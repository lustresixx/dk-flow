/**
 * `scriptFile` step runner: load a workspace-relative script and dispatch by
 * extension — JS into the vm sandbox, Python into a subprocess. Never throws;
 * every failure settles as a failed step result with a readable diagnostic.
 * @module dsh-ace-harness/engine
 */
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { PYTHON_TIMEOUT_MS, runPythonScript } from './python-runner.js'
import { runScriptNode, SCRIPT_TIMEOUT_MS, type ScriptNodeInput, type ScriptNodeResult } from './script-runner.js'

export interface ScriptFileOptions {
  /** Workspace root the file resolves against; absent means the CWD. */
  projectRoot?: string
  /** Command used to launch Python (e.g. `python`, `python3`, `py -3`). */
  pythonCommand: string
  /** Per-step override of the language default timeout; undefined uses it. */
  timeoutMs?: number
  signal: AbortSignal
}

function failed(output: string, error: string): ScriptNodeResult {
  return { output, success: false, error }
}

/**
 * Run one `scriptFile` step. The file must sit inside the workspace root
 * when one is declared. Supported extensions: `.js`, `.mjs`, `.cjs` (vm
 * sandbox) and `.py` (Python subprocess).
 */
export async function runScriptFile(
  file: string,
  input: ScriptNodeInput,
  options: ScriptFileOptions,
): Promise<ScriptNodeResult> {
  const base = options.projectRoot ? resolve(options.projectRoot) : undefined
  const filePath = resolve(base ?? process.cwd(), file)
  if (base) {
    const rel = relative(base, filePath)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      return failed(
        `脚本路径越界：${file} 不在工作区 ${base} 内`,
        `脚本路径越界：${file}`,
      )
    }
  }
  let source: string
  try {
    source = await readFile(filePath, 'utf8')
  } catch (error) {
    return failed(
      `脚本文件读取失败：${(error as Error).message}`,
      `脚本文件读取失败：${file}`,
    )
  }
  const ext = extname(filePath).toLowerCase()
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return runScriptNode(source, input, { timeoutMs: options.timeoutMs ?? SCRIPT_TIMEOUT_MS })
  }
  if (ext === '.py') {
    return runPythonScript({
      command: options.pythonCommand,
      filePath,
      input,
      timeoutMs: options.timeoutMs ?? PYTHON_TIMEOUT_MS,
      signal: options.signal,
    })
  }
  return failed(
    `不支持的脚本扩展名 ${ext === '' ? '（无扩展名）' : ext}：支持 .js/.mjs/.cjs/.py`,
    `不支持的脚本扩展名 ${ext}`,
  )
}
