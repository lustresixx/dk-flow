/**
 * Client-side workflow model: converts a workflow config to and from React
 * Flow nodes/edges, with YAML round-tripping through the shared DSL modules
 * (bundled into the client, so parsing/validation matches the host exactly).
 */
import type { Edge, Node } from '@xyflow/react'
import { stringify } from 'yaml'
import { parseWorkflowYaml } from '../dsl/load.js'
import type { StateMachineState, StateTransition, WorkflowConfig, WorkflowStep } from '../dsl/types.js'

/** Node payload: the live state object plus helpers. */
export interface StateNodeData extends Record<string, unknown> {
  state: StateMachineState
}

/** Edge payload: the live transition object. */
export interface TransitionEdgeData extends Record<string, unknown> {
  transition: StateTransition
}

export type StateNode = Node<StateNodeData>
export type TransitionEdge = Edge<TransitionEdgeData>

/** Parse a workflow YAML document with the host DSL validator. */
export function yamlToConfig(text: string): WorkflowConfig {
  return parseWorkflowYaml(text)
}

/** Serialize a workflow config back to YAML. */
export function configToYaml(config: WorkflowConfig): string {
  return stringify(config as unknown as Record<string, unknown>)
}

/** Default grid position for auto-placed states. */
const AUTO_COLUMNS = 5
const AUTO_SPACING_X = 260
const AUTO_SPACING_Y = 180

/** Verdict edge colors on the canvas. */
const EDGE_COLORS: Record<string, string> = {
  success: '#34d399',
  pass: '#34d399',
  fail: '#f87171',
  conditional_pass: '#fbbf24',
}

/** Convert a config into React Flow nodes and edges (states + transitions). */
export function configToGraph(config: WorkflowConfig): { nodes: StateNode[]; edges: TransitionEdge[] } {
  const nodes: StateNode[] = config.workflow.states.map((state, index) => ({
    id: state.name,
    type: 'aceState',
    position: state.position ?? {
      x: (index % AUTO_COLUMNS) * AUTO_SPACING_X,
      y: Math.floor(index / AUTO_COLUMNS) * AUTO_SPACING_Y,
    },
    data: { state },
  }))
  const edges: TransitionEdge[] = []
  for (const state of config.workflow.states) {
    for (const transition of state.transitions) {
      const verdict = transition.condition.verdict ?? ''
      const color = EDGE_COLORS[verdict] ?? '#6b7280'
      edges.push({
        id: `e-${state.name}-${transition.to}-${edges.length}`,
        source: state.name,
        target: transition.to,
        label: transition.label ?? verdict ?? '',
        style: { stroke: color, strokeWidth: 2 },
        labelStyle: { fill: '#f3f4f6', fontSize: 11, fontWeight: 600 },
        labelBgStyle: { fill: color, fillOpacity: 0.9 },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 6,
        data: { transition },
      })
    }
  }
  return { nodes, edges }
}

/** Rebuild a workflow config from the current graph and a base document. */
export function graphToConfig(
  nodes: readonly StateNode[],
  edges: readonly TransitionEdge[],
  base: WorkflowConfig,
): WorkflowConfig {
  const states: StateMachineState[] = nodes.map((node) => {
    const state: StateMachineState = {
      ...node.data.state,
      position: { x: node.position.x, y: node.position.y },
      transitions: [],
    }
    return state
  })
  const byName = new Map(states.map((state) => [state.name, state]))
  for (const edge of edges) {
    const transition = edge.data?.transition
    if (!transition) continue
    const source = byName.get(edge.source)
    if (source && byName.has(edge.target)) {
      source.transitions.push({ ...transition, to: edge.target })
    }
  }
  return {
    ...base,
    workflow: {
      ...base.workflow,
      states,
    },
  }
}

/** One editable step row. */
export interface StepDraft {
  id: string
  name: string
  agent: string
  role: '' | 'attacker' | 'defender' | 'judge'
  task: string
  type: 'agent' | 'script' | 'subworkflow'
  workflowRef: string
  script: string
  parallelGroup: string
}

/** Convert a step object into an editable draft. */
export function stepToDraft(step: WorkflowStep): StepDraft {
  return {
    id: step.id ?? Math.random().toString(36).slice(2, 10),
    name: step.name,
    agent: step.agent ?? '',
    role: step.role ?? '',
    task: step.task ?? '',
    type: step.type ?? 'agent',
    workflowRef: step.workflow ?? step.subworkflow?.configFile ?? '',
    script: step.script ?? '',
    parallelGroup: step.parallelGroup ?? '',
  }
}

/** Convert a draft back into a workflow step. */
export function draftToStep(draft: StepDraft): WorkflowStep {
  if (draft.type === 'subworkflow') {
    return {
      name: draft.name,
      type: 'subworkflow',
      workflow: draft.workflowRef,
      role: draft.role === '' ? undefined : draft.role,
      parallelGroup: draft.parallelGroup === '' ? undefined : draft.parallelGroup,
    }
  }
  if (draft.type === 'script') {
    return {
      name: draft.name,
      type: 'script',
      script: draft.script,
      parallelGroup: draft.parallelGroup === '' ? undefined : draft.parallelGroup,
    }
  }
  return {
    name: draft.name,
    agent: draft.agent,
    task: draft.task,
    role: draft.role === '' ? undefined : draft.role,
    parallelGroup: draft.parallelGroup === '' ? undefined : draft.parallelGroup,
  }
}

/** Replace one state's steps from drafts, keeping step order. */
export function replaceSteps(state: StateMachineState, drafts: readonly StepDraft[]): StateMachineState {
  return { ...state, steps: drafts.map(draftToStep) }
}

/** A new empty state placed to the right of existing nodes. */
export function newState(nodes: readonly StateNode[], name: string): StateMachineState {
  const maxX = nodes.reduce((max, node) => Math.max(max, node.position.x), 0)
  const maxY = nodes.reduce((max, node) => Math.max(max, node.position.y), 0)
  return {
    name,
    description: '',
    steps: [],
    transitions: [],
    position: { x: maxX + AUTO_SPACING_X, y: Math.max(0, maxY) },
    isInitial: nodes.length === 0,
    isFinal: false,
  }
}
