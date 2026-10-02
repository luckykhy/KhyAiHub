# [DESIGN-ARCH-176] TUI 与桌面端统一方案：底色分层 · 稳定渲染 · 共享语义

> **状态**：提案（待实施）
> **定位**：**唯一设计真源**。本文件**已物理合并**原 `[DESIGN-ARCH-174]`（TUI 面板底色重设计）
> 与 `[DESIGN-ARCH-175]`（跨端渲染统一）两份提案，二者连同其站点生成物（`.html`）**已删除**，编号不再使用。
> **范围**：
> - `services/backend/src/cli/tui/` —— TUI 面板视觉层 + 右栏显示时机
> - `services/backend/src/services/` —— 新增端无关语义投影层
> - `apps/khyos-desktop/src/renderer/` —— 消息区消费投影
> - **不改**任务数据模型、**不改**租约语义、**不改**宽度几何层
> **上游依赖**：无运行时依赖新增
> **规则真源**：`[DESIGN-ARCH-102] Khy TUI 统一规则手册` C17 / C18 / §10；桌面端契约见 `desktopUiContract.test.cjs`（D6/D9）
> **门约束**：`check-tui-gates.js:41` `MAX_GATES = 227`（**只降不升**）⇒ 本方案**不新增 `KHY_*` 门**，
> 用户偏好走 `~/.khyquant/tui.json`（`tuiConfig.js:6-7` 明文要求）

---

## 用户诉求（2026-10-02，两轮）

| # | 诉求 | 落点 |
|---|------|------|
| ① | TUI 任务面板不美观不直观，调研多个 GitHub 项目后重新设计 | §3.1–§3.3、§4 |
| ② | 右侧看板**什么时候以什么方式显示**需要设计 | §3.5 |
| ③ | 方案**统一为一个** | 本文件（合并 174 + 175） |
| ④ | 保证**细节与 UI 稳定性** | §5 |
| ⑤ | 避免**线条滥用**，用**底色**改变显示 | §3.1、§3.2 |
| ⑥ | 亮色终端底色对比度**也要解决** | §3.4 |
| ⑦ | 把终端**嵌入桌面端红框位置**（消息区），两端统一，**但桌面端输入框独立** | §6 |

---

## 0. 一句话结论

三件事，同一个根：**同一份数据被两套视图各写一套渲染**。

- TUI 面板**不丑，是瘦** —— 已有四层设计（分区/计数/优先级保活/诚实回退），只是每行只有「图标+文本」两维
- 右侧看板是**空壳** —— 任务段被显式关掉，只剩三小段占满 30 列 × 满屏
- 两端**已在同一层** —— 共用 `runToolUseLoop`，统一点在**渲染层之下**

⇒ 方案：**底色分层**（替线条）+ **四层亮色解法** + **共享语义投影**（替 PTY）。

---

## 1. 现状实证

### 1.1 面板的渲染骨架（已设计过的部分，不是「没设计」）

`TaskListPanel.js:152-156` 根 Box：

```js
h(Box, { flexDirection:'column', borderStyle:'round', borderColor:'gray', paddingX:1 }, ...children)
```

子元素：`:119` 头行 → `:102-112` 分区（每组插一行 `— 标签 —`）→ `:109` 每行单个 `Text` 节点 → `:120-137` 尾切提示。

**已有四层设计**：

| 设计 | 位置 |
|------|------|
| 按来源分区（本会话 / 跨会话） | `taskPanelLines.js:224-244` `splitTaskLinesBySource` |
| 头行按状态计数 | `taskPanelHeader.js:50-95` `buildTaskPanelHeader` |
| 截断按状态生存优先级 | `taskPanelLines.js:283-316` `selectTaskLinesByPriority` |
| 诚实回退（覆盖不了全量就退静态标题） | `taskPanelHeader.js:66-76` |

**行内容只有两个维度**：`taskPanelLines.js:45` `` `${icon} ${desc}` ``。
`_taskStore.snapshot():365-404` 是**字符串通道**，`:379/:382` 拼串时丢弃了
`createdAt`/`updatedAt`（`:65-66`、`:171-172`）与 `owner` ⇒ **耗时/归属当前不可达**（§9 #5）。

### 1.2 右侧看板是空壳

`App.js:6663-6666`：

```js
const _sidebarProps = {
  taskLines: [],
  hideTaskSection: true,        // ← 整块关掉右栏唯一有价值的段
```

`SidebarPanel.js:176-179`：

```js
// 1. Task checklist. App owns the canonical full-width TaskListPanel and
// passes hideTaskSection here so the optional right rail does not duplicate
// tasks or show a misleading permanent empty state.
if (!props.hideTaskSection) {
```

⇒ 右栏只剩「工作目录 / 队列 / 通知」≈ 8 行，占满 30 列 × 满屏 = 用户截图里的大片空白。

**决策本身是对的**（避免双份渲染同一份数据），**错在拿掉任务后没给新职责**。

### 1.3 ★ 右栏是**树内** `SidebarPanel`，不是带外 rail（实测）

初稿判为带外 rail，**实测否定**：

| 探测 | 结果 |
|------|------|
| `cmd /c set KHY_` | 只有 `KHY_COORDINATOR_MODE` / `KHY_GIT_PATH`，**无 `KHY_SIDEBAR_RAIL`** |
| `cmd /c echo %KHY_SIDEBAR_RAIL%` | 回显字面量 ⇒ 未定义 |
| 6 个启动脚本（`khy.bat`/`khy-cli.bat`/`khy.sh`/`portable-setup.bat`/`cli.py` 108KB/`__main__.py`） | **全部无 SIDEBAR 字样** |
| `railLayout.js:68-80` | 要求显式 on（opt-in）⇒ rail 不可能激活 |

⇒ 实际是树内面板，由 `App.js:5879-5885` `shouldShowSidebar` → `sidebarLayout.js:352-381`
`isFullscreen`（**列与行**都要接近会话最大值，`cols ≥ 120`、`rows ≥ 24`）判定。

**⚠ 附带发现**：`railLayout.js:31-32` 与 `sidebarLayout.js:73` 注释均称 rail「DEFAULT ON」，
而 `railLayout.js:68-80` 代码是 **opt-in** ⇒ **两处注释与代码矛盾**（本误判的来源）。已登记 §8 #3。

**这个区分是实质性的**（决定实施风险）：

| | 树内 SidebarPanel（**实际生效**） | 带外 rail（未激活） |
|---|---|---|
| 抢活动区高度 | **是**，受 `sidebarStableRows` 约束 | 否 |
| 参与 `App.js:6501` 高度账本 | **是** | 否 |
| 段序改动风险 | **会动高度账本** ⇒ 必须复算 | 不影响 |

### 1.4 第一性约束：帧高

面板帧高必须 **< 终端行数**，否则 `ink.js:320` 判 `outputHeight >= stdout.rows`
→ 走 `clearTerminal + fullStaticOutput`（每帧清屏）。

高度账本 `App.js:6501`：`const taskH = taskLines > 0 ? 3 + taskLines + (hidden > 0 ? 1 : 0) : 0;`
（`3` = round 边框 2 + 头行 1；分区标签行已由 `App.js:6329-6332` 前馈进 reserve）

⇒ **本方案所有改动必须行数中性**。这是排除「加表格列」路线的根本原因：
k9s / gh / taskwarrior 的对齐表格依赖固定列宽，而它们是**全屏 TUI（接管终端）**；
本仓面板是**嵌入式常驻区块**，加列在窄终端会把标题挤成两行 ⇒ 帧高失控。

### 1.5 ★ 桌面端调 AI 的完整链路（已核实）

```
renderer  → preload/index.ts:47-48   aiSend / aiStream（ipcRenderer.invoke）
          → main/index.ts           ipcMain.handle('ai:send'|'ai:stream')
          → host 子进程              fork（index.ts:6,81 hostProcess）
          ↕ 事件回流
main/index.ts:189-195  HOST_EVENT_TO_RENDERER_CHANNEL
            'ai.chunk'→'ai:chunk'  'ai.toolCall'→'ai.toolCall'
            'ai.toolResult'→'ai.toolResult'  'ai.controlRequest'→'ai.controlRequest'  'ai.result'→'ai.result'
          → :370-381  wc.webContents.send(rendererChannel, m)
          → preload/index.ts:52-70  onAiChunk / onAiToolCall / onAiToolResult …
```

`index.ts:357-358` 原文（**决定性证据**）：

> toolCall / toolResult **来自 runToolUseLoop 的循环级回调**（不是 chat 的 onChunk），
> 桌面端靠它们把「agent 真的在干活」渲染出来 —— 缺这两条通道时它们会被静默丢弃。

⇒ **桌面端与 TUI 消费同一个循环。** TUI 侧同路径为 `App.js` → `replSession.js` → `toolUseLoopCore.js`。

### 1.6 桌面端布局：红框位置就是 `<main>`

`AppLayout.tsx:375`：

```tsx
<main className="flex-1 overflow-auto flex flex-col">{children}</main>
```

`<main>` 是容器，其子元素即「消息区（滚动）+ 独立输入框」—— 与用户截图结构一致。
⇒ **红框位置不需要新增容器，只需替换消息区子组件。**

### 1.7 `Terminal.tsx` 是 stub

| 项 | 证据 | 状态 |
|---|------|------|
| 组件 | `components/terminal/Terminal.tsx` | 存在 |
| xterm + 4 addon | `Terminal.tsx:2-6` | **已装** |
| 主题接 CSS 变量 | `Terminal.tsx:16-27`（`--color-terminal-*` 16 个） | 已接 |
| 自适应 | `Terminal.tsx:30,36` `FitAddon` + `ResizeObserver` | 已接 |
| 挂载点 | `AppLayout.tsx:164-177` `toggleTerminal` → `paneTabs` kind `'terminal'` | 已通 |
| **真后端** | `Terminal.tsx:38-39` `writeln('KhyOS Terminal')` + 「命令执行结果（stub）」 | ❌ **无 PTY、无后端** |
| `node-pty` | `main/index.ts:6` 只导入 `execFile, fork` | ❌ **未装** |

⚠ **这是一个会误导用户的假终端**：界面上像真终端，输入只回显 stub 文本。
按仓库诚实红线（「不为列表好看留空壳」），**它必须被接上或删掉，不能留着**。

### 1.8 TUI 侧的输入形态

`App.js` 的 live 区自上而下：`StreamingBlock` → `TaskListPanel`（`:7030`）→ `PromptFrame` → `FooterBar`。
**`PromptFrame` 就是 TUI 的输入框**，与任务面板同区 ⇒ PTY 方案的根本冲突在此（§6.2）。

---

## 2. 借鉴提案（B-P2）

### 2.1 横向对比

| 项目 | 底色/边框做法 | 借鉴点 |
|------|--------------|-------|
| **lipgloss** | `Border*`（边框）与 `Background`（整块填充）**明确分离**；`AdaptiveColor{Light,Dark}` 按终端背景选色；`CompleteColor{True,ANSI256,ANSI}` **显式分档** | ★ 底色一等公民 + **每色深显式色值** |
| **bubbletea list** | 选中项默认用 `BorderLeftForeground`（左边框）+ 前景色，**非整块背景** | 反例：靠线条强调，恰是本方案要规避的方向 |
| **k9s** | 面板用 `bgColor`（表头/面包屑），**状态语义用文字色** | ★ **底色≠状态**：底色做面板/分组，状态用文字色+字形 |
| **gh CLI** | 无背景 token；尊重 `NO_COLOR`/`CLICOLOR`；有 `GH_ACCESSIBLE_COLORS`（4-bit 无障碍色，可配） | 无障碍走「可配置对比色」而非底色调 |
| **gum** | 进度/表格用**字符块**（`█`），非底色填充 | 字符块是底色的等宽替代 |
| **ratatui** | `NO_COLOR` 原生支持；`color_support()` 返 `:none`；`NoColor` 主题全 `Reset`；`j-cli color_adapt` 做**感知色差降级** | ★ 灰阶降级**必须显式映射**，不静默变黑 |
| **TUI Design System** | 16 色必须可用，真彩色只增强不创造层级；**永远不要只用颜色**，配 ✓/✗/⚠ | ★ 无障碍双重编码 |
| **VS Code / Cursor** | 集成终端用 **xterm.js + PTY**，但**只跑真 shell，不嵌入应用自身 TUI** | ★ 反例佐证：成熟 IDE 从不把自家 TUI 塞进 PTY |

**共性结论**：
1. **底色与线条分离**（lipgloss）：底色表达「块」，线条表达「边界」，**不混用**
2. **底色 ≠ 状态**（k9s）：底色做面板/分组，**状态用文字色 + 字形**
3. **显式色深分档**（lipgloss `CompleteColor` / ratatui `color_adapt`）：**每档都要有确定色值**
4. **颜色永不单独承载信息**（TUI Design System / WCAG）：配对字形
5. **只改色不改布局 ⇒ 零 reflow**（稳定性核心）
6. **别把自家 TUI 塞进 PTY**（VS Code 反例）：会与宿主输入体系冲突

### 2.2 B-P2 字段

**① 借鉴对象**
`charmbracelet/lipgloss`（v0.x，MIT）、`charmbracelet/bubbletea`（v0.x，MIT）、
`derailed/k9s`（v0.5x，Apache-2.0）、`ratatui`（Rust，Apache-2.0）、
`cli/cli`（gh CLI v2，Apache-2.0）、`charmbracelet/gum`（v0.x，MIT）、
`microsoft/vscode`（xterm.js 集成终端，MIT）。

**② 借鉴内容**
一句话：**借鉴「底色与边框分离 + 显式色深分档 + 颜色必配字形 + 不把自家 TUI 塞进 PTY」四条视觉/架构结论，不引入任何上游代码。**

**③ 解决的问题**
- 线条滥用：`TaskListPanel.js:154` round 边框 + `:107` `— 标签 —` 分隔行
- 底色不可用：`ccTheme.js:103-111` SEMANTIC **无 bg token**；`:158` 16 色路径对底色是 bug
- 右栏空壳：`App.js:6665` + `SidebarPanel.js:179`
- 亮色终端：`terminalCapabilities.js:79` 兜底恒判 `'dark'`
- 输入框冲突：PTY 方案会让 `PromptFrame` 与 `Composer` 并存

**④ 许可证与代码性质**
| 项目 | 许可证 | 核实位置 |
|------|--------|---------|
| lipgloss / bubbletea / gum / vscode | MIT | 各自仓库根 `LICENSE` |
| k9s / ratatui / cli | Apache-2.0 | 各自仓库根 `LICENSE` |

不复制任何上游代码片段，仅取结论 ⇒ `idea` 级。

**⑤ 借鉴方式**：`idea`

**⑥ 落点与现有实现对比**
- a. 落点：
  - 新增 `tui/theme/ccThemeBg.js`（bg token 层，纯叶子）
  - 新增 `tui/ink-components/taskSurface.js`（底色分层策略，纯叶子）
  - 新增 `services/semanticProjection.js`（端无关语义模型，纯叶子）
  - 改 `tui/theme/ccTheme.js`（修 `:158` 缺陷）
  - 改 `tui/ink-components/TaskListPanel.js`（去框线、接底色）
  - 改 `tui/ink-components/SidebarPanel.js` + `App.js:6663-6666`（右栏职责）
  - 改 `tui/ink-components/App.js`（旁路投影，不改渲染）
  - 改 `apps/khyos-desktop/src/renderer/`（消息区消费投影）
- b. 现有同类实现搜索过：
  - `backgroundColor` → `src/cli/tui/ink-components/` → 命中 `CcSelectable.js:83,131,184,213`、
    `SessionSidebar.js:43,77,83`、`SidebarPanel.js:583`、`Statusbar.js:46`、`Topbar.js:23`、`ToolLines.js:523-543`
    ⇒ **全仓已有多处底色先例，但无一走 `SEMANTIC`/`resolvePalette`，全是硬编码**
  - `resolvePalette|SEMANTIC` → `ccTheme.js`、`themeRegistry.js`
    ⇒ `resolvePalette` 是**唯一**语义色出口，但**只服务前景**
  - `structuredOutput|semanticModel|displayModel` → `services/` → **全是无关命中**（模型名）
    ⇒ **共享语义层不存在，需新建**
  - 结论：**扩展既有 canonical**（`resolvePalette` 加 bg 维度），**不新建第二套色板**；
    投影层为**全新**（无同类实现）

**⑦ 验收方式**
```bash
node scripts/ci/check-leaf-contract.js services/backend/src/cli/tui/theme/ccThemeBg.js
node scripts/ci/check-leaf-contract.js services/backend/src/cli/tui/ink-components/taskSurface.js
node scripts/ci/check-leaf-contract.js services/backend/src/services/semanticProjection.js
node --test services/backend/tests/semanticProjection.test.js
node --test services/backend/tests/tui/taskPanelFrameNeutrality.test.js
node apps/khyos-desktop/tests/desktopUiContract.test.cjs
node scripts/ci/check-tui-gates.js
```

---

## 3. 目标形态 · TUI 侧

### 3.1 视觉语言：底色分层，零线条

**核心原则**：**块靠底色，界靠间距，状态靠字形+文字色。**

| 表达目标 | ❌ 不用 | ✅ 改用 |
|---------|-------|---------|
| 面板边界 | `borderStyle:'round'` 外框（`TaskListPanel.js:154`） | **无框**，靠底色块边界 |
| 分组区分 | `— 本会话清单 —` 分隔行（`:107`，**且它占 1 行**） | **段头底色块**（`bgSubtle`），零额外行 |
| 进行中 | `color:'cyan'+bold` | **状态底色 + `→` 字形** |
| 错误 | `color:'red'` | **状态底色 + `✗` 字形** |
| 已完成 | `green+dim+strikethrough` | 保留（**唯一保留的线条类样式**，语义「已删去」不可替代） |
| 待办 | `dimColor` | 保留 dim（弱化未开始项是既有刻意选择，`taskLineStyle.js:26-27` 已论证） |

⚠ **零线条不是零区分**：去掉框线后，**靠 1 行留白 + 底色块边界**分隔。
这比框线更轻，且**不占行**（框线占 2 行，`App.js:6501` 的 `3` 里就有 2 是它）。

### 3.2 行结构（右尾元信息，窄屏自动丢弃）

```
 3/7                进行中 1 · 待办 3 · 错误 1   ← 头行：中性底色块（承载计数）
[底色] → 渲染分区标签              2m14s        ← 进行中：状态底色 + 右尾耗时
[  ]   ✓ 读取 taskStore 快照      0.4s         ← 已完成：dim + 划线
[底色] ✗ 高度账本对不齐            本机         ← 错误：状态底色 + 归属
[  ]   ○ 接入侧栏                              ← 待办：仅 dim
```

**头行不用 `█`/`░` 字符块画进度条** —— 字符块本质是线条类表达，违反约束⑤。
进度改由**头行底色块本身的填充比例**承担，或退化为纯文字计数。
**底色不改字符数 ⇒ 进度变化不触发 reflow。**

右尾元信息**用行内尾部对齐，不是新列** ⇒ 窄终端下整段丢弃，**行数不变**。

### 3.3 ★ 技术前置：底色 token 层（`ccThemeBg.js`）

**为什么必须先做**：`ccTheme.js:103-111` `SEMANTIC` 7 token
（`accent`/`muted`/`success`/`warn`/`danger`/`border`/`focus`）**没有任何背景色 token**；
唯一存在的背景色是 `CC_COLORS.selectedBg:'#2563EB20'`（`:50`），**未纳入语义层**。

**更严重的是 `:158`**（已复核原文）：

```js
if (depth < 8) {
  const out = {};
  for (const k of Object.keys(SEMANTIC)) {
    out[k] = ANSI16[k] + 'm' + SEMANTIC[k];   // ← ANSI16[k] 是 '\x1B[36'（:116，无尾 m）
  }
  return out;
}
```

拼出来是 `'\x1B[36m#00B4B4'` —— **一段带字面量 hex 的 SGR 串，不是颜色值**。
当前全仓消费者都当**前景色**用，chalk 会二次处理所以勉强能看；
**作为 `backgroundColor` 传入，chalk 会把整串再包一层 ⇒ 底色直接失效**。

**Ink 侧机制**（已核 `node_modules/ink/build/render-background.js`）：
- `:19` `colorize(' '.repeat(contentWidth), bg, 'background')` ⇒ **用空格逐行填充**
- `:15` `contentWidth > 0 && contentHeight > 0` 才画
- 嵌套 Box 背景是**覆盖而非叠加**（各自排空）

**⇒ 三条对设计有利的推论**：
1. **底色不改字符数** ⇒ 不触发 reflow ⇒ **天然满足「稳定」要求**
2. **Box 高度由 yoga 决定** ⇒ 底色块高度 = 显式 `height` ⇒ **不占额外行**
3. 不能靠嵌套两层做渐变式层次（覆盖语义）

**`ccThemeBg.js` 契约**（纯叶子：零 IO、确定性、绝不抛；色深/明度由调用方传入，**叶子自己不探测**）：

| bg token | 用途 | 暗底取值 | 亮底取值 | unknown |
|---------|------|---------|---------|---------|
| `bgSubtle` | 段头 / 分组块 | `#1c1c1c` 系 | `#f0f0f0` 系 | `ansi256(236)` |
| `bgHead` | 头行（承载进度） | 同 `bgSubtle` | 同 `bgSubtle` | `null` |
| `bgActive` | 进行中行 | accent 淡色 | accent 极浅 | **`null`（见 §3.4.3）** |
| `bgDanger` | 错误行 | danger 淡色 | danger 极浅 | **`null`（见 §3.4.3）** |
| `bgMuted` | 上下文条 | gray 系 | gray 浅系 | `null` |

⚠ **`ccTheme.js:158` 的修法**：不能直接改那行（服务前景色，全仓消费者依赖）。
正确做法是 **`ccThemeBg.js` 自己接收色深参数、自己映射**，`resolvePalette` 一个字都不动
⇒ **对既有 20+ 消费者零影响**。

### 3.4 ★ 亮色终端适配：四层解法（不依赖检测也能活）

#### 3.4.1 先纠正一处：问题比「可能不足」严重

**实测（本机，2026-10-02）**：

| env | 值 |
|-----|---|
| `COLORFGBG` | **未定义** |
| `TERM` | `"dumb"` |
| `TERM_PROGRAM` / `WT_SESSION` | **未定义** |
| `where wt.exe` | **有结果**（Windows Terminal 已安装） |

复刻 `terminalCapabilities.js:76-89` 的判定，本机结果 = **`dark`**。

⚠ **关键缺陷**：`:79` 是 `let backgroundMode = 'dark'; // safe default for developer terminals`
—— 它**不判，直接假定暗色**。而 Windows Terminal **不设 `COLORFGBG`**（实测）。

⇒ **亮色 Windows Terminal 下，现有 `backgroundMode` 必然判成 dark。**
这不是「可能判错」，是「一定不判」。**这否定了「直接用 `backgroundMode` 选亮/暗两套底色」的方案。**

#### 3.4.2 方案对比

| 方案 | 做法 | 判定 |
|------|------|------|
| **A** | 依赖 `backgroundMode` 选亮/暗两套 | ❌ **实测证明它不判** |
| **B** | **四层解法**：覆盖 → 修检测 → 安全色对 → 零底色 | ✅ **推荐** |
| **C** | 运行时 `OSC 11` 问终端背景色 | ❌ 需等终端回包，**破坏 TTY 独占**（ink 渲染时读 stdin 会与输入竞争） |

#### 3.4.3 ★ 四层解法（每层都能独立救场）

```
① 显式覆盖（最高优先，绕开一切检测）
      ↓ 未设
② 修 detection 本身：'dark' 兜底 → 'unknown' 第三态
      ↓ 仍 unknown
③ 双背景都安全的中性色对 + 状态全交给字形/文字色
      ↓ 仍不想要底色
④ 零底色字形模式（永不失败）
```

**第 ① 层 · 显式覆盖**
**走 `~/.khyquant/tui.json`，不新增 env 门。** 依据 `tuiConfig.js:6-7` 原文：

> New user preferences **MUST** live here, **not as new `KHY_*` env gates**.

新增字段：`appearance.bgMode: 'auto' | 'light' | 'dark'`（默认 `'auto'`）。
解析沿用 `tuiConfig.js:35-45` 的 fail-soft 形状（文件缺失/损坏 → 全默认，绝不阻断启动）。

⚠ **为什么不加 `KHY_BG_MODE` env 门**：`check-tui-gates.js:41` `MAX_GATES = 227`，
注释 `:24-40` 明写该值**只降不升**，且 `:28-30` 记载「user prefs 应迁往 `~/.khyquant/tui.json`」
—— 加 env 门既撞棘轮又违背既定收敛方向。

**第 ② 层 · 修 detection 本身**
`terminalCapabilities.js:79` 的兜底由 `'dark'` 改为 **`'unknown'`**（第三态）。

⚠ **这是本方案对既有代码的唯一改动，且有兼容风险**：
`backgroundMode` 现有消费者若假设只有 `'dark'|'light'` 两值，引入第三态会漏分支。
⇒ **实施前必须先 grep 全 `backgroundMode` 消费者并逐个核**（§9 #4）。
**若发现任一消费者无法容忍第三态，改为新增独立字段 `backgroundKnown: boolean`，保持 `backgroundMode` 两值不变。**

**第 ③ 层 · 双背景都安全的中性色对**
`unknown` 时**只启用中性底色**（`bgSubtle` / `bgHead`），**禁用彩色状态底色**（`bgActive` / `bgDanger` ⇒ `null`）。

**为什么这样就够**：若 `unknown` 时给「进行中」和「错误」同一个底色，用户确实分不清
⇒ 所以**状态区分在这一档全部交给字形 + 文字色**。
这正是 §2.1 里 k9s 的做法 —— 现在有了**必须这么做**的理由。

⚠ **对比度要求**：`unknown` 档的中性底色必须使用**双背景都安全**的取值
（`#1c1c1c` / `#f0f0f0` 这一对在各自背景下对比度均 ≥ 12:1），**且不依赖背景判定**。

**第 ④ 层 · 零底色字形模式**
全部 `backgroundColor: null`，靠 `→` `✓` `✗` `○` + 缩进 + 前景色。
丑但**绝不可读**。这是整个方案的安全网。

⚠ **无色档字形冗余**：`✗` 之外加 `!`（「永远不要只用颜色」原则）。

### 3.5 右栏职责重划

| 视图 | 回答 | 数据源 | 位置 |
|------|------|--------|------|
| **底部全宽面板** | 要做什么，做到哪 | `taskLines` | 输入框上方 |
| **右侧看板** | 此刻正在发生什么 | `tools` / `queue` / `notify` / 上下文 | 最右列 |

**数据源本就不同 ⇒ 不重复渲染**，`hideTaskSection` 的原始意图依然成立。

段序（`buildSidebarLines` 输出）：

```
① 当前     ← in_progress 任务标题（只 1 条，不重复底部面板）
② 工具     ← 运行中/已完成/错误，末行折叠 ✓ N 已完成
③ 队列     ← >0 才渲染
④ 通知     ← 既有 TTL 淡出
⑤ 上下文   ← 占用率 + 底色条（空闲兜底锚）
⑥ 工作目录 ← 既有段
```

**显示时机**：

| 状态 | 行为 |
|------|------|
| 激活 | `cols ≥ 120` 且 `isFullscreen` ⇒ 槽位常驻 |
| 空闲 | 只画 ⑤⑥（8 行占住上沿，**不留空洞**） |
| 折叠 | 超出高度 ⇒ `✓ N 已完成 ▸`（既有能力 `SidebarPanel.js:198-200`） |
| 关闭 | `KHY_SIDEBAR=0` ⇒ 主区全宽（既有行为逐字节不变） |

⚠ **不做「按内容出现/消失」**：`contentCols`（`railLayout.js:165-179`）是 ink 宽度单一真源，
`railActive` 为真即无条件收窄 ⇒ 让它随内容变 = 宽度在 120/90 间跳 = 整树 reflow = 残影
（`railLayout.js:24-28` 已警告）。**槽位恒在，切内容优先级。**

---

## 4. 借鉴的详细结论（见 §2.1）

四条原则：

1. **底色与线条分离**（lipgloss）—— 底色表达块，线条表达边界，不混用
2. **底色 ≠ 状态**（k9s）—— 底色做分组，状态用文字色 + 字形
3. **显式色深分档**（lipgloss `CompleteColor` / ratatui `color_adapt`）—— 不靠自动降级
4. **颜色永不单独承载信息**（TUI Design System / WCAG）—— 必配字形

---

## 5. 稳定性专项（用户要求④）

「稳定」= 不闪烁 / 不抖动 / 不残影 / 不重排。四个机制：

| 机制 | 做法 | 依据 |
|------|------|------|
| **① 零 reflow** | 底色**不改字符数**；右尾元信息用行内尾部对齐（窄屏丢弃）而非新列 | `render-background.js:19` 空格填充 |
| **② 行数中性** | 段头底色块**替代** `— 标签 —` 分隔行 ⇒ **净减 1 行**；去 round 边框 ⇒ **净减 2 行** | `App.js:6501` `3 + taskLines` |
| **③ 固定高度** | 面板高度走 `liveRegionBudget` 既有账本，不新增高度计算 | `[DESIGN-ARCH-156]` 帧生成管线契约 |
| **④ 同步输出** | 若抖动仍生，套 `supportsSyncOutput`（DEC 2026 同步序列）包裹整帧 | `terminalCapabilities.js:94-100` 已实现探测 |

⚠ **② 的连带影响（本方案唯一的账本改动点，必须两处同改）**：
`App.js:6501` 的 `3`（边框 2 + 头行 1）在去框线后变成 `1`；
但**同一公式在 `chromeRegistry.js:85` 还有第二份独立实现**（`:79` 注释明写
`round border (top+bottom) 2 + header 1`）。

⚠ **两处漏改任一 ⇒ 账本虚高 ⇒ `StreamingBlock` 被压矮 ⇒ 每帧少显示一行。**
症状只在长输出时出现（「莫名少行」），短会话复现不了，**极难在开发期抓到**。

**处置形状有先例**：`chromeRegistry.js:64-75` 记录 2026-09-24 移除 spinner 边框时，
把该块 `rows` 从 3 改成 1，注释理由是「Charging 3 here costs the transcript two rows on every busy frame」
⇒ 本方案沿用同一形状，但**本次多一处**要改。

### 5.1 文本测量不可省

底色块宽度 = `contentWidth`（`render-background.js:13`）由 yoga 算。
但**文本截断必须用 CJK-aware 测量**：`SidebarPanel.js:52-62` `_measure()` 已懒加载
`formatters.displayWidth` ⇒ **复用它，不自写第二份**（手搓风格约定：命名沿用本仓黑话，不造 `utils`）。

---

## 6. 目标形态 · 跨端侧

### 6.1 ★ 决定性判断：两端已在同一层

`main/index.ts:357-358` 原文（见 §1.5）：桌面端与 TUI **消费同一个 `runToolUseLoop` 循环**。

⇒ **统一点不在「怎么跑」，在「怎么显示」。**

### 6.2 三条路线对比

| 方案 | 做法 | 输入框 | 新依赖 | 判定 |
|------|------|-------|--------|------|
| **A · 真 PTY + xterm** | `node-pty` 起真 TTY 跑 khy TUI，整屏嵌入 | ❌ **两个**（`PromptFrame` + `Composer`） | `node-pty`（原生，需重编译） | ❌ **与约束⑦直接冲突** |
| **B · 事件流桥接** | TUI 内部状态经 IPC 暴露，桌面端 React 重渲染 | ✅ 一个 | 无 | ⚠ 要碰 6000 行 `App.js`，Ink 组件树无法序列化 |
| **C · 共享语义投影** | 循环回调 → 端无关语义模型 → 两端各自渲染 | ✅ **天然一个** | 无 | ✅ **推荐** |

**A 不行的三条硬理由**：

1. **输入框冲突**（用户明确约束）：`PromptFrame` 与 `Composer` 并存，raw mode 与 textarea 焦点互抢。
2. **同一循环跑两遍**：TUI 在 PTY 里跑一次、桌面端 host 又跑一次 ⇒ 状态分叉、工具调用重复、token 双计。
3. **视觉不可能统一**：xterm 渲染**字符网格**（等宽方块、不能用 CSS 变量做圆角/底色块），
   而 §3 的底色分层靠空格填充（`render-background.js:19`），在 xterm 里只是一片 ANSI 背景
   ⇒ **块状分层根本实现不了**。

**VS Code 反例佐证**：成熟 IDE 的集成终端只跑真 shell，**从不嵌入应用自身的 TUI**。

### 6.3 分层与投影契约

```
runToolUseLoop（已存在，共用）
  │  onChunk / onToolCall / onToolResult / onThinking / onControlRequest / onCost
  ▼
semanticProjection（新增，端无关·纯叶子）        ← 本节核心
  │  { messages[], toolCalls[], tasks[], thinking, approvals[], usage }
  ├──────────────┬─────────────────────
  ▼              ▼
TUI 渲染器      桌面端渲染器
（Ink 组件）     （React 组件）
PromptFrame     Composer          ← 输入各自，模型里没有
```

**投影模型契约**（`semanticProjection.js`，纯叶子：零 IO、确定性、绝不抛、**不改入参**）：

| 节点 | 必填字段 | 可选字段 |
|------|---------|---------|
| `message` | `id, role, text` | `ts, thinking, toolCallIds[]` |
| `toolCall` | `id, name, status` | `input, output, error, startedAt, endedAt` |
| `task` | `id, title, status` | `priority, claimedBy, updatedAt` |
| `approval` | `id, toolName, reason` | `options[]` |
| `usage` | `inputTokens, outputTokens` | `contextUsed, contextTotal, cost` |

⚠ **模型不含输入框、不含光标、不含 viewport** ⇒ 输入框问题**从定义上**消失。

### 6.4 消息区落点（用户红框位置）

`AppLayout.tsx:375` 的 `<main>` 内：
- 上：消息列表（消费投影模型，渲染助手消息 / 工具卡片 / 任务条 / 思考折叠）
- 下：`Composer`（**保持独立，不动**）

⚠ **不新增容器**：`<main>` 已是容器，只需替换消息区子组件。
⚠ **任务面板复用同一底色 token**（§3.3 `ccThemeBg.js`）⇒ 两端**视觉真统一**。

---

## 7. 实施分期

**编号体系**：`P*` = TUI 面板（对应原 174）；`E*` = 跨端（对应原 175）。

| 期 | 内容 | 独立可回滚 |
|---|------|--------|
| **P0** | `ccThemeBg.js`：bg token + **双维降级（色深 × 明度）** + 16 色显式映射（不碰 `ccTheme.js`） | ✅ 纯新增叶子 |
| **P0b** | `tuiConfig.js` 加 `appearance.bgMode` + `terminalCapabilities.js:79` 兜底改 `'unknown'` | ⚠ 改 detection 有跨模块影响，**必须先核消费者** |
| **P1** | `taskSurface.js`：状态 → 底色策略的纯叶子（状态映射 + unknown/无色字形兜底） | ✅ 纯新增叶子 |
| **P2** | ★ **账本同步（两处并行真源）**：`App.js:6501` **与** `chromeRegistry.js:85` 同时 `3`→`1` + 单测钉住 | ⚠ **两处必须同一批改** |
| **P3** | `TaskListPanel.js`：去框线、段头改底色块、接右尾元信息 | ✅ 撤接线 |
| **P4** | 右栏：`SidebarPanel.js` 段序 + `App.js:6663-6666` 传 `currentLine` | ✅ 撤接线 |
| **P5** | 耗时 / 归属（需先解 §9 #5） | ✅ 纯增量 |
| **E0** | ⚠ **先核 §9 #1**：`App.js` / `replSession.js` 是否被并行会话改动 | 只读调查 |
| **E1** | `semanticProjection.js`（纯叶子 + 完整单测） | ✅ 纯新增 |
| **E2** | TUI 侧**旁路**接线：`App.js` 回调里多调一次 `project()`（**不改渲染**） | ✅ 撤一处调用 |
| **E3** | 桌面端消息区组件消费投影（复用既有 `MessageBubble`/`ToolExecutionPanel`，不新建） | ✅ 撤接线 |
| **E4** | ★ **`Terminal.tsx` 处置**：接真后端 **或** 删除（不留假终端） | ✅ 独立，**需拍板** |
| **E5** | 跨端一致性守卫：同一投影输入 → 两端关键字段一致 | ✅ 新增测试 |

### 7.1 顺序纪律（每条都有代价）

⚠ **P2 必须与 P3 同一批落地** —— 先改面板再去边框会短暂让账本虚高，导致预留行数错误。

⚠ **P0 的顺序纪律**：`ccThemeBg.js` 必须**先落单测**再接 P3。
它是降级的唯一入口，若降级路径有 bug，症状是「某些终端上分层消失」——
**这类问题在开发机上（通常是暗色真彩色）看不出来**。
⇒ 单测必须**显式构造 light / dark / unknown / NO_COLOR 四种输入**。

⚠ **P0b 的顺序纪律**：`backgroundMode` 引入第三态 `'unknown'` **必须先 grep 全部消费者**。
若任一消费者假设两值，**改用新增独立字段 `backgroundKnown: boolean`**，保持两值契约不变。

⚠ **E0 不可跳过**：`App.js`（6000 行）与 `replSession.js` 常被并行会话同时改
（本仓已发生双会话共编，`selection.js` 先例）。动手前必须 `git status --porcelain` 确认。

⚠ **推荐跨期顺序**：`P0 → P1 → P2+P3 → E1 → E2 → E3`。
理由：**先建底色 token，桌面端才不用返工对齐颜色**（否则 E3 会先建一套自己的颜色）。

---

## 8. 顺带修复（单独登记）

| # | 缺陷 | 证据 | 处置 |
|---|------|------|------|
| 1 | 手册 C18 称面板是 `Ctrl+T` 召唤的「全宽任务视图」，实为**常驻** | `[DESIGN-ARCH-102]:458-461` vs `App.js:7029` | **改手册**。`Ctrl+T` 真实语义是显隐切换（`App.js:984` `tasksHidden`） |
| 2 | 手册 C17 规定侧边栏两段（`任务` + `上下文`）+ 已完成折叠 | `[DESIGN-ARCH-102]:454-455` | **改手册**对齐 §3.5 新段序。折叠能力已存在（`SidebarPanel.js:198-200`），本方案恢复其数据供给 |
| 3 | rail 门控注释与代码矛盾 | `railLayout.js:31-32` / `sidebarLayout.js:73` 称 DEFAULT ON；`railLayout.js:68-80` 代码 opt-in | ⚠ **只改注释为「opt-in」，不改默认行为**（改行为会让带外 rail 突然激活，不在 CI 覆盖内） |
| 4 | `ccTheme.js:158` 对背景色是 bug | §3.3 | 本方案**绕开**（`ccThemeBg.js` 自解析色深），**不改 `resolvePalette`** ⇒ 20+ 消费者零影响。缺陷本身登记待独立条目 |
| 5 | `ink-components` 已有多处 `backgroundColor` **全是硬编码**，无一走 token | `CcSelectable.js:83,131,184`、`SessionSidebar.js:43,77,83`、`Statusbar.js:46`、`Topbar.js:23`、`ToolLines.js:523-543` | 登记为**独立条目**：全仓底色收口。本方案只保证**新增**的走 token，不顺手改 6 个既有文件 |
| 6 | `Terminal.tsx` 是假终端 | `Terminal.tsx:38-39` | **E4 处置**，需拍板（§9 #3） |

---

## 9. 待核实项

| # | 事项 | 优先级 | 状态 |
|---|------|--------|------|
| **1** | `App.js` / `replSession.js` 当前是否被并行会话改动 | 🔴 **最高**（阻断 E2） | 🔴 必查。本仓已发生双会话共编（`selection.js` 先例）。E0 阶段 `git status --porcelain` 确认 |
| **2** | ★ **任务面板高度账本是「两处并行实现」** | 🔴 **最高**（阻断 P2/P3） | 🟡 **已定位，待改**。`App.js:6501` 与 `chromeRegistry.js:85` 是**同一公式两份独立实现**。`chromeRegistry.js:79` 注释明写 `round border 2 + header 1` ⇒ 去框线后两处都 `3`→`1`，**漏改任一 ⇒ 账本虚高 ⇒ StreamingBlock 每帧被压矮** |
| **3** | ★★ **真终端（方案 A：PTY 跑 shell）—— ABI 硬阻塞 + 无 C++ 工具链** | 🔴 **最高**（阻断 E4 全部） | 🔴 **A-pre 实测确认不可行**（详见 §12 变更日志末条）：<br>① **ABI 不匹配**：Electron 44.2.0 = Node v24.20.0 / **ABI 149**，而已装 `node-pty@1.0.0` 二进制是 **ABI 127**（Node 22）编译的。Electron 主进程实测报错 `was compiled against a different Node.js version`。`require` 成功（解析路径没问题）——**纯 ABI 问题**<br>② **无 `prebuilds/`** ⇒ 无 Electron 预编译产物可捡；`patches/node-pty@1.0.0.patch` 改的是 `src/win/conpty.cc`（C++ 源码）⇒ **本来就必须编译**<br>③ **无 C++ 工具链**：`cl.exe`/`msbuild`/`vswhere` 全无，`node-gyp` 未装（仅 Python 3.11.9）。`electron-rebuild` 已装但缺编译器<br>④ ⚠ **无 `postinstall` 钩子** ⇒ 即使本机重建成功，**CI 与同事机器仍会失败** |
| 4 | `backgroundMode` 第三态 `'unknown'` 的消费者兼容性 | ✅ **已解除** | E0 实测：`backgroundMode` **全仓仅 `terminalCapabilities.js:123` 一处**（自身），**零外部消费者** ⇒ 第三态无兼容风险 |
| **5** | **耗时 / 归属的数据可达性** | 中 | 🔴 不可达。`_taskStore.snapshot():365-404` 是字符串通道，`:379/:382` 丢弃 `createdAt`/`updatedAt`（`:65-66`、`:171-172`）与 `owner`。⇒ P5 需先加**结构化伴生函数**（新增不改签名 ⇒ 加性、可回滚） |
| **6** | **亮色终端的底色实际观感** | 中 | 🟡 **已有解法**（§3.4 四层），但**观感需实测**：本机为暗色环境（`COLORFGBG` 未定义、`TERM=dumb`），**无法在本机复现亮色**。需在亮色 Windows Terminal 下人工验证 §3.4.3 第③层的中性色对可读性 |
| 7 | 投影模型是否需覆盖 `onControlRequest`（人在环审批） | 中 | 待核。`index.ts:193` 已有通道，桌面端 `ElicitationPanel.tsx` 已消费 ⇒ **契约层已有 `approval` 节点**（E4 保留） |
| 8 | 既有测试基线条数 | ✅ **已取真值** | **基线 = 132 绿 / 2 存量红**（`taskPanelState` + `liveFrameGeometry`，同一根因 `describe is not defined`）。真实路径是 `tests/cli/tui/`（**不是** `tests/tui/`） |
| 9 | `ElicitationPanel` / `ToolExecutionPanel` 能否直接吃投影模型 | ✅ **已失效** | E3-pre 查明：**桌面端无需消费投影**（`App.tsx:400-457` 已接线 + `toolExecutionSlice.ts` 是完整状态真源）。投影层已于 E4 降级为契约定义 |
| **10** | **真终端的处置决策** | 🔴 **需用户拍板** | 三条路（详见 §12 变更日志）：<br>① **就地重建** `node-pty` 到 ABI 149（`electron-rebuild` 已装）—— **需先装 C++ 工具链**（VS Build Tools），且**必须加 `postinstall` 钩子**，否则 CI/同事机器仍失败<br>② **换 N-API 包**（`@homebridge/node-pty-prebuilt-multiarch`，带 Windows prebuild）—— 免编译、跨 Electron 版本稳定；代价是新增依赖<br>③ **降 Electron** 到 ABI 127 —— ❌ **代价最大，影响整个桌面端。这条路别走**<br>**我的倾向**：②（免编译 = 与本机「便携免安装」设定一致；且 Electron 升级时不会再次断裂） |
| **11** | ⚠ **本机 `ELECTRON_RUN_AS_NODE=1` 是设着的** | 中 | A-pre 首次 Electron 实测因 `app` 为 undefined 而失败（`electron.exe` 退化成普通 node）。**不是代码问题**，但任何 Electron 侧测试/脚本都必须显式清掉该变量 |

**★ #6 的诚实边界**：本机是暗色环境，**我无法实测亮色终端**。
§3.4 的四层解法是**按「检测可能失效」设计**，不依赖本机验证 ——
第 ③ 层的存在意义正是「即使 `backgroundMode` 判错，也不会不可读」。
**不得声称「已验证亮色」。**

---

## 10. 诚实边界（刻意不纳入）

| 不做 | 原因 |
|------|------|
| **加表格列 / 列头** | §1.4 帧高约束。k9s/gh 的固定列宽是全屏 TUI 能力，本仓面板是嵌入式区块 |
| **改用全屏看板** | 会摧毁 `[DESIGN-ARCH-129]` 刚修好的转录区滚动与选择 |
| **按内容让右栏出现/消失** | §3.5 末：`contentCols` 单一真源，跳变 = 残影 |
| **改 `hideTaskSection` 为 `false`** | 会双份渲染同一份 `taskLines`。P4 给了不粗暴的路径（走新参数 `currentLine`） |
| **动 `contentCols` / `railLayout` 几何** | 宽度口径是单一真源（`railLayout.js:148-164` 大段论证） |
| **改 `resolvePalette` 本体** | 20+ 消费者依赖；`ccThemeBg.js` 绕开即可，零风险 |
| **从 `updatedAt - createdAt` 反推耗时** | 那是总时长不是已跑时长，**谎称即造假** |
| **sparkline 历史趋势** | store 无历史采样，**加了就是拿假数据充数** |
| **去掉已完成行的删除线** | 它是**唯一**语义不可替代的线条（表达「已删去」），且是 CC 对齐项（`taskLineStyle.js:6-11`） |
| **新增 `KHY_*` 门** | `MAX_GATES = 227` **只降不升**；「让面板变好看」不构成用户可见权衡 |
| **嵌套 Box 做渐变式层次** | `render-background.js` 嵌套背景是**覆盖**非叠加 |
| **顺手统一 6 个既有硬编码底色** | §8 #5：独立条目，不在本方案范围 |
| **PTY / node-pty** | §6.2 三条硬理由，且与约束⑦**直接冲突** |
| **把 TUI 的 PromptFrame 搬进桌面端** | 用户明确要桌面端输入框独立。搬过来 = 两个输入框 |
| **两端共用同一个 React 组件树** | TUI 用 **Ink**，桌面用 **DOM**。只能共享**数据**不能共享**视图** |
| **本期改 TUI 的渲染** | P3 才是。E2 只旁路投影数据，**不碰 Ink 渲染** |
| **xterm 里实现底色分层** | 底色靠空格填充，xterm 里只是 ANSI 背景 ⇒ **圆角/块状分层做不出来** |
| **在语义模型里放输入框 / 光标 / viewport** | 会把两端 UI 差异塞进数据层 ⇒ 输入框问题**从定义上**被排除 |
| **新建桌面端消息组件** | 复用既有 `MessageBubble`/`ToolExecutionPanel`，不新建并行实现 |

---

## 11. 验收方式

```bash
# ① 新增叶子零 IO / 确定性 / 绝不抛
node scripts/ci/check-leaf-contract.js services/backend/src/cli/tui/theme/ccThemeBg.js
node scripts/ci/check-leaf-contract.js services/backend/src/cli/tui/ink-components/taskSurface.js
node scripts/ci/check-leaf-contract.js services/backend/src/services/semanticProjection.js

# ② ★ 双维降级（开发机通常是暗色真彩色，必须显式构造全部档位）
node --test services/backend/tests/tui/ccThemeBg.test.js
node --test services/backend/tests/tui/taskSurface.test.js
#   必须覆盖的输入矩阵（缺一不可）：
#     色深：truecolor(24) / ansi256(8) / ansi16(4) / NO_COLOR
#     明度：dark / light / unknown
#   断言：unknown 档下 bgActive/bgDanger 必须为 null（状态交给字形）

# ③ 投影层单测（E1 落地即须绿）
node --test services/backend/tests/semanticProjection.test.js
#   必测：畸形输入不抛、返回新对象、不改入参、状态枚举越界保守归类

# ④ ★ 行数中性 + 账本同步
node --test services/backend/tests/tui/taskPanelFrameNeutrality.test.js
#    断言：去框线后总行数 = 改前 - 2；App.js:6501 与 chromeRegistry.js:85 两处同步

# ⑤ 既有基线零回归 ★ 路径已由 E0 实测订正（不是 tests/tui/，而是 tests/cli/tui/）
#    基线真值 = 132 绿 / 2 存量红（taskPanelState + liveFrameGeometry，同一根因 describe 未定义）
node --test services/backend/tests/cli/tui/ccThemeBg.test.js \
             services/backend/tests/cli/tui/ink-components/taskPanelHeader.test.js \
             services/backend/tests/cli/tui/taskPanelLines.test.js \
             services/backend/tests/cli/tui/sidebarPanel.test.js \
             services/backend/tests/cli/tui/ccTheme.test.js \
             services/backend/tests/cli/taskLineStyle.test.js \
             services/backend/tests/cli/taskLinesMemo.test.js

# ⑥ 真帧验证（用 tests/tui/vtScreen.js 读最终屏幕态，不数累积字节流）
#    ⚠ 该文件当前是存量红（jest 风格），先修它再当门禁
node --test services/backend/tests/tui/liveFrameGeometry.test.js

# ⑦ 桌面端契约（D6 强制 preload↔main 两侧一致；D9 禁品牌文本）
node apps/khyos-desktop/tests/desktopUiContract.test.cjs

# ⑧ 类型检查（⚠ 改动前已有 33 条基线错误，只看「是否新增」）
node apps/khyos-desktop/node_modules/typescript/bin/tsc -p apps/khyos-desktop/tsconfig.json --noEmit

# ⑨ 设计 token（桌面端颜色必须走 CSS 变量，禁硬编码）
node scripts/ci/check-frontend-design-tokens.js

# ⑩ 跨端一致性（E5）
node --test services/backend/tests/semanticCrossSurface.test.js

# ⑪ 门预算零漂移
node scripts/ci/check-tui-gates.js
```

⚠ **CI 纪律**（本仓已踩过：`services/backend/tests/gateway/cliFailureEnvelope.test.js` 是 jest 风格，
被 `node --test` 扫到会报 `describe is not defined`）：新测试一律 `require('node:test')`。
`services/backend/package.json:59` `test:node = node --test tests/**/*.test.js`
的通配符**未加引号**（`deploy-staging.yml:97-99` 注释确认 shell 会展开）
⇒ `tests/**` 下新测试**落地即被 CI 扫到，必须当天绿**。
⚠ 禁 jest 全局（裸 `describe`/`test`/`expect`）。
✅ `jest.config.js:25-80` 会自动发现 `require('node:test')` 的文件并塞进 `testPathIgnorePatterns`
⇒ 用 `node:test` 写在 `tests/<任意子目录>/` 是安全的。
⚠ 先跑既有套件再跑新测试（顺序别反，能当场抓住 require 路径写错）。

⚠ **桌面端改动后必须重建三段**（否则用户看到的还是旧构建）：
`electron-vite build` + `vite build --config vite.host.config.ts` + `vite.scheduler.config.ts`。
⚠ `tsc --noEmit` 改动前就有 **33 条基线错误** ⇒ **不能把「tsc 全绿」当门禁**。

⚠ **`check:frontend-size` 在没 build 时恒 exit=2**（无产物可量），别误判成失败。

---

## 12. 变更日志

| 日期 | 变更 |
|------|------|
| 2026-10-02 | **174 初稿**：基于 TUI 面板截图 + 四条硬约束，确立「面板不丑是瘦」的判断；复核 `ink/build/render-background.js` 得出「底色不改字符数 ⇒ 零 reflow」；确立底色分层替代线条。 |
| 2026-10-02 | 追加 lipgloss / k9s / ratatui / gh / bubbletea / gum 底色做法对比，确立四条原则。发现并登记 `ccTheme.js:158` 对背景色的既存缺陷。 |
| 2026-10-02 | **173 实测推翻初稿前提**：原判右栏是带外 rail；实测系统 env 无 `KHY_SIDEBAR_RAIL`、6 个启动脚本均不注入 ⇒ 实际是**树内 `SidebarPanel`**。据此修正落点、新增高度校验期。 |
| 2026-10-02 | **物理合并 172/173**（用户要求「统一为一个文档」）：两份分提案连同 `.html` 生成物已删除。 |
| 2026-10-02 | **补齐亮色终端方案**（§3.4）。⚠ **订正上一轮错误陈述**：我原说「`terminalCapabilities.js` 无背景明度判定」——**不准确**，`:76-89` 确有 `backgroundMode`；真缺陷是 `:79` 兜底**恒判 `'dark'`**。本机实测 `COLORFGBG` 未定义 + Windows Terminal 已装 ⇒ 亮色 WT 下必然判 dark。 |
| 2026-10-02 | 门预算订正：`check-tui-gates.js:41` `MAX_GATES` 实为 **227**（非 skill 文档记的 220）；`:28-30` 明写用户偏好应迁 `~/.khyquant/tui.json` ⇒ 覆盖项走 `tuiConfig` 而非新增 env 门。 |
| 2026-10-02 | **175 初稿**：基于桌面端截图（红框消息区 + 独立输入框），实测 `Terminal.tsx`（stub `:38-39`）、`AppLayout.tsx:375`、`preload/index.ts:47-70`、`index.ts:189-195`+`:357-358`，得出「两端已共用 `runToolUseLoop`，统一点在渲染层之下」的核心判断；否掉 PTY 方案（三条硬理由）。 |
| 2026-10-02 | **合并为 176（本文件）**：174 + 175 物理合并，两份原提案连同其 `.html` 生成物**已删除**。统一编号体系（`P*` 面板 / `E*` 跨端），补充跨期顺序纪律与 VS Code 反例佐证。 |
| 2026-10-02 | **E0 实测订正三处**（实施前必读）：<br>① **测试真实路径是 `tests/cli/tui/`，不是 `tests/tui/`** —— §11 ⑤⑥ 的命令路径写错了，真实文件为 `tests/cli/tui/{taskPanelHeader,taskPanelLines,sidebarPanel,ccTheme}.test.js` + `tests/cli/{taskLineStyle,taskLinesMemo}.test.js`<br>② **基线实测 = 132 绿 / 2 存量红**。两个红是 `taskPanelState.test.js` 与 `tui/liveFrameGeometry.test.js`，**同一根因**：用了裸 jest 全局（无 `require('node:test')`）⇒ `describe is not defined`。**属既存缺陷，非本方案引入**<br>③ **`backgroundMode` 全仓只有 1 处**（`terminalCapabilities.js` 自身），**零外部消费者** ⇒ §9 #4 的第三态兼容风险**不成立**，P0b 可安全引入 `'unknown'` |
| 2026-10-02 | **P0 实施完成**（`ccThemeBg.js` + `ccThemeBg.test.js` 20 条全绿）。<br>**实施中抓出并修掉 2 个真 bug**：<br>① `resolveBackgroundMode` 对三段式 `COLORFGBG=15;default;0` 会读末段 `0` ⇒ 误判 dark。xterm 约定「不可知时该位写 `default`」⇒ **已修为判 `unknown`**<br>② `normalizeDepth(Symbol)` 抛 `TypeError`（`Number(symbol)` 会抛）⇒ 违反「绝不抛」铁律。**已加类型守卫**<br>**门预算归因闭合**：`check-tui-gates` 报 236 > 227（超 9），但 `ccThemeBg.js` 的 `KHY_*` token 数 = **0**（纯叶子不读 env 的直接结果），且 TUI 目录唯一新文件即本次产物 ⇒ **超标 9 个系既存，非本方案引入**。算术校验：227 + 9 = 236 ✅ |
| 2026-10-02 | **P0–P3 全部实施完成。** 落地清单：<br>🆕 `src/cli/tui/theme/ccThemeBg.js` —— 底色 token 层，5 token × 双维降级（色深 4 档 × 明度 3 档）<br>🆕 `src/cli/tui/ink-components/taskSurface.js` —— 状态→底色策略，**复用 `taskPanelLines.taskLineStatus` 判据，不另立图标表**<br>🆕 `tests/cli/tui/ccThemeBg.test.js`（21 条）+ `tests/cli/tui/taskSurface.test.js`（17 条）<br>✏️ `chromeRegistry.js:85` + `App.js:6501` —— 账本 `3`→`1`（并行真源同改）<br>✏️ `TaskListPanel.js` —— 去 round 外框、`— 标签 —` 改中性底色块、行接状态底色<br>**实施中抓出并修掉 4 个真 bug**：<br>① `COLORFGBG=15;default;0` 误判 dark（xterm 的 `default` 段语义）<br>② `normalizeDepth(Symbol)` 抛 TypeError<br>③ **P1 初版把 `glyph` 设计成「再报一次图标」** ⇒ 会渲染出 `✓ ✓ 读取快照`。已改为 `mark`（**追加的冗余标记**，只有 error 在无底色时补 `!`）<br>④ **`ccThemeBg.js` 的 16 色 + 亮底档给了 `cyan`/`red`** ⇒ 等于绕过本层自己立的「unknown 才禁用彩色底」规矩。已改为与 unknown 同策（ANSI 命名色对比度由终端主题决定，不可控）<br>**偏离方案之处（逐条给原因）**：<br>· §3.3 原写「16 色档亮底改用 `white` 底 + 显式黑字」——实施时发现**无法显式控制终端的前景色**（16 色命名色的前景由终端主题定），故改为**不给状态色**而非「给白底黑字」。诚实性优先于完整性。<br>**验收实测**：<br>· 新增单测 38 条 + 既有基线 132 条 + `liveRegionBudget` 25 条 = **195/195 全绿、零漂移**<br>· 三层叶子契约全过（`ccThemeBg` / `taskSurface` / `TaskListPanel`）<br>· ★ **真帧渲染验证**（ink 真实 `loadInk()` 后渲染数行）：四种场景 —— 真彩色暗底 5 行 / 带尾切 6 行 / NO_COLOR 5 行 / unknown 5 行，**全部与账本期望一致** ⇒ 账本与渲染未脱节<br>· 门预算仍 236（存量未变）；2 个存量红归因未变（`describe is not defined`） |
| 2026-10-02 | **E1 完成**（`semanticProjection.js` + 21 条单测）。<br>**★ E1-pre 核实纠正了 §1.5 的三处不准确**：<br>① **回调真实路径不是 `services/tool/toolUseLoopCore.js`** —— 实为 `src/services/toolUseLoopCore.js` 与 `src/services/toolUseLoop.js`，两者**均无** `onToolCall/onToolResult/onThinking` 字样（薄封装转发）。真实消费点在 `replSession.js:11128/11137/11851`（TUI）与 `host/index.ts:428-458`（桌面端）<br>② **`host/index.ts:7-8` 的协议注释是过时的** —— 只声明了 `ai.chunk`/`ai.result`，但 `:428-458` 实际在发 `ai.toolCall`/`ai.toolResult`/`ai.controlRequest`。**代码是真实的，注释没跟上**<br>③ ★★ **两端 `onToolResult` 参数顺序不同**（这是本层存在的核心原因之一）：<br>　TUI `replSession.js:11137` → `(name, result, params)` —— 第 2 参是 **result**<br>　host `host/index.ts:430` → `(name, params, toolResult, iteration, elapsed)` —— 第 2 参是 **params**<br>　⇒ 投影层提供 `toolResultFromTui` / `toolResultFromHost` **两个显式入口**，绝不让消费方靠猜<br>**真实回调签名**（投影层据此建契约）：`onToolCall(name, params)` / `onToolResult(...)` / `onControlRequest({requestId, request})` / `onChunk(chunk)`（走 `chatOpts` 内层）/ `onCost(usage)`。⚠ `elapsed` 存在 ⇒ 桌面端**已有耗时数据**，TUI 侧无<br>**实施中抓出并修掉 3 个真 bug**：<br>① ★ **用 `hasOwnProperty(CALL_STATUS, status)` 校验状态 = 拿值查键，恒 false** ⇒ 所有合法状态被误判 `unknown`。已改为 `CALL_STATUS_VALUES.indexOf()` 值集合校验（`ROLE` 同病同治）<br>② `Number(Symbol)` 抛 TypeError —— **与 P0 在 `ccThemeBg.js` 踩的是同一个坑**，说明「纯叶子绝不抛」是**每个叶子各自**要守的纪律，不是一次修完就全局生效。已加 `_num()` 守卫<br>③ 聚合函数展开 `proj.messages` 时，若传入「形状像但数组不是数组」的对象（如 `{messages:'abc'}`）会抛 `is not iterable`。已加 `_normalizeProj()` 统一归一<br>**设计约束落地**：`usage()` **刻意不自算百分比**（除零/未知是渲染决策，塞数据层会逼消费方反推）；模型**不含 input/cursor/viewport/scroll**（有专门断言钉住）<br>**验收**：**216/216 全绿、零漂移、四层叶子契约全过**（既有 195 + E1 新增 21） |
| 2026-10-02 | ★★ **E3-pre 推翻 E3 的前提 —— 本方案最重要的一次订正。**<br>**误判**：§7 的 E3 写「桌面端消息区组件消费投影」，隐含前提是「桌面端还没接工具事件」。<br>**实测真相**：桌面端**早已完整接线** ——<br>· `renderer/App.tsx:400-457` 监听 `onAiToolCall`/`onAiToolResult` 并 dispatch<br>· `renderer/state/toolExecutionSlice.ts` 是完整状态真源：**5 态**（含 `pending`/`cancelled`）+ `history`（上限 50）+ `affectedFiles` + `activeIds`<br>· `ToolExecutionPanel.tsx` 有完整的折叠/复制/耗时/失败渲染<br>**既有实现优于本方案的初版设计**：<br>· **id 配对**：`App.tsx:398-399` 原文「callId 由 host 侧按同名 FIFO 配对（循环回调不带 id）…**不按工具名找 —— 并行同名工具会张冠李戴**」；而本层初版在 id 缺失时**回落到 name**，正是这个错法<br>· **失败判定**：`App.tsx:431-434` 查 `isError` + `success===false` + **字符串前缀 `/^\s*error[:：]/i`**；本层 `_isFailure` 只查 4 个对象字段，**漏了字符串形态**<br>· 状态数 5 vs 4、history 有 vs 无、`startedAt+completedAt` 可算 running 时长 vs 单值 `elapsedMs`<br>**⇒ 真正的缺口不是「桌面端没接」，而是「TUI 侧没有对应物」**（工具调用散在 `replSession.js` 三个回调里直接打屏） |
| 2026-10-02 | **E4 完成：投影层降级为契约定义**（用户 2026-10-02 拍板）。<br>**删除**（与既有 slice 重复 = 第二份状态真源）：`createProjection` / `appendMessage` / `upsertToolCall` / `withUsage` / `_normalizeProj`。<br>**保留**（真实价值）：`toolResultFromTui` / `toolResultFromHost` 双入口（两端参数顺序确实不同）、值集合校验、`_num` 守卫、纯叶子铁律、「模型不含 UI 状态」断言。<br>★ **修掉一个会导致张冠李戴的设计错误**：`toolCall()` 的 id 缺失时**回落到 name** ⇒ 并行同名工具（「Bash」×2）会让后一个结果配到前一个调用上。已改为**返 `null`（未配对）**，并在文件头与单测里写明依据（`App.tsx:398-399`）。<br>**实施中又抓一个我自己写错的断言**：曾把 `input`（工具入参，**核心数据**）列进「不该有的字段」黑名单 ⇒ 与「输入框 UI 状态」混淆。已拆成两组：`UI_ONLY = [prompt, cursor, viewport, scroll, columns, rows, focus, composerValue, selection, inputValue, draft]`，并**正向断言** `input` 必须存在。<br>**瘦身成果**：368 行 → **275 行**，导出 21 → **10 个符号**。<br>**验收**：既有 195 + 投影层 20 = **215/215 全绿、零漂移**；叶子契约全过；**桌面端一行未改**（`desktopUiContract` exit 0） |
| 2026-10-02 | **「真终端」方案待定（用户 2026-10-02 拍板「做成真终端」）。** 该决定**推翻了 §6.2 否掉 PTY 的核心论证**，需重新划范围。<br>**已核实的前提**：`node-pty` **已在根 `node_modules`**（不在 `apps/khyos-desktop/node_modules`）；`@xterm/xterm` + fit/web-links/search/webgl 四 addon 已装；TUI 的 stdin 依赖**可降级**（`uiStdinFallbacks.js:28`「setRawMode 不存在就退」、`app.js:253/287` 判 `isTTY`）。<br>**「真终端」有两种截然不同的实现**：<br>**A · PTY 跑 shell**（`node-pty.spawn('pwsh.exe')`）—— 输入框在 xterm 内，**与 Composer 零冲突**；VS Code 集成终端同款做法。⚠ 不含 khy AI 能力<br>**B · PTY 跑 khy TUI 本身**（`spawn('khy')`）—— 完整的 khy AI 终端、能用 `/s!` 等 TUI 快捷键；⚠ **但会引入第二个输入框**（TUI 的 `PromptFrame` + 桌面端 `Composer`），焦点与 raw mode 互抢，且 TUI 与桌面端状态分叉 ⇒ **与 §6.1「统一的是显示不是输入」的前提冲突**<br>**⇒ 需用户明确选 A 还是 B**（B 需额外决定：切 tab 时是否隐藏 Composer、是否共享同一会话）。§7 的 E4 阶段（`TerminalPanel` 处置）**保持挂起**直到该决定落地。 |
| 2026-10-02 | **用户选定 A（PTY 跑 shell）** —— A-pre 实测遇**硬阻塞**，方案 A 在本机当前状态下**不可实施**。<br>**已核实的前提（好消息）**：<br>· `node-pty` **已在根 `package.json` 登记为依赖**（`node-pty@^1.0.0`），不是本地残留<br>· **Node 侧完全可用**：spawn 成功，输出带完整 ANSI 序列（`spawn OK, exit=0`）<br>· `@xterm/xterm` + fit/web-links/search/webgl 四 addon 已装在 app 侧<br>· 走 pnpm 布局；`patches/node-pty@1.0.0.patch` 已存在，改的是 `binding.gyp` + `src/win/conpty.cc` + `src/win/winpty.cc`（**C++ 源码 ⇒ 本来就必须编译，没有免编译路径**）<br>**硬阻塞 —— ABI 不兼容（Electron 主进程实测，非推断）**：<br>`The module '...node-pty\build\Release\conpty.node' was compiled against a different Node.js version`<br>· Electron 44.2.0 内置 **Node v24.20.0 / modules ABI 149**<br>· 已装二进制是给 **Node 22 / ABI 127** 编译的<br>· `require` 本身**成功**（解析路径无问题：pnpm 的 `.pnpm/node-pty@1.0.0_patch_hash=...`），**纯粹是 ABI 不匹配**<br>· `node-pty@1.0.0`（2019 年包，依赖 `nan`）**无 `prebuilds/` 目录** ⇒ 没有 Electron 预编译产物可捡<br>**次生阻塞 —— 无 C++ 工具链**：<br>· `cl.exe` / `msbuild` / `vswhere` **全部不存在**；`node-gyp` 未装；仅 Python 3.11.9 可用<br>· `electron-rebuild` **已装在根**（工具在，缺编译器）<br>· ⚠ `apps/khyos-desktop/package.json` **无 `postinstall` 钩子** ⇒ 即使本机重建成功，**CI 与同事机器上仍会失败**<br>**附带订正**：本机环境 **`ELECTRON_RUN_AS_NODE=1` 是设着的** ⇒ 首次 Electron 实测因 `app` 为 undefined 而失败（`electron.exe` 退化成普通 node）。**这不是代码问题**，但任何 Electron 侧测试都必须显式清掉该变量。<br>**⇒ 待用户决策（§9 #10）** |
