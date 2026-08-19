/**
 * Minimal RFC 6901 JSON Pointer read/write used by template parameter binding.
 * @module dsh-ace-harness/dsl
 */

/**
 * Read the value at a JSON Pointer path, or `undefined` when absent.
 * @param root - the document root.
 * @param pointer - RFC 6901 pointer (e.g. `/workflow/name`).
 */
export function pointerGet(root: unknown, pointer: string): unknown {
  if (pointer === '') return root
  let current: unknown = root
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(current)) {
      const index = Number(token)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined
      current = current[index]
    } else if (typeof current === 'object' && current !== null) {
      if (!(token in current)) return undefined
      current = (current as Record<string, unknown>)[token]
    } else {
      return undefined
    }
  }
  return current
}

/**
 * Write a value at a JSON Pointer path, creating missing containers along the way.
 * @param root - mutable document root.
 * @param pointer - RFC 6901 pointer; must not be empty.
 * @param value - value to write.
 */
export function pointerSet(root: Record<string, unknown>, pointer: string, value: unknown): void {
  if (pointer === '') throw new Error('pointerSet: cannot replace the root document')
  const tokens = pointer
    .slice(1)
    .split('/')
    .map((raw) => raw.replace(/~1/g, '/').replace(/~0/g, '~'))
  let current: Record<string, unknown> = root
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i]!
    const next = current[token]
    if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
      current = next as Record<string, unknown>
    } else {
      const created: Record<string, unknown> = {}
      current[token] = created
      current = created
    }
  }
  current[tokens[tokens.length - 1]!] = value
}
