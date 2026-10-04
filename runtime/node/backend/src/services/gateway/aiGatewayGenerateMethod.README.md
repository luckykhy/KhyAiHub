# aiGatewayGenerateMethod

网关统一生成入口的实现体。`aiGateway.js` 把「一次生成」的全部策略收在这里：通道选择与降级、
空闲看门狗与 idle-progress 判定（`gatewayIdleProgressPolicy`）、图片/视觉通道路径、
重试预算（与 `constants/retryBudget.js` 同批约束）、以及 MCP 工具调用取用的绑定。

## 实测规模与消费者（2026-09-28）

| 项 | 读数 | 取数方式 |
|---|---|---|
| 文件长度 | 6 577 行 | `wc -l src/services/gateway/aiGatewayGenerateMethod.js` |
| `src/` 内引用它的文件 | 24 个（含 `aiGateway.js`、`flagRegistry.js`、`cli/handlers/gateway.js`、各 adapter） | `grep -rln aiGatewayGenerateMethod src --include=*.js` |
| 导出面 | `AIGatewayGenerateMethod`、`setAiGatewayGenerateMethodDeps` | `Object.keys(require(...))` 实测 |

它是 `[RESEARCH-018]` §1.4 的热枢纽，也是架构轴上的**上帝文件**之一（>400 行上限，见
`ARCHITECTURE-POLICY.json` 的 legacy 台账）。本 README 只登记事实，不代表它已经可拆。

## 内部函数的可测性边界

`_callMcpVisionTool`、`_shouldResetIdleForProgress` 等**未导出**——外部只能经
`AIGatewayGenerateMethod` 整条回合驱动，而那条路需要网关凭据。因此本目录的同名测试
（`aiGatewayGenerateMethod.test.js`，2 tests / 2 pass / 0 fail，`node --test` 跑）**锁的是绑定**：
视觉通道 require 的目标必须真的提供 `callTool(serverName, toolName, args)`。
改前该绑定指向 `cli/handlers/mcp`（导出面只有 `handleMcp`），每次识图必然
`TypeError: mcp.callTool is not a function`，并被内层 catch 伪装成「识图失败」的上游原因。

未闭合：真正的「识图成功」回执需要一台已连接 `deepseek-eyes` MCP 服务器的机器跑一次带图请求
（本机探针止步于 `MCP server "deepseek-eyes" not found`，即已进到注册表层但无人 connect）。
台账见 `[DESIGN-LAY-008]` §12.6。
