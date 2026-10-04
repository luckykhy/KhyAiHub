# network — 远端执行、代理、外部应用接入与依赖装配（D2）

业务上下文：`khy remote`（hosts/connect/exec/sessions）、`remotedev`、`proxy`，
以及「这条命令缺依赖时怎么装、装哪、能不能修」与「更新从哪个渠道来」。

## 谁要（角色）

- **操作远端机器的人**：`constants/commandSchema.js:161` 的 `remote`
  （子命令 `:807`）与 `:162` 的 `remotedev` → `cli/handlers/remote.js:79`
  取 `remotedev/remoteDevService.js`、`:103` 读会话指针；`cli/handlers/remotedev.js:19`。
- **让模型自己补依赖的人**：`tools/reverseEngineer.js:94` 与
  `services/dependencyInventory.js:24`（resolver）；工具侧
  `tools/compileFile.js:98`、`tools/executeCode.js:114`、
  `tools/WebBrowserTool/index.js:243`、`tools/deploy.js:111`。
- **配代理/接入外部应用的人**：`commandSchema.js:55` 的 `proxy` →
  `cli/handlers/proxyCoreInstallHandler.js:26`；
  `tools/ImportExternalAppModels/index.js:30`。
- **更新链**：`services/updateCoordinator.js:432`（实测：
  `require('./domain/network/updateAdapters/portableAdapter')`）、
  `updateChannelRouter.js:191`。治理侧 `scripts/ci/check-delegation-boundary.js:57`
  引用 `externalApps` 路径。

## 为什么这么做

「装东西」与「连东西」是两个故障域，混在一起时错误信息无法归因，所以分成
`dependency/`（`probe / ensure / detectFromError / buildInstallPlan / heal`，
外加 `MissingDependencyError` 与 `summarizeForAgent`——最后这个是给模型读的
结构化摘要）、`remote/`（SSH 配置、凭据守卫、执行与文件传输、状态持久化）、
`remotedev/`（会话指针与设备侧）、`proxy/`、`externalApps/`（逐厂商适配器）、
`updateAdapters/`（便携版与包管理器版两条更新路）六个子上下文。
纯叶子刻意留在判定侧：`dependency/registry.js`、`toolchainVersions.js`、
`externalApps/tomlLite.js` 与 `remote/remoteWorkspaceResolver.js`、
`remoteStateSyncService.js`、`windowsSwapScript.js`——
安装计划、版本可选集、远端路径解析这三件事必须能在不 SSH、不 spawn 的机器上复算。

## 怎么验

```bash
cd services/backend
node --test tests/services/dependency/dependencyHealing.test.js   # 43 tests / 43 pass / 0 fail
```
`tests/services/remoteExecService.liveExec.test.js` 是 jest 形态（`jest.mock('child_process')`，
正式入口 `npm test`；本 shell 无 npm/npx，未在卡内复跑）。

## 已知缺陷（登记，不在本单元擅自修）

本目录当前**无** ` M`/`A ` 文件（是少数干净上下文），但 43 个源文件
全部没有共置测试——`check:layout --list=functional-unit` 逐文件点名。
