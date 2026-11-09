# [DESIGN-ARCH-187] 数据（内容）与项目（代码/逻辑）彻底解耦重构方案

> 类型：设计方案（DESIGN）。**本文是方案，不是已执行的改动。**
> 截至定稿日，仓库中**没有任何一个文件因本方案被修改**（未 Edit / 未 Write / 未 git 写操作）。
> 文中所有 `file:line` 证据均来自只读 Grep / Glob / Read / 只读 Bash 实测；未能实测到行号的条目已降级为符号名或整文件描述。

---

## 0. 覆盖边界与阅读须知

### 0.1 深审的四域

| 代号 | 域 | 物理范围 | 实测规模 | 耦合点数 |
|---|---|---|---|---|
| D1-域 | 后端服务层 `services/` | `runtime/node/backend/src/services/**`（含 `domain/` 26 个子域） | 2122 个 `.js` / 约 23.6 万行 | **33** |
| E-域 | 交互与边缘层 | `runtime/node/backend/src/{cli,tools,utils,skills,agents,routes,controllers,adapters,middleware,observability,coordinator,assistant,buddy,tasks,jobs,bridge,vim,memdir,webRemoteControl,models}` | `cli/` 含中文行 4630、`utils/` 873、`tools/` 405 | **44** |
| C-域 | 数据与配置层 | `runtime/node/backend/src/{constants,config,data,blueprints,contracts,templates,i18n,plugin-loader}/**` + `runtime/node/backend/config/**` | `constants/` 32 文件 / 10392 行 | **30** |
| F-域 | 前端与交付层 | `delivery/**`（`channel/khyquant`、`web/ai-frontend`、`web/provider-hub`、`extension`、`mobile`）+ `apps/khyos-desktop` | 四进程 Electron + Vue3 + Flutter + Python/Flask | **32** |
| | **合计** | | | **139** |

### 0.2 未深审的范围与原因

以下目录**不在本次深审范围**，文中不对其下结论；凡方案触及它们的地方均已显式标注「需单独取证」：

| 范围 | 原因 |
|---|---|
| `docs/`（378 份设计文档 + 189 份规范） | 体量超出单次审计；且属 D5 工程档案域，不是耦合发生地。仅 `docs/10_规范/registry/DOMAIN-DEPS.json`、`repo-layout-baseline.json`、`RULES-REGISTRY.json`、`DATA-LOCATIONS.json`、`COPYRIGHT.json`、`FEATURE-OWNERSHIP.json` 作为**判据真源**被读取。 |
| `scripts/` | 工程脚本域（D5）。仅 `scripts/ci/*.js` 守卫实现被读取以校准机械判据。 |
| `kernel/`（`runtime/boot/kernel`）、`platform/`（`runtime/substrate/platform`） | D1/D3 边缘，本次未逐文件扫；`platform` 只在 R3 版本轨道语境下被引用。 |
| `packaging/`（`works/ship`） | 打包面。仅确认新增数据文件不进 R3 九源。 |
| `works/`（除 `works/ship`） | 工程档案与部署态。 |
| `evidence/` | 软著申报材料。只在 B6 语境下被引用（截图重拍动作项）。 |
| `tests/` | 测试套件。文中所有验证命令指向既有测试，但未逐套审计其内容。 |

**后果（诚实标注）**：`delivery/extension` 与 `delivery/mobile` 的测绘深度弱于其他三域（F-域对 `extension` 只抽查了 `repair-portable.js`，`mobile` 只抽查了 `built_in_keys.dart` / `builtin_tools.dart` / `retry_engine.dart` / `dns_resolver.dart`）。若第 5 章的端口字面量扫描规则覆盖到它们，可能出现**计划外工作量**。同理，`src/tools` 下 229 个工具目录只做了 8 个抽样，`schema-in-code` 与 `inline-i18n` 的**真实总量需一次全量扫描才能定量**——本文给出的「49 个文件含内联 JSON Schema」是 Grep 实测数，但「229 个工具目录的 description 文案总量」是估计。

### 0.3 三透镜复核结论与本文的回应方式

三透镜（行为等价性 / 依赖方向与解耦彻底性 / 仓库红线与门禁合规）对四域设计合成的 verdict 均为 **needs-rework**。本文不做「照单采纳」也不做「静默丢弃」，而是：

1. **第 2.0 节「前置裁定」**：把三透镜的 blocking / high finding 逐条转成设计决策（采纳并改设计，或说明为何不采纳及代价）。
2. **附录 A**：finding → 回应 的逐条对照表（含不采纳的理由）。
3. **第 5.2 节**：把「门禁覆盖缺口」类 finding 转成每批必跑命令。

四域设计中最严重的一条已由透镜指出并被本文采纳：**四个域对同一个 3251 行文件 `src/constants/prompts.js` 给出三份互斥终态，且各自新建一套自称「唯一入口」的抽象层**（`src/services/di/` + `src/utils/dataCard/` / `src/repos/` / `src/dataAccess/`）。本文的回应是**收敛为一个抽象层、一个 prompts.js 终态**（见 2.0 裁定 A/B）。

---

## 1. 现状分析：数据与逻辑耦合的具体位置

### 1.0 耦合的总量与集中点

**总量**：139 个已定位耦合点。按类别分布（粗分）：

| 类别 | 数量级 | 集中点 |
|---|---|---|
| 硬编码业务数据（模型目录 / provider 表 / 渠道 / 预设 / 策略源码） | ~25 | `services/models/index.js`、`cli/handlers/backtest.js`、`cli/handlers/gateway.js`、`multiFreeService.js`、`jsDataSources.js`、`providerPresets.js`、`freeModelChannels.js`、`kiroAdapter.js` |
| 硬编码配置 / 阈值 / 端口 / URL | ~25 | `serviceDefaults.js`（133 处 env）、`proxyServer.js`（5 处 9100）、`aiManagementServer.js`（13 组）、`toolUseLoopCore.js`（约 60 处 env）、`aiGatewayGenerateMethod.js` |
| 内联提示词模板 / 用户可见文案 | ~28 | `constants/prompts.js`（3251 行）、`aiChatCore.js`（620 行含中文）、`aiGatewayGenerateHelpers.js`、`toolCallNudges.js`、`planModeService.js`、`agents/built-in/*.js`（2323 行）、`tui/ink-components/App.js`、`mobilePage.js`×2、`builtin_tools.dart` |
| 数据访问写在逻辑里（裸 fs / 自建 DDL+SQL / 自管缓存） | ~15 | `accountPool.js`、`localBrainService.js`、`webSearchService.js` + `webToolsService.js`、`routingMode.js`、`modelPricing.js`、`projectTemplateService.js`、`catalog.js` |
| 路径字面量（`os.homedir()` 拼 `.khyquant` / `.khy`，`__dirname` 爬升） | ~8（但每项内部是几十上百处） | `src/services/domain/`（实测 `os.homedir()` 105 处 / 39 文件）、`installationCandidates.js`、`agentWriters.ts` |
| 数据文件反向携带逻辑 / 依赖倒流 | ~8 | `src/data/bugCases.js`、`constants/prompts.js:18`、`constants/commandSchema.js:2194,2229`、`built_in_keys.dart` |
| schema / 契约内联在代码 | ~8 | 49 个含内联 JSON Schema 的文件、`plugin-loader/index.js:60-76`、`webRemoteControl/protocol.js`、`builtin_tools.dart` |
| 数据复制（同一份数据多份副本） | ~10 | `OFF_VALUES` 159 个文件、`AGENT_COLORS` 2 处、`search_engines.json` 读取 2 份、`mobilePage` 2 份、18 特征 schema 3 份、i18n 2 份 345KB、`modelPricing`/`routingMode` homedir 兜底 |

**集中点（按「改一处会连带多少处漂移」排序）**：

1. **`runtime/node/backend/src/constants/prompts.js`（3251 行）**——本仓最大的单一致耦合集中点。它同时是：40+ 段提示词正文（数据）、17 条中英文意图正则 + 任务规模表 + 规则门（业务规则）、37 处 `process.env` 直读（配置解析）、29 处 `require('../services/')` 横跨 20 个模块（**依赖倒流，D3→D1**）。它已越过 R4 的 2500 行门，且是 B6 软著登记材料。
2. **`runtime/node/backend/src/services/domain/`**——`os.homedir()` 105 处 / 39 文件，而同目录另有 302 处已正确使用 `getDataHome` 系。两种写法并存是「同进程在不同盘符/cwd 下读写不同数据家」的根因（CLAUDE.md B8）。
3. **`runtime/node/backend/src/services/accountPool.js`（1476 行）**——4 张表 DDL + `ensureColumn` 的 ALTER + 约 25 条 CRUD SQL + WHERE 条件模板拼接 + 业务调度五层同文件。绕过本仓唯一 ORM 层（`src/models/` + `@khy/shared/models`，22 个 Sequelize model）自建裸 SQL。
4. **`src/i18n/`（框架完备、5 locales、zh/en 各 131 leaf key）零内部消费**——`src/` 下唯一引用是 `src/index.js:24` 的 re-export。这是「文案层根本没有接口」的结构性事实：services/ 约 100+ 处中文字面量全部不过 `t()`。
5. **`cli/` 4630 行中文 + `tools/` 229 目录**——产品契约「用户可见字符串用中文」直接诱导把文案写进渲染分支。

### 1.1 后端服务层 `services/`（33 个耦合点）

| # | 路径 | 符号 | 耦合类别 | 严重度 | 说明 |
|---|---|---|---|---|---|
| 1 | `src/services/models/index.js:98-210` | `initDefaults` / `registerModel` | hardcoded-business-data | **high** | 写死 10+ 条模型记录，内联 `contextWindow`/`maxTokens`/`costPerToken`/`capabilities`。**实测修正**：`:36` `contextWindow: pinModelContextWindow(id, config.contextWindow \|\| 4096)` 恒定覆写，10 条中 4 条有效值被改（claude-sonnet-4-5 200000→1000000、claude-opus-4-0 200000→1000000、gemini-2.0-flash 1000000→1048576、gemini-1.5-pro 1000000→1048576）。`constants/modelContextWindows.js:317-329` 注释明写「真源登记了该型号 → 返回真源值」。故「内联值是缺失兜底」的说法**只对 6 条成立**。 |
| 2 | `src/services/gateway/adapters/_endpointResolver.js:20-22` | `resolveAdapterEndpoint` | hardcoded-config | **high** | claude/openai/deepseek 三个 URL 字面量。文件头自称「零硬编码」而 `serviceDefaults.js` 中 `CLAUDE_API_ENDPOINT` / `OPENAI_API_ENDPOINT` / `DEEPSEEK_API_ENDPOINT` **均未定义**，故 `defaults.XXX` 恒 undefined，永远走字面量兜底。**实测确认**（`:91 OLLAMA_HOST`、`:155 DEEPSEEK_BASE_URL`、`:158 OLLAMA_OPENAI_BASE_URL` 存在，其余四个 key 缺席）。 |
| 3 | `src/services/gateway/adapters/claudeAdapter.js:198,491-551` | `resolveBaseUrl` 兜底 / `KNOWN_MODELS` | hardcoded-config | medium | base 回落 `'https://api.anthropic.com'`；KNOWN_MODELS 内联型号清单（窗口值已抽到 constants，目录与 tier/category 仍是代码表）。 |
| 4 | `src/services/gateway/proxyServer.js:380,408,3040,3056,3058` | `PROXY_PORT` 默认值 | hardcoded-config | medium | 端口 9100 在 5 处重复；`serviceDefaults.js` 无该常量。 |
| 5 | `src/services/aiManagementServer.js:21-85,544,1469-1470,1851` | 13 组运维配置 | hardcoded-config | medium | webhook 重试、会话空闲、鉴权超时、GC、body 上限、自动导入、provider 白名单、熔断阶梯、`DEFAULT_PLUGIN_TEMPLATE`、`STATIC_CONTENT_TYPES`、限流、缓存 TTL。**环境配置与业务配置混在一起的原型**；纯数据（插件模板源码、MIME 表）占着 3780 行服务文件头部。 |
| 6 | `src/services/aiManagementServer.js:3270,3705` | `listenPort` / `getPort` | hardcoded-config | medium | `parseInt(process.env.AI_MGMT_PORT,10) \|\| 9090` 两处重复，形成第 4 个 9090 字面量（`serviceDefaults.js` 已有 `AI_BACKEND_DEFAULT_PORT`，且 ai-frontend `backendDiscovery.mjs` 镜像该值要求 lock-step）。 |
| 7 | `src/services/gateway/aiGatewayGenerateMethod.js:2203,2212` | 重试总预算 / 延迟预算 | hardcoded-threshold | medium | attempts 12/3/6、delay 45000/5000/15000 三档内联。与 `constants/retryBudget.js` 的 `MAX_RETRY_ROUNDS=10` 是两套并行口径。 |
| 8 | `src/services/tool/toolUseLoopCore.js`（约 60 处） | `process.env.KHY_* \|\| <默认>` | env-read-inline | medium | `URGENT_STEER_MAX`、`EMPTY_TEXT_TOOL_LOOP_MAX`、`VERIFY_MAX_ROUNDS`、`CLOSURE_GUARD_MAX`、`SELF_KICKOFF_MAX`、`TRUNCATION_MIN_CHARS` 等。**求值时机陷阱**：提为模块级常量会让「require 后改 env」的测试静默失效。 |
| 9 | `src/services/contextCompressor.js:27-50,1370,1375` | 约 15 个压缩阈值 | hardcoded-threshold | medium | 0.7 触发比、0.3 保留比、5000 字符工具结果上限、192000 周期阈值、4000 carry-forward 预算等。 |
| 10 | `src/services/accountPool.js:142-253,227-967` | `ensurePoolSchema` / 全部 CRUD | data-access-in-logic | **high** | 4 张表 DDL + `ensureColumn` ALTER + 约 25 条 SQL，WHERE 在模板字符串动态拼。绕过 `src/models/` ORM 层。 |
| 11 | `src/services/domain/account/accountPool/candidateDetect.js:184` | `NIRVANA_PRESET_LOGIN_EMAIL` | hardcoded-business-data | **high** | `String(process.env.NIRVANA_DEFAULT_LOGIN_EMAIL \|\| '2578974124@qq.com').trim()` —— 真实私人 QQ 邮箱作为语义默认值。子域 README 已登记为高危 KNOWN-DEFECT 第 1 条（实测传播面：无该 env 时 `poolImporter` 给每条导入凭据写 email 与 label）。属 PII 入源码，与 R2 精神相邻。 |
| 12 | `src/services/domain/account/accountPool/credentialHelpers.js:16,55` | `PROVIDER_ALIASES` / `normalizePoolType` | hardcoded-business-data | **high** | 别名映射表硬编码；`:55` `PROVIDER_ALIASES[raw] \|\| raw` 无 own-property 守卫 ⇒ 原型键一族（`poolType='constructor'` 返回 Object 构造函数本体）并作为 SQL 参数下传。README 登记为 KNOWN-DEFECT 第 2 条。 |
| 13 | `src/services/gateway/adapters/kiroAdapter.js:83,95,248-258,285` | `KIRO_REGION_ENDPOINTS` / `KIRO_BASELINE_MODELS` / `SOCIAL_REFRESH_URL` | hardcoded-business-data | medium | 10 region → AWS CodeWhisperer 端点；`SOCIAL_REFRESH_URL` 连 env 覆盖口都没有（同文件 `KIRO_LOGIN_URL` 已有先例，模式不统一）。 |
| 14 | `src/services/gateway/providerPresets.js:100-330` | `PROVIDER_PRESETS` | hardcoded-business-data | medium | 本仓最好的数据外置范式之一（无密钥、env 按 id 合并覆盖、URL 从 serviceDefaults 导入），但 300 行纯数据表住在 `services/gateway/` 逻辑层；前端/后端/registrar 三处消费却要 require 逻辑目录下的模块。 |
| 15 | `src/services/freeModelChannels.js:27-255` | `FREE_MODEL_CHANNELS` | hardcoded-business-data | low | **实测修正**：与 `src/services/gateway/zhipuFreeModels.js`（**注意路径在 gateway/ 下，不在 services/ 根**）的 7 模型清单实测**逐字节相同、顺序一致**（`[glm-4.7-flash, glm-4.6v-flash, glm-4.1v-thinking-flash, glm-4-flash-250414, glm-4v-flash, cogview-3-flash, cogvideox-flash]`）。`:20` 注释已裁定权威源是 `zhipuFreeModels`。故不存在「已漂移、需人裁定」的问题。 |
| 16 | `src/services/zenRetiredModels.js:45,129` | `BUILTIN_RETIRED` | hardcoded-business-data | low | 静态废弃模型账本。**类型陷阱**：`:43` `_PROBED_AT = Date.parse('2026-10-09T00:00:00Z')` 存的是 epoch 毫秒数，`:56` `TRANSIENT_TTL_MS = 7*24*60*60*1000` 的 TTL 判定吃时间戳。外置 JSON 若存日期字符串会让 TTL 判定变 `NaN`。 |
| 17 | `src/services/domain/`（92 文件） | `path.join(os.homedir(), '.khyquant' \| '.khy')` | path-literal | **high** | **实测修正**：`src/services/domain/` 下 `os.homedir()` 105 处 / 39 文件；`path.join(os.homedir())` 48 处 / 13 文件；**真正拼 `.khyquant`/`.khy` 字面量的只有 5 处**。`src/services/` 全量 281 处、整个 `src` 417 处。同目录另有 302 处已正确使用 `getDataHome` 系。B8 红线。 |
| 18 | `src/services/gateway/routingMode.js:29,653,660,775` | `CARD_REL` / `_loadRoutingModes` | data-access-in-logic | medium | `__dirname` 三级上爬读 JSON；注释自陈「少写一层被 catch 吞成『卡不存在』」。**合并语义**：inline env 分支直接 return（零合并）；appHome 分支 per-mode 浅合并；base 缺失返 null。 |
| 19 | `src/services/localBrainService.js:1199-1215` | `_getPublicApis` / `_findApi` | data-access-in-logic | medium | 模块级缓存 + `fs.readFileSync` + `JSON.parse` + 静默 `{apis:[]}` 四件事写在 2990 行服务里。**无 env、无 appHome 层**。 |
| 20 | `src/services/webSearchService.js:313-330` | `_readEngineConfigText` | data-access-in-logic | medium | **实测修正**：与 `webToolsService.js:23-45` 不是同一份拷贝——后者返回 `{ path, text }`（`:112` 把 `configPath` 放进 `gatherWebToolsStatus()` 回显给用户），前者只返回 `text`。两份「重复读取」返回形状不同。 |
| 21 | `src/services/cliAgentRunner.js:220-222` | `agent_roles.json` 解析 | data-access-in-logic | medium | `path.join(os.homedir(), '.khyquant', 'agent_roles.json')`——既是 B8 路径字面量，又是「数据文件路径定义在逻辑文件里」。 |
| 22 | `src/data/bugCases.js:191,207,214,228` | `exportBugCasesForTraining` 等 3 函数 | logic-in-data-file | medium | 数据数组之外同模块导出 3 个函数 ⇒ 数据文件反向携带检索/导出逻辑，且无法被非 JS 消费方读取。 |
| 23 | `src/constants/prompts.js:18,2323-2324` | `require('../services/selfProfile')` | logic-in-data-file | **high** | 依赖方向倒流：constants/（D3）→ services/（D1）。`selfProfile.js` 又 lazy-require `../skills/index`、`./gateway/aiGateway`、`../constants/commandSchema`，构成 constants↔services 双向环。**实测**：`prompts.js` 共 29 处 `require('../services/')`、横跨 20 个模块。 |
| 24 | `src/services/tool/toolCallNudges.js:13-108` | 5 个 nudge 模板 | inline-prompt-template | medium | 中英混排 follow-up 提示词以数组 `join('\n')` 内联在逻辑目录。 |
| 25 | `src/services/smallModelPromptTemplates.js`（454 行） | `PHASES` / `TASK_TYPES` | inline-prompt-template | medium | 自认「Pure leaf module: zero requires, zero IO」却住在 `services/`。低风险高收益的解耦样板候选。 |
| 26 | `src/services/planModeService.js:475-513,1290` | `PLAN_PROMPT_RICH` / `PLAN_PROMPT_LEGACY` | inline-prompt-template | medium | 两版大型计划提示词 + 步骤执行模板，写在 2280 行服务文件里。 |
| 27 | `src/services/tool/toolUseLoopCore.js:6864-6872,8825-8833` | edit-failure hint | inline-user-facing-string | medium | 同一组三条 hint 在两处近乎重复且**已漂移**（第一处「Use read_file to see the current content」，第二处「The text may have changed or whitespace/indentation does not match」）。 |
| 28 | `src/services/gateway/aiGatewayGenerateMethod.js`（约 30+ 处） | `emitStatus` / `emitActivity` | inline-user-facing-string | medium | 中文状态文案内联，其中嵌 CLI 命令字面量（`'khy gateway status'`、`'khy provider use <key>'`）。 |
| 29 | `src/services/aiManagementServer.js`（约 13 处） | `sendJson` / `sendEvent` | inline-user-facing-string | low | HTTP 响应 message 与路由处理同体。 |
| 30 | `src/services/domain/memory/compact/prompt.js:32-242` | 4 个压缩提示词模板 | inline-prompt-template | low | 纯提示词数据模块住在逻辑子域内（本身是好的抽取，只是停在逻辑层）。 |
| 31 | `src/i18n/` | `t()` / `locales/{zh,en,ja,fr,de}.json` | inline-i18n | **high** | 框架完整但 services/ 零消费。**实测**：`src/i18n/index.js:18-21` require fs/path/`../utils/logger`，`:25` `path.join(__dirname,'locales')`，`:45` `_loadLocale()` 做 IO —— 它是**带 IO 的装载器，不是纯内容**。zh/en 各 131 leaf key、13 命名空间完全对齐。 |
| 32 | `src/services/domain/`（49 文件） | 内联 JSON Schema | schema-in-code | medium | `metaPlanSchema.js`、`contentSchema.js`、`mcp/toolPool.js` 等。`src/contracts/`（12 文件）已建立「契约 JSON 单独放」先例，且 `agentclient/acpTypes.js:12` 是唯一正确接线者。 |
| 33 | `src/services/acpTransport.js:25` | `_acpSchema` lazy require | data-access-in-logic | low | 同类契约数据两种装载姿势（静态顶层 vs 函数内 lazy）；lazy 那处使契约依赖在调用图上不可见（archDebt 扫描器判「幽灵依赖」的来源）。 |

### 1.2 交互与边缘层（44 个耦合点）

| # | 路径 | 符号 | 耦合类别 | 严重度 | 说明 |
|---|---|---|---|---|---|
| 1 | `cli/ai.js:86-181` | `EFFORT_PRESETS` / `MODEL_CAPABILITIES` | hardcoded-business-data | **blocking** | 四档推理参数表 + 60+ 型号能力评分表（含中文 label）写在 5225 行宿主文件里。**实测**：`:94-95` 注释明说 context 字段不写在这里；`:177-179` 模块加载期原地 `cap.context = resolveModelContextWindow(id)` 回填；`:183` `setAiRequestAnalysisDeps({...})` 收的是**同一对象引用**。抽取时若改动加载期 mutation 的执行时序，会让上下文分母漂移。 |
| 2 | `cli/ai.js:405-418` | `COT_INJECTION_PROMPT` | inline-prompt-template | medium | CoT 注入文案内联在宿主文件。 |
| 3 | `cli/ai.js:179-181` | `MODEL_CAPABILITIES` post-pass | logic-in-data-file | **high** | 模块顶层副作用 + 数据/逻辑同文件。 |
| 4 | `cli/aliases.js:20-797` | `ALIAS_MAP` | hardcoded-business-data | **high** | 约 780 行拼音/中文/英文缩写映射。`:874` `ALIAS_MAP` 是公开导出。与 `cli/commands/registry.json`、handler manifest 的 aliases 形成三处并存别名真源（靠 `commandAutoRegistry.getAliases()` 运行时合并）。 |
| 5 | `cli/replSession.js:2883-2893` | `TIPS` | inline-i18n | medium | 9 条中文轮播文案 + 30s setInterval 状态机，写在 13916 行 REPL 主循环里。 |
| 6 | `cli/replSession.js:8183-8202` | `BLOCKED_NAMES` / `BLOCKED_EXTS` | schema-in-code | **blocking** | 18 个敏感文件名 + 7 个敏感扩展名构成「禁止读取」安全策略表。**R2 密钥防泄露红线的执行面之一**——漏改一条即可能把凭据内容读进上下文。该集合同时含基名（`id_rsa`）与扩展名（`.pem`），现有代码对两者用同一数组匹配。 |
| 7 | `cli/replSession.js:6480-6489` | `stickers` | hardcoded-business-data | low | 8 条 kaomoji/ASCII 艺术。同族 `cli/tui/logoArt.js` 的 `CLOVER_ART` 已单独成文件。 |
| 8 | `cli/replSession.js:80,164` | 设置键名 / `require('../../package.json').version` | hardcoded-config | low | 设置键名与 `settingsWhitelist.js` 三处需一致；version 顶层 require 使冷启动多一次 IO。 |
| 9 | `cli/aiChatCore.js:448-1073` | `onStatus` message / `TARGET_LABEL` | inline-user-facing-string | **high** | 数百条中文状态消息直接写在 `chat()` 主体（该文件 5225 行、620 行含中文）。同族 `cli/repl/statusLabels.js` 已收敛成纯函数，但这一带没有走任何 i18n 或文案表。 |
| 10 | `cli/aiGatewayGenerateHelpers.js:131-619` | 4 段 LLM 提示词模板 | inline-prompt-template | **high** | `lines.push('中文…')` 内联拼装，含 500/800/1200 字符截断阈值。提示词（内容）+ 阈值（配置）+ 步骤匹配算法（逻辑）同函数体。 |
| 11 | `cli/handlers/backtest.js:18-62` | `BUILTIN_STRATEGIES` | hardcoded-business-data | **high** | 三个内置量化策略的**可执行 JS 源码字符串**连同中文名称写死。**实测**：三条策略 code 无反插值，JSON 化安全（透镜已核实）。策略数值（5/20/14、30/70）与实现代码没有分离。 |
| 12 | `cli/handlers/gateway.js:992-1000,1445-1520` | `API_PROVIDER_ENV_KEYS` / `API_PROVIDER_DISPLAY_NAMES` / `PROTOCOL_LABELS` | hardcoded-business-data | **high** | 10 家公开 API 供应商目录（env key 名、endpoint env key 名、默认 URL、中文显示名）写在 3266 行 handler 里；而 `src/data/publicApis.json` 已是同类资产的正确载体。 |
| 13 | `cli/handlers/gateway.js:149-158,188-227` | `STRICT_OPERATIONAL_ADAPTERS` + 8 处 `Math.max(parseInt(...))` | env-read-inline | medium | env 默认值与 clamp 边界散落，未走 `utils/envInt` 等单一真源。**注意**：`Math.max(floor, parseInt(env \|\| 'd',10) \|\| d)` 在 `env='0'` 时因 0 falsy 回落默认值，而 `envInt` 返回 0 再 clamp 到 min —— **只有 min>=1 时两者才等价**，不可批量替换。 |
| 14 | `cli/handlers/gateway.js:225-229` | `AI_MANAGE_DAEMON_SCRIPT` / `KHY_GATEWAY_DEBUG_PROMPT_DEFAULT_FILE` | path-literal | medium | `path.resolve(__dirname,'../../../scripts/...')` 与 `getDataHome()` 拼日志名。同族 `cli/handlers/proxy.js:36-38`。 |
| 15 | `cli/handlers/clean.js:44-62,129-201,372-380` | 清理目标白名单 | hardcoded-business-data | **high** | 删除策略数据（`{rel, why 中文理由, rebuild}`）。注释自陈「黑名单漏写一条就等于删掉用户的凭据」。改一条文案或加一个目标都要开一个会删文件的模块。 |
| 16 | `cli/handlers/init.js:41-59` | `DEFAULT_KHY_MD` | inline-prompt-template | medium | `khy init` 写入新项目的 CLAUDE.md 全文模板，写在 3118 行 init handler 里。 |
| 17 | `cli/handlers/config.js:22-70+` | `SUPPORTED_CONFIG_KEYS` / `KEY_ALIASES` / `PROVIDER_TO_ADAPTER` | schema-in-code | medium | 配置 schema 与别名表是数据契约，且必须与 `src/config/settingsWhitelist.js`、`cli/repl/khySettings.js` 一致；目前三处各自维护、无机械校验。 |
| 18 | `cli/handlers/agentAssets.js:38-45` | `KIND_LABELS` / `ACTION_LABELS` | inline-i18n | medium | 同模式在 `cli/handlers/deliveries.js:19`、`commit.js:251`、`channels.js:20` 重复出现——本域没有文案表，于是每个 handler 自带一份。 |
| 19 | `cli/handlers/doctorConnectivity.js:28-31,365-371` | `PROXY_SCHEME_PORTS` / `PROBE_TIMEOUT_MS` | hardcoded-config | low | IANA 知名端口是纯参考数据。 |
| 20 | `cli/repl/statusLabels.js:28-60` | `phaseActionLabel` | inline-i18n | medium | 11 个 phase id → 中文动作标签的 if 链。**「文案以控制流表达」**，使 i18n 化不可能（没有 key 可译）。 |
| 21 | `cli/tui/ink-components/App.js`（10+ 处） | `showHint` / `pushNotice` / `push` | inline-user-facing-string | **high** | 7788 行 Ink 根组件里散布上百条用户可见中文（含三选项更新菜单）。CC TUI 是长期子系统（163 文件）且品牌合规要求「用 Khy 品牌」；改一个词要开 7788 行文件。 |
| 22 | `cli/tui/ink-components/App.js:61,217,222-227,414-416` | `GATEWAY_DEGRADE_MS` / `DEFAULT_NOTIFY_TTL_MS` / `_SELECT_CLEAR_DELAY_MS` / `_OFF_VALUES` | hardcoded-threshold | medium | 同族参数在 `cli/tui/perfTunables.js` 已有正确归宿（纯叶子 cadence 真源 + env 覆盖），但这些新旋钮没有进去。 |
| 23 | `cli/tui/commandParamSpecs.js:66-174` | `CURATED` / `_choice` / `_text` / `_colorChoices` | inline-i18n | **high** | 斜杠命令参数面板的 curated 规格表：每条命令的中文标签 + 中文候选项 + 中文 hint + 默认值。其中 `lang` 选项自带一套语言清单，与 `src/i18n/` 的 `SUPPORTED_LOCALES` 是两份真源。本域最纯粹的「UI 文案 + 选项目录」资产。 |
| 24 | `cli/tui/theme/ccTheme.js:15-60+` | `CC_COLORS` | hardcoded-config | medium | 约 25 个十六进制色值 + 亮色覆盖组。与 `cli/themeRegistry.js` + `cli/themes/*.json`（8 个）是两套主题机制。 |
| 25 | `cli/tui/bootLayout.js:33-56` | `FIXED_ROWS` / `TAIL_ROWS` / `RUNGS` / `CLOVER_ROWS` | magic-number | medium | 版面度量常数；注释自陈「与 `logoArt.CLOVER_ROWS` 同值；不 require 以保持本文件零图形依赖」——**刻意不同 require 的复制**。 |
| 26 | `cli/sessionColor.js:19-20` | `AGENT_COLORS` | hardcoded-business-data | medium | 与 `src/agents/types.js:83` **逐字相同**。注释明说「叶子内联避免业务 require」——为保零依赖契约而复制数据。 |
| 27 | `cli/handlers/createFrontend.js:30-34` | `ARCHETYPE_ID` / `TEMPLATE_NAME` / `DEFAULT_PROJECT_NAME` | hardcoded-config | low | 三个字面量必须与 `src/blueprints/archetypes/*.json`、`src/templates/*.json` 的文件名一致；一致性靠测试锁死而非数据契约。 |
| 28 | `tools/AgentTool/index.js:376-500` | `prompt()` / `inputSchema` | inline-prompt-template | **high** | 约 45 行 Agent 工具系统提示（含 10 种 Subagent types）+ `subagent_type` enum 20 值 + 每参数 description，写在 2324 行工具类里。 |
| 29 | `tools/**`（209 个含中文 JS 文件） | 各工具 `inputSchema` 的 description | inline-i18n | **high** | 工具参数 description 同时面向模型与用户（TUI 会渲染），是 inline-i18n + schema-in-code 复合点；229 个工具目录无统一 schema/文案数据层。 |
| 30 | `agents/built-in/auditAgent.js:24-100+` | `AUDIT_SYSTEM_PROMPT` | inline-prompt-template | medium | 约 80 行 audit 系统提示。同目录已有 `coordinator.md` / `agentCreator.md` 等 markdown 形态定义（数据），但 15+ 个 `*Agent.js` 是「提示词写在 JS 常量里」——同族资产两种载体，34 个条目分裂。 |
| 31 | `agents/constraints.js:27-52` | `EXECUTION_DISCIPLINE` / `HARD_PROHIBITIONS` | logic-in-data-file | low | 本域**好样板**（注入而非复制），但红线文案本身成了「散落硬编码」的判据来源，而它自己是 JS 字符串。 |
| 32 | `webRemoteControl/mobilePage.js:11-31,39-189` | `COPY` + 整页模板 | inline-i18n | **high** | 20 条中文文案 + 整页 HTML/CSS/JS 作为一个模板字符串。注释自称「文案真源：`apps/khyos-desktop/zcode-analysis/i18n-zh.json` 的 `webRemoteControl.*`」。**实测**：该「真源」与 `src/renderer/i18n/zh-CN.json` 键数差 1（5070 vs 5069）且无守卫 —— 「真源」claim 本身是第三份未校验副本。 |
| 33 | `bridge/mobilePage.js:16-1372` | `buildMobileHTML` / `KIND_LABELS` / `LABELS` | inline-user-facing-string | **high** | 另一份 1372 行移动/桌面协作页，内联 CSS+JS+中文 UI。与 webRemoteControl 是**两份独立的页面实现**（合计 1561 行），不是重复实现。 |
| 34 | `webRemoteControl/protocol.js` | 协议常量与消息类型 | schema-in-code | medium | 与 `bridge/protocol`、`src/contracts/mobile/` 三处相关。 |
| 35 | `routes/aiGatewayAdmin.js:519-536` | `MODEL_SLOT_DEFS` / `shouldWriteClaudeSettings` | hardcoded-config | medium | Claude Code 五个模型槽位 → env key 映射。env key 名是配置契约（R2 邻域），散落在路由文件里；与 `aiManagementGatewayAdmin` 的「同名孪生」并存。 |
| 36 | `routes/downloads.js:8-11` | `DIST_DIR` / `ARTIFACT_PATTERNS` | path-literal | medium | `path.resolve(__dirname,'../../../../dist')` 跨 4 层相对跳转。 |
| 37 | `routes/freeLLM.js:76-78` | `analysisPrompt` 兜底 | inline-prompt-template | medium | 面向 LLM 的提示词兜底值 + 中文输出指令写死在路由处理器。 |
| 38 | `routes/largeTasks.js:44-60` | `ACTIVE_TASK_STATUSES` / `DEFAULT_HANDOVER_WINDOW_MINUTES` / `TODO_STATE_FILE_NAME` | hardcoded-threshold | medium | 与 `routes/largeTasks/retryPolicyValidation.js`（12 个 `RETRY_POLICY_*` 常量）分居两处、无共享 schema。 |
| 39 | `routes/khySessions.js:20-21` + `routes/apiKey.js:12` | `MAX_LIST_LIMIT` / `MAX_CHAIN_MESSAGES` / `API_KEY_SCHEMA_CACHE_MS` | hardcoded-threshold | low | `utils/clampInt.js`、`utils/envInt.js` 已存在但未被用作统一入口。 |
| 40 | `middleware/originGuard.js:22,46-50` | `ALLOWED_ORIGINS_ENV` / `parseAllowedOrigins` | env-read-inline | low | env 名是跨进程契约；安全相关默认值缺失时「恒为空白名单」这一策略没有在任何数据层登记。 |
| 41 | `observability/otel.js:9-15` | `OTEL_OPTIONAL_PACKAGES` | hardcoded-config | low | 与 `constants/installationCandidates.js` 是平行真源。 |
| 42 | `constants/prompts.js:113-503,265-503,612-3251` | `PROMPT_INTENT_*` 规则引擎 + 15 个关键词正则 | logic-in-data-file | **high** | 名为 constants 的 3251 行文件实为「系统提示词内容 + 意图规则引擎」混合体。已越过 R4 2500 行门。 |
| 43 | `cli/**`（159 个文件） | `const OFF_VALUES = ['0','false','off','no']` | hardcoded-config | **high** | 本域最严重的**数据复制**。`utils/flagRegistry/index.js`（4017 行）文件头自述「其解析逻辑被逐文件复制了近百遍，且方言不一致：71 个文件用 4 词 CANON、6 个用 6 词 EXTENDED、`priorityTaxonomy` 用 3 词 MINIMAL 且不归一」。 |
| 44 | `src/data/publicApis.json` | 消费方 `services/localBrainService.js:1199-1207` | data-access-in-logic | medium | 数据资产本体是对的（JSON、无逻辑），但访问是裸 fs + 模块级缓存 + 路径拼接，没有 DAL、没有 schema 校验、没有热重载契约。 |

### 1.3 数据与配置层（30 个耦合点）

| # | 路径 | 符号 | 耦合类别 | 严重度 | 说明 |
|---|---|---|---|---|---|
| 1 | `constants/prompts.js:139-570` | `PROMPT_INTENT_SECTION_RULES` / 17 条正则 + 校验器 | logic-in-data-file | **high** | 「什么用户输入该注入哪段系统提示」的业务规则与提示词正文同文件同生命周期。 |
| 2 | `constants/prompts.js:612-3251` | `getSystemPrompt` / 40+ `getXxxSection()` | inline-prompt-template | **high** | 提示词文案写成函数与模板字面量；memo 键、cache boundary 与文案纠缠。 |
| 3 | `constants/prompts.js`（37 处） | `KHY_PLANNING_DISCIPLINE` / `KHY_SKILL_CATALOG_CHARS` 等 | env-read-inline | **high** | 提示词装配器自己当配置解析器；与 `utils/flagRegistry`（4017 行 FLAGS 表）、`constants/serviceDefaults.js`（133 处 env）三套 env 口径并存。 |
| 4 | `constants/commandSchema.js:2192-2245` | `_autoRegistryCommandNames` / `getRouterCommandNames` / `getRouterSubCommands` | logic-in-data-file | **high** | 数据表之后带 10 个函数，其中 3 个 lazy require `../cli/commandAutoRegistry`。**实测确认** `:2194` 与 `:2229` 两处 D3→D1。 |
| 5 | `constants/commandSchema.js:15-2158,2252-2256` | `ROUTER_COMMANDS` / `BUILTIN_SLASH_COMMANDS` / `MENU_SUB_SUGGESTIONS` | hardcoded-business-data | medium | 约 2100 行命令元数据，2381 行已逼近 R4 门（仅 119 行余量）。 |
| 6 | `constants/commandHelp.js:24-173` | `EXTRA_HELP` / `ALIAS_CANON` | inline-user-facing-string | medium | 40+ 条中文帮助文案，无 i18n 挂点。 |
| 7 | `constants/promptLocales.js:17-276` | `LOCALE_CATALOGS` / `t()` | inline-i18n | **high** | 4 语言（en/zh/ja/ko）目录以 JS 对象字面量硬编码。**键序依赖**：`:223-231` `tBlock` 用 `Object.keys(catalog).filter(...).map(t).join(separator)` —— 输出行序完全由键插入序决定；`:265-266` `supportedLocales()` 返回 `Object.keys(LOCALE_CATALOGS)`。手写或排序过的 JSON 会静默改输出。与 `src/i18n/locales/*.json`（en/zh/ja/fr/de）语言集不一致。 |
| 8 | `src/i18n/index.js` | `t` / `setLocale` / `LOCALES_DIR` | inline-i18n | medium | 完整框架 + 5 语言 JSON，但全仓仅 `src/index.js:24` 一处 re-export。**它自己带 fs IO**（见 1.1 #31）。 |
| 9 | `constants/serviceDefaults.js`（133 处） | `CLOUD_DEFAULT_ENDPOINT` / ILINK 参数组等 | env-read-inline | **high** | 691 行内 133 处 `process.env` 直读。**范式确认**：`:24-26` 与 `:49` 显示既有范式是模块级 `const = process.env.X \|\| 字面量`（**require 时求值**）。没有声明式 schema，无法批量校验/生成文档。 |
| 10 | `constants/serviceDefaults.js:61-89` | `_discoverAiBackendUrl` / `getAiBackendUrl` | data-access-in-logic | medium | 「常量文件」持有文件系统访问与运行时状态发现职责（`readFileSync(<dataHome>/ai_manage_runtime.json)`）。用了 dataHome（B8 合规），问题在职责不在路径。 |
| 11 | `constants/installationCandidates.js:7-8,62` | `programFiles` / `programFilesX86` / Git 候选路径 | path-literal | medium | `process.env.ProgramFiles \|\| 'C:\\Program Files'` —— 即便有 env 兜底，兜底值本身即硬编码 `C:`，直接违反 CLAUDE.md「绝不硬编码盘符」。 |
| 12 | `config/a2aConfig.js:33-84` | `buildConfig` / `workspaceBaseDir` | hardcoded-config | medium | 11 个默认值内联；catch 分支回退 `path.resolve(process.cwd(), '.khy', 'agent-workspaces')` —— B8 明令禁止的 cwd 相对形态残留（虽被 dataHome 分支遮蔽）。 |
| 13 | `config/models/style_templates.js` | `SECTION_CATALOG` / `TASK_KEYWORDS` | hardcoded-business-data | medium | 中文多行提示词数据以 .js 存（有意识决策，头注释写明「只许写字面量」），但约定无强制、无 JSON Schema 校验、热重载靠 shim 重新解释字面量。 |
| 14 | `utils/flagRegistry/index.js:75-2230` | `FLAGS` | hardcoded-config | **high** | 4017 行 FLAGS 巨型对象，被 224 个模块 require。与 `serviceDefaults.js` 的 133 处 env 直读构成两套并行 env 真源。 |
| 15 | `constants/modelContextWindows.js:33-336` | `MODEL_CONTEXT_WINDOWS` / `MODEL_CONTEXT_PREFIXES` | hardcoded-business-data | **high** | 约 300 行模型上下文窗口表。**实测**：`:41` 与 `:73` 两张表均 `Object.freeze`；`:30-33` require `./contextWindowDefaults`（D3→D3 合法）。文件头自载历史事故：同批数值曾散在 4 处并已漂移。**该模块处于 `cli/ai.js:177-179` 模块加载期 post-pass 的关键路径上**，装载时机一变就是大规模行为变更。 |
| 16 | `constants/smallModelDefaults.js:20-239` | `RETRY_BUDGET_DEFAULTS` / 11 个 getter | hardcoded-threshold | medium | 数值本身已在单一真源（好），但形态是「JS 默认值 + 自研 `_mergeJsonEnv` 解析 env 内联 JSON」，无声明式 schema。 |
| 17 | `constants/promptAnchors.js:44-331` | `ANCHOR_RE` / `parseAnchors()` | logic-in-data-file | medium | 「数据（槽位表、标记文法）+ 算法（解析/估算/摘要）」混合体，还 require `utils/gateOn`。 |
| 18 | `constants/promptSectionTaxonomy.js:34-443` | `SECTIONS` / `idsByTier()` | schema-in-code | medium | 系统提示的结构 schema 内联在 JS；与 prompts.js 的实际实现、promptAnchors 的 slot 是三处必须手工同步的结构定义。 |
| 19 | `constants/promptPrefixShape.js:94` | `_shortHash(names.join('<NUL>'))` | magic-number | medium | 源码字符串字面量内含裸 NUL 字节（0x00，offset 3818），使该文件被 `file`/grep 判定为 binary，影响全文检索与 diff 渲染。 |
| 20 | `constants/positioning.js:20-70` | `POSITIONING` | inline-user-facing-string | medium | 产品定位文案单一真源（tagline/oneLiner/四条 claims），`Object.freeze` 在 JS 里。 |
| 21 | `constants/gitCoAuthorTrailer.js:17-45` | `DEFAULT_TRAILER` / `isEnabled` | hardcoded-config | **high** | `DEFAULT_TRAILER = 'Co-Authored-By: khy <noreply@khy-os.local>'` 默认开启。**与 B6 / PROCESS-010 正面冲突**：CLAUDE.md 明令「禁止 `Co-Authored-By: <AI>` 署名」，而 `scripts/ci/check-commit-message.js` 的 `AI_NAMES` 词表（claude\|gpt\|anthropic\|…）拦不到 `'khy'`。 |
| 22 | `src/data/bugCases.js:14-227` | `BUG_CASES` + 3 函数 | logic-in-data-file | medium | data/ 目录下的「数据文件」携带查询与导出逻辑。 |
| 23 | `src/data/publicApis.json` | 消费方 `localBrainService.js:1205-1218` | data-access-in-logic | medium | 同类数据 `curriculum.json` 却有 mtime 热重载的好实现，同一 data/ 目录两种访问范式。 |
| 24 | `src/blueprints/`（21 JSON） | 装载器 `catalog.js:33-60` | hardcoded-threshold | medium | 数据很好，但装载器内联阈值（`defaultSliceChars` 5000 / `conceptSummaryMaxChars` 1200），并对每条载入的 JSON 追加 `obj._filename = file`（写回数据对象）。 |
| 25 | `src/templates/`（8 个 JSON） | `createFrontend.js:30-31` | hardcoded-business-data | medium | 约 60KB 死数据随包分发（6 份零引用）；唯一接线点反而是硬编码的。 |
| 26 | `services/projectTemplateService.js:13-32` | `loadTemplates` / `matchTemplate` | data-access-in-logic | medium | 与 `catalog.js`、`learningCurriculum` 三套并行装载器；模板对象被写字段后缓存永不失效。 |
| 27 | `src/contracts/`（12 文件） | `acpTypes.js:12` / `acpTransport.js:25` | data-access-in-logic | medium | 契约数据没有「接口层」；同一类契约在 services/ 有两种装载姿势。 |
| 28 | `src/plugin-loader/index.js:60-76` | `validateManifestFallback` / `MANIFEST_FIELDS` 内联副本 | schema-in-code | medium | 契约在代码里存了两份（SDK 一份、backend fallback 一份），靠 `tests/plugin-sdk.test.js` 钉一致 —— 用测试补偿架构缺失。 |
| 29 | `cli/handlers/learn.js:1234` | `learn list` 输出 | path-literal | low | 用户可见输出 `数据文件: backend/src/data/curriculum.json` —— 把数据文件的物理位置焊进用户文案，数据层一迁移该提示立即说谎。 |
| 30 | `constants/promptFreshness.js:35-76` | `DEFAULT_GIT_STAMP_TTL_MS` | hardcoded-threshold | low | 又一个「常量文件里的 env+阈值+算法」混合体（本域第 5 个）。 |

### 1.4 前端与交付层（32 个耦合点）

| # | 路径 | 符号 | 耦合类别 | 严重度 | 说明 |
|---|---|---|---|---|---|
| 1 | `delivery/web/ai-frontend/vite.config.js:23-52,129-157` | `resolveBackendTarget` / `DAEMON_ONLY_NAMESPACES` | hardcoded-config | **blocking** | 构建配置承担运行时职责：await 解析两个后端目标、内联 10+ 个命名空间路由表、把 `/api` 与 `/ws/cross-platform` 分流。改路由表要改构建配置，改构建配置会触发 Vite 进程内重求值从而影响运行态端口。 |
| 2 | `delivery/web/ai-frontend/backendDiscovery.mjs:27-46,110-164` | 默认端口 / 数据家优先级链 | hardcoded-config | **high** | 端口 9090/3000、运行时文件名清单、数据家链（env → `~/.khy/.location.json` → `~/.khy` → `~/.khyquant`）、`~PORTABLE~/` 前缀、400ms 超时 —— 全是后端策略的镜像副本。文件头自述 "keep the port in lock-step"（`constants/serviceDefaults.js` 的 `AI_BACKEND_DEFAULT_PORT` 是后端真源）。 |
| 3 | `delivery/web/ai-frontend/frontendRuntime.mjs:30-37,62-94` | `DEFAULT_FRONTEND_PORT` / `publishFrontendRuntime` | hardcoded-config | **high** | 基准端口 8090、扫描窗口 20、应用 id。**实测修正**：`:32` `FRONTEND_IDENTITY_PATH = '/khy-frontend-identity.json'`，与后端 `aiFrontendLocator.js:32` 同名常量构成跨进程契约（后端逐个端口做身份探测先打该路径）。 |
| 4 | `delivery/channel/khyquant/frontend/vite.config.js`（7 处） | `defineConfig` / `VitePWA` | hardcoded-config | **high** | 后端 host/port 默认（127.0.0.1:3000）、dev server 8080 + 0.0.0.0、PWA manifest 全量文案与主题色、workbox 缓存预算、chunkSizeWarningLimit、manualChunks 分包表。 |
| 5 | `.../frontend/src/composables/useDashboardLanAccess.js:18,73-82,109` | `useDashboardLanAccess` | hardcoded-config | **high** | 局域网访问 URL 硬编码端口 8080（与 vite.config `server.port` 是两份事实）；私网前缀判定与优先级权重 1/2/3/99；WebRTC 探测超时 2000ms。 |
| 6 | `.../frontend/src/utils/connectionMode.js:17-19` | `getDefaultConnectionMode` | hardcoded-config | medium | 域名清单 `'khyquant.top'` / `'khyquant.com'` 与 `serviceDefaults.js:11` 是第二份副本。被 `check-agent-rules.js` 的 `no-hardcoded-prod-domain` 豁免（host 探针）——守卫认为安全，架构上仍是重复真源。 |
| 7 | `delivery/channel/khyquant/services/multiFreeService.js:73-219` | `MultiFreeService.constructor` / `this.providers` | hardcoded-business-data | **high** | 11 家 provider 完整注册表（显示名、env 变量名含 BAIDU 三别名回退、默认模型 id、priority 1-9、supportsVision、四家 availableModels 目录含 tier）。provider 池的三重身份（配置/数据/策略）无分层。 |
| 8 | `delivery/channel/khyquant/services/jsDataSources.js:13-124` | `JSDataSources.constructor` / `this.sources` | hardcoded-business-data | **high** | 7 个金融数据源注册表内联在类构造函数；随后 `138-294` 行又在各 fetch 方法里把同一批 URL 重写第二遍（Yahoo 三镜像、网易三镜像）。 |
| 9 | `delivery/mobile/.../lib/core/config/built_in_keys.dart:14-16,29-62,66-299` | `BuiltInKeys._decode` / `_registry` | logic-in-data-file | **high** | 一个「数据文件」里同时装载：XOR 解码算法（`_k0.._k3` + `_decode`）、7 个编码凭据字节数组、7 家 provider 的 baseUrl + 模型目录。**实测**：仓库内 7 个 `static const List<int>` 均已消毒为空数组（「钥匙已迁出仓库 2026-09-27」）。R2 辖区。 |
| 10 | `delivery/mobile/.../lib/core/tools/builtin_tools.dart:13-1108` | `createBuiltinTools` | schema-in-code | **high** | 约 20 个 ToolDef 内联在一份 Dart 列表里，每项携带 name、中文 description、inputSchema、execute 闭包。 |
| 11 | `.../builtin_tools.dart:933-942,953-955,991-992,1042` | 三个搜索 provider 构造器 | hardcoded-config | medium | 三个搜索引擎端点 URL、桌面 UA、Accept-Language、各 provider connect/receive 超时。 |
| 12 | `.../services/mlAgentService.js:795-823` | `MLAgentService.extractFeatures` | schema-in-code | **high** | 18 特征 schema 以对象字面量写死；同一份列表在 `ml/train_18_features.py:23` 与 `ml/predict.py:45` 各有一份 —— 三份副本靠注释维持同步。 |
| 13 | `.../services/mlAgentService.js:895-905,923-924,939,1034-1035,1200,1264` | `getDefaultAnalysis` 等 3 方法 | inline-prompt-template | **high** | 分析师叙述模板全文内联：特征重要性得分字面量、预测概率字面量、规则阈值、风险加减分、贝叶斯权重，全部以三元表达式拼进中文句子。 |
| 14 | `delivery/channel/khyquant/config/referencePrices.js:19-25` | `STATIC_FALLBACK` | hardcoded-business-data | **high** | 15 个 A 股/期货代码静态参考价表 + 三级解析链（Sina → DB → 静态表）+ 5 分钟缓存写在同一个模块。 |
| 15 | `apps/khyos-desktop/src/host/index.ts:207,224-232,234-264` | `loadTokenUsageService` / `contextWindowLimit` | data-access-in-logic | **blocking** | host 进程用 `nodeRequire(path.join(resolveKhyOsDir(), 'runtime/node/backend/src/constants/…'))` 按字符串路径动态加载后端模块；`:235` 仍有 `\|\| 128000` 字面量兜底。跨包取真源没有模块契约，只有路径约定。 |
| 16 | `apps/khyos-desktop/src/main/remote/index.ts:45-56,109-110` | `resolveBackendSrc` / `ensureServer` / `lanIPv4` | data-access-in-logic | **blocking** | 以 `path.join(src, 'webRemoteControl','index.js')` / `'constants/serviceDefaults.js'` / `'cli/handlers/mobile.js'` 动态 require 后端模块。 |
| 17 | `apps/khyos-desktop/src/main/keyManager/agentWriters.ts:32-54,74-108,403-408` | `resolveBackendServicesRoot` / `agentTargetPath` / `agentMatrix` | hardcoded-config | **high** | 四层后端解析候选全是字面路径；agent 目标路径表硬编码 + 六个 env 名 + npm 包名内联。**R2 辖区**：唯一把 relay token 写进外部 live-config 的地方。 |
| 18 | `apps/khyos-desktop/src/main/settingsStore.ts:31-98` | `DEFAULTS` | schema-in-code | **high** | 全部设置项默认值与 schema 内联在 TS Record（约 30 键）；`:107-113` `cache = {...DEFAULTS, ...parsed}`；`:118-125` `setSetting` 写合并后的全量对象。 |
| 19 | `apps/khyos-desktop/src/renderer/i18n/zh-CN.json` | vs `zcode-analysis/i18n-zh.json` | hardcoded-business-data | **high** | 两份 345KB 中文文案资产并存。**实测确认**：5070 键 vs 5069 键，差异键唯一且仅存在于 zcode-analysis 版：`workspaceSidebar.showFileTree`（renderer 版无任何独有键）。CLAUDE.md 声称的 `scripts/ci/check-i18n-fidelity.js` 在仓库中不存在。 |
| 20 | `apps/khyos-desktop/src/main/index.ts:676-677` | `devServerUrl` | hardcoded-config | medium | dev server 端口默认 `'5173'` + URL 模板，在 `keyManagerWindow.ts:33-34` 原样重复一遍。 |
| 21 | `delivery/web/ai-frontend/src/nav/index.js:47-180` | `NAV` | hardcoded-business-data | medium | 侧边栏完整目录表（path/label/desc/icon/requiredRole）。本域质量最高的数据表之一（单一真源 + 布线测试），但 `icon` 字段引用 Vue 组件使得这张表无法被移成纯 JSON。 |
| 22 | `delivery/web/ai-frontend/src/api/request.js:10,17,23,118,123,155` | request interceptors | hardcoded-threshold | medium | 超时 30000ms、重试静默延迟 350ms、`RETRYABLE_METHODS`、`AUTH_RETRY_URLS` 三条路径 + 三条中文文案。 |
| 23 | `delivery/web/ai-frontend/src/api/notify.js:71,74-81,109,139-140` | `notifyError` / `SEVERITY_TO_TOAST_TYPE` | hardcoded-threshold | medium | 去重窗口 3000ms、映射表、duration、消息截断 80 / hint 截断 60、fallback 文案。 |
| 24 | `delivery/web/ai-frontend/src/views/AIChat.vue:1081,1272-1273,1591,1763-1771,1983` | `WS_WATCHDOG_MS` / `CTX_MIN_*` / `DRAG_HOLD_MS` / `ATTACHMENT_ICONS` / `formatSize` | magic-number | medium | 5584 行单文件视图里散落：WS 看门狗 30000ms、上下文统计最小消息数 2 / 最小字符 200、拖拽长按 350ms、最近模型上限 5 及 localStorage 键、附件类型→图标组件映射表、字节格式化阶梯阈值。 |
| 25 | `.../frontend/src/views/Trading.vue:1327-1336,1339,1343,1707-1719,1727-1737,2409-2421,2889-2901` | `allPeriodOptions` / `getStrategyStatusColor` / `mockStats` | hardcoded-business-data | medium | 周期选项表、admin 设置映射表、策略状态→颜色/文案两张映射表；以及两处完全重复的 mockStats 合成数据块。文件 4981 行。 |
| 26 | `.../frontend/src/utils/simpleTradingSignalGenerator.js:1-48,88-120` | `generateMockSignals` / `getStrategySeed` | hardcoded-business-data | medium | 整个模块是合成信号数据：随机种子表、各策略信号条数、30 天回看窗口、信号理由文案表。 |
| 27 | `delivery/channel/khyquant/khy_quant/_bootstrap.py:112-148,164,234` | `_ensure_npm_install` / `_seed_database` | hardcoded-config | medium | npm registry 默认 `https://registry.npmmirror.com`、`.env` 里 `PORT=3000`、应用注册 JSON `"port": 3000`。 |
| 28 | `delivery/mobile/.../lib/core/tools/retry_engine.dart:16-21,32-44` | `RetryConfig` / `defaultRetryConfig` / `networkRetryConfig` | hardcoded-threshold | medium | maxAttempts 3、initialDelayMs 1000、backoffMultiplier 2.0、熔断阈值 5、冷却 5 分钟；两份具名配置再重复一遍。`_recordFailure` 读的是模块级 `networkRetryConfig` 而非注入的 config（潜在缺陷）。 |
| 29 | `delivery/mobile/.../lib/core/network/dns_resolver.dart:10-13` | DoH 服务器列表 | hardcoded-config | medium | 四个 DoH 端点内联；同类清单另见 `network_diagnostic.dart:171-174`（四个探测 URL）。 |
| 30 | `.../frontend/src/config/api.js:29-30` | `getWsUrl` | hardcoded-config | low | SSR 分支硬编码 `VITE_BACKEND_HOST` 默认 `'127.0.0.1'` 与 `VITE_BACKEND_PORT` 默认 `'3000'`（端口默认值第四份副本）。 |
| 31 | `.../frontend/package.json:29` + `ai-frontend/package.json:22` | `@khy/ui-shared` 依赖声明 | hardcoded-config | medium | 两个前端包的 `@khy/ui-shared` 均写死 `"0.1.0"`，与 `ui-shared/package.json` version 构成 R3 G3 三源一致。**任何「提取版本到共享配置文件」的方案都会破坏 npm 依赖声明语义，故本条不建议动**。 |
| 32 | `apps/khyos-desktop/CLAUDE.md`「开发流程」 | `check-i18n-fidelity.js` 引用 | hardcoded-config | medium | 项目手册指示运行的守卫不存在（全仓仅此一处引用）→ 第 19 条的漂移实际无自动防护。「约定当机制」的典型。 |

### 1.5 既有好样板（重构必须挂靠，不是新建）

测绘中反复出现的正确形态，是本方案的**基座**而非改造对象：

| 样板 | 位置 | 为什么是好样板 |
|---|---|---|
| 纯叶常量契约 | `src/constants/`（32 文件，其中 `modelContextWindows.js`、`contextWindowDefaults.js`、`retryBudget.js`、`chatHistoryDefaults.js`、`riskOrder.js`、`commandHelp.js`） | 零 IO、确定性、绝不抛、env 经第三参注入、`Object.freeze` |
| env 默认值单一真源 | `src/constants/serviceDefaults.js`（691 行） | 每个值 env 可覆盖，注释声明「零硬编码，import 而非重写字面量」。**最佳样板，新收敛的 URL/端口默认值应全部进这里** |
| 三级数据装载 | `config/models/pricing.json` + `services/modelPricing.js` | env 内联 JSON > appHome 覆盖 > 仓内文件，读一次缓存；五态 priceState；「坏配置收敛到 unknown 绝不抛」 |
| 数据驱动装载 + fail-soft 单条隔离 | `services/domain/project/projectBlueprint/catalog.js:33-100` | readdirSync 过滤 → parse → 缺 id/kind 即跳过，单条损坏不污染整表 |
| mtime 热重载 | `services/learningCurriculum.js:200-262` | `stat.mtimeMs` 比对缓存，改数据不改代码不重启 |
| 纯 JSON + 懒加载归一化 | `templates/docstyles/*.json` + `domain/structured/typeset/styleTemplates.js` | 装载器只做归一化与 skip malformed |
| 路径解析唯一正解 | `src/utils/dataHome.js`（900+ 行） | B8 的唯一合法取址器；services/ 内已有 302 处正确使用 |
| JSON 读盘单点 | `src/utils/readJsonFileSafe.js` | 零抛 fail-soft |
| 内容型数据解耦范式 | `src/blueprints/`（21 JSON）+ `catalog.js` | 「数据全在 JSON，唯一装载入口在 services」 |
| 契约数据独立存放 | `src/contracts/`（12 文件）+ `agentclient/acpTypes.js` | 顶层静态 require，schema-in-code 的归位目标 |
| 数据 map 派生合法集合 | `tools/_toolCategories.js` | `CATEGORIES` 为唯一真源，`VALID_CATEGORIES` 由 `Object.keys` 派生 |
| 一处登记三处派生 | `apps/khyos-desktop/src/renderer/shared/keymap.ts` | `KEY_BINDINGS` 纯数据表 + 纯函数叶子 |
| 注入而非复制 | `agents/constraints.js` | 文件头明文「Do not duplicate any line below into an individual agent prompt」 |
| 数据表落点范本 | `cli/tui/perfTunables.js` | 纯叶子 cadence 真源 + env 覆盖 + 记录「哪些值被放松过」 |
| 跨包透传而非复制 | `delivery/channel/khyquant/constants/models.js`（14 行） | 「单一真源始终是后端，本文件仅作透传」 |
| 文案 SSOT + 薄视图 | `delivery/web/ai-frontend/src/components/gateway/gatewayGuide.js` | provider 申请信息经 API 注入，注释明确「此处不硬编码任何域名」 |
| 永不写死模型名 | `apps/khyos-desktop/src/renderer/utils/useModelCatalog.ts` | 经 preload → host → 后端 providerPresets 动态获取，失败 fail-soft 返回空 |
| 已有 baseline 门禁范式 | `scripts/ci/check-frontend-tokens.js` + `frontend-tokens.baseline.json` | 先量化现状、再禁止增长、`--write` 显式刷新 |

> **被降级的「样板」**：`src/cli/commands/registry.js` 原被引为「JSON + 惰性加载器 + 签名缓存」范式。**实测否定**：该文件是内联 JS 对象字面量 + 懒 require handler，全文不读 `registry.json`；`registry.json` 在 `src/` 下**零 require 站点**（死数据）。故它**不是**范式依据（见裁定 N）。

### 1.6 结构性诊断：三种成因与四层成熟度

**四层成熟度梯度**（不要一刀切，每个耦合点必须明确落到哪一层）：

```
第 1 层  constants/                            env 可覆盖的默认值与 SSOT 常量（唯一允许写 env 默认值的地方）
第 2 层  src/data/ + blueprints/ + config/*.json   纯内容资产（模型目录/渠道/预设/提示词/模板）
第 3 层  src/contracts/                        数据契约 schema
第 4 层  env/appHome 覆盖文件                   用户可改的运行时覆盖
```

**F-域的三种历史成因**（迁移策略必须分开治）：

- **A. 物理隔离导致的镜像**（ai-frontend 三件套 + khyquant frontend serviceDefaults）：前端是独立 npm 包，不能 import 后端 CommonJS。治法是**契约文件**（后端构建期产出、前端消费），不是「提取到数据文件」——跨包读不了。
- **B. 数据载体缺席导致的塞类**（provider 表、工具 schema、特征 schema、文案模板、设置默认值写进 class/方法/视图）：投入产出比最高的一批，剥离是机械的、可测试的、不触碰 R1–R4。
- **C. 跨包无契约的动态 require**（桌面端 `nodeRequire` + 路径字符串拼装）：本域唯一称得上 blocking 的类别——不是难改，而是任何「顺手重构」都会让桌面端在运行期才炸。

---

## 2. 架构设计

### 2.0 前置裁定：四域冲突收敛与三透镜 finding 的回应

> 本节是全文的**宪法**。四域原始设计在此处被收敛为单一形态；后续所有章节只描述收敛后的结果。
> 每条裁定标注：来源 finding、裁决、理由、不采纳的代价。

#### 裁定 A —— 唯一抽象层：`src/dataAccess/`（收敛四域的三套提案）

- **来源**：透镜 2 [high] / 透镜 3 [high] —— 四域各建一套抽象层（`src/services/di/`+`src/utils/dataCard/`、`src/repos/`、`src/dataAccess/`），都自称「全仓唯一允许 IO 的地方」。
- **实测前提**：`src/repos`、`src/dataAccess`、`src/services/di`、`src/prompts`、`src/utils/dataCard`、`src/data/prompts`、`src/cli/data`、`src/tools/data`、`src/contracts/models` **今天均不存在**（已逐一核验）。
- **裁决**：**只建 `runtime/node/backend/src/dataAccess/`**。`backend-services` 的 `src/services/di/` 与 `backend-edge` 的 `src/repos/` **不新建**；它们提出的 DI token 表与仓储文件全部改为 `src/dataAccess/` 下的子模块（`di/`、`repositories/`）。`src/utils/dataCard/` 的三层装载器合并进 `src/dataAccess/loaders/dataCardLoader.js` 的能力内，不单独成目录。
- **理由**：`dataAccess` 覆盖面最大（同时覆盖 constants 瘦身、config、data、contracts 四处），且名字不预设「只服务 services」。
- **不采纳的代价**：`backend-edge` 的 `src/repos/` 提案对 `cli/`、`tools/`、`routes/` 的覆盖更细（16 个仓储），改名后其批次路径需全部改写。
- **附带硬约束**：`src/dataAccess/` 是新的 `src/` 顶级目录，而 `check-repo-layout.js` 有 `layer-registry` 规则（顶层目录须登记在 `[DESIGN-LAY-005]` 与脚本的 `LAYERS`/`CROSSCUTTING`）。**B0 第一步就是跑一次 `node scripts/ci/check-repo-layout.js` 确认顶级目录允许清单**；若被拒，需先做一次 layout 治理修订——而治理修订本身需人点头，可能阻塞 B0。这是**已知风险 R-08**，不是可以忽略的备注。
  - **降低阻塞的替代形态**：若 layout 修订阻塞，把抽象层放进既有 D3 根 `src/utils/dataAccess/`，同时把 D6 加进 D3 的 `mayDependOn`。代价是 `utils/` 语义从「叶工具」扩成「数据访问层」，需在 `utils/` 下补 README 说明。

#### 裁定 B —— `prompts.js` 唯一终态：抽 engine 到逻辑层 + 内容留数据层

- **来源**：透镜 1 [blocking] / 透镜 2 [high] / 透镜 3 [high] —— 三域给出三个互斥终态，且 Node 解析会使目录版被一行壳遮蔽成死代码。
- **裁决**：采用 **backend-edge 的形态**，并吸收 data-config-layer 的数据落点：
  1. `src/constants/prompts.js` 中**纯文案分段** → `src/data/prompts/sections/*.md`（数据层）；
  2. **意图规则引擎**（17 条正则 + 任务规模表 + 规则门 + `_validatePromptIntentConfig` / `_classifyPromptIntentSignals` + env 读取）→ `src/data/prompts/intentRules.json`（数据）+ `src/dataAccess/promptIntent.js`（抽象层薄装载）；
  3. `src/constants/prompts.js` **保留全部既有导出名与签名**，内部改为经 `dataAccess` 取文案；终态 < 2500 行，**不建 `src/prompts/`，不降为一行壳，不改成目录**。
- **理由**：同时满足 R4（拆 god-file）、数据/逻辑分离、以及「60 个导出名一个不改」的行为等价要求。backend-services 的「`constants/prompts/` 目录 + 同名 re-export」会让拆完的文件仍住在 D3 里（D3 受 `d3-purity` 管），且与 backend-edge 的壳方案在 Node 解析上冲突（`require('../constants/prompts')` 命中 `prompts.js` 先于目录 `prompts/`）。
- **不采纳的代价**：无法一次性把 `prompts.js` 变成纯数据文件；它仍是「装配器 + 查表」的混合体，只是不再是 3251 行。

#### 裁定 C —— `selfProfile` 的 D3→D1 边**去不掉**，登记进 allowlist（不宣称「constants 恢复零 D1 依赖」）

- **来源**：透镜 1 [blocking] / 透镜 2 [blocking]。
- **实测证据**：`src/services/selfProfile.js:834-1105` `formatForSystemPrompt` 约 270 行，函数体内 **9 处 lazy require** 同层 services 模块（`modelIdentityTruth`、`cacheMetricsTruth`、`visionRoutingTruth`、`selfAuditRegistry`+`selfAuditVerifier`、`confidenceCalibration`、`clueVault`、`twentyXMode`、`docVsMeasuredPolicy`），并直读 `process.env.KHY_SKILL_FORMAT_AWARENESS`、另有 8 处传 `{ env: process.env }`，且 `:835-837` 在 profile 缺省时回调 `getFullProfile()`。
- **裁决**：
  - 把 `formatForSystemPrompt` 中**可纯化的部分**（9 个 truth 格式器的**调用编排与字符串拼接骨架**）抽到 `src/constants/selfProfileFormat.js` 纯叶；该纯叶只吃「已格式化的字符串数组」，不 require 任何 services 模块。
  - 9 个 truth 格式器本身**原样留在 services/**，由组装层在 `bootstrap/init.js` 第一顺位注册为一个组合 provider（token `SELF_AWARENESS_PROVIDER`）。
  - **`constants/prompts.js:18` 这一条 D3→D1 边保留**，登记进 `repo-layout-baseline.json` 的 allowlist，带 `// TODO(#<task>)` 与到期日。
  - **不宣称**「constants/ 恢复零 D1 依赖」；B 批的 domain-direction 预期改为实测可达成值（见第 5 章）。
- **理由**：把 9 个格式器搬进 constants/ 只是把 D3→D1 违规换位置（d3-purity 立刻红、棘轮被迫上调，而 `repo-layout-baseline.json` 的 `_note` 明令「绝不上调来让 CI 变绿」）；改写成纯叶则丢功能，违背「函数体字节等价」与 B3。
- **不采纳的代价**：`prompts.js` 无法变成零依赖纯叶；「数据层零反向依赖」的验收目标打折为「除登记的 N 条外零反向依赖」。

#### 裁定 D —— `commandSchema` 用**注入式**而非搬迁式（19 个消费者，8 个在 services 侧）

- **来源**：透镜 1 [high] / 透镜 2 [blocking]。
- **实测证据**：全 `src/` 引用 `constants/commandSchema` 的文件共 **19 个**，其中 **8 个在 `src/services/` 下**（`selfProfile.js`、`knowledgeTeachingService.js:1563-1571`、`selfCapabilityRegistry`、`evolutionPolicy`、`domain/docs/docsFreshness/docsFreshnessRunner`、`domain/catalog/commandCatalog/commandCatalog`、`domain/project/management/parityGuard.js:25,44`）。其中 `parityGuard.js:44` `schema.getRouterSubCommands().manage` **无 typeof 守卫**（导出移除即 TypeError，而 `checkParity` 是活的治理函数）；`knowledgeTeachingService.js:1565` 与 `selfProfile.js:300` 有 typeof 守卫（静默退化成空集 / routerCount=0）。另 `src/cli/router.js:21-25` 顶层解构、`:242-243` 模块加载期调用；`featureCapabilityMap.js:3,5` 同样加载期调用。
- **裁决**：**注入式**。`constants/commandSchema.js` **保留** `getRouterCommandNames` / `getRouterSubCommands` 导出与签名，内部改为从一个**可注册 accessor** 取值（`parityGuard.js:25` 的 `deps.commandSchema ||` 已是本仓现成先例，直接复用同形状）；真正 lazy require `cli/commandAutoRegistry` 的那一行搬到组装层（`src/cli/router.js` 顶层 init 或 `bootstrap`）第一顺位执行。
- **理由**：搬迁式会 (a) 让 3 个 services 消费者崩 1 处、静默退化 2 处，而该批 verify 不跑 services 测试，破坏会漏过闸门；(b) 新增 `services→cli` 边，即 `archDebtScan` R1「分层倒挂」的基线类型（`scripts/arch-debt-baseline.json` 43→39），方案没有为这条新边预算棘轮；(c) 若为保 services 消费而 re-export `cli/commandNames`，那仍是 D3→D1 边，与「constants 恢复纯叶」自相矛盾。
- **不采纳的代价**：`constants/commandSchema.js` 不会变成纯数据文件；domain-direction 只降 2 处（`:2194`、`:2229`），不是更多。

#### 裁定 E —— `ENDPOINT_SSOT` 保留既有 env 名，并明确求值时机

- **来源**：透镜 1 [high]。
- **实测证据**：`_endpointResolver.js:20-21` 读 `defaults.CLAUDE_API_ENDPOINT || process.env.CLAUDE_API_ENDPOINT || 'https://api.anthropic.com'`（openai 同型）。`serviceDefaults.js` 中 `CLAUDE_API_ENDPOINT` / `OPENAI_API_ENDPOINT` / `RELAY_API_ENDPOINT` / `LOCAL_LLM_ENDPOINT` / `API_ENDPOINT` 均未定义。`OPENAI_API_ENDPOINT` 另被 3 处当 env 键名字符串读取（`cli/handlers/gateway.js:1492`、`services/apiKeyPool.js:135`、`services/gateway/builtinProviderConfig.js:77`）。`serviceDefaults.js:24-26`、`:49` 的既有范式是**模块级 const = require 时求值**。
- **裁决**：新常量写成

  ```js
  // src/constants/serviceDefaults.js
  // REVIEW R-05: the legacy env names stay as the primary override. Renaming them
  // to KHY_ANTHROPIC_BASE_URL without an alias would silently deprecate them.
  const ANTHROPIC_BASE_URL = process.env.CLAUDE_API_ENDPOINT
    || process.env.KHY_ANTHROPIC_BASE_URL
    || 'https://api.anthropic.com';
  ```

  openai 同理；**不废弃既有 env 名**。若确实要换 env 名，按「行为变更」单独提交并人点头。
  **求值时机**：`serviceDefaults.js` 既有范式是 require 时求值，本方案**不全局改成 getter**（那会改变 133 处消费方的求值时机，是大规模行为变更）。只对本次新增/改动的少数 key 保持既有 const 形态，并在注释中记录「claude/openai 两键的 env 在运行时不再生效」这一事实——**这与今天逐字节相同**。
- **不采纳的代价**：env 名出现「新旧两个」，需在 `serviceDefaults.js` 注释里写清谁是主、谁是兼容别名。

#### 裁定 F —— `catalog.json` 第一期**不搬窗口字段**，seed 仍走 `registerModel`

- **来源**：透镜 1 [high] / 透镜 2 [low] / 透镜 3 [medium]。
- **实测证据**：`models/index.js:36` `contextWindow: pinModelContextWindow(id, config.contextWindow || 4096)` 恒定覆写；10 条中 4 条有效值被改。`cli/ai.js:93-95` 注释明说 context 字段不写在那里。`modelContextWindows.js:317-329` 注释明写真源压过声明值。
- **裁决**：
  1. `config/models/catalog.json` 第一期只搬**非窗口字段**（`id`/`name`/`tier`/`category`/`maxTokens`/`costPerToken`/`capabilities`）；
  2. `src/contracts/models/catalog.schema.json` 把 `contextWindow` 显式标为**禁止手写**（`additionalProperties: false`），`_ssot_note` 写明窗口真源是 `constants/modelContextWindows.js`；
  3. `ModelCatalogRepository` 的 seed **必须仍走 `registerModel`**（或在仓储内显式再调一次 `pinModelContextWindow`），并加断言上述 4 条覆写值的测试；
  4. 方案原文「本字段仅作缺失兜底」是**错述**，已从本文删除。
- **附带（透镜 3 [medium]）**：`catalog.json` 是 `.json`，不在 `scripts/ci/check-model-hardcoding.js` 的 `TEXT_EXTS`（只扫 `.js/.cjs/.mjs`）内，会脱离「模型名单一真源」守卫的扫描面。裁决：给 `catalog.json` 补一条与 `constants/models.js` 的**交叉一致性测试**（id 集合差集只许收缩），而不是改 `TEXT_EXTS`（改守卫扫描面是治理动作，须人点头）。

#### 裁定 G —— D6 域 roots 收窄；`constants` 留 D3；`src/i18n/index.js` 移出数据层

- **来源**：透镜 2 [high] / 透镜 3 [high][medium]。
- **实测证据**：`src/i18n/index.js:18-21` require fs/path/`../utils/logger`、`:25` `path.join(__dirname,'locales')`、`:45` `_loadLocale()` 做 IO —— 是装载器不是内容。`src/data/cliAnythingTemplates/node_skeleton/index.js:4,6,36,50` 与 `backend.js` 含 require，其中 `:36`、`:50` 指向 `../../../cli/handlers/session.js`（解析后落 `src/cli/`，属 D1 roots）。`DOMAIN-DEPS.json` 中 `D3.roots = [src/utils, src/constants]`、`D3.mayDependOn = [D3]`、`enforced[0] d3-purity from D3 forbidTargets [D1,D2,D4,D5]`；`D1.mayDependOn = [D1,D2,D3]`（无 D6）。
- **裁决**：
  1. **D6 roots** = `src/data`（**排除** `src/data/cliAnythingTemplates/**`，它是生成工程的脚手架代码，不是内容资产）、`src/blueprints`、`src/contracts`、`src/templates`、`src/i18n/locales`、`src/cli/themes`、`src/cli/data`、`src/tools/data`、`runtime/node/backend/config/**/*.json`。
  2. `src/i18n/index.js` **显式移出 D6**，归抽象层（`src/dataAccess/i18n.js` 包装它）。
  3. **`src/constants` 留 D3**，在 `DOMAIN-DEPS.json` 的 `_note` 注明「D6 的默认值载体是 D3 的子集」。理由：它今天受 `d3-purity` 管着 36 处违规，若划入 D6 会把这 36 处从读数里搬走而问题没解决。
  4. **D6 加进 D1/D2/D3 的 `mayDependOn`**，让「逻辑层 → 数据层」成为被登记的合法边；否则只有 `d6-purity` 一条单向规则在做事，读者会误以为 `mayDependOn` 图已经管住这条边。
- **不采纳的代价**：D6 不覆盖 `src/constants`，意味着「数据层」这个概念在本仓是**分裂的**（默认值在 D3、内容在 D6）。这是既有账本的现实，方案选择如实记录而不是强行统一。

#### 裁定 H —— 新守卫必须接线 + 登记 rollout，且 B1–B10 每批跑三守卫

- **来源**：透镜 3 [medium]×3。
- **实测证据**：`scripts/ci/check-wiring.js`（TOOLING-005）头部明写「every scripts/ci checker is referenced by >=1 gate surface, or is listed in wiring-exemptions.json with a reason AND an expiry」；`.github/workflows/pr-gate.yml:172` 实跑。`scripts/ci/check-rollout-stage.js`（PROCESS-006）PP-1 禁止新机制直进 S3、PP-3 S1/S2 必须旁路，数据真源 `docs/10_规范/registry/FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms[]`（实测 32 条，含 `check-data-layout`、`domain-direction-guard`、`copyright-readiness-guard` 等同类新机制）。
- **裁决**：
  1. 每个新建 `scripts/ci/check-*.js` **同批**登记进 `FEATURE-OWNERSHIP.json rollout.mechanisms[]`（stage S1、附 rollback 动作），并挂到一个 `check:*` 别名或在 `wiring-exemptions.json` 登记 reason + until。
  2. **「转硬闸」改为「采集足够样本后由人决定升阶」**（与 PP-1 不冲突）。
  3. **每个批次（B1–B10）都跑** `check-change-safety.js --changed` + `check-agent-rules.js --changed` + `check-repo-layout.js`；B10 才做总验收。
- **不采纳的代价**：B0 工作量增加约两步；但这是硬规约，没有「不采纳」选项。

#### 裁定 I —— `src/config` 归属：`*.json` 入数据层，`*.js` 入抽象层

- **来源**：透镜 3 [low] —— 三处口径不一（data-config-layer 把 `src/config/*.json` 划数据层、`src/config/envSchema.js` 划抽象层；backend-services 说本期不进 D6；backend-edge 把 `src/config/schemas/` 划数据层、`envDefaults.js` 标纯叶）。
- **裁决**：**`src/config/*.json` 声明式配置入 D6；`src/config/*.js` 装载/解析入抽象层（D3）**。`src/config` 整体**不进 D6 roots**（它 require `utils/` 与 `@khy/shared`，纳入会污染纯度判据）。
- **附带（透镜 2 [medium]）**：两个域各自新建 env 声明载体（`envDeclarations.json`+`envSchema.js` vs `envDefaults.js`）。裁决：**只建 `src/config/envDefaults.js`**（纯叶、零 IO、可被守卫 AST 校验）作唯一声明真源；`envDeclarations.json` 不建。

#### 裁定 J —— `agents/built-in` 的 `.js` 提示词常量统一到 `.md`

- **来源**：backend-edge 提出的三条裁决请求之一（本文代裁，因属架构分叉而非红线）。
- **裁决**：统一到 **`.md` 内容文件**。理由：① 仓内内容资产的主流载体（同目录已有 `agentCreator.md`/`coordinator.md`/`editAndWriteAgent.md`）；② 34 条目下 `.js` 常量合计 2323 行，无法过 R4；③ `.js` 模块保留自身逻辑、经 `AgentDefinitionRepository` 取提示词。
- **附带**：`AgentTool` 的 `subagent_type` enum（20 值）改由 `agent-definition.schema.json` 派生，消除第二份副本。

#### 裁定 K —— `ccTheme.js` 色板下沉为数据，**不**并入 `cli/themes/*.json`

- **来源**：backend-edge 提出的三条裁决请求之二。
- **裁决**：**不合入**。理由：① `check:tui-gates` 要求 CC TUI 视觉逐字节不变；② 两套 schema 不同（CC 有亮色覆盖组），强行合 schema 会改渲染。只做「色板下沉为 `src/cli/data/ccTheme.json`」。
- **注意（透镜 3 [low]）**：`npm run check:tui-gates` **只定义在仓库根 `package.json:99`**，`runtime/node/backend/package.json` 中 grep 不到。B6 的 verify 必须写成仓库根相对 `node scripts/ci/check-tui-gates.js`，不能与同批 backend 相对命令混用。

#### 裁定 L —— 内联中文文案的容器是**扩 `src/i18n/locales`**，不另起「文案表」

- **来源**：backend-edge 提出的三条裁决请求之三。
- **裁决**：扩 `src/i18n/locales/{zh,en}.json` 的 `message` 命名空间（现有 131 leaf key、13 命名空间，zh/en 完全对齐 —— parity 判据在存量数据上可过）。理由：`src/i18n/index.js` 已存在且零采用是**采纳问题不是缺失问题**。
- **硬约束**：迁移期 **locale 显式锁 `zh-CN`**（`t(key, params, { locale: 'zh-CN' })`），key 的 zh 文案 = 现字面量，保证逐字节等价。若 `t()` 随 OS locale 走，英文机器上原本硬编码的中文消息变英文 = 行为变更。各语言翻译补齐后才放开；这条不满足则 B7 整体回退。

#### 裁定 M —— `gitCoAuthorTrailer.js` 的红线冲突**单列，不混入重构**

- **来源**：C-域 notes 的判断题；透镜 3 确认 B6 词表拦不到 `'khy'`。
- **裁决**：本重构**不碰** `constants/gitCoAuthorTrailer.js`。它是红线冲突（B6「禁止 `Co-Authored-By: <AI>`」）而非数据耦合问题；若顺手外置成 JSON 等于把红线冲突藏进数据文件。**单列交人裁定后再处理。**

#### 裁定 N —— 两份 mobilePage **不合并**；`cli/commands/registry.json` 是死数据

- **来源**：透镜 1 [medium] / 透镜 2 [high]。
- **裁决**：
  1. `webRemoteControl/mobilePage.js`（1561 行）与 `bridge/mobilePage.js`（1372 行）是**真正不同的页面**，只各自把文案归位到 i18n locales，**不合并模板**（合并即行为变更）。整页 HTML/CSS/JS 下沉为 `.html` 资产留待 golden 快照测试就位后的可选批次。
  2. `src/cli/commands/registry.json` **零 require 站点**（实测 `src/` 下 grep 0 命中）—— 它不是范式样板而是死数据。裁决：**B0 之前先删，或在 B0 显式登记为「待接线」并写进 `khy.module.json`**，不留一份没人读的第二真源。删除前再跑一次全仓 grep（含 `works/` 与 `delivery/`）。
  3. `backend-edge` 原引为「仓内既有三种范式之一」的 `cli/commands/registry.js` **降级**；真实范式依据改为 `catalog.js`（readdir+parse+fail-soft）、`learningCurriculum.js`（mtime 热重载）、`utils/dataHome.js`（工厂函数+模块级解析器）。

#### 裁定 O —— 基线数字按实测重写；`check-repo-layout` 的 3 条既有 error 列为 B0 前置

- **来源**：透镜 1 [medium] / 透镜 3 [medium]。
- **实测读数**（`node scripts/ci/check-repo-layout.js --list=domain-direction`，exit 0）：
  - `counts: { domain-direction: 195, functional-unit: 263, entry-buffer: 2470 }`
  - `baseline: { domain-direction: 199, functional-unit: 290, entry-buffer: 2470 }`（updated 2026-10-04）
  - `domain-direction` 195 = `d3-purity` 36 + `d2-no-reach-into-d1` 156 + `no-reach-into-archive` 3
  - `prompts.js` 贡献 **22 条目**（非 31），`commandSchema.js` 4 条目
  - **既有 3 条 [error]**：`root-shadow-dir`（`.khy`、`.khyos`）、`root-junk`（`'`、`tmp-cmp`）、`layer-registry`（`gem`、`tmp-cmp`）
- **裁决**：全文棘轮目标按 **195/263/2470** 写（baseline 199/290/2470 是上限，不是当前值）；**「先清 3 条 error」列为 B0 前置**，否则每批的 `check-repo-layout` 都红，无法作为批次闸门。
- **附带**：透镜 3 指出 `runtime/node/backend/src/{tools,memdir,skills,config,middleware,observability,bootstrap}` **不在 `DOMAIN-DEPS.json` 任何域的 roots 里**（D4 的 `tools` 根指仓库根 `tools/`，不是 `src/tools`）。`prompts.js` 有 8 处 require 打向这些目录（`:883 ../tools/_toolTimeout`、`:1439/:1463/:1480/:2818/:2826 ../memdir/*`、`:2774 ../skills`、`:2854 ../tools/taskMemorySection`）——**domain-direction 对它们完全失明，会给出假绿**。裁决：补一条 grep 型补充判据（见第 5.1 节 J-07）；「把这些子树补登记为域」是治理动作，须人点头，本文只作前置检查项。

### 2.1 新的目录结构

```
runtime/node/backend/
├── config/                                  # 出厂默认配置（纯 JSON）
│   ├── models/
│   │   ├── pricing.json                     # 既有（三级装载样板）
│   │   ├── routing-modes.json               # 既有
│   │   ├── features.json                    # 既有（最好的声明式配置样板）
│   │   ├── catalog.json                     # 新增：模型目录（不含窗口字段）
│   │   ├── claude-catalog.json              # 新增：Claude 型号目录
│   │   └── retired.json                     # 新增：Zen 已废弃模型账本（at 存 epoch ms）
│   ├── gateway/
│   │   └── kiro.json                        # 新增：KIRO region 端点 + 基线模型 + SOCIAL_REFRESH_URL
│   └── services/
│       └── ai-management.json               # 新增：aiManagementServer 13 组运维默认值
│
├── src/
│   ├── constants/                           # D3：env 可覆盖的默认值与 SSOT 常量（纯叶）
│   │   ├── serviceDefaults.js               # 既有 + 新增 ANTHROPIC_BASE_URL / OPENAI_BASE_URL / AI_PROXY_DEFAULT_PORT(+HOST)
│   │   ├── modelContextWindows.js           # 既有（窗口唯一真源）
│   │   ├── retryBudget.js                   # 既有（重试轮次上界 SSOT）
│   │   ├── prompts.js                       # 既有 3251 行 → 拆至 <2500 行，保留全部导出名
│   │   ├── commandSchema.js                 # 既有 2381 行 → 数据外置 + 3 函数改注入式
│   │   ├── aiManagementDefaults.js          # 新增：ai-management.json 的 getter 视图
│   │   ├── compressionDefaults.js           # 新增：contextCompressor 约 15 个阈值
│   │   ├── gatewayRetryBudget.js            # 新增：与 retryBudget 并列，注明口径差异
│   │   ├── toolLoopDefaults.js              # 新增：toolUseLoopCore env 默认值（一律 getter）
│   │   ├── layoutTokens.js                  # 新增：bootLayout 版面常数
│   │   ├── agentColors.js                   # 新增：AGENT_COLORS 单一真源
│   │   ├── effortPresets.js                 # 新增：EFFORT_PRESETS 四档
│   │   ├── modelCapabilities.js             # 新增：MODEL_CAPABILITIES + 加载期 post-pass
│   │   ├── selfProfileFormat.js             # 新增：纯叶拼接骨架（只吃字符串数组）
│   │   └── ...
│   │
│   ├── data/                                # D6：纯内容资产（零 require / 零 IO / 零 env）
│   │   ├── prompts/
│   │   │   ├── sections/*.md                # 新增：40+ 段提示词正文
│   │   │   ├── intentRules.json             # 新增：17 条正则 + 任务规模表 + 规则门
│   │   │   ├── small-model-templates.js     # 纯字面量 JS 数据模块
│   │   │   ├── tool-nudges.js
│   │   │   ├── memory-compact.js
│   │   │   └── plan-mode.js
│   │   ├── gateway/
│   │   │   ├── provider-presets.json        # 从 services/gateway/providerPresets.js 搬入
│   │   │   └── free-model-channels.json     # 从 services/freeModelChannels.js 搬入
│   │   ├── bugCases.json                    # 从 bugCases.js 拆出（原文件留 re-export 壳）
│   │   ├── blockedPathPolicy.json           # 从 cli/replSession.js:8183-8202 搬入（R2 执行面）
│   │   ├── apiProviderCatalog.json          # 从 cli/handlers/gateway.js:1445-1520 搬入
│   │   ├── backtestStrategies.json          # 从 cli/handlers/backtest.js:18-62 搬入
│   │   ├── configSchema.json                # 从 cli/handlers/config.js:22-70 搬入
│   │   ├── i18n/
│   │   │   └── prompt.{en,zh,ja,ko}.json    # 从 constants/promptLocales.js 搬入（脚本生成，禁手抄）
│   │   └── cliAnythingTemplates/            # 既有 —— 明确排除出 D6（脚手架代码）
│   │
│   ├── blueprints/                          # D6（既有 21 JSON）
│   ├── templates/                           # D6（既有 8 JSON + docstyles/）
│   ├── contracts/                           # D6（既有 12 文件 + 新增 models/catalog.schema.json）
│   ├── i18n/
│   │   ├── index.js                         # 归抽象层，移出 D6 roots
│   │   └── locales/                         # D6（既有 5 语言 + 增补 message 命名空间）
│   ├── cli/
│   │   ├── data/                            # D6（新增）
│   │   │   ├── aliases.json
│   │   │   ├── replTips.json
│   │   │   ├── stickers.json
│   │   │   ├── cleanupTargets.json
│   │   │   ├── ccTheme.json
│   │   │   └── layoutTokens.json
│   │   ├── themes/                          # D6（既有 8 主题 JSON）
│   │   ├── commands/
│   │   │   ├── registry.json                # 死数据：B0 删或显式登记待接线
│   │   │   └── registry.js                  # 既有（内联 JS 对象，非 JSON 加载器）
│   │   └── ...
│   ├── tools/
│   │   └── data/                            # D6（新增）：<toolId>.json 工具 schema + description
│   │
│   ├── dataAccess/                          # 唯一抽象层·接口层（新建 src 顶级目录）
│   │   ├── index.js                         # 门面：re-export 全部对外 API
│   │   ├── khy.module.json                  # entry-buffer 要求（lifecycle: staged）
│   │   ├── di/
│   │   │   ├── tokens.js                    # DI token 表（字符串 key，可序列化）
│   │   │   └── registry.js                  # register / resolve / createScope / resetForTest
│   │   ├── loaders/
│   │   │   ├── jsonRepository.js            # readdir+parse+fail-soft 单条隔离 + schema 校验 + mtime 热重载
│   │   │   └── dataCardLoader.js            # 命名装载器（loadModelPricing / loadRoutingModes / ...）
│   │   ├── configResolver.js                # 四层优先级 env → appHome → config/ → 默认
│   │   ├── schema.js                        # SchemaValidator
│   │   ├── contracts.js                     # ContractRegistry
│   │   ├── promptContent.js                 # PromptContentRepository
│   │   ├── paths.js                         # DataPathResolver（委托 utils/dataHome）
│   │   ├── i18n.js                          # I18nTranslator（包装 src/i18n/index.js）
│   │   └── repositories/                    # 按 domain 子域归属的仓储
│   │       ├── modelCapabilities.js
│   │       ├── alias.js
│   │       ├── strategy.js
│   │       ├── apiProviderCatalog.js
│   │       ├── blockedPathPolicy.js
│   │       ├── promptTemplate.js
│   │       ├── agentDefinition.js
│   │       ├── toolSchema.js
│   │       ├── uiCopy.js
│   │       ├── theme.js
│   │       ├── cleanupTargets.js
│   │       ├── configSchema.js
│   │       ├── publicApi.js
│   │       ├── curriculum.js
│   │       ├── searchEngine.js
│   │       ├── retiredModel.js
│   │       ├── modelCatalog.js
│   │       ├── routingMode.js
│   │       └── accountPool.js
│   │
│   ├── bootstrap/
│   │   ├── init.js                          # 组装层：DI 注册 + provider 第一顺位注册
│   │   ├── prefetch.js                      # 组装层：数据预热（避免 .md 读取落进 TUI <100ms 预算）
│   │   └── dataAccess.js                    # 新增：默认 file-backed provider 注册表
│   │
│   ├── models/                              # 既有 ORM 层（22 个 Sequelize model）
│   ├── utils/
│   │   ├── dataHome.js                      # B8 唯一正解（勿另写第三套）
│   │   ├── readJsonFileSafe.js              # JSON 读盘单点
│   │   └── flagRegistry/                    # 既有（4017 行 FLAGS 表）
│   ├── services/                            # D1/D2 逻辑层
│   └── ...
```

**依赖方向（单向，机械可判）**：

```
组装层 bootstrap/ ──┐
                    ├──> 逻辑层 services/ cli/ tools/ routes/ ...
                    │        │
                    │        ▼
                    │   抽象层 src/dataAccess/ ──> 数据层 src/data/ blueprints/ contracts/
                    │        │                       templates/ i18n/locales/ cli/themes/
                    │        │                       cli/data/ tools/data/ config/*.json
                    │        ▼
                    └──> 数据层（constants/ 纯叶例外：直接 import 是「零硬编码」的正解）

禁止：数据层 ──> 逻辑层 / 抽象层
禁止：抽象层 ──> 逻辑层
```

### 2.2 分层职责

| 层 | 域标签 | 职责 | 硬禁 |
|---|---|---|---|
| **数据层 D6** | D6（新建） | 纯内容与出厂默认值。四类载体分工：`constants/` = env 可覆盖默认值与 SSOT 常量；`src/data/` + `blueprints/` + `templates/` + `config/*.json` = 纯内容资产；`contracts/` = 数据契约 schema；`i18n/locales/` = 语言包 | 不得 require D1/D2/D4；不得含 IO；不得含 `process.env`（`constants/` 的 env 默认值是唯一例外，且必须是 `const X = process.env.Y \|\| 字面量` 的既有范式） |
| **抽象层·接口层** | D3（`src/dataAccess/` + `src/i18n/index.js` + `src/config/*.js`） | 数据契约与访问收敛点。路径解析（委托 `dataHome`）、IO 单点（`jsonRepository` + `dataCardLoader`）、DI token 与工厂注册表、按 domain 子域归属的 Repository/Loader（只做装载/归一/校验/缓存，失败策略各自声明）、配置 schema 装载、契约注册表 | 不得 require 逻辑层；不得含业务规则 |
| **逻辑层** | D1/D2 | 全部业务规则与编排 | 业务字面量表（模型目录/渠道/预设/别名）、URL 与端口字面量、SQL/DDL 字符串、`os.homedir()` 拼用户家路径、提示词正文与用户可见文案、`process.env.X \|\| 默认值` 成对书写、裸 `fs.readFileSync` 读数据资产 |
| **组装层** | D1 | 启动顺序、DI 注册、env 注入与「用哪个数据源」的裁决、提示词 provider 注册、数据预热。**全仓唯一允许把数据源实例化并交给逻辑层的地方** | 不得承载业务规则本身 |

### 2.3 环境配置与业务配置的区分

这是用户点名要求的第二项，也是本仓最含混的一处。裁定如下，**两类配置住在不同文件、走不同加载路径、由不同守卫校验**：

| | 环境配置（Environment） | 业务配置（Business） |
|---|---|---|
| 定义 | 随部署环境变化：数据库连接、API 密钥、端口绑定、数据家路径、外部服务端点 | 随产品策略变化：规则参数、阈值、预算、模型目录、渠道清单、提示词文案 |
| 载体 | `src/constants/serviceDefaults.js`（env 名 + 默认值 + `\|\|` 兜底）、`.env` 模板、`src/config/envDefaults.js`（新，声明式 env 台账） | `config/**/*.json`、`src/data/**`、`src/constants/*Defaults.js` |
| 加载路径 | 模块级 `const`（require 时求值，既有范式）或 `getter`（仅本次新增的少数 key） | `ConfigResolver` 四层优先级：env 内联 → `<appHome>/<file>` 运维覆盖 → `config/<file>` 出厂 → 代码兜底 |
| 热更新 | 不热更（改 env 需重启） | 可热更（`hotReload: 'mtime'` opt-in，默认 `'never'`） |
| 密钥边界（R2） | 真 key/token **只经 env 瞬时注入、绝不落盘**；出厂件仅允许 XOR 混淆形态 | 数据文件**零密钥**；`providerPresets` / `apiProviderCatalog` 的装载器必须过 `stripSecrets()`，schema 断言无值匹配 `/(sk-\|AKIA\|Bearer \|-----BEGIN)/` |
| 守卫 | `check-agent-rules.js` 的 `no-hardcoded-prod-domain`（白名单只含 `serviceDefaults.js` 系）+ 新增 `check-env-defaults.js` | `check-data-logic-separation.js` 的 denylist + `check-data-layer-purity.js` |

**明确不迁移**（回应透镜 1 的 `envInt` 陷阱）：形如 `Math.max(floor, parseInt(process.env.X \|\| 'd', 10) \|\| d)` 的站点**不批量迁到 `utils/envInt`**——现状在 `X='0'` 时因 0 falsy 回落默认值，而 `envInt` 返回 0 再 clamp 到 min，**只有 `min>=1` 时两者才等价**。`cli/handlers/gateway.js` 那 8 处必须逐处判定。

### 2.4 接口定义（仓储接口 / 数据 Schema / 配置 Schema / 加载器 API / DI token）

> 全部签名给在 `src/dataAccess/` 下。仓内风格：2 空格缩进、单引号、分号、camelCase、英文标识符与注释。

#### 2.4.1 DI token（`src/dataAccess/di/tokens.js`）

```js
// Single source of dependency-injection identifiers for the data layer.
// Keys are plain strings on purpose: guards enumerate them, and Symbol keys
// cannot be serialised into DOMAIN-DEPS.json / FEATURE-OWNERSHIP.json.
const TOKENS = Object.freeze({
  // path & IO primitives
  DATA_HOME: 'data.dataHome',
  JSON_REPOSITORY: 'data.jsonRepository',
  DATA_CARD_LOADER: 'data.dataCardLoader',
  CONFIG_RESOLVER: 'data.configResolver',
  SCHEMA_VALIDATOR: 'data.schemaValidator',
  CONTRACT_REGISTRY: 'data.contractRegistry',
  // repositories
  MODEL_CATALOG: 'repo.modelCatalog',
  ROUTING_MODES: 'repo.routingModes',
  RETIRED_MODELS: 'repo.retiredModels',
  SEARCH_ENGINES: 'repo.searchEngines',
  ACCOUNT_POOL: 'repo.accountPool',
  BUG_CASES: 'repo.bugCases',
  PUBLIC_APIS: 'repo.publicApis',
  PROVIDER_PRESETS: 'repo.providerPresets',
  PROMPT_STORE: 'repo.promptStore',
  PROMPT_INTENT_RULES: 'repo.promptIntentRules',
  MESSAGE_CATALOG: 'repo.messageCatalog',
  SELF_AWARENESS_PROVIDER: 'provider.selfAwareness',
  MODEL_CAPABILITIES: 'repo.modelCapabilities',
  ALIAS: 'repo.alias',
  STRATEGY: 'repo.strategy',
  API_PROVIDER_CATALOG: 'repo.apiProviderCatalog',
  BLOCKED_PATH_POLICY: 'repo.blockedPathPolicy',
  PROMPT_TEMPLATE: 'repo.promptTemplate',
  AGENT_DEFINITION: 'repo.agentDefinition',
  TOOL_SCHEMA: 'repo.toolSchema',
  UI_COPY: 'repo.uiCopy',
  THEME: 'repo.theme',
  CLEANUP_TARGETS: 'repo.cleanupTargets',
  CONFIG_SCHEMA: 'repo.configSchema',
  LAYOUT_TOKENS: 'repo.layoutTokens',
});

module.exports = { TOKENS };
```

#### 2.4.2 DI 注册表（`src/dataAccess/di/registry.js`）

```js
// Container-free DI: a module-level registry in the same style as utils/dataHome.
// Only seams whose data source is meant to be replaceable go through here; the
// default path stays a plain require so the refactor does not explode.
const _factories = new Map();

function register(token, factory) {
  if (typeof token !== 'string' || !token) {
    throw new TypeError('di.register: token must be a non-empty string');
  }
  if (typeof factory !== 'function') {
    throw new TypeError('di.register: factory must be a function');
  }
  _factories.set(token, factory);
}

// scope: Map<token, factory> overriding the process-wide defaults. Used by tests
// to swap in an in-memory data source without touching a single logic file.
function createScope(overrides) {
  const scoped = new Map(_factories);
  if (overrides) {
    for (const [token, factory] of overrides) {
      scoped.set(token, factory);
    }
  }
  return {
    has: (token) => scoped.has(token),
    resolve(token) {
      const factory = scoped.get(token);
      if (!factory) {
        throw new Error('di.resolve: no factory registered for token "' + token + '"');
      }
      return factory(this);
    },
  };
}

function resolve(token) {
  return createScope().resolve(token);
}

function resetForTest() {
  _factories.clear();
}

module.exports = { register, resolve, createScope, resetForTest };
```

#### 2.4.3 通用 JSON 仓储（`src/dataAccess/loaders/jsonRepository.js`）

```js
// Directory-shaped JSON repository. Semantics are copied byte-for-byte from
// services/domain/project/projectBlueprint/catalog.js: readdirSync -> parse ->
// skip a single malformed entry so one bad file never poisons the whole table.
const fs = require('fs');
const path = require('path');
const readJsonFileSafe = require('../../utils/readJsonFileSafe');

/**
 * @param {object} opts
 * @param {string} opts.dir        absolute directory holding the JSON files
 * @param {string} opts.idField    identity field, default 'id'
 * @param {object} [opts.schema]   optional shape contract, see schema.js
 * @param {'never'|'mtime'} [opts.hotReload]  'never' keeps today's permanent cache
 * @param {(raw: object, meta: { file: string }) => object} [opts.normalize]
 *        Loader metadata (file name / source) is attached to `meta`, never
 *        written back onto the data object — that is what catalog.js used to do
 *        with `obj._filename = file`, and it made "data" undifferentiable from
 *        loader residue.
 */
function createJsonRepository(opts) {
  const { dir, idField = 'id', schema = null, hotReload = 'never', normalize = null } = opts;
  let cache = null;
  let cacheStamp = 0;

  function loadAll() {
    if (cache && hotReload === 'never') return cache;
    if (cache && hotReload === 'mtime') {
      let stamp = 0;
      try { stamp = fs.statSync(dir).mtimeMs; } catch { /* dir gone */ }
      if (stamp === cacheStamp) return cache;
      cacheStamp = stamp;
    }
    const out = new Map();
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      cache = out;
      return out;
    }
    for (const file of names) {
      const raw = readJsonFileSafe(path.join(dir, file));
      if (!raw || typeof raw !== 'object') continue; // fail-soft, single entry
      if (schema && !validateEntry(schema, raw)) continue;
      const meta = { file };
      out.set(raw[idField], normalize ? normalize(raw, meta) : raw);
    }
    cache = out;
    return out;
  }

  return {
    list: () => Array.from(loadAll().values()),
    get: (id) => loadAll().get(id) || null,
    has: (id) => loadAll().has(id),
    entriesPath: () => dir,
    reload: () => { cache = null; cacheStamp = 0; return loadAll(); },
    resetCache: () => { cache = null; cacheStamp = 0; },
  };
}

module.exports = { createJsonRepository };
```

#### 2.4.4 命名数据卡装载器（`src/dataAccess/loaders/dataCardLoader.js`）

> **回应透镜 1 [medium] 与透镜 2 [medium]**：通用签名 `loadDataCard({ relPath, envJsonKeys, overrideCandidates })` 把文件布局泄漏给调用方，且无法复现三种互异的合并/失败语义（pricing 的 families 数组序、routingMode 的 per-mode 合并与零合并 env 分支、publicApis 的静默 `{apis:[]}`）。故 `loadDataCard` 降为**抽象层私有实现细节**，对逻辑层只暴露四个命名装载器，路径与覆盖候选全部住在函数体内。

```js
// Named data-card loaders. Each one owns its own merge strategy and failure
// policy, because the four existing loaders genuinely differ. The generic
// helper below is private to this module.
const path = require('path');
const fs = require('fs');
const { getAppHome } = require('../../utils/dataHome');
const readJsonFileSafe = require('../../utils/readJsonFileSafe');

function _readRepoCard(relPath) {
  return readJsonFileSafe(path.resolve(__dirname, '..', '..', '..', relPath));
}

// 1. model pricing — env inline > appHome override > repo file.
//    Merge: base.models shallow merge, base.families = [...overrides, ...base]
//    (override families first, matching modelPricing.js:230-240 exactly).
//    Failure: { families: [], models: {} } — never null, never throws.
function loadModelPricing(env = process.env) {
  const inline = env.KHY_MODEL_PRICING_JSON;
  if (inline) {
    try { return JSON.parse(inline); } catch { /* fall through */ }
  }
  const override = readJsonFileSafe(path.join(getAppHome(), 'model_pricing.json'));
  const base = _readRepoCard(path.join('config', 'models', 'pricing.json')) || {};
  if (!override) return base;
  return {
    ...base,
    models: { ...(base.models || {}), ...(override.models || {}) },
    families: [...(override.families || []), ...(base.families || [])],
  };
}

// 2. routing modes — env inline (returns as-is, zero merge) > appHome per-mode
//    merge > repo file > null. routingMode.js:636-667.
function loadRoutingModes(env = process.env) {
  const inline = env.KHY_ROUTING_MODES_JSON;
  if (inline) {
    try { return JSON.parse(inline); } catch { /* fall through */ }
  }
  const override = readJsonFileSafe(path.join(getAppHome(), 'routing_modes.json'));
  const base = _readRepoCard(path.join('config', 'models', 'routing-modes.json'));
  if (!base) return null;
  if (!override) return base;
  return { ...base, modes: { ...(base.modes || {}), ...(override.modes || {}) } };
}

// 3. public APIs — repo file only, on purpose.
//    REVIEW R-11: localBrainService.js:1201-1207 has no env key and no appHome
//    override today. Adding them here would silently ship a new feature, so this
//    loader deliberately does NOT register those layers.
function loadPublicApis() {
  return _readRepoCard(path.join('src', 'data', 'publicApis.json')) || { apis: [] };
}

// 4. search engines — appHome override, fail-soft to ''.
//    REVIEW R-10: webToolsService needs the resolved path back so it can show
//    "edit this file" guidance, hence configPath() alongside text().
function loadSearchEngines() {
  const p = path.join(getAppHome(), 'search_engines.json');
  let text = '';
  try {
    if (fs.existsSync(p)) text = fs.readFileSync(p, 'utf8');
  } catch { /* fail-soft, same as today */ }
  return { configPath: p, text };
}

module.exports = { loadModelPricing, loadRoutingModes, loadPublicApis, loadSearchEngines };
```

#### 2.4.5 配置解析器（`src/dataAccess/configResolver.js`）

```js
// Business-config resolver. Four-level priority:
//   env inline > <appHome>/<file> (operator override) > config/<file> (factory) > defaults
// Int / bool / json parsing lives here in one place, replacing the scattered
// process.env reads in prompts.js (37 sites) and serviceDefaults.js (133 sites).
const path = require('path');
const { getAppHome } = require('../utils/dataHome');
const readJsonFileSafe = require('../utils/readJsonFileSafe');

function _parse(raw, kind) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  switch (kind) {
    case 'int': {
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'num': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'bool': {
      if (/^(1|true|yes|on)$/i.test(String(raw))) return true;
      if (/^(0|false|no|off)$/i.test(String(raw))) return false;
      return undefined;
    }
    case 'json':
      try { return JSON.parse(raw); } catch { return undefined; }
    default:
      return String(raw);
  }
}

function createConfigResolver(spec) {
  const { key, envName, parse = 'string', defaults, homeFileName } = spec;
  const homePath = homeFileName ? path.join(getAppHome(), homeFileName) : null;

  function get(env = process.env) {
    if (envName) {
      const fromEnv = _parse(env[envName], parse);
      if (fromEnv !== undefined) return fromEnv;
    }
    if (homePath) {
      const fromHome = readJsonFileSafe(homePath);
      if (fromHome && fromHome[key] !== undefined) return fromHome[key];
    }
    const factory = readJsonFileSafe(
      path.resolve(__dirname, '..', '..', 'config', spec.file || (key + '.json'))
    );
    if (factory && factory[key] !== undefined) return factory[key];
    return defaults;
  }

  return {
    get,
    reload: () => get(process.env),
    source: (env = process.env) => (
      envName && _parse(env[envName], parse) !== undefined ? 'env'
        : (homePath && readJsonFileSafe(homePath)) ? 'appHome'
          : 'repo'
    ),
  };
}

module.exports = { createConfigResolver };
```

#### 2.4.6 数据 Schema（`src/contracts/models/catalog.schema.json`）

```jsonc
// Follows the existing <area>/*.schema.json layout. The "schemas/" layer proposed
// by one domain is cancelled — see adjudication B.
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "model-catalog",
  "type": "object",
  "required": ["models"],
  "properties": {
    "$schemaVersion": { "const": 1 },
    "_ssot_note": {
      "const": "contextWindow is NOT declared here. The single source of truth is src/constants/modelContextWindows.js; registerModel applies pinModelContextWindow unconditionally."
    },
    "models": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "name"],
        "properties": {
          "id": { "type": "string" },
          "name": { "type": "string" },
          "provider": { "type": "string" },
          "tier": { "type": "string" },
          "category": { "type": "string" },
          "maxTokens": { "type": "number" },
          "costPerToken": { "type": "number" },
          "capabilities": { "type": "array", "items": { "type": "string" } },
          "supportsVision": { "type": "boolean" },
          "supportsTools": { "type": "boolean" }
        },
        "additionalProperties": false
      }
    }
  },
  "additionalProperties": false
}
```

> `additionalProperties: false` 是**故意的**：任何试图把 `contextWindow` 写回 `catalog.json` 的 PR 会在 schema 校验处直接失败，而不是静默立起第三份窗口副本。

#### 2.4.7 配置 Schema（`config/services/ai-management.json`）

```jsonc
// Business config for aiManagementServer. Env-overridable defaults that used to
// sit at the top of a 3781-line service file. Default values are byte-identical
// to the current inline literals; every env name is preserved.
{
  "$schemaVersion": 1,
  "webhook": { "maxRetries": 3 },
  "session": { "idleMs": 1800000 },
  "auth": { "timeoutMs": 30000 },
  "gc": { "intervalMs": 30000 },
  "http": { "maxBodyBytes": 1048576 },
  "autoImport": {
    "intervalMs": 60000,
    "minIntervalMs": 15000,
    "accountProviders": ["kiro", "cursor", "trae", "warp", "nirvana"]
  },
  "circuitBreaker": { "backoffMs": [60, 300, 1800, 7200] },
  "rateLimit": { "windowMs": 60000, "max": 120 },
  "newModelCache": { "ttlMs": 30000 },
  "defaultPluginTemplate": "// plugin template source, verbatim from aiManagementServer.js",
  "staticContentTypes": { ".html": "text/html; charset=utf-8", ".js": "text/javascript" }
}
```

#### 2.4.8 仓储接口签名汇总

```js
// modelCatalog.js — window values are NEVER seeded here.
// REVIEW R-06: registerModel (services/models/index.js:36) unconditionally calls
// pinModelContextWindow, so 4 of the 10 seeded models have their effective
// contextWindow overwritten. Seeding must still go through registerModel.
const modelCatalog = {
  list: () => ModelRecord[],
  get: (id) => ModelRecord | null,
  register: (record) => ({ success: true, id }),  // still routes to registerModel
  // resolveWindow(id) deliberately absent: the single source of truth for
  // context windows is constants/modelContextWindows.js.
};

// retiredModel.js — REVIEW R-12: `at` is epoch milliseconds, not a date string,
// because TRANSIENT_TTL_MS arithmetic (zenRetiredModels.js:56) needs numbers.
const retiredModel = {
  isRetired: (id) => boolean,
  markRetired: (id, reason) => void,
  snapshot: () => Record<string, { reason: string, at: number }>,
};

// searchEngine.js — REVIEW R-10: configPath() is required by webToolsService.
const searchEngine = {
  text: () => string,
  configPath: () => string,   // for "edit this file" guidance
  getEngines: () => EngineRecord[],
  getParser: (id) => ParserRecord | null,
};

// providerPresets.js — R2: stripSecrets() runs on every return path.
const providerPresets = {
  list: () => PresetRecord[],
  get: (id) => PresetRecord | null,
  mergedWith: (envJson) => PresetRecord[],
  stripSecrets: (record) => PresetRecord,
};

// promptStore.js — prompts.js keeps all its existing export names; the store is
// only where the section bodies now live.
const promptStore = {
  getSection: (id, opts) => string,
  list: () => string[],
  registerSection: (id, fn) => void,
};

// messageCatalog.js — locale is pinned explicitly during migration.
const messageCatalog = {
  t: (key, params, { locale = 'zh-CN' } = {}) => string,
  has: (key) => boolean,
};

// blockedPathPolicy.js — R2 execution surface; predicate semantics replicated
// verbatim (the set holds both bare names and extensions).
const blockedPathPolicy = {
  isBlockedName: (name) => boolean,
  isBlockedExt: (ext) => boolean,
  isBlockedPath: (p) => boolean,
  blockedNames: () => readonly string[],
  blockedExts: () => readonly string[],
};

// modelCapabilities.js — REVIEW R-14: fixed order is load-bearing.
//   (1) require constants/modelContextWindows at module top
//   (2) backfill cap.context at module load time
//   (3) only then Object.freeze
// The object handed to setAiRequestAnalysisDeps must stay the SAME reference.
const modelCapabilities = {
  getEffortPresets: () => Readonly<EffortPreset>,
  getCapabilities: () => Readonly<Record<string, Capability>>,
  getLabel: (id) => string,
  getContextWindow: (id) => number,
};

// accountPool.js — SQL strings live in a pure data module (sql.js).
const accountPool = {
  ensureSchema: () => void,
  ensureColumn: (table, col, ddl) => void,
  upsertTokenRecord: (record) => void,
  listByPoolType: (poolType) => Row[],
  acquireLease: (opts) => Lease | null,
  releaseLease: (id) => void,
  getConfig: (key) => unknown,
  setConfig: (key, value) => void,
};
```

---

## 3. 重构代码：关键模块的重构后示例

> 以下 5 个示例按「最有代表性」挑选：覆盖数据文件形态、仓储接口、加载器、注入点、以及「替换数据源不改逻辑」的机械证明。
> 全部为**目标形态示意**，不是已落盘的代码。

### 3.1 数据文件形态 —— `src/data/gateway/provider-presets.json`

```jsonc
// 数据层：零 require、零 IO、零 process.env。可被任何外部工具独立编辑。
// 从 src/services/gateway/providerPresets.js:100-330 的 PROVIDER_PRESETS 原样搬入。
{
  "$schemaVersion": 1,
  "_note": "Keys and secrets are never stored here. stripSecrets() runs on every return path (R2).",
  "presets": [
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "baseUrl": "https://api.deepseek.com",
      "apiFormat": "openai",
      "authHeader": "Authorization",
      "defaultModel": "deepseek-chat",
      "links": {
        "home": "https://www.deepseek.com",
        "console": "https://platform.deepseek.com",
        "docs": "https://api-docs.deepseek.com"
      }
    }
  ]
}
```

### 3.2 仓储接口 —— `src/dataAccess/repositories/providerPresets.js`

```js
// 原 services/gateway/providerPresets.js 从「300 行数据表 + 装载逻辑」瘦身为薄装载器。
// getProviderPresets() / getPresets 的导出面与返回值形状一字不改。
const fs = require('fs');
const path = require('path');
const readJsonFileSafe = require('../../utils/readJsonFileSafe');
const { DEEPSEEK_BASE_URL } = require('../../constants/serviceDefaults');

const PRESETS_REL = path.join('src', 'data', 'gateway', 'provider-presets.json');
const SECRET_KEY_RE = /(sk-[A-Za-z0-9]|AKIA|Bearer\s|-----BEGIN)/;

// R2: a preset that ever carries a key/apiKey is a defect, not a feature.
function stripSecrets(record) {
  if (!record || typeof record !== 'object') return record;
  const out = { ...record };
  for (const k of Object.keys(out)) {
    if (/key|token|secret|password/i.test(k)) delete out[k];
  }
  return out;
}

function _loadRaw() {
  const inline = process.env.KHY_PROVIDER_PRESETS;
  if (inline) {
    try { return JSON.parse(inline); } catch { /* fall through to repo file */ }
  }
  return readJsonFileSafe(path.resolve(__dirname, '..', '..', '..', PRESETS_REL)) || { presets: [] };
}

function _merged() {
  const raw = _loadRaw();
  const byId = new Map(raw.presets.map((p) => [p.id, stripSecrets(p)]));
  // env override merges by id, exactly like the current implementation
  const override = readJsonFileSafe(path.join(
    require('../../utils/dataHome').getAppHome(), 'provider_presets.json'
  ));
  if (override && Array.isArray(override.presets)) {
    for (const p of override.presets) byId.set(p.id, stripSecrets(p));
  }
  return Array.from(byId.values());
}

function getProviderPresets() {
  return _merged().map((p) => ({
    ...p,
    // URL defaults come from the env-default SSOT, not from a second literal
    baseUrl: p.id === 'deepseek' ? DEEPSEEK_BASE_URL : p.baseUrl,
  }));
}

function getPresets() {
  return getProviderPresets();
}

// Guard: fails the build if a preset ever carries a secret-shaped value.
function assertNoSecrets() {
  for (const p of getProviderPresets()) {
    const text = JSON.stringify(p);
    if (SECRET_KEY_RE.test(text)) {
      throw new Error('providerPresets: secret-shaped value found in preset ' + p.id);
    }
  }
  return true;
}

module.exports = { getProviderPresets, getPresets, stripSecrets, assertNoSecrets };
```

### 3.3 加载器 + 纯数据 SQL 模块 —— `domain/account/accountPool/sql.js` 与仓储

```js
// src/services/domain/account/accountPool/sql.js
// 纯字符串数据模块：遵循 config/models/style_templates.js 的「只许写字面量」约定。
// 零 require、零 IO。动态 WHERE 的拼接结果必须字节不变（快照测试锁）。
module.exports = Object.freeze({
  DDL: Object.freeze({
    account_pool: 'CREATE TABLE IF NOT EXISTS account_pool (...)',
    account_leases: 'CREATE TABLE IF NOT EXISTS account_leases (...)',
    account_pool_active: 'CREATE TABLE IF NOT EXISTS account_pool_active (...)',
    account_pool_config: 'CREATE TABLE IF NOT EXISTS account_pool_config (...)',
  }),
  ALTERS: Object.freeze([
    "ALTER TABLE account_pool ADD COLUMN label TEXT",
  ]),
  SQL: Object.freeze({
    // The `norm` branch must produce a byte-identical string to today's
    // template拼接 in accountPool.js.
    selectIds: (norm) => `SELECT id FROM account_pool ${norm ? 'WHERE pool_type = :poolType' : ''}`,
    upsertToken: 'INSERT INTO account_pool (...) VALUES (...) ON CONFLICT(...) DO UPDATE SET ...',
  }),
});
```

```js
// src/dataAccess/repositories/accountPool.js
// 薄壳：只做装载/归一/校验/缓存。业务调度（租约策略、熔断）留在 accountPool.js 门面。
const SQL = require('../../services/domain/account/accountPool/sql');

function createAccountPoolRepository(db) {
  return {
    ensureSchema() {
      for (const ddl of Object.values(SQL.DDL)) db.exec(ddl);
      for (const alter of SQL.ALTERS) {
        try { db.exec(alter); } catch { /* column already present */ }
      }
    },
    ensureColumn(table, col, ddl) {
      try { db.exec(ddl); } catch { /* already present */ }
    },
    listByPoolType(poolType) {
      return db.prepare(SQL.SQL.selectIds(true)).all({ poolType });
    },
    upsertTokenRecord(record) {
      return db.prepare(SQL.SQL.upsertToken).run(record);
    },
    // ... acquireLease / releaseLease / getConfig / setConfig
  };
}

module.exports = { createAccountPoolRepository };
```

> **注意（回应风险条目）**：自建裸 SQL **保留**，不顺手改 Sequelize——那是对 `src/models/` 的大迁移，单独任务登记。本批只把「schema/SQL 字符串」与「查询编排」分层。

### 3.4 注入点 —— `src/bootstrap/init.js` 中注册 self-awareness provider

```js
// 组装层：唯一允许同时看见抽象层与数据层的地方。
// REVIEW R-02: the 9 truth formatters stay in services/. constants/ gets only a
// zero-dependency string-joiner, so the D3 -> D1 edge shrinks instead of moving.
const di = require('../dataAccess/di/registry');
const { TOKENS } = require('../dataAccess/di/tokens');
const { formatSelfAwareness } = require('../constants/selfProfileFormat');

// The 9 formatters live in services/ and are composed here, first in the boot
// order — before any system prompt is built.
function registerSelfAwarenessProvider() {
  const selfProfile = require('../services/selfProfile');
  const modelIdentityTruth = require('../services/modelIdentityTruth');
  const cacheMetricsTruth = require('../services/cacheMetricsTruth');
  const visionRoutingTruth = require('../services/visionRoutingTruth');
  const selfAuditRegistry = require('../services/selfAuditRegistry');
  const selfAuditVerifier = require('../services/selfAuditVerifier');
  const confidenceCalibration = require('../services/confidenceCalibration');
  const clueVault = require('../services/clueVault');
  const twentyXMode = require('../services/twentyXMode');
  const docVsMeasuredPolicy = require('../services/docVsMeasuredPolicy');

  di.register(TOKENS.SELF_AWARENESS_PROVIDER, () => (opts) => {
    const env = opts && opts.env ? opts.env : process.env;
    const parts = [];
    parts.push(modelIdentityTruth.format({ env }));
    parts.push(cacheMetricsTruth.formatMetricsDirective({ env }));
    parts.push(visionRoutingTruth.formatVisionDirective({ env }));
    parts.push(selfAuditRegistry.formatForSystemPrompt({
      env,
      verification: selfAuditVerifier.verify(),
    }));
    parts.push(confidenceCalibration.formatForSystemPrompt({ env }));
    if (typeof clueVault.formatForSystemPrompt === 'function') {
      parts.push(clueVault.formatForSystemPrompt({ env }));
    }
    parts.push(twentyXMode.describeTwentyXState(env));
    parts.push(docVsMeasuredPolicy.formatDisciplineForSystemPrompt({ env }));
    // pure-leaf join: no services require inside constants/
    return formatSelfAwareness(parts, { profile: selfProfile.getFullProfile(opts) });
  });
}

// Must run before any prompt construction. bin/khy.js cold-start path is covered
// by an "already registered" assertion test.
registerSelfAwarenessProvider();
```

### 3.5 「替换数据源不改一行逻辑」的机械证明 —— `src/dataAccess/__tests__/swap.test.js`

```js
// This is the acceptance criterion for "彻底解耦": swapping the data source must
// not require touching a single logic file. No monkey-patching of logic modules
// is used — only a DI scope.
const test = require('node:test');
const assert = require('node:assert');
const di = require('../di/registry');
const { TOKENS } = require('../di/tokens');
const { getProviderPresets } = require('../../services/gateway/providerPresets');
const providerPresetsRepo = require('../repositories/providerPresets');

const FILE_BACKED = () => providerPresetsRepo;

// An in-memory fixture. Same shape, different content.
const MEMORY_BACKED = () => ({
  list: () => [{ id: 'fixture', name: 'Fixture', baseUrl: 'https://fixture.invalid' }],
  get: (id) => (id === 'fixture' ? { id: 'fixture', name: 'Fixture' } : null),
  mergedWith: () => [{ id: 'fixture', name: 'Fixture', baseUrl: 'https://fixture.invalid' }],
  stripSecrets: (r) => r,
});

test('default scope resolves to the file-backed provider', () => {
  di.register(TOKENS.PROVIDER_PRESETS, FILE_BACKED);
  const repo = di.resolve(TOKENS.PROVIDER_PRESETS);
  assert.ok(repo.list().length > 0);
});

test('swapping the data source changes output without touching logic', () => {
  di.register(TOKENS.PROVIDER_PRESETS, FILE_BACKED);
  const scope = di.createScope(new Map([[TOKENS.PROVIDER_PRESETS, MEMORY_BACKED]]));
  const swapped = scope.resolve(TOKENS.PROVIDER_PRESETS);
  assert.deepStrictEqual(swapped.list(), [
    { id: 'fixture', name: 'Fixture', baseUrl: 'https://fixture.invalid' },
  ]);
  // The consumer below is the SAME function in both cases — proof that the
  // consumer depends on the interface, not on the file.
  const consume = (repo) => repo.list().map((p) => p.id);
  assert.notDeepStrictEqual(consume(di.resolve(TOKENS.PROVIDER_PRESETS)), consume(swapped));
  di.resetForTest();
});

test('no preset ever carries a secret-shaped value (R2)', () => {
  di.register(TOKENS.PROVIDER_PRESETS, FILE_BACKED);
  for (const p of di.resolve(TOKENS.PROVIDER_PRESETS).list()) {
    assert.doesNotMatch(JSON.stringify(p), /(sk-[A-Za-z0-9]|AKIA|Bearer\s|-----BEGIN)/);
  }
  di.resetForTest();
});
```

> **诚实标注**：此测试证明的是「**经 DI 接缝的仓储**可替换」。对于未接 DI 的耦合点（例如 `constants/prompts.js` 的 29 处反向 require、159 处 `OFF_VALUES`），该判据**不适用**——它们靠第 5 章的棘轮与 denylist 治理，不靠 DI。

---

## 4. 迁移策略

> **R1 声明（最高优先级）**：本方案只给路径与判据。**全部实施由人在自己的分支上逐批执行；AI 不自动 `commit` / `push` / `clean`。**
> 每一批都是独立可提交、独立可回滚的单元；批次之间允许 rebase，不堆叠。
> 任何涉及版本递增位（MINOR / MAJOR）的对外契约变化，须先问人（B7）。

### 批次总览

| 批次 | 名称 | 主要触点 | 行为风险 | 前置 |
|---|---|---|---|---|
| B0 | 前置与骨架 | `check-repo-layout` 3 error、`src/dataAccess/` 骨架、新守卫登记接线、`registry.json` 死数据 | none | — |
| B1 | R2 邻域与纯查表 | `blockedPathPolicy`、`effortPresets`、`modelCapabilities`、`agentColors`、`layoutTokens` | medium | B0 |
| B2 | 命令面数据 | `aliases.json`、`cleanupTargets.json`、`configSchema.json` + `check-config-schema-sync.js` | medium | B0 |
| B3 | 供应商与策略目录 | `apiProviderCatalog.json`、`backtestStrategies.json` | medium | B0 |
| B4 | prompts.js 拆 god-file + commandSchema 注入式 | `constants/prompts.js`、`constants/commandSchema.js`、19 个消费方 | **high** | B0 |
| B5 | 端点/端口 SSOT 补齐 | `serviceDefaults.js`、`_endpointResolver.js`、`proxyServer.js`、`aiManagementServer.js` | low | B0 |
| B6 | 目录数据外置 | `catalog.json`、`claude-catalog.json`、`kiro.json`、`provider-presets.json`、`free-model-channels.json`、`retired.json` | medium | B5 |
| B7 | 配置/阈值外置 | `ai-management.json`、`compressionDefaults`、`gatewayRetryBudget`、`toolLoopDefaults` | medium | B0 |
| B8 | 数据访问收敛 | `accountPool/sql.js`、`searchEngine`、`bugCases`、`routingMode`、`publicApi` | medium | B0 |
| B9 | B8 路径收敛（按子域） | `domain/data` → `network` → `config` → `extensions` → `catalog` → 其余；`a2aConfig.js` | medium | B8 |
| B10 | 文案层化 + i18n 接线 | `src/data/prompts/*`、`t()` 接入、`mobilePage`×2、`ccTheme.json` | medium | B4 |
| B11 | 契约 schema 归位 + 守卫升阶评估 | 49 个内联 schema、`acpTransport.js:25`、`plugin-loader` | low | B0 |

---

### B0 · 前置与骨架（零行为变更，纯新增）

**目标**：把「批次闸门」从红变绿；立抽象层骨架；让新守卫合法存在。

**改动清单**：
1. 清 `check-repo-layout.js` 现有 3 条 error：删 `.khy` / `.khyos` 影子目录（**先确认内容是否需要合并**——历史上 `heal-audit.jsonl` 与 `heal_escalation*.json` 曾只存在于影子树那一侧）、收容 `'` / `tmp-cmp` / `gem`；登记或删除 `gem` / `tmp-cmp` 两个未登记顶层目录。
2. 跑 `node scripts/ci/check-repo-layout.js`，确认 `src/dataAccess/` 作为新 `src/` 顶级目录是否被 `layer-registry` 接受。**不接受则先做 layout 治理修订（须人点头），或改用 `src/utils/dataAccess/` 替代形态**（见裁定 A）。
3. 建 `src/dataAccess/{index.js, khy.module.json, di/tokens.js, di/registry.js, loaders/jsonRepository.js}` + 同名同目录测试。**零消费方**。
4. 建 `scripts/ci/check-data-logic-separation.js`（规则：D6 反向依赖 / services 内 `os.homedir()` / services 内裸 `fs.readFileSync` 读 JSON / denylist 业务字面量 / services 内 `process.env.KHY_* || 默认值`；**基线棘轮模式起步**）。
5. **同批**把新守卫登记进 `FEATURE-OWNERSHIP.json rollout.mechanisms[]`（stage S1 + rollback 动作），并挂 `check:*` 别名或在 `wiring-exemptions.json` 登记 reason + until（TOOLING-005 / PROCESS-006）。
6. `DOMAIN-DEPS.json` 增加 D6 域（roots 见裁定 G；**排除** `src/data/cliAnythingTemplates/**`），`D1/D2/D3.mayDependOn` 增加 `D6`，`enforced` 增补 `d6-purity`。**改前改后各跑一次 `--list=domain-direction` 取读数对比**，确认不破 199。
7. `src/cli/commands/registry.json`：删，或显式登记「待接线」并写进 `khy.module.json`（删除前全仓 grep 含 `works/` 与 `delivery/`）。

**验证命令**：
```bash
node --check runtime/node/backend/src/dataAccess/index.js
node --check runtime/node/backend/src/dataAccess/di/tokens.js
node --check runtime/node/backend/src/dataAccess/di/registry.js
node --check runtime/node/backend/src/dataAccess/loaders/jsonRepository.js
cd runtime/node/backend && node --test src/dataAccess/*.test.js
node scripts/ci/check-repo-layout.js                     # 3 条 error 应清零；三项计数不得升于基线
node scripts/ci/check-repo-layout.js --list=domain-direction
node scripts/ci/check-wiring.js                          # 新守卫已接线或已登记豁免
node scripts/ci/check-rollout-stage.js
node scripts/ci/check-data-logic-separation.js           # 基线模式，0 error
node scripts/ci/check-change-safety.js --changed
node scripts/ci/check-agent-rules.js --changed
npm run arch:god --workspace runtime/node/backend
```

**回滚**：删除新增目录与脚本（零消费方）；`git checkout -- docs/10_规范/registry/DOMAIN-DEPS.json scripts/ci/repo-layout-baseline.json`（若动过基线）。

**向后兼容**：纯新增，无任何既有路径变动。

---

### B1 · R2 邻域与纯查表（最高安全优先级）

**目标**：先把 R2 执行面与两个 blocking 耦合点从逻辑层剥离。

**改动清单**：
1. `cli/replSession.js:8183-8202` `BLOCKED_NAMES`/`BLOCKED_EXTS` → `src/data/blockedPathPolicy.json` + `BlockedPathPolicyRepository`。**同批**在 `docs/10_规范/registry/RULES-REGISTRY.json` 登记为 `SECURITY-001` 的交互层执行面。
2. `cli/ai.js:86-91` `EFFORT_PRESETS` → `src/constants/effortPresets.js`（原样搬）。
3. `cli/ai.js:96-181` `MODEL_CAPABILITIES` + post-pass → `src/constants/modelCapabilities.js`（新模块顶部自行 require `modelContextWindows`，模块加载期完成回填，之后才 `Object.freeze`）。
4. `cli/sessionColor.js:19-20` + `src/agents/types.js:83` `AGENT_COLORS` → `src/constants/agentColors.js`（先 diff 断言两处字节相同）。
5. `cli/tui/bootLayout.js:33-56` 版面常数 → `src/constants/layoutTokens.js`；`logoArt.js` 与 `bootLayout.js` 同时改 require，删「刻意不同 require」的 `CLOVER_ROWS` 复制（先 grep 断言两者确为同值）。
6. `cli/ai.js` 与 `aiRequestAnalysis` 改经 `ModelCapabilitiesRepository` 取表；`setAiRequestAnalysisDeps` 的入参形状**与对象引用身份不变**。

**验证命令**：
```bash
<!-- IMPL-STATUS: todo -->
<!-- IMPL-DRIFT-AUDIT: 2026-10-18 · DOCS-005 范围补标，依据见下 -->
> **标记依据**：27 条路径可解析，但文中未自述已实现；保守标 todo 待人工复核。
# 迁移前捕获 fixture
node -e "const m=require('./runtime/node/backend/src/cli/ai.js');console.log(JSON.stringify(m.MODEL_CAPABILITIES))" > /tmp/fx-cap.json
node -e "const m=require('./runtime/node/backend/src/cli/ai.js');console.log(JSON.stringify(m.EFFORT_PRESETS))" > /tmp/fx-eff.json
# 重构后同命令 diff 必须为空
node --test runtime/node/backend/src/dataAccess/__tests__/blockedPathPolicy.test.js   # 25 条目 + 路径语料逐条同判
node --test runtime/node/backend/src/dataAccess/__tests__/modelCapabilities.test.js  # context 回填值不变
node --check runtime/node/backend/src/constants/modelCapabilities.js
cd runtime/node/backend && npx jest cli/ai modelContextWindows
node scripts/ci/check-change-safety.js --changed
node scripts/ci/check-agent-rules.js --changed
node scripts/ci/check-repo-layout.js
```

**回滚**：还原各 `from` 文件的数据常量段（单文件 `git checkout`）；仓储与 JSON 保留不构成破坏。

**向后兼容**：符号名不变；`ALIAS_MAP` 式公开导出全部保留（值为同值只读对象）。**B1 不冻结**——先用 grep 证明无 mutation 站点后，再单独一批加冻结（冻结 post-pass 目标会静默抛错）。

---

### B2 · 命令面数据

**改动清单**：`cli/aliases.js:20-797` → `src/cli/data/aliases.json` + `AliasRepository`（保留 `resolveAlias`/`getAliasesForCommand`/`getAllAliasKeys`/`ALIAS_MAP` 四导出）；`cli/handlers/clean.js` 清理白名单 → `src/cli/data/cleanupTargets.json` + `CleanupTargetsRepository`；`cli/handlers/config.js` → `src/data/configSchema.json` + `ConfigSchemaRepository`；新建 `scripts/ci/check-config-schema-sync.js`（机械校验与 `src/config/settingsWhitelist.js`、`cli/repl/khySettings.js` 三处一致）。

**验证命令**：
```bash
node --test runtime/node/backend/src/cli/__tests__/aliases.golden.test.js   # 全部别名键 union 的合并优先级不变
node --test runtime/node/backend/src/cli/handlers/__tests__/clean.targets.test.js  # targets() 深等 fixture
node scripts/ci/check-config-schema-sync.js
node --test runtime/node/backend/src/dataAccess/__tests__/swap.test.js
node --check runtime/node/backend/src/cli/aliases.js runtime/node/backend/src/cli/handlers/clean.js runtime/node/backend/src/cli/handlers/config.js
```

**回滚**：还原 `aliases.js` / `clean.js` / `config.js` 三文件；JSON 数据文件保留。

**向后兼容**：JSON 在 `aliases.js` **顶层同步加载**（与今天内联字面量同一时机）——这是防「自注册别名尚未登记导致优先级翻转」的关键。`clean.js` 的 `--repo/--tools/--runtime/--checkpoints` 分支逻辑原地不动。

---

### B3 · 供应商与策略目录

**改动清单**：`cli/handlers/gateway.js:1445-1520` → `src/data/apiProviderCatalog.json` + `ApiProviderCatalogRepository`；`cli/handlers/backtest.js:18-62` → `src/data/backtestStrategies.json` + `StrategyRepository`；`src/seeds/rebarStrategy.js` 的策略参数一并声明进仓储 manifest（**seed 的 DB `findOrCreate` 生命周期不动**）。

**验证命令**：
```bash
node --test runtime/node/backend/src/dataAccess/__tests__/strategy.test.js          # 三条 code 字符串 JSON 往返后 strictEqual
node --test runtime/node/backend/src/dataAccess/__tests__/apiProviderCatalog.test.js # 无值匹配 /(sk-|AKIA|Bearer |-----BEGIN)/
python scripts/check_builtin_keys.py                                                # R2 0 命中
node --check runtime/node/backend/src/cli/handlers/gateway.js runtime/node/backend/src/cli/handlers/backtest.js
cd runtime/node/backend && npx jest gatewayModelChoices gatewayRuntimeProbes backtest
```

**回滚**：还原 `gateway.js` / `backtest.js`。

**向后兼容**：`khy backtest --strategy <name>` 入参名不变；JSON 的键序与数组序与原对象字面量一致（`enumerateKnownModels` 的输出序依赖它）。

---

### B4 · `prompts.js` 拆 god-file + `commandSchema` 注入式（**风险最高批**）

**改动清单**（三个独立子批，每批独立提交、独立可回滚）：
- **B4a 纯文案分段**：40+ `getXxxSection()` 的模板字面量 → `src/data/prompts/sections/*.md`；`getXxxSection` 函数体字节保留，只把字面量换成 `promptStore.getSection(id)`。
- **B4b 意图规则表**：17 条正则 + `PROMPT_TASK_SCALE_RANK` + `MEDIUM/LARGE_TASK_GATE` + reason-key 映射 → `src/data/prompts/intentRules.json`；纯匹配函数迁 `src/dataAccess/promptIntent.js`。
- **B4c env 口径**：37 处 `process.env` 直读改经 `ConfigResolver`（env 名/默认值/解析方式原样迁入声明）。
- **B4d commandSchema 注入式**：约 2100 行数据表 → `src/data/commands/{router,slash,menu}.json`；3 个反向依赖函数改为「可注册 accessor」；`constants/commandSchema.js` 变薄，2381 → <400 行。**19 个消费方全部纳入**（8 个 services 侧 + 11 个 cli 侧），逐个改 require 路径或保持路径不变（注入式下 services 侧**零改动**）。

**验证命令**：
```bash
# B4a-c 唯一可接受的判据：固定入参矩阵下全文本逐字节不变
node --test runtime/node/backend/src/constants/__tests__/prompts.byteEquivalence.test.js
cd runtime/node/backend && npx jest prompts keyConfigExecute keyConfigGuidance unknownProblemHandler \
  closureProtocol planningDiscipline unifiedMigration systemPromptSectionCache systemPromptSplit systemPromptTier \
  makeSystemPromptShortContext commandSchema commandHelp
wc -l runtime/node/backend/src/constants/prompts.js     # 须 < 2500
wc -l runtime/node/backend/src/constants/commandSchema.js
npm run arch:god --workspace runtime/node/backend       # prompts.js 须移出 arch-debt-baseline.json 的 godFiles
node scripts/ci/check-copyright-readiness.js            # B6：系统提示词是登记材料，0 error
node scripts/ci/check-version-sync.js                   # R3 九源恒绿
node scripts/ci/check-repo-layout.js --list=domain-direction   # 计数只降不升
node scripts/ci/check-change-safety.js --changed
node scripts/ci/check-agent-rules.js --changed
```

**回滚**：按子批 `git checkout -- src/constants/prompts.js`（或 `commandSchema.js` 及当批新数据文件）。同名 re-export 保每批独立可退。

**向后兼容**：`prompts.js` 保留 60 个导出名与签名；memo 键与 cache boundary 逻辑字节不动。`commandSchema` 的 `getRouterCommandNames` / `getRouterSubCommands` 导出与签名保留，services 侧三个消费者的 require 路径一个字节不改。

> **若无法构造覆盖全部 section 组合的 golden 矩阵，B4a 降级为「只抽 engine、内容 getter 原地不动」**——这是本方案主动设置的安全阀，不是失败。

---

### B5 · 端点/端口 SSOT 补齐

**改动清单**：`serviceDefaults.js` 新增 `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`（**保留 `CLAUDE_API_ENDPOINT` / `OPENAI_API_ENDPOINT` 为主覆盖口**，见裁定 E）、`AI_PROXY_DEFAULT_PORT` / `AI_PROXY_DEFAULT_HOST`；`_endpointResolver.js`、`proxyServer.js`（5 处 9100）、`aiManagementServer.js`（2 处 9090）改 import。

**验证命令**：
```bash
node -e "深比较 resolveAdapterEndpoint 各 key 迁移前后值"
grep -rn "api.anthropic.com\|api.openai.com\|'9100'\|'9090'" runtime/node/backend/src/services   # 命中 0（白名单除外）
cd runtime/node/backend && npx jest extractEndpoint gatewayStatus aiBackendPortResilience proxyConfig
node --check runtime/node/backend/src/constants/serviceDefaults.js
```

**回滚**：`git checkout` 四个文件。

**向后兼容**：默认值逐字节相同，仅多一层 env 覆盖口；`resolveAdapterEndpoint` 签名不变。

---

### B6 · 目录数据外置

**改动清单**：`models/index.js:98-210` → `config/models/catalog.json`（**不含窗口字段**）+ `ModelCatalogRepository` + `src/contracts/models/catalog.schema.json`；`claudeAdapter.js:491-551` → `config/models/claude-catalog.json`；`kiroAdapter.js` → `config/gateway/kiro.json`（为 `SOCIAL_REFRESH_URL` 补 env 覆盖口）；`providerPresets.js` → `src/data/gateway/provider-presets.json`；`freeModelChannels.js` → `src/data/gateway/free-model-channels.json`（**与 `gateway/zhipuFreeModels.js` 的 7 模型清单当前逐字节一致**，权威源已由 `freeModelChannels.js:20` 注释裁定，合并时保留 `zhipuFreeModels` 的门控与 `augmentGlmPoolModels` 逻辑在 JS 侧）；`zenRetiredModels.js` → `config/models/retired.json`（**`at` 存 epoch 毫秒**）。

**验证命令**：
```bash
cd runtime/node/backend && npx jest models claudeAdapter kiro providerPreset freeModel zenRetired
node -e "迁移前后导出表 JSON.stringify（含键序）相等"
node --test runtime/node/backend/src/dataAccess/__tests__/catalog.crossCheck.test.js  # id 集合 vs constants/models.js 差集只缩
node --test runtime/node/backend/src/dataAccess/__tests__/retired.atType.test.js      # typeof at === 'number'
# 数据源替换实验：git diff --stat -- src/services 为空的前提下换 JSON，行为随数据变
git diff --stat -- runtime/node/backend/src/services
node scripts/ci/check-data-logic-separation.js
```

**回滚**：删除新增 JSON/schema；`git checkout` 对应 js 文件（数据与代码一对一回退）。

**向后兼容**：第一期 catalog 原样搬非窗口现值，**不清与 `modelContextWindows` 的漂移**（漂移清理单独任务，避免顺手重构）；导出面不变。

---

### B7 · 配置/阈值外置

**改动清单**：`aiManagementServer.js:21-85` 13 组 → `config/services/ai-management.json` + `constants/aiManagementDefaults.js`；`contextCompressor.js` 约 15 阈值 → `constants/compressionDefaults.js`；`aiGatewayGenerateMethod.js` 重试预算 → `constants/gatewayRetryBudget.js`（**不合并两套预算**，只把默认值收敛，注释写明口径差异）；`toolUseLoopCore.js` 约 60 处 env → `constants/toolLoopDefaults.js`（**一律导出 getter 而非模块级常量**；按 nudge / verify / closure 族分小批，每批一族）。

**验证命令**：
```bash
cd runtime/node/backend && npx jest contextCompressor aiManagement aiGatewayGenerate toolUseLoop
node -e "不设 env 时配置对象与阈值逐一相等（深比较）"
# env 覆盖实验：设 KHY_* 后取值变化、不设时不变（证明 getter 仍调用时求值）
node --test runtime/node/backend/src/services/tool/*.test.js
# 求值时机回归：grep 出所有在 require 之后写 process.env 的测试，逐个确认
grep -rn "process.env.KHY_" runtime/node/backend/src/services/tool/*.test.js | head -40
```

**回滚**：`git checkout` 对应文件；删除新增常量模块。

**向后兼容**：数值与 env 名逐一相同；`pluginTemplate` 的转义用深比较测试锁。

---

### B8 · 数据访问收敛

**改动清单**：`accountPool.js` DDL/SQL → `domain/account/accountPool/sql.js`（纯字符串）+ `AccountPoolRepository` 薄壳；`webSearchService.js` + `webToolsService.js` 两份读取合一为 `SearchEngineRepository`（**含 `configPath()`**）；`bugCases.js` 拆为 `src/data/bugCases.json` + `bugCaseRepository.js`（原文件留 re-export 壳）；`routingMode.js` / `localBrainService.js` 换命名装载器（**不新增 env/appHome 层**）。

**验证命令**：
```bash
cd runtime/node/backend && npx jest accountPool bugCases learn
# 复跑 accountPool 子域 README 记载的显式路径 102 例
node --test runtime/node/backend/src/services/modelPricing.test.js runtime/node/backend/src/services/gateway/routingMode.test.js
node --test runtime/node/backend/src/dataAccess/__tests__/sql.snapshot.test.js   # selectIds 的 norm 真/假两分支字节相等
node scripts/ci/check-repo-layout.js
node scripts/ci/check-change-safety.js --changed
node scripts/ci/check-agent-rules.js --changed
```

**回滚**：`git checkout` 对应 js；删除新增 json/`sql.js`（**先删壳再删数据，顺序不可反**）。

**向后兼容**：`src/data/bugCases.js` 保留同名 re-export 壳转调仓储（弃用期一个版本），`cli/handlers/learn.js:498,972` 与 `learningCurriculum.js:24` 零改动。

---

### B9 · B8 路径收敛（一批只做一个子域）

**改动清单**：按 `domain/data` → `domain/network` → `domain/config` → `domain/extensions` → `domain/catalog` → 其余的顺序，把 `os.homedir()` 拼路径改走 `utils/dataHome`；外加 `src/config/a2aConfig.js:64` 残留 cwd 兜底；`domain/data/data/DataLocation.js`（README 自陈零消费者）删除或挂弃用壳。

**验证命令**：
```bash
grep -rn "os.homedir()" runtime/node/backend/src/services/domain/<sub>       # 命中 0
cd runtime/node/backend && npx jest <子域相关>
node scripts/ci/check-repo-layout.js
cd runtime/node/backend && node bin/khy.js --version                          # 真实启动一次
khy doctor                                                                    # 对比数据家路径与迁移前一致
node scripts/ci/check-change-safety.js --changed
node scripts/ci/check-agent-rules.js --changed
```

**回滚**：`git checkout -- runtime/node/backend/src/services/domain/<sub>`（一批一子域，回退面可控）。

**向后兼容**：解析结果在已 established 的机器上应同值（这正是 B8 目的）；系统盘保护 / pinned pointer 语义下**新盘场景会改路径**——每批必须真实启动 + `khy doctor`，新装/移动盘场景人工确认。

---

### B10 · 文案层化 + i18n 接线

**改动清单**：四个提示词数据模块搬 `src/data/prompts/`（`small-model-templates` / `tool-nudges` / `memory-compact` / `plan-mode`，留 re-export 壳）；services 用户可见文案分批接 `t()`（**locale 显式锁 `zh-CN`**，key 的 zh 文案 = 现字面量）；`webRemoteControl/mobilePage.js` 与 `bridge/mobilePage.js` **各自**把文案归位（不合并模板）；`ccTheme.js` 色板下沉 `src/cli/data/ccTheme.json`；`toolUseLoopCore.js` 两处 edit-failure hint 的漂移**只登记不统一**（单独任务、人点头）。

**验证命令**：
```bash
cd runtime/node/backend && npx jest prompt nudge planMode compact
node --test runtime/node/backend/src/i18n/__tests__/parity.test.js            # zh/en 双向 key 集合相等
node --test runtime/node/backend/src/dataAccess/__tests__/mobilePageCopy.test.js  # 渲染整页 HTML strictEqual
node --test runtime/node/backend/src/dataAccess/__tests__/theme.test.js
node scripts/ci/check-tui-gates.js                                            # 仓库根执行（勿用 backend cwd）
node scripts/ci/check-copyright-readiness.js                                  # 0 error；受影响截图重拍
node scripts/ci/check-data-logic-separation.js                                # 中文字面量计数项只降不升
node scripts/ci/check-change-safety.js --changed
node scripts/ci/check-agent-rules.js --changed
```

**回滚**：`git checkout` 对应 services 文件；删除 `src/data/prompts/` 新文件（**壳文件最后删**）。

**向后兼容**：原路径全部保留同名 re-export 壳（弃用期），require 路径不变；字面量逐字节搬运。**locale 锁不满足则 B10 整体回退。**

---

### B11 · 契约 schema 归位 + 守卫升阶评估

**改动清单**：49 个内联 JSON Schema 分批迁 `src/contracts/<area>/*.schema.json`（顺序：metaPlan → contentSchema → mcp types）；`acpTransport.js:25` lazy require 改顶层静态（消除幽灵依赖）；`plugin-loader/index.js:60-76` 的内联副本改从契约注册表取；`check-data-logic-separation.js` **不自动转硬闸**——采集足够样本后由人决定升阶，白名单清零或每条带 `TODO(#task)` + 到期日。

**验证命令**：
```bash
cd runtime/node/backend && npx jest acp contracts metaplan contentSchema toolPool
node scripts/ci/check-repo-layout.js                                          # 三项计数均不升
node scripts/ci/check-change-safety.js --changed
node scripts/ci/check-agent-rules.js --changed
node scripts/ci/check-gov-rules.js
node scripts/ci/check-copyright-readiness.js
node scripts/ci/check-version-sync.js
npm run arch:god --workspace runtime/node/backend
khy doctor
cd runtime/node/backend && npm run test:all
```

**回滚**：`git checkout` 对应文件；守卫改回基线模式（恢复 `BASELINE_IDS` 计数与 `--warn` 形态）。

**向后兼容**：schema 内容原样搬；静态 require 需确认无循环。

---

## 5. 验证标准

### 5.1 可机械判定的分离彻底性判据（J-01 … J-14）

> 每条都给命令。**J-01 ~ J-06 是硬判据（红灯即未完成）；J-07 ~ J-14 是棘轮判据（只降不升）。**

| ID | 判据 | 命令 | 现状基线 | 目标 |
|---|---|---|---|---|
| **J-01** | 反向依赖归零（D3 不得反向 require D1/D2/D4/D5） | `node scripts/ci/check-repo-layout.js --list=domain-direction` | **195**（`d3-purity` 36 + `d2-no-reach-into-d1` 156 + `no-reach-into-archive` 3）；`prompts.js` 22 条目、`commandSchema.js` 4 条目 | 单调下降；`prompts.js` 的 22 条目应有明确归零计划（**除裁定 C 登记的 1 条 allowlist**） |
| **J-02** | D6 数据层纯度：数据文件不得 require 逻辑层 | `node scripts/ci/check-repo-layout.js --list=domain-direction`（D6 建域后自动覆盖 D1/D2/D4/D5 目标） | 未建域 | 0。**不另写第二套 grep**——手写模式只匹配 `services/` 会漏 `src/cli` 与 `src/routes`，给出假绿（透镜 3 [medium]） |
| **J-03** | 逻辑层 grep 不到业务字面量 | `node scripts/ci/check-data-logic-separation.js`（denylist：`api.anthropic.com` \| `api.openai.com` \| `api.deepseek.com` \| `'9100'` \| `'9090'` \| `'gpt-4o'` \| `CREATE TABLE` \| `SELECT .* FROM account_pool` \| `'.khyquant'` \| `'.khy'` \| NIRVANA 邮箱） | 待建 | 白名单外 0 命中；白名单只降不升且每条带 `// TODO(#task)` + 到期日 |
| **J-04** | 路径单点：逻辑层不得 `os.homedir()` 拼用户家 | `grep -rnE "os\\.homedir\\(\\)" runtime/node/backend/src/services` | `src/services/domain/` 105 处/39 文件；`path.join(os.homedir())` 48 处/13 文件；真正拼 `.khyquant`/`.khy` 5 处；`src/services/` 全量 281、`src` 全量 417 | 白名单只降不升、每条带理由与到期日（**不宣称「白名单为空」**——透镜 3 已证该判据当前不可达） |
| **J-05** | env 默认值单一真源 | `grep -rnE "process\\.env\\.KHY_[A-Z_]+ *\\|\\|" runtime/node/backend/src/services` | 约 60 处（`toolUseLoopCore`）+ 13 组（`aiManagementServer`）+ 8 处（`cli/handlers/gateway.js`） | 新增 0；存量只降不升 |
| **J-06** | SQL 不在逻辑层 | `grep -rn "CREATE TABLE\|ALTER TABLE\|SELECT .* FROM" runtime/node/backend/src/services --include=*.js` | `accountPool.js` 4 DDL + ALTER + 约 25 CRUD | 只命中 `domain/account/accountPool/sql.js`（纯字符串数据模块）与 `src/models` ORM 定义 |
| **J-07** | **补充判据（补 domain-direction 的盲区）**：`constants/` 与 `utils/` 的 require 指定符必须落在已登记 roots 内 | `grep -rn "require('\.\./" runtime/node/backend/src/constants/prompts.js \| grep -vE "tools\|memdir\|skills"` | `prompts.js` 有 8 处打向 `src/tools`、`src/memdir`、`src/skills`——这些目录**不在 `DOMAIN-DEPS.json` 任何域的 roots 里**，J-01 对它们完全失明 | 0。**在此之前，「反向依赖归零」的结论不可信**（透镜 3 [high]） |
| **J-08** | 归属不成形：每个新增文件带 `khy.module.json` + 同名同目录测试 | `node scripts/ci/check-repo-layout.js` | `functional-unit` **263**（baseline 290）、`entry-buffer` **2470**（baseline 2470） | 两项**不升** |
| **J-09** | 数据源可替换（核心判据） | `node --test runtime/node/backend/src/dataAccess/__tests__/swap.test.js` | 不存在 | 绿。判据：`git diff --stat -- runtime/node/backend/src/services` 为空的前提下，替换 JSON 或设 env 覆盖，运行时行为随数据而变（观测点：`khy models list` 输出、`GET /api/user-gateway/provider-presets` 输出、路由档位列表） |
| **J-10** | 数据文件独立可编辑 | `node -e "JSON.parse(require('fs').readFileSync('<file>','utf8'))"` + `node scripts/ci/check-data-logic-separation.js --schemas` | — | 每个新数据文件通过；`src/contracts/**` 可被独立 JSON Schema 校验器跑（无需起后端） |
| **J-11** | 行为等价（每批必跑） | 见各批 verify | — | 关键纯函数迁移前后字节相同：`buildSystemPrompt` / `resolvePrice` / `resolveAdapterEndpoint` / `accountPool` SQL 拼接 / 配置对象深比较。对照模块用 `git show HEAD:` 在真实目录内编译取得 |
| **J-12** | R4 与巨石 | `npm run arch:god --workspace runtime/node/backend` | `prompts.js` 3251、`commandSchema.js` 2381、`toolUseLoopCore` 10605、`aiGatewayGenerateMethod` 6864、`aiManagementServer` 3781、`claudeAdapter` 3504 | 无新增超 2500 行文件；`prompts.js` 拆后 < 2500 并移出 `arch-debt-baseline.json` 的 `godFiles`；既有巨石行数只降不升 |
| **J-13** | R2 密钥不泄露 | `python scripts/check_builtin_keys.py` + `node scripts/ci/check-data-logic-separation.js` | 干净 | 0 命中；新数据文件无值匹配 `/(sk-\|AKIA\|Bearer \|-----BEGIN)/`；`blockedPathPolicy` 25 条目 golden 测试绿 |
| **J-14** | 前端/交付层端口与文案棘轮 | `node scripts/ci/check-frontend-tokens.js`（既有范式）+ 新增端口字面量规则 | `cli/` 4630 行中文、159 处 `OFF_VALUES` | 只减不增；**新增逻辑层文件必须 0 命中** |

### 5.2 每批必跑门禁（回应透镜 3 的系统性缺口）

> 四域原设计的 S1–S7 / B1–B7 都不跑 `check-change-safety` 与 `check-agent-rules`，违规累积到最后才暴露。**本方案把三守卫下沉到每一个批次。**

```bash
# 每一批（B1..B11）都必须跑，成本近零（pr-gate.yml 本就按 commit 跑）
node scripts/ci/check-change-safety.js --changed     # 三守卫之一
node scripts/ci/check-agent-rules.js --changed       # 三守卫之二
node scripts/ci/check-repo-layout.js                 # 三守卫之三：层级/根目录/索引/任务入口
node scripts/ci/check-gov-rules.js                   # 治理总纲十板块 + 规则登记表
npm run arch:god --workspace runtime/node/backend    # 改动文件不得新增超限
```

**B4（拆 `prompts.js`）与 B10（改用户可见文案）额外必跑**：

```bash
node scripts/ci/check-copyright-readiness.js         # B6 软著就绪，0 error；受影响 evidence/03_图片/ 截图重拍
node scripts/ci/check-version-sync.js                # R3 九源恒绿（本方案零版本 bump）
```

**触及 `runtime/node/backend/**` 的前端批次（F-域批次 3 等）额外必跑**：三守卫 + `npm run arch:god --workspace runtime/node/backend` + `khy doctor`。

**CC TUI 相关批次（B1/B10）**：`node scripts/ci/check-tui-gates.js` —— **从仓库根执行**，勿用 backend cwd（该脚本只定义在根 `package.json:99`）。

**收口（B11）**：上述全部 + `cd runtime/node/backend && npm run test:all` + `khy doctor`。

### 5.3 明确不承诺的部分（诚实标注）

1. **「逻辑层 grep 不到业务字面量」不可能 100% 达成**：面向用户的中文文案（`ElMessage` 提示、错误文案）天然是数据但散布在视图里；`AIChat.vue` 5584 行、`Trading.vue` 4981 行内的文案抽干需按视图逐个迁移，工程量远超本方案批次。现实目标是**「只减不增」的 baseline 门禁**，不是归零。
2. **R4 的 2500 行门在本域部分失效**：`archDebtScan.js` 的 `BACKEND_ROOT` 写死，`delivery/` 与 `apps/` 的 `Trading.vue`（4981 行）、`AIChat.vue`（5584 行）在管辖外。本方案对这两个文件只做数据外置、不做拆分；**「所有改动文件 `wc -l` ≤ 2500」不是本方案的判据**（那会被自己的 move 违反）。
3. **「彻底解耦」是多年的棘轮方向，不是本方案的交付物**。本方案的诚实交付物是：一个唯一抽象层 + 一份数据层纯度守卫 + 一套 baseline 棘轮 + 高严重度耦合点的抽样迁移 + 每批可机械验证的行为等价判据。
4. **159 处 `OFF_VALUES` 不迁移**（唯一主动放弃「彻底」的点）：大爆炸统一 159 处 = 静默行为变更（`flagRegistry` 文件头明确记录「统一词表会给某些 flag 悄悄加/减关闭词」）。改为把 `OFF_WORDS` 抽到纯叶 + `archDebtScan` 新增「新文件不得出现 `const OFF_VALUES = [`」的 trend gate（基线化，只拦新增）。
5. **`cli/commands/registry.json` 与 `flagRegistry` 的 JSON 化不塞进本方案**：后者改变 require 时序与对象引用身份，且是被频繁修改的 god-file，冲突概率高，单独立项。

---

## 附录 A · 三透镜复核 finding 的逐条回应

>  verdict 均为 needs-rework。下表覆盖全部 blocking 与 high finding，以及影响设计决策的 medium/low。

| # | 透镜 / 严重度 | Finding 摘要 | 回应 | 落点 |
|---|---|---|---|---|
| A1 | L1 blocking / L2 high / L3 high | 四域对 `prompts.js` 给三个互斥终态，各建一套自称唯一的抽象层 | **采纳并改设计**。收敛为唯一抽象层 `src/dataAccess/` + 唯一终态「抽 engine 到逻辑层 + 内容留数据层」 | 裁定 A/B |
| A2 | L1 blocking / L2 blocking | `selfProfileFormat`「纯叶」不可实现（9 处 lazy require） | **采纳并改设计**。只抽纯叶拼接骨架；9 个格式器留 services、组装层注册组合 provider；`prompts.js:18` 一条边登记 allowlist；**不宣称 constants 零 D1 依赖** | 裁定 C、3.4 |
| A3 | L1 high / L2 blocking | `commandSchema` 消费方漏 3 个 services 文件（1 崩 2 静默退化）；19 个消费者中 8 个在 services | **采纳并改设计**。改**注入式**而非搬迁式；19 个文件逐一列名纳入 B4d；services 侧零改动 | 裁定 D、B4d |
| A4 | L1 high | `ENDPOINT_SSOT` 会静默废弃 `CLAUDE_API_ENDPOINT` / `OPENAI_API_ENDPOINT`，并改求值时机 | **采纳并改设计**。保留既有 env 名作主覆盖口 + 新增 `KHY_` 别名；**不全局改 getter**，明确记录求值时机事实 | 裁定 E、B5 |
| A5 | L1 high / L2 low / L3 medium | `ModelCatalogRepository` 丢 `pinModelContextWindow` 覆写；schema「缺失兜底」是错述 | **采纳并改设计**。catalog 不搬窗口字段 + schema `additionalProperties:false` 禁手写 + seed 仍走 `registerModel` + 4 条覆写值断言测试；错述已删 | 裁定 F、2.4.6、B6 |
| A6 | L1 high / L3 high | domain-direction 对未登记域（`src/tools`/`memdir`/`skills`）失明，`prompts.js` 8 处 require 打向它们 ⇒ 假绿 | **采纳并改设计**。补 grep 型补充判据 J-07；「补登记为域」标为须人点头的治理动作 | 裁定 O、J-07 |
| A7 | L1 medium | 基线数字全部偏高；现仓已有 3 条 error，「0 error」门当前不可达 | **采纳并改设计**。按实测 195/263/2470 重写；3 条 error 列为 B0 前置 | 裁定 O、B0 |
| A8 | L1 medium / L2 medium | 通用 `DATA_CARD_LOADER` 无法复现三种互异合并/失败语义；签名把文件布局泄漏给调用方 | **采纳并改设计**。降为抽象层私有细节；对逻辑层只暴露四个命名装载器，各自持有合并策略与失败回落 | 2.4.4 |
| A9 | L1 medium | `SearchEngineRepository` 缺 `configPath()`；两份「重复读取」返回形状不同 | **采纳并改设计**。补 `text()` + `configPath()` | 2.4.8、B8 |
| A10 | L1 medium | publicApis 经 DATA_CARD_LOADER 会静默新增 env/appHome 覆盖层 = 加功能 | **采纳并改设计**。`loadPublicApis()` 明确 repo-only，注释说明为何不注册那两层 | 2.4.4 |
| A11 | L1 medium | `zenRetiredModels` 的 `at` 字段类型陷阱 | **采纳并改设计**。`retired.json` 存 epoch 毫秒 + `typeof at === 'number'` 守卫测试 | 裁定 F、B6 |
| A12 | L1 medium | `frontendRuntimeContract` 的 identityPath 值与实际跨进程契约不符 | **采纳并改设计**。改为 `/khy-frontend-identity.json`，并加跨文件一致性测试 | 1.4 #3 |
| A13 | L1 medium | `modelCapabilities` 抽取的冻结时机与对象引用身份未钉死 | **采纳并改设计**。写入固定顺序（require → 回填 → freeze）与「同一对象身份」断言 | 2.4.8、B1 |
| A14 | L1 medium | `webRemoteControl` COPY 的「真源」本身是第三份未校验副本 | **采纳并改设计**。搬之前先 diff；不一致则降级为「只搬不动 zcode-analysis」，并先建 `check-i18n-fidelity` 守卫 | B10 |
| A15 | L1 medium | `promptLocales` 外置 JSON 有键序依赖（`tBlock` 行序、`supportedLocales` 语序） | **采纳并改设计**。JSON 必须脚本机械生成（禁手抄）+ 顺序敏感测试 | B10 |
| A16 | L1 medium | `modelContextWindows` 外置 JSON 会丢 `Object.freeze` 身份，且处于 `cli/ai.js` 加载期关键路径 | **采纳并改设计**。装载器必须 require 时同步填充 + freeze 一次 + 「不经 bootstrap 直接 `resolveModelContextWindow('gpt-4o') === 128000`」测试 | B1 |
| A17 | L1 medium | F-域批次 6 verify 未执行 live-config 字节比对（agentWriters 是 R2 辖区） | **采纳并改设计**。提为批次 6 必跑项 | B8（本文 B8/B9 之外单列 F-域批次 6 要求） |
| A18 | L1 medium | `built_in_keys.dart` 的「拆前二进制快照」不可执行（仓库内已消毒为空）；批次 7 相对路径多上跳两级 | **采纳并改设计**。字节等价判据改为「对本机经 `scripts/gen_keys.py` 生成的 blob 做拆前/拆后比对」；路径改为 `../../../scripts/check_builtin_keys.py`；评估 0 字节 `.bin` 是否值得新增 asset 加载路径 | F-域批次 7 |
| A19 | L1 low | `settingsStore` 的 DEFAULTS 首次变成非模块级字面量，默认值装载时点被引入写路径 | **采纳并改设计**。保持 `getSettingsStore` 为唯一 await 点 + 「合并后键集合 == 旧 DEFAULTS 键集合」断言 | F-域批次 6 |
| A20 | L1 low | `freeModelChannels` 与 `zhipuFreeModels` 的 7 模型清单**不存在漂移**，「只登记不统一、等人裁定」是不必要的阻塞 | **采纳并删除错述**。清单当前逐字节一致，权威源已由 `freeModelChannels.js:20` 注释裁定；合并时保留 `zhipuFreeModels` 的门控与 augment 逻辑在 JS 侧 | 1.1 #15、B6 |
| A21 | L2 high | `cli/commands/registry.js` 不是「JSON + 惰性加载器」，`registry.json` 是死数据 ⇒ 范式依据落空 | **采纳并改设计**。降级该「样板」；范式依据改为 `catalog.js` / `learningCurriculum.js` / `utils/dataHome.js`；`registry.json` B0 删或登记待接线 | 1.5、裁定 N、B0 |
| A22 | L2 high | D6 纯度前提对自己声明的 roots 不成立（`src/i18n/index.js` 带 IO；`src/data` 模板含 require）；D6 vs D3 矛盾；`D1.mayDependOn` 无 D6 | **采纳并改设计**。D6 roots 收窄；`src/i18n/index.js` 移出 D6；`constants` 留 D3 并在 `_note` 说明；D6 加进 D1/D2/D3 的 `mayDependOn` | 裁定 G、B0 |
| A23 | L2 medium | 两个域各建 env 声明载体（`envDeclarations.json`+`envSchema.js` vs `envDefaults.js`）⇒ 两份平行真源 | **采纳并改设计**。只建 `src/config/envDefaults.js` | 裁定 I |
| A24 | L2 medium | `zhipuFreeModels.js` 路径错一位（在 `gateway/` 下） | **采纳并修正**。已在 1.1 #15 与 B6 使用正确路径；测试路径 `tests/services/gateway/zhipuFreeModels.test.js` 一并列入 verify | 1.1 #15 |
| A25 | L2 low | 两份 i18n 键数差 1 的开放问题已有确定答案 | **采纳并关闭**。差异键唯一：`workspaceSidebar.showFileTree`，仅存在于 zcode-analysis 版 ⇒ 以 zcode-analysis 为真源时**补键进 renderer 版**（键名指向真实 UI 元素，缺它说明副本漏搬），守卫设「键集合严格相等」不留差集白名单。补键属用户可见文案变化，按 B6 重拍受影响截图 | F-域批次 6 |
| A26 | L3 high | S0 把 `src/data` 列入 D6 roots + enforced `d6-purity` ⇒ `cliAnythingTemplates/node_skeleton/index.js:36,50` 打向 `src/cli` ⇒ domain-direction 破基线 ⇒ S0 自己 verify 上线即红 | **采纳并改设计**。D6 roots 显式排除 `src/data/cliAnythingTemplates/**`；改 DOMAIN-DEPS 前后各跑一次取读数对比 | 裁定 G、B0 |
| A27 | L3 medium | S0 的手写 grep 纯度判据只查 `services/`，漏 `src/cli`/`src/routes` ⇒ 假绿 | **采纳并改设计**。判据改用门禁本体 `check-repo-layout.js --list=domain-direction`，不另写第二套 grep | J-02 |
| A28 | L3 medium | `src/i18n/index.js` 是纯逻辑模块却在 D6 roots 内 ⇒「数据层零 IO」从第一天起是假话 | **采纳并改设计**。D6 root 收紧为 `src/i18n/locales`；`index.js` 归抽象层 | 裁定 G |
| A29 | L3 medium ×3 | 约 6 个新 `scripts/ci` 检查器无一接线（TOOLING-005）无一登记 rollout（PROCESS-006 PP-1/PP-3）；S8 还要「转硬闸」 | **采纳并改设计**。B0 增加「登记 + 接线」子步骤；「转硬闸」改为「由人决定升阶」 | 裁定 H、B0/B11 |
| A30 | L3 medium | S1–S7 不跑 `check-change-safety` / `check-agent-rules`，违规累积到 S8 才暴露 | **采纳并改设计**。三守卫下沉到每一批 | 5.2 |
| A31 | L3 medium | S6 的 B8 处数与文件数大幅不符实（实测 105/39 vs 48/13 vs 5） | **采纳并修正**。按真实清单裁批；「白名单为空」改为「只降不升 + 带理由与到期日」 | 1.1 #17、J-04 |
| A32 | L3 medium | `catalog.json` 脱离 `check-model-hardcoding` 扫描面（`TEXT_EXTS` 只扫 `.js/.cjs/.mjs`），新 schema 只校验形状不校验取值 | **采纳并改设计**。补与 `constants/models.js` 的交叉一致性测试，**不改 `TEXT_EXTS`**（改守卫扫描面须人点头） | 裁定 F、B6 |
| A33 | L3 medium | `check-data-layer-purity.js` 上线即报存量违规（`cliAnythingTemplates`、`bugCases.js`） | **采纳并改设计**。纯度规则限定为 `src/data/**/*.json` + 显式 JS 数据模块清单；`cliAnythingTemplates/` 单列为脚手架代码并给排除理由 | 裁定 G、J-02 |
| A34 | L3 low | `npm run check:tui-gates` 在 backend 目录下不存在（只定义在根 `package.json:99`） | **采纳并修正**。改写为仓库根相对命令 | 裁定 K、5.2 |
| A35 | L3 medium | data-config-layer S10 漏 `check-version-sync`（R3 九源）与 `check-copyright-readiness`（B6） | **采纳并修正**。B4/B10/B11 均补这两条 | 5.2 |
| A36 | L3 medium | 从未覆盖 `entry-buffer`(2470) 与 `functional-unit`(290) 两条基线棘轮 | **采纳并修正**。写入每一步 verify | 5.1 J-08 |
| A37 | L3 low | `src/config` 层归属三处口径不一 | **采纳并改设计**。`*.json` 入数据层、`*.js` 入抽象层；`src/config` 整体不进 D6 roots | 裁定 I |
| A38 | L3 high | F-域批次 0 rollback 处方无作用域 `git clean`（工作区 50 个 untracked），会毁他人在制品；且全套批次未提 R1 | **采纳并改设计**。rollback 一律改显式路径清单；批次 0 补 R1 声明 | 第 4 章 R1 声明 |
| A39 | L3 medium | F-域批次 3 改后端却只跑前端门禁；10 个批次无 `arch:god` 与 `khy doctor` | **采纳并修正**。凡触及 `runtime/node/backend/**` 的批次补三守卫 + `arch:god` + `khy doctor` | 5.2 |
| A40 | L3 medium | R4 判据「所有改动文件 ≤ 2500 行」被自己的 move 违反（Trading.vue 4981、AIChat.vue 5584） | **采纳并修正**。判据改为 `arch:god` 口径 + 「触及的既有 godFiles 行数只降不升」；前端两巨石单列「数据外置后行数下降量」指标 | J-12、5.3 |
| A41 | L3 medium | 桌面端 `diTokens` 被自己的 risk 判为不成立（跨进程注册表互不可见），却仍作验证判据 | **部分采纳**。桌面端 DI token **降级为「文档约定」**，`verificationCriteria` 中的桌面端部分改述为「`backendModuleMap` 路径表可替换 + 加载期 sentinel 校验」这类可真做的判据 | 5.3 |
| A42 | L3 low | F-域全套 10 批次无一提及 R1 | **采纳并修正**。第 4 章开头统一声明 | 第 4 章 R1 声明 |
| A43 | L3 medium（确认无问题） | R2 三处处理成立（providerPresets 剥 key、`built_in_keys.dart` 仍在 XOR 混淆形态、blockedPathPolicy 升格 SECURITY-001 执行面）；R3 九源无设计触碰 | **确认保留**。`check_builtin_keys.py` 的 `iter_source_files` 会 `os.walk` 整个 CLIENT 树覆盖新位置；本方案零版本 bump | B3、B6、5.1 J-13 |

---

## 附录 B · 不确定处与风险登记

> 诚实标注。每条给出缓解与「何时必须停下来问人」。

| ID | 风险 / 不确定 | 缓解 | 升级条件 |
|---|---|---|---|
| R-01 | **「行为等价」与两处已登记高危缺陷直接冲突**：`candidateDetect.js:184` 的 NIRVANA 私人邮箱默认值、`credentialHelpers.js:55` 的 `PROVIDER_ALIASES` 原型键守卫。修它们就是改行为 | 重构批次里**只登记不修**（子域 README 的 KNOWN-DEFECT 已钉 30 处）；修复单独提交、单独说明行为变更、等人点头 | 任何一批想「顺手修掉」时 |
| R-02 | `prompts.js` 解环的注册时机是最大单点行为风险：provider 未注册时 self-awareness 段变 null，system prompt 内容随之变化（CLAUDE.md 明令 Legacy 逐字节不变） | 组装层 `bootstrap.init` 第一顺位注册 + 每条 provider 写「已注册」断言测试 + 覆盖 `bin/khy.js` 冷启动路径；任一条不满足就回退 B4 | 断言测试无法覆盖冷启动路径时 |
| R-03 | **求值时机陷阱**：约 60 处 env 是调用时求值，提为模块级常量会让测试静默失效（绿但错） | `constants/toolLoopDefaults.js` 一律导出 getter；迁移时先 grep 出所有在 require 之后写 `process.env` 的测试逐个确认 | 出现无法确认的测试时 |
| R-04 | B8 路径收敛可能改数据家：`established-wins` / `pinned pointer` / 系统盘保护语义下，原 homedir 字面量在部分机器（U 盘、多盘、新盘）会解析到不同目录 | 一批一子域、每批真实启动 + `khy doctor` 对比数据家路径；已 established 的存量机器应同值；新装/移动盘场景人工确认 | 任何一批 `khy doctor` 显示数据家路径变化时 |
| R-05 | i18n locale 检测会把中文文案变英文 = 行为变更 | message catalog 与 UI locale 显式分离（迁移期一律传 `locale:'zh-CN'`）；各语言翻译补齐后再放开 | 该条不满足则 B10 整体回退 |
| R-06 | **`src/dataAccess/` 作为新 `src/` 顶级目录可能被 `layer-registry` 拒绝**，而 layout 治理修订须人点头，会阻塞 B0 | B0 第一步先跑 `check-repo-layout.js` 确认；替代形态为 `src/utils/dataAccess/` + 把 D6 加进 D3 的 `mayDependOn` | 两个形态都不可行时 |
| R-07 | **DOMAIN-DEPS.json 是判据真源，改错即假绿/假红**。D6 的 roots/mayDependOn/enforced 若写错（例如把 `src/config` 纳入 D6——它 require `utils/` 与 `@khy/shared`，会污染纯度判据），domain-direction 的可度整体下降 | 改前跑一次拿基线、改后立刻复跑对比计数；`src/config` 归属单独裁定，本期不进 D6 | 改后读数上升即回滚 DOMAIN-DEPS.json |
| R-08 | **`check-repo-layout.js` 现仓已有 3 条 error**（`root-shadow-dir` / `root-junk` / `layer-registry`），不清则每批都红，无法作为批次闸门 | 列为 B0 前置；`.khy`/`.khyos` 清理前先确认内容是否需要合并（历史上 heal-audit 只存在于影子树一侧） | B0 无法在合理代价内清零时 |
| R-09 | **`prompts.js` 的 golden 矩阵可能构造不出来**（40+ section 组合） | 主动安全阀：B4a 降级为「只抽 engine、内容 getter 原地不动」 | 矩阵覆盖不足时 |
| R-10 | **快照对比测试的基建缺口**：本仓测试以行为级为主，「迁移前后字节相同」的对照测试（`git show HEAD:` 编译旧模块）在 Windows 大小写不敏感盘与长路径下要额外小心；且 `src` 套件约 56 秒，每批全跑会显著拉长迭代 | 按接缝挑最小测试集 + 每批至少一次 `test:all` | 对照测试在 Windows 上不稳定时 |
| R-11 | **god-file 现实工作量**：`toolUseLoopCore` 10605 行、`aiGatewayGenerateMethod` 6864 行、`aiManagementServer` 3781 行都是基线巨石，其上的数据抽取每批都要重跑慢测试（`aiManagement*` spawn 真进程） | 按「一族 env / 一族阈值」小批次进，禁止大爆炸 PR；任一批超过 6 轮自循环即停下来重新裁批（B2 上限） | 单批超过 6 轮自循环时 |
| R-12 | **守卫改造成本与「为过守卫而加白名单」的腐化**：白名单机制本身成为新的维护面与第二真源 | 白名单必须带 `// TODO(#task)` 与到期日、守卫输出白名单清单供人 review、白名单数量本身纳入只降不升棘轮 | 白名单数量上升时 |
| R-13 | **`flagRegistry` 4017 行 / 224 消费方的 JSON 化**：改变 require 时序与对象引用身份（测试可能依赖引用相等/freeze 身份），且该文件被频繁修改、god-file 拆分冲突概率高 | **不塞进本方案**，单独立项；先加派生视图 parity 测试钉住再动结构 | — |
| R-14 | **F-域「跨包契约文件」有一个未被验证的假设**：后端构建期愿意多产出一份 JSON 到 `delivery/` 下。这会在 backend 构建流程里加一步，属 backend 辖区改动，超出本域授权 | 前端 loader 设计为「契约文件优先、缺失回落内置默认」，契约未上线前零风险；若后端侧不接，该批次白做但不变更现状 | 后端侧明确不接时 |
| R-15 | **两份 345KB i18n 资产的覆盖方向**：键数差 1（`workspaceSidebar.showFileTree` 仅存在于 zcode-analysis 版），直接让一方覆盖另一方会造成 1 个键的丢失或新增，而 B6 软著登记材料的界面截图依赖这批文案 | 以 zcode-analysis 为真源时**补键进 renderer 版**（该键名指向真实 UI 元素，缺它说明副本漏搬而非真源多余）；守卫设「键集合严格相等」不留差集白名单；补键属用户可见文案变化，按 B6 重拍受影响截图 | 补键会影响既有截图时 |
| R-16 | **移动端 `builtin_tools.dart` 拆分后**，Dart 的 tree-shaking 与 `pubspec.yaml` 的 assets 声明要同步改；漏改会在运行期才抛 asset-not-found，而 Flutter 侧没有 `node --check` 级别的快速反馈 | 每批跑 `flutter analyze` + `flutter test`；批次周期最长，排在最后 | — |
| R-17 | **`built_in_keys.dart` 的 0 字节 `.bin`**：仓库内字节数组已消毒为空，「拆前二进制快照」无物可比；新增一条 asset 加载路径可能不值得 | 字节等价判据改为「对本机经 `scripts/gen_keys.py` 生成的 blob 做拆前/拆后比对」；评估是否改为「仅当文件非空才加载」的既有门 | 0 字节资产被证明仍需单独加载路径时 |
| R-18 | **端口字面量扫描会大量误报**：WS URL 模板、示例文本、注释、测试 fixtures 里到处都是端口；`check-agent-rules.js` 现有三类豁免不足以覆盖 | 新规则以独立规则 id 落地 + 设计周全的白名单；否则一上线就红、被迫 `--write` 刷基线，门禁形虚设 | 白名单规模超过预期时 |
| R-19 | **`delivery/extension` 与 `delivery/mobile` 测绘覆盖较弱**，可能有第五份端口/路径副本；端口扫描规则覆盖到它们时会出现计划外工作量 | B0 先做一次全量扫描定量，再裁是否纳入本方案 | 扫描发现计划外耦合点时 |
| R-20 | **`constants/gitCoAuthorTrailer.js` 的红线冲突**：默认尾注 `'Co-Authored-By: khy <noreply@khy-os.local>'` 可绕过 `check-commit-message.js` 的 `AI_NAMES` 词表 | **本重构明确不碰它**；单列交人裁定后再处理。若顺手外置成 JSON 等于把红线冲突藏进数据文件 | 任何时候（与人裁定前不动） |
| R-21 | **模型窗口双真源**：`models/index.js` 内联 `contextWindow` 与 `constants/modelContextWindows.js` 已漂移。若 catalog 直接改以 constants 为 SSOT，有效窗口值会变（识图/上下文预算行为随之变） | 第一期 catalog 不搬窗口字段；漂移清理作为独立任务；若确需保留现值兜底，先跑一次全量 diff 把漂移清单作为数据写进 catalog.json 的注释字段，而不是静默二选一 | 漂移清理立项时 |
| R-22 | **热重载的静默失败模式**：运营改 JSON 语法错误时 fail-soft 会用旧缓存或空表——「保存即生效」变「保存即静默」 | 本批默认 `hotReload: 'never'` 保行为等价；mtime 模式作 env 门控 opt-in 并配 reload 失败显式日志，不默认开 | 有人要求默认开启热重载时 |
| R-23 | **JSON 化中文多行文本的 review 噪音**：`config/models/style_templates.js` 用 JS 存中文多行文案是有意识决策，强改 JSON 会让每次文案修订的 diff/审阅成本上升 | **保留纯字面量 JS 数据模块形态**，只靠 purity 守卫（零 require/零 IO/零 env）约束，不强求格式统一 | — |
| R-24 | **无 DI 容器下的「DI」只是模块级注册表**：测试隔离靠 `resetForTest` 纪律，jest 并行/顺序执行可能出现跨文件状态泄漏 flake | 注册表 API 强制每个测试文件 `afterEach` 重置，并写进 jest setup | 出现 flake 时 |
| R-25 | **R3 与打包面**：新增数据清单/manifest 类文件若被 `works/ship/modules/modules.json` 或 npm `files` 收进包，可能触碰 G1 四源一致性守卫 | 新增文件前对照 `scripts/ci/check-version-sync.js` 的 specs 数组确认不进 9 源；数据文件不声明版本号 | 任何批次碰了版本轨道文件时 |
| R-26 | **`delivery/web/ai-frontend` 根有 5 个 `vite.config.js.timestamp-*.mjs` 备份、`src/` 下有 2 个零字节垃圾文件**（名字是 shell 重定向事故残留） | 不构成耦合，但会让任何「扫 src/ 找硬编码」的守卫误报；建议在 F-域批次 0 去噪（删除前 grep 确认无 import） | — |

---

## 结语：本方案不承诺什么

1. 不承诺「彻底解耦」在一次或一年内完成。**139 个耦合点中，本方案的批次只覆盖其中约 60 个高/中严重度点**；其余靠 J-01 ~ J-14 的棘轮多年治理。
2. 不承诺「逻辑层零业务字面量」。中文文案天然是数据但散布在视图里，现实目标是只减不增。
3. 不承诺「constants/ 变成零依赖纯叶」。`prompts.js` 的 29 处反向 require 中，至少 1 条（`selfProfile`）被明确登记为去不掉的边。
4. 不承诺零行为变更。每一批都有 golden / 深比较 / 快照判据，但**判据覆盖不到的组合就是风险**（R-09）。
5. **本方案不自动执行任何一步。** 全部实施由人在分支上逐批提交；AI 只产出补丁（R1）。

---

*文档类型：DESIGN-ARCH 设计方案。定稿日：2026-10-13。上游输入：四域测绘/设计 + 三透镜复核（behavioral equivalence / dependency direction / red-line compliance）。*
