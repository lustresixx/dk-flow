/**
 * The `/workflow` slash-command family: discover templates and instances,
 * create from templates, run, watch, resume, stop, and validate workflows.
 * @module dsh-ace-harness/commands
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type AceHarnessService from './service.js'
import { askMissingParameters, askMissingTaskInputs } from './params-dialog.js'
import type { RunResult, RunState } from './engine/types.js'
import type { WorkflowConfig } from './dsl/types.js'

const ok = (text: string): CommandResult => ({ kind: 'success', text })
const err = (text: string): CommandResult => ({ kind: 'error', text })

/** Parsed command input: positionals plus flags, repeated flags in order. */
export interface ParsedFlags {
  positional: string[]
  flags: Map<string, string[]>
}

/**
 * Parse `--key value` / `--key=value` pairs from command input. Repeated
 * flags accumulate (the workbench sends several `--param id=value` pairs);
 * callers wanting the usual single-value semantics read the last occurrence.
 */
export function parseFlags(rawInput: string): ParsedFlags {
  const positional: string[] = []
  const flags = new Map<string, string[]>()
  const tokens = rawInput.split(/\s+/).filter((token) => token !== '')
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!
    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      let key: string
      let value: string
      if (eq >= 0) {
        key = token.slice(2, eq)
        value = token.slice(eq + 1)
      } else {
        key = token.slice(2)
        const next = tokens[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          value = next
          i += 1
        } else {
          value = 'true'
        }
      }
      const list = flags.get(key) ?? []
      list.push(value)
      flags.set(key, list)
    } else {
      positional.push(token)
    }
  }
  return { positional, flags }
}

/** Last occurrence of a flag, for flags that only make sense once. */
function lastFlag(flags: Map<string, string[]>, key: string): string | undefined {
  const list = flags.get(key)
  return list === undefined || list.length === 0 ? undefined : list[list.length - 1]
}

/** Decode a URI-encoded flag value; plain text passes through untouched. */
function decodeFlagValue(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

const VERDICT_TEXT: Record<string, string> = {
  success: '成功',
  pass: '成功',
  fail: '失败',
  conditional_pass: '有条件通过',
}

const verdictText = (verdict: string): string => VERDICT_TEXT[verdict] ?? verdict

/** Render one run's state progression as text. */
function renderRun(state: RunState): string {
  const lines = [
    `运行 ${state.id}`,
    `workflow: ${state.workflowName} (${state.configFile})`,
    `状态: ${state.status}${state.currentState ? ` · 当前状态: ${state.currentState}` : ''}`,
    `进度: ${state.completedSteps}/${state.totalSteps} 步 · 转移 ${state.transitionCount} 次`,
    `开始: ${state.startedAt}${state.finishedAt ? ` · 结束: ${state.finishedAt}` : ''}`,
  ]
  if (state.error) lines.push(`错误: ${state.error}`)
  for (const outcome of state.stateOutcomes) {
    lines.push(
      `  状态「${outcome.state}」→ ${verdictText(outcome.verdict.verdict)}${outcome.supervisorScore !== undefined ? ` [评分 ${outcome.supervisorScore}]` : ''}${outcome.verdict.rationale ? `：${truncateLine(outcome.verdict.rationale, 120)}` : ''}`,
    )
    for (const step of outcome.steps) {
      lines.push(`    · ${step.step}${step.agent ? ` [${step.agent}]` : ''}${step.verdict ? ` → ${verdictText(step.verdict.verdict)}` : ''}`)
    }
    if (outcome.supervisorNote) lines.push(`    supervisor: ${truncateLine(outcome.supervisorNote, 200)}`)
  }
  return lines.join('\n')
}

function truncateLine(text: string, budget: number): string {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length <= budget ? flat : `${flat.slice(0, budget)}…`
}

/** Render one run result (terminal summary). */
function renderResult(result: RunResult): string {
  const lines = [
    `运行 ${result.runId} 结束：${result.status}${result.verdict ? ` · 最终结论 ${result.verdict}` : ''}`,
  ]
  for (const outcome of result.stateOutcomes) {
    lines.push(`  ${outcome.state} → ${outcome.verdict.verdict}`)
  }
  if (result.failedStates.length > 0) {
    lines.push(`⚠ 以下状态判定失败（业务未通过，即使运行已收尾）：${result.failedStates.join('、')}`)
  }
  if (result.error) lines.push(`错误: ${result.error}`)
  return lines.join('\n')
}

/** Register the command family on the host context. */
export function registerCommands(ctx: Context, service: AceHarnessService): void {
  ctx.commands.register({
    name: 'workflow',
    description: 'ACE 状态机工作流：模板、实例、运行、恢复与治理',
    input: { hint: 'list | templates | scripts | create <模板> | run <workflow> [--wait] | test <workflow> <状态> <步骤> | runs | show <runId> | resume <runId> | stop <runId> | validate <file>' },
    async handler(invocation: CommandInvocation): Promise<CommandResult> {
      return dispatch(ctx, service, invocation)
    },
  })
}

async function dispatch(ctx: Context, service: AceHarnessService, invocation: CommandInvocation): Promise<CommandResult> {
  const { agent, rawInput, signal } = invocation
  const { positional, flags } = parseFlags(rawInput)
  const sub = positional[0] ?? 'list'
  const workspace = service.workspaceOf(agent)
  try {
    switch (sub) {
      case 'list': {
        const [templates, workflows, runs] = await Promise.all([
          service.listTemplates(),
          service.listWorkflows(workspace),
          service.listRuns(workspace),
        ])
        const lines = ['内置模板：', ...templates.map((t) => `  · ${t.id}@${t.version} — ${t.manifest.metadata.name}`)]
        lines.push('', 'Workflow 实例：')
        if (workflows.length === 0) lines.push('  （无，可通过 /workflow create 从模板创建）')
        for (const workflow of workflows) {
          lines.push(`  · ${workflow.fileName} — ${workflow.summary.name}（${workflow.summary.stateCount} 状态 / ${workflow.summary.stepCount} 步，${workflow.source}）`)
        }
        lines.push('', '运行记录：')
        if (runs.length === 0) lines.push('  （无）')
        for (const run of runs.slice(0, 10)) {
          lines.push(`  · ${run.id} — ${run.workflowName} [${run.status}] ${run.currentState ?? ''}`)
        }
        return ok(lines.join('\n'))
      }
      case 'templates': {
        const templates = await service.listTemplates()
        return ok(
          templates
            .map((t) => {
              const params = (t.manifest.spec.parameters ?? [])
                .map((p) => `${p.id}${p.required ? '*' : ''}:${p.type}`)
                .join(', ')
              const deps = t.manifest.spec.dependencies?.agents?.join(', ') ?? ''
              return `${t.id}@${t.version} — ${t.manifest.metadata.name}\n  ${t.manifest.metadata.description ?? ''}\n  状态数: ${t.config.workflow.states.length} · 参数: ${params || '无'} · 依赖 Agent: ${deps || '无'}`
            })
            .join('\n\n'),
        )
      }
      case 'agents': {
        const agents = await service.listAgents()
        return ok(
          agents
            .map((a) => `· ${a.name} [${a.team}/${a.roleType}] — ${a.description ?? a.baseCapability ?? ''}`)
            .join('\n'),
        )
      }
      case 'scripts': {
        const scripts = await service.listScripts(workspace)
        if (scripts.length === 0) {
          return ok('（无可用脚本。内置库随插件打包；通用脚本可放入工作区 .ace-workflows/scripts/ 目录收集复用）')
        }
        const lines = [
          '可用脚本（scriptFile 解析顺序：工作区根 → .ace-workflows/scripts/ → 内置库）：',
          ...scripts.map((script) =>
            `  · ${script.name} [${script.source === 'builtin' ? '内置' : '工作区'}]${script.description ? ` — ${script.description}` : ''}`,
          ),
          '把通用脚本放进工作区 .ace-workflows/scripts/ 即可被任何工作流的 scriptFile 直接引用。',
        ]
        return ok(lines.join('\n'))
      }
      case 'test': {
        const file = positional[1]
        const stateName = positional[2]
        const stepName = positional[3]
        if (!file || !stateName || !stepName) {
          return err('用法：/workflow test <workflowFile|templateId> <状态> <步骤> [--param id=value ...]（单节点独立验证，不跑整个工作流）')
        }
        const resolved = await service.resolveWorkflowConfig(workspace, file)
        if (!resolved) return err(`未找到 workflow「${file}」`)
        const values: Record<string, string> = {}
        Object.assign(values, parseParamFlags(flags))
        for (const [key, list] of flags) {
          if (key !== 'param') values[key] = list[list.length - 1]!
        }
        const result = await service.testStep({
          parent: agent,
          signal,
          config: resolved.config,
          stateName,
          stepName,
          values,
          workspace,
        })
        const lines = [
          `步骤验证：${result.state}/${result.step} [${result.type}] → ${result.verdict ? result.verdict.verdict : '无结论'}`,
          `产出：\n${result.outputSummary}`,
        ]
        if (result.data !== undefined) lines.push(`结构化数据：\n${JSON.stringify(result.data, null, 2)}`)
        return ok(lines.join('\n\n'))
      }
      case 'create': {
        const templateId = positional[1]
        if (!templateId) return err('用法：/workflow create <templateId> [--file name.yaml] [--param id=value ...] [--save]（参数可留空，运行时询问）')
        const templates = await service.listTemplates()
        const template = templates
          .filter((t) => t.id === templateId)
          .sort((a, b) => a.version.localeCompare(b.version))
          .at(-1)
        if (!template) return err(`未找到模板「${templateId}」`)
        const values: Record<string, unknown> = {}
        for (const [key, list] of flags) {
          if (key !== 'file' && key !== 'save' && key !== 'param') values[key] = list[list.length - 1]!
        }
        for (const [key, value] of Object.entries(parseParamFlags(flags))) values[key] = value
        const instantiated = await service.instantiate(templateId, undefined, values, {})
        const pendingNote =
          instantiated.pendingParams.length > 0
            ? `\n（运行时将询问：${instantiated.pendingParams.map((p) => p.label).join('、')}；也可现在用 --param 预填固化）`
            : ''
        if (flags.has('save')) {
          const fileName = lastFlag(flags, 'file') ?? `${templateId}.yaml`
          const saved = await service.saveWorkflowConfig(workspace, fileName, instantiated.yamlText)
          return ok(`已从模板「${templateId}」创建工作流并保存到 ${saved}${pendingNote}\n\n${instantiated.yamlText}`)
        }
        return ok(`已从模板「${templateId}」创建工作流（未保存，可用 --save 落盘到工作区 .dsh/workflows）${pendingNote}\n\n${instantiated.yamlText}`)
      }
      case 'run': {
        return runWorkflow(ctx, service, agent, signal, positional, flags)
      }
      case 'runs': {
        const runs = await service.listRuns(workspace)
        if (runs.length === 0) return ok('（无运行记录）')
        return ok(runs.map(renderRun).join('\n\n'))
      }
      case 'show': {
        const runId = positional[1]
        if (!runId) return err('用法：/workflow show <runId>')
        const state = await service.getRun(workspace, runId)
        if (!state) return err(`未找到运行 ${runId}`)
        return ok(renderRun(state))
      }
      case 'resume': {
        const runId = positional[1]
        if (!runId) return err('用法：/workflow resume <runId>')
        const handle = await service.resumeRun({
          parent: agent,
          signal,
          runId,
          mode: flags.has('wait') ? 'foreground' : 'job',
        })
        if (flags.has('wait')) {
          return ok(renderResult(await handle.result))
        }
        return ok(
          `已恢复运行 ${handle.runId}${handle.jobId ? `（后台 job ${handle.jobId}）` : ''}，使用 /workflow show ${handle.runId} 查看进度`,
        )
      }
      case 'stop': {
        const runId = positional[1]
        if (!runId) return err('用法：/workflow stop <runId>')
        return service.stopRun(runId) ? ok(`已请求停止运行 ${runId}`) : err(`运行 ${runId} 未在执行中`)
      }
      case 'validate': {
        const file = positional[1]
        if (!file) return err('用法：/workflow validate <fileName>')
        const loaded = await service.loadWorkflowConfig(workspace, file)
        if (!loaded) return err(`未找到 workflow 实例「${file}」`)
        const validated = await service.validateWorkflowYaml(
          await (await import('node:fs/promises')).readFile(loaded.file, 'utf8'),
        )
        if (validated.errors.length > 0) return err(validated.errors.join('\n'))
        return ok(
          `校验通过：${validated.summary.name}（${validated.summary.stateCount} 状态 / ${validated.summary.stepCount} 步 / 引用 Agent: ${validated.summary.agentNames.join(', ') || '无'}）`,
        )
      }
      case 'delete': {
        const file = positional[1]
        if (!file) return err('用法：/workflow delete <fileName>')
        const deleted = await service.deleteWorkflowConfig(workspace, file)
        return deleted ? ok(`已删除 workflow「${file}」`) : err(`未找到 workflow「${file}」`)
      }
      default:
        return err(
          `未知子命令「${sub}」。可用：list | templates | agents | scripts | create <模板> | run <workflow> [--wait] | test <workflow> <状态> <步骤> | runs | show <runId> | resume <runId> | stop <runId> | validate <file> | delete <file>`,
        )
    }
  } catch (error) {
    return err(`workflow 命令失败：${(error as Error).message}`)
  }
}

/** Read repeated `--param id=value` flags into a values record. */
export function parseParamFlags(flags: Map<string, string[]>): Record<string, string> {
  const values: Record<string, string> = {}
  for (const raw of flags.get('param') ?? []) {
    const match = /^([A-Za-z0-9_-]+)=(.*)$/.exec(raw)
    if (match) values[match[1]!] = decodeFlagValue(match[2]!)
  }
  return values
}

async function runWorkflow(
  ctx: Context,
  service: AceHarnessService,
  agent: Agent,
  signal: AbortSignal,
  positional: string[],
  flags: Map<string, string[]>,
): Promise<CommandResult> {
  const target = positional[1]
  if (!target) return err('用法：/workflow run <workflowFile | templateId> [--param id=value ...] [--requirement text] [--wait]')
  const workspace = service.workspaceOf(agent)
  const values: Record<string, string> = {}
  Object.assign(values, parseParamFlags(flags))
  for (const [key, list] of flags) {
    if (key !== 'wait' && key !== 'requirement' && key !== 'param') values[key] = list[list.length - 1]!
  }

  // Resolve: workflow instance first, then template instantiation.
  let workflow: { config: WorkflowConfig; configFile: string }
  const instance = await service.loadWorkflowConfig(workspace, target)
  if (instance) {
    workflow = { config: instance.config, configFile: instance.file }
    const taskFields = instance.config.context?.taskInput?.fields ?? []
    const missingFields = taskFields.filter((field) => field.required && values[field.id] === undefined)
    if (missingFields.length > 0) {
      const filled = await askMissingTaskInputs(
        ctx,
        agent,
        signal,
        taskFields,
        missingFields.map((field) => field.id),
      )
      if (!filled) {
        return err(
          `实例「${target}」缺少必填参数：${missingFields.map((field) => field.label).join('、')}\n` +
            `用法：/workflow run ${target}${taskFields.map((field) => ` --param ${field.id}=<${field.label}>`).join('')}`,
        )
      }
      Object.assign(values, filled)
    }
  } else {
    const templates = await service.listTemplates()
    const template = templates
      .filter((t) => t.id === target)
      .sort((a, b) => a.version.localeCompare(b.version))
      .at(-1)
    if (!template) {
      const templateIds = templates.map((t) => t.id).join('、')
      return err(
        `未找到 workflow 实例或模板「${target}」。\n` +
          `- 工作区实例：先在工作台从模板创建（.dsh/workflows/ 下的文件名），或 /workflow list 查看\n` +
          `- 内置模板 id：${templateIds || '无'}\n` +
          `注意实例名≠模板名：例如 demo 实例 code-optimization-demo 来自模板 code-optimization-review（换机器时用模板 id 更可靠）。`,
      )
    }
    const missing = (template.manifest.spec.parameters ?? [])
      .filter((p) => p.required && values[p.id] === undefined && p.default === undefined)
    if (missing.length > 0) {
      const filled = await askMissingParameters(
        ctx,
        agent,
        signal,
        template.manifest,
        missing.map((p) => p.id),
      )
      if (!filled) {
        return err(
          `模板「${target}」缺少必填参数：${missing.map((p) => p.label).join('、')}\n` +
            `用法：/workflow run ${target}${(template.manifest.spec.parameters ?? [])
              .map((p) => ` --param ${p.id}=<${p.label}>`)
              .join('')}`,
        )
      }
      Object.assign(values, filled)
    }
    const instantiated = await service.instantiate(target, undefined, values, {})
    workflow = { config: instantiated.config, configFile: target }
  }

  const requirement = lastFlag(flags, 'requirement')
  if (requirement && workflow.config.context) {
    workflow.config.context.requirements = requirement
  }

  const handle = await service.startRun({
    parent: agent,
    signal,
    workflow,
    inputs: values,
    mode: flags.has('wait') ? 'foreground' : 'job',
  })
  if (flags.has('wait')) {
    return ok(renderResult(await handle.result))
  }
  return ok(
    `已启动运行 ${handle.runId}${handle.jobId ? `（后台 job ${handle.jobId}）` : ''}（workflow: ${workflow.config.workflow.name}）。使用 /workflow show ${handle.runId} 查看进度，/workflow stop ${handle.runId} 停止。`,
  )
}
