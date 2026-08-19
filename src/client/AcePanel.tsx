/**
 * The ACE workflow floater panel: templates, workflow instances, and runs.
 * Data comes from the host `/plugins/dsh-ace-harness/state` route; actions
 * submit `/workflow` commands into the current session.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AceStateDto, StateParameterDto, StateRunDto, StateTemplateDto } from './types.ts'
import { WorkflowEditor } from './WorkflowEditor.tsx'
import styles from './AcePanel.module.css'

type Tab = 'templates' | 'workflows' | 'runs'

const STATE_ROUTE = '/plugins/dsh-ace-harness/state'

const STATUS_TEXT: Record<string, string> = {
  preparing: '准备中',
  running: '运行中',
  'waiting-human': '等待人工决策',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
  crashed: '崩溃',
}

export interface AcePanelProps {
  currentSessionId: () => string | undefined
  send: (text: string) => Promise<boolean>
}

/** Editor overlay state: raw yaml plus the save target. */
interface EditorState {
  yaml: string
  workspacePath: string
  fileName: string
}

export function AcePanel(props: AcePanelProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('templates')
  const [state, setState] = useState<AceStateDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)

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

  // Poll while open.
  useEffect(() => {
    if (!open) return
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 4000)
    return () => { window.clearInterval(timer) }
  }, [open, refresh])

  const run = useCallback(
    async (text: string): Promise<void> => {
      const ok = await props.send(text)
      setNotice(ok ? `已提交：${text}` : '当前没有可用的会话，无法提交命令')
      if (ok) setTab('runs')
    },
    [props],
  )

  const editWorkflow = useCallback(
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
        setOpen(false)
      } catch (err) {
        setNotice(`读取 workflow 失败：${(err as Error).message}`)
      }
    },
    [],
  )

  const instantiateForEdit = useCallback(
    async (templateId: string, values: Record<string, string>, workspacePath: string, fileName: string): Promise<void> => {
      try {
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
        setOpen(false)
      } catch (err) {
        setNotice(`实例化失败：${(err as Error).message}`)
      }
    },
    [],
  )

  if (editor) {
    return (
      <WorkflowEditor
        initialYaml={editor.yaml}
        workspacePath={editor.workspacePath}
        fileName={editor.fileName}
        agentNames={state?.agents.map((agent) => agent.name) ?? []}
        onClose={() => {
          setEditor(null)
          setOpen(true)
          void refresh()
        }}
        onSaved={() => {
          setEditor(null)
          setOpen(true)
          setTab('workflows')
          void refresh()
        }}
      />
    )
  }

  return (
    <div className={styles.host}>
      {open ? (
        <div className={styles.panel}>
          <header className={styles.header}>
            <span className={styles.title}>ACE 工作流</span>
            <nav className={styles.tabs}>
              <button
                type="button"
                className={tab === 'templates' ? styles.tabActive : styles.tab}
                onClick={() => { setTab('templates') }}
              >
                模板
              </button>
              <button
                type="button"
                className={tab === 'workflows' ? styles.tabActive : styles.tab}
                onClick={() => { setTab('workflows') }}
              >
                工作流
              </button>
              <button
                type="button"
                className={tab === 'runs' ? styles.tabActive : styles.tab}
                onClick={() => { setTab('runs') }}
              >
                运行
              </button>
            </nav>
            <button type="button" className={styles.close} onClick={() => { setOpen(false) }} aria-label="关闭">
              ×
            </button>
          </header>
          <main className={styles.body}>
            {error ? <p className={styles.error}>{error}</p> : null}
            {notice ? <p className={styles.notice}>{notice}</p> : null}
            {!state && !error ? <p className={styles.empty}>加载中…</p> : null}
            {state && tab === 'templates' ? (
              <TemplateTab
                templates={state.templates}
                run={run}
                editTemplate={(templateId, values, workspacePath, fileName) => {
                  void instantiateForEdit(templateId, values, workspacePath, fileName)
                }}
                workspaces={state.workspaces}
              />
            ) : null}
            {state && tab === 'workflows' ? (
              <WorkflowTab workspaces={state.workspaces} run={run} onEdit={(workspacePath, fileName) => { void editWorkflow(workspacePath, fileName) }} />
            ) : null}
            {state && tab === 'runs' ? (
              <RunsTab workspaces={state.workspaces} run={run} currentSessionId={props.currentSessionId} />
            ) : null}
          </main>
        </div>
      ) : (
        <button type="button" className={styles.toggle} onClick={() => { setOpen(true) }}>
          ACE 工作流
        </button>
      )}
    </div>
  )
}

function TemplateTab(props: {
  templates: StateTemplateDto[]
  run: (text: string) => Promise<void>
  editTemplate: (templateId: string, values: Record<string, string>, workspacePath: string, fileName: string) => void
  workspaces: AceStateDto['workspaces']
}): JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const workspacePath = props.workspaces[0]?.path ?? ''

  if (props.templates.length === 0) return <p className={styles.empty}>没有内置模板</p>
  return (
    <ul className={styles.list}>
      {props.templates.map((template) => (
        <li key={`${template.id}@${template.version}`} className={styles.card}>
          <button
            type="button"
            className={styles.cardHeader}
            onClick={() => {
              setExpanded(expanded === template.id ? null : template.id)
              if (expanded !== template.id) {
                const defaults: Record<string, string> = {}
                for (const parameter of template.parameters) {
                  if (parameter.default !== undefined) defaults[parameter.id] = String(parameter.default)
                }
                setValues(defaults)
              }
            }}
          >
            <span className={styles.cardName}>{template.name}</span>
            <span className={styles.cardMeta}>
              {template.stateCount} 状态 · {template.agents.length} 个 Agent
            </span>
          </button>
          <p className={styles.cardDesc}>{template.description}</p>
          {expanded === template.id ? (
            <ParameterForm
              template={template}
              values={values}
              setValues={setValues}
              run={props.run}
              editTemplate={(instanceValues, fileName) => {
                props.editTemplate(template.id, instanceValues, workspacePath, fileName)
              }}
            />
          ) : null}
        </li>
      ))}
    </ul>
  )
}

function ParameterForm(props: {
  template: StateTemplateDto
  values: Record<string, string>
  setValues: (next: Record<string, string>) => void
  run: (text: string) => Promise<void>
  editTemplate: (values: Record<string, string>, fileName: string) => void
}): JSX.Element {
  const { template, values, setValues } = props
  const [fileName, setFileName] = useState(`${template.id}.yaml`)
  const set = (id: string, value: string): void => {
    setValues({ ...values, [id]: value })
  }
  const paramFlags = (): string =>
    template.parameters
      .filter((parameter) => values[parameter.id] !== undefined && values[parameter.id] !== '')
      .map((parameter) => `--param ${parameter.id}=${values[parameter.id]}`)
      .join(' ')
  const missing = template.parameters
    .filter((parameter) => parameter.required && (values[parameter.id] === undefined || values[parameter.id] === ''))
    .map((parameter) => parameter.label)
  return (
    <div className={styles.form}>
      {template.parameters.map((parameter) => (
        <ParameterField
          key={parameter.id}
          parameter={parameter}
          value={values[parameter.id] ?? ''}
          onChange={(value) => { set(parameter.id, value) }}
        />
      ))}
      <label className={styles.field}>
        <span className={styles.label}>实例文件名</span>
        <input type="text" value={fileName} onChange={(event) => { setFileName(event.target.value) }} />
      </label>
      {missing.length > 0 ? <p className={styles.error}>缺少必填参数：{missing.join('、')}</p> : null}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          disabled={missing.length > 0}
          onClick={() => { void props.run(`/workflow run ${template.id} ${paramFlags()} --wait`) }}
        >
          运行
        </button>
        <button
          type="button"
          className={styles.secondary}
          disabled={missing.length > 0}
          onClick={() => { void props.run(`/workflow create ${template.id} ${paramFlags()} --save`) }}
        >
          创建实例
        </button>
        <button
          type="button"
          className={styles.secondary}
          disabled={missing.length > 0}
          onClick={() => { props.editTemplate(values, fileName) }}
        >
          创建并编排
        </button>
      </div>
    </div>
  )
}

function ParameterField(props: {
  parameter: StateParameterDto
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
  if (parameter.type === 'boolean') {
    return (
      <label className={styles.field}>
        <span className={styles.label}>{parameter.label}</span>
        <select value={value} onChange={(event) => { onChange(event.target.value) }}>
          <option value="true">是</option>
          <option value="false">否</option>
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
        <textarea
          rows={3}
          value={value}
          placeholder={parameter.description ?? ''}
          onChange={(event) => { onChange(event.target.value) }}
        />
      </label>
    )
  }
  return (
    <label className={styles.field}>
      <span className={styles.label}>
        {parameter.label}
        {parameter.required ? <span className={styles.required}>*</span> : null}
      </span>
      <input
        type="text"
        value={value}
        placeholder={parameter.description ?? ''}
        onChange={(event) => { onChange(event.target.value) }}
      />
    </label>
  )
}

function WorkflowTab(props: {
  workspaces: AceStateDto['workspaces']
  run: (text: string) => Promise<void>
  onEdit: (workspacePath: string, fileName: string) => void
}): JSX.Element {
  const all = props.workspaces.flatMap((workspace) =>
    workspace.workflows.map((workflow) => ({ ...workflow, workspacePath: workspace.path, workspaceTitle: workspace.title })),
  )
  if (all.length === 0) {
    return <p className={styles.empty}>暂无 workflow 实例，可从「模板」页创建</p>
  }
  return (
    <ul className={styles.list}>
      {all.map((workflow) => (
        <li key={workflow.fileName} className={styles.card}>
          <span className={styles.cardName}>{workflow.name}</span>
          <span className={styles.cardMeta}>
            {workflow.fileName} · {workflow.stateCount} 状态 / {workflow.stepCount} 步 · {workflow.workspaceTitle}
          </span>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              onClick={() => { void props.run(`/workflow run ${workflow.fileName} --wait`) }}
            >
              运行
            </button>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => { props.onEdit(workflow.workspacePath, workflow.fileName) }}
            >
              编排
            </button>
          </div>
        </li>
      ))}
    </ul>
  )
}

function RunsTab(props: {
  workspaces: AceStateDto['workspaces']
  run: (text: string) => Promise<void>
  currentSessionId: () => string | undefined
}): JSX.Element {
  const runs = useMemo(
    () => props.workspaces.flatMap((workspace) => workspace.runs.map((run) => ({ ...run, workspaceTitle: workspace.title }))),
    [props.workspaces],
  )
  if (runs.length === 0) return <p className={styles.empty}>暂无运行记录</p>
  return (
    <ul className={styles.list}>
      {runs.map((run) => (
        <RunCard key={run.runId} run={run} workspaceTitle={(run as RunWithTitle).workspaceTitle} runCommand={props.run} />
      ))}
    </ul>
  )
}

interface RunWithTitle extends StateRunDto {
  workspaceTitle: string
}

function RunCard(props: {
  run: StateRunDto
  workspaceTitle: string
  runCommand: (text: string) => Promise<void>
}): JSX.Element {
  const { run } = props
  const progress = run.totalSteps > 0 ? Math.round((run.completedSteps / run.totalSteps) * 100) : 0
  const resumable = run.status === 'waiting-human' || run.status === 'failed' || run.status === 'stopped' || run.status === 'crashed'
  const stoppable = run.status === 'running' || run.status === 'preparing'
  return (
    <li className={styles.card}>
      <div className={styles.runHead}>
        <span className={styles.cardName}>{run.workflowName}</span>
        <span className={styles.statusBadge} data-status={run.status}>
          {STATUS_TEXT[run.status] ?? run.status}
        </span>
      </div>
      <span className={styles.cardMeta}>
        {props.workspaceTitle} · {run.runId.slice(0, 26)}…
        {run.currentState ? ` · 当前状态：${run.currentState}` : ''}
      </span>
      <div className={styles.progressTrack}>
        <div className={styles.progressFill} style={{ width: `${progress}%` }} />
      </div>
      <ol className={styles.runStates}>
        {run.states.map((state) => (
          <li key={state.state} className={styles.runState} data-verdict={state.verdict}>
            {state.state} → {state.verdict}
          </li>
        ))}
      </ol>
      {run.error ? <p className={styles.error}>{run.error}</p> : null}
      <div className={styles.actions}>
        {resumable ? (
          <button type="button" className={styles.primary} onClick={() => { void props.runCommand(`/workflow resume ${run.runId}`) }}>
            恢复
          </button>
        ) : null}
        {stoppable ? (
          <button type="button" className={styles.secondary} onClick={() => { void props.runCommand(`/workflow stop ${run.runId}`) }}>
            停止
          </button>
        ) : null}
      </div>
    </li>
  )
}
