import { describe, expect, it } from 'vitest'
import { normalizeRunStatus, normalizeStaleRun, STALE_RUN_MS } from '../src/store/run-store.js'
import type { RunState } from '../src/engine/types.js'

const base: RunState = {
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
  startedAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  finishedAt: null,
  error: null,
  inputs: {},
  context: {},
}

const NOW = Date.parse('2026-01-01T01:00:00Z')

describe('normalizeStaleRun', () => {
  it('marks long-idle non-terminal runs as crashed without touching the file', () => {
    const normalized = normalizeStaleRun(base, NOW)
    expect(normalized.status).toBe('crashed')
    expect(normalized.error).toContain('中断')
    expect(base.status).toBe('running')
  })

  it('leaves recent non-terminal runs alone', () => {
    const recent = { ...base, updatedAt: '2026-01-01T00:59:00Z' }
    expect(normalizeStaleRun(recent, NOW).status).toBe('running')
  })

  it('leaves terminal runs alone regardless of age', () => {
    const completed = { ...base, status: 'completed' as const, finishedAt: '2026-01-01T00:00:00Z' }
    expect(normalizeStaleRun(completed, NOW).status).toBe('completed')
    const waitingHuman = { ...base, status: 'waiting-human' as const, pendingHuman: { kind: 'no-match' as const, state: '方案', candidates: [] } }
    const normalizedWaiting = normalizeStaleRun(waitingHuman, NOW)
    expect(normalizedWaiting.status).toBe('crashed')
    expect(normalizedWaiting.pendingHuman).not.toBeNull()
  })

  it('treats unparseable timestamps as fresh (never falsely crashes)', () => {
    const broken = { ...base, updatedAt: 'not-a-date' }
    expect(normalizeStaleRun(broken, NOW).status).toBe('running')
  })
})

describe('normalizeRunStatus (P1-2 shared single stale rule)', () => {
  // The SQL stats feed and the JSON file scan both derive status from this
  // ONE function (P1-2). Pin the rule's own boundaries so the two feeds
  // cannot re-split over an off-by-one or a terminal-status edge.
  const stale = new Date(NOW - STALE_RUN_MS - 1).toISOString()
  const exactBoundary = new Date(NOW - STALE_RUN_MS).toISOString()
  const fresh = new Date(NOW - STALE_RUN_MS + 1).toISOString()

  it('crashes a non-terminal status past the staleness bound', () => {
    expect(normalizeRunStatus('running', stale, NOW)).toBe('crashed')
  })

  it('keeps a non-terminal status AT the exact boundary (strict >)', () => {
    // STALE_RUN_MS exactly: `now - updated > STALE_RUN_MS` is false, so the
    // run is NOT stale. An off-by-one (>=) here would crash a run that is
    // exactly on the boundary in both feeds.
    expect(normalizeRunStatus('running', exactBoundary, NOW)).toBe('running')
  })

  it('keeps a fresh non-terminal status', () => {
    expect(normalizeRunStatus('running', fresh, NOW)).toBe('running')
  })

  it('never ages terminal statuses, however old', () => {
    for (const status of ['completed', 'failed', 'stopped', 'crashed']) {
      expect(normalizeRunStatus(status, stale, NOW)).toBe(status)
    }
  })

  it('treats unparseable updatedAt as fresh in the shared rule too', () => {
    expect(normalizeRunStatus('running', 'not-a-date', NOW)).toBe('running')
  })

  it('applies the stale rule to any non-terminal status (waiting-human included)', () => {
    expect(normalizeRunStatus('waiting-human', stale, NOW)).toBe('crashed')
    expect(normalizeRunStatus('waiting-human', fresh, NOW)).toBe('waiting-human')
  })
})
