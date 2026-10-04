# trajectory — 录制、回放、双轨与 provenance 判定（D2）

业务上下文：`/trace`（list/show/verify）、`/replay`（list/export/verify/run）、
`/guide`（map/export/list）三个命令，以及工具回路里每回合的账本落盘。

## 谁要（角色）

- **要复盘一次会话的人**：`cli/handlers/trace.js:24-25`、
  `cli/handlers/replay.js:29-33,252`、`cli/handlers/guide.js:21-26`
  （命令声明 `constants/commandSchema.js:536,537,538`）。
- **每回合自动记账的回路**：`services/tool/toolUseLoopCore.js:7675,8586` 调
  `trajectoryReplay/replayLedger.recordToolTurn`。
- **会话持久化与隔离**：`services/sessionPersistence.js:502,539`、
  `services/gateway/adapters/codexAdapter.js:2221`（`quarantinePolicy`）。
- 壳：`services/{auditTrajectory,dualTrack,dualTrackForge,trajectoryGuide,
  trajectoryProvenance}/index.js`。

## 为什么这么做

「回放」要可信，必须同时有四样彼此独立的东西：**录制**
（`auditTrajectory/recorder` + `wire` + `diffCapture`，规则要求不压缩不裁剪）、
**账本**（`replayLedger` 带 `LEDGER_VERSION` 与 `verifyLedger`）、
**可校验的产物**（`artifactHash` 的 `hashCanonical` + `replayBundle` 的
`BUNDLE_VERSION/verifyBundle` + `envFingerprint` 记录运行环境）、
以及**断言与自评估**（`dualTrack` 的 `PhysicalAssertionGate` /
`DeterministicElevator` / `LogicalSelfAssessor`，`dualTrackForge` 的
`SOURCE_TRACK` 与用户轨保护 `USER_TRACK_PROTECTED_NAMES`）。
判定侧刻意留纯：`replayEngine`（依赖注入）、`replayStepPolicy`、`tierRegistry`、
`claimReconciler` / `provenanceClassifier`、`degradeStateMachine`、
`lenientResponseParser`——「这条声明是谁产出的、能不能算证据」必须离线复算。
验收阶梯（`acceptance` 的 `TIER`/`tier1Grep`/`tier2Interact`/`tier3FullSuite`）
与 `channel` 的 `HARD_PATTERNS`/`scanForbidden`/`sanitizeEnv` 则把
「worker 侧不得越界」做成机制而非约定（规则 10 A2-4）。

## 怎么验

```bash
cd services/backend
node --test tests/services/trajectoryReplay/p1Ledger.test.js     # 9 tests / 9 pass / 0 fail
node --test tests/services/dualTrack/dualTrack.test.js           # 37 tests / 34 pass / 3 fail
```
第二条**当前是红的**，原样记录：3 条红用例为
「assemble 装载官方核心 + 仓库用户扩展轨样例」（断言 `loadedTypes.includes('say')`）、
「用户覆写生效」、「曾经未知的 speak_v2 现经扩展轨可执行」。
红的集中在**样例装载**这条路径（依赖仓库内样例文件的实际内容），
而本目录唯一脏文件是 `auditTrajectory/diffCapture.js`，与红点不同侧。
病因结论留给复跑者，本卡只登记读数与位置。

## 已知缺陷（登记，不在本单元擅自修）

`dualTrack` 的 3 条红（见上）；52 个源文件零共置测试。
