import { describe, expect, it } from 'vitest'
import type { StateMachineState, StepVerdict, StateTransition } from '../src/dsl/types.js'
import {
  assertSelfTransitionBudget,
  assertTransitionBudget,
  evaluateTransitions,
  joinSegment,
  matchCondition,
  segmentSteps,
} from '../src/engine/transitions.js'
import { EngineError } from '../src/engine/types.js'

const verdict = (v: StepVerdict['verdict'], issues: StepVerdict['issues'] = [], rationale = ''): StepVerdict => ({
  verdict: v,
  issues,
  rationale,
})

describe('matchCondition', () => {
  it('matches an empty condition unconditionally', () => {
    expect(matchCondition({}, verdict('pass'))).toBe(true)
    expect(matchCondition({}, verdict('fail'))).toBe(true)
  })

  it('matches by verdict', () => {
    expect(matchCondition({ verdict: 'fail' }, verdict('fail'))).toBe(true)
    expect(matchCondition({ verdict: 'fail' }, verdict('pass'))).toBe(false)
  })

  it('aliases the binary success verdict with the legacy pass', () => {
    expect(matchCondition({ verdict: 'success' }, verdict('success'))).toBe(true)
    expect(matchCondition({ verdict: 'success' }, verdict('pass'))).toBe(true)
    expect(matchCondition({ verdict: 'pass' }, verdict('success'))).toBe(true)
    expect(matchCondition({ verdict: 'success' }, verdict('fail'))).toBe(false)
  })

  it('matches issue types, severities, and counts', () => {
    const v = verdict('conditional_pass', [
      { type: 'security', severity: 'critical', description: 'x' },
      { type: 'test', severity: 'minor', description: 'y' },
    ])
    expect(matchCondition({ issueTypes: ['security'] }, v)).toBe(true)
    expect(matchCondition({ issueTypes: ['design'] }, v)).toBe(false)
    expect(matchCondition({ severities: ['critical'] }, v)).toBe(true)
    expect(matchCondition({ minIssueCount: 2 }, v)).toBe(true)
    expect(matchCondition({ maxIssueCount: 1 }, v)).toBe(false)
  })

  it('evaluates the custom verdict== expression', () => {
    expect(matchCondition({ custom: "verdict == 'pass'" }, verdict('pass'))).toBe(true)
    expect(matchCondition({ custom: "verdict == 'pass'" }, verdict('fail'))).toBe(false)
    expect(matchCondition({ custom: 'unknown syntax' }, verdict('pass'))).toBe(false)
  })
})

describe('evaluateTransitions', () => {
  const state = (transitions: StateTransition[]): StateMachineState => ({
    name: 's',
    steps: [{ name: 'step', agent: 'a', task: 't' }],
    transitions,
    isInitial: true,
    isFinal: false,
  })

  it('picks the first match by ascending priority', () => {
    const transitions = [
      { to: 'b', condition: { verdict: 'pass' }, priority: 20 },
      { to: 'c', condition: { verdict: 'pass' }, priority: 10 },
    ]
    expect(evaluateTransitions(state(transitions), verdict('pass'))?.to).toBe('c')
  })

  it('skips non-matching edges', () => {
    const transitions = [
      { to: 'b', condition: { verdict: 'fail' }, priority: 10 },
      { to: 'c', condition: { verdict: 'pass' }, priority: 20 },
    ]
    expect(evaluateTransitions(state(transitions), verdict('pass'))?.to).toBe('c')
  })

  it('falls back to a self-transition on conditional_pass with no match', () => {
    const transitions = [{ to: 'b', condition: { verdict: 'pass' }, priority: 10 }]
    const chosen = evaluateTransitions(state(transitions), verdict('conditional_pass'))
    expect(chosen?.to).toBe('s')
  })

  it('returns undefined when nothing matches a fail verdict', () => {
    const transitions = [{ to: 'b', condition: { verdict: 'pass' }, priority: 10 }]
    expect(evaluateTransitions(state(transitions), verdict('fail'))).toBeUndefined()
  })
})

describe('joinSegment', () => {
  it('aggregates worst-wins by default', () => {
    expect(joinSegment([verdict('pass'), verdict('fail')], undefined)?.verdict).toBe('fail')
    expect(joinSegment([verdict('pass'), verdict('conditional_pass')], undefined)?.verdict).toBe('conditional_pass')
  })

  it('any passes when any step passes', () => {
    expect(joinSegment([verdict('fail'), verdict('pass')], { mode: 'any' })?.verdict).toBe('pass')
    // Without a pass, worst-wins aggregation still applies.
    expect(joinSegment([verdict('fail'), verdict('conditional_pass')], { mode: 'any' })?.verdict).toBe('fail')
  })

  it('quorum passes at the quorum count', () => {
    expect(joinSegment([verdict('pass'), verdict('pass'), verdict('fail')], { mode: 'quorum', quorum: 2 })?.verdict).toBe('success')
    expect(joinSegment([verdict('pass'), verdict('fail'), verdict('fail')], { mode: 'quorum', quorum: 2 })?.verdict).toBe('fail')
  })
})

describe('segmentSteps', () => {
  it('groups steps sharing a parallelGroup, leaving others sequential', () => {
    const segments = segmentSteps([
      { name: 'a' },
      { name: 'b', parallelGroup: 'g' },
      { name: 'c' },
      { name: 'd', parallelGroup: 'g' },
      { name: 'e' },
    ])
    expect(segments).toEqual([
      { steps: ['a'], policy: undefined },
      { steps: ['b', 'd'], policy: undefined },
      { steps: ['c'], policy: undefined },
      { steps: ['e'], policy: undefined },
    ])
  })
})

describe('fuses', () => {
  it('rejects transition counts at the budget', () => {
    expect(() => assertTransitionBudget(29, 30)).not.toThrow()
    expect(() => assertTransitionBudget(30, 30)).toThrow(EngineError)
  })

  it('rejects self-transition counts at the budget', () => {
    const state: StateMachineState = {
      name: 's',
      steps: [{ name: 'step', agent: 'a', task: 't' }],
      transitions: [],
      isInitial: true,
      isFinal: false,
      maxSelfTransitions: 2,
    }
    expect(() => assertSelfTransitionBudget(state, 1)).not.toThrow()
    expect(() => assertSelfTransitionBudget(state, 2)).toThrow(EngineError)
  })
})
