<!-- IMPL-STATUS: todo -->

# [DESIGN-ARCH-195] khyos 手机版插件 / Skill / MCP 安装架构选型

> **本文是选型记录，不是实施计划。** 只回答「走哪条架构、凭什么」，
> 不回答「分几片、每片怎么验」——后者等架构定了再出。
>
> 决策依据的真源在本文（B6-1 / `PROCESS-010`）。**引用本文结论前，
> 先看 §2 的证据表、§8.2 的仍未验证项**：其中 T1 至今未验证，
> 而它恰好是候选 B 的成立前提。候选 C 的两项前提都已落地：
> **T2（引擎可编可链）2026-10-29 真机 7/7 验证通过**（§8.1），
> **T3（最小绑定表）已定案、安全内核已实现并可测**（§8.3）。

---

## 〇、人的意愿（B6-1 可追溯）

| 时间 | 谁 | 要什么 |
|---|---|---|
| 2026-10-28 | 用户 | 「悬浮窗打开了，另外希望 khyos 手机版也支持**插件、skill、mcp 的安装**」 |
| 2026-10-28 | 用户 | 安装来源：**URL + 本地文件**，并「**蹭用 dsh / zcode / claude code / opencode 的市场**」；插件形态：「**就要 Dart 工具插件**」 |
| 2026-10-29 | 用户 | 在「按声明式方案开工」与「仍要任意代码插件」之间选 **后者** |
| 2026-10-29 | 用户 | 提供 `https://studio.stepx.com/api/projects/p_c242ff2715642f47/releases/latest/download` |
| 2026-10-29 | 用户 | 读完三架构对比后选择「**先只出设计文档**」 |

**最后一条选择之后，架构未定**，本文即为此而写。

用户的原话诉求里有两项在技术上被证明不可达，须在此明确记下，避免后来者重复尝试：

- **「Dart 工具插件」字面不可行**。Flutter 应用产物中不含 Dart 源码或内核镜像，
  运行期无法加载未编译的 Dart。可编译分发的 Dart 插件等于重新发版，不是插件。
- **「蹭 claude code / opencode 的市场」只对其中一部分成立**。那些市场分发的是
  npm 包与 MCP server，运行期需要 Node；本机没有任何系统脚本解释器（见 §2）。
  能蹭的是**描述性资产**（skill 的 markdown、MCP 的声明配置），不是可执行载荷。

---

## 一、结论

**推荐 C（进程内 QuickJS）**，A 作为中期目标，**B 不推荐**。

一句话理由：**C 是唯一同时满足「用户能装真插件」与「攻击面可审计」的选项**，
而且它与 StepX 平台自己选的路是同一条——这不是我们发明的架构，是这台设备上
已经跑通了的架构（证据见 §2）。

三条候选的定义：

- **A｜兼容 StepX AI App 格式**：每个插件是一个独立 APK，内含 web/JS 载荷，
  自带 uid，因此获得 Android 真沙箱。
- **B｜进程内 JVM 插件**：插件是 jar/dex，落在 App 私有目录，由 App 用
  `app_process` 拉起，走 socket IPC。
- **C｜进程内 QuickJS 插件**：把 JS 引擎编进我们自己的 APK（照 StepX 的做法），
  插件是 App 私有目录下的 js 文件。

---

## 二、已核实的事实

**取证方式**：URL 产物落盘至
`works/data/khy/T4-transient/tmp/stepx-apk-probe-20261029/`（B8：临时文件不进仓库根），
按未信任数据处置——独立空目录、只解包检查、不执行。
工具为 `aapt2 dump badging` / `aapt2 dump xmltree` / `unzip -l` / `grep -a`。
本机**没有 `strings`**，早期所有靠 `strings` 得到的「0」都是命令失败被 `>/dev/null`
吞掉后的假读数；本文全部 dex 结论均改用 `grep -a` 并带正反控制。

### 2.1 该 URL 的产物

| 项 | 值 |
|---|---|
| 包名 | `com.stepx.aiapp.pc242ff271564` |
| 应用名 | 灵感接力 |
| 版本 | versionName `4.0.0`，versionCode `40000` |
| SDK | compileSdk / targetSdk 均 36，platformBuildVersionCode 36 |
| 体积 | 5,881,750 字节 |
| dex | `classes.dex` 9,251,172 + `classes2.dex` 2,277,512 |
| native | `lib/arm64-v8a/libquickjs.so` 924,936；`lib/arm64-v8a/libEncryptorP.so` 83,928 |
| 签名 | 有 APK Signing Block，Gradle 产物（`META-INF/com/android/build/gradle/app-metadata.properties`） |

**注意该 URL 的一个坑**：`curl -I` 返回 **403 Forbidden**，但 `curl` 带 body 的
GET 返回 **200 + `application/vnd.android.package-archive` + 完整 APK**。
即 WAF 拦了请求行、没拦 body。**用 HEAD 探测这个端点会得到「不可下载」的错误结论。**

### 2.2 插件清单（`assets/ai-app/manifest.json`）

```json
{
  "entry": "web/index.html",
  "fullscreen": false,
  "orientation": "portrait",
  "version": "4.0.0",
  "versionCode": 40000,
  "permissions": ["album", "record"],
  "network": { "domains": ["https://…supabase…", "https://ide-pay.stepaos.com"] }
}
```

字段即插件契约：**入口**、**呈现方式**、**版本**、**能力声明**、**网络白名单**。
`name` / `description` / `applicationId` 亦在其中。

### 2.3 容器运行时

`aapt2 dump xmltree` 得到的组件：

- `com.aiapp.ShellApplication` — Application
- `com.aiapp.container.WebContainerActivity` — **承载 web 入口的 Activity**
- `com.aiapp.container.web.PortraitCaptureActivity` — 竖屏拍照
- FileProvider authority `<pkg>.aiapp.files`，path 前缀 `/<pkg>`

dex 中另有 `com.aiapp.bundlekit.AppFunctionsSpec` 与一整套
`androidx.appfunctions.*`（`AppFunctionService` / `AppFunctionData` /
`ExecuteAppFunctionRequest` / `aggregatedAppFunctionInvoker_delegate` 等），
说明 AI App 有**声明 AppFunction 的规格通路**。

**推论（非直读验证）**：web 入口与无头 JS 是**同进程并存的两套**，不是二选一——
`WebContainerActivity` 走 UI，`com.dokar.quickjs` 走逻辑。

### 2.4 JS 引擎

dex 中 `com.dokar.quickjs.QuickJs` / `binding/Bindings_*` / `ModuleLoaderBuilder` /
`converter/JsObjectConverter` —— 即 **quickjs-kotlin**（dokar/quickjs，JNI 绑定）。
配套 `lib/arm64-v8a/libquickjs.so`。

**这条事实推翻了本文此前的一个判断。** 上一轮的结论是「手机上没有任何脚本解释器，
所以 stdio MCP 不可行、插件只能跑原生码」。结论的前半对（系统确实不带解释器），
后半错：**解释器可以随 APK 分发**，平台自己就是这么做的。

### 2.5 插件侧 SDK（`assets/sdk/capsule.js`）

**微信小程序形状的桥**：

- `global.CapsuleBridge.invoke(apiName, paramsJson, callbackId)`
- `global.CapsuleBridge.notify(apiName, paramsJson)`
- 错误契约 `errMsg: api + ":fail " + reason`，另带 `errorCode` / `errCode` / `errorCodeInt`
- `__arrayBufferBase64` 承载二进制
- 按 API 分设超时：`getLocation` 30s、`getSensor` 3s、`request` 65s、
  `downloadFile` 65s；选图/录像/扫码等人的接口**不设超时**，注释明确写了原因

即：**能力经一个具名 API 表暴露，每个 API 有独立超时与错误码**。
这正是候选 C 想要而候选 B 给不了的形状。

### 2.6 设备侧事实

| 事实 | 取证 | 状态 |
|---|---|---|
| SELinux 处于 `Enforcing` | `adb shell getenforce` | 已验证 |
| 设备上**无任何** `com.stepx.aiapp.*` 安装 | `adb shell pm list packages` | 已验证 |
| 手机无 node/python/python3/lua/luajit/perl/ruby/busybox | `adb shell which`（上一轮） | 已验证 |
| `/system/bin/app_process` 存在（→ `app_process64`） | `adb shell ls -lZ` | 已验证 |
| App 进程可自行 `Runtime.exec` 子进程 | `MainActivity.kt:1004` `Runtime.getRuntime().exec(arrayOf("sh","-c",command))` | 代码路径已验证；**设备上未实测** |
| 闸门 `SHELL_ALLOW` 是**前缀白名单**，且命令最终交 `sh -c` | `MainActivity.kt:44`、`:1184-1205` | 已验证 |
| App 自身 SELinux 域能否 `exec` `app_process` | — | **未验证** |

### 2.7 现有代码基线（选型要接的东西）

| 位置 | 现状 |
|---|---|
| `delivery/mobile/khy-os-client-app/lib/core/tools/skills.dart` | `SkillType { delegation, compound, prompt }`；**5 条硬编码 `Skill(...)`**（`:65-91`）；**无磁盘加载、无安装链路** |
| 同上 `lib/` 下 | **无** plugin / mcp / skill 目录 |
| `android/app/src/main/assets/` | 仅 `app_functions.xml` / `app_functions_schema.xsd` / `app_functions_v2.xml` / `shizuku` |
| `MainActivity.kt` | `SHELL_ALLOW` 前缀白名单 + `SHELL_DENY`；`isCommandAllowed` 已禁 shell 控制符（`;` `&` `\|` `` ` `` `$(` `>` `<` 换行），修掉了「允许的命令 + 被禁的命令」串接过闸 |
| `BridgeOverlayService.java` | 悬浮框开关已持久化（`khyos_overlay_pref` / `overlay_enabled`） |

### 2.8 一条安全观察（不照抄）

StepX 的 `assets/ai-app/manifest.json` 里有一个**明文 `apiKey` 字段**。
按本仓 R2（`SECURITY-001`），真 key 不得以明文进 bundle。**本文不复述该值**，
且 khyos 的插件清单**不得引入同类字段**——插件的凭据只能由用户在运行时输入、
经 env 或受保护存储注入，不随插件包分发。

---

## 三、三个诉求必须拆开

用户一次要了三样，但它们的难度差两个数量级，**混在一起谈会做出错误的架构决定**。

### 3.1 Skill 安装 —— 与架构选型无关，可立即做

现状是 5 条硬编码 `Skill(...)`。加磁盘加载 + 安装/卸载链路即可。
纯 Dart、无新运行时、无安全模型变化（skill 是提示词与步骤，不是可执行码）。

**这一片不依赖本文的任何决策，可以先行。**

### 3.2 MCP —— 传输方式决定可行性

| 传输 | A | B | C |
|---|---|---|---|
| http / sse 客户端 | 可 | 可 | 可 |
| **stdio** | 需容器自带解释器 | **不可行**（无解释器可拉） | **原理上可行**（解释器随包分发） |

C 让 stdio MCP 从「不可行」变成「可行但要额外造一个 Java 侧 stdio broker」——
QuickJS 在进程内、单线程、阻塞式求值，要冒充一个「可被 spawn 的子进程」需要
Java 侧管道转发到一个 JS 求值循环。**工作量未估，本文不承诺。**

另外，用户「蹭 claude code / opencode 市场」在 MCP 上的正解是**导入它们的声明配置**
（`.mcp.json` / `mcp` 段的 http/sse 条目），这与架构选型也无关。

### 3.3 插件 —— 唯一的架构分岔

见下。

---

## 四、三条候选架构

### A｜兼容 StepX AI App 格式

每个插件一个独立 APK：`assets/ai-app/manifest.json` + `assets/ai-app/web/` +
`assets/sdk/capsule.js` + 自带 QuickJS。安装走系统安装器（App 已有
`REQUEST_INSTALL_PACKAGES` 与 bundled-APK 先例：Shizuku 就是这么装的）。

- **沙箱**：真。独立 uid，Android 自己管。
- **市场兼容**：最彻底。`studio.stepx.com` 出的就是这个格式。
- **代价**：要么我们**成为** AI App 的宿主（要建一整个 WebView + 桥 + 清单解析 +
  生命周期 + 安装管理的容器运行时），要么依赖设备上某个 StepX 宿主应用
  （设备上当前**没有**装任何 AI App，宿主是否存在未经确认）。
- **用户体感**：每装一个插件 = 一次系统安装器授权。对「装个插件」来说是重操作。

### B｜进程内 JVM 插件

插件是 jar/dex，落 App 私有目录，App 用 `app_process` 拉起，走 socket IPC。

- **沙箱**：**无**。同 uid，插件可读桥令牌与 `api_keys.json`。
- **市场兼容**：无。那些市场分发 npm 包，这里跑不了。
- **代价**：`app_process` 能否被 untrusted_app 域 exec **至今未验证**（§9-T1）；
  加上 IPC、生命周期、超时、崩溃隔离全套。
- **唯一优势**：用户不用再装一个 APK。

**这一条的用户选择已被明确记录（§〇），但其成立前提未验证，且豁免必须显式接受。**

### C｜进程内 QuickJS 插件

把 JS 引擎编进我们自己的 APK，插件是 App 私有目录下的 js 文件。

- **沙箱**：**能力边界**。JS 全局对象上只有我们亲手绑定的函数；
  没有我们未绑定的文件、网络、反射入口。这不是 OS 级沙箱（QuickJS 的 JNI 边界
  若被突破仍可逃逸），但攻击面是**一个可逐行审计的绑定表**，而不是「任意 JVM
  字节码在我们的 uid 里跑」。
- **市场兼容**：部分。JS/skill 类资产可转换；npm 包仍不可直接跑。
- **代价**：要选型并编入 JS 引擎（quickjs-kotlin 或 quickjs-ng）、设计绑定表、
  实现插件的安装/校验/版本/卸载。中等。
- **附带收益**：stdio MCP 在原理上变得可行（§3.2）。

---

## 五、对比矩阵

| 维度 | A 独立 APK | B 进程内 JVM | C 进程内 QuickJS |
|---|---|---|---|
| 隔离强度 | **真沙箱**（独立 uid） | 无（同 uid） | 能力边界（绑定表可审计） |
| 用户能写真逻辑 | 能 | 能 | 能 |
| 解释器来源 | 随插件 APK 带 | 系统 ART | 随我们 APK 带 |
| 安装摩擦 | 高（系统安装器每次） | 低（落文件） | 低（落文件） |
| 蹭 StepX 市场 | **完全** | 不能 | 部分 |
| 使能 stdio MCP | 需插件自带解释器 | 不能 | **原理上可以** |
| 实现工作量 | 最大 | 大 + 前提未验证 | 中 |
| 安全结论能否写进文档 | 能 | **只能写豁免** | 能 |

---

## 六、为什么推荐 C

1. **它是这台设备上已经跑通的架构。** 不是设计推演，是 5.8 MB 的实物证据
   （§2.1–2.5）。QuickJS 编成 `.so` 进 APK 在 arm64-v8a / Android 16 上可行，
   这一点不需要我们再证。
2. **它把 B 的安全问题从「写豁免」变成「可审计」。** B 的插件是任意 JVM 字节码，
   与 App 同 uid，能读桥令牌和 `api_keys.json`——R2 直接被击穿，只能靠文档标红
   求用户背书。C 的插件能碰到的只有我们绑定的那几个函数，边界是一张表，
   可以逐行审、可以只读、可以在 CI 里钉住。
3. **它让「装真插件」这件事保持轻。** 用户不用为每个插件过一次系统安装器。
4. **它顺手解开 stdio MCP。** §3.2。
5. **它不排除 A。** C 的插件格式（manifest + 载荷 + 能力声明）可以与 A 的清单
   字段对齐，将来要升级到独立 APK 真沙箱时，插件资产可以迁移，绑定表变成
   `capsule.js` 的 API 表——两者是同一形状（§2.5 已经证明这个形状在平台侧成立）。

---

## 七、明确不做

- **不做 Dart 插件**（§〇：字面不可行）。
- **不直接运行 npm 包**（无 Node；「蹭市场」只蹭描述性资产与声明配置）。
- **不在插件清单里放任何密钥字段**（§2.8，R2）。
- **不给 B 写实现**，除非用户显式接受 §四-B 的豁免且 §9-T1 验证通过。
- **不动 `router.js` 等上帝文件**；新入口走自注册 manifest（既有惯例）。
- **不自行决定版本递增**（B7）。本文是设计记录，不带版本变更。

---

## 八、待验证项与已验证项

### 8.1 已验证

| ID | 结论 | 证据 |
|---|---|---|
| **T2** | **quickjs-ng 在本项目构建链上可编、可链、arm64-v8a 可用，且原生↔JS 双向可达。候选 C 的工程前提成立。** | 2026-10-29 真机 7/7 通过。`libkhyjs.so` 4,446,920 字节，由既有 CMake 原生构建产出并打进 APK；logcat 实测 `JNI_OnLoad: registered 1 native methods` / `engine ready (quickjs-ng, mem limit 33554432 bytes)` |

**T2 的七项实测**（自检 Activity `KhyJsSelfTestActivity`，logcat tag `KhyJsSelfTest`）：

| 用例 | 结果 |
|---|---|
| `1 + 1` | `2` |
| `console.log('…')` 抵达原生绑定 | PASS——`[script] khyjs binding ok` 由 C 侧 `__android_log_print` 打出 |
| `typeof console === 'object' && typeof console.log === 'function'` | `true` |
| `throw new Error('deliberate')` | `ok=false`，错误串含 `deliberate`，**进程未崩** |
| `while (true) {}` | 正好 **5000ms** 后 `InternalError: interrupted` |
| 失控分配（32 MB 上限） | `InternalError: out of memory`，进程未崩 |
| 前述全失败后再求值 | `still alive` |

第 5、6 两项是这个运行时**不可省**的性质：一个能让 App 卡死或被 OOM 杀掉的插件运行时，在方案对比里不能算「可用」。二者都成立。

**T2 的落地物**：

| 文件 | 作用 |
|---|---|
| `scripts/bootstrap-native-quickjs.ps1` | 拉取 vendored quickjs-ng v0.17.0 到 `third_party/quickjs`（gitignored），照 `bootstrap-native-llama.ps1` 的模式 |
| `android/app/src/main/cpp/khy_js_jni.cpp` | **手工写的 JNI shim，就是方案 C 的「可审计绑定表」**。当前只有一个绑定 `__khyLog` |
| `android/app/src/main/cpp/CMakeLists.txt` | quickjs 静态库 + `libkhyjs.so`，沿用 llama.cpp 那一套 native build |
| `android/app/src/main/kotlin/…/engine/KhyJs.kt` | Kotlin 侧，只暴露 `eval` |
| `android/app/src/debug/…/KhyJsSelfTestActivity.kt` | **debug 源集**里的验收门，release 包不含 |

**复验方式**（两个坑，都会让人以为装不上而不是以为没验）：

1. **签名冲突**。设备上已装的是 `android/key.properties` 那把真钥匙签的 release 包，debug 构建用 debug keystore，`adb install -r` 报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`。**不能卸载重装**——装着已下载的视觉模型和全部用户状态。临时给 debug 构建加 `applicationIdSuffix ".spike"` 让它 alongside 安装，namespace 不变所以 JNI `FindClass` 照旧解析，验完把那一行删掉。
2. **MIUI USB 安装限制**。装新包名报 `INSTALL_FAILED_USER_RESTRICTED`，按包授权：`adb shell settings put secure usb_install_item_<包名> "<标签>:1"`，然后**立刻**装（装失败会被系统写回 `:0`）。

```bash
adb shell settings put secure usb_install_item_com.khyos.khy_os_client.spike "khyos:1"
adb install -r build/app/outputs/apk/debug/app-debug.apk
adb shell am start -n com.khyos.khy_os_client.spike/com.khyos.khy_os_client.KhyJsSelfTestActivity
adb logcat -s KhyJsSelfTest KhyJs
```
### 8.2 仍未验证

| ID | 待验证 | 为什么卡在选型上 | 怎么验 |
|---|---|---|---|
| **T1** | untrusted_app 域能否 `exec` `/system/bin/app_process` | **候选 B 的唯一成立前提**。SELinux `Enforcing`，我从记忆里答不出，猜错就是一整版白做 | 临时把 `app_process` 加进 `MainActivity.kt` 的 `SHELL_ALLOW`，编一版，经桥的 shell 工具跑 `app_process`，看 logcat 有无 avc denied；**验完必须还原** |
| **T3** | C 的绑定表怎么落到进程结构上 | 定案、安全内核、每插件 context、net 能力均已完成并**已真机验证**（§8.3） | 见 §8.3「仍未做」4 项；剩下的是存储落盘、loader、net.fetch 异步化 |
| **T4** | 设备上是否存在可作 A 的宿主的应用 | 候选 A 若要依赖外部宿主则直接不成立 | `pm list packages` 已做，未见 AI App；宿主应用未经确认 |
| **T5** | 悬浮窗「重新打开」仍未验证通过 | 与本文无关但同为未清账 | 约 25 个点击位置均未成功；记录为**未验证**，不是已通过 |

**T1 现在更重要了**：T2 通过意味着候选 C 已经可以开工，而候选 B 仍然连前提都没验。若最终仍要比较 B，T1 是它的第一道门。

### 8.3 T3：最小绑定表（已定案，安全内核已实现并可测）

T3 问的是「这个表该有什么、按什么粒度授权」。它比引擎能不能跑重要得多——**这张表就是方案 C 相对方案 B 的全部优势所在**，所以它是设计决定，不是实现细节。

#### 授权粒度：按能力、由 manifest 声明

三种可能，取第二种：

| 方案 | 结论 |
|---|---|
| 全有或全无 | 太粗。一个只弹 toast 的插件不该因此拿到网络 |
| **按能力、manifest 声明** | **采用**。loader 只把 manifest 声明的那些绑定装进该插件的 context |
| 每次调用问用户 | **明确拒绝**。插件每调一次弹一次框不可用，且会把用户训练成反射性点「允许」——那比一个范围明确的静态授权**更糟**；何况 Amoo 本身就可能是在点的那个人 |

关键实现决定：**没授权的绑定不是「装了但报错」，而是根本不装进那个插件的 context**——`typeof net` 是 `undefined`。这比运行时检查强两点：插件能诚实做特性检测；检查代码写错时是拒绝而不是放行。

#### 最小能力表

| capability | 装什么 JS 绑定 | 能碰到什么 |
|---|---|---|
| `log` | `log` | 只写 logcat，零读取 |
| `device.info` | `device.info` | 型号/系统版本/ABI/应用版本，**不含任何设备标识符** |
| `store` | `store` | 仅本插件自己的键值命名空间 |
| `net` | `net.fetch` | 仅 manifest 声明的主机，且仅 https |
| `ui.toast` | `ui.toast` | 弹一条 toast |

#### 刻意不在表里的东西

这些是评审时**应该找得到而找不到**的条目，缺席是刻意的：

- **任何能返回桥令牌、app secret、`api_keys.json` 里密钥的能力。** 这是 C 胜过 B 的唯一理由，表里永远不该有「读凭据」这一项。
- **桥自己的工具**（`ui_tap` / `ui_swipe` / `shell` …）。那些是 App 的特权面，拿到就能驱动设备、跑命令，是比「弹 toast」高得多的一档，**不许搭着最小集一起走**。将来要加也是独立 capability 配独立授权。
- **文件系统。** `store` 已覆盖有状态场景，且命名空间锁死在一个插件内；裸文件访问能读到 App 自己的 prefs 和别的插件的数据。
- **剪贴板读取。** 剪贴板里常是用户刚复制的密码。只写输出可以，读不在最小集里。
- **设备标识符。** `device.info` 返回型号/SDK/ABI/版本，**刻意不含 `ANDROID_ID`、IMEI、序列号**——那是稳定追踪标识，交给任意插件是隐私成本，换不来功能。
- **插件代码内的 `eval`。** 插件自己的源码已经是任意代码，`eval` 不增加它能做的事；但对「从网络拿来的字符串」`eval` 就是代码注入入口。不绑它，去掉这个 footgun。

#### 两个真实的绕过路径（本轮的实质发现）

**1. 回环绕过——最严重的一个。** khy-os 自己的手机桥监听在 `127.0.0.1`。一个拿到 `net` 且 manifest 声明 `https://127.0.0.1` 的插件，可以直接跟桥对话，调用桥暴露的**每一个**工具——`ui_tap`、`ui_swipe`、受限 shell——**这些全都不在能力表里**。那会让整张表变成装饰品。

处置是两层，都要：
- **安装期**：manifest 声明回环/私网地址，直接拒装。
- **策略层**：`PluginNetPolicy` 仍然拒绝回环、私网（RFC1918 + 100.64/10 CGNAT + 0.0.0.0/8 + 192.0.2.0/24 + 203.0.113.0/24）、链路本地、组播。第二层是兜底：万一哪天安装期那层被放宽，表依然是诚实的。

**2. 后缀匹配绕过。** 白名单按后缀匹配（声明 `example.com` 就放行 `evil.example.com`）是经典漏洞——子域常常是攻击者可控的（用户内容主机、vanity 主机）。**采用精确主机匹配**，要放行子域就显式声明它。

另外两条顺手关掉的：URL 带 userinfo（`https://allowed.com@evil.com/`，host 其实是 evil.com）整体拒绝；非默认端口拒绝（声明 `api.example.com` 不等于放行 `api.example.com:8443`）。

#### 已实现并可测的部分

| 文件 | 内容 |
|---|---|
| `plugin/PluginCapability.kt` | **能力表本身**，每个条目带 wireName / 装的 JS 绑定 / 一行「能碰到什么」（给将来的同意界面用） |
| `plugin/PluginManifest.kt` | 清单解析与校验，fail-closed：任何问题都拒装，不存在「解析了一半」的路径 |
| `plugin/PluginNetPolicy.kt` | 白名单判定，**纯函数、无 IO、无 DNS**，因此可在每次跳转上重复调用 |
| `plugin/PluginStoreScope.kt` | 存储作用域推导 + 体积上限 |
| `test/…/plugin/PluginSecurityTest.kt` | 50+ 条，钉住上面每一条规则 |

字段名刻意与 StepX AI App 格式一致（`entry` / `version` / `permissions` / `network.domains`），让 manifest 在两者之间可读——这才是「蹭那个市场」的实处，而不是发明一套私有格式。

其中两条测试值得单独说：

- **`noCapabilityExposesACredentialOrTheBridge`** 钉的是**缺席的不变量**。谁要是加了一个名字或描述里含 token/secret/key/bridge/shell/tap/swipe/file/clipboard 的 capability，这条测试就红，逼他把理由讲出来。这是防止未来某一天有人「顺手加个读密钥的能力」的唯一机械防线。
- **`hostnameIsNotClassifiedAsAnAddress`** 钉的是一个**已知缺口**而不是一个通过项：主机名在没有 DNS 的情况下无法分类，而这个纯函数刻意不做 DNS。`localhost` 在这里被当作名字而不是 `127.0.0.1`。

#### 进程结构：已落地（2026-10-29 第二轮）

原来这里是 5 项「仍未做」，第 1 项（每插件一个 JSContext）是其余各项的前置。现已落地，并把架构定下来了：

**一个原生函数 + 按能力装的 JS 包装器。** `khy_js_jni.cpp` 里**只有一个**原生函数 `__khyInvoke(api, argsJson)`，外加按授权装的薄 JS 包装器（`store`、`device`、`ui`、`log`）。每个包装器都汇到那一个原生函数，由它转给 Kotlin 的 `PluginHost`，**由 Kotlin 按 manifest 逐次判授权**。

这个形状是刻选的：JNI 文件的审计面**不随能力增加而增长**——将来加 `net.fetch` 不该意味着加 C 代码。而「没授权就不装包装器」保住了粒度决策要求的性质：没拿到 `store` 的插件，`typeof store` 是 `undefined`，不是一个会报错的函数。

**每插件一个 `JSRuntime` + 一个 `JSContext`。** 内存上限因此是**每插件**的（一个插件吃光预算不会饿死另一个）；中断截止时间也存在实例上，两个插件可以并发求值而不互相打断。

**新增落地物：**

| 文件 | 内容 |
|---|---|
| `engine/KhyJs.kt` | `setHost` / `load(manifest)` / `run(handle, code)` / `unload(handle)`。**裸字符串入口已彻底移除** |
| `plugin/PluginHost.kt` | 逐次判授权 + 四个处理器（`log` / `device.info` / `store.*` / `ui.toast`）；`API_CAPABILITY` 是 api 面的唯一声明处 |
| `src/debug/…/KhyJsSelfTestActivity.kt` | 自检扩到 14 项，新增能力过滤、跨插件隔离、句柄失效三条 |

**一个必须记下的耦合。** `KhyJs.load` 发给 JNI 的是**能力序数**，JNI 侧对照的是 `khy_js_jni.cpp` 里手写的 C 枚举——两种语言、靠位置耦合。谁要是在 `PluginCapability` 中间插一个能力，所有插件的绑定会**静默错位一格**（授权 `store` 的插件拿到 `device`），而且不报错。`PluginSecurityTest.pluginCapabilityOrdinalsMatchTheNativeEnum` 靠解析 C 源文件里的枚举来钉住这件事；配套的 `everyCapabilityHasANativeWrapperOrIsDeliberatelyAbsent` 保证「刻意缺席」不会悄悄变成「忘了」。

**过程中修掉的两个真问题**（都是我自己写出来的，写在这里以免复发）：

1. `manifestOf()` 原本在 `try` **之外**调用，宿主的异常会直接从 `JS_Eval` 里逃出去把进程带走。已移入 try。
2. `store.set` 超限时原本返回 `{stored:false, ok:true}`——`ok` 是 JNI 侧给插件的**唯一**判别位，这种形状让插件无法判断成败。改为抛异常，经 catch 变成正经的 `{ok:false,error:…}`。

**真机验证通过（2026-10-29 17:14，17 项 0 失败）**，并且它当场抓出两个单测抓不到的真问题——都是**跨语言边界上的形状误解**，这类错误在 JVM 单测里根本不存在，只有跑起来才暴露：

1. **中断处理器在空闲时也开火。** `deadlineNs` 初值是 0，而判定是 `now > deadline`；单调时钟恒为正，于是**没武装的实例被判为「已过期」**，把装载期的能力包装器全打断了。真机日志：每个插件都报 `capability wrapper failed: InternalError: interrupted`。修法是引入「永不打断」哨兵值（`INT64_MAX`），武装时写真实截止时间，解除时还原哨兵。**这个 bug 只在有 JS 运行的设备上出现，JVM 单测完全看不到。**
2. **`JSON.parse` 被多包了一层。** `__khyInvoke` 在 C 侧已经 `JS_ParseJSON` 返回**对象**，我却在 JS 助手 `__khyResult` 里又 parse 了一次——对对象 parse 会先被强制成字符串 `"[object Object]"`，于是所有包装器同时报 `SyntaxError: unexpected token: 'object'`。症状是 `device.info()`、`ui.toast()` 全挂，而 toast 其实已经送到。修法是去掉那次 parse。

第二条顺带说明一件事：**`ui-toast` 那一项第一次是「假失败」**——toast 送到了，但包装器抛了语法错导致求值失败。如果只看 `toasts=[hello from plugin]` 会误判为通过，只看 `ok=false` 会误判为 toast 没工作。两个信号矛盾时必须都查，不能挑一个顺的解释。

**真机验证的 17 项**（`KhyJsSelfTestActivity`，logcat tag `KhyJsSelfTest`）：两个插件句柄、基本求值、`typeof store`/`typeof device` 在有/无授权下的取值、直接调 `__khyInvoke` 仍被逐次鉴权拦下、store 写入/读回、**跨插件存储隔离**、跨命名空间键被拒、`device.info` 返回事实且无标识符、toast 送达、死循环 5000ms 被打断、失控分配被 32 MB 上限拦下、两个插件互不影响、未知接口被拒、卸载后句柄干净失效。

#### net 能力：已落地（2026-10-29 第三轮）

前三项原列在此处，现已一并做完，因为它们本是一体：**`net.fetch` 是能力表里唯一能让数据外发的一项**，单独接一半没有意义。

**DNS 缺口已堵。** `PluginNetPolicy` 是纯字符串函数、刻意不碰 DNS，所以它自己文档里写明「主机名无法分类」是个洞——`evil.example.com` 解析到 `127.0.0.1` 就能摸到 App 自己的桥。新增 `PluginNetGuard` 补上这一半：先跑字符串策略，再把 DNS **实际返回的**地址逐个分类，**有一个非公网就拒**（一个名字解析出公网+回环两个地址时，连接可能挑到回环那个）。解析器是注入的，所以测试不需要真 DNS——包括「名字解析到回环」这个原本只能靠真网络构造的用例。

**重定向缺口已堵。** `PluginNetTransport` 刻意**不自动跟随重定向**：`HttpURLConnection` 若自己跟，调用方只看到最终响应，中间 URL 从未被检查——这正是经典绕过。改为传输层只发一跳、把 `Location` 交回来，由 `PluginHost` 的重定向循环逐跳重跑 guard。另外两条顺手关掉：相对重定向按上一跳解析；**重定向后丢弃 body**（否则一个 302 就能把插件的 payload 送到它从未声明过的地方）。

**关于同步的一个明示取舍。** `net.fetch` 是**同步**的：它跑在 `JS_Eval` 里，所以引擎的截止时间打不断它。阻塞由传输层自己的 connect/read 超时兜住（10s / 15s）——**有界但不可中途取消**。插件调一个慢主机，最多卡住自己的求值那么久，卡不死 App，也卡不到别的插件（各有各的 runtime 和调用线程）。真正的异步桥（promise）才是终态，但它比这一轮大得多，先记在这里。

**传输层保证不附带任何凭据**：不装 cookie jar、不加 Authorization、App 自己的令牌从不进这条路。插件可以带**它自己**的头（它为自己服务申请的 key），拿不到的永远是 App 的。响应体按 256K 字符截断并明示已截断——否则「拉一个无界响应体」是绕开引擎内存上限的另一个原语。

#### 仍未做

1. **存储落盘**：作用域规则与体积上限已是纯函数且已测（`PluginHost.PluginStore` 是接口，测试用内存实现），持久化那层还没写。
2. **loader 本体**：从磁盘读 manifest、建 context、跑 entry。现在 `load` 接收一个已解析的 `PluginManifest`，「从哪来」还没有。
3. **`net.fetch` 的异步化**：见上一节的取舍说明。同步版有界但不可取消，promise 桥是终态。
4. **重定向后的 method 未按 RFC 归一**：301/302/303 本应改成 GET，现在原样保留（只丢了 body）。功能上可用，规范上不严格。

---

## 九、边界（R1 / R2 / B7 / B8）

- **R1**：本文不产生任何 commit / push。要落地先开 feature branch，等明确点头。
- **R2**：插件清单不含密钥；插件凭据只由用户运行时输入，经 env 或受保护存储注入，
  绝不落盘、绝不进 bundle。StepX 那个明文 `apiKey` 是反例（§2.8）。
- **B7**：不碰版本号。MINOR/MAJOR 必须人点头。
- **B8**：取证产物在 `works/data/khy/T4-transient/tmp/`，月底随 `.tmp_*` 规则清理；
  不在仓库根造任何 `.khy` / `.khyos`。
- **B6-3**：结果要人能接住。若最终实现进入软著登记候选，插件运行时的每一行绑定
  都必须能被人解释——这也是推荐 C 而非 B 的理由之一：B 的代码没人能解释完。

---

*最后更新：2026-10-29（首版，选型记录；架构未定，待用户裁决）*
