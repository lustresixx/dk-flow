/**
 * Slash-menu trigger source for `/workflow`: typing the command opens a
 * pickable list of built-in templates and saved workflow instances; picking
 * one inserts `/workflow run <name>` so Enter runs it through the normal
 * command path (parameter dialog included).
 */
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { AceStateDto } from './types.ts'

const STATE_ROUTE = '/plugins/dsh-ace-harness/state'

/** Workflow choices with their run ids, cached briefly. */
let cache: { entries: { id: string; name: string; kind: string; summary: string }[]; at: number } | null = null

async function workflowChoices(): Promise<{ id: string; name: string; kind: string; summary: string }[]> {
  if (cache && Date.now() - cache.at < 10_000) return cache.entries
  const response = await fetch(STATE_ROUTE, { cache: 'no-store' })
  if (!response.ok) return cache?.entries ?? []
  const state = (await response.json()) as AceStateDto
  const entries = [
    ...state.templates.map((template) => ({
      id: template.id,
      name: template.name,
      kind: '模板',
      summary: `${template.stateCount} 状态 · ${template.description || ''}`,
    })),
    ...state.workspaces.flatMap((workspace) =>
      workspace.workflows.map((workflow) => ({
        id: workflow.fileName,
        name: workflow.name,
        kind: '工作流',
        summary: `${workflow.stateCount} 状态 / ${workflow.stepCount} 步 · ${workspace.title}`,
      })),
    ),
  ]
  cache = { entries, at: Date.now() }
  return entries
}

/** The `/workflow` trigger source registered on the client inputTriggers service. */
export function workflowTriggerSource(): InputTriggerSource {
  return {
    trigger: '/',
    name: 'workflow',
    order: 20,
    async candidates(_session, req) {
      const query = req.query.trim().toLowerCase()
      const entries = await workflowChoices()
      const matched = entries.filter((entry) => {
        if (query === '') return true
        return entry.id.toLowerCase().includes(query) || entry.name.toLowerCase().includes(query)
      })
      return matched.slice(0, 12).map((entry) => ({
        name: `${entry.kind} · ${entry.name}`,
        description: entry.summary.slice(0, 80),
        hint: `运行 ${entry.id}`,
      }))
    },
    onPick(pick) {
      const entry = pick.candidate.name.replace(/^(模板|工作流) · /, '')
      // Resolve the display name back to a runnable id.
      const id = pick.candidate.hint?.replace(/^运行 /, '') ?? entry
      return { text: `/workflow run ${id} ` }
    },
  }
}
