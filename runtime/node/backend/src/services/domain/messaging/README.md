# messaging — 消息渠道、MCP 与 iLink 协议面（D2）

业务上下文：`/msg`、`/wx`、`/feishu` 三个渠道命令与 `/mcp` 系列
（连接、列工具、调用、配置）背后的全部收发逻辑。

## 谁要（角色）

- **收 webhook 的人**：`routes/webhooks.js:72,89` 取 `channels/messageRouter.js`；
  HTTP 侧 `routes/wx.js:26-28`。
- **跑 `/mcp` 的人**：`constants/commandSchema.js:191` 声明（子命令 `:860`），
  处理器 `cli/handlers/mcp.js:25` 取 `mcp/mcpAddSpec.js`、`:29` 取 `mcp/mcpConfigStore.js`。
- **跑 `/msg` `/wx` `/feishu` 的人**：`commandSchema.js:146,147,148` →
  `cli/handlers/{msg,wx,feishu}.js`。
- **让模型调用 MCP 工具的人**：`services/tool/toolUseLoopCore.js:2008,2584`
  （自动连接与工具池）；`cli/tui/ink-components/App.js:535`（生态注册表）；
  定时任务 `services/cronScheduler.js:510` 与 `daemonEntry.js:213,284`。

## 为什么这么做

这一层同时存在**三种必须分开的东西**：外部协议（`mcp/mcpServerProtocol.js`、
`channels/ilinkProtocol.js`、`ilinkMessageCodec.js`、`ilinkCrypto.js` 是纯编解码与
协议常量）、本地态存储（`mcpConfigStore` / `oauthTokenStore` /
`ilink{Account,Binding,Cursor,Session}State` 各自管一份落盘）、以及发送与派发
（`msgSender` / `ilinkDispatcher` / `ilinkFileDelivery`）。把编解码与协议判定做成
纯叶子，是为了让「对端改了字段」这类故障能在不开网、不等回调的情况下断言——
`tests/services/messaging/ilinkCore.test.js` 就是这条边界的存在理由。
MCP 侧同理：`mcpAddSpec` / `mcpDisclosurePlan` / `mcpServeToolPolicy` 是纯计划函数，
真正的连接才在 `mcp/index.js` 的 `connectMCPServer / listMCPTools / callMCPTool`。

## 怎么验

```bash
cd services/backend
node --test tests/services/messaging/ilinkCore.test.js        # 20 tests / 20 pass / 0 fail
```
同族还有 `tests/services/{messaging,channels,mcp}/` 下的其余 node:test 文件；
jest 形态的走 `npm test`（本 shell 无 npm/npx，未在卡内复跑）。

## 已知缺陷（登记，不在本单元擅自修）

改动进行中：`channels/ilinkDispatchDiagnostics.js`、`channels/ilinkDispatcher.js`、
`channels/ilinkFileDelivery.js`、`messaging/ilinkLogin.js`、
`messaging/ilinkSendPolicy.js` 五个文件当前是 ` M`。本卡对 iLink 派发细节
**只登记文件名，不复述行为**，待作者落地后复核。
