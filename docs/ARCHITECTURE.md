# dsh-ace-harness 架构

把 ACEHarness 的状态机工作流核心移植为 DeepSeek Harness（DSH）外部插件的实现说明。目标平台：DSH `0.1.0-rc.7`（见 [compatibility.json](../compatibility.json)）。

## 总体结构

```
src/
  index.ts              插件入口：函数插件（name/inject/Config/apply），挂载服务、命令、工具、systemPrompt 段与 Web 路由
  service.ts            AceHarnessService：目录、模板实例化、运行生命周期、jobs 接入、StepExecutor（ctx.subagents 实现）
  commands.ts           /workflow 斜杠命令族
  tools.ts              workflow_list / run_workflow / workflow_manage 模型工具（defineTool）
  dsl/                  ACE 兼容 DSL：类型、Zod schema、YAML 加载校验、JSON Pointer、verdict 提取
  engine/               状态机运行器（纯 TS，宿主无关）：
                          runner.ts（主循环/恢复/人工决策）、transitions.ts（条件/转移/聚合/熔断）、
                          prompts.ts（角色提示与上下文预算）、pre-commands.ts（预命令）
  templates/            模板实例化（manifest 参数绑定 + agent 替换）
  store/                文件持久化：run-store / workflow-store / experience / git-baseline / paths
  catalog/              内置资源（agents + workflow 模板，双布局路径解析）
  client/               Web 面板与可视化编辑器（dsh.client，tsdown 打包）
resources/              内置 11 个 agent YAML + 3 个 workflow 模板包
```

## 关键设计

### 状态机运行器（engine/runner.ts）

- 宿主无关：`EngineRunOptions` 注入 `StepExecutor`/`persist`/`load`/`resolveSubworkflow`/`askHumanTransition`，单测用假执行器覆盖
- 每个状态按 segment 执行（`parallelGroup` 并发），**最后一个 segment 的 verdict 决定状态结论**；`conditional_pass` 无匹配规则时自转移；无匹配进入人工决策
- 每步后持久化 `pendingState`，恢复时跳过已完成步骤；`pendingHuman` 把人工决策点持久化，恢复从决策点继续
- 熔断：`maxTransitions`（运行级）+ `maxSelfTransitions`（状态级）
- 子工作流：独立 runId（`<parentRunId>.<step>`）、嵌套深度上限、结果按 `result` 映射回 verdict

### 对抗评审

- 状态 `reviewPolicy.mode: adversarial` 或步骤显式 `role` 决定 defender/attacker/judge 分工；无显式 role 时按位置推断（最后一步 judge，其余交替）
- attacker/judge 只读本状态前置步骤证据；上下文预算：结论 ≤2000、单步摘要 ≤8000、状态证据 ≤32000 字符
- judge 步骤用结构化输出 schema（provider 支持时），文本路径回退 `<workflow-verdict>`/JSON 提取（dsl/verdict.ts）

### 执行后端（service.ts StepExecutor）

- 每步 = `ctx.subagents.start(provider, request)` 一次性子代理；`persona` 语义通过把 ACE 角色 systemPrompt 前置进 user prompt 实现（部署 persona 模板是插值语义，不适合长角色文案）
- `allowedTools` 经 ACE→DSH 映射（Bash→bash、Read→read、Write→write、Edit→edit、Glob/Grep→glob）转 `toolFilter.allow`
- `preCommands` 在项目目录以系统 shell 串行执行，输出限流注入上下文，非零退出/超时不中断
- supervisor 检查点：结构化评分（1–10）+ 建议；经验写入工作区 `experience.jsonl`，最近 5 条回灌后续检查点

### 运行生命周期

- `startRun`/`resumeRun` 的 `mode: foreground | job`；job 模式经 `ctx.jobs` 注册 `ace-workflow` job（owner=发起 Agent，job kill 等价 stopRun）
- 恢复授权：`RunState.parentSessionId` 必须匹配当前会话
- 持久化：`<workspace>/.ace-workflows/runs/<runId>/state.json`（原子写）+ `audit.jsonl`

### Web 面板与编辑器

- 客户端半区（`src/client/`）经 `dsh.client` 挂载；数据走宿主路由：
  - `GET /plugins/dsh-ace-harness/state`（目录/模板/运行快照）
  - `GET|POST /plugins/dsh-ace-harness/workflows/<file>`（YAML 读写；工作区白名单 + 文件名白名单）
  - `POST /plugins/dsh-ace-harness/instantiate`（模板实例化）
- 运行入口：面板把 `/workflow run ...` 命令经 `conversation.sendSession` 提交进当前会话（复用命令/工具链路的全部能力）
- 编辑器：React Flow 画布（@xyflow/react 内联打包），配置 ↔ 图模型纯函数（`workflow-model.ts`），保存时宿主用同一套 DSL 校验

## 宿主集成要点（rc.7）

- `dsh.bundle.patch` → `cordis.patch.yml` 单条 insert；`dsh.client { platform: 'web' }` + `exports["./client"]`
- Service 在 `apply` 内直接 `new`（`ctx.plugin` 的 fiber 激活是延迟的，构造时 `ctx.get` 取不到）
- 打包资源路径：lib/ 与 src/ 两种布局都探测（`resourcesRoot()`）
- 工具 schema 用 `defineTool` 的 JSON 值 DSL；插件 Config 用 schemastery `z`
- Web 路由经 `ctx.get('webServer'|'httpServer')` 懒注册（`internal/service` 事件补偿晚绑定），headless profile 无 web 面也能启动
