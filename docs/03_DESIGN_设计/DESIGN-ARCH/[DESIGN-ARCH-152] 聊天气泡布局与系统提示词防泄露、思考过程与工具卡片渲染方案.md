# [DESIGN-ARCH-152] 聊天气泡布局与系统提示词防泄露、思考过程与工具卡片渲染方案

> **状态**：提案（待确认后实施）
> **范围**：`apps/khyos-desktop/src/renderer/App.tsx`、`src/renderer/components/message/MessageBubble.tsx`、`src/renderer/state/messageSlice.ts`、`src/host/index.ts`（仅展示过滤一处）
> **上游依赖**：无新增 IPC 通道（thinking/工具事件均在既有 `ai.chunk` / `ai:toolCall` / `ai:toolResult` 流内）
> **调研指针**：DESIGN-ARCH-151（TUI 思维链折叠，同族问题在 TUI 侧）、DESIGN-ARCH-133（桌面端接入智能体工具循环）
> **模板合规**：非借鉴类，B-P2 据实填「不适用」，见 §2

---

## 0. 一句话结论

四件事三个是「能力全链已通、只差最后一米接线」：思考流卡在 renderer 的 `chunkToText` 一行、工具卡片组件齐全但零数据、系统提示词三层全不设防直达气泡；气泡布局则要**推翻此前「整块终端化」的拍板**（以本次指示为准）。

### 病灶表格

| # | 症状 | 根因 | 证据 |
|---|------|------|------|
| 1 | 重载历史会话时系统提示词以「助手」气泡全文显示 | 全链三处显式保留 `role === 'system'`，零过滤：后端 `restoreSession` 原样返回（sessionPersistence.js:754 只做字段搬运）→ host 原样转发（host/index.ts:618）→ renderer 再次保留（App.tsx:202）→ MessageBubble 把 system 映射成 assistant 渲染（MessageBubble.tsx:252） | 见 §1.1 |
| 2 | 思考过程完全不显示 | 后端发 `type:'thinking'` chunk（aiChatCore.js:1345，受 `thinkingEnabled` 门控）→ host 原样转发 ai.chunk（host/index.ts:422）→ renderer `chunkToText` 只认 text/status，thinking **静默丢弃**（App.tsx:37-46）；`setCurrentThinking` reducer 定义了但全仓零 dispatch | 见 §1.2 |
| 3 | 聊天内没有工具卡片 | `ToolCallCard`/`TrajectoryTimeline` 组件完整实现（MessageBubble.tsx:35-151），但 MessageList 映射消息时只传 id/role/content/timestamp/isStreaming/error —— trajectory/toolCalls **从不传入**（MessageBubble.tsx:250-257）⇒ 死代码路径；真实工具事件全部进了侧栏聚合面板（App.tsx:527 ToolExecutionPanel），与触发它的消息无上下文关联 | 见 §1.3 |
| 4 | 用户与 AI 消息同为左对齐终端形态 | MessageBubble.tsx:167-169 注释自述「用户拍板：整块终端化」，❯/● 提示符布局；本次指示改为聊天气泡，**推翻该拍板** | 见 §1.4 |

---

## 1. 现状实证（file:line 可复核）

### 1.1 系统提示词泄露链（三层全通、零设防）

```
services/backend sessionPersistence.js:754   restoreSession 全链返回，system 条目原样
→ apps/khyos-desktop src/host/index.ts:618   role === 'system' 显式保留
→ src/renderer/App.tsx:202                    role === 'system' 再次保留 → setMessages 入 store
→ MessageBubble.tsx:252                        role === 'system' ? 'assistant' → 当助手全文渲染
```

四层中**任何一层都没有过滤**。修法见 §3.1：host 出口过滤（真源不外泄）+ renderer 渲染层 skip（防 store 残留路径）双保险。

### 1.2 思考流：唯一断点在 renderer 一行

- 后端：`aiChatCore.js:1345` 显式产生 `chunk.type === 'thinking'`（且 `<think>` 标签拦截器 `:1339-1340` 把非原生思考也转成 thinking chunk）；关闭时上游已抑制（`:1343-1350`）。
- host：`host/index.ts:422` onChunk 原样 `send({ type: 'ai.chunk', ... })`。
- main → preload：`preload/index.ts:47-51` `onAiChunk` 通道在位。
- renderer：`App.tsx:37-46` `chunkToText` 分支表只有 `string` / `type:'status'` / `type:'text'`，`type:'thinking'` 落到 `return ''` —— **思考流在这里被吞掉**。
- 旁证：`messageSlice.ts:31` 有 `currentThinking` 状态、`:72` 有 reducer，Grep 全仓**零 dispatch 方**；`MessageBubble` 的 `TrajectoryTimeline` 依赖 `trajectory` 字段，映射处从不传。

### 1.3 工具卡片：组件齐全、数据零供给

- `MessageBubble.tsx:114-151` `ToolCallCard`（状态点 + 名称 + 展开 input/result）实现完整。
- `App.tsx:356-419` `onAiToolCall`/`onAiToolResult` 监听器把事件 dispatch 进 **toolExecutionSlice**（callId 由 host `registerToolCall`/`settleToolCall` FIFO 配对，host/index.ts:429,434），由 `ToolExecutionPanel`（App.tsx:527 挂载）聚合一处显示。
- ⇒ 聊天流内的 `ToolCallCard` 拿不到数据；用户看到工具执行必须跳出一问一答的上下文去看侧栏面板。

### 1.4 布局现状

`MessageBubble.tsx:166-222`：用户与 AI 均左对齐，头部 `❯`（用户）/`●`（AI）等宽标记，`:167-169` 与 `:215-217` 两段注释记录了「用户拍板：整块终端化、右对齐描边气泡已移除」。**本次指示明确回到聊天形态：用户右侧气泡、AI 靠左** —— 提案按新拍板执行，旧决定作废并在此记录。

---

## 2. 借鉴提案（B-P2 七字段）

**不适用。** 依据：对桌面端既有聊天渲染模块的展示层修正与既有数据流接线，无外部项目/代码/设计稿借鉴；thinking/工具事件均来自本仓后端既有 chunk 协议。

---

## 3. 目标形态（组件级契约）

### 3.1 系统提示词防泄露（双保险，一处真源不动）

| 改动点 | 契约 |
|---|---|
| host 出口过滤（canonical） | `host/index.ts:617-618` 的 messages 映射加 `.filter(m => m.role !== 'system')` —— 数据不过 host 出口，未来新增消费方天然安全 |
| renderer 渲染层兜底 | `MessageBubble.tsx:252` 的 `system → assistant` 映射删除，MessageList 跳过 `role === 'system'`（防 store 里已存在的旧数据路径） |
| **不动** sessionPersistence | 后端 `restoreSession` 是恢复/续跑共用的链真源，砍掉 system 会破坏续跑上下文 —— 过滤只在展示出口 |

### 3.2 气泡布局（推翻终端化拍板）

| 元素 | 契约 |
|---|---|
| 用户消息 | 右对齐，胶囊气泡：`max-w-[85%] ml-auto`，`bg-brand/15 border border-brand/30 rounded-2xl`，正文 `whitespace-pre-wrap` **纯文本渲染**（不进 MarkdownRenderer，用户打的 `*`/`#` 必须原样可见）；头部 ❯ 标记行删除，时间戳小字移到气泡下方右对齐 |
| AI 消息 | 左对齐，浅面板卡：`max-w-[92%]`，`bg-surface border border-border/50 rounded-2xl`（用卡而非胶囊气泡：markdown 代码块需要满宽）；`●` 标记行删除，操作按钮（收起/复制）hover 时浮现在卡片右上 |
| 保留 | `khy-tui` 作用域类暂不动（管配色 token，与布局无关）；流式光标、错误显示维持现状 |

### 3.3 思考过程渲染（接线 thinking chunk）

| 改动点 | 契约 |
|---|---|
| chunk 分流 | `App.tsx` onAiChunk 处理器：`chunk.type === 'thinking'` → `dispatch(appendMessageThinking({ id, text }))`，不进正文 |
| 新 reducer | `messageSlice` 增 `appendMessageThinking`：`message.thinking = (message.thinking || '') + text`；`Message` 接口加 `thinking?: string` |
| 渲染 | AI 消息内正文上方渲染「思考」折叠条：流式中显示 pulse 点 + 最新一行预览；完成后默认折叠，展开显示 thinking 全文（`whitespace-pre-wrap` 小字、前景 60%） |
| 删死代码 | `TrajectoryTimeline`（MessageBubble.tsx:35-112）及其 `trajectory` 字段、`messageSlice.currentThinking`/`setCurrentThinking`（零消费方）一并删除 —— 不留等数据来激活的空壳（§8.4.1） |
| 不加新门 | thinking 显示开关后端已有（`thinkingEnabled`，aiChatCore.js:1345），前端不加 env/开关 |

### 3.4 工具卡片内联聊天流

| 改动点 | 契约 |
|---|---|
| 事件双写 | `App.tsx` 既有 onAiToolCall/onAiToolResult 监听器内，同时 dispatch messageSlice 新 action：`appendMessageToolCall({ messageId, call })`（挂到当前 streaming 消息）/ `updateMessageToolCall({ messageId, callId, status, result })`。callId 直接用 host 已配对的 FIFO id（host/index.ts:429,434），renderer 不再做名字匹配 |
| 渲染 | `MessageBubble` 用**现成的** `ToolCallCard` 渲染 `message.toolCalls`（喂真实数据，组件零改动或微调） |
| `ToolExecutionPanel` 去留 | 一期**保留不动**（进行中汇总有独立价值）；内联卡片与面板的重复度落地后观察，再决定是否把面板收缩为「仅进行中」（记入 §5 边界） |

### 3.5 文案与样式约束

- 全部走既有 token 类（`bg-brand`/`text-foreground`/`border-card-border`…），禁硬编码色值。
- 新增文案（「思考」「工具执行」）先搜 i18n 同义键；本页现状硬编码中文，保持一致。

---

## 4. 实施分期（每期独立可回滚）

| 期 | 内容 | 回滚 |
|---|---|---|
| P1 | system 双保险过滤 + 气泡布局（用户右/AI 左） | host 过滤一行 + 渲染类名，纯样式回滚 |
| P2 | thinking 接线（chunk 分流 + reducer + 折叠条）+ 删 TrajectoryTimeline 死代码 | reducer 为纯增量，删 dead code 独立成 commit |
| P3 | 工具卡片内联（事件双写 + ToolCallCard 接数据） | 双写 dispatch 移除即回到纯面板模式 |

P2/P3 共享「消息挂载到 streaming 消息」的取值方式，可并行。

---

## 5. 诚实边界（刻意不纳入）

| 不做 | 原因 |
|---|---|
| 后端 sessionPersistence 过滤 system | 续跑需要完整链（§3.1），砍链是行为变更不是展示修正 |
| 历史（重载）会话回填 thinking/toolCalls | JSONL 里没有这些字段，只有实时流有；重载显示纯文本是如实，不是缺陷 |
| 新开 `ai:thinking` IPC 通道 | thinking 已在 ai.chunk 流内，加通道 = 双轨真源 |
| 用户消息 markdown 渲染 | 用户输入是字面文本，渲染会把 `*`、`#` 吃掉，违背忠实显示 |
| 删 ToolExecutionPanel | 其「进行中」汇总与耗时显示有独立价值；收缩与否等 P3 落地后观察 |
| TUI 侧思维链（DESIGN-ARCH-151 范围） | 本提案只管桌面端 renderer，TUI 已有独立方案 |

---

## 6. 反模式（这条路别走）

| ❌ 别做 | 为什么 |
|---|---|
| 在 MessageBubble 里给 system 消息做「折叠显示」而不是不显示 | 需求是不泄露；折叠 = 仍可达，一键展开就全泄 |
| 在 renderer 里重写一套 callId 配对逻辑 | host 已 FIFO 配对（registerToolCall/settleToolCall），renderer 按名匹配会张冠李戴（App.tsx:354 注释已记录此教训） |
| 为「气泡好看」给 AI 卡片加 max-w 以外的宽度硬限制后仍塞代码块 | 代码块横向滚动即可，别让 markdown 容器溢出卡片圆角 |
| 把 thinking 塞进正文用引用块渲染 | 流式期间正文在增量追加，混入 thinking 会打乱 Markdown 流式解析（isStreaming 光标位置错乱）；独立字段独立渲染 |
| 保留 TrajectoryTimeline「等 trajectory 数据到达」 | 数据源已确认不存在（映射处零传参），留空壳违反仓库硬规矩 |

---

## 7. 验收方式

```bash
# 类型：改前基线 20 条（2026-09-24 实测，全在 src/host/index.ts，含本次将改的 :617 附近——
# 实施后必须仍为 20、零新增；host 过滤处为纯数组操作，不应引入新错误）
"<node>" apps/khyos-desktop/node_modules/typescript/bin/tsc -p apps/khyos-desktop/tsconfig.json --noEmit

# 桌面 UI 契约（本提案零新增/修改 IPC 通道，必须原样绿）
"<node>" --test apps/khyos-desktop/tests/desktopUiContract.test.cjs

# 设计令牌：零新增 finding
"<node>" scripts/ci/check-frontend-design-tokens.js
```

手工验收（重建 out/ 后）：
1. 重载一条含系统提示词的历史会话 → 列表里**不出现**系统内容（改前会出现）。
2. 发送消息 → 用户消息右侧胶囊气泡、原文显示；AI 回复左侧卡片。
3. 用带思考的模型发问 → 回复上方出现「思考」折叠条，流式有预览，完成后可展开。
4. 触发任意工具（如读文件）→ 消息流内出现工具卡片，状态从运行中转完成/失败，展开可见 input/result。
5. 重启后确认 thinking/工具卡片随消息持久（本次不持久 —— 重载回纯文本，为 §5 边界，如实展示）。

---

## 8. 待核实项

| 项 | 状态 |
|---|---|
| tsc 基线 | 20 条（2026-09-24 实测）；实施前重跑一次取当日值 |
| `khy-tui` 类去留 | 默认保留（管配色不管布局）；若气泡配色与其冲突再议 |
| 后端 JSONL 是否真含 system 条目 | 泄露链四层实证已闭环（§1.1）；即便部分会话无 system 条目，过滤也必须落（防其它元数据条目按 system 角色落盘） |
| AI 卡片 vs AI 气泡 | 由 mockup 用户拍板（§3.2 默认浅卡，理由：代码块满宽） |

---

## 9. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-09-24 | 初版提案（含泄露链四层实证、thinking 断点定位、工具卡片零供给实证、气泡布局三分期设计） |
