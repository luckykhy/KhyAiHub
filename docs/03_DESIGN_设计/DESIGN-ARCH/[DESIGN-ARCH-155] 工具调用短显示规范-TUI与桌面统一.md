# [DESIGN-ARCH-155] 工具调用短显示规范——TUI 与桌面统一

> **状态**：提案（待评审，未落码）
> **定位**：本文件管「一次工具调用在界面上**写成哪一行**」，是 TUI / 经典 REPL / 桌面端 / 网页端四端的显示契约单一真源。
> 布局、行高、键位、门控数量仍以 `[DESIGN-ARCH-102]`（TUI 统一规则手册）为准；外部 agent 向底座上报的三类提示以 `[DESIGN-ARCH-016]` §2 为准（边界见 §0.2）。
> **范围**：`services/backend/src/cli/toolResultSummary.js`、新增 `services/backend/src/cli/toolDisplayLine.js`、`services/backend/src/cli/tui/ink-components/{ToolLines,ProcessGroup}.js`、`services/backend/src/cli/repl/displayFormatters.js`、`services/backend/src/services/aiManagementChatHttp.js`、`apps/khyos-desktop/src/{host,renderer}/**`、`apps/ai-frontend/src/views/**`
> **上游依赖**：零新增依赖、零新增 env 门控；复用既有单一真源（`toolResultSummary` / `renderTheme` / `toolParamPath` / `toolHeaderCap` / `agentStatLine`）
> **调研指针**：`[DESIGN-ARCH-152]`（桌面端工具卡片接线：本规范定其**显示形态**，152 定其**数据通路**）、`[DESIGN-ARCH-151]`（TUI 思维链折叠，同为「减负」族）、`[DESIGN-ARCH-102]`（H7 门控预算）
> **模板合规**：非借鉴类改动，B-P2 七字段按体例「不适用」——依据：全文只复用本仓既有模块（`toolResultSummary` / `renderTheme` / `statusLiveActivity` / `toolParamPath` / `toolHeaderCap`）与既有事件协议，无外部项目、代码或设计稿借鉴。
> **篇幅说明**：224 行，超 `[DESIGN-DOC-001]` §12 的 150 行预算。依据同族先例（`152` 184 行、`154` 215 行）按例外处理：四端映射表、事件契约与验收命令必须与契约同篇才可判定，拆子篇会割裂「一行语法 ↔ 各端落点」的对应关系。

---

## 0. 一句话结论

「短」不是把字改小，是把一次工具调用压成**一行动词句**：`符 动作 目标 · 结果量 · 耗时`。
今天四个端各写各的：TUI/REPL 用两行（头行 `✓ 读取(x.js) (0.2s)` + 第二行 `⎿ 已读取 x.js（340 行）`），桌面用卡片（状态点 + 原始工具名 + `运行中/完成/失败`，展开是原始 JSON），网页端用一行但工具名是原始 id（`grep`），khyquant 前端直接丢弃工具事件。唯一真源（`toolResultSummary.summarizeToolResult`，`toolResultSummary.js:446`）只供到 TUI/REPL 与网页端；桌面 host 明明收到了 `elapsed`（`host/index.ts:430`），却丢在 slice 里（`toolExecutionSlice.ts` 的 `updateToolExecution` 只收 `status/result/error`）。
本规范做两件事：把行语法**冻结**为跨端契约；把**唯一的行生产函数**接到各端——GUI 端不新增任何判断逻辑，只渲染后端给的字符串。

### 0.1 四条判据（「直观 + 简洁」的可检验定义）

| 判据 | 含义 | 检验方式 |
|---|---|---|
| 一眼成句 | 状态 + 动作 + 目标 + 结果量 + 代价齐全 | 遮住上下文单独贴出该行，人能说出「做了什么、成不成、多大、多久」 |
| 一行即答案 | 常见路径（读取/搜索/编辑/执行）**一行**给全结论，无需展开、无需第二行 | 默认视图行数 = 工具调用数；成组时 = 1 |
| 跨端同形 | 同一次调用在 TUI 与桌面**去色后逐字节相等** | 快照比对（§7） |
| 可复制 | 该行粘进对话/issue 后仍成句，语义不依赖图标与颜色 | 纯文本渲染检查（无 emoji、无仅靠颜色承载的信息） |

### 0.2 作用域边界（与 016 不冲突）

- 本规范管**本机 agent 自身的工具调用**（CLI / 桌面 / 网页对话流里「助手在做什么」）。
- 外部 agent（如 khyquant 交易 agent）向底座上报的三类提示仍以 `[DESIGN-ARCH-016]` §2 为准——那里明写「不应逐条罗列工具调用」。两条互补：**插件上报要折叠，本机工具行要成句**。
- 本规范**只改「一行内写什么」**，不改行高、滚动、鼠标、键位——那些是 `[DESIGN-ARCH-102]` 的地盘。

### 0.3 病灶总表

| # | 病灶 | 位置（file:line） | 后果 |
|---|------|------------------|------|
| Z1 | 结果量另起一行：头行 `✓ 读取(x.js) (0.2s)`、第二行 `⎿ 已读取 x.js（340 行）` | `tui/ink-components/ToolLines.js:1173-1191`（头行）、`:1324-1330`（`⎿` 行） | 常见路径 2 行/工具，垂直空间翻倍；「多大」不在头行 |
| Z2 | 经典 REPL 的工具进度/完成标签是**英文字面量**（`Reading file` / `Ran command` / `Explored`） | `cli/repl/displayFormatters.js:133-237`，消费点 `cli/replSession.js:9369,9440,11746,11924` | 中文界面里冒出英文短语，与仓库「面向用户字符串用中文」策略冲突，也与 TUI 中文动词不同源 |
| Z3 | 桌面卡片只有状态词、没有动作句：`● {原始工具名}` + `运行中/完成/失败`，`ToolExecution` 丢弃 `elapsed` | `renderer/components/message/MessageBubble.tsx:199-236`；`renderer/state/toolExecutionSlice.ts`；`host/index.ts:430-441` | 违反 `RUNTIME-002`（状态须含动作+目标+进度）：用户不知道**对什么**动手、**多大**、**多久** |
| Z4 | 桌面状态字形用 emoji（`…✱✓✗`） | `MessageBubble.tsx:203-206` | 宽度不定、跨平台字形不同、纯文本粘贴不成句——阻断「一行跨端同形」 |
| Z5 | 网页端工具名是原始 id（`grep`/`read`），不是中文动词；进度行是 `工具 2/3 · 1 进行中 · 1 失败` 这类计数句 | `apps/ai-frontend/src/views/AIChat.vue`（step 行）、`views/aiChatEventUtils.js:249-272` | 同一调用在 TUI 说「搜索」、在网页说「grep」，用户每次重新学 |
| Z6 | 网页端结果量在 240 字处**硬截断**（非折叠） | `services/aiManagementChatHttp.js:211` | 信息被砍掉而非收进详情；超长结果永远看不全 |
| Z7 | 仓内已有**四张**互不引用的工具名/动词表 | `renderTheme.js:211-238`（显示名）、`repl/statusLiveActivity.js`（中文动词）、`tui/ink-components/ProcessGroup.js`（动作类别）、`tui/utils/ccToolFormat.js`（参数摘要） | 任何新端都要第五次抄表，漂移源 |
| Z8 | khyquant 前端丢弃工具事件，聊天里看不到任何工具调用 | `software/khyquant/frontend/src/composables/useStreamChat.js`（`tool_use`/`tool_result` 落到 switch 外） | 垂直应用里「AI 在做什么」不可见 |

---

## 1. 行语法（唯一真源，四端共用）

```
<符> <动作> <目标>[ · <结果量>][ · <耗时>]
```

| 位 | 取值 | 真源 |
|---|---|---|
| 符 | `◆` 运行中 / `✓` 成功 / `✗` 失败 | `ToolLines.js:1122-1123`（`done/isErr` 判定） |
| 动作 | 十一类中文动词：读取 / 写入 / 编辑 / 搜索 / 查找 / 执行 / 联网搜索 / 抓取 / 派发 / 列出 / 更新 | 本规范定义；实现收敛为**一张**表（见 §3 R6） |
| 目标 | 工具入参里最能标识「对什么动手」的值：`command` → `file_path`/`path` → `pattern` → `query` → `url` → `description` → `prompt` | `repl/statusLiveActivity.js` 的提取顺序（规则 2.3 落地实现） |
| 结果量 | 量词片段，如 `340 行` / `12 个匹配，跨 3 个文件` / `3 处替换（+12/−5）` / `84 行 [退出码 1]` | `toolResultSummary.summarizeToolResult`（`toolResultSummary.js:446`）的 `quantity` 部分 |
| 耗时 | 真实耗时：`<1s → 45ms`、`<60s → 1.2s`、`≥60s → 2m 15s`；**缺失即不显示，绝不估算/补零** | `ToolLines.formatToolDuration` / `agentStatLine.toolDurationLabelOr` |
| 分隔符 | 统一 ` · `（空格 + U+00B7 + 空格） | 本规范；两端字符级一致才可跨端比对 |

### 1.1 四级形态

| 级 | 何时出现 | 形态 | 示例 |
|---|---|---|---|
| **L1 单工具行** | 默认，唯一必需 | `<符> <动作> <目标> · <结果量> · <耗时>` | `✓ 读取 src/cli/router.js · 340 行 · 0.2s` |
| **L0 组行** | 连续 ≥2 个同批工具，替代 N 条 L1 | `<符> <动作序列> <目标(唯一时)> · <N> 步[ · <失败数>]` | `✓ 读取 + 编辑 server.js · 2 步` · `✗ 执行 + 读取 · 4 步 · 1 失败` |
| **L2 详情** | 用户显式展开（TUI `ctrl+o`/点击；GUI「详情」） | 参数（脱敏，≤4000 字）/ 输出体（折叠 ≤10 行 + `… +N 行`）/ diff（`+a/−b`） | 见 §2 |
| **L3 失败行** | 失败时**必随** L1 出现 | `⎿ <问题>：<原因>，<修复建议>`（≤1 行 + 可展开） | `⎿ 未找到文件：路径不存在，请检查 src/x.js 是否存在` |

**关键压缩动作**：把结果量从第二行**上提**到头行，`⎿` 只保留给「有正文」（输出体 / diff / 失败原因）。常见路径（读取/搜索/编辑）由 2 行降为 1 行。

### 1.2 量词片段的产法（不新增第二份措辞）

`summarizeToolResult` 今天产出整句：`已读取 router.js（340 行）`。规范要求它在**不改变整句字节**的前提下同时给出结构：

```
summarizeToolResultParts(toolName, result, params) → { claim, quantity, full }
  claim    = '已读取 router.js'      // 供「目标不在行内」的场合（L0、提示、日志）使用
  quantity = '340 行'                // 供 L1 使用
  full     = '已读取 router.js（340 行）'  // 逐字节等于既有 summarizeToolResult 输出
```

- L1 的结果量 = `quantity`；`quantity` 为空（如 `网络搜索完成`）时该段整体省略；
- 目标取不到（无法提取入参）时，L1 回退显示 `claim` —— 宁可有句无标，不出现「动作 + 空白」；
- **禁止**任何端自行拼接结果措辞（§3 R1）。

### 1.3 宽度与截断预算

| 端 | 行预算 | 牺牲顺序（先牺牲谁） |
|---|---|---|
| TUI / REPL | ≤ `effectiveCols - 2` 显示宽度，单行 | 目标截断（`relative` + 中间截断，保 basename）→ 结果量丢弃 → 耗时丢弃 |
| 桌面 / 网页 | 单行 `truncate` + `title` 悬浮全文；卡宽 ≤ 92%（桌面）、≤ 100%（网页气泡内） | 同上；被丢弃的部分必须能在 L2 看到 |

- **动作与状态符永不截断**（截断后就不成句）；
- 目标上限沿用既有真源：`toolParamPath.formatToolHeaderPath`（相对化 + 中间截断，默认 60）、命令按 `toolHeaderCap.argDisplayCap`（Bash 160，其余 60）；
- 中文按**显示宽度**计算（`cli/formatters.displayWidth`），不得按 `String.length`。

---

## 2. 目标形态：四端映射（反例 → 正例）

| 端 | 反例（现状） | 正例（本规范） | 落点 |
|---|---|---|---|
| TUI | `✓ 读取(src/cli/router.js) (0.2s)`<br>`⎿ 已读取 router.js（340 行）` | `✓ 读取 src/cli/router.js · 340 行 · 0.2s`（一行；有输出体时才出现 `⎿`） | `ToolLines.js` 头行 + 结果量上提 |
| TUI 组行 | `读取 · 编辑 server.js  ✓2` | `✓ 读取 + 编辑 server.js · 2 步` | `ProcessGroup.js` 头行 |
| 经典 REPL | `● Reading file src/x.js` / `● Ran command` | `● 读取 src/x.js` / `✓ 执行 npm test · 84 行 [退出码 1] · 12.4s` | `displayFormatters.js`（英→中，接同一函数） |
| 桌面端 | `● read` + `完成` + 展开是原始 JSON | `✓ 读取 src/cli/router.js · 340 行 · 0.2s` + 「详情 ▼」 | `MessageBubble.tsx` 换 `ToolLine`；`ToolExecution` 补 `durationMs` |
| 网页端 | el-icon + `grep` + input(120) → `执行成功` + text(≤240 截断) | 同 L1 行；超长结果折进「详情」而非截断 | `AIChat.vue` step 行；`aiManagementChatHttp.js` 补 `durationMs` + `display` |
| khyquant 前端 | 无（事件被丢弃） | 二期：接同一渲染；一期可显式记为「不支持」 | `useStreamChat.js`（二期） |

**L2 契约（三端同一口径）**：参数走同一脱敏函数（网页端已有 `formatToolParams` + `maskSecretsForDisplay`）→ 输出体折叠 ≤10 行 + `… +N 行` 尾注 → diff 用 `+a/−b`（`cli/editStatLine`）。默认视图**禁止**出现原始 JSON（触 `[DESIGN-ARCH-016]` §4 R5）。

---

## 3. 红线（一行一条，可直接判违规）

| # | 红线 |
|---|---|
| R1 | 禁止任何端自行拼接工具措辞/结果措辞；动作、目标、结果量、耗时四个位都必须来自单一真源产出 |
| R2 | 禁止 emoji 或图标字体承载状态语义；状态字形只用 `◆ ✓ ✗`，色仅作增强（去色后信息不丢） |
| R3 | 禁止默认视图出现原始 JSON、裸 `{}`、堆栈、内部 id |
| R4 | 失败必须给原因与修复建议（L3 行随 L1 出现）；禁止裸 `✗`、禁止只写「失败」 |
| R5 | 禁止在默认视图出现「动作 + 目标 + 进度」三缺一的状态词（`运行中` / `执行成功` / `完成` 单独出现即违规，触 `RUNTIME-002`） |
| R6 | 禁止新增第五张工具名/动词表；实现期把现有四张（`renderTheme` / `statusLiveActivity` / `ProcessGroup` / `ccToolFormat`）收敛为一张，其余改为委派 |
| R7 | 禁止用不可靠聚合充当信息（如「工具耗时合计」）；L0 只显示步数、失败数与可选组墙钟 |
| R8 | 不新增 env 门控（显示契约变更无灰度开关，靠分期与 revert；守 `[DESIGN-ARCH-102]` H7 门控预算） |

---

## 4. 反模式（这条路别走）

| # | 别走 | 原因 |
|---|---|---|
| A1 | 各端各自发明措辞 | 同一调用四种说法（今天 Z3/Z5 的病根），用户每次重新学 |
| A2 | 为「短」砍掉失败原因 | 违反 R4 与规则 2.2（错误消息须含问题+原因+修复） |
| A3 | 超长结果硬截断（网页端 240 字现状） | 应折叠进 L2，而非砍掉；截断要留「… +N 行」真实计数 |
| A4 | 用「更短」当借口删掉耗时 | 耗时是「多贵」的答案，是 L1 的必要位 |
| A5 | 在此规范里顺手改布局/键位/行高 | 越界到 `[DESIGN-ARCH-102]`，会造成两份冲突的规则真源 |

---

## 5. 事件契约（GUI 端拿什么）

GUI 端**不推导**任何显示文本，事件里直接带结果：

```
tool_result: { type, tool, id, success, text, durationMs, display: { glyph, verb, target, quantity, durationText, line } }
tool_use   : { type, tool, id, input, display: { glyph:'◆', verb, target, line } }
```

| 端 | 已有 | 缺 | 改动量 |
|---|---|---|---|
| 网页 SSE（`aiManagementChatHttp.js:364-389`） | `text` 已走 `summarizeToolResult`（`:180-212`） | `durationMs`、`display` | 小 |
| 桌面 IPC（`host/index.ts:428-441`） | `elapsed`、`affectedFiles` 已在事件里 | `display`；slice 与渲染丢弃 `elapsed` | 小 |
| 桌面渲染 | `ToolCallCard` 组件齐全 | 换成 L1 行组件 | 中 |
| khyquant 前端 | — | 事件消费 | 二期 |

后端唯一新增：`services/backend/src/cli/toolDisplayLine.js`（纯函数 `describeToolLine({ name, input, result, durationMs })`），内部组合 §1 的四个位；`toolResultSummary` 增加 `summarizeToolResultParts`（`full` 逐字节不变，既有断言零回归即护栏）。

---

## 6. 实施分期（每期独立可回滚）

| 期 | 内容 | 回滚 |
|---|---|---|
| P1 | `toolResultSummary` 增 `parts` + 新增 `toolDisplayLine.js` + 单测（零 UI 影响） | 纯新增导出，删除即回现状 |
| P2 | TUI 接上：头行换语法、结果量上提、组行统一 | 组件级 revert |
| P3 | 经典 REPL 接同一函数（顺带把 Z2 的英文标签改正为中文） | 同上 |
| P4 | 事件契约补 `durationMs` + `display`（向后兼容，老前端忽略新字段） | 删字段 |
| P5 | 桌面换 `ToolLine`；网页端 step 行与进度行换语法；khyquant 前端可选 | 各端独立 revert |

P2/P3 只依赖 P1；P5 依赖 P1+P4。P4 可与 P2 并行。

---

## 7. 验收方式

```bash
# 1) 行生产函数（新）
node --test services/backend/tests/cli/toolDisplayLine.test.js
# 2) 既有结果摘要零回归（full 必须逐字节不变）
node --test services/backend/tests/cli/toolResultSummary.test.js
# 3) 跨端一致性（新）：同一入参下，TUI 头行字符串 == 事件 display.line 字符串
node --test services/backend/tests/services/toolEventDisplayPayload.test.js
# 4) 规则体检（状态透明 / 硬编码 / 超时）
node scripts/ci/check-agent-rules.js --changed
```

**肉眼验收（TUI）**：`npm run cli` 后触发 read / grep / edit / bash 各一次，期望每个工具 1 行、结果量在行内、耗时在行尾、除「有正文」外不出现第二行 `⎿`。
**肉眼验收（桌面）**：同一次会话里工具行与 TUI 行**去色后逐字节相等**。

---

## 8. 诚实边界（刻意不纳入）

- 不改工具循环与事件语义（只**增加**显示字段），不改 `[DESIGN-ARCH-016]` 管的插件上报路径；
- 不新增规则 ID：本契约靠单测 + 一致性测试 + 既有 `check-agent-rules`（规则 2）兜底，不由 rules-gate 拦截（规则棘轮 94 条已满，新增一条须先退役一条）；
- 不拍板 khyquant 前端是否接入（二期决策）；
- 不做主题化字形（Khy 主题只换色，不换字形）；
- 不改 TUI 行高/滚动/键位（真源 `[DESIGN-ARCH-102]`）；
- 不做「工具耗时合计」等不可靠聚合。

---

## 9. 待核实项

| # | 待核实 | 为什么重要 |
|---|---|---|
| V1 | TUI 展开态参数是否已在上游脱敏（`ToolLines.js:1198-1211` 直接 `JSON.stringify(t.input)`，未见脱敏调用；网页端有 `maskSecretsForDisplay`） | 若未脱敏，展开态会把 API key 显示在终端里——本规范落地时应一并接同一脱敏函数 |
| V2 | `summarizeToolResult` 的整句模板能否**全部**拆出 `claim/quantity` 而不改字节（如 `命令输出 84 行 [退出码 1]` 的拆法） | 决定 §1.2 的改动面；拆不出的模板按「quantity 为空」降级即可，不得改整句 |
| V3 | 桌面 `elapsed` 的单位（ms 还是秒） | `host/index.ts:430` 只给变量名；单位错会让 `0.2s` 变成 `0.0002s` |
| V4 | 网页端 `steps` 与桌面 `toolCalls` 的字段名统一（`text` vs `result`、`tool` vs `name`） | P4/P5 的映射表要逐字段写死，避免第三个方言 |

---

## 10. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-09-26 | 首版：行语法、四级形态、四端映射、8 条红线、5 期实施与验收（提案，未落码） |
