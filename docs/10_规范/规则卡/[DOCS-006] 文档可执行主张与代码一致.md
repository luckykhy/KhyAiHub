---
name: 文档可执行主张与代码一致
id: DOCS-006
domain: DOCS
nature: 约束为主，兼福利
scope: "docs/03_DESIGN_设计/** 与 docs/10_规范/** 下非 00_INDEX_*、非规则卡的文档（与 DOCS-005 同范围，当前 329 份）；判据为文档写下的可执行字面量在代码中是否存在"
priority: P1
trigger: "新增或修改任一文档中的端点、命令或路径主张时；或运行 npm run check:doc-claims 时"
constraint: "文档写下 /api/x 这类端点字面量即构成对读者的可验证承诺，源码中必须存在该挂载；文档不得写下带版本前缀的端点而代码挂载无前缀（或反之）；npm run 目标须能在 package.json 解析到（由 check-repo-layout 的 dangling-task 承担，本条不重复）。"
grants: "授权在 S1 阶段据候选清单人工判断是否改动文档；授权对历史设计文档保留的过时端点示例加注释豁免；命令内路径类主张在 S1 不作判定（实测精度 21.9%，噪声压过价值），仅作复核线索输出。"
benefit: "把「内容级漂移」从「按设计不在射程」变成可判定——实测首轮 124 条端点主张中 9 条源码无实现，逐条人工核实 9/9 为真漂移，其中 [DESIGN-API-003] 写 /api/v1/large-tasks 而代码实挂 /api/large-tasks、[DESIGN-RL-001] 写 /api/v1/strategies 而代码实挂 /api/strategies。该判据不依赖 git 时间戳，故对「代码先走、文档没跟上」这一方向同样有效。"
exception: "与 DOCS-005 同范围：索引页、规则卡（生成物）、报告、叙事与科普类不参与；带模板段的端点（/api/v1/{id}）无法逐字比对故跳过；命令内路径主张仅作线索不作 finding（实测精度 21.9%：726 命中里 136 为搬迁后仍可达，其余多为文档中的历史命令示例）；绝对路径与示例占位名不判。"
version: "1.0.0 (2026-10-18)"
status: active
ssot: "docs/10_规范/DESIGN-DOC/[DESIGN-DOC-005] 文档可执行主张校验规范.md"
formerly: 无
owner: governance-team
---

# [DOCS-006] 文档可执行主张与代码一致

<!-- RULES-REGISTRY: DOCS-006 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/DESIGN-DOC/[DESIGN-DOC-005] 文档可执行主张校验规范.md。

## 约束

文档写下 /api/x 这类端点字面量即构成对读者的可验证承诺，源码中必须存在该挂载；文档不得写下带版本前缀的端点而代码挂载无前缀（或反之）；npm run 目标须能在 package.json 解析到（由 check-repo-layout 的 dangling-task 承担，本条不重复）。

## 授予权力

授权在 S1 阶段据候选清单人工判断是否改动文档；授权对历史设计文档保留的过时端点示例加注释豁免；命令内路径类主张在 S1 不作判定（实测精度 21.9%，噪声压过价值），仅作复核线索输出。

## 提供福利

把「内容级漂移」从「按设计不在射程」变成可判定——实测首轮 124 条端点主张中 9 条源码无实现，逐条人工核实 9/9 为真漂移，其中 [DESIGN-API-003] 写 /api/v1/large-tasks 而代码实挂 /api/large-tasks、[DESIGN-RL-001] 写 /api/v1/strategies 而代码实挂 /api/strategies。该判据不依赖 git 时间戳，故对「代码先走、文档没跟上」这一方向同样有效。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

与 DOCS-005 同范围：索引页、规则卡（生成物）、报告、叙事与科普类不参与；带模板段的端点（/api/v1/{id}）无法逐字比对故跳过；命令内路径主张仅作线索不作 finding（实测精度 21.9%：726 命中里 136 为搬迁后仍可达，其余多为文档中的历史命令示例）；绝对路径与示例占位名不判。

## 版本记录

- 1.0.0 (2026-10-18) 初版 / 迁移自 无
