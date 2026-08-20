/**
 * Script-node execution: run a step's JavaScript source in an isolated
 * worker thread (own heap via `resourceLimits`, reliably terminable on
 * timeout or abort) with a node:vm context, and interpret the returned value
 * under the strict script contract.
 *
 * The return contract is strict: a script either returns
 * `{ output: string, success: boolean }` (optionally with a JSON-serializable
 * `data` payload carried to downstream steps) or `{ error: string }` to fail.
 * Anything else fails the step with a readable diagnostic instead of being
 * silently interpreted.
 * @module dsh-ace-harness/engine
 */
import { Worker } from 'node:worker_threads'

/** Context injected into a script step. Frozen: scripts cannot mutate it. */
export interface ScriptNodeInput {
  requirements: string
  state: string
  priorStepEvidence: string
  priorStateEvidence: string
  inputs: Record<string, string>
  /** Structured `data` produced by earlier steps, keyed `<state>/<step>`. */
  stepData: Record<string, unknown>
}

/** Normalized outcome of a script step. */
export interface ScriptNodeResult {
  output: string
  success: boolean
  error?: string
  /** Optional structured payload carried to downstream steps. */
  data?: unknown
}

/** Wall-clock cap for one script step (worker termination, reliable). */
export const SCRIPT_TIMEOUT_MS = 10_000
/** Cap on the combined output text. */
const OUTPUT_BUDGET = 20_000
/** Cap on the serialized structured payload; data must survive this budget. */
const DATA_BUDGET = 64 * 1024
/** Worker heap limits: a runaway script exhausts its own worker, not the host. */
const WORKER_RESOURCE_LIMITS = {
  maxOldGenerationSizeMb: 512,
  maxYoungGenerationSizeMb: 128,
  stackSizeMb: 4,
} as const

/**
 * Worker-thread program: one vm evaluation per message. Pure JS string (no
 * imports) so the host can launch it with `eval: true` without a file.
 */
const SCRIPT_WORKER_SOURCE = `
const vm = require('node:vm')
const { parentPort } = require('node:worker_threads')
parentPort.on('message', (msg) => {
  const logs = []
  const safeStringify = (value) => {
    try { return typeof value === 'string' ? value : JSON.stringify(value, null, 2) } catch { return String(value) }
  }
  try {
    const sandbox = {
      JSON, Math, String, Number, Boolean, Array, Object, Date,
      console: {
        log: (...args) => { logs.push(args.map(safeStringify).join(' ')) },
        error: (...args) => { logs.push('[error] ' + args.map(safeStringify).join(' ')) },
      },
      context: Object.freeze({
        requirements: msg.input.requirements,
        state: msg.input.state,
        priorStepEvidence: msg.input.priorStepEvidence,
        priorStateEvidence: msg.input.priorStateEvidence,
        inputs: Object.freeze(Object.assign({}, msg.input.inputs)),
        stepData: Object.freeze(Object.assign({}, msg.input.stepData)),
      }),
    }
    const vmContext = vm.createContext(sandbox)
    const wrapped = '(function () { "use strict";\\n' + msg.source + '\\n})()'
    const value = vm.runInContext(wrapped, vmContext, { timeout: msg.timeoutMs })
    parentPort.postMessage({ ok: true, value, logs })
  } catch (error) {
    parentPort.postMessage({ ok: false, error: String((error && error.message) || error), logs })
  }
})
`

function truncate(text: string): string {
  if (text.length <= OUTPUT_BUDGET) return text
  return `${text.slice(0, OUTPUT_BUDGET)}\n…（输出过长，已截断）`
}

/** Describe a non-conforming return value for the step failure message. */
function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined（未 return）'
  if (value === null) return 'null'
  if (typeof value === 'string') return `字符串 "${truncate(value)}"`
  try {
    const json = JSON.stringify(value)
    if (json !== undefined) return truncate(json)
  } catch {
    // Fall through to the type-only description.
  }
  return `类型 ${typeof value}`
}

/**
 * Clone a value through JSON to guarantee it can be persisted and handed to
 * downstream nodes, and check it against the data budget.
 */
function cloneJsonSafe(value: unknown): { ok: true; data: unknown } | { ok: false; reason: string } {
  if (typeof value === 'function') return { ok: false, reason: 'data 不能是函数' }
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) return { ok: false, reason: 'data 不是可 JSON 序列化的值' }
    if (serialized.length > DATA_BUDGET) {
      return { ok: false, reason: `data 序列化后超过 ${DATA_BUDGET / 1024}KB 上限` }
    }
    return { ok: true, data: JSON.parse(serialized) as unknown }
  } catch {
    return { ok: false, reason: 'data 包含无法 JSON 序列化的值（如 BigInt 或循环引用）' }
  }
}

/**
 * Interpret a script's returned value under the strict contract:
 * - `{ output, success, data? }` — success decides the binary verdict, and
 *   `data` rides to downstream steps as structured evidence;
 * - `{ error }` — failed step with the message;
 * - anything else — the step fails with a diagnostic naming the contract.
 * Shared by the worker vm runner and the Python subprocess runner.
 */
export function interpretScriptResult(value: unknown): ScriptNodeResult {
  const fail = (message: string): ScriptNodeResult => ({
    output: truncate(message),
    success: false,
    error: message,
  })
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(
      `脚本必须返回对象 { output: "...", success: true/false }（或 { error: "..." } 表示失败），实际返回: ${describeValue(value)}`,
    )
  }
  const record = value as Record<string, unknown>
  if (record.error !== undefined) {
    const message = typeof record.error === 'string' ? record.error : String(record.error)
    return { output: truncate(message), success: false, error: message }
  }
  if (typeof record.output !== 'string') {
    return fail('脚本返回对象缺少字符串字段 output，应返回 { output: "...", success: true }')
  }
  if (typeof record.success !== 'boolean') {
    return fail('脚本返回对象缺少布尔字段 success，应返回 { output: "...", success: true }')
  }
  let data: unknown
  if (record.data !== undefined) {
    const cloned = cloneJsonSafe(record.data)
    if (!cloned.ok) return fail(`脚本返回的 data 不合法: ${cloned.reason}`)
    data = cloned.data
  }
  const result: ScriptNodeResult = { output: truncate(record.output), success: record.success }
  if (data !== undefined) result.data = data
  return result
}

interface WorkerOutcome {
  value?: unknown
  error?: string
  logs: string[]
}

/** Run one vm evaluation inside a disposable worker thread. */
function runInWorker(
  source: string,
  input: ScriptNodeInput,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WorkerOutcome> {
  return new Promise((resolvePromise) => {
    const worker = new Worker(SCRIPT_WORKER_SOURCE, {
      eval: true,
      resourceLimits: WORKER_RESOURCE_LIMITS,
    })
    let settled = false
    const settle = (outcome: WorkerOutcome): void => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise(outcome)
    }
    const onAbort = (): void => {
      void worker.terminate()
      settle({ error: '运行被取消', logs: [] })
    }
    const timer = setTimeout(() => {
      void worker.terminate()
      settle({ error: `脚本执行超时（${timeoutMs}ms）`, logs: [] })
    }, timeoutMs + 1500)
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    worker.on('message', (message: { ok: boolean; value?: unknown; error?: string; logs?: string[] }) => {
      settle({
        value: message.value,
        error: message.ok ? undefined : (message.error ?? '脚本执行失败'),
        logs: message.logs ?? [],
      })
    })
    worker.on('error', (error) => {
      settle({ error: `脚本 worker 错误: ${error.message}`, logs: [] })
    })
    worker.on('exit', () => {
      settle({ error: '脚本 worker 异常退出（可能超出资源限制）', logs: [] })
    })
    signal.addEventListener('abort', onAbort, { once: true })
    worker.postMessage({ source, input, timeoutMs })
  })
}

/**
 * Run one JavaScript script step in an isolated worker thread and interpret
 * its return value under the strict script contract.
 * @param options.timeoutMs - wall-clock cap (worker termination, reliable).
 * @param options.signal - cancellation; aborts the worker promptly.
 */
export async function runScriptNode(
  source: string,
  input: ScriptNodeInput,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ScriptNodeResult> {
  const timeoutMs = options.timeoutMs ?? SCRIPT_TIMEOUT_MS
  const signal = options.signal ?? new AbortController().signal
  if (signal.aborted) {
    return { output: '运行被取消', success: false, error: '运行被取消' }
  }
  const { value, error, logs } = await runInWorker(source, input, timeoutMs, signal)
  if (error !== undefined) {
    const output =
      logs.length > 0 ? `${logs.join('\n')}\n脚本执行失败: ${error}` : `脚本执行失败: ${error}`
    return { output: truncate(output), success: false, error }
  }
  const result = interpretScriptResult(value)
  if (logs.length > 0) {
    result.output = truncate(`${result.output}\n--- 日志 ---\n${logs.join('\n')}`)
  }
  return result
}
