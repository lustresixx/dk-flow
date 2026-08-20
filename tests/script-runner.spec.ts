import { describe, expect, it } from 'vitest'
import { runScriptNode } from '../src/engine/script-runner.js'

const input = {
  requirements: 'hello world',
  state: '测试',
  priorStepEvidence: '前序产出',
  priorStateEvidence: '前序状态产出',
  inputs: { a: '1' },
  stepData: { '上游/计算': { count: 2 } },
}

describe('runScriptNode', () => {
  it('returns an object with output and success', () => {
    const result = runScriptNode('return { output: "ok", success: true }', input)
    expect(result).toEqual({ output: 'ok', success: true, error: undefined })
  })

  it('marks failed steps from success:false or an error field', () => {
    expect(runScriptNode('return { output: "x", success: false }', input).success).toBe(false)
    const failed = runScriptNode('return { error: "输入不合法" }', input)
    expect(failed.success).toBe(false)
    expect(failed.output).toContain('输入不合法')
  })

  it('rejects bare return values with a contract diagnostic', () => {
    const result = runScriptNode('return context.requirements.toUpperCase()', input)
    expect(result.success).toBe(false)
    expect(result.error).toContain('必须返回对象')
  })

  it('rejects a missing output field', () => {
    const result = runScriptNode('return { success: true }', input)
    expect(result.success).toBe(false)
    expect(result.error).toContain('output')
  })

  it('rejects a non-boolean success field', () => {
    const result = runScriptNode('return { output: "x", success: "yes" }', input)
    expect(result.success).toBe(false)
    expect(result.error).toContain('success')
  })

  it('rejects array returns', () => {
    const result = runScriptNode('return [1, 2]', input)
    expect(result.success).toBe(false)
    expect(result.error).toContain('必须返回对象')
  })

  it('captures thrown errors as failures', () => {
    const result = runScriptNode('throw new Error("boom")', input)
    expect(result.success).toBe(false)
    expect(result.error).toContain('boom')
    expect(result.output).toContain('脚本执行失败')
  })

  it('exposes context and collects console logs', () => {
    const result = runScriptNode('console.log("log line"); return { output: context.inputs.a, success: true }', input)
    expect(result.success).toBe(true)
    expect(result.output).toContain('1')
    expect(result.output).toContain('log line')
  })

  it('exposes upstream stepData and carries a data payload through', () => {
    const result = runScriptNode(
      'return { output: "n=" + context.stepData["上游/计算"].count, success: true, data: { n: context.stepData["上游/计算"].count } }',
      input,
    )
    expect(result.success).toBe(true)
    expect(result.output).toBe('n=2')
    expect(result.data).toEqual({ n: 2 })
  })

  it('rejects data that is not JSON-serializable', () => {
    const result = runScriptNode('return { output: "x", success: true, data: 10n }', input)
    expect(result.success).toBe(false)
    expect(result.error).toContain('data 不合法')
  })

  it('rejects data above the 64KB budget', () => {
    const result = runScriptNode(
      'return { output: "x", success: true, data: "a".repeat(70000) }',
      input,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('KB 上限')
  })

  it('freezes context so scripts cannot mutate it', () => {
    const result = runScriptNode('context.requirements = "篡改"; return { output: "x", success: true }', input)
    expect(result.success).toBe(false)
    expect(result.error).toContain('read only')
    expect(input.requirements).toBe('hello world')
  })

  it('handles heavy finite scripts (vm timeout is best-effort only)', () => {
    const result = runScriptNode('let sum = 0; for (let i = 0; i < 1000000; i++) sum += i; return { output: String(sum), success: true }', input)
    expect(result.success).toBe(true)
    expect(result.output).not.toBe('')
  })
})
