/**
 * Tiny per-key TTL cache for aggregate read paths (P2). The stats route must
 * not rescan every run on each panel poll, but the cache must NEVER make a
 * freshly-persisted mutation invisible: the write path invalidates the
 * workspace key explicitly (write-through), and the TTL is only a fallback for
 * mutations that bypass the persist pipeline (e.g. backfill from another
 * process). Pure bookkeeping — no host service access, unit-testable.
 * @module dsh-ace-harness/store
 */

export class StatsCache<T> {
  private readonly entries = new Map<string, { at: number; value: T }>()

  constructor(private readonly ttlMs: number) {}

  /** A fresh-enough entry, or undefined to recompute (expired entries drop). */
  get(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (now - entry.at >= this.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: T, now = Date.now()): void {
    this.entries.set(key, { at: now, value })
  }

  /** Write-through invalidation: the next read for this key recomputes. */
  invalidate(key: string): void {
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }
}
