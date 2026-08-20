import { describe, expect, it } from 'vitest'
import { normalizeStaleRun } from '../src/store/run-store.js'
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
