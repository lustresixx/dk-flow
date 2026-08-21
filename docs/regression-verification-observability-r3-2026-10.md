# 回归验证报告（可观测性改造 · defender 第三轮 · HEAD 5470a93）

> 目的：对「运行级可观测性与诊断能力」改造的 **pid 存活豁免语义裁决闭环**（并发特性提交 `155570e` + 裁决提交 `7803d6c` + r2 钉入库 `0930954` + 裁决文档 `5470a93`，HEAD `5470a93`）执行全量回归验证，与
> `docs/behavior-baseline-observability-2026-10.md`（基线锚点 HEAD `7bccd4c`）对比：测试通过率不低于基线、关键行为不变、性能可解释；对改动点补充边界与回归用例。
> 约束：全部测试通过（宿主门禁）、公开 API 不变、不新增运行时依赖、禁止破坏性 git 操作。
> 执行身份：DSH 委派子代理（defender），文件策略 workspace-write，审批提示禁用；**未执行任何破坏性 git 操作**（无提交/重置/checkout/clean）。
>
> **本版与上一版（`docs/regression-verification-observability-r2-2026-10.md`，HEAD ba75238）的关系**：上一版验证了 P1-1/P1-2 首轮闭环；本版验证对抗审查+终审退回后的 **pid 豁免裁决批次**（有界宽限 12h + 主机身份门禁 hostId，`7803d6c`）及并发特性提交 `155570e`（projectRoot 透传、workflow 删除、pid 记录），并新增针对这些改动点的边界钉。

## 0. 结论摘要

- **vitest 在本沙箱仍不可执行**（`spawn EPERM`，与基线 §3.2 同一环境边界），沿用沙箱测试执行桥（`.test-build/harness/`，gitignored）。
- **全量 36 个 spec 文件实测：310 pass / 4 fail / 0 skip / 0 加载失败**（静态 324 用例）。4 个 fail 全部为 `pre-commands.spec.ts` 真实 shell 子进程用例的 `spawn EPERM` 环境边界（该文件与基线 `7bccd4c` diff 为空，非回归；纯逻辑 3 用例通过）。
- **通过率不低于任何可比基准**：基线（7bccd4c）沙箱内 UNMEASURED；上一版（ba75238）桥测 293 pass / 4 fail → 本版 **310 pass / 4 fail**（净增 17 个用例全部通过，失败集合与基线/r2 完全相同且均为环境边界）。
- **改动点全部绿灯**：`stale-pid` 8/8（裁决后收紧的豁免语义矩阵）、`stale-run` 14/14（含裁决新增 4 条宽限窗口钉）、`sqlite-archive` 14/14（含 pid 分支双 feed 等价钉）、`run-lifecycle` 10/10（r2 钉入库）、`script-runner` 16/16（projectRoot 上下文）、`runner` 32/32（含**本版新增 3 条钉**）、`audit-events` 10/10、`run-stats` 12/12、`stats-cache` 5/5、`observability-boundary` 18/18。
- **直接 lib 探针全部 PASS**：`.test-build/defender-pid-adjudication.mjs` 20/20 exit 0（裁决语义逐项）；r2 三条闭环探针（prestart-leak / stale-status / dualfeed）在 `7803d6c` 改动后复跑 exit 0，证明裁决未破坏 P1-1/P1-2 既有闭环。
- **本版新增 3 条边界钉 + 修复 2 处既有潜在类型错误**（工作树未提交，供宿主/实现者处置）：`tests/runner.spec.ts` +3（createRunState 记录 pid+hostId、resume 刷新 owner、subworkflow projectRoot 透传）全部通过，且独立 tsc 检查 exit 0。
- 公开 API 逐字不变（host 4 导出）；触碰模块仅增键/函数；无新依赖（package.json/pnpm-lock.yaml 与基线 diff 为空）；state.json 仅增 additive `pid`/`hostId`；无破坏性 git 操作。
- typecheck/build 双绿，与基线同量级（±7% 内，远低于基线 §8 的 ±30% 门禁），差异归因于 tsc 增量缓存状态与新增源码/测试面，非产品路径回归。

## 1. 环境与基线对照（本会话实测，HEAD `5470a93`）

| 项 | 基线（7bccd4c 时） | 上一版（ba75238 时） | 本版复验（HEAD 5470a93 时） |
|---|---|---|---|
| OS / Node / pnpm | Windows 11 / v22.15.0 / 10.18.2 | 同左 | 同左（未变） |
| vitest 可执行性 | 不可（spawn EPERM） | 不可（同根因） | 不可（同根因，复测确认） |
| spec 文件数 | 31 | 35 | **36**（+1：stale-pid.spec.ts） |
| 测试用例数（静态计数） | 240 | 307 | **324**（上版 307 + stale-pid 8 + script-runner 1 + stale-run 宽限 4 + sqlite-archive pid 钉 1 + 本版新增 3） |
| 实测通过（沙箱桥） | UNMEASURED | 293 pass / 4 fail | **310 pass / 4 fail（环境边界）/ 0 skip** |

> 用例数推导：307（上版静态）+ 8（stale-pid）+ 1（script-runner projectRoot）+ 4（stale-run 宽限窗口）+ 1（sqlite-archive 双 feed pid 钉）+ 3（本版 runner 钉）= 324 ✅。逐文件静态计数见 §2.1 附注。
> HEAD 漂移说明：本版锚定 `5470a93`，其前为 `7803d6c`（裁决代码）、`0930954`（r2 钉入库）、`155570e`（并发特性提交：projectRoot 透传/删除 workflow/pid 记录）。`155570e` 与 `7803d6c` 为本轮验证的改动点主体。
> **并发工作树变化（本会话期间出现，非本 defender 改动，原样保留）**：另有代理在会话中段向工作树写入**未提交**改动（`src/projections.ts` +17、`src/client/types.ts` +3：为 step/state 投影 DTO 增加 additive `durationMs` 字段，wall-clock 口径，legacy 行取 null），属工作台消费侧（需求③相关）。已在**含该改动的当前工作树**上复跑：typecheck exit 0（3.75s）、全量桥测 36 文件 / 310 pass / 4 fail（与 HEAD 态逐项一致，4 个失败仍为 pre-commands spawn EPERM 环境边界）。该改动是否入库由宿主/其所有者裁决，与本版交付物相互独立。

## 2. 全量测试执行：方法与结果（HEAD `5470a93`）

### 2.1 执行结果（36 文件逐文件）

| 规格文件 | pass/fail | 规格文件 | pass/fail |
|---|---:|---|---:|
| atomic | 3/0 | run-persistence | 7/0 |
| audit-events | 10/0 | run-registry | 7/0 |
| catalog | 10/0 | run-selection | 12/0 |
| client-bundle.client | 1/0 | run-stats | 12/0 |
| commands-flags | 4/0 | runner | **32/0（含本版新增 3 条）** |
| experience | 4/0 | sandbox-env | 2/0 |
| job-outcome | 4/0 | script-file-runner | 8/0（9 python 用例 skipIf 未注册） |
| json-pointer | 6/0 | script-runner | 16/0（含 projectRoot 上下文钉） |
| load | 12/0 | skill-install | 2/0 |
| observability-boundary | 18/0 | sqlite-archive | 14/0（含 pid 双 feed 等价钉） |
| params-dialog | 9/0 | stale-pid | **8/0（裁决后豁免语义矩阵）** |
| pre-commands | **3/4**（4 个 spawn EPERM 环境边界） | stale-run | **14/0（含裁决新增 4 条宽限钉）** |
| prompts | 5/0 | stats-cache | 5/0 |
| refactor-regression | 14/0（1 spawn 探针用例 skipIf 未注册） | step-timeout | 3/0 |
| run-lifecycle | 10/0（r2 钉已入库） | stream-fold | 4/0 |
| transitions | 15/0 | tool-filter | 8/0 |
| verdict | 11/0 | tools-runjson | 3/0 |
| workflow-model.client | 10/0 | workflow-store | 4/0 |

**合计：36 文件 / 310 pass / 4 fail / 0 skip / 0 加载失败**（退出前强制 `process.exit`：`runScriptNode` 成功路径遗留 worker 线程是既有已知泄漏，见实施报告 §2）。

执行命令与完整日志（可复核）：
```
node --experimental-strip-types --experimental-transform-types --import ./.test-build/harness/loader.mjs \
     ./.test-build/harness/run-specs.mjs tests
     → 36 files / 310 pass / 4 fail / 0 skip  （日志 .test-build/regression-full-run-r3-final.log）
```

### 2.2 4 个失败用例的归因（稳定复现 + 非回归证据）

全部为 `tests/pre-commands.spec.ts` 中真实调用 shell 的用例（`captures stdout and a zero exit code`、`reports non-zero exits without rejecting`、`captures stderr`、`renders combined output with command lines and exit markers`）——与基线/r2 的失败集合**完全相同**（同 4 条）。

- **稳定复现**：`node -e "require('node:child_process').exec('echo hi', () => {})"` → 同步抛 `spawn EPERM`（沙箱禁子进程管道 stdio；独立探针与 spec 内执行一致）。
- **影响范围**：仅沙箱内不可执行；`src/engine/pre-commands.ts` 与 `tests/pre-commands.spec.ts` 在基线 diff 外（`git diff 7bccd4c..HEAD -- src/engine/pre-commands.ts tests/pre-commands.spec.ts` 为空，实测 0 行），纯逻辑 3 用例通过，无行为变化。
- **建议回归位置**：宿主复跑 `pnpm test` 时 `pre-commands.spec.ts` 应 7/7。

## 3. 本轮改动点复核（155570e + 7803d6c + 0930954 + 5470a93）

| 改动点 | 复核动作 | 复核结果 |
|---|---|---|
| **pid 存活豁免裁决**（`7803d6c`：`PID_LIVE_GRACE_MS=12h` 有界宽限 + `hostId` 主机门禁，`normalizeRunStatus`/`isOwnerAlive` 单一共享规则，JSON/SQL 双 feed 同规则） | 全量桥测相关 5 文件 58/58 通过（stale-pid 8 + stale-run 14 + sqlite-archive 14 + run-lifecycle 10 + runner 32）；**直接 lib 探针 `defender-pid-adjudication.mjs` 20/20 PASS exit 0**（规则分档、isOwnerAlive 4 组合、normalizeStaleRun 端到端慢步骤/挂起/跨机/死pid/无host、createRunState 记录、双 feed byStatus 逐字节一致 DIVERGE=false） | ✅ 闭环且与裁决文档 §3 语义表逐条一致 |
| **r2 钉入库**（`0930954`：run-lifecycle +2、stale-run +6） | run-lifecycle 10/10、stale-run 14/14（含入库钉） | ✅ 已入库且全绿 |
| **并发特性提交 `155570e`**（pid 记录：createRunState 记 `process.pid`、runStateMachine resume 刷新；projectRoot 透传至脚本/子工作流；workflow DELETE） | 桥测：script-runner 16/16（context.projectRoot 钉）、runner 32/32（含**本版新增** createRunState 记录钉 + resume 刷新钉 + 子工作流 projectRoot 透传钉）；SQL 投影 `json_extract(state_json,'$.pid'/'$.hostId')` 经双 feed 等价钉锁定 | ✅ 全部通过，无行为回归 |
| **裁决文档 `5470a93`** | docs 批次，未触碰代码 | ✅ 与实现一致 |

另确认：r2 闭环探针（`.test-build/defender-prestart-leak.mjs` / `defender-stale-status.mjs` / `defender-dualfeed.mjs`）在 `7803d6c` 改动后复跑 **exit 0**——裁决未破坏 P1-1（启动窗口槽释放+end 行）与 P1-2（双 feed 陈旧一致）既有闭环。

## 4. 本版新增边界/回归用例（`tests/runner.spec.ts` +3 钉 +2 修复，全部通过）

本版改动点（pid/hostId 生命周期、projectRoot 透传）此前只有探针覆盖、spec 零覆盖的缺口；另修复 2 处既有潜在类型错误（见 §4.3）。

### 4.1 createRunState 记录 owner（pid + hostId）

陈旧归一化只在「记录机器 == 当前机器 且 pid 存活」时信任 owner（`isOwnerAlive` 主机门禁）。createRunState 必须把 pid 与机器身份**一起**记录，否则豁免永远不可能成立。此前仅探针覆盖，spec 无钉。新增：

| 用例 | 断言 |
|---|---|
| records the running process as owner (pid + hostId) when a run is created | `created.pid === process.pid`、`created.hostId === hostname()` |

### 4.2 resume 刷新 owner（P1-1/P1-2 生命周期钉）

runStateMachine 在 load 后、首次 persist 前刷新 `state.pid = process.pid`、`state.hostId = hostname()`（`src/engine/runner.ts:95-98`）——「新进程接管旧运行」的语义，裁决文档 §5 明确「resume 刷新 hostId」但无 spec 钉。新增：

| 用例 | 断言 |
|---|---|
| refreshes pid + hostId on (re)start, taking ownership from a stale foreign owner | 持久化状态携带死 pid + 异机 hostId → resume 完成后**末次持久化** `pid === process.pid`、`hostId === hostname()`（旧 owner 不存活于新运行） |

### 4.3 subworkflow projectRoot 透传（155570e 特性钉）

`state-steps.ts:297` 将 `run.context.projectRoot` 作为 `inheritedProjectRoot` 传入 `runSubworkflowStep`（`types.ts:192` 新增字段）；`step-executor-factory.ts` 在非空时注入子工作流 `inputs.projectRoot`。子工作流侧的工厂接线无独立 spec 钉（makeStepExecutor 无测试桩），本钉锁定**步骤边界契约**（engine → executor 的输入转发）：

| 用例 | 断言 |
|---|---|
| forwards the parent workflow projectRoot to subworkflow steps | 父 config `context.projectRoot='/proj/ws'` → executor 收到 `input.inheritedProjectRoot === '/proj/ws'` |

### 4.4 修复：2 处既有潜在类型错误（P3 发现）

独立 tsc 检查 `tests/runner.spec.ts` 发现 2 个**既有**测试（subworkflow 映射测试、脚本流水线测试）的 `StepExecutor` 对象字面量缺 `runLlmStep`（`TS2741`）。归因：`runLlmStep` 于提交 `7cea922`（fast llm node type）加入接口并成为必填，早于 ba75238（`git merge-base --is-ancestor 7cea922 ba75238` = 0），**非本轮回归**；tests/ 不在 tsconfig include 内，`pnpm typecheck` 从不覆盖 spec 文件，故长期潜伏（vitest 经 esbuild 剥类型不报错）。本版以零行为变更的 throw stub 补齐（stub 永不被调用），使独立 tsc 检查 exit 0。建议：将 tests/ 纳入独立 typecheck（或开启 vitest typecheck），列为后续跟踪项。

## 5. 构建/检查/性能对比（基线 §4/§6 对照）

| 项 | 基线（7bccd4c） | 上一版（ba75238） | 本版（HEAD 5470a93，两轮实测） | 差异说明 |
|---|---|---|---|---|
| `pnpm typecheck` | exit 0 / 3.55s / ≈950MB | exit 0 / 3.72s | **exit 0 / 3.80s、3.75s** | 相对基线 +5.6%~+7.0%，远低于 §8 ±30% 门禁；tsc 增量缓存状态 + 新增源码面（run-store +107 行、sqlite-archive +28、types +18、新测试文件） |
| `pnpm build`（tsc×2+tsdown） | exit 0 / 4.42s / ≈956MB | exit 0 / 4.37s | **exit 0 / 4.64s、4.46s** | 相对基线 +0.9%~+5.0%，同量级，机器负载波动 |
| tsdown（client bundle 自报） | 220–222ms | 215ms | 216ms（build 输出内） | 正常波动 |
| lib/client.js | 975.39 kB（gzip 210.26 kB） | 993.05 kB（gzip 214.32 kB） | **993.74 kB** | 相对基线 +18.35 kB：StatsPanel（需求③）+ 并发 client 提交（Workbench DELETE 按钮等，`155570e` +27 行）+ 既有 client 功能，可解释；相对上版 +0.69 kB |
| 桥测套件耗时 | 未测得（沙箱限制） | ≈4s 量级 | **4.4s**（36 文件） | 与上版同量级，用例 +17 条 |
| host lib 冷导入 | 148ms | 222ms（上版实测） | 未重测（前序采样量级一致） | 冷启动单次采样，非产品路径变化 |

结论：typecheck/build 双绿、耗时与基线同量级（±7% 内，远低于 ±30% 门禁），client bundle 增长与新增功能对应，无异常性能回归。

## 6. 公开 API / 导出面（基线 §5 逐字锚定，本版 node 冷导入实录）

| 面 | 基线 | 本版实测（lib/ 重建后） | 判定 |
|---|---|---|---|
| host（lib/index.js） | Config, apply, inject, name | `["Config","apply","inject","name"]` | ✅ 逐字不变 |
| lib/store/audit-events.js | EMPTY_PROGRESS_TRACK, progressAuditEvents, runDurationMs, sha256Text | 基线 4 键全在 + auditEvent、stepDurationMs、effectiveStepDurationMs | ✅ 仅新增 |
| lib/store/run-stats.js | aggregateRunStats, combineStatsProjection | 基线 2 键全在 + STEP_DURATION_BUCKETS、aggregateWorkspaceStats | ✅ 仅新增 |
| lib/engine/runner.js | createRunState, runStateMachine | 完全一致 | ✅ 不变 |
| lib/store/run-store.js | —（内部模块，非公开面） | 基线已有 STALE_RUN_MS 等 + **PID_LIVE_GRACE_MS、currentHostId、isOwnerAlive、isPidAlive**（裁决新增内部共享助手，非公开 API） | ✅ 仅新增 |
| 依赖面 | package.json / pnpm-lock.yaml | `git diff 7bccd4c..HEAD -- package.json pnpm-lock.yaml` **为空（0 行）** | ✅ 未新增任何依赖 |
| state.json / audit 形状 | — | `pid`、`hostId` 为 additive 字段（缺省时行为 = 纯时间规则，与 155570e 前一致）；failedSteps、StepOutcome.durationMs additive；end 行形状冻结 | ✅ 仅增字段 |

## 7. 与基线的行为等价性核对

- 基线 31 文件 / 240 用例在本沙箱为 UNMEASURED；对照采用「同套件在本桥下全部可测用例通过 + 环境边界用例与基线预期一致」。**全部可观测性新增用例 + 既有用例（除 4 个 spawn 环境边界）绿灯**，通过率从上一版 293 单调升至 310（+17 全过），失败集合与基线/r2 完全相同。
- 关键行为不变证据：导出面逐字（§6）；`pre-commands`/`script-runner`/`atomic`/`run-store` 等未触碰模块（除裁决委托重构）diff 为空 + 既有用例全绿；`normalizeRunStatus` 无 pid 分支与基线逐字等价（stale-run 既有 4 钉 + r2 6 钉 + 裁决 4 钉锁定）；client bundle plain Node 导入抛 `window is not defined` 为基线预期（web 平台）；e2e wire 契约（`/stats` totalRuns 新鲜断言、p95 预算）依赖真实宿主，本沙箱不可执行（残余项，§9）。

## 8. 执行命令与环境证据（可复核）

```
git rev-parse HEAD                     → 5470a93a9d64469d7aac73272a717f2faae7d76a
git status --short                     → M tests/runner.spec.ts（本版新增 3 钉 + 2 修复，未提交）+ ?? 4 个未跟踪 docs（行为基线/调研对标/r1/r2 报告）
git diff 7bccd4c..HEAD --stat          → 16 文件（本轮验证范围内全部已入库）
pnpm test                              → exit 1，spawn EPERM（vitest 启动，环境边界，同基线 §3.2）
node --experimental-strip-types --experimental-transform-types --import ./.test-build/harness/loader.mjs \
     ./.test-build/harness/run-specs.mjs tests
                                        → 36 files / 310 pass / 4 fail（spawn EPERM）/ 0 skip（日志 .test-build/regression-full-run-r3-final.log，套件 4.4s）
                                        → 含并发投影改动复跑：36 files / 310 pass / 4 fail（日志 .test-build/regression-full-run-r3-concurrent.log）
node .test-build/defender-pid-adjudication.mjs → 20/20 PASS，exit 0（裁决语义逐项，含双 feed DIVERGE=false）
node .test-build/defender-prestart-leak.mjs    → exit 0（P1-1 闭环未被裁决破坏）
node .test-build/defender-stale-status.mjs     → exit 0（P1-2 闭环未被裁决破坏）
node .test-build/defender-dualfeed.mjs         → exit 0（旧数据双 feed 一致未被裁决破坏）
npx tsc --noEmit --strict ... tests/runner.spec.ts → exit 0（新增钉 + 2 处既有类型错误修复后）
pnpm typecheck                         → exit 0，3.80s / 3.75s（两轮实测）
pnpm build                             → exit 0，4.64s / 4.46s；client.js 993.74 kB；tsdown 216ms
node 冷导入 lib/index.js               → exit 0；HOST_EXPORTS=[Config,apply,inject,name]
git diff 7bccd4c..HEAD -- package.json pnpm-lock.yaml → 空（无新依赖）
git diff 7bccd4c..HEAD -- src/engine/pre-commands.ts tests/pre-commands.spec.ts → 空（4 个失败确为环境边界）
git merge-base --is-ancestor 7cea922 ba75238 → 0（runLlmStep 必填化早于上一版锚点，2 处类型错误为既有，非本轮回归）
```

## 9. 未覆盖风险与宿主待办（放行所需补充验证）

1. **[阻断性，同前]** vitest 宿主复跑：`pnpm install --frozen-lockfile && pnpm test`（36 文件 / 324 用例；重点 stale-pid、stale-run、sqlite-archive、runner、run-lifecycle、audit-events、stats-cache）。**预期：除沙箱环境边界外全绿**。
2. **[阻断性]** `node scripts/e2e-platform.mjs`（真实 dsh 实例）：验证 /stats 新鲜断言（totalRuns === 归档 total）、p95 < 200ms 预算（stats 缓存写时失效正为此设计）。
3. **[环境]** pre-commands 4 个 spawn 用例、script-file-runner 9 个 python 用例需宿主环境复核（本沙箱 EPERM/无 python，归为环境边界而非通过）。
4. **[既有观察]** `runScriptNode` 成功路径 worker 不 terminate（本会话 smoke-worker 实测进程悬挂、需强制 exit）——非本方案引入，建议单独立项。
5. **[跟踪项，本版新发现]** tests/ 不在 tsconfig include 内，`pnpm typecheck` 不覆盖 spec 文件——本版独立检查暴露 2 处既有类型错误（§4.4，已修复）；建议将 tests/ 纳入独立 typecheck 或开启 vitest typecheck 以防再潜伏。
6. **[未覆盖]** 工作台 StatsPanel/Workbench 的视觉与交互行为、真实宿主 UI 端到端不在本沙箱验证范围；`step-executor-factory.ts` 子工作流 `inputs.projectRoot` 注入（非空守卫）无独立 spec 钉（makeStepExecutor 无测试桩），行为经状态步边界钉（§4.3）+ script 上下文钉 + 类型检查锁定，宿主 e2e 为最终对照；`isPidAlive` 的 EPERM 分支（进程存在但无信号权限）无法在沙箱确定性构造，未直接钉测（代码路径仅影响 alive 判定，属宿主环境复核项）。

## 10. 交付定位

- 本版产出：全量实测数据（§2，310 pass/4 fail 全归因）、本轮改动点逐项复核（§3，含直接 lib 探针 20/20 与 r2 三条闭环探针复跑 exit 0）、3 条新边界钉 + 2 处既有类型错误修复（§4，全部通过且独立 tsc exit 0）、性能/导出面对比（§5/§6）、残余风险清单（§9）。
- 工作树变更（未提交，供宿主/实现者处置）：`M tests/runner.spec.ts`（+3 钉、+2 处 runLlmStep stub 修复、+1 hostname import）；**`M src/projections.ts`、`M src/client/types.ts` 为会话中段出现的并发未提交改动（投影 DTO additive durationMs），非本 defender 产物，原样保留、未提交、未回滚**；未跟踪 docs 5 份（行为基线/调研对标/r1/r2 报告/本报告）。
- 无破坏性 git 操作：未执行任何 git 写命令；并发提交 `155570e`/`7803d6c`/`0930954`/`5470a93` 均为既有入库提交，原样保留。
