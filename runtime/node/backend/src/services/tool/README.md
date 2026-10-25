# services/tool — 工具执行单元

## 谁要

CLI 的对话循环（aiChatCore.js）、src/tools/ 下的具体工具、以及 src/routes/ 的工具相关端点。

## 为什么

「一次工具调用发生了什么」的所有判定（权限、审批、循环、召回）集中在这里，才谈得上统一口径。

## 里面有什么

- toolUseLoopCore.js / toolUseLoopHelpers.js —— 循环内核
- toolCalling*.js —— 调用解析与权限判定
- loop/ —— 审批、中断、工具名与输出整形
- deferredRecallIndex.js —— 延迟召回索引

## 怎么验

- `node --test tests/services/ tests/tools/ —— 工具层与工具契约测试`
- `node --check src/services/tool/*.js`

## 生命周期

本单元的 `khy.module.json` 记 `lifecycle.stage = staged`、`provenance = recorded-after-the-fact`：代码是直接写进核心域的，没有经过 `scripts/quarantine/` 缓冲区（判据见 `scripts/quarantine/README.md`）。单元内仍有源文件缺同名同目录测试，晋级三判据未齐，故不签 stable。
