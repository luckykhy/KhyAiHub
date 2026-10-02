> 状态：提案（待确认后实施）｜范围：`services/backend/src/cli/tui/selection.js`（可选带 `ccMessageProjection.js` 一处）｜上游依赖：无｜调研指针：本文 §1｜模板合规：B-P2 七字段据实声明见 §2

# [DESIGN-ARCH-149] TUI选区复制携带ANSI残留修复方案

## 0. 一句话结论

用户从 TUI 拖选复制出的文本里带着 `\x1b[1m`、`\x1b[38;2;97;175;239m` 这类**着色转义序列**（粘贴后 ESC 字节被接收方丢弃，只剩 `[1m`、`[36m` 残骸），病灶是 **markdown 渲染层的 ANSI 着色原样进入 `_mainContentLines`，而 `extractText` 按原样切片、零剥离**；修法是让选区叶子层「**列换算跳过序列、产出前剥净 ANSI**」两处纯函数级修复，不碰渲染层、不碰剪贴板出口。

| 环节 | 病灶 | 严重度 |
|---|---|---|
| 复制产出 | 文本夹带 SGR 转义序列，粘贴即乱码 | **主诉** |
| 列换算 | ESC 字节被当可见字符计宽，反色高亮在带色行上与指针错位 | 同族次要 |

## 1. 现状实证（file:line 可复核）

### 1.1 颜色从哪来：markdown 渲染层

- `services/backend/src/cli/renderTheme.js:9-10` — `c()` 懒加载 **chalk**，真彩输出 `ESC[38;2;R;G;Bm`。
- `services/backend/src/cli/markdownRenderer.js:68-74` — 着色默认值：
  - `mdBold: '#E5C07B'` = RGB(229,192,123)；
  - `mdListNumber` / `mdH3 / mdBullet: '#61AFEF'` = RGB(97,175,239)。
- **与用户粘贴残骸逐一吻合**：粘贴里的 `[38;2;229;192;123m`（粗体标题）与 `[38;2;97;175;239m`（有序列表序号 `1.` `2.`）正是这两个色值经 chalk 输出的 SGR 序列、ESC 字节在粘贴时被丢弃后的残骸。

### 1.2 带色文本怎么进入复制来源

- `services/backend/src/cli/tui/ink-components/Transcript.js:33-52` — `renderMarkdown` 委托 `markdownRenderer.renderMarkdownLite`，返回**已着色的整段字符串**。
- `services/backend/src/cli/tui/transcriptLines.js:197,249,255` — `buildTranscriptLines` 把渲染结果按 cols 折行后逐行 push，行内容**含 ANSI**。
- `services/backend/src/cli/tui/ink-components/App.js:5925-5943` — `_mainContentLines` 投影直接消费上述行 ⇒ **投影行数组整体带 ANSI**。
- `App.js:6066` — `_mainContentLinesRef.current = _mainContentLines`，选区层拿到的就是这份。

### 1.3 复制产出点为什么不干净

- `App.js:1694-1701` — 松手即定稿：`const text = sel.extractText(_mainContentLinesRef.current, finished)` → `clip.writeClipboard(text)`。**整条链路唯一的产出点**。
- `services/backend/src/cli/tui/selection.js:501-530` — `extractText` 对行**原样 `slice(from, to)`**，无任何 ANSI 处理 ⇒ 剪贴板拿到带 SGR 的文本。
- `services/backend/src/cli/tui/utils/ccClipboard.js` — 统一出口只搬运传入文本（`:157-191`），**自身无病**；病在来源。

### 1.4 次要病灶：列换算把 ESC 字节当可见字符

- `selection.js:148-167` — `charColForDisplay` 逐字符 `visWidth(ch)` 计宽换算「显示列 → 字符下标」。ESC（0x1B）、`[`、数字、`m` 这些 SGR 组成字节**被当作各占 1 列的可见字符**参与累计 ⇒ 带色行上，指针显示列 → 原文下标的映射整体后移，反色高亮与取词在带色行上**双双偏离指针**（与 [DESIGN-ARCH-132] 的锚点漂移不同源、独立存在）。

### 1.5 对照组：CC 模式为什么没事

- `services/backend/src/cli/tui/ink-components/ccMessageProjection.js:257,502,848` — CC 模式复制走 `extractByAnchors`，从 `msgTexts`（消息**原文**）取词，不经过屏幕行切片 ⇒ 天然干净。**本案只需修 legacy 路径**。

### 1.6 修具已存在，不许另造

- `services/backend/src/utils/stripAnsi.js` — 「剥 ANSI」单一真源，委托 `cli/ansiSanitizer.js`（完整 CSI/OSC/DCS 覆盖、零依赖、永不抛）。其头部 `:12-19` 明确记录：旧式 `/\x1b\[[0-9;]*m/g` 正则**实测漏剥 5/6 种形式**（冒号真彩、光标模式、清屏、光标移动），且 `1m` 残骸症状 2026-09-22 已在输出卫生层修过一次 —— **同一症状家族的第二处发病点**。

## 2. 借鉴提案（B-P2 七字段）

**全部不适用，依据如下**：本提案是本仓自身缺陷修复，**零外部借鉴** —— 不引入任何上游项目、代码、结论或测试形状。B-P2 管的是「借鉴外部」（第 1 字段即「项目名 + 版本/commit」），无借鉴则无字段可填。

| # | 字段 | 声明 |
|---|---|---|
| 1 | 借鉴对象 | 不适用 —— 无外部项目 |
| 2 | 借鉴内容 | 不适用 —— 修复思路来自本仓 §1.6 既有单一真源（`utils/stripAnsi.js`）与其 2026-09-22 修复记录 |
| 3 | 解决的问题 | 适用（本仓缺口）：§1.1-1.4 所列复制夹带 ANSI |
| 4 | 许可证与代码性质 | 不适用 —— 不引入上游代码 |
| 5 | 借鉴方式 | 不适用 |
| 6 | 落点与现有实现对比 | 落点 `selection.js` 为既有文件；实现复用既有 canonical `utils/stripAnsi.js`（已搜索 `stripAnsi|stripVT|ANSI_RE` 于 `src/cli/tui`，命中 `runtime/textMeasure.js:15` 同款委托先例），非新增并行实现 |
| 7 | 验收方式 | 见 §7 |

**B-P1 豁免判定（实测核过，不凭印象）**：`docs/10_规范/registry/FEATURE-OWNERSHIP.json` 现有 10 个 domain（`ai-gateway`…`tui-approval-cards`，行 8-207），**无 selection / clipboard 域登记**；`packaging/modules/modules.json` 亦不含 TUI 文件。即：严格按 SOURCING-001 B-P1 的「已登记能力域」判据，本域**未登记**、豁免前提不成立；但本提案同时**零借鉴**，B-P2 的触发条件（借鉴外部）也不成立 —— 属于两门都进不去的纯自修 bugfix，按 B-P2 体例据实声明如上，不留空。

## 3. 目标形态（组件级契约）

两处改动都在 `selection.js` 纯叶子内（零 IO / 不抛 / 不改入参 / 不读 env），App 层零改动：

1. **`charColForDisplay(lineText, displayCol)`**：走字符串时识别 CSI/SGR 序列（`\x1b` 起头的完整控制序列），序列内字节**计宽 0、下标整段跳过**。⇒ 带色行上「指针列 → 原文下标」重新对准；纯 ASCII / 纯中文行为逐字节不变（无序列时退化恒等，现有 DC-01~DC-07 断言原样绿）。
2. **`extractText(lines, sel)`**：切片仍在原文（raw 下标）上进行 —— 与 `Viewport.sliceLineForSelection` 的 raw 下标口径保持同源；**产出前对每段 `stripAnsi`**（经 `../../utils/stripAnsi` 委托 `ansiSanitizer`，外裹 fail-soft 保「绝不抛」纪律）。⇒ 剪贴板拿到的是纯文本。

顺序不可颠倒：只做 2 不做 1，会得到「干净但错位」的复制（切片边界仍按「ESC 计宽」的旧口径算）；只做 1 不做 2，复制产物仍带 SGR。

回滚能力走**可选参数**（`undefined` → 新行为；显式传旧开关 → 旧行为），**不新增 `KHY_*` env 门** —— 「让功能变正确」不构成用户可见权衡（判据见 check-tui-gates 的门预算棘轮与 selectGates.js:18 注释）。

## 4. 实施分期（每期独立可回滚）

| 期 | 内容 | 落点 | 回滚 |
|---|---|---|---|
| P1 | `charColForDisplay` 序列跳过 + 单测 | `selection.js:148-167` | 撤调用方一处 / git revert |
| P2 | `extractText` 产出剥 ANSI + 单测 | `selection.js:501-530` | 同上 |
| P3（可选） | `ccMessageProjection.extractByAnchors` 的**结构行退化路径**（`:841-842` 按列切屏幕行的那条）同样剥 ANSI | `ccMessageProjection.js` | 独立 revert |

P1+P2 必须同一提交落地（新测试进 `services/backend/tests/` 会被 CI 的 `test:node` 全量 glob 扫到，**落地即绿**是硬约束 —— 红探针先行会直接染红流水线）。

## 5. 诚实边界（刻意不纳入）

- **不动 markdownRenderer 的着色** —— 屏幕上要颜色，那是显示层职责；病只在「复制产出没剥」。
- **不动 `ccClipboard.js`** —— 统一出口是搬运工；把剥离塞进去会连带污染 CC 锚点路径提取的**原文**（原文不该被二次加工），且混淆「提取」与「写出」两层职责。
- **不动 `_fp` 指纹逻辑** —— 指纹在按下帧与松手帧之间自洽比较，剥不剥 ANSI 两帧一致即可；改它要重写 R-01~R-16 全套断言，收益为零。
- **不处理跨软换行多 `\n`** —— `selection.js` 头部已登记的已知偏差，独立议题。
- **不碰 [DESIGN-ARCH-132] 的 D-02/D-04 两条红** —— 基线实测 56 条中 54 绿 2 红（§7），那两条是锚点漂移的既有病灶，本案验收**只要求不新增失败**，不替别的提案收账。

## 6. 反模式（这条路别走）

| ✗ 别做 | 为什么 |
|---|---|
| 在 `writeClipboard` 统一出口里全局剥 ANSI | 把「提取层」的债记到「写出层」头上；CC 原文路径会被连带加工，违反 P1-1 单一真源的职责边界 |
| 内联手写 `/\x1b\[[0-9;]*m/g` 正则 | `stripAnsi.js:12-19` 实测该式漏剥 5/6 种序列形式；仓里已有全量覆盖的 `ansiSanitizer`，再造一把轮子就是把 2026-09-22 修过的坑再挖开 |
| 列换算改成「先 stripAnsi 整行、再按净文本算下标」 | 产出的下标对不上 **raw 行**，而 `Viewport.sliceLineForSelection` 高亮切片吃的是 raw 行 ⇒ 反色错得更远。正解是「跳过序列但保留 raw 下标」 |
| 为回滚新开 `KHY_CLIP_PLAIN` 之类的 env 门 | 撞门预算棘轮（`check-tui-gates.js:32` MAX_GATES 只降不升）；「让功能变正确」不构成用户可见权衡；且会把纯叶子拖进「读 env」的违约区 |
| 把 D-02/D-04 顺手修了 | 两套病灶一套测试，混修后回归无法归因（[DESIGN-ARCH-132] 的账） |

## 7. 验收方式（可复现命令 + 关联门禁）

**基线（2026-09-24 实测，验收尺子）**：

```
node --test services/backend/tests/cli/tui/selection{,DisplayCol,AnchorDrift,Relocate}.test.js
→ # tests 56 / # pass 54 / # fail 2（D-02、D-04，[DESIGN-ARCH-132] 已知红）
```

实施后：**≥54 绿、失败仍恰为 D-02/D-04 两条、零新增红**。

1. 新增 `services/backend/tests/cli/tui/selectionPlainCopy.test.js`（`node:test` 风格，**禁 jest 全局** —— node --test glob 会扫走，落地即红）：
   - 带色行 `'\x1b[38;2;97;175;239m1.\x1b[0m 正文'` 上 `extractText` 产出不含 `\x1b` / `[38;2` / `[0m` 残片；
   - `charColForDisplay` 指针停在可见首字符 → 下标 0（不被序列字节顶走）；
   - 纯 ASCII / 纯中文行回归恒等（DC-02/DC-03 原断言复刻）；
   - 畸形输入（null 行、非字符串）不抛（S-31/S-32 纪律复刻）。
2. `node scripts/ci/check-leaf-contract.js services/backend/src/cli/tui/selection.js` → no violations。
3. `node scripts/ci/check-tui-gates.js` → `KHY_*` token 计数零漂移（本案不加门）。
4. 人工端到端：TUI 内让模型输出带 `**粗体**` 与有序列表的 markdown → 鼠标拖选 → 粘贴至记事本 → 不得出现 `[38;2;` `[1m` `[36m` 等残片。
5. CI 覆盖说明（如实限制）：`test:node` 会跑到新增用例；`test:tui`（ink 真帧）不在 CI 内，本案不依赖它。

## 8. 待核实项

- ~~「selection.js 是否已登记为能力域」~~ —— **已当场查清**：`FEATURE-OWNERSHIP.json` 无此域、`modules.json` 不含 TUI 文件；结论已写进 §2，不动摇提案（零借鉴 ⇒ B-P2 本就不触发）。
- 无其余待核实项。premise 级问题（CI 扫描范围、红探针与 CI 的冲突）已按 6.3 的实测结论消化进 §4。

## 9. 变更日志

- 2026-09-24 初稿：定位复制夹带 ANSI 的病灶链（§1），修复方案 P1/P2/P3（§3-4），基线实测 56/54/2（§7）。
- 2026-09-24 实施：P1+P2 落地，见 §10。

## 10. 实施记录（2026-09-24）

### 10.1 落地清单

| 项 | 位置 | 内容 |
|---|---|---|
| P1 | `selection.js` `charColForDisplay` | 新增第三参 `opts`；无 ESC 行走**快路径**（与旧实现逐字节相同），含 ESC 行走 ANSI 感知扫描：CSI 序列计宽 0、下标整段跳过 |
| P2 | `selection.js` `extractText` | 新增第三参 `opts`；切片仍在 raw 下标上进行，`join` 后对产出剥一次 ANSI（序列不跨 `\n`，与逐段剥等价） |
| 复用 | `utils/stripAnsi`（→ `cli/ansiSanitizer`） | 剥离走单一真源；CSI 扫描正则借 `RE_CSI.source` **自建局部实例**（`/g` 的 lastIndex 是共享状态，直接复用导出实例会嵌套污染） |
| 测试 | `tests/cli/tui/selectionPlainCopy.test.js`（新） | PC-01~PC-09：单行/跨行剥净、指针列对准、快路径恒等、回滚钩子还原、畸形输入不抛、端到端复现用户症状。旧口径期望值用**参照实现**钉住（`visWidth` 对 ESC 计 0、对参数字节计 1，写死数字会随 string-width 装没装漂移） |
| 文档 | 本文件 | 头部已知偏差 +3、两函数 JSDoc、§10 |

### 10.2 与方案的偏离

1. **P3（ccMessageProjection 结构行退化路径剥 ANSI）未做** —— 提案已标「可选」；结构行本无「原文」可言，无真实症状前不动，避免为对齐而对齐。
2. **`extractText` 在 `join` 后剥一次**，而非提案 §3 字面的「对每段剥」—— 序列不跨 `\n`，两者等价，少一次逐段开销。已在代码注释写明。

### 10.3 验收实测（基线对照）

```
node --test tests/cli/tui/selection{,DisplayCol,AnchorDrift,Relocate,PlainCopy}.test.js
→ # tests 65 / # pass 63 / # fail 2
```

- 失败恰为 **D-02 / D-04**（[DESIGN-ARCH-132] 既有红），零新增失败；基线 54 绿全数保留 + 新增 9 条全绿。
- `node scripts/ci/check-leaf-contract.js services/backend/src/cli/tui/selection.js` → **passed, no violations**。

### 10.4 门禁红归因（check-tui-gates 229 > 227，非本案引入）

逐文件 `git show HEAD:<f>` 与工作树做 `KHY_*` token 集合差：**`selection.js` 为 `+[] -[]`**（零漂移）。超标 token 全部来自并行会话的新门：`KHY_ALT_SCREEN`(mouseButtons) / `KHY_TERM_FALLBACK_ROWS`(ccLayout) / `KHY_UI_LANG`(HistorySearchOverlay) / `KHY_PROGRESS_PACED`·`KHY_REDUCED_MOTION`·`KHY_TUI_LOW_POWER`(ProgressBar) / `KHY_CC_OVERLAY_FIT` / `KHY_PERMISSION_NOTICE` / `KHY_TUI_CONSOLE_LOG` / `KHY_WATCHDOG_*` / `KHY_CARD_CLICK` / `KHY_L2_SESSION_ALLOW` / `KHY_INLINE_TRANSCRIPT` 等（另有 `KHY_USER_MSG_FG`、`KHY_VIM_PASTE_CAP` 为**搬家**非净增，`KHY_MOUSE_BUTTONS` 从 app.js 移除为净减）。**未代为棘轮基线** —— 227→229 的账由加门的会话自己结算。

### 10.5 明确不做

- markdownRenderer 着色、`ccClipboard`、`_fp` 指纹、跨软换行 `\n`、D-02/D-04 —— 均见 §5 诚实边界，实施期未越界。
- 生效方式：`services/backend` 为源码直跑（非桌面端构建产物），**重启 TUI 会话即生效**，无需重建 `out/`。
