# [DESIGN-ARCH-184] khy-os 接入编辑器 ACP（Agent Client Protocol）实现方案

> **状态**：草案（待评审）
> **适用范围**：`runtime/node/backend/`（Node 后端；文档中 `services/backend/src/...` 为旧载体名，均指此处）
> **解决的问题**：编辑器生态（Zed / JetBrains / Neovim 等）正在用 **Agent Client Protocol**（编辑器↔智能体标准协议）打通智能体接入。khy-os 网关的多供应商容错、工具循环、权限闸门与用量审计目前**只在自家 REPL 可达**——编辑器用户触达不了；同时外部 ACP 智能体（claude-code-acp、gemini-cli 等）也不能进统一通道获得一致的计费/审计/状态透明。本方案定义 khy-os **双向接入编辑器 ACP** 的架构与落地路线。
> **强制手段**：本方案落地后由 `check-protocol-naming.js`（扩充编辑器 ACP 前缀）+ schema/transport 单测执行；文档命名与放置遵循 `[DESIGN-LAY-005]`。
> **相关文档**：`[DESIGN-NAM-002]`（三协议术语唯一真源）、`[DESIGN-ACP-001]`（私有 ACP 契约——**勿混**）、`[DESIGN-A2A-002]`（标准 A2A 适配）、`[DESIGN-ARCH-071]`（通道选择）、`[DESIGN-AGENT-002]`（工具授权矩阵）、`[DESIGN-QUAL-002]`（官方一致性套件先例）、`[DESIGN-DELIV-002]`（棘轮阈值）
> **上游规范**：agentclientprotocol.com（Zed Industries 发起，v1 稳定面，2026-10 抓取）

---

## 0. 术语红线（先读）

仓库里已有**两个**叫 ACP 的东西，本文再引入第三个——命名不先钉死，三者必然混淆：

| 规范术语 | 是什么 | 代表实现 | 版本 | 传输 | 环境 |
|----------|--------|----------|------|------|------|
| **标准 A2A** | Linux Foundation Agent2Agent 协议 | `src/services/a2a/**` | 0.3.0 | JSON-RPC over HTTP+SSE | `KHY_A2A_*`（既有） |
| **私有 ACP** | khy-os 自有进程内编排方言 | `acpTransport.js` + `a2a*` 模块群 | 1.0 | 进程内 ipc·ws·http | `KHY_ACP_*`（P2 重命名保留） |
| **编辑器 ACP**<br>（本文协议） | Zed 的 Agent Client Protocol，编辑器↔智能体标准 | 本方案新增 `agentclient/**` | **v1**（整数 1） | **NDJSON over stdio** | `KHY_ACPCLIENT_*`（新增，须登记） |

命名约束（落地时强制，参照 `NAM-002` 的既有口径）：

- 文档与代码提及本文协议，一律写「**编辑器 ACP**」或全称 "Agent Client Protocol"，**禁止裸写「ACP」**——裸写在本仓默认指私有 ACP。
- **不碰** `acpTransport.js`、`contracts/acp/`、`contracts/a2a/**`、Agent Card 一行——私有 ACP 与标准 A2A 的边界由 `check-protocol-conformance.js` 锁定，编辑器 ACP 不得渗入。
- 编辑器 ACP 的方法名是**斜杠形状**（`session/new`），与私有方言的点号形状（`task.submit`）天然不同源，不会触发 `forbiddenMethodPattern`；但**新环境变量一律用 `KHY_ACPCLIENT_` 前缀**——`KHY_ACP_` 已被私有方言的 P2 重命名计划保留，不得抢用。
- 新文件**不放** `contracts/acp/`、`services/a2a/` 附近；见 §6 目录设计。

## 1. 需求五问（`RUNTIME-008`）

| # | 问题 | 答案 | source |
|---|------|------|--------|
| 1 | 谁用？ | 两类：在 Zed/JetBrains 等编辑器里工作、想把 khy 网关能力带进编辑器的开发者；想在 khy REPL 里调用外部 ACP 智能体的用户 | `source: 用户原话「Agent Client Protocol 我希望你设计个在 khyos 中的实现方案」` |
| 2 | 什么时候用？ | 编辑器内发起对话（编辑器按需拉起 khy 子进程）；REPL 内显式选择 ACP 通道 | `source: ACP 规范「editor boots the agent sub-process on demand」`（协议事实，非用户原话） |
| 3 | 现在的替代做法？ | 手动复制粘贴 khy 输出进编辑器；或用编辑器自带 agent——khy 的多供应商容错/用量/审计不可达。REPL 调外部智能体只有「退出到外部进程」一条路，无统一计费与状态透明 | `source: 需求推导，经用户确认（2026-10-07「按照你的建议完成需求五问」）` |
| 4 | 成功长什么样？ | ① Zed 配置 khy 为 agent 后：编辑器内对话、流式回复、工具调用与审批、会话恢复可用；② REPL 内网关可路由到外部 ACP 智能体，流式回吐、审批、取消、计费与其他适配器一致。验收命令见 §9 | `source: 需求推导，经用户确认（2026-10-07「按照你的建议完成需求五问」）` |
| 5 | 不做会怎样？ | khy-os 与编辑器生态脱节；外部 ACP 智能体绕过统一网关（无审计、无 token 台账、无状态透明三态） | `source: 需求推导，经用户确认（2026-10-07「按照你的建议完成需求五问」）` |

> 问 3–5 原为需求推导，**已经用户确认收口**（2026-10-07 用户明示「按照你的建议完成需求五问」）。
> 存证：`works/data/khy/feedback/DESIGN-ARCH-184/requirement-5q.md`。

## 2. 目标 / 非目标

**目标（两个部署面 + 一个共享内核）**：

- **面 A — ACP Agent Server**：khy-os 作为**被编辑器拉起的智能体**。编辑器经 stdio 与 khy 对话，khy 用自家网关（18 适配器级联）+ `runToolUseLoop` + 权限闸门兑现 `session/prompt`。
- **面 B — ACP Agent Adapter**：khy-os 作为 **ACP Client**。网关新增一个适配器，把外部 ACP 智能体（子进程 stdio）纳入统一通道——流式、审批、取消、token 计费与其他适配器同构。
- **共享内核**：NDJSON/JSON-RPC 2.0 stdio 传输 + 编辑器 ACP v1 编解码，两面复用。

**非目标**：

- 不改私有 ACP（`acpTransport.js` 一行不动；`[DESIGN-NAM-002]` 边界）。
- 不做 ACP v2（官方仍为 draft）与 Streamable HTTP transport（draft）——只做 **v1 稳定面**。
- khyquant 不在本方案内（独立项目，人 2026-09-28 明示）。
- 不做 ACP Registry 服务端（官方 Registry 已稳定，但 khy-os 暂无发布智能体到生态的需求）。

## 3. 编辑器 ACP v1 协议面摘要（对接时以此为准）

**Agent 必须实现**：`initialize`、`session/new`、`session/prompt`、`session/cancel`（通知）、`session/update`（通知，变体见下）。
**Agent 可选**：`authenticate`/`logout`、`session/load`（需 `loadSession` 能力）、`session/resume`、`session/close`、`session/set_mode`、`session/list`、`session/delete`。
**Client 方法（Agent 可反向调用）**：`session/request_permission`（权限审批）、`fs/read_text_file`、`fs/write_text_file`、`terminal/create|output|release|wait_for_exit|kill`、`elicitation/create`。

`session/update` 变体（完整封闭集）：`user_message_chunk` / `agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `plan` / `available_commands_update` / `current_mode_update` / `config_option_update` / `session_info_update` / `usage_update`。

**StopReason**（`session/prompt` 响应，封闭枚举）：`end_turn` / `max_tokens` / `max_turn_requests` / `refusal` / `cancelled`。

**权限选项 kind**：`allow_once` / `allow_always` / `reject_once` / `reject_always`。
**ToolKind**：`read` / `edit` / `delete` / `move` / `search` / `execute` / `think` / `fetch` / `switch_mode` / `other`。

**stdio 传输三条硬红线**（规范原文 MUST）：

1. 消息 UTF-8 编码，以 `\n` 分隔，**不得内嵌换行**；
2. Agent 的 `stdout` **只能**写合法 ACP 消息（横幅、进度、诊断一律走 `stderr`）；
3. Client 的 `stdin` 只能写合法 ACP 消息。

约定：JSON 键 `camelCase`，discriminator 值 `snake_case`；文件路径必须绝对路径；行号 1-based；扩展用 `_meta` 与 `_` 前缀自定义方法。

## 4. 架构设计

```
【面 A】编辑器 → 编辑器 ACP                    【面 B】khy REPL → 外部 ACP 智能体
┌──────────┐  NDJSON/stdio  ┌───────────────┐   ┌──────────┐  adapter 接口  ┌──────────────┐
│ Zed 等   │ ◄────────────► │ agentServer.js│   │ replSession│◄────────────►│acpAgentAdapter│
│ (Client) │                │  (Agent 端)   │   │ (Client 端)│              │  (子进程 Client)│
└──────────┘                └──────┬────────┘   └──────────┘               └──────┬───────┘
                                   │ runToolUseLoop 回调                            │ session/*
                                   ▼                                               ▼
                          aiGateway + toolCallingPermissions              外部智能体 (claude-code-acp 等)
                                   │
                          sessionPersistence / tokenUsageService
```

两个面共享内核 `agentclient/`（NDJSON 帧 + v1 常量 + 会话映射），互不复用私有 ACP 的任何代码。

### 4.1 面 A：ACP Agent Server（khy 作为智能体）

入口形态仿 `mcpStdioServer` 先例（`src/services/domain/messaging/mcp/mcpStdioServer.js`）：`readline.createInterface({input})` 逐行读 stdin、`output.write(JSON.stringify(msg)+'\n')` 回包、横幅/错误全走 stderr、设 `KHY_ACPCLIENT_SERVE_STDIO='1'` 哨兵。**stdout 红线是协议要求与本仓 RUNTIME-004 纪律的交集**，先例已趟过。

**v1 方法 ↔ 既有能力映射**：

| ACP 方法 | khy-os 实现 | 复用点 |
|---|---|---|
| `initialize` | 版本协商：`protocolVersion=1`；回 `agentCapabilities{loadSession:true, promptCapabilities:{image:按适配器能力}}`；`agentInfo` 从 `package.json` 动态读（不硬编码） | 无新逻辑 |
| `session/new` | 生成 `sess_` 前缀 sessionId；由 `cwd` 经 `sessionPersistence._encodeProject` 定位项目桶；登记 ACP↔khy 会话映射 | `sessionPersistence.js` |
| `session/prompt` | 组装 `runToolUseLoop(userMessage, loopOptions)`，`chat` 注入网关链 | `toolUseLoopCore.js:764` |
| `session/cancel` | 触发 `interruptSignal`（AbortSignal），沿用 `createLinkedAbortController` 派生链 | `aiGateway.js:2108` |
| `session/load` | `restoreSession` + `buildConversationChain`，按 UUID 链回放 `user_message_chunk`/`agent_message_chunk` | `sessionPersistence.js:569/:883` |
| `session/request_permission`（反向） | 经 `onControlRequest` 通道透传，映射 khy 权限闸门决策 | 见 §5 |

**`session/update` 变体 ↔ `runToolUseLoop` 回调映射**（回调签名见 `toolUseLoopCore.js:765-795`）：

| 回调 | ACP 变体 | 说明 |
|---|---|---|
| `onChunk`（`type:'text'`） | `agent_message_chunk` | `messageId` 用 requestId 派生，同一消息保持不变 |
| `onThinking` | `agent_thought_chunk` | 思考流尾部 |
| `onToolCall` | `tool_call`（`status:'pending'`） | `title` 用 `formatToolCall`（动词+目标，`RUNTIME-002` 合规）；`kind` 按 ToolKind 映射 |
| 工具执行前后 | `tool_call_update`（`in_progress`/`completed`/`failed`） | `content` 挂工具输出文本 |
| `onPlanReady`/`onPlanProgress` | `plan` | entries{content,priority,status} 直接映射 |
| `onCost` + tokenUsage | `usage_update` | `used`/`size` 取 token 台账，`cost.currency` 用 `CNY`（khy 以人民币计价） |

**StopReason 映射**：`end_turn` ← 正常完成；`max_tokens` ← 截断；`cancelled` ← `session/cancel` 后 abort（协议 MUST：**必须捕获 abort 异常并返回 `cancelled`**，不得把取消当 error 回给编辑器）；`refusal` ← 网关内容拦截分类。

### 4.2 面 B：ACP Agent Adapter（网关第 19 个适配器）

完全沿用适配器接口（`detect()` / `generate(prompt, options)` / `getStatus()` / `destroy()`），返回形状走 `_responseBuilder.buildSuccess`（**是 `content` 不是 `{text,tokenUsage,model}`**）：

| 网关侧 | ACP 侧 |
|---|---|
| `detect()` | 配置登记的外部 ACP 智能体 bin 可达性（解析仿 `opencodeBinResolver.js`） |
| `generate(prompt, {onChunk, abortSignal, onControlRequest})` | 复用按 `adapter-key+cwd` 缓存的子进程会话：`session/new` → `session/prompt`；`agent_message_chunk` → `onChunk({type:'text',...})`；终态 `stopReason` → `buildSuccess(content=全文拼接, tokenUsage=usage_update 累计, model=agentInfo.name)` |
| `abortSignal` 中断 | 发 `session/cancel` 通知，等待 `cancelled` stopReason 后再 settle（**不硬杀子进程**，`RUNTIME-003`） |
| `onControlRequest`（agent→khy 审批） | 复用 khy 自己的审批 UI（`toolCallingPermissions.requestPermission` 的 `onControlRequest` 通道），决策映射回 `optionId` |
| `onChunk`（`type:'thinking'`） | `agent_thought_chunk` |

子进程生命周期：stdio `['pipe','pipe','pipe']`、行分隔 JSON 写入（`claudeAdapter.js:1421/:1545` 已有同构先例）；`destroy()` 优雅 close；空闲超时不 kill（RUNTIME-003 空闲语义 + 优雅关闭）。

## 5. 安全与授权（`RUNTIME-010` 映射）

- **面 A 权限链**：`session/request_permission` 必须落在 khy 既有闸门链之后（`toolCallingPermissions.js:397` 的顺序：`riskGate` → `permissionPolicy` → `permissionStore` → 交互审批）——ACP 客户端只是**交互审批的呈现面**，不是绕过闸门的通道。
- **fail-closed**：客户端不响应、返回未知 `optionId`、连接中断——一律按 `deny` 处理，不得把「没等到响应」解释为放行（A2-3/A2-7 口径）。
- **映射**：`allow_once`→`allow`、`allow_always`→`allow-always`（入 `permissionStore`）、`reject_once`/`reject_always`→`deny`；`cancelled` outcome→`deny` 且不落 store。
- **面 A fs/terminal 能力**：P0/P1 **不声明** `fs.*` 与 `terminal` 客户端能力（initialize 返回不出现），khy 工具仍在本进程执行文件/命令操作，权限边界不外扩。`terminal/*` 与 `elicitation/create` 列 P2 评估（高风险面，需单独授权矩阵增补）。
- **面 B**：外部智能体在编辑器/用户环境内自持权限，khy 不代理、不放大；**凭据不经 ACP 外传**（API key 只存 `~/.khyquant/config.json`，安全须知口径）。
- **传输面**：P0/P1 仅 stdio，无网络端口——`RUNTIME-001` 天然合规；未来接 Streamable HTTP（draft）时须另过零硬编码评审。

## 6. 目录与文件（`DESIGN-LAY-005`）

```
runtime/node/backend/src/
├── services/domain/messaging/agentclient/     ← 共享内核 + 面 A（仿 mcp/ 目录形态）
│   ├── jsonrpcStdio.js                        ← NDJSON 双向帧（分片/粘包/非法行容错）
│   ├── acpTypes.js                            ← v1 方法/变体/枚举常量（依规范自实现）
│   ├── sessionMapping.js                      ← ACP sessionId ↔ khy 会话映射
│   └── agentServer.js                         ← 面 A：方法分派 + runToolUseLoop 桥
├── services/gateway/adapters/
│   ├── acpAgentAdapter.js                     ← 面 B：适配器主体
│   └── acpAgentInvocation.js                  ← 面 B：子进程会话生命周期（仿 opencodeInvocation 拆分）
├── contracts/agentclient/
│   └── acp-v1-methods.json                    ← 方法/变体/StopReason 枚举单一真源（acpTypes.js 读它）
└── cli/handlers/
    └── acp.js                                 ← khy acp serve（仿 handlers/mcp.js _handleServe 模式）
```

- 命名为什么是 `agentclient/` 而不是 `acp/`：`contracts/acp/` 已是私有方言命名空间（`[DESIGN-NAM-002]`），编辑器 ACP **不得**进入该命名空间。
- `acpTypes.js` 依官方规范文档自实现常量，**不复制 Zed/官方 SDK 源码**（`[SOURCING-001]`）；官方 schema URL 仅作人工核对参考。
- 实现前先读 `[DESIGN-LAY-005]` 全文——本文 §6 是速查，不覆盖它。

## 7. 工程红线合规清单（实施 PR 自检）

| 规则 | 合规点 |
|---|---|
| `RUNTIME-001` | 仅 stdio 无 host/port；`agentInfo.version` 动态读，不硬编码 |
| `RUNTIME-002` | `tool_call.title` 走 `formatToolCall`（动词+目标）；`usage_update` 带 token 数字；错误经网关错误分类器映射 rule 2.2 模板 |
| `RUNTIME-003` | 无硬 kill：取消走 abort 链与优雅 close；网关侧既有 idle watchdog 继续生效 |
| `RUNTIME-004` | serve 进程 stdout 只写 ACP 消息（协议 MUST ∩ 本仓纪律）；横幅/日志走 stderr（mcpStdioServer 先例） |
| `RUNTIME-007` | 本改动集为新增非修复，无复现要求 |
| `RUNTIME-008` | 需求五问见 §1，评审待用户确认问 3–5 |
| `PROCESS-008` | 无新增拦截型机制，不需要 FEATURE-OWNERSHIP 登记 |
| `NAM-002` | 三协议区分（§0）；不碰私有 ACP；新 env 用 `KHY_ACPCLIENT_*` |

## 8. 测试与一致性

- **单测**（`tests/`）：`jsonrpcStdio` 帧解析（跨 chunk 分片/粘包/非法行/超长行）；`agentServer` 方法面（initialize 协商、unknown method → `-32601`）；adapter 生命周期（fake 子进程，仿 `tests/acpTransport.test.js` 的 fake channel 手法）。
- **一致性**：官方 Test Compatibility Kit 接入方式仿 `[DESIGN-QUAL-002]`（A2A TCK 先例），CI 接线列 P2，本地先手工跑。
- **手工验收（黄金路径）**：Zed `settings.json` 配置片段由 `khy acp` 输出（**建议式，不静默改写**——`terminalSetupPlan` 先例口径）：
  ```json
  { "agent": { "custom_servers": { "khy-os": { "command": "khy", "args": ["acp", "serve"] } } } }
  ```
  验收命令：① Zed 内对 khy-os agent 发起对话，确认流式/工具审批/取消/会话恢复；② `npm run check:delivery` 棘轮不红；③ `node --test tests/agentclient/`。

## 9. 分期落地路线

| 期 | 交付 | 验收 | 状态 |
|---|---|---|---|
| **P0** | 共享内核（jsonrpcStdio + acpTypes + schema 枚举）；`KHY_ACPCLIENT_*` 前缀登记进 `protocol-naming.json`；`NAM-002` 术语表增第三行（改真源须同步 `npm run docs:rules-cards`，`check:rules` 双向可达）；**面 B adapter**（new/prompt/update/permission/cancel） | REPL 经网关调外部 ACP 智能体：流式、审批、取消、计费与其他适配器一致 | **已落地（2026-10-07）** |
| **P1** | **面 A agentServer**：initialize / session/new / session/prompt / session/update / session/cancel / session/request_permission；`khy acp serve` 入口 | Zed 黄金路径（§8 手工验收①） | **代码已落地（2026-10-07）**：`khy acp serve` 握手冒烟通过（initialize + session/new）；Zed 实机对话待人工验收 |
| **P2** | `session/load` 回放与 `session/resume`；`usage_update`；`session/set_mode`（映射 permissionMode/plan 模式）；TCK CI；`terminal/*` 与 `elicitation` 风险评估（单独授权矩阵增补，默认不做） | TCK 通过；会话跨进程恢复 | 待排期 |

实施落点（与 §6 目录一致）：`src/contracts/agentclient/acp-v1-methods.json`、
`src/services/domain/messaging/agentclient/{jsonrpcStdio,acpTypes,sessionMapping,agentServer}.js`、
`src/services/gateway/adapters/{acpAgentAdapter,acpAgentInvocation}.js`、
`src/cli/handlers/acp.js`（manifest 自注册，未改 router 大 switch）、
`bin/khy.js` 的 `acp serve` 驻留分支（仿 mcp serve 先例）、
`tests/agentclient/`（node --test 24 项全绿；网关 jest 稳定性 92 项无回归）。

版本口径：每期**不 bump**，直至对外行为变更收口（`[DESIGN-SEMVER-002]`/`PROCESS-005`）。

## 10. 棘轮与登记影响（实施 PR 前必查）

- **命令面棘轮**：`khy acp serve` 意味着 router 新 case + 新 handler——实施时先跑 `npm run check:delivery` 看余量；无余量则按「新增一条先退役一条」（`[DESIGN-DELIV-002]` 三棘轮口径）。备选：并入 `gateway` 家族作子命令分支以少占面，二选一在实施 PR 定。
  实测（2026-10-07 实施 PR）：`routerCommands=246/245`（本次 +1）· `handlerFiles=158/155`（本次 +1）· `ruleCount=96/94`（存量 +2，与本方案无关）——棘轮已突破，warning 档。**退役哪条命令是人的决定（`RUNTIME-009` 删除先报部位），不代决**；维持 manifest 自注册形态，待裁决后要么补退役、要么并回 `gateway` 家族。
- **协议命名登记**：`protocol-naming.json` 新增第三类前缀（`agentClientEnvPrefix: "KHY_ACPCLIENT_"`）——这是 P0 阻塞项，先登记再写代码。
- **规则卡**：`NAM-002` 术语表改动须与 `docs/10_规范/规则卡/[NAM-002]` 同步再生成（`npm run docs:rules-cards`），否则 `check:rules` 翻红。
- **无需登记**：FEATURE-OWNERSHIP（无拦截门）；BUILD-OUTPUTS（无构建产物新增）。

## 11. 风险与开放问题

1. **命名空间三义**：`KHY_ACPCLIENT_` 前缀与 `KHY_ACP_` 仅差三字符，检索时易混——登记进守卫后由 `check-protocol-naming.js` 兜底，评审时留意。
2. **Windows 子进程**：bin 路径解析沿用 `opencodeBinResolver`/`daemonSpawnLocation`（`windowsHide:true`）经验；stdio 编码注意 cmd 下 UTF-8 代码页。
3. **会话 id 命名空间**：ACP `sess_*` 与 khy 既有 sessionId 的映射放 `sessionMapping.js` 单一真源，不散落。
4. **进程终止不丢会话**：编辑器关 stdin 即终止子进程（协议行为）——khy 会话主副本本就落盘 JSONL（`sessionPersistence`），P2 的 `session/load` 兜住恢复。
5. **上游演进快**：v2 已 draft（prompt lifecycle 重构、枚举扩展 RFD）——本方案只钉 v1 稳定面，v2 跟踪 RFD 另立文档。
6. **usage_update 语义差**：ACP cost 为 ISO 4217 任意币种，khy 台账以人民币计——统一 `CNY`，勿按官方示例抄 `USD`。
