<!-- IMPL-STATUS: todo -->
<!-- 文档分类: DESIGN-ARCH-200 | 阶段: 设计 -->

# [DESIGN-ARCH-200] 对标 stepx 的 amoo 深度配合

> **本文回答两个问题**：①「stepx 平台上 amoo 能被深度调用」这件事，khyos 侧到底差在哪、哪些差距已经取证、哪些只是转引；②在「不 root、不读气泡、不碰 amoo 本体、不削弱任何安全件」的约束下，补差距走哪条路、分几步、每步的门槛是什么。
>
> **结论卡**：推荐主线 = **方案 1「反向 LOCAL 能力通道」**——把 khy-os 注册成 amoo 可直调的本地能力提供方。**方案 1 内部有两条实现路径，哪条坐实由步骤 2 决定，本文不预断**：MCP-over-AIDL（按 `AMOO-INTEGRATION.md` §六 amoo 自己建议的 `khyos_exec` 形状推进，**该形状是 exec 类接口，与本文硬规则 1 正面冲突，暴露子集未定，见 §3.3**）与已架好且描述已进索引的 11 个 AppFunction（`KhyAppFunctions.java:91-95`，作先遣探针——注意「已架好」只修饰这个 AppFunction 面，MCP 侧在全树 0 命中，一行代码都不存在）；**方案 2 的半条探针**（一条 adb 命令证伪 AgentBus 本地监听）并行做；**方案 4 的排队与观察面立即上线兜底**。为什么是它：四个候选里唯一「对手方已经要求过」的机制是 `AMOO-INTEGRATION.md` §六 的 `khyos_exec`；它不与 Android 安全模型对撞（无凭据窃取、无 UI 抓取、无 root，`AMOO-INTEGRATION.md` §六 已纠正过权限方向并明确「提供方不需要持有宿主权限」）；它把「6 分钟前台读气泡」换成结构化同步调用。方案 2/3 的关键未知都能用半天探针排除，不值得先押工程份量。
>
> **诚实边界先说清**：本文所有 khyos 侧结论来自**静态读码 + 一次可复现检索**（命令与原始输出见 §八.1）；**未跑构建、未跑测试、未做任何真机验证**——§四 各步骤里的探针是**待执行项，不是已通过的检查**。stepx 侧证据（AiLauncher manifest 样例、SDK 类名、AgentBus 自陈、AppFunctions 既往实测）**转引自本轮任务输入与仓内 `AMOO-INTEGRATION.md` §6.1 的留档，本轮未重新联网抓取、未复跑那两次实测**。三件必须先说破的保留：**(i)** 现有 AppFunction 出口**本身就是一个不过 `AmooSafe`/`forAmoo` 的第二个出口**（`KhyAppFunctions.java:162-181` 原样返回 `Tools.dispatch` 结果，`EXPOSED` 含 `ui_type`），本文 §六 把它单列一行，「出口只有一个」对新通道成立、对现状不成立；**(ii)** 预算门的既有语义是**按轮重置**而非按次（`Tools.java:1488,2145-2147,2201-2204`），ability 路径没有「轮」边界，按次重置等于取消累计上限——这是未决项，不是已定的继承；**(iii)** 被继承组件自带一条用户可见的归因错误（安全底拒绝被报成「人工中止」、被拒命令不进 `executed`，`AMOO-INTEGRATION.md` §五），新入口不得原样继承。另注：`[DESIGN-ARCH-193]` §7.5 待建清单第 1 条「Flutter→原生 `amoo_ask` 通道」**已在 `MainActivity.kt:331-337` 落地**，该文档此条已过期，本文以代码为准。

---

## 〇、人的意愿（B6-1 可追溯）

| 时间 | 谁 | 要什么 |
|---|---|---|
| 2026-10-23 | 用户 | 「划清手机中 khyos 与 amoo 的职责」「khyos 与 amoo 都要可以单独使用但是又要能相互协作」（`[DESIGN-ARCH-193]` §一 R5/R6 原话） |
| 2026-10-29 | 用户 | 「参照这个项目完善手机的配合」（`[DESIGN-ARCH-196]` §〇 原话；该轮已把「手机对沙箱没有任何直连通道、所有命令都要经聊天框打字和读气泡」列为主干病灶） |
| 2026-11-02 | 本轮任务输入 | 把「对标 stepx 的 amoo 深度配合」方案落成设计文档（不 commit、不 push）。四候选与推荐主线由本轮工作流输入给出，本文是其落纸；**输入中 stepx 侧证据为转引，本文未重新取证** |
| 2026-11-03 | 独立审读员 | 对本文初版提 23 条 findings + 7 条 unclear（安全边界三条、借鉴边界、时序、门槛、引用精度等）。本版为逐条修订结果：**改了口的都改口，改不了的（需人裁决/需设备）如实写进 caveats 与 §九** |

**这条意愿链的形状**：从「划清职责」（193）到「补齐手机的配合」（196），再到本轮「对标 stepx 把 amoo 用深」。三步指向同一个未消病灶——**amoo 旁路今天必须占前台约 6 分钟**（`AMOO-INTEGRATION.md:40-41` 自陈「这是这套方案的根本限制，不是没做优化」）。本文不重新论证那个病灶，只回答「补它走哪条路」。

### 0.1 编号、证据时效与行号口径

- **编号**：`docs/03_DESIGN_设计/DESIGN-ARCH/` 现有 **192 个 `.md`**（`dir /b *.md | find /c /v ""` = 192），扣掉 `00_INDEX_DESIGN-ARCH-总目录.md` 得 **191 篇在册**；最大编号 199，**200 为首个可用空号**（已实测该目录无 200 号文件）。
- **证据时效**：读码与检索发生于 **2026-11-02**（修订复核 2026-11-03），当前分支 `chore/docker-image-slim-20261102`。手机侧 amoo 相关源码在当前工作区**大量未入仓**（`git status --porcelain` 对 `delivery/mobile/khy-os-client-app/` 显示 `??`：`bridge/AmooLoop.java`、`Tools.java`、`AmooSafe.java`、`LoopModes.java`、`LoopVerify.java`、`KhyAppFunctions.java`、`SelfDesc.java`、`lib/core/services/amoo_service.dart`、`AMOO-INTEGRATION.md` 等）。**所有 `file:line` 指向工作区今天存在的文件，不是已提交内容**（同 `[DESIGN-ARCH-193]` §3.1 的口径）。
- **行号口径（初版写错，本版更正）**：本文行号按 **Read / `findstr /n` / `Select-String` / `StreamReader`（UTF-8）** 口径，四者一致；`findstr /n` 复核 `MainActivity.kt` 的 `private fun amooAskResult` 在 **1699**，与 Read 相同。**不要用 PowerShell 5.1 的 `Get-Content` 数行号**——它默认按 ANSI(GBK) 解码无 BOM 的 UTF-8 文件：`MainActivity.kt` 字节级实测 **LF=2083、CR=0、孤立 CR=0**（全文 97,741 字节），`StreamReader` 得 2083 行，而 `Get-Content` 只得 **1939** 行且中文注释变乱码（多字节序列被错判成 GBK 双字节码、吞掉换行）。初版把此现象误归因为「文件含孤立 `\r`」，**该论据是错的，本版撤回**；行号本身经审读员抽查约 50 处 + `findstr /n` 复核无误。

---

## 一、动机与对标结论（stepx 有 / khyos 没有）

### 1.1 对标轴

「stepx」指 **StepOS 平台侧**：设备固件 + `AiLauncher.apk`（`/system_ext/app/`，特权应用）+ 系统 ability 组件（`com.stepos.ability` / `com.stepos.agentbus` / `com.stepos.mcp.sdk`）。「khyos」指本仓 `delivery/mobile/khy-os-client-app/` 的普通第三方 APK。对标的问题是：**amoo 要被「深度调用」，平台侧有什么是普通第三方 APK 今天拿不到的**。

### 1.2 差距表

> **列口径**：「stepx 侧」列**转引自本轮任务输入与仓内 `AMOO-INTEGRATION.md`，本轮未复证**；「khyos 侧」列全部本轮读码取证。判定列三值：**holds**（差距存在且已取证）/ **partial**（部分成立）/ **未取证**（关键一环没有证据）。

| # | 形态 / 能力 | stepx 侧（转引，未复证） | khyos 侧（本轮取证） | 判定 |
|---|---|---|---|---|
| G1 | **MCP-over-AIDL LOCAL 能力通道**（`com.stepos.mcp.sdk.TOOLS_SERVICE` + `mcp.tools` meta-data + `IMCPBinderService`/`IMCPBinderCallback` AIDL + `AbsMCPService` 基类） | `AiLauncher.apk` manifest 的 `VoiceAbilityService` 是现成样例；SDK 自包含在 dex 里；amoo 云端要本地动作时经 `nodes invoke` / `ability` 两个入口同步回调 | **零命中**：本次对 `android/app/src/main/java` + `kotlin` + `lib` 全树检索 `TOOLS_SERVICE`/`mcp.tools`/`IMCPBinder` 均 0（§八.1，含正对照）。现有对外能力面是 `KhyAppFunctions`（`AndroidManifest.xml:134-172`，裸 `android.app.appfunctions.AppFunctionService`，非 MCP AIDL） | **holds**（差距存在且已取证）；「第三方自注册 provider 能否被 amoo 派单」**未取证** |
| G2 | **AppFunctions 描述进索引 + 被助手派单** | 第一方四家（proxy 的 `alipay_life_service`、appstore、camera、weather）dump 里全带 description + parameters + response；APK dex 全含 `androidx/appfunctions/**`，manifest 声明 `android.app.appfunctions.schema` | 我方 11 个函数**描述已进索引**（既往实测：2026-10-28 **上午**两次请派单均无记录，`:216-224`；**同日晚**加 schema 属性后 description 0→11，`:279-296`）；parameters 由 `scripts/generate-appfunctions-metadata.js` 从 `KhyUi.PARAMS`（`KhyUi.java:72`）生成，但**参数是否真进了 AppSearch 索引仍未验证**（`:327-328`，要等设备） | **partial**：机制层 holds（可索引、可 `cmd app_function execute-app-function` 执行）；**助手派单层未取证，且时序前提必须说清——那两次失败发生在描述进索引之前，今天重测的胜率与当时不同**（`:355-358` 自陈「机制层已经通了……MCP-over-AIDL 的『唯一性』从现在起要打问号」；`:368`「自注册能索引」已证实、「自注册能被助手调用」没有） |
| G3 | **特权 / 同签名 Companion 形态**（`WRITE_SECURE_SETTINGS`、固件预置） | stepx 固件版自带 | khyos **明确不照搬**：`AMOO-INTEGRATION.md` §六「不要走 root」（解锁清全盘数据、破坏 Play Integrity，这是日用机）；已申请权限面到 `SYSTEM_ALERT_WINDOW`/`WRITE_SETTINGS` 为止（`AndroidManifest.xml:12-22`），无系统签名级 | **holds**（差距存在），但属**不追的差距**——追它要付的代价是日用机数据与完整性，见 §五 |
| G4 | **AgentBus 本地入站套接字**（帧协议形状：4 字节大端帧长 + v3 握手 + req/event 两帧型，直连 `chat.send`/`chat.abort`/`sessions.*`） | `AMOO-INTEGRATION.md` §一 自陈「不开入站端口，手机主动外连」；dex 里 420 处引用（`:60`，仅此一句） | **零命中**：`LocalSocket`/`localabstract` 在 main java + kotlin + lib 全树 0 命中（§八.1） | **未取证**（本地监听很可能不存在，探针待跑；证据倾向没有）。**帧协议那组细节在仓内无出处**，转引自本轮任务输入——探针若命中，不能凭这组形状写客户端，须另行取证 |
| G5 | **VirtualDisplay 承载 activity**（`ActivityOptions.setLaunchDisplayId` 把 amoo 聊天页拉进虚拟屏，用户屏幕上始终是 khyos 自己） | 未转引为 stepx 已有形态 | 现有 VirtualDisplay **只是 AUTO_MIRROR 抓屏**：`ScreenCaptureService.kt:182` `createVirtualDisplay` + `:185` `VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR`，不是承载 activity 的形状（全树 `setLaunchDisplayId` 0 命中）；**且唯一截图路径 `KhyAccessibilityService.kt:350-359` 的 `takeScreenshot` 钉死 `Display.DEFAULT_DISPLAY`**，拍虚拟屏必须改这一行 | **holds**（差距存在）；**跨显示可达性未取证**（a11y 服务绑默认屏，`KhyAccessibilityService.kt:88,169,249,285,314` 全走 `rootInActiveWindow`）；「截图走 `takeScreenshot(displayId)`」**不是现成件**，初版表述已更正 |
| G6 | **6 分钟前台依赖**（反代读气泡） | stepx 形态无此限制——同步回调，不用读气泡、不用在前台等 | **病灶已双证**：`AmooLoop.java:296-306` 前台预检（`amoo_not_foreground` 即拒）；`AMOO-INTEGRATION.md:40-41` 自陈「整个等待期 Amoo 必须留在前台，你不能切走去用手机」 | **holds**（本文要消的就是它） |

### 1.3 不构成差距的既有资产（列出以免重复建设）

khyos 侧**已经有**、对标时不必补的：三级提权链 `Tools.java:2759-2801`（sidecar uid 2000 → Shizuku → app uid，每个结果带 `via` 字段）；后台截图 `KhyAccessibilityService.kt:350`（API 30+ `takeScreenshot`，不需 MediaProjection 弹窗）；全局手势与动作 `:118-162`；a11y 心跳判活 `:57-65`（120s 无事件判可疑）+ 看守拉活 `BridgeService.java:119-172`（委托 `AccessibilitySetup.revive`，consent 门控 + 读-改-写）；8896 回环 HTTP `HttpBridge.java:317-321`（显式绑 127.0.0.1）；悬浮窗零 IO 面板 `BridgeOverlayService.java:463-490`；`/sdcard/khy-os` 共享工作区（`MainActivity.kt:65`、`:1804` `workBase()`，amoo 已实测能读能写 `/sdcard`）。

### 1.4 对标结论一句话

**差距集中在「通道形状」，不在「执行能力」。** khyos 的执行面（工具、提权、验证、净化）比 stepx 侧可引用的样例只强不弱；缺的是一条**让 amoo 云端直接调进来**的入站形状。G1 是首选补法，G2 是它的轻量先遣（且可能反客为主，见 §3.4），G4/G5 是待证伪的备选，G6 是所有候选共同要消的病灶。

---

## 二、amoo 现状机制与前台依赖点

### 2.1 四条接触面与反代三步协议（现状，带行号）

| 件 | 机制 | 证据（本轮已读） |
|---|---|---|
| 通道 A｜反代对话 | 你在 khyos 里输入 → 自描述 + 问题写进 amoo 聊天框 → amoo 云端思考 → khyos 读它的最新气泡 | `AmooLoop.java:385-397`（`buildAskPreamble` = `AmooSelfDesc.render()` + `AmooMemory.renderForInjection(1200)`）、`:576`/`:840`（`AmooChatText.extract`） |
| 定位依据 | amoo 包名 + 三个 resource-id **硬编码在此**，注释明确「绝不点记忆坐标」——软键盘弹起时输入框位移约 1300px，每次交互都从实时 dump 解析 | `AmooLoop.java:72-75`（`AMOO_PKG`/`ID_CHAT_LIST`/`ID_INPUT`/`ID_SEND`） |
| 写回 | `ui_type` 写入后等键盘沉降，再 dump 取发送按钮 bounds 中心 `ui_tap`，重试 3 次；3 次全败内容落 pending 文件交给人恢复 | `AmooLoop.java:1268`（`forAmoo(text)` 出口）、`:1286-1316`（3 次重试 + pending 兜底） |
| 循环主路径 | 每轮 `ui_dump` → `AmooChatText` 取最新气泡 → 优先 `AmooProtocol.extractFences` 抽围栏命令，抽不到则回落 `extractCommands` 按命令形状 JSON 识别（这台设备上围栏通常不进无障碍树） | `AmooLoop.java:854-867` |
| 命令执行链 | `LoopModes.decide` 判档 → `Tools.dispatch` 本地执行 → `LoopVerify.plan` 验证 → 写回「已验证 / 未能验证 / 失败」三种结局 | `LoopModes.java:117-153`、`LoopVerify.java:22,58-85`、`AmooLoop.java:682-702,1033-1052` |
| 反代三步 | `ask` 异步起线程立即返回 job id（单飞，`:264`）；`askResult` 轮询 `running/done/failed`；`stop` 清单飞锁 + interrupt | `AmooLoop.java:418`、`:444`（`ORPHANED_ASK_MS=1_860_000`）、`:478-485`（孤儿自愈，`orphaned_ask:` 前缀判档） |
| Dart 侧 | 三通道各带 8s 超时；失败按 `amoo_not_foreground`/`single_flight`/`refused`/`orphan_cleared`/`unavailable`/`empty_prompt` 分档 | `amoo_chat_service.dart:27,50-61,92,168-203` |
| 五态落库 | 每笔提问进 `amoo_turn` 表，进程死了重启后知道有这么一笔；未结算行回收为 `interrupted` | `amoo_turn.dart:15-29`（五态）、`amoo_turn_store.dart:160-178` |
| 通道 B｜桥 48 工具 | `/sdcard/bridge-amoobridge/` 信箱 + 8896 回环 HTTP；`exec` 三级提权链 | `Tools.java:257-268`（NAMES **48 项**，逐个手数）、`:2759-2801`；`HttpBridge.java:317-321` |
| 通道 C｜amoo 设备通道 | Amoo 自述有一条手机主动外连的常驻节点连接（AgentBus），云端经它有两个入口：`nodes invoke` + `ability`。实测 `system.which` 有实现、`khy.exec` 报 `no invoke target node`——**桥的工具要经这条通道被 amoo 调用，注册必须在手机侧做** | `AMOO-INTEGRATION.md` §二 通道 C（仓内文档留档的既往实测，本轮未复跑） |
| **AppFunction 面（第 4 条接触面，初版漏列）** | 系统索引声明 → 助手侧 ability router 直接 `bind` 调用，**无前台、无轮询、无信箱**；`onExecuteFunction` 校验调用方白名单 → 查 `EXPOSED` → `Tools.dispatch(tool, params)` → **`out.toString()` 原样作为返回值**。全函数**无 `AmooSafe`/`forAmoo`/`LoopModes`**（唯一相关是 `:36-43` 的类注释，声称档位门只属于「HTTP 桥和 loop」） | `KhyAppFunctions.java:107-182`（`:162-181` 是派发与原样返回）、`:74-81`（白名单）、`:91-95`（EXPOSED 含 `ui_type`/`ui_tap`/`ui_click`/`ui_swipe`/`ui_dump`）、`:87-89`（`shot` 回的是路径）；`AndroidManifest.xml:134-172` |
| Intent 交接 | `ACTION_SEND`+`text/plain` 直投 `ShareActivity`，失败只退回限定包名的 chooser；恒定口径「已交给 amoo（未确认送达）」 | `MainActivity.kt:1533-1633`、`amoo_service.dart:51,183-186` |
| 拉起 amoo | `OPEN_CHAT` 直投 `ChatMainActivity` → 回落 launcher 入口 → 两者都失败才报「未安装或无法启动」；不预填、不发送 | `MainActivity.kt:1744`、`:2067-2068`、`amoo_service.dart:23,97` |

### 2.2 前台依赖点逐条（这是要消的病灶）

| # | 依赖点 | 证据（本轮已读） |
|---|---|---|
| F1 | **唯一的显式前台预检**：`foregroundPackage()` 非空且 ≠ `AMOO_PKG` 时直接置 `askError="amoo_not_foreground"`、`askState=FAILED`、返回 null。注释 296-300 给出根因——提示词会落进自家输入框、找不到发送按钮、写回重试 3 次后转 pending 文件、调用方白等整个预算 | `AmooLoop.java:296-306` |
| F2 | **「输入必须落焦 EditText」的根因**：`typeText` 用 `root.findFocus(FOCUS_INPUT)`，取不到才退化成「当前窗口第一个 EditText」。amoo 不在前台时落焦的是 khy-os 自己的输入框，`ACTION_SET_TEXT` 原样写进去 | `KhyAccessibilityService.kt:314-315` |
| F3 | **「无障碍只覆盖当前窗口」的根因**：`foregroundPackage`/`find`/`dumpUi`/`listClickable`/`typeText` 全部经 `rootInActiveWindow`；`KhyUi.java:147` 的 `ui_dump` 同样只取 `getRootInActiveWindow` | `KhyAccessibilityService.kt:85-88,169,249,285,314`；`KhyUi.java:147` |
| F4 | **发送依赖前台**：发送按钮 bounds 从实时 dump 解析（`boundsCentre(xml, ID_SEND)`），amoo 不在前台时该 resource-id 根本不在树里，3 次重试全落 pending 文件 | `AmooLoop.java:1286-1316` |
| F5 | **读回复依赖前台**：`runAsk` 每轮调 `currentLastBlock()`（内部就是 `ui_dump`），amoo 不在前台时读到的是 khyos 自己屏幕，`cur.equals(before)` 恒真，只能空转到 deadline 报 timeout | `AmooLoop.java:535-543` |
| F6 | **熄屏后无障碍树过期**，所以轮询自己维护 `FLAG_KEEP_SCREEN_ON`；这条反过来要求 amoo 前台可见，否则保屏保的是 khy-os 自己的窗口 | `MainActivity.kt:1698-1718`（`amooAskResult` 里 `setKeepScreenOn(state=="running")`）、`:1723-1733`（只加窗口 flag，刻意不碰 WakeLock） |
| F7 | **`loopStart` 的前台缺口**：只查 `uiReady()`（无障碍开关），没有前台预检也不启动 amoo；amoo 不在前台时循环照样起，然后每轮读屏失败 `continue`、写回放弃，只能靠 deadline 收尾 | `AmooLoop.java:723`（`uiReady` 检查）、`:736`（`armed=true`） |
| F8 | **手机侧借不到 PC 那条会自动 `am start` 的路**：phone token 调 `amoon_send`/`amoon_inbox` 判 `forbidden_scope`（operator-only），且桥 daemon 只听 127.0.0.1，没有 adb reverse 时手机根本到不了 | `contracts.js:486,509`（`scopes:[OPERATOR]`）、`HttpBridge.java:317-321`、`amoo_service.dart:8` |
| F9 | **未装 amoo 时也报 `amoo_not_foreground`**（语义错，应分开为 `amoo_not_installed`）；「任一方缺席都不把另一方显示为故障」只做到部分 | `[DESIGN-ARCH-193]:270,311`（文档自陈的两个未决项） |

### 2.3 PC 侧对照（说明这不是「没做优化」）

PC 侧反代路径在 dispatch 前会 `adb shell am start -n <component> -a <action>` 主动把 amoo 拉到前台并等 `launchWaitMs`（`amooDispatchRunner.js:408`、`amooBridgePolicy.js:339-340`）——**手机侧没有任何代码自动调用 `openAmoo`**，它只被用户点按钮触发（`amoo_task_card.dart:233-240` → `AmooService.openChat()`）。也就是说：PC 靠「adb 拽前台」绕过 F1，手机绕不过去；而 PC 那条路对手机侧不可用（F8）。

---

## 三、候选方案对比与推荐主线

### 3.1 四候选对比表

| 维度 | 方案 1 反向 LOCAL 能力通道 | 方案 2 AgentBus 本地协议直连 | 方案 3 VirtualDisplay 后台虚拟屏 | 方案 4 现状收口（Intent+排队+观察） |
|---|---|---|---|---|
| 做法 | khy-os 把自家工具注册成 amoo 可直调的 LOCAL 能力（manifest 照 `VoiceAbilityService` 样例声明 `TOOLS_SERVICE` + `mcp.tools`，provider 不需持有宿主权限）；amoo 云端要本地动作时同步回调进来，khyos 执行、LoopVerify 验证、AmooSafe 净化后返回。**内部两路径：MCP-over-AIDL（amoo 建议的 `khyos_exec` 形状，暴露子集未定，§3.3）/ 已索引的 11 个 AppFunction（先遣探针）** | 先用一条 adb 探针确认 AiLauncher 是否监听 `localabstract:agentbus`（§一 自陈不开入站端口，故先证伪再动手）；命中则自写帧协议客户端（4 字节大端帧长 + v3 握手 + req/event 两帧型——**该组细节仓内无出处，转引本轮任务输入**）直连 `chat.send`/`chat.abort`/`sessions.*` | 建一个承载 activity 的 VirtualDisplay 把 amoo 聊天页拉进去跑（`ActivityOptions.setLaunchDisplayId`），读写与点击仍走 KhyUi/无障碍——用户屏幕上始终是 khyos 自己。**截图不是现成件**：唯一截图路径 `KhyAccessibilityService.kt:350-359` 钉死 `Display.DEFAULT_DISPLAY`，拍虚拟屏必须改这一行 | 不动架构：任务经既有 `AmooService.shareText` 一次性交给 amoo，`amoo_turn` 五态 + 悬浮框零 IO ticker + `amoo_task_card` 轮询把分钟级等待变成可排队、可观察、可恢复的形态 |
| **foregroundFree** | **full**（同步回调，不读气泡、不占前台） | **full**（若套接字存在） | **partial**（用户屏不被占，但 amoo 仍需在某个显示上活跃） | **partial**（提问路径仍被 F1 拒） |
| 工作量 | 中高：`AMOO-INTEGRATION.md` §六 记的两个未决（`AbsMCPService` 继承签名、`mcp.tools` 资源形状）要先探针确认，之后按观察/文件/执行三类分批开，每批都要真机派单验证。**另加两道初版未计的门：B-P2 六字段提案（`[DESIGN-SOURCING-001]`，先提案后编码）与「暴露子集」裁决（§3.3）** | 探针半天；帧协议客户端中等；但很可能停在探针（证据倾向没有入站端口），工程份量押不上去 | 中：读写点抽签机制全可复用，但卡在一个未验证的跨显示可达性上，要先做探针 APK 才能估准；截图目标还要改代码 | 低：全是既有构件接线，只新增排队与入口提示 |
| 风险 | 第三方自注册 provider 能否被 amoo 派单**未证实**（AppFunctions 两次实测没派单，`AMOO-INTEGRATION.md` §6.1——**但那两次在描述进索引之前，:216-224 vs :279-296**）；ability 无确认面，档位门写错就等于把高危工具开给云端；**`khyos_exec` 是 exec 形状接口，与自家硬规则 1 冲突（§3.3）**；**现有 AppFunction 出口已是一个无净化出口（§六），探针本身在往它上面派单** | AiLauncher 自陈不开入站端口，本地套接字很可能不存在，探针不命中即整个方案降为不可行；即便在，是否与 stepx 固件版同一协议无证据；帧协议形状无仓内出处，命中后仍要重新取证 | 跨显示可达性是未验证的平台行为：a11y 服务绑默认屏（`KhyAccessibilityService.kt:88,169,249,285,314`），`getRootInActiveWindow`/`findFocus` 的跨显示语义、`dispatchGesture` 的注入目标、amoo 特权 activity 能否被拉进虚拟屏，任一不成立即全盘失效 | 治标不治本：提问路径仍被 `AmooLoop.java:296-306` 拒绝，分钟级单发不变；只是等待变得可排队、可观察、可恢复 |
| 复用件 | `KhyAppFunctions` + `scripts/generate-appfunctions-metadata.js`（元数据从 `KhyUi.PARAMS`/`Tools.CATALOG` 派生不手抄）、`Tools.NAMES`/`CATALOG`/`ROUTING`、LoopModes 安全底、LoopVerify 三态、`AmooSafe.forAmoo` 单咽喉、AmooSelfDesc/SelfDesc、`amoo_turn` 五态表、BridgeOverlayService 零 IO 面板、`AmooService.shareText`、`/sdcard/khy-os` 共享工作区。**注意「复用」指语义与数据继承，不是原样照搬——遥测与悬浮框都要新接线（§3.2(c)）** | `amoo_turn` 五态表、BridgeOverlayService、`AmooService.status` 安装探测；Tools/LoopModes/LoopVerify 执行链基本用不上（不再由 khyos 替 amoo 执行），AmooSafe 只覆盖 khyos 自己出站的文本 | 整套 AmooLoop：AmooChatText 几何重建、AmooProtocol 围栏/命令形状、LoopModes、LoopVerify、AmooSafe、Tools、KhyUi、BridgeOverlayService、`amoo_turn`、KeepAwake、MainActivity 三通道；改造点集中在取屏目标（要改 `KhyAccessibilityService.kt:358-359` 的 DEFAULT_DISPLAY）与 writeBack 的输入目标 | `AmooService.shareText`（已实现）、AmooChatService 三通道、`amoo_turn` 五态、BridgeOverlayService 面板（已在读 `AmooLoop.progress`/`elapsedMs`/`lastWriteBack`）、`amoo_task_card` |
| 裁决 | **主线**（内部两路径由步骤 2 分岔，§3.4） | 并行半条探针（证伪即止） | 不押（G5 未取证，且 effort 与主线重叠度高） | **立即上线兜底** |

### 3.2 推荐主线与理由

**主线 = 方案 1；方案 2 的半条探针并行；方案 4 的排队与观察面立即上线兜底。** 四条理由：

**(a) 它是仓内文档自己写定的下一步，且是 amoo 自己建议并给过接口约定的路径。** `AMOO-INTEGRATION.md` §六 明记：amoo 推荐这条路并给出了完整接口约定（`khyos_exec`：入参 command/args/shell/cwd/timeoutMs，返回 stdout/stderr/exitCode，退出码非 0 不算错误，`:178-180`），且 `AMOO-INTEGRATION.md` §二 通道 C 的实测（`khy.exec` → `no invoke target node`）已证明「注册必须在手机侧做，云端配不了」。四个候选里唯一「对手方已经要求过」的机制就是它。

**(b) 它不与 Android 安全模型对撞。** 无凭据窃取、无 UI 抓取、无 root。`AMOO-INTEGRATION.md` §六 已纠正过权限方向（`android:permission` 在 service 上意味着「谁才能 bind 我」，不是「我才能提供」；持有该权限的是 MCP 宿主，**提供方不需要持有它**）并明确「不要走 root」——解锁清全盘数据、破坏 Play Integrity，这是日用机。G3 因此直接出局。

**(c) 它把「6 分钟前台读气泡」换成结构化同步调用；安全件是「语义继承 + 新接线」，不是「原样搬进」。** 初版写「`amoo_turn` 五态、LoopVerify 验证三态、AmooSafe 出口单咽喉、悬浮框零 IO 面板全部原样搬进新通道，安全边界不减反增」——**这句过度表述，本版撤回**。如实说：LoopVerify 三态与 AmooSafe 六 pass 是**纯逻辑、可直接调用**（`LoopVerify.java:58-85`、`AmooSafe.java:298-309`）；而 `amoo_turn` 观测流是**新接线**（步骤 5 自述「每次调用同时写进 `amoo_turn` 观测流」），悬浮框要**改读 ability 调用流**（步骤 7）——它今天读的是 loop 路径的内存 getter `AmooLoop.progress()`/`elapsedMs()`/`lastWriteBack()`（`BridgeOverlayService.java:463-490`），ability 路径一个都没有。所以准确表述是：**判档、验证、净化三类语义原样继承；遥测与显示两面新写接线**。安全边界「不减」的部分见 §六 表；「反增」不成立的地方（现有 AppFunction 出口不过净化）也在 §六 单列。

**(d) 方案 2/3 的关键未知都能用半天探针排除，不值得先押工程份量。** G4 一条 adb 命令证伪；G5 的跨显示可达性连探针 APK 都要先做。先把最便宜的一票（G2 派单实测）与最便宜的一天（G4 探针）打出去，再决定要不要动大工程。

### 3.3 主线暴露面：必须划子集（初版缺失，本版补）

这是读者读完会问的第一个问题：**主线到底暴露哪些工具？** 三个事实放在一起，答案不优雅但必须写：

1. amoo 建议的 `khyos_exec` 是 **exec 形状**的接口（command/args/shell/cwd/timeoutMs → stdout/stderr/exitCode，`AMOO-INTEGRATION.md:178-180`）；
2. 本文硬规则 1 与 `LoopModes.java:62-63` 判 `exec`/`rm` 为高危，§六 规定它们在**无确认面的入口一律拒绝**；
3. `KhyAppFunctions.java:36-43` 已经用同一立场划过一次线：`exec`/`rm`/`write`/`mv`/`cp` 与反代 loop 工具**不作 AppFunction 暴露**，理由原文是「an AppFunction is reachable by the assistant's router with no foreground window and no confirmation surface, which is precisely the shape in which a destructive file operation must not be offered」。

**所以主线给不出 amoo 要的那个 `khyos_exec` 全形状，除非人重新裁决硬规则 1。** 本文建议的暴露子集（**待人批准，不是已定**）：

| 层 | 工具 | 理由 |
|---|---|---|
| 第一批（只读观察） | `ping`/`info`/`tools`/`ui_dump`/`shot`（路径）/`ls`/`read`/`stat` | 无副作用；与 `KhyAppFunctions.EXPOSED`（`:91-95`）的既有取舍同构 |
| 第二批（有界写） | `write`/`mkdir`/`toast`/`notify`/`share_text`（`/sdcard/khy-os` 工作区内） | 可被 `LoopVerify.READ_EQUALS` 验证；`rm`/`mv`/`cp` 仍在外 |
| **不开放** | `exec`/`rm`/`ui_type`/`amoo_*`/`secret_*`/`loop_*` | `exec`/`rm` 命中硬规则 1；`ui_type` 是既知的绕过 `forAmoo` 通道（`AMOO-INTEGRATION.md` §五）；`secret_*` 是凭据面，与 N1 同源 |

**未解**：若 amoo 坚持要 exec 形状（它给的接口约定就是那样），是「谈一个更窄的接口」「按任务级人工授权后开放」还是「放弃主线」，**由人裁决，本文不自决**。这条同时是 §九 的未决项。

### 3.4 分支规则（步骤 2 出结果之后怎么走）

| 步骤 2 结果 | 走向 | 裁决人 |
|---|---|---|
| **有派单记录**（logcat 见 `KhyAppFunctions: execute function=`） | AppFunctions **升级为主线候选**——按 `AMOO-INTEGRATION.md:361-363` 原文「有 → §六 主线要重新评估」；MCP-over-AIDL 降为中期目标。**注意前置**：派单成功只证明「能被调用」，不证明「调用结果是安全的」——§六 AppFunction 出口行的处置仍要先做 | 人（AI 不自决主线取舍） |
| **无派单记录，且四条混淆因子已逐条排除**（见 §四 步骤 2 前置） | MCP-over-AIDL 坐实主线，按 §3.3 子集推进 | 人（确认前置已排除） |
| **无派单记录，但混淆因子未排除** | **不许下任何结论**，回到前置重做；「缺口在助手侧路由」这句话在有混淆因子时不成立 | — |

---

## 四、落地步骤与门槛

> 七步。**每步的门槛都是「可判定的观察」，不是「感觉对了」**；门槛未达不进入下一步。所有探针输出（命令 + 原始输出）落 `works/data/khy/feedback/`（B8：临时文件不进仓库根）。**每步标了验证分区：〔主机〕= 不需设备；〔设备〕= 必须真机/adb。**

### 步骤 0（新增）｜借鉴提案先行 —— B-P2 六字段（〔主机〕）

**动作**：方案 1 的落地命中 `[DESIGN-SOURCING-001]` B-P1 的两个触发——「新增了一个此前不存在的对外契约（新协议消息）」（B-P1 第二条）与「首次引入某个上游项目的实现方式」（B-P1 第三条，`FEATURE-OWNERSHIP.json` 的 `source` 为新值）。按 **B-P2.1「先提案、后编码」**，步骤 4 写第一行代码前必须备齐六字段：

```
【借鉴提案】（[DESIGN-SOURCING-001] B-P2 模板，:176-188）
1. 借鉴对象：AiLauncher / com.stepos.mcp.sdk —— 版本/commit 待探针确认（`AMOO-INTEGRATION.md` §六 两个未决）
2. 借鉴内容：MCP-over-AIDL 的对外契约形状（manifest 声明 + mcp.tools 资源 + AIDL 接口签名级结构）
3. 解决的问题：amoo 旁路必须占前台约 6 分钟（AmooLoop.java:296-306；AMOO-INTEGRATION.md:40-41）
4. 许可证与代码性质：无法在仓内确认 → 按 B-S4.1 最严档 idea 处理（不因为「大概是 MIT」放行）
5. 借鉴方式：idea（只取结论、本仓自写、不留上游痕迹）——从 amoo dex 反编译得到的代码不进源码目录（N8）
6. 落点与现有实现对比：a. 落点 = 新 service + manifest（本提案新增能力域）；b. 现有同类实现 =
   KhyAppFunctions（AppFunction 面，已在仓）——本提案是「第二条入站形状」而非复用扩展，须写明为何
   不复用 AppFunction（amoo 侧派单未证实）；6b 的四步检索结论（B-U2.1）写进提案
7. 验收方式：§四 步骤 4/5 的门槛（装机 dumpsys 可见 + 宿主侧 bind + 端到端一次）
```

**门槛**：六字段齐全、`method` 判定有依据、`FEATURE-OWNERSHIP.json` 的 `source` 登记（B-M2：项目名 + 版本/commit + 借鉴内容一句话）**与 `rollout.mechanisms[]` 是两件不相干的事**——后者本文明确不登记（N6），前者是 B-M2 的归定义务，步骤 4 落地时必须做。

### 步骤 1｜设备探针先行（半天，不改产品代码）〔设备〕

**动作**：`adb shell cat /proc/net/unix` 与 `ss -lx` 确认 AiLauncher 有无本地监听抽象套接字；同时确认 `AMOO-INTEGRATION.md` §六 记的两个未决（`AbsMCPService` 的具体继承方式、`mcp.tools` 资源的格式）。

**门槛**：

- **主证是 `/proc/net/unix`**（AOSP toybox 不保证含 `ss`）。`ss` 不存在、非零退出、空输出，三种结果**都要原样落盘**；「命令缺失/无输出」**不得**读成「无监听」——那正好会产出想要的证伪结论。
- 探针记录（命令 + 原始输出）落盘，两问各有明确答案。**套接字若命中**，先按方案 2 走通握手再回主线；**未命中**则方案 2 正式降级为不可行，工程份量全部收回主线。
- 两个 SDK 未决问**可能要对真机反复试错**（`AMOO-INTEGRATION.md` §六 自陈「上次已经在权限方向上判断错过一次」），**半天不包含试错预算**——超了就如实记超了，不压缩成「已确认」。

### 步骤 2｜派单闸门实测（最便宜的一票）〔设备〕

**动作**：用已装机、描述已进索引的 11 个 AppFunction（`KhyAppFunctions.java:91-95` 的 `EXPOSED`）让 amoo 派一次单，看 logcat 有没有 `KhyAppFunctions: execute function=`（该行在 `KhyAppFunctions.java:115`，拒绝调用也会打 `refused caller=`）。

**前置（初版缺失，负结果不可解释就源于此）**：

1. **必须重装**：dump 里的元数据是包变更时同步进 AppSearch 的，改完 assets/manifest 不重装会把「没生效」误判成「加了也没用」（`AMOO-INTEGRATION.md:330-331`）；
2. **parameters 进索引仍未验证**（`:327-328`，要等设备）——先 `dumpsys app_function` 确认我方区段出现 `"parameters": [{...}]`，否则模型看得见函数、看不见要传什么；
3. **proxy「6 声明 1 收录」的挑选规则未查明**（`:344-345`）；
4. **Amoo 侧 `AppFunctionSearchSpec` 四维度参数拿不到**（`:346-348`）——可能按 schema 过滤，「没派单」与「被过滤」现象相同。

**门槛**：派单记录（含调用方与函数名）落盘；**负结果必须附四条前置的逐条排除记录**，排除后仍无派单，才允许说「缺口在助手侧路由」（分支走向见 §3.4）。**探针期间暴露面应临时收窄到只读观察工具**（`ping`/`info`/`tools`/`ui_dump`/`shot`）——这一票本质是请 amoo 往一个**无档位门、无净化**的出口打（§六 AppFunction 行），不收窄就是拿无净化出口做实弹测试。

### 步骤 3｜安全边界先行（纯逻辑、可单测，不动既有语义）〔主机〕

**动作**：为 ability 入口建允许清单与档位表——

- `HIGH_RISK_TOOLS`（`LoopModes.java:62-63` 的 `exec`/`rm`）在新入口**一律拒绝而非就地确认**（此入口无确认面）；
- `LoopModes.execDangerReason`/`floorReason`（`:289`、`:176`）接到入口最前，与 loop/HTTP 两个入口判语一致；
- **预算归属先定界再动手**：`resetSessionBudget()` 的既有语义是**按轮重置**（`Tools.java:1488` 注释「重置一轮的预算。AmooLoop 起轮时调」；`:2145-2147` 明写 `loop_start` 才是「开始一个任务」的显式信号、`ask` 的多次调用**本该共享同一份预算**；`:2201-2204`「一次独立的 `amoo_ask` 也是一轮」）。ability 路径每次入站都是独立调用、**没有「轮」边界**——按次重置等于把 8MB 读出 / 2000 条列举 / 50 个复制（`Tools.java:1475,1478,1486`）退化为每次调用的额度，N 次调用无累计上限。**步骤 3 必须先定义 ability 路径的「任务」是什么**（候选：以 amoo 会话轮 / taskId 为界，界内累计、跨界拒绝；或显式设单次调用更紧的上界并在自描述里告知），**定义不出来就不调 `resetSessionBudget`**；
- 出口统一过 `AmooSafe.forAmoo`（`AmooLoop.java:1335-1342`，fail-closed：净化自身抛异常不发原文）。

**门槛**：

- JVM 单测钉住「每个 ability 工具名 → 档位」，且**枚举 `Tools.NAMES` 全 48 项**——含 `KNOWN_TOOLS`（`LoopModes.java:71-77`，36 项）之外的 12 个（`amoo_*` 四、`zip`/`unzip`、`secret_*` 四、`tools`、`adou_signin`），图省事复用 `KNOWN_TOOLS` 会漏判（§7.1、§8.3 D4）；
- `AmooSafeHostAuditTest` 全绿；
- **危险命令在 ability/HTTP/loop 三个入口判语一致**（三个入口一张表，不许各写一份）；
- **预算累计场景有单测**：同一「任务」内 N 次调用的读出/列举/复制**累计**触界，而不是每次调用各自满额；
- **上报措辞与记账**：机器拒绝必须报「机器拒绝」及其原因，**不得沿用现存归因错误**（`AMOO-INTEGRATION.md` §五：安全底拒绝被 `describeStop` 报成「人工中止」，且 `writePending` 不把被拒命令记进 `executed`——`executeOne` 在 `executed.add` 之前就返回了，只有日志里有原因）；被拒命令必须进 `executed`/审计流。

### 步骤 4｜实现 provider 侧（B-P2 提案通过后）〔设备〕

**动作**：按探针结论**自写** AIDL 与 service（不从 amoo dex 反编译代码、不 vendor 其类）；manifest 照 AiLauncher 的 `VoiceAbilityService` 样例声明 `TOOLS_SERVICE` + `mcp.tools`；工具描述从 `Tools.CATALOG`/`ROUTING`（`Tools.java:293,391`）派生，与 AppFunctions 同源不手抄。

**门槛**：

- 装机后 `dumpsys package` 可见该 service；宿主侧能 list 到全部工具且**描述与 CATALOG 逐字一致**（漂移由既有 `catalogDrift` 测试方向兜底，`Tools.java:1403-1415`）；
- **验证绑定方向，不只是可见性**：`android:permission` 在 service 上的含义是「谁才能 bind 我」（`AMOO-INTEGRATION.md` §六 自陈已为这个方向判断错过一次），所以门槛必须包含**amoo 作为宿主实际 bind 进来并完成一次 list/call**——`dumpsys` 可见但 bind 不上，正是上次那种「方向对了一半」的失败形态；
- B-P2 六字段提案已齐（步骤 0）、`FEATURE-OWNERSHIP.json` 的 `source` 已登记（B-M2）。

### 步骤 5｜接进既有执行链〔设备〕

**动作**：`ability.call` → 档位门 → `Tools.dispatch` → `LoopVerify.plan` 验证 → `AmooSafe` 净化后返回；每次调用同时写进 `amoo_turn` 观测流（provider 自己就是遥测源，替代 6 分钟气泡轮询；**这是新接线，不是原样搬进**，§3.2(c)）。

**门槛**：端到端一次 `write` 返回 `READ_EQUALS`「已验证」；一次 `exec` 危险命令被拒且理由进 pending 文件；**ability 返回值过 `forAmoo`**（不得成为第三个出口，§六）；`ui_type` 原文不进 amoo 上下文（`AMOO-INTEGRATION.md` §五 已知缺陷不借道扩大）。

### 步骤 6｜入口与自描述〔设备〕

**动作**：任务经既有 `AmooService.shareText` 交给 amoo（一次性闪现而非驻留，`amoo_service.dart:51`）；`AmooSelfDesc`/`SelfDesc` 增加一节「你可以直接调用本机能力」；最终回复的回流在三选一里定（ability 回调 / amoo 写工作区文件 `/sdcard/khy-os` / 用户去 amoo 看）。

**门槛**：`renderCarriesNoInternalIdentifiers`（`AmooSelfDescTest.java:154-175`，断言不含 `com.khyos`/`8896`/`/sdcard/`/`/data/`）仍绿——**守这条不变式的是这个测试，不是 `AmooSafe.wouldChange`**（`AmooSafe.java:313-321` 答的是「净化器会不会改这段文本」，另一个问题，可作辅助）；真机一次「分享 → amoo 回调 ability → 执行 → 净化结果返回 → amoo 继续」全链走通、**khyos 全程不读一个气泡**。

### 步骤 7｜观察面收口 + 保底件并行上线〔设备〕

**动作**：悬浮框面板（`BridgeOverlayService.java:463-490`）与 `amoo_task_card` 改读 ability 调用流（**新接线**：面板今天读的是 `AmooLoop.progress()`/`elapsedMs()`/`lastWriteBack()` 这些 loop 路径内存 getter，ability 路径一个都没有）；同时把与探针无关的排队语义（第二个提问不再被 `return null` 拒掉，`AmooLoop.java:264` 的单飞现状）先落地，保证探针全败时用户手里也有可用形态。

**门槛**：杀进程重启后未结算行仍被回收为 `interrupted`（`amoo_turn_store.dart:160-178`）且提示「去 amoo 看看」；连续 10 次 ability 调用在悬浮框有步骤显示；两个并发提问不再互相拒绝。**并发提问的产品形态未定，须先裁**：第二个提问是排队、合并、还是换一个新的错误码？`amoo_turn` 五态（`:15-29`：pending/running/done/failed/interrupted）要不要为此加态？**本文建议排队 + 不加态**（复用 pending/running，UI 明示「排队中」），但这是产品决定，由人拍。

---

## 五、不做清单

| # | 不做 | 为什么 |
|---|---|---|
| N1 | 不读取、不导出 amoo 的模型密钥、baseUrl、会话历史或私有目录 | `[DESIGN-ARCH-193]` §7.2 判为物理上做不到（非 root 读不到第三方私有目录，写了也是死代码），§7.6 凭据纪律禁止 |
| N2 | 不走 root、不做系统签名/固件预置/特权伴侣形态 | `AMOO-INTEGRATION.md` §六 明令「不要走 root」；stepx 的 `WRITE_SECURE_SETTINGS`/同签名 Companion 形态不照搬（G3 出局） |
| N3 | 不把「像用模型一样用 amoo」做成产品能力 | amoo 旁路保持任务级、手动触发，不做默认聊天后端、不做流式。`[DESIGN-ARCH-193]` §7.5 的三条约束（分钟级单轮、只能单发、必须在前台）里本方案只消掉「必须在前台」一条 |
| N4 | 不动 `AMOO-INTEGRATION.md` §五 已裁决「暂缓」的五个安全缺口；不借新通道扩大 `ui_type` 绕过 `forAmoo` 的洞 | `AmooSafe`、LoopModes 安全底、Tools 预算门的语义一条不减。**如实记**：该洞在现有 AppFunction 出口上**已经存在**（`EXPOSED` 含 `ui_type` 且返回不过净化，`KhyAppFunctions.java:91-95,162-181`；`LoopModes.uiTypeFloorReason` 的「故意留开」清单 `:225-229` 只想到 HTTP 与信箱，未含此面；`AMOO-GUIDELINES.md:145` 自陈「工具结果本身还没做这个处理。这是缺口」）——N4 约束的是**新通道不成为第三个出口**，既有那个出口的处置（收窄/关闭/接受）是人的决定，本文不自决 |
| N5 | 不做对标清单里 relevance=low 的项 | 清单原文（转引自本轮任务输入，relevance 分级由该输入给出，本文未重新评定）：**投屏/mirror、通知同步、应用商店与 APK 校验链、adb 配对自动化、模型密钥保险箱分层、SAF 取回入口**。列在此处以便读者核对，不必外翻 |
| N6 | 不新增 npm script、khy CLI 命令与规则登记 | 可交付性棘轮只降不升（`[DESIGN-DELIV-002]`）；本方案是设计文档、不是拦截机制，不触发 `PROCESS-008`，也不需要新守卫。**补一条初版漏写的提示**：若日后把「三入口一张表」这个不变式交给 CI 守，那将是一个**新的拦截型机制**，须按 `PROCESS-008` 从 S1 起步另行立项——本文不预埋那个口子 |
| N7 | 不改 amoo 本体、不要求 amoo 升级配合 | LOCAL 能力约定是它自己在 `AMOO-INTEGRATION.md` §六 建议并给过接口形状（`khyos_exec`）的那一条 |
| N8 | 从 amoo dex 反编译得到的任何代码不进软著登记材料、不进源码目录 | `PROCESS-010` C-X3；`[DESIGN-SOURCING-001]` B-S4.1（仓内无法确认许可证 → 最严档 idea）；自写 AIDL 与实现须做到人能解释（C-X2） |

---

## 六、安全边界不削弱声明

> 本节是**契约**，不是姿态。新通道每开一个入口，下面每一行都要逐条对上；对不上就是回归，按回归处理。**标注〔loop-only〕的行对 ability 路径不适用**——不删，因为它们守的是 loop 路径，且「不适用」本身是结论。

| 既有安全件 | 位置（本轮已读） | 新通道如何继承 |
|---|---|---|
| 安全底优先于一切模式（含 BYPASS）；不可判定收敛为 CONFIRM 而非抛异常 | `LoopModes.java:13-38`（类注释；「cannot be judged resolves to the most conservative outcome (`Action#CONFIRM`)…stops the loop for a human」在 `:27-30`） | 档位门接到 ability 入口**最前**，与 loop/HTTP 同表同判 |
| 高危工具恒确认（`exec`/`rm`） | `LoopModes.java:62-63`、`:143-148` | ability 入口**无确认面 → 一律拒绝**（不是就地确认，不是降级放行）。**连带后果**：amoo 建议的 `khyos_exec` 全形状因此给不出，见 §3.3 |
| 出站净化单一咽喉，fail-closed | `AmooLoop.java:1335-1342`；`AmooSafe.java:298-309` 六个 pass 按序（resourceIds → appLabelPairs → absolutePaths → packageNames → bridgePorts → systemFingerprints） | ability 返回统一过 `forAmoo`，**新通道不得成为第三个出口** |
| **〔现状缺口·必须单列〕现有 AppFunction 出口不过净化** | `KhyAppFunctions.java:162-181`：`Tools.dispatch` 的返回值 `out.toString()` **原样**作为 AppFunction 结果，全函数无 `AmooSafe`/`forAmoo`/`LoopModes`；`EXPOSED`（`:91-95`）含 `ui_type`/`ui_tap`/`ui_click`/`ui_swipe`/`ui_dump`，`shot` 回路径（`:87-89`）；`LoopModes.uiTypeFloorReason` 的「故意留开」清单（`:225-229`）只想到 HTTP 与信箱，未含 2026-10-28 才出现的这个面；`AMOO-GUIDELINES.md:145` 自陈这是缺口 | **这不是新通道的锅，是新通道动工前必须面对的地物**：①步骤 2 探针期间把暴露面临时收窄到只读观察工具；②该出口的处置（收窄 EXPOSED / 返回过 `forAmoo` / 明确接受并留痕）**由人裁决**，本文不自决；③「出口只有一个」这条硬规则的准确表述是——**新通道不新增出口**，现状已有两个不过净化的出口（HTTP 桥按设计不过、AppFunction 按疏漏不过），逐步收口是另一个议题 |
| 净化器防误伤（不把文件名泛化成包名） | `AmooSafe.java:96`（`NOT_A_PACKAGE_SECOND`）、`:130`（`PACKAGE_FIRST`） | 原样继承，不改 pass 顺序与黑名单 |
| 会话预算门（8MB 读出 / 2000 条列举 / 50 个复制；`exec` 按 1MB+512KB 预占再结算） | `Tools.java:1475,1478,1486`（三项上限）、`:1543-1549`（preflightBytes）、`:2443,2446`（exec 预占）；**重置语义是「按轮」**：`:1488` 注释「重置一轮的预算。AmooLoop 起轮时调」、`:2145-2147`（`ask` 的多次调用本该共享同一份预算）、`:2201-2204` | **未决，不是已定继承**。ability 路径没有「轮」边界，按次重置 = 三项上限退化为每次调用额度、N 次调用无累计。步骤 3 必须先定义 ability 的「任务」边界（§四 步骤 3），定义出来之前**不得调用 `resetSessionBudget`** |
| 动作后验证只有三类可机检手段，其余一律 NONE 并要求标注「未能验证」 | `LoopVerify.java:22,58-85` | 原样继承（纯逻辑可直接调）；「执行成功 + 验证通过」才写 VERIFIED 记忆（`AmooLoop.java:1033-1041`） |
| CONFIRM/DEFER 是停机不是静默跳过（未执行的命令与原因交给人） | `LoopModes.java:13-38`（类注释，契约原文 `:27-30`）；`AmooLoop.java:682-702` | 新入口没有交互 UI，**拒绝即停机 + 落 pending 文件 + 通知**，问人就是写文件。**且不得继承现存归因错误**：`AMOO-INTEGRATION.md` §五 记「安全底拒绝会被报成『人工中止』……且 `writePending` 不把被拒命令记进 `executed`（`executeOne` 在 `executed.add` 之前就返回了），只有日志里有原因」——机器拒的必须报机器拒，被拒命令必须进 `executed`/审计流（步骤 3 门槛已含） |
| 未闭合围栏永不执行；处理过的气泡按 hash 记忆不重复执行 〔loop-only〕 | `AmooLoop.java:854-867` | loop 路径原样；ability 路径天然不读气泡，此条不适用但也不删 |
| pending 文件保持原文不净化（那是给人恢复的副本，从不叫 amoo 去读它） | `AmooLoop.java:79`（`PENDING_TXT` 常量）、**理由在 `:1276-1281`**（「The pending file is the HUMAN's recovery copy, not a channel to Amoo — so it keeps the raw text」） | 原样继承 |
| 孤儿自愈（超过 1,860,000ms 未结束释放单飞锁，两侧按 `orphaned_ask:` 前缀判档） | `AmooLoop.java:444,478-485` | 原样继承 |
| armed 仅内存、进程死即停且不续跑 〔loop-only〕 | `AmooLoop.java:86`（`armed` 是 loop 概念） | **对 ability 路径不适用但也不删**——ability 路径没有 `armed`，需另立「进程死即停」的实现（如不落任何跨进程续跑状态），步骤 5 落地时补 |
| 调用方白名单 + 拒绝也记日志 | `KhyAppFunctions.java:74-81,115-126` | ability 入口沿用同一形态；未知调用方拒绝且在原因里点名，便于从助手侧报错诊断 |
| 自描述不带内部标识符（包名/端口/绝对路径），有测试盯着 | `AmooSelfDescTest.java:154-175`（`renderCarriesNoInternalIdentifiers`：不含 `com.khyos`/`8896`/`/sdcard/`/`/data/`）；`SelfDesc.java:38-41`（渲染即泛化的约定；其注释提到的 `wouldChange(render())==false` 断言实际住在 `AmooSafeHostAuditTest.java:379`「自述文本不该被净化改动」） | 新增「你可以直接调用本机能力」一节同样过 `renderCarriesNoInternalIdentifiers`；`AmooSafe.wouldChange`（`AmooSafe.java:313-321`）只答「净化器会不会改这段文本」，两道断言各守一面（标识符 / 可复述），**互不替代** |
| amoo 红线反向约束我们 | `AMOO-GUIDELINES.md:56-63,138-145`（§5.2「工具结果本身还没做这个处理。这是缺口」） | 工具结果必须能被 amoo 安全复述；这份设计文档本身永不注入 amoo 上下文 |

**四条硬规则**：

1. **没有确认面的入口，高危工具一律拒绝。** 不是「更谨慎地确认」，是拒绝。判据表与 loop/HTTP 三入口一致，单测钉住。连带：amoo 要的 `khyos_exec` 全形状给不出（§3.3）。
2. **新通道不新增出口。** ability 的返回不过 `forAmoo` 就是第三个出口；现状已有的两个不过净化出口（HTTP 桥按设计、AppFunction 按疏漏）见上表，收口是人的决定，`ui_type` 那条已知绕过通道不借新通道扩大。
3. **暂缓的缺陷保持暂缓。** `AMOO-INTEGRATION.md` §五 已知缺陷表 2026-10-25 裁决「全部维持现状」，本方案不代为人改；新通道若让其中某条的危害面变大，正确动作是**上报人**，不是顺手修、也不是装作没看见。
4. **预算先定界再调用。** ability 路径的「任务」边界定义出来之前，不得调用 `resetSessionBudget()`；定义的原则是「界内累计、跨界拒绝」，不是「按次重置」。

---

## 七、验证手段与未实测声明

### 7.1 本轮已验证（静态读码 + 两次可复现检索）

- 全部 `file:line` 引用逐条打开读过（清单见 §八.2）；审读员独立抽查约 50 处 + `findstr /n` 复核一致。
- `Tools.NAMES` 逐个手数 = **48 项**（`Tools.java:257-268`）。
- 全树检索（main java + kotlin + lib）：`VirtualDisplay` 9 命中**全在** `ScreenCaptureService.kt`（`:15,66,89,90,95,182,205,292,293`，AUTO_MIRROR 抓屏形状）；`localabstract`/`LocalSocket`/`setLaunchDisplayId`/`IMCPBinder`/`TOOLS_SERVICE`/`mcp.tools`/`AlarmManager`/`WorkManager`/`JobScheduler` **零命中**（命令、输出与**正对照**见 §八.1）。
- `LoopModes.KNOWN_TOOLS` = **36 项**（`LoopModes.java:71-77`），与 `NAMES` 48 的差集 12 个（`amoo_*` 四个 + `zip`/`unzip` + `secret_*` 四个 + `tools` + `adou_signin`）——**新入口的档位表不能图省事复用 `KNOWN_TOOLS`**，未知工具按 `LoopModes` 自身契约收敛为 CONFIRM（`:13-38` 类注释）。
- **Android 侧测试规模实测（2026-11-03，本版补测）**：`android/app/src/test` 下 **32 个 `*Test.java`**、**507 个 `@Test`**（命令与输出见 §八.1）。初版引 `[DESIGN-ARCH-193]` E4 的「11 suite / 216 testcase」是 **2026-10-23 的快照**，且 suite 数 / 测试文件数 / `@Test` 数**不是同一量纲**——`AMOO-INTEGRATION.md:328`（2026-10-29）记「27 suite / 446 测试」、`:150` 记「26 套件 439 断言」，三个数互不相同是量纲与时间差造成的，本文取实测现值。

### 7.2 主机侧可验（不需设备）

| 手段 | 命令 / 位置 | 验什么 |
|---|---|---|
| JVM 单测 | `cd delivery/mobile/khy-os-client-app/android && gradlew.bat :app:testDebugUnitTest`（现状规模：32 个 `*Test.java` / 507 个 `@Test`，§7.1 实测） | 步骤 3 的全部门槛：档位表逐工具（48 项全枚举）、三入口判语一致、预算累计场景、`AmooSafeHostAuditTest` 全绿、`catalogDrift`/`ParamsDriftTest` 不红 |
| 自描述测试 | `AmooSelfDescTest`（`:154-175` `renderCarriesNoInternalIdentifiers`、`:160-163` 无包名/端口/绝对路径、`:188-219` 措辞钉住） | 步骤 6 的新章节不引入内部标识符 |
| Dart 测试 | `flutter test`（`[DESIGN-ARCH-193]` E3 留档：257 通过 / 1 失败，失败点是「内置密钥全空」） | 排队语义与 `amoo_turn` 回收（步骤 7 的 Dart 侧） |

### 7.3 需设备（adb / 真机）——初版把步骤 4/6 错放进主机侧，本版更正

| 项 | 为什么主机替代不了 |
|---|---|
| AgentBus 本地监听是否存在（步骤 1） | 要读真机 `/proc/net/unix`；`ss` 可能不存在 |
| 装机后 `dumpsys package` / `dumpsys app_function`（步骤 2/4） | 要装包、要设备 |
| logcat 派单记录 `KhyAppFunctions: execute function=`（步骤 2） | 助手侧路由行为；且那两次既往失败发生在描述进索引之前，今天重测胜率不同 |
| **宿主侧实际 bind（步骤 4）** | 「可见」不等于「bind 得上」——上次正是在权限方向上判断错过一次 |
| ability 端到端（分享 → 回调 → 执行 → 净化返回 → amoo 继续，步骤 5/6） | 跨进程 + 跨应用，主机无对方 |
| VirtualDisplay 跨显示可达性（G5） | a11y 跨显示语义是平台行为，读码读不出来 |
| `AbsMCPService` 继承签名与 `mcp.tools` 资源形状 | 要对真机上的宿主 SDK 实际形态确认，可能要反复试错 |
| `ui_type` 实际到达形态（中文/多行/emoji、SET_TEXT 替换还是追加） | `AMOO-INTEGRATION.md` §五 自陈未验；`chars` 是发出长度不是到达长度 |
| parameters 是否真进了 AppSearch 索引 | `AMOO-INTEGRATION.md:327-328` 自陈要等设备 |

### 7.4 未实测声明（逐条写明，不许当已通过）

1. **未跑构建**：没有 `assembleDebug`/`assembleRelease`。
2. **未跑测试**：没有 `flutter test`、没有 `gradlew test`、没有 `node --test`——§7.2 的规模数字是**静态计数**（`dir`/`Select-String`），不是测试运行结果；本文所有「测试通过」表述都是既有留档或步骤门槛，不是本轮结果。
3. **未做任何真机验证**：§四 各步里的探针（`/proc/net/unix`、`ss -lx`、派单实测、bind 验证、端到端）**全部是待执行项**。
4. **未联网复核 stepx 侧**：AiLauncher manifest 样例、SDK 类名、AgentBus 自陈、AppFunctions 两次实测，均转引自本轮任务输入与仓内文档，未重新抓取、未复跑。
5. **索引缺登的准确范围（初版以偏概全，本版限定）**：缺登只对 `00_INDEX_设计-分类索引.md` 成立——该表从 191 跳到 200（本文补登了 200 一行）；**`00_INDEX_DESIGN-ARCH-总目录.md` 已逐条收录 192–199（`:201-208`）与 200（`:209`）**。192–199 未入分类索引表这个既有缺登，本文只补自己一行，未代劳补登那八篇。

---

## 八、证据表与文档漂移记录

### 8.1 本次可复现检索（命令 + 原始输出）

**负检索（与审读员用同款命令独立复跑，结果逐字一致）**：

```text
# 对 main java + kotlin + lib 全树（*.java / *.kt / *.dart）检索：
#   VirtualDisplay|localabstract|LocalSocket|setLaunchDisplayId|IMCPBinder|
#   TOOLS_SERVICE|mcp.tools|AlarmManager|WorkManager|JobScheduler
=== .../android/app/src/main/java : 0 hits ===
=== .../android/app/src/main/kotlin : 9 hits ===
ScreenCaptureService.kt:15  import android.hardware.display.VirtualDisplay
ScreenCaptureService.kt:66  private var virtualDisplay: VirtualDisplay? = null
ScreenCaptureService.kt:89  // `setupRotation` is the rotation the VirtualDisplay was created under.
ScreenCaptureService.kt:90  // `createVirtualDisplay` fixes the surface geometry at that moment, so a
ScreenCaptureService.kt:95  /** Surface rotation captured when the VirtualDisplay was created. */
ScreenCaptureService.kt:182 virtualDisplay = projection?.createVirtualDisplay(
ScreenCaptureService.kt:205 * values the VirtualDisplay was built from — what we asked for.
ScreenCaptureService.kt:292 virtualDisplay?.release()
ScreenCaptureService.kt:293 virtualDisplay = null
=== .../lib : 0 hits ===
```

**正对照（同一条命令换必定命中的关键词，证明路径/pattern/工具链没坏）**：

```text
# 同款命令，pattern 换成 AmooLoop|KhyUi|AccessibilityService
=== .../android/app/src/main/java : 118 hits ===   （例：AmooChatText.java:35,184,292）
=== .../android/app/src/main/kotlin : 38 hits ===  （例：KhyAccessibilityService.kt:4,5,24）
=== .../lib : 3 hits ===                            （例：amoo_chat_service.dart:275）
```

**读法**：VirtualDisplay 的 9 个命中全部是 AUTO_MIRROR 抓屏（`ScreenCaptureService.kt:185` 的 `VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR`），**没有一处是承载 activity 的形状**；其余九个关键词零命中；正对照证明「零命中」不是命令坏了。这与方案 3 的风险陈述一致，也与方案 2 的证据倾向一致。

**其它本轮实测**：

```text
# MainActivity.kt 字节级换行计数（[System.IO.File]::ReadAllBytes）
bytes=97741  LF=2083  CR=0  loneCR=0  streamReaderLines=2083  (Get-Content).Count=1939
# findstr /n 复核行号口径
findstr /n /c:"private fun amooAskResult" MainActivity.kt  →  1699
# Android 侧测试规模（2026-11-03）
cd android\app\src\test && dir /s /b *.java | findstr /i "Test.java$"   → 32
Select-String -Pattern '@Test' over src\test\**\*.java                  → 507
```

### 8.2 本文引用的关键行（逐条本轮打开过；审读员指正 3 处已改）

| 主题 | 位置 |
|---|---|
| amoo 定位常量 | `AmooLoop.java:72-75` |
| 前台预检 | `AmooLoop.java:296-306` |
| 单飞锁 | `AmooLoop.java:264` |
| 反代 preamble / askResult / runAsk | `AmooLoop.java:385-397`、`:418`、`:535-555` |
| 孤儿自愈 | `AmooLoop.java:444,478-485` |
| 围栏优先 + hash 记忆 〔loop-only〕 | `AmooLoop.java:854-867` |
| 三态写回 / VERIFIED 记忆 | `AmooLoop.java:682-702,1033-1052` |
| 出口单咽喉 forAmoo | `AmooLoop.java:1335-1342`；`AmooSafe.java:298-309`（六 pass）、`:96,130`（防误伤）、`:313-321`（`wouldChange`，仅辅助） |
| pending 兜底（常量 + 理由） | `AmooLoop.java:79,1276-1281` |
| armed 〔loop-only〕 | `AmooLoop.java:86` |
| 工具面 48 项 + 目录 + 路由 | `Tools.java:257-268,293,391` |
| 预算门（三项上限 + preflight + exec 预占） | `Tools.java:1475,1478,1486,1543-1549,2443,2446` |
| **预算按轮重置（不许按次）** | `Tools.java:1488`（「重置一轮的预算」）、`:2145-2147`（ask 的多次调用共享同一份预算）、`:2201-2204`（一次独立 amoo_ask 也是一轮） |
| exec 三级链 | `Tools.java:2759-2801` |
| 档位与安全底 | `LoopModes.java:13-38`（类注释，`:27-30` 不可判定→CONFIRM）、`:62-63,143-148`（高危恒确认）、`:66-77`（KNOWN_TOOLS 36）、`:117-153`（decide）、`:176-191,289`（floorReason/execDangerReason）、`:225-244`（uiTypeFloorReason 及其「故意留开」清单） |
| 验证三态 | `LoopVerify.java:22,58-85` |
| AppFunction 暴露面 | `KhyAppFunctions.java:16-56`（类注释，`:36-43` 不暴露的理由）、`:74-81`（白名单）、`:87-95`（EXPOSED + shot 回路径）、`:107-182`（`:162-181` 派发与原样返回，**无净化**）、`:115`（logcat 探针标记） |
| 参数真源与生成器 | `KhyUi.java:72`；`scripts/generate-appfunctions-metadata.js` |
| 无障碍取屏与判活 | `KhyAccessibilityService.kt:57-65,85-88,118-162,169,249,285,314-315,327-329,350-359`（`:358-359` 钉死 DEFAULT_DISPLAY） |
| 抓屏虚拟屏形状 | `ScreenCaptureService.kt:182,185,224-228` |
| Shizuku 免 root 提权 | `ShizukuServiceManager.kt:53,93-97,110-116` |
| 回环绑定 | `HttpBridge.java:271,317-321` |
| a11y 看守 | `BridgeService.java:119,131,170-172` |
| 悬浮框零 IO | `BridgeOverlayService.java:79-85,161-173,199,207,433-439,463-490` |
| MethodChannel 三通道 / 分享 / 拉起 / 保屏 | `MainActivity.kt:331-337,1533-1633,1698-1718,1723-1733,1744,2067-2068`；`amoo_service.dart:8,23,51,97,183-186` |
| Dart 侧三通道与失败分档 | `amoo_chat_service.dart:27,50-61,92,168-203` |
| 卡片与五态 | `amoo_task_card.dart:104,219,233-240,344`；`amoo_turn.dart:15-29`；`amoo_turn_store.dart:160-178` |
| 自描述派生与测试 | `AmooSelfDesc.java:46-52`；`SelfDesc.java:38-41,55,63,71-79,107-111,120-131,289-298`；`AmooSelfDescTest.java:154-175,160-163,188-219`；`AmooSafeHostAuditTest.java:379`（`wouldChange(render())==false`） |
| PC 侧自动拉前台 / bridge 门 | `amooDispatchRunner.js:408`；`amooBridgePolicy.js:339-340`；`contracts.js:88,346,486,509` |
| 共享工作区 | `MainActivity.kt:65,1804` |
| 仓内 amoo 文档 | `AMOO-INTEGRATION.md`：`:40-41`（6 分钟根本限制）、`:60`（AgentBus 420 处引用，**帧协议细节仓内无出处**）、`:178-180`（`khyos_exec` 接口约定）、`:216-224`（两次派单失败，**描述进索引之前**）、`:279-296`（schema 实验 description 0→11）、`:327-328`（parameters 未验）、`:330-331`（必须重装）、`:344-348`（proxy 挑选规则 + SearchSpec 两因子）、`:355-358`（机制层已通、MCP 唯一性打问号）、`:361-363`（有派单→主线重新评估）、`:368`（能索引≠能调用）；`AMOO-GUIDELINES.md:56-63,138-145`（§5.2 自陈工具结果未净化的缺口） |
| 借鉴规范 | `[DESIGN-SOURCING-001]`：`:159-166`（B-P1 两触发）、`:171-188`（B-P2 六字段模板）、`:190-192`（B-P2.1 先提案后编码）、`:136-142`（B-M2 归因/source 登记）、`:93-94`（B-S4.1 无法确认许可证→最严档 idea） |
| 193 引用点 | `[DESIGN-ARCH-193]:270,311,373-381,390,408-437,439-445` |

### 8.3 文档漂移记录（本轮发现，以代码为准）

| # | 漂移 | 现状 |
|---|---|---|
| D1 | `AMOO-INTEGRATION.md` §二/§三 与 `[DESIGN-ARCH-193]` 多处写「39 个工具」 | `Tools.NAMES` = **48**（`Tools.java:257-268` 手数）；自描述按 `NAMES` 派生（`SelfDesc.java:71-79`），所以注入给 amoo 的清单已经是 48 个名字，两处文档的数字是旧快照 |
| D2 | `[DESIGN-ARCH-193]` §7.5 待建清单第 1 条「Flutter→原生 `amoo_ask` 通道（`MainActivity.kt:56-160` 现无此方法）」 | **已落地**：`MainActivity.kt:331-337` 三通道已在，`amoo_task_card.dart` 已在调；该文档此条过期 |
| D3 | `AMOO-INTEGRATION.md` §五 已知缺陷「自描述告诉 Amoo『手机存储对你不存在』」（引 `AmooSelfDesc.java:154`） | 代码已携带更正措辞：`SelfDesc.java:122-125`「手机的共享存储……你已经实测往里面写过文件。要读写它就带绝对路径，**不要说『手机存储对我不存在』**」，且 `AmooSelfDescTest.java:188-219` 把新措辞钉住。该缺陷条目与代码不一致（2026-10-25 裁决「暂缓」之后代码又动过） |
| D4 | `[DESIGN-ARCH-193]` E6 记 `KNOWN_TOOLS=36`、差集正是三个 amoo 工具 | 今天 `NAMES=48` vs `KNOWN_TOOLS=36`，差集 **12** 个（新增 `zip`/`unzip`/`secret_*`/`tools`/`adou_signin`）；差集变大不影响 fail-closed 语义，但档位表若图省事复用 `KNOWN_TOOLS` 会漏判 |
| D5 | `AMOO-INTEGRATION.md` §6.1 自称「最便宜的下一步」 | 本轮任务输入已把它列为步骤 2 的门槛；本文 §四 步骤 2 沿用，未改变其「唯一待办」的定性 |
| D6 | **代码注释里还有第三处「39 个工具」旧快照**（审读员补） | `Tools.java:283`「于是调用方知道『有 39 个工具』」——而它是下一个读代码的人会撞上的那一处；同文件 `:257-268` 的真实值是 48 |
| D7 | `AMOO-INTEGRATION.md:136` 记「主机侧只有 32 个 `AmooSafeTest` + 13 个 `AmooSafeHostAuditTest`」 | 实测（2026-11-03，`Select-String '@Test'`）：`AmooSafeTest` **32** ✓、`AmooSafeHostAuditTest` **26** ≠ 13。量纲（测试方法数 vs 断言数）或时间差所致，以实测为准 |

---

## 九、仍未验证 / 做不到（汇总）

| 项 | 状态 |
|---|---|
| 第三方自注册 provider 能否被 amoo 派单（G1/G2 的共同前提） | **未取证**。AppFunctions 机制层通、助手路由层两次实测不通——**且那两次在描述进索引之前**（`AMOO-INTEGRATION.md:216-224` vs `:279-296`），今天重测胜率不同；步骤 2 就是去打这一票，四条混淆因子未排除前负结果不可解释 |
| `AbsMCPService` 继承签名、`mcp.tools` 资源形状 | **未决**（`AMOO-INTEGRATION.md` §六 自陈；步骤 1 探针，可能要反复试错） |
| AgentBus 本地监听是否存在（G4） | **未取证**，证据倾向不存在（`AMOO-INTEGRATION.md` §一 自陈不开入站端口 + 本轮零命中）；步骤 1 一条命令证伪。**帧协议那组细节仓内无出处**（转引本轮任务输入），命中后不能凭它写客户端 |
| VirtualDisplay 跨显示可达性（G5） | **未取证**；不押工程份量，除非探针反转。截图改 `DEFAULT_DISPLAY` 是确定要做的改造 |
| **`khyos_exec`（exec 形状）与硬规则 1 的冲突** | **未决，需人裁决**：谈更窄的接口 / 任务级人工授权后开放 / 放弃主线，三选一（§3.3） |
| **现有 AppFunction 出口（无净化、含 `ui_type`）的处置** | **未决，需人裁决**：收窄 EXPOSED / 返回过 `forAmoo` / 明确接受并留痕（§六） |
| **ability 路径的「任务」边界（预算归属）** | **未定义**：按轮重置的语义无法直接搬到按次入站；定义出来之前不调 `resetSessionBudget`（§六 硬规则 4） |
| B-P2 六字段提案与 `FEATURE-OWNERSHIP.json` source 登记 | **未做**；按 `[DESIGN-SOURCING-001]` B-P2.1，步骤 4 编码前必须完成（步骤 0） |
| ability 入口的档位表与三入口一致性 | **待建**（步骤 3），主机可验 |
| 端到端（分享→回调→执行→净化→返回） | **未做**，只在真机可验（§7.3） |
| 「amoo 读泛化文本后还能不能行动」 | **做不到在主机验**：模型行为问题；`AMOO-INTEGRATION.md` §五 保留审计的预测是「任何按路径寻址的事都做不了」——新通道同步返回结构化结果，反而可能改善这条，但**这是预测，不是已验证** |
| 读 amoo 的模型/密钥/历史 | **物理上做不到**（`[DESIGN-ARCH-193]` §7.2；N1 不做） |
| 构建 / 测试 / 真机 | **全未跑**（§7.4） |

---

## 十、与相邻文档的关系

| 文档 | 关系 |
|---|---|
| `[DESIGN-ARCH-193]` | 上位方案真源（职责划界与 amoo 原子能力复用）。本文只推进其中「必须在前台」一条约束的消除尝试；其 §7.5 三条约束另两条（分钟级单轮、单发）本文不动 |
| `[DESIGN-ARCH-196]` | 手机侧沙箱直连通道选型。其主干病灶「手机对沙箱没有任何直连通道」与本文病灶同源（都要经 amoo 聊天框）；两条线各自独立，不合并 |
| `[DESIGN-ARCH-195]` | 手机版插件/Skill/MCP 安装选型（已定 C）。其 MCP 指客户端侧消费，本文的 MCP-over-AIDL 是 provider 侧被消费，方向相反，勿混 |
| `[DESIGN-SOURCING-001]` | **借鉴单一真源**（AGENTS.md 指定）。步骤 4 命中 B-P1 两触发，须先过 B-P2 六字段（步骤 0）；许可证无法仓内确认 → B-S4.1 最严档 idea；`FEATURE-OWNERSHIP.json` 的 `source` 登记是 B-M2 归定义务 |
| `AMOO-INTEGRATION.md`（仓内、未跟踪） | amoo 集成的模块地图与既往实测留档；本文 §四 步骤 2 的结论要写回其 §6.1 |
| `AMOO-GUIDELINES.md`（仓内、未跟踪） | amoo 的红线；§六 的「新通道不新增出口」以其 §4.2/§5.2（`:138-145`）为判据 |

> **本文不携带 `RULES-REGISTRY` 标记**：不新增规则、不改任何规则语义（N6）；也不登记 `FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms[]`——本方案是设计文档，不是拦截型机制，不触发 `PROCESS-008`。**但 `FEATURE-OWNERSHIP.json` 并非无需动作**：B-M2 的 `source` 归因登记是步骤 4 落地时的必做项（步骤 0），与 `rollout.mechanisms[]` 是两件不相干的事。另：若日后把「三入口一张表」不变式交给 CI 守，那是新的拦截型机制，须按 `PROCESS-008` 从 S1 起步（N6 已提示）。
