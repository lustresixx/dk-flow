# dsh-ace-harness

把 [ACEHarness](https://gitcode.com/Cangjie-SIG/ACEHarness) 的核心移植成 DeepSeek Harness 插件：**可命名、可持久、可恢复的 YAML 状态机工作流** + **defender/attacker/judge 对抗式多 Agent 评审** + **模板库与治理**。

- 状态机 DSL 与 ACE 的 `workflow.yaml` 字段/语义一致（verdict 转移、子工作流、并行组、熔断、恢复）
- 每个步骤由专属角色的 DSH 子 Agent 执行（`ctx.subagents`，spawn/fork provider）
- 内置 11 个精选 Agent（supervisor / 防守 / 攻击 / 裁决四队）与 3 个 workflow 模板（通用红蓝评审、缺陷定位修复、软件交付）
- `/workflow` 斜杠命令 + `workflow_list` / `run_workflow` / `workflow_manage` 三个模型工具
- Web GUI 浮动面板：模板浏览 → 填参 → 运行 → 进度看板
- **可视化编排编辑器**（React Flow）：拖拽状态节点与 verdict 转移边、编辑步骤/角色/任务、从模板实例化后继续编排、保存即校验
- 治理：运行目录持久化（state.json + audit.jsonl）、恢复、人工决策点、Git baseline 快照、supervisor 评分（1–10）与工作区级经验沉淀（experience.jsonl 回灌后续检查点）

## 安装

要求：Node.js ≥ 22，DeepSeek Harness `0.1.0-rc.7`（见 [compatibility.json](compatibility.json)）。

```sh
# 从本地源码安装（开发）
dsh plugin --profile web add <本仓库路径>

# 发布后从 npm 安装
dsh plugin --profile web add dsh-ace-harness
```

重启对应 profile 并刷新 Web UI。验证配置：

```sh
dsh --profile web --dump-config
# 预期出现：
# - id: ace-harness
#   name: dsh-ace-harness
```

> Windows + pnpm 的本地路径安装已知问题：`link:` 绝对盘符路径可能生成损坏的 junction。开发期可手动创建 junction：
> `New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-ace-harness" -Target "<仓库绝对路径>"`，
> 并把 `dsh-ace-harness` 加进 profile `package.json` 的 `dsh.profile.bundles`。

## 使用

对话中直接说：

```text
/workflow list
/workflow templates
/workflow run general-red-blue-review --param projectRoot=E:\repo --param requirements=评审本次改动 --wait
/workflow create issue-fix --param projectRoot=E:\repo --save
/workflow runs
/workflow show <runId>
/workflow resume <runId>
/workflow stop <runId>
```

模型工具（自然语言即可触发）：

- `workflow_list` — 列出模板与已保存的 workflow 实例
- `run_workflow` — 运行实例或模板（模板先实例化），`wait=true` 同步等待终态
- `workflow_manage` — runs / show / resume / stop / create

Web GUI 右下角有「ACE 工作流」浮动面板：浏览模板、填参数、一键运行、查看进度与各状态 verdict。

可视化编排：

1. 「模板」页展开模板 → 「创建并编排」：填参数与实例文件名，进入编辑器
2. 「工作流」页对已有实例点「编排」：加载 YAML 到编辑器
3. 编辑器内：拖动节点布局、从节点右缘拖到另一节点创建转移边、点节点编辑状态/步骤/角色/任务/并行组、点边编辑 verdict 条件与优先级
4. 「保存」经宿主路由校验后写入 `<workspace>/.dsh/workflows/`

## 工作流 DSL

与 ACEHarness `workflow.yaml` 兼容（字段语义一致，见 `src/dsl/schema.ts`）：

```yaml
workflow:
  name: 通用红蓝评审
  mode: state-machine
  maxTransitions: 30
  supervisor:
    enabled: true
    agent: default-supervisor
    stageReviewEnabled: true
    checkpointAdviceEnabled: true
    scoringEnabled: true
    experienceEnabled: true
  states:
    - name: 方案
      isInitial: true
      steps:
        - { name: 方案设计, agent: architect, role: defender, task: 基于需求形成可执行方案 }
        - { name: 方案挑战, agent: solution-breaker, role: attacker, task: 从边界、风险和遗漏角度挑战方案 }
        - { name: 方案裁决, agent: design-judge, role: judge, task: 综合方案和挑战意见，给出 verdict }
      transitions:
        - { to: 执行, condition: { verdict: pass }, priority: 10, label: 方案通过 }
        - { to: 方案, condition: { verdict: conditional_pass }, priority: 20, label: 补充方案 }
  ...
context:
  projectRoot: ""
  workspaceMode: in-place
  requirements: ""
```

执行语义：

- 每个状态按 segment 执行（`parallelGroup` 相同的步骤并发）；**最后一个 segment 的 verdict 决定状态结论**
- 对抗状态（`reviewPolicy.mode: adversarial` 或显式 role）中，attacker/judge 只读本状态前置步骤的证据，judge 输出 `pass / conditional_pass / fail`
- 转移按 priority 升序取第一个命中；`conditional_pass` 无匹配规则时自转移；无任何匹配进入人工决策（持久化等待，可 resume）
- `maxTransitions` / `maxSelfTransitions` 熔断；每步后持久化，中断可从断点恢复
- 子工作流步骤：`type: subworkflow` + `workflow` 配置引用，独立 runId，结果按 `result` 映射回 verdict

## 存储布局

- workflow 实例：`<workspace>/.dsh/workflows/*.yaml`（项目）与 `$DSH_HOME/workflows/*.yaml`（个人），项目同名覆盖个人
- 运行数据：`<workspace>/.ace-workflows/runs/<runId>/`（`state.json` + `audit.jsonl` + `git-baseline.json`）
- 经验沉淀：`<workspace>/.ace-workflows/experience.jsonl`（工作区级，最近记录回灌 supervisor 检查点）
- 内置模板与 Agent：插件包内 `resources/`

## 配置

cordis.patch.yml 行内 `config`：

```yaml
- insert:
    - id: ace-harness
      name: dsh-ace-harness
      config:
        subagentProvider: spawn      # 步骤执行 provider（spawn | fork）
        model: ''                    # 可选：所有步骤强制使用的模型
        runDirName: .ace-workflows   # 运行存储目录名
        maxSubworkflowDepth: 8       # 子工作流嵌套上限
        maxConcurrentRuns: 4         # 单服务实例并发运行上限
```

## 开发

```sh
pnpm install
pnpm build          # 服务端 + 客户端双面构建
pnpm typecheck
pnpm test           # 54 个单测：DSL/verdict/转移/运行器/模板/目录
```

隔离验证（不影响正在使用的 profile）：

```sh
dsh plugin --profile ace-test add .
dsh --profile ace-test --port 3091   # 另起实例
curl http://127.0.0.1:3091/plugins/dsh-ace-harness/state
```

## 已知限制

- 步骤执行依赖 DSH 的 `spawn`/`fork` 子代理与可用的 LLM 凭据；未配置凭据时运行会以清晰错误失败并持久化 failed 状态
- 运行在发起命令/工具的进程中前台推进；后台 job 化与跨进程恢复尚未实现（中断后可用 `/workflow resume` 在同一工作区继续）
- `allowedTools` 按 ACE→DSH 工具映射（Bash→bash、Read→read、Write→write、Edit→edit、Glob/Grep→glob）转为子代理工具白名单；未知 ACE 工具名被跳过
- 编辑器暂不覆盖的高级 DSL 字段：`issueTypes`/`severities`/`minIssueCount` 条件、`reviewPolicy`、自定义 `custom` 条件——这些保留在 YAML 里，可在编辑器的步骤/转移检查器中改动常用字段，高级字段直接改 YAML

## 许可证与署名

Apache-2.0。内置 Agent 角色文案与 workflow 模板移植自 ACEHarness（Apache-2.0 with Runtime Library Exception，© 仓颉团队），保留其语义并适配 DSH 工具/模型。
