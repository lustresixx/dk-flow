/**
 * The visual workflow editor: a React Flow canvas over the workflow states
 * and verdict transitions, with a side inspector for states, steps, and
 * transitions. Saves through the host workflows route, which validates with
 * the same DSL the runtime uses.
 */
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type EdgeChange,
  type NodeChange,
  type NodeProps,
  type Connection,
  type OnNodesChange,
  type OnEdgesChange,
} from '@xyflow/react'
import { useCallback, useMemo, useState } from 'react'
import {
  configToGraph,
  configToYaml,
  draftToStep,
  graphToConfig,
  newState,
  replaceSteps,
  stepToDraft,
  yamlToConfig,
  type StateNode,
  type StepDraft,
  type TransitionEdge,
} from './workflow-model.ts'
import type { StateTransition, WorkflowConfig } from '../dsl/types.js'
import styles from './WorkflowEditor.module.css'
import '@xyflow/react/dist/style.css'

const VERDICTS = ['pass', 'conditional_pass', 'fail'] as const
const ROLES = ['', 'defender', 'attacker', 'judge'] as const

/** Custom state node rendered on the canvas. */
function AceStateNode(props: NodeProps<StateNode>): JSX.Element {
  const { data } = props
  const state = data.state
  return (
    <div className={styles.flowNode} data-selected={props.selected ? 'true' : 'false'}>
      <Handle type="target" position={Position.Left} className={styles.handle} />
      <div className={styles.flowNodeTitle}>
        {state.isInitial ? <span className={styles.badge}>初始</span> : null}
        {state.isFinal ? <span className={styles.badge}>终止</span> : null}
        <span className={styles.flowNodeName}>{state.name}</span>
      </div>
      <div className={styles.flowNodeMeta}>
        {state.steps.length} 步
        {state.reviewPolicy?.mode === 'adversarial' ? ' · 对抗' : ''}
        {state.requireHumanApproval ? ' · 人工' : ''}
      </div>
      <Handle type="source" position={Position.Right} className={styles.handle} />
    </div>
  )
}

const nodeTypes = { aceState: AceStateNode }

export interface WorkflowEditorProps {
  initialYaml: string
  workspacePath: string
  fileName: string
  agentNames: string[]
  onClose: () => void
  onSaved: () => void
}

export function WorkflowEditor(props: WorkflowEditorProps): JSX.Element {
  const baseConfig = useMemo(() => yamlToConfig(props.initialYaml), [props.initialYaml])
  const initialGraph = useMemo(() => configToGraph(baseConfig), [baseConfig])
  const [nodes, setNodes, onNodesChangeRaw] = useNodesState<StateNode>(initialGraph.nodes)
  const [edges, setEdges, onEdgesChangeRaw] = useEdgesState<TransitionEdge>(initialGraph.edges)
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)

  const config = useMemo(() => baseConfig, [baseConfig])

  const onNodesChange: OnNodesChange<StateNode> = useCallback(
    (changes: NodeChange<StateNode>[]) => {
      onNodesChangeRaw(changes)
      const selected = changes.find((change) => change.type === 'select')
      if (selected?.type === 'select' && selected.selected && selected.id !== selectedNode) {
        setSelectedNode(selected.id)
        setSelectedEdge(null)
      }
    },
    [onNodesChangeRaw, selectedNode],
  )

  const onEdgesChange: OnEdgesChange<TransitionEdge> = useCallback(
    (changes: EdgeChange<TransitionEdge>[]) => {
      onEdgesChangeRaw(changes)
      const selected = changes.find((change) => change.type === 'select')
      if (selected?.type === 'select' && selected.selected && selected.id !== selectedEdge) {
        setSelectedEdge(selected.id)
        setSelectedNode(null)
      }
    },
    [onEdgesChangeRaw, selectedEdge],
  )

  const onConnect = useCallback(
    (connection: Connection): void => {
      const transition: StateTransition = {
        to: connection.target ?? '',
        condition: { verdict: 'pass' },
        priority: 100,
      }
      const edge: TransitionEdge = {
        id: `e-${connection.source}-${connection.target}-${Date.now()}`,
        source: connection.source ?? '',
        target: connection.target ?? '',
        label: 'pass',
        data: { transition },
      }
      setEdges((current) => addEdge(edge, current))
    },
    [setEdges],
  )

  const addState = useCallback((): void => {
    const name = `状态${nodes.length + 1}`
    const state = newState(nodes, name)
    const node: StateNode = {
      id: name,
      type: 'aceState',
      position: state.position ?? { x: 0, y: 0 },
      data: { state },
    }
    setNodes((current) => [...current, node])
    setSelectedNode(name)
    setSelectedEdge(null)
  }, [nodes.length, setNodes])

  const updateNode = useCallback(
    (id: string, updater: (node: StateNode) => StateNode): void => {
      setNodes((current) => current.map((node) => (node.id === id ? updater(node) : node)))
    },
    [setNodes],
  )

  const deleteNode = useCallback(
    (id: string): void => {
      setNodes((current) => current.filter((node) => node.id !== id))
      setEdges((current) => current.filter((edge) => edge.source !== id && edge.target !== id))
      setSelectedNode(null)
    },
    [setNodes, setEdges],
  )

  const updateEdge = useCallback(
    (id: string, updater: (edge: TransitionEdge) => TransitionEdge): void => {
      setEdges((current) => current.map((edge) => (edge.id === id ? updater(edge) : edge)))
    },
    [setEdges],
  )

  const deleteEdge = useCallback(
    (id: string): void => {
      setEdges((current) => current.filter((edge) => edge.id !== id))
      setSelectedEdge(null)
    },
    [setEdges],
  )

  const validateNames = useCallback((): string | null => {
    const names = nodes.map((node) => node.data.state.name)
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index)
    if (duplicates.length > 0) return `状态名重复：${[...new Set(duplicates)].join('、')}`
    const initials = nodes.filter((node) => node.data.state.isInitial)
    if (initials.length !== 1) return `必须且只能有一个初始状态（当前 ${initials.length} 个）`
    return null
  }, [nodes])

  const save = useCallback(async (): Promise<void> => {
    const problem = validateNames()
    if (problem) {
      setNameError(problem)
      return
    }
    setNameError(null)
    setSaving(true)
    setSaveError(null)
    try {
      const next = graphToConfig(nodes, edges, config)
      const yaml = configToYaml(next)
      const response = await fetch(
        `/plugins/dsh-ace-harness/workflows/${encodeURIComponent(props.fileName)}?workspace=${encodeURIComponent(props.workspacePath)}`,
        { method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: yaml },
      )
      if (!response.ok) {
        throw new Error(await response.text())
      }
      props.onSaved()
    } catch (error) {
      setSaveError((error as Error).message)
    } finally {
      setSaving(false)
    }
  }, [validateNames, nodes, edges, config, props])

  const node = nodes.find((candidate) => candidate.id === selectedNode)
  const edge = edges.find((candidate) => candidate.id === selectedEdge)

  return (
    <div className={styles.overlay}>
      <header className={styles.toolbar}>
        <span className={styles.title}>编排工作流 — {props.fileName}</span>
        <button type="button" className={styles.toolButton} onClick={addState}>
          添加状态
        </button>
        <button type="button" className={styles.saveButton} disabled={saving} onClick={() => { void save() }}>
          {saving ? '保存中…' : '保存'}
        </button>
        <button type="button" className={styles.toolButton} onClick={props.onClose}>
          关闭
        </button>
      </header>
      {saveError || nameError ? (
        <div className={styles.errorBar}>{nameError ?? saveError}</div>
      ) : null}
      <div className={styles.layout}>
        <div className={styles.canvas}>
          <ReactFlow<StateNode, TransitionEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_event, clicked) => {
              setSelectedNode(clicked.id)
              setSelectedEdge(null)
            }}
            onEdgeClick={(_event, clicked) => {
              setSelectedEdge(clicked.id)
              setSelectedNode(null)
            }}
            onPaneClick={() => {
              setSelectedNode(null)
              setSelectedEdge(null)
            }}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>
        <aside className={styles.inspector}>
          {node ? (
            <StateInspector
              key={node.id}
              node={node}
              agentNames={props.agentNames}
              onChange={(updated) => { updateNode(node.id, () => updated) }}
              onDelete={() => { deleteNode(node.id) }}
            />
          ) : edge ? (
            <TransitionInspector
              key={edge.id}
              edge={edge}
              onChange={(updated) => { updateEdge(edge.id, () => updated) }}
              onDelete={() => { deleteEdge(edge.id) }}
            />
          ) : (
            <div className={styles.inspectorEmpty}>
              选择状态编辑其步骤与属性；拖动节点右侧圆点到另一节点可创建转移边。
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

function StateInspector(props: {
  node: StateNode
  agentNames: string[]
  onChange: (node: StateNode) => void
  onDelete: () => void
}): JSX.Element {
  const { node } = props
  const state = node.data.state
  const drafts = state.steps.map(stepToDraft)
  const setState = (patch: Partial<typeof state>): void => {
    props.onChange({ ...node, data: { state: { ...state, ...patch } } })
  }
  const setDrafts = (next: StepDraft[]): void => {
    setState({ steps: next.map(draftToStep) })
  }
  return (
    <div className={styles.inspectorBody}>
      <h3 className={styles.inspectorTitle}>状态</h3>
      <label className={styles.field}>
        <span className={styles.label}>名称</span>
        <input
          type="text"
          value={state.name}
          onChange={(event) => {
            const name = event.target.value
            props.onChange({ ...node, id: name, data: { state: { ...state, name } } })
          }}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>说明</span>
        <input
          type="text"
          value={state.description ?? ''}
          onChange={(event) => { setState({ description: event.target.value }) }}
        />
      </label>
      <div className={styles.checkRow}>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={state.isInitial}
            onChange={(event) => { setState({ isInitial: event.target.checked }) }}
          />
          初始状态
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={state.isFinal}
            onChange={(event) => { setState({ isFinal: event.target.checked }) }}
          />
          终止状态
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={state.requireHumanApproval ?? false}
            onChange={(event) => { setState({ requireHumanApproval: event.target.checked }) }}
          />
          人工批准
        </label>
      </div>
      <label className={styles.field}>
        <span className={styles.label}>最大自转移次数</span>
        <input
          type="number"
          min={1}
          max={100}
          value={state.maxSelfTransitions ?? 3}
          onChange={(event) => {
            setState({ maxSelfTransitions: Number(event.target.value) || undefined })
          }}
        />
      </label>
      <h4 className={styles.subTitle}>步骤（{drafts.length}）</h4>
      <ol className={styles.stepList}>
        {drafts.map((draft, index) => (
          <StepEditor
            key={draft.id}
            draft={draft}
            agentNames={props.agentNames}
            onChange={(next) => {
              const updated = [...drafts]
              updated[index] = next
              setDrafts(updated)
            }}
            onRemove={() => { setDrafts(drafts.filter((_d, i) => i !== index)) }}
            onMoveUp={() => {
              if (index === 0) return
              const updated = [...drafts]
              ;[updated[index - 1], updated[index]] = [updated[index]!, updated[index - 1]!]
              setDrafts(updated)
            }}
          />
        ))}
      </ol>
      <button
        type="button"
        className={styles.addStep}
        onClick={() => {
          setDrafts([
            ...drafts,
            { id: Math.random().toString(36).slice(2, 10), name: `步骤${drafts.length + 1}`, agent: props.agentNames[0] ?? '', role: '', task: '', type: 'agent', workflowRef: '', parallelGroup: '' },
          ])
        }}
      >
        + 添加步骤
      </button>
      <button type="button" className={styles.deleteButton} onClick={props.onDelete}>
        删除状态
      </button>
    </div>
  )
}

function StepEditor(props: {
  draft: StepDraft
  agentNames: string[]
  onChange: (draft: StepDraft) => void
  onRemove: () => void
  onMoveUp: () => void
}): JSX.Element {
  const { draft } = props
  const set = (patch: Partial<StepDraft>): void => props.onChange({ ...draft, ...patch })
  return (
    <li className={styles.stepCard}>
      <div className={styles.stepHead}>
        <input
          className={styles.stepName}
          type="text"
          value={draft.name}
          placeholder="步骤名"
          onChange={(event) => { set({ name: event.target.value }) }}
        />
        <select value={draft.role} onChange={(event) => { set({ role: event.target.value as StepDraft['role'] }) }}>
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {role === '' ? '角色' : role}
            </option>
          ))}
        </select>
      </div>
      <select value={draft.type} onChange={(event) => { set({ type: event.target.value as StepDraft['type'] }) }}>
        <option value="agent">Agent 步骤</option>
        <option value="subworkflow">子工作流步骤</option>
      </select>
      {draft.type === 'agent' ? (
        <select value={draft.agent} onChange={(event) => { set({ agent: event.target.value }) }}>
          {props.agentNames.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          placeholder="子工作流配置（文件名/模板 id）"
          value={draft.workflowRef}
          onChange={(event) => { set({ workflowRef: event.target.value }) }}
        />
      )}
      <textarea
        rows={2}
        placeholder="任务描述"
        value={draft.task}
        onChange={(event) => { set({ task: event.target.value }) }}
      />
      <div className={styles.stepFoot}>
        <input
          type="text"
          placeholder="parallelGroup（留空为串行）"
          value={draft.parallelGroup}
          onChange={(event) => { set({ parallelGroup: event.target.value }) }}
        />
        <button type="button" onClick={props.onMoveUp}>↑</button>
        <button type="button" className={styles.stepRemove} onClick={props.onRemove}>×</button>
      </div>
    </li>
  )
}

function TransitionInspector(props: {
  edge: TransitionEdge
  onChange: (edge: TransitionEdge) => void
  onDelete: () => void
}): JSX.Element {
  const { edge } = props
  const transition = edge.data?.transition ?? { to: edge.target, condition: {}, priority: 100 }
  const setTransition = (patch: Partial<StateTransition>): void => {
    props.onChange({ ...edge, data: { transition: { ...transition, ...patch } } })
  }
  return (
    <div className={styles.inspectorBody}>
      <h3 className={styles.inspectorTitle}>转移：{edge.source} → {edge.target}</h3>
      <label className={styles.field}>
        <span className={styles.label}>触发 verdict</span>
        <select
          value={transition.condition.verdict ?? ''}
          onChange={(event) => {
            const verdict = event.target.value
            setTransition({ condition: { ...transition.condition, verdict: verdict === '' ? undefined : (verdict as 'pass' | 'conditional_pass' | 'fail') } })
          }}
        >
          <option value="">无条件</option>
          {VERDICTS.map((verdict) => (
            <option key={verdict} value={verdict}>{verdict}</option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        <span className={styles.label}>标签</span>
        <input
          type="text"
          value={transition.label ?? ''}
          onChange={(event) => {
            setTransition({ label: event.target.value })
            props.onChange({ ...edge, label: event.target.value, data: { transition: { ...transition, label: event.target.value } } })
          }}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>优先级（小者先匹配）</span>
        <input
          type="number"
          value={transition.priority ?? 100}
          onChange={(event) => { setTransition({ priority: Number(event.target.value) || 100 }) }}
        />
      </label>
      <button type="button" className={styles.deleteButton} onClick={props.onDelete}>
        删除转移
      </button>
    </div>
  )
}
