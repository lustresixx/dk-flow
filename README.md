# dsh-ace-harness

[![npm](https://img.shields.io/badge/npm-dsh--ace--harness-blue)](https://github.com/lustresixx/dk-flow)
[![license](https://img.shields.io/badge/license-Apache--2.0-green)](./LICENSE)
[![tests](https://img.shields.io/badge/tests-186%20passing-brightgreen)](./tests)
[![node](https://img.shields.io/badge/node-%5E22.0.0%20%7C%7C%20%3E%3D24.0.0-informational)](#)

把 ACEHarness 的工作流核心移植为 [DeepSeek Harness](https://github.com/deepseek-ai) 插件：**可视化编排的状态机工作流 + 对抗式多 Agent 评审 + 平台级运行治理**。目标是做成可部署到平台上的 workflow 产品内核（见 [docs/ROADMAP.md](./docs/ROADMAP.md)）。

## 特性

- **状态机工作流**：状态串行/并行执行步骤，`success / fail` 二元流转（由 AI 判断，兼容旧 `pass / conditional_pass` YAML），熔断保护（最大转移数 / 最大自转移数）
- **四类节点**：AI 步骤（专属角色子代理 + 工具过滤）、快速 LLM（单轮直调，无子代理开销）、脚本（JS 沙箱 / Python 子进程，严格输入输出契约）、子工作流（嵌套 + 深度上限）
- **对抗式多 Agent**：13 个内置角色（defender / attacker / judge / supervisor），红蓝评审、七角色接力评审、带人工审批门的架构重构评审等 8 个内置模板
- **平台级运行治理**：断点恢复、崩溃自愈、人工审批门、风险自适应 supervisor、自动重试（指数退避）、步骤级超时、后台 job、停止即停、并发上限
- **三大入口**：全屏工作台（React Flow 可视化编辑器 + 运行时拓扑图 + 流式侧边栏）、`/workflow` 斜杠命令族、模型工具（`workflow_list` / `run_workflow` / `workflow_manage`）
- **单节点独立验证**：`/workflow test <工作流> <状态> <步骤>` 或编辑器里每个步骤的「▶ 验证」按钮——只跑一个节点看产出与 verdict，不跑整个工作流
- **每次运行独立沙箱**：JS 脚本在 worker 线程执行（独立内存 + 可靠超时终止，`while(true)` 也能杀）；Python 子进程在每次运行的沙箱目录中运行（独立 cwd、密钥脱敏环境、临时目录重定向）
- **脚本与技能收集目录**：工作区 `.ace-workflows/scripts/` + 内置脚本库三级解析，`/workflow scripts` 清单；框架 skill 自动安装到 `$DSH_HOME/skills/`
- **REST API**：状态聚合、工作流 CRUD、模板实例化、运行、流式进度、停止

## 快速开始

要求：Node `^22.0.0 || >=24.0.0`，DeepSeek Harness `0.1.0-rc.6+`（开发验证于 `0.1.0-rc.7`）。

```bash
# 安装到 DSH 的某个 profile
cd ~/.dsh/profiles/my-profile   # Windows: C:\Users\<you>\.dsh\profiles\my-profile
pnpm add github:lustresixx/dk-flow
```

然后启动 DSH 并打开 Web 界面：

```bash
dsh --profile my-profile --port 4090
# 浏览器打开 http://127.0.0.1:4090
```

右下角出现「工作流」浮标：点击进入工作台；运行中的工作流会自动弹出实时侧边栏（拓扑图 + 每步流式输出）。AI 步骤需要模型凭据；脚本流水线无需凭据即可体验。

## 使用方式

### 工作台

- **模板页**：8 个内置模板（结构预览 + 运行时参数表单），「直接运行」或「创建并编排」（创建不填参，留空的必填参数转为运行时询问）
- **工作流页**：实例列表；运行参数在这里填写（缺必填项会被页面内拦下）；编排 / 删除
- **运行记录页**：运行时拓扑图（状态按成功/失败着色、执行过的路径加亮）+ 状态时间线（每步输出、verdict、重试次数、supervisor 评分）+ 恢复 / 停止
- **编辑器**：拖节点布局、右缘拖线连转移（成功/失败/无条件）、节点检查器编辑状态与步骤，保存即校验

### 斜杠命令

```text
/workflow list                      # 模板、实例、运行一览
/workflow templates                 # 模板与参数详情
/workflow agents                    # 内置角色
/workflow scripts                   # 内置 + 收集目录脚本清单
/workflow create <模板> [--save]    # 从模板创建实例（参数可留空）
/workflow run <实例|模板> [--param id=value ...] [--wait]
/workflow test <实例|模板> <状态> <步骤> [--param id=value ...]   # 单节点独立验证
/workflow runs | show <runId> | resume <runId> | stop <runId>
/workflow validate <file> | delete <file>
```

缺少必填参数时，会弹卡询问（实例按 taskInput 字段、模板按 manifest 参数）。

### 模型工具

`workflow_list`、`run_workflow`（`wait=true` 同步等终态）、`workflow_manage`（runs / show / resume / stop / create）。注意结果里的 `failedStates`：非空表示有状态判 fail（走了失败分支），即使终态是 `completed/success` 也要如实报告。

### REST API

| 路由 | 说明 |
|---|---|
| `GET /plugins/dsh-ace-harness/state` | 模板 / 工作流 / 运行聚合状态（可选 `?workspace=<path>`） |
| `GET/POST /plugins/dsh-ace-harness/workflows/<file>` | 读取 / 保存工作流实例 |
| `POST /plugins/dsh-ace-harness/instantiate` | 模板实例化（`{ templateId, values }`） |
| `POST /plugins/dsh-ace-harness/run` | 启动运行并等待终态（`{ workspace, workflow, values }`） |
| `GET /plugins/dsh-ace-harness/stream?runId=...` | 运行实时投影（拓扑、进度、每步输出） |
| `POST /plugins/dsh-ace-harness/stop` | 停止运行 |

## 工作流 DSL

```yaml
workflow:
  name: 简单脚本流水线
  mode: state-machine
  maxTransitions: 10
  stepRetry: { maxRetries: 2, backoffMs: 2000 }   # 工作流级默认重试
  states:
    - name: 输入检查
      isInitial: true
      steps:
        - name: 检查输入
          type: script
          script: |
            if (!context.requirements) return { output: '输入为空', success: false }
            return { output: '输入检查通过：' + context.requirements, success: true, data: { ok: true } }
      transitions:
        - { to: 转换, condition: { verdict: success }, priority: 10, label: 成功 }
        - { to: 失败, condition: { verdict: fail }, priority: 20, label: 失败 }
    # ...
```

### 节点类型

| 类型 | 说明 |
|---|---|
| `agent` | 选择内置角色启动 DSH 子代理；judge 结构化输出 verdict；按角色过滤工具 |
| `llm` | 一次直接的单轮模型调用（不启动子代理、无工具），适合快速判断/分类/摘要；`agent` 可选（复用角色设定），`model` 可选 |
| `script` | 内联 JS（node:vm 沙箱、`"use strict"`、冻结只读 `context`）或 `scriptFile` 引用文件（`.js/.mjs/.cjs` 进沙箱，`.py` 用 Python 子进程）。必须返回 `{ output: "...", success: true/false }`（或 `{ error }`），可选 `data`（JSON ≤64KB）传给下游；违反契约直接判 fail |
| `subworkflow` | 引用另一工作流（文件名/模板 id），独立 runId，结果映射回 verdict |

脚本可用上下文：`context.requirements` / `context.inputs` / `context.priorStepEvidence` / `context.priorStateEvidence` / `context.stepData`（上游结构化数据，按 `状态/步骤` 取值）。Python 脚本的 `context` 以 JSON 经 stdin 传入，最后向 stdout 输出一行结果 JSON。

### 步骤级控制

- `timeoutMinutes`：覆盖默认超时（AI/LLM 用插件 `stepTimeoutMs`，脚本 JS 10s / Python 30s）
- `retry: { maxRetries, backoffMs }`：只重试**执行错误**（模型调用失败/超时/子流崩溃）；fail 裁决是流转信号不重试；运行记录显示重试次数
- `parallelGroup`：同组步骤并行执行，join 策略 `all / any / quorum / manual`

### 单节点验证与运行沙箱

- **单节点验证**：`/workflow test <工作流> <状态> <步骤> [--param ...]`（全部节点类型，走会话上下文）；编辑器步骤卡上的「▶ 验证」按钮（脚本/快速 LLM 自包含直接跑，agent/子工作流会提示到会话中验证）；`POST /plugins/dsh-ace-harness/test-step`（支持直接传 YAML）
- **每次运行独立沙箱**：启动时创建 `<runId>/sandbox/` 目录；JS 脚本在 worker 线程执行（`resourceLimits` 内存上限、超时/取消可靠终止）；Python 子进程以沙箱目录为 cwd、环境变量脱敏（不含任何密钥，仅保留 PATH 等系统变量）、TEMP/TMP 重定向到沙箱、强制 UTF-8 IO。注意：这是进程级隔离约定，不是容器级安全边界（见 ROADMAP P0-4）

### 脚本与 Skill 收集目录

- `scriptFile` 解析顺序：工作区根 → `<工作区>/.ace-workflows/scripts/` → 插件内置库 `resources/scripts/`
- 框架 skill（`ace-workflow`）自动安装到 `$DSH_HOME/skills/ace-workflow/`，已存在则不覆盖

## 内置模板与 Agent

| 模板 | 说明 |
|---|---|
| `general-red-blue-review` | 通用红蓝对抗评审（方案 → 执行 → 验收） |
| `issue-fix` | 缺陷复现 → 根因分析 → 修复 → 回归 |
| `software-delivery` | 设计 → 实现 → 测试 → 交付整理 |
| `code-optimization-review` | 七角色接力：方案 → 调研 → 对抗 → 需求 → 优化 → 测试 → 终审 → 汇总 |
| `simple-script-pipeline` | 纯脚本示例（无需模型凭据） |
| `mixed-agent-script` | 脚本 ⇄ AI 混编示例 |
| `simple-llm-qa` | 快速 LLM 节点示例（判断 → 提炼 → 汇总） |
| `architecture-refactor-review` | 架构重构评审：诊断 → 调研 → 对抗 → **方案审批** → 行为基线 → 实施 → 回归 → 对抗审查 → **终审审批** → 交付（10 状态、双人工审批门，全程对抗 + 功能等价验证） |

内置 13 个角色 Agent：`default-supervisor`（supervisor）、`architect` / `developer` / `tester` / `documentation-writer` / `issue-reproducer`（defender）、`solution-breaker` / `code-hunter` / `stress-tester`（attacker）、`design-judge` / `code-judge`（judge）、`researcher` / `product-manager`（black-gold）。

## 插件配置

在 `cordis.patch.yml` 中配置：

| 配置项 | 默认 | 说明 |
|---|---|---|
| `subagentProvider` | `spawn` | 步骤子代理的 provider |
| `model` | — | 全局模型覆盖 |
| `runDirName` | `.ace-workflows` | 工作区内的运行存储目录名 |
| `maxSubworkflowDepth` | `8` | 子工作流最大嵌套深度 |
| `maxConcurrentRuns` | `4` | 单实例并发运行上限 |
| `preCommandTimeoutMs` | `300000` | 预命令超时 |
| `stepTimeoutMs` | `1800000` | AI/LLM 步骤默认超时 |
| `pythonCommand` | `python` | `.py` 脚本的解释器命令（如 `py -3`） |

## 开发

```bash
pnpm install
pnpm typecheck    # 类型检查（宿主 + 客户端）
pnpm test         # 177 个单元测试（含真实 Python 子进程用例）
pnpm build        # tsc + tsdown（宿主 + 浏览器 bundle）
```

## 文档

- [docs/ROADMAP.md](./docs/ROADMAP.md) —— 平台化路线图（多租户、调度、配额、可观测、安全边界等）
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) —— 代码结构
- [templates/README.md](./templates/README.md) —— 可直接取用的工作流模板

## License

[Apache-2.0](./LICENSE)。工作流 DSL 字段与语义沿用 ACEHarness 的 `workflow.yaml` 设计（Apache-2.0 with Runtime Library Exception），仅保留兼容所需子集。
