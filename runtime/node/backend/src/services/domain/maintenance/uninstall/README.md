# uninstall — 卸载台账 / 计划 / 写入

D2 功能单元（`domain/maintenance/uninstall/`），三文件一条链：

- `installLedger.js` — 读「装了什么、装到哪」的安装台账（写入方经 `ledgerWriter.js`）；
- `uninstallPlan.js` — 由台账 + 当前 dataHome/默认位置解析出「要撤什么」的计划（孪生条目去重、
  pointerFile 兜底）；
- `ledgerWriter.js` — 台账的唯一写侧漏斗（`KHY_DATA_HOME` 注入的落盘位，原子写）。

## 谁要

`khy uninstall`（CLI handler `cli/handlers/uninstall.js`）与 `services/uninstall/index.js` 门面；
此外 mdEditorRegister / payloadProvisioner / runtimeProvisioner / resourceManager 四类安装/供给
动作都经 `ledgerWriter` 记一笔——卸载的完整性由「记了什么」决定，所以写侧必须有唯一漏斗。

## 为什么

卸载最怕「静默半撤」：台账缺项 → 计划漏项 → 残留。把台账读写与计划解析收进一个单元，
回滚计算（computeRollback）与去重语义集中可测。实测怪异点已钉在测试头注释：
unknown-action 记录会消耗去重名额；默认位置与解析位置同路径时 `*-default` 孪生静默去重；
写侧不校验 action 白名单（读侧才兜底）；`ts: 0` 不再被注入覆盖。

## 怎么验

`node --test` 显式列三份共置测试路径：installLedger 11 / ledgerWriter 7 / uninstallPlan 8，
合计 26 例 / 0 fail。ledgerWriter 全程 `KHY_DATA_HOME` 指临时目录（注意 opts.env 是整体替换
process.env，每个用例必须带 KHY_DATA_HOME）；installLedger/uninstallPlan 为纯叶子零桩。
