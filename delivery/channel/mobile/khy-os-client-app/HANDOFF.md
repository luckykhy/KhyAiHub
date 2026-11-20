# khy-os 控制台改造 · 当前状态交接（2026-11-16 21:00）

> 本文是当前状态的单一总结口。`VERIFICATION.md` 已于 2026-11-14 因
> Set-Content 编码事故损坏（1507 个 U+FFFD），细节过程见
> `ACCEPTANCE-PROGRESS.md` 与 `DOC-CORRUPTION-INCIDENT.md`。
>
> **交付三段（目标第六条要求的格式）见文末「交付：阻碍点 / 实现方案 / 改动清单」。**

## 〇、一句话现状

控制台改造的代码与真机验证**主体已完成**。21/21 混合命令三类失败分类在**设备当前
实际运行的构建**（versionCode 43）上复跑通过，且**三个独立证据源一致**（驱动判定 +
`KHYCONSOLE` 日志 14 行 + 历史独立复核 21/21）。冷启动首屏非 Amoo、无障碍降级行为、
「去授权」可达权限中心、不提权、常用指令、共享存储、raw JSON 切换、可导出，均已真机
实证；`clearHistory` 补齐测试（41/41 全过）。

**只剩 ② 断网执行与 ③ Amoo 完整取证两项，分别只差「插 USB」和「开无障碍 + 启动
拦截循环」这两个用户物理动作。**

> 注意：设备上跑的已是**另一会话**在 16:23 安装的 versionCode 43 构建
> （哈希 `B0CE13E2…`），不是本文交付副本 `349D8BFC…`。「装机 = 交付副本」是
> **时效性结论**，只对 15:43–16:23 成立；交付副本本身通过过全部核验。

## 一、任务目标（回顾）

让 khy-os 本地直接接收并执行 JSON 命令、在 khy-os 内显示结果，
不再默认把 Amoo 拉到前端。原链路「用户 → Amoo → 桥执行 → 回 Amoo」
改为「用户 → khy-os 本地 Console → 桥执行 → 结果在 khy-os 内显示」。

## 二、代码侧：已完成

| 模块 | 文件 | 状态 |
|---|---|---|
| 执行内核 | `bridge/KhyConsole.java`（785 行） | 唯一通道，三类失败分类 |
| 工具契约 | `bridge/ToolSchema.java`（427 行） | 50 工具，描述复用 CATALOG |
| Amoo 解耦 | `bridge/AmooLoop.java` | 走同一通道 + 唯一净化出站 |
| 通道方法 | `MainActivity.kt` 1029-1208 行 | 8 个方法 + base64 预填 |
| Dart 服务 | `lib/core/services/console_service.dart` | 只翻译不重新判断 |
| 界面 | `lib/ui/screens/console_screen.dart` | 品牌块 + 三类渲染 + 翻历史 |
| 页签 | `lib/main.dart` | 控制台为第二页签 |
| 页签配平 | `lib/main.dart` 导航循环 | **修**：写死 `i < 5`，6 条页签只渲染 5 个 destination，「设置」页点不到 |

测试：JVM 40 个 / Dart 状态 14 个 / widget 12 个 / 页签配平护栏 2 个（含阳性对照），**全绿**。
`flutter analyze` 对改动文件 0 问题（`main.dart:292` 两条 warning 是别的会话未提交的电池提示代码，非本次引入）。

## 三、真机侧：五项有效证据（均在 2026-11-16 12:0x 前取得）

| # | 证据 | 说明 |
|---|---|---|
| 1 | **11 条 manual 记录全部 `ok`** | raw 已逐条核实匹配探针命令（10×ping + 1×ls），无人工或其他会话混入 |
| 2 | **Amoo 产出命令走本地通道** | Amoo 回复原文：「我们刚才在 khy-os 本地执行了一条命令：ui_click，参数 {"text":"x"}，结果 tool_unavailable」 |
| 3 | **72 条 origin=link 全部 `ok`** | PC 经 BridgeLink 下发，无失败 |
| 4 | **三类失败分类正确** | JVM 上用 20 条混合命令逐条断言 status 与文案互异 |
| 5 | **断网不依赖网络（结构侧）** | 控制台四文件 0 网络 import；执行由 `Tools.dispatch()` 进程内完成 |

## 四、今天作废的分析（重要，避免重复）

2026-11-16 12:0x 之后我曾得出「App 进程不存在」「点击事件不触发」等结论，
**全部作废**。真实原因是设备当时已离线，而脚本用 `2>$null` / `2>&1 | Out-Null`
吞掉了 adb 的失败，使「命令没执行」与「执行了但结果为空」无法区分。

教训已固化为 `OBSERVATION-RULES.md` 三条铁律，并已应用到
`khy-today.ps1`（离线时 exit 3，不再显示陈旧数据）。

## 五、还差什么

| 项 | 前置条件 |
|---|---|
| ① 21 条混合命令完整跑查 | 设备恢复（`khy_accept2.ps1` 就绪，含 ts 过滤器与 cycle 重试） |
| ② 断网执行 | 设备恢复 **且插 USB**（`khy_offline_accept.ps1` 就绪，三层兜底防射频全灭） |
| ③ Amoo/manual 完整取证 | 设备恢复 + **先在系统设置给本 App 开无障碍** + 人点「唤起 Amoo」按钮 |

## 六、一键复跑

```powershell
# 设备恢复后，一条命令走完 0-3 步（step 4 会停下等你人工参与）
powershell -ExecutionPolicy Bypass -File 'D:\Portable\4-output\Temp\khy_run_all.ps1'

# 编排器自检（不需要手机，六项断言）
powershell -ExecutionPolicy Bypass -File 'D:\Portable\4-output\Temp\khy-verify_driver.ps1'

# 只看设备状态
powershell -ExecutionPolicy Bypass -File 'D:\Portable\4-output\Temp\khy-devcheck.ps1'
```

## 七、已知问题（不在本次范围）

1. `VERIFICATION.md` 损坏待重建（内容绝大部分在对话历史里）；文件开头已加
   横幅指明替代文档，**不要从零重写**；
2. `origin` 现有三种取值：`manual` / `amoo` / `link`（后者是别的会话新增的
   PC 经桥下发通道）；
3. ① 的 21 条跑查成功率约 1/3（两个 App 侧偶发竞态：预填有时不到输入框、
   点击有时不触发），已用 cycle 重试缓解，根因需 App 内日志；
4. **`D:\Portable\4-output\Temp\` 是系统临时目录，会被清理**。今天
   `khy-verify_driver.ps1` 与 `khy-devcheck.ps1` 就被清掉并重建过一次。
   长期保留的脚本应考虑移到仓库外的固定位置，或接受「随时需要重建」；
5. ① 的**判定逻辑**（ts 过滤器 / cycle 重试 / PASS 判定）尚未在受控输入下
   验证过——`fake-adb-test.ps1` 就是为这个写的（假 adb + 脚本化历史）。
   **2026-11-16 14:0x 进展**：前两次中断的根因是测试脚本自身的 bug 之一已定位并
   修掉——`khy_accept2.ps1` 第 11 行硬编码 adb 路径、不认 `KHY_ADB`，导致假 adb
   从未被用上，驱动一直以真 adb 跑并在设备检查处 `FATAL: no device` 退出
   （铁律 4 的又一例：测试脚本的 bug 伪装成被测对象的缺陷）。现已改为
   `$adb = if ($env:KHY_ADB) { $env:KHY_ADB } else { <原路径> }`，完整重跑在后台
   进行中（假 adb 下每条命令走满三重试，全程约 20 分钟）；
6. **冻结表守卫曾退红**：`check-amoo-package-literals.cjs` 从 0 error 退到 16
   （7 处行号漂移 + 2 条真新增），来源是别的会话今天 13:04 改 `MainActivity.kt`
   与 11-14 的几处改动，非本次引入。已按「坐标 + 整行文本 + 理由」补登记，
   现为冻结 32 / 实测 32、0 error。**该表会随别人改这些文件再次退红**，见红先分
   漂移与新增，别一律当成自己的回归；
7. **仓库布局门禁 `check-repo-layout.js` 当前是红的**，三处均与本次改动无关：
   根目录 11 个 `*_diff.txt`、1 份未进索引的新设计文档、6 个怪异顶层目录
   （`%T%`、`-p`、`done`、`echo`、`mkdir`，像是某次脚本重定向失控的产物）。
   都是别的会话在飞的产物，未代劳清理。

## 八、资产位置（2026-11-16 逐个核对存在）

**A. 仓库内 `delivery/mobile/khy-os-client-app/`（随仓库走，不会被清）**

| 文件 | 用途 |
|---|---|
| `HANDOFF.md` | 本文件，当前状态单一总结口 |
| `ACCEPTANCE-PROGRESS.md` | 过程账：带日期的证据 + 哪些结论已作废 |
| `DOC-CORRUPTION-INCIDENT.md` | `VERIFICATION.md` 损坏事故记录 |
| `VERIFICATION.md` | **已损坏**（1507 个 U+FFFD），开头有指路横幅，勿重写 |

**B. 系统临时目录 `D:\Portable\4-output\Temp\`（会被清理，接受随时重建）**

| 脚本 | 用途 |
|---|---|
| `khy_run_all.ps1` | 入口：设备检查 → 装包 → ① → ②，step ③ 停下等人 |
| `khy_verify_driver.ps1` | 编排器自检（假 adb + 标记文件，六项断言，不需要手机） |
| `khy_devcheck.ps1` | 设备状态（exit 0=有设备 / 3=无设备） |
| `khy_install.ps1` | 装包（APK 旧则拒装、绝不卸载、只认 USB） |
| `khy_accept2.ps1` + `khy_cmds.json` | ① 21 条混合命令（ts 过滤器 + cycle 重试） |
| `khy_offline_accept.ps1` + `.sh` ×2 | ② 断网执行（三层兜底防射频全灭） |
| `khy_amoo_accept.ps1` | ③ Amoo/手动一致性取证 |
| `khy-race.ps1` | 设备恢复后分离 RACE-A / RACE-B / 坐标漂移 |
| `khy-today.ps1` | 今日 manual 记录（带三重自检，范本） |
| `OBSERVATION-RULES.md` | 观测脚本三条铁律（今天一小时误判换来的） |

> **本节曾被改错两次**：先把它误列在仓库内，修正时又漏了核对、把仓库节删错。
> 最终以 2026-11-16 实查为准：`OBSERVATION-RULES.md` 在 **Temp**，不在仓库内。
> 教训与 `OBSERVATION-RULES.md` 铁律 1 同源——**改文档前先跑一次存在性检查**。

---

## 九、用户所持「新版 UI」APK 的判定与新包（2026-11-16 14:0x）

用户通过微信发来一个 236 MB 的 APK（`.../2026-11/base (1).apk`），称是新版 UI、
要求控制台也进新版并带 khyos 品牌标记。逐层扫描后的结论：

| 查什么 | 结果 |
|---|---|
| 版本号（`resources.arsc`） | **1.1.17**，远早于本树的 1.1.53 |
| Dart 层 `ConsoleScreen` | 在（kernel_blob 28 处） |
| Dart 层 `ConsoleService` | **无** |
| 原生 `consoleExec` / `amooSummon` / `consoleHistory` | **全无**（dex 与 kernel 双侧） |
| 原生 `KhyConsole` / `ToolSchema` | **无** |
| 原生 `AmooLoop` | 在 |

即：**那个包是执行通道落地前的旧构建，控制台只是个没接执行通道的空壳**，
不是新版缺了控制台。本树里控制台早在新版六页签壳的第二页签，顶栏带品牌标。

**品牌形态（2026-11-16 14:1x 对齐）**：早先控制台 AppBar 用的是裸
`KhyBrandMark(size: 22)`，而新版其他界面（聊天页 AppBar 区 `:1291` 与抽屉头
`:2469`、连接页、设置页）用的都是 `KhyBrandTile`——墨黑圆角底 + 琥珀主标，
即 Web / 桌面端 / TUI 共用的同一枚主标与同一块墨黑底。控制台是新版六屏里
唯一不带墨黑底的一处，已改为 `KhyBrandTile(size: 28)`（与抽屉头同尺寸）。
位图本身核过：`assets/brand/khy-os-mark-{256,64}.png` 与母版
`delivery/brand/png/` 对应文件**逐字节相同**（同为 11-04 13:39 构建产物），
没有被手改、也不是过期资产。

本轮因此做成一包可直接安装的 release（含上述页签配平修复）：

```
D:\Portable\khy-os\delivery\mobile\khy-os-client-app\build\app\outputs\flutter-apk\
  khy-os-client-1.1.53-console-release.apk     62.5 MB
```

已核验（**2026-11-16 14:12 重建后**）：`apksigner verify` exit 0
（`CN=khy-os, OU=Mobile, O=KhyOS`，可直接覆盖安装，无需先卸载）；
dex 内 10 个控制台通道方法
（`consoleExec`/`consoleTools`/`consoleHistory`/`consoleClear`/`consoleExport`/
`consoleFavorites`/`consolePending`/`amooSummon`/`consoleResetToken`）加
`khy_console_cmd_b64` 全在；品牌资产在 `flutter_assets` 内。
SHA-256 `349D8BFC088FCD800D3EAC95B959CC5B76536FC49A5EE0A6E3163F5D5912B974`
（**15:16 构建，含 KHYCONSOLE 日志见证**；仓库内 `build/` 副本与仓库外
`D:\Portable\4-output\` 备份三处同哈希，签名 verify exit 0，已装机）。
此前 14:12 那版是 `97E67D1B4A781CD1B95F0A2BD587B73FB01ABA5C160ABB45EEB11AFFDD649C36`，
只有品牌块修复、**没有**日志见证，别混用。

> 注意 `build/` 是构建产物、会被 `flutter clean` 或别人的构建冲掉，
> 要留档就复制到仓库外。另：今天 13:41 另有会话构建过一次 `app-release.apk`
> （62.5 MB，同样带控制台通道，但不含本轮页签修复），别把两者搞混。

**版本号更正（2026-11-16 14:2x）**：这个包的 `versionName` 是 **1.1.53 / versionCode 42**，
不是 1.1.51——我在 13:40 读到 pubspec 是 1.1.51+40，另一会话在我 14:09 开始构建前把版本
推上去了，构建直接吃进了新值。先前按 1.1.51 命名的两个副本已删除并改名重建，
哈希未变（同一个文件）。教训同铁律 1：**别凭早先读到的值给产物命名**。

**真机冒烟已通过（2026-11-16 14:2x）**：设备经 mDNS TLS 恢复在线（同一手机注册了两遍，
`adb devices` 列出两条 `device`）。用 `khy_smoke.ps1` 走完整流程跑了一条
`{"tool":"ping"}`（force-stop → base64 预填冷启动 → 点控制台页签 → 收键盘 → 点执行），
共享历史新增一条 `origin":"manual"`、`status":"ok"`、`result` 带回 `pong` 与 `pid`。
**端到端链路在真机上成立**。

### 本轮修掉的三个脚本缺陷（都不是产品代码）

| 文件 | 缺陷 | 修法 |
|---|---|---|
| `khy_run_all.ps1` step 0 | WiFi 防护只认 `IP:PORT`（`-match ':$'`），漏判 mDNS/TLS 形态，于是把 WiFi 设备当 USB 放行，一路跑到断网项——**正是会把手机双射频搞掉的那条路**。`khy_install.ps1:35` 早就会匹配三种形态，只有编排器漏了 | 改成正向判据：USB 序列号是纯令牌，凡带点号/冒号/空白的都是网络传输。阳性对照已验证（现在对该设备明确拒绝并 exit 1） |
| `khy_accept2.ps1` 序列号选择 | 取 `$d[0]`，而 mDNS 重复注册名 `adb-XXXX (2)._adb-tls-connect._tcp` **带空格**，`adb -s` 对它报 `device not found`——设备就在眼前却全盘失败 | 先改成「跳过含空白的序列号」，**又错了**：哪个注册当前可用会随时间翻转，那一版只剩空格注册可用时反而报 `FATAL: no device`。最终改为按 `adb -s <s> get-state` 探针选取，不看名字形态 |
| `fake-adb-test.ps1` 固件 | 假 adb 的 pull 处理器无视目标参数、永远写 `console_history.jsonl`，而驱动 pull 到 `console_history_probe.jsonl`（`khy_accept2.ps1:184`）→ 驱动读到不存在的探针文件 → 21 条全报 NOT RECORDED → ts 过滤器**根本没被检验到**，却让第三条断言翻红（铁律 4 又一例） | 让假 adb 按 `$args` 里的目标路径复制。**重跑尚未做**——两者共用同一探针文件，不能与真机跑查并发 |

另有一个**纯陷阱文件**：`D:\Portable\4-output\Temp\khy_devcheck.ps1`（**下划线**）带 348 个
非 ASCII 字节且无 BOM，PowerShell 5.1 按 GBK 解码后中文注释与下一行的 `$dev = ...` 赋值
被并成同一行，`#` 把赋值整行注释掉 → 永远报 `NO DEVICE`。canonical 版是**连字符**的
`khy-devcheck.ps1`（纯 ASCII，HANDOFF §六一直写的是它）。**我今天敲错成下划线版，
白绕了四轮诊断**。它只被自己引用，建议直接删掉。

### 最重要：验收驱动的判定从来没有对过（2026-11-16 14:4x）

`khy_accept2.ps1` 有**两个** bug，任何一个都足以让全部 21 条判定失效。它们一直在，
所以本文档此前所有基于该脚本输出的结论——包括「成功率约 1/3」「两个 App 侧偶发竞态」
（`_loadAll()` async 导致预填有时没写入、点击有时不触发）——**归因是错的**，
那些现象是驱动自己造成的，不是 App 的。

| # | 位置 | 缺陷 | 实测 |
|---|---|---|---|
| 1 | ts 过滤器（原 L333） | `[int]::TryParse` 解析 epoch **毫秒**。`[int]` 是 Int32，上限 2147483647，而当前 epoch 毫秒约 1.79 万亿 → 必然解析失败，`$ts` 保持 0 → `0 -lt $runStartedAtMs` 恒真 → **每条记录都被当陈旧跳过** | `[int]::TryParse('1794811097848') -> False, value=0`；`[int64]::TryParse(...) -> True` |
| 2 | `Get-HistEntries` 读文件（原 L190） | `Get-Content` 不写 `-Encoding UTF8`，中文 Windows 上默认按 GBK(936) 解码 UTF-8 文件，误解码出的字符会破坏 JSON → 这些行计入 `$bad` 后被丢弃 | 一条 135 行的真实历史：默认读法 **91 好 / 44 坏**，UTF8 读法 **135 好 / 0 坏**。丢掉的 44 行正是带中文错误文案的记录（`invalid_args`/`tool_unavailable`/`exec_error`）——**即最该被验证的失败用例** |

两处都已修（`[int64]` + `-Encoding UTF8`），并用真机拉到的历史做过验证：135 条全部解析成功，
`{"tool":"ping"}` 与 `{"tool":"info"}` 均正确匹配到 `status=ok` 的新记录。
**在此之前，该脚本从未产生过一次正确判定。**

> 连带结论：`fake-adb-test.ps1` 那条 FAIL 不只固件 bug——即使固件修好，
> Int32 溢出也会让它永远报 NOT RECORDED 而拿不到期望的 WRONG STATUS。
> 我先前「只是固件问题」的诊断不完整，是继续挖才浮出这两个的。

---

# 交付：阻碍点 / 实现方案 / 改动清单

## 一、阻碍点

| # | 阻碍 | 性质 | 解除条件 |
|---|---|---|---|
| 1 | **② 断网执行未跑** | 用户侧物理条件 | 手机插 USB。设备当前是 TCP/mDNS 形态，断网项会自断 adb 链路（脚本注释记录过「已经发生过一次」） |
| 2 | **③ Amoo/manual 完整取证未跑** | 用户侧物理条件 | 系统设置里给本 App 开无障碍服务，再由人点「唤起 Amoo」并在 Amoo 聊天发 `{"tool":"battery"}` |
| 3 | `VERIFICATION.md` 永久损坏 | 历史事故 | 1507 个 U+FFFD 不可恢复；已加指路横幅，**不要从零重写**。重建需用户决策（应视为「恢复的副本」） |
| 4 | 仓库布局门禁 `check-repo-layout.js` 红 | 别会话产物 | 根目录 11 个 `*_diff.txt`、1 份未索引新文档、6 个怪异顶层目录（`%T%`、`-p`、`done`、`echo`、`mkdir`）。**非本次引入，未代劳清理** |

## 二、实现方案

**本地命令通道**：`KhyConsole.exec()` 是唯一入口，`prepare()` 做白名单 + schema 校验，
`finish()` 统一收口并落共享历史。三类失败在**产生处**就分开，不靠下游辨别。

**结果渲染**：Dart 侧 `console_service.dart` 只做翻译不重新判断；`console_screen.dart`
默认格式化视图、可切 raw JSON；历史写 `/sdcard/bridge-amoobridge/console_history.jsonl`
（追加写），常用指令写同目录 `console_favorites.json`——**Amoo 侧读同一份**。

**与 Amoo 解耦**：`AmooLoop.executeOne` 改走 `KhyConsole.exec(ORIGIN_AMOO, …)`；
`typeIntoAmoo()` 是唯一净化出站通道；Amoo 从「启动即拉起」改为「按需唤起」，
且先 arm 拦截循环再打开聊天页（反过来会漏掉 Amoo 已开始输出的命令）。

**执行见证**：`KhyConsole.exec` 以 `Log.i("KHYCONSOLE", origin/tool/status/id)` 落一行，
与历史文件构成两个独立证据源。刻意不放在 `finish()`——那会被 `validateOnly`
（纯校验、不执行）也命中，使见证无法区分「执行过」与「只是解析过」。

## 三、改动清单

**产品代码**（`delivery/mobile/khy-os-client-app/`）

| 文件 | 改动 |
|---|---|
| `android/.../bridge/KhyConsole.java` | 新增执行内核；本轮补 `LOG_TAG` + `exec` 包 `execInner` 的日志见证 |
| `android/.../bridge/ToolSchema.java` | 新增 50 工具契约（描述复用 `Tools.CATALOG`） |
| `android/.../bridge/AmooLoop.java` | 走同一执行通道；`typeIntoAmoo` 唯一净化出站 |
| `android/.../kotlin/.../MainActivity.kt` | 8 个通道方法 + base64 预填 + `onCreate` |
| `lib/core/services/console_service.dart` | 新增；只翻译不重新判断 |
| `lib/ui/screens/console_screen.dart` | 新增；品牌块 + 三类渲染 + 翻历史 + 常用指令 |
| `lib/main.dart` | 控制台为第二页签；**修**导航循环写死 `i < 5`（6 页签只渲染 5 个，「设置」点不到） |
| `android/app/build.gradle` | `testOptions.unitTests.returnDefaultValues = true`（否则 JVM 测试撞 `Log not mocked`） |
| `test/app_shell_tab_parity_test.dart` | 新增页签配平护栏（含阳性对照） |

**验收脚本**（`D:\Portable\4-output\Temp\`，均非产品代码）

| 文件 | 修掉的问题 |
|---|---|
| `khy_accept2.ps1` | ① 认 `KHY_ADB`；② 序列号改 `get-state` 探针；③ ts 过滤器 Int32→Int64；④ `Get-Content` 补 `-Encoding UTF8`（3 处）；⑤ 汇总段同 |
| `khy_run_all.ps1` | step 0 WiFi 防护漏判 mDNS/TLS 形态（会放行 WiFi 设备跑到断网项） |
| `khy_offline_accept.ps1` | 同类 WiFi 漏判 + `$usb` 被循环覆盖；改正向判据 + 探针 |
| `khy_amoo_accept.ps1` | 3 处 `Get-Content` 补 UTF8；序列号改探针 |
| `khy-today.ps1` | `Get-Content` 补 UTF8；`catch { continue }` 改为计数并告警（原先静默丢行） |
| `fake-adb-test.ps1` | 假 adb 的 pull 改认目标参数；补 `get-state` 应答 |
| `khy_witness.ps1` | 新增；序列号改探针动态选设备 |

**交付物**：`khy-os-client-1.1.53-console-release.apk`（62.5 MB，
SHA-256 `349D8BFC088FCD800D3EAC95B959CC5B76536FC49A5EE0A6E3163F5D5912B974`），
仓库内 `build/` 与仓库外 `D:\Portable\4-output\` 各一份，已装机且哈希一致。
