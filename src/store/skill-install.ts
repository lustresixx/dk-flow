/**
 * Framework skill installation: copies the packaged SKILL.md into the DSH
 * skills collection directory (`<dsh home>/skills/ace-workflow/`), the
 * standard skill root the filesystem skill provider discovers. An existing
 * file is never overwritten, so user edits survive reloads.
 * @module dsh-ace-harness/skill-install
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resourcesRoot } from '../catalog/index.js'

/** DSH home directory: `$DSH_HOME` when set, otherwise `~/.dsh`. */
export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/**
 * Install the packaged skill into `<home>/skills/ace-workflow/SKILL.md` when
 * it is missing.
 * @param home - skills root home; defaults to the DSH home.
 * @returns the installed path, or null when the skill already exists or the
 *   copy failed.
 */
export function installFrameworkSkill(home: string = dshHome()): string | null {
  try {
    const targetDir = join(home, 'skills', 'ace-workflow')
    const target = join(targetDir, 'SKILL.md')
    if (existsSync(target)) return null
    const source = new URL('skills/ace-workflow/SKILL.md', resourcesRoot())
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(target, readFileSync(source, 'utf8'))
    return target
  } catch {
    return null
  }
}
