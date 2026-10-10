# maintenance — 自修、认领、进化与卸载的机制层（D2）

业务上下文：`maintain`、`autofix-pr`、`claim-main`、`evolve`、`uninstall`
五个入口背后的判定与台账，以及 agent 回路里的自愈（selfHeal / selfRepair）。

## 谁要（角色）

- **跑 `maintain` 的人**：规范名由 `cli/aliases.js:210` 定，处理器
  `cli/handlers/maintain.js:106`；`evolve` / `evolution` 在
  `constants/commandSchema.js:172`，派发 `cli/routerDispatchTail.js:2019`。
- **`autofix-pr` / `claim-main`**：`commandSchema.js:247,248` →
  `cli/handlers/autofixPr.js:20`（计划取自 `autofixPr/autofixPrPlan.js`）；
  认领状态由 `claimMain/claimMainStore.js` 落盘（租约机制见 `[DESIGN-ARCH-118]`）。
- **卸载**：`commandSchema.js:121` → `cli/handlers/uninstall.js:138`，
  目标清单来自纯叶子 `uninstall/uninstallPlan.js`。
- **agent 回路自愈**：`services/tool/toolCalling.js:1374`（selfHeal）、
  `:2637`（frictionBridge）、`services/sourceHealService.js:33`。

## 为什么这么做

这类机制最容易长成「谁也说不清它为什么动了我的仓库」，所以每个子上下文都拆成
**纯计划 + 有壳执行 + 可核台账**三段：`auditFixLoop/{auditParser,promptBuilder,triggerGate}`、
`autofixPr/autofixPrPlan`、`claimMain/claimMainPlan`、`evoEngine/{evoLevels,evoRequirement}`、
`uninstall/uninstallPlan`、`selfHeal/{diagnosisDictionary,fallbackTree}` 全是可单测的
纯函数；写盘的一头只有 `claimMainStore`、`evoLedger`、`ledgerWriter`、
`orphanSweep`、`autoTestScaffolder` 等少数文件；台账侧
`uninstall` 提供 `isLedgerEnabled / ledgerPath / recordSideEffect / computeRollback`，
`selfRepair` 提供 `runRepairTransaction`（事务式，失败可回滚）。
进化（evoEngine）另带 `EvoTrustBreaker` 与 `OrganogenesisSandbox`——
自改代码的机制必须先有熔断与沙箱，这与规则 8「新机制不得直进 S3」是同一立场。

## 怎么验

```bash
cd services/backend
node --test tests/services/selfHeal/selfHeal.test.js           # 26 tests / 26 pass / 0 fail
node --test tests/auditFixLoop.test.js                          # 28 tests / 28 pass / 0 fail
node --test tests/services/uninstallPlan.test.js                # 12 tests / 9 pass / 3 fail
```
第三条**当前是红的**，原样记录：红的三条是
「默认位置：三大数据家 + 运行时 + 别名 + 指针均在清单」（断言串 `'~/.khy'`）、
「去重：默认位置与解析器位置一致时不重复」、
「env 覆盖的数据家（`KHY_DATA_HOME` 指到别处）单列出来」。
三条都在**数据家路径的展开**上——本仓工作在 Windows 便携根，`~` 与 POSIX 家目录
展开不同。是判据本身平台依赖，还是本机数据家布局变了，需按规则 5 立独立改动集，
本卡只登记读数与位置，不下结论。

## 已知缺陷（登记，不在本单元擅自修）

1. 上述 3 条红（`uninstall/uninstallPlan.js` 本身当前干净）。
2. 在做中改动的文件：`auditFixLoop/index.js`、`autofixPr/autofixPrPlan.js`、
   `claimMain/claimMainPlan.js`、`selfSustainingInfra/autoTestScaffolder.js`（均 ` M`）。
