# khy-os ↔ Amoo 集成说明

> 这份文档回答一个问题：**khy-os 手机端和 Amoo 到底怎么互相找到、互相使唤、共享记忆。**
> 它同时是模块地图——这个 App 里为 Amoo 加的东西散在七八个模块，这份文档是它们的索引。
>
> 真源原则：本文只记录**已验证**的事实。每条都标了验证方式（真机 / 单测 / 读码）。
> 未验证的一律进「未验证」节，不混进结论。

---

## 一、两边的真实形态（这是所有设计的前提）

| | khy-os | Amoo |
|---|---|---|
| 运行位置 | 手机本地，App 自身 uid | **云端**容器（3 核 / 6G / 21G） |
| 手机侧载体 | 普通第三方 APK | `AiLauncher.apk`，`/system_ext/app/`，**特权应用** |
| 智能在哪 | 无，纯执行器 | 云端；手机侧只是传话筒 |
| 能读 `/sdcard` | 能（已授 MANAGE_EXTERNAL_STORAGE） | **能**——实测往 `/sdcard/Download` 写过 apk 和 zip |
| 能读自己私有目录 | 能 | 能 |
| 能读对方私有目录 | **不能** | **不能** |
| 入站端口 | 桥 8896 只监听回环 | 不开入站端口，手机主动外连 |

**最关键的一条**：Amoo 的命令环境在云端，`/sdcard` 对它却存在（它自己演示过写入）。
这一点推翻了一个早期的错误假设——`AmooMemory.java` 的类注释里还写着
「/sdcard does not exist for it」，那句话现在是**过时且错的**，见 §五。

---

## 二、三条通道，以及各自能干什么

### 通道 A：反代对话（已通，主力）

```
你在 khy-os 里输入 → 自描述+问题写进 amoo 聊天框 → amoo 云端思考
   → khy-os 读它的最新气泡 → 显示在 khy-os 里
```

- **已真机验证**：Amoo 收到自描述后正确理解了 khy-os 是什么、分工是什么，
  并给出了准确的架构判断（它自己查出桥在线、39 工具、`khy.exec` 无接收方）。
- **代价**：回复从气泡读，所以整个等待期（实测约 6 分钟）**Amoo 必须留在前台**，
  你不能切走去用手机。这是这套方案的根本限制，不是没做优化。
- **落库**：每笔提问进 `amoo_turn` 表（见 §三），进程死了重启后知道有这么一笔。

### 通道 B：桥的 39 个工具（已通，khy-os 自己用）

`/sdcard/bridge-amoobridge/` 信箱 + 8896 回环 HTTP。三级提权链：

```
Tools.exec()  →  sidecar（uid 2000）  →  权限最高
              →  Shizuku             →  能提权，但本机未装
              →  App 自身 uid         →  「成功」返回但什么都干不了
```

- **已真机验证**：`pm install` 经 sidecar 返回 `Success`，`via:"sidecar"`。
- **`via` 字段是命门**：最后一级会"成功"返回而什么都没做。所以每个结果都必须带
  执行身份，否则界面会把没做成说成做成了。

### 通道 C：Amoo 的设备通道（半通，最有价值但未打通）

Amoo 自述有一条手机主动外连的常驻节点连接（`AgentBus`，见 dex 里 420 处引用），
云端经它有两个入口：`nodes invoke` + `ability`。它实测：

- `system.which` 有实现 → 查 `adb` 返回 `found:false`（端侧 VM 里没有 adb/pm）
- `khy.exec` → `no invoke target node`（没注册这个执行器）

**结论：桥的工具要经这条通道被 Amoo 调用，注册必须在手机侧做，云端配不了。**
这正是下一步该做的事，见 §六。

---

## 三、模块地图（为 Amoo 加的每一块在哪）

| 模块 | 路径 | 职责 |
|---|---|---|
| `Tools` | `bridge/Tools.java` | 39 个工具的派发 + `exec` 三级链 |
| `ShellSidecar` / `Client` | `bridge/ShellSidecar*.java` | 纯 Java 侧车，`dalvikvm` 拉起，uid 2000，回环 8897 |
| `HttpBridge` | `bridge/HttpBridge.java` | 8896 回环 HTTP |
| `BridgeService` | `bridge/BridgeService.java` | 前台服务；**a11y 看守在这** |
| `AmooLoop` | `bridge/AmooLoop.java` | 反代的 ask/askResult/stop 三步协议 |
| `AmooSelfDesc` | `bridge/AmooSelfDesc.java` | **注入给 Amoo 的自我介绍**（见 §四） |
| `AmooMemory` | `bridge/AmooMemory.java` | 共享记忆的数据模型 |
| `AmooTurn` / `AmooTurnStore` | `lib/core/db/amoo_turn*.dart` | 提问的 SQLite 落库 |
| `WorkspacePaths` / `Store` | `lib/core/workspace/` | 通用/专用工作空间 + 临时目录 |
| `AmooTaskCard` | `lib/ui/widgets/amoo_task_card.dart` | 反代卡片 UI |
| `ToolsHubScreen` | `lib/ui/screens/tools_hub_screen.dart` | 工具/桥/智能体三页总览 |
| `KeepAwake` | `lib/core/services/keep_awake.dart` | 屏幕常亮单一事实来源 |
| `install_apk` | `builtin_tools.dart` + `MainActivity.installApk` | 窄口安装（见 §五） |
| gelab 动作文法 | `runtime/.../phone/gelab/` | 11 个动作、0-1000 归一化坐标 |

---

## 四、注入给 Amoo 的自描述（`AmooSelfDesc`）

这是整条链的**起点**。没有它，Amoo 对 khy-os 一无所知，问什么都说"我没有这个服务"。

五节，每节都对着一次真实的失败：

| 节 | 为什么存在 |
|---|---|
| khy-os 是什么 | 否则它无法放置这个名字 |
| 可用的工具 | **从 `Tools.NAMES` 派生**，不手抄——手抄的会在加工具那一刻开始说谎 |
| 分工：你出指令，khy-os 执行 | Amoo 自己的准则禁止它做 App 内点按。点名它做不到的**具体事情**（深层目录、点开文件读）才能把"做不到"变成"交给 khy-os" |
| **你不需要连那个桥** | Amoo 曾正确指出桥在手机内部它连不到，然后**结论错了**——它以为连桥是它的活。这一节就是说清：连桥不是你的活，写命令才是 |
| 边界 | 包括一条 khy-os 也做不到的（应用私有目录），防止它承诺 |

**不注入任何内部标识符**（包名、端口、绝对路径）——Amoo 自己的红线禁止它把这些回显给用户，
喂给它就是设一个它躲不开的陷阱。测试 `renderCarriesNoInternalIdentifiers` 盯着这条。

---

## 五、已验证 / 未验证

### 已验证（真机）

| 事实 | 证据 |
|---|---|
| 反代链路通 | Amoo 收到自描述并给出准确架构判断 |
| 桥 39 工具在线 | `info` 返回 `tools` 全表 |
| sidecar uid 2000 可用 | `pm install` 返回 `Success`，`via:"sidecar" |
| **`/sdcard` 路径不能直接装** | SELinux `avc: denied … tcontext=u:object_r:fuse:s0`，必须中转 `/data/local/tmp` |
| 安装需逐包用户许可 | `usb_install_item_com.stepx.wordcraft` 从 `:0` 改 `:1` 后同一条命令从失败变 `Success` |
| 共享记忆文件 amoo 可读 | 文件在 `/sdcard/bridge-amoobridge/amoo_memory.json`，而 amoo 已证明能读 `/sdcard` |
| 工作空间自动创建 | 启动后 `/sdcard/khy-os/workspace/tmp/` 出现 |
| Amoo 的交付是真的 | `com.stepx.wordcraft` 已装、`词刻-源码.zip` 在 Download、Shizuku 确实没装 |
| 屏幕常亮 | `FLAG_KEEP_SCREEN_ON`，反代期间自动 + 手动开关 |

### 未验证 / 做不到

| 事项 | 状态 |
|---|---|
| `amoo_ask` 三步通道的端到端 | **未验**。之前的测试被一次进程崩溃打断（见下） |
| 非特权 App 能否注册 LOCAL 能力 | **未决**。这是下一步的关键，见 §六 |
| 导入 Amoo 的历史会话 | **做不到**。历史在它自己的私有目录，shell 也读不了 |
| `shot_b64` 实际 b64 大小 | 未测（设备掉线） |
| `state.provider` 子路径枚举 | 11 条路径全空 |
| **`AmooSafe` 净化器是否够用** | **未验**。`adb devices` 空，真机一次都没跑过。主机侧只有 32 个 `AmooSafeTest` + 13 个 `AmooSafeHostAuditTest`——它们证明的是**变换本身**，不是集成。 |
| `ui_type` 实际收到什么 | **未验**。`KhyUi.type` 是裸 `ACTION_SET_TEXT`，1500 字符上限由 `forAmoo` 施加而非平台。中文/多行/emoji 是否原样落地、SET_TEXT 是替换还是追加、IME 或应用自己的 text watcher 会不会改字符串——都没测过。`KhyUi` 返回的 `chars` 是**发出去**的长度，不是**到达**的长度。 |
| Amoo 读了泛化文本后还能不能行动 | **未验**，且这是个模型行为问题，主机替代不了。保留审计的预测是：**任何按路径寻址的事都做不了**——见下"已知缺陷"第 4 条。 |
| `exec` 在这台设备上实际返回哪些标识符 | **未验**。`android_id` / MAC / 局域网 IP 的缺口主机上可证明存在，但是否真泄漏取决于 Amoo 发什么命令、uid 2000 的 sidecar 返回什么。 |
| 无障碍服务能否撑过 6 分钟前台要求 | **未验**。 |
| "只在主机上验证过"能不能对外说成"已验证" | **未决，且这是人的决定**。本文档的立场是**不能**。这一行就是为这个决定留的位置。 |

### 已知缺陷

| 缺陷 | 影响 |
|---|---|
| `info` 的 sidecar 探测与 `exec` 实际路由不一致 | 三次实测：`info` 报 `false` 而 `exec` 走了 sidecar。**`elevated` 字段的可信度建立在探测准确上**，这个必须修 |
| 反代期间进程死亡则提问丢失 | 已用 `amoo_turn` 表缓解（重启后报 `interrupted`），但回复本身读不回来 |
| a11y 假死只能拉活不能预防 | 系统冻结时 `isReady()` 一直 true，已改用心跳判活（`lastEventAt`，120s 无事件算可疑） |
| ~~a11y 拉活会静默关掉别人的无障碍服务~~ | **2026-10-28 已修**。`BridgeService.reviveA11y` 原来自己拼 `settings put secure enabled_accessibility_services <本服务>`——**整体赋值**，用户同时开着 TalkBack 时一次巡检就把它关掉且无提示。同一个仓库里 `AccessibilitySetup` 的文件头把「读-改-写」列为该类存在的理由（WHY READ-MODIFY-WRITE），而看守偏偏在违反它。现在委托 `AccessibilitySetup.revive()`：consent 门控 + `addToList` 读-改-写 + 写后校验。回归锁见 `AccessibilitySetupTest.theValueTheWatchdogWritesKeepsEveryOtherService`（26 套件 439 断言全绿）。**consent 闸管的是竞态窗口**：用户在 App 内关开关时 `disable()` 清了设置，但框架要过一会儿才 unbind、`instance` 在 `onUnbind` 里才置空，这期间对象活着而事件已停，正好命中看守触发条件——没有这道闸会把刚关掉的开关三十秒内又打开。（「用户在系统设置里关掉」到不了看守：那条路同样 unbind，`wasReady` 不成立。真正的盲区在 `restoreIfConsented` 的重装路径，与看守无关。） |
| **净化后 Amoo 拿不到可寻址的真实路径** | `Tools.ls` 返回的目录是绝对路径，`write`/`stat`/`mv`/`cp` 回显 `getAbsolutePath()`——全部会被 `AmooSafe` 泛化成"工作区里的workspace"这种形态。于是 Amoo 看得见文件名，**重建不出地址**。文件类工具用 `new File(path)` 不带基目录（`Tools.java` 286/292/296/315/699/725），能不能用相对路径取决于 App 进程 cwd，主机上不可知。**已核实的例外**：`exec` 在 sidecar 和 App 兜底两条路径上都把 cwd 钉在 `/sdcard`（`Tools.java` 760/770），所以 `exec cat notes/x.md` 按构造就能解析——但 Shizuku 那条路径（817-881）不设 cwd，且 **Amoo 完全不知道有这回事**。这条要不要修、怎么修（给 `exec` 开豁免 / 在自描述里告诉它 cwd / 引入不透明句柄），是人的决定。 |
| **`ui_type` 是第二条绕过 `forAmoo` 的通道** | 围栏里发 `{"tool":"ui_type","args":{"text":"/sdcard/…"}}` 就能把**未净化的**绝对路径直接塞进 Amoo 的输入框：`AmooProtocol.parseExec` 不校验工具名，`LoopModes.floorReason` 只看 `rm`/`exec`，`isKnownTool` 对 `ui_` 前缀一律放行，BYPASS 下直接 EXECUTE，而 `KhyUi.type` 原文键入不过 `AmooSafe`。同一个洞对 PC 侧 `/call` 和信箱路径都开着。**缓解事实**（不能当修好了）：`ui_type` 只打字不点发送，而下一次 `writeBack` 会替换掉输入框内容，所以原文会一直留在框里直到人按发送。修法有三个，都不该由 AI 选：(a) 工具级净化 + 同步改 `LoopVerify.java:79` 的期望值，否则每条 `ui_type` 永远"未能验证"；(b) 循环内拒接 `ui_type`；(c) 只记录不动代码。 |
| **共享记忆被静默截断，而 Amoo 被告知不要重新测量** | `AmooMemory.renderForInjection` 到上限就 `break`，**不写任何截断标记**；外层 `forAmoo` 再按 1500 切掉尾巴。于是 14:00 验证的事实可能在 14:06 被上限丢掉，而同一句话里写着"请以此为前提，不要重新测量"。**被要求当成完整前提的是一份残缺清单**——这正是这套循环要防的 fabrication，从唯一一条本该可信的通道进来。 |
| **`android_id` / MAC / 局域网 IP 不在净化范围内** | `AmooSafe` 的范围假设标识符都从 `Tools.info` 来（它按 info 的键名锚定），但 `exec` 是第二条无界通道：`getprop ro.product.model`、`settings get secure android_id`、`ip addr` 都不匹配任何一条 pass。`AMOO-GUIDELINES.md` §4.2 管路径/包名/系统版本/架构，**§四 里没有任何一条覆盖 android_id、MAC 或局域网 IP**——所以这三项的严重程度是人的判断，不是引用条文。主机测试已把缺口钉成红灯（`AmooSafeHostAuditTest.androidIdMacAndLanIpAreNotCovered`、`execGetpropOutputIsNotCovered`），修好时**反转**断言，不要删测试。 |
| **安全底拒绝会被报成"人工中止"** | `AmooLoop` 在安全底触发时置 `st.aborted`，`describeStop` 于是对用户说"人工中止"——但那是机器拒的，不是人拒的。且 `writePending` 不把被拒命令记进 `executed`（`executeOne` 在 `executed.add` 之前就返回了），只有日志里有原因。 |
| **自描述告诉 Amoo"手机存储对你不存在"，而实测它能写** | `AmooSelfDesc.java:154` 这么写，但 §一 已实测 Amoo 往 `/sdcard/Download` 写过 apk 和 zip，`AMOO-GUIDELINES.md` 对应位置也已被标为"过时且错的"。`AmooSelfDescTest.java:164-169` 把当前这句话钉住了——改措辞会让它变红，而下一个人的本能是去改测试。**这句话每次对话都注入，改它等于改模型的认知**，所以措辞和替换后的测试断言必须由人一起定。 |

### 本表当前状态（2026-10-25 裁决）

上表五项都写明了「怎么修」或「谁来定」，但没写**现在到底怎么裁**。这一节补上：

**本轮裁决：全部维持现状（暂缓），不改代码、不改措辞。** 依据是上表自己写的约束——
`exec` 净化范围与 `android_id`/MAC/局域网 IP 的严重程度是「人的判断」，
`ui_type` 的三个修法「都不该由 AI 选」，`AmooSelfDesc` 的措辞「必须由人一起定」。
本轮把决定权交给 AI 之后，AI 仍按上表约束维持现状：**改这些要么是编造严重程度，
要么是替人改模型的认知，两样都不该由 AI 干。**

裁决记录（逐字原话 + 判据）：`works/record/evidence/01_人类贡献/决策记录.md` D-批3 第 4 条 (a)。

**这不等于「这些洞可以不管」。** 它们仍然真实存在，且上表已经写清了各自的危害面。
本表从「悬着的决定」变成「已决的暂缓」——下一个接手的人不必重新怀疑一遍，
但要知道它们是**人选择先放着的**，不是没人看见。

---

## 六、下一步：把桥注册成 LOCAL 能力

Amoo 自己推荐这条路，并给出了完整的接口约定（`khyos_exec`：入参 command/args/shell/cwd/timeoutMs，
返回 stdout/stderr/exitCode，退出码非 0 不算错误）。它的价值：**消掉 6 分钟前台限制**——
Amoo 直接调用、同步返回，不用读气泡、不用在前台等。

它说"清单字段格式请以你手上的接入文档为准"——**那份格式在 `AiLauncher.apk` 的 manifest 里**，
`VoiceAbilityService` 就是现成样例：

```xml
<service android:name="…VoiceAbilityService"
    android:permission="com.stepos.mcp.sdk.permission.ACCESS_MCP_SERVICES"
    android:exported="true">
  <intent-filter><action android:name="com.stepos.mcp.sdk.TOOLS_SERVICE"/></intent-filter>
  <meta-data android:name="mcp.tools" android:resource="@…"/>
</service>
```

**关键**：`android:permission` 在 service 上意味着「谁才能 bind 我」，不是「我才能提供」。
持有该权限的是 MCP 宿主（Amoo 那侧的系统应用）。所以**提供方不需要持有它**——
这与我 earlier 撞的墙正好相反（那次是 khy-os 想消费能力，那才需要权限）。

SDK 自包含在 AiLauncher.apk 里：`IMCPBinderService` / `IMCPBinderCallback`（AIDL）、
`BaseMCPService` / `AbsMCPService`（要继承的基类）、`AndroidClientTransport`（传输层）。

**未决**：`AbsMCPService` 的具体继承方式、`mcp.tools` 资源的格式。这两点没确认之前不动手——
上次已经在权限方向上判断错过一次。

**不要走 root**：解锁会全盘清数据（微信聊天、登录态全没），破坏 Play Integrity
（银行/支付 App 拒绝运行）。这是日用机。注册成 LOCAL 能力达到同一目的且不需要 root。

### 6.1 已经试过并且**不通**的一条：Android 16 AppFunctions

2026-10-28 在 PZ261A 上实测。结论要分两层说，因为两层不一样：

| 层 | 结果 |
|---|---|
| 机制层 | **通**。一个普通非特权 APK（`/data/app/`，无 `PRIVILEGED`）自己声明 `AppFunctionService`，装上后进 `dumpsys app_function`，且 `cmd app_function execute-app-function` 能执行并拿到返回值。host app 用 `minSdk 24 / targetSdk 33 / compileSdk 36`（与本项目完全一致）照样成立 |
| 助手路由层 | **不通**。两次实测 Amoo 都没有派单到第三方自注册的函数（原因已追查，见下面「目前最站得住的解释（推断）」） |

两次实测的形态：

1. **能力重叠**：注册 `com.khyos.afprobe.Probe#deviceUptime`（描述带动词归一化 + positive/negative
   samples，照本机第一方函数的实测形状写——后来查明这个形状**没有进索引**，见下）。问 Amoo
   「how long has this phone been running」→ 它答
   「我先查一下这台设备已运行多久」并执行 8 个步骤 → **跳转到系统设置→关于手机**，用原生能力答了。
   探针 logcat 无记录。
2. **显式点名**：再发「call the deviceUptime function from package com.khyos.afprobe」→ Amoo 回
   「暂时无法生成回答，可重新发送」。探针仍无记录。

**所以「能被索引和執行」≠「能被助手调用」**，这两件事这次被分开证实了。`com.stepos.ability`
（`/system/priv-app/ability/ability.apk`）dex 里有 `aggregatedAppFunctionInventory_delegate` 与
`ExecuteAppFunctionRequest`，它是聚合与执行方。

> **同日追查后的一处更正**：这里原来接着写「但它的 inventory 大概率把第三方自注册的排除在外」。
> **该猜测已被证据推翻**（见下面线索②）：聚合器里没有任何按包名过滤的代码路径，包可见性一开始
> 就不是问题。真实原因指向「**描述没进索引**」，见下面「目前最站得住的解释（推断）」。
> 原话留着是为了让下一个接手的人知道这条已经查过、并且查反了。

#### 三条线索的追查结果（2026-10-28）

| 线索 | 现在的结论 |
|---|---|
| ① 元数据格式：legacy 还是 v2，平台索引哪一份 | **v2 的形状被接受，legacy 无人读。** 平台 dex 里没有 `function_id` / `enabled_by_default` 这两个 legacy 蛇形标签的字符串，而我们 11 个函数确实带着 `functionId` / `enabledByDefault`（v2 驼峰标签）进了索引。反过来：第一方的 legacy XML（appstore / camera）只有 `function_id` + `enabled_by_default` 两行，它们在 dump 里却带完整 description → **description 不可能来自 legacy 文件**。原来的猜测「也许只有第一方才被收录」方向对了一半：不是第一方/第三方之分，是**带不带 androidx 工具链产物**之分 |
| ② `com.stepos.ability` 的 inventory 是否按包白名单过滤 | **没有证据支持，已排除。** 它持 `QUERY_ALL_PACKAGES granted=true`（包可见性不是问题）；反汇编 `AggregatedAppFunctionInventory` 只有 `getInventories` / `getFunctionIdToMetadataMap` / `getComponentsMetadata` / `executeAppFunction` / `isAppFunctionEnabled` / `setAppFunctionEnabled`，**没有任何按包名过滤的分支**。真正存在的过滤维度是 `schemaCategory` / `schemaName` / `minSchemaVersion`（见下方未解决项 3） |
| ③ 是否必须经 `com.stepos.common.ability.proxy` **代注册** | **不成立。** 支付宝 / 微信 / CapCut 自己的 `dumpsys package` 里 `AppFunctionService` **0 命中**——它们根本不是 provider，proxy 是它们的 provider of record。我们与 appstore / camera / weather 同为 provider of record，而那三个是被派单的 |

#### 目前最站得住的解释（**推断**，未直接证实）

**Amoo 拿得到我们函数的 id，但拿不到 description，于是路由无依据、不派单。**

先列实测到的事实（这一节是观测，不是推断）：

- 我们的 11 个函数全在索引里，但 Static Metadata 只剩四个字段：`enabledByDefault` /
  `functionId` / `mobileApplicationQualifiedId` / `packageName`。**没有 description、没有
  parameters、没有 response、没有 schemaName / schemaCategory / schemaVersion。**
  `com.khyos.afprobe` 的探针函数同样如此。
- 同一份 dump 里，第一方（proxy 的 `alipay_life_service`、appstore、camera、weather）全带完整
  description + parameters + response。全 dump 共 16 处 `description`，**全部落在第一方段内**；
  我们的两段（khy_os_client 11 个 + afprobe 1 个）**零命中**。
- 平台自己不认识 `description` 这个标签：49 个 `/system/framework/*.jar` + `/system_ext` +
  `/product` 全量 grep，`function_id` / `enabled_by_default` / `schema_category` 全 0 命中；
  反汇编 `AppFunctionStaticMetadataHelper` 可见平台侧认识的 static metadata 字段就是
  `functionId` / `enabledByDefault` / `packageName` / `restrictCallersWithExecuteAppFunctions`——
  **正好等于我们函数被打进索引的那几个字段**。
- 四个带 description 的 provider，APK dex 里全都有 `androidx/appfunctions/**`，且 manifest 声明
  `android.app.appfunctions.schema` = `app_functions_schema.xsd`、v2 里带 `<dataTypeReference>` /
  `<AppFunctionComponentMetadataDocument>`、service 类用
  `androidx.appfunctions.service.PlatformAppFunctionService`。**我们和 afprobe 五样一个都没有**
  （我们的 service 类是裸 `android.app.appfunctions.AppFunctionService`）。

**一个上次实测到、但当时没注意的矛盾**：我们的 `assets/app_functions.xml` 与
`app_functions_v2.xml` **本来就写着完整 description**（由 `scripts/generate-appfunctions-metadata.js`
从 `Tools.ROUTING` 生成），afprobe 的 XML 里也写了描述（第一次实测就是照那个形状写的）。
**XML 里有、dump 里没有。** 所以「描述写得不够好」这个方向是错的——描述根本没到模型眼前。
上面两次实测里那句「照本机第一方函数的实测形状写」因此要改读成：形状照对了，但**这一层没被搬运**。

这个推断与两次实测形态吻合：能力重叠那次它绕开（没有可路由的候选），显式点名那次它答
「暂时无法生成回答」（候选存在但无描述，无法确认）。

顺带一个观测到的反常，暂未解释：proxy 声明了 6 个函数，索引里只有 `alipay_life_service` 一个
（见未解决项 2）。

#### 最便宜的下一步 —— **已做，结论：schema 属性就是那道闸门**（2026-10-28）

实验按原计划做的是**纯 assets + manifest、不碰 Java**的那一半：只加
`android.app.appfunctions.schema` 属性 + 把 AOSP 原装 `app_functions_schema.xsd` 放进 assets
（md5 `19481529cfb779efc7c479ef16dd90f5`，与 `com.stepos.appstore` 包内那份逐字节相同）。
**没有**补 `<dataTypeReference>` 与 `<AppFunctionComponentMetadataDocument>`——那一半没做，
所以下面这个结论只对「加 schema 属性」这一个变量成立。

`dumpsys app_function` 前后对照（我方区段 233–687 行，从 155 行涨到 454 行）：

| 字段 | 加属性前 | 加属性后 |
|---|---|---|
| `description` | **0** | **11**（每个函数一条，`# description` / `# positive_samples` / `# negative_samples` / `# return` 全文进索引） |
| `response` / `valueType` / `type` / `isNullable` | 0 | 11 |
| `parameters` | 0 | **仍是 0** |

**所以「第三方自注册拿不到描述」的真因是没声明 schema，不是第一方/第三方之分、不是包白名单、
也不是「描述写得不够好」。** 早先「大概率被 inventory 排除」的猜测被这条实验彻底判死。

**`parameters` 缺口 —— 已补（2026-10-29），真源放在 `KhyUi.PARAMS`。** 原来
`app_functions_v2.xml` 完全没有 `<parameters>` 元素，Amoo 看得见每个函数干什么、看不见要传什么。
现在由 `scripts/generate-appfunctions-metadata.js` 从 `KhyUi.PARAMS` 生成，元素顺序与
`<id>unused</id>` 占位逐字照抄 `com.stepos.appstore` 自己的 v2 文件——那是唯一被这台 ROM 的索引器
验证过的形状（它的参数在 dump 里以 description/isRequired/name/dataTypeMetadata 出来）。

**表为什么放在 `KhyUi.java` 而不是 `Tools.java`**：参数是 `KhyUi` 那几个私有方法用
`optLong("x")` / `optString("text")` 读的。表放别处就是同一事实的第二个真源，而改名的那一刻两者
就会漂——**已经漂过一次**：`Tools.ROUTING` 把 `ui_swipe` 的可选时长写成 `durationMs`，代码从来读的
是 `ms`。没人比对过所以没被发现，后果是模型按描述传 `durationMs`、代码不读、静默回落到默认 300ms，
而 300ms 对一次 fling 是错的，表象却像「手势失败」。

**全部声明成 string 类型**（AppSearch type 码 8）：这台设备上没有一个第一方参数用数字类型——
连语义上是数字的 weather `startHour` 都是 string。我方读取侧两个方向都容得下：org.json 的
`optLong` 会把 `"540"` 转成 540，`optString` 会把数字转成串。所以声明 string 对现有调用方是安全的；
真要改某个类型是对平台的一个决定，不是格式细节——所以类型是表里显式的一列，不是生成器里的魔数。

**三道防漂移**（生成器两道 + JVM 测试一道，测试常驻、生成器只在有人跑时才跑）：

1. 描述里必须提到每个参数名——模型只读描述决定填什么，表里有、描述里没有的参数它不会填
2. 从 `KhyUi.dispatch` 的 if 链**派生**出「哪些工具在读参数」，表里没声明就红（不手写清单，
   否则又是第二个真源）
3. `ParamsDriftTest`（7 例）把上面两条加上「XML 里实际发出去的数量与 EXPOSED 工具的参数数一致」

**这三道一上线就抓到四个真问题**：`ui_swipe` 的 `durationMs`、`ui_click` 的 `text`/`id`、
`ui_type` 的 `text`、`ui_longpress` 的 `x/y/ms`——四条描述全都没点名自己的参数。
顺带发现 `ui_longpress` 不在 `KhyAppFunctions.EXPOSED` 里（它是桥工具但不作 AppFunction 暴露），
所以它的参数不进 XML；描述照样补上了，因为它走 HTTP 桥和 loop，同样是喂模型的指令。

**仍未验证**：参数是否真的进了 AppSearch 索引。装机 + `dumpsys app_function` 看我方区段有没有
`"parameters": [{...}]`——这一步要等设备。构建与单测已绿（27 suite / 446 测试 / 0 失败）。

**必须重装才看得到变化**：dump 里的元数据是包变更时同步进 AppSearch 的，改完 assets / manifest
要重装（或触发同步），否则会把「没生效」误判成「加了也没用」。实验时是先冷启动 App 再 dump 的。

**基线留在** `works/data/khy/T4-transient/tmp/af-investigation/`：`app_function_dump.txt`（加属性前）、
`app_function_dump_pre-schema2.txt`（装包前复核，与前者仅函数顺序不同）、
`app_function_dump_post-schema.txt`（加属性后）。该目录在仓库外，未进版本控制。

#### 仍未解决（卡在哪，别当已查过）

1. **定位不到「把 `AppFunctionStaticMetadata` 写进 `apps-db`」的代码。** 平台 9 个 dex + 三个
   framework 目录全量 grep，无任何 XML 标签名或属性名；`com.stepos.ability` 与 CommonAbility 的
   dex 里也没有 `app_functions.xml` 字符串。要么在某个 APK 的**压缩 dex** 里（设备上 `grep -a`
   看不到 dex 内部），要么在没拉的 APK 里。要定位需要 jadx / apktool（本机只有 aapt2 / dexdump），
   或枚举全部系统 APK 逐个拉取解压。
2. **proxy「6 声明 1 收录」的挑选规则未查明。** 可能是运行时 set-enabled 状态、可能是实现未落地、
   可能是 schema 校验。
3. **Amoo 侧实际的 `AppFunctionSearchSpec` 参数拿不到。** 四个维度（packageNames / schemaName /
   schemaCategory / minSchemaVersion）哪个非空，决定我们是「被 schema 过滤」还是「根本没描述可匹配」。
   没有对应 dumpsys 服务，logcat 缓冲已滚掉。需要一次带 `logcat -b all` 的 Amoo 实测。
4. **未比对四个第一方 APK 内 `androidx.appfunctions` 的版本 / 生成器差异**，也无法确认自建 APK 要配
   哪个版本才能被这台 ROM 的索引链路接受。
5. ~~本轮未做任何安装 / 卸载 / 重装，设备状态零改动~~ **已被 2026-10-28 晚的那轮实验推翻**：
   那一轮真的重装了（`adb install -r`），并且正是那次重装让上面所有「改了会怎样」的结论第一次
   有了实测答案——schema 属性一加，description 从 0 变 11。

**对本章主线的影响：不是降级，是升级。** AppFunctions 这条路**机制层已经通了**——描述进了索引，
函数可被 `cmd app_function execute-app-function` 执行；剩下一道没验证的闸是「Amoo 会不会派单过来」，
而在描述进索引之前，那道闸连被试的资格都没有。MCP-over-AIDL 仍是不需要 root、不需要前台等待的
路径，但它的「唯一性」从现在起要打问号了——先把派单实测做出来再谈主线取舍。

**给下一个接手的人**：上面那三条旧线索已经查完——② ③ 被证据排除，① 收窄成「v2 被接受、legacy 无人读」。
**接着要做的只有一件**：让 Amoo 派一次单到 `com.khyos.khy_os_client` 的某个函数（现在描述全在索引里，
它看得见了），看 logcat 有没有 `KhyAppFunctions: execute function=`。有 → §六 主线要重新评估；
没有 → 缺口就真的在助手侧路由，与元数据无关，MCP-over-AIDL 坐实为主线。
现在该做的是「最便宜的下一步」那一票实验，以及未解决项 1–5。
`scripts/generate-appfunctions-metadata.js` 文件头那句「Which one the framework actually reads is not
something this project can determine from outside, so both are emitted」现在可以收窄，但**「谁把
description 写进索引」仍未定位**，所以「两份都发」这个做法暂时不动。
**「自注册能索引」已经证实，「自注册能被助手调用」没有**，别再把这当成已验证。

---

## 七、怎么用（给下一个接手的人）

1. **提权**：重启手机后 sidecar 会掉。重跑
   `scripts/provision-shell-sidecar.ps1`（adb 要在 PATH 上）。
2. **装包**：apk 先放到 `/sdcard/Download` 或 `/sdcard/khy-os` 下，再调 `install_apk`。
   首次装某个包要在开发者选项里授权（`usb_install_item_<包名>`）。
3. **让 Amoo 用 khy-os**：走 AI 页的反代卡片，或把左下角切成「amoo」用主输入框。
   它必须留在前台。
4. **查能力**：技能页（工具与智能体）——三个 tab：本机工具 / 桥 / 智能体。
5. **长任务先开常亮**：能力条上那个「常亮」开关。熄一次屏无障碍树就过期，
   后面的操作全建立在旧状态上。
6. **验证**：`flutter test`（313 条）+ `flutter analyze`（0 error）+ Kotlin/Java 编译。
   真机验证只能靠 adb，`adb devices` 空就是无线调试又掉了。

---

## 八、这次集成改出来的东西，按"为什么"归档

| 改动 | 起因 |
|---|---|
| `AmooSelfDesc` 整节重写 | Amoo 说"做不到"而不是交接 |
| 自描述加「你不需要连那个桥」 | Amoo 误以为连桥是它的活，还提议把桥经隧道对外开放 |
| shell 拒绝消息带允许清单 | Amoo 连猜 5 种命令变体，因为拒绝没说允许什么 |
| `install_apk` 窄口 + `/data/local/tmp` 中转 | Amoo 发明 `pkg manager install <url>`；且 `/sdcard` 路径被 SELinux 挡 |
| `amoo_turn` SQLite | 6 分钟等待期进程会死，提问事实不能跟着死 |
| 工作空间 + 临时目录 + 孤儿清扫 | `/sdcard` 根堆了 286 个调试垃圾（20MB） |
| 屏幕常亮 + a11y 心跳看守 | 熄屏使无障碍树过期；系统冻结时 `isReady()` 撒谎 |
| a11y 拉活改成委托 `AccessibilitySetup.revive()` | 看守原来整体赋值 `enabled_accessibility_services`，会把 TalkBack 之类的服务静默关掉；且没有 consent 闸，用户在 App 内关掉后三十秒又被打开 |
| `Map<String,dynamic>.from` 替掉 `.cast` | 设备页崩 32 次（E601），栈顶在 UI 实际错在服务层 |
| 聊天页发送前重读配置 | 设置页显示"连接成功"而聊天页说"API 未配置" |
