import { describe, expect, it } from 'vitest'
import { pointerGet, pointerSet } from '../src/dsl/json-pointer.js'

describe('pointerGet', () => {
  const root = {
    a: { b: [{ c: 1 }] },
    'x/y': { 't~i': true },
  }

  it('reads nested paths and array indices', () => {
    expect(pointerGet(root, '/a/b/0/c')).toBe(1)
    expect(pointerGet(root, '')).toBe(root)
  })

  it('decodes ~0 and ~1 escapes', () => {
    expect(pointerGet(root, '/x~1y/t~0i')).toBe(true)
  })

  it('returns undefined for missing paths', () => {
    expect(pointerGet(root, '/a/nope')).toBeUndefined()
    expect(pointerGet(root, '/a/b/9')).toBeUndefined()
  })
})

describe('pointerSet', () => {
  it('writes into existing structures', () => {
    const doc = { workflow: { name: 'old' } }
    pointerSet(doc, '/workflow/name', 'new')
    expect(doc.workflow.name).toBe('new')
  })

  it('creates missing containers', () => {
    const doc: Record<string, unknown> = {}
    pointerSet(doc, '/context/requirements', 'r')
    expect(doc).toEqual({ context: { requirements: 'r' } })
  })

  it('rejects replacing the root', () => {
    expect(() => pointerSet({}, '', 1)).toThrow()
  })
})
