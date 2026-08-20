/**
 * The full-page workflow workbench: templates / workflow instances / runs on
 * the left, detail or the React Flow editor on the right. The "后台页面"
 * behind the chat view.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { EditorPane } from './WorkflowEditor.tsx'
import type { AceStateDto, StateRunDto, StateTemplateDto, StateWorkflowDto } from './types.ts'
import styles from './Workbench.module.css'

type Tab = 'templates' | 'workflows' | 'runs'

const STATE_ROUTE = '/plugins/dsh-ace-harness/state'
const LOGO = '/plugins/dsh-ace-harness/assets/ace-logo.png'

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

const STEP_TEXT: Record<string, string> = {
  agent: 'AI',
  script: '脚本',
  subworkflow: '子工作流',
  llm: '快速LLM',
}

const ACTIVE_RUN_STATUSES = new Set(['preparing', 'running', 'waiting-human'])

const EDGE_COLORS: Record<string, string> = {
  success: '#34d399',
  pass: '#34d399',
  fail: '#f87171',
  conditional_pass: '#fbbf24',
}

interface EditorState {
  yaml: string
  workspacePath: string
  fileName: string
}

export interface WorkbenchProps {
  send: (text: string) => Promise<boolean>
  onClose: () => void
}

export function Workbench(props: WorkbenchProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('templates')
  const [state, setState] = useState<AceStateDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [template, setTemplate] = useState<StateTemplateDto | null>(null)
  const [workflow, setWorkflow] = useState<{ entry: StateWorkflowDto; workspacePath: string; workspaceTitle: string } | null>(null)
  const [run, setRun] = useState<StateRunDto | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(STATE_ROUTE, { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setState((await response.json()) as AceStateDto)
      setError(null)
    } catch (err) {
      setError(`无法读取工作流状态：${(err as Error).message}`)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 4000)
    return () => { window.clearInterval(timer) }
  }, [refresh])

  const submit = useCallback(
    async (text: string): Promise<void> => {
      const ok = await props.send(text)
      setNotice(ok ? `已提交：${text}` : '当前没有可用的会话，无法提交命令')
    },
    [props],
  )

  const openEditor = useCallback(
    async (workspacePath: string, fileName: string): Promise<void> => {
      try {
        const response = await fetch(
          `/plugins/dsh-ace-harness/workflows/${encodeURIComponent(fileName)}?workspace=${encodeURIComponent(workspacePath)}`,
          { cache: 'no-store' },
        )
        if (!response.ok) {
          setNotice(`读取 workflow 失败：${await response.text()}`)
          return
        }
        setEditor({ yaml: await response.text(), workspacePath, fileName })
      } catch (err) {
        setNotice(`读取 workflow 失败：${(err as Error).message}`)
      }
    },
    [],
  )

  const instantiateForEdit = useCallback(
    async (templateId: string, instanceValues: Record<string, string>, workspacePath: string, fileName: string): Promise<void> => {
      try {
        // Empty fields are deferred to run time; only bind what was filled.
        const values = Object.fromEntries(
          Object.entries(instanceValues).filter(([, value]) => value.trim() !== ''),
        )
        const response = await fetch('/plugins/dsh-ace-harness/instantiate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ templateId, values }),
        })
        if (!response.ok) {
          setNotice(`实例化失败：${await response.text()}`)
          return
        }
        setEditor({ yaml: await response.text(), workspacePath, fileName })
      } catch (err) {
        setNotice(`实例化失败：${(err as Error).message}`)
      }
    },
    [],
  )

  const agents = state?.agents.map((agent) => agent.name) ?? []
  const workspaces = state?.workspaces ?? []
  const runs = workspaces.flatMap((workspace) => workspace.runs.map((r) => ({ ...r, workspaceTitle: workspace.title, workspacePath: workspace.path })))
  const workflows = workspaces.flatMap((workspace) =>
    workspace.workflows.map((entry) => ({ entry, workspacePath: workspace.path, workspaceTitle: workspace.title })),
  )

  const refreshRun = (runId: string): void => {
    const latest = state?.workspaces.flatMap((w) => w.runs).find((r) => r.runId === runId)
    if (latest) setRun(latest)
  }

  return (
    <div className={styles.overlay}>
      <header className={styles.header}>
        <img src={LOGO} alt="ACE" className={styles.logo} />
        <span className={styles.title}>ACE 工作流工作台</span>
        <nav className={styles.tabs}>
          {(['templates', 'workflows', 'runs'] as const).map((key) => (
            <button
              key={key}
              type="button"
              className={tab === key ? styles.tabActive : styles.tab}
              onClick={() => {
                setTab(key)
                setTemplate(null)
                setWorkflow(null)
                setRun(null)
              }}
            >
              {key === 'templates' ? '模板' : key === 'workflows' ? '工作流' : '运行记录'}
            </button>
          ))}
        </nav>
        <button type="button" className={styles.close} onClick={props.onClose} aria-label="关闭">×</button>
      </header>
      {error ? <div className={styles.errorBar}>{error}</div> : null}
      {notice ? <div className={styles.noticeBar}>{notice}</div> : null}
      {editor ? (
        <EditorPane
          initialYaml={editor.yaml}
          workspacePath={editor.workspacePath}
          fileName={editor.fileName}
          agentNames={agents}
          onClose={() => {
            setEditor(null)
            void refresh()
          }}
          onSaved={() => {
            setEditor(null)
            setTab('workflows')
            setWorkflow(null)
            void refresh()
          }}
        />
      ) : (
        <div className={styles.body}>
          <aside className={styles.sidebar}>
            {tab === 'templates' ? (
              state?.templates.map((item) => (
                <button
                  key={`${item.id}@${item.version}`}
                  type="button"
                  className={template?.id === item.id ? styles.itemActive : styles.item}
                  onClick={() => { setTemplate(item) }}
                >
                  <span className={styles.itemName}>{item.name}</span>
                  <span className={styles.itemMeta}>{item.stateCount} 状态 · {item.agents.length} Agent</span>
                </button>
              ))
            ) : tab === 'workflows' ? (
              workflows.map((item) => (
                <button
                  key={`${item.workspacePath}/${item.entry.fileName}`}
                  type="button"
                  className={workflow?.entry.fileName === item.entry.fileName ? styles.itemActive : styles.item}
                  onClick={() => { setWorkflow(item) }}
                >
                  <span className={styles.itemName}>{item.entry.name}</span>
                  <span className={styles.itemMeta}>{item.entry.fileName} · {item.entry.stateCount} 状态</span>
                </button>
              ))
            ) : (
              runs.map((item) => (
                <button
                  key={item.runId}
                  type="button"
                  className={run?.runId === item.runId ? styles.itemActive : styles.item}
                  onClick={() => { setRun(item) }}
                >
                  <span className={styles.itemName}>{item.workflowName}</span>
                  <span className={styles.itemMeta} data-status={item.status}>
                    {STATUS_TEXT[item.status] ?? item.status} · {item.completedSteps}/{item.totalSteps} 步
                  </span>
                </button>
              ))
            )}
            {tab === 'templates' && state && state.templates.length === 0 ? <p className={styles.empty}>没有内置模板</p> : null}
            {tab === 'workflows' && workflows.length === 0 ? <p className={styles.empty}>暂无 workflow 实例，可从模板创建</p> : null}
            {tab === 'runs' && runs.length === 0 ? <p className={styles.empty}>暂无运行记录</p> : null}
          </aside>
          <main className={styles.main}>
            {tab === 'templates' && template ? (
              <TemplateDetail
                template={template}
                workspacePath={workspaces[0]?.path ?? ''}
                submit={submit}
                instantiateForEdit={instantiateForEdit}
              />
            ) : tab === 'workflows' && workflow ? (
              <WorkflowDetail
                workflow={workflow.entry}
                workspacePath={workflow.workspacePath}
                submit={submit}
                onEdit={(fileName) => { void openEditor(workflow.workspacePath, fileName) }}
              />
            ) : tab === 'runs' && run ? (
              <RunDetail
                run={run}
                submit={submit}
                refresh={() => { refreshRun(run.runId) }}
              />
            ) : (
              <div className={styles.welcome}>
                <img src={LOGO} alt="ACE" className={styles.welcomeLogo} />
                <h2>ACE 工作流工作台</h2>
                <p>左侧选择模板、工作流或运行记录；支持 AI 步骤、脚本步骤与子工作流，流转由 AI 判断成功/失败。</p>
                <p>编辑器中拖拽节点布局、拖线连接转移（成功/失败），保存即校验。</p>
              </div>
            )}
          </main>
        </div>
      )}
    </div>
  )
}

function TemplateDetail(props: {
  template: StateTemplateDto
  workspacePath: string
  submit: (text: string) => Promise<void>
  instantiateForEdit: (templateId: string, values: Record<string, string>, workspacePath: string, fileName: string) => void
}): JSX.Element {
  const { template } = props
  // Run-time parameter form for 直接运行 only; creation stays parameter-free.
  const [inputs, setInputs] = useState<Record<string, string>>(() => {
    const defaults: Record<string, string> = {}
    for (const parameter of template.parameters) {
      if (parameter.default !== undefined && parameter.default !== '') {
        defaults[parameter.id] = String(parameter.default)
      }
    }
    return defaults
  })
  const set = (id: string, value: string): void => { setInputs({ ...inputs, [id]: value }) }
  const missing = template.parameters.filter(
    (parameter) => parameter.required && (inputs[parameter.id] ?? '').trim() === '',
  )
  const filled = Object.entries(inputs).filter(([, value]) => value.trim() !== '')
  const paramFlags = filled.map(([id, value]) => `--param ${id}=${encodeURIComponent(value)}`).join(' ')
  return (
    <div className={styles.detail}>
      <h2 className={styles.detailTitle}>
        {template.name}
        {template.featured ? <span className={styles.featured}>精选</span> : null}
      </h2>
      <p className={styles.detailDesc}>{template.description}</p>
      <h3 className={styles.sectionTitle}>流程结构（{template.states.length} 状态）</h3>
      <ol className={styles.stateList}>
        {template.states.map((stateItem) => (
          <li key={stateItem.name} className={styles.stateItem}>
            <span className={styles.stateName}>
              {stateItem.isInitial ? '▶ ' : ''}{stateItem.name}{stateItem.isFinal ? ' ■' : ''}
            </span>
            <span className={styles.stateSteps}>
              {stateItem.steps.map((step) => `${step.name}(${step.agent ? step.agent : STEP_TEXT[step.type ?? 'agent']})`).join(' → ')}
            </span>
          </li>
        ))}
      </ol>
      {template.parameters.length > 0 ? (
        <>
          <h3 className={styles.sectionTitle}>运行参数（仅本次运行生效）</h3>
          <div className={styles.form}>
            {template.parameters.map((parameter) => (
              <TemplateParamField key={parameter.id} parameter={parameter} value={inputs[parameter.id] ?? ''} onChange={(value) => { set(parameter.id, value) }} />
            ))}
          </div>
        </>
      ) : null}
      {missing.length > 0 ? <p className={styles.errorText}>请先填写必填参数：{missing.map((p) => p.label).join('、')}</p> : null}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          disabled={missing.length > 0}
          onClick={() => { void props.submit(`/workflow run ${template.id} ${paramFlags}`) }}
        >
          直接运行
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => {
            props.instantiateForEdit(template.id, {}, props.workspacePath, `${template.id}.yaml`)
          }}
        >
          创建并编排
        </button>
      </div>
      <p className={styles.formHint}>创建时不填参数：留空的必填参数会在启动工作流时询问。</p>
    </div>
  )
}

/** One run-time parameter field of a template (enum / text / others). */
function TemplateParamField(props: {
  parameter: StateTemplateDto['parameters'][number]
  value: string
  onChange: (value: string) => void
}): JSX.Element {
  const { parameter, value, onChange } = props
  if (parameter.type === 'enum' && parameter.options) {
    return (
      <label className={styles.field}>
        <span className={styles.label}>
          {parameter.label}
          {parameter.required ? <span className={styles.required}>*</span> : null}
        </span>
        <select value={value} onChange={(event) => { onChange(event.target.value) }}>
          <option value="">请选择</option>
          {parameter.options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
    )
  }
  if (parameter.type === 'text') {
    return (
      <label className={styles.field}>
        <span className={styles.label}>
          {parameter.label}
          {parameter.required ? <span className={styles.required}>*</span> : null}
        </span>
        <textarea rows={3} value={value} placeholder={parameter.description ?? ''} onChange={(event) => { onChange(event.target.value) }} />
      </label>
    )
  }
  return (
    <label className={styles.field}>
      <span className={styles.label}>
        {parameter.label}
        {parameter.required ? <span className={styles.required}>*</span> : null}
      </span>
      <input type="text" value={value} placeholder={parameter.description ?? ''} onChange={(event) => { onChange(event.target.value) }} />
    </label>
  )
}

function WorkflowDetail(props: {
  workflow: StateWorkflowDto
  workspacePath: string
  submit: (text: string) => Promise<void>
  onEdit: (fileName: string) => void
}): JSX.Element {
  const { workflow } = props
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const set = (id: string, value: string): void => { setInputs({ ...inputs, [id]: value }) }
  const fields = workflow.taskFields
  const filled = Object.entries(inputs).filter(([, value]) => value.trim() !== '')
  const paramFlags = filled.map(([id, value]) => `--param ${id}=${encodeURIComponent(value)}`).join(' ')
  const missing = fields.filter((field) => field.required && (inputs[field.id] ?? '').trim() === '')
  return (
    <div className={styles.detail}>
      <h2 className={styles.detailTitle}>{workflow.name}</h2>
      <p className={styles.detailDesc}>
        {workflow.fileName} · {workflow.stateCount} 状态 / {workflow.stepCount} 步 · {workflow.source === 'project' ? '项目' : '个人'}
      </p>
      {fields.length > 0 ? (
        <>
          <h3 className={styles.sectionTitle}>运行参数</h3>
          <div className={styles.form}>
            {fields.map((field) => (
              <TaskField key={field.id} field={field} value={inputs[field.id] ?? ''} onChange={(value) => { set(field.id, value) }} />
            ))}
          </div>
        </>
      ) : null}
      {missing.length > 0 ? <p className={styles.errorText}>请先填写必填参数：{missing.map((field) => field.label).join('、')}</p> : null}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          disabled={missing.length > 0}
          onClick={() => { void props.submit(`/workflow run ${workflow.fileName} ${paramFlags}`) }}
        >
          运行
        </button>
        <button type="button" className={styles.secondary} onClick={() => { props.onEdit(workflow.fileName) }}>
          编排
        </button>
        <button type="button" className={styles.danger} onClick={() => { void props.submit(`/workflow delete ${workflow.fileName}`) }}>
          删除
        </button>
      </div>
    </div>
  )
}

/** One run-time input field of a workflow instance. */
function TaskField(props: {
  field: StateWorkflowDto['taskFields'][number]
  value: string
  onChange: (value: string) => void
}): JSX.Element {
  const { field, value, onChange } = props
  const placeholder = field.placeholder || field.description || ''
  if (field.type === 'textarea') {
    return (
      <label className={styles.field}>
        <span className={styles.label}>
          {field.label}
          {field.required ? <span className={styles.required}>*</span> : null}
        </span>
        <textarea rows={4} value={value} placeholder={placeholder} onChange={(event) => { onChange(event.target.value) }} />
      </label>
    )
  }
  return (
    <label className={styles.field}>
      <span className={styles.label}>
        {field.label}
        {field.required ? <span className={styles.required}>*</span> : null}
      </span>
      <input type="text" value={value} placeholder={placeholder} onChange={(event) => { onChange(event.target.value) }} />
    </label>
  )
}

interface TopologyNodeData extends Record<string, unknown> {
  name: string
  isInitial: boolean
  isFinal: boolean
  verdict: string | null
  current: boolean
}

function TopologyNode(props: NodeProps<Node<TopologyNodeData>>): JSX.Element {
  const { data } = props
  return (
    <div
      className={styles.topologyNode}
      data-verdict={data.verdict ?? 'pending'}
      data-current={data.current ? 'true' : 'false'}
    >
      <Handle type="target" position={Position.Left} />
      {data.current ? <span className={styles.topologyRunning}>执行中</span> : null}
      {data.isInitial ? <span className={styles.topologyBadge}>初始</span> : null}
      {data.isFinal ? <span className={styles.topologyBadgeFinal}>终止</span> : null}
      <span className={styles.topologyName}>{data.name}</span>
      {data.verdict ? (
        <span className={styles.topologyVerdict}>
          {data.verdict === 'success' || data.verdict === 'pass' ? '✓' : data.verdict === 'fail' ? '✗' : '?'}
        </span>
      ) : null}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

const topologyNodeTypes = { topologyState: TopologyNode }

/** Static state diagram of one run: outcomes color the nodes, the executed path highlights the edges. */
function RunTopology(props: { run: StateRunDto }): JSX.Element | null {
  const { run } = props
  const topology = run.topology
  const nodes = useMemo<Node<TopologyNodeData>[]>(() => {
    if (!topology) return []
    const verdictByState = new Map(run.states.map((item) => [item.state, item.verdict]))
    return topology.states.map((state, index) => ({
      id: state.name,
      type: 'topologyState',
      position: state.position ?? { x: (index % 4) * 230, y: Math.floor(index / 4) * 140 },
      data: {
        name: state.name,
        isInitial: state.isInitial,
        isFinal: state.isFinal,
        verdict: verdictByState.get(state.name) ?? null,
        current: state.name === run.currentState && ACTIVE_RUN_STATUSES.has(run.status),
      },
    }))
  }, [topology, run])
  const edges = useMemo<Edge[]>(() => {
    if (!topology) return []
    // Executed path: adjacent states in execution order.
    const sequence = run.states.map((item) => item.state)
    const taken = new Set<string>()
    for (let i = 0; i + 1 < sequence.length; i += 1) {
      taken.add(`${sequence[i]}→${sequence[i + 1]}`)
    }
    return topology.transitions.map((transition, index) => {
      const isTaken = taken.has(`${transition.from}→${transition.to}`)
      const base = transition.verdict ? (EDGE_COLORS[transition.verdict] ?? '#6b7280') : '#6b7280'
      return {
        id: `t-${transition.from}-${transition.to}-${index}`,
        source: transition.from,
        target: transition.to,
        label: transition.label ?? transition.verdict ?? '',
        style: { stroke: base, strokeWidth: isTaken ? 3 : 1.5, opacity: isTaken ? 1 : 0.4 },
        labelStyle: { fill: '#e5e7eb', fontSize: 10, fontWeight: 600 },
        labelBgStyle: { fill: '#1f2937', fillOpacity: 0.95 },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 6,
      }
    })
  }, [topology, run])
  if (!topology) return null
  return (
    <>
      <h3 className={styles.sectionTitle}>运行拓扑（{topology.states.length} 状态，执行过的路径加亮）</h3>
      <div className={styles.topologyBox}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={topologyNodeTypes}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnScroll={false}
          panOnDrag
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </>
  )
}

function RunDetail(props: {
  run: StateRunDto
  submit: (text: string) => Promise<void>
  refresh: () => void
}): JSX.Element {
  const { run } = props
  const progress = run.totalSteps > 0 ? Math.round((run.completedSteps / run.totalSteps) * 100) : 0
  const resumable = run.status === 'waiting-human' || run.status === 'failed' || run.status === 'stopped' || run.status === 'crashed'
  const stoppable = run.status === 'running' || run.status === 'preparing'
  return (
    <div className={styles.detail}>
      <h2 className={styles.detailTitle}>{run.workflowName}</h2>
      <p className={styles.detailDesc}>
        {run.runId} · {STATUS_TEXT[run.status] ?? run.status}
        {run.currentState ? ` · 当前状态：${run.currentState}` : ''} · {run.startedAt}
      </p>
      <div className={styles.progressTrack}>
        <div className={styles.progressFill} style={{ width: `${progress}%` }} />
      </div>
      {run.error ? <p className={styles.errorText}>{run.error}</p> : null}
      <RunTopology run={run} />
      <h3 className={styles.sectionTitle}>状态时间线</h3>
      <ol className={styles.runTimeline}>
        {run.states.map((stateItem) => (
          <li key={stateItem.state} className={styles.runStateItem}>
            <div className={styles.runStateHead}>
              <span className={styles.runStateName}>{stateItem.state}</span>
              <span className={styles.verdictBadge} data-verdict={stateItem.verdict}>
                {VERDICT_TEXT[stateItem.verdict] ?? stateItem.verdict}
              </span>
              {stateItem.supervisorScore !== null ? <span className={styles.scoreBadge}>评分 {stateItem.supervisorScore}</span> : null}
            </div>
            <ol className={styles.stepTimeline}>
              {stateItem.steps.map((step) => (
                <li key={step.step} className={styles.stepItem}>
                  <span className={styles.stepName}>{step.step}</span>
                  {step.type === 'agent' && step.agent ? (
                    <span className={styles.stepAgent}>{step.agent}</span>
                  ) : (
                    <span className={styles.stepAgent}>{STEP_TEXT[step.type] ?? step.type}</span>
                  )}
                  {step.role ? <span className={styles.stepRole}>{step.role}</span> : null}
                  {step.attempts > 1 ? (
                    <span className={styles.stepRole} title="重试次数">重试 {step.attempts - 1} 次</span>
                  ) : null}
                  {step.verdict ? (
                    <span className={styles.verdictBadge} data-verdict={step.verdict}>
                      {VERDICT_TEXT[step.verdict] ?? step.verdict}
                    </span>
                  ) : null}
                  {step.outputSummary ? (
                    <pre className={styles.stepOutput}>{step.outputSummary.slice(0, 300)}</pre>
                  ) : null}
                  {step.data != null ? (
                    <pre className={styles.stepOutput}>{JSON.stringify(step.data, null, 2).slice(0, 300)}</pre>
                  ) : null}
                </li>
              ))}
            </ol>
            {stateItem.supervisorNote ? <p className={styles.supervisorNote}>supervisor：{stateItem.supervisorNote}</p> : null}
          </li>
        ))}
      </ol>
      <div className={styles.actions}>
        {resumable ? (
          <button type="button" className={styles.primary} onClick={() => { void props.submit(`/workflow resume ${run.runId}`) }}>
            恢复
          </button>
        ) : null}
        {stoppable ? (
          <button type="button" className={styles.danger} onClick={() => { void props.submit(`/workflow stop ${run.runId}`) }}>
            停止
          </button>
        ) : null}
        <button type="button" className={styles.secondary} onClick={props.refresh}>
          刷新
        </button>
      </div>
    </div>
  )
}
