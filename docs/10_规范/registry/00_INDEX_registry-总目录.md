# registry

> 本夹由 [MGMT-PLAN-009] B10「二级根目录清空归夹」生成（2026-09-18）。
> 父目录：[../](../00_INDEX_规范-总目录.md)　收录 0 篇。

## 文件清单

- `AESTHETICS-TOKENS.json` —— 软件美学令牌真源（语义名/必需性/跨端映射），语义真源 `[DESIGN-FE-012]` §3
- `API-SURFACE.json` —— **对客端点清单**，五要素（版本 / 请求响应字段 / 认证方式 / 错误码 / 迁移说明）逐端点登记；`[DESIGN-API-002]` §4「先登记后实现」的机读落点，§7 目录表的真源形态；由 `[DESIGN-ARCH-190]` §五 P1-0 建立（2026-10-15）
- `ARCHITECTURE-POLICY.json`
- `CORE-LAYERS.json` —— **洋葱分层契约**：运行时按**加载时机**分 L0 芯 / L1 膜 / L2 皮（不是按目录名切），登记各层的**重量预算**（冷闭包 = 仅顶层 require 边的文件数与行数）、边缘方向矩阵、已知倒挂清单、视觉层分层与守卫覆盖盲区；守卫 `check:core-layers` 消费，规则 `TOOLING-012`，语义真源 `[DESIGN-ARCH-197]`。补的是仓库此前缺失的**重量轴**（位置轴 LAY-005 / 域方向 DOMAIN-DEPS / 模块边界 ARCHITECTURE-POLICY 均不管重量）
- `ATOMIC-CAPABILITIES.json` —— **原子能力（L1）总清单**，6 个暴露面 337 个暴露名归一到 124 个原子能力，逐个登记唯一 canonical 与**参数契约**（726 条参数归一 + 3 组已登记的平台/粒度差异）；`[DESIGN-ARCH-194]` 的机读落点，守卫 `check:atomic-capabilities` 消费。**本文件是生成物**，改能力分组请改 `scripts/lib/atomicCapabilityRegistry.js` 后重跑 `node scripts/ci/gen-atomic-capabilities.js`
- `BUILD-OUTPUTS.json`
- `COPYRIGHT-MATERIALS.json` —— 软著登记材料候选清单（哪两端进材料），守卫 `check:copyright` 消费
- `COPYRIGHT.json` —— 软著登记真源（软件全称/简称/登记版本/著作权人），守卫 `check:copyright` 消费
- `DATA-LOCATIONS.json`
- `DATA-SSOT.json` —— **数据事实单一真源登记表**（规则 LAYOUT-008）：登记每条数据事实的**真源位置 / 取值方式 / 授权镜像 / 影子副本锚点**，**不登记值本身**；守卫 `check:ssot-data` 消费，判据真源 `[DESIGN-LAY-009]`
- `DIST-SYNC.json` —— 分发同步表（发布渠道之间的同步关系）
- `DOMAIN-DEPS.json` —— 五域（D1–D5）名义边界与允许依赖方向，守卫 `check:layout` 的 `domain-direction` 规则消费（真源 `[RESEARCH-018]` §2.1/§4 C-7，说明见 `[DESIGN-LAY-005]` 四b）
- `FEATURE-OWNERSHIP.json`
- `MEMORY-RECORD-SCHEMA.json`
- `PROPOSAL-ARTIFACT-INDEX.json`
- `RULES-REGISTRY.json`
- `SOURCING-PROVENANCE.json`
- `VERSION-MODE.json` —— **版本态机读真源**（开发态 / 发布态双态切换），由 `scripts/release/version-mode.js` 消费

## 跨分类关联指引

- 上级分类索引：[00_INDEX_规范-总目录.md](../00_INDEX_规范-总目录.md)

