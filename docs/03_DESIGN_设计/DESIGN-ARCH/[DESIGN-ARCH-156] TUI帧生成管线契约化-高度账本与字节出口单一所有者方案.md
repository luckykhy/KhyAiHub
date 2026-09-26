> 状态：提案（**S0 只读测量已执行并回填 §5.1**；S1 及以后待 §9 X-001~X-004 裁决）｜范围：`services/backend/src/cli/tui/` 的**几何账本层**（`chromeBudget.js` / `ink-components/liveRegionBudget.js` / `liveHeightClamp.js` / `overlayLiveBudget.js` / `frameBudget.js`）与**字节出口层**（`app.js` 的 stdout Proxy + `scrollbackPreserve.js` + `runtime/sidebarRail.js`）｜上游依赖：`[DESIGN-ARCH-102]` §3 硬约束 H1/H2/H6/H7/H8、§4.3 chrome 账本、§4.6 缩放与重绘；`[DESIGN-ARCH-103]` P0-5；`tui/AGENTS.md` §0.9.2/§0.9.7｜调研指针：本文 §1｜模板合规：B-P2 七字段据实声明见 §2

# [DESIGN-ARCH-156] TUI 帧生成管线契约化 —— 高度账本与字节出口的单一所有者方案

## 0. 一句话结论

帧高这条硬约束（H1：`帧高 ≤ rows − 1`）目前**没有所有者**：同一个不等式由 **5 个互不知情的控制器**（前馈预测、测量反馈钳制、overlay 独占、App.js 内联算术、出口尾切）从 5 个位置各自逼近，chrome 分项清单存在 **3 份抄本**（文档表格 / App.js 手加 / `chromeBudget` 字段枚举），两端行单位还不一致（ink 数「逻辑行」、本仓数「视觉行」），差额由 5 个 `+2/+4` 魔法余量吸收；出口层则同时存在 **1 个改写者 + 2 个写者**，「本帧要不要清屏」这一意图只能靠**直写 ink 私有字段** `inst.lastOutputHeight` 来表达。

**S0 实测已把病灶定位收窄**（308 例扫描，见 §5.1）：三份 chrome 抄本**今天数值彼此一致**（Δ=0），其危害是「三处必须同时改」的漂移敞口而非现存分歧；真正的分歧在**账本与前馈预测器 C1 之间**（306/308 例不等，−11..+12 行）与 **overlay 独占者 C3**（16 例），另有 **40/308 例属于「谁都算不对」**——小终端 + 补全框/长清单时 `LIVE_MIN` 与清单下限互不相让，那一项要的是裁决（X-004），不是收敛所有者。

本方案不重写界面，而是把这条既成链路**具名为六段管线**，并引入两个契约对象（`FrameGeometry` 几何账本、`CommitPlan` 提交意图）与一个唯一出口（`frameWriter`）：**一处算高度、一处出字节、一处记帧账**。门控数按 H7 净减 6，App.js 巨石与 legacy/CC 双投影**明确不在本次范围**（见 §7）。

| # | 环节 | 病灶 | 处置 |
|---|---|---|---|
| 1 | 几何 | 一个不等式 5 个控制器，无所有者 | 收编为 `framePlan` 单点 + `heightController` 单控制器（§3.1/§3.4） |
| 2 | 几何 | chrome 清单 3 份抄本，文档与代码靠手抄对齐 | `chromeRegistry.js` 代码化登记表，表格由它生成（§3.2） |
| 3 | 几何 | 逻辑行 vs 视觉行两端不一，用魔法余量弥合 | 账本内统一视觉行，换算只在 ink 边界发生一次（§3.3） |
| 4 | 意图 | resize 要清屏只能改 ink 私有字段 | `CommitPlan.intent.repaint` 显式化，ink 私有写收敛到一处（§3.5） |
| 5 | 出口 | 四层字节改写无序列、无记录，H2 靠出口兜底才成立 | 具名有序 `rewriters` 链，逐层留痕（§3.6） |
| 6 | 出口 | ink 注入流之外还有 rail/topicBar 裸字节写者 | 唯一出口 `frameWriter.submit(frame, plan, overlays[])`（§3.6） |
| 7 | 可观测 | `KHY_TUI_DIAG_H` 只看内联账本，看不到实测与出口字节 | 帧账三元组（计划/实测/字节），复用既有诊断出口（§3.7） |

---

## 1. 现状实证（file:line 可复核）

### 1.1 同一个不等式的 5 个控制器

| # | 控制器 | 位置 | 它知道什么 | 它不知道什么 |
|---|---|---|---|---|
| C1 | **前馈预测** `resolveStreamReserve`（`:208`） | `ink-components/liveRegionBudget.js:86-91`（注释自认「**前馈预测**，永远无法准确预知」）、调用点 `ink-components/App.js:99` | 屏高、工具数、兄弟面板存在 | 真实渲染高度 |
| C2 | **测量反馈钳制** `resolveExtraReserve`（`:269`） | `liveRegionBudget.js:86-91,265-276`，采样点 `App.js:4516-4558`（读 `inst.lastOutputHeight`） | ink 刚绘制的真实高度 | 自己上一次改动了什么 |
| C3 | **overlay 独占预算** `overlayBodyRows` | `ink-components/overlayLiveBudget.js:125-131`，调用点 `ink-components/KhyOsView.js:293` | 覆盖层自己的 chrome/margin | C1/C2 正在同时收缩同一块高度 |
| C4 | **内联账本算术** | `App.js:6400-6508`：`:6403-6404` 手工相加 11 项 → `:6470-6482` 拼 `shares` → `:6483-6491` 走 `chromeBudget.liveBudget` → `:6492-6507` **再抄一份同式算术兜底** | 全部 chrome 分项 | 出口层随后还会再切一次 |
| C5 | **出口尾切** | `scrollbackPreserve.js:47-56`（第四层，门控 `KHY_FULLSCREEN_TAILCUT`），几何源注入 `app.js:204-212` | 已验证帧 + 视口行数 | 计划值是多少（只按 `rows-1` 盲切） |

> C4 的一条实证教训（`App.js:6405-6411` 注释）：补全框曾被记成 4 行、实际画 13 行，80/60/40/30/20 列下**账本少报 9~24 行**，后果就是命中 ink 的 fullscreen 分支。这说明账本漏项不是理论风险，是历史事故，而当时**没有机器手段发现它**——修完之后仍然靠注释维持。

### 1.2 chrome 清单的 3 份抄本，且已出现「凑数」

- 文档抄本：`tui/AGENTS.md:204-212` 一张表（`PromptFrame 3 / FooterBar 1 / spinner 3 / 任务清单 3+条数 / slack 1`），表头自己写着「**按实测，不是按注释**」——即承认代码里没有这份实测。
- 代码抄本 A：`App.js:6403-6404` 的 `_chromeNoMenu`，逐项手加，与上表逐条对应但**无引用关系**。
- 代码抄本 B：`chromeBudget.js:46-59` `chromeRows()` 的 `shares` 字段枚举。
- **凑数证据**：`liveRegionBudget.js:44-55` `_baseChrome()` 为了走「单一账本」同时保持旧行为，构造 `{ inputRows: 3, statusRows: 1, slack: 1, extraRows: 4 }` 求和得 9，正好等于 `:57` 的 `LEGACY_BASE = 9`，注释亦写明「与 legacy 逐字节一致」。**账本已存在，但值是反向伪造以匹配旧常量的**——这不是收敛，是把三处抄本焊成了三处。
- 同类余量常数各自为政：`liveRegionBudget.js:39 TASK_PANEL_CHROME=4`、`:66 SAFETY_MARGIN=2`、`:84 WIN_SAFETY_MARGIN=2`、`:91 CLAMP_MARGIN=2`、`chromeBudget.js:24-37` 的 8 个 `CC_*`、`:19 LIVE_MIN=3`。

### 1.3 两端行单位不一致

- ink 的判定用**逻辑行**且取**上一帧**：`tui/AGENTS.md:185-187`（`outputHeight = output.split('\n').length`，`ink.js:320`）。
- 本仓钳制用**视觉行**（含软换行 + CJK/emoji）：`liveHeightClamp.js:355-363` 导出 `wrappedRows / measureVisualRows / tailToVisualRows`，宽度度量单源 `formatters.displayWidth`（注入点 `app.js:211`）。
- 该差额正是 `WIN_SAFETY_MARGIN = 2` / `CLAMP_MARGIN = 2` 存在的原因（`liveRegionBudget.js:79-91` 注释自陈：前馈追不上，故「**用静态余量吸收**」）。
- `[DESIGN-ARCH-102]` H6（`:220-224`）早已要求「折行与计费同一函数」，判据是 `visualRows(t,w) === wrapCell(t,w).length` 属性测试——**但它约束的是文本内部，没有约束「账本 vs ink」这一次换算**。

### 1.4 意图只能靠改上游私有字段表达

`App.js:4445-4468`：resize 时先问 `outputIntegrityMonitor.assessResize()` 决策，随后在 `:4464` **直接赋值 `inst.lastOutputHeight = _decision.rows`**，再手动调 `inst.calculateLayout()` + `inst.onRender()` —— 用「预置上一帧高度 ≥ rows」来**反向触发** ink 的 fullscreen 分支。于是 H1 在本仓是双向的：常态要**严格小于** `rows`，resize 时要**恰好命中** `≥ rows`。没有任何显式字段表达这层意图，只有对私有状态的两次相反写入。私有实例的取用本身已有降级告警机制（`inkRuntime.js:170-202`，注释称 bubbletea `nil_renderer` 式显式降级），**但该降级只覆盖「取不到实例」，不覆盖「取到之后被我们写脏」**。

### 1.5 出口层：1 个改写者 + 2 个写者

- 出口改写：`app.js:182-213` 装配 `scrollbackPreserve.createClearTerminalNormalizer`，四层职责见 `scrollbackPreserve.js:17-56`（剥 `3J` / win32 ED2→ED0 改写 / 剥 `fullStaticOutput` 重发 / 活区尾切），四个门各自独立（`:97 KHY_PRESERVE_SCROLLBACK`、`:110 KHY_SUPPRESS_STATIC_REPRINT`、`:123 KHY_FULLSCREEN_TAILCUT`）。
- 写者 ①：ink，经 `app.js:214-234` 的 stdout Proxy。
- 写者 ②：带外看板，在同一次 `write()` 里**前插清槽字节、后贴重绘字节**（`app.js:224-228`），字节序被注释判定为「根因级的关键」。
- 写者 ③：置顶主题条 OSC 标题（`runtime/topicBar.js`，`app.js:408` 关），另有 `app.js:241-244` 的启动锚点裸写与 `:288/:303` 的鼠标 DECSET 裸写。
- `tui/AGENTS.md:365+`（§0.9.7 单写者原则）**承认**了这个风险类别并登记过两起事故（BUG-13 winston、BUG-17 watchdog），但处置方式是**逐个收编为绕过者名单**——它规定了「别人不许自己画屏」，却始终没有规定「**那谁来画**」。

> ⚠ 附带发现的**注释漂移**：`app.js:174` 写「门控 `KHY_SIDEBAR_RAIL`, 默认开」，而 `railLayout.js:68-80` 的实际默认是 **off**（注释写明 P0-2 / `[DESIGN-ARCH-102]` §10:830「带外 rail 不作默认后端，需显式 on-writing」）。读 `app.js` 做设计的人会据此把带外绘制当成活跃主路径。见 §9-X-003。

### 1.6 H2 的判据错位（假绿）

`[DESIGN-ARCH-102]:196-202` 的 H2 要求「零 `ESC[2J`/`ESC[3J`，全量重绘一律 ED0」，判据是「**全仓静态扫描零命中**（CI 门）」。但实际达成路径是：ink 运行时**照样发射** `clearTerminal`（`scrollbackPreserve.js:11-15` 记录 `ink.js:327`/`instance.js:132`），由出口层在字节上改写为 ED0。静态扫描只看本仓源码，扫不到 `node_modules` 里的运行时行为——**条文靠出口兜住了结果，判据却只证明了源头清白**，两者不是同一件事。见 §9-X-002。

### 1.7 可观测性断层

- `App.js:6753-6757`（`KHY_TUI_DIAG_H=1`）打印的是 **C4 的内联账本**，看不到 C5 是否真的切了字节。
- `healthScorecard.js:50-54,96` 的 `h1Holds` 用 `chromeBudget.liveBudget()` **算出来**的，不是实测帧——它检查的是「算术自洽」，不是「屏幕真的没超」。
- `frameBudget.js:133` 只导出 `createGuard`（渲染**耗时**），与高度无关。
- 结论：没有任何一处能把「计划高度 / ink 实测高度 / 出口实际字节」三元组放在同一行里对照。上述每一次定位（`AO/repro-before.txt`、`AU/repro-before-bug77b.txt`）都靠**外部字节流探针**手工完成。

---

## 2. 借鉴提案（B-P2 七字段）

**零外部借鉴**，本方案是本仓自身缺陷的结构性收敛，判据全部来自既有真源 `[DESIGN-ARCH-102]` H1/H2/H6/H7/H8。

| # | 字段 | 声明 |
|---|---|---|
| 1 | 借鉴对象 | 不适用 —— 无外部项目引入 |
| 2 | 借鉴内容 | 不适用。唯一沿用的**本仓既有**先例两处：`inkRuntime.js:39-48` 的「显式降级命名 + 一次性告警」模式（其注释自陈源自 bubbletea `nil_renderer`，属本仓已落地实践），以及 `docs:rules-cards`「登记表 → 文档」的单向生成先例 |
| 3 | 解决的问题 | §1.1–§1.7 所列七项，均附 file:line |
| 4 | 许可证与代码性质 | 不适用 —— 不引入上游代码；ink 保持为既有依赖，本方案**不 fork、不 patch ink** |
| 5 | 借鉴方式 | 不适用 |
| 6 | 落点与现有实现对比 | 新落点 `framePlan.js` / `chromeRegistry.js` / `frameWriter.js` 均无既有并行实现：已搜索 `planFrame|frameLedger|terminalWriter|writeFrame(` 于 `src/cli/tui`，零命中；被收编的 5 个控制器与 3 处出口写者见 §1 逐条列明。**复用**（非重造）既有件：`chromeBudget`（H1 算术核）、`liveHeightClamp.measureVisualRows`（视觉行度量）、`formatters.displayWidth`（宽度单源）、`healthScorecard`（诊断出口）、`inkRuntime.getInkInstance/isInstanceLookupDegraded`（实例访问与降级） |
| 7 | 与既有约束的冲突 | 一处：`tui/AGENTS.md` §0.1「禁止修改 Legacy 模式下的任何代码路径」。本方案 S1 起必须替换 `App.js:6400-6508` 的内联账本。冲突已上报待裁决，见 §9-X-001，**未获裁决前本方案只到 S0** |

---

## 3. 目标架构：六段管线 + 两个契约 + 一个出口

### 3.1 管线阶段与所有者

```
P1 投影  events/messages ──▶ screenLines[]          (既有，本次不动)
P2 几何  screenLines + registry ──▶ FrameGeometry   ★ framePlan.js        ← 唯一算高度的地方
P3 布局  FrameGeometry ──▶ React tree (props 下发)   (App.js，瘦身为「只消费 plan」)
P4 合成  tree ──▶ frameString                        ink（外部，私有字段只允许 1 处写）
P5 改写  frameString + CommitPlan ──▶ bytes          ★ frameRewriters.js   ← 收编 4 层
P6 提交  bytes + overlays[] ──▶ 一次 write()          ★ frameWriter.js      ← 唯一碰真 stdout 的地方
```

依赖方向单向：P2 不知道 P5 存在，P5 不知道 React 存在。每段的输入输出都是可冻结的纯数据，因此每段可独立单测（沿用本仓「纯叶子：零 IO、确定性、绝不抛」的既有纪律）。

### 3.2 `chromeRegistry.js` —— 把 AGENTS.md 的表变成代码

```js
// Each entry = one fixed (non-scrolling) row group, with its own evidence.
{ id: 'promptFrame', rows: ctx => ctx.inputRows, kind: 'paint',
  layout: ['legacy', 'preview'], evidence: 'measured:App.js:6363-6376',
  owner: 'PromptFrame.js' }
{ id: 'spinnerBusy', rows: 1, when: ctx => ctx.busy && !ctx.awaitingUserChoice,
  kind: 'paint', layout: ['legacy', 'preview'],
  evidence: 'measured:App.js:6385-6394', owner: 'Spinner.js' }
{ id: 'inkTrailer', rows: 1, kind: 'reserve', layout: ['legacy', 'preview'],
  evidence: 'measured:chromeBudget.js:24 CC_TRAILER_ROWS', owner: '(ink)' }
```

- `rows` 允许是 `fn(ctx)`，但 `when`/`evidence`/`owner`/`kind` **必填**；缺 `evidence` 视为未登记，守卫记样本（§5）。
- **`kind: 'paint' | 'reserve'` 是强制字段，不是注释**：`paint` 是这一帧真的画到屏幕上的行，`reserve` 是刻意留空的上界行（conpty 软换行余量、ink 追加的尾部 `'\n'`）。H1 只对 `paint` 求和；把 reserve 当 paint 记账会**双计**并制造出「308/308 全违规」的假红（S0 首版实测踩过，见 §5.1）。`chromeBudget.js:117-119` 早已就「cap 里的换行余量是 reserve 而非 paint」写过这句话，本节把它从注释升格为契约字段。
- 取代关系：`AGENTS.md:204-212` 表格改为**由登记表渲染**（`docs:rules-cards` 同法，构建产物不得手改），从此「文档说的」与「代码算的」不可能不一致。
- 收编：`App.js:6403-6404` 手工相加、`:6492-6507` 兜底副本、`liveRegionBudget.js:44-55` 的凑数 `_baseChrome()`（其 9 必须拆成真实分项，允许总行数变化，因为「凑成 9」本身已说明真值未被测量）。
- `chromeBudget.js` **保留**为算术核（`chromeRows`/`liveBudget`/`LIVE_MIN`），只换数据源：`shares` 由 registry 产出，不再由调用方拼装。**换算处不得把 `inkTrailer` 塞进 `shares`**——`liveBudget()` 自带那 `- 1`，两处都给就少画一行（`frameDivergence.sharesFrom()` 已把这条例写成断言）。

### 3.3 单位统一

- `FrameGeometry` 内部一律**视觉行**，`unit: 'visualRow'` 显式声明。
- 与 ink 的换算只发生在 P6 边界一处：`toInkOutputHeight(frameString)`（逻辑行），并断言 `planned_visual ≥ ink_logical` 的方向性。
- 一旦单位统一，`SAFETY_MARGIN/WIN_SAFETY_MARGIN/CLAMP_MARGIN` 三个魔法 2 降级为**可解释的登记项**（「conpty 软换行离散化，evidence: BUG 编号」），不再参与正确性。

### 3.4 `heightController.js` —— 5 个控制器合成 1 个

C1（前馈）与 C2（反馈）本质是同一条控制律的两项，合并为单函数、单状态：

```js
next({ plan, measuredFrame }) -> { seedRows, correctionRows }   // pure, monotonic
```

- 保留既有的收敛条件（单调非降 + 相等守卫防渲染循环，`App.js:4555-4557`）。
- C3（overlay）不再是「另一处预算」，而是 registry 里一条 `when: ctx.overlay !== null` 的登记项 ⇒ overlay 激活时其行数以普通 chrome 身份参与同一次求和。
- C5（尾切）保留在 P5，但**降级为纯保险**：它只在 `plan.overflow != null`（几何不可能）时动作，并在帧账里如实记 `tailCut` ——「切了」不再是静默行为。

### 3.5 `CommitPlan` —— 把「我要清屏」变成显式意图

```js
CommitPlan = { repaint: 'incremental' | 'full', reason: 'resize-cols' | 'h1-overflow' | null }
```

- 唯一消费者是 `frameWriter`；**只有它**被授权写 `inst.lastOutputHeight`（现为 `App.js:4464`），写前断言 `repaint === 'full'`，写后计入帧账。私有字段的取用沿用 `inkRuntime` 的降级标志（`:209-211`）。
- `App.js:4445-4481` 的 resize 分支改为：算 `CommitPlan` → 交给 `frameWriter`，自身不再持有任何 ink 内部引用。

### 3.6 出口收敛

```js
frameWriter.submit(frameString, commitPlan, overlays = [])
// rewriters: ordered, named, each returns { bytes, applied: reason|null }
[stripScrollbackClear, normalizeWinEd2ToEd0, suppressStaticReprint, tailCutToVisibleRows]
```

- 把 `app.js:214-234` 的 Proxy 内联逻辑搬进模块；`sidebarRail` 的清/画字节从「Proxy 里前插后贴」改为 `overlays[]` 的显式成员（保留 `app.js:176-179` 注释所述的**字节序**：清 → 帧 → 画，一次 `write()`，这条不变量上升为 `frameWriter` 的单测断言）。
- 单写者原则由此从「禁止别人画屏」（`AGENTS.md` §0.9.7）升级为「**画屏的只有这一个函数**」。`topicBar`（OSC 标题）、鼠标 DECSET、启动锚点等**非像素**写入保持直写（它们不参与帧高账本，混进来只会污染字节链），但必须在 §1.5 名单里登记为「非帧写入」。

### 3.7 帧账（唯一的可观测面）

`frameWriter` 维护环形缓冲（默认 50 帧）：

```
{ seq, rows, cols, chrome: {id: rows, ...}, total,
  plannedLive, inkOutputHeight, rewriters: ['normalizeWinEd2ToEd0'], tailCut: n|null }
```

- 出口**不加新命令**（规则 12 棘轮：命令面 245 已满）：`KHY_TUI_DIAG_H=1` 从「打内联账本」改为「打最近 N 帧三元组」，`healthScorecard` 的 `h1Holds` 从纯算术改为读帧账实测。
- 这一步顺手补 §1.7 的判据错位：`h1Holds` 今后是**测出来**的。

---

## 4. 门控收敛预算（H7）

H7（`[DESIGN-ARCH-102]:225-231`）要求 `cli/tui/` 内唯一 `KHY_*` token ≤ 40，实测当前 **231**（`grep -rho "KHY_[A-Z_0-9]*" src/cli/tui`）。本方案只处理**帧高/字节族**，净减 6：

| 现有门（8） | 处置 |
|---|---|
| `KHY_LIVE_HEIGHT_BUDGET`、`KHY_LIVE_HEIGHT_CLAMP`（`liveRegionBudget.js:99,113`） | 合并 → `KHY_FRAME_PLAN` |
| `KHY_TASK_PRIORITY_CAP`（`ink-components/taskPanelLines.js:253`）、`KHY_LIVE_HARD_CLAMP` / `KHY_LIVE_CLAMP_FAST_MEASURE`（`liveHeightClamp.js:65,87`） | 合并 → `KHY_FRAME_PLAN` 或降为 registry 属性 |
| `KHY_PRESERVE_SCROLLBACK` / `KHY_SUPPRESS_STATIC_REPRINT` / `KHY_FULLSCREEN_TAILCUT`（`scrollbackPreserve.js:97,110,123`） | 合并 → 每个 rewriter 保留独立开关**但**统一经 `KHY_FRAME_REWRITERS=off,<list>` 一档表达 |
| 新增（2） | `KHY_FRAME_PLAN`、`KHY_FRAME_DIAG` |

**回退纪律不变**：`KHY_FRAME_PLAN=0` 必须逐字节回到 §1 现状（含 C4 的兜底算术副本，S0/S1 期间保留，S3 观察达标后才删除）。

---

## 5. 分期落地（`PROCESS-008` 四阶段）

| 阶段 | 内容 | 出口条件 |
|---|---|---|
| **S0 只读** | 建 `chromeRegistry.js` + `framePlan.js`，**不改任何调用方**；把 §1.1 的 5 个控制器输出并列打进帧账，量化「它们此刻分歧多大」 | 拿到分歧样本（预期 >0，否则本方案立论不成立，应作废） |
| **S1 观察者** | `check-frame-ledger.js` 上线并**恒 exit 0**：报「registry 有项但帧内未出现」「帧内出现但无登记」「`planned ≠ ink 实测` 超 1 行」「tailCut 非零触发」。在 `FEATURE-OWNERSHIP.json` 登记 mechanism `stage: S1, severity: advisory` | ≥200 条相关事件且无解释不了的样本 |
| **S2 顾问** | C1+C2 合并为 `heightController`；App.js:6400-6508 消费 `planFrame`（保留兜底副本）；`AGENTS.md` 表格改为生成物 | ≥50 条提示且误报 <10% |
| **S3 门禁** | 出口收敛到 `frameWriter`；`CommitPlan` 替换 `inst.lastOutputHeight` 直写；删除 C4 兜底副本与凑数 `_baseChrome`；registry 漏项判 error | 需人工独立回滚验证（PP-4） |

**不新增规则 ID**（规则棘轮 94 已满，新增一条须先退役一条）：守卫挂既有 H1/H2 判据之下，mechanism 单独登记，升档只改执行器 `STAGE` 常量。每档回滚动作：`previousStage` 写回登记表 + `KHY_FRAME_PLAN=0` 一键回到旧路径。

### 5.1 S0 实测结果（2026-09-26 已执行，零改动既有调用方）

交付物：`src/cli/tui/chromeRegistry.js`（12 项）、`framePlan.js`、`frameDivergence.js`、单测 `tests/tuiFrameLedger.test.js`（18 例，jest 全绿）。扫描空间 **308 例** = 2 布局 × 2 平台 × 11 上下文 × 7 个 rows 档（13/14/18/24/30/40/60）；复现命令：

```bash
cd services/backend && node -e "const s=require('./src/cli/tui/frameDivergence').scan({});console.log(JSON.stringify(s.stats,null,1))"
```

| 对照 | 实测 | 判读 |
|---|---|---|
| registry vs C4 主路（`chromeBudget.liveBudget`） | **Δ = 0，308/308** | 两份代码抄本**今天数值一致**。§1.2「3 份抄本」成立，但危害是**漂移敞口**（三处同时改才能改对），不是现存分歧 |
| registry vs C4 兜底副本（`App.js:6492-6507`） | **Δ = 0，308/308** | registry 是现行为的**忠实复现** → S2 属重接线，不是行为变更。提案口述中我曾推论「主路与兜底恒定差 1 行」，**本扫描否证，撤回** |
| registry vs C1 前馈（`resolveStreamReserve`） | **306/308 分歧**，范围 −11..+12 | 真分歧在此，且**双向**：52 例 C1 算出的可用行数为**负**（它自身无下界，下界由各消费者另行发明）；31 例 C1 **比账本更宽松**（超配最多 12 行）——超配那一侧才是把帧推过 `rows` 的方向 |
| registry vs C3 overlay（`overlayBodyRows`） | 28 例激活，**16 例非零**，−2..+1 | overlay 自带一份 chrome 常数（`overlayLiveBudget.js:39,42` 的 `OVERLAY_CHROME 5 + OVERLAY_MARGIN 3`，即 `rows − 8`），与账本差 1~2 行 |
| H1（**实画行** > rows−1） | **40/308**，全部落在 rows 13~18 且「补全框打开」或「任务清单偏长」 | 两份现存账本给出**同样非法**的帧：不是它们互相不一致，而是**没有所有者去压缩分项**——`LIVE_MIN=3` 与清单下限 3 抢同一批行，谁都不肯让 |
| ink 全量重绘条件（`painted + trailer ≥ rows`） | **46/308**，其中 **6 例** H1 成立、只多算 ink 追加的那一行 | 这一类**必须先分离 paint/reserve 才看得见**（首版混计时它被 308 例假红淹没）：差一行，走的就不是同一条重绘分支 |

**S0 出口条件判定**：预期「分歧 >0」成立（C1 306 例、C3 16 例），立论不作废；但**分歧的重心从「抄本之间」移到「抄本与预测器之间」**，故 S2 内部排序调整：

1. **先修 C1 的负值与超配**（52 + 31 例，是用户可感的那一侧），此项独立于 5→1 合并即可交付；
2. 再做 `heightController` 合并与 App.js 消费 `planFrame`；
3. **H1 的 40 例不是账本问题**，是「无所有者允许压缩」的问题——需要 §3.2 之外的一条裁决：**谁有权限在几何不可能时砍掉补全框/清单的行**。S3 之前必须回答，否则换多少所有者都仍然违规。见 §9-X-004。

---

## 6. 验收判据（命令 + 期望输出）

| 判据 | 命令 | 期望 |
|---|---|---|
| 三元组可读 | `KHY_TUI_DIAG_H=1 node services/backend/bin/khy.js`（对话至触发一次 resize） | 每帧一行，含 `planned` / `ink` / `rewriters[]`；稳态差值 ≤1 |
| H1 恒成立（属性测试） | `node services/backend/scripts/run-ink-tui-tests.js framePlan` | 随机 `rows×shares×overlay` 组合下 `plannedLive ≤ rows-1` 无一例外 |
| 账本==屏幕 | 同上，80×24 / 120×40 / 200×60 三档 | `registry.total` 与帧内实测差 0；补全框、任务清单、spinner 三项**分别**断言（历史三次事故项） |
| 无静默尾切 | 生成中连续 5 帧 | `tailCut` 为 `null`；若不为 null，同一行必须有 `overflow.reason` |
| resize 快照 | 序列 `120→80→200→119→120`（`[DESIGN-ARCH-102]` §4.6 判据） | 末态快照 == 冷渲染快照；`repaint: 'full'` 只在 cols 变化帧出现 |
| 门控收敛 | `node scripts/ci/check-tui-gates.js` | `cli/tui` 唯一 token 数下降 ≥6 |
| 逐字节回退 | `KHY_FRAME_PLAN=0` 跑同一对话脚本 | 与改前字节流一致（差分空） |
| 不越界写屏 | `grep -rn "process.stdout.write\|process.stderr.write" src/cli/tui` | 出口层命中仅 `frameWriter.js`；非像素写入（OSC/DECSET/锚点）逐项对得上 §3.6 名单 |

---

## 7. 不做清单（边界）

- **不拆 `App.js` 巨石**（7169 行、51 `useState`、35 `useEffect`）——那是 P3 视图状态机的独立设计。本方案只要求 P3「消费 `FrameGeometry`」，不规定其内部结构。
- **不合并 legacy/CC 双投影**（`ccMessageProjection.js` 1011 行 vs `transcriptLines.js` 400 行）——P1 保持原样，P2 只接「已产出的屏幕行」。
- **不改鼠标/选择/输入层**（`mouseButtons.js`、`selection.js`、`useTextInput.js`）。
- **不 fork / 不 patch ink**：与 ink 内部的一切接触收敛为 `frameWriter` 一处 + `inkRuntime` 既有降级标志。
- **不新增 CLI 命令、别名、规则 ID**（棘轮只降不升）。
- **不追求把 231 个门控一次压到 40**：本方案只交付帧高/字节族的 −6，其余族另案。

---

## 8. 与既有真源的关系

| 真源 | 关系 |
|---|---|
| `[DESIGN-ARCH-102]` §3 H1/H2/H6/H7/H8、§4.3、§4.6 | **承继**。本方案是把这些**已成文但无所有者**的条文补上执行结构；H1/H2 判据从「算术自洽 + 源码静态扫描」升级为「实测帧 + 出口字节」 |
| `[DESIGN-ARCH-103]` P0-5（`:563`，`chromeBudget.js` 单一账本） | **部分完成，本方案接续**。P0-5 立了账本却留下 3 份抄本与凑数常量（§1.2），本方案补的是「数据来源与所有者」 |
| `tui/AGENTS.md` §0.9.2（帧高 ≤ rows−1 + chrome 表） | 表格降为 registry 的**生成物**；条文本身不动 |
| `tui/AGENTS.md` §0.9.7（单写者原则） | 从「绕过者名单」升级为「唯一出口函数」；名单继续有效，但新增绕过者的判定标准变成「是否走了 `frameWriter`」 |
| `[DESIGN-ARCH-119]`（鼠标/选择） | 无交集：P6 只搬运 rail 字节，不改鼠标档位真源（`enableBytes` 仍是唯一真源） |
| `PROCESS-008` / 规则 8 | 守卫按 S1→S3 逐级升档，样本量毕业，不看时间 |

---

## 9. 待裁决点（未裁决前不实施）

| # | 问题 | 建议裁决方向 |
|---|---|---|
| **X-001** | `tui/AGENTS.md` §0.1 红线「**禁止修改 Legacy 模式（`KHY_CC_TUI` 未设置）下的任何代码路径**」按字面成立时，本方案 S2 起即违规（必须替换 `App.js:6400-6508`）。该条文的**约束对象**是「为 CC 复刻而做的改动不得破坏 legacy」，还是「一切改动」？ | 建议：前者。重构类改动改走「门控 + 逐字节回退 + S1 观察」纪律（即 §4/§5）。**需人工裁决，不得由本方案自解释放宽** |
| **X-002** | H2 判据「全仓静态扫描零命中」是否改定义为「**出口字节扫描**」？现状是结果成立、判据不成立（§1.6 假绿） | 建议：改为双判据——源码静态扫描（防新代码发射）**且**帧账断言出口无 `2J/3J`（防运行时发射） |
| **X-003** | `app.js:174` 注释称 `KHY_SIDEBAR_RAIL` 「默认开」，实际默认 off（`railLayout.js:68-80`）。随手订正，还是按规则 7 单独提交（删除/改判读先报部位）？ | 建议：随 S0 一并订正，属注释纠错不改行为，`rollback.txt` 即 `git revert` 该单文件 |
| **X-004** | **几何不可能时谁有权压缩分项？** S0 实测 40/308 例（rows ≤ 18 且补全框打开或任务清单偏长）下，两份现存账本给出**同样非法**的帧：`LIVE_MIN = 3`（`chromeBudget.js:19`）与任务清单下限 3（`liveRegionBudget.js:143`）互不相让。换所有者**不解决**这一类，必须有裁决「补全框 / 任务清单 / 视口」三者谁先让步、让到几行 | 建议：定序为「补全框（瞬时态）→ 任务清单（已有 `capTaskLines` 可继续砍）→ 视口 floor」，并把 floor 降到 1；**这条裁决是 S3 的前置条件**，不是实施细节 |

---

## 10. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-26 | 初始提案：现状实证 §1（5 控制器 / 3 抄本 / 单位两端 / 私有字段表意图 / 3 写者 / 判据假绿 / 观测断层，均附 file:line）、六段管线与两契约（§3）、H7 门控净减 6（§4）、S0–S3 分期（§5）、验收（§6）、不做清单（§7）、待裁决 3 项（§9） |
| 2026-09-26 | **S0 执行完毕并回填 §5.1**（308 例扫描）：抄本之间 Δ=0（撤回「主路与兜底差 1 行」的推论），真分歧在账本与 C1 前馈之间（306 例，−11..+12，其中 52 例为负、31 例超配）与 C3 overlay（16 例）；新增 **X-004**（40 例几何不可能，floor 互不相让，S3 前置）。§3.2 契约加 **`kind: paint\|reserve` 强制字段**——首版把 reserve 当 paint 记账，产出「308/308 全违规」假红，已由 `framePlan` 的实画行判据修正 |
