# session — 会话上下文计量、分叉与拓扑（D2）

业务上下文：`/fork`、`/topology`、`/btw`、`/context`、`/session` 五个命令，
以及 REPL / TUI 里「上下文用了多少、哪来、能不能压」的全部计量。

## 谁要（角色）

- **`/fork` `/topology` `/btw`**：`constants/commandSchema.js:1087-1091,1094-1098,
  1101-1105` → `cli/handlers/fork.js:21`、`topology.js:23`、`btw.js:16-17`。
- **`/context` `/session`**：`commandSchema.js:1958`、`:2014,2019`；
  slash 侧 `cli/routerDispatchSlash.js:383` 取 `context/ctxWindowStats`。
- **REPL 的上下文计量面板**：`cli/replSession.js:5818,5850,5855`
  （contextBreakdown / contextSuggestions / messageBreakdown）；
  TUI 侧 `cli/tui/ink-components/App.js:476-479,800,3193`；
  工具侧 `tools/CtxInspectTool/index.js:80,136,183,190`。
- **会话色态与其它 handler**：`sessionColorState.js:31` 及
  `color/copy/recap/rename/statusline/tag/heapdump/debugToolCall` 均读
  `sessionForestService.getCurrentSessionId()`。
- 壳：`services/{chatStateIsolation,conversation,contextScope}/index.js`。

## 为什么这么做

计量必须与渲染分开，否则「为什么这里显示 68%」无法复算：`context/` 五个文件
（`contextBreakdown` / `contextSuggestions` / `ctxWindowStats` / `messageBreakdown` /
`webContextStats`）全是**注入 env 的纯聚合**，阈值以常量暴露
（`NEAR_CAPACITY_PERCENT`、`LARGE_TOOL_RESULT_PERCENT`、`READ_BLOAT_PERCENT`、
`MEMORY_HIGH_TOKENS`、`DEFAULT_CONTEXT_WINDOW`），渲染只走
`renderContextBreakdownLines` 一类出口。`contextScope/` 决定检索范围
（`taskSignalExtractor` 抽信号、`scopeRanker` 加权排序、`budgetController` 收预算、
`aiMapIndex` 是唯一读盘的索引）。`conversation/` 的 btwNote 是纯归一 + 内存队列。
`session/sessionForestService.js` 刻意做成 **IO 壳**：`:21` 转发
`require('../../../sessionPersistence')`，拓扑算法在 `utils/sessionTopology`，
依赖经 `sessionForestPort` 注入——这是本仓 P2 阶段专门拆过的反向边之一。

## 怎么验

```bash
cd services/backend
node --test tests/services/session/sessionForkPlan.test.js       # 23 tests / 23 pass / 0 fail
node --test tests/services/conversation/btwNote.test.js          # 12 tests / 12 pass / 0 fail
```

## 已知缺陷（登记，不在本单元擅自修）

`session/sessionForestService.js` 当前是 ` M`（作者在做中改动），本卡只登记
其结构事实（IO 壳 + 端口注入），不复述内部行为；改动落地后需复跑上面两条命令。
