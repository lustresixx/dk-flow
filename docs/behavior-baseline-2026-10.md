# 行为基线报告（改造前锚点）

> 目的：在调度流畅性 / 上下文衔接 / 稳定性 / 代码结构 / 用户体验改造开始前，
> 记录现有测试、构建、检查与运行时行为基线，作为"不破坏功能、公开 API 不变"的对照锚点。
> 原则：如实记录——基线本身有问题（含环境限制导致无法执行的项）也如实报告。

## 1. 基线锚点（Baseline Anchor）

| 项 | 值 |
|---|---|
| 记录日期 | 2026-10（本会话） |
| Git HEAD | `dc7f25685513690962bf5b39fbaeeab9b1fb2f85`（branch: main） |
| 工作树状态 | **非干净**（dirty）：`M src/index.ts`、`M src/service.ts`、`M templates/architecture-refactor-review.yaml`，未跟踪 `.dsh/`、`docs/architecture-diagnosis-2026-10.md`、`docs/architecture-patterns-benchmark-2026-10.md` |
| 重要说明 | 本基线在 **dirty 工作树**上测量。后续对照必须基于同一 HEAD + 相同脏改，或先由批次 0 明确提交/还原策略 |
| 执行身份 | DSH 委派子代理（defender），文件策略 workspace-write，审批提示禁用 |

## 2. 环境（Environment）

| 项 | 值 |
|---|---|
| OS | Microsoft Windows NT 10.0.26200.0（Windows 11） |
| CPU | AMD64 Family 25 Model 97 Stepping 2，32 逻辑核 |
| 内存 | 总量 64,734 MB，可用 39,280 MB（node `os` 模块实测；WMI/CIM 在沙箱下拒绝访问） |
| Node | v22.15.0（V8 12.4.254.21-node.24，win32 x64）；engines 要求 `^22.0.0 \|\| >=24.0.0` ✅ |
| npm | 11.14.1；包管理 pnpm（pnpm-lock.yaml） |
| PowerShell | 5.1.26100.9168（宿主 pwsh 调用） |
| TypeScript | ^5.9.2（devDeps）；vitest ^3.2.4；vite 7.3.6；esbuild 0.28.2；tsdown 0.22.2 |

## 3. 测试基线（Test Baseline）

### 3.1 测试资产盘点（静态，已实测）

- 配置：`vitest.config.ts`，`environment: 'node'`，`include: ['tests/**/*.spec.ts']`
- 规格文件：**28 个** `tests/*.spec.ts`
- 测试用例总数：**209 个**（按 `^\s*(it|test)\(` 逐文件计数，见下表）

| 规格文件 | 用例数 | 规格文件 | 用例数 |
|---|---:|---|---:|
| runner.spec.ts | 25 | verdict.spec.ts | 11 |
| script-file-runner.spec.ts | 17 | workflow-model.client.spec.ts | 10 |
| script-runner.spec.ts | 15 | sqlite-archive.spec.ts | 10 |
| transitions.spec.ts | 15 | params-dialog.spec.ts | 9 |
| load.spec.ts | 12 | catalog.spec.ts | 8 |
| run-selection.spec.ts | 12 | pre-commands.spec.ts | 7 |
| json-pointer.spec.ts | 6 | tool-filter.spec.ts | 5 |
| prompts.spec.ts | 5 | 其余 12 个文件 | 各 1–4 |

### 3.2 ⚠️ 测试执行结果：**本沙箱内无法运行，非测试本身失败**

执行命令与实测输出：

```
$ npx vitest run --reporter=basic
exit=1, elapsed=1.1s
Startup Error: failed to load config from vitest.config.ts
Error: spawn EPERM
  at ensureServiceIsRunning (esbuild@0.28.2/lib/main.js:2272:29)
  at bundleConfigFile (vite@7.3.6/.../config.js:35895)
  errno: -4048, code: 'EPERM', syscall: 'spawn'
```

根因分析（一手实测证据，三层全部验证）：

1. **esbuild 异步 API 必走子进程**：vite 7 加载任意配置文件（含 `.mjs`）都经 `bundleConfigFile` → esbuild 异步 `build()` → `child_process.spawn(esbuild 二进制, stdio: pipe)`。DSH 沙箱禁止程序间管道（named pipe），spawn 返回 EPERM。
2. **worker_threads 不是逃逸路径**：实测沙箱内 `worker_threads` 可正常创建（`new Worker(eval)` exit 0）；esbuild 仅 **Sync API**（transformSync/buildSync 等）走 worker 线程，异步 `build()` 无该分支（main.js:2269-2276 实证）。临时改用 `vitest.config.mjs` + `--pool=threads` 复测仍在同一 spawn EPERM 处失败（exit=1, 1.1s），临时文件已删除。
3. **vitest forks 池同样被禁**：即使绕过配置层，默认 `pool: 'forks'`（tinypool fork 子进程 + 管道 stdio）必 EPERM；且 TS 测试文件转换经 vite `transformWithEsbuild`（异步）→ 同样 spawn EPERM。三层叠加，沙箱内不存在可行路径。

**结论**：28 spec / 209 用例的通过情况为 **未知（UNMEASURED）**，不是失败。此前状态（架构诊断）已如实记录同一限制。这与方案定稿"批次 0 宿主测试基线门禁"完全对应——**宿主侧复跑是放行改造的前置硬门禁**。

宿主复跑建议命令（未经沙箱限制的环境）：

```
pnpm install --frozen-lockfile
pnpm test            # 期望输出 28 个 spec 文件、209 个用例的 pass/fail 明细与耗时
```

## 4. 构建 / 检查基线（全部通过 ✅）

| 命令 | 结果 | 耗时（本会话实测） |
|---|---|---|
| `npx tsc -p tsconfig.json --noEmit` | exit 0 | 3.1s |
| `npx tsc -p tsconfig.client.json --noEmit` | exit 0 | 2.6s |
| `npx tsc -p tsconfig.json`（host build） | exit 0 | 2.3s |
| `npx tsc -p tsconfig.client.json`（client types） | exit 0 | 2.4s |
| `npx tsdown`（client bundle） | exit 0 | 1.2s（tsdown 自报 226ms 打包） |
| 合计 `pnpm build` 等价链路 | **exit 0 × 3** | ≈ 5.9s |

构建产物（lib/，128 个文件，共 ≈ 3,422.7 KB）：

- `lib/client.js` 948.7 KB（gzip 208.85 kB）+ sourcemap 1,634.2 KB
- `lib/service.js` 71.6 KB、`lib/index.js` 42.1 KB、`lib/commands.js` 19.1 KB、`lib/tools.js` 14.9 KB、`lib/params-dialog.js` 4.0 KB 及对应 `.d.ts`/`.map`

> 对照锚点：改造后同机重跑上述 5 条命令，exit code 必须全 0；bundle 体积变化应可解释（纯结构移动预期 ±1% 以内）。

## 5. 公开 API 基线（机器实测导出面）

`node -e "import('./lib/index.js')"` 实测（exit 0）：

- **host 导出（4 个）**：`Config`, `apply`, `inject`, `name`
- 导入时 stderr 输出 `ExperimentalWarning: SQLite is an experimental feature`（host 使用 `node:sqlite`，Node 22.15 下为实验特性；改造涉及 sqlite-archive 时须保持该行为可预期）
- **client bundle（`lib/client.js`）**：纯 Node 导入报 `window is not defined`（exit 1）——**预期行为**，bundle 目标为 web 平台（`dsh.client.platform: "web"`），需 DOM 环境；不作为缺陷。client 端类型导出面以 `lib/client/index.d.ts` 为准。

> 对照锚点：改造后 host 导出键集合必须逐字段等于 `{Config, apply, inject, name}`；client bundle 仍应仅在 DOM 环境下可用。

## 6. 性能基线（可测项）

| 指标 | 基线值 | 测量方式 |
|---|---|---|
| typecheck 双工程 | 5.7s（3.1 + 2.6） | Stopwatch 实测 |
| 完整构建（tsc×2 + tsdown） | ≈ 5.9s | Stopwatch 实测 |
| tsdown 打包 | 226ms | tsdown 自报 |
| host lib 冷导入 | exit 0，< 1s（含 sqlite 实验警告） | node 动态 import |
| 测试套件耗时 / 峰值内存 | **未测得**（沙箱限制，见 §3.2） | 待宿主批次 0 补测 |

## 7. 已知风险与限制（放行前必读）

1. **[阻断性环境限制]** 沙箱 EPERM 导致 vitest 完全无法执行（§3.2）。**209 用例的真实通过状态未知**，这是本基线最大的诚实缺口。改造放行前必须由宿主在批次 0 跑通 `pnpm test` 并留存输出，否则"全部测试通过"约束无对照可言。
2. **[基线非干净树]** 测量时工作树含 3 处未提交修改（§1）。若这些改动后续被还原或改写，本基线的 src 层事实（如 lib 产物体积）需重新校准。
3. **[WMI 不可用]** 系统内存/CPU 信息经 node `os` 模块取得，WMI 查询在沙箱被拒——非项目问题。
4. **[未覆盖项]** 手工/端到端验证（真实 DSH 宿主内加载插件、client UI 交互）不在本基线范围；sqlite 实验性 API 在 Node 22→24 升级路径上有变更风险，属跟踪项。
5. **[client bundle 无 Node 冒烟]** 属预期（web 平台），但意味着 client 行为基线只能由 `client-bundle.client.spec.ts`（1 用例）+ `workflow-model.client.spec.ts`（10 用例）承担，同样依赖批次 0 宿主复跑。

## 8. 对照使用方式（改造期检查清单）

- [ ] 批次 0（宿主）：`pnpm test` 全绿并记录 209 用例耗时 → 补全 §3.2 与 §6 缺口
- [ ] 每批次改造后：§4 五条命令 exit 全 0
- [ ] 每批次改造后：§5 host 导出集合不变；client bundle 体积与行为可解释
- [ ] 批次 3（行为修正）前后：逐 spec 对比耗时，回归阈值建议 ±20% 内或逐项解释
