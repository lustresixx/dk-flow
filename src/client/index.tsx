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

export function apply(ctx: ClientContext): void {
  const host = document.createElement('div')
  host.dataset.aceHarnessHost = ''
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(
    <AcePanel
      currentSessionId={(): string | undefined => ctx.sessions.list.getSnapshot().current}
      send={(text: string): Promise<boolean> => sendCommand(ctx, text)}
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
