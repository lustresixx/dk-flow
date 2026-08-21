/**
 * Self-loop edge: a transition whose source and target are the same state.
 * React Flow's default bezier self-loop renders as a small, easy-to-miss arc,
 * so this draws an explicit closed loop — up from the source handle, over the
 * top of the node, and back down to the target handle — with the label above.
 */
import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react'

/** Height of the loop arc above the node. */
const LOOP_GAP = 60

export function SelfLoopEdge(props: EdgeProps): JSX.Element {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    markerEnd,
    style,
    label,
    labelStyle,
    labelBgStyle,
    labelBgPadding,
    labelBgBorderRadius,
  } = props
  // A cubic bezier whose control points sit at the loop apex: up from the
  // source, across the top, and back down into the target — one closed loop.
  const topY = Math.min(sourceY, targetY) - LOOP_GAP
  const path = `M ${sourceX} ${sourceY} C ${sourceX} ${topY} ${targetX} ${topY} ${targetX} ${targetY}`
  const labelX = (sourceX + targetX) / 2
  const labelY = topY - 8
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {label !== undefined && label !== '' ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -100%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
              ...(labelStyle ?? {}),
              ...(labelBgStyle !== undefined ? { background: labelBgStyle.fill } : {}),
              ...(labelBgPadding !== undefined
                ? { padding: `${labelBgPadding[1]}px ${labelBgPadding[0]}px` }
                : { padding: '2px 6px' }),
              ...(labelBgBorderRadius !== undefined
                ? { borderRadius: labelBgBorderRadius }
                : { borderRadius: 6 }),
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}
