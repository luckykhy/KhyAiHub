# [DESIGN-ARCH-181] 通道兜底（甩出）资格与披露统一策略

> **状态**：**一期已实施**（2026-10-04 落地：D1 只读叶子 + 披露三件套，纯披露、零行为变更；见 §10 实施记录）｜二期（D2 接线 + D4 等价映射）、三期（D4 收紧 + D5 文案）未启动
> **范围**：`runtime/node/backend/src/services/gateway/`（`aiGatewayGenerateMethod.js`、`aiGatewayRoutingMethods.js`、`routeFact.js`、`cliFailureEnvelope.js`、`aiGateway.js`）+ `cli/tui/` 披露面（只读消费，不改叶子契约）
> **上游依赖**：无外部依赖（本仓自有能力的行为修正与观测增强）
> **调研指针**：[DESIGN-ARCH-139]（钉选租约与跳过留痕 —— 本提案的**相邻正反面**：139 修「该甩不甩」，本提案修「说不清就甩」）、[DESIGN-ARCH-136]（零尝试判码）、[DESIGN-ARCH-114]（CLI 错误标准化信封）、[DESIGN-ARCH-071]（通道选择决策矩阵 —— 体例范本：把隐式裁决显式成表）、[DESIGN-ARCH-162]（模型粒度健康路由 —— 相邻面，不重叠）
> **模板合规**：按 [DESIGN-ARCH-124] 体例；非借鉴类改动，B-P1 豁免（见 §2）
> **路径时效**：仓正在分层迁移（旧 `services/backend` → 新 `runtime/node/backend`）。本文件全部路径按**新层**书写，实测于 2026-10-04。

---

## 0. 一句话结论

「甩出去」（跨通道兜底）本身是正确能力 —— 问题不在甩，在于**什么时候甩的判据分散在 6 处补丁里、故障归属不分、甩出事件不可存留**。用户实测体感「不通时不会清楚报错，反而总是发去什么桥接或 claude 渠道」，正是这三件事叠出来的：

| # | 病灶 | 位置 | 性质 |
|---|------|------|------|
| ① | **判据分散且互不一致**：同为「不通」，HTTP relay 通道要命中 dead-endpoint 类（404/4xx/5xx）才放宽，process-sensitive 通道（claude/codex/kiro/cursor/trae…）遇 process/timeout/network 就放宽 | `aiGatewayGenerateMethod.js:2497-2549` vs `:2499-2527` vs `:2528-2548` | 缺单一真源 |
| ② | **环境级故障无判定**：断网/代理挂时「换通道也无意义」无法识别，系统会对每个远端通道逐一甩一遍，再叠 jitter 4 轮重跑，最后才报「所有 AI 通道均不可用」 | `:3890-4100`（级联）+ `:2214-2228`（jitter）+ `:6529`（报面） | 归属缺失 |
| ③ | **甩出披露只活在转瞬的状态帧里**：切换说明全走 `emitStatus → {type:'status'}` 流式帧，非流式面不可见、滚动即消失；成功回复零披露；`routeFact` 有 attempted/served 但无切换链与原因 | `:1168-1195`、`routeFact.js`、`cliFailureEnvelope.js` | 观测面缺口 |
| ④ | **失败引导反向推销兜底**：报错建议里出现「切换到 API/桥接通道」「配置 RELAY_API_ENDPOINT + RELAY_API_KEY 启用中继兜底」「GATEWAY_CLAUDE_MODE=direct 直连」——用户词汇里的「总发去桥接/claude」与这些文案吻合 | `aiGateway.js:2063`、`:2071-2072` | 文案错位 |

**术语对齐（本仓语境）**：用户说「桥接」= `PROCESS_SENSITIVE_ADAPTER_KEYS`（`aiGateway.js:1214-1224`：`cli / codex / claude / kiro / cursor / trae / vscode / warp / cursor2api` —— IDE/CLI 桥接类通道）；「claude 渠道」= `claudeAdapter`（CLI 桥接 / 直连 API 双模，`GATEWAY_CLAUDE_MODE=auto`）。两者都属于**有本地进程副作用**的桥接类。

本提案的答案一句话：**把「甩」显式化为三态决策（原地重试 / 甩并披露 / 停下报错），以「故障归属」为第一判据，环境级不通走「等待网络恢复」而非继续甩，判据收拢到一个纯叶子。**

---

## 1. 现状实证（file:line 可复核）

### 1.1 甩出决策点全景（6 处，无总表）

| # | 决策点 | 位置 | 触发条件 | 披露方式 |
|---|--------|------|----------|----------|
| S1 | auto 排名级联 | `aiGatewayRoutingMethods.js:512-549`（`_rankAdaptersForDefaultRoute`）+ `:636-670`（用户自定义 failover 顺序） | 无钉选，按 penalty 分数/UCB/用户顺序逐通道试 | 页脚 `routeFact`（仅终值） |
| S2 | strict 放宽·死端点 | `aiGatewayGenerateMethod.js:2477-2496`（前置放宽）、`:2520-2527`（失败时放宽） | HTTP relay 通道（`relay_api/api/relay`）+ `{model_not_found, unavailable, bad_request, server_error}`（`gatewayErrorClassifier.js:22-27`）+ 连败 ≥1 | `emitStatus` 状态帧 |
| S3 | strict 放宽·进程类 | `:2528-2548` | process-sensitive 通道 + `{process, timeout, network}` / queue timeout / 瞬态传输消息 | `emitStatus` 状态帧 |
| S4 | env 钉选解除 | `:2585-2631`（`_maybeRelaxEnvPinnedUnavailable` + 租约解钉，139 二期已落地） | env 钉选（非用户显式）通道 `unavailable` 或处于冷却 → 当次放宽 + 连续 2 次自动写回 `.env` | `emitStatus` + `.env` 注释 |
| S5 | 进程并行提升 | `aiGatewayRoutingMethods.js:854-990`（`_maybePromoteProcessFailoverAdapters`） | 首选近期 process 失败 → 并行探测 `['relay_api','api','relay','ollama']`（`gatewayConstants.js:14`）→ 把可用者**提升到队首** | `emitStatus`（「并行探测完成：优先兜底通道 …」） |
| S6 | jitter 整轮重跑 | `:2214-2228`（`cascadeJitterRetryRounds` 默认 4）+ `:6245-6290` | 整轮全瞬态失败 → 清冷却、退避、重跑整轮 | 失败时披露（`:6512-6515`） |

叠加逻辑：级联循环本体（`:3890-4110`）内还有「冷却跳过 / unavailable 跳过 / 人肉通道跳过」（`:4071-4094`，`manualRelayAutoFallbackPolicy.js`）等分支。**6 个决策点没有任何一个统一的成文判据表** —— 唯一有成文策略的是人肉通道（`manualRelayAutoFallbackPolicy.js` 头部注释），它正是本提案要推广到全部决策点的体例。

### 1.2 判据集互不一致（同失败，不同待遇）

| 失败类别 | HTTP relay 首选（S2） | process-sensitive 首选（S3） | 差异 |
|---|---|---|---|
| `network` | ✗ 不放宽（需 dead-endpoint 类） | ✓ 放宽（直接甩） | **同型失败，取决于通道类型** |
| `timeout` | ✗ | ✓ | 同上 |
| `process` | ✗ | ✓ | 同上 |
| `bad_request`(400) | ✓ 放宽（在 DEAD_ENDPOINT 集合内） | ✗ | 400 常是请求构造问题——换通道大概率同样失败或掩盖真因 |
| `auth` / `rate_limit` | ✗（注释声明刻意排除，`:2517-2518`） | ✗ | ✓ 已正确 |
| `server_error`(5xx) | ✓ | — | ✓ 通道侧故障，甩合理 |

`auth`/`rate_limit` 的排除是**口头哲学写在注释里**（「活着但被限流/鉴权失败的端点应就地重试或换 key，不该被级联甩掉（否则会掩盖 1302 之类）」）——没有叶子、没有单测钉住。下次谁改判据，无人拦截。

### 1.3 环境级缺失与既有「等待网络恢复」错层

断网/代理挂时的现状行为链（实测代码路径）：

```
首选失败(network) → 可能放宽(S2/S3) → 逐通道甩(含桥接类/claude)
→ 每个远端都 network 失败 → jitter 4 轮重跑（退避,每轮全失败）
→ 级联耗尽且全瞬态 → 才进入「等待网络恢复」（:6295-6402,周期性轻探）
→ 最长等 _networkResumeMaxMs 后放弃 → 报「所有 AI 通道均不可用」( :6529 )
```

两个问题：
1. **判定太晚**：环境级证据（≥2 个远端同型 network 失败）在第 2 个通道失败时其实已经成立，但系统把剩余通道全试完 + 4 轮 jitter 之后才用上它（作为「等待网络恢复」的触发）；`buildChannelFailureAdvice` 的 network 指引（`buildChannelFailureAdvice.js:140-141`）也要等全穷尽才显示，且主标题仍是「通道不可用」——真因果被倒置（不是通道坏，是网络坏）。
2. **「等待网络恢复」是正确机制但触发条件错层**：它已有探针、轮次闸、诚实披露（`:6346`、`:6402`），**这正是「环境级不通」应有的归宿**。缺的只是把触发从「穷尽后」提前到「可判定时」，并在等待期间**不甩远端**（除本地 ollama/localLLM）。

### 1.4 披露面实录（用户视角可见的只有这些）

| 披露面 | 载体 | 问题 |
|---|---|---|
| 切换状态行 | `emitStatus`（`:1168-1195`）→ `{type:'status'}` 帧 | 仅 `originalOnChunk` 存在时可见（`if (originalOnChunk && text)`）；转瞬即逝；139 已记录同类教训（「状态行转瞬即逝、不可存留」） |
| 切换透明化 | `:4052-4064`：「通道 X 不可用（原因），已切换到 Y，第 N/M 个」 | 同上传载体问题 |
| 页脚路由事实 | `routeFact.js`（`buildRouteFact` 在 `:1506-1520` 挂载） | 有 `attempted`/`served`，**无切换链、无逐跳原因**；且只随 result 返回，TUI 页脚消费 |
| 失败信封 | `cliFailureEnvelope.js`（判码 + routing + hint + attempts） | 已较完善（139 加固过），但主码 `CHANNEL_EXHAUSTED` 的 title 对「环境级」与「通道级」不分流 |
| 失败引导文案 | `aiGateway.js:2063`「若处于沙箱/受限环境，请切换到 API/桥接通道」；`:2071-2072`「Claude CLI 桥接模式异常 → GATEWAY_CLAUDE_MODE=direct；或配置 RELAY_API_ENDPOINT + RELAY_API_KEY 启用中继兜底」 | 把「兜底路径」写成主建议 → 用户体感「总被发去桥接/claude」 |

### 1.5 正面先例（本提案不动、只复用）

| 先例 | 位置 | 借用点 |
|---|---|---|
| 人肉通道跳过策略 | `manualRelayAutoFallbackPolicy.js`（纯叶子 + SSOT 判定 + 显式指定放行 + env 门） | 叶子形态与「显式选择永远放行」原则 |
| strict 跳过留痕 | `:3988-4033`（139 一期已落地，`virtualSkip:true` 同型） | 「环境级跳过远端」的留痕照抄此型，不毒化熔断 |
| 等待网络恢复 | `:6295-6402` | 环境级的动作归宿（不新造机制） |
| 用户显式钉选绝不放宽 | `:2160-2165`、`:2501-2504`、`:2589` | 「钉子户」语义保持——用户钉的人绝不被自动甩 |
| 请求级回滚参数 | `options.networkResume`、`options.cascadeJitterRounds`（`:2220`、`:2240`） | 新行为的回滚面用**可选参数**承载（不加 env 门，见 §3.4） |

---

## 2. 借鉴提案（B-P2 七字段）

**不适用。** 依据：[SOURCING-001] §3 B-P1 —— 本提案是对已登记能力域（`aiGateway` 路由级联、`routeFact` 路由事实、`cliFailureEnvelope` 诊断信封）的**行为修正与观测增强 + 一处聚合判定的显式化**，无任何外部借鉴对象。为合规起见逐项声明：字段 1-7 均不适用（不引入任何上游代码/结构/结论/测试）。

---

## 3. 目标形态（组件级契约）

### D1（单一真源）甩出资格判定表

把「什么时候甩」显式化为 **归属（ownership）→ 三态决策** 两段式。**故障归属**是第一判据：

| 归属 | 判定材料 | 决策 |
|---|---|---|
| **channel-scoped**（通道自身故障） | `server_error`(5xx) / `process` / `unavailable` / 瞬态传输（`reconnecting`/`channel closed`/`socket hang up`）/ 单通道 `timeout`、`network` | **F = 甩**（级联下一通道） |
| **environment-scoped**（环境级） | 证据 A：同一轮内 ≥2 个**不同远端适配器 key** 均以 `network`/`timeout` 类失败；证据 B：错误含本机解析/代理特征码（`EAI_AGAIN`/`getaddrinfo`/`ENOTFOUND`/`proxy tunnel`/`tunneling socket`）。注：`ECONNREFUSED` 单独**不构成**环境证据（更像目标端点死） | **E = 不甩远端**：跳过剩余远端适配器（留痕），把控制交给既有「等待网络恢复」（§1.5）；本地通道（`ollama`/`localLLM`）仍可尝试 |
| **request-scoped**（请求/凭证侧） | `auth`(401/403) / `rate_limit`(429/1302) / `bad_request`(400) / `model_not_found`(模型名形状错) | **B = 不甩，明确报错** + 修复指引（auth→查 key；rate_limit→等窗口；400→查请求；404→查模型名） |

三态的含义（合法性闭合）：`R`（原地重试——不换通道，用于 rate_limit 冷却等待）、`F`、`B`、`E` **四出口**，其中 R 与 E 是本提案显式化的两个新命名（R 行为现状已有，仅命名；E 是新增判定）。

**钉选身份 × 决策**（与现状语义对齐，不变）：

| 钉选身份 | 判定来源 | 通道侧故障时 | 请求侧故障时 |
|---|---|---|---|
| 用户显式钉选 | `options.userPinnedAdapter` / `options.preferredAdapter + strictPreferred:true`（`:2160-2165`） | **B**（现状：绝不放宽——保持） | **B** |
| env 钉选 | `GATEWAY_PREFERRED_ADAPTER` 非 auto | **F + 披露 + 租约**（现状 S4——保持，受归属判据约束） | **B** |
| auto | 无钉选 | **F**（S1 级联——保持） | **B**（现状 auth 等仍会级联——一期先披露，二期收） |

**目的地资格**（甩去哪，按成本分级）：

| 目的地类别 | 成员 | 资格 |
|---|---|---|
| 本地无网络依赖 | `ollama` / `localLLM` | 自由甩；**环境级判定后是唯一仍可尝试的远端之外选项** |
| 远端 API / 中继 | `api` / `relay_api` | 自由甩 |
| 桥接类（有本机进程副作用） | `PROCESS_SENSITIVE_ADAPTER_KEYS`（`:1214-1224`） | 可甩，但受两约束：①环境级判定后**不再**甩桥接类（它们同样依赖网络）；②同轮甩入桥接类的次数受 `maxTotalAttempts` 既有闸约束（不新增） |
| 人肉 | `relay` / `clipboard` | 禁（`manualRelayAutoFallbackPolicy.js` 既有——保持） |

本表落地形态：新叶子 `runtime/node/backend/src/services/gateway/fallbackEligibilityPolicy.js`（纯叶子：零 IO、确定性、绝不抛、不读 env），承载 D1 表 + D2 证据聚合，供 §3.4 的消费点统一调用。

### D2（环境级判定提前）`environmentOutageSignal` 聚合

- 位置：新叶子（可并入 `fallbackEligibilityPolicy.js` 同模块双导出，或独立 `environmentOutageSignal.js`——实施时按文件行数 2000 上限取其一）。
- 输入：`{ attempts, env }`（attempts 为已有结构，含 `adapterKey/errorType/error/statusCode`）。
- 输出：`{ environmental: boolean, evidence: string[], remoteAdaptersFailed: number }`。
- 判定纯函数、绝不抛；`timeout` 计入证据但降权（timeout 也可能是慢端点）。
- **消费点一**：级联循环内，在一个远端适配器失败后调用；`environmental:true` → 对剩余**远端**适配器逐条 `allAttempts.push({...virtualSkip:true, errorType:'env_outage_skip'})` + `emitStatus('检测到跨通道网络不可达，暂停远端尝试，转为等待网络恢复')` + `continue` 跳过（本地通道不跳）。
- **消费点二**：jitter 重跑前置判定；`environmental:true` → 跳过 jitter（`:6245` 处），直接进「等待网络恢复」（`:6295`）。
- **消费点三**：`buildChannelFailureAdvice` 之后（`:6477-6508`）——环境级命中时改用环境级文案（见 D3-3）。

### D3（披露三件套）

**D3-1 `routeFact` 增字段（结构化，一期）**：`buildRouteFact`（`routeFact.js`）追加只读字段：

```js
cascade: [ { adapter, errorType, cause, decision:'fallback'|'skip'|'failed' } ],  // 逐跳链,虚拟跳过也计入(cause 标 virtualSkip)
switchedFrom: 'claude' | '',      // 与 served 不同的首跳来源
switchReason: 'network' | '',     // 首跳失败类别(归一化,非原始消息)
environmental: false,             // D2 结论透出
```

不变式（沿用 `_assertCoherent`）：`environmental===true → cascade 中远端 decision 全为 skip/failed`；`outcome==='ok' && cascade.length>0 → switchedFrom 非空`。

**D3-2 回合级切换 notice（TUI，一期）**：消费 `routeFact.cascade`；当 `switchedFrom && outcome==='ok'`，经**既有 notice 机制**（`App.js:791` 的 `role:'notice'` 先例）在回合结束后追加一行：

> ⚑ 本次由 `<served 显示名>` 完成（首选 `<switchedFrom 显示名>` 因 `<switchReason 中文>` 不可用，已自动兜底）。如需固定通道：`khy provider use`。

**不注入回复正文**（避免污染下游复制/解析）——notice 是独立行。

**D3-3 失败信封主标题分流（一期）**：`cliFailureEnvelope.js` 不新增判码（保 114 的单射互斥与 139 的码序），只对 `CHANNEL_EXHAUSTED` 分支做 **title/hint 变体**：

| 条件（按序，首个命中即停） | title | hint 首条 |
|---|---|---|
| 已存在具体信号（auth/rate_limit/model_not_found…） | 不变（139 语义） | 不变 |
| `environmental:true`（D2 透传） | 「网络/代理不通（不是通道问题）」 | 检查网络与代理（`khy doctor`）；恢复后说「继续」 |
| 其他 | 「所有 AI 通道均不可用」（兜底） | 现状 |

### D4（判据收拢 + 回滚面）

- 三个既有决策点改为消费同一叶子：`:2497-2549`（S2/S3 的 `_shouldRelaxStrictPreferredOnFailure`）、`:2585-2631`（S4 解钉）、`aiGatewayRoutingMethods.js:854-990`（S5 提升前的可用性判定保留，仅把「哪些失败才值得触发提升」交给叶子）。
- 一期**只映射、不改行为**：叶子对既有 6 处的入参映射表逐条等价复现现状判据（附等价性单测：同输入 → 同输出），二期再收紧（`bad_request` 细分、`network` 对 relay 的政策统一）。
- **回滚面**：新增行为由调用方**可选参数**承载（`options.fallbackOwnership` 缺省 `undefined` = 启用新判定；显式传 `false` 逐字节回退今日行为——照抄 `options.networkResume` 惯例 `:2240`）。**不加新 env 门**：门预算棘轮（`scripts/ci/check-tui-gates.js` `MAX_GATES`）只减不增，且本判定属「行为修正」而非「用户可见权衡」（[DESIGN-ARCH-181] 沿 [SOURCING-001] §6.1 判据）。
  - ⚠ 实测：`check-tui-gates.js:51` 仍指向旧路径 `services/backend/src/cli/tui`，当前**已 ENOENT 崩溃**（2026-10-04 实测）——门预算无法本地核数，故本提案明确**不新增门**，把该守卫的修复登记为 §8 待核实项。

### D5（文案约束，三期）

- `aiGateway.js:2063` / `:2071-2072`：把「切换到桥接通道 / 配置 relay 兜底 / GATEWAY_CLAUDE_MODE」从**并列建议**降为「可选加强」子区（`可选:` 前缀 + 置后），主建议位让给「先修当前问题（网络/密钥/模型名）」；保留全部信息，只调位置与措辞——**不删**（它们是真实可用的兜底路径）。

---

## 4. 实施分期（每期独立可回滚）

| 期 | 内容 | 回滚方式 | CI 风险 |
|----|------|----------|---------|
| 一期 | D1 叶子落地（只读判定，不接线）+ D3-1/D3-2/D3-3（披露三件套） | 撤 routeFact 字段消费与 notice 渲染即可；叶子无副作用 | 低：新测试用 `require('node:test')` 放 `runtime/node/backend/tests/gateway/`（CI 全量 glob 会扫到，**落地即绿**） |
| 二期 | D2 环境级判定接线（级联跳过 + jitter 前置 + 信封透传）+ D4 判据收拢（等价映射） | `options.fallbackOwnership=false` 逐字节回退 | 中：改级联热路径，需先跑既有套件（`aiGateway.cascadeJitterSelfHeal.test.js` / `aiGateway.networkResume.test.js` 等）证明零回归 |
| 三期 | D1 收紧项（`bad_request` 细分、relay 的 `network` 政策统一）+ D5 文案 | 纯判据/文案回退 | 低 |

顺序理由：一期先把「甩了什么」变得可存留、可观测（不改行为）——二期才敢改行为；三期的收紧项（400 语义细分）需要一/二期积累的 `routeFact.cascade` 样本举证「哪些 400 是端点死、哪些是请求错」。

---

## 5. 诚实边界（刻意不纳入）

| 不做 | 原因 |
|---|---|
| 不动用户显式钉选语义（`:2501-2504`） | 「钉子户」是用户意志；139 已给它补了元原因判码与披露，本提案只保证它在判定表中位置明确 |
| 不把 `auth`/`rate_limit` 改成「可甩」 | 注释哲学（`:2517-2518`）正确：换通道会掩盖「该修 key/该等窗口」。本提案把它从注释升格为叶子 + 单测，不改结论 |
| 不动 `model_not_found`/`unavailable`/`server_error` 的 DEAD_ENDPOINT 资格（`gatewayErrorClassifier.js:22-27`） | trae 死端点场景的真实类型就是 `model_not_found`（`:2519` 注释自证）；收紧它会把已修好的「死端点拖垮对话」问题重新引入 |
| 不新增 env 门 | 见 D4（棘轮 + 权衡判据）；回滚用 `options.fallbackOwnership` |
| 不做「全局断网探针」（对默认网关 TCP 探测） | 无先例、跨平台行为不一；D2 的跨通道复现证据已足够判定「不必再甩远端」，探针收益不成比例（列为三期可选项，默认不做） |
| 不改 `emitStatus` 状态帧本身 | 它是正确的即时反馈通道；本提案只补「可存留」的第二披露面，不动它 |
| 不动 khyquant（`delivery/channel/`）的独立链路 | 它若复用同一网关则自动受益；如自建通道另案立项 |
| 不修 `check-tui-gates.js` 的旧路径崩溃 | 超范围，登记 §8；本提案不依赖它 |

---

## 6. 反模式（这条路别走）

| ✗ 别做 | 为什么 |
|---|---|
| **见 `network` 就停（不加跨通道复现条件）** | 单通道 `network` 是**通道级**故障（该端点死了），甩下一通道恰恰是对的。停的条件必须是「≥2 个不同远端 key 同型失败」或环境特征码——「一次失败就宣布网络全断」会把单点故障误判成环境故障，让本可兜底的请求直接失败 |
| **把环境级判定做成「再探一个 HTTP 请求」** | 增加热路径延迟且探针本身也可能失败；跨通道复现证据（D2-A）零成本、纯离线可测。探针是反模式，证据聚合才是 |
| **把披露塞进状态帧就算完** | 139 已踩过：「状态行转瞬即逝、不可存留」（139 §6）。披露必须进**可存留**面（routeFact 字段 / notice 行 / 信封） |
| **给「环境级跳过」记真实失败** | 会毒化熔断与健康度（把网络问题记成通道坏）。必须 `virtualSkip:true` 同型（照抄 `:3998-4006`） |
| **在成功回复正文里注入「本次由 X 完成」** | 污染下游：复制、diff、二次解析都会吃到注入行。用独立 notice 行 |
| **为「甩快点」把桥接类提到队列最前** | 桥接类有本机进程副作用（spawn CLI/IDE），且 139 病史显示「自动甩到未选通道」正是用户投诉源。提升资格只属于进程级 failover（S5）既有条件，不得新开 |
| **三期收紧 `bad_request` 时直接踢出 DEAD_ENDPOINT 集合** | 会让「中继站拒特定请求格式 → 换通道可成功」的既有场景卡死（`adaptiveParamStrip` 的存在证明这类真实存在）。必须先有 `cascade` 样本细分「端点语义 vs 请求语义」，再按证据收紧 |
| **把本策略实现成新的「总调度器」** | 收拢是「多调用点消费同一叶子」，不是「新造一层路由」。routing 的真源仍是 `aiGatewayRoutingMethods.js` |

---

## 7. 验收方式

```bash
# 叶子单测（node:test，落地即绿；CI 的 test:node 全量 glob 会扫到）
node --test runtime/node/backend/tests/gateway/fallbackEligibilityPolicy.test.js
node --test runtime/node/backend/tests/gateway/environmentOutageSignal.test.js   # 若拆文件

# 等价性单测（D4 一期承诺：叶子对既有 6 处判据的映射逐条等价）
# - 输入同 {errorType, adapterKey, pin, attempts} 快照 → 叶子决策 === 改造前分支结果

# 零回归（既有套件，先跑）
node --test runtime/node/backend/tests/gateway/aiGateway.cascadeJitterSelfHeal.test.js
node --test runtime/node/backend/tests/gateway/aiGateway.networkResume.test.js
node --test runtime/node/backend/tests/gateway/cliFailureEnvelope.test.js   # jest 风格:影子跑纪律,见实施技能 §8.2

# 复现验收（一期落地后,人工核对）
#  A. 单通道故障可甩:首选 A 故障(server_error)、B 可用 → 成功;回合后出现 notice 行
#     “⚑ 本次由 B 完成(首选 A 因 5xx 不可用,已自动兜底)”,routeFact.cascade 长度 ≥1
#  B. 环境级不甩:同时断网(两远端 network 失败) → 状态帧出现“暂停远端尝试”,
#     信封 title 为“网络/代理不通(不是通道问题)”,无“已执行 N 轮抖动自愈”行
#  C. auth 不甩:密钥失效 → 报“密钥/权限”指引,routeFact.cascade 为空/environmental=false
#  D. 用户钉选不变:userPinned + 通道故障 → 硬失败 + PINNED 元原因判码(139 语义不回退)

# 关联门禁
node scripts/ci/check-leaf-contract.js runtime/node/backend/src/services/gateway/fallbackEligibilityPolicy.js
#   ⚠ check-tui-gates 当前因旧路径 ENOENT 崩溃(§8-2),本提案不依赖
```

**基线数字必须实测**（不许估）：实施一期前跑既有套件取 `# tests/# pass/# fail` 真值，写进实施记录。

---

## 8. 待核实项

| # | 事项 | 阻断什么 | 状态 |
|---|------|----------|------|
| 1 | 用户症状发生的具体面（TUI / 桌面端 / HTTP 面），决定 notice 落点优先级 | 不阻断设计（一期覆盖 TUI notice + 信封 + routeFact 三面） | 开放，建议实施前向用户确认一次 |
| 2 | `scripts/ci/check-tui-gates.js:51` 仍指旧路径 `services/backend/src/cli/tui`，**实测 ENOENT 崩溃** ⇒ 门预算无法核 | 不阻断本提案（已选「不加门」）；阻断**任何**打算新增 env 门的并行提案 | 已实测确认（2026-10-04），修复另案 |
| 3 | 分层迁移后 `DESIGN-ARCH` 引用行号的有效期（本文件行号实测于 `runtime/node/backend` 新版） | 不阻断；实施时以当日源码为准复核 | 开放 |
| 4 | `bad_request` 细分所需样本（端点语义 vs 请求语义）从 `routeFact.cascade` 积累 | 阻断三期收紧项 | 待一/二期上线后 |
| 5 | `PROCESS_SENSITIVE_ADAPTER_KEYS` 是否应补 `openclaw` 类新桥接适配器 | 不阻断；D1 目的地表按集合 SSOT 引用，集合自身变更自动跟随 | 开放 |
| 6 | `scripts/ci/check-no-emoji.js` 的 `RUNTIME_SOURCE_RE` 未随分层迁移更新（列表只有旧前缀 `services/` `apps/` `scripts/`…，**无 `^runtime/`**）⇒ `runtime/node/backend/src/**` 整体不在 emoji 观察器管辖内。实测（2026-10-04）：本期 10 个相关文件 `isJudged` 全 `skip`；同内容换旧前缀 `services/` 即 `JUDGED`。旁证：该文件的 EXEMPT 表与离线 SCENARIOS 都已更新为新层路径，唯独管辖正则漏改。附带超集扫描（原始码位、含注释）得 8 处彩色码位，逐行对拍 HEAD 确认为**既有注释**文字（彩色码位 U+26A0+U+FE0F / U+1F9E0 / U+23F3 / U+1F50D / U+2753 / U+1F4AD），本期零引入，且注释行本就会被 `codePartOf` 剥离 | 不阻断本提案（观察器 S1 非阻断期）；阻断「新层 emoji 治理」的完整性——**在新层改文件时，「守卫没报」≠「守卫查过」** | 已实测确认（2026-10-04）。修复另案：给 `RUNTIME_SOURCE_RE` 补 `^runtime/` 前缀，且**先全量盘点**新层命中再开门（否则可能一次全红） |

---

## 9. 变更日志

- 2026-10-04 初稿：实测收证 6 处甩出决策点（S1-S6）与判据不一致（§1.2）、环境级缺失与「等待网络恢复」错层（§1.3）、披露面窄化（§1.4）；提出归属三态判定表（D1）、环境级提前判定（D2）、披露三件套（D3）、判据收拢与不加门回滚面（D4）、文案降位（D5）；登记 check-tui-gates 旧路径崩溃（§8-2）。
- 2026-10-04 一期实施落地：D1 叶子（`fallbackEligibilityPolicy.js`，376 行）+ 披露三件套（`routeFact.cascade` 四字段 / TUI 回合 notice / 信封 title-hint 变体）。4 套新 node:test 73 断言 + 既有套件 75 断言全绿；3 处偏离逐条有据（§10.3）；新登记 check-no-emoji 管辖盲区（§8-6）。基线数字与验收命令见 §10。

---

## 10. 实施记录（一期，2026-10-04 落地）

### 10.1 落地清单

| 文件 | 内容 | ratchet HARD（`maxFuncLines` = 最大括号跨度） |
|---|---|---|
| `runtime/node/backend/src/services/gateway/fallbackEligibilityPolicy.js`（新增，376 行） | D1 判定表 + D2 证据聚合（纯叶子：零 IO / 确定性 / 绝不抛 / 不读 env）；导出 `classifyFailureOwnership` / `probeEnvironmentOutage` / `decideFallback` / `classifyDestination` / `strictRelaxQualifies` 等 | 新文件 caps 全绿（跨度 47/300，嵌套 4/6） |
| `.../services/gateway/routeFact.js` | D3-1：`cascade` / `switchedFrom` / `switchReason` / `environmental` 四字段 + 两条不变式 + `formatCascadeNotice()`（notice 文案源） | 32 → 31（-1） |
| `.../services/gateway/cliFailureEnvelope.js` | D3-3：白名单码 × environmental 透出 → title/hint 首条变体；顺带抽出 `_withRegistryFacts` 压低跨度 | 72 → 66（-6） |
| `.../cli/aiChatCore.js` | D3-2 转发链①：chat 成功返回**同行合并** `routeFact: result.routeFact \|\| null` | 4749 → 4751（+2，归因见 10.5-1） |
| `.../services/tool/toolUseLoopCore.js` | D3-2 转发链②：success 返回**同行合并** `routeFact` | 9469 → 9469（=） |
| `.../cli/tui/hooks/useQueryBridge.js` | D3-2 终端消费：result 映射透传 + 回合后 `role:'notice'` 追加（`_withCascadeNotice()`） | 3824 → 3824（=） |

三个巨型文件（aiChatCore 5133 行 / toolUseLoopCore 10555 行 / useQueryBridge 4470 行）的改动**全部走同行合并**（不开新行），`maxFuncLines` 零增长——这是过 L1 棘轮的硬约束，二期改行为面时不得违反。

### 10.2 测试（全部实测真值）

新建 4 套 node:test（`require('node:test')`，CI `test:node` 全量 glob 落地即扫）：

| 套件 | 断言 | 覆盖 |
|---|---|---|
| `tests/gateway/fallbackEligibilityPolicy.test.js` | **42/42** | A 归属矩阵 9 条；B D2 证据 16 条；C 三态/目的地 11 条；D 等价性 6 条（含全格等价 ≈13 万组合逐一对拍 `aiGatewayGenerateMethod.js:2497-2549` 原实现） |
| `tests/gateway/routeFact.cascade.test.js` | **15/15** | cascade 派生 / switchedFrom / switchReason / environmental 透出 / virtualSkip 留痕 / 两条不变式 / `formatCascadeNotice` 全分支（含中文 reason 映射） |
| `tests/gateway/cliFailureEnvelopeEnvironmental.test.js` | **10/10** | 环境级 title/hint 分流；非白名单码逐字节不动（139 语义不回退）；严格 `===true`；绝不抛 |
| `tests/gateway/fallbackDisclosureWiring.test.js` | **6/6** | 转发链三处接线静态锁（同行合并形态）+ notice 助手契约（独立 `role:'notice'`、不注入回复正文、fail-soft）+ 叶子导出面 |

既有套件零回归（改动后实跑）：

| 套件 | 断言 | 跑法 |
|---|---|---|
| `routeFact.test.js` | 20/20 | jest 真跑 |
| `cliFailureEnvelope.test.js` | 27/27 | jest 真跑 |
| `aiGateway.cascadeJitterSelfHeal.test.js` + `aiGateway.networkResume.test.js` | 13/13 | jest 真跑 |
| `cliFailureEnvelopeZeroAttempt.test.js` | 15/15 | node --test |

合计 **73（新）+ 75（既有）= 148 条全绿**。

> 纪律：jest 风格文件（含裸 `describe`）**不得追加** node:test 用例——会被两套 runner 同时扫到。新用例一律新文件 + `require('node:test')`。

### 10.3 与设计的偏离（3 处，逐条给原因）

1. **`decideFallback` 增加 E 的第二入口**（`ownership === 'environment'` → E，reason `environment-signature`）。原因：D2 证据 B（特征码）在 `classifyFailureOwnership` 里直接归 `environment`，若 `decideFallback` 只认 `environmental === true` 聚合旗标，则同叶子内两处判据不自洽（单条特征码成立时 E 会漏）。C-02 钉住该入口。
2. **`strictRelaxQualifies` 的 key 比较用原始字符串**（不做小写归一）。原因：原实现 `_shouldRelaxStrictPreferredOnFailure` 用 raw `entryKey !== preferredAdapter`；D4 承诺「逐字节等价复现」，大小写敏感性属于等价面的一部分。D-01~D-03 全格对拍通过。
3. **D3-3 白名单从「仅 `CHANNEL_EXHAUSTED`」扩为 `{NETWORK_ERROR, TIMEOUT, CHANNEL_EXHAUSTED, NONE}`**。原因：实测真断网时主码落到 `NETWORK_ERROR`（errorType 取最后一次失败尝试，`aiGatewayGenerateMethod.js:6561-6562`），只按 `CHANNEL_EXHAUSTED` 分流会让环境级文案几乎永不触发。白名单 = 「允许被环境级覆盖的码」；白名单外的码（auth / rate_limit / model_not_found / 5xx / unavailable / 钉选类 / NO_ATTEMPT）保持 139 语义逐字节不变（E-05/E-06 钉住）。

### 10.4 明确不做（一期边界）

- **不接线** D2 三个消费点（级联跳过 / jitter 前置 / 信封透传判定）——二期，连同 `options.fallbackOwnership` 回滚面。
- 一期无新 env 门（门预算棘轮）；一期无可回滚的行为（纯披露增量），回滚 = 撤 §10.1 六处改动。
- 不动 `emitStatus` 状态帧、不动 `aiGateway.js:2063/2071-2072` 文案（D5 三期）。
- 不修 `check-tui-gates.js` 旧路径崩溃（§8-2）；不修 `check-no-emoji.js` 管辖盲区（§8-6，另案）。

### 10.5 附带发现（两件，均取证闭环）

1. **aiChatCore 工作树 +2 行归因**：`maxFuncLines 4749 → 4751` 的 +2 为**并行会话**加入的 cache token 计数行（`tokenUsage.cacheReadInputTokens || 0,` / `cacheWriteInputTokens || 0`），逐行对拍 HEAD 确认非本期引入；本期在该文件的改动是同行合并（0 行增长）。若两方变更合并提交，棘轮会因这 +2 显红——由该会话自行平账。
2. **`check-no-emoji.js` 管辖盲区**（已登记 §8-6）：`runtime/**` 不在 `isJudged` 管辖内；对本期 10 个文件做超集扫描（原始码位、含注释）得 8 处彩色码位，逐行对拍 HEAD 全部为**既有注释**文字，本期零引入。另：本文档自身扫描 8 处命中——6 处为 §8-6 行初稿的字面 emoji（已改码位记法）、2 处为 §1.2 表内既有 U+2705（已顺手修 `✓` U+2713）；修正后归零。

### 10.6 验收命令（可复现）

```bash
cd D:/Portable/khy-os
node --test runtime/node/backend/tests/gateway/fallbackEligibilityPolicy.test.js
node --test runtime/node/backend/tests/gateway/routeFact.cascade.test.js
node --test runtime/node/backend/tests/gateway/cliFailureEnvelopeEnvironmental.test.js
node --test runtime/node/backend/tests/gateway/fallbackDisclosureWiring.test.js
node scripts/ci/check-leaf-contract.js runtime/node/backend/src/services/gateway/fallbackEligibilityPolicy.js
node scripts/ci/check-agent-rules.js <6 个源文件>          # 实测: 6 file(s) scanned, passed

# ⚠ check-file-ratchet.js 本机整跑会「扫描 0 个改动文件」假通过（base ref=HEAD~1，未提交改动不可见）
#   ⇒ 本机验收用「复刻指标算法对 git show HEAD:<file> 比」（算法源=scripts/ci/check-file-ratchet.js），
#   本期实测：5 个被改文件 HARD 4 绿，aiChatCore +2 归因为并行会话（10.5-1）
```
