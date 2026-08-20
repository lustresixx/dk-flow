/**
 * The ACE harness service: built-in agent catalog, workflow templates,
 * workflow instances, and state-machine runs executed over the DSH subagent
 * seam. This is the host half of the plugin; commands, tools, and the web
 * panel consume this service.
 * @module dsh-ace-harness/service
 */
import { mkdirSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
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
  firstCommentLine,
  listBuiltinScripts,
  loadBuiltinAgents,
  loadBuiltinTemplates,
  readBuiltinTemplateSources,
  type BuiltinWorkflowTemplate,
} from './catalog/index.js'
import { parseWorkflowYaml, summarizeWorkflow, validateWorkflowReferences, type WorkflowSummary } from './dsl/load.js'
import type { AgentDefinition, StateMachineState, StepType, StepVerdict, WorkflowConfig, WorkflowStep } from './dsl/types.js'
import { extractVerdict, normalizeVerdict } from './dsl/verdict.js'
import { buildStepEvidence, buildStepPrompt, buildSupervisorPrompt, SUMMARY_BUDGET, truncate } from './engine/prompts.js'
import { evaluateTransitions, joinSegment, segmentSteps } from './engine/transitions.js'
import { runPreCommands } from './engine/pre-commands.js'
import { foldAssistantText, type StreamEventLike } from './engine/stream-fold.js'
import { createRunState, runStateMachine } from './engine/runner.js'
import { EngineError, type EngineRunOptions, type RunResult, type RunState, type StepContext, type StepExecutor, type StepOutcome } from './engine/types.js'
import { runScriptFile } from './engine/script-file-runner.js'
import { runScriptNode } from './engine/script-runner.js'
import { captureGitSnapshot, saveGitSnapshot } from './store/git-baseline.js'
import { appendExperience, loadRecentExperience, renderExperience } from './store/experience.js'
import { workspaceRoot } from './store/paths.js'
import { appendAudit, listRunStates, loadRunState, saveRunState } from './store/run-store.js'
import { EMPTY_PROGRESS_TRACK, progressAuditEvents, runDurationMs, sha256Text, type RunProgressTrack } from './store/audit-events.js'
import { SqliteArchive, type ArchivedAuditRow, type ArchivedRunRow } from './store/sqlite-archive.js'
import { aggregateRunStats, combineStatsProjection, type WorkspaceRunStats } from './store/run-stats.js'
import { readWorkspaceSettings, writeWorkspaceSettings } from './store/workspace-settings.js'
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
  /** Command used to launch Python for `.py` scriptFile steps (default `python`). */
  pythonCommand?: string
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
  /** Completed states' actual output heads — the data flowing forward. */
  stateOutputs: { state: string; verdict: string; output: string }[]
  /** Per-step streaming log: the current entry grows live. */
  stepLog: {
    key: string
    state: string
    step: string
    type: 'agent' | 'script' | 'subworkflow' | 'llm'
    agent: string | null
    role: string | null
    text: string
    finished: boolean
  }[]
}

/** Live streaming state for one run, updated by the step executor. */
interface RunStreamState extends RunStreamSnapshot {
  /** Child session being folded; null when no step is executing. */
  childSessionId: string | null
  /** Next event index for the transcript fold. */
  foldIndex: number
  /** Prune timer after settlement. */
  pruneTimer?: ReturnType<typeof setTimeout>
  /** Index of the stepLog entry currently being streamed. */
  stepLogIndex: number
}

/** Extract plain text from LLM content blocks. */
function toText(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim()
}

/** One script discoverable by `/workflow scripts`. */
export interface WorkflowScriptEntry {
  name: string
  source: 'builtin' | 'workspace'
  description: string
}

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
  private readonly active = new Map<string, AbortController>()
  private readonly streams = new Map<string, RunStreamState>()
  private readonly archive = new SqliteArchive()
  /** Audit enrichment cursors: per-run position for state-end diffing. */
  private readonly progressTrack = new Map<string, RunProgressTrack>()

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
      pythonCommand: config.pythonCommand ?? 'python',
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
    const executor = this.makeExecutor(input.workspace, (input.parent ?? { options: {} }) as Agent, `test-${Date.now()}`, 1)
    return this.executeTestStep({
      machineState,
      step,
      executor,
      parent: input.parent,
      signal: input.signal,
      timeoutMs: step.timeoutMinutes !== undefined ? step.timeoutMinutes * 60_000 : undefined,
      sandboxDir,
      workspace: input.workspace,
      stepContext: {
        state: machineState.name,
        stateDescription: machineState.description ?? '',
        requirements,
        projectRoot: input.config.context?.projectRoot,
        priorStateEvidence: '',
        priorStepEvidence: '（无本状态前置步骤产出）',
        stepData: {},
      },
      scriptInput: {
        requirements,
        state: machineState.name,
        priorStepEvidence: '',
        priorStateEvidence: '',
        inputs: input.values,
        stepData: {},
      },
    })
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
    if (machineState.reviewPolicy?.mode === 'adversarial') {
      notes.push('对抗评审（reviewPolicy: adversarial）在独立验证中不展开，按声明的步骤原样执行')
    }
    if (machineState.steps.some((step) => step.parallelGroup)) {
      notes.push('并行组在独立验证中按声明顺序串行执行（真实运行为并发）')
    }
    const requirements = input.values.requirements ?? input.config.context?.requirements ?? ''
    const sandboxDir = join(input.workspace, this.config.runDirName, 'test-sandbox')
    if (machineState.steps.some((step) => (step.type ?? 'agent') === 'script')) this.ensureTestSandbox(sandboxDir)
    const executor = this.makeExecutor(input.workspace, (input.parent ?? { options: {} }) as Agent, `test-${Date.now()}`, 1)
    const completed: StepOutcome[] = []
    const collectData = (): Record<string, unknown> => {
      const collected: Record<string, unknown> = {}
      for (const outcome of completed) {
        if (outcome.data !== undefined) collected[`${outcome.state}/${outcome.step}`] = outcome.data
      }
      return collected
    }
    for (const step of machineState.steps) {
      const type: StepType = step.type ?? 'agent'
      try {
        const outcome = await this.executeTestStep({
          machineState,
          step,
          executor,
          parent: input.parent,
          signal: input.signal,
          timeoutMs: step.timeoutMinutes !== undefined ? step.timeoutMinutes * 60_000 : undefined,
          sandboxDir,
          workspace: input.workspace,
          stepContext: {
            state: machineState.name,
            stateDescription: machineState.description ?? '',
            requirements,
            projectRoot: input.config.context?.projectRoot,
            priorStateEvidence: '',
            priorStepEvidence: buildStepEvidence(completed),
            stepData: collectData(),
          },
          scriptInput: {
            requirements,
            state: machineState.name,
            priorStepEvidence: buildStepEvidence(completed),
            priorStateEvidence: '',
            inputs: input.values,
            stepData: collectData(),
          },
        })
        const now = new Date().toISOString()
        completed.push({
          key: `${machineState.name}/${step.name}`,
          state: machineState.name,
          step: step.name,
          type,
          role: type === 'script' ? 'neutral' : (step.role ?? 'neutral'),
          outputSummary: outcome.outputSummary,
          ...(outcome.verdict ? { verdict: outcome.verdict } : {}),
          ...(outcome.data !== undefined ? { data: outcome.data } : {}),
          startedAt: now,
          finishedAt: now,
        })
        result.steps.push({ step: step.name, type, verdict: outcome.verdict, outputSummary: outcome.outputSummary })
      } catch (error) {
        const message = (error as Error).message
        result.steps.push({ step: step.name, type, verdict: null, outputSummary: `执行出错：${message}` })
        result.error = `步骤「${step.name}」执行出错，后续步骤未执行：${message}`
        return result
      }
    }
    // Mirror executeState: the last segment's verdict, joined by state policy.
    const segments = segmentSteps(machineState.steps)
    const lastSegment = segments[segments.length - 1]!
    const lastOutcomes = completed.filter((step) => lastSegment.steps.includes(step.step))
    const pass: StepVerdict = { verdict: 'pass', issues: [], rationale: '' }
    const joined = joinSegment(lastOutcomes.map((step) => step.verdict ?? pass), machineState.joinPolicy ?? { mode: 'all' }) ?? pass
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

  /** Execute one step for an isolated test (shared by testStep/testState). */
  private async executeTestStep(input: {
    machineState: StateMachineState
    step: WorkflowStep
    executor: StepExecutor
    parent: Agent | undefined
    signal: AbortSignal
    timeoutMs: number | undefined
    sandboxDir: string
    workspace: string
    stepContext: StepContext
    scriptInput: {
      requirements: string
      state: string
      priorStepEvidence: string
      priorStateEvidence: string
      inputs: Record<string, string>
      stepData: Record<string, unknown>
    }
  }): Promise<TestStepResult> {
    const { machineState, step } = input
    const type: StepType = step.type ?? 'agent'
    const role = step.role ?? 'neutral'
    if (type === 'script') {
      this.ensureTestSandbox(input.sandboxDir)
      const result =
        step.scriptFile?.trim() !== undefined && step.scriptFile.trim() !== ''
          ? await runScriptFile(step.scriptFile.trim(), input.scriptInput, {
              projectRoot: input.stepContext.projectRoot,
              scriptsHome: join(input.workspace, this.config.runDirName, 'scripts'),
              pythonCommand: this.config.pythonCommand,
              timeoutMs: input.timeoutMs,
              sandboxDir: input.sandboxDir,
              signal: input.signal,
            })
          : await runScriptNode(step.script ?? '', input.scriptInput, { timeoutMs: input.timeoutMs, signal: input.signal })
      return {
        state: machineState.name,
        step: step.name,
        type,
        outputSummary: result.output,
        verdict: result.success
          ? { verdict: 'success', issues: [], rationale: result.output }
          : { verdict: 'fail', issues: [], rationale: result.error ?? result.output },
        data: result.data,
      }
    }
    if (type === 'llm') {
      // The bare llm call only reads `parent.options` for routing defaults.
      const parent = (input.parent ?? { options: {} }) as Agent
      const result = await input.executor.runLlmStep({
        stepName: step.name,
        role,
        task: step.task ?? '',
        agentName: step.agent,
        constraints: step.constraints ?? [],
        model: step.model,
        ctx: input.stepContext,
        parent,
        signal: input.signal,
        timeoutMs: input.timeoutMs,
      })
      return {
        state: machineState.name,
        step: step.name,
        type,
        outputSummary: result.outputSummary,
        verdict: result.verdict ?? null,
        data: undefined,
      }
    }
    if (!input.parent) {
      throw new Error(
        `「${type}」步骤的独立验证需要会话上下文：请在会话中用 /workflow test <工作流> ${machineState.name} ${step.name} 验证`,
      )
    }
    if (type === 'agent') {
      const result = await input.executor.runAgentStep({
        stepName: step.name,
        agentName: step.agent ?? '',
        agentSystemPrompt: '',
        role,
        task: step.task ?? '',
        constraints: step.constraints ?? [],
        preCommands: step.preCommands ?? [],
        ctx: input.stepContext,
        parent: input.parent,
        signal: input.signal,
        timeoutMs: input.timeoutMs,
      })
      return {
        state: machineState.name,
        step: step.name,
        type,
        outputSummary: result.outputSummary,
        verdict: result.verdict ?? null,
        data: undefined,
      }
    }
    const configFile = step.workflow?.trim() || step.subworkflow?.configFile?.trim() || ''
    const child = await input.executor.runSubworkflowStep({
      stepName: step.name,
      configFile,
      parent: input.parent,
      signal: input.signal,
      inheritedRequirements: input.stepContext.requirements,
    })
    return {
      state: machineState.name,
      step: step.name,
      type,
      outputSummary: child.verdict?.rationale ?? `子工作流结束：${child.outcome}`,
      verdict: child.verdict ?? null,
      data: undefined,
    }
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
    const onStop = (): void => linked.abort()
    // Only the run's own controller stops it; the calling turn's abort signal
    // detaches foreground runs to a job instead (see below).
    controller.signal.addEventListener('abort', onStop, { once: true })
    this.active.set(runId, controller)
    this.ensureSandboxDir(workspace, runId)

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
      stateOutputs: [],
      stepLog: [],
      childSessionId: null,
      foldIndex: 0,
      stepLogIndex: -1,
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
    await this.writeAudit(workspace, runId, {
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
      await saveGitSnapshot(workspace, runId, this.config.runDirName, 'baseline', null, snapshot)
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
    const result = new Promise<RunResult>((resolvePromise, rejectPromise) => {
      resolveResult = resolvePromise
      rejectResult = rejectPromise
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
    const detach = (): void => {
      if (settled) return
      if (this.streams.get(runId)?.status === 'waiting-human') {
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
    if (signal.aborted) detach()
    else signal.addEventListener('abort', detach, { once: true })
    return handle
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
    // Fail fast on terminal runs: the engine rejects them too, but only after
    // the job was already registered, which used to surface as a fake
    // "resumed" whose real error vanished inside the background job.
    const terminal: RunState['status'][] = ['completed', 'failed', 'crashed', 'stopped']
    if (terminal.includes(persisted.status)) {
      throw new Error(`运行 ${input.runId} 已处于终态 ${persisted.status}，无法恢复`)
    }
    if (this.active.has(input.runId)) {
      throw new Error(`运行 ${input.runId} 正在执行中`)
    }
    const workflow = await this.resolveWorkflowConfig(workspace, persisted.configFile)
    if (!workflow) throw new Error(`运行 ${input.runId} 引用的 workflow「${persisted.configFile}」不存在`)
    const controller = new AbortController()
    const linked = new AbortController()
    const onStop = (): void => linked.abort()
    // The run's own controller stops it; the turn signal detaches instead.
    controller.signal.addEventListener('abort', onStop, { once: true })
    this.ensureSandboxDir(workspace, input.runId)
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
    // Traceable resume: mirror the 'start' audit row so a resumed run's log
    // shows who continued it and when.
    await this.writeAudit(workspace, input.runId, {
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
          this.progressTrack.delete(runId)
          await this.writeAudit(workspace, runId, {
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
      stateOutputs: entry.stateOutputs,
      stepLog: entry.stepLog,
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
      options: {},
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

  /** Whether the workspace opted into the SQLite run archive. */
  private async sqliteEnabled(workspace: string): Promise<boolean> {
    return (await readWorkspaceSettings(workspace, this.config.runDirName)).sqliteArchive
  }

  /** Append one audit event: JSONL is authoritative; SQLite mirrors when on. */
  private async writeAudit(workspace: string, runId: string, event: Record<string, unknown>): Promise<void> {
    await appendAudit(workspace, runId, this.config.runDirName, event)
    if (await this.sqliteEnabled(workspace)) {
      try {
        this.archive.archiveAudit(workspace, this.config.runDirName, runId, event)
      } catch {
        // Archive is a mirror; ignore write failures.
      }
    }
  }

  /** SQLite archive status of one workspace (for the state route). */
  async sqliteStatus(workspace: string): Promise<{ enabled: boolean; archived: number; dbFile: string | null }> {
    const enabled = await this.sqliteEnabled(workspace)
    if (!enabled) return { enabled: false, archived: 0, dbFile: null }
    let archived = 0
    try {
      archived = this.archive.countRuns(workspace, this.config.runDirName)
    } catch {
      archived = 0
    }
    return { enabled: true, archived, dbFile: this.archive.dbFile(workspace, this.config.runDirName) }
  }

  /** Toggle the SQLite archive; enabling backfills the existing file store. */
  async setSqliteArchive(
    workspace: string,
    enabled: boolean,
  ): Promise<{ enabled: boolean; backfilled: number; dbFile: string }> {
    await writeWorkspaceSettings(workspace, this.config.runDirName, { sqliteArchive: enabled })
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
    this.archive.close()
  }

  /** Workspace run statistics (archive SQL when enabled, JSON scan otherwise). */
  async workspaceStats(workspace: string): Promise<WorkspaceRunStats & { archiveEnabled: boolean; activeRuns: number }> {
    const enabled = await this.sqliteEnabled(workspace)
    const stats: WorkspaceRunStats = enabled
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
          })),
        )
    return { ...stats, archiveEnabled: enabled, activeRuns: this.active.size }
  }

  /** Liveness + activity snapshot for monitoring probes. */
  health(): { ok: true; activeRuns: number; streamingRuns: number; uptimeSec: number } {
    return {
      ok: true,
      activeRuns: this.active.size,
      streamingRuns: this.streams.size,
      uptimeSec: Math.round(process.uptime()),
    }
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
      // Opt-in SQLite mirror: long-term, queryable evidence chain. A mirror
      // failure must never break the run — the JSON file stays authoritative.
      if (await this.sqliteEnabled(workspace)) {
        try {
          this.archive.archiveRun(workspace, this.config.runDirName, runState)
        } catch {
          // Archive is a mirror; ignore write failures.
        }
      }
      // Evidence chain: diff the snapshot into granular audit events
      // (state-end / waiting-human / human-resolved) so the audit timeline
      // tells the full story, not just start/resume/end.
      const tracked = this.progressTrack.get(runId) ?? EMPTY_PROGRESS_TRACK
      const derived = progressAuditEvents(tracked, runState)
      this.progressTrack.set(runId, derived.next)
      for (const event of derived.events) {
        await this.writeAudit(workspace, runId, event)
      }
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
        stream.stateOutputs = runState.stateOutcomes.map((outcome) => {
          const last = outcome.steps[outcome.steps.length - 1]
          return {
            state: outcome.state,
            verdict: outcome.verdict.verdict,
            output: truncate(last?.outputSummary ?? '', 160),
          }
        })
        // Derive the step log from the persisted progress so every step kind
        // (agent, llm, script, subworkflow) appears; the in-flight agent step keeps
        // its live text until the persist after its completion finalizes it.
        const byKey = new Map<string, number>()
        stream.stepLog.forEach((entry, index) => {
          byKey.set(entry.key, index)
        })
        const completedSteps = [
          ...runState.stateOutcomes.flatMap((outcome) => outcome.steps),
          ...(runState.pendingState?.completedSteps ?? []),
        ]
        for (const step of completedSteps) {
          const existing = byKey.get(step.key)
          if (existing === undefined) {
            stream.stepLog.push({
              key: step.key,
              state: step.state,
              step: step.step,
              type: step.type,
              agent: step.agent ?? null,
              role: step.role ?? null,
              text: step.outputSummary,
              finished: true,
            })
            byKey.set(step.key, stream.stepLog.length - 1)
          } else {
            const entry = stream.stepLog[existing]
            if (entry && !entry.finished) {
              entry.text = step.outputSummary
              entry.finished = true
            }
          }
        }
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
      pythonCommand: this.config.pythonCommand,
      scriptsHome: join(workspace, this.config.runDirName, 'scripts'),
      sandboxDir: join(workspace, this.config.runDirName, 'runs', runId, 'sandbox'),
      resolveSubworkflow: async (configFile: string) => {
        const resolved = await this.resolveWorkflowConfig(workspace, configFile)
        if (!resolved) throw new EngineError(`子工作流「${configFile}」不存在`, 'NO_MATCH')
        return resolved.config
      },
      askHumanTransition: async ({ state, candidates, signal: askSignal }) => {
        // Approval gates arrive as the single `__continue__` candidate; render
        // them as an explicit approve/stop choice instead of a raw token.
        const approval = candidates.length === 1 && candidates[0] === '__continue__'
        const answer = await this.ctx.userQuestions.ask({
          questions: [
            {
              id: 'transition',
              header: approval ? '工作流审批' : '工作流决策',
              question: approval
                ? `状态「${state}」已完成，需要人工批准后才会继续：`
                : `工作流在状态「${state}」暂停，请选择下一步：`,
              options: approval
                ? [
                    { label: '批准，继续运行', description: '进入下一状态' },
                    { label: '停止运行', description: '以人工停止结束本次运行' },
                  ]
                : candidates.map((candidate) => ({ label: candidate })),
            },
          ],
          agent: parent,
          signal: askSignal,
        })
        const selected = answer.answers[0]?.selected[0] ?? ''
        if (approval && selected === '批准，继续运行') return '__continue__'
        if (approval && selected === '停止运行') return 'stop'
        return selected
      },
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
        const stepSignal = stepSignalWithTimeout(
          input.signal,
          input.timeoutMs ?? service.config.stepTimeoutMs,
        )
        const stream = service.streams.get(parentRunId)
        if (stream) {
          stream.currentState = input.ctx.state
          stream.currentStep = input.stepName
          stream.agent = input.agentName
          stream.role = input.role
          stream.text = ''
          stream.childSessionId = null
          stream.foldIndex = 0
          stream.stepLog.push({
            key: `${input.ctx.state}/${input.stepName}`,
            state: input.ctx.state,
            step: input.stepName,
            type: 'agent',
            agent: input.agentName,
            role: input.role,
            text: '',
            finished: false,
          })
          stream.stepLogIndex = stream.stepLog.length - 1
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
                  const logEntry = entry.stepLog[entry.stepLogIndex]
                  if (logEntry) logEntry.text += fold.text
                  entry.seq += 1
                }
              } catch (error) {
                // A streaming poller failure must never take down the host.
                service.ctx.logger('ace-harness').debug(`stream poll failed: ${String(error)}`)
              }
            }, 800)
          }
          const childResult = await raceAbort(run.result, input.signal)
          if (stepSignal.timedOut()) {
            throw new Error(`步骤「${input.stepName}」执行超时（${input.timeoutMs ?? service.config.stepTimeoutMs}ms）`)
          }
          const outputText = toText(childResult.output)
          const verdict =
            childResult.structured !== undefined
              ? normalizeVerdict(childResult.structured) ?? extractVerdict(outputText)
              : extractVerdict(outputText)
          const finalText = truncate(outputText || '(该步骤没有文本输出)', SUMMARY_BUDGET)
          if (stream) {
            stream.text = finalText
            const logEntry = stream.stepLog[stream.stepLogIndex]
            if (logEntry) {
              logEntry.text = finalText
              logEntry.finished = true
            }
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
      async runLlmStep(input) {
        const agentDef = input.agentName ? await service.agentByName(input.agentName) : undefined
        const registeredProviders = service.ctx.llm.listProviders().map((info) => info.id)
        const model =
          input.model ?? (service.config.model || (input.parent.options?.model ?? ''))
        if (model === '') {
          throw new EngineError(
            `llm 步骤「${input.stepName}」未指定 model，且调用方与插件配置都没有默认模型`,
            'NO_MATCH',
          )
        }
        let provider = input.parent.options?.provider
        if (provider === undefined) {
          // A caller without its own model route (REST/API synthetic parent)
          // must land on the route that actually advertises the resolved
          // model: a blind registration-order pick can send a pi-ai model to
          // the deepseek-official endpoint, which rejects the name on the wire.
          for (const candidate of registeredProviders) {
            try {
              const advertised = await service.ctx.llm.listModels(candidate)
              if (advertised.some((entry) => entry.id === model)) {
                provider = candidate
                break
              }
            } catch {
              // Catalog discovery is advisory; fall through to the default pick.
            }
          }
        }
        provider ??= registeredProviders.includes(service.config.subagentProvider)
          ? service.config.subagentProvider
          : registeredProviders[0]
        if (!provider) {
          throw new EngineError('没有已注册的 LLM provider，无法执行 llm 步骤', 'NO_MATCH')
        }
        const promptText = buildStepPrompt({
          role: input.role,
          task: input.task,
          constraints: input.constraints,
          ctx: input.ctx,
        })
        const stepSignal = stepSignalWithTimeout(
          input.signal,
          input.timeoutMs ?? service.config.stepTimeoutMs,
        )
        const stream = service.streams.get(parentRunId)
        if (stream) {
          stream.currentState = input.ctx.state
          stream.currentStep = input.stepName
          stream.agent = input.agentName ?? null
          stream.role = input.role
          stream.text = ''
          stream.childSessionId = null
          stream.foldIndex = 0
          stream.stepLog.push({
            key: `${input.ctx.state}/${input.stepName}`,
            state: input.ctx.state,
            step: input.stepName,
            type: 'llm',
            agent: input.agentName ?? null,
            role: input.role,
            text: '',
            finished: false,
          })
          stream.stepLogIndex = stream.stepLog.length - 1
          stream.seq += 1
        }
        service.ctx.emit('ace/step-start', {
          runId: parentRunId,
          state: input.ctx.state,
          step: input.stepName,
          role: input.role,
        })
        try {
          const userMessage = createUserMessage({
            content: [{ type: 'text', text: promptText }],
            source: { kind: 'plugin', plugin: 'dsh-ace-harness' },
          })
          const collect = (async (): Promise<string> => {
            let text = ''
            for await (const chunk of service.ctx.llm.stream({
              provider,
              model,
              messages: [userMessage],
              system: agentDef?.systemPrompt,
              temperature: agentDef?.temperature,
              maxTokens: input.parent.options?.maxTokens,
              signal: stepSignal.signal,
            })) {
              if (chunk.type === 'text-delta') {
                text += chunk.text
                const entry = service.streams.get(parentRunId)
                if (entry) {
                  entry.text += chunk.text
                  const logEntry = entry.stepLog[entry.stepLogIndex]
                  if (logEntry) logEntry.text += chunk.text
                  entry.seq += 1
                }
              } else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
                throw new Error(
                  `llm 步骤「${input.stepName}」调用失败: ${chunk.reason.failure.message}`,
                )
              }
            }
            return text
          })()
          const outputText = await raceAbort(collect, input.signal)
          if (stepSignal.timedOut()) {
            throw new Error(`步骤「${input.stepName}」执行超时（${input.timeoutMs ?? service.config.stepTimeoutMs}ms）`)
          }
          const verdict = extractVerdict(outputText)
          const finalText = truncate(outputText.trim() || '(该步骤没有文本输出)', SUMMARY_BUDGET)
          if (stream) {
            stream.text = finalText
            const logEntry = stream.stepLog[stream.stepLogIndex]
            if (logEntry) {
              logEntry.text = finalText
              logEntry.finished = true
            }
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
          stepSignal.dispose()
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
          const childResult = await raceAbort(run.result, input.signal)
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
 * Race a pending promise against an abort signal: rejection wins the moment
 * the signal fires, so a stop never waits on a hung child to settle.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('运行被取消'))
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = (): void => rejectPromise(new Error('运行被取消'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolvePromise(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        rejectPromise(error)
      },
    )
  })
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
  const failed = result.failedStates.length > 0 ? ` · ⚠ 判定失败的状态: ${result.failedStates.join('、')}` : ''
  return `运行 ${result.runId} ${result.status}${verdict}${failed}：${lines.join(', ') || '无状态'}${
    result.error ? ` · 错误: ${result.error}` : ''
  }`
}
