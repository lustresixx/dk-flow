/**
 * Step-executor factory: the four `StepExecutor` implementations (agent /
 * llm / subworkflow / supervisor) that bind the engine's host seam to the
 * DSH subagent and LLM services, plus the cancellation primitives they use.
 * Extracted from AceHarnessService (P0-2); the factory takes a narrow host
 * face so tests can substitute it instead of a whole service.
 * @module dsh-ace-harness/step-executor-factory
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { assertObjectJsonSchema, type ObjectJsonSchema, type ToolRestriction } from '@deepseek-ai/dsh-tools'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { AgentDefinition, StepVerdict, WorkflowConfig } from './dsl/types.js'
import { extractVerdict, normalizeVerdict } from './dsl/verdict.js'
import { buildStepPrompt, buildSupervisorPrompt, SUMMARY_BUDGET, truncate } from './engine/prompts.js'
import { runStateMachine } from './engine/runner.js'
import { foldAssistantText, type StreamEventLike } from './engine/stream-fold.js'
import {
  EngineError,
  type EngineRunOptions,
  type RunResult,
  type RunState,
  type StepExecutor,
} from './engine/types.js'
import { appendExperience, loadRecentExperience, renderExperience } from './store/experience.js'
import { loadRunState } from './store/run-store.js'
import { runPreCommands } from './engine/pre-commands.js'
import type { AceHarnessConfig } from './service.js'
import type { RunRegistry } from './run-registry.js'

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
  // Skills load through the single model-facing `skill` tool: a role/step
  // that declares a skill name (or the generic `Skill` token) is granted
  // that tool, and the step prompt names the exact skills to load.
  Skill: ['skill'],
}

/**
 * Translate an ACE agent's allowedTools roster into a DSH tool allow-list.
 * Each ACE name resolves to the first DSH candidate that `isAvailable`
 * reports — deployments differ, e.g. Windows profiles register `pwsh`
 * instead of `bash`. Skill names (anything not in the tool map that
 * `isSkillAvailable` reports) resolve to the `skill` tool, so a role can be
 * granted skill access through the same roster. Unmapped or unavailable
 * names are skipped; an empty result means no filter.
 */
export function toolFilterFor(
  allowedTools: readonly string[] | undefined,
  isAvailable: (name: string) => boolean = () => true,
  skills: readonly string[] = [],
  isSkillAvailable: (name: string) => boolean = () => false,
): ToolRestriction | undefined {
  if ((!allowedTools || allowedTools.length === 0) && skills.length === 0) return undefined
  const allow = new Set<string>()
  for (const name of allowedTools ?? []) {
    const candidates = ACE_TOOL_MAP[name]
    if (candidates) {
      const resolved = candidates.find(isAvailable)
      if (resolved) allow.add(resolved)
    } else if (isSkillAvailable(name)) {
      allow.add('skill')
    }
  }
  for (const name of skills) {
    if (isSkillAvailable(name)) allow.add('skill')
  }
  return allow.size > 0 ? { allow: [...allow] } : undefined
}

/** Skill-registry face the executor reads (optional; absent = no skills). */
interface SkillRegistryFace {
  list(options?: { cwd?: string; signal?: AbortSignal }): Promise<Array<{ name: string }>>
}

/** The kebab-case names of skills visible to a given workspace cwd. */
async function availableSkillNames(ctx: Context, cwd?: string): Promise<Set<string>> {
  const registry = ctx.get('skills') as SkillRegistryFace | undefined
  if (!registry) return new Set()
  try {
    const listed = await registry.list(cwd ? { cwd } : {})
    return new Set(listed.map((skill) => skill.name))
  } catch {
    // Skill discovery is advisory: a listing failure just means no skill
    // grants resolve, never a step failure.
    return new Set()
  }
}

/** Extract plain text from LLM content blocks. */
function toText(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim()
}

/**
 * Append a streamed chunk under the incremental display cap (P1-2④). Live
 * buffers keep the HEAD of the text — the same side the final truncate()
 * keeps — so a long step no longer grows the stream entry and its stepLog
 * line unboundedly between polls. Intermediate streamed text can be cut
 * short; the finalized text is unchanged.
 */
function appendCapped(text: string, chunk: string, budget: number): string {
  if (text.length >= budget) return text
  return text + chunk.slice(0, budget - text.length)
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** Everything the executor implementations need from the host service. */
export interface StepExecutorHost {
  /** Host context (subagents, llm, tools, sessions, logger, emit). */
  ctx: Context
  /** Resolved plugin config. */
  config: Required<AceHarnessConfig>
  /** Shared run maps (live stream projections). */
  registry: RunRegistry
  /** Resolve one catalog agent by name (after the catalog has loaded). */
  agentByName(name: string): Promise<AgentDefinition | undefined>
  /** Resolve a workflow reference (subworkflow steps). */
  resolveWorkflowConfig(workspace: string, configFile: string): Promise<{ config: WorkflowConfig; file: string } | null>
  /** Assemble engine options for a (sub)workflow run. */
  engineOptions(input: {
    workspace: string
    parent: Agent
    workflow: { config: WorkflowConfig; configFile: string }
    runId: string
    executor: StepExecutor
    signal: AbortSignal
    load: () => Promise<RunState | null>
    inputs: Record<string, string>
  }): EngineRunOptions
}

/** Build the step executor for one run, bound to its workspace and lineage. */
export function makeStepExecutor(
  host: StepExecutorHost,
  workspace: string,
  parent: Agent,
  parentRunId: string,
  depth: number,
): StepExecutor {
  const { ctx, config, registry } = host
  return {
    async runAgentStep(input) {
      const agentDef = await host.agentByName(input.agentName)
      const systemPrompt = agentDef?.systemPrompt ?? ''
      const preOutput = await runPreCommands(
        input.preCommands,
        input.ctx.projectRoot,
        config.preCommandTimeoutMs,
        input.signal,
      )
      // Skills: role catalog + step override, deduplicated and resolved to
      // the ones actually visible in the workspace. The prompt names them so
      // the subagent loads each before acting; the tool filter grants `skill`.
      const declaredSkills = [...new Set([...(agentDef?.skills ?? []), ...(input.skills ?? [])])]
      const skillNames =
        declaredSkills.length > 0 ? await availableSkillNames(ctx, input.ctx.projectRoot) : new Set<string>()
      const skills = declaredSkills.filter((name) => skillNames.has(name))
      const skillPrompt =
        skills.length > 0
          ? `## 需加载的 Skill\n任务开始前，先调用 \`skill\` 工具逐一加载并遵循以下技能的完整指令（已加入你的可用工具列表）：\n${skills.map((name) => `- ${name}`).join('\n')}\n\n`
          : ''
      const promptText =
        (systemPrompt ? `## 角色设定\n${systemPrompt}\n\n` : '') +
        skillPrompt +
        (preOutput !== '' ? `## 预命令输出\n${preOutput}\n\n` : '') +
        buildStepPrompt({
          role: input.role,
          task: input.task,
          constraints: input.constraints,
          ctx: input.ctx,
          evidence: input.evidence,
        })
      const provider = config.subagentProvider
      const providerCaps = ctx.subagents.getProvider(provider)?.capabilities
      const wantsSchema = input.role === 'judge' && providerCaps?.outputSchema === true
      const stepSignal = stepSignalWithTimeout(
        input.signal,
        input.timeoutMs ?? config.stepTimeoutMs,
      )
      const stream = registry.streams.get(parentRunId)
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
        agentOptions: config.model ? { model: config.model } : undefined,
        outputSchema: wantsSchema ? VERDICT_OUTPUT_SCHEMA : undefined,
        toolFilter:
          providerCaps?.toolFilter === true
            ? toolFilterFor(
                agentDef?.allowedTools,
                (name) => ctx.tools.get(name) !== undefined,
                skills,
                (name) => skills.includes(name),
              )
            : undefined,
      }
      ctx.emit('ace/step-start', {
        runId: parentRunId,
        state: input.ctx.state,
        step: input.stepName,
        role: input.role,
      })
      let run: Awaited<ReturnType<typeof ctx.subagents.start>> | undefined
      let poller: ReturnType<typeof setInterval> | undefined
      try {
        run = await ctx.subagents.start(provider, request)
        if (stream) {
          const childId = run.id
          stream.childSessionId = childId
          // Fold the child transcript into the live stream while it runs.
          poller = setInterval(() => {
            try {
              const entry = registry.streams.get(parentRunId)
              if (!entry || entry.childSessionId !== childId) return
              const session = ctx.sessions.get(childId)
              if (!session) return
              const fold = foldAssistantText(
                session.events as readonly StreamEventLike[],
                entry.foldIndex,
              )
              entry.foldIndex = fold.index
              if (fold.text !== '') {
                entry.text = appendCapped(entry.text, fold.text, SUMMARY_BUDGET)
                const logEntry = entry.stepLog[entry.stepLogIndex]
                if (logEntry) logEntry.text = appendCapped(logEntry.text, fold.text, SUMMARY_BUDGET)
                entry.seq += 1
              }
            } catch (error) {
              // A streaming poller failure must never take down the host.
              ctx.logger('ace-harness').debug(`stream poll failed: ${String(error)}`)
            }
          }, 800)
        }
        const childResult = await raceAbort(run.result, input.signal)
        if (stepSignal.timedOut()) {
          throw new Error(`步骤「${input.stepName}」执行超时（${input.timeoutMs ?? config.stepTimeoutMs}ms）`)
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
        ctx.emit('ace/step-end', {
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
      const agentDef = input.agentName ? await host.agentByName(input.agentName) : undefined
      const registeredProviders = ctx.llm.listProviders().map((info) => info.id)
      const model =
        input.model ?? (config.model || (input.parent.options?.model ?? ''))
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
            const advertised = await ctx.llm.listModels(candidate)
            if (advertised.some((entry) => entry.id === model)) {
              provider = candidate
              break
            }
          } catch {
            // Catalog discovery is advisory; fall through to the default pick.
          }
        }
      }
      provider ??= registeredProviders.includes(config.subagentProvider)
        ? config.subagentProvider
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
        input.timeoutMs ?? config.stepTimeoutMs,
      )
      const stream = registry.streams.get(parentRunId)
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
      ctx.emit('ace/step-start', {
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
          for await (const chunk of ctx.llm.stream({
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
              const entry = registry.streams.get(parentRunId)
              if (entry) {
                entry.text = appendCapped(entry.text, chunk.text, SUMMARY_BUDGET)
                const logEntry = entry.stepLog[entry.stepLogIndex]
                if (logEntry) logEntry.text = appendCapped(logEntry.text, chunk.text, SUMMARY_BUDGET)
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
          throw new Error(`步骤「${input.stepName}」执行超时（${input.timeoutMs ?? config.stepTimeoutMs}ms）`)
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
        ctx.emit('ace/step-end', {
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
      if (depth >= config.maxSubworkflowDepth) {
        throw new EngineError(`子工作流嵌套深度超过上限 ${config.maxSubworkflowDepth}`, 'NO_MATCH')
      }
      const resolved = await host.resolveWorkflowConfig(workspace, input.configFile)
      if (!resolved) throw new EngineError(`子工作流「${input.configFile}」不存在`, 'NO_MATCH')
      const childRunId = `${parentRunId}.${sanitize(input.stepName)}`
      // Observability (P1-2⑤): the child run gets its own live stream entry
      // — its executor and persist projection already key on childRunId, so
      // the entry fills step by step; without it the panel went silent for
      // the whole subworkflow. Settled (and prune-scheduled) when it ends.
      registry.openStream({
        runId: childRunId,
        workflowName: resolved.config.workflow.name,
        config: resolved.config,
        totalSteps: resolved.config.workflow.states.reduce((sum, state) => sum + state.steps.length, 0),
      })
      let childResult: RunResult
      try {
        const childExecutor = makeStepExecutor(host, workspace, input.parent, childRunId, depth + 1)
        const childOptions = host.engineOptions({
          workspace,
          parent: input.parent,
          workflow: { config: resolved.config, configFile: resolved.file },
          runId: childRunId,
          executor: childExecutor,
          signal: input.signal,
          load: () => loadRunState(workspace, childRunId, config.runDirName),
          inputs: {
            requirements: input.inheritedRequirements,
            ...(input.inheritedProjectRoot !== undefined && input.inheritedProjectRoot !== ''
              ? { projectRoot: input.inheritedProjectRoot }
              : {}),
          },
        })
        childResult = await runStateMachine(childOptions)
      } catch (error) {
        registry.settleStream(childRunId, 'crashed')
        throw error
      }
      registry.settleStream(childRunId, childResult.status)
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
      const supervisorDef = await host.agentByName(input.supervisorName)
      if (!supervisorDef) return null
      const experience = await loadRecentExperience(workspace, config.runDirName, 5)
      const promptText =
        `## 角色设定\n${supervisorDef.systemPrompt}\n\n` +
        buildSupervisorPrompt({
          state: input.ctx.state,
          requirements: input.ctx.requirements,
          stateOutcome: input.stateOutcome,
          experience: renderExperience(experience),
          scoringEnabled: true,
        })
      const providerCaps = ctx.subagents.getProvider(config.subagentProvider)?.capabilities
      const wantsSchema = providerCaps?.outputSchema === true
      const stepSignal = stepSignalWithTimeout(input.signal, config.stepTimeoutMs)
      let run: Awaited<ReturnType<typeof ctx.subagents.start>> | undefined
      try {
        run = await ctx.subagents.start(config.subagentProvider, {
          label: `${input.ctx.state}/supervisor-checkpoint`,
          prompt: [{ type: 'text', text: promptText }],
          parent: input.parent,
          signal: stepSignal.signal,
          agentOptions: config.model ? { model: config.model } : undefined,
          outputSchema: wantsSchema ? SCORE_OUTPUT_SCHEMA : undefined,
        })
        const childResult = await raceAbort(run.result, input.signal)
        if (stepSignal.timedOut()) {
          throw new Error(`supervisor 检查点执行超时（${config.stepTimeoutMs}ms）`)
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
        await appendExperience(workspace, config.runDirName, entry).catch(() => {
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
