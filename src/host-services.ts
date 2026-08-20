/**
 * Host capability resolution in one place (P2-3). The service and its
 * collaborators used to reach for implicit globals ad hoc — `ctx.get(...)`
 * structural assertions scattered across modules, `process.cwd()` read at
 * the workspace fallback — which made the host seam invisible and hard to
 * substitute in tests. `HostServices` names the seam; the default
 * implementation keeps the historical LAZY resolution (the jobs service
 * is not in this plugin's `inject` list and may mount after activation,
 * so it must be looked up per call, not snapshotted at construction).
 * @module dsh-ace-harness/host-services
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { JobRegistryFace } from './run-lifecycle.js'

/** The sessions registry slice the service uses (live roots + lookup). */
export type AgentsRegistryFace = Pick<AgentRegistry, 'get' | 'roots'>

/** Host capabilities the service draws on, resolved in one place. */
export interface HostServices {
  /** Fallback workspace root when a session carries no cwd. */
  readonly processCwd: string
  /** Sessions registry, when the profile mounts one (lazy: may arrive late). */
  agents(): AgentsRegistryFace | undefined
  /** Jobs registry, when the profile mounts one (lazy: may arrive late). */
  jobs(): JobRegistryFace | undefined
}

/** The production seam: lazy `ctx.get` lookups plus the process cwd. */
export function defaultHostServices(ctx: Context): HostServices {
  return {
    processCwd: process.cwd(),
    agents: () => ctx.get('agents') as AgentsRegistryFace | undefined,
    jobs: () => ctx.get('jobs') as JobRegistryFace | undefined,
  }
}

/**
 * Synthetic parent for session-less REST runs. Only these fields are read
 * down the pipeline: `session.header.cwd` (workspace binding), `options`
 * (model-route defaults), and `session.id` (undefined here — a session-less
 * run records no parentSessionId and therefore cannot be resumed, which is
 * the intended authorization semantics).
 */
export function apiRunnerParent(workspace: string): Agent {
  return {
    id: 'api-runner' as unknown as SessionId,
    session: { header: { cwd: workspace } },
    options: {},
  } as unknown as Agent
}
