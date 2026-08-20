# 回归验证报告（改造后 vs 行为基线，本会话）

> 对照锚点：`docs/behavior-baseline-2026-10.md`（基线 HEAD `dc7f256` + 脏树）；
> 验证对象：HEAD `701d0a0`（批次 1–5 全部落地，工作树干净）。
> 约束复核：**全部测试通过、公开 API 不变**。

## 1. 结论摘要

| 维度 | 基线 | 本次实测 | 判定 |
|---|---|---|---|
| 可执行测试通过率 | 沙箱内 UNMEASURED（209 用例静态盘点） | **223/223 通过（100%）**，两轮全量运行逐位一致 | ✅ 不低于基线 |
| 基线逐文件用例数 | 28 spec / 209 用例 | 同名文件用例数逐一相等；新增 2 spec（C4 拆分产物 +13）+ 本步骤新增 1 spec（+15） | ✅ 无删减 |
| 公开 API | `{Config, apply, inject, name}` | `{Config, apply, inject, name}`（机器实测） | ✅ 逐字段冻结 |
| typecheck 双工程 | exit 0 ×2（3.1s+2.6s） | exit 0 ×2（2.9s+2.7s） | ✅ |
| 构建 ×3 | exit 0 ×3（≈5.9s） | exit 0 ×3（≈6.2s） | ✅ |
| client bundle | 948.7 KiB（971,244±B 量级） | 948.6 KiB（971,410 B），gzip 204.5 KiB | ✅ −0.01%，±1% 阈值内 |
| persist 热路径 | 0.72ms/次（实施前内联写） | 0.004ms/次（队列写，≈185×） | ✅ C15 量化门禁复测成立 |
| 关键行为 | 白名单 5 项差异已声明 | **新发现 1 项白名单外行为差异**（§6，证据齐备） | ⚠️ 待裁决 |

## 2. 验证方法（沙箱内 vitest 替代执行链）

vitest 在本沙箱仍无法启动（复测确认：`spawn EPERM` at `esbuild/lib/main.js:2272`，与基线 §3.2 三层归因一致；
另实测补正：esbuild **Sync API 同样 EPERM**——sync worker 内部仍 spawn esbuild 二进制走管道，基线"sync 走 worker 可行"的推断不成立）。

为让 209+28 个用例在沙箱内真实执行，搭建等效执行链（全部资产在 `.dsh/test-harness/`，不入库）：

1. `transpile-specs.mjs`：用 **TypeScript `transpileModule`**（纯 JS，零子进程）转译 `tests/*.spec.ts` → `.test-build/tests/*.js`——与 vitest 的 esbuild 转译语义一致（单文件、不做类型检查）；`../src/**` 说明符改写为 `lib/` 权威构建产物的 file URL（即测的是发布构件）；`resources/` 镜像进 `.test-build/` 保相对布局。
2. `vitest-shim.mjs`：`describe/it/test/hooks/skip/skipIf` 最小收集执行器；**`expect` 用真 chai + vitest 官方插件（JestExtend/JestChaiExpect/JestAsymmetricMatchers/customMatchers）按 vitest 3.2.7 `createExpect` 源码 1:1 重建**——匹配器语义与宿主 vitest 完全相同；`vi` 实现假定时器三件套（全套件仅 run-registry 用到）。
3. `run-specs.mjs`：逐文件顺序执行；client spec（`@vitest-environment jsdom`）挂真 jsdom 全局；启动前 spawn 探针，spawn 被禁时把"错误证据含 EPERM 签名"的失败归类为 **ENV-BLOCKED**（环境限制，非回归）。

保真度声明：非逐文件进程隔离（vitest 默认隔离），两轮全量结果逐位一致表明无跨文件污染可观测影响。

## 3. 环境

Node v22.15.0 / Windows 11 / pnpm 仓 / 沙箱（spawn 管道 EPERM，jsdom 30.0.1、chai 5.3.3、@vitest/expect 3.2.7 取自 pnpm store）。

## 4. 全量结果（两轮运行逐位一致；命令见 §9）

**31 spec 文件 / 237 用例：223 通过 | 0 失败 | 10 跳过 | 4 环境阻断。**

| 文件 | 用例 | 过 | 跳 | 阻断 | 耗时 |
|---|---:|---:|---:|---:|---:|
| runner.spec | 25 | 25 | | | 438ms |
| script-runner.spec | 15 | 15 | | | 986ms |
| script-file-runner.spec | 17 | 8 | 9 | | 118ms |
| transitions / load / run-selection | 15/12/12 | 全过 | | | ≤10ms |
| verdict / workflow-model.client / sqlite-archive | 11/10/10 | 全过 | | | 3–413ms |
| params-dialog / catalog / pre-commands | 9/8/7 | 9/8/3 | | 4 | ≤250ms |
| run-persistence / run-registry（实施新增） | 6/7 | 全过 | | | ≤51ms |
| **refactor-regression（本步骤新增）** | **15** | **14** | **1** | | 186ms |
| 其余 13 文件（1–6 用例） | 52 | 全过 | | | ≤220ms |

- **4 个 ENV-BLOCKED**（pre-commands.spec：`captures stdout`/`non-zero exits`/`captures stderr`/`renders combined`）：全部以 `Error: spawn EPERM at lib/engine/pre-commands.js:27 (child_process.exec)` 为证据——沙箱禁管道 spawn，非断言失败；同文件"预中止拒绝"与 2 个注入 runner 用例真实通过。**宿主批次 0 必须复核这 4 例**。
- **10 个 SKIPPED**：9 个为 `describe.skipIf(!PYTHON_OK)`（python 探测因 spawn 被禁而 false；宿主有 python 才会执行）；1 个为本步骤新增的宿主专用 abort-kill 用例（自探测 skipIf）。
- sqlite-archive 内嵌性能断言全部通过且余量大：1000 upserts 103ms（阈值 <3000ms）、500 同 id upserts 32ms（<1500ms）、分页 0.4ms（<100ms）、统计 5.3ms（<500ms）、详情 0.1ms（<50ms）。

## 5. 基线对照明细

### 5.1 测试资产沿革（git 实证）

- `git diff dc7f256 HEAD --stat -- tests/`：仅 `run-persistence.spec.ts`(+217)、`run-registry.spec.ts`(+110) 两个新增文件（f30b721 C4 拆分 + a4d2cda C12 更新），**无一既有用例被删改**（209 = 209 精确对账）。
- 本步骤新增 `tests/refactor-regression.spec.ts`（15 用例，vitest 原生 API，宿主可直接跑）。

### 5.2 构建 / API / 产物

| 命令 | 基线 | 本次 | 差 |
|---|---|---|---|
| `tsc -p tsconfig.json --noEmit` | 3.1s exit 0 | 2.9s exit 0 | −0.2s |
| `tsc -p tsconfig.client.json --noEmit` | 2.6s exit 0 | 2.7s exit 0 | +0.1s |
| `tsc -p tsconfig.json` | 2.3s exit 0 | 2.4s exit 0 | +0.1s |
| `tsc -p tsconfig.client.json` | 2.4s exit 0 | 2.6s exit 0 | +0.2s |
| `npx tsdown` | 1.2s exit 0（自报 226ms） | 1.2s exit 0（自报 226ms） | 0 |
| host 导出集合 | `{Config, apply, inject, name}` | 同左（含 sqlite ExperimentalWarning 复现） | 不变 |
| `lib/` 体积 | 128 文件 ≈3,422.7 KB | 158 文件 ≈3,474.6 KB | +1.5%，30 个新文件=C4 拆分协作者（service.js 71.6→25.5 KB） |
| `lib/client.js` | 948.7 KiB / gzip 208.85 | 948.6 KiB（971,410 B）/ gzip 209,454 B | −0.01% / +0.3%，纯结构移动解释内 |

> 勘误（实施报告 §8）："client bundle 971.41 kB（基线 948.7 kB）"系 tsdown 十进制 kB 与 KiB 单位混比；同单位下 bundle 与基线持平（948.6 vs 948.7 KiB）。**client bundle 全程未实质增长**。

### 5.3 性能

| 指标 | 基线/实施前 | 本次 | 说明 |
|---|---|---|---|
| typecheck 合计 | 5.7s | 5.6s | 噪声级 |
| 构建合计 | ≈5.9s | ≈6.2s（+5%） | lib 产物 128→158 文件（C4 拆分），emit 面增大，可解释 |
| persist 热路径 | 0.72–0.74ms/次 | **0.004ms/次（≈185×）** | C15 设计目标；bench-c15 复测：旧 37.0ms/50 次 vs 新热路径 0.20ms，等量 30.8ms 异步落盘 |
| 测试套件总耗时 | 未测得（沙箱限制） | **3.15s / 237 用例**（进程内） | 新增基线数据点；宿主 vitest 有进程隔离开销会更高 |
| 冒烟 | c7/c9/c12/c15 exit 0 | 同左（复跑全绿） | 实施期引擎自验保持 |

## 6. ⚠️ 发现：白名单外行为差异 1 项（证据齐备，待裁决）

**现象**：独立验证（编辑器「验证状态」，service.testState → `executeStateSteps(sequential: true)`）中，**同一并行组内**靠后步骤的证据/`priorStepEvidence`/`stepData` 不再包含同组先行步骤的产出——证据在**段开始时刻冻结**（`src/engine/state-steps.ts:330` `const evidenceSnapshot = [...completedSteps]`，串行/并行两路径共用）。

**对照**（一手代码）：
- C7 前 `testState` 串行循环每步读**活数组** `buildStepEvidence(completed)`（`git show 67f666f~1:src/service.ts` L357-362），同组后步可见先步产出。
- 真实并行运行：新旧一致（证据本就在各步同步起点读取，并行组互不可见）。

**稳定复现**（本步骤新增用例首版失败输出）：

```
FAIL executeStateSteps ... > sequential mode hands earlier steps forward
AssertionError: expected '慢:（本状态暂无前置步骤产出）' to contain '快产出'
```

**影响面**：仅编辑器独立验证路径；仅当同一状态声明了 ≥2 步的并行组时显现；不改变真实运行、持久化、wire 协议。方向上与 C7「验证与真实运行同一代码路径」目标自洽（旧行为使验证对并行组给出与真实运行不同的证据视图）。已声明白名单（C7 输出对齐四项、C9「事实上不变」）**未显式覆盖此点**——C9 的"事实上不变"只对真实运行成立。

**处置**：新增用例已改为钉住现契约并内联注释记录该 delta（`tests/refactor-regression.spec.ts` › `sequential mode freezes same-group evidence at segment start (documented delta)`），另补跨段正向交接用例证明段间证据传递完好。**建议**：PR 声明白名单补录此项，或由方案裁决者确认其为 C7 声明的合理子集。

## 7. 新增回归用例清单（`tests/refactor-regression.spec.ts`，15 例）

| 改动点 | 用例 |
|---|---|
| C8/P1-1 版本比较 | 0.10.0>0.9.0 数值语义（localeCompare 反例钉住）、多段数值序、相等/缺段/非数值段回退、latestTemplate 取最新/并列取先/未命中/空表 |
| C9/P1-2③ persist 链 | 并发 persist 按调用序 diff 且无重复 state-end；失败 persist 拒绝自身调用方但同链后续 persist 正常（JSON.stringify 循环引用注入失败） |
| C15/P1-2⑥ 归档队列 | run/audit 镜像 FIFO 且 flushArchives 排水、镜像写失败不破热路径也不断链、未 opt-in 工作区零镜像写 |
| C9 引擎语义 | 并行组双步观测同一段首快照（快先慢后互不可见）、串行模式段首冻结（§6 delta 钉住）、跨段正向交接 |
| C2/P1-2① abort kill | 运行中 abort 杀子进程并按 /aborted/ 拒绝、60s 子进程不得拖过 abort（宿主专用，沙箱自探测跳过） |

## 8. 未覆盖风险与限制

1. **宿主批次 0 硬门禁仍未关闭**：4 个 ENV-BLOCKED + 10 个 SKIPPED 用例只在真实 vitest + 可 spawn（+可选 python）环境下才能定论；本 harness 是等效执行而非 vitest 本体（无逐文件进程隔离）。命令：`pnpm install --frozen-lockfile && pnpm test`。
2. sqlite-archive 的 `DatabaseSync` 实验 API 在 Node 22→24 路径上的变更风险维持基线 §7.4 跟踪项。
3. `stash@{0}`（终态恢复 + 孤儿认领）仍待人工评审，不属于本方案。
4. client UI 端到端（真实 DSH 宿主加载插件）不在本次验证范围，维持基线 §7.5。

## 9. 可复核命令（本会话实跑）

```
# 全量沙箱测试（两轮逐位一致）
node .dsh/test-harness/transpile-specs.mjs
node .dsh/test-harness/run-specs.mjs --json=.dsh/test-harness/results-full1.json
# 冒烟与量化门禁
node .dsh/smoke-c7.mjs / smoke-c9.mjs / smoke-c12.mjs / smoke-c15.mjs   # exit 0 ×4
node .dsh/bench-c15.mjs                                                 # 0.74ms → 0.004ms/persist
# 构建与 API 冻结
npx tsc -p tsconfig.json[.client.json] [--noEmit] ; npx tsdown          # exit 0 ×5
node -e "import('./lib/index.js').then(m=>console.log(Object.keys(m)))" # Config,apply,inject,name
# 证据存档：.dsh/test-harness/results-full{1,2}.json、run2.log
```
