# security — 权限策略、失效兜底、韧性、数据主权与红队训练（D2）

业务上下文：`/permissions`、`/sandbox-toggle`、`security_scan` 工具，
以及每一次模型输出都要过的兜底（failsafe）、韧性回退（resilience）与
红队演练（redpass / adversarial）。

## 谁要（角色）

- **`/permissions`**：`cli/routerDispatchTail.js:750`（case `'permissions'`），
  经壳 `services/permissionPolicy/index.js` 取本目录。
- **`/sandbox-toggle`**：`constants/commandSchema.js:1073-1078`（category security）。
- **TUI 的红队与主权链**：`cli/tui/hooks/useQueryBridge.js:1348,1373,1488,3628`、
  `cli/tui/ink-components/App.js:3449,5288,5299`。
- **代码扫描工具**：`tools/securityScan.js:38,393`；
  `services/securityGuardService.js:536`；`services/cliErrorDescriptor.js:31`
  取 `failsafe` 错误码；`permissions/patternMatcher.js:123`。
- **韧性回退**：`services/domain/maintenance/selfHeal/fallbackTree.js:77`
  经壳 `services/resilience`。

## 为什么这么做

安全件的失效模式是「判级与执行分离，改了文案以为改了策略」，所以每条链都要求
**判据可点名、执行可拦截**（规则 10 A2-4）：
`permissionPolicy/{config,matchers,index}` 提供 `evaluate` / `addPathRule` /
`addUrlRule` 与 glob→正则的匹配（`globToRegExp` 的红队样本另见
`tests/globDoublestarAnchor.test.js`，那是「双星锚点」这类误放过的锁）；
`failsafe/` 把上游异常归成有限错误码（`ERROR_CODES` / `classify` /
`SafeResponseWrapper` / `StreamFailSafeInjector`），直接服务规则 2.2 的
「问题 + 识别码 + 修复建议」；`resilience/` 管预算与回退
（`BudgetAwareExecutor` / `FallbackTreeBuilder` / `DeadLoopDetector` /
`SalvageProtector` / `MAX_FALLBACK_DEPTH`）；`marshal/capabilityVector` 是纯向量判级；
`dataSovereignty/` 处理幽灵值污染（`GhostValueAnnotator` / `ConflictQuencher`）；
`adversarial/` 与 `redpass/` 是攻击面训练（`attackVectors` 的 VECTORS 表、
`survivalCriteria` 的不变量、`redpassEngine` 的覆盖率报告与拒绝检测）。

## 怎么验

```bash
cd services/backend
node --test tests/services/failsafe/failsafe.test.js             # 35 tests / 35 pass / 0 fail
node --test tests/services/resilience/resilience.test.js         # 23 tests / 23 pass / 0 fail
```
同族（node:test，本卡未逐条复跑）：
`tests/services/marshal/capabilityVector.test.js`、
`tests/services/dataSovereignty/dataSovereignty.test.js`、
`tests/services/adversarial/adversarialEngine.test.js`、
`tests/globDoublestarAnchor.test.js`、`tests/hookContribSeams.test.js`。
`tests/services/permissionPolicy/permissionPolicy.test.js` 是 jest 形态，
**本便携安装的 jest 跑不起来**（见 已知缺陷 2）。

## 已知缺陷（登记，不在本单元擅自修）

1. `security/skillLedger/index.js` 的对外五个动作（`certifySkill / verifySkill /
   listCertifiedSkills / getAuditTrail / initKeys`）除自身壳
   `services/security/index.js:6` 外**未发现消费者**；同时 `redpass/` 5 个文件与
   `failsafe/classifierSignals.js` 无同名测试。删/接需人裁决（规则 7）。
2. 在做中改动：`adversarial/attackVectors.js`、`redpass/redpassPrompts.js`（均 ` M`）。
3. 本机 jest 渠道不可用：`services/backend/node_modules/.bin/jest` 执行即
   MODULE_NOT_FOUND（`jest-cli` 未落盘），故所有 jest 形态套件在此机器无执行渠道。
   这是环境事实，不是判据结论；修法是补装依赖，属独立改动集。
