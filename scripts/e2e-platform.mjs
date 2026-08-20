/**
 * Platform E2E + performance suite against a live dsh web instance serving
 * dsh-ace-harness. Exercises regression, isolation, concurrency, evidence
 * chain, observability, and latency budgets. Usage:
 *   node scripts/e2e-platform.mjs [baseUrl] [workspace]
 * Exits non-zero on any failed assertion.
 */
const baseUrl = process.argv[2] ?? 'http://127.0.0.1:4090'
const workspace = process.argv[3] ?? 'E:\\Code\\typeScript\\ace-dsh-harness'

let passed = 0
let failed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ✗ ${name} ${detail}`)
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}/plugins/dsh-ace-harness${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  })
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text }
  return { status: response.status, body }
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

const SMOKE_YAML = `workflow:
  name: 平台冒烟
  mode: state-machine
  states:
    - name: 采集
      isInitial: true
      isFinal: false
      steps:
        - { name: 心跳, type: script, script: "return { output: 'tick', success: true, data: { n: 1 } }" }
      transitions:
        - { to: 汇总, condition: { verdict: success }, priority: 10, label: 成功 }
    - name: 汇总
      isInitial: false
      isFinal: true
      steps:
        - { name: 合并, type: script, script: "const n = context.stepData['采集/心跳']?.n ?? 0; return { output: 'n=' + n, success: n === 1 }" }
      transitions: []
`

console.log(`\n== 平台化 E2E + 性能 ==\n目标: ${baseUrl}  工作区: ${workspace}\n`)

// ---------- 1. 回归 ----------
console.log('— 回归 —')
const state = await api('/state')
check('state 路由 200 且模板齐全', state.status === 200 && state.body.templates.length >= 8, `templates=${state.body?.templates?.length}`)
const health = await api('/health')
check('health 路由字段齐全', health.status === 200 && health.body.ok === true && typeof health.body.activeRuns === 'number' && typeof health.body.uptimeSec === 'number')

const testStep = await api('/test-step', {
  method: 'POST',
  body: JSON.stringify({ workspace, yaml: SMOKE_YAML, state: '采集', step: '心跳', values: {} }),
})
check('test-step 回归正常', testStep.status === 200 && testStep.body.verdict === 'success')

const testState = await api('/test-state', {
  method: 'POST',
  body: JSON.stringify({ workspace, yaml: SMOKE_YAML, state: '采集', values: {} }),
})
check('test-state 预测转移', testState.status === 200 && testState.body.matchedTransition?.to === '汇总')

const evilWorkspace = await api('/test-state', {
  method: 'POST',
  body: JSON.stringify({ workspace: 'C:\\Windows', yaml: SMOKE_YAML, state: '采集', values: {} }),
})
check('未知工作区被拒绝（隔离）', evilWorkspace.status === 400, `status=${evilWorkspace.status}`)

// ---------- 2. 隔离：脚本环境剥离 ----------
console.log('— 隔离 —')
const envProbeYaml = `workflow:
  name: 环境探针
  mode: state-machine
  states:
    - name: 探针
      isInitial: true
      isFinal: true
      steps:
        - { name: 探测, type: script, script: "const hasProcess = typeof process !== 'undefined'; return { output: hasProcess ? 'LEAK' : 'clean', success: !hasProcess }" }
      transitions: []
`
const probe = await api('/test-state', {
  method: 'POST',
  body: JSON.stringify({ workspace, yaml: envProbeYaml, state: '探针', values: {} }),
})
check('JS 沙箱无 process 句柄（凭证不可达）', probe.body.verdict?.verdict === 'success', probe.body.steps?.[0]?.outputSummary)

// ---------- 3. 并发 ----------
console.log('— 并发 —')
const wfRes = await api(`/workflows/platform-smoke.yaml?workspace=${encodeURIComponent(workspace)}`, {
  method: 'POST',
  body: SMOKE_YAML,
  headers: { 'content-type': 'text/plain; charset=utf-8' },
})
check('冒烟工作流落盘', wfRes.status === 200, `status=${wfRes.status}`)

const archiveBefore = await api(`/runs-history?workspace=${encodeURIComponent(workspace)}&limit=1`)
const totalBefore = archiveBefore.body.total ?? 0

// The service enforces maxConcurrentRuns (default 4): a burst of 10 must
// settle as 4 completed + 6 cleanly rejected, never a partial/corrupt run.
const CONCURRENCY = 10
const fire = (n) =>
  Promise.all(
    Array.from({ length: n }, (_, index) =>
      api('/run', {
        method: 'POST',
        body: JSON.stringify({ workspace, workflow: 'platform-smoke.yaml', values: { batch: String(index) } }),
      }),
    ),
  )
const t0 = Date.now()
const wave1 = await fire(CONCURRENCY)
const wallMs = Date.now() - t0
const okRuns = wave1.filter((run) => run.status === 200 && run.body.status === 'completed')
const rejected = wave1.filter((run) => run.status === 400)
check('并发上限护栏生效（10 突发 → 4 放行 + 6 拒绝）', okRuns.length === 4 && rejected.length === 6, `ok=${okRuns.length} rejected=${rejected.length}`)
check('拒绝信息明确（并发上限）', rejected.every((run) => String(run.body).includes('并发运行数达到上限')))
check('放行的运行互不串扰（runId 唯一）', new Set(okRuns.map((run) => run.body.runId)).size === okRuns.length)
check('放行证据链完整（每运行 2 状态）', okRuns.every((run) => run.body.states.length === 2 && run.body.states[1].steps[0].outputSummary === 'n=1'))
console.log(`  … 突发 ${CONCURRENCY} 墙钟 ${wallMs}ms`)
check('突发墙钟预算（< 30s）', wallMs < 30_000, `${wallMs}ms`)

// Slots must release after completion: a second wave runs to completion too.
const wave2 = await fire(4)
const ok2 = wave2.filter((run) => run.status === 200 && run.body.status === 'completed')
check('并发槽位可回收（第二波 4 个全部完成）', ok2.length === 4, `ok=${ok2.length}`)
const totalOk = okRuns.length + ok2.length

// ---------- 4. 证据链 ----------
console.log('— 证据链 —')
const archiveAfter = await api(`/runs-history?workspace=${encodeURIComponent(workspace)}&limit=1`)
check(`归档实时镜像 +${totalOk}`, archiveAfter.body.total === totalBefore + totalOk, `${totalBefore} -> ${archiveAfter.body.total}`)
const sampleRunId = okRuns[0]?.body.runId ?? ''
const detail = await api(`/runs-history/${encodeURIComponent(sampleRunId)}?workspace=${encodeURIComponent(workspace)}`)
const events = (detail.body.audit ?? []).map((row) => row.event)
check('审计含 start/state-end×2/end', events.filter((e) => e === 'state-end').length === 2 && events.includes('start') && events.includes('end'), events.join(','))
const startEvent = (detail.body.audit ?? []).find((row) => row.event === 'start')
const endEvent = (detail.body.audit ?? []).find((row) => row.event === 'end')
check('start 含 workflowHash（防篡改）', typeof startEvent?.payload?.workflowHash === 'string' && startEvent.payload.workflowHash.length === 64)
check('end 含 evidenceHash + durationMs', typeof endEvent?.payload?.evidenceHash === 'string' && typeof endEvent?.payload?.durationMs === 'number')
const stateEnd = (detail.body.audit ?? []).find((row) => row.event === 'state-end')
check('state-end 含裁决与耗时', typeof stateEnd?.payload?.verdict === 'string' && typeof stateEnd?.payload?.durationMs === 'number')

// ---------- 5. 可观测 ----------
console.log('— 可观测 —')
const stats = await api(`/stats?workspace=${encodeURIComponent(workspace)}`)
check('stats 计数与归档一致', stats.status === 200 && stats.body.totalRuns === archiveAfter.body.total, `stats=${stats.body?.totalRuns} archive=${archiveAfter.body.total}`)
check('stats byStatus 求和一致', Object.values(stats.body.byStatus ?? {}).reduce((a, b) => a + b, 0) === stats.body.totalRuns)
check('stats 含热点矩阵', Array.isArray(stats.body.stateHotspots) && stats.body.stateHotspots.length > 0)
check('stats activeRuns 归零（并发已收尾）', stats.body.activeRuns === 0, `active=${stats.body?.activeRuns}`)

// ---------- 6. 性能 ----------
console.log('— 性能 —')
const samples = { state: [], stats: [], history: [] }
for (let i = 0; i < 20; i += 1) {
  let t = Date.now()
  await api('/state')
  samples.state.push(Date.now() - t)
  t = Date.now()
  await api(`/stats?workspace=${encodeURIComponent(workspace)}`)
  samples.stats.push(Date.now() - t)
  t = Date.now()
  await api(`/runs-history?workspace=${encodeURIComponent(workspace)}&limit=50`)
  samples.history.push(Date.now() - t)
}
const report = (label, values, budget) => {
  const p50 = percentile(values, 50)
  const p95 = percentile(values, 95)
  console.log(`  … ${label}: p50=${p50}ms p95=${p95}ms max=${Math.max(...values)}ms`)
  check(`${label} p95 预算（< ${budget}ms）`, p95 < budget, `p95=${p95}ms`)
}
report('state 路由', samples.state, 800)
report('stats 路由', samples.stats, 200)
report('runs-history 路由', samples.history, 200)

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
if (failed > 0) {
  console.log('失败项:')
  for (const item of failures) console.log(`  - ${item}`)
  process.exit(1)
}
console.log('全部通过 ✓\n')
