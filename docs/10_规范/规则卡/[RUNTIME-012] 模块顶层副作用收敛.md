---
name: 模块顶层副作用收敛
id: RUNTIME-012
domain: RUNTIME
nature: 约束为主，兼福利
scope: "启动路径上的 Node 模块顶层语句：runtime/node/backend/src 与 runtime/node/backend/vendor/shared/src 下的 .js（非测试）。判据只覆盖一种形态 —— 顶层语句直接调用**同文件定义的函数**，而该函数体内**同步可达** require / spawn / exec / connect。跨文件导入的被调方只盘点不判违规。"
priority: P2
trigger: "改动 runtime/node/backend/src 或 runtime/node/backend/vendor/shared/src 下的 .js 时（commit 快档按关心面前缀匹配；未触及则恒静默）"
constraint: "任何被启动路径 require 的模块，顶层只允许声明与常量初始化；禁止在顶层调用会 require / spawn / exec / connect 的函数。判据是「同步可达」而非「函数体里出现过」—— 命中点若包在嵌套函数（箭头 / 函数表达式）里，即视为惰性 thunk，不算违规。已知且已裁决的命中（入口脚本、刻意 eager 的 shim）必须在守卫的 KNOWN_TOPLEVEL_SIDE_EFFECTS 白名单里登记出处后降为 info；无出处的降级等于把判据关掉。跨文件导入的被调方（盲区）按盘点处理，不判违规。"
grants: "见约束边界：授权客户（团队）获得「哪些模块在 require 的瞬间就把重依赖拖进首帧」的可核查答案，不必逐个模块读源码再自行推断；也授权把入口脚本与刻意 eager 显式登记为保留，而不是被迫为迎合判据去改掉脚本入口语义。"
benefit: "实测（2026-10-04）cacheService.js 顶层写了 initRedis()，而 initRedis() 体内 require(\"redis\") + createClient() + client.connect() —— require(\"cacheService\") 的瞬间同步拉入整棵 redis 依赖树，require.cache 模块数 543 → 1（修掉顶层调用后），单这一条就是 20.4s / 542 模块。仓库有 1524 个模块进首帧，此前没有任何守卫能发现这类「看起来是声明、实际是执行」的顶层副作用。本规则把「模块加载期偷偷干了活」变成提交时可见的 finding。"
exception: "① 入口脚本（全仓无人 require、由 node <file> 直接执行）的顶层 main()/start() 属入口语义，登记出处后降为 info；② 刻意 eager 的兼容 shim（chalkCompat 必须在 import 时替换 require.cache）同理；③ 单行表达式体箭头（const g = () => require(\"x\"); g();）与顶层 if/try 块内的调用本判据**不判**（保守方向，宁可漏报不可误报）；④ 跨文件导入的被调方不追，只盘点。"
version: "1.0.0 (2026-10-04)"
status: active
ssot: "docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-178] TUI启动44秒病灶-redis顶层副作用与首帧前重require收敛方案.md"
formerly: 无
owner: governance-team
---

# [RUNTIME-012] 模块顶层副作用收敛

<!-- RULES-REGISTRY: RUNTIME-012 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-178] TUI启动44秒病灶-redis顶层副作用与首帧前重require收敛方案.md。

## 约束

任何被启动路径 require 的模块，顶层只允许声明与常量初始化；禁止在顶层调用会 require / spawn / exec / connect 的函数。判据是「同步可达」而非「函数体里出现过」—— 命中点若包在嵌套函数（箭头 / 函数表达式）里，即视为惰性 thunk，不算违规。已知且已裁决的命中（入口脚本、刻意 eager 的 shim）必须在守卫的 KNOWN_TOPLEVEL_SIDE_EFFECTS 白名单里登记出处后降为 info；无出处的降级等于把判据关掉。跨文件导入的被调方（盲区）按盘点处理，不判违规。

## 授予权力

见约束边界：授权客户（团队）获得「哪些模块在 require 的瞬间就把重依赖拖进首帧」的可核查答案，不必逐个模块读源码再自行推断；也授权把入口脚本与刻意 eager 显式登记为保留，而不是被迫为迎合判据去改掉脚本入口语义。

## 提供福利

实测（2026-10-04）cacheService.js 顶层写了 initRedis()，而 initRedis() 体内 require("redis") + createClient() + client.connect() —— require("cacheService") 的瞬间同步拉入整棵 redis 依赖树，require.cache 模块数 543 → 1（修掉顶层调用后），单这一条就是 20.4s / 542 模块。仓库有 1524 个模块进首帧，此前没有任何守卫能发现这类「看起来是声明、实际是执行」的顶层副作用。本规则把「模块加载期偷偷干了活」变成提交时可见的 finding。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

① 入口脚本（全仓无人 require、由 node <file> 直接执行）的顶层 main()/start() 属入口语义，登记出处后降为 info；② 刻意 eager 的兼容 shim（chalkCompat 必须在 import 时替换 require.cache）同理；③ 单行表达式体箭头（const g = () => require("x"); g();）与顶层 if/try 块内的调用本判据**不判**（保守方向，宁可漏报不可误报）；④ 跨文件导入的被调方不追，只盘点。

## 版本记录

- 1.0.0 (2026-10-04) 初版 / 迁移自 无
