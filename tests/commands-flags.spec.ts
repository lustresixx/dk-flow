import { describe, expect, it } from 'vitest'
import { parseFlags, parseParamFlags } from '../src/commands.js'

describe('parseFlags', () => {
  it('parses positionals and single flags', () => {
    const { positional, flags } = parseFlags('/workflow run demo.yaml --wait')
    expect(positional).toEqual(['/workflow', 'run', 'demo.yaml'])
    expect(flags.get('wait')).toEqual(['true'])
  })

  it('accumulates repeated --param flags instead of overwriting', () => {
    const { flags } = parseFlags(
      '/workflow run demo.yaml --param title=优化代码 --param description=提升稳定性',
    )
    expect(flags.get('param')).toEqual(['title=优化代码', 'description=提升稳定性'])
    expect(parseParamFlags(flags)).toEqual({ title: '优化代码', description: '提升稳定性' })
  })

  it('decodes URI-encoded param values from the workbench form', () => {
    const { flags } = parseFlags(
      `/workflow run demo.yaml --param title=${encodeURIComponent('优化 代码/性能')}`,
    )
    expect(parseParamFlags(flags)).toEqual({ title: '优化 代码/性能' })
  })

  it('keeps plain (unencoded) values untouched', () => {
    const { flags } = parseFlags('/workflow run demo.yaml --param requirements=输入文本')
    expect(parseParamFlags(flags)).toEqual({ requirements: '输入文本' })
  })
})
