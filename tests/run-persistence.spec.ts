import { mkdtemp, rm } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunState } from '../src/engine/types.ts'
import type { WorkflowConfig } from '../src/dsl/types.ts'
import { projectRunStateToStream, RunPersistence, type RunUpdatedPayload } from '../src/run-persistence.js'
import { RunRegistry } from '../src/run-registry.js'
import { loadRunState } from '../src/store/run-store.ts'
import { SqliteArchive } from '../src/store/sqlite-archive.ts'

let workspace = ''
let archive: SqliteArchive

const RUN_DIR_NAME = '.ace-workflows'

function makeConfig(): WorkflowConfig {
  return {
    workflow: {
      name: '演示',
      mode: 'state-machine',
      states: [
        {
          name: '状态一',
          steps: [{ name: '步骤A', type: 'script', script: 'return { output: "x", success: true }' }],
          transitions: [],
          isInitial: true,
          isFinal: true,
        },
      ],
    },
  }
}

function makeRun(id: string, overrides: Partial<RunState> = {}): RunState {
  return {
    id,
    workflowName: '演示',
    configFile: 'demo.yaml',
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

function makePersistence(registry: RunRegistry, emitted: RunUpdatedPayload[]): RunPersistence {
  return new RunPersistence({
    archive,
    registry,
    runDirName: RUN_DIR_NAME,
    sqliteEnabled: async () => false,
    emitRunUpdated: (payload) => emitted.push(payload),
  })
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ace-persist-'))
  archive = new SqliteArchive()
})

afterEach(async () => {
  archive.close()
  await rm(workspace, { recursive: true, force: true })
})

describe('projectRunStateToStream', () => {
  it('backfills verdicts, state output heads, and the step log from a snapshot', () => {
    const registry = new RunRegistry()
    const stream = registry.openStream({ runId: 'run-1', workflowName: '演示', config: makeConfig(), totalSteps: 1 })
    projectRunStateToStream(stream, makeRun('run-1'))
    expect(stream.status).toBe('running')
    expect(stream.currentState).toBe('状态一')
    expect(stream.completedSteps).toBe(1)
    expect(stream.verdicts).toEqual([{ state: '状态一', verdict: 'success' }])
    expect(stream.stateOutputs).toEqual([{ state: '状态一', verdict: 'success', output: '产出A' }])
    expect(stream.stepLog).toEqual([
      {
        key: '状态一/步骤A',
        state: '状态一',
        step: '步骤A',
        type: 'script',
        agent: null,
        role: null,
        text: '产出A',
        finished: true,
      },
    ])
  })

  it('is idempotent: re-projecting the same snapshot changes nothing but seq', () => {
    const registry = new RunRegistry()
    const stream = registry.openStream({ runId: 'run-1', workflowName: '演示', config: makeConfig(), totalSteps: 1 })
    const run = makeRun('run-1')
    projectRunStateToStream(stream, run)
    const stepLogAfterFirst = JSON.stringify(stream.stepLog)
    projectRunStateToStream(stream, run)
    expect(JSON.stringify(stream.stepLog)).toBe(stepLogAfterFirst)
    expect(stream.stepLog).toHaveLength(1)
  })
})

describe('RunPersistence.makePersist', () => {
  it('writes the authoritative state.json and emits ace/run-updated', async () => {
    const registry = new RunRegistry()
    const emitted: RunUpdatedPayload[] = []
    const persistence = makePersistence(registry, emitted)
    const persist = persistence.makePersist(workspace, 'run-1')
    await persist(makeRun('run-1'))
    const loaded = await loadRunState(workspace, 'run-1', RUN_DIR_NAME)
    expect(loaded?.workflowName).toBe('演示')
    expect(emitted).toEqual([
      { runId: 'run-1', status: 'running', currentState: '状态一', completedSteps: 1, totalSteps: 1 },
    ])
  })

  it('diffs settled states into state-end audit events (JSONL authoritative)', async () => {
    const registry = new RunRegistry()
    const persistence = makePersistence(registry, [])
    const persist = persistence.makePersist(workspace, 'run-1')
    // The engine always persists once with zero outcomes when a run starts;
    // that snapshot seeds the audit cursor (P1-2⑤).
    await persist(makeRun('run-1', { stateOutcomes: [], completedSteps: 0 }))
    await persist(makeRun('run-1'))
    const auditText = await readFile(join(workspace, RUN_DIR_NAME, 'runs', 'run-1', 'audit.jsonl'), 'utf8')
    const events = auditText.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ event: 'state-end', state: '状态一', verdict: 'success', steps: 1 })
    // The cursor advanced: persisting the same snapshot emits no duplicate.
    await persist(makeRun('run-1'))
    const again = await readFile(join(workspace, RUN_DIR_NAME, 'runs', 'run-1', 'audit.jsonl'), 'utf8')
    expect(again.trim().split('\n')).toHaveLength(1)
  })

  it('seeds the audit cursor without replaying history on a resumed run (P1-2⑤)', async () => {
    const registry = new RunRegistry()
    const persistence = makePersistence(registry, [])
    const persist = persistence.makePersist(workspace, 'run-1')
    // A resumed process' first snapshot carries states completed in the
    // previous process: they must not be replayed into the audit log.
    await persist(makeRun('run-1'))
    const auditText = await readFile(join(workspace, RUN_DIR_NAME, 'runs', 'run-1', 'audit.jsonl'), 'utf8').catch(() => '')
    expect(auditText.trim()).toBe('')
    // A genuinely new state after the resume still diffs exactly once.
    await persist(
      makeRun('run-1', {
        stateOutcomes: [
          ...makeRun('run-1').stateOutcomes,
          {
            state: '状态二',
            verdict: { verdict: 'success', issues: [], rationale: '通过' },
            steps: [
              {
                key: '状态二/步骤B',
                state: '状态二',
                step: '步骤B',
                type: 'script',
                outputSummary: '产出B',
                verdict: { verdict: 'success', issues: [], rationale: '产出B' },
                startedAt: '2026-08-20T10:02:00.000Z',
                finishedAt: '2026-08-20T10:03:00.000Z',
              },
            ],
            finishedAt: '2026-08-20T10:03:00.000Z',
          },
        ],
        completedSteps: 2,
      }),
    )
    const after = await readFile(join(workspace, RUN_DIR_NAME, 'runs', 'run-1', 'audit.jsonl'), 'utf8')
    const events = after.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ event: 'state-end', state: '状态二' })
  })

  it('projects the snapshot onto the live stream when one is registered', async () => {
    const registry = new RunRegistry()
    registry.openStream({ runId: 'run-1', workflowName: '演示', config: makeConfig(), totalSteps: 1 })
    const persistence = makePersistence(registry, [])
    await persistence.makePersist(workspace, 'run-1')(makeRun('run-1'))
    const stream = registry.streams.get('run-1')!
    expect(stream.status).toBe('running')
    expect(stream.stepLog).toHaveLength(1)
    expect(stream.stepLog[0]!.finished).toBe(true)
  })
})
