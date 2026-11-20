# [DESIGN-ARCH-213] 手机端通用执行器三层架构 —— Tool Host 与 Driver 解耦

> 状态：设计稿（待评审）；修订 r2——定量基线全部锚定 commit `4424c00d` + 工作区改动，判据去文档字面值化（§0 锚定声明、§7 T1），补 amoo HTTP 主路径与 pc-bridge 的请求层区分（§2.5），T2 加白名单外文件缓冲条款
> 对象：`delivery/mobile/khy-os-client-app/`（khy_os_client 1.1.17+2，pubspec.yaml:1,4）
> 前序：[DESIGN-ARCH-193]（手机端职责划界）、[DESIGN-ARCH-194]（原子能力聚合与接口目录）、[DESIGN-ARCH-195]（插件 Skill-MCP 选型）、[DESIGN-ARCH-196]（沙箱直连选型）
> 本文裁决范围：手机端 APK 的 **Tool Host / Driver Layer / Render Layer 三层单向依赖**、Driver 统一接口与四个实现、能力注册表唯一真相、通用会话格式与迁移、amoo 一键禁用 / 崩溃隔离 / 首次运行自建 / 渲染三档降级、T1–T7 判定方案。

---

## 0. 定位

khy-os 手机端 APK 是**通用执行器**，不是任何助手的客户端。amoo 只是 driver 之一，与
`local`（本机 Qwen3-VL）、`pc-bridge`（既有 127.0.0.1 桥）、`script`（本地脚本）并列。
移除或禁用任一 driver，执行器功能不得降级。**核心资产是工具契约与能力注册表，不是某条会话链路。**

**定量基线锚定声明**：本文所有硬数字（工具数/孤儿名/暴露名）**只对标注的树快照负责，
不承诺跨工作区稳定**。三轮实测已经证明同一数字会随未提交改动漂移（NAMES：勘察 50 →
上轮修订 51 → 本轮 50），根因是把基线钉在了移动的工作树上。修法：每个数字旁标注
树快照锚点；T1 等验收判据**不得引用本文档字面数字**，一律以测试运行时
`ToolCatalogTest`/守卫的注册表快照为准（§7 T1）。本稿数字的锚点 =
commit `4424c00d8234ab953b8878345327c4a9b861dc02`（分支 `feat/thinking-fold-20261103`）
+ 其未提交工作区改动（`git status --porcelain` 实测 `Tools.java` 为 M）。

勘察与历轮实测基线（本稿定稿时点实测，见 §10 证据表）：

| 事实 | 落点 | 实测方式 |
| --- | --- | --- |
| 桥工具 **50** 个（锚点树实测；历轮漂移：勘察 50 → 上轮 51 → 本稿 50，上轮多出的 `elevation_bootstrap` 已被工作区未提交改动移出 NAMES，`git status` 实测 Tools.java 为 M），NAMES/CATALOG/ROUTING 三表在 Tools.java | `android/.../bridge/Tools.java:199`（NAMES）、`:238`（CATALOG） | 正则提取 NAMES 数组逐项计数：50 项、50 distinct，含 loop_start/loop_stop/loop_status/amoo_ask/amoo_result/amoo_memory/amoo_stop；三表双向钉死由 `ToolCatalogTest.java` 守卫 |
| AppFunctions 11 个 | `bridge/KhyAppFunctions.java:91`（EXPOSED） | 同上 |
| Flutter 内置工具 **33** 个 ToolDef（历轮复核三次均为 33，未见漂移），含 `elevation_status`（:462）与 `amoo_ask`（:982） | `lib/core/tools/builtin_tools.dart` | 全文含 `name:` 的行有 34 处，但 :645 的 `Skill(name: '', ...)` 是 execute_skill 实现里的构造调用、非 ToolDef——ToolDef 计 33，与 4 空格缩进正则计数（33 distinct）一致 |
| amoo 与渲染层耦合点 ≥14 处 | `lib/ui/screens/chat_screen_new.dart:107,198,213-218`（_amooAvailable/_probeAmoo，实测行号）等，全清单见 [勘察 JSON 的 amooCoupling 节] | 本会话抽查了 4 处关键行号，全部与勘察一致 |
| 桥根目录以 amoo 命名 | `bridge/BridgeService.java:43`（`BRIDGE_DIR = "/sdcard/bridge-amoobridge"`，实测行号 43） | Select-String |
| 会话落盘 FlutterSecureStorage，键 conv_<id> | `lib/core/services/conversation_db.dart:9-24`（实测 _prefix/_indexKey/_storage） | Get-Content |
| ChatTarget enum 与 kAmooModelId 耦合 | `lib/core/services/chat_target.dart:17`（`enum ChatTarget { assistant, amoo }`，Select-String 计 17；Get-Content 因换行符变体计 10，以 Select-String 为准） | Select-String + Get-Content 双读 |
| MainActivity 六个 amoo MethodChannel 方法 | `MainActivity.kt:347,352,357,358`（实测 sendToAmoo/amooAsk/amooAskResult/amooAskStop 等） | Select-String |
| 安全层正则含 amoo 通道名 | `lib/core/security/guard.dart:368`（实测 `r'amooAsk\|lastChatBlock\|amooChatService\|...'`） | Select-String |
| 本机模型 = Qwen3-VL-4B GGUF | `lib/core/services/local_model_store.dart:22-34,47`（实测类名与模型文件常量） | Select-String |
| flutter_markdown 已声明未用 | `pubspec.yaml:48,50`（实测 ^0.7.5 / ^7.2.2） | Select-String |
| 原子能力守卫当前 5 error / 16 warning，exit 1（锚点树两轮实测稳定，Summary 不随孤儿名构成漂移） | `docs/10_规范/registry/ATOMIC-CAPABILITIES.json` 落后代码 | 本会话实测 `node scripts/ci/check-atomic-capabilities.js`（详见 §10） |

仓库纪律：本文为设计文档，正文中文；不 commit/push；不 bump 版本号。

---

## 1. 三层职责与单向依赖

### 1.1 依赖方向（只许向下）

```
Render Layer（渲染）
    ↓ 只消费 DriverEvent 与通用会话格式
Driver Layer（driver_registry + 四个 driver）
    ↓ 只调用 ToolHostClient（同一份能力出口）
Tool Host（工具契约 + 能力注册表）
```

单向依赖三条铁律：

1. **Driver 不碰设备**：driver 只负责把用户意图变成对 Tool Host 的调用，不得直接操作
   设备文件与无障碍。现在 `MainActivity.kt` 的 amooAsk 先试 `AmooApexLink` 再落 `AmooLoop`
   并直接写 `/sdcard/bridge-amoobridge/amoo_pending.json`（勘察：AmooLoop.java:72-149），
   改造后驱动文件 IO 属于 Tool Host 侧的 loop 工具族，driver 只发 `amoo.ask` 语义调用。
2. **Render 不认识 driver**：渲染层只消费 `DriverEvent`（§2.3）与通用会话格式（§4），
   不 import 任何 driver 实现文件。现状反例：`chat_screen_new.dart` 的 `_probeAmoo`、
   `_askAmooFromMainInput`、`AmooTaskCard` 全部是渲染层对具体 driver 的私有知识。
3. **Tool Host 不认识 driver**：`Tools.java` dispatch 与 `KhyAppFunctions.EXPOSED`
   不出现任何 driver 名。

   > **⚠ 已知残余 gap（明知的，不是遗漏）**：现状 7 个助手循环工具名
   > （loop_start/loop_stop/loop_status/amoo_ask/amoo_result/amoo_memory/amoo_stop）
   > 在 `Tools.java` 的 NAMES 与 CATALOG 助手循环组内（NAMES 数组实测含这 7 名，
   > CATALOG 组见 Tools.java:299-307 区），且 `BridgeService.java:576` 的
   > `isReadOnlyCall` 定义、`:584` 行认识 `amoo_result`——**Tool Host 的工具面里
   > 存在 amoo 品牌名**。在 §9-Q1 裁决前，本设计交付的是「**行为解耦、名字不解耦**」：
   > dispatch 行为、调用路径、禁用门全部与 driver 解耦，但工具名字面不动
   > （改名牵动 PC 侧 amooBridgePolicy.js 跨仓契约与 ATOMIC-CAPABILITIES.json）。
   > gap 的闭合条件 = 人裁决 Q1。gap 冻结护栏：新增一条测试断言
   > `ToolCatalogTest` 侧三表中 amoo/loop 前缀工具名集合**只减不增**——Q1 未裁前
   > 不得再有品牌名进入工具面。

### 1.2 每层既有落点与新建文件

**Tool Host（几乎全是既有代码，只加一个注册表适配）**

| 载体 | 既有落点 | 新建/改动 |
| --- | --- | --- |
| 桥工具（50 个，锚点树实测，运行时以 `catalogJson()` 为准不引本文档字面值） | `Tools.java`（NAMES/CATALOG/ROUTING + dispatch） | 无结构改动；`catalogJson()`（Tools.java 已有）成为能力清单唯一机器出口 |
| AppFunctions（11 个） | `KhyAppFunctions.java:91` EXPOSED | 无结构改动；白名单 ALLOWED_CALLERS 机制不动（刻意收窄的面，KhyAppFunctions.java:36-43 注明） |
| 无障碍 / UI 能力 | `KhyAccessibilityService.kt`、`KhyUi.java` | 不动 |
| Flutter 工具面（33 个） | `lib/core/tools/builtin_tools.dart` + `tool_engine.dart:94-150` | `builtin_tools.dart:982` 的 amoo_ask 保留工具位（工具本身合理），文案去 amoo 品牌化 |
| **Dart 侧统一能力出口（新建）** | — | **`lib/core/toolhost/tool_host_client.dart`**：driver 唯一可用的调用门，方法见 §2.1 |

**Driver Layer（全新）**

| 文件 | 职责 |
| --- | --- |
| `lib/core/drivers/driver.dart` | 抽象接口（§2.2） |
| `lib/core/drivers/driver_event.dart` | 流式事件类型（§2.3） |
| `lib/core/drivers/driver_registry.dart` | 注册/发现/启停/崩溃隔离（§6.2） |
| `lib/core/drivers/amoo_driver.dart` | amoo 适配：包 MethodChannel 现有 amooAsk 两步协议 |
| `lib/core/drivers/local_driver.dart` | 本机 Qwen3-VL 适配：包 `LocalModelStore` + 既有本地推理链 |
| `lib/core/drivers/pc_bridge_driver.dart` | 既有 127.0.0.1 桥适配：包 `khyos_api.dart` 的 `streamChat`（**:293 方法本体**，实测；136 是 KhyOsApi 类定义） |
| `lib/core/drivers/script_driver.dart` | 本地脚本 driver（新增，T2 验收对象） |

**Render Layer（以重构为主，新建一个降级渲染器）**

| 文件 | 职责 |
| --- | --- |
| `chat_screen_new.dart` | **重构**：删 `_amooAvailable/_probeAmoo/_askAmooFromMainInput`、`AmooTaskCard` 第 0 格（:1483-1503 itemCount 含 amoo 卡）、模型列表的 kAmooModelId 项；`ChatTarget` 换成 `activeDriverId` |
| `lib/ui/render/content_tier.dart`（新建） | L1/L2/L3 三档降级判定与装配（§6.4） |
| `lib/ui/widgets/chat_message_row.dart` | 改造：气泡徽章按 `meta.driver` 画，不再按 `fromAmoo`（:204-213,292-312 现状） |
| `lib/ui/widgets/thinking_block.dart` / `tool_card.dart` | 不动——它们已经是通用思维链/工具卡渲染，天然属于 Render Layer |

---

## 2. Driver 统一接口与四个实现

### 2.1 ToolHostClient（Driver → Tool Host 唯一门）

```dart
abstract class ToolHostClient {
  /// 能力清单唯一真相，来自 Tool Host 注册表快照（§3），
  /// driver 不得自维护工具清单。
  List<CapabilityEntry> capabilities();

  /// 统一调用入口。name 必须在 capabilities() 返回值内，
  /// 未注册名抛 UnregisteredCapabilityError（拒绝执行，不是降级）。
  Future<ToolResult> invoke(String name, Map<String, Object?> args, {String? callId});
}
```

实现：Dart 侧包既有 `ToolEngine.execute`（tool_engine.dart:94-150）；
原生桥工具经 MethodChannel 到 `Tools.dispatch`。同一动作从两条暴露面可达时，
以 ATOMIC-CAPABILITIES.json 的 canonical 为准选一条（R-复用-1，[DESIGN-ARCH-194]）。

### 2.2 Driver 接口

```dart
abstract class Driver {
  String get id;            // 'amoo' | 'local' | 'pc-bridge' | 'script' …
  bool get enabled;         // 受设置开关 + 健康状态共同决定
  DriverHealth health();    // ok / degraded / down，供状态行显示

  Future<void> openSession(String sessionId, SessionContext ctx);
  /// 发送一轮用户输入，返回流式事件。driver 内部禁止写 UI、禁止直接碰设备。
  Stream<DriverEvent> send(UserTurn turn);
  Future<void> abort(String sessionId);
  Future<void> dispose();
}
```

### 2.3 DriverEvent（流式事件，Render Layer 的唯一输入）

```dart
sealed class DriverEvent {}
class DriverStarted   extends DriverEvent { final String sessionId; final String turnId; }
class DriverDelta     extends DriverEvent { final String kind;    // 'content' | 'reasoning'
                                            final String text; }
class DriverToolCall  extends DriverEvent { final String callId; final String name; final Map<String, Object?> args; }
class DriverToolResult extends DriverEvent { final String callId; final bool ok; final String summary; }
class DriverStatus    extends DriverEvent { final String code;  // waiting/connecting/timed_out/failed…
                                            final String detail; final int attempt; }
class DriverFinished  extends DriverEvent { final String turnId; final FinishReason reason; }
class DriverFailed    extends DriverEvent { final Object error; final bool retryable; }
```

事件字段全部是通用语义，不含任何 amoo 私有字段。`DriverStatus` 直接满足 T7 的
「明确状态 + 重试入口」：状态行由 `code + detail + attempt` 组装
（遵守 RUNTIME-002「动作+目标+进度」，例如「等待 amoo 回复 · 已 40s / 6 分钟预算」）。

### 2.4 四个实现的适配边界

| driver | 适配对象（既有） | 边界与限制 |
| --- | --- | --- |
| **amoo** | 两条既有适配路径：① HTTP 流式——`KhyOsApi` 既有三端点 `/api/auth/login`（khyos_api.dart:196）、`/api/auth/refresh`（:220）、`/api/ai/chat/stream` SSE（:311，全部实测在文）；② MethodChannel 两步协议——`amooAsk`/`amooAskResult`/`amooAskStop`（MainActivity.kt:352-358，实测）+ AmooChatService/AmooTurnStore（lib/core/services/amoo_chat_service.dart、lib/core/db/amoo_turn_store.dart） | **只用上述三端点 + 两条既有通道，不新增任何端点**（约束原文）；凭据进 App 私有目录（ApplicationDocumentsDirectory，与 amoo_turn_store.dart:38 现状一致），不写死账号；双路径到 `send()` Stream 的映射规则**逐事件定死，见 §2.5**；请求未返回只发 `DriverStatus`，**禁止本地模型生成替代回答**（不代答/不改写/不递归）。amoo_turn sqflite 库保留为该 driver 的私有状态，不进会话主链（勘察：有 amoo 必填项但不出会话链） |
| **local** | `LocalModelStore`（local_model_store.dart:47，Qwen3-VL-4B GGUF）+ 既有本地推理/AgentLoop 主链路（lib/core/agent/agent_loop.dart:52-69 run Stream） | 完全离线可用，是「必须联网不得作为启动前提」的兜底；工具调用走 ToolHostClient 同一注册表 |
| **pc-bridge** | `KhyOsApi`（khyos_api.dart:136 类定义）的 `streamChatMessage`（**:394 方法本体**，:289 是其文档注释，实测区分）走既有 127.0.0.1 桥，SSE 端点 `/api/ai/chat/stream`（:311） | 流式 delta→DriverDelta，thinking_content→DriverDelta(kind:'reasoning')（现状 _sendRemote 的映射，chat_screen_new.dart:793-856）；不新增端点 |
| **script** | 新实现：从 App 工作区目录读取用户放置的脚本定义（输入/输出约定与 DriverEvent 对齐） | T2 的验收对象——证明「新增 driver 不改渲染层」，T2 判据按 §7 限定为 **script driver 独立变更集**；脚本沙箱沿用 [DESIGN-ARCH-195] T3 的按能力 manifest 授权结论，本文不另起炉灶 |

新增一个 driver 的手续（写进 driver_registry 的文档注释）：实现 `Driver` 四方法 →
在 registry 登记 id 与 enabled 条件 → 跑 `flutter test test/drivers/`。**不需要**改
渲染层（T2 判据）与工具清单（工具属 Tool Host）。

### 2.5 amoo 双路径到 `send()` Stream 的逐事件映射（施工不得自行发明）

两条路径的分工与事件序列**在接口层定死**，这是「只用既有三端点」约束可被验收的前提：

**路径优先级与回退**：`send()` 入口先探测 HTTP 流式路径可用性（既有连接配置 +
`/api/auth/refresh` 续期成功）；可用走 ①HTTP 流式，不可用/未配置走 ②MethodChannel
两步协议。回退是**一轮内的降级决策**，发一个 `DriverStatus(code:'degraded')` 告知
用户当前走哪条路（RUNTIME-002：动作+目标+进度），此后本轮固定该路径，不逐 chunk 切换。

**amoo HTTP 主路径与 pc-bridge driver 在请求层的区分**（两 driver 复用同一端点路径
`/api/ai/chat/stream` 与同一客户端类，区分不在端点、在连接与载荷）：

1. **连接实例区分（主区分）**：每个 HTTP 型 driver 持有**独立的 `KhyOsConnection`**
   （khyos_api.dart:83）——pc-bridge 连用户配置的 khy-os 后端（127.0.0.1，凭据来自
   app_config 既有连接配置）；amoo HTTP 路径连其接入的远端，凭据经 `/api/auth/login`
   获得、refresh token 独立存 App 私有目录。baseUrl/accessToken/刷新状态互不共享，
   禁用或移除任一 driver 不触碰另一个的连接与凭据——这是「移除任一 driver 不降级」
   在请求层的结构保证。
2. **载荷区分（不改后端契约）**：`streamChat` 载荷现状只有
   `{question, conversationHistory, sessionId?}` 三键（khyos_api.dart:284-288 实测，
   **无 model 字段**），后端按 `^[a-zA-Z0-9_-]{1,64}$` 校验 sessionId
   （khyos_api.dart:265 注释实测）。amoo HTTP 轮次传 `amoo-<turnId>` 形式 sessionId、
   pc-bridge 传本机会话 id：后端落盘 `.khy/sessions` 天然按来源分命名空间，
   **不加任何新字段、不动后端**。手机侧会话的权威来源标记仍是通用格式里的
   `meta.driver`（§4.1），sessionId 前缀只是远端落盘侧的来源标记，两者不互为依赖。

**① HTTP 流式（主路径，逐块流式）**：

| 既有信号 | DriverEvent |
| --- | --- |
| `/api/auth/login`（:196）成功/续期失败 | `DriverStarted` 前置：失败→`DriverFailed(retryable:true)`，detail 指向设置入口 |
| SSE `delta`（内容块） | `DriverDelta(kind:'content')` 逐块透传 |
| SSE `thinking_content` | `DriverDelta(kind:'reasoning')` |
| SSE 工具调用事件（如有） | `DriverToolCall`/`DriverToolResult` |
| SSE 结束/连接关闭 | `DriverFinished`；异常关闭→`DriverFailed(retryable:true)` |

**② MethodChannel 两步协议（回退路径，非流式——只有状态与终态，没有中间 delta）**：

| 协议步 | DriverEvent |
| --- | --- |
| `amooAsk(text)` 调出即回 | `DriverStatus(code:'waiting', detail:'amoo 处理中', attempt:1)` |
| 每次 `amooAskResult` 轮询返回（无论有无结果） | `DriverStatus(code:'waiting', attempt:n++)`——**每次返回同时重置空闲计时器**（规则 3：活动式超时，6 分钟预算按最后一次有响应计） |
| 结果就绪（settled） | 整包回复发**一个** `DriverDelta(kind:'content')` → `DriverFinished` |
| `amooAskStop` | 发 `DriverFinished(reason:aborted)` |
| 轮询超预算/通道错误 | `DriverFailed(retryable:true)`，detail 含已等待时长与重试入口 |

两条路径共同的硬规则：**未返回期间事件流里不允许出现任何 `DriverDelta(kind:'content')`**
——T7 测试按此断言，这是「不代答」在接口层的机械化表达。②路径没有逐块输出不是缺陷
而是既有协议的形状，渲染层对「只有终态整包」的轮次按 L3 纯文本降级渲染（§5.4），
无需任何 driver 感知。

---

## 3. 能力注册表作为唯一真相

### 3.1 两条注册表，一个真相链

1. **原生三表**（NAMES/CATALOG/ROUTING，Tools.java:199/238）是桥工具的行为真源，
   `ToolCatalogTest.java` 双向钉死不漂移。
2. **`docs/10_规范/registry/ATOMIC-CAPABILITIES.json`** 是跨面原子能力真源
   （132 能力 × 6 暴露面 × **358** 暴露名——历轮漂移：勘察 351 → 上轮 359 → 本稿 358，
   全部为工作区未提交改动所致；本稿锚点树两轮实测守卫输出
   「暴露面 6 个 · 暴露名 358 个 · 原子能力 132 个」），
   **生成物勿手改**，人工维护点只有
   `scripts/lib/atomicCapabilityRegistry.js` 的 ATOMIC_GROUPS。
3. 运行时 `ToolHostClient.capabilities()` 从 `catalogJson()`（桥侧，机器生成）
   + `KhyAppFunctions.EXPOSED` + `builtin_tools.dart` 装配成 `CapabilityEntry` 列表，
   **driver 与渲染层都从这一个方法取清单**，没有任何 driver 私有清单。

### 3.2 与既有守卫的衔接

- **本设计的登记动作只发生在 ATOMIC_GROUPS**：新增 driver 不新增工具，理想情况下
  注册表零改动；若 driver 重构导致暴露面工具名变化（如 amoo_ask 泛化改名，§9-Q1），
  必须先在 ATOMIC_GROUPS 归组 → 跑 `node scripts/ci/gen-atomic-capabilities.js` →
  `node scripts/ci/check-atomic-capabilities.js` 须 exit 0，否则 PR 门必红。
- **施工前置基线（锚点树本稿实测，两轮一致）**：commit `4424c00d` + 工作区改动上
  `node scripts/ci/check-atomic-capabilities.js` → `Summary: 5 error(s), 16 warning(s)`、
  退出码 1、首行「暴露面 6 个 · 暴露名 358 个 · 原子能力 132 个」。5 个 error 为：
  backend 3 个孤儿（Calculator/gitBranch/gitSwitch）、phone-bridge 2 个
  （phone_record_audio/phone_camera_open）、phone-native 2 个
  （record_audio/camera_open）、mobile-dart 2 个（elevation_status/amoo_ask）、
  registry stale（须重跑生成器）——共 **9 个孤儿名**。历轮漂移记录：勘察 9 →
  上轮 10（多出 elevation_bootstrap）→ 本稿 9（elevation_bootstrap 已被工作区改动
  移出 NAMES，以守卫输出为准，不采信任何一轮的文档字面值）。**触及工具定义面的
  第一步施工就是按当时树重跑守卫、归组实测出的孤儿名并重新生成注册表**，此后守卫
  回绿，T3 才有干净基线。
- 既有两道闸门（orphan-exposure / interface-divergent，[DESIGN-ARCH-194]）继续生效；
  本设计不新增守卫，复用 `check-atomic-capabilities.js` 与 `ToolCatalogTest` 两条既有防线。

---

## 4. 通用会话格式与既有存储迁移

### 4.1 目标格式（唯一会话格式，任何 driver 通用）

```json
{"id":"<uuid>","session_id":"<convId>","role":"user|assistant|system|tool",
 "content":"<文本>","ts":"<ISO8601>","meta":{...}}
```

- 不掺任何 amoo 专属必填字段。现有 `ChatMessage.source`（'amoo'）与 `fromAmoo` getter
  （models.dart:38-63）**取消独立字段**，改为 `meta.driver` 可选值；
  `tool_calls`/`reasoning`（ChatMsg 现有可选字段，conversation_db.dart:196-237）
  收进 `meta`。落盘可选键缺失即无，旧数据零破坏。
- `role` 枚举 user/assistant/system/tool；driver 的 DriverStatus 不落会话（内存态），
  只在用户点「重试」时以 `role:"system"`、`meta.note:"重试于 ts"` 记一行。

### 4.2 落盘与导出

- 落盘仍走 FlutterSecureStorage 既有键 `conv_<id>`（conversation_db.dart:9-12 实测），
  但值从「Conv JSON（messages 数组）」改为 **JSONL 文本（每行一条通用消息）**。
  T4 的导出即把该值原样写文件，零转换。
- 导出显式走「会话详情 → 导出 JSONL」入口写到工作区目录；secure storage 本身外部
  工具不可读（这是它的安全属性），T4 判的是**导出产物**可解析。

### 4.3 迁移器（一次性、幂等）

`lib/core/services/conversation_migrate.dart`（新建）：

1. 启动 bootstrap（§6.3）时读 `conv_index`，逐键检查值首字节是否 `{`（旧 Conv JSON）
   还是 `{...}\n{...}`（新 JSONL——判据：首行能独立 json.loads 且含 `session_id`）；
2. 旧格式 → `Conv.fromJson` → 逐 ChatMsg 映射到通用消息（`timestamp`→`ts`、
   `tool_calls`/`reasoning` 折进 `meta`、`meta.driver` 留空）→ 写 JSONL 回同键；
3. 迁移逐键独立 try/catch，坏键跳过并留日志（app_logger.dart 既有），不阻塞启动；
4. 测试：`test/conversation_migrate_test.dart` 用现网格式样例（含 tool_calls/reasoning/
   workspaceRoot/syncState 全字段样本）钉死双向映射。

### 4.4 amoo 自有库不动

sqflite `amoo_bridge.db`（amoo_turn_store.dart:38-49）是 amoo driver 的私有状态存储，
不进会话主链、不迁移、禁用 amoo 后保留不读（数据不清，用户重开开关可恢复历史）。

---

## 5. 四项机制落地（本节对应约束的四个「怎么落地」）

### 5.1 amoo 一键禁用

- **设置面**：`settings_screen_new.dart` 现成 `_entrySwitch` 模式（勘察 :928，同段
  :672 手机桥/:747 工作悬浮框先例）新增「amoo 反代」开关，持久化进
  `AppConfigData`（app_config.dart:5-40；新增字段 `disabledDrivers: List<String>`，
  默认 `[]`，沿用 permissionMode/sessionSyncEnabled 的 wire 先例 app_config.dart:22,29）。
- **Flutter 侧执行面**：`driver_registry.enabled` 读该字段，禁用的 driver 不注册、
  不探测、不出现在模型/目标列表。
- **原生侧执行面**：与 Flutter 同名常量，`MainActivity.kt` 的 amoo 六方法路由
  （:347-358）与 `BridgeService`/`Tools.dispatch` 的助手循环工具分支加
  SharedPreferences 布尔门，形状对齐既有 `BridgeOverlayService.isEnabled/setEnabled`
  （勘察 :105-120 先例）。两个入口（MethodChannel 与桥 HTTP）都得有门——勘察明确
  KhyAppFunctions 与桥 HTTP 是两条独立入口。
- **Flutter→原生同步通道（缺此环原生门永不生效，专门立条）**：
  `BridgeOverlayService` 的先例是「被 Flutter 经 MethodChannel **显式调 setEnabled**」
  （BridgeOverlayService.java:116 setEnabled 为独立静态方法，需调用方写入），
  所以禁用开关必须带一条显式写入通道，否则 SharedPreferences 里永远没有这个键：
  1. settings 开关 onChange → 调用**新 MethodChannel 方法**
     `setDriverEnabled(driverId, enabled)`（MainActivity.kt 现有 channel 内加一个
     case 分支，与 :347-358 的 amoo 六方法同 channel）；
  2. MainActivity 侧实现：写 SharedPreferences 布尔键 `driver_disabled_<id>`
     （键名常量 Kotlin/Dart 两侧各定义一份、测试钉死一致）；
  3. 原生两道门（六方法路由 + `Tools.dispatch`/`isReadOnlyCall` 白名单同层）只读
     该键，**不做任何默认推断**——键不存在 = 未禁用（fail-open 到功能可用，与
     「禁用是例外」的语义一致；禁用写入永远经第 1 步显式发生）；
  4. App 冷启动时（configureFlutterEngine 后首个 Flutter 侧 init）Flutter 主动
     把 `disabledDrivers` 全量 re-sync 一遍（逐个 setDriverEnabled），覆盖
     「原生侧曾手动改键/清数据」的漂移。
- **探测耦合一并移除**：`_probeAmoo`（chat_screen_new.dart:213，initState 即跑，
  main.dart:288 IndexedStack 四页签同构——:264 注释原文「IndexedStack 让四个页签
  同时活着」——导致冷启动必跑）改为 registry 统一健康探测，
  amoo 禁用时零探测——这是「禁用后其余 driver 照常可用」的启动路径证据。
- **安全层耦合**：guard.dart:368 正则中的 `amooAsk|amooChatService` 随通道重构同步
  更新为通用 driver 通道名，正则覆盖面不变（仍是「不发布通道清单」的一员）。

### 5.2 单 driver 崩溃隔离

- **Flutter 侧**：每个 driver 的 `send()` Stream 在 `driver_registry` 用独立
  `runZonedGuarded` + Stream error 边界包住；driver 抛错只变成该会话的
  `DriverFailed` 事件 + 该 driver `health=down`，不冒泡到 UI、不杀进程。
- **原生侧**：`AmooLoop` 是纯静态状态机（勘察 MainActivity.kt:1692-1694，只在被调
  时才跑），其异常在 MethodChannel result 里转 error 码回 Dart，不 crash App。
- **自恢复**：registry 记录 crash 计数；`down` 的 driver 在下一次 `openSession`
  时尝试重建（惰性重启，无后台轮询）；连续 3 次失败标记 `degraded` 并在状态行
  如实显示（RUNTIME-002：动作+目标+进度，如「amoo 连续 3 次启动失败 · 可在设置中禁用或重试」）。
- **规则 3 合规**：amoo 的 6 分钟预算是活动式超时——轮询期间每次 `amooAskResult`
  返回（无论有无结果）都重置空闲计时器；不做固定时长硬 kill。

### 5.3 首次运行自建目录与默认配置

- `lib/main.dart` 既有 init（logger/crash handler/workspace bootstrap，勘察 :26-55
  零 amoo 引用）扩为 `ensureRuntimeDirs()`：
  - App 私有目录下建 `drivers/`（script driver 的脚本定义目录）与工作区目录——
    **App 首次运行自建，不预置占位文件，不写入用户专属标识**（无设备号、无账号）；
  - `AppConfigData` 键缺失时写默认值（`disabledDrivers=[]`、`permissionMode='default'`、
    `sessionSyncEnabled=true`，全部沿用 app_config.dart:39-40 现有默认），默认配置
    不含任何 amoo 条目。
- `/sdcard/bridge-amoobridge`（BridgeService.java:43）**不改名**（跨仓契约，§9-Q2），
  首次运行也**不主动创建**它——它只在用户开启手机桥/相关工具时由既有路径创建。
- 现状核对：勘察确认启动流程本就没有 amoo 必经步骤（MainActivity.configureFlutterEngine
  只做 captureIncomingText/工作根恢复/BridgeService.start），本项是把「没有」固化成
  「有守卫的没有」（T6）。

### 5.4 渲染三档降级（L1→L2→L3，全程无人工介入）

`lib/ui/render/content_tier.dart` 对每条 assistant 消息依次尝试：

| 档 | 条件 | 渲染 |
| --- | --- | --- |
| **L1 结构化** | content 能解析为约定的块序列 JSON（文本块/工具卡/思维链块——与 DriverToolCall/DriverDelta 的内存结构对齐） | 块装配：ChatBubbleRow + ToolCard + ThinkingBlock（既有 widget，已通用） |
| **L2 半结构化** | L1 失败但含 markdown 结构（标题/列表/代码栅栏） | `flutter_markdown ^0.7.5`（pubspec.yaml:48 **已声明未用**，启用不新增依赖，不违反 [DESIGN-UI.md] 的「不加 pubspec 依赖」硬约束） |
| **L3 纯文本** | L1/L2 都失败 | 现状 `SelectableText`（chat_message_row.dart:173-290），零回归风险 |

- 逐级降级由渲染器自动完成，判定失败原因只留调试日志，**不弹任何需要人工选择的对话框**。
- driver 未返回/超时/崩溃：显示 `DriverStatus` 组装的状态行（动作+目标+进度）+ 重试
  按钮，**气泡里不塞占位空文本**、不调任何其他 driver（含 local）生成替代回答。
- 新 driver（T2 的 script）产出的任何内容必然落入三档之一——这就是「新接入 driver
  不需要改渲染代码」的机制保证。

---

## 6. 文件级改动点汇总

| # | 文件 | 动作 | 层 |
| --- | --- | --- | --- |
| 1 | `lib/core/drivers/`（7 个新文件，§1.2 表） | 新建 | driver |
| 2 | `lib/core/toolhost/tool_host_client.dart` | 新建 | tool-host |
| 3 | `lib/core/render/` → `lib/ui/render/content_tier.dart` | 新建 | render |
| 4 | `chat_screen_new.dart` | 重构：删 amoo 私有知识（_probeAmoo/_askAmooFromMainInput/AmooTaskCard 第 0 格/kAmooModelId 项），ChatTarget→activeDriverId | render |
| 5 | `lib/core/services/chat_target.dart` | 改造：enum 换 driverId 字符串，删 kAmooModelId/kAmooModelName | driver |
| 6 | `lib/data/models/models.dart` | 改造：source/fromAmoo → meta.driver；新增通用消息类 | storage |
| 7 | `lib/core/services/conversation_db.dart` | 改造：落盘 JSONL + 迁移触发 | storage |
| 8 | `lib/core/services/conversation_migrate.dart` | 新建 | storage |
| 9 | `lib/core/config/app_config.dart` | 新增 disabledDrivers 字段 + 默认值 | config |
| 10 | `settings_screen_new.dart` | _entrySwitch 新增「amoo 反代」行；onChange 经 MethodChannel 调 `setDriverEnabled`（同步通道见 §5.1 第 4 条） | render |
| 11 | `MainActivity.kt` | channel 内新增 `setDriverEnabled` case（写 SharedPreferences 键 `driver_disabled_<id>`）；amoo 六方法路由加 SharedPreferences 门；不动 AMOON_* 常量与 frozen table 行号区（MainActivity.kt:2117-2121 白名单约束仍在） | tool-host |
| 12 | `BridgeService.java` / `Tools.java` | 助手循环工具分支加门（isReadOnlyCall 白名单同步）；工具名不改 | tool-host |
| 13 | `lib/core/security/guard.dart:368` | 正则同步通道改名 | other |
| 14 | `lib/core/tools/builtin_tools.dart:982` | amoo_ask 文案去品牌化（工具位保留） | tool-host |
| 15 | `scripts/lib/atomicCapabilityRegistry.js` | 归组孤儿名（锚点树实测 9 个，施工时以当时守卫输出为准，§3.2）+ 重跑生成器 | repo |
| 16 | `lib/main.dart` | ensureRuntimeDirs | bootstrap |
| 17 | `test/`（约 6 个新测试文件，§7） | 新建 | test |

不新增顶层目录、不新增 `npm run` 入口（新 Dart 测试走 flutter test，无 LAYOUT-005
构建产物登记需求——除生成器产物 ATOMIC-CAPABILITIES.json 已登记在案）。

---

## 7. T1–T7 判定方案（先写测试、红先绿后、adb 取证、四段输出）

每条测试按本仓纪律输出四段：**命令原文 / 原始输出 / 判据数值 / pass-fail-未测**。
开发顺序：先写测试看红（新测试对现状失败），实现后看绿。工具链可用性**本会话已全路径实测**（评审环境 PATH 缺失属 shell 配置，全路径均通，见 §10）：
`flutter.bat --version` → Flutter 3.47.2 / Dart 3.13.2；
`flutter.bat test test/zen_models_test.dart` → `00:00 +6: All tests passed!`，exit 0；
`adb.exe devices` → `192.168.2.46:39421` 与 `192.168.2.46:5555` 双端口在线（同一台 PZ261A / Android 16）；
`gradlew.bat --version` → Gradle 9.8.2（wrapper 实测）。
——本机可跑 flutter test 单文件与 gradlew 单测；
integration_test / 安装验证 / 断网用例依赖这台 WiFi 真机在线，属设备门控。

| # | 判定 | 测试先行（红） | 判据数值 | 本机/设备 |
| --- | --- | --- | --- | --- |
| **T1** | 禁用 amoo 后全部工具与本地模型照常 | `test/drivers/disable_test.dart`：设 disabledDrivers=['amoo'] → registry.driverIds 不含 amoo 且含 local/pc-bridge/script；`ToolCatalogTest` 与 `KhyAppFunctionsTest` 不变红→绿 | **工具数不引用本文档字面值**：判据 =「禁用前后工具数相等且等于测试运行时 `ToolCatalogTest`/`KhyAppFunctionsTest` 钉死的注册表快照」（三处真源随树漂移，历轮 NAMES 实测 50→51→50；本稿锚点树快照为 50+11+33，仅作定稿时点记录）；driver 数 = 3；local driver 可完成一轮离线会话 | 单测本机；真机「设置开关后 adb shell 调 tools/info/shot 照常返回」部分设备门控 |
| **T2** | 新增 script driver 不改渲染层即跑通会话 | **T2 在「script driver 独立变更集」内实施与验收**：该变更集只允许触及 `lib/core/drivers/**`、`lib/core/toolhost/**`、`test/drivers/**`（§6 改动表 #3/#4/#10 的渲染重构不在其内、先落或后落均行）；**缓冲条款**：白名单外文件（如需在 `lib/core/config`/`lib/core/services` 加一个目录常量或注入点）允许出现，但必须在 T2 报告中**逐个列出并说明理由**，理由仅限「script driver 读取脚本定义所必需」，出现 UI 文件即判破白名单；红 = 变更集内先写 script 会话测试 + 断言 `git diff --stat` 输出中不出现 lib/ui/ 下任何文件 | script 变更集内 lib/ui/ diff 文件数 = 0（白名单外文件数逐个有理由 = 是）；script 会话端到端 1 轮成功、内容落入 L1/L2/L3 之一；若渲染重构与 script driver 混入同一变更集，判 T2 **未测**（不许挪判据凑绿） | 本机（纯 Dart 测试） |
| **T3** | 两 driver 同时在线，注册表输出一致、同一动作只执行一次 | 注册表快照测试：amoo+local 同开 → `capabilities()` 两次调用逐项相等、无重复 id；动作幂等测试以 callId 去重计数 | 重复 id 数 = 0；同一动作执行次数 = 1；前提：§3.2 守卫归组后 exit 0（否则基线本身是红的，T3 未测） | 本机；守卫命令本机已实测当前 5 error（基线红，先归组） |
| **T4** | 导出会话 JSONL 外部工具可直接解析 | `test/conversation_migrate_test.dart` + 导出后逐行 `json.loads` 断言（测试内用 dart:convert 起码钉 schema；真机导出件用外部脚本再验） | 每行解析成功率 100%；必填字段 id/session_id/role/content/ts 齐备率 100%；role ∈ 4 枚举 | 本机（迁移测试）；真机导出件外验设备门控 |
| **T5** | 杀单个 driver 进程主功能不受影响、重启自恢复 | driver 崩溃注入测试（Dart 侧可本机）；真机：`adb shell am force-stop <amoo包>` 后主会话/local/script 照常，重开 amoo 开关自恢复 | 其他 driver 会话成功率 = 100%；amoo 重启后 health=ok；App 主进程不 crash（`adb logcat` 无 FATAL） | 崩溃注入本机；force-stop 与 logcat 取证设备门控 |
| **T6** | 全新安装无预置文件首次可用 | 单测：AppConfigData 缺键时默认值装配；真机：`adb shell pm clear com.khyos.khy_os_client` + 重装 APK → 冷启动目录/配置自建、无 amoo 预置条目 | 首次启动可用性 = 是；预置 amoo 文件数 = 0；`adb shell run-as`/ls 取证 drivers/ 由首次运行创建 | 单测本机；pm clear + 重装 + 首启取证设备门控 |
| **T7** | 断网/超时显示明确状态与重试入口、不静默代答不留空气泡 | pc-bridge driver 超时注入测试：断言事件流**末尾依次是** `DriverStatus(code:'timed_out')` → `DriverFailed(retryable:true)`（retryable 字段在 DriverFailed 上，§2.3；DriverStatus 只有 code/detail/attempt），且全程**无任何 `DriverDelta(kind:'content')`**（§2.5 两路径共同的硬规则）；UI 测试断言无空气泡 widget | 代答内容块数 = 0；状态行含 动作+目标+进度（RUNTIME-002 判据）；重试入口存在 = 是 | 超时注入本机；真机断网（WiFi off）取证设备门控 |

adb 取证纪律：设备门控用例的原始输出一律粘贴 adb 命令原文与完整回显
（getprop / logcat / run-as ls / am force-stop 返回码），不接受转述。
四段输出落 `works/data/khy/feedback/<task-id>/`（规则 5 存证位）。

---

## 8. 五条禁止事项的逐条排除

| # | 禁止 | 设计排除方式（对应节） |
| --- | --- | --- |
| 1 | 把 amoo 写死进核心路径或启动流程 | 启动链 `main.dart:26-55` 与 `MainActivity.configureFlutterEngine` 零 amoo 引用（勘察实测）；唯一启动期接触点 `_probeAmoo` 被移除（§5.1）；amoo 成为 registry 里可 enabled=false 的普通成员；T1/T6 用测试钉死 |
| 2 | 渲染层依赖某个 driver 的私有格式 | Render 唯一输入是 DriverEvent + 通用会话格式（§2.3/§4.1）；`source`/`fromAmoo` 字段删除改 meta.driver；L1/L2/L3 判定不含 driver 分支（§5.4）；T2 以「script 独立变更集内 `git diff --stat` 不含 lib/ui/ 文件」作机械判据（§7） |
| 3 | 为 amoo 单独定制工具契约或能力清单 | 工具面只有 Tools.java 三表 / KhyAppFunctions.EXPOSED / builtin_tools 三处既有真源，amoo driver 无自有清单（§3.1）；能力经 ATOMIC-CAPABILITIES 归组统一裁决（§3.2）；amoo_ask 只去品牌文案、不加私有契约 |
| 4 | 把「必须联网」作为启动前提 | local driver 完全离线（Qwen3-VL 本机 GGUF，local_model_store.dart 实测），bootstrap（§5.3）不依赖网络；T7 断网用例验证 local/script 路径照常 |
| 5 | 要求外部会话或人工准备才能使用 | 首次运行 ensureRuntimeDirs 自建一切（§5.3）；amoo 凭据进 App 私有目录由用户在设置内录入，无账号预置；T6 pm clear 后冷启动直接可用 |

---

## 9. 待拍板问题（AI 不代改，须用户裁决）

- **Q1 amoo_* 工具名是否泛化**：loop_start/loop_stop/loop_status/amoo_ask/amoo_result/
  amoo_memory/amoo_stop 七个名字进了 Tools.java 三表 + ATOMIC-CAPABILITIES.json
  + PC 侧 amooBridgePolicy.js（跨仓）。[ASSISTANT-AND-TRANSPORT-SEAMS.md] 明确
  amoo_* 三工具名不泛化、改名要人点头。本设计按「不改名」设计；若改名须同步三处
  并重跑生成器。**在 Q1 裁决前，铁律 3 的残余 gap（工具名带 amoo 品牌，§1.1）由
  「只减不增」冻结护栏看住，不视为已闭合**——本设计对此残余如实挂牌，不伪装完备。
- **Q2 /sdcard/bridge-amoobridge 是否改名**：勘察认定这是改名成本最高的一处耦合
  （PC 侧脚本、token 读取、amoo_pending/amoo_memory 三个消费方锚定该字面量，跨仓
  契约单仓改不完）。本设计不改名，但桥根以竞品品牌命名与「通用执行器」定位冲突，
  留待单独裁决。
- **Q3 守卫基线归组归属**：当前 5 error（10 孤儿名 + stale）是否由本任务施工期一并
  归组修复（本设计 §3.2 假定「是」），还是先落 driver 重构、归组另开任务——顺序
  影响每个涉及工具面的 PR 是否全绿。
- **Q4 版本递增**：driver 层重构 + 设置新增开关属用户可见功能（T1 判据），按
  R-2a/PROCESS-005 需人批 MINOR；本设计不 bump，AI 不自行递增。
- **Q5 UI 交互形态**：ChatTarget（assistant/amoo 二值 toggle + 模型列表混排 amoo 项）
  改为 driverId 后，driver 与真模型在模型选择列表是混排还是分流展示，属视觉决策
  （[DESIGN-UI.md] 霓虹果冻规范管辖），本文不定稿。

---

## 10. 本会话证据表（所有引用的实测命令与结果）

| 命令 | 结果 |
| --- | --- |
| `git rev-parse HEAD` + `git status --porcelain -- Tools.java`（本稿定稿时运行） | HEAD = `4424c00d8234ab953b8878345327c4a9b861dc02`（feat/thinking-fold-20261103）；` M ...bridge/Tools.java`（未提交修改——历轮数字漂移的直接原因，基线锚点据此标注） |
| `Get-ChildItem docs\03_DESIGN_设计\DESIGN-ARCH`（PowerShell） | 末位 [DESIGN-ARCH-212]，213 空闲 |
| 正则提取 Tools.java NAMES 数组计数（锚点树，本稿与评审两轮一致） | **50 项、50 distinct**；`elevation_bootstrap` 不在（上轮的 51 是当时的未提交改动所致，现已被移出）；含 loop_start/loop_stop/loop_status/amoo_ask/amoo_result/amoo_memory/amoo_stop |
| `Select-String builtin_tools.dart -Pattern 'name:'` 全列（历轮复核三次） | 34 行含 `name:`；其中 :645 `Skill(name: '', ...)` 为 execute_skill 内构造调用、非 ToolDef → **ToolDef = 33**（含 :462 elevation_status、:982 amoo_ask）；4 空格缩进正则计数同 33 |
| `Select-String Tools.java -Pattern 'static final String\[\] NAMES\|CATALOG ='` | `199: public static final String[] NAMES = {`、`238: static final String[][] CATALOG = {` |
| `Select-String BridgeService.java -Pattern 'BRIDGE_DIR'` | `43: public static final String BRIDGE_DIR = "/sdcard/bridge-amoobridge";` |
| `Select-String BridgeService.java -Pattern 'isReadOnlyCall\|amoo_result'` | `576: private static boolean isReadOnlyCall(...)` 定义、`584: ... tool.equals("amoo_result")`；:553 为调用点 |
| `Select-String chat_screen_new.dart -Pattern '_probeAmoo\|_amooAvailable'` | `107/198/213/217/218` 五处命中 |
| `Get-Content conversation_db.dart`（9-26、196-240 行） | _prefix='conv_'、_indexKey、FlutterSecureStorage；ChatMsg fromJson 字段与注释与勘察一致 |
| `Select-String chat_target.dart -Pattern 'enum ChatTarget'` | `17: enum ChatTarget { assistant, amoo }`（Get-Content 因换行符变体计 10，以 Select-String 为准） |
| `Get-Content khyos_api.dart`（:265-330 区） | `streamChat` 方法本体 :265，载荷仅三键 `question/conversationHistory/sessionId?`（:284-288，**无 model 字段**）、sessionId 校验 `^[a-zA-Z0-9_-]{1,64}$`（:265 注释）；`/api/auth/login` :196、`/api/auth/refresh` :220、`/api/ai/chat/stream` :311（POST）、`streamChatMessage` :394（:289 是其文档注释）、`foldEventStream` :323 |
| `Select-String main.dart -Pattern 'IndexedStack\|页签'` | `264: // ...IndexedStack 让四个页签同时活着...`（注释原文为**四**页签）、`288: IndexedStack(` |
| `Select-String amoo_chat_service.dart -Pattern 'api/\|https?://'` | 零命中——amoo_chat_service 内无端点字面量，三端点集中在 khyos_api.dart |
| `Select-String MainActivity.kt -Pattern 'AMOON_\|amooAsk\|sendToAmoo'` | 347/352/357/358 路由 + 1578-1604 AMOON_* 使用 |
| `Select-String guard.dart -Pattern 'amooAsk\|amooChatService'` | `368: r'amooAsk\|lastChatBlock\|amooChatService\|...'` |
| `Select-String local_model_store.dart -Pattern 'class \|Qwen'` | 47: class LocalModelStore；22-34 注释载明 Qwen3VL-4B GGUF 两文件 |
| `Select-String KhyAppFunctions.java -Pattern 'EXPOSED'` | `91: static final String[] EXPOSED = {` |
| `Select-String pubspec.yaml -Pattern 'flutter_markdown\|markdown\|^version\|^name'` | 48/50 依赖声明；name=khy_os_client、version 1.1.17+2 |
| `node scripts/ci/check-atomic-capabilities.js`（仓库根，锚点树两轮运行） | `Summary: 5 error(s), 16 warning(s)`，退出码 1；首行「暴露面 6 个 · 暴露名 **358** 个 · 原子能力 132 个」；孤儿名 **9 个**：Calculator/gitBranch/gitSwitch（backend）、phone_record_audio/phone_camera_open（phone-bridge）、record_audio/camera_open（phone-native，elevation_bootstrap 已移出）、elevation_status/amoo_ask（mobile-dart）；stale error 要求跑 gen-atomic-capabilities.js |
| `D:\Portable\2-tools\flutter\flutter\bin\flutter.bat --version`（全路径，历轮与评审各复跑一次，结果一致） | Flutter 3.47.2 stable（d3b14c8769）/ Dart 3.13.2 / DevTools 2.60.0 |
| `flutter.bat test test/zen_models_test.dart`（工作目录 = khy-os-client-app，历轮与评审各复跑一次） | `00:00 +6: All tests passed!`，exit 0 |
| `C:\Users\25789\AppData\Local\Android\Sdk\platform-tools\adb.exe devices`（全路径，历轮与评审各复跑一次） | `192.168.2.46:39421 device` + `192.168.2.46:5555 device`，exit 0（无模拟器） |
| `gradlew.bat --version`（android/ 目录，历轮与评审各复跑一次） | Gradle 9.8.2（Revision 8de7bcf76e） |

未运行项如实声明：本会话未执行 gradlew 单测实体跑（`:app:testDebugUnitTest` 只在勘察
期 dry-run 验证过任务图）、未执行 integration_test / flutter build apk / 真机安装与
adb 取证——§7 的 T1–T7 全部是**设计方案**而非已跑结果。本会话已把工具链可用性从
「勘察记录」升级为**本会话实测**（flutter 版本、单文件测试冒烟 6 过、adb 双端口、
gradlew wrapper），但 T1–T7 各自的测试实体仍未运行；T5/T6/T7 的真机部分与 T2 的
变更集纪律须在施工期首跑验证。
