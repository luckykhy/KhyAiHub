# cli/handlers — 命令处理器

## 谁要

命令注册表（cli/commands/registry.js）与 router：它们按名字取到 handler 再调用。

## 为什么

一个命令一个文件是本仓的约定：新增命令 = 新增 handler 文件 + 在注册表登记，而不是往某个大文件里加分支。

## 里面有什么

- init.js —— 初始化向导与 khy doctor（细分成 initDoctorProbes.js / initClaudeSettings.js）
- gateway*.js —— 网关相关命令
- doctor*.js —— 诊断相关命令
- phone.js / amoo.js —— 手机与 amoo 原子能力通道

## 怎么验

- `node bin/khy.js <命令> —— 手工验证一个 handler`
- `node --test tests/cli/handlers/ —— handler 级测试`
- `node --check src/cli/handlers/*.js —— 语法`

## 生命周期

本单元的 `khy.module.json` 记 `lifecycle.stage = staged`、`provenance = recorded-after-the-fact`：代码是直接写进核心域的，没有经过 `scripts/quarantine/` 缓冲区（判据见 `scripts/quarantine/README.md`）。单元内仍有源文件缺同名同目录测试，晋级三判据未齐，故不签 stable。
