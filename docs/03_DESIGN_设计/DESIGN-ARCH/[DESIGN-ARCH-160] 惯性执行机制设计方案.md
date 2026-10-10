# [DESIGN-ARCH-160] 惯性执行机制设计方案

<!-- RULES-REGISTRY: RUNTIME-002, RUNTIME-003, RUNTIME-010, PROCESS-008 -->

> **状态**：S1 已实施（2026-09-27，影子模式；实施记录见 §10）
> **范围**：`services/backend` 执行编排层。新增外置控制器 `inertialRunService`；**不改** `toolUseLoopCore.js` 内核、不改 `agenticHarnessService.js` 骨架。
> **上游依赖**：无外部依赖。
> **调研指针**：[DESIGN-ARCH-135]（续跑策略单源）、[DESIGN-ARCH-136]/[DESIGN-ARCH-139]（信封与披露纪律）、[DESIGN-ARCH-130]（前后台任务编排）、[DESIGN-GOV-001]（治理总纲）。
> **模板合规**：借鉴提案 B-P2 逐字段据实声明「不适用」（§2，先例 [DESIGN-ARCH-149] §2）。

## 0. 一句话结论

本仓已有四块「半惯性」机制——Ralph Loop 自动续跑、Goal 有界持久目标、`khy -p` 无头单发、Boulder 检查点——但各自只管一段：**缺一张随任务走、可审计、可续跑的「惯性单」，缺动量衰减与歧义协议，缺无人值守下的越权与不可逆操作防线**。本提案把既有能力收拢为统一的任务级协议 **Inertial Run**：AI 在起点蹬一脚（结构化惯性单），外置控制器驱动既有循环自主推进，达成/预算/衰减/异常/歧义/越权/外部七类**机械可判**的停机规则兜底，停机后以标准信封 + 上下文摘要交还控制权，全程不碰执行内核。

| # | 病灶 | 现状证据 | 后果 |
|---|------|---------|------|
| P1 | 续跑只认「轮数打满」，无衰减 | Ralph Loop 仅在 `maxIterationsReached` 时续（agenticHarnessService.js:551-555）；Goal 满轮自动 exhausted（GoalTool.js:48-54） | 无进展也烧满轮数与 token |
| P2 | 无任务级预算账本 | `-p` 模式仅 maxTurns ≤100（printOutputFormat.js:121,131），无 token/¥/墙钟闸 | 无人值守失控无闸 |
| P3 | 歧义/越权无任务级协议 | 控制请求 fail-closed deny 后，循环如何收敛无任务级策略（toolUseLoopCore.js:6618 起多处消费 onControlRequest） | 要么卡死要么盲试 |
| P4 | 断点恢复绑定「消息相似度」 | Boulder 恢复条件 `isSimilarMessage`（agenticHarnessService.js:205）+ 24h TTL（boulderState.js:19-24） | 换个说法就捡不回来，跨机不可续 |
| P5 | 结束交还无统一信封 | `-p` 有 subtype/exit code（printOutputFormat.js:287-351），交互会话无 partial/resume 结构 | 控制权交还靠模型自由发挥 |
| P6 | 无人值守无租约隔离 | HQ 租约只管 `.ai/hq` 条目（PROGRESS.json:22）；裸惯性跑无 lease | 双机/双会话互踩同一工作区 |

## 1. 现状实证（file:line 可复核）

### 1.1 已有的四块「半惯性」能力与各自缺口

| 机制 | 位置 | 已有 | 缺口 |
|---|---|---|---|
| Ralph Loop 自动续跑 | agenticHarnessService.js:530-642 | 达上限自动续，自适应轮数 `min(ceil(3×复杂度), 8)`（:539-546）、cooldown 1500ms（DEFAULTS :45）、`inheritedDedupKeys` 防重复副作用（:589-592） | 仅由「轮数打满」触发；无衰减、无预算 |
| Boulder 检查点 | boulderState.js:4-32；写入 agenticHarnessService.js:597-620 | SQLite WAL 每轮 upsert、24h TTL、512KB 上限、文件系统漂移检测（agenticHarnessService.js:212-243）、`task_id` 列与索引（boulderState.js:62-69）、`listResumable` 查询（:82-84） | 恢复判定靠 `isSimilarMessage`（:205）；单机 dataHome；无任务级编排元数据（预算/授权） |
| 续跑策略单源 | agenticHarnessService.js:2586-2599 | `continuation.{shouldAutoContinue, assessTaskComplexity, buildContinuationSummary, buildContinuationInput}` 四函数导出（[DESIGN-ARCH-135] 三期落地） | 策略只回答「该不该续」，不回答「何时该彻底停 / 歧义怎么办」 |
| 无头单发 `khy -p` | printOutputFormat.js:65-131, 287-362 | maxTurns（≤100，:121/:131）、allowedTools/disallowedTools、outputSchema、exit 0/2/3 三态（:340-351）、`KHY_HEADLESS_EXIT_ON_LIMIT` | 一次性进程：无检查点、无中途 stop/status、无租约；subtype 无 partial 档 |
| Goal 有界持久目标 | GoalTool.js:48-54, 83-84 | maxTurns 默认 25、Stop-gate 阻止提前收工、达上限自动 exhausted | 每轮仍需主会话模型在场；无独立预算/审计/恢复 |

### 1.2 可直接继承的三个「体例先例」

- **显式裁决规则 + 具名 reason**：inertialContinuation.js:230-289 的 R1–R4 `classify()`——四条规则全部成立才接续，任一不成立返回具名 reason（`user_abort / cooldown / non_resumable_error / degenerate_prefix`）。本提案的七类停机规则照此体例。
- **主动收敛别放任到超时**：searchConvergence.js:1-31——真实病案「弱模型换词搜索 15+ 次从不收口，所有防线漏接，只剩 timeout 能终止」，解法是连续 3 轮纯搜索即强制收敛（:31）。本提案把「主动收敛」从搜索域推广为任务级动量衰减。
- **单一账本常量**：DEFAULTS 冻结（agenticHarnessService.js:35-47：maxContinuationRounds 3 / cooldown 1500ms / maxRemediationRounds 2）。本提案的动量常数与预算默认值照此冻结在一处。

### 1.3 复用不改的关键基础设施

- **执行内核**：`runToolUseLoop`——惯性服务只做调用方，传 `chat / chatOpts.cwd / onToolCall / onToolResult / onCost / abortSignal`（toolUseLoopCore.js:740 onCost 回调；:1968 abortSignal 语义；:7395/:8306 内部 abort 信号先例）。
- **授权闸**：`onControlRequest` 未传桩或不可批 → fail-closed deny（toolUseLoopCore.js:6803/:7726 判 `hr.approvable && typeof onControlRequest === 'function'`）——惯性模式直接复用此语义，deny 即计数。
- **失败信封判据**：attempts 元素 `success === false` 判据同源（gateway/cliFailureEnvelope.js:66/:128）；信封形状 `{ ok, code, severity, title, cause, routing, hint[], attempts[], resumable?, traceId? }`（:16）。惯性信封新增而不改动该文件。
- **压缩阈值**：双层同值 0.70（contextRouter.js:59、PREEMPTIVE_RATIO :112）——惯性单不进 messages，天然不受压缩影响（§3.9 的关键论据）。
- **HQ 租约**：`claimed_by / claimed_at / lease_expires`（默认 120 分钟，.ai/hq/PROGRESS.json:22；CONTEXT.md:136）——惯性租约同构。

## 2. 借鉴提案（B-P2）

**不适用——零外部借鉴。** 逐字段据实声明（B-P2 只规定「缺一不落地」；「据实声明不适用」≠「缺」）：

| # | 字段 | 声明 |
|---|---|---|
| 1 | 借鉴对象 | 不适用：本方案不引入任何外部项目的代码/结构/测试，全部结论来自 §1 本仓现状实测 |
| 2 | 借鉴内容 | 不适用（无借鉴对象即无借鉴内容）。名词「惯性」沿用本仓 inertialContinuation.js 已确立的隐喻，但作用域不同（§3.1 消歧） |
| 3 | 解决的问题 | 见 §0 病灶表 P1–P6，全部指向本仓现有文件与行为 |
| 4 | 许可证与代码性质 | 不适用：无上游，无许可证引入 |
| 5 | 借鉴方式 | 不适用；如后续实施中参考任何外部实现，须按 [DESIGN-SOURCING-001] 补登记 |
| 6 | 落点与现有实现对比 | 新增 `services/backend/src/services/inertia/`（momentum.js / planSchema.js / inertialRunService.js）；扩展既有 boulderState 存储而非另写第二份 SQLite 样板 |
| 7 | 验收方式 | 见 §7 |

## 3. 目标形态

### 3.1 术语、心智模型与命名消歧

- **蹬一脚（kick）**：起点一次性下达惯性单，之后发起方（AI 会话或人）不再逐步参与。
- **惯性单（plan）**：自包含的授权 + 预算 + 停止策略工件，sha256 指纹后不可变。
- **动量（momentum）**：0–1 标量。进度事件恢复动量，空转/重复/碰壁衰减动量；跌破阈值即「惯性耗尽」自然停车。
- **停机（stop）**：七类具名原因（§3.4），全部机械可判，不允许自由文本。
- **交还（handback）**：标准信封 + 上下文摘要，控制权回到发起方，支持换会话/换机器接管。

**命名消歧**：现有 `inertialContinuation.js` 是**连接级**惯性（断流续写前缀）；本提案是**任务级**惯性（惯性单驱动的多轮自主推进）。两者并存、作用域正交，新服务命名 `inertialRunService` 以示区分，不覆盖既有语义。

### 3.2 惯性单 schema v0（`.khy/inertia/<runId>/plan.json`）

```json
{
  "schemaVer": 1,
  "runId": "ir-20260926-<rand>",
  "kickedBy": { "surface": "cli", "sessionId": "", "machineId": "" },
  "goal": "把 services/backend/tests/gateway 下失败用例归零",
  "completion": { "kind": "command_green", "command": "node --test tests/gateway/", "expectExit": 0 },
  "authorization": {
    "tools": ["Read", "Grep", "Glob", "Bash"],
    "bashPolicy": { "allow": ["node --test *", "git diff*", "git status*"], "deny": ["git push*", "rm -rf*"] },
    "paths": ["services/backend/**"],
    "onControlRequest": "deny"
  },
  "budget": { "maxTurns": 40, "maxCostCny": 5, "maxWallMs": 600000, "maxIdleMs": 90000, "maxDenies": 3 },
  "decay": { "noProgressPenalty": 0.15, "repeatPenalty": 0.25, "denyPenalty": 0.3, "errorPenalty": 0.4, "progressRestore": 0.2, "stopBelow": 0.2 },
  "ambiguity": { "policy": "stop" },
  "model": { "preferredAdapter": "auto" },
  "leaseMs": 900000
}
```

规则：**schema 校验失败 → 拒绝启动（fail-closed）**；未声明字段取默认；默认值冻结在 `inertia/defaults.js` 一处（照 DEFAULTS 先例）；**惯性单只能把预算默认上界收紧，不能放宽**（校验器强制，见 §3.8.4）。planHash = sha256(plan.json)，入账本首行。

### 3.3 触发方式（三条路径，S1 只做路径 C）

| 路径 | 触发点 | 说明 |
|---|---|---|
| A. 会话内交还式 | TUI/桌面中模型发出结构化意图或用户 `/inertia <goal>` | 当前轮收尾后把惯性单交给 inertialRunService，**会话释放**。S1/S2 不做「loop 套 loop」的嵌套执行（诚实边界 §5.1） |
| B. HQ 任务驱动 | `.ai/hq` 任务挂惯性单附件，`khy hq next --inertia` | 领取即跑，天然复用 HQ 租约（S2） |
| C. CLI 直发 | `khy inertia run --plan <file>` | 人或脚本蹬一脚，S1 载体 |

**启动前四查**（任一失败拒绝启动并给出具名 reason）：① schema 合法；② 授权白名单非空；③ 同 cwd 无活跃 run（复用 boulderState SQLite `hasPending` 同型查询）；④ 租约可获取。

### 3.4 停止规则（七类，全部具名，照 inertialContinuation RULES 体例冻结）

| 类 | 触发条件 | 判定者 |
|---|---|---|
| `completed` 达成停 | completion 判据命中（如 `expectExit` 达成、交付门通过——可挂接 KHY_DELIVERY_GATE 语义，agenticHarnessService.js:644-655） | 控制器（机械） |
| `budget` 预算停 | turns / costCny / wallMs 任一达上限；idle 超时（reason 细分 `idle` / `wall` / `turns` / `cost`） | 控制器 |
| `decay` 衰减停 | momentum < stopBelow（§3.5） | 纯函数 |
| `error` 异常停 | 窗口内连续错误 ≥3，或命中不可恢复错误类——红线集合**继承** `continuation.isResumableError`（inertialContinuation.js:261-277 的 R3 同源：内容安全/拒答/权限/上下文溢出绝不续），不在此重复定义 | 控制器 |
| `ambiguity` 歧义停 | 下一动作越出授权面（工具不在白名单 / 路径越界）且 policy=stop；或模型显式发出需决策信号 | 控制器 |
| `privilege` 越权停 | deny 计数 ≥ maxDenies | 控制器 |
| `external` 外部停 | kill switch / abortSignal / 租约到期 / 进程被杀（下次启动经 `listResumable` 发现） | 控制器/OS |

**超时语义（对齐 RUNTIME-003 活动式超时）**：`maxIdleMs` 是活动计时器，任何账本事件都重置它；`maxWallMs` 只是兜底上界并在信封 disclosures 中披露。不存在「固定超时无重置」的违规形态。

### 3.5 动量模型（纯叶子函数，node:test 可测）

`inertia/momentum.js`：`nextMomentum(prev, events) -> { momentum, stopDecision }`。零 IO、绝不抛、不改入参（TUI 叶子纪律同源；本模块虽在 services 层，纪律照守）。

- 起点 1.0；每轮按事件调整：
  - 进度事件（文件清单变化 / completion 探针结果变化 / 新增产出超过阈值）→ `+progressRestore`，封顶 1.0
  - 空转（fs 清单无变化且无新产出）→ `−noProgressPenalty`
  - 重复签名（tool+argsDigest 与上上轮相同，与 `inheritedDedupKeys` 防重同思路但作用在动量上）→ `−repeatPenalty`
  - deny → `−denyPenalty`；error → `−errorPenalty`
  - `momentum < stopBelow` → `stopDecision: 'decay'`
- completion 探针（`kind: command_green`）命中 → 直接 `stopDecision: 'completed'`，动量数值只做记录。
- 所有常数冻结在 `inertia/defaults.js`，惯性单可收紧 decay 惩罚、不可放宽 stopBelow 以下的停车阈值语义。

这就是「自然衰减」的落地：**不是拍脑袋的固定步数，而是对「换词绕圈子」（searchConvergence 病案）的通用化——绕圈即掉动量，掉光即停车**，远早于烧满 maxTurns。

### 3.6 状态记录（ledger + checkpoint）

```
.khy/inertia/<runId>/
  plan.json          # 含 planHash；启动后不可变
  ledger.jsonl       # append-only：{seq, ts, kind, tool, argsDigest, resultDigest, momentum, costDelta}
  result.json        # 停机时写入 §3.7 信封
```

检查点**扩展** boulderState 存储（SQLite `checkpoints` 表，`task_id = runId`——boulderState.js:62-69 的 task_id 列与 idx_cp_task 索引已就绪，零迁移），每轮 upsert。`.khy/` 为本机态（已 gitignore），符合 [DESIGN-LAY-004] 数据分层；多机协调仍走 `.ai/hq`，不打破本机态/多机态边界。**不新建并行存储真源。**

### 3.7 结果信封与上下文恢复（控制权交还）

```json
{
  "ok": true,
  "status": "completed",
  "statusReason": "",
  "runId": "ir-20260926-x1", "planHash": "…", "kickedBy": { "surface": "cli" },
  "outcome": { "command": "node --test tests/gateway/", "exit": 0, "tests": 18, "fail": 0 },
  "stats": { "turns": 12, "toolCalls": 31, "costCny": 1.8, "wallMs": 214000 },
  "disclosures": [ "seq=7 deny: git push 未在白名单（−0.3）", "seq=9 重复签名 Grep（−0.25）" ],
  "resume": {
    "canResume": false, "checkpointTaskId": "ir-20260926-x1",
    "remainingBudget": { "turns": 28 },
    "openQuestions": [ { "question": "…", "options": ["…", "…"], "contextDigest": "…" } ],
    "contextDigest": "目标：…｜已完成：…（file:line）｜未完成：…｜下一步选项：…"
  }
}
```

- **判据兼容**：顶层 `ok` 显式布尔（对齐 gateway 信封 :16 形状），逐 attempt 记录沿用 `success` 布尔（cliFailureEnvelope.js:66/:128 判据不破）；**disclosures 必留**——[DESIGN-ARCH-139] 的教训是「披露必留、诊断择优」，惯性信封的披露行只增不删。
- **status 七选一具名**，禁止自由文本（RUNTIME-002 状态透明：含糊 token 无处容身）。
- **contextDigest ≤2000 字，固定四段式**（目标/已完成/未完成/下一步选项），由账本**机械汇总**生成，不靠模型自由发挥。新会话、新模型、新机器拿 digest 开局即可接管——**这就是「降低实时心智依赖」的落点**：策略在惯性单里（不受 messages 压缩影响，contextRouter 管不到它），状态在账本里，发起会话的「记忆」不再是恢复的必要条件。
- 回传通道：CLI=stdout + result.json；TUI/桌面=系统消息卡片（S2 接线）；HQ=任务状态回写。

### 3.8 安全边界（避免越权与不可逆操作）

1. **授权面即白名单**：工具不在 `authorization.tools` → deny → 计数 → 超限 stop(privilege)。未声明≠全权（RUNTIME-010 同义）；deny 语义直接复用 onControlRequest 的 fail-closed 判（toolUseLoopCore.js:6803/:7726）。
2. **不可逆硬拒清单**（无论惯性单怎么写都 deny，常量化）：`git push --force`、工作区外删除、部署/发布/registry publish 类命令、凭据文件读取。bashPolicy deny 模式先于 allow 匹配。
3. **没有「全自动放行写操作」档**：v0 的 onControlRequest 策略只允许 `deny / deny_abort / pre_authorized(仅只读类)`。写操作欲无人值守放行属于将来的独立提案（须审计答辩），本提案刻意不纳入。
4. **预算只能收紧**：schema 校验器强制——budget 各上界只允许 ≤ defaults，不允许 >。
5. **租约与单实例**：同 cwd 单活跃 run；`leaseMs` 过期才可被他机/他会话接管；`khy inertia stop <runId>` 优雅停（当前工具结束后落信封）；abortSignal 贯穿到内核（toolUseLoopCore.js:1968 既有语义）。
6. **启动即审计**：ledger 首行 = planHash + kickedBy + 时间戳；此后 append-only，事后可回放「它到底被授权了什么、实际干了什么」。

### 3.9 为什么可控、可观测（对「降低实时心智依赖」的正面回答）

| 依赖维度 | 传统 agentic 长跑 | 惯性执行 |
|---|---|---|
| 计划存放 | 模型上下文（会被压缩、漂移；contextRouter 0.70 触发压缩） | 惯性单工件，sha256 不可变，永不进 messages |
| 推进决策 | 每轮由主会话模型 + 人重复决策 | 七类机械停机规则 + 动量纯函数，零主观判断 |
| 状态记忆 | 会话心智（断会话即丢） | ledger.jsonl + 检查点，append-only 可回放 |
| 恢复条件 | 消息相似度（P4：换说法即失效） | runId + planHash 主键，digest 四段式开局 |
| 模型在场 | 全程绑定同一会话模型 | 每轮内层模型可换（`model.preferredAdapter`），发起会话可释放 |
| 中途观测 | 看流式输出猜进度 | `khy inertia status`：seq/momentum/预算余量/最近披露，全部机读 |
| 出口 | 「跑完了」或「超时了」两种 | 七类具名 status + 账本 seq 证据，永远答得出「为什么停」 |

**与两层 AI 入口的关系**（[DESIGN-ARCH-132]/实施记忆）：惯性阶段内部仍走 `runToolUseLoop`（外层循环）+ `chat`（内层 LLM）的正确接线形态——`cwd` 放 `chatOpts.cwd`；惯性服务只新增为**另一个调用方**，与 queryEngine / replSession / AgentTool 并列，不动内核。

## 4. 实施分期（PROCESS-008 合规：阶段可校验，S1 只记录不阻断）

**S1（只记录，不阻断）**：
- 新增 `services/backend/src/services/inertia/{defaults,planSchema,momentum,inertialRunService}.js`；触发路径 C。
- 测试落 `services/backend/tests/inertia/*.test.js`，**一律 `require('node:test')`**（CI `node --test tests/**/*.test.js` 全量扫描 services/backend/tests/**，jest 风格裸 `describe` 落地即红；勿往既有 jest 文件追加，另建文件）。
- 影子模式：真跑一个 run，同时记录「若启用 S2 策略会在哪停」对照日志，产出样本表。
- 回滚：不调用即不存在（对 toolUseLoopCore / agenticHarnessService 零改动）。

**S2（样本，需评审）**：触发路径 A/B 接线（TUI/桌面信封卡片、HQ 挂单）；预算默认值按 S1 影子样本校准；completion 探针挂接交付门语义；`khy inertia status/stop/resume` 全量可用。

**S3（默认化，需提案增补）**：规则登记（若设新守卫 `check-inertia-plan.js`，gate/exec/paths 走 RULES-REGISTRY.json 登记表派生，[DESIGN-ARCH-111] 绑定层）；届时若确需 env 门，先过门预算棘轮（check-tui-gates.js:32 `MAX_GATES=220` 只降不升）并满足「真实用户可见权衡」判据——本提案默认**不新增 env 门**，全部开关走惯性单字段。

每期回滚 = 撤调用方一处可选参数（缺省 = 旧行为，逐字节等价）。

## 5. 诚实边界（刻意不纳入，逐条给原因）

1. **不做嵌套惯性**（loop 内再 kick loop）：AgentTool 有嵌套先例（AgentTool/index.js:1258），但授权面交错（内层 deny 谁兜底、预算谁记账）未论证清楚前不碰。
2. **不做写操作无人值守自动放行**：§3.8.3，治理决策非技术限制。
3. **不做跨机检查点同步**：boulder 在本机 dataHome；跨机只共享 `.ai/hq` 条目状态。惯性跑是本机态，强行同步会打破 [DESIGN-LAY-004] 分层。
4. **不改 toolUseLoopCore**：10k 行内核的 maxIterationsReached / onControlRequest / dedup 语义照旧消费；改内核 = 回滚能力归零。
5. **不预设「更省 token」结论**：动量衰减理论上省，但 S2 样本说话，本提案只承诺「停机原因可控可解释」。
6. **不承诺替代 Ralph Loop / GoalTool**：会话内软目标（GoalTool）与任务级硬协议（惯性单）并存，S2 后再评估桥接（Goal 达成即生成惯性单）。

## 6. 反模式（这条路别走）

| ✗ 别做 | 为什么 |
|---|---|
| 在系统提示词里写「请自主持续推进直到完成」就当惯性执行 | 那是软目标（GoalTool 已在做）：无机械停机、无审计、无预算——正是 P1 病灶的另一种写法 |
| 惯性单允许放宽预算默认上界 | 无人值守下授权面必须只能收紧；可放宽 = 白名单形同虚设 |
| 歧义时让模型「选最可能的」继续 | 自动猜 = 把治理决策下放给采样温度；歧义停的唯一出口是把具名选项交还发起方 |
| 用 env 开关做惯性总闸 | 撞 MAX_GATES=220 棘轮（只降不升）；且这不是用户可见权衡而是部署策略——走惯性单字段 |
| 复用 isSimilarMessage 做惯性恢复判定 | 消息相似度 = 换说法即失效（P4 病灶本身）；恢复主键必须是 runId+planHash，相似度只作 fallback 提示 |
| 续跑丢弃 inheritedDedupKeys | 已执行调用重跑 = 重复副作用（Ralph Loop :589-592 已踩平，别回头） |
| 停机原因写成自由文本 | status 查询、守卫、信封判据全都吃不到机读原因；具名七类 + 账本 seq 是底线（RUNTIME-002） |
| 为「观测好看」把 ledger 全量塞进信封 | 信封是契约不是数据库；全量在 ledger，信封只带 digest + disclosures |

## 7. 验收方式

S1（全部可复现）：

```bash
node --test services/backend/tests/inertia/momentum.test.js      # 衰减/恢复/七类停机全分支
node --test services/backend/tests/inertia/planSchema.test.js    # 放宽预算必拒 / 缺白名单必拒 / deny 模式先于 allow
node scripts/ci/check-leaf-contract.js services/backend/src/services/inertia/momentum.js
```

- 影子对照表：同一任务「虚拟停机点（S1 记录）」vs「Ralph 实际轮数消耗」，样本 ≥5。
- 既有套件零回归：agenticHarness 相关测试以 `# tests / # pass / # fail` 实测三行为基线（**落地时实测，不预估**），改前改后对比零漂移。
- S2 手工验收单：`khy inertia run --plan example.json` 全流程（启动四查 → 推进 → stop(status) → 信封 → resume 剩余预算制）。
- 门禁：`npm run check:changed`；新文件不触碰 layout 红线（`.khy/` 运行态不入仓）。

## 8. 待核实项

1. **costCny 闸在免费通道形同虚设**：gateway 免费适配器 cost 常缺（printOutputFormat.js:259-283 自述 "cost is usually unknown → 0"）。S2 前须定降级语义：cost 未知时 turns 为主闸、cost 闸挂起并披露。不阻断本设计。
2. **completion 探针与交付门的挂接深度**：S2 评审时确认 KHY_DELIVERY_GATE 的 remediation 轮语义能否直接映射 `completed` 判据，还是只作参考信号。
3. **`inertia_kick` 工具注册面**（路径 A 的模型发起形态）：S2 才动工具注册表；S1 无影响。
4. **boulderState `hasPending` 同型查询能否直接复用**（boulderState.js:86-88 按 cwd_hash 判 in_progress）——若语义不合（惯性 runId ≠ cwd 唯一），在 inertialRunService 内加一层 runId 索引查询，仍不改 boulderState 写路径。

## 9. 变更日志

- 2026-09-26 v1：初版提案。实测依据（当日 HEAD）：agenticHarnessService.js:35-47/:190-265/:530-642/:2586-2599；boulderState.js:4-96；printOutputFormat.js:65-362；inertialContinuation.js:28/:230-289；searchConvergence.js:1-31；GoalTool.js:48-84；toolUseLoopCore.js:740/:1968/:6618+/:6803/:7726；gateway/cliFailureEnvelope.js:16/:66/:128；contextRouter.js:59/:112；.ai/hq/PROGRESS.json:22。
- 2026-09-27 v1.1：S1 落地（影子模式，触发路径 C）。实施记录见 §10。

## 10. 实施记录（S1，2026-09-27）

### 10.1 落地清单（8 文件）

| 文件 | 性质 | 内容 |
|---|---|---|
| `src/services/inertia/defaults.js` | 新增 | 冻结常数单一真源：DEFAULTS（预算 maxTurns 40 / maxCostCny 5 / maxWallMs 600000 / maxIdleMs 90000 / maxDenies 3；decay 六参数 + stopBelow 0.2）、HARD_DENY_BASH（约 30 条不可逆命令通配）、SUPPORTED_COMPLETION_KINDS / SUPPORTED_CONTROL_POLICIES / MOMENTUM_EVENTS |
| `src/services/inertia/planSchema.js` | 新增 | validatePlan fail-closed（白名单非空必查 / 预算放宽必拒 / decay 放松必拒 / 未知字段拒 / runId 正则）；evaluateBashPolicy（deny 先于 allow，未命中 allow 即 deny）；wildcardMatch 整串锚定、pattern 逐段转义防注入 |
| `src/services/inertia/momentum.js` | 新增（纯叶子） | nextMomentum 零 IO 绝不抛不改入参；decideStop 七类停机优先级 completed > external > error > privilege > ambiguity > budget > decay；动量 4 位小数量化防浮点漂移 |
| `src/services/inertia/inertialRunService.js` | 新增（控制器） | runInertialPlan：启动四查（schema / 白名单 / 同 cwd 活跃 run / 租约）→ 段循环（kick → loopFn → 段末探针 → 动量结算 → 影子 decay → boulder 检查点）→ §3.7 信封；依赖可注入（chat/loopFn/runProbe 等），测试无内核依赖 |
| `src/cli/inertiaCommand.js` | 新增 | handleInertiaCommand：仅 `run --plan <file>`；退出码 completed=0 / 可重试=3 / 失败=2 |
| `src/cli/router.js` | 接线 | switch 加 `case 'inertia'`（惰性 require，同既有 case 体例），零内核改动 |
| `src/constants/commandSchema.js` | 接线 | ROUTER_COMMANDS 加 `'inertia'`；ROUTER_SUB_COMMANDS 加 `inertia: ['run']` |
| `tests/inertia/{momentum,planSchema,inertialRunService}.test.js` | 新增 | 47 用例全 `node:test`（CI 全量扫描 tests 目录） |

### 10.2 与方案的偏离（3 条，均有原因）

1. **planHash 绑定语义修正**：hash 必须绑定「落盘正文」＝ `{...plan, runId}` 去 planHash 字段后计算——因 plan.json 落盘含 runId，审计回放以盘上文件为准，hash 必须与之闭合（测试暴露的真实服务缺陷，已修；测试侧同步修正为对盘上 JSON 去 planHash 重算）。
2. **影子 decay 不真停**：S1 阶段 decay 命中只记录（ledger shadow 字段 + 信封 shadow 块）不中断推进——§4 PROCESS-008 合规（S1 只记录不阻断）。
3. **`-p` 式竞态诚实披露**：`onToolCall` 观测不可否决（toolUseLoopCore.js:6859 返回值只进 `_traceContext`）；bash 硬拒命中即置 `interruptSignal.interrupted` 批间刹车（内核 :6834/:7728），但同批已入队命令可能已执行一次，信封 disclosures 如实披露该竞态——§3.8「检测不可否决」约束下的最优实现。

### 10.3 验收实测（2026-09-27，全部实测非预估）

```text
node --test tests/inertia/{momentum,planSchema,inertialRunService}.test.js
  → # tests 47 / # pass 47 / # fail 0
node scripts/ci/check-leaf-contract.js src/services/inertia/momentum.js
  → "no violations found"（exit=0）
语法冒烟 → inertia registered=true; sub=["run"]; handleType=function
node --test 既有 8 文件（cli/router 系 + constants/commandSchema 系）
  → # tests 19 / # pass 13 / # fail 6
```

既有 6 fail 归因（**零新增回归**，逐条对账）：

- 5 个 jest 风格测试（`cli/router.test.js`、`constants/commandSchema.test.js`、`routerDispatchSlashLeaf/TailLeaf`、`routerDispatchOps.monitorObservability`）在裸 node --test 下加载即死（`describe/jest is not defined`），失败点在文件头加载阶段、未执行任何断言；官方跑法是 jest（package.json `"test": "jest"`），本机 node_modules 无 jest 无法执行，属存量现状，非本回合引入。
- 1 个 update apply 实参漂移（`routerDispatchOpsLeaf.test.js:133`，期望 `['apply', undefined]` 实得 `['apply', {onProgress, onStatus}]`）：该测试依赖图仅含 `routerDispatchOps.js` + updateCoordinator stub，不含 S1 改动的任何文件；同文件其余 5 用例全过（含「host router keeps its public contract」——router.js 接线后公共面完好）。

等效替代验证（jest 专项缺失时）：结构快照 `ROUTER_COMMANDS` 259 项无重复且既有项全保留、`ROUTER_SUB_COMMANDS.inertia=['run']`、`getCompletions('ine') → ['inertia']`、router 公共面 parseInput/route/getCompletions 完好、`mcpSubcommandSchema.test.js` 3 用例过。

### 10.4 §8 待核实项进展

- **待核实 4（boulderState 寻址）已关闭**：实测 `loadBoulderStateByTaskId`（boulderState.js:484）按 task_id 寻址、导出面 :713-732——runId 可直接作恢复主键，无需额外 runId 索引层，不改 boulderState 写路径。
- 待核实 1（cost 未知降级语义）/ 2（completion 探针与交付门挂接深度）：按方案留 S2；实施中 cost 未知已按「闸挂起 + 披露」处理。
- 待核实 3（`inertia_kick` 工具注册面）：留 S2，S1 无影响。
