# phone — 手机桥接单元（khy-os → StepBridge）

> 三问格式：谁要它 / 为什么这么做 / 怎么验。

## 谁要它

要把 khy-os 和手机上的 Amoo（阶跃智能体）接起来：khy-os 需要能探活、读状态、
调用手机侧能力，并在手机桥服务意外死掉时把它拉回来。使用方（按接入顺序）：

1. `src/tools/PhoneBridgeTool/index.js` — AI 可见的工具面（actions: ping/status/probe/call/revive/setup/tools）。
2. `src/cli/handlers/phone.js` — `khy phone …` 人可直接敲的命令面（解析与文案在同目录
   `phoneCliPlan.js` 纯叶子里，IO 仍在本单元）。
3. 任何需要「手机现在什么状态」的只读消费者 — 走 `probe()` 而不是自己去拼 adb。

## 为什么这么做

**方向是 OUTBOUND。** 本单元是 khy-os 主动打给手机，与 `src/bridge/*`（手机连进 PC、
JWT 鉴权）是相反方向。所以代码不挂进 `src/bridge/*`，只借用它的约定
（loopback 优先、token 鉴权、诚实的状态快照）。

**通道顺序是量出来的，不是设计出来的：**

| 顺序 | 通道 | 为什么在这个位置 |
|------|------|------------------|
| 1 | `adb connect`（仅设备列表为空时） | 33743 是 connect 端口不是 pairing 端口；跑 `adb pair` 会 protocol fault 且配不上任何东西。配对由用户在仓外一次性完成。 |
| 2 | `adb forward tcp:<local> tcp:<remote>` | 幂等，可反复跑。 |
| 3 | HTTP `POST /ping` `/status` `/call` | 每连接一线程，一个卡死的调用不影响其他调用。 |
| 4 | 文件信箱 `/sdcard/bridge-amoobridge/cmd_<id>.json` | 兜底。worker 是**单线程顺序处理**，一个卡死的 exec 会冻结后面全部 cmd_，所以只在 HTTP 死了才走，且绝不通过它跑可能挂起的命令。 |

**两个与任务简报不一致、按实机测得值修正的事实**（本单元的默认值以此为据）：

- 端口是 **8896**，不是简报写的 8898。`HttpBridge.DEFAULT_PORT = 8896`，
  MainActivity 帮助文本也写 `127.0.0.1:8896`。8898 属于未发布的完整版。
- 信箱目录是 **`/sdcard/bridge-amoobridge`**，不是 `/sdcard/bridge`。
  `BridgeService.BRIDGE_DIR` 就是前者；往后者写文件会静默什么也不发生。

**装机的是 lite 构建，README 的工具表对这个产物是虚构的。** README 自述
「上传的是 1.x 版本，2.0 以后的还没有压测完」。实测：22 个工具、**零个 UI 工具**、
manifest 里没有任何 `BIND_ACCESSIBILITY_SERVICE`，
`res/xml/accessibility_config.xml` 指向的 `com.step.bridge.MainActivity` 在本包不存在。
所以 `phoneBridgeCatalog` 把工具表劈成两半：`BRIDGE_TOOLS`（lite 真能答的 22 个）
与 `UI_TOOLS`（完整版才会有的 10 个，只为把能力缺口说成「需要无障碍」而不是
「unknown tool」）。**UI 自动化这条路在当前 APK 上走不通**，要打通 khy-os↔Amoo
的界面操作，必须由用户提供完整的 2.x APK。

**服务自恢复不可依赖。** force-stop 之后服务不会自己回来：WatchdogReceiver 是
`exported=false` + `setInexactRepeating`（Doze 下被批掉），BridgeJobService 周期 15 分钟。
`am start` 会被 AMS 过期的 top-most 记录吞掉并给出误导性成功信息，`am start-service`
因 `exported=false` 被拒。唯一实测可行的恢复是
`adb shell monkey -p com.stepx.amoobridge -c android.intent.category.LAUNCHER 1`，
本单元把它封成 `revive()`，并在文档里写明「进程其实已经死了」的那种假成功长什么样。

**exec 的超时基本无效。** 桥的实现先把 stdout 读到 EOF 才进退出轮询，
`sleep 300` 这类保持 stdout 打开但不输出的命令会让 `readLine` 永久阻塞，
1..120s 超时永不触发。这一条同时是信箱兜底最大的风险源。

**token 是单一精确串。** 服务端比对 `("Bearer " + token).equals(auth)`——
大小写敏感、恰好一个空格。token 是 16 随机字节的 hex（32 字符），
落盘在 `/sdcard/bridge-amoobridge/token.txt`。实测它在 force-stop + 重启后不变
（因为 MANAGE_EXTERNAL_STORAGE 已授权、目录可写），只有重装 APK 才需要重取。
R2：token 运行时读取、内存缓存、绝不落仓、绝不进日志、绝不出现在任何返回值里。

**loopback URL 刻意不过 SSRF 守卫。** `services/urlSafety.js
assertPublicHttpUrlResolved` 按设计拒绝 loopback/private 字面量——它保护的是
「打向公网主机」的出站调用，而这里是通过 adb 隧道打用户自己的设备。
文件头已注明这个例外。

## 怎么验

从 `runtime/node/backend` 目录跑，**显式列文件路径**（传目录会得到假读数）：

```bash
node --test src/services/domain/network/phone/phoneBridgeCatalog.test.js \
            src/services/domain/network/phone/phoneBridgeConfig.test.js \
            src/services/domain/network/phone/phoneBridgePolicy.test.js \
            src/services/domain/network/phone/phoneBridgeMailbox.test.js \
            src/services/domain/network/phone/phoneBridgeClient.test.js \
            src/services/domain/network/phone/phoneCliPlan.test.js \
            src/services/domain/network/phone/index.test.js
```

全部用 mock：stub 掉 `child_process.spawn` 与 HTTP transport，**不打真手机**。
覆盖 token 获取与形状校验、HTTP 请求拼装、信箱兜底切换、确认门、命令行解析与
文案渲染（含令牌回显脱敏）、以及每条错误路径。

三个 CI 守卫（在仓库根跑，untracked 新叶子要显式传路径）：

```bash
node scripts/ci/check-change-safety.js --changed
node scripts/ci/check-agent-rules.js --changed
node scripts/ci/check-repo-layout.js
```

命令行面（需要 adb 能找到，`KHY_PHONE_BRIDGE_ADB` 可指到绝对路径）：

```bash
node runtime/node/backend/bin/khy.js phone status      # 设备/转发/桥/令牌一览
node runtime/node/backend/bin/khy.js phone tools       # 22 个可调用工具 + 10 个不可用 UI 工具
node runtime/node/backend/bin/khy.js phone call battery
node runtime/node/backend/bin/khy.js phone setup       # 装机后授权清单（只列不执行）
```

真机冒烟（需要手机在线，不属于单测）：

```bash
adb connect 192.168.2.46:33743
adb -s 192.168.2.46:33743 forward tcp:8896 tcp:8896
curl -s -X POST http://127.0.0.1:8896/ping -H "Authorization: Bearer <token>"
```
