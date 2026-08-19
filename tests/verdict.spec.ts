import { describe, expect, it } from 'vitest'
import { aggregateVerdicts, extractVerdict, normalizeVerdict } from '../src/dsl/verdict.js'

describe('normalizeVerdict', () => {
  it('accepts pass with issues and rationale', () => {
    const verdict = normalizeVerdict({
      verdict: 'PASS',
      issues: [{ type: 'implementation', severity: 'major', description: 'x' }],
      rationale: 'r',
    })
    expect(verdict).toEqual({
      verdict: 'pass',
      issues: [{ type: 'implementation', severity: 'major', description: 'x' }],
      rationale: 'r',
    })
  })

  it('drops malformed issues but keeps the verdict', () => {
    const verdict = normalizeVerdict({
      verdict: 'conditional_pass',
      issues: [{ type: 'nope', severity: 'huge', description: 'bad' }],
    })
    expect(verdict?.verdict).toBe('conditional_pass')
    expect(verdict?.issues).toEqual([])
  })

  it('uses summary as fallback rationale', () => {
    const verdict = normalizeVerdict({ verdict: 'fail', summary: '原因' })
    expect(verdict?.rationale).toBe('原因')
  })

  it('rejects unknown verdict values', () => {
    expect(normalizeVerdict({ verdict: 'maybe' })).toBeUndefined()
    expect(normalizeVerdict('pass')).toBeUndefined()
    expect(normalizeVerdict(null)).toBeUndefined()
  })
})

describe('extractVerdict', () => {
  it('extracts from a workflow-verdict tag', () => {
    const output = '分析完毕。\n<workflow-verdict>{"verdict":"pass","issues":[],"rationale":"通过"}</workflow-verdict>'
    expect(extractVerdict(output)?.verdict).toBe('pass')
  })

  it('extracts from a fenced json block', () => {
    const output = '结论如下：\n```json\n{"verdict":"conditional_pass","issues":[],"rationale":"需补充"}\n```'
    expect(extractVerdict(output)?.verdict).toBe('conditional_pass')
  })

  it('extracts from a step-conclusion tag without json', () => {
    const output = '<step-conclusion>{"verdict":"fail","issues":[],"rationale":"不通过"}</step-conclusion>'
    expect(extractVerdict(output)?.verdict).toBe('fail')
  })

  it('extracts a bare json object', () => {
    const output = '完成。 {"verdict":"pass","issues":[],"rationale":"ok"}'
    expect(extractVerdict(output)?.verdict).toBe('pass')
  })

  it('returns undefined when no verdict is declared', () => {
    expect(extractVerdict('只是一段没有结论的文本')).toBeUndefined()
    expect(extractVerdict('')).toBeUndefined()
  })
})

describe('aggregateVerdicts', () => {
  it('fail outranks conditional_pass which outranks pass', () => {
    const pass = { verdict: 'pass' as const, issues: [], rationale: '' }
    const conditional = { verdict: 'conditional_pass' as const, issues: [], rationale: '' }
    const fail = { verdict: 'fail' as const, issues: [], rationale: '' }
    expect(aggregateVerdicts([pass, conditional])?.verdict).toBe('conditional_pass')
    expect(aggregateVerdicts([pass, fail])?.verdict).toBe('fail')
    expect(aggregateVerdicts([conditional, fail, pass])?.verdict).toBe('fail')
  })

  it('flattens issues from all inputs', () => {
    const a = { verdict: 'pass' as const, issues: [{ type: 'test' as const, severity: 'minor' as const, description: 'a' }], rationale: '' }
    const b = { verdict: 'conditional_pass' as const, issues: [{ type: 'design' as const, severity: 'major' as const, description: 'b' }], rationale: '' }
    expect(aggregateVerdicts([a, b])?.issues).toHaveLength(2)
  })
})
