/**
 * Run persistence orchestration: the engine's per-mutation persist pipeline
 * (authoritative JSON snapshot → opt-in SQLite mirror → granular audit diff →
 * live stream projection → `ace/run-updated` event). Extracted from
 * AceHarnessService (P0-2) so the pipeline is constructible and testable on
 * its own; the JSON files stay the source of truth and every mirror is
 * best-effort.
 * @module dsh-ace-harness/run-persistence
 */
import { truncate } from './engine/prompts.js'
import type { RunState } from './engine/types.js'
import { EMPTY_PROGRESS_TRACK, progressAuditEvents } from './store/audit-events.js'
import { appendAudit, saveRunState } from './store/run-store.js'
import type { SqliteArchive } from './store/sqlite-archive.js'
import type { RunRegistry, RunStreamState } from './run-registry.js'

/** Payload of the `ace/run-updated` cordis event (frozen shape). */
export interface RunUpdatedPayload {
  runId: string
  status: string
  currentState: string | null
  completedSteps: number
  totalSteps: number
}

/** Host services the persistence pipeline draws on. */
export interface RunPersistenceDeps {
  /** The opt-in SQLite mirror (write failures are swallowed). */
  archive: SqliteArchive
  /** Shared run maps: stream projection + audit diff cursor. */
  registry: RunRegistry
  /** Run storage root name inside each workspace. */
  runDirName: string
  /** Whether the workspace opted into the SQLite archive. */
  sqliteEnabled(workspace: string): Promise<boolean>
  /** Emit the frozen `ace/run-updated` cordis event. */
  emitRunUpdated(payload: RunUpdatedPayload): void
}

/**
 * Project a persisted run snapshot onto the live stream entry: status,
 * progress counters, verdict list, state output heads, and the per-step log.
 * Idempotent — step-log entries deduplicate by step key and finished entries
 * are never rewritten, so re-projecting the same snapshot changes nothing
 * (the resume path rebuilds entries through this same projection).
 */
export function projectRunStateToStream(stream: RunStreamState, runState: RunState): void {
  stream.status = runState.status
  stream.currentState = runState.currentState ?? ''
  stream.completedSteps = runState.completedSteps
  stream.totalSteps = runState.totalSteps
  stream.verdicts = runState.stateOutcomes.map((outcome) => ({
    state: outcome.state,
    verdict: outcome.verdict.verdict,
  }))
  stream.stateOutputs = runState.stateOutcomes.map((outcome) => {
    const last = outcome.steps[outcome.steps.length - 1]
    return {
      state: outcome.state,
      verdict: outcome.verdict.verdict,
      output: truncate(last?.outputSummary ?? '', 160),
    }
  })
  // Derive the step log from the persisted progress so every step kind
  // (agent, llm, script, subworkflow) appears; the in-flight agent step keeps
  // its live text until the persist after its completion finalizes it.
  const byKey = new Map<string, number>()
  stream.stepLog.forEach((entry, index) => {
    byKey.set(entry.key, index)
  })
  const completedSteps = [
    ...runState.stateOutcomes.flatMap((outcome) => outcome.steps),
    ...(runState.pendingState?.completedSteps ?? []),
  ]
  for (const step of completedSteps) {
    const existing = byKey.get(step.key)
    if (existing === undefined) {
      stream.stepLog.push({
        key: step.key,
        state: step.state,
        step: step.step,
        type: step.type,
        agent: step.agent ?? null,
        role: step.role ?? null,
        text: step.outputSummary,
        finished: true,
      })
      byKey.set(step.key, stream.stepLog.length - 1)
    } else {
      const entry = stream.stepLog[existing]
      if (entry && !entry.finished) {
        entry.text = step.outputSummary
        entry.finished = true
      }
    }
  }
  stream.seq += 1
}

/** The per-run persist pipeline: files authoritative, mirrors best-effort. */
export class RunPersistence {
  private readonly deps: RunPersistenceDeps

  constructor(deps: RunPersistenceDeps) {
    this.deps = deps
  }

  /** Append one audit event: JSONL is authoritative; SQLite mirrors when on. */
  async writeAudit(workspace: string, runId: string, event: Record<string, unknown>): Promise<void> {
    await appendAudit(workspace, runId, this.deps.runDirName, event)
    if (await this.deps.sqliteEnabled(workspace)) {
      try {
        this.deps.archive.archiveAudit(workspace, this.deps.runDirName, runId, event)
      } catch {
        // Archive is a mirror; ignore write failures.
      }
    }
  }

  /** Build the engine persist callback of one run. */
  makePersist(workspace: string, runId: string): (runState: RunState) => Promise<void> {
    return async (runState: RunState): Promise<void> => {
      await this.persistSnapshot(workspace, runId, runState)
    }
  }

  /** Persist one run snapshot through the full pipeline. */
  private async persistSnapshot(workspace: string, runId: string, runState: RunState): Promise<void> {
    await saveRunState(workspace, runState, this.deps.runDirName)
    // Opt-in SQLite mirror: long-term, queryable evidence chain. A mirror
    // failure must never break the run — the JSON file stays authoritative.
    if (await this.deps.sqliteEnabled(workspace)) {
      try {
        this.deps.archive.archiveRun(workspace, this.deps.runDirName, runState)
      } catch {
        // Archive is a mirror; ignore write failures.
      }
    }
    // Evidence chain: diff the snapshot into granular audit events
    // (state-end / waiting-human / human-resolved) so the audit timeline
    // tells the full story, not just start/resume/end.
    const tracked = this.deps.registry.progressTrack.get(runId) ?? EMPTY_PROGRESS_TRACK
    const derived = progressAuditEvents(tracked, runState)
    this.deps.registry.progressTrack.set(runId, derived.next)
    for (const event of derived.events) {
      await this.writeAudit(workspace, runId, event)
    }
    const stream = this.deps.registry.streams.get(runId)
    if (stream) {
      projectRunStateToStream(stream, runState)
    }
    this.deps.emitRunUpdated({
      runId: runState.id,
      status: runState.status,
      currentState: runState.currentState,
      completedSteps: runState.completedSteps,
      totalSteps: runState.totalSteps,
    })
  }
}
