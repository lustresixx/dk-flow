import { mkdtemp, rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunState } from '../src/engine/types.ts'
import { stepDurationMs } from '../src/store/audit-events.ts'
import { aggregateRunStats, combineStatsProjection } from '../src/store/run-stats.ts'
import { appendAudit, normalizeStaleRun, PID_LIVE_GRACE_MS, saveRunState } from '../src/store/run-store.ts'
import { SqliteArchive } from '../src/store/sqlite-archive.ts'
import { readWorkspaceSettings, writeWorkspaceSettings } from '../src/store/workspace-settings.ts'

let workspace = ''

function makeRun(id: string, overrides: Partial<RunState> = {}): RunState {
  return {
    id,
    workflowName: '测试工作流',
    configFile: 'demo.yaml',
    status: 'running',
    currentState: '状态一',
    selfTransitions: {},
    transitionCount: 1,
    totalSteps: 2,
    completedSteps: 1,
    stateOutcomes: [
      {
        state: '状态一',
        verdict: { verdict: 'success', issues: [], rationale: '通过' },
        steps: [
          {
            key: '状态一/步骤A',
            state: '状态一',
            step: '步骤A',
            type: 'script',
            outputSummary: '产出A',
            verdict: { verdict: 'success', issues: [], rationale: '产出A' },
            startedAt: '2026-08-20T10:00:00.000Z',
            finishedAt: '2026-08-20T10:01:00.000Z',
          },
        ],
        finishedAt: '2026-08-20T10:01:00.000Z',
      },
    ],
    pendingState: null,
    pendingHuman: null,
    startedAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:01:00.000Z',
    finishedAt: null,
    error: null,
    inputs: {},
    context: {},
    ...overrides,
  }
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ace-sqlite-'))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('SqliteArchive', () => {
  it('archives a run snapshot and queries it back with the evidence chain', async () => {
    const archive = new SqliteArchive()
    archive.archiveRun(workspace, '.ace-workflows', makeRun('run-1'))
    archive.archiveAudit(workspace, '.ace-workflows', 'run-1', { at: '2026-08-20T10:00:00.000Z', event: 'start', workflow: '测试工作流' })
    expect(archive.countRuns(workspace, '.ace-workflows')).toBe(1)
    const rows = archive.queryRuns(workspace, '.ace-workflows')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ runId: 'run-1', workflowName: '测试工作流', status: 'running', completedSteps: 1 })
    const detail = archive.queryRunDetail(workspace, '.ace-workflows', 'run-1')
    expect(detail?.state?.stateOutcomes[0]?.steps[0]?.outputSummary).toBe('产出A')
    expect(detail?.audit).toHaveLength(1)
    expect(detail?.audit[0]).toMatchObject({ event: 'start' })
    archive.close()
  })

  it('upserts on repeat persists and keeps the latest snapshot', () => {
    const archive = new SqliteArchive()
    archive.archiveRun(workspace, '.ace-workflows', makeRun('run-1'))
    archive.archiveRun(
      workspace,
      '.ace-workflows',
      makeRun('run-1', {
        status: 'completed',
        currentState: null,
        completedSteps: 2,
        finishedAt: '2026-08-20T10:05:00.000Z',
        updatedAt: '2026-08-20T10:05:00.000Z',
      }),
    )
    expect(archive.countRuns(workspace, '.ace-workflows')).toBe(1)
    const row = archive.queryRuns(workspace, '.ace-workflows')[0]
    expect(row).toMatchObject({ status: 'completed', completedSteps: 2, verdict: 'success' })
    archive.close()
  })

  it('filters by workflow and status, newest first', () => {
    const archive = new SqliteArchive()
    archive.archiveRun(workspace, '.ace-workflows', makeRun('run-old', { startedAt: '2026-08-19T09:00:00.000Z', updatedAt: '2026-08-19T09:00:00.000Z' }))
    archive.archiveRun(workspace, '.ace-workflows', makeRun('run-new', { workflowName: '另一个', status: 'failed' }))
    expect(archive.queryRuns(workspace, '.ace-workflows', { workflow: '另一个' })[0]?.runId).toBe('run-new')
    expect(archive.queryRuns(workspace, '.ace-workflows', { status: 'failed' })).toHaveLength(1)
    expect(archive.queryRuns(workspace, '.ace-workflows')[0]?.runId).toBe('run-new')
    archive.close()
  })

  it('opens in WAL mode for multi-instance tolerance', async () => {
    const archive = new SqliteArchive()
    archive.archiveRun(workspace, '.ace-workflows', makeRun('run-wal'))
    const { DatabaseSync } = await import('node:sqlite')
    const probe = new DatabaseSync(join(workspace, '.ace-workflows', 'archive.db'), { open: true })
    const mode = probe.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    expect(mode.journal_mode).toBe('wal')
    probe.close()
    archive.close()
  })

  it('extracts the SQL stats projection (status counts, durations, state matrix)', () => {
    const archive = new SqliteArchive()
    archive.archiveRun(workspace, '.ace-workflows', makeRun('run-s1', { status: 'completed', finishedAt: '2026-08-20T10:04:00.000Z' }))
    archive.archiveRun(workspace, '.ace-workflows', makeRun('run-s2', { status: 'failed', workflowName: 'B' }))
    const projection = archive.queryStatsProjection(workspace, '.ace-workflows')
    expect(projection.byStatus).toContainEqual({ status: 'completed', count: 1 })
    expect(projection.byStatus).toContainEqual({ status: 'failed', count: 1 })
    expect(projection.runs).toHaveLength(2)
    expect(projection.runs[0]?.status).toBe('completed')
    expect(projection.stateVerdicts).toContainEqual({ state: '状态一', verdict: 'success', count: 2 })
    // Step rows ride along from state_json (P0-B): makeRun carries one step
    // per run with a 60s wall-clock span and no monotonic durationMs — the
    // projection reports the EFFECTIVE duration (timestamp-span fallback,
    // P1-②), so legacy rows stay in the histogram exactly like the JSON feed.
    expect(projection.steps).toHaveLength(2)
    expect(projection.steps[0]).toMatchObject({ state: '状态一', step: '步骤A', verdict: 'success', attempts: null, durationMs: 60_000 })
    expect(projection.failedSteps).toEqual([])
    archive.close()
  })

  it('extracts attempts, durations, and failed steps from state_json', () => {
    const archive = new SqliteArchive()
    archive.archiveRun(workspace, '.ace-workflows', makeRun('run-step', {
      stateOutcomes: [
        {
          state: '状态一',
          verdict: { verdict: 'success', issues: [], rationale: '通过' },
          steps: [
            {
              key: '状态一/步骤A',
              state: '状态一',
              step: '步骤A',
              type: 'script',
              outputSummary: '产出A',
              verdict: { verdict: 'success', issues: [], rationale: '产出A' },
              startedAt: '2026-08-20T10:00:00.000Z',
              finishedAt: '2026-08-20T10:00:00.500Z',
              durationMs: 480,
              attempts: 2,
            },
          ],
          finishedAt: '2026-08-20T10:00:00.500Z',
        },
      ],
      failedSteps: [
        {
          key: '状态一/步骤B',
          state: '状态一',
          step: '步骤B',
          type: 'agent',
          error: '一直失败',
          attempts: 3,
          startedAt: '2026-08-20T09:59:00.000Z',
          finishedAt: '2026-08-20T09:59:10.000Z',
        },
      ],
    }))
    const projection = archive.queryStatsProjection(workspace, '.ace-workflows')
    expect(projection.steps).toHaveLength(1)
    expect(projection.steps[0]).toMatchObject({ state: '状态一', step: '步骤A', verdict: 'success', attempts: 2, durationMs: 480 })
    expect(projection.failedSteps).toEqual([{ state: '状态一', step: '步骤B', attempts: 3 }])
    archive.close()
  })

  it('answers byte-identical step statistics to the JSON feed for legacy runs without durationMs (P1-② DIVERGE pin)', () => {
    const archive = new SqliteArchive()
    // A pre-instrumentation run: step rows carry wall-clock timestamps but no
    // monotonic durationMs (G7). Before P1-② the SQL feed dropped these rows
    // from the histogram (all-zero buckets / null percentiles) while the JSON
    // feed kept them via the timestamp-span fallback — the dual-feed
    // divergence the adversarial review reproduced (5-30s:1/p50=5000 vs
    // 全零/p50=null).
    const legacy = makeRun('run-legacy', {
      status: 'completed',
      finishedAt: '2026-08-20T10:05:00.000Z',
      stateOutcomes: [
        {
          state: '状态一',
          verdict: { verdict: 'success', issues: [], rationale: '通过' },
          steps: [
            {
              key: '状态一/步骤A',
              state: '状态一',
              step: '步骤A',
              type: 'script',
              outputSummary: '产出A',
              verdict: { verdict: 'success', issues: [], rationale: '产出A' },
              startedAt: '2026-08-20T10:00:00.000Z',
              finishedAt: '2026-08-20T10:00:05.000Z', // 5000ms span
            },
            {
              key: '状态一/步骤B',
              state: '状态一',
              step: '步骤B',
              type: 'script',
              outputSummary: '产出B',
              verdict: { verdict: 'fail', issues: [], rationale: '产出B' },
              startedAt: '2026-08-20T10:00:05.000Z',
              finishedAt: '2026-08-20T10:00:07.500Z', // 2500ms span
            },
          ],
          finishedAt: '2026-08-20T10:00:07.500Z',
        },
      ],
    })
    archive.archiveRun(workspace, '.ace-workflows', legacy)
    const sqlStats = combineStatsProjection(archive.queryStatsProjection(workspace, '.ace-workflows'))
    // The JSON feed maps steps exactly like service.workspaceStats does:
    // durationMs = stepDurationMs(step) with the same fallback.
    const jsonStats = aggregateRunStats([
      {
        status: legacy.status,
        startedAt: legacy.startedAt,
        finishedAt: legacy.finishedAt,
        states: legacy.stateOutcomes.map((outcome) => ({ state: outcome.state, verdict: outcome.verdict.verdict })),
        steps: legacy.stateOutcomes.flatMap((outcome) =>
          outcome.steps.map((step) => ({
            state: step.state,
            step: step.step,
            verdict: step.verdict?.verdict ?? null,
            attempts: step.attempts ?? null,
            durationMs: stepDurationMs(step),
          })),
        ),
        failedSteps: (legacy.failedSteps ?? []).map((failed) => ({
          state: failed.state,
          step: failed.step,
          attempts: failed.attempts ?? null,
        })),
      },
    ])
    expect(sqlStats).toEqual(jsonStats)
    // The legacy durations really landed: the pre-fix SQL feed reported
    // all-zero buckets with null percentiles here.
    const byLabel = Object.fromEntries(sqlStats.stepDurationBuckets.map((bucket) => [bucket.label, bucket.count]))
    expect(byLabel).toEqual({ '<1s': 0, '1-5s': 1, '5-30s': 1, '30-120s': 0, '>120s': 0 })
    expect(sqlStats.stepDurationPercentiles).toEqual({ p50: 5000, p95: 5000 })
    expect(sqlStats.stepCount).toBe(2)
    archive.close()
  })

  it('counts zombie runs as crashed in BOTH feeds (P1-2 stale-status pin)', () => {
    const archive = new SqliteArchive()
    // Fixed reference instant so the staleness boundary (STALE_RUN_MS = 10min)
    // is deterministic; the runs below sit clearly on either side of it.
    const NOW = Date.parse('2026-08-20T10:20:00.000Z')
    // Zombie: non-terminal and untouched for 20 minutes — reads as `crashed`.
    const zombie = makeRun('run-zombie', {
      status: 'running',
      startedAt: '2026-08-20T09:00:00.000Z',
      updatedAt: '2026-08-20T10:00:00.000Z',
      finishedAt: null,
    })
    // Fresh non-terminal: must stay `running` in both feeds.
    const fresh = makeRun('run-fresh', {
      status: 'running',
      startedAt: '2026-08-20T10:19:00.000Z',
      updatedAt: '2026-08-20T10:19:30.000Z',
      finishedAt: null,
    })
    // Terminal runs never age out, however old.
    const done = makeRun('run-done', {
      status: 'completed',
      startedAt: '2026-08-20T08:00:00.000Z',
      updatedAt: '2026-08-20T08:10:00.000Z',
      finishedAt: '2026-08-20T08:10:00.000Z',
    })
    for (const run of [zombie, fresh, done]) archive.archiveRun(workspace, '.ace-workflows', run)

    // SQL feed: the projection normalizes statuses with the SAME stale rule
    // the file scan applies (P1-2). Before the fix it reported the zombie as
    // `running` (2 running) while the JSON feed said `crashed` — the
    // dual-feed status split the adversarial review reproduced (DIVERGE=true).
    const sqlStats = combineStatsProjection(archive.queryStatsProjection(workspace, '.ace-workflows', NOW))
    // JSON feed: service.workspaceStats scans listRunStates, which normalizes
    // every loaded state through normalizeStaleRun before aggregation.
    const jsonStats = aggregateRunStats(
      [zombie, fresh, done].map((state) => {
        const normalized = normalizeStaleRun(state, NOW)
        return {
          status: normalized.status,
          startedAt: normalized.startedAt,
          finishedAt: normalized.finishedAt,
          states: normalized.stateOutcomes.map((outcome) => ({ state: outcome.state, verdict: outcome.verdict.verdict })),
          steps: normalized.stateOutcomes.flatMap((outcome) =>
            outcome.steps.map((step) => ({
              state: step.state,
              step: step.step,
              verdict: step.verdict?.verdict ?? null,
              attempts: step.attempts ?? null,
              durationMs: stepDurationMs(step),
            })),
          ),
          failedSteps: (normalized.failedSteps ?? []).map((failed) => ({
            state: failed.state,
            step: failed.step,
            attempts: failed.attempts ?? null,
          })),
        }
      }),
    )
    expect(sqlStats).toEqual(jsonStats)
    expect(sqlStats.byStatus).toEqual({ crashed: 1, running: 1, completed: 1 })
    expect(sqlStats.totalRuns).toBe(3)
    archive.close()
  })

  it('applies the pid-live exemption identically in BOTH feeds (P1-1/P1-2 pid-equivalence pin)', () => {
    const archive = new SqliteArchive()
    const NOW = Date.parse('2026-08-20T10:20:00.000Z')
    const HOST = hostname()
    // Stale, owned by THIS machine's live process, within the grace window —
    // a slow step. Both feeds keep it `running`.
    const liveSlow = makeRun('run-live-slow', {
      status: 'running',
      startedAt: '2026-08-20T09:00:00.000Z',
      updatedAt: '2026-08-20T09:09:00.000Z', // STALE_RUN_MS + 60s idle
      finishedAt: null,
      pid: process.pid,
      hostId: HOST,
    })
    // Stale, live pid, BEYOND the grace window — the run is hung. Both feeds
    // report `crashed` (hang detection restored, P1-1).
    const hung = makeRun('run-hung', {
      status: 'running',
      startedAt: '2026-08-19T22:00:00.000Z',
      updatedAt: '2026-08-19T22:00:00.000Z', // STALE_RUN_MS + PID_LIVE_GRACE_MS + 1min idle
      finishedAt: null,
      pid: process.pid,
      hostId: HOST,
    })
    // Stale with a locally-alive pid recorded by ANOTHER machine: the pid can
    // only be an unrelated local process — never trusted (P1-2 cross-machine).
    const foreign = makeRun('run-foreign', {
      status: 'running',
      startedAt: '2026-08-20T09:00:00.000Z',
      updatedAt: '2026-08-20T09:09:00.000Z',
      finishedAt: null,
      pid: process.pid,
      hostId: 'some-other-machine',
    })
    // Stale with a dead pid: abandoned — crashed in both feeds.
    const dead = makeRun('run-dead', {
      status: 'running',
      startedAt: '2026-08-20T09:00:00.000Z',
      updatedAt: '2026-08-20T09:09:00.000Z',
      finishedAt: null,
      pid: 999_999_999,
      hostId: HOST,
    })
    const runs = [liveSlow, hung, foreign, dead]
    for (const run of runs) archive.archiveRun(workspace, '.ace-workflows', run)

    const sqlStats = combineStatsProjection(archive.queryStatsProjection(workspace, '.ace-workflows', NOW))
    const jsonStats = aggregateRunStats(
      runs.map((state) => {
        const normalized = normalizeStaleRun(state, NOW)
        return {
          status: normalized.status,
          startedAt: normalized.startedAt,
          finishedAt: normalized.finishedAt,
          states: normalized.stateOutcomes.map((outcome) => ({ state: outcome.state, verdict: outcome.verdict.verdict })),
          steps: normalized.stateOutcomes.flatMap((outcome) =>
            outcome.steps.map((step) => ({
              state: step.state,
              step: step.step,
              verdict: step.verdict?.verdict ?? null,
              attempts: step.attempts ?? null,
              durationMs: stepDurationMs(step),
            })),
          ),
          failedSteps: (normalized.failedSteps ?? []).map((failed) => ({
            state: failed.state,
            step: failed.step,
            attempts: failed.attempts ?? null,
          })),
        }
      }),
    )
    expect(sqlStats).toEqual(jsonStats)
    expect(sqlStats.byStatus).toEqual({ running: 1, crashed: 3 })
    expect(sqlStats.totalRuns).toBe(4)
    archive.close()
  })

  it('backfills the file-based run store and imports audit logs once', async () => {
    await saveRunState(workspace, makeRun('run-file-1'), '.ace-workflows')
    await appendAudit(workspace, 'run-file-1', '.ace-workflows', { at: '2026-08-20T10:00:00.000Z', event: 'start' })
    await appendAudit(workspace, 'run-file-1', '.ace-workflows', { at: '2026-08-20T10:05:00.000Z', event: 'end', status: 'completed' })
    await saveRunState(workspace, makeRun('run-file-2', { workflowName: '第二个' }), '.ace-workflows')
    const archive = new SqliteArchive()
    const imported = await archive.backfill(workspace, '.ace-workflows')
    expect(imported).toBe(2)
    expect(archive.countRuns(workspace, '.ace-workflows')).toBe(2)
    expect(archive.queryRunDetail(workspace, '.ace-workflows', 'run-file-1')?.audit).toHaveLength(2)
    // A second backfill upserts runs but must not duplicate audit rows.
    await archive.backfill(workspace, '.ace-workflows')
    expect(archive.queryRunDetail(workspace, '.ace-workflows', 'run-file-1')?.audit).toHaveLength(2)
    archive.close()
  })
})

describe('SqliteArchive performance', () => {
  it('sustains 1000 snapshot upserts within the persist budget', () => {
    const archive = new SqliteArchive()
    const state = makeRun('run-perf')
    const t0 = performance.now()
    for (let index = 0; index < 1000; index += 1) {
      archive.archiveRun(workspace, '.ace-workflows', { ...state, id: `run-perf-${index}` })
    }
    const insertMs = performance.now() - t0
    console.log(`  [perf] 1000 upserts: ${insertMs.toFixed(0)}ms (${(insertMs / 1000).toFixed(2)}ms/op)`)
    expect(insertMs).toBeLessThan(3000)
    // Same-id upsert (the hot path during one run's progress):
    const t1 = performance.now()
    for (let index = 0; index < 500; index += 1) {
      archive.archiveRun(workspace, '.ace-workflows', { ...state, completedSteps: index % 10 })
    }
    const upsertMs = performance.now() - t1
    console.log(`  [perf] 500 same-id upserts: ${upsertMs.toFixed(0)}ms (${(upsertMs / 500).toFixed(2)}ms/op)`)
    expect(upsertMs).toBeLessThan(1500)
    archive.close()
  })

  it('queries stay fast over 1000 archived runs', () => {
    const archive = new SqliteArchive()
    for (let index = 0; index < 1000; index += 1) {
      archive.archiveRun(workspace, '.ace-workflows', {
        ...makeRun(`run-q-${index}`),
        status: index % 7 === 0 ? 'failed' : 'completed',
      })
    }
    const t0 = performance.now()
    const page = archive.queryRuns(workspace, '.ace-workflows', { limit: 50 })
    const queryMs = performance.now() - t0
    const t1 = performance.now()
    const projection = archive.queryStatsProjection(workspace, '.ace-workflows')
    const statsMs = performance.now() - t1
    const t2 = performance.now()
    const detail = archive.queryRunDetail(workspace, '.ace-workflows', 'run-q-500')
    const detailMs = performance.now() - t2
    console.log(`  [perf] page=${queryMs.toFixed(1)}ms stats=${statsMs.toFixed(1)}ms detail=${detailMs.toFixed(1)}ms over 1000 runs`)
    expect(page).toHaveLength(50)
    expect(queryMs).toBeLessThan(100)
    expect(statsMs).toBeLessThan(500)
    expect(detail?.run.runId).toBe('run-q-500')
    expect(detailMs).toBeLessThan(50)
    expect(projection.byStatus.reduce((sum, row) => sum + row.count, 0)).toBe(1000)
    archive.close()
  })
})

describe('workspace-settings', () => {
  it('defaults to sqliteArchive off', async () => {
    expect((await readWorkspaceSettings(workspace, '.ace-workflows')).sqliteArchive).toBe(false)
  })

  it('round-trips a toggle and revalidates the cache by mtime', async () => {
    await writeWorkspaceSettings(workspace, '.ace-workflows', { sqliteArchive: true })
    expect((await readWorkspaceSettings(workspace, '.ace-workflows')).sqliteArchive).toBe(true)
    await writeWorkspaceSettings(workspace, '.ace-workflows', { sqliteArchive: false })
    expect((await readWorkspaceSettings(workspace, '.ace-workflows')).sqliteArchive).toBe(false)
  })
})
