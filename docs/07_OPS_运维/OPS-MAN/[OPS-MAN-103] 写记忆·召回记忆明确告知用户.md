# [OPS-MAN-103] 写记忆 / 召回记忆时明确告知用户（记忆操作可见化纯叶）

> ⚠ **本条已升格**：可见化的**落点、门控与双前端一致性**以
> [`[DESIGN-MEM-008] 记忆操作可见性规范`](../../10_规范/DESIGN-MEM/[DESIGN-MEM-008]%20记忆操作可见性规范.md) 为准。
> 本条的**纯叶设计**（零 IO / 确定性 / 绝不抛 / 门控 default-on）**保留不变**，008 是它的
> **修正与升格**——008 查明本条声称的「经既有 `onStatus` 状态通道推给用户」在两个前端
> **结构性地看不见**（REPL 被 `步骤 N/5` 毫秒级擦除；TUI 只是 spinner 后缀，一开流即清空），
> 并给出 noticeInbox 主通道 + `kind:'memory-notice'` 回落。详见 008 §1 取证 F1–F7。

> 直接回应用户诉求：「然后在关键节点主动写记忆文件，包括全局记忆和项目记忆等，
> 需要用时主动召回记忆，**写记忆和回忆时明确告知用户**。」
> 本条闭合两条断桥：khy 已经会**自动写记忆**（`_maybeAutoSaveMemory`）与**自动召回记忆**
> （memory engine surface + [RELEVANT_MEMORY] 注入），但两条路径都**静默执行**——用户看不到
> 「khy 刚记住了什么」或「khy 这轮召回了哪些记忆」。本条补一个纯叶把这两个已有动作**渲染成
> 用户可见的状态提示**，让「主动写/召回记忆」这件事对用户透明。

## 一句话

写记忆与召回记忆的**执行**早就接好了，但**告知**这一步从缺——`_maybeAutoSaveMemory` 成功后
只把结果当布尔丢掉，召回的记忆名字（`_memSurfaced`）也从不回流给用户。本条抽纯叶
`memoryOpsNotice.js`：把「写入成功的记忆」渲染成 `已写入…记忆（已落盘/本会话）：<name>`，
把「本轮召回的命名记忆」渲染成 `召回 N 条相关记忆：a、b、c 等 N 条`，经既有 `onStatus`
状态通道推给用户。零 IO、绝不抛、门控 default-on。

## 为什么需要它（真实缺口 = 已有动作静默无回声）

- **写记忆断桥**：`ai.js` 的 `_maybeAutoSaveMemory` 成功路径原本 `return !!(res && res.success)`
  ——把「记住了什么类型、什么名字、落盘还是本会话」全部坍缩成一个布尔后丢弃，
  `aiChatCore.js` 调用点连布尔都不看。用户无从得知 khy 刚刚记住了一条身份/反馈/项目记忆。
- **召回断桥**：memory engine 每轮把相关记忆 surface 进上下文（命名记忆进 `_memSurfaced`），
  [RELEVANT_MEMORY] 块把它们注入提示词，但**注入完就结束**——名字从不回流给用户，
  用户看不到「这轮回答基于哪几条记忆」。
- **用户明确点名**：`/goal` 原话「写记忆和回忆时明确告知用户」是显式需求，不是推断。

## 怎么做的（外科式 + 门控 + 纯叶）

**纯叶** `services/backend/src/services/memoryOpsNotice.js`（零 IO、确定性、绝不抛、SSOT）：

- `isNoticeEnabled()`：门 `KHY_MEMORY_NOTICE`，default-on；CANON falsy
  `['0','false','off','no']`（大小写/空白归一）才关闭。**不进 flagRegistry**（sibling 门各自读 env）。
- `formatWriteNotice(result)`：只对 `{kind:'memory', success:true}` 且有非空 `name` 的富描述符
  渲染；`action` 为 `skip`/`skip-duplicate` → `记忆已存在（未重复写入）：<类型>·<name>`；
  否则按 `ephemeral` 渲 `已落盘`/`本会话` → `已写入<类型>记忆（<where>）：<name>`。
  类型标签 `_TYPE_LABEL`（user→身份 / feedback→反馈 / project→项目 / reference→参考，缺省「记忆」）。
  任何非法输入（null/非对象/非 memory/未成功/空名/门关）→ 返回 `''`（静默）。
- `formatRecallNotice(filenames, ctx)`：接受数组 / Set / 字符串（按单个文件名，见 008 §3.2.2 加固）
  / 任意可迭代；逐项 `_prettyName`（剥 `.md`）；
  取前 `_RECALL_NAME_CAP`（3）个展示，超出加 ` 等 N 条` 尾巴 →
  `召回 N 条相关记忆：a、b、c 等 N 条`。空/无命名项/门关 → `''`。
  **`ctx`（可选，`{types}`）** 由 `deriveIntentClause` 派生「用以完成什么」子句，
  插在「条相关记忆」与「：」之间；**`ctx` 缺省时输出与旧版逐字节相等**（008 V4 回退）。
- `formatRecallNoticePayload(filenames, ctx)`：把 `kind:'memory-notice'` 与 `text` 在同一处派生，
  供消费点**按字段**分流（不得用 `includes('')` 之类文案前缀——文案一改即静默失效）。
- 全部 `try/catch` 兜底返回 `''`——通知是 best-effort，绝不因渲染异常打断对话。

**接线**（均 additive、门关逐字节回退）：

- `ai.js` `_maybeAutoSaveMemory` 成功路径改为返回富描述符
  `{kind:'memory', success:true, name, type, tier, action, ephemeral}`（向后兼容：对象仍是 truthy，
  唯一既有消费者只做丢弃）；指令自动保存路径**仍留裸布尔**（`formatWriteNotice(true)` → `''` = 静默，正确）。
- `aiChatCore.js` 写入点：`_maybeAutoSaveMemory(userMessage)` 的返回值传给 `formatWriteNotice`，
  非空则经 `onStatus({phase:'init', message})` 推给用户。
- `aiChatCore.js` 召回点：memory engine 块之后把 `_memSurfaced`（命名/可核验的召回集合）传给
  `formatRecallNotice`，非空则同样经 `onStatus` 推出。

## 诚实边界

- **只告知命名可核验的召回**：`_memSurfaced` 只收有名字的记忆；[RELEVANT_MEMORY] 注入块
  读取但不追加名字（那部分召回没有可靠名字来源）——宁可少报，绝不伪造记忆名。
- **写入指令路径静默**：指令类自动保存返回裸布尔 → `formatWriteNotice` 得非富描述符 → `''`，
  即只有「带完整元信息的记忆写入」才通知，避免噪声。
- **纯叶零 IO**：本叶只做字符串格式化，不读文件、不查磁盘——记忆的真实读写仍由既有引擎负责，
  本叶只把**已发生**的动作渲染出来。门关 → 两处通知恒 `''` = 逐字节回退到原静默行为。

## 验证

```
npm run test:memory-notice                  # 纯叶 22/22（含 008 的意图派生 / V4 回退 / payload）
node --check services/backend/src/services/memoryOpsNotice.js
node --check services/backend/src/cli/ai.js
node --check services/backend/src/cli/aiChatCore.js
npm run check:arch-debt                     # 改动文件无新增超限（全量；见下方订正记录）
```

> ⚠ **订正记录（2026-09-27）**：本条此前写的 `npm run test:memory-notice` **当时并不存在**
> （`package.json` 零命中）⇒ **该验收步骤本身不可执行**。已按
> `[DESIGN-MEM-008]` §4 第 5 项补上该 script（`node --test …/memoryOpsNotice.test.js`）。
> 同族失真还有两处：① `npm run arch:god` **同样不存在**（真名 `npm run check:arch-debt`，
> 执行器 `services/backend/scripts/archDebtScan.js`；`package.json` 零命中 `arch:god`）；
> ② `scripts/memory/clear-memory.js` 尾注写的 `khy memory distill restore`
> **同样不存在**（真实恢复手段是 `npm run memory:restore`）。
>
> ⚠ 注意 `check:arch-debt` **当前本就报红**（存量巨石只许减不许增，`R2b`），
> 且该红**早于本条改动存在**；用它当验收门时必须**先做算术归属**
> （`当前行数 − 本次插入 > 基线` ⇒ 非本次引入），否则会把别人的债算成自己的。
