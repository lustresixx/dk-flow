import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowConfig } from '../src/dsl/types.ts'
import { RunRegistry } from '../src/run-registry.js'

const config: WorkflowConfig = {
  workflow: {
    name: '演示',
    mode: 'state-machine',
    states: [
      {
        name: '开始',
        steps: [],
        transitions: [{ to: '完成', condition: { verdict: 'success' }, priority: 10, label: '通过' }],
        isInitial: true,
        isFinal: false,
        position: { x: 1, y: 2 },
      },
      { name: '完成', steps: [], transitions: [], isInitial: false, isFinal: true },
    ],
  },
}

describe('RunRegistry controllers', () => {
  it('tracks active runs and honors the concurrency cap', () => {
    const registry = new RunRegistry()
    expect(registry.isFull(1)).toBe(false)
    const controller = new AbortController()
    registry.register('run-1', controller)
    expect(registry.isActive('run-1')).toBe(true)
    expect(registry.isFull(1)).toBe(true)
    registry.release('run-1')
    expect(registry.isActive('run-1')).toBe(false)
    expect(registry.isFull(1)).toBe(false)
  })

  it('stop aborts the registered controller and reports unknown ids', () => {
    const registry = new RunRegistry()
    const controller = new AbortController()
    registry.register('run-1', controller)
    expect(registry.stop('run-x')).toBe(false)
    expect(registry.stop('run-1')).toBe(true)
    expect(controller.signal.aborted).toBe(true)
  })

  it('finishRun drops the audit diff cursor', () => {
    const registry = new RunRegistry()
    registry.progressTrack.set('run-1', { states: 2, waiting: false })
    registry.finishRun('run-1')
    expect(registry.progressTrack.has('run-1')).toBe(false)
  })

  it('counts active and streaming runs for the health probe', () => {
    const registry = new RunRegistry()
    registry.register('run-1', new AbortController())
    registry.openStream({ runId: 'run-1', workflowName: '演示', config, totalSteps: 2 })
    expect(registry.counts()).toEqual({ activeRuns: 1, streamingRuns: 1 })
  })
})

describe('RunRegistry streams', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('openStream seeds the projection with the full topology', () => {
    const registry = new RunRegistry()
    registry.openStream({ runId: 'run-1', workflowName: '演示', config, totalSteps: 2 })
    const stream = registry.streams.get('run-1')!
    expect(stream.status).toBe('preparing')
    expect(stream.states).toEqual([
      { name: '开始', isInitial: true, isFinal: false, position: { x: 1, y: 2 } },
      { name: '完成', isInitial: false, isFinal: true, position: null },
    ])
    expect(stream.transitions).toEqual([{ from: '开始', to: '完成', verdict: 'success', label: '通过' }])
    expect(stream.stepLog).toEqual([])
    expect(stream.stepLogIndex).toBe(-1)
  })

  it('snapshot projects only the public fields', () => {
    const registry = new RunRegistry()
    const stream = registry.openStream({ runId: 'run-1', workflowName: '演示', config, totalSteps: 2 })
    stream.text = '进行中'
    const snapshot = registry.snapshot('run-1')!
    expect(snapshot.text).toBe('进行中')
    expect(snapshot).not.toHaveProperty('childSessionId')
    expect(snapshot).not.toHaveProperty('foldIndex')
    expect(snapshot).not.toHaveProperty('stepLogIndex')
    expect(snapshot).not.toHaveProperty('pruneTimer')
    expect(registry.snapshot('run-x')).toBeUndefined()
  })

  it('settleStream marks the terminal status and prunes after the linger window', () => {
    const registry = new RunRegistry()
    const stream = registry.openStream({ runId: 'run-1', workflowName: '演示', config, totalSteps: 2 })
    stream.currentStep = '步骤A'
    stream.agent = 'architect'
    const seqBefore = stream.seq
    registry.settleStream('run-1', 'completed')
    expect(stream.status).toBe('completed')
    expect(stream.currentStep).toBeNull()
    expect(stream.agent).toBeNull()
    expect(stream.seq).toBe(seqBefore + 1)
    expect(registry.streams.has('run-1')).toBe(true)
    vi.advanceTimersByTime(10 * 60_000 + 1)
    expect(registry.streams.has('run-1')).toBe(false)
  })
})
