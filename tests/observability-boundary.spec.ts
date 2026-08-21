/**
 * Observability boundary/regression pins (需求①②, defender batch): edge cases
 * the batch tests do not cover directly.
 *
 * 需求② rejection-path end rows (P0-A): the run-lifecycle spec covers the
 * NO_INITIAL rejection and the settle guard; here we pin the load()-failure
 * family and the durationMs:null boundary on failed/empty-outcome end rows.
 * P1-E / G7 step-duration derivation: preference order (monotonic → timestamp
 * span → null) and invalid-input fallbacks.
 * P0-B / P1-B stats kernel: nearest-rank percentile edges, missing-attempts
 * retry semantics, verdict-null step handling, invalid run spans, unknown
 * statuses, frequency-first failed-step hotspot order, and legacy projections
 * without step rows.
 * P2 cache: invalidate-then-set freshness.
 * P0-B 裁定② resume: a failed step re-executes on resume and the failure
 * history accumulates (never cleared); failedSteps round-trips through
 * state.json as an additive field.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkflowConfig } from '../src/dsl/types.js'
import { runStateMachine } from '../src/engine/runner.js'
import type { EngineRunOptions, RunResult, RunState, StepExecutor, StepOutcome } from '../src/engine/types.js'
import { settleEngineRun, type SettleRunEndDeps } from '../src/run-lifecycle.js'
import { RunPersistence } from '../src/run-persistence.js'
import { RunRegistry } from '../src/run-registry.js'
import { stepDurationMs } from '../src/store/audit-events.js'
import { aggregateRunStats, combineStatsProjection } from '../src/store/run-stats.js'
import { StatsCache } from '../src/store/stats-cache.ts'
import { loadRunState, saveRunState } from '../src/store/run-store.ts'
import type { SqliteArchive } from '../src/store/sqlite-archive.js'

const RUN_DIR_NAME = '.ace-workflows'

const SID = 'session-1' as unknown as SessionId
const fakeParent = { id: SID, session: { header: { cwd: '/ws' } } } as unknown as Agent

/** One state, isInitial + isFinal, with a single agent step that can retry. */
function singleStepConfig(retry?: { maxRetries: number; backoffMs: number }): WorkflowConfig {
  return {
    workflow: {
      name: '边界',
      mode: 'state-machine',
      states: [
        {
          name: '主',
          steps: [{ name: 'AI', agent: 'researcher', role: 'defender', task: '分析', ...(retry ? { retry } : {}) }],
          transitions: [],
          isInitial: true,
          isFinal: true,
        },
      ],
    },
  }
}

function alwaysThrowingExecutor(): StepExecutor {
  return {
    async runAgentStep() {
      throw new Error('不应调用 Agent')
    },
    async runLlmStep() {
      throw new Error('不应调用 LLM')
    },
    async runSubworkflowStep() {
      throw new Error('不应调用子工作流')
    },
  }
}

function makeOptions(
  runId: string,
  config: WorkflowConfig,
  executor: StepExecutor,
  persisted: RunState[],
  load: () => Promise<RunState | null>,
): EngineRunOptions {
  return {
    config,
    runId,
    configFile: 'x.yaml',
    inputs: {},
    parent: fakeParent,
    signal: new AbortController().signal,
    executor,
    persist: async (state) => {
      persisted.push(JSON.parse(JSON.stringify(state)) as RunState)
    },
    load,
    resolveSubworkflow: async () => config,
    askHumanTransition: async () => '',
  }
}

let workspace = ''

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ace-boundary-'))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

async function makeHarness() {
  const registry = new RunRegistry()
  const emitted: Array<{ runId: string; status: string }> = []
  const persistence = new RunPersistence({
    archive: { archiveRun: () => {}, archiveAudit: () => {} } as unknown as SqliteArchive,
    registry,
    runDirName: RUN_DIR_NAME,
    sqliteEnabled: async () => false,
    emitRunUpdated: () => {},
  })
  const deps: SettleRunEndDeps = {
    registry,
    persistence,
    emitRunEnd: (payload) => emitted.push(payload),
  }
  return { registry, persistence, emitted, deps }
}

async function readLastAudit(runId: string): Promise<Record<string, unknown>> {
  const text = await readFile(join(workspace, RUN_DIR_NAME, 'runs', runId, 'audit.jsonl'), 'utf8')
  const lines = text.trim().split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>
}

describe('rejection-path end rows (P0-A / 需求②)', () => {
  it('writes the failed end row when the engine load() rejects, and rethrows', async () => {
    const harness = await makeHarness()
    const { registry, deps } = harness
    registry.register('run-load-rej', new AbortController())
    registry.openStream({
      runId: 'run-load-rej',
      workflowName: 'wf',
      config: { workflow: { name: 'wf', mode: 'state-machine', states: [] } },
      totalSteps: 0,
    })
    registry.progressTrack.set('run-load-rej', { states: 0, waiting: false })
    const config = singleStepConfig()
    const options = makeOptions('run-load-rej', config, alwaysThrowingExecutor(), [], async () => {
      throw new Error('load boom')
    })
    await expect(settleEngineRun(deps, workspace, 'run-load-rej', runStateMachine(options))).rejects.toThrow('load boom')
    const audit = await readLastAudit('run-load-rej')
    expect(audit).toMatchObject({ event: 'end', status: 'failed', error: 'load boom' })
    expect(audit['evidenceHash']).toMatch(/^[0-9a-f]{64}$/)
    // A rejection settles with no outcomes: the duration is null, not 0.
    expect(audit['durationMs']).toBeNull()
    expect(harness.emitted).toEqual([{ runId: 'run-load-rej', status: 'failed' }])
    expect(registry.streams.get('run-load-rej')?.status).toBe('failed')
    expect(registry.progressTrack.has('run-load-rej')).toBe(false)
    expect(registry.isActive('run-load-rej')).toBe(false)
  })

  it('writes durationMs null for a completed run whose result has no step outcomes', async () => {
    const harness = await makeHarness()
    const { registry, deps } = harness
    registry.register('run-empty', new AbortController())
    registry.openStream({
      runId: 'run-empty',
      workflowName: 'wf',
      config: { workflow: { name: 'wf', mode: 'state-machine', states: [] } },
      totalSteps: 0,
    })
    registry.progressTrack.set('run-empty', { states: 0, waiting: false })
    const result: RunResult = {
      runId: 'run-empty',
      status: 'completed',
      verdict: 'pass',
      stateOutcomes: [],
      failedStates: [],
      error: null,
    }
    await settleEngineRun(deps, workspace, 'run-empty', Promise.resolve(result))
    const audit = await readLastAudit('run-empty')
    expect(audit).toMatchObject({ event: 'end', status: 'completed', error: null })
    expect(audit['durationMs']).toBeNull()
  })
})

describe('step duration derivation (P1-E / G7)', () => {
  const base: StepOutcome = {
    key: '主/s',
    state: '主',
    step: 's',
    type: 'script',
    outputSummary: '',
    verdict: { verdict: 'pass', issues: [], rationale: '' },
    startedAt: '2026-08-20T10:00:00.000Z',
    finishedAt: '2026-08-20T10:00:10.000Z',
  }

  it('prefers the monotonic measurement over the timestamp span', () => {
    expect(stepDurationMs({ ...base, durationMs: 42 })).toBe(42)
  })

  it('falls back to the wall-clock span for legacy steps without durationMs', () => {
    expect(stepDurationMs(base)).toBe(10_000)
    expect(stepDurationMs({ ...base, startedAt: base.finishedAt })).toBe(0)
  })

  it('falls back when the monotonic value is negative or non-finite', () => {
    expect(stepDurationMs({ ...base, durationMs: -5 })).toBe(10_000)
    expect(stepDurationMs({ ...base, durationMs: Number.NaN })).toBe(10_000)
  })

  it('returns null when neither measurement is usable', () => {
    expect(stepDurationMs({ ...base, startedAt: 'garbage', finishedAt: 'garbage' })).toBeNull()
  })
})

describe('stats kernel boundaries (P0-B / P1-B)', () => {
  const run = (durations: Array<number | null>): ReturnType<typeof aggregateRunStats> =>
    aggregateRunStats([
      {
        status: 'completed',
        startedAt: '2026-08-20T10:00:00.000Z',
        finishedAt: null,
        states: [],
        steps: durations.map((durationMs, index) => ({
          state: 'S',
          step: `s${index}`,
          verdict: 'success',
          attempts: 1,
          durationMs,
        })),
      },
    ])

  it('computes nearest-rank percentiles at the edges', () => {
    expect(run([5]).stepDurationPercentiles).toEqual({ p50: 5, p95: 5 })
    expect(run([1, 2]).stepDurationPercentiles).toEqual({ p50: 2, p95: 2 })
    expect(run([1, 2, 3, 4]).stepDurationPercentiles).toEqual({ p50: 3, p95: 4 })
    expect(run([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).stepDurationPercentiles).toEqual({ p50: 6, p95: 10 })
    expect(run([]).stepDurationPercentiles).toEqual({ p50: null, p95: null })
  })

  it('treats missing attempts as no retry', () => {
    const stats = aggregateRunStats([
      {
        status: 'completed',
        startedAt: '2026-08-20T10:00:00.000Z',
        finishedAt: null,
        states: [],
        steps: [
          { state: 'S', step: 'a', verdict: 'success', attempts: null, durationMs: 1 },
          { state: 'S', step: 'b', verdict: 'success', durationMs: 1 },
        ],
        failedSteps: [{ state: 'S', step: 'c', attempts: null }],
      },
    ])
    expect(stats.stepRetryCount).toBe(0)
    expect(stats.stepRetryTotal).toBe(0)
  })

  it('counts verdict-null steps in stepCount and the histogram but not hotspots', () => {
    const stats = aggregateRunStats([
      {
        status: 'completed',
        startedAt: '2026-08-20T10:00:00.000Z',
        finishedAt: null,
        states: [],
        steps: [{ state: 'S', step: 'a', verdict: null, attempts: 1, durationMs: 3000 }],
      },
    ])
    expect(stats.stepCount).toBe(1)
    expect(stats.stepHotspots).toEqual([])
    expect(stats.stepDurationBuckets.find((bucket) => bucket.label === '1-5s')?.count).toBe(1)
    expect(stats.stepDurationPercentiles).toEqual({ p50: 3000, p95: 3000 })
  })

  it('skips invalid run spans (startedAt after finishedAt) from the average', () => {
    const stats = aggregateRunStats([
      {
        status: 'completed',
        startedAt: '2026-08-20T11:00:00.000Z',
        finishedAt: '2026-08-20T10:00:00.000Z', // negative span
        states: [],
      },
      {
        status: 'completed',
        startedAt: '2026-08-20T12:00:00.000Z',
        finishedAt: '2026-08-20T12:01:00.000Z', // 60s
        states: [],
      },
    ])
    expect(stats.avgDurationMs).toBe(60_000)
    expect(stats.totalRuns).toBe(2)
  })

  it('preserves unknown run statuses in byStatus', () => {
    const stats = aggregateRunStats([
      { status: 'crashed', startedAt: '2026-08-20T10:00:00.000Z', finishedAt: null, states: [] },
      { status: 'weird-status', startedAt: '2026-08-20T10:00:00.000Z', finishedAt: null, states: [] },
    ])
    expect(stats.byStatus).toEqual({ crashed: 1, 'weird-status': 1 })
  })

  it('orders failed-step hotspots by frequency, ties stable', () => {
    const stats = combineStatsProjection({
      byStatus: [],
      runs: [],
      stateVerdicts: [],
      failedSteps: [
        { state: 'A', step: 'x', attempts: 1 },
        { state: 'B', step: 'x', attempts: 1 },
        { state: 'A', step: 'x', attempts: 1 },
        { state: 'C', step: 'x', attempts: 1 },
      ],
    })
    expect(stats.failedStepHotspots).toEqual([
      { state: 'A', step: 'x', count: 2 },
      { state: 'B', step: 'x', count: 1 },
      { state: 'C', step: 'x', count: 1 },
    ])
  })

  it('tolerates legacy projections without step rows', () => {
    const stats = combineStatsProjection({ byStatus: [], runs: [], stateVerdicts: [] })
    expect(stats.stepCount).toBe(0)
    expect(stats.stepHotspots).toEqual([])
    expect(stats.failedStepHotspots).toEqual([])
    expect(stats.stepDurationPercentiles).toEqual({ p50: null, p95: null })
  })
})

describe('stats cache boundaries (P2)', () => {
  it('serves a fresh value after invalidate-then-set', () => {
    const cache = new StatsCache<number>(60_000)
    cache.set('w', 42, 1000)
    cache.invalidate('w')
    cache.set('w', 7, 1500)
    expect(cache.get('w', 2000)).toBe(7)
  })
})

describe('failed-step records across resume (P0-B 裁定②)', () => {
  it('re-executes a failed step on resume and keeps the failure history', async () => {
    const config = singleStepConfig({ maxRetries: 1, backoffMs: 1 })
    const persisted: RunState[] = []
    const first = await runStateMachine(
      makeOptions('run-resume', config, alwaysThrowingExecutor(), persisted, async () => null),
    )
    expect(first.status).toBe('failed')
    const failedState = persisted[persisted.length - 1]!
    expect(failedState.failedSteps).toHaveLength(1)
    expect(failedState.failedSteps![0]).toMatchObject({ key: '主/AI', state: '主', step: 'AI', type: 'agent', attempts: 2 })

    // resumeRun resets an infrastructure-terminal state to running before the
    // engine sees it; the loaded state carries the failure history.
    const resumed = JSON.parse(JSON.stringify(failedState)) as RunState
    resumed.status = 'running'
    resumed.error = null
    resumed.finishedAt = null
    let executions = 0
    const goodExecutor: StepExecutor = {
      async runAgentStep() {
        executions += 1
        return { outputSummary: 'ok', verdict: { verdict: 'pass', issues: [], rationale: '' } }
      },
      async runLlmStep() {
        throw new Error('不应调用 LLM')
      },
      async runSubworkflowStep() {
        throw new Error('不应调用子工作流')
      },
    }
    const second = await runStateMachine(
      makeOptions('run-resume', config, goodExecutor, persisted, async () => resumed),
    )
    expect(second.status).toBe('completed')
    expect(executions).toBe(1) // the failed step re-ran instead of being skipped
    expect(second.stateOutcomes[0]?.steps.map((step) => step.key)).toEqual(['主/AI'])
    // The failure history survives the resume: additive, never cleared.
    const lastPersisted = persisted[persisted.length - 1]!
    expect(lastPersisted.failedSteps).toHaveLength(1)
    expect(lastPersisted.failedSteps![0]).toMatchObject({ key: '主/AI', attempts: 2 })
  })

  it('round-trips failedSteps through state.json as an additive field', async () => {
    const base: RunState = {
      id: 'run-rt',
      workflowName: 'wf',
      configFile: 'x.yaml',
      status: 'failed',
      currentState: '主',
      selfTransitions: {},
      transitionCount: 0,
      totalSteps: 1,
      completedSteps: 0,
      stateOutcomes: [],
      pendingState: null,
      pendingHuman: null,
      startedAt: '2026-08-20T10:00:00.000Z',
      updatedAt: '2026-08-20T10:00:01.000Z',
      finishedAt: '2026-08-20T10:00:01.000Z',
      error: 'boom',
      inputs: {},
      context: {},
      failedSteps: [
        {
          key: '主/AI',
          state: '主',
          step: 'AI',
          type: 'agent',
          error: 'boom',
          attempts: 2,
          startedAt: '2026-08-20T10:00:00.000Z',
          finishedAt: '2026-08-20T10:00:01.000Z',
        },
      ],
    }
    await saveRunState(workspace, base, RUN_DIR_NAME)
    const loaded = await loadRunState(workspace, 'run-rt', RUN_DIR_NAME)
    expect(loaded?.failedSteps).toEqual(base.failedSteps)

    // A pre-instrumentation state (no failedSteps key) loads cleanly.
    const { failedSteps: _omitted, ...legacy } = base
    await saveRunState(workspace, { ...legacy, id: 'run-legacy' }, RUN_DIR_NAME)
    const legacyLoaded = await loadRunState(workspace, 'run-legacy', RUN_DIR_NAME)
    expect(legacyLoaded?.failedSteps).toBeUndefined()
  })
})
