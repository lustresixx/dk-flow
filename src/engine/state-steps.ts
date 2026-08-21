/**
 * Single-state step execution: the one implementation of "run a state's
 * steps in declared segments, hand evidence forward, join the verdict".
 * Both the runner's `executeState` (real runs) and the service's isolated
 * verification (testState/testStep) drive this module, so an editor
 * prediction executes exactly the code a real run executes (P0-3).
 * @module dsh-ace-harness/engine
 */
import type { StateMachineState, StepVerdict, WorkflowStep } from '../dsl/types.js'
import { buildStateEvidence, buildStepEvidence, CONCLUSION_BUDGET, truncate } from './prompts.js'
import { runScriptNode } from './script-runner.js'
import { runScriptFile } from './script-file-runner.js'
import { joinSegment, segmentSteps } from './transitions.js'
import { EngineError, type EngineRunOptions, type StateOutcome, type StepOutcome } from './types.js'

const now = (): string => new Date().toISOString()

/** Fallback verdict when a step or state produced none. */
export const PASS_VERDICT: StepVerdict = { verdict: 'pass', issues: [], rationale: '' }

/** The engine slice one step execution reads (`EngineRunOptions` satisfies it). */
export type StateStepOptions = Pick<
  EngineRunOptions,
  'config' | 'parent' | 'signal' | 'executor' | 'scriptsHome' | 'pythonCommand' | 'sandboxDir'
>

/** Run-level inputs one state's step sequence reads beyond the state itself. */
export interface StateStepsRunInput {
  /** Completed prior states (evidence + structured-data source). */
  stateOutcomes: readonly StateOutcome[]
  /** Run-level context values (requirements / projectRoot). */
  context: { requirements?: string; projectRoot?: string }
  /** Run-scoped inputs (script surface + template values). */
  inputs: Record<string, string>
}

/** Observation / scheduling hooks of one state's step sequence. */
export interface StateStepsHooks {
  /** Fires after each newly finished step (persist / progress projection). */
  onStepFinished?: (completedSteps: readonly StepOutcome[]) => Promise<void>
  /** Run parallel groups in declaration order (isolated verification). */
  sequential?: boolean
}

function stepKey(state: string, step: string): string {
  return `${state}/${step}`
}

/** Per-step timeout override in ms, from `timeoutMinutes` when declared. */
function stepTimeoutMs(step: WorkflowStep): number | undefined {
  return step.timeoutMinutes !== undefined ? step.timeoutMinutes * 60_000 : undefined
}

/** Resolve the effective retry policy for one step. */
function resolveStepRetry(
  step: WorkflowStep,
  workflow: EngineRunOptions['config']['workflow'],
): { maxRetries: number; backoffMs: number } {
  const policy = step.retry ?? workflow.stepRetry
  return { maxRetries: policy?.maxRetries ?? 0, backoffMs: policy?.backoffMs ?? 2000 }
}

/** Abort-aware sleep used between retry attempts. */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal.aborted) {
      rejectPromise(new Error('运行被取消'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      rejectPromise(new Error('运行被取消'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Retry a transient-failure function with exponential backoff. A settled
 * value (including a `fail` verdict) is never retried — only thrown errors.
 */
async function retryOnError<T>(
  run: () => Promise<T>,
  policy: { maxRetries: number; backoffMs: number },
  signal: AbortSignal,
): Promise<{ value: T; attempts: number }> {
  let attempts = 0
  for (;;) {
    attempts += 1
    try {
      return { value: await run(), attempts }
    } catch (error) {
      if (signal.aborted || attempts > policy.maxRetries) throw error
      await sleepAbortable(policy.backoffMs * 2 ** (attempts - 1), signal)
    }
  }
}

/** Infer a step role from the step, the adversarial policy, or step order. */
function inferRole(
  step: WorkflowStep,
  state: StateMachineState,
): 'attacker' | 'defender' | 'judge' | 'neutral' {
  if (step.role) return step.role
  if (state.reviewPolicy?.mode !== 'adversarial') return 'neutral'
  const index = state.steps.indexOf(step)
  if (index === state.steps.length - 1) return 'judge'
  return index % 2 === 0 ? 'defender' : 'attacker'
}

/** Evidence an attacker or judge reads: all completed steps of this state. */
function evidenceFor(steps: readonly StepOutcome[], state: string): string {
  const own = steps.filter((step) => step.state === state)
  if (own.length === 0) return '（本状态暂无前置步骤产出）'
  return own.map((step) => buildStepEvidence([step])).join('\n\n---\n\n')
}

/**
 * Structured payloads from all completed steps, keyed `<state>/<step>`.
 * Later steps of the same key overwrite earlier ones (re-entered states).
 */
export function buildStepData(
  stateOutcomes: readonly StateOutcome[],
  completedSteps: readonly StepOutcome[],
): Record<string, unknown> {
  const collected: Record<string, unknown> = {}
  for (const outcome of stateOutcomes) {
    for (const step of outcome.steps) {
      if (step.data !== undefined) collected[`${step.state}/${step.step}`] = step.data
    }
  }
  for (const step of completedSteps) {
    if (step.data !== undefined) collected[`${step.state}/${step.step}`] = step.data
  }
  return collected
}

/**
 * Execute one step of a state and return its outcome (the outcome is NOT
 * pushed into `completedSteps` — the caller owns the list). Evidence handed
 * to the step is derived from `completedSteps` as passed in.
 */
export async function executeStateStep(input: {
  options: StateStepOptions
  machineState: StateMachineState
  step: WorkflowStep
  run: StateStepsRunInput
  /** Steps already completed inside this state (evidence source). */
  completedSteps: readonly StepOutcome[]
}): Promise<StepOutcome> {
  const { options, machineState, step, run, completedSteps } = input
  const key = stepKey(machineState.name, step.name)
  const role = step.type === 'script' ? 'neutral' : (step.role ?? inferRole(step, machineState))
  if (step.type === 'script') {
    const scriptInput = {
      requirements: run.context.requirements || run.inputs.requirements || '',
      state: machineState.name,
      priorStepEvidence: buildStepEvidence(completedSteps),
      priorStateEvidence: buildStateEvidence(run.stateOutcomes),
      inputs: run.inputs,
      stepData: buildStepData(run.stateOutcomes, completedSteps),
    }
    const timeoutMs = stepTimeoutMs(step)
    const scriptResult =
      step.scriptFile?.trim() !== undefined && step.scriptFile.trim() !== ''
        ? await runScriptFile(step.scriptFile.trim(), scriptInput, {
            projectRoot: run.context.projectRoot,
            scriptsHome: options.scriptsHome,
            pythonCommand: options.pythonCommand ?? 'python',
            timeoutMs,
            sandboxDir: options.sandboxDir,
            signal: options.signal,
          })
        : await runScriptNode(step.script ?? '', scriptInput, { timeoutMs, signal: options.signal })
    return {
      key,
      state: machineState.name,
      step: step.name,
      type: 'script',
      role: 'neutral',
      outputSummary: scriptResult.output,
      verdict: {
        verdict: scriptResult.success ? 'success' : 'fail',
        issues: [],
        // Script outputs carry no separate conclusion: the output text IS
        // the evidence, so it flows into state-level evidence verbatim.
        rationale: scriptResult.error ?? truncate(scriptResult.output, CONCLUSION_BUDGET),
      },
      ...(scriptResult.data !== undefined ? { data: scriptResult.data } : {}),
      startedAt: now(),
      finishedAt: now(),
    }
  }
  const context = {
    state: machineState.name,
    stateDescription: machineState.description ?? '',
    requirements: run.context.requirements ?? '',
    projectRoot: run.context.projectRoot,
    priorStateEvidence: buildStateEvidence(run.stateOutcomes),
    priorStepEvidence: buildStepEvidence(completedSteps),
    stepData: buildStepData(run.stateOutcomes, completedSteps),
  }
  if (step.type === 'llm') {
    const { value: result, attempts } = await retryOnError(
      () =>
        options.executor.runLlmStep({
          stepName: step.name,
          role,
          task: step.task ?? '',
          agentName: step.agent,
          constraints: step.constraints ?? [],
          model: step.model,
          ctx: context,
          parent: options.parent,
          signal: options.signal,
          timeoutMs: stepTimeoutMs(step),
        }),
      resolveStepRetry(step, options.config.workflow),
      options.signal,
    )
    return {
      key,
      state: machineState.name,
      step: step.name,
      type: 'llm',
      agent: step.agent,
      role,
      outputSummary: result.outputSummary,
      verdict: result.verdict,
      attempts,
      startedAt: now(),
      finishedAt: now(),
    }
  }
  if (step.type === 'subworkflow') {
    const configFile = step.workflow?.trim() || step.subworkflow?.configFile?.trim()
    if (!configFile) throw new EngineError(`子工作流步骤「${step.name}」缺少配置`, 'NO_MATCH')
    const { value: child, attempts } = await retryOnError(
      () =>
        options.executor.runSubworkflowStep({
          stepName: step.name,
          configFile,
          parent: options.parent,
          signal: options.signal,
          inheritedRequirements: run.context.requirements ?? '',
        }),
      resolveStepRetry(step, options.config.workflow),
      options.signal,
    )
    return {
      key,
      state: machineState.name,
      step: step.name,
      type: 'subworkflow',
      agent: step.agent,
      role,
      outputSummary: child.verdict?.rationale ?? `子工作流结束：${child.outcome}`,
      verdict: child.verdict,
      subworkflowOutcome: child.outcome,
      attempts,
      startedAt: now(),
      finishedAt: now(),
    }
  }
  const evidence =
    role === 'attacker' || role === 'judge'
      ? evidenceFor(completedSteps, machineState.name)
      : undefined
  const { value: result, attempts } = await retryOnError(
    () =>
      options.executor.runAgentStep({
        stepName: step.name,
        agentName: step.agent ?? '',
        agentSystemPrompt: '',
        role,
        task: step.task ?? '',
        constraints: step.constraints ?? [],
        preCommands: step.preCommands ?? [],
        ctx: context,
        evidence,
        skills: step.skills ?? [],
        parent: options.parent,
        signal: options.signal,
        timeoutMs: stepTimeoutMs(step),
      }),
    resolveStepRetry(step, options.config.workflow),
    options.signal,
  )
  return {
    key,
    state: machineState.name,
    step: step.name,
    type: step.type ?? 'agent',
    agent: step.agent ?? '',
    role,
    outputSummary: result.outputSummary,
    verdict: result.verdict,
    attempts,
    startedAt: now(),
    finishedAt: now(),
  }
}

/**
 * Execute a state's steps segment by segment, resuming past completed steps.
 * Returns the completed-step list (pre-filled from `run.completedSteps` when
 * resuming). Parallel groups run concurrently unless `hooks.sequential`.
 */
export async function executeStateSteps(
  options: StateStepOptions,
  machineState: StateMachineState,
  run: StateStepsRunInput & { completedSteps?: StepOutcome[] },
  hooks: StateStepsHooks = {},
): Promise<StepOutcome[]> {
  const steps = machineState.steps
  const completedSteps = run.completedSteps ?? []
  const completedKeys = new Set(completedSteps.map((step) => step.key))
  const segments = segmentSteps(steps)
  for (const segment of segments) {
    const segmentStepNames = new Set(segment.steps)
    const segmentWorkflowSteps = steps.filter((step) => segmentStepNames.has(step.name))
    // Evidence semantics are deterministic (P1-2③): every step of a segment
    // — parallel group or not — sees the completed steps as of SEGMENT
    // START. (De-facto true before, since evidence was read synchronously
    // at each step's invocation; pinning it explicitly makes the rule
    // immune to refactors that interleave an await before the read.)
    const evidenceSnapshot = [...completedSteps]
    const runOne = async (step: WorkflowStep): Promise<StepOutcome> => {
      const key = stepKey(machineState.name, step.name)
      if (completedKeys.has(key)) {
        return completedSteps.find((item) => item.key === key)!
      }
      const outcome = await executeStateStep({ options, machineState, step, run, completedSteps: evidenceSnapshot })
      completedSteps.push(outcome)
      await hooks.onStepFinished?.(completedSteps)
      return outcome
    }
    if (!hooks.sequential && segmentWorkflowSteps.length > 1) {
      await Promise.all(segmentWorkflowSteps.map((step) => runOne(step)))
    } else {
      for (const step of segmentWorkflowSteps) {
        await runOne(step)
      }
    }
  }
  return completedSteps
}

/** Derive a state's verdict from its completed steps: the last segment, joined. */
export function joinStateVerdict(
  machineState: StateMachineState,
  completedSteps: readonly StepOutcome[],
): StepVerdict {
  const segments = segmentSteps(machineState.steps)
  const lastSegment = segments[segments.length - 1]!
  const lastOutcomes = completedSteps.filter((step) => lastSegment.steps.includes(step.step))
  const joined = joinSegment(
    lastOutcomes.map((step) => step.verdict ?? PASS_VERDICT),
    machineState.joinPolicy ?? { mode: 'all' },
  )
  return joined ?? PASS_VERDICT
}
