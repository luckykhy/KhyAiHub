# deploy — 部署、发布打包与 PR 订阅（D2）

子上下文：`deploy` / `publish` / `subscribePr`。业务入口 `khy deploy`、
`khy publish`（别名 发布/打包）、`/subscribe-pr`。

## 谁要（角色）

- **`khy deploy`**：`constants/commandSchema.js:116`（`:591`、`:1783`）→
  `cli/handlers/deploy.js:42` 取 `deploy/deployLedger`。
- **`khy publish`**：`commandSchema.js:111`、`:769`、`:1681`；
  中文别名在 `cli/aliases.js:377-401`；处理器 `cli/handlers/publish.js:113-156`
  ——它一次取本目录 `publish/` 的全部五个文件。
- **`/subscribe-pr`**：`commandSchema.js:250`、`:1861`，派发
  `cli/routerDispatchSlash.js:279-281` → `cli/handlers/subscribePr.js:19-20`。
- **别处的复用**：`services/gitignoreService.js:61` 与
  `domain/project/projectBlueprint/index.js:35` 取 `deploy/projectDetector`；
  `domain/network/remote/index.js:438` 取 `publish/dockerBundleBuilder`。

## 为什么这么做

`deploy/*` 五个文件全部走**依赖注入**（`defaultDeps` 里懒 require `fs` /
`child_process`：`index.js:23-24`、`runners.js:19-20`、`projectDetector.js:38`、
`syncEngine.js:19`、`deployLedger.js:31`）。这不是风格偏好：部署器最容易犯的错是
「在模块加载时就假设自己能跑 git/docker」，注入 + 懒 require 让
`parseCommandOverride`、`shouldExclude`、`listReconciled` 这些判定可以在没装
docker 的机器上被测。台账单点 `deployLedger` 提供 `upsert / listReconciled`，
对应 `[DESIGN-DEPLOY-001]` 的「部署要对账，不能只报成功」。
`publish/` 是**产物组装**，`subscribePr/` 里 `subscribePrPlan.js` 的头部（`:7`）
把自己钉死成「不读 `process.env`、不碰文件、不开网络、不调 `Date`」的纯计划——
因为它产出的通知文案必须可复算，`decideNotify` 一旦读时钟，测试就成了看运气。

## 怎么验

```bash
cd services/backend
node --test tests/services/subscribePr/subscribePrPlan.test.js    # 28 tests / 28 pass / 0 fail
node --test tests/deploy.ledger.test.js                            # 7 tests / 7 pass / 0 fail
```
`publish/` 那五个文件的测试（`tests/services/publishUtils.test.js`、
`publishProjectState`、`publishDockerBundleBuilder`、`publishBundleArtifacts`、
`tests/cli/publishDispatch.test.js`）**全是 jest 形态**，本机 jest 渠道不可用——
即「发布打包链」在本机没有可执行的回归渠道，这是真实盲区。

## 已知缺陷（登记，不在本单元擅自修）

1. `publish/{bundleArtifacts,bundleCommon,dockerBundleBuilder,projectState,
   publishUtils}.js` 五个文件当前是 `A `（已入索引、尚未提交的新增），
   `subscribePr/subscribePrPlan.js` 是 ` M`。本卡对这六个文件的内部行为
   **只登记状态，不复述细节**。
2. 上面第 2 条盲区：publish 链在本机无测试执行渠道。
3. 任务面棘轮已接近上限（命令 245 / 别名 591 / handler 155），
   本单元新增入口前须先读 `[DESIGN-DELIV-002]` §4。
