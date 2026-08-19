import { describe, expect, it } from 'vitest'
import { runPreCommand, runPreCommands } from '../src/engine/pre-commands.js'

const ABORTED = new AbortController().signal

describe('runPreCommand', () => {
  it('captures stdout and a zero exit code', async () => {
    const result = await runPreCommand('echo hello-pre', undefined, 15000, ABORTED)
    expect(result.stdout).toContain('hello-pre')
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
  })

  it('reports non-zero exits without rejecting', async () => {
    const result = await runPreCommand('node -e "process.exit(3)"', undefined, 15000, ABORTED)
    expect(result.exitCode).toBe(3)
  })

  it('captures stderr', async () => {
    const result = await runPreCommand('node -e "console.error(\'boom\')"', undefined, 15000, ABORTED)
    expect(result.stderr).toContain('boom')
  })

  it('rejects when the caller signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runPreCommand('echo x', undefined, 15000, controller.signal)).rejects.toThrow(/aborted/)
  })
})

describe('runPreCommands', () => {
  it('renders combined output with command lines and exit markers', async () => {
    const text = await runPreCommands(['echo one', 'node -e "process.exit(2)"'], undefined, 15000, ABORTED)
    expect(text).toContain('$ echo one')
    expect(text).toContain('one')
    expect(text).toContain('[退出码 2]')
  })

  it('returns empty for no commands', async () => {
    expect(await runPreCommands([], undefined, 15000, ABORTED)).toBe('')
  })

  it('uses an injected runner for deterministic assembly tests', async () => {
    const text = await runPreCommands(['fake a', 'fake b'], '/proj', 15000, ABORTED, async (command) => ({
      command,
      stdout: `out-${command}`,
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }))
    expect(text).toContain('$ fake a')
    expect(text).toContain('out-fake a')
    expect(text).toContain('$ fake b')
  })
})
