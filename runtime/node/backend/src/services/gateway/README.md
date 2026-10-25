# services/gateway — 网关单元

## 谁要

CLI 的 gateway 命令、HTTP 路由（/api/ai-gateway*）、交付面与 AI 后端。

## 为什么

所有「请求怎么发出去、发给谁、用哪条渠道」的决定都在这一层，避免同一个策略在 CLI、路由、后台各写一份。

## 里面有什么

- adapters/ —— 各上游协议适配器
- aiGateway*.js —— 生成、路由、冷却、失败解释
- delegationGate.js —— 外部委派审批闸（fail-closed）
- modelOperationality.js / modelEntryCollection.js —— 模型可用性与清单

## 怎么验

- `node --test src/services/gateway/*.test.js tests/gateway/ —— 网关测试`
- `node bin/khy.js gateway status —— 真链路自检`
- `npm run test:maintainer:gateway —— 网关最小回归（发布门引用）`

## 生命周期

本单元的 `khy.module.json` 记 `lifecycle.stage = staged`、`provenance = recorded-after-the-fact`：代码是直接写进核心域的，没有经过 `scripts/quarantine/` 缓冲区（判据见 `scripts/quarantine/README.md`）。单元内仍有源文件缺同名同目录测试，晋级三判据未齐，故不签 stable。
