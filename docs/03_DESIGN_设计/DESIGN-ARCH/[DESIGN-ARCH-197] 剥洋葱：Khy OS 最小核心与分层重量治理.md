<!-- IMPL-STATUS: partial -->
<!-- 文档分类: DESIGN-ARCH-197 | 阶段: 设计 -->
<!-- RULES-REGISTRY: TOOLING-012 -->

# [DESIGN-ARCH-197] 剥洋葱：Khy OS 最小核心与分层重量治理

> **本文回答两个问题**：①「Khy OS 太重」到底重在哪儿（体积？逻辑？）；②能不能用剥洋葱法
> 造一个最小核心，并把「逻辑」与「视觉」两件事用同一套方法管起来。
>
> ---
>
> ## 结论卡（2026-10-31 终态）
>
> **问：可以吗？** —— **可以，而且已经落地**（不是提案，是已进库、有守卫、有 CI 接线的工程）。
>
> **问：最小核心有多小？**
>
> | 口径 | 数字 | 相对后端总量（3,510 文件 / 896,817 行） |
> |---|---|---|
> | 入口冷闭包（静态，AST 口径） | **9 文件 / 3,757 行**（其中依赖 8 文件 / 1,298 行） | 0.26% / 0.42% |
> | 入口**顶层 require**（所有命令都付的那一份） | **6 个模块 / 999 行** | — |
> | 运行时最轻路径 `khy --version` | **11 第一方模块 / 7,805 行 / 0 外部模块 / heap 6.5 MB** | **0.31% / 0.87%** |
>
> **问：边界在哪？** —— 按**加载时机**分三层，不按目录：
> L0 芯（装载即入内存）/ L1 膜（被调用才装载）/ L2 皮（终端/桌面/Web 表现层）；
> 逻辑侧 L0–L2，视觉侧 V0–V2，**同一套语义**。
>
> **问：由什么保证不反弹？** —— 机器可读契约 `CORE-LAYERS.json` + 两条守卫
> （静态 `check-core-layers.js` **阻断** / 运行时 `check-runtime-footprint.js` 报告）
> + 5 类重量预算（层冷闭包 / **入口顶层 require** / 视觉首屏 / 运行时足迹 / **顶层边·懒加载边分摊**）
> + 解析器降级必须显式报（不许静默用更差的判定）
> + 每条新判据都做**反向注入验证**（改坏 → 精确点名 → 恢复 → 回绿）。
>
> **问：视觉侧同理在哪？** —— 同一份契约、同一守卫文件、同一预算语义、
> **同一套加载时机判定**（AST 函数作用域 + 运行时求值栈）。
> 已落地的视觉侧剥离：桌面端 `App.tsx` **73 → 37 文件 / 19,385 → 9,415 行（−49%）**；
> 逻辑侧：8 个「终端几何/能力」纯叶子从 `src/cli/tui/` 下沉到 `src/utils/terminal/`，
> 芯的可达闭包里视觉皮文件 **8 → 0**。
>
> ---
>
> **两次口径级自我纠错（本文最有价值的部分 —— 它们证明「测量工具也会骗人」）：**
>
> 1. **「冷闭包」这个数本身算错了**（§1.5）：旧口径用「require 处的括号深度」区分顶层/懒加载，
>    而括号深度 ≠ 函数作用域 —— 顶层 `try{}` 块里的 require 被误判成懒加载（低估），
>    **正则字面量里的括号**还会让深度整体偏移、把函数体内的 require 误判成顶层
>    （`toolUseLoopCore.js` 第 360 行起 **96% 的字符**深度失真 ⇒ 虚高 2.4 倍）。
>    修正：静态侧改 AST 函数作用域、运行时侧改「加载者是否正在求值」；逻辑与视觉两侧同步。
> 2. **P4 的收益前提被推翻**（§9.1）：「10 个适配器从未被 probe」是**探针只数了一种调用**
>    （`detect`）造成的误判 —— 网关对**每个**适配器都调 `getStatus()` 与 `detectAsync()`。
>    ⇒ 按需加载省不到模块，**收益实测归零**；真正的代价在**探活**（读盘/起进程）。
>
> **两次都不是「数错了」，而是「问错了 / 测漏了」，且都是靠再测一次抓到的，不是靠推理。**
>
> 全文数字均为 2026-10-30 / 10-31 实测，可复现（复现命令见 §十）。

---

## 〇、人的意愿（B6-1 可追溯）

| 时间 | 谁 | 要什么 |
|---|---|---|
| 2026-10-30 | 用户 | 「khyos 太重（无论体积还是逻辑）了，可以使用剥洋葱法，打造一个最小核心，然后最重核心，逻辑，视觉上同理可以吗」 |

诉求拆成三个可验收的部分：

1. **量化「重」** —— 体积与逻辑两侧各给实测数字，不靠感觉；
2. **剥出最小核心** —— 要能说清核心有多小、边界在哪、由什么保证不反弹；
3. **逻辑与视觉同理** —— 「最重核心」与「最小核心」之间要能分层递进，视觉侧用同一套手法。

**本文不承诺**把 89 万行砍到某个数——那是一次重构工程，不是本文的交付。
本文交付的是**让重量可被度量、可被约束、可持续下降**的地基与第一刀。

**决策日志（B6：人的意愿可追溯）**

| 日期 | 决策 | 状态 |
|---|---|---|
| 2026-10-30 | 剥洋葱法 + 最小核心 + 逻辑/视觉同理 | **已落地**（契约 + 守卫 + 已剥的刀） |
| 2026-10-30 | 逻辑侧第一刀：8 个终端几何/能力纯叶子下沉 `src/cli/tui/` → `src/utils/terminal/` | **已落地** |
| 2026-10-30 ~ 31 | 视觉侧六刀（React.lazy + 条件渲染）：`App.tsx` 73 → 37 文件 / 9,415 行 | **已落地** |
| 2026-10-31 | 口径修正：静态侧改 AST 函数作用域、运行时侧改「加载者是否正在求值」；逻辑与视觉两侧同步 | **已落地**（基线全部重算并写明是「纠正」还是「收紧」） |
| 2026-10-31 | **P4**（网关适配器按需加载） | **待人决策** —— 收益前提已被实测推翻（§9.1），收益归零；**AI 未执行任何改造** |
| 2026-10-31 | **P2**（`AgentTool → cli/ai.js` 倒挂） | **待人决策** —— 单点改无效（§9.2），方案改为三步；**AI 未改任何接口** |
| 2026-10-31 | **P1**（剪 `src/cli/handlers/` 整层） | **待人决策** —— 属整层接口重构 |

> **为什么这三项停在「待人决策」**：它们会改变**对外可见的行为**（网关选谁、探活哪些适配器、
> CLI 层接口边界），按章程 B7「对外可见的判断归人决策」，AI 只备实测材料、不代拍板。
> 2026-10-31 曾就三项征询意见，**未在时限内收到答复，系统自动选取了推荐项** ——
> 自动选取**不构成人的决定**，故三项均按「未确认」处理：**只做了不改变行为的那一步**
> （P2 的方案与 P4 的纠错），**未执行任何改造**。
> 全部实测数据已写进契约，任何人可据此接着做。

---

## 一、实测：这个系统重在哪儿

### 1.1 体积侧

| 范围 | 文件数 | 行数 |
|---|---|---|
| `runtime/node/backend/src`（后端全部源码） | 3,510 | **896,817** |
| ├ `src/services` | 2,224 | 587,502 |
| │　├ `src/services/domain` | 1,072 | 230,427 |
| │　└ `src/services/gateway` | 229 | 80,601 |
| ├ `src/cli` | 622 | 192,863 |
| │　├ `src/cli/handlers` | 166 | 63,144 |
| │　└ `src/cli/tui`（终端视觉层） | 204 | 50,834 |
| ├ `src/tools` | 235 | 45,052 |
| └ `src/utils` | 152 | 15,638 |
| `apps/khyos-desktop/src`（桌面视觉层） | 104 | 24,952 |

`services` + `cli` 两块占后端的 **87%**。视觉侧另计：TUI 5.1 万行 + 桌面端 2.5 万行。

单文件极值：`src/services/tool/toolUseLoopCore.js` **12,100 行**（核心循环）、
`src/cli/replSession.js` 13,917 行、`src/cli/tui/ink-components/App.js` 367 KB。

### 1.2 逻辑侧：重量不在「有多少文件」，在「一条边连了多少」

静态依赖图（`require` 字面量边，3,076 个模块节点）实测（**2026-10-31 AST 口径**）：

| 入口 | 冷闭包（仅顶层 require） | 可达闭包（含懒加载） | 倍差 |
|---|---|---|---|
| `bin/khy.js`（全入口） | **9 文件 / 3,757 行** | 2,176 文件 / 729,751 行 | **242×** |
| `src/services/tool/toolUseLoopCore.js`（核心循环） | 71 文件 / 30,175 行 | 1,426 文件 / 504,414 行 | 20× |
| `src/services/gateway/aiGateway.js` | 122 文件 / 71,078 行 | 1,426 文件 / 504,414 行 | 12× |
| `src/cli/repl/startup.js` | 1 文件 / 385 行 | 1,476 文件 / 520,016 行 | 1476× |

**这张表就是洋葱的形状。** 冷启动只需要 3,757 行；剩下 72.9 万行是**懒加载边**在运行期
按调用路径逐步拖进来的。也就是说：系统「重」不是因为入口重，是因为**几乎每条功能路径
都会拽进一大片外壳**。

> ⚠ **本表的冷闭包一列在 2026-10-31 之前是错的**（3 文件 / 2,602 行 / 170 文件 / 91,608 行 …）。
> 错在**分类口径**，不在测量 —— 详见 §1.5。可达闭包一列基本不变（2,170 → 2,176 文件），
> 说明「重量分布」的结论不受影响，被改掉的是「每层入口各有多重」。

### 1.5 口径修正（2026-10-31）：之前量到的「冷闭包」是错的

这一节是本文最重要的一次自我修正：**守卫量错了自己要量的东西**，而且错在两个方向。

**旧口径**：用「require 调用处的括号深度」区分顶层 require 与懒加载 require
（深度 0 = 顶层，深度 > 0 = 懒加载）。

**它错在哪**（三个机理，同一个根因：**括号深度 ≠ 函数作用域**）：

| 方向 | 机理 | 实测实例 |
|---|---|---|
| **低估** | 顶层 `try { require(...) }` / `if { require(...) }` 里的 require 括号深度是 1，但它在**模块求值时**就会执行 —— 是装载期重量，却被记成懒加载 | 入口 `bin/khy.js` 的 `windowsSpawnHardening` / `moduleSelfHeal` / `startupPhases` / `debugLog` 四个 require 全在 `try` 块里 ⇒ 入口冷闭包少算 5 个文件 |
| **低估** | **多行解构赋值**里的 require：`const {\n A,\n B,\n} = require('x')` —— `require(` 落在花括号内，深度 ≥1 | `aiGateway.js` 的 4 个方法分片模块（`aiGatewayCooldownMethods` / `RoutingMethods` / `ModelMethods` / `GenerateMethod`）都是这个写法 ⇒ 连带 22 个文件没进冷闭包 |
| **虚高** | **`braceDepthMap` 根本不识别正则字面量**（它只跳过字符串、模板、注释）⇒ 正则里的括号被当成代码结构 ⇒ 从文件中**第一个正则**起，深度整体偏移 | `toolUseLoopCore.js` 第 360 行 `const TOOL_CALL_REGEX = /<tool_call>…/g` 之后，**475,083 个字符里 458,396 个（96%）深度失真** ⇒ 后面所有函数体内的 require 都被误判成顶层边 |

> **「深度再也不回 0」这个说法本身也是错的** —— 偏移是**双向**的：
> 字符串/正则里的 `}` 会让深度比真实值**小**，函数体内的 require 于是落到「深度 0」
> （⇒ 虚高）；`{` 会让深度比真实值**大**，顶层 require 于是落到「深度 ≥1」（⇒ 低估）。
> 到底偏哪个，取决于文件里先出现的是哪种字符 —— **所以它不可预测**。
> 这不是「某个文件写得不规范」，是**判据本身没有定义**。

**实测差异（同一个根，两个方向相反）**：

| 层根 | 括号深度口径 | AST 口径 | 谁错了 |
|---|---|---|---|
| `bin/khy.js` | 3 文件 / 2,602 行 | **9 文件 / 3,757 行** | 旧的**低估**（漏了 4 个装载期 require + 其传递依赖） |
| `toolUseLoopCore.js` | 170 文件 / 91,608 行 | **71 文件 / 30,175 行** | 旧的**虚高 2.4 倍**（正则导致的深度偏移，把懒加载的模块算进了冷闭包） |
| `aiGateway.js` | 100 文件 / 50,928 行 | **122 文件 / 71,078 行** | 旧的**低估**（4 个多行解构的方法分片模块被当成懒加载） |

**两个方向都错 ⇒ 这样的数字不能当预算。** 一个只涨不跌的棘轮，如果基线本身错了，
它锁住的是错误。

**修正后的两套口径**（各司其职）：

| 侧 | 口径 | 实现 | 为什么它对 |
|---|---|---|---|
| 静态（守卫、预算） | **AST 函数作用域**：require 不在任何函数体内 ⇒ 顶层边 | `scripts/lib/requireGraph.js`（@babel/parser，后端包的直接依赖） | 「不在函数体内」= 「模块求值时必被执行」，这是定义本身 |
| 运行时（探针、分摊） | **加载者是否正在求值**：加载发生在此刻 ⇒ 装载期边 | `scripts/lib/runtimeFootprint.js`（求值栈，零依赖） | 运行时真相，不猜源码；且**不往被测进程里塞解析器**（塞了会污染外部依赖与 heap 读数） |

> **两条纪律，都是这一轮踩出来的**：
> ① **判据自己有盲区时，必须显式报出来**，不许静默降级 ——
>    `@babel/parser` 解析不到时 `requireGraph` 会回退到旧口径，守卫随即报
>    `core-classifier-degraded` 告警并说明「数字不可信」。实测 3,076 个模块 0 回退。
> ② **口径变了，基线必须跟着重算，且要说清是「纠正」还是「放松」** ——
>    入口 3 → 9 文件不是放宽预算，是**纠正一个算错的基线**；核心循环 170 → 71 是**收紧**。
>    两种方向都写进文档，人才能判断。

### 1.6 视觉侧同源修正（2026-10-31）：「写了同口径」不等于「跑着同口径」

逻辑侧改口径之后，视觉侧的文件头注释仍写着「与逻辑侧同口径」—— 但它跑的是**同一份有缺陷的实现**。
**一份写着「同口径」却跑着另一套语义的契约，等于没有契约。** 故一并换掉。

视觉侧比逻辑侧多三条语义，**必须显式处理、不能照抄**：

| 差异 | 规则 | 理由 |
|---|---|---|
| ESM `import` | **提升**（hoisted）⇒ **恒为装载期边** | 无论写在模块哪一行、哪怕写在函数体内，它都在模块求值时执行 —— 逻辑侧「函数体内 = 懒加载」对 ESM 不适用 |
| ESM `export ... from` | 同样**提升** ⇒ 装载期边 | 旧口径的正则**完全没统计**这类边（本仓实测 0 条，但那是运气，不是口径正确） |
| `import type { T }` | 被**擦除** ⇒ 不构成运行时边 | 否则会凭空多一条静态边 |

实测（651 个视觉侧文件，**0 降级**）：

- **11 个 V0 根里只有 1 个变化**：`tui/ink-components/Transcript.js` 15 → **17 文件 / 4,178 行**
  （`ProcessGroup.js` 里两个顶层 `try{}` 中的 require 被旧口径误判成懒加载 ⇒ **旧数字是低估**）；
- 其余 10 个根**分毫未动** —— 桌面端与 web 前端是 ESM，本来就没踩到这个坑；
- **35 条边的归属变了**（如 `App.js` 的 14 个 require 从「懒加载」纠正为「静态」）；
- 顺带修掉一类**假边**：旧正则会匹配**注释里**的 require 文本 ——
  `tui/ink-components/caretGeometry.js` 的注释明写「本叶子**绝不** `require('./PromptFrame')`」，
  工具把这句话当成了一条真实静态边。**测量工具读到了架构注释，并把它当成了代码。**

> **一个不该混为一谈的地方**：`scripts/lib/toplevelSideEffectGuard.js`（RUNTIME-012）仍用手写词法扫描，
> **但那不是同一个缺陷** —— 它判的是「顶层是否调用了会 require/spawn/connect 的函数」，
> 不是加载时机分类；且该文件有**零依赖硬约束**（仓库 94 个检查器无一 require 外部 npm 包，
> 原型曾用 acorn 但它不是直接依赖、已弃用），并要扫 3,035 个文件 / 27MB（AST 在这个量级不可接受）。
> 它的深度判定只影响**候选建议**（可切 / 需人判），**不进入任何重量预算**。
> 记入契约 `blindSpots.knownGaps`（`open-by-design`），不藏。

### 1.3 支配树：重量汇聚在哪

对核心循环做支配树分析（某模块支配 X = 从入口到 X 的每条路径都经过它），实测最大支配子树：

| 支配者 | 支配子树 | 含义 |
|---|---|---|
| `src/cli/ai.js` | **12.7 万行 / 321 文件** | 拽掉它可整片剥离 |
| `src/cli/aiConversationOps.js` | 8.0 万行 / 204 文件 | 同上 |
| `src/cli/handlers/gateway.js` | 7.6 万行 / 199 文件 | 同上 |
| `src/cli/handlers/gatewayManageDaemon.js` | 3.6 万行 / 111 文件 | 同上 |

**核心循环的重量，一大半是 CLI 外壳贡献的。** 核心之所以是 50 万行而不是 9 万行，
根因是一条 5 层的反向依赖链：

```
src/services/tool/toolUseLoopCore.js      ← 核心
  └─ src/tools/AgentTool/index.js          ← 工具层
      └─ src/cli/ai.js                     ← 外壳（CLI 编排层）
          └─ src/cli/aiConversationOps.js
              └─ src/cli/handlers/gateway.js
                  └─ src/cli/handlers/gatewayManageDaemon.js
                      └─ src/services/aiManagementServer.js
```

AgentTool 只想拿一个 `ai.chat()`，代价是把整条网关管理栈拖进闭包。

### 1.4 视觉侧：同一个洋葱

对核心做「可达闭包」扫描，**8 个 `cli/tui/` 文件落进了逻辑芯**：

```
cli/tui/effectiveCols.js  effectiveDims.js  railLayout.js  chromeBudget.js
cli/tui/sidebarLayout.js  cli/tui/runtime/terminalCapabilities.js
cli/tui/mouseButtons.js   cli/tui/noticeInbox.js
```

路径同样是 `核心 → AgentTool → cli/ai.js → … → cli/handlers/gateway.js → cli/tui/`。

**这 8 个文件不是渲染代码** —— 它们是纯算法叶子（零 IO、确定性）：终端尺寸真源、
侧栏/右栏宽度算术、chrome 行数账本、终端能力探测、通知收件箱。
它们之所以住在 `cli/tui/`（视觉皮）下，是因为**谁先需要它，它就住在谁那里**。

> **这就是「视觉上同理」的落点**：逻辑侧被视觉污染，与视觉侧被逻辑污染，
> 是同一个洋葱被剥错方向的两种表现。治理手法完全相同。

---

## 二、洋葱模型：为什么用「加载时机」分层，而不是用目录分层

仓库已有 `L0–L6` 板块（`[DESIGN-LAY-005]`），它管的是**位置轴**：东西放哪、谁能 require 谁。
但它不回答「这系统有多重」—— 同一套位置规则下，重量可以从 10 万行涨到 90 万行，守卫全绿。

所以洋葱的层不能用目录名切，要用**加载时机**切：

| 层 | 名 | 判据 | 治理手段 |
|---|---|---|---|
| **L0** | 芯 core | 冷启动即入内存 | 冷闭包**重量预算** + **不得反向依赖** |
| **L1** | 膜 membrane | 被调用时才装载 | 重量预算（按入口分别记） + **不得依赖皮** |
| **L2** | 皮 skin | 终端/桌面/Web 表现层 | 只调 L0/L1；**不得被 L0/L1 依赖** |

**「剥洋葱」的操作定义** = 把 L0 的重量预算压住，让它只许减不许增；
L1/L2 随功能长胖无妨，因为它们不进冷启动路径。

### 2.1 为什么必须区分顶层 require 与懒加载 require

不区分就量重量，数字没有意义：全入口冷闭包 3 文件 2,602 行 vs 可达闭包 2,170 文件 73 万行，
差 **281 倍**。用后者当预算，任何代码都算「超预算」，守卫会立刻变成摆设。

判定口径：扫描源码时按括号深度定位 `require` 关键字，深度 0 记为顶层边（模块装载即求值），
深度 > 0 记为懒加载边（只在调用路径上求值）。

### 2.2 与既有真源的关系（四轴正交，不重复造轴）

| 轴 | 真源 | 守卫 | 管什么 |
|---|---|---|---|
| 位置 | `[DESIGN-LAY-005]` | `check-repo-layout.js` | 目录层级、跨层 require |
| 域方向 | `DOMAIN-DEPS.json` | 同上（domain-direction） | 五域 D1–D5 方向 |
| 模块边界 | `ARCHITECTURE-POLICY.json` | `check-zcode-baseline.js` | 单文件行数、环、深引用 |
| **重量** | **`CORE-LAYERS.json`（本文新增）** | **`check-core-layers.js`（本文新增）** | **层有多重、能不能反向依赖** |

---

## 三、既有守卫的盲区（为什么之前没人看见「芯被污染」）

`archDebtScan` 的 R1 规则**只扫 `src/services/** → src/cli/**`**。而实测倒挂发生在
`src/tools/** → src/cli/**`（AgentTool）—— **在 R1 的扫描范围之外**。

结论：**「芯被外壳污染」这件事，此前没有任何守卫看得见。** 这不是执行不到位，
是覆盖范围本身没画到那一格。

---

## 四、剥洋葱的操作手册（剪层，而不是剪边）

### 4.1 实测：剪单条边无效

试剪 `AgentTool → cli/ai.js`：核心闭包 **1,429 文件 / 506,738 行，一行没少**。

因为 `cli/ai.js` 在闭包内有 **8 条入边**：

```
cli/handlers/review.js          services/domain/session/session/sessionForestService.js
cli/bannerDataService.js         tools/AgentTool/index.js
coordinator/workerAgent.js       services/aiManagementServer.js
jobs/cronScheduler.js            （+ cli/ai.js 自身）
```

**洋葱法要剪的是一整层，不是单条边。** 剪层必须同时剪掉目标模块的**全部入边**。

### 4.2 实测：剪层的收益（对每个候选剪掉其全部入边）

| 剪掉 | 核心闭包减少 |
|---|---|
| `src/cli/ai.js`（8 条入边全剪） | **12.8 万行 / 322 文件** |
| `src/cli/aiConversationOps.js` | 8.1 万行 / 205 文件 |
| `src/cli/handlers/gateway.js` | 7.9 万行 / 200 文件 |
| **整个 `src/cli/handlers/` 外壳** | **8.5 万行 / 214 文件**（涉及 8 个源文件） |
| 整个 `src/cli/tui/` 皮 | 2,973 行 / 8 文件（涉及 8 个源文件） |

### 4.3 三种切法，各自的代价

| 切法 | 做法 | 收益 | 代价 |
|---|---|---|---|
| **A. 下沉（本文采用）** | 把「该在通用层的能力」从皮搬到芯 | 根治：依赖方向永久正确 | 需要甄别「哪些能力是通用的」 |
| B. 剪层 | 一次性剪掉某外壳的全部入边 | 立竿见影 | 断得多、回归面大，且下次加功能会长回来 |
| C. 抽接口 | 在缝上插一层 DI/端口 | 干净 | 改动面最大 |

**A 优于 B/C 的地方**：剪边只是把重量藏起来，能力仍然错位，下次有人再从芯引一次皮，
重量就回来了。**下沉是把能力归位**——归位之后，方向本身就正确，不需要靠人记着别再引错。

---

## 五、第一刀（已落地）：终端几何与终端能力下沉

### 5.1 做了什么

8 个纯叶子从 `src/cli/tui/` 迁到 **`src/utils/terminal/`**（通用层），
皮侧原路径保留 re-export 门面，调用方零改动、字节等价：

| 文件 | 原位置 | 新真源 | 性质 |
|---|---|---|---|
| `effectiveDims.js` | `cli/tui/` | `utils/terminal/` | 终端尺寸真源（sticky / band / contentWidth） |
| `effectiveCols.js` | `cli/tui/` | `utils/terminal/` | 上述的 legacy 别名 |
| `sidebarLayout.js` | `cli/tui/` | `utils/terminal/` | 侧栏宽度算术（纯函数） |
| `railLayout.js` | `cli/tui/` | `utils/terminal/` | 右栏几何（纯函数） |
| `chromeBudget.js` | `cli/tui/` | `utils/terminal/` | 固定 chrome 行数账本（纯算术） |
| `terminalCapabilities.js` | `cli/tui/runtime/` | `utils/terminal/` | 终端能力探测（自述服务 CLI+TUI） |
| `mouseButtons.js` | `cli/tui/` | `utils/terminal/` | 鼠标能力分级与命中测试（零依赖） |
| `noticeInbox.js` | `cli/tui/` | `utils/terminal/` | 一行话收件箱（发布订阅，零 IO） |

**为什么是这 8 个**：它们是「零 IO、零渲染、被多个端共用」的纯能力，
放在视觉皮下纯属历史偶然。`terminalCapabilities.js` 的文件头自己写着
「Single source of truth for terminal capability detection across ALL surfaces (CLI, TUI)」——
它的归属早就写在代码里了。

### 5.2 6 处跨层引用改为直连逻辑侧

| 调用方 | 改前 | 改后 |
|---|---|---|
| `cli/handlers/gateway.js:379` | `require('../tui/effectiveCols')` | `require('../../utils/terminal/effectiveCols')` |
| `cli/spinner.js:388` | `require('./tui/effectiveCols')` | `require('../utils/terminal/effectiveCols')` |
| `cli/palette.js:23` | `require('./tui/runtime/terminalCapabilities')` | `require('../utils/terminal/terminalCapabilities')` |
| `cli/aiChatCore.js:2533` | `require('./tui/noticeInbox')` | `require('../utils/terminal/noticeInbox')` |
| `cli/aiRenderer.js:62` | `require('./tui/effectiveCols')` | `require('../utils/terminal/effectiveCols')` |
| `cli/steps.js:40` | `require('./tui/effectiveCols')` | `require('../utils/terminal/effectiveCols')` |

> 后两处是补扫时才发现的漏网：首轮只改了守卫报出的 4 处，全仓扫「谁引用皮侧门面」
> 时又揪出 2 处**逻辑侧经门面绕路**的引用。门面的存在是为了兼容既有调用路径，
> 不是让人继续走老路——所以守卫加了一条 `facade-cross-layer` 判据把它们钉住。

### 5.3 效果（实测）

**芯的可达闭包中，视觉皮文件从 8 个降到 0 个。** 守卫的 `skin-into-core` 判据由红转绿。

### 5.4 边界守住的证明

搬迁后 8 个叶子**之间的相对引用一条都没改**（`./sidebarLayout`、`./railLayout`、
`./chromeBudget` 全部仍在同目录，路径自动成立）——这证明它们是真正自洽的纯叶子簇，
不是靠互相调用撑起来的假模块。皮侧 re-export 保证既有 `require('../effectiveCols')`
等调用路径字节等价可用。

### 5.5 回归验证

| 范围 | 结果 |
|---|---|
| `node --test` 相关套件（footerLayout / footerMemory / ccOverlayLayout / tuiFrameLedger / tuiHistoryPersist） | 49/49 通过 |
| `jest` 相关套件（tui / spinner / palette / gatewayManage / gatewayStatus 共 37 套） | 35 套通过、2 套失败 |
| 2 个失败套件的性质 | **存量失败**：`gatewayStatus.preferredAdapterHint` 与 `gatewayManage.portDrift.integration` 在 `HEAD` 原始版本上同样失败，与本次改动无关（已用 `git checkout HEAD --` 对照验证） |
| **全量 `node --test src/**/*.test.js`** | **383 套件 / 6,945 断言，0 失败**（2026-10-30，覆盖逻辑侧下沉与 4 处 require 路径改的全部 src 范围） |
| 全量 `jest`（后端 `tests/`） | 21 套件失败 —— **分类后 19 个是 node:test 文件被 jest 误收、1 个自运行脚本、0 个真 jest 套件**；逐文件用 `node --test` 跑，18/19 通过（唯一例外 `rtkMode.test.js` 的 `parseGrepOutput`，**严格对照：还原到 HEAD 后同样失败**，存量） |
| 桌面端 `npm test` + 类型检查 | **107/107 通过**；类型检查「既有 4 条 / 实际 4 条，无新增错误」 |

> **「21 个失败」的真相**：不是 21 个 bug，而是**运行器不匹配**。
> 仓库的 `jest.config.js` 会按 `require('node:test')` 标记自动排除 node:test 文件，
> 但**漏掉了部分**（比如 `src/**` 下与实现同目录的那些），
> 于是 jest 把它们当自己的套件跑，套件自己 `process.exit(1)` → jest 报 FAIL。
> 用对运行器（`node --test`）跑，同样的文件全绿。
> **教训**：看到大批失败先分类，别急着修 —— 先问「它该由谁跑」。

---

## 六、视觉侧同构：同一套方法用在「看得见的重」上

> 逻辑侧剥的是「芯里混进了外壳」，视觉侧剥的是「首屏里混进了用时才需要的面板」。
> **两者的病因同构**：能力被放在错误的位置，导致重量前置。
> 逻辑侧的正确解法是让能力归位（下沉），视觉侧的正确解法是让面板按需加载（懒加载）。

### 6.1 实测：视觉侧的重量在哪

三个视觉端各有自己的栈，但用**同一套口径**度量：静态边（顶层 `import`/`require`）
决定首屏冷闭包，动态边（`import()`）按需加载。

| 视觉入口 | 静态冷闭包 | 含动态可达 | 低频页面占比 |
|---|---|---|---|
| 桌面端 `renderer/App.tsx` | **73 文件 / 19,385 行** | 同左 | **26 文件 / 7,710 行 = 39.8%** |
| web 前端 `src/main.js` | **4 文件 / 983 行** | 同左 | 0%（**已剥好**） |
| TUI `cli/tui/app.js` | 172 文件 / 50,537 行 | 同左 | 0% |

**web 前端已经剥好了** —— 它用 Vue 路由懒加载（`router-view` + 动态 `import()`），
首屏只 4 个文件。桌面端和 TUI 还没有。

### 6.2 桌面端的病灶：两处静态 import 把低频页面前置

**病灶一**：`App.tsx` 顶层静态 import 三个**全屏替换分支**页面：

```tsx
import { KeyManagerPage } from './components/keyManager/KeyManagerPage'
import { SettingsPage } from './components/settings/SettingsPage'
import { AutomationsPage } from './components/automations/AutomationsPage'
```

这三页只在特定路由（`route === 'settings'` 等）下渲染，一天可能开不了一次——
但静态 import 让它们的代码**照样进首屏 bundle**。

**病灶二**：`SidePane.tsx` 是个多标签容器，7 个面板全部静态 import：

```tsx
import { TerminalPanel } from '../terminal/Terminal'
import { GitPanel } from '../git/GitPanel'
import { BrowserPane } from '../browser/BrowserPane'
// … 共 7 个
```

用户不点那个标签，它的代码也进首屏。而且 `SidePane` 挂在 `AppLayout` 上，
所以 `AppLayout`（视觉芯）的冷闭包里直接渗入了 `BrowserPane`（应懒加载的低频页面）——
**这与逻辑侧「芯里混进外壳」是同一个病**。

### 6.3 第一刀：两处改 `React.lazy` + `Suspense`

| 改点 | 手法 |
|---|---|
| `App.tsx` 三个全屏页 | `lazy(() => import(...).then(m => ({ default: m.X })))` + `Suspense` |
| `SidePane.tsx` 七个面板 | 同上，`Suspense` 边界放在 `TabBody` 内 |

命名导出（非 default）用 `.then(m => ({ default: m.X }))` 转成 lazy 需要的形态；
`Suspense` 边界与既有 `ErrorBoundary` 并列——加载失败仍由 ErrorBoundary 兜底。

### 6.4 效果（实测）

| 指标 | 改前 | 改后 | 降幅 |
|---|---|---|---|
| `App.tsx` 首屏冷闭包 | 73 文件 / 19,385 行 | **44 文件 / 10,857 行** | **−40% / −44%** |
| 其中低频页面 | 26 文件 / 7,710 行（39.8%） | **2 文件 / 301 行（2.8%）** | **−96%** |
| `AppLayout.tsx` 首屏冷闭包 | 38 文件 / 8,777 行 | **21 文件 / 5,172 行** | **−45% / −41%** |

### 6.5 视觉侧第二刀：`WorkspaceSidebar → FileTree`（由方向判据抓出来的）

§六.3 的第一刀修完后，我自查发现一个缺口：**契约里定义了 `visual.edgePolicy`
（视觉侧方向矩阵），但守卫从未消费它** —— 只读了顶层 `contract.edgePolicy`（逻辑侧）。

> **一份没人执行的契约等于没有约束。** 这与我在 §7.7 批评探针的五个缺陷是同一类错误：
> 「写下了」不等于「生效了」。

补上判据后，它立刻抓出一条真违例：`WorkspaceSidebar`（V0 视觉芯）静态 import
了 `FileTree`（V1 按需面板）—— 侧栏有两个视图（tasks / fileTree），
文件树**只在点「查看文件」后**才渲染，却进了首屏闭包。与第一刀修的三页完全同型。

修法一致：`React.lazy` + `Suspense`。修完违例归零。

**顺带修正了一处层定义错误**：`ToolLines`（工具调用渲染）原先归到 V1（按需面板），
但它是**转录区的组成部分**（`Transcript` 渲染它），属 V0。
不修正的话 `Transcript(V0) → ToolLines(V1)` 会被误判成越界边。

**判定方法的关键**：方向判据不能按「闭包包含」判，必须按「归属 + 逐条边」判。
闭包互相重叠（V0 的闭包含 V2 的根），按闭包判会把 1 条真违例放大成 25 条误报；
改用「先判归属（从各层根出发 BFS，只走本层内，遇别的层的根就停），再逐条边判」，
违例数从 25 收敛到 1，精确指向真问题。

### 6.6 视觉侧口径对齐 —— 之前量到的「5 万行首屏」是误判

这一轮补齐了视觉侧的两个缺口，过程中修正了**一个影响所有历史读数的口径错误**。

**缺口一：两个 web 前端没有任何层归属。**
「无归属即无约束」——web 前端的视觉重量无人管、方向无人判。补齐后实测发现：

| 前端 | 剥得如何 | 机制 |
|---|---|---|
| ai-frontend (Vue) | **已剥好** | `composables/useRoutePrefetch.js` 的 `viewLoaders` 单一真源表，router 消费同一表 + idle 预取；契约测试 `router/nav.wiring.test.js` 断言每个路由解析到真实 chunk |
| khyquant-frontend (Vue) | **已剥好** | 路由全部 `component: () => import(...)` + `App.vue` 的 critical/non-critical 分级预取 |
| 桌面端 (React) | 本轮剥 | 上一轮改 10 个页面为 `React.lazy` |
| TUI (Ink/CJS) | **未剥** | 见 §6.11 |

> 两个 web 前端是仓库里剥得最彻底的 —— **它们用的正是我给契约设计的同一套「集中式懒加载表」模式**。
> 记进契约 `visual.peeledSurfaces`，免得后人重复劳动。

**缺口二：视觉侧的边表没区分加载时机。**
`visualLayerGraph.js` 首版把**所有** `require()` 都算作静态边，包括函数体内的懒加载。
这与逻辑侧（按括号深度区分）**不一致** —— 于是：

| 影响 | 修正前 | 修正后 |
|---|---|---|
| `tui/app.js` 首屏冷闭包 | 172 文件 / **50,537 行** | **2 文件 / 773 行** |
| `PromptFrame.js` 冷闭包 | 6 文件 / 1,558 行 | 4 文件 / 1,404 行 |
| 方向判据误报 | `sidebarRail(V0) → SidebarPanel(V1)` | **消除**（那条 require 在函数体内，是懒加载） |

> **「视觉与逻辑同理」此前只在文档上成立** —— 两边的加载时机口径并不一样，
> 视觉侧量出来的数是偏高的。修正后 TUI 的真实首屏只有 **773 行**，
> 而不是我上一轮报告的 5 万行。

**顺带修正两处层归属错误**：
- `App.tsx` / `tui/app.js` 是**首屏入口**，属 V0，此前被我误归到 V2（导致 V0 预算缺了桌面端主入口）；
- `ToolLines` 是转录区组成部分，属 V0，此前误归 V1。

### 6.7 视觉侧第三刀：把选刀从「直觉」变成「归因」

前两刀我是**凭直觉**选的：「哪些页面看起来低频」。这轮补上逻辑侧早已有、视觉侧却缺的能力——
**加载归因**（谁把重量拽进来的）。

`visualLayerGraph.attributeEntry()` 给出入口每个直接依赖的可达重量，守卫在报告段输出
「下一刀候选」。据此定位：

```
App.tsx            → AppLayout.tsx        （可达 19 模块 / 4,641 行）← 最大
AppLayout.tsx     → WorkspaceSidebar.tsx （可达 10 模块 / 2,830 行）
                    → TitleBar.tsx        （可达 13 模块 / 1,646 行）
                    → CommandCenter.tsx   （可达 10 模块 / 1,230 行）← 选中
```

`CommandCenter` 是 **Ctrl+K 命令面板**：`CommandCenter.tsx` 自身第 181 行
`if (!visible) return null` —— 不可见时**不渲染任何东西**，但此前静态 import，
一直在首屏 bundle 里。典型的「按需才用却前置加载」。

改法与前两刀同型：`React.lazy` + `Suspense`，并把父层改为**条件渲染**
（原先组件常驻挂载、靠 `visible` 返回 null；现在不可见时不挂载 —— 语义等价）。

**收益**：`App.tsx` 43→**42 文件**、10,576→**10,326 行**；
`AppLayout.tsx` 20→**19 文件**、4,891→**4,641 行**。

> **与逻辑侧的分工**：
> 逻辑侧的归因判据是**约束**（重量闸门不许变大）；
> 视觉侧的归因判据是**指引**（下一刀候选）——
> 因为视觉层的重量天然随功能增长，只锁不许减没有意义，要告诉人往哪儿砍。

### 6.8 P7 补齐：「已剥好」需要测试护着才算数

khyquant 前端**早已剥好**（27 条路由全部 `() => import(...)`），但**没有契约测试护着**——
有人把某个 `import()` 改回静态 import，首屏会静默变重且**不报错**。

ai-frontend 早就补上了这个护栏（`src/router/nav.wiring.test.js`），khyquant 没有。
本轮补齐 `src/__tests__/routerLazyLoad.contract.test.js`（vitest，与该前端既有 14 个测试同构），
断言四件事：

1. 每条路由的 component 都是动态 import（**无静态 component 逃逸**）；
2. 每个动态 import 指向的 view 文件**真实存在**（路径写错会运行时空 chunk）；
3. 动态 import 的目标都落在 `@/views/` 下（路由视图目录约定不漂移）；
4. `router/index.js` **顶层没有静态 import 任何 view**（顶层 import 会进首屏 bundle）。

实测四条断言全部 PASS（27 条路由 / 零逃逸 / 零缺失 / 零顶层静态 view import）。

> **「已剥好」不是状态，是需要维护的性质。**
> 契约里记下「谁剥好了」的同时，也必须记下「谁在看着它」——
> 否则下一刀之外，还会有人从旁边把它悄悄推回去。

### 6.9 视觉侧第四~六刀：候选靠「扫」不靠「猜」

**第四刀**：归因榜的下一批是 `ToolExecutionPanel`（8 模块 / 910 行）与 `ContextUsagePanel`
（2 模块 / 758 行）。两者的共同形状：**没有内容时返回 null**
（`ToolExecutionPanel` 在 `executions.length === 0` 时 return null；
`ContextUsagePanel` 由 `showContextUsage` 与 `messageCount` 控制）——
即「不显示时不渲染任何东西」，与 CommandCenter 同型。

**第四刀收益**：`App.tsx` 42→**40 文件**、10,326→**9,815 行**。

**第五、六刀的做法**：不再凭归因榜猜，而是**扫出全部条件渲染组件**，
再逐个量五件事：① 传递重量 ② 副作用标记 ③ **cleanup 是否完整**
④ **是否被入口直接引用** ⑤ **入边广度**。

一轮扫出 **9 个**候选，最终切了 3 个：

| 候选 | 传递重量 | 副作用 | 决定 |
|---|---|---|---|
| `DiffSummary`（改动文件摘要） | 2 文件 / 493 行 | 无 | **切** |
| `ElicitationPanel`（人在环审批） | 1 文件 / 151 行 | 无 | **切** |
| `ProcessMonitorDialog`（进程监视器） | 2 文件 / 453 行 | 有，**但 cleanup 完整** | **切** |
| `MessageBubble` | 14 文件 / 2,602 行 | 无 | **不切** —— 它是消息列表主体，拆它等于拆首屏 |
| `ModeSelector` | 2 文件 / 422 行 | 有，无 cleanup | **不切** —— 第三条判据不过 |
| `WorkspacePicker` | 735 行 | — | **不切** —— 它是 `Composer` 的 `header` prop，始终渲染（非条件渲染） |
| `Icon` | 329 行 | 无 | **不切** —— 被 **29 个模块**静态引用，是共用基础设施 |

**第五刀收益**：`App.tsx` 40→**38 文件**、9,815→**9,521 行**。
**第六刀收益**：`App.tsx` 38→**37 文件**、9,521→**9,415 行**；`AppLayout.tsx` 19→**18 文件**。

> **⚠ 第三条判据被实测修正了一次**
>
> 原判据说「有订阅型副作用就不能条件挂载」，但 `ProcessMonitorDialog` 是反例：
> 它的 1s 轮询（`clearInterval`）与 Esc 监听（`removeEventListener`）**都带完整 cleanup**，
> 条件挂载时 cleanup 会跑，不存在漏订阅。
> **反过来，常驻挂载才是问题**：此前对话框关着时那个 1s 轮询还在跑（每 1000ms 问一次 host）。
> 改懒加载后关着就不跑 —— **常驻的副作用本身也是重量**。
>
> 于是判据升级为五条：
> ① 不显示时确实不渲染任何东西；
> ② **副作用带完整 cleanup 时这条自动通过**（条件挂载不漏订阅）；
> ③ 没有依赖常驻的状态（快捷键注册、全局单例）；
> ④ **不是首屏主体**（被入口根直接引用）；
> ⑤ **不是共用基础设施**（被 ≥3 个模块静态引用）。

> **⚠ 同类形状不等于同类安全 —— 真实反例**
>
> 归因榜上 `SidePane` 也在（635 行），乍看同型，但**不能这样改**：
> `AppLayout.tsx` 的注释明确写着「SidePane 本身**始终挂载** —— 其 Ctrl+Alt+B / Ctrl+J
> 快捷键注册在 visible 闸门之前，**条件挂载会让隐藏态丢快捷键**」。
>
> 这五条已写进契约 `visual.lazyLoadSafety`（含 safe 名单、unsafe 反例、方法记录），
> 免得下一个人再判一遍。**「哪些不能切」比「哪些能切」更值钱。**

### 6.9b 候选扫描与防回退：固化进库，不再靠临时脚本

上一轮的候选扫描是一次性探针。这轮把它**固化成常驻能力**：

- `scripts/lib/visualLayerGraph.js` 新增 `findLazyCandidates()` ——
  扫条件渲染形态 + 量传递重量 + 检副作用与 cleanup + 判首屏主体与共用基础设施；
  候选判定从此是**机器做的**，不靠人读代码。
- 新增 `checkStillLazy()` —— 防回退：safe 名单里的组件必须仍是懒加载。

**防回退判据（`visual-lazy-regression`，error 级）**：
重量棘轮是**事后**抓到（闭包变大），本判据给**事前**信号。

> **实现上踩的三个坑（都是真 bug）**：
> 1. `lazy()` 写在**导入方**文件里，不在被导入的组件文件里 ——
>    一开始查错了对象，判据永远不报；
> 2. 组件名与文件名常不同（`ContextUsagePanel` 来自 `ContextUsage`、
>    `DiffSummary` 来自 `DiffViewer`、`TerminalPanel` 来自 `Terminal`）——
>    不能用 basename 匹配，要认 `.then(m => ({ default: m.X }))` 里**显式写的 X**；
> 3. 正则里**不能用 `[^)]` / `[^}]` 跨嵌套括号** —— `((m) => ({ default: m.X }))`
>    里两种括号都有，任何单一排除都会在中间截断。改成「两步法」：
>    先定位 `lazy(` 起点，再在有限窗口内找 `default:` 后面的属性名。
>
> 三条都是「判据本身骗人」的实例 —— 与 §7.7 的探针缺陷同源：
> **测量工具也会骗人，判据也要验。** 本判据做了反向验证：
> 把 `ProcessMonitorDialog` 改回静态 import → 判据 EXIT=1 并精确点名。

### 6.10 视觉侧累计

| 指标 | 初始 | 现在 |
|---|---|---|
| `App.tsx` 首屏冷闭包 | 73 文件 / 19,385 行 | **37 文件 / 9,415 行** |
| 低频页面占比 | 39.8% | **2.8%** |
| 已完成的刀 | — | **7 批 / 14 处组件** |

| # | 刀口 | 手法 |
|---|---|---|
| 1 | `App.tsx` 三个全屏页（Settings / Automations / KeyManager） | `React.lazy` |
| 1 | `SidePane` 七个面板 | `React.lazy` |
| 2 | `WorkspaceSidebar: FileTree` | `React.lazy` + `Suspense`（由方向判据抓出） |
| 3 | `AppLayout: CommandCenter`（Ctrl+K 命令面板） | `React.lazy` + 条件渲染（由归因段定位） |
| 4 | `App.tsx: ToolExecutionPanel` / `ContextUsagePanel` | `React.lazy` + 条件渲染（由归因段定位） |
| 5 | `App.tsx: DiffSummary` / `ElicitationPanel` | `React.lazy` + 条件渲染（扫出全部条件渲染组件后逐个量） |
| 6 | `TitleBar.tsx: ProcessMonitorDialog` | `React.lazy` + 条件渲染（副作用有完整 cleanup；顺带停掉「关着时仍轮询」） |

每一刀的收益都被守卫的**视觉预算棘轮**锁住（`--update` 只会收紧不会放松），
且每次 `--update` 后 **文档↔契约对账判据**（`doc-contract-drift`）会检查文档是否跟上——
实测它在本轮立刻抓到了一次漂移。

### 6.10b 视觉侧为什么没有运行时足迹守卫（场景性质，不是遗漏）

逻辑侧的运行时足迹靠「跑真实命令 + 读 `require.cache`」采集，需要一个可独立执行的入口。
视觉侧**没有这样的入口**：

| 视觉端 | 为什么测不了 |
|---|---|
| 桌面端 / web 前端 / khyquant | 跑在 Electron 或浏览器里，Node 进程读不到它们的模块缓存 |
| TUI（Ink） | 由 `khy` 的交互模式启动，**需要真实 TTY**，在无 stdin 的 CI 里跑不起来 |

所以两侧的分工是清楚的：

- **逻辑侧**：静态（冷闭包 / 方向）+ 运行时（`require.cache` / 归因闸门），两套都有；
- **视觉侧**：只有静态那套（冷闭包 + 加载归因）。

若要给视觉侧补运行时足迹，需先解决「如何在无头环境里加载前端模块图」
（例如用 vite 的 build manifest 替代 `require.cache`）—— 那是独立的一项工作。
已记入契约 `visual.runtimeFootprintNote`，免得后人重复尝试。

### 6.11 TUI 侧：本轮只测不动（附理由）

TUI `app.js` 顶层只加载 3 个（`fs` / `react` / `inkRuntime`）。修正口径后它的**真实首屏
冷闭包只有 2 文件 / 773 行**（§6.6）—— 重量在 `ink-components/App.js` 的 50+ 顶层
require 里，但那些**不在首屏路径上**（`app.js` 走的是 `inkRuntime` 的动态 import）。

所以 TUI 的问题**不是首屏重，而是「上帝文件」**：`ink-components/App.js` 单文件 367 KB。
这与首屏重量是两回事，治理手段也不同（前者要拆分，不靠懒加载）。

贸然改 lazy 可能引入渲染时序问题，收益（进程内少 require 几个文件）远小于风险。
**故本轮只把事实测出来记入契约，不动代码。** 这是刻意的取舍，不是遗漏。

> 顺带一提：正因为修正了口径，「TUI 首屏 5 万行」这个我上一轮报的数字是错的。
> **测量工具骗人，第二次**（第一次是探针把自己算进测量，见 §7.7）。

---

## 七、体积轴：运行时足迹（静态闭包是估算，运行时才是事实）

> 到这里为止，「重」都是用**行数**量的——那是静态估算：「如果全加载会进多少行」。
> 但用户说的是「体积**还是**逻辑」两条轴。体积的事实侧是**运行时**：
> 进程实际加载了多少模块、多少字节、多大堆。

### 7.1 实测：三个场景，跨 42 倍

用 `node -r` 预挂探针，在进程退出时读 `require.cache`：

| 命令 | 第一方模块 | 行数 | 第一方字节 | 外部模块 | 外部字节 | heapUsed |
|---|---|---|---|---|---|---|
| `khy --version` | **11** | 7,805 | 0.48 MB | 1 | 0.01 MB | 6.4 MB |
| `khy doctor` | 67 | 38,983 | 1.61 MB | 13 | 0.06 MB | 16.5 MB |
| `khy ai -p "hi"`（lite） | **468** | 210,462 | 7.43 MB | **419** | **3.01 MB** | 47.5 MB |

**最小的那一档只有 11 个第一方模块 + 1 个外部模块**——这是「最小核心」真正成立的证据：
系统的最轻使用路径确实只拉 11 个自己的文件、连外部依赖都只有一个。

> **外部依赖也是体积的一半**：lite 路径实测拉了 **419 个外部模块 / 3.01 MB**。
> 只管第一方会漏掉「多 require 了一个重量级依赖」这类膨胀，故外部模块数与字节数
> 一并纳入预算（`runtime-footprint-external-files` / `-bytes`）。

### 7.2 静态与运行时差 80 倍，归因是「零盲区」

静态冷闭包说 `bin/khy.js` 只有 3 文件 2,602 行，运行时 lite 模式却是 468 文件 21 万行。
**差 80 倍。** 这会不会是静态分析有盲区？实测：**盲区 = 0 个模块**。

| 口径 | 文件数 |
|---|---|
| 静态冷闭包（仅顶层 require） | 3 |
| 静态全可达闭包（顶层 + 懒加载） | 2,178 |
| 运行时实际加载（lite） | 468 |
| **静态图未覆盖的运行时模块** | **0** |

运行时加载的 468 个模块**全部**落在静态全可达闭包内。所以差距的成因不是「漏边」，
而是**懒加载边在运行期被求值**——运行时加载的是「这条命令走到的那些边」的并集。

> 这给出一个重要的操作判据：**重量 = 冷闭包 + 被触发路径上的懒加载边**。
> 只压冷闭包不够，还要让「轻量路径」不去触发重路径的懒加载边。

### 7.3 lite 模式的 21 万行落在哪

| 目录 | 行数 |
|---|---|
| `src/services` | **165,940** |
| `src/cli` | 16,232 |
| `src/utils` | 10,356 |
| `src/constants` | 6,252 |
| `src/tools` | 3,861 |

`services` 占 79%——与静态分析给出的结论一致（核心循环闭包里 services 占 87%）。
**两条独立的度量方法互相印证**，这是结论可信的关键。

### 7.4 守卫

`scripts/ci/check-runtime-footprint.js`（`npm run check:runtime-footprint`）：

- 跑**真实命令**（`--version` / `doctor` / `ai -p "hi"`），不是模拟；
- 用 `scripts/lib/runtimeFootprint.js`（纯叶子）预挂探针，读真实 `require.cache`；
- 与契约 `runtimeFootprint.scenarios[].budget` 比对，**只许减不许增**；
- **五条判据**：第一方模块数 / 行数 / 字节 + 外部模块数 / 外部字节。

**探针的三条自律**（探针本身不能污染被测对象）：

1. exit 钩子里**绝不抛**——探针不能改变被测命令的成败；
2. 默认**不写 stderr**——否则用户可见输出被 JSON 污染（首版就这么写过，已改）；
3. 幂等——重复 require 不重复装钩子。

**已验证探针对被测命令零影响**：`node bin/khy.js --version` 与
`node -r <probe> bin/khy.js --version` 的输出逐字节一致。

**反向验证**：把 `ai-lite` 的模块数预算从 468 改成 100，守卫从 EXIT=0 变 EXIT=1
并精确点名「运行时加载 468 个第一方模块 > 预算 100」。

### 7.5 加载归因：谁把重量拽进来的

静态图答不了「哪条懒加载边被触发了」——它不知道运行时走了哪条路。
答案只能从运行时拿：拦截 `Module._load`，记录「加载者 → 被加载者」。

**lite 路径的实测结果**（427 个第一方模块 / 188,413 行）：

| 加载者 | 直接加载 | 可达模块 | 可达行数 |
|---|---|---|---|
| `bin/khy.js`（入口） | 17 | 444 | 185,954 |
| **`src/cli/ai.js`** | **26** | **417** | **179,335** |
| `src/cli/aiRequestAnalysis.js` | 6 | 286 | 128,274 |
| `src/services/gateway/aiGateway.js` | 51 | 270 | 117,429 |
| `src/cli/aiChatCore.js` | 46 | 159 | 62,425 |

**闸门不取入口**：`bin/khy.js` 是所有路径的根，天然可达全部模块，
但它是「按需加载的调度者」而非「重量来源」——拿它当闸门等于把「入口存在」当违规，
无法指导任何瘦身动作。闸门取**非入口加载者**中拽进最多的那个：
lite 路径是 `src/cli/ai.js`（重量编排层），与支配树分析互相印证。

### 7.6 lite 路径的重量到底落在哪（不重叠的权威分布）

按实际加载的第一方模块统计（不去重、不重叠）：

| 位置 | 模块数 | 占比 |
|---|---|---|
| `services/其他` | 136 | 31.9% |
| `services/gateway` | 122 | 28.6% |
| `utils` | 49 | 11.5% |
| `services/domain` | 49 | 11.5% |
| 其他（vendor / bin / root） | 43 | 10.1% |
| `cli` | 22 | **5.2%** |
| `tools` | 6 | 1.4% |

**`services` 占 72%，`cli` 只占 5.2%。** 这修正了一个容易犯的直觉错误：
「lite 路径重」**不在 CLI 编排层**（CLI 只是入口，22 个模块），
**在服务层**——具体是 `gateway/adapters` 的 52 个模块 / 31,868 行（占 lite 的 12.2% / 16.9%）。

### 7.7 这条守卫自己踩的坑（都是真 bug，不是配置问题）

**① 探针的路径没规范化 —— 第一方计数恒为 0。**
Windows 上 `D:/x` 与 `D:\x` 是不同的字符串，`startsWith` 恒假；
于是第一方计数全跑到外部去了（`files=0, ext=887`）。
**症状极隐蔽**：守卫「绿」着，但测的根本不是第一方。
修法：`path.resolve` 归一化 + 大小写不敏感比较。
（**同一个坑在本次工作中出现 4 次**——路径比较必须收敛到一个比较器。）

**② 探针只定义不安装 —— 场景全部「不可测」。**
`installExitHook` 写好了却没在模块末尾调用。以 `--require` 预挂的语义是
「require 完就执行」，钩子必须自安装。**症状**：守卫报
「场景未产出足迹快照」但**不判错**——一个永远不拦人的守卫。

**③ `--update` 漏字段 —— 基线永远对不上。**
更新了 files/lines/bytes，漏了 externalFiles/externalBytes，
也漏了契约里给人读的 `measured` 段。结果：跑 `--update` 之后守卫**仍然报红**。
**症状**：看起来像场景有非确定性，其实是更新机制不完整。

**③b 同型第二处：`check-core-layers.js --update` 只更新逻辑侧，漏了视觉侧。**
视觉预算挂在 `contract.visual.layers[].budget.perRoot` 下，而 update 循环只遍历
逻辑侧的 `LAYER_BY_ID` —— 于是 V0 预算永远改不动，跑完 `--update` 守卫仍然报红。
**同一条命令、同一种症状、同一个根因**：更新机制与判定机制不同步。

**④ 探针把自己算进测量 —— 数字随探针自身体积漂移。**
探针以 `--require` 预挂，必然在 `require.cache` 里，于是被算进「外部依赖」。
而探针文件体积随功能增长（归因逻辑加进来后 5.8 KB → 11.6 KB）——
**被测对象一点没变，外部字节数却从 5,859 变成 11,645。**
这是「探针污染自己的测量」：外部字节预算会跟着探针改代码而漂移。
修法：排除自身文件。

**⑤ 异常被空 catch 吞掉 —— 快照静默降级。**
`attributionReport` 里一个变量名笔误（`reachLines` 写成 `reachableLines`）
让归因报告抛错，而 exit 钩子的空 catch 把它吞了：
**快照照样写文件、照样 exit 0，只是缺了 attribution 字段**。
守卫读到残缺快照却无从知道。修法：出错时留 `.err` 痕迹，守卫据此判「本轮不可测」——
**宁可不可测，也不能把「探针崩了」误当成「重量下降」而白送一次棘轮放松。**

> 五条都指向同一个教训：**「守卫是绿的」不等于「守卫在测东西」。**
> 本文的做法是：① `--version` 场景逐字节比对确认探针零污染；
> ② 反向注入确认判据会红；③ 连跑三次确认基线稳定、不随机红；
> ④ **两法独立复核**（正式探针 vs 纯计数探针，不归因、不读盘、路径口径一致）。

### 7.8 硬预算只给稳定量

实测：**同一时刻内 4 次跑完全一致（波动 0）**，但**跨会话会漂**
（不同的 AI 回复走到不同的模块集合，行数差几十行）。

| 指标 | 稳定性 | 预算策略 |
|---|---|---|
| 第一方**文件数** | 稳定（波动 0） | **硬预算，零容差** |
| 第一方行数 | 跨会话漂几十行 | 容差 1% |
| 第一方字节数 | 跨会话漂 | 容差 5% |
| 外部模块数 | 稳定 | 硬预算 |
| 归因闸门**可达文件数** | 稳定 | 硬预算 |

否则守卫会因模型返回内容不同而随机红——**那等于没有守卫**。

### 7.9 场景本身可能不确定 —— 那是场景的性质，不是代码的

`doctor` 场景曾观测到一次异常：外部依赖从 12 个跳到 **107 个 / 605 KB（超基线 884%）**，
第一方也从 67 涨到 74。连测 6 次又全部一致（67 / 38,983 / 12 / 56,088）——
说明那次**不是随机抖动**。

根因在 `src/cli/handlers/initDoctorProbes.js`：它有**工具链探测缓存**
（`_toolchainProbeCache` + 磁盘缓存 `doctor-toolchain.json`）与**异步探测**。
探测到某个 CLI 存在就 `require` 对应模块（如 `services/apiKeyPool`），
把外部依赖一并拉进来 —— **缓存冷热与探测完成时机决定加载集合**。

**解法不是放宽预算，而是让场景变确定**。`doctor` 自带两个开关：

| 模式 | 实测（各 3–5 次，波动 0） | 说明 |
|---|---|---|
| `--quick` | **62 文件 / 35,648 行** | 跳过工具链探测组（不 spawn），**完全确定** |
| 默认（缓存热） | 67 文件 / 38,983 行 | 读缓存 |
| `--no-cache` | 68 文件 / 39,041 行 | 现场重新探测全部 CLI |
| 缓存冷（曾观测一次） | 74 文件 / 39,890 行 / 外部 107 | 现场探测 + 探测途中命中更多 CLI |

**场景改用 `doctor --quick`**：既确定（5 次读数完全一致）又更快（不 spawn）。
外部依赖仍留宽松上限（130 个 / 900 KB）作兜底，**不参与棘轮**。

> **通用原则**：守卫的预算强度必须匹配场景的确定性。
> 拿确定场景（`--version`）的稳定性去要求不确定场景（`doctor`），
> 得到的不是一个更严的门禁，而是一个会随机红、于是被人加白名单绕过的门禁——
> **那比没有门禁更糟**。
>
> **更好的解法是让场景变确定**，而不是把预算放宽到失去意义：
> `doctor` 本来就有 `--quick`，用它测「诊断路径本身有多重」，
> 比测「本机装了几个 CLI」更贴近我们要守的东西。

### 7.6 与静态守卫的关系

| | `check-core-layers.js` | `check-runtime-footprint.js` |
|---|---|---|
| 测什么 | 静态冷闭包（按加载时机） | 运行时 `require.cache` |
| 回答 | 「启动瞬间有多重」 | 「一条真实路径总共多重」 |
| 覆盖 | 逻辑侧 + 视觉侧 | 逻辑侧（后端进程） |
| 性质 | 估算 | **事实** |

**两者都不是对方的替代**：静态侧覆盖面广（能扫全仓每一个入口），运行时侧准确但只能测已列场景。

---

## 八、契约与守卫

### 8.1 机器可读真源

`docs/10_规范/registry/CORE-LAYERS.json` —— 层定义、加载时机口径、重量预算、
边缘方向矩阵、已知倒挂清单、视觉层分层与预算、**运行时足迹场景与预算**、守卫覆盖盲区，
全部机器可读。

### 8.2 守卫

**守卫一（静态）**：`scripts/ci/check-core-layers.js`（`npm run check:core-layers`），
**六条判据，逻辑与视觉各三条半**：

| 判据 | 轴 | 内容 |
|---|---|---|
| `core-purity` | 逻辑 | L0 不得依赖 L1/L2；L1 不得依赖 L2（按**可达闭包**判层归属，不按目录硬猜） |
| `core-budget-files` / `core-budget-lines` | 逻辑 | L0/L1 冷闭包不得超基线（只许减不许增） |
| `core-entry-toplevel-requires` / `core-entry-toplevel-lines` | 逻辑 | **CLI 入口的顶层 require** 数量与行数 —— 顶层 require 的重量由**所有命令**承担（§8.5） |
| `skin-into-core` | 逻辑×视觉 | L1 入口的可达闭包不得渗入视觉皮文件 |
| `facade-cross-layer` | 逻辑 | 逻辑侧不得经皮侧 re-export 门面引用通用能力（门面是兼容，不是绕路许可） |
| `visual-budget-files` / `visual-budget-lines` | 视觉 | V0 视觉芯的首屏冷闭包不得超基线 |
| `skin-into-visual-core` | 视觉 | 「应懒加载的低频页面」不得出现在 V0/V1 的首屏冷闭包里 |
| `visual-layer-direction` | 视觉 | **消费 `visual.edgePolicy`**：芯(V0) 不得依赖膜(V1) 与皮(V2)，膜(V1) 不得依赖皮(V2) |
| `visual-classifier-degraded` | 视觉 | 视觉侧加载边分类必须用 AST；回退到括号深度口径须**显式报出**（数字不可信） |
| `inversion-*` | 逻辑 | 已知倒挂边只许减不许增；已消失则提示可从基线移除 |
| `doc-contract-drift` | 文档 | **设计文档里引用的基线数字必须与契约一致**（warning 级，漂移要报但不阻断 PR） |
| `visual-lazy-regression` | 视觉 | **safe 名单里的组件必须仍是懒加载**（防回退，给**事前**信号；重量棘轮是**事后**抓到） |
| 候选扫描 | 视觉 | 懒加载候选（条件渲染 × 传递重量 × 副作用 × cleanup × 首屏主体 × 入边广度）—— **指引档**，输出「可切 / 需人判 / 共用基础设施 / 首屏主体」四类 |

> **`doc-contract-drift` 是补上的**：本轮实测到两处漂移 —— 契约被 `--update` 更新后
> （91,540 → 91,608、50,860 → 50,928），文档里还写着旧值。
> **人不会记得同步，而守卫会。** 这正是本契约一路在消灭的那类漂移本身，
> 出现在契约与文档之间。

> **`visual-layer-direction` 是补上的**：契约里定义了 `visual.edgePolicy`，
> 但守卫此前只读逻辑侧的 `contract.edgePolicy` —— **一份没人执行的契约等于没有约束**。
> 补上后立刻抓出 `WorkspaceSidebar(V0) → FileTree(V1)` 这条真违例，
> 并促成视觉侧第二刀（§6.5）。
>
> 判定按「归属 + 逐条边」，不按闭包：闭包互相重叠会把 1 条真违例放大成 25 条误报。

**守卫二（运行时）**：`scripts/ci/check-runtime-footprint.js`（`npm run check:runtime-footprint`），
五条判据：`runtime-footprint-files` / `-lines` / `-bytes` / `-external-files` / `-external-bytes`，
跑真实命令读真实 `require.cache`；外加 `runtime-attribution-gate-*`（归因闸门）
与 `runtime-weight-layer-*`（顶层边 / 懒加载边分摊预算，§8.6），详见 §七。

**视觉侧的分析器独立成纯叶子** `scripts/lib/visualLayerGraph.js` ——
因为视觉侧有三种栈（React ESM / Vue SFC / Ink CJS），统一口径靠「静态边 vs 动态边」，
这部分能力与逻辑侧的 CJS 分析不共用，故不塞进守卫主文件。

**运行时探针独立成纯叶子** `scripts/lib/runtimeFootprint.js` ——
探针必须能「预挂到别人的进程上」，故它的自律（不抛、不写 stderr、幂等）写成契约的一部分，
而不是靠调用方自觉。

**分类器独立成纯叶子** `scripts/lib/requireGraph.js`（2026-10-31 新增）——
「顶层 vs 懒加载」的判定是**所有**重量数字的地基，不能藏在守卫主文件里；
它由 `scripts/tests/requireGraph.test.js`（**15 条用例，已接进 `pr-gate.yml`**）逐条钉死：
顶层 `try{}` / `if{}` 里的 require 算顶层、函数体内算懒加载、
**字符串/正则/模板里的花括号不得改变后续 require 的分类**（旧口径的致命缺陷）、
动态 require 只计数不进边集。

**守卫的反向验证**（防假绿，五处都做过）：

1. 把 `cli/steps.js` 的一处引用改回经皮侧门面的路径 → EXIT=0 变 EXIT=1，精确点名；
2. 把 `SidePane.tsx` 的 `BrowserPane` 从 lazy 改回静态 import → EXIT=0 变 EXIT=1，
   精确点名 `skin-into-visual-core` 与 `BrowserPane.tsx`；
3. 把 `ai-lite` 的运行时模块数预算从 468 改成 100 → EXIT=0 变 EXIT=1，
   精确点名「运行时加载 468 个第一方模块 > 预算 100」；
4. **给 `bin/khy.js` 加一个顶层 require** → EXIT=0 变 EXIT=1，精确点名
   `core-entry-toplevel-requires` 与 `core-entry-toplevel-lines`
   （实测 7 个 / 预算 6，1,059 行 / 预算 999 行）；
5. **把 `ai-lite` 的顶层边可达预算压到 1** → EXIT=0 变 EXIT=1，精确点名
   `runtime-weight-layer-top-files`。

5 次注入全部在 `try/finally` 里恢复，恢复后两侧守卫 EXIT=0。
**注入必须有「精确点名」才算数** —— 只看 EXIT=1 无法区分是「目标判据生效」
还是「别的东西碰巧也红了」。

首版曾漏查懒加载边（`require` 在函数体内），修正后补上顶层边与懒加载边双查。

用法：

```bash
node scripts/ci/check-core-layers.js              # 检查，error 退出 1
node scripts/ci/check-core-layers.js --report     # 现状盘点，不判错
node scripts/ci/check-core-layers.js --json       # 机器可读
node scripts/ci/check-core-layers.js --update     # 重写基线（须显式）

node scripts/ci/check-runtime-footprint.js              # 运行时重量，error 退出 1
node scripts/ci/check-runtime-footprint.js --report     # 只报告
node scripts/ci/check-runtime-footprint.js --json       # 机器可读
node scripts/ci/check-runtime-footprint.js --update     # 重写基线（须显式）
```

### 8.3 基线数字（2026-10-31）

**逻辑侧（静态冷闭包，AST 口径）：**

| 层 | 入口 | 冷闭包文件 | 冷闭包行数 | 口径修正前 |
|---|---|---|---|---|
| L0 | `bin/khy.js` | **9** | **3,757** | 3 / 2,602（旧口径**低估**） |
| L1 | `services/tool/toolUseLoopCore.js` | **71** | **30,175** | 170 / 91,608（旧口径**虚高 2.4×**） |
| L1 | `services/gateway/aiGateway.js` | **122** | **71,078** | 100 / 50,928（旧口径**低估**） |
| L1 | `cli/repl/startup.js` | 1 | 385 | 1 / 385（无变化） |

> 口径修正见 §1.5。**「修正前」一列不是历史记录，是错误记录** ——
> 留着它是为了让人能核对「改的到底是数字还是口径」。

**入口顶层 require（所有命令都付的那一份，§8.5）：**

| 项 | 值 |
|---|---|
| 直接顶层 require（第一方） | **6 个 / 999 行** |
| 顶层 require 闭包（含入口自身） | 9 文件 / 3,757 行 |
| 其中依赖部分（不含入口自身） | 8 文件 / 1,298 行 |

**视觉侧（首屏静态冷闭包，2026-10-30 口径修正后）：**

| 层 | 入口 | 首屏冷闭包文件 | 首屏冷闭包行数 |
|---|---|---|---|
| V0 | `desktop/renderer/App.tsx` | 37 | 9,415 |
| V0 | `desktop/components/layout/AppLayout.tsx` | 18 | 4,535 |
| V0 | `desktop/components/composer/Composer.tsx` | 11 | 2,382 |
| V0 | `tui/ink-components/PromptFrame.js` | 4 | 1,404 |
| V0 | `tui/ink-components/Transcript.js` | **17** | **4,178** |
| V0 | `tui/ink-components/ToolLines.js` | 10 | 2,681 |
| V0 | `tui/app.js`（TUI 入口） | **2** | **773** |
| V0 | `web/ai-frontend/views/Layout.vue` | 1 | 9 |
| V0 | `web/ai-frontend/views/UserHome.vue` | 1 | 944 |
| V0 | `web/khyquant/App.vue` | 1 | 211 |
| V0 | `web/khyquant/views/Dashboard.vue` | 1 | 2,241 |

> **口径修正**：此前视觉侧的边表把函数体内的懒加载 `require` 也算作静态边，
> 于是 `tui/app.js` 被量成「172 文件 / 5 万行」。修正后（与逻辑侧同口径）真实值是
> **2 文件 / 773 行**。TUI 的首屏一直很轻，此前是测量工具骗人 —— 见 §6.6。
>
> **2026-10-31 再次修正**（视觉侧也换成 AST）：11 个根里**只有 1 个变化** ——
> `tui/ink-components/Transcript.js` 由 15 文件 / 4,019 行变为 **17 文件 / 4,178 行**。
> 原因：`ProcessGroup.js` 里两个 **顶层 `try{}`** 中的 `require` 被旧口径误判成懒加载
> ⇒ 旧数字是**低估**。其余 10 个根分毫未动 —— 说明桌面端与 web 前端（ESM）
> 本来就没踩到这个坑（ESM import 是**提升**的，无论写在哪都是装载期）。
>
> 顺带修掉一类**假边**：旧正则会匹配**注释里**的 require 文本。实测
> `tui/ink-components/caretGeometry.js` 的注释明写「本叶子**绝不** `require('./PromptFrame')`」，
> 而工具把这句话当成了一条真实静态边 —— **测量工具读到了架构注释，并把它当成了代码**。

**运行时侧（真实 `require.cache`，2026-10-31 口径修正后）：**

| 场景 | 第一方模块 | 第一方行数 | 外部模块 | heapUsed | 顶层边可达 | 懒加载边可达 | 归因闸门（非入口） |
|---|---|---|---|---|---|---|---|
| `khy --version` | **11** | 7,805 | 0 | 6.5 MB | 13 文件 / 5,340 行 | 2 文件 / 6 行 | `startupPhases.js`（3 个） |
| `khy doctor --quick` | 62 | 35,648 | 12 | 14.5 MB | 47 文件 / 20,879 行 | 25 文件 / 16,547 行 | `cli/router.js`（43 个） |
| `khy ai -p "hi"` | **425** | 188,294 | 422 | 44.6 MB | 332 文件 / 144,067 行 | 145 文件 / 58,490 行 | `cli/ai.js`（415 个 / 17.9 万行） |

> 旧值（468 / 210,462 / 419）作废 —— 那是「探针把自己算进外部依赖 + 归因钩子干扰加载」
> 两个探针自身缺陷造成的假读数。修正后由两法独立复核（正式探针 vs 纯计数探针）。
>
> `doctor` 用 `--quick`：默认模式随工具链探测的缓存冷热漂移（62 / 67 / 68 / 74 四种取值），
> `--quick` 跳过探测、5 次读数完全一致，且不 spawn —— 见 §7.9。
>
> **顶层边 / 懒加载边两列在 2026-10-31 换了口径**（见 §1.5）：旧的括号深度口径
> 把「长文件后半段的懒加载」误判成顶层边，故顶层 286 → 332 文件、懒加载 198 → 145 文件。
> **总和不变、归属变了** —— 这正是口径修正该有的样子：改的是分法，不是总量。

### 8.4 CI 接线

| 守卫 | CI 位置 | 档位 |
|---|---|---|
| `check-core-layers.js` | `pr-gate.yml` → `contract-checks` job | **阻断** |
| `check-runtime-footprint.js --report` | 同 job | 报告（需网络与凭据） |

静态面可离线跑，进阻断档；运行时面要跑真实请求（CI 无凭据时 `ai -p "hi"` 退 2、
耗时 9.4s，在 180s 超时内但读数会因模型回复不同而漂），故走报告档——
**阻断档由静态守卫承担，运行时面的价值是「让重量趋势可见」**。

> **接线盲区备忘**：`scripts/ci/check-wiring.js` 的「反孤儿守卫」只要在
> `package.json` 里有别名就算「已接线」——**别名 ≠ CI 会跑**。
> 新守卫必须显式加进 `pr-gate.yml`，否则它在本仓库等于没写。
> （本守卫自报「120 个检查器全部接线」时，两个新守卫确实已在 pr-gate 里。）

### 8.5 入口顶层 require 预算：「所有命令都付」的那一份

冷闭包预算答的是「整个闭包有多重」—— 涨了只说明「变重了」。
这条判据答的是另一件事：**谁把它挂到顶层的**。

入口 `bin/khy.js` 的**顶层 require**（= 不在任何函数体内的 require，AST 口径）
在**每个命令**启动时就求值：`khy --version` 也付这一份。
这类重量有一个别的重量没有的性质 —— **它不会因为「那条路径用不到」而消失**。

实测（2026-10-31）：

| spec | 行数 |
|---|---|
| `../src/bootstrap/windowsSpawnHardening` | 178 |
| `../src/bootstrap/moduleSelfHeal` | 309 |
| `../src/bootstrap/startupProfiler` | 83 |
| `../src/services/domain/state/stateMachine/startupPhases.js` | 107 |
| `../src/services/domain/state/stateMachine/debugLog.js` | 77 |
| `../package.json` | 245 |
| **合计** | **999 行 / 6 个** |

（node 内置 `path` / `fs` / `os` / `module` / `child_process` 不计重量。）

**判据**：`core-entry-toplevel-requires`（数量）、`core-entry-toplevel-lines`（行数），
契约在 `CORE-LAYERS.json` 的 `entryBudget`，只许减不许增。

**为什么把 `package.json` 算进去**：旧口径的 `resolveRel` 不认 `.json`，
于是这份「所有命令都要解析」的文件整个没被计数。入口重量被低估了 245 行 ——
**漏算不会让数字变小到没人注意，但会让预算虚低**。

**可减的方向（材料，非承诺）**：上表 6 个里有 4 个是「尽力而为」的引导
（spawn 硬化、模块自愈、启动阶段 FSM、启动调试日志）—— 它们被写在**顶层**
（`try {}` 里），意味着**每条命令**都要加载它们，哪怕那条命令与它们毫无关系。
把它们挪进懒加载边，是「减所有命令都付的重量」最直接的一刀。
但它们各自带副作用（改 `process.emitWarning`、装 `MODULE_NOT_FOUND` 拦截、挂 `process` 事件），
**副作用时机会变** ⇒ 属 B7「对外可见的判断」，须人拍板。

### 8.6 重量分摊预算：顶层边 vs 懒加载边

「重量 = 冷闭包 + 被触发路径的懒加载边」—— 两项分开计量，才知道**该动哪一头**：

- **顶层边可达** = 在模块**装载期**求值的部分。动它 ⇒ 走这条路的命令都受益。
- **懒加载边可达** = 只在**被触发的代码路径**上求值的部分。动它 ⇒ 只对那条路径受益。

实测（2026-10-31，运行时真相口径，见 §1.5）：

| 场景 | 顶层边可达 | 懒加载边可达 |
|---|---|---|
| `khy --version` | 13 文件 / 5,340 行 | 2 文件 / 6 行 |
| `khy doctor --quick` | 47 文件 / 20,879 行 | 25 文件 / 16,547 行 |
| `khy ai -p "hi"` | 332 文件 / 144,067 行 | 145 文件 / 58,490 行 |

**判据**：`runtime-weight-layer-top-files` / `-top-lines` / `-lazy-files` / `-lazy-lines`，
契约在 `runtimeFootprint.weightLayers.budget`。

> **这段此前是死契约**：数字写进了 `CORE-LAYERS.json`，但**没人读它**——
> 与 `visual.edgePolicy` 一模一样的缺陷（定义了却无人消费 ⇒ 等于没有约束）。
> 现在它进守卫输出、参与判预算、随 `--update` 一起重写。

**读法**：lite 路径上**顶层边可达 14.4 万行、懒加载边可达 5.8 万行**。
也就是说，那条「轻量」路径上的重量，**大头是模块装载期自己拉进来的**，
不是「用户触发了什么才加载什么」。

> **这条数字曾经被我用来给 P4 背书，那次背书是错的**（见 §9.1 的自我纠错）：
> 「顶层边可达 14.4 万行」不等于「适配器白加载了 7 万行」——
> 实测那 18 个适配器**全部会被探活**（`detectAsync`），模块与其传递依赖照样进内存。
> **顶层/懒加载的分摊告诉你「重量在哪一头」，不告诉你「那一头值不值得动」。**
> 后者要另测（§9.1 用探针测了，结论是 P4 的收益归零）。

---

## 九、下一刀在哪（按实测收益排序，非承诺）

| 优先级 | 轴 | 目标 | 收益 | 需要的决策 |
|---|---|---|---|---|
| **P1** | 逻辑 | 剪 `src/cli/handlers/` 整层（8 条入边） | 核心 **−8.5 万行 / −214 文件** | 需要把 `ai.chat` / 网关管理从 CLI 层抽出到服务层 —— 是接口重构，属人的决定 |
| **P2** | 逻辑 | `AgentTool → cli/ai.js` 依赖倒置 | **单点无效（实测）**：只剪这一条边，核心可达闭包**一行不少**；必须剪掉**全部 30 条** →`cli/ai.js` 的边才有 **−321 文件 / −12.6 万行** | 真刀口不是「谁注入 chat」，而是「chat 路径上哪些大依赖能按需加载」——见 §9.2 |
| **P3** | 逻辑 | `toolUseLoopCore.js` 12,100 行拆分 | 已有 `services/tool/loop/` 棘轮在推进 | 续既有路线即可 |
| **P4** | **体积** | ~~网关适配器改按需加载~~ | **收益实测归零**（2026-10-31 自我纠错）：18 个适配器**全部会被探活**（`detectAsync`），按需加载省不到模块；真正的代价在**探活**（读盘/起进程），不在模块加载 | 若还要动这一刀，该动的是「**别探没配置的适配器**」⇒ 改变探活行为 ⇒ 属对外可见的判断 |
| **P5** | 视觉 | 桌面端首屏继续瘦身 | 现 **37 文件 / 9,415 行** | 归因段的 top1 是 `AppLayout.tsx`（4,641 行）与 `WorkspaceSidebar.tsx`（2,830 行）—— **但两者都不能懒加载**（侧栏与标题栏常驻）。真正的下一刀要靠人工判读「哪些是按需才用」，机械依据已备好 |
| **P6** | 视觉 | TUI `ink-components/App.js` 367 KB 拆分 | **TUI 首屏只有 773 行**（§6.6 修正后）—— 拆分收益比原估小得多 | 是「上帝文件」问题（视觉侧的），与首屏重量是两回事 |
| ~~P7~~ | 视觉 | ~~khyquant 前端补懒加载契约测试~~ | **2026-10-30 已补**：`src/__tests__/routerLazyLoad.contract.test.js`，断言 27 条路由全懒加载、无静态 component 逃逸、动态 import 指向的文件真实存在、顶层不静态引入 view | 已完成 |

**P1/P2/P4 都需要产品/架构决策**，本文只提供实测依据与可机判的约束，不代拍板。

### 9.1 P4：收益前提被实测推翻（自我纠错 ×2）

> **⚠ 本节的收益数字被修正过两次。**
> 第一次（2026-10-30）：原写「52 文件 / 31,868 行」→ 改成「159 文件 / 71,525 行」。
> **第二次（2026-10-31）：那个 159 也作废 —— 收益实测归零。**

**病灶**：`aiGateway.js` 在模块顶层静态 require 了 **18 个适配器**（自身 21,246 行），
它们组成自动回退链 `this._adapters = [{key, adapter, priority, enabled}, ...]`。

**实测（2026-10-31，拦截适配器模块的加载 + 其导出函数调用，跑 lite 路径）**：

| | 数量 | 说明 |
|---|---|---|
| 适配器目录文件总数 | 68 | 含 18 个渠道适配器 + 50 个 helper |
| **被碰过的渠道适配器** | **18 / 18（全部）** | 每个都被调过 `detect` / `detectAsync` / `getStatus` / `listModels` / `getRuntimeDiagnostics` |
| 完全没碰的文件 | 15 | **全是 helper**（`acpAgentProbe` / `anthropicRelayPresets` / `portableCliInstaller` / `_endpointResolver` 等），**没有一个是渠道适配器** |

**⇒ 按需加载（thunk 化）那 10 个适配器，在 AI 路径上省不到模块**：
它们本来就会被探活，模块与其传递依赖照样进内存。
**上一轮记的「上限 159 文件 / 71,525 行」作废。**

**上一轮为什么算错**：我只统计了 `detect` 调用。
而网关除了 `detect`，还会对**每个**适配器调 **`getStatus()` 与 `detectAsync()`** ——
异步探活，正是回退链挨个试的那一步。
**「没被 `detect` 过」不等于「没被用过」。** 这是探针口径不完整，不是代码问题。

**真正的代价在探活，不在加载**：被调到的 helper 里
`ideDetector.findInstallation`、`traeOfficialArtifacts.resolve*`（多处）、
`portableAdapterSpawn.forTool` 都在**读磁盘 / 起进程**；
网关给 `detect` 套 60s TTL 缓存这件事本身，也说明探活很贵。
⇒ 若还要动这一刀，该动的是「**别探没配置的适配器**」（按配置/env 门控后再探），
而不是「别加载没用的适配器」。**但那会改变探活行为**（哪些适配器被探、什么顺序）⇒ 对外可见 ⇒ 须人拍板。

**先例为什么搬不过来**：`src/adapters/im/adapterRegistry.js` 的零加载契约成立，
是因为 IM 渠道**按 env 显式启用**（opt-in，未启用者从不被 require）。
网关的 18 个渠道是**无条件全探** ⇒ 同一个 thunk 模式搬过来，收益为 0。

**硬约束（仍然成立）**：构造函数对每个 `entry.adapter.detect` 做包装
（`_detectCache` + 60s TTL）⇒ 每个适配器模块必须在构造时已加载；
`tests/gateway.detectAsyncNonBlocking.test.js` 钉死了「每个 CLI 适配器必须暴露 `detectAsync`」。

**回归覆盖**：`tests/gatewayAdapters.stability.test.js` 等 26 个适配器/网关套件。
**任何改动后必须复测同一集合**：18 个适配器的**选择结果**不能变，
且被探活的适配器集合不能变（除非正是本次要改的那一项）。

> #### 两次自我纠错的共同教训
>
> 第一次错在**算法**：用「静态闭包」回答「实际用了多少」。
> 第二次错在**探针**：只数了一种调用（`detect`），就宣称「从未被用过」。
>
> **两次都不是「算错了数」，而是「问错了问题」/「测漏了入口」。**
> 而两次都是靠**再测一次**抓到的，不是靠推理。
> 这也是本文反复要求「反向验证」与「两法独立复核」的原因 ——
> **一个只数了一件事的探针，会给出看起来很确凿的错误结论。**
>
> 已把全部实测数据（18 个被碰名单、15 个没碰的 helper 名单、测量方法、收益归零的结论）
> 写进契约 `runtimeFootprint.adapterLoading.lazyLoadDecision.selfCorrection`，免得下一个人重新估错。

### 9.2 P2 的注入点方案（反事实推演给出的结论：问题问错了）

**原本的问题**：「给 AgentTool 注入一个 chat 端口，注入点选哪个？」
**推演后的结论**：**这个问题问错了 —— 单点改无效。**

**反事实推演**（用 AST 口径的边表，把边删掉再算闭包 —— 2026-10-31 实测）：

| 场景 | 核心循环可达闭包 | 变化 |
|---|---|---|
| ① 现状 | 1,425 文件 / 504,169 行 | — |
| ② 只剪 `AgentTool → cli/ai` | 1,425 / 504,169 | **0 文件 / 0 行** |
| ③ 剪掉全部 `tools/` + `services/` → `cli/ai`（7 条） | 1,425 / 504,169 | **0 文件 / 0 行** |
| ④ 剪掉**全部 30 条** → `cli/ai.js` 的边 | 1,104 / 377,708 | **−321 文件 / −126,461 行** |

**⇒ 「剪单条边无效」这条老结论（§4.1）在这里再次被证实，而且更强**：
连剪 7 条都一行不省 —— 因为 `cli/ai.js` 处在别的边也能到达的位置上。

**30 条边里哪些是越层的**：18 条在 `src/cli/**` 内部（CLI 依赖 CLI，合法），
真正越层的只有 **11 条**（`bin/khy.js` 1、`assistant/` 1、`coordinator/` 2、`jobs/` 1、`services/` 3、`tools/` 4）。

**那 321 个文件是什么**（只经 `cli/ai` 才进核心闭包）：

| 归属 | 文件 / 行数 | 说明 |
|---|---|---|
| `src/services/domain` | 78 / 17,891 | 会话、消息、记忆等领域模块 |
| `src/services/gateway` | 23 / 10,899 | 网关与其周边 |
| `src/cli/handlers` | 10 / **13,588** | 单文件很大（`aiConversationOps` 1,257、`hudRenderer` 1,066、`toolDisplayPolicy` 1,004 等） |
| `src/utils/terminal` | 7 / 2,083 | 终端能力 |
| 其余约 200 个 | 各 1 文件 | `localBrainService` 2,991、`modelTrainingService` 3,035、`embeddingClient` 498、`memoryEngine` 等 |

**⇒ 真正的刀口不是「谁注入 chat」，而是「chat 路径上哪些大依赖可以按需加载」**：
`cli/ai.js` 是个**编排层**，它把整个 AI 生态（localBrain / modelTraining / embedding / memory）
无条件拽进来。把 `cli/ai.js` 搬到 services 层**并不能**让这些依赖离开核心闭包 ——
它们会跟着搬过去。**要减重量，得让这些依赖在「不需要时」不被加载**，
这与 P1/P4 同型（都是「按需加载」而非「换个层」）。

**这解释了为什么 §一 的结论是「下沉优于剪边」而不是「剪边就够」**：
下沉解决的是**方向**（谁可以依赖谁），按需加载解决的是**重量**（什么时候付）。
**两件事都得做，且不是同一件事。**

**因此 P2 的方案不是「选一个注入点」，而是三步**（顺序即风险递增）：

1. **先摘 chat 路径上的大依赖**（`localBrainService` / `modelTrainingService` / `embeddingClient` …）
   —— 把它们从「顶层静态 require」改成「用到时才加载」。这一步**不需要改任何接口**，
   收益直接落在 chat 路径的冷闭包上，且可逐个独立验证；
2. **再把 11 条越层边改成注入或下沉** —— 这一步才动接口，须保证 18 个适配器选择结果不变；
3. **CLI 内部的 18 条边不动**（CLI 依赖 CLI，合法）——
   它们是 `cli/ai.js` 的合法入边，不是倒挂。

> **次序为什么重要**：第 1 步不碰接口、可独立验证、失败面小；
> 第 2 步动的是 11 个调用点 + 网关/工具的核心链路。
> **先做收益大、风险小的那一步**，是剥洋葱的通用次序。

---

## 十、复现

```bash
# 静态重量基线（冷闭包 / 可达闭包 / 支配树 / 扇入 / 剪层收益 / 视觉侧首屏闭包）
node scripts/ci/check-core-layers.js --json

# 运行时重量基线（真实 require.cache：三档场景）
node scripts/ci/check-runtime-footprint.js --json

# 契约与预算
cat docs/10_规范/registry/CORE-LAYERS.json
```

**口径自检（§1.5 的那套判据，单独可跑）**：

```bash
# 顶层 require 的分类器：AST 函数作用域（静态侧唯一真源）
node -e "const g=require('./scripts/lib/requireGraph');
const c=g.classifyFile('D:/Portable/khy-os/runtime/node/backend/bin/khy.js');
console.log('顶层',c.top.length,'延迟',c.lazy.length,'口径',c.mode);"

# 运行时侧：加载者是否正在求值（零依赖，不往被测进程塞解析器）
node -e "const p=require('./scripts/lib/runtimeFootprint');
console.log(Object.keys(p));" -- --version
```

---

## 十一、本文的边界

- **本文没有**把后端从 89.7 万行降到某个数。那是 §九 P1/P2/P4 之后的工程量，本文不做。
- **静态侧**只覆盖**静态** require/import 图，不覆盖动态 require（如 `require(path.join(...))`）。
  但实测运行时盲区 = 0 个模块，说明本仓当前没有这类动态加载逃出静态图。
- **运行时侧**只覆盖三个已列场景（`--version` / `doctor` / `ai -p "hi"`），
  不是全仓穷举；且只测后端进程，Python 侧与前端 bundle 的体积不在此列。
- **运行时读数跨会话会漂**：不同的 AI 回复走到不同的模块集合，行数/字节数差几十行。
  故硬预算只给**文件数**（实测波动 0），行数容差 1%、字节数容差 5%。
- **视觉侧已补齐硬判据**（`visual-budget` + `skin-into-visual-core`），不再是只记账。
  但视觉侧的度量只覆盖**桌面端 / web 前端 / TUI** 三个端，
  不含 `delivery/mobile`（Flutter）与 `delivery/extension` 里的前端。
- **TUI 侧本轮只测未改**（见 §6.11）：Ink 对 Suspense 的支持需单独验证，
  收益小于风险，故留作 §九 P6 的评估入口，不是遗漏。
- **§7.7 记的五个探针自身缺陷**，说明「测量工具也会骗人」。本文的每个数字都做了
  **两法独立复核**（正式探针 vs 纯计数探针），但**第三方复核仍是必要的**——
  若你发现某个读数与直觉不符，怀疑测量工具比怀疑结论更可能是对的。
- ~~**v18 的口径修正只覆盖逻辑侧**（§1.5）。视觉侧仍在用旧的括号深度口径~~ ——
  **已在 v19 闭合**（§1.6）：视觉侧加载边分类改用 AST，并显式处理 ESM 提升语义、
  重导出与类型导入；11 个 V0 根里只有 1 个数字变化（`Transcript.js` 15 → 17 文件）。
  仍未闭合的是 `scripts/lib/toplevelSideEffectGuard.js`（RUNTIME-012）——
  但那是**刻意零依赖**的另一个判据（判「顶层副作用」而非加载时机，且只影响候选建议、
  不进入重量预算），记入契约 `blindSpots.knownGaps` 的 `open-by-design` 项。- **AST 口径看不见两件事**：顶层 IIFE（在装载期执行，但箭头函数体算「函数体内」⇒ 记成懒加载）
  与类字段初始化器（在实例化时执行，但类体不算函数体 ⇒ 记成顶层）。
  两者都记入契约 `blindSpots.knownGaps`；运行时口径不受此影响（它看的是真实求值时刻）。
- 重量守卫是**棘轮**：只许减不许增。它不保证重量会降，只保证**不会反弹**。
  真正的下降靠 §九 的分批实施。
- **§8.5 的入口预算只判「顶层 require 的数量与行数」**，不判「入口该有哪些 require」。
  哪些引导该留在顶层、哪些该下沉，是 B7「对外可见的判断」，守卫不替人做。

---

*最后更新：2026-11-01（v21。**视觉侧第七刀：把一块自造的展示件整块删掉**（不是懒加载刀）：
① **删的是哪块**：桌面端消息流底部的「Token 用量（本月配额）」面板（组件
`ContextUsagePanel`，原文件 `apps/khyos-desktop/src/renderer/components/message/ContextUsage.tsx`，
第十三轮还给它加了「长按 400ms 拖出为悬浮面板」）—— 2026-11-01 用户拍板：信息密度过高、
在对话区形成视觉噪音，**整体删除**（不是折叠、不是默认隐藏）；
② **为什么它本就不该在**：ZCode 原版没有独立的月配额面板，用量只在 Composer 右下角
「上下文已用 X / 总量 Y」按钮（及其弹窗）与设置页「使用统计」里 —— 复刻端那个面板是
**自造的**；且它显示的是**月配额账本**（`tokenUsageService.getRemainingQuota`），
与会话级上下文窗口本就是两种语义（第十轮 P3-5 已记过这次错配）；
③ **重量账要说实话**：删的是**懒加载边**上的文件 —— 实测 `ContextUsage.tsx` 从不在
App.tsx 的首屏冷闭包里（冷闭包只计静态边），故本刀**不改变**冷闭包数字；
「删组件」与「减重量」是两件事，别把前者记成后者的收益；
④ **契约同步**：`CORE-LAYERS.json` 的 `visual.lazyLoadSafety.safe` 名单移除
`ContextUsagePanel`（留在名单里，`check-core-layers.js` 会判「不再是懒加载」而红），
`visual.cuts.desktop.cuts` 补一条删除记录；桌面端 `npm run typecheck` 无新增错误、
`npm test` 350 项全绿、`npm run build` 通过、`check-agent-rules.js` 与
`check-change-safety.js`（按改动范围）零违规、`check-core-layers.js` 无
`visual-lazy-regression`；

v20。**P4 的收益前提被实测推翻 + P2 的问题问错了**：
① **P4 自我纠错 ×2（§9.1）**：上一轮记的「上限 −159 模块 / −71,525 行」**作废**——
新探针拦截适配器模块的加载与其**导出函数调用**，实测 **18 个渠道适配器全部被碰到**
（每个都被调过 `detect` / **`detectAsync`** / **`getStatus`** / `listModels`），
完全没碰的 15 个全是 helper（`acpAgentProbe` / `anthropicRelayPresets` / `portableCliInstaller` …），
**没有一个是渠道适配器**。上一轮只数了 `detect`，而网关对**每个**适配器都调
`getStatus()` 与 `detectAsync()`（异步探活，回退链挨个试的那一步）⇒
**「没被 detect 过」不等于「没被用过」** ⇒ thunk 化省不到模块，收益实测归零。
真正的代价在**探活**（`ideDetector.findInstallation` / `traeOfficialArtifacts.resolve*` /
`portableAdapterSpawn.forTool` 都在读盘/起进程），不在加载 ⇒ 若还要动，该动的是
「别探没配置的适配器」（改探活行为 ⇒ 对外可见 ⇒ 须人拍板）。
**先例搬不过来的原因**：`adapterRegistry.js` 的零加载成立是因为 IM 渠道**按 env opt-in**，
而网关 18 个渠道是**无条件全探**。
② **P2 的反事实推演（§9.2）**：把边删掉再算闭包 ——
只剪 `AgentTool → cli/ai`：**0 文件 / 0 行**；连剪 7 条（tools+services 的全部边）：**仍然 0**；
必须剪掉**全部 30 条** →`cli/ai.js` 的边才有 **−321 文件 / −126,461 行**。
30 条里 18 条在 `src/cli/**` 内部（合法），真正越层的只有 **11 条**。
那 321 个文件的构成（services/domain 78、services/gateway 23、cli/handlers 10 但占 1.36 万行、
其余约 200 个单文件如 `localBrainService` 2,991 / `modelTrainingService` 3,035）
⇒ **真刀口不是「谁注入 chat」，而是「chat 路径上哪些大依赖能按需加载」** ——
把 `cli/ai.js` 搬到 services 层并不能让这些依赖离开核心闭包，它们会跟着搬过去。
方案因此改为三步，**先做收益大、风险小的那一步**：① 摘 chat 路径上的大依赖（不改接口）
② 再改 11 条越层边（动接口）③ CLI 内部的 18 条不动（合法）。
**两次纠错的共同教训**：一次错在**算法**（用静态闭包回答「实际用了多少」），
一次错在**探针**（只数了一种调用就宣称「从未被用过」）——都不是数错了，是**问错了 / 测漏了**，
而两次都是靠**再测一次**抓到的，不是靠推理；
v19。**视觉侧口径同步到 AST**（§1.6）：逻辑侧改口径后，
视觉侧的文件头注释仍写着「与逻辑侧同口径」—— 但它跑的是**同一份有缺陷的实现**；
**一份写着「同口径」却跑着另一套语义的契约，等于没有契约**，故一并换掉。
视觉侧比逻辑侧多三条语义，必须显式处理、不能照抄：ESM `import` 是**提升**的
（无论写在哪、哪怕写在函数体内，都是装载期边 ⇒ 逻辑侧「函数体内 = 懒加载」对 ESM 不适用）、
ESM `export ... from` 同样提升（旧口径的正则**完全没统计**这类边 —— 本仓实测 0 条，
但那是运气不是口径正确）、`import type` 被**擦除**（不算运行时边）。
实测 651 个视觉侧文件 **0 降级**（顺带修掉一个降级原因：`<script lang="ts">` 的 lang 属性
在**标签内部**，只看标签之前的文本会漏掉 ⇒ 按 flow 解析 ⇒ `interface` 解析失败）。
影响面：11 个 V0 根里**只有 1 个变化** —— `tui/ink-components/Transcript.js` 15 → **17 文件 / 4,178 行**
（`ProcessGroup.js` 里两个顶层 try{} 中的 require 被旧口径误判成懒加载 ⇒ 旧数字是**低估**），
其余 10 个根分毫未动（桌面端与 web 前端是 ESM，本来就没踩这个坑）；35 条边的归属变了。
顺带修掉一类**假边**：旧正则会匹配**注释里**的 require 文本 ——
`tui/ink-components/caretGeometry.js` 的注释明写「本叶子**绝不** `require('./PromptFrame')`」，
工具把这句话当成了一条真实静态边 —— **测量工具读到了架构注释，并把它当成了代码**。
新增判据 `visual-classifier-degraded`（回退须显式报）；视觉分类器单测 +9 例（共 22 例，已接 pr-gate）。
**没混为一谈的地方**：`toplevelSideEffectGuard.js`（RUNTIME-012）仍用手写词法扫描，
但它判的是「顶层副作用」而非加载时机，且有**零依赖硬约束**（94 个检查器无一 require 外部 npm 包）
并要扫 3,035 个文件 / 27MB ⇒ AST 在那个量级不可接受；其判定只影响**候选建议**，不进入重量预算 ——
记入契约 `blindSpots.knownGaps` 的 `open-by-design` 项，不藏；
v18。**一次口径级自我纠错 + 入口顶层 require 预算**：
① **发现并修正了「冷闭包」本身的测量口径**（§1.5）—— 旧口径用「require 处的括号深度」
区分顶层与懒加载，而**括号深度 ≠ 函数作用域**，于是**两个方向都错**：
顶层 `try { require() }` 块里与**多行解构赋值**里的 require（require( 落在花括号内）
被判成懒加载（入口低估 5 个文件、aiGateway 低估 22 个文件）；
更致命的是旧口径的 `braceDepthMap` **不识别正则字面量** ——
正则里的括号被当成代码结构，从文件中第一个正则起深度整体偏移
（`toolUseLoopCore.js` 第 360 行起，**475,083 个字符里 458,396 个（96%）深度失真**），
后面所有函数体内的 require 都被误判成顶层边（冷闭包虚高 **2.4 倍**）。
偏移方向取决于文件里先出现哪种字符 ⇒ **不可预测**：这不是某个文件写得不规范，
是判据本身没有定义。实测差异：`bin/khy.js` 3→**9** 文件 / 2,602→**3,757** 行；
`toolUseLoopCore.js` 170→**71** 文件 / 91,608→**30,175** 行；
`aiGateway.js` 100→**122** 文件 / 50,928→**71,078** 行（18 个适配器在 `try` 块里，全被漏掉）。
**两个方向都错 ⇒ 这样的数字不能当预算**：一个只涨不跌的棘轮，若基线本身错了，
它锁住的是错误。修正后静态侧用 **AST 函数作用域**（新叶子 `scripts/lib/requireGraph.js`，
@babel/parser 取自**后端包的直接依赖**，不靠「恰好被提升」的运气；解析不到时**显式报**
`core-classifier-degraded`，**不静默降级**），运行时侧用**「加载者是否正在求值」**
的运行时真相（`scripts/lib/runtimeFootprint.js` 的求值栈，**零依赖** ——
往被测进程里塞解析器会污染外部依赖与 heap 读数）；实测 3,076 个模块 0 回退。
② **新增判据 `core-entry-toplevel-requires` / `core-entry-toplevel-lines`**（§8.5）：
CLI 入口的顶层 require（6 个第一方模块 / **999 行**）是「**所有命令都付**」的那一份 ——
`khy --version` 也付，且不会因为「那条路径用不到」而消失。冷闭包预算答「整个闭包多重」，
这条答「**谁把它挂到顶层的**」。顺带补上 `package.json`（245 行）——
旧口径的 `resolveRel` 不认 `.json`，这份每条命令都要解析的文件整个没被计数。
③ **`runtimeFootprint.weightLayers` 从死契约变成活约束**（§8.6）：顶层边可达 /
懒加载边可达此前只写进契约没人读（与 `visual.edgePolicy` 同型缺陷），
现在进守卫输出、参与判预算（`runtime-weight-layer-*`）、随 `--update` 重写。
lite 路径实测：顶层边可达 **332 文件 / 14.4 万行** vs 懒加载边可达 145 文件 / 5.8 万行 ——
**大头是模块装载期自己拉进来的**，这条数字直接指认了 P4（网关适配器按需加载）。
④ 契约补 `entryBudget` 段与 `blindSpots.knownGaps`（含**视觉侧仍用括号深度口径**这一未闭合项）；
⑤ 全部基线数字与文档同步（`doc-contract-drift` 判据当场抓到两处漂移并已修）；
v17。**候选扫描与防回退固化进库**（§6.9b）：
`scripts/lib/visualLayerGraph.js` 新增 `findLazyCandidates()`（扫条件渲染形态 + 量传递重量 +
检副作用与 cleanup + 判首屏主体与共用基础设施 → 输出四类：可切 / 需人判 / 共用基础设施 / 首屏主体）
与 `checkStillLazy()`（防回退，safe 名单里的组件必须仍是懒加载，给**事前**信号；
重量棘轮是**事后**抓到）。**视觉侧第六刀**：`ProcessMonitorDialog`（进程监视器对话框）
改 lazy + 条件渲染 —— App.tsx 38→37 文件 / 9815→9415 行，AppLayout 19→18 文件；
**第三判据被实测修正**：副作用**带完整 cleanup** 时条件挂载不漏订阅（clearInterval /
removeEventListener），反而停掉了「对话框关着时 1s 轮询还在跑」这个常驻副作用 ——
**常驻的副作用本身也是重量**；判据升级为五条（加「不是首屏主体」「不是共用基础设施」）；
**实现踩的三个坑**（都是「判据本身骗人」的实例）：① `lazy()` 写在**导入方**文件里，
不在被导入的组件文件里 —— 一开始查错对象，判据永远不报；② 组件名与文件名常不同
（DiffSummary 来自 DiffViewer、TerminalPanel 来自 Terminal），
不能用 basename 匹配，要认 `.then(m => ({ default: m.X }))` 里**显式写的 X**；
③ 正则里**不能用 `[^)]` / `[^}]` 跨嵌套括号**（`((m) => ({ default: m.X }))` 里两种括号都有，
任何单一排除都会在中间截断），改成「两步法」：先定位 `lazy(` 起点，再在有限窗口内找
`default:` 后面的属性名。三条都与 §7.7 的探针缺陷同源：**测量工具也会骗人，判据也要验**；
本判据做了反向验证（把 ProcessMonitorDialog 改回静态 import → EXIT=1 并精确点名）；
另给逻辑侧与视觉侧的**行数预算加 1% 容差**（行数会因 CRLF/LF 差 1-2 行，
零容差会让守卫因编辑器换行设置而随机红 —— 那等于没有门禁；文件数仍是零容差）；
v16。**对 P4 的一次自我纠错**（§9.1）：我原把 P4 收益写成
「52 文件 / 31,868 行」，依据是「18 个适配器 + 传递依赖」的**静态闭包** ——
而正确的问法是「**几个真的被用了**」。实测（拦截适配器的 detect 导出并计数）：
lite 路径实际只 probe 了 **8 个**适配器（acp/api/claude/clipboardRelay/opencode/
relayApi/warp/webRelay，回退链要挨个探活，它们是必需的），
另有 **10 个只是被顶层 require 拖进来、从未被 probe**（cliTool/codex/cursor2api/cursor/
kiro/localLLM/ollama/openclaw/trae/vscode），而它们各自还拖着 6–21 个传递依赖，
闭包合计 **159 文件 / 71,525 行** —— 收益上限比原估大 3 倍。
教训与全文同源：**静态闭包是「如果全加载会进多少」，重量是「实际用了多少」**；
这次是去查了而不是继续挂着。全部实测数据（8+10 名单、测量方法）已写进契约
`runtimeFootprint.adapterLoading.lazyLoadDecision`；
v15：**视觉侧第五刀：候选靠扫不靠猜** —— 不再凭归因榜猜，
而是扫出全部 `{cond && <Comp/>}` 形态的条件渲染组件（9 个），逐个量 ① 传递重量
② 副作用标记 ③ 是不是首屏主体，最终只切 2 个（DiffSummary 2 文件/493 行、
ElicitationPanel 1 文件/151 行），App.tsx 40→38 文件 / 9815→9521 行；
**不切的四个也记了理由**：MessageBubble（14 文件/2602 行，是消息列表主体，
拆它等于拆首屏）、ModeSelector 与 TitleBar（有 useEffect/addEventListener/window.*，
第三判据不过）、WorkspacePicker（是 Composer 的 header prop，始终渲染，非条件渲染）。
safe 名单 8 条 / unsafe 反例 3 条与「怎么找候选」的方法都已写进契约
`visual.lazyLoadSafety`；
**对账判据立刻立功**：本轮 `--update` 收紧基线后，`doc-contract-drift` 当场抓到
文档里还写着旧的 40/9815 —— 这正是它存在的意义；
v14：**完成度审计结论**（§5.5）：后端全量 jest 的「21 个失败」经分类
是 **19 个 node:test 文件被 jest 误收 + 1 个自运行脚本 + 0 个真 jest 套件** ——
用对运行器逐文件跑，18/19 通过；唯一例外 `rtkMode.test.js` 的 `parseGrepOutput`
经严格对照（还原到 HEAD 后同样失败）确认为**存量**。教训：看到大批失败先分类，
先问「它该由谁跑」，别急着修。**最小核心的实证**：`khy --version` 实际只加载
**11 个第一方模块 / 7,805 行 / 0 个外部模块 / heap 6.5 MB**，
相对后端总量 3510 文件 / 89.7 万行 = **0.31%（文件）/ 0.87%（行数）** ——
「khyos 很重」与「能跑一个很轻的核心」并不矛盾：重的是外壳与可选能力，轻的是芯；
v13：**视觉侧为什么没有运行时足迹守卫**（§6.10b）：场景性质决定，
不是遗漏 —— 前端跑在 Electron/浏览器里（Node 读不到它们的模块缓存）、TUI 需要真实 TTY；
故视觉侧只有静态那套（冷闭包 + 加载归因），逻辑侧两套都有。记入契约
`visual.runtimeFootprintNote`，免得后人重复尝试；
v12：**完成度审计 + 视觉侧第四刀 + 文档↔契约对账**：
① 全量回归：`node --test src/**/*.test.js` **383 套件 / 6,945 断言 0 失败**（覆盖逻辑侧
下沉与 4 处 require 路径改的全部 src 范围）；桌面端 **107/107 通过**、类型检查无新增错误；
② **视觉侧第四刀**：归因榜的 `ToolExecutionPanel`（910 行）与 `ContextUsagePanel`（758 行）
都是「没内容就 return null」的浮层，改 lazy + 条件挂载 —— App.tsx 42→40 文件 / 10326→9815 行；
③ **一条「不可这样改」的反例**：同榜的 `SidePane`（635 行）看着同型却不能改 ——
它的 Ctrl+Alt+B / Ctrl+J 快捷键注册在 visible 闸门之前，条件挂载会让隐藏态丢快捷键。
故「能不能懒加载」不看「平时显不显示」，看三条：不显示时是否真的不渲染任何东西、
挂载卸载会不会漏/重订阅型副作用、有没有依赖常驻的状态（已写进契约
`visual.lazyLoadSafety`，含 safe 名单与 unsafe 反例及出处）；
④ **文档↔契约对账判据**（`doc-contract-drift`）：实测到契约被 --update 更新后
（91,540→91,608、50,860→50,928）文档里还写着旧值 —— 人不会记得同步，而守卫会；
⑤ **P7 补齐**：khyquant 前端早已剥好（27 条路由全懒加载）却**无契约测试** ——
有人把某个 import() 改回静态 import 时首屏会静默变重且不报错（ai-frontend 早有
nav.wiring.test.js 在防这个），补 `routerLazyLoad.contract.test.js` 四条断言实测全 PASS；
⑥ 章节编号与交叉引用自检（8 处 § 引用全部有效）；
v11：视觉侧第四刀与反例；v10：**P7 补齐**：「已剥好」需要测试护着才算数 ——
khyquant 前端早已剥好（27 条路由全懒加载）却**无契约测试**，有人把某个 import() 改回静态
import 时首屏会静默变重且不报错（ai-frontend 早有 nav.wiring.test.js 在防这个）。
补 `src/__tests__/routerLazyLoad.contract.test.js`：断言无静态 component 逃逸 /
动态 import 指向的文件真实存在 / 目标都落在 @/views/ / 顶层不静态引入 view，四条实测全 PASS；
v9：**视觉侧第三刀 + 选刀从直觉变归因**：逻辑侧早有加载归因
（runtimeFootprint 拦 Module._load），视觉侧此前没有 —— 前两刀是**凭直觉**选的
「哪些页面看起来低频」。补 `visualLayerGraph.attributeEntry()` 后，守卫报告段直接给出
「下一刀候选」（入口每个直接依赖的可达重量）。据此定位 CommandCenter（Ctrl+K 命令面板，
自身 `if (!visible) return null` 却一直静态 import 在首屏 bundle 里），
改 lazy + 条件渲染 —— App.tsx 43→42 文件 / 10576→10326 行，AppLayout 20→19 文件；
**与逻辑侧的分工**：逻辑侧归因是**约束**（闸门不许变大），视觉侧归因是**指引**
（视觉层重量天然随功能长，只锁不许减没意义，要告诉人往哪儿砍）；
v8：**视觉侧口径对齐（第二次被测量工具骗）**：视觉侧的边表此前把
函数体内的懒加载 `require` 也算作静态边，与逻辑侧口径不一致 —— 于是 `tui/app.js` 被量成
「172 文件 / 5 万行」，真实值是 **2 文件 / 773 行**。「视觉与逻辑同理」此前只在文档上成立；
修正后同时消除方向判据的一条误报；**视觉侧覆盖补齐**：两个 web 前端此前**无层归属**
（无归属即无约束）—— 实测它们**早已剥好**（ai-frontend 用 `useRoutePrefetch.js` 的
viewLoaders 单一真源表 + 契约测试；khyquant 全部 `() => import(...)` + 分级预取），
记进契约 `visual.peeledSurfaces` 免得后人重复劳动；**顺带修正两处层归属错误**：
`App.tsx` / `tui/app.js` 是首屏入口属 V0（此前误归 V2，导致 V0 预算缺桌面端主入口）、
`ToolLines` 属 V0（此前误归 V1）；
v7：**补上死契约**：`visual.edgePolicy` 此前定义了却无人消费 —— 守卫只读逻辑侧
`contract.edgePolicy`，**一份没人执行的契约等于没有约束**；补上 `visual-layer-direction`
判据（归属 + 逐条边，不按闭包 —— 闭包互相重叠会把 1 条真违例放大成 25 条误报），
立刻抓出 `WorkspaceSidebar(V0) → FileTree(V1)`，促成**视觉侧第二刀**；
v6：**CI 接线**：两个守卫显式加进 `pr-gate.yml` 的 `contract-checks` job——
`check-core-layers.js` 阻断档、`check-runtime-footprint.js --report` 报告档（需网络与凭据）；
并记下「反孤儿守卫的盲区」：check-wiring 只要 package.json 有别名就算「已接线」，
**别名 ≠ CI 会跑**，新守卫必须显式加进 workflow；
**场景确定性**：doctor 改用 `--quick`（跳过工具链探测组，5 次读数完全一致且不 spawn），
实测四种取值 62 / 67 / 68 / 74 来自探测缓存冷热与 --quick 开关 —— 解法是让场景变确定，
而不是把预算放宽到失去意义；
v5：**加载归因**：探针拦截 `Module._load` 记录「加载者 → 被加载者」，
给出 lite 路径的重量闸门（`src/cli/ai.js`，可达 417 模块 / 17.9 万行，闸门不取入口——
入口是调度者不是重量来源）；**权威分布**修正了一个直觉错误：lite 路径 427 个模块里
`services` 占 72%、`cli` 只占 5.2%，重在服务层不在编排层；**P4 决策材料齐备**：
`aiGateway.js` 顶层静态加载 18 个适配器（52 模块 / 31868 行 = lite 的 12.2% / 16.9%），
仓库已有同型先例 `adapters/im/adapterRegistry.js` 的零加载契约，但构造期 detect 包装
构成硬约束 ⇒ 需人决策；**基线修正**：旧读数 468/210462 作废（探针把自己算进测量 +
归因钩子干扰加载），修正后 427/188385，由两法独立复核；**§7.7 记五个探针自身缺陷**
（路径未规范化 / 只定义不安装 / --update 漏字段 ×2 处 / 探针把自己算进测量 / 异常被空 catch 吞掉）
——「守卫是绿的」不等于「守卫在测东西」；
v4：补体积轴（运行时足迹探针 + 守卫，三档场景 11 / 67 / 427 第一方模块）；
v3：补视觉侧同构（V0/V1/V2 分层 + 重量预算 + 两条视觉判据），
桌面端第一刀（App.tsx 三个全屏页 + SidePane 七个面板改 React.lazy），
App.tsx 首屏冷闭包 73→44 文件、19385→10857 行，低频页面占比 39.8%→2.8%；
v2：逻辑侧第一刀，8 个终端几何/能力纯叶子从 cli/tui/ 下沉到 utils/terminal/，
芯的可达闭包中视觉皮文件 8→0；v1：实测基线 + 契约 + 守卫。）*
