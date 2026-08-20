import { describe, expect, it } from 'vitest'
import { runJson } from '../src/tools.js'
import type { RunState } from '../src/engine/types.js'

/** Walk a value and collect every path holding a non-JSON-safe value. */
function unsafePaths(value: unknown, path = '$'): string[] {
  if (value === undefined) return [path]
  if (typeof value === 'number' && !Number.isFinite(value)) return [path]
  if (value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => unsafePaths(item, `${path}[${index}]`))
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    unsafePaths(item, `${path}.${key}`),
  )
}

const baseState: RunState = {
  id: 'run-1',
  workflowName: '红蓝评审',
  configFile: 'review.yaml',
  status: 'completed',
  currentState: '完成',
  selfTransitions: {},
  transitionCount: 3,
  totalSteps: 3,
  completedSteps: 3,
  stateOutcomes: [
    {
      state: '方案',
      verdict: { verdict: 'success', issues: [], rationale: '通过' },
      steps: [
        {
          key: '方案/方案设计',
          state: '方案',
          step: '方案设计',
          agent: 'architect',
          role: 'defender',
          outputSummary: '输出',
          verdict: { verdict: 'success', issues: [], rationale: '' },
          startedAt: '2026-01-01T00:00:00Z',
          finishedAt: '2026-01-01T00:01:00Z',
        },
      ],
      finishedAt: '2026-01-01T00:02:00Z',
    },
    {
      state: '失败态',
      verdict: { verdict: 'fail', issues: [], rationale: '' },
      // Deliberately missing supervisorNote/supervisorScore and a script
      // step without agent/role/verdict — the undefined-prone shape.
      steps: [
        {
          key: '失败态/记录',
          state: '失败态',
          step: '记录',
          role: 'neutral',
          outputSummary: '脚本输出',
          startedAt: '2026-01-01T00:03:00Z',
          finishedAt: '2026-01-01T00:03:01Z',
        },
      ],
      finishedAt: '2026-01-01T00:04:00Z',
    },
  ],
  pendingState: null,
  pendingHuman: null,
  startedAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:04:00Z',
  finishedAt: '2026-01-01T00:04:00Z',
  error: null,
  inputs: { requirements: 'x' },
  context: { requirements: 'x' },
  parentSessionId: 'session-1',
}

describe('runJson', () => {
  it('projects runs with no undefined or non-finite values', () => {
    const json = runJson(baseState)
    expect(unsafePaths(json)).toEqual([])
  })

  it('null-coalesces optional fields', () => {
    const json = runJson(baseState) as { states: { supervisorNote: unknown; supervisorScore: unknown; steps: { agent: unknown; role: unknown; verdict: unknown }[] }[] }
    expect(json.states[0]!.supervisorNote).toBeNull()
    expect(json.states[1]!.steps[0]!.agent).toBeNull()
    expect(json.states[1]!.steps[0]!.verdict).toBeNull()
  })

  it('survives a JSON round trip unchanged', () => {
    const json = runJson(baseState)
    expect(JSON.parse(JSON.stringify(json))).toEqual(json)
  })
})
