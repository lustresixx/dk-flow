import { describe, expect, it } from 'vitest'
import { listBuiltinScripts, loadBuiltinAgents, loadBuiltinTemplates } from '../src/catalog/index.js'
import { validateWorkflowReferences } from '../src/dsl/load.js'
import { instantiateTemplate } from '../src/templates/instantiate.js'

describe('built-in catalog', () => {
  it('ships the selected ACE agent roster', async () => {
    const agents = await loadBuiltinAgents()
    const names = agents.map((a) => a.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'default-supervisor',
        'architect',
        'solution-breaker',
        'design-judge',
        'developer',
        'code-hunter',
        'code-judge',
        'tester',
        'stress-tester',
        'documentation-writer',
        'issue-reproducer',
        'researcher',
        'product-manager',
      ]),
    )
    for (const agent of agents) {
      expect(agent.systemPrompt.length).toBeGreaterThan(50)
      expect(['blue', 'red', 'judge', 'black-gold']).toContain(agent.team)
    }
  })

  it('ships the reusable built-in script library with one-line descriptions', async () => {
    const scripts = await listBuiltinScripts()
    expect(scripts.map((script) => script.name)).toEqual(
      expect.arrayContaining(['to-upper.js', 'text-stats.py']),
    )
    for (const script of scripts) {
      expect(script.description.length).toBeGreaterThan(0)
    }
  })

  it('ships the seven built-in workflow templates, all reference-consistent', async () => {
    const templates = await loadBuiltinTemplates()
    expect(templates.map((t) => t.id)).toEqual(
      expect.arrayContaining([
        'general-red-blue-review',
        'issue-fix',
        'software-delivery',
        'simple-script-pipeline',
        'code-optimization-review',
        'mixed-agent-script',
        'simple-llm-qa',
        'architecture-refactor-review',
      ]),
    )
    const agents = await loadBuiltinAgents()
    const known = new Set(agents.map((a) => a.name))
    for (const template of templates) {
      const errors = validateWorkflowReferences(template.config, known)
      expect(errors, `${template.id} has reference errors`).toEqual([])
    }
    // The script pipeline uses binary success/fail transitions and no agents.
    const pipeline = templates.find((t) => t.id === 'simple-script-pipeline')!
    for (const state of pipeline.config.workflow.states) {
      for (const transition of state.transitions) {
        expect(['success', 'fail']).toContain(transition.condition.verdict)
      }
    }
    // The optimization review covers the full seven-role pipeline.
    const review = templates.find((t) => t.id === 'code-optimization-review')!
    expect(review.config.workflow.states.map((s) => s.name)).toEqual([
      '提出方案',
      '资料调研',
      '对抗挑战',
      '敲定需求',
      '代码优化',
      '测试验证',
      '最终评审',
      '交付汇总',
    ])
    const allSteps = review.config.workflow.states.flatMap((s) => s.steps)
    expect(allSteps.map((s) => s.agent)).toEqual([
      'architect',
      'researcher',
      'solution-breaker',
      'product-manager',
      'developer',
      'tester',
      'code-judge',
      'documentation-writer',
    ])
    // The mixed template alternates script and agent steps, Dify-style.
    const mixed = templates.find((t) => t.id === 'mixed-agent-script')!
    const mixedSteps = mixed.config.workflow.states
      .filter((s) => !s.isFinal || s.name === '汇总输出')
      .flatMap((s) => s.steps)
    expect(mixedSteps.map((s) => s.type ?? 'agent')).toEqual([
      'script',
      'agent',
      'script',
      'agent',
      'script',
    ])
    expect(mixedSteps.map((s) => s.agent ?? null)).toEqual([null, 'architect', null, 'code-judge', null])
    // The LLM template runs two bare llm nodes with no agents, then a script summary.
    const qa = templates.find((t) => t.id === 'simple-llm-qa')!
    const qaSteps = qa.config.workflow.states
      .filter((s) => s.name === '快速判断' || s.name === '提炼要点')
      .flatMap((s) => s.steps)
    expect(qaSteps.map((s) => s.type)).toEqual(['llm', 'llm'])
    expect(qaSteps.map((s) => s.agent ?? null)).toEqual([null, null])
    expect(qa.config.workflow.states[0]!.steps[0]!.role).toBe('judge')
    // The architecture review pairs adversarial agents with two human approval gates.
    const arch = templates.find((t) => t.id === 'architecture-refactor-review')!
    expect(arch.config.workflow.states.map((s) => s.name)).toEqual([
      '架构诊断',
      '调研对标',
      '对抗挑战',
      '方案定稿',
      '行为基线',
      '实施改造',
      '回归验证',
      '对抗审查',
      '终审',
      '交付汇总',
    ])
    const archSteps = arch.config.workflow.states.flatMap((s) => s.steps)
    expect(archSteps.map((s) => s.agent)).toEqual([
      'architect',
      'researcher',
      'solution-breaker',
      'design-judge',
      'tester',
      'developer',
      'tester',
      'code-hunter',
      'code-judge',
      'documentation-writer',
    ])
    const approvalStates = arch.config.workflow.states.filter((s) => s.requireHumanApproval === true)
    expect(approvalStates.map((s) => s.name)).toEqual(['方案定稿', '终审'])
    expect(arch.config.workflow.states[3]!.steps[0]!.role).toBe('judge')
    expect(arch.config.workflow.states[4]!.steps[0]!.role).toBe('defender')
  })
})

describe('instantiateTemplate', () => {
  async function sources() {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const base = fileURLToPath(new URL('../resources/workflows/general-red-blue-review/1.0.0/', import.meta.url))
    return {
      manifestText: await readFile(`${base}/manifest.yaml`, 'utf8'),
      workflowYamlText: await readFile(`${base}/workflow.yaml`, 'utf8'),
    }
  }

  it('binds parameters and yields a valid instance', async () => {
    const { manifestText, workflowYamlText } = await sources()
    const known = new Set([
      'default-supervisor',
      'architect',
      'solution-breaker',
      'design-judge',
      'developer',
      'code-hunter',
      'code-judge',
      'tester',
      'stress-tester',
      'documentation-writer',
    ])
    const { config, yamlText } = instantiateTemplate(
      manifestText,
      workflowYamlText,
      { workflowName: '我的评审', projectRoot: '/proj', workspaceMode: 'in-place', requirements: '评审 X' },
      {},
      known,
    )
    expect(config.workflow.name).toBe('我的评审')
    expect(config.context?.projectRoot).toBe('/proj')
    expect(yamlText).toContain('我的评审')
  })

  it('defers unprovided required parameters to run-time taskInput fields', async () => {
    const { manifestText, workflowYamlText } = await sources()
    const known = new Set([
      'default-supervisor',
      'architect',
      'solution-breaker',
      'design-judge',
      'developer',
      'code-hunter',
      'code-judge',
      'tester',
      'stress-tester',
      'documentation-writer',
    ])
    const { config, yamlText, pendingParams } = instantiateTemplate(manifestText, workflowYamlText, {}, {}, known)
    expect(pendingParams.map((p) => p.id)).toEqual(['projectRoot'])
    expect(config.context?.taskInput?.fields?.map((f) => f.id)).toContain('projectRoot')
    expect(yamlText).toContain('taskInput')
    expect(yamlText).toContain('projectRoot')
  })

  it('defers requirements without duplicating an existing taskInput field', async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const base = fileURLToPath(new URL('../resources/workflows/mixed-agent-script/1.0.0/', import.meta.url))
    const manifestText = await readFile(`${base}/manifest.yaml`, 'utf8')
    const workflowYamlText = await readFile(`${base}/workflow.yaml`, 'utf8')
    const known = new Set(['default-supervisor', 'architect', 'code-judge'])
    const { config, pendingParams } = instantiateTemplate(manifestText, workflowYamlText, {}, {}, known)
    expect(pendingParams.map((p) => p.id)).toEqual(['requirements'])
    const fields = config.context?.taskInput?.fields ?? []
    expect(fields.filter((field) => field.id === 'requirements')).toHaveLength(1)
  })

  it('rejects invalid enum values', async () => {
    const { manifestText, workflowYamlText } = await sources()
    const known = new Set<string>()
    expect(() =>
      instantiateTemplate(
        manifestText,
        workflowYamlText,
        { projectRoot: '/p', workspaceMode: 'sideways' },
        {},
        known,
      ),
    ).toThrow(/必须为/)
  })

  it('rejects instances whose agents are unknown after substitution', async () => {
    const { manifestText, workflowYamlText } = await sources()
    const known = new Set(['architect'])
    expect(() =>
      instantiateTemplate(
        manifestText,
        workflowYamlText,
        { projectRoot: '/p' },
        {},
        known,
      ),
    ).toThrow(/未知 Agent/)
  })
})
