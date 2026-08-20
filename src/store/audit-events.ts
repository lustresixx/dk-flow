/**
 * Evidence-chain enrichment for the run audit log. Pure derivation from
 * persisted run snapshots: each new state completion becomes a `state-end`
 * event, and entering/leaving `waiting-human` becomes an explicit event, so
 * the audit timeline reads as a complete evidence trail even between the
 * coarse start/resume/end rows. Hash helpers make runs tamper-evident.
 * @module dsh-ace-harness/store
 */
import { createHash } from 'node:crypto'
import type { RunState, StateOutcome } from '../engine/types.js'

/** Per-run progress cursor carried between persist snapshots. */
export interface RunProgressTrack {
  /** Number of state outcomes already audited. */
  states: number
  /** Whether a `waiting-human` event is currently open. */
  waiting: boolean
}

export const EMPTY_PROGRESS_TRACK: RunProgressTrack = { states: 0, waiting: false }

/** Wall-clock duration of one state outcome from its step timestamps. */
function outcomeDurationMs(outcome: StateOutcome): number | null {
  const starts = outcome.steps.map((step) => Date.parse(step.startedAt)).filter(Number.isFinite)
  const ends = outcome.steps.map((step) => Date.parse(step.finishedAt)).filter(Number.isFinite)
  if (starts.length === 0 || ends.length === 0) return null
  return Math.max(0, Math.max(...ends) - Math.min(...starts))
}

/** Wall-clock span of a whole run from its state outcomes' step timestamps. */
export function runDurationMs(outcomes: StateOutcome[]): number | null {
  const starts = outcomes.flatMap((outcome) => outcome.steps.map((step) => Date.parse(step.startedAt))).filter(Number.isFinite)
  const ends = outcomes.flatMap((outcome) => outcome.steps.map((step) => Date.parse(step.finishedAt))).filter(Number.isFinite)
  if (starts.length === 0 || ends.length === 0) return null
  return Math.max(0, Math.max(...ends) - Math.min(...starts))
}

/**
 * Derive the audit events one persisted snapshot adds on top of the tracked
 * position. Pure: the caller stores `next` until the next snapshot.
 */
export function progressAuditEvents(
  tracked: RunProgressTrack,
  state: RunState,
  now = new Date().toISOString(),
): { events: Array<Record<string, unknown>>; next: RunProgressTrack } {
  const events: Array<Record<string, unknown>> = []
  for (let index = tracked.states; index < state.stateOutcomes.length; index += 1) {
    const outcome = state.stateOutcomes[index]!
    events.push({
      at: outcome.finishedAt ?? now,
      event: 'state-end',
      state: outcome.state,
      verdict: outcome.verdict.verdict,
      steps: outcome.steps.length,
      durationMs: outcomeDurationMs(outcome),
    })
  }
  let waiting = tracked.waiting
  if (state.status === 'waiting-human' && !waiting) {
    waiting = true
    events.push({
      at: now,
      event: 'waiting-human',
      state: state.pendingHuman?.state ?? state.currentState ?? '',
      kind: state.pendingHuman?.kind ?? 'approval',
      candidates: state.pendingHuman?.candidates ?? [],
    })
  } else if (state.status !== 'waiting-human' && waiting) {
    // A human decision (or stop) resolved the wait; close the marker.
    waiting = false
    events.push({ at: now, event: 'human-resolved', state: state.currentState ?? '' })
  }
  return { events, next: { states: state.stateOutcomes.length, waiting } }
}

/** SHA-256 hex digest of one text payload (tamper-evident run records). */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
