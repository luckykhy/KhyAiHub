# cli — CLI 入口层

## 谁要

bin/khy.js、delivery 通道脚本、以及所有「把用户一句话变成一次运行」的调用方。

## 为什么

命令路由、REPL 会话与终端渲染都住在这里；它们是 D1 运行时最上层，下接 services（D1/D2），上接交付面（delivery/apps）。

## 里面有什么

- router.js / routerDispatch*.js —— 命令路由与派发
- replSession.js / repl/ —— REPL 会话与启动
- handlers/ —— 每个命令的业务实现（每个 handler 一个文件）
- tui/ —— CC 风格 TUI（KHY_CC_TUI=1 门控）
- formatters.js / aiRenderer.js —— 终端渲染与格式化

## 怎么验

- `node --check src/cli/**/*.js —— 语法`
- `npm run test:tui —— CC 模式 TUI 的专属门禁（见 src/cli/tui/AGENTS.md）`
- `node bin/khy.js doctor —— 入口层自检（默认本地快检，--deep 为全量）`

## 生命周期

本单元的 `khy.module.json` 记 `lifecycle.stage = staged`、`provenance = recorded-after-the-fact`：代码是直接写进核心域的，没有经过 `scripts/quarantine/` 缓冲区（判据见 `scripts/quarantine/README.md`）。单元内仍有源文件缺同名同目录测试，晋级三判据未齐，故不签 stable。
