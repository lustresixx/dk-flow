import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextWorkflowFileName, saveWorkflow } from '../src/store/workflow-store.ts'

let workspace = ''
let originalDshHome = ''

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ace-wfstore-'))
  originalDshHome = process.env.DSH_HOME ?? ''
  // Isolate the personal root so tests never read the real $DSH_HOME/workflows.
  process.env.DSH_HOME = join(workspace, 'dsh-home')
})

afterEach(async () => {
  process.env.DSH_HOME = originalDshHome
  await rm(workspace, { recursive: true, force: true })
})

describe('nextWorkflowFileName', () => {
  it('keeps a free base name unchanged', async () => {
    expect(await nextWorkflowFileName(workspace, 'red-blue-review')).toBe('red-blue-review')
  })

  it('increments a colliding base name with -2, -3, …', async () => {
    const dir = join(workspace, '.dsh', 'workflows')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(dir, { recursive: true }))
    await writeFile(join(dir, 'red-blue-review.yaml'), 'workflow:\n  name: x\n  states: []\n')
    expect(await nextWorkflowFileName(workspace, 'red-blue-review')).toBe('red-blue-review-2')
    await writeFile(join(dir, 'red-blue-review-2.yaml'), 'x')
    expect(await nextWorkflowFileName(workspace, 'red-blue-review')).toBe('red-blue-review-3')
  })

  it('sanitizes spaces and punctuation into hyphens', async () => {
    expect(await nextWorkflowFileName(workspace, '我的 工作流!')).toBe('workflow')
  })
})

describe('saveWorkflow unique', () => {
  it('auto-numbers siblings instead of overwriting', async () => {
    const yaml = 'workflow:\n  name: demo\n  states: []\n'
    const first = await saveWorkflow(workspace, 'demo', yaml, { unique: true })
    const second = await saveWorkflow(workspace, 'demo', yaml, { unique: true })
    expect(first.endsWith('demo.yaml')).toBe(true)
    expect(second.endsWith('demo-2.yaml')).toBe(true)
  })
})
