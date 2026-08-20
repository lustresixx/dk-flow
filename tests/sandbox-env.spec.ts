import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sandboxEnv } from '../src/engine/sandbox-env.js'

describe('sandboxEnv', () => {
  it('keeps only the allowlist and drops credentials', () => {
    const env = sandboxEnv(
      {
        PATH: 'C:\\bin',
        PATHEXT: '.EXE',
        SystemRoot: 'C:\\Windows',
        DEEPSEEK_API_KEY: 'sk-secret',
        ANOTHER_SECRET: 'value',
        FOO: 'bar',
        TEMP: 'C:\\old-tmp',
      },
      'C:\\sandbox',
    )
    expect(env.PATH).toBe('C:\\bin')
    expect(env.SystemRoot).toBe('C:\\Windows')
    expect(env.DEEPSEEK_API_KEY).toBeUndefined()
    expect(env.ANOTHER_SECRET).toBeUndefined()
    expect(env.FOO).toBeUndefined()
  })

  it('redirects temp dirs into the sandbox and forces UTF-8 Python IO', () => {
    const env = sandboxEnv({ PATH: 'x' }, join('C:', 'sand'))
    expect(env.TEMP).toBe(join('C:', 'sand', 'tmp'))
    expect(env.TMP).toBe(env.TEMP)
    expect(env.PYTHONIOENCODING).toBe('utf-8')
    expect(env.PYTHONUTF8).toBe('1')
  })
})
