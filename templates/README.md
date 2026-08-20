# 可直接取用的工作流模板

这些 YAML 与插件内置模板同源，放在仓库顶层方便直接查看、复制与二次修改。

| 文件 | 说明 | 需要凭据 |
|---|---|---|
| `code-optimization-review.yaml` | 七角色接力：提出方案 → 资料调研 → 对抗挑战 → 敲定需求 → 代码优化 → 测试验证 → 最终评审 → 交付汇总 | ✅（8 步 AI） |
| `mixed-agent-script.yaml` | Agent 与脚本交替：先脚本、再 Agent、再脚本、再 Agent、最后脚本，Dify 风格混编 | ✅（2 步 AI） |
| `simple-llm-qa.yaml` | 轻量 llm 节点示例：快速判断 → 要点提炼 → 脚本汇总；每个 llm 节点只是一次单轮模型调用，不启动子代理、不带工具 | ✅（2 次单轮调用） |
| `simple-script-pipeline.yaml` | 纯脚本示例流水线：输入检查 → 转换 → 汇总，成功/失败二元流转 | ❌（无模型调用） |

## 使用方式（任选）

1. **插件内直接用**：这些模板已作为内置模板打包（`code-optimization-review` / `mixed-agent-script` /
   `simple-llm-qa` / `simple-script-pipeline`），工作台「模板」页填参即可创建实例并运行。

2. **复制为实例**：把任意一份 YAML 拷贝到工作区的 `.dsh/workflows/` 目录（文件名自定，
   只允许字母/数字/下划线/连字符），刷新工作台即可在「工作流」页看到，然后：

   ```text
   /workflow run <文件名> --param requirements=你的目标 --wait
   ```

3. **API 实例化**：`POST /plugins/dsh-ace-harness/instantiate`，`templateId` 用
   `code-optimization-review`、`mixed-agent-script`、`simple-llm-qa` 或 `simple-script-pipeline`。

## 复用改法

- `code-optimization-review.yaml`：改 `context.projectRoot`（项目绝对路径）与
  `context.requirements`（优化目标与验收期望），整套七角色评审即可复用到任意项目；
  也可以在编辑器里增删状态、换 agent 角色、调整转移。
- `mixed-agent-script.yaml`：改各状态的 `script` 与 agent `task` 即可组成你自己的混编流程。
- `simple-llm-qa.yaml`：把 `type: llm` 节点的 `task` 换成你的判断/分类/摘要问题；
  节点可省略 `agent`（直接用调用方默认模型），也可指定 `agent` 复用其角色设定，
  或指定 `model` 覆盖模型。
- `simple-script-pipeline.yaml`：改各状态的 `script` 字段即可改成你自己的脚本节点流程。
