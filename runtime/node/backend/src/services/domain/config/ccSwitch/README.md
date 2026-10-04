# ccSwitch — 供应商卡片切换与本地代理路由

D2 业务上下文里的一个功能单元：CC-Switch 式的「供应商卡片」注册表 + 活跃卡片到本地代理的路由 +
写入器（Codex / 应用配置）+ 连通性规格 + 用量与计价扫描。11 个源文件全部有同名同目录的共置测试
（**206 例 / 0 fail**，2026-09-29 本道显式路径复跑；`grep -c KNOWN-DEFECT` 实测 **56** 处钉住）。

## 各文件的职责（取自各文件头注释）

| 文件 | 角色 |
|---|---|
| `store.js` | CC-Switch 风格的 provider-card 注册表（落盘真源） |
| `routeResolver.js` | 活跃卡片 → 本地代理的路由 |
| `promptGuard.js` | 恢复时保护非受管的 prompt 文件（CC Switch #6810 语义） |
| `apiHandlers.js` / `connectivity.js` | HTTP 面处理与连通性规格消费 |
| `appWriters.js` / `codexWriter.js` / `proxyAccess.js` | 应用侧配置写入与代理接入 |
| `constants.js` / `opencodeGoQuota.js` / `usageScan.js` | 协议/别名常量、OpenCode Go 配额、用量与计价扫描 |

## 谁在用本单元（非测试外部消费者 4 个）

`cli/handlers/ccSwitch.js`（CLI/TUI 主交互面）、`routes/ccSwitch.js`（HTTP 面）、
`services/ccSwitch/index.js`（D1 历史路径再导出壳）、`services/crossAgentTasteLearner.js`。

## 出域边（如实登记，不写白名单把它合法化）

- **D2 内 11 处**、**D3 共 9 处**（`utils/` 与 `constants/`）—— 名义边界内合法。
- **D1 共 6 处**，逐条如下：`appWriters.js:355` → `services/gateway/adapters/codexAdapter.js`、
  `connectivity.js:15` → `services/gateway/providerConnectivitySpec.js`、`store.js:41` → `services/configGuard.js`、
  `store.js:44` → `services/apiKeyPool.js`、`usageScan.js:382` → `services/tokenUsageService.js`、
  `usageScan.js:449` → `services/tokenPricing.js`。
  D2 的名义 `mayDependOn` 只有 `["D2","D3"]` ⇒ 这 6 条全是 `declared_not_enforced` 的 D2→D1，
  交 `archDebtScan` R1 / `cross-layer-require` 棘轮管辖；它们同时是 `[DESIGN-LAY-008]` §12.43 里
  Q2 的直接对象（本单元是本仓 D2→D1 出边最密集的一处）。

## 已知缺陷

56 处 `KNOWN-DEFECT` 断言（含 §12.42 记过的 `routeResolver.js:34` `case PROTOCOLS.CODEX:` 实为
`case undefined:`、`store` 的 null patch 降级、`getAgentMode` 非法值静默回落成 proxy 等）。
一律登记不修：每一条都改变对外可见的路由或配额读数，属行为变更。
