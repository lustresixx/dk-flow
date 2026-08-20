/**
 * Built-in resource catalog: the ported ACE agent roster and the packaged
 * workflow templates. Resources ship next to the compiled lib (see the
 * package `files` list) and are resolved relative to this module.
 * @module dsh-ace-harness/catalog
 */
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { parseTemplateManifest, parseWorkflowYaml } from '../dsl/load.js'
import { agentDefinitionSchema } from '../dsl/schema.js'
import type { AgentDefinition, WorkflowConfig, WorkflowTemplateManifest } from '../dsl/types.js'

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

/** A built-in workflow template: manifest plus its validated workflow config. */
export interface BuiltinWorkflowTemplate {
  id: string
  version: string
  manifest: WorkflowTemplateManifest
  config: WorkflowConfig
}

/**
 * Compare two dotted version strings segment by segment: numeric segments
 * compare numerically (`0.10.0` > `0.9.0`, unlike a plain localeCompare),
 * anything else falls back to locale order for that segment.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  const length = Math.max(pa.length, pb.length)
  for (let index = 0; index < length; index += 1) {
    const sa = pa[index] ?? ''
    const sb = pb[index] ?? ''
    const na = sa === '' ? NaN : Number(sa)
    const nb = sb === '' ? NaN : Number(sb)
    const bothNumeric = Number.isInteger(na) && Number.isInteger(nb)
    const compared = bothNumeric ? na - nb : sa.localeCompare(sb)
    if (compared !== 0) return compared < 0 ? -1 : 1
  }
  return 0
}

/**
 * The latest version of one template id, per `compareVersions`. The single
 * "latest" rule for every resolution path (P1-1): instance loading,
 * template instantiation, `/workflow run`, `run_workflow`, and the REST API
 * all resolve through this helper.
 */
export function latestTemplate<T extends { id: string; version: string }>(
  templates: readonly T[],
  id: string,
): T | undefined {
  let best: T | undefined
  for (const candidate of templates) {
    if (candidate.id !== id) continue
    if (best === undefined || compareVersions(candidate.version, best.version) > 0) best = candidate
  }
  return best
}

/** Load every packaged agent definition, sorted by name. */
export async function loadBuiltinAgents(): Promise<AgentDefinition[]> {
  const dir = new URL('agents/', resourcesRoot())
  const entries = (await readdir(dir)).filter((name) => name.endsWith('.yaml'))
  const agents: AgentDefinition[] = []
  for (const entry of entries) {
    const raw = parse(await readFile(new URL(entry, dir), 'utf8'))
    const parsed = agentDefinitionSchema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(
        `内置 Agent 资源 ${entry} 校验失败: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
      )
    }
    agents.push(parsed.data)
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name))
}

/** Load every packaged workflow template, sorted by id then version. */
export async function loadBuiltinTemplates(): Promise<BuiltinWorkflowTemplate[]> {
  const dir = new URL('workflows/', resourcesRoot())
  const ids = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  const templates: BuiltinWorkflowTemplate[] = []
  for (const id of ids) {
    const idDir = new URL(`${id}/`, dir)
    const versions = (await readdir(idDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    for (const version of versions) {
      const versionDir = new URL(`${version}/`, idDir)
      const manifestText = await readFile(new URL('manifest.yaml', versionDir), 'utf8')
      const manifest = parseTemplateManifest(manifestText)
      const configText = await readFile(new URL(manifest.spec.entrypoint, versionDir), 'utf8')
      const config = parseWorkflowYaml(configText)
      templates.push({ id, version, manifest, config })
    }
  }
  return templates.sort((a, b) => a.id.localeCompare(b.id) || compareVersions(a.version, b.version))
}

/**
 * Read the raw manifest and workflow YAML sources of one built-in template
 * version. Raw sources feed template instantiation, which needs the unparsed
 * document for JSON Pointer binding.
 * @returns the raw texts, or null when the template id/version does not exist.
 */
export async function readBuiltinTemplateSources(
  id: string,
  version: string,
): Promise<{ manifestText: string; workflowYamlText: string } | null> {
  const dir = new URL(`workflows/${id}/${version}/`, resourcesRoot())
  try {
    const manifestText = await readFile(new URL('manifest.yaml', dir), 'utf8')
    const manifest = parseTemplateManifest(manifestText)
    const workflowYamlText = await readFile(new URL(manifest.spec.entrypoint, dir), 'utf8')
    return { manifestText, workflowYamlText }
  } catch {
    return null
  }
}

/** First comment line (`#` or `//`) of a script file, as its one-line description. */
export function firstCommentLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
      return trimmed.replace(/^#+\s*/, '').replace(/^\/\/+\s*/, '').slice(0, 120)
    }
    return ''
  }
  return ''
}

/** List the packaged reusable scripts in `resources/scripts`. */
export async function listBuiltinScripts(): Promise<{ name: string; description: string }[]> {
  const dir = new URL('scripts/', resourcesRoot())
  let entries: string[] = []
  try {
    entries = (await readdir(dir)).filter((name) => /\.(js|mjs|cjs|py)$/.test(name))
  } catch {
    return []
  }
  const scripts: { name: string; description: string }[] = []
  for (const entry of entries) {
    scripts.push({
      name: entry,
      description: firstCommentLine(await readFile(new URL(entry, dir), 'utf8')),
    })
  }
  return scripts.sort((a, b) => a.name.localeCompare(b.name))
}
