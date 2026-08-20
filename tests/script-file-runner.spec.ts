import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runScriptFile } from '../src/engine/script-file-runner.js'
import type { ScriptNodeInput } from '../src/engine/script-runner.js'

/** Python available in this environment? Tests using it skip otherwise. */
const PYTHON_OK = (() => {
  try {
    return spawnSync('python', ['-c', 'print(1)'], { timeout: 5000 }).status === 0
  } catch {
    return false
  }
})()

const input: ScriptNodeInput = {
  requirements: 'hello',
  state: '测试',
  priorStepEvidence: '前序',
  priorStateEvidence: '',
  inputs: { a: '1' },
  stepData: {},
}

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-script-test-'))
  writeFileSync(join(dir, 'ok.js'), 'return { output: "from file: " + context.requirements, success: true }')
  writeFileSync(join(dir, 'bad.js'), 'return "bare value"')
  writeFileSync(
    join(dir, 'ok.py'),
    [
      'import json, sys',
      'ctx = json.load(sys.stdin)',
      'context = ctx["context"]',
      'print("processing...")',
      'print(json.dumps({"output": "upper: " + context["requirements"].upper(), "success": True, "data": {"len": len(context["requirements"])}}, ensure_ascii=False))',
    ].join('\n'),
  )
  writeFileSync(join(dir, 'traceback.py'), ['raise RuntimeError("boom")'].join('\n'))
  writeFileSync(join(dir, 'exit3.py'), ['import sys', 'print("boom", file=sys.stderr)', 'sys.exit(3)'].join('\n'))
  writeFileSync(join(dir, 'silent.py'), ['print("only a log line")'].join('\n'))
  writeFileSync(join(dir, 'slow.py'), ['import time', 'time.sleep(60)', 'print("late")'].join('\n'))
  writeFileSync(join(dir, 'badshape.py'), ['import json, sys', 'json.load(sys.stdin)', 'print(json.dumps({"success": True}))'].join('\n'))
  writeFileSync(join(dir, 'data.txt'), 'not a script')
})

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

const options = (extra: Partial<Parameters<typeof runScriptFile>[2]> = {}) => ({
  projectRoot: dir,
  pythonCommand: 'python',
  signal: new AbortController().signal,
  ...extra,
})

describe('runScriptFile', () => {
  it('runs a .js file through the vm sandbox', async () => {
    const result = await runScriptFile('ok.js', input, options())
    expect(result.success).toBe(true)
    expect(result.output).toBe('from file: hello')
  })

  it('applies the strict contract to file scripts too', async () => {
    const result = await runScriptFile('bad.js', input, options())
    expect(result.success).toBe(false)
    expect(result.error).toContain('必须返回对象')
  })

  it('fails readably for a missing file', async () => {
    const result = await runScriptFile('missing.js', input, options())
    expect(result.success).toBe(false)
    expect(result.error).toContain('脚本不存在')
  })

  it('rejects unknown extensions', async () => {
    const result = await runScriptFile('data.txt', input, options())
    expect(result.success).toBe(false)
    expect(result.error).toContain('不支持的脚本扩展名')
  })

  it('rejects paths escaping the workspace root', async () => {
    const result = await runScriptFile(`..${sep}outside.py`, input, options())
    expect(result.success).toBe(false)
    expect(result.error).toContain('越界')
  })

  it('resolves scripts from the workspace scripts collection directory', async () => {
    const scriptsDir = join(dir, 'scripts-home')
    mkdirSync(scriptsDir, { recursive: true })
    writeFileSync(join(scriptsDir, 'collect.js'), 'return { output: "collected: " + context.requirements, success: true }')
    const result = await runScriptFile('collect.js', input, options({ scriptsHome: scriptsDir }))
    expect(result.success).toBe(true)
    expect(result.output).toBe('collected: hello')
  })

  it('resolves bare names from the built-in script library', async () => {
    const result = await runScriptFile('to-upper.js', { ...input, requirements: 'abc' }, options())
    expect(result.success).toBe(true)
    expect(result.output).toBe('ABC')
  })

  it('reports the searched locations when a script is missing', async () => {
    const result = await runScriptFile('nope.js', input, options({ scriptsHome: join(dir, 'scripts-home') }))
    expect(result.success).toBe(false)
    expect(result.error).toContain('脚本不存在')
    expect(result.output).toContain('脚本收集目录')
    expect(result.output).toContain('/workflow scripts')
  })
})

describe.skipIf(!PYTHON_OK)('runScriptFile python', () => {
  it('runs a .py file with the context on stdin and parses the result JSON', async () => {
    const result = await runScriptFile('ok.py', input, options())
    expect(result.success).toBe(true)
    expect(result.output).toBe('upper: HELLO')
    expect(result.data).toEqual({ len: 5 })
  })

  it('fails on tracebacks with the stderr tail', async () => {
    const result = await runScriptFile('traceback.py', input, options())
    expect(result.success).toBe(false)
    expect(result.output).toContain('RuntimeError')
  })

  it('fails on non-zero exits', async () => {
    const result = await runScriptFile('exit3.py', input, options())
    expect(result.success).toBe(false)
    expect(result.error).toContain('退出码 3')
    expect(result.output).toContain('boom')
  })

  it('fails when no result JSON line is printed', async () => {
    const result = await runScriptFile('silent.py', input, options())
    expect(result.success).toBe(false)
    expect(result.error).toContain('未输出有效结果 JSON')
  })

  it('applies the strict result contract to python output', async () => {
    const result = await runScriptFile('badshape.py', input, options())
    expect(result.success).toBe(false)
    expect(result.error).toContain('output')
  })

  it('kills slow scripts at the step timeout', async () => {
    const result = await runScriptFile('slow.py', input, options({ timeoutMs: 300 }))
    expect(result.success).toBe(false)
    expect(result.error).toContain('超时')
  })

  it('settles as cancelled when the signal aborts', async () => {
    const controller = new AbortController()
    const pending = runScriptFile('slow.py', input, options({ signal: controller.signal, timeoutMs: 60_000 }))
    setTimeout(() => { controller.abort() }, 100)
    const result = await pending
    expect(result.success).toBe(false)
    expect(result.error).toContain('取消')
  })

  it('fails readably when the python command does not exist', async () => {
    const result = await runScriptFile('ok.py', input, options({ pythonCommand: 'python-definitely-missing-xyz' }))
    expect(result.success).toBe(false)
    expect(result.output).toContain('pythonCommand')
  })
})
