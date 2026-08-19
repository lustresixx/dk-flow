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
import { assertObjectJsonSchema, type ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import '@deepseek-ai/dsh-user-questions'
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
import { createRunState, runStateMachine } from './engine/runner.js'
import { EngineError, type EngineRunOptions, type RunResult, type RunState, type StepExecutor } from './engine/types.js'
import { captureGitSnapshot, saveGitSnapshot } from './store/git-baseline.js'
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

/** A started run: its id and the promise of its terminal result. */
export interface AceRunHandle {
  runId: string
  result: Promise<RunResult>
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

  constructor(ctx: Context, config: AceHarnessConfig = {}) {
    super(ctx, 'ace-harness')
    this.config = {
      subagentProvider: config.subagentProvider ?? 'spawn',
      model: config.model ?? '',
      runDirName: config.runDirName ?? '.ace-workflows',
      maxSubworkflowDepth: config.maxSubworkflowDepth ?? 8,
      maxConcurrentRuns: config.maxConcurrentRuns ?? 4,
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
   */
  async startRun(input: {
    parent: Agent
    signal: AbortSignal
    workflow: { config: WorkflowConfig; configFile: string }
    inputs?: Record<string, string>
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

    const executor = this.makeExecutor(workspace, input.parent, runId, 1)
    const options = this.engineOptions(
      workspace,
      input.parent,
      input.workflow,
      runId,
      executor,
      linked.signal,
      () => loadRunState(workspace, runId, this.config.runDirName),
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

    const result = runStateMachine(options)
      .then(async (runResult) => {
        this.ctx.emit('ace/workflow-end', { runId, status: runResult.status })
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
    return { runId, result }
  }

  /** Resume a persisted run (authorized by its recorded parent session). */
  async resumeRun(input: { parent: Agent; signal: AbortSignal; runId: string }): Promise<AceRunHandle> {
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
    )
    const result = runStateMachine(options)
      .then(async (runResult) => {
        this.ctx.emit('ace/workflow-end', { runId: input.runId, status: runResult.status })
        await appendAudit(workspace, input.runId, this.config.runDirName, {
          at: new Date().toISOString(),
          event: 'end',
          status: runResult.status,
          error: runResult.error,
        })
        return runResult
      })
      .finally(() => {
        this.active.delete(input.runId)
      })
    return { runId: input.runId, result }
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
  ): EngineRunOptions {
    const persist = async (runState: RunState): Promise<void> => {
      await saveRunState(workspace, runState, this.config.runDirName)
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
      inputs: {},
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
        const promptText =
          (systemPrompt ? `## 角色设定\n${systemPrompt}\n\n` : '') +
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
        const request: SubagentStartRequest = {
          label: `${input.ctx.state}/${input.stepName}`,
          prompt: [{ type: 'text', text: promptText }],
          parent: input.parent,
          signal: input.signal,
          agentOptions: service.config.model ? { model: service.config.model } : undefined,
          outputSchema: wantsSchema ? VERDICT_OUTPUT_SCHEMA : undefined,
        }
        service.ctx.emit('ace/step-start', {
          runId: parentRunId,
          state: input.ctx.state,
          step: input.stepName,
          role: input.role,
        })
        const run = await service.ctx.subagents.start(provider, request)
        try {
          const childResult = await run.result
          const outputText = toText(childResult.output)
          const verdict =
            childResult.structured !== undefined
              ? normalizeVerdict(childResult.structured) ?? extractVerdict(outputText)
              : extractVerdict(outputText)
          service.ctx.emit('ace/step-end', {
            runId: parentRunId,
            state: input.ctx.state,
            step: input.stepName,
            verdict: verdict?.verdict,
          })
          return {
            outputSummary: truncate(outputText || '(该步骤没有文本输出)', SUMMARY_BUDGET),
            verdict,
          }
        } finally {
          run.dispose()
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
        const promptText =
          `## 角色设定\n${supervisorDef.systemPrompt}\n\n` +
          buildSupervisorPrompt({
            state: input.ctx.state,
            requirements: input.ctx.requirements,
            stateOutcome: input.stateOutcome,
          })
        const run = await service.ctx.subagents.start(service.config.subagentProvider, {
          label: `${input.ctx.state}/supervisor-checkpoint`,
          prompt: [{ type: 'text', text: promptText }],
          parent: input.parent,
          signal: input.signal,
          agentOptions: service.config.model ? { model: service.config.model } : undefined,
        })
        try {
          const childResult = await run.result
          const text = toText(childResult.output)
          return text === '' ? null : truncate(text, SUMMARY_BUDGET)
        } finally {
          run.dispose()
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
