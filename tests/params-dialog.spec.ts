import { describe, expect, it } from 'vitest'
import {
  answersToValues,
  buildParameterQuestions,
  buildTaskInputQuestions,
  taskInputAnswersToValues,
} from '../src/params-dialog.js'
import type { WorkflowTaskInputField, WorkflowTemplateManifest } from '../src/dsl/types.js'

const manifest: WorkflowTemplateManifest = {
  apiVersion: 'aceharness.io/v1alpha1',
  kind: 'WorkflowTemplate',
  metadata: { id: 'demo', version: '1.0.0', name: 'Demo' },
  spec: {
    entrypoint: 'workflow.yaml',
    mode: 'state-machine',
    parameters: [
      { id: 'projectRoot', label: '项目目录', type: 'directory', bind: '/context/projectRoot', required: true },
      { id: 'requirements', label: '优化目标', type: 'text', bind: '/context/requirements', required: true },
      { id: 'mode', label: '模式', type: 'enum', bind: '/context/mode', options: [{ label: '快速', value: 'fast' }, { label: '深度', value: 'deep' }] },
    ],
  },
}

describe('buildParameterQuestions', () => {
  it('builds one question per missing parameter', () => {
    const questions = buildParameterQuestions(manifest, ['projectRoot', 'requirements', 'mode'])
    expect(questions.map((q) => q.id)).toEqual(['projectRoot', 'requirements', 'mode'])
    expect(questions[0]!.header).toBe('工作流参数')
    expect(questions[0]!.question).toContain('项目目录')
  })

  it('renders enum options and leaves free-text questions option-less', () => {
    const questions = buildParameterQuestions(manifest, ['requirements', 'mode'])
    expect(questions[0]!.options).toBeUndefined()
    expect(questions[1]!.options).toEqual([
      { label: '快速', description: 'fast' },
      { label: '深度', description: 'deep' },
    ])
  })
})

describe('answersToValues', () => {
  it('maps selected enum labels back to values', () => {
    const questions = buildParameterQuestions(manifest, ['mode'])
    const values = answersToValues(manifest, questions, [{ id: 'mode', selected: ['深度'] }])
    expect(values.mode).toBe('deep')
  })

  it('collects custom text answers', () => {
    const questions = buildParameterQuestions(manifest, ['projectRoot', 'requirements'])
    const values = answersToValues(manifest, questions, [
      { id: 'projectRoot', selected: [], custom: 'E:\\proj' },
      { id: 'requirements', selected: [], custom: '优化性能' },
    ])
    expect(values).toEqual({ projectRoot: 'E:\\proj', requirements: '优化性能' })
  })

  it('falls back to the selected label for unknown enums', () => {
    const questions = buildParameterQuestions(manifest, ['mode'])
    const values = answersToValues(manifest, questions, [{ id: 'mode', selected: ['未知选项'] }])
    expect(values.mode).toBe('未知选项')
  })

  it('skips unanswered questions', () => {
    const questions = buildParameterQuestions(manifest, ['projectRoot', 'requirements'])
    const values = answersToValues(manifest, questions, [{ id: 'projectRoot', selected: [], custom: 'E:\\proj' }])
    expect(values).toEqual({ projectRoot: 'E:\\proj' })
  })
})

const taskFields: WorkflowTaskInputField[] = [
  { id: 'requirements', label: '输入文本', type: 'text', required: true, placeholder: '任意文字' },
  { id: 'note', label: '备注', type: 'textarea' },
]

describe('taskInput questions', () => {
  it('builds one question per missing required field', () => {
    const questions = buildTaskInputQuestions(taskFields, ['requirements'])
    expect(questions).toHaveLength(1)
    expect(questions[0]!.id).toBe('requirements')
    expect(questions[0]!.question).toContain('输入文本')
    expect(questions[0]!.options).toBeUndefined()
  })

  it('maps custom answers back to values', () => {
    const questions = buildTaskInputQuestions(taskFields, ['requirements'])
    const values = taskInputAnswersToValues(questions, [{ id: 'requirements', selected: [], custom: 'hello' }])
    expect(values).toEqual({ requirements: 'hello' })
  })

  it('falls back to the selected label and skips unanswered fields', () => {
    const questions = buildTaskInputQuestions(taskFields, ['requirements', 'note'])
    const values = taskInputAnswersToValues(questions, [{ id: 'requirements', selected: ['已选标签'] }])
    expect(values).toEqual({ requirements: '已选标签' })
  })
})
