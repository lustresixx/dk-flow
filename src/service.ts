/**
 * The ACE harness service: built-in agent catalog, workflow templates,
 * workflow instances, and state-machine runs executed over the DSH subagent
 * seam. This is the host half of the plugin; commands, tools, and the web
 * panel consume this service.
 *
 * Structure (P0-2): the service is the assembly point and public surface.
 * Per-run state lives in `run-registry.ts`, the persist pipeline in
 * `run-persistence.ts`, run start/resume/detach in `run-lifecycle.ts`, and
 * the engine's host seam in `step-executor-factory.ts` — each constructible
 * and testable on its own. Every export of this module is frozen.
 * @module dsh-ace-harness/service
 */
import { mkdirSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { apiRunnerParent, defaultHostServices, type HostServices } from './host-services.js'
import {
  firstCommentLine,
  latestTemplate,
  listBuiltinScripts,
  loadBuiltinAgents,
  loadBuiltinTemplates,
  readBuiltinTemplateSources,
  type BuiltinWorkflowTemplate,
} from './catalog/index.js'
import { parseWorkflowYaml, summarizeWorkflow, validateWorkflowReferences, type WorkflowSummary } from './dsl/load.js'
import type { AgentDefinition, StepType, StepVerdict, WorkflowConfig } from './dsl/types.js'
import { executeStateStep, executeStateSteps, joinStateVerdict, type StateStepOptions } from './engine/state-steps.js'
import { evaluateTransitions } from './engine/transitions.js'
import type { RunState, StepExecutor, StepOutcome } from './engine/types.js'
import { workspaceRoot } from './store/paths.js'
import { listRunStates, loadRunState } from './store/run-store.js'
import { SqliteArchive, type ArchivedAuditRow, type ArchivedRunRow } from './store/sqlite-archive.js'
import { aggregateRunStats, combineStatsProjection, type WorkspaceRunStats } from './store/run-stats.js'
import { StatsCache } from './store/stats-cache.js'
import { stepDurationMs } from './store/audit-events.js'
import { readWorkspaceSettings, writeWorkspaceSettings } from './store/workspace-settings.js'
import { deleteWorkflow, listWorkflows, loadWorkflow, saveWorkflow, type WorkflowEntry } from './store/workflow-store.js'
import {
  instantiateTemplate as bindTemplate,
  type AgentSubstitutions,
  type InstantiatedWorkflow,
  type TemplateParameterValues,
} from './templates/instantiate.js'
import { RunLifecycle } from './run-lifecycle.js'
import { RunPersistence } from './run-persistence.js'
import { RunRegistry } from './run-registry.js'
import { makeStepExecutor, type StepExecutorHost } from './step-executor-factory.js'

// Frozen export surface (re-exported from the collaborators they moved to).
export { toolFilterFor, stepSignalWithTimeout, jobOutcomeFor } from './step-executor-factory.js'
export type { JobOutcomeLike } from './step-executor-factory.js'
export type { AceRunHandle, RunMode } from './run-lifecycle.js'
export type { RunStreamSnapshot } from './run-registry.js'
import type { AceRunHandle, RunMode } from './run-lifecycle.js'
import type { RunStreamSnapshot } from './run-registry.js'

/** Deployment-tunable service options; set from the plugin Config. */
export interface AceHarnessConfig {
  /** DSH subagent provider used for every step (default `spawn`). */
  subagentProvider?: string
  /** Optional model override applied to every step subagent. */
  model?: string
  /** Run storage root name inside each workspace (default `.ace-workflows`). */
  runDirName?: string
  /** Maximum nesting depth of subworkflow steps (default 8). */
  maxSubworkflowDepth?: number
  /** Maximum concurrent runs per service instance (default 4). */
  maxConcurrentRuns?: number
  /** Per pre-command timeout in milliseconds (default 300000). */
  preCommandTimeoutMs?: number
  /** Per AI step timeout in milliseconds (default 1800000 = 30 min). */
  stepTimeoutMs?: number
  /** Command used to launch Python for `.py` scriptFile steps (default `python`). */
  pythonCommand?: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A workflow run started. */
    'ace/workflow-start'(payload: { runId: string; workflowName: string }): void
    /** One step began executing. */
    'ace/step-start'(payload: { runId: string; state: string; step: string; role: string }): void
    /** One step settled with its verdict, if any. */
    'ace/step-end'(payload: { runId: string; state: string; step: string; verdict?: string }): void
    /** One state settled with its aggregate verdict. */
    'ace/state-end'(payload: { runId: string; state: string; verdict: string }): void
    /** The run reached a terminal status. */
    'ace/workflow-end'(payload: { runId: string; status: string }): void
    /** Run progress snapshot after every persisted mutation. */
    'ace/run-updated'(payload: {
      runId: string
      status: string
      currentState: string | null
      completedSteps: number
      totalSteps: number
    }): void
  }
}

/** One script discoverable by `/workflow scripts`. */
export interface WorkflowScriptEntry {
  name: string
  source: 'builtin' | 'workspace'
  description: string
}

/** TTL of the archived-count badge cache (P1-2⑥; badge may lag this long). */
const ARCHIVED_COUNT_TTL_MS = 10_000

/**
 * TTL of the workspace-stats aggregation cache (P2). Write-through
 * invalidation on every persist keeps the route fresh (the e2e asserts
 * `stats.totalRuns` equals the archive total right after a wave); the TTL is
 * only a fallback for mutations that bypass the persist pipeline. The panel
 * polls every few seconds, so 10s staleness is well inside tolerance.
 */
const STATS_CACHE_TTL_MS = 10_000

/** Result of verifying one workflow step in isolation. */
export interface TestStepResult {
  state: string
  step: string
  type: StepType
  outputSummary: string
  verdict: StepVerdict | null
  data: unknown
}

/** One step line inside a state-level verification. */
export interface TestStateStepDto {
  step: string
  type: StepType
  verdict: StepVerdict | null
  outputSummary: string
}

/** Result of verifying a whole state: step lines + predicted transition. */
export interface TestStateResult {
  state: string
  verdict: StepVerdict | null
  steps: TestStateStepDto[]
  matchedTransition: { to: string; label: string | null } | null
  error: string | null
  notes: string[]
}

export default class AceHarnessService extends Service {
  private readonly config: Required<AceHarnessConfig>
  private agents: AgentDefinition[] = []
  private templates: BuiltinWorkflowTemplate[] = []
  private readonly catalogReady: Promise<void>
  private readonly archive = new SqliteArchive()
  /** TTL cache for the state route's archived-count badge (P1-2⑥). */
  private readonly archivedCountCache = new Map<string, { at: number; value: number }>()
  /** Per-workspace stats aggregation cache (P2; write-through invalidated). */
  private readonly statsCache = new StatsCache<WorkspaceRunStats>(STATS_CACHE_TTL_MS)
  /** Shared per-run maps (active controllers / streams / audit cursors). */
  private readonly registry = new RunRegistry()
  /** The per-run persist pipeline. */
  private readonly persistence: RunPersistence
  /** Run start / resume / stop orchestration. */
  private readonly lifecycle: RunLifecycle
  /** Host face handed to the step-executor factory. */
  private readonly executors: StepExecutorHost
  /** Host capabilities, resolved in one place (P2-3). */
  private readonly host: HostServices

  constructor(ctx: Context, config: AceHarnessConfig = {}, host?: HostServices) {
    super(ctx, 'ace-harness')
    this.host = host ?? defaultHostServices(ctx)
    this.config = {
      subagentProvider: config.subagentProvider ?? 'spawn',
      model: config.model ?? '',
      runDirName: config.runDirName ?? '.ace-workflows',
      maxSubworkflowDepth: config.maxSubworkflowDepth ?? 8,
      maxConcurrentRuns: config.maxConcurrentRuns ?? 4,
      preCommandTimeoutMs: config.preCommandTimeoutMs ?? 300_000,
      stepTimeoutMs: config.stepTimeoutMs ?? 1_800_000,
      pythonCommand: config.pythonCommand ?? 'python',
    }
    this.persistence = new RunPersistence({
      archive: this.archive,
      registry: this.registry,
      runDirName: this.config.runDirName,
      sqliteEnabled: (workspace) => this.sqliteEnabled(workspace),
      emitRunUpdated: (payload) => this.ctx.emit('ace/run-updated', payload),
      // P2 write-through: every persisted snapshot invalidates the stats
      // aggregation of its workspace so the next /stats read is fresh.
      invalidateStats: (workspace) => this.statsCache.invalidate(workspace),
    })
    this.lifecycle = new RunLifecycle({
      ctx: this.ctx,
      config: this.config,
      registry: this.registry,
      persistence: this.persistence,
      jobs: () => this.host.jobs(),
      workspaceOf: (parent) => this.workspaceOf(parent),
      resolveWorkflowConfig: (workspace, configFile) => this.resolveWorkflowConfig(workspace, configFile),
      makeExecutor: (workspace, parent, runId, depth) => this.makeExecutor(workspace, parent, runId, depth),
      ensureSandboxDir: (workspace, runId) => this.ensureSandboxDir(workspace, runId),
    })
    this.executors = {
      ctx: this.ctx,
      config: this.config,
      registry: this.registry,
      agentByName: (name) => this.agentByName(name),
      resolveWorkflowConfig: (workspace, configFile) => this.resolveWorkflowConfig(workspace, configFile),
      engineOptions: (input) => this.lifecycle.engineOptions(input),
    }
    this.catalogReady = this.loadCatalog()
  }

  private async loadCatalog(): Promise<void> {
    ;[this.agents, this.templates] = await Promise.all([loadBuiltinAgents(), loadBuiltinTemplates()])
  }

  /** Resolve one catalog agent by name (after the catalog has loaded). */
  async agentByName(name: string): Promise<AgentDefinition | undefined> {
    await this.catalogReady
    return this.agents.find((agent) => agent.name === name)
  }

  /** List every built-in agent. */
  async listAgents(): Promise<AgentDefinition[]> {
    await this.catalogReady
    return [...this.agents]
  }

  /** List every built-in workflow template. */
  async listTemplates(): Promise<BuiltinWorkflowTemplate[]> {
    await this.catalogReady
    return [...this.templates]
  }

  /** One script discoverable by `/workflow scripts`. */
  async listScripts(workspace: string): Promise<WorkflowScriptEntry[]> {
    const scripts: WorkflowScriptEntry[] = (await listBuiltinScripts()).map((script) => ({
      ...script,
      source: 'builtin' as const,
    }))
    const dir = join(workspace, this.config.runDirName, 'scripts')
    try {
      const entries = (await readdir(dir)).filter((name) => /\.(js|mjs|cjs|py)$/.test(name))
      for (const entry of entries) {
        scripts.push({
          name: entry,
          source: 'workspace',
          description: firstCommentLine(await readFile(join(dir, entry), 'utf8')),
        })
      }
    } catch {
      // The collection directory does not exist yet: nothing to list.
    }
    return scripts.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name))
  }

  /** Create the per-run sandbox directory (best effort; never fails the run). */
  private ensureSandboxDir(workspace: string, runId: string): void {
    try {
      mkdirSync(join(workspace, this.config.runDirName, 'runs', runId, 'sandbox', 'tmp'), {
        recursive: true,
      })
    } catch {
      // Sandbox creation failure degrades to host-level execution.
    }
  }

  /**
   * Engine options slice for isolated verification: the same step execution
   * the runner drives (P0-3), bound to the shared test sandbox. Without a
   * live parent session, agent/subworkflow steps fail with a readable hint.
   */
  private testStepOptions(input: {
    parent?: Agent
    signal: AbortSignal
    config: WorkflowConfig
    workspace: string
    sandboxDir: string
    stateName: string
  }): StateStepOptions {
    const executor = this.makeExecutor(
      input.workspace,
      (input.parent ?? { options: {} }) as Agent,
      `test-${Date.now()}`,
      1,
    )
    if (input.parent) {
      return {
        config: input.config,
        parent: input.parent,
        signal: input.signal,
        executor,
        scriptsHome: join(input.workspace, this.config.runDirName, 'scripts'),
        pythonCommand: this.config.pythonCommand,
        sandboxDir: input.sandboxDir,
      }
    }
    const needsSession = (type: string, stepName: string): Error =>
      new Error(
        `「${type}」步骤的独立验证需要会话上下文：请在会话中用 /workflow test <工作流> ${input.stateName} ${stepName} 验证`,
      )
    return {
      config: input.config,
      parent: { options: {} } as Agent,
      signal: input.signal,
      executor: {
        ...executor,
        runAgentStep: async (stepInput) => {
          throw needsSession('agent', stepInput.stepName)
        },
        runSubworkflowStep: async (stepInput) => {
          throw needsSession('subworkflow', stepInput.stepName)
        },
      },
      scriptsHome: join(input.workspace, this.config.runDirName, 'scripts'),
      pythonCommand: this.config.pythonCommand,
      sandboxDir: input.sandboxDir,
    }
  }

  /** Result of verifying one workflow step in isolation. */
  async testStep(input: {
    parent?: Agent
    signal: AbortSignal
    config: WorkflowConfig
    stateName: string
    stepName: string
    values: Record<string, string>
    workspace: string
  }): Promise<TestStepResult> {
    const machineState = input.config.workflow.states.find((state) => state.name === input.stateName)
    if (!machineState) throw new Error(`未找到状态「${input.stateName}」`)
    const step = machineState.steps.find((candidate) => candidate.name === input.stepName)
    if (!step) throw new Error(`未找到状态「${input.stateName}」中的步骤「${input.stepName}」`)
    const requirements = input.values.requirements ?? input.config.context?.requirements ?? ''
    const sandboxDir = join(input.workspace, this.config.runDirName, 'test-sandbox')
    if ((step.type ?? 'agent') === 'script') this.ensureTestSandbox(sandboxDir)
    const outcome = await executeStateStep({
      options: this.testStepOptions({ ...input, sandboxDir }),
      machineState,
      step,
      run: {
        stateOutcomes: [],
        context: { requirements, projectRoot: input.config.context?.projectRoot },
        inputs: input.values,
      },
      completedSteps: [],
    })
    return {
      state: machineState.name,
      step: step.name,
      type: step.type ?? 'agent',
      outputSummary: outcome.outputSummary,
      verdict: outcome.verdict ?? null,
      data: outcome.data,
    }
  }

  /**
   * Verify a whole state in isolation: run its steps in declared order with
   * the same evidence hand-off as the engine, join the last segment's verdict
   * under the state join policy, and predict which transition would fire.
   */
  async testState(input: {
    parent?: Agent
    signal: AbortSignal
    config: WorkflowConfig
    stateName: string
    values: Record<string, string>
    workspace: string
  }): Promise<TestStateResult> {
    const machineState = input.config.workflow.states.find((state) => state.name === input.stateName)
    if (!machineState) throw new Error(`未找到状态「${input.stateName}」`)
    const notes: string[] = []
    const result: TestStateResult = {
      state: machineState.name,
      verdict: null,
      steps: [],
      matchedTransition: null,
      error: null,
      notes,
    }
    if (machineState.steps.length === 0) {
      result.error = '该状态没有声明任何步骤，无法验证'
      return result
    }
    if (machineState.steps.some((step) => step.parallelGroup)) {
      notes.push('并行组在独立验证中按声明顺序串行执行（真实运行为并发）')
    }
    const requirements = input.values.requirements ?? input.config.context?.requirements ?? ''
    const sandboxDir = join(input.workspace, this.config.runDirName, 'test-sandbox')
    if (machineState.steps.some((step) => (step.type ?? 'agent') === 'script')) this.ensureTestSandbox(sandboxDir)
    const completed: StepOutcome[] = []
    try {
      await executeStateSteps(
        this.testStepOptions({ ...input, sandboxDir }),
        machineState,
        {
          stateOutcomes: [],
          context: { requirements, projectRoot: input.config.context?.projectRoot },
          inputs: input.values,
          completedSteps: completed,
        },
        {
          sequential: true,
          onStepFinished: async (done) => {
            result.steps = done.map((outcome) => ({
              step: outcome.step,
              type: outcome.type,
              verdict: outcome.verdict ?? null,
              outputSummary: outcome.outputSummary,
            }))
          },
        },
      )
    } catch (error) {
      const message = (error as Error).message
      // Sequential execution: the failing step is the first not yet completed.
      const failing = machineState.steps[completed.length]
      const type: StepType = failing?.type ?? 'agent'
      result.steps.push({
        step: failing?.name ?? '',
        type,
        verdict: null,
        outputSummary: `执行出错：${message}`,
      })
      result.error = `步骤「${failing?.name ?? ''}」执行出错，后续步骤未执行：${message}`
      return result
    }
    // Same join as executeState: the last segment's verdict, by state policy.
    const joined = joinStateVerdict(machineState, completed)
    result.verdict = joined
    if (machineState.isFinal) {
      notes.push('终止状态不发生转移')
    } else {
      const matched = evaluateTransitions(machineState, joined)
      result.matchedTransition = matched ? { to: matched.to, label: matched.label ?? null } : null
      if (!matched) notes.push('没有匹配的转移：真实运行会在此暂停并等待人工决策')
    }
    return result
  }

  /** Create the test sandbox directory (best effort). */
  private ensureTestSandbox(dir: string): void {
    try {
      mkdirSync(join(dir, 'tmp'), { recursive: true })
    } catch {
      // Degrades to host-level execution.
    }
  }

  /** The agent names available to workflow configs in this deployment. */
  async availableAgentNames(): Promise<Set<string>> {
    await this.catalogReady
    return new Set(this.agents.map((agent) => agent.name))
  }

  /**
   * Instantiate a built-in template into an independent workflow config.
   * @param templateId - template id, e.g. `general-red-blue-review`.
   * @param version - optional semantic version; latest wins when omitted.
   */
  async instantiate(
    templateId: string,
    version: string | undefined,
    values: TemplateParameterValues,
    substitutions: AgentSubstitutions,
  ): Promise<InstantiatedWorkflow> {
    await this.catalogReady
    const candidates = this.templates.filter((template) => template.id === templateId)
    const template = version
      ? candidates.find((candidate) => candidate.version === version)
      : latestTemplate(candidates, templateId)
    if (!template) throw new Error(`未找到模板「${templateId}」${version ? ` 版本 ${version}` : ''}`)
    const sources = await readBuiltinTemplateSources(template.id, template.version)
    if (!sources) throw new Error(`模板「${templateId}」资源缺失`)
    return bindTemplate(
      sources.manifestText,
      sources.workflowYamlText,
      values,
      substitutions,
      await this.availableAgentNames(),
    )
  }

  /** Discover workflow instances (project shadows personal). */
  async listWorkflows(workspace: string): Promise<WorkflowEntry[]> {
    return listWorkflows(workspace)
  }

  /** Load one workflow instance by file name. */
  async loadWorkflowConfig(workspace: string, fileName: string): Promise<{ config: WorkflowConfig; file: string } | null> {
    return loadWorkflow(workspace, fileName)
  }

  /** Parse and reference-check an arbitrary workflow YAML text. */
  async validateWorkflowYaml(yamlText: string): Promise<{ config: WorkflowConfig; summary: WorkflowSummary; errors: string[] }> {
    const config = parseWorkflowYaml(yamlText)
    const errors = validateWorkflowReferences(config, await this.availableAgentNames())
    return { config, summary: summarizeWorkflow(config), errors }
  }

  /** Save a workflow instance into the workspace project directory. */
  async saveWorkflowConfig(workspace: string, fileName: string, yamlText: string): Promise<string> {
    const validated = await this.validateWorkflowYaml(yamlText)
    if (validated.errors.length > 0) {
      throw new Error(`workflow 引用校验失败: ${validated.errors.join('; ')}`)
    }
    return saveWorkflow(workspace, fileName, yamlText)
  }

  /** Delete a workspace workflow instance. */
  async deleteWorkflowConfig(workspace: string, fileName: string): Promise<boolean> {
    return deleteWorkflow(workspace, fileName)
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
    return this.lifecycle.startRun(input)
  }

  /** Resume a persisted run (authorized by its recorded parent session). */
  async resumeRun(input: {
    parent: Agent
    signal: AbortSignal
    runId: string
    mode?: RunMode
  }): Promise<AceRunHandle> {
    return this.lifecycle.resumeRun(input)
  }

  /** Cancel an active run. Returns false when the run is not active. */
  stopRun(runId: string): boolean {
    return this.lifecycle.stopRun(runId)
  }

  /** Whether a run id is currently executing. */
  isActive(runId: string): boolean {
    return this.lifecycle.isActive(runId)
  }

  /** List persisted runs of a workspace, newest first. */
  async listRuns(workspace: string): Promise<RunState[]> {
    return listRunStates(workspace, this.config.runDirName)
  }

  /** Read one persisted run state. */
  async getRun(workspace: string, runId: string): Promise<RunState | null> {
    return loadRunState(workspace, runId, this.config.runDirName)
  }

  /** Live streaming snapshot of a run, or undefined when unknown or pruned. */
  streamSnapshot(runId: string): RunStreamSnapshot | undefined {
    return this.registry.snapshot(runId)
  }

  /**
   * Run a workflow through the HTTP API. Without `sessionId` a synthetic
   * parent bound to the given workspace is used: script/llm steps run fully,
   * but steps that spawn subagents fail loudly and approval gates cannot
   * prompt. With `sessionId` the run binds to that live root session, so
   * agent steps spawn real subagents and approval gates surface in its GUI;
   * `mode: 'job'` (session-bound only) detaches the run as a background job.
   */
  async runApi(input: {
    workspace: string
    workflowRef: string
    values: Record<string, string>
    sessionId?: string
    mode?: RunMode
  }): Promise<AceRunHandle> {
    const instance = await loadWorkflow(input.workspace, input.workflowRef)
    let workflow: { config: WorkflowConfig; configFile: string }
    if (instance) {
      workflow = { config: instance.config, configFile: instance.file }
    } else {
      await this.catalogReady
      const template = latestTemplate(this.templates, input.workflowRef)
      if (!template) throw new Error(`未找到 workflow 实例或模板「${input.workflowRef}」`)
      const instantiated = await this.instantiate(input.workflowRef, undefined, input.values, {})
      workflow = { config: instantiated.config, configFile: input.workflowRef }
    }
    let parent: Agent
    if (input.sessionId !== undefined && input.sessionId !== '') {
      parent = this.requireLiveRoot(input.sessionId)
    } else {
      if (input.mode === 'job') {
        throw new Error('mode=job 需要 sessionId：后台作业必须挂在真实会话上')
      }
      parent = apiRunnerParent(input.workspace)
    }
    return this.startRun({
      parent,
      signal: new AbortController().signal,
      workflow,
      inputs: input.values,
      mode: input.mode ?? 'foreground',
    })
  }

  /** Live root sessions that can host session-bound runs (approval gates work). */
  listLiveSessions(): Array<{ id: string; cwd: string; createdAt: number }> {
    const registry = this.host.agents()
    return (registry?.roots() ?? []).map((agent) => ({
      id: agent.session.id,
      cwd: agent.session.header.cwd ?? '',
      createdAt: agent.session.header.createdAt,
    }))
  }

  /** Resolve a session id to its exact live root agent (runs bind to roots only). */
  private requireLiveRoot(sessionId: string): Agent {
    const registry = this.host.agents()
    const agent = registry?.get(sessionId as SessionId)
    if (!agent) {
      throw new Error(`会话「${sessionId}」不在线或不存在；可用 GET /plugins/dsh-ace-harness/sessions 查看在线会话`)
    }
    if (!(registry?.roots() ?? []).includes(agent)) {
      throw new Error(`会话「${sessionId}」是子代理会话，不能承载工作流运行（审批门需要根会话）`)
    }
    return agent
  }

  /** The workspace root the service uses for one agent. */
  workspaceOf(agent: Agent): string {
    return workspaceRoot(agent.session.header.cwd, this.host.processCwd)
  }

  /** Whether the workspace opted into the SQLite run archive. */
  private async sqliteEnabled(workspace: string): Promise<boolean> {
    return (await readWorkspaceSettings(workspace, this.config.runDirName)).sqliteArchive
  }

  /**
   * SQLite archive status of one workspace (for the state route). The
   * archived-count query rides a short TTL cache (P1-2⑥, same pattern as
   * the state route's topology cache): the route is polled every few
   * seconds per workspace and countRuns is a synchronous DatabaseSync
   * query. Declared staleness: the badge may lag ≤10s.
   */
  async sqliteStatus(workspace: string): Promise<{ enabled: boolean; archived: number; dbFile: string | null }> {
    const enabled = await this.sqliteEnabled(workspace)
    if (!enabled) return { enabled: false, archived: 0, dbFile: null }
    const dbFile = this.archive.dbFile(workspace, this.config.runDirName)
    const hit = this.archivedCountCache.get(workspace)
    if (hit && Date.now() - hit.at < ARCHIVED_COUNT_TTL_MS) {
      return { enabled: true, archived: hit.value, dbFile }
    }
    let archived = 0
    try {
      archived = this.archive.countRuns(workspace, this.config.runDirName)
    } catch {
      archived = 0
    }
    this.archivedCountCache.set(workspace, { at: Date.now(), value: archived })
    return { enabled: true, archived, dbFile }
  }

  /** Toggle the SQLite archive; enabling backfills the existing file store. */
  async setSqliteArchive(
    workspace: string,
    enabled: boolean,
  ): Promise<{ enabled: boolean; backfilled: number; dbFile: string }> {
    await writeWorkspaceSettings(workspace, this.config.runDirName, { sqliteArchive: enabled })
    // The stats feed switches (JSON scan ⇄ SQL projection): drop any cached
    // aggregation so the next read reflects the new feed immediately.
    this.statsCache.invalidate(workspace)
    let backfilled = 0
    if (enabled) backfilled = await this.archive.backfill(workspace, this.config.runDirName)
    return { enabled, backfilled, dbFile: this.archive.dbFile(workspace, this.config.runDirName) }
  }

  /** Query archived runs (empty result when the archive is disabled). */
  async archivedRuns(
    workspace: string,
    query: { limit?: number; offset?: number; workflow?: string; status?: string } = {},
  ): Promise<{ enabled: boolean; total: number; rows: ArchivedRunRow[] }> {
    if (!(await this.sqliteEnabled(workspace))) return { enabled: false, total: 0, rows: [] }
    return {
      enabled: true,
      total: this.archive.countRuns(workspace, this.config.runDirName),
      rows: this.archive.queryRuns(workspace, this.config.runDirName, query),
    }
  }

  /** Full archived evidence chain of one run (null when absent/disabled). */
  async archivedRunDetail(
    workspace: string,
    runId: string,
  ): Promise<{ run: ArchivedRunRow; state: RunState | null; audit: ArchivedAuditRow[] } | null> {
    if (!(await this.sqliteEnabled(workspace))) return null
    return this.archive.queryRunDetail(workspace, this.config.runDirName, runId)
  }

  /** Close archive database handles (plugin dispose). */
  closeArchives(): void {
    // Drain queued mirror writes first (P1-2⑥), best effort; the JSON files
    // stay authoritative if the process exits before the flush lands.
    void this.persistence
      .flushArchives()
      .catch(() => {})
      .finally(() => this.archive.close())
  }

  /** Workspace run statistics (archive SQL when enabled, JSON scan otherwise). */
  async workspaceStats(workspace: string): Promise<WorkspaceRunStats & { archiveEnabled: boolean; activeRuns: number }> {
    const enabled = await this.sqliteEnabled(workspace)
    // P2: aggregate once per TTL per workspace; the persist pipeline
    // invalidates the key on every write so the cache never hides a fresh
    // run. archiveEnabled / activeRuns stay live (not cached).
    const cached = this.statsCache.get(workspace)
    const stats: WorkspaceRunStats =
      cached ??
      (enabled
        ? combineStatsProjection(this.archive.queryStatsProjection(workspace, this.config.runDirName))
        : aggregateRunStats(
            (await listRunStates(workspace, this.config.runDirName)).map((state) => ({
              status: state.status,
              startedAt: state.startedAt,
              finishedAt: state.finishedAt,
              states: state.stateOutcomes.map((outcome) => ({
                state: outcome.state,
                verdict: outcome.verdict.verdict,
              })),
              // Step-level feed (P0-B): completed steps with effective durations
              // plus the failure history (steps that threw have no StepOutcome).
              steps: state.stateOutcomes.flatMap((outcome) =>
                outcome.steps.map((step) => ({
                  state: step.state,
                  step: step.step,
                  verdict: step.verdict?.verdict ?? null,
                  attempts: step.attempts ?? null,
                  durationMs: stepDurationMs(step),
                })),
              ),
              failedSteps: (state.failedSteps ?? []).map((failed) => ({
                state: failed.state,
                step: failed.step,
                attempts: failed.attempts ?? null,
              })),
            })),
          ))
    if (!cached) this.statsCache.set(workspace, stats)
    return { ...stats, archiveEnabled: enabled, activeRuns: this.registry.counts().activeRuns }
  }

  /** Liveness + activity snapshot for monitoring probes. */
  health(): { ok: true; activeRuns: number; streamingRuns: number; uptimeSec: number } {
    const counts = this.registry.counts()
    return {
      ok: true,
      activeRuns: counts.activeRuns,
      streamingRuns: counts.streamingRuns,
      uptimeSec: Math.round(process.uptime()),
    }
  }

  /** Resolve a workflow reference: instance name, template id, or relative path. */
  async resolveWorkflowConfig(
    workspace: string,
    configFile: string,
  ): Promise<{ config: WorkflowConfig; file: string } | null> {
    const instance = await loadWorkflow(workspace, configFile)
    if (instance) return { config: instance.config, file: instance.file }
    await this.catalogReady
    // Latest version wins (P1-1): the same rule every entry point applies.
    const template = latestTemplate(this.templates, configFile)
    if (template) return { config: template.config, file: configFile }
    try {
      const path = isAbsolute(configFile) ? configFile : resolve(workspace, configFile)
      const config = parseWorkflowYaml(await readFile(path, 'utf8'))
      return { config, file: path }
    } catch {
      return null
    }
  }

  /** Build the step executor for one run, bound to its workspace and lineage. */
  private makeExecutor(workspace: string, parent: Agent, parentRunId: string, depth: number): StepExecutor {
    return makeStepExecutor(this.executors, workspace, parent, parentRunId, depth)
  }
}
