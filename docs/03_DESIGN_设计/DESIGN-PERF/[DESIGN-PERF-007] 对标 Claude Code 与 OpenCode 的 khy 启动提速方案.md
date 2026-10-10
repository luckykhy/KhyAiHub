<!-- IMPL-STATUS: proposed -->
# [DESIGN-PERF-007] 对标 Claude Code 与 OpenCode 的 khy 启动提速方案

> **状态**：提案（未接线） · **日期**：2026-10-10 · **编号**：[DESIGN-PERF-007] · **落点目录**：`docs/03_DESIGN_设计/DESIGN-PERF/`
> **适用层**：`runtime/node/backend`（`khy` CLI / TUI 入口链）
> **需求来源**（`RUNTIME-008` source）：用户原话「khyos启动太慢，为什么claude code和opencode启动很快需要设计一个方案」（2026-10-10）
> **关联**：[DESIGN-PERF-002]（KHY_FAST_STARTUP / compile cache，已落地） · [DESIGN-PERF-006]（启动提速 W2/W3 已接线、W1 已证伪更正） · [DESIGN-PERF-003]（TUI 挂载期阻塞归因+探针） · [DESIGN-ARCH-115]（启动板块节拍表） · [DESIGN-PROCESS-002]（`PROCESS-008` 落地阶段）
> **证据基线**：本文全部数字为 **2026-10-10 本机实测**（仓库 `D:\Portable\khy-os`，Windows 10.0.26200，Node v22.18.0，claude v2.1.295）。同日不同时刻方差大（Defender / 文件缓存状态），关键数字注明冷/热与连跑次数；**推测项显式标注〔推测〕**。

---

## 零、一句话结论

「claude code / opencode 启动很快」在本机可复现地量成三件事：**claude 是 247MB 的 Bun 单体二进制（`--version` 47ms、TUI 首帧 ~150ms，UI 先画、网络后查）；opencode 是 172MB 的 Bun 单体（TUI 进备用屏 4.1s，比 khy 快 3 倍，但 `--version` 1.3s 并不快）；khy 是 CJS + pnpm `node_modules` 的多文件模块图**——同机同条件实测，`khy` TUI 启动屏首帧 **12.2s**（三次连跑 11.6/12.2/19.7s），`khy status` 热启动 ~530ms、冷启动（compile cache 冷）**17s**。khy 的慢可分解为四段，各有明确修法：**ink ESM 冷编译 16.4s 从未被预热摊薄**（现有预热跑的是 `khy status`，而 status 根本不装载 ink）、**挂载期尾巴多秒级且主体是等待不是 CPU**、**单命令 require 图为一行状态装载 315 个模块含整套网关适配器**、**冷启动文件扫描**。方案 = W1 预热与挂载期治理（P0）、W2 require 图瘦身（P1）、W3 单体打包评估（P2，需独立评审）、W4 daemon 备选（P3，沿用 PERF-006）。

---

## 一、需求五问（`RUNTIME-008`，source 均为本轮用户原话）

| # | 问题 | 答案 |
|---|------|------|
| 1 | 谁用？ | 每天开终端敲 `khy` 的维护者与最终用户（source：「khyos启动太慢了」——主语是日常使用者） |
| 2 | 什么时候用？ | 每次敲 `khy`（TUI）、`khy status` 等单命令时；以及用户拿 claude code / opencode 对比时（source：「为什么claude code和opencode启动很快」） |
| 3 | 现在的替代做法？ | 等；或绕过包装层直跑 `node runtime/node/backend/bin/khy.js`（省 Python 启动器链 ~950ms，不解决大头） |
| 4 | 成功长什么样？ | 命令：PTY 探针（§7.1）+ `Measure-Command`。期望：`khy` TUI 启动屏首帧 p50 < 3s；`khy status` 热启动 p50 < 300ms；装机后首次启动（冷）< 3s |
| 5 | 不做会怎样？ | 用户继续拿「别人 47ms 我家 12s」做判断，平台入口被 claude/opencode 类工具架空 |

---

## 二、实测基线（2026-10-10，复现命令见 §七）

### 2.1 四条路径墙钟（同机同条件）

| 路径 | 冷（首次） | 热（连跑） | 说明 |
|---|---|---|---|
| `claude --version` | 203ms | **47ms**（三次 203/49/46） | Bun 单体二进制，247MB |
| `claude.exe` TUI 首帧（PTY 探针） | — | **~150ms** 出完整 logo 画面，随后联网报 403（本机未配 API，与启动无关） | UI 先行、网络后查的直接证据 |
| `opencode --version` | 3210ms | **~1.3s**（三次 3210/1329/1374） | Bun 单体二进制，172MB；**并不快** |
| `opencode` TUI 进备用屏（PTY 探针） | — | **4143ms** | 比 khy 快约 3 倍 |
| `khy --version` | — | **~101ms** | 快速路径（不经 bootstrap） |
| `khy status`（直跑 node） | **16982ms** | **525/567ms**（两次） | 冷=compile cache 冷 + Defender |
| `khy` TUI 启动屏首帧（PTY 探针） | 19633ms | **11929/12202ms**（两次；另一次 5/5 就绪段就花了 5.5s） | 见 §2.2 时间线 |

> 如实更正用户前提的一半：**opencode 的 `--version` 在本机 1.3s，比 khy status 还慢**；用户感知的「opencode 快」对应的是它的 **TUI 就绪 4.1s vs khy 12s+**。claude 则是全面快（47ms / 150ms）。三条对比都建立在「Bun 单体二进制」这同一结构差异上。

### 2.2 TUI 启动时间线（PTY 探针，百分比为启动行实时曲线）

| 里程碑 | run A | run B | run C |
|---|---|---|---|
| first-output | 348ms | 239ms | 154ms |
| ✓ 就绪 5/5（env+认证+setup） | 1246ms | 1538ms | **5518ms** |
| 加载渲染引擎 36% | — | 1879ms→36% | 6868ms |
| 65% | — | 3205ms | 7944ms |
| 71%（ stalled ~2.7s 到下一格） | — | 6868ms 后 9922ms 到 75% | 10623ms |
| 进备用屏 `\x1b[?1049h` | 11578ms | 19469ms | 11978ms |
| 启动屏首帧可见 | 11929ms | 19633ms | 12202ms |

判读：**「就绪 5/5 → 进备用屏」这段（ink 装载 + App 挂载）是 12s 里的主体**，且 run 间方差 11.6→19.7s，与 PERF-006 §8.3 的漂移结论一致（同机不同时刻 Defender 突发）。百分比曲线证明停顿分布：65%→71% 一格 2.7s、71%→alt-screen 1.4s——**不是单点，是多段等待叠加**。

### 2.3 单命令 require 图（require 计时钩子，`khy status`）

共 **315 个不同模块请求**，归因累计 ~1850ms（嵌套计入调用方）：

| 顶层 require | 累计 | 子请求数 | 是什么 |
|---|---|---|---|
| `bin/khy.js` 自身顶层 | 326ms | 30 | 入口 + bootstrap/init 链 |
| `../services/gateway/aiGateway` | **257ms** | **49** | **整套网关适配器全家**（claude/codex/cursor/relay/localLLM/webRelay…） |
| `../../multiFreeService` | 133ms | 11 | 免费模型服务 |
| `./ai`（src/cli/ai.js） | 102ms | 26 | AI 对话核心 |
| `../src/utils/logger` | 84ms | 1 | winston 实例（backend 侧） |
| `../src/cli/router` | 74ms | 15 | 命令路由器 |
| `../../vendor/shared/src/utils/logger` | 73ms | 13 | **@khy/shared 侧第二份 winston 图** |
| `jsonwebtoken` | 58ms | 6 | JWT 校验链 |
| `winston` | 51ms | 14 | 日志器本体 |

**关键发现**：`khy status` 只打印 5 行状态，却经 `handlers/gatewayStatusView.js:141` **顶层 require 了整个 aiGateway**（连带 multiFreeService / cli/ai）。claude/opencode 的对应操作（读一份 JSON 配置）不装载任何工具实现。

### 2.4 ink ESM 装载：冷 16.4s / 热 0.9s

| 条件 | `import('ink')` 耗时 |
|---|---|
| 无 compile cache（全新/缓存被清） | **16359ms** |
| 有 compile cache（`module.enableCompileCache()` 后） | **923ms** |

PERF-002 落的 compile cache 把热路径压到 0.9s，**但冷编译 16.4s 从未被摊薄**——见 W1-1：`repair-portable.js` 的装机预热跑的是 `khy status`，而 **status 路径不装载 ink**，于是每个用户机器上的「第一次 `khy`」仍要付这 16s。

### 2.5 CPU / 等待特征

PERF-006 §2.4 实测（`khy status`）：CPU 总样本 ~220ms / 墙钟 830ms，**大头是等待**；PERF-003 无头渲染探针 74s 墙钟仅 ~5s CPU。本文 TUI 曲线（§2.2）同样显示多段秒级停顿而进度条背后无 CPU 密集型工作〔与 PERF-003 结论一致：主体是文件系统 / Defender 扫描与子进程等待，不是同步计算〕。

---

## 三、为什么 claude code / opencode 快（结构解剖）

五条原因，按对本机实测数据的解释力排序：

1. **单体编译二进制，消灭模块解析**。claude.exe / opencode.exe 分别是 247MB / 172MB 的 Bun 编译单体（二进制内含 `bun` 运行时可证）。整个应用是一个文件：没有 `node_modules` 遍历、没有 315 次模块解析、没有按文件计的 Defender 实时扫描。khy 是 CJS + pnpm store 的多文件图——**这是 47ms vs 12s 的第一因**。
2. **UI 先行、网络后查**。claude 首帧 150ms 就画出完整界面， connectivity 检查在画面之后（本机 403 也照样先出画面）。khy 的启动屏结构上依赖 ink 装载完成才能出场（PERF-006 §8.2 已证伪「缺首帧」，但 ink 之前的窗口仍由百分比过渡行覆盖）。
3. **启动图极小、工具懒加载**。claude `--version` 47ms；khy `status` 装载 315 模块含整套网关适配器（§2.3）。工具实现（读写文件、执行命令）在 claude/opencode 里都是用到才加载。
4. **无本地数据库 / 迁移 / 服务器孵化**。khyquant 完整模式要 spawn `server.js` 并轮询端口就绪（`POLL_TIMEOUT` 10s 预算，bin/khy.js `startWithServer()`）；khy 模式虽跳过服务器，启动链仍过认证 + setup + 网关预热。claude/opencode 的持久状态是少量 JSON 文件。
5. **运行时差异（Bun vs Node）**。Bun 单文件 mmap + 启动路径更短；但 opencode `--version` 1.3s 说明「编译型」并非万能——**结构（单体+懒加载）比运行时更值钱**。

---

## 四、与 PERF-006 的关系（不重复劳动）

| 文档 | 已覆盖 | 本文增量 |
|---|---|---|
| PERF-002 | compile cache / KHY_FAST_STARTUP / 顶层 require 瘦身 | 新实测：compile cache 热/冷两面的 16.4s 缺口未被预热覆盖 |
| PERF-006 | W2 单命令快路径（git 探针并行+TTL、chcp 条件化）、W3 Defender 提示+预热、W1 证伪更正 | **对标视角**（claude/opencode 同机实测 + 结构解剖）；W2 剩余项重新定位到 require 图（status→aiGateway）；指出 PERF-006 W3 预热的覆盖漏洞（§2.4） |
| PERF-003 | 挂载期阻塞归因 + 探针 + 「同步工作要被消化」判据 | 继承为 W1-2 的约束：先取真实 TTY 挂载期 profile 再动手 |

---

## 五、方案

### W1（P0）TUI 首帧：12s → 目标 p50 < 3s

| # | 措施 | 预期收益 | 判据 / 风险 |
|---|---|---|---|
| W1-1 | **预热覆盖 ink**：`repair-portable.js` 的 `warmupAndHint()` 当前 spawn `khy status`——status 不装载 ink，16.4s 冷编译从未被摊薄。改为预热链追加一次 TUI 装载（PTY 下起到 alt-screen 即收，或直接 `node -e "import('ink')"`） | 装机后首次 `khy` 的 ink 窗口 16.4s → <1.5s | 机制层证据：预热前后 `import('ink')` 耗时对照；不得以「跑了 status」充当完成依据 |
| W1-2 | **挂载期尾巴归因**：按 PERF-003 判据（消化，不平移），先给 PTY 探针的子进程传 `--cpu-prof` 且改为优雅退出后采样，列出 65%→71%、71%→alt-screen 两段的同步 IO / spawn / 网络清单，逐项后台化或预缓存 | 多段秒级停顿逐项消减 | **先列清单再动手，不盲改**（`RUNTIME-007`）；PERF-006 两次取 profile 失败，本次须换采样方式 |
| W1-3 | **首帧窗口内的非首帧工作外移**：核对 `_kickoffGatewayPinStartupCheck` / `_scheduleStartupUpdateCheck` / clipboard bridge 是否在 alt-screen 前占事件循环或同步段；能后移的后移到首帧之后 | 每项 ~百 ms 级〔推测〕 | 行为等价重构；门控保留可回退 |

### W2（P1）单命令 require 图：status 530ms → 目标 p50 < 300ms

| # | 措施 | 预期收益 | 判据 / 风险 |
|---|---|---|---|
| W2-1 | **status 不再装载 aiGateway**：`gatewayStatusView.js:141` 顶层 require 改为按需（只取状态字段），或改读 hudRenderer 已有的磁盘缓存 + 网关快照，不拉 49 个适配器 | -257ms 及其链式（multiFreeService -133ms / cli/ai -102ms 若仅服务 status） | 输出逐字节不变（同一份数据两个来源要对账）；缓存 TTL 沿用 30s |
| W2-2 | **logger 去重**：CLI 路径同时装载 backend `utils/logger` 与 `@khy/shared` logger 两份 winston 图（84+73+51ms）。让 CLI 共用一份，或延迟到首次真正写日志 | -100~150ms | 文件 transport 全量落盘的行为不许变；warn/error 仍直达用户 |
| W2-3 | **JWT 链懒加载**：jsonwebtoken 58ms 出现在 status 路径，查调用方（clAuth/session）按需拉 | -58ms | status 不碰认证语义；交互路径不变 |
| W2-4 | **router handler 分簇懒加载**（PERF-002 阶段 C 延续）：按命令簇拆 require，`khy status` 不编译 gateway/quant 全簇 handler | 余下 74ms 里再省〔推测 30-50ms〕 | 以 startupProfiler / require 钩子逐项前后对照 |

### W3（P2）冷启动治理

1. **Defender 排除提示**沿用 PERF-006 W3（只提示不代改）。
2. **首启预热**改为覆盖完整装载链（W1-1），把「第一次 17s」摊到装机时刻。
3. **pnpm store → 打包产物**的评估见 W4。

### W4（P3，需独立评审）结构性方案：单体二进制

对标 claude/opencode 的**唯一结构性差距**：用 Bun（`bun build --compile`）或 esbuild 打包 + Node SEA，把 CLI 热路径（bin/khy.js + bootstrap + router + status/gateway 视图 + ink/react）打成**单文件**；`node_modules` 只留原生/可选依赖（better-sqlite3、pg、node-pty）外置。

- **收益**：消灭 315 次模块解析与按文件计的扫描——claude 47ms 的第一因。
- **成本与风险**（逐条需评审）：
  - CJS→ESM 边界：ink 本就是 ESM（有利），但 backend 是 CJS 海；babel/esbuild 转换链要进构建；
  - 懒加载 handler 的动态 `require` 形态改变，`moduleSelfHeal` 的 MODULE_NOT_FOUND 自愈失去作用面（其存在理由之一正是路径迁移后的引用断裂）；
  - 发布链：三轨道版本（`PROCESS-002`）+ SBOM + 签名 + 镜像同步全部要重接；构建产物登记 `BUILD-OUTPUTS.json`（`LAYOUT-005`）；
  - 软著登记材料：Bun 运行时属第三方代码，**不进 60 页选材**（`PROCESS-010` C-X3），选材仍以仓内 CJS 真源为准；
  - 包体积 ~100MB+，安装/修复脚本（`repair-portable.js` 等）要适配。
- **立项条件**：W1–W3 落地后 TUI p50 仍 >3s 或 status p50 仍 >300ms。**不在本轮范围**，本文只留评估结论与门槛。

### W5（P3，备选）daemon

沿用 PERF-006 W4（常驻 Node + 薄客户端 IPC），不展开；仅当 W4 也不达标时再议。

---

## 六、落地顺序与阶段约束（`PROCESS-008`）

1. **顺序**：W1-1（低风险高确定，先修预热漏洞）→ W2-1/W2-2（机制层证据明确）→ W1-2（先取 profile 列清单）→ W2-3/W2-4 → W3 → 视达标情况决定 W4 / W5。
2. 修复类改动集存证落 `.khy/feedback/DESIGN-PERF-007/`（`repro-before.txt` / `repro-after.txt` 用同一探针、同一命令）；本文当前为**提案**，未改任何代码，故无 before/after 对——**未量体温就不开药**（`RUNTIME-007`），§七的命令即体温计。
3. 每项验收用 §七 探针跑 **20 连跑取 p50**，且墙钟必须「同刻逐对交错」、机制层证据（spawn 数 / require 数 / 缓存命中）优先（PERF-006 §8.3 纪律）。
4. 本文所有措施均为启动路径重构，**不新增拦截型机制**，不走四阶段升阶；若 W4 引入新的启动门禁（如打包产物校验），按其自身性质从 S1 起。

---

## 七、度量命令（本机可复现）

```bat
:: 7.1 TUI 启动里程碑（真实 ConPTY；探针 .khy\tmp\perf-probe\tui-boot-probe.js，本机态）
::     里程碑：first-output / 就绪5/5 / 百分比曲线 / alt-screen / 启动屏首帧
node .khy\tmp\perf-probe\tui-boot-probe.js node runtime\node\backend\bin\khy.js
node .khy\tmp\perf-probe\tui-boot-probe.js D:\Portable\Tools\opencode\opencode.exe
set CLAUDE_CONFIG_DIR=D:\Portable\Tools\claude
node .khy\tmp\perf-probe\tui-boot-probe.js D:\Portable\bin\claude.exe --dangerously-skip-permissions

:: 7.2 单命令墙钟（PowerShell）
Measure-Command { node runtime\node\backend\bin\khy.js status }
Measure-Command { claude --version }

:: 7.3 require 图归因（钩子 .khy\tmp\perf-probe\require-hook.js；嵌套计入调用方）
set NODE_OPTIONS=--require D:/Portable/khy-os/.khy/tmp/perf-probe/require-hook.js
node runtime\node\backend\bin\khy.js status

:: 7.4 ink ESM 冷热对照
node -e "const t=Date.now();import('ink').then(()=>console.error('ink cold: '+(Date.now()-t)+'ms'))"
node -e "require('module').enableCompileCache();const t=Date.now();import('ink').then(()=>console.error('ink warm: '+(Date.now()-t)+'ms'))"

:: 7.5 交错 A/B（现成工具，勿在有未提交改动时跑 stash 变体）
npm run bench:startup
```

> 探针为**本机态**（`.khy/` gitignore），换机器时按 §7.1 路径重建；两份探针共约 120 行，无第三方依赖（tui 探针用仓库已装的 `node-pty`）。

---

## 八、范围边界（不做的事）

- **不碰 Python 启动器链**：`khy.bat` 已损坏（PERF-006 §七）另案修；`--version` 底板 ~950ms 的 Python 链成本不在本文。
- **不为提速牺牲状态透明**（`RUNTIME-002`）：百分比曲线是既有合规形态，W1 各措施只消减其背后的等待，不把曲线改回含糊文案。
- **不自行启动 W4**：触及发布链（`PROCESS-002`/`PROCESS-013`/`PROCESS-014`）与软著选材（`PROCESS-010` C-X3），须人拍板后独立立项。
- **不把 claude/opencode 的代码或二进制搬进本仓**：对标只学结构（单体+懒加载+UI 先行），实现仍是本仓自己的事（`[DESIGN-SOURCING-001]`）。
