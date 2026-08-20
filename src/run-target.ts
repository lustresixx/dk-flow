/**
 * Run-target resolution: one implementation of "workflow instance or
 * built-in template → runnable config + complete input values" (P1-1).
 * The interactive entries (`/workflow run`, `run_workflow`) share this
 * orchestration and render the failure reasons in their own words; the
 * REST API resolves the same references without asking.
 * @module dsh-ace-harness/run-target
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { latestTemplate, type BuiltinWorkflowTemplate } from './catalog/index.js'
import type { TemplateParameter, WorkflowConfig, WorkflowTaskInputField } from './dsl/types.js'
import { askMissingParameters, askMissingTaskInputs } from './params-dialog.js'
import type AceHarnessService from './service.js'

/** Outcome of resolving one run target reference. */
export type RunTargetResolution =
  | {
      ok: true
      workflow: { config: WorkflowConfig; configFile: string }
      /** Caller-supplied values merged with the answers to the asks. */
      values: Record<string, string>
    }
  | { ok: false; reason: 'not-found'; target: string; templateIds: string[] }
  | {
      ok: false
      reason: 'missing-instance-fields'
      target: string
      missing: WorkflowTaskInputField[]
      /** All declared taskInput fields (callers render usage hints from them). */
      fields: WorkflowTaskInputField[]
    }
  | {
      ok: false
      reason: 'missing-template-params'
      target: string
      template: BuiltinWorkflowTemplate
      missing: TemplateParameter[]
    }

/**
 * Resolve a workflow reference (instance file name or template id) into a
 * runnable config, asking for missing required inputs through the
 * user-questions dialog. Asking is best-effort: a headless environment
 * settles the corresponding failure reason and the caller renders it.
 */
export async function resolveRunTarget(input: {
  ctx: Context
  agent: Agent
  signal: AbortSignal
  service: AceHarnessService
  workspace: string
  target: string
  values: Record<string, string>
}): Promise<RunTargetResolution> {
  const { ctx, agent, signal, service, workspace, target, values } = input
  const instance = await service.loadWorkflowConfig(workspace, target)
  if (instance) {
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
        return { ok: false, reason: 'missing-instance-fields', target, missing: missingFields, fields: taskFields }
      }
      Object.assign(values, filled)
    }
    return { ok: true, workflow: { config: instance.config, configFile: instance.file }, values }
  }
  const templates = await service.listTemplates()
  const template = latestTemplate(templates, target)
  if (!template) {
    return { ok: false, reason: 'not-found', target, templateIds: templates.map((entry) => entry.id) }
  }
  const missing = (template.manifest.spec.parameters ?? []).filter(
    (parameter) => parameter.required && values[parameter.id] === undefined && parameter.default === undefined,
  )
  if (missing.length > 0) {
    const filled = await askMissingParameters(
      ctx,
      agent,
      signal,
      template.manifest,
      missing.map((parameter) => parameter.id),
    )
    if (!filled) {
      return { ok: false, reason: 'missing-template-params', target, template, missing }
    }
    Object.assign(values, filled)
  }
  const instantiated = await service.instantiate(target, undefined, values, {})
  return { ok: true, workflow: { config: instantiated.config, configFile: target }, values }
}
