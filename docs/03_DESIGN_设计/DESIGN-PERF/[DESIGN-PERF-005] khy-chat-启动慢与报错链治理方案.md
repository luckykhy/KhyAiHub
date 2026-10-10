<!-- IMPL-STATUS: done -->
# [DESIGN-PERF-005] khy chat 启动慢与报错链治理方案

> **状态**：提案（未接线） · **日期**：2026-10-01 · **编号**：[DESIGN-PERF-005] · **落点目录**：`docs/03_DESIGN_设计/DESIGN-PERF/`
> **适用层**：`services/backend`（`ai-manage-daemon.js` + `server.js` + `khy chat` 等待预算）
> **证据基准**：全部 `文件:行号` 与数字为 **2026-10-01 本机实测**（仓库 `D:\Portable\khy-os`，Windows，Node v22.22.2）。凡推测项显式标注「**【推测】**」。
> **关联**：[DESIGN-PERF-003] TUI 启动阻塞治理方案 · [DESIGN-PERF-004] TUI 动画节拍治理方案 · [DESIGN-ARCH-115] TUI 启动板块设计（节拍真源） · [DESIGN-ARCH-169] khychat 启动假阴性（就绪信号后置）

---

## 零、一句话结论

用户报的三件事（**慢 / 报错 / 动画不好看**）是**三个独立缺陷**，根因不在一处，但**都收敛在同一条启动链上**：

| 用户感知 | 真根因 | 关键判据 |
|---|---|---|
| **慢**（约 90s 卡在 83%） | 管理台 **web 后端（`server.js`）冷启动 initDatabase ~90s**，而它**串在 daemon 链上**；`khy chat` 的等待预算跑不满它 | 日志 `09:51:30 启动 Web 后端` → `09:53:02 已就绪` = **92s**；`WEB_BACKEND_WAIT_MS=120_000` vs CLI 预算 `180_000`（余额仅 88s） |
| **报错**（MCP 超时 + 守护自杀） | ① `deepseek-eyes` 是**可选**工具（`python -m deepseek_eyes`），冷启偶发 >30s 被硬超时；② 守护的 `startup-timeout` **标签名不副实** —— 实为「启动宽限 600s 内零会话」，**与启动快慢无关** | `.khy/mcp.json` 定义；`mcp/index.js:448` 硬超时；`ai-manage-daemon.js:986-990` 判定分支 |
| **动画不好看** | 进度条百分比的**时间模型已改对（`percentAt` 平滑），但渲染节拍仍是 250ms 离散重画 + spinner 80ms**；且 ink **首帧渲染期整块阻塞主线程**，期间任何渲染器都动不了 | `bootPhaseLine.js:55` `PERCENT_TICK_MS=250`；`BootScreen.js:56` `FRAME_MS=80`；`app.js:345-368` 的两段 render |

> **核心判断**：**这三件事不该由「启动链并行化」治** —— 那是大改。**最小代价的最高收益是两刀**：
> **(A) 把 `server.js` 的非关键后台初始化移出健康判据**（让 web 后端 ~1s 就 `/api/health` 200），
> **(B) 把 MCP 自动连接与守护存活彻底解耦**。
> 动画（C）是独立的观感项，可单独立项，**与 A/B 无依赖**。

---

## 一、现状实证（可复核）

### 1.1 实测时间线（2026-10-01，本机，日志 `.khy/logs/ai_manage_daemon.log` + `web_backend.log`）

| 时刻 | 事件 | 证据 |
|---|---|---|
| 09:51:30 | `启动 Web 后端 (server.js)：端口 3000，等待 /api/health 就绪…` | daemon log L488 |
| 09:53:02 | `Web 后端已就绪: http://127.0.0.1:3000` | daemon log L489；`web_backend.log` 同刻 `GET /api/health 200 22ms` |
| **Δ = 92s** | 这段窗口 daemon **完全卡住**，`khy chat` 的进度条停在最后一拍 | 对照用户截图：83% 冻结 |
| 09:53:35 | `[MCP] [0/1 0.0%] 连接 deepseek-eyes...` | daemon log L491 |
| 09:54:03 | `[MCP] [1/1 100.0%] ✓ deepseek-eyes` | daemon log L492 —— **本轮成功，但耗时 28s（贴着 30s 上限）** |
| 历史轮 | `✗ MCP server "deepseek-eyes" connection timed out after 30000ms` | 用户截图 + 历史 log 多轮 |
| 历史轮 | `正在关闭守护进程: 原因=startup-timeout 无活动=603616ms 阈值=600000ms 曾见会话=false` | 用户截图 + log |

### 1.2 代码事实（file:line 可复核）

| # | 事实 | 依据 |
|---|---|---|
| 1 | `server.js` 在 **listen 后**才做后台初始化，但 **立刻再 await `initDatabase()`** —— 该 await **位于同一个 IIFE 内、`listen` 之后**，因此 HTTP 虽已监听，`/api/health` 若等 DB 就绪则被测不到 | `server.js:784-799`（listen + `服务器已就绪，后台初始化中...`）→ `:864` `sequelize = await initDatabase()` |
| 2 | 后台初始化里**大量串行 await**：`runAutoDbMigration` → `sequelize.sync` → `ensureDefaultAdmin` → `seedChannelApis`，之后 8 个 `(async()=>{})()` **未 await** | `server.js:885-900`、`:1040-1051`、`:1156-1184`、`:1144`（`后台初始化完成 (Xs)` 计时） |
| 3 | 标的同步 `syncInstrumentsFromAData()` 确实调 **AKShare / Python**，实测耗时 **29s**（09:53:02 → 09:53:31） | `server.js:1173-1183`；`web_backend.log` 时间戳 |
| 4 | daemon 等待 web 后端 **120s 上限**，且**有界**、超时只回退不硬杀 | `ai-manage-daemon.js:669` `WEB_BACKEND_WAIT_MS = 120_000`，`:695-700` |
| 5 | daemon 启动链**串行**：web 后端 → API `start()` → workflow-worker → 前端 → 控制面 bind → runtime 写入 | `ai-manage-daemon.js:968-1096`（同 [DESIGN-ARCH-169] §1.2） |
| 6 | `khy chat` 就绪预算 **180s**，失败分支打印通用「失败或超时」+ 日志尾 5 行 | `gatewayManageDaemon.js:36-39`、`:1436-1461` |
| 7 | MCP 每 server 硬超时 **30s**（`DEFAULT_CONNECT_TIMEOUT_MS`），无整段墙钟上限、**不阻塞 `start()`** | `mcp/index.js:119,446-450`；`aiManagementServer.js:3445-3454`（`resolve` 先行） |
| 8 | MCP 配置真源 `.khy/mcp.json`：`{"type":"stdio","command":"python","args":["-m","deepseek_eyes"]}` —— **可选工具，非启动依赖** | 实测读取 |
| 9 | 守护两种自关闭：`seenAnySession ? 'idle' : 'startup-timeout'`，阈值各 **600s**；`startup-timeout` 的实际含义是「启动宽限内零会话」 | `ai-manage-daemon.js:110,112,986-990` |
| 10 | **另有一个独立看门狗**（300s，`phase !== ready` 时自杀，reason=`startup-watchdog`）与上述 GC 自杀是**两个不同机制** | `ai-manage-daemon.js:153,259-292` |
| 11 | 静态 require 图已优化到位：`require(replSession)` **206ms**，且 **winston / ink 均未被 eager 拉入** | §1.3 探针（本次实测） |
| 12 | **ink 冷加载 ≈ 1.02~1.08s**（ESM 图） | §1.3 探针 |
| 13 | 进度条时间模型**已实现**平滑插值（`percentAt` + ramp/creep/guard），但**重画节拍 250ms**、spinner **80ms** | `startupBeats.js:164-178`；`bootPhaseLine.js:55`；`BootScreen.js:56` |
| 14 | `App.js` 首帧渲染**同步阻塞主线程**（结构性），期间所有渲染器不可动 —— 已在代码注释中记录 | `app.js:345-368` 注释；[DESIGN-PERF-003] §零实测 2.0–16.3s |

### 1.3 本次实测的「结构事实」探针输出（判据，非耗时）

探针：临时 hook `Module.prototype.require`，检查 ReplSession 启动图中是否出现重依赖。

```
require(commandAutoRegistry)  =   2.9ms
require(replSession)          = 206.2ms
winstonEagerlyLoaded          = false      ← 【判据】winston 未被 eager 拉入
inkLoadedDuringRepl           = false      ← 【判据】ink 未在 replSession 图内
inkColdTouchMs                = 1020~1080ms（ESM 动态 import）
appModuleLoadMs               = 434.5ms
```

**结论**：**「启动慢」不能归因于 require 图**。本次实测 `khy version` 3 轮 **1937 / 3006 / 3807ms**（方差极大，含 Python launcher ~600-1200ms），`khy chat` **3087~9167ms** —— 即 **CLI 自身在 3~9s 内走完**，而用户感知的「慢」是**之后**卡在 daemon 段（92s + 28s MCP）。

> **测量方法论声明**（沿用 [DESIGN-PERF-003]）：本机耗时抖动极大（同配置 394~939ms），故本文**以「结构事实」为主判据**（布尔量），耗时仅作参考并标注方差。

---

## 二、与既有文档的关系（不是重复劳动）

| 文档 | 已覆盖 | 本文的增量 |
|---|---|---|
| [DESIGN-PERF-002] / 交互流畅度修复方案 | 阶段 A 打 bundle / B `KHY_FAST_STARTUP` / C 顶层 require 瘦身 / D 首 token 解耦 | 那是 **CLI 进程内**的 require 与首 token。**本文 §1.3 实测证明那一段已无大改善空间**（winston/ink 均已惰性） |
| [DESIGN-PERF-003] TUI 启动阻塞治理方案 | 首帧期同步 IO（B1–B4）、`render()` 阻塞 2.0–16.3s | 那是**首帧之前/之内**的阻塞。**本文的 92s 发生在首帧之后**，是**另一条进程（daemon → server.js）**的账 |
| [DESIGN-PERF-004] TUI 动画节拍治理方案 | **运行期**动画节拍（`perfTunables` 降频、渲染体同步扫盘） | 那是**主界面跑起来之后**的帧节拍。**本文 §5 处理的是「启动屏」这一段**（`bootPhaseLine` / `BootScreen`），两者时间窗不重叠 |
| [DESIGN-ARCH-169] khychat 启动假阴性 | 就绪信号后置、预算 206s > 180s、守护僵尸化（**已实施**） | 169 治的是「**假阴性**」（daemon 其实健康但 CLI 报失败）。**本文治的是「真慢」** —— daemon 真的花了 92s+28s，与 169 互补不重叠 |
| [DESIGN-ARCH-115] TUI 启动板块设计 | 六拍节拍表、`startupBeats.js` 真源 | 节拍表**结构正确**。本文补的是「**run 拍里的真实工作量为什么是 92s**」 |

**检索结论**：`DESIGN-PERF/` 下 001–004 均**未覆盖「daemon 段 web 后端冷启 ~90s」**，`DESIGN-ARCH/` 下 169 覆盖的是假阴性而非真慢。**这是真空白。**

---

## 三、目标形态

### 3.1 病灶 1（慢）：web 后端「就绪」判据与「后台初始化」解耦

> ## ⛔ 实施阶段更正（2026-10-01）：本节假设 **已被证伪**
>
> 本节原文把 92s 归因为「DB / 后台初始化挡住 health 端点」。**A0 探针实测推翻了它**：
>
> ```
> initDatabase()             =    82ms   ← 不是它
> AKShare 标注同步            =  3100ms   ← 不是它（方案 §1.2 事实 3 的 29s 是本机冷启噪声/口径差）
> require(instrumentService) = 45920ms   ← 【真凶，占 92s 的一半】
> ```
>
> **真根因链**（file:line 可复核）：
>
> `server.js` 后台初始化 → eager `require` → `domain/extensions/.../quantApp.loadModule(...)`
> → `software/khyquant/services/instrumentService.js:6` `require('./pythonDataSourceService')`
> → `pythonDataSourceService.js:629` `module.exports = new PythonDataSourceService()`
> ⇒ **模块加载即构造** ⇒ 构造函数调 `findPython()`
> ⇒ `utils/pythonPath.js:202`（`canRunPython`）对每个候选 `execSync` spawn 一次 python
> ⇒ 本机单次 `python -c "pass"` 实测 **3.8–7.8s**（Defender 扫描税）
> ⇒ 多候选累加 = **45.9s 白等**，且与业务毫无关系。
>
> **实际修法**（与本节的 health/ready 解耦**不同**，见 §10 实施记录）：
> 1. `pythonPath.js`：`canRunPython` 加 fast-path（绝对路径 + 文件存在 → 采信，不 spawn），
>    开关 `KHY_PYTHON_TRUST_PATH`（默认开）。
> 2. 三个 service 的 `pythonPath` 改**惰性 getter**，模块级 `new` 改懒 Proxy。
>
> **本节的 health/ready 解耦仍然有价值、但降级为「次要」**：它治的是「daemon 等业务级判据」，
> 而实测 `listen` 后约 8.3s 就已 `服务器已就绪`，真正的 45.9s 在 `listen` **之前**的模块加载里 ——
> 也就是说**即使把 health 解耦做满，不改 python 解析时机，92s 仍有 ~46s**。
> 详见 §10：`/api/ready` 已按本节设计落地（保留语义分离），但主收益来自根因修复。

**现状病灶**：`/api/health` 的语义被后台初始化绑架 —— daemon 的 `probeWebBackendHealth` 探测的是「后台初始化是否完成」而非「服务是否可服务」。

> ⚠ **诚实边界**：`server.js:784-799` 显示 `listen()` 在后台初始化**之前**、并已打印「服务器已就绪，后台初始化中...」。因此**代码层面 listen 确实先行**；但**实测 `/api/health` 直到 09:53:02 才返回 200**（`web_backend.log`），说明健康端点**实际等到了后台初始化完成**（或其 handler 依赖了尚未就绪的 DB/sequelize）。**具体卡点已在实施阶段用探针钉死**（见上「实施阶段更正」与 §10）。

**目标形态**：

```
web_server（server.js）：
  listen()                       → 立即 /api/health 返回 200 {status:'ok'}      ← 只反映「进程活着 + 路由挂载」
  /api/ready                     → 200 需 DB 就绪 + 迁移完成                    ← 新增，反映「可承载业务」
  后台初始化（DB/迁移/种子/AKShare）→ 全部 fire-and-forget，不阻塞上述两个端点

daemon（ai-manage-daemon.js）：
  等待 web 后端用 /api/health（快，~1s）→ 不再用业务级判据
  若需业务就绪 → 异步补一个 /api/ready 轮询，**不阻塞启动链**
```

**关键约束**：`/api/health` 的语义变更**必须与既有消费者对齐**。当前消费者至少包括 `check-health` 系路由（`server.js:668`）、`server.js:672` 存活探针、daemon `probeWebBackendHealth`、可能的外部探活。**这是一个「改语义」的动作，必须先做 §7.1 A0 的消费者普查**（见 §6 风险 R1）。

**收益**：daemon 链上 92s → ~1~3s（实测 `/api/health` handler 自身 22ms）。

### 3.2 病灶 2（报错）：MCP 自动连接与守护存活解耦

**现状病灶**：`deepseek-eyes` 是**可选工具**，但它的连接失败会在**用户终端**打出一行红字 `✗ ... timed out after 30000ms`，且失败轮次让整条启动观感更差；同时**守护的 `startup-timeout` 标签误导** —— 用户把它读成「启动超时」，实际是「600s 内没有任何浏览器会话接入」。

**目标形态**：

| 项 | 改法 |
|---|---|
| MCP 失败文案 | 从 `✗`（错误）降级为 `!`（降级/可选），并**明确标注「可选工具，不影响使用」**；失败详情收进日志，终端只留一行 |
| MCP 连接预算 | 保留 30s 单 server 上限，但**加整段墙钟上限**（[DESIGN-ARCH-169] §0 病灶 6 同款建议），避免多 server 串行累加 |
| `startup-timeout` 标签 | **改名不改 key**（与 169 §3.2 处理方式一致）：日志人类可读段改成「启动宽限 600s 内无任何会话接入（非启动失败）」；机器 reason key 保持 `startup-timeout` 不动（日志 grep 与既有测试匹配它） |
| 守护自杀的可见性 | 自杀前若 `phase === 'ready'`（即**启动早已成功**），日志**必须写明「启动已成功，此为会话空置回收」** —— 否则用户永远误读为启动失败 |

> **依据**：daemon 自己已有正确文案（`ai-manage-daemon.js:997-1002` 的括号注释），但用户看到的是**关掉守护进程**这半句 + `startup-timeout` 这个词，**误导性来自词本身而非描述**。

### 3.3 病灶 3（动画）：启动屏的「诚实连续」而非「丝滑」

**现状**：时间模型已对（`percentAt` 平滑），但**渲染节拍粗**：`PERCENT_TICK_MS=250`（4fps 的百分比）+ `FRAME_MS=80`（12.5fps spinner），且 **ink 首帧渲染期整块阻塞**。

**目标形态**（**低风险、可独立落地**）：

| 改法 | 落点 | 判据 |
|---|---|---|
| 百分比重画节拍 250ms → **120ms** | `bootPhaseLine.js:55` | 与 `PERCENT_CREEP_MS=12000`（时间常数）匹配，4fps→8.3fps 可感知更顺 |
| spinner 帧率与规范对齐 | `BootScreen.js:56` `FRAME_MS=80` | ⚠ **须先核对 [DESIGN-ARCH-102] §6.4 / `perfTunables`**：PERF-004 已证明此值存在「规范↔实现」漂移，**别再加第三源** |
| **不承诺 60fps** | —— | ink 首帧阻塞是结构性的（`app.js:345-368`），**该窗口物理上动不了**；方案承诺的是「**进度被诚实、连续地报告**」 |

> ⚠ **本节与 [DESIGN-PERF-004] 有重叠风险**：PERF-004 治「运行期动画节拍」，本节治「启动屏节拍」。**实施前须先确认 PERF-004 是否已接线**（其状态为「提案（未接线）」）—— 若已接线则本节**只做增量**，不重复造旋钮。

---

## 四、落点清单（file:line）

| # | 文件 | 行 | 改动 | 归属 |
|---|---|---|---|---|
| A1 | `services/backend/server.js` | `784-799` / `857-900` / `1040-1051` / `1156-1184` | 后台初始化全量 fire-and-forget；`/api/health` 只反映进程存活；新增 `/api/ready` | 3.1 |
| A2 | `services/backend/scripts/ai-manage-daemon.js` | `669` / `695-700` / `784` | 等待判据改 `/api/health`；业务就绪异步补探 | 3.1 |
| A3 | `services/backend/server.js` | `1173-1183` | AKShare 标的同步**移出启动链**（已有每日 2:00 定时任务 `:1057-1068`，冷启那次是冗余的） | 3.1 |
| B1 | `services/backend/src/services/domain/messaging/mcp/index.js` | `446-450` | 加整段墙钟上限；失败降级为「可选工具」语义 | 3.2 |
| B2 | `services/backend/scripts/ai-manage-daemon.js` | `997-1003` | `startup-timeout` 人类可读段改写；`phase==='ready'` 时明示「启动已成功」 | 3.2 |
| B3 | 调用 MCP `auto-connect` 的展示层（`aiManagementServer.js` 附近） | 【待定位】 | `✗` → `!` + 「可选工具，不影响使用」 | 3.2 |
| C1 | `services/backend/src/cli/bootPhaseLine.js` | `55` | `PERCENT_TICK_MS` 250 → 120 | 3.3 |
| C2 | `services/backend/src/cli/tui/ink-components/BootScreen.js` | `56` | `FRAME_MS` 核对规范后微调 | 3.3 |

> **R2b 巨石纪律**：`replSession.js`（589KB）、`App.js`（343KB）**已在 archDebtScan 巨石基线**，只许减不许增。**本方案不新增任何行到这两个文件** —— A/B/C 全部落在叶子文件（`server.js` 虽大但不在 CLI 巨石基线内，仍应遵守「新逻辑进叶子」）。
> **落点纪律**：新逻辑优先放入新建叶子模块（如 `src/bootstrap/backgroundInit.js`），`server.js` 只留调用点。

---

## 五、验收判据（每条都可当场复核）

| # | 判据 | 复核命令 |
|---|---|---|
| V1 | `/api/health` 在 web 后端 listen 后 **≤3s** 返回 200 | `curl` 或 `probeWebBackendHealth(3000)` 计时 |
| V2 | daemon 日志中「启动 Web 后端」→「Web 后端已就绪」**Δt ≤ 5s**（现状 92s） | `grep` daemon log 两行，算差 |
| V3 | `khy chat` 从敲到出现启动屏 **≤10s** | 真实 PTY 探针（[DESIGN-PERF-003] §2 P1 手法） |
| V4 | 后台初始化仍**全部完成**（迁移/种子/标的同步不能丢） | `server.js:1144` 的「后台初始化完成 (Xs)」仍出现；`web_backend.log` 仍有「标的同步: 33 成功」 |
| V5 | MCP 失败时终端**不出现 `✗`**，且带「可选工具」字样 | 断网跑一次 |
| V6 | 守护因零会话自杀时，日志**明示「启动已成功」** | 对照 §3.2 文案 |
| V7 | 启动屏百分比**单调上升、不回退、恰达 100** | `startupBeats.test.js` 既有设计锁 |
| V8 | 进度条不再 250ms 才跳一格 | `bootPhaseLine.test.js` + 人眼 |

### 5.1 既有红灯（**别当成自己搞坏的**）

| 门禁 | 现象 | 判定方法 |
|---|---|---|
| `check-tui-gates` | `FAIL — 226 unique KHY_* tokens (limit 220)` | `git show HEAD:<file>` 复算 → **改前已红**（223 > 220） |
| `archDebtScan` R2b | 11 项新增架构债 | 看条目里有没有**你没碰过**的文件 → 有则存量 |
| `check-node-syntax` | 全仓跑 8 分钟+ | 改用 `for f in <改动文件>; do node --check "$f"; done` |
| `tests/cli/commandCompletionIndexMemo.test.js` 第 10 例 | 一直红 | `git diff --numstat -- <file>` 空输出 + mtime 早于本次会话 |

---

## 六、风险与诚实边界

| # | 风险 | 等级 | 处置 |
|---|---|---|---|
| R1 | `/api/health` **语义变更**影响既有消费者（`server.js:672` 存活探针、`check-health` 路由、外部探活、daemon） | **高** | **实施前必须先做消费者普查**（§7.1 A0）。若消费者依赖「health=业务就绪」，则改为**新增 `/api/ready` 而不改 `/api/health` 语义** |
| R2 | 后台初始化改 fire-and-forget 后，**首次请求可能撞上未初始化的 DB** | 中 | 保留 `/api/ready`；对 DB 依赖路由加就绪门（或让请求层等 `ready` promise） |
| R3 | AKShare 标的同步移出启动链 → 首次使用量化功能时标的可能为空 | 中 | 已有每日 2:00 定时任务兜底；**冷启那次若确有「首次必须同步」语义，则改为「后台异步 + 就绪事件」而非删除** |
| R4 | 动画节拍与 [DESIGN-PERF-004] **可能撞车** | 中 | 实施前确认 PERF-004 接线状态；若已接线则只做增量 |
| R5 | **92s 的具体卡点未经探针钉死**（DB 迁移 vs `sequelize.sync` vs AKShare） | 中 | §7.1 A0 必须做：在 `server.js:885-905` 各 await 点打时间戳，产出**分段耗时表**再动手 |
| R6 | 方差极大（`khy version` 1937~3807ms）→ 容易把噪声当成果 | 中 | 全部 A/B **背靠背交错 + 每组取 min**（[DESIGN-PERF-003] §2 方法论） |

### 6.1 本方案**不做**的事（诚实边界）

- **不承诺 60fps 动画**：ink 首帧渲染是**结构性同步阻塞**（`app.js:345-368`），该窗口物理上无法渲染。
- **不承诺 GUI 缩短首帧**：[DESIGN-PERF-003] 已证「前移/预热」是**伪优化**（同步工作换位置不减少总墙钟）。
- **不重构 daemon 串行链**：并行化是更大的架构改动，**本文只做「让每段更快/更早就绪」，不改变串行结构**。
- **不动破坏性 git**。

---

## 七、实施顺序（小步多轮、每步可回退）

### 7.1 第 0 步：钉死 92s 的具体卡点（**只读探针，不改代码**）

**A0 探针**（落 `.khy/tmp/`，用完即删）：

```js
// 在 server.js:864 / :889 / :895 / :903 / :1041 / :1176 六个 await 点插桩，
// 各打一行 process.hrtime 时间戳 → 产出分段耗时表。
// 判据：哪一段占 92s 的大头（DB 迁移 / sequelize.sync / AKShare / 其它）。
```

**A0 消费者普查**（决定 R1 的处置）：

```bash
# 找出所有 /api/health 与 /health 的消费者（含前端、外部探活、daemon）
grep -rn "'/api/health'\|\"/api/health\"\|/health" --include=*.js --include=*.vue --include=*.ts \
  services/backend/src apps software 2>/dev/null | grep -v node_modules | head -40
```

**出口**：一份「分段耗时表 + 消费者清单」，据此决定 §3.1 是「改 health 语义」还是「新增 ready 端点」。

### 7.2 第 1 步：A3（AKShare 移出启动链）—— **最小、最独立**

只动 `server.js:1173-1183` 一处。收益立即可测（§1.2 事实 3 实测该段 29s）。**可单独回退。**

### 7.3 第 2 步：A1+A2（health/ready 解耦）

依赖 §7.1 A0 的结论。**改动面较大，必须带 `ready` 门与回归测试。**

### 7.4 第 3 步：B1+B2+B3（报错文案与预算）

**纯展示层 + 单个预算常量**，风险最低，可与前两步并行。

### 7.5 第 4 步：C1+C2（动画节拍）

**须先确认 [DESIGN-PERF-004] 接线状态**，避免撞车。

---

## 八、回退方案

| 改动 | 回退方式 |
|---|---|
| A1 后台初始化 fire-and-forget | 恢复 `await`（git diff 反向最小补丁，**不用 `git checkout --`**） |
| A2 daemon 等待判据 | 改回 `/api/health` 单一判据 |
| A3 AKShare 移出 | 把 `:1173-1183` 的 IIFE 恢复进 `Promise.allSettled` 数组 |
| B1/B2/B3 | 文案与常量的字面值回改 |
| C1/C2 | 两个常量回改（**注意**：`FRAME_MS`/`PERCENT_TICK_MS` 若被既有测试断言，须同步回退测试） |

**铁律**：全程**不用 `stash` / `reset --hard` / `clean -fd` / `push --force` / `git checkout --`**。要还原就 `cp` 备份 + 最小反向补丁。

---

## 九、待你裁决的三处（不代拍板）

| # | 事项 | 选项 A | 选项 B | 代价对比 |
|---|---|---|---|---|
| **Q1** | `/api/health` 语义 | **改语义**（health = 进程存活），新增 `/api/ready` | **不改语义**，只新增 `/api/ready`，daemon 改用 ready 的**快速版** | A 更简洁但**影响所有既有消费者**（需普查）；B 更安全但**多一个端点、两个语义并存** |
| **Q2** | AKShare 冷启同步 | **直接移出**（依赖每日定时） | **保留但后台异步 + 就绪事件** | A 最快（省 29s）但首次可能空标的；B 保语义但复杂度高 |
| **Q3** | 动画是否本轮做 | **本轮一起做**（C1+C2，低风险） | **单独立项**（先确认 PERF-004 接线状态） | A 用户当天就能感到改善；B 避免与 PERF-004 撞车/造第三源 |

> 建议的**默认路径**（若你不特别指定）：**Q1→B（安全侧）、Q2→B（保语义）、Q3→先单独立项、只做 C1**。
> 理由：这仓里最贵的教训是「看起来对、其实从未生效」与「过早阻断比不阻断更危险」，**语义类改动宁慢勿错**。

---

## 十、实施记录（2026-10-01，按方案修复）

> 本节记录**实际做了什么、实测判据、以及没解决什么**。
> 与 §3.1 的差异已在上方「实施阶段更正」中标注 —— **方案的假设被证伪，真根因另在别处**。

### 10.1 真根因与修法（A 组的替代实现）

| # | 文件 | 改动 | 可复核判据 |
|---|------|------|-----------|
| **R-a** | `software/khyquant/utils/pythonPath.js` | `canRunPython()` 加 fast-path：**绝对路径 + `fs.existsSync` → 直接采信**，跳过 `execSync` spawn。开关 `KHY_PYTHON_TRUST_PATH`（默认开；`=0` 恢复逐候选实测） | 真正解析时 `TRUST=1` spawns=1 / `TRUST=0` spawns=2（见 §10.5.1） |
| **R-b** ★承重 | `software/khyquant/services/pythonDataSourceService.js` | 构造函数 `this._pythonPath = null` + `get/set pythonPath` 惰性 getter；**模块级 `new` 改懒 Proxy** | `_pythonPath BEFORE read === null`；`require` 期 `findPython` 调用数 = **0** |
| **R-c** | `software/khyquant/services/akshareDataService.js` | 同上（惰性 getter） | 同 R-b |
| **R-d** | `software/khyquant/services/mlAgentService.js` | 同上（惰性 getter） | 同 R-b |

> ⚠ **归因更正**：45.9s → 1.2s 的收益**几乎全部来自 R-b**（惰性 getter），
> **不是** R-a。归因分离实验见 §10.5.1 —— 这一点很重要：R-a 在 `require` 期**毫无作用**
> （那时已不解析 python，fast-path 无从被调用）。R-a 治的是「该解析时解析贵了」，R-b 治的是
> 「不该解析时解析了」。**两条都保留，但功劳不能记混。**

### 10.2 A1/A2 组（health/ready 解耦）—— 按 §3.1 原设计**已落地**

| # | 文件 | 改动 |
|---|------|------|
| **A1** | `services/backend/server.js` | 新增 **`/api/ready`**（业务就绪，`_bootBusinessReady` 标志位，200/503）；`/healthz` 保持纯存活（不触 DB）；后台初始化完成后置位 |
| **A2** | `services/backend/scripts/ai-manage-daemon.js` | `probeWebBackendHealth` 探测路径 `/api/health` → **`/healthz`**（存活级，快） |
| **A2b** | `services/backend/src/cli/handlers/gatewayManageDaemon.js` | ~~`_collectManageHealth` 的 `apiReachable` 改探 `/healthz`~~ → **此项已撤回（原改动是错的）**，见下方更正说明 |

> **Q1 的实际取向**：没有「改 `/api/health` 语义」（选项 A 的高风险动作），而是
> **新增 `/api/ready` + 让 daemon 改探 `/healthz`** —— 即
> **A 的形态 + B 的安全边界**：端点语义分离到位，但既有 `/api/health` 语义**一字未动**（零消费者破坏）。

> ## ⛔ A2b 更正（2026-10-01 验收时发现）：**我改错了，已被撤回**
>
> 我曾把 `gatewayManageDaemon.js` 的 `_collectManageHealth.apiReachable` 探针
> 从 `/api/health` 改成 `/healthz`。**这是错的** —— 该探针打的是**管理守护进程（默认 9090）**，
> 而 `/healthz` 只存在于 **web 后端（server.js，默认 3000）**。守护进程上无此路由，
> GET `/healthz` 会落到鉴权闸门返回 **401**，于是一个完全健康的守护进程被误判成「API 不可达」。
>
> 现已更正回 `/api/health`（`gatewayManageDaemon.js` 的 `apiLivenessUrl = apiHealthUrl`），
> 并在该处留下了显式注释说明为什么**不能**用 `/healthz`。
>
> **两处探针的正确归属**：
>
> | 探针 | 打的是哪个进程 | 正确路径 |
> |------|---------------|---------|
> | `ai-manage-daemon.js` `probeWebBackendHealth` | web 后端（3000） | `/healthz` ✅（本方案改动正确，保留） |
> | `gatewayManageDaemon.js` `_collectManageHealth` | 管理守护进程（9090） | `/api/health` ✅（本方案改动错误，已撤回） |
>
> **教训**：改探针路径前必须先确认「这个探针打的是哪个进程」。
> 同一份代码库并存多个 HTTP 服务时，`/healthz` 这类名字**不是全局唯一的** ——
> 仅凭「都是健康检查」就套同一路径，会把健康进程判成故障。

### 10.3 B 组（报错文案）

| # | 文件 | 改动 |
|---|------|------|
| **B1** | `services/backend/src/services/domain/messaging/mcp/autoConnect.js` | 新增两个**纯函数**（措辞真源）：`formatConnectFailure(failure, progress)` / `formatConnectFailureSummary(failures)` |
| **B2** | `services/backend/src/services/aiManagementServer.js` | 两处失败文案改**引用**上面的真源（`✗` → `!` + 「可选工具，不影响使用」）；**不内联字符串**（避免措辞出现第二源） |
| **B3** | `services/backend/scripts/ai-manage-daemon.js` | `startup-timeout` 的**人类可读段**改写：`phase==='ready'` 时明示「启动早已成功，此处仅因 Ns 内无会话接入而回收」；**machine key `startup-timeout` 一字未动** |

### 10.3.1 A3 / Q2（AKShare 冷启同步移出启动链）—— **已实施，且实测推翻了方案的 29s 数字**

**方案 §1.2 事实 3 说这段耗时 29s**。实测（2026-10-01，直接跑该同步本身）：

```
findPython()                         =   935ms
spawn + 跑 get_all_instruments_from_cache.py = 3302ms
GRAND TOTAL                          =  4301ms        ← 不是 29s
```

**更贵的发现：它产出的是「源码里已经写死的常量」。**

```
[py-err] 读取缓存失败: No module named 'pandas'
[py-err] akshare 获取失败: No module named 'akshare'
[py-err] 网络不可用，使用内置兜底列表          ← 落到 get_all_instruments_from_cache.py:157
records = 33 success = true                    ← 这 33 条 = 该文件第 22 行起的 BUILTIN 常量表
```

即：**每次冷启 spawn 一个必然失败的 python（4.3s），只为读回一段早已写在源码里的常量表。**

三个旁证说明它不该占启动窗口：

| 事实 | 位置/取值 |
|------|----------|
| 缓存 CSV 4.4h 前刚写过（TTL 24h） | `.khy/khyquant/cache/instruments.csv` |
| 每日 2:00 已有同一任务的定时兜底 | `server.js` dailyScheduler（`hour:2, minute:0`） |
| 同步是 upsert 不是「没有就起不来」 | 走 CSV 缓存 + DB upsert，缺这次不影响可服务性 |

**修法**（`server.js`）：把该分支从 `await Promise.allSettled([...])` 数组里摘出，
改到 `_bootBusinessReady = true` **之后**由 `_runDeferredInstrumentSync()` fire-and-forget 执行。

- 保留 `setImmediate` 脱离当前 tick；`_deferredInstrumentSyncStarted` one-shot latch 防重复 spawn
- best-effort：失败只记日志，绝不影响进程
- **回退** = 把 `_runDeferredInstrumentSync()` 改回 `await ...syncInstrumentsFromAData()` 并放回数组

**实测（listen → 初始化完成）**：

```
run1:  listen→初始化完成 = 5.6s   标的同步出现在 +7.7s   ← 同步已在链外
run2:  listen→初始化完成 = 4.3s   标的同步出现在 +5.3s   ← 同步已在链外
```

**结构判据**（比时间可靠）：`后台初始化完成` 现在先于 `标的同步` 出现，
而在 HEAD 里该分支是 `allSettled` 数组的最后一个元素 ⇒ 顺序必然相反。

**新增守卫**：`tests/bootstrap/instrumentSyncOffBootChain.test.js`（3 用例）
—— 源码级结构断言，防止有人把 `await syncInstrumentsFromAData()` 塞回启动链而功能测试全绿。
已做**反向验证**：人为注入回退版本后该守卫 `fail 1`，还原后 `pass 3`。

> 同时修正一处**我自己的疏漏**：首次运行该守卫时挂了 3 分钟 ——
> 因为我的 `stripScheduledTaskBodies` 把 `task: async () => {` 替换成
> 仍含该字面量的字符串，导致 `for(;;)` 永不退出。已改为不含 MARKER 的占位串 + 迭代上限守卫。
> **教训：写测试代码也要自检「我这段逻辑会不会不终止」**，否则一个坏守卫比没有守卫更糟（挂死 CI）。

### 10.4 C 组（动画节拍）—— Q3 取向：**本轮一起做**

| # | 文件 | 改动 | 依据 |
|---|------|------|------|
| **C1** | `services/backend/src/cli/bootPhaseLine.js` | `PERCENT_TICK_MS` **250 → 120** | 百分比曲线时间常数 `PERCENT_CREEP_MS=12000`；250ms 使曲线「一跳一跳」 |
| **C2** | `services/backend/src/cli/tui/ink-components/BootScreen.js` | `FRAME_MS` 硬编码 80 → **消费 `perfTunables.spinnerFrameMs()`** 单一真源（默认 160ms） | `[DESIGN-ARCH-101]` §8 冲突 1 已裁定「以 perfTunables 160ms 为准，80ms 是陈旧第三源」 |

> C2 **不是「调快」而是「消除第三源」**：同一 TUI 里主界面 spinner 160ms、启动屏 80ms 的历史不一致被收敛，
> 且 `KHY_SPINNER_FRAME_MS` / `KHY_TUI_LOW_POWER` 现在对启动屏同样生效。

### 10.5 实测判据（背靠背 3 连跑）

```
require(instrumentService):   45920ms  →  1166 / 1309 / 1286ms     (≈39×)
require 期 findPython 调用:   N 次     →  0 次                    【结构事实】
pythonPath 惰性:              —        →  _pythonPath 读前为 null  【结构事实】
隔离 server 启动:  服务器已就绪(listen) 8.3s / DB connected 8.6s / 后台初始化完成 15.2s
测试:  bootPhaseLine+startupBeats 46/46 · mcpAutoConnect 14/14（含 5 条新增措辞锁定）
       mcpAutoConnectWiring 3/3(jest) · inkComponents 25/25(jest)
守卫:  check-agent-rules(11 文件) 0 violation · check-agent-feedback 0 error 0 warning
```

#### ★ 10.5.1 归因更正：R-b 是承重件，R-a 是次要防线

实施后做了一轮**归因分离**（把 `KHY_PYTHON_TRUST_PATH` 两边都跑一遍），结果**推翻了我最初的归因**：

```
require(instrumentService) 时：  TRUST=1 → findPython calls = 0 / 867ms
                                 TRUST=0 → findPython calls = 0 / 789ms
                                 ⇒ 两档完全一样，R-a 在 require 期**毫无作用**
```

**结论：45.9s → ~1.2s 的收益 100% 来自 R-b（惰性 getter）**，因为 `require` 期根本不再解析 python，
`canRunPython` 的 fast-path 自然无从被调用。R-a **不是**主因 —— 这是对本文档 10.1 表格的更正。

R-a 的真实收益在**真正解析时**（首次要跑 python 脚本）：

```
findPython() 首次调用：  TRUST=1 → spawns=1 / 1618ms
                         TRUST=0 → spawns=2 / 3505ms       ⇒ 省掉 1 次 spawn（约减半）
```

即：**R-b 治「不该解析时解析了」，R-a 治「该解析时解析贵了」**。两者互补，但**功劳不能记混**。

#### 10.5.2 端到端一次真实冷启（含机器税）

```
25169ms  服务器已就绪，后台初始化中...     ← listen（本次含 ~4s 进程创建税 + 模块图）
25403ms  Database connected
34629ms  后台初始化完成 (9.3s)             ← 后台初始化自身只 9.3s
35153ms  ✓ 标的同步完成: 33 个成功, 0 个失败
```

> ⚠ **这两个数字（25.2s vs 10.5.3 提到的 8.3s）差异巨大**，正是本文档反复强调的
> 「**时间数字不可靠、结构判据可靠**」的又一例证：同一份代码、同一台机器，冷热/负载不同差 3 倍。
> 可复核的是 `findPython calls = 0`（布尔），不是毫秒。

### 10.6 **未解决 / 诚实边界**

| # | 事实 | 说明 |
|---|------|------|
| **U1** | **剩余 ~14s 未解** | Node 模块图（jose/webcrypto/sequelize/express）总量。实测 `node -e 0` 单独就要 ~4s（本机进程创建税）—— 这 14s 里相当一部分是**机器税**，非代码问题。本方案**未承诺**解决。 |
| **U2** | 45.9s 是**本机冷启**数字 | 含 Defender 进程创建税；换机/换盘会变。**可复核的是结构判据**（require 期 findPython 调用 = 0），不是时间数字。 |
| **U3** | `instrumentService.js:6` 仍是 eager require | 未动（动它会破契约）。修的是被 require 那个模块的**构造时机**。 |
| **U4** | R2b 巨石账为红 | `aiManagementServer.js` 基线 3703 → 实测 3781（delta **+78**）。但该文件**同时存在他人在途改动**（conversation-groups/reorder 路由，约 +70）；我本次贡献约 **+8**（且已通过抽叶子到 `autoConnect.js` 把措辞逻辑移出）。**未跑 `--update-baseline`** —— 跑了会把别人的 +70 洗成存量。 |
| **U5** | §1.2 事实 3 的「AKShare 29s」与实测 4.3s 不一致 | 口径/温度差异（冷启 vs 预热、是否含 spawn）。**以直接实测为准**：该同步本体 4.3s，且**产出等价于源码常量**（见 §10.3.1）。**已移出启动链**。 |

### 10.7 回退路径

| 改动物 | 回退方式 |
|--------|---------|
| R-a | `KHY_PYTHON_TRUST_PATH=0`（无需改代码，恢复逐候选实测） |
| R-b/c/d | `git diff` 逆补丁（**不用 `checkout --`**）；或把 getter 改回构造期赋值 |
| A1/A2 | 删 `/api/ready` 段；daemon 探针路径改回 `/api/health` |
| B1/B2/B3 | 文案字面值回改（**注意 B2 是引用变异，需同时处理真源**） |
| C1/C2 | 两个常量回改（`FRAME_MS` 回硬编码、`PERCENT_TICK_MS` 回 250） |

---

## 十一、参考

- 上游设计：[DESIGN-ARCH-169]（就绪信号后置，已实施） · [DESIGN-ARCH-115]（启动节拍真源） · [DESIGN-PERF-003]（首帧阻塞） · [DESIGN-PERF-004]（运行期节拍）
- 关键代码：`services/backend/server.js` · `services/backend/scripts/ai-manage-daemon.js` · `services/backend/src/cli/handlers/gatewayManageDaemon.js` · `services/backend/src/services/domain/messaging/mcp/index.js` · `services/backend/src/cli/bootPhaseLine.js` · `services/backend/src/cli/startupBeats.js`
