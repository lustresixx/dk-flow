/**
 * The state-machine runner: execute states step by step, extract verdicts,
 * evaluate transitions, honor fuses, and persist progress after every step.
 * Ports ACEHarness `executeStateMachine` / `executeState` /
 * `executeWorkflowStepDispatch` / `evaluateTransitions`.
 * @module dsh-ace-harness/engine
 */
import type { StateMachineState, WorkflowConfig } from '../dsl/types.js'
import { buildStateEvidence, buildStepEvidence } from './prompts.js'
import {
  buildStepData,
  executeStateSteps,
  joinStateVerdict,
  PASS_VERDICT,
} from './state-steps.js'
import {
  assertSelfTransitionBudget,
  assertTransitionBudget,
  evaluateTransitions,
  isSelfTransition,
} from './transitions.js'
import { EngineError, type EngineRunOptions, type RunResult, type RunState, type StateOutcome } from './types.js'

const now = (): string => new Date().toISOString()

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
    pid: process.pid,
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
  // The process that (re)starts this run is the live owner: refresh the pid so
  // a resume under a new process is not misread as abandoned by the old one.
  state.pid = process.pid

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
  // The supervisor-checkpoint context keeps its historical capture point
  // (state start, i.e. only steps resumed from pendingState contribute its
  // stepData) so the runner path stays bit-identical while the step sequence
  // itself moves into the shared module.
  const resumedSteps = [...(runState.pendingState?.completedSteps ?? [])]
  const context = {
    state: machineState.name,
    stateDescription: machineState.description ?? '',
    requirements: runState.context.requirements ?? '',
    projectRoot: runState.context.projectRoot,
    priorStateEvidence: buildStateEvidence(runState.stateOutcomes),
    priorStepEvidence: buildStepEvidence(resumedSteps),
    stepData: buildStepData(runState.stateOutcomes, resumedSteps),
  }

  // Step execution lives in state-steps.ts and is shared with the service's
  // isolated verification (P0-3): the sequence below only wires run-level
  // bookkeeping (pendingState / progress counters / failed steps / persist)
  // into the hook.
  const completedSteps = await executeStateSteps(
    options,
    machineState,
    {
      stateOutcomes: runState.stateOutcomes,
      context: runState.context,
      inputs: runState.inputs,
      completedSteps: resumedSteps,
    },
    {
      onStepFinished: async (completed) => {
        runState.pendingState = { name: machineState.name, completedSteps: [...completed] }
        runState.completedSteps =
          runState.stateOutcomes.reduce((sum, item) => sum + item.steps.length, 0) + completed.length
        await persist()
      },
      onStepFailed: async (failed) => {
        // Additive failure history (P0-B): there is no StepOutcome for a
        // failed step, so the failure statistics read this list. Failed steps
        // are NOT in pendingState.completedSteps — a resume re-executes them.
        runState.failedSteps = [...(runState.failedSteps ?? []), failed]
        await persist()
      },
    },
  )

  // The last segment decides the state verdict.
  const verdict = joinStateVerdict(machineState, completedSteps)

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
