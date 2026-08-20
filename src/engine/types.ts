/**
 * State-machine engine runtime types: persisted run state, step outcomes,
 * and the executor interface the runner drives.
 * @module dsh-ace-harness/engine
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { StepType, StepVerdict, Verdict, WorkflowConfig } from '../dsl/types.js'

/** Outcome of one executed step. */
export interface StepOutcome {
  /** Stable key `<stateName>/<stepName>`; unique within one run. */
  key: string
  state: string
  step: string
  /** Step kind as declared in the workflow (`agent` when omitted). */
  type: StepType
  agent?: string
  role?: 'attacker' | 'defender' | 'judge' | 'neutral'
  /** Final assistant text (bounded copy kept for context handoff). */
  outputSummary: string
  /** Verdict when the step declared one. */
  verdict?: StepVerdict
  /** Subworkflow terminal outcome when the step is a subworkflow. */
  subworkflowOutcome?: 'completed' | 'failed' | 'stopped' | 'crashed'
  /** Optional structured payload (script steps only); rides to downstream steps. */
  data?: unknown
  /** Total execution attempts (retry policy); 1 means no retry was needed. */
  attempts?: number
  startedAt: string
  finishedAt: string
}

/** Verdict of a completed state, derived from its last segment. */
export interface StateOutcome {
  state: string
  verdict: StepVerdict
  /** All step outcomes inside the state, in execution order. */
  steps: StepOutcome[]
  /** Optional supervisor checkpoint note for the state. */
  supervisorNote?: string
  /** Optional supervisor score for the state (1–10, scoringEnabled). */
  supervisorScore?: number
  finishedAt: string
}

/** Persisted engine progress; survives process restarts for resume. */
export interface RunState {
  id: string
  workflowName: string
  configFile: string
  status: 'preparing' | 'running' | 'waiting-human' | 'completed' | 'failed' | 'stopped' | 'crashed'
  currentState: string | null
  /** Self-transition counts per state, for the maxSelfTransitions fuse. */
  selfTransitions: Record<string, number>
  transitionCount: number
  totalSteps: number
  completedSteps: number
  stateOutcomes: StateOutcome[]
  /** Steps already completed inside the current (not yet finished) state. */
  pendingState: { name: string; completedSteps: StepOutcome[] } | null
  /** Durable human decision point; resume continues from here. */
  pendingHuman: {
    kind: 'approval' | 'no-match'
    state: string
    candidates: string[]
  } | null
  startedAt: string
  updatedAt: string
  finishedAt: string | null
  error: string | null
  /** Run-scoped inputs resolved from template parameters / taskInput. */
  inputs: Record<string, string>
  context: {
    projectRoot?: string
    requirements?: string
    workspaceMode?: string
  }
  /** DSH session id of the invoking agent (resume authority). */
  parentSessionId?: string
}

/** Terminal result of a whole run. */
export interface RunResult {
  runId: string
  status: RunState['status']
  verdict?: Verdict
  stateOutcomes: StateOutcome[]
  /** States that settled with a `fail` verdict (business failures), even when the run completed via a failure branch. */
  failedStates: string[]
  error: string | null
}

/** Current-state context handed to a step: goal, requirements, evidence. */
export interface StepContext {
  state: string
  stateDescription: string
  requirements: string
  projectRoot?: string
  /** Evidence from completed states (bounded per budget rules). */
  priorStateEvidence: string
  /** Evidence from previous steps of the current state. */
  priorStepEvidence: string
  /** Structured payloads from completed steps, keyed `<state>/<step>`. */
  stepData: Record<string, unknown>
}

/**
 * Dependencies the engine needs from the host. Implemented by the service
 * over `ctx.subagents`; tests substitute a fake executor.
 */
export interface StepExecutor {
  /**
   * Run one agent step as a DSH subagent.
   * @returns the step outcome; a thrown error fails the run.
   */
  runAgentStep(input: {
    stepName: string
    agentName: string
    agentSystemPrompt: string
    role: 'attacker' | 'defender' | 'judge' | 'neutral'
    task: string
    constraints: string[]
    /** Shell commands run before the step; output is injected as context. */
    preCommands: string[]
    ctx: StepContext
    /** Evidence the attacker/judge may read (defender output). */
    evidence?: string
    parent: Agent
    signal: AbortSignal
    /** Per-step timeout override in ms; undefined uses the plugin default. */
    timeoutMs?: number
  }): Promise<{ outputSummary: string; verdict?: StepVerdict }>

  /** Run one subworkflow step by starting the nested workflow config. */
  runSubworkflowStep(input: {
    stepName: string
    configFile: string
    parent: Agent
    signal: AbortSignal
    inheritedRequirements: string
  }): Promise<{ outcome: 'completed' | 'failed' | 'stopped' | 'crashed'; verdict?: StepVerdict }>

  /**
   * Run one bare LLM step: a direct single-turn chat completion on the parent
   * model route, without spawning a subagent or exposing tools. Used for fast
   * single-turn nodes (judgement, classification, drafting) where subagent
   * startup cost is not worth paying.
   */
  runLlmStep(input: {
    stepName: string
    role: 'attacker' | 'defender' | 'judge' | 'neutral'
    task: string
    /** Optional agent whose system prompt becomes the role prompt. */
    agentName?: string
    constraints: string[]
    model?: string
    ctx: StepContext
    parent: Agent
    signal: AbortSignal
    /** Per-step timeout override in ms; undefined uses the plugin default. */
    timeoutMs?: number
  }): Promise<{ outputSummary: string; verdict?: StepVerdict }>

  /** Supervisor checkpoint advice between states (optional, may be absent). */
  supervisorAdvice?(input: {
    supervisorName: string
    supervisorSystemPrompt: string
    workflowName: string
    ctx: StepContext
    stateOutcome: StepOutcome[]
    parent: Agent
    signal: AbortSignal
  }): Promise<{ advice: string; score: number | null } | null>
}

/** Options controlling one engine run. */
export interface EngineRunOptions {
  config: WorkflowConfig
  runId: string
  configFile: string
  inputs: Record<string, string>
  parent: Agent
  signal: AbortSignal
  executor: StepExecutor
  /** Persist the run state after every mutation. */
  persist: (state: RunState) => Promise<void>
  /** Load a persisted state (resume path). */
  load?: () => Promise<RunState | null>
  /** Resolve a subworkflow config by its configFile reference. */
  resolveSubworkflow: (configFile: string) => Promise<WorkflowConfig>
  /** Command used to launch Python for `scriptFile` steps ending in `.py`. */
  pythonCommand?: string
  /** Workspace scripts collection directory (`<workspace>/.ace-workflows/scripts`). */
  scriptsHome?: string
  /** Per-run sandbox directory handed to sandboxed script execution. */
  sandboxDir?: string
  /** Human decision when no transition matches. */
  askHumanTransition: (input: {
    state: string
    candidates: string[]
    signal: AbortSignal
  }) => Promise<string>
}

/** Raised when the engine refuses to continue (fuse tripped or config error). */
export class EngineError extends Error {
  constructor(
    message: string,
    readonly code: 'MAX_TRANSITIONS' | 'MAX_SELF_TRANSITIONS' | 'NO_INITIAL' | 'NO_MATCH' | 'UNKNOWN_AGENT' | 'UNKNOWN_STATE' | 'CANCELLED' = 'NO_MATCH',
  ) {
    super(message)
    this.name = 'EngineError'
  }
}
