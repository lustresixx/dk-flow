/**
 * Pre-command execution: run a step's `preCommands` in the step's project
 * directory and return bounded, text-safe output for context injection.
 * Non-zero exits and timeouts do not abort the step (ACE semantics); the
 * outcome text is injected so the agent sees what happened.
 * @module dsh-ace-harness/engine
 */
import { exec } from 'node:child_process'

/** Bounded outcome of one pre-command run. */
export interface PreCommandResult {
  command: string
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

/** Cap applied to each captured stream before injection. */
const STREAM_BUDGET = 20_000

function truncate(text: string): string {
  if (text.length <= STREAM_BUDGET) return text
  return `${text.slice(0, STREAM_BUDGET)}\n…（输出过长，已截断）`
}

/**
 * Run one shell command tolerantly.
 * @returns the captured result; the promise never rejects for command
 *   failures — only for an aborted caller signal.
 */
export function runPreCommand(
  command: string,
  cwd: string | undefined,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<PreCommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal.aborted) {
      rejectPromise(new Error('preCommand aborted before start'))
      return
    }
    const child = exec(
      command,
      { cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        cleanup()
        resolvePromise({
          command,
          stdout: truncate(stdout),
          stderr: truncate(stderr),
          exitCode: error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : null,
          timedOut: (error as { killed?: boolean })?.killed === true,
        })
      },
    )
    const onAbort = (): void => {
      cleanup()
      // Kill the spawned shell so a stopped run does not leave the command
      // executing (leaked process + write races on the workspace). Known
      // boundary: on Windows the exec shell's own children (grandchild
      // processes) may survive the kill of the immediate child.
      child.kill()
      rejectPromise(new Error('preCommand aborted'))
    }
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Run a step's pre-commands sequentially and render their combined output as
 * prompt context. Empty when there are no commands or no output.
 * @param runner - injectable for tests; defaults to {@link runPreCommand}.
 */
export async function runPreCommands(
  commands: readonly string[],
  cwd: string | undefined,
  timeoutMs: number,
  signal: AbortSignal,
  runner: (command: string, cwd: string | undefined, timeoutMs: number, signal: AbortSignal) => Promise<PreCommandResult> = runPreCommand,
): Promise<string> {
  if (commands.length === 0) return ''
  const sections: string[] = []
  for (const command of commands) {
    const result = await runner(command, cwd, timeoutMs, signal)
    const parts = [`$ ${result.command}`]
    if (result.stdout !== '') parts.push(result.stdout)
    if (result.stderr !== '') parts.push(`[stderr] ${result.stderr}`)
    if (result.timedOut) parts.push(`[超时 ${timeoutMs}ms 后被终止]`)
    else if ((result.exitCode ?? 0) !== 0) parts.push(`[退出码 ${result.exitCode}]`)
    sections.push(parts.join('\n'))
  }
  return sections.join('\n\n')
}
