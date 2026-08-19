import { describe, expect, it } from 'vitest'
import { toolFilterFor } from '../src/service.js'

describe('toolFilterFor', () => {
  it('maps the ACE catalog tool names onto DSH tools', () => {
    expect(toolFilterFor(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'])?.allow).toEqual([
      'bash',
      'read',
      'write',
      'edit',
      'glob',
    ])
  })

  it('maps read-only rosters', () => {
    expect(toolFilterFor(['Read', 'Glob', 'Grep'])?.allow).toEqual(['read', 'glob'])
  })

  it('maps web research tools for the researcher role', () => {
    expect(toolFilterFor(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'])?.allow).toEqual([
      'read',
      'glob',
      'web_search',
      'web_fetch',
    ])
  })

  it('skips unknown ACE names and returns no filter when nothing maps', () => {
    expect(toolFilterFor(['UnknownThing'])).toBeUndefined()
    expect(toolFilterFor(undefined)).toBeUndefined()
    expect(toolFilterFor([])).toBeUndefined()
  })
})
