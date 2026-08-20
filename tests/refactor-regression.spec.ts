/**
 * Regression pins for the 2026-10 refactor (batches 1–5). These cases pin
 * behavior contracts the refactor established or corrected, complementing the
 * pre-existing suite:
 * - C8 / P1-1: one numeric "latest version" rule (compareVersions / latestTemplate)
 * - C9 / P1-2③: per-run persist serialization — order, chain survives failure
 * - C9 / P1-2③: parallel-segment evidence snapshot semantics (executeStateSteps)
 * - C15 / P1-2⑥: archive writes are queued FIFO off the hot path, drained on flush
 * - C2 / P1-2①: aborting a pre-command kills the spawned shell (host-only:
 *   requires spawning child processes; skipped where the sandbox denies spawn)
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compareVersions, latestTemplate } from '../src/catalog/index.js'
import { runPreCommand } from '../src/engine/pre-commands.js'
import { executeStateSteps } from '../src/engine/state-steps.js'
import type { RunState, StepExecutor } from '../src/engine/types.js'
import type { StateMachineState, StepVerdict, WorkflowConfig } from '../src/dsl/types.js'
import { RunPersistence } from '../src/run-persistence.js'
import { RunRegistry } from '../src/run-registry.js'
import { loadRunState } from '../src/store/run-store.js'
import type { SqliteArchive } from '../src/store/sqlite-archive.js'

const RUN_DIR = '.ace-workflows'

// ---------------------------------------------------------------------------
// C8 / P1-1: one numeric version-comparison rule
// ---------------------------------------------------------------------------
describe('compareVersions (P1-1 numeric rule)', () => {
  it('compares numeric segments numerically: 0.10.0 > 0.9.0 (localeCompare disagrees)', () => {
    expect('0.10.0'.localeCompare('0.9.0')).toBeLessThan(0)
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
  })

  it('orders multi-segment numeric versions', () => {
    expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0)
    expect(compareVersions('1.2.10', '1.2.9')).toBeGreaterThan(0)
  })

  it('treats equal versions as equal and missing segments as locale fallback', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0', '1.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
  })
})

describe('latestTemplate (P1-1 single latest rule)', () => {
  const template = (id: string, version: string): { id: string; version: string } => ({ id, version })

  it('picks the numerically latest version among mixed ids', () => {
    const all = [template('a', '0.9.0'), template('b', '1.0.0'), template('a', '0.10.0'), template('a', '0.9.1')]
    expect(latestTemplate(all, 'a')?.version).toBe('0.10.0')
  })

  it('keeps the first candidate on an exact version tie and ignores other ids', () => {
    const all = [template('a', '1.0.0'), template('a', '1.0.0'), template('b', '9.9.9')]
    expect(latestTemplate(all, 'a')).toBe(all[0])
  })

  it('returns undefined when the id is absent or the list is empty', () => {
    expect(latestTemplate([template('a', '1.0.0')], 'b')).toBeUndefined()
    expect(latestTemplate([], 'a')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// C9 / P1-2③: RunPersistence per-run persist chain
// ---------------------------------------------------------------------------
function makeRun(id: string, overrides: Partial<RunState> = {}): RunState {
  return {
    id,
    workflowName: '回归',
    configFile: 'r.yaml',
    status: 'running',
    currentState: '状态一',
    selfTransitions: {},
    transitionCount: 0,
    totalSteps: 1,
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
            startedAt: '2026-10-01T10:00:00.000Z',
            finishedAt: '2026-10-01T10:01:00.000Z',
          },
        ],
        finishedAt: '2026-10-01T10:01:00.000Z',
      },
    ],
    pendingState: null,
    pendingHuman: null,
    startedAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:01:00.000Z',
    finishedAt: null,
    error: null,
    inputs: {},
    context: {},
    ...overrides,
  }
}

let workspace = ''

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ace-regression-'))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

function stubArchive(calls: string[], failures: { throwOnRun?: number } = {}): SqliteArchive {
  let runCalls = 0
  return {
    archiveRun: (_workspace: string, _dir: string, run: RunState) => {
      runCalls += 1
      if (failures.throwOnRun === runCalls) throw new Error('mirror write boom')
      calls.push(`run:${run.completedSteps}`)
    },
    archiveAudit: (_workspace: string, _dir: string, _runId: string, event: Record<string, unknown>) => {
      calls.push(`audit:${String(event.event)}`)
    },
  } as unknown as SqliteArchive
}

describe('RunPersistence persist chain (P1-2③)', () => {
  it('serializes concurrent persists in call order with no duplicated diffs', async () => {
    const registry = new RunRegistry()
    const persistence = new RunPersistence({
      archive: stubArchive([]),
      registry,
      runDirName: RUN_DIR,
      sqliteEnabled: async () => false,
      emitRunUpdated: () => {},
    })
    const persist = persistence.makePersist(workspace, 'run-1')
    await persist(makeRun('run-1', { stateOutcomes: [], completedSteps: 0 }))
    // Exactly what a settling parallel segment does: two persists at once.
    const second = makeRun('run-1', {
      stateOutcomes: [
        ...makeRun('run-1').stateOutcomes,
        {
          state: '状态二',
          verdict: { verdict: 'fail' as const, issues: [], rationale: '未过' },
          steps: [
            {
              key: '状态二/步骤B',
              state: '状态二',
              step: '步骤B',
              type: 'script' as const,
              outputSummary: '产出B',
              verdict: { verdict: 'fail' as const, issues: [], rationale: '产出B' },
              startedAt: '2026-10-01T10:02:00.000Z',
              finishedAt: '2026-10-01T10:03:00.000Z',
            },
          ],
          finishedAt: '2026-10-01T10:03:00.000Z',
        },
      ],
      completedSteps: 2,
    })
    await Promise.all([persist(makeRun('run-1')), persist(second)])
    const auditText = await readFile(join(workspace, RUN_DIR, 'runs', 'run-1', 'audit.jsonl'), 'utf8')
    const states = auditText
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { event: string; state?: string }).state)
    expect(states).toEqual(['状态一', '状态二'])
    const loaded = await loadRunState(workspace, 'run-1', RUN_DIR)
    expect(loaded?.completedSteps).toBe(2)
  })

  it('a failed persist rejects its caller but does not stall the chain', async () => {
    const registry = new RunRegistry()
    const persistence = new RunPersistence({
      archive: stubArchive([]),
      registry,
      runDirName: RUN_DIR,
      sqliteEnabled: async () => false,
      emitRunUpdated: () => {},
    })
    const persist = persistence.makePersist(workspace, 'run-1')
    const circular = makeRun('run-1', { stateOutcomes: [], completedSteps: 0 })
    circular.context = circular as unknown as RunState['context']
    await expect(persist(circular)).rejects.toThrow()
    // Same persist callback: the chain must have survived the rejection.
    await persist(makeRun('run-1', { stateOutcomes: [], completedSteps: 0 }))
    await persist(makeRun('run-1'))
    const loaded = await loadRunState(workspace, 'run-1', RUN_DIR)
    expect(loaded?.completedSteps).toBe(1)
    const auditText = await readFile(join(workspace, RUN_DIR, 'runs', 'run-1', 'audit.jsonl'), 'utf8')
    expect(auditText.trim().split('\n')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// C15 / P1-2⑥: archive writes off the hot path, FIFO, drained on flush
// ---------------------------------------------------------------------------
describe('RunPersistence archive queue (P1-2⑥)', () => {
  it('queues run mirrors and audit mirrors FIFO, drained by flushArchives', async () => {
    const calls: string[] = []
    const registry = new RunRegistry()
    const persistence = new RunPersistence({
      archive: stubArchive(calls),
      registry,
      runDirName: RUN_DIR,
      sqliteEnabled: async () => true,
      emitRunUpdated: () => {},
    })
    const persist = persistence.makePersist(workspace, 'run-1')
    await persist(makeRun('run-1', { stateOutcomes: [], completedSteps: 0 }))
    await persist(makeRun('run-1'))
    // Not yet drained: queue may still be in flight; flush must settle it.
    await persistence.flushArchives()
    expect(calls).toEqual(['run:0', 'run:1', 'audit:state-end'])
  })

  it('a failing mirror write never breaks the persist hot path or the queue', async () => {
    const calls: string[] = []
    const registry = new RunRegistry()
    const persistence = new RunPersistence({
      archive: stubArchive(calls, { throwOnRun: 1 }),
      registry,
      runDirName: RUN_DIR,
      sqliteEnabled: async () => true,
      emitRunUpdated: () => {},
    })
    const persist = persistence.makePersist(workspace, 'run-1')
    await persist(makeRun('run-1', { stateOutcomes: [], completedSteps: 0 }))
    await persist(makeRun('run-1'))
    await persistence.flushArchives()
    // First mirror threw; the second mirror and the audit mirror still ran.
    expect(calls).toEqual(['run:1', 'audit:state-end'])
    expect(await loadRunState(workspace, 'run-1', RUN_DIR)).not.toBeNull()
  })

  it('skips mirror writes entirely when the workspace has not opted in', async () => {
    const calls: string[] = []
    const registry = new RunRegistry()
    const persistence = new RunPersistence({
      archive: stubArchive(calls),
      registry,
      runDirName: RUN_DIR,
      sqliteEnabled: async () => false,
      emitRunUpdated: () => {},
    })
    await persistence.makePersist(workspace, 'run-1')(makeRun('run-1'))
    await persistence.flushArchives()
    expect(calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// C9 / P1-2③: parallel-segment evidence snapshot (engine semantics)
// ---------------------------------------------------------------------------
const V = (verdict: StepVerdict['verdict'], rationale = ''): StepVerdict => ({ verdict, issues: [], rationale })
const fakeParent = { id: 'session-1' as unknown as SessionId, session: { header: { cwd: '/ws' } } } as unknown as Agent

function parallelState(): StateMachineState {
  return {
    name: '并行',
    steps: [
      { name: '快', agent: 'a-defender', role: 'defender', task: '先完成', parallelGroup: 'g' },
      { name: '慢', agent: 'a-attacker', role: 'attacker', task: '后完成', parallelGroup: 'g' },
    ],
    transitions: [],
    isInitial: true,
    isFinal: true,
  }
}

const parallelConfig: WorkflowConfig = {
  workflow: { name: '并行快照', mode: 'state-machine', states: [] },
}

function recordingExecutor(delays: { fast: number; slow: number }, seen: { evidence: string[]; priorTexts: string[] }): StepExecutor {
  return {
    async runAgentStep(input) {
      await new Promise((resolve) => setTimeout(resolve, input.stepName === '快' ? delays.fast : delays.slow))
      seen.evidence.push(`${input.stepName}:${input.evidence ?? '(无证据)'}`)
      seen.priorTexts.push(`${input.stepName}:${input.ctx.priorStepEvidence}`)
      return { outputSummary: `${input.stepName}产出`, verdict: V('pass') }
    },
    async runLlmStep() {
      throw new Error('该测试不应启动 LLM 步骤')
    },
    async runSubworkflowStep() {
      return { outcome: 'completed', verdict: V('pass') }
    },
  }
}

describe('executeStateSteps segment evidence snapshot (P1-2③)', () => {
  it('parallel steps both observe the segment-start snapshot, not each other', async () => {
    const seen = { evidence: [] as string[], priorTexts: [] as string[] }
    const executor = recordingExecutor({ fast: 5, slow: 40 }, seen)
    const completed = await executeStateSteps(
      { config: parallelConfig, parent: fakeParent, signal: new AbortController().signal, executor },
      parallelState(),
      { stateOutcomes: [], context: {}, inputs: {} },
    )
    expect(completed).toHaveLength(2)
    // 「快」 finished 35ms before 「慢」, yet the attacker's evidence was frozen
    // at segment start: it must NOT contain the fast step's output.
    const attackerEvidence = seen.evidence.find((entry) => entry.startsWith('慢:'))
    expect(attackerEvidence).toBeDefined()
    expect(attackerEvidence).toContain('（本状态暂无前置步骤产出）')
    expect(attackerEvidence).not.toContain('快产出')
    // Both steps saw the same prior-step text (identical snapshot).
    expect(new Set(seen.priorTexts.map((entry) => entry.slice(entry.indexOf(':')))).size).toBe(1)
  })

  it('sequential mode freezes same-group evidence at segment start (documented delta)', async () => {
    // Pre-C7 testState read the LIVE completed list per step, so a later step
    // of the same parallel group saw its same-group predecessor in isolated
    // verification. executeStateSteps now freezes evidence at segment start
    // in BOTH modes, making verification predict the real parallel run
    // (where same-group steps never see each other). This pins the current
    // contract so the delta is explicit, not accidental.
    const seen = { evidence: [] as string[], priorTexts: [] as string[] }
    const executor = recordingExecutor({ fast: 5, slow: 5 }, seen)
    await executeStateSteps(
      { config: parallelConfig, parent: fakeParent, signal: new AbortController().signal, executor },
      parallelState(),
      { stateOutcomes: [], context: {}, inputs: {} },
      { sequential: true },
    )
    const attackerEvidence = seen.evidence.find((entry) => entry.startsWith('慢:'))
    expect(attackerEvidence).toBeDefined()
    expect(attackerEvidence).toContain('（本状态暂无前置步骤产出）')
    expect(attackerEvidence).not.toContain('快产出')
  })

  it('hands earlier segments forward: a later segment sees prior completions', async () => {
    const state: StateMachineState = {
      name: '串接',
      steps: [
        { name: '前段', agent: 'a-defender', role: 'defender', task: '先', parallelGroup: 'g' },
        { name: '后段', agent: 'a-attacker', role: 'attacker', task: '后' },
      ],
      transitions: [],
      isInitial: true,
      isFinal: true,
    }
    const seen = { evidence: [] as string[], priorTexts: [] as string[] }
    const executor = recordingExecutor({ fast: 5, slow: 5 }, seen)
    await executeStateSteps(
      { config: parallelConfig, parent: fakeParent, signal: new AbortController().signal, executor },
      state,
      { stateOutcomes: [], context: {}, inputs: {} },
    )
    const attackerEvidence = seen.evidence.find((entry) => entry.startsWith('后段:'))
    expect(attackerEvidence).toBeDefined()
    expect(attackerEvidence).toContain('前段产出')
  })
})

// ---------------------------------------------------------------------------
// C2 / P1-2①: abort kills the spawned shell (needs real child processes)
// ---------------------------------------------------------------------------
const SPAWN_OK = (() => {
  try {
    const probe = spawnSync(process.execPath, ['-e', '1'])
    return probe.error == null && probe.status === 0
  } catch {
    return false
  }
})()

describe.skipIf(!SPAWN_OK)('runPreCommand abort kill (P1-2①, needs spawn)', () => {
  it('kills the spawned shell and rejects promptly when the caller aborts', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const promise = runPreCommand(
      `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 60000)"`,
      undefined,
      30_000,
      controller.signal,
    )
    setTimeout(() => controller.abort(), 100)
    await expect(promise).rejects.toThrow(/aborted/)
    // The 60s child must not outlive the abort by any meaningful margin.
    expect(Date.now() - started).toBeLessThan(15_000)
  }, 20_000)
})
