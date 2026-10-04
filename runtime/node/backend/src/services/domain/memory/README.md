# memory — 记忆引擎、上下文压缩与认知快照（D2）

业务上下文：AI 对话里「记住什么、什么时候召回、上下文爆了怎么压」的全部判定，
无独立 slash 命令入口（`memory` 在 `constants/commandSchema.js:945` 只做分类登记）。

## 谁要（角色）

- **对话管线**：`cli/aiChatCore.js:2453,2609`、`cli/aiSession.js:379`、
  `cli/routerDispatchTail.js:469`、`cli/replSession.js:3946`、
  `cli/tui/hooks/useQueryBridge.js:651`。
- **记忆目录层**：`memdir/memdir.js:664,1127,1182`。
- **工具回路**：`services/tool/toolUseLoopHelpers.js:1386`（经壳
  `services/cognitiveSnapshot/index.js`）。
- 壳：`services/{memoryEngine,cognitiveSnapshot,compact}/index.js`。

## 为什么这么做

三个子上下文对应三件不同时间尺度的事：
`memoryEngine/` 管**跨会话**（`scoring` 打分、`distiller` 蒸馏、`dreamPromote`
晋升、`topicSwitch` 话题切换、`vectorRecall` 召回、`sessionMemory`、
`progressLog`、`sessionCheckpoint` 均为纯判定；落盘的只有
`offloadStore` / `vectorStore` / `snapshotManager` / `distiller`）；
`compact/` 管**单会话内**的压缩（`sessionMemoryCompact`、`microCompact`、
`applyCompaction`、`shouldCompact` 与 `DEFAULT_PRESERVE_RECENT` /
`MIN_MESSAGES_FOR_COMPACTION` 两个阈值）；`cognitiveSnapshot/` 管**一次回合的工作台**
（`workbench`、`compressionEngine`、`overflowInterceptor` 超限拦截）。
阈值与判据都是纯数，为的是「为什么这轮被压掉了」可复算——规则 2.2 要求错误
信息说清问题与修法，压缩这件事同理。

## 怎么验

```bash
cd services/backend
node --test tests/services/memoryEngine/progressLog.test.js      # 11 tests / 11 pass / 0 fail
node --test tests/services/memoryEngine/topicSwitch.test.js      # 7 tests / 5 pass / 2 fail
```
第二条**当前是红的**（2 条失败）。`memoryEngine/topicSwitch.js` 本体当前干净，
而本目录的在做中文件是 `memoryEngine/progressLog.js`（` M`，第一条命令测的正是它，
此刻全绿）。红点成因未判定，需按规则 5 立独立改动集复现。
其余 `tests/services/memoryEngine/` 下 12 个文件混合两种形态：
`distiller.test.js` 是 jest（用 `jest.resetModules()`），
而 **jest 在本便携安装里跑不起来**（`node_modules/.bin/jest` → MODULE_NOT_FOUND，
`jest-cli` 未落盘），故这些套件在本机无执行渠道，已登记为缺陷。

## 已知缺陷（登记，不在本单元擅自修）

1. 上面 2 条红（topicSwitch）。
2. `services/compact/*` 的三个入口（`sessionMemoryCompact` / `microCompact` /
   `applyCompaction`）在 `src` 内**未发现外部消费者**（只有自引用）——
   是「未接线的新面」还是「经由壳由别处调用」需人裁决，删除属规则 7 的活。
