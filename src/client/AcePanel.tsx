/**
 * The workbench launcher plus the live run sidebar: a floating button (with
 * the ACE logo) opens the full-page workbench. Run discovery lives here; the
 * launcher shows a live badge while a run is active or recently finished,
 * and the sidebar receives the selected run id.
 *
 * Session gating (mirrors the AgentTeams activity floater): the sidebar and
 * the launcher badge follow ONLY the session that started the run — a run
 * owned by another session, an API-synthetic run (null parent), or no open
 * session at all never pops the panel.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ObservableSnapshot, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { LiveRunPanel } from './LiveRunPanel.tsx'
import { Workbench } from './Workbench.tsx'
import { ACTIVE_STATUSES, route } from './run-meta.ts'
import { selectRun, sessionRuns, type RunSelection, type SelectableRun } from './run-selection.ts'
import styles from './AcePanel.module.css'

const LOGO = '/plugins/dsh-ace-harness/assets/ace-logo.png'
const STATE_ROUTE = route('state')

const RECENT_MS = 2 * 60_000
const LAST_RUN_KEY = 'ace-harness:lastRun'

export interface AcePanelProps {
  /** Reactive session list: `current` gates which runs may pop the sidebar. */
  sessionsList: ObservableSnapshot<SessionListState>
  send: (text: string) => Promise<boolean>
  /** Start a run via the REST route (structured values, no flag parsing). */
  run: (workspace: string, workflow: string, values: Record<string, string>) => Promise<{ ok: boolean; message: string }>
}

interface RunRow extends SelectableRun {
  finishedAt: string | null
  parentSessionId: string | null
}

export function AcePanel(props: AcePanelProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<RunSelection>({ runId: null, active: false })
  const current = useSyncExternalStore(
    props.sessionsList.subscribe,
    props.sessionsList.getSnapshot,
  ).current as string | undefined
  /** Latest owned runs for the open session, kept for instant re-selection. */
  const ownedRef = useRef<readonly RunRow[]>([])
  const currentRef = useRef(current)
  useEffect(() => {
    currentRef.current = current
  }, [current])

  // Re-select from the owned runs; shared by the poll tick and the
  // session-switch effect so switching conversations re-gates immediately.
  const reselect = (runs: readonly RunRow[]): void => {
    setSelected((previous) => {
      const remembered = window.sessionStorage.getItem(LAST_RUN_KEY)
      const next = selectRun(previous, remembered, runs)
      if (next.runId !== null && next.runId !== previous.runId) {
        window.sessionStorage.setItem(LAST_RUN_KEY, next.runId)
      }
      if (next.runId === null) {
        window.sessionStorage.removeItem(LAST_RUN_KEY)
      }
      return next
    })
  }

  // Switching sessions hides another session's run at once — the panel must
  // never linger over a conversation that did not start it. Layout effect so
  // the stale run clears before paint, not a frame later.
  useLayoutEffect(() => {
    ownedRef.current = []
    reselect([])
  }, [current])

  // Discover interesting runs owned by the open session: active ones plus
  // recently finished ones. Re-attaches fast after a page reload.
  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      try {
        const response = await fetch(STATE_ROUTE, { cache: 'no-store' })
        if (!response.ok) return
        const state = (await response.json()) as { workspaces: { runs: RunRow[] }[] }
        const now = Date.now()
        const owned = sessionRuns(
          state.workspaces.flatMap((workspace) => workspace.runs),
          currentRef.current,
        )
        const runs = owned
          .filter((run) => {
            if (ACTIVE_STATUSES.has(run.status)) return true
            const finished = Date.parse(run.finishedAt ?? '')
            return Number.isFinite(finished) && now - finished < RECENT_MS
          })
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        if (!alive) return
        ownedRef.current = runs
        reselect(runs)
      } catch {
        // Best-effort discovery; the next tick retries.
      }
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, 1500)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  return (
    <>
      {/* The full-page workbench supersedes the floating sidebar: suspend it
          (kept mounted so dismiss/collapse memory survives) while open. */}
      <LiveRunPanel runId={selected.runId} suspended={open} />
      {open ? (
        <Workbench send={props.send} run={props.run} onClose={() => { setOpen(false) }} />
      ) : (
        <button type="button" className={styles.launcher} onClick={() => { setOpen(true) }}>
          <img src={LOGO} alt="" className={styles.launcherLogo} />
          <span>工作流</span>
          {selected.runId !== null && selected.active ? (
            <span className={styles.liveDot} title="有工作流正在运行" />
          ) : selected.runId !== null ? (
            <span className={styles.doneDot} title="最近一次运行已结束" />
          ) : null}
        </button>
      )}
    </>
  )
}
