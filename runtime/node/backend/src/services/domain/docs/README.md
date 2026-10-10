# docs — 文档新鲜度与发布说明的判定层（D2）

业务上下文：`/docs` 的「哪些文档可能过期了」与 `/release-notes` 的
「从 CHANGELOG 生成发布说明」——两件事的**判定**都在这里，IO 只留一个 runner。

## 谁要（角色）

- **跑 `/docs` 的人**：`constants/commandSchema.js:2087` 声明命令，
  子路由 `docs maintainer`（`:1670`）与 `docs check`（`:1677`）；
  处理器 `cli/handlers/docs.js:694` 取 `docsFreshness/docsFreshnessRunner.js`、
  `:774` 取 `docsFreshness/docSuggestDraft.js`。
- **要发布说明的人**：`cli/handlers/releaseNotes.js:23` require 纯叶子
  `changelog/changelogParse.js` 的 `parseChangelog / selectReleaseNotes`
  （命令声明 `commandSchema.js:213`，路由 `:1027`）。
- 壳 `services/docsFreshness/index.js:4-8` 只做再导出。

## 为什么这么做

「文档过期」这个判断必须**可解释**：`docPathIndex.js` 把源码路径抽进倒排
（`extractSourcePaths / buildDocPathIndex / matchStaleSuspects`），
`docMarkerSync.js` 管受管区块的值映射，`docProductPlan.js` 决定哪些文档产品该重建，
`changelogParse.js` 把 Markdown 切成版本/亮点结构。这四件都是**确定性纯函数**，
所以「为什么这份文档被判为可疑」能原样打印给人看。唯一的 IO 侧是
`docsFreshnessRunner.js`（`fs` + `child_process.execFileSync` + `utils/gitSoftExec`），
它只负责取改动集与落盘，不参与判定。

## 怎么验

```bash
cd services/backend
node --test tests/services/changelog/changelogParse.test.js   # 17 tests / 17 pass / 0 fail
```
同族还有 `tests/services/{docPathIndex,docMarkerSync,docProductPlan,docsFreshnessRunner}.test.js`
（node:test 形态）与 `tests/services/docSuggestDraft.test.js`（jest 形态，正式入口 `npm test`；
本卡未在此 shell 复跑 jest 那条，便携 shell 无 npm/npx）。

## 已知缺陷（登记，不在本单元擅自修）

本目录**零**测试共置（`check:layout` 的 `test-colocated` 判据逐文件点名）：
所有测试都在 `services/backend/tests/` 下。补齐属 `[RESEARCH-018]` §4 C-4 的
存量活，与 README 半（本文件）共用同一把尺。
