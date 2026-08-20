/**
 * Crash-safe atomic file writes: a unique temp file (per process + call) is
 * written then renamed over the target, so concurrent writers never see a
 * torn file and racing same-path writes settle as last-writer-wins instead
 * of corrupting each other's temp file. Windows transiently denies a rename
 * whose destination is touched by another in-flight rename (EPERM/EBUSY), so
 * the rename retries briefly before giving up; temp files are always reaped.
 * @module dsh-ace-harness/store
 */
import { rename, rm, writeFile } from 'node:fs/promises'

let counter = 0

const RENAME_ATTEMPTS = 12
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/** Rename over an existing file, absorbing transient Windows lock denials. */
async function renameReplace(temp: string, file: string): Promise<void> {
  let attempt = 0
  for (;;) {
    try {
      await rename(temp, file)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      attempt += 1
      if (code !== undefined && RETRY_CODES.has(code) && attempt < RENAME_ATTEMPTS) {
        await sleep(Math.min(2 ** attempt * 5, 250) + Math.floor(Math.random() * 10))
        continue
      }
      throw error
    }
  }
}

/** Write `content` to `file` atomically (temp file + rename). */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  counter = (counter + 1) % 1_000_000
  const temp = `${file}.${process.pid}.${Date.now()}.${counter}.tmp`
  try {
    await writeFile(temp, content, 'utf8')
    await renameReplace(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}
