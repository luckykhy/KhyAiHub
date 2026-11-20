# hiaoBridge — 第二个手机桥 profile（khy-os → hiao / phone-dsh）

> 三问格式：谁要它 / 为什么这么做 / 怎么验。协议口径真源：phone-dsh
> `docs/AMOO-INTEGRATION.md`（真机实测的接入文档）。

## 谁要它

`src/tools/HiaoBridgeTool/index.js` —— AI 可见的第二个手机入口。phone 单元
（StepBridge 8896）给的是「无治理的轻桥」；hiao 给的是**带治理的执行层**：
每次调用走 策略 → 租约 → 人工审批 → 审计哈希链，`/call` 的 confirm 级工具会
阻塞等人在手机审批卡上放行（上游 socket 600s，超时=拒绝）。

所以这个 profile 的价值不是「又一个桥」，而是：整任务委托（`agent_task`）、
审批面（`/approvals` + `/approve`）、审计回查（`/audit`）——这些 phone 单元没有。

## 为什么这么做

**方向与 phone 单元相同，协议不同。** PC 经 `adb forward tcp:0 tcp:8898` 打手机
回环 8898（`tcp:0` 让 adb 自选 PC 侧空闲端口并回填，端口占用不是失败）。令牌是
Bearer 配对令牌，真源在手机 `/sdcard/hiao/token.txt`（单点常量
`HIAO_BRIDGE_TOKEN_REMOTE_PATH`，env `KHY_HIAO_BRIDGE_TOKEN_PATH` 可覆盖）。

**为什么 660000ms 的 /call 超时不是「硬超时杀任务」。** 上游协议自身的审批截止是
socket 600s，超时即拒绝（AMOO-INTEGRATION.md:20）。`HIAO_BRIDGE_CALL_TIMEOUT_MS`
= 600s + 60s 余量，语义是**单次请求的 AbortSignal 中止**，不是长任务 kill；显式
配置低于 600s 时向上夹到 600s（比审批截止短的值不可能等到任何审批决定）。
审批超时与设备故障是**两个错误码**（`approval_timeout` vs `device_fault`），
不能互相顶替——把「没人批」报成「手机坏了」正是 RESEARCH-029 §5 点名禁止的。

**为什么未知工具一律按写操作走确认。** 手机端工具表随 hiao 版本变（`/status`
实时报），本地白名单只能是快路径：`HIAO_READONLY_TOOLS` 之外的名字（含没见过的）
一律要求 `confirm:true`，fail-closed。

**为什么不设 on/off 开关。** 契约口径：hiao 不设门，配置键全在
`constants/serviceDefaults.js` + env。能力由**配对令牌**结构性把关：没有令牌时
`readToken` 失败 → `hiao_not_paired`，一个请求都不发；工具本身照常注册，配对前
每次调用都给这条诚实答复，而不是消失成「不可见的能力」。加一个开关还得在
flagRegistry 登记一行，而那个文件属另一批——同一个开关不能有两个真源。

**为什么 adb/argv 全走 phone 门面取。** `resolveAdbExecutableProbed` /
`resolveDeviceSerial` / `buildAdbArgv` / `buildForwardArgv` /
`buildStatusReadArgv` / `buildLoopbackBaseUrl` / `redactSecrets` 的单一实现都在
`phone/`；本单元只写协议（路由、Bearer、审批分类），不复制 adb 管线。

**令牌是 R2 级机密。** `readToken()` 是唯一出现令牌的地方，内存缓存；所有对外
错误文案先过门面的 `redactSecrets`；结果体里永不回显令牌（测试逐条断言）。
401/403 时缓存会被清掉——否则「重新配对后重试」这句提示是假的：重试会继续用
内存里的旧令牌，只有重启进程才能恢复。

**失败归因的三条线。** `/call` 上我们自己的截止（660s）→ `approval_timeout`（最
可能是没人放行）；GET 面的截止（45s）→ `unreachable`（链路没回应，与审批无关，
文案不许出现 600s/放行，且同时说清「被拒」与「无响应」两种形态）；
`status>=500`/adb 失败 → `device_fault`。

**正文探测必须拼写宽容。** hiao 的机器码字段是下划线形（`approval_timeout`、
`lease_missing`），人读文案可能是中文（「审批超时」「缺少有效租约」），英文散文
才是空格形。只按英文词边界匹配会把前两种落进 `device_fault` / `hiao_deny`——
把治理拒绝报成设备故障，正是本单元存在的理由。同时词边界不能松到裸子串，
否则 `please` / `released` 会被当成缺租约。三种拼写各有测试钉住
（`hiaoBridgePolicy.test.js`、`hiaoBridgeClient.test.js`）。

## 本批不做（诚实边界）

| 不做 | 原因 |
|------|------|
| `GET /events`（SSE） | 长连接 + 三路事件流需要独立的生命周期与取消语义；本批只做请求-响应。没有它也能用 `/approvals` 轮询 |
| `/sdcard/hiao` 文件信箱 | 兜底通道；HTTP 不可用时它也需要 adb，而 adb 已断时同一条路走不通。写它会把「桥死了」伪装成「还有一条路」 |
| `POST /mcp`（tools/list、tools/call） | 直接把手机当 MCP 服务端消费是独立的一层（工具名映射、JSON-RPC 会话），需要单独的契约测试钉住，不与桥面混做 |
| 工具名清单 | `/status` 有的 hiao 版本只报数量；本单元如实返回 count，不把「数」装扮成「名」（名字要走 MCP tools/list） |

## 怎么验

从 `runtime/node/backend` 目录跑，**显式列文件路径**（传目录会得到假读数）：

```bash
node --test src/services/domain/network/phone/hiaoBridge/hiaoBridgeConfig.test.js \
            src/services/domain/network/phone/hiaoBridge/hiaoBridgePolicy.test.js \
            src/services/domain/network/phone/hiaoBridge/hiaoBridgeClient.test.js \
            src/services/domain/network/phone/hiaoBridge/index.test.js \
            src/tools/HiaoBridgeTool/index.test.js
```

全部测试注入假 `runAdb` / 假 `httpTransport`，**不连真机、不 spawn adb、不读设备
上的令牌文件**。真机验收（配对 → 审批放行 → verdict → `/audit` 回查）未做，
属独立批次。

## 晋级判据

staged → stable 三条（与 phone 单元同口径）：

1. 真机跑通一次完整链路：`ping` → `status` → 一次需要审批的 `call`（在手机上
   放行）→ `audit` 回查同一条记录；
2. 至少一个消费方在真实使用期里接线并观察（当前只有 HiaoBridgeTool，与本批同批落地）；
3. 晋升时把 `khy.module.json` 的 `lifecycle.stage` 改 `stable` 并在
   `_lifecycle_note` 写明上述实测日期。
