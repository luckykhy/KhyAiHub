# catalog — 命令、工具与能力的登记表（D2）

子上下文：`commandCatalog` / `toolCatalog` / `capabilityMatrix` / `toolUseLoop`。
这是「系统对外说自己会什么」的那份账，也是 `khy --help`、`/features`、
`toollist`、`toolcheck` 与 Web 命令页的共同真源。

## 谁要（角色）

- **看能力清单的人**：`cli/handlers/features.js`、`toollist.js`、`toolcheck.js`；
  Web 侧 `routes/commands.js`；壳 `services/{commandCatalog,capabilityMatrix}/index.js`。
- **要「工具契约」的工具回路**：`catalog/toolCatalog/toolContract.js` 定契约，
  `catalog/toolUseLoop/abortCascade.js` 是本目录 `toolUseLoop/` 子上下文里
  被工具回路消费的文件之一（该子目录整体由
  `services/tool/toolUseLoop*` 使用）。
- **能力矩阵的档位判定**：`capabilityMatrix/descriptors.js:245` 把
  `quality/toolFunnelGuard` 的 `enforce` 挂成 invoke——登记表面向人，
  同一张表同时是机判入口。

## 为什么这么做

命令面是**会被冻结的面**：`[DESIGN-DELIV-002]` 的任务面棘轮（命令 245 / 别名 591 /
handler 155，只降不升）要求「有多少命令」这件事有一个可数、可 diff 的单一真源，
所以清单不能散在 router 的 switch 里——`commandCatalog` 把它收成数据，
`toolCatalog` 用 `toolContract` 规定每个工具必须声明什么，
`capabilityMatrix` 把「档位 + 描述符 + invoke」三件绑在一条记录上。
`toolUseLoop/` 放在本目录是因为回合级判定（中止、级联、阶段）需要读同一份契约，
而不是因为它属于工具回路。

## 怎么验

```bash
cd services/backend
node --test tests/allCommandsCatalog.test.js                     # 11 tests / 11 pass / 0 fail
```
同族：`tests/diskAnalyzeCatalog.test.js`、`tests/upstreamStudyCatalog.test.js`
（node:test，本卡未复跑），`tests/services/catalog/{toolCatalog,advisorPlan,
commandCatalog}.test.js` 亦存在（本卡未逐条复跑，形态未核）。

## 已知缺陷（登记，不在本单元擅自修）

`khy --help` 的完整画面由 `cli/help*` 渲染，不由本目录直接输出；
两份「清单」的一致性目前靠 `tests/allCommandsCatalog.test.js` 与棘轮守卫
（`npm run check:delivery`）夹住，缺一侧即漂移。
