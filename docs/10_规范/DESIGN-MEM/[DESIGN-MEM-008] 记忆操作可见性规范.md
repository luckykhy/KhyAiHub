# [DESIGN-MEM-008] 记忆操作可见性规范

<!-- RULES-REGISTRY-NONE: 本文件当前不承载规则 ID（纯设计规范，无执行器） -->

> **定位**：`[OPS-MAN-103] 写记忆·召回记忆明确告知用户` 的功能**修正与升格**真源。
> `[OPS-MAN-103]` 已完成「接线」这一步（纯叶 `memoryOpsNotice.js` 存在且正确）；
> 本规范处理它**漏掉的第二步**：那行告知语**从未真正到达用户的眼睛**。
>
> **双重下游身份**：本文件同时是两处的下游——
> - `[OPS-MAN-103]` 的下游（修正其接线落点）；
> - **`[DESIGN-MEM-007]` 记忆规则系统总纲的下游**（承接其 MR-R4③「冲突时须提示用户」
>   与 §3.A~E 各「须记录/须告知」条款的**可见性实现**）。007 §5 诚实边界明写
>   「**不定义记忆的 UI/展示**」，本文件即该让出块的承接者，**不重复定义任何行为规则**。
>
> **受众**：改记忆/状态通道的维护者；`[DESIGN-MEM-001]`（标准规范）与
> `[DESIGN-MEM-005]`（使用指南）的可见性条款以本文件为准。

---

## 1. 问题陈述（取证结论）

用户诉求原话：「**主动记忆为什么我从来没有看见过『我在背 xxx 内容』，主动回忆希望提示
我在回忆 XXX，用以完成什么**」。

现状取证（2026-09-24，全部可复现）：

| # | 事实 | 取证 |
|---|------|------|
| F1 | 纯叶**存在且正确** | `node -e` 直调 `formatRecallNotice(new Set(['a.md','b.md']))` → `🧠 召回 2 条相关记忆：a、b` |
| F2 | 召回链**确实产出文件名** | `buildProactiveMemoryResult()` 实测返回 `filenames:["feedback_tool-execution-results_a3d9521e.md", …]` |
| F3 | 告知语经 `onStatus({phase:'init'})` 发出 | `aiChatCore.js:2333-2335` |
| F4 | **但 `init` 在 REPL 是「瞬时行」** | `replSession.js:10354` `_writeOnStatusTransient` 用 `\r\x1b[K` 原地覆盖 ⇒ 后随的 `步骤 2/5`、`步骤 3/5` **毫秒级擦除** |
| F5 | **在 TUI 只是 spinner 后缀** | `useQueryBridge.js:2246` `safeSetDetail` → `App.js:6903` `detail: query.statusDetail`，渲染成 `思考中… · 🧠 召回…`；`deriveLiveActivity` 对 `streaming` 返回 `''` ⇒ 一开流即清空 |
| F6 | **本地记忆库近乎为空** | `.khy/memory/` 仅 3 条；`user/`、`feedback/`、`project/`、`reference/` 中 3 个目录为空 |
| F7 | **「正在记忆」进行时态完全不存在** | `formatWriteNotice` 措辞是「已写入」（完成时）；无任何过程播报 |

**结论**：不是「没接线」，而是**接线了但没有用户可见的落点**。`[OPS-MAN-103]` 自己的
§诚实边界 已承认 `_memSurfaced` 只收具名可核的召回子集——但它没有回答**这行字落在哪里**。

### 1.1 附带失真（须一并订正）

- `[OPS-MAN-103]` §验证 写 `npm run test:memory-notice`，**该 script 在 `package.json` 中不存在**（实测 `grep` 零命中）。文档声称的验收手段不可执行 ⇒ 按 `PROCESS-011` 四问，属 T2「实现越界」的镜像（声称超出实现）。
- **`clear-memory.js` 尾注写的恢复命令 `khy memory distill restore [filename]` 不存在**
  （实测 `package.json` 无该 script；`khy memory` 亦非 CLI 子命令）。
  真实恢复命令是 `node scripts/memory/restore-memory.js --file <filename>`。
  ⇒ 同族失真：**脚本注释与实现背离**。（2026-09-24 新发现，与上一条同类）
- 本规范**自身**曾犯同类错误：v0.1.2 的 §4 第 0 项曾建议「用 `khy memory` 归档」——
  **该命令不存在**，且真实存在的 `npm run memory:clear` 是**全量清空**工具（影响面见 §4.1）。
  已在 v0.1.5 订正。**⇒ 教训：写「用某命令做某事」前必须实际跑一次 `--help`/dry-run。**

---

## 2. 判据（验收标准）

本规范确立四条**可核**判据。全部通过前，不得声称「记忆可见化已落地」。

| ID | 判据 | 核验方式 |
|----|------|----------|
| **V1** | 记忆召回/写入的告知语**落成转录区一条持久消息**，不随下一状态更新消失 | 触发一次召回，向上滚动仍可见该行 |
| **V2** | 告知语**含意图子句**（用以完成什么），且该子句**由召回结果派生**，非模型自述 | 单测断言输出含 `为了…`；纯叶可确定性渲染 |
| **V3** | 告知语**在 REPL 与 TUI 双前端都可见**（不得只修一个） | 两个前端各跑一次 |
| **V4** | 门控关闭 ⇒ **逐字节回退**（无新增输出、无新增状态） | 门关前后 diff 为空 |

> **★ V1 是本次的核心**。`[OPS-MAN-103]` 的失败模式是「信号发出了但没人安置它」——
> 与本仓 `AGENTS.md` §0.9.7「**外部模块一律不自己画屏，要嘛交给我画，要嘛别说**」同源。

---

## 3. 方案

### 3.1 分层决策：复用既有 `noticeInbox`，不新造通道

**不要**再往 `onStatus({phase:'init'})` 里塞更长的字符串（那是 F4/F5 的加深）。
既有 `services/backend/src/cli/tui/noticeInbox.js` 正是为这个场景设计的：

```js
// 契约（noticeInbox.js 头注）
//   push(line) 返回 true = 已有人在屏幕上安置它
//                 false = 无人认领，调用方**必须**回到旧行为。绝不静默丢弃。
```

它是 TUI 侧「宿主想让用户看见、但不能自己写屏」的收件箱（BUG-17 产物），
订阅点已存在于 `ink-components/App.js:2308`，落成 `role:'notice'`。

**处方**：把记忆告知语从「状态通道」迁到「notice 通道」，并保留状态通道作**降级**。

```
memoryOpsNotice.formatRecallNotice(filenames, ctx)   ← 纯叶（已有，扩展签名）
        │
        ├─→ noticeInbox.push(line)        主通道（TUI：落 role:'notice' 持久行）
        │      │ 返回 false（无订阅者/门关）
        │      └─→ 回落到 onStatus        降级通道（REPL：走既有渲染）
        └─→ （若既不认领又无 onStatus）→ 不输出，且**不得**静默吞掉观测
```

> ⚠ **纪律**：`noticeInbox.push()` 返回 `false` 时**不许**当作成功。这是本仓
> 「闸挂在哪层决定它管不管」的同类陷阱——`push` 返回 `false` 表示**没人接**。

### 3.2 V2「用以完成什么」的派生规则（纯叶、确定性）

**来源**：按用户选择，**从召回结果反推**，不依赖模型自述。

`memoryOpsNotice` 新增纯函数 **`deriveIntentClause(ctx)`**（`ctx` 形如 `{ types: string[] }`）：

| 输入 | 输出「为了…」子句 |
|---|---|
| 召回含 `project`/`reference` 型 | `为了对齐项目约定` / `为了查证外部资料` |
| 召回含 `feedback` 型 | `为了遵守你此前给过的协作偏好` |
| 召回含 `user` 型 | `为了沿用你的既有设定` |
| 混合 / 未知 | 取**首个命中型**的标签；全空 / 无 `ctx` → **省略子句**（绝不编造） |

> ⚠⚠ **`type` 的取数口径（实现者必读，取错即静默失真）**：
> 必须取 **`frontmatter.type`**，**不得按文件所在目录推断**。取证（2026-09-24）：
>
> | 事实 | 证据 |
> |---|---|
> | 存储是**扁平**的，写入**不建 type 子目录** | `memdir.js:508/562` `path.join(memoryDir, filename)`；真源 `memdir/paths.js`（`<root>/.khy/memory/`） |
> | 召回结果**同时带 filename 与 frontmatter** | `memdir.js:689` `scored.push({ filename, frontmatter, body, score })` |
> | `filename` 是**纯文件名**（不含路径） | `memdir.js:382` `return { filename, filepath }` 两者分离 |
> | 实测存在**目录与 type 不一致**的存量：`user/zlibrary-access.md` 在 `user/` 子目录，而 `feedback_*.md` 两个文件在**根目录**、`feedback/` 反为空 | `.khy/memory/` 实况 |
>
> ⇒ **按目录推断 type 会得到 `unknown`**（根目录文件）或**错型**（`user/` 例外）。
> **`deriveIntentClause` 不接收路径**，只接收已汇总的 `types` 数组。

> ⚠⚠ **措辞纪律（V4 的强要求，实施时最易违反）**：
> 意图子句在既有文案中**只做「插入」**，**不得改动任何既有字符**。
> 真源原文是 **`🧠 召回 N 条相关记忆：…`** ——
> **不得**顺手改成「回忆起」「回忆到」「记得」等更"自然"的词。
> 理由：`ctx` 缺省时整行必须与今日**逐字节相等**（见下方原型验证），
> 改词即等于在"回退"路径上也改了输出，**V4 不成立**。
> 经原型实测，把「召回」写成「回忆起」会使 6/6 输入全部 diff —— 这是**真实踩过的坑**。

**渲染样例**（确定性、可单测断言；**注意动词是「召回」**）：

```
🧠 召回 2 条相关记忆（为了遵守你此前给过的协作偏好）：feedback_tool-execution-results、feedback_system-收尾保障
```

**诚实边界**：意图子句是**类型标签的派生陈述**，不是对模型真实动机的断言。
措辞用「为了…」而非「因为你需要…」——**不替用户/模型宣称动机**。

#### 3.2.1 可实施性原型结论（2026-09-24 实测，非空想）

已按「真源码文本等价替换」做过原型（探针落 `.khyos/diag/`），结论：

| 验证项 | 结果 |
|---|---|
| **锚点唯一** | 4/4 唯一（函数头、返回行、导出块、`_TYPE_LABEL` 定义） |
| **语法合法** | `node --check` 通过 |
| **V2 行为** | 7/7 情形符合上表（4 型 + 混合取首个 + 未知省略 + 无 ctx 省略） |
| **★ V4 回退** | **6/6 输入逐字节相等**（`Set`/`Array`/空/`null`/数字）——**前提是保留「召回」原词** |
| 原型抓到的缺漏 | ① 措辞被擅自改成"回忆起" ⇒ V4 破；② `_INTENT_CLAUSE` 初版漏定义（`node --check` 不报引用错误，**必须跑行为**才暴露） |

> ⇒ 这两条缺漏**只靠读文档发现不了**，是原型实跑挖出来的。
> 实现时请**照抄原型结构**：`deriveIntentClause` 独立于 `formatRecallNotice`，
> 后者第二参 `ctx` **可选**，缺省即走原路径。

> ⚠⚠ **已知的系统性失真（2026-09-24 实测，非本规范引入）—— 这是本规范的阻塞性前置**：
> `.khy/memory/` 根目录下的两条 `type: feedback` 记录，其正文是**系统内部事件**
> （`feedback_system----_1c477a3f.md` 是发给模型的纠错提示；`feedback_tool-execution-results_a3d9521e.md`
> 是工具循环拦截日志），**并不是用户偏好**。
>
> **实测（`buildProactiveMemoryResult` / `buildSessionPrimingSection` 直调）**：
>
> | query | 命中 filenames |
> |---|---|
> | `"记忆"` | `feedback_tool-execution-results_…` |
> | `"khyos 的记忆系统"` | **两条系统噪声** |
> | **`"你好"`（纯问候）** | **两条系统噪声** |
> | `"zlibrary"` / `"test"` / `""` | 无 |
> | **预热段（`buildSessionPrimingSection`，query 无关）** | **两条系统噪声**（309 字符文本） |
>
> ⚠⚠ **这不是边缘情况，而且比"混入噪声"更严重 —— 当前召回面是 100% 噪声。**
>
> 决定性取证：`memdir.js` 的**三处**扫描（`:503-504` 主动召回 / `:557-558` 预热 / `:929-930` 第三处）
> **全部是非递归的 `readdirSync(memoryDir).filter(f => f.endsWith('.md') …)`**，
> 且写入用 `path.join(memoryDir, filename)`（`:508`/`:562`，**扁平、不建 type 子目录**）。
>
> ⇒ **只有 `.khy/memory/` 根目录下的 `.md` 参与召回**。逐个核对该目录后：
>
> | 条目 | 参与召回？ | 说明 |
> |---|---|---|
> | `feedback_system----_1c477a3f.md` | **✅** | 系统纠错提示 —— **噪声** |
> | `feedback_tool-execution-results_a3d9521e.md` | **✅** | 工具循环拦截日志 —— **噪声** |
> | `user/zlibrary-access.md` | ❌ | 在**子目录**，非递归扫不到 |
> | `logs/**`（含 `[Turn]` 记录） | ❌ | 是**目录**；虽为 `.md` 但非递归扫不到 |
> | `.archive/**`、`feedback/**`、`project/**`、`reference/**` | ❌ | 均为子目录 |
> | `MEMORY.md`（索引） | ❌ | 被 `f !== MEMORY_INDEX_NAME` 显式排除 |
> | `.distill.json` | ❌ | 非 `.md` |
>
> ⇒ **参与召回的两个文件恰好就是那两条噪声 —— 有效记忆 0 条。**
> （⚠ 此前本规范两处曾误判：把 `logs/` 的 `[Turn]` 记录当作"落库噪声"、
> 把 `user/zlibrary-access.md` 当作"唯一真实用户记忆"，**均已订正**，见 §7。）
>
> ⚠⚠ 预热段是 **query 无关** 的（tier×recency），
> ⇒ **这两条系统噪声几乎每一轮对话都会被召回**。
> 按本规范 V2 渲染，用户将**每轮都看到**：
> 「🧠 召回 2 条相关记忆（**为了遵守你此前给过的协作偏好**）：feedback_system-收尾保障、feedback_tool-execution-results」
> ⇒ **措辞正确、内容完全错误，且高频重复**。
>
> ⇒ **落地本规范前必须先做记忆库卫生**（见 §4 第 0 项）。否则不是"告知用户回忆了什么"，
> 而是"**每轮向用户播报两条与他无关的系统日志**"。
>
> ⚠ 且噪声**会再生**：`.archive/feedback_tool-execution-results_a3d9521e.md`（Sep-3 已归档）
> 对应的同名文件在根目录 **Sep-24 18:15 又出现**。⇒ **纯归档治不了本项**，
> 必须连带定位写入路径（见 §4.1）。
>
> 本规范**不负责**清理这类记录（属记忆质量问题，须另立条目判据）；
> 此处只声明：**意图子句的准确性以上游记忆质量为上界**，
> 不因措辞正确就宣称「意图表达准确」。参见 `[DESIGN-MEM-007]` §6 反模式第 2 条
> 「把工作标准写成记忆散文」——本项即该反模式的**活实例**。

#### 3.2.2 可选加固：字符串入参应 fail-soft（**非本次必须，建议顺手修**）

原型实测发现的**既有**行为（非本规范引入）：`formatRecallNotice` 的契约声明入参是
`Array<string>|Set<string>`，但实现（`:119`）接受**任意可迭代对象**：

```js
} else if (filenames && typeof filenames[Symbol.iterator] === 'function') {
  list = Array.from(filenames);   // ← 字符串也可迭代 ⇒ 被逐字符拆开
}
```

实测后果：`'bad'` → `🧠 召回 3 条相关记忆：b、a、d`；
`'a.md'` → `🧠 召回 4 条相关记忆：a、.、m 等 4 条`。

**当前不是活的 bug**——唯一调用点 `aiChatCore.js:2333` 传的是 `_memSurfaced`（`Set`），
永远命中 `Set` 分支。但它与本仓「**低精度守卫比没有守卫更糟**」同族：
**宽容的归一化让畸形输入产出荒谬输出，而不是 fail-soft 返 `''`**。

**建议**（可并入本次改动，也可另开）：在可迭代分支前加
`typeof filenames === 'string'` 的判断 → 规范化为 `[filenames]` 或直接返 `''`。
⚠ 若改，**必须同时更新契约注释**，否则注释与实现继续背离。

### 3.3 V3 双前端落点

| 前端 | 落点 | 现状 | 处方 |
|---|---|---|---|
| TUI | `role:'notice'` 消息 | 已是 spinner 后缀（F5） | 经 `noticeInbox.push` 落持久行 |
| REPL | `_printOnStatusTerminal`（**非** transient） | 走 `_writeOnStatusTransient`（F4） | 给 `init` 加「记忆类告知」白名单走 terminal 分支 |

REPL 侧的**最小改动**：`replSession.js:10340` 分类链中，`init` 阶段命中记忆告知
（识别前缀 `🧠` 或更稳的 `message.kind` 字段）→ 走 `_printOnStatusTerminal`
而非 `_writeOnStatusTransient`。

> ⚠ **别用字符串前缀做判据**。应给 `onStatus` 载荷加一个可选 `kind` 字段
> （如 `kind:'memory-notice'`），分类链按字段判——这是本仓
> 「低精度守卫比没有守卫更糟」的同类问题。

### 3.4 V4 门控与回退

- 主门沿用 `KHY_MEMORY_NOTICE`（default-on，`{0,false,off,no}` 关）。
- **新增**独立门 `KHY_MEMORY_NOTICE_PERSIST`（default-on）：只控制「是否落持久行」，
  关 ⇒ 回到 `onStatus` 单行行为。两个门正交，便于排障时二分。
- 门关 ⇒ `formatRecallNotice` 返 `''` ⇒ 不 push、不 onStatus ⇒ **逐字节回退**（V4）。

---

## 4. 落地清单（改哪几处）

> 遵循「一条规则只应有 1 处语义输入」：**措辞与门控只在 `memoryOpsNotice` 派生**。

| # | 文件 | 改动 | 性质 |
|---|---|---|---|
| **0** | **`.khy/memory/` 记忆库卫生（**须先定位根因，不能只归档**）** | **阻塞前置**。实测 2 条噪声：`feedback_system----_1c477a3f.md`、`feedback_tool-execution-results_a3d9521e.md`。⚠ **它们会再生**（`.archive/` 已有 Sep-3 同名归档，根目录 Sep-24 又出现）⇒ 只归档治不了。**根因在写入侧，须另立条目**（见下方根因说明） | 数据卫生（**先于 1–4**） |
| 1 | `services/backend/src/services/memoryOpsNotice.js` | 扩展 `formatRecallNotice(filenames, ctx)` 加意图子句；新增 `deriveIntentClause(ctx)`；新增 `formatRecallNoticePayload` 返回 `{kind,text}` | 纯叶扩展（**照抄 §3.2.1 原型结构**） |
| 2 | `services/backend/src/cli/aiChatCore.js:2333` | 改为：先试 `noticeInbox.push`，未认领回落 `onStatus({...,kind:'memory-notice'})` | 接线 |
| 3 | `services/backend/src/cli/replSession.js:10340` | `kind==='memory-notice'` → 走 `_printOnStatusTerminal` | 接线 |
| 4 | `services/backend/src/cli/tui/hooks/useQueryBridge.js:2246` | 识别 `kind==='memory-notice'` → 落 `setMessages(role:'notice')`（而非 `safeSetDetail`） | 接线 |
| 5 | `package.json` | 新增 `test:memory-notice`（见 §6）**或**订正 `[OPS-MAN-103]` 删掉该行 | 订正 §1.1 失真 |
| 6 | `docs/07_OPS_运维/OPS-MAN/[OPS-MAN-103] …md` + `.html` | §验证 订正；头部加指向本规范的「已升格」指针 | 孪生件**必须同改** |
| 7 | `services/backend/src/services/domain/memory/memoryEngine/index.js:489-517` | **承接 007 MR-R4③**：`decideUpdate` 返回 `supersede` 时，产出**同通道**告知语（`🧠 已更新既有记忆：X（原记录已归档）`）。**本项为 007 拍板后的实现预留，非本规范独立需求** | 接线（**待 007 拍板后启动**） |
| 8 | `services/backend/src/services/memoryOpsNotice.js`（同第 1 项） | **可选加固**（§3.2.2）：字符串入参 fail-soft；若做，**同步改契约注释** | 加固 |

> ⚠ **第 0 项为何在清单首位**：本规范的全部价值是「让用户知道回忆了什么」。
> 若回忆到的是系统日志，则**做得越显眼，伤害越大**（每轮一条误导性持久行）。

#### 4.0 落地状态（2026-09-27 执行）

| # | 状态 | 落点（实测行号） |
|---|---|---|
| **0** | ✅ **已执行** | 2 条噪声已归档（见 §4.1）；**根因未修 ⇒ 会再生** |
| 1 | ✅ 已实现 | `memoryOpsNotice.js`：`deriveIntentClause` / `formatRecallNotice(f,ctx)` / `formatRecallNoticePayload` |
| — | ✅ 已实现（新增） | `memoryEngine/index.js` `_formatMemoryBlock` 补 `types`（与 `filenames` 平行的 `frontmatter.type`）——**§3.2 意图取数的前提，原清单未列，实施时补入** |
| 2 | ✅ 已实现 | `aiChatCore.js:2390` `noticeInbox.push` 主通道 + `:2396` 回落 `onStatus({kind:'memory-notice'})`；门 `KHY_MEMORY_NOTICE_PERSIST` |
| 3 | ✅ 已实现 | `replSession.js:10216` `phase==='init'` 块内按 `status.kind` 分流到持久打印 |
| 4 | ✅ 已实现 | `useQueryBridge.js:2247` `onStatus` 在 `safeSetDetail` 前按 `evt.kind` 落 `role:'notice'` |
| 5 | ✅ 已实现 | `package.json` 新增 `test:memory-notice`；测试扩到 **22/22** |
| 6 | ✅ 已实现 | `[OPS-MAN-103]` 加「已升格」指针 + 订正 §验证 的假 script 引用 |
| 7 | ⏸ **未启动** | 按本表说明**待 007 拍板**；本轮刻意不动 |
| 8 | ✅ 已实现 | 字符串入参 fail-soft（`'bad'` 从「3 条:b、a、d」改为「1 条:bad」），契约注释已同步 |

> ⚠ **实施期发现的两处「清单外必需项」**（记录以备复核）：
> ① **`types` 取数**（上表第 — 行）：清单第 1 项要求 `deriveIntentClause(ctx)`，但
> `ctx.types` 在既有返回形状里**根本不存在**（`{text, filenames}`）。若不补，意图子句
> 永远走「省略」分支 ⇒ **功能静默不生效而测试仍全绿**。故在 `_formatMemoryBlock` 补 `types`。
> ② **REPL 的 TDZ 陷阱**：清单说「走 `_printOnStatusTerminal`」，但该 `const` 定义在
> `onStatus` 函数体的**更后面**（`:10414`），而 `phase==='init'` 的早退在 `:10216`
> ⇒ 提前调用会抛 `ReferenceError`。故在 init 块内**内联等价逻辑**，不调该 helper。

#### 4.1 第 0 项的**正确处置路径**（2026-09-24 实测核定；2026-09-27 已执行）

> ✅ **已执行（2026-09-27）**：两条噪声已按下方「最小干预」做法归档到
> `.khy/memory/.archive/`（带时间戳后缀，未覆盖 Sep-3 的既有同名归档）：
>
> | 原文件 | 归档为 |
> |---|---|
> | `feedback_system----_1c477a3f.md` | `.archive/feedback_system----_1c477a3f.archived-2026-09-26T23-53-34-802Z.md` |
> | `feedback_tool-execution-results_a3d9521e.md` | `.archive/feedback_tool-execution-results_a3d9521e.archived-2026-09-26T23-53-34-802Z.md` |
>
> 归档后实测**召回面已清空**（`buildSessionPrimingSection` / `buildProactiveMemoryResult`
> 均返 `{text:null, filenames:[], types:[]}`）。
> ⚠ 这只是**临时缓解**：根因（见 §4.2）未修 ⇒ **噪声会再生**。
> 恢复手段：`npm run memory:restore -- --file <filename>`，或直接把归档文件 rename 回根目录。
>
> ⚠⚠ **不要用 `npm run memory:clear`**。实测（`clear-memory.js` dry-run）它的影响面远超目标：
> **P0** 归档全部根目录记忆 **+ 重置 `MEMORY.md` + 重置 10 个成长数据文件**
> （含 `user_preferences.json`、`habits.json`、`user_knowledge_base.json`）；
> **P1** 归档 **75 个**学习缓存。⇒ **这是「全量清空」工具，不是「精准清理」工具**。

**推荐做法（最小干预，可恢复）**：

```bash
# 1) 先把目标文件移入归档（等价于 clear-memory.js 的 safeDelete：renameSync 到 .archive/）
#    注意 feedback_tool-execution-results_a3d9521e.md 在 .archive/ 已有同名（Sep-3），
#    需带时间戳后缀避免覆盖 —— clear-memory.js 已有该逻辑，可参照。
# 2) 恢复手段（真实存在，已核）：
node scripts/memory/restore-memory.js                  # 列出可恢复项
node scripts/memory/restore-memory.js --file <filename> # 精准恢复单文件
node scripts/memory/restore-memory.js --type feedback   # 按类型恢复
```

> ⚠ **`khy memory` 不是真实命令**（`/memory` 仅是 REPL 快捷方式，委派给 `memory` 命令，
> 非归档工具）。`clear-memory.js` 尾注写的 `khy memory distill restore` **同样不存在** ——
> 该脚本的注释与实现背离，属**既有文档失真**（与 §1.1 的 `test:memory-notice` 同族）。

#### 4.2 第 0 项的**根因（须另立条目，本规范不负责修）**

**噪声不是历史遗留，是持续再生的**：

| 证据 | 实测 |
|---|---|
| `.archive/feedback_tool-execution-results_a3d9521e.md` | **Sep-3** 已归档过 |
| 根目录 `feedback_tool-execution-results_a3d9521e.md` | **Sep-24 18:15** 又出现 ⇒ **再生** |
| 来源文本 | `[SYSTEM 收尾保障] …`（`deliverableClosure.js:168`）、`[Tool execution results] …`（`deliveryFormatter.js:56`、`queryEngine.js:230`、`toolUseLoopHelpers.js:103`） |

🔴 **召回面实测（决定性，2026-09-24）**：`memdir.js` 三处扫描（`:503`/`:557`/`:929`）
**全部是非递归的 `readdirSync(memoryDir)` + `.filter(f => f.endsWith('.md') && f !== 'MEMORY.md')`**：

| 项 | 是否参与召回 | 原因 |
|---|---|---|
| 根目录 `feedback_system----_1c477a3f.md` | ✅ **参与** | 根目录 + `.md` |
| 根目录 `feedback_tool-execution-results_a3d9521e.md` | ✅ **参与** | 根目录 + `.md` |
| `user/zlibrary-access.md` | ❌ **不参与** | 在**子目录**中（非递归 ⇒ 扫不到） |
| `feedback/`、`project/`、`reference/`、`logs/`、`.archive/` | ❌ 不参与 | 均为目录 |
| `.distill.json` | ❌ 不参与 | 非 `.md` |

⇒ **当前召回面 = 100% 系统噪声，0% 有效记忆。** 不是"三条里两条脏"，
而是**整个可见召回面只有那两条噪声**。这使第 0 项从"卫生"升级为**硬阻塞**。

> ⚠ **此前的一处误判（本规范 v0.1.3–0.1.4）**：曾把
> `.khy/memory/logs/2026/09/2026-09-24.md` 的 `[Turn]` 记录写成噪声的「落库路径」——
> **该写法误导**：`logs/` 是**目录**，**不参与召回**；它只说明"这些文本在某处被记过"，
> 与"进入召回面"是两件事。已在 v0.1.6 订正。
> ⚠ 同理，§7 曾把 `user/zlibrary-access.md` 标为「✅ 唯一真实用户记忆」——
> 它**同样不参与召回**（在子目录），该标记亦已订正。

🔴 **根因已定位（2026-09-27，受控实验，机制级）** —— 此前「分类器本身是对的 / 写入绕过
`classify()`」的判断**是错的**，现订正：

**触发词是 `不要再`，藏在系统注入文本里。**

| 受控实验（`memoryTrigger.classify()` 直调） | 结果 |
|---|---|
| `'不要再说「让我…」「我来看看…」这类过程话'` | **`explicit` + `type:'feedback'` + `cross_session`** |
| `[SYSTEM 收尾保障] …` **全文**（含「不要再」） | **`explicit` + `feedback`** |
| `[Tool execution results] …` **全文**（含「不要再 web_search」） | **`explicit` + `feedback`** |
| **同一段文本，仅删掉「不要再」** | **`none`** ✅ 对照 |

机制：`memoryTrigger.js:70` 的

```js
const EXPLICIT_RE = /(记住|记一下|…|别再|不要再|…)/i;
```

把**任意位置**出现的「不要再」当作「用户明确要求记住的纠偏偏好」。而系统注入的两段文本
恰好都含它：
- `deliverableClosure.js:168` 的 `[SYSTEM 收尾保障]`：「…**不要再**说「让我…」这类过程话…」
- `deliveryFormatter.js:56` 等的 `[Tool execution results]`：「…本轮禁止再调用任何工具
  （**不要再** web_search / **不要再** WebFetch）…」

⇒ 这两段系统文本被拼进交给 `_maybeAutoSaveMemory` 的 `userMessage` 后，
`classify()` 命中「不要再」⇒ `_inferType` 又因 `FEEDBACK_RE`（同样含「不要再」）判 `feedback`
⇒ **系统提示词被当作"用户偏好"存进了记忆库**。噪声文件的 frontmatter 形状
（`description` = 首行截 40、`name` = 首行 slug 化、`type: feedback`）与
`aiSession.js:301-309` 的生成逻辑**逐字吻合**，可交叉验证。

⇒ **修复点不在记忆侧，在「分类器看到了什么」**：`classify()` 应只看**用户原始输入**，
或忽略 `[SYSTEM …]` / `[Tool execution results]` 这类注入块。属
`[DESIGN-MEM-007]` W 系列「写入触发」问题，**须另立条目**（本规范不越界修它，
但已把根因钉死，避免下一手重演「猜着修」）。

> ⚠ 这也解释了**为何会再生**（`.archive/` Sep-3 归档过、根目录 Sep-24 / Sep-26 又现）：
> 只要系统再注入一次含「不要再」的收尾/工具提示，就会再存一条。
> ⇒ **纯归档治不了本项**，必须先修分类器输入面（或先关掉自动捕获）。

> ⚠ 第 6 项：`check-agent-docs.js` D9 要求指令文件 `.md`/`.html` **同行变更**。
> `OPS-MAN-103` 是否属「指令文件」需先核；若否仍建议同改以保持双入口一致。
>
> ⚠ 第 7 项取证（2026-09-24）：`memoryEngine/index.js` 的 `decideUpdate`
> （`:489-517`）在 `supersede` 路径上**零用户可见输出**（`node` 逐字节扫，无
> `onStatus`/`notice` 命中）⇒ 007 MR-R4③ 声明的「提示用户」**当前完全未实现**。
> 本规范把它的落点一并定义，**避免 007 拍板后重演「规则要求提示、提示没落点」的同一失败模式**
> （即本文件 §1 的 F4/F5）。
> ⚠ 该文件 `:2850` 处**含一个裸 `\0` 字节**，导致普通 `grep` 判其为二进制而**静默跳过全文**；
> 改它前先用 `node` 读取，勿依赖 `grep`（既有状态，非本规范引入）。

---

## 5. 反模式（本规范明令禁止）

| 反模式 | 为什么 |
|---|---|
| 继续加长 `onStatus` 字符串 | F4/F5 证明该通道对长文本**结构性地**不适合承载告知 |
| 用 `includes('🧠')` 做分类判据 | 低精度判据；文案一改即静默失效 |
| 只修 TUI 不修 REPL（或反之） | V3 明确要求双前端；单修会制造「一半用户看不到」 |
| 让模型自述「我记得你…」当唯一手段 | 不可控、不保证出现；本仓已有 `[PROACTIVE_MEMORY]` 提示词，属**补充**非**替代** |
| 意图子句由模型生成后拼进告知语 | 告知语必须**确定性可单测**；模型参与即失稳 |

---

## 6. 验收

```bash
# ✅ 已落地（2026-09-27，§4 第 5 项）：22/22
npm run test:memory-notice

# 纯叶扩展的确定性断言（V2）
node -e "const n=require('./services/backend/src/services/memoryOpsNotice'); \
  console.log(n.formatRecallNotice(new Set(['a.md']),{types:['feedback']}))"
# 期望含「为了遵守你此前给过的协作偏好」

# 门关回退（V4）：两次输出 diff 必须为空
node -e "process.env.KHY_MEMORY_NOTICE='0'; const n=require('./services/backend/src/services/memoryOpsNotice'); \
  console.log(JSON.stringify(n.formatRecallNotice(new Set(['a.md']))))"   # 期望 '""'

# 语法
node --check services/backend/src/services/memoryOpsNotice.js
node --check services/backend/src/cli/aiChatCore.js

# 接线完整性（新增 onStatus 消费点不得让守卫变红）
npm run check:wiring
npm run check:rules

# 落地清单第 7 项（supersede 告知）：须能观察到一次 supersede 产生告知语
node -e "const m=require('./services/backend/src/services/domain/memory/memoryEngine'); \
  console.log(typeof m.addStructuredMemory)"   # 前置：确认导出面（smoke）

# 前置 3 复验：_memSurfaced 可填充性（探针已置于 .khyos/diag/）
node .khyos/diag/probe-mem-surfaced.js
# 期望：预热段 [B] 恒命中；主动召回 [A] 视 query 命中
```

**人工验收（V1/V3，机器判不了）**：
1. ~~**先做 §4 第 0 项**（记忆库卫生）~~ ✅ **已于 2026-09-27 执行**；但⚠ 召回面现为**空**
   ⇒ 看不到告知是**正常的**（没有具名召回可播报）。要验收请先**造素材**：
   用 `/remember` 在根目录写 2–3 条（`reference` 型最佳），见 §7 前置 2。
2. 在 TUI（`KHY_CC_TUI=1`）里制造一次具名召回，确认转录区出现持久行，且**下一轮仍在**。
3. 在经典 REPL 里重复，确认行**不被 `步骤 N/5` 擦除**。
4. 关闭 `KHY_MEMORY_NOTICE_PERSIST`，确认回到旧单行行为。

---

## 7. 依赖与前置

- ⚠⚠ **前置 1（阻塞）：记忆库卫生**。见 §4 第 0 项。**不做则 V2 每轮播报错误意图**。
- ⚠ **前置 2：验收素材（F6 精确化）**。2026-09-24 实测 `.khy/memory/` 存量，
  **并标注是否参与召回**（口径见 §4.2）：

  | 位置 | 内容 | **参与召回？** | 可用性 |
  |---|---|---|---|
  | 根目录 `feedback_system----_1c477a3f.md` | `type: feedback`，正文是**发给模型的纠错提示** | ✅ **参与** | ❌ 非用户偏好 |
  | 根目录 `feedback_tool-execution-results_a3d9521e.md` | `type: feedback`，正文是**工具循环拦截日志** | ✅ **参与** | ❌ 非用户偏好 |
  | `user/zlibrary-access.md` | `type: user` | ❌ **不参与**（子目录，非递归扫不到） | ⚠ 真实但**召不到** |
  | `feedback/`、`project/`、`reference/` | 空 | ❌ 目录 | — |
  | `logs/`、`.archive/`、`.distill.json` | 日志/归档/配置 | ❌ 目录或非 `.md` | — |

  ⇒ **不是「库为空」，也不是「3 条里 2 条脏」——是「整个召回面只有那 2 条噪声」**。
  ⇒ 且**无法自行验收**：唯一真实记忆 `user/zlibrary-access.md` 因在子目录而**召回不到**，
  所以「造素材」不能靠它 —— **必须用 `/remember` 在根目录造 2–3 条**，
  以 `reference` 型最佳（唯一未受污染、且能验证「为了查证外部资料」分支）。
  > ⚠ 这也意味着：**`user/` 子目录的存在本身是一个待查的目录约定不一致**
  > （与 `memdir` 扁平写入约定冲突，见 §3.2）—— 但属既有状态，本规范不整改。

- ✅ **前置 3 已核实：`_memSurfaced` 确实会被填充（V1 不是美化死信号）**。
  实测（2026-09-24，探针 `.khyos/diag/probe-mem-surfaced.js`）：

  | 段 | query | 结果 |
  |---|---|---|
  | 主动召回 | `"记忆"` | 命中 1 条 |
  | 主动召回 | `"khyos 的记忆系统"` / `"你好"` | 命中 **2 条** |
  | 主动召回 | `"zlibrary"` / `"test"` / `""` | 无命中 |
  | **预热段（query 无关）** | 任意 | **恒命中 2 条**（309 字符文本） |

  ⇒ **预热段是 query 无关的** ⇒ 告知语**几乎每轮触发**。这既是 V1 的价值所在
  （确实有东西要播报），也正是**前置 1 必须先行**的原因（播报的正是那两条噪声）。

- ⚠ `deriveIntentClause` 的类型标签须与 `memoryOpsNotice._TYPE_LABEL` **同源**
  （已在同一叶子内，直接复用，不新建副本）；`type` 取数口径见 §3.2 的加粗警告。

---

## 8. 与既有规范的关系

| 文档 | 关系 |
|---|---|
| `[OPS-MAN-103]` | 本规范是其**修正与升格**；103 的纯叶设计保留，接线落点改由本规范定义 |
| **`[DESIGN-MEM-007]` 记忆规则系统总纲** | **上游（行为规则侧）**。007 定义「何时该写/该读/冲突时谁让路」，本规范只回答「这些动作发生时用户能否看见」。007 §3.E **MR-R4③**「P1 冲突时提示用户『记忆与规范 X 冲突，已按规范执行』」是本规范的**首要需求方**；该提示的落点、门控、双前端一致性**全部以本文件为准**。⚠ 007 现为 `03_DESIGN_设计/DESIGN-MEM/` 下的**提案（待评审拍板）**；本规范**先于提案拍板生效**是刻意的——可见性属横切关注点，不因某一批行为规则的评审进度而阻塞。但**若 007 的 R 系列后续改动措辞或增删「须告知」条款，须同步复核本文件 §3.2 的类型标签映射**。 |
| `[DESIGN-MEM-001]` §环境变量表 | 补登 `KHY_MEMORY_NOTICE_PERSIST` |
| `[DESIGN-MEM-002]`（记忆时机指南） | 其「八时机」中任何对用户可见的时点，**可见性实现**以本文件为准 |
| `[DESIGN-MEM-005]` §4.2 记忆检索 | 「主动回忆会根据上下文推荐记忆」需补「并明确告知用户回忆了什么」 |
| `[DESIGN-MEM-006]`（生命周期治理） | 其「指定入口」类治理动作若产生用户可见事件，**同一 notice 通道**承载 |
| `AGENTS.md` §0.9.7 单写者原则 | 本规范是其**在记忆域的应用** |
| `PROCESS-011` 规范-实现裁定 | §1.1 的 `test:memory-notice` 失真按 T2 处理：订正文档（该脚本不存在） |

### 8.1 编号说明（为何本文件是 008 而非 007）

`[DESIGN-MEM-007]` **已存在**（`docs/03_DESIGN_设计/DESIGN-MEM/[DESIGN-MEM-007] 记忆规则系统总纲.md`，
2026-09-23 创建，提案状态），故本文件取 008。

> ⚠ **已知编号隐患（非本文件引入，但会误伤后续维护者）**：
> ① `docs/03_DESIGN_设计/DESIGN-MEM/00_INDEX_DESIGN-MEM-总目录.md` 写「收录 6 篇」
> 而该目录实有 **7 个 `.md`** ⇒ **007 未登记**，读者按索引枚举最大编号会**漏掉 007 而误用 008**；
> ② `[DESIGN-MEM-000]`~`005` 在 `03_DESIGN_设计/` 与 `10_规范/` **两夹各存一份**（迁移遗留），
> 两边索引口径不一。
> 本规范**不擅自整改**（属跨文档治理，须先过 `RUNTIME-009` 安全闸）；
> 仅在 §9 版本历史登记该项，交由维护者决定。

---

## 9. 版本历史

| 版本 | 日期 | 变更 |
|---|---|---|
| 0.1.0 | 2026-09-24 | 初版：取证 F1–F7、判据 V1–V4、方案（noticeInbox 主通道 + 意图派生 + 双前端）、反模式、验收 |
| 0.1.1 | 2026-09-24 | 补正：查明 `[DESIGN-MEM-007]` 已存在（03_DESIGN 夹）⇒ ① 补登 §8 真源关系（本文件为 007 §5 让出块「UI/展示」的承接者，主要需求方为 007 MR-R4③）；② 补 §8.1 编号说明，含两处既有编号隐患（007 未登记于 03_DESIGN 索引；000–005 双夹重复）——**仅登记不整改** |
| 0.1.2 | 2026-09-24 | 补正：① §3.2 加「`type` 取数口径」硬约束（**必须取 `frontmatter.type`，禁按目录推断**；实测存储扁平、存在 `user/` 目录例外与根目录文件）；② §7 把「记忆库为空」精确化为实测存量表，并声明**2/3 存量是与用户无关的系统事件** ⇒ 会渲染出「文案正确但内容误导」的告知；③ §3.2 加失真声明（意图子句准确性以**上游记忆质量**为上界）；④ §4 加落地清单第 7 项（承接 007 MR-R4③ 的 supersede 告知）；⑤ §6 订正 `test:memory-notice` 不存在、增第 7 项验收 |
| 0.1.3 | 2026-09-24 | **可实施性原型实跑**（真源码等价替换，探针 `.khyos/diag/`）⇒ ① 新增 §3.2.1 原型结论（锚点 4/4 唯一、语法合法、V2 行为 7/7、**V4 回退 6/6 逐字节相等**）；② 订正 §3.2 渲染样例的动词（原写「回忆起」⇒ **改为真源原词「召回」**），并加**措辞纪律**警告（改词即破 V4，实测 6/6 diff）；③ 订正函数签名为 `deriveIntentClause(ctx)`；④ 新增 §3.2.2 可选加固项（字符串入参被逐字符拆开的既有行为，当前非活 bug） |
| 0.1.4 | 2026-09-24 | **地基实测**（探针 `.khyos/diag/probe-mem-surfaced.js`）⇒ ① §3.2 失真声明**从"已知失真"升级为"系统性/高频失真"**：实测预热段 **query 无关、恒命中那两条系统噪声** ⇒ 告警语**几乎每轮触发且内容错误**；② §4 新增**第 0 项阻塞前置**（记忆库卫生）——不做则本规范"做得越显眼、伤害越大"；③ §4 新增第 8 项（可选加固）；④ §7 前置重排为三条，新增**前置 3「`_memSurfaced` 确实会被填充」实测表**（V1 不是美化死信号）；⑤ §6 加探针复验命令，人工验收步骤改为先做第 0 项 |
| 0.1.5 | 2026-09-24 | **第 0 项处置路径核定 + 三次自我纠错**：① 查明 **`khy memory` 命令不存在**（v0.1.2–0.1.4 的 §4 第 0 项建议有误）⇒ 订正；② 实测 `npm run memory:clear` 是**全量清空**（P0 重置 `MEMORY.md` + 10 个成长文件；P1 归档 75 个学习缓存）⇒ **明令不得用于本项**；③ 新增 §4.1 给出**最小干预**处置 + 真实恢复命令（`restore-memory.js --file`）；④ 新增 §4.2 根因说明：噪声**持续再生**（`.archive/` Sep-3 归档过、根目录 Sep-24 又现），但 `memoryTrigger.classify()` 对系统文本返回 `none` ⇒ **写入绕过分类器或另有入口，须另立条目**；⑤ §1.1 补登两处新发现失真（`clear-memory.js` 尾注命令不存在；本规范自身的 `khy memory` 误引） |
| 0.1.6 | 2026-09-24 | **召回面核定（决定性取证）+ 两处自纠**：① 查实 `memdir.js` **三处扫描全部非递归**（`:503-504`/`:557-558`/`:929-930`）+ 写入扁平（`:508`/`:562`）⇒ **只有根目录 `.md` 参与召回**；据此 §3.2 失真声明从「混入 2 条噪声」升级为「**召回面 100% 噪声、有效记忆 0 条**」，并附逐条参与召回核对表；② 订正 §4.2 误导写法（曾把 `logs/**/[Turn]` 当"落库噪声" ⇒ 实为**目录、不参与召回**）；③ 订正 §7 前置 2（`user/zlibrary-access.md` 曾标「✅ 唯一真实用户记忆」⇒ 实为**子目录、召回不到**），结论从「3 条里 2 条脏」改为「整个召回面只有那 2 条噪声」 |
| **0.2.0** | **2026-09-27** | **按方案落地（生产代码首次改动）**：① **第 0 项已执行**（2 条噪声归档到 `.archive/`，召回面清空；**根因未修 ⇒ 会再生**）；② **🔴 根因定位成功（机制级、受控实验）** —— 触发词是 `EXPLICIT_RE` 里的 **`不要再`**，而 `deliverableClosure.js:168` 的 `[SYSTEM 收尾保障]` 与 `deliveryFormatter.js:56` 等的 `[Tool execution results]` 正文**恰好都含它** ⇒ **系统提示词被当作"用户偏好"存进记忆库**；**推翻了 v0.1.x「分类器本身是对的、写入绕过了 classify()」的旧判断**（旧判断只在**截断文本**上测过，测全文即复现）；③ 新增 §4.0 落地状态表（含**两处清单外必需项**：`types` 取数缺失会让功能**静默不生效而测试全绿**；REPL `_printOnStatusTerminal` 的 **TDZ 陷阱**）；④ 纯叶扩至 `deriveIntentClause` / `formatRecallNotice(f,ctx)` / `formatRecallNoticePayload` / 字符串加固；⑤ `memoryEngine._formatMemoryBlock` 补 `types`；⑥ `aiChatCore` 接 noticeInbox 主通道 + `onStatus({kind})` 回落；⑦ `replSession` / `useQueryBridge` 双前端按 `kind` 分流；⑧ `test:memory-notice` 落地，测试 11 → **22 例**；⑨ `[OPS-MAN-103]` 升格指针 + 假 script 引用订正 |

---

*本规范由 khy-os 维护者维护；任何「记忆可见化已完成」的声称须先过 §6 验收。*
