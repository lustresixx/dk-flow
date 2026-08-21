# pid 存活豁免语义裁决记录（P1-1 / P1-2 闭环 · defender）

> 目的：记录对「pid 感知的陈旧运行归一化」（并发提交 `155570e` 引入）的语义裁决与闭环，回应对抗审查 2 项 P1 行为回归与 1 项验证缺口，以及终审「裁决豁免语义（建议加上限或心跳）、补 foreign-pid/跨机/双 feed 等价钉、提交 8 条未提交 r2 钉、修正 r2 主张」的退回裁定。
> 对应提交：`0930954`（8 条 r2 钉入库）、`7803d6c`（裁决代码 + 钉集更新）、本文档 + r2 文档修正（docs 批次）。
> 执行身份：DSH 委派子代理（defender），文件策略 workspace-write；未执行任何破坏性 git 操作（无 reset/checkout/clean），未触碰并发代理的既有提交与未提交改动（前序未跟踪 docs 原样保留）。

## 1. 背景与问题（对抗审查 + 终审裁定）

并发提交 `155570e` 为陈旧运行归一化引入 pid 分支：`createRunState` 记录 `process.pid`、resume 刷新、`normalizeStaleRun`/`normalizeRunStatus` 增加「进程存活则不判陈旧」分支、SQL 投影经 `json_extract(state_json,'$.pid')` 套同一规则。动机（提交说明）：评审运行的 tester 步骤合法运行 >10 分钟未持久化，被误判为 crashed。

对抗审查与终审（基于代码锚点 + 直接执行 lib 产物）确认三项问题：

| # | 问题 | 实质 |
|---|---|---|
| P1-1 | 挂死检测整体失效 | 存活 pid 对陈旧判定是**无界豁免**：只要 pid 对应任一存活进程，运行永远不读 crashed。引擎嵌在长驻 host 进程中，`process.pid` 即 host pid —— host 存活时**所有**其创建/恢复的运行被永久豁免，运行循环异常退出/挂死不再可见。 |
| P1-2 | 无关存活 pid 致 false-live、同状态无 pid 判 crashed | (a) pid 复用：host 崩溃后该 pid 被无关进程（浏览器/系统服务等）复用 → 陈旧运行永久 false-live；(b) 跨机：工作区同步到另一台机器，记录 pid 恰与本地存活进程号重合 → 本地 false-live；(c) 语义不一致：同样陈旧的非终态运行，带无关存活 pid 判 running、无 pid 判 crashed。 |
| P1-3 | 特性零测试 + r2 主张被证伪 | 155570e 提交时 pid 分支无等价钉；r2 报告主张「并发改动保留原规则语义」被探针证伪（无界豁免即语义变更）；8 条 r2 钉（run-lifecycle +2、stale-run +6）未提交。 |

## 2. 裁决决定

对存活 pid 豁免采用**有界宽限窗口（cap）+ 主机身份门禁（hostId）**，两者都落在**单一共享规则** `normalizeRunStatus`/`isOwnerAlive` 内，JSON 文件扫描与 SQL 归档投影自动同规则，双 feed 无法再分裂。

1. **上限（cap）**：新增常量 `PID_LIVE_GRACE_MS = 12h`。规则改为按「空闲时长」分档：
   - `age ≤ STALE_RUN_MS`（10 分钟）→ 新鲜，原样；
   - `STALE_RUN_MS < age ≤ STALE_RUN_MS + PID_LIVE_GRACE_MS` 且存在**本机存活 owner** → 保持 running（慢步骤/长人工等待不是崩溃）；
   - `age > STALE_RUN_MS + PID_LIVE_GRACE_MS` → 即使 pid 存活也判 crashed（挂死可被检出，P1-1 闭环）。
2. **主机身份门禁（hostId）**：新增 additive 字段 `RunState.hostId`（`os.hostname()`，create 时记录、resume 时随 pid 一并刷新）。新共享助手 `isOwnerAlive(owner, host)`：`pid` 与 `hostId` 都必须存在、`hostId` 等于当前机器、且 `isPidAlive(pid)` 为真才豁免。跨机记录的 pid 永不信任（只能是无关本地进程的巧合号，P1-2 跨机 false-live 被**消除**而非仅被截断）；同机 pid 复用的 false-live 被 cap 截断（最多持续宽限窗口）。
3. **错误文案区分**：live pid 超宽限判 crashed 时，error 为「进程仍存活但长时间无更新，疑似挂起」而非「进程已退出」，诊断不误导（进程确实还在）。
4. **语义一致性**：无 pid / 无 hostId / hostId 不符 / pid 已死，全部退回纯时间规则（与既有僵尸钉一致）——「同样陈旧的非终态运行」不再因是否有（可信的）存活 owner 而分裂。

### 2.1 cap 取值依据

- 默认步骤超时 `stepTimeoutMs = 30 min`（`src/index.ts:71`、`src/service.ts:186`），重试上限 `maxRetries ≤ 10`（`src/dsl/schema.ts:118`），每步最多 ≈ 30 min × 11 ≈ **5.5 h** 不持久化（另含 supervisor/退避余量）。
- `PID_LIVE_GRACE_MS = 12 h` 覆盖默认配置最坏步进预算并留 >2× 余量；`timeoutMinutes` 自定义（schema 上限 1440 分钟，`src/dsl/schema.ts:134`）或重试预算超出宽限属操作者显式覆盖：运行在窗口后读 crashed（仅显示层，state.json 不动，`/workflow resume` 可用）。
- 待决选项对比：**心跳方案**（运行循环内周期 persist）精度更高（长步骤/长人工等待永不误伤），但需改动引擎运行热路径（persist 节奏、缓存写失效、e2e p95 预算均受影响）且定时行为难确定性钉测；**纯 cap 不加 hostId** 只能截断跨机 false-live 而不能消除。裁决选 cap+hostId：纯函数级改动、零运行路径风险、可完全确定性钉测，跨机问题直接消除。心跳作为未来精度升级记入残余（§6）。

## 3. 语义契约（normalizeRunStatus + isOwnerAlive）

| 状态 | 空闲时长 age | 本机存活 owner | 归一化结果 |
|---|---|---|---|
| 终态 | 任意 | 任意 | 原样（永不老化） |
| 非终态 | `age ≤ STALE_RUN_MS` | 任意 | 原样（新鲜） |
| 非终态 | `STALE < age ≤ STALE+GRACE` | 有（pid+hostId 匹配且存活） | 原样（慢步骤豁免） |
| 非终态 | `STALE < age ≤ STALE+GRACE` | 无 | crashed（进程已退出或长时间无更新） |
| 非终态 | `age > STALE+GRACE` | 有 | crashed（疑似挂起——cap 闭环） |
| 非终态 | `age > STALE+GRACE` | 无 | crashed（进程已退出或长时间无更新） |
| 非终态 | 时间戳不可解析 | 任意 | 原样（永不误伤） |

owner 可信 ⇔ `pid ≠ undefined ∧ hostId ≠ undefined ∧ hostId === hostname() ∧ isPidAlive(pid)`（`isOwnerAlive` 单一定义，JSON 扫描与 SQL 投影共用）。

## 4. 钉集对照（裁决后）

| 钉 | 位置 | 裁决前 | 裁决后 |
|---|---|---|---|
| stale 非终态（无 pid）→ crashed | stale-run.spec（既有） | ✅ 不变 | ✅ 不变 |
| 严格 > 边界、终态永不老化、非法时间戳、waiting-human 参与老化 | stale-run.spec（r2 +6，`0930954` 入库） | ✅ | ✅ 不变 |
| P1-1 窗口另两个失败点（ensureSandboxDir 抛错 / job 缺 jobs 服务） | run-lifecycle.spec（r2 +2，`0930954` 入库） | ✅ | ✅ 不变 |
| 存活 pid 豁免陈旧 → running | stale-pid.spec（155570e） | ✅ | ✅ 但**收紧**：改为「本机存活 owner + 宽限窗口内」；helper 补 `hostId` |
| 存活 pid **超宽限** → crashed（挂死可检出） | stale-pid.spec + stale-run.spec（新增） | — | ✅ 新增 |
| 跨机（本地存活 pid 但 hostId 不符）→ crashed | stale-pid.spec + sqlite-archive.spec（新增） | — | ✅ 新增 |
| 无 hostId 的 pid 退回时间规则 | stale-pid.spec（新增） | — | ✅ 新增 |
| isOwnerAlive 矩阵（pid/hostId/存活 4 组合） | stale-pid.spec（新增） | — | ✅ 新增 |
| 双 feed pid 分支等价（running:1/crashed:3，DIVERGE=false） | sqlite-archive.spec（新增） | — | ✅ 新增 |

## 5. 验证证据（本裁决批次实测）

- 桥测（沙箱 vitest shim）：`stale-run 14/14`、`stale-pid 8/8`、`sqlite-archive 14/14`、`run-lifecycle 10/10`（共 46/46）。
- 直接 lib 探针 `.test-build/defender-pid-adjudication.mjs`（真实编译产物）：规则分档、isOwnerAlive 4 组合、normalizeStaleRun 端到端（慢步骤/hung/foreign/dead/noHost）、`createRunState` 记录 pid+hostId、双 feed byStatus 逐字节一致 —— **20/20 PASS**。
- `pnpm typecheck` exit 0；`pnpm build` exit 0（client 993.74 kB / gzip 214.42 kB，与上版同量级）。
- 全量回归：见回归验证（35 spec / 293+ pass，4 个 spawn EPERM 环境边界非回归；新增 17 条钉全部通过）。
- 公开 API：host 导出逐字不变（Config/apply/inject/name）；触碰模块仅增键/函数（`RunState.hostId` additive、`PID_LIVE_GRACE_MS`/`currentHostId`/`isOwnerAlive` 新增导出）；无新依赖；state.json 仅增 `hostId` 字段（缺省时行为 = 纯时间规则，与 155570e 前一致）。

## 6. 残余风险与宿主待办

1. **[阻断性，同前]** vitest 宿主复跑 `pnpm install --frozen-lockfile && pnpm test`（重点 stale-pid/stale-run/sqlite-archive/run-lifecycle；预期全绿，pre-commands 4 个 spawn 用例与 python 用例为宿主环境复核项）。
2. **[阻断性]** `node scripts/e2e-platform.mjs`（真实 dsh 实例）：/stats 新鲜断言与 p95 预算（本裁决未触碰 persist 节奏，缓存写时失效语义不变）。
3. **[设计取舍]** 自定义 `timeoutMinutes` > 12 h 且带重试的步骤，运行在宽限窗口后读 crashed（仅显示层，resume 可恢复）；如需覆盖超长自定义步骤，可升级为心跳方案（运行循环周期 persist），列为未来独立项。
4. **[设计取舍]** `waiting-human` 运行在 host 存活但宽限窗口后读 crashed（显示层；resume 从存储态恢复）—— 与基线（10 分钟即 crashed）相比为**改善**（10 分钟 → 12 小时 10 分钟）；人类等待 > 12 h 属超长场景，resume 路径不受影响。
5. **[环境敏感]** hostname 变化（机器改名/容器迁移）会使旧 hostId 失效 → 运行退回时间规则（保守方向，resume 刷新 hostId）。同机多 dsh 实例共享工作区：hostname 相同，pid 检查作用于任意本地存活进程，由 cap 截断误信窗口。

## 7. r2 主张修正（终审裁定项）

r2 报告（`docs/regression-verification-observability-r2-2026-10.md`）主张「并发改动保留原规则语义（无 pid 或 pid 不存活时行为与 HEAD 态逐字一致），仅当 state 携带存活 pid 时才豁免陈旧判定」。对抗审查以探针证伪其**充分性**：该主张对「无 pid / pid 不存活」分支成立，但漏述「存活 pid」分支自身是无界豁免（挂死检测失效）且无主机门禁（跨机/pid 复用 false-live）—— 即语义变更而非常规「保留」。本裁决已闭环：cap + hostId 将豁免限定为「本机存活 owner 且宽限窗口内」，既有僵尸钉语义（无可信 owner → 时间规则）原样保留。修正说明已以追加段写入 r2 文档，随 docs 批次入库。
