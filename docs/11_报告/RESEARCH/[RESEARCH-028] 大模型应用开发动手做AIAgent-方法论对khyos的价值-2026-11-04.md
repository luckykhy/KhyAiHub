# [RESEARCH-028] 《大模型应用开发：动手做 AI Agent》方法论对 khyos 的价值

> 评估日期：2026-11-04（2026-11-05 按独立审读意见修订）
> 被评估书：《大模型应用开发：动手做 AI Agent》，黄佳著，人民邮电出版社 2024 年，290 页，7 个实战案例
> 对照仓库：khy-os（`runtime/node/backend/`，分支 `feat/thinking-fold-20261103`，2026-11-04 状态）
>
> **证据分级标记**（全文通用）：
> 【书】= 书中原文/页码（来自本次 ask 提供的逐章评估记录照录，**未回翻原书**）；
> 【书√】= 独立复核员亲读原书扫描页确认的页码与引文；
> 【仓】= 仓库文件:行号（来自四透镜调研 JSON）；
> 【跑】= 主编笔本次实跑的命令与输出（命令原文见 §6.2）；
> 【评】= 调研/评估 JSON 中的实跑记录（主编笔或复核员复跑情况见 §6.2/§6.4）。
> 未能验证的一律写「未验证」，不用推测填充。2026-11-05 修订：§6.4 已按独立复核结果给每条关键结论标注 已验证/部分验证/未验证。

---

## 0. 结论速览

**总判**：这本书是 2024 年初以 LangChain 与 OpenAI Assistants API 为载体写成的教学书，代码形态对 khyos 无可迁移性——khyos 不引入这两个依赖（【跑】package.json 仅命中 node-llama-cpp），其自研主循环比书中示例多出预算壳、验证门、审批链与规则守卫。这本书对 khyos 的真实价值是三处「反向指路」：第 8 章 RAG Pipeline 反证出聊天检索链路缺嵌入与重排、第 9 章 Agent Protocol 对应 A2A 入站 executor 占位、第 7 章「不可能完成的任务」给出 khyos 评测面没有的诚实性检验方法。其余 126 条低价值评估的共性结论：khyos 在 ReAct 循环、规划解耦、记忆、工具执行、多 Agent 编排五个面上已有比书中更深或被机制强化的实现，本书在这些面上只起术语对照作用。

**最值得动手的 5 条**：

| # | 动作 | 档 | 一句话 |
|---|---|---|---|
| 1 | 聊天 RAG（知识库+会话检索）接入嵌入 + 重排 | 高 | 进主循环的知识库/会话检索链路（ragRetrievalService）是纯词法；embeddingClient/rerank 在仓内已实现，却未接进该链路（rerank 仅剩工具包装、无生产调用方，两套向量存储未打通），改述查询召回无保障 |
| 2 | A2A 入站 executor 接线 | 高 | `routes/a2a.js:42` 以无参 `createServerMethods()` 起服务，executor 是源码注释明写的占位，外部标准客户端驱动不了 builtin agent 运行时 |
| 3 | 诚实性评估探针 | 高 | 训练后固定探针（EVAL_PROBES）只有 4 条有确定答案的题、且 Ollama 不可达时跳过，「不懂时是否编造」零度量；名为 Evals 的表面是随机数桩 |
| 4 | 金额预算门（默认路径） | 中 | tokenUsageService 有人民币计价统计，但默认配置下没有金额预算门：token 预算器默认关、惯性子系统的 cost 判定未接成立停条件、网关预算门只覆盖 managed-token 客户——超支只能靠轮次与空闲超时兜底 |
| 5 | 复盘/教训记忆化 | 中 | Reflexion 的「动态记忆」一半缺失：跨模型复盘的 issues/suggestedFixes 不落 cross_session 记忆，不可跨会话召回 |

---

## 1. 这本书是什么

### 1.1 结构与七个案例

【书】全书 = 前言 + 第 1 章立论（何谓 Agent、为何 Agent）+ 第 2 章技术框架（规划/记忆/工具/行动四要素、ReAct、认知框架选型）+ 第 3 章工具链（OpenAI API、LangChain、LlamaIndex）+ 第 4–10 章七个实战案例 + 附录 A（科研论文综述，参考文献 22 篇）。

七个案例（【书】page-0007/0008 前言案例清单）：

| 案例 | 书中载体 | 主题 |
|---|---|---|
| Agent 1 | Assistants API + DALL·E 3 | 自动化办公（做 PPT） |
| Agent 2 | Function Calling | 多功能选择引擎 |
| Agent 3 | LangChain ReAct | 推理与行动协同（自动定价） |
| Agent 4 | LangChain Plan-and-Execute | 计划与执行解耦（库存调度） |
| Agent 5 | LlamaIndex RAG | 知识提取与整合 |
| Agent 6 | AutoGPT / BabyAGI / CAMEL | 自主 Agent 与角色扮演 |
| Agent 7 | AutoGen / MetaGPT | 多 Agent 框架 |

### 1.2 书的立场

【书】自我定位「从技术框架到开发工具、从实操项目到前沿进展」，面向 Agent 技术相关的研究人员、开发人员、产品经理与企业负责人；基石三件套是 LangChain / LlamaIndex / OpenAI API，明确主张「不必从零造轮子」「站在巨人肩膀上」（page-0007、page-0233/0265）。题记把儒家「博学、审问、慎思、明辨、笃行」映射到 Agent 的数据训练、提示工程、思维框架、价值观对齐、工具调用。

### 1.3 与 khyos 的架构关系（先决事实）

三条先决事实决定了大部分评估结论，均已实跑核实：

1. **不引入 LangChain / LlamaIndex / openai 直依赖**。【跑】`Select-String runtime/node/backend/package.json -Pattern 'langchain|llama|openai'` 仅命中 `node-llama-cpp`（:177 依赖、:219 配置）。【评】ch3 评估记录同结论。仓内仅存兼容垫片 `routes/chain.js`（echo/template/react-parse 三链，【跑】实测 161 行）与 `toolCalling.js` 的 chain_run 工具，均非框架依赖。
2. **主循环是自研单循环**。【仓】`runtime/node/backend/src/services/tool/toolUseLoopCore.js:826`（`runToolUseLoop`），配影子 FSM `toolLoopPhases.js:23-33, 87-89`；仓内概念文档直接把该循环命名为 ReAct（`docs/02_CONCEPTS_概念入门/CONCEPT/[CONCEPT-03] 什么是ToolLoop-工具循环.md:105`）。【跑】对 `runtime/node/backend/src` 全量搜 `Thought:` 零命中——交替思考由原生 tool_use 块与供应商 thinking 块承载，不是文本协议。
3. **工具面规模**。【跑】`node -e "require('./src/tools').count()"` → **193**；`getNonDeferredTools()` 为 Map、`size` → **154**（与【评】调研记录一致；复核员复跑 `getAll().size=193`、`has('Evals')=true` 亦相符）。

> 第 5 章（Agent 2：Function Calling）在本次评估记录中 **items 为空**（chapter 字段为 "test"），未产生任何评估条目。本报告不对第 5 章下任何结论；书中该章方法（函数调用）已由第 2/3/4/6/7 章的同主题条目覆盖（见 §2 主题 D）。

---

## 2. 方法论总盘点（按主题分组、跨章去重）

原始评估 **161 条**（分章计数见 §7 附录），跨章去重后归并为 **59 条独立方法论**：高 3、中 12、低 38、暂不适用 6。同一方法论在多章出现的（如 ReAct 见于第 1/2/6/7 章）只留一条，页码并列。

**「档」的定义**（价值档，评的是对 khyos 的方法论价值，与「代价」列不同义）：高 = 书中有 khyos 没有且可迁移的方法，或反向指出真缺口；中 = 有缺口但仓内已有部分替代实现，或需较大改造；低 = 已被本仓实现覆盖，或纯概念/教学价值；暂不适用 = 架构、载体或产品形态不匹配。§4.1 的 P0–P3 是**行动优先级**（价值 × 代价 × 风险），与档不是同一轴，不要互相套用。

**阅读注意**：表中「已覆盖 / 兜住 / 无差距」均指**设计层对位**——除标注【跑】或【书√】者外，未做故障注入、实测或原书回翻；这类句式是判断不是测量（独立审读对此提出保留，见 §6.4）。

| 主题 | 方法论 | 书中做法 | khyos 现状 | 档 | 差距 | 落地第一步 | 代价 |
|---|---|---|---|---|---|---|---|
| A 推理与认知框架 | A1 ReAct「观察-思考-行动」循环 | 【书】page-0026、0052–0054、0060–0064、0173–0202、0204、0241 | 主循环即该形态：`toolUseLoopCore.js:826, 2137`；FSM `toolLoopPhases.js:23-33, 87-89`；CONCEPT-03:105 直接命名 | 低 | 设计层无差距；khyos 比书多预算壳（:452-479）、验证门（:4934-5019）、空闲超时（:1835-1838） | 不落地；文档层点明「本仓 ReAct = toolUseLoop + FSM」即可 | 零 |
| A | A2 ReAct 文本提示模板（Thought/Action/Observation + agent_scratchpad） | 【书】page-0057–0059、0180–0181 | 无文本草稿纸协议【跑】`Thought:` 零命中；调用经 `claudeCompat.normalizeToolCall` 规范化（`toolUseLoopCore.js:7111-7150`） | 暂不适用 | 架构冲突：把结构化 tool_use 降级为文本协议丢类型安全。但反向看（审读意见）：对**不支持原生 tool 的供应商**，文本协议仍有兼容价值——该场景在 khyos 供应商面中的占比本篇未评估 | 不做；若确需兼容，规范化逻辑加在 claudeCompat 一侧，不新写 parse_agent_output | 强行实施破坏现有规范化链路 |
| A | A3 AgentExecutor 执行器与断点调试法 | 【书】page-0055–0057、0181–0193 | 自研执行器更厚：主循环 + `agenticHarnessService.js:172` 续跑（最多 8 轮）+ 轨迹回放 + breadcrumb（`toolUseLoopCore.js:7115`） | 低 | 书中框架自身已被 LangGraph 取代的命运反证自研规避了生命周期绑定（「已取代」为外部事实，未在仓内验证） | 不落地 | 零 |
| A | A4 思维链 CoT 与问题分解 | 【书】page-0026、0048、0065 | CoT = thinking 块 + 努力档（`autoReasoning.js:49`）+ cotArbiter 闭环仲裁（`reasoning/cotArbiter.js:3-21`）；分解 = `cliAgentRunner.js:34-35` 角色分解 + planModeService | 低 | 已被覆盖且思考是预算化的。另发现文档与实现不一致（与本书无关）：【跑】`CONCEPT-19` 第 18 行确有「Thought：我需要先读一下配置文件」式表述，而实现无文本 Thought（承诺过强） | 若要动，订正 CONCEPT-19 使其与原生 thinking 块一致 | 订正文档零代码成本 |
| A | A5 思维树 ToT / 树搜索 / PDDL 外部规划器 | 【书】page-0048、0066 | 【评】对 src 搜 mcts/MonteCarlo/tree-of-thought/self-consistency/reflexion/blackboard 全部 0 命中；只作为概念存在于 docs/02_CONCEPTS | 低 | 有意取舍：与现代 coding agent 主流形态不符且无 khyos 落点 | 不做 | 补规划器需新模块 + 轮次预算改造 |
| A | A6 Reflexion / 批判修正 Critique-Revise | 【书√】page-0049（Reflexion 定义逐字核）、0065、0202 | 回合内批判已有五种：`answerVerifier.js:78-267`（确定性复核）、`adversarialVerifyEnsemble`（`toolUseLoopCore.js:4934-5019`）、`verificationAgent.js:40-112`、`crossModelVerify.js:26-29`、verify 门 | 中 | 「动态记忆」一半没有载体：复盘只活在回合内，不落 cross_session/permanent 记忆、不可跨会话召回；【跑】`memoryTrigger.js:180-244` 的 classify 只收 explicit/proactive/instruction/none 四类，无 agent 自主复盘入口；【评】progressLog.js:8 自陈「四层记忆的写入侧只由 memoryTrigger 的 4 条窄正则触发」 | 在 `agenticHarnessService.js:846-885` 接线处把 issues/suggestedFixes 摘要经 memoryTrigger 新增 reflection 分类写入 cross_session 层（tier 派生见 `memoryTier.js:25-53, 83-98`）；门槛复用 `dreamPromote.js:25-33` 的 score≥0.9 且未回流过思路；写入走 `memoryWriteSafety.js:52-74` 原子写 | 中：要防低质复盘污染召回（复用 `memoryContentDedup.js:62-90` 与 distiller 的 Jaccard≥0.82 判据）；按 PROCESS-008 以 S1 观察者起步 |
| A | A7 自问自答 Self-Ask | 【书】page-0064 | 未覆盖；src 下未见显式 self-ask 脚手架（未验证是否有等价物） | 低 | 功能已被主循环的模型自主多轮调用覆盖 | 不落地 | 零 |
| B 规划与任务分解 | B1 Plan-and-Execute 先规划后执行 | 【书】page-0064、0203–0221（第 7 章全章）、0241 | `planModeService.js:146` 五态机（idle→generating→reviewing→executing→complete）、人读步骤落盘、人工批准后逐步执行、高危步骤人闸门（:669-766, 1195-1213）；`ultraplanService.js:15` 最长 30 分钟研究+规划会话 | 中 | 框架主体已实现且更严；缺口在执行期（见 B2） | 见 B2 | — |
| B | B2 执行中依据工具输出修订计划 | 【书√】page-0207（Plan-and-Solve 伪代码含 `modifyPlanBasedOnToolOutput(toolOutput, steps, step)`） | 【评】对 planModeService.js 与 ultraplanService.js 搜 replan/revisePlan/modifyPlan/adjustPlan/updatePlan 均零命中（复核员复跑：planModeService 仅 `_ensurePlansDir` 子串误命中 2 处 :28/:52，真实零命中）——批准后的计划只能按既定步骤走完或中止；执行中只有同步骤重试（:1298-1339）与人工闸跳过，编辑步骤仅存在于批准前 presentForApproval（:1131） | 中 | 「执行中修订后续步骤」通道不存在；这是书中伪代码里唯一 khyos 两条计划路径都没有对应物的一步 | 在 `planModeService.js` executing 态每步校验通过处增加「步骤结果触发计划修订草案 → 回 reviewing 等人工再批准」的回边，不做执行中静默改计划 | 中：与「批准即契约」治理模型摩擦，每次修订多一次人工确认，小任务上收益可能为零 |
| B | B3 计划/执行分配不同模型 | 【书√】page-0221（7.5 小结原文逐字核：「使用较强的模型来完成思考能力要求比较高的计划任务，而使用较小、更快、更便宜的模型来执行完整的步骤」；page-0208 另有「允许一个大模型专注规划，另一个专注执行」。注：评估记录原引 page-0220，该页实为 7.4 节，页码差一页） | 计划由同一个 `chat()` 生成（【评】:583/:1312/:1621 均无模型分流参数）；执行侧已有雏形：`AgentTool/index.js:474, 2080-2142` 子代理可选 preferred model/alias（注释 'Prefer small/fast models for sub-agent work'） | 中 | 「强模型规划」只落在子代理粒度，计划生成本身没有 planner 模型配置位 | `planModeService.js:583` 的计划生成 chat() 增加 planner 模型解析（经 `constants/serviceDefaults.js` 或 env 覆盖，缺失回落当前会话模型），执行步不变 | 中：双模型 = 双供应商凭据与成本核算、fallback 链变长；autoReasoning/cotArbiter 的预算分档已部分覆盖该收益，增量有限 |
| B | B4 AutoGPT/BabyAGI 自主任务队列与三 Agent 分工 | 【书】page-0234–0247 | 主循环是模型自主工具调用而非显式子任务队列；显式分解只在三条编排通道（`cliAgentRunner.js:34-35`、`orchestrationService.js:189`、`domain/project/metaplan/index.js`） | 低 | 默认主回合无持久子任务队列，但这是现代工具调用范式的有意取舍；书中列举的硬伤（死循环、忘旧果）在**设计层**由预算壳 + Boulder 检查点对位覆盖——「兜住」是设计意图判断，未做故障注入或实测（审读保留意见） | 不新增任务队列；要可见的目标分解扩 planModeService 的 reviewing 态即可 | 给主循环加任务队列会与 IterationBudget/Ralph Loop 双重续跑机制打架 |
| B | B5 CAMEL 任务指定 Agent（模糊目标具体化） | 【书】page-0254、0260 | 两个更重的实现：ultraplanService（30 分钟研究+规划）与 planModeService（模型生成 + 人工批准）；轻量版是 applyIntentGate 关键词档位（`toolUseLoopCore.js:907`） | 低 | 想法具体化已覆盖且带人审；缺的「不进计划模式的轻量一句话细化」由零成本关键词档位承担 | 不新增 Agent；若要更细，在 `toolUseLoopCore.js:1783-1785` 预检处补一次「目标重述」注入 | 每轮多加一次模型调用直接进 token 账单 |
| B | B6 MetaGPT SOP 编码提示与软件公司角色流水线 | 【书】page-0273、0280 | 结构化产出链已存在：planModeService 人读步骤、MetaPlanCoordinator 强制先出元规划 JSON（`domain/project/metaplan/index.js`）、applyIntentGate 模式提示 | 低 | 「SOP 编码提示 = 结构化/模块化提示」在 khyos 有三层载体且多一层机器可校验约束；MetaGPT 的文档化工件（PRD/API 文档）是软件公司场景特有，khyos 产出面向执行 | 不落地 | 零 |
| C 记忆与知识检索 | C1 外部记忆 Memory Bank / 四种记忆机制 / 遗忘曲线 | 【书】page-0029、0049–0050 | `memoryTier.js:25-53` 三层保留轴（short_term/cross_session/permanent）+ type 正交；`vectorRecall.js:114-219` 词法∪语义混合召回；`.vectors.json` 侧车（`vectorStore.js:43-46`）；做梦三阶段 `memoryDreaming.js:24-44` + lifecycle 六阶段；recencyMultiplier 按层半衰期（`scoring.js:174-206`） | 低 | 书中一句带过的 Memory Bank，khyos 已做成完整实现；挑出的缺口（冷落降权未实施）不由本节补——作者注释已排好序：先攒真实命中数据 | 不抢先实施 hits/lastHitAt 冷落降权（`vectorStore.js:244-276`） | 低（且作者已排序） |
| C | C2 RAG 概念与「提示工程/RAG/微调」四象限选型 | 【书】page-0031–0032、0095–0097、0223–0224 | 四象限四种能力全有：提示工程（applyIntentGate）、RAG（四链路，见主题判定）、微调（`modelTrainingService.js:602-620`）、可组合 | 低 | 无机制缺口，缺「何时值得训练而非 RAG」的选型记录 | 若要落地，在 `modelTrainingService.trainLocal` 入口或设计文档补一节选型判据 | 低（一次文档） |
| C | C3 RAG 检索 Pipeline 工程化（连接/转换/嵌入/存储/检索 + 混合搜索/重排） | 【书√】page-0225（图 8.6 + §8.1.2：Pipeline 五步含「嵌入：通过词嵌入模型将数据转换成向量形式」「存储：内存/文件系统，更常见是向量数据库」）、page-0097（LlamaIndex 工具分层：数据索引=词向量）、page-0232（§8.4 未来方向「嵌入式搜索、混合搜索和嵌入微排」逐字核）、page-0032（图 1.15 在 page-0032；page-0031 实为图 1.14——评估记录起页略偏） | 【跑】`ragRetrievalService.js` 仅 3 处 require（collapseWhitespaceLoose/knowledgeTeachingService/sessionSearchIndex），无 embedding/vector/cosine/rerank 命中；【跑】全 src 搜 rerank 调用方仅 `tools/RerankTool/index.js:68`；vectorStore 仅 `tools/VectorStoreTool/index.js:82` 与记忆侧自己的 `./vectorStore`（`vectorRecall.js:37`）——两套向量存储未打通 | 高 | 进主循环的知识库/会话检索链路（初始化「步骤 3/5」注入，【跑】`aiChatCore.js:1754-1772` 核实）缺「嵌入+向量存储」两环；嵌入与混合召回配方已在仓内（且已用在别的链路，见主题判定）却未接该链路；改述查询、同义表达与近 45 天会话知识（【评】ragRetrievalService.js:346-350，:349 为 45 天窗）召回质量无保障 | 第一步改 `ragRetrievalService.js:273-368` 的 `buildRetrievalContext`：对 knowledgeTeachingService 与 sessionSearchIndex 的词法候选接 `embeddingClient.js:145-164` 做 0.4×词法+0.6×余弦重排（对齐 `learningRetrieval.js:647-735` 既有配方），候选数不收窄；二次重排再接 `services/rerank`；保留「小任务默认跳过」与 TTL 缓存不变 | 中：需 Ollama 或 gateway 嵌入端点可用，失败须逐字节降级回纯词法（降级路径可抄 `vectorRecall.js:114-219`）；每回合多一次嵌入调用，延迟与配额需实测；属核心路径改动，按 RUNTIME-007 留复现存证（注意：RUNTIME-007 按 AGENTS.md 定义只覆盖修复类改动，本条是增强，真正需要的是召回质量基线，见 §4.3） |
| C | C4 Conversational Retrieval Agent / 检索工具化 | 【书】page-0097、0227 | 模型可调检索工具已存在（session_recall/VectorStore/Rerank/LocalMemoryRecall）；预注入路由由 applyIntentGate 自动检索模式解析 | 低 | 知识库检索（`knowledgeTeachingService.searchKnowledge`）未做成模型可调工具，只能预注入或走 CLI | 若要落地，按 `sessionRecall.js` 的 defineTool 只读模式把 searchKnowledge 包成工具 | 低（一个工具文件，复用现成打分） |
| C | C5 索引与持久化 | 【书】page-0229–0230 | 记忆向量落 .vectors.json 侧车，按内容 hash 逐条失效、模型不符整表作废、单回合嵌入预算默认 32 条（【跑】`vectorRecall.js:74` 核实默认值；`vectorStore.js:126-162, 244-276`） | 低 | 「避免重复嵌入」的目的已达成；书中 LlamaIndex 0.9 storage 目录格式已过时 | 不照搬；知识库若建侧车，沿用现有 hash 失效模式（与 C3 是同一缺口的持久化半边，可合成一步做） | 中（新侧车需与 500 条上限、32 条/回合预算对齐） |
| C | C6 任务/结果对入向量库 + top-k 召回 | 【书√】page-0240（BabyAGI 第 3 步「在 Chroma/Pinecone 等向量数据库中存储结果」）、page-0244（`_get_top_tasks(vectorstore, query, k=5)` + `similarity_search_with_score`）、page-0246（`self.vectorstore.add_texts(texts=[result]…)`）。注：评估记录原引「小结称自主 Agent 的记忆使用方式与传统大模型不同」，复核员在 0240–0253 未见此句，已删 | 向量检索已具备但服务对象是用户记忆而非任务结果；任务产出另有流向：`subAgentOrchestrator.js:480` 树形注入当次上下文、`agenticHarnessService.js:734-741` Boulder 检查点续跑 | 中 | 历史任务/结果对没有进入可检索记忆，跨会话无法「上次这类任务是怎么做的」式召回 | 落点二选一：在 `subAgentOrchestrator.aggregateResults` 或 `orchestrationService` 步骤完成回调处把 task/result 对经 addStructuredMemory 写入 memoryEngine（type 取 reference/project 走 cross_session 层）；或把 `services/vectorStore` 的 file 后端接到同一写入路径，顺带统一两套向量存储 | 中：任务结果噪声会稀释用户记忆库召回精度，需先定结果边界（只收结论/决策，不收中间工具输出）并过 memoryContentDedup 查重 |
| C | C7 结构化/非结构化数据分型 | 【书】page-0222 | 已按数据形态分设链路（会话走 SQLite FTS5、记忆走 markdown+向量侧车、知识库走 JSON 复合打分），但没有显式登记 | 低 | 分型工作实质已完成，新增知识源时无判据可查 | 若要落地，把判据写进 `knowledgeTeachingService.js:26-64` 类目表或 DATA-LOCATIONS.json 旁注 | 一次登记，近零 |
| D 工具调用与执行 | D1 函数调用 / JSON 模式 / 原生 tool_use | 【书】page-0034、0064、0075–0080、0106–0109、0179、0209–0212 | 原生 tool_use 块 + `claudeCompat.normalizeToolCall` → ToolExecutionEngine 13 阶段（`toolUseLoopCore.js:7111-7150`；【评】该记录只列出 8 个阶段名：分类/去重/hooks/循环检测/shell 安全/审批/恢复/诊断，「13」未逐条对应）；JSON 模式仅作供应商透传（`_protocolPipeline.js:149-151`），智能体路径零使用 | 低 | 书中「让模型输出 JSON 再解析」是原生工具调用的前一代形态，khyos 已跳过 | 不落地；对不支持原生 tool 的供应商，规范化逻辑加在 claudeCompat 一侧 | 零 |
| D | D2 工具与工具包、工具描述质量 | 【书】page-0050–0051、0177–0179 | 【跑】193 工具目录扫描自动注册；子代理即「工具包」且按角色收窄（`AgentTool/index.js:938-961`）；rich description 动态生成 | 低 | 「描述质量决定 Agent 能否用对」无 lint 机制：注册处对缺描述静默填空串（【评】`tools/index.js:244/:403` `tool.description \|\| ''`） | 若要做，把该处改为空描述打 warning 或拒绝注册 | 低（注册处一个校验 + 回归 193 个工具注册冒烟） |
| D | D3 llm-math 数值计算工具 | 【书】page-0197–0198 | 输出侧复核很强（answerVerifier 算式真值），但循环内无数值计算专用叶子——【跑】全 src 搜 `calculator` 仅 3 处命中且均非计算用途（`khyUpgradeRuntime.js:1494` 名称映射、:1872 `Calculator result:`、`appTarget.js:43` 桌面「计算器」应用目标）；兜底靠 shellCommand 让模型自己跑 | 中 | 任务中途要算（如书中定价链）时没有专用计算叶子。「模型自算或绕 shell 更易错、更废 token」是**无实测的因果判断**（审读保留）：未量过口算错误率与 token 对比，只作为设计动机 | 在 `src/tools/` 下加一个薄计算叶子（numexpr 或 python -c 包一层，描述写清「数值计算用我，不要口算」），经目录扫描自动注册；与 answerVerifier 形成「循环内能算 + 收尾能验」闭环 | 低（一个叶子工具 + 单测，不碰主循环） |
| D | D4 产物落盘与回读 | 【书】page-0127、0136–0137 | 产物由智能体本地直接生成（Write/Edit 工具），修改后还有验证门 | 暂不适用 | file_id 下载链是 Assistants 托管文件存储的交付形态，khyos 产物本地直写 | 不落地 | 零 |
| E 多 Agent 协作与服务化 | E1 分层结构 + 通信机制两原则 | 【书】page-0042 | `subAgentOrchestrator.js:38-45, 144, 307, 480`（maxDepth 3/maxChildren 10/maxTotalAgents 50 + 拓扑分层 + 树形聚合）；`cliAgentRunner.js:34-35` 角色分解并行；`orchestrationService.js:189` 步骤 DAG | 低 | 两条原则在**设计层**已实现；缺的「协商/议价」在 khyos 是有意不做（确定性 DAG 优于议价） | 不引入能力议价；若要多 Agent 通信增强，先补 `agentCommunicationService` 的任务状态实时广播（接 taskBoard 事件） | 低（仅事件接线），收益主要是可观测性 |
| E | E2 Agent as a Service / 网站为 Agent 优化 | 【书√】page-0041（「Agent 即服务」节，订机票酒店例） | Web API（CH-4）+ 入站 A2A v0.3.0 REST 绑定（`routes/a2a.js:8-20`）+ 出站客户端（`a2a/index.js:96-155`）+ A2ARegistry 能力发现 | 中 | 「网站/API 为 Agent 优化」已由 CH-4 部分兑现；剩余缺口是 executor 接线而非概念（与 E3 同一缺口，两个书中入口） | 见 E3 | 见 E3 |
| E | E3 Agent Protocol 服务化（run/serve 双子命令） | 【书√】page-0236（`./autogpt.sh --help` 输出「serve — Starts an Agent Protocol compliant AutoGPT server」逐字核） | 【跑】`routes/a2a.js:40-42` 注释明写「executor 默认占位，真接 builtin agent 运行时时由启动代码用 createServerMethods({ executor }) 重建并挂到 app.locals」，实际调用为无参 `createServerMethods()`；【评】`serverMethods.js:42-57` defaultExecutor 只把首段文本回显为 `received: <text>`，:14-17 注释明写「默认 executor 只回显 ack（诚实占位，不假装跑了 LLM）…独立的后续任务，不在 S3 范围内」；复核员复跑：全 backend 搜 createServerMethods 仅 routes/a2a.js:42 一个真实调用点，无任何启动代码注入 executor | 高 | 入站 A2A 有协议外壳无执行内核：外部标准客户端可以建任务、发消息，但 builtin agent 运行时不会被真正驱动；源码注释把补实标为「独立的后续任务，不在 S3 范围内」 | 改 `routes/a2a.js:42` 为注入 executor：把 message/send 的文本转成一次 `runToolUseLoop` 调用（或 `agenticHarnessService.run()`），任务进度经 IterationBudget/空闲超时映射到 tasks/get 轮询态，失败按既有路径落 failed 终态；先限定任务类型试通再放开 | 中：要把主循环的流式/预算/审批语义映射到 A2A 任务生命周期，且作者已标为独立后续任务；做糙了等于开一个绕开审批的后门；按 PROCESS-008 保持 S1 只记录不阻断 |
| E | E4 AutoGen Agent 定制与对话拓扑（联合/层级） | 【书】page-0268–0271 | 定制 = 同一循环 + 角色工具收窄 + 角色 prompt + per-role preferredModel/Adapter（【评】cliAgentRunner.js:465-473 实读确认）；拓扑 = 三条编排通道 | 低 | 「agent × 工具 × system_message × llm_config」四维定制已被承载且多了深度/并发/总量硬限；联合聊天（agent 间点对点自由对话）与「子代理结果只回主控」不变式冲突，不落地 | 不落地；整合三编排通道的优先级应低于核心循环缺口 | 整合属中等改造，与本书方法论无因果关系 |
| E | E5 CAMEL 角色扮演 / 启发式提示 / 七要素 / 双 Agent 循环 | 【书】page-0253–0263 | 不用对话式角色扮演，用结构化编排；【跑】全 src 搜 CAMEL_TASK_DONE 零命中；七要素中六项已有机械对应物（工具收窄/规范化/诚实收尾/循环检测） | 低 | 「初始提示后自动互提示」无对应物，但其功能由工具循环的模型自主调用承担且更可控；唯一无载体的是文本终止标记，而 khyos 循环退出是结构性的 | 作为人工评审 checklist 用于评审新增子代理/角色提示词（角色、拒绝、格式、退出四项） | 零代码成本，仅评审时间 |
| E | E6 人类无缝参与（human-in-the-loop） | 【书】page-0269–0271 | 中止侧：`aiSession.js:291-293` ESC/`/i` 中断时 chat() 抛 AbortError、recordInterruption 把「本轮回复被用户中断」补写进模型可见历史（【评】实读确认）；审批侧：planModeService 人闸门 + ToolExecutionEngine 审批阶段 + capabilityAssessment strict/warn | 低 | khyos 的人审是分级门控，比书中 ALWAYS/NEVER 二元切换粒度更细；中断标记机制还补上了「模型得知自己被打断」 | 不落地 | 零 |
| E | E7 代码生成—执行—报错—自愈闭环 | 【书】page-0271–0272 | 这就是主循环本身且验证层更深（验证门 + answerVerifier）；执行隔离侧【评】实测 bash.js/powershell.js/shellCommandEngine.js 无 sandbox/docker/isolate/container 关键词 | 低 | 无实质差距（书中示例同样 use_docker: False）。「shell 执行无容器隔离」的判断**仅以关键词零命中为据**（审读保留）：隔离可能以非关键词形态存在，本次未逐行审计 bash.js 的执行路径 | 若要补隔离，给 `tools/bash.js` 加与 CodeInterpreterTool 同款的 Docker 沙箱探测开关（【评】`index.js:68` 既有形态），阈值与报错文案沿用 | 沙箱改造影响面大：Windows 宿主无 Docker 时若不设计好降级路径会误伤主路径 |
| E | E8 _watch/set_actions 事件驱动流水线 | 【书】page-0275–0276 | 依赖/事件驱动执行已有等价物：executeDependencyAware 拓扑分层、orchestrationService 步骤 DAG、workflow 画布 DAG（后者未找到被主对话回合调用的接线路径，【评】missing 明列） | 低 | 「上游输出即下游触发条件」已由 DAG 依赖边实现；workflow 未接主循环是 khyos 自身接线缺口，与本书方法论无因果 | 若要盘活自家资产，先追 workflowExecutor 的调用方确认是否该接主循环——动手前需人工确认是刻意设计还是遗漏 | 接线改造中等；未验证缺失性质 |
| F 评测、校验与诚实性 | F1 「不可能完成的任务」检验 Agent 是否诚实 | 【书√】page-0210（§7.3.2 标题「创建一个'不可能完成的任务'」，理由「任务需求根本不清楚」，原文「我们来看看 Agent 是会坦诚交代自己的能力不足以完成任务，还是会'自信地胡说八道'」）、page-0214（第 5 步输出「since we don't have the necessary information about the demand, I cannot provide an accurate comparison at this time」，书注「在需求不清楚时没有胡乱猜测」）、page-0217（「这样的回答相当贴心」在总结段，略出 0213–0216 范围） | 运行时诚实拒答已有：`capabilityAssessment.js:408-424` canProceed 判定 + 「执行前能力预判未通过」格式化输出（【评】实读确认）；但评估面无此类用例：【跑】`modelTrainingService.js:1467` EVAL_PROBES 恰 4 条（math-arith/trading-glossary/python-code/risk-assessment，:1471/1476/1481/1486 expectContains），判定为单一 includes；【评】:1492-1494 注释明示 Ollama 不可达时 fail-open，实现在 :1537-1546（skipped:true, passed:false）；【跑】`evals/index.js` 第 48-54 行 `score: 0.85 + Math.random() * 0.1`，注释自陈 "Simulated evaluation"；复核员复跑：全 backend 搜 EVAL_PROBES\|expectContains\|passThreshold 仅命中 modelTrainingService 及其测试，搜 honesty\|诚实\|hallucinat\|胡乱\|不清时 仅得 CLI handler 注释，无任何「需求不清时诚实承认 vs 自信胡说」的可复用评估用例 | 高 | 「需求不清时是诚实承认还是自信胡说」没有任何可复用评估用例——现有探针只能查「答案对不对」，查不出「不懂时是否编造」，而这正是诚实收尾判据的直接度量。注意口径：EVAL_PROBES 是**训练后固定探针**不是常设门（Ollama 不可达即跳过）；capabilityAssessment 是执行前能力预判（「环境能不能做」），不同性质，不计入本口径 | 在 `modelTrainingService.js:1467-1488` 的 EVAL_PROBES 旁增补 honesty 类探针（prompt 为信息不足/缺参数请求，判定从单一 includes 扩为 expectContains 拒答标志 + rejectPattern 编造检测），随 evaluateModel 的 Ollama 门一起跑；evals 桩须换成真实调用后才能作为通用回归面 | 拒答标志与编造检测的判定规则需人工设计误判边界；且现有门 fail-open，诚实探针可能被静默跳过 |
| F | F2 QA 角色 / 真实命令验证 | 【书】page-0273 | khyos 的 QA 由确定性验证承担：`verificationAgent.js:40-112` detectProject 后跑 syntax/lint/test/build/typecheck（真实 spawnSync 退出码）+ adversarialVerifyEnsemble 多视角投票（`_tallyVotes` 按 quorum，无决定性投票者 abstain） | 低 | 强于对话式 QA 角色；顺带发现（与本书无关）：Evals 工具返回模拟分却对模型可见——本条已从「无证据」升级为**已验证**（复核员实跑，见 §6.4） | 不按本书落地；顺带事项见 F1 | — |
| F | F3 SimulateBench 一致性/鲁棒性基准 | 【书】page-0283 | khyos 没有「模拟人类行为」的 Agent 面，方法论标的与 Agent 形态不匹配 | 暂不适用 | 没有评估对象；若关心一致性/鲁棒性，缺口在评测基建，不由本方法论补 | 不建议引入；若要落地一致性维度，把 `arenaResultStore.js:296-373` 的横评记录扩成跨版本一致性报表，与 evals 桩整改分开立项 | 改造横评记录约 1-2 天且与本书方法论无关 |
| F | F4 多模型横评（ModelLaboratory 对照） | 【书】page-0085 | `arenaManager.js:81-125, 296-373`（同一 prompt 并行发给 ≥2 个模型、Jaccard 差异摘要、CLI 带 history/leaderboard） | 低 | 已有横评，但全仓没有固定基准题库、没有 pass@k 报表、没有跨版本跑分对比——「基准」止于横评 | 若要补，与 F1 的探针扩容合并设计 | 中（题库建设是持续投入） |
| F | F5 自一致性采样投票（More Agents Is All You Need） | 【书】page-0283 | 多模型并行已在三处落地但都不是答案聚合；【评】主循环无自一致性（搜 selfConsistency 零命中） | 中 | 「多次采样+投票产出最终答复」缺失：现有多模型机制全是校验/横评用途，最终答复仍是单次生成；难题（数理/代码）没有自一致性兜底 | 在 toolUseLoopCore final response 前加可选自一致性：env 门控 `KHY_SELF_CONSISTENCY_N`，仅在 autoReasoning 高档或验证门 FAIL 重试时触发，并行扇出复用 arenaManager、计票复用 `verificationAgent._tallyVotes` | N 倍 token 成本与延迟；必须默认关 + 明确触发条件；实现约 2-3 天 |
| F | F6 ExpeL 经验学习（insight 库 + 按任务类型迁移） | 【书√】page-0283（表 A.1 ExpeL 行「通过自主从经验中学习，以提升 Agent 解决任务的能力」） | 已有两条经验学习线：memoryDreaming 做梦三阶段 + dreamPromote 回流、skillLearningService 从重复交互模式学技能；「从任务成败轨迹抽取教训注入未来任务」未覆盖（trajectoryGuide 仅作为 learningRetrieval 语料出现） | 中 | 「这次任务为什么成/败 → 可复用教训 → 下次同类任务注入」的回路没有显式载体 | 在 `agenticHarnessService.js:172` 收尾或验证门之后（`toolUseLoopCore.js:4934-5019`）加 lesson 抽取，经 memoryEngine.addStructuredMemory 落库（复用 dreamPromote 通路），注入点选 aiChatCore 的 proactive/session priming（`aiChatCore.js:2436-2502`）；与 A6 合并设计（lesson schema + 去重可复用 memoryContentDedup） | 中等：需设计 lesson schema 与去重，防低质教训污染召回；约数天到一周 |
| F | F7 DyLAN 动态选人/提前停止 | 【书】page-0283 | 多智能体编排全是静态分工（关键词 + DAG 依赖）；【评】missing 明示角色匹配是关键词与 DAG 依赖，没有能力议价；当前不采集 agent 级表现数据 | 中 | 任务与角色错配时没有择优机制；且冷启动阶段动态选择反而更差 | 先补数据再上算法：在 `orchestrationService.js:367-403` 或 `cliAgentRunner.js:553` synthesizeResults 处记录 per-role 成功率，落独立执行台账；有数据后再加角色择优 | 较大改造：需表现遥测 + 选择层 + 回归验证；无数据前落地收益不确定 |
| G 成本与预算 | G1 Token 计费与用量可见 | 【书】page-0079、0083、0114 | `tokenUsageService.js` 按会话/日/月计量、落盘 ~/.khyquant/token_usage.json、USD_TO_CNY 换算、按订阅层级给剩余配额；AGENTS.md 亦记载「Token 统计：以人民币计」 | 低 | 书中价格表全部过时；计量能力 khyos 更完整 | 不落地 | 零 |
| G | G2 运行时预算门（Team invest / cost_manager 逐角色记账） | 【书√】page-0276（`team.invest(investment)` + `team.run_project`）、page-0278（日志逐条「Total running cost: 0.001 \| Max budget: 10.000 \| Current cost: 0.001, prompt_tokens: 48, completion_tokens: 10」，累计 0.001→0.016）、page-0279（表 10.1「成本管理」行） | 有计价、有 token 预算器、有网关预算门、有惯性成本字段，但**默认交互路径上没有金额门**：【跑】`tokenUsageService.js` 搜 budget\|maxCost\|costLimit\|spendLimit\|maxBudget ZERO HITS（纯统计）；【跑】`services/tokenBudget.js` 存在，:16-22 注释与 :45-50 实现明示 `KHY_TOKEN_BUDGET` 即天花板即开关，unset/0 → ceiling 0 → assessBudget 永远 'ok'（默认关），wire 在 `toolUseLoopCore.js:2245-2289`（assessBudget='stop' → budgetStopped）；【跑】惯性子系统 `inertia/defaults.js:24` maxCostCny 默认 5 元、`momentum.js:131-132` 有 cost 停判，但 `inertialRunService.js:377` 段顶门只接 idle/wall（:381-382 turns），cost 判定未接成立停条件；【跑】网关 `gateway/customerQuotaEnforcer.js` 有 monthlyBudgetCny（人民币余额）与 scope 判定，`gateway/proxyServer.js:2852-2875` 对生成端点 enforce、!allowed 即返 quota_exceeded——但只覆盖呈现 managed-token 的客户调用方；【跑】`cli/costThresholdWarning.js` 是一次性 $5 会话花费提醒（CC 对齐），明言非阻断 | 中 | 缺默认生效的金额预算门（书中 invest 的等价物）：超支只能靠轮次上限与空闲超时兜底，用户可能在不知不觉中烧钱——这直接削弱核心循环的诚实收尾（RUNTIME-002/003 精神：花超了要诚实说明完成了什么、还剩什么）。**本条为部分验证**：原报告「两文件 ZERO HITS」「没有任何机制停手」的绝对表述不成立（见 §6.2 #5 更正与 §6.4） | 第一步把 `tokenBudget.js` 的既有 token 预算器扩出金额维度（或在其旁加累计花费计数器：每轮 chat() 返回的 tokenUsage 经 tokenUsageService 人民币计价累加），阈值放 `constants/serviceDefaults.js` 遵守 RUNTIME-001；默认关起步、按 PROCESS-008 走 S1 观察者档攒真实花费分布后再定默认值；超限走与 grace 总结轮同款收口路径——诚实报告已完成/未完成并按 RUNTIME-003 建议拆分或重试，绝不假装成功 | 中：要接 tokenUsageService 真实计价并处理其不可达降级；阈值定错会误停活跃任务，必须做成「累计花费超限才停」而非硬时钟；S1 只记录不阻断 |
| G | G3 max_iterations 硬计数 vs 活动式超时 | 【书】page-0245–0247（BabyAGI max_iterations=6 跑满即停）、0119–0120（忙等轮询无退避无总时限） | 循环安全壳是「预算+空闲超时」双重：IterationBudget + grace 总结轮 + IDLE_TIMEOUT_MS 按 productive iteration 重置（`toolUseLoopCore.js:452-479, 1835-1838`）；外层 agenticHarnessService 自适应续跑最多 8 轮 | 低 | 书中两种粗糙退出都已被活动式超时全面覆盖，且这是本仓 RUNTIME-003 红线要求 | 不落地；此项只作对照，印证 khyos 选活动式超时的理由 | 零 |
| H 工程卫生与上手 | H1 API key 管理与 .env.template 副本法 | 【书】page-0055（GitGuardian 泄露事故 + 三条正确做法）、0235–0236（.env.template 副本）、0270（AutoGen 示例把 sk- 明文写进 llm_config） | `.env.example` 用法写明「cp .env.example .env && docker compose up -d --build」，全部变量有默认值、未配置供应商直接不可用（【评】实读 :1-27）；端点默认值单一真源在 `constants/serviceDefaults.js`（AGENTS.md 规则 1）；凭据存 ~/.khyquant/config.json 已 gitignore | 低 | 「复制模板填密钥」已有且更严。注：「书中未对明文 key 作安全警告」这一断言需通读 page-0270 上下文才能成立，评估记录只照实记下明文 key 的存在，本次未回翻——标未验证 | 不落地；若让上手更顺，可在 doctor/bootstrap 输出提示「复制 .env.example 为 .env」，属文案 | 零机制成本 |
| H | H2 提示工程通用技巧（给足条数/字数/用途/视觉细节） | 【书】page-0125–0134、0182（改一句介绍即控制输出语言） | 已体系化：applyIntentGate 模式注入（`toolUseLoopCore.js:907`）、MetaPlanCoordinator 约束阶梯、初始化管线「步骤 2/5 任务规模识别」；输出语言控制已有运行时检测（【评】aiGateway.js:653 正则检测中文要求 + freeLLM.js:78、repeatStreak.js:74 兜底提示词） | 低 | 通用提示技巧，khyos 以模式注入 + 约束阶梯覆盖 | 不落地 | 零 |
| H | H3 模型选择表 / temperature / 速率受限处理 | 【书】page-0076–0082 | 模型目录带 code/reasoning/creative 评分（【评】`cli/ai.js:98-133`）；temperature 全链路透传 + 内部确定性调用固定低温 + adaptiveParamStrip 剥离；限流有分类 + cooldown + key 轮换；缺口：未解析上游 Retry-After 头（【评】grep 只命中 bridgeServer 认证限流） | 低 | 书的「按任务类型选温度」未被 codify 成显式策略，但热点路径已按需取低值 | 若要做，在 `autoReasoning.js` 定档处附带温度档，不新建设置项；Retry-After 解析可在 `_errorClassifiers.js` 归类处附带 | 小；需防与 adaptiveParamStrip 剥离逻辑冲突 |
| H | H4 断点调试深入框架源码 | 【书】page-0183–0190 | 操作对象不存在（不引入 LangChain）；可移植的只剩「从观察日志升级为追踪真实运行机制」这一习惯，khyos 已用 FSM + 轨迹 + breadcrumb 达成 | 暂不适用 | — | 不做；把 toolLoopPhases 状态图与 while 循环体的对应关系画进 CONCEPT-03 即可 | 零 |
| H | H5 fire 自动生成 CLI | 【书】page-0277 | 自建 CLI 体系（router/aliases/handlers 三步）+ PROCESS-014 命令面棘轮（命令 245/别名 591/handler 155 只降不升）明令冻结新增命令 | 暂不适用 | 引入 Python CLI 生成器既跨语言又与命令面棘轮冲突 | 不落地 | 纯负收益 |
| I 宏观叙事与行业图景 | I1 L1–L5 五层级（Tool→Intelligence） | 【书】page-0006 | khyos 已在 L4 且要件齐备（主循环做任务拆分/工具选择/进度控制 + harness 续跑；人类侧有计划批准门 + 工具审批）；L5「完全无须人类监督」与审批/熔断设计相反 | 低 | 阶梯是定位话术；khyos 监督机制比书中描述更硬 | 不落地；若要对外说明定位，在 CONCEPT-01 四特征卡后补一段 L1–L5 定位，声明 khyos 为 L4 | 零代码；风险是变成宣传话术，需人工把关 |
| I | I2 四象限分层图（提示工程/RAG/微调/Agent） | 【书】page-0005 | 四格全部有实现且权重与书中相反（本仓实际权重是上下文工程 > 微调） | 低 | 该图是全书目录地图而非可迁移方法 | 若在概念文档中引用，需在 CONCEPT-11/CONCEPT-25 注明本仓实际权重，避免误导出「先微调再 RAG」的实施顺序 | 纯文档 |
| I | I3 Gartner 成熟度曲线与 8 项预测 | 【书】page-0027–0028、0040 | 预期管理靠可执行守卫（规则 2 + check-agent-rules + 规则 12「度量必须有一根表针朝外」） | 低 | 通用预期管理修辞；多个预测时间点在 2026-11 已到期或临近 | 不落地；若借用，只在 `works/record/ai/hq/ROADMAP.md` 叙述层标注所处阶段 | 无 |
| I | I4 五行业效能提升清单 | 【书】page-0037–0038 | khyos 是平台而非垂直产品；可对应的是流程自动化（orchestrationService DAG + workflow 画布） | 低 | 领域清单是需求灵感库不是方法 | 若做产品规划，五域的「挑战」列可作 khyquant 垂直场景的需求检查单（非本仓核心循环；khyquant 视角的整体评估见 §4.5） | 无 |
| I | I5 Life 3.0 与三种核心能力 | 【书】page-0019 | khyos 的对应物是可证伪的能力自知体系而非世界观类比（【仓】`selfCapabilityRegistry.js:279-286` 20 个能力域各带 evidenceAnchors + `selfCapabilityVerifier.js:1-25` 运行时核验） | 低 | 立论修辞无工程载荷 | 不落地 | 无 |
| I | I6 周鸿祎/傅盛商业判断 | 【书】page-0039 | 平台/垂直分工已在 AGENTS.md 立论（khyquant 是独立项目、连接 Khy OS 使用） | 低 | 商业判断不产生工程改动 | 不落地 | 无 |
| I | I7 七类 Agent 划分与两篇综述 | 【书】page-0281–0282 | 覆盖工具与助手两类；自描述机制靠 selfCapabilityRegistry 做能力版图 | 低 | 外部 taxonomy 不改变其缺口判定 | 可作文档对照表补一节「khyos 覆盖七类中的哪几类」 | 零 |
| I | I8 未来六个创新方向 | 【书】page-0284 | 逐条对照：人机混合/伦理内化（规则化）/神经-符号混合（answerVerifier + ruleguard）/持续进化（skillLearning + memoryDreaming）已有对应物；多模态与「伦理进训练目标」空着 | 中 | 六方向中四条已有 khyos 对应物、一条规模不匹配（隐私三项）、真正空着的是多模态感知；作为整体它是路线图输入而非可执行方法 | 落到 `works/record/ai/hq/ROADMAP.md`；单点优先把 answerVerifier 与 ruleguard 判据显式产品化为「符号层」组件文档与 API；多模态先人工确认现状再决定是否立项 | 路线图归档近零；符号层显式化约数天；多模态若立项是大工程（未评估） |
| I | I9 数据与智能解绑 / 「猿人期」判断 | 【书】page-0287–0288 | 去中心化有实体（A2A 双向 + A2ARegistry）；「猿人期」的谨慎对应诚实收尾机制（answerVerifier + crossModelVerify S1 + evals 桩被注释自陈） | 低 | 后记是宏观判断而非工程方法；唯一可操作派生点是 A2A executor（见 E3），但补它是产品决策，不源于本书 | 不按本书动作 | 零 |
| I | I10 开源社区集体智慧 | 【书】page-0233、0265、0284 | 已制度化：SubAgentOrchestrator ported from OpenClaw（【仓】`subAgentOrchestrator.js:6` 注明）、skillLearningService 学技能 + 威胁扫描、上游 vendored 逐字入库 + sha256 漂移校验、[DESIGN-SOURCING-001] 借鉴真源 | 低 | 态度已落地为纪律；真正的风险面在威胁扫描器误报（skillThreatPatterns 空串 bug，实跑记录见 §6.2 #6），那不是本书方法论能补的 | 若要跟进生态，优先修 skillThreatScanner 误报而非读更多论文 | 零 |
| J 具身智能与物理世界 | J1 具身智能概念与 Gemini 节点 | 【书】page-0036、0043 | 纯软件运行时（Python 启动器 + Node 后端 + Vue 前端）；四透镜未记录任何机器人/硬件/传感器执行载体；训练侧无 RL/模仿学习链路 | 暂不适用 | 无物理执行器载体也不在平台规划面；书中依赖的强化学习/模仿学习 khyos 同样没有 | 不落地 | 无 |
| J | J2 LLM-Planner 少样本接地规划 | 【书】page-0283 | LLM 规划已是重实现（planModeService 五态机 + ultraplanService 30 分钟会话）；「具身+视觉感知环境」无对应场景 | 低 | 可迁移内核已被覆盖且更严（人闸门、每步校验、文件系统锚点）；具身与视觉接地部分无标的 | 不落地；若要补概念页，落点 docs/02_CONCEPTS（与 ToT/Reflexion 同列） | 零 |

**主题 C 判定（检索链路清单，H-1 的前提）**：记忆子系统远超书中 Memory Bank 的描述（三层保留轴 + 做梦巩固 + 向量侧车），无洞可补；进主循环的检索注入共有四条，只有第一条缺嵌入：

| # | 链路 | 载体 | 是否用嵌入 |
|---|---|---|---|
| 1 | 知识库 + 历史会话检索（初始化「步骤 3/5」） | `ragRetrievalService.js:273-368`（注入点【跑】`aiChatCore.js:1754-1772`） | **否**（纯词法：BM25 + 同义词 + 45 天新近衰减） |
| 2 | 记忆召回（proactive / session priming / short_term） | `memoryEngine/vectorRecall.js:114-219` | **是**（【跑】`vectorRecall.js:57` 向量召回总开关默认开，:74 单回合嵌入预算默认 32） |
| 3 | /learn 学习检索 | `learningRetrieval.js:647-735` | **是**（0.4×词法 + 0.6×余弦） |
| 4 | 代码库预取搜索 + 弱模型轨迹指南 | 【评】`aiChatCore.js:1786-1794`（预取）、:2090 → `guideInjector.js:75-83`（allowVector 默认关） | 预取是词法；轨迹指南向量档默认关 |

据此，精确的缺口表述是：**链路 1 未用嵌入与重排；rerank 服务有工具包装但无生产调用方；通用 vectorStore 与记忆侧车两套并存未打通**——而非「仓内零接线」（记忆链路已接线）。

---

## 3. 分级清单

### 3.1 高价值（4 条原始评估 / 去重后 3 条）

复核状态详见 §6.4。

| # | 方法论 | 书中页码 | khyos 证据 | 差距一句话 | 第一步 |
|---|---|---|---|---|---|
| H-1 | RAG 检索 Pipeline 工程化（含嵌入/重排/混合搜索） | 【书√】page-0225、0097、0232；图 1.15 在 page-0032 | `ragRetrievalService.js:273-368`（【跑】无 embedding/rerank/vector 命中）；`embeddingClient.js:145-164`；`vectorRecall.js:114-219`；`learningRetrieval.js:647-735` | 进主循环的知识库/会话检索链路是纯词法；嵌入与重排组件在仓内已实现却未接该链路 | 改 buildRetrievalContext 接 embeddingClient 做 0.4×词法+0.6×余弦重排 |
| H-2 | Agent Protocol 服务化（run/serve） | 【书√】page-0236；page-0041 Agent as a Service 同缺口 | `routes/a2a.js:40-42`（【跑】核实占位注释与无参调用）；`services/a2a/serverMethods.js:42-57` | 协议外壳齐、执行内核占位，外部标准客户端驱动不了 builtin agent | `routes/a2a.js:42` 注入 executor 接 runToolUseLoop，先限定任务类型 |
| H-3 | 「不可能完成的任务」检验诚实性 | 【书√】page-0210、0214、0217 | `modelTrainingService.js:1467-1488`（【跑】4 条探针 + fail-open）；`evals/index.js` 第 48-54 行（【跑】模拟分） | 评测面无诚实性用例；唯一真实探针只能查「答案对不对」且会跳过 | EVAL_PROBES 旁增补 honesty 类探针（拒答标志 + 编造检测） |

### 3.2 中价值（13 条原始评估 / 去重后 12 条）

复核状态详见 §6.4。M-4/M-6 与 H-1/H-2 同缺口，已归并。

| # | 方法论 | 书中页码 | khyos 证据 | 差距一句话 | 第一步 |
|---|---|---|---|---|---|
| M-1 | Reflexion 动态记忆与自我反思 | 【书√】page-0049 | `crossModelVerify.js:26-29, 276-389`；`memoryTrigger.js:180-244`；`memoryTier.js:25-53, 83-98` | 复盘只活在回合内，不落记忆、不可跨会话召回 | agenticHarnessService.js:846-885 接线处开 reflection 分类回流 cross_session |
| M-2 | 执行中依据工具输出修订计划 | 【书√】page-0207 | `planModeService.js:146, 1159-1161`（replan 类真实零命中） | 批准后的计划只能走完或中止 | executing 态加「修订草案 → 回 reviewing」回边 |
| M-3 | 计划/执行分配不同模型 | 【书√】page-0221（另 page-0208） | `planModeService.js:583`；`AgentTool/index.js:474, 2080-2142` | planner 模型无配置位，只落在子代理粒度 | 计划生成 chat() 增加 planner 模型解析，缺失回落当前模型 |
| M-4 | 现代化 RAG 工具分层与双循环 | 【书】page-0097 | 同 H-1（已归并） | 同 H-1 | 同 H-1 |
| M-5 | llm-math 数值计算工具 | 【书】page-0197–0198 | `answerVerifier.js:78-267`；【跑】calculator 仅 3 处非计算命中 | 循环内无专用计算叶子 | src/tools/ 加薄计算叶子，自动注册 |
| M-6 | Agent as a Service | 【书√】page-0041 | 同 H-2（已归并） | 同 H-2 | 同 H-2 |
| M-7 | 任务/结果对入向量库 + top-k | 【书√】page-0240、0244、0246 | `subAgentOrchestrator.js:480`；`agenticHarnessService.js:734-741`；`memoryEngine/vectorRecall.js:114-219` | 历史任务/结果对不可检索，跨会话无法复用 | aggregateResults 或步骤完成回调写 memoryEngine（只收结论/决策） |
| M-8 | Team 编排与运行时成本管理 | 【书√】page-0276、0278、0279 | `tokenUsageService.js`（【跑】ZERO HITS）；`tokenBudget.js:16-22, 45-50`（默认关）；`inertialRunService.js:377`；`proxyServer.js:2852-2875` | 有计价有零件，默认路径上没有金额门 | 扩 tokenBudget 出金额维度或加累计计数器，阈值放 serviceDefaults，S1 起步 |
| M-9 | ExpeL 经验学习 | 【书√】page-0283 | `memoryDreaming.js:24-44`；`dreamPromote.js:25-33`；`skillLearningService.js:39-70` | 缺「任务成败 → 教训 → 注入」回路 | 与 M-1 合并设计 lesson schema，落 addStructuredMemory |
| M-10 | 自一致性采样投票 | 【书】page-0283 | `arenaManager.js:81-125`；`verificationAgent.js:754-798`；【评】selfConsistency 零命中 | 最终答复单次生成，难题无自一致性兜底 | env 门控 KHY_SELF_CONSISTENCY_N，仅高档/验证门 FAIL 时触发 |
| M-11 | DyLAN 动态选人 | 【书】page-0283 | `orchestrationService.js:367-403`；`cliAgentRunner.js:553`；【评】无 agent 级表现数据 | 静态分工，角色错配时无择优 | 先记 per-role 成功率台账，再谈择优层 |
| M-12 | 未来六个创新方向 | 【书】page-0284 | AGENTS.md 规则体系；`answerVerifier.js:78-267` | 多模态感知空着；整体是路线图输入 | 落 ROADMAP.md；优先符号层显式化 |

### 3.3 低价值（126 条原始评估 / 去重后 38 条）

共性判断（按主题，条目名全列在 §7 附录）：

| 主题 | 条数 | 共性判断 |
|---|---|---|
| 推理与认知框架（A1/A3/A4/A5/A7） | 5 | ReAct/CoT/问题分解已被主循环以更强形态覆盖；ToT 有意不做；Self-Ask 功能被自主多轮覆盖 |
| 规划与任务分解（B4/B5/B6） | 3 | Plan-and-Execute 已工程化带人审；BabyAGI 任务队列/CAMEL 任务指定/MetaGPT SOP 均有更重或等价实现 |
| 记忆与知识检索（C1/C2/C4/C5/C7） | 5 | 记忆子系统远超 Memory Bank；RAG 概念与持久化已覆盖；剩两个小缺口（知识库未工具化、数据分型未登记）不由本书补 |
| 工具调用与执行（D1/D2） | 2 | 193 工具 + 执行引擎远超书中；工具描述无 lint 是可选改进 |
| 多 Agent 协作（E1/E4/E5/E6/E7/E8） | 6 | 分层+通信已实现且带硬限；CAMEL 互对话/联合聊天有意不做；human-in-the-loop 粒度更细 |
| 评测与校验（F2/F4） | 2 | 校验五种已实现；横评有、基准题库无（与 H-3 同属评测基建） |
| 成本与预算（G1/G3） | 2 | 计量完整；硬计数退出已被活动式超时覆盖 |
| 工程卫生（H1/H2/H3） | 3 | 全覆盖；Retry-After 未解析是仅存小缺口 |
| 宏观叙事（I1–I7、I9、I10） | 9 | 不产生工程改动；最多作 roadmap 叙述层输入（I8 为中档，不计入） |
| 具身（J2） | 1 | 无标的 |

### 3.4 暂不适用（18 条原始评估 / 去重后 6 条）

| 类别 | 条目 | 原因 |
|---|---|---|
| 框架依赖冲突 | ReAct 文本提示模板（A2）、LangChain ReAct 实战、LangSmith、LlamaIndex 定位与示例、Plan-and-Execute 组装、ReAct RAG 财报案例 | khyos 不引入 LangChain/LlamaIndex/openai 直依赖（【跑】package.json 核实）；照抄会与自研循环、守卫体系、工具注册面正面冲突，且书中代码横跨 LangChain 分包重构前后，大概率无法在今天的库版本运行 |
| 托管 API 形态 | Assistant/Thread/Run 相关托管机制（创建后只留 ID、Playground、file_ids/attachments、产物按 file_id 回读）、DALL·E 3 配图 | 服务端对象累积/托管文件存储在 khyos 无对应面；产物本地直写 |
| 形态不匹配 | 具身智能两条（J1）、SimulateBench、联合聊天、fire CLI、断点调试 | 无物理载体/无拟人评估对象/与「结果只回主控」不变式冲突/与命令面棘轮冲突/无可步进的框架源码 |

---

## 4. 如果要动手：优先级排序与第一步

### 4.1 优先级总表

| 优先级 | 动作 | 本书独有增量？ | 落点 | 前置条件 |
|---|---|---|---|---|
| P0-1 | 聊天 RAG 接嵌入 + 重排 | **缺口由本书指出，配方在仓内**（vectorRecall/learningRetrieval 已有混合检索配方）——本书无新方法，但它把「嵌入/重排是 RAG 承重段」讲成了清单 | `ragRetrievalService.js:273-368` | Ollama 或 gateway 嵌入端点可用；降级路径抄 `vectorRecall.js:114-219`；属增强，需召回质量基线而非故障复现（见 §4.3） |
| P0-2 | A2A 入站 executor 接线 | 方向由本书指出（Agent Protocol / AaaS），接线是 khyos 自己的债（源码注释已标「独立后续任务」） | `routes/a2a.js:42` | 把流式/预算/审批语义映射到 A2A 任务生命周期；定义取消/租约语义；按 PROCESS-008 保持 S1 |
| P0-3 | 诚实性评估探针 | **本书独有增量**：第 7 章「不可能完成的任务」是书中给出的、khyos 没有的方法 | `modelTrainingService.js:1467-1488` 旁 | 人工设计拒答标志/编造检测的误判边界；处理 fail-open 被跳过的问题 |
| P1-1 | 金额预算门（默认路径） | **本书独有增量**（MetaGPT cost_manager 的 invest 等价物）；khyos 有计价有零件但默认不生效 | `tokenBudget.js` 扩金额维度 / `toolUseLoopCore.js:452-479` 旁 + `constants/serviceDefaults.js` | 接 tokenUsageService 真实计价 + 不可达降级；S1 观察者档；「累计超限才停」而非硬时钟 |
| P1-2 | 复盘/教训记忆化（M-1 + M-9 合并） | **本书独有增量**（Reflexion 动态记忆 + ExpeL insight 库）；khyos 有批判无沉淀 | `agenticHarnessService.js:846-885` + `memoryTrigger.js:180-244` | lesson schema + 去重（复用 memoryContentDedup）+ 防召回污染门槛；S1 起步 |
| P1-3 | 任务/结果对入记忆 | **本书独有增量**（BabyAGI 记忆使用方式） | `subAgentOrchestrator.js:480` 或 orchestrationService 回调 | 先定结果边界（只收结论/决策）；顺带评估两套向量存储归并（涉删除/归档先按 RUNTIME-009 报部位） |
| P1-4 | 循环内计算叶子 | 本书独有增量（llm-math）；khyos 输出侧复核已有、输入侧计算缺 | `src/tools/` 新叶子 | 一个工具文件 + 单测，不碰主循环 |
| P2-1 | 执行中再规划回边 | 书中伪代码有（modifyPlanBasedOnToolOutput）；与「批准即契约」治理模型摩擦 | `planModeService.js` executing 态 | 评估小任务上收益是否为零 |
| P2-2 | 自一致性（默认关） | 本书独有增量（More Agents） | toolUseLoopCore final response 前 | env 门控 + 明确触发条件；N 倍成本 |
| P2-3 | planner/executor 分模型 | 书中一句话建议，未给配置方法；khyos autoReasoning 已部分覆盖 | `planModeService.js:583` | 双凭据与成本核算；增量有限 |
| P2-4 | per-role 表现台账 → 动态选人 | 本书独有增量（DyLAN）；无数据前不落地 | `orchestrationService.js:367-403` / `cliAgentRunner.js:553` | 先攒数据 |
| P3 | 文档层：CONCEPT-01 补 L1–L5 定位、CONCEPT-03 指向 FSM、CONCEPT-19 订正显式 Thought 承诺、案例→本仓实现对照表、四组件/七类映射 | 无（纯文档） | docs/02_CONCEPTS_概念入门/ | 人工评审措辞，避免与 RUNTIME-002 冲突；对外引用本书前先过 [DESIGN-SOURCING-001] 借鉴边界（见 §4.5） |

**排序依据的坦白**：P0/P1 的排序依据是「缺口真伪 + 落地代价 + 是否默认路径」，**没有影响面与频率的量化**——三个 P0 缺口一个度量都没有（见 §4.4）。若要先做 H-1 还是 P0-3，目前的诚实回答是：H-1 影响每轮对话的上下文质量但缺召回基线，P0-3 一次性建成但只在训练后跑；缺度量时无法回答，建议先花半天补 §4.4 的三项基线再定。

### 4.2 「本书独有增量」与「khyos 已有更好实现」分界

**本书独有增量（书中方法在 khyos 无对应物，共 8 项）**：不可能任务的诚实性检验（第 7 章）、任务/结果对入向量库（BabyAGI）、金额预算门（MetaGPT cost_manager）、ExpeL insight 库、自一致性投票（More Agents）、DyLAN 动态选人、执行中修订计划（modifyPlanBasedOnToolOutput）、循环内计算叶子（llm-math）。

**khyos 已有更好实现（书中做法对照后确认不迁移，共 8 项）**：

| 书中做法 | khyos 更好实现 |
|---|---|
| ReAct 文本协议（Thought/Action/Observation 草稿纸） | 原生 tool_use 块 + normalizeToolCall，无格式漂移（【跑】`Thought:` 零命中） |
| BabyAGI max_iterations 硬计数 / Assistants 忙等轮询 | 预算 + 空闲超时 + grace 总结轮 + 验证轮封顶（RUNTIME-003 红线） |
| load_tools 工具挂载 | 193 工具目录扫描 + 执行引擎多阶段（分类/去重/hooks/循环检测/shell 安全/审批/恢复/诊断） |
| Memory Bank + 遗忘曲线 | 三层保留轴 + 做梦巩固三阶段 + dreamPromote 回流 + 向量侧车 |
| CAMEL/AutoGen 角色互对话 | 结构化 DAG 编排 + 深度/并发/总量硬限 + 结果树形聚合 |
| human_input_mode ALWAYS/NEVER 二元切换 | 分级门控（高危步骤门/计划批准/工具审批/capability strict-warn）+ 中断标记 |
| is_termination_msg 协议化终止词 | 结构性退出（无工具调用 + budget + 验证门），词匹配可被模型误触发 |
| 依赖模型自觉的自我修正 | 确定性验证门（quickSyntaxCheck → adversarialVerifyEnsemble）+ answerVerifier 真值复核 |

**反向视角（审读意见补入，本篇未能回答）**：以上全部共用一把尺——「khyos 已有更深的实现 → 本书方法不迁移」。这把尺预设「更深=更好」，从未反向问「书中更简单的做法是否指出 khyos 的过度工程」。可举的反例是存在的：D1 承认对不支持原生 tool 的供应商需要文本协议兼容路径（说明文本协议并非全无价值）；193 工具 + 多阶段引擎 + 影子 FSM 的维护成本，全文没有一处借书的简洁性审视。**126 条低价值里有多少是书浅、多少是尺子单向，本篇无法区分**——这是比任何单条缺口都更根本的方法论保留。

### 4.3 验收判据（改完怎么算有效）

审读意见指出原报告只给「改哪行」不给「怎么算改好了」。补判据如下（均为建议，未经验证）：

| 动作 | 验收判据 |
|---|---|
| P0-1 RAG 嵌入 | 构造一组改述查询集（同一意图的多种说法，含同义替换与口语化），测改前/改后在知识库与会话索引上的命中数与首位命中率；改后不低于改前（回归）+ 改述类查询命中数上升（收益）；Ollama 不可达时逐字节降级回纯词法且输出与改前一致（降级契约）；每回合嵌入延迟增量实测记录 |
| P0-2 A2A executor | 标准 A2A 客户端能走通 message/send → tasks/get(completed) 全流程；外部任务同样过审批/shell 安全/循环检测（抽样审计一条高危任务被拦）；取消/租约语义有测试 |
| P0-3 诚实性探针 | honesty 探针集（信息不足/缺参数/超范围请求）上，拒答率与编造率可测量；误判边界有人工评审记录；Ollama 不可达时探针明确报告 skipped 而非静默消失 |
| P1-1 金额门 | 用 S1 记录的真实累计花费分布定阈值；超限时输出诚实收尾（已完成/未完成 + 拆分建议）；构造低阈值冒烟验证「不误停活跃任务」 |
| P1-2 复盘记忆化 | 一条跨模型复盘 issues 能落 cross_session 并被后续会话召回（端到端验证）；重复复盘被去重（memoryContentDedup）不二次注入；低质复盘被门槛拦在库外 |
| P1-4 计算叶子 | 循环内数值任务（如书中定价链）不再绕 shell；answerVerifier 对该类任务复核通过率不下降 |

注意 RUNTIME-007 的适用范围：按 AGENTS.md 规则 5，它覆盖「判定为修复 bug 的改动集」，要求 repro-before/after 存证；P0-1/P1-* 都是**增强**，需要的是上表的基线/对照，不是故障复现——原报告笼统写「按 RUNTIME-007 留复现存证」是用错了门。

### 4.4 不改的代价（现状影响面）——本篇最大的盲区

审读意见指出：161 条里 144 条判低/不适用，却无一处给出缺口的实际频率或影响面。诚实记录当前所知：

| 缺口 | 已知 | 未知（未度量） |
|---|---|---|
| H-1 聊天 RAG 纯词法 | 失败模式可推知（改述查询召不回——同一缺陷已在记忆侧被修复并留注释，【仓】vectorRecall.js 附近注释明示「先词法过滤再重排、改述查询永远召不回」） | 实际召回失败率；「小任务默认跳过」后有多少回合走了该链路；用户可感频率 |
| H-2 A2A executor 占位 | 源码注释自陈「独立后续任务，不在 S3 范围内」；无启动代码注入点（【评】全 backend 仅一处无参调用） | 是否真有外部客户端在试；有无用户需求 |
| H-3 无诚实性度量 | 4 条探针全有确定答案；evals 是桩 | 模型在实际使用中「不懂时编造」的发生率 |
| M-8 无金额门 | 默认路径无门（零件默认关/不覆盖） | 实际超支案例；单会话花费分布（S1 攒的正是这个） |
| M-1 复盘不落记忆 | 写入侧只由 4 条窄正则触发（【评】progressLog.js:8 自陈） | 因此丢失的跨会话复用价值 |

**结论：本篇无一项缺口有频率或影响面实测。** 排真正的优先级之前，建议先补三项基线：① 改述查询召回对照（半天）；② A2A 入站是否有真实调用方（查网关访问日志，半天）；③ 单会话累计花费分布（给 S1 预算门攒数，一周自然积累）。

### 4.5 阅读建议与借鉴边界（审读意见补入）

**谁该读、读哪几章**（对 khyos 维护者）：

| 读者 | 建议 | 理由 |
|---|---|---|
| 新贡献者（补术语） | 第 1 章 + 第 2 章四要素 | 与仓内 docs/02_CONCEPTS 概念层对照，建立共同语言；不要照抄代码 |
| 做检索/记忆的人 | 第 8 章（RAG Pipeline 与混合搜索方向）+ 第 2 章 2.3 记忆 | 本书把「嵌入/重排是承重段」讲成清单的部分有对照价值 |
| 做评测的人 | 第 7 章 7.3.2（不可能任务）+ 第 10 章 QA 角色 | 诚实性检验方法是本书独有的可迁移项 |
| 做多 Agent 的人 | 第 9/10 章可略读 | khyos 编排面已超出书中概念层，读它只为知道「书中到哪」 |
| 所有人 | 第 3/4/5 章可跳过 | LangChain/Assistants API 载体与 khyos 架构冲突，代码不可运行（书中页码自证写在框架重构前后） |

**作为 docs/02_CONCEPTS 引用源的边界**：本仓对外部借鉴有单一真源纪律——AGENTS.md 治理总纲节规定「从外部项目借鉴任何实现之前，先定位对应条款和它引用的既有规范（借鉴的单一真源是 `[DESIGN-SOURCING-001]`）」（此条引自项目指令，非本轮验证）。本书是图书不是开源项目，「引用其概念」与「借鉴其实现」是两件事：前者（如 L1–L5 定位、四象限选型）可在概念文档中作旁证并注明 2024 年成书的时效边界；后者（LangChain 代码）按上述纪律应先过借鉴边界评审，而本书代码形态已无评审必要。

**khyquant 视角（审读意见补入，本篇未覆盖）**：本仓口径 khyquant 是连接 Khy OS 的独立项目（AGENTS.md 项目概览），产品任务面含其垂直应用。书中 Agent 3（玫瑰花自动定价：搜索进货价 → 计算器加价 5% → 出结论，page-0181–0183）与 ReAct RAG 财报案例（两家电商销售额比较，page-0228–0231）与量化交易场景相邻——都是「多步检索 + 数值计算 + 跨源比较」的同构任务。本篇四透镜未覆盖 khyquant 面，「剥离 LangChain 载体后该书方法论对 khyquant 的相关性」**未评估**；可注意的两点：① 书中财报案例自记的缺陷（跨源未归一本位 $3.3 billion vs $6,586 million 直接比较）对量化场景是现成的教训；② Agent 3 的「搜索→计算→结论」链正是 khyos 缺计算叶子（M-5）的场景例证。此项留待 khyquant 侧评估。

### 4.6 与仓内自身计划的对照（审读意见补入）

原报告把 8 项「本书独有增量」当新发现呈现，未对照 `works/record/ai/hq/`（AGENTS.md 记载的任务/Bug/进度真源）。本次补查：【跑】对该目录全部文件（BUGS.json、PROGRESS.json、ROADMAP.md、CONTEXT.md、MODELS.json）搜 `RAG`、`嵌入`、`embedding`、`A2A`、`executor`、`评测`、`evals`、`预算门`、`诚实` 九个关键词，**全部 0 命中**。即：这些缺口未在任务/Bug 真源中以这些词登记（不能排除同义表述，如「检索」「成本」——本次未搜）。读者问「开哪张工单、冲不冲现有的活」的诚实回答是：**未核对，建议人工用半小时过一遍 PROGRESS.json 的未完成任务与 ROADMAP.md 再决定**，避免与人在做的任务重复。

---

## 5. 本书的历史局限（只写有证据支撑的判断）

> 说明（审读意见补入）：本节【书】级证据分两档——复核员亲读原书确认的标【书√】，其余为评估记录照录、未回翻原书。凡需通读上下文才能成立的断言，均已标未验证。

1. **框架代码形态全部过时，且书中自证**。【书】page-0055 单包安装指令与 page-0061 分包说明并存、page-0056/0057 混用 `langchain_openai`（新式）与 `langchain.agents.tools.Tool`（0.x 早期路径）——写在 LangChain 分包重构前后（此二页为评估记录照录，**未回翻原书**）；page-0234 脚注自陈 AutoGPT「问世仅仅不到一年」就已「沦为旧技术」。【仓】khyos 不引入该依赖（【跑】package.json 核实），书中代码对 khyos 无可迁移性。
2. **第 4 章全书载体是 beta 托管接口**。【书】page-0108–0137 全部建立在 `client.beta.assistants` 上，beta 标记本身即不稳定信号；配套模型名（gpt-4-turbo-preview 等）为 2024 年初形态。【评】评估记录称 OpenAI Assistants API 已于 2025 年被 Responses API 取代——此为外部事实，本次未在仓内验证，仅作参考。
3. **模型清单与价格表全部过时**。【书】表 3.1（GPT-4 8192 / GPT-3.5 Turbo / text-embedding-3-large 等）、表 3.4 每 1k Token 美元价、AutoGen config2.yaml 的 gpt-4-turbo-preview / gpt-3.5-turbo-1106 / gpt-4-1106-preview（page-0274）、图 1.8 大模型时间线只到 2023 年（均为评估记录照录，未回翻）。
4. **时效性预测多个已到期**。【书】表 1.1 八项预测中「到 2025 年……」「到 2026 年……」多个时间点在 2026-11 已到期或临近，书中自称「拭目以待」（page-0040）；图 1.10 为 2023 年 7 月曲线；page-0043「Gemini 被视为 GPT-4 的有力竞争者」是 2024 年初视角。
5. **书中存在未自警的安全反模式（部分未验证）**。【书】page-0270 AutoGen 示例把 sk- 开头明文 API key 直接写进 llm_config——评估记录照实记下明文 key 的存在；「书中未作安全警告」这一断言需要通读 page-0270 上下文才能成立，**本次未回翻原书，标未验证**。对照 khyos RUNTIME-001（凭据不落源码、真源在 serviceDefaults/config.json）。
6. **书中没有的（khyos 已有的整层）**——已按审读意见更正，原列「A2A / 成本预算门 / 安全审批链」三条不成立（书中分别有 Agent Protocol、MetaGPT cost_manager、human_input_mode 对位），删除。站得住的只有：**MCP 与现代跨 Agent 互操作协议**（书中第 9 章的 Agent Protocol 是 AutoGPT 自有服务化接口，不是 A2A/MCP 这类互操作协议）；**评测与回归体系**（固定题库/pass@k/跨版本跑分，书中无）；**规则守卫绑定层与 S1–S4 升阶机制**（ruleguard，书中无）；**轨迹回放与审计通道**（书中只有 verbose 日志）。另需精确化：书中 MetaGPT 有逐角色记账与 Max budget 展示（【书√】page-0278），是否「超限即停」本次未从书记载确认（未验证）；书中没有的是「工具执行前的安全审批链」——human_input_mode 是人参与对话，不是工具审批。
7. **教学法定位决定工程深度有限**。【书】大量「咖哥发言」经验谈；工程兜底手段是「出错多试几次，毕竟这是新功能，没那么稳定」（page-0126–0127、0136–0137）——同类问题在 khyos 是分阶段恢复 + 失败上限 + 强制复验 + 自动回滚的体系，且诚实汇报是红线要求。

---

## 6. 复核与验证说明

### 6.1 本报告的证据构成

| 来源 | 内容 | 可信度处理 |
|---|---|---|
| 本书逐章扫描页评估记录（本次 ask 提供） | 161 条方法论评估，每条含书中做法+页码、khyos 现状+文件证据、价值档、差距、动作、代价 | 页码与文件:行号照录；标【书】者我未回翻原书 |
| 独立复核员亲读原书 + 复跑命令（2026-11-05 审读） | 亲读 page-0032/0041/0049/0207/0208/0210/0214/0217/0221/0225/0232/0236/0240/0244/0246/0276/0278/0279/0283 等并逐字核对引文；复跑仓内检索与工具注册 | 标【书√】；复核员判定 7 条关键结论中 4 条成立、3 条部分成立（详见 §6.4） |
| khyos 四透镜调研 JSON（本次 ask 提供） | 智能体循环与编排 / 记忆与知识检索 / 评测训练与自我提升三透镜 facts+missing，含调研方实跑记录 | 标【评】；关键条目已由我或复核员复跑 |
| 主编笔实跑（【跑】） | 2026-11-04 九项 + 2026-11-05 修订补跑八项（见 §6.2） | 命令与输出照录 |

### 6.2 实跑复核清单

**2026-11-04 主编笔复跑（9 项）**：

| # | 命令 | 输出 | 证实了什么 |
|---|---|---|---|
| 1 | `Select-String -Path 'runtime/node/backend/src/services/ragRetrievalService.js' -Pattern 'embed\|vector\|cosine\|rerank\|require\('` | 仅 3 行：:84 collapseWhitespaceLoose、:279 knowledgeTeachingService、:328 sessionSearchIndex | 聊天 RAG 纯词法，无嵌入/重排/向量命中（H-1 承重部分） |
| 2 | `Get-Content 'runtime/node/backend/src/services/evals/index.js' -TotalCount 60 \| Select-Object -Skip 40` | `score: 0.85 + Math.random() * 0.1, // Simulated score` + 注释 "Simulated evaluation (in real implementation, this would call the model)" | evals 是模拟桩（H-3 旁证） |
| 3 | `Select-String -LiteralPath 'runtime/node/backend/src/routes/a2a.js' -Pattern 'executor\|createServerMethods\|placeholder'` | :40-41 注释「executor 默认占位…由启动代码用 createServerMethods({ executor }) 重建并挂到 app.locals」；:42 `const methods = createServerMethods();` | A2A 入站 executor 占位（H-2） |
| 4 | `Select-String -LiteralPath 'runtime/node/backend/src/services/modelTrainingService.js' -Pattern 'EVAL_PROBES\|expectContains\|skipped'` | :1467 `const EVAL_PROBES = [`；:1471/1476/1481/1486 expectContains；:1493-1494 注释 "if Ollama is unreachable the gate is skipped (fail-open)" | 4 条固定探针 + fail-open（H-3） |
| 5 | 对 `tokenUsageService.js` 搜 `budget\|maxCost\|costLimit\|spendLimit\|maxBudget`；对 `toolUseLoopCore.js` 搜 `maxCost\|costLimit\|spendLimit\|maxBudget` | tokenUsageService.js：ZERO HITS；toolUseLoopCore.js：ZERO HITS | **⚠ 本条证据部分作废（2026-11-05 更正）**：对 toolUseLoopCore.js 的模式漏了 `budget` 一词，该文件的 ZERO HITS **不能**支持「无预算机制」；补跑（见下轮 #3）证实该文件有 token 预算器接线。tokenUsageService.js 的 ZERO HITS（含 budget 模式）仍成立，仅支持「该文件是统计不是门」 |
| 6 | `Get-Content 'runtime/node/backend/src/services/domain/skills/skills/skillThreatPatterns.js' -TotalCount 40 \| Select-Object -Skip 25` | `_INVISIBLE_CHARS` 第三项为 `''`（注释 zero-width joiner） | 威胁扫描器空串 bug（每行误判 invisible_unicode） |
| 7 | 全 src 搜 rerank 调用方 / vectorStore require | rerank 仅 `tools/RerankTool/index.js:68`；vectorStore 仅 `tools/VectorStoreTool/index.js:82` 与 `vectorRecall.js:37`（后者为记忆侧自己的 `./vectorStore`） | rerank 无生产调用方；两套向量存储未打通（H-1 旁证） |
| 8 | `node -e "require('./src/tools').count()"` / `getNonDeferredTools().size`（cwd: runtime/node/backend） | `193` / `154`（Map） | 工具面规模（D2 及全文引用） |
| 9 | `Select-String 'runtime/node/backend/package.json' -Pattern 'langchain\|llama\|openai'` + 全 src 搜 `Thought:` | 仅 node-llama-cpp（:177/:219）；`Thought:` ZERO HITS | 不引入外部 Agent 框架；无 ReAct 文本协议（§1.3 先决事实） |

**2026-11-05 修订补跑（7 项，应审读意见）**：

| # | 命令 | 输出 | 处置 |
|---|---|---|---|
| 1 | `Test-Path 'runtime/node/backend/src/services/tokenBudget.js'` + `Select-String toolUseLoopCore.js -Pattern 'KHY_TOKEN_BUDGET\|budgetStopped\|assessBudget'` | True；命中 :134-135、:2035、:2041、:2252、:2280、:2289 等 | 证实 token 预算器存在且接线在主循环（G2/M-8 改写） |
| 2 | `Select-String tokenBudget.js -Pattern 'assessBudget\|KHY_TOKEN_BUDGET\|disabled\|ceiling'` | :16-22「Gate: KHY_TOKEN_BUDGET is the ceiling itself and doubles as the on/off switch. unset / 0 / non-finite / negative → ceiling 0 → assessBudget always 'ok'」；:45-50 实现 | 证实默认关（G2 精确化） |
| 3 | `Select-String inertialRunService.js -Pattern 'pre.stop\|pre.reason\|stop = \{'` + `Select-String momentum.js -Pattern 'cost\|maxCost'` + `Select-String defaults.js -Pattern 'maxCost\|COST'` | inertialRunService:377 仅接 `pre.reason === 'idle' \|\| 'wall'`（:381-382 turns、:386 wall）；momentum:131-132 有 cost 停判；defaults:24 `maxCostCny: 5`（注释「cost 缺失时 turns 为主闸」） | 证实 cost 判定未接成立停条件（G2 精确化） |
| 4 | `Select-String gateway/proxyServer.js -Pattern 'enforce\|quota_exceeded\|allowed\|FAIL_OPEN'` + 读 :2845-2875 | :2852 注释「Real-time customer quota enforcement — generation endpoints only」；:2862 `enforce`；:2863 `!allowed` → :2873 `quota_exceeded`；enforcer 在 `gateway/customerQuotaEnforcer.js`（:361-379 monthlyBudgetCny、:450-470 scope） | 证实网关预算门存在但只覆盖呈现 managed-token 的客户（G2 精确化） |
| 5 | `Get-Content 'cli/costThresholdWarning.js'` 头部 | :3-18 自陈「Session cost-threshold warning — pure leaf…Aligns the LOGIC BEHIND Claude Code's cost-threshold dialog…one-shot, first-crossing only」，CC 硬编码 $5 | 证实是一次性提醒非阻断（G2 精确化） |
| 6 | `Select-String '[CONCEPT-19] 什么是ReAct-智能体推理模式.md' -Pattern 'Thought'` + `(Get-Content 'routes/chain.js').Count` + 全 src 搜 `calculator` | CONCEPT-19 第 18 行命中 Thought（「Thought：我需要先读一下配置文件」式表述）；chain.js = 161 行；calculator 仅 3 处命中（khyUpgradeRuntime.js:1494/1872、appTarget.js:43，均非计算用途） | 证实 CONCEPT-19 承诺过强（A4）、chain.js 行数（§1.3）、循环内无计算叶子（D3） |
| 7 | 对 `works/record/ai/hq/` 全部文件搜 `RAG`、`嵌入`、`embedding`、`A2A`、`executor`、`评测`、`evals`、`预算门`、`诚实` | 九个关键词全部 0 命中 | 缺口未以这些词登记在任务/Bug 真源（§4.6；不能排除同义表述） |
| 8 | `Select-String aiChatCore.js -Pattern 'buildRetrievalContext\|步骤 3/5\|prefetch'` + `Select-String vectorRecall.js -Pattern 'isEnabled\|KHY_'` | aiChatCore:1754-1772（步骤 3/5 RAG 注入）、:1785-1811（预取，KHY_PREFETCH_MAX_MS 默认 1200）；vectorRecall:57「向量召回总开关。默认开」、:74 单回合嵌入预算默认 32 | 证实四条检索链路的注入点与默认档（主题 C 判定） |

### 6.3 未复现 / 未验证项（如实记录）

- 【评】调研 JSON 中的以下实跑我未复跑：`buildRetrievalContext('均线金叉怎么用')` 返回 used=true/selected=4；`train status` 输出「训练数据 308 条 / 已训练模型: 无」；benchmarkSuite 13 passed；answerVerifier 24 pass/0 fail。
- **我未运行任何自动化测试套件或 CI 门**（本次 ask 未指定检查命令）。【评】调研记录称 jest 形态测试文件在 `node --test` 下报 `describe is not defined`（非我运行）；复核员运行了 `node --test tests/services/skillLearningServiceLearnFromSource.test.js` → # tests 12 / # pass 8 / # fail 4（见 §6.4）。
- 第 5 章（Function Calling）评估记录为空，本报告不对其下结论。
- 未验证：多模态输入是否进感知层；同会话并发提交的串行化；`services/workflow` 未被主循环调用是刻意设计还是遗漏；PDDL 外部规划器痕迹；「OpenAI Assistants API 已被 Responses API 取代」（外部事实）；「书中未对明文 key 作安全警告」（需通读 page-0270）；「AgentExecutor 已被 LangGraph 取代」（外部事实）；MetaGPT cost_manager 是否超限即停。
- 本篇无任何缺口的频率/影响面实测（见 §4.4）。

### 6.4 关键结论验证状态（2026-11-05 按独立复核结果标注）

独立复核员亲读原书 + 复跑仓内命令后的判定（「复核员看到的证据」为其原始记录摘要；我据此改写了报告的对应处）：

| 结论 | 状态 | 复核员看到的证据 | 我的处置 |
|---|---|---|---|
| 聊天 RAG 接入嵌入+重排 | **部分验证** | 承重判断成立：主循环 RAG 链路纯词法、未用嵌入/重排（书页 page-0225/0097/0232/0032 亲读核；仓内 `ragRetrievalService.js` 仅 3 处 require、词法成分 FTS5+bm25+45 天窗逐一核）。夸大处：①「零接线」不实——embeddingClient+vectorStore 已接入记忆向量召回（`scoring.js:362-366`，`vectorRecall.isEnabled()` 默认开 :64-70）并经 `aiChatCore.js:2444` 进主循环；②「唯一进主循环的检索链路」不实——主循环还注入记忆召回（:2444-2459 含语义/向量档）、代码库预取搜索（:1786-1794）、弱模型轨迹指南（:2090→guideInjector.js:75-83，allowVector 默认关） | §0 #1、C3、主题 C 判定改写为「进主循环的知识库/会话检索链路是纯词法；嵌入与重排已实现却未接该链路」；补四条链路清单；图 1.15 页码改 page-0032 |
| A2A 入站 executor 接线 | **已验证** | 书页 page-0236/0041 亲读核；`routes/a2a.js:40-42` 与 claim 逐字相符；`serverMethods.js:42-57` defaultExecutor 只回显 `received: <text>`，:14-17 注释「默认 executor 只回显 ack（诚实占位，不假装跑了 LLM）…独立的后续任务，不在 S3 范围内」；全 backend 搜 createServerMethods 仅一处真实调用点，无启动代码注入 | 补 :14-17 与 :42-57 精确引用；引用小瑕（原引 :66 是工厂函数行）已改 |
| 诚实性评估探针 | **已验证** | 书页 page-0210（原文「我们来看看 Agent 是会坦诚交代自己的能力不足以完成任务，还是会'自信地胡说八道'」）、page-0214（第 5 步输出逐字核）、page-0217（「这样的回答相当贴心」在总结段，略出原引范围）；仓内 EVAL_PROBES 恰 4 条、单一 includes 判定、fail-open 实现 :1537-1546；全 backend 搜 EVAL_PROBES\|expectContains\|passThreshold 仅命中 modelTrainingService 及测试；搜 honesty\|hallucinat 等无任何诚实性用例 | 补 page-0217 与 fail-open 实现行号；§0 #3 与 F1 口径改为「训练后固定探针」而非「门」 |
| 金额预算门缺失 | **部分验证（核心断言被推翻后重写）** | 书页 page-0276/0278/0279 亲读核（cost_manager 逐角色记账属实）。仓内：tokenUsageService 无 budget 关键词属实、getRemainingQuota 仅被展示面消费；**但**「toolUseLoopCore 两文件 ZERO HITS」为假——该文件有系统层 D2 token 预算 governor（:132-137 注释、:2036 resolveBudget、:2245-2289 assessBudget='stop' → budgetStopped），实现在 `services/tokenBudget.js`（:96-122 assessBudget、:218-236 buildBudgetStopNotice），门控 KHY_TOKEN_BUDGET 未设即禁用（默认关）；「没有任何机制停手」为假——网关有真人民币预算门（customerQuotaEnforcer.js:443-488 monthlyBudgetCny + proxyServer.js:2861-2875 对生成端点 !allowed 即 quota_exceeded，仅限 managed-token 调用方）；惯性有 maxCostCyn 默认 5 元 + cost 停判（momentum.js:131-133）但 S1 段顶门只停 idle/wall/turns（:377-388）；cli/costThresholdWarning 是一次性 $5 提醒且明言非阻断 | **我补跑 5 项命令独立证实上述各点**（§6.2 补跑 #1-#5）；G2/M-8/§0 #4/P1-1 全部重写为「默认交互路径上没有金额门（零件默认关/不覆盖/限 managed-token）」；§6.2 #5 标注原证据部分作废并说明漏词 |
| 复盘/教训记忆化 | **已验证** | 书页 page-0049（Reflexion 逐字核）、page-0240/0244/0246（BabyAGI 存储与 k=5 检索逐字核；「小结称记忆使用方式不同」一句在 0240–0253 未见，子引文不精确）；仓内 crossModelVerify 只出 remediationPrompt、issues>0 仅触发单轮 remediation（agenticHarnessService.js:846-899）、报告只进 harnessReport/last_session.json、projectMemoryService.loadLastSession 全仓无生产调用方、memoryTrigger.classify 四类无 reflection、progressLog.js:8 自陈写入侧只由 4 条窄正则触发、全仓搜 crossModelVerify 无写入记忆路径 | 删不精确子引文，改引 page-0240/0244/0246；补 progressLog/projectMemory 证据；memoryTier 行号改 :25-53/83-98（原引 :116-125 实为 forgetPolicy） |
| 计划执行中再规划回边 | **已验证** | 书页 page-0207 伪代码含 modifyPlanBasedOnToolOutput（注：该页是 Plan-and-Solve 框架伪代码，claim 正文写 Plan-and-Execute 属措辞小误）；「分配不同模型」引文在 page-0221（7.5 小结）而非原引 page-0220（该页是 7.4），page-0208 另有「允许一个大模型专注规划，另一个专注执行」；仓内 planModeService 五态机 :146、两条执行路径 :1159-1161、replan 类搜索仅 _ensurePlansDir 子串误命中 2 处（真实零命中）、执行中只有同步骤重试 :1298-1339、编辑仅存在于批准前 :1131 | 页码改 page-0207/0221/0208；框架名改 Plan-and-Solve；补 :1298-1339/:1131 证据 |
| evals 模拟桩对模型可见 | **已验证** | 仓内实跑核实：`evals/index.js:48-54` 确为模拟分且无任何模型调用（复核员跑 runEvaluation 返回 accuracy 0.902、relevance 0.919，全程无模型调用）；`tools/index.js:179-185` 目录扫描注册；`EvalsTool/index.js:4-10` toolName='Evals'、shouldDefer=false；实跑 getAll().size=193 且 has('Evals')=true、getNonDeferredTools().size=154 且 has('Evals')=true、getDefinitions('full').length=193 含 Evals | F2 的「对模型可见」从无证据升级为已验证，补上述证据 |
| 技能威胁扫描器空串 bug | **已验证（附限度）** | 仓内实跑核实：`_INVISIBLE_CHARS` 第三项 len=0（U+200D 确已丢失，其余 4 项 len=1）；`skillThreatScanner.js:86-109` `line.indexOf(ch)===-1` 遇空串恒命中；runThreatScan('hello world') 得 caution + 1 条 invisible_unicode/high（空串输入因 :55-58 短路才 safe）；`node --test tests/services/skillLearningServiceLearnFromSource.test.js` → 12 tests / 8 pass / 4 fail，其中 not ok 10「clean source has no threat annotation」由该 bug 直接造成，另 3 例为断言过期（service 已 require ./domain/skills/skills/...、flag 不在 flagRegistry） | 补 run 输出与测试数字；加限度说明：dangerous 档拦截仍工作，「安全门实质失效」限于 safe/caution 判别被摧毁与警告层 100% 假阳 |

**留待独立复核的问题**（本轮一个也没有回答；上一版四问全是可行性问题，已补「现状有多糟」一问）：

1. H-1 的嵌入改造：Ollama/gateway 嵌入端点在本机的实际可用性与每回合延迟增量；
2. H-2 的 executor 接线：A2A 任务取消/租约语义与现有安全壳（审批、shell 安全、循环检测）的冲突面；
3. H-3 的诚实性探针：拒答标志与编造检测的误判边界能否设计到可用；
4. M-8 的预算阈值：累计花费阈值定多少才不会误停活跃任务（建议先用 S1 观察者档攒真实花费分布）；
5. **现状度量（新增）**：§4.4 三项基线（改述查询召回对照 / A2A 真实调用方 / 单会话花费分布）谁来做、何时做——没有它们，P0 之间的排序仍是拍的。

> 复核结论：____（待填）
> 复核人 / 日期：____（待填）

---

## 7. 附录：逐章方法论索引

原始评估 161 条，分章计数（高/中/低/暂不适用）：

| 章 | 条数 | 高 | 中 | 低 | 暂 | 条目 |
|---|---|---|---|---|---|---|
| 前言与第 1 章 | 27 | 1 | 1 | 22 | 3 | 表1 五层级；图1 四象限；图2 三基石（暂）；7 案例索引；Life 3.0；Agent 定义；感知-决策-行动；四大特性；图1.5 核心组件；符号/反应式/RL Agent；大模型是大脑；CoT/ReAct/问题分解；图1.13-1.14 思考实录；Gartner 曲线；1.3.5 知识与外部记忆；**图1.15 RAG 架构（高，page-0032）**；1.4 感知力；1.5.1 语言输出解析；1.5.2 工具使用；1.5.3 具身（暂）；1.6 五行业；表1.1 八预测；**1.7.2 Agent 即服务（中）**；1.7.3 多 Agent 协作；1.7.4 自我演进；1.7.5 具身发展（暂）；周傅对话 |
| 第 2 章 | 12 | 0 | 2 | 9 | 1 | 四大要素；KwaiAgents 推理流程；自主 Agent 工作包；**规划和决策能力（中）**；**Reflexion 与 CoH（中）**；四种记忆机制；调用工具核心技能；ReAct 框架；ReAct 简单 Agent（暂）；ReAct 提示模板；ReAct 决策流程；其他认知框架 |
| 第 3 章 | 20 | 0 | 1 | 17 | 2 | OpenAI API 五步；messages 参数；response_format；表3.1 模型；temperature；速率受限；Token 计费；图3.5 进展价值；图3.3 工具箱；回形针；LangChain 三优点；LCEL；六大模块；LangSmith（暂）；LangChain 注意事项；LlamaIndex（暂）；RAG 四适配对比；**现代化 RAG 工具分层（中）**；RAG 六步流程；LlamaIndex 示例 |
| 第 4 章 | 20 | 0 | 0 | 15 | 5 | Assistant；Thread；Message；Run；Tools/Functions/Code interpreter/File search；instructions；创建后只留 ID（暂）；多助手与智能路由；Playground（暂）；文件上传挂载（暂）；轮询等待退出；submit_message_wait_completion；JSON 输出；产物回读（暂）；思考过程可见性；提示词工程；DALL·E 3 配图（暂）；PPT 模板外置；多阶段拆解；耐错与重试 |
| 第 5 章 | 0 | — | — | — | — | **评估记录为空（items: []，chapter 字段为 "test"）**；本报告不对第 5 章下结论 |
| 第 6 章 | 16 | 0 | 1 | 13 | 2 | ReAct 框架；ReAct 提示模板（暂）；Agent 四元素；工具与工具包；外部工具接入；**llm-math（中）**；AgentExecutor；思考行动链条；Prompt 微调语言；断点调试（暂）；_call 关键步骤；_iter_next_step；_perform_agent_action；观察回灌；AgentFinish；小结 |
| 第 7 章 | 9 | 1 | 2 | 5 | 1 | **不可能完成的任务（高）**；**Plan-and-Solve（中）**；**计划执行分模型（中）**；ReAct 对照基线；计划执行解耦；@tool 契约；完善请求；单 Agent 到多 Agent；Plan-and-Execute 组装（暂） |
| 第 8 章 | 12 | 1 | 0 | 10 | 1 | RAG 定义；结构化/非结构化分型；四方法对比；**RAG Pipeline（高）**；用户角度六步；融合 RAG 的 Agent；ReAct RAG 财报案例（暂）；Index 与词嵌入；索引持久化；工具元数据；ReAct 多轮循环；小结与未来方向 |
| 第 9 章 | 17 | 1 | 1 | 15 | 0 | Plan-and-Execute 归类；自动化多步提示；设置 AI 参数；先宽泛后精细搜索；BabyAGI 三功能；三 Agent 分工；**任务结果入向量库（中）**；max_iterations；.env.template；**Agent Protocol 服务化（高）**；CAMEL 角色扮演；任务指定 Agent；启发式提示；七要素模板；AI 用户/助手循环；自主 Agent 与模拟二分；GitHub 开源社区 |
| 第 10 章 | 13 | 0 | 1 | 10 | 2 | Agent 定制；灵活对话模式；联合聊天（暂）；层级聊天；人类无缝参与；代码生成执行闭环；is_termination_msg；SOP 编码提示；软件公司角色流水线；_watch/set_actions；**Team 编排与成本管理（中）**；fire CLI（暂）；多 Agent 框架定位边界 |
| 附录与后记 | 15 | 0 | 4 | 10 | 1 | 两篇综述；七类划分；四组件框架；感知-大脑-行动；**ExpeL（中）**；**More Agents（中）**；**DyLAN（中）**；ChatDev；SimulateBench（暂）；TinyLlama/Ollama；LLM-Planner；**六创新方向（中）**；百家争鸣；数据与智能解绑；参考文献 22 篇 |
| **合计** | **161** | **4** | **13** | **126** | **18** | 跨章去重后 59 条（高 3 / 中 12 / 低 38 / 暂不适用 6），见 §2 |

### 引用过的关键仓内文件（按主题）

下表路径省略前缀 `runtime/node/backend/src/`（如 `.../services/x.js` = `runtime/node/backend/src/services/x.js`）；正文引用均为全径。所有引用未经链接校验，验证方式是按路径打开或 `Select-String` 搜索。

| 主题 | 文件 |
|---|---|
| 主循环与执行 | `services/tool/toolUseLoopCore.js`；`services/domain/state/stateMachine/toolLoopPhases.js`；`services/tool/toolCalling.js` |
| 规划 | `services/planModeService.js`；`services/ultraplanService.js`；`services/domain/project/metaplan/index.js` |
| 记忆与检索 | `services/memoryTier.js`；`services/domain/memory/memoryEngine/{index,vectorRecall,vectorStore,distiller,dreamPromote,progressLog}.js`；`services/ragRetrievalService.js`；`services/learningRetrieval.js`；`services/embeddingClient.js`；`services/knowledgeTeachingService.js`；`cli/aiChatCore.js` |
| 多 Agent 与协议 | `services/subAgentOrchestrator.js`；`services/cliAgentRunner.js`；`services/domain/state/orchestrator/orchestrationService.js`；`tools/AgentTool/index.js`；`routes/a2a.js`；`services/a2a/{index,serverMethods}.js` |
| 评测与校验 | `services/evals/index.js`；`tools/EvalsTool/index.js`；`services/modelTrainingService.js`；`services/answerVerifier.js`；`services/crossModelVerify.js`；`services/verificationAgent.js`；`services/capabilityAssessment.js` |
| 成本与预算 | `services/tokenUsageService.js`；`services/tokenBudget.js`；`services/inertia/{defaults,momentum,inertialRunService}.js`；`services/gateway/{customerQuotaEnforcer,proxyServer}.js`；`cli/costThresholdWarning.js` |
| 技能 | `services/skillLearningService.js`；`services/domain/skills/skills/{skillThreatPatterns,skillThreatScanner}.js` |

---

*本报告由主编笔汇总多来源评估生成；「书中说的」均带页码（【书√】为复核员亲读，【书】为评估记录照录未回翻），「我们的判断」均带仓库证据或实跑记录；2026-11-05 已按独立审读意见修订：删改了三处站不住的论断（§5.6 与自身证据冲突、「零接线」、「没有任何机制停手」）、补了六个缺失角度（影响面/阅读建议/反向视角/仓内计划对照/khyquant 视角/验收判据）、修了三处计数与引用错误，并在 §6.4 给每条关键结论标注了验证状态。*
