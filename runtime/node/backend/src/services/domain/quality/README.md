# quality — 性能归因、产物工具与元约束求解（D2）

业务上下文：`/perf-issue` 的报告生成、模型的 `Artifact` 工具（读写产物），
以及工具调用前的元约束（能力档位、风险分级、工具漏斗闸）。

## 谁要（角色）

- **跑 `/perf-issue` 的人**：`constants/commandSchema.js:1045-1050` →
  `cli/handlers/perfIssue.js:29` 取 `perf/perfReport.js`。
- **用 Artifact 工具的模型**：`tools/ArtifactTool/index.js:4` 取
  `artifact/artifactPlan.js`。
- **每次工具调用的约束**：`services/tool/toolCalling.js:2448`；
  目录侧 `services/domain/catalog/capabilityMatrix/descriptors.js:245`
  以 `invoke: toolFunnelGuard.enforce` 挂上漏斗闸。
- 壳：`services/{metaConstraint,artifact}/index.js:4`。

## 为什么这么做

本目录 7 个文件**零 IO**（`fs` / `net` / `child_process` 在本目录内 grep 无命中）：
`perfReport.js` 只 require `utils/finiteNumber`，把「慢在哪」归因成可打印的
结构化结论（`analyzePerf` / `formatPerfReport`）；`artifactPlan.js` 把工具调用
变成纯计划（`validateInput / deriveSafeName / buildCreateResult / buildListResult /
buildErrorResult / describeActivity`——最后这个是给状态行用的「动作+目标」文案源）；
`metaConstraint/` 是判定四件套：`capabilityProbe`（`BANDS` / `bandForReasoning` /
`tightenBand`）、`riskClassifier`（`RISK` / `RISK_RANK` / `classify`）、
`constraintMatrix`（`MATRIX` / `DOCTRINE` / `solveFloor`）、
`toolFunnelGuard.enforce`。跨单元依赖只有三条且都是**取判据**：
`../../project/metaplan/{constraintInjection,constraintStrategy,irreversibleSignatures}`、
`../../security/marshal/capabilityVector`、`../../../execApproval`。
零 IO 是本单元的立场：约束求解一旦读盘，「为什么这次被拦」就无法复算。

## 怎么验

```bash
cd services/backend
node --test tests/services/perf/perfReport.test.js               # 16 tests / 16 pass / 0 fail
node --test tests/services/artifact/artifactPlan.test.js         # 25 tests / 25 pass / 0 fail
node --test tests/services/metaConstraint/metaConstraint.test.js # 24 tests / 24 pass / 0 fail
```

## 已知缺陷（登记，不在本单元擅自修）

`tests/services/metaConstraint/toolFunnelGuard.test.js` 存在但未在本卡复跑；
漏斗闸的拦截样本量属规则 8 的 S1 观察账，见
`docs/10_规范/registry/FEATURE-OWNERSHIP.json`。
