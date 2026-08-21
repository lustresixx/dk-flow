# 实施改造报告（可观测性 8 批次，本会话）

> 输入：「方案定稿」批准的变更清单（8 批次：基线门禁 → 收尾修复+审计工厂 → 打点 → 失败记录 → 统计内核 → 缓存 → 工作台消费 → 回归），覆盖需求
> ① 步骤级耗时分布与失败热点统计聚合（含重试次数）；② 审计链对异常/中断/超时路径补 end 事件；③ 工作台运行记录页展示失败热点与耗时分布。
> 约束：**全部测试通过（宿主门禁）、公开 API 不变、不新增运行时依赖、禁止破坏性 git 操作**。
> 前置证据：`docs/architecture-diagnosis-2026-10.md`（P0-A…P2 问题清单）、`docs/observability-patterns-benchmark-2026-10.md`（模式 A–H + F1–F9）、`docs/behavior-baseline-observability-2026-10.md`（HEAD `7bccd4c` 行为基线）。

## 0. 结论摘要

8 批次全部实施完成并逐批提交（`feffe5f`…`74802ce` + 本报告），typecheck / build 双绿（exit 0），运行时冒烟覆盖各批次核心行为全部通过；
**vitest 仍无法在本沙箱执行**（`spawn EPERM`，与基线 §3.2 同一环境边界）——240+ 用例的真实通过状态维持 UNMEASURED，宿主批次 0/8 复跑是唯一对照来源。
公开 API（`lib/index.js`：`Config, apply, inject, name`）逐字不变；触碰模块的既有导出键全部保留（仅新增）；state.json / audit 形状只增字段。

| 批次 | 内容 | 问题 | 提交 |
|---|---|---|---|
| 0 | 基线门禁（宿主 `pnpm test`） | — | 宿主职责，本沙箱不可执行（UNMEASURED） |
| 2 | 收尾修复 + 审计工厂 | P0-A / P1-A / P1-C | `feffe5f` |
| 3 | 打点（单调钟耗时 + 墙钟时间戳） | P1-E（覆盖全部步骤类型） | `c16bebb` |
| 4 | 失败记录（failedSteps + onStepFailed） | P0-B 失败路径 | `4108d32` |
| 5 | 统计内核（单一聚合 + 步骤级统计） | P0-B / P1-B | `1028f21` |
| 6 | 缓存（写时失效 + TTL 兜底） | P2 | `35eaab8` |
| 7 | 工作台消费（/stats 接入运行记录页） | P1-D / 需求③ | `74802ce` |
| 8 | 回归（typecheck/build/导出面/冒烟 + 本报告） | 全部 | 本提交 |

「方案定稿」4 项结构性裁定全部落实：①拒绝路径测试锚定 NO_INITIAL/load 错误、finally 收尾统一覆盖；②additive `RunState.failedSteps` + `onStepFailed`（resume 不跳过）；③打点覆盖全部步骤类型、单调钟测耗时 + 墙钟时间戳；④stats 缓存写时失效（TTL 仅兜底），不破坏 e2e 新鲜断言与 p95。

---

## 1. 批次 2 — 收尾修复 + 审计工厂（P0-A / P1-A / P1-C）`feffe5f`

**问题**（P0-A）：`beginRun` 把 end 事件 / `settleStream` / `finishRun` 全放在 `runStateMachine(options).then(...)` 成功回调；engine 在 try 之外抛出的校验错误（NO_INITIAL、NO_MATCH 终态、load 失败）使 promise reject → 三者全被跳过 → 无 end 行、stream 不 settle（prune 永不调度，条目滞留）、progressTrack 游标泄漏（F1/F9）。

**改动**：
- `src/run-lifecycle.ts` 新增导出 seam：`RunSettleResult`、`SettleRunEndDeps`、`settleRunEnd(deps, workspace, runId, result)`（emit end → settleStream → finishRun → 写 end 审计行）、`settleEngineRun(deps, workspace, runId, run)`（成功路径照旧 settle；拒绝路径以 `status:'failed'` + error + 空 stateOutcomes settle 后**原样 rethrow**，调用方看到的 rejection 语义不变；`release` 仍在 finally；`settleOnce` 守卫保证 settle 最多一次，settle 自身失败不会双写 end 行）。
- `beginRun` 重写为 `() => settleEngineRun(settleDeps, workspace, runId, runStateMachine(options))`。
- 审计事件工厂（P1-C）：`src/store/audit-events.ts` 新增 `auditEvent(kind, fields, at?)` 单点构造（`AuditEventKind` = start/resume/end/state-end/waiting-human/human-resolved）；`progressAuditEvents` 与 lifecycle 的 start/resume/end 全部改经工厂构造。end 行形状冻结不变（`status/error/evidenceHash/durationMs`，e2e `scripts/e2e-platform.mjs:156-162` 契约保持）。
- 测试：新增 `tests/run-lifecycle.spec.ts`（成功路径 end 行 + stream settled + 游标清理 + release；拒绝路径 failed end 行 + rethrow；真实 engine NO_INITIAL 接线；settle 失败仅尝试一次）；`tests/audit-events.spec.ts` 增补工厂形状断言。

**运行时冒烟**：拒绝路径 audit 写 `{event:'end', status:'failed', error:'workflow 缺少 isInitial 状态', evidenceHash:<64hex>, durationMs:null}`，stream settled、active 释放、游标清理；成功路径 `durationMs:5000`。全部符合预期。

## 2. 批次 3 — 打点（P1-E，覆盖全部步骤类型）`c16bebb`

**问题**（F7 + 方案裁定③）：四类步骤（script/llm/subworkflow/agent）的 `startedAt`/`finishedAt` 都在执行**之后**连续两次 `now()` 打点（`src/engine/state-steps.ts:194-195,235-236,265-266,303-304`）——耗时恒 ≈0，state/run 跨度无意义；且全仓无单调钟。

**改动**：
- `StepOutcome` 新增 additive `durationMs?: number`（`src/engine/types.ts`）。
- `state-steps.ts` 新增 `measureExecution(run)`：墙钟 ISO 时间戳**围绕**真实执行取钟（人类可读时间线），耗时用 `performance.now()` 单调钟测量（NTP 免疫）；重试策略步骤的测量包裹整个 retry 循环（耗时含重试）。
- `audit-events.ts` 新增 `stepDurationMs(step)`：**唯一**步骤耗时口径——优先单调钟值，旧数据（无 durationMs）回退时间戳差（G7 缺失处理），供统计层复用。
- 测试：`runner.spec.ts` 增补 agent 与 script 步骤的 `startedAt !== finishedAt` + `durationMs ≥ 实际执行时长` 断言（script 用 15ms busy-wait 钉住 F7 前置缺陷）。

**运行时冒烟**：script/agent/llm 三类步骤均 `equal=false`、durationMs 覆盖真实执行（39.7ms/27.0ms/20.4ms）。**残余观察（非本批次引入）**：`runScriptNode` 成功路径不 `worker.terminate()`，每个 script 步骤遗留一个 worker 线程直至进程退出——既有泄漏（与 `script-runner.spec` 既有 15 用例同一暴露面），不在批准方案内，建议后续单独立项。

## 3. 批次 4 — 失败记录（P0-B 失败路径）`4108d32`

**问题**（方案裁定②）：步骤抛错时没有 StepOutcome（运行直接 failed），失败热点无数据可聚合；且重试耗尽后 attempts 计数丢失。

**改动**：
- `FailedStepRecord`（key/state/step/type/error/attempts/startedAt/finishedAt）+ `RunState.failedSteps?: FailedStepRecord[]`（additive state.json 字段）。
- `retryOnError` 在最终抛出时把 attempt 计数附着到 error 上（不改 error.message，既有断言不变）；`attemptsOf(error)` 读取（无附着 = 1）。
- `StateStepsHooks.onStepFailed`：`executeStateSteps.runOne` 的 catch 中构造失败记录并回调（best-effort，失败吞掉——步骤错误决定运行结局）；**运行 signal 中止时（将 settle 为 stopped）不记录**，避免把取消噪音算作失败热点。
- `runner.executeState` 接线：`runState.failedSteps` 追加 + persist；失败步骤**不在** `pendingState.completedSteps` 中 → resume 会重新执行（裁定②“resume 不跳过”），而失败历史跨 resume 持续累积。
- 测试：`runner.spec.ts` 增补失败记录（attempts=首次+重试）、中止不记录两条。

**运行时冒烟**：`failedSteps: [{key:'主/AI', error:'一直失败', attempts:2, …}]` 持久化到终态快照。

## 4. 批次 5 — 统计内核（P0-B / P1-B）`1028f21`

**问题**：`aggregateRunStats` 与 `combineStatsProjection` 各写一份聚合数学（F4，P1-B）；`WorkspaceRunStats` 无任何步骤级字段（F2，P0-B）。

**改动**：
- `src/store/run-stats.ts` 收敛为**单一内核** `aggregateWorkspaceStats(input)`：runs（含 per-run status）/ stateVerdicts / steps / failedSteps 归一化输入，全部聚合数学只此一份；`aggregateRunStats`（JSON 扫描 feed）与 `combineStatsProjection`（SQL 投影 feed）只做归一化适配（P1-B，`run-stats.spec` 的等价断言继续当契约并扩到步骤级）。
- 新增步骤级字段：`stepCount`、`stepDurationBuckets`（固定桶 `<1s/1-5s/5-30s/30-120s/>120s`，`minMs ≤ d < maxMs`，末桶无界）、`stepDurationPercentiles {p50,p95}`（nearest-rank，与 e2e 同规则）、`stepRetryCount`/`stepRetryTotal`（覆盖完成与失败步骤的执行，attempts>1 计一次重试）、`stepHotspots`（(state,step,verdict) 失败优先 top10）、`failedStepHotspots`（(state,step) 频次优先 top10）。
- `sqlite-archive.queryStatsProjection`：runs 查询补 status；用 JSON1 从 `state_json` 提取原始步骤行（state/step/verdict/attempts/durationMs）与 failedSteps 行，喂同一内核（归档开启时统计与文件扫描逐字节一致）。
- `service.workspaceStats`：JSON feed 映射 steps（`stepDurationMs` 折算有效耗时）与 failedSteps。
- 测试：`run-stats.spec.ts`（桶边界、百分位、重试聚合、热点排序、缺失耗时、双 feed 步骤级等价、桶定义连续性）；`sqlite-archive.spec.ts`（JSON1 提取 attempts/durationMs/failedSteps）。

**运行时冒烟**：JSON feed 与 SQL feed 各自聚合正确（p50/p95、retryCount/Total、hotspots 一致语义）。

## 5. 批次 6 — 缓存（P2，写时失效）`35eaab8`

**问题**：`/stats` 每次调用全量重扫（F8），历史增长必破 e2e p95 200ms 预算；方案裁定④——缓存必须**写时失效**，否则破坏 e2e 新鲜断言（`stats.totalRuns === 归档 total`）与 p95 读数，TTL 仅兜底。

**改动**：
- `src/store/stats-cache.ts`：小型 per-key TTL 缓存（get/set/invalidate/clear），无依赖、可单测。
- `RunPersistence` 新增可选依赖 `invalidateStats?(workspace)`，`persistSnapshot` 在 `saveRunState` 后立即触发（写时失效挂 JSON 真源）。
- `service.workspaceStats`：每 workspace 每 TTL 聚合一次；persist 管线逐次失效；`archiveEnabled`/`activeRuns` 实时计算不入缓存；`setSqliteArchive` 显式失效（JSON ⇄ SQL feed 切换）。
- 测试：`stats-cache.spec.ts`（TTL 命中/过期、写时失效立即 miss、键独立、clear）；`run-persistence.spec.ts`（每次 persist 都触发失效）。

**运行时冒烟**：两次 persist → 两次失效回调；缓存命中/失效/过期语义正确。

## 6. 批次 7 — 工作台消费（P1-D / 需求③）`74802ce`

**问题**：`/stats` 路由无 UI 消费者（F6，client 零引用），是文档上的死路由；需求③要求运行记录页展示失败热点与耗时分布。

**改动**：
- `src/client/Workbench.tsx` 新增 `StatsPanel`：运行记录 tab 的落地视图，轮询 `/stats?workspace=…`（10s，与服务端缓存 TTL 对齐），渲染状态分布 chips、步骤耗时直方图（桶条 + p50/p95）、重试统计（N 步 / M 次）、步骤级失败热点（失败优先）与执行失败热点。
- `src/client/types.ts` 新增 `WorkspaceStatsDto`（手工镜像 `WorkspaceRunStats` + archiveEnabled/activeRuns，附同步注释）。
- `Workbench.module.css` 新增统计面板样式。
- 客户端 bundle 增长 +9.9 kB 原始（gzip +1.7 kB），对应面板与样式，可解释。

## 7. 批次 8 — 回归（本提交）

执行命令与结果（本沙箱实测）：

| 命令 | 结果 | 说明 |
|---|---|---|
| `pnpm typecheck`（tsc 双工程） | **exit 0** | 与基线 §4 同命令 |
| `pnpm build`（tsc×2 + tsdown） | **exit 0** | client.js 985.27 kB（基线 975.39 kB，+9.9 kB 对应 StatsPanel） |
| `pnpm test`（vitest） | **exit 1 = spawn EPERM** | 与基线 §3.2 同根因（vite 加载配置必经 esbuild spawn 管道）；**非测试失败**，宿主复跑唯一对照 |
| esbuild 语法变换 7 个触碰 spec | 全部 OK | vitest 同级 transform 通过 |
| tsc 测试专项检查（临时配置，已删除） | 仅 6 处**既有**类型宽松（`runner.spec` 2 + `transitions.spec` 4，均为改动前代码；项目 typecheck 不含 tests） | 本会话新增/修改测试全部类型干净 |
| 导出面实测 | host `Config, apply, inject, name` 不变；audit-events/run-stats 既有键全保留（新增 auditEvent/stepDurationMs/STEP_DURATION_BUCKETS/aggregateWorkspaceStats）；runner 不变 | `node` 冷导入实录 |
| client bundle 工厂 | `require("process")/require("buffer")` 均无；plain Node 抛 `window is not defined` 为基线预期（web 平台，jsdom 提供 window） | 与基线 §5 一致 |

运行时冒烟脚本（`.test-build/`，gitignored，未提交）：settle 双路径、三类步骤打点、failedSteps 记录、JSON/SQL 双 feed 聚合、缓存失效，全部 exit 0。

## 8. 行为差异声明（预期内，PR 需声明）

1. **拒绝路径新增 end 行**：NO_INITIAL/NO_MATCH 终态/load 失败时，audit 现在写 `{event:'end', status:'failed', error, evidenceHash, durationMs:null}`（此前缺失），stream 正常 settle、游标清理（顺带修复流/游标泄漏）。
2. **步骤耗时真实化**：`StepOutcome.durationMs` 新增；`startedAt/finishedAt` 从“执行后相邻两戳”变为“围绕执行取钟”。
3. **state.json 新增字段**：`StepOutcome.durationMs`、`RunState.failedSteps`（均为 additive，旧数据按缺失处理）。
4. **/stats 新增字段**：stepCount/stepDurationBuckets/stepDurationPercentiles/stepRetryCount/stepRetryTotal/stepHotspots/failedStepHotspots（additive）。
5. **审计行构造点收敛**：形状不变，仅构造经 `auditEvent` 工厂。

## 9. 残余风险与宿主待办

1. **[阻断性]** vitest 无法在本沙箱执行（EPERM）：宿主跑 `pnpm install --frozen-lockfile && pnpm test`，重点 `run-lifecycle.spec.ts`、`run-stats.spec.ts`、`runner.spec.ts`、`audit-events.spec.ts`、`stats-cache.spec.ts`、`refactor-regression.spec.ts`；并对 `pnpm build` 后 `node scripts/e2e-platform.mjs`（真实 dsh 实例）验证 /stats 新鲜断言与 p95 预算（stats 缓存写时失效正为此设计）。
2. **[既有问题观察]** `runScriptNode` 成功路径 worker 不 terminate（脚本步骤线程泄漏）——非本方案引入，建议单独跟进。
3. **[既有问题观察]** `runner.spec`/`transitions.spec` 存在改动前遗留的类型宽松（vitest 不 typecheck，不影响运行）。
4. **[G7]** 旧运行无 `durationMs`：步骤直方图/百分位按缺失排除、`stepCount` 照常计数；文档声明统计起点为打点批次后。
5. **[覆盖边界·已收窄（P1-③）]** 进程被杀/断电时**没有任何代码可执行**，因此这类"崩溃"**不写 end 审计行、也不落盘任何状态**——end 事件保证范围 = 进程内可到达的异常/中断/超时终态路径；e2e 审计断言（`scripts/e2e-platform.mjs:156-162`）与双 feed"逐字节一致"统计均不覆盖进程级被杀。`normalizeStaleRun`（`src/store/run-store.ts:77-88`）只在**读时**把僵尸 `running` 在内存中显示为 `crashed`（不写 audit、不写 state.json，`/workflow resume` 仍可用）——它是**显示层兜底，不是审计兜底**；本报告初版"崩溃写 end 仍由 normalizeStaleRun 读时兜底"的表述过宽，已按此收窄。工作台统计面板为最小展示形态（无交互筛选），后续可按需扩展。

## 10. 交付定位

- 每批次独立提交，commit message 含“改了什么/为什么/对应问题”；全量 diff = `feffe5f..HEAD`（7 个提交 + 本报告）。
- 未触碰方案之外的模块；工作树仅新增预期文件（docs 报告 + 提交），无破坏性 git 操作（无 reset/checkout/clean）。
- 维护者复现路径：逐提交 `git show <hash>` → 跑 §7 命令 → 宿主跑测试与 e2e。

## 11. P1 闭环（对抗审查 → 终审 fail 回退后，本批次）

对抗审查（独立挑战）与终审（git 锚点 + 直接 node 执行复核）裁定当前提交态不放行，3 项 P1 已全部闭环（提交 `7234f3f` / `bfc5658` / 本提交），需求②③与内核/缓存/导出面证据充分，无需重做交付工作：

| P1 | 裁定内容 | 闭环动作 | 证据 |
|---|---|---|---|
| ① 提交态测试红 | `tests/run-stats.spec.ts`「caps step and failed-step hotspots at 10 entries」断言 count=25，与内核契约（步骤行 = 原始执行行、按 (state,step,verdict) 键聚合）矛盾；修复写在工作树但从未提交，提交态必红 | 提交回归步骤的修复（25 个不同键 → 封顶 10 条、每条 count=1；25 个同键 → 单条 count=25，计数不被封顶截断）与 16 条边界用例 `tests/observability-boundary.spec.ts`（拒绝路径 load 错误 end 行、stepDurationMs 全分支、统计内核边缘、缓存失效后重设、failedSteps resume 往返） | `7234f3f`；桥实测 run-stats 12/12、observability-boundary 16/16 |
| ② 旧数据双 feed 口径分裂 | 无 `durationMs` 的旧步骤行：JSON feed 经 `stepDurationMs` 回退时间戳差（实测 5-30s:1 / p50=5000），SQL feed 原始提取为 null（全零桶 / p50=null）——与「归档开启时统计与文件扫描逐字节一致」的核心主张冲突 | SQL feed 的 JSON1 提取补 `startedAt/finishedAt`，并经共享口径 `effectiveStepDurationMs`（单调钟优先、时间戳差回退）折算**有效耗时**；`stepDurationMs` 改为委托该口径。补 DIVERGE 等价钉：归档一条旧式运行（无 durationMs）→ `combineStatsProjection` 与 JSON feed（`aggregateRunStats` + `stepDurationMs`，即 service 的真实映射）**deep-equal**，且耗时确实落桶 | `bfc5658`；直接 node 复算：旧口径全零桶 + p50=null vs 新口径 1-5s:1 / 5-30s:1 / p50=5000；sqlite-archive 12/12、audit-events 10/10 |
| ③ 崩溃窗口主张过宽 | 本报告初版「崩溃（进程被杀）写 end 仍由 `normalizeStaleRun` 读时兜底」表述误导：进程死亡无代码可执行，`normalizeStaleRun` 只读时把内存中的状态显示为 `crashed`，**不写 audit、不写 state.json**——是显示层兜底而非审计兜底 | §9.5 已收窄为准确边界：end 事件保证范围 = 进程内可到达的异常/中断/超时终态路径；进程级被杀不写 end；`normalizeStaleRun` 仅显示层兜底（既有 `tests/stale-run.spec.ts`「不触碰文件」断言即此语义的钉） | 本提交（§9.5 修订） |

**残余门禁（宿主）**：`pnpm install --frozen-lockfile && pnpm test`（35 文件 / 292 用例：288 + 本批次 DIVERGE 钉 1 条 + effectiveStepDurationMs 3 条）与 `node scripts/e2e-platform.mjs`（/stats 新鲜断言 + p95 预算）仍为唯一权威对照——本沙箱 `spawn EPERM` 环境边界不变（本批次桥实测 35 文件 / 278 pass / 4 fail，4 个失败全部为 `pre-commands.spec.ts` 真实 shell 子进程的 EPERM 环境边界，非回归）。
