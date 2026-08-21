# 回归验证报告（可观测性改造 · defender 第二轮 · HEAD ba75238）

> ## 修正记录（终审后 · 见 docs/pid-exemption-adjudication-2026-10.md）
>
> 本文 §0/§10 的「并发改动保留原规则语义（无 pid 或 pid 不存活时行为与 HEAD 态逐字一致，仅当 state 携带存活 pid 时才豁免陈旧判定）」主张被后续对抗审查**证伪其充分性**：该主张对「无 pid / pid 不存活」分支成立，但漏述「存活 pid」分支自身为**无界豁免**（挂死检测整体失效，P1-1）且无主机门禁（pid 复用/跨机 false-live，P1-2）—— 属语义变更而非「保留」。裁决（`7803d6c`）以 `PID_LIVE_GRACE_MS`（12 h）上限 + `RunState.hostId` 主机门禁（`isOwnerAlive`）闭环：豁免仅适用于「本机存活 owner 且宽限窗口内」，既有僵尸钉语义（无可信 owner → 纯时间规则）原样保留。本文其余内容（实测数据、闭环复核、8 条钉的说明）不受影响。


> 目的：对「运行级可观测性与诊断能力」改造的 **P1-1 / P1-2 第二轮闭环提交**（`b1ae0fc` / `1ab475b` / `e740897`，HEAD `ba75238`）执行全量回归验证，与
> `docs/behavior-baseline-observability-2026-10.md`（基线锚点 HEAD `7bccd4c`）对比：测试通过率不低于基线、关键行为不变、性能可解释；对改动点补充边界与回归用例。
> 约束：全部测试通过（宿主门禁）、公开 API 不变、不新增运行时依赖、禁止破坏性 git 操作。
> 执行身份：DSH 委派子代理（defender），文件策略 workspace-write，审批提示禁用；**未执行任何 git 写操作**（无提交/重置/checkout/clean）。
>
> **本版与上一版（`docs/regression-verification-observability-2026-10.md`，HEAD 70069b4）的关系**：上一版验证了 P1-①/②/③ 首轮闭环；本版验证对抗审查+终审退回后的 **P1-1（启动窗口槽泄漏+缺 end 行）/ P1-2（陈旧运行双 feed 状态分裂）二轮闭环**，并新增针对这两个改动点的边界钉。

## 0. 结论摘要

- **vitest 在本沙箱仍不可执行**（`spawn EPERM`，与基线 §3.2 同一环境边界），沿用沙箱测试执行桥（`.test-build/harness/`，gitignored）。
- **全量 35 个 spec 文件实测：293 pass / 4 fail / 0 加载失败**（静态 307 用例；HEAD 态 `ba75238` 与「含会话中段并发 pid 改动的工作树」两次复跑一致）。4 个 fail 全部为 `pre-commands.spec.ts` 真实 shell 子进程用例的 `spawn EPERM` 环境边界（该文件与基线 diff 为空，非回归；纯逻辑 3 用例通过）。
- **改动点全部绿灯**：`run-lifecycle` 10/10（含 P1-1 的 6 条钉：start/resume 审计失败、4 连败不泄漏、最坏情形、**新增 ensureSandboxDir 抛错、job 模式缺 jobs 服务**）、`sqlite-archive` 13/13（含 P1-2 陈旧状态 DIVERGE 钉）、`stale-run` 10/10（含 **新增 normalizeRunStatus 单规则边界套件 6 条**）、`audit-events` 10/10、`run-stats` 12/12、`observability-boundary` 18/18、`runner` 29/29。
- **本次新增 8 条边界/回归钉**（工作树未提交，供宿主/实现者处置）：`tests/stale-run.spec.ts` +6（P1-2 共享规则的直接边界矩阵：严格大于边界、终态永不老化、非法时间戳、waiting-human 等非终态）、`tests/run-lifecycle.spec.ts` +2（P1-1 窗口的另两个失败点：ensureSandboxDir 同步抛错、job 模式 jobs 服务缺失）。全部通过。
- **P1-1/P1-2 直接 lib 探针全部 PASS**（`.test-build/defender-prestart-leak.mjs` / `defender-stale-status.mjs` / `defender-dualfeed.mjs`，走真实编译产物 lib/）。
- 公开 API 逐字不变（host 4 导出；audit-events/run-stats 仅新增键、runner 不变）；typecheck/build 双绿且与基线同量级（±5% 内）；未新增任何依赖（package.json/pnpm-lock.yaml 与基线 diff 为空）；无破坏性 git 操作。

## 1. 环境与基线对照（本会话实测，HEAD `ba75238`）

| 项 | 基线（7bccd4c 时） | 上一版（70069b4 时） | 本版复验（HEAD ba75238 时） |
|---|---|---|---|
| OS / Node / pnpm | Windows 11 / v22.15.0 / 10.18.2 | 同左 | 同左（未变） |
| vitest 可执行性 | 不可（spawn EPERM） | 不可（同根因） | 不可（同根因，复测确认） |
| spec 文件数 | 31 | 35 | 35（不变） |
| 测试用例数（静态计数） | 240 | 294 | **307**（上一版 294 + P1-1 钉 4 + 最坏情形钉 1 + 本版新增 8） |
| 实测通过（沙箱桥） | UNMEASURED | 280 pass / 4 fail | **293 pass / 4 fail（环境边界）/ 0 skip** |

> HEAD 漂移说明：本版锚定 `ba75238`（= `ebbf952` + 1 个并发 client 提交 `ba75238`「render self-transitions as a connected loop」，仅触碰 src/client/* 5 个文件，不涉本轮验证模块；实现报告 §12 的 P1 闭环提交链为 5b1ba5c → b1ae0fc → 1ab475b → 007666e → e740897 → ebbf952，全部已入库）。
> **并发工作树变化（本会话期间出现，非本 defender 改动，原样保留）**：另有其他代理在会话中段向工作树写入**未提交**改动（`src/engine/runner.ts` / `src/engine/types.ts` / `src/store/run-store.ts` / `src/store/sqlite-archive.ts`：为 RunState 增加 `pid` 字段，`normalizeStaleRun`/`normalizeRunStatus` 增加「进程存活则不判陈旧」分支与 `isPidAlive`，SQL 投影同步取 `state_json.pid`，error 文案改为「进程已退出」）。该改动触碰 P1-2 同一规则文件，故本版在**含这些并发改动的当前工作树**上复跑全量：35 文件 / 293 pass / 4 fail（与 HEAD 态完全一致，4 个失败仍为 pre-commands spawn EPERM 环境边界）、typecheck exit 0、build exit 0。本版新增的 `normalizeRunStatus` 边界矩阵在并发改动下仍全部通过（stale-run 10/10、sqlite-archive 13/13）：并发改动保留原规则语义（无 pid 或 pid 不存活时行为与 HEAD 态逐字一致），仅当 state 携带存活 pid 时才豁免陈旧判定。并发改动是否入库由宿主/其所有者裁决，与本版交付物相互独立。
> 用例数推导：294（上一版静态）+ 5（b1ae0fc/e740897 的 lifecycle 钉，4→8 再加最坏情形 1）+ 8（本版新增）= 307 ✅。

## 2. 全量测试执行：方法与结果（HEAD `ba75238`）

### 2.1 执行结果（35 文件逐文件）

| 规格文件 | pass/fail | 规格文件 | pass/fail |
|---|---:|---|---:|
| atomic | 3/0 | run-persistence | 7/0 |
| audit-events | 10/0 | run-registry | 7/0 |
| catalog | 10/0 | run-selection | 12/0 |
| client-bundle.client | 1/0 | run-stats | 12/0 |
| commands-flags | 4/0 | runner | 29/0 |
| experience | 4/0 | sandbox-env | 2/0 |
| job-outcome | 4/0 | script-file-runner | 8/0（9 python 用例 skipIf 未注册） |
| json-pointer | 6/0 | script-runner | 15/0 |
| load | 12/0 | skill-install | 2/0 |
| observability-boundary | 18/0 | sqlite-archive | 13/0（含 P1-2 DIVERGE 钉） |
| params-dialog | 9/0 | stale-run | **10/0（含本版新增 6 条）** |
| pre-commands | **3/4**（4 个 spawn EPERM 环境边界） | stats-cache | 5/0 |
| prompts | 5/0 | step-timeout | 3/0 |
| refactor-regression | 14/0（1 spawn 探针用例 skipIf 未注册） | stream-fold | 4/0 |
| run-lifecycle | **10/0（含本版新增 2 条）** | tool-filter | 8/0 |
| transitions | 15/0 | tools-runjson | 3/0 |
| verdict | 11/0 | workflow-model.client | 10/0 |
| workflow-store | 4/0 | | |

**合计：35 文件 / 293 pass / 4 fail / 0 加载失败**（退出前强制 `process.exit`：`runScriptNode` 成功路径遗留 worker 线程是既有已知泄漏，见实施报告 §2）。

执行命令与完整日志（可复核）：
```
node --experimental-strip-types --experimental-transform-types --import ./.test-build/harness/loader.mjs \
     ./.test-build/harness/run-specs.mjs tests
     → 35 files / 293 pass / 4 fail / 0 skip  （日志 .test-build/regression-full-run-ba75238.log）
```

### 2.2 4 个失败用例的归因（稳定复现 + 非回归证据）

全部为 `tests/pre-commands.spec.ts` 中真实调用 shell 的用例（`echo hello-pre`、`node -e "process.exit(3)"`、stderr 捕获、多命令合并）。

- **稳定复现**：`node -e "require('node:child_process').exec('echo hi', () => {})"` → 同步抛 `spawn EPERM`（沙箱禁子进程管道 stdio；独立探针与 spec 内执行一致）。
- **影响范围**：仅沙箱内不可执行；`src/engine/pre-commands.ts` 与 `tests/pre-commands.spec.ts` 在基线 diff 外（`git diff 7bccd4c..HEAD -- src/engine/pre-commands.ts tests/pre-commands.spec.ts` 为空，实测 0 行），纯逻辑 3 用例通过，无行为变化。
- **建议回归位置**：宿主复跑 `pnpm test` 时 `pre-commands.spec.ts` 应 7/7。

## 3. P1-1 / P1-2 二轮闭环复核（终审退回 2 项，HEAD 上逐项独立验证）

| P1 | 终审裁定（可复现场景） | 本版复核动作 | 复核结果 |
|---|---|---|---|
| ① register→beginRun 窗口异常泄漏并发槽 | 4 次 `writeAudit('start')` 失败耗尽 `maxConcurrentRuns=4`：槽永久泄漏、流滞留 `preparing`、无 `end` 审计行（违反需求②） | 复核 `b1ae0fc`（startRun/resumeRun 窗口 try/catch → `settleStartupFailure` 写 end 行+settle 流+释放槽，`beginRun` 与收尾共用 `makeSettleDeps` seam）。**直接 node 执行 lib**（`.test-build/defender-prestart-leak.mjs`）：4 次失败后 activeRuns=0、5 条 end 行均含 evidenceHash、流均 settled、第 5 次 start 仍达审计写入而非「并发数上限」；**本版新增 2 条窗口失败点钉**（ensureSandboxDir 同步抛错 / job 模式缺 jobs 服务）全部通过 | ✅ 闭环 |
| ② 陈旧运行双 feed 状态分裂 | 僵尸运行（非终态、updatedAt 超 10 分钟）：JSON feed 显示 `crashed`，SQL feed 直接读 `runs.status` 仍为 `running`（DIVERGE=true） | 复核 `1ab475b`（抽出单一规则 `normalizeRunStatus`，`normalizeStaleRun` 委托之且行为不变；`queryStatsProjection` 增选 `updated_at` 并对 `runs[].status` 与 `byStatus` 套同一规则）。**直接 node 执行 lib**（`.test-build/defender-stale-status.mjs`）：zombie/fresh/done 三运行 SQL `combineStatsProjection` 与 JSON `aggregateRunStats` 逐字节一致，byStatus={crashed:1,running:1,completed:1}，DIVERGE=false。**本版新增 `normalizeRunStatus` 直接边界矩阵 6 条**（严格大于边界 / 恰在边界不老化 / 终态永不老化 / 非法时间戳 / waiting-human 等非终态参与老化）全部通过 | ✅ 闭环 |

另确认：终审要求的 2 条此前未提交边界钉（单口径委托守卫 + 空工作区归零）已在 `5b1ba5c` 入库，`observability-boundary` 18/18 通过。

## 4. 新增边界/回归用例（本版 +8，全部通过）

### 4.1 `tests/stale-run.spec.ts`（+6）— P1-2 共享单规则的直接边界矩阵

P1-2 的关键是把「陈旧判定」收敛为**单一规则** `normalizeRunStatus`，JSON 与 SQL 两个 feed 都委托它。此前该规则只有间接覆盖（normalizeStaleRun + DIVERGE 钉），规则的自身边界（严格大于、终态豁免、非法时间戳）没有直接钉。新增：

| 用例 | 断言 |
|---|---|
| 越过老化界 → crashed | `normalizeRunStatus('running', now-600001ms)` = 'crashed' |
| **恰在老化界（严格 >）不老化** | `normalizeRunStatus('running', now-600000ms)` = 'running'（防 `>=` 离一错误在双 feed 再分裂） |
| 新鲜非终态保持 | 600001ms 内 = 'running' |
| 终态永不老化 | completed/failed/stopped/crashed 无论多旧都原样 |
| 非法时间戳视为新鲜 | 'not-a-date' = 'running'（与 normalizeStaleRun 既有钉同语义，锁共享规则） |
| 任意非终态参与老化 | 'waiting-human' 旧→crashed、新→waiting-human |

### 4.2 `tests/run-lifecycle.spec.ts`（+2）— P1-1 窗口的另两个失败点

P1-1 修复的 try/catch 覆盖 register→hand-off 之间的**任何**失败；既有 4 条钉只覆盖了审计写入失败。新增另外两个真实失败点，验证收尾的通用性：

| 用例 | 断言 |
|---|---|
| **ensureSandboxDir 同步抛错**（流尚未打开） | 原错误 rethrow；end 事件 {failed}；流未打开（settleStream 对缺失条目是 no-op 不炸）；槽释放（activeRuns=0）；audit.jsonl 有 end 行 status=failed/error='sandbox boom' |
| **job 模式缺 jobs 服务**（detachAsJob 在窗口内抛错） | 原错误 rethrow（'当前 profile 未挂载 jobs 服务，无法以后台 job 方式运行'）；end 事件 {failed}；流 settled；槽释放；end 行含完整错误消息 |

## 5. 构建/检查/性能对比（基线 §4/§6 对照）

| 项 | 基线（7bccd4c） | 上一版（70069b4） | 本版（HEAD ba75238） | 差异说明 |
|---|---|---|---|---|
| `pnpm typecheck` | exit 0 / 3.55s / ≈950MB | exit 0 / 3.71s | **exit 0 / 3.72s** | +4.8%（相对基线），同量级，tsc 增量缓存波动 |
| `pnpm build`（tsc×2+tsdown） | exit 0 / 4.42s / ≈956MB | exit 0 / 4.53s | **exit 0 / 4.37s** | -1.1%（相对基线），同量级 |
| tsdown（client bundle 自报） | 220–222ms | 216ms | **215ms** | 正常波动 |
| lib/client.js | 975.39 kB（gzip 210.26 kB） | 986.55 kB（gzip 212.38 kB） | **993.05 kB（gzip 214.32 kB）** | +17.66 kB：对应 StatsPanel（需求③）+ 并发 client 提交（SelfLoopEdge 环状自转移渲染、workflow-model 改动），可解释 |
| host lib 冷导入 | 148ms | 222ms（上一版实测） | 未重测（两次前序采样量级一致） | 冷启动单次采样，非产品路径变化 |

结论：typecheck/build 双绿、耗时与基线同量级（±5% 内），client bundle 增长与新增功能/并发改动对应，无异常性能回归。

## 6. 公开 API / 导出面（基线 §5 逐字锚定，本版 node 冷导入实录）

| 面 | 基线 | 本版实测（lib/ 重建后） | 判定 |
|---|---|---|---|
| host（lib/index.js） | Config, apply, inject, name | `["Config","apply","inject","name"]` | ✅ 逐字不变 |
| lib/store/audit-events.js | EMPTY_PROGRESS_TRACK, progressAuditEvents, runDurationMs, sha256Text | 基线 4 键全在 + `auditEvent`、`stepDurationMs`、`effectiveStepDurationMs` | ✅ 仅新增 |
| lib/store/run-stats.js | aggregateRunStats, combineStatsProjection | 基线 2 键全在 + `STEP_DURATION_BUCKETS`、`aggregateWorkspaceStats` | ✅ 仅新增 |
| lib/engine/runner.js | createRunState, runStateMachine | 完全一致 | ✅ 不变 |
| 依赖面 | package.json / pnpm-lock.yaml | `git diff 7bccd4c..HEAD -- package.json pnpm-lock.yaml` **为空（0 行）** | ✅ 未新增任何依赖 |
| state.json / audit 形状 | — | failedSteps、StepOutcome.durationMs 为 additive；end 行形状冻结（status/error/evidenceHash/durationMs）；`normalizeRunStatus` 为新增导出但属 run-store 内部共享规则（既有导出面不动） | ✅ 仅增字段/函数 |

## 7. 与基线的行为等价性核对

- 基线 31 文件 / 240 用例在本沙箱为 UNMEASURED；对照采用「同套件在本桥下全部可测用例通过 + 环境边界用例与基线预期一致」。**全部可观测性新增用例 + 18 条边界用例 + P1-1/P1-2 闭环钉 + 既有用例（除 4 个 spawn 环境边界）绿灯**，未发现行为回归。
- 关键行为不变证据：导出面逐字（§6）；`pre-commands`/`script-runner`/`atomic`/`run-store`（除 normalizeRunStatus 委托重构，行为经 stale-run 4/4 + 本版 6 条边界钉锁定）等未触碰模块 diff 为空 + 既有用例全绿；client bundle plain Node 导入抛 `window is not defined` 为基线预期（web 平台）；e2e wire 契约（`/stats` totalRuns 新鲜断言、p95 预算）依赖真实宿主，本沙箱不可执行（残余项，§9）。

## 8. 执行命令与环境证据（可复核）

```
git rev-parse HEAD                     → ba752388ebf5c98db22236cfb7c190f4b4fc5cd2
git status --short                     → M src/engine/runner.ts、M src/engine/types.ts、M src/store/run-store.ts、M src/store/sqlite-archive.ts（并发未提交改动，非本 defender 产物）
                                         M tests/run-lifecycle.spec.ts、M tests/stale-run.spec.ts（本版新增钉，未提交）+ ?? 4 个未跟踪 docs
git diff ebbf952..ba75238 --name-only  → 仅 src/client/* 5 个文件（并发 client 提交，不涉验证模块）
pnpm test                              → exit 1，spawn EPERM（vitest 启动，环境边界，同基线 §3.2）
node --experimental-strip-types --experimental-transform-types --import ./.test-build/harness/loader.mjs \
     ./.test-build/harness/run-specs.mjs tests
                                       → 35 files / 293 pass / 4 fail（spawn EPERM）/ 0 skip（HEAD 态与含并发改动的当前树两次复跑一致；日志 .test-build/regression-full-run-ba75238.log 与 .test-build/regression-full-run-final.log）
node .test-build/defender-prestart-leak.mjs → PASS（P1-1：4 失败后 activeRuns=0、end 行含 evidenceHash、第 5 次仍达审计写入）
node .test-build/defender-stale-status.mjs → PASS（P1-2：SQL/JSON byStatus 均 {crashed:1,running:1,completed:1}，DIVERGE=false）
node .test-build/defender-dualfeed.mjs → PASS（旧数据双 feed 桶分布逐字节一致，p50=5000，DIVERGE=false）
pnpm typecheck                         → exit 0，3.72s（HEAD 态）/ 3.66s（含并发改动当前树）
pnpm build                             → exit 0，4.37s（HEAD 态）/ 4.18s（含并发改动当前树）；client.js 993.05 kB / gzip 214.32 kB；tsdown 215ms / 193ms
node 冷导入 lib/index.js               → exit 0；HOST_EXPORTS=[Config,apply,inject,name]
git diff 7bccd4c..HEAD -- package.json pnpm-lock.yaml → 空（无新依赖）
git diff 7bccd4c..HEAD -- src/engine/pre-commands.ts tests/pre-commands.spec.ts → 空（4 个失败确为环境边界）
```

## 9. 未覆盖风险与宿主待办（放行所需补充验证）

1. **[阻断性，同前]** vitest 宿主复跑：`pnpm install --frozen-lockfile && pnpm test`（35 文件 / 307 用例；重点 run-lifecycle、stale-run、sqlite-archive、runner、audit-events、stats-cache、observability-boundary、refactor-regression）。**预期：除沙箱环境边界外全绿**。
2. **[阻断性]** `node scripts/e2e-platform.mjs`（真实 dsh 实例）：验证 /stats 新鲜断言（totalRuns === 归档 total）、p95 < 200ms 预算（stats 缓存写时失效正为此设计）。
3. **[环境]** pre-commands 4 个 spawn 用例、script-file-runner 9 个 python 用例需宿主环境复核（本沙箱 EPERM/无 python，归为环境边界而非通过）。
4. **[既有观察]** `runScriptNode` 成功路径 worker 不 terminate（本会话 smoke-worker 实测进程悬挂、需强制 exit）——非本方案引入，建议单独立项。
5. **[未覆盖]** 工作台 StatsPanel 的视觉/交互行为、真实宿主 UI 端到端不在本沙箱验证范围（与基线 §7.5 一致）；P1-1 窗口的 `makeExecutor`/`resolveWorkflowConfig`/`ctx.emit` 失败点未逐条钉（与 ensureSandboxDir/job 模式同属同一 try/catch 收尾，风险等价，宿主 e2e 为最终对照）。

## 10. 交付定位

- 本版产出：全量实测数据（§2，293 pass/4 fail 全归因，HEAD 态与含并发改动当前树两次复跑一致）、P1-1/P1-2 二轮闭环逐项复核（§3，含直接 lib 探针）、8 条新边界钉（§4，全部通过）、性能/导出面对比（§5/§6）、残余风险清单（§9）。
- 工作树变更（未提交，供宿主/实现者处置）：`M tests/run-lifecycle.spec.ts`（+2 钉）、`M tests/stale-run.spec.ts`（+6 钉）；**`M src/engine/runner.ts`、`M src/engine/types.ts`、`M src/store/run-store.ts`、`M src/store/sqlite-archive.ts` 为会话中段出现的并发未提交改动（pid 存活豁免陈旧判定，跨文件 feed 一致实现），非本 defender 产物，原样保留、未提交、未回滚**；未跟踪 docs 4 份（行为基线/调研对标/上一版回归报告/本报告）。
- 无破坏性 git 操作：未执行任何 git 写命令；并发 client 提交 `ba75238` 与并发工作树改动均为其他代理产物，原样保留。
