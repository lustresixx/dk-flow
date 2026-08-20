/**
 * The live run sidebar: a docked panel that appears while a workflow runs,
 * showing the state-machine diagram with live verdict coloring, the current
 * node highlight, and the edges between states. The progress and current
 * state live in an overlay chip on the canvas.
 * Run discovery happens in the launcher; this panel streams the given run.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
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
      <Handle type="target" position={Position.Left} className={styles.handle} />
      {data.current ? <span className={styles.runningBadge}>执行中</span> : null}
      {data.isInitial ? <span className={styles.badge}>初始</span> : null}
      {data.isFinal ? <span className={styles.badgeFinal}>终止</span> : null}
      <span className={styles.nodeName}>{data.name}</span>
      {data.verdict ? (
        <span className={styles.nodeVerdict}>{data.verdict === 'success' || data.verdict === 'pass' ? '✓' : data.verdict === 'fail' ? '✗' : '?'}</span>
      ) : null}
      <Handle type="source" position={Position.Right} className={styles.handle} />
    </div>
  )
}

const nodeTypes = { liveState: LiveStateNode }

export interface LiveRunPanelProps {
  /** Interesting run discovered by the launcher, or null when idle. */
  runId: string | null
}

export function LiveRunPanel(props: LiveRunPanelProps): JSX.Element | null {
  const { runId } = props
  const [snapshot, setSnapshot] = useState<StreamSnapshotDto | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const seqRef = useRef(0)

  // Stream the selected run; reset whenever the run changes or goes idle.
  useEffect(() => {
    if (runId === null) {
      setSnapshot(null)
      seqRef.current = 0
      return
    }
    if (dismissed === runId) return
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
  }, [runId, dismissed])

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
        style: { stroke: color, strokeWidth: 2 },
        labelStyle: { fill: '#e5e7eb', fontSize: 10, fontWeight: 600 },
        labelBgStyle: { fill: '#1f2937', fillOpacity: 0.95 },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 6,
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
              <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}>
                <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} />
                <Controls showInteractive={false} />
              </ReactFlow>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
