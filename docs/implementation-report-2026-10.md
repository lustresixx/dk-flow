# 实施改造报告（批次 3–5，本会话）

> 输入：「方案定稿」批准的五批次方案；约束：**全部测试通过、公开 API 不变**。
> 前置事实：`docs/behavior-baseline-2026-10.md`（基线 + 批次 0 宿主门禁）。
> 本文档逐项记录：改了什么 / 为什么 / 对应哪个问题 / 如何验证。

## 0. 接手核对（先核对再续做）

| 批次 | 状态 | 证据 |
|---|---|---|
| 批次 1 纯 bug 修复（C1 缓存 / C2 kill / C3 常量） | 已完成 | `b05ae34` |
| 批次 2 纯结构移动（C4 拆分 / C5 投影 / C6 run-meta） | 已完成 | `f30b721` `509bad9` `f1f1b48` |
| 批次 3 行为修正（P0-3 / P1-1 / P1-2③） | **本会话完成** | `67f666f` `ab88732` `b7ef3f2` |
| 批次 4 加固与观测（P1-2②④⑤ / P2-2 / P2-3） | **本会话完成** | `a4d2cda` `4fc46d0` `13c69da` |
| 批次 5 量化门禁（P1-2⑥） | **本会话完成** | `5172446` |

### ⚠️ 清单外改动事件（已按规程处置）

接手时工作树有一份**未提交、且不属于任何已批准批次**的修改（`src/run-lifecycle.ts` +
`src/run-persistence.ts`）：内容是让终态运行（failed/crashed/stopped）可恢复 + 孤儿运行跨会话认领。
它逆转了 `04292b3` 的刻意设计（终态 fail-fast），且与对标文档「API 运行可否被任意会话 resume 属安全决策、
必须走审批门，不可由重构顺手改掉」的结论冲突。**处置：未提交、未删除，以 `git stash` 完整保留**：

```
stash@{0}: OUT-OF-PLAN uncommitted: run-lifecycle terminal-resume + orphan adoption
           (reverses 04292b3; not in approved batches 1-5; preserved for human review)
```

该 stash 的另一半（run-persistence 审计游标补种）与已批准的 P1-2⑤「重建必须幂等」语义重叠，
已由 C12 以方案内口径实现（见 §4.3）；stash 中的恢复语义部分仍待人工审批门决策。
建议维护者评审后 `git stash pop` 或 `git stash drop`。

## 1. C7 — 步骤执行路径收敛（P0-3，批次 3·1/3）`67f666f`

- **问题**：`engine/runner.ts executeState` 与 `service.ts testState/testStep/executeTestStep` 各实现一份
  单状态步骤执行，已发散四点（角色推断 / script rationale 截断 / segment·join 镜像 / timeout 换算）。
- **改动**：新增 `src/engine/state-steps.ts`——`executeStateStep`（单步：角色推断、四种类型分派、
  重试策略、超时换算、证据交接）、`executeStateSteps`（segment 串行/并行、恢复跳过）、
  `joinStateVerdict`（末段汇合）。`runner.executeState` 只保留运行簿记（pendingState/进度/persist）
  经 hook 接入；supervisor 检查点上下文保持状态开始时的历史捕获点，**runner 路径逐位不变**。
  `service.testState/testStep` 改用同一实现；无会话守卫错误文案逐字保留。
- **声明差异**（编辑器「验证状态/步骤」输出，无测试钉住）：对抗状态角色推断与真实运行一致
  （原「不展开」备注移除）；script rationale 按 `CONCLUSION_BUDGET` 截断；单步验证的 script
  `priorStepEvidence` 用标准占位符；声明了重试策略的步骤在验证中会真实重试；缺配置的子工作流步骤
  报「缺少配置」而非「不存在」。
- **验证**：typecheck ×2 exit 0；构建 ×3 exit 0；引擎冒烟 17/17（并行并发度、judge 证据交接、
  重试 attempts、script 截断与数据通道、对抗角色推断、verdict 汇合——覆盖 runner.spec 钉住的语义）。

## 2. C8 — 解析统一（P1-1，批次 3·2/3）`ab88732`

- **问题**：模板/实例解析 3+1 处实现，`resolveWorkflowConfig` 的 `find` 取**最旧**版本而其余三处取最新；
  版本排序用 `localeCompare`（`0.10.0 < 0.9.0` 语义错误）。
- **改动**：`catalog/index.ts` 新增 `compareVersions`（分段数值比较）与 `latestTemplate`（唯一「最新」口径），
  catalog 排序同步修正；service.resolveWorkflowConfig / instantiate / runApi、commands run/create、
  tools.run_workflow 全部改走 `latestTemplate`；缺参询问编排提取为 `run-target.ts resolveRunTarget`，
  commands/tools 各自渲染与此前**逐字节相同**的错误文案；runApi 保持不询问。
- **声明差异**：多版本部署下编辑器拓扑/子工作流/resume 解析从「最旧」改为「最新」——当前 resources
  全部单版本 1.0.0，无即时影响。
- **验证**：typecheck ×2 exit 0；版本助手冒烟 6/6（含 0.10.0 > 0.9.0、latestTemplate 选取/未命中）。

## 3. C9 — persist 串行化 + 证据快照语义（P1-2③，批次 3·3/3）`b7ef3f2`

- **问题**：并行 segment 多步骤并发 `await persist()` 交错；共享 `completedSteps` 可变数组。
- **改动**：`RunPersistence.makePersist` 改为 per-run promise 链（失败的 persist 拒绝自身调用方但不阻塞链）；
  `executeStateSteps` 钉住「segment 开始时快照」证据语义。经一手代码复核确认：证据读取原本就在各步骤
  同步起点完成（事实上确定），本次将其显式化以防未来重构引入 await 交错；真正的不确定性在 persist
  交错（state.json 原子写不损坏，但审计游标与流投影观测顺序不定，极端下可重复 diff 同一状态）。
- **runner.spec 复核**（方案门禁项）：并行组用例只断言并发度（`maxConcurrent >= 2`），不钉证据文本 → 不破。
- **验证**：C9 冒烟 4/4（两个并发快照恰好两个 state-end、顺序 s1→s2、失败不阻塞链）+ C7 冒烟复跑绿。

## 4. 批次 4 — 加固与观测

### 4.1 C10 — 单控制器（P1-2②）`a4d2cda`

- startRun/resumeRun 的双 AbortController 手工桥接（controller→linked，无 dispose）收敛为单控制器，
  引擎直接消费其 signal；turn 信号不再链入，detach 决策点命名并文档化三分支
  （已终态→不动；waiting-human→abort（pendingHuman 持久，resume 重问）；否则→detach 为 job，
  无 jobs 服务→abort）。外部行为不变。

### 4.2 C11 — 流缓冲增量封顶（P1-2④）`a4d2cda`

- `step-executor-factory` 两处流追加（agent 子会话折叠轮询、llm text-delta）改经 `appendCapped`，
  按 `SUMMARY_BUDGET` 保头部（与 finalize 的 `truncate` 同侧）。声明差异：中间态流文本可被截短；
  最终文本不变。

### 4.3 C12 — 恢复/子工作流可观测性（P1-2⑤）`a4d2cda`

- `resumeRun` 经 `registry.openStream` + 幂等的 `projectRunStateToStream` 从持久化真源重建流条目
  （拓扑/verdicts/stepLog 回填，`/stream` 恢复 200）；
- 子工作流步骤为 childRunId 开流条目并在结束时 settle（执行期面板不再静默；面板自动轮询子运行
  属后续 client 增强，本次 wire 纯增量）；
- 审计 diff 游标在进程内首个快照时**只补种不发射**，恢复运行的历史 state-end 不再重放进
  audit.jsonl（新运行的首个空快照补种空游标，diff 行为与此前逐位一致）。
- **测试钉变更（已声明）**：`run-persistence.spec` 的 state-end diff 用例补上引擎真实首帧（零产出
  persist）；新增用例钉住「恢复不重放」语义。旧钉文本字面编码的正是重放 bug——「首帧带产出」即
  恢复模式，无法既满足旧钉又满足已批准的幂等要求。
- **验证**：C12 冒烟 8/8（恢复不重放、新状态恰好 diff 一次、新运行 diff 不变、重建+幂等）。

## 5. C13 — resources 根下沉（P2-2，批次 4）`4fc46d0`

- `resourcesRoot` 移至最底层 `src/resources.ts`（仅 node 内建）；catalog 原位 re-export 保旧路径；
  engine/script-file-runner 与 store/skill-install 不再上引 catalog。实测全库：engine/store 无 catalog
  import，「engine 纯 TS 宿主无关」宣称与实现重新一致。ARCHITECTURE.md 结构树同步刷新为拆分后实况。
- 纯 import 路径移动，无签名/行为变化。验证：typecheck ×2 + 构建 + 导出集合 + C7 冒烟复跑。

## 6. C14 — 宿主能力收口（P2-3，批次 4）`13c69da`

- 新增 `src/host-services.ts`：`HostServices`（processCwd + 惰性 agents()/jobs()）命名宿主缝；
  惰性是刻意的——jobs 不在 inject 列表、可能晚于激活挂载，构造期快照会破坏 job 模式。
  服务构造器新增**可选**第三参 `host?: HostServices`（`new AceHarnessService(ctx, config)` 不破）；
  `apiRunnerParent(workspace)` 命名工厂标注最小必需字段与「无 session.id → 不可恢复」的授权语义。
- 边界决策（记录在案、不动）：index.ts 的 webServer/workspaceRegistry 多键惰性探测留在路由注册缝；
  `DSH_HOME`/`paths.dshHome` 环境读取是文档化配置面。
- 验证：typecheck ×2；`apiRunnerParent` 形状冒烟；C7/C12 冒烟复跑。

## 7. C15 — 归档写移出热路径（P1-2⑥，批次 5·量化门禁）`5172446`

- `RunPersistence` 归档写（run 快照 + audit 行）改挂 per-workspace FIFO promise 链，persist 热路径
  只排队不等待；`closeArchives` 先尽力 drain 再关句柄；状态路由 archived 计数挂 10s TTL 缓存
  （复用 P0-1 模式；runs-history/stats 查询不缓存）。声明：崩溃窗口内未落盘的镜像行可丢失
  （JSON 文件仍是真源）；徽章可滞后 ≤10s。
- **量化门禁实测**（同机，state_json ≈ 77 KB、10 状态 × 5 步、50 次 persist）：
  旧内联同步写每次 persist 阻塞事件循环 **0.72ms**（总 36.1ms）；新队列写热路径 **0.004ms/次**
  （≈180×），等量 31.2ms 工作异步落盘。旧成本随运行长度线性增长，新热路径不增长。
- 验证：C15 e2e 冒烟 3/3（队列快照+审计行 FIFO 落盘、关闭归档不受影响）；C7/C9/C12 复跑绿。

## 8. 本会话执行过的命令与结果

| 命令 | 结果 |
|---|---|
| `npx tsc -p tsconfig.json --noEmit` | exit 0（每提交前 + 终验，共 8 次） |
| `npx tsc -p tsconfig.client.json --noEmit` | exit 0（同上） |
| `npx tsc -p tsconfig.json` / `tsconfig.client.json` / `npx tsdown` | exit 0；client bundle 971.41 kB（基线 948.7 kB 为拆分前；与 C6 提交时持平，本会话增量为 host 侧） |
| `node -e import('./lib/index.js')` 导出集合 | `{Config, apply, inject, name}` 逐字段等于基线冻结值 |
| `node .dsh/smoke-c7.mjs`（引擎等价性 17 断言） | exit 0 |
| `node .dsh/smoke-c9.mjs`（persist 串行化 4 断言） | exit 0 |
| `node .dsh/smoke-c12.mjs`（恢复幂等+投影重建 8 断言） | exit 0 |
| `node .dsh/smoke-c15.mjs`（归档队列 e2e 3 断言） | exit 0 |
| `node .dsh/bench-c15.mjs`（量化门禁） | 0.72ms → 0.004ms/persist（≈180×） |
| `pnpm test`（vitest，28 spec/209 用例） | **未执行——沙箱 EPERM**（基线 §3.2 三层归因）；属宿主批次 0 硬门禁 |

## 9. 残余风险与未覆盖范围

1. **vitest 全程未跑**（环境限制，非测试失败）。除既有 209 用例外，本会话改了
   `run-persistence.spec`（1 处更新 + 1 处新增）——宿主复跑时必须确认全绿，特别是 runner.spec、
   tools-runjson.spec、step-timeout.spec、client-bundle.client.spec。
2. **引擎级冒烟是 node 直跑编译产物的自验**（`.dsh/smoke-*.mjs`，未进 tests/），覆盖 C7/C9/C12/C15
   关键路径但不替代 vitest；如需长期留存可迁入 tests/（宿主环境验证后）。
3. **stash@{0} 待评审**（§0）：终态可恢复 + 跨会话认领是安全/产品语义决策，不在本方案内。
4. **P1-2⑤ 的 client 侧**（LiveRunPanel 自动追踪子工作流子运行）未做——host 侧 `/stream` 已可查
   childRunId，面板增强留给后续。
5. **行为修正白名单汇总**（需在 PR 声明）：testState/testStep 输出对齐（C7）；多版本「最新」口径（C8）；
   并行组证据快照显式化（C9，事实上不变）；流中间态截短（C11）；重建流的 stepLog 为持久化摘要文本（C12）；
   归档徽章 ≤10s 滞后 + 镜像崩溃窗口（C15）；拓扑编辑 30s 缓存（C1，批次 1 已声明）。
6. sqlite-archive 的 `DatabaseSync` 驱动未换（方案裁决：保驱动改时机）；Node 22→24 升级路径上
  `node:sqlite` 实验 API 变更风险维持基线 §7.4 跟踪项。
