# [DESIGN-PERF-004] TUI 动画节拍治理方案

<!-- RULES-REGISTRY: RUNTIME-011 -->
> **一句话结论（2026-09-29 订正 —— 此前只看到一半）**：TUI 的「不流畅」有**两个独立成因**：
> **① 动画被主动降频**：`perfTunables` 把节拍当 CPU 旋钮，Spinner 从规范写的 12.5fps 砍到实测 **6.25fps**（漂移 ×2），且全仓无守卫会发现。
> **② 每一帧本来就极贵**：`App.js:6313` 在**渲染体里同步扫盘**（`statSync` + `readdirSync`），实测占一帧 **45%（≈49ms）**，使单帧达 **62–110ms**（16ms 帧预算的 4–7 倍）。
> ⇒ ① 让「贵帧」变少（**用户能看见**，所以被抱怨）；② 让**每一帧**都贵（**不出现在任何用户可见指标里**，所以一直没人发现）。**② 的收益远大于 ①** —— 见 §6 A5。
>
> **状态**：提案（**未接线**）。代码改动仅 A1 第 2 步的首个组件（`TranscriptView` 加 memo，见 §14 #9/#10）；**守卫 / 规则 / 节拍值均未接线**
> **日期**：2026-09-29
> **上游**：[DESIGN-PERF-003]（治启动阻塞）· [DESIGN-ARCH-156]（治帧几何）· [DESIGN-ARCH-115]（启动节拍表）
> **关系**：**不推翻任何既有设计**，补的是它们都没覆盖的一面——**运行期动画节拍**。

---

## 一、问题陈述

### 1.1 用户感知（四类表现）

用户原话：「khyos 的动画不流畅」。逐项确认到四类具体表现：

| # | 表现 | 用户描述 |
|---|---|---|
| ① | 一顿一顿 / 掉帧 | 刷新不匀、帧率不够，肉眼看出跳跃 |
| ② | 动画被跳过或闪现 | 没播完就被下一帧覆盖 / 一闪而过 |
| ③ | 与实际进度不同步 | 假进度、卡住不动、或进度回退 |
| ④ | 起步有明显延迟 | 先静止一段才开始动，或首帧很慢 |

**④ 已被 [DESIGN-PERF-003] 覆盖**（首帧 2885–15867ms，四条阻塞点 B1–B4）。本文**只治 ①②③**，即**运行期**动画。

### 1.2 与既有文档的关系（不是重复劳动）

按 `khyos-design-proposal` 第 0 步的检索纪律，全 `docs/` 按**标题**搜过一遍。结论：

| 文档 | 已覆盖 | 本文的增量 |
|---|---|---|
| `[DESIGN-PERF-001]` / `-002` 交互流畅度修复方案 | 阶段 A 打 bundle / 阶段 B `KHY_FAST_STARTUP` / 阶段 C 顶层 require 瘦身 / 阶段 D 首 token 解耦 | 那是**启动慢**。本文治的是启动完成之后、界面已在跑时的**帧节拍** |
| `[DESIGN-PERF-003]` TUI 启动阻塞治理方案 | 首帧期同步 IO（B1–B4）、L0–L4 方案、渲染期同步代价守卫 | 那是**首帧之前的阻塞**。本文的节拍发生在**首帧之后**，两者时间窗不重叠 |
| `[DESIGN-ARCH-156]` TUI 帧生成管线契约化 | 高度账本、字节出口单一所有者、H1（frame ≤ rows−1） | 那是**帧几何的正确性**（会不会擦掉记录）。本文是**帧的时间分布**（该不该在这一刻画） |
| `[DESIGN-ARCH-115]` TUI 启动板块设计 | 启动节拍表、`startupBeats.js` | 节拍表管**启动**的拍子。本文管**动画**的拍子 |
| `[DESIGN-ARCH-079]/[101]/[102]` TUI 规范三件套 | 交互/展示/视觉规范，`102` §6.4 有 Spinner 条目 | 规范**写了** Spinner 该多快，但**没有任何执行器**。本文补的是「规范 ↔ 实现」的对账机制。⚠ **2026-09-29 订正**：本行初稿写「规范写了 80ms」是**读反了** —— 三篇规范写的是 **160ms**，且 `[101]` §8 冲突 1 **明确裁定「以 perfTunables 的 160ms 为准」，把 80ms 判为陈旧第三源**。规范内部确有冲突，但裁决方向是 **→160**，与 A0 初稿的 80ms 相反（见 §6 A0-b） |
| `docs/tui-interaction-optimize/LOG.md` | 滚轮/拖选、`/stats` 闪现单帧（:190） | 那是**交互事件**通道。本文治的是**动画**通道（两者共用渲染出口，但触发源不同） |

**检索结论**：**没有任何既有文档治「运行期动画节拍 vs 规范的漂移」**。这是真空白，不是重复劳动。

> ⚠ **检索中发现的既有问题（本文不改，仅登记）**：`DESIGN-PERF-001` 编号被**两份不同标题的文档**占用——`khy-cli-交互流畅度修复方案-v1.md` 与 `性能规范.md`；且 `-001` 与 `-002` 两份「交互流畅度修复方案」内容几乎完全相同（`diff` 仅 4 行差异）。按 `[MGMT-STD-008]` §2.2「重叠即违规」这属于既有技术债，**建议单独立项清理**，本文不擅自处置。

---

## 二、现状实证（file:line 可复核）

### 2.1 实测：规范与实现已经漂移

**探针**（只读，零副作用）：

```bash
node .khyos/tmp/anim-probe.js
```

**实测输出**（2026-09-29，本机，无 `KHY_*` 覆盖）：

```
节拍项 | 实际(ms) | 实际fps | 规范(ms) | 出处
Spinner braille | 160 | 6.25fps | 80 | AGENTS.md §3.3「Spinner 80ms / 12.5fps」  ⚠ 漂移 x2.00
topicBar working | 320 | 3.13fps | 180 | 原硬编码 180ms（规范表未列）  ⚠ 漂移 x1.78
elapsed heartbeat | 1000 | 1.00fps | 1000 | AGENTS.md §3.3「状态栏 1000ms / 1fps」  一致
frame budget | 16 | 62.50fps | 16 | AGENTS.md §0.3「单次渲染 < 16ms」  一致

ink 上游节流: maxFps 30 -> throttle 34ms (动画帧率上限 30fps)
LOW_POWER 伞开关下: spinner=320ms topicBar=640ms heartbeat=2000ms
```

> ⚠ **本段是 2026-09-29 A0-a 实施前**的快照**（原读数保留，不追改）**：其中 `topicBar working | 320` 已于同日回正为 **180ms**（§6 A0-a）。Spinner 的 `160 vs 规范 80` 漂移**仍然存在**，但已裁决维持 160（§6 A0-b）—— 故下面这句只作**历史证据**，不代表当前待办。

**这是本文最硬的一条证据**：规范说 12.5fps，实现跑 6.25fps，**差一倍**。

### 2.2 漂移是怎么产生的（作者有据可查的取舍）

`services/backend/src/cli/tui/perfTunables.js:9-19` 的头部注释**自己写明了**：

```
 * Background: profiling showed the busy-state TUI stacks THREE periodic
 * timers — the 80ms Spinner braille rotation, the 1s elapsed heartbeat
 * (App.js nowTick) and the 180ms topicBar working-dot animation — each of
 * which forces an ink re-render. Relaxing cadences cuts idle-busy CPU with
 * no functional change (the animations just tick slower):
 *   - spinnerFrameMs: 80 → 160 (12.5fps → ~6fps; braille rotation stays
 *     visibly smooth at 6fps while halving spinner-driven renders)
 *   - topicBarAnimMs: 180 → 320 (working-dot pulse; still clearly animated)
```

**三个关键事实**：

1. **这是一次有意的降频**，目的是压 CPU（profile 显示三只定时器各自触发 ink 重渲染）。
2. **"no functional change" 这个判断把视觉质量排除在 "functional" 之外** —— 这正是本文要纠正的设计取向。
3. **"stays visibly smooth at 6fps" 是作者的假设，没有实测支撑** —— 与 [DESIGN-PERF-003] 全文用探针量出每一个数字的做法形成对比。该仓自己的纪律是「不接受『声称』当『判据』」，这条恰是反例。

**旁证**：`dragAutoScrollTimer.js:28-30` 的注释解释了为什么它**不**把节拍放进 `perfTunables`：

```
 * ⚠ 节拍为什么留在这里、不进 `perfTunables`(该叶子是本仓计时节奏的 SSOT):
 *      env override 会直接顶破上限;② `perfTunables` 的定位是「LOW_POWER 可放宽的
```

⇒ **`perfTunables` 的设计定位就是「可以被 LOW_POWER 放宽的性能开关」**，而不是「不可让渡的视觉契约」。这是根因，不是 bug。

### 2.3 四个节拍的挂载点与消费方

| 节拍 | SSOT | 默认值 | 消费方（file:line） | **重渲染范围**（2026-09-29 实测） |
|---|---|---|---|---|
| Spinner braille | `perfTunables.js:62-65` | **160ms** | `tui/ink-components/Spinner.js:21`、`tui/ink-components/ProgressBar.js:79` | **仅 Spinner 自己** —— 相位是组件内部 state（`Spinner.js:147`）+ `React.memo`（`Spinner.js:238`） |
| topicBar working-dot | `perfTunables.js:130-133` | **180ms**（A0-a 已回正） | `tui/runtime/topicBar.js:64` | **不触发 React，也不与 ink 争出口** —— 走 ink 树外**直写 stdout**（`topicBar.js:134`/`:293`；`App.js:4656-4659` 注释自陈 "raw ANSI outside the Ink tree"），且两处写入**都是 OSC 0**（`\x1b]0;TITLE\x07`，只设窗口标题），**不触任何 ink 管理的单元格** ⇒ **零渲染冲突**（判据见 §6 A1 第 3 步 / §14 #24） |
| elapsed heartbeat | `perfTunables.js:81-84` | 1000ms | `App.js:1877`（`App.js:1220` `nowTick` 状态） | ⚠ **App 整棵树** —— `nowTick` 是 App **顶层** state，5 个消费点（`App.js:6655`/`6669`/`6921`/`7032`/`7186`）；App.js 实测 **32 个组件定义 / 144 个 `h()` 调用** |
| suspend settle | `perfTunables.js:173-175` | 50ms | `App.js:459`、`App.js:3381` | 非动画（正确性屏障），不周期触发 |
| 帧耗时预算 | `perfTunables.js:152-154` | 16ms | `tui/frameBudget.js`（守卫）、`tui/healthScorecard.js:32` | 只读度量，不触发渲染 |

**注意 `Spinner.js:19`**：

```js
let FRAME_MS = 80;                       // ← 兜底值 = 规范值
try { FRAME_MS = require('../perfTunables').spinnerFrameMs(process.env); } catch { FRAME_MS = 80; }
```

**兜底值（80，合规）比默认值（160，违规）更符合规范** —— 这是漂移的绝佳旁证：规范只活在 `catch` 分支里。

> ⚠ **对 `perfTunables.js:9-13` 注释本身的订正（2026-09-29 实测）**：该注释称三只定时器「**each of which forces an ink re-render**」。实测**对 topicBar 不成立** —— 它是 ink 树外的 ANSI 直写（见上表）。
> 这条注释正是当初降频决策的依据，而它的前提**至少有一项不准确**。⇒ 降频省 CPU 的论证链存在事实性缺口。

### 2.4 三处 spinner 帧率互不一致

| 位置 | 节拍 | 出处 |
|---|---|---|
| ink TUI Spinner | **160ms** | `tui/ink-components/Spinner.js:21` |
| 经典 REPL spinner | **120ms** | `services/progressiveProgress.js:72` 注释引用 |
| 规范表 | **80ms** | `tui/AGENTS.md:652` |

⇒ 同一个产品里，**三种 spinner 三种速度**，且规范值谁都没用。违反「一处真源」。

### 2.5 终端动画的物理约束（为什么 6fps 看起来就是卡）

- **渲染出口的上限是 30fps**：ink 的 `maxFps: 30` → `Math.ceil(1000/30)` = **34ms** throttle（`perfTunables.js:136-140` 的 `INK_THROTTLE_MS`）。任何动画都不可能超过 30fps。
- 因此**动画的可用区间是 0–30fps，而规范选了 12.5fps**（留了一半余量给重绘）。
- 6.25fps = **每帧间隔 160ms**。braille 是 10 帧循环 ⇒ 转一圈 1.6 秒。
- 视觉上，这是「一格一格跳」而不是「在转」。

> **诚实边界**：本文**没有**实测「人眼在终端上把 6.25fps 判为卡顿」的阈值——那是主观量。本文的判据是**客观的**：**规范写 12.5fps，实现跑 6.25fps，两者不一致，且无人报警**。修不修这个不一致由人裁决（见 §13）。

---

## 三、根因：四类表现逐条对应

| 表现 | 根因 | 判据（file:line） | 现状 |
|---|---|---|---|
| **① 一顿一顿 / 掉帧** | 动画被主动降频，且漂移未被发现 | `perfTunables.js:63`（160）、`:131`（320）vs `tui/AGENTS.md:652`（80） | 漂移 ×2 / ×1.78 |
| **② 动画被跳过或闪现** | 动画 tick 与**重绘竞争**同一出口：ink 的 34ms throttle 会把窗口内的帧合并（leading+trailing）；`full` repaint 会整屏重画 | `perfTunables.js:157-168`（`suspendSettleMs` 修的就是 clear 与 trailing render 竞争）；`tui/framePlan.js:70-76`（`REPAINT_REASONS` 的 `full` 分支）；`LOG.md:190`（`/stats` 输出「仅闪现单帧即被下一次重绘抹掉」） | 同族现象已在三处被分别记录，**从未被当作一类问题** |
| **③ 与实际进度不同步** | **两个独立时钟**：braille 帧走 160ms 定时器，秒数走 `nowTick` 1000ms 心跳 | `Spinner.js:157`（`setFrame` 用 `FRAME_MS` 自校正）、`App.js:1220/1877`（`nowTick` + `heartbeatAlignDelayMs`） | 心跳已修过一次（见下） |
| **④ 起步延迟** | 首帧期同步 IO 阻塞 | `[DESIGN-PERF-003]` §4 B1–B4 | **本文不治**（已覆盖） |

> ⚠ **表现②的判据订正（2026-09-29 实测）**：上表把 topicBar 一并算进「与重绘竞争同一出口」，但实测它**根本不在 ink 树里** —— `runtime/topicBar.js:134`/`:293` 直接 `stdout.write(OSC)`，`App.js:4656-4659` 注释自陈 "raw ANSI outside the Ink tree"。
> ~~它的问题不是「被 ink 的 throttle 合并」，而是**与 ink 争 stdout 所有权**。这是表现②的第四条机制，此前从未被单独登记。~~
> ❌ **上句已于 2026-09-29 被证伪**（§6 A1 第 3 步核验）：topicBar 的两处写入**都是 OSC 0**（`\x1b]0;TITLE\x07`），只设窗口标题 —— **不触光标、不触滚动区、不写任何 ink 管理的单元格**。它是**刻意设计成 out-of-band** 的，不是「争所有权」：`topicBar.js:12-17` 自陈 "fully **OUT OF BAND** … zero render conflict"，`:267` 自陈 suspend 是 "**Intentionally a no-op**: the OSC title never overlaps an interactive prompt"。
> ⇒ **表现②的机制只有三条**（ink 34ms throttle 合帧 / `full` repaint 整屏重画 / clear 与 trailing render 竞争），topicBar **不在其中**。

**关于 ③ 的历史**：`perfTunables.js:67-80` 记录了用户原话——

> 「时间应该 1s、1s 的跳，而不是一下跳几秒」

当时心跳被放宽到 2000ms，导致秒数**跳变**（1s→3s→5s）。已在 2026-09-24 回退到 1000ms，并加了 `heartbeatAlignDelayMs` 做整秒对齐。

⇒ **同一个人、同一类抱怨（"不同步"），已经在心跳上发生过一次，并且已经被修好**。但**同一个降频手法仍在 Spinner / topicBar 上生效**——修的是症状，没修手法。

---

## 四、核心判断：动画节拍不是 CPU 旋钮

本文的中心论点，与 `[DESIGN-PERF-003]` §6.0 的判据**同构**：

> [DESIGN-PERF-003] 原文：一份同步工作要么**不在关键路径上**，要么**被消除**；**「换个位置放」不算优化。**

对应到动画：

> **一个动画要么不触发整树重渲染，要么保持帧率。**
> **「降帧率」不算优化** —— 那是拿视觉质量换 CPU，且用户能看见。

**为什么这条重要**：降频是**最省事**的省 CPU 手段，所以它总是被选中（本文的漂移就是证据）。但它把成本从 CPU 转移到了**用户的眼睛**上——而那个成本**不出现在任何 profile 里**，所以永远不会被发现。

**正道是什么**（不是本文发明，是仓库已有的做法）：

`Spinner.js:224-238` 已经有 `React.memo` 收窄重渲染：

```
// Re-render narrowing: memoize so App's keystroke re-renders stop re-rendering
// the spinner row when nothing it shows has changed. ... The braille
// animation itself is internal state (setInterval → setFrame) and is untouched
// by memoization. Gate KHY_TUI_COMPONENT_MEMO, DEFAULT ON;
```

⇒ **省 CPU 的正道是「让每一帧更便宜」，不是「少画几帧」**。这条路已经在走，只是没走完。

> **2026-09-29 补证**：这条判断被新数据**强化**（不是推翻）—— 实测单帧 62–110ms，其中
> **45% 是渲染体里的同步扫盘**（§6 A5）。所以「让每一帧更便宜」不但正确，而且**还有巨大的
> 未兑现空间**；而「降帧率」在这条数据面前更站不住：它只是让贵帧变少，帧本身一点没变便宜。

---

## 五、设计公理（4 条，不可让渡）

| # | 公理 | 为什么 |
|---|---|---|
| **A1** | **动画节拍是视觉契约，不是 CPU 旋钮。** 节拍只有两种合法状态：**动画**（按规范值）与**无动画**（reduced-motion）。**不存在"慢一点"这个合法档位。** | 降频的成本（视觉）不可被 profile 观测，因此必须靠契约而非靠优化直觉来守 |
| **A2** | **省 CPU 只能走「降低单帧成本」，不得走「降低帧数」。** 任何以「省 CPU」为理由放宽节拍的改动，必须**同时**给出单帧成本的下降证据 | 否则就是把成本转嫁给用户的眼睛 |
| **A3** | **节拍真源唯一，且必须可被判据读到。** 规范表（`tui/AGENTS.md` §3.3）与实现（`perfTunables`）与组件兜底值，三者必须一致；不一致即 finding | 本文的漂移正是「兜底值比默认值更合规」——三方各自为政 |
| **A4** | **强度与可行解同步。** 在「降低单帧成本」尚未落地时，**不得**把节拍漂移判 error | 沿用本仓公理：过早阻断会逼人把值改回去交差，而不是真优化 |

---

## 六、方案（A0–A4）

> ⚠ **2026-09-29 订正**：原写「**顺序不可颠倒**：A1 是 A0 的**前置条件**」——**该判断已被实测推翻**。
> A0-a 只把「无规范约束的放宽」收回原值、**不提高帧率**，故不依赖 A1（见 A0-a 末段）。
> 且实施过程中**四个 A 项的前提被证伪**（A0-b 读反上游文档、A3 机制不成立、A4 落点「立刻可见」不成立、A1 第 3 步「与 ink 争出口」不成立）。
> ⇒ **投工前先读下面这张表。**

### 6.0 · 前提核验与执行顺序（2026-09-29 重排）

本节是 §6 的入口，也是**投工的唯一依据**。排法不是按编号，而是按「**前提是否已核验**」。

| 项 | 前提核验 | 状态 | 卡在哪 / 下一步 |
|---|---|---|---|
| **A5** 渲染体零同步 I/O | ✅ 已核验（实测扫盘占一帧 45% ≈ 49ms） | ✅ **已实施** | — |
| **A0-a** `topicBarAnimMs` 320→180 | ✅ 已核验（三篇规范对 topicBar **零规定**） | ✅ **已实施** | — |
| **A0-b** `spinnerFrameMs` 160→80 | ⚠ 核验**失败**（原依据 `tui/AGENTS.md:652` 读反） | ✅ **已裁决：不做** | 另一半待办：§3.3 / `BootScreen.js` / `ccTimers.js` 收敛到 160（P1/D10，**必须整批做**） |
| **A3** 秒数与动画同源 | ❌ 核验**失败**（三条硬伤：算少 / 精度更差 / 收益为零） | ❌ **作废** | 无。残余只作 A1 第 1 步的前置件 |
| **A1 第 2 步** memo 覆盖 | ✅ 已核验（实测 1.73×，心跳帧 20→0 次重渲） | ⚠ **已起步**（仅 `TranscriptView`） | 其余 22 个未 memo 组件的**上界只有 12%**（§14 #15）⇒ 性价比低，**不铺开** |
| **A1 第 1 步** 收窄 `nowTick` | ✅ 已核验（5 个消费点，上界 ≈ 53ms/帧） | ⛔ **待复测** | 方案自己要求「A5 之后复测 Q-3 是否还值得」；但 §11 要求**先清场**（并行进程会污染墙钟）⇒ **等机器空闲** |
| **A1 第 3 步** topicBar 直写仲裁 | ❌ 核验**失败**（两处写入全是 OSC 0，out-of-band；见 §14 #24） | ❌ **作废** | 无。它不争出口 ⇒ **无仲裁可加** |
| **A2** 三处 spinner 帧率收敛 | ✅ 已核验（ink 160 / 经典 REPL 120 / §3.3 80） | ⛔ **待裁决** | **Q-2**：该不该同值？经典 spinner 的 120ms 是**刻意对齐 Claude Code** 的（`cli/spinner.js:33`） |
| **A4** 节拍漂移守卫 | ✅ 已核验（漂移真实存在） | ✅ **已接线**（`RUNTIME-011`，`gate=commit` + `severity=advisory`，S1 观察者） | — |

**修正后的执行顺序** —— 已落地的与已排除的都不再占位，**下一步只剩三条路，且各需一个前提**：

```
A5 ✅ ─┬─ A0-a ✅
       └─ A0-b ✅（裁决不做；另一半 = P1/D10 三处陈旧源整批收敛到 160）

下一步（二选一，各需一个前提）：
  ① A1 第 1 步复测    ← 需机器清场（否则墙钟数据不可信）
  ② A2 收敛          ← 需 Q-2 裁决（同值 or 登记「为何不同」）

本轮已完成：A4 接线（`RUNTIME-011` 已入 `scripts/ci/`，见 §6 A4 与 §9）

已排除：A3（作废）、A1 第 3 步（作废，见 §14 #24）、A1 第 2 步铺开（上界仅 12%）、A0-b（已裁决不做）
```

> ⚠ **编号不连续是历史事实，不是遗漏**：A5 是 2026-09-29 定位到新根因后**插入**的（它优先级最高，故排在 A1 之后、A0 之前）。
> 重排顺序**不等于重编号** —— 全文与其它文档都按 `A0/A1/A2/A3/A4/A5` 引用，重编号会制造死引用。

### A1 · 降低单帧成本（第 2 步已起步；第 1 步待复测、第 3 步已证伪）

**目标**：让周期性 tick 不引起**不必要的整树重渲染**。

**现状（2026-09-29 实测，不再引自注释）**：

| 定时器 | 周期 | 重渲染范围 | 有 memo 保护吗 |
|---|---|---|---|
| Spinner braille | 160ms | **仅 Spinner** | ✅ `Spinner.js:238` |
| topicBar | 180ms | **不走 React，也不与 ink 争出口**（OSC 0 直写窗口标题，out-of-band） | — |
| **elapsed heartbeat** | 1000ms | ⚠ **App 整树**（32 组件 / 144 个 `h()`） | ❌ `nowTick` 在顶层（`App.js:1220`） |

**关键判断**：**成本最高的 heartbeat 没被降频；被降频的 Spinner 本来最便宜（有 memo 保护）。**

这直接说明「降帧率省 CPU」**打错了对象** —— 真正贵的是那个 1fps 的整树重渲染，而它一次都没被碰过。

**做法**（按收益排序，每步可独立验收）：

1. **收窄 `nowTick` 的消费面**（收益最大，**未做**）：5 个消费点里只有 spinner 相关的三个数（`App.js:7085`）真正需要 1s 粒度。把 `nowTick` 下推到只包住该子树 ⇒ 32 个组件里只有少数需要重跑。
2. **提高 memo 覆盖**（**已起步**）：复用既有 `KHY_TUI_COMPONENT_MEMO` 门控（**不新增门控**，R4）。首个落地组件 = `TranscriptView`（`TranscriptView.js:115-133`），memo 实测有效（§14 #9/#10）。

   > **收益边界（必须写清，否则会被读成"整树问题已解决"）**：`TranscriptView` 只在 **Ctrl+O 转录视图打开**时才挂载（`App.js:6950`）。所以这一步治的是「转录视图开着 + 心跳在跳」这一组合场景，**不是主视口路径**。主视口的整树成本仍要靠第 1 步。

   > **上限收益（2026-09-29 实测，探针 `.khyos/diag/memo-coverage.js`）**：复现 `node .khyos/diag/memo-coverage.js`，
   > 实测 **App.js 渲染 24 个组件，已 memo 2（`Spinner`、`TranscriptView`），未 memo 22**。
   > 即第 2 步的收益面就是这 22 个 —— 而它们**大多只在特定视图打开时才挂载**（`TranscriptView` 已是其中
   > 一个），所以「补齐 memo 就能救主视口」不成立，**钱仍在第 1 步**。
   >
   > ⚠ **口径差，不得混读**：本小节上方表格写「32 组件」，探针去重后得 **24**。探针只数
   > `h(<大写名>)` 的**具名组件**，不数 `h('div')` 这类小写宿主标签、也不按挂载实例计；「32」的原始
   > 口径本文未记录。两者**不是同一个量**，引用时各自标注，不要互相换算。
   >
   > 探针落 `.khyos/diag/`（gitignore）⇒ 新克隆的检出里没有它，属预期而非漏提交；它是一次性审计脚本，**不接线**。
3. ~~**给 topicBar 的 stdout 直写加仲裁**：它与 ink 争同一出口，是表现②的机制之一。~~
   ❌ **前提核验不通过（2026-09-29）—— 本步作废，收益为零。** 判据全在 `runtime/topicBar.js`，静态可核：
   - `:12-17` 头部注释写明设计意图：早期的 DECSTBM 滚动区方案**因与 Ink 不兼容已被废弃**，现方案改为 OSC 0 直写窗口标题 —— "fully **OUT OF BAND** … sets the title without touching the scroll region, the cursor, or any cell Ink manages — **zero render conflict**"。
   - 该文件**只有两处写入**（`:134` `_paint()`、`:293` `disable()`），**两处都是 OSC 0 形式**：`stdout.write('\\x1b]0;' + title + '\\x07')`（OSC 0 = 设窗口标题，BEL 收尾）；**无光标移动、无单元格绘制**。
   - `:267` 更直接：`suspend()` 自陈 "**Intentionally a no-op**: the OSC title never overlaps an interactive prompt" —— 它连「与交互式提示争行」都无需处理。
   ⇒ 它**不是「争同一个出口」，而是刻意绕开 ink 所管理的输出面**。给它加仲裁 = 给一条本就无冲突的通道加锁。
4. **测量**：用既有 `frameBudget.js` 的 p95 与 `healthScorecard` 做前后对照。

**预期收益**：待第 1/2 步落地后实测（本文**不编造**数值）。
**风险**：中（动渲染路径，须带帧高回归）。
**回退**：`KHY_TUI_COMPONENT_MEMO=0` 等既有门控已提供逃生口。

### A5 · 渲染体零同步 I/O（**2026-09-29 定位 → 同日已实施（做法 2）**）

**这是本文此前漏掉的真凶。** 用 CPU profile 追调用树定位到：

`App.js:6313` 在**渲染体**里调 `_readMergedTaskLines()`（`appHostHelpers.js:32`），
后者调 `_taskStore.snapshot()`（`_taskStore.js:365`）。实测调用链（profile 自下而上）：

```text
App.js:6313
 └─ _readMergedTaskLines (appHostHelpers.js:32)
     ├─ _taskStore.snapshot() → list() → largeTaskRuntimeStore.listTasks()
     │    → _ensureLoaded → _isStoreStale → _statMtimeMs → statSync
     └─ getCurrentSessionId (sessionForestService.js:65)
          → listPersistedSessions (sessionPersistence.js:1123)
          → _collectSnapshotFiles (sessionPersistence.js:154) → readdirSync
          → _readSessionMetaCached (sessionPersistence.js:1094) → statSync
```

⇒ **每一次 App 渲染都同步 stat + readdir 一遍会话快照目录与大任务库**（实测每帧约 2 次 snapshot）。

**实测成本**（打桩对照：把 `_taskStore.snapshot` 换成返回空串，只掐扫盘，其余一字不改）：

| 变体 | 每帧 |
|---|---|
| 基线（真扫盘） | 110.18 ms |
| 打桩 snapshot（掐掉扫盘） | 60.90 ms |

⇒ **同步扫盘占一帧 ≈ 49 ms（45%）**。

**已有的 memo 为什么没救回来**：`appHostHelpers.js:20-29` 确实有 `taskLinesMemo`
（门控 `KHY_TASK_LINES_MEMO`），但它只缓存 `mergeTaskLines(snap, planTasks)` 的**字符串解析** ——
昂贵的 `snapshot()` 扫盘在它**之前**（`:38`）、**无条件执行**，memo 在 `:46-48` 才生效。
⇒ 与本文 §2.5 记的漂移同族：**memo 护住了便宜的那半，贵的那半裸奔**。

**做法**（按收益排序）：

1. **把扫盘移出渲染体**：`snapshot()` 结果放进 state/ref，由 effect 按**任务变更事件**刷新，
   而不是由渲染驱动。这是根治（渲染体里不该有任何 I/O）。
2. **或给「扫盘结果」加短 TTL 缓存**：与既有解析 memo 同族、**复用同一门控**（不新增门控，R4）。
3. **`_isStoreStale` 的 mtime 检查本身就是一次 `stat`**：即便内容被缓存，每帧仍要 stat 判陈旧。
   TTL 必须排在 stat **之前**，否则省不掉。

**预期收益**：≈ 45% 的单帧成本（实测上界 49ms/帧）。
**风险**：中 —— 动的是**数据新鲜度语义**，必须保证任务变更后仍会刷新，否则看板滞后。
**回退**：`KHY_TASK_PANEL=0` 可整段关掉；缓存门控关掉即逐字节回退到今日行为。

#### A5 实施记录（2026-09-29，做法 2）

**改动面**（2 个源文件 + 2 个测试文件）：

| 文件 | 改动 |
|---|---|
| `tui/perfTunables.js` | 新增 `taskSnapshotTtlMs(env)`：默认 **250ms**；**LOW_POWER 放宽到 1000ms**；⚠ **刻意不提供独立 env override** —— 本方案 §7 R4 要求「净新增 `KHY_*` 门控 = 0」，档位差异由既有的 `KHY_TUI_LOW_POWER` 承担 |
| `ink-components/appHostHelpers.js` | `_readMergedTaskLines()` 在**调用 `snapshot()` 之前**加单槽 TTL 短路；新增 `_taskTtlMs()` / `_resetTaskLinesTtl()` |
| `tests/cli/tui/perfTunables.test.js` | +5 用例（默认 / 覆盖 / 垃圾值 / 不受 LOW_POWER / 默认 env 不抛） |
| `tests/tui/appHostHelpersLeaf.test.js` | +4 用例（**打桩 `_taskStore.snapshot` 计数**：窗口内只扫 1 次且复用同一引用 / 门控关逐帧真扫 / 过期重扫 / 面板关不扫盘） |

**实现要害（唯一的）**：缓存必须掐在**调用 `snapshot()` 之前**。
若放在其后，`snapshot()` 内部的 `_isStoreStale → _statMtimeMs → statSync` 照跑，缓存形同虚设 ——
这正是上面做法 3 记的那条。自检判据（可粘贴复核）：

```bash
grep -n "taskStore.snapshot()" services/backend/src/cli/tui/ink-components/appHostHelpers.js
# 期望：TTL 短路分支（返回缓存那几行）行号 < 该行行号 —— 实测 83-88 < 91
```

**门控复用（零新增回退开关）**：总开关直接用既有的 `KHY_TASK_LINES_MEMO` —— 语义自洽，
因为 `flagRegistry:2343-2348` 对该门的描述本就是
「`_readMergedTaskLines` 每 render 跑 `taskStore.snapshot()`→`mergeTaskLines`……纯浪费」。

**收益实测（真实代码，非打桩）**：

| 组 | 扫盘次数 | 平均耗时 |
|---|---|---|
| 对照 `KHY_TASK_LINES_MEMO=0`（今日行为） | **30 / 30** | **7.754 ms/次** |
| 改动（TTL 250ms 生效） | **1 / 30** | **0.275 ms/次** |

⇒ **降幅 96.5%；扫盘 60 次 → 2 次**（共 60 次读取，交错对照 + 取两轮最小值）。
复现：`node .khyos/tmp/a5/a5-verify.js`。

**代价（诚实记账）**：

1. **任务面板最多滞后 250ms** 才反映变化 —— 远低于人对面板刷新的感知阈值，但这是**语义变化**，不是纯优化。
2. ✅ **R4 合规：`check-tui-gates` 计数不变（236）**。实现过程中曾一度写成
   `KHY_TASK_SNAPSHOT_TTL_MS` 独立 override（计数 **237 —— 违反本文 §7 R4**），
   随即改为复用既有的 `KHY_TUI_LOW_POWER` 做档位 ⇒ 净新增 token 归零。
   有单测锁定该约束：`taskSnapshotTtlMs 刻意无独立 env override(锁定 §7 R4「净新增门控 = 0」)`。
3. ⚠ **做法 2 只覆盖「扫盘」这一层，没有把 I/O 移出渲染体** —— `App.js:6313` 仍在渲染体里调用，
   只是该调用在 250ms 窗口内会短路。**做法 1（移出渲染体）经实证后挂起，理由见下。**

**做法 1（移出渲染体）为何挂起 —— 2026-09-29 可行性实证**：

| 项 | 结论 | 判据 |
|---|---|---|
| 技术障碍 | **首帧 `_taskProps` 为空 ⇒ `taskH = 0` ⇒ 帧高顶破 `rows−1`** | `App.js:6500-6501`（`taskH` 计算）→ `:6524`（进 chrome 总高）；`:5991-5993` 的注释记录了这个 bug 的历史版本 |
| 后果 | ⚠ **灾难性且自锁**：备屏下那条清屏会连转录一起抹掉，且此后**每一帧**都清屏 | `AGENTS.md:190-193`（「这个判定会**自锁**」） |
| 可行的规避 | 首帧用**保守上界** `resolveTaskLineCap(rows)` 预留 `taskH`（就绪后的实际值只会 ≤ 上界） | `liveRegionBudget.js:140-143`（cap = `max(min, min(max, floor(rows×ratio)))`） |
| 代价 | 动 7302 行热点文件（已有别人的在途脏改动）+ 任务面板「先空后填」+ 需独立帧高回归 | — |
| **增量收益** | **仅 ≈ 1–7 ms/帧**（做法 2 已拿走 96.5%，剩下的是每 250ms 一次的扫盘摊销） | 见上「收益实测」 |

⇒ **结论：风险收益比不佳，挂起。**（`[DESIGN-PERF-003]` 的 `L2c` 早已以同样理由挂为待办。）
**重启前提**：等 A4 的帧高守卫（或 `[DESIGN-ARCH-156]` 的高度账本契约化）就绪，
使「改帧几何」能被机器拦住，再单独一轮 —— 而不是靠人记得去跑 `KHY_TUI_DIAG_H=1`。

**⚠ 关键推论：A5 为 Q-1（节拍回正）创造了条件。**
当初把 Spinner 从 80ms 放宽到 160ms 的理由是**省 CPU**；A5 已把每帧最贵的一块（扫盘 ≈45%）拿掉，
⇒ **现在有空间把帧率调回去**。两者是配套的：**A5 降单帧成本，Q-1 提帧率**。

### A0 · 节拍回正

⚠ **2026-09-29 实施时发现：A0 的两半性质完全不同，必须拆开。** 初稿把两者当成同一件事（都引「规范值」），但只有 `topicBar` 那一半真有「规范值」可依 —— 另一半的「依据」是本文**读反了上游文档**（见 §1.2 的订正）。

#### A0-a · `topicBarAnimMs` 320 → 180 —— ✅ **2026-09-29 已实施**

| 项 | 现在 | 改后 | 依据 |
|---|---|---|---|
| `topicBarAnimMs` | 320 | **180** | 原硬编码值（`runtime/topicBar.js:62` 的 `_ANIM_MS` 兜底仍是 180）；**三篇规范均未对 topicBar 作任何规定**（实测 grep：`079`/`101`/`102` 零命中，冲突登记册 `[103]` 只登记了 spinner 一条）⇒ **无规范冲突** |

**配套已做**：`tui/AGENTS.md` §3.3 表补上 `topicBar` 行 —— 此前表里没有它，所以它「无规范可依」才被随意放宽到 320ms。

**连带修（实施时发现的既有缺陷）**：`ink-components/ProgressBar.js:77` 的 `RENDER_MS` 原从 `perfTunables.spinnerFrameMs` 派生，而进度步长 `progressiveProgress.STEP_MS` 是独立字面量 160。`KHY_TUI_LOW_POWER=1` 时 `spinnerFrameMs` = 320 ⇒ 重绘 320ms 而步长仍 160ms ⇒ **一跳 2%**，恰好推翻该文件自己注释里的「1% 1% 地加载」。已改为单向 `STEP_MS → RENDER_MS`。

**验收判据（A0-a，已过）**：`node .khyos/diag/tui-cadence-guard.js` → **0 error / 0 warning / 7 info**；Spinner 那条漂移降级为 `cadence-drift-known`（带出处）。

#### A0-b · `spinnerFrameMs` 160 → 80 —— ✅ **2026-09-29 已裁决：维持 160，不做**

**初稿的依据 `tui/AGENTS.md:652` 不成立。** 那格写 80ms，但它是**已知待收敛的陈旧侧**，不是权威侧：

| 来源 | 值 | 状态 |
|---|---|---|
| `[DESIGN-ARCH-101]` §8 冲突 1 | **160** | **明确裁定**：「以 `perfTunables` 的 160ms 为准」，80ms 判为**陈旧第三源** |
| `[DESIGN-ARCH-102]` §6.4 + `:833` | **160** | `ccTimers` 的 80ms 标为**废弃** |
| `[DESIGN-ARCH-079]` §12.6.1 | **160** | 已由 80ms **修订为** 160ms（⚠ 同篇 `:1097` 仍写 80ms，**该篇自相矛盾**） |
| `[DESIGN-ARCH-115]` §2.2 | **160** | 建议「同步改 `tui/AGENTS.md` §3.3 与 `BootScreen.js`」⇒ 收敛方向是 **→160** |
| `[DESIGN-ARCH-134]` | ⚠ 反对 80 | 「帧高被推到 `rows-1` 后，每 80ms 一次 spinner 重绘 = 近乎整屏重写 …… **这是 H1 的原始病灶，不要用视觉理由把它请回来**」 |
| `perfTunables.js` | 160 | 与上述五篇一致 |
| §3.3 / `Spinner.js` / `BootScreen.js` / `ccTimers.js` | 80 | **陈旧侧**；收敛属 P1（D10），`BootScreen.js:55` 自陈「本轮不动」 |

⇒ **改 160 → 80 等于悄悄推翻一条已登记的裁决**，且与 `[134]` 的明确警告相悖。它**不是一次默认值调整，而是一次规范变更** —— 必须先动上表那五篇。本轮**不做**。

**✅ 2026-09-29 用户裁决：维持 160。** 采纳上表五篇的裁决方向；本节下面的护栏全部保留。

> **遗留待办（P1/D10）**：把 §3.3 / `BootScreen.js` / `ccTimers.js` 三处陈旧 80ms **收敛到 160**，
> 一次做完。这是「维持 160」这一裁决的**另一半** —— 不做则 §3.3 那格永远是假的。
> 只改 §3.3 而不同步 `BootScreen.js`/`ccTimers.js` 会**造出新的不一致**，故必须整批做。

**已留的护栏**（防止下次有人顺手「修」成 80）：

- `perfTunables.js` 头部 Background + `spinnerFrameMs` docstring 写入裁决出处；
- `perfTunables.test.js` 新增断言把 160 钉住；
- §3.3 表 Spinner 格加 ⚠ 标注（**值不改**，只标「待收敛」）。

> ⚠ **A0-a 未依赖 A1**：它不提高帧率，只把「无规范约束的放宽」收回到原值。
> A0-b 仍受 §5 公理约束 —— **若 A1/A5 未把单帧成本降下来，A0-b 不做。**

---

#### A0 初稿（**已被上文取代**，保留供对照）

**做法**：把 `perfTunables` 的默认值改回规范值：

| 项 | 现在 | 改后 | 依据 |
|---|---|---|---|
| `spinnerFrameMs` | 160 | **80** | `tui/AGENTS.md:652` |
| `topicBarAnimMs` | 320 | **180** | 原硬编码值 |

**同时必须做**（初稿，已被 A0-a 取代）：把 `tui/AGENTS.md` §3.3 表补上 `topicBar` 一行（现在表里没有它，所以它"无规范可依"才被随意放宽）。

**验收判据（硬，初稿）**：改后 `node .khyos/tmp/anim-probe.js` 必须显示 **无漂移**，且 `healthScorecard` 的 `frame.p95` **不高于** A1 之后的基线。

> ⚠ **若 A1 未能把单帧成本降下来，则 A0 不做。** 这是 A4 公理的直接推论。（**2026-09-29 订正**：该公理只约束 A0-b；A0-a 已实施，不依赖 A1。）

### A2 · 三处 spinner 帧率收敛 —— ⛔ **待裁决 Q-2**

**做法**：让经典 REPL spinner（现 120ms）与 ink TUI spinner（现 160ms）**共用同一个 SSOT 值**。

**注意**：两者的渲染出口不同（chalk 逐行写 vs ink 全屏重绘），**是否应该用同一个值需要人裁决**（见 §13 Q-2）。本文只主张**"不允许三个值各写各的"**，不主张"必须相等"。

### A3 · 秒数与动画同源（治表现 ③）—— ❌ **2026-09-29 前提核验不通过，作废**

**原做法（作废）**：把 `elapsedSec` 改为**从 Spinner 的 `startedAt` 推导**，而不是从 `nowTick` 取。

**为什么不成立**（三条独立理由，逐条可复核）：

| # | 理由 | 判据 |
|---|---|---|
| 1 | **会引入正确性回归**：`Spinner.js:155` 的 `startedAt` 是**组件挂载时刻**，而回合起点是 `query.turnStartedAt`。Spinner 在回合**开始之后**才挂载 ⇒ 从它推导会把秒数**算少** | `Spinner.js:151-160`（effect 里 `startedAt = Date.now()`）vs `App.js:6919-6924`（`_spinnerProgress(turnStartedAt, …)`） |
| 2 | **精度反而变差**：心跳**已经**用 `heartbeatAlignDelayMs` 对齐到整秒边界（2026-09-24 修）。改用 160ms 的 braille 时钟，进位会落在边界后 **0–160ms** | `perfTunables.js:107-121`；`App.js:1877` |
| 3 | **收益为零**：Spinner 本来就每 `FRAME_MS` 因 braille 的 `setFrame` 重渲一次 ⇒ 「省掉它因心跳重渲」不省任何东西 | `Spinner.js:156-158` |

**注意 §3 表里 ③ 的「现状」列本就写着「心跳已修过一次」** —— 即 ③ 已被修。§6 A3 却提出一个与 §3 不同、且更差的机制。
**这是本方案第 2 处被推翻的前提**（第 1 处是 A0-b 读反上游文档；此后又发现 2 处 —— A4 落点「立刻可见」不成立、A1 第 3 步「与 ink 争出口」不成立，**累计 4 处**，见 §6.0 表）。

**唯一有意义的残余**：把 elapsed 的**归属**移进 Spinner（传 `turnStartedAt` 而非 `nowTick`）可作为 **A1 第 1 步的前置件** —— 但那一步受 Q-3 约束，且单做 A3 收益 ≈ 0。故 A3 **不作为独立项**。

### A4 · 节拍漂移守卫 —— ✅ **2026-09-29 已接线（`RUNTIME-011` · S1 观察者）**

**做法**：新增一条检查器，对账**规范表 ↔ `perfTunables` 导出值**，不一致即 finding。

**这是本方案唯一需要接线的部分**，接线清单见 §9。

**落点选择**（按 skill 步骤 2 与 §5.74「先读接线机制」）：

| 候选落点 | 评估 |
|---|---|
| `tui/healthScorecard.js` | ⚠ **2026-09-29 实测订正：暂不可用** —— 它确实是只读体检聚合，但**全仓没有任何调用方**（无 CLI 命令、无 CI job、无测试；它自己提到的 `--leak-check` job 也不存在，见 §14 #23）。往一个死模块里加条目 ⇒ **可见性为零**，与本节「运行时可见」的目的相悖。要用它**必须先把它接线**（另立待办） |
| `scripts/ci/` 新检查器 | **需要接线**（四件事，见 §9）。用于把漂移挡在 CI 门口 |
| `tui/frameBudget.js` | ❌ **不适用**：它量的是**渲染耗时**（`onRender({renderTime})`），不是帧率。混进去会污染它的单一职责 |

**推荐组合（2026-09-29 修订）**：~~`healthScorecard` 做运行时可见~~ —— 该落点经实测**不成立**（死模块，见上表）。
改为：**先只做 `scripts/ci/` 一处**（提交时拦截），把「接线 `healthScorecard`」立为独立待办。
理由：**一条会真的跑起来的守卫，胜过一条永远不会被调用的「可见性」。**

**✅ 原型已知缺陷（2026-09-29 实测 → 同日已修）**：
`.khyos/diag/tui-cadence-guard.js:189-196` 的 `impl` 是**手写清单**（只列了 `topicBarAnimMs` /
`suspendSettleMs` / `frameBudgetMs`），但该文件 `:42` 的注释声称「perfTunables 有导出、
这里没有 ⇒ 自动报 `unbound-impl`」—— **注释声称的机制与实现不符**。
实测：本次给 `perfTunables` 新增 `taskSnapshotTtlMs` 后，guard 的 baseline 仍是
`0 error / 1 warning / 6 info`，**新增导出被静默漏掉**。
⇒ **已修**：`impl` 改为按 **arity 动态枚举**（`typeof v === 'function' && v.length <= 1` ——
用 arity 排除 3 参的纯计算 `heartbeatAlignDelayMs`）。修后 `loadImpl` 返回 **6** 个旋钮（手写清单只有 5），
`taskSnapshotTtlMs` 出现在 `unbound-impl` 里、不再静默漏掉。

**同时新增 `KNOWN_DRIFTS` 白名单**：把「已裁决保留」的漂移（Spinner 160 vs §3.3 的 80）降为 info 并附出处 ——
否则观察者长期挂着一条消不掉的 warning 会**教会人无视它**（告警疲劳比不报更糟）。
修后 baseline：**0 error / 0 warning / 7 info**（原 0 / 1 / 6）。

#### ✅ 2026-09-29 已接线（`RUNTIME-011`）

**落点**：`scripts/ci/check-tui-cadence.js`（薄壳，只做采集与渲染）+ `scripts/lib/tuiCadenceGuard.js`（判定叶子，纯函数、零 IO、绝不抛、可离线单测）。
**原型去向**：`.khyos/diag/tui-cadence-guard.js` 按落点纪律**留在 gitignore 桶内**（`[DESIGN-LAY-002]` §3.1「过程态工具」），未迁入 `scripts/`；它保留作接线前后的对照。

**九条判据的强度表**（`CRITERIA`，S1 列刻意等于原型实测 baseline ⇒ 接线这一步**不改变任何既有读数**）：

| 判据 | 铁律 | S1 | S3 |
|---|---|---|---|
| `cadence-drift` 规范值 ≠ 实现默认值（未裁决） | R1 | warning | **error** |
| `cadence-drift-known` 同上但已裁决保留 | R1 | info | info |
| `binding-orphan` 绑定表指向的规范行不存在 | R1 | warning | **error** |
| `spec-unreadable` §3.3 表读不到 | R1 | warning | **error** |
| `fallback-drift` 组件兜底值 ≠ 规范值 | R2 | warning | **error** |
| `fallback-drift-known` 兜底对齐的是已裁决实现值 | R2 | info | info |
| `fallback-unreadable` 兜底值抽取失败 | R2 | warning | **error** |
| `unbound-spec` 规范行未纳入对账 | R3 | info | **error** |
| `unbound-impl` `perfTunables` 导出在表里无对应行 | R3 | info | info |

**验收读数**（全部可复核）：`rules:gate:commit` **13/13 检查器**、`action=start target=scripts/ci/check-tui-cadence.js`、`errors=0 warnings=0`；反例矩阵 **7/7**；变异测试 **5/5 全杀**（证明断言不是装饰）；`check-wiring` **97 → 98**；`check-rollout-stage` **0 error / 3 warning**（三条均为既有同族，本机制未新增）；`check-rules-registry` / `check-gov-rules` / `check-repo-layout` / `gen-rules-cards --check` 全通过。

**两处必须知道的边界**：

1. ⚠ **ssot 文档未跟踪**：本规则的 ssot 就是本文（`[DESIGN-PERF-004]`），而它目前仍是 `??` 未跟踪状态 ⇒ **登记表与真源必须同批提交**，否则新克隆的检出会因 `TOOLING-007` 双向可达失败而变红。
2. ⚠ **R2 与 A0-b 裁决存在张力**（执行器已用「兜底容差」兜住，但没根治）：R2 字面说「兜底值必须等于规范值」，而 `Spinner.js` 的兜底 `80ms` 对应的是**已判为陈旧**的规范值。若有人把兜底改成 `160`（= A0-b 裁决值），字面 R2 会判违规 —— 那是**教人改回错值**。故执行器对已裁决绑定接受「规范值 **或** 实现值」，后者降为 `fallback-drift-known`(info)。**根治要等 P1/D10 把三处陈旧源整批收敛到 160 后重写 R2**，本方案不代拍。

---

## 七、防呆铁律（每条都有可自动判的判据）

| # | 铁律 | 可自动判的判据 |
|---|---|---|
| **R1** | 同一动画的节拍在**规范表 / `perfTunables` 默认值 / 组件兜底值**三处必须一致 | 三方比对；本文实测已抓到 Spinner 的 160 vs 80 不一致 |
| **R2** | 组件里的节拍**兜底值**必须等于规范值 | `Spinner.js:19` 的 `let FRAME_MS = 80` 合规；若写成 160 即违规 |
| **R3** | 规范表 §3.3 的**每一项**都必须有对应的 `perfTunables` 导出 | 表 ↔ 导出对账（现在 `topicBar` 在表外，`Resize 防抖 50ms` 在表内但无对应导出——**两个方向都有缺口**） |
| **R4** | **净新增 `KHY_*` 门控 = 0** | `node scripts/ci/check-tui-gates.js` 计数**不得上升**（现状已超标，见 §9 约束） |
| **R5** | 任何放宽节拍的改动，**必须同时**提交单帧成本下降的证据 | 改动的 PR 里必须含 `frameBudget` p95 的前后对照；缺证据即驳回 |

> ⚠ **R1–R3 已有执行器，但仍是红的**（2026-09-29 接线 `RUNTIME-011` 后复测）：执行器 `scripts/ci/check-tui-cadence.js` 对账三方并报出 **7 条 info 缺口**（已裁决漂移 1 + 表→导出缺口 3 + 导出→表缺口 3），只是按 S1 观察者档**只记录不阻断**。
> 这正是「规范写了但没人执行」的典型：`tui/AGENTS.md` §0.2/§3.3 的 16ms 与 80ms 此前**根本没有执行器**；现在有了，但**强度还没到能拦**（升 S3 的两个前置见 §8）。
> ⚠ **R2 与 A0-b 裁决存在张力**（执行器已用兜底容差兜住，未根治）：R2 字面说「兜底值必须等于规范值」，而 `Spinner.js` 的兜底 `80ms` 对应的是**已判为陈旧**的规范值 —— 若有人把它改成 `160`（= 裁决值），字面 R2 会判违规，那是**教人改回错值**。详见 §6 A4 末段的「两处必须知道的边界」。

---

## 八、强度梯度

按 `PROCESS-008` / `[DESIGN-PROCESS-002]` §2，**新拦截型机制必须从 S1 观察者起步**。

| 阶段 | 行为 | 毕业条件 |
|---|---|---|
| **S1 观察者** | 只记录 finding，执行器**恒 exit 0** | ≥200 条相关事件且无解释不了的样本 |

> ✅ **2026-09-29 本方案已落到 S1**：`RUNTIME-011` 的 `gate=commit` + `severity=advisory`，执行器 `STAGE='S1'` 恒 exit 0。实测 `rules:gate:commit` 里 **13/13** 检查器、`errors=0 warnings=0`（见 §6 A4）。
> ⚠ **升 S3 的两个前置**（缺一不可）：① A1 已落地（单帧成本已降），否则会逼人把节拍值改回去交差；② **§7 的 R3 缺口清零或改判据** —— 升 S3 后 `unbound-spec` 会派生 error，而当前 baseline 恰好有 **3 条** `unbound-spec`（表里 3 行无对应导出）⇒ 提交门会**立刻变红**。这是设计上刻意保留的「升档要先还债」信号，不是缺陷。
| **S2** | 同上，但在体检表里显著呈现 | — |
| **S3 拦截** | R1/R2 判 error，阻断提交 | **前置**：A1 已落地（单帧成本已降），否则会逼人把值改回去交差 |

**登记表的正确写法**（`khyos-design-proposal` §6.4 的陷阱）：

- `gate: "commit"`（最低的**会跑**档位）+ `severity: "advisory"` → 执行器**真被调用**，finding 只记录不阻断
- ❌ **绝不能**写 `gate: "advisory"` —— `GATE_ORDER.advisory = 4 > max = 2`，规则**永不被任何门档选中**，且所有守卫全绿

**必做的实证**（否则是空接线）：

```bash
npm run rules:gate:commit 2>&1 | grep "<执行器名>"
# 必须看到 action=start ... mode=commit rules=<finding ids>
```

---

## 九、接线清单（B-L2 三步）—— ✅ **2026-09-29 三步已全部完成**

### 约束（先读再估）

| 约束 | 实测值 | 出处 |
|---|---|---|
| `KHY_*` 门控预算 | **已超标**（226 unique / 上限 220） | [DESIGN-PERF-003] §L3 实测 |
| ⇒ 本方案**不得**新增门控 | R4 铁律 | 同上 |
| 新检查器的"检查器集合" | = `scripts/ci/*` ∪ 全部 `exec.script` | `check-wiring.js` |
| 门档成员资格 | 从登记表**派生**，**不要**动 `qualityGateStages.js` | [DESIGN-ARCH-111] |

### 步 1 · 标记（只登记，不迁移）—— ✅ 已完成

- `RULES-REGISTRY.json` 补条目：`domain` 从**十域封闭枚举**里选（本方案属 **`RUNTIME`**）；`gate: "commit"` + `severity: "advisory"`；`formerly: "无"`（**不能写 `null`**）
- 新规范/真源文档第 3 行加 `<!-- RULES-REGISTRY: <ID> -->` 标记行
- 同步 `meta.ruleCount`
- ⚠ 此时**不要**先跑 `docs:rules-cards`（生成器逐字复制 `ssot`，错路径会扩散）

### 步 2 · 迁移（执行器入仓 + 加别名）—— ✅ 已完成

- 判定逻辑放 `scripts/lib/tuiCadenceGuard.js`（**纯叶子**：零 IO、确定性、绝不抛、可单测）
- 走盘/打印放 `scripts/ci/check-tui-cadence.js`
- `package.json` 加 `check:tui-cadence` 别名 → **否则 `check-wiring` 判 error（检查器零接线）**
- ⚠ **未接线的原型绝不能放 `scripts/ci/`** —— 原型阶段放 `.khyos/diag/`

### 步 3 · 收口 —— ✅ 已完成

- `npm run docs:rules-cards` 生成规则卡（`docs/10_规范/规则卡/` **禁止手改**）
- 验收：`check:wiring`、`check:gov-rules`、`rules:coverage`、`check:rules-registry` 四条

> ✅ **实际执行结果（2026-09-29）** —— 三步全部完成，落点与上表逐条一致：
> - **步 1**：`RULES-REGISTRY.json` 加 `RUNTIME-011`（domain `RUNTIME`、`gate: "commit"` + `severity: "advisory"`、`formerly: "无"`），`meta.ruleCount` **94 → 95**；ssot 文档第 3 行加 `<!-- RULES-REGISTRY: RUNTIME-011 -->`。
> - **步 2**：判定叶子 `scripts/lib/tuiCadenceGuard.js` + 薄壳 `scripts/ci/check-tui-cadence.js`；`package.json` 加 `check:tui-cadence` 别名（**未**加进 `check:structure` 聚合 —— 同族 S1 观察者都不在里面）。
> - **步 3**：规则卡 `docs/10_规范/规则卡/[RUNTIME-011] TUI 动画节拍三方一致.md` 由 `gen-rules-cards.js` 生成（**95 张**），`.html` 孪生由 `build_docs_site.js` 生成。
> - **另加第四触点**（本清单初稿未列，`PROCESS-006` PP-1 要求）：`FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms[]` 登记 `tui-cadence-guard`（`stage=S1`，`executorStage.constant="STAGE"` 为**字面常量**以便 `check-rollout-stage.js` 比对）。
> - ⚠ **未跟踪前提**：ssot 文档 `[DESIGN-PERF-004]` 仍是 `??` ⇒ **登记表与真源必须同批提交**（`RULES-REGISTRY.json` 是 tracked，只提交它会让新克隆的检出因 `TOOLING-007` 变红）。

---

## 十、验证与反例清单

**原型**：`.khyos/diag/tui-cadence-guard.js`（判定核心是纯函数、数据源 `require` 真源、零外部依赖）

| 场景 | 输入 | 期望 | **实测**（2026-09-29，**7 个场景**） |
|---|---|---|---|
| `baseline` | 当前仓库（真实漂移） | 报 Spinner 漂移 | ✅ **0 warning + 7 info**（Spinner 那条已裁决保留 ⇒ `cadence-drift-known`(info)。原写的「1 warning」是**加 `KNOWN_DRIFTS` 白名单之前**的读数，已过期） |
| `aligned`（**应放行**） | 实现与兜底都对齐规范值 | **0 warning** | ✅ 0 warning + 6 info（且 `cadence-drift-known` **也消失** —— 只断言「0 warning」不够：唯一的存量漂移在白名单里，所以「aligned 等于 baseline」也能过。变异测试实测抓到了这个漏洞，已补直接断言） |
| `spec-missing` | 规范表删掉 `Spinner` 行 | 报绑定表腐化 | ✅ 1 warning（`binding-orphan`） |
| `fallback-drift` | `topicBar.js` 兜底值改成漂移值 | 报兜底漂移 | ✅ 1 warning（`fallback-drift`）。⚠ 载体从 `Spinner` 换成 `topicBar`：Spinner 的漂移已在白名单里，且兜底容差会把它降为 info ⇒ **不再是「能变红」的负例**，必须换一个无已知漂移的绑定 |
| `fallback-drift-known` | `Spinner.js` 兜底值改成 `160`（= 已裁决实现值） | **不报 warning** | ✅ 0 warning + 8 info（`fallback-drift-known`）—— 证明兜底容差**不是恒真**（否则它会静默吞掉真漂移） |
| `spec-unreadable` | §3.3 小节消失 | **只报根因**，不派生噪声 | ✅ 1 warning（`spec-unreadable`） |
| `no-binding` | 绑定表被清空 | 全部落入 unbound | ✅ 0 warning + **12 info**（原写「10 info」漏计了 `unbound-impl` 的 6 项 —— 绑定表清空后 6 个旋钮全部无对应行） |

> **`aligned` 场景是必需的**：只测「会拦」不测「会放行」，等于给了一个**恒真断言**（skill §5.7）。实测它收敛到 0 warning，证明判据不是恒真。
>
> **`gate-count`（R4）已移出本守卫职责**：它归 `scripts/ci/check-tui-gates.js` 管，混进来会破坏单一职责。
>
> ⚠ **反例矩阵当场抓到原型自身的 2 个缺陷**（这正是矩阵的价值）：
> ① 初版把 `impl: null` 的绑定也算作「已对账」⇒ `unbound-spec` 零命中、`topicBarAnimMs` 漏报；
> ② `spec-unreadable` 场景下 `specByName` 为空 Map，`s.ms` 抛 `TypeError` ⇒ **违反「绝不抛」纪律**。
> 两处均已修。**这是「低精度守卫比没有更糟」的实证。**

---

## 十一、复现方式（可直接粘贴）

```bash
# ① 量出节拍漂移（本文最硬的证据）
node .khyos/tmp/anim-probe.js

# ② A4 守卫（2026-09-29 已接线为 RUNTIME-011）
node scripts/ci/check-tui-cadence.js --scenario=matrix   # 反例矩阵 7/7
node scripts/ci/check-tui-cadence.js --list              # 含 info 的完整盘点（7 条缺口）
node --test scripts/tests/check-tui-cadence.test.js      # 29 用例（含 S1/S3 强度差异与方言可解析性）
node .khyos/diag/tui-cadence-guard.js --scenario=all     # 接线前的原型，保留作对照

# ③ 门控预算现状（确认没上升）
node scripts/ci/check-tui-gates.js

# ④ 既有帧耗时守卫（A1 的前后对照基线）
#    运行时由 App.js 喂 onRender({renderTime})，体检经 healthScorecard 呈现

# ⑤ memo 净收益实测（A1 第 2 步的判据）
#    数「心跳帧里目标组件重渲几次」：门控关 = 20/20，开 = 0/0/0/0
node .khyos/tmp/memo-effect-probe.js

# ⑥ ★ 单帧成本的组成分解（A5 的判据）：把子组件全注入 memo vs 原样
node .khyos/tmp/app-frame-cost-split.js

# ⑦ ★ 渲染体同步扫盘的真实成本（打桩对照）：基线 vs 掐掉 snapshot
node .khyos/tmp/app-fs-io-cost.js

# ⑧ ★ 单帧 CPU profile + 调用树定位（谁在烧 CPU / 谁调的）
node --cpu-prof --cpu-prof-dir=.khyos/tmp/prof-app --cpu-prof-interval=200 .khyos/tmp/app-cost-profile.js
node .khyos/tmp/parse-cpuprofile-tail.js .khyos/tmp/prof-app 9000
node .khyos/tmp/who-calls.js .khyos/tmp/prof-app 9000 "stat,readdir"

# ⚠ 以上全部是**墙钟/采样**测量：跑之前必须确认没有别的重进程在占 CPU。
#   实测教训：一个并行跑的 jest 进程把同一组数据从 62ms 抬到 90ms+ 且方差翻倍。
```

> ⚠ `.khyos/` 是 **gitignore 的暂存区**（`.gitignore` 规则 `/.khyos/`），新克隆的检出里**没有** `anim-probe.js`。若要把它作为长期证据，须在步 2 迁入 `scripts/lib/` 纳入版本控制。

---

## 十二、不做什么（明确范围外）

- ❌ **不治启动**（首帧 2885–15867ms）—— [DESIGN-PERF-003] 的地盘
- ❌ **不改帧几何 / 高度账本**（H1、`framePlan`、`chromeRegistry`）—— [DESIGN-ARCH-156] 的地盘，且有属性测试覆盖
- ❌ **不新增 `KHY_*` 门控**（R4）
- ❌ **不引入动画库**（GSAP / framer-motion 等）—— 终端没有合成器，库解决不了重绘出口问题
- ❌ **不擅自处置** `DESIGN-PERF-001` 的编号冲突与 `-001`/`-002` 重复（§1.2 已登记，建议单独立项）
- ❌ **不把节拍漂移在 A1 落地前判 error**（A4 公理）

---

## 十三、未决问题（需人裁决，本文不代为决定）

| # | 问题 | 选项与代价 |
|---|---|---|
| **Q-1** | ~~**A0 节拍回正做不做？**~~ ✅ **2026-09-29 已裁决：维持 160**（见 §6 A0-b） | 原「做/不做」二选一建立在**错误前提**上（初稿把 §3.3 的 80ms 当规范值，实为陈旧侧）。现况：**A0-a（topicBar 320→180）已实施**；**A0-b 维持 160** —— 与 `[DESIGN-ARCH-101]` §8 裁决 / `102` §6.4 / `079` §12.6.1 / `115` §2.2 一致，并遵 `134` 的警告。**遗留待办（P1/D10）**：把 §3.3 / `BootScreen.js` / `ccTimers.js` 三处陈旧 80ms 收敛到 160，**整批做**；未收敛前 §3.3 保留 ⚠ 标注 |
| **Q-2** | **经典 REPL spinner 与 ink TUI spinner 要不要同值？** | ① 同值：一处真源，但两者渲染出口不同（chalk 逐行 vs ink 全屏），同值未必同观感；② 不同值但**登记理由**：需要一处"为什么不同"的说明 |
| **Q-3** | **A1「合帧」动渲染路径，风险中。做不做？** | ① 做：这是唯一的正道，但要带帧高回归测试；② 先只做 A4 守卫（S1 观察者），把漂移**暴露**出来，A1 另立提案 |
| **Q-4** | ~~**守卫落点**：`healthScorecard` 还是 `scripts/ci/`？~~ ✅ **2026-09-29 已决并落地** | `healthScorecard` 选项经实测**不成立**（死模块，零调用方，见 §14 #23），原「零接线、立刻可见」是假的。⇒ 落点 = `scripts/ci/check-tui-cadence.js`，已接线为 `RUNTIME-011`（规则登记 / 别名 / 规则卡 / 孪生件 / 阶段登记，见 §9）。**「把 `healthScorecard` 接线」仍另立待办** —— 那是另一件事，不在本方案范围内 |
| **Q-5** | ~~`tui/AGENTS.md` §3.3 表要不要补 `topicBar` 行？~~ | ✅ **2026-09-29 已补**（A0-a 的配套）。实测确认：正因表里缺这一行，它才无规范可依被放宽到 320ms |
| **Q-6** | ~~**A1 第 3 步（给 topicBar 直写加仲裁）做不做？**~~ | ❌ **2026-09-29 已证伪，不成立**：topicBar 的两处写入全是 OSC 0（设窗口标题），不触光标 / 滚动区 / 任何 ink 管理的单元格 —— 它**不争出口**，故「仲裁」无对象（见 §6 A1 第 3 步 / §14 #24）。**无需裁决** |

---

## 十四、验证状态（区分「已实测」与「仅主张」）

### 已实测（26 条，均可复现）

| # | 断言 | 证据 |
|---|---|---|
| 1 | Spinner 实际 160ms / 6.25fps，规范 80ms / 12.5fps，漂移 ×2 —— **2026-09-29 复核：该漂移属「已裁决保留」**（`[DESIGN-ARCH-101]` §8 冲突 1 裁定 160 为准），A0-b 冻结，见 §6 A0-b | `node .khyos/tmp/anim-probe.js` 输出 |
| 2 | topicBar 实际 320ms / 3.13fps，原值 180ms，漂移 ×1.78 —— **2026-09-29 已回正为 180ms**（A0-a） | 同上；回正后见 #21 |
| 3 | ink 上游上限 30fps（throttle 34ms）；LOW_POWER 下 spinner=320ms | 同上 |
| 4 | `scripts/` 下**没有任何**检查器引用 `spinnerFrameMs` / `frameBudgetMs` / `perfTunables` | `grep -rln` 返回空 |
| 5 | A4 守卫原型反例矩阵 6 场景**全部符合预期**（含 `aligned` 应放行对照） | `node .khyos/diag/tui-cadence-guard.js --scenario=all` |
| 6 | baseline 报出的 7 条 finding **逐条核验全为真**（Spinner 漂移 + 3 条 `unbound-spec` + 3 条 `unbound-impl`） | 同上；unbound 项已对照 `perfTunables` 导出面与 §3.3 表逐一确认 |
| 7 | 一次 heartbeat tick 的重渲染范围是 **App 整树**（32 组件 / 144 个 `h()` 调用），而 Spinner 的 braille tick **只重渲自己** | `grep -cE "^(function\|const) [A-Z]" App.js` = 32；`grep -c "h(" App.js` = 144；`Spinner.js:147`（内部 state）+ `:238`（memo） |
| 8 | topicBar 动画**不触发 React**，走 ink 树外直写 stdout | `topicBar.js:134`/`:293` 的 `stdout.write`；`App.js:4656-4659` 注释 |
| 9 | `TranscriptView` 的 props 在心跳帧里**引用不变**（`_transcriptView` 是 `useMemo` 产物，依赖 `[transcriptOpen, expanded, query.messages, _resCols, _resRows]`，**不含 `nowTick`**）⇒ 对它加 memo 是**真生效**而非摆设 | `App.js:5975-5987`（依赖数组）· `App.js:6951-6956`（4 个 prop 全是原始值/稳定引用） |
| 10 | 加 memo 后**心跳帧零重渲**：门控关 = 20/20，门控开 = 0/0/0/0（各 4 轮全稳）；单次最优耗时 169.3ms → 98.0ms，**1.73×**（2000 行负载） | `node .khyos/tmp/memo-effect-probe.js`；探针自证「副本逐字节忠实」= `true` |
| 11 | `App.js:6313` 在**渲染体**里调 `_readMergedTaskLines()`，后者同步扫盘（`statSync` + `readdirSync`），每帧约 2 次 | profile 调用树：`App.js:6313 → appHostHelpers.js:32 → _taskStore.js:365 → largeTaskRuntimeStore.listTasks → _isStoreStale → _statMtimeMs → statSync`；另一支 `→ sessionForestService.js:65 → sessionPersistence.js:1123 → _collectSnapshotFiles → readdirSync` |
| 12 | 该扫盘占一帧 **45%（≈49ms）**：基线 110.18ms → 打桩 `snapshot` 后 60.90ms | `node .khyos/tmp/app-fs-io-cost.js` |
| 13 | 既有 `taskLinesMemo` 只护住**字符串解析**；昂贵的 `snapshot()` 扫盘在它**之前**、无条件执行 | `appHostHelpers.js:38`（snapshot）早于 `:46-48`（memo 生效点） |
| 14 | App 一次重渲 ≈ **61.95ms（dev）/ 52.25ms（prod）**；让 App **完全不重渲**只需 **9.39ms** ⇒ 收窄 nowTick 的收益上界 ≈ **53ms/帧（85%）** | `node .khyos/tmp/app-memo-bailout.js`（清场、各 2 轮、dev/prod 交错验证） |
| 15 | **memo 覆盖的收益上界仅 12%**（25 个子组件全注入 memo：80.59ms → 70.80ms） | `node .khyos/tmp/app-frame-cost-split.js`；注入报告：22 个包成 memo，3 个已是 memo（ToolLines/Spinner/TranscriptView） |
| 16 | 单帧 CPU 构成（尾部 9s profile）：**同步 I/O ≈ 45%**（`stat` 24.3% + `readdir` 16.1% + `path` 4.0%）· `createElement`@react.development **12.7%** · ANSI 输出流水线 **19.7%** · **yoga 布局仅 0.7%** · GC 2.1% | `node .khyos/tmp/app-cost-profile.js` + `parse-cpuprofile-tail.js` + `who-calls.js` |
| 17 | 合成用例（200 个 Text）dev→prod 快 **20–80×**，但 **App 级只快 16%**；且 `NODE_ENV=production` 下 dev/prod **两个 React 构建同时被加载** | `node .khyos/tmp/frame-floor.js`（dev/prod 交错）· `app-memo-bailout.js` · `which-react.js` |
| 18 | **A5 已实施并实测**：真实代码下 30 次连续读取，扫盘 **30/30 → 1/30**，平均 **7.754 → 0.275 ms/次（降 96.5%）** | `node .khyos/tmp/a5/a5-verify.js`（交错对照 + 取两轮最小值） |
| 19 | TTL 短路**确实排在 `snapshot()` 之前**（本刀唯一的实现要害） | `grep -n` 自检：短路分支在 `appHostHelpers.js:83-88`，`taskStore.snapshot()` 在 `:91` |
| 20 | A5 验收：`node --test` 41 用例 / **40 绿**；唯一红是**既有** `PERMISSION_MODES`（HEAD 即 6 值含 `RedPass`，测试期望 5 值 —— `git diff -U0` 证明与本刀无关）。`check-tui-gates` **计数不变 = 236（R4 合规）** | `node --test tests/tui/appHostHelpersLeaf.test.js tests/cli/tui/perfTunables.test.js`；`node scripts/ci/check-tui-gates.js` |
| 21 | **A0-a 已实施并实测**：`topicBarAnimMs` 320 → 180（+ §3.3 表补 `topicBar` 行）。守卫 baseline 由 **0 error / 1 warning / 6 info** 变为 **0 error / 0 warning / 7 info**；Spinner 那条降级为 `cadence-drift-known`（带出处） | `node .khyos/diag/tui-cadence-guard.js`；反例矩阵 `--scenario=all` 仍 3 warning 且**全在预期负例内**（spec-missing / fallback-drift / spec-unreadable），`aligned` 场景 0 warning |
| 22 | A4 原型的 `impl` 手写清单**确实静默漏报**：改按 arity 动态枚举后，`loadImpl` 返回 **6** 个旋钮（手写清单只有 **5** 个，缺的正是 `taskSnapshotTtlMs`）。`KNOWN_DRIFTS` 白名单把已裁决漂移降为 info | 改后 baseline 的 `unbound-impl` 里出现 `taskSnapshotTtlMs`(250ms)；`loadImpl` 为纯函数可直接单测 |
| 23 | **`tui/healthScorecard.js` 是死模块**：全仓**零调用方**（无 CLI 命令、无 CI job、无测试；其头部注释提到的 `--leak-check` job 不存在）。且 `:32` `require` 了 `perfTunables` 却**从未使用**，`:59` 又把预算硬编码成 `budgetMs: 16` —— SSOT 与消费者漂移的又一实例（同 `[DESIGN-ARCH-101]` §8 的 `ccTimers` 型）。**已修**：`budgetMs` 改走 `perfTunables.frameBudgetMs(env)` | `grep -rln healthScorecard services/backend/tests bin scripts/lib packages` 全空；`services/backend/src` 内仅命中它自身与 `inkRuntime.js:46` 的一条注释 |
| 25 | **A4 已接线为 `RUNTIME-011`（S1 观察者）**：执行器 `scripts/ci/check-tui-cadence.js` + 判定叶子 `scripts/lib/tuiCadenceGuard.js`。`rules:gate:commit` 实测 **13/13 检查器**（原 12）、`action=start target=scripts/ci/check-tui-cadence.js`、`errors=0 warnings=0` —— 与我自跑 baseline（0 error / 0 warning / 7 info）**逐项一致**。反例矩阵 **7/7**；`check-wiring` **97 → 98**（98 个检查器全接线）；`check-rollout-stage` **0 error / 3 warning**（三条均为既有同族 `editFile`/`crossModelVerify`/`trajectoryStatsStore`，本机制**未新增** —— 证明 `STAGE` 字面常量可被它找到）；`check-rules-registry`（含 TOOLING-007 双向可达）/ `check-gov-rules` / `check-repo-layout` / `gen-rules-cards --check` 全通过 | `npm run rules:gate:commit`；`node scripts/ci/check-tui-cadence.js --scenario=matrix`；`node scripts/ci/check-wiring.js`；`node scripts/ci/check-rollout-stage.js`；`node scripts/ci/check-rules-registry.js` |
| 26 | **断言不是装饰（变异测试 5/5 全杀）**：对叶子/薄壳注入 5 个变异体，每个都**必须**让目标用例变红，否则该断言是永远绿的装饰。全部被杀死并逐字节还原（`cp` 备份还原，**未用任何 git 破坏性操作**）。⚠ 首版探针自己踩了一个坑：`--test-name-pattern` 打不中时 `node --test` 会**跑 0 个用例并 exit 0**，看起来像「变异被杀死」—— 探针已补 `# tests > 0` 校验。另：变异测试**抓到一条真漏洞** —— `aligned` 只断言「0 warning」时，「aligned 不对齐」的变异体存活（因唯一存量漂移在白名单里），已补直接断言 | `node .khyos/tmp/a0/mutate-probe.js`（gitignore）；5 个变异体：severityFor 忽略 stage / 方言行带尾随文字 / loadImpl 改回手写白名单 / aligned 不对齐 / KNOWN_DRIFTS 白名单被清空 |
| 24 | **A1 第 3 步的前提为假**：`runtime/topicBar.js` **只有两处写入**（`:134` `_paint()`、`:293` `disable()`），**两处都是 OSC 0**（`\x1b]0;TITLE\x07` 设窗口标题 + BEL 收尾）—— **无光标移动、无单元格绘制**。`:12-17` 自陈 "fully **OUT OF BAND** … zero render conflict"，`:267` 自陈 `suspend()` 是 "**Intentionally a no-op**: the OSC title never overlaps an interactive prompt" ⇒ 它**不争 stdout 出口**，「加仲裁」无对象 | `grep -n "OSC\|BEL\|stdout.write\|out.write" services/backend/src/cli/tui/runtime/topicBar.js` —— 只有 `:134`/`:293` 两处 `write`，且**均为 OSC 0**；逐行读 `:12-17`（设计意图）与 `:267`（suspend 为 no-op） |

### 仅主张（未实测，标注补测方式）

| # | 主张 | 补测方式 |
|---|---|---|
| 1 | 6.25fps 在终端上被人眼判为「一顿一顿」 | **主观量，无法机器测**。须用户实机确认（本文的客观判据是"规范≠实现"，不是"6fps 一定难看"） |
| 2 | ~~「合帧」能降低单帧成本~~ **已实测并改写**：收窄 `nowTick` 的收益上界 = 53ms/帧（#14），但**A5 的收益（49ms/帧）与它高度重叠** —— 两者都在治「App 重渲」 | 见 #14/#12。**A5 与 Q-3 不应同时做**：先做 A5（不动 state 结构、收益已实测），再复测 Q-3 是否还值得 |
| 3 | ~~「三只定时器各自触发重渲染」~~ **已订正**：静态核实发现**对 topicBar 不成立**（走 ink 树外直写），Spinner 有 memo 只重渲自己 ⇒ 该注释前提至少一项不准 | 已升级为 §14 已实测 #7/#8。**仍未复跑运行时 profile** —— 单次重渲染的真实耗时（ms）仍待测 |

### 本轮**未做**（防止被误读为已落地）

- ⚠️ **代码改动共 9 个文件**（另加规范表 `tui/AGENTS.md`）：① A1 第 2 步 —— `TranscriptView.js`（+16/−1，memo 条件导出）、`componentMemoExports.test.js`（+17/−0）；② **A5** —— `perfTunables.js`（+`taskSnapshotTtlMs`）、`appHostHelpers.js`（TTL 短路 + `_resetTaskLinesTtl`）、`perfTunables.test.js`（+5 用例）、`appHostHelpersLeaf.test.js`（+4 用例）。③ **A0-a** —— `runtime/topicBar.js`（注释）、`ink-components/ProgressBar.js`（`RENDER_MS` 解耦）、`services/progressiveProgress.js`（注释）、`tui/AGENTS.md` §3.3 表。⚠ `Spinner.js` **仍原样**（A0-b 冻结）；`topicBar.js` / `ProgressBar.js` 的**动画逻辑**未变，只改了派生源与注释
- ❌ **未新增任何守卫或规则**（§9 是**清单**，不是已执行）——A4 只做了 `.khyos/diag/` 下的**原型**，未接线、未登记
- ❌ **未跑 CI 门档**（`check:tui-gates` 的 226/220 数字引自 [DESIGN-PERF-003]，本文未复跑）
- ⚠️ **A1 只做了第 2 步（memo 覆盖）的第一个组件**；第 1 步（收窄 `nowTick`）与第 3 步（topicBar 直写仲裁）**未动**。第 1 步要动 state 结构，仍须先裁决 Q-3
- ✅ **A5 已实施（做法 2：短 TTL 缓存）**：见 §6 A5 实施记录。⚠️ 但**做法 2 只覆盖「扫盘」这一层，没把 I/O 移出渲染体** —— `App.js:6313` 仍在渲染体里调用，只是那次调用在 250ms 窗口内会短路。**做法 1（移出渲染体）经可行性实证后挂起**（首帧 `taskH=0` ⇒ 帧高自锁，见 §6 A5）
- ✅ **A0-a 已实施**（`topicBarAnimMs` 320→180 + §3.3 表补 `topicBar` 行 + `ProgressBar.RENDER_MS` 解耦）
- ⛔ **A0-b 冻结**（`spinnerFrameMs` 160→80）—— 撞上五篇规范裁决，见 §6 A0-b。**这不是遗漏，是刻意不做**
- ✅ **A4 原型两个缺陷已修**（`.khyos/diag/tui-cadence-guard.js`）：① `impl` 由手写清单改**按 arity 动态枚举**（此前 `taskSnapshotTtlMs` 被静默漏掉）；② 新增 `KNOWN_DRIFTS` 白名单，把「已裁决保留的漂移」降为 info 并带出处（否则长期挂一条消不掉的 warning ⇒ **告警疲劳**）。修后 baseline **0 error / 0 warning / 7 info**

---

## 十五、变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-29 | 初稿。基于 `anim-probe.js` 实测的节拍漂移，确立「动画节拍不是 CPU 旋钮」这一核心判断 |
| 2026-09-29 | 补 A4 守卫原型（`.khyos/diag/tui-cadence-guard.js`）与 6 场景反例矩阵；§10 期望值改为实测值，§14 已实测 4→6 条。矩阵当场抓到原型自身 2 处判据缺陷，已修 |
| 2026-09-29 | 补 A1 影响面实测：量出 heartbeat tick 触发 **App 整树**重渲染（32 组件/144 个 `h()`），而 Spinner 有 memo 只重渲自己；订正 `perfTunables.js:9-13` 注释对 topicBar 的不成立之处。§6 A1 改为按收益排序的做法，§14 已实测 6→8 条 |
| 2026-09-29 | **A1 第 2 步起步**：`TranscriptView` 加 memo 条件导出，`componentMemoExports.test.js` 补数字型静态属性覆盖。新增 `memo-effect-probe.js` 量出净收益（心跳帧 20→0 次重渲，1.73×）。§14 已实测 8→10 条，并**订正**「本文不含任何代码改动」这一已失效表述 |
| 2026-09-29 | **补 A1 第 2 步的上限收益实测**：§6 A1 第 2 步补 `.khyos/diag/memo-coverage.js` 的复现命令与实测读数（24 组件 / 已 memo 2 / 未 memo 22），并如实标注与本节「32 组件」的口径差（探针只数 `h(<大写名>)` 具名组件，两者不是同一个量）。该探针此前在全文零引用，是本次核查发现的唯一孤儿原型 |
| 2026-09-29 | **两个原型迁出 `_产物/`**：`tui-cadence-guard.js`、`memo-coverage.js` 由 `_产物/` 迁入 `.khyos/diag/`（均为「过程态工具」，非交付物），本文全部路径同步；两个脚本的 `__dirname` 相对深度一并修正，迁后 `--scenario=all` 6 场景与本节 §10 期望值**逐条一致**。落点判据真源 `[DESIGN-LAY-002]` §3.1（2026-09-29 新立：交付物 → `_产物/`，过程态工具 → `.khyos/diag/`） |
| 2026-09-29 | **重大订正 + 新根因**：清场后重测单帧成本（62–110ms，帧预算的 4–7 倍），并用 CPU profile 追调用树定位到**渲染体里的同步扫盘**（`App.js:6313` → `_taskStore.snapshot()` → `statSync`/`readdirSync`），打桩对照实测占一帧 **45%（49ms）**。新增 §6 **A5**（优先级最高）、订正头部结论、§4 补证、§14 已实测 10→17 条。同时记录方法论教训：**并行 jest 进程会污染全部墙钟数据** |
| 2026-09-29 | **A5 落地（做法 2）**：`perfTunables` 增 `taskSnapshotTtlMs`（默认 250ms，LOW_POWER → 1000ms，**刻意无独立 override**），`appHostHelpers._readMergedTaskLines` 在 `snapshot()` **之前**加 TTL 短路；门控复用既有 `KHY_TASK_LINES_MEMO`（零新增回退开关）。真实代码实测扫盘 **30/30 → 1/30**、耗时 **7.754 → 0.275ms/次（降 96.5%）**。测试 +9 用例（41/40 绿，1 红为既有 `PERMISSION_MODES`）。`check-tui-gates` 计数不变（236，**R4 合规**）。§14 已实测 17→20 条，「本轮未做」订正 A5 状态 |
| 2026-09-29 | **A0 拆半 + 订正读反的上游文档（重要）**：实施 A0 时发现初稿把 `spinnerFrameMs` 的依据写成 `tui/AGENTS.md:652` 的 80ms，但 `[DESIGN-ARCH-101]` §8 冲突 1 早已**裁定「以 perfTunables 的 160ms 为准」，把 80ms 判为陈旧第三源**（另见 `102` §6.4 / `079` §12.6.1 / `115` §2.2，且 `134` 明确警告 80ms 在帧高饱和时每 tick 近乎整屏重写）。⇒ 160→80 **冻结**，它是规范变更而非默认值调整。**A0-a（topicBar 320→180）已实施**：`perfTunables.js`、`tui/AGENTS.md` §3.3（补 `topicBar` 行 + 给 Spinner 格加 ⚠ 待收敛标注）、`runtime/topicBar.js:58`、`ProgressBar.js`（`RENDER_MS` 由 `spinnerFrameMs` 派生改为由 `progressiveProgress.STEP_MS` 派生，**连带修掉 `LOW_POWER` 下一跳 2% 的既有缺陷**）、`progressiveProgress.js`（订正循环论证注释）、`perfTunables.test.js`（+1 裁决锁）。**A4 原型两缺陷已修**（动态枚举 `impl` + `KNOWN_DRIFTS` 白名单）。守卫 baseline **0/0/7**；`check-tui-gates` 计数不变（236，**R4 合规**）。§14 已实测 20→22 条 |
| 2026-09-29 | **Q-1 裁决：维持 160**（用户裁定）。A0-b 不做；`§3.3` / `BootScreen.js` / `ccTimers.js` 三处陈旧 80ms 的收敛**立为 P1（D10）待办**（须整批做，只改一处会造出新的不一致）。§6 A0-b 与 §13 Q-1 同步标注为「已裁决」 |
| 2026-09-29 | **前提审计（第二、三处推翻）+ 一个真缺陷**：① **A3 作废** —— 原做法「`elapsedSec` 从 Spinner 的 `startedAt` 推导」有三条硬伤：`startedAt` 是**挂载时刻**≠回合起点 ⇒ 秒数**算少**；心跳**已**对齐整秒边界，改用 160ms 时钟**精度更差**；Spinner 本就每 160ms 重渲一次 ⇒ **收益为零**。② **A4 落点评估被推翻** —— `healthScorecard` 是**死模块**（全仓零调用方，其 `--leak-check` job 不存在），「运行时可见」不成立 ⇒ 落点改为**只做 `scripts/ci/`**。③ **真缺陷已修** —— `healthScorecard.js:59` 硬编码 `budgetMs: 16` 改走 `perfTunables.frameBudgetMs(env)`（该文件 `:32` 早就 require 了它却从未使用）。§14 已实测 22→23 条 |
| 2026-09-29 | **A1 第 3 步前提核验：失败（第四处推翻）** —— 原做法「给 topicBar 的 stdout 直写加仲裁」建立在「它与 ink 争同一出口」上，实测**不成立**：`runtime/topicBar.js` 只有两处写入（`:134` `_paint()` / `:293` `disable()`），**都是 OSC 0 设窗口标题**（`\x1b]0;TITLE\x07`），不触光标 / 滚动区 / 任何 ink 管理的单元格；`:12-17` 自陈 out-of-band "zero render conflict"，`:267` 自陈 suspend 是 no-op。⇒ **本步作废**，无仲裁可加。连带订正：§2.3 表、§3 表现② 段（**表现②的机制由「四条」收回「三条」**）、§6 开头 note（三个→四个前提被证伪）、§6 A1 标题与现状表、§6.0 表与执行顺序、§13 新增 Q-6（已证伪、无需裁决）。另修 **两处过期默认值**：§2.3 表 / §6 A1 现状表把 topicBar 的 `320ms` 更新为 `180ms`（A0-a 已回正），并给 §1.1 探针读数加「A0-a 前快照」注。§14 已实测 23→24 条 |
| 2026-09-29 | **A4 接线完成（`RUNTIME-011`）** —— 三步接线 + 第四触点（阶段登记）全部落地：执行器 `scripts/ci/check-tui-cadence.js`、判定叶子 `scripts/lib/tuiCadenceGuard.js`、测试 `scripts/tests/check-tui-cadence.test.js`（29 用例）、`package.json` 别名、`RULES-REGISTRY.json` 条目（`meta.ruleCount` 94→95）、ssot marker、`FEATURE-OWNERSHIP.json` 的 `tui-cadence-guard`、规则卡（95 张）+ 孪生件。**九条判据**（R1×4 / R2×3 / R3×2）由 `severityFor()` 从 `STAGE` **单点派生**。**验收**：`rules:gate:commit` 13/13 检查器 + `action=start` + `errors=0 warnings=0`；反例矩阵 7/7；**变异测试 5/5 全杀**；`check-wiring` 97→98；`check-rollout-stage` 0/3（未新增）；四条规则守卫全通过。**同时修掉 §10 反例矩阵表里三处过期期望值**（baseline「1 warning」、fallback-drift「2 warning」、no-binding「10 info」—— 都是加 `KNOWN_DRIFTS` 白名单之前写的）与新增 `fallback-drift-known` 场景。⚠ 两处边界已写进正文：**ssot 文档未跟踪**（登记表须与真源同批提交）、**R2 与 A0-b 裁决的张力**（兜底容差兜住但未根治）。§14 已实测 24→26 条 |
| 2026-09-29 | **§6 重排：新增 §6.0「前提核验与执行顺序」** —— 按「前提是否已核验」而非编号排列全部 A 项（含状态 / 卡点 / 下一步），并订正 §6 开头那句已被推翻的「顺序不可颠倒：A1 是 A0 的前置条件」（A0-a 不提高帧率，故不依赖 A1）。同时给 A1/A2/A4 标题加状态后缀。**编号刻意不重排**（全文与其它文档按 `A0–A5` 引用，重编号会造死引用） |
