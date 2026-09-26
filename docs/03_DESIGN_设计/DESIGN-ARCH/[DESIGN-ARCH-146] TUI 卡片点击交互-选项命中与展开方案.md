# [DESIGN-ARCH-146] TUI 卡片点击交互：选项命中与展开方案

> **文档类型**：设计族（`DESIGN-ARCH-*`）· 状态：**方案（待评审）** · 日期：2026-09-24
> **上游**：[DESIGN-ARCH-101] TUI 交互与展示规则细则、[DESIGN-ARCH-119] TUI 原生文本选择与复制可用性修复、[DESIGN-ARCH-129] TUI 滚动-选择-历史-固定底部共存设计
> **相关规则**：`RUNTIME-001`（零硬编码）、`RUNTIME-002`（状态透明）、`RUNTIME-003`（活动式超时）、`RUNTIME-004`（无滚动区 UI）、`RUNTIME-007`（修复先复现）、`RUNTIME-008`（新增先提问）、`RUNTIME-009`（删除先报部位）
> **存证**：`.khy/feedback/DESIGN-ARCH-146-card-click/`（`repro-before.txt` + `card-click-probe.cjs`）

---

## 1. 需求与现状（`RUNTIME-008` 需求五问）

### 1.1 原始需求

> 「khyos 的选择卡片和条件卡片，点击事件在 TUI 中怎么响应需要设计一个方案，比如点击选择选项 1，或者是点击展开等。」

### 1.2 需求五问

| 问 | 答 |
|---|---|
| **谁需要** | 使用 khy TUI 的交互用户；在 `/` 菜单、AskUserQuestion 选项卡、权限确认卡上操作的人 |
| **解决什么** | 现在**只能键盘**（↑/↓ + 数字键 + Enter）。鼠标点击**完全无响应** —— 点了没有任何反馈，用户会怀疑「是不是卡死了」 |
| **不做会怎样** | 与「点击展开」已实现的工具卡片（`ToolLines.js`）形成**同类交互不一致**：同一屏里工具卡可点、选项卡不可点 |
| **边界在哪** | 只做**卡片内**的点击（选项行、展开/折叠、可讨论、Other）。不做拖拽、不做跨卡片拖放、不改既有键盘路径 |
| **怎么算完成** | ① 点「选项 1」＝选中第 1 项（多选卡＝切换该项勾选）；② 点「展开」＝切换该块展开态；③ **档位为 `off` 时逐字节零影响**；④ 不破坏「在卡片上拖选复制文字」 |

### 1.3 `source`（`RUNTIME-008`）

- **既有范式**：`services/backend/src/cli/tui/ink-components/ToolLines.js` L1381-1402 —— 工具卡片整块 `<Box>` 挂 `onClick: () => handleToolClick(i, t)`，`toolExpanded` Map 逐工具切换展开态，提示文案 `[点击展开] / [点击折叠]`（L1204-1214）。**本方案复用这一范式，不新造机制。**
- **既有基础设施**：`services/backend/src/cli/tui/mouseButtons.js`（`createMouseDispatcher` / `collectLayout` / `hitTest`）+ `App.js` `onSelectEvent`（L1538-1745）。
- **既有门控口径**：`OFF_VALUES = ['0','false','off','no']`（显式 falsy 关，其余含 unset 开）。

---

## 2. 实体定位（**先定名再设计**）

用户说的两个名词在代码里**都不存在同名实体** —— `grep -rn "SelectionCard\|ConditionCard"` 全仓**零命中**。
⇒ 必须按**引用计数**而不是按命名映射。这是本方案的第一条纪律。

| 用户说法 | 真实实体 | 判定依据 |
|---|---|---|
| **选择卡片** | `ink-components/QuestionPrompt.js`（735 行）<br>纯逻辑真源 `ink-components/questionCardModel.js`（244 行） | 自持 `useInput`（L241）；`App.js` L4805 `if (query.controlRequest) return;` 让键；行布局 `rowCount = optionsLen + 2` |
| **条件卡片** | `ink-components/PermissionsPrompt.js`（543 行） | 头注释 `Mirrors QuestionPrompt's interaction model`；同一套 `cardLayout` 排版；同样**零鼠标分支** |
| **点击展开** | `ink-components/ToolLines.js` 工具卡片 | L1381-1402 整卡 Box 挂 `onClick`；`toolExpanded` Map |

### ⚠ 排除项：`CcSelectable.js` 是死代码

`ink-components/CcSelectable.js`（228 行）**看起来像候选，但不是**：

- `git grep "CcSelectable"` **只命中它自身**（定义 + `module.exports`）—— **全仓零使用点**；
- 其头注释第 10 行自称「鼠标点击支持」，但**实现里零点击处理器** ⇒ **注释与实现不符**；
- 内含的 4 个组件（`CcSelectableList` / `CcMultiSelectList` / `CcPermissionPrompt` / `CcMessageBar`）的 `useInput` 里**均无鼠标分支**。

⇒ **教训沉淀**：「命名像」≠「是目标」。**判定必须靠引用计数**（`git grep` 命中数 = 1 即死代码）。

---

## 3. 根因：缺口的三层结构

### 3.1 第一层 —— 卡片把鼠标事件「消费即丢弃」

`QuestionPrompt.js` L261-267 原文：

```js
// Mouse-button layer: consume SGR mouse sequences (dispatched by App's top
// useInput) so they are never inserted into the typed-cursor buffer.
try {
  const _mouse = require('../mouseButtons');
  if (_mouse && typeof _mouse.isMouseSequence === 'function' && _mouse.isMouseSequence(ch)) {
    return;          // ← 只 return，不做任何分派
  }
} catch {
  /* mouseButtons unavailable — skip guard */
}
```

它**只 `return`，不做任何事** —— 事件到了卡片门口被原地丢弃。

### 3.2 第二层 —— 即使不丢，行也**不在命中区**

`mouseButtons.collectLayout` L387-392 的判定条件是**「`onClick`/`onMouseUp`/`onMouseOver`/`onMouseOut` 任一为 function」**。
而 `QuestionPrompt.js` L652-656 的行节点：

```js
const rowNodes = rowSpecs.map((s) => h(
  Text,
  { key: s.key, color: s.color, bold: s.bold, dimColor: s.dim },   // ← 零鼠标 prop
  rowLinesOf(s, rowMode).join('\n')
));
```

⇒ **行压根不在命中区**。挂 handler 是「进命中区」的唯一途径。

### 3.3 第三层 —— 守卫位置有独立缺陷

该守卫位于 `if (reviewing) {…}`（L246）**之后**、`if (typing) {…}`（L273）**之前**：

- **Review 步与 typing 自由输入态拦不到鼠标序列**；
- `typing` 分支 L320 `if (ch && !key.ctrl && !key.meta)` 会把 `[<0;…M` **当字面文本插进输入缓冲**。

⇒ 修卡片点击时**必须顺手把守卫提到 `reviewing` 之前**。

---

## 4. 复现证据（`RUNTIME-007`）

探针 `.khy/feedback/DESIGN-ARCH-146-card-click/card-click-probe.cjs`，存证 `repro-before.txt`。

```
=== A) 静态取证：卡片行节点是否在命中区内 ===
FAIL  A1 QuestionPrompt.rowNodes 挂有鼠标 prop  — 无
FAIL  A2 PermissionsPrompt 整体含鼠标 prop  — 无
PASS  A3 QuestionPrompt 鼠标守卫「只 return 不分派」  — 确认：消费即丢弃

=== B) 动态取证：真 collectLayout 命中测试（反向对照）===
PASS  B0 mouseButtons 可 require  — collectLayout 存在
PASS  B1 反向对照：行不挂 prop ⇒ hitTest 命中不到该行  — 确认缺陷（命中 null）
PASS  B2 正向对照：行挂 prop ⇒ hitTest 命中该行  — 确认：该行可命中
PASS  B3 命中后触发的是「那一行」的回调  — rowClicks=[1]（期望 [1]＝第 2 行 y=2）
PASS  B4 粒度对照：整卡挂一个 handler ⇒ 不同行命中同一节点（无法区分选项）

Summary: 6/8 PASS, 2 FAIL
```

**读法**：A1/A2 两个 FAIL **就是缺陷本身**（行无鼠标 prop）；B1–B4 全 PASS **证明疗法可行且非平凡**：

- B1（不挂 prop → 命中 `null`）与 B2（挂 prop → 命中该行）是**同一基础设施上的反向对照**，
  证明 B2 不是恒真；
- B3 证明「点哪行 = 触发哪行的回调」（粒度正确）；
- B4 证明「整卡挂一个 handler」**不足以**「点选项 1 选中选项 1」⇒ 必须**逐行挂**。

> ⚠ **探针纪律**：B1 与 B2 构成反向对照。若只有 B2，`hitTest` 返常量即可让断言恒真。
> 另：`hitTest(layout, col, row, offset)` 的 `offset` 是**数字**（非对象）。首版探针误传 `{screenTop:0}`
> ⇒ `y0 = it.y + {}` = `NaN` ⇒ 永不命中、B2/B4 假 FAIL。**这一坑已记入踩坑清单。**

---

## 5. 关键架构事实（**决定方案形态**）

### 5.1 ★★ App 在**让键给 overlay 之前**就已经处理了鼠标

`App.js` 顶层 `khyKeyHandler` 的**第 0 段**（L4694-4763）：

```js
_keyHandlerRef.current = function khyKeyHandler(input, key) {
  // 0) Mouse events own the top slot: …
  if (_mouse && mouseDispatcherRef.current && _mouse.isMouseSequence(input)) {
    …
    mouseDispatcherRef.current.onInput(input, {
      rootNode: (_inst && _inst.rootNode) || null,
      rows: _rows, anchorBottom: _anchorBottom, screenTop: _screenTop,
      cacheKey: (_inst && _inst.lastOutput) || '',
    });
    return;                     // ← 鼠标事件在这里就结束了
  }
  …
  if (query.controlRequest) { return; }   // L4805 —— 让键给 overlay（只对**键盘**生效）
```

**推论（本方案的核心）**：

- 鼠标分派发生在**第 0 段**，`return` 距 `query.controlRequest` 的让键点**还有 40 多行**；
- ⇒ **卡片的 `useInput` 根本收不到鼠标序列**（它们已被 App 吞掉），
  所以 **§3.3 的守卫其实是「死代码」** —— 它以为自己拦到了，实则 App 早就拦了；
- ⇒ **卡片要响应点击，不需要在自己的 `useInput` 里解析鼠标序列**，
  只需**给行节点挂 `onClick`**，剩下的交给 App 的既有分派链路。**这是最小改动路径。**

### 5.2 ★★ `collectLayout` 遍历**整棵树**，不看 overlay

`mouseButtons.js` L363-412：`walk(rootNode, 0, 0)` **无条件 DFS 全部子节点**，
`if (!node || node.internal_static) return;` 是**唯一**的排除条件。

⇒ overlay 卡片是 root 的后代 ⇒ **只要行节点挂了 handler，就自动进 `hitTest`**，
**无需任何「overlay 注册」步骤**。

### 5.3 ★ 命中的是**最上层**（渲染顺序靠后）

`hitTest` L512-521 遍历 `layout.items`，**后者覆盖前者**（`best = it` 无条件赋值）。
⇒ overlay 若渲染在正常内容**之后**，则 overlay 上的点击优先命中 —— 与视觉层级一致，无需额外处理。

### 5.4 ★★ 点击 vs 拖选：由**终点**区分，不由起点

`mouseButtons.js` L776-820 释放分支：

```js
const hit = hitTest(layout, ev.col, ev.row, offset);
if (hit) pendingClick = true;                    // 按下时记录「有命中」
if (selectEnabled) fireSelect('down', ev);       // 但 down **无条件上报**
return !!hit;
…
// 释放：
const wasClick = pendingClick; pendingClick = false;
const item = hitTest(layout, ev.col, ev.row, offset);
const consumed = selectEnabled ? fireSelect('up', ev) : false;
if (item) {
  const handler = wasClick && !consumed && style ? style.onMouseUp || style.onClick : null;
  if (typeof handler === 'function') { try { handler(ev); } catch { /* fail-soft */ } }
  return true;
}
```

**判据**：

- `down` **不论命中与否都上报**（L530-575 注释记录了历史缺陷：曾经「命中即吞」⇒ **拖选没有起点**）；
- 算不算「点击」＝ `wasClick && !consumed`，`consumed` 来自 `onSelectEvent('up')` **严格 `=== true`**。

⇒ **给卡片挂 `onClick` 不会破坏「在卡片上拖选复制文字」** ——
拖拽时释放点与按下点不同宽/或选择层已消费 ⇒ `consumed === true` ⇒ **不触发点击**。
**这是本方案的安全性核心论证**，也是评审时必须复验的一条。

### 5.5 ★ 命中粒度**由挂点决定**

- 挂在**整块卡片 Box**：整卡一个点击（`ToolLines` 的展开语义刚好够用，见 §5.1 范式）；
- 挂在**每一行 Text**：点哪行就是哪行（「点选项 1 选中选项 1」**必须**这样）。

---

## 6. 设计方案

### 6.1 总原则

| 原则 | 内容 |
|---|---|
| **最小改动** | 复用 App 既有分派链路（§5.1）⇒ 卡片**不新增鼠标解析代码** |
| **零影响承诺** | 门控关 / 非浮层挂载点 / 档位 `off` ⇒ **逐字节回退**到改前形态 |
| **不破既有承诺** | 拖选复制、键盘路径、`BUG-36b` 待裁决项**一律不动** |
| **单一真源** | 行 → 下标的映射**只从 `rowSpecs` 派生**，不二次硬编码（`RUNTIME-001`） |

### 6.2 选择卡片（`QuestionPrompt.js`）改造

**① 给行挂 handler**（L652-656 改为）：

```js
const rowNodes = rowSpecs.map((s, i) => h(
  Text,
  {
    key: s.key,
    color: s.color, bold: s.bold, dimColor: s.dim,
    // 仅在选择层可点时挂载 ⇒ 档位 off 时树与改前**完全相同**
    onClick: clickEnabled ? () => onRowClick(i) : undefined,
  },
  rowLinesOf(s, rowMode).join('\n')
));
```

**② `onRowClick(i)` 语义**（**复用既有的键盘逻辑，零新语义**）：

下标的含义由 `rowSpecs` 的构造顺序（L487-522）唯一确定：

| 下标区间 | 行 | 点击行为 |
|---|---|---|
| `0 .. options.length-1` | 真实选项 | 单选：**等于按数字键 `i+1`**（选中并提交本卡）<br>多选：**切换该行勾选**（等于 Space） |
| `options.length` | 「可讨论」 | 等于按对应数字键（落 `discuss`） |
| `options.length+1` | Other | 等于按对应数字键 ⇒ 进 `typing` 态 |

⇒ 实现只需**调用既有的数字键分支同一函数**，**不新写一套选择逻辑**。
（多卡时左右环绕、卡内上下环绕、惰性回退**全部由既有逻辑负责**，不重复实现。）

**③ 修掉守卫位置**（§3.3）：把 L261-270 的守卫**移到 `if (reviewing)` 之前**。

⚠⚠ **必须「移动」而不是「复制」** —— 即**在插入新守卫的同一个编辑里删除原守卫**。
（原型 `prototype-applicability.cjs` 的 **C4 实测**：只做插入 ⇒ 源码里出现 **2 处** `isMouseSequence(ch)`
⇒ 守卫重复。虽然功能上无害（第一次就 `return`），但**留一处死代码**且违反「单一真源」。）

正确形态（**一增一删**）：

```js
// ① 在 `// Review 步:…` 注释之前**新增**守卫
// ② 同时**删除**原 L261-270 那段（`// Mouse-button layer: consume SGR …` 整块）
```

注意：按 §5.1，这守卫对鼠标序列其实**收不到**（App 顶层先吞了）；
保留它是为了**防御未来 App 分派顺序变化**，并顺手消除「typing 态被 `[<0;…M` 污染」的可能。
**移动本身零行为变化**，因为它对真实输入是 no-op。

> **落点锚点（原型实测唯一命中）**：
> - 守卫前移锚点 ＝ `    // Review 步:Enter 提交 / Tab 与 ←→ 回上一卡改 / Esc 取消(上游同款三键)\n    if (reviewing) {`
> - `rowNodes` 锚点 ＝ `const rowNodes = rowSpecs.map((s) => h(` … `rowLinesOf(s, rowMode).join('\n')\n  ));`
>
> 两处均为**唯一命中**（`original.split(anchor).length === 2`）；替换后 `node --check` 通过；
> 回退后与原文**逐字节相等**。这些是落盘时的**机械化前置检查**，见 §11.1 #12。

**④ 「点击展开」语义**：选择卡片**暂无**「展开」需求（选项说明由 `BUG-57` 尺寸阶梯自动降档）。
若后续需要「点选项行展开它的完整说明」，**复用 `ToolLines` 的 `toolExpanded` Map 范式**
（`Map<rowIndex, bool>` + `[点击展开]/[点击折叠]` 提示），但**本次不实现** —— 依 `RUNTIME-008`，
无需求不新增。

### 6.3 条件卡片（`PermissionsPrompt.js`）改造

**① 给选项行挂 handler**（L365 的 `kind: 'option'` 行）：

```js
rowSpecs.push({
  key: opt.key, kind: 'option',
  head: `${active ? MARKER : ' '} ${opt.label}`, tail: String(i + 1),
  active, danger: !!opt.danger,
  onClick: clickEnabled ? () => onChoose(i) : undefined,   // ← 新增
});
```

（渲染处 **L405-421** 的 `for (const spec of rowSpecs)` 循环里，同样要**把 `onClick` 透传到 `<Text>`**：）

```js
children.push(h(Text, {
  key: spec.key,
  color: colorOf(spec), dimColor: dimOf(spec),
  bold: spec.kind === 'title' || !!spec.active,
  onClick: spec.onClick,        // ← 新增：透传（undefined 时 ink Box 不写入 style ⇒ 树与改前相同）
}, ln));
```

> ⚠ 注意 L405 的循环会 `skip` `kind === 'diff'` 的 spec（`children.push(spec.node); continue;`）
> ⇒ **diff 块不参与点击**，这是既有行为，本方案不改。

**② ⚠ 下标口径必须取 `orderOptions` 重排后的下标。**

`planOptions` L151：`const options = permissionOptionOrder.orderOptions(builtOptions, { highRisk: isL2 });`
⇒ **视觉顺序 ≠ 原始顺序**。`tail: String(i+1)` 的数字键口径**已经是重排后**的
⇒ **点击下标必须与它同源**。

**实测后果（已执行 `services/permissionOptionOrder.js` 取证）**：

```
原始顺序:        deny , allow , allowAlways
orderOptions →   allow , allowAlways , deny        （highRisk 两种取值下同此结果）

视觉第 1 行（点它的下标 = 0）实际是:  allow      / 允许本次
若误用「原始数组下标 0」则会得到:      deny       / 拒绝
⇒ 误用原始下标：用户想点「允许本次」却触发「拒绝」——**授权决定被反转**。
```

⇒ 这是本方案**最严重**的潜在缺陷（**权限语义反转**，比「点 1 得到 2」更坏）。
**评审必查**：`onChoose(i)` 的 `i` 必须来自**渲染用的那个 `options` 数组**（即重排后）。

**③ 风险分级必须与 `BUG-36` 同口径。**

既有 `BUG-36`（L195-201）：footer **必须列出 handler 实际接受的全部键类**；
L2 曾漏写「数字键直选」，按 `2` 会直接发出**「本会话内总是允许此类高危操作」**（比默认行后果更重却不提示）。

⇒ **加鼠标点击后，`BUG-36` 的口径必须扩展到「可点区域」**：
- 增加一条 footer 提示（如 `点击选择 · `），且
- **L2 高危及 `danger: true` 的行**，点击后果比默认行更重 ⇒ **提示必须说清**，
  或按 `BUG-36b` 的待裁决方向**把高危行的点击降格为「仅移动光标」**（**此项待用户拍板，本方案不擅自裁决**）。

### 6.4 门控（`RUNTIME-001` / `RUNTIME-002`）

新增门控 **`KHY_CARD_CLICK`**，沿用既有口径：

```js
// 显式 falsy 关（OFF_VALUES 同源），其余（含 unset）开
const OFF = ['0', 'false', 'off', 'no'];
const clickEnabled =
  !OFF.includes(String(process.env.KHY_CARD_CLICK || '').trim().toLowerCase()) &&
  mouse.mouseButtonsEnabled(process.env);   // ← 既有 API；档位为 off 时恒 false
```

> ⚠ **API 名称核对**：`mouseButtons.js` 的导出面为
> `{ OFF_VALUES, SGR_MOUSE_RE, isMouseSequence, parseSgrMouse, autoDetectTerminal, altScreenEnabled,
> mouseTier, mouseButtonsEnabled, mouseHoverEnabled, mouseExplicitlyDisabled, wheelDirection,
> enableBytes, disableBytes, collectLayout, staticRowCount, liveFrameTop, screenOffset, hitTest,
> createMouseDispatcher }`（L833-852）。
> **没有 `clickableEnabled`** —— 档位判据用既有 **`mouseButtonsEnabled(env)`**（L248 `if (mouseTier(env) === 'off') return false`）。
> 落地时**以导出面为准**，不要凭方案里的名字臆造 API。

**三重前置**（任一不满足 ⇒ `clickEnabled = false` ⇒ 树与改前逐字节相同）：

1. `KHY_CARD_CLICK` 未被显式关闭；
2. `mouseButtons.mouseButtonsEnabled(process.env)` 为真（档位非 `off`）；
3. **行渲染路径存在**（`rowSpecs.length > 0`）。

> ⚠ **前置依赖必须写进文档**（`RUNTIME-002`）：
> 卡片点击生效要求终端已进 `click`/`full` 档。`mouseTier`（L230-250）：
> 备屏开（`KHY_ALT_SCREEN` 默认开）→ `click`；主屏 → `off`；
> `KHY_MOUSE=off` 显式优先恒关；CC 模式（`hasWheelConsumer:false`）→ `off`。
> ⇒ **档位 `off` 时必须优雅降级为纯键盘交互**（即 §6.4 的三重前置的第 2 条）。

### 6.5 两个挂载点必须同步（**§本仓反复踩的坑**）

`QuestionPrompt` / `PermissionsPrompt` 各有**两处挂载点**（**行号为实测**）：

- **挂载点 A**：`App.js` **L6625-6647**（`overlayNodes`，宽屏三列布局用）；
- **挂载点 B**：`App.js` **L6913-6930**（legacy 渲染树）。

实测两处 props（**两个组件在两条分支上都一致**）：

```js
h(QuestionPrompt,    { request, onResolve, cols: _overlayCols, rows: _resRows })
h(PermissionsPrompt, { request, onResolve, cols: _overlayCols })   // ← 没有 rows
```

⚠ **`PermissionsPrompt` 两个挂载点都不传 `rows`**（实测确认）：
⇒ 它**没有** `QuestionPrompt` 那套 `BUG-57` 尺寸收敛阶梯（`cols`/`rows` 缺失时恒 `full`）；
⇒ 本改造**不涉及 `rows`**，但**两条分支都要核对**：组件内部拿到的 `clickEnabled` 必须**两条路径都算得出**。
必须复验的反面案例：**只在一条分支生效 ⇒ 复现 09-24 的同类缺陷**
（「另一条布局分支必须核对它消费了原分支的全部 props」；
`PreviewLayout` 曾因收下 `completion` 却从不渲染 ⇒ 宽终端 ≥122 列整棵菜单不挂载）。

---

## 7. 与既有机制的交互（**逐条复验**）

| 既有机制 | 交互结论 | 复验方式 |
|---|---|---|
| **拖选复制**（`onSelectEvent`） | **不冲突**：`down` 无条件上报（§5.4）；拖拽时 `consumed === true` ⇒ 不触发 `onClick` | 在卡片上按下→拖到另一行→释放，应**只复制、不选中** |
| **键盘路径** | **零改动**：点击复用键盘分支同一函数 | 全部既有键盘测试须保持绿 |
| **`Ctrl+O` 全局展开** | **两套独立状态**（`ToolLines` 的 `expanded` vs `toolExpanded`）；本方案**不新增第三套** | — |
| **`KHY_TUI_DIAG=1`** | 点击诊断可复用既有 `[mouse]` stderr 打点（L4749-4757） | 开诊断应看到命中行信息 |
| **尺寸收敛阶梯**（`BUG-57`） | 点击下标按 **`rowSpecs` 下标**算，**不按视觉行**：`rowMode` 降档只影响**每行的文本**，不改 `rowSpecs` 数组长度 | 在 40 列窄屏点选项，行为与宽屏一致 |
| **`BUG-36b` 待裁决** | L2 高危行点击后果 ≥ 数字键 ⇒ **不擅自裁决**，交用户拍板 | 见 §6.3 ③ |

---

## 8. 验收判据（**可机械判定**）

1. **复现→修复对照**：`card-click-probe.cjs` 的 A1/A2 从 **FAIL → PASS**；
   B1–B4 **保持 PASS**（疗法非平凡性不得退化）。
2. **点击=键盘等价**：点选项 `i` 的结果 === 按数字键 `i+1` 的结果（单选提交 / 多选切换 / Other 进 typing），
   逐项对照，**多卡 + 惰性回退场景全覆盖**。
3. **零影响**（逐字节）：`KHY_CARD_CLICK=0` 与档位 `off` 两种情形下，
   渲染输出与改前**逐字节相等**（`FORCE_COLOR=3` 且**在 ink 加载前**注入）。
4. **不破拖选**：卡片上按下→拖选→释放，**只复制文字、不触发选中**。
5. **两挂载点一致**：宽屏（`overlayNodes`）与 legacy 树**行为一致**。
6. **`PermissionsPrompt` 下标正确**：L2（`orderOptions` 重排）下点第 1 行 ⇒ 得到**视觉第 1 行**的语义，
   **不是**原始顺序第 1 项。
7. 既有 TUI 测试全绿：`node scripts/run-ink-tui-tests.js`（⚠ **不是** `npx jest`，后者路径已断；
   缺 `--experimental-vm-modules` 会**静默 skip 像绿**）。

---

## 9. 落地清单（`RUNTIME-009` 删除先报部位）

**新增**：

| 文件 | 内容 |
|---|---|
| `ink-components/cardClick.js`（建议） | 门控判定 + `onRowClick` 纯逻辑（**零依赖叶子**，可离线单测） |
| `tests/cli/tui/cardClick.test.js` | §8 的 2/3/6 项断言 + 反向对照 |

**修改**：

| 文件 | 位置 | 改动 |
|---|---|---|
| `QuestionPrompt.js` | L652-656 | `rowNodes` 加 `onClick` |
| `QuestionPrompt.js` | L261-270 | 守卫**移到 `reviewing` 之前** |
| `PermissionsPrompt.js` | L365 / L405-421 | 选项行加 `onClick`，渲染循环透传 |
| `App.js` | **L6625-6647 / L6913-6930** | 核对两挂载点（实测确认**无需改**，仅复验） |

**`rollback.txt`**：删除 `cardClick.js` + 还原上述 4 处 `onClick` / 守卫位置 ⇒ 回到改前。
**因本方案为纯新增（无删除既有代码），`RUNTIME-009` 的「删除有文档背书的代码」判据不触发。**

---

## 10. 方案裁决（2026-09-24 用户拍板）

> 本节原为「未决项（交用户拍板）」。三项已全部裁决，**裁决结果即实施依据**。

| # | 原未决问题 | 裁决 | 落地后果 |
|---|---|---|---|
| 1 | `BUG-36b`：L2 高危卡的数字键是否降格？ | **两段式** —— 数字键与鼠标点击**只选中**，须再按 Enter 才授权 | `PermissionsPrompt` 新增 `twoStep = !!isL2`；`moveOnly()` 替代高危路径的 `choose()`；footer 文案同步改写（`BUG-36` 教训：文案必须与 handler 实际行为一致） |
| 2 | 门控名 | **`KHY_CARD_CLICK`** | 采原案，无改动 |
| 3 | 是否做「点选项行展开完整说明」 | **一并做** | `QuestionPrompt` 新增 `expandedRows` 态；`rowSpecs` 增 `fullDesc` 全文；展开态改用 `cardClick.expandLine()` 重排该行 |

**裁决带来的范围变化（诚实记录）**：

- 第 1 项使 `PermissionsPrompt` 从「纯加 onClick」升级为**行为策略变更**。L1 不受影响（保留一键直选）；
  L2 由「一键直选（误触即高危授权）」改为「选中 → 确认」两步。这是本次唯一改变既有行为的改动。
- 第 3 项使 `QuestionPrompt` 从「只加命中」升级为**新增一种版面态**。为守住原有契约
  （`questionPromptSize.test.js`：不传 `cols` 时逐字节保持改前形态），展开态**只在点击时进入**，
  且默认（`expandedRows` 全 `null`）渲染路径与改前**完全同路径**。
- 随之新增 `cardClick.expandable()` 判据：空说明 / 已完整显示的行不展开（避免凭空多出空白）。

---

## 11. 验证状态（**哪些是实测、哪些是主张**）

> 本仓纪律：「**源码文本断言必须就地执行真代码**，否则恒真」。故本节区分
> **已实测**（跑过真代码）与 **仅主张**（读源码/注释得出，**落地前必须补测**）。

### 11.1 已实测（探针可复跑）

| # | 主张 | 探针 | 结论 |
|---|---|---|---|
| 1 | 卡片行节点**无鼠标 prop** ⇒ 不在命中区 | `card-click-probe.cjs` A1/A2/B1 | ✅ 实测 FAIL＝缺陷成立 |
| 2 | 给行挂 prop ⇒ 该行**可命中**且回调是**那一行** | 同上 B2/B3 | ✅ 实测 PASS（`rowClicks=[1]`） |
| 3 | 整卡挂一个 handler ⇒ **无法区分选项** | 同上 B4 | ✅ 实测 PASS |
| 4 | 点同一行 ⇒ 触发 onClick 且**被吞** | `verify-safety-probe.cjs` P1a-c | ✅ 实测 PASS（**真 dispatcher**） |
| 5 | 跨行拖选且 `consumed=true` ⇒ **不触发** onClick | 同上 P2a-c | ✅ 实测 PASS ← **安全性核心** |
| 6 | 上述「不触发」是 `consumed` 的功劳（非恒真） | 同上 P2-rev | ✅ 实测 PASS（**反向对照**） |
| 7 | 按下（含空白处）**无条件上报** `down` | 同上 P3a/b | ✅ 实测 PASS ← 拖选起点不被吞 |
| 8 | `orderOptions` **重排**选项 | 直接执行 `permissionOptionOrder.js` | ✅ 实测：`[deny,allow,allowAlways] → [allow,allowAlways,deny]` |
| 9 | 误用原始下标 ⇒ **授权语义反转** | 同上 | ✅ 实测：想点「允许本次」实际触发「拒绝」 |
| 10 | 两挂载点**都不给** `PermissionsPrompt` 传 `rows` | 实读 `App.js` L6631-6641 / L6916-6926 | ✅ 实测确认 |
| 11 | App 第 0 段（L4699）鼠标 `return` **早于** L4805 让键 | 源码控制流定位（脚本计行） | ✅ 实测：**相隔 106 行** ⇒ 断言 A 成立 |
| 12 | **两处改造点锚点唯一** + 替换后 `node --check` 通过 + 回退逐字节相等 | `prototype-applicability.cjs` C1-C6 | ✅ 实测 **8/8 PASS**（**可实施性**） |
| 13 | 既有鼠标测试**基线全绿**（改动前） | `node --test` × 5 文件 | ✅ 实测 **60/60 pass**（8+12+9+19+12） |
| 14 | 守卫位置＝`reviewing`(L246) 之后、`typing`(L273) 之前 | 脚本逐行定位 | ✅ 实测：守卫 **L261-270**，`typing` 内插字面量在 **L310** |
| 15 | **全 TUI 测试基线**（1017 例） | `node --test "tests/cli/tui/*.test.js"` | ⚠ 实测 **1013 pass / 4 fail**，**4 个失败全部来自并发会话在途文件**（见下注） |

> **⚠ 关于 #15 的 4 个失败（归属已查清，与本方案无关）**：
>
> | 失败文件 | git 状态 | 归属 |
> |---|---|---|
> | `consoleMute.test.js`（C6） | `??` untracked | **并发会话在途** |
> | `selectionAnchorDrift.test.js`（D-02/D-04） | `??` untracked | **并发会话在途** |
> | `transcriptLines.test.js`（unknown roles） | `M` 已修改 | **并发会话在途** |
>
> **本轮我没有改任何 `services/backend/src/**` 或 `tests/**` 下的文件**（只新增了
> `docs/` 设计文档与 `.khy/feedback/` 探针）⇒ 这 4 个失败**与方案零关系**。
> 落地时应以**当时的**基线为准，不要把「别人在途的红」当成自己的回归。
>
> ⚠ **跑法注意**：`node --test tests/cli/tui/`（目录形态）在本机会报
> `Cannot find module '…/tests/cli/tui'`（Node 版本对目录参数的处理差异）——
> **必须用 glob** `node --test "tests/cli/tui/*.test.js"`。

**探针落点**：`.khy/feedback/DESIGN-ARCH-146-card-click/`
（`card-click-probe.cjs` / `repro-before.txt` / `verify-safety-probe.cjs` / `verify-safety-before.txt` /
`prototype-applicability.cjs` / `prototype-applicability.txt`）

> ⚠ **原型抓到了方案的一处缺漏**：§6.2③ 原写「把守卫移到 `reviewing` 之前」，
> 但**没写明要同时删除原守卫** ⇒ 照字面实施会出现 **2 处** `isMouseSequence(ch)`。
> 已据实订正为该节「**一增一删**」形态。**这是「先做可运行原型」的直接收益**。
>
> ⚠ **原型自身也踩了一个坑**（值得记）：首版把「原守卫块」用**手抄常量**写进探针，
> 结束空行数与真实文件差一个字节 ⇒ **回退校验假 FAIL**（C6）。
> 正解＝**从源码现场截取**（`original.slice(indexOf(开始), indexOf(结束标记))`）。
> ⇒ 教训：**任何「对照用的原文常量」都不要手抄**，一律现场截取。

### 11.2 仅主张（**落地前必须补测**）

| # | 主张 | 为何尚未证 | 补测方式 |
|---|---|---|---|
| A | ~~「卡片 `useInput` 收不到鼠标序列」~~ | ✅ **已升级为实测 #11**（控制流相隔 106 行） | — |
| B | 「改后键盘路径零回归」 | 需改后跑既有 TUI 测试套 | `node --test tests/cli/tui/*.test.js`（基线已取，见 #13） |
| C | 「门控关时逐字节回退」 | 需改后跑逐字节对照 | `FORCE_COLOR=3` + 在 ink 加载前注入 |
| D | 「`BUG-57` 降档不影响点击下标」 | 需窄屏实测 | 40 列终端点选项，对照宽屏 |
| E | 「`PermissionsPrompt` 点击下标取重排后下标」 | 需改后集成测（原型未覆盖该组件的 DOM 路径） | 单测 `onChoose(i)` 的 `i` 来自重排后数组 |

### 11.3 设计阶段**未**做的事（**已被 §12 实施取代**）

> ⚠ 本节记录的是**设计阶段的边界**，读到时请注意：生产代码随后已在 §12 落地。
> 保留本节是为了让「方案」与「实施」两个阶段的边界可追溯（哪条是当时的主张、哪条后来被证伪）。

- ✅ 当时仅新增**设计文档 + `.html` 孪生件 + 索引登记 + 三份探针存证**；
- ❌ 当时**未改生产代码**、**未新增 `cardClick.js`** —— 均已在 §12 完成。

---

## 12. 实施记录（2026-09-24，**含一处地基被证伪**）

### 12.1 落地清单完成情况

| 文件 | 改动 | 状态 |
|---|---|---|
| `ink-components/cardClick.js` | **新增**：门控 `cardClickEnabled` + 命中 `normalizeRowIndex` + 展开 `toggleExpandedRow` / `expandable` / `expandLine` | ✅ |
| `ink-components/QuestionPrompt.js` | ① `rowNodes` 挂点击；② 鼠标守卫「一增一删」前移到 `reviewing` 之前；③ 新增 `expandedRows` 展开态 + `rowSpecs.fullDesc` | ✅ |
| `ink-components/PermissionsPrompt.js` | ① 两个渲染分支（紧凑 / 旧形态）挂点击；② **L2 改两段式**（`twoStep`/`moveOnly`）；③ 页脚文案同步 | ✅ |
| `tests/tui/cardClick.test.js` | **新增**：17 例（门控口径 / 下标收束 / 展开态 / 反向对照） | ✅ 17/17 |
| `App.js` | 挂载点核对 | ✅ 无需改（与设计期实测一致） |

### 12.2 ⚠⚠ **地基被证伪：`<Text onClick>` 根本不生效**（本节最重要）

**设计期的错误假设**：方案 §6.2① 写的是「给 `rowNodes` 的 **`Text`** 加 `onClick`」。
实施后用探针验证，**发现这条假设是错的**：

| 组件 | 未知 props 处理 | `onClick` 落点 | `collectLayout` 能否命中 |
|---|---|---|---|
| `<Box>` | `({...style})` **透传** | `node.style.onClick` | ✅ **能** |
| `<Text>` | **固定 props 白名单**，不展开 rest | 被 React **静默丢弃** | ❌ **不能** |

ink 6.8.0 的 `Text.js` 只声明 `color/backgroundColor/dimColor/bold/italic/underline/strikethrough/inverse/wrap/aria-*`；
而 `Box.js` 用 `...style` 收集其余 props 并整体塞进 `style` 对象。`collectLayout` 读的正是
`node.style.onClick`（`mouseButtons.js` L387-392）⇒ **给 `Text` 挂 `onClick` 是一条静默死路**：
代码看着对、语法通过、守卫全绿，但**点了毫无反应**。

**修正**：所有可点行改为 **`<Box flexDirection="column" onClick>` 包一层 `<Text>`**；
门控关时仍返回原 `Text` 节点，保证改前渲染路径逐字节不变。
（`ToolLines.js` L1381-1402 / `RightPanel.js` / `SessionSidebar.js` 之所以能用，正因为它们挂的是 `Box`。）

**实证**：`.khy/feedback/DESIGN-ARCH-146-card-click/probe-box-vs-text.txt`（5/5 PASS，
含「`attributes.onClick` 的节点不进命中区」的反向对照）。

> ⚠ **这正印证了本仓的一条老判据**：**「守卫报绿」≠「没问题」，只等于「判定面内没问题」**。
> 若只跑单测与守卫，这个错误**不会被任何现成机制发现** —— 必须真渲染 + 用 `collectLayout` 独立复查。

### 12.3 端到端验证（真渲染 + 真 `collectLayout`）

探针 `probe-real-cards-hittest.cjs` 真渲染两个改后组件，从 ink 的 `instances` WeakMap 取
`rootNode`，跑真 `collectLayout`：

| 被测 | 门控 | 可点节点 | 命中屏幕行 | 结论 |
|---|---|---|---|---|
| `QuestionPrompt`（3 选项） | 开 | **5**（3 真实 + 可讨论 + Other） | `[2,3,4,5,6]` | ✅ 逐行不重叠 |
| `PermissionsPrompt` L1（3 选项） | 开 | **3** | `[6,7,8]` | ✅ 逐行不重叠 |
| `QuestionPrompt`（反向对照） | **关** | **0** | `[]` | ✅ 门控真的生效 |

**8/8 PASS**（存证 `probe-real-cards-hittest.txt`）。反向对照是硬要求：缺了它，
一个「无条件挂 `onClick`」的实现也会全绿 —— 那就等于门控不存在。

### 12.4 两段式（`BUG-36b` 裁决）的行为变化

| 卡型 | 改前 | 改后 |
|---|---|---|
| **L2 高危** | 数字键**一键直选**（按 `2` 直接发出「本会话内总是允许此类高危操作」） | 数字键/点击**只选中**，须再按 `Enter` 才授权 |
| L1 普通 | 数字键一键直选 | **不变** |

页脚文案随之改写（`数字键/点击 选中 · Enter 确认执行`）—— 这是 `BUG-36` 的同一类纪律：
**页脚必须列出 handler 实际接受的全部键类**，文案与行为不得背离。

### 12.5 ⚠ footer 文案的**长度是契约**（改文案时踩到的坑）

改 footer 时一个看似安全的动作 ——「把文案写短一点」—— **反而复发了 BUG-57**。

`cardLayout.splitFooter(text, avail)` 按 ` · ` 分段折行；**只有折成两行才能保证 `Esc 取消`
整段落在行内**。实测（60 列终端 ⇒ `avail ≈ 56`）：

| 文案 | 显示宽 | `splitFooter(t, 56)` | 结果 |
|---|---|---|---|
| 旧（改前） | 63 | **折 2 行**：末行 `默认「确认执行」· Esc 取消` | ✅ `Esc 取消` 完整 |
| 实施初版（**过短**） | 55 | **不折**（55 ≤ 56），单行 | ❌ 渲染时被卡宽裁成 `… Esc …` |
| 实施修正版（5 段结构） | 73 | **恒折 2 行**（46–56 各档实测均如此） | ✅ `Esc 取消` 完整 |

**教训**：**「短」不等于「安全」**。折行阈值是个**上限**，短过阈值会掉到「单行 + 被裁」这一更差的形态。
改这类文案前必须先量 `visWidth` **与** `splitFooter(t, avail)` 的最坏情形，不能靠直觉。

修正版刻意保留 5 段结构（`↑/↓ 导航 · Enter 确认执行 · 数字键/点击 选中 · 默认「确认执行」· Esc 取消`），
并在 `footerTextOf` 的注释里写明「长度是契约的一部分，不要顺手缩短」。

### 12.6 门控的默认值（**影响测试与真实终端**）

`cardClickEnabled(env)` 需要**两条同时成立**，其中第二条是 `mouseButtonsEnabled(env)`，
而它要求终端**被识别**（`autoDetectTerminal`）。实测：

| 环境 | `mouseTier` | `mouseButtonsEnabled` | `cardClickEnabled` |
|---|---|---|---|
| 测试 / 管道（`TERM=dumb`、无 `KHY_MOUSE`） | `click` | **false** | **false** |
| 真实终端 + `KHY_MOUSE_BUTTONS=1` | `click` | true | **true** |

**两个直接后果**：

1. **测试环境天然走「门控关」路径** ⇒ `questionPromptSize.test.js` 的「不传 `cols` 时逐字节不改」
   负对照**不受本次改动影响**（这也是为什么端到端探针必须显式设 `KHY_MOUSE_BUTTONS=1`
   才看得到可点节点 —— 否则探针会**假绿**）。
2. 终端不被识别时点击静默关闭 —— 这是既有 `mouseButtonsEnabled` 的设计（不识别就不接管），
   非本次引入；但意味着**「代码在、终端不给」时点击无反应**，排查时先看这一点。

### 12.7 改后测试状态

| 项 | 结果 |
|---|---|
| `cardClick.test.js`（新增 17 例） | ✅ **17/17 pass**（`node --test` 族；`jest.config.js` 按 `require('node:test')` 标记自动忽略，无需手工登记） |
| 端到端命中探针（真渲染 + 真 `collectLayout`） | ✅ **8/8 pass**（含门控关反向对照） |
| 机制探针（Box vs Text） | ✅ **5/5 pass**（含 `attributes.onClick` 不入命中区的反向对照） |
| 守卫前移探针（typing 态吞掉鼠标序列） | ✅ **3/3 pass**（含「普通字符 Z 必须被插入」的反向对照） |
| 两段式行为探针（L2 选中→Enter / L1 直选） | ✅ **9/9 pass** |
| `tests/tui` 全量（**含并发会话在途改动**） | 47 suites / 711 pass；2 suites / 5 fail —— **失败全部属并发会话**（见下） |

**本次改动直接相关 suite 的实测（均绿）**：

```
PASS tests/tui/permissionsPromptDigitFooter.test.js   ← 本次改写的契约测试
PASS tests/tui/permissionsPromptNoticeFrame.test.js   ← 本次改写的窄屏折行用例
PASS tests/tui/questionPromptSize.test.js             ← 「不传 cols 逐字节不变」负对照
PASS tests/tui/cardLayout.test.js                     ← splitFooter 折行真源
```

**关于 2 个失败 suite（**归属已查明，与本次改动无关**）**：

| suite | 失败原因 | 归属证据 |
|---|---|---|
| `ccOverlayFit.test.js` | `maxWriteRows` 比账本地板少 1（AgentTree / busy 帧让位账本） | `App.js` mtime **18:20:43**（+743/−175 行）—— 落在并发会话工作时段，**本次从未碰过 `App.js`** |
| `keyHandlerFreshClosure.test.js` | `Exceeded timeout of 60000 ms`（`openThenUp(200)`） | **超时**而非断言失败；且伴随 `import after Jest environment torn down` —— 典型的**机器负载 / 多 jest 进程竞争**症状（本轮为赶进度同时跑了多个后台 suite）。判据：**超时类红先看负载**，不要当回归 |

> 判定方法（本仓纪律）：**判红灯前先看 `git status` 规模，大规模变动先按 mtime 判归属**。
> 本次改动的 6 个文件 mtime 全部落在 17:52–18:30；`App.js` / `perfTunables.js` / `Spinner.js`
> 在同区间被**并发会话**修改，故其失败不归本次。

**测试契约随行为同步（`RUNTIME-009`：改动有文档背书的行为须报部位）**：

| 文件 | 改动 | 理由 |
|---|---|---|
| `tests/tui/permissionsPromptNoticeFrame.test.js` | 「窄屏页脚折行」用例的文案断言改为 `数字键/点击 选中` + `Enter 确认执行` | L2 行为变了，文案随之变；该用例的**主旨**（`Esc 取消` 不许丢）不变 |
| `tests/tui/permissionsPromptDigitFooter.test.js` | 头注释补裁决记录；「数字键在 L2 直选」两个用例改为**两段式**（数字键只选中 ⇒ `hit=false`；加 Enter 才出原结果）；新增 L1 回归对照 | 该文件头注释**原文即写明**「若将来改变该策略，本用例必须同步改，好让那次改变是显式的而非顺手发生（BUG-36b 的裁决点）」—— 此处正是履约 |

### 12.8 存证清单（`.khy/feedback/DESIGN-ARCH-146-card-click/`）

| 文件 | 内容 |
|---|---|
| `card-click-probe.cjs` / `repro-before.txt` | 缺陷复现（6/8 PASS，2 FAIL 即缺陷本身） |
| `verify-safety-probe.cjs` / `verify-safety-before.txt` | 拖选安全（9/9，含 `consumed` 反向对照） |
| `prototype-applicability.cjs` / `.txt` | 可实施性（8/8：锚点唯一 / 回退逐字节） |
| `probe-box-vs-text-click.cjs` / `.txt` | **地基修正实证**（5/5：Box 透传 vs Text 白名单） |
| `probe-real-cards-hittest.cjs` / `.txt` | **端到端命中**（8/8：真渲染 + 真 `collectLayout` + 门控反向对照） |
| `probe-guard-order.cjs` / `.txt` | **守卫前移**（3/3：typing 态吞序列 + 反证输入态在工作） |
| `probe-twostep.cjs` / `.txt` | **两段式行为**（9/9：L2 选中→Enter / L1 直选回归对照） |


