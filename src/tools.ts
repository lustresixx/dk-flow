/**
 * Model-facing workflow tools: `workflow_list`, `run_workflow`, and
 * `workflow_manage`. The tools run workflows through the service in the
 * invoking agent's workspace and return lossless JSON canonical values.
 * @module dsh-ace-harness/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type AceHarnessService from './service.js'
import type { RunState } from './engine/types.js'
import type { WorkflowConfig } from './dsl/types.js'

/** Canonical JSON run projection shared by all tools. */
function runJson(state: RunState): Record<string, unknown> {
  return {
    runId: state.id,
    workflowName: state.workflowName,
    status: state.status,
    currentState: state.currentState,
    completedSteps: state.completedSteps,
    totalSteps: state.totalSteps,
    transitionCount: state.transitionCount,
    error: state.error,
    states: state.stateOutcomes.map((outcome) => ({
      state: outcome.state,
      verdict: outcome.verdict.verdict,
      rationale: outcome.verdict.rationale,
      supervisorNote: outcome.supervisorNote,
      steps: outcome.steps.map((step) => ({
        step: step.step,
        agent: step.agent,
        role: step.role,
        verdict: step.verdict?.verdict,
        issues: step.verdict?.issues ?? [],
      })),
    })),
  }
}

/** Register the three model-facing tools on the host context. */
export function registerTools(ctx: Context, service: AceHarnessService): void {
  ctx.tools.register(
    defineTool({
      name: 'workflow_list',
      description:
        '列出可用的 ACE 状态机工作流：内置模板（可实例化）与工作区/个人已保存的 workflow 实例，含状态数、步骤数与参数要求。',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [
          { type: 'text', text: `工作流清单：\n${JSON.stringify(value, null, 2)}` },
        ],
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (!agent) throw new Error('workflow 工具调用缺少调用方 Agent')
        const workspace = service.workspaceOf(agent)
        const [templates, workflows, runs] = await Promise.all([
          service.listTemplates(),
          service.listWorkflows(workspace),
          service.listRuns(workspace),
        ])
        const value: JsonValue = {
          templates: templates.map((t) => ({
            id: t.id,
            version: t.version,
            name: t.manifest.metadata.name,
            description: t.manifest.metadata.description ?? '',
            stateCount: t.config.workflow.states.length,
            parameters: (t.manifest.spec.parameters ?? []).map((p) => ({
              id: p.id,
              label: p.label,
              type: p.type,
              required: p.required ?? false,
              hasDefault: p.default !== undefined,
            })),
            agents: t.manifest.spec.dependencies?.agents ?? [],
          })),
          workflows: workflows.map((w) => ({
            fileName: w.fileName,
            name: w.summary.name,
            source: w.source,
            stateCount: w.summary.stateCount,
            stepCount: w.summary.stepCount,
            agents: w.summary.agentNames,
          })),
          runs: runs.map((r) => ({
            runId: r.id,
            workflowName: r.workflowName,
            status: r.status,
            currentState: r.currentState,
          })),
        }
        return value
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'run_workflow',
      description:
        '运行一个 ACE 状态机工作流：按 workflow 实例文件名或内置模板 id 启动，模板会先用参数实例化。每一步由专属角色的子 Agent 执行（defender/attacker/judge 对抗评审），verdict 驱动状态转移。wait=true 时同步等待终态并返回完整结果。',
      parameters: {
        workflow: {
          type: 'string',
          description: 'workflow 实例文件名（如 red-blue-review.yaml）或内置模板 id（如 general-red-blue-review）',
          required: true,
        },
        params: {
          type: 'json',
          description: '模板/任务参数（id → 值），例如 {"projectRoot": "...", "requirements": "..."}',
        },
        wait: {
          type: 'boolean',
          description: '是否同步等待运行结束；默认 false，立即返回 runId 与状态',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [
          { type: 'text', text: `工作流运行：\n${JSON.stringify(value, null, 2)}` },
        ],
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (!agent) throw new Error('run_workflow 工具调用缺少调用方 Agent')
        const params = (args.params as Record<string, unknown> | undefined) ?? {}
        const workspace = service.workspaceOf(agent)
        const target = args.workflow as string
        const values = Object.fromEntries(
          Object.entries(params).map(([key, value]) => [key, String(value)]),
        )

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
          if (!template) throw new Error(`未找到 workflow 实例或模板「${target}」`)
          const instantiated = await service.instantiate(target, undefined, values, {})
          workflow = { config: instantiated.config, configFile: target }
        }

        const handle = await service.startRun({
          parent: agent,
          signal: exec.signal,
          workflow,
          inputs: values,
          mode: args.wait === true ? 'foreground' : 'job',
        })
        if (args.wait === true) {
          const result = await handle.result
          const value: JsonValue = {
            runId: handle.runId,
            status: result.status,
            verdict: result.verdict ?? null,
            error: result.error,
            states: result.stateOutcomes.map((o) => ({ state: o.state, verdict: o.verdict.verdict })),
          }
          return value
        }
        const value: JsonValue = { runId: handle.runId, status: 'started', jobId: handle.jobId ?? null }
        return value
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'workflow_manage',
      description:
        '管理 ACE 工作流与运行：action=runs 列运行记录；action=show 查看一个运行的完整状态与各步结论；action=resume 恢复暂停/中断的运行；action=stop 停止运行中的实例；action=create 从内置模板创建 workflow 实例（可 save 保存到工作区 .dsh/workflows）。',
      parameters: {
        action: {
          type: 'string',
          description: 'runs | show | resume | stop | create',
          required: true,
        },
        runId: { type: 'string', description: '运行 id（show/resume/stop 时必填）' },
        templateId: { type: 'string', description: '内置模板 id（create 时必填）' },
        file: { type: 'string', description: 'create 并 save 时的实例文件名，默认 <templateId>.yaml' },
        params: { type: 'json', description: '模板参数（id → 值）' },
        save: { type: 'boolean', description: 'create 时是否保存为工作区 workflow 实例' },
        wait: { type: 'boolean', description: 'resume 时是否同步等待终态' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [
          { type: 'text', text: `工作流管理：\n${JSON.stringify(value, null, 2)}` },
        ],
      },
      async execute(args, exec): Promise<JsonValue> {
        const agent = exec.agent
        if (!agent) throw new Error('workflow_manage 工具调用缺少调用方 Agent')
        const workspace = service.workspaceOf(agent)
        const action = args.action as string
        const values = Object.fromEntries(
          Object.entries((args.params as Record<string, unknown> | undefined) ?? {}).map(([key, value]) => [
            key,
            String(value),
          ]),
        )
        switch (action) {
          case 'runs': {
            const runs = await service.listRuns(workspace)
            return {
              runs: runs.map((r) => ({
                runId: r.id,
                workflowName: r.workflowName,
                status: r.status,
                currentState: r.currentState,
              })),
            } as JsonValue
          }
          case 'show': {
            const runId = args.runId as string | undefined
            if (!runId) throw new Error('show 需要 runId')
            const state = await service.getRun(workspace, runId)
            if (!state) throw new Error(`未找到运行 ${runId}`)
            return { run: runJson(state) as JsonValue }
          }
          case 'resume': {
            const runId = args.runId as string | undefined
            if (!runId) throw new Error('resume 需要 runId')
            const handle = await service.resumeRun({
              parent: agent,
              signal: exec.signal,
              runId,
              mode: args.wait === true ? 'foreground' : 'job',
            })
            if (args.wait === true) {
              const result = await handle.result
              return {
                runId: handle.runId,
                status: result.status,
                verdict: result.verdict ?? null,
                error: result.error,
                states: result.stateOutcomes.map((o) => ({ state: o.state, verdict: o.verdict.verdict })),
              } as JsonValue
            }
            return { runId: handle.runId, status: 'resumed', jobId: handle.jobId ?? null }
          }
          case 'stop': {
            const runId = args.runId as string | undefined
            if (!runId) throw new Error('stop 需要 runId')
            return { runId, stopped: service.stopRun(runId) }
          }
          case 'create': {
            const templateId = args.templateId as string | undefined
            if (!templateId) throw new Error('create 需要 templateId')
            const instantiated = await service.instantiate(templateId, undefined, values, {})
            if (args.save === true) {
              const fileName = (args.file as string | undefined) ?? `${templateId}.yaml`
              const saved = await service.saveWorkflowConfig(workspace, fileName, instantiated.yamlText)
              return { created: true, saved, fileName, name: instantiated.config.workflow.name }
            }
            return {
              created: true,
              name: instantiated.config.workflow.name,
              yaml: instantiated.yamlText,
            }
          }
          default:
            throw new Error(`未知 action「${action}」：runs | show | resume | stop | create`)
        }
      },
    }),
  )
}
