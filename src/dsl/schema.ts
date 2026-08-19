/**
 * Zod schemas for the ACE-compatible workflow DSL. Field names, defaults, and
 * validation messages follow ACEHarness `src/lib/core/schemas.ts`.
 *
 * @module dsh-ace-harness/dsl
 */
import { z } from 'zod'

export const agentTeamSchema = z.enum(['blue', 'red', 'judge', 'black-gold'])
export const agentRoleTypeSchema = z.enum(['normal', 'supervisor'])

export const agentDefinitionSchema = z.object({
  name: z.string().min(1),
  team: agentTeamSchema,
  roleType: agentRoleTypeSchema.default('normal'),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  baseCapability: z.string().optional(),
  taskModes: z.array(z.string().min(1)).max(16).default([]),
  temperature: z.number().optional(),
  allowedTools: z.array(z.string()).optional(),
  capabilities: z.array(z.string()).default([]),
  systemPrompt: z.string().min(1),
  constraints: z.array(z.string()).optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
})

export const workflowSupervisorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  agent: z.string().min(1).default('default-supervisor'),
  stageReviewEnabled: z.boolean().default(true),
  stageReviewAsync: z.boolean().default(true),
  checkpointAdviceEnabled: z.boolean().default(true),
  scoringEnabled: z.boolean().default(true),
  experienceEnabled: z.boolean().default(true),
}).optional()

export const reviewPolicySchema = z.object({
  mode: z.enum(['standard', 'adversarial']),
  source: z.enum(['ai', 'user', 'legacy', 'default']),
  locked: z.boolean().default(false),
  confidence: z.enum(['high', 'medium', 'low']),
  riskSignals: z.array(z.string()).default([]),
  rationale: z.string().default(''),
})

export const joinPolicySchema = z.object({
  mode: z.enum(['all', 'any', 'quorum', 'manual']).default('all'),
  quorum: z.number().int().min(1).optional(),
  timeoutMinutes: z.number().min(1).optional(),
  onTimeout: z.enum(['continue', 'fail', 'manual-review']).optional(),
})

export const stepConcurrencySchema = z.object({
  groupId: z.string().optional(),
  branchId: z.string().optional(),
  joinPolicy: joinPolicySchema.optional(),
})

export const issueSchema = z.object({
  id: z.string().optional(),
  type: z.enum(['design', 'implementation', 'test', 'performance', 'security']),
  severity: z.enum(['critical', 'major', 'minor']),
  description: z.string(),
  foundInState: z.string().optional(),
  foundByAgent: z.string().optional(),
  targetState: z.string().optional(),
})

export const transitionConditionSchema = z.object({
  verdict: z.enum(['success', 'pass', 'conditional_pass', 'fail']).optional(),
  issueTypes: z.array(z.enum(['design', 'implementation', 'test', 'performance', 'security'])).optional(),
  severities: z.array(z.enum(['critical', 'major', 'minor'])).optional(),
  minIssueCount: z.number().optional(),
  maxIssueCount: z.number().optional(),
  custom: z.string().optional(),
})

export const stateTransitionSchema = z.object({
  to: z.string().min(1, '目标状态不能为空'),
  condition: transitionConditionSchema,
  priority: z.number().default(100),
  label: z.string().optional(),
})

export const subworkflowInputsSchema = z.object({
  requirements: z.union([z.literal('inherit'), z.string()]).default('inherit').optional(),
  workspace: z.enum(['inherit', 'child-isolated-copy', 'config']).default('inherit').optional(),
  context: z.enum(['inherit', 'none', 'custom']).default('inherit').optional(),
  stateContexts: z.enum(['inherit', 'none', 'relevant']).default('relevant').optional(),
  skills: z.enum(['inherit', 'merge', 'child-only', 'parent-only']).default('merge').optional(),
}).optional()

export const subworkflowResultMappingSchema = z.object({
  completed: z.enum(['pass', 'conditional_pass', 'fail']).default('pass').optional(),
  failed: z.enum(['pass', 'conditional_pass', 'fail']).default('fail').optional(),
  stopped: z.enum(['pass', 'conditional_pass', 'fail']).default('fail').optional(),
  crashed: z.enum(['pass', 'conditional_pass', 'fail']).default('fail').optional(),
}).optional()

export const subworkflowRuntimeSchema = z.object({
  timeoutMinutes: z.number().min(1).optional(),
  timeoutStrategy: z.enum(['stop', 'ask-human']).default('stop').optional(),
  maxDepth: z.number().int().min(1).max(8).optional(),
}).optional()

export const subworkflowReferenceSchema = z.object({
  configFile: z.string().min(1, '子工作流配置不能为空'),
  inputs: subworkflowInputsSchema,
  result: subworkflowResultMappingSchema,
  runtime: subworkflowRuntimeSchema,
})

export const workflowStepSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1, '步骤名称不能为空'),
  agent: z.string().optional(),
  task: z.string().optional(),
  preCommands: z.array(z.string()).optional(),
  type: z.enum(['agent', 'script', 'subworkflow']).optional(),
  workflow: z.string().optional(),
  subworkflow: subworkflowReferenceSchema.partial().optional(),
  script: z.string().optional(),
  inputs: subworkflowInputsSchema.optional(),
  result: subworkflowResultMappingSchema.optional(),
  runtime: subworkflowRuntimeSchema.optional(),
  role: z.enum(['attacker', 'defender', 'judge']).optional(),
  constraints: z.array(z.string()).optional(),
  parallelGroup: z.string().optional(),
  concurrency: stepConcurrencySchema.optional(),
  skills: z.array(z.string().min(1)).optional(),
}).superRefine((step, ctx) => {
  if (step.type === 'subworkflow') {
    const configFile = step.workflow?.trim() || step.subworkflow?.configFile?.trim()
    if (!configFile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['workflow'],
        message: '子工作流步骤必须设置 workflow 或 subworkflow.configFile',
      })
    }
    return
  }
  if (step.type === 'script') {
    if (!step.script?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['script'],
        message: '脚本步骤必须设置 script',
      })
    }
    return
  }
  if (!step.agent?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['agent'],
      message: 'Agent 名称不能为空',
    })
  }
  if (!step.task?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['task'],
      message: '任务描述不能为空',
    })
  }
})

export const stateMachineStateSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1, '状态名称不能为空'),
  description: z.string().optional(),
  requireHumanApproval: z.boolean().default(false).optional(),
  steps: z.array(workflowStepSchema),
  transitions: z.array(stateTransitionSchema),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  isInitial: z.boolean().default(false),
  isFinal: z.boolean().default(false),
  maxSelfTransitions: z.number().min(1).max(100).optional(),
  reviewPolicy: reviewPolicySchema.optional(),
  executionMode: z.enum(['sequential', 'parallel']).optional(),
  joinPolicy: joinPolicySchema.optional(),
})

export const workflowTaskInputFieldSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['text', 'textarea', 'url']).default('text').optional(),
  required: z.boolean().default(false).optional(),
  placeholder: z.string().optional(),
  description: z.string().optional(),
})

export const workflowContextConfigSchema = z.object({
  projectRoot: z.string().optional(),
  workspaceMode: z.enum(['isolated-copy', 'in-place']).optional(),
  requirements: z.string().optional(),
  taskInput: z.object({
    fields: z.array(workflowTaskInputFieldSchema).default([]).optional(),
  }).optional(),
  timeoutMinutes: z.number().min(1).optional(),
  gitBaselineEnabled: z.boolean().optional(),
})

export const workflowDefinitionSchema = z.object({
  name: z.string().min(1, '工作流名称不能为空'),
  description: z.string().optional(),
  mode: z.literal('state-machine'),
  profile: z.literal('lightweight').optional(),
  states: z.array(stateMachineStateSchema).min(1, '至少需要一个状态'),
  maxTransitions: z.number().min(1).max(100).default(50),
  supervisor: workflowSupervisorConfigSchema,
})

export const workflowConfigSchema = z.object({
  workflow: workflowDefinitionSchema,
  context: workflowContextConfigSchema.optional(),
})

export const templateParameterSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['string', 'text', 'directory', 'enum', 'boolean', 'number']),
  bind: z.string().min(1),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  description: z.string().optional(),
  options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
})

export const workflowTemplateManifestSchema = z.object({
  apiVersion: z.string(),
  kind: z.literal('WorkflowTemplate'),
  metadata: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    featured: z.boolean().optional(),
  }),
  spec: z.object({
    entrypoint: z.string().min(1),
    mode: z.string(),
    compatibility: z.object({ aceharness: z.string().optional() }).optional(),
    parameters: z.array(templateParameterSchema).optional(),
    dependencies: z.object({
      agents: z.array(z.string()).optional(),
      skills: z.array(z.string()).optional(),
      subworkflows: z.array(z.string()).optional(),
    }).optional(),
  }),
})
