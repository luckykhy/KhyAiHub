<!-- 文档分类: DESIGN-ARCH-211 | 阶段: 取证 / 分析（结论已落到代码） -->
<!-- IMPL-STATUS: partial -->
<!-- 证据时效: 2026-11-11 取证（官方 release v13.6.0 + 真机 PZ261A/Android 16）。样本 SHA-256 与脚本路径写在本文件内，可独立复核。 -->

# [DESIGN-ARCH-211] Shizuku 解包分析与 khyos 提权模型

> 状态：**分析完成，结论已落到代码**（2026-11-11）。
> 真源范围：本文是「khyos 手机端如何接官方 Shizuku、官方 Shizuku 到底怎么把权限发到第三方 App、
> 以及为什么 khyos 不自己实现一遍 Shizuku」的取证真源。**上游源码不入本仓**（B-S3），
> 本文只承载**事实、标识符与结论**。
> 上游既有归属裁定见 `[DESIGN-ARCH-207]`（Shizuku 以 `adapter` 档登记）；本文**不改写**那份裁决，
> 只在 §6 追加式说明「解包后是否改变裁定」。

## 0. 一句话结论

**「装了 khyos 就不必再装 Shizuku」这件事有两层，现状与人们的直觉都不一样：**

1. **khyos 自己要的权限，它早就有自己的实现**——内置的 sidecar（`dalvikvm` 拉起的 uid 2000 进程），
   与 Shizuku 同级。**不需要 Shizuku**，这是仓库既有能力，本次只是把它武装起来并实测跑通。
2. **khyos 想用官方 Shizuku 通道，此前根本没接上**——不是「Shizuku 没启动」，而是
   **客户端 provider 没接线 + 从不申请授权**。这两个缺口让 khyos 在 Shizuku 明明「正在运行」时
   依然报「IPC 未建立」，并把提示指向了错误的方向（详见 §4）。

⇒ 因此本轮**不引入任何上游代码**（§6），只做两件事：**把接线补上**，并**把这份分析固化成可复现的脚本**。

## 1. 取证方法（可独立复核）

| 项 | 值 |
|---|---|
| 样本 | 官方 release `v13.6.0`，资产 `shizuku-v13.6.0.r1086.2650830c-release.apk` |
| 样本 SHA-256 | `6E273AB0E991C4E79BC8B1BBB9B9DD739CCAC1A8712A541A214078886B7B790F` |
| 样本体积 | 2,571,773 字节 |
| 解包工具 | Android SDK `cmdline-tools/latest/bin/apkanalyzer`（`manifest print` / `dex packages` / `dex code`） |
| 客户端 API 工具 | `javap`（对 Maven Central 的 `dev.rikka.shizuku:{api,aidl,provider}:13.1.5` 三个 AAR 逐个核签名） |
| 真机 | PZ261A / StepOS `pandora` / Android 16 (SDK 36) / arm64-v8a |
| 复现脚本 | `delivery/mobile/khy-os-client-app/scripts/analyze-shizuku-apk.ps1` |

脚本三种输入方式，均已实测：

```powershell
pwsh -File delivery\mobile\khy-os-client-app\scripts\analyze-shizuku-apk.ps1 -Version v13.6.0   # 下载官方件并分析
pwsh -File delivery\mobile\khy-os-client-app\scripts\analyze-shizuku-apk.ps1 -ApkPath <apk>    # 分析本地件
pwsh -File delivery\mobile\khy-os-client-app\scripts\analyze-shizuku-apk.ps1 -FromDevice      # 拉手机上已装的那份
```

脚本产物（`manifest.xml` / `classes.txt` / `key-classes.txt` / `analysis.json`）**默认写在仓库外**
（`%TEMP%\shizuku-analysis`）：它们是分析产物，不是仓库内容（B-S3）。

## 2. 解包得到的事实

### 2.1 清单事实

| 项 | 实测值 |
|---|---|
| 包名 | `moe.shizuku.privileged.api`（v10 起改名；v9 及以前是 `moe.shizuku.server`） |
| 版本 | `13.6.0.r1086.2650830c`，versionCode `1086` |
| SDK | min 24 / target 36 / compile 36 |
| uses-permission | `RECEIVE_BOOT_COMPLETED`、`FOREGROUND_SERVICE`、`INTERNET`、`POST_NOTIFICATIONS`、`WRITE_SECURE_SETTINGS` |
| 自定义权限 | `moe.shizuku.manager.permission.MANAGER`（protectionLevel `0x2` = signature）、`moe.shizuku.manager.permission.API_V23`（`0x1` = normal），归属 permission-group `moe.shizuku.manager.permission-group.API` |
| 对外 provider | `moe.shizuku.manager.ShizukuManagerProvider`，authority `moe.shizuku.privileged.api.shizuku`，`exported=true`，`permission=android.permission.INTERACT_ACROSS_USERS_FULL` |
| meta-data | `moe.shizuku.client.V3_SUPPORT=true`（客户端探测 v3 能力的标记） |

### 2.2 dex 事实

- 全部 **2412 个类**；应用本体经 R8 混淆（`rikka.shizuku.*` 下一堆 `a1/Qc/xh` 之流）。
- **未被混淆、可读名的只有 20 个 `moe.shizuku.*` 类**——它们是入口，恰好构成完整的协议面：

| 类 | 角色 |
|---|---|
| `moe.shizuku.starter.ServiceStarter` | server 侧入口：与「管理 App」握手、把 binder 交出去 |
| `moe.shizuku.manager.ShizukuManagerProvider` | 管理 App 的对外 provider：第三方 App 从这里取 binder |
| `moe.shizuku.manager.authorization.RequestPermissionActivity` | 授权弹窗（用户点「允许」的那一屏） |
| `moe.shizuku.manager.adb.AdbPairingClient` / `AdbPairingService` | 无线调试配对（Shizuku 自带 adb 客户端） |
| `moe.shizuku.manager.starter.StarterActivity` | 「启动 Shizuku」的 UI |
| `moe.shizuku.manager.shell.Shell` | Shell（root 模式那条路） |
| `moe.shizuku.manager.management.ApplicationManagementActivity` | 「已授权的应用」名单页 |
| `moe.shizuku.manager.receiver.BootCompleteReceiver` | 开机自启（root 模式） |
| `moe.shizuku.api.BinderContainer` | binder 的单点存放处（客户端库与管理 App 共用） |

> 注意：**server 的实现类不在这个 APK 的可读名里**。真机实测，server 进程
> （`ps -A` 显示名 `shizuku_server`）的 classloader 指向的正是本 APK 的 `base.apk`——
> 也就是说 server 是**用 app_process 加载同一个 APK 的 dex 跑起来的**，权限是 adbd 给的 uid 2000。

### 2.3 协议常量（三个关键类的字符串常量）

这些字符串就是协议本身，抄下来即可复原交互，无需看源码：

**`ServiceStarter`（server 侧）**

| 常量 | 含义 |
|---|---|
| `ShizukuServiceStarter` | server 的进程名 |
| `moe.shizuku.privileged.api` | 管理 App 包名 |
| `moe.shizuku.privileged.api.shizuku` | 管理 App 的 provider authority |
| `moe.shizuku.privileged.api.intent.extra.BINDER` | binder 的 extra key |
| `send binder to %s in user %d` | **server 把 binder 交给管理 App 时的日志** |
| `server binder not received` / `failed send binder to %s in user %d` | 交接失败 |
| `provider is null %s %d` / `provider is dead %s %d` / `kill %s in user %d and try again` | 管理 App 没起来时的自愈：杀掉重试 |
| `sendUserService` / `shizuku:user-service-arg-token` | v11+ 的 user service 通道 |

**`ShizukuManagerProvider`（管理 App 侧）**

| 常量 | 含义 |
|---|---|
| `getBinder` / `sendBinder` | provider 的两个方法名 |
| `android:exported must be true` | **管理 App 会校验客户端 provider 的清单属性** |
| `android:multiprocess must be false` | 同上 |
| `Binder not received in 5s` | 等 binder 的超时 |
| `Provider called when Sui is available. Are you using Shizuku and Sui at the same time?` | 与 Sui 冲突时的提示 |

**`RequestPermissionActivity`（授权弹窗）**

| 常量 | 含义 |
|---|---|
| `uid` / `pid` / `requestCode` | 弹窗收到的调用方身份 |
| `dispatchPermissionConfirmationResult` | 结果回传给客户端的 AIDL 方法 |
| `shizuku:request-permission-reply-allowed` / `shizuku:request-permission-reply-is-onetime` | 回传参数 |

**客户端库（`dev.rikka.shizuku:api:13.1.5`，javap 实测）**

- `Shizuku.getBinder()` **只是读一个静态字段**——它不发起任何请求。
- `Shizuku.requestPermission(int)` → `requireService().requestPermission(int)`（**没有 binder 会抛
  `IllegalStateException: binder haven't been received`**）。
- `Shizuku.checkSelfPermission()`；`Shizuku.addRequestPermissionResultListener(OnRequestPermissionResultListener)`
  （回调 `onRequestPermissionResult(int, int)`）；`Shizuku.dispatchPermissionConfirmationResult(int,int,int,Bundle)`。
- **provider 类不在 api 包里**：它单独住在 `dev.rikka.shizuku:provider:13.1.5`
  （`rikka.shizuku.ShizukuProvider` + `moe.shizuku.api.BinderContainer`），
  其 AAR 清单自带 `uses-permission moe.shizuku.manager.permission.API_V23` 与 meta-data `V3_SUPPORT`。
- 客户端 provider 的 `onCreate` 会去问 **自己包的** authority `<自己包名>.shizuku` 取 binder
  （同进程多进程场景），并注册广播 `moe.shizuku.api.action.BINDER_RECEIVED` 接收管理 App 送来的 binder。

## 3. 端到端时序（真机实测）

```
[PC]  adb shell /data/app/~~<hash>==/moe.shizuku.privileged.api-<hash>==/lib/arm64/libshizuku.so
        │  这个二进制是「启动器」：starter begin → killing old process → starting server
        │  → shizuku_server pid is N → shizuku_starter exit with 0
        ▼
[手机] shizuku_server（uid 2000，由 adbd 授权）
        │  server 反过来找管理 App 的 provider（authority moe.shizuku.privileged.api.shizuku）
        │  logcat（tag Service）: "send binder to user app moe.shizuku.privileged.api in user 0"
        ▼
[手机] Shizuku 管理 App 收到 binder
        │  客户端 App 的 ShizukuProvider（exported=true, multiprocess=false）被 sendBinder 命中
        ▼
[客户端] rikka.shizuku.Shizuku.getBinder() → 非空
        │  checkSelfPermission() → 未授权
        │  requestPermission(code) → server 转交管理 App → RequestPermissionActivity 弹窗
        │  用户点「允许」→ dispatchPermissionConfirmationResult 回传 → checkSelfPermission() == 0
        ▼
[客户端] IShizukuService.newProcess(...) 以 uid 2000 执行命令
```

**两个只有实测才知道的点：**

- server 的进程实名是 **`shizuku_server`**，不是 `libshizuku.so`（后者是启动器）。
  按二进制名去 `pidof` 会得出「server 没起来」的错误结论——本轮第一版脚本就是这么错的。
- server 的日志**进 logcat**（tag `Service`），**不进**启动器的 stdout 重定向文件。
  只看文件会得出「没握手」的错误结论。

## 4. 本轮真机踩到的三个坑（都是静默失败）

| # | 症状 | 真因 | 为什么静默 |
|---|---|---|---|
| 1 | Shizuku 明明「正在运行」，khyos 报「IPC 未建立」 | 客户端**没注册 provider**：既没引 `dev.rikka.shizuku:provider`，清单里也没有 `<provider android:name="rikka.shizuku.ShizukuProvider">` | `getBinder()` 只是读静态字段，没人填就是 null；构建不报错、测试不报错 |
| 2 | 提示「此 App 未获得 Shizuku 授权，请在 Shizuku 中授权」——**照做找不到本 App** | 代码只读 `checkSelfPermission()`，**从不调 `requestPermission()`**；而 Shizuku 的「已授权的应用」只列**申请过**的 App（真机实测：名单里只有 Aurora Store） | 那句提示在真机上是一句**无法执行的指示** |
| 3 | 状态文案把「没接线」说成「没启动」 | `ensureConnected` 把两种 null 合并成一句「IPC 未建立」 | 把人引向错误的方向：去反复重启 Shizuku，而它早就跑着了 |

三个坑的共同形状：**报错信息指的是「你可能做了什么」，而不是「系统缺了什么」**——所以现场调试绕了很久才回到「查上游到底怎么发 binder」。

## 5. khyos 侧的落点（代码位置）

| 文件 | 改动 | 为什么 |
|---|---|---|
| `android/app/build.gradle` | 增 `implementation("dev.rikka.shizuku:provider:13.1.5")` | provider 类不在 api 包里（§2.3） |
| `android/app/src/main/AndroidManifest.xml` | 声明 `rikka.shizuku.ShizukuProvider`，authority `${applicationId}.shizuku`，`exported=true`、`multiprocess=false`、permission `moe.shizuku.manager.permission.API_V23` | 管理 App **会校验**这两个属性（§2.3 的两条报错常量）；authority 必须是 `<包名>.shizuku`，那是管理 App 回送 binder 的地址 |
| `.../ShizukuServiceManager.kt` | ①`ensureConnected` 区分「没启动 / 没注册 provider / 没授权」三种原因并给出各自可执行的下一步；②新增 `requestPermission()`：未授权时主动申请，被拒则重开申请闸 | §4 的坑 1 与坑 2 |
| `.../src/test/.../ShizukuProviderWiringTest.kt`（新） | 守住上面两处接线（清单里有 provider / authority 正确 / build.gradle 有 provider 依赖） | 故障形态是**少一行**，不是行为错；没有设备就没有可测的行为，只有源码可守 |

**为什么值得单独写一个测试**：这三个坑当时**没有任何测试或构建失败**能发现它们——一个断言抓不到「少了一行声明」。

## 6. 边界：为什么不把 Shizuku 的代码搬进 khyos（追加式说明，不改写 207 的裁决）

`[DESIGN-ARCH-207]` 已把 Shizuku 定为 `adapter` 档（只调官方分发版本，不搬代码）。解包之后，这条裁决**不变**，理由反而更硬了：

| 阻断点 | 事实依据 |
|---|---|
| **B-S3 绝对红线** | `[DESIGN-SOURCING-001]` §1：只借鉴「用自己写的代码实现的功能」，不搬上游源码。本仓根目录又无 LICENSE 文件（B-S4.1），连 `verbatim` 档都走不了 |
| **上游许可证额外三条** | Apache-2.0 + Section 6：不得用 `moe.shizuku.privileged.api` 作 applicationId、不得以 `Shizuku` 作 App 名、不得复用其 launcher 图标 |
| **能力上没有增量** | khyos 自带的 sidecar 已经是 **uid 2000 shell**，与 Shizuku 同级；复制一遍 server 不会多出任何能力 |
| **平台不同** | 上游是 Kotlin/Android 工程，本仓手机端是 Flutter + 原生壳，桌面端是 Electron（207 §5 已列） |
| **第三方 App 的官方 API 唯一** | 那个 binder 由**官方 App** 以官方包名发布；khyos 既不能占用该包名，也无法伪造它的签名 ⇒ **别的 App 想用 Shizuku API，只能靠官方 Shizuku App** |

⇒ 结论：**分析结论入库，上游源码不入库**；本仓在「官方通道」上的角色是**正确接线并诚实降级**的客户端，
在「自带通道」上的角色是**不依赖任何第三方 App 的 sidecar**。这两条都不需要抄上游一行代码。

## 7. 两条提权通道的现状（2026-11-11 真机）

| 通道 | 需要装 Shizuku？ | 需要电脑？ | 权限 | 状态 |
|---|---|---|---|---|
| **khyos 内置 sidecar**（`provision-shell-sidecar.ps1` 武装） | **不需要** | 需要（一次 adb） | uid 2000 shell | ✅ 实测：`exec` 走 `via:"sidecar"`，`id -u` → `2000`，`elevated=true` |
| **官方 Shizuku**（`start-shizuku-service.ps1` 拉起） | 需要（官方 App） | 需要（一次 adb） | uid 2000 shell | ✅ 实测：server pid 25356 / uid 2000，管理 App 显示「正在运行」；客户端接线与授权待新构建验证 |

> 两条通道都**不随重启保留**——这是平台事实（无线调试不跨重启），脚本与提示都不粉饰。

## 8. 验收与复现

```powershell
# 1) 解包取证（产物在仓库外）
pwsh -File delivery\mobile\khy-os-client-app\scripts\analyze-shizuku-apk.ps1 -Version v13.6.0

# 2) 官方通道
pwsh -File delivery\mobile\khy-os-client-app\scripts\start-shizuku-service.ps1 -Serial <serial>

# 3) 自带通道（不装 Shizuku 也能提权）
pwsh -File delivery\mobile\khy-os-client-app\scripts\provision-shell-sidecar.ps1 -FromDevice -Serial <serial>

# 4) 客户端接线回归测试
node scripts/ci/check-change-safety.js <本次改动文件…>
node scripts/ci/check-agent-rules.js <本次改动文件…>
```

## 9. 未决事项（交人裁决，本文不代劳）

1. **是否把官方 Shizuku APK 内置进 khyos**（构建期下载并打包）——「装了 khyos 就不用另外下载 Shizuku」彻底成立，
   代价是包体 +约 10MB 与三方二进制分发策略。
2. **是否改 App 内「激活 Shizuku」引导页**——现有文案与实测不符（Shizuku 在跑，卡片却写「已安装但没运行」），
   且主线应改为「khyos 自带通道优先」。
3. **官方通道的客户端授权**需新构建后真机验证：provider 接线 + `requestPermission` 弹窗 → 授权名单出现 khyos。
