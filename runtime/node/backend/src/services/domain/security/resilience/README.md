# resilience — 有限窗口降级与强制兜底协议单元

隶属 `services/backend/src/services/domain/security/`。把「每个核心意图绑定一棵有限深度
降级熔断树 + 预算闸门 + 死循环检测 + 强制兜底交差」这套协议收成一个可注入的门面
（`ResilienceCoordinator`），供 toolCalling、adversarial、selfHeal 等上层以非侵入方式接入
（不改 `toolUseLoop`，接入点只是把 `executeTool` 包成 runner）。

## 成员表

| 文件 | 角色 | requires（单元内） | 对应测试 |
|---|---|---|---|
| `errorSignature.js` | 调用签名 + 失败归类（纯叶子，绝不抛） | — | `errorSignature.test.js` |
| `fallbackTree.js` | 降级树 builder，硬上限 depth=3 / retry=1 / 冻结产物 | — | `fallbackTree.test.js` |
| `deadLoopDetector.js` | 「同一发子弹」检测（纯内存，可 reset） | `errorSignature` | `deadLoopDetector.test.js` |
| `budgetAdapters.js` | 步数/Token 预算适配器，统一 `snapshot()` 契约 | `fallbackTree` | `budgetAdapters.test.js` |
| `budgetExecutor.js` | 协议心脏：预算闸门阶梯、修复门控唯一重试、失败降级注入 | `deadLoopDetector` `errorSignature` `fallbackTree` `salvage` `budgetAdapters` | `budgetExecutor.test.js` |
| `intentTrees.js` | 内置意图→降级树注册表（当前 1 棵：`fetch-web-content`）+ 残料抽取 | `fallbackTree` | `intentTrees.test.js` |
| `salvage.js` | 强制兜底 JSON 组装（SalvageProtector） | — | `salvage.test.js`（钉的是集中修复后的行为，见 D3） |
| `index.js` | 门面：`ResilienceCoordinator` + `makeToolRunner` + 全量再导出 | 上列全部 | `index.test.js` |

## 消费者与实测 fan-in

单元外真实 `require`（grep 实测，2026-09 计数口径：**生产 5 + 测试 3 = 8**）：

| 消费者 | 路径 | 引用方式 |
|---|---|---|
| 兼容 shim | `services/backend/src/services/resilience/index.js` | `require('../domain/security/resilience')` |
| 工具调用主循环 | `services/backend/src/services/tool/toolCalling.js` | `require('../resilience')`（经 shim） |
| 对抗压力台 | `services/backend/src/services/domain/security/adversarial/stressHarness.js` | `require('../resilience')` |
| 自愈·树供给 | `services/backend/src/services/domain/maintenance/selfHeal/fallbackTree.js` | `require('../../security/resilience')` |
| 自愈·错误诊断 | `services/backend/src/services/domain/maintenance/selfHeal/errorDiagnostician.js` | `require('../../security/resilience')` |
| 测试 ×3 | `tests/services/{adversarial,resilience,selfHeal}/*.test.js` | 经 shim |

## 编号契约 → 命名测试

| # | 契约 | 测试（文件 · 用例名） |
|---|---|---|
| C1 | 树深/重试硬上限、builder 拒绝超限、产物冻结 | `fallbackTree.test.js`（既有） |
| C2 | 预算 `snapshot()` 语义；显式 0 = 真枯竭不回落缺省 | `budgetAdapters.test.js`（既有） |
| C3 | 预算阶梯：地板/不足/中途熔断时**精确存活集 + 丢弃项原因串**（如 `skipped:budget-floor(33%<40%)`） | `budgetExecutor.test.js` · `gate ①…` / `gate ②…` / `mid-ladder floor cut…` |
| C4 | 绝不开启第二遍循环；穷尽即 tree-exhausted 兜底 | `budgetExecutor.test.js` · `full ladder exhausted…` |
| C5 | 唯一重试仅限「修复且真的换了输入」，死循环探针二次否决 | `budgetExecutor.test.js` · `repair-gated retry…` 等 4 例 |
| C6 | 内置 `fetch-web-content` 树形状、三 Plan 的 buildParams 精确形状、冻结 | `intentTrees.test.js` · `buildWebContentTree: intent…` / `per-plan buildParams contract…` |
| C7 | 意图注册表冻结且仅一项；`getIntentTree` 命中给**新树**（无记忆化）、未命中给 null、容忍首尾空白 | `intentTrees.test.js` · `INTENT_TREE_BUILDERS: frozen registry…` / `getIntentTree: hit → fresh…` |
| C8 | `_textSalvage` 候选优先级、trim 门、results 列表编号拼接、4000 字符上限 | `intentTrees.test.js` · `_textSalvage: …` 4 例 |
| C9 | 门面 16 键精确导出，且全部为同源**同一绑定**（禁止重新实现/记忆化包装） | `index.test.js` · `face: exports exactly…` / `face: every re-export is the SAME binding…` |
| C10 | `makeToolRunner` 拒绝非函数；trace = baseTrace + `resiliencePlan/resilienceRetry`（无 meta 时键仍在） | `index.test.js` · `makeToolRunner: …` 2 例 |
| C11 | 协调器缺省预算=树深、`opts.budget/floorPct/detector/onDegrade/availableTools` 全部透传；未注入 detector 时每次 `run()` 全新（无跨 run 状态泄漏） | `index.test.js` · `coordinator: default budget…` 等 6 例 |
| C12 | 未知意图/非法输入**必须交差**兜底 JSON（`unknown-intent` / `executor-error`），不抛给调用方 | `index.test.js` · `coordinator.run: unknown intent still 交差…` / `coordinator.run: non-string non-tree…` |

## Manifest 裁决

本工作流开始时，任务简报所称「父级 `security/khy.module.json` 管辖整个子树」**与磁盘不符**
（`find services/backend/src/services/domain/security -name khy.module.json` 为空）。按简报
指令「除非父清单确有不符才考虑单元清单，否则把决定记在 README」——我未创建任何清单文件。
会话进行中，并行编排进程已在本目录落下单元级 `khy.module.json`（domain D2、fanIn 5、
stage stable），本单元自此受其管辖，不存在也不需要第二个竞争真源。其 `fanIn: 5` 与本
README 的生产消费者计数一致（其口径不含 `*.test.js`；加上 tests/ 下 3 份外部行为测试
即上表的 8）。该清单另钉了两条 `_textSalvage` 内容级偏差（null 条目抛错、字符串条目
命中 `String.prototype.link`），复现归并行进程（`.khy/feedback/b23-resilience/`），与本
README D2 所记 `getIntentTree` 原型链泄漏（`.khy/feedback/b23-resilience-2/`）互不覆盖。

## 偏差与已知缺陷

- **D1 缺口清单过期**：简报称 `budgetExecutor.test.js` 缺失，实际已在盘（16.6 KB、
  24 用例，经逐条核对断言的是真实阶梯行为），本工作流未触碰它，只补了
  `intentTrees.test.js` 与 `index.test.js`。
- **D2 `getIntentTree` 原型链泄漏（真实缺陷，已集中修复）**：注册表查找曾走原型链，
  `getIntentTree('valueOf'/'hasOwnProperty')` 抛 TypeError、`'constructor'` 返回 `{}`、
  `'toString'` 返回字符串；连带门面 `run('valueOf')` 违反 C12「绝不抛」直接 reject。
  复现存证：`.khy/feedback/b23-resilience-2/repro-before.txt` 与
  `.khy/feedback/b23-resilience/repro-before.txt`（缺陷 2，探针
  `.khyos/tmp/b23-proto-lookup-probe.js`）。修复（2026-09-28，编排方集中落地）：查找前加
  `Object.prototype.hasOwnProperty.call`，只认自有键；测试已翻正为修复后契约
  （`getIntentTree: inherited keys return null…`），原 skip 的期望契约用例已删除。
- **D3 `salvage.js` 纯空白池缺陷**：由编排方集中修复，本单元不触碰
  `salvage.js`，`salvage.test.js` 断言的即修复后行为（空白池 → `''`）。
- **D3b `_textSalvage` 两条偏差（本批已修，复诊见 repro-after）**：results[] 含 null 条目抛
  TypeError（违背函数自身「绝不抛错」JSDoc）、字符串条目命中 `String.prototype.link`
  把原生函数串渲染进残料——生产路径靠 `_salvageOf` 的 try/catch 兜住第一条。
  见 `intentTrees.test.js` 的两条同名用例（已改写为钉住修后契约），
  复现存证 `.khy/feedback/b23-resilience/repro-before.txt`（缺陷 1）。
- **D4 测试基线**：`node --test` 八个文件名逐一传入（Windows 下目录参数会被当模块路径）
  → 129 tests / 129 pass / 0 fail / 0 skip；测试全内存、有界，不使用任何计时器。
