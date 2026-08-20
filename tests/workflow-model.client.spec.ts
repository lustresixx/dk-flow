// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  configToGraph,
  configToYaml,
  draftToStep,
  graphToConfig,
  newState,
  replaceSteps,
  stepToDraft,
  yamlToConfig,
} from '../src/client/workflow-model.ts'
import type { WorkflowConfig } from '../src/dsl/types.ts'

const config: WorkflowConfig = {
  workflow: {
    name: '红蓝评审',
    mode: 'state-machine',
    states: [
      {
        name: '方案',
        description: '设计方案',
        steps: [
          { name: '方案设计', agent: 'architect', role: 'defender', task: '设计' },
          { name: '方案挑战', agent: 'solution-breaker', role: 'attacker', task: '挑战', parallelGroup: 'g' },
          { name: '方案裁决', agent: 'design-judge', role: 'judge', task: '裁决' },
        ],
        transitions: [
          { to: '执行', condition: { verdict: 'pass' }, priority: 10, label: '通过' },
          { to: '方案', condition: { verdict: 'conditional_pass' }, priority: 20 },
        ],
        position: { x: 10, y: 20 },
        isInitial: true,
        isFinal: false,
      },
      {
        name: '执行',
        steps: [{ name: '任务执行', agent: 'developer', role: 'defender', task: '执行' }],
        transitions: [],
        isInitial: false,
        isFinal: true,
      },
    ],
  },
}

describe('workflow-model', () => {
  it('round-trips a config through nodes and edges', () => {
    const { nodes, edges } = configToGraph(config)
    expect(nodes).toHaveLength(2)
    expect(edges).toHaveLength(2)
    const restored = graphToConfig(nodes, edges, config)
    expect(restored.workflow.states).toHaveLength(2)
    const plan = restored.workflow.states.find((state) => state.name === '方案')!
    expect(plan.position).toEqual({ x: 10, y: 20 })
    expect(plan.transitions).toHaveLength(2)
    expect(plan.transitions[0]).toMatchObject({ to: '执行', condition: { verdict: 'pass' }, priority: 10, label: '通过' })
    expect(plan.steps.map((step) => step.name)).toEqual(['方案设计', '方案挑战', '方案裁决'])
  })

  it('keeps moved node positions and dropped transitions out of the round trip', () => {
    const { nodes, edges } = configToGraph(config)
    nodes[0]!.position = { x: 300, y: 400 }
    const restored = graphToConfig(nodes, edges.slice(0, 1), config)
    const plan = restored.workflow.states.find((state) => state.name === '方案')!
    expect(plan.position).toEqual({ x: 300, y: 400 })
    expect(plan.transitions).toHaveLength(1)
    expect(restored.workflow.states.find((state) => state.name === '执行')!.transitions).toEqual([])
  })

  it('auto-places states without positions', () => {
    const bare: WorkflowConfig = JSON.parse(JSON.stringify(config)) as WorkflowConfig
    delete bare.workflow.states[0]!.position
    delete bare.workflow.states[1]!.position
    const { nodes } = configToGraph(bare)
    expect(nodes[0]!.position.x).toBeGreaterThanOrEqual(0)
    expect(nodes[1]!.position.x).toBeGreaterThanOrEqual(0)
    expect(nodes[0]!.position).not.toEqual(nodes[1]!.position)
  })

  it('round-trips yaml through the host DSL', () => {
    const yaml = configToYaml(config)
    const parsed = yamlToConfig(yaml)
    expect(parsed.workflow.name).toBe('红蓝评审')
    expect(parsed.workflow.states).toHaveLength(2)
  })

  it('converts steps to drafts and back without losing semantics', () => {
    const step = config.workflow.states[0]!.steps[1]!
    const draft = stepToDraft(step)
    expect(draft).toMatchObject({ name: '方案挑战', agent: 'solution-breaker', role: 'attacker', parallelGroup: 'g' })
    const restored = draftToStep(draft)
    expect(restored).toMatchObject({
      name: '方案挑战',
      agent: 'solution-breaker',
      role: 'attacker',
      parallelGroup: 'g',
      task: '挑战',
    })
  })

  it('round-trips llm steps through drafts', () => {
    const step = { name: '快速判定', type: 'llm', model: 'fast-model', task: '判断' } as const
    const draft = stepToDraft(step)
    expect(draft).toMatchObject({ type: 'llm', model: 'fast-model', task: '判断' })
    const restored = draftToStep(draft)
    expect(restored).toMatchObject({ name: '快速判定', type: 'llm', model: 'fast-model', task: '判断' })
    expect(restored.agent).toBeUndefined()
  })

  it('round-trips scriptFile, timeoutMinutes, and retry through drafts', () => {
    const step = {
      name: 'py',
      type: 'script',
      scriptFile: 'scripts/analyze.py',
      timeoutMinutes: 5,
      retry: { maxRetries: 2, backoffMs: 500 },
    } as const
    const draft = stepToDraft(step)
    expect(draft).toMatchObject({ scriptFile: 'scripts/analyze.py', timeoutMinutes: '5', maxRetries: '2', backoffMs: '500' })
    const restored = draftToStep(draft)
    expect(restored).toMatchObject({
      type: 'script',
      scriptFile: 'scripts/analyze.py',
      timeoutMinutes: 5,
      retry: { maxRetries: 2, backoffMs: 500 },
    })
    expect(restored.script).toBeUndefined()
  })

  it('creates new states placed after existing nodes and replaces steps in order', () => {
    const { nodes } = configToGraph(config)
    const state = newState(nodes, '新状态')
    expect(state.position.x).toBeGreaterThan(260)
    expect(state.isInitial).toBe(false)
    const withSteps = replaceSteps(state, [
      stepToDraft({ name: 'a', agent: 'architect', task: 'A' }),
      stepToDraft({ name: 'b', agent: 'developer', task: 'B' }),
    ])
    expect(withSteps.steps.map((step) => step.name)).toEqual(['a', 'b'])
  })
})
