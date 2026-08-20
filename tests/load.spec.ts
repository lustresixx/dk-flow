import { describe, expect, it } from 'vitest'
import { parseWorkflowYaml, validateWorkflowReferences, WorkflowConfigError } from '../src/dsl/load.js'

const validYaml = `
workflow:
  name: 红蓝评审
  mode: state-machine
  states:
    - name: 方案
      isInitial: true
      steps:
        - name: 设计
          agent: architect
          role: defender
          task: 设计
      transitions:
        - to: 完成
          condition: { verdict: pass }
    - name: 完成
      isFinal: true
      steps:
        - name: 汇总
          agent: documentation-writer
          task: 汇总
      transitions: []
`

describe('parseWorkflowYaml', () => {
  it('parses a valid document with defaults applied', () => {
    const config = parseWorkflowYaml(validYaml)
    expect(config.workflow.name).toBe('红蓝评审')
    expect(config.workflow.maxTransitions).toBe(50)
    expect(config.workflow.states).toHaveLength(2)
  })

  it('rejects a document without a name', () => {
    expect(() =>
      parseWorkflowYaml('workflow:\n  mode: state-machine\n  states: []'),
    ).toThrow(WorkflowConfigError)
  })

  it('rejects broken YAML with a parse error', () => {
    expect(() => parseWorkflowYaml('workflow: [unclosed')).toThrow(WorkflowConfigError)
  })

  it('rejects an agent step without a task', () => {
    const yaml = `
workflow:
  name: x
  mode: state-machine
  states:
    - name: s
      isInitial: true
      isFinal: true
      steps:
        - name: step
          agent: architect
      transitions: []
`
    expect(() => parseWorkflowYaml(yaml)).toThrow(/任务描述不能为空|校验失败/)
  })

  it('requires a configFile on subworkflow steps', () => {
    const yaml = `
workflow:
  name: x
  mode: state-machine
  states:
    - name: s
      isInitial: true
      isFinal: true
      steps:
        - name: sub
          type: subworkflow
      transitions: []
`
    expect(() => parseWorkflowYaml(yaml)).toThrow(/子工作流步骤必须设置/)
  })

  it('requires a task on llm steps', () => {
    const yaml = `
workflow:
  name: x
  mode: state-machine
  states:
    - name: s
      isInitial: true
      isFinal: true
      steps:
        - name: fast
          type: llm
          model: fast-model
      transitions: []
`
    expect(() => parseWorkflowYaml(yaml)).toThrow(/LLM 步骤必须设置/)
  })

  it('accepts an llm step without an agent', () => {
    const yaml = `
workflow:
  name: x
  mode: state-machine
  states:
    - name: s
      isInitial: true
      isFinal: true
      steps:
        - name: fast
          type: llm
          model: fast-model
          task: 判断输入是否合法
      transitions: []
`
    const config = parseWorkflowYaml(yaml)
    expect(config.workflow.states[0]!.steps[0]!.type).toBe('llm')
    expect(config.workflow.states[0]!.steps[0]!.model).toBe('fast-model')
    expect(validateWorkflowReferences(config, new Set())).toEqual([])
  })

  it('accepts a scriptFile step and rejects script + scriptFile together', () => {
    const withFile = `
workflow:
  name: x
  mode: state-machine
  states:
    - name: s
      isInitial: true
      isFinal: true
      steps:
        - name: py
          type: script
          scriptFile: scripts/check.py
      transitions: []
`
    const config = parseWorkflowYaml(withFile)
    expect(config.workflow.states[0]!.steps[0]!.scriptFile).toBe('scripts/check.py')
    const both = withFile.replace('scriptFile: scripts/check.py', 'script: "return 1"\n          scriptFile: scripts/check.py')
    expect(() => parseWorkflowYaml(both)).toThrow(/不能同时设置/)
  })

  it('parses retry, timeoutMinutes, and workflow-level stepRetry', () => {
    const yaml = `
workflow:
  name: x
  mode: state-machine
  stepRetry: { maxRetries: 2, backoffMs: 1000 }
  states:
    - name: s
      isInitial: true
      isFinal: true
      steps:
        - name: step
          agent: a
          task: t
          timeoutMinutes: 5
          retry: { maxRetries: 3 }
      transitions: []
`
    const config = parseWorkflowYaml(yaml)
    expect(config.workflow.stepRetry).toEqual({ maxRetries: 2, backoffMs: 1000 })
    const step = config.workflow.states[0]!.steps[0]!
    expect(step.timeoutMinutes).toBe(5)
    expect(step.retry).toEqual({ maxRetries: 3 })
  })
})

describe('validateWorkflowReferences', () => {
  it('flags unknown agents, transitions, and missing initials', () => {
    const config = parseWorkflowYaml(validYaml)
    const errors = validateWorkflowReferences(config, new Set(['documentation-writer']))
    expect(errors.some((e) => e.includes('architect'))).toBe(true)
  })

  it('flags transitions to unknown states', () => {
    const yaml = `
workflow:
  name: x
  mode: state-machine
  states:
    - name: s
      isInitial: true
      steps:
        - { name: step, agent: a, task: t }
      transitions:
        - { to: ghost, condition: { verdict: pass } }
`
    const config = parseWorkflowYaml(yaml)
    const errors = validateWorkflowReferences(config, new Set(['a']))
    expect(errors.some((e) => e.includes('ghost'))).toBe(true)
  })

  it('passes a fully consistent config', () => {
    const config = parseWorkflowYaml(validYaml)
    const errors = validateWorkflowReferences(
      config,
      new Set(['architect', 'documentation-writer']),
    )
    expect(errors).toEqual([])
  })
})
