import { describe, expect, it } from 'vitest'
import {
  buildStepPrompt,
  renderStructuredData,
  STRUCTURED_DATA_BUDGET,
} from '../src/engine/prompts.js'
import type { StepContext } from '../src/engine/types.js'

const ctx: StepContext = {
  state: '测试',
  stateDescription: '',
  requirements: '需求文本',
  priorStateEvidence: '前序状态',
  priorStepEvidence: '（无本状态前置步骤产出）',
  stepData: {},
}

describe('renderStructuredData', () => {
  it('renders nothing without data', () => {
    expect(renderStructuredData({})).toBe('')
  })

  it('renders upstream data as a JSON section', () => {
    const text = renderStructuredData({ '检查/校验': { ok: true } })
    expect(text).toContain('上游结构化数据')
    expect(text).toContain('检查/校验')
    expect(text).toContain('"ok":true')
  })

  it('truncates oversized data to the budget', () => {
    const text = renderStructuredData({ big: 'x'.repeat(10_000) })
    expect(text.length).toBeLessThanOrEqual(STRUCTURED_DATA_BUDGET + 100)
    expect(text).toContain('已截断')
  })
})

describe('buildStepPrompt', () => {
  it('omits the structured section when there is no data', () => {
    const prompt = buildStepPrompt({ role: 'neutral', task: '任务', constraints: [], ctx })
    expect(prompt).not.toContain('上游结构化数据')
  })

  it('includes bounded structured data for agent and llm steps', () => {
    const prompt = buildStepPrompt({
      role: 'judge',
      task: '裁决',
      constraints: ['约束'],
      ctx: { ...ctx, stepData: { '计算/产出': { answer: 42 } } },
    })
    expect(prompt).toContain('上游结构化数据')
    expect(prompt).toContain('"answer":42')
    expect(prompt).toContain('workflow-verdict')
  })
})
