import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installFrameworkSkill } from '../src/store/skill-install.js'

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-skill-install-'))
})

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

describe('installFrameworkSkill', () => {
  it('installs the packaged SKILL.md into the skills collection directory', () => {
    const installed = installFrameworkSkill(dir)
    expect(installed).toBe(join(dir, 'skills', 'ace-workflow', 'SKILL.md'))
    const content = readFileSync(installed!, 'utf8')
    expect(content).toContain('ace-workflow')
    expect(content).toContain('/workflow')
  })

  it('never overwrites an existing skill, preserving user edits', () => {
    const target = join(dir, 'skills', 'ace-workflow', 'SKILL.md')
    writeFileSync(target, '用户自定义内容', 'utf8')
    expect(installFrameworkSkill(dir)).toBeNull()
    expect(readFileSync(target, 'utf8')).toBe('用户自定义内容')
  })
})
