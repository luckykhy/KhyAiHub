# 助手层与设备传输层的可插拔缝

> 本文回答一个问题：**khy-os 怎样才能既兼容 Amoo、又不被 Amoo 绑死，并且将来到
> 华为（鸿蒙）手机上也能用。**
>
> 结论先说：**执行基质已经是助手无关的**。真正耦合的地方只有 5 处，全部集中、
> 全部有名字。换助手是写一套平行的模块，不是重写。换手机品牌（华为/荣耀/小米）
> 分两种：荣耀/小米是 Android，`adb` 现在就通，**什么都不用改**；只有华为鸿蒙
> 需要另一条传输（HDC）。
>
> **本文没有实现任何 HDC 适配器**，理由见 §6：本机没有 `hdc` 可执行文件，没有
> 鸿蒙设备，写一个没跑过的适配器就是"凭想象交付"，正是本项目章程禁止的那件事。

---

## 1. 先说实测：耦合到底有多大

扫过 `android/app/src/main/java/com/khyos/khy_os_client/bridge/` 全部文件和
`lib/` 全部 Dart 文件，按"这个文件提不提 Amoo"分类。

### 已经助手无关的（一个字都不用改）

| 文件 | 职责 | 为什么无关 |
|---|---|---|
| `Tools.java` | 39 个工具的派发 + 会话预算门 | 除了 3 个 `amoo_*` 工具名，其余全是文件/执行/UI/系统 |
| `KhyUi.java` | 无障碍派发（`ui_tap`/`ui_type`/`ui_dump`…） | 0 处 Amoo 引用 |
| `LoopVerify.java` | 事后验证 | 0 处 |
| `LoopModes.java` | 安全底 + 模式闸 | 2 处，都是注释里引 Amoo 的红线作依据 |
| `LoopState.java` | 停止/退避判定 | 1 处，注释 |
| `AmooSafe.java` | 出站净化 | **2 个字面量**，见 §2 |
| `ShellSidecar.java` / `ShellSidecarClient.java` | uid 2000 的 shell 边车 | 完全无关 |
| `lib/core/tools/*`、`lib/core/agent/*`、`lib/core/workspace/*` | Dart 工具层、四个子智能体、工作空间 | 完全无关 |
| `lib/core/db/*` | SQLite 层 | 完全无关 |

**会话预算门（`Tools.java:239-249`）、安全底（`LoopModes.floorReason`）、
出站净化（`AmooSafe`）、UID 2000 边车、四个子智能体——这些是这套桥真正的资产，
它们一个都不绑 Amoo。** 这是本次调查最重要的发现：**"不要完全依赖 Amoo"
这个目标在结构上已经完成了大部分。**

### Amoo 专属的（一整个命名的模块组，不是撒开的）

| 模块 | 职责 | 行数量级 |
|---|---|---|
| `AmooLoop.java` | 读 Amoo 聊天气泡 → 执行 → 写回输入框 | ~1400 |
| `AmooProtocol.java` | ```khy-exec 围栏协议 | ~360 |
| `AmooSelfDesc.java` | 注入给 Amoo 的自描述 | ~180 |
| `AmooMemory.java` | 共享记忆文件 | ~250 |
| `AmooChatText.java` | 从无障碍树抽聊天气泡 | ~180 |
| `lib/core/services/amoo_chat_service.dart` | 反代三步通道（ask/poll/stop） | 57 处引用 |
| `lib/core/services/amoo_service.dart` | 包名 + 3 个 Activity | 36 处 |
| `lib/core/db/amoo_turn*.dart` | 提问回合持久化 | 72 处 |
| `lib/ui/widgets/amoo_task_card.dart`、`amoo_composer.dart` | 界面 | 74 处 |

这些是**一套**：它们共同实现"一个跑在云端的助手，通过反代把命令写进手机本地执行"。
第二个助手就是第二套同角色的实现，**不是**把这些拆散。

---

## 2. 真正的 5 个耦合点（带行号，可核）

| # | 位置 | 耦合内容 | 换助手时怎么办 |
|---|---|---|---|
| 1 | `Tools.java:111`、`:370-372` | 3 个工具名 `amoo_ask` / `amoo_result` / `amoo_memory` 在 `NAMES` 和派发表里 | 新助手加自己的 3 个；**不要**把这 3 个删掉（PC 侧 `phoneBridgeCatalog.js` 和 A 通道在用） |
| 2 | `AmooSafe.java:81` | `AMOO_PKG = "com.stepos.ailauncher"` —— 净化器把包名泛化成 "amoo" | 新助手有包名就加一条 `genericFor` 分支。**这是基质里唯一的助手专属字面量** |
| 3 | `AmooSafe.java:84` | `OWN_PKG_PREFIX = "com.khyos."` | 不变——这是 khy-os 自己，与助手无关 |
| 4 | `amoo_service.dart:17-22` | 4 个常量：包名 + `ShareActivity` + `ChatMainActivity` + `OPEN_CHAT` action | 新助手给 4 个新值。这就是 Dart 侧全部的硬编码 |
| 5 | `MainActivity.kt:1501-1504` | 同上的 Kotlin 副本 | 同上。**两处重复，改时要一起改**——这是本文唯一建议的小重构（提成一份） |

除此之外没有任何跨层耦合。**没有** "Amoo 的名字出现在工具实现里"这种情况。

---

## 3. 缝一：助手通道——第二个助手要实现什么

一个新助手要接入，需要实现的是下面这个角色，不是修改基质：

```
AssistantChannel
  ├─ foreground()          → 哪个包在前台（AmooLoop:213 已有实现）
  ├─ openChat()            → 打开它的聊天页（amoo_service.dart:96）
  ├─ readLastBubble()      → 从无障碍树读它最新的一条回复
  │                            （AmooChatText.java，按资源 id 定位）
  ├─ writeBack(text)       → 把文本写进它的输入框并点发送
  │                            （AmooLoop.writeBack，KhyUi.ui_type + ui_tap）
  ├─ selfDescription()     → 注入给它的自我介绍（AmooSelfDesc.render）
  └─ memoryFile()          → 共享记忆的落点（AmooMemory.DEFAULT_PATH）
```

**六个方法里，五个在不同助手之间是不同的，一个是共通的**：`writeBack` 的机制
（无障碍写文本框 + 点发送）与助手无关，可复用；其余五个都要按助手的资源 id 重写。

**接入一个新助手的真实工作量**：一套 `XxxLoop/XxxProtocol/XxxSelfDesc/XxxMemory`
（照 `Amoo*` 的样子写）+ `amoo_service.dart` 那样一个 descriptor + `Tools.java` 里
3 个工具名。**基质零改动**，除了 `AmooSafe` 加一条包名分支。

**为什么现在不写第二个**：没有第二个助手的包名和资源 id。这两个值拿不到也不该猜
——猜错的代价是写出一整套跑不通的代码，而它看起来是能跑的。

---

## 4. 缝二：设备传输——HDC 要接在哪

PC 侧连手机的传输层已经有一个干净的缝：

| 文件 | 现在的行为 | HDC 要改什么 |
|---|---|---|
| `phoneBridgeConfig.js:37` | `ADB_EXECUTABLE_NAMES = ['adb.exe','adb']` | 加 `['hdc.exe','hdc']`，由一个 env / 配置项选传输 |
| `phoneBridgeClient.js:111` | `spawn(adbExecutable, args, …)` | 不变——**可执行名已经是参数**，这是缝所在 |
| `phoneBridgeClient.js:392` | `_runAdb(['devices'])` | HDC 的等价命令（`hdc list targets`）输出格式不同，要一个解析分支 |
| `phoneBridgeClient.js:589` | `adb forward tcp:L tcp:R` | HDC 的等价命令（`hdc fport` 系），**语义不同，不是改个名字** |
| `phoneBridgeClient.js:373` | `adb mdns services` 找无线实例 | HDC 的发现机制不同，可能没有对应物 |

**关键事实：`adb forward` 和 HDC 的端口转发不是同一条命令的不同拼写。**
所以 HDC 适配器不是"把 `adb` 换成 `hdc`"，是一个平行的 client 实现，
共用 `phoneBridgeClient` 的 HTTP/socket 上层。

### 华为 / 荣耀 / 小米，分三种情况

| 品牌 | 系统 | 现在能不能用 | 要做什么 |
|---|---|---|---|
| 荣耀、小米、三星、OPPO、vivo… | Android | **能**。`adb` 通，桥跑在 App 里，与 OEM 无关 | 什么都不用做 |
| 华为（鸿蒙 NEXT / HarmonyOS） | HarmonyOS | **不能** | 需要 HDC 传输 + 一个鸿蒙版宿主 App。**本文未实现** |
| 华为（仍是 Android，如旧机型/部分平板） | Android | **能** | 什么都不用做 |

**"换华为/荣耀/小米"这个需求，三条里两条现在已经满足了。** 剩下的是鸿蒙，
而鸿蒙缺的不只是一条传输——是一整个宿主 App（无障碍服务、sidecar、前台服务
在鸿蒙上的形态都不同）。那是一个独立项目，不是这次能顺手带上的。

---

## 5. 已经跨品牌无关的部分（这是好消息，值得说清）

桥之所以在荣耀/小米上开箱即用，是因为它不依赖任何 OEM 专属能力：

- **sidecar**：`adb shell dalvikvm` 起一个纯 Java 类，跑成 uid 2000。这是 AOSP
  能力，不是 StepOS 能力。
- **无障碍服务**：标准 `AccessibilityService`，`ACTION_SET_TEXT` / 节点点击。
- **前台服务 + 常亮**：标准 API。
- **SELinux 那条坑**（`/sdcard` 是 fuse，`system_server` 读不了，所以安装要走
  `/data/local/tmp` 中转）是 AOSP sepolicy 行为，所有 Android 品牌一样。
- **`pm install` 的逐包授权**（`usb_install_item_<pkg>`）是 OEM 设置项，
  StepX 上有，别家可能有别的名字或没有——这是**唯一**已知的跨品牌差异点，
  且已有 `code` 字段把拒绝分类透出（`install_apk_test.dart` 钉着四种 code）。

---

## 6. 本文没有做的事，以及为什么

| 没做 | 为什么 |
|---|---|
| **HDC 传输适配器** | 本机 `which hdc` 为空，`C:\Users\25789` 下也没有 `hdc.exe`；没有鸿蒙设备。写一个没编译过、没跑过、没有设备可验证的适配器，就是"凭想象交付"——`ADB_EXECUTABLE_NAMES` 那类改动看起来能跑，但 `hdc fport` 的参数语义和 `adb forward` 不同，猜错要到真机上才暴露，而那时它已经看起来完成了 |
| **第二个助手通道** | 没有第二个助手的包名和输入框资源 id。这两个值拿不到 |
| **把 4 个 Amoo 常量提成一份**（消除 §2 第 5 项的重复） | 这是本文唯一建议的小重构，但它跨 Dart 和 Kotlin 两个语言，要一个共享常量层。现在只有一份重复、改的时候一起改就行，不值得为一个还不存在的第二个助手先建抽象 |
| **`Tools.java` 的 3 个 `amoo_*` 工具名泛化** | PC 侧 `phoneBridgeCatalog.js` 已发布这 3 个名字，`ATOMIC-CAPABILITIES.json` 从它生成。改名是破坏发布契约，B7 要人点头 |

---

## 7. 什么时候该回来做 §4

满足这三条中的任意两条，就值得开工：

1. 手上有一台鸿蒙设备（能 `hdc list targets` 看到）
2. 本机装好了 HDC 工具链（能跑 `hdc -h`）
3. 确定了要在鸿蒙上跑的宿主 App 形态（无障碍/sidecar 在鸿蒙上是否可用，未知）

在那之前，正确做法是**保持现状**：桥在 Android 上开箱可用，Amoo 是第一个助手
而不是唯一的助手，HDC 的缝已经标在 `phoneBridgeConfig.js:37`。
