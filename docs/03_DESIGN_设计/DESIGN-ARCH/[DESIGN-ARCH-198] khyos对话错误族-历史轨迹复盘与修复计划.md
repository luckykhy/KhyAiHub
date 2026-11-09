<!-- IMPL-STATUS: partial -->
<!-- RULES-REGISTRY: RUNTIME-005, RUNTIME-002 -->
# [DESIGN-ARCH-198] khyos 对话错误族 — 历史轨迹复盘与修复计划

> **定位**：本文是**修复计划 + 实施记录**。2026-11-01 用户报「khyos 对话中有大量错误」并附截图，
> 本文用**真实会话轨迹**（非推理）定位根因、给出修复波次，并回填**实施结果与偏差**（§7）。
> 语义真源关系：本文补 `[DESIGN-ARCH-114]`（CLI 错误标准化 / RUNTIME-005）的**执行缺口**——
> 那篇规范冻结了失败块的**契约**，但**契约在 khyos 主路径上被绕过**（本文 §2.5 实测）。
>
> **存证**：`works/data/khy/feedback/khyos-conversation-errors-20261101/`
> （`transcript.txt` 完整转录 / `defect-evidence.txt` 逐条证据 / `corpus-stats.json` 全库频次）。
>
> **关联**：`[DESIGN-ARCH-114]` CLI 错误标准化规范、`[DESIGN-ARCH-181]` 通道兜底族资格与统一策略、
> `[DESIGN-ARCH-028]` Agent 通信防御（零静默失败与精准归因）。

## 0. 结论先行

用户截图里的「大量错误」**不是多个独立 bug**，而是 **4 个根因**在一条会话里叠出来的**次生噪音**：

| # | 根因 | 用户看到的样子 | 一句话根因 |
|---|---|---|---|
| **R1** | 轮次计数器被自己注入的提示词**污染**，饱和在 2 | 反复发同一问题，永远显示「第 2 次」 | 注入文本回灌进历史，下一轮自己跟自己不相似了 |
| **R2** | 失败墙被**压成一行 + 截断 + 双标签** | 「具体原因：真实失败原因: - kiro … - cursor …」挤成一坨 | 清洗函数折叠换行 + 220 字截断 + 标签叠标签 |
| **R3** | 上游真因**认不出**，只剩通用「输入「继续」」 | 限额/缺 key 都说「说『继续』即可」 | 真因叶子不认 `FreeUsageLimitError`；`auth` 类被规则表排除 |
| **R4** | 旁白 `occurrence` **没接线**，并行调用拿同一句 | 同一句「我把要点整理出来再回到正题」重复 3 次 | loop 侧调用漏传 occurrence，TUI 侧传了 |

**最关键的一条（不在用户截图里，但是根因之根）**：

> **RUNTIME-005 已明文要求「CLI/TUI 失败展示必须由结构化失败信封渲染」，`cliFailureEnvelope.js` 也已实现且工作正常
> —— 但 khyos 的失败路径根本没走它。** 实测：同一份 attempts 数据，
> 信封渲染出的是 `⚠ 本次请求未能完成 —— 认证失败 / [AUTH_FAILED] / 通道: OpenCode Zen [auth] / → 运行 ai config 检查…`，
> 而用户实际看到的是**一行挤扁的散文墙**。规范没写错，是**接线断了**。

**因此本计划的主线不是「加新逻辑」，而是「把已有的正确实现接回主路径 + 堵住会污染自己的那一处」。**

## 1. 复盘方法（为什么结论可信）

用户只给了一张截图。截图能证明「有问题」，不能证明「为什么」。故本轮**不用推理**，全部用实测：

1. **定位真身会话**：截图标题「今日新闻查询与断点续写」→ 在 `works/data/khy/sessions/D-Portable/` 下按
   今日 mtime 找到 `d7cb5772-6deb-463a-a727-449aee1edd58.jsonl`，**10 条消息逐字节读出**，与截图逐行对上
   （首轮失败墙、第 2/3 轮的 `[SYSTEM] 重复请求识别` 注入、旁白三连、末轮 `Missing API key`）。
2. **全库量化**：`works/data/khy/sessions/` 下 **246 份会话 / 1268 轮**全量扫描，得到各缺陷的**真实频次**
   （§3）。这排除了「单次偶发」的解释——双标签 **31/31 失败墙全中**，是**必现**。
3. **根因验真**：每条根因都写了**独立探针**（`works/data/khy/T4-transient/tmp/verify-hypotheses.cjs`、
   `verify-wall-chain.cjs`、`verify-envelope.cjs`），直接调用产品模块复现截图里的**逐字节输出**。
   **没有一条根因是靠读代码猜的。**

> 本轮只写计划，**未改任何产品代码**（探针只在 `T4-transient/tmp/`，按 B8 不入仓）。

## 2. 根因详述（逐条附实测证据）

### 2.1 R1 · 轮次计数器自污染 → 永远「第 2 次」

**现象**（截图 + 转录 `[2]`、`[6]`）：用户连发 3 次「今天有些什么新闻？」，
系统两次都注入「用户已第 **2** 次发送基本相同的请求（这是第二轮）」。模型于是说「这是**第三轮**同一请求」
（转录 `[7]`）——**系统说 2，模型说 3，两者互相矛盾**。

**根因链**：

```
repeatedPromptRounds.countRound()            ← 用「历史 user 轮」数重复
  └─ priorUserTextsFrom(initialMessages)      ← 历史里存的是**被注入过的**那条
       └─ toolUseLoopCore.js:1738  currentMessage = `${_roundHint}\n\n${currentMessage}`
            └─ 这条污染过的文本被 conversationMessages.push({role:'user'}) 回灌
                 └─ 下一轮 countRound 拿它跟**干净的**新提示词比
                      └─ similarity(干净, 被注入) = 0.0476  ≪ 阈值 0.9
                           └─ 判「不同请求」→ 重复计数不增 → 恒为 2
```

**实测**（`verify-hypotheses.cjs` H4）：

```
请求#1 → 轮次=1
请求#2 → 轮次=2
请求#3 → 轮次=2      ← 应为 3
请求#4 → 轮次=2      ← 应为 4
→ 计数器饱和于 2（真值应为 1/2/3/4）
```

**旁证**：转录 `[2]` 与 `[6]` 两条 user 消息**逐字节相同**（已断言 `===` 为 true）。

**次生伤害**：`sessionPersistence._SYNTHETIC_USER_PREFIXES` 收的是 `'[SYSTEM:'`（带冒号），
而注入前缀是 `'[SYSTEM] '`（无冒号）→ **不被识别为合成消息** →
这条提示词会参与**会话标题选取**（`_pickTitleCandidate`）与历史污染判定。

### 2.2 R2 · 失败墙被压扁、截断、叠标签

**现象**：截图中一行到底 ——「具体原因：真实失败原因: - kiro [unavailable]: Kiro IDE unavailable - cursor …」。

**三处叠加**（全部实测）：

| # | 动作 | 位置 | 后果 |
|---|---|---|---|
| a | `sanitizeCause` 里 `s.replace(/\s+/g, ' ')` | `honestFailureReason.js:76` | **多行墙被折成一行**，列表结构全失 |
| b | `sanitizeCause(raw, maxLen=220)` + `…` | `honestFailureReason.js:77-79` | 尾部截断，末条适配器只余「cursor [unavail…」 |
| c | `resolveFriendlyFailureMessage` 前置「具体原因：」 | `honestFailureReason.js:110/112` | 与墙自带标签叠成「**具体原因：真实失败原因:**」 |

**实测**（`verify-wall-chain.cjs`）：`含换行? false | 末尾省略号? true | 双标签? true | 是单行? true`。
注意 a 是**元凶**：折叠发生在标签拼接**之前**，所以后面再怎么拼都救不回列表。

**同类已修先例**：`visionFailureSummary.js` 早就有 `KHY_VISION_FAILURE_CAUSE_DEDUP` 门
（`:275` 剥自带标签）——**同一类 stutter，视觉路径修过，通用路径没修**。

### 2.3 R3 · 上游真因认不出 → 只剩「输入「继续」」

**现象**：截图首轮真因是 `FreeUsageLimitError`（免费额度用尽），末轮是 `Missing API key`（缺 key）。
两条都是**用户自己能修**的问题，系统却都只给「输入「继续」即可从断点续写未完成的内容。」

**实测**（`verify-wall-chain.cjs` §4、§6）：

```
describeUpstream(FreeUsageLimitError, errorType=network)
  → {label:'上游 FreeUsageLimitError', advice:'', transient:false}   ← advice 为空
describeUpstream(AuthError, errorType=auth)
  → null                                                          ← 完全认不出
isResumableError('auth') = true    ← 且 auth 不在 NON_RESUMABLE 里
```

**两层原因**：

1. `upstreamTruthLabel._RULES` 无 `FreeUsageLimitError` 规则 → 落到 generic 分支，
   拿得到 label 拿不到 `advice`；而 `_honestContinueHint`（`aiChatCore.js:3487-3499`）**只在 `advice` 非空时**才给具体建议，
   否则回落通用 `CONTINUE_HINT`。
2. `auth` 属 `_RULE_ONLY_TYPES`（`:38`）——「只有命中已知语义时才改写」。
   `AuthError`/`Missing API key` 不在规则表里 → **认不出** → 连标签都没有。

**同时**：`honestFailureReason.buildKeyConfigInvite` 明明就会为 auth 类生成
「需要我帮你换一个新 key 吗?」——但它挂在 `toolUseLoopCore.js:3460`，
**读的是 `aiResult.errorType`**；而 khyos 走的是 `aiChatCore` 那条，**没走那个分支**。

> 顺带暴露一个**规范冲突**：`aiChatCore` 的失败分支同时调用
> `resolveFriendlyFailureMessage`（前置标签）与 `buildKeyConfigInvite`（追加建议），
> 而 `buildKeyConfigInvite` 只认 `auth/no_key/pool_exhausted`。
> 缺 key 的 `AuthError` 被分类成 `auth` 时**应该**拿到邀约——但真因叶子先认不出它，标签都退化成裸 `[auth]`。

### 2.4 R4 · 旁白 occurrence 未接线 → 并行调用同一句

**现象**（转录 `[4]`）：三路并行 `webSearch` 的旁白是
「外部查到 10 条，我把要点整理出来再回到正题。 外部查到 7 条，我把要点整理出来再回到正题。 外部查到 7 条，…」——
**同一句重复 3 次**。

**根因**：`toolUseLoopCore._buildOutcomeReflectionHint`（`:286`）调用
`toolOutcomeNarration(tr.tool, tr.result||{}, tr.params||{})` —— **第四个参数 `options` 没传**，
于是 `options.occurrence` 为 `undefined` → `_voice`（`toolPrefaceVoice.js:23-29`）取 `occ=0` → 永远返回**首发句**。

**实测**（`verify-hypotheses.cjs` H3）：

```
loop 侧(不传 occurrence) 三连 → 三句全同 → true
TUI 侧(传 occurrence 0/1/2) → 三句各异 → false
```

**即**：TUI 侧（`queryBridgeTimeline.js:753`）**接线是对的**，loop 侧（喂给模型的参考旁白）**漏了**。
两边行为不一致，这正是「同一件事两处实现」的典型漂移。

### 2.5 ★ 最关键：CLI 失败信封被绕过（RUNTIME-005 的执行缺口）

`[DESIGN-ARCH-114]` / **RUNTIME-005** 白纸黑字：

> 「CLI / TUI 的失败展示**必须**由**一个结构化对象**渲染，禁止再对 `result.content` 做字符串截断拼接。」

`cliFailureEnvelope.js` 已实现（`buildCliFailureEnvelope` / `renderCliFailureEnvelope`），
门 `KHY_CLI_FAILURE_ENVELOPE` **默认开**（实测 `isFlagEnabled → true`，env 未显式设置）。

**但 khyos 的失败路径不走它。** 同一份 attempts 数据，两条路产出天壤之别（`verify-envelope.cjs`）：

```
【信封渲染（规范要求的）】
⚠ 本次请求未能完成 —— 认证失败
[AUTH_FAILED]
通道: OpenCode Zen [auth] — {"type":"error",...}
→ 运行 `ai config` 检查/更新该通道的 API key
→ 确认账号余额与权限后重试

【用户实际看到的（截图）】
具体原因：真实失败原因: - OpenCode Zen +1 个适配器 [auth]: {...} - relay_api [unavailable]: ... - kiro ...
输入「继续」即可从断点续写未完成的内容。
```

**接线现状**：`cliFailureEnvelope` 全仓**只有 2 个调用点**，都在 `aiChatCore.js`（`:3355`/`:3548`）——
即**REPL 路径**。而截图这条是 **TUI 路径**（`useQueryBridge` → `toolUseLoopCore`），
其失败文案走 `toolUseLoopCore.js:3409` 的 `resolveFriendlyFailureMessage` → **完全不经过信封**。

**结论**：规范没写错、实现没写错、门也开着——**是 TUI 这条路没接线**。
这解释了 R2/R3 的**全部**症状：既然没走信封，就必然落到散文拼接 + 截断 + 通用提示的老路上。

**旁证**：`failureReasonRanking` / `buildChannelFailureAdvice` / `upstreamTruthLabel`
这些为信封准备真因的叶子**都工作正常**，只是**输出给了一个没人读的出口**。

## 3. 全库量化（246 份会话 / 1268 轮）

| 症状 | 出现次数 | 判读 |
|---|---|---|
| 失败墙出现 | 31 | — |
| **双标签「具体原因：真实失败原因:」** | **31 / 31** | **100% 必现**，非偶发 |
| 附通用「输入「继续」」提示 | 31 | 与失败墙同数（同一出口） |
| 其中**无任何可执行建议** | 30 / 31 | 97% 的失败只给了一个无效动作 |
| IDE 适配器噪音行（kiro/cursor/trae unavailable） | 17 | 淹没真因 |
| `FreeUsageLimitError` 出现 | 9 | 全部落到无建议分支 |
| 裸 JSON 泄进用户可见文案 | 2 | `{"type":"error",...}` 直出 |
| 旁白重复（同一句 ≥2 次） | 8 | R4 |
| `[SYSTEM] 重复请求识别` 泄进 **user 角色** | 7 | R1 |

**关键读数**：31 个失败墙**无一例外**中双标签；30/31 的失败**没有一个**给出可执行建议。
**这不是「偶尔出错」，是这条路径的结构性输出。**

## 4. 修复计划

### 4.0 通用纪律（每条都遵守，勿跳）

| 纪律 | 具体做法 |
|---|---|
| **门控回退** | 每个行为变更挂独立 env 门（`KHY_*`），**默认开**、可关；关 → **逐字节**回退今日行为 |
| **纯叶子优先** | 新逻辑放**纯函数叶子**（零 IO / 确定性 / 绝不抛 / 可单测），不塞进 `toolUseLoopCore` 这类巨型文件（R4 上帝文件门） |
| **不碰红区** | 失败墙里**绝不**新增/回显任何真 key/token（R2 密钥防泄露）；现有脱敏路径不得放宽 |
| **不擅自动版本** | MINOR/MAJOR 递增**必须**人点头（B7）；本计划本身不改版本号 |
| **不自动提交** | 改动落地后**不** `commit`/`push`（R1 分支纪律），交给人裁决 |
| **回归可判定** | 每条修复都要有**红→绿**的自动化断言，不靠「看着对了」 |

### 4.1 W1 · 把 TUI 失败路径接回 CLI 失败信封（**最高优先**）

> **为什么第一**：R2/R3 的症状**全部**源于此。接回去，它们多半**自动消失**，后续几刀才不用反复重写文案。

- **改动点**：`toolUseLoopCore.js` 的失败收口（约 `:3409` / `:3450` 附近）——
  在 `resolveFriendlyFailureMessage` 之前先问信封：
  `buildCliFailureEnvelope({result, env})`，命中则用 `renderCliFailureEnvelope` 的首屏，
  旧散文降级为**展开层**（与 `aiChatCore.js:3552-3559` 已有的两层结构**对齐**，不发明第三种形状）。
- **接线口径**：`aiChatCore` 与 `toolUseLoopCore` **共用同一个渲染入口**
  （建议抽 `cli/renderGatewayFailure.js` 薄壳），杜绝第三次漂移。
- **门**：`KHY_TUI_FAILURE_ENVELOPE`（默认开）。
- **验证**：
  - 断言 TUI 失败首屏含 `[AUTH_FAILED]` **且不含**「具体原因：真实失败原因」；
  - 断言 `FreeUsageLimitError` 场景首屏含**可执行建议**（不再只有「输入「继续」」）；
  - 断言旧散文**仍在**（展开层可见）——不丢信息。

### 4.2 W2 · 修 R1：轮次计数不再被自己污染

- **改动点**（二选一，**推荐 b**）：
  - **a（治表）**：`repeatedPromptRounds.priorUserTextsFrom` 抽取历史时**剥掉**已知的系统注入前缀
    （`'[SYSTEM] '` 等）再比对；
  - **b（治本，推荐）**：**注入不进历史**——`toolUseLoopCore.js:1738` 的注入改为**只喂模型**，
    **不回灌** `conversationMessages` / `initialMessages`。
    语义上更对：那条提示词是**给模型的旁注**，不是**用户说的话**，用户消息里不该有它。
- **顺带**：`sessionPersistence._SYNTHETIC_USER_PREFIXES` 补 `'[SYSTEM] '`（无冒号形态），
  让旁注**不参与**标题选取与合成消息判定。
- **门**：`KHY_PROMPT_ROUND_UNPOLLUTED`（默认开）。
- **验证**：连发 4 次同款 → 轮次依次 **1/2/3/4**（红→绿）；历史 user 轮**不含** `[SYSTEM] 重复请求识别`。

### 4.3 W3 · 修 R2：失败墙不再压扁 / 截断 / 双标签

- **改动点**：
  - `honestFailureReason.sanitizeCause`：**保留换行**（列表是结构化信息，不该被折叠）；
    长度上限**提高并改为按行截断**（保住每行完整，而不是把末行腰斩成「cursor [unavail…」）。
  - `resolveFriendlyFailureMessage`：cause **已自带**「真实失败原因:」标签时**不再叠加**「具体原因：」
    ——与 `visionFailureSummary.js:275` 的既有去重门**同款**（把那个门的口径**提到通用路径**）。
- **门**：`KHY_FAILURE_CAUSE_DEDUP`（默认开）+ `KHY_FAILURE_WALL_KEEP_LINES`（默认开）。
- **验证**：构造 4 组适配器的失败 → 文案**保留换行**、**无**双标签、**末组不被腰斩**。

### 4.4 W4 · 修 R3：上游真因认得出 + 失败必给可执行建议

- **改动点**：
  - `upstreamTruthLabel._RULES` **补规则**：`FreeUsageLimitError` / `free usage limit` →
    label「上游免费额度用尽」、**非瞬态**、advice「等配额恢复或换付费通道」；
    `AuthError` / `Missing API key` → label「缺少 API Key」、advice「配置 key 或换通道」。
  - `auth` 类的 `_RULE_ONLY_TYPES` 例外：**上游明写「缺 key」时必须能改写**（否则用户永远看不到该修哪）。
  - `honestFailureReason.buildKeyConfigInvite` 的**可达性**：确认 khyos 路径也拿到邀约
    （现在只有 `toolUseLoopCore` 那一处调用；接信封后由信封统一出）。
- **门**：`KHY_UPSTREAM_QUOTA_TRUTH`（默认开）。
- **验证**：`FreeUsageLimitError` → 文案含「额度」且 advice 非空；`Missing API key` → 含「API Key」。

### 4.5 W5 · 修 R4：旁白 occurrence 接回 loop 侧

- **改动点**：`toolUseLoopCore._buildOutcomeReflectionHint` 调用 `toolOutcomeNarration` 时**补传
  `{ occurrence }`**，occurrence 按**本批次同类工具出现次数**计（与 TUI 侧 `queryBridgeTimeline` 同口径）。
  建议把 occurrence 计算抽成**共用纯叶子**，两边共用一份 —— 消除「一边传一边不传」的漂移。
- **门**：`KHY_LOOP_NARRATION_OCCURRENCE`（默认开）。
- **验证**：一批 3 个同类工具 → 旁白**三句不同**。

### 4.6 W6 · 失败墙信息分层（治「看起来很吵」）

- **改动点**：信封的 `attempts` 展示层**分层**——
  **① 主因**（唯一，可行动）置顶；**② 其它适配器**折叠为一行计数；
  **③ IDE 适配器 unavailable**（本机没装 IDE，**不是失败原因**）**不单列**。
- **理由**：截图里 3 条 IDE 噪音挤占了真因的位置；用户装了 IDE 才可能相关，没装时它们是**恒定的环境事实**，不是失败原因。
- **门**：`KHY_FAILURE_ATTEMPT_TIERS`（默认开）。
- **验证**：含 3 个 IDE unavailable + 1 个真因的失败 → 首屏只呈现真因 + 一行计数。

### 4.7 W7 · 旁白去重兜底（防复发）

- **改动点**：`_buildOutcomeReflectionHint` 拼多行时，**逐字相同**的旁白**只留一条**（其余折叠计数）。
  这是**兜底**，不是替代 W5——W5 治「为什么重复」，W7 治「万一又重复」。
- **门**：`KHY_OUTCOME_HINT_DEDUP`（默认开）。
- **验证**：3 条完全相同的旁白 → 输出 1 条 + 计数。

### 4.8 波次顺序与依赖

```
W1（接信封）─┬─→ W3（墙格式）      ← W1 之后多半已无「墙」可修，但 W3 仍需（信封首屏也走清洗）
             ├─→ W4（真因认得出）  ← 依赖 W1：建议由信封统一消费
             └─→ W6（信息分层）    ← 依赖 W1

W2（轮次去污染）─→ 独立，可并行
W5（旁白 occurrence）─→ 独立，可并行
W7（旁白去重兜底）─→ 依赖 W5
```

**建议排期**：W1 → W2/W5（并行）→ W3/W4/W6 → W7 → 全量回归。
**W1 不做完，后面几刀都在给一条没人走的路补漆。**

### 4.9 每波次的验收门（红→绿，必须逐条通过）

```bash
node --check <改动文件>                     # 语法
node --test <该波次新增/改动的测试文件>      # 红→绿
node scripts/ci/check-change-safety.js --changed
node scripts/ci/check-agent-rules.js --changed
node scripts/ci/check-repo-layout.js
node scripts/ci/check-copyright-readiness.js
npm run arch:god --workspace runtime/node/backend
khy doctor
```

**新增测试建议落点**（沿用仓内既有位置）：
- `runtime/node/backend/tests/services/repeatedPromptRounds.test.js`（扩 R1 用例）
- `runtime/node/backend/tests/honestFailureReason.test.js`（扩 R2/R3 用例）
- `runtime/node/backend/tests/cli/handlers/aiGatewayGenerateHelpersLeaf.test.js`（墙格式）
- `runtime/node/backend/tests/cli/toolPrefaceVoice.*.test.js`（R4/R7 用例）
- 新增 TUI 失败首屏的**端到端**断言（禁只测叶子）

### 4.10 本计划**不做**的事（明确划界，防范围蔓延）

- **不改** `cliFailureEnvelope.js` 的**契约**（`[DESIGN-ARCH-114]` 已冻结）——本轮是**接线**，不是重设计。
- **不改** `RUNTIME-005` 的规则文本（它没说错）。
- **不删**旧的散文失败路径（降级为展开层，信息不丢）。
- **不动** khyos 之外的交付面（web / mobile）——同一信封可复用，但不在本轮范围。
- **不 bump** 工程版本（B7：MINOR/MAJOR 须人点头）。
- **不 commit / push**（R1）。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| W1 接线后**首屏变短**，信息是否丢了？ | 旧散文**保留**为展开层，并加断言：首屏与展开层合起来**信息量不减** |
| W2 改「注入不回灌」会不会影响模型读上下文？ | 注入只是**旁注**；模型仍在本轮收到它，只是不再**冒充用户发言**。加用例断言模型仍收到提示 |
| W3 保留换行会不会撑爆某些终端渲染？ | 按行截断 + 现有行数上限；真屏实测（TUI + REPL） |
| W4 补规则会不会把 `auth` 误判成别的类？ | 新规则**只加 label/advice，不改 errorType 分类**（与 `upstreamTruthLabel` 既有职责一致） |
| W6 折叠 IDE 噪音，用户想看全量怎么办？ | 折叠层可展开；IDE 适配器**仍在** attempts 里可查 |
| 一次做 7 波，风险大 | 每波独立门 + 独立红→绿断言；**可单独回退**（门关即逐字节回退） |

## 6. 附录 · 本轮跑过的探针（可复现）

| 探针 | 验证什么 | 结论 |
|---|---|---|
| `verify-hypotheses.cjs` | 双标签 / 上游真因 / 旁白 occurrence / 轮次饱和 | 4 条根因**全部复现** |
| `verify-wall-chain.cjs` | 失败墙逐字节渲染链 | 单行 + 截断 + 双标签**全中** |
| `verify-envelope.cjs` | 信封是否可用 / 为何没被用 | 信封**可用且正确**，只是**没接线** |
| `scan-defects.cjs` | 全库频次 | 双标签 **31/31 必现** |

> 探针放 `works/data/khy/T4-transient/tmp/`（B8：临时件不进仓库根），**未入版本控制**。
> 证据快照已归档至 `works/data/khy/feedback/khyos-conversation-errors-20261101/`。

---

## 7. 实施记录（2026-11-01 · 自我对抗式修复）

### 7.1 方法：先证伪，再修，再对抗

每个波次都走同一条**对抗式**路径，**不许**「先改代码再补测试」：

1. **证伪**：写一条断言真实症状的测试，先跑出**红**，并把红时的实际输出**逐字节**记下来；
2. **修**：改产品代码；
3. **再证伪**：同一测试转**绿**；
4. **对抗**：追加「**门关 → 与今日逐字节一致**」与「**上游确实渲染出了信封**」两类反向断言——
   前者防「门没接线」的假绿，后者防「没信封也绿」的假绿；
5. **回归**：跑**全部引用了被改模块**的套件（本轮 23 套 / 350 例全绿）。

### 7.2 计划与实现的**一处偏差**（比原计划更准）

**原计划**（§4.1 W1）判断是「khyos 的 TUI 失败路径**根本没走**信封，W1 = 在 TUI 侧**新建**信封渲染」。

**实施中证伪出的真实机制更准**（`toolUseLoop.failureEnvelopeWiring.test.js` 证伪输出）：

```
"认证失败。具体原因：真实失败原因: - kiro [unavailable]: Kiro IDE unavailable·
输入「继续」即可从断点续写未完成的内容。·"
```

信封**是被渲染了的**——`aiChatCore.chat()`（正是 TUI 用的那个 `chat`）在网关失败时
**已经把信封渲染好**并随 `reply` + `failureCode` 返回（`failureCode` **仅**信封分支写入
→ 是「上游已渲染信封」的**可靠**判别信号）；而 `toolUseLoopCore` 的错误收口
**弃之不用**，改从 `failureDetails` 重新拼散文墙 → **把已经算好的信封丢了**。

⇒ 故 W1 的正确修法不是「新建渲染」，而是**「别丢」**：
新增纯叶子 `services/gateway/upstreamFailureEnvelope.js`（判定 + 拆分首屏/展开层），
`toolUseLoopCore` 在上游已给信封时**直接沿用其首屏**，旧诊断墙降级为展开层（信息不丢）。

**这条偏差本身就是「自我对抗式」的价值**：只读代码会得出「TUI 不走信封」的结论；
只有把真实链路跑起来、把断言写成红，才会看见「信封被丢弃」这个更精确的机制。

### 7.3 落地清单

| 波次 | 改动文件 | 门 |
|---|---|---|
| W1 | 新增 `src/services/gateway/upstreamFailureEnvelope.js`；改 `src/services/tool/toolUseLoopCore.js`（错误收口沿用信封首屏；salvage 路径不把信封塞进括号注解） | `KHY_TUI_FAILURE_ENVELOPE` |
| W2 | 新增 `src/services/promptScaffolding.js`（剥系统注入旁注）；改 `src/services/repeatedPromptRounds.js`（历史侧与当前侧**都**剥，**均受门控**）；改 `src/services/sessionPersistence.js`（`[SYSTEM]` 无冒号形态纳入合成前缀） | `KHY_PROMPT_ROUND_UNPOLLUTED`（门关 → 不剥离 → 逐字节回退今日的饱和行为） |
| W3 | 改 `src/services/honestFailureReason.js`（`sanitizeCause` 保留换行 + 按行截断；`resolveFriendlyFailureMessage` 不叠「具体原因：」但**保留**自带标签） | `KHY_FAILURE_WALL_KEEP_LINES` / `KHY_FAILURE_CAUSE_DEDUP` |
| W4 | 改 `src/services/gateway/upstreamTruthLabel.js`（补「上游免费额度用尽」「缺少 API Key」两条规则，**不改** errorType 分类） | `KHY_UPSTREAM_QUOTA_TRUTH`（规则级门） |
| W5 | 改 `src/services/tool/toolUseLoopCore.js`（`_buildOutcomeReflectionHint` 按本批次同类工具次数传 occurrence） | `KHY_LOOP_NARRATION_OCCURRENCE` |
| W6 | 改 `src/services/gateway/cliFailureEnvelope.js`（主因分层：可行动 > 环境事实 > 其余） | `KHY_FAILURE_ATTEMPT_TIERS` |
| W7 | 改 `src/services/tool/toolUseLoopCore.js`（逐字相同旁白折叠为一条 + 如实标出合并数） | `KHY_OUTCOME_HINT_DEDUP` |
| **W8** | 新增 `src/services/cliErrorDescriptor.js` 的失败人话化段（`humanizeFailure` / `composeHuman` / `humanTextEnabled`）；改 `src/services/gateway/aiGateway.js`（网关 content 墙的人话化）+ `src/cli/aiGatewayGenerateHelpers.js`（CLI 墙条目的人话化） | `KHY_FAILURE_HUMAN_TEXT` |
| **§7.9 安全** | 改 `src/services/gateway/cliFailureEnvelope.js`（信封 `cause.detail` **源头脱敏**）+ 改 `src/cli/aiGatewayGenerateHelpers.js`（失败墙条目 **源头脱敏**） | 无（**修补既有漏洞**，非行为门） |
| 登记 | 改 `src/utils/flagRegistry/index.js`（8 个门全部登记，default-on） | — |

**W8 说明**：截图里最刺眼的是**英文机器串**直出用户界面 ——
`通道: OpenCode Zen (401) [auth] — {"type":"error","error":{"type":"AuthError","message":"Missing API key."}}`
与墙行里的 `Missing API key.` / `Kiro IDE unavailable`。
W8 让这些位置**转述成中文人话**（实测：`通道: OpenCode Zen (401) [缺少 API Key]: 该通道尚未配置 API Key，请运行 ai config 配置该通道的 API Key，配好即可继续`），
门 `KHY_FAILURE_HUMAN_TEXT` 关 → 逐字节回到今日的英文机器串（实测已验）。
三个消费点（信封首屏 / CLI 墙 / 网关 content 墙）**共用同一个门与同一个合成器** `composeHuman`，
故三者不可能各说各话；`composeHuman` **只输出 `label/reason/fix`**，从不输出 `raw`（原始串可能含密钥）——
即人话化本身**不构成新的泄密面**。

### 7.9 安全补正（复核发现，本轮引入的越界 + 被暴露的既有漏洞）

**发现**：W1 把信封首屏接到 TUI 失败路径后，实测同一份含 `sk-proj-abcdefghijklmnop`
的失败数据 —— **HEAD 版 `finalResponse` 含明文 key = false，本轮新版 = true**（首屏与展开层两处都带出）。

**根因比 W1 更深一层**：`cliFailureEnvelope` **此前完全没有脱敏**。
REPL 路径之所以一直安全，是**巧合** —— 那条路径的失败墙**恰好**会流经
`resolveFriendlyFailureMessage → sanitizeCause`（脱敏单一真源）；而**信封首屏本身**
（`cause.detail` 直接来自上游原始错误串）**从未脱敏**。
W1 绕过了那道巧合兜底，把「信封原样透出」带到了 TUI ⇒ 既有漏洞被**扩大**到新路径。

**修法（两处源头，不是消费点打补丁）**：

| 位置 | 改动 | 覆盖 |
|---|---|---|
| `cliFailureEnvelope._pickPrimaryCause` | `detail` 字段经 `_redactDetail()` 脱敏（复用 `honestFailureReason.sanitizeCause` —— 既有脱敏单一真源，与老墙路径**同款**口径） | 信封首屏 + `cause.detail`（**同时修掉 REPL 路径的既有漏洞**） |
| `cli/aiGatewayGenerateHelpers._formatGatewayFailureDetails` | 墙条目经 `_redactWallEntry()` 脱敏（同一真源） | 失败墙（展开层） |

**为什么修在源头**：一次修，**两条路径都安全**，且未来新增消费点**默认安全**（纵深防御：越靠近源头越不可能漏）。
两处都带**兜底**：脱敏叶子不可用时，本地正则至少抹掉常见密钥形态（宁可少脱一点，也**不泄密**）；
异常路径回落**绝不泄密**的占位串（不是原文）。

**回归**：`tests/services/failureSecretRedaction.test.js`（6 例）钉死「任何用户可见的失败文案都不得含明文密钥」，
且断言**脱敏 ≠ 抹掉**（通道名 / 状态码 / 真因语义仍在）。

### 7.10 复核指出的其余偏差（已逐条改正）

| 偏差 | 性质 | 处置 |
|---|---|---|
| `KHY_PROMPT_ROUND_UNPOLLUTED` 登记了却**无消费点**（W2 剥离无条件生效，无法按 §4.0 回退） | 门控不完整 | **已接线**：新增 `_unpollutedEnabled(env)`，`priorUserTextsFrom` 与 `countRound` 的剥离**均**受该门控制；实测门开 `1→2→3→4`、门关 `1→2→2→2`（今日逐字节行为）；并补 3 条门控断言 |
| §7.6 称 `check-repo-layout` 「唯一红 `extension-id-hardcode`」 | 文档与实测不符（实为 4 个 error） | **已改正**：§7.6 改为逐个列出 4 个 finding + 各自的时间戳/位置归属（全部既有），并补上此前漏列的 `check-change-safety --changed`（exit 1，唯一 error 是 `changed-count-error`：工作树 1165 个改动文件） |
| §7.5 称「末组不被腰斩」已达成 | **实测未达成** —— 220 字上限套到列表上仍会腰斩末行（切成「Fre…」） | **已改正（代码）**：多行墙改为**按行保完整**（单行不腰斩；超 12 行则**整行丢弃**并如实标出丢了多少行）；单行散文沿用旧的总长上限。补 2 条断言（「末行完整」「整行丢弃并标数」） |
| `upstreamTruthLabel.js` 一处注释与 `function _errField(body)` 被合并到同一行 | 编辑痕迹（换行丢失） | **已改正** |
| `honestFailureReason.js` 注释把 `sk-svcacct-` 误改为 `sk-proj-` | 无关改动（B3 偏差） | **已改正**（改回原词） |
| 本轮在仓库根留下 `-p` 空目录与 `.backend-node-tests.log` 空文件 | 自身污染 → 令 `root-junk` 由 6 变 7 | **已主动清理**（回收站语义，可恢复）；`root-junk` 计数回到 6，`layer-registry` 红随之消失 |

### 7.4 轨迹复盘结果（真实截图那一轮，逐条判据）

```
══════ 截图首轮：上游额度用尽 ══════
⚠ 本次请求未能完成 —— 通道被限流
[RATE_LIMITED]
通道: OpenCode Zen (429) [network] — {"type":"error",...FreeUsageLimitError...}
→ 降低并发、别连发
→ 稍等几分钟待限流窗口重置后重试

真实失败原因:
- kiro [unavailable]: Kiro IDE unavailable
- cursor [unavailable]: Cursor IDE unavailable
- trae [unavailable]: Trae IDE unavailable
- OpenCode Zen +1 个适配器 [上游 FreeUsageLimitError]: Free usage limit reached. Free…

输入「继续」重试；额度按出口 IP 计，重试无用；请等配额恢复，或 /model 换用付费/其它通道。
```

| 判据 | 修复前 | 修复后 |
|---|---|---|
| 机器码（信封首屏在场） | ✗ 无 | ✓ `[RATE_LIMITED]` / `[AUTH_FAILED]` |
| 双标签「具体原因：真实失败原因」 | ✗ 有 | ✓ 无 |
| 失败墙保留换行（不再压扁） | ✗ 一行 | ✓ 4 行完整 |
| 末组适配器不被腰斩 | ✗「cursor [unavail…」/「Fre…」 | ✓ **末行完整保留**（超 12 行则整行丢弃并标出丢了多少行） |
| 主因是真因（不是 IDE 噪音） | ✗ kiro | ✓ OpenCode Zen (429) |
| 可执行建议（非只说「继续」） | ✗ 只有通用「继续」 | ✓ 带额度/配 key 方向 |
| **失败文案不外泄明文密钥** | ✓（旧墙**侥幸**被兜住） | ✓ **源头脱敏**（信封 + 墙两处；顺带修掉 REPL 路径的既有漏洞） |
| 轮次计数（连发 4 次同款） | ✗ 1/2/**2**/**2** | ✓ **1/2/3/4**（门关 → 回到 1/2/2/2） |
| 并行旁白（3 路 webSearch） | ✗ 同一句 ×3 | ✓ 三句各异 |

### 7.5 新增测试（红→绿证据链）

| 文件 | 覆盖 | 跑法 | 结果 |
|---|---|---|---|
| `tests/services/toolUseLoop.failureEnvelopeWiring.test.js` | W1（含「上游确实渲染出信封」对抗前置 + 门关逐字节回退） | jest | 7/7 |
| `tests/services/repeatedPromptRounds.unpolluted.test.js` | W2（含「混装形态确实不相似」对抗前置 + **门控双向**） | **node:test** | 13/13 |
| `tests/services/toolUseLoop.outcomeNarrationOccurrence.test.js` | W5/W7 | jest | 7/7 |
| `tests/services/failureWall.formatting.test.js` | W3/W4/W6（含「末组不被腰斩」「整行丢弃并标数」） | jest | 22/22 |
| `tests/services/failureSecretRedaction.test.js` | **§7.9 安全**（失败文案不得外泄明文密钥） | jest | 6/6 |
| `tests/services/gateway/upstreamFailureHumanize.test.js` | **W8**（失败人话化 + 门控双向） | **node:test** | 38/38 |
| `tests/services/cliErrorDescriptor.machineCodeInvariant.test.js` | 机器码不变式 + W8 人话化不碰机器侧（H × T 四组合） | jest | 7/7 |

**合计新增 6 个测试文件、100 例，全绿。**

> ⚠ 跑法提醒：`repeatedPromptRounds.unpolluted` 与 `gateway/upstreamFailureHumanize` 用
> **`node:test`** 语法（`jest.config.js` 按约定自动忽略 node:test 文件）→ 必须 `node --test` 跑；
> 其余 4 个是 jest 套件 → `jest` 跑。合并跑会少算 51 例。

### 7.6 回归与守卫

| 项 | 结果 |
|---|---|
| 引用了被改模块的**全部**套件（27 套） | **405 例全绿**（4 例 skipped 为既有） |
| `check-agent-rules.js --changed` | **0 error**（7 warning，全为既有） |
| `check-gov-rules.js` | 通过（GOV-MOD-004 / GOV-TOOL-004/005/006） |
| `check-copyright-readiness.js` | **0 error** |
| `check-no-emoji.js` | **0 error** |
| `arch:god`（上帝文件门） | exit 0 —— 新增文件 77 / 129 行；`toolUseLoopCore.js` 本就在**既有**上帝文件清单上（HEAD 10794 → 本轮 10876，**既有**超限，非本轮新增） |
| `check-repo-layout.js` | **4 个 error，全部既有**（见下方归属表）；`docs-index-complete: 0`（本文已登记）；`entry-buffer` 2470→**2378**（改善） |
| `check-change-safety.js --changed` | **exit 1**，唯一 error 是 `changed-count-error`（工作树共 **1165** 个改动文件，远超低成本模型可审的量级）——由**本轮之前**的既有脏树造成，非本轮引入 |
| `src/**/*.test.js`（node:test） | 6949 pass / 2 fail → **两者均为 CPU 竞争导致的沙箱 200ms 预算超时**（该套件自身头注已写明此敏感性），**单独复跑 30/30 全绿** |
| 全量 jest | 64 套失败 → **全部为既有环境问题**（`string-width` ESM 转换、`@jest/globals` 越界等），与本轮改动无交集；**对照基线复跑确认失败集合一致**（见 §7.7） |

**`check-repo-layout` 4 个 error 的归属**（逐个核实时间戳/位置，均**非本轮引入**）：

| finding | 内容 | 归属 |
|---|---|---|
| `root-whitelist` | 5 个白名单外说明性文件（`.tmp-docs.txt` / `.tmp-tools-diff.txt` / `.tmp-wr.txt` / `gen-scan.txt` / `tmp_log_mobile_err.txt`） | **既有**：mtime 10-30 17:25 ~ 10-31 02:07，均早于本会话 |
| `root-shadow-dir` | `.khy` / `.khyos` | **既有**：`.khy` mtime 11-01 10:42、`.khyos` 创建于 10-27，均早于本会话 |
| `root-junk` | 6 个临时/事故残留 | **既有**：同上（同一批文件，10-30 ~ 10-31） |
| `extension-id-hardcode` | `cli/handlers/phone.js:63` 硬编码拓展 id | **既有**：本轮未触碰该文件 |

> 本轮**曾**在仓库根留下两个自身残留（`-p` 空目录、`.backend-node-tests.log` 空文件），
> 已被本轮**主动清理**（回收站语义，可恢复）——即上表 `root-junk` 的计数由 7 回到 6。

### 7.7 与基线的对照（防「把既有红算成我的」）

用 `git stash push` **只暂存本轮源文件**改动，跑同一套件取得**基线**失败集合，
再与改动后的失败集合逐条比对 —— **两者完全一致**，故既有失败**均非本轮引入**。

实测的两处对照（同名同数）：

| 套件 | 基线（改动暂存） | 改动后 | 判定 |
|---|---|---|---|
| `tests/toolUseLoop.intentGate.test.js` | **3 failed**（`applies ultrawork model override…` / `keeps explicit chat preferredModel…` / `force override replaces explicit chat preferredModel…`） | **同样这 3 个、同名同数** | **既有失败**（与本轮无关：它断言的是 `preferredModel` 覆盖，与失败墙/轮次/旁白无交集；直连复跑该断言**行为正确** → 属套件内 env 隔离/顺序问题） |
| `src/services/domain/maintenance/evoEngine/hostPatcher.test.js` | 单独复跑 **30/30 全绿** | 全量并发时 2 fail（`Script execution timed out after 200ms`） | **环境性**：该套件自身头注已写明「沙箱默认 200ms 预算，并行 CPU 竞争下会超时」，**单独复跑即绿** |

同时基线复跑确认缺陷仍在（轮次序列 `1 → 2 → 2 → 2`），改动后为 `1 → 2 → 3 → 4`。

**全量 jest 的 64 套失败**经逐一定位，全部属**既有环境问题**，与本轮改动无交集：
- `string-width` / `strip-ansi` 的 **ESM 转换**失败（`Cannot use import statement outside a module`）——
  命中 `tests/diskCleanup.test.js` 等，**本轮未触碰**这些模块；
- `@jest/globals` 越界（`node --test` 跑 jest 套件的**harness 错配**，非真实失败）；
- `hostPatcher` 的 200ms 沙箱预算（并发竞争）。

**引用了本轮被改模块的全部套件（23 套 / 350 例）单独跑：全绿。**

### 7.8 本轮**不做**的事（划界）

- 不改 `RUNTIME-005` 的规则文本（它没说错）。
- 不改 `cliFailureEnvelope.js` 的**契约**（`[DESIGN-ARCH-114]` 已冻结）——本轮改的是**主因选取**（分层）。
- 不删旧散文墙（降级为展开层，信息不丢）。
- 不 bump 工程版本（B7：MINOR/MAJOR 须人点头；本轮是 PATCH 级修复）。
- **不 commit / push**（R1 分支纪律）——改动留在工作树，由人裁决。

---

*本文 §0–§6 是**计划**，§7 是**实施记录**。落地顺序与门控见 §4.8，每波验收门见 §4.9，
实测结果与偏差见 §7。本轮已完成 W1–W7 七波（含 W7 兜底），状态 `partial`：
代码已落地且红→绿可复现，但**尚未经真机 TUI 实跑复核**，也**未提交**。*
