/**
 * Run DTO projections: the single host-side source for the JSON shapes built
 * from `RunState` / `RunResult`. Every projector is whitelist-style (each
 * field named explicitly, optionals null-coalesced) so the wire contracts of
 * the state route, the run route, and the `workflow_manage` tool cannot
 * drift apart again. The client mirrors these shapes by hand in
 * `src/client/types.ts` — keep the two in sync.
 * @module dsh-ace-harness/projections
 */
import type { Issue } from './dsl/types.js'
import type { RunResult, RunState, StateOutcome, StepOutcome } from './engine/types.js'

/** Step row of the state route (the full step wire shape). */
export type StepOutcomeDto = {
  step: string
  type: StepOutcome['type']
  agent: string | null
  role: string | null
  verdict: string | null
  outputSummary: string
  data: unknown
  attempts: number
}

/** Whitelist projection of one step (state route shape). */
export function stepOutcomeDto(step: StepOutcome): StepOutcomeDto {
  return {
    step: step.step,
    type: step.type,
    agent: step.agent ?? null,
    role: step.role ?? null,
    verdict: step.verdict?.verdict ?? null,
    outputSummary: step.outputSummary,
    data: step.data ?? null,
    attempts: step.attempts ?? 1,
  }
}

/** State row of the state route. */
export type StateOutcomeDto = {
  state: string
  verdict: string
  supervisorScore: number | null
  supervisorNote: string | null
  steps: StepOutcomeDto[]
}

/** Whitelist projection of one state outcome (state route shape). */
export function stateOutcomeDto(outcome: StateOutcome): StateOutcomeDto {
  return {
    state: outcome.state,
    verdict: outcome.verdict.verdict,
    supervisorScore: outcome.supervisorScore ?? null,
    supervisorNote: outcome.supervisorNote ?? null,
    steps: outcome.steps.map(stepOutcomeDto),
  }
}

/** One run row of the state route (the route attaches `topology` itself). */
export type RunSummaryDto = {
  runId: string
  /** Owning session: the client gates the live popup on it. */
  parentSessionId: string | null
  workflowName: string
  status: RunState['status']
  currentState: string | null
  completedSteps: number
  totalSteps: number
  error: string | null
  startedAt: string
  finishedAt: string | null
  states: StateOutcomeDto[]
}

/** Whitelist projection of a persisted run for the state route. */
export function runSummaryDto(state: RunState): RunSummaryDto {
  return {
    runId: state.id,
    parentSessionId: state.parentSessionId ?? null,
    workflowName: state.workflowName,
    status: state.status,
    currentState: state.currentState,
    completedSteps: state.completedSteps,
    totalSteps: state.totalSteps,
    error: state.error,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    states: state.stateOutcomes.map(stateOutcomeDto),
  }
}

/** Step row of the run route's terminal result (no agent/role columns). */
export type RunResultStepDto = {
  step: string
  type: StepOutcome['type']
  verdict: string | null
  outputSummary: string
  data: unknown
  attempts: number
}

/** State row of the run route's terminal result. */
export type RunResultStateDto = {
  state: string
  verdict: string
  supervisorScore: number | null
  steps: RunResultStepDto[]
}

/** Terminal result of the run route. */
export type RunResultDto = {
  runId: string
  status: RunResult['status']
  verdict: string | null
  error: string | null
  failedStates: string[]
  states: RunResultStateDto[]
}

/** Whitelist projection of a settled run for the run route. */
export function runResultDto(result: RunResult): RunResultDto {
  return {
    runId: result.runId,
    status: result.status,
    verdict: result.verdict ?? null,
    error: result.error,
    failedStates: result.failedStates,
    states: result.stateOutcomes.map((outcome) => ({
      state: outcome.state,
      verdict: outcome.verdict.verdict,
      supervisorScore: outcome.supervisorScore ?? null,
      steps: outcome.steps.map((step) => {
        const dto = stepOutcomeDto(step)
        return {
          step: dto.step,
          type: dto.type,
          verdict: dto.verdict,
          outputSummary: dto.outputSummary,
          data: dto.data,
          attempts: dto.attempts,
        }
      }),
    })),
  }
}

/** Step row of the model-facing `runJson` projection (issues, no output). */
export type RunJsonStepDto = {
  step: string
  agent: string | null
  role: string | null
  verdict: string | null
  issues: Issue[]
}

/** State row of the model-facing `runJson` projection (with rationale). */
export type RunJsonStateDto = {
  state: string
  verdict: string
  rationale: string
  supervisorNote: string | null
  supervisorScore: number | null
  steps: RunJsonStepDto[]
}

/** The model-facing canonical run projection (`workflow_manage` show). */
export type RunJsonDto = {
  runId: string
  workflowName: string
  status: RunState['status']
  currentState: string | null
  completedSteps: number
  totalSteps: number
  transitionCount: number
  error: string | null
  states: RunJsonStateDto[]
}

/**
 * Canonical JSON run projection shared by all tools. Every field is lossless
 * JSON: optional values are null-coalesced because the tool output contract
 * rejects `undefined`.
 */
export function runJsonDto(state: RunState): RunJsonDto {
  return {
    runId: state.id,
    workflowName: state.workflowName,
    status: state.status,
    currentState: state.currentState,
    completedSteps: state.completedSteps,
    totalSteps: state.totalSteps,
    transitionCount: state.transitionCount,
    error: state.error,
    states: state.stateOutcomes.map((outcome) => ({
      state: outcome.state,
      verdict: outcome.verdict.verdict,
      rationale: outcome.verdict.rationale,
      supervisorNote: outcome.supervisorNote ?? null,
      supervisorScore: outcome.supervisorScore ?? null,
      steps: outcome.steps.map((step) => ({
        step: step.step,
        agent: step.agent ?? null,
        role: step.role ?? null,
        verdict: step.verdict?.verdict ?? null,
        issues: step.verdict?.issues ?? [],
      })),
    })),
  }
}
