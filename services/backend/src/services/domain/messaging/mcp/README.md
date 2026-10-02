# `domain/messaging/mcp` — khy 的 MCP 双面单元（既当客户端，也当服务器）

> 本 README 是本单元的上下文真源之一。机器可读的契约、扇入与登记缺陷见同目录
> `khy.module.json`（守卫 `npm run check:layout` 的 `functional-unit` 规则要求二者并存）。

## 1. 三问（规则 9 / `PROCESS-010`）

| 问 | 答 |
|---|---|
| **谁要的** | 用户。`khy mcp …`（add/list/serve/status/export/oauth）与 `khy gateway` 侧的 MCP 工具调用，都是人直接敲的入口；扇入实测 11 个非测试消费者，第一消费者是 `services/backend/src/cli/handlers/mcp.js`（8 处引用）。 |
| **为什么要这么做** | 这个单元解决的是**同一份 MCP 配置在四处存放**的问题：khy 自己的 `mcp.json`、Claude Code 的 `settings.json`、OpenClaw 的配置、以及 14 家第三方 agent 生态（Cursor/VS Code/Codex/Gemini/Qwen/Kiro/AmazonQ/Copilot CLI/Continue/Zed/Cline/Roo/opencode…）各自的家。没有这一层，每接一家就要复制一段「探测 → 读 → 解析 → 抽 map → 打桥接标记」的分支——`mcpEcosystemRegistry.js` 把这段收敛成一张声明表（`ECOSYSTEMS[]`），这是它存在的全部理由。第二半原因是**方向相反**：khy 也要把自己暴露成 MCP server（stdio / Streamable HTTP / SSE 三种传输），所以服务器侧的协议层、工具暴露策略与预设表也在这里。 |
| **怎么验证** | `node --test services/backend/src/services/domain/messaging/mcp/*.test.js`（**显式列路径**，本环境给目录会得到假读数）→ 21 份共置套件 173 例 / 0 fail / 0 skip；单元外 21 份引用本单元的测试实测 13 份可跑（180 例 / 175 pass / 4 skip / 1 fail，那 1 例是既有真红，见 `khy.module.json` B30-M6），8 份在本环境**无法复跑**（方言错配，不是缺陷）。 |

## 2. 契约（改本单元前先读这段）

- **对外面只有 24 个键**（`index.js` 的 `module.exports`，`index.test.js:88` 逐字钉死）：
  客户端侧 `MCPClient` / `connectMCPServer` / `disconnectMCPServer` / `connectAll` /
  `disconnectAll` / `listMCPTools` / `callMCPTool` / `callTool` / `listResources` /
  `readResource` / `listPrompts` / `getPrompt` / `authenticate` / `getMCPInstructions` /
  `getState` / `getClient` / `getConnectedServers`，配置侧 `loadConfig` / `saveConfig`，
  常量侧 `PROTOCOL_VERSION` / `CLIENT_CAPABILITIES` / `Transport` / `ConnectionState` / `ConfigScope`。
  其余 20 个文件是**纯叶子或薄 IO**，各自独立导出，不聚合进 `index.js`。
- **三种文件角色，改法不同**：纯叶子（`mcpAddSpec` / `mcpServerProtocol` / `mcpServeToolPolicy` /
  `mcpDisclosurePlan` / `mcpGovernance` / `mcpServerStatus` / `mcpServerPresets` / `types` /
  三个 bridge 叶子 / `mcpEcosystemRegistry`）零 IO、确定性、可整包注入 env；
  薄 IO（`mcpConfigStore` / `mcpHttpServer` / `mcpStdioServer` / `mcpServer` /
  `pythonCommandResolver` / `autoConnect`）只做读写与进程；`index.js`（1841 行）与
  `oauthTokenStore.js`（675 行）是两坨有状态主体。**新逻辑一律进纯叶子，不要往 `index.js` 加。**
- **协议版本只有一个真源**：`PROTOCOL_VERSION`（`index.test.js:98` 钉死它 + `CLIENT_CAPABILITIES`
  只声明 `roots` 且被 `Object.freeze`）。任何一家传输自己写死版本串就是第二个真源。
- **配置读的回退链**：`loadConfig` 是 project > user > legacy 三档合并，`_scope` / `_configPath`
  标记来源；旧格式 `{servers:[...]}` 与新格式 `disabled:true` 都折成内部 `_disabled`。
- **门控**（本单元源文件里出现的 `KHY_*` 全数清点，非抽样）：`KHY_MCP_ECOSYSTEM`（生态桥总闸，
  默认开）+ 每家 `KHY_MCP_ECO_<ID>` 子门（13 家合此命名，opencode 那一家叫 `KHY_MCP_ECODE`，
  与家族不一致，见 B30-M6）+ `KHY_MCP_ECODE_BRIDGE` + `KHY_CC_MCP_BRIDGE` + `KHY_MCP_ADD` +
  `KHY_MCP_PRESETS` + `KHY_MCP_SERVE` + `KHY_MCP_AUTOCONNECT` + `KHY_MCP_DISCLOSURE`
  （配 `KHY_MCP_DISCLOSURE_THRESHOLD_PCT` / `KHY_MCP_DISCLOSURE_WINDOW` 两个阈值）+
  `KHY_MCP_RESOURCE_METADATA`；路径/网络位 `KHY_APP_HOME` / `KHY_DATA_HOME` /
  `KHY_MCP_ALLOWED_ORIGINS`；`KHY_HUMAN_GATE` 由治理叶子引用。读取一律
  「flagRegistry 优先，本地 `{0,false,off,no}` 兜底」，**flagRegistry 走的是
  `services/flagRegistry.js` 兼容壳，真身已在 D3 `utils/flagRegistry/`**。
- **凭据**：`oauthTokenStore.js` 存 MCP OAuth token 与 api_key/token 两类静态凭据，
  多后端回退；`authenticate` 缺凭据时抛专词，**不许静默匿名发起**。

## 3. 实测数字（2026-09-29，全数清点非抽样）

| 项 | 读数 |
|---|---|
| 源文件 / 行数 | 21 / 7045（`index.js` 1841、`mcpHttpServer.js` 557、`mcpServerProtocol.js` 496、`mcpEcosystemRegistry.js` 720、`oauthTokenStore.js` 675） |
| 共置测试 | 21 份 ↔ 21 个源文件，一一对同名 → 173 例 / 1107 个断言调用点 / 0 fail / 0 skip |
| 扇入（非测试） | 11 个文件 / 23 个 require 站点：`cli/handlers/mcp.js` ×8、`services/skillSearch.js` ×3、`cli/handlers/mcpExport.js` ×2、`cli/routerDispatchSlash.js` ×2、`services/tool/toolUseLoopCore.js` ×2，其余 6 处各 ×1 |
| 出边 | D3 8 个目标 / 14 站点；D1 名义 5 站点（全是 `services/flagRegistry` 兼容壳，真身 D3）；**无域归属的根 4 目标 / 7 站点**（`src/tools` ×2、`src/tools/platformUtils` ×3、`src/agents/index` ×1、`package.json` ×1） |
| 本批改动 | **零源文件修改**。只新增 21 份共置测试 + 本 README + `khy.module.json`，`git status` 该目录全是 `??` |

## 4. ⚠ 测试隔离警告（跑本目录测试前必读）

单元内 21 份共置测试全部把 `KHY_DATA_HOME` / `KHY_PROJECT_DATA_HOME` / `HOME` 钉到
`fs.mkdtempSync` 临时目录**再 require**，写路径一律打在临时目录；实测跑完
`git status --porcelain -- <本目录>` 仍只有 `??`，**不改任何跟踪文件**。

但**单元外**的 `services/backend/tests/services/externalApps/appModelImporter.test.js`
（属 `network/externalApps` 单元）会改写跟踪文件
`services/Tools/opencode/config/opencode.json`——根因是那条 B30-S1 的错便携根，
见 `../network/externalApps/README.md` §4。

另外，本环境**未安装 jest**：`tests/mcpAutoConnectWiring` / `mcpOAuthTokenStore` /
`mcpRemoteTransport` 三份是 `jest.mock` 方言，`tests/mcpToolPool` /
`services/mcp/mcpServer` / `services/mcp/mcpServerProtocol` /
`services/mcp/mcpServeToolPolicy` / `services/mcpDisclosure` 五份是裸 `describe`
方言（其中三份文件头还自注 `(node:test)`，注释与代码不符）。这 8 份在 `node --test` 下
报的是**文件级装载失败**（node 把它合成 1 个 fail，名字就是文件路径），不是产品缺陷，
**绝不可据此判红**。
