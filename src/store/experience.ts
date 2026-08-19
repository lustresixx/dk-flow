/**
 * Workspace-level supervisor experience store: one append-only JSONL file
 * under `<workspace>/<runDirName>/experience.jsonl` recording per-state
 * scores and advice, replayed as bounded context into later runs' supervisor
 * checkpoints.
 * @module dsh-ace-harness/store
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One recorded supervisor checkpoint. */
export interface ExperienceEntry {
  workflowName: string
  state: string
  score: number | null
  advice: string
  at: string
}

function experienceFile(workspace: string, runDirName: string): string {
  return join(workspace, runDirName, 'experience.jsonl')
}

/** Append one experience entry (workspace-level, shared across runs). */
export async function appendExperience(
  workspace: string,
  runDirName: string,
  entry: ExperienceEntry,
): Promise<void> {
  const file = experienceFile(workspace, runDirName)
  await mkdir(join(workspace, runDirName), { recursive: true })
  await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
}

/** Load the most recent experience entries, newest last, up to the limit. */
export async function loadRecentExperience(
  workspace: string,
  runDirName: string,
  limit: number,
): Promise<ExperienceEntry[]> {
  try {
    const text = await readFile(experienceFile(workspace, runDirName), 'utf8')
    const entries = text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try {
          return JSON.parse(line) as ExperienceEntry
        } catch {
          return null
        }
      })
      .filter((entry): entry is ExperienceEntry => entry !== null)
    return entries.slice(-limit)
  } catch {
    return []
  }
}

/** Render entries as bounded prompt context for the supervisor. */
export function renderExperience(entries: readonly ExperienceEntry[]): string {
  if (entries.length === 0) return ''
  return entries
    .map((entry) => `- [${entry.state}] 评分 ${entry.score ?? '无'}：${truncateLine(entry.advice, 200)}`)
    .join('\n')
}

function truncateLine(text: string, budget: number): string {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length <= budget ? flat : `${flat.slice(0, budget)}…`
}
