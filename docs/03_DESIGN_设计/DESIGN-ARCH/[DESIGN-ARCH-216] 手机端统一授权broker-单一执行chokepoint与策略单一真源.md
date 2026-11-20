<!-- IMPL-STATUS: todo -->
# [DESIGN-ARCH-216] 手机端统一授权 broker：单一执行 choke point 与策略单一真源

> **状态：实施细化提案，2026-11-14；不是实施完成报告，本轮零代码改动。**
> **父方案**：[215 安卓统一方案](<[DESIGN-ARCH-215] khyos安卓统一方案-人工基座与智能执行闭环.md>) 的 **P1 安全调用闭环**中「统一授权」一块的可开工细化。事务账本迁移（P2/M3）是下一块，本文不展开。
> **需求来源**：用户在 215 交付后说「要，做好方案后我批准再执行」。本文是待批方案；**批准前不写任何运行时代码**。
> **批准 ≠ 可立即施工**：见 §0.2——授权面当前整片是未提交的在飞工作，施工还须等它落定并与作者对齐。

## 0. 交付口径与边界

### 0.1 本文给什么

一个**可开工**的授权 broker 设计：验证过的现状缺口地图（带 `文件:行号`）、目标架构、确切插入点、复用清单、需人裁决的契约决定、分阶段落地（PROCESS-008）、复现规格（RUNTIME-007）、正负控制测试规格、回退条件。它把 215 §8 的「有效授权 = 系统 ∩ 策略 ∩ 调用范围 ∩ 隐私」落到手机端真实代码的具体缝上。

### 0.2 三条硬边界（先说清，避免误批）

1. **本轮零代码改动**。只产出本设计 + 索引行。不碰手机、不装依赖、不改权限、不提交。
2. **授权面整片在飞**。本轮 `git status` 实测：`tool_engine.dart`、`agent_loop.dart`、`chat_screen_new.dart`、`LoopModes.java`、`ATOMIC-CAPABILITIES.json`、`atomicCapabilityRegistry.js` 均为 ` M`（已跟踪有改动）；`local_driver.dart`、`pc_bridge_driver.dart`、`tool_host_client.dart`、`wechat_approval_bridge.dart` 均为 `??`（从未提交，canary 戳 2026-11-13）。这是作者正在写的 213 三层架构 lane。**本文所有行号是本轮工作树快照，施工前必须重读现值；不得整文件覆盖任何在飞文件。**
3. **批准是两段闸**。用户批准本设计 → 仍须等在飞代码落定、与作者对齐插入点 → 才进入 P0 复现与 P1 施工。本文不授权「批准即抢改在飞文件」。

### 0.3 与 215 的分工

215 定「授权必须在执行点、ask 必须等真人、无确认面即拒绝、before-hook 不是安全门」。本文回答**在手机端现有代码里具体怎么落**：门放哪、策略真源在哪、callId 怎么贯穿、两条模式词汇怎么对齐、分几阶段、怎么测、怎么回退。

## 1. 需求五问与主诉（RUNTIME-008 / RUNTIME-007）

### 1.1 需求五问（逐条标 source，区分用户原话与我的推断）

| 问 | 答 | source |
|---|---|---|
| 谁用 | 手机 App 的用户（人工 + AI 协作者共用同一执行面）；间接是写 213 lane 的作者 | 用户「做好一个统一的方案」+ 215 §0 |
| 什么时候用 | 每一次工具/shell/文件副作用执行前，无论来自聊天、driver、AgentLoop、WeChat、原生桥 | 215 §8.1「所有入口同一执行检查」 |
| 现在的替代做法 | 授权散在聊天 UI 弹框、WeChat y/n、原生 LoopModes 安全底；driver/AgentLoop 路径无门（§2 实证） | 本轮代码实测 E-A01–E-A09 |
| 成功长什么样 | 同一个 ask 工具从**任一**入口调用都等真人批准；无确认面返回 `approval_required` 且不产生副作用；正负控制测试可证伪（§9） | 215 T05/T06/T07 + 本文 §9 |
| 不做会怎样 | 最危险的提权/不可逆动作恰好走无门路径裸奔；「已授权」是 UI 假象 | 本轮实测：driver 路径绕过聊天门 |

> **诚实标注**：用户要的是「其中某一块的可开工方案，批准再执行」。**先做授权块（而非账本迁移）是我的推荐**，依据是 215 自身把 P1 授权排在 P2 数据之前、且授权是其余一切的地基；用户以「要」接受了我的提议，但未逐字点名「授权」。若用户更想先做账本迁移，本文让位。

### 1.2 主诉（RUNTIME-007：先看病，不直接说病因）

谁：手机 App 用户。条件：当工具调用不是走聊天界面手动工具循环、而是走 driver / AgentLoop / ToolHostClient 路径时。现象：声明了「需询问」的工具或危险命令**没有弹出任何确认就执行了**，而聊天界面同一工具会弹框。复现规格见 §8（本文只出规格，未执行）。

## 2. 验证过的现状：授权面碎片化地图

以下每条本轮亲自读代码核实（非转述搜索摘要）。行号是工作树快照，施工前重核。

### 2.1 执行路径与各自的门（E-A01–E-A09）

| ID | 路径 | 确切位置 | 今天的门 | 判定 |
|---|---|---|---|---|
| E-A01 | 基础引擎执行点 | [tool_engine.dart:150](../../../delivery/mobile/khy-os-client-app/lib/core/tools/tool_engine.dart#L150)–202 | `canExecute` 只拒 `deny`（:140）；`ask` 不拦；before/after hook `catch(_){}` 吞异常（:183/:198） | **ask 形同虚设**（引擎层） |
| E-A02 | 聊天手动工具循环（非流式） | [chat_screen_new.dart:810](../../../delivery/mobile/khy-os-client-app/lib/ui/screens/chat_screen_new.dart#L810)→826 | `_needsApproval`（模式→ask 声明→危险命令清单）+ `_showApprovalDialog` 后才 execute | **有门**（仅此路径） |
| E-A03 | 聊天 driver 路径 | chat_screen_new.dart:508 / 1796 / 1824 → `ToolEngineHostClient(_toolEngine)` | 经 [tool_host_client.dart:55](../../../delivery/mobile/khy-os-client-app/lib/core/toolhost/tool_host_client.dart#L55)→`_engine.execute`，**不过 `_needsApproval`** | **无门**（普通引擎） |
| E-A04 | AgentLoop（local 真机实现） | [agent_loop.dart:131](../../../delivery/mobile/khy-os-client-app/lib/core/agent/agent_loop.dart#L131) `_engine.execute` | 门 = 传进来的引擎实例；普通 `ToolEngine` 即无门 | **门取决于实例** |
| E-A05 | WeChat runner | [wechat_task_runner.dart:154](../../../delivery/mobile/khy-os-client-app/lib/core/wechat/wechat_task_runner.dart#L154) `ApprovalGatedToolEngine` → AgentLoop:245 | [wechat_approval_bridge.dart:223](../../../delivery/mobile/khy-os-client-app/lib/core/wechat/wechat_approval_bridge.dart#L223) override execute，ask 走 y/n，超时拒绝 | **有门**（唯一用到该子类的地方） |
| E-A06 | 其它普通引擎构造点 | tools_hub_screen.dart:43、agent_screen_new.dart:57、longcat_chat_screen.dart:73 均 `ToolEngine()` | 各自是否有 UI 门**本轮未逐一核实** | **待 P0 逐路径核**（不臆断） |
| E-A07 | amoo 原生拦截循环 | [LoopModes.java:42](../../../delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/LoopModes.java#L42) `decide` + 安全底 | 模式闸 + **模式无关安全底**（BYPASS 也否决不可逆）；`defaultMode()=BYPASS`（:224） | **有门**（独立词汇） |
| E-A08 | 原生 shell 准入 | MainActivity.kt:1556 `isCommandAllowed` → [ShellCommandPolicy.kt:21](../../../delivery/mobile/khy-os-client-app/android/app/src/main/kotlin/com/khyos/khy_os_client/ShellCommandPolicy.kt#L21) | 纯函数：控制符整体拒 + deny/allow + 形状层（`rm -rf /` 变体） | **有门**（可复用） |
| E-A09 | pc-bridge 远端 | [pc_bridge_driver.dart:71](../../../delivery/mobile/khy-os-client-app/lib/core/drivers/pc_bridge_driver.dart#L71) | 纯聊天流：只映射 content/reasoning/done/error，**不发工具事件、不调本地工具** | 远端工具执行路径**尚不存在** |

### 2.2 策略真源散落（E-A10–E-A13）

| ID | 策略载体 | 位置 | 内容 |
|---|---|---|---|
| E-A10 | Dart 工具声明 | [vision_tools.dart:96](../../../delivery/mobile/khy-os-client-app/lib/core/tools/vision_tools.dart#L96) | **全 App 只有 `vision_tap` 声明 `ask`**；`builtin_tools.dart` 无 `permission:` 字段（全默认 auto）；无任何工具声明 deny |
| E-A11 | Dart 模式层 | [permission_mode.dart:32](../../../delivery/mobile/khy-os-client-app/lib/core/config/permission_mode.dart#L32) | `prompt/auto/bypass/remoteApproval`，wire 名对齐桌面；`bypass` 只 waive khy-os 自己的提示，不 waive OS 同意 |
| E-A12 | 原生风险名单 | LoopModes.java:63/96 | `HIGH_RISK_TOOLS{exec,rm}` + `IRREVERSIBLE_TOOLS{secret_*,adou_signin,amoo_*}`；与 Dart 模式词汇**不同步** |
| E-A13 | canonical 目录 | [ATOMIC-CAPABILITIES.json](../../../docs/10_规范/registry/ATOMIC-CAPABILITIES.json) | 135 能力，**无 risk/permission 字段**（实测 capability 级零风险键）；是名/接口注册表，不是策略表；真源 = [atomicCapabilityRegistry.js:55](../../../scripts/lib/atomicCapabilityRegistry.js#L55) `ATOMIC_GROUPS`（人工维护，生成物勿手改） |

### 2.3 由此确认的缺口（本文要闭合的）

1. **默认路径无单一 choke point**：`ApprovalGatedToolEngine` 是对的形（override execute 是唯一必经点），但只在 WeChat 用；基础引擎只拒 deny，hook 能观察不能拦。
2. **driver / AgentLoop 绕过聊天门**（E-A03/E-A04）：同一个 `_toolEngine` 手动循环有门、host client 路径无门。
3. **callId 接收即丢**：[tool_host_client.dart:58](../../../delivery/mobile/khy-os-client-app/lib/core/toolhost/tool_host_client.dart#L58) `invoke(...callId)` 调 `_engine.execute(name,args)` 不带 callId，原生拿不到（215 E05）。
4. **无审批事件**：[driver_event.dart](../../../delivery/mobile/khy-os-client-app/lib/core/drivers/driver_event.dart) 七个子类无 `approval_required`；该词只是 amoo 桥字符串常量。
5. **两套模式词汇不同步**：Dart `PermissionMode` vs 原生 `LoopModes.Mode`（E-A11/E-A12）。
6. **无持久授权**：只有内存 `_approvedThisSession` Set 与 WeChat 单槽；无 grantRef/expiry 落盘（持久账本属下一块 P2）。
7. **风险策略无单一真源**：散在 UI 危险清单 + 原生名单 + 几乎空的 Dart 声明；canonical 目录不带风险档。
8. **local_driver 文档与代码不符**：[local_driver.dart:30](../../../delivery/mobile/khy-os-client-app/lib/core/drivers/local_driver.dart#L30) 注释称「工具调用经 ToolHostClient」，实际包 AgentLoop（工具已在 :131 执行），`DriverToolCall` 是**事后通知**不是执行请求。

## 3. 目标架构

**一句话**：把「ask 在执行点等真人」从 WeChat 子类的特例，提升为**所有 Dart 执行路径必经的单一 choke point**；策略档从 canonical 单一真源派生；原生既有安全底/壳闸保留为执行点复验；callId 贯穿；无确认面一律 fail-closed。

### 3.1 单一 choke point（复用既有形，不另造引擎）

把 `ApprovalGatedToolEngine` 的 execute-override 门**下沉进基础 `ToolEngine.execute`**，由可注入的 `AuthorizationGate` 承担：

- `ToolEngine.execute` 在 `canExecute`（deny）之后、`tool.execute` 之前，调 `gate.authorize(call)`。
- `AuthorizationGate` 持有一个 `ApprovalChannel?`（抽象审批面）与策略查询。WeChat 的 y/n、聊天弹框、远端审批单都是 `ApprovalChannel` 的实现，**不再是各自的 execute override**。
- 决策 `allow` → 执行；`ask` → 经 channel 等真人；`deny` → 拒；**`ask` 但无 channel/无确认面 → 返回 `approval_required` 失败，绝不降级 allow**。
- before/after hook 维持**只观察**语义（吞异常可以），但**不承担授权**——门在 hook 之前的独立判定里。这直接闭合 E-A01。

> 为什么下沉而不是再叠一个子类：现有 `ApprovalGatedToolEngine` 与基础引擎是两条 execute，driver 路径拿到的是基础引擎就漏。单一 choke point 才能让 E-A02–E-A06 所有路径同门。下沉时保留 WeChat 子类作为「提供 y/n channel」的薄封装，行为不回归。

### 3.2 broker 决策契约（215 §8 的手机端落地）

```
authorize(call) -> allow | ask | deny | approval_required
call = { canonicalTool, argsDigest, caller/origin, deviceId,
         taskId, callId, grantRef?, policyVersion, privacyMode }
决策 = 系统当前允许 ∩ 应用策略(模式 + 风险档) ∩ 本调用范围 ∩ 隐私策略
```

- **canonical 名判定**：别名经 `kToolAliases` 归一后判（沿用 tool_engine.dart:151 与 wechat 子类:227 的既有规则），别名不得成为绕过 tool 自身声明的侧门。
- **argsDigest**：执行点生成规范化参数摘要；批准卡显示模型文案 ≠ 真实参数时以摘要为准；批准后参数/目标/收件人/金额/策略变化 → 原批准失效（215 §8.2）。
- **fail-closed**：未知权限档、解析失败、超时、无确认面 → deny / approval_required，留具体原因，不静默放行（闭合 E-A01 的吞异常）。
- **身份由传输入口建立**：不接收模型自填 `approved=true` / `caller=用户`（215 §6）。

### 3.3 策略单一真源（不手写第二份表）

- 在 `ATOMIC_GROUPS`（atomicCapabilityRegistry.js，人工维护语义真源）为每个 canonical 能力**增一个风险档字段**（如 `risk: read|reversible|mainScreen|external|elevated`，对齐 215 §8.2 五类），重跑生成器让 `ATOMIC-CAPABILITIES.json` 携带它。
- Dart `ToolDef.permission` 与原生 `LoopModes` 风险名单**派生/对齐**这同一份，用**跨语言黄金向量测试**钉零漂移（同一组输入 → Dart 与原生判定逐条相等）。
- 风险档是「需要人拍板」的语义（生成器注释明说机器猜不了），故**逐档归类须人确认**，不由 AI 默默定案（§6 待裁）。
- **不新增第二套健康/策略注册表**（215 §5.2）；扩展既有 canonical 目录与既有引擎。

### 3.4 两条模式词汇对齐（不静默统一）

Dart `PermissionMode{prompt,auto,bypass,remoteApproval}` 与原生 `LoopModes.Mode{BYPASS,PLAN,EDIT,DEFAULT}` 建**显式映射表** + 黄金向量，而非假装它们是一回事。关键不变式（permission_mode.dart:17–24 与 LoopModes.java:16–25 都已写死，保留）：

- `bypass`/`BYPASS` 只 waive **khy-os 自己的 ask 提示**（用户有权 waive）；
- **安全底模式无关**：不可逆/危险命令（原生 IRREVERSIBLE_TOOLS + 形状层）即使 bypass 也否决；
- **OS 同意框**（MediaProjection 等）不归任何模式管，不可 waive。

**显式映射表（2026-11-14 实测两枚举后补；非双射，按语义映不按 wire 字面值）**。Dart 侧 `permission_mode.dart:32–74`（prompt:34 / auto:42 / bypass:45 / remoteApproval:56 / asks:70 / remembersWithinSession:74 / fromWire:62）；原生侧 `LoopModes.java` 枚举:42、`decide()`:177–213、`defaultMode()`:224。

| Dart 模式（wire） | 语义 | 原生最近对应 | 非双射差异（施工须显式处理） |
|---|---|---|---|
| `prompt`（`'default'`） | 对**声明 ask** 的工具每次弹框 | `EDIT`（逐条 CONFIRM，:189） | Dart 只问「声明 ask」者；原生 EDIT 对**每条命令**都 CONFIRM，不看声明。粒度不同 |
| `auto`（`'auto'`） | 每工具每会话问一次后记住 | `DEFAULT`（低危自动/高危问，:197）+ 会话记忆 | 原生 DEFAULT **无会话记忆**，每次按风险重判；「记住」是 Dart 独有（`remembersWithinSession`:74） |
| `bypass`（`'bypass'`） | 一律不问 | `BYPASS`（不踩底则 EXECUTE，:192） | 最干净对应；两者都仍受安全底否决。Dart waive 所有 ask 声明，原生踩底仍 CONFIRM |
| `remoteApproval`（`'remote_approval'`） | 远端副作用→审批单等人、超时拒 | **无原生 Mode** | 正交维度：问「在哪问」（移到手机旁的人），非「问多少」。活在 `amoo_approval.dart`，不在 LoopModes；**不继承本地 bypass** |
| （无 Dart 对应） | — | `PLAN`（DEFER，一条不执行、清单交人审，:186） | Dart `PermissionMode` 枚举**无 plan/defer 档**；桌面有 plan，手机端此枚举没有 |
| `fromWire` 未知→`prompt`（:62 fail-closed） | 未知收敛最保守 | `null`→CONFIRM（:181 fail-closed） | 共享不变式：未知绝不 fail-open |

> ⚠ **「default」一词在两表里语义相反**（E-A11/E-A12 要防的漂移）：Dart `prompt` 的 wire 值恰是 `'default'`（=最爱问），而原生 `DEFAULT` 是「低危自动执行」（=较少问）。跨桥若按字面 `'default'` 直映原生 `DEFAULT`，会把「每次问」静默变成「低危不问」。映射必须按上表**语义**、不按 wire 字面值，黄金向量须钉死这条。

**黄金向量输入建议（断言各模式「做什么」，不预判 §6.2 是否改默认；供 §4 模式映射测试用）**：

- (Dart `bypass`, 不可逆工具如 `amoo_memory`) → 仍否决（安全底模式无关；与原生 BYPASS+floor→CONFIRM 同构）；
- (Dart `prompt` / wire `'default'`, 声明 ask 的工具) → 弹框，**不得**落成原生 DEFAULT 的自动执行；
- (原生 `PLAN`, 任意命令) → DEFER、零执行；
- (未知 mode 串) → Dart `fromWire`→prompt / 原生 `null`→CONFIRM，均 fail-closed；
- (Dart `remoteApproval`, 远端副作用) → 生成审批单等人、超时拒，**不**因本地 bypass 跳过。

`defaultMode()=BYPASS` 是否改默认是 **193 Q5 待人裁决**，本文不静默改（§6）。上表只记录各模式现值语义，不含「该不该改默认」的判断。

### 3.5 callId 贯穿与审批事件

- `ToolHostClient.invoke(callId)` → `ToolEngine.execute(callId)` → 原生桥信封 → sidecar，全程带 callId；授权决策与结果按 `(taskId, callId)` 记账（幂等键，215 §6.3）。**持久事务账本是下一块 P2**；本块只保证 callId 贯穿 + 决策可按 callId 关联，不宣称已落盘。
- 审批如何成为事件：**两条候选，须评审（§6）**——
  - (a) 新增 `DriverApprovalRequired` 事件（渲染层认识它），门在 execute 内阻塞等待时经侧通道发事件；
  - (b) 把 local_driver 改成**真正经 ToolHostClient 路由执行**（`DriverToolCall` 成为真请求 → host 门 → `DriverToolResult`），顺带闭合 E-A13 文档不符。
  - (b) 更贴 213 本意但改动 AgentLoop 较大；(a) 改动小但留「事后通知」形。本文倾向 (b) 作为目标、(a) 作为过渡，**最终由人裁**。

### 3.6 原生执行点复验（保留既有，补齐缺失）

- **保留** ShellCommandPolicy（壳准入）与 LoopModes 安全底（amoo 循环）作为原生执行点复验——它们已是纯函数/可测，不重造。
- broker 的共享策略须与这两者一致（黄金向量）。
- 其它原生入口（VfsBridge.kt、KhyAppFunctions.java、Tools.java、MainActivity.kt 的 MethodChannel 处理器）**是否已做范围复验本轮未逐一核实**，P0 须清点；缺的按同一共享策略补，不另起原生策略表（215 §8.1）。
- 原生不信任调用者自报 `via=storage`/包名/目标 display，按边界输入复验（215 §8.1）。
- **2026-11-14 实测：整个 `android/app/src/main/` 在飞**——`ShizukuServiceManager.kt` 已 ` D`（Shizuku 移除），新增 `ShellLevelPolicy.java`/`CallChain.java`/`ToolSchema.java`/`ShellSidecarProtocol.java` 等 `??`，`Vfs*`/`bridge/*` 全 ` M`；入口体量 VfsBridge.kt 1610 行、Tools.java 3362 行、MainActivity.kt 2595 行、LoopModes.java 969 行、ShellCommandPolicy.kt 271 行（KEEP 闸仍在）。这是作者 Shizuku 移除 + 213 的活跃改动面，**对移动靶做逐行安全清点会产出即刻过期的 finding**，故 P0 原生清点与 Dart 施工同门——待 lane 落定后再做，本轮只确认入口名册与 KEEP 闸存在，不宣称已复验其内部。

## 4. 确切插入点（施工前重读现值；均在飞，勿整文件覆盖）

| 改动 | 落点 | 性质 |
|---|---|---|
| 门下沉进 execute | tool_engine.dart:150–202（` M`） | 改既有执行点，保留 deny/hook 语义 |
| 抽象 ApprovalChannel + AuthorizationGate | 新增纯 Dart 文件（core/authz/）；WeChat 子类改薄封装 | 新增 + 重构 wechat_approval_bridge.dart:202（`??`） |
| callId 贯穿 | tool_host_client.dart:55–58（`??`）+ execute 签名 + 原生信封 | 增量扩字段 |
| 风险档入真源 | atomicCapabilityRegistry.js `ATOMIC_GROUPS`（` M`）→ 重跑生成器 | 改人工真源，生成物勿手改 |
| 模式映射 + 黄金向量 | 新增测试；对齐 permission_mode.dart 与 LoopModes.java（` M`） | 新增测试 |
| 审批事件 | driver_event.dart（`??`）+ local_driver.dart（`??`） | 须先定 §3.5 (a)/(b) |
| 原生入口复验清点 | VfsBridge.kt / Tools.java / AppFunctions / MainActivity.kt | P0 先清点再补 |

**新增文件优先纯 Dart 叶子**（零 IO、确定性、可 VM 测），沿用本仓 `core/config` 无 Flutter import 的约定（permission_mode.dart:29 实测）。

### 4.1 施工前重读现值（2026-11-14 实测：核心目标已在飞，架构与 §3.1 提案分叉）

> 兑现 §4「施工前重读现值」。本轮只读核实，零在飞源码改动；下列 file:line 均本轮实测，均在作者未提交工作里（`??`/` M`）。

**结论先行**：§3.1/§4/§5 提议「新增 core/authz/、把 ApprovalChannel 抽象出来、把门下沉进基础 execute」——**抽象与两个审批通道已由作者建好并在飞**，作者选的是**装饰器 + 可插拔通道**（架构 B），不是本文提议的**基础 execute 下沉**（架构 A）。任务执行管线（微信远端 + 悬浮本地）已全程过门；**残余缺口收窄到「屏幕内聊天/agent/工具台/host」几条直接 new 基础引擎的路径**。故 §6.4 已从「协调下沉时机」变为「**A/B 架构如何归并 + 残余路径谁补**」，是人 + 作者的决定，AI 不抢改、不默默定案。

> **作者此刻活跃（2026-11-14 16:43 复读实测，非 dormant）**：broker 核心真路径是 `lib/core/wechat/wechat_approval_bridge.dart`（15:43 改）与 `lib/core/floating/overlay_task_sink.dart`（**16:24 改，距复读仅 19 分钟**）——不是早先笔记误记的 `lib/core/agent/`。符号实测仍在：`ApprovalChannel`:106、`WechatApprovalBridge`:131、`ApprovalGatedToolEngine`:208、`execute`:230（较上轮 :229 漂 +1，坐实移动靶）。**残余漏门三面（chat/agent/longcat 屏 + driver host）反而是 dormant**（chat 11:07、agent 11-11、tool_host_client 11-13），与作者活跃的 broker 核心不在同一组文件。行号一律按 §0.2 快照纪律施工前重读，不追漂移。

**已在飞的既有资产（实测）**：

| 资产 | 落点 | 与本文关系 |
|---|---|---|
| `ApprovalChannel` 抽象审批契约 | wechat_approval_bridge.dart:106（`??`） | §5「抽象成通用 ApprovalChannel」**已完成** |
| `WechatApprovalBridge`（远端 y/n，120s 超时拒） | wechat_approval_bridge.dart:131（`??`） | 远端通道实现 |
| `OverlayApprovalChannel`（本地悬浮信箱，120s 超时拒，id 匹配） | lib/core/floating/overlay_task_sink.dart:113（`??`，16:24 仍在改） | **本地来源审批路径**，§3.5/§6.1 (a) 设想的「另一去向」已建 |
| `ApprovalGatedToolEngine.execute` 门（canonical 判定 + allow/deny/timeout） | wechat_approval_bridge.dart:229（`??`） | 门在装饰器，**不在基础 execute** |
| `_defaultEngineFactory` → gated 引擎 + builtin/vision 注册 | wechat_task_runner.dart:207（`??`） | §3.1「所有路径同门」在 runner 管线内已成立 |
| `ApprovalGate` 审批单状态机（request/approve/deny/expireDue/decide + 审计 + 重放安全 + 到期） | amoo_approval.dart:338（`??`） | §3.5 推迟的 **P2 账本机器已部分存在**；callId 须与其 approvalId/traceId 对齐 |

**两条来源都已过门（实测管线）**：`floating_task_hub.submitLocal`（floating_task_hub.dart:169）与微信 `_admit`（wechat_task_runner.dart:284）都汇入 `_execute`（:325）→ `_engineFactory(approval)`（:336）→ `ApprovalGatedToolEngine` → `AgentLoop(engine: gated)`（:337）。本地任务的 AgentLoop 拿到的是**带门引擎**，不是基础引擎。

**全执行路径门覆盖图（2026-11-14 逐路径实测；E-A02–E-A06 在 driver/agent/longcat 三面仍开）**：

| 执行路径 | 门 | 实测判定 |
|---|---|---|
| 微信远端任务 | ApprovalGatedToolEngine + WechatApprovalBridge | **有门**（B） |
| 悬浮本地任务 | ApprovalGatedToolEngine + OverlayApprovalChannel | **有门**（B） |
| 聊天 UI 直连 API 工具循环 | `_needsApproval`（chat_screen_new.dart:2917，模式感知）→ `_showApprovalDialog`（:2939）→ execute（:826） | **碎片但有门**：ask 在 UI 循环层问，不在引擎 choke point |
| **driver 路径** | `_sendViaDriver`（:502）→ `registryFor(cfg, ToolEngineHostClient(_toolEngine))`（:506-508）→ `invoke`（tool_host_client.dart:55）→ 基础 `execute`（:58） | **真漏门**：host client 只查注册名，无 ask 门、无 ApprovalChannel；基础引擎只判 deny（tool_engine.dart:173）。**且 invoke 收 callId 却丢弃**（:55 签名有、:58 不传）→ E-A13 |
| agent 屏工具循环 | `_toolEngine.execute`（agent_screen_new.dart:420），无 `_needsApproval`/弹框 | **真漏门**：直接 execute，ask 完全不问 |
| longcat 聊天工具循环 | `_toolEngine.execute`（longcat_chat_screen.dart:342 / :493），无门 | **真漏门**：两处 execute 均不问 ask |
| 工具台 | `_engine = ToolEngine()`（tools_hub_screen.dart:43），未发现 execute 调用 | 非执行路径（工具注册/管理 UI），不构成 ask 漏门 |

**A/B 裁决的关键点（§6.4）——本轮实测坐实「B 覆盖不全，三个执行面漏门」**：

- B（装饰器）覆盖 runner 两来源，但**三个执行面仍漏门**：driver（包基础引擎的 `ToolEngineHostClient`）、agent 屏（:420 直接 execute）、longcat（:342/:493 直接 execute）——故 B **不足以闭合 E-A02–E-A06**。这正是 §3.1「为什么下沉」预判的「driver 路径拿到基础引擎就漏」，本轮逐路径实测坐实并扩到 agent/longcat。**A（下沉基础 execute）一次覆盖全部漏门面；B+ 须逐面补门**——这是 A 相对 B 的实质优势，交人裁。
- 裁决因而不是「A/B 偏好」，而是「**B 对 driver 不够，三选一**」：① A＝门下沉基础 execute（driver 自动同门，但整文件改在飞 tool_engine.dart）；② B+＝让 driver 的 host client 包带门引擎，或在 `ToolHostClient.invoke` 内加门（改在飞 tool_host_client.dart，带 canary 戳 `Khy-20261113-001-P1THC`）；③ 把聊天 UI 的 `_showApprovalDialog` 降为一个 `ApprovalChannel` 实现并让 driver 共用（§5 末行）。
- **三条都要动作者在飞文件**，且**无 Dart 工具链可验**（Gate 2 未解）。故本轮不施工，只把逐路径实测交人裁。

**对本文其余节的影响**：§3.1/§5 中「抽象 ApprovalChannel」「y/n 是一个实现」等已由作者落地，阅读以本表实测为准；§3.5 的 P2 账本机器已部分存在于 `ApprovalGate`，callId 贯穿须对齐其 approvalId/traceId，不另造。

## 5. 复用既有资产（不重造）

| 既有 | 复用方式 |
|---|---|
| `ApprovalGatedToolEngine` execute-override | 门下沉的形蓝本；子类降为 y/n channel 提供者 |
| `WechatApprovalChannel` 接口 + 超时拒绝 | 抽象成通用 `ApprovalChannel`，y/n 是一个实现 |
| `PermissionMode`（wire 对齐桌面） | 应用策略的模式输入，不另造模式 |
| 原生 `LoopModes` 安全底 | 模式无关否决，保留为原生复验 |
| 原生 `ShellCommandPolicy` | 壳准入纯函数闸，保留 |
| `ATOMIC_GROUPS` / 生成 catalog | 名/接口单一真源，风险档加在这里 |
| `ToolHostClient` | driver→host 唯一门，callId 与门接在这里 |
| `_needsApproval`/`_showApprovalDialog` | 聊天弹框降为一个 ApprovalChannel 实现 |

## 6. 需显式评审的契约决定（人拍板，AI 不默默定案）

1. **审批事件 (a) 新增 DriverEvent vs (b) 重构 local_driver 经 host 路由**（§3.5）。(b) 闭合文档不符但动 AgentLoop；涉及 213「不新增端点/不改渲染层」约束的边界——新增 DriverEvent 是否算改渲染层须按 213 T2 判据核。
2. **BYPASS 默认是否改**（193 Q5 / LoopModes.defaultMode）。本文保留现状 + 安全底，不静默改默认。
3. **风险档逐能力归类**（§3.3）：135 能力的五类归属须人确认。**草案已产出**：见 [216-附1 §2–§4](<[DESIGN-ARCH-216-附1] 授权风险档分类草案与P0复现规格.md>)（135 逐个提案 + 与原生名单交叉核对，二仪器核过全覆盖）。待裁项原 11 节，现 **10 节待人裁**：§3.6 `amoo.memory` 已由原生写语义证据**定案 external**（跨源冲突闭合）；§3.1 `zip/unzip` 的事实前提（Zip Slip 防护是否存在且生效）已实测**确证**（`Tools.java:3079` 越界即 REJECT），reversible 推荐证据已足，只剩「可逆+防护 vs 保守升 external」纯策略取舍连同 193 Q5 交人。其余 9 节为纯策略判断，AI 不默默定案。
4. **门下沉对在飞 213 lane 的协调（2026-11-14 实测升级，见 §4.1）**：核心目标已由作者在飞建好——`ApprovalChannel` 抽象 + 微信/悬浮两通道 + 装饰器门 + runner 两来源全程过门；作者选**装饰器（B）**而非本文**基础 execute 下沉（A）**。残余缺口收窄到屏幕内聊天/agent/工具台/host 几条直接 new 基础引擎的路径。裁决已从「协调时机」变为「**A/B 如何归并 + 残余路径谁补**」；两条都要动在飞文件且无工具链可验，AI 不抢改、不默默定案。
5. **callId 记账与 P2 账本的边界**：本块只贯穿 + 关联，持久落盘属 P2；不在本块偷偷建第二个活存储。

## 7. 分阶段落地（PROCESS-008：新拦截机制不得直进 S3）

broker 的 **ask-在-choke-point 强制**是新拦截能力，按四阶段升阶，毕业看样本量：

| 阶段 | 行为 | 与既有门的关系 | 毕业 |
|---|---|---|---|
| S1 观察者 | broker 计算决策并**记录**，不拦；既有门（聊天/WeChat/原生底）照常生效 | 对**当前无门路径**（driver/AgentLoop）只加观察，不降低安全 | ≥200 样本、无解释不了的 |
| S2 顾问 | 记录 + 提示与既有门的分歧 | 误报率 <10%（≥50 提示） | |
| S3 门禁 | broker 强制（可豁免） | 既有门收敛为 broker 的 channel/复验 | ≥20 真实拦截、豁免 <20% |

- **S1 不阻断**（PROCESS-008 PP-3）：登记 `severity=advisory` + `executorStage` 与代码常量一致，否则守卫报 drift。
- **安全底例外**：原生模式无关安全底（不可逆命令）**不是新机制**，维持现状强制，不进 S1 观察。
- 升阶是人的决定，守卫只校验不代劳。登记表落 `FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms[]`。

## 8. 复现规格（RUNTIME-007：修复前先复现，本文只出规格未执行）

> **细化已产出**：见 [216-附1 §5](<[DESIGN-ARCH-216-附1] 授权风险档分类草案与P0复现规格.md>)——4 条复现规格锚定到本轮亲读的真实现有测试（`tool_engine_test.dart:150` 已把 ask 缺口钉成绿测试），含正/负控制与差分；**§5.2/§5.4 已用独立 Dart SDK 3.14.0 对真实源执行 PASS（15/15），§5.3 已于 2026-11-15 用 Flutter 真工具链执行 PASS（4/4，非空转）**（详见附1 §5.5 / 本文 §14.2）。

P0 须先产出 `repro-before.txt`（原始输出，非转述），证明缺口真实存在：

1. **driver 路径无门**：构造普通 `ToolEngine`（如 E-A03），注册 `vision_tap`（ask），经 `ToolEngineHostClient.invoke` 调用 → 断言**未触发任何审批即执行**（bug 现状）。
2. **AgentLoop 无门**：`AgentLoop(engine: 普通ToolEngine)` 跑一个含 ask 工具的回合 → 断言 ask 工具直接执行。
3. **正控制**：同样输入经 `ApprovalGatedToolEngine`（WeChat）→ 断言**被门拦下等待**。证明测试能区分有门/无门（不是恒绿）。
4. **callId 丢失**：`invoke(callId:'x')` → 断言原生侧/execute 收到的 callId 为空。

存证落 `works/data/khy/feedback/<task-id>/`：`complaint.md` / `repro-before.txt` / `differential.md`（≥2 候选病因）/ `repro-after.txt`（改后同命令复诊）。

> 处方最小化：本块改动若触及 ≥4 文件或 ≥3 顶层目录会触发 `fix-blast-radius` 提示；按 §4 分片，一次一片。

## 9. 验收测试规格（正负控制 + 黄金向量 + 仪器自验；细化 215 T05/06/07/19）

**待执行规格，不是已通过清单。** 每项记源码/构建指纹、设备/系统、真实入口、输入、观察到的工具请求、结果、原始日志。

| ID | 场景 | 通过判据 |
|---|---|---|
| A-T01 | 同一 ask 工具经**全部**入口（聊天手动/聊天 driver/AgentLoop/WeChat/tools hub/原生） | 均等真人批准；无确认面 → `approval_required` 且零副作用 |
| A-T02 | 审批超时/过期/参数变/目标变 | 执行拒绝；日志区分原因；不吞错后继续 |
| A-T03 | 伪造 caller / `approved=true` / 越权 via/path | 执行点拒绝；**合法正控制仍运行** |
| A-T04 | 别名 `bash`→`exec_shell` | 按 canonical 判权限，别名不绕过声明 |
| A-T05 | 相同 callId 重发 / 不同参数复用 | 前者返回原状态、后者拒绝；实际执行计数一次 |
| A-T06 | 跨语言黄金向量 | 同一组输入 Dart 与原生 broker 判定逐条相等 |
| A-T07 | 模式映射 | bypass waive ask 提示但**安全底仍否决**不可逆；OS 同意框不可 waive |
| A-T08 | sidecar 假服务占端口/旧令牌 | 双向身份失败或已撤销；不凭 PONG 标 ready（215 T19） |
| A-T09 | 风险档真源 | catalog 由生成器产出、`--check` 不漂；Dart/原生名单与真源一致 |

### 9.1 仪器本身也要验（215 §21.1）

- 真实工具目录数量 **> 0**；声明集合/实现集合/实际调用集合分别核对（数字以 `ToolCatalogTest`/守卫运行时快照为准，**不引文档字面值**——213 判据纪律）。
- 每条安全测试**同时有合法正控制与故意触犯的负控制**；**若摘掉门接线测试仍全绿，该测试不能签字**。
- 回归看**具体失败集合**，不只看错误总数相同。
- 分母是真实受测集合；无设备样本不报百分比。

## 10. 回退条件

- 每片独立可回退；broker 可禁用回退到**既有门**（聊天/WeChat/原生底），**绝不回退到无门**。
- 不回滚到公开令牌或 ask 自动放行（215 M2）。
- 门下沉若致 WeChat/聊天行为回归，先恢复子类 override 形再排查，不带病推进。
- 在飞文件改动须留可执行回滚命令（RUNTIME-009）；不整文件覆盖作者未提交工作。

## 11. 未闭合项与待人裁决

| 项 | 性质 | 处置 |
|---|---|---|
| §6 五项契约决定 | 待人拍板 | 批准本设计时一并裁，或标「先做无争议片」 |
| 在飞 213 lane 落定 | 外部依赖 | 施工前重读现值 + 与作者对齐，不抢改 |
| E-A06 其它引擎路径门 | 本轮未逐一核实 | P0 清点，不臆断有/无门 |
| 原生入口复验覆盖面 | §14.5 已 P0 清点（VfsBridge/AppFunctions/MethodChannel） | 清点毕：VfsBridge 由并行的 AiSafetyFilter/VfsPolicy 把关（非裸奔），但坐实**两套政策真源**；收口待 §6.2/§3.3 人裁 + 作者在飞 VFS lane（ai_safety/automation_runner/shell_command_guard）落定 |
| 持久授权账本 | 属 P2 下一块 | 本块只 callId 贯穿 + 关联，不建第二活存储 |
| 真机验证 | 本轮无设备测试 | 全部真机项标「待验证」，不宣称已通过 |

## 12. 与既有设计的关系

| 真源 | 关系 |
|---|---|
| [215](<[DESIGN-ARCH-215] khyos安卓统一方案-人工基座与智能执行闭环.md>) | 父方案；本文是其 P1 授权块细化，继承 §6/§8 契约 |
| [213](<[DESIGN-ARCH-213] 手机端通用执行器三层架构-ToolHost与Driver解耦.md>) | 三层架构与 ToolHostClient 门；审批事件/local 路由须按其 T2「不改渲染层」判据核 |
| [193](<[DESIGN-ARCH-193] 手机端职责划界与 amoo 原子能力复用方案.md>) | LoopModes BYPASS 默认 = Q5 待裁；本文不静默改 |
| [206](<[DESIGN-ARCH-206] Khyos 文件管理器基座重构方案.md>) | 人工/AI 共用安全边界；AI 计划制不变 |
| [194](<[DESIGN-ARCH-194] 原子能力聚合与接口目录.md>) | canonical 单一真源；风险档加在 ATOMIC_GROUPS |
| [058 细粒度权限策略](<[DESIGN-ARCH-058] 细粒度权限策略与记忆主动化引擎.md>) | **另需核对是否同一概念**（本轮未读，不臆断其内容）；若重叠则对齐不另造 |

## 13. 交付口径

本文把授权块的**验证过的缺口、目标架构、确切插入点、复用清单、待裁决定、分阶段、复现、正负控制测试、回退**放在一份可开工契约里。**方案可以完整，施工仍须用户批准 + 在飞代码落定 + 真机实证。** 本轮交付的是设计与索引，不是「授权已统一」。

下一步若获批：先做 §8 复现（P0），再按 §7 S1 观察者把 broker 接到当前无门路径并记录，与既有门并存；样本达标后人裁升阶。**不先抢改在飞文件，不先对外宣称「统一授权已完成」。**

## 14. 施工记录（2026-11-14，用户裁 B+ + 授权施工 dormant 残余面）

用户两裁：**Q1＝B+ 扩展装饰器**（复用作者在飞 `ApprovalGatedToolEngine`，不下沉基础 execute）；**Q2＝授权施工 dormant 残余面**（chat/agent/longcat 屏 + driver host），并解压 flutter SDK 尝试验证，**失败如实报、不伪造 PASS**。据此本轮已施工：

### 14.1 已落地（结构实测，grep 逐点核过）

| 件 | 路径 | 内容 |
|---|---|---|
| 新增·通道适配 | `lib/core/authz/dialog_approval_channel.dart`（`??`） | `DialogApprovalChannel implements ApprovalChannel`：把 `Future<bool> confirm(...)` 弹框回调适配成 `WechatApprovalDecision`（true→allow，false→deny，沉默≠同意）；`kGateDangerousTools`＝{exec_shell, exec_shell_elevated, android}；`gateDangerousTools(engine)` 用 `setPermission(...,ask)` 把这三件标成 ask（canonical 名，bash 别名经 kToolAliases 归到 exec_shell 一并覆盖） |
| 新增·弹框 | `lib/core/authz/tool_approval_dialog.dart`（`??`） | `showToolApprovalDialog(context,...)`：agent/longcat 此前无确认面，补 fail-closed 弹框（barrierDismissible:false，取消即拒绝） |
| chat driver 门 | `chat_screen_new.dart`（` M`，作者脏改保留） | 新增独立带门引擎 `_driverToolEngine`（:145 字段、:213-217 构造，**手动循环仍用基础 `_toolEngine` 避免双重问门**）；三处 host client :519/:1807/:1835 改包带门引擎；`_confirmDriverTool` 按「模式→危险命令过滤→`_showApprovalDialog`」判，与手动循环同序但**不查基础引擎 permission**（driver 引擎单独注册，基础引擎不知道的 ask 工具如 vision_tap 也必须问，否则会漏），复用既有 `_isDangerousCommand`/`_getToolLabel`/`_showApprovalDialog` |
| agent 屏门 | `agent_screen_new.dart`（` M`） | :60-64 `ToolEngine()`→`ApprovalGatedToolEngine`+`gateDangerousTools`；`_confirmTool`（:74）接 `showToolApprovalDialog` |
| longcat 屏门 | `longcat_chat_screen.dart`（原 clean，现 18/1 纯本轮增量） | :76-80 同上；`_confirmTool`（:87） |
| P0 复现测试 | `test/authz_residual_gate_test.dart`（`??`） | 负控制（基础引擎经 host client 裸跑 ask 工具＝bug 现状）+ 正控制（带门引擎 deny→零副作用+「用户拒绝了该操作」、allow→执行一次问一次）+ 适配器映射 + gateDangerousTools 三件标 ask + bash 别名 + **仪器自验两条**（录音回调真记录、ask 工具允许时真跑，防绿跑空转） |

**安全边界实测**：作者在飞 broker 核心**一字未动**——`wechat_approval_bridge.dart` mtime 15:43、`overlay_task_sink.dart` mtime 16:24 均未变；本轮只**实例化**其 `ApprovalGatedToolEngine`，新增件全在 `core/authz/` 与残余面。longcat 原 clean、现 numstat 18/1，坐实本轮编辑是小额增量、无整文件重写、无 LF↔CRLF 翻转。

### 14.2 验证状态：**门链运行时已验 PASS（纯 Dart 15/15 + Flutter 8 文件 authz 套件 110 测试全过，含 §5.3 AgentLoop 4/4）；Flutter 类型已验（release AOT + analyze 0 错）；仅真机待补（如实报）**

**已验（运行时，纯 Dart 门链，15/15 PASS，exit 0）**：关键发现——门链是**纯 Dart**（`tool_engine.dart` / `tool_host_client.dart` / `wechat_approval_bridge.dart` / `dialog_approval_channel.dart` 零 Flutter import），故无需 1.87GB Flutter SDK，用**独立 Dart SDK 3.14.0**（官方 `storage.googleapis.com/dart-archive`，221MB，12 路 range 并行下载拼合、解压）即可对**真实仓库源**编译运行。验证 harness `D:/Portable/dart_verify/verify.dart` 经 `package_config.json` 把 `package:khy_os_client` 映射到 `delivery/mobile/khy-os-client-app/lib/`（**无副本，直接吃在仓源**），`dart run verify.dart` 运行（真源 `tool_engine.dart:36` 用 `?sendable`；**Dart 3.14.0 stable 已把 null-aware-elements 转正**，故不再需要 `--enable-experiment=null-aware-elements`——带该 flag 反而报 `Unknown experiment` exit 254，2026-11-14 实测更正），逐条实测。**2026-11-14 对当前在仓源重跑复验（作者在飞 broker 核心，防签名漂移）：仍 15/15 PASS、exit 0、RESULT=PASS**——负控制仍红、门 deny/allow 仍绿、仪器自验非空转，门链未被作者改动破坏：

| # | 判据 | 结果 |
|---|---|---|
| 1 | **负控制**：基础 `ToolEngine` 经 `ToolEngineHostClient` 裸跑 ask 工具＝bug 现状 | PASS（effects=1，无问门） |
| 2 | B+ deny：通道恰问一次 + 返回「用户拒绝了该操作」 + **零副作用** | PASS |
| 3 | B+ allow：问一次、执行一次 | PASS |
| 4 | 适配器 true→allow / false→deny + params 透传 | PASS |
| 5 | `gateDangerousTools` 把 exec_shell/exec_shell_elevated/android 三件标 ask（前 auto） | PASS |
| 6 | 危险 shell（`rm -rf /sdcard`）deny→零副作用 | PASS |
| 7 | `bash` 别名经 kToolAliases 归一 exec_shell 且 `heldByGate` 拦截 | PASS |
| 8 | **仪器自验**：ask 工具允许时真跑（effects 探针非空转，防绿跑空） | PASS |

负控制红得起来（坐实 bug 真实存在）、正控制绿、仪器自验非空——满足 §8 P0 判据，非vacuous。另执行附1 **§5.4 callId 复现（场景 9，2 条）**：spy 确捕获 `{'k':'v'}`（非空转），`invoke(...,callId:'call_x')` 后 captured 不含 callId——坐实 [tool_host_client.dart:58](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/lib/core/toolhost/tool_host_client.dart#L58) 收 callId 即丢。**此 bug 门片不修**（callId 贯穿是 §3.5 独立项，仍待施工），本条只确认 repro-before。附1 **§5.3 AgentLoop 复现仍待 Flutter**（依赖 dio+config 链 + fake gateway，且作者在飞）。

**部分已验（语法层，dart analyze）**：用同一 Dart SDK 跑 `dart analyze`——`dialog_approval_channel.dart` **零错误**（纯 Dart，已编译运行）；`tool_approval_dialog.dart` 报 35 错**全是 Flutter 解析类**（uri_does_not_exist 1 / undefined_function 17 / undefined_identifier 10 / creation_with_non_type 6 / undefined_class 1），**零语法/parse 错**；三屏（chat/agent/longcat）亦**零 parse 错**。即本轮 UI 接线的 **Dart 语法已验有效**（分析器完整解析了文件，只缺 Flutter 框架符号），结构 grep 逐点核过（import、`ApprovalGatedToolEngine` 构造点、三处 host 站点、`_confirmTool`/`_confirmDriverTool` 回调、`gateDangerousTools`）。**2026-11-14 补齐接线类型一致性（逐读真签名，非 Flutter 编译）**：三屏引擎字段均声明为基类型 `late final ToolEngine`（[agent:38](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/lib/ui/screens/agent_screen_new.dart#L38) / [longcat:58](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/lib/ui/screens/longcat_chat_screen.dart#L58) / chat `_driverToolEngine`:145），接受 `ApprovalGatedToolEngine extends ToolEngine`（[wechat_approval_bridge.dart:208](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/lib/core/wechat/wechat_approval_bridge.dart#L208)）子类型；各 `.execute` 站点（agent:437 / longcat:359,510 / chat driver host）经基类型引用**多态分派**到装饰器 override 的门；`DialogApprovalChannel(confirm: _confirmTool)` 的 `confirm` typedef（[dialog_approval_channel.dart:14-18](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/lib/core/authz/dialog_approval_channel.dart#L14)）与两屏 `_confirmTool`（agent:74 / longcat:87）签名逐字一致，`gateDangerousTools(ToolEngine)`（:46）接受基类型。**即接线的类型一致性已由「纯 Dart 链编译 PASS + 真签名逐读」双重坐实**；Flutter 编译只剩周边 widget 代码（与本接线无关）的框架符号解析这一窄口。

**Flutter 类型已验（2026-11-15 实测升级：可用 Flutter SDK 已就位，两面分别坐实）**：先前「Flutter 类型未验」的阻塞已解除——`D:/Portable/2-tools/flutter/flutter/` 是一套**可用的 git-clone Flutter SDK**（cache 内 dart-sdk 3.13.2 + engine + flutter_tools.snapshot 齐全；先前笔记「zip 损坏 / 无 flutter dir」已过时：1.93GB `2-tools/flutter.zip` EOCD 完整，889MB `flutter_full.zip` 与 334MB stable zip 仍partial）。Flutter 类型检查由两条独立证据闭合：

> **(a) chat 屏 + 门机器：真实 release AOT 编译坐实**。一次 `flutter build apk --release` 于 **2026-11-15 00:20** 产出 [app-release.apk](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/build/app/outputs/flutter-apk/app-release.apk)（65,063,554 B，EOCD 完整，sha1 `3b26943909b2905383af23ae2e3585153c1f4e85`），三 ABI AOT 快照 `intermediates/flutter/release/{arm64-v8a,armeabi-v7a,x86_64}/app.so`（arm64 12,536,192 B，00:18）。release 依赖清单 `flutter_build.d`（268,711 B，2307 个 .dart 依赖）**逐字含** `chat_screen_new.dart` / `dialog_approval_channel.dart` / `tool_host_client.dart` / `wechat_approval_bridge.dart`。多 ABI `gen_snapshot` AOT 编译**必须先全量 kernel 类型检查通过**才产得出 app.so——故这四个文件（含本轮 B+ 接线）的 **Flutter 类型 + AOT 编译已实证通过**，非仅「语法 / parse」。所有 B+ 接线文件 mtime ≤ Nov 14 17:06，早于 00:20 构建，构建吃的是当前源。

> **(b) agent / longcat 屏：Flutter-resolved analyze 0 错**。这两屏**当前是孤儿**——全 `lib/` 唯一引用是 [tool_verdict.dart:5](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/lib/core/agent/tool_verdict.dart#L5) 的注释，**零 import、零在 release 清单**（故 (a) 的 AOT 图不含它们，不可据 APK 宣称其已编译）。改用 **Flutter cache 内 dart-sdk 3.13.2**（带已解析的 flutter/material，区别于先前缺 Flutter 的独立 SDK）对两屏跑 `dart analyze`：**0 error**，仅 10 条既有 warning/info（agent 3 条 unused_import：dns_resolver/network_autofix/built_in_keys；surfaceVariant 弃用 ×2；longcat 的 use_build_context_synchronously / prefer_interpolation / curly_braces）。**能报出 `surfaceVariant` 弃用与 `BuildContext` async-gap lint，恰证明 Flutter 框架符号已解析**（否则会是先前独立 SDK 的 undefined_identifier 错）——即两屏 widget 代码（含 B+ 接线）**Flutter 类型检查通过**。此 analyze 只读、不取 flutter-tool 锁，未干扰作者在飞构建。

**widget 运行时已验（2026-11-15，flutter test 10/10 PASS，exit 0）**：作者 release 重建（PID 38884）退出后，后台脚本 `D:/Portable/dart_verify/wait_and_flutter_test.sh` 以**真实 Flutter 工具链**（cache dart-sdk 3.13.2 + flutter_tools.snapshot `test --no-pub`）跑 [test/authz_residual_gate_test.dart](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/test/authz_residual_gate_test.dart)：**10/10 全过、FLUTTER_TEST_EXIT=0、All tests passed!**。逐条：负控制（基础引擎裸跑 ask＝bug 现状）红得起来、B+ deny→零副作用 + 拒绝、B+ allow→问一次跑一次、适配器 true→allow / false→deny + params 透传、gateDangerousTools 三件标 ask、危险 shell deny 零副作用、bash 别名归一 exec_shell 且 heldByGate、**仪器自验两条**（recording confirm 真记录、effects 探针真跑——证绿跑非空转）、callId repro-before（host client 收即丢，门片不修）。**至此 SDK 级类型 + 运行时验证全部闭合**（纯 Dart 门链 15/15 + Flutter widget-test 10/10 + release AOT 编译 + Flutter-resolved analyze 0 错）。

**广义 authz 契约套件 + §5.3 AgentLoop 复现已验（2026-11-15，8 文件逐单独 invocation，110 测试全过、各 exit 0）**：作者 flutter 测试进程退出后，后台脚本以真实 Flutter 工具链逐个跑（每文件单独一次 `test --no-pub`，跑前删可再生 `build/unit_test_assets/NativeAssetsManifest.json`）：

| 测试文件 | 测试数 | exit |
|---|---|---|
| permission_mode_test | 17 | 0 |
| tool_engine_test | 29 | 0 |
| wechat_approval_bridge_test | 20 | 0 |
| overlay_approval_channel_test | 4 | 0 |
| wechat_task_runner_test | 20 | 0 |
| zen_gate_wire_test | 6 | 0 |
| authz_residual_gate_test（B+ 门） | 10 | 0 |
| **authz_agentloop_gate_test（附1 §5.3）** | 4 | 0 |

**§5.3 AgentLoop 复现非空转**：新建 [test/authz_agentloop_gate_test.dart](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/test/authz_agentloop_gate_test.dart) 用本地 fake LLM `HttpServer` 驱动真实 `AgentLoop.run` 工具回合，4/4——负控制（普通引擎经 AgentLoop 裸跑 ask 工具 effects=`['ran:probe']`，坐实 AgentLoop 自身无门）、deny（带门引擎 confirm 问一次 + 零副作用）、allow（问一次跑一次）、**仪器自验**（effects 非空 + 到达 `AgentPhase.executing`，防绿跑空转）。只读作者在飞 `agent_loop.dart`（` M`）不改。**更正前轮过度保守**：前轮记「ZenGate 须 identity/HMAC、fake gateway 非平凡、纯 Dart 编不动」——实测 [zen_gate.dart:476](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/lib/core/gateway/zen_gate.dart#L476) 非 Zen 端点路就是裸 `dio.post`，本地 HttpServer 即可驱动，`flutter test` 真工具链可编。

**⚠ 部分绿陷阱已纠（如实报）**：首次把 8 文件塞进**一次** `flutter test` invocation，flutter_tools 在 Windows 拷 `NativeAssetsManifest.json` 到已存在目标抛 `PathExistsException`（errno 183）崩溃，只有 4/8 文件真跑、却报「110 All tests passed」——**这是部分绿，不采信**。改每文件单独 invocation + 删陈旧 manifest 后，8/8 文件各自干净跑通（上表），才是权威记录。教训：多文件合跑的「全过」可能是崩溃截断后的部分绿，须逐文件单独复核。

**仍未验（真机，不伪造 PASS）**：**真机运行时**无设备，按 §11 标「待验证」——flutter test 是 host 侧 widget 测试，不等于真机上「授权弹窗→执行→拒绝」的端到端实证。

**结论**：B+ 的**安全关键授权逻辑（单一 choke point + 策略强制 + 别名归一 + deny 零副作用）已运行时实证 PASS（纯 Dart 15/15 + Flutter 8 文件 authz 套件 110 测试全过，均 exit 0、含负控制与仪器自验非空转）**，附1 §5.2/§5.4/§5.3 P0 复现均已执行（§5.3 AgentLoop 4/4，本地 fake LLM 驱动真回合）；UI 接线 **Flutter 类型已验**——chat + 门机器经真实 release AOT 编译（00:20 APK，三 ABI app.so，清单逐字含），agent/longcat（孤儿屏）经 Flutter-resolved `dart analyze` 0 错。**SDK 级类型 + 运行时验证全部闭合**。**仍不宣称「授权已统一 / 真机已验」**——真机端到端无设备仍是开口；策略单一真源的收口仍待 §6 人裁 + 作者在飞 lane 落定。

### 14.3 全执行点门覆盖审计（2026-11-14，grep 全 `lib/` 逐点核过）

为确认 B+ 施工**无遗漏残余面**，对全 `lib/` 的每一个工具 `.execute(` 调用点做了穷举分类（非工具执行点——`db.execute` SQLite、`SkillExecutor.execute`、`AiPlanExecutor.execute`——不在授权面，略）：

| 执行点 | 引擎来源 | 门 | 归属 |
|---|---|---|---|
| [chat_screen_new.dart:837](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/lib/ui/screens/chat_screen_new.dart#L837) 手动循环 | 基础 `_toolEngine`（:211） | **既有内联门**：:821 `_needsApproval`→`_showApprovalDialog`；`_needsApproval`（:2956）对 `PermissionLevel.ask` 返回 true，对 exec_shell/elevated/android 走 `_isDangerousCommand`（:2968） | 作者既有 ✓ |
| chat_screen_new.dart:519/1807/1835 driver host | `_driverToolEngine`＝ApprovalGatedToolEngine（:213）+gateDangerousTools（:217） | 装饰器 + `_confirmDriverTool`（:2932） | **本轮 B+ ✓** |
| [agent_screen_new.dart:437](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/lib/ui/screens/agent_screen_new.dart#L437) | `_toolEngine`＝ApprovalGatedToolEngine（:60）+gateDangerousTools（:64） | 装饰器 + `_confirmTool`（:74） | **本轮 B+ ✓** |
| [longcat_chat_screen.dart:359](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/lib/ui/screens/longcat_chat_screen.dart#L359)/:510 | `_toolEngine`＝ApprovalGatedToolEngine（:76）+gateDangerousTools（:80） | 装饰器 + `_confirmTool`（:87） | **本轮 B+ ✓** |
| [agent_loop.dart:131](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/lib/core/agent/agent_loop.dart#L131) AgentLoop 类 | 注入 `_engine`；唯一构造点 [wechat_task_runner.dart:337](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/lib/core/wechat/wechat_task_runner.dart#L337) 喂 `_engineFactory(approval)` | 工厂类型**锁死** `ApprovalGatedToolEngine Function(ApprovalChannel)`（:198），默认工厂 :207 建带门引擎；**通道非空转已核**：微信路传真 `WechatApprovalBridge(sendPrompt:…transport.send)`（:167/:285），本地路 `submitLocal` 的 `ApprovalChannel` 是必传参（:296，OverlayApprovalChannel） | 作者既有 ✓ |
| [tool_host_client.dart:58](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/lib/core/toolhost/tool_host_client.dart#L58) | 被包 `_engine` | 当且仅当被包引擎带门即带门（chat 三处均传带门引擎） | choke point ✓ |
| wechat_approval_bridge.dart:251 `super.execute` / tool_engine.dart:189 `tool.execute` | 装饰器 allow 路径 / 基础 dispatch 底座 | 门内 | 核心 ✓ |

**两个一度疑似漏门、核实后确认无需补的点**：

1. **工具台 [tools_hub_screen.dart:43](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/lib/ui/screens/tools_hub_screen.dart#L43) `_engine = ToolEngine()`**：全文 `_engine` 仅三处用——:44 `registerAll`、:138 `allTools.length`、:154 `allTools`（只读清单展示）。**零 `.execute(`、零 `ToolEngineHostClient` 包裹**。它是「工具与智能体总览」的**只读目录页**，没有任何执行路径，补门等于门一个不存在的执行——故**正确地不补**（补了反而是超出任务需要的抽象）。
2. **chat 手动循环基础引擎（:211）**：一度记为「避免双重问门」，本轮**对真实代码核实**——:821 确有内联 `_needsApproval`+`_showApprovalDialog` 门，ask 工具与危险命令都问。基础引擎**不**再套装饰器是对的：套了会对同一工具问两次。

**一个如实上报的观察（作者在飞核心，本轮不编辑）**：wechat/AgentLoop 路径的默认工厂 [wechat_task_runner.dart:207](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/lib/core/wechat/wechat_task_runner.dart#L207) 注册 builtin+vision 工具并套 ApprovalGatedToolEngine，但**不调 `gateDangerousTools`**。因 `ToolDef.permission` 默认 `auto`（[tool_engine.dart:55](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/lib/core/tools/tool_engine.dart#L55)）、builtin_tools.dart **零 `permission:` 声明**，故 exec_shell/exec_shell_elevated/android 在该路径是 **auto→不走 ask 审批**，仅靠工具级命令白名单（`am/pm/dumpsys/settings/input`）约束；而 `vision_tap` 是 ask（[vision_tools.dart:104](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/lib/core/tools/vision_tools.dart#L104)，经 builtin_tools.dart:1055 spread 进各面）故各路径都问。**即危险 shell 的审批策略在 UI 面（本轮 B+ 标 ask）与 wechat 面（白名单only）之间不一致**——这正是 §3「策略单一真源」尚未完全收口的体现。该文件是作者活跃核心（mtime 今日），**在 Q2 授权范围外，本轮只上报不编辑**，留作者/用户裁：是否给 wechat 工厂也接 `gateDangerousTools`，或确认白名单only 是远程路径的有意设计。

**审计结论**：本轮 B+ 授权范围内的 dormant 残余面（chat driver host / agent / longcat）**门覆盖完整、无遗漏**；手动 chat 循环与 AgentLoop/wechat 管线由作者既有机制覆盖；工具台无执行路径。唯一策略不一致点在作者在飞 wechat 工厂，已如实上报、不在本轮施工范围。

### 14.4 跨语言模式词汇分歧（§4 行5「模式映射」的只读清点，实测；对齐施工待 §6.2/§3.3 人裁）

兑现 §4 行5「对齐 permission_mode.dart 与 LoopModes.java」的**清点 halves**（只读，两文件均 ` M` 作者在飞，本轮不编辑）。逐字读两侧后实测：**Dart 模式层对齐的是桌面，不是原生桥；原生桥另有一套词汇与语义，二者无跨语言一致性测试**。

| 维度 | Dart [permission_mode.dart:32](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/lib/core/config/permission_mode.dart#L32) | 原生 [LoopModes.java:42](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/LoopModes.java#L42) | 分歧 |
|---|---|---|---|
| 词汇 | `default`/`auto`/`bypass`/`remote_approval` | `BYPASS`/`PLAN`/`EDIT`/`DEFAULT` | 仅 default/bypass 同名；Dart 独有 auto/remote_approval，原生独有 PLAN/EDIT |
| `default` 语义 | 对每个声明 ask 的工具都问（`asks=>this!=bypass`，:70） | DEFAULT 档低危已知工具直接 EXECUTE，仅 exec/rm/未知/踩底才 CONFIRM（:197-211） | **同名不同义** |
| 未设回退 | `fromWire(null)→prompt`（保守，问；:66） | `defaultMode()→BYPASS`（宽松，执行；:224）；但 `decide(null)→CONFIRM`（:181） | Dart 保守 vs 原生默认档宽松 |
| 对齐基准 | 桌面 `toolCallingPermissions.js`，[permission_mode_test.dart:29](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/test/permission_mode_test.dart#L29) 钉「wire names match the desktop vocabulary」 | 原生桥命令循环（Amoo loop），`LoopModesTest` 钉原生侧 | 两侧各自对齐**不同**基准，**无 Dart↔原生一致性测试** |

**关键澄清（不夸大，已在真实执行点核实）**：分歧在**模式层**（便利提示的词汇/语义），**不在危险命令底**。原生有**两层**底，本轮在真实执行点核过（兑现 §4 行7「原生入口复验清点」的 dispatch 入口）：

- **工具层 exec 危险命令底（所有入口共用）**：[Tools.java:1748](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/Tools.java#L1748) `dispatch` 对 `exec` 调 `LoopModes.execDangerReason(a)`，命中即返回 `dangerous_command_refused` 拒绝——代码与注释（:1741-1746）坐实**三条入口（Amoo 循环 / HTTP /call / 文件信箱）一次覆盖**，`rm -rf /`/mkfs/dd/reboot/pm uninstall 这类系统级破坏命令在任何入口都不执行。这是「危险命令不裸奔」的真实保证，**不是只写在注释里的承诺**。
- **Amoo 路径专用底（模式无关）**：`LoopModes.decide` 的 `floorReason`（`IRREVERSIBLE_TOOLS` 13 项 + rm 递归 + ui_type 净化，:96/:236）排在 mode switch 之前，**BYPASS 也不例外**（:192-195）。它只管 Amoo 循环这一条 `decide` 的生产调用方；HTTP/信箱是人手动驱动，**有意不套**这条（LoopModes:358-362「人自己的操作不该套 Amoo 红线」）。另核到 dispatch 还有 driver 禁用门（:1766，`DriverGate.isDisabled(...,"amoo")`，与 MainActivity 的 [amooDriverDisabled():2158](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/android/app/src/main/kotlin/com/khyos/khy_os_client/MainActivity.kt#L2158) **同一把钥匙、同一个 `"amoo"` 键**——MethodChannel 与桥 HTTP 两入口不分叉，已在两侧核实）与读出类会话预算门（:1784，ls/read/exec/cp/zip 前置字节预算）。

故 §7「安全底例外，维持现状强制」成立：危险命令底在工具层全入口强制、不可逆底在 Amoo 路径模式无关强制。模式词汇分歧**不削弱这两层底**，它只是「同一个 `default`/未设档，在 Dart 面与原生桥面承诺的**询问行为**不一致」——正是 §3.3「策略单一真源」要收口的碎片。

**已有覆盖 vs 缺口**：Dart 侧契约已被作者在飞的 `permission_mode_test.dart` **完整钉死**（wire 名、fromWire 回退、asks/remembers、声明级 honoured、AppConfig 携带、设置选择器），**无需新增 Dart 侧测试**（会重复）。缺口是**跨语言**那一根：没有测试钉「Dart 设某模式 ⇒ 原生桥同义」。该测试现在写会**红**（词汇/语义/回退三处分歧），是 §4 行5 黄金向量的 repro-before——但**对齐本身是 §6.2（BYPASS 默认是否改）+ §3.3（规范词汇）的人裁项**，且要动两个作者在飞文件，**在本轮 Q2 补门授权范围外**。本轮只把实测分歧交人裁，不抢改、不默默定案、不写一个钉死分歧却宣称对齐的测试。

### 14.5 原生入口安全底覆盖面 P0 清点（§11 row4：VfsBridge / AppFunctions / MethodChannel，2026-11-14 实测）

兑现 §11 row4「原生入口复验覆盖面 → P0 清点 VfsBridge/AppFunctions/MethodChannel」，只读、不臆断有/无门。实测结论：**VfsBridge 不是无门残余漏点，但它坐实了「策略单一真源」要收口的是两套并行系统，不只模式词汇。**

- **VfsBridge 是独立原生入口，不经 Tools.dispatch / LoopModes**：[VfsBridge.kt:190](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/android/app/src/main/kotlin/com/khyos/khy_os_client/vfs/VfsBridge.kt#L190)（clean at HEAD）有自己的 `dispatch`/`handle`（:215）， destructive ops 含 `delete`/`appUninstall`（:232）/`appDisable`/`write`/`copy`/`move`/`archiveExtract`。MainActivity 双通道接线：主 device 通道 fallthrough（[:418](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/android/app/src/main/kotlin/com/khyos/khy_os_client/MainActivity.kt#L418)）+ 专用 vfsChannel（:425）。全文**零 `Tools.dispatch` 调用**。
- **它由另一套并行安全系统把关（不是裸奔）**：VFS 的 AI 路径（`ai_plan`/`automation_runner`）经 [ai_safety.dart:81](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/lib/core/vfs/ai_safety.dart#L81) `AiSafetyFilter.checkPath`（绝对路径 + 禁写根/子树白名单）+ `checkCommand`→`ShellCommandGuard`（结构化解析 + 正则兜底两层）+ `VfsPolicy` 执行层（`advancedDataEdit`，私有目录删除判高危需逐项确认）+ 原生 `requirePath`/`resolveVia` 守卫。doctrine（ai_safety.dart:8-10）：「原生侧那道护栏是最后一道网，不是唯一一道」。
- **结构性事实：手机端有两套政策真源**——(1) 工具 broker（`ApprovalGatedToolEngine` + `LoopModes`，本轮 B+ 补门的那套）；(2) VFS AI 安全（`AiSafetyFilter` + `ShellCommandGuard` + `VfsPolicy`）。命令危险判定亦有两份实现（Dart `ShellCommandGuard` vs Java `LoopModes.execDangerReason`）。§3.3「策略单一真源」要统一的是这**两套**。
- **AppFunctions** = [KhyAppFunctions.java](file:///D:/Portable/khy-os/delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/KhyAppFunctions.java)（+ `assets/app_functions*.xml`），被 Tools.java/KhyUi.java 引用——Android AppFunctions 框架入口。
- **关键阻塞（实测 git 状态）**：VFS AI 安全 lane **作者在飞**——`ai_safety.dart` ` M`、`automation_runner.dart` ` M`、`shell_command_guard.dart` `??`（新建未提交）。故两套真源收口**既需 §6.2/§3.3 人裁（哪套是真源、如何统一），又需作者先落定这条在飞 lane**，在本轮 Q2 补门授权范围外。只清点上报，不抢改、不默默定案。
- **细化 §14.4「all entries」口径**：exec 危险命令底（Tools.dispatch:1748）覆盖的是**三条 shell 入口**（Amoo/HTTP/信箱）；VfsBridge 的**文件/应用 ops** 不经该底，由 `AiSafetyFilter`/`VfsPolicy` 这套**不同机制**把关。两者都「有门」，但**不是同一道门、不是同一套策略**——这正是单一真源要收口的碎片，不是「全入口已被同一道门覆盖」。