import { describe, expect, it } from 'vitest'
import { isPidAlive, normalizeRunStatus, normalizeStaleRun, STALE_RUN_MS } from '../src/store/run-store.js'
import type { RunState } from '../src/engine/types.js'

const NOW = Date.now()

function state(pid?: number): RunState {
  return {
    id: 'run-1',
    workflowName: 'w',
    configFile: 'w.yaml',
    status: 'running',
    currentState: '方案',
    selfTransitions: {},
    transitionCount: 0,
    totalSteps: 8,
    completedSteps: 0,
    stateOutcomes: [],
    pendingState: null,
    pendingHuman: null,
    startedAt: new Date(NOW - 3_600_000).toISOString(),
    updatedAt: new Date(NOW - STALE_RUN_MS - 60_000).toISOString(),
    finishedAt: null,
    error: null,
    inputs: {},
    context: {},
    ...(pid !== undefined ? { pid } : {}),
  }
}

describe('pid-aware stale normalization', () => {
  it('keeps a stale-but-live run running when its pid is alive', () => {
    const alive = normalizeStaleRun(state(process.pid), NOW)
    expect(alive.status).toBe('running')
    expect(alive.error).toBeNull()
  })

  it('marks a stale run crashed when its pid is dead', () => {
    const dead = normalizeStaleRun(state(999_999_999), NOW)
    expect(dead.status).toBe('crashed')
  })

  it('keeps the shared rule backward-compatible when no pid is recorded', () => {
    expect(normalizeRunStatus('running', new Date(NOW - STALE_RUN_MS - 1).toISOString(), NOW)).toBe('crashed')
  })

  it('isPidAlive rejects non-positive and non-integer pids', () => {
    expect(isPidAlive(0)).toBe(false)
    expect(isPidAlive(-1)).toBe(false)
    expect(isPidAlive(1.5)).toBe(false)
    expect(isPidAlive(process.pid)).toBe(true)
  })
})
