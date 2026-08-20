/**
 * The ACE harness service: built-in agent catalog, workflow templates,
 * workflow instances, and state-machine runs executed over the DSH subagent
 * seam. This is the host half of the plugin; commands, tools, and the web
 * panel consume this service.
 * @module dsh-ace-harness/service
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { assertObjectJsonSchema, type ObjectJsonSchema, type ToolRestriction } from '@deepseek-ai/dsh-tools'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { JobId, JobStart } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import '@deepseek-ai/dsh-user-questions'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'ace-workflow': 'ace-workflow'
  }
}
import {
  loadBuiltinAgents,
  loadBuiltinTemplates,
  readBuiltinTemplateSources,
  type BuiltinWorkflowTemplate,
} from './catalog/index.js'
import { parseWorkflowYaml, summarizeWorkflow, validateWorkflowReferences, type WorkflowSummary } from './dsl/load.js'
import type { AgentDefinition, StepVerdict, WorkflowConfig } from './dsl/types.js'
import { extractVerdict, normalizeVerdict } from './dsl/verdict.js'
import { buildStepPrompt, buildSupervisorPrompt, SUMMARY_BUDGET, truncate } from './engine/prompts.js'
import { runPreCommands } from './engine/pre-commands.js'
import { foldAssistantText, type StreamEventLike } from './engine/stream-fold.js'
import { createRunState, runStateMachine } from './engine/runner.js'
import { EngineError, type EngineRunOptions, type RunResult, type RunState, type StepExecutor } from './engine/types.js'
import { captureGitSnapshot, saveGitSnapshot } from './store/git-baseline.js'
import { appendExperience, loadRecentExperience, renderExperience } from './store/experience.js'
import { workspaceRoot } from './store/paths.js'
import { appendAudit, listRunStates, loadRunState, saveRunState } from './store/run-store.js'
import { deleteWorkflow, listWorkflows, loadWorkflow, saveWorkflow, type WorkflowEntry } from './store/workflow-store.js'
import {
  instantiateTemplate as bindTemplate,
  type AgentSubstitutions,
  type InstantiatedWorkflow,
  type TemplateParameterValues,
} from './templates/instantiate.js'

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
}

/** Verdict JSON schema enforced on judge steps when the provider supports it. */
const VERDICT_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'conditional_pass', 'fail'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['design', 'implementation', 'test', 'performance', 'security'],
          },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          description: { type: 'string' },
        },
        required: ['type', 'severity', 'description'],
      },
    },
    rationale: { type: 'string' },
  },
  required: ['verdict'],
}
assertObjectJsonSchema(VERDICT_OUTPUT_SCHEMA)

/** Supervisor score schema enforced when the provider supports structured output. */
const SCORE_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    score: { type: 'number' },
    advice: { type: 'string' },
  },
  required: ['score', 'advice'],
}
assertObjectJsonSchema(SCORE_OUTPUT_SCHEMA)

/** Extract a `<supervisor-score>{…}</supervisor-score>` payload from text. */
function extractScore(text: string): { score: number | null; advice: string } {
  const tag = /<supervisor-score>([\s\S]*?)<\/supervisor-score>/i.exec(text)
  if (tag?.[1]) {
    try {
      const parsed = JSON.parse(tag[1]) as { score?: unknown; advice?: unknown }
      const raw = typeof parsed.score === 'number' ? parsed.score : NaN
      const score = Number.isFinite(raw) ? Math.min(10, Math.max(1, Math.round(raw))) : null
      return { score, advice: typeof parsed.advice === 'string' ? parsed.advice : text }
    } catch {
      // Fall through to whole-text handling.
    }
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  if (fenced?.[1]) {
    try {
      const parsed = JSON.parse(fenced[1]) as { score?: unknown; advice?: unknown }
      const raw = typeof parsed.score === 'number' ? parsed.score : NaN
      if (Number.isFinite(raw)) {
        const score = Math.min(10, Math.max(1, Math.round(raw)))
        return { score, advice: typeof parsed.advice === 'string' ? parsed.advice : text }
      }
    } catch {
      // Not JSON; keep the text as advice.
    }
  }
  return { score: null, advice: text }
}

/** ACE catalog tool names mapped onto DSH tool names (candidates in order). */
const ACE_TOOL_MAP: Record<string, readonly string[]> = {
  Bash: ['bash', 'pwsh'],
  Read: ['read'],
  Write: ['write'],
  Edit: ['edit'],
  Glob: ['glob', 'grep'],
  Grep: ['grep', 'glob'],
  WebSearch: ['web_search'],
  WebFetch: ['web_fetch'],
}

/**
 * Translate an ACE agent's allowedTools roster into a DSH tool allow-list.
 * Each ACE name resolves to the first DSH candidate that `isAvailable`
 * reports — deployments differ, e.g. Windows profiles register `pwsh`
 * instead of `bash`. Unmapped or unavailable names are skipped; an empty
 * result means no filter.
 */
export function toolFilterFor(
  allowedTools: readonly string[] | undefined,
  isAvailable: (name: string) => boolean = () => true,
): ToolRestriction | undefined {
  if (!allowedTools || allowedTools.length === 0) return undefined
  const allow = new Set<string>()
  for (const name of allowedTools) {
    const candidates = ACE_TOOL_MAP[name]
    if (!candidates) continue
    const resolved = candidates.find(isAvailable)
    if (resolved) allow.add(resolved)
  }
  return allow.size > 0 ? { allow: [...allow] } : undefined
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

/** A started run: its id, optional DSH job id, and its terminal result. */
export interface AceRunHandle {
  runId: string
  jobId?: JobId
  result: Promise<RunResult>
}

/** How a run executes: awaited by the caller or detached as a DSH job. */
export type RunMode = 'foreground' | 'job'

/** Live streaming projection of one run, polled by the web panel. */
export interface RunStreamSnapshot {
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
}

/** Live streaming state for one run, updated by the step executor. */
interface RunStreamState extends RunStreamSnapshot {
  /** Child session being folded; null when no step is executing. */
  childSessionId: string | null
  /** Next event index for the transcript fold. */
  foldIndex: number
  /** Prune timer after settlement. */
  pruneTimer?: ReturnType<typeof setTimeout>
}

/** Extract plain text from LLM content blocks. */
function toText(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim()
}

export default class AceHarnessService extends Service {
  private readonly config: Required<AceHarnessConfig>
  private agents: AgentDefinition[] = []
  private templates: BuiltinWorkflowTemplate[] = []
  private readonly catalogReady: Promise<void>
  private readonly active = new Map<string, AbortController>()
  private readonly streams = new Map<string, RunStreamState>()

  constructor(ctx: Context, config: AceHarnessConfig = {}) {
    super(ctx, 'ace-harness')
    this.config = {
      subagentProvider: config.subagentProvider ?? 'spawn',
      model: config.model ?? '',
      runDirName: config.runDirName ?? '.ace-workflows',
      maxSubworkflowDepth: config.maxSubworkflowDepth ?? 8,
      maxConcurrentRuns: config.maxConcurrentRuns ?? 4,
      preCommandTimeoutMs: config.preCommandTimeoutMs ?? 300_000,
      stepTimeoutMs: config.stepTimeoutMs ?? 1_800_000,
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
      : candidates[candidates.length - 1]
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
    if (this.active.size >= this.config.maxConcurrentRuns) {
      throw new Error(`并发运行数达到上限 ${this.config.maxConcurrentRuns}`)
    }
    const workspace = this.workspaceOf(input.parent)
    const runId = `run-${Date.now()}-${randomSuffix()}`
    const controller = new AbortController()
    const linked = new AbortController()
    const onAbort = (): void => linked.abort()
    input.signal.addEventListener('abort', onAbort, { once: true })
    controller.signal.addEventListener('abort', onAbort, { once: true })
    this.active.set(runId, controller)

    const state = createRunState({
      runId,
      workflowName: input.workflow.config.workflow.name,
      configFile: input.workflow.configFile,
      config: input.workflow.config,
      inputs: input.inputs ?? {},
      parentSessionId: input.parent.session.id,
    })

    // Live streaming projection for the web panel.
    this.streams.set(runId, {
      runId,
      workflowName: input.workflow.config.workflow.name,
      status: 'preparing',
      currentState: '',
      currentStep: null,
      agent: null,
      role: null,
      text: '',
      seq: 0,
      completedSteps: 0,
      totalSteps: state.totalSteps,
      states: input.workflow.config.workflow.states.map((machineState) => ({
        name: machineState.name,
        isInitial: machineState.isInitial,
        isFinal: machineState.isFinal,
        position: machineState.position ?? null,
      })),
      transitions: input.workflow.config.workflow.states.flatMap((machineState) =>
        machineState.transitions.map((transition) => ({
          from: machineState.name,
          to: transition.to,
          verdict: transition.condition.verdict ?? null,
          label: transition.label ?? null,
        })),
      ),
      verdicts: [],
      childSessionId: null,
      foldIndex: 0,
    })

    const executor = this.makeExecutor(workspace, input.parent, runId, 1)
    const options = this.engineOptions(
      workspace,
      input.parent,
      input.workflow,
      runId,
      executor,
      linked.signal,
      () => loadRunState(workspace, runId, this.config.runDirName),
      input.inputs ?? {},
    )

    this.ctx.emit('ace/workflow-start', { runId, workflowName: input.workflow.config.workflow.name })
    await appendAudit(workspace, runId, this.config.runDirName, {
      at: state.startedAt,
      event: 'start',
      workflow: input.workflow.config.workflow.name,
    })

    // Git baseline snapshot when the workflow runs against a repository.
    const projectRoot = input.workflow.config.context?.projectRoot
    if (projectRoot && input.workflow.config.context?.gitBaselineEnabled !== false) {
      const snapshot = await captureGitSnapshot(projectRoot)
      await saveGitSnapshot(workspace, runId, this.config.runDirName, 'baseline', null, snapshot)
    }

    const begin = this.beginRun(workspace, runId, options)
    if (input.mode === 'job') {
      return { runId, ...this.detachAsJob(runId, input.parent, controller, begin, input.workflow.config.workflow.name) }
    }
    return { runId, result: begin() }
  }

  /** Resume a persisted run (authorized by its recorded parent session). */
  async resumeRun(input: {
    parent: Agent
    signal: AbortSignal
    runId: string
    mode?: RunMode
  }): Promise<AceRunHandle> {
    const workspace = this.workspaceOf(input.parent)
    const persisted = await loadRunState(workspace, input.runId, this.config.runDirName)
    if (!persisted) throw new Error(`未找到运行 ${input.runId}`)
    if (persisted.parentSessionId !== input.parent.session.id) {
      throw new Error('只有启动该运行的会话才能恢复它')
    }
    if (this.active.has(input.runId)) {
      throw new Error(`运行 ${input.runId} 正在执行中`)
    }
    const workflow = await this.resolveWorkflowConfig(workspace, persisted.configFile)
    if (!workflow) throw new Error(`运行 ${input.runId} 引用的 workflow「${persisted.configFile}」不存在`)
    const controller = new AbortController()
    const linked = new AbortController()
    const onAbort = (): void => linked.abort()
    input.signal.addEventListener('abort', onAbort, { once: true })
    controller.signal.addEventListener('abort', onAbort, { once: true })
    this.active.set(input.runId, controller)
    const executor = this.makeExecutor(workspace, input.parent, input.runId, 1)
    const options = this.engineOptions(
      workspace,
      input.parent,
      { config: workflow.config, configFile: workflow.file },
      input.runId,
      executor,
      linked.signal,
      () => loadRunState(workspace, input.runId, this.config.runDirName),
      {},
    )
    const begin = this.beginRun(workspace, input.runId, options)
    if (input.mode === 'job') {
      return { runId: input.runId, ...this.detachAsJob(input.runId, input.parent, controller, begin, persisted.workflowName) }
    }
    return { runId: input.runId, result: begin() }
  }

  /** Wrap the engine promise chain: end event, audit row, registry cleanup. */
  private beginRun(
    workspace: string,
    runId: string,
    options: EngineRunOptions,
  ): () => Promise<RunResult> {
    return () =>
      runStateMachine(options)
        .then(async (runResult) => {
          this.ctx.emit('ace/workflow-end', { runId, status: runResult.status })
          const stream = this.streams.get(runId)
          if (stream) {
            stream.status = runResult.status
            stream.currentStep = null
            stream.agent = null
            stream.role = null
            stream.seq += 1
            stream.pruneTimer = setTimeout(() => {
              this.streams.delete(runId)
            }, 10 * 60_000)
            stream.pruneTimer.unref?.()
          }
          await appendAudit(workspace, runId, this.config.runDirName, {
            at: new Date().toISOString(),
            event: 'end',
            status: runResult.status,
            error: runResult.error,
          })
          return runResult
        })
        .finally(() => {
          this.active.delete(runId)
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
    const jobRegistry = this.ctx.get('jobs') as JobRegistryFace | undefined
    if (!jobRegistry) {
      controller.abort()
      throw new Error('当前 profile 未挂载 jobs 服务，无法以后台 job 方式运行')
    }
    let resolveResult!: (value: RunResult) => void
    let rejectResult!: (reason: unknown) => void
    const result = new Promise<RunResult>((resolvePromise, rejectPromise) => {
      resolveResult = resolvePromise
      rejectResult = rejectPromise
    })
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
          done: runResult.then((settled) => jobOutcomeFor(settled)),
        }
      },
    })
    return { jobId, result }
  }

  /** Cancel an active run. Returns false when the run is not active. */
  stopRun(runId: string): boolean {
    const controller = this.active.get(runId)
    if (!controller) return false
    controller.abort()
    return true
  }

  /** Whether a run id is currently executing. */
  isActive(runId: string): boolean {
    return this.active.has(runId)
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
    const entry = this.streams.get(runId)
    if (!entry) return undefined
    return {
      runId: entry.runId,
      workflowName: entry.workflowName,
      status: entry.status,
      currentState: entry.currentState,
      currentStep: entry.currentStep,
      agent: entry.agent,
      role: entry.role,
      text: entry.text,
      seq: entry.seq,
      completedSteps: entry.completedSteps,
      totalSteps: entry.totalSteps,
      states: entry.states,
      transitions: entry.transitions,
      verdicts: entry.verdicts,
    }
  }

  /**
   * Run a workflow through the HTTP API with a synthetic parent bound to the
   * given workspace. Script-only workflows run fully without credentials;
   * steps that spawn subagents fail loudly because the synthetic parent is
   * not a live agent — use the chat command/tool for AI workflows.
   */
  async runApi(input: {
    workspace: string
    workflowRef: string
    values: Record<string, string>
  }): Promise<AceRunHandle> {
    const instance = await loadWorkflow(input.workspace, input.workflowRef)
    let workflow: { config: WorkflowConfig; configFile: string }
    if (instance) {
      workflow = { config: instance.config, configFile: instance.file }
    } else {
      await this.catalogReady
      const template = [...this.templates]
        .filter((candidate) => candidate.id === input.workflowRef)
        .sort((a, b) => a.version.localeCompare(b.version))
        .at(-1)
      if (!template) throw new Error(`未找到 workflow 实例或模板「${input.workflowRef}」`)
      const instantiated = await this.instantiate(input.workflowRef, undefined, input.values, {})
      workflow = { config: instantiated.config, configFile: input.workflowRef }
    }
    const parent = {
      id: 'api-runner' as unknown as SessionId,
      session: { header: { cwd: input.workspace } },
    } as unknown as Agent
    return this.startRun({
      parent,
      signal: new AbortController().signal,
      workflow,
      inputs: input.values,
      mode: 'foreground',
    })
  }

  /** The workspace root the service uses for one agent. */
  workspaceOf(agent: Agent): string {
    return workspaceRoot(agent.session.header.cwd, process.cwd())
  }

  private engineOptions(
    workspace: string,
    parent: Agent,
    workflow: { config: WorkflowConfig; configFile: string },
    runId: string,
    executor: StepExecutor,
    signal: AbortSignal,
    load: () => Promise<RunState | null>,
    inputs: Record<string, string>,
  ): EngineRunOptions {
    const persist = async (runState: RunState): Promise<void> => {
      await saveRunState(workspace, runState, this.config.runDirName)
      const stream = this.streams.get(runId)
      if (stream) {
        stream.status = runState.status
        stream.currentState = runState.currentState ?? ''
        stream.completedSteps = runState.completedSteps
        stream.totalSteps = runState.totalSteps
        stream.verdicts = runState.stateOutcomes.map((outcome) => ({
          state: outcome.state,
          verdict: outcome.verdict.verdict,
        }))
        stream.seq += 1
      }
      this.ctx.emit('ace/run-updated', {
        runId: runState.id,
        status: runState.status,
        currentState: runState.currentState,
        completedSteps: runState.completedSteps,
        totalSteps: runState.totalSteps,
      })
    }
    return {
      config: workflow.config,
      runId,
      configFile: workflow.configFile,
      inputs,
      parent,
      signal,
      executor,
      persist,
      load,
      resolveSubworkflow: async (configFile: string) => {
        const resolved = await this.resolveWorkflowConfig(workspace, configFile)
        if (!resolved) throw new EngineError(`子工作流「${configFile}」不存在`, 'NO_MATCH')
        return resolved.config
      },
      askHumanTransition: async ({ state, candidates, signal: askSignal }) => {
        const answer = await this.ctx.userQuestions.ask({
          questions: [
            {
              id: 'transition',
              header: '工作流决策',
              question: `工作流在状态「${state}」暂停，请选择下一步：`,
              options: candidates.map((candidate) => ({ label: candidate })),
            },
          ],
          agent: parent,
          signal: askSignal,
        })
        return answer.answers[0]?.selected[0] ?? ''
      },
    }
  }

  /** Resolve a workflow reference: instance name, template id, or relative path. */
  private async resolveWorkflowConfig(
    workspace: string,
    configFile: string,
  ): Promise<{ config: WorkflowConfig; file: string } | null> {
    const instance = await loadWorkflow(workspace, configFile)
    if (instance) return { config: instance.config, file: instance.file }
    await this.catalogReady
    const template = this.templates.find((candidate) => candidate.id === configFile)
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
    const service = this
    return {
      async runAgentStep(input) {
        const agentDef = await service.agentByName(input.agentName)
        const systemPrompt = agentDef?.systemPrompt ?? ''
        const preOutput = await runPreCommands(
          input.preCommands,
          input.ctx.projectRoot,
          service.config.preCommandTimeoutMs,
          input.signal,
        )
        const promptText =
          (systemPrompt ? `## 角色设定\n${systemPrompt}\n\n` : '') +
          (preOutput !== '' ? `## 预命令输出\n${preOutput}\n\n` : '') +
          buildStepPrompt({
            role: input.role,
            task: input.task,
            constraints: input.constraints,
            ctx: input.ctx,
            evidence: input.evidence,
          })
        const provider = service.config.subagentProvider
        const providerCaps = service.ctx.subagents.getProvider(provider)?.capabilities
        const wantsSchema = input.role === 'judge' && providerCaps?.outputSchema === true
        const stepSignal = stepSignalWithTimeout(input.signal, service.config.stepTimeoutMs)
        const stream = service.streams.get(parentRunId)
        if (stream) {
          stream.currentState = input.ctx.state
          stream.currentStep = input.stepName
          stream.agent = input.agentName
          stream.role = input.role
          stream.text = ''
          stream.childSessionId = null
          stream.foldIndex = 0
          stream.seq += 1
        }
        const request: SubagentStartRequest = {
          label: `${input.ctx.state}/${input.stepName}`,
          prompt: [{ type: 'text', text: promptText }],
          parent: input.parent,
          signal: stepSignal.signal,
          agentOptions: service.config.model ? { model: service.config.model } : undefined,
          outputSchema: wantsSchema ? VERDICT_OUTPUT_SCHEMA : undefined,
          toolFilter:
            providerCaps?.toolFilter === true
              ? toolFilterFor(agentDef?.allowedTools, (name) => service.ctx.tools.get(name) !== undefined)
              : undefined,
        }
        service.ctx.emit('ace/step-start', {
          runId: parentRunId,
          state: input.ctx.state,
          step: input.stepName,
          role: input.role,
        })
        let run: Awaited<ReturnType<typeof service.ctx.subagents.start>> | undefined
        let poller: ReturnType<typeof setInterval> | undefined
        try {
          run = await service.ctx.subagents.start(provider, request)
          if (stream) {
            const childId = run.id
            stream.childSessionId = childId
            // Fold the child transcript into the live stream while it runs.
            poller = setInterval(() => {
              try {
                const entry = service.streams.get(parentRunId)
                if (!entry || entry.childSessionId !== childId) return
                const session = service.ctx.sessions.get(childId)
                if (!session) return
                const fold = foldAssistantText(
                  session.events as readonly StreamEventLike[],
                  entry.foldIndex,
                )
                entry.foldIndex = fold.index
                if (fold.text !== '') {
                  entry.text += fold.text
                  entry.seq += 1
                }
              } catch (error) {
                // A streaming poller failure must never take down the host.
                service.ctx.logger('ace-harness').debug(`stream poll failed: ${String(error)}`)
              }
            }, 800)
          }
          const childResult = await run.result
          if (stepSignal.timedOut()) {
            throw new Error(`步骤「${input.stepName}」执行超时（${service.config.stepTimeoutMs}ms）`)
          }
          const outputText = toText(childResult.output)
          const verdict =
            childResult.structured !== undefined
              ? normalizeVerdict(childResult.structured) ?? extractVerdict(outputText)
              : extractVerdict(outputText)
          const finalText = truncate(outputText || '(该步骤没有文本输出)', SUMMARY_BUDGET)
          if (stream) {
            stream.text = finalText
            stream.currentStep = null
            stream.agent = null
            stream.role = null
            stream.childSessionId = null
            stream.seq += 1
          }
          service.ctx.emit('ace/step-end', {
            runId: parentRunId,
            state: input.ctx.state,
            step: input.stepName,
            verdict: verdict?.verdict,
          })
          return {
            outputSummary: finalText,
            verdict,
          }
        } finally {
          if (poller !== undefined) clearInterval(poller)
          stepSignal.dispose()
          run?.dispose()
        }
      },
      async runSubworkflowStep(input) {
        if (depth >= service.config.maxSubworkflowDepth) {
          throw new EngineError(`子工作流嵌套深度超过上限 ${service.config.maxSubworkflowDepth}`, 'NO_MATCH')
        }
        const resolved = await service.resolveWorkflowConfig(workspace, input.configFile)
        if (!resolved) throw new EngineError(`子工作流「${input.configFile}」不存在`, 'NO_MATCH')
        const childRunId = `${parentRunId}.${sanitize(input.stepName)}`
        const childExecutor = service.makeExecutor(workspace, input.parent, childRunId, depth + 1)
        const childOptions = service.engineOptions(
          workspace,
          input.parent,
          { config: resolved.config, configFile: resolved.file },
          childRunId,
          childExecutor,
          input.signal,
          () => loadRunState(workspace, childRunId, service.config.runDirName),
          { requirements: input.inheritedRequirements },
        )
        const childResult = await runStateMachine(childOptions)
        const outcome =
          childResult.status === 'completed'
            ? 'completed'
            : childResult.status === 'stopped'
              ? 'stopped'
              : childResult.status === 'failed'
                ? 'failed'
                : 'crashed'
        const verdict: StepVerdict | undefined = childResult.verdict
          ? { verdict: childResult.verdict, issues: [], rationale: childResult.error ?? '' }
          : undefined
        return { outcome, verdict }
      },
      async supervisorAdvice(input) {
        const supervisorDef = await service.agentByName(input.supervisorName)
        if (!supervisorDef) return null
        const experience = await loadRecentExperience(workspace, service.config.runDirName, 5)
        const promptText =
          `## 角色设定\n${supervisorDef.systemPrompt}\n\n` +
          buildSupervisorPrompt({
            state: input.ctx.state,
            requirements: input.ctx.requirements,
            stateOutcome: input.stateOutcome,
            experience: renderExperience(experience),
            scoringEnabled: true,
          })
        const providerCaps = service.ctx.subagents.getProvider(service.config.subagentProvider)?.capabilities
        const wantsSchema = providerCaps?.outputSchema === true
        const stepSignal = stepSignalWithTimeout(input.signal, service.config.stepTimeoutMs)
        let run: Awaited<ReturnType<typeof service.ctx.subagents.start>> | undefined
        try {
          run = await service.ctx.subagents.start(service.config.subagentProvider, {
            label: `${input.ctx.state}/supervisor-checkpoint`,
            prompt: [{ type: 'text', text: promptText }],
            parent: input.parent,
            signal: stepSignal.signal,
            agentOptions: service.config.model ? { model: service.config.model } : undefined,
            outputSchema: wantsSchema ? SCORE_OUTPUT_SCHEMA : undefined,
          })
          const childResult = await run.result
          if (stepSignal.timedOut()) {
            throw new Error(`supervisor 检查点执行超时（${service.config.stepTimeoutMs}ms）`)
          }
          const text = toText(childResult.output)
          let score: number | null = null
          let advice = truncate(text, SUMMARY_BUDGET)
          if (childResult.structured !== undefined) {
            const structured = childResult.structured as { score?: unknown; advice?: unknown }
            const raw = typeof structured.score === 'number' ? structured.score : NaN
            score = Number.isFinite(raw) ? Math.min(10, Math.max(1, Math.round(raw))) : null
            advice =
              typeof structured.advice === 'string' && structured.advice.trim() !== ''
                ? truncate(structured.advice, SUMMARY_BUDGET)
                : advice
          } else {
            const extracted = extractScore(text)
            score = extracted.score
            advice = truncate(extracted.advice || '(无检查点结论)', SUMMARY_BUDGET)
          }
          const entry = {
            workflowName: input.workflowName,
            state: input.ctx.state,
            score,
            advice,
            at: new Date().toISOString(),
          }
          await appendExperience(workspace, service.config.runDirName, entry).catch(() => {
            // Experience persistence is best-effort; it must not fail the run.
          })
          return { advice, score }
        } finally {
          stepSignal.dispose()
          run?.dispose()
        }
      },
    }
  }
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10)
}

/** Structural face of the jobs registry (resolved lazily through the store). */
interface JobRegistryFace {
  start(spec: JobStart): JobId
}

/**
 * Derive a step-scoped signal from the caller signal plus a wall-clock
 * timeout. The returned signal aborts the child on either event; `timedOut`
 * reports whether the timeout — rather than the caller — fired.
 */
export function stepSignalWithTimeout(
  caller: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController()
  let timedOut = false
  const onCallerAbort = (): void => controller.abort()
  caller.addEventListener('abort', onCallerAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer.unref?.()
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer)
      caller.removeEventListener('abort', onCallerAbort)
    },
  }
}

/** Structural terminal outcome returned to the jobs registry. */
export interface JobOutcomeLike {
  status: 'completed' | 'killed' | 'failed'
  detail?: string
  output?: string
}

/** Project a settled run onto the jobs registry's terminal outcome. */
export function jobOutcomeFor(result: RunResult): JobOutcomeLike {
  return {
    status:
      result.status === 'completed' ? 'completed' : result.status === 'stopped' ? 'killed' : 'failed',
    detail: result.verdict ?? result.error ?? undefined,
    output: summarizeRunForJob(result),
  }
}

/** One-line summary of a settled run for the job's final output. */
function summarizeRunForJob(result: RunResult): string {
  const lines = result.stateOutcomes.map((outcome) => `${outcome.state}→${outcome.verdict.verdict}`)
  const verdict = result.verdict ? ` · 最终结论 ${result.verdict}` : ''
  return `运行 ${result.runId} ${result.status}${verdict}：${lines.join(', ') || '无状态'}${
    result.error ? ` · 错误: ${result.error}` : ''
  }`
}
