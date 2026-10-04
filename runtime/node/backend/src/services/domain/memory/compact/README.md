# compact — 对话压缩的提示模板与编排器（D2 功能单元）

一句话：把「上下文窗口快满了」这件事变成一次**可编排、可测、不 call 模型**的纯计算——
`prompt.js` 出模板与字符串整形，`index.js` 决定切在哪、留多少、要不要压。
模型调用与 transcript 落盘归调用方（`index.js` 头注释原话：*The orchestrator does NOT call the AI itself*）。

清单：`khy.module.json`（`domain` / `mayDependOn` / `fanIn` / `lifecycle.stage` 四字段被
`npm run check:layout` 的 entry-buffer 规则读取；本单元的 D2→D1 边按偏差登记，不写白名单）。

## 逐成员

| 文件 | 角色 | require | 同名测试 |
|------|------|---------|----------|
| `prompt.js` | 纯模板/纯字符串叶子：no-tools 首尾包裹、全量与增量两套 9 段式模板、锚定式（增量更新）模板、`<analysis>` 草稿剥离与 `<summary>` 解包、续会话用户消息拼装 | 零 require（连 path 都不吃） | `prompt.test.js` |
| `index.js` | 编排与算术：全量切分（保留最近 N 条逐字）、增量窗口切分、应用压缩结果、变体选路、是否需要压缩的 token 预算判定 | `./prompt`（单元内 D2）、`../../../../utils/simpleTokenEstimate`（D3）、`../../../contextProfile`（**D1**，try 内惰性 require，缺失回退未钳制 reserve） | `index.test.js` |

## 消费者（实测 fan-in = 1）

`services/backend/src/services/compact/index.js` —— D1 再导出壳。

**如实记录一件不太好听的实测事实**：那个壳在 `src/` 下**零消费者**，本单元**不在活的 /compact 通路上**。
运行时压缩走 `services/contextCompressor.js` 与 `domain/query/query/{compactionStages,compactPipeline}.js`；
`src/cli/compactInstructions.js:30` 还明文写着「不改道去 `services/compact/*` 那套 `getCompactPrompt` 通路」。
本单元目前的真实读者只有两份测试（`tests/promptLearningRules.test.js` 与 jest 方言的
`tests/services/compactShouldCompactReserve.test.js`）。
去留属规则 7「删除先报部位」与人的裁决范围：**本单元本次只补测试与建档，不做任何删除或改名动作。**

## 契约（每条都对应命名测试）

1. **两条 floor 各管一件事**：全量压缩要 `messages.length >= MIN_MESSAGES_FOR_COMPACTION`（=20），
   增量压缩要 `length >= windowSize + 5`；不满足者返回 `prompt: null` + `metadata.skipped: true`，
   并把**全部**消息原样交回（`toPreserve`/`remainingMessages`），绝不静默丢消息。
   → `exposes the documented compaction constants`、
   `sessionMemoryCompact skips under the floor and keeps everything`、
   `sessionMemoryCompact at exactly the floor compacts`、
   `microCompact skips while shorter than window + 5`、`sessionMemoryCompact tolerates a null message list`
2. **切分无损且可复原**：`toSummarize.concat(toPreserve)` 与入参逐元素全等；切点 = `length - preserveRecent`，
   默认留 10 条、可注入覆盖；过度保留（`preserveRecent >= length`）时前段为空、全文逐字保留；
   增量窗默认 10 条。
   → `sessionMemoryCompact splits at length - preserveRecent`、
   `sessionMemoryCompact honours a custom preserveRecent`、
   `sessionMemoryCompact over-preserving keeps the whole transcript verbatim`、
   `microCompact summarizes only the oldest window`、`microCompact defaults its window to 10`
3. **压缩结果是「一条 user 消息 + 原文尾部」**：`applyCompaction` 产出的 `out[0]` 是
   `role:'user'` + `_meta.type:'compaction_summary'`，尾部逐字保留；**没有**保留尾巴时
   绝不写「Recent messages are preserved verbatim.」这句假承诺；transcriptPath 与 suppressFollowUp
   由编排器透传给模板。
   → `applyCompaction puts a user summary message first, then the preserved tail`、
   `applyCompaction with no preserved messages does not claim verbatim tail`、
   `applyCompaction threads transcriptPath and suppressFollowUp through`
4. **变体选路**：`getCompactionPrompt(messages, 'partial')` 走增量模板，缺省走全量模板；
   该函数**不**把消息体嵌进 prompt（模板只教格式，transcript 由会话上下文自带）。
   → `getCompactionPrompt picks the variant`
5. **token 预算用 SSOT 原子**：逐条消息 `simpleTokenEstimate(content)`（chars/4 上取整），
   非字符串 `content` 走 `JSON.stringify` 分支——即仓内已知的「`.content` 可能是字符串也可能是 block-array」
   形状在此**不抛**；空 messages/null → `{needed:false, urgency:'none', estimatedTokens:0}`；
   缺 `content` 的消息按空串的 JSON 字面量 `'""'` 计 1 token（轻度过计，不误伤判定）。
   → `shouldCompact is silent on an empty transcript`、
   `shouldCompact estimates string content at ceil(chars/4) per message`、
   `shouldCompact survives the block-array content shape`、
   `shouldCompact counts a content-less message as the empty JSON literal`
6. **reserve 必须被钳制**（本单元唯一的跨层依赖，也是它存在的理由）：默认 4096 的输出预留
   经 `contextProfile.deriveReserveTokens` 压到窗口的 30%（8k 窗口 → 2400），
   否则固定预留吃掉半个上下文、压缩在错误时点触发；大窗口不受影响。
   阈值：usage ≥ 0.9 → `'now'`，≥ 0.7 → `'soon'`，其余 `'none'`。
   → `shouldCompact escalates urgency at 0.7 and 0.9 of the available budget`
7. **no-tools 包裹是首尾双向的**：三套模板（全量 / 增量 / 锚定）都以 `NO_TOOLS_PREAMBLE` 开头、
   以 `NO_TOOLS_TRAILER` 结尾——放在最前是因为模型会先看到它再看到缓存的工具定义。
   两套对话模板共用 Claude Code 的 9 段式契约，只在「摘要范围」上分岔（全量 vs「earlier 已保留」）。
   → `both variants are wrapped by the no-tools preamble and trailer`、
   `the two variants differ in scope wording and share the 9-section contract`
8. **空白附加指令等于没有附加指令**：`customInstructions` 经 `.trim()` 判空，
   `''`/`'   '`/`'\n'`/undefined 都**不**注入 `Additional Instructions:` 空块。
   → `customInstructions are appended verbatim only when non-blank`、
   `anchored prompt joins context lines and honours customInstructions`
9. **`<analysis>` 是草稿纸，不进上下文**：`formatCompactSummary` 先剥 analysis、再把
   `<summary>` 解包成 `Summary:\n<trim 后的正文>`，并把连续空行收敛成一段；无标签的原样回复
   只做 trim 不报错；标签前后的模型散文保留。
   → `formatCompactSummary drops the analysis scratchpad and unwraps the summary`、
   `formatCompactSummary passes an untagged model reply through, trimmed`、
   `formatCompactSummary keeps model prose around the tags`
10. **续会话用户消息的三个从句各自独立门控**：抬头恒定，transcriptPath / recentPreserved /
    suppressFollowUp 只在真值为真时追加，任一 falsy（`''`/null/0/false）都不改变文本。
    → `getCompactUserMessage builds the continuation header with the formatted body`、
    `getCompactUserMessage optional clauses are each independently gated`、
    `getCompactUserMessage falsy options omit their clause`
11. **锚定式压缩是「更新」不是「重写」**：有 `previousSummary` 时把上文包进 `<previous-summary>` 并要求
    「保留仍成立的、删掉陈旧的、并入新事实」；没有则明示新建。上下文行按 `\n` join 追加，空数组不追加该段。
    → `anchored prompt starts fresh when there is no previous summary`、
    `anchored prompt echoes the previous summary inside its tag pair`、
    `anchored prompt joins context lines and honours customInstructions`

## 已知边界（现状契约，由测试钉住，**不是**「已修」声明）

- `formatCompactSummary` 对非字符串入参抛 `TypeError`——契约要求调用方先取到模型文本，本层不做 block-array 解包。
  → `formatCompactSummary requires a string (no content-block coercion here)`
- `getAnchoredCompactPrompt` 的 `context` 默认值只对「键缺失/undefined」生效，显式 `null` 会命中 `.length` 而抛。
  → `anchored prompt defaults context only for an absent key`
- 标签重写用的是**非全局**正则：模型若吐出第二对 `<analysis>`/`<summary>`，后一对会以原始标签残留在摘要里。
  → `formatCompactSummary only rewrites the first tag pair of each kind`
  这是现状，未在此改动集里放宽（放宽会改变输出字节，属另一件事）。
- `index.js` 的 `ESTIMATED_TOKENS_PER_MESSAGE` 是未被引用也未导出的死常量；
  `prompt.js` 的 `getAnchoredCompactPrompt` 在单元内无人调用。二者都留待规则 7 的部位清单与人的裁决，
  本单元不做静默清理。

## 测试怎么跑

```bash
cd services/backend
node --test src/services/domain/memory/compact/index.test.js \
            src/services/domain/memory/compact/prompt.test.js
```

共 34 例、0 skip、零真 IO、不 call 模型、不碰工作树。
另有仓级 `tests/services/compactShouldCompactReserve.test.js` 是 **jest 方言**（`describe`/`expect`），
本便携环境未安装 jest（`node_modules/.bin/jest` 是悬空 shim），用 `node --test` 跑它会 ReferenceError；
其 reserve 钳制断言已由上面 `index.test.js` 以同一算术复现，所以「本环境跑不了那份」不构成本单元的覆盖缺口。
