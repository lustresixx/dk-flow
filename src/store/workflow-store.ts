/**
 * File-based workflow instance store: project-level `.dsh/workflows` and
 * personal `$DSH_HOME/workflows`, project entries shadowing personal ones by
 * name. Built-in templates live in the packaged resources.
 * @module dsh-ace-harness/store
 */
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parseWorkflowYaml, summarizeWorkflow, type WorkflowSummary } from '../dsl/load.js'
import type { WorkflowConfig } from '../dsl/types.js'
import { writeFileAtomic } from './atomic.js'
import { personalWorkflowsDir, projectWorkflowsDir } from './paths.js'

/** One discovered workflow instance. */
export interface WorkflowEntry {
  /** Display name (workflow.name inside the config). */
  name: string
  /** File name without extension, used as the instance id. */
  fileName: string
  /** Absolute config path. */
  file: string
  /** Discovery source; project shadows personal. */
  source: 'project' | 'personal'
  summary: WorkflowSummary
}

async function listYamlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

async function loadEntry(dir: string, fileName: string, source: 'project' | 'personal'): Promise<WorkflowEntry | null> {
  const file = join(dir, fileName)
  let config: WorkflowConfig
  try {
    config = parseWorkflowYaml(await readFile(file, 'utf8'))
  } catch {
    return null
  }
  return {
    name: config.workflow.name,
    fileName: basename(fileName, '.yaml'),
    file,
    source,
    summary: summarizeWorkflow(config),
  }
}

/**
 * Discover workflow instances: project directory first, then personal, with
 * project entries shadowing personal ones by file name. Unparseable files are
 * skipped, not fatal.
 */
export async function listWorkflows(workspace: string): Promise<WorkflowEntry[]> {
  const projectDir = projectWorkflowsDir(workspace)
  const personalDir = personalWorkflowsDir()
  const personalFiles = (await listYamlFiles(personalDir)).filter(
    (name) => name.startsWith('_') === false,
  )
  const entries: WorkflowEntry[] = []
  const seen = new Set<string>()
  for (const fileName of await listYamlFiles(projectDir)) {
    const entry = await loadEntry(projectDir, fileName, 'project')
    if (entry) {
      entries.push(entry)
      seen.add(entry.fileName)
    }
  }
  for (const fileName of personalFiles) {
    const key = basename(fileName, '.yaml')
    if (seen.has(key)) continue
    const entry = await loadEntry(personalDir, fileName, 'personal')
    if (entry) entries.push(entry)
  }
  return entries
}

/** Load one workflow instance by file name (project first, then personal). */
export async function loadWorkflow(
  workspace: string,
  fileName: string,
): Promise<{ config: WorkflowConfig; file: string } | null> {
  const safeName = fileName.endsWith('.yaml') ? fileName : `${fileName}.yaml`
  for (const dir of [projectWorkflowsDir(workspace), personalWorkflowsDir()]) {
    const file = join(dir, safeName)
    try {
      const config = parseWorkflowYaml(await readFile(file, 'utf8'))
      return { config, file }
    } catch {
      // Try the next discovery root.
    }
  }
  return null
}

/** Save a workflow instance into the project directory (atomic write). */
export async function saveWorkflow(
  workspace: string,
  fileName: string,
  yamlText: string,
): Promise<string> {
  const dir = projectWorkflowsDir(workspace)
  await mkdir(dir, { recursive: true })
  const safeName = fileName.endsWith('.yaml') ? fileName : `${fileName}.yaml`
  if (!/^[A-Za-z0-9_-]+\.yaml$/.test(safeName)) {
    throw new Error(`workflow 文件名非法：${safeName}（只允许字母、数字、下划线、连字符）`)
  }
  const file = join(dir, safeName)
  await writeFileAtomic(file, yamlText)
  return file
}

/** Delete a project workflow instance by file name. */
export async function deleteWorkflow(workspace: string, fileName: string): Promise<boolean> {
  const safeName = fileName.endsWith('.yaml') ? fileName : `${fileName}.yaml`
  const file = join(projectWorkflowsDir(workspace), safeName)
  try {
    await rm(file)
    return true
  } catch {
    return false
  }
}
