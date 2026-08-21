# 行为基线报告（可观测性改造前锚点）

> 目的：在"运行级可观测性与诊断能力"改造（①步骤级耗时分布与失败热点统计聚合含重试次数；②审计链对异常/中断/超时路径补 end 事件；③工作台运行记录页展示失败热点与耗时分布）开始前，
> 记录现有测试、构建、检查与运行时行为基线，作为"不破坏功能、公开 API 不变"的对照锚点。
> 原则：如实记录——基线本身有问题（含环境限制导致无法执行的项）也如实报告。
> 与既有 `docs/behavior-baseline-2026-10.md`（上一轮改造锚点，HEAD `dc7f256`）的关系：本报告为**当前 HEAD 的新一轮锚点**，两者并存，对照时以本报告 HEAD 为准。

## 1. 基线锚点（Baseline Anchor）

| 项 | 值 |
|---|---|
| 记录日期 | 2026-10（本会话） |
| Git HEAD | `7bccd4cd86806da442d38729983fb253122837f1`（branch: main） |
| 工作树状态 | **干净**（clean，无已跟踪文件修改）：仅未跟踪 `docs/observability-patterns-benchmark-2026-10.md`（上一阶段调研证据，未提交） |
| 相比上一基线 HEAD | 自 `dc7f256` 前进 19 个提交（e66e619 起至 7bccd4c），含 refactor 批次与 15 条边界回归测试 |
| 执行身份 | DSH 委派子代理（defender），文件策略 workspace-write，审批提示禁用；未执行任何 git 写操作（无提交/重置/checkout） |
| 约束核验 | 全部测试通过（宿主门禁）、公开 API 不变、不新增运行时依赖、禁止破坏性 git 操作 —— 本步骤仅测量，未改生产代码 |

## 2. 环境（Environment，本会话实测）

| 项 | 值 |
|---|---|
| OS | Microsoft Windows NT 10.0.26200.0（Windows 11），win32 x64 |
| CPU / 内存 | 32 逻辑核；总量 63 GB，空闲 47 GB（node `os` 模块实测） |
| Node | v22.15.0（V8 12.4.254.21-node.24）；engines 要求 `^22.0.0 \|\| >=24.0.0` ✅ |
| pnpm | 10.18.2（pnpm-lock.yaml 存在） |
| TypeScript / vitest / tsdown | ^5.9.2 / ^3.2.4 / 0.22.2（rolldown v1.1.5，配置经 unrun 加载） |
| 测试环境 | vitest.config.ts：`environment: 'node'`，`include: ['tests/**/*.spec.ts']`；`client-bundle.client.spec.ts`、`workflow-model.client.spec.ts` 文件头 `// @vitest-environment jsdom`（jsdom ^30.0.1 在 devDeps） |

## 3. 测试基线（Test Baseline）

### 3.1 测试资产盘点（静态，已实测）

- 规格文件：**31 个** `tests/*.spec.ts`
- 测试用例总数：**240 个**（按 `^\s*(it|test)\(` 逐文件计数，见下表）
- 相比上一基线（dc7f256 时 28 文件 / 209 用例）：新增 `refactor-regression.spec.ts`（15）、`run-persistence.spec.ts`（6）、`run-registry.spec.ts`（7），`tool-filter.spec.ts` 由 5 → 8，净增 **+3 文件 / +31 用例**

| 规格文件 | 用例数 | 规格文件 | 用例数 |
|---|---:|---|---:|
| runner.spec.ts | 25 | catalog.spec.ts | 8 |
| script-file-runner.spec.ts | 17（部分依赖 Python 可用性，可跳过） | tool-filter.spec.ts | 8 |
| script-runner.spec.ts | 15 | run-registry.spec.ts | 7 |
| refactor-regression.spec.ts | 15 | pre-commands.spec.ts | 7 |
| transitions.spec.ts | 15 | json-pointer.spec.ts | 6 |
| load.spec.ts | 12 | run-persistence.spec.ts | 6 |
| run-selection.spec.ts | 12 | prompts.spec.ts | 5 |
| verdict.spec.ts | 11 | audit-events.spec.ts | 4 |
| workflow-model.client.spec.ts | 10（jsdom） | commands-flags.spec.ts | 4 |
| sqlite-archive.spec.ts | 10 | experience.spec.ts | 4 |
| params-dialog.spec.ts | 9 | job-outcome.spec.ts | 4 |
| run-stats.spec.ts | 4 | stale-run.spec.ts | 4 |
| stream-fold.spec.ts | 4 | atomic.spec.ts | 3 |
| step-timeout.spec.ts | 3 | tools-runjson.spec.ts | 3 |
| sandbox-env.spec.ts | 2 | skill-install.spec.ts | 2 |
| client-bundle.client.spec.ts | 1（jsdom） | | |

### 3.2 ⚠️ 测试执行结果：**本沙箱内无法运行，非测试本身失败**

执行命令与实测输出（本会话重跑，与上一基线同根因）：

```
$ pnpm test
exit=1, elapsed=0.68s
Startup Error: failed to load config from E:\Code\typeScript\ace-dsh-harness\vitest.config.ts
Error: spawn EPERM
    at ChildProcess.spawn (node:internal/child_process:420:11)
    at ensureServiceIsRunning (esbuild@0.28.2/lib/main.js:2272:29)
    at bundleConfigFile (vite@7.3.6/.../config.js:35895)
  errno: -4048, code: 'EPERM', syscall: 'spawn'
ELIFECYCLE Test failed.
```

根因：DSH 沙箱禁止程序间管道（named pipe），vite 7 加载配置文件必经 esbuild 异步 `build()` → `child_process.spawn(esbuild 二进制, stdio: pipe)` → EPERM。属上一基线已三层验证的同一环境边界（esbuild 异步 API 无 worker 线程逃逸路径、vitest forks 池同样被禁），**本会话不重复尝试绕过**（沙箱规则：EPERM 为文档化边界，审批提示禁用、不可升级权限）。

**结论**：31 spec / 240 用例的真实通过情况为 **未知（UNMEASURED）**，不是失败。改造放行前必须由宿主在批次 0 跑通并留存输出——这是"全部测试通过"约束的唯一对照来源。

宿主复跑建议命令（无沙箱限制的环境）：

```
pnpm install --frozen-lockfile
pnpm test            # 期望 31 个 spec 文件、240 个用例 pass/fail 明细与耗时
```

## 4. 构建 / 检查基线（全部通过 ✅，本会话实测）

| 命令 | 结果 | 耗时（直接运行） | 峰值内存（node 聚合 WorkingSet，采样法） |
|---|---|---|---|
| `pnpm typecheck`（tsc 双工程 `--noEmit`） | exit 0 | 3.55s（wrapper 复测 3.51s） | ≈ 950 MB |
| `pnpm build`（tsc ×2 + tsdown） | exit 0 | 4.42s（wrapper 复测 4.4s） | ≈ 956 MB |
| └ tsdown（client bundle，自报） | exit 0 | 220–222ms | — |
| `node` 冷导入 `lib/index.js` | exit 0 | 148ms | — |

> 说明：峰值内存为采样 `Get-Process node` 全部 node.exe WorkingSet64 之和的最大值（含 pnpm 调度进程 + tsc 子进程并发），量纲为聚合峰值，非单进程 RSS；方法学固定，后续对照沿用同一采样法。
> 构建时 stderr 有 2 条 tsdown 弃用告警（`external`/`noExternal` → `deps.neverBundle`/`deps.alwaysBundle`）与 pnpm.ps1 包装的 NativeCommandError 呈现噪音，均不影响 exit 0。

构建产物（lib/ 为 .gitignore 忽略目录，不污染工作树）：

| 产物 | 大小（本会话实测） | 上一基线（dc7f256） |
|---|---|---|
| lib/ 文件数 | 158 个，合计 3,575,409 B（≈ 3.41 MB） | 128 个，≈ 3,422.7 KB |
| lib/client.js | 975,395 B（975.39 kB；tsdown 报 gzip 210.26 kB） | 948.7 KB（gzip 208.85 kB） |
| lib/client.js.map | 1,682,064 B | 1,634.2 KB |

> lib 体积增长（128→158 文件）与中间 19 个提交新增的模块（run-lifecycle/run-persistence/run-registry/state-steps/step-executor-factory/host-services/projections/resources/run-meta 等）一致，非本任务改动（本步骤未改任何源文件）。

## 5. 公开 API 基线（机器实测导出面）

- **host 导出（lib/index.js，4 个）**：`Config, apply, inject, name` —— 与上一基线完全一致；冷导入 exit 0，stderr 有 `ExperimentalWarning: SQLite is an experimental feature`（node:sqlite，Node 22.15 实验特性，既有行为，须保持可预期）。
- **client bundle（lib/client.js）**：纯 Node 导入报 `window is not defined` 为预期（platform: web，需 DOM）；client 类型导出面以 `lib/client/index.d.ts` 为准。
- **本特性将触碰模块的导出面（lib 产物实测，逐字锚定）**：
  - `lib/store/audit-events.js` → `EMPTY_PROGRESS_TRACK, progressAuditEvents, runDurationMs, sha256Text`
  - `lib/store/run-stats.js` → `aggregateRunStats, combineStatsProjection`
  - `lib/engine/runner.js` → `createRunState, runStateMachine`
  - 相关既有测试锚点：`audit-events.spec.ts`（4）、`run-stats.spec.ts`（4）、`step-timeout.spec.ts`（3）、`stale-run.spec.ts`（4）、`refactor-regression.spec.ts`（15，含行为基线回归钉）

> 对照锚点：改造后上述导出键集合必须逐字段不变；既有 wire 字段 / state.json 形状仅允许新增字段；audit 事件形状冻结（详见方案定稿）。

## 6. 性能基线（可测项汇总）

| 指标 | 基线值（本会话） | 上一基线（dc7f256） | 测量方式 |
|---|---|---|---|
| typecheck 双工程 | 3.55s / 峰值 ≈950 MB | 5.7s（3.1+2.6） | Stopwatch + 采样法 |
| 完整构建（tsc×2+tsdown） | 4.42s / 峰值 ≈956 MB | ≈ 5.9s | Stopwatch + 采样法 |
| tsdown 打包 | 220–222ms | 226ms | tsdown 自报 |
| host lib 冷导入 | 148ms，exit 0 | < 1s | node 动态 import |
| 测试套件耗时 / 峰值内存 | **未测得**（沙箱限制，见 §3.2） | 未测得 | 待宿主批次 0 补测 |

> typecheck/build 耗时较上一基线下降（5.7s→3.55s、5.9s→4.42s），部分来自 tsc 增量缓存（`.tsbuildinfo` 被 gitignore）与机器负载差异，非缺陷。

## 7. 已知风险与限制（放行前必读）

1. **[阻断性环境限制]** 沙箱 EPERM 导致 vitest 完全无法执行（§3.2）。**240 用例的真实通过状态未知**，是本基线最大的诚实缺口。改造放行前必须由宿主在批次 0 跑通 `pnpm test` 并留存输出，否则"全部测试通过"约束无对照可言。
2. **[基线树]** 本基线在干净树（仅 1 个未跟踪文档）上测量；若后续提交/还原影响 src 或模板，本基线的 lib 产物体积与导出面需重新校准。lib/ 被 gitignore，构建不产生脏树。
3. **[jsdom 依赖]** 11 个用例（client-bundle 1 + workflow-model 10）需 jsdom 环境，宿主复跑时须确认 devDeps 完整安装（`--frozen-lockfile`）。
4. **[Python 依赖]** `script-file-runner.spec.ts`（17 用例）部分用例依赖本机 Python 可用性，缺失时按 skip 处理——宿主复跑记录中 skip 数应与 Python 环境对应，不可误读为失败。
5. **[未覆盖项]** 手工/端到端验证（真实 DSH 宿主加载插件、client UI 交互、工作台运行记录页视觉行为）不在本基线范围；sqlite 实验性 API 在 Node 22→24 升级路径上有变更风险，属跟踪项。
6. **[基线漂移]** 上一基线（dc7f256）与本基线（7bccd4c）间隔 19 个提交，任何涉及这两次基线之间的行为比较需以本报告为准，旧报告仅作趋势参考。

## 8. 对照使用方式（改造期检查清单）

- [ ] 批次 0（宿主）：`pnpm test` 全绿并记录 240 用例耗时/内存 → 补全 §3.2 与 §6 缺口
- [ ] 每批次改造后：§4 命令（typecheck、build）exit 全 0，耗时/峰值内存与 §6 对照（阈值建议：耗时 ±30% 内或逐项解释；内存量级一致）
- [ ] 每批次改造后：§5 host 导出集合与三个模块导出键逐字不变；client bundle 体积与行为可解释（新增 UI 后 bundle 增长应有对应功能解释）
- [ ] 批次 3（行为修正，补 end 事件）前后：逐 spec 对比耗时，回归阈值建议 ±20% 内或逐项解释
- [ ] 全部改造后：`git status` 仅含预期新增文件，无破坏性 git 操作记录

## 9. 证据清单（本会话实测输出可复核）

| 证据 | 位置/方式 |
|---|---|
| vitest EPERM 启动错误全文 | 本报告 §3.2（pnpm test，exit=1, 0.68s） |
| typecheck exit 0 + 3.55s | §4（直接运行 + Start-Process 采样复测 3.51s） |
| build exit 0 + 4.42s、tsdown 220ms、client.js 975.39 kB / gzip 210.26 kB | §4（stdout 实录） |
| lib/ 158 文件 / 3,575,409 B；client.js.map 1,682,064 B | §4（Get-ChildItem 实测） |
| host 导出 {Config, apply, inject, name} + 冷导入 148ms | §5（node 动态 import，exit 0） |
| 三模块导出键（audit-events / run-stats / runner） | §5（node import 实录） |
| 31 spec / 240 用例静态计数 | §3.1（逐文件 Select-String 计数，总和自洽：28+3 文件、209+31 用例） |
| HEAD / 工作树 | §1（git rev-parse + status，7bccd4c，clean） |
