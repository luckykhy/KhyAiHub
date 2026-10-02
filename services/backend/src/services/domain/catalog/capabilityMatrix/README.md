# capabilityMatrix — 智能体能力矩阵（D2 功能单元）

一句话：把散落在工具循环里的 ~27 处 `process.env.KHY_*` 内联门控，收敛成一份**人可编辑的数据表**（19 条能力描述符）+ 一个**纯函数路由器**（把一次请求的能力集压成可观测的 Route）。执行位置不变、行为不变（cut 1 只做观测），改能力只需编辑 `descriptors.js`。

清单：`khy.module.json`（domain / mayDependOn / fanIn / lifecycle.stage 四字段被 `npm run check:layout` 的 entry-buffer 规则读取，其余给人看）。

## 逐成员

| 文件 | 角色 | 仓内 require | 同名测试 |
|------|------|-------------|----------|
| `seams.js` | 5 个注入点符号 + 相位地板 + 物理宿主表；纯数据 | 无 | `seams.test.js` |
| `predicates.js` | 6 种 flag 方言的解析叶子（逐字节复现旧内联表达式） | `utils/envFlagEnabled`（D3，再导出同一函数） | `predicates.test.js` |
| `routePresets.js` | 3 条命名路线（research / delivery / audit），纯声明 | 无 | `routePresets.test.js` |
| `descriptors.js` | 能力 SSOT：19 条描述符，声明 data-only | `./seams`；`unknownProblemHandler`（D1，惰性，见下「偏差」） | `descriptors.test.js` |
| `composer.js` | 路线规划器：筛选 + 排序 + 预算背包，零 IO | `./seams` | `composer.test.js` |
| `route.js` | 把运行期 Route 压成观测字段 / CLI 一行摘要 | 无 | `route.test.js` |
| `index.js` | 唯一运行期面：类 + 单例 + 覆盖文件读取（本单元唯一 IO 面） | `fs/os/path`、单元内 4 件、`utils/dataHome`（D3） | `index.test.js` |

外部消费者 4 个（fanIn 实测口径见清单里的 `_fanIn_note`）：`services/capabilityMatrix/index.js`（再导出壳）→ `tool/toolCalling.js`、`tool/toolUseLoopCore.js`、`tool/toolUseLoopHelpers.js`。

## 契约（每条都有测试兜）

1. **方言不漂移**：`resolveFlag` 对每个 env 取值必须给出与旧内联检查相同的布尔；`offDisables` 不 trim 不 lowercase（`'OFF'` 仍为开），`onEnables` 默认关，`module` 抛异常按关处理 → `predicates.test.js`
2. **未知 kind = fail-open，所以目录里不许出现**：解析器对无法识别的 `kind` 返回 true（默认放行），真正的防线是「19 条描述符的 kind 全部在枚举内」这条目录级锁 → `predicates.test.js`
3. **预设不改变谁开火**：cut 1 里 preset 只贴 `inPreset` 标签和做同带内的次序微调，`active` 集合与不带预设时逐字节相同；audit 路线 `whenModes: []` 永不被自动选中，只能按 id 取 → `routePresets.test.js`、`composer.test.js`
4. **预算永不砍不可逆步骤**：`budget` 有限时按成本从高到低丢弃 reversible 条目；不够就把全部 reversible 丢完并如实报超限，绝不丢 `isReversible: false` → `composer.test.js`
5. **目录数据不许烂**：`invoke.module` 全部可解析（一次报全部死链，不像逐条断言那样在第一个失败处停），`requires` 维度必须存在于 `gateway/capabilityRegistry.CAPABILITIES`，`phase` 偏移不得越出本接缝的 100 宽带 → `descriptors.test.js`
6. **清单是冻到骨子里的**：`Object.freeze` 只冻数组外壳，条目与内层数组仍可写，而 `index.js` 把这些引用直接交给调用方（覆盖是浅拷贝 `{...d, ...override}`，所以覆盖路径本来就依赖「不改原表」）→ 现在每条描述符 / 预设都深度冻结，覆盖仍照常生效 → `descriptors.test.js`、`routePresets.test.js`、`index.test.js`

## 已登记的偏差（不在本单元内悄悄修）

- **D2 → D1 一条边**：`descriptors.js:91` 在 `unknownProblem` 的 `isEnabledFn` 里惰性 `require('../../../unknownProblemHandler')`。该边在 `DOMAIN-DEPS.json` 属 `declared_not_enforced`，归 archDebtScan R1 / `cross-layer-require` 棘轮管，本单元只在清单里如实登记，不写进 `mayDependOn` 冒充许可。
- **2 个 `designDoc` 是占位 id**：`DESIGN-ARCH-AUDIT`、`DESIGN-ARCH-CROSS-SRC` 在 `docs/` 下没有同名文件（其余 5 个都有）。要补文档还是改指现有真源，需人拍板；本单元不设白名单把它永久合法化。

## 怎么跑

```bash
# 共置契约测试（node:test 方言；目录参数在 Windows 下会被当模块路径，必须逐个列文件名）
cd services/backend/src/services/domain/catalog/capabilityMatrix
node --test seams.test.js route.test.js routePresets.test.js predicates.test.js composer.test.js descriptors.test.js index.test.js

# 仓级行为测试：capabilityMatrixParity.test.js 是 describe/it（jest 方言），直接 node --test 会整文件 ReferenceError
node .khyos/tmp/jest-lite.js services/backend/tests/root-level/capabilityMatrixParity.test.js
```

`*.test.js` 与 `*.md` / `*.json` 不计入源文件数，因此本单元的记录动作是「7 份同名同目录测试 + 1 份清单 + 本 README」——按守卫实测，每补一份共置测试 `functional-unit` 降 1，补清单一次 `entry-buffer` 降 7。
