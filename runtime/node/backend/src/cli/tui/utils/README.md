# cli/tui/utils — TUI 工具函数

## 谁要

src/cli/tui/ 下的组件与 hooks。

## 为什么

把「怎么排版、怎么保持光标、怎么判悬停」从组件里抽出来，保证全屏一致的排版行为。

## 里面有什么

- wrapCell.js —— 显示宽度换行
- ccNoticeLines.js —— 通知块行渲染
- sgrHold.js —— SGR 序列保持
- menuHover.js —— 菜单悬停判定

## 怎么验

- `npm run check:tui-gates`
- `node --test tests/cli/tui/`

## 生命周期

本单元的 `khy.module.json` 记 `lifecycle.stage = staged`、`provenance = recorded-after-the-fact`：代码是直接写进核心域的，没有经过 `scripts/quarantine/` 缓冲区（判据见 `scripts/quarantine/README.md`）。单元内仍有源文件缺同名同目录测试，晋级三判据未齐，故不签 stable。
