# [DESIGN-ARCH-143] DSH 插件生态接入评估与分层适配方案

> **状态**：提案（待评审，未实施）
> **范围**：`services/backend`（CLI 子命令 + extensions/bridges）；不改既有扩展体系语义
> **上游依赖**：deepseek-ai/deepseek-harness（DSH）v0.1.7-rc.1，MIT
> **调研指针**：DSH `docs/architecture.md`（2026-09-23 版）、`dsh.so` 插件登记站、InfoQ 2026-08 开源报道
> **模板合规**：B-P2 七字段见 §2；本提案为**新增能力域**（见 §2 字段 6b），不适用 B-P1 豁免

---

## 0. 一句话结论

**Khy 当前不支持安装 DSH 插件，也不应该"直接支持"** —— DSH 插件是同进程挂载的 Cordis 服务，连它的 agent 主循环本身都是插件；整内核引入等于在 khy 主进程里再嵌一个与 `toolUseLoopCore` 竞争的第二内核。但 DSH 生态（开源 6 周约 1700 个精选插件，MIT）是真实杠杆，值得**分层有条件接入**：MCP 同源能力直连（零新代码）→ 只读盘点（一期）→ 纯工具类白名单适配（二期可选）→ 替换内核类（明确不做）。

| 问题 | 结论 | 依据 |
|---|---|---|
| Khy 现在能装 dsh 插件吗 | **不能** | `dsh` 在 backend 源码概念级零命中（仅子串噪音）；自有扩展体系只认自家格式 |
| 需要"完整支持"吗 | **不需要** | 自有扩展/插件/网关链/MCP 四套机制已存在；直接装 = 嵌入第二内核 + 供应链风险进主进程 |
| 可以设计接入方案吗 | **可以，本文** | 分层：T0 MCP 直连 / T1 只读盘点 / T2 白名单适配 / T3 不做 |

---

## 1. 现状实证

### 1.1 Khy 侧（file:line 可复核）

| 既有机制 | 位置 | 说明 |
|---|---|---|
| 自有扩展管理 | `services/backend/src/services/domain/extensions/extensions/extensionManager.js`（`EXTENSIONS_DIR = extensionRoots.userExtensionsDir()`；2026-09-24 起用户安装根迁至 `<dataHome>/extensions`，默认 `~/.khy`，旧 `<appHome>/extensions` 降级为遗留根仍被发现，见 `[DESIGN-TOOL-002]` §2.1） | 安装/卸载/启停/load 的 canonical |
| 自有扩展市场 | `services/backend/src/services/extensionMarketplace.js:41`（`DEFAULT_REGISTRY = 'https://registry.khy.dev'`，`:52` 可被 `KHY_EXTENSION_REGISTRY` 覆盖） | search/install/uninstall/scaffold，包装 extensionManager |
| CLI 插件命令 | `services/backend/src/cli/router.js` `case 'plugin'`（`require('./plugins')` 的 `getPluginList/reloadPlugins/PLUGINS_DIR` + `handlers/plugin-dev` 的 SDK 插件） | 自定义命令插件（`PLUGINS_DIR` 下 `.js`）与 SDK 插件两路 |
| 网关插件链 | `services/backend/src/services/gateway/pluginChain.js`（`router.js` 内 `gwPlugins.list()`） | AI 网关中间件，非通用插件系统 |
| MCP 客户端域 | `services/backend/src/services/domain/messaging/mcp/`（`autoConnect` / `toolPool` / `ccMcpBridge` / `ocMcpBridge` / `oeMcpBridge` / `mcpEcosystemRegistry` / `mcpGovernance` / `mcpServerProtocol` / `mcpHttpServer`） | **T0 路线的既有基座**：MCP server 已可接入 khy 工具池 |
| extensions 板块 | `extensions/{bridges,scripts,tools}/`（先例：`extensions/bridges/khy-trae-bridge/`） | 本提案 T2 落点的板块先例 |

### 1.2 DSH 侧（外部证据，2026-09-23 核实）

| 事实 | 来源 |
|---|---|
| MIT 许可（"Adopt MIT for DSH packages"，2026-08-13 提交）；v0.1.7-rc.1（2026-09-23） | GitHub 仓库 LICENSE 与 commit 历史 |
| 基于 Cordis 微内核，"一切皆插件"：模型适配器、工具注册表、会话日志、**agent 主循环**均为可替换插件 | 官方 `docs/architecture.md` |
| 插件 = npm 包，`package.json` 的 `dsh.bundle` 字段指向 patch 文件（Cordis 配置行 + 挂载代码）；`dsh.profile` 叠加 bundles；安装即组合 | 同上 |
| 能力经 `ctx` 键贡献：`ctx.tools` / `ctx.llm` / `ctx.commands` / `ctx.sessions` / `ctx.agents` / `ctx.agentLoop` / `ctx.shell` / `ctx.sandbox` / `ctx.fs` / UI 节点等 | 同上 |
| **同进程挂载，无插件级进程隔离**（`ctx.sandbox` 只约束插件 spawn 的子进程，不隔离插件运行时） | 同上 |
| 生态约 1700 条精选插件（awesome-dsh-plugin）；第三方评测明确指出生态治理缺位、装社区插件前需人工审源码 | dsh.so、2026-08 第三方评测 |

### 1.3 搜索结论（字段 6b 的证据）

- 搜索词：`dsh`（backend src / docs / extensions，概念级零命中）、`extensionLoader|extensionRegistry|loadExtension|pluginRegistry`（backend services，命中自有件）、`mcpClient|MCP client|modelcontextprotocol|mcpServers`（backend services，命中 MCP 域）。
- 结论：仓内**无任何 dsh 兼容层**；本提案是新增能力域，非扩展既有 canonical 的行为修正。

---

## 2. 借鉴提案（B-P2 七字段）

### 【借鉴提案 P-01】DSH 插件清单静态盘点与纯工具类插件最小适配

1. **借鉴对象**：deepseek-ai/deepseek-harness（DSH）v0.1.7-rc.1（2026-09-23，commit 46a7f68）。
2. **借鉴内容**：借其**插件清单（`dsh.bundle` / `dsh.profile` 字段与 patch 文件）的静态解析方法与能力分类口径**（一期，reference）；二期对白名单内纯工具插件借其 **Cordis ctx.tools 最小运行时面**（adapter）。
3. **解决的问题**：khy 自有市场（`registry.khy.dev`）生态从零起步，而 DSH 生态已有约 1700 条插件；khy 用户既无法盘点本机已装的 dsh 插件（不知道身边有什么可用能力），也无法复用其中纯工具类插件（如终端、文件、通知、数据库集成）。指向现有缺口：`extensionMarketplace.js` 只认自家 registry 格式；`router.js` 无任何 dsh 入口。
4. **许可证与代码性质**：MIT；核实位置 `https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE`（"Adopt MIT for DSH packages"，2026-08-13）。一期不引入上游代码；二期仅作为 npm 依赖引入 `cordis`（DSH 的底层框架，同为 MIT），不引入 DSH 自身源码。
5. **借鉴方式**：一期 `reference`（只读解析 manifest，零上游代码）；二期 `adapter`（隔离 context + 白名单映射）。判定依据：不 vendored / 不 fork（上游 0.1 处于 developer preview，契约可能 breaking）；adapter 的调用边界与降级路径见 §3/§4。
6. **落点与现有实现对比**：
   - a. 落点：一期 `services/backend/src/cli/handlers/dsh.js`（新增）+ `router.js` 新 `case 'dsh'`；二期 `extensions/bridges/khy-dsh-bridge/`（新增，板块先例 `khy-trae-bridge`）。
   - b. 现有同类实现：见 §1.3 —— 全部为 khy 自有格式，无 dsh 兼容件可扩展，故新增而非复用；T0 路线**不新增**任何实现，直接使用既有 MCP 域。
7. **验收方式**：
   - 一期：对装有 dsh 的机器执行 `khy dsh inspect`，输出 bundles 清单（名称/版本/贡献类型/风险标记），全程零插件代码执行，`node --test services/backend/tests/cli/dshInspect.test.js` 全绿。
   - 二期：白名单内一个纯 `ctx.tools` 插件在 khy 会话中作为工具被模型调用成功，且 `khy dsh inspect --json` 对该插件标注 `adaptable: true`。

---

## 3. 目标形态（分层契约）

```
┌────────────────────────────────────────────────────────────┐
│ T0  MCP 直连（已存在，零新代码）                              │
│     dsh 生态中本质是 MCP 服务的能力 → khy MCP 域直接接入      │
├────────────────────────────────────────────────────────────┤
│ T1  只读盘点（一期）khy dsh inspect                          │
│     静态解析 DSH 安装目录的 profiles/bundles 清单             │
│     输出：贡献类型 + 风险标记；绝不 require 插件代码          │
├────────────────────────────────────────────────────────────┤
│ T2  白名单适配（二期，可选）extensions/bridges/khy-dsh-bridge│
│     仅贡献面 ⊆ {ctx.tools} 的插件 → 映射进 khy 工具注册表     │
│     经既有工具权限闸门；bridge 崩溃 → 工具不注册 + 披露       │
├────────────────────────────────────────────────────────────┤
│ T3  明确不做：agentLoop / sessions / UI / fs / shell 类插件  │
└────────────────────────────────────────────────────────────┘
```

- **T1 inspect 输出契约**：每个 bundle 一行——`name / version / 贡献类型（ctx.tools|ctx.llm|ctx.commands|agentLoop|sessions|ui|fs|shell|other）/ adaptable（是否仅 ctx.tools）/ 风险标记（引用 patch 涉及的 ctx 面）`。`--json` 输出同构 JSON。
- **T2 适配边界**：bridge 在**独立 Cordis context** 中加载插件，只挂 `ctx.tools` 一个键；工具调用经 khy 既有工具权限闸门与 `onControlRequest` 审批流；bridge 加载失败或插件越界注册其他 ctx 键 → 该插件整体不注册并向用户披露，主进程不受影响。
- **降级路径**：T2 整体卸载（`uninstallExtension`）即回到 T1 状态；一期删除 `handlers/dsh.js` + router case 即完全回滚。

---

## 4. 实施分期（每期独立可回滚）

| 期 | 内容 | 新增文件 | 回滚方式 |
|---|---|---|---|
| 一期 T1 | `khy dsh inspect` 只读盘点 + `node:test` 测试（`require('node:test')`，前置不满足显式 skip） | `cli/handlers/dsh.js`、`tests/cli/dshInspect.test.js`、router.js 一个 case | 删新增文件 + 撤 router case |
| 二期 T2 | khy-dsh-bridge extension + 白名单 schema + 权限审计接线 | `extensions/bridges/khy-dsh-bridge/**` | `uninstallExtension` |
| T0 | 无实施，仅在文档记录使用方式 | 无 | 不适用 |

**验收门禁**（每期通用）：`npm run check:layout`（extensions 落点）、`npm run check:gov-rules`、`node --test services/backend/tests/cli/dshInspect.test.js`；二期另跑 `npm run rules:gate:commit`。

---

## 5. 诚实边界（刻意不纳入）

| 不做 | 原因 |
|---|---|
| 在 khy 主进程默认路径引入 DSH 运行时 | DSH 的 agent loop 自身是插件，引入即双内核 |
| 任意 dsh 插件"可装"承诺 | 多数插件深度耦合 `ctx.sessions/agents/UI` 面，只有纯工具子集可适配；对可适配子集也不做安全背书（上游治理缺位是上游事实） |
| 聚合 dsh 生态到 khy 市场 UI | `registry.khy.dev` 是自有真源，混入第三方索引会制造并行真源 |
| 自动安装（`khy dsh add`） | 盘点可以做，安装决策必须留给用户逐个确认 |

---

## 6. 反模式（这条路别走）

| ✗ 别做 | 为什么 |
|---|---|
| 在 khy 主进程 require 社区 dsh 插件 | 同进程无隔离（上游文档明示）+ 生态治理缺位 = 供应链事故直接打穿主进程 |
| 把 khy 改造成 Cordis 树、"一切皆插件"化 | 与 `toolUseLoopCore` 双内核打架；违反「不新建并行真源」铁律；上游 0.1 契约随时 breaking |
| 把 dsh bundle 的 patch 文件当通用 YAML 配置套用到 khy | Cordis config rows 按 id 定位 khy 不存在的行，语义完全不同 |
| 为接入加常驻 env 门（如 `KHY_DSH_ENABLED`） | 撞门预算棘轮（`check-tui-gates.js` MAX_GATES 只降不升）；bridge 是 extension 自带启停，无需新门 |
| 先写代码后补本提案 | B-P2.1：决策必须发生在写代码之前 |

---

## 7. 验收方式

见 §2 字段 7 与 §4 门禁表。一期做成的判据：**在一台装有 dsh 的机器上，`khy dsh inspect` 能如实列出该机的 bundles 与贡献类型，且全程零插件代码执行**。

---

## 8. 待核实项

| # | 事项 | 影响 | 状态 |
|---|---|---|---|
| 1 | ★ DSH 安装目录真值（`$DSH_HOME`？`~/.dsh`？profiles 子目录布局）——官方文档只给了 Electron 桌面端例子（`$DSH_HOME/profiles/desktop`） | 阻断一期的路径解析实现，不阻断本设计 | 一期动工前在实机 `dsh` 环境实测 |
| 2 | `dsh.bundle` patch 文件的确切 schema（architecture.md 未详列） | 影响一期贡献类型的解析精度 | 读上游 `docs/cookbook/extension-cookbook.md` |
| 3 | CLI 子命令名 `dsh` 是否与 `aliases.js` 既有别名冲突 | 命名 | 实施前查重 |
| 4 | 二期引入 `cordis` npm 包的体积与许可合规复核 | 二期准入 | 实施前 |

---

## 9. 变更日志

- 2026-09-23 初稿：评估结论（不直接支持、分层接入）+ T0–T3 分层方案 + B-P2 七字段登记。
- 2026-09-24 环境注记：khy 用户安装扩展根同日迁至 `<dataHome>/extensions`（用户拍板，`[DESIGN-TOOL-002]` §2.1 同步）——DSH 本机盘点（一期）将来读的安装目录同样按数据家解析。
