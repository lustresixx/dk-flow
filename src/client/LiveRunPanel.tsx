/**
 * The live run sidebar: a docked panel that appears while a workflow runs,
 * showing the state-machine diagram with live verdict coloring, the current
 * node highlight, and the edges between states. The progress and current
 * state live in an overlay chip on the canvas.
 *
 * Visual language follows the AgentTeams activity panel: DSH design tokens
 * (theme-aware), compact nodes with a state dot, and edges that highlight
 * the executed path while dimming the branches not taken.
 * Run discovery happens in the launcher; this panel streams the given run.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import type { StreamSnapshotDto } from './types.ts'
import styles from './LiveRunPanel.module.css'
import '@xyflow/react/dist/style.css'

const STREAM_ROUTE = '/plugins/dsh-ace-harness/stream'

/**
 * Root marker announced while the sidebar is expanded (AgentTeams panel
 * form): the web shell owns no top-right slot, so this body-level attribute
 * lets the center conversation column yield room on wide viewports; narrow
 * viewports keep overlay mode.
 */
const PANEL_OPEN_ATTRIBUTE = 'data-ace-harness-panel-open'

const STATUS_TEXT: Record<string, string> = {
  preparing: '准备中',
  running: '运行中',
  'waiting-human': '等待人工决策',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
  crashed: '崩溃',
}

const ACTIVE_STATUSES = new Set(['preparing', 'running', 'waiting-human'])

const STEP_KIND_TEXT: Record<string, string> = {
  agent: 'AI',
  script: '脚本',
  subworkflow: '子工作流',
  llm: '快速LLM',
}

/** Legacy verdict spellings fold onto the modern success/fail pair. */
function normalizeVerdict(verdict: string | null): string | null {
  if (verdict === 'pass') return 'success'
  if (verdict === null) return null
  return verdict
}

/** Live state node rendered on the mini diagram. */
interface LiveNodeData extends Record<string, unknown> {
  name: string
  isInitial: boolean
  isFinal: boolean
  verdict: string | null
  current: boolean
}

function LiveStateNode(props: NodeProps<Node<LiveNodeData>>): JSX.Element {
  const { data } = props
  const verdict = normalizeVerdict(data.verdict)
  return (
    <div
      className={styles.diagramNode}
      data-verdict={verdict ?? 'pending'}
      data-current={data.current ? 'true' : 'false'}
    >
      <Handle type="target" position={Position.Left} className={styles.handle} />
      <span className={styles.nodeDot} aria-hidden />
      <span className={styles.nodeName}>{data.name}</span>
      {data.isInitial ? <span className={styles.badge}>初始</span> : null}
      {data.isFinal ? <span className={styles.badgeFinal}>终止</span> : null}
      {data.current ? <span className={styles.runningBadge}>执行中</span> : null}
      {verdict ? (
        <span className={styles.nodeVerdict} data-verdict={verdict}>
          {verdict === 'success' ? '✓' : verdict === 'fail' ? '✗' : '?'}
        </span>
      ) : null}
      <Handle type="source" position={Position.Right} className={styles.handle} />
    </div>
  )
}

const nodeTypes = { liveState: LiveStateNode }

export interface LiveRunPanelProps {
  /** Interesting run discovered by the launcher, or null when idle. */
  runId: string | null
  /**
   * Hide without unmounting (the full-page workbench owns the screen): no
   * render, no layout-yield marker, no polling — but the snapshot and the
   * user's dismiss/collapse choices survive the suspension.
   */
  suspended?: boolean
}

export function LiveRunPanel(props: LiveRunPanelProps): JSX.Element | null {
  const { runId, suspended = false } = props
  const [snapshot, setSnapshot] = useState<StreamSnapshotDto | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const seqRef = useRef(0)
  const logRef = useRef<HTMLDivElement | null>(null)
  /** Follow the newest output only while the user is pinned to the bottom. */
  const stickRef = useRef(true)

  // Stream the selected run; reset whenever the run changes or goes idle.
  // While suspended (workbench open) polling pauses but state is kept.
  useEffect(() => {
    if (runId === null) {
      setSnapshot(null)
      seqRef.current = 0
      stickRef.current = true
      return
    }
    if (suspended || dismissed === runId) return
    stickRef.current = true
    let alive = true
    const tick = async (): Promise<void> => {
      try {
        const response = await fetch(`${STREAM_ROUTE}?runId=${encodeURIComponent(runId)}`, { cache: 'no-store' })
        if (!response.ok) return
        const next = (await response.json()) as StreamSnapshotDto
        if (!alive) return
        if (next.seq === seqRef.current) return
        seqRef.current = next.seq
        setSnapshot(next)
      } catch {
        // Best-effort polling.
      }
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, 1500)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [runId, dismissed, suspended])

  // Follow the newest output while pinned to the bottom; never fight a
  // user who scrolled up to read earlier entries.
  useEffect(() => {
    const node = logRef.current
    if (node && stickRef.current) node.scrollTop = node.scrollHeight
  }, [snapshot?.stepLog])

  // The sidebar is a body-level floater, so announce its expanded state on
  // documentElement: the conversation column reads the marker from CSS and
  // yields space (AgentTeams panel form), without knowing module class names.
  const expanded = runId !== null && snapshot !== null && dismissed !== runId && !collapsed && !suspended
  useLayoutEffect(() => {
    const root = document.documentElement
    if (expanded) root.setAttribute(PANEL_OPEN_ATTRIBUTE, '')
    else root.removeAttribute(PANEL_OPEN_ATTRIBUTE)
    return () => { root.removeAttribute(PANEL_OPEN_ATTRIBUTE) }
  }, [expanded])

  const nodes = useMemo<Node<LiveNodeData>[]>(() => {    if (!snapshot) return []
    const verdictByState = new Map(snapshot.verdicts.map((item) => [item.state, item.verdict]))
    return snapshot.states.map((state, index) => ({
      id: state.name,
      type: 'liveState',
      position: state.position ?? { x: (index % 4) * 200, y: Math.floor(index / 4) * 120 },
      data: {
        name: state.name,
        isInitial: state.isInitial,
        isFinal: state.isFinal,
        verdict: verdictByState.get(state.name) ?? null,
        current: state.name === snapshot.currentState && ACTIVE_STATUSES.has(snapshot.status),
      },
    }))
  }, [snapshot])

  const edges = useMemo<Edge[]>(() => {
    if (!snapshot) return []
    // Executed-path semantics (AgentTeams active/dimmed): once the source
    // state settled, the branch matching its verdict lights up in the
    // verdict color and every sibling branch dims; untouched branches stay
    // neutral. Unconditional edges count as taken once the source ran.
    const verdictByState = new Map(
      snapshot.verdicts.map((item) => [item.state, normalizeVerdict(item.verdict)]),
    )
    return snapshot.transitions.map((transition, index) => {
      const sourceVerdict = verdictByState.get(transition.from) ?? null
      const edgeVerdict = normalizeVerdict(transition.verdict)
      const taken = sourceVerdict !== null && (edgeVerdict === null || edgeVerdict === sourceVerdict)
      const dimmed = sourceVerdict !== null && !taken
      return {
        id: `e-${transition.from}-${transition.to}-${index}`,
        source: transition.from,
        target: transition.to,
        label: transition.label ?? transition.verdict ?? '',
        className: [
          styles.edge,
          taken ? styles.edgeTaken : '',
          dimmed ? styles.edgeDimmed : '',
          edgeVerdict !== null ? styles[`edge_${edgeVerdict}`] ?? '' : '',
        ].filter(Boolean).join(' ') || undefined,
        labelStyle: { fill: 'var(--dsw-alias-label-secondary)', fontSize: 10, fontWeight: 600 },
        labelBgStyle: { fill: 'var(--dsw-alias-bg-module)', fillOpacity: 0.95 },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 6,
      }
    })
  }, [snapshot])

  if (!runId || !snapshot || dismissed === runId || suspended) return null
  const progress = snapshot.totalSteps > 0 ? Math.round((snapshot.completedSteps / snapshot.totalSteps) * 100) : 0
  const active = ACTIVE_STATUSES.has(snapshot.status)
  const stopRun = async (): Promise<void> => {
    try {
      await fetch('/plugins/dsh-ace-harness/stop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId }),
      })
    } catch {
      // Best-effort; the run registry also stops it on /workflow stop.
    }
  }

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <span className={styles.title} title={snapshot.workflowName}>
          {snapshot.workflowName}
        </span>
        <span className={styles.status} data-status={snapshot.status}>
          {STATUS_TEXT[snapshot.status] ?? snapshot.status}
        </span>
        {active ? (
          <button type="button" className={styles.stopButton} onClick={() => { void stopRun() }}>
            停止
          </button>
        ) : null}
        <button type="button" className={styles.headerButton} onClick={() => { setCollapsed(!collapsed) }}>
          {collapsed ? '□' : '—'}
        </button>
        <button type="button" className={styles.headerButton} onClick={() => { setDismissed(runId) }}>
          ×
        </button>
      </header>
      {!collapsed ? (
        <div className={styles.body}>
          <div className={styles.diagramWrap}>
            <div className={styles.diagramOverlay}>
              <div className={styles.progressRow}>
                <span className={styles.progressChip}>
                  进度 {snapshot.completedSteps}/{snapshot.totalSteps} 步 · {progress}%
                </span>
                <span className={styles.stateChip} data-active={ACTIVE_STATUSES.has(snapshot.status) ? 'true' : 'false'}>
                  {ACTIVE_STATUSES.has(snapshot.status)
                    ? `执行中：${snapshot.currentState || '—'}${snapshot.currentStep ? ` · ${snapshot.currentStep}` : ''}`
                    : `结束：${snapshot.currentState || '—'}`}
                </span>
              </div>
              <div className={styles.miniTrack}>
                <div className={styles.miniFill} style={{ width: `${progress}%` }} />
              </div>
            </div>
            <div className={styles.diagram}>
              <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} zoomOnScroll panOnDrag minZoom={0.4} maxZoom={2.5}>
                <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="var(--dsw-alias-line-strong)" />
                <Controls showInteractive={false} />
              </ReactFlow>
            </div>
          </div>
          <div
            ref={logRef}
            className={styles.stepLog}
            onScroll={() => {
              const node = logRef.current
              if (node) {
                stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40
              }
            }}
          >
            {snapshot.stepLog.length === 0 ? (
              <div className={styles.stepLogEmpty}>（等待第一步开始…）</div>
            ) : (
              snapshot.stepLog.map((entry) => (
                <div key={entry.key} className={styles.stepLogItem} data-finished={entry.finished ? 'true' : 'false'}>
                  <div className={styles.stepLogHead}>
                    <span className={styles.stepLogName}>{entry.step}</span>
                    {entry.agent ? <span className={styles.stepLogAgent}>{entry.agent}</span> : <span className={styles.stepLogAgent}>{STEP_KIND_TEXT[entry.type] ?? entry.type}</span>}
                    {entry.role && entry.role !== 'neutral' ? <span className={styles.stepLogRole}>{entry.role}</span> : null}
                    {entry.finished ? <span className={styles.stepLogDone}>完成</span> : <span className={styles.stepLogLive}>输出中…</span>}
                  </div>
                  <pre className={styles.stepLogText}>
                    {entry.text === '' && !entry.finished ? '（正在执行，输出即将出现…）' : entry.text === '' ? '（无文本输出）' : entry.text}
                  </pre>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
