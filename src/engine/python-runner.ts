/**
 * Python subprocess runner for `scriptFile` steps. The step context is sent
 * as JSON on stdin; the script must print its result as a single JSON line
 * to stdout under the same strict contract as inline scripts:
 * `{"output": "...", "success": true, "data": ...}` or `{"error": "..."}`.
 * @module dsh-ace-harness/engine
 */
import { mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { sandboxEnv } from './sandbox-env.js'
import { interpretScriptResult, type ScriptNodeInput, type ScriptNodeResult } from './script-runner.js'

/** Default wall-clock cap for one Python script step. */
export const PYTHON_TIMEOUT_MS = 30_000
/** Cap on captured stdout/stderr per process. */
const IO_BUDGET = 200_000

export interface PythonRunOptions {
  /** Command used to launch Python (e.g. `python`, `python3`, `py -3`). */
  command: string
  /** Absolute path to the `.py` file to run. */
  filePath: string
  input: ScriptNodeInput
  timeoutMs: number
  signal: AbortSignal
  /**
   * Per-run sandbox directory: the process runs with this cwd, a scrubbed
   * environment, and temp dirs redirected inside it. Absent means inherit
   * (legacy host-level behavior).
   */
  sandboxDir?: string
}

function appendBounded(buffer: string, chunk: string): string {
  const next = buffer + chunk
  return next.length <= IO_BUDGET ? next : next.slice(-IO_BUDGET)
}

function tail(text: string, budget = 2000): string {
  const trimmed = text.trim()
  return trimmed.length <= budget ? trimmed : trimmed.slice(-budget)
}

/**
 * Run one Python script step. Never throws: spawn failures, timeouts, abort,
 * non-zero exits, and unparseable output all settle as failed step results
 * with readable diagnostics.
 */
export function runPythonScript(options: PythonRunOptions): Promise<ScriptNodeResult> {
  return new Promise((resolvePromise) => {
    const [command, ...prefixArgs] = options.command.trim().split(/\s+/).filter((part) => part !== '')
    if (!command) {
      resolvePromise({
        output: 'Python 命令为空：请检查插件配置 pythonCommand',
        success: false,
        error: 'Python 命令为空',
      })
      return
    }
    let settled = false
    let stdout = ''
    let stderr = ''
    let child: ReturnType<typeof spawn> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      try {
        child?.kill()
      } catch {
        // Best-effort process kill.
      }
      finish({ output: '运行被取消', success: false, error: '运行被取消' })
    }
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      options.signal.removeEventListener('abort', onAbort)
    }
    const finish = (result: ScriptNodeResult): void => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise(result)
    }
    if (options.signal.aborted) {
      finish({ output: '运行被取消', success: false, error: '运行被取消' })
      return
    }
    options.signal.addEventListener('abort', onAbort, { once: true })
    // Per-run sandbox: scrubbed env, sandbox cwd, redirected temp dirs.
    let cwd: string | undefined
    let env: NodeJS.ProcessEnv | undefined
    if (options.sandboxDir !== undefined) {
      try {
        mkdirSync(join(options.sandboxDir, 'tmp'), { recursive: true })
      } catch {
        // Best-effort temp dir; the process still runs with the scrubbed env.
      }
      cwd = options.sandboxDir
      env = sandboxEnv(process.env, options.sandboxDir)
    }
    try {
      child = spawn(command, [...prefixArgs, options.filePath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        cwd,
        env,
      })
    } catch (error) {
      finish({
        output: `Python 进程启动失败: ${(error as Error).message}`,
        success: false,
        error: (error as Error).message,
      })
      return
    }
    child.on('error', (error) => {
      finish({
        output: `Python 进程启动失败: ${error.message}（请确认 pythonCommand 可执行）`,
        success: false,
        error: error.message,
      })
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk.toString('utf8'))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk.toString('utf8'))
    })
    child.stdin?.end(`${JSON.stringify({ context: options.input })}\n`, 'utf8')
    timer = setTimeout(() => {
      try {
        child?.kill()
      } catch {
        // Best-effort process kill.
      }
      finish({
        output: `脚本执行超时（${options.timeoutMs}ms）${stderr !== '' ? `：\n${tail(stderr)}` : ''}`,
        success: false,
        error: `脚本执行超时（${options.timeoutMs}ms）`,
      })
    }, options.timeoutMs)
    child.on('close', (code) => {
      const lines = stdout.split(/\r?\n/)
      let parsed: unknown
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]!.trim()
        if (line === '') continue
        try {
          const candidate = JSON.parse(line) as unknown
          if (candidate !== null && typeof candidate === 'object') {
            parsed = candidate
            break
          }
        } catch {
          // Not a JSON line; keep scanning backwards.
        }
      }
      if (code !== 0) {
        const detail = stderr.trim() !== '' ? tail(stderr) : parsed === undefined ? tail(stdout) : tail(stdout)
        finish({
          output: `脚本进程退出码 ${code}：\n${detail}`,
          success: false,
          error: `脚本进程退出码 ${code}`,
        })
        return
      }
      if (parsed === undefined) {
        const detail = stderr.trim() !== '' ? tail(stderr) : tail(stdout)
        finish({
          output: `脚本未输出有效结果 JSON（最后输出一行 {"output": "...", "success": true/false}）：\n${detail || '（无输出）'}`,
          success: false,
          error: '脚本未输出有效结果 JSON',
        })
        return
      }
      finish(interpretScriptResult(parsed))
    })
  })
}
