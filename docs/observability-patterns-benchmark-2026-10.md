# 可观测性与诊断能力：架构模式对标（模式清单 + 证据 + 适用边界）

日期：2026-10 · 输入：本工作流「架构诊断」产出的可观测性问题清单（P0-A…P2）
需求：增强运行级可观测性与诊断能力——① 步骤级耗时分布与失败热点统计聚合（含重试次数）；② 审计链对异常/中断/超时路径也写 end 事件（含错误与证据哈希，补齐 engine 异常时不写 end 的缺口）；③ 工作台运行记录页展示失败热点与耗时分布。
约束不变：**全部测试通过、公开 API 不变、不新增运行时依赖、禁止破坏性 git 操作**。本文档只产出"可复用模式 + 证据 + 不适用场景"，不改代码。

---

## 1. 研究问题与方法

**研究问题**：针对可观测性问题清单的每一项，同类系统（工作流引擎 / 可观测性标准 / 事件日志基础设施 / 读模型实践）采用的架构模式是什么？证据强度如何？在本仓库约束（文件持久化、单进程插件、wire 冻结、无新依赖）下哪些适用、哪些不适用？

**问题拆解**：

| 编号 | 研究问题 | 类型 | 决策标准 |
|---|---|---|---|
| Q1 | 工作流/任务引擎如何保证"任何结局都落一条终态事件"（含异常/中断/超时路径）？ | 待验证事实 + 待比较选项 | end 事件在有错误/无错误路径都必须存在，且带 error 与证据哈希 |
| Q2 | 步骤级耗时的业界表达：均值还是分布（直方图/分位数）？失败热点与重试次数如何聚合？ | 待比较选项 | 不引入监控依赖；纯函数可测；数据来源为已持久化的 StepOutcome |
| Q3 | 生命周期收尾逻辑（settle + end 事件）如何获得测试接缝？ | 待比较选项 | beginRun 的拒绝路径可被单测钉住；公开 API 不变 |
| Q4 | 双统计路径（JSON 扫描 vs SQL 投影）重复聚合逻辑，业界如何处理"多读模型、单一聚合"？ | 待验证事实 + 待比较选项 | 两个 feed 保留、聚合内核收敛为一处 |
| Q5 | 审计事件在多模块散落写入，业界如何保证日志顺序与完整性（single writer）？ | 待比较选项 | 审计行构造单点；append 顺序确定 |
| Q6 | 一个"生产者无消费者"的路由（/stats）该接消费者还是删除？ | 待验证事实 | 与需求③结合：接消费者（工作台页面） |
| Q7 | "耗时"的多种口径（步骤时间戳推导 / startedAt-finishedAt 墙钟）如何收敛？ | 待验证事实 | 单一规范口径；wire 冻结兼容 |
| Q8 | 统计读路径（每次全量重扫 state.json）的缓存/物化形态？ | 待比较选项 | 面板 4s 轮询 + e2e p95 预算约束 |

**时间范围**：模式类证据取长期稳定的经典文献（2012–2026）；宿主/标准能力以本仓库锁定的 Node ^22/≥24 与当前依赖为准。
**术语约定**：`end 事件` = audit.jsonl 中的 `{event:'end', status, error, evidenceHash, durationMs}` 行；`settle` = `registry.settleStream + finishRun` 的收尾动作；`StepOutcome.attempts` = 重试后的总尝试次数（1 表示未重试）。

**方法**：
1. 一手代码核验：本会话用 `read`/`grep` 复核全部断言锚点（§4），不依赖诊断转述。
2. 检索优先级：官方规范/官方文档/经典原著（一手）→ 广泛采用的库/标准文档（二手）→ 社区材料（方向参考）。
3. 冲突检查：每条模式记录反方证据与消解条件（见 §3 各条"边界"）。
4. 约束检查：所有推荐形态均需满足"无新运行时依赖、wire 冻结、可被现有测试体系直接钉住"。

**证据强度分级**（沿用仓库既有 benchmark 文档约定）：
- **A** = 一手/权威：官方规范（OpenTelemetry、Prometheus、OWASP、MDN/Node）、经典原著、本仓库内直接验证的代码事实（附文件:行号）。
- **B** = 高质量二手：广泛采用的标准文档镜像、权威项目官方文档、知名技术写作。
- **C** = 社区经验：博客/SO/工具页，仅作方向参考，不单独支撑结论。

---

## 2. 来源清单（含权威性/时效性检查）

| # | 来源 | 类型 | 权威性与时效性检查 |
|---|---|---|---|
| S1 | [OpenTelemetry Trace API 规范（Span.End / IsRecording）](https://opentelemetry.io/docs/specs/otel/trace/api/)（[相关澄清 commit](https://github.com/open-telemetry/opentelemetry-specification/commit/ec58e4507c1966a0537804a8b81776921569b385)） | 一手（开放规范） | A。规范明确 End 之后 span 不再记录；未 end 的 span 不导出——"终态动作必须发生"的标准出处 |
| S2 | [OpenTelemetry 语义约定：Recording Errors](https://opentelemetry.io/docs/specs/semconv/general/recording-errors/) | 一手（开放规范） | A。错误必须作为 exception 事件/状态落在 span 上，而不是吞掉或漏记 |
| S3 | [Temporal 文档：Workflow Execution Events（事件历史）](https://docs.temporal.io/workflow-execution/event)（[Event History 百科页](https://docs.temporal.io/encyclopedia/event-history)） | 二手（权威项目官方文档） | B。工作流引擎的事件历史**必然以终态事件收尾**（Completed/Failed/Canceled/Terminated），无论执行如何结束——对 Q1 的最强同型对标 |
| S4 | [Google SRE 书：Monitoring Distributed Systems（四个黄金信号）](https://sre.google/sre-book/monitoring-distributed-systems/) | 一手（权威原著，公开免费） | A。latency/traffic/errors/saturation 是"该测什么"的标准框架；耗时用分布不用均值 |
| S5 | [Prometheus 文档：Histograms and summaries（分位数）](https://prometheus.io/docs/practices/histograms/) | 一手（项目官方文档） | A。直方图 + 分位数估计是耗时分布的事实标准；均值被明确提示不可靠 |
| S6 | [The Tail at Scale — Dean & Barroso (2013)](https://research.google/pubs/pub44145/)（[ACM 版](https://dl.acm.org/doi/10.1145/2408776.2408794)） | 一手（权威论文） | A。长尾分位数（p99）比均值更能暴露真实体验；"尾部即问题所在" |
| S7 | [Apache Kafka 文档：设计——追加写日志与分区内顺序](https://kafka.apache.org/documentation/#intro_ordering) | 一手（项目官方文档） | A。追加写 + 每分区单写者保证顺序与完整性——"日志只有一个写者"的权威出处 |
| S8 | [Apache BookKeeper / DistributedLog：single-writer 语义](https://bookkeeper.apache.org/docs/next/api/distributedlog/)（[实现 diff](https://apache.googlesource.com/bookkeeper/+/64102086e3bf25e52c1e019cc7f6aa13bdad2ec5%5E%21/)） | 一手+二手（项目官方文档/源码） | A/B。显式命名 single-writer 语义并给出强制手段 |
| S9 | [Microservices.io：Transactional Outbox 模式 — Chris Richardson](https://microservices.io/patterns/data/transactional-outbox.html)（[补充文](https://james-carr.org/posts/2026-01-15-transactional-outbox-pattern/)） | 二手（权威作者） | B。事件与状态变更同源同序写出；本仓库无 DB 事务，只借"事件在 persist 时同链写出"的语义 |
| S10 | [OWASP Logging Cheat Sheet（完整性/追加写/终态事件含错误细节）](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) | 一手（权威指南） | A。审计日志应含结果/错误信息、应防篡改（本仓库已有证据哈希） |
| S11 | [OWASP API Security Top 10：API9:2023 Improper Inventory Management](https://owasp.org/API-Security/editions/2023/en/0xa9-improper-inventory-management/) | 一手（权威指南） | A。"没被消费的 API 端点 = 资产清单问题"；路由要么有消费者要么摘除 |
| S12 | [MDN performance.now()（单调、亚毫秒）](https://developer.mozilla.org/en-US/docs/Web/API/Performance/now)（[Node.js perf_hooks](https://nodejs.org/api/perf_hooks.html)） | 一手（标准文档） | A。测量耗时用单调钟；墙钟只作时间戳 |
| S13 | [Your Clock Can Go Backward — Use the Right One for Durations（DEV）](https://dev.to/luciano655/your-clock-can-go-backward-use-the-right-one-for-durations-1ic) | 二手（技术写作） | B。墙钟跳变/回拨会污染耗时；durational 测量应排除 NTP 调整 |
| S14 | [Martin Fowler：CQRS（读写模型分离）](https://martinfowler.com/bliki/CQRS.html)（[Single Source of Truth](https://martinfowler.com/bliki/SingleSourceOfTruth.html)） | 一手（权威作者原著） | A/B。多个读模型允许，但聚合逻辑须单点；"单一事实源"判定条件 |
| S15 | [Azure Architecture Center：Materialized View 模式](https://learn.microsoft.com/azure/architecture/patterns/materialized-view)（[Cache-Aside 模式](https://learn.microsoft.com/azure/architecture/patterns/cache-aside)） | 二手（官方模式目录） | B。预计算读模型 + cache-aside 是统计类读路径的标准形态 |
| S16 | [Martin Fowler：Memory Image（易失状态从持久真源重建）](https://martinfowler.com/bliki/MemoryImage.html) | 一手（权威作者原著） | A/B。内存统计累加器 = 持久 run 状态的物化视图，崩溃后可重建 |
| S17 | [Working Effectively with Legacy Code — Michael Feathers（seam / characterization test）](https://www.amazon.com/Working-Effectively-Legacy-Michael-Feathers/dp/0131177052)（[要点摘要](https://github.com/mattpocock/agent-rules-books/blob/main/working-effectively-with-legacy-code/working-effectively-with-legacy-code.md#1)） | 一手（原著）+摘要 | A。改动无测试覆盖的收尾链前先织测试网 |
| S18 | [Martin Fowler：Humble Object（宿主壳变薄）](https://martinfowler.com/bliki/HumbleObject.html) | 一手（权威作者原著） | A/B。收尾决策逻辑下沉纯函数，宿主只做转发 |
| S19 | [vibealive（检测未使用的文件与 API）](https://github.com/skullzarmy/vibealive)（[Laravel Tombstone](https://packagist.org/packages/wprigollopes/laravel-tombstone)） | 二手（工具） | C。死代码/死路由的机械检测方向参考；本仓库用手工 grep 即可 |
| S20 | [OneUptime：Forgetting to Close Spans（未 end 的 span 泄漏）](https://oneuptime.com/blog/post/2026-02-06-fix-forgetting-to-close-spans/view)（[Not Calling Span.End](https://oneuptime.com/blog/post/2026-02-06-fix-not-calling-span-end/view)） | 二手（技术写作） | C。社区对"漏终态动作"后果的实证描述，方向性参考 |

---

## 3. 可复用架构模式清单（按诊断问题映射）

### A. 终态事件不可缺失：settle 逻辑挂在 finally 而非 then → P0-A

- **模式**：任何执行路径（成功、失败、取消、中断、启动即抛错）都必须产生一条终态事件，且终态事件携带结局与错误细节；收尾动作属于"保证发生"的代码，不放在成功回调用 `.then` 里。
- **证据**：
  - S3（B）：Temporal 事件历史**必然以 WorkflowExecutionCompleted / Failed / Canceled / Terminated 之一收尾**——工作流引擎把"终态事件"当作历史完整性的硬不变量；
  - S1/S2（A）：OpenTelemetry span 必须 End，未 end 的 span 不导出（遥测丢失）；错误以 status/exception 记录在 span 上——"终态动作 + 错误信息"是标准强制；
  - S10（A）：审计日志应记录结果与错误细节。
  - 事实层（§4-F1，A）：本仓库 `beginRun`（`src/run-lifecycle.ts:346-366`）把 end 行、`settleStream`、`finishRun` 全放在 `runStateMachine(options).then(...)` 成功回调里；engine 在 **try 之外**抛出的 `EngineError`（`src/engine/runner.ts:73-75` NO_INITIAL、`:88-91` NO_MATCH）使 promise reject → `.then` 被跳过 → 无 end 行、流不 settle（`streams` 条目残留，prune 只由 `settleStream` 调度，`src/run-registry.ts:170-179`）、`progressTrack` 游标不回收（`src/run-registry.ts:97-99`）。
- **推断链**：拒绝路径跳过 `.then`（事实）→ end 事件缺失、流条目与游标泄漏（推断，已被代码路径确认）→ 收尾动作应移到 promise 的拒绝分支/`finally` 形态（结论）：engine 侧保证"异常也写终态"，lifecycle 侧保证"reject 也 settle + 写 end（status=failed/crashed，error=message，evidenceHash=当前已持久化证据的哈希）"。
- **适用条件**：engine 的 `NO_INITIAL`/`NO_MATCH` 是启动前校验，属"运行未真正开始"——end 事件语义建议标 `status:'failed'` 与可读 error，而非伪造已完成；`crashed`（进程级中断，无进程可写 end）不在本模式范围。
- **不适用场景/边界**：①进程被杀/断电时没有任何代码可写 end——这是 `normalizeStaleRun`（`src/store/run-store.ts:77-88`）的职责（读时把僵尸 `running` 标为 `crashed`），不要把"崩溃也写 end"硬塞进本模式；②end 行形状（`event/status/error/evidenceHash/durationMs`）被 `sqlite-archive` 重放与 `scripts/e2e-platform.mjs:156-160` 断言冻结，新增字段只能兼容式追加。
- **证据强度**：A（缺口事实 + 规范）+ B（Temporal 对标）。

### B. 耗时用分布不用均值；热点 = 分组计数（失败优先）→ P0-B

- **模式**：
  - 耗时聚合：固定桶直方图（如 0–1s/1–5s/5–30s/30–120s/>120s）+ 计数，展示时分位数（p50/p95/p99）或桶分布；均值单独展示会掩盖长尾。
  - 失败热点：按 (workflow/state/step, verdict) 分组计数，失败优先排序，并叠加重试总次数/分布（`attempts-1` 的求和与按步骤分组）。
- **证据**：S4（A，黄金信号：latency + errors）、S5（A，直方图与分位数是事实标准，均值被提示不可靠）、S6（A，长尾分位数暴露真实问题）；事实层（§4-F2/F3，A）：`WorkspaceRunStats` 目前只有 `avgDurationMs`（均值）与 (state, verdict) 热点（`src/store/run-stats.ts:17-25,56-61`），**没有**步骤级耗时分布与重试聚合；`attempts` 已在 `StepOutcome` 逐步骤持久化（`src/engine/types.ts:27-28`、`src/engine/state-steps.ts:234,264,301`）并已投影到 DTO 与 UI 单步徽标（`src/projections.ts:22,35`、`src/client/Workbench.tsx:729-731`）——聚合所需的原始数据**已经存在**。
- **推断链**：均值掩盖长尾（规范事实）→ 当前只有均值（事实）→ 加固定桶直方图 + 分位数（结论）；attempts 已持久化（事实）→ 聚合只需求和/分组，不改数据源（结论）。
- **适用条件**：桶边界需匹配本仓库步骤的真实量级（秒~分钟级步骤、`stepTimeoutMs` 默认 1800s）；脚本步骤超时分钟换算已有先例（`src/engine/state-steps.ts:50-52`）。
- **不适用场景/边界**：**前置缺陷（本调研新发现）**：脚本步骤在 `src/engine/state-steps.ts:194-195` 用连续两次 `now()` 同时打 `startedAt`/`finishedAt` → 脚本步骤耗时恒 ≈0，步骤级耗时统计必须先修正打点（围绕真实执行测量）才有意义；且当前所有打点都是墙钟（§4-F7），长耗时受 NTP 回拨影响（S13）——建议打点用单调钟、审计时间戳仍用墙钟（见 §3-G）。
- **证据强度**：A（规范 + 数据已存在的事实）+ B（对标）。

### C. 收尾链的可测性：先织测试网，再把收尾决策下沉纯函数 → P1-A

- **模式**：改动无测试覆盖的收尾链前，先（a）在 seam 处补特征化测试钉住现状（Feathers），再（b）把"settle + 写 end"决策抽为可独立构造/测试的纯函数或协作者（Humble Object），宿主壳只做转发。
- **证据**：S17（A，seam 与特征化测试的原始出处）、S18（A/B，Humble Object）；事实层（§4-F9，A）：`beginRun` 是 `RunLifecycle` 的私有闭包（`src/run-lifecycle.ts:340-366`），tests 目录无任何 import `RunLifecycle` 的用例；`runner.spec` 全部用假执行器测引擎，`audit-events.spec` 只测纯派生函数——"拒绝路径不写 end"这一行为**没有任何测试钉住**。
- **推断链**：beginRun 私有且无测试（事实）→ 直接改收尾逻辑风险不可见（推断）→ 先抽 seam（如导出 `settleRunEnd(registry, persistence, workspace, runId, runResultOrError)`）并补拒绝路径单测（结论）。`RunLifecycle` 不是包导出面（§4-F9），导出新函数/类不破公开 API。
- **不适用场景/边界**：特征化测试钉住的是现状——对 P0-A 这类"现状即缺口"的项，新测试应直接钉住**修复后的目标行为**（拒绝路径写 end），不要先钉 bug 再改。
- **证据强度**：A（缺口事实 + 原著）。

### D. 单一聚合内核 + 多读模型 feed → P1-B

- **模式**：统计查询允许两个数据源（JSON 扫描 / SQL 投影），但聚合数学（byStatus / 耗时 / 热点排序）必须只有一个实现；两个 feed 只负责把各自数据规整成同一最小投影，喂给同一个纯聚合函数。
- **证据**：S14（A/B，CQRS 允许多读模型；SSOT 判定"逻辑单点"）；事实层（§4-F4，A）：`aggregateRunStats`（`src/store/run-stats.ts:40-70`）与 `combineStatsProjection`（`:80-107`）各自重新实现 byStatus/耗时/热点三段数学；`tests/run-stats.spec.ts:48-63` 已在断言两者输出等价——等价性是测试钉住的承诺，但实现重复。
- **推断链**：两实现数学重复且靠测试维持等价（事实）→ 收敛为"一个 `aggregateWorkspaceStats` 内核 + 两个 feed 适配"（结论）：JSON 扫描先投影为 `RunStatsProjection` 形状（或内核直接接受 rows），SQL 侧保持 SQL 提取但复用同一内核——重复消除，等价测试保留。
- **不适用场景/边界**：不要为"统一"把 SQL 侧改回 JSON 扫描（破坏归档开启时的性能收益）；也不要为"去重"提前抽象出不存在的第三个 feed（YAGNI）。新增步骤级统计时应直接落在**共享内核**上，避免再次出现双实现。
- **证据强度**：A（事实 + SSOT 判定）+ B（CQRS 对标）。

### E. 审计行单写者：构造单点、append 顺序确定 → P1-C（与 P0-A 同源）

- **模式**：事件日志只有一个逻辑写者；所有事件行（start/resume/end/state-end/waiting-human/human-resolved）由同一构造入口产出并在同一时序（serialized persist 链）内 append，保证顺序与完整性。
- **证据**：S7（A，Kafka 追加写 + 分区单写者保证顺序）、S8（A/B，DistributedLog 显式命名 single-writer）、S9（B，outbox：事件与状态变更同链写出——本仓库无 DB 事务，语义收敛为"审计行在 persist 串行链内写出"）；事实层（§4-F5，A）：audit 行构造散布在 `src/run-lifecycle.ts:169-175`（start）、`:325-331`（resume）、`:352-360`（end）与 `src/run-persistence.ts:184-193`（派生事件）四处；物理写已收敛到 `writeAudit`（`src/run-persistence.ts:142-147`，JSONL append + SQLite 镜像），缺的是**构造点**的收敛。
- **推断链**：构造点散落 + end 事件本身存在缺口（事实）→ 收口为单一"审计事件工厂"（`buildAuditEvent(kind, ctx)` 纯函数）+ 全部经 `writeAudit` 落盘（结论）；persist 链已串行化（`src/run-persistence.ts:157-167`），派生事件顺序已确定，end 事件补在收尾处即可保持全链顺序。
- **不适用场景/边界**：①不要为"单写者"引入进程级锁——单进程内 promise 链已串行，无并发写者（S8 的 ZooKeeper 式强制是分布式语义，不适用）；②start/resume 行在 `beginRun` 之前由生命周期写，与 persist 链不同步是**有意**的（运行尚未开始没有 persist），工厂化即可、不必强行并入 persist 链。
- **证据强度**：A（事实）+ B（single-writer/outbox 对标）。

### F. 无消费者的端点：接消费者优先于删除 → P1-D（与需求③直接耦合）

- **模式**：API 清单里每个端点都应有明确消费者；"生产者无消费者"是资产清单问题——要么接线（找到真实消费者），要么摘除。
- **证据**：S11（A，API9:2023：未消费/未记录的端点是清单问题）；事实层（§4-F6，A）：`/stats` 路由存在（`src/index.ts:684-704`、`src/service.ts:703-719`），client 侧 grep 零引用，唯一消费者是 `scripts/e2e-platform.mjs:166-170`（断言形状与 p95 预算）与 `README.md:84` 文档——**对用户 UI 而言是死路由**。
- **推断链**：路由有服务端实现 + e2e 断言但无 UI 消费者（事实）→ 需求③（工作台运行记录页展示失败热点与耗时分布）正是该路由的天然消费者（结论）：把 `WorkspaceRunStats` 增量字段接进 Workbench 运行记录页（侧栏/详情），路由从"死"转"活"，无需删除。
- **不适用场景/边界**：若未来某端点确认无消费者且无文档价值，应摘除（S11）；但本案例中 e2e 脚本已把它当契约钉住，删除会破坏 `e2e-platform.mjs`——删除路线明确不适用。
- **证据强度**：A（事实 + 指南）。

### G. 耗时口径单一化：单调钟测量、墙钟作时间戳 → P1-E

- **模式**：一条记录里区分"时间戳"与"耗时"：时间戳用墙钟 ISO（人类可读时间线、跨进程对齐），耗时用单调钟（`performance.now()`/`process.hrtime.bigint()`）在事件发生现场测量；同一范围（步骤/状态/运行）只保留一个规范耗时定义。
- **证据**：S12（A，performance.now 单调、亚毫秒；Node perf_hooks）、S13（B，墙钟回拨污染耗时）；事实层（§4-F7，A）：本仓库三种耗时口径并存——`runDurationMs`（由步骤时间戳推导，`src/store/audit-events.ts:31-36`）、`outcomeDurationMs`（步骤时间戳，`:23-28`）、`avgDurationMs`（startedAt/finishedAt 墙钟差，`src/store/run-stats.ts:49-54,90-98`）；全仓打点均为 `new Date().toISOString()`（`src/engine/state-steps.ts:16`、`src/engine/runner.ts:24`），无单调钟。
- **推断链**：三种口径 = 同一名词三种含义（事实）→ 定义规范：**步骤耗时 = 该步骤单调钟起止差；状态耗时 = 状态内步骤跨度；运行耗时 = finishedAt − startedAt（墙钟，兼容既有 end 事件语义）**（结论）；新统计字段只加不改（state.json/audit 形状冻结，§4-F1 边界）。
- **适用条件**：`durationMs` 字段在 audit 'end'/'state-end' 上已被 e2e 断言为 number（`scripts/e2e-platform.mjs:160-162`）——规范后必须保持字段存在且仍为 number。
- **不适用场景/边界**：①不要把审计 `at` 时间戳改成单调钟（人类时间线需要墙钟，S12 边界）；②不要在持久化格式上做迁移（旧 state.json 无单调钟数据，按缺失处理即可，§4-F8）。
- **证据强度**：A（规范 + 事实）。

### H. 统计读路径：物化视图/累加器 + 短 TTL 缓存 → P2

- **模式**：被高频轮询的聚合读路径不每次全量重扫源数据；用（a）cache-aside 短 TTL 缓存，或（b）增量维护的内存累加器（物化视图），崩溃后从持久 run 状态重建。
- **证据**：S15（B，Materialized View + Cache-Aside 是统计读路径标准形态）、S16（A/B，Memory Image：易失累加器从真源重建）、S14（B，CQRS 读模型）；事实层（§4-F8，A）：`/state` 每次轮询对每工作区 `listRunStates` 全量读+解析（`src/index.ts:240-248` → `src/store/run-store.ts:91-98`）；`workspaceStats` 的 JSON 扫描路径同样全量重扫（`src/service.ts:707-716`）；现有缓存仅覆盖 topology/taskFields（30s，`src/index.ts:173-174`）与归档计数（`src/service.ts:646-655`）；e2e 对 stats 路由的 p95 预算为 200ms（`scripts/e2e-platform.mjs:193`）——随运行历史增长，全量扫描必破预算。
- **推断链**：stats/state 读路径无缓存（事实）→ 历史增长时全量重扫线性变慢（推断）→ 首选"读时缓存（TTL，写时失效）+ 聚合结果物化"；归档开启时直接走 SQL 投影（已是物化形态）（结论）。
- **适用条件**：TTL 陈旧对聚合类展示可容忍（面板 4s 轮询；统计非单次运行关键路径）；写路径（persist）可顺带失效 stats 缓存键。
- **不适用场景/边界**：①不要引入外部缓存库/内存数据库（破"不新增运行时依赖"）；②不要缓存"运行中"运行的细节（实时性要求高），只缓存聚合结果；③物化累加器要能从 JSON 重建（S16），否则进程重启后统计失真。
- **证据强度**：A（事实 + 规范）+ B（模式目录）。

---

## 4. 本仓库直接验证的前置事实（本会话复核，A 级）

| # | 事实 | 定位 | 对结论的作用 |
|---|---|---|---|
| F1 | `beginRun` 的 end 行/settleStream/finishRun 全在 `.then()` 成功回调；engine 在 try 外抛 `NO_INITIAL`/`NO_MATCH` 时 reject → 三者全被跳过；`.finally(release)` 只清 active 控制器 | `src/run-lifecycle.ts:346-366`、`src/engine/runner.ts:73-75,88-91,98` | P0-A 成立：拒绝路径无 end 事件 + 流/游标泄漏 |
| F2 | `WorkspaceRunStats` 无步骤级字段：仅 totalRuns/byStatus/avgDurationMs/lastRunAt/stateHotspots((state,verdict)) | `src/store/run-stats.ts:17-25,56-61` | P0-B 成立：步骤级耗时分布与重试聚合缺失 |
| F3 | `attempts` 已逐步骤持久化（llm/subworkflow/agent 设值，script 不设）；DTO 与 UI 单步徽标已用；仅缺聚合 | `src/engine/types.ts:27-28`、`src/engine/state-steps.ts:179-196,234,264,301`、`src/projections.ts:22,35`、`src/client/Workbench.tsx:729-731` | P0-B 的原始数据已齐，聚合是纯增量 |
| F4 | 双统计路径各写一份聚合数学，`run-stats.spec` 断言两者等价 | `src/store/run-stats.ts:40-70 vs 80-107`、`tests/run-stats.spec.ts:48-63` | P1-B 成立：收敛内核、保留双 feed 与等价测试 |
| F5 | 审计行构造散布 4 处（start/resume/end/派生事件）；物理写已收敛 `writeAudit` | `src/run-lifecycle.ts:169-175,325-331,352-360`、`src/run-persistence.ts:142-147,184-193` | P1-C 成立：构造点收敛即可，写入已有单点 |
| F6 | `/stats` 路由存在且被 e2e 与 README 引用；client 零引用 | `src/index.ts:684-704`、`src/service.ts:703-719`、`scripts/e2e-platform.mjs:166-170`、`README.md:84`；grep `src/client` 无 `stats` 命中 | P1-D 成立：接消费者（需求③）而非删除 |
| F7 | 三种耗时口径并存；全仓无单调钟打点；script 步骤 startedAt==finishedAt（耗时恒 0） | `src/store/audit-events.ts:23-28,31-36`、`src/store/run-stats.ts:49-54,90-98`、`src/engine/state-steps.ts:16,194-195`、`src/engine/runner.ts:24`；grep `performance.now` 无命中 | P1-E 成立 + 前置缺陷（script 耗时打点） |
| F8 | `/state` 与 stats JSON 扫描每次全量重读所有 state.json；仅 topology/taskFields（30s）与归档计数有缓存 | `src/index.ts:173-174,240-248`、`src/service.ts:646-655,707-716`、`src/store/run-store.ts:91-98`、`scripts/e2e-platform.mjs:192-194` | P2 成立：历史增长必破 stats p95 预算 |
| F9 | `beginRun` 私有闭包；tests 无任何 `RunLifecycle` import；`RunLifecycle` 非包导出面 | `src/run-lifecycle.ts:340-366`；grep `tests/` 仅 run-persistence/refactor-regression import `RunPersistence` | P1-A 成立：抽 seam 不破公开 API |

---

## 5. 选项比较表（收益/成本/风险/依赖/成熟度/推荐）

### 决策点 1：P0-A + P1-C —— end 事件缺口与审计行收敛
| 选项 | 收益 | 成本 | 风险 | 依赖 | 成熟度 | 推荐 |
|---|---|---|---|---|---|---|
| ①收尾动作移入拒绝分支/finally 形态：reject 也写 end（status=failed/crashed+error+evidenceHash）+ settleStream + finishRun | 堵缺口、流/游标不再泄漏；e2e"审计含 end"对拒绝路径也成立 | 低（重构 beginRun 的 promise 链） | end 行形状被 e2e/sqlite 重放冻结，只能兼容式加字段 | 无 | 高（S3/S1/S2） | **推荐** |
| ②①+审计事件工厂（构造单点）+ 全部经 writeAudit | 审计链顺序/完整性确定 | 低-中（4 处构造点收口） | start/resume 与 persist 链天然不同步，工厂化即可勿强并入 | 无 | 高（S7/S8/S9） | **推荐**，与①同批 |
| ③进程级锁/分布式 single-writer 强制 | 多进程安全 | 高 | 单进程插件属超前设计 | 新机制 | 中 | 不推荐（§3-E 边界） |

### 决策点 2：P0-B —— 步骤级统计形态
| 选项 | 收益 | 成本 | 风险 | 依赖 | 成熟度 | 推荐 |
|---|---|---|---|---|---|---|
| ①固定桶直方图（步骤耗时）+ p50/p95 + (state,step,verdict) 失败热点 + attempts 聚合，落在共享聚合内核 | 长尾可见、热点可诊断、重试可量化 | 中（纯函数 + 双 feed 适配 + spec） | 必须先修 script 步骤打点（F7）否则耗时恒 0 | 无 | 高（S4/S5/S6） | **推荐** |
| ②只加均值/计数 | 成本最低 | 低 | 均值掩盖长尾（S5/S6 明示） | 无 | 低 | 不推荐单独做 |
| ③引入 Prometheus/统计库 | 生态成熟 | 高 | 破"不新增运行时依赖" | 新依赖 | 高 | 不推荐本轮（§3-B 边界） |

### 决策点 3：P1-A —— beginRun 可测性
| 选项 | 收益 | 成本 | 风险 | 依赖 | 成熟度 | 推荐 |
|---|---|---|---|---|---|---|
| ①抽导出纯函数/协作者 `settleRunEnd(...)` + 拒绝路径单测 | 收尾链有测试网；P0-A 修复被钉住 | 低-中（纯结构移动） | RunLifecycle 非包导出面，移动安全（F9） | 无 | 高（S17/S18） | **推荐** |
| ②保持私有 + 仅靠 e2e 覆盖 | 零改动 | 0 | 拒绝路径无单测，回归不可见 | 无 | 低 | 不推荐 |

### 决策点 4：P1-B —— 双统计路径
| 选项 | 收益 | 成本 | 风险 | 依赖 | 成熟度 | 推荐 |
|---|---|---|---|---|---|---|
| ①单一聚合内核 + JSON/SQL 双 feed 适配，等价测试保留 | 数学单点、新增步骤统计只改内核 | 低-中 | SQL 提取与 JSON 投影需保持同一最小投影形状 | 无 | 高（S14） | **推荐** |
| ②维持现状（双实现） | 0 | 0 | 步骤级统计要再写两遍，漂移风险随字段增多放大 | 无 | 现状 | 不推荐（P0-B 落地时必然暴露） |

### 决策点 5：P1-D —— /stats 路由去向（耦合需求③）
| 选项 | 收益 | 成本 | 风险 | 依赖 | 成熟度 | 推荐 |
|---|---|---|---|---|---|---|
| ①工作台运行记录页接 /stats（侧栏热点 + 详情耗时分布） | 死路由转活；需求③完成 | 中（client 展示组件 + 新字段） | wire 形状兼容式新增字段，client/types 手工镜像需同步 | 无 | 高（S11） | **推荐** |
| ②删除路由 | 清单干净 | 低 | 破坏 e2e-platform.mjs 断言与 README 契约 | — | — | 不适用（§3-F 边界） |

### 决策点 6：P1-E —— 耗时口径
| 选项 | 收益 | 成本 | 风险 | 依赖 | 成熟度 | 推荐 |
|---|---|---|---|---|---|---|
| ①规范口径：步骤/状态=单调钟现场测量；运行=finishedAt−startedAt；审计 `at` 保持墙钟；script 步骤补打点 | 三种口径合一、script 耗时真实 | 中（打点改动 + 规范文档） | 旧数据无单调钟值（缺失处理）；durationMs 字段保持 number（e2e 断言） | 无 | 高（S12/S13） | **推荐** |
| ②维持三义并存 | 0 | 0 | "耗时"含义依调用点而异，统计展示自相矛盾 | 无 | 现状 | 不推荐 |

### 决策点 7：P2 —— 统计读路径
| 选项 | 收益 | 成本 | 风险 | 依赖 | 成熟度 | 推荐 |
|---|---|---|---|---|---|---|
| ①stats/state 聚合结果加短 TTL 缓存（写时失效）；归档开启走 SQL 投影（物化读模型） | 轮询不再全量重扫；p95 预算可守 | 低-中 | 陈旧 ≤TTL（统计可容忍）；写路径需挂失效点 | 无 | 高（S15/S16） | **推荐** |
| ②增量内存累加器（persist 时更新，崩溃后从 JSON 重建） | 读 O(1) | 中-高 | 重建逻辑要与聚合一致（复用共享内核即可） | 无 | 中-高 | 第二阶段（①不足时升级） |
| ③每次全量重扫（现状） | 0 | 0 | 历史增长必破 stats p95 200ms 预算 | 无 | 现状 | 不可接受（e2e 已设预算） |

---

## 6. 不适用场景总表（模式→本仓库的例外）

1. **完整 OTel/分布式追踪接入**——不引入遥测 SDK；只借用 span 生命周期纪律（必须 End、错误要记录）与错误语义约定（§3-A）。
2. **Prometheus/时序数据库/统计库**——本地文件型工具，固定桶直方图纯 JS 实现即可（§3-B）。
3. **完整事件溯源/outbox 事务**——无 DB 事务边界；只借"事件与状态变更同链写出 + 追加写"语义（§3-E）。
4. **分布式 single-writer 强制（ZooKeeper 式锁）**——单进程插件，persist 链已串行（§3-E）。
5. **删除 /stats 路由**——e2e 契约 + README + 需求③让它必须有消费者（§3-F）。
6. **审计 `at` 时间戳改单调钟**——时间线要墙钟；单调钟只用于耗时测量（§3-G）。
7. **持久化迁移/版本化重写 state.json**——旧格式按缺失处理，只加字段不改语义（§3-G、F1 边界）。
8. **为统计引入缓存库/内存数据库**——破"不新增运行时依赖"；TTL Map + 共享聚合内核足够（§3-H）。
9. **进程崩溃也保证写 end**——进程死亡无代码可执行，由 `normalizeStaleRun` 读时兜底（§3-A 边界）。

---

## 7. 未解决问题、信息缺口与下一步验证计划

| # | 缺口 | 影响 | 下一步验证动作 | 责任环境 |
|---|---|---|---|---|
| G1 | vitest 无法在本沙箱运行（node 禁派生孙进程，历史一致） | 全部改动的回归验证 | `pnpm typecheck && pnpm test`，重点 run-stats.spec / runner.spec / audit-events.spec / refactor-regression.spec / e2e-platform.mjs | 宿主 |
| G2 | 拒绝路径写 end 的语义细节：`status` 取 failed 还是 crashed、evidenceHash 对未开始运行的取值 | P0-A 修复形态 | 方案审批门定夺后，补 `settleRunEnd` 拒绝路径单测钉住 | 方案审批 + 宿主 |
| G3 | 步骤耗时直方图桶边界取值（秒~分钟级步骤、timeoutMinutes 覆盖） | P0-B 展示质量 | 用现有 runs 目录（`.ace-workflows/runs/*/state.json`）实测 step 耗时分布后定桶 | 宿主 |
| G4 | script 步骤打点修正（startedAt/finishedAt 围绕真实执行）是否会改变 runner.spec 既有断言 | P0-B 前置缺陷 | 宿主跑 runner.spec + 审阅 script 步骤用例 | 宿主 |
| G5 | stats/state 聚合缓存 TTL 与失效点的选取（persist 写时失效 vs 纯 TTL） | P2 形态 | 量化 `/state`、`/stats` 现耗时（e2e 已计时）后定 TTL | 宿主 |
| G6 | 工作台页面展示形态（侧栏热点列表 vs 详情分布条） | 需求③ UX | 参照 ArchiveDetailView/`stats` 新字段做最小展示，wire 形状先冻结 | 实施步骤 |
| G7 | 旧运行数据无单调钟耗时 | 步骤统计只覆盖新运行 | 缺失按 null/不计入处理，文档声明统计起点 | 实施步骤 |

---

## 8. 结论摘要

8 个模式（A–H）覆盖可观测性问题清单 P0-A…P2 全部项，每项均有一手证据（官方规范/权威原著/本仓库逐行复核）支撑，反方证据（分布式 single-writer、删除死路由、均值足够）已逐条消解或转化为适用边界。核心结论：

1. **P0-A 是收尾动作放错位置**：end/settle 在 `.then` 成功回调，engine 启动前校验异常直接 reject 跳过——修法是"收尾进 finally/拒绝分支"（Temporal 终态事件不变量 + OTel span 必须 End 的标准语义，S1/S2/S3）。
2. **P0-B 的原始数据已齐**：`attempts` 已逐步骤持久化并投影，缺的只是聚合——固定桶直方图 + p50/p95 + 失败优先热点，全部落在共享聚合内核（S4/S5/S6）；**前置缺陷**：script 步骤耗时打点恒 0，必须先修。
3. **P1-A 与 P0-A 同批修**：抽 `settleRunEnd` seam + 拒绝路径单测（S17/S18）；`RunLifecycle` 非包导出面，移动安全（F9）。
4. **P1-B 收敛内核、保留双 feed**：`run-stats.spec` 的等价断言继续当契约（F4/S14）。
5. **P1-C 收口构造点**：审计事件工厂 + 全部经 `writeAudit`，单写者语义在单进程内由 persist 串行链天然满足（S7/S8/S9）。
6. **P1-D 接消费者不删除**：工作台运行记录页即需求③，/stats 从死路由转活（S11/F6）。
7. **P1-E 规范口径**：单调钟测耗时、墙钟作时间戳、三种口径合一（S12/S13/F7）。
8. **P2 缓存/物化**：聚合结果短 TTL 缓存 + 归档开启走 SQL 投影（物化读模型），守 e2e p95 预算（S15/S16/F8）。

所有推荐形态均满足"测试通过、公开 API 不变、不新增运行时依赖"；行为差异（拒绝路径新增 end 行、script 步骤耗时从 0 变真实、步骤统计为新增字段）属预期内并需 PR 声明。残余验证集中在宿主环境：跑测试（G1）、桶边界实测（G3）、script 打点回归（G4）、缓存量化（G5）。

---

*推断链说明：本文"事实"均为代码锚点或规范条文（A 级）；"推断"为从事实到模式适用性的推理；"结论"为可执行的形态选择。全部仓库锚点经本会话逐条复核（§4），与本工作流「架构诊断」问题清单（P0-A…P2）一致。*
