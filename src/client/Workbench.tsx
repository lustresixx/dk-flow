/**
 * The full-page workflow workbench: templates / workflow instances / runs on
 * the left, detail or the React Flow editor on the right. The "后台页面"
 * behind the chat view.
 */
import { useCallback, useEffect, useState } from 'react'
import { EditorPane } from './WorkflowEditor.tsx'
import type { AceStateDto, StateParameterDto, StateRunDto, StateTemplateDto, StateWorkflowDto } from './types.ts'
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
  const [values, setValues] = useState<Record<string, string>>({})

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
        const response = await fetch('/plugins/dsh-ace-harness/instantiate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ templateId, values: instanceValues }),
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
                  onClick={() => {
                    setTemplate(item)
                    const defaults: Record<string, string> = {}
                    for (const parameter of item.parameters) {
                      if (parameter.default !== undefined) defaults[parameter.id] = String(parameter.default)
                    }
                    setValues(defaults)
                  }}
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
                values={values}
                setValues={setValues}
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
  values: Record<string, string>
  setValues: (next: Record<string, string>) => void
  workspacePath: string
  submit: (text: string) => Promise<void>
  instantiateForEdit: (templateId: string, values: Record<string, string>, workspacePath: string, fileName: string) => void
}): JSX.Element {
  const { template, values } = props
  const set = (id: string, value: string): void => props.setValues({ ...values, [id]: value })
  const paramFlags = template.parameters
    .filter((parameter) => values[parameter.id] !== undefined && values[parameter.id] !== '')
    .map((parameter) => `--param ${parameter.id}=${values[parameter.id]}`)
    .join(' ')
  const missing = template.parameters
    .filter((parameter) => parameter.required && (values[parameter.id] === undefined || values[parameter.id] === ''))
    .map((parameter) => parameter.label)
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
              {stateItem.steps.map((step) => `${step.name}${step.agent ? `(${step.agent})` : '(脚本)'}`).join(' → ')}
            </span>
          </li>
        ))}
      </ol>
      <h3 className={styles.sectionTitle}>参数</h3>
      <div className={styles.form}>
        {template.parameters.map((parameter) => (
          <ParameterField key={parameter.id} parameter={parameter} value={values[parameter.id] ?? ''} onChange={(value) => { set(parameter.id, value) }} />
        ))}
      </div>
      {missing.length > 0 ? <p className={styles.errorText}>缺少必填参数：{missing.join('、')}</p> : null}
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={missing.length > 0} onClick={() => { void props.submit(`/workflow run ${template.id} ${paramFlags}`) }}>
          直接运行
        </button>
        <button
          type="button"
          className={styles.secondary}
          disabled={missing.length > 0}
          onClick={() => {
            props.instantiateForEdit(template.id, values, props.workspacePath, `${template.id}.yaml`)
          }}
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
  return (
    <div className={styles.detail}>
      <h2 className={styles.detailTitle}>{workflow.name}</h2>
      <p className={styles.detailDesc}>
        {workflow.fileName} · {workflow.stateCount} 状态 / {workflow.stepCount} 步 · {workflow.source === 'project' ? '项目' : '个人'}
      </p>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={() => { void props.submit(`/workflow run ${workflow.fileName}`) }}>
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
                  {step.agent ? <span className={styles.stepAgent}>{step.agent}</span> : <span className={styles.stepAgent}>脚本</span>}
                  {step.role ? <span className={styles.stepRole}>{step.role}</span> : null}
                  {step.verdict ? (
                    <span className={styles.verdictBadge} data-verdict={step.verdict}>
                      {VERDICT_TEXT[step.verdict] ?? step.verdict}
                    </span>
                  ) : null}
                  {step.outputSummary ? (
                    <pre className={styles.stepOutput}>{step.outputSummary.slice(0, 300)}</pre>
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
