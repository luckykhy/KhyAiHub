# state — 意图裁决、编排与阶段状态机（D2）

业务上下文：`/orchestrate`（多角色编排的 run/status/pause/resume/replay/cancel）、
`/autonomy`，以及 REPL、工具循环、回合相位这三处**阶段判定**的真源。

## 谁要（角色）

- **跑编排的人**：`constants/commandSchema.js:151` 声明 `/orchestrate`
  （别名 `/orch`，子命令 `:812-813`）→ `cli/handlers/orchestrate.js:168` 取
  `orchestrator/orchestrationService`。
- **切自治档的人**：`commandSchema.js:1108` 的 `/autonomy` → `cli/handlers/autonomy.js:35`。
- **要「角色能拿哪些工具」的判定**：`tools/AgentTool/index.js:22` require
  `orchestrator/roleToolScope`；治理守卫 `scripts/ci/check-agent-authz.js:238`
  直接以该文件为判据目标（规则 10 A2-2/A2-4 的执行面）。
- **回合/工具/启动相位**：`cli/replSession.js:1206`（replPhases）、
  `services/tool/toolUseLoopCore.js:196`（toolLoopPhases）、
  `cli/tui/hooks/useQueryBridge.js:529`；`services/taskDecomposer.js:423,457,517`
  消费合并结果的三个纯叶子。

## 为什么这么做

四个子上下文各管一件**不能被含糊**的事：
`intentArbiter/` 决定一句话属于哪个意图带（`intentLexicon` 的权重表 +
`intentCalibration` 的词面相似 + `tieredResponseRouter` 的分档响应 +
`misjudgmentQuencher` 的误判灭火）；`orchestrator/` 决定计划与合并
（`orchestrationPlan` 纯构建、`dependencyWaveScheduler` 分波、
`merge*` 三个纯叶子负责「空成功/文件冲突/角色归因」的如实标注）；
`stateMachine/` 是通用 FSM（`FiniteStateMachine` 与 `NoopFsm` 两档，
门控关时退化成 Noop 而不改调用点）；`envSymbiosis/` 管平台亲和与熔断。
判据全部是纯表 + 纯函数，为的是「为什么这一句被判成 X」能一步回答，
也为了让 `roleToolScope` 这类权限判定可以被 CI 直接引用而不是靠描述。

## 怎么验

```bash
cd services/backend
node --test tests/services/intentArbiter/intentArbiter.test.js      # 32 tests / 32 pass / 0 fail
node --test tests/services/orchestrator/mergeFileConflicts.test.js  # 18 tests / 18 pass / 0 fail
```

## 已知缺陷（登记，不在本单元擅自修）

四个文件在做中改动（` M`）：`intentArbiter/intentPreprocess.js`、
`orchestrator/mergeEmptySuccess.js`、`orchestrator/mergeFileConflicts.js`、
`orchestrator/mergeRoleAttribution.js`。上面第二条命令此刻仍全绿，
但它测的正是这三个脏文件之一——作者落地后必须复跑同一命令，本卡的绿读数不可外推。
