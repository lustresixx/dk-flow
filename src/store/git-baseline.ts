/**
 * Git baseline snapshots for governance: record HEAD and a porcelain status
 * summary into the run directory at the run start. Git is optional — captures
 * degrade to `null` when the directory is not a repository or the `git`
 * executable is unavailable.
 * @module dsh-ace-harness/store
 */
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runDir } from './paths.js'

/** Run one git command tolerantly; failures resolve to null output. */
function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 15000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim())
    })
  })
}

/** A captured git point-in-time summary. */
export interface GitSnapshot {
  head: string | null
  /** One porcelain status line per changed path; empty when clean. */
  statusLines: string[]
}

/** Capture HEAD and working-tree status of a directory (null-safe). */
export async function captureGitSnapshot(projectRoot: string | undefined): Promise<GitSnapshot> {
  if (!projectRoot || projectRoot.trim() === '') return { head: null, statusLines: [] }
  const [head, status] = await Promise.all([
    git(projectRoot, ['rev-parse', 'HEAD']),
    git(projectRoot, ['status', '--porcelain=v1', '--untracked-files=all']),
  ])
  return { head, statusLines: status === null ? [] : status.split('\n').filter((line) => line !== '') }
}

/**
 * Write a named git snapshot into the run directory.
 * @returns the snapshot file name inside the run directory, or null when
 *   there was nothing to record.
 */
export async function saveGitSnapshot(
  workspace: string,
  runId: string,
  runDirName: string,
  kind: 'baseline' | 'state',
  stateName: string | null,
  snapshot: GitSnapshot,
): Promise<string | null> {
  if (snapshot.head === null && snapshot.statusLines.length === 0) return null
  const dir = runDir(workspace, runId, runDirName)
  await mkdir(dir, { recursive: true })
  const fileName = kind === 'baseline' ? 'git-baseline.json' : `git-state-${sanitize(stateName ?? 'run')}.json`
  await writeFile(
    join(dir, fileName),
    JSON.stringify(
      {
        kind,
        state: stateName,
        capturedAt: new Date().toISOString(),
        head: snapshot.head,
        statusLines: snapshot.statusLines,
      },
      null,
      2,
    ),
    'utf8',
  )
  return fileName
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}
