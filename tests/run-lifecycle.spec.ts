/**
 * Run-lifecycle settlement pins (P0-A / P1-A): the terminal settle seam
 * (`settleRunEnd` / `settleEngineRun`) must write the `end` audit row on BOTH
 * paths — the engine success path and the rejection path (startup validation
 * errors such as NO_INITIAL that reject before any step executes) — settle
 * the live stream, release the audit diff cursor, and release the registry
 * entry exactly once. Pinned here so the "engine 异常时不写 end" gap cannot
 * regress; the suite previously had no coverage of this chain (F9).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkflowConfig } from '../src/dsl/types.js'
import { runStateMachine } from '../src/engine/runner.js'
import { EngineError, type EngineRunOptions, type RunResult, type RunState, type StateOutcome, type StepExecutor } from '../src/engine/types.js'
import { RunLifecycle, settleEngineRun, type RunLifecycleDeps, type SettleRunEndDeps } from '../src/run-lifecycle.js'
import { RunPersistence } from '../src/run-persistence.js'
import { RunRegistry } from '../src/run-registry.js'
import type { AceHarnessConfig } from '../src/service.js'
import type { SqliteArchive } from '../src/store/sqlite-archive.js'
import { saveRunState } from '../src/store/run-store.js'

const RUN_DIR_NAME = '.ace-workflows'

const SID = 'session-1' as unknown as SessionId
const fakeParent = { id: SID, session: { id: SID, header: { cwd: '/ws' } } } as unknown as Agent

/** One completed state outcome with a 5s step span (drives durationMs). */
function completedOutcome(): StateOutcome {
  return {
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
        finishedAt: '2026-08-20T10:00:05.000Z',
      },
    ],
    finishedAt: '2026-08-20T10:00:05.000Z',
  }
}

interface Harness {
  registry: RunRegistry
  persistence: RunPersistence
  emitted: Array<{ runId: string; status: string }>
  auditPath(runId: string): string
  deps: SettleRunEndDeps
}

let workspace = ''

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ace-lifecycle-'))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

async function makeHarness(): Promise<Harness> {
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
  return {
    registry,
    persistence,
    emitted,
    auditPath: (runId) => join(workspace, RUN_DIR_NAME, 'runs', runId, 'audit.jsonl'),
    deps,
  }
}

async function readAudit(runId: string): Promise<Record<string, unknown>> {
  const text = await readFile(join(workspace, RUN_DIR_NAME, 'runs', runId, 'audit.jsonl'), 'utf8')
  const lines = text.trim().split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>
}

describe('settleEngineRun (P0-A terminal settlement)', () => {
  it('settles a completed engine result: end row, stream, cursor, release', async () => {
    const harness = await makeHarness()
    const { registry, deps } = harness
    registry.register('run-ok', new AbortController())
    registry.openStream({ runId: 'run-ok', workflowName: 'wf', config: { workflow: { name: 'wf', mode: 'state-machine', states: [] } }, totalSteps: 1 })
    registry.progressTrack.set('run-ok', { states: 0, waiting: false })
    const result: RunResult = {
      runId: 'run-ok',
      status: 'completed',
      verdict: 'pass',
      stateOutcomes: [completedOutcome()],
      failedStates: [],
      error: null,
    }
    const settled = await settleEngineRun(deps, workspace, 'run-ok', Promise.resolve(result))
    expect(settled).toBe(result)
    const audit = await readAudit('run-ok')
    expect(audit).toMatchObject({ event: 'end', status: 'completed', error: null })
    expect(typeof audit['evidenceHash']).toBe('string')
    expect(audit['evidenceHash']).toMatch(/^[0-9a-f]{64}$/)
    expect(audit['durationMs']).toBe(5000)
    expect(harness.emitted).toEqual([{ runId: 'run-ok', status: 'completed' }])
    expect(registry.streams.get('run-ok')?.status).toBe('completed')
    expect(registry.progressTrack.has('run-ok')).toBe(false)
    expect(registry.isActive('run-ok')).toBe(false)
  })

  it('settles a rejected engine run as failed, writes end, and rethrows', async () => {
    const harness = await makeHarness()
    const { registry, deps } = harness
    registry.register('run-rej', new AbortController())
    registry.openStream({ runId: 'run-rej', workflowName: 'wf', config: { workflow: { name: 'wf', mode: 'state-machine', states: [] } }, totalSteps: 0 })
    registry.progressTrack.set('run-rej', { states: 0, waiting: false })
    const error = new EngineError('workflow 缺少 isInitial 状态', 'NO_INITIAL')
    await expect(settleEngineRun(deps, workspace, 'run-rej', Promise.reject(error))).rejects.toBe(error)
    const audit = await readAudit('run-rej')
    expect(audit).toMatchObject({ event: 'end', status: 'failed', error: 'workflow 缺少 isInitial 状态' })
    expect(typeof audit['evidenceHash']).toBe('string')
    expect(harness.emitted).toEqual([{ runId: 'run-rej', status: 'failed' }])
    expect(registry.streams.get('run-rej')?.status).toBe('failed')
    expect(registry.progressTrack.has('run-rej')).toBe(false)
    expect(registry.isActive('run-rej')).toBe(false)
  })

  it('wires the real engine NO_INITIAL rejection through settlement', async () => {
    const harness = await makeHarness()
    const { registry, deps } = harness
    registry.register('run-no-initial', new AbortController())
    registry.openStream({ runId: 'run-no-initial', workflowName: '缺初始', config: { workflow: { name: '缺初始', mode: 'state-machine', states: [] } }, totalSteps: 0 })
    const config: WorkflowConfig = {
      workflow: {
        name: '缺初始',
        mode: 'state-machine',
        states: [{ name: 'S', steps: [], transitions: [], isInitial: false, isFinal: true }],
      },
    }
    const options: EngineRunOptions = {
      config,
      runId: 'run-no-initial',
      configFile: 'x.yaml',
      inputs: {},
      parent: fakeParent,
      signal: new AbortController().signal,
      executor: {
        runAgentStep: async () => { throw new Error('不应启动 Agent 步骤') },
        runLlmStep: async () => { throw new Error('不应启动 LLM 步骤') },
        runSubworkflowStep: async () => { throw new Error('不应启动子工作流') },
      },
      persist: async () => {},
      load: async () => null,
      resolveSubworkflow: async () => config,
      askHumanTransition: async () => '',
    }
    await expect(
      settleEngineRun(deps, workspace, 'run-no-initial', runStateMachine(options)),
    ).rejects.toThrow('workflow 缺少 isInitial 状态')
    const audit = await readAudit('run-no-initial')
    expect(audit).toMatchObject({ event: 'end', status: 'failed', error: 'workflow 缺少 isInitial 状态' })
    expect(registry.streams.get('run-no-initial')?.status).toBe('failed')
    expect(registry.isActive('run-no-initial')).toBe(false)
  })

  it('settles at most once even when the settle itself fails', async () => {
    const harness = await makeHarness()
    const { registry } = harness
    registry.register('run-x', new AbortController())
    let auditCalls = 0
    const failingPersistence = {
      writeAudit: async (): Promise<void> => {
        auditCalls += 1
        throw new Error('audit boom')
      },
    } as unknown as RunPersistence
    const result: RunResult = {
      runId: 'run-x',
      status: 'completed',
      verdict: 'pass',
      stateOutcomes: [completedOutcome()],
      failedStates: [],
      error: null,
    }
    await expect(
      settleEngineRun({ registry, persistence: failingPersistence, emitRunEnd: () => {} }, workspace, 'run-x', Promise.resolve(result)),
    ).rejects.toThrow('audit boom')
    // The guard in settleOnce prevented a second (double-write) attempt.
    expect(auditCalls).toBe(1)
  })
})

describe('startRun / resumeRun startup-window settlement (P1-1)', () => {
  const workflowConfig: WorkflowConfig = {
    workflow: { name: 'wf', mode: 'state-machine', states: [] },
  }
  const stubExecutor: StepExecutor = {
    runAgentStep: async () => { throw new Error('不应启动 Agent 步骤') },
    runLlmStep: async () => { throw new Error('不应启动 LLM 步骤') },
    runSubworkflowStep: async () => { throw new Error('不应启动子工作流') },
  }

  /** A persisted run a resume would continue (owner = SID, non-terminal). */
  function resumableState(runId: string): RunState {
    return {
      id: runId,
      workflowName: 'wf',
      configFile: 'demo.yaml',
      status: 'running',
      currentState: null,
      selfTransitions: {},
      transitionCount: 0,
      totalSteps: 1,
      completedSteps: 0,
      stateOutcomes: [],
      pendingState: null,
      pendingHuman: null,
      startedAt: '2026-08-20T10:00:00.000Z',
      updatedAt: '2026-08-20T10:01:00.000Z',
      finishedAt: null,
      error: null,
      inputs: {},
      context: {},
      parentSessionId: SID,
    }
  }

  interface LifecycleHarness {
    lifecycle: RunLifecycle
    registry: RunRegistry
    emitted: Array<{ runId: string; status: string }>
  }

  function makeLifecycleHarness(options: {
    failStartAudit: boolean
    failResumeAudit: boolean
    /** Persistent audit-destination failure: EVERY write throws, including
     * the settle's `end` row — the exact worst case of the P1-1 repro. */
    failAllAudits?: boolean
    /** ensureSandboxDir throws synchronously (startRun window, before the
     * stream is opened) — a distinct P1-1 failure point from audit writes. */
    failEnsureSandboxDir?: boolean
  }): LifecycleHarness {
    const registry = new RunRegistry()
    const emitted: Array<{ runId: string; status: string }> = []
    const persistence = new RunPersistence({
      archive: { archiveRun: () => {}, archiveAudit: () => {} } as unknown as SqliteArchive,
      registry,
      runDirName: RUN_DIR_NAME,
      sqliteEnabled: async () => false,
      emitRunUpdated: () => {},
    })
    // The START/RESUME audit write fails exactly like the adversarial repro
    // (a broken audit destination); every other write (the settle's `end`
    // row) succeeds, so the test can assert the end row really landed.
    // Object.create keeps the prototype chain (makePersist / persistSnapshot
    // live there); only writeAudit is shadowed on the instance.
    const originalWriteAudit = persistence.writeAudit.bind(persistence)
    const guarded = Object.create(persistence) as RunPersistence
    guarded.writeAudit = async (ws, runId, event) => {
      const kind = event['event']
      if (options.failAllAudits) throw new Error(`audit boom: ${kind}`)
      if ((options.failStartAudit && kind === 'start') || (options.failResumeAudit && kind === 'resume')) {
        throw new Error(`audit boom: ${kind}`)
      }
      await originalWriteAudit(ws, runId, event)
    }
    const deps: RunLifecycleDeps = {
      ctx: {
        // settleRunEnd emits the terminal event through the host ctx
        // (`makeSettleDeps` → `ctx.emit('ace/workflow-end')`); record it so
        // the tests can observe the settlement exactly like the host would.
        emit: (event: string, payload: unknown) => {
          if (event === 'ace/workflow-end') emitted.push(payload as { runId: string; status: string })
        },
        userQuestions: { ask: async () => ({ answers: [] }) },
      } as unknown as Context,
      config: {
        subagentProvider: 'spawn',
        model: 'test-model',
        runDirName: RUN_DIR_NAME,
        maxSubworkflowDepth: 8,
        maxConcurrentRuns: 4,
        preCommandTimeoutMs: 300_000,
        stepTimeoutMs: 1_800_000,
        pythonCommand: 'python',
      } satisfies Required<AceHarnessConfig>,
      registry,
      persistence: guarded,
      jobs: () => undefined,
      workspaceOf: () => workspace,
      resolveWorkflowConfig: async () => ({ config: workflowConfig, file: 'demo.yaml' }),
      makeExecutor: () => stubExecutor,
      ensureSandboxDir: () => {
        if (options.failEnsureSandboxDir) throw new Error('sandbox boom')
      },
    }
    return { lifecycle: new RunLifecycle(deps), registry, emitted }
  }

  function startArgs(): Parameters<RunLifecycle['startRun']>[0] {
    return {
      parent: fakeParent,
      signal: new AbortController().signal,
      workflow: { config: workflowConfig, configFile: 'demo.yaml' },
      mode: 'foreground' as const,
    }
  }

  it('settles a run whose start audit write fails: end row, stream settled, slot released', async () => {
    const harness = makeLifecycleHarness({ failStartAudit: true, failResumeAudit: false })
    const { lifecycle, registry, emitted } = harness
    await expect(lifecycle.startRun(startArgs())).rejects.toThrow('audit boom: start')
    // The settle wrote the end row for the exact run that failed; the
    // runId is only knowable after the fact (generated inside startRun), so
    // the emitted end event carries it.
    const firstEmitted = emitted[0]
    expect(firstEmitted).toBeTruthy()
    const runId = firstEmitted!.runId
    expect(emitted).toEqual([{ runId, status: 'failed' }])
    expect(registry.streams.get(runId)?.status).toBe('failed')
    expect(registry.isActive(runId)).toBe(false)
    const audit = await readAudit(runId)
    expect(audit).toMatchObject({ event: 'end', status: 'failed', error: 'audit boom: start' })
    expect(typeof audit['evidenceHash']).toBe('string')
    expect(audit['evidenceHash']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does not leak the concurrency slot across repeated start-audit failures (P1-1)', async () => {
    const harness = makeLifecycleHarness({ failStartAudit: true, failResumeAudit: false })
    const { lifecycle, registry, emitted } = harness
    for (let index = 0; index < 4; index += 1) {
      await expect(lifecycle.startRun(startArgs())).rejects.toThrow('audit boom: start')
    }
    // Pre-fix each failure left the run registered forever: after 4 failures
    // the cap (maxConcurrentRuns=4) was exhausted and every later start was
    // rejected with「并发运行数达到上限 4」.
    expect(registry.counts().activeRuns).toBe(0)
    // The 5th start still reaches the audit write (not the concurrency cap).
    await expect(lifecycle.startRun(startArgs())).rejects.toThrow('audit boom: start')
    expect(registry.counts().activeRuns).toBe(0)
    expect(emitted.filter((entry) => entry.status === 'failed')).toHaveLength(5)
  })

  it('releases the slot even when the end-row settle write also fails (P1-1 worst case)', async () => {
    // The repro's audit destination is BROKEN, so the settle's `end` write
    // fails too. Cleanup must still run: the end event fires (it precedes
    // the audit write in settleRunEnd), the stream settles, and the slot is
    // released — a persistent audit failure must not wedge the runner.
    const harness = makeLifecycleHarness({ failStartAudit: false, failResumeAudit: false, failAllAudits: true })
    const { lifecycle, registry, emitted } = harness
    await expect(lifecycle.startRun(startArgs())).rejects.toThrow('audit boom: start')
    expect(registry.counts().activeRuns).toBe(0)
    const firstEmitted = emitted[0]
    expect(firstEmitted).toBeTruthy()
    expect(firstEmitted!.status).toBe('failed')
    expect(registry.streams.get(firstEmitted!.runId)?.status).toBe('failed')
    expect(registry.isActive(firstEmitted!.runId)).toBe(false)
  })

  it('settles a run whose resume audit write fails: end row, stream settled, slot released', async () => {
    const harness = makeLifecycleHarness({ failStartAudit: false, failResumeAudit: true })
    const { lifecycle, registry, emitted } = harness
    const runId = 'run-resume-1'
    await saveRunState(workspace, resumableState(runId), RUN_DIR_NAME)
    await expect(
      lifecycle.resumeRun({
        parent: fakeParent,
        signal: new AbortController().signal,
        runId,
        mode: 'foreground' as const,
      }),
    ).rejects.toThrow('audit boom: resume')
    expect(emitted).toEqual([{ runId, status: 'failed' }])
    expect(registry.streams.get(runId)?.status).toBe('failed')
    expect(registry.isActive(runId)).toBe(false)
    const audit = await readAudit(runId)
    expect(audit).toMatchObject({ event: 'end', status: 'failed', error: 'audit boom: resume' })
  })

  it('settles a startRun whose ensureSandboxDir throws before the stream opens (P1-1)', async () => {
    // A distinct P1-1 window failure point from the audit write: the sandbox
    // setup throws synchronously BEFORE the live stream is opened. The settle
    // must still write the end row, tolerate the missing stream entry, and
    // release the slot.
    const harness = makeLifecycleHarness({ failStartAudit: false, failResumeAudit: false, failEnsureSandboxDir: true })
    const { lifecycle, registry, emitted } = harness
    await expect(lifecycle.startRun(startArgs())).rejects.toThrow('sandbox boom')
    const firstEmitted = emitted[0]
    expect(firstEmitted).toBeTruthy()
    const runId = firstEmitted!.runId
    expect(emitted).toEqual([{ runId, status: 'failed' }])
    // Stream never opened — settleStream on a missing entry is a no-op, and
    // the run must not be left active.
    expect(registry.streams.has(runId)).toBe(false)
    expect(registry.isActive(runId)).toBe(false)
    expect(registry.counts().activeRuns).toBe(0)
    const audit = await readAudit(runId)
    expect(audit).toMatchObject({ event: 'end', status: 'failed', error: 'sandbox boom' })
  })

  it('settles a job-mode start whose detach fails on a missing jobs registry (P1-1)', async () => {
    // `detachAsJob` throws inside the same register→hand-off window when the
    // profile has no jobs service; the failure must not leak the slot or
    // leave the stream stuck in `preparing`.
    const harness = makeLifecycleHarness({ failStartAudit: false, failResumeAudit: false })
    const { lifecycle, registry, emitted } = harness
    await expect(
      lifecycle.startRun({ ...startArgs(), mode: 'job' as const }),
    ).rejects.toThrow('当前 profile 未挂载 jobs 服务')
    const firstEmitted = emitted[0]
    expect(firstEmitted).toBeTruthy()
    const runId = firstEmitted!.runId
    expect(emitted).toEqual([{ runId, status: 'failed' }])
    expect(registry.streams.get(runId)?.status).toBe('failed')
    expect(registry.isActive(runId)).toBe(false)
    expect(registry.counts().activeRuns).toBe(0)
    const audit = await readAudit(runId)
    expect(audit).toMatchObject({ event: 'end', status: 'failed', error: '当前 profile 未挂载 jobs 服务，无法以后台 job 方式运行' })
  })
})
