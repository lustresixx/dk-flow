import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFileAtomic } from '../src/store/atomic.ts'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ace-atomic-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('writeFileAtomic', () => {
  it('writes content', async () => {
    const file = join(dir, 'a.json')
    await writeFileAtomic(file, '{"ok":true}')
    expect(await readFile(file, 'utf8')).toBe('{"ok":true}')
  })

  it('survives 64 concurrent same-path writers with no torn file', async () => {
    const file = join(dir, 'race.json')
    const payloads = Array.from({ length: 64 }, (_, index) => JSON.stringify({ writer: index, pad: 'x'.repeat(2048) }))
    await Promise.all(payloads.map((payload) => writeFileAtomic(file, payload)))
    const final = await readFile(file, 'utf8')
    // Last-writer-wins: the content must be exactly one complete payload.
    const parsed = JSON.parse(final) as { writer: number; pad: string }
    expect(parsed.pad).toBe('x'.repeat(2048))
    expect(final).toBe(payloads[parsed.writer])
  })

  it('leaves no temp files behind', async () => {
    const file = join(dir, 'clean.json')
    await Promise.all(Array.from({ length: 8 }, (_, i) => writeFileAtomic(file, `v${i}`)))
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(dir)
    expect(entries.filter((name) => name.endsWith('.tmp'))).toHaveLength(0)
  })
})
