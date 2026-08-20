/**
 * The state-machine runner: execute states step by step, extract verdicts,
 * evaluate transitions, honor fuses, and persist progress after every step.
 * Ports ACEHarness `executeStateMachine` / `executeState` /
 * `executeWorkflowStepDispatch` / `evaluateTransitions`.
 * @module dsh-ace-harness/engine
 */
import type { StateMachineState, StepVerdict, WorkflowConfig, WorkflowStep } from '../dsl/types.js'
import { buildStateEvidence, buildStepEvidence, CONCLUSION_BUDGET, truncate } from './prompts.js'
import { runScriptNode } from './script-runner.js'
import { runScriptFile } from './script-file-runner.js'
import {
  assertSelfTransitionBudget,
  assertTransitionBudget,
  evaluateTransitions,
  isSelfTransition,
  joinSegment,
  segmentSteps,
} from './transitions.js'
import { EngineError, type EngineRunOptions, type RunResult, type RunState, type StateOutcome, type StepOutcome } from './types.js'

const now = (): string => new Date().toISOString()

const PASS_VERDICT: StepVerdict = { verdict: 'pass', issues: [], rationale: '' }

/** Create a fresh run state for a new run. */
export function createRunState(options: {
  runId: string
  workflowName: string
  configFile: string
  config: WorkflowConfig
  inputs: Record<string, string>
  parentSessionId?: string
}): RunState {
  const totalSteps = options.config.workflow.states.reduce((sum, state) => sum + state.steps.length, 0)
  return {
    id: options.runId,
    workflowName: options.workflowName,
    configFile: options.configFile,
    status: 'preparing',
    currentState: null,
    selfTransitions: {},
    transitionCount: 0,
    totalSteps,
    completedSteps: 0,
    stateOutcomes: [],
    pendingState: null,
    pendingHuman: null,
    startedAt: now(),
    updatedAt: now(),
    finishedAt: null,
    error: null,
    inputs: options.inputs,
    context: {
      // Run-time answers to `requirements` / `projectRoot` taskInput fields
      // take effect when the workflow document left the placeholders empty.
      projectRoot: options.config.context?.projectRoot || options.inputs.projectRoot || undefined,
      requirements: options.config.context?.requirements || options.inputs.requirements || undefined,
      workspaceMode: options.config.context?.workspaceMode,
    },
    parentSessionId: options.parentSessionId,
  }
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
  workflow: WorkflowConfig['workflow'],
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

/**
 * Run one workflow to completion or to a durable human-decision pause point.
 * Resumes from a persisted state when `load()` returns a continuable one.
 */
export async function runStateMachine(options: EngineRunOptions): Promise<RunResult> {
  const { config } = options
  const states = config.workflow.states
  const initialState = states.find((state) => state.isInitial)
  if (!initialState) {
    throw new EngineError('workflow 缺少 isInitial 状态', 'NO_INITIAL')
  }
  const maxTransitions = config.workflow.maxTransitions ?? 50

  let state: RunState =
    (await options.load?.()) ?? createRunState({
      runId: options.runId,
      workflowName: config.workflow.name,
      configFile: options.configFile,
      config,
      inputs: options.inputs,
      parentSessionId: options.parent.session.id,
    })

  const terminal: RunState['status'][] = ['completed', 'failed', 'crashed', 'stopped']
  if (terminal.includes(state.status)) {
    throw new EngineError(`运行 ${state.id} 已处于终态 ${state.status}，无法继续`, 'NO_MATCH')
  }

  const persist = async (): Promise<void> => {
    state.updatedAt = now()
    await options.persist(state)
  }

  try {
    state.status = 'running'
    await persist()

    while (true) {
      if (options.signal.aborted) return await finish(state, 'stopped', '运行被取消', persist)

      let machineState: StateMachineState
      let outcome: StateOutcome

      const pending = state.pendingHuman
      if (pending?.kind === 'approval') {
        // Resume the gated state's decision, then fall through to transitions.
        const ok = await resolveApproval(options, state, persist)
        if (!ok) return buildResult(state)
        machineState = states.find((candidate) => candidate.name === pending.state) ?? initialState
        outcome = lastOutcomeFor(state, pending.state) ?? {
          state: pending.state,
          verdict: PASS_VERDICT,
          steps: [],
          finishedAt: now(),
        }
      } else {
        if (pending) {
          // Resume a no-match decision; it sets the next state and loops.
          const ok = await resolveNoMatch(options, state, maxTransitions, persist)
          if (!ok) return buildResult(state)
          continue
        }

        let stateName = state.pendingState?.name ?? state.currentState ?? initialState.name
        machineState = states.find((candidate) => candidate.name === stateName) ?? initialState
        stateName = machineState.name
        state.currentState = stateName

        outcome = await executeState(options, state, machineState, persist)
        state.stateOutcomes.push(outcome)
        state.pendingState = null
        state.completedSteps = state.stateOutcomes.reduce((sum, item) => sum + item.steps.length, 0)
        await persist()

        if (machineState.isFinal) return await finish(state, 'completed', null, persist)

        if (machineState.requireHumanApproval) {
          state.pendingHuman = { kind: 'approval', state: stateName, candidates: ['__continue__'] }
          state.status = 'waiting-human'
          await persist()
          const ok = await resolveApproval(options, state, persist)
          if (!ok) return buildResult(state)
        }
      }

      const transition = evaluateTransitions(machineState, outcome.verdict)
      if (!transition) {
        state.pendingHuman = {
          kind: 'no-match',
          state: machineState.name,
          candidates: states.filter((candidate) => !candidate.isFinal).map((candidate) => candidate.name),
        }
        state.status = 'waiting-human'
        await persist()
        const ok = await resolveNoMatch(options, state, maxTransitions, persist)
        if (!ok) return buildResult(state)
        continue
      }

      applyTransition(state, machineState, transition.to, maxTransitions)
      await persist()
    }
  } catch (error) {
    if (options.signal.aborted) {
      return await finish(state, 'stopped', '运行被取消', persist)
    }
    return await finish(state, 'failed', (error as Error).message, persist)
  }
}

/** The most recent completed outcome for a state name. */
function lastOutcomeFor(state: RunState, stateName: string): StateOutcome | undefined {
  for (let i = state.stateOutcomes.length - 1; i >= 0; i -= 1) {
    if (state.stateOutcomes[i]!.state === stateName) return state.stateOutcomes[i]
  }
  return undefined
}

/** Settle a run into a terminal status and return its result. */
async function finish(
  state: RunState,
  status: RunState['status'],
  error: string | null,
  persist: () => Promise<void>,
): Promise<RunResult> {
  state.status = status
  state.error = error
  state.finishedAt = now()
  try {
    await persist()
  } catch {
    // Persistence failure must not hide the run outcome.
  }
  return buildResult(state)
}

/** Project the terminal result from the persisted state. */
function buildResult(state: RunState): RunResult {
  return {
    runId: state.id,
    status: state.status,
    verdict: state.stateOutcomes[state.stateOutcomes.length - 1]?.verdict.verdict,
    stateOutcomes: state.stateOutcomes,
    failedStates: state.stateOutcomes
      .filter((outcome) => outcome.verdict.verdict === 'fail')
      .map((outcome) => outcome.state),
    error: state.error,
  }
}

/** Record a transition: self-transition fuse, run fuse, and new current state. */
function applyTransition(
  state: RunState,
  machineState: StateMachineState,
  to: string,
  maxTransitions: number,
): void {
  if (isSelfTransition({ to, condition: {}, priority: 0 }, machineState)) {
    const count = (state.selfTransitions[machineState.name] ?? 0) + 1
    assertSelfTransitionBudget(machineState, count - 1)
    state.selfTransitions[machineState.name] = count
  }
  state.transitionCount += 1
  assertTransitionBudget(state.transitionCount, maxTransitions)
  state.currentState = to
}

/**
 * Resolve the human approval gate. Returns false when the run settled into a
 * terminal status instead of continuing.
 */
async function resolveApproval(
  options: EngineRunOptions,
  state: RunState,
  persist: () => Promise<void>,
): Promise<boolean> {
  const pending = state.pendingHuman
  const chosen = await options.askHumanTransition({
    state: pending?.state ?? state.currentState ?? '',
    candidates: pending?.candidates ?? ['__continue__'],
    signal: options.signal,
  })
  state.pendingHuman = null
  if (options.signal.aborted || chosen !== '__continue__') {
    await finish(state, 'stopped', options.signal.aborted ? '运行被取消' : `人工选择停止：${chosen}`, persist)
    return false
  }
  state.status = 'running'
  await persist()
  return true
}

/**
 * Resolve a no-match transition decision: the chosen state name becomes the
 * next state. Returns false when the run settled terminally.
 */
async function resolveNoMatch(
  options: EngineRunOptions,
  state: RunState,
  maxTransitions: number,
  persist: () => Promise<void>,
): Promise<boolean> {
  const pending = state.pendingHuman
  const chosen = await options.askHumanTransition({
    state: pending?.state ?? state.currentState ?? '',
    candidates: pending?.candidates ?? [],
    signal: options.signal,
  })
  state.pendingHuman = null
  if (options.signal.aborted) {
    await finish(state, 'stopped', '运行被取消', persist)
    return false
  }
  if (!options.config.workflow.states.some((candidate) => candidate.name === chosen)) {
    await finish(state, 'failed', `人工选择了未知状态「${chosen}」`, persist)
    return false
  }
  state.status = 'running'
  state.transitionCount += 1
  try {
    assertTransitionBudget(state.transitionCount, maxTransitions)
  } catch (error) {
    await finish(state, 'failed', (error as Error).message, persist)
    return false
  }
  state.currentState = chosen
  await persist()
  return true
}

/**
 * Execute one state: run segments in order, resume past completed steps, and
 * derive the state verdict from the last segment.
 */
async function executeState(
  options: EngineRunOptions,
  runState: RunState,
  machineState: StateMachineState,
  persist: () => Promise<void>,
): Promise<StateOutcome> {
  const { executor } = options
  const steps = machineState.steps
  const completedSteps: StepOutcome[] = [...(runState.pendingState?.completedSteps ?? [])]
  const completedKeys = new Set(completedSteps.map((step) => step.key))

  const context = {
    state: machineState.name,
    stateDescription: machineState.description ?? '',
    requirements: runState.context.requirements ?? '',
    projectRoot: runState.context.projectRoot,
    priorStateEvidence: buildStateEvidence(runState.stateOutcomes),
    priorStepEvidence: buildStepEvidence(completedSteps),
    stepData: buildStepData(runState.stateOutcomes, completedSteps),
  }

  const segments = segmentSteps(steps)
  for (const segment of segments) {
    const segmentStepNames = new Set(segment.steps)
    const segmentWorkflowSteps = steps.filter((step) => segmentStepNames.has(step.name))
    const runOne = async (step: WorkflowStep): Promise<StepOutcome> => {
      const key = stepKey(machineState.name, step.name)
      if (completedKeys.has(key)) {
        return completedSteps.find((item) => item.key === key)!
      }
      const role = step.type === 'script' ? 'neutral' : (step.role ?? inferRole(step, machineState))
      let outcome: StepOutcome
      if (step.type === 'script') {
        const scriptInput = {
          requirements: runState.context.requirements || runState.inputs.requirements || '',
          state: machineState.name,
          priorStepEvidence: buildStepEvidence(completedSteps),
          priorStateEvidence: buildStateEvidence(runState.stateOutcomes),
          inputs: runState.inputs,
          stepData: buildStepData(runState.stateOutcomes, completedSteps),
        }
        const timeoutMs = stepTimeoutMs(step)
        const scriptResult =
          step.scriptFile?.trim() !== undefined && step.scriptFile.trim() !== ''
            ? await runScriptFile(step.scriptFile.trim(), scriptInput, {
                projectRoot: runState.context.projectRoot,
                scriptsHome: options.scriptsHome,
                pythonCommand: options.pythonCommand ?? 'python',
                timeoutMs,
                signal: options.signal,
              })
            : runScriptNode(step.script ?? '', scriptInput, { timeoutMs })
        outcome = {
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
      } else if (step.type === 'llm') {
        const stepContext = {
          ...context,
          priorStepEvidence: buildStepEvidence(completedSteps),
          stepData: buildStepData(runState.stateOutcomes, completedSteps),
        }
        const { value: result, attempts } = await retryOnError(
          () =>
            executor.runLlmStep({
              stepName: step.name,
              role,
              task: step.task ?? '',
              agentName: step.agent,
              constraints: step.constraints ?? [],
              model: step.model,
              ctx: stepContext,
              parent: options.parent,
              signal: options.signal,
              timeoutMs: stepTimeoutMs(step),
            }),
          resolveStepRetry(step, options.config.workflow),
          options.signal,
        )
        outcome = {
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
      } else if (step.type === 'subworkflow') {
        const configFile = step.workflow?.trim() || step.subworkflow?.configFile?.trim()
        if (!configFile) throw new EngineError(`子工作流步骤「${step.name}」缺少配置`, 'NO_MATCH')
        const { value: child, attempts } = await retryOnError(
          () =>
            executor.runSubworkflowStep({
              stepName: step.name,
              configFile,
              parent: options.parent,
              signal: options.signal,
              inheritedRequirements: runState.context.requirements ?? '',
            }),
          resolveStepRetry(step, options.config.workflow),
          options.signal,
        )
        outcome = {
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
      } else {
        const agentName = step.agent ?? ''
        const stepContext = {
          ...context,
          priorStepEvidence: buildStepEvidence(completedSteps),
          stepData: buildStepData(runState.stateOutcomes, completedSteps),
        }
        const evidence =
          role === 'attacker' || role === 'judge'
            ? evidenceFor(completedSteps, machineState.name)
            : undefined
        const { value: result, attempts } = await retryOnError(
          () =>
            executor.runAgentStep({
              stepName: step.name,
              agentName,
              agentSystemPrompt: '',
              role,
              task: step.task ?? '',
              constraints: step.constraints ?? [],
              preCommands: step.preCommands ?? [],
              ctx: stepContext,
              evidence,
              parent: options.parent,
              signal: options.signal,
              timeoutMs: stepTimeoutMs(step),
            }),
          resolveStepRetry(step, options.config.workflow),
          options.signal,
        )
        outcome = {
          key,
          state: machineState.name,
          step: step.name,
          type: step.type ?? 'agent',
          agent: agentName,
          role,
          outputSummary: result.outputSummary,
          verdict: result.verdict,
          attempts,
          startedAt: now(),
          finishedAt: now(),
        }
      }
      completedSteps.push(outcome)
      runState.pendingState = { name: machineState.name, completedSteps: [...completedSteps] }
      runState.completedSteps =
        runState.stateOutcomes.reduce((sum, item) => sum + item.steps.length, 0) + completedSteps.length
      await persist()
      return outcome
    }
    if (segmentWorkflowSteps.length > 1) {
      await Promise.all(segmentWorkflowSteps.map((step) => runOne(step)))
    } else {
      await runOne(segmentWorkflowSteps[0]!)
    }
  }

  // The last segment decides the state verdict.
  const lastSegment = segments[segments.length - 1]!
  const lastOutcomes = completedSteps.filter((step) => lastSegment.steps.includes(step.step))
  const joined = joinSegment(
    lastOutcomes.map((step) => step.verdict ?? PASS_VERDICT),
    machineState.joinPolicy ?? { mode: 'all' },
  )
  const verdict = joined ?? PASS_VERDICT

  const stateOutcome: StateOutcome = {
    state: machineState.name,
    verdict,
    steps: completedSteps,
    finishedAt: now(),
  }

  // Supervisor checkpoint after the state settles. The `risks` policy (the
  // default) skips the extra model call on success-forward transitions and
  // keeps oversight exactly where risk concentrates: failed states, states
  // marked `supervisorCheckpoint`, and human-approval gates.
  const supervisor = options.config.workflow.supervisor
  const needsCheckpoint =
    supervisor?.checkpointPolicy === 'all' ||
    machineState.supervisorCheckpoint === true ||
    machineState.requireHumanApproval === true ||
    stateOutcome.verdict.verdict === 'fail' ||
    stateOutcome.verdict.verdict === 'conditional_pass'
  if (
    supervisor &&
    supervisor.enabled &&
    !machineState.isFinal &&
    needsCheckpoint &&
    options.executor.supervisorAdvice
  ) {
    const result = await options.executor.supervisorAdvice({
      supervisorName: supervisor.agent ?? 'default-supervisor',
      supervisorSystemPrompt: '',
      workflowName: options.config.workflow.name,
      ctx: { ...context, priorStepEvidence: buildStepEvidence(completedSteps) },
      stateOutcome: completedSteps,
      parent: options.parent,
      signal: options.signal,
    })
    if (result) {
      stateOutcome.supervisorNote = result.advice === '' ? undefined : result.advice
      if (supervisor.scoringEnabled !== false) {
        stateOutcome.supervisorScore = result.score ?? undefined
      }
    }
  }

  return stateOutcome
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
function buildStepData(
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
