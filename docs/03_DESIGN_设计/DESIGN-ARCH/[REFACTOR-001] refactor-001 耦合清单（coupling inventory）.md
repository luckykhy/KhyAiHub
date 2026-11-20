# refactor-001 耦合清单（coupling inventory）
状态：设计稿，待人工评审；本次未改动生产代码。


- 生成：2026-11-16，作者：耦合清单编写员（工作流子代理）
- 数据真源：`.khyos/refactor-drafts/coupling-facts.json`（边表 generatedAt 2026-11-16T04:24:39.791Z）、
  `.khyos/refactor-drafts/assets-facts.json`、`.khyos/refactor-drafts/layout-facts.json`
- 本文件是**草稿**，不改任何生产代码；所有数字可回溯到三份 facts JSON 或下文 §1 列出的实测命令
- 方案原文路径（services/backend、packages/* 等）与本仓真实落点的换算见 §5；一律以
  `scripts/ci/check-repo-layout.js` 的 LAYERS 名册为准

---

## 1 范围与方法

**扫描 roots**（coupling-facts.json `scan.roots`，6 个）：
`apps`、`delivery/web`、`delivery/channel`、`delivery/extension`、`runtime/node/backend`、`runtime/node/ai-backend`。

**排除**（`scan.excludes`）：`node_modules`、`dist*`、`build*`、`.git`、`.khyos`、`out`、`coverage`、`release`、
`target`、`unpacked`、`*.timestamp-*.mjs`、electron.vite 构建产物。
**边扩展名**（`scan.edgeExtensions`）：`.js/.mjs/.cjs/.jsx/.ts/.tsx/.vue`。

**未在扫描范围内**（读数按「未扫」处理，不是「无耦合」）：
`runtime/substrate/platform`（Python 启动器 khy_platform 与三个共享包本体只作为 `@khy/*` 目标出现）、
`delivery/mobile`（Flutter 端，不在 roots）、`runtime/boot/kernel`、`entries/`、`works/`、`scripts/`。

**规模读数**（`scan` 与 `coverage` 字段）：收集 7908 文件（含 Python），其中 7831 进入边扫描；
消费侧包 11 个（`coverage.consumerPackagesList`：apps/khyos-desktop、khyquant/frontend、
khy-amoon-bridge、khy-trae-bridge、khy-desktop-rd/{goose,openflux}、khy-markdown 及其 muya-embed/stubs、
ai-frontend、provider-hub）。边表聚合后 **201 条有向边、248 个加权 require/import 位点**
（本会话实测命令：`node -e "…edges.reduce((s,e)=>s+e.count,0)"` → 248，`edges.length` → 201）。
命中方式分布（via，实测）：`pkg` 153、`path` 41、`reverse-path` 6、`pen` 1。

**本会话重实测/抽查的命令**（计数全部来自 facts JSON，以下用于回溯验证）：
1. `node -e` 读取三份 JSON 的全部顶层键与计数（edges/gatewayBypasses/hostLeaks* 各数组长度）
2. `node -e` 按 from 前缀分组统计（结果见 §2 表）
3. 源码抽查 10 处（全部与 facts JSON 行号一致）：
   - `delivery/channel/khyquant/services/tokenUsageService.js:273`（require ../../../../runtime/node/backend/src/cli/ccFormat）
   - `delivery/channel/khyquant/middleware/auth.js:3`（整模块 re-export backend auth）
   - `delivery/channel/khyquant/services/gateway/toolCapabilityStore.js:29,30`
   - `delivery/extension/scripts/khy-portable/portable-sync.js:42`
   - `delivery/channel/khyquant/services/multiFreeService.js:73-88`（16 个 env 名，覆盖 11 家供应商；`this.providers`
     在 :90-197 只有 10 个键，HUGGINGFACE_TOKEN 只读不建条目）
   - `apps/khyos-desktop/src/main/keyManager/keyStore.ts:755-760`（BUILTIN_PRESETS 官方端点表）
   - `apps/khyos-desktop/src/main/keyManager/types.ts:127-140`（ENV_PROVIDER_MAP：:127 声明、:128-139 共 12 家、
     :140 右花括号）
   - `delivery/channel/khyquant/frontend/src/components/TradingAgentsBotSimple.vue:2265`（fetch api.openai.com）
   - `delivery/web/provider-hub/src/main/modelCatalog.ts:33-38`（fetch(url) 直连供应商）
   - `delivery/web/ai-frontend/src/views/admin/AIGateway.vue:2093`（UI 预设 baseUrl 字面量，数据非调用）
   - `runtime/node/backend/src/services/gateway/relayPage.js:100`（模板内嵌 `document.getElementById`）与
     `runtime/node/backend/src/services/domain/desktop/browser/session.js:297`（page.evaluate 注入 DOM 代码）
   - `delivery/extension/tools/khy-markdown/muya-embed/ensure-vendor.mjs:41`：目标
     `delivery/scripts/lib/buildDepsCleanup.mjs` 实测 `fs.existsSync` = **false**（`delivery/scripts` 目录不存在），
     仓根 `scripts/lib/buildDepsCleanup.mjs` = true → 方案 P 后的陈旧死路径
   - 桌面端 src 全量扫描（main/preload/renderer/host）：35/4/127/7 个边扩展文件；preload 外部 import 只有
     `electron`；renderer 的 2 处 `'path'` 命中是 UI 字符串（AppHeader.tsx:159,163、ToolExecutionPanel.tsx:90,94），
     非模块 import

**已运行的仓内检查**（facts JSON `commands` 记录，本轮引用其结论，未重跑）：
- `npm run check:core-layers:report` exit 0：扫描 3148 模块；aiGateway.js 冷闭包 122 文件/71731 行、
  toolUseLoopCore.js 71/30629，均在预算内；11 个 V0 视觉入口 5 个超预算（App.tsx 59/37、AppLayout.tsx 33/18、
  Composer.tsx 16/11、Transcript.js 18/17）；2 条 inversion-lazy 倒挂边；10 违规 + 1 视觉回归（报告态不判错）
- `npm run check:cycle-deps` exit 0：巨型 SCC 197 节点；services→cli 候选反向边 4 条；
  单边杠杆 `healEscalationService.js→cli/handlers/publish.js` 移除后 197→119；贪心三刀后剩 116

---

## 2 总量表

### 2.1 消费侧（apps/delivery）→ runtime/node/backend

| 度量 | 值 | 来源 |
|---|---|---|
| 有向边 | **15** | 本会话实测（filter from∈apps/delivery ∧ to 前缀 runtime/node/backend） |
| 加权 require 位点 | **17**（其中 2 条边各 count=2：tokenUsageService→ccFormat、verify-install→installIntegrity） | 同上 |
| 消费侧受影响文件 | **12**（khyquant 8 + extension 4） | 同上 |
| backend 侧受影响模块 | **14**（khyquant 触达 10 + extension 触达 4） | 同上 |

### 2.2 按终端分组（终端 id 取 assets-facts.json `terminals`，其真源为 entries/entries.json）

| 终端 / 根 | →backend 边（加权） | →backend 文件 | →@khy/* 边 | 说明 |
|---|---|---|---|---|
| web-quant 渠道服务端 `delivery/channel/khyquant`（根，frontend 之外） | **11（12）** | 8 | 3→@khy/shared | 唯一直穿 backend src 的渠道 |
| delivery/extension（脚本/桥/工具，非独立端） | **4（5）** | 4 | 0 | 诊断/安装/便携脚本直调 backend |
| web `delivery/web/ai-frontend` | 0 | 0 | 9→@khy/ui-shared（10 加权） | 只依赖共享 UI 包 |
| web-quant 前端 `delivery/channel/khyquant/frontend` | 0 | 0 | 5→@khy/ui-shared（6 加权） | 同上 |
| desktop `apps/khyos-desktop` | 0 | 0 | 0 | 边表内零跨包 import；本会话实测 src 四面子树 main 35 / preload 4 / renderer 127 / host 7 个边扩展文件，跨包出边 0（网关行为走 §4 绕过类，不计入本表） |
| desktop-provider-hub `delivery/web/provider-hub` | 0 | 0 | 0 | 同上 |
| 脚本 `delivery/extension/scripts/khy-desktop-rd/{goose,openflux}` | 0 | 0 | 0 | 已扫（facts 各 1 个边扩展文件），无跨包 import |
| 桥 khy-amoon-bridge / khy-trae-bridge、khy-markdown | 0（另有 1 条 muya-embed→delivery/scripts 的 pen 边，目标不存在） | — | 0 | 桥未直穿 backend；pen 边见 §3 表 D，属陈旧死路径 |
| mobile `delivery/mobile/khy-os-client-app` | **未扫** | 未扫 | 未扫 | 不在 scan.roots |

### 2.3 runtime 内部与共享包

| 关系 | 边（加权） | 受影响文件 | 备注 |
|---|---|---|---|
| `runtime/node/ai-backend` → `runtime/node/backend` | **24** | from 15（13 src + 2 test）、to 14 | 全部相对路径 require，见 §3 表 B |
| `runtime/node/backend` → `runtime/node/ai-backend` | **4**（2 条 path + 2 条 pkg） | 4 | 见 §3 表 C；构成包级双向 → 循环类 |
| → `@khy/shared` | **134（168）**：backend 87（98）+ ai-backend 44（67）+ khyquant 根 3（3） | — | shared 是被依赖最重的包；backend 消费的是 vendor 副本（assets-facts collisions #9） |
| → `@khy/ui-shared` | 14（16）：ai-frontend 9 + khyquant/frontend 5 | — | G3 版本轨道钉 0.1.0 精确匹配 |
| → `@khy/plugin-sdk` | 3：plugin-loader/index.js:62、cli/handlers/plugin-dev.js:234、tests/plugin-sdk.test.js:34 | — | G2 第 3 源 |
| 反向/陈旧边（reverse-path） | 6 | 6 | 4 条为方案 P 前旧路径（runtime/software、runtime/platform、runtime/node/services、runtime/node/cli 均不存在，facts verdicts 标注）；2 条指向 delivery/extension 的测试边。另 1 条 via=pen 边（muya-embed→delivery/scripts/lib/buildDepsCleanup.mjs）目标实测不存在，同类陈旧路径，运行期走 catch 降级空操作 |

---

## 3 逐条清单

风险类别定义：**直连服务**=消费方直接 require backend 的 services/middleware 模块；
**穿透内部**=消费方越过服务面、直取 backend 的 utils/constants/cli 内部；
**绕过网关**=不经 aiGateway 的直连供应商网络调用或密钥处理；
**宿主耦合**=宿主运行时 API（浏览器 DOM / Node 内建）出现在另一侧代码；
**循环**=包级双向依赖或环内反向边。

### 表 A：消费侧 → runtime/node/backend（15 条，全部 `via=path`）

| # | from | to | count | 行 | 风险类别 |
|---|---|---|---|---|---|
| A1 | delivery/channel/khyquant/handlers/data.js | backend/src/services/userProfile | 1 | 10 | 直连服务 |
| A2 | delivery/channel/khyquant/middleware/auth.js | backend/src/middleware/auth | 1 | 3 | 直连服务（整模块 re-export，源码抽查证实） |
| A3 | delivery/channel/khyquant/services/gateway/glmVisionImageDownscale.js | backend/src/services/imageMetadataProbe | 1 | 368 | 直连服务 |
| A4 | delivery/channel/khyquant/services/gateway/toolCapabilityStore.js | backend/src/services/gateway/toolCallingProbe | 1 | 30 | 直连服务 |
| A5 | delivery/extension/scripts/khy-diagnostics/bench/ab-dual-dev.js | backend/src/services/gateway/adapters/claudeAdapter | 1 | 63 | 直连服务 |
| A6 | delivery/extension/scripts/khy-diagnostics/hydration-doctor.js | backend/src/services/domain/backup/restore/hydrationHealth | 1 | 29 | 直连服务 |
| A7 | delivery/extension/scripts/khy-installer/verify-install.js | backend/src/services/domain/backup/restore/installIntegrity | 2 | 26,156 | 直连服务 |
| A8 | delivery/channel/khyquant/services/gateway/glmVisionImageDownscale.js | backend/src/utils/onValueOr | 1 | 67 | 穿透内部 |
| A9 | delivery/channel/khyquant/services/gateway/glmVisionTextBudget.js | backend/src/utils/onValueOr | 1 | 65 | 穿透内部 |
| A10 | delivery/channel/khyquant/services/gateway/modelToolingCapability.js | backend/src/utils/parseListToSet | 1 | 74 | 穿透内部 |
| A11 | delivery/channel/khyquant/services/gateway/modelToolingCapability.js | backend/src/utils/trimLowerNullish | 1 | 57 | 穿透内部 |
| A12 | delivery/channel/khyquant/services/gateway/toolCapabilityStore.js | backend/src/utils/dataHome | 1 | 29 | 穿透内部（数据目录策略真源） |
| A13 | delivery/channel/khyquant/services/multiFreeService.js | backend/src/constants/serviceDefaults | 1 | 503 | 穿透内部（但方向合规：serviceDefaults 是规则 1 的单一真源，允许被 import） |
| A14 | delivery/channel/khyquant/services/tokenUsageService.js | backend/src/cli/ccFormat | 2 | 273,444 | 穿透内部（直取 CLI 内部格式化器；try/catch 回退 legacy，源码抽查证实） |
| A15 | delivery/extension/scripts/khy-portable/portable-sync.js | backend/src/cli/handlers/portable | 1 | 42 | 穿透内部（直调 CLI handler） |

### 表 B：runtime/node/ai-backend → runtime/node/backend（24 条，全部 `via=path`，全部 count=1）

| # | from | to | 行 | 风险类别 |
|---|---|---|---|---|
| B1 | ai-backend/src/routes/aiGatewayAdmin.js | backend/src/utils/maskSecret | 355 | 穿透内部 |
| B2 | ai-backend/src/routes/aiGatewayAdmin.js | backend/src/utils/normalizeCompatibility | 215 | 穿透内部 |
| B3 | ai-backend/src/routes/aiGatewayAdmin.js | backend/src/utils/parseBoolean | 96 | 穿透内部 |
| B4 | ai-backend/src/routes/userGateway.js | backend/src/services/gateway/providerPresets | 33 | 直连服务 |
| B5 | ai-backend/src/services/aiAssetCustomerService.js | backend/src/utils/ensureDirSync | 40 | 穿透内部 |
| B6 | ai-backend/src/services/aiAssetCustomerService.js | backend/src/utils/maskToken | 124 | 穿透内部 |
| B7 | ai-backend/src/services/aiAssetCustomerService.js | backend/src/utils/normalizeAuthToken | 117 | 穿透内部 |
| B8 | ai-backend/src/services/apiKeyPool.js | backend/src/utils/parseRetryAfterCooldown | 362 | 穿透内部 |
| B9 | ai-backend/src/services/cozeImportService.js | backend/src/utils/httpError | 33 | 穿透内部 |
| B10 | ai-backend/src/services/customerUsageService.js | backend/src/utils/ensureDirSync | 46 | 穿透内部 |
| B11 | ai-backend/src/services/pricingService.js | backend/src/utils/ensureDirSync | 47 | 穿透内部 |
| B12 | ai-backend/src/services/requestLogService.js | backend/src/utils/ensureDirSync | 27 | 穿透内部 |
| B13 | ai-backend/src/services/gateway/userModelCatalogGraph.js | backend/src/services/gateway/localOllamaProbe | 46 | 直连服务 |
| B14 | ai-backend/src/services/gateway/userModelCatalogGraph.js | backend/src/services/gateway/modelCapability | 43 | 直连服务 |
| B15 | ai-backend/src/services/gateway/userModelCatalogGraph.js | backend/src/services/gateway/modelCatalogGraph | 45 | 直连服务 |
| B16 | ai-backend/src/services/gateway/userModelCatalogGraph.js | backend/src/services/modelTier | 44 | 直连服务 |
| B17 | ai-backend/src/services/gateway/userModelDetectionService.js | backend/src/services/gateway/modelCapability | 34 | 直连服务 |
| B18 | ai-backend/src/services/gateway/userModelDetectionService.js | backend/src/services/gateway/upstreamModelProbe | 33 | 直连服务 |
| B19 | ai-backend/src/services/userGatewayConfigService.js | backend/src/services/gateway/modelCapability | 711 | 直连服务 |
| B20 | ai-backend/src/services/workflowGenerateService.js | backend/src/services/gateway/providerPresets | 58 | 直连服务 |
| B21 | ai-backend/src/services/workflowService.js | backend/src/utils/httpError | 42 | 穿透内部 |
| B22 | ai-backend/test/userModelCatalogGraph.test.js | backend/src/services/gateway/localOllamaProbe | 36 | 直连服务（测试） |
| B23 | ai-backend/test/userModelCatalogGraph.test.js | backend/src/services/gateway/modelCatalogGraph | 37 | 直连服务（测试） |
| B24 | ai-backend/test/userModelDetectionService.test.js | backend/src/services/gateway/upstreamModelProbe | 28 | 直连服务（测试） |

### 表 C：runtime/node/backend → runtime/node/ai-backend（4 条，构成包级循环的另一臂）

| # | from | to | count | 行 | via | 风险类别 | 备注 |
|---|---|---|---|---|---|---|---|
| C1 | backend/src/bootstrap/aiBackendModuleResolve.js | ai-backend/src/... | 1 | 10 | path | 循环 | facts verdicts 判为注释假边（L10 是文档注释，无静态 import）；但该文件本身是跨包动态解析器，动态耦合属实 |
| C2 | backend/tests/aiBackendDataHomeConvergence.test.js | ai-backend/src/utils/dataHome | 1 | 27 | path | 循环（测试） | |
| C3 | backend/src/routes/guiEval.js | khy-ai-backend（包名） | 1 | 8 | pkg | 循环 | |
| C4 | backend/src/services/aiManagementServer.js | khy-ai-backend（包名） | 10 | 243,272,289,306,325,345,385,428,445,463 | pkg | 循环 | 单文件 10 处 require，backend 反向依赖 ai-backend 的主通道 |

### 表 D：其余跨边界边（汇总）

| 关系 | 条数 | 风险类别 | 备注 |
|---|---|---|---|
| delivery/extension/tools/khy-markdown/muya-embed/ensure-vendor.mjs → delivery/scripts/lib/buildDepsCleanup.mjs | 1（L41 dynamic-import，via=pen） | **陈旧死路径**（方案 P 前 `extensions/…` 深度下的 `../../../../scripts` 写法，P 后多一层 delivery；`fs.existsSync('delivery/scripts/lib/buildDepsCleanup.mjs')`=false、`delivery/scripts` 目录不存在、仓根 `scripts/lib/buildDepsCleanup.mjs`=true；运行期走 :42-44 catch 返回 null 降级空操作） | 不计入活的跨层耦合；全表唯一 pen 边 |
| backend/tests/portableUpdateAdapter.test.js → delivery/extension/scripts/khy-portable/artifact-manifest；backend/tests/videoIngestionFuzz.test.js → delivery/extension/scripts/khy-diagnostics/fuzzVideoCorpus.js | 2 | 循环（测试→L5） | reverse-path 记录 |
| → @khy/shared 134 条 / @khy/ui-shared 14 条 / @khy/plugin-sdk 3 条 | 151 | （共享包依赖，方向合规） | 走包名而非路径，不受 L3→L2 禁令约束 |

---

## 4 越界清单

### 4.1 gatewayBypasses（绕过网关）

facts JSON `gatewayBypasses` 共 **45 个文件条目**（带行级命中明细）。verdicts 分级如下：

**实打实的供应商直连/密钥处理（12 条，全部本会话抽查或行号核对）**：

| # | 路径 | 证据 |
|---|---|---|
| G1 | delivery/channel/khyquant/services/multiFreeService.js | L73-88 读 16 个 env 名、覆盖 11 家供应商（源码抽查；同文件 this.providers 仅 10 个键，HUGGINGFACE_TOKEN 只读不建条目）；L436 generativelanguage、L468 api.groq、L494 openrouter、L523 api.openai、L844 api.anthropic、L1161 open.bigmodel、L1313 dashscope 直连 fetch —— delivery 侧自建多供应商网关 |
| G2 | delivery/channel/khyquant/frontend/src/components/TradingAgentsBotSimple.vue:2265 | 浏览器端直接 `fetch('https://api.openai.com/v1/models')`（源码抽查） |
| G3 | delivery/web/provider-hub/src/main/modelCatalog.ts:35,145 | Electron 主进程 `fetch(url)` 直连供应商 baseUrl（源码抽查 :33-38） |
| G4 | apps/khyos-desktop/src/main/keyManager/keyStore.ts:756-760 | 内置 api.openai.com/api.anthropic.com/generativelanguage/api.deepseek/openrouter 官方端点预设表（源码抽查）；L723 直连时手工置 x-api-key |
| G5 | apps/khyos-desktop/src/main/keyManager/types.ts:127-140 | ENV_PROVIDER_MAP（:127 声明、:128-139 共 **12 家**：openai/anthropic/deepseek/agnes/sensenova/qwen/glm/doubao/wenxin/trae/openrouter/relay、:140 右花括号）的 keyEnv/endpointEnv 映射表（源码抽查） |
| G6 | apps/khyos-desktop/src/main/keyManager/agentWriters.ts:258,280,282 | 向子 agent 注入 ANTHROPIC_API_KEY；按协议写 @ai-sdk/anthropic、@ai-sdk/openai-compatible 包名 |
| G7 | apps/khyos-desktop/src/main/keyManager/health.ts:69 | 对端点直发 x-api-key 探活 |
| G8 | delivery/channel/khyquant/services/zhipuRequestShape.js:113 | 内置 open.bigmodel.cn 官方端点判定 |
| G9 | delivery/channel/khyquant/tools/news.js:120 | `process.env.FINLIGHT_API_KEY` |
| G10 | delivery/channel/khyquant/services/jsDataSources.js:328 | `process.env.ALPHA_VANTAGE_API_KEY` |
| G11 | delivery/extension/scripts/khy-diagnostics/model-type-providers.js:140-141 | 探测 OPENAI/ANTHROPIC_API_KEY 环境变量 |
| G12 | delivery/extension/tools/khy-markdown/khyos-md-bridge.js:492-493 | 读 config.ai_api_key/process.env.OPENAI_API_KEY 并默认 https://api.openai.com/v1 |

**端点字面量属 UI 数据非调用（2 条）**：
- delivery/web/ai-frontend/src/views/admin/AIGateway.vue:2093-2126（源码抽查 :2090-2097 确为 provider 预设数据）
- delivery/web/ai-frontend/src/views/admin/ChannelApiEditor.vue:40,61（placeholder 文本含 api.anthropic.com / ANTHROPIC_API_KEY）

**误报（31 条 = 45−12−2）**：verdicts falsePositiveEnums 收录——host/index.ts、keyManager/ipc.ts、
KeyManagerPage.tsx、gateway/*、AccountPool.vue、AIAssetsCustomers.vue、BridgeChannels.vue、Dashboard.vue、
models/UserGatewayConfig.js、models/UserProvider.js、provider-hub src/main/*.ts、各 tests、
provider-hub/.build-tmp 构建产物；命中全是 protocol/apiFormat 字符串枚举、mongoose defaultValue、
测试 fixture 或构建产物。另 verdicts 实测：**apps/delivery 无一处声明 openai/anthropic/@ai-sdk 依赖，
也无一处 import 这些包**。

### 4.2 hostLeaksBackend（backend 内的宿主 API，226 命中 / 45 文件）

**实打实的 2 条**：
- `runtime/node/backend/src/services/gateway/relayPage.js:100-225` —— 网关直出的 relay HTML 模板内嵌
  浏览器 JS（`document.getElementById` 等，源码抽查 :100）；宿主 API 以字符串形式出现在 core 源码
- `runtime/node/backend/src/services/domain/desktop/browser/session.js:297-836` —— page.evaluate 注入的
  浏览器端代码块（document/window/localStorage），执行于被控浏览器而非 Node（源码抽查 :297）

**字符串非 import（1 条）**：runtime/node/backend/src/services/gateway/adapters/traeOfficialArtifacts.js:787,858
—— electron 仅作为字符串值「electron-safeStorage」（解析 Trae state.vscdb），无 electron require。

**其余 223 命中为注释与字段名**（verdicts falsePositiveCounts）：window=上下文窗口/滑动窗口/空闲窗口
（sessionWatchdog x15、maxTokensPolicy x11、aiGatewayRoutingMethods x11 等）；document=Anthropic document
内容块或注释；localStorage=sessionGroupService.js:372,418 注释指 renderer 侧迁移。

### 4.3 hostLeaksDeliveryWeb（前端代码 require Node 内建，135 命中 / 48 文件）

**前端侧实打实的 3 条**：
- `delivery/web/ai-frontend/src/services/crossPlatform/shared/sessionSyncService.cjs:21-24` —— 顶层
  require fs/path/events/crypto（源码抽查）；消费方仅同目录 crossPlatformHub.cjs 与 protocol.js（facts 实测），无浏览器侧静态引用
- `delivery/web/ai-frontend/src/services/crossPlatform/shared/crossPlatformHub.cjs` —— require crypto
- `delivery/web/ai-frontend/public/vendor/khyos-muya.js` —— vendored 打包产物内 require("util") 等 3 处

**合法 Node 侧（其余命中）**：vite/electron 配置、backendDiscovery.mjs、frontendRuntime.mjs、scripts/*.mjs、
*.wiring.test.js / *.contract.test.js / test/*；provider-hub src/main/* 是 Electron 主进程（合法）；
provider-hub/.build-tmp/* 构建产物（facts 标注：本次未排除）。

**桌面端已扫，无 Node 内建泄漏**：本会话对 `apps/khyos-desktop/src` 四面子树实测（main 35 / preload 4 /
renderer 127 / host 7 个边扩展文件）——preload 的外部 import 只有 `electron`（agentbus.ts:5、amooSecretary.ts:5、
editor.ts:8、index.ts:2）；renderer 的 2 处 `'path'` 命中是 UI 字符串（AppHeader.tsx:159,163 的复制目标标识、
ToolExecutionPanel.tsx:90,94 的工具入参字段名），不是模块 import。故 §2.2 的 desktop 0 边是「已扫且为 0」。

---

## 5 与方案 A1 的对照

方案 A1 写的是 **services/backend**；本仓已执行方案 P，真实落点是 **runtime/node/backend**
（layout-facts layers：`runtime/node` = L2 全部业务逻辑；LAYERS 名册真源 scripts/ci/check-repo-layout.js:111-121）。
清单换算规则与证据：

| 方案 A1 写法 | 本仓真实落点 | 换算依据 |
|---|---|---|
| services/backend | **runtime/node/backend** | layout-facts verdicts「services/」条：方案 P 旧名，DOMAIN-DEPS D1.roots 已改指 runtime/node/backend/{bin,src/cli,src/routes,src/services} |
| services/ai-backend（若有） | runtime/node/ai-backend | 同上；G2 版本轨道第 1 源 |
| packages/shared 等 | runtime/substrate/platform/packages/{shared,ui-shared,plugin-sdk} | layout-facts verdicts「packages/*」三条：duplicate；顶层 packages/ 从未存在 |
| apps/{cli,ai-frontend,electron,flutter-android,provider-hub} | apps/khyos-desktop（桌面）/ delivery/web/ai-frontend（web）/ **electron 已退役**（Q10，2026-10-02，verdicts apps/electron=illegal）/ delivery/mobile/khy-os-client-app（mobile）/ delivery/web/provider-hub（desktop-provider-hub） | layout-facts verdicts apps/* 五条；assets-facts collisions #4（apps/ 实测只有 khyos-desktop） |
| 各端登记真源 | entries/entries.json（assets-facts collisions #1：端矩阵真源；再引入 terminals 清单即第二真源） | layout-facts verdicts apps/*/khy.terminal.json=duplicate |

对本清单的影响：**表 A/B/C 的 from/to 全部已是真实落点路径，无需再换算**；方案 A1 若引用
`services/backend/src/utils/X`，只需把前缀替换为 `runtime/node/backend/src/utils/X` 即可命中本清单行。
两个换算注意点：
1. 「backend」在版本轨道上是 G1 第 3 源、khyquant 打包载体在 delivery/channel——拆分若动包名/目录，
   会同时牵动 check-version-sync.js 的 specs 三组 10 源（assets-facts collisions #3）。
2. 依赖方向真源：layout-facts verdicts「apps/cli」条引 LAY-005 §2 边表「L3→L2 只能走 HTTP/REST、
   不得跨目录 import」——表 A 的 15 条与表 B 的 24 条 path 边**正是被该规则禁止的形态**；
   facts verdicts edges.noConsumerImportsCoreByPackageName 实测：apps/delivery 无一处按包名
   import khy-os-backend/khy-ai-backend（0 处），消费→core 全部走相对路径穿透。

---

## 6 拆分建议（三档）

### 6.1 可先搬（目标无 backend 内部耦合，或已是纯叶子函数；搬动只改 import 前缀）

首批文件（搬入共享包，或收敛到 `@khy/shared` / 新 utils 包；backend 已有 vendor/shared 拷贝机制
`runtime/node/backend/scripts/prepack.js:7/:30/:59`，见 assets-facts collisions #9）：
- backend/src/utils/{onValueOr,parseListToSet,trimLowerNullish,ensureDirSync,maskSecret,maskToken,
  normalizeAuthToken,httpError,parseBoolean,normalizeCompatibility,parseRetryAfterCooldown} ——
  表 A8-A11 + 表 B1-B3、B5-B12、B21 共 **16 条边**的目标（4 + 3 + 8 + 1）；全为纯函数/IO 叶子
- backend/src/cli/ccFormat —— 表 A14 目标，纯格式化器（tokenUsageService 已带 try/catch 回退，迁移后
  回退路径仍安全）
- backend/src/utils/dataHome —— 表 A12/B2 相关目标；**注意**它是数据目录策略真源（规则 LAYOUT-007），
  搬动须同步 DATA-LOCATIONS.json 指针，故列为本档但单独走一次评审
- delivery/extension/scripts/{khy-diagnostics,khy-installer} 的 4 条直连边（A5/A6/A7）—— 改走 CLI 正门
  （`khy` 子命令或 HTTP），是删边而非搬码，最便宜

### 6.2 需先加契约（有状态/有协议语义，先定义稳定接口再动）

- backend/src/middleware/auth（A2，khyquant 整模块 re-export）—— 契约 = JWT + session revocation 语义
- backend/src/services/gateway/{toolCallingProbe,modelCapability,modelCatalogGraph,localOllamaProbe,
  upstreamModelProbe} 与 services/modelTier、services/gateway/providerPresets —— 表 A4 与表 B4/B13-B20
  共 **10 条边**（A4=1 + B4=1 + B13-B20=8）；ai-backend→backend 网关能力探测族，需先落 HTTP/REST 或独立包接口（LAY-005 §2 要求 L3→L2
  只走 HTTP/REST，runtime 内包间同理宜用包名依赖）
- backend/src/services/imageMetadataProbe（A3）、services/userProfile（A1）、domain/backup/restore/
  {hydrationHealth,installIntegrity}（A6/A7）—— 服务面接口化后 khyquant/extension 改走正门
- delivery/channel/khyquant/services/multiFreeService.js —— 与 backend aiGateway 的双网关并存问题
  （见 §4.1 G1）；要么收编走 aiGateway（需网关 API 契约），要么作为独立项目 khyquant 的内部实现
  显式登记（PROCESS-010 口径：khyquant 独立项目，另案申报）

### 6.3 必须留适配层（宿主边界/刻意豁免，机械迁移会破坏行为）

- apps/khyos-desktop/src/main/keyManager/keyStore.ts:755-760 —— 注释明言 fallback 故意只钉公共云端点、
  防止悄悄 fork backend 默认值（AGENTS 规则 1 语境）；保留为桌面端兜底适配层
- apps/khyos-desktop/src/main/keyManager/{types.ts,agentWriters.ts,health.ts} —— 子 agent 授权面的
  env 注入协议，属桌面宿主职责
- runtime/node/backend/src/services/gateway/relayPage.js —— 模板内嵌浏览器 JS 是下发给浏览器的产物，
  不是 Node 模块边界问题；拆 core 时应整体作为模板资产搬运
- runtime/node/backend/src/services/domain/desktop/browser/session.js —— page.evaluate 的浏览器控制
  边界，宿主 API 内在
- delivery/web/ai-frontend/src/services/crossPlatform/** —— Node 内建依赖的 .cjs 只被同目录 Node 侧
  消费（facts 实测），保持 Node-only 模块定位即可，无须迁浏览器
- delivery/channel/khyquant/frontend/src/components/TradingAgentsBotSimple.vue:2265 —— 浏览器直连
  OpenAI 是越界（应走后端），但修法是改调用走后端正门，不是搬文件

**环的治理顺序**（配合 §1 已跑的 check:cycle-deps 读数）：先移除单边杠杆
`healEscalationService.js→cli/handlers/publish.js`（SCC 197→119），再做表 C 的 backend→ai-backend
反向 4 条（尤其 aiManagementServer.js 的 10 处 require），最后收敛 ai-backend→backend 的 utils 面
（表 B 的 12 条穿透，6.1 档可消化 12 条）。

---

## 7 未核实项

1. **扫描器本体未重跑**：本轮全部计数取自 coupling-facts.json（generatedAt 2026-11-16T04:24:39.791Z），
   未重放其扫描命令；做了十余处源码/文件系统抽查（§1 列表，含复核后补测的 3 项），计数与行号均与 facts 一致（分叉见 §7.9）。
2. **check:layout 未运行**：layout-facts 记录该 tool call 被用户拒绝；其 findings/counts 未经本会话验证，
   本文件不引用任何来自该运行的读数（「LAYERS 9 键 + CROSSCUTTING 6 键 = 15 键逐个 stat 无死键」为
   layout-facts 实测结论，LAYERS 9 键见 scripts/ci/check-repo-layout.js:111-121，CROSSCUTTING 6 键见
   :123-165；非本轮复测）。
3. **vendor/shared 符号链接态未实测**：assets-facts collisions #9 的 link-shared-dev.js 机制描述未在
   本会话实跑验证（pnpm/corepack 不在本机 PATH，assets-facts workspace 节已记录）。
4. **hostLeaks 的 223+132 条误报命中未逐条复核**：采纳 facts verdicts 的分类结论（注释/字段名/构建产物），
   仅抽核 2 条 real 项（relayPage.js:100、session.js:297）。
5. **delivery/mobile（Flutter/Dart）不在 scan.roots**：§2.2 的 mobile 读数 0 是「未扫」而非「无耦合」。
6. **TradingAgentsBotSimple.vue 的 fetch 上下文只读了 2258-2269 行**：是否存在可配置代理/开关未核实。
7. **C1（aiBackendModuleResolve.js）的动态耦合形态**：facts verdicts 判 L10 为注释假边、无静态 import，
   但该文件运行期跨包解析的实际路径未逐行核实。
8. **方案 A1 原文未在本会话读取**：§5 的「方案写法」按任务给的已知偏差清单（services→runtime/node 等）
   与 layout-facts/assets-facts 的 verdicts 记录换算；A1 原文若与本偏差清单冲突，以偏差清单 + 守卫名册为准。
9. **本轮补测项**（复核意见后新增，均为本会话实跑）：`fs.existsSync` 双路径判定（delivery/scripts=**false**、
   仓根 scripts/lib=**true**、delivery/scripts 目录=false）；`types.ts:127-140` 与
   `multiFreeService.js:71-197` 逐行读取；桌面 src 四面子树文件计数与 import 命中扫描（35/4/127/7）。
   上述 3 项已写入 §1/§2.2/§3 表 D/§4.1/§4.3。

---

*计数复核命令：`node -e` 读取三份 facts JSON 分组统计（edges 201 条/248 加权；消费→backend 15 条/17 加权/
12 文件/14 模块；AIB→B 24 条/15 文件/14 模块；B→AIB 4 条；@khy/shared 134 条/168 加权；gatewayBypasses 45；
hostLeaksBackend 226；hostLeaksDeliveryWeb 135）。本文件与 facts JSON 不一致处以 facts JSON 为准，并注明。*
