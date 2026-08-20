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
  workflowName: string
  status: string
  currentState: string | null
  completedSteps: number
  totalSteps: number
  error: string | null
  startedAt: string
  finishedAt: string | null
  states: {
    state: string
    verdict: string
    supervisorScore: number | null
    supervisorNote: string | null
    steps: { step: string; agent: string | null; role: string | null; verdict: string | null; outputSummary: string }[]
  }[]
}

export interface StateWorkflowDto {
  fileName: string
  name: string
  source: 'project' | 'personal'
  stateCount: number
  stepCount: number
}

export interface StateWorkspaceDto {
  path: string
  title: string
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
    state: string
    step: string
    agent: string | null
    role: string | null
    text: string
    finished: boolean
  }[]
}
