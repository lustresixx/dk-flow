import { describe, expect, it } from 'vitest'
import { toolFilterFor } from '../src/service.js'

const allAvailable = (): boolean => true

describe('toolFilterFor', () => {
  it('maps the ACE catalog tool names onto DSH tools', () => {
    expect(toolFilterFor(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'], allAvailable)?.allow).toEqual([
      'bash',
      'read',
      'write',
      'edit',
      'glob',
      'grep',
    ])
  })

  it('maps read-only rosters', () => {
    expect(toolFilterFor(['Read', 'Glob', 'Grep'], allAvailable)?.allow).toEqual(['read', 'glob', 'grep'])
  })

  it('maps web research tools for the researcher role', () => {
    expect(toolFilterFor(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'], allAvailable)?.allow).toEqual([
      'read',
      'glob',
      'grep',
      'web_search',
      'web_fetch',
    ])
  })

  it('falls back to pwsh when bash is not registered (Windows deployments)', () => {
    const available = new Set(['pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'web_search'])
    const allow = toolFilterFor(['Bash', 'Read'], (name) => available.has(name))?.allow
    expect(allow).toEqual(['pwsh', 'read'])
  })

  it('skips unavailable candidates and unknown ACE names', () => {
    expect(toolFilterFor(['Bash', 'Read'], () => false)).toBeUndefined()
    expect(toolFilterFor(['UnknownThing'], allAvailable)).toBeUndefined()
    expect(toolFilterFor(undefined, allAvailable)).toBeUndefined()
    expect(toolFilterFor([], allAvailable)).toBeUndefined()
  })

  it('grants the skill tool for declared skills that resolve', () => {
    const skills = ['ace-workflow', 'missing-skill']
    const isSkillAvailable = (name: string): boolean => name === 'ace-workflow'
    expect(toolFilterFor(['Read'], allAvailable, skills, isSkillAvailable)?.allow).toEqual(['read', 'skill'])
  })

  it('resolves a skill name inside allowedTools to the skill tool', () => {
    const isSkillAvailable = (name: string): boolean => name === 'ace-workflow'
    expect(toolFilterFor(['Read', 'ace-workflow'], allAvailable, [], isSkillAvailable)?.allow).toEqual([
      'read',
      'skill',
    ])
  })

  it('omits the skill tool when no declared skill resolves', () => {
    expect(toolFilterFor(['Read'], allAvailable, ['missing-skill'], () => false)?.allow).toEqual(['read'])
    expect(toolFilterFor([], allAvailable, ['missing-skill'], () => false)).toBeUndefined()
  })
})
