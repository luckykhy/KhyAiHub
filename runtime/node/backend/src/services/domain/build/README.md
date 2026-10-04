# build — 编译、forge 与仓库地图（D2）

子上下文：`compile` / `forge` / `repoMap`。业务入口是 `khy forge` 系列与
模型的 `buildProject` / `compileFile` / `executeCode` / `forgeCodeSearch` 四个工具。

## 谁要（角色）

- **跑 `forge` 的人**：`cli/handlers/forge.js` require `domain/build`，
  壳 `services/forge/index.js`。
- **模型侧**：`tools/buildProject.js`、`tools/compileFile.js`、
  `tools/executeCode.js`、`tools/forgeCodeSearch.js`。
- **仓库体检**：`services/repoDisciplineRisk.js` 与壳 `services/repoMap/index.js`
  取 `repoMap/`——治理规则里的「god-file / 重复模块」读数从这里出。

## 为什么这么做

`compile` 与 `forge` 是两个失败域：前者是「把这份源码变成可运行物」
（编译器/打包器探活、参数拼装、产物落点），后者是「在项目里造一个新能力」
（脚手架 + 检索）。把它们放同一目录是因为**都要 builder 工具链**，
而工具链的获取必须走依赖真源——`khyosBuilderProvisioner` 就是这条链的
装配单点（ Provisioner 决定装哪个、装到哪、缺了怎么办），
所以它的测试同时是给 `tools/buildProject.js` 兜底的那根尺。
产物落点不在本目录定义，由 `[DESIGN-LAY-004]` 的
`entries/<producer>` 与 `BUILD-OUTPUTS.json` 管（`check:build-root` 执行）。

## 怎么验

```bash
cd services/backend
node --test tests/khyosBuilderProvisioner.test.js                # 20 tests / 20 pass / 0 fail
```
**登记一条实测事实**：同目录的 `tests/khyosBuild.test.js`（node:test 形态）
在本次尝试执行时**超过 10 分钟未返回**而被中止（本机便携 Node v22.18.0）。
它很可能真的在跑构建/下载，因此本卡**不把它列为验收命令**，也不判它是死循环——
「慢」与「挂」的区分要按规则 3 用活动超时来量，需独立改动集处理。

## 已知缺陷（登记，不在本单元擅自修）

`tests/khyosBuild.test.js` 在本机无可用读数（见上）；
`tests/esbuildConfig.test.js` 是 jest 形态，本机 jest 渠道不可用。
