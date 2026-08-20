import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunState } from '../src/engine/types.ts'
import { appendAudit, saveRunState } from '../src/store/run-store.ts'
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
    expect(projection.stateVerdicts).toContainEqual({ state: '状态一', verdict: 'success', count: 2 })
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
