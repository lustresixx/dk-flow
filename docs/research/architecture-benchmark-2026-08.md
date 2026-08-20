# 架构对标研究：调用更快 / 更稳 / 并发安全

> 状态：`架构重构评审` → **调研对标**（defender 交付）
> 输入：`架构诊断` 产出的问题清单（P0-1 失效缓存、P0-2 resume 竞态、P0-3 runApi 会话身份、P0-4 runId 唯一性、P1-1 巨石服务、P1-2 路由内联+投影重复、P1-3 跨入口重复、P2-1 隐式全局、P2-2 持久化无版本/无配置快照、P2-3 宿主层无测试）
> 运行：`run-1787236769887-vjhra4dx`　需求：「优化逻辑，使得调用更快，有更好的稳定性，以及并发安全」
> 本文只做**事实基础与模式对标**，不改动任何生产代码。

---

## 1. 研究问题拆解

| 编号 | 研究问题 | 类型 | 决策标准 |
|---|---|---|---|
| Q1 | 进程内读缓存（`/state` 路由）的正确作用域与失效策略，业界标准做法是什么？ | 待比较选项 | 能消除重复 YAML 解析/文件读，且保存后不返回脏拓扑 |
| Q2 | 单进程 async JS 中「先 await 再 check-then-act」的竞态，标准修法有哪些？何时才需要锁/租约？ | 待验证事实 + 待比较选项 | 判断与登记落在同一同步段；不引入跨进程复杂度 |
| Q3 | 由 API/非会话入口发起的运行，其「身份 + 恢复授权」在成熟工作流引擎中如何建模？ | 待比较选项 | 身份不再是 `undefined`；resume 的允许/拒绝语义显式可解释 |
| Q4 | 运行 ID 的生成：随机性、唯一性、可排序性、作为文件路径的安全性如何同时满足？ | 待验证事实 | 不破坏现有按名字典序列举运行的行为 |
| Q5 | 「引擎纯净、宿主集成层巨石」这种形态，业界的拆分模式与依赖方向准则是什么？ | 待比较选项 | 拆分后宿主层可单测，外部契约零变更 |
| Q6 | 三入口（命令 / 工具 / HTTP）重复表达同一流程与同一 DTO，收敛模式与契约保护手段？ | 待比较选项 | 单一事实源 + 字段漂移可被测试捕获 |
| Q7 | 文件型运行持久化的版本化与「运行配置快照」，参考实现是什么？破坏性如何控制？ | 待比较选项 | 旧 `state.json` 必须仍可 resume/展示 |
| Q8 | 宿主集成层（依赖子代理/工具/webServer 的代码）如何获得可执行的测试策略？ | 待比较选项 | 竞态与身份缺陷能被自动化测试捕获 |

**时间范围**：模式类结论取长期稳定的经典文献（2005–2019）；实现类结论取 2024–2026 的当前版本（Node 22/24、Argo v3.5、Airflow 3.x、Temporal 当前文档、RFC 9562）。
**术语约定**：`同步段` = 一次事件循环任务内不含 `await` 的连续执行区间；`登记` = 把 runId 写入 `active` map；`投影` = RunState → 面板 DTO 的映射。

---

## 2. 研究方法与证据分级

1. **一手代码核验**：用 `read` / `grep` 直接读取本仓库 `src/**` 与本机 DSH/Cordis 安装，记录文件行号（不依赖诊断步骤的转述，关键断言全部复核）。
2. **规范与官方文档对标**：MDN、RFC、Node.js、Microsoft Learn、Temporal / Argo / Airflow / Pact 官方文档。
3. **成熟项目实现对标**：Argo Workflows 类型注释、Airflow 多调度器 PR 与配置项、npm `write-file-atomic`、`async-mutex`、groupcache singleflight。
4. **冲突检查**：每个模式都问「在本仓库是单进程插件 / 文件持久化 / 已有正向先例」的前提下是否仍成立，反例单列（§6、§8.3）。

证据强度标度（全文统一）：

| 级别 | 含义 |
|---|---|
| **A** | 一手：本仓库或本机文件，已用工具读取核验，附文件:行号 |
| **B** | 官方文档 / 正式规范：URL 已由检索命中确认存在；**正文未逐字抓取**（本会话无网页抓取能力），内容依据既有稳定共识 |
| **B-** | 权威项目源码注释 / PR / 配置项：检索返回了对应片段或标题 |
| **C** | 二手社区材料（博客、SO、npm 页）：仅作背景与实现参考，不单独支撑结论 |

> **方法学声明（重要）**：`web_search` 只返回 URL 列表与标题片段，本会话**无法抓取网页正文**。因此所有外部结论标注为 B / B- / C，且不引用具体页面行号；凡直接驱动代码改动的判断，均另配一条 A 级本地证据。这是本报告最大的证据局限（见 §8.2）。

---

## 3. 来源清单

| ID | 来源 | 类型 | 用于 | 强度 |
|---|---|---|---|---|
| S1 | `src/index.ts:180-228`（每请求 `new Map()` 的 topology/taskFields 缓存与 30s TTL 判断） | 本仓库代码 | Q1 | A |
| S2 | `src/client/workflow-trigger.ts:13-36`（模块级 10s TTL 缓存 + 失败回退旧值） | 本仓库代码 | Q1 | A |
| S3 | `src/store/workflow-store.ts:26-100`（`listWorkflows`/`loadWorkflow` 每次调用重新 `readFile`+`parseWorkflowYaml`，无任何缓存） | 本仓库代码 | Q1 | A |
| S4 | `src/store/run-store.ts:53-100`（`listRunIds` 按目录名 `sort().reverse()`；`listRunStates` 逐个读 `state.json`） | 本仓库代码 | Q1/Q4 | A |
| S5 | `src/service.ts:579-591`（`startRun` 上限检查与 `active.set` 之间无 `await`）对比 `src/service.ts:729-746`（`resumeRun` 在 `await loadRunState` 之后才 check，再 `set`） | 本仓库代码 | Q2 | A |
| S6 | `src/service.ts:909-919` + `src/service.ts:924`（合成 `parent` 只有 `session.header.cwd`，无 `session.id`；`workspaceOf` 隐式 `process.cwd()`） | 本仓库代码 | Q3 | A |
| S7 | `src/service.ts:583,1434`（`run-${Date.now()}-${Math.random()...}`）与 `src/service.ts:423,450`（`test-${Date.now()}`） | 本仓库代码 | Q4 | A |
| S8 | `src/store/workflow-store.ts:111-113`（文件名白名单 `^[A-Za-z0-9_-]+\.yaml$`，已是正向先例） | 本仓库代码 | Q4 | A |
| S9 | `src/engine/types.ts:177-201`（`EngineRunOptions` 注入 `executor/persist/load/signal`）+ `docs/ARCHITECTURE.md:26-32` | 本仓库代码/文档 | Q5 | A |
| S10 | `src/store/run-store.ts:79`（`normalizeStaleRun(state, now = Date.now())` 默认参数注入时钟，已是正向先例） | 本仓库代码 | Q8 | A |
| S11 | `src/store/run-store.ts:13-24`（temp + `rename` 原子替换，无 fsync） | 本仓库代码 | Q7 | A |
| S12 | 本机 Cordis README：`…/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/README.md:61-67`（`inject` 声明依赖、fiber 释放时自动回收 effect/服务/监听） | 本机一手文件 | Q5/Q8 | A |
| S13 | [MDN `Math.random()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/random) — 明示不提供密码学安全随机数 | 官方文档 | Q4 | B |
| S14 | [MDN 并发模型与事件循环（Execution model）](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Execution_model) — run-to-completion / 不可抢占 | 官方文档 | Q2 | B |
| S15 | [Node.js `crypto.randomUUID([options])`](https://nodejs.org/api/crypto.html#cryptorandomuuidoptions)（检索命中镜像：[url.nodejs.cn v24](https://url.nodejs.cn/api/v24/crypto/crypto_randomuuid_options.html)） | 官方文档 | Q4 | B |
| S16 | [RFC 9562（UUID v7 时间有序）](https://www.rfc-editor.org/rfc/rfc9562.html) | 正式规范 | Q4 | B |
| S17 | [OWASP Path Traversal](https://owasp.org/www-community/attacks/Path_Traversal) | 权威指南 | Q4 | B |
| S18 | [Azure Architecture Center · Cache-Aside pattern](https://learn.microsoft.com/azure/architecture/patterns/cache-aside) / [Caching guidance](https://learn.microsoft.com/azure/architecture/best-practices/caching) | 官方文档 | Q1 | B |
| S19 | [RFC 5861 `stale-while-revalidate` / `stale-if-error`](https://httpwg.org/specs/rfc5861.html) | 正式规范 | Q1 | B |
| S20 | [RFC 9110 §8.8/§13 条件请求与校验器（ETag/Last-Modified）](https://www.rfc-editor.org/rfc/rfc9110.html) | 正式规范 | Q1 | B |
| S21 | [groupcache-go（singleflight 请求合并）](https://pkg.go.dev/github.com/groupcache/groupcache-go/v3) | 成熟实现 | Q1 | B- |
| S22 | [`async-mutex`（npm，keyed/普通异步互斥）](https://www.npmjs.com/package/async-mutex) | 成熟实现 | Q2 | C |
| S23 | [Apache Airflow PR #10956「Fully support running more than one scheduler concurrently」](https://github.com/apache/airflow/pull/10956) + 配置项 [`use_row_level_locking`](https://apache.googlesource.com/airflow/+/a660636baaaae7d2bc13023148215dde10ea45ee/airflow/config_templates/config.yml) | 成熟实现 | Q2 | B- |
| S24 | [Martin Kleppmann, How to do distributed locking（fencing token）](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) | 权威文章 | Q2 | B |
| S25 | [Temporal · Workflow Id 与 Run Id](https://docs.temporal.io/workflow-execution/workflowid-runid)、[WorkflowIdReusePolicy](https://dotnet.temporal.io/api/Temporalio.Api.Enums.V1.WorkflowIdReusePolicy.html) | 官方文档 | Q3/Q4 | B |
| S26 | [Temporal · Versioning（patching / pinned 行为）](https://docs.temporal.io/develop/python/workflows/versioning) | 官方文档 | Q7 | B |
| S27 | [Argo Workflows `v1alpha1` 类型：`StoredWorkflowSpec` —— “stores the WorkflowTemplate spec for future execution”](https://pkg.go.dev/github.com/argoproj/argo-workflows/v3@v3.5.12/pkg/apis/workflow/v1alpha1) | 成熟实现（注释原文命中） | Q7 | B- |
| S28 | [Airflow DAG versioning & DAG bundles（Airflow 3）](https://www.astronomer.io/docs/learn/airflow-dag-versioning)、[apache/airflow discussion #59595](https://github.com/apache/airflow/discussions/59595) | 厂商文档/上游讨论 | Q7 | B-/C |
| S29 | [npm `write-file-atomic`](https://github.com/npm/write-file-atomic) | 成熟实现 | Q7 | B- |
| S30 | [Martin Fowler · Parallel Change（expand/migrate/contract）](https://martinfowler.com/bliki/ParallelChange.html) | 权威模式 | Q7 | B |
| S31 | [Alistair Cockburn · Hexagonal Architecture (Ports & Adapters)](https://alistair.cockburn.us/hexagonal-architecture) | 权威模式 | Q5 | B |
| S32 | [Martin Fowler · Humble Object](https://martinfowler.com/bliki/HumbleObject.html)、[xUnit Patterns · Humble Object](http://xunitpatterns.com/Humble%20Object.html) | 权威模式 | Q5/Q8 | B |
| S33 | [Martin Fowler · The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html) | 权威文章 | Q8 | B |
| S34 | [James Shore · Testing Without Mocks（Nullables / Infrastructure Wrapper）](https://www.jamesshore.com/v2/projects/nullables/testing-without-mocks) | 权威模式语言 | Q8 | B |
| S35 | [Pact · 消费者驱动契约测试](https://docs.pact.io/consumer) | 官方文档 | Q6 | B |
| S36 | `docs/ROADMAP.md`（自列 P0 gap：运行配置快照、持久化格式版本化）、`scripts/smoke-headless.mjs`、`vitest.config.ts` | 本仓库 | Q7/Q8 | A |

---

## 4. 关键事实（A 级，本地核验）

| # | 事实 | 定位 | 对结论的作用 |
|---|---|---|---|
| F1 | `/state` 的两个缓存 Map 在 handler 内部创建，TTL 命中分支永不可达 | `src/index.ts:180-181` vs `:185,:216` | 缓存等价于不存在（P0-1 成立） |
| F2 | 缓存未命中的真实成本：`listWorkflows` 会读并解析**目录下每个** YAML；`resolveWorkflowConfig`/`loadWorkflowConfig` 每次都重新 `readFile`+parse；`listRuns` 逐个读 `state.json` | `src/store/workflow-store.ts:60-100`、`src/store/run-store.ts:93-99` | 「调用更快」的主要成本项是**文件读 + YAML 解析**，而非 CPU 逻辑 |
| F3 | 同仓库客户端已有**作用域正确**的缓存：模块级、10s TTL、失败回退旧值 | `src/client/workflow-trigger.ts:13-36` | 修法不需要新范式，只需把宿主侧对齐既有先例 |
| F4 | `startRun` 的「上限检查 → set」之间无 `await`（安全）；`resumeRun` 的「check → set」被 `await loadRunState` 与 `await resolveWorkflowConfig` 隔开（不安全） | `src/service.ts:579-591` / `:729-746` | 竞态是局部疏漏，非设计取舍（P0-2 成立） |
| F5 | 合成 parent 缺 `session.id`；resume 授权用 `persisted.parentSessionId !== input.parent.session.id` | `src/service.ts:909-912`、`:732` | API 运行的 `parentSessionId` 为 `undefined`，resume 必然被拒（P0-3 成立） |
| F6 | runId = `run-${Date.now()}-${Math.random().toString(36).slice(2,8)}`；单节点验证用 `test-${Date.now()}`（**无随机后缀**） | `src/service.ts:583,1434`、`:423,450` | 同毫秒并发碰撞面比诊断结论更大：`test-` 前缀完全无随机 |
| F7 | 运行列表依赖 **runId 目录名的字典序** 表达时间序（`sort().reverse()` = 最新在前） | `src/store/run-store.ts:57-61` | **换成纯 UUIDv4 会静默破坏"最新在前"**（本报告新增的破坏性发现） |
| F8 | 已有文件名白名单校验先例：`^[A-Za-z0-9_-]+\.yaml$` | `src/store/workflow-store.ts:111-113` | runId 作目录名可复用同一校验，无需引入新依赖 |
| F9 | 引擎已通过 `EngineRunOptions` 注入 `executor/persist/load/signal`，测试用假执行器 | `src/engine/types.ts:177-201`、`docs/ARCHITECTURE.md:28` | 端口化不是新引入，是**向宿主层延伸既有做法** |
| F10 | `run-store` 已有原子替换（temp+rename）但**无 fsync**；`normalizeStaleRun(state, now = Date.now())` 已是注入时钟先例 | `src/store/run-store.ts:13-24`、`:79` | 持久化硬化与可测试性都有本地锚点 |
| F11 | Cordis 的依赖与释放契约：`inject` 声明前置服务，fiber dispose 自动回收 effect/监听/服务 | 本机 `…/@deepseek-ai/cordis/README.md:61-67` | 拆模块时「谁持有生命周期」有框架级答案 |

---

## 5. 可复用架构模式清单

每条格式：**模式 → 内容 → 对应问题 → 来源/强度 → 不适用场景**。

### 5.1 读路径性能（对应 P0-1，目标「调用更快」）

**M1 · Cache-Aside，且缓存生命周期必须长于请求**
- 内容：缓存对象持有在服务实例/闭包作用域，读时先查缓存、未命中再回源并回填。
- 来源：S18（B）；本地正向先例 S2/F3（A）。
- 不适用：多进程/多实例部署时进程内缓存无法一致（ROADMAP 的多租户目标下需换共享缓存或接受 per-instance 陈旧）。

**M2 · 写时失效（write-invalidate）+ TTL 兜底**
- 内容：`saveWorkflow`/`deleteWorkflow`/`instantiate` 成功后主动删除对应 key；TTL 只用于兜底外部改动。
- 来源：S18（B）。本地：保存路径已集中在 `workflow-store.saveWorkflow`（A，S3），有唯一失效点。
- 不适用：文件被 IDE/其他进程直接改写时写失效收不到通知 → 必须保留 TTL 或 M3。

**M3 · 用校验器（mtime/size）代替盲目 TTL**
- 内容：缓存项记录 `stat().mtimeMs`+`size` 作为指纹，命中前 `stat` 校验；一次 `stat` 远比 `readFile`+YAML parse 便宜。语义同 HTTP 条件请求的 `Last-Modified` 校验器。
- 来源：S20（B）。本地成本模型：F2（A）。
- 不适用：目录级列举（`listWorkflows` 要 `readdir` 才知道有哪些文件）无法只靠单文件指纹 → 目录列举仍需短 TTL；网络文件系统 mtime 粒度可能不足。

**M4 · Single-flight（同 key 并发合并为一次回源）**
- 内容：缓存里存 `Promise` 而非结果值，同 key 并发共享同一个在途 Promise。
- 来源：S21（B-）、S18（B，缓存击穿章节）。
- 不适用：回源极快或并发极低时是纯复杂度；必须在 reject 时清除在途条目，否则会缓存住失败。

**M5 · `stale-if-error`：回源失败时返回上次成功值**
- 内容：读失败/解析失败不冒泡成 500，返回最近一次成功快照并打标。
- 来源：S19（B）；本地先例 `src/client/workflow-trigger.ts:18`（A）。
- 不适用：需要强一致读的写后校验路径（保存后立刻回读校验）不能吃陈旧值。

### 5.2 并发安全（对应 P0-2，目标「并发安全」）

**M6 · 同步临界区：判断与登记落在同一同步段**
- 内容：单线程 JS 的任务是 run-to-completion、不可抢占，因此「check + set」只要不跨 `await` 即为原子；把 `active.has → active.set` 移到所有 `await` 之前。
- 来源：S14（B）；本地对照 F4（A，`startRun` 已是正确形态）。
- 不适用：跨进程/跨实例（多个 DSH 进程共享同一工作区目录）时进程内 map 无效 → 需 M9。

**M7 · 占位登记（reservation / placeholder）**
- 内容：先用占位 controller/Promise 登记 runId，再做 `await` 的加载与校验，失败路径 `delete` 回滚（try/catch/finally）。
- 来源：S21 的在途条目思想（B-）+ S14（B）。
- 不适用：登记后如果异常路径漏 `delete`，会把 runId 永久锁死 → 必须 `finally` 兜底并有测试覆盖。

**M8 · Keyed async mutex（按 runId 串行化整段操作）**
- 内容：`Map<runId, Promise>` 的串行链，或引入 `async-mutex` 的 keyed mutex，把 start/resume/stop 对同一 runId 的操作串起来。
- 来源：S22（C）+ S14（B）。
- 不适用：本仓库需要的是"拒绝第二次 resume"而非"排队执行第二次 resume"——互斥会把并发 resume 变成串行重放，语义比 M6/M7 更差；只在确实需要排队（如 persist 写序）时才用。

**M9 · 单写者 + 运行租约（owner + 过期），跨进程用 fencing token**
- 内容：`state.json` 增加 `owner`/`leaseUntil`（或 `epoch` 单调计数），写入前校验自己仍是持有者；这正是 Airflow 多调度器用数据库行锁、Temporal 用「同一 Workflow Id 仅一个 open execution」所解决的同类问题。
- 来源：S23（B-）、S24（B）、S25（B）；本地已有 10 分钟 `STALE_RUN_MS` 心跳式判定可作租约雏形（A，`run-store.ts:68-90`）。
- 不适用：**当前是单进程插件**，引入租约属于 ROADMAP 阶段的能力，现在做是超前设计；且文件系统上的锁没有 CAS，只能近似（`mkdir`/`O_EXCL`），可靠性弱于数据库行锁。

**M10 · 冲突策略显式化，而不是隐式抛错**
- 内容：把「已在运行时再次启动/恢复」定义为一等策略（拒绝 / 复用现有句柄 / 终止后重启），像 Temporal 的 `WorkflowIdReusePolicy` / `WorkflowIdConflictPolicy` 那样命名并文档化。
- 来源：S25（B）。
- 不适用：策略枚举会成为对外契约，一旦暴露到命令/工具层就难改 —— 建议先内部命名、暂不进 DSL。

### 5.3 身份与标识（对应 P0-3、P0-4，目标「稳定性」）

**M11 · 显式主体对象，禁止 `as unknown as` 造假 principal**
- 内容：为非会话入口定义一等主体（如 `{ kind: 'api', id: 'api:<workspace hash>' }`），授权判断基于 `kind` 分支而不是 `undefined` 比较；不可恢复就返回可读原因（Null Object 显式表达"无会话"）。
- 来源：S25（B，Workflow Id 是显式一等标识）；本地缺陷 F5（A）。
- 不适用：这会把「API 运行可否被任意会话 resume」变成安全决策，必须在**方案审批门**明确取舍，不能由重构顺手改掉（默认建议：仍不可恢复，但错误信息明确）。

**M12 · CSPRNG + 时间有序 ID**
- 内容：`crypto.randomUUID()` / `randomBytes()` 替代 `Math.random()`；若需要按 ID 排序即时间序，用 UUIDv7 或保留 `run-<epoch>-` 前缀。
- 来源：S13（B，`Math.random` 非密码学安全）、S15（B）、S16（B）。
- **不适用/反例（本报告核心发现 F7）**：**纯 UUIDv4 会破坏 `listRunIds` 的字典序 = 时间序假设**（`run-store.ts:57-61`），运行列表将变成随机顺序。必须保留时间前缀（`run-${Date.now()}-${uuid}`）或改为按 `mtime`/`startedAt` 显式排序（后者要多读文件，与 Q1 目标冲突）。

**M13 · 用作路径的标识必须双侧校验**
- 内容：生成侧只产出白名单字符；**使用侧**（`runDir(workspace, runId)`）也要校验/规范化并断言解析后路径仍在根目录内。
- 来源：S17（B）；本地正向先例 F8（A，`workflow-store` 的文件名白名单）。
- 不适用：内部生成的 ID 看似可信 —— 但 `resume <runId>`、REST `?runId=` 来自外部输入，属必须校验面；纯内部子工作流 ID（`<parent>.<step>`）也需 sanitize（现有 `sanitize()` 已做，见 P1-3）。

### 5.4 模块化与依赖方向（对应 P1-1、P1-2、P1-3）

**M14 · Ports & Adapters：领域核心不依赖宿主，适配器按端口切分**
- 内容：`dsl/`+`engine/` 已是不依赖宿主的核心（F9）；`service.ts` 目前把**多个适配器**（子代理执行、LLM、流式投影、jobs、HTTP）挤在一个类里。按端口拆：`executor.ts`（执行端口的 DSH 适配器）、`streams.ts`（投影）、`web/routes.ts`（HTTP 适配器）。
- 来源：S31（B）；本地 F9/S9（A）。
- 不适用：为每个端口都造接口+DI 容器在 ~1.5k 行插件里是过度工程；只拆已经存在的自然缝（`makeExecutor`、`persist` 内的投影、路由 handler），不新增抽象层。

**M15 · Humble Object：把最难测的宿主耦合削到"哑壳"**
- 内容：路由 handler / Cordis Service 方法只做参数解析与转发，判断逻辑落在纯函数模块里（可无宿主单测）。
- 来源：S32（B）；Cordis 的 fiber 生命周期让"壳"天然是被托管对象（A，F11）。
- 不适用：如果逻辑本身就依赖宿主状态机（如 job 分离、abort 联动），humble 化会退化成"转发地狱"；这类应改用注入接缝（M19/M20）而不是继续削薄。

**M16 · Extract Class → Facade（巨石降级为编排门面）**
- 内容：按"数据+行为的内聚簇"抽类（`active`/`streams` 两张 map 的生命周期各自跟随一个新类），原类保留同名方法转发，保证调用点零改动。
- 来源：Fowler《重构》Extract Class / Facade（B，经典模式，检索仅命中二手材料，见 §8.2）。
- 不适用：抽出后如果两个新类仍互相回调，只是把耦合搬了位置；判据是"抽出后的类能否独立单测"。

**M17 · 用例编排层（application service）收敛多入口重复**
- 内容：把"解析实例 → 询问缺参 → 实例化 → startRun"沉到一个用例函数，命令 / 工具 / HTTP 三入口只做各自的 I/O 适配；模板版本解析收敛为 `resolveLatestTemplate`（现 4 处重复）。
- 来源：S31（B，用例位于核心与适配器之间）；本地重复点由诊断列出并经 grep 复核（A，`service.ts:901-904` 等）。
- 不适用：入口间语义**并不真的相同**时（命令要交互式追问、HTTP 不能弹窗），强行合并会长出布尔开关 → 应抽"无交互内核 + 各入口自己的缺参策略"。

**M18 · DTO 单一事实源 + 轻量契约测试**
- 内容：`state`/`run`/`stream` 的 JSON 投影收敛到一个模块，客户端类型（`src/client/types.ts`）由同一定义派生；用快照/契约测试锁字段，防面板字段漂移。
- 来源：S35（B，消费者驱动契约思想）；本地三处重复投影（A，`index.ts:251-323`、`index.ts:466-487`、`tools.ts:20-45`）。
- 不适用：引入 Pact broker / 双向契约平台对单仓库插件过重 → 只取"消费者期望被固化成测试"这一点，用 vitest 快照实现。

### 5.5 可测试性与确定性（对应 P2-1、P2-3）

**M19 · 注入 clock / random / env（默认参数即可）**
- 内容：`now = Date.now()`、`newId = defaultNewId`、`env = process.env` 作为可选参数或构造依赖，生产用默认值，测试传假值。
- 来源：S34（B）；**本地已有先例** `normalizeStaleRun(state, now = Date.now())`（A，F10）。
- 不适用：给每个函数都加注入参数会污染签名 → 只注入"影响可观测行为"的三类（时间、随机、环境/路径根）。

**M20 · Nullable Infrastructure / Infrastructure Wrapper 替代重度 mock**
- 内容：为 `ctx.subagents` / `ctx.llm` / `webServer` 写一层薄包装，并提供 `createNull()` 实现（可预设响应、可记录调用），宿主层测试用它而非手搓 mock 对象图。
- 来源：S34（B）；本地：引擎已用"假执行器"验证过这条路可行（A，F9）。
- 不适用：包装层自身无测试时会变成新的未测代码；且如果 DSH 服务接口频繁变动，包装层维护成本可能高于收益 → 优先包 3 个高频服务，不做全量。

**M21 · 确定性竞态测试（deferred 交错，不用 sleep）**
- 内容：用可手动 resolve 的 deferred 替换 `loadRunState`，在其挂起期间发起第二次 `resumeRun`，断言"第二次被拒绝且 `active` 只有一条"；vitest fake timers 覆盖 TTL/退避。
- 来源：S33（B，测试金字塔中的窄集成测试）+ S14（B，交错点即 `await` 边界）。
- 不适用：`sleep(0)`/`setTimeout` 式竞态测试不稳定、会在 CI 上偶发；且这类测试要求被测函数的 `await` 顺序稳定，重构时需同步维护。

**M22 · 金字塔 + 窄集成 + smoke 兜底**
- 内容：纯层保持单测（现状已好：`tests/` 22 个 spec）；宿主层补窄集成测试（假 DSH 服务）；端到端只留 `scripts/smoke-headless.mjs` 一条。
- 来源：S33（B）；本地 S36（A）。
- 不适用：把宿主层测试写成"启动真实 DSH"的宽端到端会慢且脆 —— 明确不做。

### 5.6 持久化演进（对应 P2-2，最高破坏风险）

**M23 · `schemaVersion` + Tolerant Reader**
- 内容：写入带版本号；读取端对未知字段宽容、对缺失字段给默认值，只在**主版本**不认识时显式拒绝并给可读错误。
- 来源：S30（B）。本地：`loadRunState` 目前只校验 `id`，无版本概念（A，F10/S11）。
- 不适用：宽容读会掩盖真实的数据损坏 → 需配一条"无法识别就明确报错"的下限，而不是静默降级。

**M24 · Parallel Change（expand → migrate → contract）**
- 内容：新字段先"可选、双写、旧读兼容"，等旧运行自然退场后再收紧；一次发布只走一步。
- 来源：S30（B）。
- 不适用：本地运行目录是用户数据、没有"全量迁移窗口"，contract 阶段可能永远不到 → 应接受"长期保留旧格式读路径"。

**M25 · 运行时配置快照（本次最强对标）**
- 内容：启动运行时把完整 workflow 配置快照进 run 目录，resume/展示优先读快照，当前文件仅作回退。
- 参考实现：Argo Workflows 在 `Workflow.Status` 里存 `StoredWorkflowSpec`——注释原文即"stores the WorkflowTemplate spec for future execution"（S27，B-）；Airflow 3 引入 DAG versioning / DAG bundles，让运行绑定到具体版本（S28，B-）；Temporal 用 versioning/patching 保证运行期定义变更不破坏在途执行（S26，B）。三个独立成熟系统在同一问题上收敛到"运行绑定不可变定义"。
- 不适用：快照会显著增大 run 目录（模板 YAML 数十 KB × 每次运行）；且**快照与"用户改了 YAML 想让恢复用新逻辑"直接冲突** → 必须在审批门决定语义（建议：resume 用快照，新运行用新文件，并在 UI 标注版本）。

**M26 · 原子写 + 持久化屏障**
- 内容：temp+rename 已有（F10）；如需抗断电还要 `fsync` 文件与目录，这正是 npm `write-file-atomic` 的语义。
- 来源：S29（B-）。
- 不适用：每步 persist 都 fsync 会明显拖慢步进（与"调用更快"冲突）→ 建议只在状态终态/审批点 fsync，或直接不做（本地开发工具场景，进程崩溃比断电常见得多，rename 已足够）。

---

## 6. 选项比较表

评分口径：收益/成本 相对本仓库当前规模；成熟度 = 业界采用广度；推荐条件写明触发前提。

### 表 A · `/state` 读路径（Q1 / P0-1）

| 选项 | 收益 | 成本 | 风险 | 依赖 | 成熟度 | 推荐理由/条件 |
|---|---|---|---|---|---|---|
| A0 保持现状（每请求新 Map） | 无 | 0 | 面板轮询与每键查询持续全量读+解析（F2） | — | — | 仅当立刻冻结代码 |
| A1 缓存上移到闭包/服务作用域 + 保留 30s TTL | 高（消除绝大多数重复解析） | 极低（移动 2 个声明） | 保存后最长 30s 脏读 | 无 | 高（S18） | **首选第一步**：行为等价于注释里"本来想做的事"，与客户端先例一致（F3） |
| A2 = A1 + 写时主动失效（M2） | 高 + 脏读窗口≈0 | 低（在 save/delete/instantiate 后清 key） | 漏挂失效点 → 局部长期脏读 | 保存路径集中（已满足，S3） | 高（S18） | **推荐落地目标**：写路径唯一，成本几乎为零 |
| A3 = A2 + mtime 校验器（M3） | 覆盖外部改文件 | 中（每命中一次 `stat`） | `stat` 在大目录下也有开销 | 无 | 高（S20） | 当用户常在编辑器直接改 YAML 时再加 |
| A4 = A3 + single-flight（M4） | 抗并发击穿 | 中（在途 Promise 与失败清理） | 缓存住 rejected Promise | 无 | 高（S21） | 仅当出现"面板多标签同时轮询导致抖动"的实测证据 |
| A5 引入外部缓存库 / 共享缓存 | 多实例一致 | 高（依赖 + 部署） | 与单进程插件定位不符 | 新依赖 | 高 | 留给 ROADMAP 多租户阶段 |

**推荐**：A1 → A2 一次做完；A3/A4 由实测触发。

### 表 B · resume 并发登记（Q2 / P0-2）

| 选项 | 收益 | 成本 | 风险 | 依赖 | 成熟度 | 推荐理由/条件 |
|---|---|---|---|---|---|---|
| B0 现状 | — | 0 | 双 resume → 双写 `state.json`/交错 `audit.jsonl`、步骤重复执行 | — | — | 不可接受 |
| B1 把 check+set 前移到同步段（M6） | 高（消除窗口） | 极低 | 需保证异常路径 `delete` | 无 | 高（S14） | **首选**：与 `startRun` 现有正确形态一致（F4） |
| B2 占位登记 + `finally` 回滚（M7） | 高，且 `loadRunState` 失败不留残留 | 低 | 漏 `finally` → runId 永久锁死 | 无 | 高 | **推荐与 B1 合并实现**（抽 `acquireRunSlot()` 供 start/resume 共用） |
| B3 keyed async mutex（M8） | 通用串行化 | 中（新依赖或自研 20 行） | 把"拒绝重复"变成"排队重放"，语义更差 | `async-mutex` | 高（S22） | 仅用于 persist 写序等确需排队处，不用于 resume |
| B4 文件租约 / owner+epoch（M9） | 跨进程安全 | 高 | 文件系统无 CAS，实现易错 | 无 | 高（S23/S24） | 仅当出现"多个 DSH 进程共享同一工作区"的真实需求 |

**推荐**：B1+B2（抽公共 `acquireRunSlot`），并用 M21 的 deferred 测试锁死行为。

### 表 C · runId 生成（Q4 / P0-4）

| 选项 | 唯一性 | 排序保持（F7） | 安全性 | 成本 | 成熟度 | 推荐理由/条件 |
|---|---|---|---|---|---|---|
| C0 `Date.now()+Math.random()`（现状） | 同毫秒有碰撞面 | ✅ | 可预测（S13） | 0 | — | 不满足"稳定性" |
| C1 `run-${Date.now()}-${randomUUID()}` | 实用上唯一 | ✅ 保持 | CSPRNG（S15） | 极低 | 高 | **首选**：零破坏、零依赖、排序假设不变 |
| C2 纯 `randomUUID()` | 唯一 | ❌ **破坏"最新在前"** | ✅ | 低 | 高 | 除非同时改 `listRunIds` 改按 `startedAt` 排序（要多读文件，与 Q1 冲突） |
| C3 UUIDv7 / ULID | 唯一 | ✅（规范即时间有序） | ✅ | 中（Node 24 原生支持视版本而定；否则新依赖/自研） | 中-高（S16） | 当需要跨系统统一 ID 规范时 |
| C4 C1 + 登记冲突重试 + 目录名白名单（M13） | 唯一且可断言 | ✅ | ✅✅ | 低 | 高（S17/F8） | **推荐落地目标**：顺带修 `test-${Date.now()}` 无随机后缀（F6） |

**推荐**：C1 → C4。

### 表 D · 巨石拆分（Q5/Q6 / P1-1、P1-2、P1-3）

| 选项 | 收益 | 成本 | 风险 | 依赖 | 成熟度 | 推荐理由/条件 |
|---|---|---|---|---|---|---|
| D0 不拆，只修 P0 | 快 | 0 | 负债与语义漂移继续（`dshHome` 已漂移） | — | — | 若本轮只求稳，可先只做 P0 |
| D1 抽 `executor.ts` / `streams.ts` / `run-id.ts`（M14+M16） | 高（宿主层可单测，`active`/`streams` 生命周期归位） | 中 | 投影字段错位 → 面板显示异常 | 无 | 高（S31/S32） | **推荐**：`makeExecutor` 是 private，接口不变即外部无感 |
| D2 + 路由拆 `web/routes.ts` + DTO 单一源（M15+M18） | 高（可测 + 字段防漂移） | 中-高 | 路由/字段是客户端硬契约 | 需快照测试兜底 | 高（S35） | **推荐但需逐字段对齐 + smoke 验证** |
| D3 + 用例层收敛三入口（M17） | 消除最大块重复 | 高 | 交互语义差异被布尔化 | D1/D2 完成 | 高 | 分批：先收敛"无交互内核"，缺参策略留在各入口 |
| D4 全量 hexagonal 重写（正式端口接口 + DI 容器） | 理论最优 | 很高 | 对 1.5k 行插件属过度工程 | — | 高 | 不推荐（明确排除） |

**推荐**：D1 → D2 →（视审批）D3；D4 排除。

### 表 E · 持久化版本化与配置快照（Q7 / P2-2，破坏风险最高）

| 选项 | 收益 | 成本 | 风险 | 依赖 | 成熟度 | 推荐理由/条件 |
|---|---|---|---|---|---|---|
| E0 不动 | 0 | 0 | 任何 RunState 结构演进都可能让旧 run 加载失败 | — | — | 若本轮不改 RunState 结构，可接受 |
| E1 只加 `schemaVersion` + Tolerant Reader（M23） | 中-高（为后续演进开路） | 低 | 宽容读掩盖损坏 | 无 | 高（S30） | **推荐第一步**：新字段可选、旧文件无版本按 v0 处理 |
| E2 E1 + 迁移器 + 旧样本回归测试 | 高 | 中 | 迁移器本身出 bug | 需固化旧样本 | 高（S30） | 当确需改 RunState 结构时才做 |
| E3 E2 + 运行配置快照（M25） | 高（resume 语义确定、拓扑不再降级） | 中-高（磁盘占用、语义变更） | **语义变更**：改 YAML 后 resume 用旧逻辑 | 审批门决策 | 高（S26/S27/S28 三系统收敛） | **强对标支持，但必须走人工审批门**，不可由重构顺带引入 |
| E4 事件溯源全量重放替代快照 | 最强可审计 | 很高 | 与文件型本地工具定位不符 | — | 高 | 不推荐 |

**推荐**：E1 本轮；E3 提请审批门单独决策；E4 排除。

### 表 F · 宿主集成层测试策略（Q8 / P2-3）

| 选项 | 收益 | 成本 | 风险 | 依赖 | 成熟度 | 推荐理由/条件 |
|---|---|---|---|---|---|---|
| F0 现状（纯层有测、宿主层无测） | — | 0 | P0-2/P0-3 这类缺陷无自动化防线 | — | — | 不可接受（缺陷已实证） |
| F1 注入接缝 + 手写假对象，新增 `service.spec.ts`（M19+M21） | 高（直接覆盖竞态/身份/ID） | 中 | 假对象与真实 DSH 服务漂移 | D1 的拆分更易做 | 高（S33） | **推荐第一步**：先覆盖 `acquireRunSlot`、runId、resume 授权三点 |
| F2 F1 + Nullable Infrastructure 包装（M20） | 高（测试可读性与复用） | 中-高 | 包装层自身需测试 | 3 个高频服务 | 中-高（S34） | 当宿主层测试超过 ~10 个用例时升级 |
| F3 + DTO 快照契约测试（M18） | 防面板字段漂移 | 低-中 | 快照噪声（需刻意最小化） | D2 | 高（S35） | 与 D2 同批 |
| F4 真实 DSH 端到端 | 最真 | 很高 | 慢且脆 | — | 高 | 只保留现有 `smoke-headless.mjs` 一条 |

**推荐**：F1 + F3；F2 视规模升级；F4 维持现状不扩张。

---

## 7. 结论摘要

**C1（强，A+B）**：性能瓶颈在**读路径的文件 I/O 与 YAML 解析**，而非算法；因此"调用更快"的最高性价比动作是让已写好的缓存真正生效（A1）并加写时失效（A2）。同仓库客户端已有正确形态的先例（F3），这是**行为等价修复**而非新设计。
- 适用条件：单进程、单实例插件；多实例场景需另议（M1 不适用项）。

**C2（强，A+B）**：`resumeRun` 的竞态修法不需要任何锁或依赖——单线程 run-to-completion 保证同步段原子（S14），把 check+set 前移并抽出 `acquireRunSlot()` 即可（B1+B2）；分布式锁/租约（M9）在当前单进程形态下是**超前设计**，明确不做。

**C3（中-强，A+B）**：runId 修法必须保留时间前缀。**纯 UUIDv4 会静默破坏"运行列表最新在前"**（F7，`run-store.ts:57-61`）——这是本轮调研相对诊断清单的**新增破坏性发现**，应写入实施约束。同时 `test-${Date.now()}` 完全无随机后缀（F6），比 runId 更易碰撞，需一并修。

**C4（中-强，A+B）**：模块化不需要新范式。引擎已是 Ports & Adapters 的核心（F9/S31），正确动作是**把既有做法延伸到宿主适配层**（D1→D2），并用 Humble Object 把路由/服务方法削薄（S32）。全量 hexagonal 重写与 DI 容器对 ~1.5k 行插件属过度工程，明确排除（D4）。

**C5（中-强，B-+B）**：「运行绑定不可变定义」在 Argo（`StoredWorkflowSpec`，S27）、Airflow 3（DAG versioning，S28）、Temporal（versioning/patching，S26）三个独立成熟系统上收敛，是对 P2-2「运行配置快照」的强对标支持。**但它改变 resume 语义**（改了 YAML 后恢复用旧逻辑），属于产品决策而非重构 → 必须走本工作流的**方案审批门**，本轮只落 `schemaVersion` + Tolerant Reader（E1）。

**C6（中，A+B）**：宿主集成层的缺陷（竞态、身份）之所以能长期存在，直接原因是**该层无任何测试**（F0）。修 P0 时必须同批补 3 个确定性测试（deferred 交错的双 resume、runId 唯一性+排序、API 运行的 resume 拒绝原因），否则同类缺陷会复发。

**建议实施批次（供下游"对抗评审 → 方案审批"使用）**

| 批次 | 内容 | 破坏风险 | 验证方式 |
|---|---|---|---|
| 批 1 | A1+A2（缓存作用域+写失效）、B1+B2（`acquireRunSlot`）、C1/C4（runId + `test-` 后缀 + 目录名校验） | 低 | `pnpm test` + 新增 3 个宿主层测试 + smoke |
| 批 2 | D1（executor/streams/run-id 抽取）、E1（schemaVersion + Tolerant Reader）、M19 注入时钟/随机 | 低-中 | 全量测试 + 面板手验 |
| 批 3 | D2（路由拆分 + DTO 单一源 + 快照契约）、F3 | 中（客户端硬契约） | 逐字段对齐 + smoke + 面板手验 |
| 待审批 | P0-3 身份语义（API 运行可否 resume）、E3 配置快照 | 中-高（语义变更） | 需人工审批门决策后再实施 |

---

## 8. 未解决问题、信息缺口与下一步计划

### 8.1 仍未解决的问题（需下游或用户决策）

| # | 问题 | 为何本步无法定论 | 建议决策者 |
|---|---|---|---|
| U1 | API 发起的运行**应否**可恢复？谁有权恢复？ | 属安全/产品语义，不是重构可顺带决定（M11 不适用项） | 方案审批门 |
| U2 | 运行配置快照的语义：resume 用快照还是用当前 YAML？ | 与用户"改了就想生效"的直觉冲突（M25 不适用项） | 方案审批门 |
| U3 | 是否要为多进程/多实例共享工作区预留租约机制？ | 取决于 ROADMAP 多租户时间表 | 用户/路线图 |
| U4 | 缓存 TTL 取值（30s 是否合适）、是否需要 mtime 校验 | 缺实测数据（见 U5） | 实施+回归阶段实测 |
| U5 | `/state` 的实际耗时与请求频率 | 本步为只读调研，未做基准测量 | 下一步（8.3 V1） |

### 8.2 信息缺口（证据强度的诚实边界）

- **无网页抓取能力**：所有外部来源仅确认 URL 存在与标题/片段命中，**正文未逐字核对**。因此 §5 的外部模式结论标注 B/B-/C，不引用页面行号。若评审要求 A 级外部证据，需要具备抓取能力的环境复核 S13–S35。
- **两条来源仅命中二手材料**：M16（Extract Class/Facade，检索只返回二手转述与书籍 PDF）与 S24（Kleppmann fencing，只命中相关讨论/PDF），强度按 B 记。
- **未做性能基准**：F2 是"成本项定性判断"（代码路径必然发生的 I/O 与解析），**不是实测数字**；缓存收益的量化留给 V1。
- **未验证 Node 版本对 UUIDv7 的原生支持**：C3 的成本列因此标注"视版本而定"（检索仅命中 Java/Ruby/Bun 侧实现）。
- **未核对 DSH 内部是否已提供可复用的 ID/锁工具**：本机 `@deepseek-ai/dsh/lib` 仅含入口壳文件，`randomUUID`/mutex 搜索无命中，故在 §5 中不假设可复用宿主工具。
- **本沙箱无法运行单元测试（已实测）**：`pnpm test` 在本会话失败于 `Error: spawn EPERM`（`esbuild` 加载 `vitest.config.ts` 时启动子进程被文件/进程沙箱拒绝），**这是环境策略限制，不是代码缺陷**；本会话审批弹窗被禁用，无法提权重试。可执行的替代基线：`pnpm typecheck` 已跑通（`tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json --noEmit`，退出码 0、无告警）。因此"批 1/批 2 的回归绿灯"这一条**尚未获得实测证据**，必须在允许子进程的环境中补跑（见 V5）。

### 8.3 下一步最有价值的验证动作

| # | 动作 | 命令/方法 | 目的 |
|---|---|---|---|
| V1 | 量化 `/state` 成本 | 起 DSH 后对 `GET /plugins/dsh-ace-harness/state` 连续 20 次计时；对照工作区内 workflow/run 数量 | 把 C1 从定性升级为实测，确定 TTL 与是否需要 M3/M4 |
| V2 | 复现 resume 竞态 | 新增 `tests/service-run-slot.spec.ts`：把 `loadRunState` 替换为可控 deferred，在其挂起期间并发调用 `resumeRun`，断言第二次抛错且 `active.size === 1` | 让 P0-2 有红灯，再改绿（M21） |
| V3 | 锁死 runId 契约 | 单测断言：①1e4 次生成无重复；②生成序列的字典序 == 时间序（保护 F7）；③匹配 `^[A-Za-z0-9_.-]+$` | 防 C2 式回归破坏运行列表顺序 |
| V4 | 固化旧 `state.json` 样本 | 把当前 `run-1787236769887-vjhra4dx/state.json` 拷为测试 fixture，断言加入 `schemaVersion` 后仍可加载/展示/resume | 为 E1/E2 提供旧格式回归网 |
| V5 | 基线回归 | `pnpm typecheck && pnpm test && node scripts/smoke-headless.mjs` | 建立"行为等价"判据（下游"行为基线"状态直接复用） |
| V6 | DTO 字段清单 | `grep` 三处投影（`index.ts:251-323`、`index.ts:466-487`、`tools.ts:20-45`）与 `src/client/types.ts` 交叉比对，产出字段矩阵 | D2/M18 的前置输入，避免拆分时字段漂移 |

---

## 附录 · 模式 → 问题 → 证据 速查

| 问题 | 推荐模式 | 关键证据 | 强度 |
|---|---|---|---|
| P0-1 失效缓存 | M1 M2（+M3 M4 M5 备选） | F1 F2 F3 / S18 S19 S20 S21 | A + B |
| P0-2 resume 竞态 | M6 M7（M8 M9 明确不适用） | F4 / S14（S22 S23 S24 为对照） | A + B |
| P0-3 API 身份 | M11（待审批） | F5 / S25 | A + B |
| P0-4 runId | M12 M13（含 F7 反例约束） | F6 F7 F8 / S13 S15 S16 S17 | A + B |
| P1-1 巨石 | M14 M15 M16 | F9 F11 / S31 S32 | A + B |
| P1-2 路由/投影 | M15 M18 | 三处重复投影 / S35 | A + B |
| P1-3 重复实现 | M17 | `dshHome` 语义漂移等 / S31 | A + B |
| P2-1 隐式全局 | M19 M20 | F10 / S34 | A + B |
| P2-2 持久化演进 | M23 M24（M25 待审批，M26 权衡） | F10 S11 S36 / S26 S27 S28 S29 S30 | A + B/B- |
| P2-3 宿主层无测试 | M21 M22（M20 升级） | F0 S36 / S33 S34 | A + B |
