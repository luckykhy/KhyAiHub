# [RESEARCH-019] Claude Code 源码架构深度解析 × khy-os 逐章对照学习指南

> 素材来源：《Claude Code 源码架构深度解析 V2.0 —— 从 4756 个文件里读懂 Agent 系统工程》（Xiao Tan, 2026-04-01，21 页）。
> 对照对象：本仓库 `services/backend/`（Node.js 后端）。
> 生成日期：2026-09-29。所有 khy-os 文件路径均经探索代理定位并给出行号；行号随 `#7` god-file 重构可能漂移，引用前建议 grep 复核符号。

---

## 总体结论

khy-os 不是"类似 Claude Code"，而是**把 CC 架构近乎逐条移植并做了超集扩展**——原报告十章里九章能在仓库中找到带注释自认「Mirror Claude Code」的实现，多处标识符逐字同名（`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`、`DANGEROUS_uncachedSystemPromptSection`、`streamingToolExecutor`）。

真正的差距集中在：

1. 子 Agent 生命周期（runAgent.ts 的 cleanup 链）未闭环——**全局最实的一条差距**；
2. 工具执行流水线中**校验顺序**与 CC 相反；
3. 无 speculative bash classifier（预判风险提前量）；
4. token budget 只有截停语义，缺"接近目标注入 nudge 继续"的正向语义；
5. 插件契约不如 CC 的统一打包（SKILL.md + hooks + MCP + 变量替换）；
6. 无中央不可变 AppState store；主循环巨型文件的组织形态（已由作者以 `#7` 重构在途处理）。

---

## 第 1 章 全局视角：CLI 工具 vs Agent Operating System

**CC 论点**：多入口（cli.tsx / init.ts / mcp.ts / sdk）共享一个 agent 运行时；fast-path 分发让 `--version` 零模块加载；命令系统是用户与运行时的控制面而非装饰。

| CC 概念 | khy-os 对应 | 位置 |
|---|---|---|
| cli.tsx fast-path | `--version` 在 bootstrap 之前退出，注释明示 "fast path = this file + package.json only" | `services/backend/bin/khy.js:1465`（`--help` 同 `:1438`） |
| dynamic import 按需加载 | 重模块记忆化懒加载 `() => (_x ??= require(...))` | `src/cli/router.js:119-130` |
| daemon / 后台会话管理 | `cli/handlers/daemon.js` + `services/daemonManager.js`；后台 shell 注册表 `backgroundShellRegistry` | 引用见 `src/services/tool/toolUseLoopCore.js:2520` |
| 101 个命令的控制面 | router 大 switch + `aliases.js` 中英拼音别名；命令面棘轮 245 命令 / 591 别名（`PROCESS-014`） | `src/cli/routerDispatchSlash.js` |
| bridge 远程模式 | `tools/ccAgentBridge.js`、`tools/A2ATool/` | — |

**阅读入口**：`bin/khy.js:1438-1472`，看它如何在加载运行时之前拦截 `--help` / `--version`。khy-os 额外用 V8 compile cache 补偿启动开销，属渐进优化而非重新设计。

---

## 第 2 章 引擎：主循环与 Prompt 编排（重点章）

**CC 论点**：query.ts 用 `while(true)` + state 对象取代递归（长会话防爆栈），9 个 continue 点各对应一种"为什么要再跑一轮"；StreamingToolExecutor 边收边跑；prompt 静态/动态段以 boundary 分隔吃 API 前缀缓存；行为规范写成制度而非指望模型自觉。

| CC 概念 | khy-os 对应 | 位置 |
|---|---|---|
| query.ts 状态机 | `runToolUseLoop()`，`while (!budget.depleted \|\| _gracePending)`，continue 点 30+（工具续跑、方向修正重入 `:3057`、空响应重试 `:3271`、截断续写 `:3969`、Stop hook 阻断续跑 `:6523`（`_stopHookActive` 一次性闸门 `:1920`）、grace 总结轮 `:2267`） | `src/services/tool/toolUseLoopCore.js:764, :2029` |
| StreamingToolExecutor | 同名移植：流式解析出 tool_use 即提交执行，并发安全者并行、其余排队，带 hash 结果缓存与 sibling abort；门控 `KHY_STREAM_TOOL_RAW_INPUT` | `src/services/domain/query/query/streamingToolExecutor.js:33`，接线 `toolUseLoopCore.js:2467`，解析侧 `cli/aiRequestParsers.js:118` |
| SYSTEM_PROMPT_DYNAMIC_BOUNDARY | 逐字同名 | `src/constants/systemPromptBoundary.js:36`；`getSystemPrompt()` 在 `constants/prompts.js:2781`（boundary push `:3139`） |
| section registry / DANGEROUS_uncached | 逐字同名：`systemPromptSection()`（cacheKey 命中才复用）、`DANGEROUS_uncachedSystemPromptSection()`（每轮重算）、`clearSectionCache()`（/clear /compact 全清）；另有静态段记忆化 `_memoStaticSection` | `src/constants/systemPromptSections.js:55, :68, :114`；`prompts.js:571-579` |
| 真 cache 打点 | 对 staticPrefix/tools 打 `cache_control:{type:'ephemeral'}` | `src/services/gateway/adapters/claudeAdapter.js:2649-2730` |
| getSimpleDoingTasksSection 行为规范 | 近乎 CC 原文 JS 移植：不加未要求功能(`:644`)、三行重复好过过早抽象(`:646`)、先读再改(`:652`)、失败先诊断(`:655`)、如实汇报不确定性(`:677`)；另补 `getExecutionDisciplineSection()`(`:669`) | `src/constants/prompts.js:641-667` |
| 413 / prompt-too-long 恢复 | errorClassifier 解析 "prompt is too long: N > M" 置 `shouldCompress` → ReactiveCompact，注释直书 "Mirror Claude Code's reactiveCompact" | `src/services/errorClassifier.js:46, :632`；`retryWithBackoff.js:526, :621`；`cli/aiChatCore.js:3375-3416` |
| max output tokens 续写 | `stopReason=length` 时累积续写、递减收益守卫、动态抬升 maxTokens，逻辑抽成独立模块 | `toolUseLoopCore.js:1882-1918, :3824-3990`；`domain/query/query/maxTokensRecovery.js` |

**差距**：

1. **代码组织**：CC 主循环 1729 行、continue 点收敛于单一状态转移语义；khy-os 的 `toolUseLoopCore.js` 6500+ 行、`replSession.js` 13718 行。这正是作者 `#7` god-file 重构的对象，本章可当作重构的目标形态来读。
2. **流式执行非默认路径**：依赖 `KHY_STREAM_TOOL_RAW_INPUT` 门控启用。

---

## 第 3 章 工具系统：42 个工具和一条治理流水线

**CC 论点**：Tool 基类带 11+ 契约方法；buildTool fail-closed 默认（忘声明就按最严处理）；执行是 14 步流水线，"模型说调"不等于"就调"。

| CC 概念 | khy-os 对应 | 位置 |
|---|---|---|
| Tool.ts / buildTool | `defineTool()`（返回 Object.freeze）+ `class BaseTool`（注释自对齐 CC：`prompt()` / `inputSchema` / `validateInput` / `execute`） | `src/tools/_baseTool.js:476, :903` |
| fail-closed 默认 | `BEHAVIOR_DEFAULTS`：isReadOnly=false、isConcurrencySafe=false（"assume writes"） | `_baseTool.js:128-134` |
| 42 个工具 | **231 个工具**，`loadTools()` 自动发现 | `src/tools/index.js:133` |
| 工具元信息 | `isReadOnly/isDestructive/isConcurrencySafe/interruptBehavior/sandboxEscape/risk/category/aliases/maxResultSizeChars` | `_baseTool.js` 同上 |
| Zod inputSchema | 纯 JS `validateParams()`（文件头 `:22` 明示无 Zod）；另有 CC 没有的 `_toolHealer` 自愈层 | `_baseTool.js:293` |
| 执行流水线 | 引擎注释列 13 步；实际漏斗：PreToolUse 硬底(`:1970`) → denylist(`:2067`) → 权限网关(`:2234`) → `requestPermission`(`:2495`) → normalizeParams(`:2696`) → schema 过滤(`:2703`) → validate(`:2739`) → validateInput(`:2796`) → 执行 → 结果尺寸处理(`:2965`) | `src/services/tool/toolExecutionEngine.js:12-24`；`src/services/tool/toolCalling.js` |
| 工具结果落盘摘要 | `maybePersistLargeResult`：>50K 字符落盘 + 头尾预览 + `_persistedPath`，在 defineTool 包装 execute 时无条件应用；每工具 `maxResultSizeChars`（默认 20K） | `src/tools/_toolResultNormalizer.js:258-305`；`_baseTool.js:143, :586-592` |
| 智能截断 | 按工具噪声档案双限截断（grep 文件列表=信号、build log 早期=噪音）——**khy-os 反超 CC 的单一截断** | `src/services/smartTruncation.js:3-15` |

**真差距与实现思路**：

1. **校验顺序**：khy-os 权限网关在前、schema 校验在后（CC 相反）。后果：非法参数也会先弹权限窗。修法：把 `normalizeParams`/`validate` 前移到 `toolCalling.js:2234` 之前——纯顺序调整、行为保持，属 Rule-5 修复类（需 repro-before 存证）。
2. **无 speculative classifier**：CC 在权限决策**之前**并行启动 Bash 风险预判，减少弹窗等待。khy-os 积木现成（`services/commandRiskClassifier.js`、`permissions/bashSecurityPatterns.js`、`riskGate.js`），缺的只是"提前异步启动 + 结果缓存供权限步骤消费"：在 PreToolUse 入口 fire-and-forget 一个 Promise，`requestPermission` 处竞速 await。
3. **无 PostToolUseFailure 事件**：失败走 `toolError.js` / `toolFailureRecovery.js`，hook 消费不到"失败"语义事件。修法：`hookRegistry.js` 事件表加一项，在失败分支发。
4. **无 render 系列方法**：渲染集中在 `cli/toolDisplay`，不在工具对象上——形态差异，不算缺失。

---

## 第 4 章 多 Agent 体系：分工和调度

**CC 论点**：把角色拆开（至少"做事的人"与"验收的人"分离）；Explore 极端只读 + 轻量模型；Verification 130 行对抗性 prompt；runAgent.ts 管完整生命周期与 cleanup 链；前台可转后台、完成 notification 回主线程。

| CC 概念 | khy-os 对应 | 位置 |
|---|---|---|
| 6 个内建 Agent | **25 个**：GeneralPurpose/Explore/Plan/Verification/Audit/Fix/Research/Security/Performance/Debug/Refactor/Review/Browser/ComputerUse/Statusline… | `src/agents/builtInAgents.js:69-201`；目录 `src/agents/built-in/` |
| Explore 只读 + Haiku | `disallowedTools` 剥 Edit/Write/NotebookEdit/Agent/Bash，`model:'haiku'`，`omitClaudeMd`——逐条对齐 | `src/agents/built-in/exploreAgent.js:59-78` |
| Verification 对抗 prompt | 139 行，"try to break it" + 识别自我合理化倾向 + VERDICT: PASS/FAIL/PARTIAL | `agents/built-in/verificationAgent.js:9-125` |
| 只读靠机制而非提示词 | `buildSubagentDenylist`（agentDef denylist ∪ `roleToolScope.js` 角色剥离集 ∪ 深度上限剥 Agent 工具）；CI 守卫 `scripts/ci/check-agent-authz.js`（AGENTS.md 规则 10，七红线 A2-1~A2-7，当前 S1 只记录） | `src/tools/AgentTool/index.js:305` |
| AgentTool.tsx 调度总控 | 2281 行对应物：`run_in_background`(`:474`)、`isolation:'worktree'`(`:481, :705-715` 经 `services/worktreeManager`)、后台注册表 `_backgroundAgents`(`:143`)、`<task_notification>` 注入主线程下一轮(`:150-162`，接线 `toolUseLoopCore.js:2512`)、子专属 AbortController + 空闲看门狗(`:1130-1192`) | `src/tools/AgentTool/index.js` |
| teammate / remote 分支 | `tools/teammateBus.js`；`tools/A2ATool/` + `ccAgentBridge.js` | — |
| tasks/ 5 种任务类型 | 4 种：local_bash / local_agent / remote_agent / dream；5 状态 + 终态集；持久 board（`.khy/taskboard.db`，WAL），状态机含 claim/pause/retry_wait/dead_letter（比 CC 细） | `src/tasks/index.js:27-30`；`src/coordinator/taskBoard.js:70`；`tasks/largeTaskBoard.js`、`_taskStore.js` |
| 任务工具面 | TaskCreate/TaskGet/TaskList/TaskUpdate/TaskStop/TaskOutput/TodoWrite | `src/tools/Task*Tool/` |

**真差距（本章最集中）—— runAgent.ts 生命周期清单**。CC 子 agent 运行时中 khy-os **未找到**的项：

| 缺失项 | CC 行为 | khy-os 现状与实现思路 |
|---|---|---|
| 子 agent 专属 MCP servers | frontmatter 声明 → 连接 → 结束后清理 | 连接池现成（`domain/messaging/mcp/index.js` `_connections`），在 agent 启动/结束处开专属条目即可 |
| 克隆 file state cache | 子不污染父的读追踪 | 需在 AgentTool 派发点做浅拷贝 + 结束后丢弃 |
| frontmatter hooks 注册 | agent 自带 Pre/Post hooks | `loadAgents.js:87, :145` 目前只解析 `permissionMode` 字段存而不用；`hookRegistry` 已支持会话级注册，缺"喂进去"一步 |
| 预加载 skills | agent 声明 skills 先行注入 | `skillLoader` 现成，按 agentDef 字段过滤预载 |
| 独立 transcript + cleanup 链 | recordSidechainTranscript / killShellTasksForAgent / 清 hooks / 清 todos | `sessionPersistence.js` 的 JSONL 链加 agentId 分片；cleanup 链在 AgentTool finally 里逐项调用 |
| 前台转后台 | 执行中可转后台 | 未找到；需把 `_backgroundAgents` 注册从派发期扩展到运行期 |

> 对应 CC 原则 7「产品化在于处理第二天」：khy-os 子 agent 的"第二天"（泄漏、脏状态）目前没有闭环。**这是本报告认定最有学习价值的差距块。**

---

## 第 5 章 安全层：权限、Hook 和三层防护网

**CC 论点**：PermissionMode/Rule/Result + bashClassifier + dangerousPatterns + pathValidation；Hook 三时点且 pre-hook 富协议；`resolveHookPermissionDecision()`：hook allow 不能绕过 settings deny；三层配合但互不绕过。

| CC 概念 | khy-os 对应 | 位置 |
|---|---|---|
| PermissionMode | 六档案 strict / normal / acceptEdits / auto / dontAsk / yolo（无 plan 档案——plan 是独立只读态） | `src/services/permissionStore.js:44` |
| PermissionRule deny/ask/allow | `checkPermission()` deny 优先（fail-closed `:204-228`），规则持久化 `~/.khy/permission-rules.json` | `src/services/permissions/rules.js:197`；glob 匹配 `permissions/patternMatcher.js` |
| dangerousPatterns | `bashSecurityPatterns.js:13` DANGEROUS_PATTERNS（blocked/dangerous 双级）+ `commandRiskClassifier.js` + `riskGate.js` + `shellSafetyValidator.js` | `src/services/permissions/bashSecurityPatterns.js` |
| Hook 时点 | **11 个事件**：PreToolUse / PostToolUse / PrePrompt / PostResponse / PreCompact / PostCompact / Stop / SubAgentStart / SubAgentEnd / ToolPermission / PromptSection（后两个为 khy 扩展注册点）；exit 2 阻断、stdout JSON 改上下文、输出白名单过滤 | `src/services/hookRegistry.js:13, :20-35`；`hookRunner.js:1-8, :28-46` |
| resolveHookPermissionDecision | 等价且更强：`applyToolPermissionHooks()` 强制「单调收紧」格（auto < confirm < deny）；插件 ToolPermission "只能收紧绝不放松"；PreToolUse 硬底 bypass 档案也绕不过 | `src/services/tool/hookContribSeams.js:102`；`toolCalling.js:1970`；`toolCallingPermissions.js:413, :434, :475` |
| 三层互不绕过 | 原则已对齐；红线不可绕 `toolCallingPermissions.js:413` | — |

**差距**：

1. `auto` 模式是确定性风险阈值而非分类器模型（`permissionStore.js:49` 自注 "khy has no classifier model"）——成本决策，非疏漏。
2. PreToolUse hook 协议贫：只有 block/modify/allow 三元 + 改 `params`（≈ updatedInput），无 `permissionBehavior` / `additionalContexts` 富协议（注入类被迫走 PrePrompt 时点）。
3. 路径校验分散（`utils/isPathWithin.js:23`、`workspaceTrust.js`、`additionalDirectories.js`、`readBoundaryGuard`），无 CC 的中心化 pathValidation——可收敛为单一 seam。

---

## 第 6 章 生态：Skill、Plugin、MCP

**CC 论点**：Skill 是带 frontmatter 的 workflow package（allowed-tools/model）；Plugin 能影响模型行为（commands+hooks+MCP+变量替换+市场）；MCP 同时给模型"工具"和"怎么用工具的说明"；生态的关键是模型**感知到**自己的能力。

| CC 概念 | khy-os 对应 | 位置 |
|---|---|---|
| Skill frontmatter + allowed-tools | 有，且更进一步：allowed-tools 在 handler 运行期**临时收窄工具面**（真执行，不是声明） | `src/skills/index.js:563, :683-721`；`skillLoader.js:44-58`；加载源 `./.khy/skills/` + `~/.khy/skills/`（`index.js:11-12, :125-143`）；内置 `skills/built-in/`；外部桥 `ccSkillBridge.js` / `ocSkillBridge.js`；安装规格 `skillSourceSpec.js` |
| MCP instructions 注入 prompt | 逐条对齐：连接上的 server 的 instructions 拼进 system prompt 动态段 | `src/services/domain/messaging/mcp/index.js:1691 getMCPInstructions()` → `constants/prompts.js:1406 getMcpInstructionsSection()`（拼装 `:2888`；`promptSectionTaxonomy.js:220` 标注易变段） |
| 能力清单感知 | `toolPool.js` 每轮刷新 MCP 工具进共享工具表；`services/skillSearch.js:259` 汇总能力清单 | `mcp/types.js:143`（`mcp__server__tool` 命名）、`autoConnect.js` |
| Plugin | 6 发现源（config/本地/全局 npm/`extensions/` 根/`~/.khyquant/plugins`/env），manifest=`khy.extension.json`，懒激活 + 命名空间前缀注册；可注入命令 + 工具（注册/注销带可回滚 cleanup） | `src/plugin-loader/index.js:1-35`；`plugin-loader/contextFactory.js:30, :117-133`；SDK `platform/packages/plugin-sdk/index.js:37-41` |

**差距**：khy 插件契约只有 `name/namespace/main/engines`，**没有** CC 那种统一打包声明（一个插件带 SKILL.md 目录 + hooks + MCP server 配置 + `${CLAUDE_PLUGIN_ROOT}` 变量替换 + 自动更新/blocklist）。实现思路：扩展 `khy.extension.json` schema 增加可选 `skills/`、`hooks/`、`mcpServers` 字段，加载时分别喂给现成的 `skillLoader` / `hookRegistry` / mcp 连接池——三块底座都在，缺的只是 manifest 这层胶水契约。

---

## 第 7 章 上下文经济学：Token 就是预算

**CC 论点**：四道压缩轻量优先叠加；413 后 reactive compact 兜底且防循环；token budget 双向——既防超支也"推"模型继续干到目标。

| CC 概念 | khy-os 对应 | 位置 |
|---|---|---|
| 四道压缩 | **五道**（多一道工具结果预算）：Stage1 结果落盘 → 1.5 SnipCompact → 2 Microcompact → 2.5 ContextCollapse → 3 Autocompact（AI 摘要）；纯函数折叠（snip 阈值 2000→500 字符；collapse 折叠 ≥3 轮工具链） | `src/services/domain/query/query/compactPipeline.js:7-12`；`compactionStages.js:24, :68, :130` |
| 触发阈值 | 80% 预算；`autoCompactTriggerTokens = budget × 0.75`（底栏倒计时同源）；usage ≥0.7 'soon' / ≥0.9 'now' | `compactPipeline.js:23`；`contextRouter.js:340`；`domain/memory/compact/index.js` |
| Reactive Compact 防循环 | 413 后以 0.5×预算重压、只重试一次；另有连续失败 3 次熔断 + anti-jitter | `cli/aiChatCore.js:3375-3418`；`retryWithBackoff.js:526`；`compactPipeline.js:29-31`；`contextCompressor.js:1215-1222` |
| tool_use 配对修复 | 压缩后消息配对完整性修复 | `services/contentBlockUtils.js:207-212`（接线 `aiSession.js:992`、`aiMessageBuilder.js:294`） |
| /compact 命令 | AI 摘要优先、失败回退本地启发式，三入口共用，写回 `_chatState` + 落盘 + 进度条；`/snip` 手动裁剪 | `cli/routerDispatchSlash.js:316-346` → `cli/compactOrchestrator.js:3-31`；`ink-components/CompactionProgress.js` |
| Token Budget | 解析 "+500k" 提示内指令、`assessBudget` ok/warn/stop、HUD 同源显示 | `src/services/tokenBudget.js:159, :43, :96`；`toolUseLoopCore.js:2120-2125`；`hudRenderer.js:484` |
| 结果超预算落盘 | 见第 3 章 `toolResultPersistence.js` | `domain/query/query/toolResultPersistence.js` |

**真差距**：khy 的 budget 是**截停语义**（超限即中止），CC 是**双向语义**——接近目标时注入 nudge message 让模型**继续**。修法：`toolUseLoopCore.js:2120` 的 `assessBudget` 分支中，warn 档不中止而是 push 一条 system reminder（"已用 X/Y，按目标继续"），复用现成 `shortStopContinuation.js` 注入通道。

另：**goal 级跨轮自动续跑已实现**（曾被视为缺口）——`services/goalStopGate.js` 是 CC Stop-hook 等价物：`KHY_GOAL_STOP_GATE`（父门控 `KHY_GOAL`）默认开、单用户轮 redrive ≤1（clamp [0,10]）、跨轮由 goalCore maxTurns 兜底，且带**证据门**（达成判定若建立在无实证的"验证声称"上→降级为 redrive 要求出具证据）。

---

## 第 8 章 产品化：从 prototype 到 product

| CC 概念 | khy-os 对应 | 位置 |
|---|---|---|
| transcript 记录 | 双轨持久化：append-only JSONL（uuid+parentUuid 链，注释明示借鉴 CC）+ 快照；图像块外链化；rewind checkpoint | `src/services/sessionPersistence.js:4, :429`；目录 `.khy/sessions`（`getProjectDataDir('sessions')`） |
| 会话恢复 | SQLite `sessions.db` 带自愈 | `dbHealthService.js:214-245` |
| 生命周期兜底 | `sessionWatchdog.js`：活动感知挂死看门狗，"有工作在等且无输出"才报一行，**永不自动杀进程**；子 agent cleanup 链未闭环（见第 4 章） | `src/services/sessionWatchdog.js:4-38` |
| React+Ink TUI | `cli/tui/` 双栈：CC 风 `CcApp.js`+`utils/ccLayout.js` / khy 风 `KhyOsView.js`；60+ ink-components：权限弹窗 `PermissionsPrompt.js`/`CcPermissionPrompt.js`、进度 `ProgressBar.js`、`CompactionProgress.js`、agent 面板 `AgentTree.js`+`cli/agentTreeView.js`、PlanApproval/ModelPicker/RewindPicker/HelpMenu；diff 走 ANSI `cli/ui/diffViewer.js`（非 Ink）；测试 `scripts/run-ink-tui-tests.js` + `tests/tui/` 30 余例 | `src/cli/tui/app.js` |
| AppState 集中管理 | **差距**：无中央不可变 store；现状为可变模块单例 `cli/aiChatState.js`（`_chatState`）+ `services/domain/state/{stateMachine,orchestrator,intentArbiter,envSymbiosis}` + TUI React hooks（`cli/tui/hooks/useQueryBridge.js`）。追平需引入单 store + 订阅，属架构级改动，建议待 `#7` 重构收敛后再议 | — |
| Telemetry | `telemetryService.js:1-10` 内存计数统一聚合供 HUD；`tokenUsageService.js:13-16` USD→CNY 7.25 逐 provider 计价、日/月聚合落 `~/.khyquant/token_usage.json`；OTel 可选依赖 `src/observability/otel.js` | — |
| Rate limit | 429 自动重试策略纯叶 + 接线 | `cli/rateLimitRetry.js`；`aiChatCore.js:3425` |
| Perfetto / 外部 analytics | **未找到**（仅 agenticHarnessService 内部字段） | — |

---

## 第 9 章 七条设计原则 —— khy-os 的制度化答卷

| 原则 | khy-os 落实 |
|---|---|
| 1 不信任模型自觉性 | prompts.js 行为规范 + runtime 权限检查 + AGENTS.md 工程规则 5/6/7（修复先复现/新增先提问/删除先报部位，带存证文件与守卫） |
| 2 把角色拆开 | 25 个内建 agent + verificationAgent 独立角色 + `check-agent-authz.js` 七红线 |
| 3 工具调用要有治理 | toolExecutionEngine 13 步（差距见第 3 章 ①②③） |
| 4 上下文是预算 | boundary / section registry / 五道压缩全套 |
| 5 安全层互不绕过 | 「单调收紧」格 + PreToolUse 硬底 bypass 绕不过——**比 CC 表述更强**（CC 只规定 hook 不越 deny，khy 连 bypass 档案都有硬底） |
| 6 生态的关键是模型感知 | 对齐（第 6 章） |
| 7 产品化在于处理第二天 | 会话持久化/看门狗对齐；**子 agent cleanup 链是最实的一条未闭合差距** |

---

## 第 10 章 附录核心文件索引 → khy-os 等价物速查

| CC 文件 | khy-os 等价物 |
|---|---|
| `src/entrypoints/cli.tsx` | `services/backend/bin/khy.js` |
| `src/main.tsx` | `src/cli/replSession.js`（13718 行；入口 shim `cli/repl.js:1-151`；TUI 入口 `cli/tui/app.js`） |
| `src/query.ts` | `src/services/tool/toolUseLoopCore.js`（`runToolUseLoop` :764） |
| `src/QueryEngine.ts` | `src/services/tool/toolExecutionEngine.js` + `toolCalling.js` |
| `src/Tool.ts` | `src/tools/_baseTool.js` |
| `src/constants/prompts.ts` | `src/constants/prompts.js` |
| `src/constants/systemPromptSections.ts` | `src/constants/systemPromptSections.js` |
| `src/services/tools/toolExecution.ts` | `src/services/tool/toolCalling.js` |
| `src/services/tools/toolHooks.ts` | `src/services/hookRunner.js` + `hookRegistry.js` + `services/tool/hookContribSeams.js` |
| `src/services/tools/StreamingToolExecutor.ts` | `src/services/domain/query/query/streamingToolExecutor.js` |
| `src/tools/AgentTool/AgentTool.tsx` | `src/tools/AgentTool/index.js`（2281 行） |
| `src/tools/AgentTool/runAgent.ts` | **无独立文件**，内联于 AgentTool——差距见第 4 章 |
| `src/tools/AgentTool/built-in/*` | `src/agents/built-in/`（25 个） |
| `src/utils/permissions/` | `src/services/permissions/` + `permissionStore.js` |
| `src/services/compact/` | `src/services/domain/query/query/compactPipeline.js` + `compactionStages.js` |
| `src/services/SessionMemory/` | `src/services/sessionPersistence.js` + `domain/memory/` |
| `src/query/tokenBudget.ts` | `src/services/tokenBudget.js` + `goalStopGate.js` |

---

## 建议学习顺序

1. **第 2 章（主循环）→ 第 5 章（安全层）→ 第 3 章（工具流水线）**：对照读能建立约 80% 架构认知，khy-os 对应文件都能逐段找到同源注释。
2. **第 4 章 + 第 7 章差距清单**：最适合转化为下一步改进任务。

## 差距汇总（按实施成本升序）

| # | 差距 | 成本 | 备注 |
|---|---|---|---|
| 1 | token budget 缺 nudge-继续正向语义 | 小 | warn 档注入 system reminder，复用 shortStopContinuation 通道 |
| 2 | 校验顺序：schema/validateInput 前移到权限网关之前 | 小 | Rule-5 修复类，需 repro-before 存证 |
| 3 | 缺 PostToolUseFailure hook 事件 | 小 | hookRegistry 事件表 + 失败分支发 |
| 4 | 缺 speculative bash classifier | 中 | 积木现成（commandRiskClassifier 等），补"提前异步启动+竞速消费" |
| 5 | 子 agent 生命周期未闭环（专属 MCP / file state 克隆 / frontmatter hooks / skills 预载 / transcript+cleanup 链 / 前台转后台） | 中 | CC 原则 7 核心；建议抽独立 runAgent 等价模块，顺带化解 god-file 问题 |
| 6 | 插件无统一打包契约（SKILL.md+hooks+MCP+变量替换） | 中 | 扩 `khy.extension.json` schema，喂给现成三底座 |
| 7 | 无中央 AppState store；主循环巨型文件 | 大 | 等 `#7` god-file 重构收敛后再议 |
