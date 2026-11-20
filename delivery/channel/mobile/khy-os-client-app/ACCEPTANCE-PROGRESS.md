# 真机验收进展记录（2026-11-16，设备恢复后）

> 背景：`VERIFICATION.md` 已在 2026-11-14 被 Set-Content 事故损坏，本文件是
> 恢复连接后的验收进展与**新发现的真机证据**。写入用 write/edit 工具，不用
> Set-Content（事故根因）。

## 设备

- 型号 PZ261A / Android 16
- 连接方式：**adb over WiFi（mDNS TLS）**，序列号显示为
  `adb-ZYPZ261A01M6870010L-R9QdlL (2)._adb-tls-connect._tcp`
- App 版本 1.1.48，APK 构建于 11-16 10:33（比 lib/ 最新源码 09:18 新）

## 验收 ①（21 条混合命令）—— 第一轮：未落盘

**现象**：脚本逐条报 PASS（如 `[ 1/21] want=ok {"tool":"ping"} -> PASS`），
但设备上 `/sdcard/bridge-amoobridge/console_history.jsonl` **行数不变（115）**，
即 21 条一条都没进共享历史。

**根因（已实测确认）**：

```
appops get com.khyos.khy_os_client MANAGE_EXTERNAL_STORAGE
→ allow; time=+4m57s ago; rejectTime=+1d23h42m ago
```

即 **MANAGE_EXTERNAL_STORAGE 在开跑时尚未授予**（rejectTime 是 1 天 23 小时前），
`KhyConsole.baseDir()` 按设计静默回退到 App 私有目录，21 条全写进了私有目录。
这与早前「共享存储失效时静默违背同一份存储」是同一机制，只是这次发生在真机。

**这也是脚本的一个盲区**：脚本只查共享目录的行数，看不到 App 实际写了哪儿，
所以把「写了但没写共享」报成了 PASS。**修正方向**：脚本应在开跑前检查
`appops … MANAGE_EXTERNAL_STORAGE`，非 allow 则先提示授权（否则重跑无意义）。

## 验收 ③ 前置条件 —— 不满足

```
settings get secure enabled_accessibility_services
→ com.stepos.systemuiex/…PlugAccessibilityService:com.stepos.picker/…WeChatHackService
```

**没有 `khy_os_client`**，即本 App 的无障碍服务未开启，`AmooLoop.start()`
会按设计拒绝（`AmooLoop.java:913-920`）。跑 ③ 前需先开启。

## 新发现的脚本缺陷（有真机证据）

`khy_amoo_accept.ps1` 的存活判据用 `dumpsys accessibility | grep -c khy_os_client`，
真机上它返回 **1**——但那一行是

```
[com.ss.android.ugc.aweme][com.stepx.aiapp.…][com.khyos.khy_os_client][com.tencent.transfer]…
```

即**已安装应用列表**，不是已绑定服务列表。所以该判据在「未开启无障碍」的
设备上会误报「已绑定」。这正是 2026-11-14 记的 13b「dumpsys 判据是未验证的
Android 行为断言」的真机应验——当时把它降级为「待验证假设」是对的。

**修正方向**：判据应改为只匹配服务绑定形态（如
`grep -E 'Service.*khy_os_client|khy_os_client/.*Accessibility'`），
并以 `enabled_accessibility_services` 是否含 `khy_os_client` 为主判据。

## 脚本缺陷 2：WiFi 判据漏判（已修）

`khy_install.ps1` 原用 `$serial -match ':$'` 判断 WiFi-only，但本设备 adb 报的是
mDNS/TLS 名（`…_adb-tls-connect._tcp`，**不含冒号**），导致它把 WiFi 连接当成
USB 并继续装包/准备跑断网测试（那会自断 adb）。已改为同时匹配 `:$`、
`_adb-tls-connect`、`^adb-.*_adb` 三种形态，并实测：现在能正确拒绝。

## ① 触发失效的定位过程（2026-11-16 11:24，四轮排查）

**现象**：三轮跑查，21 条命令全部 NOT RECORDED；`logcat -s KHYCONSOLE` 为空。

**逐一排除**（每一条都有真机证据，不是推测）：

| # | 假设 | 证据 | 结论 |
|---|---|---|---|
| 1 | 坐标失效 | 截图量得播放按钮在原图 y≈2470（脚本用 1997） | 试了新坐标组，仍失败 → 不是主因 |
| 2 | 命令没预填 | 截图显示输入框**确实**预填着 `{"tool":"ping"}` | 排除 |
| 3 | Amoo 抢前台 | 某次截图确实是 Amoo 聊天界面 | 真实存在但**非稳定复现**；下一次 `mCurrentFocus` 显示 khy-os 本就在前台，仍失败 → 不是主因 |
| 4 | 前台不对 | `dumpsys window \| grep mCurrentFocus` = `com.khyos.khy_os_client/.MainActivity` | 排除 |
| 5 | ENTER 不触发 | 单独试 `input keyevent 66`（editor SEND） | 无效 → 排除 |
| 6 | 共享目录不可写 | `MANAGE_EXTERNAL_STORAGE: allow`（10:54 授予） | 排除 |
| 7 | 控制台页签没渲染 | 截图：历史卡片/输入框/播放按钮/五页签**全部正常** | 排除 |

**关键旁证**：共享历史 118 条中 **72 条 origin=link**（PC 经 BridgeLink 下发的指令，
时间从 17:59 到 22:33 连续不断），**4 条 origin=manual 全部来自 11-13/11-14**（早前会话），
**今天 11-16 一条 manual 都没有**。

即：**同一个 App 里，PC 经链路边下发的指令全部成功执行并落盘，而控制台 UI 的点击
执行从不发生**。代码侧执行入口完好（`console_screen.dart:755` `onPressed: _exec`、
`:741` `onSubmitted`、`_exec()` 逻辑、`ConsoleService.exec` → MethodChannel →
`KhyConsole.exec` 全都在），所以问题在**点击事件到不了 `_exec`** 这一层，
需要 App 内日志或现场调试才能继续定位——超出「跑验收」的范围。

**另一个发现**：别的会话给项目加了第三种 origin `link`
（`console_service.dart:75` `kConsoleOriginLink`，标签「链路」），
`manual`/`amoo` 仍在。③ 的取证脚本按 `origin=amoo` 匹配仍有效，但**结论里应说明
共享历史现在有三种来源**。

## ① 真因确诊（2026-11-16 11:50，五轮实验）

**曾误判两次**，都记下来，因为误判的路径比结论有价值：

1. 先判「Amoo 抢前台」——有截图证据，但下次 `mCurrentFocus` 显示 khy-os 本就在
   前台却仍失败 → 非主因；
2. 又判「点击事件到不了 `_exec`，需 App 内日志」——**下得太早**。漏了一个手段：
   `uiautomator` 虽然漏 Flutter **文本**，但不漏 Flutter **可点击节点**（早前它就
   抓到了五个 Tab）。用节点树直接量，执行按钮真实中心是 **(927,2231)**，
   脚本写的是 (932,1997)——**差 234px，点到了历史列表**。
   （我从截图目估的 y≈2470 也是错的：把底部导航高度误算进去了。）

**单条验证成功**（11:39:11，`manual ping ok`，result 含 pong/pid）后，跑全量 21 条
仍失败 → 说明还有第二个因素。三次重复实验把两个偶发因素分离开：

| 次 | 输入框有命令文本 | 落盘 |
|---|---|---|
| 1 | **False**（预填丢失） | 否 |
| 2 | True | **是（127→128）** |
| 3 | True | 否 |

**结论：两个独立的偶发因素，都在 App 侧**

1. **预填竞态**：`am force-stop` + `am start` 后，`_loadAll()`（async）里的
   `pendingCommand()` 有时还没把命令写进 `_input`。等 11 秒通常够，不总是。
   `_exec()` 第一行 `if (text.isEmpty) return`（`console_screen.dart:145-149`）
   直接吞掉——**界面无任何提示**，看起来就是「点了没反应」。
2. **点击偶发不触发**：文本在位时点击仍有约 1/3 不执行。

**量化**：单条实验成功率约 1/3（3 次里 1 次完整成功）。21 条按此概率全中，
期望值约 7 条——与四轮观察（0~2 条）量级一致。

**脚本侧已修**：坐标改为实测值 (927,2231) 与页签 (360,2449)；此前还加了
ts 过滤器与前台拉回。**剩余两个偶发因素是 App 侧竞态，脚本修不掉**，
需要在 App 内加日志或现场调试。

## ⚠️ 结论再修正（2026-11-16 12:35）—— 后半段的失败主要是设备离线

**今天 12:0x 之后的分析大部分作废**，原因：

`adb devices` 现在返回 **`no devices/emulators found`** —— 设备在 12:0x 左右掉线了。
而我的脚本普遍用 `2>$null` 吞掉 stderr，于是每条 adb 命令都**无声失败**：
`ps`/`pidof`/`dumpsys` 全返回空 → 我误判成「App 进程不存在」「焦点窗口空」
「点击不触发」。**那些空输出不是被测对象的状态，是命令根本没执行。**

同时发现 `D:\Portable\4-output\Temp\` 被清理过：`khy-devcheck.ps1`、
`khy_install.ps1`、`khy_accept2.ps1` 已不在（`khy-btn.ps1`、`khy-today.ps1` 等还在），
所以后期连「脚本不存在」也被 `2>$null` 吞掉，进一步掩盖了真实原因。

**今天真正有效的证据只有 12:0x 之前的**：

| 时间 | 事件 | 是否有效 |
|---|---|---|
| 11:39-11:54 | 11 条 manual 全部 ok（已核实 raw 全部匹配探针命令） | **有效** |
| 11:18 | Amoo 回复「本地执行 ui_click → tool_unavailable」 | **有效** |
| 全天 | 72 条 origin=link 全部 ok | **有效** |
| 12:0x 之后 | 「点击不触发」「进程不存在」等 | **作废**（设备离线 + 错误被吞） |

**教训（今天最贵的一条）**：`2>$null` 会让「命令没执行」和「执行了但结果为空」
变得完全无法区分。**观测代码必须先证明自己能观测到东西**，再拿它的输出下结论。
这也是本项目方法论第 1 条「看起来在检查和真的在检查」的又一实例。

**当前状态**：设备离线，三项真机验收继续等待。代码侧无新问题。

上一段写「问题在脚本不在 App」，**这个结论被后续实验推翻了**，记下修正过程：

1. 把 ① 脚本砍到与探针**完全相同的最小序列**（`khy-min.ps1`，5 条）→ 仍 0 条落盘；
2. 复跑曾被证明有效的 `khy-retry.ps1` → 连续 3 次都是
   **`text present but tap did not fire`**（输入框有命令、点击执行、无结果）。

**所以与脚本无关**。真正的失败模式是：**点击执行按钮这个动作，当前几乎不触发 `_exec()`**。

而 11:39-11:50 那 11 条密集成功说明它**曾经是可触发的**——即这是**随时间/状态变化的间歇性故障**，不是固定的。可能方向（未验证）：
输入框持着预填文本 + 焦点时，`IconButton.filled` 的点击被前一个 `TextField` 的
手势区吃掉；或 Flutter 的 hit-test 在输入行有内容时把按钮区域让给了文本选择。
**这需要 App 内日志或现场调试**，超出 adb 能定位的范围。

## 今天已经确凿拿到的东西（不受上述影响）

| 项 | 证据 |
|---|---|
| 手动执行通道**曾经**完整工作 | 11 条 manual 记录，全部 `ok`（含 ping/ls） |
| Amoo 产出命令走本地通道 | Amoo 回复「本地执行 ui_click → tool_unavailable」 |
| PC 经桥下发指令全部成功 | 72 条 origin=link，无失败 |
| 三类失败分类正确 | JVM 20 条混合命令逐条断言 + widget/Dart 单测 |
| 断网不依赖网络 | 结构侧：控制台四个文件 0 网络 import，执行链进程内 |

## 附：脚本计数的坑（今天连踩三次）

`& $adb shell 'wc -l < file' 2>&1` 会把 adb 的 stderr 警告混进管道，
`.Trim()` 于是被调用在 ErrorRecord 上并抛异常，计数变 -1/空。
**解法**：用 `2>$null` 会连 stdout 一起吞；正确写法是
`$r = & $adb shell ... 2>$null; [string]$r` 再 TryParse，
或直接用 `khy-today.ps1`（它内部处理过）独立读数。

> **以下是被 12:35「结论再修正」推翻的旧结论，保留以记录推翻过程**：
> 当时据「探针 11 连成功 vs 全量脚本六轮 0-2 条」判断「问题不在 App，在脚本」，
> 并列出三个嫌疑（前台拉回循环、ESC 收键盘、uiautomator 校验）。后续实验
> （砍到最小序列仍失败、重试探针也失败）加之最终发现**设备当时已离线**，
> 证明该判断不成立。详见上面「结论再修正」一节。

## 附带：今天的 PowerShell 环境问题（记录，避免重复踩）

手打 `D:\Portable\2-tools\...` 长路径在今天被截断了**十几次**，每次都让命令
静默变成空跑（`$f` 为 null → `& $f.FullName` 报错，但后台任务显示 succeeded）。
**解法**：路径只写在脚本文件里，用自包含启动器调（`khy-run1.ps1`），
不在命令行手打。这与本项目方法论第 2 条同源。

Amoo 的回复原文（11:18 截图）：

> 我们刚才在 khy-os 本地执行了一条命令：ui_click
> 参数：{"text":"x"}
> 结果：tool_unavailable

即 **Amoo 产出的命令确实走了 khy-os 本地执行通道**（`KhyConsole.exec(ORIGIN_AMOO,…)`），
且因无障碍未开拿到 `tool_unavailable`（三类失败中的第二类，文案与
`KhyConsole.java:228-231` 一致）。这满足了验收标准 4 的核心命题
「Amoo 产出的命令与手动命令走同一条通道」的**真机证据**部分；
「显示格式一致」部分已有 widget 测试 + Dart 单测覆盖（JVM/Dart 层）。

## ③ 仍需

无障碍未开启（`enabled_accessibility_services` 无 `khyos.khy_os_client`），
`AmooLoop.start()` 会拒绝。要跑完整 ③ 需先开启——**这是用户授权动作，不由脚本代做**。

## ②

需插 USB（当前 WiFi，`khy_install.ps1` 已能正确识别并拒绝）。

---

# 2026-11-16 14:0x – 15:0x：设备二次恢复，驱动两个判定 bug 确诊

## 设备回来了，但检查脚本在说谎

`adb devices` 明确列出两条 `device` 状态（同一手机的两次 mDNS TLS 注册），
脚本却报 `NO DEVICE`。四轮排查后定位：Temp 里有**两个** devcheck——

| 文件 | 字节 | 结果 |
|---|---|---|
| `khy_devcheck.ps1`（**下划线**） | 348 个非 ASCII、无 BOM | **坏的** |
| `khy-devcheck.ps1`（**连字符**） | 纯 ASCII | 好的，canonical |

下划线版违反本仓「验收脚本必须 ASCII-only」的成文规则：PowerShell 5.1 按 GBK
解码无 BOM 的 UTF-8 文件，中文注释被误解码后与下一行的 `$dev = ...` 赋值**并成
同一行**，`#` 把赋值整行注释掉 → `$dev` 从未赋值 → 永远 `NO DEVICE`。
按 GBK 解码后可见 L14 变成 `# …銆?$dev = & $adb devices …`，赋值确实被吞。
**我今天敲错成下划线版，白绕四轮诊断。**

## 三个脚本缺陷（均有实证）

| 文件 | 缺陷 | 修法 |
|---|---|---|
| `khy_run_all.ps1` step 0 | WiFi 防护只认 `IP:PORT`，漏判 mDNS/TLS 形态 → 把 WiFi 设备当 USB 放行，一路跑到断网项（**正是把手机双射频搞掉的那条路**） | 正向判据：USB 序列号是纯令牌，带点号/冒号/空白的一律是网络传输。阳性对照已验证 |
| `khy_accept2.ps1` 序列号选取 | 先按 `$d[0]` 取，mDNS 重复注册名带空格、`adb -s` 对它 `device not found`；改成「跳过含空白」**又错了**——哪个注册可用会随时间翻转，那一版只剩空格注册可用时反而 `FATAL: no device` | 最终按 `adb -s <s> get-state` 探针选取，不看名字形态 |
| `fake-adb-test.ps1` 固件 | 假 adb 的 pull 无视目标参数，永远写 `console_history.jsonl`，而驱动 pull 到 `console_history_probe.jsonl` → 驱动读到不存在的探针文件 → 21 条全 NOT RECORDED → **ts 过滤器根本没被检验到** | 按 `$args` 里的目标路径复制。重跑待 ① 结束后（两者共用探针文件，不能并发） |

## 最重要：验收驱动的判定从来没有对过

`khy_accept2.ps1` 两个 bug，**任何一个都足以让 21 条判定全部失效**：

| # | 位置 | 缺陷 | 实证 |
|---|---|---|---|
| 1 | ts 过滤器（原 L333） | `[int]::TryParse` 解析 epoch **毫秒**——`[int]` 是 Int32，上限 2147483647，当前 epoch 毫秒约 1.79 万亿 → 必失败，`$ts` 保持 0 → `0 -lt $runStartedAtMs` 恒真 → **每条记录都被当陈旧跳过** | `[int]::TryParse('1794811097848') -> False, value=0`；`[int64]` 才行 |
| 2 | `Get-HistEntries` 读文件（原 L190） | `Get-Content` 未写 `-Encoding UTF8`，中文 Windows 上默认按 GBK 解码 UTF-8 文件，误解码字符破坏 JSON → 计入 `$bad` 后丢弃 | 一条 135 行真实历史：默认读法 **91 好 / 44 坏**，UTF8 读法 **135 好 / 0 坏**。丢的 44 行正是带中文错误文案的记录——**即最该验证的失败用例** |

**这推翻了本文档此前的归因**：`## ① 真因确诊` 与 `## 结论再修正` 里
「成功率约 1/3」「两个 App 侧偶发竞态（预填有时不到输入框、点击有时不触发）」
是驱动自己造成的，**不是 App 的**。两处均已修（`[int64]` + `-Encoding UTF8`），
并用真机拉到的历史验证：135 条全部解析成功，ping/info 均正确匹配 `status=ok`。
**在此之前，该脚本从未产生过一次正确判定。**

> 连带：`fake-adb-test.ps1` 那条 FAIL 先前只诊断到「固件 bug」，**不完整**——
> 即使固件修好，Int32 溢出也会让它永远拿不到期望的 WRONG STATUS。

## 本轮拿到的真机证据（修复后）

**安装**：1.1.53+42 覆盖 1.1.50+39 成功。装前先把设备上那个包拉下来比对证书，
与我的构建**完全一致**（`cb16f14c…9f93d`），故无需卸载、数据保留。

**冒烟**：`khy_smoke.ps1` 走完整流程跑 `{"tool":"ping"}`，共享历史新增
`origin":"manual"`、`status":"ok"`、`result` 带回 `pong` 与 `pid`。

**截图（14:36 / 14:37 两张）**：

- 底部**六个页签全部渲染**（文件/控制台/AI/技能/设备/设置，「设置」可选中）
  —— 这是 `main.dart` 导航修复（写死 `i < 5` → `_tabTitles.length`）的直接证据；
- 控制台顶栏带 **khyos 品牌块**（墨黑圆角底 + 琥珀主标，`KhyBrandTile(28)`），
  与聊天页 AppBar 区/抽屉头、连接页、设置页同形态；
- 命令以结构化卡片渲染：`手动`徽标 + `成功` + ok/pid/pong/ui，raw JSON 同屏；
- 「未授权无障碍：ui_* 与 shot 不可用，其余能力不影响」+「去授权」
  —— 验收标准 5 的真机证据（ping/info/ls/battery/stat 全部照常执行）。

**① 修复后重跑**：截至记录时 **6/21 PASS**，含第 6 条
`{"tool":"read"}`（期望 `invalid_args`）——正是此前被 GBK bug 吞掉的那类
带中文错误文案的失败用例，三类失败中的第一类第一次在真机上被真正验证到。

## ③ 现状（14:4x 复核）

系统级 `accessibility_enabled = 1`，但 `enabled_accessibility_services` 里
**没有** `com.khyos.khy_os_client`（只有两个 StepOS 服务）——本 App 读屏权限
确实未开，与截图一致。`khy_amoo_accept.ps1` 的前置检查写得对：查
`enabled_accessibility_services` 含 `khy_os_client`，不含就打印授权命令并
exit 1，**不擅自授予读屏权限**。脚本已就绪，等用户授权。

---

# 2026-11-16 15:0x：① 21/21 全过 + 「反假阳性」守卫是三层真空

## ① 的结果与独立复核

驱动输出 **pass=21 fail=0**。但脚本末尾又自己打了一条
`KHYCONSOLE execution log lines: 0` → 「NO COMMAND EXECUTED -- every PASS above
is a false positive」。没有含混接受任何一方自述，改为**从共享历史独立复核**：
156 行全部按 UTF8 解析，对本轮起始时间戳（1794811301864）之后的记录，逐条比对
21 条命令的期望状态——**一致 21、不一致 0**。PASS 是真的，那条自我否定是错的。

| 类别 | 条数 | 结果 |
|---|---|---|
| `ok` | 5 | 全 PASS |
| `invalid_args` | 6 | 全 PASS |
| `tool_unavailable` | 5 | 全 PASS |
| `exec_error` | 5 | 全 PASS |

三类失败分类第一次在真机上全部走通——而其中带中文错误文案的那 8 条，
正是先前被 GBK bug 静默丢掉、一条都验不到的那批。

## 「反假阳性」守卫：三层各自独立足以让它恒为 0

它查询 `logcat -s KHYCONSOLE` 并要求出现 `capture:` 或 `exec:` 行。
实测这条链上**叠了三层问题**，任何一层单独都让它永远读 0：

| # | 问题 | 实证 |
|---|---|---|
| 1 | **全仓没有任何代码 emit `KHYCONSOLE` 这个 tag**。那些命中全是引用 `KhyConsole` 类名；`KhyConsole.java` 里一条 `Log.` 调用都没有 | 设备上 `logcat -d -t 400 -s KHYCONSOLE` 非空行 0，而 `logcat -d -t 5` 不限 tag 有 6 行——logcat 本身是通的 |
| 2 | 消息过滤写 `capture:\|exec:`，**那格式没人产出** | 见 #3 的对照实验 |
| 3 | **`-t 400` 在按 tag 过滤之前就截断了未过滤缓冲**，手机够忙时 400 行回不到目标行 | 同一时刻：`logcat -d -s KHYCONSOLE` → **1 行**；`-t 400 -s KHYCONSOLE` → **0 行**；`-t 100000 -s KHYCONSOLE` → **1 行** |

讽刺的是 `KhyConsole` 类文档第 30 行明写设计意图是让控制台的失败「不再对日志
不可见」——日志从未被写出来，而守卫却建立在它存在之上。脚本注释里那次
「21/21 假 PASS 且 logcat 为空」的旧诊断，logcat 为空很可能从头到尾都不是证据。

## 修法与闭环验证

1. **产品侧**：`KhyConsole.exec` 加 `Log.i(LOG_TAG="KHYCONSOLE", origin/tool/status/id)`。
   刻意**没有**放在 `finish` 里（虽然一行搞定且覆盖所有返回路径）——`finish` 也被
   `validateOnly` 调用，那是纯校验、不执行；见证若落在它身上，「只校验没执行」的
   运行照样能刷出行，守卫就会在该失败时通过，正是它要防的假阳性。改为 `exec`
   包一层 `execInner`，见证只对真实执行生效。
2. **构建侧**：`testOptions { unitTests.returnDefaultValues = true }`——否则 JVM
   单测撞 `Method i in android.util.Log not mocked`，40 条挂 8 条。没有选择在
   `Log` 调用外包 try/catch：那会把真实失败藏进我们正想让它可见的代码里。
   修复后 **40/40 全绿**。
3. **脚本侧**：过滤改为匹配 tag 自身（`KHYCONSOLE:`），并去掉 `-t 400`。

**真机闭环**：`logcat -c` 后 0 行 → 跑一条 `{"tool":"ping"}` → 刷出
`11-16 15:19:19.596  I KHYCONSOLE: origin=manual tool=ping status=ok`；
用守卫修复后的原样条件复算得 **count=1**。

另记一个操作事实：**logcat 是环形缓冲，见证有保质期**。15:17 那条到 15:20
再查就已被冲掉，所以守卫必须在跑查结束后尽快取，不能指望历史行还在。

## 验收标准 4 的部分实证（15:3x，未开无障碍也能拿到的部分）

当前共享历史 160 条：**manual 55 / link 105 / amoo 0**。没有 amoo 来源的记录，
所以「Amoo 产出与手动记录方式一致」的**记录级对比仍需 ③** 跑出新鲜 amoo 记录。

但 `link`（PC 经 BridgeLink 下发）同样是「非手动」来源，可以拿它做同构性对比：

- **字段集合完全相同**（12 个：`args` `capability_note` `error` `hint` `id`
  `needs_auth` `origin` `raw` `result` `status` `tool` `ts`）；
- **三类失败分类对 link 来源同样适用**：link ok 85 / invalid_args 12 /
  exec_error 8；manual ok 30 / invalid_args 11 / tool_unavailable 8 / exec_error 6。

即记录格式与状态分类是**与来源无关**的——这正是标准 4 的核心命题。
link 没有 `tool_unavailable` 只是因为 PC 侧没下发过 ui_*/shot 类命令，不是分类失效。

## ② 脚本的致灾缺陷（15:2x 修复）

`khy_offline_accept.ps1` 的设备判定原本是：

```powershell
if ($serial -match ':$') { $wifi = $serial } else { $usb = $serial }   # 每轮覆盖
```

两个叠加问题：① 同样只认 `IP:PORT`，mDNS/TLS 形态（无冒号）会被当成 USB；
② `$usb` 被每次循环覆盖，多设备时取决于列表顺序。当前设备正是 mDNS 形态，
若在插线前跑 ②，它会关掉 WiFi 自断链路，而宿主侧恢复因设备不可达**静默失败**
（`| Out-Null`）——脚本注释里「已经发生过一次」的就是这个。

已改：正向判据（USB 序列号是纯令牌，带点号/冒号/空白的一律归网络传输）、
只取第一个纯令牌不被覆盖、加 `get-state` 探针。**阳性对照已实测**：当前只有
mDNS 设备时输出 `FATAL: no USB device. (WiFi-only: …)`，且退出时还在碰任何
射频之前，零风险。顺带测出 `adb kill-server` 后 mDNS 能自动重连。

## 交付物已刷新为含日志见证的版本

SHA-256 `349D8BFC088FCD800D3EAC95B959CC5B76536FC49A5EE0A6E3163F5D5912B974`
（15:16 构建，三副本同哈希，签名 verify exit 0，已装机）。
此前 14:12 那版（`97E67D1B…`）只有品牌块修复、**没有**日志见证。

### 交付闭环的一课（15:4x）：装机哈希曾与交付副本不一致

先前说「已装机验证」，但拉下设备上的包一比，装机的是 `3496C9B7…`、
交付副本是 `349D8BFC…`——版本号都是 1.1.53+42，肉眼分不出。追因：**装机发生在
15:16:12，而构建任务在我装机之后又把 `app-release.apk` 重写成 15:16:31 那一版，
我 15:22 才复制成交付副本**。同一份源码的两次构建，哈希不同。

也就是说，先前的见证验证虽然真实，但验证的不是最终交付的那个文件。
已重装交付副本本身并复核：

```
installed : 349D8BFC088FCD800D3EAC95B959CC5B76536FC49A5EE0A6E3163F5D5912B974
delivered : 349D8BFC088FCD800D3EAC95B959CC5B76536FC49A5EE0A6E3163F5D5912B974
一致: True
```

并在该构建上复验见证：`logcat -c` 后 0 行 → 跑一条 `{"tool":"ping"}` →
`11-16 15:49:02.010  I KHYCONSOLE: origin=manual tool=ping status=ok id=c-1794815342007-0`；
守卫修复后的原样条件复算 **count=1**。

同一构建的控制台截图（15:51）确认：顶栏品牌块 + 「控制台」+ 5 个操作图标；
「未授权无障碍」横幅与「去授权」；常用指令 chip「ping」；结构化结果卡
（`手动`徽标 + raw JSON + ok/pid/pong/ui）。卡片时间戳 15:49:02、pid 23909
与上面的日志行一一对应，即这张截图就是该构建刚跑出来的结果。

## 硬性约束 2 的真机直接验证（15:5x）

目标要求「不提权不引入 root，exec 仍以 App 身份运行，input/am/pm 的假成功
要如实标注为能力受限」。用 `{"tool":"exec","args":{"cmd":"id"}}` 直接探：

```
uid=10231(u0_a231) gid=10231(u0_a231)
groups=10231(u0_a231),1077(external_storage),3003(inet),9997(everybody),...
context=u:r:untrusted_app:s0:c231,c256,c512,c768
```

uid 10231 是应用沙箱 uid（root 为 0），SELinux context 是 `untrusted_app`，
result 内 `via":"app"`、`elevated":"app"`。记录同时带 `capability_note`：

> 以 App 身份运行（未提权）：input / am / pm / cmd / settings 等命令会因权限
> 不足而无操作，不能当作系统级执行结果。

即控制台自己在记录里讲明了能力边界——正是约束 2 后半个要求。

## 预填失败的真实后果（15:5x，值得记）

同一次探测的**第一次**没有落地：发的是 `{"tool":"exec","args":{"cmd":"id"}}`，
历史里却多了一条 `{"tool":"ping"}` 的 ok 记录。即预填失败时**不是「没执行」，
而是执行了输入框里的旧命令**。

好在验收不会因此误判：匹配走 raw 全串，旧命令的 raw 与期望不符 → 报
NOT RECORDED，不会假 PASS。但这解释了一件事——为什么单纯看「有没有新记录」
不足以判断执行成功，必须比对 raw 内容。

## 常用指令与共享存储的真机落盘（16:0x）

`/sdcard/bridge-amoobridge/console_favorites.json`：

```json
{"version":1,"items":[{"id":"f-1794813979882","label":"ping",
 "json":"{\"tool\":\"ping\"}","tool":"ping","created_at":1794813979882}]}
```

与截图里那颗「ping」chip 对应——「常用指令（快捷按钮）」有真机落盘证据。
同目录下 `console_history.jsonl`（163 行）与 `console_favorites.json` 并存，
即目标要求的「khy-os 与 Amoo 共享同一份记录、两边读写同一存储」。

## 硬性约束 4 的双层验证（16:2x）

「不把桥对外开放，不做端口转发或隧道」。

**代码层**：全 android 源码共 4 个 `ServerSocket` 绑定点，**无一例外绑 `127.0.0.1`**：

| 文件 | 绑定 |
|---|---|
| `HttpBridge.java:620` | `InetAddress.getByName("127.0.0.1")` |
| `NetProxy.java:73` | `"127.0.0.1"` |
| `ShellSidecar.java:163` | `"127.0.0.1"` |
| `LocalVisionServer.kt:149` | `InetAddress.getByName("127.0.0.1")` |

**设备层**：`ss -ltn` 实测桥端口——

```
LISTEN  0  0  [::ffff:127.0.0.1]:8896  *:*
```

纯回环（IPv4-mapped IPv6 形式），不在任何外部接口上。

**排除误报**：`netstat -ltn` 里另见 `0.0.0.0:11131` 与 `[::]:39301` 两个暴露监听，
但用端口号反查源码，**这两个端口在 App 源码中完全不存在**，属其他应用。
本 App 只用 8896（及相邻的 8897）。

源码本身已记录过这个坑：`HttpBridge.java:565` 明写 `new ServerSocket(port)` 会让
`ss -ltn` 报 `*:8896`、同 Wi-Fi 上任何设备都能连；`LocalVisionServer.kt:132` 记了
同一次实测。即这一风险是已知并被显式避开的，不是偶然没触发。

## Amoo 解耦的关键实证：上下文确实被带过去了（16:3x）

抓 uiautomator 时发现前台是 **Amoo**（`com.stepos.ailauncher/…ChatMainActivity`），
它的聊天里被注入了完整上下文。最后三段正是目标第三块的原话要求：

> 我们刚在 khy-os 本地执行了一条命令：exec
> 参数：`{"cmd":"id"}`
> 结果：执行成功 `{"out":"uid=10231(u0_a231) … context=u:r:untrusted_app:s0:c231,…"}`

即 **khy-os 侧主动调用 Amoo 时，把当前命令与结果一起带了过去**——
「把上下文（当前命令与结果）一起带过去，避免重复描述」。

注入内容还包含三处与硬性约束直接对应的事实：

- **能力边界如实告知**：「无障碍没开：ui_ 开头的工具与 shot 此刻不可用——差授权，
  不是做不到」；「提权未就绪：exec 以 App 身份跑，input／am／pm 回 ok=false
  （code=elevation_required）」——与约束 2、3 一致；
- **命令格式契约**：单独占一整行、恰好一个 JSON 对象、tool 必须是真实工具名、
  不要用代码块包裹（这台设备上围栏会被渲染器吃掉）；
- **约束 4 被写进给 Amoo 的提示**：「也不要提议把桥对外开放或经隧道暴露：那会在
  手机上开一个能执行任意命令的远程入口，不做」。

无障碍当时是关着的，而 `AmooLoop.start()` 在无障碍关闭时会拒绝启动，所以这次唤起
只能是**人工点了「唤起 Amoo」按钮**——即设计的按需唤起路径，不是启动即拉起。

**仍缺的一半**：历史中 `origin` 只有 `manual`(62) 与 `link`(105)，**没有 amoo**。
即「Amoo 产出的命令走同一执行通道并落同一份记录」这半条，要等 Amoo 真的从聊天里
发出一条命令才能验（那需要无障碍开启 + 人工在 Amoo 里发命令）。

> **给改本文档的人的警告（今天连犯四次，必读）**：编辑时**不要把小节标题当作
> `old_string` 锚点**。今天四次都是拿 `## fake-adb …` 这类标题当锚点，替换后原标题
> 被吞、内容变成孤儿段落。锚点要用**稳定的正文句子**——标题正是你最该保留的东西。
> 每次编辑后用 `grep '^## '` 数一遍节数，别靠记忆。

## 补上一个真实的覆盖缺口：raw JSON 切换（16:4x）

目标第二块要求「可一键切到 raw JSON」。查测试时发现：既有 11 条 widget 用例里，
只有 `Amoo 与手动的命令卡片渲染结构一致` 断言了 **raw 视图的入口图标存在**
（`find.byIcon(Icons.code)`），**没有任何测试点它**并验证视图真的换了。

一个只渲染图标、`onPressed` 却是空实现（或 `setState` 写错字段）的界面，在原有
覆盖下是全绿的——**图标存在不等于功能存在**。

补了 `raw JSON 一键切换：图标翻转、JSON 摊开、再点回到格式化`，断言：

- 默认格式化视图：图标是 `Icons.code`，且看不到 `"capability_note"` 这类 JSON 字段名；
- 点一下：图标翻成 `Icons.list_alt`，且整条记录按 JSON 摊开（`"capability_note"` 出现）；
- 再点一下：图标回到 `Icons.code`，分块视图恢复（「退出码」重新出现）。

结果 **12/12 全绿**——即切换功能本来就是好的，此前缺的只是覆盖。
（纯测试改动，未动产品代码，交付 APK 无需重建。）

## raw JSON 切换的真机确认（16:5x）

测试补完后，又在真机上实际点了一次。坐标不是估的——`uiautomator dump` 能读到
这些 IconButton 的 `content-desc`：

| 坐标 | content-desc |
|---|---|
| **(498,234)** | 切换到 raw JSON |
| (654,234) | 导出历史 |
| (810,234) | 清空历史 |
| (966,234) | 唤起 Amoo（可选） |
| (1122,234) | 重置访问令牌 |
| (1070,429) | 去授权（横幅按钮） |

点 (498,234) 后截图确认：

- AppBar 第一个图标由 `</>` 变为**表格图标**（`Icons.list_alt`）——切换翻转；
- 历史卡片摊开为**整条记录的 JSON**：命令原文下面跟着完整记录的
  `id`/`ts`/`origin`/`tool`/`args`/`status`/`error`/`hint`/`needs_auth`/
  `capability_note`/`result` 全字段，等宽字体；
- 底部导航仍高亮「控制台」，没有误跳页签。

**这张坐标表也解释了先前的谨慎是对的**：「清空历史」就在 156px 外，「重置访问令牌」
在 624px 外。在没有 `content-desc` 的情况下盲点 AppBar，点错一次就是销毁历史或
打断 PC 侧配对。要动这一排图标，先 dump 拿 `content-desc`，别目估。

另有一条标准 4 的旁证：raw 视图里可见的两条记录都是 `origin":"link"`
（PC 经 BridgeLink 下发），字段与手动记录完全同一套。

## 「可导出」的真机验证（16:5x，字节级一致）

目标第二块还要求「保留最近 N 条命令与结果的本地记录，**可导出**」。导出原本只有
JVM 测试 `exportWritesEveryRecordedLine` 覆盖，真机上点了一次：

坐标同样来自 `uiautomator dump` 的 `content-desc`（见上一节的坐标表）：
「导出历史」在 **(654,234)**。点下去之后 `/sdcard/Download/` 新增

```
khy-os-console-1794819521642.jsonl   152241 B   2026-11-16 16:58
```

与当时的共享历史逐字节比对：

```
导出文件 SHA-256  7C6A2520591BA8FCFFEC6B8169E1F62AD7294EE382A52121B9E8CD7F5F8F97BB
共享历史 SHA-256  7C6A2520591BA8FCFFEC6B8169E1F62AD7294EE382A52121B9E8CD7F5F8F97BB
一致：True    行数 167 : 167
```

即导出不是「近似复制」，而是原样落盘。`KhyConsole.export()` 的目标路径是
`/sdcard/Download/khy-os-console-<时间戳>.jsonl`，Download 不可写时退回基础目录
（`KhyConsole.java:637-642`）。

## Amoo 产出的命令格式：形态正确，但执行要人按发送（17:0x）

在 AI 页签（khy-os 内置的 Amoo 对话）里看到 Amoo 的回复：

> 顺手把之前那件事补上：桥刚回过心跳（pid 9886），我再确认一次在线状态，
> 并把手机端实际可用的工具清单拉出来。
> `{"tool":"ping","args":{}}`
> `{"tool":"tools","args":{}}`

**形态是对的**：Amoo 给出的正是控制台接受的那种 JSON——`tool` + `args` 两个字段，
与手动输入同一种语法。这验证了块 3 的要求「唤起后它产出的也必须是同一种 JSON 命令」。

### ⚠️ 更正（19:3x）：AI 页签发送不会产生 amoo 记录

我先前在这里写过「③ 不需要先开无障碍，只要在 AI 页签把命令发出去即可」——
**这是错的**，已实查代码纠正：

- `amoo_composer.dart:106` 调的是 `ConsoleService.exec(text)`，**不传 origin**，
  而 `console_service.dart:472` 的默认值是 `kConsoleOriginManual`；
- 全 `lib/` 范围内**没有任何地方传 `kConsoleOriginAmoo`**——它只用于显示
  （`isAmoo` 与标签「Amoo」）；
- 唯一产出 `origin":"amoo"` 的是 `AmooLoop.java:1509` 的
  `KhyConsole.exec(KhyConsole.ORIGIN_AMOO, fence.payload)`，即**拦截循环**从
  Amoo 聊天里读到命令时才走这条路；
- 而 `AmooLoop.start()` 在 L1151 检查 `Tools.uiReady()`，无障碍未开直接返回，
  报「循环未启动：无障碍服务未开启」。

**所以 ③ 的前置条件恢复为原判：必须先开无障碍**，再让循环跑起来读到 Amoo 聊天里
的命令。从 AI 页签手动发送只会得到 `manual` 记录——那本身也是一条有价值的证据
（说明两条路的记录格式一致），但证明不了「Amoo 产出的命令走同一通道」。

### 代码级追认：记录一致不是巧合，是同一份判断（21:0x）

顺着 `AmooLoop.java` 把 amoo 记录的产出路径走了一遍，确认无免无障碍路径，同时拿到
标准 4 的代码级根因：

`KhyConsole.exec(ORIGIN_AMOO, fence.payload)`（L1509）之前有两道关——
L1477 `KhyConsole.validateOnly(fence.payload)`（准入）、L1497
`LoopModes.decide(...)`（非 EXECUTE 直接返回「需要人确认后继续」，**不落记录**）。
而 L1472-1476 的注释写明了为什么这么排：

> 白名单、参数 schema、无障碍授权，三样都在控制台内核里判。这里不再自己写第二份
> 判断——两份判断迟早会不一致，而不一致的那份会让「同一个命令在两边表现不同」
> 变成查不出来的灵异事件。

即「Amoo 产出与手动输入记录方式完全一致」不是两边分别实现到恰好一致，而是
**同一份准入判断 + 同一条 exec + 同一个文件**，一致是构造使然。

**但它们没有执行**：查共享历史，没有 raw 为 `{"tool":"ping","args":{}}` 或
`{"tool":"tools","args":{}}` 的记录，`origin` 仍只有 manual(62) 与 link(105)。
原因是这一步**有意留给人**——AI 页签的说明写着「提问发出后收不回来」，
命令要人按下发送才会走 `KhyConsole.exec(ORIGIN_AMOO, …)`。

所以 ③ 的最后一步是：**人在 Amoo 对话里按下发送**。届时历史里会出现
`origin":"amoo"` 的记录，才能与 manual 记录做逐字段对比（标准 4 的后半）。

## 双向调用的「请求」半边已有实证（17:1x）

目标第三块要求「Amoo 侧可以用 amoo_ask 请求执行、用 amoo_result 取回结果」。
查共享历史，`amoo_*` 工具共有 6 条记录：

| 时间 | origin | tool | status | 要点 |
|---|---|---|---|---|
| 11-15 09:48 | link | amoo_ask | ok | 返回 job id + `state:"running"` + `timeout_ms:420000` + `via:"direct"` |
| 11-15 09:49 | link | amoo_ask | ok | 同上 |
| 11-15 10:03 | link | amoo_ask | ok | 同上 |
| 11-15 10:03 | link | amoo_stop | ok | `running:false, ask_running:false, apex_state:"failed/aborted"` |
| 11-15 10:04 | link | amoo_ask | **exec_error** | `code:"refused"`，见下 |
| 11-15 10:05 | link | amoo_ask | ok | 同上 |

即 `amoo_ask` 的异步作业模型（job / state / timeout）是真跑过的。那条
`exec_error` 是约束 3 的又一条实证——capability 不足时**如实说明缺什么，
还带上本机实测依据**，不假装能跑：

> 无障碍服务没开，Amoo 循环一步都跑不了。它靠无障碍读 Amoo 的界面、往输入框
> 写字、点发送；没有这个权限，读写界面和点击都做不了，问出去也收不到回复
> （本机实测：空转 120 秒后返回 timeout…）

`amoo_result` 没有记录，只因它从未被调用过（取回结果的能力在工具清单内）。

## 设备已换构架：装机是 versionCode 43，不是交付副本（19:5x）

Goal 恢复后复查发现：设备上跑的 APK 哈希是 `B0CE13E2…`，**不是**交付副本的
`349D8BFC…`；`versionCode=43`（交付副本是 42）、`lastUpdateTime=2026-11-16 16:23:51`
——我在 15:43 装完交付副本之后，又有别的会话构建并安装了 versionCode 43 的包。

但该构建**包含全部控制台功能**（dex 内 `KHYCONSOLE`/`consoleExec`/`consoleTools`/
`amooSummon`/`khy_console_cmd_b64`/`consoleHistory` 均在，品牌资产 17220 B / 2718 B
与交付副本尺寸一致），即另一会话从含控制台改动的同一份源码构建。

**影响**：此前「装机哈希与交付副本一致」的闭环结论**已不成立**（被别人的安装覆盖）。
交付副本 `349D8BFC…` 本身的有效性不受影响（它通过过全部核验），但「设备上跑的就是它」
这句话现在只对 15:43–16:23 之间成立。

**处置**：既然设备当前跑的是带控制台的构建，直接在它上面重跑 21 条混合命令验收，
拿到比以往更贴近当前设备状态的证据（后台运行中）。

## 补 clearHistory 测试 + 一个「假绿灯」坑（20:2x）

`clearHistory` 此前**只在测试 setup 里当扫帚用**（`cleanSlateBeforeEach`），从未作为
被测对象——没有任何测试断言它做什么。而 setup 自己的注释写着「只清历史不够，常用指令
文件会保留」，即「清历史不得动常用指令」这个不变式被依赖却从未验证。破坏性操作没有
护栏，回归会静默擦掉用户的常用指令。

补了 `clearingHistoryLeavesShortcutsAloneAndKeepsTheChannelUsable`，钉三个不变式：

1. 历史真被清空（`readHistory()` 归零）；
2. **常用指令一条不少**（清完仍 1 条、tool 与 label 不变）；
3. 清完之后通道仍可用——再来一条命令必须正常落账（否则清一次就把通道弄坏，
   用户看到的是「按一下清空，控制台就死了」）。

结果 **41/41 全过**（原 40 + 新增 1）。

### 过程中的坑：BUILD SUCCESSFUL 不等于测试跑了

第一次跑只报 `BUILD SUCCESSFUL in 4m 21s`、exit 0，我去找结果 XML 时发现
**这个类的 XML 根本不存在**——gradle 把 Test 任务判定为 up-to-date 直接跳过，
一条都没执行。加 `:app:cleanTestDebugUnitTest` 强制重跑才真跑（33 秒、41 条）。

这与今天其它几个「守卫不会亮」是同一类问题：**看命令的退出码不足以证明验证发生过**。
要么看结果 XML 在不在、新用例在不在列里，要么就强制重跑。

## 「去授权」真的到得了权限中心（20:4x，标准 5 补强）

标准 5 要求「未开无障碍时…给出授权提示」。此前只见到横幅和按钮存在，没验证**点了
真的到得了**。设备在线时点了一次（坐标 (1070,429) 来自 `content-desc`，非目估），
权限中心页打开，内容比要求的更强：

- 顶部汇总 **「4/6 已就绪 / 缺少：无障碍、屏幕捕获」**——缺什么一眼可见；
- 六项各带状态灯与直达入口：所有文件访问 ✓、**无障碍服务 →「去开启」**、
  悬浮窗 ✓、通知 ✓、**屏幕捕获 →「启动」**、电池与后台运行 ✓；
- 每项都写清「缺它会怎样」：「缺它 PC 侧拿不到令牌，手机连不上」；
  「UI 自动化、点按、输入文字、无障碍截屏都靠它」；
  「省电策略冻结后台时，无障碍会掉线、助手与 PC 断连」；
- 提权代理单列为「**不算授权位**」，并如实写「PING 未应答（未提权，或 sidecar
  仍在启动中）」——与约束 2 一致，不把没就绪的说成就绪。

**中途修正一次错误预期**：我原以为「去授权」会跳系统设置页，查代码才发现设计是
`Navigator.push(PermissionCenterScreen)` 推 **App 内**权限中心（console_screen.dart
L497-499 注释：2026-11-15 收敛，所有授权位状态灯与直达入口集中一处，不再散跳）。
所以点完焦点仍留在本 App 是**正确行为**，不是没反应。

## 21/21 在设备当前构建上复跑通过（19:5x，三证据源一致）

在 versionCode 43（哈希 `B0CE13E2…`，即设备当时实际运行的构建）上重跑：

在 versionCode 43（哈希 `B0CE13E2…`，即设备当时实际运行的构建）上重跑：

```
=== per-command result: pass=21 fail=0 (of 21) ===
=== KHYCONSOLE execution log lines: 14 ===
  19:58:50.883 I KHYCONSOLE: origin=manual tool=read status=exec_error id=c-1794830330880-0
  19:59:17.430 I KHYCONSOLE: origin=manual tool=stat status=exec_error id=c-1794830357425-0
  19:59:43.236 I KHYCONSOLE: origin=manual tool=unzip status=exec_error id=c-1794830383233-0
```

**三个独立证据源同时成立**：

1. 驱动判定 21/21 PASS；
2. `KHYCONSOLE` 日志见证刷出 14 行（带 origin/tool/status/id）——守卫不再是真空信号；
3. 从共享历史独立复核：**一致 21/21**（历史 167 → 197 条，其中 21 条对应该轮命令且
   状态全部正确；多出的 9 条是重试重复，符合预期）。

三类失败的文案在明细里也逐一可见，且互不相同：

- `参数不合法：缺少参数「path」` / `未知参数「psth」（read 可用：path、max）` /
  `参数「cmd」应为 字符串，实际是 数字` / `op=set 时必须提供参数「text」` /
  `参数「mode」只能是 bypass / plan / edit / default`
- `工具不可用：未授权无障碍服务，ui_tap 无法执行`
- `执行报错：退出码 127，/system/bin/sh: zz_no_such_cmd_xyz: inaccessible or not found` /
  `FileNotFoundException: /no_such_file_xyz: open failed: ENOENT` /
  `zip 不存在：/no_such_file_xyz.zip` / `工具没有返回结果`

> 教训：共享设备 + 共享工作树的场景下，「装机哈希 = 交付副本」是个**时效性结论**，
> 任何一次别人的安装都会让它失效。要陈述这个事实，必须带上时间戳。

在等插 USB 的间隙预检 `khy_offline_test.sh`（② 要 push 到设备的那份），发现兜底
判断把「之前」和「之后」的行数**在同一时刻**读：

```sh
input tap $PLAY_X $PLAY_Y ...      # 点了
sleep 8
b=$(wc -l < $HIST 2>/dev/null)     # 点了之后才读"之前"
a=$(wc -l < $HIST 2>/dev/null)     # 同一时刻读"之后"
if [ "$b" = "$a" ]; then ...       # 恒真
```

后果：`b == a` 永远成立，「坐标点击已命中」那个分支是死代码，而 ENTER 兜底被
**无条件执行**——即使坐标点击已经成功，也会重跑一遍命令，证据里留下两条同名记录，
看着像「命令执行了两次」。已修：把 `b=` 前移到 tap 之前（现为 L77 读 b → L78 点
执行 → L80 读 a），并删掉原来那两个恒等的读取。

## ② 脚本预检：抓到一个会让证据翻倍的 bug（17:2x）

在等插 USB 的间隙预检 `khy_offline_test.sh`（② 要 push 到设备的那份），发现兜底
判断把「之前」和「之后」的行数**在同一时刻**读：

修复后复核：文件无 BOM、无 CR、0 个非 ASCII 字节（4770 B）——它要被 push 到设备
上由 toybox sh 解析，中文 Windows 上一次 CJK 往返就足以让解析器静默失败。

② 的其余安全设计也确认在位：`trap restore EXIT`（任何退出路径都恢复射频，含中途
被杀）、独立的 watchdog 脚本 200 秒后无条件恢复、共享历史缺失时不跑兜底而是明确报错。

> 同类教训今天还有一处：`khy_accept2.ps1` 的 ts 过滤器也是「看起来在过滤」
> （有 `-lt $runStartedAtMs` 比较），实则 `[int]` 溢出后恒真。**写了断言不等于
> 断言有效**，得让它在已知输入下真的分出对错。

## fake-adb 判定逻辑测试：三条断言全过（16:0x）

今天这条断言失败了三次，每次原因都不同，且三次都不是被测逻辑的错：

1. 驱动硬编码 adb 路径、不认 `KHY_ADB` → 假 adb 从未被用上；
2. 假 adb 的 pull 无视目标参数 → 驱动读到不存在的探针文件；
3. 驱动改用 `get-state` 探针后，假 adb 不认识这个子命令 → 探针返回空 → 判无设备。

三处都修完后（第三条是给假 adb 补 `get-state` 应答），结果：

```
PASS  harness reached khy_accept2.ps1 (positive control)
PASS  ts filter ignored the stale record (no false PASS)
PASS  fresh record was matched (verdict is WRONG STATUS, not NOT RECORDED)
DECISION LOGIC OK
```

驱动输出里的关键行：

```
[ 1/21] want=ok  {"tool":"ping"}  -> WRONG STATUS (want ok, got exec_error)
```

固件为 ping 备了一条**陈旧**的 `ok` 和一条**新鲜**的 `exec_error`。ts 过滤器
忽略陈旧那条、命中新鲜那条，于是报 WRONG STATUS 而非假 PASS——这正是该测试
要证明的核心命题。第 2-21 条报 NOT RECORDED 是预期的：固件只为 ping 准备了记录。

至此今天所有能自主执行的项目都已跑完并有实证。

**教训**：构建产物与交付副本之间只要隔着一次未锁定的复制，就可能漂移。
正确顺序是「构建完全结束 → 复制成交付副本 → 装交付副本 → 验证」，
不能把「装构建输出」当成「装交付物」。

### 附：设备掉线又恢复（15:4x）

mDNS 链路断过一次（`adb devices` 空，但 `adb mdns services` 仍在广播），
`adb connect 192.168.1.117:40497` 直连后恢复，设备以 **TCP 形态**回来了
（不再是 `adb-XXXX._adb-tls-connect._tcp`）。各脚本的 WiFi 防护对 TCP 形态
（`IP:PORT`）本来就认得好，所以这次恢复反而让防护更可靠。

见证脚本原先硬编码旧序列号，设备一换形态就「device not found」，
已改为探针动态选设备——与 `khy_accept2.ps1` 一致。
