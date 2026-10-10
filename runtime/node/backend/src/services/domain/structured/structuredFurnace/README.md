# `domain/structured/structuredFurnace` — 万物结构化熔炉（D2，近孤岛单元）

> 本 README 是本单元的上下文真源之一。机器可读的契约、扇入与登记缺陷见同目录
> `khy.module.json`（守卫 `npm run check:layout` 的 `functional-unit` 规则要求二者并存）。
> 设计出处：`[DESIGN-ARCH-036]`；锁级桥接 `[DESIGN-ARCH-034]`（`domain/project/metaplan/constraintStrategy`）。

## 1. 三问（规则 9 / `PROCESS-010`）

| 问 | 答 |
|---|---|
| **谁要的** | 不是本轮任何人新提的需求——这 11 个源文件是**既有跟踪代码**（`git status` 里它们是干净的，本批一个字节都没改），出处是设计文档 `[DESIGN-ARCH-036]`，运行时唯一的生产接线点是 D1 侧 `services/tool/toolUseLoopHelpers.js:1314-1339` 的 `maybeForgeStructuredIntent`（observe 模式，默认开），第二个消费者是安全对抗侧 `services/domain/security/adversarial/stressHarness.js:194-225` 的 `_driveFurnace`。**扇入实测 2 个文件 / 2 个 require 站点**（判据：require 解析后落进本目录）。 |
| **为什么要这么做** | 它想解决的是「一句自然语言里同时并存 3 个动作、模糊词、条件与反悔，下游模型只能临场猜」这个问题：把无序 NL 强制坍缩成三种机器可解析的形状（L0 ActionIntent / L1 TaskGraph DAG / L2 StateMachine），并按锁级（Prompt_Soft…Code_Hard…System_Block）给出该用多重的护栏。这一层的**存在理由**是省 token 与消歧义；它**不买账**的地方在于全部判据是词法表（`VERB_MAP`/`VAGUE_RE`/`CONNECTORS`/`REVERSAL_RE`），词表一漏就静默走轻锁——见 §4 与 `khy.module.json` 的 B31-F1/F2/F3/F18。<br>⚠ **「11 个源文件 / 扇入 2」是一个近孤岛**：它没有测试网以外的真实负载，且**目录内零 env、零 fs、零网络**（全数清点，非抽样）。它到底是「该养的机制」还是「该退役的重量」，**这是人的裁决，不是本 README 的裁决**；本 README 只把事实摆清楚：生产侧确有 1 条默认开的接线（observe 模式），但该接线**从不验封**（`assertForged` 全仓只有 1 个调用者 = stressHarness，`isForged` 生产侧 0 个），所以熔炉的硬边界目前只在对抗测试里被行使。 |
| **怎么验证** | `cd services/backend && node --test src/services/domain/structured/structuredFurnace/anomalyHandler.test.js src/services/domain/structured/structuredFurnace/chaosInterceptor.test.js src/services/domain/structured/structuredFurnace/dimensionReducer.test.js src/services/domain/structured/structuredFurnace/entityRegistry.test.js src/services/domain/structured/structuredFurnace/entropyAssessor.test.js src/services/domain/structured/structuredFurnace/forgeSchema.test.js src/services/domain/structured/structuredFurnace/index.test.js src/services/domain/structured/structuredFurnace/intentWeaver.test.js src/services/domain/structured/structuredFurnace/skeletonReconstructor.test.js src/services/domain/structured/structuredFurnace/stateMachine.test.js src/services/domain/structured/structuredFurnace/taskGraph.test.js`（**必须逐个显式列路径**，本环境 `node --test <目录>` 给假读数）→ 实测 **215 例 / 0 fail / 0 skip / 0 todo**，712 个断言调用点。单元外 2 份引用本单元的测试（`tests/services/structuredFurnace/`）**在本机可跑**（node:test 方言，非 jest）：实测 **30 例 / 8 suites / 30 pass / 0 fail / 0 skip**。 |

## 2. 契约（改本单元前先读这段）

### 2.1 导出面（`Object.keys` 实测全数清点，共 69 键 / 11 文件）

| 文件 | 键数 | 导出 |
|---|---|---|
| `index.js` | **24** | `intercept` `assertForged` `isForged` `SEAL_BRAND` `FurnaceRejection` / `reduce` `weave` `reconstruct` / `assess` `adjudicate` `validate` / 11 个命名空间与类（`entropyAssessor` `entityRegistry` `EntityRegistry` `taskGraph` `TaskGraph` `stateMachine` `StateMachine` `forgeSchema` `dimensionReducer` `intentWeaver` `skeletonReconstructor` `anomalyHandler` `chaosInterceptor`） |
| `forgeSchema.js` | 9 | `ACTION_PRIMITIVES` `VAGUE_RE` `coerceVagueness` `isAtomic` `hasRelativeClause` `validate` `validateActionIntent` `validateTaskGraph` `validateStateMachine` |
| `dimensionReducer.js` | 7 | `reduce` `reduceClause` `mapActionVerb` `extractTarget` `strategyForActions` `RISKY_ACTIONS` `_uid` |
| `entropyAssessor.js` | 6 | `assess` `hasCausalDependency` `CAUSAL_TEMPORAL_RE` `MULTI_ACTION_RE` `CONTRADICTION_RE` `ENUMERATION_RE` |
| `anomalyHandler.js` | 5 | `adjudicate` `FurnaceRejection` `ANOMALY_KINDS` `DEGRADE_CONFIDENCE_FLOOR` `CONTRADICTION_DEGRADE_MAX` |
| `chaosInterceptor.js` | 5 | `intercept` `assertForged` `isForged` `FurnaceRejection` `SEAL_BRAND` |
| `skeletonReconstructor.js` | 4 | `reconstruct` `splitSlices` `REVERSAL_RE` `NEGATION_RE` |
| `intentWeaver.js` | 3 | `weave` `splitClauses` `_edgeFor` |
| `entityRegistry.js` | 2 | `EntityRegistry` `_normalize` |
| `stateMachine.js` | 2 | `StateMachine` `STATE_STATUS` |
| `taskGraph.js` | 2 | `TaskGraph` `EDGE_TYPES` |

⚠ **调参常量不在扁平面上**：`ANOMALY_KINDS` / `DEGRADE_CONFIDENCE_FLOOR` /
`CONTRADICTION_DEGRADE_MAX` / `hasCausalDependency` 只能经命名空间取到
（`furnace.anomalyHandler.DEGRADE_CONFIDENCE_FLOOR`），照 `index.js` 头部示例写
`furnace.X` 得到 `undefined`（B31-F16c，由 `index.test.js:192` 钉住）。

### 2.2 三种文件角色（本单元实际分布，与 mcp 单元不同）

- **纯叶子（6 个）**：`entropyAssessor` `forgeSchema` `anomalyHandler` `intentWeaver`
  `skeletonReconstructor` `dimensionReducer` —— 零 IO、确定性、可整包注入 env 的地方**根本没有**
  （因为它们不读 env）。`dimensionReducer`/`intentWeaver`/`skeletonReconstructor` 是坍缩器，
  复用同一份动词表与实体抽取（单一真源在 `dimensionReducer`）。
- **有状态容器（3 个）**：`entityRegistry` `taskGraph` `stateMachine` —— 各自一个 class，
  内部是 `Map`/数组，**实例态、非单例**：每次熔炉铸造 `new EntityRegistry()`
  （`chaosInterceptor.js:66`），实例不跨请求续命。它们仍是零 IO、零 env。
- **编排 + 进程态（1 个）**：`chaosInterceptor` —— 唯一持有进程私有封印盐
  `SEAL_SALT = crypto.randomBytes(16)`（:31），别处没有第二份。
- **外观（1 个）**：`index.js` —— 纯再导出，无逻辑、无状态。
- ⚠ **本单元没有 thin-IO 角色**：全目录 11 个源文件 + 11 个测试文件里，
  `require('fs'|'path'|'os'|'net'|'http')`、`process.env`、`mkdtemp`、`setTimeout`、`await`
  **零命中**（实测 grep，非抽样）。这既是它好测的原因，也是「扇入 2 的近孤岛」判定的组成部分。

### 2.3 门控：本目录**一个 `KHY_*` 都不读**（全数清单为空，非抽样）

实测 `grep -rn 'KHY_[A-Z_]*' *.js`（排除 `*.test.js`）在本目录 **0 命中**；
`process.env` 同样 0 命中。熔炉的开/关**全部在消费方**，改本单元时不要以为存在本地闸门：

| 闸门 | 在哪 | 默认 | 语义 |
|---|---|---|---|
| `KHY_STRUCTURED_FURNACE` | `services/tool/toolUseLoopHelpers.js:1316-1325`（经 `capabilityMatrix` 的 `CAP_SEAMS.PRE_DISPATCH` + id `'structuredFurnace'`） | **开** | `=0` 关闭整层；`options.structuredFurnace.enabled` 单次覆盖 |
| `KHY_STRUCTURED_FURNACE_MODE` | 同上 `:1325` | `observe` | `observe` 拒损只记录不打断；`enforce` 才把 `FurnaceRejection` 上抛 |
| 能力登记表 | `domain/catalog/capabilityMatrix/descriptors.js:63` + `routePresets.js:25/:34` | — | id `structuredFurnace` 挂在 PRE_DISPATCH 缝上 |

（`descriptors.js`/`routePresets.js`/`toolUseLoopHelpers.js` 三个文件都在本单元**外面**，
本批只清点不触碰。）

### 2.4 熔炉数据模型（谁能读什么）

**ForgeEnvelope（封印信封）** —— `chaosInterceptor._forge`（:124-141）的唯一产物形状：
`{ [SEAL_BRAND]:true, sealed, seal, level, entropy, verdict, kind, payload, strategy,
degraded, writeLocked, entities, rawHash }`，`Object.freeze` **浅**冻结。
`seal` = `HMAC-SHA256(SEAL_SALT, JSON.stringify(payload))`，盐是**进程私有 randomBytes**
（:31）⇒ **信封跨进程不可验**（重启后 `assertForged` 必抛「封印校验失败」）；
`SEAL_BRAND` 是 `Symbol.for('khyos.structuredFurnace.sealed')`（全局可达键）⇒
`{ ...envelope }` 浅拷贝仍然验封通过（B31-F4）。`rawHash` = `sha1(text).slice(0,12)`，
信封里**不含原文**——原文只以哈希形态存在。

**三级 payload**（`envelope.payload`，消费方只许读它，不许回碰原文——`index.js:20` 的约定）：

| 级别 | 形状 | 由谁产出 | 由谁把关 |
|---|---|---|---|
| L0 `ActionIntent` | `{kind,uid,action,target:{uid},params,confidence,strategy,entities}` | `dimensionReducer.reduce` | `validateActionIntent`（**唯一**校验 `target.uid` 是否落在 `entities` 里的层） |
| L1 `TaskGraph` | `{kind,uid,graph:{nodes[],edges[]},entities,confidence,strategy}` | `intentWeaver.weave` | `validateTaskGraph(payload,{hadDependency})`（查节点 uid 去重、边端点，**不查 node.target**） |
| L2 `StateMachine` | `{kind,uid,machine:{initial,states[],transitions[],contradictions[]},entities,strategy,confidence,hasContradictions,contradictions}` | `skeletonReconstructor.reconstruct` | `validateStateMachine`（查 initial 与转移端点，**不查状态 uid 去重**） |

`FurnaceRejection`（`anomalyHandler.js:35-60`）= 拒损异常，携带
`{name,kind,missing[],conflicts[],detail,recoverable:false}` 与 `toJSON()`；
它是熔炉对人类的**唯一回问通道**（observe 模式下被 `gatedInput.furnaceRejection` 记录）。
`verdict` 三值语义：`PASS` 原样返回 / `DEGRADE` 打标 `degraded+sandbox+writeLocked`
并把锁级 `escalate` 到 Code_Hard 起步 / `REJECT` **不返回**而是抛出。

### 2.5 注入点（本单元可注入的面，逐个点名）

- `reduce(raw, registry)` / `weave(raw, registry)` / `reconstruct(raw, registry)` /
  `reduceClause(clause, registry)` / `extractTarget(text, registry)` —— 实体表可注入；
  ⚠ **默认值只在 `undefined` 时生效**，传 `null` 会打成内部异常（B31-F16b）。
- `intercept(raw, { forceLevel })` —— 头部广告为测试缝，跳过熵路由；
  ⚠ **对取值零校验**，`'L9'`/`'l0'` 都落进 else 分支变成 L2（B31-F16a）。
- `validateTaskGraph(payload, { hadDependency })` —— 防呆②的开关，
  但 `chaosInterceptor.js:72` **永远写死 `true`**（B31-F7a）。
- `StateMachine.addTransition(from,to,on,{guard,confidence})` —— `guard` 收下并序列化，
  ⚠ **全仓无人调用**（B31-F22）；`confidence` 只过 `typeof === 'number'`（B31-F8）。
- 词表/枚举常量本身即注入位：`ACTION_PRIMITIVES` `VAGUE_RE` `EDGE_TYPES` `STATE_STATUS`
  `ANOMALY_KINDS` `RISKY_ACTIONS` `CAUSAL_TEMPORAL_RE` `MULTI_ACTION_RE`
  `CONTRADICTION_RE` `ENUMERATION_RE` `REVERSAL_RE` `NEGATION_RE` `SEAL_BRAND`。
- **没有 env 注入位**（本目录不读 env，见 §2.3）。

## 3. 实测数字（2026-09-29，全数清点非抽样）

行数口径 = `wc -l`（census 的逐文件值 = 本口径 +1，总数按本口径 1591）。

| 文件 | 行数 | 导出键 | 测试例 | 断言调用点 |
|---|---|---|---|---|
| `anomalyHandler.js` | 145 | 5 | 20 | 72 |
| `chaosInterceptor.js` | 175 | 5 | 23 | 95 |
| `dimensionReducer.js` | 138 | 7 | 21 | 55 |
| `entityRegistry.js` | 124 | 2 | 16 | 45 |
| `entropyAssessor.js` | 124 | 6 | 18 | 61 |
| `forgeSchema.js` | 288 | 9 | 27 | 88 |
| `index.js` | 75 | 24 | 12 | 72 |
| `intentWeaver.js` | 157 | 3 | 20 | 54 |
| `skeletonReconstructor.js` | 119 | 4 | 20 | 63 |
| `stateMachine.js` | 113 | 2 | 19 | 55 |
| `taskGraph.js` | 133 | 2 | 19 | 52 |
| **合计 11/11** | **1591** | **69** | **215** | **712** |

| 项 | 读数 |
|---|---|
| 源文件 / 行数 | 11 / 1591（最大 `forgeSchema.js` 288，最小 `index.js` 75） |
| 共置测试 | 11 份 ↔ 11 个源文件同名一一对，**215 例 / 712 断言 / 0 fail / 0 skip / 0 todo**（`# duration_ms 1430.8`） |
| 单元外行为测试 | 2 份 / 4 个 require 站点，方言 `node:test`，**本机可跑**：30 例 / 8 suites / 30 pass / 0 fail |
| 扇入（非测试，require 解析落进本目录） | **2 个文件 / 2 个站点**：`domain/security/adversarial/stressHarness.js:199`（D2）、`services/structuredFurnace/index.js:4`（D1 shim 整包再导出） |
| 扇入（把 D1 shim 的调用方算进来） | **3 个上游文件**：另加 `services/tool/toolUseLoopHelpers.js:1330` `require('../structuredFurnace')` —— 它取的是 shim 不是本目录，故不计入 fanIn，但它是**唯一默认开的生产接线** |
| 出边 | D2 3 个站点 / 1 个目标（`domain/project/metaplan/constraintStrategy`，见 `anomalyHandler.js:20`、`dimensionReducer.js:16`、`forgeSchema.js:21`）；CORE 3 个站点（`crypto`，见 `chaosInterceptor.js:18`、`dimensionReducer.js:14`、`entityRegistry.js:18`）；SAME_UNIT 26 个站点；**D2→D1 反向边 0**；**D5 可达 0**；**无域归属出边 0**（与 mcp 单元不同，这里伸向 `src/tools`/`src/agents` 的边一条都没有） |
| 零消费者的导出（死面，磁盘走查） | `hasCausalDependency`、`unreachableStates`、`pointerTable`、`deduplicatedCount`、`matrix`、`isAcyclic` 在**本目录之外 0 个调用者**；`isForged` 生产侧 0 个调用者（只有测试）；`assertForged` 生产侧 1 个（stressHarness） |
| 本批改动 | **零源文件修改、零测试文件修改**。只新增本 README + `khy.module.json`；`git status --porcelain -- <本目录>` 全是 `??` |

## 4. ⚠ 测试隔离与已知警告

**隔离性（实测）**：11 份共置测试是**纯同步、零 IO**——不打 `fs`、不打网络、不改
`process.env`、不起定时器，因此可以任意顺序、任意并发复跑，且不会写出任何文件。
跑完 `git status --porcelain -- services/backend/src/services/domain/structured/structuredFurnace`
实测仍是 11 项 `??`（11 份测试文件本身是本批新增的未跟踪文件），**零 ` M`**。
唯一非确定性来源是被测代码里的 `crypto.randomBytes`（封印盐，进程内一次性），
测试全部在同一进程内铸造并验封，故不受影响（`index.test.js:205` 反过来把
「两条 import 路径共用一把盐」钉成了断言）。

**已知警告**：

1. **不要对本目录用 `node --test <目录>`** —— 本环境给假读数（见 mcp 单元 §4 同型记录）；
   必须显式列 11 个路径。jest 在本环境**未安装**，但本单元与两份单元外测试都是 `node:test`
   方言，**没有方言错配**，30 例全部真实执行 —— 这点和 mcp 单元（8 份跑不了）不同，别照抄它的口径。
2. **多数用例钉的是「当前（错）行为」，不是「应有行为」**。测试头部注释（`anomalyHandler.test.js:9-11`）
   明写：这些用例带 `B31-F<nn>` 标记，**在没有人的裁决前不许靠翻断言来「修好」**。
   看到 `current, wrong` 标题时不要判红，也不要顺手改绿。
3. **登记缺陷共 24 条**（`B31-F1`…`B31-F24` 连续无号缺口，个别条内带 a/b/c 子项），
   逐条见 `khy.module.json` 的 `contract.registered_defects`。其中 **5 条**（F18/F19/F22/F23/F24）
   是本批读源码补出来的，其余 **19 条**由上一位同事在测试注释里点名但一直没编号。
   ⚠ **注释里的编号有两处复用**：`dimensionReducer.test.js:216` 把「共享 registry 跨次累积实体」
   也标成了 `B31-F1`（与词法闸门缺陷同号），`B31-F7` 被用在 3 个互不相关的部位
   （`hadDependency` 写死 / weave 空产物 / `topoSort` 环过度上报）。本清单把它们拆成
   **F24** 与 **F7a/F7c**，源码与测试文件**未作任何改写**。
4. **封印是能力，不是闸门**（B31-F4，high）：浅冻结让 `envelope.payload` 可写、
   `Symbol.for` 品牌让浅拷贝可冒充、而生产接线（`toolUseLoopHelpers.js:1332-1338`）
   **从不调用** `assertForged`/`isForged`。头注释「只能消费熔炉产物…升级为可校验的硬边界」
   （`chaosInterceptor.js:15`）在现网路径上不成立。
5. **跨进程不可验封**：盐是 `crypto.randomBytes(16)` 且「不持久、不出进程」
   （`chaosInterceptor.js:30-31`，注释如实）。任何把信封序列化到磁盘/另一进程再验的用法
   必然抛「封印校验失败」——这不是缺陷，是设计，但改动时必须知道。
6. **git 侧读数只作一次性快照**：本工作区对象库已系统性损坏（`git fsck` 报大量
   `hash-path mismatch` / broken link，另有活动进程在改索引），因此本 README 与清单里
   所有 `??`/` M`/名单类读数都按**磁盘走查**取，复跑前请重新 `git status` 对齐，
   不要把「文件不见了」读成「测试被删了」。
