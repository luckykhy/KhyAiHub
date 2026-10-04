# gateway-stuff — 网关日志租界：噪声翻译与来源归因（D2）

业务上下文：AI 管理服务器启动时装上的**进程级日志治理**——把底层库/适配器的
英文与噪声日志翻译成面向用户的中文状态，并把每条输出归因到「哪个适配器、
哪种调用模式」，同时守住后台任务不污染前台。

## 谁要（角色）

- **管理服务器进程本身**：`services/aiManagementServer.js:3528` 的
  `require('./gatewayLogLease').install()`——这是全仓**唯一**生产调用点。
- **状态可见性契约的消费方**：`cli/handlers/trace.js:14` 只在注释里引用其契约
  （不 require）；壳 `services/gatewayLogLease/index.js:4` 再导出本目录。
- **测试**：`tests/services/gatewayLogLease/gatewayLogLease.test.js:19-23`、
  `wiring.test.js:24`。

## 为什么这么做

「日志治理」这件事天然三份职责，混在一起会互相掩盖：
`logLease.js` 只做**租界决策**（`decide` / `CHANNELS`，纯函数）；
`noiseFilter.js` 只做**翻译与净化**（`translate` / `sanitize` / `sanitizeForStatus`，
规则表 `RULES` + `ADAPTER_TOKENS`，纯函数）；
`context.js`（`async_hooks`）与 `sandbox.js` 负责**归因与拦截**
（`runWith` / `current` / `isStatusQuery` / `isSandbox` / `runForAdapter` /
`guardBackground`），`devLog.js` 是唯一碰 `fs` 的环形缓冲。
拆开的收益是：一条中文状态文案错在哪、某个适配器为何没被归因，各自只有一处可查。
没有 slash 命令是**有意的**——它不是功能入口，是进程护栏。

## 怎么验

```bash
cd services/backend
node --test tests/services/gatewayLogLease/gatewayLogLease.test.js
```
**当前实测（2026-09-28，原样记录）**：22 tests / **16 pass / 6 fail** / 0 skipped。
本卡采集到的前 4 条红用例名均为「原始日志 → 面向用户中文状态」的翻译断言
（「Token 刷新失败 → 模型服务正在切换」「本地依赖不完整 → 正在尝试其他方式获取」
「API 400 → 当前模型响应异常，正在自动修复」「requires puppeteer → 正在降级到轻量模式」），
其余 2 条未采集；`gatewayLogLease/noiseFilter.js` 正是翻译表所在文件，此刻是 ` M`
（作者在做中的改动）。本卡**不下病因结论**，只登记「红点落在脏文件所辖的翻译侧」
这一观察。
`wiring.test.js` 是 jest 形态（正式入口 `npm test`，本 shell 无 npm/npx 未复跑）。

## 已知缺陷（登记，不在本单元擅自修）

1. 上面那 6 条红：需要作者 `noiseFilter.js` 改动落地后复跑同一命令复核。
2. 本目录零测试共置（`test-colocated` 逐文件点名，6 个源文件全中）。
