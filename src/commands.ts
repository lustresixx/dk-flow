/**
 * The `/workflow` slash-command family: discover templates and instances,
 * create from templates, run, watch, resume, stop, and validate workflows.
 * @module dsh-ace-harness/commands
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type AceHarnessService from './service.js'
import type { RunResult, RunState } from './engine/types.js'
import type { WorkflowConfig } from './dsl/types.js'

const ok = (text: string): CommandResult => ({ kind: 'success', text })
const err = (text: string): CommandResult => ({ kind: 'error', text })

/** Parse `--key value` / `--key=value` pairs from command input. */
function parseFlags(rawInput: string): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = []
  const flags = new Map<string, string>()
  const tokens = rawInput.split(/\s+/).filter((token) => token !== '')
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!
    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      if (eq >= 0) {
        flags.set(token.slice(2, eq), token.slice(eq + 1))
      } else {
        const next = tokens[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(token.slice(2), next)
          i += 1
        } else {
          flags.set(token.slice(2), 'true')
        }
      }
    } else {
      positional.push(token)
    }
  }
  return { positional, flags }
}

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
      `  状态「${outcome.state}」→ ${outcome.verdict.verdict}${outcome.supervisorScore !== undefined ? ` [评分 ${outcome.supervisorScore}]` : ''}${outcome.verdict.rationale ? `：${truncateLine(outcome.verdict.rationale, 120)}` : ''}`,
    )
    for (const step of outcome.steps) {
      lines.push(`    · ${step.step}${step.agent ? ` [${step.agent}]` : ''}${step.verdict ? ` → ${step.verdict.verdict}` : ''}`)
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
  if (result.error) lines.push(`错误: ${result.error}`)
  return lines.join('\n')
}

/** Register the command family on the host context. */
export function registerCommands(ctx: Context, service: AceHarnessService): void {
  ctx.commands.register({
    name: 'workflow',
    description: 'ACE 状态机工作流：模板、实例、运行、恢复与治理',
    input: { hint: 'list | templates | create <模板> | run <workflow> [--wait] | runs | show <runId> | resume <runId> | stop <runId> | validate <file>' },
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
      case 'create': {
        const templateId = positional[1]
        if (!templateId) return err('用法：/workflow create <templateId> [--file name.yaml] [--param id=value ...] [--save]')
        const templates = await service.listTemplates()
        const template = templates
          .filter((t) => t.id === templateId)
          .sort((a, b) => a.version.localeCompare(b.version))
          .at(-1)
        if (!template) return err(`未找到模板「${templateId}」`)
        const values: Record<string, unknown> = {}
        for (const [key, value] of flags) {
          if (key !== 'file' && key !== 'save' && key !== 'param') values[key] = value
        }
        for (const [key, value] of Object.entries(parseParamFlags(flags))) values[key] = value
        const missing = (template.manifest.spec.parameters ?? [])
          .filter((p) => p.required && values[p.id] === undefined && p.default === undefined)
          .map((p) => p.label)
        if (missing.length > 0) return err(`缺少必填参数：${missing.join('、')}`)
        const instantiated = await service.instantiate(templateId, undefined, values, {})
        if (flags.has('save')) {
          const fileName = flags.get('file') ?? `${templateId}.yaml`
          const saved = await service.saveWorkflowConfig(workspace, fileName, instantiated.yamlText)
          return ok(`已从模板「${templateId}」创建工作流并保存到 ${saved}\n\n${instantiated.yamlText}`)
        }
        return ok(`已从模板「${templateId}」创建工作流（未保存，可用 --save 落盘到工作区 .dsh/workflows）：\n\n${instantiated.yamlText}`)
      }
      case 'run': {
        return runWorkflow(service, agent, signal, positional, flags)
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
        const handle = await service.resumeRun({ parent: agent, signal, runId })
        if (flags.has('wait')) {
          return ok(renderResult(await handle.result))
        }
        return ok(`已恢复运行 ${handle.runId}，使用 /workflow show ${handle.runId} 查看进度`)
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
          `未知子命令「${sub}」。可用：list | templates | agents | create <模板> | run <workflow> [--wait] | runs | show <runId> | resume <runId> | stop <runId> | validate <file> | delete <file>`,
        )
    }
  } catch (error) {
    return err(`workflow 命令失败：${(error as Error).message}`)
  }
}

/** Read repeated `--param id=value` flags into a values record. */
function parseParamFlags(flags: Map<string, string>): Record<string, string> {
  const values: Record<string, string> = {}
  const raw = flags.get('param')
  if (!raw) return values
  const match = /^([A-Za-z0-9_-]+)=(.*)$/.exec(raw)
  if (match) values[match[1]!] = match[2]!
  return values
}

async function runWorkflow(
  service: AceHarnessService,
  agent: Agent,
  signal: AbortSignal,
  positional: string[],
  flags: Map<string, string>,
): Promise<CommandResult> {
  const target = positional[1]
  if (!target) return err('用法：/workflow run <workflowFile | templateId> [--param id=value ...] [--requirement text] [--wait]')
  const workspace = service.workspaceOf(agent)
  const values: Record<string, string> = {}
  Object.assign(values, parseParamFlags(flags))
  for (const [key, value] of flags) {
    if (key !== 'wait' && key !== 'requirement' && key !== 'param') values[key] = value
  }

  // Resolve: workflow instance first, then template instantiation.
  let workflow: { config: WorkflowConfig; configFile: string }
  const instance = await service.loadWorkflowConfig(workspace, target)
  if (instance) {
    workflow = { config: instance.config, configFile: instance.file }
  } else {
    const templates = await service.listTemplates()
    const template = templates
      .filter((t) => t.id === target)
      .sort((a, b) => a.version.localeCompare(b.version))
      .at(-1)
    if (!template) return err(`未找到 workflow 实例或模板「${target}」`)
    const missing = (template.manifest.spec.parameters ?? [])
      .filter((p) => p.required && values[p.id] === undefined && p.default === undefined)
      .map((p) => p.label)
    if (missing.length > 0) return err(`模板「${target}」缺少必填参数：${missing.join('、')}`)
    const instantiated = await service.instantiate(target, undefined, values, {})
    workflow = { config: instantiated.config, configFile: target }
  }

  const requirement = flags.get('requirement')
  if (requirement && workflow.config.context) {
    workflow.config.context.requirements = requirement
  }

  const handle = await service.startRun({ parent: agent, signal, workflow, inputs: values })
  if (flags.has('wait')) {
    return ok(renderResult(await handle.result))
  }
  return ok(`已启动运行 ${handle.runId}（workflow: ${workflow.config.workflow.name}），使用 /workflow show ${handle.runId} 查看进度；后台执行中，可在运行后查看状态`)
}
