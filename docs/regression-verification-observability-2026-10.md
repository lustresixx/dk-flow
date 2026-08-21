# 回归验证报告（可观测性改造，defender 批次 8 · HEAD 70069b4 复验）

> 目的：对「运行级可观测性与诊断能力」改造（①步骤级耗时分布与失败热点统计聚合含重试次数；②审计链异常/中断/超时路径补 end 事件；③工作台运行记录页展示失败热点与耗时分布）执行全量回归验证，与
> `docs/behavior-baseline-observability-2026-10.md`（基线锚点 HEAD `7bccd4c`）对比：测试通过率不低于基线、关键行为不变、性能可解释；对改动点补充边界与回归用例。
> 约束：全部测试通过（宿主门禁）、公开 API 不变、不新增运行时依赖、禁止破坏性 git 操作。
> 执行身份：DSH 委派子代理（defender），文件策略 workspace-write，审批提示禁用；未执行任何 git 写操作（无提交/重置/checkout）。
>
> **本版为 P1 闭环提交（`7234f3f`/`bfc5658`/`70069b4`）后的复验**：终审退回的 3 项 P1 已在 HEAD 上闭环，本报告在最终 HEAD 上重新跑通全量并逐项复核闭环证据（§3、§4、§7），替代上一版（HEAD `9baf232`）的 274 pass 数字。

## 0. 结论摘要

- **vitest 在本沙箱仍不可执行**（`spawn EPERM`，与基线 §3.2 同一环境边界），沿用沙箱测试执行桥（`.test-build/harness/`，gitignored）：Node `--experimental-strip-types --experimental-transform-types` + vitest API 子集 shim，同一进程内执行测试与被测生产代码。
- **全量 35 个 spec 文件实测：280 pass / 4 fail / 0 加载失败**（本版在上一版 274 pass 基础上 +6：P1 闭环的 4 条新用例 + 本次新增 2 条边界钉）。4 个 fail 全部为 `pre-commands.spec.ts` 真实 shell 子进程用例的 `spawn EPERM` 环境边界（非产品回归，该文件 7 用例中 3 个纯逻辑用例通过）。另 10 个环境依赖用例经 `describe.skipIf` 未注册（script-file-runner 9 个 python 用例、refactor-regression 1 个 spawn 探针用例），与基线对 python 缺失的预期一致。
- **P1 闭环三项全部复核通过**：①提交态测试红 → HEAD 提交态全绿（run-stats 12/12）；②旧数据双 feed 分裂 → 独立 node 复算 DIVERGE=false，双 feed 逐字节一致（§3）；③崩溃窗口主张 → 实施报告 §9.5 已收窄（本次复核 `normalizeStaleRun` 仅读时显示层兜底，`stale-run.spec.ts` 4/4 通过）。
- **改动点全部绿灯**：run-lifecycle（4）、run-stats（12，含修复后的热点封顶用例）、stats-cache（5）、audit-events（10，含 P1-② 口径 3 条）、runner（29，含 P0-B 失败记录/P1-E 打点）、sqlite-archive（12，含 DIVERGE 钉）、run-persistence（7）、observability-boundary（18，16 条既有 + 本次 2 条新钉）全部通过。
- **本次新增 2 条边界/回归钉**（`tests/observability-boundary.spec.ts`）：①`stepDurationMs` ↔ `effectiveStepDurationMs` 单口径委托守卫（P1-② 根因钉，10 组输入矩阵）；②空工作区 /stats 全字段归零形状（需求③ 全新工作台场景）。全部通过。
- 公开 API 逐字不变（host 4 导出；audit-events/run-stats 仅新增键、runner 不变）；typecheck/build 双绿且与基线同量级（±5% 内）；未新增任何依赖（package.json/pnpm-lock.yaml 与基线逐字一致）；无破坏性 git 操作。

## 1. 环境与基线对照（本会话实测，HEAD `70069b4`）

| 项 | 基线（7bccd4c 时） | 本版复验（HEAD 70069b4 时） |
|---|---|---|
| OS / Node / pnpm | Windows 11 / v22.15.0 / 10.18.2 | 同左（未变） |
| vitest 可执行性 | 不可（spawn EPERM） | 不可（同根因，复测确认） |
| spec 文件数 | 31 | **35**（+run-lifecycle、stats-cache、observability-boundary；catalog/workflow-store 后续提交 +6 用例） |
| 测试用例数（静态计数） | 240 | **294**（本批 +16 边界用例、P1 闭环 +4、本次复验 +2） |
| 实测通过（沙箱桥） | UNMEASURED | **280 pass / 4 fail（环境边界）/ 10 skip（skipIf 未注册）** |

> HEAD 漂移说明：上一版报告锚定 `9baf232`（288 用例 / 274 pass）；此后线性追加 P1 闭环提交 `7234f3f`（提交态测试修复 + 16 边界用例入库）、`bfc5658`（effectiveStepDurationMs 统一口径 + DIVERGE 钉，+4 用例）、`70069b4`（文档收窄，仅 docs）。本版锚定最终 HEAD `70069b4`，294 = 288 + 4（P1 闭环）+ 2（本次新增）。

## 2. 全量测试执行：方法与结果（HEAD `70069b4`）

### 2.1 执行结果（35 文件逐文件）

| 规格文件 | pass/fail | 规格文件 | pass/fail |
|---|---:|---|---:|
| atomic | 3/0 | run-persistence | 7/0 |
| audit-events | 10/0（含 P1-② 口径 3 条） | run-registry | 7/0 |
| catalog | 10/0 | run-selection | 12/0 |
| client-bundle.client | 1/0 | run-stats | 12/0 |
| commands-flags | 4/0 | runner | 29/0 |
| experience | 4/0 | sandbox-env | 2/0 |
| job-outcome | 4/0 | script-file-runner | 8/0（9 python 用例 skipIf 未注册） |
| json-pointer | 6/0 | script-runner | 15/0 |
| load | 12/0 | skill-install | 2/0 |
| observability-boundary（含本次 2 新钉） | **18**/0 | sqlite-archive | 12/0（含 DIVERGE 钉） |
| params-dialog | 9/0 | stale-run | 4/0 |
| pre-commands | **3/4**（4 个 spawn EPERM 环境边界） | stats-cache | 5/0 |
| prompts | 5/0 | step-timeout | 3/0 |
| refactor-regression | 14/0（1 spawn 探针用例 skipIf 未注册） | stream-fold | 4/0 |
| run-lifecycle | 4/0 | tool-filter | 8/0 |
| run-selection | 12/0 | tools-runjson | 3/0 |
| transitions | 15/0 | verdict | 11/0 |
| workflow-model.client | 10/0 | workflow-store | 4/0 |

**合计：35 文件 / 280 pass / 4 fail / 0 加载失败**（退出前强制 `process.exit`：`runScriptNode` 成功路径遗留 worker 线程是既有已知泄漏，见实施报告 §2）。

### 2.2 4 个失败用例的归因（稳定复现 + 非回归证据）

全部为 `tests/pre-commands.spec.ts` 中真实调用 shell 的用例（`echo hello-pre`、`node -e "process.exit(3)"`、stderr 捕获、多命令合并）。

- **稳定复现**：`node -e "require('node:child_process').exec('echo hi', () => {})"` → 同步抛 `spawn EPERM`（沙箱禁子进程管道 stdio；独立探针与 spec 内执行一致）。
- **影响范围**：仅沙箱内不可执行；`src/engine/pre-commands.ts` 在可观测性 diff 外（`git diff 7bccd4c..HEAD -- src/engine/pre-commands.ts` 为空），纯逻辑 3 用例通过，无行为变化。
- **建议回归位置**：宿主复跑 `pnpm test` 时 `pre-commands.spec.ts` 应 7/7。

## 3. P1 闭环复核（终审退回 3 项，HEAD 上逐项独立验证）

| P1 | 终审裁定 | 本版复核动作 | 复核结果 |
|---|---|---|---|
| ① 提交态测试红 | 提交态断言与内核契约矛盾，修复未提交 | 复核 `7234f3f` 已入库：`run-stats.spec.ts`「caps step and failed-step hotspots at 10 entries, preserving per-key counts」改为双场景（25 不同键 → 封顶 10 条每条 count=1；25 同键 → 单条 count=25 不被截断）。**直接 node 复算生产内核**（不经 shim）确认两场景均符合契约（见 §8 证据行）。提交态 run-stats 12/12 | ✅ 闭环 |
| ② 旧数据双 feed 口径分裂 | SQL feed 无 durationMs 旧行原始提取为 null（全零桶/p50=null），与 JSON feed 分裂 | 复核 `bfc5658`：SQL JSON1 提取补 startedAt/finishedAt 并经共享口径 `effectiveStepDurationMs` 折算；`stepDurationMs` 改为委托该口径。**独立 node 脚本**（`.test-build/defender-dualfeed.mjs`）走真实 `SqliteArchive.archiveRun → queryStatsProjection → combineStatsProjection` 与 service 同款 JSON 映射：**DIVERGE=false**，双 feed 逐字节一致，旧数据确实落桶（1-5s:1、5-30s:1、p50=5000，旧口径为全零/p50=null） | ✅ 闭环 |
| ③ 崩溃窗口主张过宽 | 「崩溃写 end 由 normalizeStaleRun 读时兜底」表述误导 | 复核 `70069b4` 收窄的 §9.5：`normalizeStaleRun`（`src/store/run-store.ts:77-88`）仅读时把僵尸 running 在内存显示为 crashed，**不写 audit、不写 state.json**；`stale-run.spec.ts` 4/4 通过（含「不触碰文件」钉） | ✅ 闭环 |

## 4. 新增边界/回归用例（本次复验 +2，累计 18 条 `tests/observability-boundary.spec.ts`，全部通过）

| 分组 | 用例 | 覆盖 |
|---|---|---|
| 拒绝路径 end 行（需求②/P0-A） | load() 抛错 → failed end 行（error/evidenceHash 64hex/durationMs:null）+ stream settled + 游标释放 + 原样 rethrow | 方案裁定①「load 错误」家族 |
| 同上 | 无 outcome 的 completed 结果 → end 行 durationMs:null | runDurationMs([]) 边界 |
| 步骤耗时口径（P1-E/G7） | 优先单调钟值；缺失时回退时间戳差；负/NaN 单调值回退；双无效 → null | stepDurationMs 全分支 |
| **同上（本次新增）** | **`stepDurationMs` 委托 `effectiveStepDurationMs` 的 10 组输入矩阵守卫（单调 42/0、负/NaN/∞/null、缺省、零跨度、垃圾时间戳、双 null），断言两者恒等且等于预期值** | **P1-② 单口径根因钉：两个口径任何再分裂在此即失败，早于 sqlite-archive DIVERGE 钉** |
| 统计内核（P0-B/P1-B） | 百分位 nearest-rank 边缘（1/2/4/10 元素、空 → null） | percentile 边界 |
| 同上 | attempts 缺失视为无重试（retryCount/Total = 0） | 旧数据兼容 |
| 同上 | verdict-null 步骤计入 stepCount/直方图但不进热点 | 归一化输入语义 |
| 同上 | startedAt > finishedAt 的跨度不进 avgDurationMs（60s 有效跨度照算） | 非法跨度过滤 |
| 同上 | 未知状态原样进入 byStatus | 状态集合开放 |
| 同上 | failedStepHotspots 频次优先 + 同频稳定序 | 排序契约 |
| 同上 | 无 steps 的旧投影不抛错、步骤字段归零 | 归档兼容 |
| **同上（本次新增）** | **空工作区 feed（aggregateRunStats([])）全字段归零：totalRuns 0、byStatus {}、avgDurationMs/lastRunAt null、histogram 全 0、百分位 null、热点空** | **需求③ /stats 全新工作台渲染形状** |
| 缓存（P2） | invalidate 后 set → 立即服务新值 | 写时失效 + 重设 |
| 失败记录（P0-B 裁定②） | 失败步骤在 resume 时重新执行（executions=1）且失败历史跨 resume 累积不清空 | 裁定② 核心契约 |
| 同上 | failedSteps 经 state.json 往返保留；无该键的旧状态加载为 undefined | additive 字段持久化 |

另：P1 闭环提交自带的 4 条用例（`audit-events.spec.ts` effectiveStepDurationMs 3 条 + `sqlite-archive.spec.ts` DIVERGE 钉 1 条）在 §2.1 各文件计数中，全部通过。

## 5. 构建/检查/性能对比（基线 §4/§6 对照）

| 项 | 基线（7bccd4c） | 本版复验（HEAD 70069b4） | 差异说明 |
|---|---|---|---|
| `pnpm typecheck` | exit 0 / 3.55s / ≈950MB | **exit 0 / 3.71s** | +4.5%，同量级（tsc 增量缓存 + 新增统计模块） |
| `pnpm build`（tsc×2+tsdown） | exit 0 / 4.42s / ≈956MB | **exit 0 / 4.53s** | +2.5%，同量级 |
| tsdown（client bundle 自报） | 220–222ms | 216ms | 正常波动 |
| lib/ 文件数/体积 | 158 / 3,575,409 B | 161 / 3,661,414 B | +3 文件（workflow-store 等后续提交）；+2.6 KB 对应 bfc5658 口径逻辑 |
| lib/client.js | 975.39 kB（gzip 210.26 kB） | 986.55 kB（gzip 212.38 kB） | 对应 StatsPanel（需求③）+ 工作流命名/热载 UI，可解释 |
| host lib 冷导入 | 148ms | 222ms（上一版实测） | 冷启动单次采样，量级一致，非产品路径变化 |

结论：typecheck/build 双绿、耗时与基线同量级（±5% 内），client bundle 增长与新增功能对应，无异常性能回归。

## 6. 公开 API / 导出面（基线 §5 逐字锚定，本版 node 冷导入实录）

| 面 | 基线 | 本版实测 | 判定 |
|---|---|---|---|
| host（lib/index.js） | Config, apply, inject, name | `["Config","apply","inject","name"]` | ✅ 逐字不变 |
| lib/store/audit-events.js | EMPTY_PROGRESS_TRACK, progressAuditEvents, runDurationMs, sha256Text | 基线 4 键全在 + `auditEvent`、`stepDurationMs`、`effectiveStepDurationMs` | ✅ 仅新增 |
| lib/store/run-stats.js | aggregateRunStats, combineStatsProjection | 基线 2 键全在 + `STEP_DURATION_BUCKETS`、`aggregateWorkspaceStats` | ✅ 仅新增 |
| lib/engine/runner.js | createRunState, runStateMachine | 完全一致 | ✅ 不变 |
| 依赖面 | package.json / pnpm-lock.yaml | `git diff 7bccd4c..HEAD -- package.json pnpm-lock.yaml` **为空** | ✅ 未新增任何依赖 |
| state.json / audit 形状 | — | failedSteps、StepOutcome.durationMs 为 additive；end 行形状冻结（status/error/evidenceHash/durationMs） | ✅ 仅增字段 |

## 7. 与基线的行为等价性核对

- 基线 31 文件 / 240 用例在本沙箱为 UNMEASURED；对照采用「同套件在本桥下全部可测用例通过 + 环境边界用例与基线预期一致」。**全部 30 条可观测性新增用例（26 批次 + 4 P1 闭环）+ 18 条边界用例 + 全部既有用例（除 4 个 spawn 环境边界）绿灯**，未发现行为回归。
- 关键行为不变证据：导出面逐字（§6）；`pre-commands`/`script-runner`/`atomic`/`run-store` 等未触碰模块 `git diff 7bccd4c..HEAD` 为空 + 既有用例全绿；client bundle plain Node 导入抛 `window is not defined` 为基线预期（web 平台）；e2e wire 契约（`/stats` totalRuns 新鲜断言、p95 预算）依赖真实宿主，本沙箱不可执行（残余项，§9）。

## 8. 执行命令与环境证据（可复核）

```
git rev-parse HEAD                     → 70069b4dcacaf3fe5dee1c5117d8031ce5d0e927（工作树仅 3 个未跟踪 docs）
git log --oneline -3                   → 70069b4 / bfc5658 / 7234f3f（P1 闭环，线性）
pnpm test                              → exit 1，spawn EPERM（vitest 启动，环境边界，同基线 §3.2）
node --experimental-strip-types --experimental-transform-types --import ./.test-build/harness/loader.mjs \
     ./.test-build/harness/run-specs.mjs tests
                                       → 35 files / 280 pass / 4 fail（spawn EPERM）/ 0 加载失败 / exit 1
node .test-build/defender-dualfeed.mjs → SQL 与 JSON feed 桶分布逐字节一致 {<1s:0,1-5s:1,5-30s:1,30-120s:0,>120s:0} p50=5000，DIVERGE=false
node -e "combineStatsProjection(...)"  → 25 不同键封顶 10 条 count=1；25 同键聚合单条 count=25（热点封顶契约独立复算）
node .test-build/smoke-*.mjs（6 个）    → 全部 exit 0（settle 双路径 / 打点 / failrec / 双 feed / 缓存 / 导出面）
pnpm typecheck                         → exit 0，3.71s
pnpm build                             → exit 0，4.53s；client.js 986.55 kB / gzip 212.38 kB；tsdown 216ms
node 冷导入 lib/index.js               → exit 0；HOST_EXPORTS=[Config,apply,inject,name]
git diff 7bccd4c..HEAD -- package.json pnpm-lock.yaml → 空（无新依赖）
git status                             → 仅 ?? 3 个未跟踪 docs + M tests/observability-boundary.spec.ts（本次新增 2 钉，未提交）
```

## 9. 未覆盖风险与宿主待办（放行所需补充验证）

1. **[阻断性，同前]** vitest 宿主复跑：`pnpm install --frozen-lockfile && pnpm test`（35 文件 / 294 用例；重点 run-lifecycle、run-stats、runner、audit-events、stats-cache、observability-boundary、refactor-regression）。**预期：除沙箱环境边界外全绿**。
2. **[阻断性]** `node scripts/e2e-platform.mjs`（真实 dsh 实例）：验证 /stats 新鲜断言（totalRuns === 归档 total）、p95 < 200ms 预算（stats 缓存写时失效正为此设计）。
3. **[环境]** pre-commands 4 个 spawn 用例、script-file-runner 9 个 python 用例需宿主环境复核（本沙箱 EPERM/无 python，归为环境边界而非通过）。
4. **[既有观察]** `runScriptNode` 成功路径 worker 不 terminate（本会话 smoke-worker 实测进程悬挂、需强制 exit）——非本方案引入，建议单独立项。
5. **[未覆盖]** 工作台 StatsPanel 的视觉/交互行为、真实宿主 UI 端到端不在本沙箱验证范围（与基线 §7.5 一致）；服务类 `workspaceStats` 全链路（含缓存写时失效接线）无直接单测，语义由 DIVERGE 钉 + run-persistence 失效钉覆盖，宿主 e2e 为最终对照。

## 10. 交付定位

- 本版产出：全量实测数据（§2）、P1 闭环逐项复核（§3，含独立 node 复算）、2 条新边界钉（§4，全部通过）、性能/导出面对比（§5/§6）、残余风险清单（§9）。
- 工作树变更（未提交，供宿主/实现者处置）：`M tests/observability-boundary.spec.ts`（+2 钉）；未跟踪 docs 3 份（行为基线/调研对标/本报告）。
- 无破坏性 git 操作：未执行任何 git 写命令。
