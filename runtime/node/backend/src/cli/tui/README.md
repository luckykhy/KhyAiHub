# cli/tui — CC 风格 TUI

## 谁要

khy 进程在 KHY_CC_TUI=1 时走这条渲染路径；其余场景走 Legacy。

## 为什么

CC 风格界面需要一套独立的状态机、键盘/鼠标处理与渲染管线，与 Legacy 的输出式交互不共用一套代码。

## 里面有什么

- app.js / CcApp.js —— 应用装配与两种模式入口
- ink-components/ —— Ink 组件（cc 前缀 = CC 模式专用）
- hooks/ —— React hooks（补全、查询桥、手机链路状态）
- utils/ —— TUI 工具函数（换行、通知行、菜单悬停）

## 怎么验

- `npm run check:tui-gates —— 本子系统的专属门禁`
- `KHY_CC_TUI=1 node bin/khy.js —— 起 TUI`
- `node --test tests/cli/tui/ —— TUI 行为测试`

## 生命周期

本单元的 `khy.module.json` 记 `lifecycle.stage = staged`、`provenance = recorded-after-the-fact`：代码是直接写进核心域的，没有经过 `scripts/quarantine/` 缓冲区（判据见 `scripts/quarantine/README.md`）。单元内仍有源文件缺同名同目录测试，晋级三判据未齐，故不签 stable。
