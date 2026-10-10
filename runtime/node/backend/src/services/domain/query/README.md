# query — 检索必要性、续写、压缩管线与搜索证据链（D2）

子上下文：`query`（15 个文件）/ `search`（11 个文件）。
无独立 slash 命令，全部由对话管线与工具回路调用。

## 谁要（角色）

- **联网检索**：`services/webSearchService.js:69,106,143,180,217,252,305,1046`
  是本目录最大的消费者；本地大脑 `services/localBrainService.js:2359`。
- **对话管线**：`cli/aiChatCore.js:1060`（检索必要性路由）、
  `:2924,4380`（`compactPipeline.persistOversizedToolResults`）。
- **工具回路**：`services/tool/toolUseLoopCore.js:1886-1910,2471,2534`
  （续写、重复守卫、最大 token 恢复等）。
- 治理侧锁：`scripts/tests/leaf-contract.test.js:49` 断言
  `search/searchNecessity.js` 声明自己是叶子。
- 壳：`services/{query,search}/index.js`。

## 为什么这么做

`search/` 这一族解决的是「AI 说的这句有没有证据」，所以每条判据单独成文件且
都是纯打分函数：`searchNecessity`（要不要搜）、`searchSourceDiscovery` /
`searchSourceChainResolver`（来源与来源链）、`searchFreshness`（时效）、
`crossSourceMerge`（跨源合并）、`searchAdversarialVerifier` /
`searchClaimVerifier` / `searchContradictionDetector`（对抗、断言、矛盾三侧
互相独立，避免「同一段提示词既当证据又当裁判」）、`searchQualityEnhancer`，
每个都另出 `format*Footer` 供状态行满足规则 2 的「动作+目标+进度」。
`query/` 管的是**回合能不能继续**：`continuation` / `inertialContinuation` /
`shortStopContinuation` / `seamlessResume` / `maxTokensRecovery` /
`streamRepetitionGuard` / `responseDebounce` / `searchConvergence`，
加 `compactPipeline` + `compactionStages`（阈值 `AUTOCOMPACT_THRESHOLD`）。
IO 只在两处：`toolResultPersistence.js`（`:22-24` 的 `fs`/`os`/`path`，
超限工具结果落盘）与 `streamingToolExecutor.js`（`crypto`）。

## 怎么验

```bash
cd services/backend
node --test tests/services/searchNecessity.test.js               # 19 tests / 19 pass / 0 fail
```
同族（node:test，本卡未逐条复跑）：`tests/services/{crossSourceMerge,
searchFreshness,searchSourceDiscovery,unifiedSearch}.test.js`、
`tests/{activeAssist,inertialContinuation,searchConvergence,
shortStopContinuation,streamRepetitionGuard,mojeekEngine,inertiaCompletion}.test.js`。
注意：`tests/activeAssist.test.js` 与
`tests/services/domain/query/query/responseDebounce.test.js` 在 `node --test` 下
报 `describe is not defined`（jest 形态，本机 jest 渠道不可用）。
`tests/maxTokensRecovery.test.js` 亦为 jest 形态。

## 已知缺陷（登记，不在本单元擅自修）

七个文件在做中改动（均 ` M`）：`query/maxTokensRecovery.js`、
`search/{searchAdversarialVerifier,searchClaimVerifier,
searchContradictionDetector,searchQualityEnhancer,
searchSourceChainResolver,searchSourceDiscovery}.js`。
上面那条 19 pass 测的是 `searchNecessity.js`（当前干净），
**不能**当作这七个文件的绿证。
