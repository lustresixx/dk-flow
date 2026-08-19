/**
 * File-based run persistence: one directory per run under
 * `<workspace>/<runDirName>/runs/<runId>` holding `state.json` and an
 * append-only `audit.jsonl` event log. Writes are temp-file + rename.
 * @module dsh-ace-harness/store
 */
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunState } from '../engine/types.js'
import { runDir, runsRoot } from './paths.js'

/** Persist one run state snapshot (atomic replace). */
export async function saveRunState(
  workspace: string,
  state: RunState,
  runDirName: string,
): Promise<void> {
  const dir = runDir(workspace, state.id, runDirName)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'state.json')
  const temp = `${file}.tmp`
  await writeFile(temp, JSON.stringify(state, null, 2), 'utf8')
  await rename(temp, file)
}

/** Load a persisted run state, or null when absent or unreadable. */
export async function loadRunState(
  workspace: string,
  runId: string,
  runDirName: string,
): Promise<RunState | null> {
  try {
    const text = await readFile(join(runDir(workspace, runId, runDirName), 'state.json'), 'utf8')
    const parsed = JSON.parse(text) as RunState
    return parsed.id === runId ? parsed : null
  } catch {
    return null
  }
}

/** Append one JSON audit event to the run log. */
export async function appendAudit(
  workspace: string,
  runId: string,
  runDirName: string,
  event: Record<string, unknown>,
): Promise<void> {
  const dir = runDir(workspace, runId, runDirName)
  await mkdir(dir, { recursive: true })
  await appendFile(join(dir, 'audit.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
}

/** List run ids of a workspace, newest first. */
export async function listRunIds(workspace: string, runDirName: string): Promise<string[]> {
  try {
    const entries = await readdir(runsRoot(workspace, runDirName), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
  } catch {
    return []
  }
}

/** Load every run state of a workspace (skipping unreadable ones). */
export async function listRunStates(workspace: string, runDirName: string): Promise<RunState[]> {
  const states: RunState[] = []
  for (const runId of await listRunIds(workspace, runDirName)) {
    const state = await loadRunState(workspace, runId, runDirName)
    if (state) states.push(state)
  }
  return states
}
