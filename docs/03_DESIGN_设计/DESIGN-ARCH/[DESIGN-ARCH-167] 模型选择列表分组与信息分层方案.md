<!-- IMPL-STATUS: done -->
<!-- 文档分类: DESIGN-ARCH-167 | 阶段: 设计 | 原路径: 新建 -->
# [DESIGN-ARCH-167] 模型选择列表分组与信息分层方案

> **隶属**：本文属 **TUI 设计族**（总纲 `[DESIGN-ARCH-122]`）；**规则冲突一律以 `[DESIGN-ARCH-102] Khy TUI 统一规则手册` 为准**。
>
> **定位**：本文管 `/model` 选择列表（`ModelPicker`）的**信息架构**——「哪些条目是一家的、每行哪段是主信息哪段是次信息」。它**不**管：哪些模型有资格进列表（那是 `[DESIGN-ARCH-100] 模型列表真值校验与过滤规范` 的射程）、列表项的语义锚点（`ccMessageProjection`）、CLI（非 TUI）命令输出的层次化（`[DESIGN-ARCH-159]`）。
>
> **状态**：**已落地**（2026-10-01）。改动 A/B 已落进 `services/`，并覆盖**两个消费表面**（TUI `ModelPicker` 与经典 REPL `/model`）；分组与分层语义由**共享叶子** `cli/modelChoiceGrouping.js` 单点给出（否则就是第二真源）。裁决记录见 §12。
>
> **取证时间**：初稿 2026-09-29；落地与真数据复核 2026-09-30 ~ 2026-10-01（实测数字均附可复跑的命令）。

---

## 0. 一句话结论

用户说「列表划分不够清楚」，病根**不在渲染层缺分组行，而在数据层把分组维度丢了**：

`gatewayModelChoices.js` 的外层循环 `for (const s of enabledAdapters)`（`:525`）**本来就是分组循环**，但它在拼 `name` 字符串时（`:576`）把分组降级成了一个 dim 后缀 `(执行:${s.name}/${s.type})`（`:574`）——**分组的语义在这行代码上被丢掉了**，选择器拿到的选项对象只有 `{disabled, externalAgent, name, value}` 四个字段，没有任何分组字段。

于是 49 个模型只能平铺，而「谁和谁是一家的」被塞进每行**末尾的括号**里；同时每行内部六段信息（状态 / 模型名 / 能力 / 来源 / 通道 / 延迟）没有一列对齐，模型名被推到第 20 列开外。

本方案两个改动，都**不增加一帧高度**（实测帧高与改前逐档相等）：

| # | 改动 | 落点 | 实测收益 |
|---|------|------|----------|
| **A** | **分组标题行**（只进渲染维度，不进光标维度） | `ModelPicker.js` + 选项对象加 `group` 字段 | 页内出现 `── OpenCode Zen · 18 个 ──`；帧高**零增长** |
| **B** | **行内信息分层**（主信息靠左 / 次信息右对齐成一列） | `ModelPicker.js` + `wrapCell.js` 加 `padCell` | 长标签截断率 **10/10 → 0/10**（80×24 真数据） |

两个由**真数据 A/B** 逼出来的补充（都不是初稿想到的，见 §11）：

- **同一套语义必须覆盖两个表面**：`ModelPicker`（ink）与经典 REPL `/model`（inquirer）吃的是**同一份** `modelChoices`，但只有前者被治过 ⇒ 经典路径仍是平铺，宽度中位 **91 列**（80 列终端下每行折 2 行）。已抽共享叶子一并治（§12-Q12）。
- **Auto 行只留 `★ Auto` + 预览**：80×24 真帧里全表**只剩这 1 行**被 `…` 截断，而切掉的恰好是最有信息量的预览，17 字样板文反而完整 ⇒ 说明让位给预览（§12-Q11）。

---

## 1. 现状实证（全部可复核）

### 1.1 数据层：分组维度存在，但在拼字符串时被丢弃

量具静态抽取 `gatewayModelChoices.js` 里全部 `modelChoices.push({...})` / `unshift({...})` 的**顶层字段**：

```text
── ⓪ 数据层（gatewayModelChoices.js 静态抽取）
[  ok ] 抽取自校验：5 个 modelChoices 站点，抽出选项对象 4 个、跳过非字面量 1 个（合计相等）
  选项对象的顶层字段（并集）: {disabled, externalAgent, name, value}
[  ok ] 选项对象上**没有**任何分组字段 —— 分组维度确实在数据层被丢弃了
  供应商名只以 `执行:` 字面量出现在 name 模板里：命中 1 处
```

- 站点自校验（`5 = 4 抽出 + 1 跳过`）是**必须**的：多行写法会被按行匹配静默漏掉，漏掉的站点永远不会进反向检查 ⇒ 静默假绿。
- 跳过的那 1 个是 `modelChoices.unshift(autoSelect.buildAutoChoice({ previewModel, chalk }))`（`:752`）——`{` 是**调用实参**不是选项对象。初版把它算进来，`previewModel` 被误当成选项字段，已修。

### 1.2 「按适配器分组」分不出截图里的组（本方案最贵的一条发现）

截图里每行末尾都写着 `（执行：API 云端服务/api）`——**OpenCode Zen 的行和百炼 Token Plan 的行写的是同一句**。回到真源：

| 事实 | 证据 |
|---|---|
| 云端供应商全部挂在**同一个适配器** `api` 下 | `adapters/apiAdapter.js:908` `name: 'API 云端服务'`；`:700-728` `listModels()` 遍历 `svc.getAvailableProviders()` 逐个 provider 出模型 |
| 适配器条目的显示名是 `API 云端服务`，类型是 `api` | `gatewayModelChoices.js:267` `statuses.filter(s => s.enabled)`；`:574` `` chalk.dim(`(执行:${s.name}/${s.type})`) `` |
| 上游供应商名**只**以展示串形式存在 | `apiAdapter.js:723` `name: `${p.name} / ${mid}``、`:725` `description: `Cloud provider: ${p.name}``；池路径 `:841`/`:843` |

⇒ 选项对象的 `value.adapter` 对 38/49 个模型都是 `'api'`。**分组键取 `value.adapter` 会把它们并成一组**，标题会写成 `── API 云端服务 · 38 个 ──`——用户依旧分不出 OpenCode Zen 与百炼。量具实测两种键：

```text
── ②c 分组键对比（同一 picker，只换分组键）
  provider 键标题: ── Claude Code · 3 个 ──
  provider 键标题: ── OpenCode Zen · 12 个 ──
  adapter  键标题: ── Claude Code · 3 个 ──
  adapter  键标题: ── API 云端服务 · 38 个 ──
[  ok ] adapter 键把 38 个跨供应商模型并成一组（占 78%，provider 键最大组仅 12 个）
        ⇒ 解决不了截图里「OpenCode Zen / 百炼 混在一起」
```

### 1.3 渲染层：49 项平铺的帧级实测

用**真** `ModelPicker` 渲染真帧（ink 真渲染、真 stdin/stdout），六档终端：

```text
── ① 现状（真 ModelPicker）
  now  80×12       | 帧高 11 | 帧内条目  7 / 账本  7 | 模型  7 | 标题  0 | 数字可达 100% | 截断  6
  now  80×24       | 帧高 16 | 帧内条目 12 / 账本 12 | 模型 12 | 标题  0 | 数字可达  75% | 截断  9
  now  80×40       | 帧高 16 | 帧内条目 12 / 账本 12 | 模型 12 | 标题  0 | 数字可达  75% | 截断  9
  now 120×40       | 帧高 16 | 帧内条目 12 / 账本 12 | 模型 12 | 标题  0 | 数字可达  75% | 截断  3
  now  80×24 q="free" | 帧高 16 | 帧内条目 11 / 账本 11 | 模型 11 | 标题  0 | 数字可达  82% | 截断  6
  now  40×12       | 帧高 11 | 帧内条目  6 / 账本  6 | 模型  6 | 标题  0 | 数字可达 100% | 截断  6
```

三条读数各自说明一件事：

1. **「标题 0」** —— 零分组行，49 项平铺。这是用户抱怨的本体。
2. **帧高账本本身是对的**（`帧内条目 == 真源 pickerPageRows 算出的 pageSize`，六档全中）。所以本方案的重点**不是修账本，而是在不动账本的前提下加分组**。这条也解释了为什么 `services/backend/tests/tui/modelPickerSize.test.js`（BUG-56 的守卫）能一直绿。
3. **「数字可达 75%」** —— 页内 12 行只有前 9 行有 `n.` 序号（`ModelPicker.js:231` `windowPos < 9 ? ... : '  '`），第 10 行起只能用方向键。这是设计限制（数字键只有 1–9），但分组行挤掉窗口位置后，模型行反而全部落在 9 个号位内 ⇒ 实测升到 90%。

### 1.4 行内信息未分层 ⇒ 长标签被切掉

现状一行是：

```text
❯ 5.  [可用] OpenCode Zen / mimo-v2.6-flash-free 免费 [未证实·内置] (执行:API 云端服务/api) ● 3327ms ✓ 当前
      └状态┘ └────── 模型名被推到第 20 列开外 ──────┘ └来源┘ └──── 每行重复的通道信息 ────┘ └每行重复的延迟┘
```

六段信息挤在一行、没有一列对齐；`pickerRowBudget` 只给固定列数，超了就用 `clipCell` 切（`ModelPicker.js:242-243`）。量具把同一 picker 喂两种标签风格：

```text
── ②d 信息分层对截断的影响（同一 picker，只换标签风格）
   80×24 | 旧标签 截断  8/10 ( 80%) → 分层 截断  1/10 ( 10%)
  120×40 | 旧标签 截断  3/10 ( 30%) → 分层 截断  0/10 (  0%)
   60×24 | 旧标签 截断 10/10 (100%) → 分层 截断  1/10 ( 10%)
```

关键在**消重**：`[可用]`/`[可用-告警]` 与 `● 3327ms` 是**每通道一份**的事实（`gatewayModelChoices.js:545-548` 在适配器循环里算一次，然后复制给该通道每一行），却被写进每一行。把它们上移到组标题，行内只剩「该模型独有」的信息。

### 1.5 顺带发现：三处并行的「帧预算」实现

| 实现 | 位置 | 谁在用 |
|---|---|---|
| `pickerPageRows` / `pickerRowBudget` | `tui/wrapCell.js:276,292` | `ModelPicker` |
| `overlayBodyRows` / `ownsLiveRegion` | `tui/ink-components/overlayLiveBudget.js:92` | `App.js:6764` 的 `_overlayOwnsLive` |
| `chromePlan` | `tui/ink-components/ccOverlayLayout.js:29-46` | `CcCommandPalette` / `CcFuzzyPicker` / `CcHistorySearch` |

三者都在算「浮层能占多少行」，互不知情。**本方案不合并它们**（那是独立射程，见 §5 与 §12-Q5），只在接线时**复用** `pickerPageRows` 一个，不新增第四套。

---

## 2. 契约/数据模型可行性实证

### 2.1 选项对象的真形状（读构造函数，不读文档）

| 初稿设想的字段 | 真源实况 | 处置 |
|---|---|---|
| `name`（已格式化标签） | ✅ `gatewayModelChoices.js:576` | 保留；拆成 `primary` / `secondary` |
| `value: { adapter, model }` | ✅ 同上 | 保留；`model` 是**带前缀的 id**（`api:poolKey:mid` 或 `p.key:mid`） |
| `disabled` | ✅ 同上 | 保留 |
| `externalAgent` | ✅ `:654`（外部智能体投影条目） | 保留 |
| **`group` / 组名** | ❌ **不存在** | **需扩真源**，见 §2.2 |
| **组级状态 / 延迟** | ❌ 不存在（每行重复） | 需扩真源（与上同源） |
| `unverified` | ✅ 在**模型行**上（`modelListTruth.js:248`），但选项对象里没有 | 保留在 `secondary` 里呈现 |

**字段透传已验证**：`modelListTruth.js:248` 是 `kept.push(m && m.unverified !== true ? { ...m, unverified: true } : m)`——**展开**原对象，不重建 ⇒ 给模型行加新字段能穿过真值过滤链。`:282` 同理。`gateway.js:1164` 的 `_filterModelsByReliability` 全程 `.filter()` 传递同一批对象引用。

### 2.2 支点字段「组」从哪来——三条路的代价

分组键是本方案的**支点**，必须落在真源上，不能从展示串反解。

| 路 | 做法 | 代价 | 判断 |
|---|---|---|---|
| **P1（推荐）** | 在 `apiAdapter.listModels()` 的行上加结构化 `providerName` / `providerKey`（`:723-726`、`:841-844` 两处 `rows.push`），`gatewayModelChoices.js:576` 透传成选项的 `group`；组级 `statusTag`/`indicator` 也从适配器循环搬到组上 | 改 1 个函数的返回形状（**加**字段，不改既有字段）+ 复核消费方；已验透传不丢字段（§2.1） | ✅ 唯一能真正分开 OpenCode Zen / 百炼的路 |
| **P2（兜底）** | 什么都不改，分组键回退 `value.adapter` | 零 | ⚠ 实测把 38/49 个模型并成一组（§1.2）⇒ 解决不了截图问题，只能算降级可用 |
| **P3（禁止）** | 解析 `m.name` 的 ` / ` 前缀当组名 | 零 | ❌ 从**展示字符串**反解语义 = 第二套真源。展示文案一改就静默错组 |

`buildEntries` 因此写成 **`choice.group || choice.value.adapter`**：P1 落地走前者，P2 兜底走后者，**同一处语义输入**，不另立 `groupLabel` 字段。

### 2.3 光标/数字键所在的维度（最贵的一处接线判断）

`ModelPicker.js` 现有 6 处依赖「下标 == 模型」这个前提：

| 位置 | 依赖方式 |
|---|---|
| `:98-107` `initialCursor` | 在 `list` 上找 `defaultValue` 的下标 |
| `:109` `useState(initialCursor)` | `cursor` 是模型下标 |
| `:127-141` `moveCursor` | 按 `filtered.length` 取模、跳过 `disabled` |
| `:143-149` `choose(idx)` | `filtered[idx]` |
| `:176-185` 数字键 | `filtered[start + offset]` |
| `:260` `（n/N）` 计数器 | `cursor + 1` / `filtered.length` |

若把标题行放进 `filtered`（让它们走 `disabled` 通道），这 6 处**全部要重算**——而 `ccMessageProjection.js:29` 记着这个仓为「`row === index` 不成立」付过的代价（「这是选择模型能成立的全部前提」）。

⇒ **本方案的核心决定：标题行只进渲染维度，不进光标维度**（§4.1）。上述 6 处**一行不改**。

---

## 3. 设计公理（不可让渡）

| # | 公理 | 理由 |
|---|---|---|
| **A1** | **帧高不因分组增长** | 帧高 ≥ `rows` 会让 ink 走全屏分支写 `\x1b[2J`（BUG-89/91/92/93 家族，`ccOverlayFit.test.js` 逐档钉死）。分组是「让列表更好读」，不是「让列表更长」。 |
| **A2** | **光标与数字键活在模型维度** | §2.3：这是选择模型能成立的唯一地基。渲染维度的插入物不得污染它。 |
| **A3** | **分组键必须来自结构化字段，不得从展示串反解** | §2.2-P3。展示文案与语义耦合 ⇒ 文案一改就静默错组，且没有守卫会变红。 |
| **A4** | **同一事实只呈现一次** | §1.4：每通道一份的状态与延迟不该在 49 行里各写一遍。消重既是可读性，也是宽度预算。 |
| **A5** | **净新增 `KHY_*` 门控 = 0** | `check-tui-gates.js:41` 的 `MAX_GATES` 是**只降不升**的棘轮，且**当前已经超了**（实测 236 vs limit 227，存量红，非本次造成）。回滚杆复用既有 `KHY_CC_OVERLAY_FIT`。 |

---

## 4. 设计

### 4.1 改动 A：分组标题行（渲染维度）

分组与分层的纯函数（**落地时已抽到共享叶子 `cli/modelChoiceGrouping.js`** —— 两个消费表面共用一份，零 require、零 IO）：

```js
// 模型条目 → 渲染条目（在组边界插入标题行）
buildEntries(models, query) -> [
  { kind:'section', name, count, meta } | { kind:'model', mi, choice }, ...
]
// 大小写折叠后的组键。**只作比较键** —— 标题名仍取 `groupKeyOf` 的首现原拼写
groupFoldOf(choice) -> string
// 按组键**首现序**做稳定归并（纯置换：不丢 / 不重 / 组内保序 / 组间保持首现相对顺序）
stableGroupOrder(models) -> models'
// 渲染条目 → 上屏的两段文本（主信息 / 次信息）；孤儿段的 groupMeta 回落也在这里
layeredTextOf(entry) -> { primary, secondary }
// 数字键与屏幕序号同源的那座桥（窗口内第 1..9 个**模型行**的条目下标）
digitTargets(entries, start, end) / digitIndexOf(entries, start, end, i) / entryIndexOfModel(entries, mi)
```

> 为什么必须抽成叶子：经典 REPL `/model` 与 TUI 吃的是**同一份** `modelChoices`（§12-Q12）。若两边各写一份分组逻辑，就是**第二真源**——一处改了另一处静默漂移。放 `cli/` 根下而不是 `cli/tui/` 下，是因为 `cli/handlers/**` **不得反向依赖** `cli/tui/**`（分层倒置，`archDebtScan` 的 R1）。

三个关键点：

1. **`filtered`（模型维度）语义一字不变**；它外面再套一层**显示序**：`shown = 浏览态 ? stableGroupOrder(filtered) : filtered`，`entries = buildEntries(shown, query)` 供渲染。⚠ **引入 `shown` 的那一刻，所有依赖模型下标的路径必须一次全部改绑**（`cursor` / 数字键 / `choose` / `initialCursor` / `（n/N）` 分母）—— 漏一处就重现「屏幕上第 n 行 ≠ 按 n 选中的模型」。搜索态**不归并**（结果已按相关度排好，再按组归并会把相关度打散）。
2. **`pageSize` 数的是条目**（`entries.length`）⇒ 标题行**占额度**，帧高账本与改前同一套算式：`2(边框) + header + [搜索回声] + footer + pageSize`。**没有任何一行游离在账外**（实测六档逐档相等，§9）。
3. **数字键与序号同源**：`useInput` 里 `digitTargets(entries, start, end)[n-1]` → 取 `entries[ei].mi` → `setCursor(mi)`；渲染里 `digitIndexOf(...)` 写「n.」。这是对旧版「两处各自推导」的收口（`ModelPicker.js:227-231` 与 `:171-175` 的注释记着旧版因此出过「按数字跳到别的模型」）。
4. **`row === index` 不变式**：光标 / 数字键 / `choose` / `（n/N）` 活在**模型下标**维度；标题行**只进渲染维度**。判据不能看 `❯` 的位置（高亮走 `e.mi === cursor`，而 `e.mi` 已在显示序，绑错数组时 ❯ 看起来照样对）—— 只能看 `onResolve` 拿到的 **value**（§12-Q10）。

**单模型组不画标题**（`MIN_GROUP_FOR_SECTION = 2`）：行内标签已自证「它是谁家的」，标题是纯开销。这条同时给标题行数封了顶——**每个画标题的组至少 2 个模型 ⇒ 页内标题行 ≤ 页内模型行**（最坏 1:1，实测 80×24 为 2:10）。没有这条，49 个单模型组能画出 49 行标题、0 个模型。

**全表只有一组时不画标题**（`MIN_DISTINCT_GROUPS = 2`）—— **这条是落地期实测出来的，方案初稿没有**：

```text
── gateway · 12 个 ──      ← 全表就这一组，标题不携带任何信息
```

它看起来无害，实测却连带三处代价（80×24 / 60×24 逐档量过）：

1. 标题吃掉**一个条目额度** ⇒ 12 条模型被挤成 11 条（既有 BUG-56 测试 `isItemRow === 12` 变红）；
2. 列表因此**不再整页放下** ⇒ `end < entries.length` ⇒ 滚动提示 `↓更多` 出现；
3. 页脚在 60 列**折成 2 行** ⇒ 帧高 16 → 17（公理 A1 被打破）。

⇒ 判据定为「不同组键 < 2 就一个标题都不画」。组级信息（若有）此时全部回落到行内（`orphan`），仍然满足「至少出现一次」。

**搜索态不画标题**：分组是浏览辅助，不是搜索结果的性质；且搜索本来就把列表打散了。

**标题行样式**（1 视觉行，前缀与模型行等宽 9 列以保证左边界对齐）：

```text
❯ 5.  ★ deepseek-v4-flash-free                    免费 · ✓ 当前
   ── OpenCode Zen · 12 个 ── ● 3327ms
   6.  mimo-v2.5-free                              免费
```

### 4.2 改动 B：行内信息分层

| 段 | 改前 | 改后 |
|---|---|---|
| 状态 `[可用]`/`[可用-告警]` | 行首，每行重复 | **上移组标题**（每通道一份） |
| 模型名 | 被状态标签挤到第 20 列开外 | **行首**（主信息） |
| 能力 `视觉` | 跟在模型名后 | 保留在主信息里 |
| 来源 `[未证实·内置]` | 夹在模型名与通道之间 | **次信息列**（右对齐）；`[DESIGN-ARCH-100]` §158 要求它必须可见且黄色 ⇒ 只许移位，不许删除 |
| 通道 `(执行:…)` | 每行重复 | **上移组标题**（消重） |
| 延迟 `● 3327ms` | 每行重复 | **上移组标题**（消重） |
| `✓ 当前` | 行尾 | 次信息列 |

右对齐需要一把与 `clipCell` **同一把**宽度尺的补白函数：`wrapCell.js` 新增 `padCell(text, width)`（与 `clipCell` 同文件、同 `visWidth` 度量）。**不引入第二套宽度计算**——否则截断点与对齐列会各自漂移。

**Auto 行的次信息只放预览**（§12-Q11）。它不是某个上游供应商，是自己的一类（`group: 'Auto'`，1 条 ⇒ 不画标题）。改前它的次信息是「17 字说明 + 预览」，在 80 列下**说明把预览挤出了屏幕**：

```text
改前  ❯ 1.  ★ Auto  自动选择最适合当前任务且可用的模型 (当前最优: claude-opus-…   ← 被 … 切掉的是预览
改后  ❯ 1.  ★ Auto                                          (当前最优: claude-opus-5::auto)
```

代价与边界如实写在这里：`secondary` 空了之后，**无预览时这一行只剩 `★ Auto`**（不附说明）。这不是「静默丢失」——`name` 字段**一字未改**，仍带完整说明，供两个既有消费者用：`cli/handlers/advisor.js` 拿它当候选 label、`ModelPicker.filterChoices` 拿它当搜索匹配文本（搜「自动」仍能命中 Auto）。

**产出点必须全仓找齐**：`ModelPicker` 的 choice 有 **5 个**产出点 —— `apiAdapter` 两路（配置路 / 池路）、默认模型兜底、外部智能体投影、**Auto 行**（`autoModelSelect.buildAutoChoice`）。前 4 个都在 `gatewayModelChoices.js` 里，第 5 个不在 ⇒ 漏了它，Auto 行会成为**唯一不参与分层**的行，并静默依赖渲染侧 `c.primary || c.name` 的回退。这是**真数据 A/B** 才暴露出来的（§11）。

### 4.3 标题行行数上界（可证）

设页内模型行 $m$、标题行 $s$。每个标题行属于一个「≥2 个模型的组」；页内出现的标题行对应的组，其**首个模型**必在同一页内（标题行紧邻其首模型之前）。最坏情况是页首恰好落在多个组的边界：

$$s \le m \quad\Rightarrow\quad \text{页内条目} = m + s \le 2m$$

即标题行最多占掉半页。实测 80×24：$m=10, s=2$。**代价如实写在这里**：页内可见模型数从 12 降到 10（−17%），换来的是「一眼看出分组」。这是本方案唯一的负面读数，不粉饰。

---

## 5. 与既有机制的边界表

| 既有件 | 它管什么 | 本方案做什么 | 边界在哪 |
|---|---|---|---|
| `[DESIGN-ARCH-100]` 模型列表真值校验与过滤 | 哪些条目**有资格**进列表；每条必须带什么来源标签（`:158` `[未证实·内置]` 黄色） | 进来的条目**怎么分组呈现** | 100 管「准入 + 标签必须存在」，本方案管「标签放哪一列」。**本方案不删任何标签**（§4.2） |
| `[DESIGN-ARCH-102]` Khy TUI 统一规则手册 | TUI 布局/组件/配色/键盘/响应式**规则真源**；H1 帧高 ≤ `rows−1`；§5.4 C12 选择列表；H7 门控预算 | 在其规则下给 `ModelPicker` 补信息架构 | **冲突以 102 为准**。本方案不新增 H 约束、不改组件目录 |
| `[DESIGN-ARCH-159]` CLI 命令输出层次化 | `services/backend/src/cli/**` **handler 层 console 输出**的分组/条目/详情五原语；**明写不含 TUI ink 渲染族** | ink 渲染层的分组 | 同一套「分组 → 条目 → 详情」语义，落点不同。若 159 先落地 `outputBlock.js`，两边的**术语与缩进档位应对齐**（本方案不重复实现它） |
| `[DESIGN-ARCH-084]` CC 模式注意力与选择 | 焦点/选择信号的强度排序（边框 > 反显 > 粗体 > 符号 > 颜色 > 缩进） | 标题行用**最弱档**（`color: 'gray'`，无粗体、无边框、无符号） | 遵守 §1.2「禁止同时用 4+ 个信号表示同一状态」 |
| `[DESIGN-ARCH-119]` / `ccMessageProjection` | 屏幕行 ↔ 文本的 1:1 映射（`row === index`） | 标题行是 picker **内部**的渲染行，不进投影 | ⚠ **接线前必验**：picker 是 `_overlayOwnsLive`（`App.js:6764`）独占 live 区，实测 `ccMessageProjection.js` 内零 `picker` 引用 ⇒ 不参与投影。**若将来 picker 进投影，标题行必须按 `anchors[i] = null`（结构行）登记** |
| `[DESIGN-ARCH-122]` TUI 设计族总纲 | 族的 scope 裁决 | 本文归入族（组件设计类） | 落地后应在 122 §2 的族成员表补一行（见 §8 步 3） |
| 三处并行帧预算（§1.5） | 各自算浮层高度 | 只复用 `pickerPageRows`，不新增第四套 | 合并它们是独立提案，**不在本方案射程**（§12-Q5） |

---

## 6. 强度梯度

| 阶段 | 形态 | 判据 |
|---|---|---|
| **事前（本轮）** | 提案 + 可复跑量具，**零阻断** | 量具 `exit 0`；无任何守卫新增 |
| **事中（步 1–2）** | 回归测试进 `test:tui` 套件；量具从 `.khyos/diag/` 迁出为测试内的断言 | 测试变红即停 |
| **事末（步 3，可选）** | 若要把「标题行不得进 `filtered`」变成机器守卫，需按 §8 步 3 的 4 件一起做 | `check:wiring` / `check:gov-rules` 绿 |

> **本方案不提议任何新的阻断档**。理由：`ModelPicker` 是热点文件，且「分组是否正确」目前**没有客观判据**（取决于 `group` 字段的上游供数），过早设 error 只会逼实现者谎报。

---

## 7. 防呆铁律（每条都有可自动判的判据）

| # | 铁律 | 判据 | 违反后果 |
|---|---|---|---|
| **R1** | `filtered`（模型维度）元素**永远**有 `value.adapter`；标题行**不得**出现在 `filtered` 里 | 单测：`filtered.every(c => c.value && c.value.adapter)` | 6 处下标依赖全部错位（§2.3） |
| **R2** | 帧内条目行数 == `pickerPageRows(...)` 算出的 `pageSize` | 量具 A2（六档）；负对照 `overflow` 必须变红 | 帧高越屏 → ink 全屏分支 → 每次重画塞整屏副本 |
| **R3** | 数字键按 `n` 选中的**就是**屏幕上写着 `n.` 那一行 | 量具 ②b（2 档 × 9 键）；负对照 `digitmap` 必须变红 | 用户「按 3 选中了别的模型」 |
| **R4** | 净新增 `KHY_*` 门控 = 0 | `npm run check:tui-gates` 的计数**不上升**（当前已 236 > 227，属存量红） | 顶破只降不升的棘轮；方案 A5 |
| **R5** | 搜索态零标题行 | 量具（`query` 非空时 `sections == 0`） | 搜索被无意义的标题行稀释 |
| **R6** | 单模型组不画标题 | `MIN_GROUP_FOR_SECTION = 2`；单测：构造 49 个单模型组，断言 `sections == 0` | 标题行数失控（§4.1） |
| **R7** | `[未证实·内置]` 标签只许移位、不许删除，且**不得静默**丢失 | 量具 ④（4 变体 × 3 行）+ 负对照 `silent-secondary` 必须变红；单测待补（与 §9-7/§9-8 同批） | 违反强制规范（`[DESIGN-ARCH-100]` §158） |
| **R8** | 光标**永不**停在标题行 | 量具 ②c（↓ 扫全程 14 帧，`❯` 零次落在 `──` 行） | 光标停在一行不可选的东西上 |

---

## 8. B-L2 三步接线清单（一次提交只做一步）

### 步 1 — 标记：把纯函数与回归测试落地（**不动渲染**）

| # | 触点 | 动作 |
|---|---|---|
| 1.1 | `tui/wrapCell.js` | 新增并导出 `padCell(text, width)`（与 `clipCell` 同一把 `visWidth` 尺） |
| 1.2 | `tui/ink-components/ModelPicker.js` | 新增 `buildEntries` / `digitTargets` / `digitIndexOf` / `entryIndexOfModel` 四个纯函数并导出（供单测直调） |
| 1.3 | `services/backend/tests/tui/modelPickerSize.test.js` | **扩展既有文件**（不新建）：加 R1/R3/R6/R7 的单测 + 帧高不回归断言 |
| 1.4 | — | ⚠ **不要**在 `services/backend/tests/tui/` 下新建文件。该目录被 `test:tui`（jest）与 `node --test tests/**/*.test.js` **同时**扫到，两种风格互不兼容（`[DESIGN-ARCH-135]` 记着这个雷）。扩既有文件不新增扫描面 |

验收：`npm run --workspace services/backend test:tui` 全绿；`node scripts/ci/check-repo-layout.js` 的 `entry-buffer` 计数不上升。

### 步 2 — 迁移：接线渲染与数据层

| # | 触点 | 动作 |
|---|---|---|
| 2.1 | `ModelPicker.js` `:125` | `filtered` 之后加 `entries = useMemo(() => buildEntries(filtered, query), [filtered, query])` |
| 2.2 | `ModelPicker.js` `:176-186` | 数字键块改用 `digitTargets` → `entries[ei].mi` → `setCursor(mi)` |
| 2.3 | `ModelPicker.js` `:207-218` | `pageSize` 用 `entries.length`；窗口 `start` 用 `entryIndexOfModel(entries, cursor)` 定位 |
| 2.4 | `ModelPicker.js` `:223-256` | 行渲染加 `kind === 'section'` 分支（1 视觉行，前缀 9 列空格）；序号改 `digitIndexOf` |
| 2.5 | `ModelPicker.js` `:258-261` | `scrollHint` 的**分母保持模型数**（`filtered.length`），分子 `cursor + 1` 不变 |
| 2.6 | `handlers/gatewayModelChoices.js` 三处 `modelChoices.push` | 选项对象**加** `group` / `primary` / `secondary` / `groupMeta`；组级 `statusTag`/`indicator`/`adapterTag` 合成 `groupMeta` 挂到组上。**`name` 只增不减**（见下方偏离 ①） |
| 2.7 | `services/gateway/adapters/apiAdapter.js` 两处 `rows.push` | 加**既有**字段 `upstreamProvider: p.name`（见下方偏离 ②） |
| 2.8 | — | 门控：**裁决为不加**（见下方偏离 ③） |

**落地时相对本表的三处偏离**（都是落地期才查出来的事实，不是改主意）：

| 偏离 | 原写 | 实际做法 | 依据（可复核） |
|---|---|---|---|
| ① `name` 不拆 | 「`name` 拆成 `primary`/`secondary`」 | **只加不拆**，`name` 原样保留 | `advisor.js:41-46` 真消费 `c.name` 当 `label`；拆掉会让 advisor 的 `label` 静默变 `undefined`。`gatewayConfigEditor.js:33/58` 只是持有 DI 引用、未调用。 |
| ② 用既有字段而非新字段 | 加 `providerName`/`providerKey` | 填既有 `upstreamProvider` | `upstreamProvider`/`upstreamHost` 已是结构化字段，唯一消费者 `_formatUpstreamTag`（`gateway.js:461-469`）、唯一生产者 `codexAdapter.js`；apiAdapter 此前未填。再立 `providerName` 就是同义第二真源（`[MGMT-STD-008]` §2.2「重叠即违规」）。透传已验：`applyOverrides` 与 `filterByUpstreamAuthority` 均以 `...m` 展开，不吞字段。 |
| ③ 不加门控 | 复用 `KHY_CC_OVERLAY_FIT` 作回滚杆 | **不加** | 人裁决（2026-09-30）。该门控只被 CC 四个组件消费、自述「CC 表面浮层」叶子，回退的是选取语义不是行会计；复用它会把本改动挂到 CC 专属杆上。**净新增门控 = 0，直接满足 A5/R4**，回退靠正常 revert 提交。 |

**落地期新发现的洞（本表原本没有）**：`MIN_GROUP_FOR_SECTION = 2` ⇒ 只有 1 个模型的供应商**不画标题行**，而组级三件套已升格到 `groupMeta`，那三件套会**整个消失**（静默丢失）。已补：段不画标题时 `buildEntries` 给该段模型条目打 `orphan: true`，渲染侧把 `groupMeta` 回落到行内 —— 判据是「组级信息至少出现一次」。

**落地期追加的五项收口**（都在原表之外；每项都由人裁决，逐项都有判据）：

| 收口 | 动作 | 裁决 | 判据 |
|---|---|---|---|
| **Q8** 组名大小写变体 | 加 `groupFoldOf`（**只作比较键**）；`buildEntries` 段边界按 fold 判、标题名取首现原拼写 | §12-Q8 | 纯函数 2 条 + 真帧 1 条（`Anthropic` 只 1 条标题） |
| **Q9** 同名段归并 | 加 `stableGroupOrder`（**首现序**稳定归并，非字母序）；新增 `shown` 显示序，**5 处下标一次全部改绑** | §12-Q9 | 纯函数 2 条 + 真帧 1 条 + Q10 组 5 条 |
| **Q11** Auto 行文案 | `buildAutoChoice` 的 `secondary` **只放预览**（`name` 一字未改） | §12-Q11 | 真入口 A/B 80×24 截断 **1/10 → 0/10** |
| **Q12** 经典 REPL `/model` | 抽**共享叶子** `cli/modelChoiceGrouping.js`（两个表面共用）；`gatewayModelChoices.js` 加 4 个纯函数 + 4 处接线 | §12-Q12 | 4 条单测 + 纯函数 A/B 中位 **91 → 40 列**、三表面读数逐项相等 |
| **Q12+** 经典路径验证深度 | 抽 `resolveNumericPick`（把「按显示序取」那行从调用点变成可单测的纯函数，**调用点原本零覆盖**）；测试 7 → **9** 条；补**负对照** | §12-Q12 | 四条注入 **3 / 2 / 1 / 2** 条变红（F 精准单点）；还原逐字节相等 |

> **Q12 的落点是 `cli/` 根下，不是 `cli/tui/` 下**：`cli/handlers/gatewayModelChoices.js` 要用它，而 `cli/handlers/**` **不得反向依赖** `cli/tui/**`（分层倒置，`archDebtScan` 的 R1）。把语义复制一份到 handlers 里更省事，但那就是**第二真源** —— 一处改了另一处静默漂移。

验收：量具全绿（`node .khyos/diag/model-picker-grouping/probe.js`）；`npm run --workspace services/backend test:tui` 全绿；`npm run check:tui-gates` 计数**未上升**。

### 步 3 — 收口：索引与族表

| # | 触点 | 动作 |
|---|---|---|
| 3.1 | `docs/03_DESIGN_设计/DESIGN-ARCH/00_INDEX_DESIGN-ARCH-总目录.md` | 补录本文（**纯增**：只在末尾插行 + 计数 +1） |
| 3.2 | `docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-122] TUI 设计族总纲.md` | 组 3 成员表加本文 |
| 3.3 | `[DESIGN-ARCH-159]` | 若 159 已落地 `outputBlock.js`，把两边的分组术语/缩进档位对齐（否则不改）。**实测：`find services/backend/src -name "outputBlock*"` 为空 ⇒ 159 的 `outputBlock.js` 未落地 ⇒ 本方案不与之对齐，不新增任何对齐改动。** |

> **本方案不新增规则、不加 `scripts/ci/` 检查器、不动门档阶段表**。若将来要把 R1–R8 变成机器守卫，那是**独立一笔**（登记表 + `package.json` 别名 + `<!-- RULES-REGISTRY -->` 标记行 + 规则卡，四件成对做，见 `[DESIGN-ARCH-127]` 的 13 处硬触点）。

---

## 9. 验证与反例清单

| # | 反例 / 场景 | 预期 finding | 本轮是否实测 |
|---|---|---|---|
| 1 | 新增标题行后帧高 > `rows−1` | A1 红（越屏） | ✅ 负对照 `overflow` 实测抓到（帧高 53 > 23） |
| 2 | 标题行游离在 `pageSize` 账外 | A2 红（帧内条目 ≠ 账本 pageSize） | ✅ 同上（49 ≠ 12） |
| 3 | 数字键映射与序号不同源 | ②b 红 | ✅ 负对照 `digitmap` 实测 8/9 落错行 |
| 4 | 光标停在标题行 | ②c 红 | ✅ 14 帧扫描零次 |
| 5 | 搜索态仍画标题 | ⑤ 红 | ✅ 六档实测搜索态 `sections == 0` |
| 6 | 分组键取 `value.adapter` | ②c 红（云端 38 个并成一组） | ✅ 实测 |
| 7 | 单模型组也画标题 | R6 红 | ✅ 单测已补（`R6 单模型组不画标题`：`[A×1,B×2,C×1]` ⇒ 只有 `B` 画标题） |
| 8 | 49 项 / 49 个单模型组 | 页内 0 标题 | ✅ 由 §9-7 同一条不变量封顶（每个画标题的组 ≥2 个模型 ⇒ 页内标题 ≤ 页内模型） |
| 9 | `unverified` 标签被分层改动**静默**吃掉 | ④ 红（静默丢失 > 0） | ✅ 实测：4 个变体（现状 / 提案 / 分层 120×40 / 分层窄档 60×24）全部「保留 3 + 可见截断 0 + **静默丢失 0**」；负对照 `silent-secondary` 变红 3/3 ⇒ ④ 非恒真断言 |
| 10 | 窄终端 40 列 / 60 列 | 帧高不越屏、footer 折行进账本 | ✅ 实测 40×12 与 60×24 通过 |
| 11 | 矮终端 5–9 行 | 提案与现状**逐档等高**、帧内条目 == 真源账本 | ✅ 实测：6/7/8/9 行帧高 5/6/7/8，与现状**逐档相等**（零增长），帧内条目 == 账本；⚠ **5 行档现状与提案同档越屏**（帧高 5 > `rows−1` = 4）—— **既有地板，非本方案引入**，见 §12-Q7 |
| 12 | 全表只有一组 | 不画标题；且帧高**不因标题增长** | ✅ 实测（落地期新增，方案初稿没有这条）：8 组夹具仍画 2 条标题；单组夹具 `60×24` 帧高回到 16（一度变 17），既有 BUG-56 测试 `isItemRow === 12` 未改一字也回到绿 —— 详见 §4.1 |
| 13 | 单模型组的组级信息（状态/延迟/执行方）丢失 | `orphan` 回落：行内必须出现 | ✅ 单测已补（`orphan：段没画标题时 groupMeta 回落到行内`） |
| 14 | 组名只差大小写（`Anthropic`/`anthropic`）被画成两条近似标题 | 真帧里该组只出现 **1** 条标题 | ✅ 已补（纯函数 + 真帧各一条）：`Q8` 两条 + 真帧断言「`sectionRows` 里含 anthropic 的只有 1 条、拼写为 `Anthropic`、计数 3」 |
| 15 | 同名供应商被切成两个不连续段 ⇒ 两条同名标题 | 真帧里该组只出现 **1** 条标题、计数为全局值 | ✅ 已补：真帧断言「`OpenCode Zen · 7 个` 只出现 1 次」；真数据读数 **6 段 → 5 段**（17 个并成一段） |
| 17 | **第 5 个产出点**（Auto 行）漏供分层字段 ⇒ 它是唯一不参与分层的行，且静默依赖 `c.primary \|\| c.name` 回退 | 真数据上「字段未定义计数」全 0；Auto 行主/次信息分层 | ✅ 已补：真数据实测 `{group:1,primary:1,secondary:1,groupMeta:1}` → **全 0**；120×40 真帧实测 Auto 行 `★ Auto` 左对齐 + 说明/预览右对齐 |
| 18 | 把**时变**的真数据读数当成稳定值（判据钉绝对条数） | 判据钉**关系 / 比率** | ⚠ 已观察并写进口径：同一命令三次真跑 **36 / 52 / 53 条**（`agnes` 1 → 12），而比率（`(执行:)` 5→0、前缀 6→0、截断 10/10→**0/10**）几次一致 |
| 16 | 归并改变了模型下标 ⇒ 光标/数字键/`choose`/`（n/N）` 指错行 | 归并后「按 n 选中的值」== 屏幕上「n.」那一行；`defaultValue` 开局光标同源 | ✅ 已补 5 条（§12-Q10 收口）：数字键 4 个落点、`↓×2+Enter`、`defaultValue` 开局光标、`（n/N）` 分母、以及「夹具真的被重排」的前提断言。**判据挂在 `onResolve` 拿到的 value 上**，不是 ❯ 的位置 —— 高亮走 `e.mi === cursor` 而 `e.mi` 已在显示序，绑错数组时 ❯ 看起来照样对。**负对照（三条注入，逐条精准）**：见下方「Q10 负对照」。 |
| 19 | **只治一个表面** ⇒ 同一份数据在两个表面上语义不一致（经典 REPL 仍平铺 `c.name`） | 两个表面的读数**逐项相等** | ✅ 已治并实测（§12-Q12）：经典路径宽度中位 **91 → 40 列**、超 80 列 **43/53 → 2/59**；改后经典 inquirer / 数字兜底 / TUI **三列读数逐项相等**（行数 59、含执行方 8/59、供应商前缀 0/59、中位 40、超 80 列 2/59）—— 同一套语义的交叉验证 |
| 20 | **截断切掉了最有信息量的那段**（Auto 行） | 截断率 **1 → 0**（80×24） | ✅ 已治并实测（§12-Q11）：真入口 A/B 80×24 被截断 **1/10 → 0/10**、60×24 **2/11 → 1/11**；Auto 行改后完整显示 `★ Auto  (当前最优: claude-opus-5::auto)`。`name` 一字未改（两个既有消费者不受影响），单测钉到**字节** |
| 21 | 多键序列 `↓ ↓ Enter` 读到「显示序第 2 个」（期望 `A-2`，实得 `A-1`） | 判据必须证明「**回车结算用的是最新光标**」 | ✅ **已定位机制并修**（2026-10-02）。**不是「丢键」** —— 取证 `q10-frame-dump.js` 四读数：① 回车**发出前**屏上 `❯ 3.  A-2`；② 回车后 `resolved = ['A-1']`；③ **stdin 队列残留 = 0**（键被消费了）；④ 回车后屏上 ❯ 仍是 `A-2`（状态没回退）。⇒ 机制是 **`choose(cursor)` 读了 render 期闭包**：ink 在 **passive effect** 里重订阅 input handler，而帧是在 **layout effect** 里写出去的 ⇒ 存在「**屏已新、handler 还是上一拍**」的窗口，此刻按回车就按旧光标结算。修法：`cursorRef` 在 **render 期**赋值（必须早于写屏，放 effect 里同样滞后），回车改读 `cursorRef.current`；`moveCursor` 本来就走 `setCursor(c => …)` **函数式更新**，不受影响。**正对照**（`q10-closure-ab.js`，各 120 轮）：旧写法 **6 / 120**（且 `#107–#111` **连续 5 轮**抖动 —— 窗口会成片放大）、修后 **0 / 120**。⚠ 抖动率低（约 3–5%）且**对按键间隔不敏感**（40 / 150 / 300ms 各 20 轮均 0）⇒ 「加大等待」治不了它，只有消除闭包陈旧才行 |
| 22 | ~~「多键序列丢键」是跨组件同族问题~~ **初版归因有误，此处更正** | 归因必须区分「**丢键**」与「**键被消费但闭包陈旧**」 | ⚠ **更正**：本表初版把 21 归为「与 `permissionsPromptDigitFooter` / `keyHandlerFreshClosure` **同族的丢键**问题，属测试脚手架、未并入本笔」—— **这是错的**。判据是 `stdin` 队列残留：21 实测为 **0**（键被消费），与「丢键」**不是同一机制**。这也解释了为什么 `downkey-probe.js`（纯 CPU 负载 / 阻塞事件循环各 3–4 轮）**复现不出来** —— 它找的是「丢键」那条线，而闭包陈旧**本来就不该用机器负载去复现**。⇒ 「丢键」那一族是否真的存在、是否跨组件，**仍未定位**；本次不再替它下结论 |


#### Q10 负对照：三条注入，逐条精准（2026-10-02 复跑）

**为什么必须复跑**：Q10 的就绪闸从「只在提交键前一道」改成**逐键闸**（`cursorGates`）之后，闸本身要读 ❯ 的位置；而 ❯ 的位置**分辨不出**「光标绑错数组」（高亮走 `e.mi === cursor`，`e.mi` 已在显示序）。⇒ 必须证明「**即使加了闸，绑错数组时断言照样红**」。

```
node .khyos/diag/model-picker-grouping/q10-negative-control.js
# 对真源注入已知缺陷（每个锚点要求命中恰好 1 次）→ 跑 Q10 那一组 → 记录哪几条变红
# → 无论成败都在 finally 里还原，并用 `===` 逐字节自证
```

| 注入（改真源一处绑定） | 变红 | 具体哪几条 |
|---|---|---|
| （基线，未注入） | 0 / 5 | — |
| **A** `choose` 绑回**输入序**（`shown[idx]` → `list[idx]`） | **3 / 5** | 数字键 · `↓×2+Enter` · `defaultValue`（另 2 条：`前提` 与 `（n/N）分母`，对本缺陷**正确地不敏感**） |
| **B** `initialCursor` 绑回输入序（`browse.findIndex` → `list.findIndex`） | **1 / 5** | 只有 `defaultValue` |
| **C** 数字键用**条目下标**而非模型下标（`choose(mi)` → `choose(ei)`） | **1 / 5** | 只有 `数字键` |

三点结论：

1. **每条断言都有牙**：三个缺陷各自至少红一条，且 B/C 各**只**红那一条 —— 说明判据**精准定位**到对应的绑定点，不是「一红一大片」的模糊断言。
2. **就绪闸没有把绑定错误盖住**：加了逐键闸之后注入 A 仍然 3 条红 ⇒ 闸只承担「等它画完」，没有替断言兜底。
3. **还原可信**：脚本在 `finally` 里写回并在跑完后 `===` 逐字节自证相等，收尾复跑 Q10 **5/5 绿**。全程**不用 `git stash`**（用户铁律），备份另存一份到 `.khyos/diag/.../ModelPicker.js.bak`。

#### Q12 负对照：四条注入，逐条精准（2026-10-02）

**为什么必须补**：Q12 的经典路径原只有 4 条**纯函数**单测（断言「builder 产出了什么」），**没有一条**断言「屏幕上的编号真的能选回那个模型」；而且落地后我发现一个真空白 —— handler 里那行 `picked = numeric.models[idx - 1]` **零覆盖**（量具只验了 builder 的映射，没验调用点）。⇒ 先把这行抽成可单测的 `resolveNumericPick`（见「落地账本」），再补**负对照**证明这组断言**不是恒真**。

```
node .khyos/diag/model-picker-grouping/classic-path-negative-control.js
# 同 Q10 口径：逐个锚点注入（每个要求命中恰好 1 次）→ 跑 classic 那一组
# → 记录哪几条变红 → finally 还原 + `===` 逐字节自证
```

| 注入（改真源一处绑定） | 变红 | 具体哪几条 |
|---|---|---|
| （基线，未注入） | 0 / 6 | — |
| **D** 经典路径**不归并**（摘掉 `stableGroupOrder`） | **3 / 6** | `Separator 顺序` · `编号只给模型行`（`models[n-1]` 自证） · `编号 → 显示序` |
| **E** `resolveNumericPick` **差一位**（`models[idx-1]` → `models[idx]`） | **2 / 6** | `编号 → 显示序` · `边界各自可辨` |
| **F** **边界混淆**（去掉 `idx === 0` 判定） | **1 / 6** | 只有 `边界各自可辨` |
| **G** 标题行**丢掉组级信息**（`classicSectionText` 不带 `meta`） | **2 / 6** | `Separator 顺序` · `编号只给模型行` |

三点结论：

1. **「编号 → 显示序」这条断言有牙且不可替代**：注入 D（不归并）与 E（差一位）两条**互相独立**的缺陷都让它变红 ⇒ 它是唯一把「屏幕上的编号」接回「模型」的判据，且不依赖某一种具体改法。
2. **F 是精准单点**：只让「三条边界各自可辨」变红（1/6），说明该断言真的在分辨 `cancel` / `out-of-range` / `disabled` 三种失败，而不是「红一大片」。
3. **还原可信**：`finally` 写回 + `===` 逐字节自证 OK，收尾复跑 **6/6 绿**；真源四处锚点复检齐在、`node --check` 通过、注入形态（`models[idx]` / `buildEntries(list, '')` / `!Number.isFinite(idx)) {` 单独形态）**零残留**。

⚠ **量具自身踩过的坑（已修，留作复用提示）**：`●` 失败清单的**第一版正则是错的**，读成「失败用例：无」——那是**假读数**，而 `Tests:` 汇总明明写着 `3 failed / 2 failed / 1 failed / 2 failed`（即四条注入**都真的红了**）。
根因不是转义，是**锚点位置**：jest 的 `●` 行**从顶层 describe 起锚**，本例前面还挂着 `Gateway Model Choices Leaf › `：

```text
"  ● Gateway Model Choices Leaf › classic /model 列表：分组 + 分层（与 TUI 同一套语义） › 数字兜底：输入编号 → …"
```

Q10 那个脚本能对上，只是因为它的 describe 本身就是**顶层**。已改为 `/●[^\r\n]*classic \/model 列表[^\r\n]*›[^\S\r\n]*(.+)/g`，并加**护栏**：汇总里 `N failed > 0` 但清单为空 ⇒ 打印「★ 解析失败」而**不是**「无」（把「解析失败」与「真的没红」严格分开）。

---

## 10. 复现方式（可直接粘贴）

> ⚠ **量具落 `.khyos/diag/`，而 `.khyos/` 被 gitignore**（`.gitignore:65`）⇒ **新克隆的检出里没有这两个文件**。它们是**过程态工具**（真源 `[DESIGN-LAY-002]` §3.1），本轮不迁入版本控制；步 1 落地时其判定逻辑以**回归测试**形式入仓（§8 步 1.3）。

```bash
# 1) 从真源打补丁生成「分组版」变体（14 条锚点各命中恰好 1 次；还原自证逐字节相等）
node .khyos/diag/model-picker-grouping/patch.js

# 2) 对拍量具（现状 vs 提案 vs 负对照），Summary 必须 0 error
#    （--scenario=all 下另有 1 warning：5 行档的既有越屏地板，见 §9-11）
node .khyos/diag/model-picker-grouping/probe.js
node .khyos/diag/model-picker-grouping/probe.js --scenario=data       # 只跑数据层抽取
node .khyos/diag/model-picker-grouping/probe.js --scenario=negative   # 只跑负对照（含 silent-secondary）
node .khyos/diag/model-picker-grouping/probe.js --scenario=fidelity   # 只跑来源标签保真（§9-9）
node .khyos/diag/model-picker-grouping/probe.js --scenario=short      # 只跑 5–9 行矮终端档（§9-11）
node .khyos/diag/model-picker-grouping/probe.js --group=adapter       # 换分组键（P2 兜底）

# 3) 存证（探针自己写 UTF-8；shell 重定向会吃 Windows 控制台代码页）
node .khyos/diag/model-picker-grouping/probe.js --out=.khyos/diag/model-picker-grouping/evidence-after.txt

# 4) 真入口 A/B：真跑 buildGatewayModelChoices()（探测 17 通道，1~2 分钟），落盘真 choices + 两帧读数
#    ⚠ 必须显式 process.exit —— 真入口会起「后台深测任务」持有定时器，否则「跑完却挂着」
node .khyos/diag/model-picker-grouping/real-choices-ab.js

# 5) 经典 REPL `/model` 的改前/改后 A/B（读上一步落盘的真 choices，纯函数，秒级）
node .khyos/diag/model-picker-grouping/classic-path-gap.js

# 6) Q10 负对照：注入已知缺陷证明「归并后下标一致性」那 5 条断言**会红**
#    （脚本自带 finally 还原 + 逐字节自证；不用 git stash）
node .khyos/diag/model-picker-grouping/q10-negative-control.js

# 7) Q12 负对照：注入已知缺陷证明「经典 REPL `/model`」那 6 条断言**会红**
#    （四条注入：不归并 / 差一位 / 边界混淆 / 标题丢 meta；口径同 6）
node .khyos/diag/model-picker-grouping/classic-path-negative-control.js

# 8) 取证：`↓ ↓ Enter` 为何会读到「第 2 个」
#    8a) 逐拍时间线（纯 CPU 负载 / 阻塞事件循环）—— 找的是「丢键」那条线
node .khyos/diag/model-picker-grouping/downkey-probe.js 4 40 0      # 4 轮，按键间隔 40ms，不阻塞
node .khyos/diag/model-picker-grouping/downkey-probe.js 3 40 150    # 每键后同步阻塞 150ms
#    8b) ★ 真凶在这里：回车前后四读数（屏上 ❯ / resolved / stdin 队列残留 / 状态是否回退）
node .khyos/diag/model-picker-grouping/q10-frame-dump.js 10 40 0    # [轮数] [键间隔ms] [闸后额外ms]
#    8c) 正对照：修后 vs 旧写法（回车读 ref vs 读闭包），各 120 轮
node .khyos/diag/model-picker-grouping/q10-closure-ab.js 120
```

`patch.js` 的设计要点：变体不是**手抄副本**（手抄会与真源静默漂移），而是**带命中数断言的补丁栈**——任一锚点命中数 ≠ 1、或还原后与真源不逐字节相等，脚本就 `exit 1` 拒绝出数。真源一改，探针当场失效而不是给出好看的假数据。

---

## 11. 验证状态

### 已实测（附路径）

| 断言 | 数字 | 出处 |
|---|---|---|
| 选项对象无分组字段；字段并集 = `{disabled, externalAgent, name, value}` | 5 站点自校验 | `probe.js --scenario=data` |
| 现状帧账本正确（帧内条目 == 真源 pageSize） | 6 档 | `probe.js` ① |
| 提案帧高与现状**逐档相等**（零增长） | 11/11、16/16、16/16、16/16、16/16、11/11 | `probe.js` ② |
| 提案帧账本正确 | 6 档 | `probe.js` ② |
| 分组键对比：adapter 键并成 38 个（78%） | provider 键最大组仅 12 | `probe.js` ②c |
| 信息分层把截断率 80%→10% / 30%→0% / 100%→10% | 3 档 | `probe.js` ②d |
| 数字键与序号同源 | 2 档 × 9 键 | `probe.js` ②b |
| 光标零次落在标题行 | 14 帧 | `probe.js` ②c |
| 负对照 `digitmap` 变红 | 8/9 落错行 | `probe.js` ③a |
| 负对照 `overflow` 变红 | 被 3 条断言抓住 | `probe.js` ③b |
| 负对照 `silent-secondary` 变红 | 3/3 行静默丢掉 `[未证实·内置]` | `probe.js` ③c |
| 来源标签保真：无静默丢失 | 4 变体 × 3 行 | `probe.js` ④ |
| 矮终端 6–9 行提案与现状**逐档等高** | 5/6/7/8（零增长） | `probe.js` ⑤ |
| 矮终端 5 行：现状与提案**同档**越屏 | 帧高 5 > 4（既有地板） | `probe.js` ⑤ |
| 补丁栈还原后与真源逐字节相等 | 14/14 条 | `patch.js` |
| 量具输出确定性 | 两次运行逐字节相同 | 实测 `diff` |
| 数据层齐备 `group`/`primary`/`secondary`/`groupMeta` 且 `name` 仍在 | 5 站点抽取、4 个选项对象 | `probe.js` ⓪ |
| apiAdapter 两处结构化 `upstreamProvider` | 2/2 站点 | `probe.js` ⓪ |
| 真 ModelPicker 浏览态画出组标题、搜索态不画 | 6 档 | `probe.js` ① |
| 接线后帧高仍与改前基线逐档相等 | 11/16/16/16/16/11 | `probe.js` ① + `modelPickerSize.test.js` PINNED |
| 经典路径改前 / 改后（纯函数 A/B） | 中位 **91 → 40 列**；超 80 列 **43/53 → 2/59** | `classic-path-gap.js` |
| 三个渲染面读数**逐项相等**（共享叶子的交叉验证） | 行数 59 / 执行方 8/59 / 前缀 0/59 / 中位 40 | `classic-path-gap.js` |
| 经典数字兜底：编号 ↔ 模型映射自证 | 53 个编号行 / 53 个 models，**错配 0** | `classic-path-gap.js` |
| 门控计数**未上升** | 236 → 236；本笔在 TUI 目录内新增 **0** 个 token | `npm run check:tui-gates`（见下方注） |
| 相关测试套件 | `modelPickerSize` 41/41、`autoModelSelect` 13/13、`gatewayAutoModelWiring` 7/7、`gatewayModelChoicesLeaf` **9/9** | jest / node:test |
| Q10 负对照：三条注入逐条精准 | 3 / 1 / 1 条变红（各自命中对应绑定点） | `q10-negative-control.js` |
| Q10 抖动机制取证：屏新 / handler 旧 | 回车前屏 `A-2`、回车后 `resolved=['A-1']`、**stdin 队列残留 0** | `q10-frame-dump.js` |
| Q10 抖动修法正对照（各 120 轮） | 旧写法 **6/120**（`#107–#111` 连续 5 轮）→ 修后 **0/120** | `q10-closure-ab.js` |
| Q10 抖动对「按键间隔」不敏感 | 40 / 150 / 300 ms 各 20 轮：**均 0**（⇒ 加延时治不了） | `q10-frame-dump.js` |
| Q12 负对照：四条注入逐条精准 | 3 / 2 / **1** / 2 条变红；还原逐字节相等、收尾 6/6 绿 | `classic-path-negative-control.js` |

> **注（`check:tui-gates` 的既有红）**：该守卫报 `FAIL — 236 unique KHY_* tokens (limit 227)`。
> 这不是本笔引入的，归因有三条独立证据：① `scripts/ci/check-tui-gates.js` 工作区**未改动**，
> `git show HEAD:` 版本里 `MAX_GATES` 也是 `227`；② 按 HEAD blob 重算 TUI 目录的 unique token 数
> **同样是 236**，工作区与 HEAD 的**差集为空**（新增 0 个）；③ 本笔在 TUI 目录内唯一的改动文件
> `ModelPicker.js` 含 **0 个** `KHY_*` token。守卫自己的注释也写着
> `Exception log 2026-09-23: 220 → 227. The cap was **already exceeded** before this`。
> ⇒ 上限 227 相对实际 236 已陈旧，属**独立一笔**（收口方式是 `--baseline 236`，或把 9 个门控
> 迁到 `~/.khyquant/tui.json`）；**本方案射程不含它，不代为决定**。

### 真数据复核（2026-09-30，补上「真实 49 项」这一格）

上一格长期写的是「夹具形态对齐、绝对字数不对齐 ⇒ 只当量级证据」。落地后已能**真跑** `apiAdapter.listModels()`
（无需网络探测，配置/池两路都在本机），于是把这一格补成实测：

```
node .khyos/tmp/p1-supply-chain.js      # 供数链路 + 透传 + buildEntries
node .khyos/tmp/p1-real-stats.js        # isDefault 分布 + 组段形态
```

| 断言 | 真数据读数 |
|---|---|
| apiAdapter 真的填上 `upstreamProvider` | **45/45 行**（`{"id":"opencode-zen:mimo-v2.6-flash-free","name":"OpenCode Zen / mimo-v2.6-flash-free","upstreamProvider":"OpenCode Zen"}`） |
| 两个中间层真的透传（`applyOverrides` / `filterByUpstreamAuthority`） | **45/45 → 45/45**，bypassed=false、dropped=0 |
| 分组键真的取到 provider，不是并成一组 | 归并前 **6 个段**：`OpenCode Zen`(6) `Anthropic`(5) `百炼 Token Plan（阿里云）`(4) `OpenCode Zen`(11) `TierFlow`(6) `agnes`(12) |
| **Q9 归并后**：同名段真的并成一段 | **6 段 → 5 段**：`OpenCode Zen`(**17**) `Anthropic`(6) `百炼 Token Plan（阿里云）`(4) `TierFlow`(6) `agnes`(12)；同名段 0 个 |
| **Q8 归并后**：大小写变体不再算两组 | 去重后供应商数（大小写敏感）**6** → （case-folded）**5** —— 症状**潜伏**，但**潜伏的原因不是「恰好相邻」**（那是本行初版写错的：量的是 `listModels()` 这一层）。准确原因见下方「真入口 A/B」第 1 条 |
| 归并是纯置换（不丢、不重） | OK —— 归并前后模型 id 集合等长同集 |
| `primary` 真的剥掉供应商前缀 | 45/45（`mimo-v2.6-flash-free` / `deepseek-v4-flash-free` …） |

**同时量出两个方案没预料到的缺陷**（先写进 §12 待裁决、不自行处置；**后经人裁决并已落地**）：

1. **`isDefault=true` 有 7 行**（OpenCode Zen 一家 2 个），按上游供应商分布
   `{OpenCode Zen:2, Anthropic:1, 百炼:1, TierFlow:1, agnes:1, anthropic:1}` ⇒ §12-Q3 从「仅主张」升级为**实测**，且比截图的 3 行更严重。**仍待裁决**（Q3 未动）。
2. **组名重复**：`Anthropic` 与 `anthropic`（大小写变体）被当成两个组；`OpenCode Zen` 因配置路与池路
   （`opencode-zen:` vs `api:opencode-zen:` 两套 id 命名空间）被切成**两个不连续段** ⇒ 屏幕上会出现两个近似/同名的组标题。
   去重后供应商 6 个、段也是 6 个 —— 段数没错，是**名字**重复。
   ⇒ **已裁决并落地**：Q8 按 case-folded 合并（`groupFoldOf`）、Q9 渲染前稳定归并（`stableGroupOrder`），
   见 §12-Q8/Q9 与本节上表；判据是真帧单测 2 条 + 真数据读数 6 段→5 段。

### 真入口 A/B（2026-10-01）：真跑 `buildGatewayModelChoices()` 喂真组件

上一格量的是 `apiAdapter.listModels()`，那是**数据层**；这一格量的是 `/model` 真正消费的那一层。
落地时 `name` 字段**一字未改**，所以「只喂 `name`」= 改前的输入形态、「喂全字段」= 改后的输入形态 ——
同一个组件、同一份真数据、同一个尺寸 ⇒ **两帧之差就是本改动之差**。

```
node .khyos/diag/model-picker-grouping/real-choices-ab.js   # 真探测 17 通道，~23s（本轮 73s）
# 落盘 real-choices.json（真 choices）+ real-choices-ab.txt（读数存证）
```

| 尺寸 | 指标（模型行） | 改前 | 改后（Q11 前） | 改后（Q11 后 = 现态） |
|---|---|---|---|---|
| 80×24 | 每行重复的 `(执行:…)` | **5** | **0** | **0** |
| 80×24 | 模型名里夹供应商前缀 | **6** | **0** | **0** |
| 80×24 | 被 `…` 截断 | **10 / 10** | **1 / 10** | **0 / 10** |
| 60×24 | 被 `…` 截断 | **10 / 11** | **2 / 11** | **1 / 11** |
| 120×40 | 被 `…` 截断 | **3 / 10** | **0 / 10** | **0 / 10** |

Q11 前剩下的那 1 行**正是 Auto 行**，而且被切掉的恰好是最有信息量的 `(当前最优: …)`（§12-Q11）⇒ 说明让位给预览后归零。现态 80×24 的 Auto 行：

```text
❯ 1.  ★ Auto                                          (当前最优: claude-opus-5::auto)
      ── Claude Code · 3 个 ── [可用-告警] ● claude probe timeout after … 
  2.  Claude Opus 5.0                                  视觉 [未证实·内置] 自动 ✓ 当前
```

⚠ 60×24 现态仍有 **1/11** 带 `…` —— 那是**合规降级**（判据是「要么显示、要么留可见 `…`」，它满足），不是静默丢失。真数据**时变**（见下第 3 条），所以判据一律钉**比率**。

**三个只有真入口才暴露出来的事实**（在数据层量不到）：

1. **`Anthropic`(5) 与 `anthropic`(1) 在真 `/model` 输出里是分开的两组。**
   准确的读数是：归并前 `Anthropic`(5) **有**标题、`anthropic`(1) 因为只有 1 条**不画标题**
   （`MIN_GROUP_FOR_SECTION = 2`）⇒ 症状确实潜伏，**但潜伏的原因是「单条组不画标题」，
   不是「恰好相邻」**。归并后二者合成 `── Anthropic · 6 个 ──` 一条标题（那 1 条孤行被并进组）。
   ⚠ 本节初版据 `listModels()` 那一层写成「恰好相邻」—— **量错了层**，已按此更正。
2. **Auto 是 ModelPicker 的**第 5 个** choice 产出点**，前 4 个都供了分层字段，它漏了 ⇒
   `字段未定义计数 = {group:1, primary:1, secondary:1, groupMeta:1}`，Auto 行成为**唯一
   不参与分层**的行，且静默依赖渲染侧 `c.primary || c.name` 回退。已补（见「落地账本」），
   补后 `字段未定义计数` 全 0（本轮 53 条真数据复跑同样全 0）。它随后又被 §12-Q11 收了一次：
   次信息**只留预览**，因为补上分层之后，全表被截断的那 1 行恰好就是它。
3. **真数据读数有抖动**：同一命令三次真跑得到 **36 条 / 52 条 / 53 条**（`agnes` 1 → 12，
   本轮多出 `Claude Code`(3) 与 `Web 中转服务`(1) 两组）—— 通道连通性探测与「低置信模型过滤」
   是时变的（本次日志：`已过滤 21 个低置信模型`、`防抖复检`、`已启动 5 个后台深测任务`）。
   ⇒ **判据要钉「关系 / 比率」，不要钉绝对条数**；上表的比率（5→0、6→0、10/10→0/10）
   在几次真跑里一致，绝对条数不一致。

**探针本身踩过的两个坑**（都已修，留作复用提示）：

- `buildGatewayModelChoices` 会起「**后台深测任务**」（strict 通道），它们持有定时器 ⇒
  事件循环不空，探针**必须显式 `process.exit`**，否则「跑完却挂着」（第一次跑了 17 分钟没退出）。
- 字段齐备性判据要用「**未定义**」而不是 `!c[k]`：`groupMeta: ''` 是**合法值**（无组级信息），
  用 falsy 判会把空串误报成缺失（第一版读成 `groupMeta 缺 1 条`）。

### 另一个表面：经典 REPL `/model`（2026-10-01 量差距 → 已治并复核）

`ModelPicker` 的头注释写着它「替代了经典 REPL 的 inquirer 选择器」，但**经典路径还在**：
`gatewayModelChoices.js` 把 `c.name` **平铺**喂给 inquirer（只有一个 `Separator` 在「返回」前，
组间没有分隔），数字兜底同样平铺 `c.name`。两个表面吃的是**同一份** `modelChoices` ——
**只治一个表面，另一个表面就仍是改前形态**（射程边界问题，§12-Q12 已裁决为「一并治」）。

```
node .khyos/diag/model-picker-grouping/classic-path-gap.js   # 读 real-choices.json，不真起 inquirer
```

**改前 vs 改后**（53 条真数据；「改前」= 手工重建旧实现的那一行 `...modelChoices.map(c => ({ name: c.name }))`，
`git show HEAD:services/backend/src/cli/handlers/gatewayModelChoices.js` 可复核它确实是 `name: c.name`；
「改后」= **真调** `buildClassicInquirerChoices` / `buildClassicNumericLines`，源一改读数当场跟着变）：

| 指标 | 改前（平铺 `c.name`） | 改后（inquirer） | 改后（数字兜底） | TUI |
|---|---|---|---|---|
| 含 `(执行:…)` | **50/53（94%）** | 8/59（14%） | 8/59（14%） | 8/59（14%） |
| 含「供应商 / 名」 | **47/53（89%）** | **0/59（0%）** | **0/59（0%）** | **0/59（0%）** |
| 宽度 中位 / 最大 | **91 / 122** | **40 / 101** | 44 / 105 | 40 / 101 |
| 超 80 列 | **43/53（81%）** | **2/59（3%）** | 2/59（3%） | 2/59（3%） |
| 超 60 列 | **51/53（96%）** | 8/59（14%） | 8/59（14%） | 8/59（14%） |

⇒ 经典路径**原本比 TUI 改前更差**（中位 91 列，80 列终端里每行折 2 行，可视条目直接减半）；
改后中位降到 **40 列**，且**三个渲染面的读数逐项相等** —— 这正是「同一套语义由共享叶子单点给出」的交叉验证。
剩下的 8 条含 `(执行:…)` 是**组标题行 + 单条组的孤儿回落**（每组一次，不再是每行一次），不是漏改。

**落地形状**（4 个纯函数 + 2 处接线，都从共享叶子取语义）：

```js
classicDisplayEntries(modelChoices)                      // = buildEntries(stableGroupOrder(list), '')
classicSectionText(entry)                                // = `── ${name} · ${count} 个 ──${meta ? ' ' + meta : ''}`
buildClassicInquirerChoices(modelChoices, inquirer, chalk)  // 组边界 → inquirer.Separator(dim(标题))；模型行 → primary + 次信息
buildClassicNumericLines(modelChoices, chalk)            // { lines, models }；编号只给模型行
```

两个要点：

1. **数字兜底的编号映射必须按显示序取**：`picked = numeric.models[idx - 1]`，**不是**按原始下标 ——
   归并改了模型下标，按原始下标取会让「屏幕上写 3.」与「按 3 选中的模型」脱节。
   （量具自证：53 个编号行 / 53 个 models，**错配 0 条**。）
2. **没有 ink 那套「模型下标 ↔ 条目下标」的桥风险**：inquirer 的 `Separator` **不可选中**
   （方向键会跳过它）⇒ 「屏幕上第 n 行」与「按 n 命中」不会脱节 —— 那是 ink 自己排版才有的风险。
   这也是为什么经典路径**不需要** TUI 那 5 处下标改绑。

数据层未动：`group` **53/53**、`primary` **53/53** 齐备 —— 升级经典路径**不必再动数据层**（原本就已就绪）。

### 仅主张（未实测，标出补测方式）

| 主张 | 补测方式 |
|---|---|
| ~~真实 49 项标签下的**绝对**截断数~~ | **已补测**（见上方「真入口 A/B」）：真跑 `buildGatewayModelChoices()`（53 条）喂真组件，截断率 80×24 **10/10 → 0/10**、60×24 **10/11 → 1/11**、120×40 **3/10 → 0/10**（含 §12-Q11 的 Auto 行收口）。⚠ 但真数据**时变**（三次跑 36 / 52 / 53 条）⇒ 判据取**比率**，绝对数只作当次快照 |
| 截图里 `✓ 当前` 出现在 3 行 | 真源看是**合理**的：`apiAdapter.js:726` `isDefault: mid === p.model` **按上游 provider 逐个判**，池路径 `:844` 同构 ⇒ 一个适配器下有几个 provider 就有几个 `isDefault`。但选择器把它渲染成「当前」（会话正在用的那个）⇒ **语义碰撞**：用户读到「3 个模型都是当前」。是否算缺陷需人裁决（§12-Q3） |
| 标题行在 256 色 / `NO_COLOR` 下的对比度 | 本轮只量帧高与宽度，未量 SGR。补测：`modelPickerSize.test.js` 已有 `unclosedSgr` 工具可直接复用 |
| ~~真机上 `padCell` 与 `clipCell` 不产生 1 列漂移~~ | **已补测**：落地已改用真源 `padCell`，不变量 `visWidth(padCell(s,w)) === w` 实测 0 违例（`tests/tui/modelPickerSize.test.js`） |

### 落地账本（步 1 / 步 2 改了什么、没改什么）

**改了** —— 全部是**加字段 / 加分支 / 抽叶子**，没有删掉任何既有字段：

| 文件 | 改动 |
|---|---|
| `cli/modelChoiceGrouping.js` | **新建**：共享纯叶子（零 require、零 IO）。`MIN_GROUP_FOR_SECTION` / `MIN_DISTINCT_GROUPS` / `groupKeyOf` / `groupFoldOf` / `stableGroupOrder` / `buildEntries` / `layeredTextOf`。放 `cli/` 根下而非 `cli/tui/` 下 —— `cli/handlers/**` 不得反向依赖 `cli/tui/**`（分层倒置 R1） |
| `cli/tui/wrapCell.js` | 新增 `padCell`（与 `clipCell` 共用同一把 `visWidth`） |
| `cli/tui/ink-components/ModelPicker.js` | 步 1 加纯函数；步 2 接线 5 处（entries / 数字键 / 窗口 / 行渲染 / scrollHint）；新增 `orphan` 回落分支；**Q8/Q9 收口**：加 `groupFoldOf` / `stableGroupOrder`，`buildEntries` 段边界改按 fold 判，新增 `shown` 显示序并把 5 处下标（`initialCursor` / `moveCursor` / `choose` / 数字键 / `scrollHint` 分母）全部改绑到它；**Q12 收口**：本地约 115 行纯函数删除，改为 `require('../../modelChoiceGrouping')`，行渲染改用 `layeredTextOf(e)`（`module.exports.*` 仍转发，调用方零改动）；**Q10 抖动收口**：加 `cursorRef`（**render 期**赋值）+ 回车改读 `cursorRef.current` —— 治「屏已新、handler 还是上一拍」的窗口（§9-21，正对照 6/120 → 0/120） |
| `cli/handlers/gatewayModelChoices.js` | 三处 `modelChoices.push` 加 `group`/`primary`/`secondary`/`groupMeta`；新增 `_stripProviderPrefix`；组级三件套 hoist 成 `groupMeta`；**Q12 收口（经典路径）**：新增 `classicDisplayEntries` / `classicSectionText` / `buildClassicInquirerChoices` / `buildClassicNumericLines` 并导出，两处 inquirer `choices` 与两处数字兜底全部改用它；**Q12 收口（补零覆盖）**：把两处数字兜底里的 `picked = numeric.models[idx - 1]` 抽成可单测的纯函数 `resolveNumericPick(numeric, rawAnswer)`（返回 `{ok, choice}` / `{ok:false, reason}`，`reason ∈ cancel / out-of-range / disabled`）并导出 —— 此前**调用点本身零测试覆盖**（量具只验了 builder 的映射，没验「按显示序取」这一行） |
| `services/gateway/adapters/apiAdapter.js` | 两处 `rows.push` 加既有字段 `upstreamProvider` |
| `services/gateway/autoModelSelect.js` | **第 5 个产出点**（Auto 行）：`buildAutoChoice` 加 `group`/`primary`/`secondary`/`groupMeta`；**Q11 收口**：`secondary` 改为**只放预览**（去掉 17 字说明），无预览时为空串，fail-soft 分支 `secondary: ''`。`name` **一字未改**（逐字相等，单测钉到字节） |
| `tests/autoModelSelect.test.js` | 扩展既有用例：钉「分层字段齐备」+「`name` 一字未改」（含预览时的完整字面）+「次信息只留预览」+ fail-soft 分支齐备 |
| `tests/tui/modelPickerSize.test.js` | 扩展既有文件（不新建）：分组不变量 / 来源标签保真 / 帧高 PINNED 表；**Q8/Q9 收口** +6 条；**Q10 收口** +5 条端到端下标判据；测试骨架加「记录 `onResolve` 的选中值」与**逐键就绪闸 `cursorGates`**（`[{at, cursor}]` = 「发完 `at` 个键后等 ❯ 到目标行再发下一个键」）+ `gateTimeouts` **显式失败**（纯增）；**加文件级 `jest.setTimeout(30000)`** |
| `tests/cli/handlers/gatewayModelChoicesLeaf.test.js` | **Q12 收口** +6 条（原 3 条 + 4 条 → **9 条**）：夹具真被重排的前提 / inquirer 的 `Separator` 组边界与分层 label / 数字兜底编号映射自证 / 单条组不画分隔 + 孤儿回落 / **`resolveNumericPick`：输入编号 → 选中的是显示序那一条**（含逐行自证「`resolveNumericPick(n)` == 屏幕上第 n 行」）/ **`resolveNumericPick`：取消 / 越界 / 不可选 三条边界各自可辨** |

**没改**：

- `name` **一字未动**（`advisor.js` 的 label 契约 + `ModelPicker.filterChoices` 的搜索匹配文本）。
- 未新增门控、未登记规则、未加 `scripts/ci/` 检查器、未动门档阶段表。
- 未合并三处并行帧预算（§1.5）。
- 未修 5 行档的越屏地板（§12-Q7）。
- **未修**「丢键」那一族（`permissionsPromptDigitFooter` 数字键 `2` 的效果丢、`keyHandlerFreshClosure` BUG-62 多键序列）：**仍未定位**，且本笔**已证明**它不是 `ModelPicker` 那条抖动的原因（判据：stdin 队列残留，§9-21/22）。本笔**改的**是另一条 —— `choose(cursor)` 读陈旧闭包，已用 `cursorRef` 修掉。

### 全量套件跑的两轮读数：本笔的红 vs 别人的红（2026-10-02）

`npm run --workspace services/backend test:tui`（= `tests/tui` 全部 52 个套件，`--runInBand`）：

| 轮次 | 失败套件 | 失败用例 | `modelPickerSize` |
|---|---|---|---|
| 第 1 轮（Q10 用单道闸） | **7** / 52 | **18** / 797 | ❌ 红（`↓×2+Enter` 实得 `A-1`） |
| 第 2 轮（Q10 改逐键闸后） | **4** / 52 | **15** / 797 | ✅ **绿** |
| 第 3 轮（`cursorRef` 修掉闭包陈旧后） | 待全量复跑 | 待全量复跑 | ✅ 单文件 **12/12 组跑 + 3/3 整文件（41/41）** |

> ⚠ 第 2 轮的「✅ 绿」是**运气**：同一条用例的抖动率约 3–5%，单次跑绿不能证明治好（第 2 轮之后我又实测到 1/6、1/12 各一次红）。**第 3 轮才是有判据的**：先定位机制（§9-21），再正对照 120 轮 6/120 → 0/120，最后 12 次组跑 + 3 次整文件全绿。⇒ **「一次绿」不是验收，`N 次全绿 + 正对照`才是**。

**剩下 4 个失败套件全部不是本笔**，逐个归因（判据是「**零引用**本笔改的模块」—— 结构上不可能由本笔引起）：

| 失败套件 | 症状 | 归因 |
|---|---|---|
| `permissionNotice` | 期望 `⛔ 高危操作需要授权`、实得 `◉ …` | **在途去 emoji 改动**：`src/cli/tui/permissionNotice.js` 工作区里已是 `◉`（`git status` 显示 ` M`），测试文件未改 ⇒ 源在它脚下被改 |
| `helpMenuSize` | 期望帧高 18、实得 21 | 在途改动：`src/cli/tui/ink-components/` 下 20+ 文件被改（`ChatColumn.js` / `CcViewStack.js` / `App.js` / `ToolLines.js` …） |
| `inkRenderSmoke` | ProcessGroup / Transcript 渲染 | 该测试文件**自身**在 `git status` 里是 ` M`（在途改动的一部分） |
| `ccOverlayFit` | CcApp busy 帧让位梯 / AgentTree 行数进账本（BUG-91/92/93/95） | 依赖链（`CcApp` / `CcViewStack` / `CcTranscriptView` / `chromeBudget` / `ccLayout` / `agentTreeView`）**零引用** `ModelPicker` / `modelChoiceGrouping` ⇒ 与本笔无关；其直接依赖 `ink-components/CcViewStack.js` 在途被改 |

**另有两个套件是间歇性红**（第 1 轮红、第 2 轮绿）：`keyHandlerFreshClosure`（BUG-62 多键序列）与
`permissionsPromptDigitFooter`（数字键 `2` 的效果丢）。
- ⚠ **归因更正（2026-10-02）**：本节初版据此推断「`modelPickerSize` 的 Q10 抖动与它们是**同一类**跨组件竞态」—— **该推断已被证伪**。取证（`q10-frame-dump.js`）显示 Q10 那条的 **stdin 队列残留 = 0**（键被消费了），机制是 `choose(cursor)` 读陈旧闭包（§9-21），**与「丢键」不是同一机制**，且已修（`cursorRef`，正对照 6/120 → 0/120）。
- ⇒ 上面这两个套件的间歇性红**仍然未定位**，但它们与 Q10 的那条**不是同一个原因**；本笔不再替它们下结论。
- ⚠ `git status` 里 `services/` 下另有大量 ` M`（如去 emoji 改动、`ChatColumn.js`、`helpMenuSize` 相关，mtime 2026-09-28 起）—— 那是**前轮 / 他人在途**，不是本方案产物，请勿归到本笔。**已按「谁的红」四步归因**：`tests/tui/permissionNotice.test.js`（期望 `⛔`、实得 `◉`）与 `tests/tui/helpMenuSize.test.js`（期望 18、实得 21）都是**别人在途改动**的红，本笔零引用它们的被测模块。

---

## 12. 未决问题（需人裁决，不代为决定）

| # | 问题 | 选项与代价 |
|---|---|---|
| ~~**Q1**~~ | ~~分组键走 **P1（扩真源）** 还是 **P2（兜底）**？~~ | **已裁决并落地：走 P1**（人裁决 2026-09-30）。落地形状与本文原写有两处偏离（`name` 不拆、填既有 `upstreamProvider` 而非新字段），见 §8 步 2 下方的「三处偏离」表 |
| **Q2** | 标题行样式？ | 当前原型是 `── X · N 个 ──`（无折叠）。备选：`▸ X`（可折叠，但要加折叠状态与键位，牵动 §2.3 的维度问题）、`X` 顶格（省 4 列，但左边界与模型行不齐） |
| **Q3** | `✓ 当前` 的语义碰撞要不要一并修？ | 真源是「每个上游 provider 各有一个默认模型」，UI 却写「当前」。**真数据实测：45 行里 `isDefault=true` 有 7 行**，分布 `{OpenCode Zen:2, Anthropic:1, 百炼:1, TierFlow:1, agnes:1, anthropic:1}`（截图里只有 3 行，真机更严重 —— 一家供应商就占了 2 个）。选项：① 改成 `✓ 本通道默认`（准确但啰嗦）；② 只给**会话当前模型**打 `✓ 当前`，其余 provider 默认不打；③ 不动。**②最符合用户直觉，但需要数据层区分两个概念**，超出本方案射程 |
| **Q4** | 搜索态要不要保留分组？ | 我建议不保留（§4.1）。但「搜索后仍想知道是哪家的」也成立——那就得把组名压进行内（`OpenCode Zen / mimo-v2.5-free`），即回到现状的写法 |
| **Q5** | 三处并行帧预算（§1.5）要不要合并？ | 合并能消掉一整类「同一个数三处算」的漂移，但会牵动 4+ 个浮层与它们的既有测试。**我建议另立提案**，本方案只复用不合并 |
| **Q6** | 组标题要不要承载「本组有多少个可用/告警」？ | 当前原型把 `● 3327ms` / `● 告警` 放上去了（消重）。但组内若出现**部分告警**（`generationWarn` 是适配器级、均匀的，理论上不会），标题会失真。需要确认 `generationWarn` 的粒度保证 |
| ~~**Q8**~~ | ~~组名大小写变体（`Anthropic` / `anthropic`）要不要合并成一组？~~ | **已裁决并落地：按 case-folded 合并**（人裁决 2026-09-30，选项 ①）。落地：`groupFoldOf()` 只作**比较键**，`buildEntries` 的段边界按它判、标题名仍取 `groupKeyOf` 的首现原拼写 —— 组名语义输入仍只有一处，没有第二份真源（`ModelPicker.js:82-84`、`:141-152`）。判据：`tests/tui/modelPickerSize.test.js` 两条（纯函数 + 真帧各一），真帧实测屏上只有 1 条 `Anthropic` 标题、计数 3。**未采纳 ③**（不动适配器供数）的理由：那是改真源拼写，会让「显示名」与「配置里的名」脱钩，代价大于收益 |
| ~~**Q9**~~ | ~~同一供应商被切成两个不连续段（`OpenCode Zen` 6 + 11）要不要并成一段？~~ | **已裁决并落地：渲染前按组键稳定排序合并**（人裁决 2026-09-30，选项 ①）。落地：`stableGroupOrder()` 按组键**首现序**做稳定归并（**不是字母序** —— 字母序会把组本身重排，而现有顺序可能是有意的优先级），组内保原序（`ModelPicker.js:96-109`）。⚠ 归并改变了模型下标 ⇒ `cursor` / `choose` / 数字键 / `initialCursor` / `（n/N）` 全部改绑到同一份 `shown`，否则重现「屏幕上第 5 行 ≠ 按 5 选中的模型」。**只在浏览态归并**，搜索态不动（结果已按相关度排好，再按组归并会把相关度打散）。判据：真帧实测两个同名段并成 1 条 `OpenCode Zen · 7 个` |
| ~~**Q10**~~ | ~~归并（Q9）后的**下标一致性**要不要补一条端到端判据？~~ | **已按选项 ① 落地**（2026-10-01）：补 5 条真帧判据（数字键落点 / `↓×2+Enter` / `defaultValue` 开局光标 / `（n/N）` 分母 / 「夹具真被重排」前提）。两条设计约束写进测试注释：① 判据必须挂 `onResolve` 的 **value**（❯ 的位置分辨不出来 —— 高亮走 `e.mi === cursor`，`e.mi` 已在显示序）；② 夹具必须**输入序 ≠ 显示序**，否则 `stableGroupOrder` 是恒等映射、断言恒真。**负对照实测**：注入「绑回输入序」⇒ 3/5 变红。**抖动收口（2026-10-02）**：该组曾以约 3–5% 概率间歇性红（期望 `A-2` 实得 `A-1`），取证后确认**不是丢键**、而是 `choose(cursor)` 读 render 期闭包（ink 在 passive effect 里才重订阅 handler，帧却在 layout effect 里写出去）⇒ 加 `cursorRef` 在 render 期赋值、回车读它；正对照各 120 轮 **6/120 → 0/120**。见 §9-21/22 |
| ~~**Q12**~~ | ~~射程边界：**经典 REPL 的 `/model`** 要不要一并治？~~ | **已裁决并落地：一并治**（人裁决 2026-10-01，选项 ①）。落地：把分组/分层语义抽成**共享叶子** `cli/modelChoiceGrouping.js`（`ModelPicker` 改为 `require` 它、本地约 115 行删除），`gatewayModelChoices.js` 新增 4 个纯函数并替换两处 inquirer `choices` + 两处数字兜底；数字兜底的编号映射改按**显示序**取（`picked = numeric.models[idx - 1]`，否则归并后「写 3. 的行」与「按 3 选中」脱节）。**未采纳 ②**（另立一笔）的理由：两个表面吃**同一份** `modelChoices`，只治一个 = 同一个列表两种语义；而把语义复制一份到 `cli/handlers/**` 会反向依赖 `cli/tui/**`（分层倒置 R1）⇒ 只能抽叶子，不能复制。判据：4 条单测（`gatewayModelChoicesLeaf`）+ 纯函数 A/B（中位 **91 → 40 列**、超 80 列 **43/53 → 2/59**、三个渲染面读数**逐项相等**）。**收尾又补两处**：① 发现「按显示序取」那一行（`models[idx-1]`）在调用点**零覆盖** ⇒ 抽 `resolveNumericPick` 可单测化，测试 **7 → 9 条**；② 补**负对照**（四条注入：不归并 / 差一位 / 边界混淆 / 标题丢 meta）⇒ 分别让 **3 / 2 / 1 / 2** 条变红，其中「边界各自可辨」被 F **精准单点**命中 ⇒ 断言非恒真。见 §9「Q12 负对照」 |
| ~~**Q11**~~ | ~~Auto 行的 17 字样板文要不要让位给 `(当前最优: X)`？~~ | **已裁决并落地：行内只留 `★ Auto` + 预览**（人裁决 2026-10-01，选项 ①）。落地：`buildAutoChoice` 的 `secondary` 改为**只放预览**（无预览时空串），fail-soft 分支同样；`name` **一字未改** —— 仍供两个既有消费者用（`advisor.js` 的候选 label、`ModelPicker.filterChoices` 的搜索匹配文本），单测把 `name` 钉到**字节**。判据：真入口 A/B 80×24 被截断 **1/10 → 0/10**、60×24 **2/11 → 1/11**。**未采纳 ②**（压成 `自动选型`）的理由：仍要动文案，却没解决「说明与预览争同一行宽度」这个零和；**未采纳 ③**（不动）的理由：那是把最有信息量的一段让给最没信息量的一段 —— 最差的一种截断 |

| **Q7** | 5 行档的越屏地板要不要一并修？ | §9-11 实测：`rows=5` 时现状与提案**同档**越屏（帧高 5 > `rows−1` = 4），6 行起正常。这是**既有**行为、非本方案引入，但确实是缺陷。选项：① 本方案不管（推荐——保持「只治模型选择列表的划分与分层」这一射程，越屏另立一笔）；② 在 `pickerPageRows` 里加「预算不足则整体不渲染提示行」的降级，代价是牵动全部浮层与它们的测试 |

---

## 附：本文与截图的一一对应

| 截图现象 | 本文定位 |
|---|---|
| 49 项平铺、没有分组 | §1.1（分组字段被丢）+ §1.3（标题 0） |
| `（执行：API 云端服务/api）` 在每行重复 | §1.2（所有云端供应商共用一个适配器）+ §1.4（消重） |
| `OpenCode Zen /`、`百炼 Token Plan（阿里云）/` 写在模型名里 | §1.2（上游供应商名只以展示串存在 ⇒ P1 要把它升格为字段） |
| 状态标签 `[可用]` / `[可用-告警]` 在行首 | §4.2（上移组标题） |
| `● 3327ms` 每行相同 | §1.4（每通道一份的事实被复制 49 遍） |
| `✓ 当前` 出现在 3 行 | §11 仅主张 + §12-Q3 |
| 第 10 行起没有数字序号 | §1.3-3（`windowPos < 9` 限制）+ 提案把它从 75% 提到 90% |
| `claude probe timeout after…` 被切断 | §1.4（截断率 80% → 10%） |
