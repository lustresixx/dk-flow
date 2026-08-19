/**
 * Verdict extraction from step output.
 *
 * Ports ACEHarness `extractVerdictJson` / `parseVerdictFromConclusion` /
 * `normalizeWorkflowVerdict` semantics: a step's final text may end with a
 * fenced JSON block, a `<workflow-verdict>{…}</workflow-verdict>` tag, a
 * `<step-conclusion>` tag, or a bare JSON object carrying `verdict`.
 * @module dsh-ace-harness/dsl
 */
import { issueSchema } from './schema.js'
import type { Issue, StepVerdict, Verdict } from './types.js'

const VERDICTS: readonly Verdict[] = ['pass', 'conditional_pass', 'fail']

/** Extract the first balanced `{…}` JSON object from a span of text. */
function extractBalancedJson(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

function stripCodeFence(content: string): string {
  return content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
}

function parseJsonSpan(span: string): unknown | undefined {
  try {
    return JSON.parse(stripCodeFence(span.trim()))
  } catch {
    return undefined
  }
}

/** Normalize one candidate parsed value into a StepVerdict, or undefined. */
export function normalizeVerdict(value: unknown, fallbackRationale = ''): StepVerdict | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const rawVerdict = typeof record.verdict === 'string' ? record.verdict.toLowerCase() : ''
  if (!(VERDICTS as readonly string[]).includes(rawVerdict)) return undefined
  const issues: Issue[] = []
  if (Array.isArray(record.issues)) {
    for (const item of record.issues) {
      const parsed = issueSchema.safeParse(item)
      if (parsed.success) issues.push(parsed.data)
    }
  }
  const rationale =
    typeof record.rationale === 'string' && record.rationale.trim() !== ''
      ? record.rationale
      : typeof record.summary === 'string' && record.summary.trim() !== ''
        ? record.summary
        : fallbackRationale
  return { verdict: rawVerdict as Verdict, issues, rationale }
}

/**
 * Extract a verdict from a step's final output text.
 * @param output - the complete final assistant text of the step.
 * @returns the verdict, or `undefined` when the output declares none.
 */
export function extractVerdict(output: string): StepVerdict | undefined {
  const text = output.trim()
  if (text === '') return undefined

  // Tagged verdict: <workflow-verdict>{...}</workflow-verdict>
  const verdictTag = /<workflow-verdict>([\s\S]*?)<\/workflow-verdict>/i.exec(text)
  if (verdictTag?.[1]) {
    const parsed = parseJsonSpan(verdictTag[1])
    const verdict = normalizeVerdict(parsed)
    if (verdict) return verdict
  }

  // Step conclusion tag: <step-conclusion>...</step-conclusion>
  const conclusionTag = /<step-conclusion>([\s\S]*?)<\/step-conclusion>/i.exec(text)
  if (conclusionTag?.[1]) {
    const conclusion = conclusionTag[1]!.trim()
    const parsed = parseJsonSpan(conclusion)
    const verdict = normalizeVerdict(parsed, conclusion)
    if (verdict) return verdict
  }

  // Fenced JSON block anywhere in the output.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi.exec(text)
  if (fenced?.[1]) {
    const verdict = normalizeVerdict(parseJsonSpan(fenced[1]))
    if (verdict) return verdict
  }

  // Bare JSON object carrying a verdict.
  const verdictJson = extractBalancedJson(text)
  if (verdictJson) {
    const verdict = normalizeVerdict(parseJsonSpan(verdictJson))
    if (verdict) return verdict
  }

  return undefined
}

/**
 * Aggregate several step verdicts the way ACE joins parallel segments:
 * fail outranks conditional_pass, which outranks pass.
 */
export function aggregateVerdicts(verdicts: readonly StepVerdict[]): StepVerdict | undefined {
  if (verdicts.length === 0) return undefined
  const rank = { fail: 0, conditional_pass: 1, pass: 2 } as const
  let worst = verdicts[0]!
  for (const verdict of verdicts.slice(1)) {
    if (rank[verdict.verdict] < rank[worst.verdict]) worst = verdict
  }
  const issues = verdicts.flatMap((verdict) => verdict.issues)
  return { ...worst, issues }
}
