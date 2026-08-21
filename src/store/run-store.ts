/**
 * File-based run persistence: one directory per run under
 * `<workspace>/<runDirName>/runs/<runId>` holding `state.json` and an
 * append-only `audit.jsonl` event log. Writes are temp-file + rename.
 * @module dsh-ace-harness/store
 */
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
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

/**
 * Bounded grace window for the pid-live exemption (P1-1 adjudication): a
 * non-terminal run whose recorded owner process is alive is kept `running`
 * past the staleness bound ONLY for this much extra time. Sized to cover a
 * genuinely slow step under the DEFAULT configuration (step timeout 30 min ×
 * (1 + maxRetries ≤ 10) ≈ 5.5 h, plus supervisor/backoff slack) with >2×
 * margin, while still reporting a hung run as `crashed` instead of exempting
 * it forever. Custom per-step `timeoutMinutes` (schema max 1440) or retry
 * budgets beyond the grace are operator overrides: the run then reads
 * `crashed` after the window — display-only, state.json is never touched and
 * `/workflow resume` keeps working.
 */
export const PID_LIVE_GRACE_MS = 12 * 60 * 60_000

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

/** Machine identity used to trust a recorded run-owner pid (hostname). */
export function currentHostId(): string {
  return hostname()
}

/**
 * Whether a recorded run owner (pid on its recorded host) is alive on THIS
 * machine. A pid is trusted only when the run recorded the SAME host: a pid
 * recorded by another machine can only collide with an unrelated local
 * process (cross-machine false-live, P1-2). Same-machine pid reuse stays
 * bounded by the grace window in `normalizeRunStatus`. Missing host or pid is
 * never trusted — those runs fall back to the pure time rule.
 */
export function isOwnerAlive(
  owner: { pid?: number; hostId?: string },
  host: string = currentHostId(),
  isAlive: (pid: number) => boolean = isPidAlive,
): boolean {
  return owner.pid !== undefined && owner.hostId !== undefined && owner.hostId === host && isAlive(owner.pid)
}

/**
 * Normalize ONE run status for display/stats (P1-2): a non-terminal run whose
 * `updatedAt` is older than the staleness bound AND whose owning process is
 * gone was abandoned and reads as `crashed`. A live same-host owner keeps the
 * run `running` even when a long step has not persisted recently — a slow
 * step is not a crash — but only within the bounded grace window
 * (`PID_LIVE_GRACE_MS`), so a hung run is eventually reported as crashed.
 * THE single stale rule — shared by the JSON store scan (`normalizeStaleRun`)
 * and the SQLite archive's stats projection, so both feed adapters count
 * zombie runs identically instead of diverging.
 */
export function normalizeRunStatus(
  status: string,
  updatedAt: string,
  now = Date.now(),
  pidAlive = false,
): RunState['status'] {
  if (TERMINAL_STATUSES.has(status)) return status as RunState['status']
  const updated = Date.parse(updatedAt)
  if (!Number.isFinite(updated)) return status as RunState['status']
  const age = now - updated
  if (age <= STALE_RUN_MS) return status as RunState['status']
  // Stale (> STALE_RUN_MS): abandoned UNLESS a same-host live owner is still
  // around within the bounded grace window. The cap restores hang detection:
  // a run that stops persisting for far longer than any plausible step
  // (default timeout × max retries ≈ 5.5 h) reads `crashed` even with a live
  // pid (P1-1).
  if (pidAlive && age <= STALE_RUN_MS + PID_LIVE_GRACE_MS) return status as RunState['status']
  return 'crashed'
}

/**
 * Normalize a loaded run state for display: a non-terminal run whose
 * `updatedAt` is older than the staleness bound AND whose owning process is
 * gone was abandoned. Its status reads as `crashed` (without touching the
 * stored file, so `/workflow resume` keeps working), keeping zombie `running`
 * entries out of live discovery while never misreading a live long step.
 * The owner is trusted only when it recorded THIS machine's host (isOwnerAlive),
 * so a pid recycled by an unrelated process or recorded on another machine
 * cannot grant an unbounded exemption.
 */
export function normalizeStaleRun(
  state: RunState,
  now = Date.now(),
  isAlive: (pid: number) => boolean = isPidAlive,
  host: string = currentHostId(),
): RunState {
  const pidAlive = isOwnerAlive(state, host, isAlive)
  const status = normalizeRunStatus(state.status, state.updatedAt, now, pidAlive)
  if (status === state.status) return state
  return {
    ...state,
    status,
    // A live pid past the grace window means the process is still there but
    // the run stopped persisting — hung, not exited; say so for diagnosis.
    error: pidAlive
      ? '运行中断（进程仍存活但长时间无更新，疑似挂起），可用 /workflow resume 恢复'
      : '运行中断（进程已退出或长时间无更新），可用 /workflow resume 恢复',
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
