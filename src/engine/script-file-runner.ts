/**
 * `scriptFile` step runner: resolve a script through the framework's script
 * locations — the workspace root, the workspace scripts collection directory
 * (`<workspace>/.ace-workflows/scripts/`), and the plugin's built-in script
 * library (`resources/scripts/`) — and dispatch by extension: JS into the vm
 * sandbox, Python into a subprocess. Never throws; every failure settles as
 * a failed step result with a readable diagnostic.
 * @module dsh-ace-harness/engine
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resourcesRoot } from '../resources.js'
import { PYTHON_TIMEOUT_MS, runPythonScript } from './python-runner.js'
import { runScriptNode, SCRIPT_TIMEOUT_MS, type ScriptNodeInput, type ScriptNodeResult } from './script-runner.js'

export interface ScriptFileOptions {
  /** Workspace root the file resolves against; absent means no workspace root. */
  projectRoot?: string
  /** Workspace scripts collection directory (`<workspace>/.ace-workflows/scripts`). */
  scriptsHome?: string
  /** Command used to launch Python (e.g. `python`, `python3`, `py -3`). */
  pythonCommand: string
  /** Per-step override of the language default timeout; undefined uses it. */
  timeoutMs?: number
  /** Per-run sandbox directory handed to Python subprocesses. */
  sandboxDir?: string
  signal: AbortSignal
}

function failed(output: string, error: string): ScriptNodeResult {
  return { output, success: false, error }
}

/**
 * Candidate paths for one `scriptFile` reference, in resolution order:
 * workspace-relative, the workspace scripts collection directory, then the
 * built-in library (bare file names only). Workspace-scoped candidates must
 * stay inside their base; escape attempts are dropped.
 */
function candidatePaths(file: string, options: ScriptFileOptions): { path: string; label: string }[] {
  const candidates: { path: string; label: string }[] = []
  const pushScoped = (base: string | undefined, label: string): void => {
    if (base === undefined) return
    const candidate = resolve(base, file)
    const rel = relative(base, candidate)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return
    candidates.push({ path: candidate, label })
  }
  pushScoped(options.projectRoot, `工作区根（${options.projectRoot ?? ''}）`)
  pushScoped(options.scriptsHome, `脚本收集目录（${options.scriptsHome ?? ''}）`)
  if (!file.includes('/') && !file.includes('\\')) {
    candidates.push({
      path: fileURLToPath(new URL(`scripts/${file}`, resourcesRoot())),
      label: '内置脚本库（resources/scripts）',
    })
  }
  return candidates
}

/**
 * Run one `scriptFile` step. Resolution order: workspace root, the workspace
 * scripts collection directory, then the built-in library. Supported
 * extensions: `.js`, `.mjs`, `.cjs` (vm sandbox) and `.py` (Python subprocess).
 */
export async function runScriptFile(
  file: string,
  input: ScriptNodeInput,
  options: ScriptFileOptions,
): Promise<ScriptNodeResult> {
  const candidates = candidatePaths(file, options)
  if (candidates.length === 0 && file.includes('..')) {
    return failed(
      `脚本路径越界：${file} 不在工作区或脚本收集目录内`,
      `脚本路径越界：${file}`,
    )
  }
  const filePath = candidates.find((candidate) => existsSync(candidate.path))?.path
  if (filePath === undefined) {
    const searched = candidates.map((candidate) => candidate.label).join('、')
    return failed(
      `脚本「${file}」不存在。已查找：${searched || '工作区根'}。可把通用脚本放进脚本收集目录（.ace-workflows/scripts/），用 /workflow scripts 查看可用脚本。`,
      `脚本不存在：${file}`,
    )
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
    return runScriptNode(source, input, {
      timeoutMs: options.timeoutMs ?? SCRIPT_TIMEOUT_MS,
      signal: options.signal,
    })
  }
  if (ext === '.py') {
    return runPythonScript({
      command: options.pythonCommand,
      filePath,
      input,
      timeoutMs: options.timeoutMs ?? PYTHON_TIMEOUT_MS,
      signal: options.signal,
      sandboxDir: options.sandboxDir,
    })
  }
  return failed(
    `不支持的脚本扩展名 ${ext === '' ? '（无扩展名）' : ext}：支持 .js/.mjs/.cjs/.py`,
    `不支持的脚本扩展名 ${ext}`,
  )
}
