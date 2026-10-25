# services/reasoning — 思维链仲裁

## 谁要

src/services/tool/toolUseLoopCore.js（工具循环里的续写决策）。

## 为什么

思维链续写既要够用又要不烧钱，判定集中在一处才能在预算维度上闭环。

## 里面有什么

- cotArbiter.js —— 分层仲裁与续写决策

## 怎么验

- `node --test tests/services/cotArbiter.test.js`
- `node --check src/services/reasoning/*.js`

## 生命周期

本单元的 `khy.module.json` 记 `lifecycle.stage = staged`、`provenance = recorded-after-the-fact`：代码是直接写进核心域的，没有经过 `scripts/quarantine/` 缓冲区（判据见 `scripts/quarantine/README.md`）。单元内仍有源文件缺同名同目录测试，晋级三判据未齐，故不签 stable。
