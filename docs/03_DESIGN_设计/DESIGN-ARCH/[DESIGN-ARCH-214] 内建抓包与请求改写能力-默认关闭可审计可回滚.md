# [DESIGN-ARCH-214] 内建抓包与请求改写能力 —— 默认关闭、可审计、可回滚

> 状态：设计稿（待评审）。**本文是提案，不是实施记录；本轮未改任何产品代码，未运行 T1–T16 测试实体。**
> 范围：设备主人在自己设备上排障。不抓、不改他人流量；不安装系统证书；不绕过付费、风控或权限校验。
> 上游依赖：**零**。不引入任何上游代码/二进制/资源/证书，不依赖任何外部 App 才能工作。
> 调研指针：`[DESIGN-ARCH-193]`（手机端职责划界）、`[DESIGN-ARCH-213]`（能力注册表唯一真相、T1–T7 判定体例）、`[DESIGN-ARCH-194]`（原子能力归组）、`[DESIGN-SOURCING-001]` §3 B-P1/B-P2/B-S4.1。
> 模板合规：B-P1 判定为「本仓此前不存在的能力域」→ 必须走 B-P2 提案；按 B-P2 七字段逐项据实填（第 6 项含 a/b 两子字段），非借鉴处填「不适用 + 依据」，不留空。
> 基线锚点：分支 `feat/thinking-fold-20261103`，HEAD `4424c00d`，`git status --porcelain` 487 行（工作区有大量并行会话改动）。**本文所有计数只对锚点树负责，判据不引用文档字面值**（承 `[DESIGN-ARCH-213]` §0）。

---

## 0. 一句话结论

这份规格能落地，但**落点只在手机端 APK**（`delivery/mobile/khy-os-client-app/`），并且有三处与任务书假设不符的实测事实必须先认：

| # | 任务书假设 | 实测事实 | 后果 |
|---|---|---|---|
| F1 | AmooMITM 是当前抓包能力的提供者，卸载后要「不受影响」 | 仓内**没有** `com.khyos.amoomitm` 源码（四路径均不存在，源码命中仅 `AmooApexLink.kt` 1 处）；它的角色是 apex **视图桥**（`AmooApexLink.kt:15-16,52,64`），不是流量抓取 | T10 不是「搬移抓包功能」，而是「新增能力对该包零引用 + 卸载后 A 路线全流程可用」 |
| F2 | 「可解密范围仅限自身调试构建（debug-overrides）与 WebView」 | `targetSdk = 36`（`android/app/build.gradle:60`）；`AndroidManifest.xml:34-38` 无 `networkSecurityConfig`；`res/xml/` 只有 `accessibility_service_config.xml` 与 `file_paths.xml`，**无** `network_security_config.xml`、**无** `debug-overrides` | 现状连自身 debug 构建都不信任用户 CA。B 路线要先在 `debug/` sourceSet 补配置，且 release 包永远返回「无法解密」——「不可解密」是**常态一等结果**，不是异常兜底 |
| F3 | 网络出口埋点即可自记录 | `builtin_tools.dart:171-190` 的 `http_request` 是空壳，返回「网络请求功能将在后续版本完善」；真实出口在 `lib/core/gateway/{khyos_api,pairing,provider_adapter,zen_gate}.dart` | 埋点挂 `http_request` 会「测试全绿、零覆盖」。必须挂真实出口 |

另有一条**环境硬约束**：本轮 `adb devices -l` 无设备、`adb get-state` 报 `no devices/emulators found`。任务书 §6 要求的 adb 取证与四段输出，**本轮一项都不能给 pass/fail**——按任务书 §5「不许伪造结果」与 §7「用本地模型推断没抓到的内容当成事实」，本文只给判定方案与真实的环境门控取证，所有 T 标「未测」。

---

## 1. 现状实证（file:line 可复核）

| 事实 | 落点 | 实测方式与结果 |
|---|---|---|
| 手机端是完整 Android 工程，`compileSdk 36 / targetSdk 36` | `delivery/mobile/khy-os-client-app/android/app/build.gradle:35,60` | 读文件；`minSdk = flutter.minSdkVersion` |
| 无 VpnService、无网络 CA 配置 | `android/app/src/main/AndroidManifest.xml:34-38`；`res/xml/` | `BIND_VPN_SERVICE` / `networkSecurityConfig` / `usesCleartextTraffic` / `debug-overrides` 四项全 `false` |
| 能力域全新 | `mobile/lib`(189 文件)、`mobile/test`(143 文件)、`backend/src/cli`(669 文件) | 关键词 `net_capture\|net_rule\|AmooMITM\|VpnService\|debug-overrides\|network_security_config\|self+tls\|info.capture\|rule_id\|replace_body\|override_status\|<redacted>`：手机端两处 **0 命中**；后端仅 `TTL_MS` 通用常量 17 命中，无一与抓包相关 |
| `info` 工具真落点是桥侧三表 | `bridge/Tools.java:216`(NAMES)、`:256`(CATALOG)、`:384`(ROUTING) | 三表由 `ToolCatalogTest.java` 双向钉死（`[DESIGN-ARCH-213]` §3.1）。Flutter 侧只有 `device_info`（`builtin_tools.dart:158`），**不是** `info` |
| Flutter 工具面 33 个 ToolDef | `lib/core/tools/builtin_tools.dart`；`tool_engine.dart:94-150` | `name: '...'` 正则计数 33；权限档 `enum PermissionLevel { auto, ask, deny }` 在 `tool_engine.dart:6` |
| 跨面能力真源是生成物 | `docs/10_规范/registry/ATOMIC-CAPABILITIES.json`；人工维护点 `scripts/lib/atomicCapabilityRegistry.js` 的 `ATOMIC_GROUPS` | 本轮跑 `node scripts/ci/check-atomic-capabilities.js` → **exit 1**、`atomic-registry-stale`、暴露面 6 / 暴露名 358 / 原子能力 135（比 213 号记录的 132 又漂了） |
| 提示词片段有既有落点且有守卫 | `lib/ui/screens/chat_screen_new.dart:3040` 的 `## 可用工具` 区块；`agent_screen_new.dart:551` 同型 | `test/system_prompt_tools_test.dart:81-117` 已断言「提示词里出现的工具名必须在注册表」 |
| 审计有既有 canonical | `lib/core/services/audit_log.dart:28-115`（`AuditSource` 四值、`AuditEntry` 七字段）、`:119-150`（单例、`maxEntries=500`、`useDirectoryForTest`） | 落盘走 `path_provider` 应用支持目录，不写 cwd |
| X.509 / 私钥能力已存在 | `android/app/src/main/kotlin/com/khyos/khy_os_client/shell/AdbTlsCertificate.kt`（299 行） | 手搓 DER / `RSAPrivateCrtKey` / `X509Certificate`，用途是 adb 无线调试 **mTLS 客户端证书**，不是 MITM CA |
| 外部依赖只有一处引用 | `AmooApexLink.kt:52,64,205` | `com.khyos.amoomitm` / `content://com.khyos.amoomitm.tick`；仓内无该 App 源码 |
| 既有凭据债（非本能力引入） | `android/key.properties:353-356`（明文 `storePassword`/`keyPassword`，gitignored）、`android/khyos-release.keystore` 2758B | 是 **APK 签名密钥**，不是 CA 私钥。T2 判据须显式排除，不能偷偷忽略 |
| PC 侧已有一次性 MITM 脚本 | `scripts/capture-adb-pairing-mitm.js:1-36` | adb 配对协议取证用，命令行传 `cert.pem`/`key.pem`，注释明写「产物属于仓库外」。**非产品能力、非手机端** |
| 桥根在 `/sdcard` | `bridge/BridgeService.java:43`（213 号实测） | 与 §4.1「CA 私钥只在 App 私有目录」相冲突的既有习惯，不得沿用 |
| CI 选择范围 | 12 个 workflow；`runtime/node/backend/package.json` | 零 `flutter test` 命中 → 手机端 `test/` 红探针**不在 CI 内**；后端 `test:node = node --test tests/**/*.test.js`、`test:node:src`、jest；`test:scripts` 扫 `scripts/tests/**/*.test.js` |
| 本轮工具链 | 探针 | `adb.exe` 在 SDK，但**无设备**；`flutter.bat` 在 `D:/Portable/2-tools/flutter/flutter/bin/`（存在、不在 PATH）；`gradlew.bat` 存在；`JAVA_HOME` 有效 |

**三层验证结论**（承提案流程 §1）：`info` 动作存在（Tools.java:216）、有调用方（CATALOG/ROUTING）、有消费方（ToolCatalogTest）；`http_request` 存在且有注册，但**实现是空壳**——A 路线的埋点必须绕开它。

---

## 2. 借鉴提案（B-P2 七字段）

**B-P1 判定链**：`[DESIGN-SOURCING-001]:161`「只要改动引入了『本仓此前不存在的能力域』，就必须走 B-P2 提案」。§1 实测关键词零命中 ⇒ 抓包/改写属新能力域 ⇒ **豁免不适用**（`:168-169` 只给「已登记能力域的行为修正」）。`B-P2.1`（`:190-191`）要求「先提案、后编码」，故本轮只落本文。

### 【借鉴提案 P-01】内建抓包与请求改写能力（零上游实现引入）

1. **借鉴对象**：**不适用**。本提案不引入任何上游项目。依据：任务书 §7 把「依赖外部应用才能工作」列为禁止项；`AmooMITM`（仓内包名 `com.khyos.amoomitm`）是**被替换的运行时依赖**，且仓内无其源码、其职责是 apex 视图桥而非抓包（§0 F1）。把它写成「借鉴来源」即编造借鉴关系，明禁。
2. **借鉴内容**：**不适用（零借鉴）**。一句话：本提案依据的是 Android 平台公开行为（`targetSdk ≥ 24` 默认不信任用户 CA、`VpnService` API 语义）与本仓既有契约，不取任何项目的结论、结构、代码或测试。
3. **解决的问题**：本仓缺一个自有的、默认关闭的请求观测与改写能力域（§1 关键词零命中）。今天的排障只能靠 PC 侧一次性脚本 `scripts/capture-adb-pairing-mitm.js`（手工传 cert/key、产物在仓库外）与外部 App `com.khyos.amoomitm`（仓内无源码、卸载即失效）。二者都不是随包可用、可审计、可回滚的能力。
4. **许可证与代码性质**：**不适用**（零上游文件进入仓库）。按 `B-S4.1`（`:93`）从严：即使只参考外部 App 的行为，也只能落在 `idea` 档。本文明确声明：**不引入任何上游代码、二进制、资源或证书文件**。
5. **借鉴方式**：`idea`（B-S4.1 从严档）。判定依据：无可核实的许可证、无上游源码入仓、无 `adapter`/`vendored`/`fork` 面；`reference` 亦不成立（无可核实的上游文件）。
6. **落点与现有实现对比**：
   - **a. 落点**（均为本仓既有文件的扩展或同层新建，清单见 §3.1）：`bridge/Tools.java` 三表 + dispatch、新建 `bridge/NetCapture*.java` 族、`lib/core/tools/` 下新增 ToolDef、`lib/core/services/audit_log.dart` 扩展、`debug/` sourceSet 新增 `res/xml/network_security_config.xml`、`ATOMIC_GROUPS` 归组、`chat_screen_new.dart:3040` 提示词区块。
   - **b. 现有同类实现**：已搜 `net_capture|net_rule|AmooMITM|VpnService|debug-overrides|network_security_config|info.capture|capture|proxy|mitm|vpn|certificate|keystore|audit|redact|ttl_ms|rule_id` 等词，覆盖 `mobile/lib`、`mobile/android/app/src`、`mobile/scripts`、`mobile/test`、`backend/src/cli`、`docs/10_规范/registry`。结论是**扩展既有 canonical，不新建并行真源**：`info.capture` 扩展 `Tools.java:216` 的 `info`（不新建第二个 info）；审计扩展 `audit_log.dart`（不新建第二份日志）；证书生成复用 `AdbTlsCertificate.kt` 的 X.509/DER 能力（不引入新库）；工具清单走 `ATOMIC_GROUPS` 归组并重跑生成器（不手改 `ATOMIC-CAPABILITIES.json`）；提示词片段挂既有 `## 可用工具` 区块（不新建随包 md）。唯一新增的并行面是 `debug/` 的 CA 信任配置，那是 Android 平台要求的 sourceSet，不是真源重复。
7. **验收方式**：先跑 `adb devices -l` 确认有 `state=device` 的真机（当前为 0，见 §0），再跑 `node scripts/ci/check-atomic-capabilities.js` 须 `exit 0`，最后跑 `flutter test test/net_capture/` 与 §7 的设备门控用例。**怎么算做成**：T1–T16 每条按「命令原文 / 原始输出 / 判据数值 / pass-fail-未测」四段留痕，设备门控用例的原始输出必须是 adb 完整回显，不接受转述；任一判据数值不达标即该条 fail。

---

## 3. 目标形态（组件级契约）

### 3.1 落点清单

| 层 | 文件 | 动作 |
|---|---|---|
| 状态机（唯一真源） | 新建 `bridge/NetCaptureState.java` | 进程内存态；三态 `off\|self\|self+tls`；不落盘、不跨进程恢复 |
| 自记录 | 扩展 `lib/core/gateway/` 真实出口 + `bridge/` 侧记录器 | 记录 method/host/path/status/耗时/字节/响应结构摘要；无 CA |
| TLS 解密 | 新建 `bridge/NetCaptureVpnService.java`；`debug/res/xml/network_security_config.xml`（新增） | 仅 debug 构建带 `debug-overrides` + `trust-anchors src="user"`；release 不带 |
| CA 生命周期 | 新建 `bridge/CaptureCa.java`，复用 `AdbTlsCertificate.kt` 的 DER 能力 | 私钥只写 App 私有目录；导出仅公钥；提供删除与轮换 |
| 规则引擎 | 新建 `bridge/NetRuleTable.java` + `NetRule.java` | 纯内存 `Map<rule_id, Rule>`；ttl 到期即失效；无持久化 |
| 脱敏 | 新建 `bridge/CaptureRedactor.java` | 字段名保留 + 值 `<redacted>` + 长度；认证类字段改写额外告警 |
| 审计 | 扩展 `lib/core/services/audit_log.dart` | 新增四类 operation；`detail` 放结构化 diff 摘要（只含哈希与长度） |
| 工具面 | `bridge/Tools.java` 三表 + `builtin_tools.dart` + `ATOMIC_GROUPS` | 10 个工具名同步登记，生成器重跑 |
| 提示词 | `chat_screen_new.dart:3040` 的 `## 可用工具` 区块 | 追加 §5 片段；由 `system_prompt_tools_test.dart` 自动校验名实一致 |

### 3.2 状态机与「不残留」的架构裁决

`NetCaptureState` 是 `info.capture` 与 `net_capture_status` 的**唯一真源**，两者都只读它，不各自计算。三态迁移：

```
off --[前台确认"将解密并可能改写本机流量"]--> self
self --[再次确认 + 二次确认(高风险动作)]--> self+tls
任意态 --[ttl 到期 / stop / 进程终止]--> off
```

**关键裁决**：§4.5「退出、崩溃、关机后不得残留」靠**「状态与规则只存在于进程内存、从不落盘」**保证，不靠退出清理钩子——钩子在崩溃与关机时根本不会执行。审计日志是例外（它必须留痕、必须落盘），两者不能混为一谈：规则不持久化、审计持久化。

VPN 残留另有三道：`onRevoke()` 收回、`ParcelFileDescriptor.close()`、前台服务 `START_NOT_STICKY` 且**不做自动重连**。`VpnService.Builder.addAllowedApplication(自身包名)` 把 VPN 作用面在**系统层**收窄，而不是在规则层判断「是不是自己的流量」——这是 §4.4「block 仅允许作用于自身流量」与 §0「不抓他人流量」的硬保证。

### 3.3 规则模型（照任务书 §3 定形，不自由发挥）

```
{"rule_id":"r-...","enabled":true,"ttl_ms":900000,
 "match":{"host":"...","path_regex":"...","method":"...","direction":"request|response"},
 "action":{"type":"set_header|remove_header|replace_body|override_status|delay_ms|block",
           "name":"...","value":"..."}}
```

`ttl_ms` 必填，缺省 900000（15 分钟）。命中记录进 `net_capture_list`：带 `rule_id`、命中次数、改写前后哈希、**不存原文**。`replace_body` / `override_status` 需二次确认；认证类字段改写额外写一条告警审计。

### 3.4 「无法解密」是一等结果，不是空成功

由于 §0 F2，release 构建与所有不信任用户 CA 的目标应用都会走这条路径。契约定为：

```
{ "ok": false, "code": "capture_decrypt_unavailable",
  "reason": "targetSdk>=24 且未配置 debug-overrides，该应用不信任用户证书，无法解密" }
```

改写失败同理返回 `capture_rewrite_unavailable` + 原因。**禁止**返回 `ok:true` 配空数组、禁止用本地模型补全没抓到的内容。T8/T16 就是钉这一条。

### 3.5 脱敏与审计的字段契约

敏感字段名（`Authorization` / `Cookie` / `Set-Cookie` / `token` / 密码类）一律输出 `<redacted>` 并保留字段名与长度。审计 diff 摘要结构：

```
{ "op":"rewrite", "rule_id":"r-...", "hits":N,
  "field":"<字段名>", "len_before":A, "len_after":B,
  "sha256_before":"...", "sha256_after":"..." }
```

`detail` 里**不得出现正文原文**。这与 `audit_log.dart` 现有「detail 存命令原文」的习惯冲突，必须在实现时显式区分：本能力的 detail 只放上述结构。

### 3.6 提示词片段（随包落盘，挂既有区块）

追加到 `chat_screen_new.dart:3040` 的 `## 可用工具` 区块，含「何时用 / 何时不用 / 怎么用 / 明确不承诺」四段，逐字覆盖任务书 §5：何时用（请求失败定位、验证服务端对某字段的响应、确认改写后行为是否改变）；何时不用（登录凭据、支付、第三方账号数据；不抓不改其它应用流量）；怎么用（start → 设规则 → 观测 → stop/clear；单次 ≤ 15 分钟；报告只给脱敏结构与状态码）；明确不承诺（抓不到或改不动就说「该应用不信任用户证书，无法解密/改写」，不许伪造结果；结论须给 rule_id、命中次数、前后哈希）。因该区块已被 `system_prompt_tools_test.dart` 扫描，工具名与片段会天然被守卫覆盖，不需要新增守卫。

---

## 4. 实施分期（每期独立可回滚）

| 期 | 内容 | 回滚方式 | 前置 |
|---|---|---|---|
| P0 | 归组 `ATOMIC_GROUPS`、重跑生成器，把 `check-atomic-capabilities.js` 的 `exit 1` 基线修绿；建立 `test/net_capture/` 红测试骨架 | 撤掉归组提交 | 当前守卫 stale，不修则 P1 起每个 PR 都红 |
| P1 | `NetCaptureState` + 自记录（A 路线）+ 脱敏 + `info.capture` 字段 + 审计四类 | 状态机整体撤销，其它工具不受影响 | P0 绿 |
| P2 | 10 个工具进三表 / Dart ToolDef / `ATOMIC_GROUPS`，提示词片段与守卫同步 | 撤掉登记与片段，`info.capture` 回 `off` | P1 状态机稳定 |
| P3 | 规则引擎 + ttl + 命中记录 + 二次确认 | 规则表整体撤销，A 路线仍可用 | P2 |
| P4 | `VpnService` + `debug-overrides` + CA 生成/删除/轮换 + B 路线解密 | 整个 sourceSet 与 service 声明撤销；release 包不含任何新代码 | P3 且真机在线 |
| P5 | 真机 adb 取证，按 §7 跑 T1–T16 四段输出 | 逐期独立回滚 | P4 且设备在线 |

**P0 是硬前置**：本轮守卫已 `exit 1`（stale），不先归组，P2 新增 10 个工具名只会让红更深，且无法区分「我引入的红」与「既有红」（并行会话归因纪律）。

---

## 5. 诚实边界（刻意不纳入，逐条给原因）

1. **不安装系统证书、不 root、不要求 Shizuku**。 tasked 范围内做不到，也不该做；`targetSdk ≥ 24` 的证书信任模型是平台事实，绕不过去。
2. **不解密他人应用流量**。`addAllowedApplication` 把作用面钉在自身包名；他人应用一律 `capture_decrypt_unavailable`。
3. **release 包不具备 TLS 解密**。B 路线只在 debug 构建 + WebView 生效；release 上 `info.capture` 最高只能到 `self`。这不是降级，是如实标注。
4. **规则与状态不持久化**。因此「崩溃后不残留」由架构保证；代价是重启后必须重新开启与设规则，这是**刻意取舍**，不是待修缺陷。
5. **抓包结果不进共享同步流**。`lib/core/services/conversation_sync.dart` / `amoo_shared_store.dart` / `training_export.dart` 均不接线；`net_capture_export` 只能人工触发且产出到用户指定位置。
6. **`android/key.properties` 的明文签名口令与 `khyos-release.keystore` 是既有债**，属 APK 签名凭据、非 CA 私钥。T2 判据显式限定「本能力新增的 CA 私钥材料」，并把这两处单独列为已知既有项；不借本任务顺手改它们，也不假装扫描没命中。
7. **本轮不给任何 pass/fail**。`adb` 无设备、flutter 不在 PATH，T1/T4/T5/T8/T10/T11/T12/T16 的真机取证实体未运行。按 213 号 §7 体例，§7 全部是**判定方案**而非已跑结果。
8. **不新建第二个 `info`、第二份审计日志、第二份工具清单**。三处都扩展既有 canonical。

---

## 6. 反模式（这条路别走）

| 别做 | 为什么 |
|---|---|
| 埋点挂 `builtin_tools.dart:171-190` 的 `http_request` | 它是返回占位文案的空壳。挂上去测试全绿、实际零覆盖（§0 F3）。真实出口在 `lib/core/gateway/` |
| 靠「退出/崩溃清理钩子」保证不残留 | 崩溃与关机时钩子不执行。正解是状态与规则从不落盘（§3.2） |
| 把 `info.capture` 做成从工具调用记录反推的派生值 | 会与 `net_capture_status` 漂移。两者必须同读 `NetCaptureState` 一个真源 |
| 手改 `ATOMIC-CAPABILITIES.json` | 它是生成物；改了下一次生成器就覆盖，且守卫会判 stale。人工维护点只有 `ATOMIC_GROUPS` |
| 为「让 T8 好看」在 release 加 `debug-overrides` 或装系统证书 | 直接违反 §0 与 §7；且会把「无法解密」这个诚实结果抹掉 |
| CA 私钥沿用 `/sdcard/bridge-amoobridge` 的既有习惯（`BridgeService.java:43`） | 违反 §4.1。私钥只能写 App 私有目录，导出仅公钥 |
| 把 `<redacted>` 做成「导出时再脱敏」 | 采集与存储环节就已经不能留原文；导出前后二次扫描必须一致（T3） |
| 用本地模型推断没抓到的内容并写成事实 | 任务书 §7 明禁，也是 §3.4 一等结果码存在的理由 |
| 先落红探针到 `runtime/node/backend/tests/**` 或 `scripts/tests/**` | 它们被 `test:node` / `test:scripts` 全量扫，落地当天 CI 就红（见 §8 待核实项） |
| 为「默认关闭」新开一个 `KHY_*` env 门 | 门预算棘轮只降不升；默认态由状态机保证，回滚能力用可选参数而非新 env |

---

## 7. 验收方式：T1–T16 判定方案（先写测试、红先绿后、adb 取证、四段输出）

每条按本仓纪律输出四段：**命令原文 / 原始输出 / 判据数值 / pass-fail-未测**。开发顺序：先写测试看红（新测试对现状失败），实现后看绿。设备门控用例的原始输出一律粘贴 adb 命令与完整回显（含返回码），不接受转述；四段输出落 `works/data/khy/feedback/<task-id>/`（规则 5 存证位）。

| # | 判定 | 测试先行（红）落点 | 判据数值 | 门控 |
|---|---|---|---|---|
| T1 | 默认 off；开启有确认；15 分钟自动停 | `test/net_capture/state_default_test.dart` | 冷启动 `state==off`；无 `confirmation_id` 不得转入 `self/self+tls`；`stop_at - start_at <= 900000 + ε` 且 `auto_stop_reason=='timeout'`；三组时间戳可复核 | 单测本机；超时真机 |
| T2 | 私钥不在 `/sdcard`；静态扫描无明文私钥 | `test/net_capture/ca_storage_test.dart` + 静态扫描脚本 | `/sdcard` 命中 **0**；本能力新增文件集内 `BEGIN (RSA \|EC \|)PRIVATE KEY` 命中 **0**；导出件只含 `BEGIN CERTIFICATE`。既有 `key.properties`/`keystore` 单列为已知项、不混入判据 | 单测本机；`run-as ls` 设备 |
| T3 | `Authorization`/`Cookie` 显示 `<redacted>`；导出前后二次扫描一致 | `test/net_capture/redaction_test.dart` | 六个敏感字段名的值全为 `<redacted>` 且保留 `len=N`；导出前后两次扫描命中数相等、凭据原文命中 **0** | 本机 |
| T4 | stop 后无残留 | 设备脚本 + 状态单测 | `dumpsys connectivity` 中 VPN 条目 **0**；`ss -ltn` 中代理监听端口 **0**；VpnService 进程 **0** | 设备 |
| T5 | 崩溃后重启不自动恢复、不残留规则 | 崩溃注入单测 + `am force-stop` 设备脚本 | 冷启动 `state==off`、`net_rule_list` 条数 **0**、VPN 条目 **0** | 单测本机；设备 |
| T6 | 10 个工具在注册表；`info.capture` 与实际一致 | `ToolCatalogTest.java` 扩展 + `test/net_capture/catalog_consistency_test.dart` | 三表 / Dart ToolDef / `ATOMIC_GROUPS` 工具名集合差 **0**；`check-atomic-capabilities.js` **exit 0**；`info.capture` 与 `net_capture_status.state` 与状态机逐字节相等（三处） | 本机（守卫） |
| T7 | 抓自身请求字段正确、无凭据 | `test/net_capture/self_record_test.dart`（自身调试端点回环） | status 与服务端一致；耗时 `>0` 且 `<` 总时长；字节数 `>0`；凭据原文命中 **0** | 本机 |
| T8 | 不信任用户 CA 的应用返回「无法解密」 | `test/net_capture/decrypt_unavailable_test.dart` | `ok==false`、`code=='capture_decrypt_unavailable'`、`reason` 非空且含证书不信任；伪造抓包记录 **0** 条 | 本机契约 + 设备 |
| T9 | 开启/关闭/导出/改写四类审计可查 | `test/net_capture/audit_four_kinds_test.dart` | 四类 operation 各 `>=1` 条；改写记录含 `rule_id`/`hits`/前后哈希/`len_before`/`len_after`；正文原文命中 **0** | 本机 |
| T10 | 卸载 AmooMITM 后能力仍可用 | 静态零引用测试 + 设备卸载脚本 | 新增代码对 `com.khyos.amoomitm` 引用 **0**；`pm uninstall` 后 A 路线 start→list→export 全流程 `exit 0` | 本机静态 + 设备 |
| T11 | `set_header` 生效 | 自身调试端点回显测试 | 服务端回显值 `== rule.value`；命中 `hits>=1` | 设备 |
| T12 | `replace_body` 生效且审计只有哈希 | 同上 + 审计断言 | 响应体 `== action.value`；审计正文原文命中 **0**；含前后 sha256 与长度变化 | 设备 |
| T13 | ttl 到期自动失效；重启规则为空 | `test/net_capture/rule_ttl_test.dart`（短 ttl 注入，如 2000ms） | 到期后命中次数不再增长；冷启动 `net_rule_list` 条数 **0** | 本机 |
| T14 | `block` 命中返回明确错误码、不静默挂起 | `test/net_capture/block_test.dart`（超时注入） | 返回耗时 `<` 超时阈值；`code=='capture_blocked'` 且带 `rule_id`；pending 请求 **0** | 本机 |
| T15 | 每条改写可按 rule_id 追溯 | 汇总查询测试 | `rule_id` 覆盖率 **100%**；每条可查 hits 与前后哈希 | 本机 |
| T16 | 改写失败返回明确原因、不伪造成功 | `test/net_capture/rewrite_unavailable_test.dart` | `ok==false`、`code=='capture_rewrite_unavailable'`、`reason` 含证书不信任；命中记录 **0** | 本机契约 + 设备 |

**本轮实测的四段样例（环境门控取证，不是 T 判定）**：

```
命令：C:/Users/25789/AppData/Local/Android/Sdk/platform-tools/adb.exe devices -l
原始输出：
List of devices attached


判据数值：设备条目数 = 0（设备门控要求 >=1 且 state=device）
结论：未测 —— 不推断、不补写 pass/fail
```

```
命令："D:/.../node.exe" scripts/ci/check-atomic-capabilities.js
原始输出：
check-atomic-capabilities: 原子能力聚合守卫
暴露面 6 个 · 暴露名 358 个 · 原子能力 135 个
[ERROR] atomic-registry-stale ... 请运行：node scripts/ci/gen-atomic-capabilities.js 重新生成。
判据数值：exit=1；error 数 >=1；原子能力 135（随工作区漂移，不作判据）
结论：fail（P0 施工前置基线红，非本提案引入）
```

---

## 8. 待核实项（前两条阻断落地，优先）

1. **工具面挂在哪一侧**：任务书说「进能力注册表，与既有工具同级」，但本仓有三套（`Tools.java` 三表 / Dart `ToolDef` / `ATOMIC-CAPABILITIES.json`）。本文按 213 号 §3.1 裁决为「三表登记 + Dart 同步 + ATOMIC_GROUPS 归组」。**需人确认**是否 10 个工具全部要在这三面同时出现，还是只有桥侧需要。
2. **红探针与 CI**：实测 12 个 workflow 零 `flutter test`，故手机端 `test/net_capture/` 落地不会让 CI 变红，但也**没有 CI 覆盖**——验收只能靠本地 `flutter test` 与人工 adb 取证。若要求 CI 覆盖，须先接线 flutter job，且按提案流程 §6.3「先接线再落红探针」，顺序不能反。后端红探针不得落 `runtime/node/backend/tests/**` 或 `scripts/tests/**`（会被全量扫）。**需人确认**是否接受「CI 不覆盖手机端」这个限制。
3. **设备门控**：本轮 `adb` 无设备（首次探针曾见 `192.168.1.117:5555 offline`，复核时已完全消失）。T4/T5/T10/T11/T12 的真机部分须待设备在线后首跑。
4. **`debug-overrides` 的作用面**：`debug/` sourceSet 目前只有 `AndroidManifest.xml` 与一个自测 Activity（实测）；新增 `res/xml/network_security_config.xml` 后需真机确认 WebView 是否同样继承该信任配置，若否，T8 的 WebView 分支要单列。
5. **审计 `detail` 结构扩展**：`AuditEntry` 现为自由文本 `detail`；改为结构化摘要会影响既有 `fromJson`/`toJson` 与日志查看页渲染。需确认是扩字段还是塞 JSON 字符串（本文倾向扩字段，避免字符串里再解析）。
6. **提示词第二处区块**：`agent_screen_new.dart:551` 也有 `## 可用工具` 区块，但 `system_prompt_tools_test.dart:81` 只读 `chat_screen_new.dart`。需确认片段是否两处都加、守卫是否扩展到第二处。

---

## 9. 本会话证据表

| 命令 / 动作 | 结果 |
|---|---|
| 临时 node 探针（`.khy/tmp/nc-*.js`，只读，结果落 `.khy/tmp/*.md` 后 Read） | 8 个探针；首轮全仓逐文件读内容因超时被 SIGTERM，改为「文件名级 Glob / 内容级限定目录」后收敛 |
| `adb devices -l`（两次，间隔数分钟） | 第一次 `192.168.1.117:5555 offline`；复核 `List of devices attached` 后为空 |
| `adb get-state` | 第一次 `error: device offline`；复核 `error: no devices/emulators found`，exit 1 |
| SDK 目录枚举 | `platform-tools/adb.exe` 存在；`emulator/emulator.exe` 不存在；`build-tools 35/36`、`platforms android-34/35/36` |
| `flutter.bat` / `dart` 在 PATH | 均 NOT FOUND；全路径 `D:/Portable/2-tools/flutter/flutter/bin/flutter.bat` 存在（213 号记录 Flutter 3.47.2 / Dart 3.13.2，本轮未复跑版本） |
| 枚举 `DESIGN-ARCH/*.md` | count 206，max 213，next 214，`214 already taken = false`（复核两次一致） |
| `git rev-parse --abbrev-ref HEAD` / `log -3` / `status --porcelain` | `feat/thinking-fold-20261103`；`4424c00d` 等三条；487 行未提交改动 |
| `node scripts/ci/check-atomic-capabilities.js` | exit 1，`atomic-registry-stale`，暴露面 6 / 暴露名 358 / 原子能力 135 |
| 关键词全扫（手机端 lib 189 / android src 141 / scripts 5 / test 143 / backend cli 669 文件） | 抓包与改写能力域关键词：手机端 0 命中；后端仅通用 `TTL_MS` 常量 17 命中 |
| `Read` `[DESIGN-ARCH-193]` / `[DESIGN-ARCH-213]` / `[DESIGN-SOURCING-001]` | 复核「同一原子能力只允许一个持有者」「能力注册表唯一真相」「B-P1 新能力域必提案」「B-P2.1 先提案后编码」「T1–T7 是设计方案而非已跑结果」 |

**未运行项如实声明**：本轮未运行任何 `flutter test` / `gradlew` 单测实体、未安装 APK、未做 adb 真机取证、未运行 T1–T16 任一判定。本轮只做只读取证与文档落盘。

---

## 10. 变更日志

- 2026-11-13：初稿。基于 8 个只读探针的实测取证落盘；按 B-P2 七字段逐项据实填「不适用 + 依据」；把 §6 的 T1–T16 写成判定方案而非已跑结果；如实标注 adb 无设备、守卫基线红、CI 不覆盖手机端。
