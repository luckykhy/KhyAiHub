<!-- IMPL-STATUS: todo -->
# [DESIGN-ARCH-161] 任务执行时延与质量优化方案（对标 ZCode 主循环）

<!-- RULES-REGISTRY: RUNTIME-003, PROCESS-008 -->

> **状态**：部分实施（P0-2 / P0-3 / P1-1（上限部分）/ P3（截断抢救 + taskScale 下限）已落地，
> 见 §5；P0-1 / P1-2 / P2 及 P3 运行时路由部分因目标文件在途受阻，见 §5.6）
> **范围**：`services/backend` AI 请求前置链路与回放记账路径。**不改** `toolUseLoopCore.js` /
> `replSession.js` / `toolUseLoop/*` 内核——该线为在途神文件重构（任务 #7），本方案与之解耦。
> **上游依赖**：ZCode 核心源码镜像（`.khy/feedback/zcode-gap-analysis-20260921/zcode-src/`，
> 上游 https://github.com/zai-org/ZCode ，Apache-2.0，仅对标引用、未借代码）。
> **调研指针**：[DESIGN-ARCH-113]（三模态反馈契约）、[DESIGN-ARCH-118]（多机协作）、
> `RUNTIME-003`（活动式超时——本方案的定时器全部为预算/去抖型，无任务硬 kill）。

## 0. 一句话结论

同样一件任务 khy-os 比 ZCode 用时更长且质量更差，**主因不是模型调用本身慢，而是每一轮都背着
一份未缓存的巨量上下文重复全价往返、首回合付阻塞式预热、失败路径叠加固定睡眠、以及每工具同步
写盘串行化了本可并行的执行段**。质量差则由「模型路由按来源可信度而非能力排序 + 工具结果机械
头尾截断」两个旋钮造成。本方案按 P0（低风险速改）→ P3（能力面）分档，P0-2/P0-3 已实施。

| # | 病灶 | 现状证据（file:line） | 后果 |
|---|------|----------------------|------|
| L1 | 每轮全量重发、无 prompt caching | `constants/prompts.js:564`（getSystemPrompt 每轮重跑）；`toolUseLoopCore.js:2749`（整段 `conversationMessages` 重发） | 每轮为同一几千行前缀付全价 token 时延，注意力被稀释 |
| L2 | 首回合阻塞预热 | `aiChatCore.js:1660-1691`（RAG 同步）；`:1714`（预取 `await Promise.race` 软超时 2s） | 首 token 前凭空多 0-2s |
| L3 | 网关探活串行 | `aiMessageBuilder.js:1083-1110`（`for` 逐适配器，各 3s、总预算 6s） | 最坏 3×3s 顺序累加 |
| L4 | 失败路径睡眠堆积 | `tool/loop/recovery.js:179`（默认 1200ms）；`aiGatewayGenerateMethod.js:6222-6225`（退避至 12s）；5xx 冷却 15s；`:3853` 串行 failover | 一次抖动 = 十秒级纯等待 |
| L5 | 循环内隐藏整轮 | `toolUseLoopCore.js:2685`（压缩为 await 的额外模型往返，`:2655` 注释自认「长停顿」）；`:1813`（截断续写=多付整轮） | 偶发单轮 10s+ 停顿 |
| L6 | 每工具同步写盘 | `replayLedger.js:208-211`（`mkdirSync`/`appendFileSync`）；`toolUseLoopCore.js:7591`（PostToolUse 钩子串行 await） | 并行工具批次被磁盘 I/O 重新串行化 |
| Q1 | 模型路由能力缺位 | `gateway/autoModelSelect.js:17,209`（按「发现来源可信度」排序）；弱模型补偿层 `weakModelGuidance.js` 存在本身即证据 | 免费/弱通道成为事实默认 → 质量差 |
| Q2 | 工具结果机械截断 | `tool/toolResultCompressor.js:19-29`（>10k 时留头 3000+尾 3000） | 长日志/大文件的**中间证据**丢失，模型据残缺信息行动 |
| Q3 | 无子代理后台并行 | ZCode `methods__subagent.ts:69-295` + `turn-loop.ts:57-60`（结果中途回流）；khy 无对应机制 | 无法把可并行工作甩出关键路径 |

### ZCode 对照锚点（镜像源码，只读引用）

| 维度 | ZCode 做法 | 证据 |
|---|---|---|
| 缓存 | 投影后统一 `applyCacheControl: true` + cache 命中记账 | `turn-loop.ts:168-176`；`turn-model-step.ts:448` |
| 工具调度 | 拓扑排序 + 并发 10 + 只读即并行，非并行工具独占单组 | `tool__scheduler:48,85-204` |
| 流式重叠 | 工具在模型流式期间即开始执行（`executionTiming:"during_stream"`） | `turn-model-step.ts:256-258`；`turn-tools.ts:104` |
| 前置 | 每步仅过期检查+已热 MCP，**无**分类/RAG/安全前置 | `turn-loop.ts:105-146` |
| 压缩 | microcompact（cheap-first）→ autoCompact 双层 + 溢出反应式恢复 | `turn-loop.ts:69-78`；`turn-model-step.ts:742` |
| 恢复 | 锚点式恢复，`model_stream_stalled` 与请求失败分治，不盲目睡 | `turn-model-step.ts:225-278` |

## 1. 根因分析

**时延结构** = 每轮固定成本（L1 主导）+ 首回合摊销（L2/L3）+ 失败税（L4）+ 偶发整轮税（L5）
+ 执行段串行税（L6）。其中只有 L1 需要架构级动作（适配器透传缓存语义），L2-L6 均为局部改造。

**质量结构** = 路由（Q1）决定「谁在想」，截断（Q2）决定「它看得见多少」，L1 无缓存在长对话中
同时抬高两者成本（截断后的历史每轮重编码，错误累积）。Q3 是能力缺口，非缺陷。

## 2. 优化方案分档

### P0-1 · Prompt caching（提案，未实施）

把系统提示拆「静态前缀（工具说明、风格规范等）+ 每轮动态尾巴（任务板、MCP 状态、注入指令）」，
`getSystemPrompt` 增加分段返回；`aiGateway` 各适配器按供应商透传缓存语义（Anthropic
`cache_control: ephemeral` 打在前缀块；OpenAI 兼容通道天然前缀缓存——只需保证前缀字节稳定）。
历史侧按 ZCode 体例在投影层统一打缓存点。**前置**：需先给适配器层加分段 system 能力矩阵，
属跨文件改动，且与 #7 重构线相邻，等其收口。

### P0-2 · 回放账本异步批量写盘（✓ 已实施，见 §5.1）

`replayLedger.recordToolTurn` 的 `mkdirSync`/`appendFileSync`（每回合热点）改为**每路径
内存行队列 + 去抖异步 flush**；`read()` 合并未刷队列保证「写后可见」一致性；进程 `exit`
兜底同步 drain，`exportBundle` 入口显式 `drainSync()`；内容库 blob 写（仅 write-diff 触发、
导出语义假设落盘即在）**刻意保持同步**。`KHY_REPLAY_LEDGER_SYNC=1` 退回同步原行为。

### P0-3 · 网关探活并行化 + 预取预算收紧（✓ 已实施，见 §5.2）

`_preflightGatewayAvailability` 的 auto-pick 分支由 `for` 串行改为并行发射
（每探针自带 `adapterProbeTimeoutMs` 上限）+ 总预算 race；**结果仍按原列表顺序取第一个
全绿者**，保持「有序偏好」语义不变。首回合代码库预取默认预算 2000ms → 1200ms。

### P1 · 调度与失败路径（提案）

1. **并行退化范围收窄**：`toolExecutionEngine.js:143-172` 注册表不可用时整批转串行 →
   改为仅未知工具各自成单例组（对齐 ZCode `tool__scheduler:195` singleton group），
   已知只读/无副作用工具照常并行；并发上限 8 → 10。
2. **恢复去睡眠化**：`recovery.js:179` 的 1200ms 固定 delay 改事件驱动/滑动；对**幂等**
   请求（读、检索、探活）引入 hedged race（并行发 2、最快返回者胜、弃者 abort），
   写类保持串行 failover。`RUNTIME-003` 合规：均为预算型，不 kill 任务。

### P2 · 上下文管线（提案，与 #7 收口后合流）

流式期间监测 token 水位，撞墙前**后台**跑压缩、循环内换引用（消灭 L5 的循环内模型往返）；
对齐 ZCode microcompact→autoCompact 双层（khy 已有 cheap-first 清理层——G-K-compact
证伪记录在案，本档只做「移出热路径」增量）；截断续写合并进同一轮。

### P3 · 质量面（提案，按规则 6 先答需求五问）

`autoModelSelect` 增加能力维度（任务规模=large 时能力优先于来源可信度）；工具结果截断改
**结构化摘要**（保错误行/结果行而非机械头尾）；对工具密集任务提供「turn 1 并行所有 Read /
turn 2 并行所有 Write」的子代理提示模板（ZCode `memory__extraction:56` 体例）。

## 3. 非目标与边界

- 不改执行内核（`toolUseLoopCore.js` 及其伴生文件）——#7 在途，动它即踩踏。
- 不引入任何新的拦截型机制，故不触发 `PROCESS-008` 登记；本文件是设计文档，非门。
- ZCode 源码仅作对标引用，未借用任何实现（`[DESIGN-SOURCING-001]` 借鉴边界）。

## 4. 验证手段

1. **计时探针先行**（学 ZCode `beginLocalTurnPreparation`）：对 preflight、ledger 写、
   首回合预热分段计时并落 `onStatus`，优化前后各取同一命令的原始输出存
   `.khy/feedback/<task-id>/repro-before.txt` / `repro-after.txt`（规则 5）。
2. 单元验证：ledger 写后 `read()` 立即可见含未刷条目；`exit` 后文件行数 = 记录数；
   `KHY_REPLAY_LEDGER_SYNC=1` 行为与旧实现逐字节一致。
3. 探活并行验证：预算 600ms 下 3 个慢适配器（各 3s）总耗时 ≤ ~预算+探针超时上限，
   且选中结果与串行版一致（顺序优先）。
4. `node scripts/ci/check-agent-rules.js --changed` 全绿。

## 5. 实施记录

### 5.1 P0-2 回放账本（2026-09-26）

- `services/backend/src/services/domain/trajectory/trajectoryReplay/replayLedger.js`：
  新增每路径 pending 行队列（**仅 JSONL 行**）；`_scheduleFlush` 去抖（默认 150ms，
  `KHY_REPLAY_LEDGER_FLUSH_MS` 可调，批量 ≥32 行即刻刷）；`read()` 合并 pending 保证
  「记录后立即可见」；`process.on('exit')` 同步兜底 drain；导出 `flush`/`drainSync`/
  `pendingCount`；`KHY_REPLAY_LEDGER_SYNC=1` 退回逐条同步落盘。
- **内容库（write-diff blob）刻意保持同步**：`exportBundle` 与「被删文件可复现」语义假设
  blob 落盘即存在；且它只在文件写改时触发，不是每回合热点。
- `replayBundle.exportBundle` 开头调用 `replayLedger.drainSync()`，杜绝导出漏掉未刷条目
  （它对 ledger 文件做逐字节 verbatim 拷贝，绕过 `read()` 合并）。
- 其余调用方（`toolUseLoopCore.js:7576/8487`、`handlers/replay|guide`）零改动。

### 5.2 P0-3 探活与预取（2026-09-26）

- `services/backend/src/cli/aiMessageBuilder.js`：auto-pick 分支改并行发射 + 顺序裁决。
- `services/backend/src/cli/aiChatCore.js`：`KHY_PREFETCH_MAX_MS` 默认 2000 → 1200。

### 5.3 P1-1 并发上限与分区（2026-09-26，部分）

- `tool/toolExecutionEngine.js`：`MAX_PARALLEL_TOOLS` 8 → **10**（`KHY_MAX_PARALLEL_TOOLS`
  可覆盖）。复核发现**分区器本已把不安全调用各自成单例串行 batch**（与 ZCode
  singleton-group 同语义），病灶表 L-并行一行的「整批退化」描述偏重，实际缺口只是
  上限与内核流式路径；内核侧上限（`toolUseLoopCore.js:7631`）属 #7 在途，未动。

### 5.4 P3 工具结果中段信号抢救（2026-09-26）

- **定位更正**：`tool/toolResultCompressor.js` 在 `src/` 内**无任何活调用方**（休眠模块），
  Q2 病灶的真实活路径在 `tools/ccOutputTruncate.js`（build/test/lint 三工具共用）。
- `ccMiddleTruncate` 新增中段信号行抢救层：省略区中命中 error/failure/异常 等信号
  且未出现在头尾的短行，按 1500 字符 / 16 行预算注入占位符后。**无命中时输出与历史
  逐字节一致**；`KHY_CC_TRUNCATE_RESCUE=0` 关闭。测试 13/13 绿（含零差异回归断言）。

### 5.5 P3-Q1 模型能力维度（2026-09-26，部分）

- **判断更正**：`autoModelSelect.rankAutoModels` 的首排序键**本就是**「距任务期望 tier
  的距离」（能力代理），来源可信度只是第三键——Q1 病灶中「按来源而非能力排序」表述不确。
  真正缺口是运行时从不传重任务的更高期望。
- 已落：`rankAutoModels` 新增 `opts.taskScale` 档位**下限**（large→T1、xlarge/huge→T0，
  只上抬不下调，不传逐字节回退）；`enhancedModelSelector.rankEnhancedModels` 转发该字段。
  测试 `tests/autoModelSelect.test.js` 12/12 绿。
- **受阻未做**：免费/弱通道的运行时置前逻辑在 `dynamicFreeModelService.js` 与
  `aiGatewayRoutingMethods.js`——两文件当前均为在途脏文件，按 §3 边界不触碰。

### 5.6 受阻项登记

P0-1（适配器透传缓存语义）、P1-2 网关侧（退避/冷却/hedged race，涉
`aiGatewayGenerateMethod.js` 与未跟踪新文件 `tool/loop/recovery.js`）、P2（预压缩，
与 #7 同线）——目标文件全部在途，等收口后按本文档 §2 推进。
`tests/enhancedModelSelector.test.js` 与 `gatewayAutoModelWiring.test.js` 为 jest 风格
而本机 jest 包未安装（`npm test` → jest），属既有环境限制，两文件在 HEAD 上同样无法
本机运行；纯叶子回归由 node:test 的 `autoModelSelect.test.js` 覆盖。
