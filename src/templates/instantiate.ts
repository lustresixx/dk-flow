/**
 * Template instantiation: bind manifest parameters into a workflow document
 * through JSON Pointer paths, apply agent substitutions, and validate the
 * result. Ports the ACE template instantiation flow from
 * `docs/workflow-templates.md`.
 * @module dsh-ace-harness/templates
 */
import { parse, stringify } from 'yaml'
import { pointerSet } from '../dsl/json-pointer.js'
import { parseTemplateManifest, validateWorkflowReferences } from '../dsl/load.js'
import { workflowConfigSchema } from '../dsl/schema.js'
import type { WorkflowConfig, WorkflowTemplateManifest } from '../dsl/types.js'

/** Raised when template instantiation fails validation or binding. */
export class TemplateInstantiationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateInstantiationError'
  }
}

/** Parameter values supplied by the user, keyed by manifest parameter id. */
export type TemplateParameterValues = Record<string, unknown>

/** Replacements for missing agents, keyed by template agent name. */
export type AgentSubstitutions = Record<string, string>

/**
 * Bind a parameter value into the raw workflow document.
 */
function bindParameter(
  document: Record<string, unknown>,
  parameter: NonNullable<WorkflowTemplateManifest['spec']['parameters']>[number],
  values: TemplateParameterValues,
): void {
  const provided = values[parameter.id]
  const value = provided === undefined ? parameter.default : provided
  if (value === undefined) {
    if (parameter.required) {
      throw new TemplateInstantiationError(`参数「${parameter.label}」为必填项`)
    }
    return
  }
  if (parameter.type === 'enum' && parameter.options) {
    const allowed = new Set(parameter.options.map((option) => option.value))
    if (!allowed.has(String(value))) {
      throw new TemplateInstantiationError(
        `参数「${parameter.label}」的值必须为 ${[...allowed].join(' / ')}`,
      )
    }
  }
  pointerSet(document, parameter.bind, value)
}

/** Apply agent substitutions across states, steps, and the supervisor. */
function substituteAgents(
  config: WorkflowConfig,
  substitutions: AgentSubstitutions,
): WorkflowConfig {
  const mapped = (name: string | undefined): string | undefined =>
    name === undefined ? name : (substitutions[name] ?? name)
  const workflow = config.workflow
  const supervisor = workflow.supervisor
  if (supervisor && supervisor.agent) supervisor.agent = mapped(supervisor.agent)!
  for (const state of workflow.states) {
    for (const step of state.steps) {
      if (step.type !== 'subworkflow' && step.agent) step.agent = mapped(step.agent)!
    }
  }
  return config
}

export interface InstantiatedWorkflow {
  /** The validated instantiated config. */
  config: WorkflowConfig
  /** The instantiated document as YAML text, ready to save as a new workflow. */
  yamlText: string
}

/**
 * Instantiate a workflow from a template package.
 * @param manifestText - the template manifest YAML.
 * @param workflowYamlText - the template workflow YAML.
 * @param values - user-supplied parameter values.
 * @param substitutions - agent replacements for missing agents.
 * @param knownAgents - agent names available in this deployment.
 * @returns the validated instance and its YAML text.
 */
export function instantiateTemplate(
  manifestText: string,
  workflowYamlText: string,
  values: TemplateParameterValues,
  substitutions: AgentSubstitutions,
  knownAgents: ReadonlySet<string>,
): InstantiatedWorkflow {
  const manifest = parseTemplateManifest(manifestText)
  let document: unknown
  try {
    document = parse(workflowYamlText)
  } catch (error) {
    throw new TemplateInstantiationError(`模板 workflow YAML 解析失败: ${(error as Error).message}`)
  }
  if (typeof document !== 'object' || document === null) {
    throw new TemplateInstantiationError('模板 workflow YAML 根节点必须是对象')
  }
  for (const parameter of manifest.spec.parameters ?? []) {
    bindParameter(document as Record<string, unknown>, parameter, values)
  }
  const parsed = workflowConfigSchema.safeParse(document)
  if (!parsed.success) {
    throw new TemplateInstantiationError(
      `实例化后的 workflow 校验失败: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    )
  }
  const config = substituteAgents(parsed.data, substitutions)
  const referenceErrors = validateWorkflowReferences(config, knownAgents)
  if (referenceErrors.length > 0) {
    throw new TemplateInstantiationError(referenceErrors.join('; '))
  }
  const yamlText = stringify(document as Record<string, unknown>)
  return { config, yamlText }
}

/** Collect the agents a template declares as dependencies. */
export function templateAgentDependencies(manifest: WorkflowTemplateManifest): string[] {
  return manifest.spec.dependencies?.agents ?? []
}
