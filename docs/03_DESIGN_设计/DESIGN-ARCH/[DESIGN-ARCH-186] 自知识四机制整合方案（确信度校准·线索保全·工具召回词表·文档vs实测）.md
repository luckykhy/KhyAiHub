<!-- IMPL-STATUS: done -->
<!-- IMPL-DRIFT-AUDIT: 2026-10-18 · DOCS-005 范围补标，依据见下 -->
> **标记依据**：10 条根锚定路径全部可解析，且文中自述已实现；据 DOCS-005 §二 标 done。
# [DESIGN-ARCH-186] 自知识四机制整合方案（确信度校准 · 线索保全 · 工具召回词表 · 文档 vs 实测）

> **状态**：已落地（2026-10-13），四个机制全部 **S1 观察者档**（只记录/只注入，不阻断），
> 登记于 `docs/10_规范/registry/FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms`。
> **范围**：`runtime/node/backend/src/services/` 的四个纯叶子 + 五个既有接缝 +
> 三处共享登记文件（`utils/flagRegistry/index.js`、`services/selfProfile.js`、
> `services/selfAuditRegistry.js`）+ `docs/10_规范/registry/FEATURE-OWNERSHIP.json`。
> **不改**：任何路由命令 / 别名 / handler / 规则 ID（命令面棘轮已超:246/245 · 591/591 ·
> 158/155 · 96/94）——四个机制全部挂进既有的 selfProfile A 层、既有 env 门控、
> 既有收尾观察接缝与既有自审登记，零新增入口。
> **验证**：`runtime/node/backend/scripts/selfKnowledgeProbe.js`（19/19 绿）+
> 四套机制测试（24+21+11+15 全绿）+ `check:flag-registry` / `check-rollout-stage` /
> `check:feature-ownership` 全绿；逐项读数见 §6。

---

## 0. 一句话结论

四个「自知识」缺陷（说话不校准 / 长任务丢线索 / 延迟工具召不回 / 把文档当事实），
各自补一个**纯叶子 + 一处既有接缝 + 一条既合规的 env 门控**：提示侧把纪律注入系统提示，
运行侧在既有收尾接缝做确定性观察（S1 只记账），门控关时**四处接缝逐字节回退**。
四条机制零新增命令、零新增别名、零新增 handler、零新增规则 ID。

---

## 1. 四个缺陷 → 四个机制

| # | 缺陷（问题陈述） | 机制 | 叶子 | 门控（默认开） |
|---|---|---|---|---|
| 1 | 生成机制天然倾向「接上一个通顺的回答」，一知半解时说得和真确定时一样笃定 | 确信度校准 | `services/confidenceCalibration.js` | `KHY_CONFIDENCE_CALIBRATION` |
| 2 | 长任务跑到第几十步，早期决策与约束被压缩稀释/丢失，最初定的规矩被忘掉 | 线索保全（CLUE-LEDGER） | `services/clueVault.js` | `KHY_CLUE_VAULT` |
| 3 | 36 个延迟工具主聊天流只注入裸名，toolSearch 按词命中（别名 +8 / searchHint +4）——看得见名字、看不见可搜的词 | 延迟工具召回词表 | `services/tool/deferredRecallIndex.js` | `KHY_TOOL_RECALL_INDEX` |
| 4 | 回答过分相信文档/注释（二手声明），不跑一遍/读一遍源码核实 | 文档 vs 实测 | `services/docVsMeasuredPolicy.js` | `KHY_DOC_VS_MEASURED` |

四叶子的共同契约（照 `selfAuditRegistry.js` 先例）：**零 IO、确定性、绝不抛、可单测、
数组与条目全 `Object.freeze`**；门控判定统一走 `utils/flagRegistry`（CANON 词表
`0/false/off/no` 关），注册表不可用时回退本地 CANON——两处语义完全一致。

---

## 2. 机制详解

### 2.1 确信度校准（confidenceCalibration）

**提示侧（A 层）**：`selfProfile.formatForSystemPrompt` 注入「确信度自检」协议——
事实性断言先分三档（本轮已验证 / 训练知识 / 未验证），未验证必须明说并给验证路径，
禁用笃定措辞包装猜测，零工具调用的纯问答同样适用（`selfProfile.js:937` 起，
插入点在自审块与 20 倍模式块之间）。

**运行侧（收尾 S1 观察器）**：`agenticHarnessService.js:1210-1236` 对最终回复做
确定性扫描，两个 finding 类：

- `unbacked_certainty`：零工具调用的轮次里出现**强笃定措辞**（一定/绝对/definitely…）。
  启发式——只落样待人复核，不作「模型错了」的断言。实质长度下限：中文主导回复 40
  非空白字符、其余 120（`MIN_SUBSTANTIVE_CHARS_CJK` / `MIN_SUBSTANTIVE_CHARS`）。
- `unbacked_verification_claim`：零工具调用**且会话历史无工具活动痕迹**
  （`loopResult.conversationMessages` 无 role:'tool' / tool_calls / tool_result|tool_use 块）
  的轮次里自称「我查了/读了/跑了/I verified」。两条同时成立时该自称必为假（确定性）。

**与既有机制的分工（不重复计量）**：`claimReconciler` 六族（delete/write/edit/test/commit/deploy）
的动作声称对账已由 `answerVerifier` 在同一收尾接缝用户可见地纠错；其词库不含 read/check
系自称，工具循环的两道证据门又都以「已发生过工具调用」为前提
（`toolUseLoopCore.js` 编辑门 `_allModifiedFiles.size>0`、非编辑证据门 `substantiveCalls>=threshold`）
——零工具轮的 read/check 系自称正是既有机制覆盖不到的盲区。本观察器按 ±40 字窗口跳过
已落在既有族对账范围内的命中；否定判定复用 `claimNegation._isNegatedClaim`（单一真源）。

**台账**：样本经 `confidenceCalibrationLedger` 旁路落 `<dataHome>/ruleguard/confidence-observations.jsonl`
（`KHY_CONFIDENCE_LEDGER_FILE` 可覆盖路径；只落有 finding 的行、绝不落回复正文）。

### 2.2 线索保全（clueVault）

把对话里四类「丢了会出错」的线索（约束 / 决策 / 锚 / 未决）确定性抽成可回流的
`[CLUE-LEDGER v1]` 台账，在四处**只增不改**地注入（S1 铁律：不调 splitIndex、不接
`adjustSplitForPins`、不改任何既有字段）：

| 接缝 | 落点 |
|---|---|
| 压缩摘要提示（全量） | `contextCompressor.js:867/875`（台账段并入同级） |
| 增量摘要路径 | `contextCompressor.js:1181/1203`（承接上一轮台账 + 回流） |
| cycle boundary briefing | `contextCompressor.js:1450`（兜底追加） |
| 断点 `contextSummary` | `agenticHarnessService.js:433/444`（中断）与 `:610/621`（续跑轮，此前全仓无写入者、恒为空） |

A 层注入（`selfProfile.js:950` 附近）告诉模型 CLUE-LEDGER 块的语义与线索书写纪律
（压缩后仍有效、抵触要显式说明、自己的持久决策/未决写成可抽取的一行）。
门控关 → 四个接缝全部逐字节回退；字节对照由 `clueVault.test.js` 以**不可变基线
commit 889920fe** 版 `contextCompressor` 锁死（gate off 与基线逐字节一致）。

### 2.3 延迟工具召回词表（deferredRecallIndex）

36 个 `shouldDefer` 工具在主聊天流只注入裸名清单（`# Additional Tools`），而
`toolRecommend.scoreTool` 是按词命中的（别名 +8 / searchHint +4 / 描述 +2）。
本叶子从 `tool.aliases + tool.searchHint` **现场派生**每个未揭示延迟工具的词表
（小写归一、丢英文虚词、丢与名字同形的词、ASCII 子串去重、每工具 ≤6 词 / 单词 ≤16 字符 /
≤60 行），生成 `- <Name>: <词表>` 索引块，替换 `khyUpgradeRuntime.js` 两处既有接缝的裸名拼接
（`:2151-2152` 统一路径、`:2320-2322` legacy 路径）。词表不是第二份手搓映射：元数据变则
索引变，且词表与打分器同源由测试实跑真 `scoreTool` 逐词断言命中 >0。
门控关 → 叶子返**历史裸名清单**（逐字节回退，接缝不留第二份模板）。

### 2.4 文档 vs 实测（docVsMeasuredPolicy）

**提示侧（A 层）**：注入「引述前先自证」三档纪律（实测 ＞ 读到 ＞ 引述）+ 三个最便宜的
既有取证入口（`khy docs check` / KhySelf 自审核验动作 / location+Read/Grep）；只引述不核实
必须标注「文档陈述·未实测」。插入点在 self-location 块与 Skill protocol 块之间。

**运行侧（S1 观察器）**：`toolUseLoopCore.js:4871-4887` 在零工具调用收尾时观察
「引述了本回合未取证的仓内路径」（白名单顶层目录 + 常见扩展名），记入既有
`toolLoopJournal`（`event: 'doc-grounding'`，默认开，样本主通道）并叠 breadcrumb
（`KHY_LOOP_DEBUG` 开时才落文件）——无 nudge、无 continue、不改写输出。

**自审登记**：新增 `selfAuditRegistry` #8 条目（2026-10-13 新增追踪项，非原报告编号），
其 `evidenceAnchors` 与叶子**共用同一份冻结声明**（单一真源）——叶子删除/模块搬家,
`selfAuditVerifier` 现场核验即翻红。

---

## 3. 门控与回退语义

| 门控 | 登记 | 默认 | 关（CANON 4 词） | 关时回退语义 |
|---|---|---|---|---|
| `KHY_CONFIDENCE_CALIBRATION` | `utils/flagRegistry` | 开 | 0/false/off/no | 提示词不注入、harness 不扫描不落账 |
| `KHY_CLUE_VAULT` | 同上 | 开 | 同上 | 四处接缝逐字节回退（基线 commit 对照锁死） |
| `KHY_DOC_VS_MEASURED` | 同上 | 开 | 同上 | 注入块返 `''`、观察器返 `observed:false` |
| `KHY_TOOL_RECALL_INDEX` | 同上 | 开 | 同上 | 叶子返历史裸名清单（逐字节） |

**阶段选择器不入表**（字符串常量，非布尔门控，与 `KHY_STEP_ANCHOR_STAGE` 先例一致）：
`KHY_CONFIDENCE_CALIBRATION_STAGE` / `KHY_CLUE_VAULT_STAGE` / `KHY_TOOL_RECALL_INDEX_STAGE`
（叶子字面常量）与 `docVsMeasuredPolicy.STAGE`。四个叶子当前一律 `'S1'`，非法值回落 S1
（绝不 fail-open 到更高阶段）；登记表 `executorStage.constant` 与源码常量由
`check-rollout-stage.js` 比对，漂移即报。

**路径覆盖**：`KHY_CONFIDENCE_LEDGER_FILE`（台账落点，无默认；缺省走
`dataHome/ruleguard/confidence-observations.jsonl`，dataHome 不可用回退 cwd 相对
`works/data/khy/ruleguard/`）。其余三个机制无路径开关。

---

## 4. 共享登记落点（整合后的单一改动）

| 文件 | 落什么 |
|---|---|
| `runtime/node/backend/src/utils/flagRegistry/index.js` | 四条门控登记（default-on / CANON），各带中文注释说明缺陷与回退语义 |
| `runtime/node/backend/src/services/selfProfile.js` | 三处 A 层注入（确信度自检 / CLUE-LEDGER / 文档 vs 实测），全部 fail-soft、门控关返 `''` |
| `runtime/node/backend/src/services/selfAuditRegistry.js` | #4 的 mitigation/锚点补 `deferredRecallIndex` + `KHY_TOOL_RECALL_INDEX`；新增 #8（文档 vs 实测）；`meta.note` 如实标注 #8 来源 |
| `docs/10_规范/registry/FEATURE-OWNERSHIP.json` | 四条 mechanism（S1 / stageSince 2026-10-13 / samples.observed 0 / target 200 / rollback / executorStage）；`updated` 与 `rollout.updated` → 2026-10-13 |
| `runtime/node/backend/tests/services/selfAuditRegistry.test.js` | #4 期望锚点表更新（严格 deepStrictEqual，未放宽） |
| `runtime/node/backend/tests/tools/khySelfAlignment.test.js` | 自审面计数 5 → 6（仍是**严格计数**逐项 verified；#8 起随 #1..#7 一并核验） |

> **整合适配（有意的小改，非放宽）**：补丁原文把 #8 的 mitigation 写作
> `KhySelf self_audit_verify`，与该文件既有测试 ⑪「无核验输入时输出不得含该串
> （代理断言 = 无核验协议措辞）」冲突。整合时该处改为 `KhySelf 自审核验动作`
> ——三条取证入口不变、语义不变、既有断言一字未动；精确动作名仍由同轮注入的
> docVsMeasured 纪律块给出。

---

## 5. 阶段（PROCESS-008 / 规则 8）

四条机制全部 **S1 观察者**：只注入提示、只记录样本，**不阻断、不改写、不 nudge**。
登记字段齐备：`stage` / `stageSince` / `previousStage` / `samples` / `rollback` / `executorStage`。

- 样本口径：确信度校准 = 台账事件行（每组 finding 一行，带 `replyChars` / `priorToolActivity`）；
  线索保全 = compress 与增量两条审计行的 `clueCount>0`；文档 vs 实测 = doc-grounding 观察记录
  （落既有 toolLoopJournal）；工具召回词表 = 观察期「据词表命中并真正调用」的实例（非拦截型）。
- 毕业口径：≥200 条且无解释不了的样本（PP-2，以样本量计不以时间计）；升阶一次一阶（PP-6），
  是人的决定——**当前代码里刻意不存在任何按阶段改变行为的路径**。
- 升档动作已预写：S2/S3 对确信度校准=开始提示/拦截；对线索保全=接 split 调整 / pin 强制；
  对工具召回=接进 toolSearch 零命中回退（会改工具结果，故必须后置）。

---

## 6. 验证（2026-10-13 实跑）

| 检查 | 命令 | 结果 |
|---|---|---|
| 门控登记表结构 | `npm run check:flag-registry` | `Flag-registry check passed` |
| 阶段守卫 | `node scripts/ci/check-rollout-stage.js` | mechanisms: 32 · **0 error** · 3 warning（存量:read-before-edit / cross-model-verify / trajectory-routing） |
| 归属登记守卫 | `node scripts/ci/check-feature-ownership.js` | 0 error · 3 warning（存量:ai-gateway / token-usage / software-copyright-materials） |
| 确信度校准测试 | `node --test runtime/node/backend/tests/services/confidenceCalibration.test.js` | 24/24，exit 0 |
| 线索保全测试 | `node --test runtime/node/backend/tests/services/clueVault.test.js` | 21/21，exit 0 |
| 工具召回词表测试 | `node --test runtime/node/backend/tests/services/deferredRecallIndex.test.js` | 11/11，exit 0 |
| 文档 vs 实测测试 | `node --test runtime/node/backend/tests/services/docVsMeasuredPolicy.test.js` | 15/15，exit 0 |
| 自审登记回归 | `node --test runtime/node/backend/tests/services/selfAuditRegistry.test.js` | 13/13，exit 0 |
| 四机制门控探针 | `node runtime/node/backend/scripts/selfKnowledgeProbe.js` | 19/19，exit 0（**负路径实测**：桩坏一条叶子即 16/19、exit 1 并点名 FAILED 三条） |

探针（`runtime/node/backend/scripts/selfKnowledgeProbe.js`，只读、不写盘）对每个机制断言
四件事：叶子门控开→块出现；叶子门控关→逐字节为空；接缝门控开→系统提示含对应块；
接缝门控关→**逐字节回退**（前三个 = 输出 === 开态去掉该块；第四个 = 该段回退为历史裸名
清单且首字节起逐字节相等）。另附登记面检查：四门控已登记 default-on/CANON、四叶子阶段
常量均 S1、四机制均在 `rollout.mechanisms` 登记齐备。

> 已知既有失败（**非本批引入**）：`tests/tools/khySelfAlignment.test.js` 的
> 「既有 action 行为不回归」条断言 `selfSourceDir` 匹配 `/services[\/\\]backend[\/\\]src$/`，
> 实际值为 `D:\Portable\khy-os\runtime\node\backend\src`——仓库层级迁移后的测试侧路径漂移，
> 与四个机制的文件无交集（复核记录同款）。

---

## 7. 边界与未覆盖（如实登记）

1. **运行侧只覆盖默认收尾路径**：确信度校准挂在 `agenticHarnessService` 收尾；
   `KHY_QUERY_ENGINE_HARNESS=off` 或 harness 抛错走 `queryEngine._submitMessageViaToolLoop`
   回退的轮次不扫描（那一轮只有提示词侧生效）。文档 vs 实测同理只挂 toolUseLoopCore 收尾。
2. **启发式与假阳/假阴**：`unbacked_certainty` 是启发式（强措辞词表外的过度自信识别不出；
   表内措辞也会有误报）；doc-grounding 抽取限白名单顶层目录 + 常见扩展名，未加反引号的
   含空格文档名会漏抽。S1 靠人工复核样本，升 S2 前不做任何提示、不阻断任何交付。
3. **提示协议的行为改变不可保证**：本批保证的是「注入发生 + 零工具轮次的笃定断言/自称核验
   被确定性计量」，不是「模型行为必然改变」。
4. **有工具调用的轮次不叠报**：证据薄的轮次仍归既有证据门管，本批刻意不叠加。
5. **台账无容量上限/轮转**（与 `authzFailureLedger` 同型）；工具召回的样本需使用方在观察期汇总
   （叶子零 IO，不埋采样写入）。
6. **跨轮引用残余**：`conversationMessages` 缺失的调用路径下，前几轮真实查过而本轮引用的
   轮次仍可能被记 `unbacked_verification_claim`（台账不存正文，复核需按轮次回捞）。
7. **中文召回到 hint 自带中文词为止**（36 个延迟工具约 25 个 searchHint 纯英文）；
   未扩 TOOL_CLUSTERS（预激活是另一条机制）；未覆盖 Claude Direct 服务端 tool_search。
8. **只读面**：工具召回词表未新增命令面读取入口（命令面棘轮已满），样本经文件/审计行复核。

---

## 8. 棘轮合规

本批 **0 新增**：路由命令、别名、handler 文件、规则 ID。
四机制挂进的既有入口：selfProfile A 层（既有）、`/self` 自审面（#8 经既有分面暴露）、
既有 env 门控体系（flagRegistry）、既有收尾观察接缝（agenticHarnessService / toolUseLoopCore）、
既有 toolLoopJournal 与既有审计台账。
`npm run check:delivery` 读数（本批前后一致）：routerCommands=246/245 · aliasEntries=591/591 ·
handlerFiles=158/155 · ruleCount=96/94。
