# `domain/project/workflow` — 确定性工作流引擎（图解释器 + 运行时自演化 + 队列 worker）

> 本 README 是本单元的上下文真源之一。机器可读的契约、扇入与登记缺陷见同目录
> `khy.module.json`（守卫 `npm run check:layout` 的 `functional-unit` 规则要求二者并存）。

## 1. 三问（规则 9 / `PROCESS-010`）

| 问 | 答 |
|---|---|
| **谁要的** | 用户，经两条入口：人直接敲的 `khy workflow`（`cli/handlers/workflow.js`）与 Agent 侧的两个工具 `tools/WorkflowTool`（只读图）/`tools/RPATool`（沉淀 + 自愈 + 重试）。第一消费者是 `services/backend/src/services/workflow/index.js`（7 处 require，D1 侧整包 shim），实测非测试扇入 5 个文件 / 19 个 require 站点。 |
| **为什么要这么做** | 这个单元把「Agent 首次用 LLM 规划完成的任务」沉淀成一张可**确定性重放**的 canonical 图 `{nodes, connections}`，二次执行不再走规划。核心是一台**单游标 DAG 解释器**（`workflowExecutor.runGraph`，772 行）——图里合法含环（loop 回边），故不能用拓扑排序，只能一个游标按输出端口走。节点副作用全部经 `primitives` **注入**，解释器本体因此可离线单测。在此之上长出的三层让它不只是回放器：`graphPatch`/`expandTemplate` 是运行时自演化（受限数据补丁，绝不是 JS；删节点禁、删边允许）；`healGuard` 把 RPATool「AI 手工自愈」的 `healedFrom` 从只写字段变成可判定的四条闸 + 重放三态裁决；`workflowRunWorker` 是跨进程队列消费者（`workflow_runs` 表是两端唯一桥梁，原子 claim + 崩溃回收 + 量子抢占时间片）。`contractChecker` 在重放后校验 `_meta.contract` 断言，`flowStats`/`flowRegistry` 提供成功率加权与幂等存储。 |
| **怎么验证** | `node --test services/backend/src/services/domain/project/workflow/*.test.js`（**显式列全部路径**，本环境给目录得假读数）→ 11 份共置套件 200 例 / 572 个断言调用点 / 0 fail / 0 skip；已用正向两趟 + 反向一趟复跑证明与顺序无关、幂等。单元外 15 份引用本单元的测试：8 份 node:test 方言实测 90 例全绿（2 suites），7 份在本环境**无法复跑**（方言错配，不是缺陷，见 §4）。 |

## 2. 契约（改本单元前先读这段）

- **每个源文件都是叶子或有状态主体，导出面各自独立，无 `index.js` 聚合**（`services/workflow/index.js` 是 D1 侧的整包 shim，不在本单元内）。逐文件导出键数（本批测试用 `Object.keys` 逐字钉死）：`contractChecker` 3 / `expandTemplate` 5 / `flowRegistry` 11 / `flowStats` 9 / `graphPatch` 6 / `healGuard` 3 / `jsonExtract` 1 / `retryPrimitives` 4 / `workflowCliCore` 7 / `workflowExecutor` 8 / `workflowRunWorker` 9。
- **三个文件角色，改法不同**：纯叶子（`jsonExtract` / `graphPatch` / `expandTemplate` / `healGuard` / `workflowCliCore` / `contractChecker` 的插值与窗口标题抽取）零 IO、确定性、**绝不抛**（一律返回 `{ok:false, errors}`）；薄 IO（`flowRegistry` 的 save/load/list/remove/find、`flowStats` 的 record/getSuccessRate/…）fail-soft，任何异常收敛为结构化返回或中性值 `null`，**绝不抛**；有状态主体（`workflowExecutor.runGraph`、`workflowRunWorker` 的模块级 `_started/_timer/_tableReady`、`retryPrimitives` 的重试计数器）承载副作用与进程态。
- **端口词汇与类型集合必须注入，叶子里绝不 require `nodeCatalog`**：`workflowCliCore.validateGraph`、`graphPatch`、`expandTemplate` 都靠调用方注入 `ctx.portsFor` / `ctx.knownTypes`；注入缺失即 fail-closed（拒绝），绝不「拿不到类型集合就放行」。真身 `@khy/shared/workflow/nodeCatalog` 只在 `workflowExecutor.catalogCaps()`(:43) 与 `workflowRunWorker`(:197) 里惰性加载。nodeCatalog 实有 **13 种类型**（start/end/prompt/ifElse/loop/graphPatch/expand/subAgent/toolCall/skill/code/http/askUserQuestion）。
- **节点类型 fail-closed（规则 TOOLING-011）**：`workflowExecutor.js:709-719` 的 `default` 分支对未知 `node.type` **抛错**，绝不静默标 skipped 后继续（那是本仓最危险的一类静默失真）。解释器 case 标签集合必须是 nodeCatalog 的超集，漂移由 `scripts/ci/check-workflow-node-parity.js` 在 commit 档拦下。`workflowRunWorker.assertGraphNodeTypes`(:193) 是执行前的第二道同名闸。
- **ifElse 求值是受限比较器，永不 eval/Function**（`compare`/`evalCondition`，`workflowExecutor.js:132-168`）：只支持 `a OP b`（`== != > < >= <=`）与单值真值，杜绝从存储图里执行任意代码。⚠ 注意 `code` 节点（:506）确实经 `defaultPrimitives.runCode` 的 `new Function` 执行用户代码——那是对齐 Bash 节点的既有信任边界，**不适用于图改写**（`graphPatch` 只有 `addNode/connect/disconnect` 三个数据算子）。
- **自愈链（`healGuard` + `flowRegistry.save`）**：带 `meta.healedFrom` 的 save 先过四条闸（① 非空字符串 ② 有上一版 ③ 根因节点在上一版图中 ④ 深度 ≤ 上限），不通过即**不发布新版本**；「同图 + healedFrom」被判为幻觉明确拒绝（不静默丢弃，实测 `Noop Heal` 路径）。重放侧三态 `healVerified / healRejected / healUnverified` **必须可区分**，未声明 contract 或契约校验环节自身异常都判 `healUnverified`（诚实说「未验证」，而非 fail-soft 当通过）。
- **门控（本单元源文件 `KHY_*` 全数清点，非抽样，两种前缀族）**：worker 族 `KHY_WORKFLOW_WORKER`（总闸，默认开，CANON `{0,false,off,no}`）/ `KHY_WORKFLOW_POLL_MS`（默认 2500）/ `KHY_WORKFLOW_STALE_MS`（默认 180000）/ `KHY_WORKFLOW_QUANTUM_STEPS`（默认 0）；CLI 族 `KHY_WORKFLOW_CLI`；统计族 `KHY_FLOW_IDLE_LIMIT_MS`（默认 120000）/ `KHY_FLOW_STATS_LIMIT`（默认 200）。路径位经 D3 `dataHome` 的 `KHY_APP_HOME`/`KHY_DATA_HOME`/`KHY_PROJECT_DATA_HOME`。⚠ 只有 `quantumSteps()` 每次调用现读 env；`POLL_INTERVAL_MS`(:35) 与 `STALE_RUN_MS`(:39) 在 **require 时快照一次**（见 B31-W6）。
- **跨单元版本格式**：`flowRegistry` 落盘 `{name, nodes, connections, _meta}`，与 `cli/handlers/workflow.js` 的 `_loadSaved`（`{graph:{nodes,connections},name,_meta}`）双向兼容（`_readFlowFile` 展平两种形态）。

## 3. 实测数字（2026-09-29，全数清点非抽样）

| 项 | 读数 |
|---|---|
| 源文件 / 行数 | 11 / 4058（`workflowExecutor.js` 772、`flowRegistry.js` 475、`graphPatch.js` 463、`workflowRunWorker.js` 420、`expandTemplate.js` 380、`workflowCliCore.js` 361、`contractChecker.js` 312、`flowStats.js` 308、`retryPrimitives.js` 245、`healGuard.js` 205、`jsonExtract.js` 117） |
| 共置测试 | 11 份 ↔ 11 个源文件，一一同名同目录 → **200 例 / 572 个断言调用点 / 0 fail / 0 skip**；正向两趟 + 反向一趟复跑，读数一致（顺序无关、幂等） |
| 出边（非内置） | **D3 4 站点 / 2 目标**（`contractChecker.js:30` nativeHttp、`workflowExecutor.js:32` nativeHttp、`flowRegistry.js:27` dataHome、`flowStats.js:23` dataHome）——方向合法。**同目录 D2 14 站点 / 8 目标**——内部互取，合法。⚠ **D1 反向 2 站点**（`workflowExecutor.js:213` aiChatPort、:221 toolCalling）——登记不洗白。⚠ **无域归属根 2 站点**（`workflowExecutor.js:225` `src/skills`、:232 `src/tools/AgentTool`）。**`@khy/shared` 裸标识符 3 站点 / 2 目标**（`workflowExecutor.js:43` nodeCatalog、`workflowRunWorker.js:75` models、:197 nodeCatalog，经 `node_modules/@khy/shared` 符号链接解析到 `vendor/shared`，DOMAIN-DEPS 未归类）。node 内置 `fs/crypto/path` 若干处不计为域边。 |
| 扇入（非测试） | **5 个文件 / 19 个 require 站点**：`services/workflow/index.js` ×7（整包 shim，D1）、`cli/handlers/workflow.js` ×3（executor/core/flowStats，D1 cli）、`tools/RPATool/index.js` ×6（flowRegistry/flowStats/retryPrimitives/executor/contractChecker/healGuard，**UNMAPPED 根**）、`tools/WorkflowTool/index.js` ×2（core/executor，**UNMAPPED 根**）、`cli/aiChatCore.js` ×1（flowRegistry.find，D1 cli）。消费者域构成：3 个 D1（合法 D1→D2）+ 2 个无域归属根（src/tools）。 |
| 本批改动 | **零源文件修改**。只新增 11 份共置测试 + 本 README + `khy.module.json`，`git status --porcelain -- <本目录>` 全是 `??`（13 项）。 |

## 4. 测试隔离与已知警告

单元内 11 份共置测试全部把 `KHY_APP_HOME` / `KHY_DATA_HOME` / `KHY_PROJECT_DATA_HOME` 钉到 `fs.mkdtempSync` 临时目录**再 require**，任何落盘（`flowRegistry` 的 `workflows/`、`flowStats` 的 `workflow_stats/`、`contractChecker` 的文件断言）都打在临时目录里；实测跑完 `git status --porcelain -- <本目录>` 仍只有 `??`，**不改任何跟踪文件**。测试**不 spawn worker/子进程、不开 socket、不起定时器**：
- `workflowRunWorker` 只测注入式假模型能覆盖的 `claimNext`/`recoverStale`/`executeRun`/`assertGraphNodeTypes`；`tick()` 与 `start()`（会 `getModel()` 启动 `@khy/shared/models` 打真库、并 `setInterval` 起重复定时器）**未测**，其不可注入性登记为 B31-W10，不绕过。
- `executeRun` 只驱动 `start/end/ifElse/askUserQuestion` 图（这些节点不调任何 primitive，故 `defaultPrimitives` 里那些惰性真通道闭包永不触达）。
- `retryPrimitives` 全程注入 `basePrimitives` 且 `backoffMs:0`（`waitMs>0` 守卫直接跳过 `_sleep`，零定时器）。
- `contractChecker` 的 `httpStatus` 只走非法 URL / 非 http 协议的**跳过分支**——`requestStatus` 在模块顶层直接 require（`contractChecker.js:30`），无注入位，真实状态检查会开 socket，故不驱动（见 §4 末）。

**RUNTIME-003（定时器）留档**：产品源码里存在多处固定墙钟——`contractChecker.HTTP_TIMEOUT_MS=30000`（http GET 30s）与 `workflowExecutor.js:277` 的 `timeoutMs:30000`（两处注释互指「same wall-clock」，实为**各写一份魔数**，改一处另一处漂移）；`retryPrimitives` 默认退避 1000ms；worker `setInterval` 默认 2500ms。本批测试**一律不复制**这些时长（用 `backoffMs:0`、事件驱动、或跳过分支），并把它登记在 `khy.module.json` 的 `instrument_notes`。

**RUNTIME-001（零硬编码）留档**：单元内无 IP/端口/绝对路径/生产主机名字面量。`workflowExecutor.js:262` 的 `'Bash'` 是 executeTool 的工具名（非端点），`runCode` 回退路径；`RPATool` 自愈协议的提示词不在本单元。

**单元外 7 份测试在本环境无法复跑，全是方言错配、非产品缺陷**（node 把装载失败合成「1 test / 1 fail，名字即文件路径」，**绝不可据此判红**）：4 份裸 `describe`（`workflowExecutor.quantum` / `workflowExecutor.test` / `workflowExecutor.userThreading` / `services/contractChecker.nativeHttp`，报 `describe is not defined`；本环境未安装 jest），3 份 jest `beforeAll`（`workflowRunWorker.quantum` / `workflowRunWorker.starvation` / `workflowRunWorker.test`，报 `beforeAll is not defined`）。⚠ 另注：`workflowRunWorker.test.js` 文件头注释含 mojibake（编码损坏的中文），不影响其可测性判断，属既有瑕疵。可跑的 8 份实测 **90 例 / 0 fail / 0 skip**（`graphRewriteContract` / `healGuard` / `nativeHttpConsumers` / `services/aiChatPort` / `workflowExecutor.expand` / `.failClosed` / `.graphPatch` / `.onVar`）。
