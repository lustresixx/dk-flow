import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendExperience, loadRecentExperience, renderExperience } from '../src/store/experience.js'

const dirs: string[] = []

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ace-exp-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('experience store', () => {
  it('appends and reloads entries newest-last under the limit', async () => {
    const workspace = await tempWorkspace()
    for (let i = 1; i <= 3; i += 1) {
      await appendExperience(workspace, '.ace-workflows', {
        workflowName: '红蓝评审',
        state: `状态${i}`,
        score: i,
        advice: `建议${i}`,
        at: `2026-01-0${i}T00:00:00Z`,
      })
    }
    const entries = await loadRecentExperience(workspace, '.ace-workflows', 2)
    expect(entries.map((entry) => entry.state)).toEqual(['状态2', '状态3'])
  })

  it('returns empty for a missing store', async () => {
    const workspace = await tempWorkspace()
    expect(await loadRecentExperience(workspace, '.ace-workflows', 5)).toEqual([])
  })

  it('renders entries as prompt context', () => {
    const text = renderExperience([
      { workflowName: 'w', state: '方案', score: 8, advice: '证据充分', at: 'x' },
      { workflowName: 'w', state: '执行', score: null, advice: '风险未收敛', at: 'y' },
    ])
    expect(text).toContain('[方案] 评分 8')
    expect(text).toContain('[执行] 评分 无')
  })

  it('skips malformed lines on load', async () => {
    const workspace = await tempWorkspace()
    await appendExperience(workspace, '.ace-workflows', {
      workflowName: 'w',
      state: 's',
      score: 1,
      advice: 'ok',
      at: 'x',
    })
    const { appendFile } = await import('node:fs/promises')
    await appendFile(join(workspace, '.ace-workflows', 'experience.jsonl'), 'not-json\n', 'utf8')
    const entries = await loadRecentExperience(workspace, '.ace-workflows', 5)
    expect(entries).toHaveLength(1)
  })
})
