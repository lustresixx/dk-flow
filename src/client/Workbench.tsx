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
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import { EditorPane } from './WorkflowEditor.tsx'
import { SelfLoopEdge } from './SelfLoopEdge.tsx'
import { blankWorkflowYaml } from './workflow-model.ts'
import { ACTIVE_STATUSES, route, STATUS_TEXT, STEP_TYPE_TEXT, VERDICT_TEXT } from './run-meta.ts'
import type { AceStateDto, StateRunDto, StateTemplateDto, StateWorkflowDto, WorkspaceStatsDto } from './types.ts'
import styles from './Workbench.module.css'

type Tab = 'templates' | 'workflows' | 'runs'

const STATE_ROUTE = route('state')
const LOGO = '/plugins/dsh-ace-harness/assets/ace-logo.png'

/** Resolve a non-colliding workflow base name: `base` → `base-2` → `base-3`… */
function nextFileName(existingBases: readonly string[], base: string): string {
  const safe = base.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'workflow'
  const existing = new Set(existingBases)
  if (!existing.has(safe)) return safe
  let n = 2
  while (existing.has(`${safe}-${n}`)) n += 1
  return `${safe}-${n}`
}

/** One archived run row from the SQLite history route. */
interface ArchivedRunRow {
  runId: string
  workflowName: string
  status: string
  currentState: string | null
  transitionCount: number
  totalSteps: number
  completedSteps: number
  verdict: string | null
  error: string | null
  parentSessionId: string | null
  startedAt: string
  updatedAt: string
  finishedAt: string | null
}

/** Archived evidence chain of one run (runs-history/<runId>). */
interface ArchivedRunDetail {
  run: ArchivedRunRow
  state: {
    stateOutcomes?: Array<{
      state: string
      verdict: { verdict: string }
      steps: Array<{ step: string; type: string; verdict?: { verdict: string }; outputSummary: string }>
    }>
  } | null
  audit: Array<{ id: number; at: string; event: string; payload: Record<string, unknown> }>
}

const EDGE_COLORS: Record<string, string> = {
  success: 'var(--dsw-alias-state-success-primary, #12a150)',
  pass: 'var(--dsw-alias-state-success-primary, #12a150)',
  fail: 'var(--dsw-alias-state-error-primary, #e5484d)',
  conditional_pass: 'var(--dsw-alias-state-warn-primary, #e08700)',
}

interface EditorState {
  yaml: string
  workspacePath: string
  fileName: string
}

export interface WorkbenchProps {
  send: (text: string) => Promise<boolean>
  /** Start a run via the REST route (structured values, no flag parsing). */
  run: (workspace: string, workflow: string, values: Record<string, string>) => Promise<{ ok: boolean; message: string }>
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

  /** Start a run through the REST route with structured values (no flags). */
  const runDirect = useCallback(
    async (workspacePath: string, workflowRef: string, values: Record<string, string>): Promise<void> => {
      const result = await props.run(workspacePath, workflowRef, values)
      setNotice(result.ok ? result.message : `运行失败：${result.message}`)
      if (result.ok) {
        setTab('runs')
        void refresh()
      }
    },
    [props],
  )

  /** Delete a workflow instance directly via REST (no agent round-trip). */
  const deleteDirect = useCallback(
    async (workspacePath: string, fileName: string): Promise<void> => {
      try {
        const response = await fetch(
          `/plugins/dsh-ace-harness/workflows/${encodeURIComponent(fileName)}?workspace=${encodeURIComponent(workspacePath)}`,
          { method: 'DELETE' },
        )
        if (!response.ok) {
          setNotice(`删除失败：${await response.text()}`)
          return
        }
        setNotice(`已删除工作流 ${fileName}`)
        setWorkflow(null)
        setTab('workflows')
        void refresh()
      } catch (err) {
        setNotice(`删除失败：${(err as Error).message}`)
      }
    },
    [],
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

  /** Existing instance base names (no extension), for collision-free naming. */
  const workflowNames = useMemo(
    () => (state?.workspaces ?? []).flatMap((workspace) => workspace.workflows.map((entry) => entry.fileName)),
    [state],
  )

  const instantiateForEdit = useCallback(
    async (templateId: string, instanceValues: Record<string, string>, workspacePath: string): Promise<void> => {
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
        const fileName = `${nextFileName(workflowNames, templateId)}.yaml`
        setEditor({ yaml: await response.text(), workspacePath, fileName })
      } catch (err) {
        setNotice(`实例化失败：${(err as Error).message}`)
      }
    },
    [workflowNames],
  )

  /** Create-from-blank entry: a minimal one-state workflow in the editor. */
  const createBlank = useCallback(
    (workspacePath: string): void => {
      if (workspacePath === '') {
        setNotice('暂无已知工作区，无法创建工作流')
        return
      }
      setEditor({
        yaml: blankWorkflowYaml('未命名工作流'),
        workspacePath,
        fileName: `${nextFileName(workflowNames, 'workflow')}.yaml`,
      })
    },
    [workflowNames],
  )

  /** SQLite archive toggle + archived run drill-down. */
  const [archiveDetail, setArchiveDetail] = useState<{ workspacePath: string; detail: ArchivedRunDetail } | null>(null)
  const toggleSqlite = useCallback(
    async (workspacePath: string, enabled: boolean): Promise<void> => {
      try {
        const response = await fetch('/plugins/dsh-ace-harness/workspace-settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspace: workspacePath, sqliteArchive: enabled }),
        })
        if (!response.ok) throw new Error(await response.text())
        const result = (await response.json()) as { enabled: boolean; backfilled: number; dbFile: string }
        setNotice(
          result.enabled
            ? `已开启 SQLite 归档（回填 ${result.backfilled} 条历史运行）`
            : '已关闭 SQLite 归档（已归档数据保留，不再写入新记录）',
        )
        void refresh()
      } catch (err) {
        setNotice(`设置失败：${(err as Error).message}`)
      }
    },
    [refresh],
  )
  const openArchivedRun = useCallback(
    async (workspacePath: string, runId: string): Promise<void> => {
      try {
        const response = await fetch(
          `/plugins/dsh-ace-harness/runs-history/${encodeURIComponent(runId)}?workspace=${encodeURIComponent(workspacePath)}`,
          { cache: 'no-store' },
        )
        if (!response.ok) throw new Error(await response.text())
        setRun(null)
        setTemplate(null)
        setWorkflow(null)
        setArchiveDetail({ workspacePath, detail: (await response.json()) as ArchivedRunDetail })
      } catch (err) {
        setNotice(`读取归档失败：${(err as Error).message}`)
      }
    },
    [],
  )

  const agents = state?.agents.map((agent) => agent.name) ?? []
  const workspaces = state?.workspaces ?? []
  const firstWorkspace = workspaces[0]
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
                setArchiveDetail(null)
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
              state?.templates.map((item, index) => (
                <button
                  key={`${item.id}@${item.version}`}
                  type="button"
                  className={template?.id === item.id ? styles.itemActive : styles.item}
                  onClick={() => { setTemplate(item) }}
                >
                  <span className={styles.itemName}><span className={styles.itemIndex}>{index + 1}</span>{item.name}</span>
                  <span className={styles.itemMeta}>{item.stateCount} 状态 · {item.agents.length} Agent</span>
                </button>
              ))
            ) : tab === 'workflows' ? (
              <>
                <button
                  type="button"
                  className={styles.createBlank}
                  onClick={() => { createBlank(workspaces[0]?.path ?? '') }}
                >
                  ＋ 新建空白工作流
                </button>
                {workflows.map((item, index) => (
                  <button
                    key={`${item.workspacePath}/${item.entry.fileName}`}
                    type="button"
                    className={workflow?.entry.fileName === item.entry.fileName ? styles.itemActive : styles.item}
                    onClick={() => { setWorkflow(item) }}
                  >
                    <span className={styles.itemName}><span className={styles.itemIndex}>{index + 1}</span>{item.entry.name}</span>
                    <span className={styles.itemMeta}>{item.entry.fileName} · {item.entry.stateCount} 状态</span>
                  </button>
                ))}
              </>
            ) : (
              <>
                {firstWorkspace ? (
                  <ArchiveCard
                    workspacePath={firstWorkspace.path}
                    archive={firstWorkspace.sqliteArchive}
                    onToggle={(enabled) => { void toggleSqlite(firstWorkspace.path, enabled) }}
                    onOpen={(runId) => { void openArchivedRun(firstWorkspace.path, runId) }}
                  />
                ) : null}
                {runs.map((item) => (
                  <button
                    key={item.runId}
                    type="button"
                    className={run?.runId === item.runId ? styles.itemActive : styles.item}
                    onClick={() => {
                      setRun(item)
                      setArchiveDetail(null)
                    }}
                  >
                    <span className={styles.itemName}>{item.workflowName}</span>
                    <span className={styles.itemMeta} data-status={item.status}>
                      {STATUS_TEXT[item.status] ?? item.status} · {item.completedSteps}/{item.totalSteps} 步
                    </span>
                  </button>
                ))}
              </>
            )}
            {tab === 'templates' && state && state.templates.length === 0 ? <p className={styles.empty}>没有内置模板</p> : null}
            {tab === 'workflows' && workflows.length === 0 ? <p className={styles.empty}>暂无 workflow 实例——点上方「新建空白工作流」从零编排，或到「模板」页从模板创建</p> : null}
            {tab === 'runs' && runs.length === 0 ? <p className={styles.empty}>暂无运行记录</p> : null}
          </aside>
          <main className={styles.main}>
            {tab === 'templates' && template ? (
              <TemplateDetail
                template={template}
                workspacePath={workspaces[0]?.path ?? ''}
                submit={submit}
                onRun={runDirect}
                instantiateForEdit={instantiateForEdit}
              />
            ) : tab === 'workflows' && workflow ? (
              <WorkflowDetail
                workflow={workflow.entry}
                workspacePath={workflow.workspacePath}
                submit={submit}
                onRun={runDirect}
                onDelete={deleteDirect}
                onEdit={(fileName) => { void openEditor(workflow.workspacePath, fileName) }}
              />
            ) : tab === 'runs' && archiveDetail ? (
              <ArchiveDetailView
                workspacePath={archiveDetail.workspacePath}
                detail={archiveDetail.detail}
                onClose={() => { setArchiveDetail(null) }}
              />
            ) : tab === 'runs' && run ? (
              <RunDetail
                run={run}
                submit={submit}
                refresh={() => { refreshRun(run.runId) }}
              />
            ) : tab === 'runs' ? (
              // 需求③: the run-records page consumes /stats — failure hotspots
              // and the step-duration distribution (P1-D turns the route live).
              <StatsPanel workspacePath={firstWorkspace?.path ?? ''} />
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
  onRun: (workspacePath: string, workflowRef: string, values: Record<string, string>) => void
  instantiateForEdit: (templateId: string, values: Record<string, string>, workspacePath: string) => void
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
              {stateItem.steps.map((step) => `${step.name}(${step.agent ? step.agent : STEP_TYPE_TEXT[step.type ?? 'agent']})`).join(' → ')}
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
          onClick={() => {
            props.onRun(props.workspacePath, template.id, Object.fromEntries(filled))
          }}
        >
          直接运行
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => {
            props.instantiateForEdit(template.id, {}, props.workspacePath)
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
  onRun: (workspacePath: string, workflowRef: string, values: Record<string, string>) => void
  onDelete: (workspacePath: string, fileName: string) => void
  onEdit: (fileName: string) => void
}): JSX.Element {
  const { workflow } = props
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const set = (id: string, value: string): void => { setInputs({ ...inputs, [id]: value }) }
  const fields = workflow.taskFields
  const filled = Object.entries(inputs).filter(([, value]) => value.trim() !== '')
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
          onClick={() => {
            props.onRun(props.workspacePath, workflow.fileName, Object.fromEntries(filled))
          }}
        >
          运行
        </button>
        <button type="button" className={styles.secondary} onClick={() => { props.onEdit(workflow.fileName) }}>
          编排
        </button>
        <button type="button" className={styles.danger} onClick={() => { props.onDelete(props.workspacePath, workflow.fileName) }}>
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
const topologyEdgeTypes = { selfLoop: SelfLoopEdge }

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
        current: state.name === run.currentState && ACTIVE_STATUSES.has(run.status),
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
        type: transition.from === transition.to ? 'selfLoop' : undefined,
        label: transition.label ?? transition.verdict ?? '',
        style: { stroke: base, strokeWidth: isTaken ? 3 : 1.5, opacity: isTaken ? 1 : 0.4 },
        markerEnd: { type: MarkerType.ArrowClosed, color: base, width: 16, height: 16 },
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
          edgeTypes={topologyEdgeTypes}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnScroll
          panOnDrag
          minZoom={0.4}
          maxZoom={2.5}
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
                    <span className={styles.stepAgent}>{STEP_TYPE_TEXT[step.type] ?? step.type}</span>
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

/**
 * Run-records diagnostics (需求③ / P1-D): polls the /stats route of the
 * selected workspace and renders the failure hotspots (step-level and
 * failed-step) and the step-duration distribution — the consumer that turns
 * the previously UI-dead /stats route live.
 */
function StatsPanel(props: { workspacePath: string }): JSX.Element {
  const { workspacePath } = props
  const [stats, setStats] = useState<WorkspaceStatsDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!workspacePath) {
      setStats(null)
      return
    }
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(
          `/plugins/dsh-ace-harness/stats?workspace=${encodeURIComponent(workspacePath)}`,
          { cache: 'no-store' },
        )
        if (!response.ok) {
          if (alive) setError(`统计路由返回 HTTP ${response.status}`)
          return
        }
        const body = (await response.json()) as WorkspaceStatsDto
        if (alive) {
          setStats(body)
          setError(null)
        }
      } catch (err) {
        if (alive) setError(`无法读取运行统计：${(err as Error).message}`)
      }
    }
    void load()
    // Aggregates are cached server-side for 10s; poll at the same cadence.
    const timer = window.setInterval(() => { void load() }, 10_000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [workspacePath])

  if (!workspacePath) {
    return <div className={styles.welcome}><h2>运行统计</h2><p>暂无已知工作区，无法读取统计。</p></div>
  }
  if (error) {
    return (
      <div className={styles.detail}>
        <h2 className={styles.detailTitle}>运行统计</h2>
        <p className={styles.errorText}>{error}</p>
      </div>
    )
  }
  if (!stats) {
    return <div className={styles.detail}><h2 className={styles.detailTitle}>运行统计</h2><p className={styles.detailDesc}>加载中…</p></div>
  }

  const maxBucketCount = Math.max(1, ...stats.stepDurationBuckets.map((bucket) => bucket.count))
  const statusChips = Object.entries(stats.byStatus).map(([status, count]) => (
    <span key={status} className={styles.statsChip} data-status={status}>
      {STATUS_TEXT[status] ?? status}: {count}
    </span>
  ))
  const pct = (ms: number | null): string => (ms === null ? '—' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`)
  return (
    <div className={styles.detail}>
      <h2 className={styles.detailTitle}>
        运行统计
        <span className={styles.statsBadge}>
          {stats.totalRuns} 次运行{stats.activeRuns > 0 ? ` · ${stats.activeRuns} 执行中` : ''}
        </span>
      </h2>
      <h3 className={styles.sectionTitle}>状态分布</h3>
      <div className={styles.statsChips}>{statusChips}</div>

      <h3 className={styles.sectionTitle}>步骤耗时分布（{stats.stepCount} 步）</h3>
      <div className={styles.histogram}>
        {stats.stepDurationBuckets.map((bucket) => (
          <div key={bucket.label} className={styles.histogramRow}>
            <span className={styles.histogramLabel}>{bucket.label}</span>
            <div className={styles.histogramTrack}>
              <div
                className={styles.histogramFill}
                style={{ width: `${(bucket.count / maxBucketCount) * 100}%` }}
              />
            </div>
            <span className={styles.histogramCount}>{bucket.count}</span>
          </div>
        ))}
      </div>
      <p className={styles.statsHint}>
        p50 {pct(stats.stepDurationPercentiles.p50)} · p95 {pct(stats.stepDurationPercentiles.p95)} · 重试{' '}
        {stats.stepRetryCount} 步 / {stats.stepRetryTotal} 次
      </p>

      <h3 className={styles.sectionTitle}>失败热点</h3>
      {stats.stepHotspots.length === 0 && stats.failedStepHotspots.length === 0 ? (
        <p className={styles.statsHint}>暂无失败记录</p>
      ) : (
        <ul className={styles.hotspotList}>
          {stats.stepHotspots.map((hotspot) => (
            <li key={`${hotspot.state}/${hotspot.step}/${hotspot.verdict}`} className={styles.hotspotItem}>
              <span className={styles.hotspotName}>
                {hotspot.state}/{hotspot.step}
              </span>
              <span className={styles.verdictBadge} data-verdict={hotspot.verdict}>
                {VERDICT_TEXT[hotspot.verdict] ?? hotspot.verdict}
              </span>
              <span className={styles.hotspotCount}>{hotspot.count} 次</span>
            </li>
          ))}
          {stats.failedStepHotspots.map((hotspot) => (
            <li key={`${hotspot.state}/${hotspot.step}`} className={styles.hotspotItem}>
              <span className={styles.hotspotName}>
                {hotspot.state}/{hotspot.step}
              </span>
              <span className={styles.verdictBadge} data-verdict="fail">执行失败</span>
              <span className={styles.hotspotCount}>{hotspot.count} 次</span>
            </li>
          ))}
        </ul>
      )}
      <p className={styles.statsHint}>
        {stats.archiveEnabled ? '数据源：SQLite 归档' : '数据源：运行文件'} · 最近运行 {stats.lastRunAt ?? '—'}
      </p>
    </div>
  )
}

/** SQLite archive switch card at the top of the runs tab. */
function ArchiveCard(props: {
  workspacePath: string
  archive: { enabled: boolean; archived: number; dbFile: string | null }
  onToggle: (enabled: boolean) => void
  onOpen: (runId: string) => void
}): JSX.Element {
  const { archive } = props
  const [recent, setRecent] = useState<ArchivedRunRow[]>([])
  const enabled = archive.enabled
  const archived = archive.archived
  useEffect(() => {
    if (!enabled) {
      setRecent([])
      return
    }
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(
          `/plugins/dsh-ace-harness/runs-history?workspace=${encodeURIComponent(props.workspacePath)}&limit=5`,
          { cache: 'no-store' },
        )
        if (!response.ok) return
        const body = (await response.json()) as { rows: ArchivedRunRow[] }
        if (alive) setRecent(body.rows)
      } catch {
        // Best-effort list.
      }
    }
    void load()
    return () => { alive = false }
  }, [enabled, archived, props.workspacePath])
  return (
    <div className={styles.archiveCard}>
      <label className={styles.archiveSwitchRow}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => { props.onToggle(event.target.checked) }}
        />
        <span className={styles.archiveTitle}>SQLite 持久化运行记录</span>
      </label>
      <p className={styles.archiveHint}>
        默认关闭。开启后每次运行的进度快照与审计事件实时写入 <code>.ace-workflows/archive.db</code>，并回填已有运行——证据链长期可查。
      </p>
      {enabled ? (
        <>
          <p className={styles.archiveMeta}>已归档 {archived} 条运行记录</p>
          {recent.length > 0 ? (
            <ul className={styles.archiveList}>
              {recent.map((item) => (
                <li key={item.runId}>
                  <button type="button" className={styles.archiveItem} onClick={() => { props.onOpen(item.runId) }}>
                    <span className={styles.itemName}>{item.workflowName}</span>
                    <span className={styles.itemMeta} data-status={item.status}>
                      {STATUS_TEXT[item.status] ?? item.status} · {item.startedAt.slice(0, 19).replace('T', ' ')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

/** Read-only archived run view: state evidence chain + audit timeline. */
function ArchiveDetailView(props: {
  workspacePath: string
  detail: ArchivedRunDetail
  onClose: () => void
}): JSX.Element {
  const { detail } = props
  const outcomes = detail.state?.stateOutcomes ?? []
  return (
    <div className={styles.detail}>
      <h2 className={styles.detailTitle}>
        {detail.run.workflowName}
        <span className={styles.verdictBadge} data-verdict={detail.run.verdict ?? detail.run.status}>
          {VERDICT_TEXT[detail.run.verdict ?? ''] ?? STATUS_TEXT[detail.run.status] ?? detail.run.status}
        </span>
      </h2>
      <p className={styles.detailDesc}>
        归档记录 · {detail.run.runId} · {detail.run.startedAt}
        {detail.run.parentSessionId ? ` · 会话 ${detail.run.parentSessionId}` : ''}
      </p>
      {detail.run.error ? <p className={styles.errorText}>{detail.run.error}</p> : null}
      <h3 className={styles.sectionTitle}>状态证据链（{outcomes.length} 状态）</h3>
      <ol className={styles.runTimeline}>
        {outcomes.map((outcome) => (
          <li key={outcome.state} className={styles.runStateItem}>
            <div className={styles.runStateHead}>
              <span className={styles.runStateName}>{outcome.state}</span>
              <span className={styles.verdictBadge} data-verdict={outcome.verdict.verdict}>
                {VERDICT_TEXT[outcome.verdict.verdict] ?? outcome.verdict.verdict}
              </span>
            </div>
            <ol className={styles.stepTimeline}>
              {outcome.steps.map((step) => (
                <li key={step.step} className={styles.stepItem}>
                  <span className={styles.stepName}>{step.step}</span>
                  <span className={styles.stepAgent}>{STEP_TYPE_TEXT[step.type] ?? step.type}</span>
                  {step.verdict ? (
                    <span className={styles.verdictBadge} data-verdict={step.verdict.verdict}>
                      {VERDICT_TEXT[step.verdict.verdict] ?? step.verdict.verdict}
                    </span>
                  ) : null}
                  {step.outputSummary ? <pre className={styles.stepOutput}>{step.outputSummary.slice(0, 300)}</pre> : null}
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
      <h3 className={styles.sectionTitle}>审计时间线（{detail.audit.length} 事件）</h3>
      <ol className={styles.runTimeline}>
        {detail.audit.map((event) => (
          <li key={event.id} className={styles.stepItem}>
            <span className={styles.stepName}>{event.event}</span>
            <span className={styles.stepAgent}>{event.at.slice(0, 19).replace('T', ' ')}</span>
            <pre className={styles.stepOutput}>{JSON.stringify(event.payload)}</pre>
          </li>
        ))}
      </ol>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={props.onClose}>
          返回
        </button>
      </div>
    </div>
  )
}
