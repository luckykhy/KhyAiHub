# metaplan — 元规划与动态约束注入（D2 功能单元）

一句话：把「模型自己决定这次改动要配多少锁」这件事，从一句口头承诺变成一个**有存证的闭环**——模型必须先交出一份三元 JSON（`toolchain` / `constraint_strategy` / `risk_dissent`），系统按风险配发锁具（Soft 不加锁 / Hard 挂代码拦截器 / Block 挂起并要求快照+确认），再由**宪法红线**与**信任熔断**两层单向加严。核心不变量只有一条：**只能加锁，不能减锁**。

清单：`khy.module.json`（domain / mayDependOn / fanIn / lifecycle.stage 四字段被 `npm run check:layout` 的 entry-buffer 规则读取，其余给人看）。

## 逐成员

| 文件 | 角色 | 仓内 require | 同名测试 |
|------|------|-------------|----------|
| `constraintStrategy.js` | 三级约束阶梯（Prompt_Soft ⊏ Code_Hard ⊏ System_Block）与 `escalate` 并上确界；纯数据 | 无 | `constraintStrategy.test.js` |
| `executorRegistry.js` | 武器库 SSOT：4 个执行器，各自声明语言边界与有无 AST 安全网；纯数据 | 无 | `executorRegistry.test.js` |
| `irreversibleSignatures.js` | 破坏性/不可逆动作的**单一模式库**（Goal 1 收敛：两个消费者不再各持一份正则） | 无 | `irreversibleSignatures.test.js` |
| `constitutionalRedLines.js` | 宪法红线三条（毁库 / 泄密 / 毁 package.json 核心依赖块），按**具体动作**匹配，不可覆盖 | `./constraintStrategy`、`./irreversibleSignatures` | `constitutionalRedLines.test.js` |
| `metaPlanSchema.js` | 元规划契约：schema 生成 + 容错解析 + 确定性校验；防偷懒升级在这里发生 | `./constraintStrategy`、`./executorRegistry`、`../../../gateway/safeJsonParse`（**D1，见下「偏差」**） | `metaPlanSchema.test.js` |
| `trustCircuitBreaker.js` | 信任状态机：按任务类型扣分 + 连续翻车则全会话强制 Code_Hard | `./constraintStrategy` | `trustCircuitBreaker.test.js` |
| `codeInterceptors.js` | 真锁具：`babel` / `vm_or_native` / `python_ast` / `balance` 四种校验，全部「绝不向调用方抛」 | `child_process`、`vm`（node 内建）、`@babel/parser`（npm） | `codeInterceptors.test.js` |
| `constraintInjection.js` | 动态注入引擎，刻意分两半：`resolveInjection`（声明要挂什么，零 IO）/ `runHardValidation`（真跑） | `./codeInterceptors`、`./constraintStrategy`、`./executorRegistry` | `constraintInjection.test.js` |
| `index.js` | `MetaPlanCoordinator`：§6 四步闭环（问规划 → 收规划并叠加覆盖层 → 执行前校验 → 回报结果）+ 单元的统一再导出面 | 单元内 7 件 | `index.test.js` |

外部消费者 9 个（实测口径见清单里的 `_fanIn_note`；其中 7 个只取 `constraintStrategy` 的枚举，1 个取 `irreversibleSignatures` 的签名库，1 个取 `constraintInjection`）：

```
constraintLattice.js ─┐
domain/quality/metaConstraint/{index,constraintMatrix,toolFunnelGuard}.js ─┤→ constraintStrategy / constraintInjection
domain/quality/metaConstraint/riskClassifier.js ───────────────────────────┤→ irreversibleSignatures
domain/structured/structuredFurnace/{forgeSchema,dimensionReducer,anomalyHandler}.js ─┘
services/metaplan/index.js（再导出壳）→ index.js
```

依赖方向 `metaConstraint → metaplan` 是单向的：`irreversibleSignatures.js` 之所以住在 metaplan 而不是 metaConstraint，正是因为要让它同时被红线层与风险分级层取用，而不制造反向边。

## 契约（每条都有具名测试兜）

1. **阶梯是单调并上确界**：`escalate(a,b)` 对任意输入组合都返回**更严**的一方，且不满足交换律/幂等/「结果不松于任一输入」的任何一条都算回归；未知值按最严（System_Block）计而非丢弃 → `constraintStrategy.test.js`（全对偶扫描，一次报全部违例）
2. **红线不可覆盖、也不可被绕过**：三条红线各自的触发面与**不触发面**都逐条钉住（读 `.env` 不泄、`cat` 无外调动词不算泄、保留依赖块的 package.json 改写不算毁）；`enforce` 无命中时**原样返回**传入策略（既不放松也不顺手收紧），有命中时结果必然 System_Block → `constitutionalRedLines.test.js`
3. **红线之间有稳定次序**：同时命中多条时报的是先检查的那条（红线 1 压 2/3），这样 overrides 台账里的归因不会随实现细节漂动 → `constitutionalRedLines.test.js`
4. **偷懒只会被加严，不会被拒**：`Prompt_Soft` + 不充分 `risk_dissent` **不判失败**，而是确定性升级为 `Code_Hard`，并把升级理由写进 `escalations`；`declared_strategy` 原样保留（谁说的谁负责）→ `metaPlanSchema.test.js`
5. **充分的论证是真捷径**：无 AST 执行器（`raw_string_injector`）配一句够长的 dissent 必须**留在 Soft、零升级**——这是本目标想保住的快速路径；如果哪天它也被升级，就是这条测试先红 → `metaPlanSchema.test.js`、`constraintInjection.test.js`
6. **菜单 == 注册表**：`buildMetaPlanSchema()` 的 `toolchain.items.enum` 逐元素等于 `executorIds()`，且 `describeForModel()` 每一行都来自同一张表；模型可得的选项永远不可能多于校验器认的 → `metaPlanSchema.test.js`、`executorRegistry.test.js`、`index.test.js`
7. **执行器表不许烂**：8 个键的完整形状、4 条目的精确值、`listExecutors()` 逐条目给新对象、`validateToolchain` 对空/非数组/未注册 id 的拒绝文案（并把整个武器库重打印一遍好让模型自纠）→ `executorRegistry.test.js`
8. **签名库是收敛后的唯一真源**：7 个库的条目数、每条正则的命中与**误报**边界（`\b` 纪律：`warm` 不是 `rm`、`delicious` 不是 `del`、`package.json.bak` 不是 `package.json`）；无 `/g` 状态化模式（否则 `some()` 会给出交替结果）→ `irreversibleSignatures.test.js`
9. **拦截器绝不抛、且缺工具不阻断**：`runInterceptor` 对 (键 × 内容 × ctx) 全组合的**全域性**扫描；python 不可用时降级为 `{ok:true, skipped:true}`（「不比今天更差」），未知键回显键名并跳过，null 键是**显式**的「裸执行器，风险自担」而非偶然通过 → `codeInterceptors.test.js`
10. **语言决定插件**：`typescript` → 只开 ts 插件（禁 jsx，源码注释明写理由）；`tsx` → ts+jsx 同时开；`jsx` → 类型注解必须报错。这条把注册表的语言声明和拦截器分派缝在一起，两侧任一分叉都会红 → `codeInterceptors.test.js`
11. **Soft 什么都不挂**：`resolveInjection(Soft)` 的 `validators` 是**空数组**（不是「挂了好但不跑」），`promptHint` 是唯一那句 ≤40 字的固定提示；`System_Block` 是**双保险**——快照+确认**且**保留代码校验；未知/缺失策略回落 `Code_Hard` 而不是回落便宜的 Soft → `constraintInjection.test.js`
12. **声明与执行不许分叉**：对 (三种策略 × 三种 toolchain) 全组合，`runHardValidation` 跑的结果条数必须等于 `resolveInjection` 声明的挂载数，否则编排器推理的是一份计划、执行的是另一份 → `constraintInjection.test.js`
13. **熔断只惩罚「押 Soft 然后翻车」**：Hard/System_Block 下的失败被记为 `hard_failure`（安全网在正常工作，不是失信），不计入连击；一次 Soft 成功清连击但**不能**撤销已扣的信任分；会话锁一旦合上**永不**自开；任务类型先归一化（大小写/空白/非字符串），无类型统一落 `default` 桶而不是落进所有桶 → `trustCircuitBreaker.test.js`
14. **审计面是副本**：`events()` / `distrustedTypes()` 返回拷贝，改返回值不能改写台账；错误摘要只取首行并截到 200 字 → `trustCircuitBreaker.test.js`
15. **覆盖层的次序**：schema 自升级 → 熔断地板 → 宪法红线，**红线最后**所以 unmistakably 不可覆盖；`overrides` 数组的内容与次序逐条钉住（用注入的桩熔断器把次序与连击算术隔离开）→ `index.test.js`
16. **没有票据就不许执行**：`validateExecution` 对缺 `_plan` 的票据返回 `allowed:false` + System_Block + 快照/确认双要求，**绝不**退化成「当它是 Soft 放行」→ `index.test.js`
17. **状态住在实例上**：无单例、无 memoize，两个协调器的熔断器互不影响；re-export 是**同一对象**（身份相等，不是拷贝），否则调用方与协调器会各看一份执行器表 → `index.test.js`

## 已登记的偏差与缺口（不在本单元内悄悄修）

- **D2 → D1 一条边**：`metaPlanSchema.js:25` 在文件头 `require('../../../gateway/safeJsonParse')` 取 `extractFirstJson`。该边在 `DOMAIN-DEPS.json` 属 `declared_not_enforced`，归 archDebtScan R1 / `cross-layer-require` 棘轮管，本单元只在清单里如实登记，不写进 `mayDependOn` 冒充许可。摘掉它的办法是把这一个纯字符串叶子里沉到 D3（`src/utils`），或由调用方注入。
- **已修复｜`getExecutor` 与 `isRegistered` 曾对 `Object.prototype` 键判定不一致**：原 `executorRegistry.js:96` 用 `_BY_ID[key] || null`（原型链查找），而 `:101` 的 `isRegistered` 正确使用 `hasOwnProperty`。于是 `getExecutor('constructor')` 返回 `Object` 构造函数、`getExecutor('toString')` 返回 `Object.prototype.toString`，**违反其自身 JSDoc「Look up an executor by id, or null」**；下游 `resolveInjection` 因此会产出一条 `validator` 字段为 `undefined`（而非声明的 `string|null`）的挂载项。复现链：`.khyos/tmp/b23-repro-getexecutor.js` → 改前 `.khy/feedback/b23-metaplan/repro-before.txt`、改后 `.khy/feedback/b23-metaplan/repro-after.txt`（六个原型键全部收敛为 `null`，`resolveInjection` 的 `validator` 回到 `null`）。处方已由中央应用：`getExecutor` 改为 `isRegistered(id) ? _BY_ID[...] : null`。本文件不擅自改源码，测试 `executorRegistry.test.js` 现在钉的是**两者一致**这一修复后的正确行为。历史上下文：该缺陷当前**不可被模型触发**（`validateToolchain` 一直用的是正确的那一半），属潜伏 API 契约缺陷。
- **缺口｜执行器表只冻了数组外壳**：`Object.freeze(EXECUTORS)` 不冻条目，`EXECUTORS[0]` 仍可写；`listExecutors()` 虽逐条目 `{...e}` 拷贝，但嵌套的 `languages` **按引用外泄**，消费者可以就地拓宽某个执行器的语言边界（`executorRegistry.test.js` 明确不执行这个写操作，只把引用同一性钉住）。同一件事在 `catalog/capabilityMatrix` 已被修成深冻（该单元契约第 6 条），本单元尚未。处方：逐条目 `Object.freeze` + `languages` 也冻。
- **缺口｜红线 1 的第二个签名库看不见 SQL 文本**：`checkAction` 用 `commandish = command + '\n' + sql` 扫 `DB_DROP_PATTERNS`，却只用 `${command} ${path}` 扫 `DB_FILE_PATTERNS`——而后者正是装着 `/\bdropDatabase\s*\(/` 的那一支。于是 `db.dropDatabase()` 作为 shell 命令会被拦，作为 `params.sql` 会**漏拦**。复现与两侧输出都在 `constitutionalRedLines.test.js`（已标 registered gap）。处方：把 DB_FILE 的扫描目标对齐为 `${command} ${sql} ${path}`。
- **缺口｜`checkAction` 没有顶层 `sql` 便捷字段**：JSDoc 只承诺 `tool/params/command/path/content`，`sql` 只在 `params.sql`/`params.query` 被读；调用方把 SQL 挂在动作顶层即等于未经筛查。这是**调用方契约要求**（已在 `constitutionalRedLines.test.js` 钉住 `check({sql:'DROP DATABASE …'}) === null`），要不要补一个便捷字段属设计决定，未擅自补。
- **缺口｜`isStrategy` 会把单元素数组强转成策略名**：`hasOwnProperty.call(RANK, ['Prompt_Soft'])` 因键强转而返回 true，与 JSDoc「one of the three legal enum values」不符。现有调用方全部先 `String()` 归一，不可达；处方：前置 `typeof s !== 'string'` 守卫。
- **缺口｜`_str` 对函数值返回 `undefined`**：`JSON.stringify(function(){})` 返回 `undefined` 且**不抛**，catch 分支到不了，于是一个名为「转成字符串」的叶子吐出了非字符串。当前无 bank 匹配字面文本 `undefined`，故只错类型不错判定。处方：JSON 尝试后再兜一层 `String(x)`。

## 怎么跑

```bash
# 共置契约测试（node:test 方言；目录参数在 Windows 下会被当模块路径，必须逐个列文件名）
cd services/backend/src/services/domain/project/metaplan
node --test constraintStrategy.test.js irreversibleSignatures.test.js constitutionalRedLines.test.js \
  metaPlanSchema.test.js executorRegistry.test.js codeInterceptors.test.js constraintInjection.test.js \
  trustCircuitBreaker.test.js index.test.js

# 仓级行为测试（同为 node:test，经 D1 再导出壳取数，可直接跑）
node --test services/backend/tests/services/metaplan/metaPlanSubsystem.test.js
```

hermetic 纪律（本目录 9 份测试都遵守）：不发网络、不碰数据库、不写盘；`codeInterceptors.test.js` 把 `KHY_PYTHON_BIN` 钉到一个不存在的解释器名，使 python_ast 那一支在任何机器上都走**同一条**降级 arm（而不是撞上开发机的 python 或 Microsoft Store 的 `python3` 存根），并在文件级 `after()` 里还原；`metaPlanSchema.test.js` / `trustCircuitBreaker.test.js` 对 `KHY_METAPLAN_MIN_DISSENT` / `KHY_METAPLAN_SESSION_TRIP` 同样设了就还原（用 `try/finally`，不用 `t.after`——后者在单条测试结束就触发，会让后续测试跑在还原后的 env 上）。`JEST_WORKER_ID` 必须在**首次调用前**清掉，因为 `_getBabel()` 的判定是模块级缓存。

`*.test.js` 与 `*.md` / `*.json` 不计入源文件数，因此本单元的记录动作是「9 份同名同目录测试 + 1 份清单 + 本 README」——按守卫实测，每补一份共置测试 `functional-unit` 降 1，补清单一次 `entry-buffer` 降 9。
