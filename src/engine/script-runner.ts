/**
 * Script-node execution: run a step's JavaScript source in an isolated
 * node:vm context and interpret the returned value as the step outcome.
 *
 * The return contract is strict: a script either returns
 * `{ output: string, success: boolean }` (optionally with a JSON-serializable
 * `data` payload carried to downstream steps) or `{ error: string }` to fail.
 * Anything else fails the step with a readable diagnostic instead of being
 * silently interpreted.
 * @module dsh-ace-harness/engine
 */
import vm from 'node:vm'

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

/** Wall-clock cap for one script step. */
const SCRIPT_TIMEOUT_MS = 10_000
/** Cap on the combined output text. */
const OUTPUT_BUDGET = 20_000
/** Cap on the serialized structured payload; data must survive this budget. */
const DATA_BUDGET = 64 * 1024

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

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
 * Run one script step and interpret its return value:
 * - `{ output, success, data? }` — success decides the binary verdict, and
 *   `data` rides to downstream steps as structured evidence;
 * - `{ error }` or a thrown exception — failed step with the message;
 * - anything else — the step fails with a diagnostic naming the contract.
 */
export function runScriptNode(source: string, input: ScriptNodeInput): ScriptNodeResult {
  const logs: string[] = []
  const context = Object.freeze({
    requirements: input.requirements,
    state: input.state,
    priorStepEvidence: input.priorStepEvidence,
    priorStateEvidence: input.priorStateEvidence,
    inputs: Object.freeze({ ...input.inputs }),
    stepData: Object.freeze({ ...input.stepData }),
  })
  const sandbox = {
    JSON,
    Math,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Date,
    console: {
      log: (...args: unknown[]): void => {
        logs.push(args.map((arg) => safeStringify(arg)).join(' '))
      },
      error: (...args: unknown[]): void => {
        logs.push(`[error] ${args.map((arg) => safeStringify(arg)).join(' ')}`)
      },
    },
    context,
  }
  const vmContext = vm.createContext(sandbox)
  let value: unknown
  try {
    const wrapped = `(function () { "use strict";\n${source}\n})()`
    value = vm.runInContext(wrapped, vmContext, { timeout: SCRIPT_TIMEOUT_MS })
  } catch (error) {
    const message = (error as Error).message
    const output = logs.length > 0 ? `${logs.join('\n')}\n脚本执行失败: ${message}` : `脚本执行失败: ${message}`
    return { output: truncate(output), success: false, error: message }
  }

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
  const combined = [record.output, ...(logs.length > 0 ? ['--- 日志 ---', logs.join('\n')] : [])]
    .filter((section) => section !== '')
    .join('\n')
  const result: ScriptNodeResult = { output: truncate(combined), success: record.success }
  if (data !== undefined) result.data = data
  return result
}
