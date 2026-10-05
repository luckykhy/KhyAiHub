# data — 数据落点、资源安装、逆向工程与上游研读（D2）

子上下文：`data`（DataLocation）/ `resources` / `reverseEngineer` / `upstreamStudy`。
17 个文件，纯叶子四个：`asarArchive` / `formatRegistry` / `stringHarvester` /
`reconstructionPort`（+ `resourceTask` 走注入）。

## 谁要（角色）

- **管离线资源的人**：`khy resource <status|list|fetch|prefetch|verify|rollback|gc|path>`
  （`constants/commandSchema.js:101`、`:535`）→ `cli/handlers/resource.js:4,33`。
- **给运行时装东西**：`services/runtimeProvisioner.js:349,358`。
- **模型侧工具**：`tools/unpackTool.js:7,272`；
  `tools/reverseEngineer.js:74`（经壳 `services/reverseEngineer/index.js:9`）；
  `tools/UpstreamStudyTool/index.js:17`（经壳 `services/upstreamStudy/index.js:4`），
  另有 `services/upstreamStudyPlan.js`。
- 注：`delivery/channel/khyquant/tools/{unpackTool.js:232,305,reverseEngineer.js:45}`
  指向 software 本地副本，属独立项目 khyquant 的分发载体，不算本目录消费者。

## 为什么这么做

「拿到一个不明包并恢复出可读源码」这条链每一步都可能失败在不同层面，
所以按判据/动作分文件而不是按流程分：`formatRegistry.js` 是**格式与可恢复性表**
（`RECOVERABILITY` / `FORMATS` / `EMBEDDED_MARKERS` / `candidateTools`），
`artifactScanner.js` 负责识别（`_disambiguateCafebabe` 这种字节级歧义消解单独成函数），
`asarArchive.js` 是纯解析（`parseHeaderSize` / `flattenEntries`），
`stringHarvester.js` 只做抽取与工具链指纹归类（`TOOLCHAIN_FINGERPRINTS`），
`sourceRecoverer.js` 管安全落盘（`_isSafeEntry` / `_isWithinDest` 防路径穿越），
`genericExtractor.js` 决定用哪个解压器与包管理器命令，`toolOrchestrator.js` 探活与
装配计划（`recommendInstall`、`TOOL_TIMEOUT_MS`），
`verificationLedger.js` 出可复核清单（`buildManifest` / `verify`）。
最后这个是「怎么验」的机器版本：逆向结果不留台账就无法复现。
`data/DataLocation.js` 单独存在是因为老数据家迁移（`hasLegacyData` /
`migrateIfNeeded` / `markMigrationComplete`）是一次性动作，不能混进资源管理。

## 怎么验

```bash
cd services/backend
node --test tests/services/reverseEngineer/reverseEngineer.test.js   # 45 tests / 45 pass / 0 fail
```
同目录 `asarArchive.test.js`（node:test）；`tests/services/resources/*.test.js`
是 jest 形态（本机渠道不可用）；`tests/tools/unpackGeneric.test.js`、
`tests/upstreamStudy.test.js` 本卡未复跑。

## 已知缺陷（登记，需人裁决）

`data/DataLocation.js` 在代码里**零消费者**（只有
`tests/services/dataLocationRemedyResolve.test.js` 按路径读它）。
迁移逻辑是否已作废、还是留给老安装升级路径，本卡不下结论；
删除属规则 7，需先查文档背书。
