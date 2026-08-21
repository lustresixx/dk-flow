import { describe, expect, it } from 'vitest'
import { hostname } from 'node:os'
import {
  isOwnerAlive,
  isPidAlive,
  normalizeRunStatus,
  normalizeStaleRun,
  PID_LIVE_GRACE_MS,
  STALE_RUN_MS,
} from '../src/store/run-store.js'
import type { RunState } from '../src/engine/types.js'

const NOW = Date.now()
const HOST = hostname()

function state(pid?: number, host: string = HOST): RunState {
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
    hostId: host,
  }
}

describe('pid-aware stale normalization (P1-1/P1-2 adjudicated)', () => {
  it('keeps a stale-but-live run running when its SAME-HOST pid is alive (within the grace window)', () => {
    const alive = normalizeStaleRun(state(process.pid), NOW)
    expect(alive.status).toBe('running')
    expect(alive.error).toBeNull()
  })

  it('marks a stale run crashed when its pid is dead', () => {
    const dead = normalizeStaleRun(state(999_999_999), NOW)
    expect(dead.status).toBe('crashed')
    expect(dead.error).toContain('进程已退出')
  })

  it('does NOT exempt a stale run whose live pid outlives the grace window (hang detection restored, P1-1)', () => {
    const hung = state(process.pid)
    hung.updatedAt = new Date(NOW - STALE_RUN_MS - PID_LIVE_GRACE_MS - 1).toISOString()
    const normalized = normalizeStaleRun(hung, NOW)
    expect(normalized.status).toBe('crashed')
    // The process is still there — the run stopped persisting. Say "hung",
    // not "exited", so the diagnosis is accurate.
    expect(normalized.error).toContain('疑似挂起')
  })

  it('never trusts a pid recorded by ANOTHER machine (cross-machine guard, P1-2)', () => {
    const foreign = normalizeStaleRun(state(process.pid, 'some-other-machine'), NOW)
    expect(foreign.status).toBe('crashed')
    expect(foreign.error).toContain('进程已退出')
  })

  it('treats a run with a pid but no recorded host like a run without a pid (time rule only)', () => {
    // A state persisted before the host gate (pid present, hostId key absent)
    // must not be exempted: without a host identity the pid cannot be trusted.
    const noHost = state(process.pid)
    delete (noHost as Partial<RunState>).hostId
    expect(normalizeStaleRun(noHost, NOW).status).toBe('crashed')
  })

  it('keeps the shared rule backward-compatible when no pid is recorded', () => {
    expect(normalizeRunStatus('running', new Date(NOW - STALE_RUN_MS - 1).toISOString(), NOW)).toBe('crashed')
  })

  it('isOwnerAlive requires a recorded host AND a live same-host pid', () => {
    expect(isOwnerAlive({})).toBe(false)
    expect(isOwnerAlive({ pid: process.pid })).toBe(false)
    expect(isOwnerAlive({ pid: process.pid, hostId: 'some-other-machine' })).toBe(false)
    expect(isOwnerAlive({ pid: 999_999_999, hostId: HOST })).toBe(false)
    expect(isOwnerAlive({ pid: process.pid, hostId: HOST })).toBe(true)
  })

  it('isPidAlive rejects non-positive and non-integer pids', () => {
    expect(isPidAlive(0)).toBe(false)
    expect(isPidAlive(-1)).toBe(false)
    expect(isPidAlive(1.5)).toBe(false)
    expect(isPidAlive(process.pid)).toBe(true)
  })
})
