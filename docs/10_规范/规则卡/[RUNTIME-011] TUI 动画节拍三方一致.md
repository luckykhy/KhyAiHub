---
name: TUI 动画节拍三方一致
id: RUNTIME-011
domain: RUNTIME
nature: 约束为主，兼福利
scope: "TUI 动画节拍的三个可能各说各话的落点：规范表 runtime/node/backend/src/cli/tui/AGENTS.md §3.3、实现真源 runtime/node/backend/src/cli/tui/perfTunables.js 的节拍默认值导出、以及组件里的兜底字面量（Spinner.js 的 FRAME_MS、topicBar.js 的 _ANIM_MS）"
priority: P2
trigger: "改动 tui/AGENTS.md §3.3 计时器表、perfTunables 的节拍导出、或任一组件兜底节拍字面量时"
constraint: "同一动画的节拍在「规范表 / perfTunables 默认值 / 组件兜底值」三处必须一致（R1）；组件兜底值必须等于规范值（R2）；规范表 §3.3 的每一项都必须有对应的 perfTunables 导出（R3）。不一致即 finding。已由规范明确裁决保留的漂移必须在守卫的 KNOWN_DRIFTS 白名单里登记出处，否则不得降级为 info —— 无出处的降级等于把判据关掉。新增/删除节拍项造成的未对账缺口（unbound-*）按盘点处理，不判违规。"
grants: "见约束边界：授权客户（团队）获得「终端动画到底跑多快、谁说了算」的可核查答案，不必读三处源码再自行比对；也授权把已裁决的漂移显式登记为保留，而不是被迫改代码去迎合陈旧规范值。"
benefit: "此前 Spinner 规范写 80ms、实现跑 160ms，漂移 ×2.00 存在了很久没人发现 —— 用户只看到「动画一顿一顿」，因为三处漂移时没有任何一处会报错。同族还有 ProgressBar.RENDER_MS 从错误的源派生（LOW_POWER 下一跳 2%），也是靠人工读代码才发现的。本规则把「规范写了但没人执行」变成提交时可见的 finding。"
exception: "已由规范明确裁决保留的漂移（如 [DESIGN-ARCH-101] §8 裁定 Spinner 160ms 为准）在守卫里以 KNOWN_DRIFTS 登记出处后降为 info；未登记出处的漂移不得降级。纯新增/删除节拍项导致的 unbound-* 缺口按盘点处理（info），不判违规。"
version: "1.0.0 (2026-09-29)"
status: active
ssot: "docs/03_DESIGN_设计/DESIGN-PERF/[DESIGN-PERF-004] TUI 动画节拍治理方案.md"
formerly: 无
owner: governance-team
---

# [RUNTIME-011] TUI 动画节拍三方一致

<!-- RULES-REGISTRY: RUNTIME-011 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/03_DESIGN_设计/DESIGN-PERF/[DESIGN-PERF-004] TUI 动画节拍治理方案.md。

## 约束

同一动画的节拍在「规范表 / perfTunables 默认值 / 组件兜底值」三处必须一致（R1）；组件兜底值必须等于规范值（R2）；规范表 §3.3 的每一项都必须有对应的 perfTunables 导出（R3）。不一致即 finding。已由规范明确裁决保留的漂移必须在守卫的 KNOWN_DRIFTS 白名单里登记出处，否则不得降级为 info —— 无出处的降级等于把判据关掉。新增/删除节拍项造成的未对账缺口（unbound-*）按盘点处理，不判违规。

## 授予权力

见约束边界：授权客户（团队）获得「终端动画到底跑多快、谁说了算」的可核查答案，不必读三处源码再自行比对；也授权把已裁决的漂移显式登记为保留，而不是被迫改代码去迎合陈旧规范值。

## 提供福利

此前 Spinner 规范写 80ms、实现跑 160ms，漂移 ×2.00 存在了很久没人发现 —— 用户只看到「动画一顿一顿」，因为三处漂移时没有任何一处会报错。同族还有 ProgressBar.RENDER_MS 从错误的源派生（LOW_POWER 下一跳 2%），也是靠人工读代码才发现的。本规则把「规范写了但没人执行」变成提交时可见的 finding。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

已由规范明确裁决保留的漂移（如 [DESIGN-ARCH-101] §8 裁定 Spinner 160ms 为准）在守卫里以 KNOWN_DRIFTS 登记出处后降为 info；未登记出处的漂移不得降级。纯新增/删除节拍项导致的 unbound-* 缺口按盘点处理（info），不判违规。

## 版本记录

- 1.0.0 (2026-09-29) 初版 / 迁移自 无
