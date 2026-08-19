import { describe, expect, it } from 'vitest'
import { runScriptNode } from '../src/engine/script-runner.js'

const input = {
  requirements: 'hello world',
  state: '测试',
  priorStepEvidence: '前序产出',
  priorStateEvidence: '前序状态产出',
  inputs: { a: '1' },
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

  it('stringifies bare return values with success', () => {
    const result = runScriptNode('return context.requirements.toUpperCase()', input)
    expect(result.success).toBe(true)
    expect(result.output).toBe('HELLO WORLD')
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

  it('handles heavy finite scripts (vm timeout is best-effort only)', () => {
    const result = runScriptNode('let sum = 0; for (let i = 0; i < 1000000; i++) sum += i; return { output: String(sum), success: true }', input)
    expect(result.success).toBe(true)
    expect(result.output).not.toBe('')
  })
})
