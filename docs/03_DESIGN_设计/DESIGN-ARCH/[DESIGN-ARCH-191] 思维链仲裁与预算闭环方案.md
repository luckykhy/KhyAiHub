<!-- IMPL-STATUS: done -->
# [DESIGN-ARCH-191] 思维链仲裁与预算闭环方案

> **状态**：L1 / L2 / L3 三档均已实现并通过验收（2026-10-15）。三档各自独立 env 门控，**缺省全部关闭**，关闭时行为与改动前逐字节一致。
> **范围**：新增 `runtime/node/backend/src/services/reasoning/cotArbiter.js`（纯叶子、零 IO）；`runtime/node/backend/src/services/tool/toolUseLoopCore.js`（**纯追加，0 删除**）；新增测试 `runtime/node/backend/tests/services/cotArbiter.test.js`（49 例）
> **上游依赖**：`services/autoReasoning.js`（档位解析，L1 的输入）；`services/tokenBudget.js`（本方案的**house pattern 模板**，非功能依赖）
> **调研指针**：[DESIGN-ARCH-151] TUI 思维链折叠存储与显示减负方案；[DESIGN-ARCH-152] 聊天气泡布局与思考过程渲染方案；[DESIGN-ARCH-161] 任务执行时延与质量优化方案；[DESIGN-ARCH-166] 静默失效与真源漂移四例收敛方案
> **模板合规**：按 [DESIGN-SOURCING-001] §3 B-P2 体例逐字段填写。本方案的 L1 判据来自本仓既有信号与公开研究成果两项，**§10 据实列出**（不适用项：无）

---

## 0. 一句话结论

Khy OS 里的思维链**已经是完整的一等公民，但全程只读**——解析、跨轮回传、展示三样齐全，唯独没有任何一个点对它做过决策。本方案补上决策层，分三档交付：

| 档 | 手段 | 本轮 |
|---|---|---|
| **L1** | 每轮闭环调节思考预算 | ✅ **已实现** |
| **L2** | 带判据的截断续写（Anthropic 唯一合法的改向路径） | 规格已定，未实现 |
| **L3** | 注入 / 删改 / 前缀强制（仅无签名 provider） | 规格已定，未实现 |

L1 不改模型行为之外的任何东西，缺省关闭，关闭时逐字节不变。

---

## 1. 现状实证（file:line 可复核）

### 1.1 思维链已经打通了哪四层

| 层 | 能力 | 位置 |
|---|---|---|
| 请求前·预算 | `resolveEffort()` 关键词判 low/high/max；`effortToParams()` 映射各家参数 | `services/autoReasoning.js:48,90` |
| 请求前·兜底 | `thinkingFloor` 防止跌破最低档 | `services/tool/toolUseLoopCore.js:2480-2487` |
| 协议 | `reasoning_content` / `thinking` / `reasoningParts` 三家归一，JSON 与流式双路一致 | `services/gateway/adapters/_protocolPipeline.js:280,411,683` |
| 跨轮回传 | `thinkingBlocks` 原样回传为 assistant 轮首块，注释明写"保持 extended thinking 连续" | `services/contentBlockUtils.js:95,109`；`services/tool/toolUseLoopCore.js:9228-9233` |
| 展示 | TUI 折叠存储与渲染减负 | [DESIGN-ARCH-151]、[DESIGN-ARCH-152] |

### 1.2 已经存在一个 token 预算调控器

`services/tokenBudget.js` 是**硬预算 governor**，且它确立了这个仓做"决策类叶子"的 house pattern：

- 纯叶子 · 零 IO · 确定性 · fail-soft · env 门控（文件头 `:1-22` 自述）
- **壳层在 `onCost` 处累积花费，在每轮顶部、下一次 `chat()` 之前调 `assessBudget()` 决定是否硬停**（`:11-14` 自述；接线见 `toolUseLoopCore.js:1957,2068`）
- 门控即配置：`KHY_TOKEN_BUDGET` 同时是上限和开关，未设/0 ⇒ 完全禁用、逐字节回退
- 防呆：每个函数都是全函数，最坏情况退化为「禁用」，**绝不退化为误动作**（`:21-22` 自述）

L1 照此同构，不发明新范式。

---

## 2. 缺口诊断

| # | 缺口 | 实证 |
|---|---|---|
| **D1** | 预算是一次性决策，**无反馈闭环** | `toolUseLoopCore.js:2472-2474` 注释明写"Only on first iteration; follow-ups keep same tier"。模型思考 32k 绕五轮才收敛，与深思 1k 直接拿到答案，走同一条路 |
| **D2** | **无 provider 能力区分** | `contentBlockUtils.js:109` 以 `tb.signature` 作为**有效性前提**过滤，而非**不可篡改标记**。签名块内容一改即回传 400 |
| **D3** | 只读不用 | 循环内唯一读思维处是 400 字符长度门（`:5161-5177`），且该门测的是 `strippedReply`；注释明确原生思维模型走独立 `thinkingBlocks` 通道、不并入 `reply` |
| **D4** | 69% 的 CoT token 生成于答案定型之后，这个事实完全未被利用 | 无任何代码引用该结论 |

---

## 3. 方案总纲

### 3.1 能力矩阵（设计的硬约束）

思维链能否被改，**先由 provider 形态决定，不由我们想不想决定**：

| Provider | thinking 形态 | 改内容 | 截断续写 | steering |
|---|---|---|---|---|
| Anthropic | 签名块 | ✗ | ✓（`max_tokens` 未闭合时） | ✗ |
| DeepSeek / GLM | 纯文本 `reasoning_content` | ✓ | ✓ | ✗ |
| OpenAI 兼容 | 纯文本 | ✓ | ✓ | 自部署 ✓ |
| 本地 vLLM | 纯文本 | ✓ | ✓ | ✓ |

这张表是 `autoReasoning.effortToParams`（`:90-118`）既有 provider 分支的自然延伸——那处在回答「预算怎么表达」，本方案回答「这个 provider 允许改到什么程度」。

### 3.2 为什么禁止「静默分叉」

同一套注入策略在 GLM 上默默生效、在 Claude 上被静默丢弃，会产生极难排查的行为不一致。因此能力探测必须**显式查表、随决策一起返回**，不允许用 try/catch 兜底掩盖。`resolveCapabilities()` 是唯一真源。

---

## 4. L1 规格（本轮实现）

### 4.1 一句话

把「第一轮定死档位」变成「每轮根据上一轮实际表现重新定档」，**只调预算，不动内容**。

### 4.2 契约（照 `tokenBudget.js` 同构）

```
resolveGate(env)        -> { enabled, floor, ceiling, maxAdjust }
observeRound(input)     -> signal        // 壳层每轮累积，纯提取不决策
nextTier({...})         -> { tier, action, reason }   // 纯函数决策
```

**信号源**（全部取自循环里已存在的数据，**不新增 IO**）：

| 信号 | 来源 | 含义 |
|---|---|---|
| `thinkingChars` | `aiResult.thinking` | 本轮思维文本长度 |
| `thinkingTokens` | `aiResult.thinkingBlocks` 文本长度估算 | 跨轮可比的结构化量 |
| `stopReason` | `aiResult.stopReason` | `'length'` 表示**思维被截断、没想完** |
| `toolCount` | 本轮工具调用数 | 是否在推进 |

### 4.3 判据（v1 只有两条，都可从上面直接读出）

| 动作 | 判据 | 依据 |
|---|---|---|
| **升档** | `stopReason === 'length'` | 思维没想完就被砍，降档只会更糟 |
| **降档** | 连续 `stagnationRounds`（缺省 2）轮 `toolCount` 不变 **且** `thinkingTokens` 未下降 | 反复想、反复不动 —— 正是 D4 那 69% 的形态 |
| **不动** | 其余全部 | 缺省即不动 |

**不做**的事：不按"任务复杂度"调（那由 `autoReasoning` 的关键词档负责，重复判断）；不做跨轮振荡（每次尝试最多调 1 档，且受 `floor`/`ceiling` 夹紧）。

### 4.4 挂载点

`toolUseLoopCore.js:2494` 之后**追加**一个块，处理 `iteration > 1`。`:2474` 的首轮块**一字不动**——首轮仍是关键词定档，L1 只管后续轮。

```js
// 门 KHY_COT_L1（缺省关）。关 → 整个块跳过，effectiveChatOpts 逐字节不变。
if (iteration > 1) { /* observeRound → nextTier → Object.assign */ }
```

### 4.5 零回归论证

1. 缺省 `KHY_COT_L1` 未设 ⇒ `resolveGate().enabled === false` ⇒ 新块整体跳过；
2. 新块是**纯追加**，不修改 `:2474` 既有块的任何语句；
3. 门内全部 `try/catch` fail-soft，异常回退为「不调整」；
4. `floor` 默认取 `null`（不覆盖 `thinkingFloor` 的既有兜底）。

合起来：关闭时 `effectiveChatOpts` 与改动前逐字节相同。

---

## 5. L2 规格（已实现）

**Anthropic 上唯一合法的改向路径**。签名块内容不可碰，但 `stop_reason: max_tokens` 时**未闭合的 thinking 可以带原样前缀合法续写**。

现状：`toolUseLoopCore.js` 的 length-truncation auto-continue 已是这个动作，但它是**盲续一次**，注入固定文案。

改进：读上一段 thinking 的**尾部**（默认窗口 400 字），判断是「没想完」还是「想岔了」——前者照旧续写，后者把 `derailed` 标记写进该轮信号，让 L1 在下一轮**降档**而非按截断升档。

判定顺序（确定性、无模型调用、无 IO）：**回撤标记 → 未闭合代码块 → 悬空小句 → 句子边界兜底为「没想完」**（延续现状是两种默认里更安全的那个）。只看尾部是有意的：模型中途质疑自己后又恢复的轨迹，不该被误判为跑偏。

> **实现期修掉的一个真 bug**：中文回撤词表把「实际上」写成了「其实」——同音不同字，导致 `实际上哈希表在这里行不通` 这类典型跑偏句**判不出来**。由单测用例暴露。另把裸 `no` 从词表移除（"there is no other option" 会误判）。

## 6. L3 规格（已实现，含一处载体约束）

仅对无签名 provider 开放。**硬护栏**：只允许从冻结的 `NUDGE_WHITELIST`（`narrow` / `verify` / `replan` / `finish`）按键取词，**代码里不存在任何调用方自带文本的通路**——这正是 §10 那条实测（模型几乎察觉不到思维链被改）所要求的。

### 6.1 载体约束（实测得出，非简化）

无签名的 `reasoning_content` **当前根本不会回传给模型**：`contentBlockUtils.buildAssistantContent` 只转发**带 signature** 的 thinking 块，其余一律丢弃。所以循环真正控制、且确实会发出去的载体只有**续写消息**。L3 因此作用在续写消息上，三种操作落为「续写前缀拼什么」：

| 原操作 | 在现架构下的落法 |
|---|---|
| 注入 | 白名单键追加到续写消息尾部 |
| 前缀强制 | 同上，且续写消息整体作为前缀 |
| 删改 | 对**已回传**的 thinking 生效；unsigned 通道当前无载体，故不可达 |

**未知 provider 一律按签名契约处理**（`canRewrite=false`），宁可不做也不冒静默分叉的风险——见 §3.2。单测对此有专门断言。

## 7. L4（远期）

logit bias / activation steering，仅自部署模型可行。已知结论：思考长度是一个可分离的线性方向，单个 steering vector 即可显著压缩（§10）。工程量大，列为 Phase 3，不在当前两轮承诺内。

---

## 8. 验收标准

| # | 标准 | 判据 |
|---|---|---|
| A1 | 零回归 | 门关闭时 `nextTier` 恒返 `{tier: baseTier, action:'hold'}`；`effectiveChatOpts` 逐字节不变 |
| A2 | 升档判据 | `stopReason==='length'` → 升一档，且受 `ceiling` 夹紧 |
| A3 | 降档判据 | 连续 N 轮 `toolCount` 不变且 thinking 未降 → 降一档，受 `floor` 夹紧 |
| A4 | 不振荡 | 单轮尝试最多调 1 档；每轮最多调整 `maxAdjust` 次 |
| A5 | fail-soft | 任意非法入参不抛异常，退化为 hold |
| A6 | 门控阶梯 | 未设/0/false/off/no ⇒ 禁用 |
| A7 | 守卫 | 三守卫 + `check-gov-rules.js` 全绿；`arch:god` 无新增超限 |
| **A8** | **L2 判定** | 回撤标记 → `derailed`；标记在尾部窗口**之外**则**不得**误判；未闭合代码块/悬空小句 → `unfinished`；无文本 → `unknown`（退回现状盲续） |
| **A9** | **L2 与 L1 的耦合** | `derailed` 信号**压过**截断升档规则 ⇒ 跑偏轨迹走降档，不是升档 |
| **A10** | **L3 白名单闭合** | 垃圾键、`bogus` 的 `defaultNudge`、未知 provider 一律**不产生任何注入文本**；`NUDGE_WHITELIST` 被 `Object.freeze` |
| **A11** | **L3 签名拒绝** | `anthropic` / `claude` / 未知 vendor 在**门开启**时消息仍逐字节不变、`applied=false` |

**效果类指标（需 A/B 对照集，非本轮硬门）**：L1 全程开启后，同任务集 thinking token 总量下降 ≥40% 且任务成功率不降。

**实测（2026-10-15）**：单测 49/49 全绿；`node --check` 三文件通过；`check-change-safety` / `check-agent-rules` / `check-gov-rules` / `arch:god` 均 EXIT 0；主干改动为 **纯新增、0 删除**，三档门缺省全关时 `effectiveChatOpts` 与 `currentMessage` 均不变。

---

## 9. 明确不做的事

1. **不改签名块内容** —— 会导致 400，且无正当收益；
2. **不在 L1 里改内容** —— 调预算与改内容是两个风险等级，混在一起不可回滚；
3. **不用 try/catch 兜底掩盖能力差异** —— 见 §3.2；
4. **不自动 bump 版本** —— 按 B7，功能新增属 T1，MINOR 递增须人明示（`version-mode.js bump --minor --approved-by <批准人>`）。

---

## 10. 依据来源（B6：决策可解释）

### 10.1 外部研究（用于 L2/L3 规格的可行性判断与护栏设计）

| 结论 | 来源 |
|---|---|
| CoT 篡改实测：对思维链做删词/插词/换句后，模型**很少察觉**；即使大幅改动，检出率仍不足 50%；显眼的对照注入（把某句换成"我是个海盗！"）下 R1 仅 42.2% 察觉、GPT-OSS 仅 1.4% | [Current LLMs seem to rarely detect CoT tampering](http://baserates.org/posts/Ywzk9vwMhAAPxMqSW/current-llms-seem-to-rarely-detect-cot-tampering) |
| 多数 CoT token 生成于**答案定型之后**（Qwen3-32B-Think 上 69% 的 CoT token 在 commitment boundary 之后，PSC 阈值下 75%） | [The Detection–Extraction Gap: Models Know the Answer Before They Can Say It](https://arxiv.org/html/2604.06613v1) |
| 截断 CoT 后从前缀重生成、比较答案可复现性，是无需 logprob 的质量信号 | [Reliable Chain-of-Thought via Prefix Consistency](https://lacuna.tiptreesystems.com/work/reliable-chain-of-thought-via-prefix-consistency/wrk_c74a1421ec0d1da07f7ab1d1e8c334bd) |
| 思考长度是激活空间中可分离的线性方向，steering 可压缩（**L4 依据**，本次未实现） | *Activation Steering for Chain-of-Thought Compression*, arXiv:2507.04742（编号来自二手聚合页，落地前须核对原文） |

**D4 的处置即基于第二行**：既然多数思维 token 生成于定型之后，对"反复想但不动"的轮次降档不会损害答案质量——这是 L1 降档判据敢成立的原因。

### 10.2 本仓依据

- `services/tokenBudget.js:1-22` —— house pattern（纯叶子 / fail-soft / 门控即配置 / 最坏退化为禁用）的真源
- `services/tool/toolUseLoopCore.js:2472-2474` —— D1 的原文出处，也是 L1 挂载点选择的依据
- `services/contentBlockUtils.js:86-88,109` —— Anthropic 首块规则与签名前提，D2 的依据
- `services/gateway/adapters/_protocolPipeline.js:280,411,683` —— 三家思维链字段归一，L3 能力矩阵的依据

### 10.3 为什么这套东西人能接住（B6 第 3 条）

L1 的每条判据都只读循环里**已经存在**的变量，没有新增 IO、没有新增模型调用、没有新的外部依赖；关掉它等于什么都没发生。它能改变的是「同一任务花多少 token 思考」，不是「模型答什么」——判据与影响面都可在一轮 A/B 内验证完。
