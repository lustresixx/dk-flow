/**
 * Workspace run statistics: ONE pure aggregation kernel fed by two adapters
 * (P1-B). The JSON-scan feed (`aggregateRunStats`) and the SQLite-archive feed
 * (`combineStatsProjection`) both normalize their data into the same input
 * shape and hand it to `aggregateWorkspaceStats`, so the byStatus / duration /
 * hotspot / step-level math exists exactly once. The stats route answers the
 * same shape regardless of whether archiving is enabled.
 *
 * Step-level aggregation (P0-B): fixed-bucket duration histogram + p50/p95,
 * retry counts (attempts > 1), (state, step, verdict) hotspots with failures
 * first, and failed-step hotspots fed by `RunState.failedSteps` (steps that
 * threw have no StepOutcome, so they cannot appear in the completed-step
 * aggregation). Durations are the effective step durations — monotonic
 * measurement preferred, timestamp span fallback (see `stepDurationMs`).
 * @module dsh-ace-harness/store
 */

/** Minimal run projection the JSON-scan feed produces per run. */
export interface RunStatsInput {
  status: string
  startedAt: string
  finishedAt: string | null
  states: Array<{ state: string; verdict: string }>
  /** Completed steps of the run (optional: pre-instrumentation feeds omit it). */
  steps?: StepStatsInput[]
  /** Steps that threw (RunState.failedSteps), optional for the same reason. */
  failedSteps?: FailedStepStatsInput[]
}

/** One completed step row of a run projection. */
export interface StepStatsInput {
  state: string
  step: string
  verdict: string | null
  attempts?: number | null
  /** Effective duration in ms (monotonic preferred, timestamp fallback). */
  durationMs?: number | null
}

/** One failed step row of a run projection. */
export interface FailedStepStatsInput {
  state: string
  step: string
  attempts?: number | null
}

/** One fixed duration bucket of the step histogram. */
export interface StepDurationBucket {
  label: string
  /** Inclusive lower bound, ms. */
  minMs: number
  /** Exclusive upper bound, ms; null means unbounded. */
  maxMs: number | null
  count: number
}

/**
 * Fixed bucket boundaries tuned to this repo's step scale (seconds to tens of
 * minutes; the default step timeout is 1800s). A duration lands in the bucket
 * where `minMs <= d < maxMs`; the last bucket is unbounded.
 */
export const STEP_DURATION_BUCKETS: Array<Omit<StepDurationBucket, 'count'>> = [
  { label: '<1s', minMs: 0, maxMs: 1000 },
  { label: '1-5s', minMs: 1000, maxMs: 5000 },
  { label: '5-30s', minMs: 5000, maxMs: 30_000 },
  { label: '30-120s', minMs: 30_000, maxMs: 120_000 },
  { label: '>120s', minMs: 120_000, maxMs: null },
]

export interface WorkspaceRunStats {
  totalRuns: number
  byStatus: Record<string, number>
  /** Mean wall clock of runs with both timestamps, in ms (null when none). */
  avgDurationMs: number | null
  lastRunAt: string | null
  /** (state, verdict) counts, failures first, top 10. */
  stateHotspots: Array<{ state: string; verdict: string; count: number }>
  /** Completed step count (failed steps are reported separately). */
  stepCount: number
  /** Fixed-bucket histogram of completed-step durations. */
  stepDurationBuckets: StepDurationBucket[]
  /** Nearest-rank percentiles of completed-step durations (null when none). */
  stepDurationPercentiles: { p50: number | null; p95: number | null }
  /** Steps that needed at least one retry (attempts > 1). */
  stepRetryCount: number
  /** Total retries across all steps (sum of attempts − 1). */
  stepRetryTotal: number
  /** (state, step, verdict) counts over completed steps, failures first, top 10. */
  stepHotspots: Array<{ state: string; step: string; verdict: string; count: number }>
  /** (state, step) counts over failed steps (thrown errors), frequency first, top 10. */
  failedStepHotspots: Array<{ state: string; step: string; count: number }>
}

/** Failures-first, frequency-second hotspot ordering (all hotspot kinds share it). */
function sortHotspots<T extends { count: number; verdict?: string }>(
  entries: T[],
  verdictOf: (entry: T) => string | null,
): T[] {
  return entries.sort((a, b) => {
    const aFail = verdictOf(a) === 'fail' ? 1 : 0
    const bFail = verdictOf(b) === 'fail' ? 1 : 0
    if (aFail !== bFail) return bFail - aFail
    return b.count - a.count
  }).slice(0, 10)
}

/** Nearest-rank percentile over sorted durations (same rule as the e2e). */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}

/** The normalized input both feeds produce (P1-B). */
export interface WorkspaceStatsInput {
  runs: Array<{ status: string; startedAt: string; finishedAt: string | null }>
  stateVerdicts: Array<{ state: string; verdict: string; count: number }>
  steps: Array<{ state: string; step: string; verdict: string | null; attempts: number | null; durationMs: number | null }>
  failedSteps: Array<{ state: string; step: string; attempts: number | null }>
}

/**
 * THE single aggregation kernel. Both feed adapters normalize into
 * `WorkspaceStatsInput`; every piece of stats math (byStatus, run durations,
 * state hotspots, step histogram/percentiles, retries, step and failed-step
 * hotspots) lives here and nowhere else.
 */
export function aggregateWorkspaceStats(input: WorkspaceStatsInput): WorkspaceRunStats {
  const byStatus: Record<string, number> = {}
  let durationSum = 0
  let durationCount = 0
  let lastRunAt: string | null = null
  for (const run of input.runs) {
    byStatus[run.status] = (byStatus[run.status] ?? 0) + 1
    if (lastRunAt === null || run.startedAt > lastRunAt) lastRunAt = run.startedAt
    if (run.finishedAt !== null) {
      const span = Date.parse(run.finishedAt) - Date.parse(run.startedAt)
      if (Number.isFinite(span) && span >= 0) {
        durationSum += span
        durationCount += 1
      }
    }
  }

  // Step duration histogram + percentiles; retry aggregates cover completed
  // AND failed step executions (a retry that ended in failure still retried).
  const bucketCounts: StepDurationBucket[] = STEP_DURATION_BUCKETS.map((bucket) => ({ ...bucket, count: 0 }))
  const durations: number[] = []
  let stepCount = 0
  let stepRetryCount = 0
  let stepRetryTotal = 0
  const countRetries = (attempts: number | null): void => {
    const effective = attempts ?? 1
    if (effective > 1) {
      stepRetryCount += 1
      stepRetryTotal += effective - 1
    }
  }
  for (const step of input.steps) {
    stepCount += 1
    countRetries(step.attempts)
    if (step.durationMs !== null) {
      durations.push(step.durationMs)
      const bucket = bucketCounts.find(
        (candidate) =>
          step.durationMs! >= candidate.minMs && (candidate.maxMs === null || step.durationMs! < candidate.maxMs),
      )
      if (bucket) bucket.count += 1
    }
  }
  for (const failed of input.failedSteps) {
    countRetries(failed.attempts)
  }
  const sortedDurations = [...durations].sort((a, b) => a - b)

  const stepHotspotMap = new Map<string, { state: string; step: string; verdict: string; count: number }>()
  for (const step of input.steps) {
    if (step.verdict === null) continue
    const key = `${step.state}\n${step.step}\n${step.verdict}`
    const entry = stepHotspotMap.get(key) ?? { state: step.state, step: step.step, verdict: step.verdict, count: 0 }
    entry.count += 1
    stepHotspotMap.set(key, entry)
  }
  const failedStepMap = new Map<string, { state: string; step: string; count: number }>()
  for (const failed of input.failedSteps) {
    const key = `${failed.state}\n${failed.step}`
    const entry = failedStepMap.get(key) ?? { state: failed.state, step: failed.step, count: 0 }
    entry.count += 1
    failedStepMap.set(key, entry)
  }

  return {
    totalRuns: input.runs.length,
    byStatus,
    avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : null,
    lastRunAt,
    stateHotspots: sortHotspots([...input.stateVerdicts], (entry) => entry.verdict),
    stepCount,
    stepDurationBuckets: bucketCounts,
    stepDurationPercentiles: {
      p50: percentile(sortedDurations, 50),
      p95: percentile(sortedDurations, 95),
    },
    stepRetryCount,
    stepRetryTotal,
    stepHotspots: sortHotspots([...stepHotspotMap.values()], (entry) => entry.verdict),
    failedStepHotspots: [...failedStepMap.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
  }
}

/**
 * JSON-scan feed: aggregate one batch of per-run projections. Groups each
 * run's states into (state, verdict) counts and flattens steps / failed steps
 * into the kernel's normalized input.
 */
export function aggregateRunStats(rows: RunStatsInput[]): WorkspaceRunStats {
  const runs = rows.map((row) => ({ status: row.status, startedAt: row.startedAt, finishedAt: row.finishedAt }))
  const stateVerdictMap = new Map<string, { state: string; verdict: string; count: number }>()
  for (const row of rows) {
    for (const item of row.states) {
      const key = `${item.state}\n${item.verdict}`
      const entry = stateVerdictMap.get(key) ?? { state: item.state, verdict: item.verdict, count: 0 }
      entry.count += 1
      stateVerdictMap.set(key, entry)
    }
  }
  const steps = rows.flatMap((row) =>
    (row.steps ?? []).map((step) => ({
      state: step.state,
      step: step.step,
      verdict: step.verdict ?? null,
      attempts: step.attempts ?? null,
      durationMs: step.durationMs ?? null,
    })),
  )
  const failedSteps = rows.flatMap((row) =>
    (row.failedSteps ?? []).map((failed) => ({
      state: failed.state,
      step: failed.step,
      attempts: failed.attempts ?? null,
    })),
  )
  return aggregateWorkspaceStats({ runs, stateVerdicts: [...stateVerdictMap.values()], steps, failedSteps })
}

/** Pre-counted projection pieces (as extracted SQL-side by the archive). */
export interface RunStatsProjection {
  byStatus: Array<{ status: string; count: number }>
  /** One row per archived run; status rides along so the kernel can count. */
  runs: Array<{ startedAt: string; finishedAt: string | null; status: string }>
  stateVerdicts: Array<{ state: string; verdict: string; count: number }>
  /** Step rows extracted from state_json (JSON1) with EFFECTIVE durations. */
  steps?: Array<{ state: string; step: string; verdict: string | null; attempts: number | null; durationMs: number | null }>
  /** Raw failed-step rows extracted from state_json (JSON1). */
  failedSteps?: Array<{ state: string; step: string; attempts: number | null }>
}

/** SQLite feed: combine SQL-side projection pieces into the same stats shape. */
export function combineStatsProjection(projection: RunStatsProjection): WorkspaceRunStats {
  return aggregateWorkspaceStats({
    runs: projection.runs,
    stateVerdicts: projection.stateVerdicts,
    steps: projection.steps ?? [],
    failedSteps: projection.failedSteps ?? [],
  })
}
