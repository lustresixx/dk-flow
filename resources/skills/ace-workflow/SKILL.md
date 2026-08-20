---
name: ace-workflow
description: ACE 状态机工作流的编排与运行：模板、实例、运行、脚本与参数约定。当用户提到工作流、流水线、模板、红蓝评审、脚本节点或 /workflow 命令时使用。
---

# ACE 工作流框架使用指南

dsh-ace-harness 把 ACEHarness 的状态机工作流移植成了 DSH 插件。工作流是 YAML 状态机：状态（state）串行/并行执行步骤（step），步骤产出 verdict（success/fail）驱动转移。

## 工具与命令

- `workflow_list`：列模板、实例与运行记录（必填参数信息在此查看）
- `run_workflow`：按实例文件名或模板 id 启动运行；`params` 提供参数；`wait=true` 同步等终态
- `workflow_manage`：runs / show / resume / stop / create
- 斜杠命令：`/workflow list | templates | create <模板> | run <workflow> [--param id=value ...] [--wait] | runs | show <runId> | resume <runId> | stop <runId> | scripts | validate <file> | delete <file>`

## 关键约定

1. **参数**：运行前用 workflow_list 确认必填参数并在 params/--param 提供；缺少时系统会向用户弹卡询问。创建实例时参数可留空，留空的必填参数转为运行时询问字段。
2. **结果解读**：终态 completed/success 只表示运行收尾；结果里的 `failedStates` 非空表示有状态判 fail（走了失败分支），必须如实报告，不得说“整体成功”。
3. **等待被取消**：wait=true 的运行如果调用被用户取消（aborted），运行不会丢失——自动转为后台 job 继续执行，用 workflow_manage action=runs 查最新 runId。
4. **脚本节点**（type: script）：
   - 内联 `script` 是 JS（node:vm 沙箱、冻结 context）；`scriptFile` 引用脚本文件（.js/.mjs/.cjs 进沙箱，.py 用 Python 子进程）
   - 解析顺序：工作区根 → `<工作区>/.ace-workflows/scripts/`（收集目录）→ 插件内置库 `resources/scripts/`
   - 输入：`context.requirements` / `context.inputs` / `context.priorStepEvidence` / `context.stepData`（上游结构化数据，按 `状态/步骤` 取值）
   - 输出契约（严格）：`return { output: "...", success: true|false }`，可选 `data`（JSON，≤64KB）；`{ error }` 表示失败；Python 脚本最后向 stdout 打印一行 JSON
5. **重试与超时**：`retry: { maxRetries, backoffMs }`（只重试执行错误，fail 裁决不重试）；`timeoutMinutes` 覆盖默认超时（AI/LLM 用插件 stepTimeoutMs，脚本 JS 10s / Python 30s）。
6. **收集脚本**：通用脚本放进工作区 `.ace-workflows/scripts/`，`/workflow scripts` 查看清单；不要散落在全盘。
