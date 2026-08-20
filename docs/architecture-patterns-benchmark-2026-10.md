# 架构最佳实践对标：模式清单 + 证据 + 适用边界

日期：2026-10（v2）· 输入：[`architecture-diagnosis-2026-10.md`](./architecture-diagnosis-2026-10.md)（二轮复核版，问题清单 P0-1…P3）
约束不变：**全部测试通过、公开 API 不变**。本文档只产出"可复用模式 + 证据 + 不适用场景"，不改代码。
v2 变更：对齐二轮诊断——修正 §3-E 的 P1-1 语义（find=最旧 vs sort.at(-1)=最新）；新增 §3-M（P1-2⑤ 恢复运行投影重建）、§3-N（P1-2⑥ 同步 SQLite I/O）、§3-O（P2-4 客户端常量重复）；补充来源 S16–S19 与决策点 6–8；全部仓库内锚点经本会话重新逐条复核（§4）。

## 1. 研究问题与方法

**研究问题**：针对诊断清单的每个问题，同类系统（模块化插件/状态机引擎/Web 面板宿主）采用的架构模式是什么？证据强度如何？在本仓库约束下哪些适用、哪些不适用？

**拆解**：
- 待验证事实：dsh-user-questions rc.7 的 answer 是否有 value 通道（P1-3 前置）；Node engines 是否支持 `AbortSignal.any/timeout`（P1-2② 前置）；P1-2⑥ 的同步写入是否为有意设计（影响修复形态）。
- 待比较选项：缓存修复的三种范围、god class 拆分的深度、执行路径收敛的两种切法、取消原语的两种实现、恢复投影的三种形态、SQLite 写入的三种形态、客户端共享的三种深度。
- 关键术语：cache-aside、facade/协作者拆分、characterization test、seam、SSOT、semver precedence、memory image/projection rebuild、write-behind、value/label 分离、DTO 投影、dependency rule、composition root。
- 时间范围：模式类证据（经典原著/官方规范）无时效敏感；宿主能力（rc.7）与 Node 版本特性以本仓库 `package.json` 锁定的版本为准。
- 决策标准：不破坏公开 API 与 wire 形状；修复后可直接被测试钉住；不引入新运行时依赖。

**方法**：
1. 以诊断文档的实测锚点（文件:行号）为事实基线，本会话对全部引用锚点重新抽查复核（§4，含二轮新增项）。
2. 检索优先级：官方规范/官方文档/经典原著（一手）→ 广泛采用的库文档与真实修复实例（二手）→ 社区讨论（方向性参考）。
3. 冲突检查：对每条模式记录反方证据并给出消解条件（见 §3 各条"边界"）；显著反方为 S14（重复优于错误抽象）与 better-sqlite3 同步设计辩护（§3-N）。
4. 本仓库直接验证前置事实（§4，六项全部结案）。

**证据强度分级**：
- **A** = 一手/权威：官方规范（semver.org、Node.js API 文档、MDN、react.dev）、经典原著（Feathers、Demeyer、Fowler 等）、本仓库内直接验证的代码事实。
- **B** = 高质量二手：广泛采用的库官方文档（execa、better-sqlite3）、知名技术写作、真实项目的同类修复实例。
- **C** = 社区经验：HN/SO 讨论串，仅作方向参考，不单独支撑结论。

## 2. 来源清单（含权威性/时效性检查）

| # | 来源 | 类型 | 权威性与时效性检查 |
|---|---|---|---|
| S1 | [The Clean Architecture — Robert C. Martin (2012)](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html)（另见[实践维护文](https://www.cubic.dev/blog/how-to-maintain-clean-architecture-with-dependency-rules-in-your-codebase)） | 一手（原著博客） | A。依赖规则（The Dependency Rule）的原始出处；2012 年文，概念无时效问题 |
| S2 | [Hexagonal Architecture — Alistair Cockburn](https://alistair.cockburn.us/hexagonal-architecture/) | 一手（原著） | A。ports & adapters 原始出处；2005 年概念，仍为主流 |
| S3 | [Split Up God Class — Object-Oriented Reengineering Patterns ch.9.4 (Demeyer/Ducasse/Nierstrasz)](https://eng.libretexts.org/Bookshelves/Computer_Science/Programming_and_Computation_Fundamentals/Book:_Object-Oriented_Reengineering_Patterns_(Demeyer_Ducasse_and_Nierstrasz)/09%3A_Redistribute_Responsibilities/9.04%3A_Split_Up_God_Class) | 一手（原著，SCG 免费公开） | A。再工程经典；明确给出"增量迁移、保持外观"的步骤，正对本约束 |
| S4 | [Working Effectively with Legacy Code — Michael Feathers](https://www.amazon.com/Working-Effectively-Legacy-Michael-Feathers/dp/0131177052)（[要点摘要](https://github.com/mattpocock/agent-rules-books/blob/main/working-effectively-with-legacy-code/working-effectively-with-legacy-code.md#1)） | 一手（原著）+摘要 | A。seam 与 characterization test 的原始出处；"先织测试网再动结构"正对本约束 |
| S5 | [Node.js child_process 文档（`spawn` 的 `signal` 选项、`subprocess.kill()`）](https://nodejs.org/api/child_process.html)（[abort 行为修复 commit](https://github.com/nodejs/node/commit/313b4743de61c5315481ff850163d262d66ec0e5)） | 一手（官方文档+源码提交） | A。`signal` 选项自 v15.4 起内置"abort 即 kill 子进程"；engines 为 Node ^22/≥24，完全覆盖 |
| S6 | [execa termination 文档](https://github.com/sindresorhus/execa/blob/main/docs/termination.md) | 二手（主流库官方文档） | B。业界事实标准：默认 SIGTERM + 宽限期 + 强杀；可作为本仓库自实现的行为参照 |
| S7 | [MDN AbortSignal.any](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static) / [AbortSignal.timeout](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static) | 一手（标准文档） | A。`any` 自 Node 20.3 可用；`timeout` 自 Node 17.3 可用——engines ^22 满足 |
| S8 | [semver 2.0.0 规范 §11 precedence](https://semver.org/#spec-item-11)（[MDN localeCompare numeric 选项](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/localeCompare)） | 一手（规范+标准文档） | A。规范明确"数字段按数值比较"；`{ numeric: true }` 是平台内置修正 |
| S9 | [Microsoft Cache-Aside pattern](https://learn.microsoft.com/azure/architecture/patterns/cache-aside) | 二手（官方架构模式目录） | B。cache-aside + TTL 是目录级模式；stampede 在单进程 Node 场景不构成主要风险（§3-A 边界） |
| S10 | [await-mutex](https://github.com/mgtitimoli/await-mutex) | 二手 | B。keyed mutex 是成熟模式；纯 promise 链即可实现，无需依赖（§3-H） |
| S11 | [MDN `<option value>` 语义](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/option)（[i18n key 最佳实践](https://simplelocalize.io/blog/posts/best-practices-for-translation-keys/)） | 一手+二手 | A/B。"展示文本≠协议值"在 Web 标准是 30 年先例 |
| S12 | [DTO Mapping Patterns](https://www.stacklesson.com/dotnet-fullstack-tutorial/aspnet-webapi-dtos/ch35-lesson-05-dto-mapping-patterns/)（[domain-driven-hexagon：projection 白名单](https://github.com/afrizahrp/domain-driven-hexagon-ts-oop-api)） | 二手 | B。集中 mapper/投影是跨栈共识；TS 生态无同等权威目录，强度记 B |
| S13 | [eslint-plugin-boundaries](https://github.com/javierbrea/eslint-plugin-boundaries)（[dependency-cruiser](https://github.com/sverweij/dependency-cruiser)） | 二手（工具官方文档） | B。架构边界的机器强制手段；本仓库当前**无 ESLint**（§4），引入成本见 §5 |
| S14 | [Prefer duplication over the wrong abstraction — Sandi Metz (2016)](https://sandimetz.com/blog/2016/1/20/the-wrong-abstraction) | 二手（知名作者） | B。**反方证据**：用于消解"消除重复"与"错误抽象"之争，见 §3-D 边界 |
| S15 | 本仓库内一手验证：`node_modules/@deepseek-ai/dsh-user-questions@0.1.0-rc.7/lib/types/types.d.ts`；`package.json` engines；诊断全部行号锚点 | 一手 | A。解决 P1-3 宿主能力悬案 + 全部事实基线复核 |
| S16 | [Node.js 官方指南：Don't block the event loop (or the worker pool)](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop) | 一手（官方文档） | A。"事件循环上的同步/长任务直接摊薄宿主吞吐"的官方表述；长期维护文档，无时效问题 |
| S17 | [Node.js `node:sqlite` 文档（DatabaseSync）](https://nodejs.org/api/sqlite.html)（[better-sqlite3 README 同步设计辩护](https://github.com/WiseLibs/better-sqlite3)；[@photostructure/sqlite 异步设计分析](https://photostructure.github.io/node-sqlite/documents/internal_async-design.html)） | 一手（官方文档）+二手（**反方**） | A/B。DatabaseSync 即同步 API（事实）；better-sqlite3 明确辩护"SQLite 写通常微秒级，同步反而更简单更快"——反方证据，见 §3-N 消解 |
| S18 | [Martin Fowler：Memory Image](https://martinfowler.com/bliki/MemoryImage.html)（[Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html)） | 一手（权威作者原著） | A/B。"易失工作状态 + 崩溃/恢复后从持久真源重建"的原始表述；本仓库只需其投影重建子集，不需完整 ES（§3-M 边界） |
| S19 | [React 官方文档：Reusing Logic with Custom Hooks](https://react.dev/learn/reusing-logic-with-custom-hooks) | 一手（官方文档） | A。"组件间重复逻辑 → 提取共享"的官方机制；对纯常量情形是类比支撑（常量是更简单的模块级情形） |

## 3. 可复用架构模式清单（按诊断问题映射）

### A. 闭包级 TTL 缓存（cache-aside at composition scope）→ P0-1
- **模式**：缓存条目的生命周期必须挂在"被轮询对象"的作用域上，而非请求处理函数内；读路径 miss→回源→回填，TTL 控制过期窗口。
- **证据**：S9（Microsoft Cache-Aside，B）；事实层：`src/index.ts:184-185` 两个 Map 声明在 handler 体内（§4 复核，A）——bug 是**作用域错误**而非策略错误，注释（`src/index.ts:181-183`）自述的设计意图（30s 缓存）与 S9 模式一致。
- **推断链**：handler 每次请求重建 Map（事实）→ 缓存永远不命中（推断，已被诊断确认）→ 提升到 `registerWebSurface` 闭包即恢复设计意图（结论）。
- **适用条件**：单进程宿主、轮询读远多于写、容忍 ≤TTL 陈旧。全部满足。
- **不适用场景/边界**：①面板"保存 workflow 后立即看图"场景会被 TTL 滞后影响——但写路径走另一条路由（`POST /workflows/<file>`），可在写成功后对该 key 主动失效（cache-aside 的写侧失效是 S9 的标准组成），本轮不必须；②cache stampede（S9）在单进程 + 1.5s 轮询频率下风险极低，不需要请求合并。
- **证据强度**：A（bug 定位）+ B（模式）。

### B. Split Up God Class：增量职责再分配，类退化为 Facade → P0-2
- **模式**（S3，A，原著步骤）：①识别 god class 的职责簇；②把每个职责簇迁为可独立构造/测试的协作者；③god class 保留为外观（facade），原客户端调用不变；④增量执行，每次迁移后可运行。
- **证据**：S3 步骤与本仓库约束（公开方法签名冻结）**逐条同构**——诊断提议的"服务类退化为装配+委托"就是 S3 的终点形态。S3 明确警告两种失败形态：一次性重写（破坏一切）和拆出只持数据的哑类（无测试收益）。
- **推断链**：1887 行/≥8 职责（事实）→ 主机耦合代码零测试（事实，`runner.spec` 全用假执行器）→ 拆出协作者即产生新 seam（推断，S4）→ 每个新 seam 补单测（结论）。
- **适用条件**：拆分必须沿"可独立构造"的缝（诊断列的 run-registry / executor-factory / lifecycle / persistence 均满足：输入输出清晰、可注入假件）。
- **不适用场景/边界**：S3 明确指出若系统即将废弃则不值得拆——不适用本仓库。真正风险是**过度拆分**：把仅被一处的私有助手也独立成文件，反而增加跳转成本；建议以"该协作者是否有独立单测价值"为准绳。
- **证据强度**：A。

### C. 特征化测试先行（Characterization Tests + Seams）→ 横切（P0-2/P0-3/P1-2③ 的测试网缺口）
- **模式**（S4，A）：改动无测试覆盖的代码前，先在 seam 处补"钉住当前行为"的特征化测试；重构 = 不改变行为的结构变换。
- **证据**：S4 原著 + [解耦核心的控制器测试实践](https://matthiasnoback.nl/2021/03/testing-controllers-when-you-have-a-decoupled-core/)（B，展示"核解耦后宿主薄壳才可测"的同型论证）。
- **推断链**：makeExecutor 4 实现/流投影/persist 编排无单测（事实）→ 直接拆分会把无测试代码搬家，风险不可见（推断）→ 顺序应为：先拆协作者（纯结构移动）→ 立即在新 seam 补测 → 再做行为修正（结论）。
- **边界**：特征化测试钉住的是**现状**而非**正确性**——对 P0-3 这类"现状即 bug"的项，测试应钉 runner 路径（正确侧），对 testState 路径应在修正后补测，避免把 bug 固化。
- **证据强度**：A。

### D. 单一执行路径（收敛镜像实现；SSOT 的条件判定）→ P0-3
- **模式**：两条必须保持一致的代码路径，应收敛为一条共享实现 + 两侧薄适配（"独立验证 = 用同一引擎跑单状态"）。
- **证据**：S14（B）是**关键反方**："错误的抽象比重复更贵"——消除重复的前提是确认两侧**已经收敛**。本案例中收敛证据是代码自带的：`service.ts:530-543` 注释自述 "Mirror executeState"，且已确认的 4 处发散全部是**无意漂移**（角色推断、rationale 截断、超时换算），没有一处是有意的差异（事实层，诊断 §P0-3）。满足 Metz 条件 → 提取共享实现正确。
- **推断链**：mirroring 已发散（事实）→ 发散点均为无意（事实）→ 共享抽象不会是"错误抽象"（推断，S14 条件满足）→ 下沉 `executeStateSteps` 到 engine，runner 与 testState 共用（结论）。
- **不适用场景/边界**：若未来"独立验证"需要**故意**偏离真实运行（如注入 fault-injection），共享路径应留 hook 而非复制整段——诊断提议的 `hooks` 参数已覆盖。
- **证据强度**：A（收敛事实）+ B（模式判定）。

### E. 单一解析入口 + 数值化版本比较 → P1-1（v2 按二轮诊断修正语义）
- **模式**：一个引用→配置的解析函数、一个"最新版本"比较器，所有调用点共用；版本比较按 semver §11 数值化逐段比较，或 `localeCompare(b, a, { numeric: true })`。
- **证据**：S8（A，semver 规范 §11：precedence 按数值比较标识符；MDN `numeric: true`）；事实层（§4 复核，A）：`loadBuiltinTemplates` 按 `id,version` 的 `localeCompare` **升序**排序（`catalog/index.ts:75-77`），故 `resolveWorkflowConfig` 的 `templates.find(...)`（`service.ts:1411`）取**首个匹配 = 最旧版本**，而 `runApi`/`commands`/`tools` 三处 `.sort(...).at(-1)` 取**最新版本**——"最新"两种相反口径并存；且全部用 `localeCompare` 排版本，`0.10.0 < 0.9.0` 字典序错误。
- **推断链**：实例→模板→路径三路解析 + "最新/最旧"两种相反口径（事实）→ 当前 8 模板全 1.0.0 故潜伏（事实）→ 首个多版本模板出现即分叉（推断）→ 收敛为 `resolveWorkflowRef` + `latestTemplate`（结论）。
- **边界**：`{ numeric: true }` 只修数字序，不完整实现 semver（prerelease 规则）；本仓库模板版本若承诺只使用 `x.y.z` 数字三段则够用，否则引入 30 行内的严格比较器，不必加 semver 依赖。
- **证据强度**：A。

### F. 子进程取消 = abort 即 kill（SIGTERM 优先，宽限后强杀）→ P1-2①
- **模式**：取消语义必须传导到子进程；裸 reject 留下孤儿进程是泄漏。
- **证据**：S5（A，官方文档：`spawn` 的 `signal` 选项在 abort 时会 kill 子进程——Node 自 v15.4 内置，engines ^22 满足）；S6（B，execa：SIGTERM 默认、`forceKillAfterTimeout` 宽限强杀是业界事实标准）；事实层（§4 复核，A）：`pre-commands.ts:57-60` abort 分支仅 reject，`exec` 的 child 句柄在手但不 kill。
- **推断链**：pre-commands abort 不 kill（事实）→ shell 命令在 stop 后继续写工作区（推断）→ 最小修复：`child.kill()` 于 abort 分支（保留 reject 语义）；更完整方案：spawn/exec 时传 `signal` 让 Node 处理，或 SIGTERM→宽限→SIGKILL（结论）。
- **不适用场景/边界**：Windows 上 `SIGTERM` 对 `cmd /c` 派生的**孙进程**传导不可靠（Node 官方文档注明 `kill` 只作用于直接子进程）——preCommand 以系统 shell 执行，孙进程不在 kill 范围；这是已知残留风险，与 execa 在非 tree-kill 模式下一致，记录即可，不阻塞修复直接子进程。
- **证据强度**：A。

### G. 单 AbortController + 标准组合子（`AbortSignal.any`/`timeout`）→ P1-2②
- **模式**：取消只有一个权威 controller；"超时""外部取消"等附加来源用标准组合子合成，不手工桥接第二个 controller。
- **证据**：S7（A，MDN：`AbortSignal.any([a,b])`、`AbortSignal.timeout(ms)`，Node 20.3+/17.3+ 可用；engines ^22 满足——§4 已验证）；事实层：`service.ts:756-761,921-924` 双 controller 手工桥接且 `linked` 无 dispose 路径（诊断）。
- **推断链**：双 controller 语义需读注释才能理解（事实）→ 手工桥接是泄漏与误解源（推断）→ 收敛为单 controller + `AbortSignal.any` 合成，detach 决策点显式化（结论）。
- **不适用场景/边界**：`AbortSignal.any` 合成的 signal 无法再 `abort()`——若调用方需要"主动取消"能力，必须保留权威 controller 的引用一并传递；`stepSignalWithTimeout` 的导出签名（被 step-timeout.spec 钉住）不可改，只改内部实现。
- **证据强度**：A（标准可用性）+ B（具体重构形态）。

### H. 按键串行化（per-run promise 链）+ 并行组证据快照 → P1-2③④
- **模式**：对同一键（runId）的异步副作用串行化——用"末尾 promise 续接"的 10 行工具即可，无需引入 mutex 依赖；并行组的共享输入改为"进入时快照"获得确定性。
- **证据**：S10（B，keyed mutex 是成熟模式；等价 promise 链实现是社区共识）；快照语义类比数据库 snapshot isolation（方向性类比，C——并行组内各步骤读到一致的"组开始时"视图）。
- **推断链**：并行 runOne 各自 `await persist()` 交错（事实）→ 文件写原子故不损坏，但 audit diff 游标与证据内容时序不确定（事实/推断）→ persist 串行化 + 证据改"segment 开始快照"= 确定性（结论）。
- **不适用场景/边界**：串行化**降低**持久化吞吐——单 run 场景无并发键竞争，开销≈0；跨 run 不串行（不同键），不会成为全局瓶颈。④流缓冲增量封顶会改变 stepLog 中间态文本（无测试钉住，诊断已注明），属预期内行为修正。
- **证据强度**：B（模式成熟）+ A（本仓库风险面已由诊断实测）。

### I. value/label 分离（展示文本永不作协议 token）→ P1-3
- **模式**：协议层匹配稳定标识符，展示层文本可自由改（含 i18n）。
- **证据**：S11（A，`<option value>` 是 Web 30 年先例）；**本仓库一手验证（§4，A）**：`dsh-user-questions@0.1.0-rc.7` 的 `AskUserQuestionOption` **只有 `label`/`description`，没有 value 通道**，answer 返回 `selected: string[]` 且文档自述"Selected option labels"——诊断标记的"唯一需要宿主能力确认的项"**已结案：无 value 通道**。
- **推断链**：无 value 通道（事实，rc.7 类型定义 `types.d.ts:8-13, 49-56`）→ 注入式方案不可行（事实）→ 退路：标签提取为模块级常量（单一定义点）+ 比较逻辑只引用常量 + 注释说明"标签即协议"的宿主约束（结论）；**增量改进**：rc.7 提供 `intent: { kind: 'plan-review', approve: <批准标签> }` 通道，语义恰为"approve/decline"，可把"哪个标签代表批准"声明给宿主而非散落比较——但 `plan-review` 要求提供 `detail`（plan markdown），需 UX 确认展示形态，列为可选项。
- **不适用场景/边界**：不要把中文标签硬编码进比较逻辑的第二处副本（现状即如此）；若宿主未来加 value 通道，常量方案可平移。
- **证据强度**：A（宿主能力结论）；B（plan-review 形态的 UX 适配待验证）。

### J. 集中式 DTO 投影模块（单处 mapper + 客户端手工镜像注释同步）→ P2-1
- **模式**：wire 形状只在一个模块定义；其余消费方调用投影函数；跨包无法共享运行时代码时，用手工镜像 + 字段级"同步来源"注释。
- **证据**：S12（B，集中 mapper/projection 是跨栈共识；domain-driven-hexagon 强调白名单式投影——逐字段列举正是本仓库 wire 冻结约束所需的风格）。
- **推断链**：4+1 处投影已发生字段 drift（事实，`attempts`/`supervisorScore` 有无不一）→ 单处 `projections.ts` + `tools-runjson.spec` 逐字段钉住（结论）。
- **边界**：client 独立打包不能 import host 代码——手工镜像保留，不强行共享；投影函数必须保持"白名单列举"风格，禁止 `...spread` 透传 RunState（否则新增内部字段即泄出 wire）。
- **证据强度**：B。

### K. 依赖规则 + 端口注入（层级倒置修复与宿主能力显式化）→ P2-2 / P2-3
- **模式**：内层（engine/store）不 import 外层（catalog/宿主）；外层资源以构造参数/选项注入（ports & adapters）；宿主能力在 composition root（`apply`）一次性解析为 `HostCapabilities` 注入。
- **证据**：S1（A，Dependency Rule 原始出处：源码依赖只许指向内层）；S2（A，ports & adapters 与 composition root）；事实层：`engine/script-file-runner.ts:14` import `catalog/resourcesRoot` 且 `ARCHITECTURE.md:14` 宣称 engine 宿主无关——宣称与实现矛盾（诊断，A）。
- **推断链**：engine→catalog 的 import 是文档宣称的违反（事实）→ `builtinScriptsDir` 选项注入、默认回退现行为（结论，与诊断一致；保签名故不破测试）；`process.cwd()`/`process.env.DSH_HOME` 回退保留为默认值，但解析点上移到 `apply`（结论）。
- **不适用场景/边界**：**不要**为本仓库规模引入全套 Clean Architecture 分层（entities/usecases/interface-adapters/frameworks 四环）——S1 原文针对大型业务系统；本插件只需修两条倒置边 + 显式化隐式依赖，四环分层是过度工程（推断，基于仓库 src 规模）。
- **证据强度**：A（规则与本仓库矛盾点）+ B（裁量判断）。

### L. 依赖方向的机器强制（防回归护栏）→ 新增建议（诊断未列）
- **模式**：依赖图规则进 CI（dependency-cruiser 的 forbidden 规则，或 eslint-plugin-boundaries 的元素类型规则），把"无循环依赖、engine 不 import catalog"从文档宣称变成可执行检查。
- **证据**：S13（B，两个工具均为该领域事实标准）。
- **推断链**：本次诊断的依赖图是人工实测（事实）→ 重构落地后无人复核即会腐化（推断）→ 最小配置：dependency-cruiser 单条 forbidden 规则 + `pnpm exec` 脚本，**不引入 ESLint**（本仓库当前无 ESLint，§4 验证；为其单独装 ESLint 成本不划算）（结论）。
- **边界**：工具本身要进 devDependencies；若团队决议统一上 ESLint，则优先 eslint-plugin-boundaries（规则与 lint 同生命周期）。
- **证据强度**：B。

### M. 恢复时投影重建（memory-image 式易失投影，从持久真源回填）→ P1-2⑤（v2 新增）
- **模式**：内存中的实时投影（`streams` Map：拓扑/verdicts/stepLog）是持久化 RunState 的**物化视图**；恢复/重启时必须从真源重建投影，而非留空—— Fowler 的 Memory Image 即"工作状态在内存、崩溃后从持久日志/快照重建"的原始表述。
- **证据**：S18（A/B，Fowler：Memory Image / Event Sourcing 的 replay-to-rebuild 语义）；事实层（§4 复核，A）：`streams.set` 全服务唯一出现在 `service.ts:775`（startRun 路径），`resumeRun` 路径（`service.ts:897-951`）不建条目 → 恢复的运行 `/stream` 404、LiveRunPanel 静默；子工作流步骤经 `engineOptions` 复用父 runId 的 stream 键（`service.ts:1707-1716`），streams 无该键时子工作流执行期面板同样静默。
- **推断链**：投影只在 startRun 建（事实）→ resume/子工作流路径观测断点（事实）→ persist 的投影逻辑（RunState→stream 条目）已存在，resume 时调用同一投影函数回填即可（推断）→ 重建必须幂等（重复 resume 不重复 append stepLog）（结论）。
- **不适用场景/边界**：**不要**升级为完整事件溯源框架（事件日志重放、版本化事件 schema）——本仓库已有全量 RunState 快照作真源，一次投影重建即可，ES 是过度工程（S18 的完整形态不适用）；重建出的投影与"从头实时跑出来"的中间态文本可有差异（stepLog 由 persist 回填的是持久化文本，无测试钉住中间态），属可观测性修复的预期差异。
- **证据强度**：B（模式类比）+ A（本仓库缺口实测）。

### N. 热路径同步 I/O 治理：不阻塞事件循环 + 写入移出关键路径（不换驱动）→ P1-2⑥（v2 新增）
- **模式**：单线程事件循环上，热路径（每步 persist、被轮询路由）中的同步 I/O 直接占用宿主；修复方向不是"全改异步"，而是（a）归档写入移出 persist 串行关键路径（微任务/定时批量 flush），（b）被轮询路由的同步 `countRuns` 复用 P0-1 的 TTL 缓存。
- **证据**：S16（A，Node 官方"不要阻塞事件循环"）；S17/node:sqlite 文档（A，DatabaseSync 即同步 API 的事实）；**反方证据（必须消解）**：S17/better-sqlite3（B——SQLite 单写通常微秒级，同步 API 反而更简单更快，是主流选择）+ 本仓库 `sqlite-archive.ts:106-109` 设计注释自述"Writes are synchronous so mirroring never adds latency to the run loop"（有意选择，§4 复核，A）且已调 WAL/busy_timeout/synchronous=NORMAL（`sqlite-archive.ts:124-129`）。**消解**：双方对"单次同步写很快"无争议；问题在于**频率 × 载荷**——persist 每步全量写 `state_json`（证据链随运行增长），轮询路由每 1.5s/4s 对每个工作区同步 `countRuns`。故保留 DatabaseSync（不新增依赖、不换驱动），只改**写入时机**与**读取缓存**。
- **推断链**：同步 API 是有意且可调优的选择（事实+反方）→ 顿挫来自增长载荷与轮询频率（推断）→ 写侧批量 flush（崩溃窗口内丢失的最近归档可由 audit.jsonl `backfill` 重建——归档本就支持 backfill）+ 读侧 TTL 缓存（结论）。
- **不适用场景/边界**：①若量化显示 persist 载荷恒小（短脚本流水线），现状可接受——本项实施前应测量 state_json 大小 × persist 频率（§7-G6）；②**不要**换异步 SQLite 驱动或上 worker_threads——归档是 opt-in 特性，线程边界序列化成本与新依赖不抵收益（破"不新增运行时依赖"决策标准）。
- **证据强度**：A（事件循环事实）+ B（取舍判断，含反方消解）。

### O. 客户端共享 run-meta 模块（常量/路由助手/verdict 折叠单一定义点）→ P2-4（v2 新增）
- **模式**：跨组件重复的常量与展示逻辑提取为共享模块；裸 fetch 收口为 api client 助手；与 dsl 同语义的 verdict 折叠直接复用 `dsl/verdict.ts`（dsl 已在 client bundle 内，`client/workflow-model.ts` 现成先例）。
- **证据**：S19（A，React 官方"组件间重复逻辑→提取共享"机制；纯常量是更简单的模块级情形）；事实层（§4 复核，A，grep 行号）：`ACTIVE_STATUSES` 重复 3 处 + 改名第 4 处（`run-selection.ts:7`、`AcePanel.tsx:22`、`LiveRunPanel.tsx:48`、`Workbench.tsx:52` 作 `ACTIVE_RUN_STATUSES`——drift 已发生）；`STATUS_TEXT` 2 处（`LiveRunPanel.tsx:38`、`Workbench.tsx:28`）；步骤类型文案 3 处措辞不一（`LiveRunPanel.tsx:50` `STEP_KIND_TEXT`、`Workbench.tsx:45` `STEP_TEXT`、WorkflowEditor.tsx:53` `STEP_TYPE_TEXT`，"子工作流"/"子流"混用）；`STATE_ROUTE` 写死 3 处（`AcePanel.tsx:20`、`Workbench.tsx:25`、`workflow-trigger.ts:10`）。
- **推断链**：4 组常量已现 drift（事实）→ 提取 `client/run-meta.ts` 单一定义点 + `route(path)` 助手 + verdict 折叠复用 dsl/verdict（结论）；`run-selection.spec.ts` 只 import 具名符号，保留 re-export 即不破。
- **不适用场景/边界**：①**不要**为此引入状态管理库（Zustand/Redux）——轮询 + 局部 state 够用，新依赖破决策标准；②三个 React Flow 节点渲染器的合并不在本轮（诊断 P3 已裁决 client 大组件"host 侧 DTO 稳定后再拆"），本轮只共享 verdictMeta/徽标子组件与常量；③dsl 代码进 client bundle 的边界由 `tests/client-bundle.client.spec.ts` 看门——复用 `dsl/verdict` 安全，但不得借道引入任何 node 内建。
- **证据强度**：A（drift 事实）+ B（React 官方文档对常量场景为类比支撑）。

## 4. 本仓库直接验证的前置事实（v2 全部重新复核）

| 悬案/锚点 | 结论 | 证据 |
|---|---|---|
| P1-3 依赖：dsh-user-questions rc.7 有无 value 通道 | **无**。`AskUserQuestionOption = { label, description? }`；answer 为 `selected: string[]`（labels）；另有 `intent: plan-review` 带 `approve` 标签通道 | `node_modules/@deepseek-ai/dsh-user-questions/lib/types/types.d.ts:8-13, 49-56`（A，一手，本会话复核） |
| P1-2② 依赖：`AbortSignal.any/timeout` 可用性 | **可用**。engines `^22.0.0 \|\| >=24.0.0`；标准自 Node 20.3/17.3 起 | `package.json:41-43` + MDN/Node 文档（A，本会话复核） |
| P0-1 事实复核 | 属实。`topologyCache`/`taskFieldsCache` 声明于 handler 体内；30s TTL；注释自述设计意图 | `src/index.ts:184-185`（声明）、`:181-183`（注释）、`:189,220`（TTL）（A，本会话复核） |
| P1-1 二轮修正语义复核 | 属实。`resolveWorkflowConfig` 用 `find`（`service.ts:1411`）取升序首个=**最旧**；目录排序为 `localeCompare` 升序（`catalog/index.ts:75-77`） | 同上（A，本会话复核） |
| P1-2① 事实复核 | 属实。abort 分支仅 `rejectPromise`，`exec` child 在手不 kill | `src/engine/pre-commands.ts:43-60`（A，本会话复核） |
| P1-2⑤ 事实复核 | 属实。`streams.set` 唯一出现在 `service.ts:775`（startRun）；resumeRun 路径（897-951）不建条目 | `src/service.ts` grep 全量 9 处 streams 引用（A，本会话复核） |
| P1-2⑥ 事实复核 | 属实且为**有意设计**。`DatabaseSync`（`sqlite-archive.ts:12,123`）；注释自述同步理由（`:106-109`）；已调 WAL/busy_timeout/synchronous=NORMAL（`:124-129`） | 同上（A，本会话复核） |
| P2-4 drift 复核 | 属实。ACTIVE_STATUSES×3+改名×1、STATUS_TEXT×2、步骤文案×3、STATE_ROUTE×3 | grep 行号见 §3-O（A，本会话复核） |
| 边界强制的现有工具链 | 无 ESLint；测试为 vitest；运行时依赖仅 yaml+zod | `package.json` dependencies/devDependencies（A，本会话复核） |

## 5. 选项比较表（收益/成本/风险/依赖/成熟度/推荐）

### 决策点 1：P0-1 缓存修复形态
| 选项 | 收益 | 成本 | 风险 | 依赖 | 成熟度 | 推荐 |
|---|---|---|---|---|---|---|
| ①提升缓存到闭包（诊断方案） | 立即消除重复 parse；响应体不变 | 极低（移动 2 行声明） | 拓扑滞后 ≤30s（原设计意图） | 无 | 高（S9 标准模式） | **推荐** |
| ②①+写路径主动失效 | 编辑后立即刷新 | 低 | 失效键漏算 | 需在写路由加钩子 | 高 | 第二阶段顺带做 |
| ③改 WebSocket/SSE 推送 | 彻底去轮询 | 高（协议+client 重写） | wire 协议变化，破约束 | 宿主 webServer 推送能力 | 中 | 不推荐本轮 |

### 决策点 2：P0-2 拆分深度
| 选项 | 收益 | 成本 | 风险 | 依赖 | 成熟度 | 推荐 |
|---|---|---|---|---|---|---|
| ①拆 4 协作者+Facade（诊断方案） | 主机耦合代码获得测试 seam | 中（纯结构移动） | 导出符号误移破 API | 无 | 高（S3 原著步骤同构） | **推荐** |
| ②①+新 seam 特征化测试 | 拆完即有测试网 | 中 | 测试钉住 bug 的风险（§3-C 边界） | vitest 宿主复核 | 高（S4） | **推荐**，与①同 PR 或紧随 |
| ③按四环 Clean Architecture 重分层 | 理论纯度 | 高 | 过度工程、API 震荡 | 无 | 中 | 不推荐（§3-K 边界） |

### 决策点 3：P0-3 执行路径收敛切法
| 选项 | 收益 | 成本 | 风险 | 依赖 | 成熟度 | 推荐 |
|---|---|---|---|---|---|---|
| ①下沉 `executeStateSteps` 到 engine（诊断方案） | 预测=真实运行；4 处发散根除 | 中 | testState 输出变化（预期内，需 PR 声明） | 无 | 高 | **推荐** |
| ②service 内逐点对齐 runner | 成本最低 | 低 | mirroring 关系保留，必然再次漂移 | 无 | 低 | 不推荐（S14 反例已消解） |

### 决策点 4：P1-2 取消原语实现
| 选项 | 收益 | 成本 | 风险 | 依赖 | 成熟度 | 推荐 |
|---|---|---|---|---|---|---|
| ①abort 分支 `child.kill()`（最小修复） | 堵泄漏 | 极低 | Windows 孙进程残留（已知边界） | 无 | 高（S5/S6） | **推荐** |
| ②spawn/exec 传 `signal` 由 Node 处理 | 语义官方托管 | 低（需改调用形态） | 同上 | Node ≥15.4（满足） | 高（S5） | 推荐，可与①合并 |
| ③`AbortSignal.any` 收敛双 controller | 去手工桥接、去泄漏 | 低 | 合成 signal 不可再主动 abort | Node ≥20.3（满足） | 高（S7） | **推荐**，导出签名不变 |

### 决策点 5：P1-3 人工门协议（宿主能力已结案：无 value 通道）
| 选项 | 收益 | 成本 | 风险 | 依赖 | 成熟度 | 推荐 |
|---|---|---|---|---|---|---|
| ①标签提为模块级常量+注释（退路转正） | 比较逻辑单点定义 | 极低 | 仍是字符串协议（宿主所限） | 无 | 高 | **推荐** |
| ②①+`intent: plan-review` 声明批准标签 | 语义显式化、UI 可特化展示 | 低-中 | `detail` 必填改变提问形态，UX 待验 | rc.7 已有该类型 | 中 | 可选增量，单独 PR |
| ③等待宿主加 value 通道 | 彻底解耦 | 0（等待） | 无时间表 | 宿主路线图 | 未知 | 不阻塞 |

### 决策点 6：P1-2⑤ 恢复运行的流投影（v2 新增）
| 选项 | 收益 | 成本 | 风险 | 依赖 | 成熟度 | 推荐 |
|---|---|---|---|---|---|---|
| ①resume 时从持久化 RunState + workflow config 重建 stream 条目（复用 persist 投影逻辑） | 恢复运行重获实时流；子工作流可观测 | 低-中 | 重建中间态文本与实时跑有差异（无测试钉住） | 无 | 高（S18 模式同构） | **推荐** |
| ②`/stream` 对无条目运行返回"已恢复无流"标记 | 成本最低 | 低 | 面板仍无实时输出，观测断点保留 | wire 增字段（兼容式新增） | 中 | 不推荐单独做；可作①的兜底 |
| ③完整事件溯源/重放框架 | 理论完备 | 高 | 过度工程、事件 schema 版本化负担 | 新依赖 | 低 | 不推荐（§3-M 边界） |

### 决策点 7：P1-2⑥ SQLite 同步 I/O（v2 新增）
| 选项 | 收益 | 成本 | 风险 | 依赖 | 成熟度 | 推荐 |
|---|---|---|---|---|---|---|
| ①保留 DatabaseSync；归档写移出 persist 关键路径（微任务/批量 flush）+ `countRuns` 走 P0-1 TTL 缓存 | 顿挫消除且不换驱动 | 低-中 | 批量 flush 崩溃窗口丢最近归档（state.json 是真源，可 backfill 重建） | 无 | 中-高 | **推荐**（G6 量化后实施） |
| ②换异步驱动 / worker_threads | 事件循环完全无同步 I/O | 高 | 新依赖、线程序列化成本；破"不新增运行时依赖" | 新运行时依赖 | 中 | 不推荐本轮（§3-N 边界） |
| ③维持现状 | 0 | 0 | 顿挫随运行时长/历史线性增长 | 无 | 现状 | 仅当 G6 量化证明载荷恒小 |

### 决策点 8：P2-4 客户端 run-meta 提取（v2 新增）
| 选项 | 收益 | 成本 | 风险 | 依赖 | 成熟度 | 推荐 |
|---|---|---|---|---|---|---|
| ①提取 `client/run-meta.ts`（常量+`route()` 助手+verdict 折叠复用 dsl/verdict） | drift 根除、改文案单点 | 低 | re-export 缺失破 `run-selection.spec` import 路径 | 无 | 高 | **推荐** |
| ②①+共享节点徽标子组件 | 三处渲染器配色/徽标一致 | 中 | CSS 类名变动 → 视觉回归风险 | 无 | 中 | 第二阶段（P3 已裁决大组件后拆） |
| ③引入状态管理库 | 统一数据流 | 高 | 新依赖、面板重写 | 新依赖 | 低 | 不推荐（§3-O 边界） |

## 6. 不适用场景总表（模式→本仓库的例外）

1. **四环 Clean Architecture 全量落地**——仓库规模与插件形态不匹配；只修两条倒置边（§3-K）。
2. **SWR/请求合并/分布式缓存**——单进程宿主 + 1.5s 轮询，stampede 与多实例一致性问题不存在（§3-A）。
3. **WebSocket 推送替代轮询**——破 wire 冻结约束，收益不抵成本（决策点 1③）。
4. **引入 mutex/semver/缓存库依赖**——promise 链、30 行数值比较器、2 个 Map 各自够用；决策标准要求不新增运行时依赖（`package.json` 现仅 yaml+zod，§4）。
5. **为边界强制引入 ESLint**——仓库无 ESLint 现状；优先 dependency-cruiser 单规则（§3-L）。
6. **"复制优于错误抽象"**——S14 的前提（收敛未证实）在本案例不成立：发散全部无意，提取条件满足（§3-D）。
7. **特征化测试钉住 testState 现状**——现状即 bug（P0-3），应先修正后补测，避免固化 bug（§3-C）。
8. **完整事件溯源/重放框架**——resume 只需一次投影重建，RunState 快照已是真源（§3-M）。
9. **异步 SQLite 驱动 / worker_threads**——同步写有 better-sqlite3 式辩护且为本仓库有意选择；改写入时机与读缓存即可（§3-N）。
10. **客户端状态管理库**——轮询 + 共享常量模块足够（§3-O）。
11. **本轮合并三个 React Flow 节点渲染器 / 拆 client 大组件**——诊断 P3 已裁决"host 侧 DTO 稳定后再拆"（§3-O 边界）。

## 7. 未解决问题、信息缺口与下一步验证计划

| # | 缺口 | 影响 | 下一步验证动作 | 责任环境 |
|---|---|---|---|---|
| G1 | vitest 无法在本沙箱运行（node 禁派生孙进程） | 全部重构项的回归验证 | `pnpm typecheck && pnpm test`，重点 runner.spec / tools-runjson.spec / step-timeout.spec / stale-run.spec / client-bundle | 宿主 |
| G2 | runner.spec 并行组用例是否断言证据文本 | P1-2③ 快照语义的破坏面大小 | 宿主跑测试 + 读 runner.spec 并行组断言 | 宿主 |
| G3 | `plan-review` intent 的 `detail` 形态与人工门 UX 适配 | 决策点 5② 可行性 | 读 dsh-user-questions 实现/宿主 UI 渲染，小范围 spike | 宿主 |
| G4 | Windows 下 preCommand 孙进程 kill 的传导率 | P1-2① 残留风险量化 | 宿主实测：preCommand spawn 孙进程后 stopRun | 宿主（Windows） |
| G5 | dependency-cruiser 引入决议（新增 devDep） | §3-L 落地 | PR 评审时决议 | 团队 |
| G6 | persist 的 `state_json` 大小 × 频率量化 | 决策点 7 选①还是③的输入 | 宿主跑一次长运行，测量归档写耗时与载荷增长 | 宿主 |
| G7 | resume 重建投影的语义需测试钉住 | 决策点 6① 回归网 | 补测：resume 后 `/stream` 200、拓扑/verdicts/stepLog 由持久化回填、幂等 | 宿主 |

## 8. 结论摘要

15 个模式（A–O）覆盖二轮诊断全部 P0–P2 项（含二轮新增的 P1-2⑤⑥ 与 P2-4）；每项均有一手证据（官方规范/文档/经典原著/本仓库直接验证）支撑，显著反方证据（S14 的"错误抽象"、better-sqlite3 的同步辩护）已逐条消解或转化为适用边界。两个宿主能力悬案已在仓库内一手结案（user-questions 无 value 通道；AbortSignal 组合子可用），P1-2⑥ 的"同步是否为有意设计"亦已结案（是有意选择 → 保驱动改时机）。所有推荐方案均满足"测试通过、公开 API 不变"约束；行为修正类差异（testState 输出、并行组证据、拓扑 30s 滞后、resume 投影中间态、批量 flush 崩溃窗口）已标注为预期内并需 PR 声明。残余验证集中在宿主环境：跑测试（G1/G2）、载荷量化（G6）、resume 投影补测（G7）。

---

*推断链说明：本文"事实"均为代码锚点或规范条文；"推断"为从事实到模式适用性的推理；"结论"为可执行的形态选择。证据强度标注于每条模式末尾。v2 的全部仓库锚点经本会话逐条复核（§4），与二轮诊断（2026-10）一致。*
