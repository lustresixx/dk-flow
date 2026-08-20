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
import type { WorkflowConfig, WorkflowTaskInputField, WorkflowTemplateManifest } from '../dsl/types.js'

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
 * @returns true when the parameter was bound (value or non-empty default);
 *   false when it stays unbound so the caller can defer it to run time.
 */
function bindParameter(
  document: Record<string, unknown>,
  parameter: NonNullable<WorkflowTemplateManifest['spec']['parameters']>[number],
  values: TemplateParameterValues,
): boolean {
  const provided = values[parameter.id]
  if (provided === undefined) {
    // An empty-string default is a placeholder, not a real value: such
    // parameters stay unbound and are asked at run time.
    if (parameter.default !== undefined && parameter.default !== '') {
      pointerSet(document, parameter.bind, parameter.default)
      return true
    }
    return false
  }
  if (parameter.type === 'enum' && parameter.options) {
    const allowed = new Set(parameter.options.map((option) => option.value))
    if (!allowed.has(String(provided))) {
      throw new TemplateInstantiationError(
        `参数「${parameter.label}」的值必须为 ${[...allowed].join(' / ')}`,
      )
    }
  }
  pointerSet(document, parameter.bind, provided)
  return true
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
  /**
   * Required parameters that were not supplied at instantiation time. Each
   * was appended to `context.taskInput.fields`, so the workflow asks for it
   * when it runs instead of failing creation.
   */
  pendingParams: { id: string; label: string }[]
}

/**
 * Instantiate a workflow from a template package.
 *
 * Parameters supplied here are baked into the document. Required parameters
 * left empty are NOT an error: they become runtime taskInput fields, so the
 * workflow asks for them at every run.
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
  const pendingParams: { id: string; label: string }[] = []
  for (const parameter of manifest.spec.parameters ?? []) {
    const bound = bindParameter(document as Record<string, unknown>, parameter, values)
    if (!bound && parameter.required) {
      pendingParams.push({ id: parameter.id, label: parameter.label })
    }
  }
  // Deferred required parameters become runtime taskInput fields so the run
  // path can ask for them interactively.
  if (pendingParams.length > 0) {
    const root = document as {
      context?: { taskInput?: { fields?: WorkflowTaskInputField[] } }
    }
    const context = (root.context ??= {})
    const taskInput = (context.taskInput ??= {})
    const fields = (taskInput.fields ??= [])
    const existing = new Set(fields.map((field) => field.id))
    for (const parameter of pendingParams) {
      if (existing.has(parameter.id)) continue
      const definition = (manifest.spec.parameters ?? []).find((candidate) => candidate.id === parameter.id)
      fields.push({
        id: parameter.id,
        label: parameter.label,
        type: definition?.type === 'text' ? 'textarea' : 'text',
        required: true,
        description: definition?.description,
        placeholder: definition?.description,
      })
    }
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
  return { config, yamlText, pendingParams }
}

/** Collect the agents a template declares as dependencies. */
export function templateAgentDependencies(manifest: WorkflowTemplateManifest): string[] {
  return manifest.spec.dependencies?.agents ?? []
}
