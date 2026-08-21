/**
 * File-based run persistence: one directory per run under
 * `<workspace>/<runDirName>/runs/<runId>` holding `state.json` and an
 * append-only `audit.jsonl` event log. Writes are temp-file + rename.
 * @module dsh-ace-harness/store
 */
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunState } from '../engine/types.js'
import { writeFileAtomic } from './atomic.js'
import { runDir, runsRoot } from './paths.js'

/** Persist one run state snapshot (atomic replace). */
export async function saveRunState(
  workspace: string,
  state: RunState,
  runDirName: string,
): Promise<void> {
  const dir = runDir(workspace, state.id, runDirName)
  await mkdir(dir, { recursive: true })
  await writeFileAtomic(join(dir, 'state.json'), JSON.stringify(state, null, 2))
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

/** Non-terminal runs untouched for this long are treated as interrupted. */
export const STALE_RUN_MS = 10 * 60_000

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'crashed'])

/** True when a process id refers to a live process on this machine. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but we lack signal permission — alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Normalize ONE run status for display/stats (P1-2): a non-terminal run whose
 * `updatedAt` is older than the staleness bound AND whose owning process is
 * gone was abandoned and reads as `crashed`. A live pid keeps the run
 * `running` even when a long step has not persisted recently — a slow step is
 * not a crash. THE single stale rule — shared by the JSON store scan
 * (`normalizeStaleRun`) and the SQLite archive's stats projection, so both
 * feed adapters count zombie runs identically instead of diverging.
 */
export function normalizeRunStatus(
  status: string,
  updatedAt: string,
  now = Date.now(),
  pidAlive = false,
): RunState['status'] {
  if (TERMINAL_STATUSES.has(status)) return status as RunState['status']
  if (pidAlive) return status as RunState['status']
  const updated = Date.parse(updatedAt)
  if (Number.isFinite(updated) && now - updated > STALE_RUN_MS) return 'crashed'
  return status as RunState['status']
}

/**
 * Normalize a loaded run state for display: a non-terminal run whose
 * `updatedAt` is older than the staleness bound AND whose owning process is
 * gone was abandoned. Its status reads as `crashed` (without touching the
 * stored file, so `/workflow resume` keeps working), keeping zombie `running`
 * entries out of live discovery while never misreading a live long step.
 */
export function normalizeStaleRun(
  state: RunState,
  now = Date.now(),
  isAlive: (pid: number) => boolean = isPidAlive,
): RunState {
  const pidAlive = state.pid !== undefined && isAlive(state.pid)
  const status = normalizeRunStatus(state.status, state.updatedAt, now, pidAlive)
  if (status === state.status) return state
  return {
    ...state,
    status,
    error: '运行中断（进程已退出或长时间无更新），可用 /workflow resume 恢复',
  }
}

/** Load every run state of a workspace (skipping unreadable ones). */
export async function listRunStates(workspace: string, runDirName: string): Promise<RunState[]> {
  const states: RunState[] = []
  for (const runId of await listRunIds(workspace, runDirName)) {
    const state = await loadRunState(workspace, runId, runDirName)
    if (state) states.push(normalizeStaleRun(state))
  }
  return states
}
