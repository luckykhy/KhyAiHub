<!-- IMPL-STATUS: done -->
# [DESIGN-ARCH-182] Watchdog 阻塞归因分化：同步长任务与进程被停走区分方案

> **状态**：**一期已落地（A + 接线 + 测试，2026-10-05；落地清单见 §13，偏离见 §14）** · **日期**：2026-10-05 · **编号**：[DESIGN-ARCH-182] · **落点目录**：`docs/03_DESIGN_设计/`
> **族属**：运行时可观测族（`sessionWatchdog` / `runtimeResourceProbe`）；兄弟案 `[DESIGN-ARCH-180]`（资源探针判据分档，已落地）
> **证据基准**：2026-10-05 用户截图（PowerShell 交互会话两行告警）+ 源码逐行复核 + 既有测试基线实测（jest 24/24 绿）

---

## 0. 一句话结论

截图里那行 `[Watchdog] 事件循环曾阻塞 383.3s（同步长任务或死循环嫌疑），现已恢复调度。`
**大概率是冤案**：同屏的资源探针已判定「机器余量 空闲 10%/≥15%……**非 khy 缺陷**」。
383s 的「阻塞」最可能是**整个进程被停走**（低余量换页 / 系统休眠 / 被调度走），
不是 khy 在跑同步长任务。病灶：stall 检测器只证明「计时器晚到了」，
文案却断言了归因。方案 = 用 `process.cpuUsage()` 窗口增量 + `os.freemem()`
做**零 spawn 归因**，按归因分化文案与处置，环境性停滞不再背「死循环嫌疑」。

| 环节 | 位置（`runtime/node/backend/src/services/`） | 问题 |
|---|---|---|
| 检测 | `sessionWatchdog.js:616-627` | drift = 计时器晚到的时长；同步阻塞 / 换页停走 / 休眠三种原因**不可区分** |
| 文案 | `sessionWatchdog.js:519` | 硬编码「同步长任务或死循环嫌疑」——把三种可能说成一种 |
| 上屏政策 | `sessionWatchdog.js:525-526` | 单次 ≥ `stallAlertMs`(300s) 必报 ⇒ 383.3s 触发单条上屏 |
| 同屏矛盾 | `runtimeResourceProbe.js:354` | 资源探针同屏说「低于判据（**非 khy 缺陷**）」——两条消息归因打架 |
| 早有预言 | `runtimeResourceProbe.js:271` | 「可用内存只剩 N%……此时任何常驻开销都会**因换页被放大成卡顿**」——探针知道会卡，watchdog 不读 |

**判别性事实（方案立足点）**：真同步阻塞期间进程烧满单核，`process.cpuUsage()`
窗口增量 ≈ drift × 单核；进程被整体停走（换页/休眠/调度）时增量 ≈ 0。
`process.cpuUsage()` 是 Node 内置、微秒精度、**零 spawn** —— 与
`runtimeResourceProbe.js:4` 的 zero-spawn 原则一致，恢复瞬间采样不放大卡顿。

---

## 1. 现状实证

### 1.1 截图逐行对源码（2026-10-05 用户会话）

| 截图原文 | 出处 | 判定 |
|---|---|---|
| `[Watchdog] 事件循环曾阻塞 383.3s（同步长任务或死循环嫌疑），现已恢复调度。` | `sessionWatchdog.js:519` | 归因**未经验证** |
| `资源 环境：机器余量 空闲 10%/≥15%，低于判据（非 khy 缺陷）。处置：先释放系统侧占用…clipboard bridge stop 去掉约 85 MB 常驻内存` | `runtimeResourceProbe.js:354`（`buildResidencyNotice` 的环境段，`:321` `SESSION_ENVIRONMENT_IDS`） | 归因**有读数支撑** |

### 1.2 检测机制的物理极限（文件头自述）

`sessionWatchdog.js:22-25`：sync stall 期间**什么都不可能运行**，只能事后由 beat
漂移观测。⇒ 「期间检测」无解，但「事后归因」有解 —— 本方案做的是后者。

### 1.3 三种归因的判别表

| 归因 | `cpuUsage` 窗口增量 | 典型伴生 |
|---|---|---|
| 真同步长任务 / 死循环 | ≥ drift 的 50%（单核打满） | 风扇起、其他程序不卡 |
| 换页停走（低余量） | ≤ drift 的 5%（≈0） | `freemem` 低于 15% 判据、全系统都卡 |
| 系统休眠 / 挂起 | ≈ 0 | wall-clock 大跳变，常跨小时 |

### 1.4 既有测试基线（2026-10-05 实测，验收的尺子）

| 跑法 | 结果 | 说明 |
|---|---|---|
| `node node_modules/jest/bin/jest.js tests/services/__tests__/sessionWatchdog.test.js` | **24/24 绿**（25.7s） | 本提案的回归基线 |
| `node --test <同文件>` | 红（`describe is not defined`） | **既有伤情**（jest 风格文件被 node 扫描误伤，与 `cliFailureEnvelope.test.js` 同型），非本提案引入、不在本提案修 |

---

## 2. 借鉴提案（B-P2）：非借鉴类，逐字段据实填「不适用」

本提案修的是**本仓自有缺陷**（watchdog 文案断言了未验证的归因），零外部借鉴。

| # | 字段 | 填写 |
|---|---|---|
| 1 | 借鉴对象 | 不适用 —— 零借鉴，无上游 |
| 2 | 借鉴内容 | 不适用 —— 归因方法（`process.cpuUsage()` 增量判别）是 Node 内置 API 的直接运用 |
| 3 | 解决的问题 | 本仓具体缺口：`sessionWatchdog.js:519` 文案断言归因而检测器不支持该断言（§0 病灶表） |
| 4 | 许可证与代码性质 | 不适用 —— 不引入任何外部代码/资源 |
| 5 | 借鉴方式 | 不适用 —— 无借鉴对象，不触发 `idea`/`reference`/`adapter`/`vendored`/`fork` 任一 |
| 6 | 落点与现有实现对比 | 落点 `services/stallAttribution.js`（新增纯叶子）+ `services/sessionWatchdog.js`（接线）；搜过 `cpuUsage`/`freemem`/`stall`/`归因`（`src/services/`、`src/cli/tui/`），无既有归因实现，非并行真源 |
| 7 | 验收方式 | §7：jest 基线 24/24 零回归 + 新增 node:test 归因用例全绿 + 负对照精确捕获 |

**B-P1 豁免判定**：对已登记能力域的行为修正（bugfix），**零新增配置键**
（阈值走常量 + opts 注入，不开 `KHY_*` 门 —— 门预算 `MAX_GATES=227` 已顶格，
`scripts/ci/check-tui-gates.js:41`）⇒ 豁免成立，且本表已按体例逐字段填齐。

---

## 3. 目标形态

### 3.1 归因叶子（新增 `services/stallAttribution.js`）

纯叶子：零 IO（原始读数由调用方采好传入）、确定性、绝不抛、绝不读 env、不改入参。

```js
// classifyStall({ driftMs, cpuDeltaUs, freePct })
//   → { kind: 'sync' | 'external' | 'unknown', cpuRatio, reason }
const SYNC_CPU_RATIO = 0.5;      // 窗口内单核占用 ≥50% ⇒ 真同步阻塞
const EXTERNAL_CPU_RATIO = 0.05; // ≤5% ⇒ 进程被整体停走
```

- `cpuRatio = cpuDeltaUs / (driftMs * 1000)`（µs 对 ms 换算）
- `freePct` 只作**文案佐证**（「当前空闲 N%」），不作硬判 —— 判据唯一真源仍在
  `runtimeResourceProbe`（`FLOOR_FREE_MEM_PCT`），本叶子不抄它，避免第二真源

### 3.2 watchdog 接线（只动 `sessionWatchdog.js` 内部，宿主零改动）

- 每拍 beat 顺手记 `lastCpu = process.cpuUsage()`（两个数，零成本）；
  drift ≥ `stallMs` 时算 `cpuDeltaUs` 并采一次 `os.freemem()`
- `recordStall(driftMs)` → `recordStall(driftMs, attribution)`；安装点
  （`replSession.js:870` / `tui/app.js:95`）不需要动
- 文案分化：

| 归因 | 文案（示意，落地时定稿） |
|---|---|
| `sync` | `[Watchdog] 事件循环曾阻塞 Xs（同步长任务嫌疑：期间本进程 CPU 打满约 Ys/Xs），现已恢复调度。若反复出现，设 STARTUP_PROFILE=1 启动一次定位慢子树。` |
| `external` | `[Watchdog] 事件循环曾停滞 Xs——期间本进程几乎未获 CPU（≈0s/Xs），系统换页/休眠/调度嫌疑，非 khy 同步任务。处置：先释放系统侧内存（当前空闲 N%）；低余量机器可 clipboard bridge stop 省约 85 MB。` |
| `unknown` | 两种可能如实并列，不猜。 |

- burst 合并行（`:540-542`）同样带归因；`stats().stalls` 增 `byAttribution` 计数
- **上屏政策不动**：quiet 默认、单次 ≥300s 仍报 —— 383s 的冻结用户能感知，
  该报，但措辞和处置必须指对方向

### 3.3 与资源探针的边界

watchdog **不 require** `runtimeResourceProbe`（两个职责不耦合）；
处置语与探针 hint 对齐（`clipboard bridge stop` 省约 85 MB）但各自维护——
两处文案若漂移，属于可接受的提示语冗余，不构成判据分叉。

---

## 4. 实施分期（每期独立可回滚）

| 期 | 内容 | 回滚 |
|---|---|---|
| 一期（核心） | `stallAttribution.js` 叶子 + watchdog 接线 + 文案分化 + 新增 node:test 用例（**另建文件**，不追加进 jest 风格文件） | 撤 `recordStall` 一处调用即回旧行为 |
| 二期 | `stats()` 归因计数暴露；`external` 且当前低余量时处置语与探针 hint 对齐 | 撤 stats 字段 |
| 三期（可选） | `khy doctor` 增加「最近 stall 归因」展示（读 stats，不改判定） | 撤 doctor 段 |

---

## 5. 诚实边界（刻意不纳入）

| 不做 | 原因 |
|---|---|
| 阻塞「期间」的检测 | 物理不可能（`sessionWatchdog.js:22-25` 自述），只能事后归因 |
| 自动处置（自动 `clipboard bridge stop` / 杀进程） | 处置权在用户（`runtimeResourceProbe.js:280-281` 的既有公理：报告成本，处置留人） |
| 调整 `stallAlertMs` / quiet 政策 | 那是 2026-09-23 降噪政策的既有平衡，本提案不动 |
| 改动 `runtimeResourceProbe` 的任何判据 | 180 号已落地，本提案不碰 |
| 归因到具体系统进程（谁抢的内存） | 需要 spawn / 性能计数器，违背 zero-spawn 原则 |
| 修 jest 风格文件被 `node --test` 误伤的既有伤情 | 同型受害者至少三处，是独立条目，不顺手修 |

---

## 6. 反模式（这条路别走）

| ❌ 别做 | 为什么 |
|---|---|
| 调大 `stallAlertMs` 或把超长 stall 也静音 | 掩盖真死循环信号；quiet 政策本意是降噪不是灭迹 |
| 加 `KHY_*` env 开关控制归因 | 门预算 227 已顶格；「让归因正确」不构成用户可见权衡；还会把 B-P1 豁免变成非豁免 |
| spawn `wmic` / PowerShell 取系统指标 | 违背 `runtimeResourceProbe.js:4` 的 zero-spawn 原则；恢复瞬间进程正卡，spawn 放大卡顿 |
| 把 `freePct < 15%` 的判据抄进 watchdog | 第二真源。`freePct` 只做文案佐证，判据永远属于 `runtimeResourceProbe` |
| 用 wall-clock 跳变当唯一休眠判据 | 换页停走不产生「跳变感」；`cpuUsage` 增量才是判别性证据 |
| 把新用例追加进 jest 风格的 `sessionWatchdog.test.js` | 一个文件被两套 runner 扫到（jest 因 `describe(` 命中、node --test 因 glob 命中）；另建文件 |

---

## 7. 验收方式

| # | 项 | 判据 |
|---|---|---|
| V1 | 回归基线 | `node node_modules/jest/bin/jest.js tests/services/__tests__/sessionWatchdog.test.js` **仍 24/24 绿**（2026-10-05 实测基线） |
| V2 | 归因用例 | 新增 node:test 文件（`tests/services/stallAttribution.test.js`）：`cpuDeltaUs≈0` → `external`；`≈drift×单核` → `sync`；中间 → `unknown`；畸形入参 fail-soft | ✓ 实测 10/10（§13.2） |
| V3 | 接线用例 | 注入假 `cpuUsage` 序列驱动 watchdog 的 stall 路径，断言 external 文案不含「死循环嫌疑」、sync 文案保留原语义 | ✓ 实测 7/7（`sessionWatchdogAttribution.test.js`） |
| V4 | 负对照 | 把 `SYNC_CPU_RATIO` 改成 1.1 ⇒ sync 用例必须红；还原后逐字节一致 | ✓ 实测 3/3 捕获（§13.2 V4） |
| V5 | 门禁 | `npm run check:changed` 绿；`scripts/ci/check-leaf-contract.js` 对新叶子 PASS；`check-tui-gates` 零新增门（本地该脚本因旧路径 ENOENT 不可核，属已知伤情，以「不新增 `KHY_*` token」自查代替） | ✓ 叶子契约 PASS；`KHY_` token 集合 HEAD 5 = 工作区 5（§13.2 V5）。⚠ `check:changed` 本轮**未跑**，理由见 §13.2 V8 |
| V6 | CI 纪律 | `runtime/node/backend/tests/**` 会被 `test:node` glob 扫到 ⇒ 新用例一律 `require('node:test')`、落地即绿 |

真实环境复核（非阻断）：用户机器空闲 10%，复现条件现成 —— 落地后下次
383s 级停滞再现时，文案应变为 external 归因并指向释放系统内存。

---

## 8. 待核实项

| # | 项 | 影响 |
|---|---|---|
| Q1 | `SYNC_CPU_RATIO=0.5` / `EXTERNAL_CPU_RATIO=0.05` 在真低余量机器上复核一次 | 只调阈值常量，不动结构 |
| Q2 | `freePct` 是**恢复后**采的，阻塞期间的值不可知 ⇒ 文案只能说「当前空闲 N%」，不声称因果 | 已反映进文案约束 |
| Q3 | TUI 下 notice 走 `noticeInbox.js`（BUG-17 定论），长文案是否折行破坏帧预算 | 实施时按 `chromeBudget.js` 账本核一次，超长则截断 + 全文进 stats |

---

## 9. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-10-05 | 初版。用户截图两行告警逐行对源码；定位病灶为「检测器只证晚到、文案断言归因」；找到判别性证据（`process.cpuUsage()` 窗口增量）；实测 jest 基线 24/24 绿；给出三归因分化方案（叶子 + 接线 + 文案），含 B-P2 豁免填表、4 条边界、6 条反模式、6 项验收、3 项待核实。 |
| 2026-10-05 | **一期落地**（§13/§14）。新增 `src/services/stallAttribution.js` 纯叶子；`sessionWatchdog.js` 接线（beat 记 `process.cpuUsage()` 增量 + `os.freemem()`，文案三分化，burst 合并行带归因，`stats().stalls.byKind`，`onHang` 增 `attribution`/`cpuRatio`）；新增两个 `node:test` 文件（叶子 10 条 / 接线 7 条）。实测：叶子 10/10、接线 7/7、jest 基线 **24/24 零回归**、邻居套件 17/17、叶子契约 PASS、**零新增 `KHY_` 门**（HEAD 5 = 工作区 5）；负对照 3/3 被精确捕获且还原逐字节一致；截图读数端到端判为 `external`（CPU 占比 0.026%）。落地中真抓到 2 个缺陷（`Number(null)===0` 把「无读数」判成 external；测试假体按调用计 CPU 而非按墙钟），均已修并被用例钉住。 |

---

## 13. 实施记录（一期，2026-10-05）

### 13.1 落地清单

| 文件 | 动作 | 要点 |
|---|---|---|
| `runtime/node/backend/src/services/stallAttribution.js` | **新增** | 纯叶子：`classifyStall()` / `stallNoticeLine()` / `KINDS` / 两个阈值常量。零 `require`、零 env、零 IO、绝不抛 |
| `runtime/node/backend/src/services/sessionWatchdog.js` | 改 | ①beat 基线记 `process.cpuUsage()`，drift 时算 `cpuDeltaUs` + `os.freemem()`；②`recordStall(driftMs, attribution)` 三分支文案；③burst 合并行带 `_burstAttribution()` 归因摘要；④`ledger.stallByKind` + `stats().stalls.byKind`；⑤`onHang` 增 `attribution` / `cpuRatio`；⑥三个注入面 `opts.cpuUsage` / `opts.freemem` / `opts.totalmem`；⑦头部文档 + JSDoc 补归因契约 |
| `runtime/node/backend/tests/services/stallAttribution.test.js` | **新增**（node:test，10 条） | 三分类、阈值含边界、无比率 ⇒ unknown、入参不改、fail-soft、三种文案 |
| `runtime/node/backend/tests/services/sessionWatchdogAttribution.test.js` | **新增**（node:test，7 条） | 走真 `installSessionWatchdog`：sync / external / 静默不 suppression / 混合 burst / 探针抛错 / 探针返 null / stats 闭合 |

**安装点零改动**：`replSession.js:870` 与 `tui/app.js:95` 都没碰（归因全在模块内部完成）。

### 13.2 验收实测

| # | 项 | 结果 |
|---|---|---|
| V1 | jest 基线 | **24/24 绿**（`tests/services/__tests__/sessionWatchdog.test.js`）—— 4 处盯文案的断言（`事件循环曾阻塞` / `阻塞 N 次` / `最长` / `均已自动恢复调度`）**一字未改即通过** |
| V2 | 归因用例 | 叶子 **10/10**、接线 **7/7** |
| V3 | 接线判据 | 注入假 `cpuUsage` 驱动真 stall 路径，external 文案不含「死循环」、sync 保留原告警语义 |
| V4 | 负对照 | **3/3 精确捕获**：NEG1 `SYNC_CPU_RATIO=1.1` → 叶子红 3 + 接线红 1；NEG2 `EXTERNAL_CPU_RATIO=-1` → 叶子红 3 + 接线红 2；NEG3 断接线（`classifyStall({driftMs})` 不传 cpuDeltaUs）→ 接线红 3。还原后两份源码**逐字节一致** |
| V5 | 门禁 | `check-leaf-contract` 对新叶与 watchdog 均 `no violations found`；`KHY_` token 集合 HEAD 5 = 工作区 5，`added=[]` / `removed=[]`；邻居套件（resourceGuard / backgroundShell / watchdogService）**17/17** |
| V6 | CI 纪律 | 两个新文件都用 `require('node:test')`，`jest.config.js` 会自动 ignore，落地即绿 |
| V7 | 端到端 | 截图读数（383.3s + 空闲 10% + 低 CPU）⇒ `{"kind":"external","cpuRatio":0.00026}`，文案见 §13.3 |
| V8 | 改动归属 | 工作区 `git status --porcelain` 共 **851** 项改动，其中**只有 4 项属本提案**（3 个新文件 + `sessionWatchdog.js`）；其余 847 是并行车道的 R1-R4 迁移。`git diff -U0` 核过：`sessionWatchdog.js` 23 hunk / +120 / **-9**，9 行删除全是本次归因工作，**无他人 hunk 夹带**。⚠ 也正因如此，本轮**没跑 `check:changed`** —— 它的判定会被 847 项他人改动淹没，报红无法归因（§6.5 三步法的前提是先有干净基线） |

### 13.3 端到端文案对照（实测输出，非手写）

**改前**（同屏两行自相矛盾）：

```
[Watchdog] 事件循环曾阻塞 383.3s（同步长任务或死循环嫌疑），现已恢复调度。
资源 环境：机器余量 空闲 10%/≥15%，低于判据（非 khy 缺陷）。处置：先释放系统侧占用…
```

**改后**（同一读数）：

```
[Watchdog] 事件循环曾停滞 383.3s——期间本进程几乎未获 CPU（约 0.1s/383.3s），系统换页/休眠/调度嫌疑，非 khy 同步任务。处置：先释放系统侧内存（当前空闲 10%）；低余量机器可 clipboard bridge stop 省约 85 MB。
```

**若是真同步长任务**（同一时长、CPU 打满 99%）：

```
[Watchdog] 事件循环曾阻塞 383.3s（同步长任务嫌疑：期间本进程 CPU 占用约 379.5s/383.3s），现已恢复调度。若反复出现，设 STARTUP_PROFILE=1 启动一次定位慢子树。
```

### 13.4 落地中抓到的两个真缺陷（都不是「测试写错」）

| # | 缺陷 | 后果 | 修法 | 钉它的用例 |
|---|---|---|---|---|
| E1 | `_finite(null)` 走 `Number(null) === 0` | 探针**没读到数**会被判成「烧了 0 CPU」⇒ 直接判 `external` —— 把「无读数」变成一个结论，正是本提案要消灭的那类错误 | 改为类型收紧：只收 number / 非空数字串，其余一律 null | `no usable measurement says so instead of accusing khy`、`a probe returning null is "no reading", not "zero CPU"` |
| E2 | 测试假体按**调用次数**计 CPU | `process.cpuUsage()` 是**按墙钟连续**累加的；按调用计数让 sync 分支在测试里永远测不到（曾误判为接线失败） | 假体改为按 `Date.now()` 差 × `rate` 累加，`rate` 可在拍与拍之间切换 | `a busy stall is reported as a sync block`、`a mixed burst…` |

> E1 是本提案最有价值的产出：**如果只写「外部停滞」这一侧而不测「读数缺失」，就会把第三种情况错判成第四种。**

---

## 14. 落地偏离表（方案 §3 写的那样 vs 实际做法）

| # | 方案原写 | 实际做法 | 依据 |
|---|---|---|---|
| D1 | `classifyStall({ driftMs, cpuDeltaUs, freePct })` 收三个入参 | 同上，但 `freePct` **只进文案不进判定**，且不作为必填 | 方案 §3.1 已声明「只作文案佐证」；落地把它写成显式契约（叶子 docstring + JSDoc 各写一遍），避免后来者把它当判据用 |
| D2 | （未列） | 新增 `_burstAttribution(byKind)`，burst 合并行**点名每种归因各几次** | 方案 §3.2 只说「burst 合并行带归因」。实测发现若只报总数，合并行会把「1 次 sync + 2 次 external」压成「阻塞 3 次」——恰好复现了本提案要消灭的那种失真 |
| D3 | （未列） | 归因**不参与**上屏决策，仅换措辞 | 落地时确认：若让 external 静默，就等于「因为不是我的问题所以不告诉你」——与 2026-09-23 quiet 政策「静默是常态但绝不失明」相悖。已由 `attribution never suppresses a line the policy already owed` 钉住 |
| D4 | （未列） | 新增三个 `opts` 注入面（`cpuUsage` / `freemem` / `totalmem`） | 方案 §7 V3 要求「注入假 `cpuUsage` 序列驱动」，这三条就是那个注入面。**不是 env 门**，不影响门预算 |
| D5 | （未列） | 既有 jest 套件**一字未改** | 方案 §7 V1 预期「24/24 仍绿」。原以为盯 `事件循环曾阻塞` 的断言会因文案分化而失效；实测发现测试用真自旋阻塞（烧 CPU）⇒ 判 `sync` ⇒ 原文案逐字命中，**连断言都不用改**。这条运气来自 §13.4 E2 揭示的事实：真实自旋就是烧 CPU |

> ⚠ **本轮未做**（按方案 §4 分期，二/三期不在本次范围）：
> 二期 `stats()` 归因计数已随接线一并落地（`stalls.byKind`），但**「external 且低余量时处置语与探针 hint 联动」未做**——
> 现在的处置语是固定文案（`先释放系统侧内存…`），`freePct` 只作读数展示，不驱动措辞分叉；
> 三期 `khy doctor` 的「最近 stall 归因」展示**未做**。
> Q1（阈值 0.5 / 0.05 的真机复核）**仍是待办**：本次只做了合成读数验证，
> 你机器上「下次真出现 383s 级停滞时是否判成 external」只有等真实复发才能确认。


