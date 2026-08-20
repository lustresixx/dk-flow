/**
 * The live run sidebar: a docked panel that appears while a workflow runs,
 * showing the state-machine diagram with live verdict coloring, the current
 * step, and the streaming assistant output of the active subagent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import type { StreamSnapshotDto } from './types.ts'
import styles from './LiveRunPanel.module.css'
import '@xyflow/react/dist/style.css'

const STATE_ROUTE = '/plugins/dsh-ace-harness/state'
const STREAM_ROUTE = '/plugins/dsh-ace-harness/stream'

const STATUS_TEXT: Record<string, string> = {
  preparing: '准备中',
  running: '运行中',
  'waiting-human': '等待人工决策',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
  crashed: '崩溃',
}

const VERDICT_TEXT: Record<string, string> = {
  success: '成功',
  pass: '成功',
  fail: '失败',
  conditional_pass: '有条件通过',
}

const ACTIVE_STATUSES = new Set(['preparing', 'running', 'waiting-human'])

/** Runs finished this recently still auto-show so fast workflows stay visible. */
const RECENT_MS = 2 * 60_000

const EDGE_COLORS: Record<string, string> = {
  success: '#34d399',
  pass: '#34d399',
  fail: '#f87171',
  conditional_pass: '#fbbf24',
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
  return (
    <div
      className={styles.diagramNode}
      data-verdict={data.verdict ?? 'pending'}
      data-current={data.current ? 'true' : 'false'}
    >
      {data.isInitial ? <span className={styles.badge}>初始</span> : null}
      {data.isFinal ? <span className={styles.badgeFinal}>终止</span> : null}
      <span className={styles.nodeName}>{data.name}</span>
      {data.verdict ? (
        <span className={styles.nodeVerdict}>{VERDICT_TEXT[data.verdict] ?? data.verdict}</span>
      ) : null}
    </div>
  )
}

const nodeTypes = { liveState: LiveStateNode }

export function LiveRunPanel(): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<StreamSnapshotDto | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const seqRef = useRef(0)
  const textRef = useRef<HTMLPreElement | null>(null)

  // Discover interesting runs from the state route: active ones, plus runs
  // that finished within the grace window so fast workflows stay visible.
  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      try {
        const response = await fetch(STATE_ROUTE, { cache: 'no-store' })
        if (!response.ok) return
        const state = (await response.json()) as {
          workspaces: { runs: { runId: string; status: string; startedAt: string; finishedAt: string | null }[] }[]
        }
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
        if (runs.length === 0) {
          setRunId(null)
          setSnapshot(null)
          setDismissed(null)
          return
        }
        setRunId((current) => {
          const currentStillShown = runs.some((run) => run.runId === current)
          if (currentStillShown) return current
          const active = runs.find((run) => ACTIVE_STATUSES.has(run.status))
          return active?.runId ?? (runs[0]?.runId ?? null)
        })
      } catch {
        // Polling is best-effort; the next tick retries.
      }
    }
    void tick()
    const timer = window.setInterval(() => { void tick() }, 3000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  // Stream the selected run.
  useEffect(() => {
    if (!runId) return
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
  }, [runId])

  // Auto-scroll the streaming text area.
  useEffect(() => {
    const node = textRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [snapshot?.text])

  const nodes = useMemo<Node<LiveNodeData>[]>(() => {
    if (!snapshot) return []
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
    return snapshot.transitions.map((transition, index) => {
      const color = transition.verdict ? (EDGE_COLORS[transition.verdict] ?? '#6b7280') : '#6b7280'
      return {
        id: `e-${transition.from}-${transition.to}-${index}`,
        source: transition.from,
        target: transition.to,
        label: transition.label ?? transition.verdict ?? '',
        style: { stroke: color, strokeWidth: 1.5 },
        labelStyle: { fill: '#d1d5db', fontSize: 9 },
        labelBgStyle: { fill: '#1f2937', fillOpacity: 0.9 },
      }
    })
  }, [snapshot])

  if (!runId || !snapshot || dismissed === runId) return null
  const progress = snapshot.totalSteps > 0 ? Math.round((snapshot.completedSteps / snapshot.totalSteps) * 100) : 0

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <span className={styles.title} title={snapshot.workflowName}>
          {snapshot.workflowName}
        </span>
        <span className={styles.status} data-status={snapshot.status}>
          {STATUS_TEXT[snapshot.status] ?? snapshot.status}
        </span>
        <button type="button" className={styles.headerButton} onClick={() => { setCollapsed(!collapsed) }}>
          {collapsed ? '□' : '—'}
        </button>
        <button type="button" className={styles.headerButton} onClick={() => { setDismissed(runId) }}>
          ×
        </button>
      </header>
      {!collapsed ? (
        <div className={styles.body}>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${progress}%` }} />
            <span className={styles.progressText}>{snapshot.completedSteps}/{snapshot.totalSteps} 步</span>
          </div>
          <div className={styles.diagram}>
            <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} zoomOnScroll={false} panOnDrag={false}>
              <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} />
            </ReactFlow>
          </div>
          <div className={styles.stepLine}>
            {snapshot.currentStep ? (
              <>
                <span className={styles.stepName}>{snapshot.currentStep}</span>
                {snapshot.agent ? <span className={styles.stepAgent}>{snapshot.agent}</span> : null}
                {snapshot.role && snapshot.role !== 'neutral' ? <span className={styles.stepRole}>{snapshot.role}</span> : null}
              </>
            ) : (
              <span className={styles.stepName}>状态「{snapshot.currentState}」已结束</span>
            )}
          </div>
          <pre ref={textRef} className={styles.streamText}>
            {snapshot.text === '' ? '（该步骤正在执行，输出即将出现…）' : snapshot.text}
          </pre>
        </div>
      ) : null}
    </div>
  )
}
