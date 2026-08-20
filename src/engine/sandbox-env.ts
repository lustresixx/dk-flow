/**
 * Per-run sandbox environment: a scrubbed process environment for sandboxed
 * script execution. Only a fixed allowlist of system variables survives
 * (PATH and friends, so interpreters resolve); credentials and other host
 * secrets never reach sandboxed scripts. Temp dirs redirect into the run's
 * sandbox directory.
 * @module dsh-ace-harness/engine
 */
import { join } from 'node:path'

/** System variables scripts may still need (interpreter lookup, Windows runtime). */
const SANDBOX_ENV_ALLOWLIST = [
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'LANG',
  'LC_ALL',
  'USER',
  'USERNAME',
] as const

/**
 * Build the environment for a sandboxed script process.
 * @param base - the host environment to scrub.
 * @param sandboxDir - the run's sandbox directory; temp dirs redirect inside it.
 * @returns a minimal environment: no credentials, no host-specific variables.
 */
export function sandboxEnv(base: NodeJS.ProcessEnv, sandboxDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of SANDBOX_ENV_ALLOWLIST) {
    const value = base[key]
    if (value !== undefined) env[key] = value
  }
  const tmp = join(sandboxDir, 'tmp')
  env.TEMP = tmp
  env.TMP = tmp
  // Force UTF-8 stdout/stdin on Windows interpreters (Python's pipe encoding
  // otherwise follows the console codepage and garbles non-ASCII output).
  env.PYTHONIOENCODING = 'utf-8'
  env.PYTHONUTF8 = '1'
  return env
}
