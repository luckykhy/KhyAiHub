# [DESIGN-ARCH-163] 图文混合输入识别增强方案

<!-- RULES-REGISTRY: RUNTIME-001, RUNTIME-002, RUNTIME-003, PROCESS-008, PROCESS-014 -->

> **状态**：D1/D1.1/D2/D3/D4/D6/D7 已实施（2026-09-27）；D5 已实施且停在 S1 只记录档；
> D8.1（网页粘贴丢图修复）已实施（2026-09-27）；D8.2（手机通道）、D8.3（跨通道等值验收）与
> D9（附件渲染与回显契约）网页面已实施 2026-09-27（TUI/桌面维持现状降级，见 D9 实施记录）；
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

### D7（已实施 2026-09-27）不支持格式的诚实声明与引导：压缩包 / bmp / mp3 / 视频 …

D6 的引用卡目前只说「仅登记引用」——诚实，但**没给路**。D7 把「无通道」分支升级为
三段式：**①声明没读到什么 ②为什么 ③下一步可做的具体动作（按当前环境真实可用性生成）**，
并把该契约钉进卡内行为指令，模型转述而非编造。

1. **能确定提取的先榨干（零新依赖，全部复用既有软依赖链）**：

   | 格式族 | 本地确定性提取 | 通道缺失时如实声明的内容 |
   |---|---|---|
   | 图片 bmp/tiff（不在发送白名单的位图） | 文件头解宽高/位深/字节数；**ffmpeg 在场 → 自动转 png 走正常图轨**（卡注明「已转码」，D2 降尺度同族位置） | 「未做视觉理解，仅登记尺寸」 |
   | archive zip/tar（可读清单者） | python `zipfile`/`tarfile` 列目录（前 N 条+总数+加密标志） | 「包内文件未展开；加密包无口令通道」 |
   | audio mp3/wav/flac/m4a | ffmpeg `-probe` 容器元数据（时长/采样率/比特率/声道）+ ID3 标签 + **同目录同名 `.lrc` / 内嵌 lyrics 直接按 text 轨出摘录** | 「旋律/音调/人声内容未转录」 |
   | video mp4/mkv/mov/avi/webm | probe 时长/分辨率/帧率/编码/有无音轨 + **同名 `.srt`/`.vtt` 字幕或内嵌字幕流按 text 轨出摘录** + **ffmpeg 在场自动抽帧**（见下「视频专段」） | 「画面内容未采样/无视觉通道时未理解」 |

   **视频专段**——视频不是「黑盒格式」，是**可以被本地确定性地变成图 + 文本的容器**：

   - **V1 元数据与字幕（零新依赖）**：ffmpeg `-probe` 出时长/分辨率/帧率/编码/音轨有无；
     同目录同名 `.srt`/`.vtt` 或可提取的内嵌字幕 → 按 D6 text 轨摘录（上限同
     `KHY_FILE_CARD_EXCERPT_CHARS`）。字幕存在时卡注明「以下摘录来自字幕文本，非画面内容」
     ——两者是不同的证据等级，不许混称「看懂了视频」。
   - **V2 自动抽帧 = 图轨复用**：ffmpeg 在场 → 均匀抽 `KHY_VIDEO_THUMB_FRAMES` 帧
     （默认 3，钳 1–8；首/中/尾或等距），每帧**作为普通图片附件注入本回合图轨**——
     于是 D1 说明书、D2 降尺度、D4 视觉通道判定、OCR 兜底全部自动生效，零新代码路径。
     卡内编号 `视频帧 j/i`（如 `文件2·帧1/3`），与【附件对照】表同源。帧抽取走
     短 I/O 子进程超时（同 `KHY_FILE_CARD_TIMEOUT_MS` 族，≤10s 合法例外）+ 临时文件
     finally 清理（同 docx 轨）。成本控制：本回合图数已达 `MAX_CARDS` 上限 → 跳过抽帧
     并在卡内如实说明「已达单轮图上限，未抽帧」。
   - **行为分流**：视觉通道 verdict=supported（D4 台账）→ 抽帧被真视觉描述，
     卡尾汇总「帧说明来自 <通道> 视觉识别」；无视觉通道 → 帧仍走 OCR（录屏类视频
     的字幕/UI 文本可捞回），捞不到就如实「已抽帧但无理解通道」；ffmpeg 缺席 →
     仅 V1 元数据 + 引导「安装 ffmpeg 或运行 khy doctor 检查」。
   - **音轨**：视频含人声解说的转写与 mp3 同属 T2 音频通道（一个能力两处复用），
     T1 阶段卡内声明「音轨未转录」。

2. **引导文本按能力三态生成**（纯叶 `unsupportedGuide`：kind × 环境探测 → 动作列表）：
   - **本地可做**（ffmpeg/python 在场）→ 直接降级做了，卡注明引擎（上表）；
   - **配置可得** → 给正门命令：识图 = `khy gateway config` 配视觉通道；
     音频转写 = 配 audio-capable 通道；解包 = 让用户展开后按路径重发（不旁路权限）；
   - **有通道但未实测** → 接 **D4 探针台账**（`.khyos/vision_capability.json`）：
     当前首选通道 verdict ≠ supported 时，引导文案直接点名「已实测支持的通道」（若有）
     或「运行 khy gateway 视觉探测」。用户例「配置一个识图模型返回图片说明」即此闭环：
     配好 → verdict=supported → 同图下一轮走真视觉轨，说明书自动从「无视觉通道」
     切为视觉描述，无需改码。
3. **音乐「音调/歌词/说明」分级落地**：T1 本轮可做——歌词（.lrc/内嵌文本）+ 容器说明
   （元数据卡）；T2 音频转写通道（复用 D4「探针+台账+引导」模式登记 audio 能力）；
   T3 音高/调性分析（需 librosa 级 DSP python helper）——**候选登记、默认不做**，
   卡内永远如实：「旋律级内容无通道」。
4. **模型行为契约**（写进卡尾【行为约定】一行）：
   「本附件正文未经通道读取。用户问及此附件时：①先声明未读到 ②从本卡『可行动作』中
   给具体建议 ③禁止编造画面/旋律/歌词/包内文件内容。」提取失败分支（D6 已有）同式升级。
5. **门控**：`KHY_HONEST_UNSUPPORTED_GUIDE` 默认开；`0` → 引用卡逐字节回退 D6 文案。
   探测全部 fail-soft（ffmpeg 缺席即当不存在，不报错不阻断）。

验收判据：发 `x.zip song.mp3 shot.bmp demo.mp4` 四路径——bmp 出图卡（有 ffmpeg）或尺寸+引导卡；
zip 出目录清单+「展开后重发」；mp3 出元数据+（有 .lrc 则歌词摘录）+「旋律未转录」；
demo.mp4 出元数据卡，有 ffmpeg 时另出 3 帧进图轨（对照表见 `文件4·帧1/3`），有同名 .srt
则字幕摘录并注明证据等级；各卡尾均有【行为约定】；`KHY_HONEST_UNSUPPORTED_GUIDE=0` 时
卡文本与 D6 逐字节一致。

实施记录（2026-09-27）：纯叶 `services/unsupportedGuide.js`（三态引导 + CONTRACT 一行）；
编排层全部落在 `services/imageContextCardService.js`（归档清单走 python `zipfile/tarfile`、
媒体元数据走 ffprobe JSON、bmp 文件头解宽高、`.lrc`/`.srt`/`.vtt` 同名文本轨、
抽帧注入 `options.images` 图轨并同步 `frameRefs` 行进【附件对照】，零改 aiGateway 与在途 #7 文件）；
发现层扩展 `cli/repl/inlineFileRefs.js` 导出 `D7_MEDIA_EXT_SET`，仅在门控开时并入扫描扩展名集，
保证关档逐字节回退 D6。单测：`tests/services/unsupportedGuideD7.test.js`（9 用例）+
`tests/services/fileExtractionD7.test.js`（8 用例，B1–B6）。**诚实备注**：本机 ffmpeg/ffprobe
缺席（`searchExecutable` 均为 null），归档清单路径有真实 python 子进程集成用例（B1b）验证，
bmp 转码 / mp3 元数据 / 视频抽帧三族经注入 runner 缝验证——**引擎命令行为已按 ffprobe/ffmpeg
文档参数拼装，但未在本机对真实二进制端到端实测**，首次装有 ffmpeg 的环境应按上条验收判据复测。

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

### D8（D8.1 已实施 2026-09-27；D8.2/D8.3 批次待批准）四通道输入框统一契约：TUI / 网页 / 桌面 / 手机

先钉不变量：**通道差异只允许存在于「捕获 + 传输」层；归一（网关 `normalizeImages`）、
关联（【附件对照】`图i/文件j` 编号锚定）、理解（D6 提取路由 + D7 诚实引导）四层全通道
共享**。任何通道都不允许私有一套「说明书」——四通道发同一附件集，模型必须收到同一视图。

| 通道 | 图片/文件捕获 | 传输 payload | 现状 |
|---|---|---|---|
| TUI | 打字/粘贴**路径文本**（`inlineImageSubmit` 多路模式）+ 系统剪贴板 staging（`App.js` stagedImages 合并） | `{images:[{base64,mimeType,label}]}` | 已齐（D1.1） |
| 桌面（khy 原生壳） | 同 TUI：路径提取 + 剪贴板原生可读 | 同上 | 与 TUI 同源，验收即可 |
| 网页（ai-frontend） | 文件选择器 + **粘贴（D8.1）** → `POST /api/ai/upload` → `pendingAttachments[].id` | `{attachments:[ids]}` | 已接线（原「无 paste 粘贴即静默丢」bug 已修） |
| 手机 | 触摸无桌面式剪贴板 staging；捕获=相册/相机选择器 +（支持的浏览器）长按粘贴 | 同网页 ids 契约 | 未接线 |

**D8.1 网页粘贴丢图（已实施 2026-09-27，纯前端小改动集）**：
- 病根：`ChatInputBar.vue` 的 textarea 没有 `@paste` 处理——浏览器 paste 事件里图片以
  `clipboardData` File/Blob 形态存在（**浏览器永远拿不到本地路径**），现有唯一入口是
  picker，故粘贴被静默丢弃、「桌面/TUI 正常」的差异本质是原生壳能读系统剪贴板而页面没接线。
- 修法（与实施一致）：`ChatInputBar.vue` textarea 绑 `@paste="onComposerPaste"` →
  `clipboardData.files` 为空则**不拦截**（纯文本粘贴保持原生行为）；非空则 `preventDefault()`
  并 `emit('paste-attachments', files)`（实现接纳剪贴板里的一切文件，不限 `image/*`，
  与 picker 的「图片/视频/文档/项目」口径对齐）。`AIChat.vue` 侧 `onPasteAttachments` 与
  `onFilesSelected` 共用抽出的 `uploadAttachmentFiles` 循环：`FormData('file')` **复用既有
  `/api/ai/upload` 管线**（零新后端）→ `pendingAttachments` chip + 逐文件失败提示不阻断。
  截图 Blob 文件名常为 `blob`/空，仅按 MIME 补可读扩展名（`粘贴文件-<ts>-<n>.<ext>`），字节不动。
- 门控（实现偏差登记）：原设计 `KHY_WEB_PASTE_ATTACHMENT` env 变量；实际落在
  `localStorage['khy.webPasteAttachment'] === '0'` 关闭——Vite 前端 env 是**构建期**注入，
  做不到用户运行时可关；localStorage 键默认开、随时可关且刷新即生效。关档 = 完全回到
  「粘贴即忽略」旧行为。
- 网页粘「路径文本」：本地部署（页面与 backend 同机）时按 D6 文件卡路径语义处理；
  远程部署时必然命中「文件不存在或不可读」诚实卡——这是 D6 已有行为，不新增特判。
- 单测：`src/views/chatInputPaste.wiring.test.js`（6 用例，源码级接线契约：paste 绑定 /
  emit / 文本粘贴不拦截 / kill switch / 双入口共用同一上传循环）。

**D8.2 手机通道**：复用网页同一 paste/upload 契约（若手机走 ai-frontend 则 D8.1 自动受益）；
相册/相机选择走既有 picker；label 语义 = 文件名+内容寻址摘要（浏览器/移动端无绝对路径，
**不许伪装成路径**，对照表如实显示 `图1=IMG_2049.jpg（手机相册）`）。

**D8.3 跨通道等值验收（机器可判）**：同一贴图 + 同一文本分别从 TUI / 网页 / 桌面发送，
断言模型收到的【附件对照】表与卡结构逐字段一致（编号、来源形态、溢出诚实行）；
单测层面可在 node:test 用三通道 payload 构造 → 同一 `buildContextCard` 输出比对。

验收判据：网页粘贴截图 + 打「这图里报错怎么修」→ chip 出现、发送后卡与 TUI 同形；
`localStorage['khy.webPasteAttachment']='0'` → 行为与修复前逐字节一致（粘贴即忽略）。

### D9（网页面已实施 2026-09-27；TUI/桌面维持现状降级）附件在输入区与输出区的渲染与回显契约

D8 钉的是「怎么进来」；D9 钉「进来之后用户看得见什么」。现状实测（2026-09-27，
只读勘察）：网页输入区是图标+名字+大小 chip（AIChat.vue:634-658），**无任何缩略图**；
发送后气泡里 chip 是 `<a target=_blank href=/api/ai/upload/:id>`（:564-580）；TUI 发送后
只有计数角标 `📎×N`（Transcript.js:315 / transcriptLines.js:270-271）；说明书只注入
网关 prompt、任何界面都不回显（aiGatewayGenerateMethod.js:923-927）。

**四条原则**：

- **P1 单一真源**：渲染只由上传返回的 descriptor `{id,name,kind,mimeType,size,url,extracted,transcript}`
  （`aiUploadStore.toDescriptor`）驱动。四通道不许私养第二套附件形状。
- **P2 输入区回显「用户给了什么」**：文件名/大小/类型/上传态——本地事实，零后端调用。
  说明书内容**不进**输入区（那是模型视图，不是用户的）。
- **P3 输出区回显「当时发出了什么」**：descriptor 快照已随消息持久并可 reload 重建
  （AIChat.vue:3118-3127 存快照、:1101-1109 入会话、retract :3326-3328 还原），
  回显不得依赖任何 live 上传态。
- **P4 媒体必须走认证 blob 通道**：`GET /api/ai/upload/:id` 只认
  `Authorization: Bearer`/`X-API-Key` 头（aiManagementServer.js:1240-1241），
  裸 `<img src>` 与浏览器导航**必然 401**。缩略图与下载一律
  `authedFetch → blob → URL.createObjectURL`（组件卸载 revoke）。
  ⚠ 推论：现有气泡 chip 的 `<a target=_blank>` 今日疑似点开即 401 JSON——
  **属候选缺陷，实施第一步按规则 5 先对活后端复现，再处**（修法二选一：
  点击改走 blob 下载，或后端给该 GET 路由接受短时 query token；倾向前者，零新凭据面）。

**输入区（发送前）分型渲染**：

| kind | 网页/手机 | TUI/桌面（终端无像素，如实降级） |
|---|---|---|
| image | 44–72px 缩略图 chip（本地 `File` → objectURL，零上传依赖）+ × 角标；点按放大 | 维持既有 `📎 已附加 N 张图片`（ChatColumn.js:182） |
| document/text/code | 图标+名+大小 + 状态徽标：`已提取正文`（descriptor.extracted）/ 失败徽标 | 路径文本本身即回显（多路模式现状） |
| archive/audio/video | 图标+名+大小 + `已转写`（descriptor.transcript）等徽标 | 同上 |
| 上传态 | spinner chip 保留；**失败留痕**：红 chip + 重试/移除（现状失败只 toast 即散，chip 无痕——gap） | — |

**输出区（发送后回显）**：

- 用户气泡：image → 认证 blob 缩略图行（点按放大）；其余 kind → 与输入区同款 chip
  的快照版。资源 404/410（后端 GC 过期）→ 灰置「附件已不可用」徽标，**不许静默消失**。
- 助手侧不重复回显附件（维持现状）——模型的理解已在正文；说明书归模型视图。
- **候选（规则 6 待用户点头，默认不做）**：用户气泡加「模型看到了什么」折叠件，
  展示该回合注入的说明书卡。代价：说明书当前**不随消息存储**，需要网关装配处落一份
  副本——新持久面，单独批准。
- resume/reload：网页按 P3 快照重建；TUI 走 D3 `image_ref` 还原，缺文件出诚实占位。

**门控与验收**：

- 门控 `localStorage['khy.attachmentThumbs']` 默认开；`'0'` → 回到纯图标 chip，逐字节现状。
  （偏差登记：设计稿原写 env `KHY_ATTACHMENT_THUMBS`，实现改 localStorage——与 D8.1
  同一理由，Vite 构建期 env 做不到用户运行时可关。）
- 手机复用网页组件（响应式现有 flex-wrap 已够，无新分支）。
- 验收判据：网页贴截图 → 输入区见缩略图 → 发送 → 气泡内缩略图 + 刷新后仍在 →
  点旧附件**不见裸 401**（出「已不可用」或成功下载）；门控 `'0'`
  与 TUI 全路径行为逐字节不变。
- 单测面：blob 取图 helper（node:test，注入 fetch）+ 前端 wiring（气泡 image 分支
  必须走 blob，源码级断言禁裸 `img :src="att.url"`）。

**D9 实施记录（2026-09-27，按建议档）**：

- **401 缺陷已按规则 5 复现后处置**：对活后端 curl 无头 `GET /api/ai/upload/:id` →
  HTTP 401「未提供认证令牌」原始输出存
  `.khy/feedback/d9-attachment-echo-2026-09-27/repro-before.txt`；复诊
  `repro-after.txt`——后端路由刻意不变（仍只认头），修复面在前端 blob 通道，
  未走「query 短时 token」备选（零新凭据面）。
- **新文件**：`apps/ai-frontend/src/utils/attachmentView.js`（纯叶：
  `THUMBS_KEY`/`readThumbsFlag`（storage 抛错 fail-soft 默认开）/`isImageAttachment`/
  `attachmentBadge`（已转写 · 已提取正文）/`downloadFileName`（'blob'/无名 → id 兜底））；
  `views/components/MessageAttachment.vue`（输出区回显：三态机 loading/idle/ready/error，
  `authedFetch(url,{silent:true})` → blob → objectURL，silent 防附件失败触发整页登出；
  模块级缓存 Map + FIFO 封顶 64 回收 objectURL；失败不缓存可重试；过期灰置
  「附件已不可用」）。
- **AIChat.vue 接线**：输入区图片本地缩略图（objectURL 只挂首个描述符，remove/send/
  newConversation 三处 revoke；发送快照剥离 `thumbUrl`，历史里不落 blob: 死链）；
  descriptor 徽标（消费此前从未被前端读取的 `extracted`/`transcript`）；上传失败留痕
  （红 chip + 重试/忽略，仅门控开时记录，重试回灌同一上传循环）。门控关：bubble
  旧 `<a target=_blank>` block 以 `v-else` 原样保留，thumb/badge/failed 全部不渲染。
- **「模型看到了什么」折叠件按建议默认不做**（说明书不随消息存储，新持久面需单独批准）。
- **测试**：`utils/attachmentView.test.js`（8 用例）+ `views/chatAttachments.wiring.test.js`
  （19 用例，源码级锁 blob 通道、禁裸 `:src="att.url"`、门控、revoke/快照净化、
  失败留痕双分支）；全量 vitest 589/590（唯一红为 HEAD 既有 W8 棘轮，违规文件均在
  `src/components/**`，与本改动集无关）；vite build 通过；`check-agent-rules.js`
  显式路径全绿。
- **如实备注**：真实浏览器粘贴→缩略图→刷新回显的手测未在本环境执行（需登录态 UI），
  待用户或 browser-use 验证；TUI/桌面通道按分型表维持既有 `📎` 计数降级，未改动。

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
| `KHY_HONEST_UNSUPPORTED_GUIDE` | 开 | D7：不支持格式「声明+原因+引导」三段式卡；`0` → 回退 D6 纯引用卡文案 |
| `KHY_VIDEO_THUMB_FRAMES` | 3 | D7-V2 视频自动抽帧数（钳 1–8；0 或 ffmpeg 缺席 → 只出 V1 元数据卡） |
| `localStorage['khy.webPasteAttachment']` | 开 | D8.1 网页输入框粘贴文件→上传管线；`'0'` → 粘贴即忽略（修复前行为）。非 env：Vite 构建期 env 做不到用户运行时可关 |
| `localStorage['khy.attachmentThumbs']` | 开 | D9 输入/输出区图片缩略图、状态徽标与失败留痕；`'0'` → 纯图标 chip 现状逐字节。非 env：与 D8.1 同口径，Vite 构建期 env 做不到运行时可关 |

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
