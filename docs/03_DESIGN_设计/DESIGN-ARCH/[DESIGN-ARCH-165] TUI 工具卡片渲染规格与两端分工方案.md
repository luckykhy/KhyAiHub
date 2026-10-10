# [DESIGN-ARCH-165] TUI 工具卡片渲染规格与两端分工方案

> 状态：已评审采纳（2026-09-28）。本文是 Ink TUI 工具卡片的**渲染规格单一真源**；
> 措辞真源仍是 `[DESIGN-ARCH-155]`，帧高度账本契约在 `[DESIGN-ARCH-156]`，
> diff 规格在 `[DESIGN-ARCH-157]`——本文不重复它们，只规定「卡片」这一层。

## 1. 背景与现状

Ink TUI 中每个工具调用渲染为一张**圆角边框卡片**（`services/backend/src/cli/tui/ink-components/ToolLines.js`，
卡片 Box 在该文件 `borderStyle: 'round'` 处），渲染管线：

```
toolUseLoopCore.runToolUseLoop（services/tool/toolUseLoopCore.js）
  → toolExecutionEngine 逐工具计时（elapsedMs）
  → onToolCall / onToolResult 回调（签名含 iteration, elapsedMs, toolId）
  → tui/hooks/useQueryBridge.js（pushToolFromLoop / markToolResult）写 timeline
  → ProcessGroup 分组 → ToolLines.js 每帧渲染
```

该实现是增量演化而成，五态颜色、头行行语法、折叠策略均已成立，但缺一份统一规格；
且卡宽撑满终端，与 `tui/cardLayout.js` 头注释批评询问框/权限框的「框重内容空」同病。
本文收拢规格并规定后续演进方向。

## 2. 卡片状态机与视觉规格

五态状态机（+ 一个视觉修饰态），判定真源 `services/tool/toolOutcomeSeverity`（成败三档）
+ 结果存在性；渲染层只消费，不得自建第二份判定：

| 状态 | 判定 | 字形 | 边框色（`TOOL_CARD_COLOR`） |
|---|---|---|---|
| pending | 无 result 且无 progress | ◆ | yellow |
| running | 无 result（live 中） | ◆ | yellow |
| done | 有 result 且非 err/notice | ✓ | green |
| notice | `result.severity === 'notice'` | •（`NOTICE_GLYPH`） | yellow（`NOTICE_COLOR`） |
| error | `result.isError/is_error/error/success===false` | ✗ | red |
| hover（修饰） | 鼠标悬停 300ms 后 | — | blue（覆盖除 error 外的状态色） |

不变式：

- **颜色优先级**：hover > error > notice > done > running（已实现于 ToolLines 卡片边框色取值处）。
- **notice 不是失败**：走黄 • + 中性说明，不进红色失败通道；真错误必红。
- 错误卡**必须**就地给出原因（`errorText`），权限拒绝须标注「权限被拒绝」——用户永远不该追问「为什么失败」。

## 3. 卡片解剖

```
╭──────────────────────────────────────╮
│ ✓ 读取 src/x.js · 340 行 · 0.2s      │  ← 头行（行语法）
│ ⎿ …stdout 折叠窗…                    │  ← 结果体（按类型二选一）
│   … +N 行 (ctrl+o 展开)              │  ← 诚实折叠页脚
╰──────────────────────────────────────╯
```

### 3.1 头行（措辞真源 `[DESIGN-ARCH-155]`）

行语法 `字形 动词 目标 · 结果量 · 耗时`，四段全由 `cli/toolDisplayLine.js` 单一生产者产出
（`toolVerb` / `toolTarget` / `resultSegment` / `formatToolDuration`）。
取不到动词时回退旧 `名(摘要)` 形态。约束：

- 动词/目标缺省时以显示名补位，「动作 + 目标」永不空档（规则 2.3）；
- 耗时仅在工具/结果携带真实 `durationMs` 时显示，绝不估算补零（诚实原则）；
- 结果量只在结算后出现，从 `result.summary` 派生，缺失才回源 `summarizeToolResultParts`。

### 3.2 结果体类型注册表（目标态，待实施）

现状是 if 链：write-diff（`result._khyWriteDiff` → 红绿 diff）→ shell literal（`⎿` 折叠
stdout）→ 透明体（`toolResultTransparency`）→ 12 行预览。每加一种结果类型要同时改
**渲染、计数孪生（`estimateLiteralRows`）、memo 键** 三处，漏一处即触发高度账本溢出
（`[IMPL-RPT-044]` 同族）。

目标态抽成**有序注册表**，每项成对提供渲染与计数：

```js
// 注册项契约：match → { render, estimate }，二者必须成对登记，缺一即测试失败。
const BODY_RENDERERS = [
  { match: (r) => r._khyWriteDiff,      render: renderWriteDiff,  estimate: estimateWriteDiff },
  { match: isShellResult,               render: renderLiteralOutput, estimate: estimateLiteralOutput },
  { match: shouldRenderTransparentBody, render: renderLiteralOutput, estimate: estimateLiteralOutput },
  // 兜底：collapsed 摘要 1 行 / expanded 12 行预览
];
```

`estimate` 是渲染的**计数孪生**：计数分支镜像渲染分支逐行（同 memo、同折叠、同标记行），
喂给 live 区高度预算（`toolEntryRows` → `liveHeightClamp.toolCostOf`）。
「任何新结果体必须同时补计数分支」由注册表结构强制，而非注释约定。

### 3.3 运行中进度行（staged transparency）

运行中（`live && t.progress`）在 ◆ 行下渲染 `↳ 阶段说明`；结果落地后该行消失，
卡片翻转为 ✓/✗ + 结果体。已提交（committed）的行永远有结果，不出现进度行。

## 4. 排版规格

复用 `tui/cardLayout.js` 三原则（该叶子是浮层卡片排版 SSOT）：

1. **卡宽贴合内容**：卡宽 = `min(最宽行, 可用宽)`，不再撑满终端
   （目标态：Ink 侧 `alignSelf: 'flex-start'` 或量宽后定宽；门控 `KHY_TOOL_CARD_FIT_WIDTH`，默认关起步）；
2. **一行一格 + 列对齐**：CJK 按显示列计（宽度真源 `utils/text/width.js` 的 `displayWidth`）；
3. **右对齐尾注**：耗时/键位贴右边界，头行裁到 `width − 尾注 − TAIL_GAP`，任何行不超宽。

**宽度收窄与高度账本的联动约束**：折叠态行的 clip 预算目前按
`cols − gutter`（`diffClipWidth`）计算；卡宽收窄后内容列预算须改为 `卡宽 − 4`
（`BOX_CHROME_COLS`），否则 CJK 长行在窄卡内软换行、视觉行数超出 `estimateLiteralRows`
按 1 源行 = 1 视觉行的计费——反阶梯纪律被破。即：**改卡宽必须同步改 clip 预算与
（若计费口径受影响）计数孪生**，三者一个提交内完成。

## 5. 两端分工

| 端 | 形态 | 理由 |
|---|---|---|
| Ink TUI | 边框卡片（本文规格） | 有交互（点击/hover/Ctrl+O），ink 每帧 diff 重绘 |
| 经典 readline REPL | 单行动词句（`printStepLine`）+ spinner | readline 下画边框须人工记账光标，违背 `RUNTIME-004` 的低成本路径；且无鼠标交互能力 |

共享面**只保留**两份 SSOT：`cli/toolDisplayLine.js`（措辞）与
`services/tool/toolOutcomeSeverity.js`（成败三档）。禁止在任何一端再写第二份动词表、
颜色表或结果量拆分（`[DESIGN-ARCH-155]` §3 R6 同旨）。

## 6. 交互规格

| 交互 | 行为 |
|---|---|
| 单卡点击 | 切换该卡展开态（`toolExpanded` Map，独立于全局 Ctrl+O）；错误卡点击走 `onErrorClick` 跳侧栏 |
| Ctrl+O | 全局展开：折叠窗 → 全貌（诚实展开：`diffClipWidth` → Infinity，整行交 ink 换行，绝不静默丢尾） |
| hover | 300ms 延迟显示参数预览，边框变蓝；门控 `KHY_MOUSE_HOVER` |
| 折叠页脚 | `… +N 行 (ctrl+o 展开)` 是**独立 dim 行**，不静默丢内容；截断须带真实计数 `[已截断 shown/total 字]` 与原因 |

## 7. 门控与回退

本文所有增量改动沿用仓库惯例：`KHY_*` env 门控 + 门控关时**逐字节回退**到既有输出。
已挂门控：`KHY_TOOL_HEADER_DURATION` / `KHY_TOOL_HEADER_CAP` / `KHY_TOOL_PATH_MIDDLE_TRUNCATE`
/ `KHY_DIFF_CONTENT_WIDTH` / `KHY_TOOL_ERROR_FOLD` / `KHY_RESULT_ELBOW` /
`KHY_TOOL_RESULT_TRANSPARENT` / `KHY_TUI_COMPONENT_MEMO` / `KHY_MOUSE_HOVER`。
新增门控：`KHY_TOOL_CARD_FIT_WIDTH`（卡宽贴合内容，默认关）。

本方案不新增任何拦截型机制，不涉及 `PROCESS-008` 升阶。

## 8. 实施顺序与验收判据

1. **缺陷修复（已完成，2026-09-28）**：`ToolLines.js` agentTree 分支在 `isNotice`
   声明前引用它（TDZ ReferenceError），带 `_agentTree` 的工具卡渲染即崩帧。
   修复：把 `done` / `isErr` / `isNotice` 上提到分支前统一计算；回归测试
   `tests/tui/toolLinesAgentTreeNotice.test.js`（修复前该测试以 ReferenceError 失败）。
2. **卡宽贴合内容**（§4.1，门控起步默认关）。
3. **结果体类型注册表**（§3.2，纯内部重构，配合计数孪生成对测试）。

验收判据：

- 修复前失败的回归测试转绿；`tests/tui/` 全部 toolLines* 测试不回退；
- 头行措辞一字不改（`[DESIGN-ARCH-155]` 单测锁定）；
- 任何结果体新增时，`estimate` 与 `render` 必须来自同一注册项（结构强制）；
- 经典 REPL 输出逐字节不变（两端分工的回归面）。

## 9. 关联文件索引

| 角色 | 文件 |
|---|---|
| 卡片渲染体 | `services/backend/src/cli/tui/ink-components/ToolLines.js` |
| 子代理树渲染 | `services/backend/src/cli/tui/ink-components/AgentTree.js` |
| 排版 SSOT | `services/backend/src/cli/tui/cardLayout.js` |
| 行语法 SSOT | `services/backend/src/cli/toolDisplayLine.js` |
| 成败三档 SSOT | `services/backend/src/services/tool/toolOutcomeSeverity.js` |
| 宽度 SSOT | `services/backend/src/utils/text/width.js` |
| 事件桥 | `services/backend/src/cli/tui/hooks/useQueryBridge.js` |
| 高度账本契约 | `[DESIGN-ARCH-156]`（`estimateLiteralRows` 计数孪生纪律） |
