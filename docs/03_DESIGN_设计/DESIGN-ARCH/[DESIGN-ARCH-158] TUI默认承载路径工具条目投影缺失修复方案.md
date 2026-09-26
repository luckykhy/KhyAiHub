# [DESIGN-ARCH-158] TUI 默认承载路径工具条目投影缺失修复方案

> **状态**：提案（待评审，未落码）
> **定位**：本文件管「TUI **默认**转录承载路径里，一次工具调用**有没有被画出来**」。**写什么**（一行语法）以 `[DESIGN-ARCH-155]` 为准；布局/行高/键位/门控预算以 `[DESIGN-ARCH-102]` 为准；桌面端工具卡片的数据通路以 `[DESIGN-ARCH-152]` 为准（边界见 §0.2）。
> **范围**：`services/backend/src/cli/tui/transcriptLines.js`（投影器）、`services/backend/src/cli/tui/hooks/useQueryBridge.js`（折叠判定一处）、`services/backend/tests/cli/tui/transcriptLines.test.js`
> **上游依赖**：零新增依赖、**零新增 env 门控**（`check-tui-gates` 的唯一 token 数**现查 232 / 上限 227**，HEAD 上即已超限）
> **调研指针**：`[DESIGN-ARCH-152]`（桌面端工具卡片接线）、`[DESIGN-ARCH-155]`（工具调用短显示规范）、`[DESIGN-ARCH-102]`（TUI 统一规则手册）、`[DESIGN-ARCH-146]`（卡片挂点/展开，同族「判定面白名单」教训）
> **模板合规**：非借鉴类改动，B-P2 七字段按体例「不适用」——依据：全文只复用本仓既有模块（`ProcessGroup.groupConsecutiveTools`、`ToolLines.summarizeArgs`、`transcriptLines`），无外部项目、代码或设计稿借鉴。

---

## 0. 一句话结论

**工具条目在默认承载路径上不是被「压成一行」，而是被整条丢弃。**

真源 timeline 的条目形状是 `{ type: 'tool', tool }`（`queryBridgeTimeline.js:41` 的 `tlPushTool`），
而投影器 `transcriptLines._timelineLines` 只认 `{ type: 'tools', tools: [] }`（`transcriptLines.js:212`）——
那是 `ProcessGroup.groupConsecutiveTools()` **分组之后**的产物。
于是「说明」（合成叙述文本段）照常渲染，**工具本身一条不剩**：用户看到的就是「只有说明、没有工具卡片」。

### 0.1 病灶总表

| # | 症状（用户可见） | 根因 | 位置 | 等级 |
|---|------------------|------|------|------|
| **P0** | 转录里**看不到任何工具**，只剩合成叙述（「我先定位…」「这轮 14 处，接着往下核对。」）；工具在提交瞬间从屏幕消失 | 投影器不认真源形状 `{type:'tool'}`，`continue` 静默跳过 | `transcriptLines.js:212`（分支表 `:186-220`） | **P0** |
| **P2** | 以工具为主的回合 **Ctrl+O 判为不可折叠**；`expansion` 视图里工具条目整条消失 | 同一形状判据写歪：`_entryIsFoldable` 只认 `{type:'tools'}` | `useQueryBridge.js:240`（判定）/ `:285`（过滤） | P1 |
| **P0-b** | 同一个工具「运行中」与「已提交」**形态不一致**（`  ● name summary` ↔ `  ◆ name(summary)`） | 流式投影是**手写的第二套格式**，与投影器不同源 | `App.js:5975-5982` | P2 |

### 0.2 与既有件的边界（补空白 > 另起炉灶）

| 既有件 | 它管什么 | 本方案做什么 | 边界 |
|---|---|---|---|
| `[DESIGN-ARCH-155]` | 一次工具调用**写成哪一行**（行语法契约，四端统一） | 这些行**有没有**被投影出来 | 本方案不动行内文案、动词、图标语义；行内容变更一律归 155 |
| `[DESIGN-ARCH-152]` | **桌面端**（`apps/khyos-desktop`）工具卡片的**数据通路** | **TUI** 侧承载路径的投影接线 | 152 的范围不含 `services/backend/src/cli/tui/**` |
| `[DESIGN-ARCH-102]` | TUI 布局 / 行高 / 键位 / 门控数量 | 条目形状归一 | 不新增门控、不改行高与键位 |
| `[DESIGN-ARCH-146]` | 卡片点击命中与展开（挂点决定粒度） | — | 只借用其「判定面常是白名单清单」的教训（见 §1.3） |

> 检索记录：`grep -rl "工具卡片\|transcriptLines" docs/ --include="*.md"` 命中 152/155 等 20 件，
> **无一件把 `transcriptLines.js` 纳入范围**——本方案落在这个空白上。

---

## 1. 现状实证（file:line 可复核）

### 1.1 承载路径：默认不是 ink 组件，而是「纯文本行 + 应用内 Viewport」

```
App.js:215  _inlineTranscriptEnabled()   除 0/false/off/no 外**默认开**（:6087 取值）
   ⇒ 默认：转录由**应用内 Viewport** 承载，内容是 transcriptLines 产出的**纯文本行数组**
        App.js:5932 _mainContentLines → :5942 buildTranscriptLines(query.messages, …)
   ⇒ 仅当显式 KHY_INLINE_TRANSCRIPT=0 时才回退 <Static> + ink 组件（App.js:197 _STATIC_BANNER_ONLY）
```

推论（决定了用户看到什么）：

- `ToolLines` 的**卡片**（圆角 Box / `⎿` 结果体 / ±diff / 折叠）**只存在于两条路径**：
  live 流式区（`StreamingBlock.js:283` → `ToolLines`）与 `KHY_INLINE_TRANSCRIPT=0` 的 `<Static>` 路径。
- **默认路径没有卡片，只有文本行。** 所以本方案的目标不是「把卡片搬过来」，而是先保证
  **工具行至少存在**（P0），形态问题另按 §7-4 裁决。

### 1.2 真源形状 vs 消费面

| 消费者 | 位置 | 吃 `{type:'tool'}`（真源形状） | 吃 `{type:'tools'}`（分组后） | 结论 |
|---|---|---|---|---|
| **投影器**（默认承载） | `transcriptLines.js:212` | ❌ **静默跳过** | ✅ | **P0 缺陷** |
| committed ink 路径 | `Transcript.js:367` | 先 `groupTimeline` 归一 | ✅ | 正确 |
| live 流式区 | `StreamingBlock.js:283` | 先 `groupConsecutiveTools` 归一 | ✅ | 正确 |
| 折叠判定 | `useQueryBridge.js:240` / `:285` | ❌ | ✅ | **P2 缺陷** |
| 归并器（真源） | `ProcessGroup.js:328`（`:335` 认 `'tool'`） | 它就是归一器 | 产出 | 正确 |

⇒ **投影器是唯一「直接吃原始 timeline」的消费者**——因为它是纯叶子，不能 require ink 组件树
（现依赖面只有 `wrapCell` + `permissionNotice`，见文件头契约）。这不是它写错的理由，但解释了
为什么它成了唯一的漏网者。

### 1.3 为什么单测全绿（判定面与真源不同形）

`tests/cli/tui/transcriptLines.test.js:57` 喂的是 `{ type: 'tools', tools: [...] }`——
**分组后的形状，真实 timeline 从不产生它**。测试与真源**不同形** ⇒ 恒绿。

这与 `[DESIGN-ARCH-146]` 记的教训同族：**判定面常是一份白名单清单，漏一项＝一类静默漏检**。
此处漏的正是「真源形状」这一项。

### 1.4 探针实测（修复前）

```
① 真源 timeline 直接投影（用户实际所见）
   0 | "我先定位渲染逻辑，用 Grep 检索相关实现文件。"
   1 | ""
   2 | "这轮 14 处，接着往下核对。"
② 先经 ProcessGroup.groupTimeline() 分组后投影（对照）
   2 | "  ✓ Grep(tool_use|toolCall)"
   6 | "  ✓ Read(src/cli/toolDisplay.js)"
--- 不变量（判定面＝工具行形状 /^\s{2}[◆✓✗]\s+名(/）---
① 真源形状下工具行数 : 0  ← 应为 2
② 分组形状下工具行数 : 2  ← 对照，应为 2
结论 : FAIL（工具条目被静默丢弃）        EXIT=1
```

⚠ 探针首版的不变量写成「行里出现 `Grep`/`Read` 字样」，被**合成叙述文本**命中 ⇒ 断言恒真、
报出假的 `PASS`。判定面已收窄为**工具行的形状**（缩进 2 + `◆✓✗` + `名(`）。全文见附录 A。

---

## 2. 设计公理（不可让渡）

1. **投影器必须吃真源形状。** `transcriptLines` 的入参永远是 `query.messages` 的原始 timeline
   （`App.js:5942`/`:6040` 就是这么传的）。「先分组」是调用方的可选优化，不是它的契约。
2. **形状归一化只允许一处实现。** `{type:'tool'}` → `{type:'tools'}` 的归并逻辑只能有一个真源；
   投影器不得为绕过依赖面而自带第二份（否则两条路径会各自漂移）。
3. **纯叶子契约不可破。** `transcriptLines` 零 IO、确定性、绝不抛、**不得 require ink/React 组件树**。
4. **静默跳过是默认危险，但本方案不加门控。** 未知条目类型今天被 `continue` 吞掉；
   `check-tui-gates` 的 token 预算已顶格，**不引入任何新 `KHY_*` 名**——改由**测试钉住形状**（§5 R3/R4）。

---

## 3. 修法

### 3.1 候选 A（推荐）：抽出零依赖归并叶子，投影器消费同一份

```js
// 新增 services/backend/src/cli/tui/timelineGroups.js —— 纯叶子：零 IO、确定性、绝不抛
// 内容＝ ProcessGroup.js:328-350 的 groupConsecutiveTools **原样搬入**（不改逻辑）
function groupConsecutiveTools(timeline) { /* … */ }
module.exports = { groupConsecutiveTools };
```

```js
// ProcessGroup.js：保留同名转发（既有调用点与单测一律不动）
module.exports.groupConsecutiveTools = require('../timelineGroups').groupConsecutiveTools;

// transcriptLines.js：入口一次归一，既有三分支**逐字节不动**
const { groupConsecutiveTools } = require('./timelineGroups');
function _timelineLines(timeline, ctx) {
  for (const e of groupConsecutiveTools(timeline)) { /* 既有 text/thinking/tools 分支不变 */ }
}
```

收益：① 投影器与 ink 路径**同一份分组语义**；② 不破纯叶子契约（新叶子只依赖自己）；
③ 分组形状的输入输出**逐字节不变** ⇒ 对既有测试零风险。

### 3.2 候选 B（否决）：在提交边界把 timeline 存成分组形状

改动真源形状 ⇒ 波及 `tlResolveTool` / `reduceAgentTree` / `liveHeightClamp` / `tailTruncation` /
持久化 `_timeline` 的全部消费者，还要迁移存量会话。归一器已经存在，收益为零。**否决。**

### 3.3 候选 C（降级备选）：`transcriptLines` 内联三行归并

改动最小，但制造**第二份**归并实现（违反公理 2）。仅在不接受新增文件时采用。

### 3.4 分期

| 期 | 内容 | 风险 |
|---|---|---|
| **P0** | 形状归一（候选 A）+ 回归对照测试 | 低（分组形状输出不变） |
| **P2** | `_entryIsFoldable`（`useQueryBridge.js:240`）与 `buildExpansionMessage`（`:285`）同步接受两种形状 | 低（纯判据收窄） |
| **P0-b** | `App.js:5975` 流式投影改为复用投影器的同一纯函数，消掉「提交瞬间形态跳变」 | **中**——它改的是**当前唯一能看见工具**的路径，须独立验收 |
| **P1** | 工具行的**内容**（结果量/耗时/是否升级为多行块） | 边界外，归 `[DESIGN-ARCH-155]`，本方案不裁决 |

---

## 4. 接线清单（B-L2 三步，一次提交只做一步）

| 步 | 动作 | 内容 | 验收 |
|---|---|---|---|
| 1 标记 | 新增纯叶子 + 两处 require 收口 | `timelineGroups.js`；`ProcessGroup` 转发；`transcriptLines` 消费 | `node --test tests/cli/tui/*.test.js` 全绿；`check:tui-gates` 的 token 数**不变**（现查 232） |
| 2 迁移 | 投影器归一 + 折叠判定收口 | `_timelineLines` 入口归一；`_entryIsFoldable` 接受两种形状 | §5 的 R1–R6 全绿，含 R3 双向相等 |
| 3 收口 | P0-b 流式格式统一（可选，独立验收） | `App.js:5975` 复用同一投影函数 | 流式↔提交形态一致；live 区回归对照 |

⚠ **不新增任何 `KHY_*` 门控**：`check-tui-gates` 的唯一 token 数**现查 232 / 上限 227**（HEAD 上即已超限，非本次引入）。
⚠ 新增 1 个 `.js` 文件本身**不增加** token 计数（先例：178 → 179 文件，token 数不变）。

---

## 5. 验证与反例清单

| # | 反例 | 预期 | 当前实测 |
|---|---|---|---|
| **R1** | 真源形状 `[{text},{tool},{tool}]` | 出 2 条工具行 | ❌ **0 条**（探针 FAIL） |
| **R2** | 分组形状 `[{text},{tools:[…]}]` | 仍出工具行（**回归对照**） | ✅ 2 条 |
| **R3** | 同一份数据，两种形状**输出逐字节相等** | 必须相等 | 待补 —— **这正是 P0 的目标断言** |
| **R4** | 未知类型 `{type:'weird'}` | 不崩、不改变既有行数 | 待补（钉住「静默跳过是有意的」） |
| **R5** | 工具与文本交错 | 与 `<Static>` 路径同序 | 待补 |
| **R6** | 折叠判定：仅含工具的回合 | `selectLastFoldableMessage` 非 null | 待补（P2 判据） |

⚠ **R3 必须与 R1 同时存在**：只测 R1（「会出」）不测 R2/R3（「分组形状别退化」），
等于给了一条**可以靠删掉 `'tools'` 分支来通过**的单向断言。

---

## 6. 防呆铁律

| # | 铁律 | 可自动判的判据 |
|---|---|---|
| 1 | 投影器只吃真源形状 | 单测喂的 timeline 必须与 `tlPushTool` 产出的**字面量同形**；断言 R3 双向相等 |
| 2 | 归并只允许一处实现 | `cli/tui/**` 里**归并实现**只有 1 处（`timelineGroups.js`）；其余要么 `require` 它、要么只处理分组形状 |
| 3 | 纯叶子契约不可破 | `transcriptLines.js` 的 require 面不得出现 ink/React（应只命中 `wrapCell` / `permissionNotice` / 新叶子） |
| 4 | 新增 timeline 条目类型必须登记 | §1.2 的表与 `tlPushTool` 的类型字面量**同批更新**；新增类型无消费者分支 ⇒ 测试红 |

---

## 7. 未决问题（需人裁决，本方案不代为决定）

1. **是否接受新增 1 个 `.js`**（候选 A）？不接受则降级候选 C，并接受「两份归并」的漂移风险。
2. **P0-b 是否同批**？它改的是当前唯一能看见工具的路径，建议独立验收。
3. **`App.js:5975` 与 `transcriptLines._toolLines` 的文案/字形分歧**（`●` vs `◆`、`name summary` vs
   `name(summary)`）是缺陷还是 `[DESIGN-ARCH-155]` 有意保留的两态？**归 155 裁决。**
4. **用户说的「工具卡片」到底是哪种形态？** 本方案只保证「工具行存在」。
   若要求多行块 / 可折叠 / 带 ±diff，则属于**承载路径切换**（`KHY_INLINE_TRANSCRIPT=0`，
   或让 Viewport 支持富行），是另一个量级的提案。**需产品裁决。**

---

## 8. 验证状态

**已实测（附可复跑证据）**

- P0 缺陷存在：探针（附录 A）真源形状 **0** 条工具行 / 分组形状 **2** 条，`EXIT=1`。
- 真源形状：`queryBridgeTimeline.js:41-43`。
- 投影器分支表：`transcriptLines.js:186-220`（`:212` 只认 `'tools'`）。
- 默认承载路径：`App.js:215` / `:6087`（默认开）、`:5932` / `:5942` / `:6040`（投影调用点）。
- 测试判定面：`transcriptLines.test.js:57` 只喂分组形状。
- 对照路径正确：`Transcript.js:367`、`StreamingBlock.js:283` 均先归一；`ProcessGroup.js:328/335` 认 `'tool'`。
- 流式手写投影：`App.js:5975-5982`。

**仅主张（本轮未执行真代码验证）**

- **P2**（`_entryIsFoldable` 同族）由读源码得出，**未跑 Ctrl+O 端到端**。
  补测方式：构造 `{ role:'assistant', timeline:[{type:'tool', tool:{…}}] }` 调 `selectLastFoldableMessage`，断言非 null。
- **P0-b** 的「形态跳变」由两处源码对比得出，**未在真终端观察**。

**本轮未做什么（防止被误读为已落地）**

- **未改任何源码**——本文件是提案。
- **未跑全站建站**（`node scripts/docs/build_docs_site.js`）：它会重写 700+ 已跟踪 `.html` 并卷入他人 WIP，
  ⇒ 本文件的 `.html` 孪生件**待生成**。`docs:verify` 未接线到任何门档（仅 `package.json:165` 一个别名），故不阻断。
- **未回写既有漏收录**：`00_INDEX_DESIGN-ARCH-总目录.md` 原称「收录 128 篇」，实际 153 个 `.md`，
  且 147–157 未收录——**只报告，不擅自替他人补**。
- 探针落 `.khyos/diag/`（gitignore）⇒ 不随文档入仓；全文见附录 A，可直接粘贴复跑。

---

## 附录 A：探针全文（可直接粘贴复跑）

```js
'use strict';
// 落点：.khyos/diag/tool-card-projection-probe.js
const path = require('path');
const SB = path.join(__dirname, '..', '..', 'services', 'backend');
const { buildTranscriptLines } = require(path.join(SB, 'src/cli/tui/transcriptLines'));
const ProcessGroup = require(path.join(SB, 'src/cli/tui/ink-components/ProcessGroup'));

const RAW_TIMELINE = [
  { type: 'text', text: '我先定位渲染逻辑，用 Grep 检索相关实现文件。' },
  { type: 'tool', tool: { name: 'Grep', input: { pattern: 'tool_use|toolCall' }, id: 'toolu_01',
      result: { success: true, output: 'src 里 14 处' } } },
  { type: 'text', text: '这轮 14 处，接着往下核对。' },
  { type: 'tool', tool: { name: 'Read', input: { file_path: 'src/cli/toolDisplay.js' }, id: 'toolu_02',
      result: { success: true } } },
];
const msgOf = (timeline) => ({ role: 'assistant', content: '', timeline });

const rawLines = buildTranscriptLines([msgOf(RAW_TIMELINE)], { cols: 80 });
const groupedLines = buildTranscriptLines([msgOf(ProcessGroup.groupTimeline(RAW_TIMELINE))], { cols: 80 });

// ⚠ 判定面必须是**工具行的形状**，不能用「行里出现 Grep/Read 字样」——合成叙述文本里也会出现工具名 ⇒ 断言恒真
const TOOL_ROW_RE = /^\s{2}[◆✓✗]\s+\S+\(/;
const rows = (ls) => ls.filter((l) => TOOL_ROW_RE.test(l));
console.log('① 真源形状工具行数 :', rows(rawLines).length, '（应为 2）');
console.log('② 分组形状工具行数 :', rows(groupedLines).length, '（对照，应为 2）');
process.exit(rows(rawLines).length >= 2 ? 0 : 1);
```

## 附录 B：复现命令

```bash
# 1) 缺陷复现（修复前应 EXIT=1）
node .khyos/diag/tool-card-projection-probe.js; echo "EXIT=$?"

# 2) 现有单测（当前全绿 —— 因为它喂的是分组形状）
cd services/backend && node --test tests/cli/tui/transcriptLines.test.js

# 3) 改动后必跑
node scripts/ci/check-tui-gates.js          # token 数应不变（现查 232；HEAD 上本就超限，勿拿它当回归信号）
node scripts/ci/check-agent-rules.js --changed
```

---

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-26 | 初版提案（含承载路径实证、真源形状 vs 消费面对照表、探针实测输出、P0/P2/P0-b 三处病灶、双向反例清单） |
