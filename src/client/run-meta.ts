/**
 * Client run metadata: the single source for the status/verdict/step-kind
 * vocabularies and the routes shared by more than one component. Extracted
 * from the four panels (P2-4) so the labels cannot drift apart again; pure
 * presentation data, no wire-shape involvement.
 */

import { verdictEquals } from '../dsl/verdict.js'
import type { Verdict } from '../dsl/types.js'

/** Statuses that count as "still running" for live badges and diagrams. */
export const ACTIVE_STATUSES = new Set(['preparing', 'running', 'waiting-human'])

/** Human-facing text of a run status. */
export const STATUS_TEXT: Record<string, string> = {
  preparing: '准备中',
  running: '运行中',
  'waiting-human': '等待人工决策',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
  crashed: '崩溃',
}

/** Human-facing text of a step kind. */
export const STEP_TYPE_TEXT: Record<string, string> = {
  agent: 'AI',
  script: '脚本',
  subworkflow: '子工作流',
  llm: '快速LLM',
}

/** Human-facing text of a verdict. */
export const VERDICT_TEXT: Record<string, string> = {
  success: '成功',
  pass: '成功',
  fail: '失败',
  conditional_pass: '有条件通过',
}

/**
 * Client-facing plugin routes shared by more than one component. Single-use
 * action routes (stop / test-step / …) stay inline at their call site.
 */
export function route(name: 'state'): string
export function route(name: 'stream', runId: string): string
export function route(name: 'state' | 'stream', runId?: string): string {
  const path = `/plugins/dsh-ace-harness/${name}`
  return name === 'stream' ? `${path}?runId=${encodeURIComponent(runId ?? '')}` : path
}

/**
 * Fold legacy verdict spellings onto the modern success/fail pair. Reuses the
 * DSL alias semantics (`verdictEquals`): only `pass` folds, everything else —
 * including unknown spellings — passes through untouched.
 */
export function foldVerdict(verdict: string | null): string | null {
  if (verdict === null) return null
  return verdictEquals(verdict as Verdict, 'success') ? 'success' : verdict
}
