import { describe, expect, it } from 'vitest'
import { jobOutcomeFor } from '../src/service.js'
import type { RunResult } from '../src/engine/types.js'

const base: RunResult = {
  runId: 'run-1',
  status: 'completed',
  verdict: 'pass',
  stateOutcomes: [
    { state: '方案', verdict: { verdict: 'pass', issues: [], rationale: '' }, steps: [], finishedAt: 'x' },
  ],
  error: null,
}

describe('jobOutcomeFor', () => {
  it('maps completed runs to completed jobs with the verdict detail', () => {
    const outcome = jobOutcomeFor(base)
    expect(outcome.status).toBe('completed')
    expect(outcome.detail).toBe('pass')
    expect(outcome.output).toContain('方案→pass')
  })

  it('maps stopped runs to killed jobs', () => {
    const outcome = jobOutcomeFor({ ...base, status: 'stopped', verdict: undefined, error: '运行被取消' })
    expect(outcome.status).toBe('killed')
    expect(outcome.detail).toBe('运行被取消')
  })

  it('maps failed and crashed runs to failed jobs', () => {
    expect(jobOutcomeFor({ ...base, status: 'failed', verdict: undefined, error: '熔断' }).status).toBe('failed')
    expect(jobOutcomeFor({ ...base, status: 'crashed', verdict: undefined, error: null }).status).toBe('failed')
  })
})
