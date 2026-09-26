---
name: 工作流节点类型接线一致
id: TOOLING-011
domain: TOOLING
nature: 约束为主，兼福利
scope: "工作流引擎的**节点类型声明面与执行面**：`services/backend/vendor/shared/src/workflow/nodeCatalog.js`（声明 SSOT）、`services/backend/src/services/domain/project/workflow/workflowExecutor.js`（执行语义）、`services/backend/src/services/domain/project/workflow/workflowRunWorker.js`（跨进程执行路径）。不含画布前端 `apps/ai-frontend/` 与 ai-backend 的 REST 校验 —— 那两处已消费目录，不构成漂移面。"
priority: P1
trigger: "新增 / 重命名 / 删除任一工作流节点类型时；改 `switch (node.type)` 时；改 `default` 分支时；新增或修改 `workflowRunWorker.executeRun` 时；用户报「工作流跑成功了但某一步没生效」时。"
constraint: "节点类型只有 `nodeCatalog.js` 一处真源，执行器**必须消费**它：① 目录声明的每个类型，执行器必须有 handler（**单向包含**，目录是权威）；② 对未知节点类型必须 **fail-closed**（抛错），**不得**静默标 `skipped` 后继续走 default 端口 —— 那会让整图以 `completed` 收尾而该节点什么都没做；③ worker 路径在执行前必须过目录校验，不得把未经校验的 `graphJson` 直接交给执行器。"
grants: "见约束边界：授权执行器按目录声明的端口与字段语义实现 handler，并允许目录先行登记、执行器随后补齐 —— 但补齐之前，该类型必须被守卫拦下（不允许「目录已声明而执行器静默跳过」的中间态上线）。"
benefit: "「工作流成功了但某一步没做」这类静默失真从机制上消失；新增节点类型只需改一处真源，漂移在 commit 档就被拦下，不必等到运行期靠人看日志发现。"
exception: "两类：① `node-undocumented`（执行器有 handler、目录未声明）**不阻断** —— 它是「画布不可达」的前置条件而非产物问题，恒为 warning；② 目录与执行器源码的**注释、文档字符串**里出现的类型名不计入对账（只比对目录条目的 `type` 字段与 switch 的 `case` 标签）。"
version: "1.0.0 (2026-09-23)"
status: active
ssot: "docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-141] 动态工作流-运行时自演化与节点热插拔方案.md"
formerly: 无
owner: architecture-team
enforcement: "scripts/ci/check-workflow-node-parity.js"
---

# [TOOLING-011] 工作流节点类型接线一致

<!-- RULES-REGISTRY: TOOLING-011 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-141] 动态工作流-运行时自演化与节点热插拔方案.md。

## 约束

节点类型只有 `nodeCatalog.js` 一处真源，执行器**必须消费**它：① 目录声明的每个类型，执行器必须有 handler（**单向包含**，目录是权威）；② 对未知节点类型必须 **fail-closed**（抛错），**不得**静默标 `skipped` 后继续走 default 端口 —— 那会让整图以 `completed` 收尾而该节点什么都没做；③ worker 路径在执行前必须过目录校验，不得把未经校验的 `graphJson` 直接交给执行器。

## 授予权力

见约束边界：授权执行器按目录声明的端口与字段语义实现 handler，并允许目录先行登记、执行器随后补齐 —— 但补齐之前，该类型必须被守卫拦下（不允许「目录已声明而执行器静默跳过」的中间态上线）。

## 提供福利

「工作流成功了但某一步没做」这类静默失真从机制上消失；新增节点类型只需改一处真源，漂移在 commit 档就被拦下，不必等到运行期靠人看日志发现。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

两类：① `node-undocumented`（执行器有 handler、目录未声明）**不阻断** —— 它是「画布不可达」的前置条件而非产物问题，恒为 warning；② 目录与执行器源码的**注释、文档字符串**里出现的类型名不计入对账（只比对目录条目的 `type` 字段与 switch 的 `case` 标签）。

## 版本记录

- 1.0.0 (2026-09-23) 初版 / 迁移自 无
