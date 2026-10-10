<!-- IMPL-STATUS: done -->
# [DESIGN-ARCH-141] 动态工作流：运行时自演化、节点热插拔与公平调度方案

<!-- RULES-REGISTRY: TOOLING-011 -->
> **隶属**：工作流设计族（画布族背景见 `[DESIGN-ARCH-009]`）；与 `[DESIGN-ARCH-130]`（前台/后台任务编排）相邻但**不重叠**（边界见 §4）。
> **状态**：**步骤 2「迁移」+ 步骤 3「收口」已完成**（2026-09-23，规则 `TOOLING-011`）；**D1 步 A「受控图改写」+ 步 B「边级 `disconnect`」+ 步 C「动态扇出 `expand`」+ 步 D「运行期补丁来源 `onVar`」已落地**（2026-09-24，§12.7 / §12.8 / §12.9 / §12.11，节点类型 13 型）；**D2「自愈闭环闸」已落地**（2026-09-24，§12.10：`healedFrom` 由「只写不读」变为真判据）；**D1 已全部落地**（含 §12.12 的**铁律判据** F4 / F5 / F9 —— 此前头部这句对 F5 / F9 是过度声明）；D3（动态调度）与 D5（打通 hq）待建 · **日期**：2026-09-23 起 · **编号**：[DESIGN-ARCH-141] · **落点目录**：`docs/03_DESIGN_设计/`
> **证据基准**：2026-09-23 实测。方法 = 零依赖探针 `_产物/workflow-dynamic-probe.js` 直接 `require` 真实执行器，用 mock primitives 跑真图 + 静态抽取对账。**所有结论均有可复现命令**（§9），非估算。

---

## 0. 先说结论：本方案**不新建工作流引擎**

动笔前按 `[MGMT-STD-008]` §2.2「重叠即违规」做了检索，结论是 khy-os **已有生产级工作流引擎**，四个「动态」诉求里**两个半已有实现**。若不先讲清这点就动笔，会造出与既有件冲突的重复真源。

| 已有件 | 真源（实测路径） | 已覆盖 |
|---|---|---|
| 原生 DAG 解释器（单游标 + 环回边） | `services/backend/src/services/domain/project/workflow/workflowExecutor.js:296` `runGraph()` | 分支 / 循环 / 并行端口 / 1000 步熔断 |
| 人工审批 + 持久化 checkpoint + 跨进程恢复 | 同上 `:475-516`、`workflowRunWorker.js:175` | 痛点「动态调度」的一部分 |
| 抢占式时间片（长流程不独占 worker） | 同上 `:546`；`workflowRunWorker.js:45` `quantumSteps()` | 公平性 |
| 跨进程队列消费者（原子认领 + 崩溃恢复） | `workflowRunWorker.js:109` `recoverStale()` / `:142` `claimNext()` | — |
| 节点类型**声明式目录**（SSOT） | `services/backend/vendor/shared/src/workflow/nodeCatalog.js`（11 型 + 端口 + 字段 schema） | 痛点「动态节点热插拔」的一半 |
| 沉淀-重放（Agent 做大脑 + RPA 做手脚） | `flowRegistry.js:237/377`（`save`/`find`）、`computeGraphHash():62` | 痛点「AI 生成与自改」 |
| 自愈协议（`healedFrom`） | `tools/RPATool/index.js:67/116`、`flowPriorityDirective.js:104` | 痛点「AI 生成与自改」 |
| 契约断言 | `contractChecker.js`（5 种断言类型） | — |
| REST + SSE + Vue Flow 画布 | `services/ai-backend/src/routes/workflow.js`、`apps/ai-frontend/src/components/workflow/` | — |

**所以本方案的定位是「补四个真空白 + 补一条守卫」，不是重建。**

---

## 1. 现状证据（实测，含复现命令）

### 1.1 探针输出（2026-09-23）

```
$ node _产物/workflow-dynamic-probe.js --scenario=all --verbose
== 动态工作流能力探针 == scenario=all

[1] parity — 节点类型：目录(SSOT) vs 执行器 handler
  catalog types (11): start, end, prompt, ifElse, loop, subAgent, toolCall, skill, code, http, askUserQuestion
  executor cases (11): start, end, prompt, ifElse, loop, toolCall, skill, subAgent, code, http, askUserQuestion
  ok: 目录 11 型 == 执行器 11 型，双向一致

[2] silent-skip — 未知节点类型是否静默成功
  实测: status=completed, 节点 x=skipped, 已访问 3 步

[3] worker-unvalidated — worker 路径是否校验图
[4] frozen-graph — 运行期改图是否生效
  实测: 注入节点 late 是否被执行 = false，实际访问序列 = s -> p -> e

[5] read-before-loop — 结构不变式
  结构: graph 引用 4 处，主循环前 4 处，循环内 0 处

[6] divergence — 反例（守卫必须报出人造差异）
  反例: 注入目录类型 'expand' ⇒ 守卫报出 workflow-node-missing-handler ✓（目录 12 型 / 执行器 11 型）
        ⚠ 该探针名已于 2026-09-24 改为 zzInjectedProbeType —— `expand` 被真实声明后，
          原探针与真实条目重复，触发守卫的「重复抽取」自校验（详见 §12.9）
  放行对照: 未注入的原始输入 ⇒ 0 条 missing ✓（证明不是无脑拦）

[ERROR] workflow-unknown-node-silent-success 含未知节点类型的图跑出 status=completed 且节点 x status=skipped（fail-open，应 fail-closed） workflowExecutor.js:518
[ERROR] workflow-worker-unvalidated worker 直接把 graphJson 交给 runGraph，未校验节点类型（上游校验兜不住这一路） workflowRunWorker.js:204
[ERROR] workflow-graph-frozen-at-start 运行期改写 graph.nodes/connections 不生效（nodes/outEdges 在主循环前已建为 Map）⇒ 无运行时自演化能力 workflowExecutor.js
Summary: 3 error(s), 0 warning(s).
```

### 1.2 三条缺口（全部实测复现，非阅读推断；**G1/G2 已于同日修复**，见 §12）

**G1 — 未知节点类型静默成功（fail-open）**
`workflowExecutor.js:518-520` 的 `default:` 分支把未知类型标成 `skipped` 后**继续走 default 端口**，于是整个 run 以 `status:'completed'` 收尾。实测复现：一张含 `expand` 类型（目录外）的图跑出 `completed`，该节点 `skipped`，访问序列 `s -> x -> e`。

> 这是本仓最看重的一类缺陷：**工作流"成功"了，但那个节点什么都没做**，且日志里只有一行 `未知节点类型 … 已跳过`。

**G2 — worker 路径完全不校验图**
`workflowRunWorker.js:204` 把 `run.graphJson` **直接**交给 `executor.runGraph()`，全文件不含 `validateGraph` / `portsFor` / `getNodeType`（探针静态断言）。而 `workflowService.js:106/134/137` 的端口校验只在 ai-backend 的 REST 侧生效 ⇒ **上游校验兜不住 worker 这一路**，G1 在真实入队路径上可达。

**G3 — 图在启动时被冻结，无运行时自演化能力**
`runGraph` 在 `:305-313` 一次性把 `graph.nodes` / `graph.connections` 读成两个 `Map`，之后 `nextNode()` 闭包只读这两个 Map。结构不变式实测：**`graph` 的全部 4 处引用都在主循环之前，循环内 0 处**。
实测复现：从 `prompt` 节点的 `chat()` 副作用里往 `graph.nodes` / `graph.connections` 注入新节点 `late` 并重接线 → **`late` 从未被执行**，访问序列仍是 `s -> p -> e`。

### 1.3 两条附带发现的**文档/字段漂移**（顺手订正，属 `[MGMT-STD-008]` 范围）

| 位置 | 写的 | 实际 | 处置 |
|---|---|---|---|
| `WorkflowRun.js:97`（**三份副本**：`platform/packages/shared/src/models/`、`services/backend/vendor/shared/src/models/`、`software/khyquant/models/`） | `pending_json` = `{ nodeId, question, options, answerVar, cursor, vars }` | 写入侧只有 `workflowRunWorker.js:276/288`，存的是执行器 `runGraph` 返回的 `pause`，共**两种带判别符的形状**：① 提问停车 `{ nodeId, question, options, answerVar, loopState }`（无 `kind`）；② quantum 让出 `{ kind: "quantum", nodeId, loopState }` | ✓ 已订正（2026-09-24，三份副本同步；`cursor`/`vars` 在**写入侧 0 处**出现） |
| 全仓 | `_meta.healedFrom` | ~~**只写不读**~~ **已订正**（2026-09-24）：save 侧经 `healGuard.checkHealClaim` 判「根因节点须存在于上一版图中 + 自愈链深度 ≤ 5」，run 侧出三态裁决 | ✓ **已变成真判据**（§12.10） |

> `healedFrom` 属于「字段存在、写入函数存在、**生产调用点/消费点 0 处**」这一类隐蔽空头支票。**一条永远为真的铁律比没有更坏** —— 它会让人以为这里有守卫。

---

## 2. 契约/数据模型可行性实证（逐字段回真源）

本方案要动两处数据面，逐字段核对如下（**不写不存在的字段**）。

### 2.1 `workflow_runs` 表（真源 `vendor/shared/src/models/WorkflowRun.js:25-141`）

| 初稿想写 | 真源实况 | 处置 |
|---|---|---|
| `priority` | ✗ **不存在**（全表 12 字段：`id` / `user_id` / `workflow_id` / `status` / `graph_json` / `vars_json` / `log_json` / `error` / `pending_json` / `resume_json` / `started_at` / `finished_at` + `createdAt`/`updatedAt`） | **登记为「需要扩真源」**，划入 D3 边界，不在步 1/2 假装它存在 |
| `updatedAt`（排序键） | ✓ 存在（`timestamps: true`，且 `claimNext` 的 `order` 已消费） | 直接复用 |
| 索引 | ✓ `user_id` / `workflow_id` / `status` | 加 `priority` 需**同步加复合索引** `[status, priority, updated_at]`，否则排序退化为全表扫 |
| 状态枚举 | ✓ `queued \| running \| awaiting_input \| succeeded \| failed`（`:47`） | ⚠ 注意**无 `paused`**：quantum 让出时写回的是 `queued`（`workflowRunWorker.js:227`） |

### 2.2 canonical 图（真源 `nodeCatalog.js` + `flowRegistry.js`）

| 契约项 | 真源实况 | 处置 |
|---|---|---|
| 节点形状 | `{ id, type, name?, data }` | 沿用 |
| 边形状 | `{ from, fromPort, to, toPort }`，端口词汇 `input` / `default` / `branch-true` / `branch-false` / `loop-body` / `loop-done` | 沿用；**新节点类型的端口必须先在 `nodeCatalog` 声明**（`portsFor()` 是校验真源） |
| 图哈希 | ✓ `flowRegistry.computeGraphHash():62`（`stableStringify` 键排序 + sha256） | **零新实现**，D1 审计直接复用 |
| 图形状闸 | ✓ `flowRegistry.checkGraphShape():116`（非空 / 唯一 start / 至少一个 end） | 复用为图改写的前置闸 |
| 版本 | ✓ `_meta.version` / `_meta.previousVersion`（`:263-284`） | 复用 |

> ⚠ **命名纪律**：契约层一律沿用真源的 **`snake_case`（DB 列）/ camelCase（JS 对象）原样**，不做转换层 —— 转换层就是第二套字段名。

---

## 3. 设计公理（3 条，不可让渡）

| # | 公理 | 可自动判的判据 |
|---|---|---|
| **A1** | **图是数据，不是代码。** 一切动态性通过改写 canonical `{nodes, connections}` 实现；不引入代码生成 / 热重载 / `eval` | 图改写入口只接受**数据补丁**；源码中 `new Function` 不出现在图改写路径 |
| **A2** | **动态必须可审计、可重放。** 每次图改写落 `graphRevisions[]`，重放同一 revision 序列必须得到同一结果 | 同一输入双跑，`computeGraphHash` 序列与终态 vars 逐字符相等 |
| **A3** | **单一真源。** 节点类型只有 `nodeCatalog` 一处；执行器必须**消费**它，不得持有第二套清单 | §1.1 的 parity 对账（单向包含） |

---

## 4. 与既有机制的边界表

| 既有件 | 它管什么 | 本方案做什么 | 边界（不碰什么） |
|---|---|---|---|
| `[DESIGN-ARCH-009]` 可视化拖拽工作流编辑器 | 画布的**编辑体验**（拖拽 / 属性面板 / 导入导出） | 运行**时**行为与引擎结构 | 不改编辑器交互；前端 `BaseNode.vue` 已通用，**零改动** |
| `nodeCatalog.js` | 节点类型的**声明 SSOT** | 让执行器消费它（handler 表） | **不新增第二套清单**；新类型一律先登记目录 |
| `flowRegistry.js` | 沉淀 / 重放 / 意图匹配 | 复用其哈希与形状闸 | 不改其 IO 面（`save`/`load`/`list`/`find` 签名不变） |
| `flowsEngine.js`（`FLOW_STATE`） | 另一条流程状态机路径 | **不动** | ⚠ 与 `runGraph` 是**两条独立路径**，本方案只覆盖 `runGraph`；二者关系**登记为未决**（§10-Q4） |
| `orchestrationService.js` / `taskScheduler.js` | 多智能体编排、拓扑排序 | **不动** | 编排 ≠ 图执行，不复用其调度器（避免引入环依赖） |
| `[DESIGN-ARCH-130]` 前台/后台任务编排 | 任务生命周期与前台/后台切换 | **不动** | 边界 = 它管「任务怎么活」，本方案管「图怎么跑」 |
| `releaseGateStages.js` | 发布门阶段（`tier`/`kind`） | **仅作「阶段」范式参照** | 不混用阶段表 |

---

## 5. 四个动态面的设计

### D1 运行时自演化（真空白，G3）

**做法**：把 `nodes` / `outEdges` 两个 `Map` 从闭包局部变量提升为可传递的 `GraphView` 对象，并给 `primitives` 注入一个**受控**改写句柄。

> **落地状态（2026-09-24）**：第 ① 步（提升为**就地可改写的 GraphView**）与两个新类型
> **均已落地** —— `graphPatch`（§12.7）含**边级 `disconnect`**（§12.8）与**运行期补丁来源
> `onVar`**（§12.11），`expand`（§12.9）。**D1 至此全部落地。**
> ⚠ 此前写的「`onVar` 的前置是 D2 闭环闸，已就位 ⇒ 前置已满足」**不精确**，订正见 §12.11：
> D2 的闸在**沉淀边界**（`flowRegistry.save`），而 `onVar` 的补丁是**运行期**改写、**从不经过它**。
> ⚠ **曾记录的限制、现已解除**：`nextNode()` 对每个 `(from, fromPort)` **只认第一条边** ⇒ 在
> 「删除默认禁」之下，加法补丁**只能在尚无出边的位置生效**。§10-Q2 收窄为「禁删**节点**、
> 允许删**边**」后，先 `disconnect` 旧边再 `connect` 即可把新节点插入**已存在**的边（§12.8）。

新增两个节点类型（**必须先在 `nodeCatalog` 声明**，否则画布不可达且校验会拒）：

| 类型 | 语义 | 关键字段 |
|---|---|---|
| `expand` | **动态扇出**：按运行期数据决定实例数，把子图模板内联 N 份并**串成链**（**已落地** §12.9） | `templateId`（**只引用已存 flow**，Q1 裁决）、`sourceVar`（决定实例数）、`itemVar`（逐份绑定，默认 `item`）。⚠ 模板按**片段**处理（去 start/end，须单入口单出口）—— 依据见 §12.9 的两条实测 |
| `graphPatch` | **受限图改写**：接受补丁 DSL，**不是 JS** | `ops: [{op:'addNode'\|'connect'\|'disconnect', ...}]`、`onVar`（补丁来源变量，**已落地** §12.11：数组直用 / 字符串容错解析 / **失败不回落 `ops`**） |

**★ 最重要的防呆（安全边界）**：`code` 节点已有 `new Function`，其注释（`workflowExecutor.js:230-236`）明确声明信任边界 = 「用户自己的图，同 Bash 节点」。**但图改写不能同权** —— 图是**引擎结构**，改写它等于改写后续**所有**节点的执行权，量级不同。因此：

- `graphPatch` 只接受**数据补丁**，绝无代码执行；
- **删除节点/边默认禁止**，需显式开关（默认关）；
- 每次改写后**必须**重新过 `checkGraphShape()` + `portsFor()` 端口校验；
- **事务性**：先算新图 → 校验 → 通过才替换引用。**绝不允许半改状态**。

**审计**：`run.graphRevisions[] = { seq, nodeId, op, beforeHash, afterHash }`，哈希用 `flowRegistry.computeGraphHash`（复用，零新实现），随 `log_json` 一同持久化。

**上界**：`MAX_STEPS=1000` 之外新增 `MAX_NODES` 与 `MAX_REVISIONS`（防 `expand` 无限扇出把图撑爆）。

### D2 AI 生成与自改（已有大半，补闭环闸）

**已有**：`flowRegistry.save/find` 的沉淀-重放、`RPATool` 的 `healedFrom` 自愈协议、`workflowGenerateService` 的生成。

**缺口**：自愈是**AI 按提示词手工做**的（`flowPriorityDirective.js:104` 是一段文字指令），**没有引擎级校验闸**；且 `healedFrom` 零消费方（§1.3）。

**设计**：
1. **自愈闭环闸**：自愈产生的新版本必须让 `contractChecker` 的既有 5 种断言（`fileExists` / `fileContains` / `varContains` / `windowTitle` / `httpStatus`）**全绿**才算 healed，否则退回 `healedFrom` 链上的上一版。
2. **把 `healedFrom` 变成真判据**：自愈链深度上限 + 根因节点必须**存在于上一版图中**（否则该自愈是幻觉）。
3. ⚠ **不新增断言类型**，不新增第二套契约。

> **落地状态（2026-09-24）**：点 2 与点 1 的**重放侧裁决**已落地（§12.10）。
> **契约闸本体早已存在**（`RPATool.run()` 重放后调 `checkContract`，未通过即 `success:false`）——
> 本次补的是「`healedFrom` 链」那一半，即把**只写不读**的 `healedFrom` 变成真判据。
>
> **★ 一条文档没暴露的硬约束（实测取证）**：「否则退回 `healedFrom` 链上的上一版」在本方案的
> 存储模型下**物理不可行** —— `flowRegistry.save()` **原地覆盖**同一文件，`_meta.previousVersion`
> 只是个数字（**零消费方**），全仓**无回滚能力、无历史版本存储**。⇒ 裁决 **只报不滚**：
> 只出裁决与 `rollbackTarget`，物理回退交给调用方（AI / hq）。
>
> **两条裁决（见 §10.1 的 Q6 / Q7）**：**只报不滚**；深度上限**持久化为 `_meta.healDepth`**（上限 **5**）。

### D3 动态调度（部分空白）

**现状实测**：`claimNext()` 的 `order` 是 `[['id','ASC']]`（quantum 关）或 `[['updatedAt','ASC'],['id','ASC']]`（quantum 开）；`tick()` 每 tick 只认领并执行 **1** 个 run（`:290-295`，串行）；**无 `priority` 列**（§2.1）。

**设计**（分两小步，第一步零 schema 变更）：
1. **零 schema**：把 `priority` 派生自**等待时长（老化 aging）**，排序键改为 `[['updatedAt','ASC'],['id','ASC']]` 已有形态即可承载；**不静态写死优先级**。
2. **需扩真源**：`workflow_runs` 加 `priority` 列（默认 0）+ 复合索引 `[status, priority, updated_at]`，排序键 `[['priority','DESC'],['updatedAt','ASC'],['id','ASC']]`。

**★ 防饿死判据（硬性）**：任何优先级方案都必须证明**低优先级不会被饿死** —— 必须配一个反例场景：持续高优入队时，低优 run 的**最大等待上界有限**。只测「高优先跑」不测「低优仍会跑」= 恒真断言。

**⚠ 并发度红线**：`workflowRunWorker.js:11-13` 注释明说该 poller **与实盘交易后端同进程**。故 `KHY_WORKFLOW_CONCURRENCY` 默认 **1**（= 零行为变化），升并发**另立提案**，不在本方案内。

### D4 动态节点热插拔（真空白，G1+G2）

**现状**：`nodeCatalog` 被 5 处消费（`workflow.js:26`、`workflowExportService.js:28/88/188`、`workflowService.js:20/106/134/137`、`cli/handlers/workflow.js:57`、`workflowCliCore.js:15-17`），**唯独执行器不消费**。

**设计（这是整个方案的地基，也是第一步）**：
1. 执行器改 **handler 表驱动**：`NODE_HANDLERS: Map<type, fn>`，`runGraph` 查表；**表里缺该类型 ⇒ 抛错（fail-closed）**，取代 `default:` 静默 skip。
2. 加 **节点类型对账守卫**（原型已就绪，§9）：判据 = 目录类型集合 ⊆ 执行器 handler key 集合（**单向**，目录是权威）。
3. 前端 `BaseNode.vue` 通用，**零改动**。

**⚠ 诚实的边界**：实测当前 **11 == 11，无存量差异**。所以这条守卫是**防回归**，不是清存量。这反而是好消息 —— 意味着可以在**不背存量债**的前提下把它做成 error 级。

### D5（「两者打通」）用引擎驱动项目自身开发流程

**hq 侧现状**：`cli/hqStore.js` 的 `TASK_STATES = ['todo','doing','review','done']`（4 态）、`BUG_STATES`（5 态），`canTransition():269` 是**唯一裁决点**；`TYPE_TO_TEMPLATE:153` 把 12 种 kind 映射到 `.ai/hq/prompts/` 的模板。

**打通方式（推荐：hq 只做「触发 + 记账」，引擎做「执行」）**：

```
khy hq next  →  按 type 选模板  →  生成一张图  →  入队 workflow_runs  →  worker 执行
                                        ↑                                        │
                                        └──── 终态回写（走 canTransition）←──────┘
```

- 这是 D1 的**第一个真实消费者**：`expand` 让「一个任务按发现的子问题动态展开」成立（而 `TYPE_TO_TEMPLATE` 的静态 12 选 1 做不到）。
- ⚠ **边界（硬性）**：**不把 hq 状态机搬进图里**。hq 状态迁移一律走 `canTransition()`，图只负责「执行」；否则 `canTransition` 会失去「唯一裁决点」地位，制造第二套状态真源。

---

## 6. 防呆铁律（每条都有可自动判的判据）

| # | 铁律 | 判据（可自动判） | 现状 |
|---|---|---|---|
| F1 | 目录声明的每个节点类型，执行器必须有 handler | parity 对账（§9 `--scenario=parity`） | ✓ 已可判（探针就绪） |
| F2 | 未知节点类型必须 **fail-closed**，不得静默 skip | 未知类型图必须抛错 | ✓ 已修（步 3，`default:` → `throw`） |
| F3 | worker 路径必须校验图 | worker 源含 `getNodeType(` / `assertGraph` | ✓ 已修（步 3，`assertGraphNodeTypes`） |
| F4 | 图改写必须过 `checkGraphShape` + 端口校验，且**事务性** | 改写前后哈希 + 校验返回码 | ✓ **已实现**（§12.12）：`beforeHash` **可被独立重算**；被拒补丁不落审计且图逐字段不变 |
| F5 | 图改写必须落 `graphRevisions`，同 revision 序列可重放 | 双跑对比终态 vars 逐字符相等 | ✓ **已实现**（§12.12）：审计随 `log_json` 落盘；双跑哈希序列 + 终态 vars 逐字符相等，含**有牙对照**；⚠ 审计**形状**分歧登记为 §10-Q9 |
| F6 | 自愈版本必须 `contract` 全绿才算 healed | 契约断言全绿 | ✓ **已实现**（§12.10）：契约未全绿 ⇒ `healRejected`；未声明 `contract` ⇒ `healUnverified`（**不得算 verified**） |
| F7 | `priority` 不得静态写死（必须含老化项） | 反例场景：低优 run 最大等待上界有限 | 待实现（D3） |
| F8 | 并发度默认 1（零行为变化） | 默认配置下 tick 行为快照与 HEAD 一致 | ✓ 当前即 1 |
| F9 | **图改写不得引入代码执行**（`graphPatch` 只收数据） | 源码断言：图改写路径无 `new Function` / `eval` | ✓ **已实现**（§12.12）：复用 `stripComments` 的源码断言 + **非平凡闸** + 载荷哨兵对照；⚠ 判定面由 `graphPatch` 的**直接依赖派生**并**自校验**（漏登记即测试变红） |

---

## 7. 强度梯度（过早阻断会逼 AI 撒谎）

| 阶段 | 表达 | 说明 |
|---|---|---|
| **事前（步 1–2）** | `gate: "commit"` + `severity: "advisory"` | 只记录不阻断。⚠⚠ **绝不能用 `gate: "advisory"`** —— `GATE_ORDER.advisory=4 > max=2`，该规则**永不执行**，且所有守卫全绿（空接线最难发现） |
| **事中（步 2 后观察期）** | `severity: "warning"` | 误报率 < 10% 后升档 |
| **事末（步 3 收口）** | `severity: "error"` | 仅对 F1/F2/F3 —— 实测**零存量债**（F1 本就一致、F2/F3 已于步 3 修复），可安全升 error |

> 强度必须**按阶段派生**（`severityFor(criterion)` 单点函数），不得在判定处写死 `warning` —— 否则 `STAGE` 常量变成装饰，S1 与 S3 跑出相同结果与退出码，升级后仍不拦截。

---

## 8. B-L2 三步接线清单（**一次提交只做一步**，违反 SOURCING-006）

### 步 1「标记」（本次交付）
- 本文件 + `_产物/workflow-dynamic-probe.js` + `_产物/workflow-dynamic-probe.lib.js`
- 规则 ID **只写在文档里**，**不建执行器、不改登记表**（避免 `check-wiring` 判「执行器不存在」）

### 步 2「迁移」
1. 判定逻辑迁入 **`scripts/lib/workflowNodeParityGuard.js`**（纯叶子：零 IO、确定性、绝不抛、可单测）
2. IO 层迁入 **`scripts/ci/check-workflow-node-parity.js`**
3. `package.json` 加别名 `` `check:workflow-node-parity` ``（裸名，**不写 `npm run` 前缀**，避免 `dangling-task`）
4. `docs/10_规范/registry/RULES-REGISTRY.json` 补条目：`domain` 十域封闭枚举内选 **`TOOLING`**；`gate:"commit"` + `severity:"advisory"`；`formerly` 写字符串 `"无"`；同步 `meta.ruleCount`
5. 本文件第 3 行加 `<!-- RULES-REGISTRY: <新ID> -->`（**标记行语义 = 本文件是 ssot**）
6. 规则卡重生成 + `FEATURE-OWNERSHIP.json` → `rollout.mechanisms[]` 加阶段登记（`stage:"S1"` + `executorStage{file,constant}`）
7. **验收（缺一即假绿）**：`rules:gate:commit` 输出里必须看到该执行器的 `action=start`

### 步 3「收口」
- 执行器改 handler 表 + fail-closed（F2/F3）
- `severity` 升 `warning` → `error`
- D1/D2/D3 按 §10 的裁决结果分别立子提案

---

## 9. 复现方式（可直接粘贴）

```bash
# 语法
node --check _产物/workflow-dynamic-probe.js

# 全场景（含反例矩阵）
node _产物/workflow-dynamic-probe.js --scenario=all --verbose

# 单场景
node _产物/workflow-dynamic-probe.js --scenario=parity --verbose
node _产物/workflow-dynamic-probe.js --scenario=silent-skip
node _产物/workflow-dynamic-probe.js --scenario=frozen-graph
node _产物/workflow-dynamic-probe.js --scenario=divergence
```

**持久化守卫（步 2 落地，已纳入版本控制）**：

```bash
node scripts/ci/check-workflow-node-parity.js                    # 全量
node scripts/ci/check-workflow-node-parity.js --scenario=matrix   # 反例矩阵（5/5，含"应放行"对照）
node scripts/ci/check-workflow-node-parity.js --verbose           # 附目录/执行器类型清单
node --test services/backend/tests/workflowExecutor.failClosed.test.js   # 行为测试（5 条）
```

**反例矩阵（每条反例 → 预期 finding）**：

| 场景 | 输入 | 预期 | 实测 |
|---|---|---|---|
| 应放行 | 原始仓库 | 0 条 missing | ✓ 0 条 |
| 应拦 | 注入目录类型 `expand` | 报 `workflow-node-missing-handler` | ✓ 报出（12 vs 11） |
| 应拦 | 图含未知类型节点 | 不得 `completed` | ✓ 实测 `completed`（**当前 fail-open，正是 F2 要修的**） |
| 应拦 | 运行期注入节点 | 不得被执行 | ✓ 未执行（证明 G3） |

> ⚠ 探针位于 `_产物/`（`.gitignore:214` 的 `/_产物/`）⇒ **新克隆的检出里没有它**。它是步 1 的临时证据，步 2 才迁入 `scripts/lib/` 纳入版本控制。

---

## 10. 未决问题（**需人裁决，本方案不代为决定**）

| # | 问题 | 影响面 | 备注 |
|---|---|---|---|
| **Q1** | `expand` 的子图模板从哪来？（内联 JSON / 引用已存 flow / AI 现生成） | **安全边界差一个数量级**：AI 现生成 = 运行期执行未经审阅的图结构 | 建议先只支持「引用已存 flow」，AI 生成留到 D2 闭环闸就位后 |
| **Q2** | 运行时是否允许**删除**已有节点/边？ | 影响在飞 checkpoint 语义（`pending_json.loopState` 可能指向已删节点） | 建议默认禁，需显式开关 |
| **Q3** | `priority` 公平算法选哪种？（老化 aging / 配额 / DRR） | 决定 D3 是否真的需要扩真源 | 建议先做零 schema 的老化版 |
| **Q4** | `flowsEngine.js`（`FLOW_STATE`）与 `runGraph` 是**两条并行路径**，是否收敛？ | 不收敛 ⇒ 本方案的四个动态能力**只覆盖一半路径** | 本方案**只声明覆盖 `runGraph`**，不擅自合并 |
| **Q5** | D5 打通是否要动 `canTransition`？ | 动它 = 失去唯一裁决点 | 本方案建议**不动**，图只做执行 |
| **Q8** | `graphPatch.onVar` 的补丁**值形态**？（结构化数组 / 字符串需解析 / 两者） | 决定「AI 产出的补丁」能否直接用 —— 字符串形态等于放开**运行期执行未经审阅的图改写**（与 Q1「AI 现生成」同一风险类） | 原文只有「补丁来源变量」六字；建议**最窄**（只接受数组），后续放开是严格超集 |

### 10.1 裁决结果（2026-09-24，人裁决）

| # | 裁决 | 落地含义 |
|---|---|---|
| Q1 | **只支持「引用已存 flow」** | `expand.templateId` 指向已审阅的 flow；不做内联模板，更不做 AI 现生成（留到 D2 闭环闸就位后） |
| Q2 | **删除默认禁，需显式开关** → **2026-09-24 收窄：禁删节点、允许删边** | `removeNode` / `deleteNode` **仍一律被拒**（`pending_json.loopState` 指向**节点**，删节点会产生悬空）；`disconnect`（**只删边**）**已放开**（§12.8） |
| Q3 | **未裁决** | D3 扩 schema 前需再问一次（其「零 schema 老化排序」那一步实测**已是现状**） |
| Q4 | **不收敛，只覆盖 `runGraph`** | `flowsEngine.js`（`FLOW_STATE`）保持原样；本方案的动态能力**只声明覆盖 `runGraph`** |
| Q5 | **未裁决** | D5 打通前需再问一次 |
| Q6 | **只报不滚** | 契约不通过时只出裁决 + `rollbackTarget`，**不做物理回退** —— 实测无「上一版图」可退（§12.10） |
| Q7 | **深度持久化为 `_meta.healDepth`，上限 5** | 跨版本计数必须持久化，否则深度闸无从判；超限即拒 save |
| Q8 | **两者都接受**（数组直接当补丁；字符串按容错解析，**结果必须是数组**） | `resolvePatchOps` 纯叶子；`onVar` 优先级高于 `ops` 且**失败不回落**；审计 `entry.revision.source` 记出处（§12.11） |
| Q9 | **未裁决** | F5 审计的**形状**归宿：文档写 `run.graphRevisions[] = {seq, nodeId, op, beforeHash, afterHash}`，实现是 `log[].revision = {seq, beforeHash, afterHash, source, ops}`（**更宽**且已随 `log_json` 持久化）。判据已满足，形状分歧按 `PROCESS-011` 待人裁决（§12.12） |

> **早期三项**（Q1 / Q2 / Q4）**都选了最窄选项** —— 这是有意的：最窄选项是其余选项的**严格子集**，
> 所以后续放开只需**新增来源 / 打开开关**，不必重写已落地的部分。
>
> ⚠ **Q8 是例外**：它选了**最宽**的「两者都接受」。原因是运行期补丁的**两种来源都要用**
> （结构化来源给控制平面，字符串形态给 AI 产出），只留最窄会让 `onVar` 对后者的用途失效。
> 代价（放开「运行期执行未经审阅的图改写」）由「**运行期补丁不落盘**」这条边界兜住（§12.11 残留边界）。
> 也就是说 Q8 **没有**沿用「最窄优先」，所以它的残留边界必须**显式登记**，
> 不能默认被「严格子集」这条性质覆盖。
>
> **Q9 是新增的未裁决项**：它不涉及行为放开，只涉及**审计形状**（文档 vs 实现），
> 因此不阻塞任何已落地能力 —— 但**必须登记**，否则「文档写的形状」与「实际落盘的形状」会长期分叉。

---

## 11. 相关文档

- `[DESIGN-ARCH-009]` 可视化拖拽工作流编辑器 —— 画布层背景（边界见 §4）
- `[DESIGN-ARCH-130]` 前台与后台任务编排方案 —— 任务生命周期（不重叠）
- `[OPS-MAN-057]` 工作流引擎 `khy workflow` —— CLI 面操作手册
- `[DESIGN-LAY-005]` 仓库层级板块规范 —— 本方案落点合规依据
- `[DESIGN-ARCH-111]` 规则遵守保障 —— 门成员资格从登记表派生（§8 步 2 的依据）

## 12. 落地记录（2026-09-23）与对原方案的两处必要订正

### 12.1 已落地（步 2 + 步 3，同一日）

| 项 | 产物 | 验收 |
|---|---|---|
| 规则登记 | `TOOLING-011`（`domain: TOOLING`，`gate: commit` + `severity: advisory`） | `check:wiring` / `check:rules` / `check:gov-rules` 全绿 |
| 判定叶子 | `scripts/lib/workflowNodeParityGuard.js`（纯叶子，零 IO、绝不抛） | 走盘层与原型**共用同一实现** |
| 执行器 | `scripts/ci/check-workflow-node-parity.js` + 别名 `check:workflow-node-parity` | `rules:gate:commit` 里有 `action=start`（证明**真被执行**） |
| 阶段登记 | `FEATURE-OWNERSHIP.json` → `rollout.mechanisms[]`（`workflow-node-parity-guard`，S1） | `check:rollout-stage` 无漂移 |
| 规则卡 | `docs/10_规范/规则卡/[TOOLING-011] 工作流节点类型接线一致.md` | `check:rules`（TOOLING-008 逐字节一致）通过 |
| **F2 修复** | `workflowExecutor.js` 的 `default:` 由「标 skipped」改为 **`throw`** | 未知类型图现在**抛错**，不再报 completed |
| **F3 修复** | `workflowRunWorker.assertGraphNodeTypes()`，在 `executeRun` 的 `try` 内前置校验 | worker 侧拒绝未声明类型 |
| 行为测试 | `services/backend/tests/workflowExecutor.failClosed.test.js`（`node:test`，5 条） | 5/5 通过（含「应放行」对照） |

**实测验收**：守卫 0 error / 0 warning；反例矩阵 **5/5**（含「应放行」对照与升阶自检）；
探针 `--scenario=all` 中 F2/F3 均由 error 转为 ok，**仅剩 G3（图启动即冻结）** —— 那是 D1 的范围，尚未实现。

### 12.2 订正一：**不引入 handler 表**，只把 `default:` 改为 `throw`

原方案 §5-D4 写「执行器改 handler 表驱动：`NODE_HANDLERS: Map<type, fn>`，`runGraph` 查表」。
**落地时改为最小 diff**：只把 `default:` 分支改成抛错，`switch` 结构不动。

理由：`switch` 的 **`case` 标签集合本身就是「已实现类型」的声明面**，守卫已能对它做单向包含校验
（`analyzeParity` 抽的就是 case 标签）。再引入一张 `NODE_HANDLERS` 表，等于**多出一处需要与 switch
同步的真源** —— 违反本方案自己的公理 A3（单一真源），而且新表与 switch 之间又要多一条守卫。

**判据（可复用）**：若某个结构改动**不增加可自动判定的不变式**，就不要为它引入新的同步点。

### 12.3 订正二：worker 校验必须放在 `try` **之内**（否则制造僵尸 run）

`workflowRunWorker.tick()` 的设计是「任何错误都吞掉，绝不因一个坏 run 打崩后端」。
若把前置校验放在 `executeRun` 的 `try` **之外**，抛错会直接逃到 `tick()` 被吞 ——
**该 run 会永远停在 `running`**：没有任何 worker 会再来收尾（`recoverStale` 要等
`KHY_WORKFLOW_STALE_MS`，而那行的 `updatedAt` 从未被更新过）。这比「静默成功」更糟。
⇒ 校验必须放在 `try` 内，走正常的 `status:'failed'` 写回路径。

**判据（可复用）**：往一个「吞掉所有异常」的消费者里加前置断言时，先问
**「抛出去之后，谁会把它变成终态？」** 答不上来，就必须放进现有的错误处理块里。

### 12.4 未落地（本方案的其余部分）

D3（动态调度）与 D5（打通 hq）**未实现**（**D1 运行时自演化已于 2026-09-24 全部落地** ——
步 A / B / C / D 见 §12.7 / §12.8 / §12.9 / §12.11，**铁律判据 F4 / F5 / F9** 见 §12.12；
**D2 自愈闭环闸**见 §12.10），
前置裁决见 §10-Q1~Q9。本文件仍是这几项的语义真源。

### 12.5 验收记录（同日复跑，含一处外部红牌的处置）

| 命令 | 结果 |
|---|---|
| `node scripts/ci/check-workflow-node-parity.js` | `Summary: 0 error(s), 0 warning(s).` |
| `node scripts/ci/check-workflow-node-parity.js --scenario=matrix` | 矩阵 **5/5**（含「应放行」对照 + 升阶自检 S1=0 / S3=1） |
| `npm run test:workflow-node-parity` | `# pass 5 / # fail 0` |
| `npm run rules:gate:commit` | `action=pass target=scripts/ci/check-workflow-node-parity.js … errors=0` |
| `npm run check:wiring` | 93 个检查器全部接线（豁免 11 项），无死指针 |
| `npm run check:rules` | 通过（途中一度红，见下） |
| `npm run check:gov-rules` / `check:rollout-stage` | 全绿 |
| `npm run rules:coverage` | 93 条 / 已执行 81（87.1%），无 P0 红线 |
| `npm run docs:verify` | `✓ 全部通过：每个 md 都有 html，所有本地链接可达，资源齐全。` |

**⚠ 验收途中撞到的一处外部红牌（非本方案引入，已处置）**：
`check:rules` 曾报 `TOOLING-008`「2 份产物与登记表不一致」—— `[DOCS-003]` 与 `[PROCESS-004]`
两张规则卡陈旧。原因是**同日另一路改动修改了 `RULES-REGISTRY.json`（移除 `windsurf` 残留），
却没有重跑规则卡生成器**。处置：`node scripts/docs/gen-rules-cards.js` → `check:rules` 转绿。

**判据（可复用）**：**改登记表 = 必须重跑规则卡生成器**。卡片是产物、登记表是真源，
两者的字节一致性由 `TOOLING-008` 兜底 —— 但**兜底只在被跑到时才生效**：
不跑 `check:rules` 就会带着陈旧卡片提交，且卡片陈旧**不会**让任何其它守卫变红。

**附带改动说明**：为使 `.md` 与 `.html` 孪生件保持一致，本次重跑了全量文档站生成器，
净附带 4 个 `.html` 变更（3 个是**陈旧孪生件追平**：`[DOCS-003]`、`[PROCESS-004]`、
`context-engineering/prompt.html`；1 个是另一路新增文档的必需孪生件 `[DESIGN-ARCH-142]`）。
均为生成器的正确产物，无手工编辑。

### 12.6 补做：§1.3 的第一条漂移（原为「已报告但未落地」）

§1.3 表格原写「注释订正为 `loopState`」，**但落地时并没有真的改** —— 2026-09-24 复跑发现
三份副本的 `WorkflowRun.js:97` 仍是旧文本。已补做，并顺带纠正原表格的两处不准：

1. **路径不准**：原写 `vendor/shared/src/models/WorkflowRun.js`，实际有**三份副本**都要改 ——
   `platform/packages/shared/src/models/`（工作区真源）、
   `services/backend/vendor/shared/src/models/`（`services/backend` 的 `file:` 依赖目标）、
   `software/khyquant/models/`（第三份）。三者之间**没有**一致性守卫。
   ⚠ 附带发现：`vendor/shared` 那份是 **CRLF**，另两份是 **LF**（既有不一致，本次保持原样）。
2. **载荷描述不准**：不只是「`cursor`/`vars` 改叫 `loopState`」—— `pending_json` 实际承载
   **两种带判别符的形状**（提问停车 vs quantum 让出，见 §1.3 表），旧注释漏了第二种。

**判据（可复用）**：**「顺手订正」这类一句话结论，必须在同一轮里回读原文件复核**；
否则文档会留下「已完成」的假状态，而代码里的缺陷仍在 —— **这比不写更坏**（下一个人不会再去看）。
复核方式：`git grep -n "<旧文本>"` 应为 **0 处**。

### 12.7 D1 步 A：受控图改写（`graphPatch`）已落地（2026-09-24）

§10 的 Q1/Q2/Q4 已获人裁决（见 §10.1），D1 按其**最窄子集**落地了第一步。

**本次落地**

| 项 | 产物 |
|---|---|
| 纯叶子 | `services/backend/src/services/domain/project/workflow/graphPatch.js`（零 IO、绝不抛、可离线单测） |
| 执行器 | `workflowExecutor.js`：`nodes` / `outEdges` / `connections` 提为**就地可改写的 GraphView**；新增 `case 'graphPatch'` |
| 节点类型 | 两份 `nodeCatalog.js` 声明 `graphPatch` ⇒ **12 型**（`platform/packages/shared` 与 `services/backend/vendor/shared`） |
| 导出器 | `workflowExportService.instructionFor` 补 `graphPatch` 分支 |
| 行为测试 | `services/backend/tests/workflowExecutor.graphPatch.test.js`（13 条）+ 既有「放行对照」扩到 **12 型** |

**为什么「提升 GraphView」不能单独落地**：只把两个 `Map` 提出来、不给任何消费者，等于
制造一个**新空头支票**（正是 §1.3 批评的那一类）。所以步 A 必须带一个真消费者 ——
`graphPatch` 就是它，且它是**纯数据改写、不引入新的 IO 原语**。（`expand` 需要从存储读
flow，得先加 `primitives.loadFlow`，那是下一步。）

**★ 一条落地时改出来的约定（对齐既有范式）**：`graphPatch.js` 最初自己 `require` 了
`nodeCatalog`，落地时改回**注入式** —— `portsFor` / `knownTypes` 由调用方传入，
缺失即**拒绝**（fail-closed），绝不「拿不到类型集合就放行」。依据是同目录的
`workflowCliCore.validateGraph` 早已定了这条约定（纯叶子不 require catalog，把端口词汇
与类型集合作为参数注入）；执行器侧配合用**惰性 require**（只有真跑到 `graphPatch` 节点才
加载 catalog，不给每次 run 都挂一条 require 链）。

> 该 fail-closed 行为有**专门回归测试**，并用反向对照验证过它真的会变红：把 catalog
> 作为「兜底」`require` 回来（最可能的 fail-open 回归形态）后，`applyPatch(无注入).ok`
> 变为 `true` ⇒ 断言 `strictEqual(ok, false)` 必然失败。**不是恒真断言。**
**★ 落地时补的一条错误精度（可复用）**：`portsFor` 是**注入**的，不能假设它一定不抛。
契约是「绝不抛」，于是包了一层防御 —— 但第一版把失败**退化为「空端口」**，结果是：
注入能力坏掉时，报出的错误是「非法源端口」—— **把矛头指向补丁，而真因在注入**。
已改为失败返回 `null`，调用点据此报**另一条**错误（「注入的 `portsFor` 对类型 X 不可用」），
两类失败因而**可区分**。两者都是 fail-closed，但错误串不同。

> **判据（可复用）**：★★ **fail-closed 不等于「错误报对」** —— 「一律拒绝」只保证不放行，
> 不保证调试者能定位。**当同一个拒绝点有两种成因时，错误串必须能区分**，否则等于把
> 「静默失真」换成了「误导失真」。有专门的回归测试钉死两类错误串互不串味。
**★ 本次实测出的一个硬限制（已记录 → 已于步 B 解除）**：`nextNode()` 对每个
`(from, fromPort)` **只认第一条边**（`edges.find(...)`）。而当时 Q2 裁定「删除边默认禁」
⇒ **加法补丁只能在「该 `(from, fromPort)` 尚无出边」的位置生效**，无法把新节点插入一条
**已存在**的边（新边被既有的第一条边遮蔽，游标仍走老路 —— 又是一次「成功但没跑」）。

⇒ 这不是 bug，是「加法-only」的必然代价。**已按当时提出的切口落地**：Q2 收窄为「禁删
**节点**、允许删**边**」，`disconnect` 放开后即可插入已存在的边。**解除过程与对照判据见 §12.8。**

**判据（可复用）**：★★ **把「只读闭包」改成「可改写」时，先问「谁按什么规则选边」** ——
本次若不做这个检查，会以为补丁生效了，而实际游标被既有的第一条边挡住。
且判据必须是 **「新增的节点真的被执行」**，不能是「补丁被接受」（后者是恒真断言）。

**判据二（可复用）**：★ **纯叶子要「可离线单测」，就不能自己 `require` 任何有 IO/单例的模块** ——
把能力做成**注入参数**并**缺失即拒绝**。反过来，「缺失时兜底 `require` 回来」是最像「方便」、
实则同时破掉「零耦合」与「fail-closed」的写法，务必用一条反向对照把它钉死。

**后续（本步当时未落地，现均已落地）**：`disconnect` → **步 B**（§12.8）；`expand` → **步 C**（§12.9）；
`graphPatch.onVar` → **步 D**（§12.11）。**D1 至此全部落地。**

**验收（步 A 当时）**：守卫 `0 error / 0 warning`（目录 12 型 / 执行器 12 型）；反例矩阵 **5/5**；
行为测试 **18/18**（13 新 + 5 既有）；`check-agent-rules --changed` 仍为 **17 error**（与改动前
**同数同项**，全是存量）；`archDebtScan` **未点名本次任何文件**。

### 12.8 D1 步 B：边级 `disconnect` 已落地（2026-09-24）

§10-Q2 的原文禁的是「删除**节点/边**」。经人裁决**收窄**为：

| 收窄项 | 结论 | 依据 |
|---|---|---|
| 删**节点**（`removeNode` / `deleteNode`） | **仍一律拒绝** | 在飞 checkpoint 的 `pending_json.loopState` 指向**节点**，删节点会产生悬空 |
| 删**边**（`disconnect`） | **放开** | 只改拓扑、不动节点集合，不产生上述悬空 |

**本次落地**

| 项 | 产物 |
|---|---|
| 纯叶子 | `graphPatch.js`：`disconnect` 从禁列移入 `ALLOWED_OPS`；新增 `NODE_DELETE_OPS`（仍禁）。算子形态 `{op:'disconnect', from, fromPort?, to?}` —— 省略 `to` 即删该 `(from, fromPort)` 的**全部**出边 |
| 执行器 | **零改动** —— 既有的「补丁提交后就地重建 `outEdges`」已足够（步 A 的 GraphView 设计在此兑现） |
| 审计 | 沿用既有 `entry.revision.ops`（**零 schema 变更**），`applied` 条目带 `removed` 条数 |
| 行为测试 | `workflowExecutor.graphPatch.test.js` 新增 5 条（含 1 条**对照**），并更新 1 条既有（原「删除类算子被拒」） |

**★ 这一步的真正价值：解除 §12.7 记录的硬限制。**
`nextNode()` 对每个 `(from, fromPort)` 只认第一条边 ⇒ 加法-only 无法把节点插入**已存在**的边。
有了 `disconnect`，先摘旧边、再连新边即可插入。

**判据（可复用）**：★★ **「解除了一个限制」这个声明本身必须有对照。** 本次配了两条**只差一个
`disconnect`** 的测试：

| 场景 | 期望 | 实测 |
|---|---|---|
| 有 `disconnect`（addNode + disconnect + connect ×2） | 新节点 `mid` 被执行 | `seen = ['outer', 'inner']`，`vars.inner = 'chat:inner'` ✓ |
| **无** `disconnect`（同补丁去掉那一行） | 新节点被既有第一条边遮蔽 | `seen = ['outer']`，`vars.inner = undefined` ✓ |

**没有后者，前者就是恒真断言** —— 因为「补丁被接受」与「节点真的跑了」是两件事，这正是 G3 的形态。

**⚠ 残留风险面（诚实登记）**：`disconnect` 允许把边删到某节点**不可达**（例如摘掉指向 `end` 的
唯一入边）。当前 `validateGraph(strict)` **不查可达性**，所以这类图会通过校验，run 在
`nextNode()` 返回 `null` 时正常收尾。这是**已知且刻意**的边界：删边只改拓扑，不会让在飞
checkpoint 悬空。若将来要收紧，应作为**独立一步**加「可达性」判据，而不是在 `disconnect`
里做特例。

**后续（本步当时未落地，现均已落地）**：`expand` → **步 C**（§12.9）；
`graphPatch.onVar` → **步 D**（§12.11）。**D1 至此全部落地。**

**验收**：守卫 `0 error / 0 warning`（目录 12 型 / 执行器 12 型）；反例矩阵 **5/5**；
行为测试 **23/23**（18 新 + 5 既有）；`check-agent-rules --changed` 仍为 **17 error**（与改动前
**同数同项**，全是存量）；`archDebtScan` **未点名本次任何文件**。

### 12.9 D1 步 C：动态扇出 `expand` 已落地（2026-09-24）

§10-Q1 已裁「**只支持引用已存 flow**」；本次裁决把**内联接线**定为**串行链**，
并新增一条**文档原本没暴露的硬约束**的处理方式：**模板当作「片段」（去 start/end）**。

**★ 两条实测取证（正是它们决定了「片段」这个形态）**

| 探针 | 结果 |
|---|---|
| 把一份模板（自带 `start`）原样内联 | **被拒**：`图必须恰好有一个 start 节点(实际 2)` —— 任何可独立运行的 flow 都必然有 `start` |
| `case 'end'` 的语义 | **`return {status:'completed'}`** ⇒ 模板里的 `end` 会**终止整轮 run**，串行链断在第一份 |

故模板被当作**片段**：只取**非 start/end** 的节点与它们之间的边；
片段入口 = 模板 `start` 的**唯一**后继（入端口沿用原边），出口 = 模板 `end` 的**唯一**前驱（出端口沿用原边）。
模板必须**单入口单出口**，否则一律 fail-closed（多入口/多出口没有唯一可接的位置，硬接会静默改变语义）。

**串行链接线**（`N === 0` 时不内联，expand 直接退场 —— 与 `loop` 的 `limit === 0 ⇒ loop-done` 同构）：

```
expand ──▶ copy0.entry ──…──▶ copy0.exit ──▶ copy1.entry ──…──▶ copyN-1.exit ──▶ 原后继 S
```

**本次落地**

| 项 | 产物 |
|---|---|
| 纯叶子 | `services/backend/src/services/domain/project/workflow/expandTemplate.js`（零 IO、绝不抛、可离线单测） |
| IO 原语 | `primitives.loadFlow(templateId)` —— 默认实现经 `flowRegistry.load`，**加载失败即抛**（绝不返回半个模板让 expand 去猜，那会变成「静默少跑几份」） |
| 执行器 | 主循环体加 `__bind` 处理（3 行）+ 新增 `case 'expand'` |
| 节点类型 | 两份 `nodeCatalog.js` 声明 `expand` ⇒ **13 型** |
| 导出器 | `workflowExportService.instructionFor` 补 `expand` 分支；并**订正 `graphPatch` 的陈旧描述**（原写「仅加法…删除默认禁止」，步 B 后 `disconnect` 已放开） |
| 行为测试 | `services/backend/tests/workflowExecutor.expand.test.js`（11 条） |

**逐份变量绑定 —— 为什么不能「在 `expand` 里写一次」**
每份副本的**入口节点**带 `data.__bind = { var, value }`，执行器在主循环体顶部应用它
（与 `loop` 的「进循环体前写 `vars[itemVar]`」同构）。**所有副本共享同一个 `vars`** ——
若只在 `expand` 里写一次，N 份看到的都会是**最后一个**元素（一类不会报错的静默失真）。

**判据（可复用）**：★★ **「批量 + 带数据绑定」的能力，判据必须是「每一份都真的执行、且各自看到自己的元素」。**
本次用 `{{cur}}` 插值 + mock `chat` 的 `seen` 数组断言 `['p-a','p-b','p-c']`。
反向对照：**拆掉 `__bind` 后实测 `seen = ['p-','p-','p-']`** ⇒ 断言必然变红，**不是恒真断言**。

**★ 顺手抓到的一类「测试腐烂」（值得单独记）**
`expand` 这个名字此前被**两处**当作「未在目录声明的节点类型」的替身：守卫反例矩阵的注入类型、
`workflowExecutor.failClosed.test.js` 的两条断言。本次 `expand` 被真实声明后，两处**同时变红**
（矩阵 4/5、测试 32/34）。

⇒ **判据（可复用）**：★★ **「未声明的类型」这类替身必须用永不与真实目录撞名的合成名**
（本次改为 `zzInjectedProbeType` / `zzUndeclaredProbeType`）。用真实类型名当替身，测试会
**随目录增长而腐烂**；而且腐烂时表现为「守卫/测试报红」而非「漏检」，容易被误判成新引入的 bug。

**⚠ 一处守卫判定面的边界（顺带发现，未擅改）**：守卫的目录抽取正则要求**类型名首字符是 A-Za-z**。
下划线开头（或数字开头）的类型名会被**静默漏掉**。目前有「抽取条数 == 真实 require 条数」这条
自校验兜底，所以不会静默通过 —— 但**探针类型名必须字母开头**（本次实测踩过：用 `__probe_injected_type__`
时抽不到，场景报 extraction-failed 而非预期的 node-missing-handler）。

**后续**：`graphPatch.onVar` → **步 D**（§12.11）。**D1 至此全部落地。**

**验收**：守卫 `0 error / 0 warning`（目录 13 型 / 执行器 13 型）；反例矩阵 **5/5**；
行为测试 **34/34**（11 expand + 18 graphPatch + 5 failClosed）；`check-agent-rules --changed` 仍为
**17 error**（与改动前**同数同项**，全是存量）；`archDebtScan` **未点名本次任何文件**。

---

### 12.10 D2 落地记录：自愈闭环闸（2026-09-24）

**裁决**：§10.1 追加 **Q6「只报不滚」** 与 **Q7「深度持久化为 `_meta.healDepth`，上限 5」**。

### ★ 动笔前撞到的一条硬约束（正是它决定了「只报不滚」）

§5-D2 点 1 原文要求「否则**退回** `healedFrom` 链上的上一版」。实测取证：

| 探针 | 结果 |
|---|---|
| `flowRegistry.save()` 是否保留上一版图 | **不保留** —— 原地 `fs.writeFileSync` 覆盖同一文件 |
| `_meta.previousVersion` 有消费方吗 | **零消费方**（全仓只有 1 处写入、2 处注释） |
| 全仓有回滚/退回能力吗 | **无**（`rollback` / `revert` / 历史版本存储均为空） |

⇒ 「退回上一版」在当前存储模型下**物理不可行**（没有可退的东西）。故裁决 **只报不滚**：
save 侧**拒绝发布**（= 当前版本原封不动，字面意义上的「退回」），run 侧**只出裁决 + `rollbackTarget`**。

### 落地内容

| 项 | 产物 |
|---|---|
| 纯叶子 | `services/backend/src/services/domain/project/workflow/healGuard.js`（零 IO、绝不抛、可离线单测）—— `checkHealClaim`（save 侧判据）+ `computeHealVerdict`（run 侧三态） |
| save 侧闸 | `flowRegistry.save()` 在**写盘之前**判：不通过即 `{ok:false}`，**不发布新版本**；通过则写 `_meta.healedFrom` + `_meta.healDepth` |
| run 侧裁决 | `RPATool._run()` 在 `stats.record` 之前算裁决，随**三条返回路径**（成功 / 契约失败 / 运行失败）一并返回 |
| `list()` 摘要 | 暴露 `healDepth`（与既有 `healedFrom` 并列） |
| 提示词 | `flowPriorityDirective.js` 的【失败接管与自愈】补闸的规则；`RPATool` 的 `healedFrom` 参数描述同步 |
| 行为测试 | `services/backend/tests/healGuard.test.js`（20 条，含 save 集成与事务性） |

### 四条判据（save 侧，全部 fail-closed）

1. `healedFrom` 必须是非空字符串；
2. 必须**存在上一版**可溯源（无上一版 ⇒ 无从谈起「治愈了上一版的失败」）；
3. 根因节点必须**存在于上一版图中**（否则该自愈是幻觉 —— §5-D2 原文）；
4. 自愈链深度 `= 上一版 healDepth + 1`，超过 **5** 即拒。

> 附加（本次派生，非文档原文）：**同图 + `healedFrom` 一律拒**。原因见下 ——
> 原实现在这条路径上会**静默丢弃** `healedFrom`，正是本闸该堵的那类失真。

### ★ 顺手抓到一个静默失真（本闸的直接动因之一）

| 探针 | 改动前 |
|---|---|
| 同图再 save 且带 `healedFrom` | 返回 `{ok:true, unchanged:true}`，落盘 `_meta` 里**没有** `healedFrom` |

AI 会据此以为「自愈已记录」，而实际什么都没记。现已改为**明确拒绝**
（错误串说明「图与上一版逐字节相同 ⇒ 本次 save 没有产生任何修复，不构成自愈」）。

### run 侧三态（**必须可区分**）

| 态 | 触发 | 含义 |
|---|---|---|
| `healRejected` + `healRejectReason` | `run-failed`（run 没跑完）或 `contract-failed`（契约未通过） | **不算 healed** |
| `healUnverified` + `healUnverifiedReason` | 未声明 `contract`（无断言可判 ⇒ 闸空转），或契约校验环节自身异常 | **无法判定**，不得算 verified |
| `healVerified` | 契约全绿 | **才算 healed** |

★★ **判据（可复用）**：同一处「没通过」有多种成因时，**三态必须可区分** —— 否则等于把
「静默失真」换成「误导失真」（步 A 的教训）。本次特意把「未声明 `contract`」与「校验环节异常」
从「verified」里拆出来：原代码对后者是 **fail-soft 按通过处理**（为的是不淹没一次成功的 run），
但**自愈裁决**必须诚实说「未验证」。

### 反向对照（证明测试不是恒真断言）

| 对照 | 拆掉什么 | 实测 |
|---|---|---|
| A1 | save 侧闸 | 首次带 `healedFrom` 的 save 由「拒」变 `ok:true` |
| A2 | save 侧闸 | 幻觉 `healedFrom`（节点不在上一版）由「拒」变**接受且落盘** |
| A3 | save 侧闸 | 同图 + `healedFrom` 由「拒」变 `ok:true` 且 `healedFrom` **静默消失** |
| A4 | save 侧闸 | 自愈链深度 8（远超上限 5）由「拒」变 `version=9` |
| B1 | run 侧 `unverified` 分支 | 未声明 `contract` 由 `healUnverified` 变 `healVerified` |

⇒ 五条断言**全部有牙**。

### ⚠ 一处**刻意不改**的地方：运行期指令的预算已饱和

§5-D2 指出自愈提示词在 `flowPriorityDirective.js:104`。本次**没有**往那里加字，因为实测：

| 情形 | 长度 | 结果 |
|---|---|---|
| 无候选 | 319 | 余量 131 |
| 2 个候选 | 334 | 余量 116 |
| **5 个长候选** | **465** | **已被截断**（`MAX_DIRECTIVE_CHARS = 450`，而末段正是【契约沉淀】） |

⇒ 往这里加字会**把已有缺陷放大**、可能切掉契约要求本身。故闸的规则改走 **`RPATool` 工具描述**
（无长度上限，且 AI 在**调用点**读到），指令文件保持不动；且该指令已有「每次 `RPA.save` 时尽量
附带 `contract`」—— 已覆盖「自愈须带 contract」。

★ **判据（可复用）**：**往任何有长度上限的提示词里加字之前，先量「最坏情形」是否已经超限** ——
上限通常按**典型情形**设定，最坏情形（候选拉满 + 长文本）常常已经越界，此时加字是**把已有缺陷放大**。

### 验收

守卫 `check-workflow-node-parity` **0 error / 0 warning**（13 型 / 13 型 —— 本次不动节点类型）；
反例矩阵 **5 / 5**；行为测试 **54 / 54**（20 healGuard + 11 expand + 18 graphPatch + 5 failClosed）；
`check:rules` / `check:wiring` / `check:rollout-stage` / `check:gov-rules` 全绿；
`check-agent-rules --changed` 仍为 **17 error**（与改动前**同数同项**，全是存量）；
`archDebtScan` **未点名本次任何文件**。

测试文件被 `services/backend` 的 `test:node`（`node --test tests/**/*.test.js`，glob 命中 **2585** 个文件）
自动收走 ⇒ **无需新增别名**（顺带发现：既有别名 `test:workflow-node-parity` **零引用**，只是手动入口）。

### 残留边界（诚实登记，未擅改）

- **`healUnverified` 是「闸空转」的显式化，不是拦截**：自愈版本**不声明 `contract`** 时，闭环闸无断言可判。
  本次选择**显式标注**而非「强制自愈版本必须带 `contract`」—— 后者会拒绝 AI 的合法修复（有丢工作风险）。
  要收紧应**另立一步**把「自愈必须带 contract」做成 save 侧判据。
- **物理回退仍未实现**：`rollbackTarget` 只是**目标描述**（`name@v{previousVersion}`），不是可执行的回退入口。
  要真回退须先解决「上一版图不被保留」这个存储问题（裁决时已列为另两个选项）。
- **「根因节点」只验证存在性**，不验证它是否**真的失败过**（`flowStats` 未按节点记账）。

### 12.11 D1 步 D：运行期补丁来源 `graphPatch.onVar` 已落地（2026-09-24）

**裁决**：§10.1 追加 **Q8「补丁值形态：两者都接受」**。原文只有「`onVar`（补丁来源变量）」
六个字，未规定值形态，且 §10 的 Q1–Q7 里**没有它** —— 按 §10 开头「需人裁决，本方案不代为决定」
提交裁决。**D1 至此全部落地**（步 A `graphPatch` / 步 B `disconnect` / 步 C `expand` / 步 D `onVar`）。

#### 落地前的两条取证（都不是从文档能读出来的）

| 探针 | 结果 |
|---|---|
| `onVar` 全仓是否有实现 | **没有**。`git grep --untracked onVar` 只命中本文件的 7 处状态/描述行 |
| 运行期补丁是否经过 D2 的闸 | **不经过**。`runGraph` 只返回 `{status, vars, log}`；执行器与 worker **都不调** `flowRegistry.save` ⇒ 运行期图改写**从不回写** flow，而 D2 的闸挂在 `save()` 上 |

> ⚠ **订正（本节的重要产出之一）**：本文件此前多处写着「`graphPatch.onVar` 的前置是 D2 闭环闸，
> 已就位 ⇒ **前置已满足**」。这句**不精确**：D2 的闸在**沉淀边界**（`flowRegistry.save`），
> 而 `onVar` 的补丁是**运行期**改写。
>
> 准确的表述是：**运行期补丁不需要 D2 的闸** —— 它只改内存图、不落盘，天然是临时的；
> AI 的自愈成果若要**持久化**，才必须走 `RPA.save` / `flowRegistry.save`，那一步已被 D2 的闸管住。
> 也就是说「前置」不是「闸本身」，而是「**沉淀路径已有闸**」这个事实。

#### 落地内容

| 项 | 产物 |
|---|---|
| 纯叶子 | `jsonExtract.js`（容错 JSON 抽取）+ `graphPatch.resolvePatchOps`（来源解析） |
| 执行器 | `case 'graphPatch'` 先解析来源再 `applyPatch`；审计 `entry.revision.source` 记出处 |
| 节点目录 | 两份 `nodeCatalog` 的 `graphPatch.fields` 补 `onVar`（widget 沿用既有 `var-ref`，**不自造新 widget**） |
| 导出器 | `workflowExportService` 的 `graphPatch` 分支区分「补丁来自变量 X」与「N 个算子」 |
| 测试 | `workflowExecutor.onVar.test.js` 15 条（含执行器级「真的被执行」判据） |
| 前端 | **零改动**（catalog 驱动，实测确认） |

#### 语义（「两者都接受」的落地口径）

- `vars[onVar]` 是**数组** ⇒ 直接当补丁算子数组（结构化来源，如 `http` 节点写入的 JSON 响应）。
- 是**字符串** ⇒ 按 `extractFirstJson` 范式**容错解析**（剥 ```json 围栏、容忍前后文），结果必须是数组。
- **其它类型** ⇒ 拒绝。

**优先级**：`onVar` 一旦声明（非空字符串）就**只认它**；`onVar` 为空串 / 纯空白 / 缺省视为**未指定**，
回落静态 `ops` —— 沿用本执行器既有约定（`d.outputVar` 等字段一律以 falsy 表示「没填」，前端空文本框正是 `''`）。

**★ 不回落**：`onVar` 解析失败时**绝不**回落到 `ops`。回落是一次**静默降级** —— 作者声明了运行期来源，
引擎却跑了一份静态补丁，而日志上（改动前）看不出区别。反向对照实证了这一点：

| 场景 | 改动前实测 | 改后 |
|---|---|---|
| `onVar:'nope'` + 合法 `ops` | `status:'completed'`，**跑的是 ops 的补丁** | **抛**：`onVar 变量 'nope' 不存在` |

#### ★ 判据：核心断言必须是「补丁真的被执行」

沿用 §12.7 的立场：G3 类缺陷**不报错**。所以「onVar 生效」不能只用「解析函数返回 ok」证明 ——
必须断言**补丁新增的节点真的进入了执行序列**（`log` 的 `nodeId` 序列 + prompt 副作用落到 `vars`）。

反向对照（把执行器复制成同目录副本、恢复「只读 `d.ops`」的改动前行为，跑同一批场景）：**5 / 5 全部偏离**。

| 对照 | 改动前实测 |
|---|---|
| `onVar` 数组来源 | 抛 `graphPatch.ops …`（`onVar` 被完全忽略） |
| `onVar` 字符串来源 | 同上 |
| `onVar` + `ops` 并存 | 跑的是 `ops` 的节点（`p_ops`），`p_var` 从未出现 |
| `onVar` 解析失败 + `ops` 可用 | `completed` + 跑 `ops`（**静默降级**） |
| 审计 `source` | 无该字段（或恒为 `ops`） |

**错误精度**：同一个拒绝点有 8 种成因（无变量袋 / 变量不存在 / 不是合法 JSON / 解析出对象 /
解析出数字 / 值是数字 / 值是对象 / 值是布尔·null），每种给**独立措辞**，并由测试断言
「两两不同」—— 与 §12.7 判据二「fail-closed ≠ 错误报对」是同一条。

⚠ **测试口径的一处细节**：「没有变量袋」这一支在**执行器层不可达**（`runGraph` 里
`vars = {...(options.vars || {})}` 至少是 `{}`），故它只由叶子级测试覆盖。把不可达的分支写进
执行器级用例，只会得到一个永远测不到的分支（本次实测踩过：一条用例因此变红）。

#### 一处真缺陷（本轮顺手修掉）

`workflowCliCore.js` 的 `slugify` 里，字符类写成了**原始控制字节**（实测 1 个 NUL + `0x1F` + `0x7F`）
而非转义写法。后果是**普通 `grep` 把整个文件判成二进制、静默跳过其内容**（`git grep` 侥幸还能读 ——
因为 git 只看前 8000 字节，而 NUL 在偏移 11944，属**巧合而非保证**）。已改写为
`[\u0000-\u001f\u007f]`，**语义逐字节等价**（行为对照通过：NUL/SOH/US/DEL 均被剥除，空格仍转 `-`），
消除该静默漏检。

#### 残留边界（诚实登记，未擅改）

- **运行期补丁没有闭环闸**：`onVar` 的补丁应用后**立即**影响后续执行，而 D2 的闸只在**沉淀**时生效。
  本次**没有**新增运行期闸 —— 那需要「补丁应用后、下一步执行前」的校验点，是独立设计。
  当前兜底是：**运行期补丁不落盘** ⇒ 未审阅的图结构不会沉淀成可复用流程。
- **`jsonExtract.js` 与 ai-backend 的同名函数是重复**：两者是**有意孪生**（本叶子是**超集**，
  多认数组定界符 —— 实测 `'前文 [{"op":"x"}] 后文'` 原版返回**内层对象**，本叶子返回数组）。
  未上提到 `@khy/shared` 的原因：该包在本仓有**两棵被 git 跟踪的副本**
  （`platform/packages/shared/` 与 `services/backend/vendor/shared/`），实测**已存在漂移且无同步守卫**，
  加子路径要同时改两棵树 + 两个 `exports` 映射 —— 风险与收益不成比例。两者都改过之后应上提收敛。
- **`onVar` 不解析点号路径**：`vars[onVar]` 是**直接键查找**，与 `expand.sourceVar` / `loop.itemsVar`
  一致。要支持 `a.b` 需另立一步（`resolveArgs` 的 `{{a.b}}` 是另一套机制）。

#### 验收

守卫 `check-workflow-node-parity` **0 error / 0 warning**（13 型 / 13 型 —— 本次不动节点类型）；
反例矩阵 **5 / 5**；行为测试 **69 / 69**（15 onVar + 20 healGuard + 11 expand + 18 graphPatch + 5 failClosed）；
`check:rules` / `check:wiring` / `check:rollout-stage` / `check:gov-rules` 全绿；
`check-agent-rules --changed` 仍为 **17 error**（与改动前**同数同项**，全是存量）；
`archDebtScan` **未点名本次任何文件**；`check-tool-contract` **0 error**。

---

### 12.12 D1 收尾：把 §6 的三条铁律做成真判据（2026-09-24）

#### 为什么还要做这一步

头部状态写着「**D1 已全部落地**」，而 §6 防呆铁律里 **F4 / F5 / F9 的「现状」列仍是「待实现（D1）」**。
这两句**不能同时为真**。逐条取证后确认：**头部那句话对 F5 / F9 是过度声明**。

| 铁律 | 文档要求的判据 | 取证结果 |
|---|---|---|
| F4 | 改写前后哈希 + 校验返回码 | 事务性与端口校验**已有测试**；`entry.revision` 已带 `beforeHash` / `afterHash`，但**没有测试断言它可独立核验** |
| F5 | 双跑对比终态 vars 逐字符相等 | 审计**存在**但形状不同（见 §10-Q9）；**重放对照测试不存在**（测试里零 `computeGraphHash`） |
| F9 | 源码断言：图改写路径无 `new Function` / `eval` | **该断言不存在**（`new Function` 只出现在 `case 'code'` —— 那是**节点类型**的合法用途，与改写路径无关） |

> ★ **判据已写在文档里**，所以这一步**不需要新裁决**（与步 C / 步 D 不同）——
> 它只是把**已规定的判据**补成真判据，从而让「已落地」这句话**有据可依**。

#### 落地内容

新文件 `services/backend/tests/graphRewriteContract.test.js`（7 条）：

| 铁律 | 判据 | 关键设计 |
|---|---|---|
| F4 | 成功改写时审计带 `beforeHash` / `afterHash` 且两者**不等**；且 `beforeHash` **必须等于** `computeGraphHash(改写前图)` | 后半句是重点：否则 `beforeHash` 只是一个「**看起来像哈希的字符串**」，审计**没有可核性** |
| F4 | 被拒补丁**不落审计**、图**逐字段不变** | 拒绝路径到不了审计写入（执行器在写 revision **之前** throw）⇒ 判据是「**抛错 + 图不变**」，并配 `graphPatch refused` 措辞断言 |
| F5 | 同图 + 同补丁**双跑** ⇒ `seq` / `beforeHash` / `afterHash` **序列逐项相等**，终态 `vars` **逐字符相等** | 补一条**先决条件**断言（`vars.out1 === 'chat:hi-A'`），防「两边都空」的恒真 |
| F5 | **有牙对照**：改补丁 ⇒ `afterHash` **必变**、终态 `vars` 必变，而 `beforeHash` **必须不变** | 最后半句是分辨力的关键：证明变的是**补丁**，不是基线 |
| F9 | 源码断言：`graphPatch.js` 及其**直接依赖**（`workflowCliCore.js` / `jsonExtract.js`）剥离注释后**不含**代码执行原语 | **复用** `archDebtScan.stripComments`（该文件自带状态机边界测试）。复用 > 复制：自造一个「只删 `//`」的实现会把字符串里的 `//` 当注释，从而**漏掉**真代码 |
| F9 | **非平凡闸**：剥离后非空白字符 > 500 且仍含 `module.exports` | 防「剥离器失效把文件剥空 ⇒ 断言静默通过」的恒真陷阱 |
| F9 | 行为对照：代码样载荷只当**文本**（哨兵 `globalThis.__f9pwned` 必须仍为 `undefined`）；未知算子被拒 | 补上「算子白名单封闭 ⇒ 补丁无法夹带新算子」这条 |
| F9 | **判定面自校验**：`graphPatch.js` 的直接依赖必须**全部登记** | 从源码 `require` **派生**期望集合，断言 ⊆ 登记集合；配非平凡闸（解析出的依赖数 ≥ 2）。实测：**摘掉一条登记 ⇒ 该测试变红** ⇒ 清单**自维护**（不再依赖「记得加」） |

#### 反向对照（证明判据真有牙）

**内建对照**（测试第 167 / 245 行）已覆盖「哈希有分辨力」与「仪器能识别真代码 / 跳过注释」。

**外部文件级对照**（更强，因为 F9 断言的是**真文件文本**）：临时向 `graphPatch.js` 注入一行**真代码** `eval`，跑同一批断言。

| 阶段 | 实测 |
|---|---|
| 基线 | `tests=8 pass=8 fail=0` |
| 注入 `eval` 后 | `tests=8 pass=7 fail=1` —— 失败项**正是 F9 那条**（不是被别的测试连带拖红） |
| 还原校验 | 与注入前**逐字节相等**、无 `__f9neg` 残留、备份文件已清 |

**判定面自校验的对照**（证明清单真能自维护）：把测试文件复制成**同目录副本**（`__dirname` 不变 ⇒
相对路径仍解析正确），在副本里**摘掉 `workflowCliCore.js` 那条登记**，跑副本。

| 阶段 | 实测 |
|---|---|
| 基线 | `tests=8 pass=8 fail=0` |
| 副本摘掉一条登记 | `tests=8 pass=7 fail=1` —— 失败项**正是「判定面自校验」那条** |
| 清理校验 | 副本已删、真文件未改动（逐字节相等） |

> 对照脚本用 `try/finally` 保证还原。**这与前面几步的对照方式不同**：那几步可以复制成同目录副本再改，
> 而 F9 是**源码文本断言**、它读的是被断言的**真文件路径**，所以对照必须**就地改真文件** ——
> 也正因如此，还原必须放进 `finally`，不能靠 shell 的 `&&` 链（实测中断过一次）。

#### 顺带发现的两条边界

- **`computeGraphHash` 对节点数组序敏感**：`stableStringify` 使它对 **`data` 键序不敏感**，但对**节点数组序敏感**
  —— 语义等价、仅顺序不同的两张图**哈希不同**。这不影响 F4 / F5（同一图改写前后比较），
  但**不可**把它当「语义等价」的判据（例如不能用它去重「同一张图的两种写法」）。
- **运行期改写与沉淀路径的校验集合不同**：`checkGraphShape` **只在 `flowRegistry.save()`** 生效；
  运行期改写走的是执行器**注入**的 `validateGraph`。两者判据集合不同，**不可互相替代**
  （这也是 §12.11 残留边界「运行期补丁没有闭环闸」的另一面）。

#### 订正

- §6 的 **F4 / F5 / F9** 「现状」列：由「待实现（D1）」改为**已实现**并指向本节的测试。
- §12.4 的「未落地」表述同步（D1 现已含铁律判据，不再有「D1 剩余」）。
- 头部状态行补「D1 收尾（铁律判据）」并把依据指向本节。

#### 登记（未自行裁决）

**§10-Q9：F5 审计的形状归宿。** 文档写 `run.graphRevisions[] = {seq, nodeId, op, beforeHash, afterHash}`；
实现是 `log[].revision = {seq, beforeHash, afterHash, source, ops}` —— **更宽**（`ops` 是数组而非单个 `op`，
另有 `source` 记来源），且**已随 `log_json` 持久化**。按 `PROCESS-011`「先裁改哪边」**不自行裁决**：
判据已满足（可重放、可核验），但**形状分歧**需要你定是改文档还是改实现。

#### 残留边界（诚实登记）

- **F5 的「可重放」只验证了同进程双跑**：两次都在同一进程、同一 mock 下跑 ⇒ 相等是**确定性**的证据，
  但**不等于**「跨进程 / 跨版本重放」也已验证（那需要持久化的 `log_json` 回读重放，是独立一步）。
- **F9 的断言面已从「手写清单」升级为「派生 + 自校验」，但闭包只走一层**：
  `REWRITE_PATH_FILES` 现由 `graphPatch.js` 的**直接依赖**派生（`graphPatch.js` / `workflowCliCore.js` /
  `jsonExtract.js` —— 实测后两者**自身零 require**，所以这一层就是全部闭包），并由一条测试钉住
  「派生集合 ⊆ 登记集合」⇒ **新增 `require` 而忘了登记，测试会变红**。
  残留：① **包外依赖**（`require('@khy/...')`）不在判定面内；② 若某个依赖将来自己长出 `require`，
  闭包会变深而判定面**不自动跟着变深**（那时需改成递归派生）。
  （本仓判据：**「守卫报绿」只等于「判定面内没问题」**。）

#### 验收

行为测试 **77 / 77**（在 §12.11 的 69 条之上新增本节的 8 条：15 onVar + 20 healGuard + 11 expand + 18 graphPatch + 5 failClosed + 8 铁律）；
守卫 `check-workflow-node-parity` **0 error / 0 warning**（13 型 / 13 型 —— 本次不动节点类型）；
反例矩阵 **5 / 5**；`check:rules` / `check:wiring` / `check:rollout-stage` / `check:gov-rules` 全绿；
`check-agent-rules --changed` 仍为 **17 error**（**我的文件零发现** —— 逐条归属见 §12.11 的订正记录）；
`archDebtScan` **未点名本次任何文件**；`check-tool-contract` **0 error**。
