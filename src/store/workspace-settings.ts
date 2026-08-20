/**
 * Per-workspace plugin settings (`<workspace>/<runDirName>/settings.json`),
 * revalidated by file mtime so out-of-process edits are picked up while
 * repeated reads stay cheap.
 * @module dsh-ace-harness/store
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runStateDir } from './paths.js'

/** Workspace-level toggles. Every field defaults to off/false. */
export interface WorkspaceSettings {
  /** Mirror run states + audit events into the SQLite archive. */
  sqliteArchive: boolean
}

const DEFAULT_SETTINGS: WorkspaceSettings = { sqliteArchive: false }

interface CacheEntry {
  mtimeMs: number | null
  value: WorkspaceSettings
}

const cache = new Map<string, CacheEntry>()

function settingsFile(workspace: string, runDirName: string): string {
  return join(runStateDir(workspace, runDirName), 'settings.json')
}

function normalize(raw: unknown): WorkspaceSettings {
  const record = (raw ?? {}) as Record<string, unknown>
  return { sqliteArchive: record['sqliteArchive'] === true }
}

/** Read the workspace settings (freshness checked by mtime). */
export async function readWorkspaceSettings(
  workspace: string,
  runDirName: string,
): Promise<WorkspaceSettings> {
  const file = settingsFile(workspace, runDirName)
  let mtimeMs: number | null = null
  try {
    mtimeMs = (await stat(file)).mtimeMs
  } catch {
    // No file yet: defaults, cached so we do not stat on every persist.
  }
  const cached = cache.get(file)
  if (cached && cached.mtimeMs === mtimeMs) return cached.value
  let value = DEFAULT_SETTINGS
  if (mtimeMs !== null) {
    try {
      value = normalize(JSON.parse(await readFile(file, 'utf8')))
    } catch {
      value = DEFAULT_SETTINGS
    }
  }
  cache.set(file, { mtimeMs, value })
  return value
}

/** Merge a patch into the workspace settings and persist them. */
export async function writeWorkspaceSettings(
  workspace: string,
  runDirName: string,
  patch: Partial<WorkspaceSettings>,
): Promise<WorkspaceSettings> {
  const current = await readWorkspaceSettings(workspace, runDirName)
  const next: WorkspaceSettings = { ...current, ...patch }
  const file = settingsFile(workspace, runDirName)
  await mkdir(runStateDir(workspace, runDirName), { recursive: true })
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  cache.set(file, { mtimeMs: (await stat(file)).mtimeMs, value: next })
  return next
}
