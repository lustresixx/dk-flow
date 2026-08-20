/**
 * Run registry: single owner of the three per-run maps (active stop
 * controllers, live stream projections, audit progress cursors) plus the
 * stream prune policy. Extracted from AceHarnessService (P0-2) so the
 * lifecycle, persistence, and step-executor collaborators share one owner
 * instead of reaching into the service. Pure bookkeeping — no host service
 * access, independently constructible for tests.
 * @module dsh-ace-harness/run-registry
 */
import type { WorkflowConfig } from './dsl/types.js'
import type { RunProgressTrack } from './store/audit-events.js'

/** Live streaming projection of one run, polled by the web panel. */
export interface RunStreamSnapshot {
  runId: string
  workflowName: string
  status: string
  currentState: string
  currentStep: string | null
  agent: string | null
  role: string | null
  text: string
  seq: number
  completedSteps: number
  totalSteps: number
  states: { name: string; isInitial: boolean; isFinal: boolean; position: { x: number; y: number } | null }[]
  transitions: { from: string; to: string; verdict: string | null; label: string | null }[]
  verdicts: { state: string; verdict: string }[]
  /** Completed states' actual output heads — the data flowing forward. */
  stateOutputs: { state: string; verdict: string; output: string }[]
  /** Per-step streaming log: the current entry grows live. */
  stepLog: {
    key: string
    state: string
    step: string
    type: 'agent' | 'script' | 'subworkflow' | 'llm'
    agent: string | null
    role: string | null
    text: string
    finished: boolean
  }[]
}

/** Live streaming state for one run, updated by the step executor. */
export interface RunStreamState extends RunStreamSnapshot {
  /** Child session being folded; null when no step is executing. */
  childSessionId: string | null
  /** Next event index for the transcript fold. */
  foldIndex: number
  /** Prune timer after settlement. */
  pruneTimer?: ReturnType<typeof setTimeout>
  /** Index of the stepLog entry currently being streamed. */
  stepLogIndex: number
}

/** Settled stream entries linger this long for late pollers, then prune. */
const STREAM_PRUNE_MS = 10 * 60_000

/** Owner of the per-run maps and the stream prune policy. */
export class RunRegistry {
  /** Active runs: runId → its stop controller. */
  readonly active = new Map<string, AbortController>()
  /** Live stream projections, keyed by runId. */
  readonly streams = new Map<string, RunStreamState>()
  /** Audit enrichment cursors: per-run position for state-end diffing. */
  readonly progressTrack = new Map<string, RunProgressTrack>()

  /** Whether starting another run would exceed the concurrency cap. */
  isFull(maxConcurrentRuns: number): boolean {
    return this.active.size >= maxConcurrentRuns
  }

  /** Register a run's stop controller. */
  register(runId: string, controller: AbortController): void {
    this.active.set(runId, controller)
  }

  /** Drop a run's stop controller (the run settled). */
  release(runId: string): void {
    this.active.delete(runId)
  }

  /** Cancel an active run. Returns false when the run is not active. */
  stop(runId: string): boolean {
    const controller = this.active.get(runId)
    if (!controller) return false
    controller.abort()
    return true
  }

  /** Whether a run id is currently executing. */
  isActive(runId: string): boolean {
    return this.active.has(runId)
  }

  /** Drop the audit diff cursor of a run (terminal cleanup). */
  finishRun(runId: string): void {
    this.progressTrack.delete(runId)
  }

  /** Open the live streaming projection of a new run (full topology). */
  openStream(input: {
    runId: string
    workflowName: string
    config: WorkflowConfig
    totalSteps: number
  }): RunStreamState {
    const stream: RunStreamState = {
      runId: input.runId,
      workflowName: input.workflowName,
      status: 'preparing',
      currentState: '',
      currentStep: null,
      agent: null,
      role: null,
      text: '',
      seq: 0,
      completedSteps: 0,
      totalSteps: input.totalSteps,
      states: input.config.workflow.states.map((machineState) => ({
        name: machineState.name,
        isInitial: machineState.isInitial,
        isFinal: machineState.isFinal,
        position: machineState.position ?? null,
      })),
      transitions: input.config.workflow.states.flatMap((machineState) =>
        machineState.transitions.map((transition) => ({
          from: machineState.name,
          to: transition.to,
          verdict: transition.condition.verdict ?? null,
          label: transition.label ?? null,
        })),
      ),
      verdicts: [],
      stateOutputs: [],
      stepLog: [],
      childSessionId: null,
      foldIndex: 0,
      stepLogIndex: -1,
    }
    this.streams.set(input.runId, stream)
    return stream
  }

  /** Public snapshot projection of one run's stream state. */
  snapshot(runId: string): RunStreamSnapshot | undefined {
    const entry = this.streams.get(runId)
    if (!entry) return undefined
    return {
      runId: entry.runId,
      workflowName: entry.workflowName,
      status: entry.status,
      currentState: entry.currentState,
      currentStep: entry.currentStep,
      agent: entry.agent,
      role: entry.role,
      text: entry.text,
      seq: entry.seq,
      completedSteps: entry.completedSteps,
      totalSteps: entry.totalSteps,
      states: entry.states,
      transitions: entry.transitions,
      verdicts: entry.verdicts,
      stateOutputs: entry.stateOutputs,
      stepLog: entry.stepLog,
    }
  }

  /** Mark a run's stream settled (terminal status) and schedule its prune. */
  settleStream(runId: string, status: string): void {
    const stream = this.streams.get(runId)
    if (!stream) return
    stream.status = status
    stream.currentStep = null
    stream.agent = null
    stream.role = null
    stream.seq += 1
    this.pruneStreamLater(runId)
  }

  /** Schedule a stream entry prune (settled runs and resumed rebuilds). */
  pruneStreamLater(runId: string): void {
    const stream = this.streams.get(runId)
    if (!stream) return
    stream.pruneTimer = setTimeout(() => {
      this.streams.delete(runId)
    }, STREAM_PRUNE_MS)
    stream.pruneTimer.unref?.()
  }

  /** Activity counts for the health probe. */
  counts(): { activeRuns: number; streamingRuns: number } {
    return { activeRuns: this.active.size, streamingRuns: this.streams.size }
  }
}
