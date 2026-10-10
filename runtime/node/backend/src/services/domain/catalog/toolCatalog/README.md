# toolCatalog — 工具目录、契约与审计规则

D2 业务上下文里的一个功能单元：把已注册工具收敛成**发现所需的最小目录**（分类、排序、去重），
并提供工具契约（`toolContract`）与目录审计规则（`auditRules`）。3 个源文件全部有同名同目录共置测试
（**55 例 / 0 fail**，2026-09-29 本道显式路径复跑；`grep -c KNOWN-DEFECT` 实测 2 处）。

## 谁在用本单元（非测试外部消费者，去重 3 个已定性）

- `src/cli/handlers/toollist.js` —— `/toollist` 命令面（目录的主展示口）。
- `src/cli/handlers/toolcheck.js` —— `/toolcheck` 命令面（契约与审计的消费方）。
- `src/services/toolCatalog/index.js` —— D1 侧历史路径再导出壳。

另有 1 处路径命中 `src/utils/trimIfString.js` —— **已定性：那是该文件头注释里列举消费者的 JSDoc 行（`:7`），不是 require**。
因此不构成 D3→D2 边，也不计入 fan-in（本单元已定性的外部消费者就是上面 3 个）。

## 出域边（如实登记，不写白名单）

- **D3 共 6 处**（`utils/`、`constants/`），名义边界内合法。
- **D1 标签下 4 处，但逐条看只有 1 处真是 D1**：`toolContract.js:40` → `services/flagRegistry.js`（该文件是
  D3 归位后留下的兼容壳，语义为 D2→D3）；其余 3 处指向 `src/tools/**`（`toolCatalog.js:144`、
  `toolContract.js:113`、`toolContract.js:150`）—— `src/tools` 在 `DOMAIN-DEPS.json` 里**没有域根映射**，
  被判成 D1 纯属路径前缀误判。⇒ 本单元是 §12.43 两个「建门前必须先定判据」样本的集中地：
  兼容壳（Q1 的口径题）与 `src/tools` 归属（Q4）在同一条判据链上。

## 已知缺陷

2 处 `KNOWN-DEFECT`，其中一条是 §12.42 记过的 `toolCatalog.js:63` 的
`CATEGORY_META[cat] || CATEGORY_META.other` 对 `cat='constructor'` 返回 truthy 的 `Object` 函数、兜底被绕过
⇒ `label`/`order` 变 undefined，`/toollist` 的显示与排序受害（原型键一族第五次出现）。一律登记不修。
