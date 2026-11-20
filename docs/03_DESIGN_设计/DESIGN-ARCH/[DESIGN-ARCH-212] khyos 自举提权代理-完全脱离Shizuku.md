<!-- 文档分类: DESIGN-ARCH-212 | 阶段: 设计 / 提案（期 1、期 2 已落地） -->
<!-- IMPL-STATUS: partial -->
<!-- 证据时效: 2026-11-17（配对协议 AOSP 权威源 + 真机配对端点实测通过；App UI 触发链未测） -->

# [DESIGN-ARCH-212] khyos 自举提权代理 —— 完全脱离 Shizuku

> 状态：**期 1、期 2 已落地**（协议字节黄金向量 8/8 + 配对协议 AOSP 权威源实现 + 真机配对端点实测通过）；期 3（UI 触发链与重启自恢复）部分未测。
> 真源范围：本文是「khyos 如何在**不装 Shizuku、不内置 Shizuku**的前提下自己拿到 uid 2000」
> 的设计与取证真源。提权链的既有归属见 `[DESIGN-ARCH-207]`、官方通道的接线见 `[DESIGN-ARCH-211]`；
> 本文**不改写**那两份的结论，只在其上叠加「自举」这一层。

## 0. 一句话结论

**目标形态**：装 khyos 即可提权，不需要 Shizuku、不需要电脑、不需要每次重启重跑命令。

**实现路径**：App 内实现一个**最小 adb 客户端**，与**本机**的无线调试端口配对、开 shell，
以 uid 2000 拉起 khyos 内置的提权代理（sidecar）——**这正是 Shizuku v13 在 Android 11+
上自启动的同一条路**（解包证据见 §2.1）。

**当前进度**：协议字节层已按**真实 adb 客户端实测**钉版并有回归测试（期 1）；
**配对协议已按 AOSP 权威源实现并在真机配对端点实测通过**（期 2，2026-11-17）；
App UI 触发链与重启自恢复（期 3）部分未测。

## 0.1 期 2 落地记录（2026-11-17）

**配对协议的权威来源问题已解决。** 2026-11-12 时本网络取不到 AOSP 源（raw / googlesource /
jsdelivr / codeload 全被挡），期 2 因此停摆。2026-11-17 实测 GitHub raw 通路可用，
取得 AOSP 权威源后，配对协议不再是黑盒：

| 组件 | 权威源 | 本仓实现 |
|---|---|---|
| SPAKE2 算术（Ed25519 群 + M/N 固定点 + 口令标量 hack） | BoringSSL `crypto/curve25519/spake25519.c` | `shell/Spake2.kt` + `shell/Ed25519.kt` |
| 配对传输（TLS1.3 → 导出 64 字节 keying material → SPAKE2 → AES-128-GCM → 8192 字节 PeerInfo） | AOSP `packages/modules/adb`（`pairing_auth/`、`pairing_connection/`） | `shell/AdbPairingClient.kt` |
| Android mincrypt 公钥编码 | AOSP `crypto_utils/android_pubkey.c` | `AdbAuthKey.mincryptPublicKeyBase64()` |
| 帧格式与黄金向量 | AOSP `adb/proto/pairing.proto` | `scripts/adb-pairing-common.js`（Node 参考实现，被平台真 `adb pair` 验收） |

**真机验收**（`works/data/khy/feedback/2026-11-16-selfconnect-adbd/acceptance-t1-t12.md`）：
- T2：Node 客户端（与 App 同协议）连**真机配对端点**，SPAKE2 交换 + PeerInfo 解密成功，
  取回设备 GUID `adb-ZYPZ261A01M6870010L-R9QdlL`。
- T3：全程无 USB（`dumpsys battery` = USB/AC/Wireless powered 全 false）。
- T6：`/sdcard` 密钥残留 0；`exportKeyForHost()` 已删（存证见 `scrub-plan.md`）。
- T7：`rm -rf` / `mkfs` / `pm uninstall` 全部 `dangerous_command_refused`。
- T9：63 工具 `required_level` 全表；标注 app 的 9 个在 `elevated=none` 实测可用，
  标注 shell 的 `exec` 的 shell 动词明确报 `needs_shell`（错误码已从 `elevation_required`
  改名，LEGACY_CODE 保留兼容）。

**未测（如实）**：App UI 触发链（`elevationPair` 按钮点击 → `elevated=shell`）未跑通——
Flutter 引导 sheet 的输入框/按钮在 uiautomator 下不稳定（焦点、键盘遮挡、配对码 120s 轮换）。
协议正确性由 T2 真机 + 643 个单元测试双重保证；UI 触发链需人工或专用集成测试覆盖。

**平台事实（新增，不粉饰）**：Android 16 重启后**无线调试默认关闭**，adbd 不监听——
「重启后自动重连」在系统层面无对象可连。`ElevationState.deviceAuth` 在设备撤销授权时
报 `unpaired`；自动重连的前提是用户保持无线调试开启（或走电脑兜底脚本）。

## 1. 目标形态（用户视角）

| 时刻 | 用户动作 | 系统发生什么 |
|---|---|---|
| 首次 | 设置 → 无线调试 → 「使用配对码配对设备」 → 拿到 6 位码 | — |
| 首次 | 在 khyos 的「激活提权」页输入 6 位码 | khyos 与本机 adbd 配对（记下自己的密钥），开 shell，把代理以 uid 2000 拉起 |
| 之后每次开机 | **零操作** | khyos 自动重连本机 adbd、自动拉起代理 → `elevated=true` |
| 任何时候 | 不想用提权 | 关掉无线调试开关即可，khyos 安静降级回 App uid（现有降级链不变） |

> 与现状的差别只有一处，但正是「装了就行」与「装了还要折腾电脑」的分界：
> 现在是 **PC 侧脚本** `provision-shell-sidecar.ps1` 跑一条 adb 命令把代理拉起来；
> 目标形态是 **App 自己**完成同一件事，用户不用碰电脑。

## 2. 机制（解包 + 实测）

### 2.1 Shizuku 自己是怎么做的（解包证据）

对官方 release v13.6.0 解包（方法与样本见 `[DESIGN-ARCH-211]` §1），其自启动相关类的
字符串常量给出机制骨架：

| 类 | 常量 | 含义 |
|---|---|---|
| `moe.shizuku.manager.adb.AdbPairingService` | `_adb-tls-pairing._tcp`、`paring_code`、`Pair succeed` / `Pair failed`、`start` / `stop`、`startForeground failed` | 前台服务做配对；配对码以 intent extra 传入 |
| `moe.shizuku.manager.adb.AdbPairingClient` | `127.0.0.1`、`adb`、`AdbPairClient`、`PairingPacketHeader version mismatch (us=1 them=…)`、`header payload not within a safe payload size`、`PeerInfo.size=8192` | **连的是本机 127.0.0.1**，自己说 adb 配对协议 |
| `moe.shizuku.manager.shell.Shell` | `moe.shizuku.server.IShizukuService`、`Permission denied` | 拿到 shell 后再取服务 |

⇒ **Shizuku 在 Android 11+ 上不需要电脑**：它连自己的 adbd，配对，开 shell，起 server。
手机屏幕上那句「在 Android 11 或更高版本上，您可以直接从您的设备启用无线调试并启动 Shizuku，
无需连接到计算机」正是这条路径的用户说明（截图存证见 `[DESIGN-ARCH-211]` §7）。

### 2.2 adb 协议的三条实测事实（**不要凭记忆写**）

用本机真实 `platform-tools/adb.exe` 连一个本地假 adbd，把客户端真正发出的字节抓下来
（`delivery/mobile/khy-os-client-app/scripts/capture-adb-wire-format.js`），
三条事实与「常识」相左，全部钉成黄金向量：

| # | 字段 | 常识说法 | **实测** |
|---|---|---|---|
| 1 | 第 6 个头字（magic） | 恒为 `0xffffffff` | **`command XOR 0xffffffff`**：CNXN→`0xb1a7b1bc`、OPEN→`0xb1baafb0` |
| 2 | 第 5 个头字（data_crc32） | CRC32 | **payload 字节之和**，且**只有 CNXN 填**：286 字节 banner → `0x701d`（精确等于字节和）；OPEN → `0`（而其 payload 字节和是 1573） |
| 3 | payload 结尾 | 都带 NUL | **服务串带 NUL**（`shell:echo hello` = 17 字节），**CNXN banner 不带**（286 字节，无 NUL） |

**这三条错一条，握手就静默不成立**——在手机上表现与「服务没开」完全一样，无法自证。
所以期 1 不是「抄个协议」，而是**把字节测出来并钉住**（§5 期 1 验收）。

### 2.3 khyos 的落地链路（时序）

```
[手机] 用户：设置 → 无线调试 → 使用配对码配对设备 → 得到 6 位码
   ↓
khyos: NsdManager 发现 _adb-tls-pairing._tcp（127.0.0.1:<随机端口>）
   ↓  AdbPairingClient：CNXN → AUTH(SIGNATURE, RSA) → OPEN "pair:<6位码>"
   ↓  ⇒ adbd 把 khyos 的公钥记进 /data/misc/adb/adb_keys（配对态持久）
[手机] khyos：NsdManager 发现 _adb-tls-connect._tcp → TLS 连接 → AUTH(公钥签名) → OPEN "shell:"
   ↓  ⇒ 拿到 uid 2000 的 shell 通道
khyos: 通过该通道把自身 classes.dex 写入 /data/local/tmp/khyos.dex（shell 有权写，App 自己写不进 /data/local/tmp）
   ↓  ⇒ 执行 dalvikvm -cp /data/local/tmp/khyos.dex <sidecar class> --port 8897
[手机] sidecar 以 uid 2000 运行 → khyos 的提权链第一级恢复 → elevated=true
[手机] 每次开机：khyos 启动 → 发现端点 → 用已配对的密钥直接连（不再要 6 位码）→ 重连 shell → 重起代理
```

**为什么必须是「连本机」**：无线调试的配对端点与连接端点只监听 **loopback**；
外部 PC 走的是 mDNS 广告出来的局域网地址，而 **App 自己只能连 127.0.0.1**——
这也解释了为什么这条路径天然不需要电脑。

### 2.4 配对传输的实测事实（2026-11-12，真实 `adb pair` 抓包）

| 项 | 实测 |
|---|---|
| 传输 | 配对端点是 **TLS 包着的**（mDNS 名 `_adb-tls-pairing._tcp`）；配对期间**客户端不校验服务端证书**——信任锚是那 6 位码，所以自签假服务端能站在那儿 |
| 客户端首包 | TLS 握手后**恰好 38 字节**：`01 00 00 00` + `00 20` + 32 字节 |
| 那 32 字节 | **每次连接都新**：同码连抓两次不同，换码也不同 ⇒ 不是码的函数 |
| 是不是密钥派生 | **不是**：抓包期间 PC 上的 `~/.android/adbkey` **未被改写**（仍是旧文件），所以它是**连接级材料**（随机数或临时公钥），不是长期密钥的哈希 |
| 仍未取到 | **服务端回包** + **真正带 6 位码的那个包**；`00 20` 的语义（长度？命令？）也未定 |

### 2.5 配对这条线探到了哪（2026-11-12 第二轮，黑盒极限）

用**真实 `adb pair` 客户端**配一台**自签 TLS 中间人**，把真实对话抓了出来（`scripts/capture-adb-pairing-mitm.js`）：

| 观测 | 事实 |
|---|---|
| 客户端首包（真包，经中间人确认） | 与 fake-server 抓到的一致：`01 00 00 00` + `00 20` + 32 字节 |
| 配对端口 | **每次重开配对页就换**（实测 34509 → 40781 → 42717） |
| 服务端行为 | **TLS 握手完成后立刻 RST**——即使转发的正是真实客户端用**正确配对码**发出的真包 |
| 推论 | 配对凭证**与 TLS 会话绑定**（或 adbd 对会话另有要求）⇒ **中间人方案不成立**；盲发重放同样必被拒 |

⇒ **黑盒到此为止**：剩下的「服务端回包 + 带码那一包」**必须**拿到 AOSP 的 pairing 规范才能照实实现，
而 AOSP 源站在本网络不可达（raw / googlesource / jsdelivr / codeload 全被挡）。
两条抓包工具已入库（`capture-adb-pairing.js` 录客户端侧、`capture-adb-pairing-mitm.js` 录双向），
换网络或换镜像拿到源码后即可续上。

⇒ 已知的部分固化为 `AdbPairingProtocol.kt`（含 4 条黄金向量断言），抓包工具 `capture-adb-pairing.js` 入库，
**未知的部分不写进代码**——这正是普通传输里 magic / “CRC32” / 结尾 NUL 三处翻车的原因（§2.2）。



## 3. 与既有实现的关系（**不新开并行实现**，B-U5.1）

| 既有件 | 处置 |
|---|---|
| `shell/ShellSidecar.java`（uid 2000 代理本体） | **复用**，不重写。它已是「不依赖 Shizuku 的提权通道」 |
| `scripts/provision-shell-sidecar.ps1`（PC 侧武装） | **保留**：人工兜底与排障通道；自举成功后它不再是必经之路 |
| `Tools.java` 三级提权链 | **已降为两级**（sidecar → App uid）：官方通道在 §11 被移除 |
| 官方 Shizuku 通道（`ShizukuServiceManager.kt`） | **已移除**（§11）：提权改由 `ElevationManager.kt` 提供 |

⇒ 本提案**不新增第二个提权实现**，只是给**既有 sidecar**补一条「谁来拉起它」的路。

## 4. 落点（文件清单）

| 文件 | 期 | 职责 | 状态 |
|---|---|---|---|
| `android/.../shell/AdbProtocol.kt` | 1 | adb 帧格式：magic/checksum/服务串编解码 | **✅ 已落地** |
| `android/app/src/test/.../shell/AdbProtocolTest.kt` | 1 | 黄金向量回归（真实 adb.exe 抓包钉版） | **✅ 已落地** |
| `scripts/capture-adb-wire-format.js` | 1 | 重新抓黄金向量（adb 升级后刷新测试用） | **✅ 已落地** |
| `android/.../shell/AdbAuthKey.kt` | 2 | RSA 密钥对持久化 + 对 challenge 签名 + mincrypt 公钥编码 | **✅ 已落地** |
| `android/.../shell/Spake2.kt` + `shell/Ed25519.kt` | 2 | SPAKE2 over Ed25519（AOSP/BoringSSL 权威源） | **✅ 已落地（Spake2Test 8/8）** |
| `android/.../shell/AdbPairingClient.kt` | 2 | 配对端点握手（TLS1.3 → 导出密钥 → SPAKE2 → PeerInfo） | **✅ 已落地** |
| `scripts/adb-pairing-common.js` + `adb-pairing-server.js` | 2 | Node 参考实现 + 配对服务端（被平台真 `adb pair` 验收） | **✅ 已落地** |
| `android/.../shell/ElevationBootstrap.kt` | 2 | 自举编排：发现端点 → 配对/重连 → 起 sidecar | **✅ 已落地** |
| `android/.../shell/ElevationState.kt` | 2 | 提权态真源（enabled/elevated/device_auth/last_pair_ms） | **✅ 已落地** |
| `android/.../shell/AdbTlsCertificate.kt` | 2 | 客户端证书（CN=指纹, O=AdbKey-0，实测设备接受） | **✅ 已落地** |
| `android/.../shell/AdbPairingProtocol.kt` | 2 | **配对传输的已知部分**（首包形状 + 连接级材料），未知的**不写** | **✅ 已落地（4 断言）** |
| `scripts/capture-adb-pairing.js` | 2 | 录真实 `adb pair` 的字节 | **✅ 已落地** |
| `bridge/ShellLevelPolicy.java` | 2 | required_level 分级（app|shell）+ needs_shell 错误码 | **✅ 已落地** |
| `bridge/ToolSchema.java` | 2 | 63 工具逐工具 required_level 真源 | **✅ 已落地** |
| `MainActivity.kt`（elevationPair/elevationSetEnabled/openDeveloperSettings） | 2 | App 内配对 + 开关 + 开发者选项跳转 | **✅ 已落地** |
| `lib/ui/widgets/vfs/vfs_elevation_guide.dart` | 3 | 配对码输入 + 开关 + 状态呈现（App 内配对） | **✅ 已落地** |
| `lib/core/services/device_control.dart`（pairElevation/setElevationEnabled） | 3 | Dart 侧配对/开关 + 四类审计 | **✅ 已落地** |
| `scripts/pair-khyos-key.ps1` | 2 | ~~PC 侧一次性配对~~ | **❌ 已删**（T6：私钥不得落 /sdcard；App 内配对取代） |
| `ElevationBootstrap.exportKeyForHost()` | 2 | ~~把私钥导出到外部存储供 PC 拉取~~ | **❌ 已删**（T6；存证 scrub-plan.md） |

## 5. 分期与验收

| 期 | 内容 | 验收（可复现） |
|---|---|---|
| **1** | 协议层 + 黄金向量 | ✅ 已落地：`AdbProtocolTest` 8/8 绿；`encodeCnxn/encodeOpen` 与真实 `adb.exe` 抓包**逐字节一致**；本地 kotlinc 编译 exit 0 |
| **2** | 配对与传输 | ✅ 协议层已落地：AOSP 权威源实现 + `Spake2Test` 8/8 黄金向量全绿 + 643 个单元测试全绿；**真机配对端点实测通过**（T2：SPAKE2 交换 + PeerInfo 解密成功，取回设备 GUID）。**未测**：App UI 触发链（按钮点击 → elevated=shell） |
| **3** | 自启动与 UI | ⚠ 部分：UI 已落地（配对码输入 + 开关 + 状态）；**未测**：真机重启后自动重连——实测 Android 16 重启后无线调试默认关闭（平台事实），自动重连无对象可连。**未测**：全程不装 Shizuku（设备上官方 Shizuku 仍装着，见 §11.5，产品不依赖它） |

**期 1 的实测工具留在仓内**：adb 升级后重跑 `capture-adb-wire-format.js` 刷新向量，
**不要靠猜改测试**（§2.2 的三条就是猜出来的反面教材）。

## 6. 边界（做不到的那一条，必须说清）

「完全替代 Shizuku」的准确含义是：**khyos 自己不再需要 Shizuku**。
以下这条**做不到**，不要含糊：

- **别的 App 无法通过「官方 Shizuku API」调用 khyos**。原因有三，且都不是工程量问题：
  ① 那个 binder 由**官方 Shizuku App** 以官方包名发布，Android 的包名与签名唯一；
  ② 上游 Apache-2.0 的 Section 6 明确禁止用 `moe.shizuku.privileged.api` 作 applicationId；
  ③ 本仓 B-S3 绝对红线禁止搬上游代码。
  ⇒ 想让**第三方 App** 用 Shizuku API，仍然只能装官方 Shizuku。
  khyos 能提供的是**自己的等价能力**（uid 2000 shell，与 Shizuku 同级）。

- **无线调试开关仍需用户在系统设置里开一次**（系统权限，App 不能静默开启）。
  首次配对需要用户在系统「使用配对码配对设备」页取 6 位码——这一步是系统设计，不是遗漏。

## 7. 复现

```powershell
# 1) 协议层回归（本地 kotlinc + junit；无需设备）
#    见 §5 期 1 的验收命令
# 2) 重新抓黄金向量（adb 升级后）
node delivery\mobile\khy-os-client-app\scripts\capture-adb-wire-format.js 5556 <out.jsonl>
adb connect 127.0.0.1:5556
adb -s 127.0.0.1:5556 shell echo hello
```

## 8. 风险与回退

| 风险 | 缓解 | 回退 |
|---|---|---|
| adb 协议随 Android 升级变化 | 黄金向量 + 抓包工具（§5） | 代理起不来时回退 PC 侧 `provision-shell-sidecar.ps1` |
| 配对态/密钥丢失（换机、清除数据） | 明确失败并提示重新配对，不静默 | 同上 |
| 自举代理的权限面过大 | 沿用现有三道闸（sidecar 令牌 + `ShellCommandPolicy` 白名单 + `LoopModes`），**本提案不新增执行入口** | 关掉无线调试即失效 |
| 期 2/3 做不完 | 期 1 独立成立（协议层可测） | 保持现状：PC 侧武装 + 官方 Shizuku 双通道 |

---

## 9. 「完全等价」的精确定义：Shizuku 公开 API 全清单 vs khyos 现状

**怎么算等价**不能靠印象，所以这里把 Shizuku 的**公开 API 面**逐个列出来（来源：`dev.rikka.shizuku:aidl:13.1.5`
的 AIDL 与 `dev.rikka.shizuku:api:13.1.5` 的静态方法，用 `javap` 逐个核过，非记忆）。
一共 **21 个 `IShizukuService` 方法 + 8 个 `IRemoteProcess` + 3 个 `IShizukuApplication`
+ 4 个 `IShizukuServiceConnection` + 客户端 20 个静态方法**。

### 9.1 能力矩阵

| Shizuku 能力 | 作用 | khyos 现状 | 差距 | 补法 |
|---|---|---|---|---|
| `newProcess(argv, env, cwd)` → `IRemoteProcess` | **提权执行命令**（核心） | sidecar `EXEC`（`sh -c`，可带 cwd） | △ 无 env、无 stdin、**无常驻进程** | 侧：新增 `EXEC_IN` / `EXEC_STREAM`；客：`ShellSidecarClient` |
| `IRemoteProcess`：三管道 + `waitFor`/`exitValue`/`destroy`/`alive`/`waitForTimeout` | 进程生命周期与交互 | 只有一次性 `RESULT`（exit/out/err） | △ | 同上（协议层可扩展，sidecar 是纯 Java ⇒ 可 JVM 测） |
| `getUid()` | 提权身份 | sidecar `INFO` 带 uid | ✅ 等价 | — |
| `getVersion()` | server 版本 | sidecar `IDENT`（`shell-sidecar 1`） | ✅ 等价 | — |
| `getSELinuxContext()` | SELinux 上下文 | ✗ | △ | `id -Z` 经 `EXEC` 近似 |
| `getSystemProperty`/`setSystemProperty` + `ShizukuSystemProperties` | 系统属性读写 | `EXEC` 走 `getprop`/`setprop` | △ 受限 | 专用命令或策略化 `setprop` |
| `checkPermission(pkg)` | 查他包权限 | ✗ | △ | `dumpsys package` 近似 |
| `checkSelfPermission` / `requestPermission` / `shouldShowRequestPermissionRationale` | 自身授权 | ✅（provider 接线后，见 `[DESIGN-ARCH-211]`） | ✅ | — |
| `isHidden(api)` | 隐藏 API 查询 | ✗ | △ | 放弃（收益低、风险高） |
| `getFlagsForUid` / `updateFlagsForUid` | 读/改某 uid 的应用标志 | ✗ | ✗ | **能力上 khyos 同样做得到**（sidecar 就是 uid 2000，与 Shizuku server 同权）；**要不要对模型开放是策略问题**（`LoopModes` / `ShellCommandPolicy`），不是能力缺失 —— 详见 §9.4 |
| `addUserService`/`removeUserService`/`attachUserService` + `IShizukuServiceConnection` | **以调用方 uid 跑的服务，由 shell 托管** | ✗ | ✗ | **超越点**：sidecar 可托管 khyos 自己的长驻服务 |
| `attachApplication` + `IShizukuApplication` | 拿到 shell 权限的**伪 Application 上下文** | ✗ | ✗ | 高价值但要改 App 架构（一个进程只能有一个 Application） |
| `dispatchPackageChanged(Intent)` | 包增删改事件 | ✗（khyos 有自己的桥与轮询） | ≈ | 自研更贴合，不追平 |
| `dispatchPermissionConfirmationResult` | 授权结果回传 | ✅ | ✅ | — |
| `exit()` | 结束 server | ✗ | 低 | 不做（sidecar 生命周期归 khyos 管） |

**结论**：Shizuku 的 API 面 ≈ **「一个裸 shell + 三个超越普通 shell 的口子」**：
① 持久/交互进程；② user service（以 App uid 跑的托管服务）；③ 伪 Application 上下文。
khyos 现状覆盖了「执行命令」这一主面，其余三块是缺口，其中 **① 在协议层可补**，
②③ 需要架构决策（§9.3）。

### 9.2 khyos 超越 Shizuku 的地方（已具备，非口号）

| 维度 | Shizuku | khyos |
|---|---|---|
| 策略层 | 给的是**裸 shell**，调用方自负全责 | `ShellCommandPolicy` 白名单 + `LoopModes` 三档 + `ShellSidecar` 令牌闸，**提权能力带策略** |
| 审计 | 无 | 每次提权执行在桥侧留痕，可回放 |
| 能力粒度 | 只有一个「shell」 | 原子能力目录（`ATOMIC-CAPABILITIES.json`），模型按能力调而非拿 shell |
| 装机成本 | 要装 Shizuku + 授权 | 装 khyos 即可（目标形态，见 §1） |
| 协作面 | 只有 binder | HTTP + 文件信箱双通道、PC 协作、悬浮执行台、过程可观测可打断 |
| 提权之外 | 无 | 无障碍、截屏、应用管控等一整套手机端能力 |

⇒ 「超越」不是把 Shizuku 抄一遍，而是**在同一条 uid-2000 通道上叠一层策略、审计与能力目录**。

### 9.3 缺口补齐的优先级（接 §5 分期）

| 序 | 缺口 | 落点 | 为什么排这个序 |
|---|---|---|---|
| 1 | **自举**（谁来拉起代理） | §5 期 2/3 | 这是「装了 khyos 就行」的门槛；其它能力都要代理在跑才有意义 |
| 2 | **交互/常驻进程**（对齐 `IRemoteProcess`） | sidecar 协议 + `ShellSidecarClient` | **第一刀已落地**：`ShellSidecarProtocol`（纯 Java 请求侧）+ `EXEC_IN`（带 stdin 的执行），3 条断言离线绿；**常驻进程与流式仍待做** |
| 3 | **系统属性读写** | sidecar 协议 | 低成本、对调试与系统配置类工具直接有用 |
| 4 | **user service 式的托管服务** | 架构决策 | 能力最强、但要先想清与现有桥/服务的边界（B-U5.1） |
| 5 | 伪 Application 上下文 | 架构决策 | 收益高、代价高（进程模型），不急 |

**明确不做**：`updateFlagsForUid`（越权）、`exit`（生命周期不归它管）、`isHidden`（收益低）。

### 9.4 「改 uid 标志」这类能力：khyos 能不能做，怎么做

**能做。** 这一条曾被写成「明确不做（越权面）」，那是判断，不是事实——纠正如下：

- **权限面相同**：Shizuku 的 server 与 khyos 的 sidecar **都是 uid 2000**。框架层面对 uid 2000 开放的
  任何操作，khyos 同样能做。差别不在**能不能**，而在**要不要给模型用**。
- **两条实现路径**：

  | 路径 | 做法 | 覆盖 | 代价 |
  |---|---|---|---|
  | **shell 路径**（今天就能做） | sidecar 以 uid 2000 执行 `cmd package` / `am` / `dumpsys package` | 绝大多数「应用标志」类操作（停用/卸载/挂起/查状态） | 依赖命令行的输出格式，脆但零架构改动 |
  | **framework 路径**（更完整） | 像 Shizuku server 那样在 `app_process`/`dalvikvm` 下挂 `framework.jar`，直接调隐藏 API（`PackageManagerInternal` / `ActivityManagerInternal`）读写 `ApplicationInfo.flags` | 全部标志位 | 会打破 sidecar 当前「零 `android.*` 依赖」的约束 |

- **关于那条约束**：sidecar 之所以零 `android.*` 依赖，是因为它在 `app_process` 下会缺
  `libandroid_runtime`（见 `ShellSidecar.java` 的类注释）。但它跑的是 **`dalvikvm`**，
  而 dalvikvm **可以挂 `framework.jar`**（真机上 Shizuku 的 server 进程就开着
  `/apex/com.android.art/javalib/*.jar` 与 `framework.jar`）。⇒ **约束可解，不是死路**。
- **结论**：**能力不缺，缺的是把它接进受控的能力目录**——原子能力 + 风险分级 + 审批闸，
  而不是「能不能做」。khyos 的架构优势恰好在这里：Shizuku 给的是一根裸 shell，
  khyos 可以给「一个分级、可审计、按需审批的 uid 级操作能力」。

**未取证的部分（如实标注）**：这两个方法在 Shizuku server 侧的**具体实现**没有查清。
server 的代码在 APK 的 `assets/rish_shizuku.dex` 里（59 KB，R8 混淆），且本轮对它的
反编译取字未成功（dexdump 输出编码与检索问题）。因此本节只断言「**权限面等价 ⇒ 能力可得**」，
**不断言** Shizuku 用的是哪条具体路径、改的是哪几个标志位——那需要再取一次 server 侧字节。

## 10. 未决事项（交人裁决，本文不代劳）

1. **配对协议还差两半**（2026-11-12 更新）：客户端首包**已实测取得**（38 字节，形状已钉版，
   见 §2.4 与 `AdbPairingProtocol.kt`）；**仍缺**「服务端回包」与「真正带 6 位码的那个包」。
   取法二选一：
   ① **拿 AOSP 源码**：`packages/modules/adb`（本网络下 raw / googlesource / jsdelivr /
      codeload 全被挡，需换网络或换镜像）；
   ② **用手机当 oracle**（更直接）：手机进「设置 → 无线调试 → 使用配对码配对设备」，
      此时 adbd 的配对端口才在 loopback 上监听；然后
      `adb forward tcp:5559 tcp:<配对端口>`，再用 `capture-adb-pairing.js` 的客户端
      **重放已抓到的首包**，就能读到 adbd 的回包；再让假服务端按回包格式应答，
      即可抓到客户端第三包（带码的那一包）。
   **工具已备好**：`scripts/capture-adb-pairing-reply.js` 会自动轮询设备、一旦配对端口
   出现就转发+重放+收包（无需掐时间）。干跑已验证：它只认 **127.0.0.1 上 adbd 的端口**
   （connect 端点绑在 `::`、sidecar 绑 8897，都会被排除——第一版正是栽在这里）。
   **2026-11-12 人裁决：先不取这一段**（配对握手暂缓），已抓到的首包成果与工具全部保留；
   期 2 的「配对」部分因此仍未开工，期 2 的其余部分（RSA 签名 / TLS 连接 / shell 流）
   不受此影响，可独立推进。
   **同日补充（第二轮黑盒）**：已用真实客户端 + 自签中间人抓到**真首包**（形状与前次一致），
   并测得服务端在 TLS 握手后**立刻 RST**，即使转发的是带正确配对码的真包 ⇒ 配对凭证与
   TLS 会话绑定，**中间人方案不成立**（详见 §2.5）。⇒ 这条线的唯一出路是**拿到 AOSP 的
   pairing 规范**（换网络/换镜像），而不是继续猜包。
2. **uid 标志类能力的暴露口径**（§9.4）：能力可做，但要不要给模型、给哪几类、按什么审批——属策略裁决。
3. **user service 式托管服务 / 伪 Application 上下文**（§9.1）：能力最强，但要先划清与现有桥、
   悬浮执行台、服务进程的边界（B-U5.1）。
4. **App 引导页改写**（期 3）：现在那段「先装 Shizuku」的文案与实测不符，且主线应改为
   「khyos 自带通道优先」。
5. **是否仍保留官方 Shizuku 通道**：保留则多一条兜底（别的 App 也能用 Shizuku API），
   去掉则 khyos 与 Shizuku 彻底解耦——这是产品口径，不是技术问题。

---

## 11. 裁定：完全移除官方 Shizuku（2026-11-12，人决策）

**人裁决原文要点**：「让 khyos 完全脱离 shizuku，提供等价能力；不内置；装了 khyos 就行。」
配套两个老问题的结论（本代理决定）：**不内置官方 Shizuku APK**（与「完全移除」自洽）、**改 App 引导页文案**（旧文案让用户去装 Shizuku，已不成立）。

### 11.1 移除范围（已落地）

| 移除项 | 位置 |
|---|---|
| 三个客户端依赖坐标 | `android/app/build.gradle` |
| 清单里的客户端 provider | `AndroidManifest.xml` |
| 官方通道适配层 | `ShizukuServiceManager.kt`（已删）→ 由 `ElevationManager.kt` 取代 |
| 内置的官方 APK | `android/app/src/main/assets/shizuku/shizuku-release.apk`（2.57 MB，已删） |
| 自动安装通道 | `shizukuAutoInstall` / `install_shizuku` 工具（原生 + Dart 两侧都删） |
| 依赖它的两个测试 | `ShizukuProviderWiringTest` / `ShizukuServiceManagerTest`（已删） |

**提权链从三级降为两级**：sidecar（uid 2000）→ App uid。`Tools.java` 里的 Shizuku 探针与执行分支、
`elevationReady` / `elevationWhy` 快照键一并删除。

### 11.2 等价性（为什么这仍然是「等价」而不是「缩水」）

Shizuku 的 server 与 khyos 的 sidecar **同为 uid 2000 shell**——权限级别相同。
被移走的是「多一个 App、多一次授权、多一份三方二进制」的代价，留下的是：
**装 khyos 即可提权，且不装任何第二个 App**（§1 的目标形态）。

### 11.3 防回流守卫

`scripts/ci/check-no-shizuku-dependency.js`：扫依赖坐标、包引用、清单 provider、
已删通道名、硬编码包名、assets 里的安装包——**任一回流即 exit 1**。
2026-11-12 实测：移除前 **42 处** → 移除后 **0 处**；并在假树上验证过它确实会红。

### 11.4 遗留的诚实风险（不粉饰）

移除官方通道后，**提权完全依赖 sidecar**，而 sidecar 今天仍需电脑侧一条命令武装，
且**不随重启保留**。真正的「装了就完事」要等 §5 期 3 的自举（卡在 AOSP pairing 规范，§2.5）。
也就是说：**这一刀让产品更干净，但把「重启后要重跑命令」这件事从「两条路里的一条」变成了「唯一一条路」**——
这是人已知并接受的方向，但落地前要保证 §10 第 1 条（拿到 AOSP 规范）不被无限期搁置。
### 11.5 设备侧保留官方 Shizuku（2026-11-12，人裁定补充）

**产品不依赖 ≠ 设备上不装。** 人裁定的原文是「完全脱离」——指 khyos **不捆绑、不依赖、不调用**
官方 Shizuku；**手机上的官方 Shizuku 保留**，理由是它是**通用备用通道与调试工具**：
别的 App 可能要用它，设备调试时它也是现成的 uid-2000 入口。

| 层面 | 状态（2026-11-12 实测） |
|---|---|
| 仓内内置 APK | **已删**（`assets/shizuku/shizuku-release.apk` 2.57 MB） |
| 编译期依赖 | **已删**（三个 `dev.rikka.shizuku:*` 坐标） |
| 运行时调用 | **已删**（适配层、清单 provider、自动安装通道） |
| **手机上的官方 Shizuku** | **保留**：13.6.0 仍安装着，server 以 uid 2000 在跑 |
| khyos 自己的通道 | **照常可用**：sidecar → `elevated=true`（与 Shizuku 同级） |

⇒ 两条通道并存，但**互不依赖**：khyos 不碰官方 Shizuku；官方 Shizuku 在设备上随时可被别的 App 使用，
也随时可以由人用 `scripts/start-shizuku-service.ps1` 拉起来。**这不是把依赖偷偷放回来**——
`scripts/ci/check-no-shizuku-dependency.js` 守的是「仓内/编译期/运行时不得依赖」，设备上的安装不在其列。
### 2.6 配对协议：从上游实现里解出来了（2026-11-12，jadx 反编译官方 APK）

**上一节的「拿不到规范」已经绕过去了**：不必依赖 AOSP 源码——直接反编译官方 Shizuku APK
（`jadx 1.5.6`），配对客户端的实现原样躺在里面。**下面的描述来自上游实现，不是推测**：

| 事实 | 上游实现依据 |
|---|---|
| 传输是 **TLS**，且服务端证书**不校验**（配对码才是信任锚） | `AdbPairingClient.b()`：`SSLSocketFactory.createSocket(...)` + `startHandshake()`，无证书校验 |
| 会话密钥**绑定 TLS 会话** | `Conscrypt.exportKeyingMaterial(sslSocket, "adb-label\u0000", null, 64)` → 作为 keying material 传给 `PairingContext.nativeConstructor` |
| **包头 6 字节**：`version(1) + type(1) + length(4, BE)` | `Ij`/`c()`：先 put 两个 byte，再 putInt(length)；`a()` 按 BIG_ENDIAN 读回 |
| **首包 payload = 客户端公钥（32 字节）**，type=0 | `PairingContext.b`（= `nativeMsg`）长度 32；`c(new Ij(1, 0, len), payload)` |
| 服务端回包 type=0 → 用对方公钥初始化 cipher | `pairingContext.e(payload)`（= `nativeInitCipher`） |
| 第二轮 type=1 走**加密消息** | `c(new Ij(1, 1, len), pairingContext.d(buf))`；对端 `b(payload)` = `nativeDecrypt` |
| **成功判据：服务端回一个 8192 字节的 PeerInfo** | `if (bArrB.length == 8192)`；日志串 `PeerInfo.size=8192` |
| 加密/签名在 **native**（`libadb.so`） | `PairingContext` 的 `nativeEncrypt/nativeDecrypt/nativeInitCipher` 全是 JNI |

**为什么中间人必然失败（源码级结论）**：会话密钥由 **TLS 会话本身**导出
（`exportKeyingMaterial`）。代理重新加密后，两端的 keying material 不同 ⇒ 校验失败 ⇒ 服务端 RST。
此前所有「连字节都没发也被 RST」的观测，现在有了确切解释。

**两条实现路线（§5 期 2 的落点据此修订）**：

| 路线 | 做法 | 依赖 | 可行性 |
|---|---|---|---|
| **A：自实现 pairing** | App 内做 Conscrypt TLS + 自实现 ECDH/加解密 | 需要 AOSP 的 pairing 密码学细节（仍在 `libadb.so` 里） | 细节仍缺 ❗ |
| **B：PC 配对一次 + App 走标准 adb 协议** | App 生成 RSA 密钥对 → PC 用 `ADB_VENDOR_KEYS` 带上 App 公钥执行 `adb pair` → 之后 App 用**标准 adb 协议**连 connect 端点 | 标准 adb 协议（**已实测钉版**，§2.2）+ TLS + RSA 签名 | **全标准件，可实现** ✅ |

⇒ **路线 B 是「装了就完事」的现实解**：首次需要电脑配合一次（Shizuku 同样如此），
之后 App 自己持钥、自己连、自己拉起代理，**不再需要任何第三方 App**。

### 2.7 连接侧的认证协议：实测钉版 + 落地（2026-11-12 第三轮）

路线 B 只差「App 怎么向 adbd 证明自己是谁」这一块。这一轮把它测出来了，**并且实现了**。

**抓包方法**：把本机真实 `platform-tools/adb.exe` 指向一个本地假 adbd
（`scripts/capture-adb-wire-format.js`），同时开 `ADB_TRACE=all` 看 adb server 自己的
状态机。两边对上之后，协议事实如下（**与「常识」相左的地方已标出**）：

| # | 事实 | 证据 |
|---|---|---|
| 1 | 设备先发 **AUTH arg0=1**，payload **20 字节** = 挑战 token | 抓包：`from remote: [AUTH] arg0=1 arg1=0 (len=20)` |
| 2 | 客户端回 **AUTH arg0=2**，payload **256 字节** = 签名 | 抓包：`to remote: [AUTH] arg0=2 arg1=0 (len=256)`，trace：`adb_auth_sign len=256` |
| 3 | **arg0=2 是「签名」，不是「公钥」** | 常量序为 TOKEN=1 / **SIGNATURE=2** / RSAPUBLICKEY=3 / RSAchallenge=4。旧资料里「arg0=2 是公钥」是**旧版协议**（那时 SIGNATURE=3） |
| 4 | 签名是 **PKCS#1 v1.5**，摘要信息是 **SHA-1** | 用 PC 自己的 adbkey 做 `m = s^e mod n` 反解，尾部是 `30 21 30 09 06 05 2b 0e 03 02 1a 05 00 04 14` |
| 5 | **被签的是 token 本身，不是 SHA-1(token)** | 反解出的 20 字节与 token **逐字节相同**；而 `SHA-1(token) = 853a1eee…` 在整块里**根本没出现** |
| 6 | AUTH 包的 `data_crc32` = **0** | 客户端自己发的 AUTH(2) 就是 0（CNXN 才是字节和） |
| 7 | 服务端的 AUTH 包**也**用 0 | 用 0 重放后客户端才继续（用 CRC32 时客户端直接挂断） |

⇒ 第 5 条是本轮最有价值的一条：**平台把那个 20 字节 token 当成「已经算好的摘要」直接签**。
所以 `Signature.getInstance("SHA1withRSA")` 是**错的**（它会再哈希一次），签出来的签名设备一律不认，
而且**失败是静默的**——设备根本不回话，在手机上表现与「无线调试没开」一模一样。
因此 `AdbAuthKey` **手工拼 PKCS#1 v1.5 块**（`BigInteger.modPow`），并用第 4/5 条的
反解结果做单测钉死。

**已落地（路线 B 的代码）**：

| 文件 | 作用 |
|---|---|
| `shell/AdbAuthKey.kt` | App 自己的 RSA-2048 身份：生成、持久化、手工 PKCS#1 v1.5 签名、导出 PEM（`adb` 能读的 PKCS#8 形状） |
| `shell/AdbClient.kt` | 纯 JVM 的 adb 客户端：TLS → CNXN → 答挑战 → OPEN `shell:` → 读 WRTE 流 |
| `shell/ElevationBootstrap.kt` | 自举编排：连本机 adbd → 用**自身 APK** 起 sidecar → 等 sidecar 报 listening → 探活 |
| `shell/AdbProtocol.kt` | 帧格式（已按本轮实测更新 AUTH 常量与 `encodeAuthSignature`） |
| `scripts/pair-khyos-key.ps1` | **一次性**配对：从手机拉下 App 的身份 → `ADB_VENDOR_KEYS=该文件 adb pair` → 删掉 PC 上的临时副本 |

**为什么 sidecar 不用上传 dex**：`CLASSPATH=<自己的 APK> app_process /system/bin <sidecar 类>`
直接跑**装在手机上的这份代码**。这样「只留一个 APK」的性质在自举之后依然成立，
也不会出现设备上的代码和装着的 App 不同版本的问题。

**离线可证的部分**（不依赖手机）：`AdbAuthKeyTest` + `AdbClientTest` + `AdbProtocolTest`
共 17 条 JVM 用例全绿——包括「假 adbd 用**设备的验签规则**验我们的签名」这一条。
本地编译/运行方式见 §7。

**仍需真机确认的部分**（手机当前不在网，未验）：① `adb pair` 是否确实用
`ADB_VENDOR_KEYS` 授权了 App 的公钥；② 无线调试的 **connect 端点**是否接受「App 从本机连回自己」
（文档说端点只监听 loopback，那 App 就该连 `127.0.0.1`，而不是 mDNS 广告的局域网地址——
**这一点必须实测，不能照抄文档**）；③ `app_process` 起 sidecar 在目标机型上的行为。
这三项的结论会回写本节。

### 2.8 传输层：STLS 升级 + 双向 TLS（2026-11-12 第四轮，真机 MITM 实测）

上一节只覆盖了认证。传输层还有两件事，**都是从真机抓包里解出来的**，
其中一件直接改变了实现，一件仍是未解的坑。

**① 传输是「先明文、后升级」，不是一开始就 TLS。**
MITM 夹在 PC 的 adb server 与真机 adbd 中间（`scripts/` 下的 `adb-plain-mitm.js` 用的就是它），
逐字节看到真实顺序：

```
client -> CNXN   明文，286 字节 banner
device -> STLS   24 字节（arg0=1, arg1=0, len=0）
client -> STLS   原样回显这 24 字节
client -> TLS ClientHello
... TLS 握手，之后整个 adb 协议都跑在 TLS 会话里 ...
```

⇒ **直接上 TLS 会被设备挂断**（它等的是明文 CNXN，ClientHello 在它眼里是垃圾）。
⇒ `AdbClient` 因此先发明文 CNXN，见到 `STLS` 就原样回显、再在同一 socket 上做 TLS 升级。

**② 设备要求客户端证书（双向 TLS）。**
升级后设备回一个致命告警 `certificate_required`。设备自己的日志说得更清楚：

```
I/adbd: Received STLS packet. Stopping read thread.
I/adbd: [server]: Initializing adbwifi TlsConnection
I/adbd: adbd_auth: loading keys from /data/misc/adb/adb_keys
I/adbd: fingerprint=[FC6DA2D0A7BBEB3B2A4872BEE9FD83C998B7F8C21FB99851EB4DA151573E3FFD]
E/adbd: [server]: Handshake failed in SSL_accept/SSL_connect [DECODE_ERROR]
```

（那行 `Invalid base64 key` 是**无关噪音**：PC 的 adb 走同一条路成功时也照样打这一行。）

**证书应该长什么样——两处都是实测出来的，不是猜的**：

1. **名字**：设备的 TLS CertificateRequest 直接点名了它要哪张证书：

   ```
   "certificate authorities": [
       CN=FC6DA2D0A7BBEB3B2A4872BEE9FD83C998B7F8C21FB99851EB4DA151573E3FFD,
       O=AdbKey-0
   ]
   ```

   ⇒ 证书主体必须是 **`CN=<adb key 指纹>, O=AdbKey-0`**。
   而那个「指纹」的算法是 **SHA-256(公钥的 SPKI DER)**（大写 hex，64 字符）——
   这一点是拿本机 adbkey 与设备点名要的值对出来的：SHA-256(SPKI) 对得上，
   SHA-256(裸模数) 对不上。

   ⚠ **X.500 的 RDN 打印顺序与 DER 编码顺序相反**：要让名字读成 `CN=…, O=AdbKey-0`，
   DER 里必须 **O 在前、CN 在后**。写反了的后果很隐蔽：JDK 自己的 KeyManager
   因为「签发者不匹配」而**不肯把这张证书递出去**，设备收到的是「没有客户端证书」，
   报 `certificate_required`——一句话都不会说你的名字写反了。

2. **扩展**（从 `adb.exe` 里的字符串挖出来，出自 AOSP 的
   `packages/modules/adb/crypto/x509_generator.cpp`）：`critical,CA:TRUE` 与
   `critical,keyCertSign,cRLSign,digitalSignature`。

⇒ 照这两条做出来的证书，**设备认了**：TLS 握手成功，设备随即发来自己的 banner ✓。

**✅ 这一格已解（2026-11-17，AOSP Android 16 源码，不是再抓一次包）**：
答案根本不在「怎么回那个 STLS」，而在**客户端升级之后不该再发任何东西**。
源码三处合起来才说得通：

| 位置 | 事实 |
|---|---|
| `client/auth.cpp:487-506` `adb_auth_tls_handshake` | 握手成功后只有一句日志：`"Handshake succeeded. Waiting for CNXN packet..."`——**客户端不再说话** |
| `daemon/adb_wifi.cpp:238-245` `adbd_wifi_secure_connect` | 设备侧握手成功后做 `handle_online(t)` + `send_connect(t)`，即**发自己的 CNXN banner**；TLS 模式下**没有 AUTH 挑战**（`handle_packet` 里 `use_tls` 时 `A_AUTH` 直接被忽略，身份就是客户端证书） |
| `adb.cpp:407-433` `handle_new_connection` | 设备每收到一个 CNXN 都走这里；`t->use_tls` 已置位时就再 `send_tls_request`——**又一个 STLS** |

⇒ 上一轮测量里那个「会话内第二个 STLS」不是设备的新要求，是**设备在回应我们升级后
重发的那一份 CNXN**。原样回显它之所以让设备挂断，是因为那等于在已建立的会话上
再开一次 TLS 握手。

**实测修正**：`AdbClient.handshake()` 升级后不再重发 CNXN；见到 TLS 会话内的
CNXN 即视为上线并返回（明文路由仍然等 AUTH 挑战再签名——两条路由在此分叉）。

### 2.9 真正能落地的那条路：设备自己的 adbd 明文端口（2026-11-12，已全程验证）

上面两轮把 TLS 拆到底之后，剩下一个更朴素、也**已经被真机全程验证**的事实：

**手机的 adbd 除了 TLS 端点，还有一个明文 TCP 端口**（`adb tcpip 5555` 打开的那一个）。
它在**设备自己的 loopback** 上（`127.0.0.1:5555`），手机上的任何 App 都连得上；
而 adb 的认证流程与传输层是不是 TLS 无关——**这正是 §2.2 那套帧格式 + §2.7 那条签名规则
唯一被要求成立的地方**。

于是 App 侧自举变成：

```
[App] 生成/持有自己的 RSA-2048 身份（AdbAuthKey），持久化在私有目录
   ↓  （一次性，由电脑侧执行，见 scripts/pair-khyos-key.ps1）
[电脑] adb pair <配对地址> <6位码>  —— 用 ADB_VENDOR_KEYS 带上 App 的身份
       ⇒ 设备记住了「这把钥匙是 khyos 的」
   ↓
[App] 连 127.0.0.1:5555（明文，loopback）
   ↓  CNXN → 收 20 字节挑战 → 用实测规则签名 → AUTH(2)
   ↓  ⇒ 拿到 uid 2000 的 shell
[App] CLASSPATH=<自身 APK> setsid app_process /system/bin <sidecar 类> --port 8897
   ↓  ⇒ sidecar 以 uid 2000 起来，App 的提权链恢复
```

**这一整条链已经在真机上跑通**（2026-11-12）：

| 步骤 | 实测结果 |
|---|---|
| 自研客户端连真机 adbd 的明文端口 | 握手成功 ✓ |
| 挑战签名（SHA-1 当作已算好的摘要直接签） | 设备接受 ✓ |
| `OPEN shell:` + 读流 | `id -u` → **2000** ✓ |
| `CLASSPATH=<自身 APK> app_process …` 起 sidecar | 日志：`listening 127.0.0.1:8897 as uid 2000` ✓ |

⇒ **「装了就完事」这一关的代码已经齐了**：自举不再依赖任何第三方 App、不依赖 root、
也不依赖电脑在场——电脑只需要在**第一次**做两件事（配对 + 打开端口）。

**诚实的一处**：端口不跨重启保留（`service.adb.tcp.port` 不是持久属性，
而 shell 也无权写 `persist.adb.tcp.port`——实测被拒）。所以「重启后完全不用电脑」
还差 §2.8 那一格；在此之前，重启后跑一次 `adb tcpip 5555` 即可（一条命令），
或者直接用电脑侧那条武装脚本。

> **2026-11-17 修订**：§2.8 那一格已经解了（见上一节），明文端口这条路随之
> **降级为兜底**——无线调试端点才是正门，明文端口留给「无线调试关着、
> 而电脑刚好在」的场景。配对也不再必须由电脑做：App 自己实现了配对协议
> （`AdbPairingClient`），真机一次通过。

**为什么 sidecar 不上传 dex**：用 `CLASSPATH=<自身 APK> app_process` 直接跑**装在手机上的这份代码**，
「只留一个 APK」的性质在自举之后依然成立，也不会出现设备上的代码与装着的 App 不同版本。

**sidecar 怎么验「是谁在调用」（2026-11-17 改，真机实测）**：原来是读
`/sdcard/bridge-amoobridge/token.txt` 里的共享令牌。桥按「断点二」不再写那个文件
（`HttpBridge.writeTokenToDisk` 恒 false，还会 purge 旧文件），于是 sidecar
**每个连接都被拒**，而端口开着、日志写着 `listening`——看起来完全正常，
`PING 未应答` 是唯一线索。现在换成挑战应答：launch 时传 App 的设备**公钥**
（公钥不是秘密），每次连接发 32 字节 nonce，调用方用设备私钥签，sidecar 用
`SHA256withECDSA` 验。没有公钥就一律拒（fail closed）。这条与桥对 PC 的主张是同一条：
「出示得出用设备私钥签的东西」，而不是「持有一串躺在共享存储上的字符」。

**这一格上踩过的两个坑（都靠双边哈希才定位）**：

1. **签名被多包了一层 base64**。`b64(sig)` 把一个已经是 base64 的文本又编了一遍
   （`b64()` 是令牌路径的遗留——那里确实需要编）。现象是「两边都对得上但验不过」；
   给两侧各打一行 `sha256(nonce)` / `sha256(sig)` 才看出 nonce 逐字节一致
   （`766400f8`）而签名不一致（App `73a4fe42` vs sidecar `06c65580`）。
2. **JVM 单测测不到客户端**。`ShellSidecarAuthTest` 直接发原始 base64 签名，
   与 sidecar 的期望一致，所以 5 个用例全绿也拦不住客户端的双重编码——
   那一侧需要 `Context` 才能跑。教训：协议的每一侧都要有能跑的测试，
   否则「服务端测试全绿」会变成对客户端的虚假保证。