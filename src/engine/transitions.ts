/**
 * Transition evaluation: condition matching, priority ordering, self-transition
 * counting, and parallel-segment verdict aggregation. Ports ACEHarness
 * `evaluateTransitions` / `matchCondition` semantics.
 * @module dsh-ace-harness/engine
 */
import type {
  Issue,
  StepVerdict,
  StateMachineState,
  StateTransition,
  Verdict,
} from '../dsl/types.js'
import { aggregateVerdicts, verdictEquals } from '../dsl/verdict.js'
import { EngineError } from './types.js'

const RANK: Record<Verdict, number> = { fail: 0, conditional_pass: 1, success: 2, pass: 2 }

/**
 * Whether one transition condition matches a state outcome.
 * An empty condition matches any outcome (unconditional edge).
 * `success` and the legacy `pass` are aliases of the same outcome.
 */
export function matchCondition(
  condition: StateTransition['condition'],
  verdict: StepVerdict,
): boolean {
  if (condition.verdict && !verdictEquals(condition.verdict, verdict.verdict)) return false
  const issues = verdict.issues
  if (condition.issueTypes && condition.issueTypes.length > 0) {
    const present = new Set(issues.map((issue) => issue.type))
    if (!condition.issueTypes.some((type) => present.has(type))) return false
  }
  if (condition.severities && condition.severities.length > 0) {
    const present = new Set(issues.map((issue) => issue.severity))
    if (!condition.severities.some((severity) => present.has(severity))) return false
  }
  if (condition.minIssueCount !== undefined && issues.length < condition.minIssueCount) return false
  if (condition.maxIssueCount !== undefined && issues.length > condition.maxIssueCount) return false
  if (condition.custom) return matchCustomCondition(condition.custom, verdict)
  return true
}

/**
 * Minimal custom-condition vocabulary: `verdict == 'pass'` style equality,
 * optionally ANDed with `;`. Unsupported syntax never matches.
 */
function matchCustomCondition(expression: string, verdict: StepVerdict): boolean {
  const clauses = expression.split(';').map((clause) => clause.trim()).filter((clause) => clause !== '')
  if (clauses.length === 0) return false
  return clauses.every((clause) => {
    const match = /^verdict\s*==\s*['"](pass|conditional_pass|fail)['"]$/.exec(clause)
    return match?.[1] === verdict.verdict
  })
}

/**
 * Pick the transition for a state outcome: by ascending priority, first match
 * wins. `conditional_pass` with no matching edge falls back to a
 * self-transition, mirroring ACE behavior.
 * @returns the chosen transition, or `undefined` when nothing matches.
 */
export function evaluateTransitions(
  state: StateMachineState,
  verdict: StepVerdict,
): StateTransition | undefined {
  const transitions = [...state.transitions].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
  for (const transition of transitions) {
    if (matchCondition(transition.condition, verdict)) return transition
  }
  if (verdict.verdict === 'conditional_pass') {
    return { to: state.name, condition: { verdict: 'conditional_pass' }, priority: 0 }
  }
  return undefined
}

/** Whether a transition stays in the same state. */
export function isSelfTransition(transition: StateTransition, state: StateMachineState): boolean {
  return transition.to === state.name
}

/**
 * Aggregate the verdicts of a parallel segment under a join policy.
 * `all` (default) aggregates all step verdicts, worst wins; `any` passes when
 * any step passes; `quorum` passes when at least `quorum` steps pass.
 */
export function joinSegment(
  verdicts: StepVerdict[],
  policy: { mode: 'all' | 'any' | 'quorum' | 'manual'; quorum?: number } | undefined,
): StepVerdict | undefined {
  if (verdicts.length === 0) return undefined
  const mode = policy?.mode ?? 'all'
  const passed = (verdict: StepVerdict): boolean => verdict.verdict === 'pass' || verdict.verdict === 'success'
  if (mode === 'any') {
    const winning = verdicts.find(passed)
    if (winning) return { ...winning, issues: verdicts.flatMap((verdict) => verdict.issues) }
    return aggregateVerdicts(verdicts)
  }
  if (mode === 'quorum') {
    const quorum = policy?.quorum ?? 1
    const winners = verdicts.filter(passed)
    if (winners.length >= quorum) {
      return {
        verdict: 'success',
        issues: verdicts.flatMap((verdict) => verdict.issues),
        rationale: `quorum 达成：${winners.length}/${verdicts.length} 个步骤成功`,
      }
    }
    return aggregateVerdicts(verdicts)
  }
  if (mode === 'manual') {
    // Manual join cannot be decided by the engine alone; degrade to worst-wins
    // so the state always has a verdict, while every step result stays visible.
    return aggregateVerdicts(verdicts)
  }
  return aggregateVerdicts(verdicts)
}

/** Split a state's steps into sequential segments around parallelGroup. */
export function segmentSteps(
  steps: readonly { name: string; parallelGroup?: string }[],
): { steps: string[]; policy: { mode: 'all' | 'any' | 'quorum' | 'manual'; quorum?: number } | undefined }[] {
  const segments: { steps: string[]; policy: { mode: 'all' | 'any' | 'quorum' | 'manual'; quorum?: number } | undefined }[] = []
  const groupSegments = new Map<string, number>()
  for (const step of steps) {
    const group = step.parallelGroup
    if (group) {
      const existing = groupSegments.get(group)
      if (existing !== undefined) {
        segments[existing]!.steps.push(step.name)
      } else {
        groupSegments.set(group, segments.length)
        segments.push({ steps: [step.name], policy: undefined })
      }
    } else {
      segments.push({ steps: [step.name], policy: undefined })
    }
  }
  return segments
}

/** Derive the verdict ranking helper used across the engine. */
export function verdictRank(verdict: Verdict): number {
  return RANK[verdict]
}

/** Flatten issues of several verdicts, deduplicated by content. */
export function mergeIssues(verdicts: readonly StepVerdict[]): Issue[] {
  const seen = new Set<string>()
  const issues: Issue[] = []
  for (const verdict of verdicts) {
    for (const issue of verdict.issues) {
      const key = `${issue.type}|${issue.severity}|${issue.description}`
      if (!seen.has(key)) {
        seen.add(key)
        issues.push(issue)
      }
    }
  }
  return issues
}

/**
 * Guard the run-level transition fuse.
 * @throws {EngineError} MAX_TRANSITIONS when exceeded.
 */
export function assertTransitionBudget(transitionCount: number, maxTransitions: number): void {
  if (transitionCount >= maxTransitions) {
    throw new EngineError(
      `状态转移次数达到上限 ${maxTransitions}，运行熔断`,
      'MAX_TRANSITIONS',
    )
  }
}

/**
 * Guard the per-state self-transition fuse.
 * @throws {EngineError} MAX_SELF_TRANSITIONS when exceeded.
 */
export function assertSelfTransitionBudget(
  state: StateMachineState,
  selfTransitions: number,
): void {
  const max = state.maxSelfTransitions ?? 3
  if (selfTransitions >= max) {
    throw new EngineError(
      `状态「${state.name}」自我转移次数达到上限 ${max}，运行熔断`,
      'MAX_SELF_TRANSITIONS',
    )
  }
}
