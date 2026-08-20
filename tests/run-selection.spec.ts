import { describe, expect, it } from 'vitest'
import { selectRun, sessionRuns, type RunSelection, type SelectableRun } from '../src/client/run-selection.ts'

const NONE: RunSelection = { runId: null, active: false }

const finished = (runId: string, startedAt: string): SelectableRun => ({
  runId,
  status: 'completed',
  startedAt,
})

const active = (runId: string): SelectableRun => ({
  runId,
  status: 'running',
  startedAt: '2026-01-01T00:00:02Z',
})

describe('selectRun', () => {
  it('returns an empty selection when there are no runs', () => {
    expect(selectRun(NONE, null, [])).toEqual(NONE)
  })

  it('selects an active run and marks it active', () => {
    const selection = selectRun(NONE, null, [finished('old', '2026-01-01T00:00:00Z'), active('run-1')])
    expect(selection).toEqual({ runId: 'run-1', active: true })
  })

  it('lets an active run take over a finished current selection', () => {
    const current: RunSelection = { runId: 'run-old', active: false }
    const selection = selectRun(current, null, [active('run-2'), finished('run-old', '2026-01-01T00:00:00Z')])
    expect(selection).toEqual({ runId: 'run-2', active: true })
  })

  it('sticks with the current finished run inside the recent window', () => {
    const current: RunSelection = { runId: 'run-1', active: false }
    const selection = selectRun(current, null, [finished('run-1', '2026-01-01T00:00:00Z')])
    expect(selection).toEqual(current)
  })

  it('flips active to false once the selected run finishes', () => {
    const current: RunSelection = { runId: 'run-1', active: true }
    const selection = selectRun(current, null, [finished('run-1', '2026-01-01T00:00:00Z')])
    expect(selection).toEqual({ runId: 'run-1', active: false })
  })

  it('falls back to the remembered last run when nothing is selected', () => {
    const selection = selectRun(NONE, 'run-remembered', [finished('run-other', '2026-01-01T00:00:01Z'), finished('run-remembered', '2026-01-01T00:00:00Z')])
    expect(selection).toEqual({ runId: 'run-remembered', active: false })
  })

  it('falls back to the newest recent run without a remembered run', () => {
    const selection = selectRun(NONE, null, [finished('newer', '2026-01-01T00:00:01Z'), finished('older', '2026-01-01T00:00:00Z')])
    expect(selection).toEqual({ runId: 'newer', active: false })
  })

  it('returns the same selection object when nothing changed', () => {
    const current: RunSelection = { runId: 'run-1', active: true }
    expect(selectRun(current, null, [active('run-1')])).toBe(current)
  })
})

describe('sessionRuns', () => {
  const owned = (runId: string, parentSessionId: string | null): SelectableRun & { parentSessionId: string | null } => ({
    runId,
    status: 'running',
    startedAt: '2026-01-01T00:00:02Z',
    parentSessionId,
  })

  it('keeps only runs owned by the current session', () => {
    const runs = [owned('run-a', 'session-1'), owned('run-b', 'session-2')]
    expect(sessionRuns(runs, 'session-1').map((run) => run.runId)).toEqual(['run-a'])
  })

  it('returns nothing when no session is open', () => {
    expect(sessionRuns([owned('run-a', 'session-1')], undefined)).toEqual([])
  })

  it('hides API-synthetic runs (null parent) from every session', () => {
    expect(sessionRuns([owned('run-api', null)], 'session-1')).toEqual([])
  })

  it('returns nothing when the current session owns no run', () => {
    expect(sessionRuns([owned('run-b', 'session-2')], 'session-1')).toEqual([])
  })
})
