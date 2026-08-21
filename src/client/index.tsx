/**
 * Browser plugin: the ACE workflow floater. A body-portal panel (the web
 * shell has no dedicated top-right slot) that browses built-in templates and
 * workflow instances, submits `/workflow` commands into the current session,
 * and watches run progress through the host state route.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { createRoot } from 'react-dom/client'
import { AcePanel } from './AcePanel.tsx'
import { workflowTriggerSource } from './workflow-trigger.ts'

/** Required client services: the sessions face for submission. */
export const inject = ['sessions']

/** Structural conversation send face (resolved through the service store). */
interface ConversationSendFace {
  sendSession(
    session: unknown,
    text: string,
    imageIds: readonly unknown[],
    mode: string,
  ): Promise<void>
}

/** Send one slash-command line into the current session's composer sink. */
async function sendCommand(ctx: ClientContext, text: string): Promise<boolean> {
  const current = ctx.sessions.list.getSnapshot().current
  if (current === undefined) return false
  const binding = ctx.sessions.binding(current)
  if (binding === undefined) return false
  const conversation = ctx.get('conversation') as ConversationSendFace | undefined
  if (conversation === undefined) return false
  await conversation.sendSession(binding.session, text, [], 'queue')
  return true
}

/**
 * Start a workflow run through the REST route with structured values instead
 * of a slash command: values ride as JSON, so nothing is lost to flag parsing
 * or a session round-trip. With a live session the run detaches as a job
 * (202, agent steps + approval gates bind to it); without one it runs
 * foreground (script/llm-only workflows).
 */
async function runWorkflow(
  ctx: ClientContext,
  workspace: string,
  workflow: string,
  values: Record<string, string>,
): Promise<{ ok: boolean; message: string }> {
  try {
    const sessionId = ctx.sessions.list.getSnapshot().current
    const response = await fetch('/plugins/dsh-ace-harness/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace,
        workflow,
        values,
        sessionId,
        mode: sessionId !== undefined ? 'job' : 'foreground',
      }),
    })
    const text = await response.text()
    if (!response.ok) return { ok: false, message: text }
    if (sessionId !== undefined) {
      // 202 { runId, detached }: the live panel picks it up via the state poll.
      try {
        const body = JSON.parse(text) as { runId?: string }
        return { ok: true, message: body.runId ? `运行已启动 ${body.runId}` : text }
      } catch {
        return { ok: true, message: text }
      }
    }
    try {
      const body = JSON.parse(text) as { status?: string; verdict?: string }
      return { ok: true, message: `运行完成：${body.status ?? '未知'}${body.verdict ? ` / ${body.verdict}` : ''}` }
    } catch {
      return { ok: true, message: text }
    }
  } catch (error) {
    return { ok: false, message: `运行失败：${(error as Error).message}` }
  }
}

export function apply(ctx: ClientContext): void {
  const host = document.createElement('div')
  host.dataset.aceHarnessHost = ''
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(
    <AcePanel
      sessionsList={ctx.sessions.list}
      send={(text: string): Promise<boolean> => sendCommand(ctx, text)}
      run={(workspace: string, workflow: string, values: Record<string, string>): Promise<{ ok: boolean; message: string }> =>
        runWorkflow(ctx, workspace, workflow, values)
      }
    />,
  )
  ctx.effect(() => () => {
    root.unmount()
    host.remove()
  }, 'ace-harness: panel')

  // Slash-menu trigger: typing `/workflow` offers the workflow list for
  // keyboard pick-and-run. The service is optional (headless client tests).
  const inputTriggers = ctx.get('inputTriggers') as
    | { registerSource(source: InputTriggerSource): () => void }
    | undefined
  if (inputTriggers) {
    ctx.effect(
      () => inputTriggers.registerSource(workflowTriggerSource()),
      'ace-harness: workflow trigger source',
    )
  }
}
