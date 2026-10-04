# cognitiveSnapshot — 上下文永续与认知压缩引擎

D2 业务上下文里的一个功能单元：`CognitiveContextEngine`，负责长会话的三级压缩、状态快照与溢出拦截。
6 个源文件，全部有同名同目录的共置测试（30 处 `KNOWN-DEFECT` 断言钉住实测行为）。

## 各文件的职责（取自各文件头注释）

| 文件 | 角色 |
|---|---|
| `index.js` | `CognitiveContextEngine` 门面：上下文永续与记忆压缩 |
| `compressionEngine.js` | 三级认知压缩引擎（§3.2） |
| `offloadStore.js` | L3 卸载离境的外部持久层（§3.2 L3 / §3.3 外部卸载指针集） |
| `overflowInterceptor.js` | 断点续传网关 / 溢出拦截器（§3.4） |
| `snapshotManager.js` | 状态快照与热插拔接力（§3.3） |
| `workbench.js` | 工作台与冷热分层（§3.1，CPU 寄存器模式） |

## 谁在用本单元（非测试外部消费者，去重 2 个）

- `src/services/cognitiveSnapshot/index.js:4` —— D1 侧历史路径再导出壳。
- `src/services/tool/toolUseLoopHelpers.js:1386` —— 工具循环侧惰性 require，取 `CognitiveContextEngine`。

## 出域边（如实登记，不写白名单把它合法化）

- **D3 共 8 处**（`utils/` 与 `constants/`，共享底座，名义边界内合法）。
- **D1 共 3 处**，全部指向同一个文件 `services/contextWasm.js`：`compressionEngine.js:42`、`index.js:55`、`workbench.js:34`。
  D2 的名义 `mayDependOn` 只有 `["D2","D3"]`，这 3 条属 `DOMAIN-DEPS.json` 的 `declared_not_enforced` D2→D1，
  交 `archDebtScan` R1 / `cross-layer-require` 棘轮与任务 #17 第 19 项（Q2）管辖 —— 逐条裁决面见 `[DESIGN-LAY-008]` §12.43。

## 已知缺陷

30 处 `KNOWN-DEFECT` 以共置测试钉住（grep 实测：compressionEngine 4 / index 4 / offloadStore 4 /
overflowInterceptor 5 / snapshotManager 7 / workbench 6）。全部只登记不修：改任何一条都改变面向模型的上下文取舍结果，属行为变更。
