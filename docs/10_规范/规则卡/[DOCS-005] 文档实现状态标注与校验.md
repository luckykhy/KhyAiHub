---
name: 文档实现状态标注与校验
id: DOCS-005
domain: DOCS
nature: 约束为主，兼福利
scope: "docs/** 下带 <!-- IMPL-STATUS: --> 标记的文档（当前 127 份）；判据为该文档声称的实现路径在仓库中是否真实存在"
priority: P1
trigger: "新增或修改任一带 IMPL-STATUS 标记的文档时；或运行 npm run check:doc-drift 时"
constraint: "一份文档标 IMPL-STATUS: done，其声称的实现路径必须在仓库中真实存在——搬迁过的须先过方案 P 前缀映射与同名兜底；标 todo 的文档可写尚不存在的路径（属规划非漂移）；不得以人工标记为准而不核对代码；864 份无标记文档不受本条管辖。"
grants: "授权维护者在 S1 阶段据本守卫的候选清单自行判断是否改动文档——守卫只报告不裁决，约 10% 为已知误报（agent 基础设施与本机态目录、Windows 路径、相对片段）；授权对误报加注释豁免而不修改判据。"
benefit: "把「这份设计落码了没有」从一句无守卫的人工约定变成可判定事实——此前 127 份标记文档中无一被任何脚本消费，且标记本身已被证伪（[DESIGN-ARCH-131] 首行 done 而正文写未落地、[DESIGN-ARCH-030] done 而实现已从仓库消失）；首轮 done 54 vs todo 7 的不对称证明标记携带信息，判据有区分力；经一轮收口（误报排除 + 路径更正 + 据实改标记）后 done 类漂移归零。"
exception: "无标记文档不在管辖范围（占 993 份中的 866 份），需先补标记才受检；docs/html/ 孪生件排除；命名模板（<域>.js、{A,B}.js）与 node_modules 排除；.khy/.khyos/.zcode/.claude 等 agent 基础设施与本机态目录排除；superseded 文档的历史路径单列审计项、不算漂移；内容级漂移（数值/口径/命令/错误码与代码不符）不在本条射程——git 时间戳判先后已被实测证伪，理由见 SSOT §四。"
version: "1.1.0 (2026-10-18 收口：新增 superseded 第三态，done 类漂移归零)"
status: active
ssot: "docs/10_规范/DESIGN-DOC/[DESIGN-DOC-004] 文档实现状态标注规范.md"
formerly: 无
owner: governance-team
---

# [DOCS-005] 文档实现状态标注与校验

<!-- RULES-REGISTRY: DOCS-005 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/10_规范/registry/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/10_规范/DESIGN-DOC/[DESIGN-DOC-004] 文档实现状态标注规范.md。

## 约束

一份文档标 IMPL-STATUS: done，其声称的实现路径必须在仓库中真实存在——搬迁过的须先过方案 P 前缀映射与同名兜底；标 todo 的文档可写尚不存在的路径（属规划非漂移）；不得以人工标记为准而不核对代码；864 份无标记文档不受本条管辖。

## 授予权力

授权维护者在 S1 阶段据本守卫的候选清单自行判断是否改动文档——守卫只报告不裁决，约 10% 为已知误报（agent 基础设施与本机态目录、Windows 路径、相对片段）；授权对误报加注释豁免而不修改判据。

## 提供福利

把「这份设计落码了没有」从一句无守卫的人工约定变成可判定事实——此前 127 份标记文档中无一被任何脚本消费，且标记本身已被证伪（[DESIGN-ARCH-131] 首行 done 而正文写未落地、[DESIGN-ARCH-030] done 而实现已从仓库消失）；首轮 done 54 vs todo 7 的不对称证明标记携带信息，判据有区分力；经一轮收口（误报排除 + 路径更正 + 据实改标记）后 done 类漂移归零。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

无标记文档不在管辖范围（占 993 份中的 866 份），需先补标记才受检；docs/html/ 孪生件排除；命名模板（<域>.js、{A,B}.js）与 node_modules 排除；.khy/.khyos/.zcode/.claude 等 agent 基础设施与本机态目录排除；superseded 文档的历史路径单列审计项、不算漂移；内容级漂移（数值/口径/命令/错误码与代码不符）不在本条射程——git 时间戳判先后已被实测证伪，理由见 SSOT §四。

## 版本记录

- 1.1.0 (2026-10-18 收口：新增 superseded 第三态，done 类漂移归零) 初版 / 迁移自 无
