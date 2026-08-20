/**
 * The workbench launcher plus the live run sidebar: a floating button (with
 * the ACE logo) opens the full-page workbench. Run discovery lives here; the
 * launcher shows a live badge while a run is active or recently finished,
 * and the sidebar receives the selected run id.
 */
import { useEffect, useState } from 'react'
import { LiveRunPanel } from './LiveRunPanel.tsx'
import { Workbench } from './Workbench.tsx'
import styles from './AcePanel.module.css'

const LOGO = '/plugins/dsh-ace-harness/assets/ace-logo.png'
const STATE_ROUTE = '/plugins/dsh-ace-harness/state'

const ACTIVE_STATUSES = new Set(['preparing', 'running', 'waiting-human'])
const RECENT_MS = 2 * 60_000

export interface AcePanelProps {
  currentSessionId: () => string | undefined
  send: (text: string) => Promise<boolean>
}

interface RunRow {
  runId: string
  status: string
  startedAt: string
  finishedAt: string | null
}

export function AcePanel(props: AcePanelProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [runId, setRunId] = useState<string | null>(null)
  void props.currentSessionId

  // Discover interesting runs: active ones plus recently finished ones.
  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      try {
        const response = await fetch(STATE_ROUTE, { cache: 'no-store' })
        if (!response.ok) return
        const state = (await response.json()) as { workspaces: { runs: RunRow[] }[] }
        const now = Date.now()
        const runs = state.workspaces
          .flatMap((workspace) => workspace.runs)
          .filter((run) => {
            if (ACTIVE_STATUSES.has(run.status)) return true
            const finished = Date.parse(run.finishedAt ?? '')
            return Number.isFinite(finished) && now - finished < RECENT_MS
          })
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        if (!alive) return
        setRunId((current) => {
          if (current !== null && runs.some((run) => run.runId === current)) return current
          const active = runs.find((run) => ACTIVE_STATUSES.has(run.status))
          return active?.runId ?? (runs[0]?.runId ?? null)
        })
      } catch {
        // Best-effort discovery; the next tick retries.
      }
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, 3000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  return (
    <>
      <LiveRunPanel runId={runId} />
      {open ? (
        <Workbench send={props.send} onClose={() => { setOpen(false) }} />
      ) : (
        <button type="button" className={styles.launcher} onClick={() => { setOpen(true) }}>
          <img src={LOGO} alt="" className={styles.launcherLogo} />
          <span>工作流</span>
          {runId !== null ? <span className={styles.liveDot} title="有工作流运行" /> : null}
        </button>
      )}
    </>
  )
}
