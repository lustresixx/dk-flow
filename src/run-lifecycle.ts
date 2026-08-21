/**
 * Run lifecycle: startRun / resumeRun / stopRun and the detach orchestration
 * (foreground runs detach into background jobs when the calling turn aborts),
 * plus the `EngineRunOptions` assembly every run goes through. Extracted from
 * AceHarnessService (P0-2); the service keeps the public method surface and
 * delegates here.
 * @module dsh-ace-harness/run-lifecycle
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId, JobStart } from '@deepseek-ai/dsh-jobs'
import '@deepseek-ai/dsh-user-questions'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'ace-workflow': 'ace-workflow'
  }
}
import type { WorkflowConfig } from './dsl/types.js'
import { createRunState, runStateMachine } from './engine/runner.js'
import {
  EngineError,
  type EngineRunOptions,
  type RunResult,
  type RunState,
  type StateOutcome,
  type StepExecutor,
} from './engine/types.js'
import { auditEvent, runDurationMs, sha256Text } from './store/audit-events.js'
import { captureGitSnapshot, saveGitSnapshot } from './store/git-baseline.js'
import { loadRunState, saveRunState } from './store/run-store.js'
import type { AceHarnessConfig } from './service.js'
import { jobOutcomeFor, type JobOutcomeLike } from './step-executor-factory.js'
import { projectRunStateToStream, type RunPersistence } from './run-persistence.js'
import type { RunRegistry } from './run-registry.js'

/**
 * Approval-gate option labels doubling as protocol tokens. The
 * dsh-user-questions rc.7 answer shape carries no stable value channel, so
 * the selected LABEL is the token — these strings are the contract between
 * the option list and the response mapping. Change both sides together.
 */
const APPROVAL_CONTINUE_LABEL = '批准，继续运行'
const APPROVAL_STOP_LABEL = '停止运行'

/** A started run: its id, optional DSH job id, and its terminal result. */
export interface AceRunHandle {
  runId: string
  jobId?: JobId
  /**
   * Set when a foreground run was detached into a background job because the
   * calling turn aborted. The run keeps executing; `result` settles with its
   * terminal outcome.
   */
  detachedJobId?: JobId
  result: Promise<RunResult>
}

/**
 * Terminal settle inputs shared by the success and rejection paths: what the
 * `end` audit row records. On the success path the engine result is used
 * verbatim; on a rejection (startup validation errors that never executed a
 * step) the run settles as `failed` with the error message and no outcomes.
 */
export interface RunSettleResult {
  status: RunState['status']
  error: string | null
  stateOutcomes: StateOutcome[]
}

/** Host seams the terminal settlement draws on (P0-A / P1-A). */
export interface SettleRunEndDeps {
  registry: RunRegistry
  persistence: RunPersistence
  /** Emit the frozen `ace/workflow-end` cordis event. */
  emitRunEnd: (payload: { runId: string; status: string }) => void
}

/**
 * Settle one run terminally on BOTH paths (P0-A): emit the end event, mark
 * the live stream settled (which schedules its prune), release the audit diff
 * cursor, and append the `end` audit row carrying status / error / evidence
 * hash / run duration. Extracted as a seam (P1-A) so the rejection path —
 * engine startup validation errors that reject before any step runs — gets
 * the same terminal row the success path does, and so the behavior is
 * unit-testable without a live host. The audit row shape is frozen by the
 * archive replay and the e2e contract; this function is the one writer.
 */
export async function settleRunEnd(
  deps: SettleRunEndDeps,
  workspace: string,
  runId: string,
  result: RunSettleResult,
): Promise<void> {
  deps.emitRunEnd({ runId, status: result.status })
  deps.registry.settleStream(runId, result.status)
  deps.registry.finishRun(runId)
  await deps.persistence.writeAudit(
    workspace,
    runId,
    auditEvent('end', {
      status: result.status,
      error: result.error,
      // Tamper-evident evidence-chain digest + run wall clock.
      evidenceHash: sha256Text(JSON.stringify(result.stateOutcomes)),
      durationMs: runDurationMs(result.stateOutcomes),
    }),
  )
}

/**
 * Wrap one engine run promise with terminal settlement on both paths. The
 * success path settles with the engine result; a rejection (engine startup
 * validation — NO_INITIAL / NO_MATCH on a terminal state / a failing load —
 * or any error escaping the engine's own catch) settles as `failed` with the
 * error message and rethrows, so callers keep seeing the rejection exactly as
 * before. `registry.release` always runs via `finally`. The settle runs at
 * most once: a settle failure (e.g. an audit write error) cannot double-write
 * the `end` row or mask the original outcome.
 */
export function settleEngineRun(
  deps: SettleRunEndDeps,
  workspace: string,
  runId: string,
  run: Promise<RunResult>,
): Promise<RunResult> {
  let settled = false
  const settleOnce = async (result: RunSettleResult): Promise<void> => {
    if (settled) return
    settled = true
    await settleRunEnd(deps, workspace, runId, result)
  }
  return run
    .then(async (runResult) => {
      await settleOnce(runResult)
      return runResult
    })
    .catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error)
      await settleOnce({ status: 'failed', error: message, stateOutcomes: [] })
      throw error
    })
    .finally(() => {
      deps.registry.release(runId)
    })
}

/** How a run executes: awaited by the caller or detached as a DSH job. */
export type RunMode = 'foreground' | 'job'

/** Structural face of the jobs registry (resolved lazily through the store). */
export interface JobRegistryFace {
  start(spec: JobStart): JobId
}

/** Inputs of the `EngineRunOptions` assembly shared by runs and subworkflows. */
export interface EngineOptionsInput {
  workspace: string
  parent: Agent
  workflow: { config: WorkflowConfig; configFile: string }
  runId: string
  executor: StepExecutor
  signal: AbortSignal
  load: () => Promise<RunState | null>
  inputs: Record<string, string>
}

/** Host services the run lifecycle draws on. */
export interface RunLifecycleDeps {
  ctx: Context
  /** Resolved plugin config. */
  config: Required<AceHarnessConfig>
  /** Shared run maps. */
  registry: RunRegistry
  /** The per-run persist pipeline. */
  persistence: RunPersistence
  /** Jobs registry lookup (lazy: the service may mount after activation). */
  jobs(): JobRegistryFace | undefined
  /** The workspace root used for one agent. */
  workspaceOf(parent: Agent): string
  /** Resolve a workflow reference (subworkflow + resume paths). */
  resolveWorkflowConfig(workspace: string, configFile: string): Promise<{ config: WorkflowConfig; file: string } | null>
  /** Build the step executor for one run, bound to workspace and lineage. */
  makeExecutor(workspace: string, parent: Agent, parentRunId: string, depth: number): StepExecutor
  /** Create the per-run sandbox directory (best effort; never fails the run). */
  ensureSandboxDir(workspace: string, runId: string): void
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10)
}

/** Start / resume / stop orchestration for workflow runs. */
export class RunLifecycle {
  private readonly deps: RunLifecycleDeps

  constructor(deps: RunLifecycleDeps) {
    this.deps = deps
  }

  /**
   * Start one workflow run in the invoking agent's workspace. The run executes
   * on the DSH subagent seam and persists progress after every step.
   * @param mode - `foreground` returns the settled result to the caller;
   *   `job` detaches the run as a DSH background job owned by the parent agent.
   */
  async startRun(input: {
    parent: Agent
    signal: AbortSignal
    workflow: { config: WorkflowConfig; configFile: string }
    inputs?: Record<string, string>
    mode?: RunMode
  }): Promise<AceRunHandle> {
    const { config, registry, persistence } = this.deps
    if (registry.isFull(config.maxConcurrentRuns)) {
      throw new Error(`并发运行数达到上限 ${config.maxConcurrentRuns}`)
    }
    const workspace = this.deps.workspaceOf(input.parent)
    const runId = `run-${Date.now()}-${randomSuffix()}`
    // One controller per run (P1-2②): the registry stop button and the job
    // cancel hook abort it, and the engine consumes its signal directly.
    // The calling turn's signal is NOT linked in — a turn abort detaches a
    // foreground run into a background job instead (detachOnTurnAbort).
    const controller = new AbortController()
    registry.register(runId, controller)
    // P1-1: everything between `register` (which takes a concurrency slot)
    // and handing the run to `settleEngineRun` (which settles + releases in a
    // `finally`) runs under settlement coverage. A failure here — a broken
    // `start` audit write or a git-baseline snapshot error — used to leak the
    // slot forever (exhausting maxConcurrentRuns after a few failures), leave
    // the stream stuck in `preparing`, and write no `end` audit row (需求②).
    try {
      this.deps.ensureSandboxDir(workspace, runId)

      const state = createRunState({
        runId,
        workflowName: input.workflow.config.workflow.name,
        configFile: input.workflow.configFile,
        config: input.workflow.config,
        inputs: input.inputs ?? {},
        parentSessionId: input.parent.session.id,
      })

      // Live streaming projection for the web panel.
      registry.openStream({
        runId,
        workflowName: input.workflow.config.workflow.name,
        config: input.workflow.config,
        totalSteps: state.totalSteps,
      })

      const executor = this.deps.makeExecutor(workspace, input.parent, runId, 1)
      const options = this.engineOptions({
        workspace,
        parent: input.parent,
        workflow: input.workflow,
        runId,
        executor,
        signal: controller.signal,
        load: () => loadRunState(workspace, runId, config.runDirName),
        inputs: input.inputs ?? {},
      })

      this.deps.ctx.emit('ace/workflow-start', { runId, workflowName: input.workflow.config.workflow.name })
      await persistence.writeAudit(
        workspace,
        runId,
        auditEvent('start', {
          workflow: input.workflow.config.workflow.name,
          // Tamper-evident: which exact workflow content launched this run.
          workflowHash: sha256Text(JSON.stringify(input.workflow.config)),
        }, state.startedAt),
      )

      // Git baseline snapshot when the workflow runs against a repository.
      const projectRoot = input.workflow.config.context?.projectRoot
      if (projectRoot && input.workflow.config.context?.gitBaselineEnabled !== false) {
        const snapshot = await captureGitSnapshot(projectRoot)
        await saveGitSnapshot(workspace, runId, config.runDirName, 'baseline', null, snapshot)
      }

      const begin = this.beginRun(workspace, runId, options)
      const workflowName = input.workflow.config.workflow.name
      if (input.mode === 'job') {
        return { runId, ...this.detachAsJob(runId, input.parent, controller, begin, workflowName) }
      }
      return this.detachOnTurnAbort(runId, input.parent, controller, input.signal, begin(), workflowName)
    } catch (error) {
      // Settle as `failed` (end event + stream + end audit row) and free the
      // slot, then rethrow so callers keep seeing the original rejection.
      await this.settleStartupFailure(this.makeSettleDeps(), workspace, runId, error)
      throw error
    }
  }

  /**
   * Wrap a foreground run so that a cancelled calling turn does not kill it:
   * the run is detached into a background job and keeps executing. A run
   * already parked in a human decision point still aborts — resume re-asks.
   */
  private detachOnTurnAbort(
    runId: string,
    parent: Agent,
    controller: AbortController,
    signal: AbortSignal,
    running: Promise<RunResult>,
    workflowName: string,
  ): AceRunHandle {
    let resolveResult!: (value: RunResult) => void
    let rejectResult!: (reason: unknown) => void
    const result = new Promise<RunResult>((resolvePromise, reject) => {
      resolveResult = resolvePromise
      rejectResult = reject
    })
    running.then(resolveResult, rejectResult)
    let settled = false
    running.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    const handle: AceRunHandle = { runId, result }
    // The turn-abort decision point, made explicit (P1-2②). A cancelled
    // calling turn never silently kills a run:
    //   1. already settled      → nothing to decide;
    //   2. parked at a human decision point → abort the run (the durable
    //      pendingHuman survives; resume re-asks the question);
    //   3. otherwise            → detach into a background job that keeps
    //      executing; when this profile has no jobs service the run cannot
    //      outlive its turn, so it is aborted instead.
    const decideOnTurnAbort = (): void => {
      if (settled) return
      if (this.deps.registry.streams.get(runId)?.status === 'waiting-human') {
        controller.abort()
        return
      }
      try {
        const detached = this.detachAsJob(runId, parent, controller, () => running, workflowName)
        handle.detachedJobId = detached.jobId
        detached.result.then(resolveResult, rejectResult)
      } catch {
        // No jobs service in this profile: the run cannot outlive the turn.
        controller.abort()
      }
    }
    // A turn signal may already be aborted by the time the run starts.
    if (signal.aborted) decideOnTurnAbort()
    else signal.addEventListener('abort', decideOnTurnAbort, { once: true })
    return handle
  }

  /** Resume a persisted run (authorized by its recorded parent session). */
  async resumeRun(input: {
    parent: Agent
    signal: AbortSignal
    runId: string
    mode?: RunMode
  }): Promise<AceRunHandle> {
    const { config, registry, persistence } = this.deps
    const workspace = this.deps.workspaceOf(input.parent)
    const persisted = await loadRunState(workspace, input.runId, config.runDirName)
    if (!persisted) throw new Error(`未找到运行 ${input.runId}`)
    // Ownership: a live owning session binds the run exclusively. When the
    // owner is gone (its process exited — one-shot/headless sessions), the
    // run is an orphan: any live root session may adopt it, and the adoption
    // rebinds parentSessionId so later resumes belong to the adopter.
    let adoptedFrom: string | undefined
    if (persisted.parentSessionId !== input.parent.session.id) {
      const agents = this.deps.ctx.get('agents') as { get(id: never): Agent | undefined } | undefined
      const ownerLive =
        persisted.parentSessionId !== undefined &&
        agents?.get(persisted.parentSessionId as never) !== undefined
      if (ownerLive) throw new Error('只有启动该运行的会话才能恢复它')
      adoptedFrom = persisted.parentSessionId
      persisted.parentSessionId = input.parent.session.id
    }
    // Fail fast on completed runs; infrastructure-terminal runs (failed /
    // crashed / stopped) stay resumable — the engine continues from
    // pendingState/pendingHuman exactly like a waiting-human resume. Without
    // this, a step timeout would strand every long workflow for good.
    if (persisted.status === 'completed') {
      throw new Error(`运行 ${input.runId} 已完成，无需恢复`)
    }
    const resetFrom = ['failed', 'crashed', 'stopped'].includes(persisted.status) ? persisted.status : undefined
    if (resetFrom !== undefined) persisted.status = 'running'
    if (adoptedFrom !== undefined || resetFrom !== undefined) {
      // Durable adoption/status reset before the engine's first persist.
      await saveRunState(workspace, persisted, config.runDirName)
    }
    if (registry.isActive(input.runId)) {
      throw new Error(`运行 ${input.runId} 正在执行中`)
    }
    const workflow = await this.deps.resolveWorkflowConfig(workspace, persisted.configFile)
    if (!workflow) throw new Error(`运行 ${input.runId} 引用的 workflow「${persisted.configFile}」不存在`)
    // Single controller, same rule as startRun (P1-2②): the turn signal
    // detaches instead of aborting.
    const controller = new AbortController()
    this.deps.ensureSandboxDir(workspace, input.runId)
    registry.register(input.runId, controller)
    // P1-1: same settlement coverage as startRun — a failure between register
    // and the engine hand-off (e.g. the `resume` audit write) must settle the
    // run terminally and release the slot instead of leaking it.
    try {
      // Rebuild the live stream projection from the persisted truth (P1-2⑤):
      // a resumed run must be observable like a fresh one (/stream 200 with
      // topology, verdicts, and the step log backfilled). The projection is
      // idempotent; later persists refine the entry in place.
      projectRunStateToStream(
        registry.openStream({
          runId: input.runId,
          workflowName: persisted.workflowName,
          config: workflow.config,
          totalSteps: persisted.totalSteps,
        }),
        persisted,
      )
      const executor = this.deps.makeExecutor(workspace, input.parent, input.runId, 1)
      const options = this.engineOptions({
        workspace,
        parent: input.parent,
        workflow: { config: workflow.config, configFile: workflow.file },
        runId: input.runId,
        executor,
        signal: controller.signal,
        load: () => loadRunState(workspace, input.runId, config.runDirName),
        inputs: {},
      })
      // Traceable resume: mirror the 'start' audit row so a resumed run's log
      // shows who continued it and when; adoption/status resets are recorded.
      await persistence.writeAudit(
        workspace,
        input.runId,
        auditEvent('resume', {
          workflow: persisted.workflowName,
          ...(adoptedFrom !== undefined ? { adoptedFrom } : {}),
          ...(resetFrom !== undefined ? { resetFrom } : {}),
        }),
      )
      const begin = this.beginRun(workspace, input.runId, options)
      if (input.mode === 'job') {
        return { runId: input.runId, ...this.detachAsJob(input.runId, input.parent, controller, begin, persisted.workflowName) }
      }
      return this.detachOnTurnAbort(input.runId, input.parent, controller, input.signal, begin(), persisted.workflowName)
    } catch (error) {
      await this.settleStartupFailure(this.makeSettleDeps(), workspace, input.runId, error)
      throw error
    }
  }

  /**
   * Build the terminal-settle seam. Shared by the engine settlement
   * (`beginRun`) and the startup-failure handler (P1-1) so both paths settle
   * through the one writer (`settleRunEnd`).
   */
  private makeSettleDeps(): SettleRunEndDeps {
    const { registry, persistence } = this.deps
    return {
      registry,
      persistence,
      emitRunEnd: (payload) => this.deps.ctx.emit('ace/workflow-end', payload),
    }
  }

  /**
   * Settle a run that failed between `register` (which takes a concurrency
   * slot) and handing it to `settleEngineRun` (P1-1): write the `end` audit
   * row carrying the failure, settle the stream, and free the slot. The
   * settle itself is best-effort — a broken audit write must not mask the
   * original error or leak the slot, so cleanup and release always run.
   */
  private async settleStartupFailure(
    deps: SettleRunEndDeps,
    workspace: string,
    runId: string,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    await settleRunEnd(deps, workspace, runId, { status: 'failed', error: message, stateOutcomes: [] })
      .catch(() => {})
      .finally(() => {
        deps.registry.release(runId)
      })
  }

  /** Wrap the engine promise chain: end event, audit row, registry cleanup. */
  private beginRun(
    workspace: string,
    runId: string,
    options: EngineRunOptions,
  ): () => Promise<RunResult> {
    const settleDeps = this.makeSettleDeps()
    // P0-A: settlement lives OUTSIDE the engine's success callback. A
    // rejection (NO_INITIAL / NO_MATCH on a terminal state / load failure)
    // settles the run as `failed` with the error and writes the same `end`
    // audit row the success path does; the stream settles (and gets pruned)
    // and the audit cursor is released on both paths.
    return () => settleEngineRun(settleDeps, workspace, runId, runStateMachine(options))
  }

  /** Detach an engine run as a DSH background job owned by the parent agent. */
  private detachAsJob(
    runId: string,
    parent: Agent,
    controller: AbortController,
    begin: () => Promise<RunResult>,
    workflowName: string,
  ): { jobId: JobId; result: Promise<RunResult> } {
    const jobRegistry = this.deps.jobs()
    if (!jobRegistry) {
      controller.abort()
      throw new Error('当前 profile 未挂载 jobs 服务，无法以后台 job 方式运行')
    }
    let resolveResult!: (value: RunResult) => void
    let rejectResult!: (reason: unknown) => void
    const result = new Promise<RunResult>((resolvePromise, reject) => {
      resolveResult = resolvePromise
      rejectResult = reject
    })
    // Job-mode callers observe the job outcome, not this promise: keep an
    // engine rejection from surfacing as an unhandled promise rejection.
    result.catch(() => {})
    const jobId = jobRegistry.start({
      kind: 'ace-workflow',
      label: `ACE workflow ${workflowName}`,
      owner: parent,
      run: () => {
        const runResult = begin()
        runResult.then(resolveResult, rejectResult)
        return {
          cancel: (): void => {
            controller.abort()
          },
          // JobHooks.done must not reject — the registry converts a rejection
          // to a bare 'failed' and loses the engine's error message.
          done: runResult.then(
            (settled) => jobOutcomeFor(settled),
            (error): JobOutcomeLike => ({
              status: 'failed',
              detail: error instanceof Error ? error.message : String(error),
            }),
          ),
        }
      },
    })
    return { jobId, result }
  }

  /** Cancel an active run. Returns false when the run is not active. */
  stopRun(runId: string): boolean {
    return this.deps.registry.stop(runId)
  }

  /** Whether a run id is currently executing. */
  isActive(runId: string): boolean {
    return this.deps.registry.isActive(runId)
  }

  /** Assemble the engine options of one (sub)workflow run. */
  engineOptions(input: EngineOptionsInput): EngineRunOptions {
    const { config, persistence } = this.deps
    const { workspace, parent, workflow, runId, executor, signal, load, inputs } = input
    return {
      config: workflow.config,
      runId,
      configFile: workflow.configFile,
      inputs,
      parent,
      signal,
      executor,
      persist: persistence.makePersist(workspace, runId),
      load,
      pythonCommand: config.pythonCommand,
      scriptsHome: join(workspace, config.runDirName, 'scripts'),
      sandboxDir: join(workspace, config.runDirName, 'runs', runId, 'sandbox'),
      resolveSubworkflow: async (configFile: string) => {
        const resolved = await this.deps.resolveWorkflowConfig(workspace, configFile)
        if (!resolved) throw new EngineError(`子工作流「${configFile}」不存在`, 'NO_MATCH')
        return resolved.config
      },
      askHumanTransition: async ({ state, candidates, signal: askSignal }) => {
        // Approval gates arrive as the single `__continue__` candidate; render
        // them as an explicit approve/stop choice instead of a raw token.
        const approval = candidates.length === 1 && candidates[0] === '__continue__'
        const answer = await this.deps.ctx.userQuestions.ask({
          questions: [
            {
              id: 'transition',
              header: approval ? '工作流审批' : '工作流决策',
              question: approval
                ? `状态「${state}」已完成，需要人工批准后才会继续：`
                : `工作流在状态「${state}」暂停，请选择下一步：`,
              options: approval
                ? [
                    { label: APPROVAL_CONTINUE_LABEL, description: '进入下一状态' },
                    { label: APPROVAL_STOP_LABEL, description: '以人工停止结束本次运行' },
                  ]
                : candidates.map((candidate) => ({ label: candidate })),
            },
          ],
          agent: parent,
          signal: askSignal,
        })
        const selected = answer.answers[0]?.selected[0] ?? ''
        if (approval && selected === APPROVAL_CONTINUE_LABEL) return '__continue__'
        if (approval && selected === APPROVAL_STOP_LABEL) return 'stop'
        return selected
      },
    }
  }
}
