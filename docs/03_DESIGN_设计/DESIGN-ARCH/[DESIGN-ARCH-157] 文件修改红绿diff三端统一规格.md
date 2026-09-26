# [DESIGN-ARCH-157] 文件修改红绿 diff 三端统一规格

> **状态**：已采纳（2026-09-26 用户确认「先设计成文档，然后开始实施」；两项视觉裁决见 §2）
> **定位**：本文件管「一次文件修改的红/绿 diff 在界面上**长什么样**」，是 TUI 工具卡片 / 经典 REPL 回显 / 审批框预览 / `ui/diffViewer` 四个消费面的视觉契约单一真源。
> 「一行的头行怎么写」以 `[DESIGN-ARCH-155]` 为准（本规范只管 diff 详情体，即其 L2 层的 ±行部分）；TUI 布局/键位/门控数量仍以 `[DESIGN-ARCH-102]` 为准。
> **范围**：新增 `services/backend/src/cli/diffSpec.js`、新增 `services/backend/src/cli/writeDiffRows.js`、修改 `cli/tui/ink-components/ToolLines.js`、`cli/repl/toolOutputRender.js`、`cli/diffRenderer.js`、`cli/aiRenderer.js`、`cli/ui/diffViewer.js`、`services/editDiffPreview.js`（仅引用改路径）
> **上游依赖**：零新增第三方依赖；复用既有叶子 `diffGutter.js` / `previewOverflowMarker.js` / `editStatLine.js` / `wordDiff.js` / themeRegistry。
> **模板合规**：非借鉴类改动，B-P2 七字段按体例「不适用」——全文只复用本仓既有模块，无外部项目借鉴。
> **篇幅说明**：约 150 行，在 `[DESIGN-DOC-001]` §12 预算内。

---

## 0. 一句话结论

diff 的**计算**早已统一（`diffRenderer.computeStructuredDiffHunks` 是 LCS/hunk/±计数的唯一引擎），但 diff 的**画法**散在四份实现里：颜色有 5 份真源、折叠账本两份、gutter 基准两套、词级高亮三种默认值、色条宽度两种形态。本规范把「画法」收敛为：**一张 token 表（`diffSpec.js`）+ 一份行模型（`writeDiffRows.js`）+ 两个薄渲染器（ink / chalk）**，四端消费同一 rows，只保留渲染技术差异。

### 0.1 病灶总表（实测 file:line，非推测）

| # | 病灶 | 位置 | 后果 |
|---|------|------|------|
| D1 | 颜色 5 份真源：主题 JSON 有完整 diff 色板（`diffAdded`/`diffRemoved`/`diffAddedWord`/`diffRemovedWord`），但其余各端各自为政 | `cli/themes/*.json`（正源）；`cli/aiRenderer.js:17-20`（THEME 字面量）；`cli/repl/toolOutputRender.js:77,100`（裸写 `#225C2B`/`#7A2936`，完全绕过主题系统）；`ToolLines.js`（`DIFF_ADD_BG`/`DIFF_DEL_BG`/`*_WORD_BG` 常量）；`cli/ui/diffViewer.js:276-279`（又一份消费） | 切 solarized/ocean/sunset 主题时三端漂移：REPL 预览永不换色，TUI 与 diffViewer 换色不同步 |
| D2 | 行模型只有 TUI 有 | `buildWriteDiffRows`/`buildShellDiffRows` 住在 `ToolLines.js:406,540`；REPL 的 `maybeRenderWriteDiff`（`toolOutputRender.js:20-117`）自己另实现新建/删除文件三分支 | 每条规则要改两处；审批框（`editDiffPreview` → ToolLines）与 REPL 无法共享判断 |
| D3 | 折叠账本不一致 | shell unified diff：TUI `MAX_DIFF_ROWS_COLLAPSED=60`（`ToolLines.js:370`）vs REPL 硬编码 120（`toolOutputRender.js:140`） | 同一段 `git diff` 输出两端看到的行数不同 |
| D4 | gutter 位宽基准不一致 | TUI 按**全部行**最大行号算（`computeDiffGutterWidth(rows)`）；REPL 新建文件预览按**已显示行**算（`toolOutputRender.js:74` `computeDiffGutterWidthForMax(shown.length)`） | 11 行以上的新建文件预览，两端缩进宽度不同 |
| D5 | 词级高亮三端三种状态 | 经典 shell 路径默认**开**（`diffRenderer.renderDiff:311`）；经典结构化路径**故意不做**（`_emitChangeBlock:375-380` 注释「先红后绿不配对」）；TUI 默认**关**（`KHY_TUI_WORD_DIFF`，`ToolLines.js:614-619`） | 同一处「改一行里两个词」在不同路径观感完全不同，且无统一开关 |
| D6 | 色条宽度两种形态 | chalk 端 `_padToFull` 铺整行满宽背景；ink 端背景只铺到文字宽度 | 两终端并排对比时 diff 体明显不同形 |

---

## 1. 规格架构（唯一真源）

```
diffSpec.js（新纯叶子，绝不抛）
 ├─ COLORS(env)      → { add, addWord, del, delWord, ctx, hint, text }  ← themeRegistry 唯一入口，缺省 = CC 值
 ├─ FOLD             → { preview: 10, diffCollapsed: 60, expanded: Infinity }
 ├─ GUTTER 规则      → 一律按全部行的最大行号（复用 diffGutter.computeDiffGutterWidth）
 └─ GRAMMAR          → add/del: `${num} ${sign} ${text}`（满宽色条）；ctx: `${num}   ${text}`（dim）；
                       间隙: `⋯ N unchanged lines`（dim）；统计: `└ …`（editStatLine 真源不变）
        │
writeDiffRows.js（buildWriteDiffRows / buildShellDiffRows / planWordDiffPairs 从 ToolLines 下移，签名不变）
        │
 ├─ ToolLines.renderDiffRows(ink)         ← TUI 卡片 + 审批框（PermissionsPrompt 经 editDiffPreview 复用，引用改路径）
 ├─ diffRenderer.renderDiffRowsChalk(rows)← 经典 REPL maybeRenderWriteDiff 改消费 rows（新函数）
 └─ ui/diffViewer.js                      ← 改读 COLORS
```

**不变量**：`computeStructuredDiffHunks` 仍是计算引擎唯一真源（本规范不动它）；`rows` 数组（`{kind:'add'|'del'|'ctx'|'meta'|'more'|'stat', num, text}`）是跨端契约形状，渲染器不得在内部再算折叠/再算 gutter。

### 1.2 主门控与回退

| 门控 | 默认 | 语义 |
|------|------|------|
| `KHY_DIFF_SPEC_V1` | 开 | 总闸：关 → A/B/C 三刀逐字节回退现状（旧裸 hex、旧三分支、旧 120 行账本原样保留为 fallback 分支） |
| `KHY_DIFF_WORD_HIGHLIGHT` | 开 | 词级高亮三端统一开关；旧名 `KHY_TUI_WORD_DIFF` 继续解析（旧名显式 `0` 在 TUI 侧仍生效，兼容既有排障手册），新名对三端同时生效 |

---

## 2. 两项视觉裁决（用户 2026-09-26 选定）

1. **词级高亮全端默认开**：删改一行时只亮真正变化的词（`diffAddedWord`/`diffRemovedWord` 亮底），其余用行底色。配对逻辑唯一真源 `planWordDiffPairs`（del 连段紧邻 add 连段 1:1 配对，`wordLevel` 不达标退回整行色）；经典结构化路径的「先红后绿不配对」行为改为门控关时的字节回退档。
2. **整行满宽色条**：红/绿行背景铺到终端右缘。chalk 端维持 `_padToFull`；ink 端在 `renderDiffRows` 对 add/del 行按 `clipW − displayWidth(body)` 补背景空格（展开态 wrap 由 ink 背景自然延续）。

---

## 3. 实施四刀（每刀独立可回退，顺序 A→B→C，D 可并行）

| 刀 | 内容 | 触及 | 验收 |
|---|------|------|------|
| **A 颜色** | 建 `diffSpec.js`；5 处色来源改读 `COLORS(env)`；REPL 预览分支顺带获得主题感知 | diffSpec(新) + toolOutputRender / ToolLines / aiRenderer / diffViewer | 切 ocean 主题，三端 diff 底色一致；`KHY_DIFF_SPEC_V1=0` 全端逐字节现状 |
| **B 行模型** | `buildWriteDiffRows`/`buildShellDiffRows`/`planWordDiffPairs` 及折叠常量下移至 `writeDiffRows.js`；ToolLines 与 editDiffPreview 改 require；REPL `maybeRenderWriteDiff` 三分支改「取 rows → `renderDiffRowsChalk`」 | writeDiffRows(新) / ToolLines / toolOutputRender / diffRenderer | D2/D4 消失：rows 同源；`tests/writeDiff.test.js` 全绿；⚠ 动工前确认 `ToolLines.js` 工作区干净（#7 在途 god-file 家族，不与作者重构抢刀） |
| **C 折叠** | `FOLD` 账本进 diffSpec；REPL shell diff 120→60；gutter 统一全行基准 | diffSpec / toolOutputRender / ToolLines | 同输入两端折叠行数相等（D3/D4） |
| **D 视觉** | 词级高亮统一开关全端开 + ink 满宽色条 | ToolLines / diffRenderer / wordDiff 接线 | 同一 before/after 截图级同形（D5/D6） |

### 3.1 守卫（S1 观察者档起步，遵守 `PROCESS-008`）

| 守卫 | 内容 |
|------|------|
| 跨端等价测试 | 同一 `_khyWriteDiff` 输入，断言 ink 与 chalk 渲染器消费的 rows 逐条相等（含新建/删除/编辑三分支、多 hunk、溢出标记） |
| 色字面量检查 | `scripts/ci/` 新增检查：diff 色 hex 字面量只许出现在 `diffSpec.js` 与 `cli/themes/`，命中他处报 finding；**登记 FEATURE-OWNERSHIP.json 为 S1，只记录不阻断** |
| 回归 | 既有 `writeDiff.test.js` / `editDiffPreview.test.js` / `displayFormatters.test.js` / `ccMessageProjection` 系列必须全绿；`node scripts/ci/check-agent-rules.js --changed` 零新增 error |

---

## 4. 非目标（本轮不做）

- 不动 `computeStructuredDiffHunks` 的算法/hunk 合并策略；
- 不做「独立全屏 diff 视图」（现有 ctrl+o 展开 + 转录视图已承载，另立议题）；
- 不改头行语法（`✓ 编辑 x.js · 3 处替换 · 1.2s` 属 `[DESIGN-ARCH-155]` 地盘）；
- 不动 `_khyWriteDiff` 的采集链路（`_finalizeWriteDiff` 属在途重构 #7 区，不碰）。

## 5. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-09-26 | 初版：病灶 D1–D6 实测登记；四刀方案；词级高亮全端开 + 满宽色条两项裁决采纳 |
