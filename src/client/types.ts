/** Wire DTOs served by the host `/plugins/dsh-ace-harness/state` route. */

export interface StateAgentDto {
  name: string
  team: string
  roleType: string
  description: string
  capabilities: string[]
}

export interface StateParameterDto {
  id: string
  label: string
  type: string
  bind: string
  required: boolean
  default?: unknown
  description?: string
  options?: { label: string; value: string }[]
}

export interface StateTemplateDto {
  id: string
  version: string
  name: string
  description: string
  category: string
  tags: string[]
  featured: boolean
  stateCount: number
  parameters: StateParameterDto[]
  agents: string[]
  states: {
    name: string
    isInitial: boolean
    isFinal: boolean
    position: { x: number; y: number } | null
    steps: { name: string; agent: string | null; role: string | null; type: string }[]
  }[]
}

export interface StateRunDto {
  runId: string
  /**
   * Session that started the run (null for API/synthetic parents). The live
   * run popup only appears while this session is the one currently open.
   */
  parentSessionId: string | null
  workflowName: string
  status: string
  currentState: string | null
  completedSteps: number
  totalSteps: number
  error: string | null
  startedAt: string
  finishedAt: string | null
  /** Workflow topology for the run diagram; null when the config is unreadable. */
  topology: {
    states: { name: string; isInitial: boolean; isFinal: boolean; position: { x: number; y: number } | null }[]
    transitions: { from: string; to: string; verdict: string | null; label: string | null }[]
  } | null
  states: {
    state: string
    verdict: string
    supervisorScore: number | null
    supervisorNote: string | null
    steps: {
      step: string
      type: 'agent' | 'script' | 'subworkflow' | 'llm'
      agent: string | null
      role: string | null
      verdict: string | null
      outputSummary: string
      data: unknown | null
      attempts: number
    }[]
  }[]
}

export interface StateWorkflowDto {
  fileName: string
  name: string
  source: 'project' | 'personal'
  stateCount: number
  stepCount: number
  /** Run-time input fields the workflow asks for when it starts. */
  taskFields: {
    id: string
    label: string
    type: string
    required: boolean
    placeholder: string
    description: string
  }[]
}

export interface StateWorkspaceDto {
  path: string
  title: string
  /** SQLite run-archive status (opt-in per workspace). */
  sqliteArchive: { enabled: boolean; archived: number; dbFile: string | null }
  runs: StateRunDto[]
  workflows: StateWorkflowDto[]
}

export interface AceStateDto {
  agents: StateAgentDto[]
  templates: StateTemplateDto[]
  workspaces: StateWorkspaceDto[]
}

/** Live streaming projection of one run (GET /plugins/dsh-ace-harness/stream). */
export interface StreamSnapshotDto {
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
