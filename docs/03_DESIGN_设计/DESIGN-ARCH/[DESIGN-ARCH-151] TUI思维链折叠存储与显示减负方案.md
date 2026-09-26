# [DESIGN-ARCH-151] TUI 思维链折叠存储与显示减负方案

> **状态**：部分实施 —— P2 已落地（2026-09-26）；P4/P5（逐条点击展开 + 流式跑马灯）由用户当轮裁决新增，
> 并**推翻**了 §5 第一条原边界；P3 仍未启动（等 §1.3 判定）
> **范围**：`services/backend/src/cli/tui/`（显示层）、`services/backend/src/cli/repl/`（仅指认）、gateway adapter 层（仅指认）
> **上游依赖**：无新增
> **调研指针**：DESIGN-ARCH-103（foldModel 统一折叠模型）、DESIGN-ARCH-128（输出卫生层）
> **模板合规**：按 `[DESIGN-ARCH-124]` 体例；B-P2 逐字段据实填写（见 §2）

---

## 0. 一句话结论

**折叠与存储机制已经存在、且默认就是折叠的**——思维链全文既显示不全屏刷，也没有丢：它以「💭 思考 · N 字」一行折叠显示、以全文存进会话 JSONL 的 `_timeline` 字段。截图里「乱七八糟全量平铺」的根因不在「没做折叠」，而在下表三条路径之一：

| # | 病灶 | 证据 | 本提案处置 |
|---|---|---|---|
| A1 | 全局 showAll（Ctrl+E）处于展开态，thinking 全文平铺 | `App.js:5009-5012`、`transcriptLines.js:205-207` | P1：操作引导，零代码 |
| A2 | 跑的是旧构建 / 旧会话回放，折叠行为未生效 | — | P1：构建新鲜判定 |
| A3 | **推理文本被 adapter 并进了 `text` 段**（非 thinking chunk），渲染层对 text 全量 renderMarkdown，无任何折叠 | `transcriptLines.js:190-197`（text 分支无折叠）；截图内容带完整 markdown 结构（标题/加粗/分层），形态是正文而非 💭 行 | P3：治本点在 adapter 层归位，不在渲染层猜 |
| G1 | 折叠行**不显示真实思考耗时**：`durationMs` 已存进 timeline 却没人消费 | 存：`queryBridgeTimeline.js:522-537`；弃：`transcriptLines.js:209` 只显字数 | P2：一行显示层改动 |

## 1. 现状实证（file:line 可复核）

### 1.1 显示链：默认已折叠

| 环节 | 行为 | 证据 |
|---|---|---|
| committed thinking（已定格消息） | `showAll=false` → 一行 `💭 思考 · N 字`；`showAll=true` → `💭 思考` + 全文 | `services/backend/src/cli/tui/transcriptLines.js:198-211` |
| 流式 thinking（正在生成） | 单行预览 `💭 <首行>`（换行压空格、按显示宽截首段） | `services/backend/src/cli/tui/ink-components/App.js:5957-5963` |
| 全局展开开关 | Ctrl+E = CC `transcript:toggleShowAll`，复用全局 `expanded` state，退出浮层后 live 区同口径 | `App.js:5009-5012`、`App.js:5161`、`App.js:940` |
| 过程组（工具）折叠 | Ctrl+O 展开，`▸/▾` caret | `services/backend/src/cli/tui/ink-components/ProcessGroup.js:443-456` |
| 统一折叠模型 | `foldModel.js`（DESIGN-ARCH-103）：kind 含 `'thinking'`，行高签名含 expanded 态 | `services/backend/src/cli/tui/foldModel.js:22-33`；消费方 `ToolLines.js:1474-1476`、`RightPanel.js:13` |

测试佐证：`tests/cli/tui/transcriptLines.test.js` 有两条 thinking 折叠语义用例（折叠摘要 + showAll 全文展开），均绿（见 §7 基线）。

### 1.2 存储链：全文已落盘，无需新建存储

```
thinking chunk (useQueryBridge.js:1993 tlAppendThinking)
  → timeline 独立条目（thinking 与 text 分段，尾部同型合并）
  → 定格时 buildTurnArtifacts：thinking 保持独立条目，真实 durationMs 随行（queryBridgeTimeline.js:1011-1058）
  → aiSession.js:153  m._timeline = artifacts._timeline
  → sessionPersistence.js:344-352  _timeline present-only 写入会话 JSONL
```

- `sessionPersistence.js:344-348` 注释明说这是 additive contract，旧 reader 忽略未知字段。
- 会话恢复 / `/issue`、`/perf-issue` 等 handler 都走同一份 JSONL transcript（`handlers/issue.js:164`）。
- **结论：思维链「存储」这一半已经闭环——全文在盘、显示折叠。任何「再建一个 thinking 存储」的写法都是新建并行真源，直接违反本仓红线。**

### 1.3 病灶判定方法（给使用者的一次性操作）

1. 在 TUI 里按 **Ctrl+E**：若那批文字收进 `💭` 行 → 属 A1，纯开关状态问题。
2. 若无变化：查会话 JSONL 里 `_timeline` 的段型分布——`type:'thinking'` 存在 → 显示层问题；推理文字全在 `type:'text'` → 属 A3（adapter 把 reasoning 并进了正文通道）。

## 2. 借鉴提案（B-P2 逐字段）

| 字段 | 内容 |
|---|---|
| 借鉴对象 | 不适用——本提案修的是本仓自己的显示/接线缺口，**零外部借鉴**。B-P2 第 1 字段即借鉴对象，为空则七字段整体不触发（先例：`[DESIGN-ARCH-149]` §2）。 |
| 借鉴内容 | 不适用 |
| 解决的问题 | 见 §0 病灶表 A1–A3、G1 |
| 许可证与代码性质 | 不适用 |
| 借鉴方式 | 不适用 |
| 落点与现有实现对比 | 已搜索：`thinking`/`reasoning` 于 `services/backend/src/cli/`（41 文件命中）与 `services/tool/toolUseLoopCore.js`；折叠语义的 canonical 即 `transcriptLines.js` + `foldModel.js`，本提案是**扩展既有 canonical**（P2 改折叠行文案、P3 改 adapter 归位），不新增并行实现 |
| 验收方式 | 见 §7 |

## 3. 目标形态

折叠态（P2 后，committed 区）：

```
💭 思考 12s · 1,842 字          ← durationMs 来自 tlStampThinkingDuration，非编造
```

展开态（Ctrl+E，与现状一致）：

```
💭 思考 12s
<全文逐行，wrapCell 按 cols 折行>
```

text 通道（A3 判定为真时）：adapter 层把 reasoning 流归位到 thinking chunk，正文只留结论性 markdown——渲染层零改动即自动获得折叠。

## 4. 实施分期（每期独立可回滚）

| 期 | 内容 | 落点 | 回滚 |
|---|---|---|---|
| P1 | 零代码：引导 Ctrl+E；构建新鲜判定（用本次新增标识符 grep `out/` 判构建旧新） | 无 | — |
| P2 | 折叠行消费 `durationMs`：`💭 思考 · N 字` → `💭 思考 {ccFormatDuration(durationMs)} · N 字`（时长格式走 `ccFormat.js` SSOT，同 `queryBridgeTimeline.js:471-484` 已有先例）；durationMs 缺失时逐字节回退现文案 | `transcriptLines.js:208-211` 一处 | 单点撤回即旧行为 |
| P3 | 仅当 §1.3 判定属 A3：在 gateway/adapter 层把 reasoning 流归位 thinking chunk（指认级条目，需先定位具体 adapter 再单独出实施记录） | adapter 层（待定位） | adapter 单点 |
| P4 | 折叠行**逐条点击展开**（2026-09-26 用户裁决，推翻 §5 原边界）：投影多产出第三条**平行数组** `folds`（行下标 → `{kind:'thinking', key}`，非锚点行为 `null`），`Viewport` 收 `lineClickAt(rowIdx)` 给命中行各挂一个 `onClick`（闭包携带行下标，**不做屏幕行换算**），App 侧 `expandedThinking: Set<key>` 只存 key 不存内容。门复用既有 `KHY_CARD_CLICK`（`cardClickEnabled`），**不新增 env 门** | `transcriptLines.js`（`folds`）、`Viewport.js`（`lineClickAt`）、`PreviewLayout.js`（转发）、`App.js`（状态 + 命中闭包） | 不传 `lineClickAt` → Viewport 走原单 `<Text>` 分支，逐字节回退 P2 形态 |
| P5 | **流式期**思维链单行「从左到右」滑动预览（用户裁决：仅流式期滚动，轮次落定即静态）：`thinkingMarquee.tailWindow(text, cols-8)` 取可视尾部窗口，chunk 驱动、**零新增 setInterval**（`query.streaming` 本就是行 memo 的依赖，不产生额外重渲染）；被裁掉头补 `⋯ ` 标记 | `src/cli/tui/thinkingMarquee.js`（新纯叶子）、`App.js` 流式预览段 | 删该调用回到「恒显首段」旧行为 |

## 5. 诚实边界（刻意不纳入）

| 不做 | 原因 |
|---|---|
| per-item thinking 单条展开（点击/Ctrl+O 逐条） | ~~不做~~ **已推翻（2026-09-26 用户裁决，见 §4 P4）**。原判断错在把「交互焦点」当成前提：其实不需要行焦点，只要投影多产出第三条平行数组 `folds`，命中行各自挂 `onClick`、由闭包携带下标即可——「纯文本行数组」契约与「屏幕行 == 数组下标」不变量都未被破坏。仍**不做**键盘逐条（用户裁决「仅鼠标点击」） |
| 渲染层启发式判「这段 text 像推理」自动折叠 | 不可测、必然误伤正文（见 §6） |
| 新增 env 门做回滚开关 | P2 是单点显示改动，用「参数缺省 → 旧行为」即可，不撞 `check-tui-gates.js:32` 的门预算棘轮（MAX_GATES=220 只降不升）。**注**：2026-09-26 实测该棘轮已记 `limit 227` 且当前存量 `232` 为**既有超额**（非本次引入），故 P4/P5 全程复用既有门（`KHY_CARD_CLICK` / `KHY_THINKING_DURATION`）与「不传 prop → 逐字节回退」，token 数保持 232 不上涨 |
| 顺手修 §7 里那条既有红测试 | 归因属并行会话的 decision 投影改动（`transcriptLines.js:296-304` 新增 decision 分支 vs 旧断言 `test.js:131`），与本提案无关，单独条目处理 |

## 6. 反模式（这条路别走）

| ❌ 别做 | 为什么 |
|---|---|
| 在渲染层用正则/关键词猜「text 段里哪部分是思维链」 | 推理与正文在 text 通道里**信息论上不可分**；猜错 = 把正文答案折掉，比「显示乱」严重一个量级。归位责任在产生数据的那一层（adapter），不在消费数据的渲染层 |
| 为思维链新建独立存储文件/表 | `_timeline` in JSONL 已是单一真源（§1.2），第二存储 = 本仓明令禁止的并行真源 |
| 把 text 段改标成 thinking 段「好让它能折叠」 | 污染数据语义：`/issue`、`/perf-issue` 等读 transcript 的消费方会把正文当推理，统计全歪 |
| 为 P2 新开 `KHY_THINKING_*` env 门 | 门预算棘轮 + 会把行为修正从豁免拖进非豁免（§6.1 判据：没有「开/关都有道理」的用户可见权衡） |

## 7. 验收方式

**既有基线（2026-09-24 实测）**：`node --test services/backend/tests/cli/tui/transcriptLines.test.js` → `# tests 27 / # pass 26 / # fail 1`。唯一失败为 `unknown roles degrade…`（`test.js:131`），是 decision 投影改动导致的**既有红**，与本提案无关；P2 落地后要求 **26 绿保持 + 新增用例绿 + 不新增红**。

P2 新增用例（`node:test` 风格，放同目录新文件，勿向既有 jest 混编文件追加——两套 runner 会同扫一个文件）：
1. `durationMs>0` → 折叠行含格式化时长；2. `durationMs` 缺失 → 折叠行与现文案**逐字节相等**；3. showAll 展开态标题含时长。

CI 关联：`test:node` 全量 glob 扫 `tests/**`（`deploy-staging.yml:97-104`），新文件落地即绿才能进。

**P4/P5 落地实测（2026-09-26）**：

| 检查 | 命令 | 结果 |
|---|---|---|
| 投影契约 | `node --test tests/cli/tui/transcriptLines.test.js` | `# tests 28 / pass 27 / fail 1`（唯一红仍是 §5 末条那条既有 decision 红；新增用例绿） |
| 尾部窗口叶子 | `node --test tests/cli/tui/thinkingMarquee.test.js` | 7/7 绿（CJK 宽度、码点完整性、垃圾入参不抛） |
| 行/角色/锚点同长同序 | `buildTranscriptLineRecords` 直跑 | 9 行 / 9 角色 / 9 锚点对齐；只展开被点的 `a1:0`，`a1:2` 保持折叠 |
| Viewport / 鼠标 / 选择回归 | `node --test` viewportSticky、viewportDragEdgeScroll、mouseSelectEvent、selection | 71/71 绿 |
| 门预算 | `node scripts/ci/check-tui-gates.js` | **232（未上涨）**，与改动前同一既有超额基线 |
| 工程红线 | `node scripts/ci/check-agent-rules.js --changed` | 本次 6 个改动文件 **0 命中** |

> ⚠ **未验证项（诚实边界）**：真实 TTY 里的鼠标点击与流式滑动**没有实机走过**——以上全是叶子级
> 与投影级验证。`node scripts/run-ink-tui-tests.js` 现有 5 个红套件（ccOverlayFit / inkRenderSmoke
> / agentTreeRender / helpMenuSize / toolLinesWriteDiff，16 例）经核**与本案无关**：其失败文案
> （`执行命令` → `读取 + 编辑 server.js · 2 步`、write-diff 新增 `numNew` 字段、HelpMenu 帧高）
> 全部来自并行的中文 chrome 本地化与 [DESIGN-ARCH-155] 组行语法改造：其余 4 个套件对 `💭` **零引用**，
> `inkRenderSmoke` 的两个 thinking 用例（折叠/Ctrl+O、真实时长 `💭 思考 7s`）**为绿**，红在其
> ProcessGroup / ToolLines 文案断言。

## 8. 待核实项

| 项 | 状态 |
|---|---|
| 截图那一次会话属 A1 还是 A3 | **待用户按 §1.3 两步判定**——它决定 P3 是否启动。判定前 P2 可独立先行 |
| 具体 adapter 把 reasoning 并进 text 的位置 | 未定位（A3 判定为真后才值得花成本定位） |
| 既有红测试 `test.js:131` 的归因与修复 | 另立条目，不阻塞本提案 |

## 9. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-09-24 | 初版：实证折叠/存储链已闭环，收敛真实缺口为 P1/P2/P3 |
| 2026-09-26 | P2 落地（折叠行文案收敛到 `thinkingDuration.js` 单一真源，`hint` 由调用方注入）；用户当轮裁决**推翻 §5 第一条边界**，新增 P4（`folds` 第三条平行数组 + 逐条 `onClick` 展开，复用 `KHY_CARD_CLICK`，无新门）与 P5（`thinkingMarquee.tailWindow` 流式期尾部窗口，无新计时器）；§7 补落地实测与**未实机验证**的诚实边界 |
