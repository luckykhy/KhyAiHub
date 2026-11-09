<!-- IMPL-STATUS: todo -->
<!-- IMPL-DRIFT-AUDIT: 2026-10-18 · DOCS-005 范围补标，依据见下 -->
> **标记依据**：文中无根锚定路径主张，无从判定是否落码；保守标 todo 待人工复核。
# [DESIGN-ARCH-130] 任务叙事-热奈特话语层

> 状态：已实现（2026-10-15）
> 实现：`runtime/node/backend/src/services/domain/trajectory/trajectoryNarrative/`
> 入口：`khy recap narrative [sessionId] [--mode process|result|both] [--focus task|reasoning] [--polish] [--out file]`
> 测试：`node --test runtime/node/backend/src/services/domain/trajectory/trajectoryNarrative/trajectoryNarrative.test.js`（12 例）

## 1. 需求五问（RUNTIME-008）

1. **谁用？** 复盘一次任务执行的人——维护者看 AI 干活的过程，或用户想知道
   「这几分钟里它到底做了什么」。（source: 用户 2026-10-15 原话「实现 khyos 任务叙事过程描述」）
2. **什么时候用？** 会话结束后（事后叙述），经 CLI `khy recap narrative` 触发；
   与 `/recap` 同入口——recap 回答「发生了什么」，narrative 回答「怎么发生的」。
3. **现在的替代做法是什么？** `khy trace show` 逐条看溯源轨迹（结构清单，无叙事）；
   `/recap` 出主题/决策清单（有结果无过程）；`khy replay run` 重放（面向验证不面向阅读）。
   三者都是「证据陈列」，没有一处把过程**讲出来**。
4. **成功长什么样？** `khy recap narrative <sessionId>` 输出一篇 Markdown：
   结果叙事在前（预叙）、过程叙事在后，过程段每句带 `[#n]` 证据锚点，
   文末锚点表可逐条回到 transcript 验真；无模型时完全可用。
5. **不做会怎样？** 用户只能对着 JSONL 逐行脑补过程；轨迹栈的全部录制投入
   （账本/时间线/溯源）到不了「人读」这一层。

## 2. 理论映射：故事与话语

热奈特《叙事话语》的根本区分是**故事**（实际发生了什么，真实时序）与
**话语**（怎么讲）。它与本仓轨迹栈的既有架构同构：

| 叙事学概念 | 本仓对应 |
|---|---|
| 故事 fabula | `sessionPersistence` 的 JSONL transcript（`_timeline`/`_toolCalls`/`_turnStats` 增量字段 + 老式 `tool_use` 内容块）——**录制侧，不新增采集** |
| 话语 discourse | `trajectoryNarrative` 四件套：collectStory（摊平）→ buildNarrative（五范畴算子）→ renderNarrative（成稿）→ maybePolish（可选修辞层） |

录制侧刻意保留结构化证据、人读层只做投影，是本仓既有哲学
（`traceProjection`/`mapAuthor` 皆然）；本设计把「投影」升级为「叙事」，
但红线不变：**投影可以重排、压缩、省略，唯独不许虚构**。

## 3. 五范畴算子（话语层的全部判定规则）

### 3.1 时序 Order

- **顺叙**为默认：故事层事件按真实时间序进入，段落顺序不打乱。
- **倒叙 analepsis**：同一目标被写入类工具（edit/write/createfile/notebook）
  再次修改、且两次写入之间隔着其它单元（连续重复已被频率算子合并，不算折返），
  后来的段落前置「回到第 k 步：」并挂 `analepsis.backTo` = 首次写入的 seq。
- **预叙 prolepsis**：文档层装置——`--mode both` 时「结果叙事」置于
  「过程叙事」之前，先讲结局再回溯经过。结果叙事复用
  `sessionRecapService.generateRecap` 的确定性抽取（主题/决策/改动文件/未决问题），
  不另写一套。

### 3.2 时距 Duration

| 档位 | 判据 | 叙述方式 |
|---|---|---|
| 场景 scene | 用户请求；工具组含失败；写入类工具；耗时 ≥10s（`sceneMs`） | 逐拍展示：直接引用命令、错误一行、耗时 |
| 概要 summary | 常规只读工具、assistant 文本、上下文压缩事件 | 连续概要压成一段，分句以「；」连接 |
| 省略 ellipsis | `turn.end` 统计事件、空段、外聚焦下的 thinking | 丢弃（折入头部统计行） |
| 停顿 pause | thinking 段（仅 `--focus reasoning`） | 「KHY 分析：…」叙述性反思段 |

### 3.3 频率 Frequency

连续同名同目标的工具调用合并为一组（复数叙述）：有成功记录讲
「先后 N 次 X（第 k 次成功）」，全败讲「均未成功」，**结局无记录时只讲
「其中 k 次失败，其余结果无记录」或不标次数**——老式 transcript 只有
`tool_use` 块没有结果块，「无记录」绝不允许讲成「成功」。

### 3.4 语式 Mood

- **聚焦**：`--focus task` 外聚焦（只讲行动与结果，thinking 省略）；
  `--focus reasoning` 内聚焦（thinking 以停顿段进入叙事）。
- **距离**：场景=展示（直接引用命令与错误文本），概要=叙述（转述不引用）。

### 3.5 语态 Voice

固定：**外叙述者 · 事后叙述 · 第三人称「KHY」**——与 `traceProjection`
的 `✓ KHY executed` 字形同一主体。叙述者不进故事、不评价、不预测。

## 4. 证据锚点：不虚构的机制保证

1. 故事层每条事件领一个全局 `seq`；话语层的每个段落携带其来源事件的
  `anchors: number[]`。
2. 成稿时段落文本末尾附 `[#n]`，文末「证据锚点」表逐条列出
  `seq → 时刻 / 事件种类 / 摘要`。
3. 过程段出现的每个 `[#n]` 必须在锚点表中存在（单测断言双向完备）。
4. 润色层（`--polish`，门 `KHY_NARRATIVE_POLISH` 默认关）经
  `llmGenerateSink` 单轮调用，prompt 硬约束「保留全部锚点、不得新增事实」；
  成稿过 `_validatePolish`：**丢锚点 / 造锚点 / 超长 3 倍，一律丢弃回退骨架**。
   模型只改文风，不改事实——与 `mapAuthor` 的强度门同一哲学：
   模型是可拔插的修辞层，骨架才是可信叙事。

## 5. 数据契约

**输入**（只读，绝不写 transcript）：

- 首选 `_toolCalls[i] = { seq, name, paramsSummary?, durationMs?, status, error? }`
  与 `_timeline[i]`（TUI 回合产物，含结果与耗时）；
- 回退 `content` 数组里的 `tool_use` 块（老式 transcript）：只取
  `name` + `input` 的目标键（file_path/path/command/query/pattern/url），
  `outcome` 留空（结果块不落盘）。
- relay 产出的裸 `</think>` 残签是标记不是叙述，故事层直接丢弃。

**输出**：`{ markdown, anchorCount }`；`--out` 落盘在 handler 层。

## 6. 入口与棘轮合规

挂在既有 `khy recap` 的子命令（`ROUTER_SUB_COMMANDS.recap = ['narrative']`）：
PROCESS-014 任务面棘轮的命令/别名/handler 三计数不变。门控 `KHY_NARRATIVE`
默认开；`KHY_NARRATIVE_POLISH` 默认关（触模型须显式 opt-in）。

## 7. 边界（不支持清单）

- 不做跨会话叙事（一次一篇，sessionId 为界）；
- 不接入 replay-ledger 的内容寻址字节（那是验证通道，叙事只要语义层）；
- 润色不做多轮迭代、不做风格选项（一轮、单 prompt、失守即回退）；
- 不生成英文叙事（面向用户的字符串一律中文，仓规）。
