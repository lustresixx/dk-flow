# dsh-ace-harness

把 ACEHarness 的工作流核心移植成 DeepSeek Harness 插件：**可视化编排的状态机工作流** + **AI/脚本双节点** + **成功/失败二元流转（由 AI 判断）** + **对抗式多 Agent 评审**。

- 全屏「工作流工作台」后台页面：模板 / 工作流 / 运行记录三栏，React Flow 画布拖拽节点与连线
- **实时运行侧边栏**：工作流运行时自动在右侧弹出——状态机迷你流转图（完成状态按成功/失败着色、当前状态脉冲高亮）+ 当前步骤角色 + **子代理输出流式滚动**（`GET /plugins/dsh-ace-harness/stream` 实时投影）
- 节点四种类型：**AI 步骤**（专属角色 Agent）、**快速 LLM**（单轮直调，无子代理）、**脚本步骤**（node:vm 执行 JS）、**子工作流**
- 流转只分**成功 / 失败**，由 AI 依据实际产出判断；保留旧 pass/conditional_pass YAML 兼容
- 内置 13 个角色 Agent（supervisor / defender / attacker / judge 四队）+ 7 个模板（通用红蓝评审、缺陷定位修复、软件交付、简单脚本流水线、**代码优化评审**、**混合流水线（脚本⇄AI）**、**快速 LLM 问答**）
- **按风险自适应监督**：`supervisor.checkpointPolicy: risks`（默认）只在失败/标记/人工门状态跑检查点，成功直行跳过额外调用；`all` 恢复逐状态检查
- `/workflow` 斜杠命令 + `workflow_list` / `run_workflow` / `workflow_manage` 模型工具
- 治理：运行持久化、断点恢复、人工决策点、supervisor 评分与经验沉淀、Git baseline、后台 job
- ACEHarness 官方 logo 装饰界面

## 明天早上直接看效果（两个入口）

### 入口 A：演示实例（已启动，无需凭据即可体验脚本工作流）

浏览器打开 **http://127.0.0.1:4090**：

1. 右下角「工作流」按钮 → 进入全屏工作台
2. 「运行记录」页已有 4 条跑通的历史（成功路径 + 失败路径，含每步输出）
3. 「模板」页选「简单脚本流水线」→ 填输入文本 → 「直接运行」（脚本节点不需要模型凭据）
4. 「工作流」页选 `simple-script-pipeline` → 「编排」→ 拖节点、拖线连转移（默认成功边，可在右边改成失败）→ 保存
5. 想跑 AI 步骤（红蓝评审等）需要 DeepSeek 凭据：见下方「安装到自己的 GUI」

演示实例是隔离 profile（`ace-test`），不动你正在用的 :3080。

### 入口 B：装进自己的 web profile（有凭据，可跑 AI 工作流）

```sh
# 1) 挂载插件（不重启、不影响当前运行）
dsh plugin --profile web add <插件仓库路径>
# Windows 本地路径注意：pnpm 的 link: 盘符路径可能生成损坏 junction；
# 可用手动 junction 代替（PowerShell）：
#   New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-ace-harness" -Target "<仓库绝对路径>"
#   并把 "dsh-ace-harness" 加进 "$env:USERPROFILE\.dsh\profiles\web\package.json" 的 dsh.profile.bundles

# 2) 验证合成
dsh --profile web --dump-config
# 预期出现: - id: ace-harness / name: dsh-ace-harness

# 3) 重启你的 dsh web（会短暂中断当前会话）并刷新页面
```

之后在对话里说：`用 workflow 跑通用红蓝评审，评审对象是 X`，或点右下角「工作流」进工作台点「运行」。

## 功能速览

### 工作流工作台（后台页面）

- **模板页**：7 个内置模板（结构预览 + 参数表单），可「直接运行」或「创建并编排」
- **工作流页**：项目/个人实例列表，运行 / 编排 / 删除
- **运行记录页**：状态时间线、每步输出与 verdict、supervisor 评分、恢复 / 停止
- **编辑器**：拖动状态节点布局；从节点右缘拖线到另一节点创建转移（默认「成功」，可在右侧检查器改成「失败」或「无条件」）；点节点编辑状态属性与步骤（AI / 快速 LLM / 脚本 / 子工作流）；保存即校验

### 节点类型

| 类型 | 说明 |
|---|---|
| AI 步骤 | 选择角色 Agent（defender/attacker/judge 或 13 个内置角色），启动 DSH 子代理执行任务，可按 Agent 配置挂载工具；judge 步骤结构化输出 verdict |
| 快速 LLM | 一次直接的单轮模型调用（不启动子代理、不带工具），适合快速判断 / 分类 / 摘要；`agent` 可选（填写则复用其角色设定作为 system prompt），`model` 可选（缺省用调用方默认模型） |
| 脚本步骤 | 内联 JavaScript（node:vm 沙箱、10s 超时、`"use strict"`、只读冻结的 `context`），或 `scriptFile` 导入脚本文件（`.js/.mjs/.cjs` 进同一沙箱，`.py` 用 Python 子进程运行，默认 30s 超时）；可用 `context.requirements` / `context.inputs` / `context.priorStateEvidence` / `context.priorStepEvidence` / `context.stepData`（上游结构化数据，按 `状态/步骤` 键取值）；**必须返回 `{ output: "...", success: true/false }`**（或 `{ error }` 表示失败），可附带 `data`（任意 JSON，≤64KB）传给下游脚本与 AI 提示词；违反契约直接判 fail 并给出诊断 |
| 子工作流 | 引用另一个工作流配置（文件名/模板 id），独立 runId，结果映射回 verdict |

### 成功/失败流转

状态转移条件为 `{ verdict: success }` 或 `{ verdict: fail }`，由最后一个步骤的结论（AI 判断或脚本返回值）驱动；无匹配时进入人工决策。旧版 ACE 的 `pass` / `conditional_pass` YAML 仍可加载运行。

### 平台能力：重试 / 超时 / 脚本导入

```yaml
workflow:
  stepRetry: { maxRetries: 2, backoffMs: 2000 }   # 工作流级默认重试
  states:
    - name: 分析
      steps:
        - name: AI 分析
          agent: researcher
          task: 分析输入
          timeoutMinutes: 10        # 步骤级超时，覆盖插件全局 stepTimeoutMs
          retry: { maxRetries: 3, backoffMs: 1000 }   # 步骤级覆盖
        - name: Python 预处理
          type: script
          scriptFile: scripts/analyze.py    # 与内联 script 二选一
```

- **自动重试**：agent / 快速 LLM / 子工作流步骤执行抛错（模型调用失败、超时、子流崩溃）时按指数退避重试（`maxRetries` 为额外尝试次数，0 禁用）；**正常的 fail 裁决是流转信号，不会重试**；脚本步骤结果确定，也不重试。运行记录会显示「重试 N 次」
- **步骤级超时**：`timeoutMinutes` 覆盖插件全局 `stepTimeoutMs`（AI/LLM）与脚本默认超时（JS 10s / Python 30s），适合 Python 等慢步骤
- **导入脚本**：`scriptFile` 为工作区相对路径，与内联 `script` 二选一；`.js/.mjs/.cjs` 读入 node:vm 沙箱，`.py` 以 `pythonCommand`（插件配置，默认 `python`）启动子进程——`context` 以 JSON 经 stdin 传入，脚本最后向 stdout 输出一行 JSON `{"output", "success", "data"}`；非零退出、无法解析、超时均判 fail。脚本文件与 `preCommands` 同信任等级，请只运行可信来源的脚本

## 代码优化评审工作流（七角色接力）

内置模板 `code-optimization-review`：一个完整、可复用的「提出方案 → 资料调研 → 对抗挑战 → 敲定需求 → 代码优化 → 测试验证 → 最终评审 → 交付汇总」闭环，全程由 AI 判断成功/失败：

| 状态 | 角色 Agent | 职责 | 失败去向 |
|---|---|---|---|
| 提出方案 | architect（defender） | 分析现状，形成可执行优化方案与验收标准 | 自循环重做 |
| 资料调研 | researcher（defender） | 检索最佳实践/类似方案，标注来源与证据强度 | 自循环补充 |
| 对抗挑战 | solution-breaker（attacker） | 攻击方案与调研，输出风险与反例清单 | 回到提出方案 |
| 敲定需求 | product-manager（defender） | 综合三方产出敲定需求清单、范围与验收标准 | 回到提出方案 |
| 代码优化 | developer（defender） | 按需求实施优化，记录前后对比证据 | 自循环重做 |
| 测试验证 | tester（defender） | 逐条验收 + 回归 + 边界，产出测试证据 | 回到代码优化 |
| 最终评审 | code-judge（judge） | 对照需求与证据终审（可交付 / 回修） | 回到代码优化 |
| 交付汇总 | documentation-writer（defender） | 汇总需求、实现、验证证据与残余风险 | （终止） |

另有 supervisor 在每个阶段后做检查点评分与经验沉淀。

**复用到你自己的项目**：填两个参数即可 —— `projectRoot`（项目绝对路径）+ `requirements`（优化目标与验收期望）。工作台「模板」页选「代码优化评审」填参运行；或对话中说：

```
用 workflow 跑 code-optimization-review，项目目录 E:\你的项目，优化目标是 ...
```

**Demo 题目**：已预置实例 `code-optimization-demo`（工作台「工作流」页可见）——「**优化工作流引擎性能**」：优化 dsh-ace-harness 自身状态机引擎（`src/engine/`、`src/store/` 热点），约束保持 86 个单测全绿，验收给出优化前后对比证据。在带凭据的 GUI 里运行：

```text
/workflow run code-optimization-demo --wait
```

（运行后可在工作台「运行记录」查看 8 个状态的完整时间线与每步产出。）

## 工作流 DSL（workflow.yaml）

```yaml
workflow:
  name: 简单脚本流水线
  mode: state-machine
  maxTransitions: 10
  states:
    - name: 输入检查
      isInitial: true
      steps:
        - name: 检查输入
          type: script
          script: |
            if (!context.requirements) return { output: '输入为空', success: false }
            return { output: '输入检查通过：' + context.requirements, success: true }
      transitions:
        - { to: 转换, condition: { verdict: success }, priority: 10, label: 成功 }
        - { to: 失败, condition: { verdict: fail }, priority: 20, label: 失败 }
    # ... AI 步骤示例：
    # - name: 方案裁决
    #   agent: design-judge
    #   role: judge
    #   task: 判断方案是否成立，给出 verdict
context:
  requirements: ""
```

## API（示例）

```sh
# 列出模板 / 工作流 / 运行（GET）
curl http://127.0.0.1:4090/plugins/dsh-ace-harness/state

# 读取/保存工作流 YAML（GET/POST，工作区白名单 + 文件名白名单）
curl "http://127.0.0.1:4090/plugins/dsh-ace-harness/workflows/simple-script-pipeline.yaml?workspace=E:%5CCode%5CtypeScript%5Cdeepseek-harness"

# 模板实例化（POST JSON）
curl -X POST http://127.0.0.1:4090/plugins/dsh-ace-harness/instantiate \
  -H "content-type: application/json" \
  -d '{"templateId":"simple-script-pipeline","values":{"requirements":"hi"}}'

# 运行工作流并等待终态（POST JSON；脚本工作流无需凭据，AI 步骤请用聊天命令）
curl -X POST http://127.0.0.1:4090/plugins/dsh-ace-harness/run \
  -H "content-type: application/json" \
  -d '{"workspace":"E:\\Code\\typeScript\\deepseek-harness","workflow":"simple-script-pipeline","values":{"requirements":"hello api test"}}'

# 实时流式投影（GET，含状态机流转图数据、当前步骤与子代理输出文本）
curl "http://127.0.0.1:4090/plugins/dsh-ace-harness/stream?runId=<runId>"
```

响应示例：`{"runId":"run-...","status":"completed","verdict":"success","states":[{"state":"输入检查","verdict":"success","steps":[{"step":"检查输入","type":"script","verdict":"success","outputSummary":"输入检查通过：hello api test"}]},...]}`

## 存储布局

- workflow 实例：`<workspace>/.dsh/workflows/*.yaml`（项目）与 `$DSH_HOME/workflows/*.yaml`（个人）
- 运行数据：`<workspace>/.ace-workflows/runs/<runId>/`（`state.json` + `audit.jsonl` + `git-baseline.json`）
- 经验沉淀：`<workspace>/.ace-workflows/experience.jsonl`

## 配置（cordis.patch.yml 行内 config）

```yaml
- insert:
    - id: ace-harness
      name: dsh-ace-harness
      config:
        subagentProvider: spawn      # AI 步骤执行 provider（spawn | fork）
        model: ''                    # 可选：所有 AI 步骤强制使用的模型
        runDirName: .ace-workflows
        maxSubworkflowDepth: 8
        maxConcurrentRuns: 4
        preCommandTimeoutMs: 300000
```

## 开发

```sh
pnpm install
pnpm build        # 服务端 + 客户端双面构建
pnpm typecheck
pnpm test         # 86 个单测
```

隔离验证：`dsh plugin --profile ace-test add .` → `dsh --profile ace-test --port 4090`。架构说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 已知限制

- **AI 步骤需要 DeepSeek 凭据**（`DEEPSEEK_API_KEY` 或 web Models 页写入的凭据）；凭据缺失时运行以清晰错误失败并持久化 failed 状态
- 脚本步骤是工作流配置代码，与 `preCommands` 同信任等级，请只运行可信来源的配置；`vm` 超时为尽力而为，同步死循环无法被中断
- 后台运行以 DSH job 承载（进程内注册表）；跨进程重启后 job 记录消失，但运行状态已持久化，可 `/workflow resume` 继续
- API 的 `/run` 路由用合成父会话：脚本工作流可完整运行，AI 步骤需要真实会话（请用聊天命令或工具）
- 编辑器暂不覆盖：`custom` 条件表达式、`constraints`/`skills` 等步骤级细节（可直接改 YAML）

## 许可证与署名

Apache-2.0。内置 Agent 角色文案与工作流模板移植自 ACEHarness（Apache-2.0 with Runtime Library Exception，© 仓颉团队），界面图标使用 ACEHarness 官方 logo。
