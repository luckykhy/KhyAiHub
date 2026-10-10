# GitHub 调研 — 终端渲染 / TUI / ANSI 规范板块 — 2026-09-17

> 每日板块轮转调研（索引 8/12）：khy-os 终端渲染板块（`services/backend/src/cli/tui/`，基于 ink 6.8.0 + React.createElement 桥接）对标 GitHub 开源终端 UI / 渲染框架，寻找可借鉴点。

## 调研对象

khy-os 终端渲染板块现状（`services/backend/src/cli/tui/`）：

| 组件 | 位置 | 机制 |
|---|---|---|
| ink 运行时桥接 | `inkRuntime.js` | 动态 `import('ink')`（ESM-only → CJS 单例缓存）+ `.jsx` 即 CommonJS 的 require 处理；内部 `instances.js` WeakMap 直连 |
| 备用缓冲区纪律 | `app.js` + `chromeBudget.js` | 1049h/1049l 进出、`frame ≤ rows-1` 硬约束（conpty pending-wrap -1 行）、单一定义 chrome 账本 |
| 回滚保留 | `scrollbackPreserve.js` | 4 层 stdout Proxy：剥 `3J`、win32 `ED2→H+J`、抑制 static 重发、活区尾切 rows-1 |
| 视口贴底 | `ink-components/Viewport.js` | `null` 贴底哨兵 + `resolveViewportOffset`/`applyStickyViewportAction` 纯叶子 |
| 滚轮接管 | `mouseButtons.js` | 备用缓冲区下强制接管滚轮（否则被合成为 ↑/↓ → 误触输入历史） |
| 节拍调优 | `perfTunables.js` | spinner/heartbeat/topicBar 节拍纯函数 + `INK_THROTTLE_MS=34` 镜像 |

**短板（5 条）**：

1. **16ms 帧预算未接入渲染主循环**：`AGENTS.md §0.3` 白纸黑字写了「单次渲染 <16ms」「冷启动 <100ms」，但渲染路径里**没有任何实测帧计时守卫**——ink 6.8.0 自带 `options.onRender?.({ renderTime })`（`ink.js:252` 已确认）却没被利用，超帧只是性能测试里偶发断言，没有滚动 p95 窗口 + 棘轮基线。
2. **缺 TUI 健康记分卡**：帧高 vs 账本、fps 窗口、内存趋势、备用缓冲区开关、回滚救援是否生效——散在 `KHY_TUI_DIAG_H` / `KHY_TUI_DIAG` 两个诊断开关里，没有一条只读命令能一次性读出。
3. **ink 内部实例解析失败时静默降级**：`inkRuntime.getInkInstance()` 靠直连 `instances.js` WeakMap（`_renderStdout` Proxy 作 key），内部布局一变就返回 `null`，调用方**默默退回** ink 内建 resize 行为（残线不修），无任何告警。
4. **无金帧/视觉回归测试**：现有 `viewportSticky` / `mouseWheel` 都是逻辑单测，没有「对渲染出的 ANSI 帧做快照 + 归一化 diff」的护栏。
5. **内存泄漏只有清单没有检测器**：AGENTS.md 列了「定时器/监听器必须清理」，但无自动化 weak-ref sweep / active-resources diff 守卫。

## 对标项目

| 项目 | Star（2026-09-17） | 技术栈 | 相关度 | 链接 |
|---|---|---|---|---|
| ink | ~39.9k | TS/React | 高：就是底座；`onRender({renderTime})`/`maxFps` 是现成集成面 | https://github.com/vadimdemedes/ink |
| bubbletea | ~45.0k | Go / Elm | 高：帧率上限 + 渲染/逻辑解耦 + 健康态显式降级（非静默） | https://github.com/charmbracelet/bubbletea |
| blessed-contrib | ~15.8k | JS | 中：Table 强制 columnWidth 前置校验 = chrome 账本该学的 fail-fast | https://github.com/yaronn/blessed-contrib |
| terminal-kit | ~3.4k | JS | 低：stream/TTY 分层参照，印证 scrollbackPreserve 单一 stdout 收口 | https://github.com/cronvel/terminal-kit |
| ink `test/helpers` (node-pty + reconstruct-terminal) | — | 随 ink | 高：金帧范式可直接搬 | https://github.com/vadimdemedes/ink/tree/main/test/helpers |

## 值得借鉴的点

### 1. 帧预算守卫接入 ink `onRender({renderTime})`（P0）

**对方怎么做**：ink `src/ink.tsx` 暴露 `options.onRender?: (metrics:{renderTime}) => void`（本机 6.8.0 `ink.js:252` 已确认 `this.options.onRender?.({ renderTime: performance.now() - startTime })`），`maxFps` 经 es-toolkit throttle 限流。bubbletea 把 FPS 上限当**渲染器级不变量**而非测试（`tea.go:1403` framerate ticker），超预算 = 告警而非「文档写了的地板」。

**khy-os 现状差在哪**：`app.js` 的 `render(...)` 没传 `onRender`；16ms 只是 AGENTS.md 纸面约束，渲染路径无实测。

**改哪些文件**：`app.js`（`render` 增 `onRender` 回调 → 滚动窗口 p95）+ 新增 `tui/frameBudget.js`（纯叶子：窗口 p50/p95/p99 + 超帧告警 + 棘轮基线读取）。

### 2. 内部实例解析失败的显式告警（P0）

**对方怎么做**：bubbletea `cursed_renderer.go`/`nil_renderer.go` —— 标准渲染器建不出来时用**具名降级实现** + 显式日志，绝不静默改行为；ink `instances.ts` 的 WeakMap 按 stream 作 key 是**稳定契约**而非易碎内部。

**khy-os 现状差在哪**：`inkRuntime.getInkInstance()` 返回 `null`（内部布局变化）时，`app.js` 的 resize 全重绘修复**静默失效**，残线回归无任何信号。

**改哪些文件**：`inkRuntime.js`（`getInkInstance` 加一次性降级告警 + 健康标志位），`app.js`（resize 分支据告警改走 SIGWINCH 兜底并打点）。

### 3. TUI 健康记分卡：一条只读命令聚合（P0/P1）

**对方怎么做**：bubbletea 把状态 `push` 进 model（`WithWindowSize`/ColorProfileMsg）且**只写 stderr/文件**（stdout 归 TUI 独占）；ink 的 `onRender` tick 天然可作记分卡心跳。

**khy-os 现状差在哪**：帧高/账本、fps、内存、备用缓冲区/回滚救援状态散在两个 DIAG 开关，无统一读视图。

**改哪些文件**：新增 `tui/healthScorecard.js`（纯叶子：聚合 `chromeBudget` 账本 + `frameBudget` 窗口 + 进程内存 + 安全网激活态，输出表格 / `--json`，默认写 stderr 不碰受管 stdout）+ 一个 `khy tui health` 入口（**不新增顶层目录/npm run 入口**，走既有 CLI router 或脚本目录）。

### 4. 金帧/ANSI 快照回归（P1）

**对方怎么做**：ink `test/helpers/reconstruct-terminal.ts` + node-pty，replay 只有 ink 真发的 CSI 序列还原**可见屏**（scrollback + viewport），对金帧归一化 diff；`atago`/`tuitest` 同款范式。

**khy-os 现状差在哪**：只有逻辑单测，无渲染输出快照护栏。

**改哪些文件**：新增 `tui/goldenFrames.js`（frame 归一化 + 快照 diff），CI 跑 `--leak-check`/golden 作业（P1 留后续）。

### 5. 内存泄漏 CI 检测器（P1）

**对方怎么做**：`@sinonjs/fake-timers` + `WeakRef` sweep + `process.getActiveResourcesInfo()` diff。

**khy-os 现状差在哪**：内存 <50MB 只是文档清单，无自动检测。

**改哪些文件**：新增 `tui/leakGuard.js`（P1 留后续）。

## 落地建议（排序）

| # | 行动 | 优先级 | 工作量 |
|---|---|---|---|
| 1 | 帧预算守卫：`app.js` 传 `onRender({renderTime})` → 新增 `tui/frameBudget.js` 纯叶子（滚动 p95 + 超帧告警 + 棘轮基线） | P0 | 半天 |
| 2 | 内部实例解析失败显式告警：`inkRuntime.getInkInstance` 加一次性降级告警 + 健康标志 | P0 | 1 小时 |
| 3 | TUI 健康记分卡：新增 `tui/healthScorecard.js`（聚合账本+帧窗口+内存+安全网，表格/--json，写 stderr） | P1（P0 不足 3 条补位） | 半天 |
| 4 | 金帧/ANSI 快照回归 `goldenFrames.js` | P1 | 1 天 |
| 5 | 内存泄漏检测器 `leakGuard.js` | P1 | 半天 |

## 参考链接

- https://github.com/vadimdemedes/ink — `src/ink.tsx` `onRender({renderTime})` + `maxFps`、`test/helpers/reconstruct-terminal.ts`、`src/instances.ts`
- https://github.com/charmbracelet/bubbletea — `tea.go` framerate ticker、`options.go WithFPS`、`cursed_renderer.go`/`nil_renderer.go` 显式降级
- https://github.com/yaronn/blessed-contrib — `lib/widget/table.js` 前置列宽校验
- https://github.com/cronvel/terminal-kit — stream/TTY 分层
- https://github.com/nao1215/atago / https://github.com/Gaurav-Gosain/tuitest — PTY 金帧 + 确定性等待范式

## 落地记录

> 本轮落地 3 项（P0×2 + P0 补位×1）；第 4、5 项（P1）留后续。
> 全程遵守工程红线：零硬编码、纯叶子零 IO、stderr-only（stdout 归 TUI 独占）、无固定硬超时、无滚动区转义。

### P0-1 帧预算守卫（已实现）

- 新增 `services/backend/src/cli/tui/frameBudget.js`（纯叶子，零 IO，`createGuard` 滚动窗口 p50/p95/p99/max + 一次性超帧告警 `maybeWarn` + `reset`）。
- `perfTunables.js` 增 `frameBudgetMs`（SSOT，默认 16ms，env `KHY_TUI_FRAME_BUDGET_MS` 可覆盖）——补上「16ms 地板」单一真源。
- `app.js`：`render(...)` 增 `onRender: (m) => frameGuard.record(m?.renderTime ?? 0)`，接入 ink 6.8.0 现成的 `onRender({renderTime})`（`ink.js:252`）；守卫门控 `KHY_TUI_FRAME_BUDGET`（默认开）。
- 新增测试 `services/backend/tests/cli/tui/frameBudget.test.js`（8 条，`node --test` 全绿）。

### P0-2 内部实例解析失败显式告警（已实现）

- `inkRuntime.js`：`getInkInstance()` 内部 WeakMap 解析失败时不再静默降级——置位 `_instanceLookupDegraded` 并发一次性 stderr 告警（门控 `KHY_TUI_INSTANCE_WARN`，默认开），并导出 `isInstanceLookupDegraded()` 供记分卡 / 测试读取。

### P0-3 TUI 健康记分卡（已实现，P0 补位）

- 新增 `services/backend/src/cli/tui/healthScorecard.js`（纯叶子，只读）：聚合 `chromeBudget` 账本（H1 不变式）+ `frameBudget` 窗口 + `inkRuntime` 实例解析态 + 各安全网 env 激活态 + 进程内存快照；`renderTable()`（stderr-ready 字符串）/ `toJSON()`（机器读）两个出口，本模块自身**绝不写 stdout**。
- CLI 入口（`khy tui health`）留后续，走既有 router，不新增 npm run 入口。

### 校验结果

| 检查 | 结果 |
|---|---|
| `node --test services/backend/tests/cli/tui/frameBudget.test.js` | 8/8 通过 |
| `node scripts/run-ink-tui-tests.js` | 29/29 套件、435 条测试通过 |
| `node scripts/ci/check-agent-rules.js`（改动 5 源文件 + 1 测试） | 零违规（零硬编码 / 无含糊状态 / 无固定硬超时 / 无滚动区 / 无死循环） |

### 未实现项（P1，留后续）

| 项 | 说明 | 阻塞点 |
|---|---|---|
| ~~金帧 / ANSI 快照回归 `goldenFrames.js`~~ | **已于 2026-10-10 落地**（见补记二） | 已闭合 |
| ~~内存泄漏 CI 检测器 `leakGuard.js`~~ | **已于 2026-10-10 落地并挂 CI**（见补记二、三） | 已闭合 |
| ~~`khy tui health` CLI 入口~~ | **已于 2026-10-10 落地为 `khy health tui`**（见下） | 已闭合 |

### 后续落地补记（2026-10-10）：`khy health tui` 入口闭合

> 接线点选择：**未**新增顶层命令 `khy tui`——`ROUTER_COMMANDS` 棘轮已在 breach（246/245），
> 「加一个先退役一个」是人的决定；改走既有 `health` 命令的**子命令** `khy health tui`
> （零棘轮影响：不加 ROUTER_COMMANDS 条目、不加 aliases 条目、不加 handler 文件），
> 语义同族（系统健康体检 → TUI 子系统健康）。经 commandAutoRegistry 的 `_alignSubCommand`
> 自动对齐（manifest 已声明 `subCommands: ['tui']`），router.js 零改动。

- `runtime/node/backend/src/cli/handlers/health.js`：`handleHealth` 增子命令分派（`subCommand === 'tui'` 或首位置参数）→ 新增 `_renderTuiHealth`：调 `healthScorecard.build/renderTable/toJSON`（module 仍零写，本 handler 作为调用方选 stdout 为 sink——一次性命令独占终端，可管道）；`frameGuard` 恒传 null（帧数据活在 TUI 进程守卫闭包内，跨进程不可达是架构事实；活动会话走 `KHY_TUI_DIAG_FRAME` stderr 诊断）；inkRuntime require 失败 → 传 null（fail-soft）。**出口码只对真信号非零**：`instance.degraded`（残线修复失效风险）→ exit 1；H1/帧段无 TTY 时是环境性读数，只展示不判红。manifest 登记 `subCommands: ['tui']` + usage 更新。
- `runtime/node/backend/src/constants/commandSchema.js`：`ROUTER_SUB_COMMANDS.health = ['tui']`（子命令注册表，非四棘轮计数面）。
- `runtime/node/backend/src/cli/tui/healthScorecard.js`：H1 人类显示改**三态**——rows=0（无 TTY/管道）时显示「无法判定（无 TTY 几何）」而非「不成立」；把环境性读数误报成故障是误导（RUNTIME-002 状态透明）。
- 顺带核对：P0-1 的 app.js 接线已被 [DESIGN-ARCH-176]（2026-10-03）演进为 `frameBudgetWiring.buildInkRenderOpts`（修复了 ink 实例复用吞 onRender 的陷阱），`frameBudgetMs` SSOT 与本报告设计一致。

**校验结果（2026-10-10）**

| 检查 | 结果 |
|---|---|
| `khy health tui`（端到端，bin/khy.js） | ✓ 记分卡表格（几何/chrome 账本/帧预算/实例解析/安全网/内存），H1 无 TTY 时如实「无法判定」 |
| `khy health tui --json`（端到端） | ✓ JSON 可解析（`geometry/instance/safetyNets/heap` 全字段） |
| `khy health`（缺省，端到端） | ✓ 行为不变（全系统体检 7 项全绿，未被子命令分支影响） |
| `node --test …/tests/cli/tui/{chromeBudget,frameBudget,perfTunables}.test.js` | 49/49 通过 |
| `node scripts/ci/check-agent-rules.js`（3 改动文件） | 零违规 |
| `node scripts/ci/check-delivery-baseline.js` 棘轮读数 | 与改动前逐字一致（routerCommands=246/245 · aliasEntries=591/591 · handlerFiles=158/155 · ruleCount=96/94）——零新增突破 |

### 后续落地补记二（2026-10-10）：金帧回归 + 泄漏检测（P1-4 / P1-5 全部闭合）

> 两条 P1 的原始设想都挂「PTK/CI 基建」作阻塞点（node-pty 依赖、`--expose-gc` 作业）。
> 本轮核实测试树后改了落点：视觉测试现状是**源码正则断言**（`bootScreenVisual.test.js`
> 头注释明言 CI 不挂 ink 渲染），故金帧不覆盖 ink 渲染端，改覆盖渲染管线的另一端——
> **scrollbackPreserve 四层 ANSI 变换**（3J 剥离 / ED2→H+J 改写 / 冗余重发抑制 / 尾切）。
> 它是全 TUI 最精密的变换、纯文本进出、完全确定性，字节级金帧零 PTY 即可；泄漏检测
> 同理，`process.getActiveResourcesInfo()`（Node ≥17.3 无 flag）+ WeakRef 分拣覆盖
> 可确定性断言的部分，`--expose-gc` 端到端作业留作后续挂点（契约写在测试头注释）。

- 新增 `runtime/node/backend/src/cli/tui/goldenFrames.js`（纯叶子）：`escapeVisible`/`fromVisible`（ESC ↔ 四字面转义，金帧文件存可 diff 文本，沿用本仓「不嵌字面 ESC 字节」纪律）；`diffFrames`（行级 diff，限前 12 行明细）；`matchGolden`（缺失→指路 `KHY_GOLDEN_UPDATE=1`；更新→须人工看 diff 再提交；比较路径零写）。
- 新增 `runtime/node/backend/tests/cli/tui/goldenFrames.test.js`（9 条）+ `tests/cli/tui/goldens/` 7 个基线（linux 剥 3J / win32 现代帧 H+J / 老 conhost 帧 / 重发剥离留尾 / 尾切 rows=5 / 跨 write 拼装 / 门控关逐字节回退）——基线内容已人工核对，语义与 scrollbackPreserve 头注释的实测场景一一对应。
- 新增 `runtime/node/backend/src/cli/tui/leakGuard.js`（纯叶子）：`snapshotResources`（活动资源按类型分组）+ `diffResources`（净增=疑似泄漏/净减=已释放，结构性判读不做绝对字节数地板）+ `createSweep`（WeakRef 登记表；`global.gc` 缺失时如实报 `gcUnavailable`，诚实跳过不假装测过）+ `renderDiff`。
- 新增 `runtime/node/backend/tests/cli/tui/leakGuard.test.js`（9 条：diff 算术 / 新增类型 / fail-soft / gc 不可用诚实路径 / 非对象静默忽略）。
- 实战验证（一次性脚本，已清理）：泄漏 4 个 interval + 1 个已清 timeout → `Timeout +5` 被抓到；清理后 diff 归零（clean）。

**校验结果（2026-10-10）**

| 检查 | 结果 |
|---|---|
| `node --test …/tests/cli/tui/{goldenFrames,leakGuard,scrollbackPreserve,frameBudget}.test.js` | **46/46 通过** |
| `KHY_GOLDEN_UPDATE=1` 首跑生成基线 → 无更新复跑 | 9/9 通过（diff 干净） |
| 泄漏实战脚本（4 interval 泄漏 → 抓到；清理 → 归零） | 3/3 通过 |
| `node scripts/ci/check-agent-rules.js`（4 新文件） | 零违规 |

### 接线补记三（2026-10-10，人工点头）：TUI 泄漏检测挂 CI（`--expose-gc`）

> 落点选择：泄漏检测按 PROCESS-008（新拦截机制从 S1 观察者起步）放进 **report-only 的
> Test baseline 作业**（已登记的测试债务位）——只记录不阻断 + 输出进 test-evidence
> artifact（「非阻断不等于无证据」），不进阻断的 contract-checks 作业（那等于新机制直进 S3）。

- `.github/workflows/pr-gate.yml` Test baseline 作业：`Node built-in tests` 之后新增
  **`TUI leak check (--expose-gc)`** 步骤（`node --expose-gc --test tests/cli/tui/leakGuard.test.js`，
  continue-on-error 随作业）——`--expose-gc` 让 WeakRef sweep 走「强制 GC 后分拣」的真路径；
  输出并入 `Record test evidence` 的 GITHUB_STEP_SUMMARY 与 `test-evidence` artifact
  （`/tmp/leak.log` + `/tmp/leak.status`）。
- `leakGuard.test.js`：`--expose-gc` 下暴露一处断言对 V8 GC 时机过强（强制 gc 不保证
  一次就回收刚丢引用的新生代对象）——断言改「分拣结构完整（collected + retained =
  登记总数）+ retained 条目带理由」，不再断言「必然已回收」（CI 随机红根除）。

**校验结果**：`node --expose-gc --test` 与常规运行时下均 **9/9**；`check-workflow-sanity.js`
0 error；`check-gov-rules.js` / `check-wiring.js`（106 检查器全部接线）全绿；棘轮读数与改动前一致。
