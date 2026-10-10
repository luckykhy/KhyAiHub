# account — 账号池与 tokenless 压缩的两块业务逻辑（D2）

业务上下文：`khy pool`（别名 `nir` / `nrv`）背后的**凭据池**逻辑，以及一组**纯函数**的
上下文压缩叶子（`tokenless/`：schema / 工具输出压缩与 toon 编解码）。

## 谁要（角色）

- **跑 `khy pool` 的人**：命令声明在 `constants/commandSchema.js:54`（子命令 `:303`），
  处理器 `cli/handlers/pool.js:21`；`nir` / `nrv` 在 `cli/aliases.js:295` 展开成
  `pool import nirvana`。
- **三个代码消费者**：`services/accountPool.js:39,58,1381`（池主体）、
  `tools/ConfigureModelProvider/index.js:22`（配模型时取池）、
  `services/localBrainProviderConfig.js:138`（本地大脑取凭据）。

## 为什么这么做

池这件事天然是**两半**：一半必须碰盘（`accountPool/candidateDetect.js` 扫各家 CLI 的
凭据文件、`poolImporter.js` 导入、`poolSync.js` 回写），另一半是纯判定
（`credentialHelpers.js` 的 `normalizePoolType` / `maskToken` / `tokenHash` / `isValidEmail`、
`poolScheduler.js` 的轮换选择）。本目录把这条线切开：`poolScheduler.js` 是
**零 require 的 DI 工厂**（`createPoolScheduler(deps)`），IO 由 `accountPool.js` 注入，
所以「哪一个账号该被轮换」这种判定能在不开盘、不联网的情况下断言。
`tokenless/` 七个文件全部纯函数（只互相 require 加 `utils/simpleTokenEstimate`），
同理——压缩比与截断行为必须可离线复算。

## 怎么验

```bash
cd services/backend
node --test tests/services/accountPool/candidateDetectLeaf.test.js   # 9 pass / 0 fail
node --test tests/toonDecodeDepthCap.test.js                          # 7 pass / 0 fail
node --test tests/services/accountPoolCredentialHelpers.test.js       # see note below
```
第三条是 **jest 形态**的测试文件（`tests/services/accountPoolCredentialHelpers.test.js`
用 `describe`/`it`），在便携 Node 下 `node --test` 直接跑会因缺 `describe` 而失败，
正式入口是 `npm test`（`services/backend/jest.config.js`）。本 README 记录命令时
只保证前两条在当前 shell 可直接执行；第三条给出的是它的真实执行渠道，不是转述。

```bash
cd D:/Portable/khy-os
node scripts/ci/check-repo-layout.js --list=functional-unit   # 本目录缺件读数
```

## 已知缺陷（登记，不在本单元擅自修）

`tokenless/` 目前**只有**一个壳在消费它：`services/tokenless/index.js:4`。
在 `services/backend/src` 全量搜 `tokenlessPlugin` 的 gateway / CLI 接线点 →
**零命中**。也就是说这套压缩叶子写完了但没接进任何请求路径。删除它属规则 7 的活
（需要部位清单 + 可执行 `rollback.txt`，且要先查文档背书），是否算「未完成的特性」而非孤儿
**需人裁决**，本 README 只如实记录事实。
