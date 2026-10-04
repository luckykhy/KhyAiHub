# `network/externalApps` — 外部 AI 软件的配置读写适配层（D2 业务上下文单元）

> 5-3-1 定位：**D2 / network 上下文**的功能单元（[RESEARCH-018] §3 P3、C-4/C-5 判据见
> `docs/10_规范/registry/DOMAIN-DEPS.json`）。生命周期记录在同目录 `khy.module.json`。

## 三问（规则 9 / `PROCESS-010`）

**谁要？** 人是消费者与需求方：`khy provider` / `khy mcp` 之外，用户在 opencode、Claude Code、
Codex、Gemini CLI、Trae、Coze 等**外部 AI 软件**里已经配好的模型与密钥，需要被 khy 读出来复用
（反向使用外部软件的模型），也需要被 khy 写回去（把 khy 的厂商配置落到对方能读的位置）。
调用方是 D1 的 CLI handler（`cli/handlers/provider.js`）、网关适配器（`gateway/adapters/*`）、
工具层（`tools/ImportExternalAppModels`）与同域兄弟（`config/ccSwitch/appWriters.js`、
`agents/agentAssets/_adapterBase.js`），共 11 个非测试文件 / 35 个 require 站点。

**为什么在这里而不是别处？** 这块业务的知识是「每个外部软件各自的配置方言」——JSON、
`.env`、TOML、`settings.json` 的 env 块、profile store 五种形状，且 11 家互不兼容。
把它放 D2 是因为它是**业务上下文**（外部软件生态接入），而不是共享底座：`_shared.js` 的
`atomicWrite/expandHome/maskKey/envKeyName` 只有本单元用（fanIn 全在本目录内），
不满足 D3 的「只被依赖」定义。真正的共享件（`utils/trimLowerCase`、`utils/isPlainObject`、
`utils/dataHome`）已经在 D3，本单元按允许方向取用。

**怎么验？** 三层，全部命令可复跑：
1. **单元内共置**：15 个源文件各有同名同目录 `*.test.js`，`node --test` 显式列出 15 个路径 →
   实测 `# tests 205 / # pass 205 / # fail 0 / # skipped 0`（542 条断言）。
2. **单元外行为**：`services/backend/tests/services/externalApps/`（5 份）与
   `tests/tools/configureExternalAppRepair.test.js`。⚠ 其中 3 份是 **jest 方言**，
   `node --test` 跑会报 `ReferenceError: describe is not defined`——那是仪器错配，不是缺陷；
   本环境未装 jest，这三份**无法在此复跑**。另 3 份 node:test 方言实测有失败，
   原因与影响见 `khy.module.json` 的 `registered_defects`（B30-S2、B30-S11）。
3. **端到端**：`khy provider import --app opencode --dry-run` 走
   `appModelImporter.importApp(..., {registrar})`；写路径由调用方注入 registrar 后才落地。

## 契约（改动前必读）

- **11 家适配器同一个六件套**：`configPath / list / get / add / remove / usable`
  （`opencodeAdapter` 另加 `repair`，`zcodeAdapter` 另加 `GATE_SLOTS / KINDS / kindForProtocol`）。
  新增一家就必须齐这六个，缺一个 `appModelImporter` 的 `usable` 探测就把它当不可用。
- **`usable(env)` 是唯一的生产入口形状**：`appModelImporter` 只认
  `typeof adapter.usable === 'function'`，其余方法名各家自便。
- **env 注入是本单元的隔离承诺**：所有公开函数签名都收 `env`，测试据此打在临时目录。
  两个成员破坏了这条（`traeAppAdapter._readStore` 丢参数、`opencodeAdapter` 的便携根候选
  不看 env）——见 B30-S1/S2/S5，这两条会让「沙箱 env」输给真实配置。
- **写必走 `_shared.atomicWrite`**：同目录 tmp + rename（`_shared.js:44-52`），因为对方软件
  随时可能在读这份配置；`remove` 的确认闸门在各家 `remove(..., {confirmed})` 里，
  未确认只回 preview。
- **密钥只在进程内流动**：`_shared.maskKey` 负责一切对外展示，`importApp` 的返回值只带
  `keyMasked`；真 key 只进 `registrar.registerCustomProvider` 的 `keyInput` 字段。
- **门控**：`KHY_EXTERNAL_APP_IMPORT`（读侧，`appModelImporter.isEnabled`）、
  `KHY_OPENCODE_CONFIG_HEAL`（opencode 配置自愈）、`TRAE_SWITCH_STORE_PATH` /
  `GEMINI_CONFIG_DIR` / `OPENCODE_CONFIG(_DIR)` 等各家路径覆盖位。**零硬编码端点**（RUNTIME-001）。

## 已知缺陷：不在本单元修

11 条实测缺陷登记在 `khy.module.json` 的 `contract.registered_defects`（编号 B30-S1…S11；
其中 S3 的病灶在 D1 的 `src/tools/ConfigureExternalApp`、S11 在单元外测试方言，都不在本目录内），逐条附**复现命令与原始输出**。其中 4 条是用户可见/凭据级：
ConfigureExternalApp 工具六个 app 全部报「不支持」（B30-S3）、便携根 `__dirname` 爬根算术
少两级导致真实配置被仓库内文件遮蔽（B30-S1）、`geminiCliAdapter.remove` 删掉共享凭据却留下
被删 provider 自己的密钥（B30-S6/S7）。**修法涉及改 D1/D2 源码与删改跟踪文件，属人的裁决**
（任务 #17），本轮只登记不动源码。
