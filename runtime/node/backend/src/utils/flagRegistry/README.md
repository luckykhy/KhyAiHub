# flagRegistry — D3 共享底座 / KHY_* 门控的声明式中央注册表

一句话：把散在全仓 ~1500 个 `KHY_*` env 门控的**解析方言**与**父→子优先级**收成一份声明式真源，
调用方只问「这个 flag 现在开不开」，不再各自手写私有 `_off`。

## 为什么住在 D3（而不是 services/）

`DOMAIN-DEPS.json` 对 D3 的 evidence 是「fan-in>30 的枢纽绝大多数落在 `utils/` 与 `constants/`」。
本单元 fan-in 实测 **223** 个非测试源文件（清单见 `khy.module.json` 的 `_fanIn_note`），
且真身**零 require、零 IO、确定性、绝不抛**——它自述就是「纯叶子」。
此前它住在 `services/`（D1），于是 8 个同为 D3 的消费者（`utils/gateOn`、`utils/isEnabledDefaultOn`、
`utils/resolveNumericFlag`、`utils/pythonPath`、`constants/prompts` ×4）不得不向下伸回 D1 取它，
构成 `check:layout` 的 d3-purity 违规。归位后这些边变成 D3 内部边（允许）。

- 旧路径 `services/backend/src/services/flagRegistry.js` 保留为**一行再导出壳**，223 个消费者不改。
- 迁移批次与前后读数：`[DESIGN-LAY-008]` §12.7（P2 第 17 批，2026-09-28）。

## 契约

| 导出 | 语义 | 失败模式 |
|---|---|---|
| `isRegistryEnabled(env)` | 自门控 `KHY_FLAG_REGISTRY`，缺省开 | 只认 4 词显式关闭 |
| `isFlagEnabled(name, env, _seen)` | 按登记模式解析；**父关 → 子必关**（集中施加，不逐站点重刻） | 未登记的 name 保守放行 `true` |
| `resolveNumeric(name, env)` | `numeric` 模式取数，带 min/max clamp | 坏值 → 登记表 default |
| `listFlags()` | 返回副本（不改内部表） | — |
| `FLAGS` / `OFF_WORDS` / `VALID_MODES` / `VALID_OFF_NAMES` | 声明表面向守卫与测试开放 | — |

**刻意不做的两件事**（改动前务必读）：
1. **不统一关闭词方言**：`CANON`(4 词) / `EXTENDED`(6 词) / `MINIMAL`(3 词) 是各 flag 的历史事实，
   注册表**记录**分歧而不是抹除；抹平等于给某些 flag 悄悄加/减关闭词 = 静默行为变更。
2. **不迁移全部站点**：`FLAGS` 是**种子集**（已确证的父子链 + outlier）。

结构不变量由 `npm run check:flag-registry`（`scripts/lib/flagRegistryGuard.js`，查活表不查文本）把守。

## 测试

- 行为契约 40 例：`services/backend/tests/services/flagRegistry.test.js`（jest 方言）
- 层契约 4 例（本目录）：`node --test services/backend/src/utils/flagRegistry/index.test.js`
  锁壳/真身同一模块、壳不含逻辑、D3→D1 反向边棘轮（上限 35）、父子链在真实表上生效。
