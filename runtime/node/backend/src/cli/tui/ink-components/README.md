# cli/tui/ink-components — Ink 组件集

## 谁要

src/cli/tui/app.js 与 CcApp.js 的装配代码。

## 为什么

把每块界面拆成独立组件，样式与状态各自封闭，改一处不牵动整屏。

## 里面有什么

- App.js / CcApp.js —— 两套应用外壳
- MessageBubble / ToolExecutionPanel —— 消息与工具执行面
- CompletionMenu / ParamPanel —— 补全与参数面板
- CcPhoneLinkPanel / CcNoticeBlock —— 手机链路与通知块

## 怎么验

- `npm run check:tui-gates`
- `node --test tests/tui/ tests/cli/tui/`

## 生命周期

本单元的 `khy.module.json` 记 `lifecycle.stage = staged`、`provenance = recorded-after-the-fact`：代码是直接写进核心域的，没有经过 `scripts/quarantine/` 缓冲区（判据见 `scripts/quarantine/README.md`）。单元内仍有源文件缺同名同目录测试，晋级三判据未齐，故不签 stable。
