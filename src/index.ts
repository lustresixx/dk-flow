/**
 * dsh-ace-harness plugin entry: the ACEHarness core as a DeepSeek Harness
 * bundle. Mounts the `ace-harness` service, the `/workflow` command family,
 * the model-facing `workflow_*` tools, a usage-policy system-prompt section,
 * and a web panel data route (web profiles only).
 *
 * Installation: `dsh plugin --profile <name> add <this package>`.
 * @module dsh-ace-harness
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { registerCommands } from './commands.js'
import AceHarnessService, { type AceHarnessConfig } from './service.js'
import { registerTools } from './tools.js'

/** Read a request body up to a byte cap. */
function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        rejectPromise(new Error(`请求体超过 ${maxBytes} 字节上限`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      resolvePromise(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', rejectPromise)
  })
}

/** Packaged assets directory, probing the compiled and source layouts. */
function assetsRoot(): URL {
  const candidates = [new URL('../assets/', import.meta.url), new URL('../../assets/', import.meta.url)]
  for (const candidate of candidates) {
    if (existsSync(fileURLToPath(new URL('ace-logo.png', candidate)))) return candidate
  }
  return candidates[0]!
}

export const name = 'ace-harness'

/** Host services this plugin waits for before activation. */
export const inject = ['tools', 'subagents', 'commands', 'userQuestions', 'systemPrompt', 'sessions', 'llm']

/** Plugin configuration, settable from the cordis.patch.yml row. */
export interface Config extends AceHarnessConfig {
  /** System-prompt usage section order (default 118, tool guidance band). */
  promptSectionOrder?: number
}

export const Config: z<Config> = z.object({
  subagentProvider: z.string().default('spawn'),
  model: z.string(),
  runDirName: z.string().default('.ace-workflows'),
  maxSubworkflowDepth: z.natural().min(1).max(8).default(8),
  maxConcurrentRuns: z.natural().min(1).default(4),
  preCommandTimeoutMs: z.natural().default(300000),
  stepTimeoutMs: z.natural().default(1800000),
  promptSectionOrder: z.natural().default(118),
})

/** Web-server service key candidates, newest first (mirrors dsh-agent-teams). */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'] as const
/** Workspace registry service key candidates, newest first. */
const WORKSPACE_KEYS = ['workspaceRegistry', 'workspace'] as const

/** Structural slice of the web server service used to register panel routes. */
interface WebRouteHost {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Structural slice of the workspace registry: paths with display titles. */
interface WorkspaceRegistryLike {
  list(): { title: string; path: string }[]
}

/** The model-facing usage policy for the workflow tools. */
function usageSectionText(toolNames: string): string {
  return `You have ACE state-machine workflow tools available: ${toolNames}. Use them when the user asks to run, create, review, or inspect an ACE workflow (e.g. "跑一下红蓝评审工作流", "用 workflow 评审这次改动"). Semantics: a workflow is a YAML state machine whose states run agent steps with roles defender/attacker/judge and whose transitions are driven by verdicts (pass / conditional_pass / fail). workflow_list discovers built-in templates and saved workflow instances; run_workflow starts a run (template ids are instantiated with params first; wait=true collects the terminal result); workflow_manage shows/resumes/stops runs and creates instances from templates. Prefer running named workflows instead of hand-writing steps; report the run id and terminal verdict back to the user.`
}

export function apply(ctx: Context, config: Config): void {
  const resolved: AceHarnessConfig = {
    subagentProvider: config.subagentProvider,
    model: config.model,
    runDirName: config.runDirName,
    maxSubworkflowDepth: config.maxSubworkflowDepth,
    maxConcurrentRuns: config.maxConcurrentRuns,
  }
  // The Service constructor registers synchronously on this plugin's fiber
  // (and unregisters when the fiber unloads), so direct construction makes
  // the instance immediately resolvable for commands, tools, and routes.
  const aceHarness = new AceHarnessService(ctx, resolved)

  registerCommands(ctx, aceHarness)
  registerTools(ctx, aceHarness)

  ctx.systemPrompt.section({
    name: 'ace-harness:usage',
    order: config.promptSectionOrder ?? 118,
    text: usageSectionText('workflow_list, run_workflow, workflow_manage'),
  })

  // The web panel data route needs the web server and the workspace registry,
  // which headless profiles do not mount and which may bind after this plugin
  // under concurrent activation. Register lazily; in a webless profile the
  // plugin stays command/tool-only and never blocks boot.
  let webRegistered = false
  const registerWebSurface = (): void => {
    if (webRegistered) return
    const webServer = (ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1])) as
      | WebRouteHost
      | undefined
    const workspaceRegistry = (ctx.get(WORKSPACE_KEYS[0]) ?? ctx.get(WORKSPACE_KEYS[1])) as
      | WorkspaceRegistryLike
      | undefined
    if (webServer === undefined || workspaceRegistry === undefined) return
    webRegistered = true

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-ace-harness/state',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x')
        try {
          const workspaces = workspaceRegistry.list().map((workspace) => ({
            workspace: workspace.title,
            path: workspace.path,
          }))
          // Aggregate across every known workspace; the panel filters by its own
          // session workspace (or ?workspace=<path> when supplied).
          const wanted = url.searchParams.get('workspace')
          const roots = wanted ? workspaces.filter((w) => w.path === wanted) : workspaces
          const [agents, templates, runsByWorkspace, workflowsByWorkspace] = await Promise.all([
            aceHarness.listAgents(),
            aceHarness.listTemplates(),
            Promise.all(roots.map(async (w) => ({ path: w.path, runs: await aceHarness.listRuns(w.path) }))),
            Promise.all(roots.map(async (w) => ({ path: w.path, workflows: await aceHarness.listWorkflows(w.path) }))),
          ])
        const body = JSON.stringify({
          agents: agents.map((agent) => ({
            name: agent.name,
            team: agent.team,
            roleType: agent.roleType,
            description: agent.description ?? '',
            capabilities: agent.capabilities,
          })),
          templates: templates.map((t) => ({
            id: t.id,
            version: t.version,
            name: t.manifest.metadata.name,
            description: t.manifest.metadata.description ?? '',
            category: t.manifest.metadata.category ?? '',
            tags: t.manifest.metadata.tags ?? [],
            featured: t.manifest.metadata.featured ?? false,
            stateCount: t.config.workflow.states.length,
            parameters: t.manifest.spec.parameters ?? [],
            agents: t.manifest.spec.dependencies?.agents ?? [],
            states: t.config.workflow.states.map((s) => ({
              name: s.name,
              isInitial: s.isInitial,
              isFinal: s.isFinal,
              position: s.position ?? null,
              steps: s.steps.map((step) => ({
                name: step.name,
                agent: step.agent ?? null,
                role: step.role ?? null,
                type: step.type ?? 'agent',
              })),
            })),
          })),
          workspaces: runsByWorkspace.map((entry, index) => ({
            path: entry.path,
            title: roots[index]?.workspace ?? entry.path,
            runs: entry.runs.map((run) => ({
              runId: run.id,
              workflowName: run.workflowName,
              status: run.status,
              currentState: run.currentState,
              completedSteps: run.completedSteps,
              totalSteps: run.totalSteps,
              error: run.error,
              startedAt: run.startedAt,
              finishedAt: run.finishedAt,
              states: run.stateOutcomes.map((outcome) => ({
                state: outcome.state,
                verdict: outcome.verdict.verdict,
                supervisorScore: outcome.supervisorScore ?? null,
                supervisorNote: outcome.supervisorNote ?? null,
                steps: outcome.steps.map((step) => ({
                  step: step.step,
                  type: step.type,
                  agent: step.agent,
                  role: step.role,
                  verdict: step.verdict?.verdict ?? null,
                  outputSummary: step.outputSummary,
                  data: step.data ?? null,
                })),
              })),
            })),
            workflows: workflowsByWorkspace[index]?.workflows.map((w) => ({
              fileName: w.fileName,
              name: w.summary.name,
              source: w.source,
              stateCount: w.summary.stateCount,
              stepCount: w.summary.stepCount,
            })) ?? [],
          })),
        })
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(body)
        } catch (error) {
          ctx.logger('ace-harness').warn(`state route failed: ${String(error)}`)
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(String(error))
        }
      },
    }), 'ace-harness: state route')

    // Raw workflow read/write + template instantiation routes for the visual
    // editor. Workspace paths are validated against the workspace registry;
    // file names are restricted to a safe pattern.
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/plugins/dsh-ace-harness/workflows',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x')
        let rawName: string
        try {
          rawName = decodeURIComponent(url.pathname.slice('/plugins/dsh-ace-harness/workflows'.length)).replace(/^\/+/, '')
        } catch {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('workflow 文件名非法')
          return
        }
        // The state route reports extension-less names; accept both forms and
        // normalize to the canonical `<name>.yaml`.
        const base = rawName.endsWith('.yaml') ? rawName.slice(0, -'.yaml'.length) : rawName
        const relative = `${base}.yaml`
        try {
          const workspacePath = url.searchParams.get('workspace')
          const known = workspaceRegistry.list().map((workspace) => workspace.path)
          if (!workspacePath || !known.includes(workspacePath)) {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('workspace 不在已知工作区列表中')
            return
          }
          if (relative !== '.yaml' && !/^[A-Za-z0-9_-]+\.yaml$/.test(relative)) {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('workflow 文件名非法')
            return
          }
          if (req.method === 'GET') {
            const loaded = await aceHarness.loadWorkflowConfig(workspacePath, relative)
            if (!loaded) {
              res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
              res.end(`未找到 workflow「${relative}」`)
              return
            }
            const { readFile } = await import('node:fs/promises')
            const yaml = await readFile(loaded.file, 'utf8')
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
            res.end(yaml)
            return
          }
          if (req.method === 'POST') {
            const body = await readRequestBody(req, 1_000_000)
            const saved = await aceHarness.saveWorkflowConfig(workspacePath, relative, body)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: true, file: saved }))
            return
          }
          res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('method not allowed')
        } catch (error) {
          ctx.logger('ace-harness').warn(`workflows route failed: ${String(error)}`)
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(String(error))
        }
      },
    }), 'ace-harness: workflows route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-ace-harness/instantiate',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('method not allowed')
            return
          }
          const body = JSON.parse(await readRequestBody(req, 1_000_000)) as {
            templateId?: string
            values?: Record<string, string>
          }
          const templateId = body.templateId
          if (!templateId) {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('缺少 templateId')
            return
          }
          const instantiated = await aceHarness.instantiate(templateId, undefined, body.values ?? {}, {})
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(instantiated.yamlText)
        } catch (error) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(String(error))
        }
      },
    }), 'ace-harness: instantiate route')

    // API-driven run: executes a workflow instance/template against a known
    // workspace and returns the terminal run result.
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-ace-harness/run',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('method not allowed')
            return
          }
          const body = JSON.parse(await readRequestBody(req, 1_000_000)) as {
            workspace?: string
            workflow?: string
            values?: Record<string, string>
          }
          const workspacePath = body.workspace
          const known = workspaceRegistry.list().map((workspace) => workspace.path)
          if (!workspacePath || !known.includes(workspacePath)) {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('workspace 不在已知工作区列表中')
            return
          }
          if (!body.workflow) {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('缺少 workflow（实例文件名或模板 id）')
            return
          }
          const handle = await aceHarness.runApi({
            workspace: workspacePath,
            workflowRef: body.workflow,
            values: body.values ?? {},
          })
          const result = await handle.result
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(
            JSON.stringify({
              runId: handle.runId,
              status: result.status,
              verdict: result.verdict ?? null,
              error: result.error,
              states: result.stateOutcomes.map((outcome) => ({
                state: outcome.state,
                verdict: outcome.verdict.verdict,
                supervisorScore: outcome.supervisorScore ?? null,
                steps: outcome.steps.map((step) => ({
                  step: step.step,
                  type: step.type,
                  verdict: step.verdict?.verdict ?? null,
                  outputSummary: step.outputSummary,
                  data: step.data ?? null,
                })),
              })),
            }),
          )
        } catch (error) {
          ctx.logger('ace-harness').warn(`run route failed: ${String(error)}`)
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(String(error))
        }
      },
    }), 'ace-harness: run route')

    // Live streaming projection of one run, polled by the web panel.
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-ace-harness/stream',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          const runId = url.searchParams.get('runId')
          if (!runId) {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('缺少 runId')
            return
          }
          const snapshot = aceHarness.streamSnapshot(runId)
          if (!snapshot) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('未找到该运行的实时流（可能已结束并被清理）')
            return
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(snapshot))
        } catch (error) {
          ctx.logger('ace-harness').warn(`stream route failed: ${String(error)}`)
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(String(error))
        }
      },
    }), 'ace-harness: stream route')

    // Stop an active run from the web panel.
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-ace-harness/stop',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('method not allowed')
            return
          }
          const body = JSON.parse(await readRequestBody(req, 64_000)) as { runId?: string }
          const runId = body.runId
          if (!runId) {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('缺少 runId')
            return
          }
          const stopped = aceHarness.stopRun(runId)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: stopped, runId }))
        } catch (error) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(String(error))
        }
      },
    }), 'ace-harness: stop route')

    // Packaged artwork: the ACE logo and favicon, served through an explicit
    // allowlist (no path traversal).
    const assetsDir = assetsRoot()
    const ASSET_ALLOWLIST = new Set(['ace-logo.png', 'favicon.ico'])
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/plugins/dsh-ace-harness/assets',
      handler: async (req, res) => {
        let name: string
        try {
          name = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.split('/').pop() ?? '')
        } catch {
          res.writeHead(404)
          res.end()
          return
        }
        if (!ASSET_ALLOWLIST.has(name)) {
          res.writeHead(404)
          res.end()
          return
        }
        try {
          const { readFile } = await import('node:fs/promises')
          const { fileURLToPath } = await import('node:url')
          const data = await readFile(fileURLToPath(new URL(name, assetsDir)))
          res.writeHead(200, {
            'content-type': name.endsWith('.ico') ? 'image/x-icon' : 'image/png',
            'cache-control': 'public, max-age=86400',
          })
          res.end(data)
        } catch {
          res.writeHead(404)
          res.end()
        }
      },
    }), 'ace-harness: assets route')
  }

  registerWebSurface()
  ctx.on('internal/service', (serviceName: string) => {
    if (
      WEB_SERVER_KEYS.includes(serviceName as (typeof WEB_SERVER_KEYS)[number]) ||
      WORKSPACE_KEYS.includes(serviceName as (typeof WORKSPACE_KEYS)[number])
    ) {
      registerWebSurface()
    }
  })
}
