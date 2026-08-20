import { describe, expect, it } from 'vitest'
import { aggregateRunStats, combineStatsProjection, type RunStatsInput } from '../src/store/run-stats.ts'

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
})

describe('combineStatsProjection', () => {
  it('matches aggregateRunStats on equivalent data', () => {
    const combined = combineStatsProjection({
      byStatus: [
        { status: 'completed', count: 2 },
        { status: 'failed', count: 1 },
      ],
      runs: ROWS.map((row) => ({ startedAt: row.startedAt, finishedAt: row.finishedAt })),
      stateVerdicts: [
        { state: '诊断', verdict: 'success', count: 2 },
        { state: '实施', verdict: 'fail', count: 2 },
        { state: '实施', verdict: 'success', count: 1 },
      ],
    })
    const aggregated = aggregateRunStats(ROWS)
    expect(combined).toEqual(aggregated)
  })

  it('caps hotspots at 10 entries', () => {
    const stateVerdicts = Array.from({ length: 25 }, (_, i) => ({ state: `S${i}`, verdict: 'fail', count: i + 1 }))
    const stats = combineStatsProjection({ byStatus: [], runs: [], stateVerdicts })
    expect(stats.stateHotspots).toHaveLength(10)
    expect(stats.stateHotspots[0]?.count).toBe(25)
  })
})
