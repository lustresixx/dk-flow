/**
 * The visual workflow editor pane: a React Flow canvas over the workflow
 * states and verdict transitions, with a side inspector for states, steps
 * (AI / script / subworkflow), and transitions. `WorkflowEditor` wraps the
 * pane as a full-screen overlay; `EditorPane` embeds it into the workbench.
 */
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type NodeProps,
  type OnEdgesChange,
  type OnNodesChange,
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

const VERDICTS = ['success', 'fail'] as const
const ROLES = ['', 'defender', 'attacker', 'judge'] as const
const ISSUE_TYPES = ['design', 'implementation', 'test', 'performance', 'security'] as const
const SEVERITIES = ['critical', 'major', 'minor'] as const

const STEP_TYPE_TEXT: Record<string, string> = {
  agent: 'AI',
  script: '脚本',
  subworkflow: '子流',
  llm: '快速LLM',
}

/** Custom state node rendered on the canvas. */
function AceStateNode(props: NodeProps<StateNode>): JSX.Element {
  const { data } = props
  const state = data.state
  const kinds = new Set<string>()
  for (const step of state.steps) {
    kinds.add(step.type ?? 'agent')
    if (step.role) kinds.add(step.role)
  }
  return (
    <div className={styles.flowNode} data-selected={props.selected ? 'true' : 'false'}>
      <Handle type="target" position={Position.Left} className={styles.handle} />
      <div className={styles.flowNodeTitle}>
        {state.isInitial ? <span className={styles.badge}>初始</span> : null}
        {state.isFinal ? <span className={styles.badgeFinal}>终止</span> : null}
        <span className={styles.flowNodeName}>{state.name}</span>
      </div>
      <div className={styles.flowNodeMeta}>
        {state.steps.length} 步
        {state.reviewPolicy?.mode === 'adversarial' ? ' · 对抗' : ''}
        {state.requireHumanApproval ? ' · 人工' : ''}
      </div>
      <div className={styles.flowNodeKinds}>
        {[...kinds].slice(0, 4).map((kind) => (
          <span key={kind} className={styles.kindBadge}>{STEP_TYPE_TEXT[kind] ?? kind}</span>
        ))}
      </div>
      <Handle type="source" position={Position.Right} className={styles.handle} />
    </div>
  )
}

const nodeTypes = { aceState: AceStateNode }

export interface EditorPaneProps {
  initialYaml: string
  workspacePath: string
  fileName: string
  agentNames: string[]
  onClose: () => void
  onSaved: () => void
}

/** Canvas + inspector + editor toolbar, without the overlay chrome. */
export function EditorPane(props: EditorPaneProps): JSX.Element {
  const baseConfig = useMemo(() => yamlToConfig(props.initialYaml), [props.initialYaml])
  const initialGraph = useMemo(() => configToGraph(baseConfig), [baseConfig])
  const [nodes, setNodes, onNodesChangeRaw] = useNodesState<StateNode>(initialGraph.nodes)
  const [edges, setEdges, onEdgesChangeRaw] = useEdgesState<TransitionEdge>(initialGraph.edges)
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ loading: boolean; text: string } | null>(null)

  const config = useMemo(() => baseConfig, [baseConfig])

  /** Verify one step in isolation: serialize the current graph and run it. */
  const runStepTest = useCallback(
    async (draft: StepDraft): Promise<void> => {
      const stateName = selectedNode
      if (!stateName) return
      setTestResult({ loading: true, text: '验证中…' })
      try {
        const next = graphToConfig(nodes, edges, config)
        const yaml = configToYaml(next)
        const response = await fetch('/plugins/dsh-ace-harness/test-step', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ yaml, state: stateName, step: draft.name, values: {} }),
        })
        const body = (await response.json()) as {
          error?: string
          type?: string
          verdict?: string | null
          outputSummary?: string
          data?: unknown
        }
        if (!response.ok) {
          setTestResult({ loading: false, text: body.error ?? `HTTP ${response.status}` })
          return
        }
        setTestResult({
          loading: false,
          text:
            `[${body.type ?? ''}] verdict: ${body.verdict ?? '无'}\n` +
            `产出：\n${body.outputSummary ?? ''}` +
            (body.data != null ? `\n\n结构化数据：\n${JSON.stringify(body.data, null, 2)}` : ''),
        })
      } catch (error) {
        setTestResult({ loading: false, text: `验证失败：${(error as Error).message}` })
      }
    },
    [nodes, edges, config, selectedNode],
  )

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
        condition: { verdict: 'success' },
        priority: 100,
        label: '成功',
      }
      const edge: TransitionEdge = {
        id: `e-${connection.source}-${connection.target}-${Date.now()}`,
        source: connection.source ?? '',
        target: connection.target ?? '',
        label: '成功',
        style: { stroke: '#34d399', strokeWidth: 2 },
        labelStyle: { fill: '#f3f4f6', fontSize: 11, fontWeight: 600 },
        labelBgStyle: { fill: '#34d399', fillOpacity: 0.9 },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 6,
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
    <div className={styles.pane}>
      <div className={styles.paneToolbar}>
        <button type="button" className={styles.toolButton} onClick={addState}>
          + 添加状态
        </button>
        <span className={styles.paneHint}>拖动节点布局 · 从节点右缘拖线到另一节点创建转移（默认成功，可在边上修改）</span>
        <button type="button" className={styles.saveButton} disabled={saving} onClick={() => { void save() }}>
          {saving ? '保存中…' : '保存'}
        </button>
        <button type="button" className={styles.toolButton} onClick={props.onClose}>
          返回
        </button>
      </div>
      {saveError || nameError ? (
        <div className={styles.errorBar}>{nameError ?? saveError}</div>
      ) : null}
      <div className={styles.paneLayout}>
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
            zoomOnScroll={false}
            panOnScroll
            zoomActivationKeyCode="Control"
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} />
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
              onTestStep={(draft) => { void runStepTest(draft) }}
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
              选择状态编辑其步骤与属性；拖动节点右侧圆点到另一节点可创建转移边（默认「成功」，可在边上改为「失败」）。
            </div>
          )}
          {testResult ? (
            <div className={styles.testResult} data-loading={testResult.loading ? 'true' : 'false'}>
              <pre>{testResult.text}</pre>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  )
}

/** Full-screen overlay wrapper around the editor pane. */
export function WorkflowEditor(props: EditorPaneProps): JSX.Element {
  return (
    <div className={styles.overlay}>
      <EditorPane {...props} />
    </div>
  )
}

function StateInspector(props: {
  node: StateNode
  agentNames: string[]
  onChange: (node: StateNode) => void
  onDelete: () => void
  onTestStep?: (draft: StepDraft) => void
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
      <div className={styles.checkRow}>
        <label className={styles.field}>
          <span className={styles.label}>评审模式（reviewPolicy）</span>
          <select
            value={state.reviewPolicy?.mode ?? 'standard'}
            onChange={(event) => {
              const mode = event.target.value as 'standard' | 'adversarial'
              setState({
                reviewPolicy: {
                  mode,
                  source: 'user',
                  locked: false,
                  confidence: state.reviewPolicy?.confidence ?? 'high',
                  riskSignals: state.reviewPolicy?.riskSignals ?? [],
                  rationale: state.reviewPolicy?.rationale ?? '',
                },
              })
            }}
          >
            <option value="standard">standard（串行步骤内联判定）</option>
            <option value="adversarial">adversarial（defender/attacker/judge 对抗）</option>
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>置信度</span>
          <select
            value={state.reviewPolicy?.confidence ?? 'high'}
            onChange={(event) => {
              const confidence = event.target.value as 'high' | 'medium' | 'low'
              setState({
                reviewPolicy: {
                  mode: state.reviewPolicy?.mode ?? 'standard',
                  source: 'user',
                  locked: false,
                  confidence,
                  riskSignals: state.reviewPolicy?.riskSignals ?? [],
                  rationale: state.reviewPolicy?.rationale ?? '',
                },
              })
            }}
          >
            <option value="high">high</option>
            <option value="medium">medium</option>
            <option value="low">low（强制对抗）</option>
          </select>
        </label>
      </div>
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
            onTest={props.onTestStep ? () => { props.onTestStep!(draft) } : undefined}
          />
        ))}
      </ol>
      <button
        type="button"
        className={styles.addStep}
        onClick={() => {
          setDrafts([
            ...drafts,
            {
              id: Math.random().toString(36).slice(2, 10),
              name: `步骤${drafts.length + 1}`,
              agent: props.agentNames[0] ?? '',
              role: '',
              task: '',
              type: 'agent',
              workflowRef: '',
              script: '// context.requirements 为运行输入，context.priorStepEvidence 为前序产出，context.stepData 为上游结构化数据\n// 必须返回 { output: "...", success: true/false }，可选附带 data（任意 JSON）\nreturn { output: "完成", success: true }',
              scriptFile: '',
              model: '',
              timeoutMinutes: '',
              maxRetries: '',
              backoffMs: '',
              parallelGroup: '',
            },
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
  onTest?: () => void
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
        <select value={draft.type} onChange={(event) => { set({ type: event.target.value as StepDraft['type'] }) }}>
          <option value="agent">AI 步骤</option>
          <option value="llm">快速 LLM</option>
          <option value="script">脚本步骤</option>
          <option value="subworkflow">子工作流</option>
        </select>
      </div>
      {draft.type === 'agent' ? (
        <>
          <select value={draft.agent} onChange={(event) => { set({ agent: event.target.value }) }}>
            {props.agentNames.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          <select value={draft.role} onChange={(event) => { set({ role: event.target.value as StepDraft['role'] }) }}>
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {role === '' ? '角色（可选）' : role}
              </option>
            ))}
          </select>
          <textarea
            rows={4}
            className={styles.taskArea}
            placeholder="任务描述（交给该角色 Agent 的指令）"
            value={draft.task}
            onChange={(event) => { set({ task: event.target.value }) }}
          />
        </>
      ) : draft.type === 'llm' ? (
        <>
          <select value={draft.agent} onChange={(event) => { set({ agent: event.target.value }) }}>
            <option value="">无角色（直接调用，最快）</option>
            {props.agentNames.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          <select value={draft.role} onChange={(event) => { set({ role: event.target.value as StepDraft['role'] }) }}>
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {role === '' ? '角色（可选）' : role}
              </option>
            ))}
          </select>
          <textarea
            rows={3}
            className={styles.taskArea}
            placeholder="单轮任务描述（一次 LLM 调用，不启动子代理、无工具）"
            value={draft.task}
            onChange={(event) => { set({ task: event.target.value }) }}
          />
          <input
            type="text"
            placeholder="model（可选，留空用调用方默认模型）"
            value={draft.model}
            onChange={(event) => { set({ model: event.target.value }) }}
          />
        </>
      ) : draft.type === 'script' ? (
        <>
          <input
            type="text"
            placeholder="scriptFile（可选，与内联二选一；解析顺序：工作区根 → .ace-workflows/scripts/ 收集目录 → 内置库；.js 进沙箱，.py 用 Python）"
            value={draft.scriptFile}
            onChange={(event) => { set({ scriptFile: event.target.value }) }}
          />
          {draft.scriptFile.trim() === '' ? (
            <textarea
              rows={7}
              className={styles.scriptArea}
              spellCheck={false}
              placeholder={'// JavaScript：可用 context.requirements / context.inputs / context.priorStepEvidence / context.stepData\n// 必须返回 { output: "结果文本", success: true }，可选附带 data（任意 JSON）传给下游\nreturn { output: "结果文本", success: true }'}
              value={draft.script}
              onChange={(event) => { set({ script: event.target.value }) }}
            />
          ) : null}
        </>
      ) : (
        <input
          type="text"
          placeholder="子工作流配置（文件名/模板 id）"
          value={draft.workflowRef}
          onChange={(event) => { set({ workflowRef: event.target.value }) }}
        />
      )}
      <div className={styles.stepFoot}>
        <input
          type="text"
          placeholder="parallelGroup（留空为串行）"
          value={draft.parallelGroup}
          onChange={(event) => { set({ parallelGroup: event.target.value }) }}
        />
        <input
          type="number"
          min={1}
          placeholder="超时（分钟，可选）"
          value={draft.timeoutMinutes}
          onChange={(event) => { set({ timeoutMinutes: event.target.value }) }}
        />
        <input
          type="number"
          min={0}
          max={10}
          placeholder="maxRetries（0=不重试）"
          value={draft.maxRetries}
          onChange={(event) => { set({ maxRetries: event.target.value }) }}
        />
        <input
          type="number"
          min={0}
          placeholder="退避 ms（可选）"
          value={draft.backoffMs}
          onChange={(event) => { set({ backoffMs: event.target.value }) }}
        />
        {props.onTest ? (
          <button type="button" className={styles.stepTest} title="单节点独立验证" onClick={props.onTest}>
            ▶ 验证
          </button>
        ) : null}
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
        <span className={styles.label}>触发条件（由 AI 判断）</span>
        <select
          value={transition.condition.verdict ?? ''}
          onChange={(event) => {
            const verdict = event.target.value
            const color = verdict === 'fail' ? '#f87171' : verdict === 'success' ? '#34d399' : '#6b7280'
            setTransition({
              condition: { ...transition.condition, verdict: verdict === '' ? undefined : (verdict as 'success' | 'fail') },
              label: verdict === '' ? transition.label : (verdict === 'success' ? '成功' : '失败'),
            })
            props.onChange({
              ...edge,
              label: verdict === '' ? (transition.label ?? '') : (verdict === 'success' ? '成功' : '失败'),
              style: { stroke: color, strokeWidth: 2 },
              labelBgStyle: { fill: color, fillOpacity: 0.9 },
              data: {
                transition: {
                  ...transition,
                  condition: { ...transition.condition, verdict: verdict === '' ? undefined : (verdict as 'success' | 'fail') },
                  label: verdict === '' ? transition.label : (verdict === 'success' ? '成功' : '失败'),
                },
              },
            })
          }}
        >
          <option value="">无条件</option>
          {VERDICTS.map((verdict) => (
            <option key={verdict} value={verdict}>{verdict === 'success' ? '成功' : '失败'}</option>
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
      <div className={styles.conditionBlock}>
        <span className={styles.label}>问题类型（任一命中即匹配）</span>
        {ISSUE_TYPES.map((type) => {
          const selected = transition.condition.issueTypes?.includes(type) ?? false
          const toggle = (checked: boolean): void => {
            const current = new Set(transition.condition.issueTypes ?? [])
            if (checked) current.add(type)
            else current.delete(type)
            setTransition({ condition: { ...transition.condition, issueTypes: current.size > 0 ? [...current] : undefined } })
          }
          return (
            <label key={type} className={styles.check}>
              <input type="checkbox" checked={selected} onChange={(event) => { toggle(event.target.checked) }} />
              {type}
            </label>
          )
        })}
      </div>
      <div className={styles.conditionBlock}>
        <span className={styles.label}>严重度（任一命中即匹配）</span>
        {SEVERITIES.map((severity) => {
          const selected = transition.condition.severities?.includes(severity) ?? false
          const toggle = (checked: boolean): void => {
            const current = new Set(transition.condition.severities ?? [])
            if (checked) current.add(severity)
            else current.delete(severity)
            setTransition({ condition: { ...transition.condition, severities: current.size > 0 ? [...current] : undefined } })
          }
          return (
            <label key={severity} className={styles.check}>
              <input type="checkbox" checked={selected} onChange={(event) => { toggle(event.target.checked) }} />
              {severity}
            </label>
          )
        })}
      </div>
      <button type="button" className={styles.deleteButton} onClick={props.onDelete}>
        删除转移
      </button>
    </div>
  )
}
