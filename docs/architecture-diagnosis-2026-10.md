# 架构诊断：调度流畅性 / 上下文衔接 / 运行稳定性 / 代码结构 / 用户体验

日期：2026-10 · 基线：`dc7f256` + 工作区未提交改动（`index.ts`/`service.ts` 的 session 绑定运行）
约束：**全部测试通过、公开 API 不变**。证据：`tsc -p tsconfig.json --noEmit` 与 `tsc -p tsconfig.client.json --noEmit` 均 exit 0（本沙箱禁止 node 派生孙进程，esbuild `spawn EPERM` 使 `vitest` 无法启动，需在宿主环境复核 `pnpm test`）。本版经第二轮逐条代码复核，修正 P1-1 的版本语义描述并补充 P1-2⑤、P2-4 与 dsl 浏览器安全约束。

## 模块边界现状（实测依赖图，无循环依赖）

```
dsl/        纯 DSL：types / schema(zod) / load / verdict / json-pointer        无内部依赖
engine/     runner → prompts, script-runner, script-file-runner, transitions, types
            script-file-runner → catalog（resourcesRoot）        ← 层级倒置①
            python-runner → sandbox-env, script-runner
store/      run-store/audit-events/sqlite-archive → engine/types（仅类型）
            workflow-store → dsl/load；skill-install → catalog    ← 层级倒置①
catalog/    → dsl/load, dsl/schema
templates/  → dsl/json-pointer, dsl/load, dsl/schema
service.ts  → catalog, dsl, engine/*, store/*, templates          ← 汇聚点（god class）②
commands.ts → service（仅类型）, params-dialog, engine/types, dsl/types
tools.ts    → service（仅类型）, params-dialog, engine/types, dsl/types
index.ts    → commands, tools, service, dsl/load, store/skill-install + 14 条内联 HTTP 路由③
client/     → dsl/load(workflow-model), 轮询 host 路由
```

图注：①=P2-2（层级倒置）；②=P0-2（god class）；③=index.ts 承担全部 HTTP 路由注册（约 900 行），路由样板（工作区白名单校验 / body 读取 / JSON 应答 / 错误映射）每条路由重复一遍，且 state 路由内含 P0-1 的失效缓存——路由层值得一个 `routes/` 目录 + 共享的 `routeHelpers`。

---

## 问题清单（按严重度排序）

### P0-1 状态路由的"30 秒缓存"是 per-request 的，完全不生效（正确性 + 调度流畅性）
- **位置**：`src/index.ts:170-232`。`topologyCache` / `taskFieldsCache` 两个 `Map` 声明在 `handler` 函数体内部，每次请求重建；注释声称"cached briefly: this route is polled by the panel … re-reading every workflow/run config on each call made the menu lag"，实际行为与注释相反。
- **影响**：面板每 1.5s（AcePanel/LiveRunPanel）+ 4s（Workbench）轮询 `/state`，每次对**所有工作区 × 所有运行 × 所有 workflow** 重新 `readFile + YAML parse + zod 校验`（`resolveWorkflowConfig` → `loadWorkflow` → `parseWorkflowYaml`）。这是当前调度流畅性最大的确定性损耗，且随运行历史线性增长。
- **优化假设**：把两个缓存提升到 `registerWebSurface` 闭包（与 handler 同级），命中逻辑不变、键不变、TTL 不变。纯 bug 修复，响应体形状不变。
- **破坏面**：无 API 变化。风险仅在于缓存过期窗口内编辑 workflow 后拓扑最多滞后 30s——注释表明这本就是设计意图。

### P0-2 `service.ts` god class：1887 行、≥8 种职责汇聚
- **位置**：`src/service.ts`。
- **职责清单**：①内置目录访问（agents/templates/scripts）②模板实例化 ③workflow 实例 CRUD 代理 ④运行生命周期（startRun/resumeRun/stopRun/detachOnTurnAbort/detachAsJob/beginRun）⑤实时流投影（streams Map、stepLog 维护、子会话 transcript 轮询折叠）⑥StepExecutor 工厂（agent/llm/subworkflow/supervisor 四种实现）⑦审计+SQLite 归档+统计 ⑧人工决策门 UI（含中文标签协议）⑨会话注册表访问（requireLiveRoot/listLiveSessions）。
- **结构后果**：引擎测试接缝 `StepExecutor` 之后的主机耦合代码（`makeExecutor` 的 4 个实现、流投影、persist 编排）**完全无单测**——`tests/runner.spec.ts`（1091 行）全部用假执行器。改动运行生命周期时没有任何直接测试网。
- **优化假设**：保持 `AceHarnessService` 公开方法签名不变，内部拆为可独立构造/测试的协作者：
  - `run-registry.ts`：`active`/`streams`/`progressTrack` 三张 Map 的所有权 + prune 策略；
  - `step-executor-factory.ts`：`makeExecutor` 全体 + `stepSignalWithTimeout`/`raceAbort`/`jobOutcomeFor`（后两个已是导出函数，原位 re-export 保 API）；
  - `run-lifecycle.ts`：startRun/resumeRun/beginRun/detach*；
  - `run-persistence.ts`：`engineOptions.persist` 的 文件→SQLite→审计 diff→流投影→事件 编排；
  - 服务类退化为装配 + 委托。
- **破坏面**：`service.ts` 的导出面（default class、`toolFilterFor`、`stepSignalWithTimeout`、`jobOutcomeFor`、`JobOutcomeLike`、`AceRunHandle`、`RunStreamSnapshot`、`TestStepResult` 等）必须原样保留（commands/tools/index 以类型引用，部分被测试直接 import，如 `step-timeout.spec.ts`）。拆分为纯内部重构时不破坏；移动导出符号会破坏。

### P0-3 步骤执行逻辑在 engine 与 service 中重复实现且已发散（上下文衔接）
- **位置**：`src/service.ts:438-662`（testState/testStep/executeTestStep）对照 `src/engine/runner.ts:353-603`（executeState）。
- **已确认的发散点**：
  1. **角色推断不同**：runner 用 `inferRole`（adversarial 状态下按位置推断 defender/attacker/judge，`runner.ts:606-615`）；testState/testStep 用 `step.role ?? 'neutral'`（`service.ts:515`）。独立验证与真实运行的 prompt 角色指令不同 → 产出不可比。
  2. **script verdict 构造不同**：runner 的 rationale 截断到 `CONCLUSION_BUDGET`（`runner.ts:417-423`）；service 用原始 `result.error ?? result.output`（`service.ts:588-591`）。
  3. **segment/join/transition 预测重写一遍**：`service.ts:530-543` 注释自述 "Mirror executeState"——mirroring 即腐化源。
  4. `stepTimeoutMs` 换算在 runner（`runner.ts:70-72`）与 service（`service.ts:410,488`）各写一份。
- **优化假设**：把"单状态步骤序列执行 + 证据交接 + verdict 汇合"下沉为 engine 的导出函数（如 `executeStateSteps(options, machineState, completedSteps, hooks)`），runner.executeState 与 service.testState 共用；service 只保留 sandbox 目录与 DTO 适配。独立验证即"用同一引擎跑单状态"，预测与真实运行天然一致。
- **破坏面**：testState 的**输出文本**会变（角色推断修正后 prompt 变化、script rationale 截断对齐）——无测试钉住 testState，但编辑器"验证状态"按钮的用户可见输出会变；属行为修正，需在 PR 说明。runner 路径不变则 runner.spec 不受影响。

### P1-1 模板/实例解析语义实现 3+1 处、"最新版本"口径不一致（用户体验）
- **位置**：`service.resolveWorkflowConfig`（`service.ts:1404-1420`：实例→模板→文件路径）；`commands.runWorkflow`（`commands.ts:372-408`）；`service.runApi`（`service.ts:1107-1115`，内联重复 commands 逻辑）；`service.instantiate`（`service.ts:691-695`）。
- **具体问题（复核后修正）**：`loadBuiltinTemplates` 按 `id,version` 的 `localeCompare` 升序排序（`catalog/index.ts:75-77`），因此：
  1. `resolveWorkflowConfig` 用 `find` 取**首个匹配 = 最旧版本**，而 `runApi`/`commands`/`tools` 三处 `.sort(...).at(-1)` 取**最新版本**——子工作流解析与编辑器拓扑走路由 A，运行/实例化走路由 B，多版本模板出现即分叉；
  2. `instantiate` 取 `candidates[candidates.length-1]`（=最新，依赖目录排序而非自排序，与前三处实现不同但结果相同）；
  3. 全部用 `localeCompare` 排版本，对 `0.10.0 vs 0.9.0` 这类语义化版本排序错误（`'0.10.0' < '0.9.0'`）。
  当前 resources 下 8 个模板全部只有 `1.0.0`，故为**潜伏**不一致。
- **关联重复**：必填参数缺失时的询问流程（`askMissingTaskInputs`/`askMissingParameters` 编排）在 `commands.ts:354-371,387-406` 与 `tools.ts:146-162,174-191` 各写一份，仅错误文案不同；`runApi` 则无询问直接跑（API 语义），三种入口三种缺参行为。
- **优化假设**：单一 `resolveWorkflowRef(workspace, ref)` + 单一 `latestTemplate(templates)`（版本按 `.` 分段数值比较），四个调用点共用；缺参询问编排提取为 `collectRunInputs(...)` 供 commands/tools 共用，runApi 保持不询问。
- **破坏面**：`resolveWorkflowConfig` 是公开方法（index/commands/子工作流解析使用），签名保留；内部语义统一后，多版本场景的选取结果可能变化——这正是修复目的。commands 的错误提示文案不变；`tools-runjson.spec.ts` 不涉及。

### P1-2 取消与并发原语薄弱（运行稳定性）
- **位置与证据**：
  1. `engine/pre-commands.ts:57-60`：abort 时 reject 但**不 kill 子进程**——停止运行后 shell 命令继续跑（泄漏 + 写竞争）。测试只钉住"启动前已 abort 则 reject"（`tests/pre-commands.spec.ts:24-28`），补 kill 不破测试。
  2. `service.ts:756-761,921-924`：每次运行创建**两个** AbortController（controller+linked）手工桥接，`linked` 无 dispose 路径；语义需读注释才能理解。
  3. `runner.ts:537-548`：并行 segment 的多个 `runOne` 共享可变 `completedSteps` 并各自 `await persist()`——persist 交错（文件写原子故不损坏，但 audit diff 依赖 `progressTrack` 游标，虽 get/set 同步块内无交错，快照内容却时序不确定）；`buildStepEvidence(completedSteps)` 在并行步骤间读到哪步算哪步 → **并行组内证据内容不确定**（上下文衔接问题）。
  4. `streams` 的 `entry.text`/`stepLog[].text` 在一个长步骤内无界增长，step 结束才 `truncate`（`service.ts:1511-1515`）；长运行 + 1.5s 轮询 → 每次快照传输全量 stepLog，内存与带宽双涨。
  5. `resumeRun` 不重建流投影：`streams` 只在 `startRun` 填充（`service.ts:775-807`），`resumeRun` 路径（`service.ts:897-951`）不建条目——恢复的运行在 LiveRunPanel 无实时流（`/stream` 404），且子工作流步骤经 `engineOptions` 复用父 runId 的 stream（`service.ts:1709-1718` 传 `childRunId` 但 streams 无该键），子工作流执行期面板静默。属"上下文衔接"的可观测性断点。
  6. SQLite 归档走 `node:sqlite` 的 **DatabaseSync 同步 API**（`sqlite-archive.ts:136-194`）：`persist` 热路径上每次落盘都同步写 `state_json`（全量证据链，随运行增长），状态路由每 1.5s/4s 轮询又对每个工作区同步 `countRuns`——opt-in 开启后，同步 I/O 直接占用事件循环，长运行的步骤 persist 会造成宿主级顿挫（调度流畅性）。
- **优化假设**：①preCommand abort 时 `child.kill()`（保留 reject 语义）；②双控制器收敛为一个控制器 + detach 决策点显式化（不改外部行为）；③persist 串行化（per-run promise 链），并行组证据改为"segment 开始时快照"语义（确定性）；④流缓冲按 SUMMARY_BUDGET 增量封顶；⑤`resumeRun` 从持久化 RunState + workflow config 重建 stream 条目（拓扑/verdicts/stepLog 由 persist 投影逻辑自然回填）；⑥归档写入移出 persist 串行路径（`queueMicrotask`/定时批量 flush 或 per-workspace 写队列），状态路由的 `countRuns` 复用 P0-1 的 TTL 缓存。
- **破坏面**：③的证据快照语义会改变并行组内后完成步骤所见证据——runner.spec 中并行组用例如断言了证据文本需复核；④截断提前会改变 stepLog 中间态文本（无测试钉住；最终文本不变）。①②⑤为纯加固/补齐；⑥只改写入时序，`sqlite-archive.spec.ts` 直接构造 `SqliteArchive` 测同步 API，不受影响。

### P1-3 人工决策门协议耦合中文展示文案（代码结构 + 稳定性）
- **位置**：`service.ts:1372-1399`。`askHumanTransition` 用 `selected === '批准，继续运行'` / `selected === '停止运行'` 字符串匹配把 UI 标签当协议 token。
- **优化假设**：选项带稳定 `value`（`__continue__`/`stop`），标签仅作展示；匹配 value 而非 label。引擎接口 `askHumanTransition` 返回字符串的契约不变。
- **破坏面**：依赖 `userQuestions.ask` 返回结构中有 value 通道——需先确认 dsh-user-questions rc.7 的 answer 形状；若无 value 通道，则退而保留标签匹配但提取为常量并加注释。这是本清单中**唯一需要宿主能力确认**的项。

### P2-1 RunState → DTO 投影重复 4+1 处（代码结构）
- **位置**：`tools.ts:20-45`（runJson）、`index.ts:292-321`（state 路由 runs）、`index.ts:488-509`（run 路由结果）、`commands.ts:86-125`（renderRun/renderResult）、`client/types.ts`（手工镜像 DTO）。
- **证据**：`attempts`、`data`、`supervisorScore` 等字段在各投影中有无不一——已是 drift 的实例。
- **优化假设**：host 侧单一 `projections.ts` 提供 `runSummaryDto`/`stateOutcomeDto`/`stepOutcomeDto`，四处调用；client/types.ts 保持手工镜像（client 独立打包，无法共享运行时代码）但在字段注释中标记"与 src/projections.ts 同步"。
- **破坏面**：wire 形状逐字段保留即不破 client；`tools-runjson.spec.ts` 钉住 runJson 形状，必须逐字段对齐。

### P2-2 引擎"宿主无关"宣称与实现不符（层级倒置）
- **位置**：`engine/script-file-runner.ts:14` import `catalog/resourcesRoot`；`store/skill-install.ts:11` 同。`docs/ARCHITECTURE.md:14` 宣称 engine "纯 TS，宿主无关"。
- **优化假设**：`resourcesRoot` 下沉到更底层模块（如 `store/paths.ts` 旁的 `packaged-resources.ts`，catalog 与 script-file-runner 都引用它），或把内置脚本目录作为 `ScriptFileOptions.builtinScriptsDir` 由 service 注入。后者更符合依赖方向，但改 `runScriptFile` 签名。
- **破坏面**：注入式改签名会影响 `script-file-runner.spec.ts`（174 行）调用点；最小破坏方案是保持签名、新增可选字段，默认回退到现行为。

### P2-3 隐式全局依赖散布
- **位置**：`service.workspaceOf` 的 `process.cwd()` 回退（`service.ts:1163` 经 `store/paths.ts:14-16`）；`paths.dshHome()` 读 `process.env.DSH_HOME`；`runApi` 的伪 Agent（`{ id: 'api-runner' ... } as unknown as Agent`，`service.ts:1123-1127`）；`ctx.get('jobs'|'agents'|'webServer'...)` 结构断言散在 service/index 多处。
- **优化假设**：在 index.apply 内一次性解析宿主能力为 `HostCapabilities` 对象注入服务（构造参数新增可选字段，默认现行为）；伪 Agent 提取为命名工厂函数并标注最小必需字段。
- **破坏面**：构造参数新增可选字段不破现有 `new AceHarnessService(ctx, config)`（index.ts:129）。

### P2-4 客户端常量与展示逻辑重复（用户体验 + 代码结构）
- **位置与证据**：
  - `ACTIVE_STATUSES = {'preparing','running','waiting-human'}` 重复 4 处：`client/run-selection.ts:7`、`AcePanel.tsx:22`、`LiveRunPanel.tsx:48`、`Workbench.tsx:52`（后者改名 `ACTIVE_RUN_STATUSES`——已现 drift 苗头）；
  - `STATUS_TEXT` 重复 2 处（`LiveRunPanel.tsx:38`、`Workbench.tsx:28`）；步骤类型文案 3 处且措辞不一（`LiveRunPanel.tsx:50` `STEP_KIND_TEXT`、`Workbench.tsx:45` `STEP_TEXT`、`WorkflowEditor.tsx:53` `STEP_TYPE_TEXT`，"子工作流"/"子流" 混用）；
  - `STATE_ROUTE = '/plugins/dsh-ace-harness/state'` 写死 3 处（`AcePanel.tsx:20`、`Workbench.tsx:25`、`workflow-trigger.ts:10`），全部 fetch 调用裸写在组件里，无共享 API client 模块；
  - React Flow 状态节点渲染器 3 份（`LiveRunPanel` 的 `LiveStateNode`、`Workbench.tsx:691` 附近的 topology 节点、`WorkflowEditor` 的 `AceStateNode`），各自维护 verdict 配色与徽标逻辑；
  - `LiveRunPanel.tsx:58-62` 的 `normalizeVerdict`（pass→success 折叠）与 `dsl/verdict.ts` 的 `verdictEquals` 语义平行存在。
- **优化假设**：新增 `client/run-meta.ts`（或并入 `client/types.ts`）导出 `ACTIVE_STATUSES`/`STATUS_TEXT`/`STEP_TYPE_TEXT`/`route(path)` 助手与 verdict 折叠函数，四个组件共用；三个节点渲染器共享 `verdictMeta`（已在 workflow-model.ts）与徽标子组件。纯客户端内部重构，wire 形状不变。
- **破坏面**：`run-selection.spec.ts` 只 import `selectRun`/`sessionRuns`/`RunSelection`/`SelectableRun`，常量移出该文件时保留 re-export 即不破；`workflow-model.client.spec.ts` 不涉及。CSS 类名不变则视觉无回归。

### P3 低危项
| 项 | 位置 | 说明 | 假设 |
|---|---|---|---|
| parseFlags 空白切分 | `commands.ts:28-59` | `--requirement "a b"` 引号内空格被切碎；workbench 用 URI 编码规避 → 两种方言并存 | 支持引号 tokenize，保留 URI 解码兼容；`commands-flags.spec.ts` 现有断言需保持 |
| `truncate` 两份 | `engine/prompts.ts:19` vs `engine/pre-commands.ts:22` | 签名/措辞不同 | 保留各自措辞（输出文本被 prompts.spec/pre-commands.spec 钉住），只注释说明差异是有意的 |
| client 大组件 | `Workbench.tsx` 895 行、`WorkflowEditor.tsx` 988 行 | 与 host 同构的 god 模式 | 本轮不动；host 侧 DTO 稳定后再拆 |
| `normalizeStaleRun` 读时改写状态 | `store/run-store.ts:77-88` | 展示语义混在持久层 | 现行为被 stale-run.spec 钉住且合理，不动 |

---

## "哪些改动可能破坏现有功能"——破坏面台账

**公开 API（package exports `./`）**
- `index.ts`：`name`/`inject`/`Config`/`apply`——不可动。
- `service.ts` 导出符号：default class 及其全部 public 方法（被 commands/tools/index 使用）、`toolFilterFor`、`stepSignalWithTimeout`、`jobOutcomeFor`、`JobOutcomeLike`、`AceHarnessConfig`、`AceRunHandle`、`RunMode`、`RunStreamSnapshot`、`WorkflowScriptEntry`、`TestStepResult`、`TestStateResult`——签名冻结；内部可拆。
- 测试直接 import 的内部符号：`engine/*` 全部公开函数、`store/*`、`dsl/*`、`commands.parseFlags/parseParamFlags`、`tools.runJson`、`catalog/*`——移动文件即破测试 import 路径；同路径原位重构安全。

**持久化与 wire 兼容**
- `state.json` 的 `RunState` 形状：resume 路径直接反序列化旧文件，字段只可增、不可改语义；`normalizeStaleRun`/`resumeRun` 依赖 `status`/`updatedAt`/`parentSessionId`。
- `audit.jsonl` 事件形状：被 `sqlite-archive.backfill` 重放；事件名/字段冻结。
- HTTP 路由路径与响应形状：client 三个面板 + workflow-trigger 写死路径；形状逐字段冻结。
- cordis 事件 `ace/*` 的 payload（`service.ts:180-201` 的 Events 声明）：外部插件可监听，冻结。
- 工具名与 `run_workflow`/`workflow_manage` 参数/输出形状：`tools-runjson.spec.ts` + systemPrompt 文案钉住。
- `/workflow` 命令语法与输出文案：用户肌肉记忆 + `commands-flags.spec.ts`。

**打包边界（易踩的隐式约束）**
- `src/dsl/*` 同时被打进 client bundle（`client/workflow-model.ts` import `dsl/load`）：dsl 模块**不得引入 node 内建或宿主 API**，否则 client 打包即破。`tests/client-bundle.client.spec.ts` 是这道边界的看门测试。向 dsl 加依赖前必须想清它要在浏览器里跑。
- `resources/` 双布局探测（`catalog/resourcesRoot`、`index.ts assetsRoot`）：构建产物布局变化（tsdown/tsc 输出结构调整）会影响资源解析，改动构建配置时需同时验证 `lib/` 与 `src/` 两种布局。

**行为修正类改动（预期内可见差异，需在 PR 声明）**
1. P0-3：testState/testStep 的角色推断与 script rationale 对齐真实运行 → 编辑器"验证状态/步骤"输出变化（无测试钉住）。
2. P1-1：多版本模板的"最新"选取口径变化（当前 resources 全为单版本 1.0.0，无即时影响）。
3. P1-2③：并行组证据快照语义确定化 → runner.spec 并行组断言需复核。
4. P0-1：缓存生效后，面板编辑 workflow 的拓扑刷新最多滞后 30s（注释声称的原设计）。

**验证路径**
- 每步改动后：`pnpm typecheck && pnpm test`（本会话沙箱无法跑 vitest：node 禁止派生孙进程，需宿主环境执行）。
- 针对性复核：`tests/runner.spec.ts`（引擎）、`tests/tools-runjson.spec.ts`（DTO）、`tests/stale-run.spec.ts`、`tests/step-timeout.spec.ts`（取消语义）、`tests/client-bundle.client.spec.ts`（client 打包产物）。
