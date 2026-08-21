/**
 * Evidence-chain enrichment for the run audit log. Pure derivation from
 * persisted run snapshots: each new state completion becomes a `state-end`
 * event, and entering/leaving `waiting-human` becomes an explicit event, so
 * the audit timeline reads as a complete evidence trail even between the
 * coarse start/resume/end rows. Hash helpers make runs tamper-evident.
 * @module dsh-ace-harness/store
 */
import { createHash } from 'node:crypto'
import type { RunState, StateOutcome, StepOutcome } from '../engine/types.js'

/** Per-run progress cursor carried between persist snapshots. */
export interface RunProgressTrack {
  /** Number of state outcomes already audited. */
  states: number
  /** Whether a `waiting-human` event is currently open. */
  waiting: boolean
}

export const EMPTY_PROGRESS_TRACK: RunProgressTrack = { states: 0, waiting: false }

/**
 * The audit event names the chain can carry. The set is the single writer's
 * vocabulary (P1-C): start / resume / end come from the run lifecycle, the
 * derived events come from `progressAuditEvents`, and every row is built by
 * `auditEvent` before it reaches `writeAudit`.
 */
export type AuditEventKind = 'start' | 'resume' | 'end' | 'state-end' | 'waiting-human' | 'human-resolved'

/** One audit row: `at` + `event` are always present, the rest is event data. */
export type AuditEventRow = Record<string, unknown>

/**
 * Single construction point for every audit row (P1-C). All call sites —
 * lifecycle start/resume/end, the persist pipeline's derived events, and the
 * terminal settle paths — build their rows through this factory so the event
 * vocabulary and the `at`/`event` placement cannot drift apart. The returned
 * shape stays a plain record: the JSONL append and the SQLite mirror consume
 * whatever fields a row carries.
 */
export function auditEvent(
  kind: AuditEventKind,
  fields: AuditEventRow = {},
  at = new Date().toISOString(),
): AuditEventRow {
  return { at, event: kind, ...fields }
}

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
 * One step's duration, preferring the monotonic-clock measurement recorded at
 * the execution site (P1-E) and falling back to the wall-clock timestamp span
 * for runs persisted before the instrumentation landed (G7: old data has no
 * monotonic value — handled as missing). Shared by the stats kernel so both
 * feed paths use the same duration definition.
 */
export function stepDurationMs(step: StepOutcome): number | null {
  if (typeof step.durationMs === 'number' && Number.isFinite(step.durationMs) && step.durationMs >= 0) {
    return step.durationMs
  }
  const span = Date.parse(step.finishedAt) - Date.parse(step.startedAt)
  return Number.isFinite(span) && span >= 0 ? span : null
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
    events.push(
      auditEvent('state-end', {
        state: outcome.state,
        verdict: outcome.verdict.verdict,
        steps: outcome.steps.length,
        durationMs: outcomeDurationMs(outcome),
      }, outcome.finishedAt ?? now),
    )
  }
  let waiting = tracked.waiting
  if (state.status === 'waiting-human' && !waiting) {
    waiting = true
    events.push(
      auditEvent('waiting-human', {
        state: state.pendingHuman?.state ?? state.currentState ?? '',
        kind: state.pendingHuman?.kind ?? 'approval',
        candidates: state.pendingHuman?.candidates ?? [],
      }, now),
    )
  } else if (state.status !== 'waiting-human' && waiting) {
    // A human decision (or stop) resolved the wait; close the marker.
    waiting = false
    events.push(auditEvent('human-resolved', { state: state.currentState ?? '' }, now))
  }
  return { events, next: { states: state.stateOutcomes.length, waiting } }
}

/** SHA-256 hex digest of one text payload (tamper-evident run records). */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
