<!-- IMPL-STATUS: done -->
# [DESIGN-PERF-006] khy 启动提速方案

> **状态**：已接线（W2/W3 全量，W1 部分更正） · **日期**：2026-10-04 · **编号**：[DESIGN-PERF-006] · **落点目录**：`docs/03_DESIGN_设计/DESIGN-PERF/`
> **适用层**：`runtime/node/backend`（`khy` CLI / TUI 入口链）
> **需求来源**（`RUNTIME-008` source）：用户原话「khyos的启动太慢了，怎么快速启动需要设计个方案」（2026-10-04）
> **关联**：[DESIGN-PERF-002]（KHY_FAST_STARTUP / compile cache，已落地） · [DESIGN-PERF-003]（TUI 挂载期阻塞诊断 + 探针，提案未接线） · [DESIGN-ARCH-115]（启动板块节拍表） · [DESIGN-PROCESS-002]（`PROCESS-008` 落地阶段）
> **证据基线**：本文全部数字为 **2026-10-04 本机实测**（仓库 `D:\Portable\khy-os`，Windows 10.0.26200，Node v22.18.0）。启动耗时 run 间方差大（OS 文件缓存状态不同），故关键数字给区间或注明冷/热；**推测项显式标注〔推测〕**。

---

## 零、一句话结论

用户感知的「启动慢」由三段构成，今天实测：**TUI 交互首帧 ~6.2s**（其中 2.3s→6.2s 的 ~3.9s 是 Ink 挂载期停顿，即 [DESIGN-PERF-003] 诊断的同步阻塞，该方案至今未落地）、**单命令热启动 ~830ms**（其中 ~320ms 是三条**串行同步** git 子进程、56ms 是 chcp 子进程）、**冷启动 ~13.8s**（磁盘缓存冷 + Defender 扫描，代码侧无法根治）。方案 = 四条工作流：W1 接线 PERF-003 消化挂载期阻塞（P0）、W2 单命令快路径（P1）、W3 冷启动治理（P2）、W4 daemon 结构性方案（P3，可选）。

---

## 一、需求五问（`RUNTIME-008`，source 均为本轮用户原话）

| # | 问题 | 答案 |
|---|------|------|
| 1 | 谁用？ | 每天开终端敲 `khy` 的维护者与最终用户（source：「khyos的启动太慢了」——主语是日常使用者） |
| 2 | 什么时候用？ | 每次敲 `khy`（TUI）、`khy status`、`khy ai -p` 等单命令时（source：「启动」） |
| 3 | 现在的替代做法？ | 等待；或绕过 bat 直接 `node runtime/node/backend/bin/khy.js`（省 ~100ms bat 解析，但不解决大头） |
| 4 | 成功长什么样？ | 命令：`node perf-probe 探针` + `Measure-Command { khy status }`。期望：TUI BootScreen 首帧 p50 < 2s；`khy status` 热启动 p50 < 300ms；冷启动首跑 < 3s（W3） |
| 5 | 不做会怎样？ | 每次交互白等 6 秒起步；用户绕开 TUI 与 CLI 包装层，平台入口被架空 |

---

## 二、实测基线（2026-10-04，可复现命令见 §六）

### 2.1 三条路径的墙钟

| 路径 | 冷（首次） | 热（连续跑） | 说明 |
|---|---|---|---|
| TUI（裸 `khy`，真实 ConPTY） | — | **首帧 6176ms** | 见 §2.2 时间线 |
| 单命令 `khy status`（`Tools\khy.bat` → node 直跑） | 13808ms | **~830ms**（三次 3403/836/828） | node 自身基线 67ms |
| 仓库根 `khy.bat`（Python launcher 链） | — | — | **当前已损坏**：批处理解析报错 exit 255，40ms 即退（见 §七） |

### 2.2 TUI 启动时间线（PERF-003 P1 探针，真实 ConPTY，run 2026-10-04）

| 里程碑 | 今天（10-04） | PERF-003 实测（09-22） |
|---|---|---|
| first-output | 71ms | 297–1558ms |
| 5 步骤阶段走完（✅ 就绪 5/5） | **459ms** | 1575–4144ms |
| 进备用屏（`\x1b[?1049h`） | **2272ms** | 3853–21476ms |
| BootScreen 首帧可见（bootscreen-art） | **6176ms** | 5588–15867ms |

判读：**节拍表（ARCH-115 / PERF-004）治理后的前半段已明显改善**（5 步骤 459ms 完成）；剩余痛点收敛为两段：
- **Ink 渲染引擎就绪 ~1.65s**（615ms 进度条起 → 2272ms 进备用屏，进度条 48% 处一次停顿 ~1.5s）；
- **挂载期停顿 ~3.9s**（2272ms 进备用屏 → 6176ms 首帧），与 [DESIGN-PERF-003] §三 的 render() 同步阻塞归因一致——**该方案的修复至今未接线**。

### 2.3 单命令 830ms 分解

- `STARTUP_PROFILE=1`：entry → main:start = **189ms**（其中 entry→init:start 135ms = require 图；init 51ms）。
- spawn 钩子（`NODE_OPTIONS=--require` 包裹 child_process，见 §六）实测启动期同步子进程：

| 时刻 | 调用 | 耗时 |
|---|---|---|
| 72ms | `execFileSync chcp.com 65001` | 56ms |
| 432ms | `execSync git rev-parse --abbrev-ref HEAD` | 72ms |
| 560ms | `execSync git status --porcelain` | **128ms** |
| 678ms | `execSync git rev-list --left-right --count HEAD...@{u}` | 118ms |

三条 git 探针**串行同步**执行，合计 ~318ms；本仓当时 854 个改动文件放大了 `git status --porcelain` 的成本。72ms→432ms 之间的 ~360ms 为模块加载 + init（与 `STARTUP_PROFILE` 的 135ms require 图 + 各命令 handler 懒加载对得上，量级一致，未逐模块归因〔推测：分布均匀，无单点 >50ms〕）。

### 2.4 CPU 侧面印证

`--cpu-prof`（`khy status`）：CPU 总样本仅 ~220ms（墙钟 830ms）——**大头是等待**；自耗第一名 `child_process` 122ms（55.8%），`loader`（模块解析）21ms（9.6%）。与 §2.3 的 spawn 清单互证：**砍同步子进程比砍 CPU 更值钱**。

---

## 三、与既有文档的关系（不重复劳动）

| 文档 | 已覆盖 | 本文增量 |
|---|---|---|
| [DESIGN-PERF-002] | KHY_FAST_STARTUP 默认开、enableCompileCache 已接、顶层 require 瘦身 | 不重复；W2 仅列其阶段 C 剩余项 |
| [DESIGN-PERF-003] | TUI 挂载期阻塞的**归因 + 4 支探针 + 反例教训**（预热平移无效、compile cache 在噪声内） | **P0 就是把它的结论接线**；补今天的新基线（前半段已改善，痛点收敛到挂载期） |
| [DESIGN-PERF-004] | 动画节拍 | 不涉及 |
| [DESIGN-PERF-005] | khy-chat 启动链 | 独立入口，另案 |
| [DESIGN-ARCH-115] | 启动板块节拍表 / D1 1.5s 硬超时 | W1 的验收挂在它的节拍表之下 |

PERF-003 最重要的教训直接约束本文：**同步工作要被消化，不能只换位置**（setImmediate 平移实测把首帧从 5013ms 恶化到 7975ms）。W1 的每个候选措施都要过这条判据。

---

## 四、方案（四条工作流）

### W1（P0）TUI 首帧：6.2s → 目标 p50 < 2s

按收益/风险排序，每项独立可回退：

| # | 措施 | 预期收益 | 判据 / 风险 |
|---|---|---|---|
| W1-1 | **BootScreen 静态帧先行**：进备用屏后立即用纯 ANSI write 画一帧静态 art（不经过 Ink），Ink 就绪后无缝接管 | 首帧感知 6.2s → ~2.3s | 符合 PERF-003「消化」判据（一帧 write 是 O(百字节) 输出，无同步 IO）；风险=交接闪烁，交接帧须与 Ink 首帧同一画布内容；回退 `KHY_BOOT_STATIC=0` |
| W1-2 | **挂载期同步 IO 清理**：按 PERF-003 P3 探针（`tui-startup-probe-render.js` + `--chains`）列出 render()→首帧间的 spawnSync/readFileSync 清单，逐项后台化或预缓存 | ~3.9s 停顿逐项消减 | 探针已备；逐项前后对照；**先列清单再动手**，不盲改 |
| W1-3 | Ink 就绪 ~1.65s 的压降：评估 ink/react 模块图瘦身与升级；若静态帧（W1-1）落地后用户已无感，此项降级为观察 | 2.3s → <1.5s〔推测〕 | PERF-003 实测 compile cache 无效，**不得以「开了 compile cache」作为此项的完成依据** |

### W2（P1）单命令快路径：830ms → 目标 p50 < 300ms

| # | 措施 | 预期收益 | 说明 |
|---|---|---|---|
| W2-1 | **git 探针并行 + 异步化**：`khy status` 链路的 3 条 `execSync`（rev-parse / status / rev-list）改为 `execFile` 异步 `Promise.all` | ~318ms → ~130ms（取最慢一条） | 行为等价重构，无拦截机制，不走 PROCESS-008 升阶 |
| W2-2 | **git status TTL 缓存**：`.khy/cache/` 内按 mtime 缓存 `--porcelain` 结果（秒级 TTL），连续多次 `khy status` / sync 脚本共享 | 二次查询 → ~0ms | 只缓存只读探针；写路径不变 |
| W2-3 | **去掉 chcp execFileSync**（56ms）：Windows 21H1+ / Windows Terminal 下 Node stdout 已是 UTF-8，仅旧 conhost TTY 需要时保留 | -56ms | 兜底：保留 `KHY_FORCE_CHCP=1` 手动开关 |
| W2-4 | require 图续瘦（PERF-002 阶段 C 剩余项） | entry→init 135ms 里再省〔推测 30–60ms〕 | 以 `startupProfiler` checkpoint 为准逐项做 |

### W3（P2）冷启动：13.8s → 目标 < 3s

1. **Defender 排除提示**：`khy repair` / 装机脚本的输出中提示用户把 `D:\Portable\khy-os`（或安装根）加入 Windows Defender 排除目录——**脚本只提示不代改**（改杀软排除是用户安全决策）。13.8s 与 830ms 的差值主体是 Defender 实时扫描 + 冷文件缓存，代码侧无解〔推测，可关掉实时防护复测一次验证〕。
2. **首启预热**：安装/修复完成后自动跑一次 `khy doctor`（触发 compile cache 写入 + OS 文件缓存预热），把「第一次 13.8s」摊到装机时刻。

### W4（P3，可选）结构性方案：khy daemon

常驻 Node 进程 + CLI 薄客户端（named pipe / localhost IPC，端口遵循 `RUNTIME-001` 动态来源），单命令与 TUI 的「进程冷启动」整体消失，目标 < 200ms。**成本**：生命周期管理、多机租约冲突、崩活检测；**仅当 W1–W3 落地后仍不达标时立项**，不在本轮范围。

---

## 五、落地顺序与阶段约束（`PROCESS-008`）

1. **顺序**：W1-2（先列清单）→ W2-1/W2-3（低风险高确定）→ W1-1 → W2-2 → W3 → 视达标情况决定 W1-3 / W4。
2. 修复类改动集存证落 `.khy/feedback/DESIGN-PERF-006/`（`repro-before.txt` / `repro-after.txt` 用同一探针、同一命令）；涉及删除的另按 `RUNTIME-009` 报部位。
3. 每项措施的验收都用 §六 的探针命令跑 **20 连跑取 p50**（PERF-003 的方差教训：不给单点值）。
4. 本文为提案；接线时 W1-1 若引入新的启动拦截行为，按四阶段从 S1 观察者起（预期不需要：它是渲染路径改动，不是拦截机制）。

---

## 六、度量命令（本机可复现）

```bat
:: P1 端到端（真实 ConPTY；探针原件在 works/data/khyos/housekeeping/2026-09-27/_产物/，
:: 其 ROOT 取 __dirname/..，须放到「仓根的直接子目录」运行才能解析 node_modules。
:: 注意：原件 spawn 路径仍是迁移前的 services/backend/bin/khy.cmd，须改为
:: runtime/node/backend/bin/khy.cmd；已改好的副本在 .khy/tmp/perf-probe/（本机态，gitignore））
node <仓根子目录>\tui-startup-probe-e2e.js 20000

:: 启动检查点
set STARTUP_PROFILE=1 && node runtime\node\backend\bin\khy.js status

:: 同步子进程清单（钩子文件内容见本文 §2.3 的产生方式：包一层 child_process 计时打点）
set NODE_OPTIONS=--require <hook.js> && node runtime\node\backend\bin\khy.js status

:: CPU 归因
node --cpu-prof --cpu-prof-dir=%TEMP%\khy-prof runtime\node\backend\bin\khy.js status

:: 墙钟（PowerShell）
Measure-Command { D:\Portable\Tools\khy.bat status }
```

---

## 七、现状备注（非本文范围，但影响「启动」体验）

- **仓库根 `khy.bat` 已损坏**（批处理解析报错、exit 255，错误行含被截断的中文字符串，疑似编码/换行损伤）。用户实际生效的入口是 `D:\Portable\Tools\khy.bat`（直接 node，不经过 Python 链）。修复它须先按 `RUNTIME-007` 复现存证，另开任务。
- **文档路径漂移**：PERF-002/003 等旧文写的 `services/backend/bin/khy.cmd`，在 R2-R4 迁移后真身已移至 `runtime/node/backend/bin/`。本文按新路径书写；旧文的路径以迁移基线（commit `559a7a8d`）为准订正。

---

## 八、落地记录（2026-10-04 接线，同日）

### 8.1 已接线

| 项 | 改动 | 实测结果（`repro-before/after` 存证 `.khy/feedback/DESIGN-PERF-006/`） |
|---|---|---|
| W2-1 | `hudRenderer.js` 新增 `refreshGitAsync()`（三条 git 探针 `execFile` 并行、事件循环非阻塞），`routerDispatchSlash.js` status 分支 `await` 之；同步 `refreshGit()` 原样保留给无法 await 的调用方 | 冷跑：git 探针从「432→796ms 串行、合计 ~320–535ms」变为「~448ms 起三路并行、各 ~10ms」；`chcp` spawn 消失（见 W2-3） |
| W2-2 | `hudRenderer.js` 跨进程磁盘缓存：`<dataHome>/cache/git-hud-<cwd-base64>.json`，TTL 30s（与进程内一致），读路径 fail-soft；dataHome 解析沿用 `KHY_DATA_HOME → .khy/.location.json 指针 → ~/.khy` 链 | 命中后 spawn 数 4 → **0**；`khy status` 热启动 5 连跑 **521/528/537/548ms**（改前 5 连跑 833/904/912/833/1023ms，中位 ~870 → ~530，**约 -35%**） |
| W2-3 | `bin/khy.js` chcp 块加条件：仅「legacy conhost TTY」才 spawn（管道/重定向字节本就是 UTF-8；Windows Terminal / VS Code 终端原生渲染 UTF-8）；`KHY_FORCE_CHCP=1` 恢复无条件 spawn | 管道调用下 chcp spawn 消失（改前 56–106ms） |
| W3 | `delivery/extension/scripts/khy-portable/repair-portable.js` 新增 `warmupAndHint()`：打印 Defender 排除提示（**只提示不代改**，含可直接粘贴的 `Add-MpPreference` 命令）+ 修复后自动预热一遍完整加载链（`spawnSync khy status`，60s 上限，失败不影响修复结果） | 修复 dry-run 验证：提示与预热均正常；预热即把「首次 ~13.8s」摊到装机时刻 |

A/B 方式说明：机器状态漂移显著（同日不同时刻 entry→main 从 189ms 漂到 367–627ms），故机制层证据（spawn 数与耗时并行化）以同刻 stash A/B 交叉验证；墙钟取同批 5 连跑对照。guard：`check-agent-rules.js --changed` 通过；`routerDispatchSlashLeaf` 测试通过。

### 8.2 W1 更正（实测推翻了本方案 §四 W1-1 的前提）

字节级 e2e 时间线（探针 chunk 逐条核对）显示：

1. **启动屏并不缺首帧**：进入备用屏（`\x1B[?1049h`）后 **~200ms** 内 Ink 预热帧（含 'khy OS' 字标、进度条、节拍行）就已落地——app.js 的两步渲染（预热 BootScreen → render(App)）按设计生效。
2. **探针里程碑量错了对象**：PERF-003/本文早先引用的 `bootscreen-art` 里程碑匹配的是小写 `khy-os` 字符串——那是**全量 App UI 帧**里输入框的 cwd 路径串，不是启动屏 art（字标实为 `khy OS`）。所谓「首帧 6.2s」实为「全 UI 就绪 6.2s」。
3. **剩余痛点重新定义为「App 挂载尾巴」**：启动屏出现后到全 UI 就绪之间有 ~3.9–10s（run 间方差大）的静默期，期间 spinner 冻结。挂载期同步 IO 清单（W1-2）实测只有 2 条一次性 git 探针（`gitExecutableDetector` ~84ms + `_baseTool.isGitRepo` 首查 ~66ms，均有进程级缓存），**远不足以解释尾巴**；无头渲染探针 74s 墙钟仅 ~5s CPU，主体是**等待**而非同步 IO。真 TTY 的 CPU profile 两次尝试均未取到（探针硬杀子进程丢失 profile / PTY 探针抓到的是自身进程）。
4. **结论**：W1-1（静态帧）**不需要做**；尾巴的构成需先拿到真实 TTY 的挂载期 profile（建议给 e2e 探针的子进程传 `--cpu-prof` 且改为优雅退出再采样），在此之前**不盲改**（`RUNTIME-007`）。方差本身（alt-screen 2.3s/5.3s/6.1s 三连跑）再次指向 W3 的文件系统/Defender 因素。

### 8.3 漂移治理与度量纪律（本机实测沉淀）

本机同日不同时刻 entry→main 可从 189ms 漂到 627ms（Defender 突发 / 文件缓存状态），**分组采样与单点值都不可信**。纪律与工具：

1. **墙钟数字必须「同刻交错对照」**：改前/改后逐对交替采样、每对轮换起始侧，取中位数。现成工具：`npm run bench:startup`（`delivery/extension/scripts/khy-diagnostics/bench/startup_ab_bench.js`，本次已修复三处：入口路径跟随 R2-R4 迁移 → `runtime/node/backend/bin/khy.js`；采样从分组改为**逐对交错**；负载从 `khy ai` 换成 `khy status`——实测 `ai` REPL 在 Windows 上 stdin EOF 不退出（挂死验证过），`status` 走同一启动链且干净退出）。实测一次：6 对交错，BEFORE 中位 956.8ms vs AFTER 476.8ms，0 超时。
2. **机制层证据优先于墙钟**：spawn 数量/并行度/缓存命中（spawn 钩子、`STARTUP_PROFILE=1` checkpoint）不受漂移影响，作为第一判据；墙钟对照作为第二判据。
3. **`.bat` 文件防复发**：`.gitattributes` 的 `*.bat text eol=crlf` 只在 checkout 时生效——工具直接写 LF 的 `.bat` 在 `git status` 里照样「干净」（本次 khy.bat 坏因）。任何脚本/AI 写 `.bat` 后必须确认 CRLF。
