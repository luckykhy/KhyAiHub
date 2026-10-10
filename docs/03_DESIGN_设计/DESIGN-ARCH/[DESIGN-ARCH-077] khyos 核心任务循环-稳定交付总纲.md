<!-- IMPL-STATUS: done -->
# [DESIGN-ARCH-073] khyos 核心任务循环 — 稳定交付总纲

> **定位**：khyos 执行一个用户任务时从「受理」到「交付」的**核心循环单一真源**——即任务最小闭环
> （登记 → 执行 → 裁决 → 交付 → 台账）的完整运行时契约。任何人（AI 助手、维护者、操作者）要回答
> 「khyos 怎么做任务、凭什么算交付完、坏了怎么查」都以本文为准。
>
> **2026-09-27 合并**：原独立方案件 `[DESIGN-ARCH-164] 复杂项目开发作业法 — 三档位阶段模型与机制映射`
> 的正文已并入本文 §7.1–§7.7 / §8.1 / §9.1 / §10 / §11，该独立文档**已删除**（避免第二套真源，
> `[MGMT-STD-008]` §2.2「重叠即违规」）。**编号 `DESIGN-ARCH-164` 已释放**，历史引用请改指本文。
> 本文适用范围相应扩展为「**任务执行循环本体 + 复杂项目作业法**」——§0–§6 仍是循环本体的单一真源，
> §7.1–§7.7 是其**复杂项目场景**下的作业法展开。

> **适用边界**：只描述任务执行循环本体；层级与依赖方向见 `[DESIGN-LAY-005]`，通道选择见
> `[DESIGN-ARCH-071]`，收尾裁决接线与交付台账的实现细节见 `[DESIGN-ARCH-072]`，持久任务（队列/租约）
> 的状态机见 `docs/10_规范/其它规范/RELIABILITY-PROTOCOL.md`（2026-09-10 规范目录拆分后迁至 `10_规范/`）。
> **代码锚点**：`services/backend/src/services/toolUseLoopCore.js`（循环本体，各门以文件内中文门名注释
> 为 grep 锚点）、`services/backend/src/services/agenticHarnessService.js`（harness 验证层）、
> `services/backend/src/services/backgroundTaskManager.js`（终态咽喉）、
> `services/backend/src/services/deliveryLedger.js`（台账）。

---

## 0. 闭环全景

```text
 用户任务
    │
    ▼
┌─ 登记 ────────────────────────────────────────────────────────┐
│ backgroundTaskManager.register() → durable 任务库            │
│ （.khy/tasks/large_task_runtime.json，canonical 状态机）      │
└──────────────┬───────────────────────────────────────────────┘
               ▼
┌─ 执行 ────────────────────────────────────────────────────────┐
│ runToolUseLoop（toolUseLoopCore）                             │
│   工具轮：解析计划 → <tool_call> → 权限网关 → 执行 →          │
│           写后回读自证 → 结果透明化 → 下一轮                  │
│   「想停」轮：门序见 §2（一致性门 → 软门 → 仲裁门 → 硬门）     │
│   有界性：MAX_ITERATIONS=100 · 墙钟 10 分钟 · 每门独立预算     │
└──────────────┬───────────────────────────────────────────────┘
               ▼
┌─ 验证（harness 路径；headless 为最小版）──────────────────────┐
│ 交付门 deliveryGate：验收包（空 criteria → 最小兜底）→        │
│   逐条评估 → 不过 → 修复循环 ≤3 轮                            │
│ VerificationAgent：语法/lint/test/build + 一次修复            │
│ 回归门：基线对比                                              │
└──────────────┬───────────────────────────────────────────────┘
               ▼
┌─ 裁决 ────────────────────────────────────────────────────────┐
│ buildHarnessDeliveryVerdict → pass/fail；fail 时把缺口        │
│ 如实追加进最终回复，绝不假装成功收尾                          │
└──────────────┬───────────────────────────────────────────────┘
               ▼
┌─ 交付 + 台账 ─────────────────────────────────────────────────┐
│ 终态咽喉 backgroundTaskManager.complete/fail/cancel →        │
│ deliveryLedger 追加 JSONL → khy deliveries 回查               │
│ headless -p 路径在 bin/khy.js 退出前入账（含循环报错回退）    │
└──────────────────────────────────────────────────────────────┘
```

**不变式（违反任何一条即闭环破损，评审按红线对待）**：

1. **登记必达**——凡走 harness/后台的任务必先 `register()`，有 ID 可查可取消。
2. **终态必达**——任务不得滞留 running；崩溃/中断走 boulder 断点（§5），可 `khy resume`。
3. **诚实收尾**——`close_partial` / 交付门 fail / 达上限时，缺口必须写进用户可见的最终回复与台账，绝不把过程当结果。
4. **有界续跑**——任何再驱动（nudge / redrive / remediation）都有独立预算，预算耗尽即降级收尾，绝不无限循环。
5. **证据门**——声称「测试通过/已验证」却拿不出真实验证命令记录 → 必须再驱动，声称即接受被禁止。
6. **台账必记**——每个终态（含失败与取消）都进交付台账，5 分钟 TTL 只清活动列表 UI，不灭台账。

---

## 1. 入口与路径矩阵

| 入口 | 命令 | 执行路径 | 验证层级 | 台账 |
|---|---|---|---|---|
| 交互 REPL（默认） | `khy` + 任务文本 | `agenticHarnessService.run()`（`KHY_REPL_HARNESS` 默认开） | 完整：交付门 + 验证代理 + 回归门 + 裁决 | ✓（经终态咽喉） |
| Headless 一次性 | `khy -p "任务"` | `runToolUseLoop` 原生循环（`KHY_HEADLESS_NATIVE_LOOP` 默认开） | 最小：循环内门序 + 台账如实入账 | ✓（bin/khy.js 退出前） |
| 一次性纯问答 | `khy --ai "问题"` | 单发 chat，无工具循环 | 无（问答非任务，不入账避免噪音） | — |
| 后台任务 | AgentTool/Task 工具/`agent run` | durable 队列 + worker | 循环内门序 | ✓（经终态咽喉） |
| 断点续跑 | `khy resume <taskId>` / `khy resume list` | boulder 检查点重激活 | 继承原路径 | ✓ |

---

## 2. 「想停」轮门序（模型不再调工具时的完整序列）

> 这是闭环的裁决核心。顺序即代码顺序（`toolUseLoopCore.js` 内按门名注释 grep 可定位）；
> 「一次性」指每轮循环至多触发一次，「有界」指带显式预算。

| # | 门 | 预算 | 门控（默认态） | 作用 |
|---|---|---|---|---|
| 1 | 项目一致性门 projectCoherence | ≤2 轮 | `KHY_PROJECT_COHERENCE_ROUNDS`（2） | 文件聚合后导入断链/入口失配 → 续推 |
| 2 | concludeNow 短路 | — | — | ≥400 字实质非占位答复直接进入收尾装配（省一轮模型调用） |
| 3 | 承诺式结尾 nudge | ≤2 次 | — | 「让我…/我将…」结尾却零工具调用 → 推它真执行 |
| 4 | 软门抑制判定 | — | `KHY_SUPPRESS_SOFT_REDRIVE`（开） | 实质答复已交付本轮 → 抑制后续软门，防同一答案重复生成 |
| 5 | deliverableClosure 收尾兜底 | 有界 2 | `CAP_SEAMS.EMPTY_TOOLCALLS` | 空壳收尾检测（[DESIGN-ARCH-050]） |
| 6 | selfKickoff 启动兜底 | ≤3 次 | 同上 | 「干了一半又回前言」→ 续推 |
| 7 | 选择腔 nudge | 一次性 | harness profile | 列选项不执行 → 推它执行 |
| 8 | 过短无结论 nudge | 一次性 | harness profile | 零工具+短回复+无结论 → 挑战 |
| 9 | 失败恢复 nudge | 一次性 | harness profile | 工具失败后短回复放弃 → 推它换方法 |
| 10 | 伪成功拒绝 nudge | 一次性 | harness profile | 已取回数据却回套话拒绝 → 用数据作答 |
| 11 | **任务收尾仲裁门** | ≤6（默认 1） | `KHY_TASK_CLOSURE_GATE`（开）；预算 `KHY_TASK_CLOSURE_REDRIVE_MAX`（1） | **权威三态仲裁**（§2.1） |
| 12 | 持久目标门 goalStopGate | ≤10（默认 1） | `KHY_GOAL_STOP_GATE`（开，父门控 `KHY_GOAL`） | 仅 `/goal set` 后生效；达成可自动清除 |
| 13 | coding 验证引导 | 一次性 | harness profile | 改了文件没跑 build/test → 推它验证 |
| 14 | 交付结论 nudge | 一次性 | harness profile | 有工具、回复短且无结论 → 要求补交付说明 |
| 15 | 覆盖率检查 | 一次性 | harness profile | 用户请求关键词覆盖率 <30% → 推它查漏 |
| 16 | 失败静默披露 | 被动 | — | 有失败工具调用且回复未提 → 追加披露 |
| 17 | 结果守卫 C | 一次性 | `KHY_RESULT_GUARD` | 承诺式前言未交付 → 追加诚实收尾 |
| 18 | Stop hook | 可否决 1 次 | hook 配置 | 外部 hook 可拦截自然停机 |
| 19 | answerVerifier | 被动 | `KHY_ANSWER_VERIFIER`（开） | 算式真值/动作声称与工具日志对账，证伪处如实追加 |
| 20 | 空回复兜底 → **close_partial 标注追加** → terminalNotice → return | — | — | 空回复由工具日志合成诚实小结；仲裁门降级标注经此通道流式必达 |

### 2.1 任务收尾仲裁门（#11，闭环的权威裁决）

判定在纯叶子 `taskClosure.decideClosure`（零 IO、可单测），接线处只做落地：

- **close**——终态交付 + 无未完成步骤 + 验证声称有真实命令记录 → 放行交付。
- **redrive**——注入 `buildRedriveMessage`（含原始请求 + 未完成步骤清单）再驱动一轮。
  - 结构化信号（`steps-incomplete` 计划步骤未完成 / `verification-missing` 声称验证却未真跑）是**硬门**：不受软门抑制（#4）拦截——实质性假完成正是抑制门的盲区；
  - 非结构化「无收尾词」再驱动尊重抑制，避免对已交付答案重复生成。
- **close_partial**——预算耗尽即诚实降级：未完成步骤/未经证实的验证/无证据逐条写入标注，随交付返回，绝不假装成功。
- **证据门**：`verificationCommandRan` 要求工具日志里真有验证命令（`params.command` 命中 build/test 模式），「口头上说测过了」不算。
- 作用域：仅 `actionTask`（`_looksLikeActionRequest` 命中）；纯问答/闲聊不受此门。

### 2.2 工具执行失败的多分支恢复梯子（toolFailureRecovery）

工具调用链路的异常按层次各有分支，**每个分支都有界**；判定在纯叶子
`toolFailureRecovery.js`（零 IO、可单测），接线处（并行/串行执行路径）只做 IO：

**A. 单次工具调用内部**（executeTool → ToolError 结构化，绝不崩循环）：
executeTool 自身把超时/取消塑成诚实可重试的结构化结果；循环侧 catch 再给一层
`toolRegistry` 直调二次兜底（并行/串行两条路径**同构**），仍抛才 ToolError 结构化入账。

**B. 工具执行后钩子**（既有意图等价替换，执行失败时依次尝试顶替）：
shell 失败 + 打开应用意图 → `open_app` 候选试跑；shell 失败 + 信息搜索意图 →
`web_search` → `search` → `toolSearch`；错误结果附平台命令提示（Windows/Linux hint）。

**B+. Branch N（工具名执行前确定性纠正，2026-08 新增）**：
近似错误的工具名（`read_fiel` / `web_serch` / `ReadFile` / `web-search`）此前原样进
executeTool → TOOL_UNAVAILABLE → 错误文本回灌模型，模型要花一整轮自行纠正。现在在
解析汇合后、执行前，用已知工具名集合（含别名/变体）做**保守**纠正：键归一（大小写/
分隔符/首尾空白偏差）→ 唯一编辑距离命中（短名 ≤1、长名 ≤2，键空间去重防同工具变体
互相顶票）；**歧义（并列最小）一律不猜**、完全无关名原样放行——错误信号不丢失，交
后续失败分支。纠正成功标 `_originalName` 留痕。判定在纯叶子 `toolCallCorrection.js`，
门控 `KHY_TOOL_NAME_CORRECTION`（默认开）。

**C. Branch R（工具级瞬态自动重跑，2026-08 新增）**：
失败结果满足「瞬态（`error.retryable` 标记 / `TIMEOUT`·`NETWORK_ERROR` 码 / 瞬态文本特征：
ECONNRESET、socket hang up、rate limit、429/529/503…）**且**工具在只读白名单
（read/grep/ls/web_search/web_fetch/git 只读等，幂等重跑无副作用）**且**循环级预算
未耗尽（`KHY_TOOL_TRANSIENT_RETRY_MAX`，默认 2，clamp [0,5]）」→ 以新中断计划 + 原执行
契约自动重跑一次，成功顶替结果并标 `_transientRetried`。**写类工具（shell/write/edit）
绝不自动重跑**——副作用不可重复，失败一律交回模型裁决（Branch H）。

**D. Branch C（chat() 意外抛出的循环内重试，2026-08 新增）**：
适配器抛异常此前一律归一为「诚实本轮结束」——网络抖动类抛出在无人值守 run 里直接终止
本轮（headless 甚至终局）。现在守卫归一**之前**先给一条有界分支：异常文本命中瞬态特征、
非 cooldown、预算未耗尽（`KHY_TOOL_LOOP_CHAT_THROW_RETRIES`，默认 1，clamp [0,3]）→
退避后原地重发同一轮；耗尽/非瞬态 → 原诚实收尾逐字节保留。

**E. Branch H（诚实失败 = 安全默认）**：其余失败原样放行——错误文本（含 `hint`）回灌
模型，由模型决定换参/换工具/拆步；反复同参失败由 doomLoopGuard / loopDetector 断路器
接管；空回复守卫、transient 通道恢复、maxTokens 恢复各自有独立预算（§2 门序）。

**分支裁决准确性红线**（`toolFailureRecovery.decideToolRecovery`）：
- **确定性失败码优先**——`PERMISSION_DENIED` / `INVALID_ARGS` / `RESOURCE_NOT_FOUND` /
  `TOOL_UNAVAILABLE` / `MISSING_DEPENDENCY` 五码**压过** `retryable` 标记与文本特征：
  上游误标 retryable 的参数错误绝不触发自动重跑；
- **负向文本守卫优先于正向特征**——错误文本同时含确定性签名与瞬态字样时（如
  "invalid argument: timeoutMs must be < 120000"）判非瞬态，防 "timeout" 字样误判空跑；
- **只读白名单门槛**——写类工具（shell/write/edit…）瞬态失败绝不自动重跑，副作用
  不可重复；
- **纠正歧义不猜**——工具名纠正遇并列最小编辑距离一律放行，错误信号交模型与探索分支。

### 2.3 输出区分级显示（核心抢占焦点 / 次要折叠防凌乱）

**单一真源**：`cli/toolDisplayPolicy.js` 的**显示矩阵**（家族 × tier × 渲染样式 × 说明文案，
同一注册表）。分级依据＝工具名清单（ALIASES 把注册表 **151 个工具全部**归一到 ~55 个家族），
不看参数；**未注册工具默认 core（宁可见到，不可漏掉）**。
`toolDisplayMatrix.test.js` 是完整性强制门：注册表新增工具而矩阵未分类 → 测试失败，
逼着维护者给新工具一个明确的显示位（tier + 说明 + 样式）。

**视觉语言三级层次**：`▌ 加粗焦点行`（core 说明，抢占焦点）＞ `⏺/◆ 头行` ＞ `⎿ dim 结果行`。
说明文案（intentLabel）是矩阵字段：`_describeToolIntent` 的 switch 只保留高频家族的
参数感知文案（"看看 x.js 里的内容"），**其余全部家族回退到矩阵 intentLabel**——
此前 ~100 个工具没有说明行，现在全部有。目标摘要由调用方拼参数链
（path/file_path/url/query/command/prompt/code/symbol…）。

**家族 → 显示方式矩阵**（★=core 抢占焦点常驻；○=minor 显示后折叠；样式列见下注）：

| 家族（代表性工具） | 级 | 说明文案 | 结果样式 |
|---|---|---|---|
| bash（PowerShell/shellCommand/REPL） | ★ | 执行命令 | **命令预览块**（boxPreview 底色块）+ ⎿ tree 6行 |
| codeexec / testrun / build / deps | ★ | 执行代码 / 运行测试 / 构建编译 / 管理依赖 | tree 8行 |
| write（writeFile/createFile） | ★ | 写入文件 | diff 红绿 10行 |
| edit（editFile/MultiEdit/apply_patch） | ★ | 编辑文件 | diff 红绿 10行 |
| open_app / desktop（ComputerUse/RPA） | ★ | 打开应用 / 桌面控制 | tree 6行 |
| browser（WebBrowser） | ★ | 操作浏览器 | tree 6行 |
| agent（Workflow/adoptRole/Team） | ★ | 委派子代理 | delegate（子代理树接管） |
| gitcommit / gitpush / gitclone（forgeCommits） | ★ | 提交变更 / 推送远端 / 克隆仓库 | tree 6行 |
| taskstop（KillShell） | ★ | 终止任务 | tree 6行 |
| docwrite（createDocument/renderDocument） | ★ | 生成文档 | tree 8行 |
| convert（pdfToWord/image2web） | ★ | 转换/发布文件 | tree 6行 |
| scaffold（scaffoldFiles/createTool） | ★ | 创建文件结构 | tree 8行 |
| mediagen（image_generate/video_generate） | ★ | 生成图片/视频 | tree 6行 |
| mediaedit（image_edit） | ★ | 编辑图片/视频 | tree 6行 |
| configwrite / importfam（Config/Configure 系） | ★ | 修改配置 / 导入模型配置 | tree 6行 |
| cron / trigger / deploy / shutdown / khyupdate / diskcleanup | ★ | 管理计划任务 / 远程触发 / 部署 / 关闭系统 / 更新 khyOS / 清理磁盘 | tree |
| worktree / planmode | ★ | 切换工作树 / 切换规划模式 | tree 4行 |
| mcp（MCPTool/McpAuth） | ★ | MCP 操作 | tree 6行 |
| skillload（Skill） / askuser（AskUserQuestion） | ★ | 加载技能 / 向你提问 | tree 4行 |
| read（readFile/notebookRead） | ○ | 读取文件 | collapsed 3行 |
| grep（search/searchContent） | ○ | 搜索内容 | tree 8行 |
| glob（find/ls/ListDir） | ○ | 查找文件 | tree 8行 |
| websearch（news/forgeSearch 系） | ○ | 搜索网页 | collapsed 4行 |
| webfetch（httpRequest/VaultHttpFetch） | ○ | 抓取网页 | collapsed 4行 |
| dataread / quote / dataquery / backtest | ○★ | 拉取数据 / 查询行情 / 查询数据库 / 运行回测★ | collapsed 4行（backtest★ tree 8行） |
| gitread（gitStatus/gitDiff/gitLog/gitBlame） | ○ | 查看 Git 仓库 | tree 8行 |
| taskmgmt（TaskCreate 系/TodoWrite/GoalTool/Brief） | ○ | 更新任务清单 | inline 3行 |
| memory（SaveMemory/LocalMemoryRecall） | ○ | 记忆读写 | collapsed 4行 |
| mediaread（imageOcr/RecognizeImage/video_analyze） | ○ | 分析图片/视频 | collapsed 4行 |
| verify（lint/security_scan/repoAudit/coverage） | ○ | 验证/检查 | tree 6行 |
| docread（Artifact/ReviewArtifact/inspectDocument） | ○ | 查看文档/产出物 | collapsed 4行 |
| mcpread（ListMcpResources/ReadMcpResource） | ○ | 查看 MCP 资源 | collapsed 4行 |
| appquery（DeviceApps/GetLocation） | ○ | 查询应用/位置 | tree 6行 |
| notify（SendMessage/PushNotify/SendUserFile） | ○ | 发送消息/通知 | collapsed 4行 |
| screencap（Snip） | ○ | 截取屏幕 | collapsed 4行 |
| cronread（CronList） | ○ | 查看计划任务 | collapsed 4行 |
| lsp / registryread / toolssearch | ○ | LSP 查询 / 检索注册表 / 搜索可用工具 | 6行/collapsed |
| aux（Sleep/unpack/Monitor 等内部辅助） | ○ | 辅助操作 | tree 4行 |

四条渲染路径消费同一份矩阵（判定在叶子、着色/布局在接线处）：
- **经典 REPL（TTY）**：`printStepLine` 接 `{toolName}` → 核心工具 `▌` 焦点锚点 + 加粗标签/目标，次要保持 dim（`steps.js` + `replSession` onToolCall 接线）；`toolProgressStart` 未收录家族回退矩阵 intentLabel（此前 ~100 个工具在 TTY 无进度行）；
- **管道/重定向输出**：`toolDisplay.printToolCallStart` 核心工具说明行以 `▌ + bold` 抢占焦点，次要保持 dim；
- **Ink TUI**（TTY 默认）：次要工具完成态收成 `⎿ 摘要 (ctrl+o 展开)` 一行；核心工具执行中 `↳` 叙述行 yellow+bold 强调（`ToolLines.js`）；
- **headless `-p`**：`headlessProgress.formatToolStart` 核心工具加 `▌` 前缀，次保持原轻量行（stderr，stdout 机器契约不动）。

全文回取不变：折叠只是显示层——`_expandableOutputs` + Ctrl+O（REPL）、expanded
prop（TUI）仍可取回完整输出，信息不丢失。

---

## 3. 验证与裁决层（harness）

`runToolUseLoop` 返回后，harness（`agenticHarnessService.js`）继续：

1. **交付门**：`intentGate.detectModes` → `buildAcceptancePack`（按意图模式生成验收标准；
   **criteria 为空时注入最小兜底** `substantive_final_response`——最终回复 ≥30 非空白字符，
   空壳/套话拒绝会被拦下）→ `evaluateDelivery` 逐条评估 → 不过进修复循环
   （`buildRemediationPrompt`，`KHY_DELIVERY_MAX_REMEDIATION` ≤3 轮）。
2. **验证代理**：VerificationAgent 对改动文件跑语法/lint/test/build（每步 60s 上限）+ 一次修复。
3. **回归门**：与任务前基线对比，防「修好一个弄坏三个」。
4. **裁决**：`buildHarnessDeliveryVerdict` 汇总 → `pass/fail`；**fail 时把「缺什么证据」如实追加进
   最终回复**，并把 `delivery-gate-report.md` 落盘到项目轨迹目录（`KHY_DELIVERY_GATE_REPORT` 开）。
5. **收尾**：清 boulder 检查点 → `backgroundTaskManager.complete/fail` → 交付台账入账
   （verdict=fail 的「完成」在台账记 `closure: delivery-gate-fail`，不谎报完整闭环）。

---

## 4. 台账与查询

| 需求 | 用什么 |
|---|---|
| 「上次任务交付了什么、缺什么」 | `khy deliveries`（别名：`交付` / `交付记录` / `台账` / `jiaofu`）；`--status succeeded\|failed\|cancelled`、`--task <taskId>`、`--limit n` 过滤；`khy deliveries stats` 看台账路径与条数 |
| 「这次执行跑了哪些操作、什么风险」 | `khy receipts list/show/search`（执行粒度回执，与台账互补：receipts 记操作，deliveries 记结论） |
| 「当前/历史活动任务」 | `/tasks`（REPL）或 `khy session`；活动列表终态 5 分钟 TTL 清理 |
| 「断了的任务从哪续」 | `khy resume list` → `khy resume <taskId>` |

台账为追加式 JSONL（`<dataHome>/tasks/delivery_ledger.jsonl`），自裁剪
`KHY_DELIVERY_LEDGER_MAX`（默认 500，clamp [1,5000]）；读取 fail-soft，坏行跳过、文件缺失返回空。

---

## 5. 失败模式与恢复

| 失败模式 | 系统行为 | 恢复手段 |
|---|---|---|
| 用户 Ctrl+C 中断 | `markBoulderInterrupted` 打断点（`.khy/boulder/boulder.db`，TTL 24h，512KB 上限） | `khy resume <taskId>` 或 REPL 提示恢复 |
| 循环达 100 轮 / 10 分钟墙钟 | 停止并如实标注「未完整闭环」（headless 可配 `KHY_HEADLESS_EXIT_ON_LIMIT` 反映退出码 3） | 拆小任务重跑，或 `khy resume` |
| 模型假完成（声称完成/验证） | 仲裁门 redrive → 预算耗尽 close_partial；harness 交付门 fail → 修复循环 ≤3 轮 | 交付门报告 + 台账缺口即「差什么」清单 |
| 近似错误的工具名（read_fiel 等） | Branch N：键归一 / 唯一编辑距离纠正后执行（留 `_originalName` 痕）；歧义不猜 | 歧义/无关名走 TOOL_UNAVAILABLE 失败 → unknown exploration 探索 |
| 工具循环整体抛错（headless） | 先走 Branch C：瞬态样抛出循环内有界重试（默认 1 次）；非瞬态/预算耗尽 → stderr 诊断（`KHY_HEADLESS_PROGRESS`）+ 台账记 `closure: error`，回退单发 chat | 依错误信息修复环境后重跑 |
| 只读工具瞬态失败（超时/网络抖动） | Branch R：只读白名单内自动重跑（默认 ≤2 次），成功顶替结果并标 `_transientRetried`；写类工具不自动重跑 | 非只读失败由模型换方法（Branch H） |
| 进程崩溃 | 任务滞留 running → 租约过期被 sweeper 回收重排（RELIABILITY-PROTOCOL） | worker 重新认领；无 checkpoint 则重跑 |
| 交付门误拦（真完成被判缺） | 修复循环后仍 fail → verdict fail 但如实附缺口，不静默丢弃成果 | 人工复核 `delivery-gate-report.md` 后放行 |

---

## 6. 环境变量总表（闭环相关，全部默认开/默认值即生产值）

| 变量 | 默认 | 管什么 |
|---|---|---|
| `KHY_REPL_HARNESS` | 开 | REPL 走 harness 完整闭环 |
| `KHY_TASK_CLOSURE_GATE` | 开 | 任务收尾仲裁门总开关 |
| `KHY_TASK_CLOSURE_REDRIVE_MAX` | 1 | 仲裁门再驱动预算（clamp [0,6]） |
| `KHY_GOAL_STOP_GATE` / `KHY_GOAL` | 开 / 开 | 持久目标门（嵌套父门控） |
| `KHY_DELIVERY_GATE` / `KHY_DELIVERY_MAX_REMEDIATION` | 开 / 3 | 交付门与修复循环 |
| `KHY_DELIVERY_GATE_REPORT` | 开 | 交付门报告落盘 |
| `KHY_ANSWER_VERIFIER` | 开 | 可证伪声称复核 |
| `KHY_PROJECT_COHERENCE_ROUNDS` | 2 | 一致性门轮次预算 |
| `KHY_SUPPRESS_SOFT_REDRIVE` | 开 | 已交付答案的软门抑制 |
| `KHY_TOOL_TRANSIENT_RETRY_MAX` | 2 | Branch R 工具级瞬态自动重跑预算（clamp [0,5]，仅只读工具） |
| `KHY_TOOL_LOOP_CHAT_THROW_RETRIES` | 1 | Branch C chat() 瞬态抛出的循环内重试预算（clamp [0,3]） |
| `KHY_TOOL_NAME_CORRECTION` | 开 | Branch N 工具名执行前纠正总开关 |
| `KHY_HEADLESS_NATIVE_LOOP` | 开 | headless -p 走原生工具循环 |
| `KHY_HEADLESS_PROGRESS` / `_TEXT` / `_HEARTBEAT` | auto/开/开 | headless stderr 进度反馈（stdout 契约不动） |
| `KHY_HEADLESS_EXIT_ON_LIMIT` | 关 | 达上限时退出码 3 + json 如实标注 |
| `KHY_DELIVERY_LEDGER_MAX` | 500 | 台账自裁剪上限（clamp [1,5000]） |

---

## 7. 稳定交付操作规程（操作者 / AI 助手）

1. **派任务**：能一句话说清验收标准的任务直接给；长任务先 `/goal set`——goalStopGate 会经 `completionContract` 从目标文本解析完成标准并逐条对证据，达成前拦截停止。
2. **跑任务**：交互用 REPL（完整验证）；脚本/CI 用 `khy -p`（最小闭环 + 台账）；重任务用后台（durable 队列，崩溃可续）。
3. **收工核对**：`khy deliveries` 看最近交付——`完整闭环` 才算完；`部分闭环`/`交付门未过` 的条目自带缺口清单，照单补课或重派。
4. **中断续跑**：任务被断后先 `khy resume list`，有检查点就 `khy resume <taskId>`，不要凭记忆重做。
5. **AI 助手维护守则**：改循环内任何门时——判定逻辑进纯叶子（照 taskClosure/goalStopGate 形状：零 IO、绝不抛、可单测）、接线处只做 IO 且整块 try/catch fail-soft、每门必须有独立预算、新终态必须入台账。

### 7.1 复杂项目作业法的现状证据

> 本节回答「在 khy-os 里开发一个**复杂项目**——跨模块大改造 / 从 0 到 1 新建 / 长时间无人值守批量——该怎么走」。
> 它是 §7 五条基本规程在**复杂项目**场景下的展开，**不替代、不改写**那五条。

**零件清单（全部实测，file:line。强度栏的「只记录」= S1 观察者，不阻断）**

| # | 能力 | 真源 | 强度 |
|---|------|------|------|
| 1 | 任务规模判定 small/normal/large | `services/backend/src/services/taskScale.js:103-147`（`_LARGE_INTENT` / `len >= 700` / `len >= 450 && hasLineBreak` / 多目标+编码意图） | 启发式，**只影响提示词与是否自动进计划模式** |
| 2 | 计划模式状态机 | `services/backend/src/services/planModeService.js:146`（`idle｜generating｜reviewing｜executing｜complete`）、`:558` / `:650` / `:1152` / `:1494` | 能拦（状态外调用被拒） |
| 3 | 计划前多方案选择 | `services/backend/src/services/taskComplexity.js` | 仅提示 |
| 4 | 逐步骤执行 + 重试 | `planModeService.js:1152 executePlanSteps()`、`:1181 maxStepRetry`（`KHY_PLAN_STEP_RETRY` 默认 1）、`:1296` | 能重试，**不能回退** |
| 5 | 人闸步骤 | `planModeService.js:740 requiresHumanGateStep()` | 能拦 |
| 6 | 步骤锚点（每步快照） | `services/backend/src/services/stepAnchorStore.js:332 createAnchor()` / `:440 listAnchors()` / `:478 restoreAnchor()` / `:555 verifyRestore()` | **只写**（见下「够不到」） |
| 7 | 锚点门控 | `services/backend/src/services/flagRegistry.js:3780`（`KHY_STEP_ANCHOR`，default-on，off=CANON）；`:3777` 注释「只写锚点 + 旁路台账，**绝不自动还原**」 | 默认开 |
| 8 | 锚点只读投影 | `planModeService.js:2173 formatAnchorSummary()`，挂 `cli/tui/ink-components/App.js:3679`（TUI 默认路径）与 `cli/replSession.js:8284`（REPL） | 只报事实，不承诺能力 |
| 9 | 爆炸半径闸 | `scripts/ci/check-agent-feedback.js:555-563`（`changes.length >= 4 \|\| buckets.size >= 3` → `fix-blast-radius`，归属 `RUNTIME-007`） | **只记录** |
| 10 | 删除分片闸 | `check-agent-feedback.js:535-539`（一次删 >10 文件 → `delete-needs-sharding`，归属 `RUNTIME-009`） | 能拦 |
| 11 | 交付门 | `services/backend/src/services/deliveryGate.js:507 evaluateDelivery()` → `:551` verdict（pass/warn/fail）、`:497`（未知 check 类型 → **判 fail**） | 能拦 |
| 12 | 验收判据 | `services/backend/src/services/acceptanceCriteria.js` | 空 criteria → 最小兜底 |
| 13 | 验证代理 | `services/backend/src/agents/built-in/verificationAgent.js` | 语法/lint/test/build + 一次修复 |
| 14 | 交付台账 | `services/backend/src/services/deliveryLedger.js:165 recordDelivery()` / `:196 listDeliveries()` / `:222 ledgerStats()` | 只记录 |
| 15 | 持久任务库 | `services/backend/src/tasks/largeTaskRuntimeStore.js`（落点 `getDataDir('tasks')/large_task_runtime.json`，`:484`；回退 `cwd/.khy-runtime/tasks/`，`:128`） | 有 |
| 16 | 重试策略分类 | 同上 `:88-105`（non-retryable 错误类型/状态码/kind、retryable kind、`default_retryable: true`） | 有 |
| 17 | worktree 隔离 | `services/backend/src/services/worktreeManager.js:161 createWorktree()`、`:206 bindWorktree()` | 隔离可用，**任务绑定未接线** |
| 18 | 后台 shell | `services/backend/src/tools/shellCommandEngine.js` + `tools/backgroundShellRegistry.js` + `BashOutputTool` | 有，**跨会话存活** |
| 19 | 后台子代理 | `services/backend/src/tools/AgentTool/index.js:474`（`run_in_background` 描述）、`:720`（执行）、`:750`（`_backgroundAgents` 存 **in-process promise**） | 有，**进程内** |
| 20 | HQ 任务板 + 租约 | `.ai/hq/PROGRESS.json:20-22`（`claimed_by` / `claimed_at` / `lease_expires`，默认 **120 分钟**） | 有 |
| 21 | 工具授权 | `RUNTIME-010`（默认拒绝、显式授予） | 能拦（S1 只记录） |
| 22 | 多机协作 | `[DESIGN-ARCH-118]`；`node services/backend/bin/khy.js hq verify` | 有 |

**★ 档位与闸强度解耦（本节最重要的一条现状判断）**

`taskScale` 的**消费方全部落在提示词层**：`cli/ai.js` / `aiChatCore.js` / `aiContextFlow.js` /
`aiGatewayGenerateHelpers.js` / `aiMessageBuilder.js` / `aiRequestAnalysis.js`；
`scripts/**`、`apps/**`、`software/**` 下**零消费方**（唯一命中 `scripts/ci/check-prompt-taxonomy.js:446`
是校验提示词段的 `dependsOn`，仍属提示词层）。

⇒ **闸这边完全不看档位**：爆炸半径闸只数「本次改动几个文件 / 几个顶层目录」，交付门只看验收判据。
**一个 `large` 任务和一个 `small` 任务，机制上享受完全相同的约束强度。**
即：§7.3 的三档位差异表**当前是「建议」而非「强制」**——要变强制须先补 §8.1 缺口 1。

**★ 三处「造好了但够不到」**（最容易被误读为「已有能力」，且**都不会让任何守卫变红**）

| 能力 | 事实 | 取证 |
|------|------|------|
| **步骤锚点回退** | `restoreToStep()` 定义在 `planModeService.js:2222`、导出在 `:2275`、**生产调用点 0 处**（其余出现全是注释：`:1198` / `:1205` / `:1350` / `:2115` / `:2165`）。**缺口与未决问题详见 `[IMPL-DOC-001]` §12.7**——本文不重复 | `git grep -n "restoreToStep" -- 'services/**' 'apps/**' 'software/**' \| grep -v /tests/` |
| **worktree 任务绑定** | `createWorktree()` 的**全部 3 个生产调用点都不传 `taskId`**：`cli/repl/worktreeCommand.js:126`（`{name, cwd}`）、`tools/AgentTool/index.js:711`（`{name}`）、`tools/EnterWorktreeTool/index.js:54-56`（`{name}`）⇒ `worktreeManager.js:206 bindWorktree()` **永不触发** ⇒ `payload_json.worktree` 恒为 `null` | `git grep -n "createWorktree(" -- 'services/**' \| grep -v /tests/` |
| **后台子代理跨会话性** | `AgentTool/index.js:750` 把任务存在 `_backgroundAgents` 这个 **Map** 里、值是 `promise` ⇒ **执行体随进程消失**，写盘也救不回；且 `getBackgroundAgent()`（`:143-146`）**未注册为独立工具**（`static toolName = 'Agent'` 唯一，`:248`）⇒ 模型被工具描述（`:477`）指引去调一个**无工具可调的入口** | `sed -n '715,760p' services/backend/src/tools/AgentTool/index.js` |

### 7.2 复杂项目七阶段动线（S0 → S6）

顺序固定；三档位的差异只体现在每阶段的**参数**上（§7.3），**动线本身不变**。

| 阶段 | 目的 | 靠哪个机制（真源） | 判据 | 失败处置 |
|---|---|---|---|---|
| **S0 立项与档位判定** | 动手前先定「这是哪一档」，它决定后面 6 步的参数 | `taskScale.js:103-147` 自动判定 + **用户一句话纠偏**（`opts.taskScale` 显式覆盖，`:89`） | 判出 `large` **或** 用户显式声明 ⇒ 走完整动线；判 `small` ⇒ 可跳过 S1 | 判小 ⇒ 一句话纠偏，**不惩罚**；判大 ⇒ 直接跳过 S1 |
| **S1 拆解与计划** | 切成**每步可独立验收**的步骤序列 | `planModeService.js:558` → `:650`（等人批）→ `:1152`；人闸 `:740` | ① 每步写明**验收判据**（不是「做什么」）；② 每步爆炸半径可预估（≤3 文件且 ≤2 顶层目录）；③ 步骤间无循环依赖 | 计划被否 ⇒ 回 `generating` 重拆；验收判据写不出来 ⇒ **该步粒度不对，继续拆** |
| **S2 隔离与授权** | 让改动炸不到别人的在途工作；明确 AI 被允许做什么 | `worktreeManager.js:161`（⚠ 任务绑定未接线）；`RUNTIME-010`；HQ 租约 `.ai/hq/PROGRESS.json:20-22` | ① 同仓有他人在途改动 ⇒ **必须** worktree 或先记基线（`git status --porcelain`）；② 授权面**逐项声明**，不得靠「没禁止就等于允许」 | 越权 ⇒ fail-closed deny（`onControlRequest` 语义），deny 计数而非盲试 |
| **S3 小步执行** | 按计划一步步做，每步留可回退的完成态 | `planModeService.js:1152`；每步边界建锚 `stepAnchorStore.js:332`（传**全计划目标集**，`:1227-1231` / `:1349`）；重试 `:1181` | ① 每步结束**锚点存在**（`listAnchors()` 可查）；② 单步改动量不触发爆炸半径闸；③ 单步失败**不得在已改坏的基础上继续** | 重试 ≤ `maxStepRetry`；仍失败 ⇒ **停下报部位**（`RUNTIME-009`：缺 `rollback.txt` 判 error） |
| **S4 验证** | 用**机器可判**的判据确认这一步真成了 | `deliveryGate.js:507` → `:551`；`acceptanceCriteria.js`；`verificationAgent.js` | ① 判据机器可判；② 判据为空 ⇒ 走最小兜底而非跳过；③ 未知 check 类型 ⇒ 判 fail（`:497`） | `fail` ⇒ 把缺口**如实追加进最终回复**，绝不假装成功收尾 |
| **S5 交付裁决** | 给出「这批活到底算不算完」的单一裁决 | `deliveryGate` verdict → harness 消费；`deliveryValidator.js` / `deliveryGateReporter.js`；本文 §0 的「裁决」环节 | 必须含三态之一（pass / partial / fail），partial 必须**逐条列出缺口** | fail ⇒ **不得进入 S6 续跑**，必须先回 S1 重拆 |
| **S6 台账与续跑** | 让「明天 / 另一台机器 / 另一个会话」能接上 | `deliveryLedger.js:165`；`largeTaskRuntimeStore.js`（跨进程 stale 重对齐 `KHY_TASK_STORE_RELOAD_ON_STALE` 默认开，`:68-75`）；重试策略 `:88-105`；HQ 租约；**后台 shell（跨会话存活）** | ① 每个交付有一条台账记录；② 未完成任务必须写明**下一步的第一个动作**；③ 多机场景必须写租约 | 租约过期 ⇒ 按协议置回 `todo` 待重新领取（`.ai/hq/PROGRESS.json:84` 有先例记录） |

> **S1 与 `[IMPL-DOC-001]` §12 的分工**：§12 讲「单次任务内如何小步多轮避免硬截断」，属**执行期**；
> S1 讲「动手前如何拆」，属**计划期**。互补，不重叠。

> ⚠ **锚点的两个语义细节**（写作业法时别搞错；完整论述见 `[IMPL-DOC-001]` §12.7）：
> ① `restoreToStep(N)` 用**全计划目标集**的累积式 manifest ⇒ 退回第 N 步**会删掉**第 N+1 步之后才首次出现的文件；
> ② `KHY_PLAN_CONTINUOUS=1` 那条路径**刻意不接锚点**（`planModeService.js:1211-1217`）——它没有逐步骤磁盘边界，锚点会退化成假信息。
> ⇒ 若要启用锚点，**不要同时开 `KHY_PLAN_CONTINUOUS`**。

### 7.3 三档位差异（当前为**建议**，非强制——见 §7.1 的「解耦」）

| 阶段 | **A 档：单体大改造** | **B 档：从 0 到 1 新建** | **C 档：无人值守批量** |
|---|---|---|---|
| **特征** | 爆炸半径大 + 在途改动多 + 守卫密 | 无存量约束 + 需完整生命周期 | 多会话/多机 + 可续跑 + 预算敏感 |
| **S0** | 人**必须**显式声明（自动判定不可信） | 可自动判定 + 人工确认 | 人**必须**声明预算与停机条件 |
| **S1** | 拆到「单步 ≤3 文件」；每步先记基线（`git status` + mtime） | 拆到「每步可独立跑起来」，含测试步骤 | 拆到「单步失败可丢弃」，含**预算**与**停机条件** |
| **S2** | **强制 worktree**（同仓必有他人在途） | 可选 | **强制租约** + 每任务独立工作区 |
| **S3** | 每步查锚点 + 逐 hunk 认领 diff（判归属） | 每步跑测试 | 每步记账（token / ¥ / 墙钟） |
| **S4** | 守卫**定向集**（全量必红）+ 判定面外独立复查 | 全量测试 + 构建 | 自动判据 + **失败即停** |
| **S5** | 必须交代「哪些是本次改动 / 哪些是存量」 | 必须交代「哪些功能未实现」 | 必须交代「烧了多少预算 / 为什么停」 |
| **S6** | 记 mtime 归属结论 | 记交付物清单 | **记租约 + 预算 + 续跑入口** |
| **该档最缺** | 回退入口（§8.1 缺口 3） | 项目级生命周期（§8.1 缺口 2） | 任务级预算闸 + 惯性单（§8.1 缺口 5、6） |

> **A 档是本仓最常发生的场景，也是唯一「缺的能力正好最要命」的档**：大改造必然要回退，而回退入口恰好零调用点。

### 7.4 防呆铁律（每条都有可机械执行的判据）

| # | 铁律 | 判据 |
|---|---|---|
| **F1** | 一次只推进一步 | 单次提交改动集 ≤3 文件且 ≤2 顶层目录（或已声明「本步就是大改」并留锚点） |
| **F2** | 每步留完成态 | 该步结束时 `listAnchors()` 含该步（现状：**只记录不阻断**） |
| **F3** | 不得在已改坏的基础上继续 | 某步失败后，下一步起点必须等于该步**之前的**状态（现状：**无机制兜底，靠纪律**） |
| **F4** | 删除先报部位 | 删 ≥1 文件必须留 `rollback.txt`（`RUNTIME-009`，**能拦**）；≥10 文件必须分片（**能拦**） |
| **F5** | 守卫绿之后换一套方法复查 | 每个阶段收尾必须有一条**判定面之外**的独立复查（如：直接调真实运行时函数量它，而不是再跑一遍守卫） |
| **F6** | 不把「声称」当「判据」 | 交付物里每条「已落地」必须指到 file:line 或可跑命令；指不到的一律标「仅主张」 |
| **F7** | 无人值守必有机械可判的停机条件 | C 档任务必须声明预算上限（token / ¥ / 墙钟）之一 + 停机触发条件（现状：**无任务级预算闸**） |

> **F5 的取证**：本仓有明确教训——把守卫自己的输出当「实测证据」会构成**循环论证**
> （守卫套错常量 → 文档引守卫 → 假的实测数字 → 据此规划本不该做的重构）。判据必须回到**运行时源码**复核。

### 7.5 强度梯度（事前 advisory → 事中 warning → 事末 error）

**过早 error 会逼 AI 撒谎**，所以强度按「有可行解」决定：

| 阶段 | 检查项 | 建议强度 | 理由 |
|---|---|---|---|
| S0 | 档位是否被显式声明 | advisory | 声明缺失不该阻断，但应可见 |
| S1 | 每步是否写了验收判据 | warning | 无判据的计划仍可执行，但必然在 S4 暴露 |
| S1 | 步骤粒度是否 ≤3 文件 | **advisory**（暂） | 粒度不可机械判定，过早 error 会逼 AI 把一步伪装成两步 |
| S2 | 同仓有在途改动时是否用了 worktree | **advisory** | worktree 任务绑定未接线 ⇒ 判 error 无可行解 |
| S3 | 每步结束锚点是否存在 | **advisory** | 锚点已落地但**回退入口不存在** ⇒ 判 error 无意义 |
| S3 | 单步改动是否触发爆炸半径 | warning（现状） | `check-agent-feedback.js:555-563` 已是 warning |
| S4 | 验收判据是否机器可判 | warning | 交付门已在 S4 判 fail，前置提醒即可 |
| S5 | 裁决是否含缺口清单 | error | 「假装成功收尾」是本仓红线（本文 §0） |
| S6 | 未完成任务是否写明下一步首动作 | warning | 影响续跑效率，不影响正确性 |

**升级条件**：对应「可行解」存在时才可升级。例如 S3 的锚点检查要转 error，**前置条件是回退入口存在**（§8.1 缺口 3）。

### 7.6 与相邻真源的边界

| 相邻件 | 它管什么 | 本节做什么 | 边界 |
|---|---|---|---|
| `[DESIGN-ARCH-130]` | 一件活**跑在哪条道**（前台阻塞 / 后台并发） | S2 引用，**不重复定义** | 130 管**落位**；本节管**何时该落位** |
| `[DESIGN-ARCH-025]` | 模型自决「执行器选择 + 约束级别」 | S1 引用；本节不介入执行器选择 | 025 管**选哪个执行器**；本节管**拆几步** |
| `[DESIGN-ARCH-160]` | 任务级惯性单 + 动量衰减 + 七类停机规则（**提案**） | 列为 C 档的**前置缺口**（§8.1 缺口 5、6） | 160 是**机制提案**；本节是**作业法**。160 落地后本节 C 档应改为「引用 160」 |
| `[DESIGN-ARCH-161]` | 每轮往返的时延与质量病灶（P0 已实施） | 不重复；S3 的「单步改动量」与它正交 | 161 管**一轮多快**；本节管**一共几轮、每轮做什么** |
| `[IMPL-DOC-001]` §12 | **执行期**如何小步多轮避免硬截断 | S1 的「拆解」与它互补 | §12 管**执行期内**；S1 管**动手前** |
| `[IMPL-DOC-001]` §12.7 | **回退锚点**的缺口 / 落地形状 / 未决问题 / 验证状态 | **本文不重复**，S3 只留指针 | §12.7 是该主题的单一真源 |
| `[DESIGN-ARCH-126]` | 跨端任务看板的**展示** | 本节不定义展示 | 126 管**看得见**；本节管**怎么做** |

### 7.7 名词消歧（三个「同名不同物」，写指令时必须点名模块）

| 词 | 陷阱 | 正确用法 |
|---|---|---|
| `checkpoint` | 本仓该词**全指「往对话注入自检/进度提示」**（`pipelineOrchestrator.createCheckpointTracker`、`toolUseLoopCore` 的 `PHASE_SELF_CHECK`/`PHASE_SUMMARY`），**不产生快照** | 要快照说「**步骤锚点**」（step anchor） |
| `getStage()` | `planModeService.getStage()` = **三阶段控制**（返 `'plan'`）；`stepAnchorStore.getStage()` = **S1/S2/S3 落地阶段** | 跨模块取阶段**必须点名模块** |
| `getBackgroundAgent` | 被工具描述宣称为「可用」，但**未注册为工具**、生产调用点 0（见 §7.1 第三处「够不到」） | 目前只能用一次性通知；**别写进作业法** |

---

## 8. 已知边界与后续演进

- REPL 非 harness 路径（纯 chat 降级、harness 抛错回退）不写台账——已由循环内门序兜底诚实标注，台账覆盖待后续版本统一。
- 模型侧 Task 工具（TaskCreate/TaskUpdate）创建的计划与循环的 `_parseExecutionPlan` 解析尚未完全打通，计划步骤完成度以循环内解析为准。
- 外层 harness `retryWithBackoff` 仍被「本轮零工具调用」门槛限制（`toolCallLog.length===0`）——跑过工具的 timeout/network 结局不整体重跑，防副作用重复；该层补偿由 Branch R/C 的循环内分支承担。
- 指挥部仓库 khy-os-hq 未部署时，任务/Bug 状态真源离线，台账是本机唯一交付事实来源（详见根目录 `AGENTS.md` 双机流水线自举）。

### 8.1 复杂项目作业法的七个能力缺口

分三档登记。**「需补强」= 机制存在但未接线；「真缺口」= 机制不存在。**

| # | 缺口 | 类型 | 证据 | 影响哪一档 | 处置方向（不代为决定） |
|---|---|---|---|---|---|
| 1 | **档位不影响闸强度** | 真缺口 | §7.1 的「档位与闸强度解耦」 | 全部 | 需裁定：让闸读 `taskScale`，还是档位只做提示（§7.3 暂按「建议」写） |
| 2 | **无「项目级」状态**（里程碑 / 依赖 / 预算聚合） | 真缺口 | 全部机制的真源都是**任务级**：`taskScale`（单条消息）、`plan.steps`（单次计划）、`deliveryLedger`（单次交付）、`largeTaskRuntimeStore`（单任务） | A、B、C | 需裁定：扩 `largeTaskRuntimeStore` 加一层 project 聚合，还是另立 |
| 3 | **回退入口不存在** | 需补强 | §7.1 第一处「够不到」；完整论述见 `[IMPL-DOC-001]` §12.7 | **A（最要命）** | ⚠ **棘轮约束**：`check-delivery-baseline.js → checkSurfaceRatchet` 只量 `routerCommands` / `aliasEntries` / `handlerFiles` / `ruleCount` 四项且**只降不升** ⇒ **不能新增 CLI 命令 / 别名 / handler / 规则**，只能给**既有命令加选项**或扩展**既有工具** |
| 4 | **后台子代理不可跨会话 + 取回入口未注册** | 需补强 | `AgentTool/index.js:750`（in-process Map）、`:477` 描述承诺 vs `:248` 唯一 `toolName` | C | 需裁定：改成分离进程范式，还是显式登记该边界并在退出前留可读终态（⚠ 只搬记录不搬执行 = 制造僵尸态） |
| 5 | **无任务级预算账本** | 真缺口 | `[DESIGN-ARCH-160]` §0 病灶 P2（`-p` 模式仅 `maxTurns ≤100`，无 token / ¥ / 墙钟闸）；160 仍是**提案** | C | 引用 160 落地；或先做最小版（单文件预算账本） |
| 6 | **无动量衰减 / 无统一停机规则** | 真缺口 | 同上 P1（Ralph Loop 仅在 `maxIterationsReached` 时续，无进展也烧满轮数） | C | 同缺口 5 |
| 7 | **worktree 与任务未绑定** | 需补强 | `worktreeManager.js:206 bindWorktree()` 的 3 个生产调用点都不传 `taskId`（§7.1 第二处） | A | 最小改动 = 让 3 个调用点把 id 传下去；但 `bindWorktree` 只接受 `payload_json.source === 'tool_task_store'` 的任务，需一并核对 |

> **缺口 3 与 7 的共同点**：都是「机制造好了、参数没传」。修复成本通常极低，但**发现成本极高**——因为没有任何守卫会变红（这正是 F5 的来源）。

## 9. 测试锚点

- `taskClosure.decideClosure.test.js` — 三态仲裁/预算/证据门（纯叶子契约）
- `toolFailureRecovery.test.js` — 多分支恢复梯子：瞬态分类/确定性码优先/负向守卫/只读白名单/预算/分支裁决
- `toolCallCorrection.test.js` — 工具名纠正阶梯：键归一/唯一编辑距离/歧义不猜/门控
- `cli/toolDisplayTier.render.test.js` — 输出区分级：tier 注册表/焦点说明行/printStepLine 强调/headless ▌ 前缀
- `cli/toolDisplayMatrix.test.js` — **显示矩阵完整性强制门**：注册表每个工具必有分类、每条家族必有说明文案
- `toolUseLoop.taskClosureGate.smoke.test.js` — 假 chat 驱动循环：redrive 注入 + close_partial 标注 + 有界终止
- `deliveryLedger.test.js` / `backgroundTaskManager.ledger.test.js` — 台账契约与终态咽喉集成
- `toolUseLoop.streamingExecGate.test.js` / `goalStopGate.test.js` — 相邻门既有契约

### 9.1 复杂项目作业法自身的验证与反例清单

每条铁律都要有「应拦 + 应放行」两个对照，否则就是**恒真断言**（只测「会拦」不测「会放行」，等于给了一个恒真断言）。

| 铁律 | 应拦场景 | 应放行场景（防止收得过头） |
|---|---|---|
| F1 | 单步改 5 文件 / 3 顶层目录 | 单步改 3 文件 / 2 顶层目录；**或**已声明「本步就是大改」并留锚点 |
| F2 | 该步结束但 `listAnchors()` 无该步 | 该步结束且 `listAnchors()` 含该步（**且**下一步 manifest 覆盖全计划目标集） |
| F4 | 删 12 文件不分片 | 删 1 文件且留 `rollback.txt` |
| F5 | 只跑守卫、无独立复查 | 跑了独立复查（如直接调运行时函数） |
| F7 | C 档任务无预算声明 | C 档任务声明了预算 + 停机条件 |

**复现方式（可直接粘贴）**

```bash
# 1) 任务规模判定的真源与阈值
grep -nE "_LARGE_INTENT|len >= 700|len >= 450|Rule 6" services/backend/src/services/taskScale.js

# 2) 计划模式状态机与逐步骤执行
grep -nE "_state = |executePlanSteps|maxStepRetry|requiresHumanGateStep|KHY_PLAN_CONTINUOUS" \
  services/backend/src/services/planModeService.js

# 3) 锚点回退是否仍零入口（期望：只有注释 + 定义 + 导出，无生产调用）
git grep -n "restoreToStep\|restoreAnchor\|getLastAnchorRun" -- 'services/**' 'scripts/**' 'apps/**' 'software/**' \
  | grep -v "/tests/" | grep -v "stepAnchorStore.js"

# 4) worktree 与 taskId 是否接线（期望：3 个调用点均不传 taskId）
git grep -n "createWorktree(" -- 'services/**' | grep -v "/tests/"

# 5) 后台子代理的存储形态（期望：_backgroundAgents 是 Map，值为 promise）
sed -n '715,760p' services/backend/src/tools/AgentTool/index.js
grep -n "static toolName" services/backend/src/tools/AgentTool/index.js

# 6) 爆炸半径闸的判据
sed -n '553,564p' scripts/ci/check-agent-feedback.js

# 7) 交付门的裁决三态与未知 check 的处置
grep -nE "evaluateDelivery|const verdict|Unknown check" services/backend/src/services/deliveryGate.js

# 8) 锚点只读投影的挂载点
git grep -n "formatAnchorSummary" -- 'services/**' 'apps/**' | grep -v "/tests/"

# 9) HQ 租约字段
grep -nE "claimed_by|lease_expires|120 分钟" .ai/hq/PROGRESS.json | head -5

# 10) 档位是否影响闸强度（期望：消费方全在 cli/ 提示词层，scripts/apps/software 下无消费方）
git grep -n "taskScale" -- 'services/backend/src/**' | grep -v "/tests/" | grep -v "taskScale.js:"
git grep -n "taskScale" -- 'scripts/**' 'apps/**' 'software/**' | grep -v "/tests/"

# 11) 两条 finding 的规则归属
node -e "const j=require('./docs/10_规范/registry/RULES-REGISTRY.json');for(const r of j.rules){const s=JSON.stringify(r);if(s.includes('check-agent-feedback'))console.log(r.id,r.priority,r.gate,r.name)}"
```

## 10. 未决问题（复杂项目作业法）

**需人裁决，本节不代为决定。**

| # | 问题 | 为什么要人裁 |
|---|---|---|
| Q1 | 档位（§7.3）要不要**变强制**？即：闸是否读 `taskScale`？ | 涉及 `RUNTIME-007` / `PROCESS-014` 的既有口径，且与「过早阻断会逼 AI 撒谎」直接冲突 |
| Q2 | 「项目级状态」（§8.1 缺口 2）该扩 `largeTaskRuntimeStore` 还是另立？ | 扩真源要动构造函数 + 迁移存量 + 碰状态机，代价高一到两个数量级；另立则面临「两套真源」风险 |
| Q3 | 回退入口（§8.1 缺口 3）挂在**哪个既有命令**上？ | 棘轮禁止新增命令/别名/handler/规则 ⇒ 只能寄生既有入口。`PlanRetryTool` 语义最近但**两点不匹配**：它 `risk: 'medium'`（拿不到人闸门）且完全不碰磁盘，而还原会**写/删用户文件**；且它要求 `state === 'executing'`，而还原最需要的时机是计划**已结束** |
| Q4 | 后台子代理（§8.1 缺口 4）改成分离进程，还是**登记边界**？ | 前者是重构，后者是承认现状。⚠ 只把记录写进 durable store 而不搬执行体 = 制造僵尸态，**比现状更糟** |
| Q5 | S1 的「步骤粒度 ≤3 文件」是否可判？ | 粒度判定需要「这一步会碰哪些文件」的预测，而 `inferStepFileTargets()`（`planModeService.js:281`）是**启发式**，误报会让作业法失去可信度 |
| Q6 | §7.1–§7.7 要不要升格为 `docs/10_规范/` 的**规范**（带规则 ID + 执行器）？ | 升格意味着从「建议」变「强制」，需 13 处硬触点接线 |

## 11. 验证状态（复杂项目作业法）

### 11.1 已实测

| # | 结论 | 取证 |
|---|---|---|
| 1 | `taskScale` 阈值（`len >= 700` / `len >= 450 && hasLineBreak` / `_LARGE_INTENT` / 多目标+编码意图） | 读 `taskScale.js:103-147` |
| 2 | 计划模式 5 态状态机 | 读 `planModeService.js:146` |
| 3 | 锚点**只写**：`restoreToStep` 生产调用点 0 处 | §9.1 命令 3 |
| 4 | worktree 的 3 个生产调用点**均不传 `taskId`** | §9.1 命令 4 |
| 5 | 后台子代理存 **in-process Map + promise** | §9.1 命令 5 |
| 6 | `getBackgroundAgent` **未注册为独立工具** | `static toolName = 'Agent'` 唯一（`AgentTool/index.js:248`） |
| 7 | 爆炸半径判据 = `changes.length >= 4 \|\| buckets.size >= 3`，severity = warning | 读 `check-agent-feedback.js:555-563` |
| 8 | 交付门未知 check 类型 → 判 fail | 读 `deliveryGate.js:497` |
| 9 | 锚点只读投影挂 TUI 默认路径 + REPL 两处 | `App.js:3679` / `replSession.js:8284` |
| 10 | HQ 租约默认 120 分钟 | 读 `.ai/hq/PROGRESS.json:22` |
| 11 | 锚点门控 `KHY_STEP_ANCHOR` 默认开、off=CANON | 读 `flagRegistry.js:3777-3780` |
| 12 | 持久任务库落点与跨进程 stale 重对齐门控 | 读 `largeTaskRuntimeStore.js:63-75` / `:128` / `:484` |
| 13 | `KHY_PLAN_CONTINUOUS` 路径刻意不接锚点 | 读 `planModeService.js:1211-1217` |
| 14 | 锚点用**全计划目标集**（累积式 manifest） | 读 `planModeService.js:1198-1205` / `:1227-1231` |
| 15 | **没有任何闸读档位**：`taskScale` 消费方全在提示词层 | §9.1 命令 10 |
| 16 | `fix-blast-radius` 归属 `RUNTIME-007`；`delete-needs-sharding` 归属 `RUNTIME-009` | 读 `RULES-REGISTRY.json` 中 `exec.script === scripts/ci/check-agent-feedback.js` 的三条目 |

### 11.2 仅主张（未实测，标出补测方式）

| # | 主张 | 补测方式 |
|---|---|---|
| 1 | 「所有机制都是任务级、无项目级」（§8.1 缺口 2） | 基于对 §7.1 全部 22 项真源的逐个判断。**未做**全仓搜索 ⇒ 补测：`git grep -niE "projectState\|milestone\|项目级" -- 'services/**'` |
| 2 | §7.3 三档位参数是**建议** | 参数由推导得出，**无实测数据支撑**（如「A 档单步 ≤3 文件」未经样本验证）⇒ 需在真实项目上跑样本后再定阈值 |
| 3 | §7.5 强度梯度建议 | 沿用本仓既有梯度原则（`RUNTIME-007` 停在 S1 的先例），**未做**强度对照实验 |

### 11.3 本轮未做什么（防止被误读为已落地）

1. **未改任何源码**——`planModeService.js` / `stepAnchorStore.js` / `AgentTool/index.js` / `worktreeManager.js` 一字未动。
2. **未登记任何规则**——`RULES-REGISTRY.json` 未改，`rules: []`。
3. **未附可跑原型**——§9.1 的反例矩阵是**表格**不是脚本。理由：判据大量依赖「档位 / 项目级 / 粒度」这类**尚无真源**的概念，此时写原型只会得到一堆**恒真断言**（判据无真源可查 ⇒ 只能测自己造的夹具）。待 Q1 / Q2 / Q5 裁定后再写。
4. **未修 §7.7 的三处「同名不同物」陷阱**（只登记，不修）。

### 11.4 合并来源

本节群（§7.1–§7.7 / §8.1 / §9.1 / §10 / §11）原为**独立方案件**
「复杂项目开发作业法 — 三档位阶段模型与机制映射」（编号 `DESIGN-ARCH-164`），
2026-09-27 并入本文以避免第二套真源（`[MGMT-STD-008]` §2.2「重叠即违规」），**原独立文档已删除、编号已释放**。
原件的建站附带改动归属分析（A / B / C 三类）不属本文范围，保留在工作日志中。
