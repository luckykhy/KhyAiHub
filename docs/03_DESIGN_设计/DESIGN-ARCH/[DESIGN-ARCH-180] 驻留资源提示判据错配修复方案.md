# [DESIGN-ARCH-180] 驻留资源提示判据错配修复方案

> **隶属**：启动性能族（`[DESIGN-ARCH-178]` 的直接后续）；运行时可观测族（`runtimeResourceProbe`）
> **状态**：**已落地（A + B，2026-10-04；偏离见 §12）** · **日期**：2026-10-04 · **编号**：[DESIGN-ARCH-180] · **落点目录**：`docs/03_DESIGN_设计/`
> **证据基准**：2026-10-04 本机实测（`khy doctor` 短进程 + node-pty 真实 TUI 会话 + 用户截图）
> **与 178 号的关系**：178 修的是「首帧 44s」的性能病灶；本方案修的是**178 留下的判据被误用到稳态**
> 所产生的**常驻告警**。178 的 P0 已落地（实测 981 模块，达标），本方案不改 178 的任何判据。

---

## 0. 一句话

启动期那条「资源 已统计本会话进程…超出判据」**不是资源失控，是判据错配**：
`BUDGET_MODULES = 1000` 抄自 `[DESIGN-ARCH-178]` §7 的**首帧前**验收目标，
而 `runtimeResourceProbe` 在**会话稳态**测量 ⇒ 每次启动必然超标 —— 一条**永远为真的告警**。
本方案 = 判据按测量时点分档（A）+ 启动提示按受众分流并补判据明细（B）。

---

## 1. 现状证据

### 1.1 提示的发出链（file:line）

| 环节 | 位置 | 说明 |
|---|---|---|
| 文案生成 | `runtime/node/backend/src/services/runtimeResourceProbe.js:268` `buildResidencyNotice()` | 无超标项时返回 `null`（静默是常态） |
| 触发 | `runtime/node/backend/src/bootstrap/prefetch.js:169` `emitFootprintNotice()` | 轻量模式 `runtimeFootprintNotice`(+3.5s)；完整模式 `cleanupService`(+3s) |
| 判据 | `runtimeResourceProbe.js:26` `BUDGET_MODULES = 1000`；`:41-42` `HANDLE_BUDGET_TIMERS = 20` / `HANDLE_BUDGET_WATCHERS = 2` | 单一真源 |
| 另一消费面 | `runtime/node/backend/src/cli/handlers/init.js:1216` `_residentResourceChecks()` | `khy doctor` 的「驻留资源」段，与启动提示共用 `assessResidency`（刻意「同一把尺」） |

### 1.2 判据的出处：它是「首帧目标」，不是「稳态基线」

`[DESIGN-ARCH-178]` §7 验收表第 2 条：

| # | 判据 | 门槛 |
|---|---|---|
| 2 | V1 模块数 | **≤ 1000**（现状 1523） |

该判据的探针跑到 `require('./tui/app.js')` **停手** —— 量的是**首帧前**的 `require.cache`。
178 的 P0（redis 顶层副作用改惰性）已于 2026-10-04 落地，实测 V1 = **981**，**达标**。

### 1.3 实测：判据与测量时点错配

| 场景 | 测量时点 | 模块数 | 活体资源 |
|---|---|---|---|
| perf 探针（178 §7） | 首帧前（`require('./tui/app.js')`） | **981** ✓ | — |
| `node bin/khy.js doctor`（本机，短进程） | 启动后稳态 | **1084** ⚠ | 10 项（定时器 1 · 监视 0）✓ |
| 真实 TUI 会话（node-pty，本机） | REPL ready 后 +3s | **2079** ⚠ | 机器余量一并超标 |
| 用户截图（交互会话） | 会话期 | **1475** ⚠ | **91 项** ⚠ |

⇒ **同一把尺量两个时点**。稳态必然包含首帧之后懒加载进来的工具注册表 / 网关 / ink 全树
（`[DESIGN-ARCH-012]` 工具延迟加载、178 §3.3 的 `setImmediate` 预热）⇒ **恒超标**。

> `runtimeResourceProbe.js:262-263` 自己的注释写着：
> 「a boot line that always fires trains everyone to ignore it」
> （每帧都响的仪表会让人学会忽略它）—— 而它正是那条。

### 1.4 附带缺陷：提示把判据明细丢掉了

`buildResidencyNotice:271`：

```js
const readings = over.map((f) => `${f.label} ${f.detail.split('（')[0].trim()}`).join(' · ');
```

`detail` 的**全角括号里装的正是判据**（`（上限 1000）` / `（定时器 X · 文件监视 Y）`），
被 `split('（')[0]` 整段丢掉 ⇒ 用户看到「活体资源 91 项」却看不出**是哪个判据超**。
这是截图无法自解的直接原因。

### 1.5 现状：零文档背书、零守卫

本方案之前，`runtimeResourceProbe` 在 `docs/` 与 `scripts/` **全无引用**；
`BUDGET_MODULES` 的 1000 只活在代码注释里，**没有任何棘轮守着它**。

---

## 2. 设计公理

| # | 公理 | 依据 |
|---|---|---|
| A1 | **判据必须与测量时点同源** | 首帧预算不能量稳态，否则永远是噪声（§1.3） |
| A2 | **会话提示只报「用户可处置」的项** | 模块图的处置是「改代码」，不是会话内动作；对用户是噪声 |
| A3 | **同一把尺**：doctor 与启动提示的判定不得分叉 | `runtimeResourceProbe.js:165-167` 的既有设计意图 |
| A4 | **强度与「有可行解」同步** | 低余量机器上用户没有回退手段 ⇒ 不升 error（本仓既有公理） |

---

## 3. 与既有机制的边界

| 既有件 | 管什么 | 本方案做什么 | 边界 |
|---|---|---|---|
| `[DESIGN-ARCH-178]` §7 | 首帧前模块数 ≤1000 的**验收判据** | **不动**；只把它登记为 `frame` 档的语义真源 | 178 管首帧，本方案管稳态 |
| `[DESIGN-ARCH-062]` 生命周期边界 | 后台常驻 vs 按需加载的**层级声明**（`serviceLifecyclePolicy.js`） | **不动**；句柄超标的 hint 仍指向它 | 062 管「谁该常驻」，本方案管「超标了怎么说」 |
| `khy doctor`「驻留资源」段 | 完整驻留体检（含磁盘树走查） | **不动**；只让它的模块判据按 `cli` 档判定 | 仍是同一份 `assessResidency` |
| `check-tui-gates`（`MAX_GATES=227`） | `KHY_*` 门控棘轮 | **零新增门控**（A4：不引入开关） | — |

---

## 4. 目标形态

### 4.1 A —— 判据按测量时点分档

```js
// runtimeResourceProbe.js —— 模块图预算按测量时点分档（单一真源）
const MODULE_BUDGET = Object.freeze({
  frame: 1000, // 首帧前；[DESIGN-ARCH-178] §7 验收判据，只有 perf 探针消费
  cli: 1200,   // 短进程命令（khy doctor 等）实测 1084，留 ~10% 余量
  tui: 2200,   // 交互会话实测 2079，留 ~6% 余量
});
const DEFAULT_PHASE = 'tui'; // fail-open：忘传 phase 时取最宽松档，不制造噪声
```

- `collectRuntimeCensus(opts)` 接受 `opts.phase`，把对应预算写进 `snap.modules.budget`
- 调用点显式声明时点：`prefetch.js:169` → `{ phase: 'tui' }`；`init.js:1218` → `{ phase: 'cli' }`
- `BUDGET_MODULES` 保留为 `MODULE_BUDGET.frame` 的**兼容别名**（既有测试引用它）

**棘轮纪律**：三个值只许下调。用设计锁测试钉住（要改大必须同时改测试，属有意动作）。

### 4.2 B —— 启动提示受众分流 + 补判据明细

```js
// 模块图的处置是「改代码」，属开发者向；会话提示只报用户可处置的项。
// 它仍在 khy doctor 的「驻留资源」段完整可见（同一把尺，受众不同）。
const SESSION_AUDIENCE = new Set(['memory', 'handles', 'machine', 'children', 'dataHome']);
const over = assessResidency(snap).filter((f) => f.exceeded && SESSION_AUDIENCE.has(f.id));
```

每个 finding 新增 `reading` 字段（短串，带分子/分母）：

| finding | reading |
|---|---|
| memory | `RSS 240/220 MB` |
| handles | `定时器 22/20 · 监视 3/2` |
| machine | `空闲 12%/≥15%` |
| dataHome | `509/500 MB` |

⇒ 提示从 `…：活体句柄 活体资源 91 项，均超出判据。`
变为 `…：活体句柄 定时器 22/20 · 监视 3/2，超出判据。`

---

## 5. 强度梯度

| 阶段 | 强度 | 说明 |
|---|---|---|
| 本方案 | **无新增阻断** | 纯判据分档 + 文案，不改任何退出码 |
| doctor 的 `level` | 保持 `warn` | 不升 error（A4：低余量机器上用户没有可行解） |

---

## 6. 防呆铁律

| # | 铁律 | 可自动判的判据 |
|---|---|---|
| R1 | 模块预算只许下调 | 设计锁测试 `assert.equal(MODULE_BUDGET.cli, 1200)` 等三条 |
| R2 | 净新增 `KHY_*` 门控 = 0 | `node scripts/ci/check-tui-gates.js` 计数不上升 |
| R3 | 会话提示不得含 `modules` | 合成 `modules.loaded` 超标的快照 ⇒ `buildResidencyNotice()` 不含「模块图」 |
| R4 | 同一把尺不得分叉 | 同一快照下 `assessResidency` 的 `modules.exceeded` 在 doctor / notice 路径下一致 |
| R5 | 明细必须带分子分母 | 断言 `/定时器 \d+\/20/`、`/监视 \d+\/2/` 命中 |

---

## 7. B-L2 三步接线清单（一次提交只做一步）

| 步 | 内容 |
|---|---|
| **标记** | 本文档落盘 + 就近索引回写 + html 孪生件（本步） |
| **迁移** | `runtimeResourceProbe.js` 分档 + `reading` 字段 + `prefetch.js` / `init.js` 传 phase |
| **收口** | 同步 `tests/runtimeResourceProbe.test.js` + 新增设计锁用例（R1/R3/R5） |

> **不新增检查器** ⇒ 不触发 `check-wiring` 的四件接线，不动 `RULES-REGISTRY.json`、不改门档阶段表。

---

## 8. 验证与反例

| # | 场景 | 预期 | 状态 |
|---|---|---|---|
| V1 | 合成快照 `modules.loaded = 1084`，phase=`cli` | `exceeded: false` | ✓ 实测（单测 `module budget is split by measurement phase`） |
| V2 | 同上，phase=`frame` | `exceeded: true` | ✓ 实测（同上） |
| V3 | 合成快照 `handles.by.Timeout = 22` | 提示含 `定时器 22/20` | ✓ 实测（单测 `notice names the offending readings…`） |
| V4 | 合成快照**仅** `modules` 超标 | `buildResidencyNotice() === null` | ✓ 实测（单测 `the module graph never fires the session notice`） |
| V5 | 真实 TUI 会话启动 | **不再出现**「资源 …模块图…」行 | ✓ 实测（node-pty；见下方对比） |
| V6 | `khy doctor` | 「模块图」不再恒 ⚠ | ✓ 实测（`✓ 已载入 1084 个模块（上限 1200）`） |

**V5 的改前 / 改后对比**（同一台机器、同一命令、真 TTY）：

| | 提示行 |
|---|---|
| 改前 | `资源  已统计本会话进程（pid 17640，运行 39.5s）：模块图 已载入 2079 个模块 · 机器余量 …` |
| 改后 | `资源  已统计本会话进程（pid 28652，运行 36.7s）：机器余量 空闲 9%/≥15%，均超出判据。处置：先释放系统侧占用（关闭闲置浏览器/常驻应用）再评估` |

⇒ 模块图不再出现（`grep -c 模块图` = 0）；读数带上分子分母；只剩**用户可处置**的项。

**铁律的实测状态**：R1（设计锁）· R2（零新增门控：本次改动不在 `cli/tui/` 扫描面内）·
R3（模块图不进提示）· R4（同一把尺：`assessResidency` 未因受众过滤而变）· R5（明细带分子分母）
—— 全部 ✓ 实测。

**负对照（§5.9993 纪律）**：3 个注入各只红相关用例（去受众过滤→红 7；忽略 phase→红 9+11；
断 phase 接线→红 9），还原后逐字节一致。

---

## 9. 复现方式

```bash
cd D:/Portable/khy-os/runtime/node/backend
NODE="D:/WorkBuddyData-Intl/.workbuddy-ai/binaries/node/versions/22.22.2-2/node.exe"
"$NODE" bin/khy.js doctor 2>&1 | grep -A 8 "驻留资源"
"$NODE" --test tests/runtimeResourceProbe.test.js
```

真实 TUI 会话的读数用仓库自带 `node-pty` 采集（`prefetch.js` 的提示只在真 TTY 下发出）：
spawn `node bin/khy.js` → 自动回车推进交互提示 → 捕获含「已统计本会话进程」的行。
探针一次性，跑完即删。

---

## 10. 未决问题（需人裁决，本方案不代拍板）

| # | 问题 | 代价 |
|---|---|---|
| Q1 | ~~`cli` / `tui` 两个基线取多少？~~ **已按本文的 1200 / 2200 落地**（2026-10-04）。如需调整，改 `MODULE_BUDGET` 三行 + 同步设计锁测试即可 | 已落地，仍可调 |
| Q2 | 是否给 `MODULE_BUDGET` 加一条 CI 棘轮（读基线文件、只降不升）？本方案只用设计锁测试，**无独立守卫** | 加守卫 = 四件接线，成本 ↑ |
| Q3 | `frame` 档是否有人真的消费？（目前只有 178 的 perf 探针，且它不是 CI） | 若无人消费，可只留注释不留常量 |

---

## 11. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-10-04 | 初版。定位提示发出链（`runtimeResourceProbe.js:268` + `prefetch.js:169`）与判据出处（178 §7 首帧目标）；实测三档读数（981 首帧 / 1084 doctor / 2079 真实 TUI 会话）证实**判据错配**；抓到 `buildResidencyNotice:271` 丢弃判据明细的 UX 缺陷；给出 A（分档）+ B（受众分流 + 明细）方案，含 4 条公理、4 条边界、5 条铁律、6 条验证、3 项未决。 |
| 2026-10-04 | **A + B 落地**。`runtimeResourceProbe.js`：`BUDGET_MODULES=1000` → `MODULE_BUDGET{frame:1000,cli:1200,tui:2200}` + `DEFAULT_PHASE` + `_moduleBudget()`；`collectModuleGraph(phase)` / `collectRuntimeCensus(opts.phase)`；5 个 finding 各加 `reading`；`SESSION_AUDIENCE` 过滤（`modules` 不进会话提示）；`buildResidencyNotice` 改用 `f.reading`（不再 `split('（')[0]` 丢判据）。接线：`prefetch.js:169` → phase=tui、`init.js:1218` → phase=cli。测试 7 → **13**。**负对照 3/3 被精确捕获**（去受众过滤→红 7；忽略 phase→红 9+11；断 phase 接线→红 9），还原逐字节一致。端到端：`khy doctor` 的模块图由 `⚠ 1084/1000` 转为 `✓ 1084/1200`。 |
| 2026-10-04 | **回归 + V5 端到端补测**。相关套件 **54/54**（`prefetchRuntimeFootprint` / `updateWiring` / `runtimeResourceProbe` / `doctorReport` / `startupBeats`）。真 TTY 会话实测：改前 `模块图 已载入 2079 个模块 · 机器余量 …` → 改后 `机器余量 空闲 9%/≥15%，均超出判据`（模块图消失，读数带分子分母）。§8 表补「状态」列，V1–V6 与 R1–R5 **全部 ✓ 实测**。 |

---

## 12. 落地偏离表（方案 §4 写的那样 vs 实际做法）

| # | 方案原写 | 实际做法 | 依据 |
|---|---|---|---|
| D1 | `BUDGET_MODULES` **保留为** `MODULE_BUDGET.frame` 的兼容别名 | **删除** `BUDGET_MODULES`，只留 `MODULE_BUDGET` | `AGENTS.md`「手搓风格约定」：只有一个实现就不要建兼容 shim；引用它的只有本方案的测试，已同步改 |
| D2 | 只给「会超标」的 finding 加 `reading` | **全部 5 个** finding 都加（含 `children` / `dataHome`） | 契约统一，避免「有的项有 reading 有的没有」导致 `undefined` 静默进提示 |
| D3 | （未列） | 新增一条**接线判据** `census threads the phase through to the module budget` | 负对照暴露的盲区：原「分档」用例自造 `budget`，`collectRuntimeCensus` 漏传 `phase` 时它照样绿 ⇒ 补端到端判据（§5.8「字段存在但没人写」形态） |

> ⚠ **本轮未做**：Q2（CI 棘轮守卫）、Q3（`frame` 档是否有消费者）**仍是决策而非遗漏**；
> 未新增任何检查器，故不触发 `check-wiring` 四件接线，`RULES-REGISTRY.json` 与门档阶段表一字未动。
