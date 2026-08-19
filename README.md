# dsh-ace-harness

把 ACEHarness 的工作流核心移植成 DeepSeek Harness 插件：**可视化编排的状态机工作流** + **AI/脚本双节点** + **成功/失败二元流转（由 AI 判断）** + **对抗式多 Agent 评审**。

- 全屏「工作流工作台」后台页面：模板 / 工作流 / 运行记录三栏，React Flow 画布拖拽节点与连线
- 节点三种类型：**AI 步骤**（专属角色 Agent）、**脚本步骤**（node:vm 执行 JS）、**子工作流**
- 流转只分**成功 / 失败**，由 AI 依据实际产出判断；保留旧 pass/conditional_pass YAML 兼容
- 内置 11 个角色 Agent（supervisor / defender / attacker / judge 四队）+ 4 个模板（通用红蓝评审、缺陷定位修复、软件交付、简单脚本流水线）
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

- **模板页**：4 个内置模板（结构预览 + 参数表单），可「直接运行」或「创建并编排」
- **工作流页**：项目/个人实例列表，运行 / 编排 / 删除
- **运行记录页**：状态时间线、每步输出与 verdict、supervisor 评分、恢复 / 停止
- **编辑器**：拖动状态节点布局；从节点右缘拖线到另一节点创建转移（默认「成功」，可在右侧检查器改成「失败」或「无条件」）；点节点编辑状态属性与步骤（AI / 脚本 / 子工作流）；保存即校验

### 节点类型

| 类型 | 说明 |
|---|---|
| AI 步骤 | 选择角色 Agent（defender/attacker/judge 或 11 个内置角色），填写任务；judge 步骤结构化输出 verdict |
| 脚本步骤 | 内联 JavaScript（node:vm 沙箱、10s 超时）；可用 `context.requirements` / `context.inputs` / `context.priorStateEvidence` / `context.priorStepEvidence`；返回 `{ output, success }`、`{ error }` 或裸值 |
| 子工作流 | 引用另一个工作流配置（文件名/模板 id），独立 runId，结果映射回 verdict |

### 成功/失败流转

状态转移条件为 `{ verdict: success }` 或 `{ verdict: fail }`，由最后一个步骤的结论（AI 判断或脚本返回值）驱动；无匹配时进入人工决策。旧版 ACE 的 `pass` / `conditional_pass` YAML 仍可加载运行。

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
