/**
 * Script-node execution: run a step's JavaScript source in an isolated
 * node:vm context and interpret the returned value as the step outcome.
 * @module dsh-ace-harness/engine
 */
import vm from 'node:vm'

/** Context injected into a script step. */
export interface ScriptNodeInput {
  requirements: string
  state: string
  priorStepEvidence: string
  priorStateEvidence: string
  inputs: Record<string, string>
}

/** Normalized outcome of a script step. */
export interface ScriptNodeResult {
  output: string
  success: boolean
  error?: string
}

/** Wall-clock cap for one script step. */
const SCRIPT_TIMEOUT_MS = 10_000
/** Cap on the combined output text. */
const OUTPUT_BUDGET = 20_000

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

/**
 * Run one script step and interpret its return value:
 * - `{ output, success }` — success decides the binary verdict;
 * - `{ error }` or a thrown exception — failed step with the message;
 * - any other value — stringified output with success.
 */
export function runScriptNode(source: string, input: ScriptNodeInput): ScriptNodeResult {
  const logs: string[] = []
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
    context: {
      requirements: input.requirements,
      state: input.state,
      priorStepEvidence: input.priorStepEvidence,
      priorStateEvidence: input.priorStateEvidence,
      inputs: { ...input.inputs },
    },
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

  let output = ''
  let success = true
  let error: string | undefined
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.success === 'boolean') success = record.success
    if (record.output !== undefined) output = safeStringify(record.output)
    else if (record.error !== undefined) {
      error = String(record.error)
      output = error
      success = false
    } else output = safeStringify(value)
  } else if (value !== undefined && value !== null) {
    output = safeStringify(value)
  } else {
    output = logs.join('\n')
  }
  const combined = [output, ...(logs.length > 0 ? ['--- 日志 ---', logs.join('\n')] : [])]
    .filter((section) => section !== '')
    .join('\n')
  return { output: truncate(combined), success, error }
}
