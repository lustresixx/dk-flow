/**
 * YAML loading and validation for workflow configs and template manifests.
 * @module dsh-ace-harness/dsl
 */
import { parse } from 'yaml'
import {
  workflowConfigSchema,
  workflowTemplateManifestSchema,
} from './schema.js'
import type { WorkflowConfig, WorkflowTemplateManifest } from './types.js'

/** Raised when a workflow document fails schema validation. */
export class WorkflowConfigError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message)
    this.name = 'WorkflowConfigError'
  }
}

function describeIssues(error: { issues?: { path: PropertyKey[]; message: string }[] }): string[] {
  return (error.issues ?? []).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    return `${path}: ${issue.message}`
  })
}

/**
 * Parse and validate one `workflow.yaml` document.
 * @param text - raw YAML text.
 * @returns the validated workflow config.
 * @throws {WorkflowConfigError} on YAML or schema errors, with issue details.
 */
export function parseWorkflowYaml(text: string): WorkflowConfig {
  let raw: unknown
  try {
    raw = parse(text)
  } catch (error) {
    throw new WorkflowConfigError(`workflow YAML 解析失败: ${(error as Error).message}`)
  }
  const result = workflowConfigSchema.safeParse(raw)
  if (!result.success) {
    const issues = describeIssues(result.error)
    throw new WorkflowConfigError(
      issues.length > 0 ? `workflow 配置校验失败: ${issues.join('; ')}` : 'workflow 配置校验失败',
      issues,
    )
  }
  return result.data
}

/**
 * Parse and validate one template `manifest.yaml` document.
 * @throws {WorkflowConfigError} on YAML or schema errors.
 */
export function parseTemplateManifest(text: string): WorkflowTemplateManifest {
  let raw: unknown
  try {
    raw = parse(text)
  } catch (error) {
    throw new WorkflowConfigError(`manifest YAML 解析失败: ${(error as Error).message}`)
  }
  const result = workflowTemplateManifestSchema.safeParse(raw)
  if (!result.success) {
    throw new WorkflowConfigError('manifest 校验失败', describeIssues(result.error))
  }
  return result.data
}

/** Compact display summary of one workflow config. */
export interface WorkflowSummary {
  name: string
  description: string
  stateCount: number
  stepCount: number
  agentNames: string[]
  isLightweight: boolean
  maxTransitions: number
}

/** Derive the summary card fields for a workflow config. */
export function summarizeWorkflow(config: WorkflowConfig): WorkflowSummary {
  const agents = new Set<string>()
  let stepCount = 0
  for (const state of config.workflow.states) {
    stepCount += state.steps.length
    for (const step of state.steps) {
      if (step.type !== 'subworkflow' && step.agent) agents.add(step.agent)
    }
  }
  return {
    name: config.workflow.name,
    description: config.workflow.description ?? '',
    stateCount: config.workflow.states.length,
    stepCount,
    agentNames: [...agents],
    isLightweight: config.workflow.profile === 'lightweight',
    maxTransitions: config.workflow.maxTransitions ?? 50,
  }
}

/**
 * Find the initial state of a validated config. Configs always declare one.
 */
export function initialStates(config: WorkflowConfig): string[] {
  return config.workflow.states.filter((state) => state.isInitial).map((state) => state.name)
}

/**
 * Check that a workflow config names only states and agents that exist.
 * Returns human-readable errors; empty means the config is internally consistent.
 */
export function validateWorkflowReferences(
  config: WorkflowConfig,
  knownAgents: ReadonlySet<string>,
): string[] {
  const errors: string[] = []
  const stateNames = new Set(config.workflow.states.map((state) => state.name))
  const initials = initialStates(config)
  if (initials.length !== 1) {
    errors.push(`workflow 必须且只能有一个 isInitial 状态，实际有 ${initials.length} 个`)
  }
  for (const state of config.workflow.states) {
    for (const step of state.steps) {
      if (step.type === 'subworkflow' || step.type === 'script') continue
      const agent = step.agent ?? ''
      if (!knownAgents.has(agent)) {
        errors.push(`状态「${state.name}」步骤「${step.name}」引用了未知 Agent「${agent}」`)
      }
    }
    for (const transition of state.transitions) {
      if (!stateNames.has(transition.to)) {
        errors.push(`状态「${state.name}」的转移指向未知状态「${transition.to}」`)
      }
    }
  }
  const supervisor = config.workflow.supervisor
  if (supervisor && supervisor.agent && !knownAgents.has(supervisor.agent)) {
    errors.push(`supervisor 引用了未知 Agent「${supervisor.agent}」`)
  }
  return errors
}
