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
  type StepExecutor,
} from './engine/types.js'
import { runDurationMs, sha256Text } from './store/audit-events.js'
import { captureGitSnapshot, saveGitSnapshot } from './store/git-baseline.js'
import { loadRunState } from './store/run-store.js'
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
    await persistence.writeAudit(workspace, runId, {
      at: state.startedAt,
      event: 'start',
      workflow: input.workflow.config.workflow.name,
      // Tamper-evident: which exact workflow content launched this run.
      workflowHash: sha256Text(JSON.stringify(input.workflow.config)),
    })

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
    if (persisted.parentSessionId !== input.parent.session.id) {
      throw new Error('只有启动该运行的会话才能恢复它')
    }
    // Fail fast on terminal runs: the engine rejects them too, but only after
    // the job was already registered, which used to surface as a fake
    // "resumed" whose real error vanished inside the background job.
    const terminal: RunState['status'][] = ['completed', 'failed', 'crashed', 'stopped']
    if (terminal.includes(persisted.status)) {
      throw new Error(`运行 ${input.runId} 已处于终态 ${persisted.status}，无法恢复`)
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
    // shows who continued it and when.
    await persistence.writeAudit(workspace, input.runId, {
      at: new Date().toISOString(),
      event: 'resume',
      workflow: persisted.workflowName,
    })
    const begin = this.beginRun(workspace, input.runId, options)
    if (input.mode === 'job') {
      return { runId: input.runId, ...this.detachAsJob(input.runId, input.parent, controller, begin, persisted.workflowName) }
    }
    return this.detachOnTurnAbort(input.runId, input.parent, controller, input.signal, begin(), persisted.workflowName)
  }

  /** Wrap the engine promise chain: end event, audit row, registry cleanup. */
  private beginRun(
    workspace: string,
    runId: string,
    options: EngineRunOptions,
  ): () => Promise<RunResult> {
    const { registry, persistence } = this.deps
    return () =>
      runStateMachine(options)
        .then(async (runResult) => {
          this.deps.ctx.emit('ace/workflow-end', { runId, status: runResult.status })
          registry.settleStream(runId, runResult.status)
          registry.finishRun(runId)
          await persistence.writeAudit(workspace, runId, {
            at: new Date().toISOString(),
            event: 'end',
            status: runResult.status,
            error: runResult.error,
            // Tamper-evident evidence-chain digest + run wall clock.
            evidenceHash: sha256Text(JSON.stringify(runResult.stateOutcomes)),
            durationMs: runDurationMs(runResult.stateOutcomes),
          })
          return runResult
        })
        .finally(() => {
          registry.release(runId)
        })
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
