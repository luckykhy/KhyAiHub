# cli/tui/hooks — TUI 的 React hooks

## 谁要

src/cli/tui/ink-components/ 里的组件。

## 为什么

把「订阅 / 轮询 / 键盘态」这类跨渲染的状态从组件里抽出来，组件只管画。

## 里面有什么

- useCompletions.js —— 补全菜单
- useQueryBridge.js —— 查询与流式结果桥
- usePhoneLinkStatus.js —— 手机链路状态

## 怎么验

- `npm run check:tui-gates`
- `node --test tests/cli/tui/`

## 生命周期

本单元的 `khy.module.json` 记 `lifecycle.stage = staged`、`provenance = recorded-after-the-fact`：代码是直接写进核心域的，没有经过 `scripts/quarantine/` 缓冲区（判据见 `scripts/quarantine/README.md`）。单元内仍有源文件缺同名同目录测试，晋级三判据未齐，故不签 stable。
