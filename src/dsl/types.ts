/**
 * ACE-compatible state-machine workflow DSL types.
 *
 * Field names and semantics follow ACEHarness `src/lib/core/schemas.ts`
 * (Apache-2.0 with Runtime Library Exception) so existing `workflow.yaml`
 * files load unchanged; fields that only make sense inside the ACE product
 * (channels, spec coding, RAG, agent instances) are accepted-but-ignored or
 * trimmed as noted per field.
 */

/** Agent team color, as in the ACE agent catalog. */
export type AgentTeam = 'blue' | 'red' | 'judge' | 'black-gold'

/** An agent either executes steps or coordinates/supervises them. */
export type AgentRoleType = 'normal' | 'supervisor'

/** Role a step plays inside an adversarial review state. */
export type StepRole = 'attacker' | 'defender' | 'judge'

export type Verdict = 'success' | 'fail' | 'pass' | 'conditional_pass'

export type IssueType = 'design' | 'implementation' | 'test' | 'performance' | 'security'

export type IssueSeverity = 'critical' | 'major' | 'minor'

export type StepType = 'agent' | 'script' | 'subworkflow' | 'llm'

/** Built-in agent catalog entry (ported subset of the ACE role config). */
export interface AgentDefinition {
  name: string
  team: AgentTeam
  roleType: AgentRoleType
  category?: string
  tags?: string[]
  baseCapability?: string
  taskModes?: string[]
  temperature?: number
  /** ACE tool names; mapped to DSH tool filters when the catalog is resolved. */
  allowedTools?: string[]
  capabilities?: string[]
  systemPrompt: string
  constraints?: string[]
  description?: string
  keywords?: string[]
}

export interface WorkflowSupervisorConfig {
  enabled?: boolean
  agent?: string
  stageReviewEnabled?: boolean
  stageReviewAsync?: boolean
  checkpointAdviceEnabled?: boolean
  scoringEnabled?: boolean
  experienceEnabled?: boolean
  /**
   * `risks` (default): checkpoint advice only when a state fails, is marked,
   * or asks for human approval — success-forward states skip the extra call.
   * `all`: keep the legacy per-state checkpoint.
   */
  checkpointPolicy?: 'risks' | 'all'
}

export interface ReviewPolicy {
  mode: 'standard' | 'adversarial'
  source: 'ai' | 'user' | 'legacy' | 'default'
  locked?: boolean
  confidence: 'high' | 'medium' | 'low'
  riskSignals?: string[]
  rationale?: string
}

export interface JoinPolicy {
  mode: 'all' | 'any' | 'quorum' | 'manual'
  quorum?: number
  timeoutMinutes?: number
  onTimeout?: 'continue' | 'fail' | 'manual-review'
}

export interface StepConcurrency {
  groupId?: string
  branchId?: string
  joinPolicy?: JoinPolicy
}

export interface Issue {
  id?: string
  type: IssueType
  severity: IssueSeverity
  description: string
  foundInState?: string
  foundByAgent?: string
  targetState?: string
}

export interface TransitionCondition {
  verdict?: Verdict
  issueTypes?: IssueType[]
  severities?: IssueSeverity[]
  minIssueCount?: number
  maxIssueCount?: number
  /** Custom condition expression; evaluated by the transition matcher. */
  custom?: string
}

export interface StateTransition {
  to: string
  condition: TransitionCondition
  priority?: number
  label?: string
}

export interface SubworkflowInputs {
  requirements?: 'inherit' | string
  workspace?: 'inherit' | 'child-isolated-copy' | 'config'
  context?: 'inherit' | 'none' | 'custom'
  stateContexts?: 'inherit' | 'none' | 'relevant'
  skills?: 'inherit' | 'merge' | 'child-only' | 'parent-only'
}

export interface SubworkflowResultMapping {
  completed?: Verdict
  failed?: Verdict
  stopped?: Verdict
  crashed?: Verdict
}

export interface SubworkflowRuntime {
  timeoutMinutes?: number
  timeoutStrategy?: 'stop' | 'ask-human'
  maxDepth?: number
}

export interface SubworkflowReference {
  /** Workflow config file (workspace-relative path or workflow name). */
  configFile: string
  inputs?: SubworkflowInputs
  result?: SubworkflowResultMapping
  runtime?: SubworkflowRuntime
}

/** One step of a state: an agent task, a bare llm call, a script, or a nested subworkflow. */
export interface WorkflowStep {
  id?: string
  name: string
  /** Agent catalog name; optional for `script`, `llm` (role prompt), and `subworkflow`. */
  agent?: string
  /** Task description handed to the agent or the bare llm call. */
  task?: string
  /** Shell commands run before the agent step; output is injected as context. */
  preCommands?: string[]
  type?: StepType
  /** Subworkflow config file (shorthand for `subworkflow.configFile`). */
  workflow?: string
  subworkflow?: Partial<SubworkflowReference>
  /** JavaScript source for `type: script` steps (node:vm, returns JSON). */
  script?: string
  /** Optional model override for `type: llm` (and agent) steps. */
  model?: string
  inputs?: SubworkflowInputs
  result?: SubworkflowResultMapping
  runtime?: SubworkflowRuntime
  role?: StepRole
  constraints?: string[]
  /** Steps sharing a parallelGroup run concurrently in one segment. */
  parallelGroup?: string
  concurrency?: StepConcurrency
  skills?: string[]
}

export interface StateMachineState {
  id?: string
  name: string
  description?: string
  /** Require human approval after the state completes (except self-transitions). */
  requireHumanApproval?: boolean
  steps: WorkflowStep[]
  transitions: StateTransition[]
  /** Visual editor position; kept for the DSH editor port. */
  position?: { x: number; y: number }
  isInitial: boolean
  isFinal: boolean
  /** Self-transition fuse: exceeding it ends the run with an error. */
  maxSelfTransitions?: number
  /** Force a supervisor checkpoint even on success-forward transitions. */
  supervisorCheckpoint?: boolean
  reviewPolicy?: ReviewPolicy
  executionMode?: 'sequential' | 'parallel'
  joinPolicy?: JoinPolicy
}

export interface WorkflowTaskInputField {
  id: string
  label: string
  type?: 'text' | 'textarea' | 'url'
  required?: boolean
  placeholder?: string
  description?: string
}

export interface WorkflowContextConfig {
  projectRoot?: string
  /** in-place runs in the project dir; isolated-copy uses a working copy. */
  workspaceMode?: 'isolated-copy' | 'in-place'
  requirements?: string
  taskInput?: { fields?: WorkflowTaskInputField[] }
  timeoutMinutes?: number
  /** Whether the run snapshots a Git baseline and per-step diffs. */
  gitBaselineEnabled?: boolean
}

export interface WorkflowDefinition {
  name: string
  description?: string
  mode: 'state-machine'
  /** `lightweight` forces the single-state tasklist profile. */
  profile?: 'lightweight'
  states: StateMachineState[]
  maxTransitions?: number
  supervisor?: WorkflowSupervisorConfig
}

/** Top-level `workflow.yaml` document. */
export interface WorkflowConfig {
  workflow: WorkflowDefinition
  context?: WorkflowContextConfig
}

/** Workflow template manifest (`manifest.yaml`). */
export interface TemplateParameter {
  id: string
  label: string
  type: 'string' | 'text' | 'directory' | 'enum' | 'boolean' | 'number'
  /** JSON Pointer path (RFC 6901) inside workflow.yaml to bind the value to. */
  bind: string
  required?: boolean
  default?: unknown
  description?: string
  options?: { label: string; value: string }[]
}

export interface WorkflowTemplateManifest {
  apiVersion: string
  kind: 'WorkflowTemplate'
  metadata: {
    id: string
    version: string
    name: string
    description?: string
    category?: string
    tags?: string[]
    featured?: boolean
  }
  spec: {
    entrypoint: string
    mode: string
    compatibility?: { aceharness?: string }
    parameters?: TemplateParameter[]
    dependencies?: {
      agents?: string[]
      skills?: string[]
      subworkflows?: string[]
    }
  }
}

/** A run of one workflow: persisted state machine progress. */
export type RunStatus =
  | 'preparing'
  | 'running'
  | 'waiting-human'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'crashed'

export interface RunRecord {
  id: string
  workflowName: string
  configFile: string
  startTime: string
  endTime: string | null
  status: RunStatus
  currentState: string | null
  totalSteps: number
  completedSteps: number
}

/** Verdict extracted from one step's final output. */
export interface StepVerdict {
  verdict: Verdict
  /** Structured issues a judge or attacker reported. */
  issues: Issue[]
  /** Free-text rationale, kept verbatim for the next steps' context. */
  rationale: string
}

/** Terminal outcome of a subworkflow run, mapped through `result`. */
export type SubworkflowOutcome = 'completed' | 'failed' | 'stopped' | 'crashed'
