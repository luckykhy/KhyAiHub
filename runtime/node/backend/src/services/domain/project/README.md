# project — 工作流、蓝图、一致性体检与元计划（D2）

业务上下文：`workflow`、`issue` / `perf-issue`、`manage`，以及项目蓝图 /
一致性门禁 / 卫生体检 / 元计划约束这四族判定。

## 谁要（角色）

- **跑 `workflow` 的人**：`constants/commandSchema.js:177` →
  `cli/handlers/workflow.js:59-61`；模型侧 `tools/WorkflowTool/index.js:84,96`、
  `tools/RPATool/index.js:159-343`；slash 查流 `cli/aiChatCore.js:2202`
  （`flowRegistry.find`）。
- **报 issue 的人**：`commandSchema.js:222`（`issue`）与 `:220-221`（`perf-issue`）
  → `cli/handlers/issue.js:31`。
- **`manage`**：`cli/handlers/manage.js:21` → `services/management` → 本目录 `management/`。
- **CI 与治理**：`scripts/lib/workflowNodeParityGuard.js:270-271`、
  `scripts/ci/check-workflow-node-parity.js:50-51`（工作流节点与 CI 必须成对）；
  `tools/ProjectBlueprintTool/index.js:3`。
- **约束格**：`services/constraintLattice.js:237` 取 `metaplan/constraintStrategy`。

## 为什么这么做

这一族的产物是「计划」和「门禁结论」，两者都必须**能在没跑之前就被追问**，
所以判定与执行分离：`metaplan/` 提供约束注入与不可逆签名
（`constraintStrategy` / `constraintInjection` / `irreversibleSignatures` /
`constitutionalRedLines`）以及 `TrustCircuitBreaker`；
`projectHygiene/` 的 `assessGodFile` / `findDuplicateModule` / `stackConflict`
和 `thresholds`、`symbols` 全是纯判据（本仓 400 行上限与纳管台账就长在这里）；
`projectCoherence/` 的 `analyzeProjectCoherence` + `evaluateCoherenceGate` +
`evaluateClosure` / `evaluateKickoff` 决定「能不能收口」；
`projectBlueprint/` 的 `plan / milestone / scaffold / verify` 出计划文本；
`workflow/` 里 `retryPrimitives`、`healGuard`、`parityGuard`、`resourceContract`
是纯叶子，`flowRegistry` / `flowStats` / `contractChecker` 才碰盘。

## 怎么验

```bash
cd services/backend
node --test tests/services/issue/issueReport.test.js            # 23 tests / 23 pass / 0 fail
node --test tests/services/projectCoherence.test.js             # 35 tests / 30 pass / 5 fail
```
第二条**当前是红的**，原样记录：5 条红用例为
「resolver: relative resolves against known set (+ index)」（断言里出现
`'D:\\khyc_test_35432\\src\\b.js'` 这样的**绝对临时根**）、
「analyzer: unresolved local import → HIGH gap」、「resolved but missing named
export → MEDIUM gap」、「broken package.json main → HIGH gap」等。
红点集中在「往 `D:\khyc_test_*` 造临时工程再解析」这条路上；
本目录当前无 ` M` 文件（干净），但被测侧 `projectCoherence/resolver.js` 与
`coherenceAnalyzer.js` 是 IO 侧。这条断言里的盘符根来自测试的临时目录构造——
若它是字面量而非取自 `os.tmpdir()`，就与规则 1（零硬编码）相冲；
**未核实来源，登记待查**，不在本卡擅自改。

## 已知缺陷（登记，不在本单元擅自修）

`workflow/` 12 个文件的逐文件导出键未被本次调研逐个点名（经壳
`services/workflow/index.js:4-10` 可枚举），补齐需独立改动集。
