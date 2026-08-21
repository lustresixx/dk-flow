import { describe, expect, it } from 'vitest'
import { StatsCache } from '../src/store/stats-cache.ts'

describe('StatsCache (P2)', () => {
  it('returns a fresh entry within the TTL', () => {
    const cache = new StatsCache<number>(10_000)
    cache.set('w', 42, 1000)
    expect(cache.get('w', 5000)).toBe(42)
    expect(cache.get('w', 9999)).toBe(42)
  })

  it('expires after the TTL and drops the entry (fallback only)', () => {
    const cache = new StatsCache<number>(10_000)
    cache.set('w', 42, 1000)
    expect(cache.get('w', 1000 + 10_000)).toBeUndefined()
    // Expired entries are removed, not merely hidden.
    cache.set('w', 7, 1000 + 10_000)
    expect(cache.get('w', 1000 + 10_000)).toBe(7)
  })

  it('write-through invalidation makes the next read miss immediately', () => {
    const cache = new StatsCache<number>(60_000)
    cache.set('w', 42, 1000)
    cache.invalidate('w')
    expect(cache.get('w', 1001)).toBeUndefined()
  })

  it('keeps keys independent', () => {
    const cache = new StatsCache<number>(10_000)
    cache.set('a', 1, 0)
    cache.invalidate('b')
    cache.set('b', 2, 0)
    expect(cache.get('a', 5000)).toBe(1)
    expect(cache.get('b', 5000)).toBe(2)
  })

  it('clear drops every entry', () => {
    const cache = new StatsCache<number>(60_000)
    cache.set('a', 1, 0)
    cache.set('b', 2, 0)
    cache.clear()
    expect(cache.get('a', 1)).toBeUndefined()
    expect(cache.get('b', 1)).toBeUndefined()
  })
})
