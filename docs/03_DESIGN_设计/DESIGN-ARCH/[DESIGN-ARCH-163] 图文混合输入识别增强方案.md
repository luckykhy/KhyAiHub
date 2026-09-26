# [DESIGN-ARCH-163] 图文混合输入识别增强方案

<!-- RULES-REGISTRY: RUNTIME-001, RUNTIME-002, RUNTIME-003, PROCESS-008, PROCESS-014 -->

> **状态**：D1/D1.1/D2/D3/D4/D6 已实施（2026-09-27）；D5 已实施且停在 S1 只记录档；
> 长图拆分默认关待升阶（见 §6）
> **范围**：`services/backend/src/services/imageService.js`、`services/multimodalInputService.js`、
> `services/gateway/**`（视觉能力登记）、`services/sessionPersistence.js`、`cli/repl/**` 与
> `cli/tui/**` 的图片入口。**不改** `toolUseLoopCore.js` / `replSession.js` 主干 / `toolUseLoop/*`
> （在途神文件重构线，任务 #7）。
> **上游依据**：用户提供的《khyos 图片识别解决方案实战指南》（docx，2026-09-26），
> 其核心论断：单独丢图只能「看」，**图 + 结构化文字**才能「理解」；不要让模型「猜」，
> 给它「确定性输入」。
> **命名说明**：用户原话中的「khyps」按上下文判为「khyos」的键入笔误（p 与 o 相邻），
> 本方案主语为 khy-os。若另有所指，以批准时的订正为准。

## 0. 一句话结论

khy-os 的图文混输**采集与传输链路已成型**（剪贴板/路径/附件 → `_imageCompat` 归一 → 各协议
多模态块 → 视觉路由与 OCR 兜底），但指南指出的四个真实缺口都在**「理解层」而非「传输层」**：
① 图片到达网关时缺一张自动生成的「图片说明书」（结构化上下文卡）；② 预处理只在超限链路
被动触发且 `imageService` 对 >5MB 直接抛错；③ 会话转录不落图片，多轮/续聊时图「看过即失」；
④ 原生视觉能力登记失真（仅 `codex` 在册，多个 adapter 实际已能发图块）。
本方案沿指南「双轨制」原则补理解层：新增纯叶子 `imageContextCard` 场景分类 + 说明书装配，
`imageService` 超限改为降尺度优先、抛错兜底，会话图片落 `.khy/images/` 引用化持久，
视觉登记改为探针驱动。全程按 `PROCESS-008` 走 S1 观察者档。

## 1. 需求五问（RUNTIME-008 / 规则 6）

1. **谁用？** —— 在 REPL/TUI 中向 khy-os 发送截图（UI 设计稿、需求文档、报错截图、
   流程图）并期望它据此干活的一切终端用户。（source: 用户原话
   「参照设计khyps的图片识别与文字混合问题」+ 所附指南 docx 的适用场景一节）
2. **什么时候用？** —— 每次携带图片的生成请求发出之前（采集后、送网关前的装配时刻），
   以及会话 resume / 多轮追问同一张图时。入口不变（既有 `image|图片|img`、`paste|粘贴`、
   内联路径提取、TUI Ctrl+V），**不新增顶层命令**（`PROCESS-014` 命令面棘轮只降不升）。
3. **现在的替代做法是什么？** —— 用户手工把指南 §2.2.1 的模板（图片说明 + 内容转录 +
   补充上下文）复制粘贴进输入框。这证明自动化必要性：指南第七章 Checklist 的 10 项
   全靠人肉执行。（source: 指南「策略二：结构化描述——这是最关键的策略」）
4. **成功长什么样？** —— 命令 + 期望输出，见 §7 验收判据 A1–A5。核心一条：
   发一张报错截图且不带任何文字，助手消息前自动出现「📇 图片说明书（OCR 转录 + 场景判定 +
   待确认项）」，且 OCR 转录文本可被用户直接编辑修正后再发送。
5. **不做会怎样？** —— 指南 §1.1 的五类失准场景（颜色偏差 / OCR 错字 / 堆栈截断 /
   箭头方向搞反 / 手写批注漏识）继续由用户独自承担；重复发图得到重复错误
   （指南误区四），会话一续聊图片上下文即丢失。

## 2. 现状盘点（证据链，均为已核实 file:line）

| # | 层 | 证据 | 现状 |
|---|----|------|------|
| E1 | 采集 | `imageService.js:36-37,110-112` | 剪贴板三平台读取已有；**>5MB 直接 throw**（`Image too large`），不尝试压缩 |
| E2 | 入口 | `cli/repl/imageIntent.js`、TUI `pendingImageAttachments.js`、`ink-components/App.js:3942` | 路径提取、暂存附件、图无文字时兜底话术「请描述这张图片」已就绪 |
| E3 | 归一 | `gateway/adapters/_imageCompat.js` | 各家图片形态 → 统一 `{base64,mimeType}`，Anthropic/OpenAI/Responses/Ollama/CodeWhisperer 发射器齐备 |
| E4 | 路由 | `visionCapability.js`、`visionRouting.js`、`adapterVisionCapability.js:40` | keep/switch-model/mcp-vision/ocr-fallback 四态决策已有；但 `NATIVE_VISION_ADAPTERS=['codex']` **仅一个在册** |
| E5 | OCR | `services/ocrSnippetService.js`（pytesseract chi_sim+eng）、`aiGateway.js` 的 `extractImageOcrTexts`/`tryRateLimitOcrRescue` | OCR 已作为**限流兜底**存在，未作为**双轨常态上下文**装配 |
| E6 | 降尺度 | `gateway/glmVisionImageDownscale.js`、`adapters/_imageTranscode.js`（ffmpeg，≤5MB/≤2048px） | 能力存在但**只在特定网关链路触发**，采集侧（E1）未接 |
| E7 | 持久化 | `sessionPersistence.js:320-334`（`appendMessage` 仅存 `{uuid,parentUuid,role,content,timestamp,...}`）、`:874`（`_flattenMessageContent` 把内容块压平为文本） | **图片字节与引用都不落会话**，resume 后图不可再读 |

**结论**：传输层不缺，缺的是指南所说的「校验层」——把图的信息在**送模型之前**用文字钉死。

## 3. 差距分析（指南策略 → 仓库现状）

| 指南策略 | 要求 | 差距编号 | 现状 |
|---|---|---|---|
| 一：图片预处理 | 放大/锐化/转 PNG/拆长图 | G1 | 仅网关侧被动降尺度；采集侧超限抛错；无长图拆分 |
| 二：结构化描述（最关键） | 图 + 转录文字 + 尺寸/色值 + 上下文 + 疑问 | **G2** | 无「说明书」装配；OCR 只在限流兜底路径出现 |
| 三：分步拆解 | 复杂图分区域多次提交 | G3 | TUI 附件可分批，但无分区引导 |
| 四：反馈校准 | 按「尺寸/颜色/遗漏/逻辑/文字」五类精确反馈 | G4 | 无任何校准话术支持 |
| 附录：能力诚实 | 模型能不能看图要说真话 | G5 | E4 登记失真 |
| 五：可复用模板 | `.khyos/templates/` 四类模板 | G6 | 目录不存在（`src/templates` 仅代码脚手架 JSON） |

## 4. 方案设计

### D1（对 G2/G6）图片说明书 `imageContextCard` —— 图文双轨契约

新增纯叶子 `services/backend/src/services/imageContextCard.js`（零 IO、可单测），
在采集完成后、送网关前，为每张图装配一张结构化上下文卡：

```
【图片说明】
- 来源: clipboard | file:<相对路径> | tui-attachment 第 N/共 M 张
- 尺寸: <宽x高 px> · <文件大小> · 格式 <mime>
- 场景判定: error-screenshot | ui-design | document | diagram | handwriting | unknown
- 运行环境: node <版本> / <platform>（报错场景自动附）
【OCR 转录】<ocrSnippetService 文本>（置信度 <level>；低置信度行以 ⚠ 前缀标出）
【待确认】<场景模板生成的 1-3 个具体问题，如「设计稿请补充主色色值；流程图请提供 Mermaid 或节点关系文字」>
```

- **场景分类**为确定性启发式纯函数：OCR 文本特征（堆栈/`error`/文件路径 → error-screenshot；
  `#rrggbb`、`px`、组件词频 → ui-design；编号列表/「需求」「PRD」→ document；
  `-->`、节点括号语法 → diagram），**不猜即 unknown**，unknown 不生成【待确认】以免噪音。
- 说明书与用户原文**合并为同一条多模态消息**送入既有 `options.images` 通道（E3 归一不动）；
  用户文字在场时置于图块之前，保持「用户主诉优先」。
- 四类场景模板落 `.khyos/templates/`（指南 §5.1 原样采纳：`ui-component.md`、
  `bug-report.md`、`requirement-prd.md`、`design-token.md`），unknown/用户主动时可
  `khy image template <场景>` 打印骨架供填表。入口为既有 `image` 命令的子 flag，**不新增顶层命令**。
- 门控 `KHY_IMAGE_CONTEXT_CARD`（默认开；显式 `0` 逐字节回退旧行为）。

### D2（对 G1）预处理改道：降尺度优先，抛错兜底

- `imageService.readImageFromFile` 的 >5MB 分支：先走 E6 既有平台工具链
  （PowerShell System.Drawing / ffmpeg / sips）**尽力降尺度**（每轮按
  `sqrt(目标/当前)×0.85` 收缩、最多 3 轮，`_downscaleToLimit`），成功则继续并返回
  `downscaledFrom` 元数据；**展示面**：元数据随 D1 说明书的「预处理」行透出给模型
  （实测 27MB→3.5MB/866ms）。不在服务层直接打状态行——TUI 存活期直写 stdio 会留
  擦不掉的残行（tui/AGENTS §0.9.7 单写者红线），调用面接线待 #7 神文件落定。
  仅当工具缺失或失败时才抛错，且错误消息按 RUNTIME-002 模板给出
  「问题+原因+修复建议」（指南 §2.2 精神）。
- 高图（高度 > 2×宽度 或 > 2000px）：S1 阶段**只在说明书追加一条【建议】**
  「长图信息密度过高，建议按区域拆成 2-3 张（指南策略三）」，不自动切图——
  自动拆分留待 S3 且有 `KHY_IMAGE_SPLIT_TALL=1` 显式开启。
- 全程 fail-soft、活动式超时（RUNTIME-003：空闲超限才中止，不硬 kill），
  **不引入 sharp 等新的原生依赖**（现状零图像依赖是刻意选择）。

### D1.1（已实施 2026-09-27）多格式同轮关联：一条消息多图 + 混排文字

用户可在输入框一次提交「文字 + N 个本地图片路径 +（剪贴板暂存图）」。关联契约：

1. **提取**：`imageIntent.extractAllInlineImageIntents`（纯叶，与单路径提取器共用同一
   pathAtom 真源）非重叠扫描全部路径，引号形态优先占位，按出现序去重。
2. **提交语义**（`inlineImageSubmit` 多路模式，门控 `KHY_INLINE_MULTI_IMAGE` 默认开）：
   ≥2 路径时**用户原文逐字节不剥离**——「A 和 B 哪里不一致 <pathA> <pathB>」里指代词与
   路径的相对位置本身就是联系，剥离反而销毁它；每张读出的图带 `label=原始路径`。
   恰好 1 路径 / 门控关 → 逐字节维持既有单路径 REPL 对齐行为（剥路径+上下文改写）。
3. **透传**：`_imageCompat.normalizeImageItem` 对 `label` 做**白名单透传**（仅短纯字符串，
   去控制符、截 160，hostile 形态丢弃——边界「绝不抛」契约不变）；`_imageTranscode` 的
   `{...img,...conv}` 天然保留。
4. **钉死联系**：说明书按 `options.images` **真实下标**编号（图i = 模型收到的第 i 个图片块，
   过滤不漂移）；≥2 张时卡片头部先出【图片对照】`图i=来源` 表 + 指代约定（「提到图i或文件名
   按编号对应；跨图比较逐图引用编号，歧义先问勿猜」）；出卡数 < 总数时如实注明差额，不假装全有。

单测锁定于 `tests/services/imageMixedFormatLink.test.js`（11 用例）+ 既有
`tui.inlineImageSubmit` / `pendingImageAttachments` / `imageCompatMime` 全绿。

### D1.2 / D6（已实施 2026-09-27）多格式附件说明书：pdf / docx / md / txt / csv …

把「说明书」从图片推广到**一切能在消息里以路径出现的格式**。发现层与提取层：

1. **发现**：新纯叶 `cli/repl/inlineFileRefs.js`——通用扫描引擎 `scanPathRefs`
   （`imageIntent.extractAllInlineImageIntents` 已改为复用同一引擎，单一真源）+
   文档/文本扩展集（pdf/docx/xlsx/pptx/txt/md/csv/json/yaml/xml/log…，与
   `aiUploadStore.classifyKind` 口径对齐）；图片集与文件集**刻意不相交**，两扫描器
   各管各的、按归一化路径去重合并。
2. **提取路由**（网关侧 `imageContextCardService`，异步、门控 `KHY_FILE_CARDS` 默认开）：
   - text/code 类 → `fs` 直读，截断（`KHY_FILE_CARD_EXCERPT_CHARS` 默认 4000 字，
     钳 500–20000）；
   - `.pdf` → 既有 `documentSnippetService.extractDocumentSnippetAsync`
     （pdftotext→pypdf→strings 引擎链，短 I/O 超时 `KHY_FILE_CARD_TIMEOUT_MS`
     默认 8s ≤10s，RUNTIME-003 合法例外）；
   - `.docx` → 既有 `handlers/convert.runConvert`（python docHelper），临时产物 finally 清理；
   - 其余（xlsx/pptx/legacy doc/未知）→ **引用卡**：「该格式暂无正文提取通道，仅登记引用」，
     不假装有正文；提取失败按 RUNTIME-002.2 给「问题+修法」。
   - >20MB / 不存在 / 非常规文件 → 同上诚实引用卡。
3. **联系**：图卡与文件卡共用一张【附件对照】表——`图i=<来源>` 与 `文件j=<路径>` 并列，
   分开编号、逐项可指代；「图i」仍锚定图片块真实发送序，「文件j」锚定消息内路径出现序。
   文件卡带【正文摘录】+【待确认】「仅摘录，完整内容请用 read 工具」——说明书给确定性
   锚点，全文读取仍走工具正门（权限/审计不旁路）。
4. **挂载**：网关归一收口调用从「仅图」放开为「每回合」（无图纯文本消息中的路径同样出卡）；
   双门控任一关 → 对应面逐字节回退。全链 fail-soft。

实测：一条「按 prd.md 实现校验，界面参照 shot.png，另核对 ghost.pdf」→
【附件对照 2/2】`图1=shot.png；文件1=prd.md` + 直读摘录卡 + 不存在路径诚实卡。
单测 `tests/services/imageFileCards.test.js`（11 用例）。

### D3（已实施 2026-09-27）会话图片引用化持久

- 图片字节落 `<dataHome>/images/<sha16>.<ext>`（内容寻址，天然去重；已并入
  `DATA-LOCATIONS.json` seedEntries → `session-images-dir`，规则 `LAYOUT-007`）。
- `sessionPersistence.appendMessage` 的 `content` 为内容块数组时，base64 image 块
  （anthropic `{type:'image'}` 与 openai data-URL `{type:'image_url'}` 两形态）以
  `{type:'image_ref', path, mimeType, bytes, sha16, stored, scene?, ocrDigest?}` 随行存储；
  字符串 content 与「块数组无图」路径**逐字节不变**。
- 回读收口在 `buildConversationChain`（消费者唯一重建口，脏文件零改动）：引用命中 →
  还原等效 base64 图像块；文件缺失 → 诚实占位文本（带 sha16，有 ocrDigest 则附摘要）。
  读侧按 image_ref 块存在而**无条件**解析（不受写侧门控约束），盘上原始行不动，校验/
  审计轨看到的仍是落盘原文。`path` 只取 basename，防转录文件被投毒后越界读盘。
- 门控 `KHY_SESSION_IMAGE_PERSIST`（默认开，`0/false/off/no` → base64 原样落行的旧行为）；
  单图 >2MB 只存引用与摘要、不复制字节（`stored:false`，指南「压缩严重 JPG 转 PNG」的对偶）。

实测：200 字节图 → 行内 0 处 base64、`images/<sha16>.png` 字节级还原；同字节两会话
仅一份文件；2MB+1 → `stored:false` 不落盘；删文件后 resume 得「图片正文缺失(引用 …)」。
单测 `tests/services/sessionImagePersistD3.test.js`（9 用例）。

### D4（已实施 2026-09-27）视觉能力登记求真

- `adapterVisionCapability.js` 判定序改为：env 显式覆盖（优先级不变）→ CLI 实例自报 →
  **既有探针实测灌入**（`visionCapabilityStore.getAdapterVerdict` 扫
  `.khyos/vision_capability.json` 未过期条目，adapter 级聚合）→ 内置名单回退。
  实测 `supported` 自动放行；实测 `unsupported` 可否决内置名单（上游真拒图时剥 OCR
  才是真话）；无记录/过 TTL/store 读失败 → 逐字节回退旧判定。
- 消除「发得出但被判定发不出」或反之一的谎报；post-failure OCR 网兜底不变，放行仍安全。

单测 `tests/services/visionNativeAdapterProbe.test.js`（8 用例）。

### D5（已实施 2026-09-27，S1 只记录）校准话术卡

- 纯叶子 `correctionPhraseCard.js`：五类确定性关键词表（尺寸偏差/颜色偏差/遗漏元素/
  逻辑错误/文字错误，指南 §2.4.2）、上一条助手消息 UI/代码产物判定（string 与
  block-array content 双形态安全）、档位 `KHY_IMAGE_CALIBRATE_HINT`（默认 log / off / on）。
- 观测编排 `correctionPhraseService.js` 挂网关送模型前（先于说明书卡，看用户原文）：
  本轮无图且命中句式 → 往 `.khyos/correction_phrase_samples.jsonl` 追加一行样本
  （类别/关键词/assistantArtifacts/sha16 摘要/≤120 字预览）。**S1 只记录，绝不改写
  用户消息、绝不阻断**。误报样本也记录（artifacts 字段），否则 S2 的误报率永远算不出。
- 骨架注入通道**不存在**：阶段权威常量 `KHY_CALIBRATE_HINT_STAGE='S1'`，
  `effectiveMode()` 把 on/inject 一律收敛为 log；升 S3 = 人工翻转常量 + 同步
  `FEATURE-OWNERSHIP.json` → `image-calibrate-hint-skeleton`（守卫
  `check-rollout-stage.js` 已校一致）。

单测 `tests/services/correctionPhraseS1.test.js`（7 用例）。

## 5. 门控与开关汇总

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `KHY_IMAGE_CONTEXT_CARD` | 开 | D1 说明书装配；`0` → 逐字节旧行为 |
| `KHY_IMAGE_AUTO_DOWNSCALE` | 开 | D2 超限降尺度优先；`0` → 保持抛错旧行为 |
| `KHY_INLINE_MULTI_IMAGE` | 开 | D1.1 多路径同轮模式；`0` → 单路径老逻辑逐字节回退 |
| `KHY_FILE_CARDS` | 开 | D6 文件说明书卡；`0` → 只出图卡，逐字节回退 D1.1 面 |
| `KHY_FILE_CARD_TIMEOUT_MS` | 8000 | D6 单文件提取子进程短 I/O 超时（钳 1000–15000） |
| `KHY_FILE_CARD_EXCERPT_CHARS` | 4000 | D6 正文摘录上限（钳 500–20000） |
| `KHY_IMAGE_SPLIT_TALL` | 关 | D2 长图自动拆分（仅 S3 后允许默认开） |
| `KHY_SESSION_IMAGE_PERSIST` | 开 | D3 引用化持久；`off` → 图片不落会话 |
| `KHY_NATIVE_VISION_ADAPTERS` | 未设 | D4 既有显式覆盖通道，优先级高于探针灌入 |
| `KHY_IMAGE_CALIBRATE_HINT` | 记录档 | D5：`log`（默认，只记样本）/ `on`（注入骨架，S3 后）/ `off` |

## 6. 落地阶段（PROCESS-008）

| 机制 | 起步阶段 | 毕业判据 |
|---|---|---|
| 场景分类器（D1/D5 共用） | S1 观察者：记录判定与用户后续修正的分歧样本 | ≥200 样本且无解释不了的样本 → S2 |
| 长图拆分（D2） | 不注册拦截；仅【建议】文案，属状态文本非门 | — |
| 校准骨架注入（D5） | S1 只记录命中 | ≥50 提示且误报 <10% → S2；≥20 次有效校准 → S3 |
| 登记处 | `FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms[]`，含 `executorStage` 与回退动作（PP-4） | 一次只升一阶（PP-6） |

## 7. 验收判据

- **A1（说明书）**：`KHY_IMAGE_CONTEXT_CARD=1` 下 TUI 粘贴一张报错截图、零文字回车 →
  送网关的 user 消息含「【图片说明】…【OCR 转录】」块，场景判定 = error-screenshot；
  `KHY_IMAGE_CONTEXT_CARD=0` 时消息逐字节与改前一致。
- **A2（降尺度）**：对一个 27MB PNG 执行 `readImageFromFile` → 不再抛
  `Image too large`，返回 ≤5MB 的 PNG 且带 `downscaledFrom` 元数据（实测 866ms，
  2026-09-27）；说明书含「预处理」行；无 ffmpeg/绘图工具的环境仍抛错且消息含修复建议；
  `KHY_IMAGE_AUTO_DOWNSCALE=0` 时错误文本逐字节等于旧版（已锁进单测）。
- **A3（持久化）**：带图会话 `khy resume` 后追问「图里第三行写的什么」→ 引用回读成功；
  删除 `.khy/images/` 中对应文件后重试 → 降级 OCR 摘要 + 一行如实提示，不崩。
- **A4（登记）**：对 `.khyos/vision_capability.json` 中有 `verdict:vision-ok` 记录的 adapter，
  `adapterVisionCapability` 返回 true；无记录者维持保守 false。
- **A5（回归）**：`node scripts/ci/check-agent-rules.js --changed` 零 error；
  既有 `tests/` 图片相关套件全绿且新增用例断言输入图片数 >0（防空转）。

## 8. 非目标与不支持清单

- **不**新建图像依赖（sharp/jimp 等）——预处理继续走平台外部工具，缺工具即 fail-soft。
- **不**新增顶层 CLI 命令/别名（`PROCESS-014` 棘轮）；一切入口挂既有 `image`/`paste`/TUI 附件。
- **不**做自训 OCR/超分模型；放大（waifu2x/Real-ESRGAN 类）超出本仓边界，指南该节按
  「用户自备工具」处理。
- **不**承诺像素级还原：说明书是「校验层」而非替代模型视觉（指南误区一的对偶——也不替代人）。
- 手写体识别率、暗色模式自动转亮：S1 阶段明确**不支持**，写入本节留痕。

## 9. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 说明书文本污染 prompt（用户只想发图） | 卡片前置分隔标记，token 预算计入既有 `glmVisionTextBudget`；`KHY_IMAGE_CONTEXT_CARD=0` 单开关全退 |
| 降尺度改变像素导致「尺寸估算更糟」 | 降尺度仅在 >5MB（原本必失败）路径触发，不改变可达路径的字节 |
| 会话磁盘膨胀 | 内容寻址去重 + >2MB 不复制字节 + `off` 全退 |
| 探针灌入登记误放开坏 adapter | 只读取已落盘的实测 verdict；env 覆盖通道优先；探针本身维持既有只增不改语义 |

回滚命令（规则 7 `rollback.txt` 兑现）：各开关显式置 `0`/`off` 即逐字节回到旧行为；
代码级回滚 `git revert <本方案提交>`。
