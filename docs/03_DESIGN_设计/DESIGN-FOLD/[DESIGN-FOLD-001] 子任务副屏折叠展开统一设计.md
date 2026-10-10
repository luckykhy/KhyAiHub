<!-- IMPL-STATUS: done -->
# [DESIGN-FOLD-001] 子任务副屏折叠展开统一设计

> 状态：已核验、已实现（实现清单见 §7）。本文是「子任务（agent 族并行 fan-out）
> 的折叠 / 展开 / 副屏查看」的**单一真源**，管键位契约、数据流与门控回退；
> 不覆盖各既有折叠机制自己的真源（DESIGN-ARCH-053 / DESIGN-ARCH-103 / DESIGN-ARCH-151）。

## 0. 结论（核验记录）

设计前对本仓做了全量代码核验（2026-09-27），确认可行且**零新增键位、零新增视图分支槽位**：

- 子任务实时树已存在：`AgentTool` progressCallback → `useQueryBridge.makeAgentProgress`
  → 共享纯 reducer `cli/agentTreeView.applyProgressEvent` → `tool._agentTree` →
  `ToolLines` 内嵌 `AgentTree` 渲染。
- 缺口有三个：①树的展开态只受全局 Ctrl+O 驱动，无逐树展开；②子 agent 正文只有
  一行 preview（`subAgentTextStream` 的 `agent_text` 事件），全量输出无处可看；
  ③后台 agent 完成前用户没有「副屏」可翻看子任务实时输出。

**登记与发布核验（2026-09-27 补）**：本文落盘时 `DESIGN-FOLD/` 是**未注册的新夹**——
既不在 `00_INDEX_设计-分类索引.md` 的分级清单，也无就近索引，且全夹**无 `.html` 孪生**
（`verify_docs_site.js` 报 2 个「缺少 HTML」，即本设计在文档站上根本不可达）。
现补：`DESIGN-FOLD/00_INDEX_DESIGN-FOLD-总目录.md`、根索引分级条目与就近索引登记表行，
并跑 `docs:build` 生成孪生；复验 `1264 md / 14201 链接` 全绿。
教训同型于任何新夹：**新建 `docs/` 子夹必须同时补就近索引 + 根索引登记 + 跑构建**，
少一步则该文档只存在于磁盘，不存在于站点。

## 1. 现状：折叠机制对照（核验时点）

| 机制 | 键位 | 代码位置 | 与本设计的关系 |
| --- | --- | --- | --- |
| 工具/命令输出折叠 | Ctrl+O（全局） | `toolDisplayPolicy.js` / `ToolLines.js` / `ProcessGroup.js` | 保持不动；子任务树跟随其 `expanded` prop |
| 网关 notice 折叠 | Ctrl+G | `App.js`（`content._collapsed`）+ `Transcript.js` | 无关，不并入 |
| 思维链折叠 | Ctrl+E / 点击 | `transcriptLines.js` folds + `expandedThinking` Set | **逐条点击 Set 模式的先例**，本设计的逐树展开复用同型交互 |
| 统一折叠模型 | —（模型层） | `tui/foldModel.js` | kind 词表增补 `'agent'`（登记性） |
| live 区高度预算 | — | `liveRegionBudget.js` 等 | 副屏沿用「有界高度」纪律，不新增预算项 |

**键位契约（统一后，各安其位、互不抢键）**：

| 键/交互 | 作用域 | 行为 |
| --- | --- | --- |
| Ctrl+O | 全局 | 折叠/展开一切可折叠（含子任务树），现状保留 |
| **点击子任务树卡** | 单棵树 | 逐树展开/收起（新增；与工具卡的既有点击展开同一 Map 状态 `toolExpanded`） |
| **↓（回合执行中）** | 副屏 | 打开窥视副屏：最近工具是 agent 族 → **子任务副屏**；否则 → 既有 ShellView 实时输出。**本回合还没有工具调用时不响应**：没有可看的内容就不摆空框，改由一行提示说清入口与时机 |
| ↑/↓、← | 副屏内 | 滚动 / 返回（arrowRouting `shellView` context 原样复用） |

**「本回合还没有工具调用时不响应」是 2026-10-09 加的**（用户反馈「执行过程中的下键不知道搞什么的，不清楚，很难看作用是什么」）。
改动前的行为是：执行中按 `↓` 无条件开板，于是第一轮（尚未调用任何工具）按下去得到的是一个
**占满主区、正文只有一句「← 返回」的空框** —— 用户看不出它是干什么的。三处落点：

- `cli/tui/arrowRouting.js`：`executing.down` 由静态映射变为条件绑定（输入 `hasTool`），
  没有工具可看时降级为 `subview:peekUnavailable`（缺省按「还没有」处理：宁可不开，也不开空框）；
- `cli/tui/ink-components/App.js`：该动作**不静默吞键**，用 `showHint` 说明入口与时机
  （按了没反应，和看到一个不说话的框一样费解）；
- `cli/tui/ink-components/ShellView.js`：面板自己说清身份、入口与生命周期 —— 页脚由
  `← 返回` 改为 `← 关闭 · 回合结束后自动关闭`（此前只有返回键，用户既不知它是哪个键打开的，
  也不知它会随回合结束自己消失）；空态分支保留为组件的诚实空态（正常按不出来）。

同一把尺：`ShellView.latestTool`（App 判定 `hasTool` 与面板取内容用同一个函数），
故「面板不会开成空框」不靠两处各自记住。键位目录侧，`services/domain/config/keybindings/keybindingCatalog.js`
新增「回合执行中（输入框为空）」组，`/keybindings` 与 `?` 浮层不再只写「↑/↓ 浏览历史」。

## 2. 三层查看模型

子任务输出按「信息量递增」分三层，用户逐层深入：

```
L1 折叠头行   ● Running 2 agents…  (Ctrl+O 展开)          ← committed 且未展开时
L2 树展开     ├ 基本面分析师 · 3 tool uses · 2.1s          ← Ctrl+O 或点击卡
              │ └ Reading server.js
L3 子任务副屏 ⊟ 子任务副屏  · 2 agents                      ← ↓ 打开，↑↓ 滚动
                ● 基本面分析师 · running
                  <该子 agent 的全量正文输出（有界尾部保留）>
                ● 风控经理 · completed · Done
```

- L1/L2 现状已有；本设计补 **L2 的逐树入口**（点击）与 **L3 的全量正文**。
- L3 复用 ShellView 的「主屏内窥视子视图」槽位（`App.js` 视图切换链的
  `shellViewOpen` 分支），不新增视图分支、不进 overlay 栈 —— 因此高度有界、
  arrowRouting 的 `shellView` context（↑↓ 滚动、← 退出）零改动直接生效。

## 3. 数据流：全量正文缓冲（单一接缝）

子 agent 正文 delta 的**唯一生产点**是 `AgentTool` 的 `_onTextDelta`
（`tools/AgentTool/index.js`，onChunk 链）。本设计不建第二条事件总线，只在该接缝
多发一路事件：

```
子 agent onChunk(text delta)
  → subAgentTextStream.buildAgentOutputEvent(delta)     # 新：{type:'agent_output', text}
  → progressCallback（与 agent_text 同门控 KHY_SUBAGENT_TEXT_STREAM）
  → useQueryBridge.makeAgentProgress(batchId)           # 现有管道，零改动
  → agentTreeView.applyProgressEvent(prev, event)       # 新 case 'agent_output'
      agent.outputLines += delta 拆行（尾部保留，cap 400 行）
      agent.outputTail  = 未收尾的末行残片
      agent.outputDropped = 因 cap 丢弃的行数（诚实计数）
  → tool._agentTree[].outputLines                        # L3 副屏 / 未来消费方读取
```

**有界性**：每 agent 正文行缓冲 cap 400 行（`agentTreeView.OUTPUT_LINES_CAP`），
超出丢最老、留 `outputDropped` 计数；单 delta 不设限（增量本就是小片）。
纯叶子、确定性、绝不抛 —— 与 `agentTreeView` 既有纪律一致。

## 4. 门控与字节回退

| 改动 | 门控 | 关闭时行为 |
| --- | --- | --- |
| `agent_output` 事件 | 复用 `KHY_SUBAGENT_TEXT_STREAM`（不新增开关） | 生产端不发事件 → reducer 不触 → 树/副屏逐字节回退 |
| 逐树点击展开 | 无门控（加法交互，无按键/静态文本变化） | 不点击即不生效 |
| 副屏 agent 分支 | 无门控（仅在「最近工具是 agent 族且带 `_agentTree`」时才走新分支） | 非子任务场景走原 ShellView 分支，逐字节不变 |

诚实红线：副屏在正文被 cap 截断时必须显示「早前 N 行已省略」，不许假装看全了。

## 5. 与 RUNTIME-004（滚动区）的关系

本设计**不引入任何 DECSTBM 滚动区**。L3 副屏是有界高度的子视图（ShellView 同型），
整站 TUI 已持有合法的备用屏幕缓冲区（`tui/app.js` 的 `\x1B[?1049h`），
滚动由 `arrowRouting` 的 scroll 动作驱动 Viewport 式切片，符合规则 4 的全部约束。

## 6. 不支持清单（诚实边界）

- 不支持副屏内**回看已结束多轮**的历史子任务：副屏只看「当前/最近一次工具」；
  历史子任务的正文本就不持久化（`agent_text` preview 亦不入 JSONL），不造假功能。
- 不支持后台 agent（`run_in_background`）的实时副屏：其结果走
  `<task_notification>` 注入下一轮的既有通路，本设计不改。
- 不支持逐 agent（树内分支级）独立展开：L2 的粒度是**一棵树**（一次 fan-out），
  与工具卡粒度一致，避免第三套展开状态。
- 经典 REPL 前端不获得副屏：readline 无副屏槽位，reducer 的 `agent_output`
  case 对其无害（它只读 `outputLines` 才有意义，不读即无副作用）。

## 7. 实现清单（与本文判据一一对应）

| 判据 | 实现 |
| --- | --- |
| §3 数据流 | `services/subAgentTextStream.js` 增 `buildAgentOutputEvent`；`tools/AgentTool/index.js` `_onTextDelta` 同接缝转发；`cli/agentTreeView.js` 增 `agent_output` case + `OUTPUT_LINES_CAP` + `outputLines/outputTail/outputDropped` |
| §2 L2 逐树展开 | `cli/tui/ink-components/ToolLines.js` 子任务卡挂 `onClick/onMouseOver/onMouseOut`（与工具卡同 `toolExpanded` Map），`AgentTree` 的 `expanded` prop 变为 `expanded || toolExpanded.get(i)` |
| §2 L3 子任务副屏 | `cli/tui/ink-components/ShellView.js` 增 agent 族分支：最近工具带 `_agentTree` 时渲染子任务副屏（状态头 + 全量 outputLines + 截断诚实计数 + 有界滚动） |
| §1 模型登记 | `cli/tui/foldModel.js` kind 词表注释增补 `'agent'` |
| 测试 | `tests/cli/agentTreeViewFold.test.js`（**新文件**，非 `agentTreeView.test.js`）5 例：拆行/未收尾尾行、纯函数不改入参、cap 保留尾部且 `outputDropped` 诚实计数、敌意输入不抛、`agent_output` 只在 running 期累积且缓冲**跨完成存活**；`tests/services/subAgentTextStream.test.js` 补 `buildAgentOutputEvent` 形状/字符串强转/不抛用例 |

### 7.1 逐判据核验手段（2026-09-27 复核）

实现清单只说「改了哪」，不说「凭什么算验过」。补齐这一列，避免把「源码里有这段」
误当「行为已被测住」：

| 判据 | 核验手段 | 强度 |
| --- | --- | --- |
| §3 数据流（reducer 累积 / cap / 诚实计数） | `agentTreeViewFold.test.js` 真跑纯 reducer | **自动** |
| §3 事件形状（`{type:'agent_output', text}`） | `subAgentTextStream.test.js` | **自动** |
| §2 L2 逐树点击展开 | 源码核验：`ToolLines.js:929-952` 挂 `onClick` 复用 `toolExpanded` Map，`AgentTree` 的 `expanded` = `expanded \|\| toolExpanded.get(i)` | 人工 |
| §2 L3 子任务副屏渲染 | 源码核验：`ShellView.js:154-159` 走 `_renderAgentPeek`，`_agentPeekLines` 展平 + 截断计数行 | 人工 |
| §4 字节回退（关 `KHY_SUBAGENT_TEXT_STREAM`） | 源码核验：生产端 `_onTextDelta` 与 `agent_text` 同门控，关门即不发事件，reducer 无 case 触发 | 人工 |
| §5 无滚动区 | `check-agent-rules.js`（DECSTBM 扫描）覆盖 `ShellView.js` / `ToolLines.js` | **自动** |

> 已知测试空洞：L2/L3 两个 UI 判据**无自动用例**。它们的不回归目前只靠人工评审，
> 若要收口需 ink 渲染快照测试（走 `run-ink-tui-tests.js`），属独立增量，不在本设计范围。
