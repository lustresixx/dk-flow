/**
 * Workspace run statistics: one pure aggregation over a minimal run
 * projection, fed either by the SQLite archive (SQL-side extraction) or by
 * scanning the JSON run store, so the stats route answers the same shape
 * regardless of whether archiving is enabled.
 * @module dsh-ace-harness/store
 */

/** Minimal run projection the aggregation needs. */
export interface RunStatsInput {
  status: string
  startedAt: string
  finishedAt: string | null
  states: Array<{ state: string; verdict: string }>
}

export interface WorkspaceRunStats {
  totalRuns: number
  byStatus: Record<string, number>
  /** Mean wall clock of runs with both timestamps, in ms (null when none). */
  avgDurationMs: number | null
  lastRunAt: string | null
  /** (state, verdict) counts, failures first, top 10. */
  stateHotspots: Array<{ state: string; verdict: string; count: number }>
}

/** Failures-first, frequency-second hotspot ordering (both feed paths share it). */
function sortHotspots(
  entries: Array<{ state: string; verdict: string; count: number }>,
): Array<{ state: string; verdict: string; count: number }> {
  return entries.sort((a, b) => {
    const aFail = a.verdict === 'fail' ? 1 : 0
    const bFail = b.verdict === 'fail' ? 1 : 0
    if (aFail !== bFail) return bFail - aFail
    return b.count - a.count
  }).slice(0, 10)
}

/** Aggregate one batch of run projections into workspace statistics. */
export function aggregateRunStats(rows: RunStatsInput[]): WorkspaceRunStats {
  const byStatus: Record<string, number> = {}
  const hotspots = new Map<string, { state: string; verdict: string; count: number }>()
  let durationSum = 0
  let durationCount = 0
  let lastRunAt: string | null = null
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
    if (lastRunAt === null || row.startedAt > lastRunAt) lastRunAt = row.startedAt
    if (row.finishedAt !== null) {
      const span = Date.parse(row.finishedAt) - Date.parse(row.startedAt)
      if (Number.isFinite(span) && span >= 0) {
        durationSum += span
        durationCount += 1
      }
    }
    for (const item of row.states) {
      const key = `${item.state}\n${item.verdict}`
      const entry = hotspots.get(key) ?? { state: item.state, verdict: item.verdict, count: 0 }
      entry.count += 1
      hotspots.set(key, entry)
    }
  }
  return {
    totalRuns: rows.length,
    byStatus,
    avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : null,
    lastRunAt,
    stateHotspots: sortHotspots([...hotspots.values()]),
  }
}

/** Pre-counted projection pieces (as extracted SQL-side by the archive). */
export interface RunStatsProjection {
  byStatus: Array<{ status: string; count: number }>
  runs: Array<{ startedAt: string; finishedAt: string | null }>
  stateVerdicts: Array<{ state: string; verdict: string; count: number }>
}

/** Combine SQL-side projection pieces into the same statistics shape. */
export function combineStatsProjection(projection: RunStatsProjection): WorkspaceRunStats {
  const byStatus: Record<string, number> = {}
  let totalRuns = 0
  for (const row of projection.byStatus) {
    byStatus[row.status] = row.count
    totalRuns += row.count
  }
  let durationSum = 0
  let durationCount = 0
  let lastRunAt: string | null = null
  for (const run of projection.runs) {
    if (lastRunAt === null || run.startedAt > lastRunAt) lastRunAt = run.startedAt
    if (run.finishedAt !== null) {
      const span = Date.parse(run.finishedAt) - Date.parse(run.startedAt)
      if (Number.isFinite(span) && span >= 0) {
        durationSum += span
        durationCount += 1
      }
    }
  }
  return {
    totalRuns,
    byStatus,
    avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : null,
    lastRunAt,
    stateHotspots: sortHotspots([...projection.stateVerdicts]),
  }
}
