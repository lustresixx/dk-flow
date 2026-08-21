import { describe, expect, it } from 'vitest'
import {
  aggregateRunStats,
  combineStatsProjection,
  STEP_DURATION_BUCKETS,
  type RunStatsInput,
  type RunStatsProjection,
} from '../src/store/run-stats.ts'

const ROWS: RunStatsInput[] = [
  {
    status: 'completed',
    startedAt: '2026-08-20T10:00:00.000Z',
    finishedAt: '2026-08-20T10:01:00.000Z',
    states: [
      { state: '诊断', verdict: 'success' },
      { state: '实施', verdict: 'fail' },
    ],
  },
  {
    status: 'completed',
    startedAt: '2026-08-20T11:00:00.000Z',
    finishedAt: '2026-08-20T11:03:00.000Z',
    states: [
      { state: '诊断', verdict: 'success' },
      { state: '实施', verdict: 'success' },
    ],
  },
  {
    status: 'failed',
    startedAt: '2026-08-20T12:00:00.000Z',
    finishedAt: null,
    states: [{ state: '实施', verdict: 'fail' }],
  },
]

/** Step-rich rows: durations, retries, verdicts, and a failure history. */
const STEP_ROWS: RunStatsInput[] = [
  {
    status: 'completed',
    startedAt: '2026-08-20T10:00:00.000Z',
    finishedAt: '2026-08-20T10:05:00.000Z',
    states: [
      { state: '方案', verdict: 'fail' },
      { state: '实施', verdict: 'success' },
    ],
    steps: [
      { state: '方案', step: '挑战', verdict: 'fail', attempts: 3, durationMs: 500 },
      { state: '实施', step: '编码', verdict: 'success', attempts: 1, durationMs: 3000 },
    ],
    failedSteps: [{ state: '方案', step: '挑战', attempts: 3 }],
  },
  {
    status: 'failed',
    startedAt: '2026-08-20T11:00:00.000Z',
    finishedAt: null,
    states: [{ state: '实施', verdict: 'fail' }],
    steps: [{ state: '实施', step: '编码', verdict: 'success', attempts: 1, durationMs: 15_000 }],
    failedSteps: [{ state: '实施', step: '验证', attempts: 2 }],
  },
]

describe('aggregateRunStats', () => {
  it('counts by status, averages durations, tracks the latest run', () => {
    const stats = aggregateRunStats(ROWS)
    expect(stats.totalRuns).toBe(3)
    expect(stats.byStatus).toEqual({ completed: 2, failed: 1 })
    expect(stats.avgDurationMs).toBe(120_000) // (60s + 180s) / 2, null-finished skipped
    expect(stats.lastRunAt).toBe('2026-08-20T12:00:00.000Z')
  })

  it('surfaces failure hotspots first', () => {
    const stats = aggregateRunStats(ROWS)
    expect(stats.stateHotspots[0]).toEqual({ state: '实施', verdict: 'fail', count: 2 })
    expect(stats.stateHotspots.map((h) => `${h.state}:${h.verdict}:${h.count}`)).toContain('诊断:success:2')
  })

  it('aggregates step durations into the fixed histogram with p50/p95', () => {
    const stats = aggregateRunStats(STEP_ROWS)
    expect(stats.stepCount).toBe(3)
    const byLabel = Object.fromEntries(stats.stepDurationBuckets.map((bucket) => [bucket.label, bucket.count]))
    expect(byLabel).toEqual({ '<1s': 1, '1-5s': 1, '5-30s': 1, '30-120s': 0, '>120s': 0 })
    // durations [500, 3000, 15000] — nearest-rank percentiles.
    expect(stats.stepDurationPercentiles).toEqual({ p50: 3000, p95: 15_000 })
  })

  it('assigns durations to buckets at the exact boundaries', () => {
    const stats = aggregateRunStats([
      {
        status: 'completed',
        startedAt: '2026-08-20T10:00:00.000Z',
        finishedAt: null,
        states: [],
        steps: [
          { state: 'S', step: 'a', verdict: 'success', attempts: 1, durationMs: 0 },
          { state: 'S', step: 'b', verdict: 'success', attempts: 1, durationMs: 999 },
          { state: 'S', step: 'c', verdict: 'success', attempts: 1, durationMs: 1000 },
          { state: 'S', step: 'd', verdict: 'success', attempts: 1, durationMs: 5000 },
          { state: 'S', step: 'e', verdict: 'success', attempts: 1, durationMs: 30_000 },
          { state: 'S', step: 'f', verdict: 'success', attempts: 1, durationMs: 120_000 },
          { state: 'S', step: 'g', verdict: 'success', attempts: 1, durationMs: 120_001 },
        ],
      },
    ])
    expect(stats.stepDurationBuckets.map((bucket) => `${bucket.label}:${bucket.count}`)).toEqual([
      '<1s:2',
      '1-5s:1',
      '5-30s:1',
      '30-120s:1',
      '>120s:2',
    ])
  })

  it('excludes missing durations from the histogram but counts the step', () => {
    const stats = aggregateRunStats([
      {
        status: 'completed',
        startedAt: '2026-08-20T10:00:00.000Z',
        finishedAt: null,
        states: [],
        steps: [
          { state: 'S', step: 'a', verdict: 'success', attempts: 1, durationMs: null },
          { state: 'S', step: 'b', verdict: 'success', attempts: 1, durationMs: 2500 },
        ],
      },
    ])
    expect(stats.stepCount).toBe(2)
    expect(stats.stepDurationBuckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(1)
    expect(stats.stepDurationPercentiles).toEqual({ p50: 2500, p95: 2500 })
  })

  it('aggregates retries across completed and failed steps (含重试次数)', () => {
    const stats = aggregateRunStats(STEP_ROWS)
    // completed attempts [3, 1, 1] + failed attempts [3, 2] → 3 steps retried,
    // retries = (3-1) + (3-1) + (2-1) = 5.
    expect(stats.stepRetryCount).toBe(3)
    expect(stats.stepRetryTotal).toBe(5)
  })

  it('surfaces step hotspots failures-first and failed-step hotspots', () => {
    const stats = aggregateRunStats(STEP_ROWS)
    expect(stats.stepHotspots[0]).toEqual({ state: '方案', step: '挑战', verdict: 'fail', count: 1 })
    expect(stats.stepHotspots[1]).toEqual({ state: '实施', step: '编码', verdict: 'success', count: 2 })
    expect(stats.failedStepHotspots).toEqual([
      { state: '方案', step: '挑战', count: 1 },
      { state: '实施', step: '验证', count: 1 },
    ])
  })
})

describe('combineStatsProjection', () => {
  it('matches aggregateRunStats on equivalent data', () => {
    const combined = combineStatsProjection({
      byStatus: [
        { status: 'completed', count: 2 },
        { status: 'failed', count: 1 },
      ],
      runs: ROWS.map((row) => ({ startedAt: row.startedAt, finishedAt: row.finishedAt, status: row.status })),
      stateVerdicts: [
        { state: '诊断', verdict: 'success', count: 2 },
        { state: '实施', verdict: 'fail', count: 2 },
        { state: '实施', verdict: 'success', count: 1 },
      ],
    })
    const aggregated = aggregateRunStats(ROWS)
    expect(combined).toEqual(aggregated)
  })

  it('matches the JSON feed on step-level data (P1-B single kernel)', () => {
    const projection: RunStatsProjection = {
      byStatus: [
        { status: 'completed', count: 1 },
        { status: 'failed', count: 1 },
      ],
      runs: STEP_ROWS.map((row) => ({ startedAt: row.startedAt, finishedAt: row.finishedAt, status: row.status })),
      stateVerdicts: [
        { state: '方案', verdict: 'fail', count: 1 },
        { state: '实施', verdict: 'success', count: 1 },
        { state: '实施', verdict: 'fail', count: 1 },
      ],
      steps: STEP_ROWS.flatMap((row) =>
        (row.steps ?? []).map((step) => ({
          state: step.state,
          step: step.step,
          verdict: step.verdict ?? null,
          attempts: step.attempts ?? null,
          durationMs: step.durationMs ?? null,
        })),
      ),
      failedSteps: STEP_ROWS.flatMap((row) =>
        (row.failedSteps ?? []).map((failed) => ({
          state: failed.state,
          step: failed.step,
          attempts: failed.attempts ?? null,
        })),
      ),
    }
    expect(combineStatsProjection(projection)).toEqual(aggregateRunStats(STEP_ROWS))
  })

  it('caps hotspots at 10 entries', () => {
    const stateVerdicts = Array.from({ length: 25 }, (_, i) => ({ state: `S${i}`, verdict: 'fail', count: i + 1 }))
    const stats = combineStatsProjection({ byStatus: [], runs: [], stateVerdicts })
    expect(stats.stateHotspots).toHaveLength(10)
    expect(stats.stateHotspots[0]?.count).toBe(25)
  })

  it('caps step and failed-step hotspots at 10 entries', () => {
    const steps = Array.from({ length: 25 }, (_, i) => ({
      state: `S${i}`,
      step: 'x',
      verdict: 'fail',
      attempts: 1,
      durationMs: 100 + i,
    }))
    const failedSteps = Array.from({ length: 25 }, (_, i) => ({ state: `S${i}`, step: 'x', attempts: 1 }))
    const stats = combineStatsProjection({ byStatus: [], runs: [], stateVerdicts: [], steps, failedSteps })
    expect(stats.stepHotspots).toHaveLength(10)
    expect(stats.failedStepHotspots).toHaveLength(10)
    expect(stats.stepHotspots[0]?.count).toBe(25)
    expect(stats.failedStepHotspots[0]?.count).toBe(25)
  })
})

describe('STEP_DURATION_BUCKETS', () => {
  it('covers the full non-negative duration range contiguously', () => {
    for (let index = 0; index < STEP_DURATION_BUCKETS.length; index += 1) {
      const bucket = STEP_DURATION_BUCKETS[index]!
      const next = STEP_DURATION_BUCKETS[index + 1]
      expect(bucket.minMs).toBeGreaterThanOrEqual(0)
      if (bucket.maxMs !== null && next) expect(bucket.maxMs).toBe(next.minMs)
      if (index === STEP_DURATION_BUCKETS.length - 1) expect(bucket.maxMs).toBeNull()
    }
  })
})
