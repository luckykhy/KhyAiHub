# [DESIGN-ARCH-164] 用户需求理解管线——意图裁决、澄清问询与需求固化

<!-- RULES-REGISTRY: RUNTIME-002, RUNTIME-008, PROCESS-008, PROCESS-014 -->

> **状态**：S1 已落地（2026-09-27 实现，门控默认关；登记 `FEATURE-OWNERSHIP.json`
> `rollout.mechanisms[]` → `requirement-intake-layer`，执行器阶段常量
> `KHY_REQUIREMENT_INTAKE_STAGE='S1'`）
> **范围**：`services/backend/src/cli/aiChatCore.js`（管线装配点）、
> `services/backend/src/services/`（新增 3 个纯叶子服务）、
> `services/backend/src/cli/tui/`（问询 UI 已有，零改动或微改）、
> `apps/ai-frontend/src/views/AIChat.vue`（Web 端问询卡组件）。
> **不改**：`replSession.js` 主干、`aiGateway.js`、`toolUseLoopCore.js`。
> **上游依据**：2026-09-27 双线调研纪要（外部：Claude Code / Cline / Aider / OpenHands /
> LangGraph / ClarifyGPT；内部：五路现有件盘点），要点摘录见 §2，全量纪要见附录 B 来源。

## 0. 一句话结论

khy-os 的需求理解**散件齐全、编排缺席**：`taskScale` / `intentGate` / `clarificationCards` /
`referenceDisambiguation` / `mathSolvePolicy` 五个意图件各自向系统提示词注入指令，互不知晓；
需求五问只活在 CI 存证层（`.khy/feedback/`），运行时对话管线从不产出可回看、可编辑、
执行时可引用的需求制品；Web 前端把 `AskUserQuestion` 协议渲染成只读状态文本，
用户只能干看不能答。本方案不新增第五个意图件，而是新增一个**聚合前置层
`requirementIntakeService`**（五路裁决一次出、单一指令出口），加一个**需求固化制品
`.khy/requirements/<id>.md`**（执行时回灌、收尾时对账），加 **Web 端交互式问询卡**
（复用 TUI `questionCardModel` 数据形状）。全部按 `PROCESS-008` 走 S1 观察者档，
门控 `KHY_REQUIREMENT_INTAKE`（默认关，置 `on` 启用）。

## 1. 需求五问（RUNTIME-008 / 规则 6）

1. **谁用？** —— 通过 REPL/TUI 或 Web 端向 khy-os 提需求、希望「一次说清、少来回返工」
   的终端用户；以及在长任务执行中途发现「AI 做的不是我说的」而无处修正的用户。
   （source: 用户原话「准确的理解用户需求是核心，希望你多调研一下网络资料与开源项目
   看看怎么实现的，然后设计一个方案」）
2. **什么时候用？** —— 用户每轮输入进入 `aiChatCore` 五步管线的**步骤 2（任务规模识别）
   与步骤 3（RAG）之间**：五路意图件聚合裁决一次，之后按裁决结果决定走澄清轮、
   直接执行轮还是降级轮。长任务执行中按需回看固化制品（步骤 5 之后）。
3. **现在的替代做法是什么？** —— 五个意图件各自独立注入（现状即替代做法），
   已实测出问题：同一轮可能同时命中「澄清卡指令」与「消歧指令」，模型收到两份
   互相竞争的问询指引；且没有任何机制保证模型答完澄清后需求被**记住**——
   多轮之后跑偏只能靠用户重申。（source: 内部盘点纪要 §1「各检测件各自独立注入，
   缺一个聚合前置层」）
4. **成功长什么样？** —— 命令 + 期望输出，见 §7 验收判据 A1–A6。核心一条：
   在 REPL 输入「优化一下代码」后，收到的是一张可左右切换的选项卡问询
   （优化什么文件 / 什么指标），答完后 REPL 内出现
   `📋 需求已确认 → .khy/requirements/20260927-xxxx.md（可编辑）`，
   长任务执行中每阶段日志引用该制品，收尾输出「交付 vs 需求」对账。
5. **不做会怎样？** —— 五件各自为政的竞争指令继续随机打架；模糊需求继续
   「猜错方向白跑一轮」；长任务跑到一半偏航只能整轮作废；Web 端用户面对
   只读的「权限确认」文本永远无法回应，只能切回终端。

## 2. 调研结论（外部铁律 → 本仓对应缺口）

> 全量来源 URL 见附录 B；此处只留设计决策级结论，每条注明来源编号。

| # | 外部铁律（出处） | 本仓现状 | 采纳方式 |
|---|----------------|---------|---------|
| L1 | **模式门而非模型猜**：意图/权限用显式状态机裁决，LLM 只在门内活动（Claude Code plan 模式 [1]、Aider 四模式 [6]、Cline Plan/Act [8]） | 五个意图件**并行注入**，无统一裁决状态机 | 聚合器一次算出五路裁决 → 单一 `understandingDirective` 出口，互斥排序 |
| L2 | **结构化选项 + 自由文本兜底**是澄清的标准形态，一次 1–4 题多卡（AskUserQuestion [3]、Cline AgentAskQuestion [12]） | TUI `QuestionPrompt`（755 行）+ `questionCardModel` 已实现该形态；指令源 `clarificationCards` 已就绪 | 复用现有数据形状，聚合器按裁决决定**何时**注入 `clarificationCards` 指令，不重写指令文本 |
| L3 | **澄清是计划阶段的常规步骤，不是异常兜底**（Cline /deep-planning 第 2 步就是「提定向问题」[9]） | 仅「提示词不清」时才触发澄清（`clarificationCards.need` 条件） | 裁决新增 `needPlan` 级：中大型任务且缺验收口径时，即使提示词「清晰」也建议澄清轮 |
| L4 | **需求固化成用户可编辑的制品**：plan 文本 / SPEC.md / implementation_plan.md，好 spec = 点名文件接口 + 声明范围外 + 端到端验证收尾（[4]） | 无任何运行时需求制品；五问只在 CI 存证 | 新增 `.khy/requirements/<id>.md` 制品，字段按「好 spec」三件套设计 |
| L5 | **执行时固化物必须反复可见**：任务列表跨压缩持久 [1]、GoalController 按迭代审计 [16] | 澄清结论只存在于会话历史，压缩后即失 | 每阶段状态广播附带制品引用；收尾强制「交付 vs 需求」对账 |
| L6 | **拒绝也是澄清**：拒绝动作必须带原因回灌（OpenHands `reject_pending_actions` [15]） | 澄清卡「可讨论/自由输入」已有；无「用户答完 → 需求改写」环节 | 澄清答案回灌后由模型**复述改写**需求（含 source 标注）再固化 |
| L7 | **防自答要出处机制**：系统提示明令"ask instead of making assumptions" [13]；本仓规则 6 已有 `source: <用户原话>` 判据 | 该判据只在 CI 层校验 `.khy/feedback/` 存证 | 运行时制品沿用同一判据：需求条目必须带 source（用户原话或澄清答案），无 source 的条目标 ⚠ 由用户确认 |
| L8 | **理解/执行上下文分离**：面试完换新会话执行 spec [4] | 无此分离 | S1 阶段不做会话分裂；把「压缩后回灌」作为最小替代（成本/收益再评估） |
| L9 | **学术评测可做回归集**：ClarifyGPT 三段式（歧义检测→定向追问→改写需求）[19]、ClarifyCodeBench [22] | 无任何澄清质量评测 | 列入 §9 未来工作，不在本期 |

**边界声明**：本方案是「理解**人类**用户」的管线；[DESIGN-ARCH-037] 的需求内源发生器
是「系统**自产**需求」的进化引擎，二者在 `EvoRequirement` 层面可对接（进化需求也应
过同一固化格式），但本文不展开。

## 3. 现状盘点（证据链，均为已核实 file:line）

| # | 件 | 证据 | 现状与缺口 |
|---|----|------|-----------|
| E1 | 任务规模 | `services/taskScale.js`（104 行，7 规则分 small/normal/large）；`aiChatCore.js:457` 调 `_resolveTaskScale` | 骨架在，只产 scale，不产「是否缺验收口径」 |
| E2 | 问候快路径 | `aiChatCore.js:467-582`（`_pureFirstTurnGreeting` + `KHY_GREETING_FASTPATH`） | 与本方案正交：问候直接短路，不进聚合层 |
| E3 | 教学分流 | `aiChatCore.js:587-669`（`intentGate.detectTeaching`） | 正交，聚合层放行 |
| E4 | 澄清卡 | `services/clarificationCards.js`（133 行，复用 `multimodalIntentRouter.assessPromptClarity` 零假阳性判据，注入 6 条选项卡指令） | 判据与指令质量高，但**只有「提示词不清」一个触发面**，且与其他件互不知晓 |
| E5 | 指代消歧 | `services/referenceDisambiguation.js:130`（歧义时提示调 AskUserQuestion）；`aiChatCore.js:872` 接线 | 与 E4 **可同时命中**，两份问询指令竞争，无互斥 |
| E6 | 数学分流 | `services/mathSolvePolicy.js`（264 行，正则 + 确定性代入复核） | 正交，聚合层放行 |
| E7 | 问询 UI（TUI） | `cli/tui/ink-components/QuestionPrompt.js`（755 行多卡 + 多选 + 自动补「可讨论/自由输入」）、纯逻辑 `questionCardModel.js` | **三端最强件**，数据形状 `{questions:[{question,header,options,multiSelect}]}` 作为跨端协议真源 |
| E8 | 问询 UI（Web） | `apps/ai-frontend/src/views/aiChatEventUtils.js:33,293-295` 能识别 `control_request`/`can_use_tool`，但只渲染只读状态文本 | **最大前端缺口**：协议已通、交互缺席 |
| E9 | 需求五问 | `scripts/ci/check-agent-feedback.js:212-223`（`auditFiveQuestions`：<40 字判敷衍、缺 `source:` 判 self-answered） | 判据成熟，**只在 CI**；`.khy/feedback/` 有 87 行范本可参考格式 |
| E10 | 管线装配点 | `aiChatCore.js:446-500`（步骤 1-2 广播）、`:851-859`（澄清注入）、`:872`（消歧注入）、`:1034-1043`（数学） | 五处散装注入是本次收口对象 |

## 4. 方案总图

```
用户输入 ──► 步骤1 初始化 ──► 步骤2 任务规模识别
                                   │
                                   ▼
                    ┌─── requirementIntakeService.aggregate() ───┐
                    │  (S1 纯叶子，一次输入 → 一份裁决)             │
                    │                                            │
                    │  ① greeting    问候短路（复用 textHeuristics）│
                    │  ② scale       small/normal/large（复用 taskScale）
                    │  ③ clarity     清晰度（复用 assessPromptClarity）
                    │  ④ reference   指代歧义（复用 referenceDisambiguation）
                    │  ⑤ acceptance  缺验收口径判定（新，确定性启发式）
                    │                                            │
                    │  → understandingState:                      │
                    │    { route: 'clarify' | 'proceed' | 'plan',  │
                    │      directives: {clarify?|disambiguate?},   │
                    │      needArtifact: boolean }                 │
                    └────────────────┬───────────────────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
        route=clarify          route=plan/proceed      route=proceed
        注入 clarificationCards  注入单一问询指令(互斥)     直接执行
        指令 → AskUserQuestion                                        │
              │                      │                                │
              ▼                      ▼                                ▼
        用户答选项卡 ──► 模型复述改写需求 ──► 需求制品 .khy/requirements/<id>.md
                                              │
                        ┌─────────────────────┼─────────────────────┐
                        ▼                     ▼                     ▼
                  执行中回灌              收尾对账                 用户可编辑
              （每阶段状态引用 id）    （交付 vs 需求 逐条 ✓/✗/⏳）  （改后下轮生效）
```

### 4.1 裁决语义（互斥排序，首个命中即停）

| route | 触发条件（按序判定） | 动作 |
|-------|-------------------|------|
| 短路 | ① 纯问候（既有 `isGreeting`，快路径不变） | 走既有问候管线，聚合器不注入任何指令 |
| clarify | ④ 指代歧义且引用对象唯一性 < 阈值 → **消歧优先**（答不出引用就谈不上需求）；否则 ③ `clarity.clear === false` | 注入 `referenceDisambiguation` 指令**或** `clarificationCards` 指令（二选一，当前散装会双注入） |
| plan | ② scale ∈ {normal, large} 且 ⑤ 缺验收口径 且 ③ 已清晰 | 注入「先复述需求 → 列执行计划 → 列验收标准 → 询问是否按此执行」的系统指令（一次性，不阻塞） |
| proceed | 其余 | 零注入 |

- ⑤ `acceptance` 判定是**新增的确定性启发式**（不调模型）：消息中无「文件/模块/命令/
  数值/验收动词（跑通、验证、测试、输出、修复 X 报错）」且长度 ≥ N 时判「缺验收口径」。
  判据真源放 `requirementIntakeService` 内，零假阳性保守起步（宁可漏判走 proceed）。
- 互斥排序原则：**消歧 > 澄清 > 计划**——先弄清「在说什么」，再弄清「要什么」，
  最后才「怎么做」。同一轮至多注入一份问询指令。

### 4.2 需求制品格式（`.khy/requirements/<YYYYMMDD>-<sid>.md`）

```markdown
# 需求单 20260927-a1b2

> 会话: <sessionId> · 状态: confirmed | amended | superseded · 更新: 2026-09-27 14:30

## 需求条目（每条必须有 source）

- R1. 优化 replSession.js 的启动耗时
  - source: 用户原话「优化一下代码」+ 澄清答案「主指启动，文件 replSession.js」
  - 验收: khy --version 首帧 < 500ms（命令 + 期望输出）
  - 范围外: 不动 aiGateway.js
- R2. （无 source 的条目标 ⚠ 待用户下轮确认，S1 阶段仅标注不阻断）

## 收尾对账（执行完成后由系统追加）

- R1 ✓（khy --version 实测 412ms）
- R2 ⏳ 未观测到验证动作
```

- 制品是**用户可编辑的普通 markdown**（对齐 Claude Code Ctrl+G 改计划 [1]），
  落 `.khy/requirements/`（gitignore 内本机态；如需多机共享再议 `.ai/`，本期不做）。
- `source` 判据**复用** `check-agent-feedback.js` 的同一语义（原话引用或澄清答案），
  但**不复制其代码**——CI 层判据已在 S1 观察期，运行时先用弱判据（有 source 字段即可）
  避免双真源漂移。
- 写制品的时机：澄清答案回来的那一轮，由模型产出复述文本，**后端确定性组装**成制品
  （模型只产字段内容，不产文件）。字段：条目列表 + 每条 source + 验收口径 + 范围外。

### 4.3 执行中回灌与收尾对账

- **回灌**：制品 id 注入会话系统上下文一行
  `当前需求单: .khy/requirements/20260927-a1b2.md（执行中每阶段引用，收尾对账）`；
  每阶段状态广播（规则 2.6 步骤 n/m）天然携带任务目标，改写为引用制品条目号
  （`步骤 2/5: R1 — 解析 AST（340/1200）`），实现「固化物反复可见」（L5）。
- **对账**：任务收尾时系统在制品尾部追加「收尾对账」段：每条 R 逐个 ✓/✗/⏳
  （✓ 有验收证据；⏳ 未观测到验证动作）。这是 OpenHands GoalController 按迭代审计 [16]
  的收尾化简版，S1 只记录不阻断。
- **编辑生效**：用户手改制品后，下一轮对话重新读取（每轮一次 `fs.readFile`，
  fail-soft 读失败按无制品处理）。

## 5. 模块设计（新增 2 个纯叶子 + 1 个薄 UI 组件）

| 模块 | 位置 | 职责 | 复用 |
|------|------|------|------|
| `requirementIntakeService.js` | `services/backend/src/services/` | 聚合五路裁决（§4.1 表），产 `understandingState`；纯函数、无 I/O、绝不抛；门控 `KHY_REQUIREMENT_INTAKE` | `taskScale` / `multimodalIntentRouter.assessPromptClarity` / `referenceDisambiguation` 判据 / `textHeuristics` |
| `requirementArtifact.js` | 同上 | 需求制品的确定性组装 / 读取 / 对账追加；唯一落盘点；fail-soft | `utils/dataHome` |
| `ClarifyCard.vue` | `apps/ai-frontend/src/components/` | Web 端交互式选项卡问询；单选即答 / 多选显式提交 / Other 兜底 | `questionCardModel` 数据形状 + 既有 `control_request` 事件通道 |
| （零改动）`QuestionPrompt.js` | `services/backend/src/cli/tui/` | TUI 问询 UI 已是目标形态 | — |

装配点改动（唯一侵入面，全部 try/catch fail-soft）：
`aiChatCore.js` 步骤 2-3 之间调用 `aggregate()`，用返回的 `understandingState`
替换现有 `:851-859`（澄清）与 `:872`（消歧）两处**散装注入**；制品回灌在
步骤 4 预检后注入一行上下文。

**风格对齐既有模式**（`mathSolvePolicy` / `clarificationCards` 同款）：
头部注释写明职责与真源归属；`isEnabled(env)` 读 env 门控（默认关，仅显式 `on` 启用）；
确定性纯函数；`module.exports` 命名路由函数；用户可见串中文、注释英文；2 空格缩进。

## 6. 数据流与协议

- **跨端问询协议**：TUI 与 Web 共用 `questionCardModel` 的数据形状
  （`{questions:[{question,header,options:[{label,description}],multiSelect}]}`），
  经既有 `AskUserQuestion` 控制协议下发。Web 端 `ClarifyCard.vue` 消费同一形状，
  答案回传走既有 `control_response` 通道（`aiChatEventUtils.js` 已能收到事件，
  只补「可回应」）。
- **制品生命周期**：`created（澄清轮组装）→ confirmed（用户未异议的下一轮）→
  amended（用户编辑后）→ superseded（同会话新需求单生成时）`。状态只进制品头注释，
  无独立状态机——制品即真相（CH-1 只读豁免适用：任何端要看需求单，直读文件）。
- **失败语义**：聚合器任何一路判据抛错 → 该路按「未命中」处理并 `console.warn`
  具体原因（动作+目标+进度，规则 2）；制品读写失败 → 会话照常进行、状态行提示
  `需求单写入失败（.khy/requirements/ 权限），本轮不固化`（规则 2.2：问题+原因+建议）。

## 7. 验收判据（A1–A6，命令 + 期望输出）

| # | 命令 | 期望 |
|---|------|------|
| A1 | REPL 输入「优化一下代码」（`KHY_REQUIREMENT_INTAKE=on`） | 收到 AskUserQuestion 选项卡（≥2 题，含「可讨论/自由输入」自动项）；且本轮**只有一份**问询指令（/intent 调试快照可见 directives 计数 = 1） |
| A2 | 同上答完澄清 | REPL 出现 `📋 需求已确认 → .khy/requirements/<id>.md（可编辑）`；制品含 ≥1 条带 source 的需求条目与验收口径 |
| A3 | 编辑制品 R1 验收值后继续对话 | 下一轮系统上下文回灌行反映编辑后的值（状态行可见） |
| A4 | 长任务执行中 | 每阶段状态广播引用 R 编号；收尾输出对账段（✓/✗/⏳） |
| A5 | `KHY_REQUIREMENT_INTAKE=`（默认关） | 行为与现状完全一致（散装注入保留原样），零回归 |
| A6 | `apps/ai-frontend` Web 端收到 `control_request(AskUserQuestion)` | 出现可交互选项卡（可点选、可自由输入），答案回传后流继续；不再只是只读文本 |

## 8. 落地阶段（PROCESS-008：S1 起步，毕业看样本）

| 阶段 | 内容 | 门槛 |
|------|------|------|
| S1 观察者（**已实现 2026-09-27**） | `requirementIntakeService.aggregate` 只算裁决并记录（`requirements/observations.jsonl` + onStatus 播报），**不改变注入行为**（S2 收口逻辑已写好，由 `getStage()!=='S1'` 短路）；制品组装/回灌/对账已开（`KHY_REQUIREMENT_ARTIFACT` 独立门控，写文件不阻断会话）；Web ClarifyCard 已上（control_request 升级为交互卡，答复走既有发送通道） | 样本 ≥200 轮，无解释不了的误判样本 |
| S2 顾问 | `getStage()` 改 `'S2'` → aiChatCore 按聚合裁决替换散装注入（互斥排序生效）；plan 路由注入计划指令 | 提示 ≥50 条后误报 <10% |
| S3 门禁 | plan 路由升级为「未确认需求单不进入执行轮」（可豁免） | ≥20 次真实拦截且豁免率 <20% |

- 实现落点：`services/backend/src/services/requirementIntakeService.js`（聚合纯函数 +
  验收口径判据 ⑤ + observe 台账）、`services/backend/src/services/requirementArtifact.js`
  （QA 观察缓冲 / 轮末确定性固化 / 回灌行 / 幂等对账）、`aiChatCore.js` 三处装配点
  （聚合观察 / 回灌 entry / 轮末固化+对账）、`replSession.js` QA 观察缝（`handleControlRequest`
  askuserquestion 分支 `behavior:'allow'` 返回前一行，fail-soft）、`apps/ai-frontend`
  `ClarifyCard.vue` + `AIChat.vue`（SSE/WS 双路径捕获 + 交互卡）。
- 每阶段在 `FEATURE-OWNERSHIP.json` 登记 `stage / previousStage / samples.observed /
  rollback / executorStage`；rollback 一律是「关 `KHY_REQUIREMENT_INTAKE` /
  `KHY_REQUIREMENT_ARTIFACT` 即回现状」。
- **升阶是人的决定**，守卫/CI 不代劳（PP-6）。`check:rollout-stage` 守卫已登记并校验。
- 执行强度对齐：S1 期间 `RUNTIME-002` 检查对新状态文本同样生效（动作+目标+进度）。

## 9. 未来工作（不在本期）

1. **澄清质量回归集**：仿 ClarifyCodeBench [22] 建 30-50 条歧义提示样本，离线跑
   `aggregate()` 断言 route 分布（不调模型的纯函数可全量回归）。
2. **理解/执行上下文分离**（L8）：面试轮结束开新会话执行，需先评估记忆/RAG 影响。
3. **与 [DESIGN-ARCH-037] 对接**：`EvoRequirement` 过同一制品格式入库。
4. **多机共享需求单**：若出现跨机任务，制品迁 `.ai/`（受 `MEMORY-003` 管辖）再议。

## 附录 A：裁决真源对照

| 判据 | 真源 | 本方案角色 |
|------|------|-----------|
| 问候判定 | `textHeuristics.isGreeting` | 聚合器复用，不重写 |
| 任务规模 | `taskScale.resolveTaskScale` | 聚合器复用，不重写 |
| 清晰度 | `multimodalIntentRouter.assessPromptClarity` | 聚合器复用，不重写 |
| 消歧 | `referenceDisambiguation` | 聚合器复用其判定；注入指令时**让位逻辑**由聚合器决定 |
| 澄清指令文本 | `clarificationCards.buildClarificationDirective` | 原样复用，聚合器只决定**何时注入** |
| 问询 UI 形状 | `questionCardModel` | 跨端协议真源 |
| source 判据语义 | `check-agent-feedback.js auditFiveQuestions` | 运行时弱判据（有字段即可），语义对齐不复制代码 |
| 验收判据 D9 | `[DESIGN-DELIV-002]` 黄金路径 | A1-A6 命令可脚本化，供未来 golden path 引用 |

## 附录 B：调研来源

外部（2026-09-27 调研纪要，来源已逐条核验）：

- [1] Claude Code permission modes — https://code.claude.com/docs/en/permission-modes
- [2] Claude Code common workflows — https://code.claude.com/docs/en/common-workflows
- [3] Claude Code tools reference (AskUserQuestion) — https://code.claude.com/docs/en/tools-reference
- [4] Claude Code best practices — https://code.claude.com/docs/en/best-practices
- [5] Claude Code memory — https://code.claude.com/docs/en/memory
- [6] Aider chat modes — https://aider.chat/docs/usage/modes.html
- [7] Aider conventions — https://aider.chat/docs/usage/conventions.html
- [8] Cline Plan and Act — https://docs.cline.bot/core-workflows/plan-and-act
- [9] Cline custom commands / deep-planning — https://docs.cline.bot/core-workflows/using-commands
- [10] Cline tools reference — https://docs.cline.bot/tools-reference/all-cline-tools
- [11] cline/cline `apps/vscode/src/shared/tools.ts` — https://github.com/cline/cline
- [12] cline/cline `agent-ask-question.tsx` — https://github.com/cline/cline
- [13] cline/cline `sdk/packages/shared/src/prompt/system/act.ts` — https://github.com/cline/cline
- [14] OpenHands agent loop — https://docs.openhands.dev/sdk/arch/agent
- [15] OpenHands security / confirmation policies — https://docs.openhands.dev/sdk/guides/security
- [16] OpenHands conversation goals — https://docs.openhands.dev/sdk/guides/agent-server/conversation-goals
- [17] OpenHands paper — https://arxiv.org/abs/2407.16741
- [18] LangGraph interrupts — https://docs.langchain.com/oss/python/langgraph/interrupts
- [19] ClarifyGPT — https://arxiv.org/abs/2310.10996
- [20] LLMREI — https://arxiv.org/abs/2507.02564
- [21] Follow-up question generation — https://arxiv.org/abs/2507.02858
- [22] ClarifyCodeBench — https://arxiv.org/abs/2607.00711
- [23] Clarity is not assumed — https://arxiv.org/abs/2604.21505

内部盘点（2026-09-27，file:line 已核）：

- 五步管线：`services/backend/src/cli/aiChatCore.js:446-500,851-872,1034-1043`
- 澄清卡：`services/backend/src/services/clarificationCards.js`
- 消歧：`services/backend/src/services/referenceDisambiguation.js:130`
- 规模：`services/backend/src/services/taskScale.js`
- TUI 问询：`services/backend/src/cli/tui/ink-components/QuestionPrompt.js`、`questionCardModel.js`
- Web 缺口：`apps/ai-frontend/src/views/aiChatEventUtils.js:33,293-295`
- 五问判据：`scripts/ci/check-agent-feedback.js:212-223`
