/**
 * Packaged-resource root resolution: the lowest-level module every resource
 * consumer (catalog, engine script runner, skill installer) shares, so no
 * lower layer imports upward to find the shipped resources (P2-2).
 * @module dsh-ace-harness/resources
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Absolute path to the packaged resources directory. Compiled output mirrors
 * `src/` under `lib/` at the same depth, so the offset differs between the
 * two layouts; probe the lib layout first, then the source layout.
 */
export function resourcesRoot(): URL {
  const candidates = [new URL('../resources/', import.meta.url), new URL('../../resources/', import.meta.url)]
  for (const candidate of candidates) {
    if (existsSync(fileURLToPath(new URL('agents/', candidate)))) return candidate
  }
  return candidates[0]!
}
