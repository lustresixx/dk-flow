/**
 * SQLite run archive (`<workspace>/<runDirName>/archive.db`): an opt-in,
 * queryable mirror of the file-based run store. Every persisted run snapshot
 * lands in `runs` (full evidence chain inside `state_json`); every audit
 * event lands in `audit`. The JSON files stay the source of truth — the
 * archive is a long-term, structured index over them.
 * @module dsh-ace-harness/store
 */
import { mkdirSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { RunState } from '../engine/types.js'
import { effectiveStepDurationMs } from './audit-events.js'
import { runDir, runsRoot, runStateDir } from './paths.js'
import { isPidAlive, normalizeRunStatus } from './run-store.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  workflow_name TEXT NOT NULL,
  config_file TEXT NOT NULL,
  status TEXT NOT NULL,
  current_state TEXT,
  transition_count INTEGER NOT NULL,
  total_steps INTEGER NOT NULL,
  completed_steps INTEGER NOT NULL,
  verdict TEXT,
  error TEXT,
  parent_session_id TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  state_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_workflow ON runs (workflow_name);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_run ON audit (run_id, id);
`

/** One archived run row (summary fields; the evidence chain stays in state_json). */
export interface ArchivedRunRow {
  runId: string
  workflowName: string
  status: string
  currentState: string | null
  transitionCount: number
  totalSteps: number
  completedSteps: number
  verdict: string | null
  error: string | null
  parentSessionId: string | null
  startedAt: string
  updatedAt: string
  finishedAt: string | null
}

/** One archived audit event. */
export interface ArchivedAuditRow {
  id: number
  at: string
  event: string
  payload: Record<string, unknown>
}

interface RawRunRow {
  run_id: string
  workflow_name: string
  status: string
  current_state: string | null
  transition_count: number
  total_steps: number
  completed_steps: number
  verdict: string | null
  error: string | null
  parent_session_id: string | null
  started_at: string
  updated_at: string
  finished_at: string | null
}

function mapRow(row: RawRunRow): ArchivedRunRow {
  return {
    runId: row.run_id,
    workflowName: row.workflow_name,
    status: row.status,
    currentState: row.current_state,
    transitionCount: row.transition_count,
    totalSteps: row.total_steps,
    completedSteps: row.completed_steps,
    verdict: row.verdict,
    error: row.error,
    parentSessionId: row.parent_session_id,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  }
}

/**
 * Lazily-opened per-workspace archive databases. Writes are synchronous
 * (node:sqlite DatabaseSync) so mirroring never adds latency to the run loop.
 */
export class SqliteArchive {
  private readonly dbs = new Map<string, DatabaseSync>()

  /** Absolute path of the workspace's archive database file. */
  dbFile(workspace: string, runDirName: string): string {
    return join(runStateDir(workspace, runDirName), 'archive.db')
  }

  private open(workspace: string, runDirName: string): DatabaseSync {
    const key = `${workspace}\n${runDirName}`
    const existing = this.dbs.get(key)
    if (existing) return existing
    mkdirSync(runStateDir(workspace, runDirName), { recursive: true })
    const db = new DatabaseSync(this.dbFile(workspace, runDirName))
    // Multi-instance tolerance: WAL lets concurrent readers/writers coexist
    // (several dsh instances may share one workspace), busy_timeout absorbs
    // short lock contention instead of erroring into the run path.
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec(SCHEMA)
    this.dbs.set(key, db)
    return db
  }

  /** Mirror one run snapshot (insert or refresh on every persist). */
  archiveRun(workspace: string, runDirName: string, state: RunState): void {
    const db = this.open(workspace, runDirName)
    db.prepare(
      `INSERT INTO runs (
         run_id, workflow_name, config_file, status, current_state,
         transition_count, total_steps, completed_steps, verdict, error,
         parent_session_id, started_at, updated_at, finished_at, state_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         status = excluded.status,
         current_state = excluded.current_state,
         transition_count = excluded.transition_count,
         completed_steps = excluded.completed_steps,
         verdict = excluded.verdict,
         error = excluded.error,
         updated_at = excluded.updated_at,
         finished_at = excluded.finished_at,
         state_json = excluded.state_json`,
    ).run(
      state.id,
      state.workflowName,
      state.configFile,
      state.status,
      state.currentState,
      state.transitionCount,
      state.totalSteps,
      state.completedSteps,
      this.runVerdict(state),
      state.error,
      state.parentSessionId ?? null,
      state.startedAt,
      state.updatedAt,
      state.finishedAt,
      JSON.stringify(state),
    )
  }

  /** Run-level verdict mirrors RunResult: the last completed state's verdict. */
  private runVerdict(state: RunState): string | null {
    return state.stateOutcomes[state.stateOutcomes.length - 1]?.verdict.verdict ?? null
  }

  /** Mirror one audit event (the JSONL row, verbatim). */
  archiveAudit(workspace: string, runDirName: string, runId: string, event: Record<string, unknown>): void {
    const db = this.open(workspace, runDirName)
    const at = typeof event['at'] === 'string' ? (event['at'] as string) : new Date().toISOString()
    const kind = typeof event['event'] === 'string' ? (event['event'] as string) : 'event'
    db.prepare('INSERT INTO audit (run_id, at, event, payload_json) VALUES (?, ?, ?, ?)').run(
      runId,
      at,
      kind,
      JSON.stringify(event),
    )
  }

  /** Total archived runs of a workspace. */
  countRuns(workspace: string, runDirName: string): number {
    const db = this.open(workspace, runDirName)
    const row = db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }
    return row.n
  }

  /** Archived runs, newest first, with optional filters. */
  queryRuns(
    workspace: string,
    runDirName: string,
    query: { limit?: number; offset?: number; workflow?: string; status?: string } = {},
  ): ArchivedRunRow[] {
    const db = this.open(workspace, runDirName)
    const clauses: string[] = []
    const params: string[] = []
    if (query.workflow) {
      clauses.push('workflow_name = ?')
      params.push(query.workflow)
    }
    if (query.status) {
      clauses.push('status = ?')
      params.push(query.status)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(query.limit ?? 50, 500))
    const offset = Math.max(0, query.offset ?? 0)
    const rows = db
      .prepare(
        `SELECT run_id, workflow_name, status, current_state, transition_count,
                total_steps, completed_steps, verdict, error, parent_session_id,
                started_at, updated_at, finished_at
         FROM runs ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as RawRunRow[]
    return rows.map(mapRow)
  }

  /** Full archived detail of one run: evidence chain + audit timeline. */
  queryRunDetail(
    workspace: string,
    runDirName: string,
    runId: string,
  ): { run: ArchivedRunRow; state: RunState | null; audit: ArchivedAuditRow[] } | null {
    const db = this.open(workspace, runDirName)
    const row = db
      .prepare(
        `SELECT run_id, workflow_name, status, current_state, transition_count,
                total_steps, completed_steps, verdict, error, parent_session_id,
                started_at, updated_at, finished_at, state_json
         FROM runs WHERE run_id = ?`,
      )
      .get(runId) as (RawRunRow & { state_json: string }) | undefined
    if (!row) return null
    let state: RunState | null = null
    try {
      state = JSON.parse(row.state_json) as RunState
    } catch {
      state = null
    }
    const audit = db
      .prepare('SELECT id, at, event, payload_json FROM audit WHERE run_id = ? ORDER BY id')
      .all(runId) as unknown as Array<{ id: number; at: string; event: string; payload_json: string }>
    return {
      run: mapRow(row),
      state,
      audit: audit.map((item) => {
        let payload: Record<string, unknown> = {}
        try {
          payload = JSON.parse(item.payload_json) as Record<string, unknown>
        } catch {
          payload = {}
        }
        return { id: item.id, at: item.at, event: item.event, payload }
      }),
    }
  }

  /**
   * Import the file-based run store into the archive (idempotent: runs are
   * upserted; audit rows import only for runs with no archived events yet).
   * @returns the number of runs imported.
   */
  async backfill(workspace: string, runDirName: string): Promise<number> {
    let runIds: string[] = []
    try {
      const entries = await readdir(runsRoot(workspace, runDirName), { withFileTypes: true })
      runIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return 0
    }
    const db = this.open(workspace, runDirName)
    const auditCount = db.prepare('SELECT COUNT(*) AS n FROM audit WHERE run_id = ?')
    let imported = 0
    for (const runId of runIds) {
      try {
        const state = JSON.parse(
          await readFile(join(runDir(workspace, runId, runDirName), 'state.json'), 'utf8'),
        ) as RunState
        if (state.id !== runId) continue
        this.archiveRun(workspace, runDirName, state)
        imported += 1
        const hasAudit = (auditCount.get(runId) as { n: number }).n > 0
        if (!hasAudit) {
          try {
            const lines = await readFile(join(runDir(workspace, runId, runDirName), 'audit.jsonl'), 'utf8')
            for (const line of lines.split('\n')) {
              const trimmed = line.trim()
              if (trimmed === '') continue
              try {
                this.archiveAudit(workspace, runDirName, runId, JSON.parse(trimmed) as Record<string, unknown>)
              } catch {
                // Skip an unparseable audit line.
              }
            }
          } catch {
            // No audit file for this run.
          }
        }
      } catch {
        // Skip an unreadable run directory.
      }
    }
    return imported
  }

  /**
   * SQL-side statistics projection: per-run status/timestamps, the
   * (state, verdict) matrix, raw step rows, and failed-step rows — all
   * extracted from state_json with JSON1. Step rows carry the EFFECTIVE
   * duration (monotonic measurement preferred, wall-clock span fallback, see
   * `effectiveStepDurationMs`), so the SQL feed and the file feed answer
   * byte-identical statistics for new AND legacy runs (P1-B / P1-②). Run
   * statuses pass through the SAME stale normalization as the file scan
   * (P1-2): a zombie `running` row abandoned by a dead process reads as
   * `crashed` in both feeds, so the status counts cannot diverge.
   * @param now - staleness reference instant (injected for deterministic tests).
   */
  queryStatsProjection(
    workspace: string,
    runDirName: string,
    now = Date.now(),
  ): {
    byStatus: Array<{ status: string; count: number }>
    runs: Array<{ startedAt: string; finishedAt: string | null; status: string }>
    stateVerdicts: Array<{ state: string; verdict: string; count: number }>
    steps: Array<{ state: string; step: string; verdict: string | null; attempts: number | null; durationMs: number | null }>
    failedSteps: Array<{ state: string; step: string; attempts: number | null }>
  } {
    const db = this.open(workspace, runDirName)
    // Status counts derive from the SAME normalized run rows the kernel sees
    // (aggregateWorkspaceStats counts `runs`, not this map), so the two can
    // never disagree about a zombie run.
    const runs = db
      .prepare("SELECT started_at, finished_at, status, updated_at, json_extract(state_json, '$.pid') AS pid FROM runs")
      .all() as unknown as Array<{
        started_at: string
        finished_at: string | null
        status: string
        updated_at: string
        pid: number | null
      }>
    const statusCounts = new Map<string, number>()
    for (const row of runs) {
      const status = normalizeRunStatus(row.status, row.updated_at, now, row.pid !== null && isPidAlive(row.pid))
      statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1)
    }
    const stateVerdicts = db
      .prepare(
        `SELECT json_extract(j.value, '$.state') AS state,
                json_extract(j.value, '$.verdict.verdict') AS verdict,
                COUNT(*) AS n
         FROM runs, json_each(runs.state_json, '$.stateOutcomes') AS j
         GROUP BY 1, 2`,
      )
      .all() as unknown as Array<{ state: string; verdict: string; n: number }>
    const steps = db
      .prepare(
        `SELECT json_extract(o.value, '$.state') AS state,
                json_extract(j.value, '$.step') AS step,
                json_extract(j.value, '$.verdict.verdict') AS verdict,
                json_extract(j.value, '$.attempts') AS attempts,
                json_extract(j.value, '$.durationMs') AS durationMs,
                json_extract(j.value, '$.startedAt') AS startedAt,
                json_extract(j.value, '$.finishedAt') AS finishedAt
         FROM runs,
              json_each(runs.state_json, '$.stateOutcomes') AS o,
              json_each(o.value, '$.steps') AS j`,
      )
      .all() as unknown as Array<{
        state: unknown
        step: unknown
        verdict: unknown
        attempts: unknown
        durationMs: unknown
        startedAt: unknown
        finishedAt: unknown
      }>
    const failedSteps = db
      .prepare(
        `SELECT json_extract(j.value, '$.state') AS state,
                json_extract(j.value, '$.step') AS step,
                json_extract(j.value, '$.attempts') AS attempts
         FROM runs, json_each(runs.state_json, '$.failedSteps') AS j`,
      )
      .all() as unknown as Array<{ state: unknown; step: unknown; attempts: unknown }>
    return {
      byStatus: [...statusCounts.entries()].map(([status, count]) => ({ status, count })),
      runs: runs.map((row) => ({
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        // Same stale rule as the file scan (P1-2): abandoned non-terminal
        // runs count as `crashed`, exactly like the JSON feed's
        // `normalizeStaleRun`, so /stats cannot split by feed. A live pid
        // keeps a slow-but-alive run `running`.
        status: normalizeRunStatus(row.status, row.updated_at, now, row.pid !== null && isPidAlive(row.pid)),
      })),
      stateVerdicts: stateVerdicts
        .filter((row) => typeof row.state === 'string' && typeof row.verdict === 'string')
        .map((row) => ({ state: row.state, verdict: row.verdict, count: row.n })),
      steps: steps.flatMap((row) => {
        if (typeof row.state !== 'string' || typeof row.step !== 'string') return []
        return [{
          state: row.state,
          step: row.step,
          verdict: typeof row.verdict === 'string' ? row.verdict : null,
          attempts: typeof row.attempts === 'number' ? row.attempts : null,
          // Effective duration — the SAME definition the JSON feed uses
          // (P1-②): a legacy row without durationMs falls back to its
          // wall-clock span instead of dropping out of the histogram, so the
          // SQL feed and the file feed cannot diverge on old data.
          durationMs: effectiveStepDurationMs({
            durationMs: typeof row.durationMs === 'number' ? row.durationMs : null,
            startedAt: typeof row.startedAt === 'string' ? row.startedAt : null,
            finishedAt: typeof row.finishedAt === 'string' ? row.finishedAt : null,
          }),
        }]
      }),
      failedSteps: failedSteps.flatMap((row) => {
        if (typeof row.state !== 'string' || typeof row.step !== 'string') return []
        return [{
          state: row.state,
          step: row.step,
          attempts: typeof row.attempts === 'number' ? row.attempts : null,
        }]
      }),
    }
  }

  /** Close every open archive database. */
  close(): void {
    for (const db of this.dbs.values()) {
      try {
        db.close()
      } catch {
        // Already closed.
      }
    }
    this.dbs.clear()
  }
}
