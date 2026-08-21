import { describe, expect, it } from 'vitest'
import type { RunState } from '../src/engine/types.ts'
import {
  auditEvent,
  EMPTY_PROGRESS_TRACK,
  progressAuditEvents,
  runDurationMs,
  sha256Text,
} from '../src/store/audit-events.ts'

function makeState(overrides: Partial<RunState>): RunState {
  return {
    id: 'run-1',
    workflowName: 'wf',
    configFile: 'wf.yaml',
    status: 'running',
    currentState: 'A',
    selfTransitions: {},
    transitionCount: 0,
    totalSteps: 2,
    completedSteps: 0,
    stateOutcomes: [],
    pendingState: null,
    pendingHuman: null,
    startedAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    finishedAt: null,
    error: null,
    inputs: {},
    context: {},
    ...overrides,
  }
}

function outcome(state: string, verdict: 'success' | 'fail') {
  return {
    state,
    verdict: { verdict, issues: [], rationale: '' },
    steps: [
      {
        key: `${state}/s1`,
        state,
        step: 's1',
        type: 'script',
        outputSummary: 'o',
        startedAt: '2026-08-20T10:00:00.000Z',
        finishedAt: '2026-08-20T10:00:02.000Z',
      },
      {
        key: `${state}/s2`,
        state,
        step: 's2',
        type: 'script',
        outputSummary: 'o',
        startedAt: '2026-08-20T10:00:02.000Z',
        finishedAt: '2026-08-20T10:00:05.000Z',
      },
    ],
    finishedAt: '2026-08-20T10:00:05.000Z',
  }
}

describe('progressAuditEvents', () => {
  it('emits one state-end event per newly completed state, with duration', () => {
    const first = progressAuditEvents(EMPTY_PROGRESS_TRACK, makeState({ stateOutcomes: [outcome('A', 'success')] }))
    expect(first.events).toHaveLength(1)
    expect(first.events[0]).toMatchObject({ event: 'state-end', state: 'A', verdict: 'success', steps: 2, durationMs: 5000 })
    expect(first.next.states).toBe(1)
    // A repeat snapshot of the same position emits nothing new.
    const again = progressAuditEvents(first.next, makeState({ stateOutcomes: [outcome('A', 'success')] }))
    expect(again.events).toHaveLength(0)
    // The next state completion emits exactly its own event.
    const second = progressAuditEvents(again.next, makeState({ stateOutcomes: [outcome('A', 'success'), outcome('B', 'fail')] }))
    expect(second.events.map((e) => e['event'])).toEqual(['state-end'])
    expect(second.events[0]).toMatchObject({ state: 'B', verdict: 'fail' })
  })

  it('opens and closes waiting-human exactly once per wait', () => {
    const waitingState = makeState({
      status: 'waiting-human',
      currentState: '审批',
      pendingHuman: { kind: 'approval', state: '审批', candidates: ['继续', '终止'] },
    })
    const open = progressAuditEvents(EMPTY_PROGRESS_TRACK, waitingState)
    expect(open.events).toEqual([
      expect.objectContaining({ event: 'waiting-human', state: '审批', candidates: ['继续', '终止'] }),
    ])
    // Still waiting on the next snapshot: no duplicate.
    const still = progressAuditEvents(open.next, waitingState)
    expect(still.events).toHaveLength(0)
    // Resolved: back to running closes the wait exactly once.
    const resolved = progressAuditEvents(still.next, makeState({ status: 'running', currentState: '继续' }))
    expect(resolved.events).toEqual([expect.objectContaining({ event: 'human-resolved', state: '继续' })])
    const after = progressAuditEvents(resolved.next, makeState({ status: 'running', currentState: '继续' }))
    expect(after.events).toHaveLength(0)
  })
})

describe('auditEvent (P1-C single construction point)', () => {
  it('always places at/event first and merges the event fields', () => {
    const row = auditEvent('end', { status: 'completed', evidenceHash: 'abc' }, '2026-01-01T00:00:00.000Z')
    expect(row).toEqual({ at: '2026-01-01T00:00:00.000Z', event: 'end', status: 'completed', evidenceHash: 'abc' })
  })

  it('defaults `at` to the current wall clock', () => {
    const before = Date.now()
    const row = auditEvent('start', { workflow: 'wf' })
    expect(row.event).toBe('start')
    expect(typeof row.at).toBe('string')
    expect(Date.parse(row.at as string)).toBeGreaterThanOrEqual(before)
  })

  it('carries every event kind through the same row shape', () => {
    for (const kind of ['start', 'resume', 'end', 'state-end', 'waiting-human', 'human-resolved'] as const) {
      expect(auditEvent(kind).event).toBe(kind)
      expect(typeof auditEvent(kind).at).toBe('string')
    }
  })
})

describe('runDurationMs / sha256Text', () => {
  it('spans the whole run from step timestamps', () => {
    expect(runDurationMs([outcome('A', 'success'), outcome('B', 'fail')])).toBe(5000)
    expect(runDurationMs([])).toBeNull()
  })

  it('hashes deterministically', () => {
    expect(sha256Text('{"a":1}')).toBe(sha256Text('{"a":1}'))
    expect(sha256Text('{"a":1}')).not.toBe(sha256Text('{"a":2}'))
    expect(sha256Text('x')).toMatch(/^[0-9a-f]{64}$/)
  })
})
