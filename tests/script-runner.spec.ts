import { describe, expect, it } from 'vitest'
import { runScriptNode } from '../src/engine/script-runner.js'

const input = {
  requirements: 'hello world',
  state: '测试',
  projectRoot: 'C:/projects/demo',
  priorStepEvidence: '前序产出',
  priorStateEvidence: '前序状态产出',
  inputs: { a: '1' },
  stepData: { '上游/计算': { count: 2 } },
}

describe('runScriptNode', () => {
  it('returns an object with output and success', async () => {
    const result = await runScriptNode('return { output: "ok", success: true }', input)
    expect(result).toEqual({ output: 'ok', success: true, error: undefined })
  })

  it('marks failed steps from success:false or an error field', async () => {
    expect((await runScriptNode('return { output: "x", success: false }', input)).success).toBe(false)
    const failed = await runScriptNode('return { error: "输入不合法" }', input)
    expect(failed.success).toBe(false)
    expect(failed.output).toContain('输入不合法')
  })

  it('rejects bare return values with a contract diagnostic', async () => {
    const result = await runScriptNode('return context.requirements.toUpperCase()', input)
    expect(result.success).toBe(false)
    expect(result.error).toContain('必须返回对象')
  })

  it('rejects a missing output field', async () => {
    const result = await runScriptNode('return { success: true }', input)
    expect(result.success).toBe(false)
    expect(result.error).toContain('output')
  })

  it('rejects a non-boolean success field', async () => {
    const result = await runScriptNode('return { output: "x", success: "yes" }', input)
    expect(result.success).toBe(false)
    expect(result.error).toContain('success')
  })

  it('rejects array returns', async () => {
    const result = await runScriptNode('return [1, 2]', input)
    expect(result.success).toBe(false)
    expect(result.error).toContain('必须返回对象')
  })

  it('captures thrown errors as failures', async () => {
    const result = await runScriptNode('throw new Error("boom")', input)
    expect(result.success).toBe(false)
    expect(result.error).toContain('boom')
    expect(result.output).toContain('脚本执行失败')
  })

  it('exposes context and collects console logs', async () => {
    const result = await runScriptNode('console.log("log line"); return { output: context.inputs.a, success: true }', input)
    expect(result.success).toBe(true)
    expect(result.output).toContain('1')
    expect(result.output).toContain('log line')
  })

  it('exposes the project root on the script context', async () => {
    const result = await runScriptNode('return { output: context.projectRoot ?? "缺失", success: true }', input)
    expect(result.success).toBe(true)
    expect(result.output).toBe('C:/projects/demo')
  })

  it('exposes upstream stepData and carries a data payload through', async () => {
    const result = await runScriptNode(
      'return { output: "n=" + context.stepData["上游/计算"].count, success: true, data: { n: context.stepData["上游/计算"].count } }',
      input,
    )
    expect(result.success).toBe(true)
    expect(result.output).toBe('n=2')
    expect(result.data).toEqual({ n: 2 })
  })

  it('rejects data that is not JSON-serializable', async () => {
    const result = await runScriptNode('return { output: "x", success: true, data: 10n }', input)
    expect(result.success).toBe(false)
    expect(result.error).toContain('data 不合法')
  })

  it('rejects data above the 64KB budget', async () => {
    const result = await runScriptNode(
      'return { output: "x", success: true, data: "a".repeat(70000) }',
      input,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('KB 上限')
  })

  it('freezes context so scripts cannot mutate it', async () => {
    const result = await runScriptNode('context.requirements = "篡改"; return { output: "x", success: true }', input)
    expect(result.success).toBe(false)
    expect(result.error).toContain('read only')
    expect(input.requirements).toBe('hello world')
  })

  it('handles heavy finite scripts', async () => {
    const result = await runScriptNode('let sum = 0; for (let i = 0; i < 1000000; i++) sum += i; return { output: String(sum), success: true }', input)
    expect(result.success).toBe(true)
    expect(result.output).not.toBe('')
  })

  it('terminates infinite loops reliably via worker termination', async () => {
    const started = Date.now()
    const result = await runScriptNode('while (true) {}', input, { timeoutMs: 500 })
    expect(result.success).toBe(false)
    // Either the vm watchdog or the host-side worker termination may fire first.
    expect(result.error).toMatch(/超时|timed out/)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('settles as cancelled when the signal aborts', async () => {
    const controller = new AbortController()
    const pending = runScriptNode('while (true) {}', input, {
      timeoutMs: 60_000,
      signal: controller.signal,
    })
    setTimeout(() => { controller.abort() }, 100)
    const result = await pending
    expect(result.success).toBe(false)
    expect(result.error).toContain('取消')
  })
})
