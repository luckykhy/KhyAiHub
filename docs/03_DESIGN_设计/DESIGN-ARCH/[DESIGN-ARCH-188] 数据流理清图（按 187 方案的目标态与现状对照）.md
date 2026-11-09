<!-- IMPL-STATUS: todo -->
<!-- IMPL-DRIFT-AUDIT: 2026-10-18 · DOCS-005 范围补标，依据见下 -->
> **标记依据**：30 条路径可解析，但文中未自述已实现；保守标 todo 待人工复核。
# [DESIGN-ARCH-188] 数据流理清图（按 187 方案的目标态与现状对照）

> 类型：**测绘产物（survey map）**，不是已执行的改动。
> 本图定稿时，仓库中**没有任何一个文件因本图被修改**（未 Edit / 未 Write / 未 git 写操作）。
> 全部证据来自只读 Grep / Glob / Read / 只读 Bash，以及对
> `[DESIGN-ARCH-187] 数据与逻辑解耦重构方案.md` 的只读阅读。
>
> **本图是什么**：一张「**187 方案规定的目标态** vs **今日工作树现状**」的**对照图**。
> 现状栏（各流域「现状流」边表）全部可复现到 `file:line`；目标态栏全部引自 187 方案条文
> （§2.1 目录 / §2.2 四层硬禁 / §2.4.x 接口与优先级 / §2.0 裁定 A–O / §4 批次 B0–B11）。
> 两栏之差 = §3 各流域的「差异点表」。
>
> **本图不是什么**：不是改动清单，不是已排期的工单，不是「将要做什么」的承诺。
> 图中每一条差异点都只是「现状与目标的差」的登记；实施与否、何时实施，属 187 方案批次计划，
> 不属本图。凡本图给出「建议」「须裁定」处，均为测绘者的判断输入，**不构成授权**。

**规模总览**：5 流域 × 201 条现状边 × 98 条差异点 × 73 份真源登记 × 51 条未核实项；
双透镜 14 条 finding 全部逐条回应（§4.4）；透镜补边 4 条（§3.6）。

| 项 | 数 |
|---|---|
| 现状边（五流域） | 201（模型 44 / 供应商与渠道 28 / 提示词与命令面 59 / 文案与界面 30 / 持久化与配置 40） |
| 透镜补边 | 4（OFF_VALUES / search_engines.json 双读 / 18 特征 schema / AGENT_COLORS） |
| 差异点（五流域） | 98（16 / 20 / 20 / 22 / 20），另透镜补 4 |
| 真源登记 | 73 |
| 未核实项 | 51 |
| 双透镜 finding | 14（透镜一 6 + 透镜二 8），全部回应 |

---

## 1. 读图说明

### 1.1 三种栏位，别混读

| 栏位 | 含义 | 可复现性 |
|---|---|---|
| **现状流**（§3 各卡「现状流」） | 今日工作树真实存在的边，每条带 `file:line` 与 violates 判定 | 只读 Grep/Read 可复现 |
| **目标流**（§3 各卡「目标流」） | 187 方案条文规定的目标态，逐条引自方案章节号 | 引自方案文本，不可在仓库复现（文件尚不存在） |
| **差异点表**（§3 各卡末） | 现状与目标的差，带批次落点（B0–B11 / 裁定 X）与风险级 | 差异本身可复现；目标侧引自方案 |

### 1.2 层标签（依 187 方案 §2.2 四层）

| 标签 | 层 | 物理范围（今日） | 硬禁（摘要） |
|---|---|---|---|
| **D6** | 数据层 | 目标态：`src/data/`、`src/blueprints/`、`src/templates/`、`src/contracts/`、`src/i18n/locales/`、`config/**/*.json`、`src/cli/themes/`、`src/cli/data/`、`src/tools/data/`；**例外**：`constants/` 的 env 可覆盖默认值（须为 `const X = process.env.Y \|\| 字面量` 既有范式） | 不得 require D1/D2/D4；不得含 IO；不得含 process.env（constants 例外除外） |
| **D3** | 抽象层 | 目标态：`src/dataAccess/`（di / loaders / configResolver / schema / contracts / paths / repositories）+ `src/i18n/index.js` + `src/config/*.js` | 不得 require 逻辑层；不得含业务规则；IO 单点（jsonRepository + dataCardLoader） |
| **D1 / D2** | 逻辑层 | `src/cli/`、`src/services/`（含 `domain/` 子树）、`src/tools/`、`src/routes/` 等 | 禁业务字面量表（模型目录/渠道/预设/别名）、URL 与端口字面量、SQL/DDL 串、`os.homedir()` 拼用户家路径、提示词正文与用户可见文案、`process.env.X \|\| 默认值` 成对书写、裸 `fs.readFileSync` 读数据资产 |
| **组装层** | assembly | 目标态：`bootstrap/init.js` 唯一实例化点（+ `bootstrap/dataAccess.js` provider 注册表） | 全仓唯一允许把数据源实例化并交给逻辑层的地方；不得承载业务规则本身 |

> **注意「数据层」概念在本仓是分裂的**（187 方案裁定 G 原话）：默认值住在 D3（`constants/`），
> 内容住在 D6（`src/data/`）。本图凡标 `D6-purity`，指的是「按方案 §2.1 的字面目录归属判 D6」的边。

### 1.3 边的机制枚举（mechanism）

| 机制 | 含义 |
|---|---|
| `require` | 静态 `require()` 依赖（模块加载期建立） |
| `re-export` | 经中间模块转手导出，物理生产者与消费者不直接相连 |
| `function-call` | 函数/方法调用（含惰性 require 后调用、依赖注入 setter 注入） |
| `inline-literal` | 数据以对象/数组/字符串字面量形式内联在代码文件中，无独立资产文件 |
| `env-read` | 读 `process.env.*` |
| `json-parse` | 消费方对 JSON 资产做 parse |
| `readFileSync` | 裸 fs 读（本图用该标签涵盖 `readFileSync` 与 `statSync` 家族，详见各边 note 的实际计数） |
| `homedir-path` | `os.homedir()` / 用户家目录字面量拼路径 |
| `process-spawn` | `child_process` 派生子进程 |
| `sql-query` | 裸 SQL / DDL 字符串 |

> **透镜一更正（L1-4）**：原报告把「异步 fire-and-forget」与「被调方内部读盘」分别错标为
> `process-spawn` 与 `readFileSync`。本图已改判为 `function-call`，并在 note 中说明真实机制；
> enum 不新增 `async-fire-and-forget` 一类（全流域仅 1 例，单独分类的收益低于混淆成本）。

### 1.4 violates 标记枚举

| 标记 | 含义 | 判据来源 |
|---|---|---|
| `none` | 未检出违反（含 D3→D3、D1→D3 等合法方向） | 方案 §2.2 |
| `D1-no-literal` | 逻辑层持有业务字面量数据（表/URL/端口/SQL/env 默认值成对书写） | 方案 §2.2 逻辑层硬禁 |
| `D6-purity` | 数据层/ nominally 纯叶模块违反「零 require D1/D2、零 IO、零 process.env」 | 方案 §2.2 D6 硬禁 |
| `D3-no-logic` | 抽象层反向 require 逻辑层 | 方案 §2.2 抽象层硬禁 |
| `assembly-only-instantiation` | 组装层之外实例化数据源 | 方案 §2.2 组装层条款 |

> violates 是**单边判定**，不是整文件判决；同一文件的不同边可有不同标记（例：`cli/ai.js` 的
> 边多为 `D1-no-literal`，而其 `modelCapabilityPort` 注册边为 `none`）。

### 1.5 其他符号

| 符号 | 含义 |
|---|---|
| `driftRisk: single-source / duplicate / contested / unknown` | 真源清单列。`duplicate` = 存在第二份副本；`contested` = 两份以上在争真源地位；`unknown` = 真源地位无法从静态阅读判定 |
| 风险级 `blocking / high / medium / low` | 差异点表列。`blocking` = 按方案字面实施会产生错误结果或违反方案自身硬禁，须先裁定 |
| `※L1-n` / `※L2-n` | 双透镜 finding 的裁定标记，进入本图的方式见 §4.4 逐条回应表 |
| `【补边】` | §3.6 透镜补边，非原五流域追踪所有 |
| 边号 `F1-E12` | 流域 1 第 12 条边，供 §4.4 引用 |

### 1.6 读数口径与工作树状态声明

1. **工作树状态**：所有行号与计数读自当前 git 工作树（分支 `chore/hygiene-20261010`，
   存在大量未提交修改）。187 方案撰写时的提交可能与今日不同；**B4 等批次开工前应在干净树上重测**。
2. **grep 范围声明**：本图所有「零消费者 / 零命中」结论，除特别说明外，**grep 范围为
   `runtime/node/backend/src/`**。透镜一（L1-2）已证明该范围会漏掉 `runtime/node/backend/tests/`
   下的活跃消费者；凡此类结论本图均已标注「src/ only」。
3. **R2 纪律**：涉及 `providerPresets` / `apiProviderCatalog` / `customProviderRegistrar` 处，
   只核对了数据形态与 sanitize 职责，**未读取、未复现任何 key 值**；文中出现的 `sk-` 前缀串
   经确认是一眼假的占位 `keyExample`。
4. **未追通即未追通**：凡静态阅读无法确认的，进 §5「今日追不动的链」，**不编边**。

---

## 2. 目标态数据流总图（按 187 方案 §2.2 四层）

### 2.1 四层总图

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ 组装层 Assembly（D1 · bootstrap/init.js —— 全仓唯一数据源实例化点）                     │
│                                                                                      │
│   bootstrap/init.js 第一顺位：di/registry.register(TOKENS.*, provider)               │
│   bootstrap/dataAccess.js：默认 file-backed provider 注册表（19 个仓储的出厂装配）       │
│   边界：可实例化数据源并交给逻辑层；不得承载业务规则本身                                  │
└───────────────────────────────▲──────────────────────────────────────────────────────┘
                                │ resolve(TOKENS.xxx) —— 逻辑层只经接口取数
┌───────────────────────────────┴──────────────────────────────────────────────────────┐
│ 逻辑层 Logic（D1/D2 · src/cli、src/services/**、src/tools/**、src/routes/** …）        │
│                                                                                      │
│   取数只经 Repository 接口；硬禁：业务字面量表 / URL·端口字面量 / SQL·DDL 串 /           │
│   os.homedir() 拼用户家路径 / 提示词正文与用户可见文案 / process.env.X||默认值 成对书写 / │
│   裸 fs.readFileSync 读数据资产                                                        │
└───────────────────────────────▲──────────────────────────────────────────────────────┘
                                │ require（D1/D2/D3 → D6 合法；constants/ 纯叶例外可直接 import）
┌───────────────────────────────┴──────────────────────────────────────────────────────┐
│ 抽象层 Abstraction（D3 · src/dataAccess/）                                             │
│                                                                                      │
│   di/tokens.js（31–33 个字符串 token）   di/registry.js（register/resolve/createScope/   │
│   configResolver.js（四层优先级）        schema.js   contracts.js   paths.js            │
│   loaders/jsonRepository.js（只读：list/get/has/reload/resetCache，mtime 热重载 opt-in） │
│   loaders/dataCardLoader.js（4 个命名装载器：loadModelPricing/loadRoutingModes/         │
│                               loadPublicApis/loadSearchEngines）                       │
│   repositories/ ← 11 套仓储接口（见 §2.2 表）                                          │
│   硬禁：不得 require 逻辑层；不得含业务规则；IO 只发生在 jsonRepository/dataCardLoader    │
└───────────────────────────────▲──────────────────────────────────────────────────────┘
                                │ 唯一 IO 通道（readdir + parse + fail-soft 单条隔离）
┌───────────────────────────────┴──────────────────────────────────────────────────────┐
│ 数据层 D6（constants/ 的 env 可覆盖默认值为例外 + src/data + blueprints + templates    │
│            + config/**/*.json + contracts + i18n/locales）                            │
│                                                                                      │
│   硬禁：不得 require D1/D2/D4；不得含 IO；不得含 process.env（constants 例外除外）        │
│   出厂 JSON：config/models/{catalog,claude-catalog,retired}.json、config/gateway/kiro.json、│
│              config/services/ai-management.json、src/data/gateway/*.json、               │
│              src/data/apiProviderCatalog.json、src/data/prompts/*、src/data/commands/*、  │
│              src/cli/data/*.json、src/data/i18n/prompt.{en,zh,ja,ko}.json …            │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**合法边**：D6 →（被读）D3 → D1/D2；D1/D2/D3 → D6（require 数据/constants 纯叶）；
组装层 → 全部。
**非法边（今日高发，见 §3）**：D3 → D1/D2（`constants/prompts.js` 29 处 `require('../services/')`）；
D6 → IO / process.env / require D1；D1/D2 → 裸 fs 读数据资产；D1/D2 内联字面量表。

### 2.2 十一套仓储接口（目标态，签名引自 187 方案 §2.4.8）

| # | 仓储（`src/dataAccess/repositories/`） | 接口签名（摘要） | 归属流域 |
|---|---|---|---|
| 1 | `modelCatalog.js` | `list / get / register`（register 仍路由到 `registerModel`）；**`resolveWindow(id) deliberately absent** —— 注释「window values are NEVER seeded here」 | 模型 |
| 2 | `modelCapabilities.js` | `getEffortPresets / getCapabilities / getLabel / getContextWindow`；固定顺序 load-bearing：(1) 顶层 require `constants/modelContextWindows` (2) 加载期回填 `cap.context` (3) 之后才 `Object.freeze`；交给 `setAiRequestAnalysisDeps` 的必须是**同一引用** | 模型 |
| 3 | `retiredModel.js` | `isRetired / markRetired / snapshot`；`snapshot()` 形状 `Record<string,{reason:string,at:number}>`，`at` 是 epoch 毫秒 | 模型 |
| 4 | `providerPresets.js` | `list / get / mergedWith(envJson) / stripSecrets(record)`；**stripSecrets 在每条返回路径执行**（R2） | 供应商与渠道 |
| 5 | `apiProviderCatalog.js` | `get / list`；收敛「provider → 显示名 / env 键 / 默认端点」 | 供应商与渠道 |
| 6 | `promptStore.js` | `getSection(id, opts) => string / list() => string[] / registerSection(id, fn) => void` | 提示词与命令面 |
| 7 | `promptIntent.js` | 意图规则引擎薄装载（读 `src/data/prompts/intentRules.json`） | 提示词与命令面 |
| 8 | `uiCopy.js`（messageCatalog） | `t(key, params, { locale = 'zh-CN' }) => string / has(key) => boolean` | 文案与界面 |
| 9 | `alias.js` | `resolveAlias / getAliasesForCommand / getAllAliasKeys / ALIAS_MAP`（四导出保留） | 文案与界面 |
| 10 | `theme.js` | ThemeRepository（装载/归一/缓存/失败策略各自声明；路径解析委托 `utils/dataHome`） | 文案与界面 |
| 11 | `cleanupTargets.js` | CleanupTargetsRepository（rel/why/rebuild 三元组；`--repo/--tools/--runtime/--checkpoints` 分支逻辑不动） | 文案与界面 |

> 方案另有 `promptContent.js`（PromptContentRepository）、`toolSchema.js`、`configSchema.js`、
> `publicApi.js`、`blockedPathPolicy.js`（`isBlockedName/isBlockedExt/isBlockedPath`，25 条目 golden 测试）、
> `accountPool.js`（`ensureSchema/ensureColumn/upsertTokenRecord/listByPoolType/acquireLease/releaseLease/getConfig/setConfig`，
> SQL 字符串住纯数据模块 `domain/account/accountPool/sql.js`）等扩展仓储，未计入上表 11 套核心接口。
> 四层优先级（ConfigResolver，§2.4.5）：**env 内联 → `<appHome>/<file>` 运维覆盖 → `config/<file>` 出厂 → 代码兜底**；
> `createConfigResolver(spec)`，spec = `{key, envName, parse, defaults, homeFileName, file}`，返回 `get(env)/reload()/source(env)`。

### 2.3 本图与 187 方案的关系声明

§2.1/§2.2 是**目标态**：图中 `src/dataAccess/`、各 `config/models/*.json`、`src/data/gateway/*.json` 等
**今日在仓库中均不存在**（已逐一核验，见各流域差异点表第 1 条）。本图不新建任何目录或文件。

---

## 3. 逐流域数据流卡

> 五张卡对应五流域。每卡四段：**现状流**（边表，主体，保留全部 `file:line` 证据）→
> **真源清单**（含 driftRisk）→ **目标流**（187 方案条文摘录）→ **差异点表**（含批次落点与风险级）。

### 3.1 流域一：模型数据流（44 边 / 16 真源 / 16 差异点）

#### 3.1.1 现状流（边表）

| 边号 | from（产地） | to（消费方） | 机制 | 证据 `file:line` | violates | 说明 |
|---|---|---|---|---|---|---|
| F1-E1 | `src/constants/models.js:21-53`（`CLAUDE_*_MODELS` 等 typed arrays） | `src/constants/prompts.js:22,62-64`（`MODEL_PRIMARY.opus/sonnet/haiku`） | require | `constants/prompts.js:22` | none | D3→D3 合法边；型号名 SSOT 的唯一提示词消费点 |
| F1-E2 | `src/constants/models.js:21-53` | `src/services/modelEscalationPolicy.js:320-325`（`selectTargetModel` candidates） | require | `services/modelEscalationPolicy.js:320-325` | none | 全仓最干净的 D1→D3 型号取样：候选项全部来自 SSOT 数组，函数体内零型号字面量。※L1-5：原记 :317-322，实测 :317-319 为 `return null` 与 `let models` 声明，数组体在 :320-325 |
| F1-E3 | `src/constants/models.js` | 25 个消费文件（`services/gateway/adapters/{claude,relayApi,ollama,localLLM,cursor,kiro,vscode}Adapter.js`、`cliAgentRunner.js`、`embeddingClient.js`、`aiManagementServer.js` 等） | require | `grep -rln "constants/models'" src` | none | auto 选型/默认兜底/探测型号的主要来源；`scripts/ci/check-model-hardcoding.js` 的监视名单由本文件派生。※L1-2 摘要：消费方实测 25 处 require（原流记 24） |
| F1-E4 | `src/services/models/index.js:98-210`（`initDefaults`） | `src/services/models/index.js:21-39`（`registerModel`） | function-call | `services/models/index.js:100-211` | D1-no-literal | 10 条模型记录（id/name/provider/capabilities/contextWindow/maxTokens/costPerToken/supportsVision/supportsTools）整表内联在逻辑层 |
| F1-E5 | `src/constants/modelContextWindows.js:323-329`（`pinModelContextWindow`） | `src/services/models/index.js:36` | function-call | `services/models/index.js:12,36` | none | D1→D3 合法边；:36 是**恒定覆写点**，写在前一次 contextWindow 赋值（:27）之后，声明的值只作 fallback |
| F1-E6 | `src/services/models/index.js:36` | `src/services/models/index.js:19,22`（`_models` Map 条目） | function-call | `services/models/index.js:22-37` | none | 按两张表实算：10 条 seed 中 `claude-sonnet-4-5-20250929`(200000→1000000)、`claude-opus-4-0-20250514`(200000→1000000)、`gemini-2.0-flash`(1000000→1048576)、`gemini-1.5-pro`(1000000→1048576) 共 4 条有效值被覆写，与方案 §1.1 #1 实测一致 |
| F1-E7 | `src/services/models/index.js:215-221`（`getModelsDir`） | `<os.homedir()>/.khy/models/models.json`（`saveModels`/`loadModels`） | homedir-path | `services/models/index.js:216,226,232` | D1-no-literal | §2.2 逻辑层硬禁明列「os.homedir() 拼用户家路径」；同文件 :217-219 `mkdirSync`、:236 `readFileSync` 也是逻辑层自管 IO |
| F1-E8 | `src/services/models/index.js`（整个模块） | 无（全仓零 require 站点） | require | 全仓（runtime/delivery/apps/works/docs）grep `"services/models"` 0 命中；`src/services` 内 `require('./models')` 0 命中；无 `khy.module.json` | none | 死代码：`src/models/`（Sequelize ORM，22 model）与 `src/services/models/` 同名，所有 `require('../models')` 都落到 ORM 层。方案裁定 F/B6 却把 `registerModel` 当作活 seed 路径（冲突见 §4.5-a） |
| F1-E9 | `src/services/gateway/adapters/claudeAdapter.js:491-551`（`KNOWN_MODELS`） | `claudeAdapter.js:552-554`（post-pass）→ `claudeAdapter.js:907-941`（`listModels`） | function-call | `claudeAdapter.js:552-554, 907-941` | D1-no-literal | 活着的 Claude 目录（8 条目带 name/tier/category/isDefault）；`listModels` 再按 `::auto`/`::direct`/`::bridge` 三连接模式展开。contextWindow 不在此写死，由 post-pass 从真源回填。※L1-5：`listModels` 实测起于 :907（原记 :908） |
| F1-E10 | `src/constants/modelContextWindows.js:292-315`（`resolveModelContextWindow`） | `src/cli/ai.js:179-181`（`MODEL_CAPABILITIES` post-pass `cap.context` 回填） | function-call | `cli/ai.js:179-181` | none | D1→D3 合法；但方案 §1.2 #3 把「模块顶层副作用 + 数据/逻辑同文件」单列为 high。#1 记为 blocking：:177-179 原地 mutation，:184 收同一对象引用 |
| F1-E11 | `src/constants/modelContextWindows.js` | `src/cli/tui/utils/ccContextWindows.js:28-30`（`getContextWindow`）→ `ink-components/CcStatusLine.js`、`CcApp.js` | re-export | `cli/tui/utils/ccContextWindows.js:19-30` | none | TUI 状态栏 Context 百分比的分母来源；文件头自陈「要新增/修正窗口改真源，不要改这里」。※L1-3：行号由 :30-32/:31 修正为 :28-30/:29 |
| F1-E12 | `src/constants/modelContextWindows.js` | `src/services/gateway/adapters/claudeAdapter.js:553` 与 `src/cli/aiRequestAnalysis.js:24,113` | require | `claudeAdapter.js:553; cli/aiRequestAnalysis.js:24,113` | none | ※L1-3：`resolveModelContextWindow` 的**活调用点共 4 个**：`cli/ai.js:180`、`cli/aiRequestAnalysis.js:113`、`cli/tui/utils/ccContextWindows.js:29`、`claudeAdapter.js:553`；另有一个**死代码点** `services/models/index.js:36` 调的是 `pinModelContextWindow`（该模块零 require 站点，见 F1-E8）。原清单既漏了 `aiRequestAnalysis.js:113`，又把死代码点算了进来 |
| F1-E13 | `src/services/gateway/aiGatewayRoutingMethods.js:1768-1775`（`_refreshModelsBackground` 内 `listModels` 提取） | `aiGatewayRoutingMethods.js:1975-1986`（`_setContextWindowCache` → `_contextWindowCache`） | function-call | `aiGatewayRoutingMethods.js:1766-1788` | none | 「adapter 上报真值」是运行期第一优先；同段还提取 `maxOutputTokens` → `setModelMaxOutputTokens` |
| F1-E14 | `src/services/gateway/aiGatewayRoutingMethods.js:1719-1732`（`_warmupContextWindowCache`） | `aiGatewayRoutingMethods.js:1741+`（`_refreshModelsBackground` → 各 `adapter.listModels()`） | function-call | `aiGatewayRoutingMethods.js:1719-1732` | none | ※L1-4：机制由 `process-spawn` 改判 `function-call`。实测为 `Promise.resolve().then(...).catch(...).finally(...)` 的**异步 fire-and-forget，全链路无 child_process**。消费侧 `aiRequestAnalysis.js:86-92` 在缓存 miss 时反向触发它 |
| F1-E15 | `src/services/dynamicFreeModelService.js`（models.dev `api.json` + opencode zen `/v1/models`） | `aiGatewayRoutingMethods.js:145-155`（`_loadFreeCatalogArray`）→ :126-141（`_freeCatalogByIdMap`）→ :190,2254（`_setContextWindowCache` `source='free-catalog'`） | function-call | `aiGatewayRoutingMethods.js:63-87,145-155,183-194,2254` | none | 免费/全量目录供血。`source='free-catalog'` 属 NOMINAL，`contextWindowStore.js:182` 明写「只填缺失，绝不覆盖已学到的实测值」 |
| F1-E16 | `src/services/dynamicFreeModelService.js:40-56`（`_cacheDir`） | `<getDataDir('cache')>/free-models`，失败回退 `<os.homedir()>/.khy/cache/free-models` | homedir-path | `services/dynamicFreeModelService.js:46-49` | D1-no-literal | B8：catch 分支的 `os.homedir()+'.khy'` 字面量（被 `getDataDir` 分支遮蔽，但字面量仍在） |
| F1-E17 | `src/services/gateway/aiGatewayRoutingMethods.js:1983` | `src/services/gateway/contextWindowStore.js:187+`（`recordLearnedContextWindow`）→ `<getDataDir('gateway')>/context_window.json` | function-call | `aiGatewayRoutingMethods.js:1975-1986; contextWindowStore.js:60-68,187` | none | ※L1-4：机制由 `readFileSync` 改判 `function-call`——:1983 是 `require('./contextWindowStore').recordLearnedContextWindow(...)`，readFileSync 发生在**被调方内部**。dataHome 合规（`getDataDir('gateway')`）。这是窗口值的**跨重启第三层**：`VERIFIED_SOURCES`(probe/error-extract/listModels/generate-response) 双向覆盖，NOMINAL(free-catalog) 只填缺失；文件头明写「学到的值无论大小都压过静态表」 |
| F1-E18 | `src/services/gateway/aiGatewayRoutingMethods.js:1923-1965`（`getModelContextWindow`） | `src/cli/aiRequestAnalysis.js:52-96`（`_resolveModelContextLimit` 第 1 步） | function-call | `cli/aiRequestAnalysis.js:60-96` | none | 运行期第一优先；缓存 miss 时触发 :86-92 的 fire-and-forget 补供 |
| F1-E19 | `src/services/gateway/adapters/claudeAdapter.js:370-380`（`effectiveContextWindow`） | `src/cli/aiRequestAnalysis.js:71-79` | function-call | `cli/aiRequestAnalysis.js:71-79; claudeAdapter.js:363-380` | none | 1M 声明只有在 `context-1m` beta 真在发时才作数，否则钳回 200000——这是一条**业务规则**，落在消费接缝而非数据层 |
| F1-E20 | `src/cli/ai.js:96-177`（`MODEL_CAPABILITIES`） | `src/cli/ai.js:184`（`setAiRequestAnalysisDeps`）→ `src/cli/aiRequestAnalysis.js:41-43` | function-call | `cli/ai.js:184; cli/aiRequestAnalysis.js:28-29,41-43` | D1-no-literal | 29 条型号的能力评分/中文 label 表（※L1-6：原记「30+」，实测 29 个 key）+ 加载期回填的 context 字段，整表住在 5225 行宿主文件里；注入的是**同一对象引用** |
| F1-E21 | `src/cli/ai.js:600-604`（`setAiChatCoreDeps` 传入 `MODEL_CAPABILITIES`） | `src/cli/aiChatCore.js:129-130` → :243-244（`setAiTaskClassifierDeps` 转发）→ `src/cli/aiTaskClassifier.js:23-25` | function-call | `cli/ai.js:600-604; aiChatCore.js:129-130,243-244; aiTaskClassifier.js:23-25` | D1-no-literal | 引用身份三级透传：`ai.js` → `aiChatCore` → `aiTaskClassifier`，全程同一 reference（`deps.MODEL_CAPABILITIES !== undefined` 时取入参） |
| F1-E22 | `src/cli/aiTaskClassifier.js:144-188`（`checkModelCapability`） | auto 选型告警 + recommendations（`cap.code` / `cap.reasoning` / `cap.context`） | function-call | `aiTaskClassifier.js:142-188` | D1-no-literal | 按 key 长度降序排序后子串匹配；※L1-5：`cap.context` 当上限用在 :165 与 :167（原记 :165/:180，:180 无 `cap.context`），recommendations 在 :187。同函数 :411 被任务守卫再消费一次 |
| F1-E23 | `src/cli/ai.js:728` | `src/services/modelCapabilityPort.js:24-38`（`registerModelCapabilityChecker`） | function-call | `cli/ai.js:728; services/modelCapabilityPort.js:23-38` | none | cli→services 的端口注册（模块加载期执行），形态上是本仓现成的「组装层唯一实例化点」雏形；services 侧经 port 反查 cli 的 `checkModelCapability` |
| F1-E24 | `src/cli/ai.js:86-91`（`EFFORT_PRESETS`） | `src/cli/ai.js:184` → `src/cli/aiRequestAnalysis.js:38-40` → :200（`_resolveContextBudget` 默认档） | function-call | `cli/ai.js:86-91,184; cli/aiRequestAnalysis.js:38-40,200,222` | D1-no-literal | 四档 temperature/maxTokens/label/thinking.budgetTokens 内联；:222 `presetReserve` 与 :238-244 `smallCap` 共同决定压缩预算 |
| F1-E25 | `src/cli/ai.js:86-91`（`EFFORT_PRESETS`） | `src/cli/ai.js:600` → `src/cli/aiChatCore.js:123-125` → :2063（`preset.maxTokens`/`temperature`） | function-call | `cli/ai.js:600; aiChatCore.js:80,123-125,2063` | D1-no-literal | 同表第二注入路径；:4042 注释明示「续写轮不污染 EFFORT_PRESETS 原表」——即该表今天**可被**污染（未 freeze） |
| F1-E26 | `src/cli/ai.js:317-319`（`getEffortPresets`） | `src/services/aiManagementServer.js:1534,1977`（HTTP/WS 状态面回显 presets） | function-call | `cli/ai.js:317-319; services/aiManagementServer.js:1533-1544,1976-1977` | D1-no-literal | 运维面把 D1 里的表原样回显；表的定义处仍在逻辑层。※L1-5：`getEffortPresets` 回现实测在 :1534（另 :3164），原记 :1542 |
| F1-E27 | `src/services/aiManagementServer.js:2794` | WS `session.effort` 默认值 `'high'` | inline-literal | `services/aiManagementServer.js:2794` | D1-no-literal | 第三处 effort 档位字面量，与 `EFFORT_PRESETS.high` 语义重复但无引用关系 |
| F1-E28 | `src/services/zenRetiredModels.js:45-52`（`BUILTIN_RETIRED`） | `src/services/zenRetiredModels.js:124-137`（`isRetired`）→ `services/zenGatekeeper.js`、`services/multiFreeService.js`、`services/zenModelStability.js` | function-call | `services/zenRetiredModels.js:45-52,124-137` | D1-no-literal | 6 条静态废弃 id 账本内联；:43 `_PROBED_AT = Date.parse(...)` 转 epoch ms 后入库，因为 :58 `TRANSIENT_TTL_MS` 的 TTL 判定吃数字（外置 JSON 若存日期串会让 :98 变 NaN） |
| F1-E29 | `src/services/zenRetiredModels.js:143-163`（`_readFresh`） | `<getDataHome()>/zen_retired_models.json` | readFileSync | `services/zenRetiredModels.js:64-79,143-163` | none | dataHome 合规（`getDataHome` + `getLegacyDataHome` 回退，env `KHY_ZEN_RETIRED_FILE` 可覆盖）。:105-117 `_write` 走 temp→rename 原子落盘；:200-227 `pruneExpired` 修剪 |
| F1-E30 | `src/services/zenRetiredModels.js:254-291`（`recordFromUpstreamError`） | `src/services/zenRetiredModels.js:171-190`（`markRetired`） | function-call | `services/zenRetiredModels.js:171-190,254-291` | none | 410/401/404 只作准入，定性看上游明文（ModelDeprecated / is not supported）；403/429/5xx 明确不记。「用过一次就自愈」的运行时补录路径 |
| F1-E31 | `<getDataHome()>/custom_providers.json` | `src/services/customProviderRegistry.js:15-17` → `src/services/gateway/adapters/apiAdapter.js:744-757,767-775` | json-parse | `services/customProviderRegistry.js:15-17; apiAdapter.js:734-775` | none | 运维 JSON 是型号的第三来源：`cp.models`（静态型号表）+ `cp.defaults`（contextWindow/maxOutputTokens 元数据）+ `defaultModel` 覆盖 `getPoolDefaultModelMap` 静态表 |
| F1-E32 | `src/services/gateway/zhipuFreeModels.js:38+`（`ZHIPU_FREE_MODELS`） | `src/services/gateway/adapters/apiAdapter.js:769,813` 与 `src/services/gateway/modelCatalogGraph.js:156`（`augmentGlmPoolModels`） | function-call | `apiAdapter.js:769,813; modelCatalogGraph.js:156` | D1-no-literal | 智谱免费模型权威源（`freeModelChannels.js:20` 注释已裁定）；门控 `KHY_ZHIPU_FREE_MODELS` 默认开，关时原样返回入参。※L2-7：本数据的归属流域裁定为**供应商与渠道流**，模型流只作交叉引用（见 §4.1/§4.3） |
| F1-E33 | `src/services/freeModelChannels.js:27-255`（`FREE_MODEL_CHANNELS`） | 免费渠道消费方（`multiFreeService` 等） | inline-literal | `services/freeModelChannels.js:20,27-255` | D1-no-literal | zhipu 一条的 7 个免费模型 id 与 `zhipuFreeModels.js` 逐字节相同、顺序一致（方案 §1.1 #15 实测），构成同数据两份副本。※L2-7：同属供应商与渠道流主归属 |
| F1-E34 | `runtime/node/backend/config/models/pricing.json` | `src/services/modelPricing.js` 函数体（`_loadTable`：env 内联 → appHome → homedir 兜底 → 仓内）→ `src/services/tokenPricing.js` → `src/services/tokenUsageService.js` | readFileSync | `services/modelPricing.js:209-245`（:213-219 env 内联、:223-225 appHome、:226-227 homedir 兜底、:228 仓内） | D1-no-literal | ※L2-6：锚点由模块头 :26-29,94 改到**函数体**，violates 由 `none` 统一为 `D1-no-literal`（homedir 兜底 :226-227）。计费链与窗口/能力链**完全解耦**：`priceState` 五态按 model id 精确/家族正则/provider 三级解析，不读 `MODEL_CAPABILITIES` 也不读窗口表。三级装载是仓内既有样板（方案 §2.1 点名 pricing.json 为「既有（三级装载样板）」） |
| F1-E35 | `runtime/node/backend/config/models/features.json` | `src/services/modelFeatureRegistry.js:63,126`（7 层：env JSON > 内存 > `<appHome>/model_features.json` > `config/models/features.json` > patterns > tierDefaults > modelTier 兜底 > defaults） | readFileSync | `services/modelFeatureRegistry.js:18-27,63,126` | none | 方案 §2.1 称 features.json 是「最好的声明式配置样板」，可作为 ModelCatalogRepository 的挂靠范式。※L2-6：其 catch 内 homedir 兜底（:124-129）在持久化配置流同标签登记，见 F5-E25 |
| F1-E36 | `src/services/modelFeatureRegistry.js:128` | `<os.homedir()>/.khyquant/model_features.json`（catch 回退） | homedir-path | `services/modelFeatureRegistry.js:124-129` | D1-no-literal | 被 `getAppHome()` 分支遮蔽，但字面量仍在；与 `dynamicFreeModelService.js:49` 同型 |
| F1-E37 | `src/services/gateway/capabilityRegistry.js:38+`（`DEFAULT_ADAPTER_CAPABILITIES`） | adapter 级 11 维 0-5 能力查询引擎 | inline-literal | `services/gateway/capabilityRegistry.js:22-35,38-123` | D1-no-literal | **第三套能力刻度**（adapter 粒度 11 维），与 `MODEL_CAPABILITIES`（model 粒度 3 维）、`modelCapability.classifyCapability`（text/audio/image/video 四桶）互不引用。方案 §1.1/§1.3 未覆盖此文件；其消费方未追（§5） |
| F1-E38 | `src/cli/aiRequestAnalysis.js:103-112` | `MODEL_CAPABILITIES[key].context`（子串匹配，`Math.max(8000, …)`） | function-call | `cli/aiRequestAnalysis.js:98-116` | none | 顺序问题：**派生副本（回填自 modelContextWindows）被排在真源 :113 `resolveModelContextWindow` 之前查询**，且遍历用 `Object.entries` 插入序（未按 key 长度排序，`aiTaskClassifier.js:144-146` 才有排序）。注释自陈只因「~25 型号子集不含 agnes-*/glm-5.*/deepseek-chat」才继续问 SSOT |
| F1-E39 | `src/cli/aiRequestAnalysis.js:200-255`（`_resolveContextBudget`） | 压缩预算（contextBudget / reserveTokens / safetyTokens）→ `src/services/contextCompressor.js` | function-call | `cli/aiRequestAnalysis.js:200-255` | D1-no-literal | 函数体内 `KHY_CONTEXT_*` env 内联共 7 处（※L1-6：原记 8 处；实测 :183/:187/:196/:216/:220/:228/:241），是方案 B7「env 与阈值成对书写」硬禁的原型 |
| F1-E40 | `src/cli/aiChatCore.js:2125` | `runtime.makeSystemPrompt(..., { contextWindow })`（短上下文模型瘦身系统提示） | function-call | `cli/aiChatCore.js:2119-2125` | none | 窗口值的第四个消费面（提示词装配）；0/未知与大窗口时逐字节不变 |
| F1-E41 | `src/cli/aiChatCore.js:4025` | `_bounds.contextWindow` → truncation 恢复决策 | function-call | `cli/aiChatCore.js:4013-4045` | none | 与 :4019 `getModelMaxOutputTokens` 一起构成续写轮的上界 |
| F1-E42 | `src/services/gateway/modelCatalogGraph.js:221,228,272-273,340-341` | 目录图谱（每 model edge 挂 tier + capability） | function-call | `services/gateway/modelCatalogGraph.js:221,228,272-273,340-341` | none | tier/capability 由 `modelTier.js` 与 `modelCapability.js` 的正则启发式**推导**，不是数据表——属逻辑层规则，方案不要求外置 |
| F1-E43 | `src/cli/handlers/gatewayModelChoices.js:807-813` | `/model` 选择器条目的 tier 显示 | function-call | `cli/handlers/gatewayModelChoices.js:807-813` | none | 显示面经 `modelTier.resolveTier` 取档，不读 `MODEL_CAPABILITIES` 的 label |
| F1-E44 | `src/services/gateway/autoModelSelect.js` + `src/services/gateway/aiGatewayRoutingMethods.js:autoSelectModel` | auto 选型（任务贴合度 + 能力匹配 + 发现来源可信度排序） | function-call | `services/gateway/autoModelSelect.js:41,68-130` | none | 模型粒度排序是纯叶子（零 IO）；运行时逐请求仍以 adapter 粒度经 `autoSelectModel` 解析 |

#### 3.1.2 真源清单（16）

| # | 路径 | 角色 | driftRisk |
|---|---|---|---|
| T1-1 | `src/constants/modelContextWindows.js` | 静态上下文窗口唯一真源（:39 `MODEL_CONTEXT_WINDOWS` 精确表 + :67 `MODEL_CONTEXT_PREFIXES` 家族前缀表，均 `Object.freeze`；:292 `resolveModelContextWindow` / :323 `pinModelContextWindow`） | contested |
| T1-2 | `src/services/gateway/contextWindowStore.js` + `<getDataDir('gateway')>/context_window.json` | 运行期学到的窗口（probe/error-extract/listModels/generate-response 可双向覆盖；free-catalog 只填缺失）；文件头明写「学到的值无论大小都压过静态表」 | contested |
| T1-3 | `src/cli/ai.js:96-177`（`MODEL_CAPABILITIES`） | 每型号能力评分（code/reasoning/creative）与中文 label 的唯一表（29 条）；context 字段是 :179-181 从真源回填的派生副本 | duplicate |
| T1-4 | `src/services/gateway/adapters/claudeAdapter.js:491-551`（`KNOWN_MODELS`） | 活着的 Claude 型号目录（name/tier/category/isDefault），`listModels()` 的唯一数据源；contextWindow 为 :552-554 回填副本 | duplicate |
| T1-5 | `src/services/models/index.js:98-210`（`initDefaults`） | 10 条通用 seed 模型记录；**全仓零 require 站点（死代码）**，与 `KNOWN_MODELS`、`MODEL_CAPABILITIES` 三份「模型目录」并存 | duplicate |
| T1-6 | `src/constants/models.js` | 型号名 SSOT（typed arrays + PRIMARY 映射），`scripts/ci/check-model-hardcoding.js` 的监视名单由本文件派生 | single-source |
| T1-7 | `src/cli/ai.js:86-91`（`EFFORT_PRESETS`） | effort 四档（temperature/maxTokens/label/thinking.budgetTokens）唯一表，未 `Object.freeze` | single-source |
| T1-8 | `src/services/zenRetiredModels.js:45-52`（`BUILTIN_RETIRED`） | Zen 已废弃 id 的静态账本（6 条，reason 决定是否可自愈；:43 转 epoch ms） | single-source |
| T1-9 | `<getDataHome()>/zen_retired_models.json` | 运行期观测账本（`markRetired` 写、`_readFresh` 带 mtime 复查读、`pruneExpired` 修剪，上限 200 条） | single-source |
| T1-10 | `src/services/gateway/zhipuFreeModels.js` | 智谱免费模型权威源（7 个 `{id, modality, label}` + `CHAT_MODALITIES` + `RETIRED_ZHIPU_REMAP` + `augmentGlmPoolModels`），门控 `KHY_ZHIPU_FREE_MODELS`。※L2-7：driftRisk 由 `single-source` 统一改判 **contested**（`freeModelChannels.js:20` 注释已裁定权威源在本文件，但两份都在争「发现层」与「目录层」出口） | contested |
| T1-11 | `src/services/freeModelChannels.js` | 免费渠道种子表；zhipu 一条的 7 个免费模型 id 与 `zhipuFreeModels` 逐字节相同、顺序一致（无机械同步） | duplicate |
| T1-12 | `config/models/pricing.json` | 价格五态表（priced/free/flat/assumed/unknown），`modelPricing` 三级装载：env 内联 > appHome > 仓内文件 | single-source |
| T1-13 | `config/models/features.json` | 模型画像（models/patterns/tierDefaults/defaults），`modelFeatureRegistry` 七层解析，方案 §2.1 点名的「最好的声明式配置样板」 | single-source |
| T1-14 | `<getDataHome()>/custom_providers.json` | 运维 provider/型号登记（`customProviderRegistry`），`apiAdapter.listModels()` 的 staticModels/defaults/defaultModel 来源 | single-source |
| T1-15 | `https://models.dev/api.json` + `<getDataDir('cache')>/free-models` | 远端全量/免费目录（`dynamicFreeModelService`，5min 文件缓存），窗口的 NOMINAL 供血来源 | single-source |
| T1-16 | `src/services/gateway/capabilityRegistry.js` | adapter 粒度 11 维 0-5 能力声明（第三套能力刻度），与 `MODEL_CAPABILITIES`、`modelCapability.classifyCapability` 互不引用；方案未覆盖，消费方未追 | duplicate |

#### 3.1.3 目标流（187 方案条文摘录）

**§2.1 新目录（模型相关）**：`config/models/` 新增三个纯 JSON——`catalog.json`（「新增：模型目录（**不含窗口字段**）」）、`claude-catalog.json`（「新增：Claude 型号目录」）、`retired.json`（「新增：Zen 已废弃模型账本（**at 存 epoch ms**）」）；`pricing.json`/`routing-modes.json`/`features.json` 记为既有样板。`src/constants/`：`modelContextWindows.js`「既有（**窗口唯一真源**）」；新增 `modelCapabilities.js`（「`MODEL_CAPABILITIES` + **加载期 post-pass**」）与 `effortPresets.js`（「`EFFORT_PRESETS` 四档」）。`src/dataAccess/repositories/` 新增 `modelCapabilities.js` / `modelCatalog.js` / `retiredModel.js`；`src/contracts/` 新增 `models/catalog.schema.json`。

**§2.4.6 数据 Schema**：`catalog.schema.json` 的 `_ssot_note` const 串写明「contextWindow is NOT declared here. The single source of truth is src/constants/modelContextWindows.js; registerModel applies pinModelContextWindow unconditionally.」；`items.additionalProperties: false` 是故意的，写回 contextWindow 的 PR 直接校验失败。

**§2.4.8 仓储接口**：`modelCatalog` —— `list/get/register`（register 仍路由到 `registerModel`），**`resolveWindow(id) deliberately absent**，注释「window values are NEVER seeded here」+ REVIEW R-06 复述 4/10 覆写；`retiredModel` —— `isRetired/markRetired/snapshot`，REVIEW R-12 复述 `at` 是 epoch 毫秒（因 `zenRetiredModels.js:56` `TRANSIENT_TTL_MS` 需要数字）；`modelCapabilities` —— `getEffortPresets/getCapabilities/getLabel/getContextWindow`，REVIEW R-14「fixed order is load-bearing：(1) require constants/modelContextWindows at module top (2) backfill cap.context at module load time (3) only then Object.freeze. The object handed to setAiRequestAnalysisDeps must stay the SAME reference.」

**裁定 F（4 条）**：① `catalog.json` 第一期只搬非窗口字段；② schema 把 `contextWindow` 显式标为禁止手写；③ `ModelCatalogRepository` 的 seed **必须仍走 `registerModel`**（或仓储内显式再调一次 `pinModelContextWindow`），并**加断言上述 4 条覆写值的测试**；④ 删除「本字段仅作缺失兜底」的错述。附带：`catalog.json` 不在 `check-model-hardcoding.js` 的 `TEXT_EXTS` 内，补交叉一致性测试（id 集合差集只许收缩）而不改 `TEXT_EXTS`。

**§4 批次**：B1 第 2/3/6 条（`EFFORT_PRESETS`、`MODEL_CAPABILITIES`+post-pass、`setAiRequestAnalysisDeps` 入参形状与对象引用身份不变）；B6（`catalog.json` / `claude-catalog.json` / `retired.json` 外置 + 交叉一致性测试 + `retired.atType.test.js` + 「第一期不清与 modelContextWindows 的漂移」）。

#### 3.1.4 差异点表（16）

| # | 差异点 | 现状 | 目标态 | 批次 | 风险 |
|---|---|---|---|---|---|
| Δ1-1 | `config/models/catalog.json` 不存在 | 10 条 seed 记录整表内联在 `src/services/models/index.js:98-210`；且该模块全仓零 require 站点（死代码） | §2.1 只搬非窗口字段（id/name/tier/category/maxTokens/costPerToken/capabilities）；§2.4.6 schema `additionalProperties:false` 显式禁写 contextWindow；§2.4.8 `ModelCatalogRepository.register` 仍路由到 `registerModel` | B6 / 裁定 F | blocking |
| Δ1-2 | `services/models/index.js` 是死代码，但方案把它当活 seed 路径 | 全仓 grep `"services/models"` 0 命中；`src/services` 内 `require('./models')` 0 命中；无 `khy.module.json`；`src/models/` ORM 同名遮蔽 | 裁定 F 第 3 条要求「seed 必须仍走 `registerModel`」；B6 要求 `git diff --stat -- src/services` 为空 | 裁定 F / B6 | high |
| Δ1-3 | `config/models/claude-catalog.json` 不存在 | Claude 活目录内联在 `claudeAdapter.js:491-551`（8 条目），:552-554 加载期回填 contextWindow，:907-941 `listModels` 展开 | §2.1 `config/models/claude-catalog.json`；B6 改动清单 `claudeAdapter.js:491-551` → JSON | B6 | high |
| Δ1-4 | `config/models/retired.json` 不存在（`at` 须为 epoch ms） | `BUILTIN_RETIRED` 内联在 `zenRetiredModels.js:45-52`；:43 `Date.parse` 转时间戳；:58 `TRANSIENT_TTL_MS` 与 :98 TTL 判定吃数字 | §2.1 `config/models/retired.json`（at 存 epoch ms）；§2.4.8 `retiredModel.snapshot()` 形状 `Record<string,{reason:string,at:number}>`；B6 验证 `retired.atType.test.js`（`typeof at === 'number'`） | B6 | medium |
| Δ1-5 | `src/constants/modelCapabilities.js` 不存在，且现表未 `Object.freeze` | `MODEL_CAPABILITIES` 定义在 `cli/ai.js:96-177`（29 条，含中文 label），:179-181 模块加载期原地 `cap.context = resolveModelContextWindow(id)`，:184 注入同一引用；`cli/ai.js` 内 grep 无任何 `Object.freeze` | B1 第 3 条：搬到 `src/constants/modelCapabilities.js`，固定顺序（顶部 require `modelContextWindows` → 加载期回填 → 之后才 `Object.freeze`）；§2.4.8/附录 A13：冻结时机与对象引用身份必须钉死 | B1 / A13 | high |
| Δ1-6 | `src/constants/effortPresets.js` 不存在 | `EFFORT_PRESETS` 定义在 `cli/ai.js:86-91`（四档，max 档带 `thinking.budgetTokens`），未 freeze，经 :184/:600 双路注入，经 :317 `getEffortPresets` 暴露给 `aiManagementServer` | B1 第 2 条：`cli/ai.js:86-91` → `src/constants/effortPresets.js` 原样搬；fixture diff 必须为空 | B1 | medium |
| Δ1-7 | DI/仓储层完全缺席，依赖注入是手写 setter | `setAiRequestAnalysisDeps`（`aiRequestAnalysis.js:37-50`）、`setAiChatCoreDeps`（`aiChatCore.js:121-`）、`setAiTaskClassifierDeps`（`aiTaskClassifier.js:21-27`）、`modelCapabilityPort.registerModelCapabilityChecker` 四套并行注入机制；`src/dataAccess/` 目录不存在 | §2.4.1 TOKENS（`MODEL_CAPABILITIES:'repo.modelCapabilities'` 等 33 个字符串 token）+ §2.4.2 `di/registry.js` register/resolve/createScope；`src/dataAccess/repositories/{modelCapabilities,modelCatalog,retiredModel}.js` | B0 / B1 | medium |
| Δ1-8 | `src/contracts/models/catalog.schema.json` 不存在 | `config/models/` 下只有 `pricing.json` / `routing-modes.json` / `features.json` / `style_templates.js`，无任何 schema 断言；没有任何机制阻止把 contextWindow 写回目录 | §2.4.6 `catalog.schema.json`：`_ssot_note` 写明窗口真源是 `constants/modelContextWindows.js`，`items.additionalProperties:false` 让写回 contextWindow 的 PR 直接校验失败 | B6 | medium |
| Δ1-9 | 「窗口双真源」在运行期成立，且 4 条覆写无测试断言 | 静态真源 `constants/modelContextWindows.js`（:39/:67 两张 freeze 表）在消费侧被三层压过：① gateway `_contextWindowCache`（`aiGatewayRoutingMethods.js:1923`）② `contextWindowStore` 落盘 `<getDataDir('gateway')>/context_window.json`（明写「压过静态表」）③ 两份回填副本（`cli/ai.js:180`、`claudeAdapter.js:553`）。`tests/constants/modelContextWindows.test.js` 只泛测 `pinModelContextWindow`（:253-261），无一条断言 `services/models/index.js` 那 4 个被覆写的 seed 窗口 | 裁定 F 第 3 条明令「加断言上述 4 条覆写值的测试」；第 4 条已删除「本字段仅作缺失兜底」的错述 | 裁定 F | high |
| Δ1-10 | `MODEL_CAPABILITIES` 的派生 context 副本排在真源之前被查 | `cli/aiRequestAnalysis.js:103-112` 先用 `MODEL_CAPABILITIES[key].context` 子串匹配（`Object.entries` 插入序，未按 key 长度排序），miss 后才走 :113 `resolveModelContextWindow` | §2.4.8 `modelCapabilities.getContextWindow(id)` 与 `modelCatalog` 注释「`resolveWindow(id)` deliberately absent: the single source of truth for constants/modelContextWindows.js」 | B1 | medium |
| Δ1-11 | `catalog.json` 将脱离「模型名单一真源」守卫扫描面 | `scripts/ci/check-model-hardcoding.js:31` `TEXT_EXTS = {'.js','.cjs','.mjs'}`，监视名单由 `constants/models.js` 派生（`loadWatchedNames`） | 裁定 F 附带：给 `catalog.json` 补与 `constants/models.js` 的交叉一致性测试（id 集合差集只许收缩），明确不改 `TEXT_EXTS`（改守卫扫描面是治理动作须人点头） | 裁定 F | medium |
| Δ1-12 | `stripSecrets` 全仓不存在 | `runtime/node/backend/src` 全量 grep `"stripSecrets"` 0 命中（含 tests） | §2.3 密钥边界：`providerPresets` / `apiProviderCatalog` 的装载器必须过 `stripSecrets()`，schema 断言无值匹配 `/(sk-\|AKIA\|Bearer \|-----BEGIN)/`；§2.4.8 `providerPresets.stripSecrets` 每条返回路径都跑（R2） | B3 / B6 | high |
| Δ1-13 | B8 路径字面量在模型链上残留 3 处 | `services/models/index.js:216` `path.join(os.homedir(),'.khy','models')`；`services/dynamicFreeModelService.js:49` `path.join(os.homedir(),'.khy','cache','free-models')`；`services/modelFeatureRegistry.js:128` `path.join(os.homedir(),'.khyquant','model_features.json')`（三处均被 dataHome 分支遮蔽，字面量仍在） | §2.2 逻辑层硬禁「`os.homedir()` 拼用户家路径」；`utils/dataHome.js` 为唯一正解；新增 `check-data-logic-separation.js` 的 denylist 抓 services 内 `os.homedir()` | B0 | medium |
| Δ1-14 | 四份互不引用的「模型目录/能力」表并存 | ① `services/models/index.js:98-210`（10 条，通用）② `claudeAdapter.js:491-551` `KNOWN_MODELS`（8 条 Claude）③ `cli/ai.js:96-177` `MODEL_CAPABILITIES`（29 条评分/label）④ `capabilityRegistry.js:38+` `DEFAULT_ADAPTER_CAPABILITIES`（adapter 粒度 11 维） | 收敛为 `catalog.json` + `claude-catalog.json` + `constants/models.js`（型号名）+ `constants/modelCapabilities.js`（评分/label）；`capabilityRegistry` 方案未覆盖 | （无批次） | medium |
| Δ1-15 | effort 档位字面量第三处 | `services/aiManagementServer.js:2794` WS `session.effort = 'high'`，与 `EFFORT_PRESETS.high` 语义重复但无引用 | B1 搬表后经 `effortPresets` 取档；B7 把 `aiManagementServer` 头部配置组外置到 `config/services/ai-management.json` | B1 / B7 | low |
| Δ1-16 | `aiManagementServer` 的 effort 默认值与 `modelPricing` 五态口径未入方案模型域 | `services/modelPricing.js` 的 `priceState` 五态（priced/free/assumed/flat/unknown）与 `config/models/pricing.json` 三级装载不在方案 §2.1 的 `models/` 清单内（清单只列 catalog/claude-catalog/retired 三个新增） | §2.1 仅把 `pricing.json` 记为「既有（三级装载样板）」，未要求新增仓储 | （无批次） | low |

---

### 3.2 流域二：供应商与渠道数据流（28 边 / 13 真源 / 20 差异点）

#### 3.2.1 现状流（边表）

| 边号 | from（产地） | to（消费方） | 机制 | 证据 `file:line` | violates | 说明 |
|---|---|---|---|---|---|---|
| F2-E1 | `src/constants/serviceDefaults.js`（`OPENROUTER_BASE_URL`/`GROQ_BASE_URL`/`TOGETHER_BASE_URL`/`DEEPSEEK_BASE_URL`/`OLLAMA_OPENAI_BASE_URL`，:152-158） | `src/services/gateway/providerPresets.js:PROVIDER_PRESETS.baseUrl` | require | `serviceDefaults.js:152-158`；`providerPresets.js:25-31`（解构 require）与 :144,:257,:275,:294,:310（5 处 baseUrl 取值） | none | 方案 §2.1 明许 `constants/` 纯叶直接 import（「零硬编码」的正解），裁定 E 明确保留既有 env 名。但覆盖率只有 5/15：openai/anthropic/gemini/vertex/agnes/shengsuanyun/packycode/moonshot/qwen/zhipu 共 10 条的 baseUrl 仍是文件内 URL 字面量 |
| F2-E2 | `src/services/gateway/providerPresets.js:PROVIDER_PRESETS` | `src/services/gateway/providerPresets.js:getProviderPresets()` | inline-literal | `providerPresets.js:64-323`（15 条对象字面量）；:418 `getProviderPresets()`；:356-394 `sanitize()` 白名单构造（不拷贝 `raw.key`/`raw.apiKey`） | D1-no-literal | 下游 12 处消费方：`customProviderRegistrar.js:25,64`；`channelApiService.js:23,160,485`；`relayApiAdapter.js:791`；`aiGateway.js:1534`；`gatewayGuide.js:95`；`cli/handlers/provider.js:116`；`cli/onboarding.js:142`；`domain/network/externalApps/_shared.js:146`；`ai-backend/src/routes/userGateway.js:33,205` |
| F2-E3 | env `KHY_PROVIDER_PRESETS` | `src/services/gateway/providerPresets.js:getProviderPresets()` | env-read | `providerPresets.js:400-411` `readEnvOverrides()`；:447-460 按 id 合并（覆盖替换、新 id 追加） | none | 在函数体内求值（非模块级 const），因此测试改 env 生效——求值时机是对的。JSON 畸形/非数组 fail-soft 返 `[]`。不属 §2.2 D1 硬禁列的「`process.env.X \|\| 默认值`」成对书写形态，故判 none；目标态只是改经 ConfigResolver（§2.4.5） |
| F2-E4 | `src/services/zhipuGlmModel.js:LATEST_ZHIPU_MODELS`（:24 `LATEST_ZHIPU_MODEL`、:26 `LEGACY_ZHIPU_MODEL`、:29/:33 `LEGACY/LATEST_ZHIPU_MODELS`） | `src/services/gateway/providerPresets.js` zhipu preset 的 `defaultModel`/`models` | inline-literal | `zhipuGlmModel.js:24-33`；`providerPresets.js:435-441`；`builtinProviderConfig.js:136-149` `_withGlmLatest`；`routes/ai.js:793-796` | D1-no-literal | `zhipuGlmModel.js` 自述「纯叶子」，但住在 `services/` 逻辑层。它是 GLM 模型清单的真源叶子，被 3 处 require 覆写各自表内的静态副本 |
| F2-E5 | `src/services/freeModelChannels.js:FREE_MODEL_CHANNELS`（:27-89，4 条渠道） | `src/tools/ConfigureModelProvider/index.js:executeList`/`executeAdd` | inline-literal | `freeModelChannels.js:27-89`；:187-215 `listFreeModelChannels()`；`tools/ConfigureModelProvider/index.js:222-226` 与 :473-482 | D1-no-literal | 唯二消费方都在 `tools/ConfigureModelProvider/index.js`：`action=list` 追加 `freeChannels` 字段，内置 add 成功 note 追加一行摘要 |
| F2-E6 | `src/services/gateway/zhipuFreeModels.js:ZHIPU_FREE_MODELS` | `src/services/freeModelChannels.js:FREE_MODEL_CHANNELS[zhipu].freeModels` | inline-literal | `freeModelChannels.js:33-41`（zhipu.freeModels 7 个 id 字符串）；`zhipuFreeModels.js:39-69`（7 个 `{id,modality,label}`） | D1-no-literal | 7 个 id 与顺序实测逐字节相同（glm-4.7-flash, glm-4.6v-flash, glm-4.1v-thinking-flash, glm-4-flash-250414, glm-4v-flash, cogview-3-flash, cogvideox-flash）。`freeModelChannels.js:20` 注释已裁定权威源是 `zhipuFreeModels`，但副本仍是手抄字符串数组、无任何机械同步，改一处不改另一处即静默漂移。※L2-7：本流域是该数据的**主归属流域**（另两流改交叉引用） |
| F2-E7 | `src/services/gateway/zhipuFreeModels.js:ZHIPU_FREE_MODELS` | `src/services/gateway/adapters/apiAdapter.js:listModels` 与 `src/services/gateway/modelCatalogGraph.js` 的 pool-only 分支 | function-call | `zhipuFreeModels.js:194-221` `augmentGlmPoolModels`；:148-157 `zhipuFreeChatModelIds`；调用点 `apiAdapter.js:769,:813`；`modelCatalogGraph.js:156`；`tools/ConfigureModelProvider/index.js:461` | D1-no-literal | 只 augment modality 为 chat/vision 的 5 个（cogview-3-flash 图像、cogvideox-flash 视频按设计不进聊天目录）。:578/:583 另有 `remapRetiredZhipuModel` 消费同文件的 `RETIRED_ZHIPU_REMAP` |
| F2-E8 | `src/services/gateway/zhipuFreeModels.js:ZHIPU_ENDPOINT` | （无消费方） | inline-literal | `zhipuFreeModels.js:29` 定义、:256 导出；全仓 grep 仅此两处命中 | D1-no-literal | 死导出。GLM v4 端点字面量在 src 内另有多处数据值副本：`gateway.js:1478`、`apiKeyPool.js:121`、`builtinGlmKey.js:32`、`builtinProviderConfig.js:54`、`providerPresets.js:236`、`routes/ai.js:800`、`multiFreeService.js:2132` |
| F2-E9 | `src/cli/handlers/gateway.js:API_PROVIDER_ENV_KEYS`（:1459-1504） | `src/cli/handlers/gatewayStatusView.js:handleGatewayStatus`（:155, :612） | inline-literal | `gateway.js:1445-1457` `API_PROVIDER_DISPLAY_NAMES`、:1459-1504 `API_PROVIDER_ENV_KEYS`；:1563-1665 `_collectConfiguredEndpointRows`、:1667-1778 `_collectConfiguredEndpointObjects`；:1643,:1756 `Object.entries` 循环 | D1-no-literal | 两个 collector 读三份不同来源：Rows=api_keys.json+`API_PROVIDER_ENV_KEYS`(11)；Objects=api_keys.json+builtin(agnes/sensenova)+`API_PROVIDER_ENV_KEYS`(11)。两者都不读 `apiKeyPool` 的 `ENV_KEY_MAP`(13)，故 CLI 状态面少报 agnes/stepfun 的 env key |
| F2-E10 | `src/cli/handlers/gateway.js:API_PROVIDER_DISPLAY_NAMES`（:1445-1457，11 个中文显示名） | `src/cli/handlers/gateway.js:_collectConfiguredEndpointRows`/`_collectConfiguredEndpointObjects` 的 `row.displayName` | inline-literal | `gateway.js:1380-1392` `_resolveApiProviderLabel`（读 DISPLAY_NAMES）；:1593,:1697 displayName 取值 | D1-no-literal | `customMeta?.name` 优先，其次本表，最后回退 provider 原值 |
| F2-E11 | `src/cli/handlers/gateway.js:envMap` | `src/cli/handlers/gateway.js` token 来源描述（`maskTokenValue` 脱敏后） | inline-literal | `gateway.js:1873-1882`（※L1-5：实测 **10 项**，原记 9 项）；:1884-1886 `process.env[envKey]` + `maskTokenValue`；maskToken 真源 `src/utils/maskToken.js:22-31` | D1-no-literal | 第三份 provider→env key 表（前两份是同文件的 `API_PROVIDER_ENV_KEYS` 与 `DISPLAY_NAMES`）。此处 token 经 `maskTokenValue` 脱敏后才进返回值 `{source, detail}`，不返原文 |
| F2-E12 | `src/services/apiKeyPool.js:ENV_KEY_MAP`（:97-152，13 项含 default 端点） | `src/services/apiKeyPool.js:init()`/`reload()` 的 env 合并 | inline-literal | `apiKeyPool.js:97-152`；:232-233、:370-378 两处 `for..of Object.entries` 合并；:936-963 `_collectProviderEnvKeys` | D1-no-literal | 合并口径：只认 `ENV_KEY_MAP` 里登记的 13 个 provider，且每个只读 `<PRIMARY>_API_KEY` 加前缀派生的 `<P>_API_KEYS` / `<P>_API_KEY_1..10`，不读裸 `<P>_API_KEY`。providerPresets 的 15 个 id 中 gemini/vertex/shengsuanyun/packycode/moonshot/openrouter/groq/together/ollama/zhipu 共 10 个根本不在表内 → 这些 provider 的 env 单 key 永不被池合并 |
| F2-E13 | `src/services/gateway/builtinProviderConfig.js:BUILTIN_PROVIDERS`（:32-126，11 条，含 `poolKey:null` 的 HuggingFace） | `src/cli/handlers/gateway.js:getProviderKeyChoices` 等多处 | inline-literal | `builtinProviderConfig.js:32-126`；:152-154 `listBuiltinProviders`、:165-190 `findBuiltinProvider`；:122 `require('../../constants/serviceDefaults').ZEN_BASE_URL` | D1-no-literal | 数据表内联 require constants（:122），故它不是一个可 JSON 化的纯字面量表。消费方：`gateway.js:2732`、`cli/onboarding.js:134`、`tools/ConfigureModelProvider/index.js:30,176`、`providerConnectivitySpec.js:26`、`localBrainProviderConfig.js:205,262,401` |
| F2-E14 | `src/services/gateway/gatewayGuide.js:ENV_BY_ID`（:63-71，7 项） | `src/services/gateway/gatewayGuide.js:buildKeyReferences()` 的 `envVar` 字段 | inline-literal | `gatewayGuide.js:63-71`；:75-84 `envVarForId`；:89-100 `buildKeyReferences` 输出 envVar | D1-no-literal | 第四份 provider→env key 表。zhipu→`GLM_API_KEY`（id 与 env 前缀不一致）；gemini/moonshot 只在本表出现，`ENV_KEY_MAP` 无对应项 → 用户按提示设 `GEMINI_API_KEY`/`MOONSHOT_API_KEY` 对池无效。`buildKeyReferences` 同时外泄 `keyExample`（占位示例文本，非真 key） |
| F2-E15 | `src/utils/dataHome.js:getAppHome` | `src/cli/handlers/gateway.js:api_keys.json` 读取 | homedir-path | `dataHome.js:662-711`；`gateway.js:1620-1621,1723-1724`（try 内）；:1625-1626,1728-1729 `fs.existsSync`+`readFileSync` | none | dataHome 是 B8 唯一正解，本条边本身合规。注意两个 collector 各自重复了一遍「getAppHome→api_keys.json」读取逻辑（:1615-1640 与 :1719-1778 近乎同构），是同一份读取的两份拷贝 |
| F2-E16 | `src/cli/handlers/gateway.js` homedir 兜底路径 | `src/cli/handlers/gateway.js:poolFile` | homedir-path | `gateway.js:1623、:1726` `path.join(os.homedir(), '.khyquant', 'api_keys.json')`；`gatewayStatusView.js:31-39` `_appHomeFile` 同型兜底 | D1-no-literal | `getAppHome()` 抛异常时静默改读另一棵树。B8 的病灶正是「同一份代码在不同 cwd/环境下读写不同数据家」；这里是同病灶的 catch 分支形态。方案 §1.1 #17 已登记 `services/domain/` 的同类问题，`cli/handlers` 这 3 处未被计入 |
| F2-E17 | env `KHY_BUILTIN_AGNES_KEY` / `KHY_BUILTIN_SENSENOVA_KEY` | `src/cli/handlers/gateway.js:_collectConfiguredEndpointObjects` 的 `keyCount` | env-read | `apiKeyPool.js:157-178` `_getBuiltinProviderKeys`（只读 env，源码无硬编码 key）；:983 导出；`gateway.js:1745-1754` `addEntry(provider, cfg.endpoint, cfg.key, 'built-in')` | none | R2 合规段：`cfg.key` 只进 :1584 `keySig` 去重签名与 :1611 `keyCount` 计数，row 对象只落 provider/displayName/endpoint/defaultModel/keyCount/sources——返回值路径上不出现 key 原文 |
| F2-E18 | `src/services/apiKeyPool.js:listAvailableKeys` | `src/services/domain/network/externalApps/_shared.js:resolveApiKey` | function-call | `apiKeyPool.js:665-681`（JSDoc 自述「raw key for internal gateway use」）；:771 `getPoolStatus` 用 `maskKey(e.key)` 预览；`externalApps/_shared.js:161-175` | none | 裸 key 离开 apiKeyPool 进入外部 app 配置写者（同目录 12 个 `*Adapter` 的 `upsertDotenv`/`atomicWrite`）。另约 9 处消费方（imageGenService/videoGenPoolBridge/keyHealthProbe/aiGatewayGenerateMethod 等）同样拿到裸 key。检索路径（`getPoolStatus`/`getAllStatus`）走 `maskKey` 脱敏 |
| F2-E19 | `src/services/builtinGlmKey.js:GLM_PLACEHOLDER_KEY` | `src/services/apiKeyPool.js` glm 池 priority-0 占位条目 | inline-literal | `builtinGlmKey.js:31` 字面量、:27-29 安全铁律注释、:80,:87 组装条目 | none | 全仓唯一随 pip 包分发的 key 形态字面量。值是一眼假的占位串（含 not-a-real-key / configure-your-own 字样），且条目带 `placeholder:true`、`priority:0`，任何真 key 都盖过它——符合 R2「占位 key 必须一眼假」。方案 §2.3 的 schema 断言 `/(sk-\|AKIA\|Bearer \|-----BEGIN)/` 不会命中它 |
| F2-E20 | `src/services/gateway/adapters/kiroAdapter.js:REGION_ENDPOINTS`（:247-255）+ `REGION_ENDPOINTS_CN`（:256-259）+ `DEFAULT_REGION`（:260） | `src/services/gateway/adapters/kiroAdapter.js:resolveAdapterEndpoint` | inline-literal | `kiroAdapter.js:247-260`；:1287-1291 `resolveAdapterEndpoint` | D1-no-literal | 实测 9 个 region（7 全球 + 2 CN），方案 §1.1 #13 与 §2.1 记为「10 region」，且符号名写作 `KIRO_REGION_ENDPOINTS`（实为 `REGION_ENDPOINTS`/`REGION_ENDPOINTS_CN`），搬迁时按方案名 grep 会找不到 |
| F2-E21 | `src/services/gateway/adapters/kiroAdapter.js:KIRO_BASELINE_MODELS`（:285-363，11 条） | `kiroAdapter.js:ListAvailableModels` 不可达时的静态回退清单 | inline-literal | `kiroAdapter.js:285-363`；:371 `KIRO_INJECTED_CLAUDE_MODELS` 派生；:372-374 `KIRO_INJECT_CLAUDE` 门控 | D1-no-literal | 文件 2659 行，方案 §4 B6 目标是把这三组搬进 `config/gateway/kiro.json` |
| F2-E22 | `src/services/gateway/adapters/kiroAdapter.js:SOCIAL_REFRESH_URL`（:95，`https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken`） | `src/services/gateway/adapters/kiroAdapter.js` token 刷新路径 | inline-literal | `kiroAdapter.js:95`；对比 :83 `KIRO_LOGIN_URL` 有 env 覆盖口 | D1-no-literal | 无 env 覆盖口，与同文件 `KIRO_LOGIN_URL` 的模式不统一。方案 §4 B6 明写「为 `SOCIAL_REFRESH_URL` 补 env 覆盖口」 |
| F2-E23 | `src/constants/models.js:53` `ZHIPU_DIRECT_MODELS=['glm-4']`、:81 `PRIMARY.zhipuDirect` | `src/routes/ai.js` 智谱AI provider 的默认模型 | require | `constants/models.js:53,81`；`routes/ai.js:792-796` | D1-no-literal | GLM 模型清单的第三条副本，静态停在 glm-4。`zhipuGlmModel.js:6-8` 自述「三处 SSoT 仍停留在 glm-4 世代」，但修法只在 providerPresets 与 builtinProviderConfig 两个调用点覆写；本副本作为兜底值仍与门控后的真源不一致 |
| F2-E24 | `src/routes/ai.js` GLM v4 端点字面量（:800 `https://open.bigmodel.cn/api/paas/v4/chat/completions`） | `src/routes/ai.js:postProvider` | inline-literal | `routes/ai.js:800`；同文件 :786-798 智谱AI 分支 | D1-no-literal | `serviceDefaults.js` 中无 GLM/智谱端点常量（只有 5 个 provider preset 端点），故此处无处可 require，只能写字面量 |
| F2-E25 | `src/services/apiKeyPool.js:maskKey` | `src/services/apiKeyPool.js:getPoolStatus` 的 `keyPreview` | function-call | `apiKeyPool.js:929-934`（阈值 10、前6...后4）；:771 `keyPreview`；对比 `src/utils/maskToken.js:22-31`（阈值 10、前3\*\*\*/前6\*\*\*后4、空→'(empty)'）与 `src/utils/maskSecret.js:22-29`（阈值 8、前2\*\*\*\*/前4...后2、空→''） | none | `maskSecret.js:14-17` 的自述注释明确把「阈值 len<=10、露后4、分隔符 \*\*\*/… 的变体」列为刻意不收敛项，`apiKeyPool.maskKey` 与 `externalApps/_shared.js:196` 的 `maskKey`（头尾各 4、分隔符 …）正是这两个变体。四条脱敏口径在同一个供应商/渠道数据流内并存 |
| F2-E26 | env `KHY_FREE_MODEL_CHANNELS` | `src/services/freeModelChannels.js:listFreeModelChannels` | env-read | `freeModelChannels.js:97-121` `freeModelChannelsEnabled`、:163-179 `_readEnvOverrides`；`utils/flagRegistry/index.js:3150` `KHY_FREE_MODEL_CHANNELS` `{mode:'default-on'}` | none | 同一个 env 名兼两种语义：非 JSON 时当开关词（0/false/off/no 关），以 `'['` 开头时当 JSON 覆盖数组（:170 的 `startsWith('[')` 判别）。设成 JSON 数组时 `freeModelChannelsEnabled` 也返回 true（不在 `OFF_VALUES`），即「给数据」隐含「开门」。目标态 ConfigResolver 需把门控与数据拆成两个键 |
| F2-E27 | `runtime/node/ai-backend/src/routes/userGateway.js:GET /api/user-gateway/provider-presets` | `delivery/web/ai-frontend/src/views/MyGateway.vue` | function-call | `userGateway.js:33` `require('../../../backend/src/services/gateway/providerPresets')`、:205-211 `res.json({success,data:getProviderPresets()})` | none | providerPresets 唯一的 HTTP 出口，跨包 require backend/src 的 D1 模块（ai-backend 与 backend 是两个 npm workspace）。响应只含 `getProviderPresets()` 的 sanitize 结果（无 key/apiKey 字段），R2 合规 |
| F2-E28 | `delivery/web/ai-frontend/src/views/admin/AIGateway.vue:relayProfilePresets`（:2062-2100，value/label/category/baseUrl/apiFormat/apiKeyField/defaultModel） | `delivery/web/ai-frontend/src/views/admin/AIGateway.vue` relay profile 表单预填 | inline-literal | `AIGateway.vue:2062-2100`；`providerPresets.js:52-54` 注释自述「权威值取自 AIGateway.vue relayProfilePresets + customProviderRegistrar Agnes」 | D1-no-literal | 前端平行副本，且已实测漂移：anthropic 的 `defaultModel` 前端为 `claude-sonnet-4-20250514`（:2087 附近），后端 preset 为 `claude-sonnet-4-6`；openai 的 baseUrl 前端带 /v1 后缀而后端 preset 亦带 /v1（此条一致）。「两份都在争真源地位」的典型 |

#### 3.2.2 真源清单（13）

| # | 路径 | 角色 | driftRisk |
|---|---|---|---|
| T2-1 | `src/services/gateway/providerPresets.js` | 供应商预设单一真源（后端 15 条 preset：id/label/baseUrl/apiFormat/keyField/defaultModel/models/tier/links/keyExample）。无密钥、env 按 id 合并覆盖、URL 从 serviceDefaults 导入——方案 §1.1 #14 称其为「本仓最好的数据外置范式之一」，但 300 行纯数据表住在 services/ 逻辑层 | contested |
| T2-2 | `src/services/gateway/zhipuFreeModels.js` | 智谱免费模型的权威源（7 个 `{id, modality, label}` + `CHAT_MODALITIES` + `RETIRED_ZHIPU_REMAP` + `augmentGlmPoolModels`）。`freeModelChannels.js:20` 注释明文裁定权威源在本文件。※L2-7：driftRisk 由 `contested` 保留并确认为**主归属**（模型流/持久化流原标 single-source/duplicate，本图统一为 contested） | contested |
| T2-3 | `src/services/freeModelChannels.js` | 免费渠道发现/建议层（4 条渠道 + 一句话无 SLA 披露 + 一行摘要）。zhipu 条的 7 个 freeModels 是 `zhipuFreeModels` 的手抄副本（当前逐字节一致，无机械同步） | duplicate |
| T2-4 | `src/cli/handlers/gateway.js` | API 目录（:1445-1457 显示名 11 项 + :1459-1504 env 键与默认端点 11 项 + :1873-1882 第三张 env key 表 10 项）。方案 §4 B3 的搬迁源 | contested |
| T2-5 | `src/services/apiKeyPool.js` | `ENV_KEY_MAP`（:97-152，13 个 provider 的 env 键名 + 默认端点）+ api_keys.json 凭据存储 + env 自动合并（只认这 13 个键） | duplicate |
| T2-6 | `src/services/gateway/builtinProviderConfig.js` | `BUILTIN_PROVIDERS`（:32-126，11 个内置 provider 的 poolKey/envKey/envEndpoint/defaultEndpoint/models），Key 池的内置厂商目录 SSoT，被 `providerConnectivitySpec` 复用 | duplicate |
| T2-7 | `src/services/gateway/gatewayGuide.js` | `ENV_BY_ID`（:63-71，7 个 provider id → env 变量名），「去哪申请 Key」指引层的 env 名推导 | duplicate |
| T2-8 | `src/services/zhipuGlmModel.js` | GLM 默认模型 + 已知清单的门控叶子（`KHY_GLM_LATEST_MODEL`）。自述收敛「三处 SSoT」，但 `constants/models.js:53` 的静态兜底未被覆写 | duplicate |
| T2-9 | `src/constants/models.js` | `ZHIPU_DIRECT_MODELS = ['glm-4']`（:53）+ `PRIMARY.zhipuDirect`（:81），`routes/ai.js` 的智谱直连默认模型兜底 | duplicate |
| T2-10 | `src/constants/serviceDefaults.js` | 端点 SSOT（:152-158 定义 5 个 provider preset 端点常量，:146-150 注释自称 providerPresets 的 endpoint SSOT）。CLAUDE/OPENAI/RELAY/LOCAL_LLM/GLM 端点常量缺席，故这 5 个之外的所有端点只能写字面量 | contested |
| T2-11 | `src/utils/dataHome.js` | 数据家路径解析唯一正解（`getDataHome`/`getAppHome`/`getLegacyDataHome`/`getDataDir`）。B8 门禁的执行面 | single-source |
| T2-12 | `src/services/builtinGlmKey.js` | `GLM_PLACEHOLDER_KEY`（:31）——全仓唯一随 pip 分发的 key 形态字面量，一眼假、`placeholder:true`、priority 0 | single-source |
| T2-13 | `delivery/web/ai-frontend/src/views/admin/AIGateway.vue` | `relayProfilePresets`（:2062 起）——前端平行副本的供应商预设表，anthropic defaultModel 已与后端 preset 漂移 | duplicate |

#### 3.2.3 目标流（187 方案条文摘录）

**【§2.1 新目录 · 本域】**：`config/gateway/kiro.json`（新增：KIRO region 端点 + 基线模型 + `SOCIAL_REFRESH_URL`）；`src/data/gateway/provider-presets.json`（新增：从 `services/gateway/providerPresets.js` 搬入）；`src/data/gateway/free-model-channels.json`（新增：从 `services/freeModelChannels.js` 搬入）；`src/data/apiProviderCatalog.json`（新增：从 `cli/handlers/gateway.js:1445-1520` 搬入）；`src/dataAccess/`（唯一抽象层·接口层，新建 src 顶级目录）：`index.js` 门面、`khy.module.json`、`di/tokens.js`、`di/registry.js`、`loaders/jsonRepository.js`、`loaders/dataCardLoader.js`、`configResolver.js`、`schema.js`、`contracts.js`、`paths.js`、`repositories/`（含 `apiProviderCatalog.js`；`providerPresets.js` 的仓储签名在 §2.4.8）。

**依赖方向**：组装层 `bootstrap/` ──> 逻辑层 `services/` ──> 抽象层 `src/dataAccess/` ──> 数据层 `src/data/`；`constants/` 纯叶例外允许直接 import。禁止 数据层──>逻辑层/抽象层、抽象层──>逻辑层。

**【§2.3 密钥边界（R2）】**：真 key/token 只经 env 瞬时注入、绝不落盘；出厂件仅允许 XOR 混淆形态；数据文件零密钥；`providerPresets` / `apiProviderCatalog` 的装载器必须过 `stripSecrets()`，schema 断言无值匹配 `/(sk-\|AKIA\|Bearer \|-----BEGIN)/`；环境配置 vs 业务配置分居不同文件、不同加载路径、不同守卫。

**【§2.4.8 仓储接口 · 本域两条】**：`providerPresets.js` —— R2: `stripSecrets()` runs on every return path；`{ list, get, mergedWith(envJson), stripSecrets(record) }`；`apiProviderCatalog` 的 Repository 在 §2.1 `repositories/` 列出（B3 验收命令给 `apiProviderCatalog.test.js` 无值匹配 `/(sk-\|AKIA\|Bearer \|-----BEGIN)/`）。

**【§2.0 裁定】**：裁定 E —— ENDPOINT_SSOT 保留既有 env 名（`CLAUDE_API_ENDPOINT` 等），并明确求值时机（serviceDefaults 既有范式是 require 时求值，不全局改 getter）；裁定 I —— `src/config` 归属：`*.json` 入数据层，`*.js` 入抽象层；裁定 H —— 新守卫必须接线 + 登记 rollout，B1–B10 每批跑三守卫。

**【§4 批次 · 本域】**：B3 · 供应商与策略目录：`cli/handlers/gateway.js:1445-1520` → `src/data/apiProviderCatalog.json` + `ApiProviderCatalogRepository`；B6 · 目录数据外置：`kiroAdapter.js` → `config/gateway/kiro.json`（为 `SOCIAL_REFRESH_URL` 补 env 覆盖口）；`providerPresets.js` → `src/data/gateway/provider-presets.json`；`freeModelChannels.js` → `src/data/gateway/free-model-channels.json`（明写「与 `gateway/zhipuFreeModels.js` 的 7 模型清单当前逐字节一致，权威源已由 `freeModelChannels.js:20` 注释裁定，合并时保留 `zhipuFreeModels` 的门控与 `augmentGlmPoolModels` 逻辑在 JS 侧」）；B0 · 前置与骨架（零行为变更，纯新增）：dataAccess 骨架。§1.1 #13/#14/#15 是方案对本域三个耦合点的现状记载（严重度均为 medium/low）。

#### 3.2.4 差异点表（20）

| # | 差异点 | 现状 | 目标态 | 批次 | 风险 |
|---|---|---|---|---|---|
| Δ2-1 | 抽象层 `src/dataAccess/` 整体不存在 | `src/dataAccess/` 目录不存在（src 下无 dataAccess）；DI registry、jsonRepository、dataCardLoader、configResolver 全部缺失；`scripts/ci/` 下无 `check-data-logic-separation.js` / `check-data-layer-purity.js` / `check-env-defaults.js` | §2.1 新建 `src/dataAccess/`（index.js 门面 + di/tokens.js + di/registry.js + loaders/jsonRepository.js + loaders/dataCardLoader.js + configResolver.js + repositories/），§2.4.1-2.4.8 给足签名；§2.0 裁定 H 要求新守卫必须接线 + 登记 rollout | B0 | blocking |
| Δ2-2 | 三份目标 JSON 数据文件全部不存在 | `providerPresets.js`（470 行，15 条字面量）、`freeModelChannels.js`（255 行，4 条）、`kiroAdapter.js`（2659 行）三处数据全住在 services/ 逻辑层；`src/data/` 下只有 bugCases.js、publicApis.json、curriculum.json、cliAnythingRegistry、cliAnythingTemplates，无 gateway/ 子目录；`config/` 下只有 models/{features,pricing,routing-modes}.json、resources.json、runtime-binaries.json，无 gateway/kiro.json | §2.1：`src/data/gateway/provider-presets.json`、`src/data/gateway/free-model-channels.json`、`config/gateway/kiro.json` | B6 | blocking |
| Δ2-3 | `stripSecrets()` 装载器不存在 | 无 `stripSecrets` 符号（全仓 grep 0 命中）。现行等价物是 `providerPresets.js:356-394` `sanitize()`——白名单构造式，在 `getProviderPresets()` 每条入口执行，`raw.key`/`raw.apiKey` 一律不拷贝；已有测试 `tests/root-level/providerPresets.test.js:112-119` 断言 env 覆盖带 key 时被打掉 | §2.3 / §2.4.8：providerPresets 仓储提供 `stripSecrets(record)`，且「`stripSecrets()` runs on every return path」 | B3 / B6 | medium |
| Δ2-4 | 方案的 schema 密钥断言会误报合法的占位 keyExample | `provider-presets.json` 若按字面搬迁，`keyExample` 字段会带入 `'sk-agnes-xxxxxxxxxxxxxxxx'`（`providerPresets.js:168`）与 `'sk-or-v1-xxxxxxxxxxxxxxxx'`（:264）两个占位示例——二者都以 `sk-` 开头 | §2.3：schema 断言数据文件无值匹配 `/(sk-\|AKIA\|Bearer \|-----BEGIN)/`；§4 B3 验证命令对该正则跑 `apiProviderCatalog.test.js` | B6 / §2.3 | high |
| Δ2-5 | 端点 SSOT 只覆盖 5/15 preset，且 provider-presets.json 与 env 可覆盖端点存在结构性冲突 | `serviceDefaults.js:152-158` 只定义 5 个 preset 端点常量（OPENROUTER/GROQ/TOGETHER/DEEPSEEK/OLLAMA_OPENAI），CLAUDE/OPENAI/RELAY/LOCAL_LLM 端点常量缺席（§2.0 裁定 E 已实测记载）。15 条 preset 中 10 条 baseUrl 是文件内 URL 字面量。GLM v4 端点作为数据值在 src 内有 8 处副本：`providerPresets.js:236`、`builtinProviderConfig.js:54`、`apiKeyPool.js:121`、`gateway.js:1478`、`routes/ai.js:800`、`builtinGlmKey.js:32`、`zhipuFreeModels.js:29`（死导出）、`multiFreeService.js:2132` | 裁定 E：`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` 入 `serviceDefaults.js`，保留既有 env 名（`CLAUDE_API_ENDPOINT` 等）作主覆盖，不废弃 | 裁定 E | high |
| Δ2-6 | `provider-presets.json` 无法成为「纯内容资产」——数据表内联 require env 可覆盖常量 | `providerPresets.js:25-31` require `constants/serviceDefaults` 取 5 个 baseUrl，`builtinProviderConfig.js:122` 在数组字面量内 require `ZEN_BASE_URL`——两者都不是可 JSON 化的纯字面量 | §2.2：`src/data/` 为 D6，硬禁「不得 require D1/D2/D4；不得含 IO；不得含 process.env」 | B6 | high |
| Δ2-7 | provider→env key/默认端点 的「单一真源」实际有五份，方案只认定其中一份 | 五份平行表，键空间互不相同：(1) `providerPresets.js:64` 的 15 个 preset id；(2) `apiKeyPool.js:97` `ENV_KEY_MAP` 13 键；(3) `gateway.js:1459` `API_PROVIDER_ENV_KEYS` 11 键（是 ENV_KEY_MAP 的子集，缺 agnes/stepfun）；(4) `builtinProviderConfig.js:32` `BUILTIN_PROVIDERS` 11 个 poolKey（多 opencode-zen 与一个 `poolKey:null` 的 HuggingFace，少 codex）；(5) `gatewayGuide.js:63` `ENV_BY_ID` 7 键（多 zhipu/gemini/moonshot）。方案 §4 B6 只搬第 1 份入 JSON，未提另外四份 | §2.1：`src/data/apiProviderCatalog.json` + `ApiProviderCatalogRepository` 收敛「provider → 显示名 / env 键 / 默认端点」；§2.4.8 给 get/list 签名 | B6 / §2.2 | high |
| Δ2-8 | env 自动合并只认 `ENV_KEY_MAP`，导致 gatewayGuide 文档化的一半 provider 设了 env 也无效 | `apiKeyPool.js:232-233` 与 :370-378 只遍历 `ENV_KEY_MAP` 的 13 个 provider；`_collectProviderEnvKeys`(:936-963) 只读 `<PRIMARY>_API_KEY` + 前缀派生的 `<P>_API_KEYS` / `<P>_API_KEY_1..10`，不读裸 `<P>_API_KEY`。故 providerPresets 的 15 个 id 中 gemini/vertex/shengsuanyun/packycode/moonshot/openrouter/groq/together/ollama/zhipu 共 10 个的 env 单 key 永不被池合并；而 `gatewayGuide.js:63-71` 恰恰在教用户设 `GEMINI_API_KEY` / `MOONSHOT_API_KEY` | （方案未涉及，属重构暴露出的既有缺陷） | （无批次） | high |
| Δ2-9 | CLI 两个 endpoint collector 覆盖的 provider 源不一致，状态面少报 | Rows collector（`gateway.js:1563-1665`）只读 api_keys.json + `API_PROVIDER_ENV_KEYS`(11)；Objects collector（:1667-1778）读 api_keys.json + `_getBuiltinProviderKeys`(2) + `API_PROVIDER_ENV_KEYS`(11)。两者都不读 `ENV_KEY_MAP`(13)，且都不读 `custom_providers.json` 的 key（`_getCustomProviderMap:1539-1559` 只取 name/endpoint/defaultModel） | §2.4.8 `ApiProviderCatalogRepository` + `apiProviderCatalog.json` 单一口径 | B3 | medium |
| Δ2-10 | freeModelChannels 的智谱 7 模型清单不随 `KHY_ZHIPU_FREE_MODELS` 门控 | `freeModelChannels.js:187-215` `listFreeModelChannels` 只看 `KHY_FREE_MODEL_CHANNELS` 门控；zhipu 条的 7 个免费模型 id 与 `KHY_ZHIPU_FREE_MODELS` 门控无关。`tools/ConfigureModelProvider/index.js:472-483` 只要前者开就向用户广告这 7 个模型 | §4 B6 明写「与 `gateway/zhipuFreeModels.js` 的 7 模型清单当前逐字节一致，权威源已由 `freeModelChannels.js:20` 注释裁定，合并时保留 `zhipuFreeModels` 的门控与 `augmentGlmPoolModels` 逻辑在 JS 侧」 | B6 | medium |
| Δ2-11 | 免费渠道摘要承诺的模型数（7）大于 /model 选择器实际可见数（5） | `KHY_ZHIPU_FREE_MODELS` 开门时 `zhipuFreeModels.js:72` `CHAT_MODALITIES` 只放 chat/vision 5 个进聊天目录（cogview-3-flash 图像、cogvideox-flash 视频排除）；`freeModelChannels.js:32` note 写「7 个永久免费 Flash 模型」并原样列出 7 个 id | （方案未涉及） | （无批次） | low |
| Δ2-12 | env/appHome 两层对供应商数据今天是零覆盖，方案新增 appHome 层属新功能 | `providerPresets.js:400-411` 与 `freeModelChannels.js:163-179` 各只有一个 env inline 层，全仓 grep 无 `provider_presets.json` / `free_model_channels.json` 的 appHome 读取。既有三层样板见 `routingMode.js:634-673`（env inline > appHome 覆盖 > 仓内文件） | §2.4.5 ConfigResolver 四层优先级：env 内联 → `<appHome>/<file>` 运维覆盖 → `config/<file>` 出厂 → 代码兜底 | （无批次） | medium |
| Δ2-13 | 门控解析路径三种姿势：flagRegistry-first、纯 env、完全不经门控 | `freeModelChannels.js:97-121` 与 `zhipuFreeModels.js:88-112` 各自 lazy require `./flagRegistry` 或 `../flagRegistry`，registry 不可用时回退本地 `OFF_VALUES` 解析；providerPresets 的 env 覆盖则完全不经 flagRegistry | §2.4.5 ConfigResolver 收敛 env 读取 | （无批次） | low |
| Δ2-14 | `DATA_CARD_LOADER` 的通用签名会把「合并语义差异」抹平 | 四类合并/失败语义各异：routingMode 的 env inline 零合并直返 + appHome per-mode 浅合并（:637-667）；providerPresets 的按 id 覆盖/新增（:447-460）；freeModelChannels 的按 key 覆盖/新增（:199-210）；`localBrainService._getPublicApis` 无 env 无 appHome 静默 `{apis:[]}` | §2.4.4：`loadDataCard` 降为抽象层私有实现细节，对逻辑层只暴露四个命名装载器，各自声明合并策略与失败策略 | §2.4.4 R-11 | medium |
| Δ2-15 | 脱敏口径四套，且其中两套被文档明确「刻意不收敛」 | 四种口径并存：`utils/maskToken.js:22-31`（阈值 10、前3\*\*\* / 前6\*\*\*后4、空→'(empty)'）；`utils/maskSecret.js:22-29`（阈值 8、前2\*\*\*\* / 前4...后2、空→''）；`apiKeyPool.js:929-934`（阈值 10、前6...后4）；`externalApps/_shared.js:196-202`（头尾各 4、分隔符 …）。`maskSecret.js:14-17` 明确把后两者列为「刻意不收敛」 | （方案 §2.3 只规定 schema 断言与 stripSecrets，未规定脱敏口径统一） | （无批次） | medium |
| Δ2-16 | `api_keys.json` 路径解析有 3 处 homedir 兜底，绕过 dataHome | `cli/handlers/gateway.js:1623` 与 :1726（`getAppHome()` 的 catch 兜底）、`cli/handlers/gatewayStatusView.js:31-39` `_appHomeFile` 同型兜底，共 3 处 `path.join(os.homedir(), '.khyquant', ...)` | B8：状态目录一律经 `utils/dataHome` 解析器取址，禁止 cwd/homedir 相对写者 | B8 / §1.1 #17 | medium |
| Δ2-17 | DI token 已定义但注册表与仓储实现均不存在 | TOKENS 表在方案里有 `PROVIDER_PRESETS: 'repo.providerPresets'` 与 `API_PROVIDER_CATALOG: 'repo.apiProviderCatalog'`，但 `src/dataAccess/di/tokens.js` 与 `di/registry.js` 均不存在，无任何 register 调用点 | §2.4.1/§2.4.2：DI token 表 + register/resolve/createScope/resetForTest 注册表；§3.4 组装层在 `bootstrap/init.js` 第一顺位注册 | §2.4.1 | blocking |
| Δ2-18 | R2 的新增守卫（check-data-logic-separation / check-data-layer-purity）不存在 | guard 侧只有 `scripts/ci/check_builtin_keys.py`（针对 Flutter built_in_keys.dart 的 XOR 混淆件解码，与本域无关）、`check-agent-rules.js` 的 `no-hardcoded-prod-domain`、`check-data-layout.js`（L-3 查 .khy/.khyos 字面拼接，管运行时数据态不管 src/） | §2.3：`check-agent-rules.js` 的 `no-hardcoded-prod-domain`（白名单只含 serviceDefaults.js 系）+ 新增 `check-env-defaults.js`；`check-data-logic-separation.js` 的 denylist + `check-data-layer-purity.js` | B1 / §2.3 | high |
| Δ2-19 | 种子数据的冻结状态三份不一致 | `providerPresets.js:15-18` 与 `freeModelChannels.js:12-14` 的注释都宣称「Overridable, not frozen」，但 `PROVIDER_PRESETS` 与 `FREE_MODEL_CHANNELS` 两个数组本身未 `Object.freeze`；`getProviderPresets` 每次返回全新深拷贝（`tests/root-level/providerPresets.test.js:135-145` 有隔离断言），`zhipuFreeModels.js:39` 则 `Object.freeze` 了三层 | （方案未规定冻结） | B6 | low |
| Δ2-20 | `PROVIDER_PRESETS` 原始种子被直接导出，绕过 sanitize 与 env 合并 | `providerPresets.js:469` 导出 `PROVIDER_PRESETS`（未经 sanitize、未应用 env 覆盖的原始种子），注释自述「Exposed for tests/derivation only」。全仓 grep 该符号无本仓消费方（仅测试，**src/ only 口径**） | （方案未涉及） | （无批次） | low |

---

### 3.3 流域三：提示词与命令面数据流（59 边 / 13 真源 / 20 差异点）

#### 3.3.1 现状流（边表）

| 边号 | from（产地） | to（消费方） | 机制 | 证据 `file:line` | violates | 说明 |
|---|---|---|---|---|---|---|
| F3-E1 | `src/cli/aiChatCore.js:2119`（chat 主路径） | `src/services/khyUpgradeRuntime.js:1984` `makeSystemPrompt` | function-call | `cli/aiChatCore.js:2119`；`cli/ai.js:702` 同型 | none | **活的** chat 装配入口；`promptAssemblyService` 那条稳定/动态分层链无外部消费者（见 Δ3-5） |
| F3-E2 | `src/services/khyUpgradeRuntime.js:1967` | `src/constants/prompts.js::getSystemPrompt`/`assembleSystemPrompt` | require | `khyUpgradeRuntime.js:1965-1967`（模块顶层解构） | none | prompts.js 唯一的生产装配入口 |
| F3-E3 | `src/services/khyUpgradeRuntime.js:2063,2219` | `src/constants/prompts.js::getOnDemandPromptSections`/`getOutputEfficiencySection`/`getKhySpecificSection`/… | require | `khyUpgradeRuntime.js:2062-2063；:2218-2219`（`KHY_UNIFIED_PROMPT=0` 逃生路径，:2082 注释） | none | 2219 那处拉 12 个 section getter，是 legacy 内联装配的逃生舱，注释明说 byte-identical to today's modular output |
| F3-E4 | `src/constants/prompts.js:18` | `src/services/selfProfile.js` | require | `constants/prompts.js:18` | D6-purity | **裁定 C 明令保留并登记 allowlist 的那一条**。今天在 arch-debt-baseline 里计 1 条 d3-purity |
| F3-E5 | `src/constants/prompts.js:2324` | `src/services/selfProfile.js::formatForSystemPrompt` | function-call | `constants/prompts.js:2322-2326`（`getKhySpecificSection` 内） | D6-purity | self-awareness 段的唯一产出点。**同步**在装配期求值，无 provider/注册表机制。profile 缺省时 `selfProfile.js:835-837` 回调 `getFullProfile()` |
| F3-E6 | `src/services/selfProfile.js:834-1105`（`formatForSystemPrompt`） | `src/services/{modelIdentityTruth,cacheMetricsTruth,visionRoutingTruth,selfAuditRegistry,selfAuditVerifier,confidenceCalibration,clueVault,twentyXMode,docVsMeasuredPolicy}.js`（:851/:876/:899/:915/:920/:946/:964/:985/:1082） | require | `services/selfProfile.js:851,876,899,915,920,946,964,985,1082` | D6-purity | 裁定 C 点名的 9 个 truth 格式器，全部**惰性** require 且各自独立 fail-soft。方案要求它们原样留 services/、由 bootstrap 组合注册 |
| F3-E7 | `src/services/selfProfile.js:1045-1058` | `src/services/selfLocation.js` 与 `src/services/domain/catalog/commandCatalog/commandCatalog.js` | require | `selfProfile.js:108-128`（`getSelfLocation()`/`getCommandCatalog()`，memoized lazy require） | D6-purity | 方案 §3.4 的 provider 组装清单**未列这两个**（只列 9 个 truth 格式器），但它们在今天同一个函数体内、同一时机产出 self-awareness 段 |
| F3-E8 | `src/constants/prompts.js:769,953,1288,1330` | `src/services/fableVoiceProfile.js` | require | `constants/prompts.js:769,953,1288,1330` | D6-purity | 4 处 require 同一模块（纯叶子：`responseFormattingItems`/`toneAndStyleItems`/`errorHandlingItems`），分别追加到 Response formatting / Tone and style / Error handling 三个 section 末尾。除 :18 外第二处被守卫单独点名的边 |
| F3-E9 | `src/constants/prompts.js:980` | `src/services/smallModelPromptTemplates.js`（`buildStructuredFlowOverview()`） | require | `constants/prompts.js:980` | D1-no-literal | small-model 结构化流程提示词正文真源，454 行，方案 §2.1 规划搬到 `src/data/prompts/small-model-templates.js`（纯字面量 JS 数据模块） |
| F3-E10 | `src/constants/prompts.js:1362` | `src/services/repoDisciplineRisk.js` | require | `constants/prompts.js:1362` | D6-purity | 仓库纪律规则此前只以英文散文散落在 prompts.js，已抽到 services/（639 行） |
| F3-E11 | `src/constants/prompts.js:1439,1463,1480` | `src/memdir/memdir.js::loadProjectMemoryPrompt`/`loadProjectProgressPrompt`/`loadMemoryPrompt` | require | `constants/prompts.js:1439,1463,1480` | D6-purity | 3 处打向 `src/memdir/**`——该目录**不在 DOMAIN-DEPS.json 任何域的 roots 里**，domain-direction 守卫对它完全失明（裁定 O 附带着重指出，会给出假绿） |
| F3-E12 | `src/constants/prompts.js:1494,1499` | 用户家 `.khy` 记忆索引（磁盘） | readFileSync | `constants/prompts.js:1488-1499`（`const fs = require('fs')`; `baseDir = path.join(os.homedir(), '.khy')`; `fs.readFileSync(indexPath,'utf-8')`） | D6-purity | **B8 违规**：`path.join(os.homedir(), '.khy')` 是用户家相对字面路径，未经 `utils/dataHome` 解析器（同文件 :1491 又 lazy require 了 dataHome，说明两条路并存）。同时是 D3 内含裸 IO |
| F3-E13 | `src/constants/prompts.js:1581,1627,2869` | `src/constants/systemClock.js` | require | `constants/prompts.js:1581,1627,2869` | none | D3→D3 合法边（systemClock 160 行，含 `formatSystemClockLines`/`clockCacheKey`）。env 以 `{ env: process.env }` 传入 |
| F3-E14 | `src/constants/prompts.js:1600` | `src/services/platformCapabilities.js`（`branchGuidance`） | require | `constants/prompts.js:1600` | D6-purity | 分支指引提示词正文真源在 services/ |
| F3-E15 | `src/constants/prompts.js:1640` | `src/services/geolocationService.js` | require | `constants/prompts.js:1640` | D6-purity | 地理信息注入 system prompt（env_info 段） |
| F3-E16 | `src/constants/prompts.js:1657` | `src/utils/pathCompat.js`（`getDesktopPath`） | require | `constants/prompts.js:1657` | none | D3→D3 合法边（utils 是 D3 roots） |
| F3-E17 | `src/constants/prompts.js:1700,1723,2026,2030,2036,2062,2065` | git CLI（子进程） | process-spawn | `prompts.js:1700` execFile、:1723 execSync、:2026/:2030/:2036/:2062/:2065 execSync×5 | D6-purity | ※L1-6：实测 **3 处 `require('child_process')`（:1700/:1723/:2026）+ 6 次实际派生**（execFile :1701，execSync :1724/:2030/:2036/:2062/:2065），原记「9 处进程派生」不准确。全部发生在 nominally「共享底座纯叶」的 D3 constants 层内，方案 §2.2 的 D3 硬禁「不得含 IO」今天被完整违反；B4 改动清单未提及这 6 次派生 |
| F3-E18 | `src/constants/prompts.js:1740,1741,1762` | 用户家配置文件（磁盘） | readFileSync | `constants/prompts.js:1740-1762`（`const fs = require('fs')`; `const homeDir = os.homedir()`; `fs.readFileSync(filePath,'utf-8')`） | D6-purity | 第二处 `os.homedir()` + readFileSync。`getEnvironmentSection` 内读盘 |
| F3-E19 | `src/constants/prompts.js:1852,2744` | `src/services/instructionFileService.js::loadInstructions`/`discoverInstructionFiles` | require | `constants/prompts.js:1852,2744` | D6-purity | AGENTS.md/CLAUDE.md 等指令文件发现与装载 |
| F3-E20 | `src/constants/prompts.js:1892,2936` | `src/services/personaService.js` | require | `constants/prompts.js:1892,2936` | D6-purity | persona 提示词（`loadPersona` / `personaStamp`） |
| F3-E21 | `src/constants/prompts.js:1914,2950` | `src/services/roleService.js` | require | `constants/prompts.js:1914,2950` | D6-purity | role 提示词（`getActiveRole` / `roleStamp`） |
| F3-E22 | `src/constants/prompts.js:1939,2961` | `src/services/domain/agents/agentFs/agentFsService.js` | require | `constants/prompts.js:1939,2961` | D6-purity | 守卫标记为 **D3→D2**（不是 D1）——domain/ 子树归 D2。`companionPromptSection({level:'L1'})` 与 `activeStamp('L1')` |
| F3-E23 | `src/constants/prompts.js:1950` | `src/services/gitContextService.js`（`formatForSystemPrompt`，380 行） | require | `constants/prompts.js:1950` | D6-purity | git 上下文提示词 |
| F3-E24 | `src/constants/prompts.js:2128` | `src/services/skillSearch.js`（`buildSystemReminder`） | require | `constants/prompts.js:2128` | D6-purity | skill 检索提醒注入 |
| F3-E25 | `src/constants/prompts.js:2170` | `src/services/bootstrapBudget.js`（`injectWithBudget`） | require | `constants/prompts.js:2170` | D6-purity | bootstrap 文件的 token 预算注入 |
| F3-E26 | `src/constants/prompts.js:2716,2749,2819,2827,2838,2918` | 磁盘（memdir 索引 / PROGRESS.md / cwd / references.json） | readFileSync | `prompts.js:2712,2743,2817,2825,2837,2912`（`require('fs')`）+ :2716/:2749/:2819/:2827/:2838/:2918 `fs.statSync` | D6-purity | ※L1-6：实测 **6 处 `statSync`**（原记「约 12 处」）；连同 2 处 `readFileSync`（:1499/:1762）合计 8 处 fs IO。全部用于算 section cacheKey（mtime+size 折进 cacheKey 防冻结）。这是「缓存正确性依赖 IO」的结构性事实，B4a「只换字面量」动不到它 |
| F3-E27 | `src/constants/prompts.js:2477` | `src/services/commentGuidance.js`（`buildCommentGuidanceDirective`） | require | `constants/prompts.js:2477`（env 读 :2472 `KHY_COMMENT_GUIDANCE`） | D6-purity | 注释指引指令 |
| F3-E28 | `src/constants/prompts.js:2489,2493` | `src/services/weakModelGuidance.js`（`wmg.buildWeakModelExemplars(process.env)`） | require | `constants/prompts.js:2489,2493` | D6-purity | 弱模型范例提示词 |
| F3-E29 | `src/constants/prompts.js:2507,2508` | `src/services/procedureCatalog.js`（`pc.buildProcedureDirective(process.env)`） | require | `constants/prompts.js:2507,2508` | D6-purity | 流程目录指令 |
| F3-E30 | `src/constants/prompts.js:2520,2521` | `src/services/toolTierCatalog.js`（`ttc.buildTierDirective(process.env)`） | require | `constants/prompts.js:2520,2521` | D6-purity | 工具分层指令 |
| F3-E31 | `src/constants/prompts.js:2535,2536` | `src/services/externalAgentDirective.js`（`ead.buildExternalAgentDirective(process.env)`） | require | `constants/prompts.js:2535,2536` | D6-purity | 外部代理指令 |
| F3-E32 | `src/constants/prompts.js:2774` | `src/skills/index.js`（`getCachedSkills`） | require | `constants/prompts.js:2774` | D6-purity | `src/skills` 同样不在 DOMAIN-DEPS.json 任何域 roots 里（裁定 O 附带着重点名的 8 处之一） |
| F3-E33 | `src/constants/prompts.js:2818,2826` | `src/memdir/paths.js::getProjectMemoryDir`/`getMemoryIndexPath` | require | `constants/prompts.js:2818,2826` | D6-purity | `memdir/paths.js:66` 自身经 `utils/dataHome` 的 `getProjectDataHome` 解析（B8 合规），但 prompts.js 直读它是 D3→未登记域 |
| F3-E34 | `src/constants/prompts.js:2854` | `src/tools/taskMemorySection.js`（`getTaskMemorySection(process.env)`） | require | `constants/prompts.js:2854` | D6-purity | `src/tools` 不在 DOMAIN-DEPS.json 任何域 roots 里（裁定 O 附带着重指出 D4 的 tools 根指仓库根 `tools/`，不是 `src/tools`） |
| F3-E35 | `src/constants/prompts.js:2905,2913` | `src/services/referencesService.js::buildReferencesContext` | require | `constants/prompts.js:2905,2913` | D6-purity | @alias 外部资源引用上下文；:2912-2918 同时 statSync 折 mtime 进 cacheKey |
| F3-E36 | `src/constants/prompts.js:3017,3025` | `src/services/unknownProblemHandler.js` | require | `constants/prompts.js:3017,3025` | D6-purity | 未知问题处理协议段（on/off 状态行） |
| F3-E37 | `src/constants/prompts.js:3047,3079` | `src/constants/promptCacheOrder.js::partitionDynamicSections`/`isOnDemandRelocationEnabled` | require | `constants/prompts.js:3047,3079` | none | D3→D3 合法边；**模块加载期**调用（:3079 在顶层 const 初始化里） |
| F3-E38 | `src/constants/promptLocales.js:LOCALE_CATALOGS` | `src/constants/prompts.js:1391,2657,2999` | require | `promptLocales.js:18`；`prompts.js:1391`（t）、:2657（tBlock）、:2999（detectLocale） | D1-no-literal | 276 行内联 en/zh/ja/ko 四份文案目录（100 leaf key）——方案 §2.1 规划搬到 `src/data/i18n/prompt.{en,zh,ja,ko}.json`（脚本生成，禁手抄） |
| F3-E39 | `src/constants/prompts.js:1975,2008,2049,2079` | `src/constants/gitWorkflowGuidance.js`（`buildWorkflowAwareness`） | require | `constants/prompts.js:1975,2008,2049,2079` | none | D3→D3；4 处 require 同一 96 行模块 |
| F3-E40 | `src/cli/aiChatCore.js:2154,2244,2258,2288`（约 24 个 `_xxxDirective` 局部变量，每个内联中文模板串） | `src/services/directiveComposer.js::composeDirectives` | inline-literal | `cli/aiChatCore.js:2154-2290`；:2244-2245 `require('../services/directiveComposer').composeDirectives` | D1-no-literal | **方案 §2.1 / B4 完全未覆盖的第二条提示词正文产出链**：约 24 段中文指令正文内联在 5225 行的 D1 逻辑层文件里，由 directiveComposer（265 行，`DIRECTIVE_REGISTRY` 18 个 key + tier 编排 + 协调头文案）整合后 `sp += '\n\n' + _composed`。方案的 D1 硬禁明文禁「提示词正文与用户可见文案」，此处是最大一处违反 |
| F3-E41 | `src/services/promptAssemblyService.js:110`（内联中文 `CODING_STANDARDS`） | system prompt 稳定前缀（理论消费者） | inline-literal | `promptAssemblyService.js:34-36`（require crypto/fs/os/path）、:95-102（`getMemoryDataDir('logs')` + path.join 年月日）、:110-120 | D1-no-literal | **第三条提示词正文链，今天无外部消费者**（src/ only 口径）：grep `buildStableSystemMessage`/`assembleRequestMessages`/`buildDynamicContext` 在 src/ 下除自身与 `khyUpgradeRuntime` 的 re-export 外 0 命中。含内联中文 + 裸 `fs.readFileSync` 读日志 + 手拼路径。方案的目录结构与批次清单均未提及它 |
| F3-E42 | `src/constants/commandSchema.js:2194,2229` | `src/cli/commandAutoRegistry.js::peekCachedCommandNames`/`getCommandNames`/`peekCachedCompletions`/`getCompletions` | require | `commandSchema.js:2194,2229`（`_autoRegistryCommandNames`/`getRouterSubCommands` 内） | D6-purity | 裁定 D 唯二要求搬迁的两行。今天各自包在 try/catch 里，registry 不可用 → 回落静态表（`_autoRegistryCommandNames` catch 返 []） |
| F3-E43 | `src/cli/router.js:236,243,244` | `src/constants/commandSchema.js::getRouterCommandNames`/`getRouterSubCommands` | function-call | `cli/router.js:21-25`（顶层解构）、:236 `commandAutoRegistry.init()`、:243-244 `const COMMANDS = getRouterCommandNames(); const SUB_COMMANDS = getRouterSubCommands();` | none | **模块加载期调用**（裁定 D 明点名）。`init()` 先于 COMMANDS/SUB_COMMANDS 求值，所以今天 :2194 的 lazy require 能拿到已初始化的 registry。改注入式后这一行的执行时机必须由组装层保证，否则首次加载拿到空集 |
| F3-E44 | `src/cli/featureCapabilityMap.js:3,5` | `src/constants/commandSchema.js::getRouterCommandNames` | function-call | `featureCapabilityMap.js:3-5`（`const KNOWN_COMMANDS = new Set(getRouterCommandNames())`） | none | **另一处模块加载期调用**（裁定 D 明点名）。与 router.js 无先后保证，是注入式改造的第二个时序风险点 |
| F3-E45 | `src/services/domain/project/management/parityGuard.js:25,44` | `src/constants/commandSchema.js::getRouterSubCommands` | require | `parityGuard.js:25`（`const schema = deps.commandSchema \|\| require('../../../../constants/commandSchema')`）、:44（`schema.getRouterSubCommands().manage`） | none | **本仓现成的注入式先例**（裁定 D 要求复用同形状）。:44 **无 typeof 守卫**——导出移除即 TypeError，而 `checkParity` 是活的治理函数 |
| F3-E46 | `src/services/knowledgeTeachingService.js:1563` | `src/constants/commandSchema.js::getRouterCommandNames`/`getRouterSubCommands` | require | `knowledgeTeachingService.js:1563-1571`（两个 typeof 守卫） | none | 裁定 D 点名：有 typeof 守卫 → 静默退化成空集 / routerCount=0 |
| F3-E47 | `src/services/selfProfile.js:38,298,659` | `src/constants/commandSchema.js::getRouterCommandNames`/`getBuiltinSlashCommands` | require | `selfProfile.js:36-40`（memoized lazy require）、:298-303、:659 typeof 守卫 | none | 两个调用点：:298 算 `facts.routerCount`/`slashCount`；:659 另一处。均有 typeof 守卫 → routerCount=0 静默退化 |
| F3-E48 | `src/services/domain/catalog/commandCatalog/commandCatalog.js:90,106` | `src/constants/commandSchema.js::getBuiltinSlashCommands`/`getCommandAliases` | require | `commandCatalog.js:90,106`（:74 `@param {object} [deps]` 依赖注入） | none | deps 注入 + typeof 守卫双保险；README 自述「命令清单永远来自 constants/commandSchema SSOT，零 IO 纯叶子」 |
| F3-E49 | `src/services/domain/docs/docsFreshness/docsFreshnessRunner.js:354` | `src/constants/commandSchema.js` | require | `docsFreshnessRunner.js:354` | none | docs 新鲜度 runner 读命令表 |
| F3-E50 | `src/constants/commandHelp.js:100` | `src/constants/commandSchema.js::getBuiltinSlashCommands` | require | `commandHelp.js:100`（`_getSlashIndex`，try/catch） | none | D3→D3 合法边，但它是 commandSchema 的**第 11 个 cli 侧消费者**（方案 §2.0 裁定 D 的「11 个 cli 侧」清单未逐个列出） |
| F3-E51 | `src/cli/{commandRegistry.js:39, commandCatalogUi.js:261/279, helpCard.js:46, formatters.js:518/631, handlers/init.js:614, handlers/maintain.js:237, tui/commandParamSpecs.js:186, tui/hooks/useCompletions.js:75/105, router.js:824}` | `src/constants/commandSchema.js` | require | 见左列行号 | none | 其余 9 个 cli 侧消费者，全部**惰性** require（函数体内），无一在模块加载期解构（除 router.js:21-25 与 featureCapabilityMap.js:3 两处） |
| F3-E52 | `src/services/commandOverlapAudit.js:88,159` | `src/constants/commandSchema.js::getCommandSchema`（输出作入参） | function-call | `commandOverlapAudit.js:88` `auditCommandOverlap(schema, aliases)`、:159 `buildPrimaryCommandPanel(schema, aliases, opts)`；JSDoc :79/:153 `@param schema getCommandSchema() 输出` | none | 方案 §2.0 裁定 D 数的第 8 个 services 侧消费者（参数注入形态）。※L1-2：**「零外部调用者/死代码」结论已撤回**——`runtime/node/backend/tests/services/commandOverlapAudit.test.js` 有 11 个活跃测试（:26/:49/:60/:68/:78 调 `auditCommandOverlap`，:89/:102/:112 调 `buildPrimaryCommandPanel`），原 grep 范围只覆盖 src/ 故漏掉；该文件头 :26-27 自陈「审计原语无门控——它被守卫测试消费、不改运行时行为」 |
| F3-E53 | `src/services/selfCapabilityRegistry.js:129` 与 `src/services/evolutionPolicy.js:333` | `src/constants/commandSchema.js`（作为路径字符串） | inline-literal | `selfCapabilityRegistry.js:129`（`evidenceAnchors.modules` 数组元素）；`evolutionPolicy.js:333`（`trigger` 字段） | none | **不是 require，是字符串指针**。方案 §2.0 裁定 D 把它们算进「8 个 services 侧消费者」，但它们只作机器可读的证据锚点/共变规则触发条件，改 require 路径不影响它们 |
| F3-E54 | `src/constants/commandSchema.js:15,265,898,981,2147,2249`（6 张内联静态表） | `src/constants/commandSchema.js` 的 9 个导出函数 | inline-literal | `commandSchema.js:15` `ROUTER_COMMANDS`、:265 `ROUTER_SUB_COMMANDS`、:898 `CATEGORY_BY_COMMAND`、:981 `BUILTIN_SLASH_COMMANDS`、:2147 `COMMAND_ALIASES`、:2249 `MENU_SUB_SUGGESTIONS` | D1-no-literal | 6 张内联静态表（方案 B4d 说「约 2100 行数据表 → `src/data/commands/{router,slash,menu}.json`」）。`BUILTIN_SLASH_COMMANDS` 单表 :981-2136 约 1155 行（行域为按行号差估算，未逐行确认） |
| F3-E55 | `src/constants/prompts.js:134,141,142,143,164,183,425,501,503`（意图规则引擎全量） | `src/constants/prompts.js:988,998,1085`（`getOnDemandPromptSections` / `listOnDemandPromptSectionIds` / `getModelExecutionGuidance`） | inline-literal | `prompts.js:85-131`（21 个正则常量）、:143-160 `PROMPT_INTENT_REASON_MATCHERS`、:134 `PROMPT_TASK_SCALE_RANK`、:138-142 规则门、:425 `_validatePromptIntentConfig`、:501 模块加载期调用、:503 `_classifyPromptIntentSignals` | D1-no-literal | **意图规则引擎全量**：21 个正则常量 + 16 个 reason matcher（10 个直接正则 test + 6 个 `_matchesX` 辅助函数）+ 17 条 section 规则 + 3 档任务规模 + 规则门。方案 B4b 规划搬 `intentRules.json` + `dataAccess/promptIntent.js`。**注意：方案说「17 条正则」，实测是 21 个正则常量 / 16 个 matcher（其中 6 个不是正则而是函数）** |
| F3-E56 | `src/constants/prompts.js:37` 处 `process.env` | `src/constants/prompts.js` 内部门控与预算参数 | env-read | `prompts.js:266,513,573,601,1432,1520-1524,1531,1551,1582,1628,1960,2028,2114,2116,2213,2221,2247,2472,2491,2493,2508,2521,2536,2708,2725,2739,2770,2854,2869,3047,3072,3079,3113,3165`（37 行） | D6-purity | ※L2-5：**三流统一口径**——37 行含 `process.env`（38 次出现）分解为：**14 处直读**（其中 10 处带 `\|\| 默认值` 兜底：:266/:513/:573/:601/:1432/:2116/:2213/:2221/:2472/:3072）+ **10 处 `isFlagEnabled(..., process.env)`**（:1531/:1960/:2028/:2114/:2247/:2491/:2708/:2739/:2770/:3113）+ **13 处 `{ env: process.env }` 对象透传**（:1582/:1628/:2493/:2508/:2521/:2536/:2854/:2869/:3047/:3079/:3165 等）。原流「29 处裸 `process.env.X \|\| 默认值` 直读」的分解不成立；B4c 只应对前 10 处排队（见 §4.5-b） |
| F3-E57 | `src/services/selfProfile.js:1077` + 8 处 env 传递 | 9 个 truth 格式器的 env 入参 | env-read | `selfProfile.js:1077`（`String(process.env.KHY_SKILL_FORMAT_AWARENESS \|\| 'true')`）；:855/:879/:902/:927/:951/:968/:997/:1090 `{ env: process.env }`；:996 `describeTwentyXState(process.env)` 位置参数 | none | 裁定 C 点名的实测证据全部核实：1 处裸 env 直读 + 8 处 env 透传（7 对象形 + 1 位置形） |
| F3-E58 | `src/constants/systemPromptSections.js:96` | `src/constants/prompts.js::getSystemPrompt` 返回的 sections 数组 | function-call | `systemPromptSections.js:84` `resolveSystemPromptSections`、:96 `if (value != null) { results.push(value); }` | none | **段级 null 丢弃点**。`khy_specific` 段（:2981-2992）的 compute 永不返 null（`formatForSystemPrompt` 至少产出 `# Runtime`/`Adapter:` 两行），所以今天这条丢弃逻辑对 self-awareness 段不生效 |
| F3-E59 | `src/constants/prompts.js:3178` | 最终 system prompt 字符串 | function-call | `constants/prompts.js:3178-3184` `assembleSystemPrompt` | none | 扁平化：滤 null + 滤 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` + 滤锚点标记（`promptAnchors.isAnchorMarker`），`\n\n` join |

#### 3.3.2 真源清单（13）

| # | 路径 | 角色 | driftRisk |
|---|---|---|---|
| T3-1 | `src/constants/prompts.js` | 提示词正文第一真源：46 个 `getXxxSection` 模板字面量 + 21 个意图正则 + 46 处 section 编排顺序。3251 行（god-file baseline 记 3252）。今天它是「装配器 + 查表 + IO + 进程派生」的混合体，D3 三层硬禁全破 | single-source |
| T3-2 | `src/constants/commandSchema.js` | 命令面第一真源：`ROUTER_COMMANDS` / `ROUTER_SUB_COMMANDS` / `CATEGORY_BY_COMMAND` / `BUILTIN_SLASH_COMMANDS` / `COMMAND_ALIASES` / `MENU_SUB_SUGGESTIONS` 六张表 + 9 个导出函数。2381 行。`domain/catalog/commandCatalog/README` 自述「命令清单永远来自 constants/commandSchema SSOT」 | single-source |
| T3-3 | `src/cli/aliases.js` | 命令别名第二真源：`ALIAS_MAP` 内联字面量（874 行，:20-797 为数据区）。与 `commandSchema.COMMAND_ALIASES` 是**两套独立别名机制**（一个管路由归一、一个管 route 碰撞声明），B2 只规划把前者搬 JSON。注释明记 `hq` 曾在此表、2026-09-17 让位给自注册命令——说明两表优先级是隐式约定而非机械保证 | duplicate |
| T3-4 | `src/cli/aiChatCore.js` | 提示词正文**第二真源（与 prompts.js 争）**：约 24 个 `_xxxDirective` 内联中文模板串，:2288 `sp += '\n\n' + _composed` 追加在 `makeSystemPrompt` 产物之后。方案的 §2.1 目录结构、裁定 A-O、B4 改动清单**均未提及这条链**。它同时也是 directiveComposer tier 编排的输入 | contested |
| T3-5 | `src/services/directiveComposer.js` | 指令整合层真源：`DIRECTIVE_REGISTRY` 18 个 key → `{tier, label}` + `TIER_ORDER` + 协调头文案。label 是中文用户可见文案。它自述「单一真源：所有指令类别/编排次序/协调头文案只在本文件」，但**指令正文本身不在本文件**（在 aiChatCore.js）——真源被劈成两半 | contested |
| T3-6 | `src/services/selfProfile.js` | self-awareness 段真源：`formatForSystemPrompt`（:834-1105，约 272 行）是 9 个 truth 格式器的唯一编排点，也是 prompts.js:18 那条 D3→D1 边的落点。含 1 处裸 env 直读 + 8 处 env 透传 + 2 个 memoized lazy accessor | single-source |
| T3-7 | `src/constants/promptLocales.js` | 提示词 i18n 真源：276 行内联 en/zh/ja/ko 四份目录、100 leaf key。与 `src/i18n/locales/{de,en,fr,ja,zh}.json` 是**两套并存的文案载体**（后者 5 语言、131 leaf key、13 命名空间，方案裁定 L 要扩它）。方案规划前者搬到 `src/data/i18n/prompt.{en,zh,ja,ko}.json` | duplicate |
| T3-8 | `src/services/promptAssemblyService.js` | 提示词装配**第三真源，今天无外部消费者**（src/ only 口径）：`CODING_STANDARDS` 内联中文 + 稳定/动态前缀哈希 + 裸 fs 读日志。`khyUpgradeRuntime.js:2664-2666` re-export 了它，但 src/ 下无调用者。方案的目录结构与批次清单未提及它 | duplicate |
| T3-9 | `src/agents/built-in/*.js` | 子代理提示词真源：26 个 .js 文件合计 2323 行（与方案裁定 J 的「2323 行」实测一致），同目录另有 4 个 .md（agentCreator/coordinator/editAndWriteAgent/readAgent）。裁定 J 规划 .js 常量统一到 .md。方案说「34 条目」，实测 26 .js + 4 .md = 30 | duplicate |
| T3-10 | `src/memdir/paths.js` | 记忆文件路径解析真源（B8 合规：:66-67 经 `utils/dataHome` 的 `getProjectDataHome`）。但 prompts.js 有 5 处直接 require 它，且 prompts.js:1494 又自己 `path.join(os.homedir(), '.khy')` 拼了一条平行路径 | single-source |
| T3-11 | `src/cli/commandAutoRegistry.js` | 自注册命令 manifests 的运行时真源（commandSchema:2194/2229 的唯一外部依赖）。它的初始化时机（router.js:236 `init()`）是今天 :243-244 模块加载期调用能拿到非空集的**唯一原因**；改注入式后这个时序契约没有文档化承载 | unknown |
| T3-12 | `scripts/arch-debt-baseline.json` | god-file 基线（prompts.js 记 3252 行，R2-god-file）+ entry-buffer 清单（:234 列 `src/constants/prompts.js`）。B4 要求 prompts.js 拆完后移出这份清单 | single-source |
| T3-13 | `src/utils/flagRegistry/index.js` | 门控真源（225 个消费者的 require 串未改，其 `khy.module.json:38` 自述）。prompts.js 有 10 处 `process.env` 读是经它的 `isFlagEnabled`；另有 4 处直接 require flagRegistry（:19/:1959/:2027/:2490），D3→D3 合法 | single-source |

#### 3.3.3 目标流（187 方案条文摘录）

1) **数据层 D6（新增 `src/data/prompts/`）**：`sections/*.md`（40+ 段提示词正文）、`intentRules.json`（17 条正则 + 任务规模表 + 规则门）、`small-model-templates.js` / `tool-nudges.js` / `memory-compact.js` / `plan-mode.js`（纯字面量 JS 数据模块）。D6 硬禁：不得 require D1/D2/D4、不得含 IO、不得含 process.env。
2) **抽象层 D3（`src/dataAccess/`，全仓唯一抽象层，裁定 A）**：契约 `promptStore.js` —— `getSection(id, opts) => string` / `list() => string[]` / `registerSection(id, fn) => void`（§2.4.8）；另有 `dataAccess/promptIntent.js`（意图规则引擎薄装载）、`dataAccess/promptContent.js`（PromptContentRepository）。硬禁：不得 require 逻辑层、不得含业务规则。
3) **逻辑层 D1/D2**：`src/constants/prompts.js` **保留全部既有导出名与签名**（裁定 B，60 个导出名一个不改），内部改为经 dataAccess 取文案，终态 <2500 行；**不建 `src/prompts/`，不降为一行壳，不改成目录**。
4) **组装层 D1（`src/bootstrap/init.js`，裁定 C + §3.4）**：9 个 truth 格式器**原样留在 services/**，由组装层在第一顺位注册为一个组合 provider（DI token `SELF_AWARENESS_PROVIDER`），必须早于任何 system prompt 构造；`src/constants/selfProfileFormat.js` 为新增纯叶拼接骨架（只吃已格式化字符串数组，不 require 任何 services 模块）。
5) **裁定 C 硬结论**：`constants/prompts.js:18` 这一条 D3→D1 边**去不掉**，登记进 `repo-layout-baseline.json` allowlist，带 `// TODO(#<task>)` 与到期日；**不宣称**「constants/ 恢复零 D1 依赖」。
6) **裁定 D（commandSchema 注入式）**：`constants/commandSchema.js` **保留** `getRouterCommandNames` / `getRouterSubCommands` 导出与签名，内部改为从「可注册 accessor」取值（复用 `parityGuard.js:25` `deps.commandSchema \|\|` 同形状先例）；真正 lazy require `cli/commandAutoRegistry` 的那一行搬到组装层第一顺位执行；**services 侧三个消费者 require 路径一个字节不改**（零改动）。
7) **裁定 G**：D6 域 roots 收窄；`src/constants` **留 D3**（明记「数据层」概念在本仓是分裂的：默认值在 D3、内容在 D6）。
8) **批次归属**：B4a 纯文案分段 → .md；B4b 意图规则表 → `intentRules.json` + `promptIntent.js`；B4c 37 处 process.env 改经 ConfigResolver；B4d commandSchema 注入式（2381 → <400 行，19 个消费方全部纳入）。B2 覆盖 `cli/aliases.js`、`cli/handlers/clean.js` 清理白名单、`cli/handlers/config.js`。B4 判据：固定入参矩阵下全文本逐字节不变。

#### 3.3.4 差异点表（20）

| # | 差异点 | 现状 | 目标态 | 批次 | 风险 |
|---|---|---|---|---|---|
| Δ3-1 | 「commandSchema 19 个消费者」的分母口径与方案不一致 | 19 个文件引用 `constants/commandSchema`。其中**真 require 只有 16 个文件**：cli 侧 11 个（commandHelp.js、commandRegistry.js、commandCatalogUi.js×2、helpCard.js、formatters.js×2、featureCapabilityMap.js、handlers/init.js、handlers/maintain.js、router.js×2、tui/commandParamSpecs.js、tui/hooks/useCompletions.js×2）、services 侧 5 个（selfProfile.js、knowledgeTeachingService.js、commandCatalog.js、docsFreshnessRunner.js、parityGuard.js）。另 2 个是**字符串指针不是 require**（selfCapabilityRegistry.js:129 evidenceAnchors、evolutionPolicy.js:333 trigger），1 个是测试（parityGuard.test.js:263） | 裁定 D：19 个消费者全部纳入，逐个改 require 路径或保持路径不变（注入式下 services 侧零改动）；保留 `getRouterCommandNames`/`getRouterSubCommands` 导出与签名 | B4d / 裁定 D | medium |
| Δ3-2 | ~~`commandOverlapAudit` 的两个 schema 消费函数是死代码~~ → ※L1-2 **撤回该结论**：它们在 src/ 内无调用者，但有活跃测试消费者 | `commandOverlapAudit.js:88` 与 :159 的 JSDoc 写明吃 `getCommandSchema()` 输出；src/ 内这两个函数无调用者（只有 :41 `isPanelEnabled` 被 commandCatalog.js:105 消费），**但** `runtime/node/backend/tests/services/commandOverlapAudit.test.js` 有 11 个活跃测试（:26/:49/:60/:68/:78 调 `auditCommandOverlap`；:89/:102/:112 调 `buildPrimaryCommandPanel`）。文件头 :26-27 自陈「审计原理无门控——它被守卫测试消费、不改运行时行为」 | 方案把它计作 services 侧第 8 个消费者——**这一计数成立**（原流据此推论「方案把死代码计入分母」不成立，已撤回）。真正的问题是 grep 范围：原流所有「零外部调用者」结论均为 src/ only | B4d / 裁定 D | low |
| Δ3-3 | 两处模块加载期调用（router.js:243-244 与 featureCapabilityMap.js:5）的时序契约无承载 | `cli/router.js:21-25` 顶层解构 + :236 `commandAutoRegistry.init()` + :243-244 模块加载期调用；`cli/featureCapabilityMap.js:3-5` 同样模块加载期调用。两处之间**无文档化的先后保证**，且 featureCapabilityMap 不依赖 router 已加载 | 裁定 D：真正 lazy require `cli/commandAutoRegistry` 的那一行搬到组装层（`src/cli/router.js` 顶层 init 或 bootstrap）第一顺位执行 | 裁定 D | blocking |
| Δ3-4 | 方案完全未覆盖第二条提示词正文产出链（cli/aiChatCore.js 内联中文指令） | `aiChatCore.js`（5225 行，D1）内含约 24 个 `_xxxDirective` 局部变量，各自持有内联中文提示词正文；:2244-2245 经 `directiveComposer.composeDirectives` 整合；:2288 `sp += '\n\n' + _composed` 追加在 `makeSystemPrompt` 产物之后。fail-soft 分支（:2290+）还有一份**重复的扁平拼接顺序**作逃生路径 | §2.2 D1 硬禁明文禁「提示词正文与用户可见文案」住在逻辑层；§2.1 目录结构与 B4 改动清单均未提及这条链 | B4a | blocking |
| Δ3-5 | 第三条提示词装配链（services/promptAssemblyService.js）无消费者且方案未登记 | `src/services/promptAssemblyService.js`（357 行）含内联中文 `CODING_STANDARDS`（:110-120）、裸 `fs.readFileSync` 读当日日志（:95-102）、手拼年月日路径。它经 `khyUpgradeRuntime.js:2664-2666` re-export，但 src/ 下 `buildStableSystemMessage`/`assembleRequestMessages`/`buildDynamicContext` **零外部调用者** | 方案的 §2.1 新目录结构、§2.2 分层职责、§4 批次清单中均无此模块 | B4a（对不上方案批次，需人裁定归属） | medium |
| Δ3-6 | 裁定 O 的「prompts.js 贡献 22 条目」与今日实测 29 条不符 | `node scripts/ci/check-repo-layout.js --list=domain-direction` 实测（exit 0，2026-10-13 工作树）：domain-direction 195 / functional-unit 263 / entry-buffer 2470，baseline 199/290/2470——与裁定 O 的三个数字完全一致。**但 prompts.js 贡献 29 条 d3-purity（不是方案说的 22 条）**，commandSchema.js 2 条；29+2=31，d3-purity 总数 36，余 5 条在其他文件（输出被脚本截断，未能定位） | 裁定 O：「prompts.js 贡献 22 条目（非 31）」；全文棘轮目标按 195/263/2470 写 | 裁定 O | high |
| Δ3-7 | 方案 B4b 的「17 条正则」与实测的意图引擎规模不符 | `prompts.js:85-131` 有 21 个正则常量；:143-160 `PROMPT_INTENT_REASON_MATCHERS` 共 16 个 matcher，其中只有 10 个是直接 `.test(text)` 的正则，另 6 个是 `_matchesFileOperations`/`_matchesCommandExecution`/`_matchesSearchExploration`/`_matchesFeatureAccessProxyBoundary`/`_matchesActionSafety`/`_matchesSecurityPermissionBoundaries`/`_matchesSensitiveData` 这类辅助函数（含多正则组合）。`PROMPT_TASK_SCALE_RANK` 3 档、section 规则 17 条 | B4b：17 条正则 + `PROMPT_TASK_SCALE_RANK` + MEDIUM/LARGE_TASK_GATE + reason-key 映射 → `src/data/prompts/intentRules.json` | B4b | medium |
| Δ3-8 | prompts.js 的进程派生与 fs IO 不在任何批次改动清单里 | `prompts.js` 内 3 处 `require('child_process')`（:1700/:1723/:2026）+ 6 次派生（execFile :1701，execSync :1724/:2030/:2036/:2062/:2065）；6 处 `fs.statSync`（:2716/:2749/:2819/:2827/:2838/:2918）+ 2 处 `fs.readFileSync`（:1499/:1762）合计 8 处 fs IO；2 处 `os.homedir()`（:1494/:1741），其中 :1494 是 `path.join(os.homedir(), '.khy')` 字面路径 | §2.2 D3 硬禁「不得含 IO」；B4 改动清单只提「40+ `getXxxSection` 模板字面量 → .md」「37 处 process.env 改经 ConfigResolver」，未提 IO。B8 要求路径经 `utils/dataHome` 解析 | B4（无对应改动项） | blocking |
| Δ3-9 | section cacheKey 依赖 IO 的事实与「数据层零 IO」目标存在结构性冲突 | 6 处 `statSync` 的唯一用途是把 mtimeMs+size 折进 section cacheKey（memoryStamp / projectTreeStamp / projectInstructionsSectionCacheKey / skillCatalogSectionCacheKey / promptFreshness），防缓存冻结。这些 IO 是**缓存正确性的承载**，不是可顺手删的杂质 | B4a 只承诺「`getXxxSection` 函数体字节保留，只把字面量换成 `promptStore.getSection(id)`」；§2.1 的 `dataAccess/loaders/jsonRepository.js` 提供 mtime 热重载，但未说明 section cacheKey 的 IO 归谁 | B8 / B4a | high |
| Δ3-10 | self-awareness 段今天无 provider 注册机制；方案未定义「未注册时该段是否为 null」 | **不存在任何 provider / DI / 注册表机制**（grep `SELF_AWARENESS_PROVIDER` / dataAccess / registerSection 在 src/ 下 0 命中）。self-awareness 段由 prompts.js:2324 同步调用 `selfProfile.formatForSystemPrompt(profile)` 产出；9 个 truth 格式器各自 try/catch + typeof 守卫，缺失时**只丢自己那块**。基础行（`# Runtime (...)` / `Adapter: ..., Model: ...`）无条件产出，所以该段**永不返 null**，`systemPromptSections.js:96` 的 null 丢弃逻辑对它不生效 | §3.4：9 个格式器原样留 services/，由组装层在 `bootstrap/init.js` 第一顺位注册为组合 provider（token `SELF_AWARENESS_PROVIDER`），必须早于任何 system prompt 构造 | 裁定 C / §3.4 | high |
| Δ3-11 | 方案的 self-awareness provider 组装清单漏了 selfLocation 与 commandCatalog 两个同期产出者 | `selfProfile.js:1045-1058` 在同一函数体内还 memoized lazy require 了 `./selfLocation` 与 `./domain/catalog/commandCatalog/commandCatalog`，产出「Self-location + own-command overview」两块（含 `buildCommandCatalog()` 的二次调用，自身还有一层 try/catch） | §3.4 的 `registerSelfAwarenessProvider` 只组合 9 个 truth 格式器，未列 selfLocation 与 commandCatalog | 裁定 C / §3.4 | high |
| Δ3-12 | prompts.js 拆解后仍需依赖 21 个 D3 兄弟模块，其中 4 个持有提示词正文 | prompts.js 顶层 require 21 个兄弟 constants 模块（systemPromptBoundary/systemPromptSections/shellTransparency/shellChainStyle/promptAnchors/promptFreshness/promptCacheOrder/promptLocales/models/outputStyles/cyberRiskInstruction/gitWorkflowGuidance/systemClock 等），这些兄弟模块自身合计约 1490 行，其中 outputStyles(154)/shellChainStyle(229)/promptLocales(276)/promptSectionTaxonomy(443) 持有大量提示词正文 | 裁定 B：`src/constants/prompts.js` 保留全部既有导出名与签名，内部改为经 dataAccess 取文案，终态 <2500 行，不建 `src/prompts/`、不降为一行壳、不改成目录 | 裁定 B | medium |
| Δ3-13 | 8 处 require 打向未登记域（memdir/skills/tools），domain-direction 守卫给出假绿 | 裁定 O 已实测：`src/{tools,memdir,skills,config,middleware,observability,bootstrap}` 不在 DOMAIN-DEPS.json 任何域的 roots 里。prompts.js 有 8 处 require 打向这些目录（:883 `../tools/_toolTimeout`、:1439/:1463/:1480/:2818/:2826 `../memdir/*`、:2774 `../skills`、:2854 `../tools/taskMemorySection`）——全部逃过 domain-direction 计数 | 裁定 G/裁定 O 附带：补一条 grep 型补充判据（§5.1 J-07）；「把这些子树补登记为域」是治理动作须人点头，本文只作前置检查项 | 裁定 G / 裁定 O | high |
| Δ3-14 | B0 前置项未动：3 条 check-repo-layout error 仍在 | `node scripts/ci/check-repo-layout.js` 实测仍有 3 条 [error]：root-shadow-dir（.khy、.khyos）、root-junk（'、tmp-cmp）、layer-registry（gem、tmp-cmp）——与裁定 O 记录的完全一致，B0 尚未开工 | B0 改动清单第 1 项：清 3 条 error（删影子目录、收容 ' / tmp-cmp / gem、登记或删除 gem / tmp-cmp） | B0 | high |
| Δ3-15 | 方案目标文件全部不存在（符合「B0 未开工」预期，非缺陷） | `src/dataAccess/`、`src/data/prompts/`、`src/data/commands/`、`src/constants/selfProfileFormat.js`、`src/cli/data/`、`src/tools/data/` 全部不存在（已逐一核验）。`src/data/` 今日只有 bugCases.js / cliAnythingRegistry / cliAnythingTemplates / curriculum.json / publicApis.json 五项，其中 cliAnythingTemplates 被裁定 G 明确排除出 D6 | 裁定 A：只建 `runtime/node/backend/src/dataAccess/`；B0 第 3 项建 index.js/khy.module.json/di/tokens.js/di/registry.js/loaders/jsonRepository.js，零消费方 | B0 | low |
| Δ3-16 | 新守卫未建，`check-data-layout.js` 与方案的新守卫不是同一件事 | `scripts/ci/` 下已有 `check-data-layout.js`（[DESIGN-LAY-007] 三态目录分层守卫，`GUARD_STAGE='S1'` 恒 exit 0，已登记在 `FEATURE-OWNERSHIP.json:454` `rollout.mechanisms[]`）。但**它管的是数据家分档/绕表直拼/格式卫生，不是数据-逻辑分离**。方案点名的 `check-data-logic-separation.js` / `check-data-layer-purity.js` / `check-env-defaults.js` / `check-config-schema-sync.js` 四个新守卫均不存在 | B0 第 4-5 项：新建 `scripts/ci/check-data-logic-separation.js`（基线棘轮模式起步），同批登记进 `FEATURE-OWNERSHIP.json` `rollout.mechanisms[]`（stage S1 + rollback）并挂 check:* 别名或在 wiring-exemptions.json 登记 | B0 | medium |
| Δ3-17 | 裁定 N 的「`src/cli/commands/registry.json` 是死数据」在 src/ 内复核为真，但未按裁定要求全仓（含 works/ 与 delivery/）复核 | `src/cli/commands/registry.json` 与 registry.js 并存。grep `'commands/registry.json'` 在 src/ 下 0 命中 | 裁定 N：B0 之前先删，或显式登记为「待接线」并写进 `khy.module.json`；删除前再跑一次全仓 grep（含 works/ 与 delivery/） | 裁定 N | low |
| Δ3-18 | 裁定 J 的「34 条目」与实测 30 个文件不符（.js 行数 2323 精确吻合） | `src/agents/built-in/` 下 26 个 .js 合计 2323 行（与方案数字精确一致）+ 4 个 .md（agentCreator/coordinator/editAndWriteAgent/readAgent） | 裁定 J：统一到 .md 内容文件；AgentTool 的 `subagent_type` enum（20 值）改由 `agent-definition.schema.json` 派生 | 裁定 J | low |
| Δ3-19 | prompts.js 导出 `MODEL_IDS` 形成一条方案未登记的模型名单暴露路径 | `src/constants/models.js`(107) 的 `MODEL_PRIMARY` 被 prompts.js:22 引入并摊平为 `MODEL_IDS` 导出（:60-64），`MODEL_IDS` 又是 prompts.js 的公开导出之一（`tests/modelConstants.test.js:127` 消费） | 方案 §1.0 耦合总量与 §4 批次均以 prompts.js 的行数/require 数为口径，未单列 models.js 这一条 D3→D3 但语义上属「模型名单第二暴露面」的边 | （无批次） | medium |
| Δ3-20 | 「29 处反向 require」的实测分解：29 是守卫可见数，另有 8 处守卫不可见 | 79 处 `require(` 出现、47 个不同模块；其中**跨层反向 require 37 处 / 25 个模块** = 守卫可见的 29 处（20 个 services 模块，D3→D1/D2）+ 守卫不可见的 8 处（memdir×3 + memdir/paths×2 + skills + tools/_toolTimeout + tools/taskMemorySection，5 个模块）。另有 12 处 D3→D3 合法边（constants 兄弟 + utils/flagRegistry/dataHome/pathCompat）与 4 类内建模块（fs×9 行/child_process×3/os/path/zlib） | 任务书锚点写「29 处 require 横跨 20 个模块」 | B4a | high |

---

### 3.4 流域四：文案与界面数据流（30 边 / 15 真源 / 22 差异点）

#### 3.4.1 现状流（边表）

| 边号 | from（产地） | to（消费方） | 机制 | 证据 `file:line` | violates | 说明 |
|---|---|---|---|---|---|---|
| F4-E1 | `src/i18n/locales/{zh,en,ja,fr,de}.json` | `src/i18n/index.js:_loadLocale` | readFileSync | `src/i18n/index.js:25` | D6-purity | 装载器读内容资产。按 §2.1 的字面目录归属判 D6；裁定 G 已明裁 index.js 是装载器不是内容、移出 D6 归抽象层，故这条是「若不裁定就违规」的边。今天 `src/i18n` 未登记进 DOMAIN-DEPS.json 任何域，d3-purity/d6-purity 均扫不到，零守卫触发 |
| F4-E2 | `process.env.KHY_LOCALE` / `LANG` / `LC_ALL` / `LC_MESSAGES` | `src/i18n/index.js:_currentLocale` | env-read | `src/i18n/index.js:248`（`setLocale('auto')` 模块加载期触发）；:72-95 `detectLocale()`；:27 `DEFAULT_LOCALE='en'` | D6-purity | 「接线后英文 OS 上中文消息变英文」的机械成因。同受 src/i18n 未登记之赐，今天无守卫 |
| F4-E3 | `src/i18n/index.js` | `src/index.js:24` `exports.i18n` | re-export | `src/i18n/index.js:33`；`src/index.js:24` | assembly-only-instantiation | 全 backend grep `'\.i18n\b'` 只命中这一行自身——re-export 的下游也是空的。这不是「框架没人用」，是「框架连出口都没人接」 |
| F4-E4 | `src/constants/promptLocales.js:LOCALE_CATALOGS` | `src/constants/prompts.js:1391,2657,2999` | require | `promptLocales.js:18`；`prompts.js:1391`（t）、:2657（tBlock）、:2999（detectLocale）；另 `services/tool/toolGuards.js:985`（t，带「i18n module unavailable 回退英文模板」注释） | none | 第二套并行 i18n：4 locale（en/zh/ja/ko，`DEFAULT_LOCALE='en'`），与 src/i18n 的 5 locale（en/zh/ja/fr/de）集合与 key 空间均不重叠。constants = D3、services = D1，D1→D3 合法 |
| F4-E5 | `src/constants/prompts.js` | `src/services/{selfProfile,fableVoiceProfile,smallModelPromptTemplates,repoDisciplineRisk,platformCapabilities,…}.js` | require | `prompts.js:769,953,980,1288,1330,1362,1600` 等 29 处 `require('../services/')` 横跨 20 个 services 模块（:18 selfProfile 已按裁定 C 登记 allowlist） | D3-no-logic | §2.2 抽象层硬禁「不得 require 逻辑层」的实况；D3→D1 方向由 `check-repo-layout.js` 的 d3-purity 管（全仓基线 36 处） |
| F4-E6 | `process.env.KHY_PLANNING_DISCIPLINE` 等 38 处 env | `src/constants/prompts.js:getSystemPrompt` 及 60 个 section 导出 | env-read | `prompts.js:266,513,573,601,1432,1520,1531,1582,1960,2114,2213,2247` 等 | none | ※L2-5 统一口径：37 行含 `process.env` = 14 处直读（10 处带 `\|\| 默认值`）+ 10 处 `isFlagEnabled` + 13 处对象透传。`KHY_ON_DEMAND_PROMPT_SECTIONS` / `KHY_PROMPT_SECTION_STATIC_MEMO` / `KHY_PROMPT_TOOLS_SECTION_MEMO` / `KHY_PROMPT_ENV_MIN` / `KHY_PROMPT_GIT_STATUS_MIN` / `KHY_PROMPT_SKILLS_MIN` / `KHY_PROJECT_TREE…` 与 17 条意图正则、任务规模表、规则门同住一文件，构成裁定 B 要拆的三类职责 |
| F4-E7 | `src/cli/aliases.js:ALIAS_MAP`（:20-797） | `src/cli/router.js` 与 `src/cli/routerDispatchSlash.js`（别名归一化） | inline-literal | `cli/aliases.js:20-797`（874 行文件，ALIAS_MAP 内联中英拼音三套别名键：行情/回测/策略/数据下载…） | D1-no-literal | §2.2 逻辑层硬禁明文列「业务字面量表（…别名…）」。方案 B2 目标 `src/cli/data/aliases.json` + AliasRepository，保留 `resolveAlias`/`getAliasesForCommand`/`getAllAliasKeys`/`ALIAS_MAP` 四导出，且要求 JSON 在 aliases.js 顶层同步加载以防别名优先级翻转 |
| F4-E8 | `src/cli/handlers/clean.js:BUILD_TARGETS` / `TOOLS_TARGETS` / `RUNTIME_TARGETS` / `CHECKPOINT_TARGET` | `src/cli/handlers/clean.js:clean()` | inline-literal | `clean.js:75,156,198` | D1-no-literal | 清理白名单（rel/why/rebuild 三元组）内联在 826 行的 handler 里，含 .khy/checkpoints 特殊分支。方案 B2 目标 `src/cli/data/cleanupTargets.json` + CleanupTargetsRepository，`--repo`/`--tools`/`--runtime`/`--checkpoints` 分支逻辑原地不动 |
| F4-E9 | `src/cli/handlers/config.js:SUPPORTED_CONFIG_KEYS` / `KEY_ALIASES` / `PROVIDER_TO_ADAPTER` | `src/cli/handlers/config.js` + `src/config/settingsWhitelist.js` + `src/cli/repl/khySettings.js` | inline-literal | `config.js:22,31,60` | D1-no-literal | 三张内联查找表。方案 B2 要新建 `check-config-schema-sync.js` 机械校验与 `src/config/settingsWhitelist.js`、`cli/repl/khySettings.js` 三处一致——即方案本身就认定这三处今天不在单一真源上 |
| F4-E10 | `src/cli/themes/{default,dracula,forest,mono,nord,ocean,solarized,sunset}.json` | `src/cli/themeRegistry.js:_themes` / `_defaultTheme` / `_activeName` | readFileSync | `themeRegistry.js:48,153,156,171` | assembly-only-instantiation | D1 逻辑层（src/cli 是 DOMAIN-DEPS 的 D1 roots）用裸 `fs.readFileSync`/`readdirSync` 读数据资产，并在模块作用域把 `_defaultTheme` 实例化（:48）、把 `_themes` Map 从 readdirSync 装出（:153-156）。§2.2 两条硬禁同时命中：逻辑层禁「裸 fs.readFileSync 读数据资产」、组装层之外禁实例化数据源 |
| F4-E11 | `os.homedir()` + `'.khyquant'` 字面量 | `src/cli/themeRegistry.js:PREFS_FILE` / `CUSTOM_THEME_FILE` | homedir-path | `themeRegistry.js:27` | D1-no-literal | `_appHome()` 已正确委托 `utils/dataHome.getAppHome()`（:22），但 catch 分支回落 `os.homedir()+'.khyquant'`（:27）。B8 的口径是「路径解析归解析器，不归 cwd/homedir」，这条回落正是 B8 要收敛的形状 |
| F4-E12 | `src/cli/tui/theme/ccTheme.js:CC_COLORS` / `CC_THEME` / `SEMANTIC` | `src/cli/tui/{ink-components/CcApp.js:71, components/CcStatusLine.js:25, CcSidebarPanel.js:18, CcTranscriptView.js:30, utils/ccStatusBar.js:27, CcToast.js:18, …}`（约 20 个 TUI 消费者） | require | `ccTheme.js:16`（165 行 JS 模块承载色板数据：toolName/success/error/warning/info + 亮色覆盖组 + 16 色路径） | D1-no-literal | 裁定 K 目标 `src/cli/data/ccTheme.json`，且明确不合入 `cli/themes/*.json`（两套 schema 不同，`check:tui-gates` 要求 CC 视觉逐字节不变） |
| F4-E13 | `src/services/tipScheduler.js:TIPS`（:44） | `src/services/tipHistoryStore.js:100`（`leaf.TIPS`）→ `src/cli/repl/startupNotices.js:63` | function-call | `tipScheduler.js:44`（每条 `{id,text,cooldownSessions,isRelevant?}`） | D1-no-literal | 启动轮换提示真源。关键：`isRelevant` 是函数字面量（:64 `_startups(ctx) < 15`、:70 `< 8`），所以这份「数据」今天无法原样搬成 JSON——方案 §2.1 的 `src/cli/data/replTips.json` 需要把谓词改写为声明式（如 `minStartups`）或把谓词留逻辑层，方案未展开 |
| F4-E14 | `src/cli/replSession.js:2883` `TIPS` | `src/cli/replSession.js:2883-2897`（`_tipIdx % TIPS.length` 轮转） | inline-literal | `replSession.js:2883` | D1-no-literal | 9 条中文提示，与 `tipScheduler.js:44` 的 9 条文本逐一相同（但缺 web-tools / 双击 Esc / 陌生目录三条）。replSession.js 已登记 R2-god-file（13728 行），副本埋在 god-file 里，漂移最难发现 |
| F4-E15 | `src/cli/replSession.js:13215` `tips` | `src/cli/replSession.js:13215-13230`（console.log 提示行） | inline-literal | `replSession.js:13215` | D1-no-literal | 第三套：AI 回复后随机 tip（7 条，throttled 120000ms）。与 2883 的 9 条、tipScheduler 的 12 条互不相同 |
| F4-E16 | `src/cli/formatters.js:67` `TIPS` | `src/cli/formatters.js:67`（farewell 渲染） | inline-literal | `formatters.js:67` | D1-no-literal | 第四套，且是唯一的英文 tips（7 条 farewell messages）。四套 tips 分居三个文件、两种语言、三种触发时机，方案的单一 `src/cli/data/replTips.json` 需要先裁定它们是同一份数据的四个视图还是四份数据 |
| F4-E17 | `src/cli/routerDispatchSlash.js:1340` `stickers` | `src/cli/routerDispatchSlash.js:1339-1347`（case 'stickers'） | inline-literal | `routerDispatchSlash.js:1339-1347` | D1-no-literal | ※L1-1：**与 F4-E18 不是逐字重复**——本处 **7 条**元素，`;` 收在 :1347；`console.log` 用模板串 `\n  ${...}\n`。原流与 truthSources 的「两份逐字重复副本，同数组」判定已撤回。方案 §2.1 的 `src/cli/data/stickers.json` 对应此处 |
| F4-E18 | `src/cli/replSession.js:6480` `stickers` | `src/cli/replSession.js:6479-6489` | inline-literal | `replSession.js:6480-6489` | D1-no-literal | ※L1-1：本处 **8 条**元素，第 8 条 `'(ノಠ益ಠ)ノ彡┻━┻'` 仅存在于 replSession；`console.log` 用字符串相加 `'\n  ' + ... + '\n'`（输出等价，代码不逐字节相同）。两处数组体行域原流记 :1339-1349/:6479-6490，实测为 :1339-1347/:6480-6489。**B10 合并前必须先裁定保留 7 条还是 8 条**（见 §4.5-d） |
| F4-E19 | `src/webRemoteControl/mobilePage.js:11` `COPY` | `src/webRemoteControl/mobilePage.js:renderMobilePage` → `src/webRemoteControl/server.js:37` | inline-literal | `mobilePage.js:6`（自称「文案真源：apps/khyos-desktop/zcode-analysis/i18n-zh.json 的 webRemoteControl.*」）、:11 `COPY`（31 条）；渲染走 textContent（:34-38 esc），不拼 innerHTML | D1-no-literal | 文件头自陈的真源是注释里的承诺，无机械绑定、无守卫校验。方案 B10 要求各移动页 copy 归位 + `mobilePageCopy.test.js` 整页 HTML strictEqual |
| F4-E20 | `src/bridge/mobilePage.js:buildMobileHTML`（1372 行）+ `bridge/mobilePage.chat.js`（379 行） | `src/bridge/bridgeServer.js:285`（协作控制台页面） | function-call | `bridgeServer.js:285` | D1-no-literal | 第二份（实为第三份，含 chat 子页）手机页文案，与 webRemoteControl/mobilePage.js 完全独立、内联中文 UI + 内联 CSS/JS。裁定 N 明确两份 mobilePage 不合并，B10 要求「各自把文案归位」 |
| F4-E21 | `apps/khyos-desktop/src/renderer/i18n/zh-CN.json`（345291 字节） | `apps/khyos-desktop/src/renderer/i18n/index.ts:5-12`（`i18n.init`） | json-parse | `renderer/i18n/index.ts:3` | none | 全仓唯一真正接线成功的 i18n：i18next + initReactI18next，`lng:'zh-CN'`、`fallbackLng:'zh-CN'` 双锁，`saveMissing:true` + missingKeyHandler。它正是裁定 L 要求 backend 抄的作业——「locale 显式锁 zh-CN」在这份代码里已经是既成范式，不是新发明 |
| F4-E22 | `apps/khyos-desktop/zcode-analysis/i18n-zh.json`（345343 字节，5070 leaf） | `apps/khyos-desktop/src/renderer/i18n/zh-CN.json`（5069 leaf）+ `runtime/node/backend/src/webRemoteControl/mobilePage.js:6`（仅注释引用） | readFileSync | `zcode-analysis/i18n-zh.json`；旁边还有同源的 i18n-zh.jsonl/.tsv/.txt 四个派生物格式 | none | ZCode 1:1 复刻的文案真源资产（apps/khyos-desktop/CLAUDE.md「真源资产」表登记为 5070 条中文文案）。mobilePage.js:6 的注释指向这份而非在用的 renderer 版。实测差集：`workspaceSidebar.showFileTree` 仅 zcode-analysis 版有，renderer 版无独有键 |
| F4-E23 | `src/cli/commands/registry.json`（3353 字节） | （无消费方） | inline-literal | 全 src grep `'commands/registry\.json'` 零命中（src/ only 口径） | none | 实测零消费者。裁定 N 已裁它为死数据，B0 处置是「删或显式登记待接线」。在用的是同目录 registry.js（内联 JS 对象，非 JSON 加载器），中文 description 直接写在对象里 |
| F4-E24 | `src/cli/commands/registry.js:29` `COMMAND_REGISTRY` | `src/cli/commands/registry.js`（懒加载 handler 解析） | inline-literal | `registry.js:29` | D1-no-literal | 命令元数据（description 中文、category、handler 路径、lazy 标志）内联在 JS 对象里；registry.json 与它并存且无人读，是「数据两份、活的一份不是 JSON」的典型 |
| F4-E25 | `src/data/bugCases.js:14` `BUG_CASES` | （学习课程第 10 层 / 小模型 few-shot） | inline-literal | `data/bugCases.js:14`（228 行，零 require / 零 readFileSync / 零 process.env，纯数组字面量） | none | src/data 下唯一纯净的数据模块，只是载体是 .js 不是 .json。方案 §2.1 目标 `src/data/bugCases.json` + 原文件留 re-export 壳 |
| F4-E26 | `src/data/cliAnythingTemplates/node_skeleton/index.js:36,50` | `src/cli/handlers/session.js` + node 内置模块 | require | `cliAnythingTemplates/node_skeleton/index.js:4,6`（require commander/../package.json）、:36 与 :50（require `'../../../cli/handlers/session.js'`，解析后落 src/cli）；`backend.js:3-5`（require child_process/fs/path）、:30（`path.join(require('os').homedir(),'.local','bin',name)`） | D6-purity | D6 目录反向 require D1。这正是裁定 G 把 `src/data/cliAnythingTemplates/**` 显式排除出 D6 roots 的实测依据，不是理论担忧（它是生成工程的脚手架代码，不是内容资产） |
| F4-E27 | `src/cli/tui/ink-components/SidebarPanel.js:163` 本地 `t = (s) => truncateToWidth(s, innerW, measure)` | `src/cli/tui/ink-components/SidebarPanel.js`（侧栏文本渲染） | function-call | `SidebarPanel.js:163`；调用点 :205,209,220,385（参数直接是 '当前'/'发送消息后将显示任务'/'· 待命中' 等中文字面量） | none | **假 i18n**。全 src 只有 7 处 `t('`：其中 4 处是这个本地截断助手，2 处是 i18n/index.js 的 JSDoc 示例，1 处是 prompts.js:1393 调 promptLocales 的真翻译。任何按 `t(` 计数的「i18n 采用度」指标都会被这 4 处污染成「已接线」 |
| F4-E28 | `src/cli/tui/ink-components/App.js`（7788 行，1348 行含中文） | `src/cli/tui/ink-components/App.js`（CC TUI 渲染） | inline-literal | 已登记 `arch-debt-baseline.json` godFiles（R2-god-file，记录 7710 LOC，现 7788） | none | 方案 §1.0 只把它列为「内联提示词/用户可见文案 ~28」的集中点之一，未在 §4 批次表里给它单独的拆解批次——即文案最多的单文件与 R4 门同时超标，却不在任何一批的改动清单上 |
| F4-E29 | `src/constants/promptLocales.js:t('lang.instruction', locale, {lang})` | `src/constants/prompts.js:getLanguageSection` → `getSystemPrompt` | function-call | `prompts.js:1393`；`promptLocales.js` `t`/`detectLocale`/`tBlock` | none | 全 backend 唯一走到「真翻译函数」的用户可见文案路径，且它连的是第二套 i18n（promptLocales）而非 src/i18n。`getLanguageSection` 在 languagePreference 为空时直接返回英文硬编码句（:1387），非空时 detectLocale 中文前缀返回 'zh' |
| F4-E30 | `src/webRemoteControl/protocol.js`（错误码枚举） | `apps/khyos-desktop/src/renderer/i18n/zh-CN.json` 的 `webRemoteControl.failure.*`（约定，未机械绑定） | inline-literal | `protocol.js:9,50`（两条注释声称「错误码与 i18n webRemoteControl.failure.* 一一对应，手机页据此选文案」） | none | 注释级契约：没有测试、没有守卫把 protocol.js 的枚举与 zh-CN.json 的 failure.* 键集合锁在一起。未逐条比对是否真的等长（§5） |

#### 3.4.2 真源清单（15）

| # | 路径 | 角色 | driftRisk |
|---|---|---|---|
| T4-1 | `src/i18n/locales/{zh,en,ja,fr,de}.json` | backend 唯一 i18n 框架的语言包：5 语言各 131 leaf key、13 命名空间（common,menu,auth,ext,gateway,data,strategy,security,ai,arena,session,config,lsp）、zh/en 完全对齐、无 message 命名空间。零消费 | single-source |
| T4-2 | `src/constants/promptLocales.js` | 第二套并行 i18n（4 locale：en/zh/ja/ko，`DEFAULT_LOCALE='en'`，key 空间 exec.*/guard.*/lang.*），被 prompts.js:1391/2657/2999 与 services/tool/toolGuards.js:985 消费。与 src/i18n 争「khy 的文案层」地位而两者互不知晓 | contested |
| T4-3 | `src/constants/prompts.js` | 提示词正文 + 意图规则 + env 解析的单一真源；3251 行（R4 超限）、37 行 env、29 处 require('../services/')、60 个导出名。是 B6 软著登记材料 | single-source |
| T4-4 | `src/cli/aliases.js` | `ALIAS_MAP` 别名表单一真源（874 行，:20-797 为映射体） | single-source |
| T4-5 | `src/services/tipScheduler.js:44` `TIPS` | 启动轮换提示真源（12 条，含 `isRelevant` 函数字面量）。已知三份同文/近文副本：cli/replSession.js:2883（9 条同文）、cli/replSession.js:13215（另 7 条）、cli/formatters.js:67（英文 7 条） | duplicate |
| T4-6 | `src/cli/routerDispatchSlash.js:1340` + `src/cli/replSession.js:6480` | stickers 趣味贴纸数组的两份副本。※L1-1：**不是逐字重复**——7 条 vs 8 条子集重叠、已漂移（replSession 多一条 `'(ノಠ益ಠ)ノ彡┻━┻'`），console.log 形状亦不同 | duplicate |
| T4-7 | `src/cli/themes/*.json` | 8 个主题 JSON（default/dracula/forest/mono/nord/ocean/solarized/sunset），是数据层形状的真源；但被 D1 逻辑层 cli/themeRegistry.js 用裸 fs 读并在模块级实例化 | single-source |
| T4-8 | `src/cli/tui/theme/ccTheme.js` | CC TUI 色板单一真源（`CC_COLORS`/`CC_THEME`/`SEMANTIC`），约 20 个 TUI 消费者 require。载体是 JS 模块不是 JSON | single-source |
| T4-9 | `src/webRemoteControl/mobilePage.js:11` `COPY` | 手机页文案。文件头 :6 自称真源是 `apps/khyos-desktop/zcode-analysis/i18n-zh.json` 的 `webRemoteControl.*`，但那是注释承诺，无机械绑定、无守卫 | contested |
| T4-10 | `src/bridge/mobilePage.js` + `bridge/mobilePage.chat.js` | 第二/第三份手机页文案（1372 + 379 行），与 webRemoteControl/mobilePage.js 完全独立。裁定 N 明确不合并 | duplicate |
| T4-11 | `apps/khyos-desktop/src/renderer/i18n/zh-CN.json` | 桌面端唯一在用的 i18n 语言包（i18next，lng/fallbackLng 双锁 zh-CN，5069 leaf，345291 字节）。与 zcode-analysis 版差 1 key | contested |
| T4-12 | `apps/khyos-desktop/zcode-analysis/i18n-zh.json` | ZCode 1:1 复刻的文案真源资产（5070 leaf，345343 字节），被 apps/khyos-desktop/CLAUDE.md「真源资产」表登记，并被 backend mobilePage.js:6 的注释引用为文案真源——但它不是在用的那一份 | contested |
| T4-13 | `src/cli/commands/registry.json` | 命令元数据 JSON，实测零消费者（死数据，src/ only 口径）。裁定 N 要求 B0 删或显式登记待接线；与在用的同目录 registry.js 构成「活的一份不是 JSON、JSON 的一份是死的」 | unknown |
| T4-14 | `src/data/bugCases.js` | Bug 修复案例库（`BUG_CASES`），src/data 下唯一零 require/零 IO/零 env 的纯净数据；载体是 .js 不是 .json | single-source |
| T4-15 | `src/data/cliAnythingTemplates/**` | 脚手架模板代码（node_skeleton 等）。单源但含 require child_process/fs/commander，且 index.js:36/50 反向 require src/cli/handlers/session.js（D1），backend.js:30 有 `os.homedir()` 拼 .local/bin——故被裁定 G 显式排除出 D6 roots | single-source |

#### 3.4.3 目标流（187 方案条文摘录）

【目录】D6 roots = `src/data`（排除 `cliAnythingTemplates/**`）、`src/blueprints`、`src/contracts`、`src/templates`、`src/i18n/locales`、`src/cli/themes`、`src/cli/data`、`src/tools/data`、`config/**/*.json`；`src/i18n/index.js` 显式移出 D6 归抽象层，由 `src/dataAccess/i18n.js` 包装。

【数据落点】`src/data/i18n/prompt.{en,zh,ja,ko}.json`（从 constants/promptLocales.js 搬入，脚本生成、禁手抄）；`src/cli/data/{aliases,replTips,stickers,cleanupTargets,ccTheme,layoutTokens}.json`；`src/i18n/locales/{zh,en}.json` 增补 message 命名空间（裁定 L：内联中文文案的容器是扩 locales，不另起「文案表」）；`src/data/bugCases.json` + re-export 壳；`src/tools/data/<toolId>.json`。

【抽象层仓储】`repositories/uiCopy.js`、`alias.js`、`theme.js`、`cleanupTargets.js`、`toolSchema.js`、`configSchema.js`、`publicApi.js`；`src/dataAccess/i18n.js`（I18nTranslator）。

【契约】§2.4.8 messageCatalog：`t(key, params, { locale = 'zh-CN' })` → string、`has(key)` → boolean；B2 AliasRepository 保留 `resolveAlias`/`getAliasesForCommand`/`getAllAliasKeys`/`ALIAS_MAP` 四导出。

【硬禁】D6 不得 require D1/D2/D4、不得含 IO、不得含 process.env（constants/ 的 env 默认值是唯一例外且须 `const X = process.env.Y \|\| 字面量` 范式）；抽象层不得 require 逻辑层、不得含业务规则；逻辑层禁「提示词正文与用户可见文案」字面量、禁「`os.homedir()` 拼用户家路径」、禁「裸 `fs.readFileSync` 读数据资产」、禁「`process.env.X \|\| 默认值` 成对书写」；组装层是全仓唯一允许实例化数据源并交给逻辑层的地方。

【裁定 L 硬约束】迁移期 locale 显式锁 zh-CN，key 的 zh 文案 = 现字面量保证逐字节等价；若 `t()` 随 OS locale 走，英文机器上原本硬编码的中文消息变英文 = 行为变更；各语言翻译补齐后才放开；这条不满足则 B7 整体回退（B10 亦承此约束）。

【裁定 K】ccTheme 色板下沉 `src/cli/data/ccTheme.json`，不合入 `cli/themes/*.json`（两套 schema 不同，check:tui-gates 要求逐字节不变）。

【裁定 N】两份 mobilePage 不合并，各自把文案归位。

【B10 验证】`src/i18n/__tests__/parity.test.js`（zh/en 双向 key 集合相等）、`src/dataAccess/__tests__/mobilePageCopy.test.js`（整页 HTML strictEqual）、`theme.test.js`、仓库根执行 `check-tui-gates.js`、`check-copyright-readiness.js` 0 error、`check-data-logic-separation.js` 中文字面量计数项只降不升。

#### 3.4.4 差异点表（22）

| # | 差异点 | 现状 | 目标态 | 批次 | 风险 |
|---|---|---|---|---|---|
| Δ4-1 | 「文案层没有接口」的结构性事实：src/i18n/ 整套零内部消费 | src/ 下唯一引用是 `src/index.js:24` 的 re-export；且该 re-export 自身无下游（全 backend grep `'\.i18n\b'` 只命中它自己）。services 约 100+ 处、cli 30617 行中文全部不过 `t()` | `src/dataAccess/i18n.js`（I18nTranslator）包装 `src/i18n/index.js`；services 用户可见文案分批接 `t()`，`messageCatalog.t(key, params, { locale = 'zh-CN' })` | B10 | blocking |
| Δ4-2 | `src/i18n/index.js` 不在任何域登记表里，其 IO/env 读取不受 d3-purity 或任何规则管辖 | DOMAIN-DEPS.json 的 D1/D2/D3/D4/D5 roots 均未登记 `src/i18n`（连同 src/data、src/blueprints、src/templates、src/contracts、src/tools、src/bridge、src/webRemoteControl、src/config、src/bootstrap）。index.js:18-21 require fs/path/logger、:25 `path.join(__dirname,'locales')`、:45-53 `_loadLocale` IO、:248 `setLocale('auto')` 模块级执行、:73-78 `detectLocale` 读 4 个 env——今天零守卫覆盖 | D6 roots = src/data（排除 cliAnythingTemplates）/blueprints/contracts/templates/i18n/locales/cli/themes/cli/data/tools/data/config/**/*.json；`src/i18n/index.js` 显式移出 D6 归抽象层；D6 加进 D1/D2/D3 的 mayDependOn | 裁定 G | high |
| Δ4-3 | locale 检测机制已存在且默认值是 'en'——接线后英文 OS 上原本硬编码的中文消息会变英文（行为变更） | `src/i18n/index.js:27` `DEFAULT_LOCALE='en'`；:72-95 `detectLocale()` 读 `KHY_LOCALE`/`LANG`/`LC_ALL`/`LC_MESSAGES`；:248 `setLocale('auto')` 在模块加载期定值 | 迁移期 `t(key, params, { locale: 'zh-CN' })` 显式锁；key 的 zh 文案 = 现字面量；各语言翻译补齐后才放开；这条不满足则 B7/B10 整体回退 | 裁定 L | blocking |
| Δ4-4 | `src/i18n/locales/*.json` 没有 message 命名空间，而它是裁定 L 指定的内联中文文案容器 | 实测 13 个命名空间：common,menu,auth,ext,gateway,data,strategy,security,ai,arena,session,config,lsp。zh/en/ja/fr/de 五语言各 131 leaf key 且 zh/en 完全对齐（zh-only/en-only 均为空） | 扩 `src/i18n/locales/{zh,en}.json` 的 message 命名空间承载内联中文文案，不另起「文案表」 | 裁定 L | medium |
| Δ4-5 | 两套 i18n 并存，locale 集合与 key 空间互不重叠 | `constants/promptLocales.js` 是与 src/i18n 并列的第二套 i18n：4 locale（en/zh/ja/ko，`DEFAULT_LOCALE='en'`）、独立 key 空间（exec.*/guard.*/lang.*）、独立 `t()`/`tBlock()`/`detectLocale()` 签名。消费点 prompts.js:1391,2657,2999 与 services/tool/toolGuards.js:985 | `src/data/i18n/prompt.{en,zh,ja,ko}.json`（从 constants/promptLocales.js 搬入，脚本生成、禁手抄） | 裁定 B / B4 | high |
| Δ4-6 | `constants/prompts.js` 是 R4 超限的 god-file（3251 > 2500），同时混合四类职责 | 3251 行；37 行 `process.env`；29 处 `require('../services/')` 横跨 20 个 services 模块（:18 selfProfile 已按裁定 C 登记 allowlist）；60 个导出名 | `src/constants/prompts.js` 保留全部 60 导出名与签名、内部改经 dataAccess 取文案，终态 <2500 行；意图规则引擎 → `src/data/prompts/intentRules.json` + `src/dataAccess/promptIntent.js`；不建 `src/prompts/`、不降为一行壳、不改成目录 | 裁定 B / B4 | blocking |
| Δ4-7 | cli/ 的中文行数量级与任务书锚点不符（差约 6.6 倍） | 实测 `rg -c '\p{Han}'`：cli 30617 行 / 547 文件、utils 4620、tools 3112、services 68455、constants 1510。任务书锚点写的是 cli 4630 / utils 873 / tools 405 | `check-data-logic-separation.js` 的「中文字面量计数项只降不升」 | B10 | medium |
| Δ4-8 | tips 与 stickers 各有多个副本，分散在三个以上文件、两种语言 | 四份 tips：`services/tipScheduler.js:44`（12 条，含 `isRelevant` 函数字面量）、`cli/replSession.js:2883`（9 条，与前者的 9 条同文）、`cli/replSession.js:13215`（另 7 条）、`cli/formatters.js:67`（英文 7 条）。两份 stickers：`cli/routerDispatchSlash.js:1340` 与 `cli/replSession.js:6480`——※L1-1：**7/8 条子集重叠、已漂移，非逐字重复** | `src/cli/data/replTips.json` + `src/cli/data/stickers.json` | B10 | high |
| Δ4-9 | tipScheduler 的 TIPS 含函数字面量，无法原样搬成 JSON——方案的 replTips.json 需要谓词声明式化或分层，方案未展开 | `tipScheduler.js:64` `isRelevant: (ctx) => _startups(ctx) < 15`、:70 `< 8`，是函数字面量 | `src/cli/data/replTips.json`（JSON 无法承载函数） | B10 | high |
| Δ4-10 | `cli/themeRegistry.js` 在 D1 逻辑层用裸 fs 读 themes/*.json 并在模块级实例化数据源，且带 `os.homedir()` 拼用户家路径 | `cli/themeRegistry.js`（316 行，D1）:48 模块作用域 `readFileSync(default.json)` 实例化 `_defaultTheme`、:153-156 `readdirSync` + `readFileSync` 装 `_themes` Map、:171 `readFileSync(CUSTOM_THEME_FILE)`；:27 `path.join(os.homedir(),'.khyquant')` | 抽象层 ThemeRepository（装载/归一/缓存/失败策略各自声明）；路径解析委托 `utils/dataHome` | B10 | high |
| Δ4-11 | ccTheme.js 色板数据住在 D1 逻辑层，是 JS 模块不是 JSON | `cli/tui/theme/ccTheme.js`（165 行 JS 模块）承载 `CC_COLORS`/`CC_THEME`/`SEMANTIC`，约 20 个 TUI 消费者 require | `src/cli/data/ccTheme.json`；明确不合入 `cli/themes/*.json`（两套 schema 不同，check:tui-gates 要求 CC 视觉逐字节不变） | 裁定 K / B10 | medium |
| Δ4-12 | 手机页文案有两份（实为三份）完全独立的内联副本，裁定 N 明确不合并 | `webRemoteControl/mobilePage.js`（189 行，:11 COPY 31 条）+ `bridge/mobilePage.js`（1372 行）+ `bridge/mobilePage.chat.js`（379 行），各自内联中文 UI 与内联 CSS/JS；消费者分别是 `webRemoteControl/server.js:37` 与 `bridge/bridgeServer.js:285` | 两份 mobilePage 各自把文案归位（不合并模板）；验证 `node --test src/dataAccess/__tests__/mobilePageCopy.test.js` 渲染整页 HTML strictEqual | 裁定 N / B10 | medium |
| Δ4-13 | 两份 345KB i18n 资产键数差 1，且 mobilePage.js 注释指向的是不在用的那一份 | renderer 版 345291 字节 / 5069 leaf（在用的 i18next 语言包）；zcode-analysis 版 345343 字节 / 5070 leaf（ZCode 解包提取的真源资产）。实测差集：`workspaceSidebar.showFileTree` 仅 zcode-analysis 版有，renderer 版无独有键。且 `webRemoteControl/mobilePage.js:6` 的注释把文案真源指向 zcode-analysis 版 | （方案未裁定）需要明确谁是桌面端/手机页文案的真源，以及两份的机械同步机制 | （无批次） | high |
| Δ4-14 | `cli/commands/registry.json` 是零消费者的死数据，与在用的 registry.js 并存 | 实测全 src grep `'commands/registry\.json'` 零命中。在用的是同目录 registry.js（内联 JS 对象，中文 description 直接写在对象里） | `cli/commands/registry.json` 是死数据：B0 删或显式登记待接线 | B0 / 裁定 N | medium |
| Δ4-15 | `src/data/cliAnythingTemplates/**` 是 D6 目录里的 D1 代码（require IO + 反向 require 进 src/cli） | `node_skeleton/index.js:4,6` require commander/../package.json，:36 与 :50 require `'../../../cli/handlers/session.js'`（解析后落 src/cli = D1）；`backend.js:3-5` require child_process/fs/path，:30 `path.join(require('os').homedir(),'.local','bin',name)` | D6 roots 显式排除 `src/data/cliAnythingTemplates/**`（它是生成工程的脚手架代码，不是内容资产） | 裁定 G | medium |
| Δ4-16 | `src/data/bugCases.js` 是纯净数据但载体是 .js | 228 行，零 require / 零 readFileSync / 零 process.env，`BUG_CASES` 为纯数组字面量 | `src/data/bugCases.json` + 原文件留 re-export 壳 | B6 | low |
| Δ4-17 | SidebarPanel.js 的本地 `t()` 是截断助手不是翻译函数——grep `t(` 会得到假的 i18n 采用度 | `SidebarPanel.js:163` `const t = (s) => truncateToWidth(s, innerW, measure)`，被 :205,209,220,385 四处调用，传入 '当前'/'发送消息后将显示任务'/'· 待命中' 等中文字面量。全 src 仅 7 处 `t('`：4 处是它、2 处是 i18n/index.js 的 JSDoc、1 处是 prompts.js:1393 调 promptLocales | （方案未提及）B10 之前必须先排除这个假阳性，否则「t() 调用数」会被它推高 | B10 | high |
| Δ4-18 | 方案规定的四个新建数据/抽象目录今天都不存在 | `src/dataAccess/`、`src/cli/data/`、`src/tools/data/`、`src/data/i18n/` 四个目录实测均不存在；`src/blueprints/`、`src/templates/`、`src/contracts/`、`src/cli/themes/`、`src/i18n/locales/` 已存在 | 裁定 A：只建 `runtime/node/backend/src/dataAccess/`（src/repos、src/services/di、src/utils/dataCard 不新建） | B10 | low |
| Δ4-19 | B10 的验证命令引用的测试与守卫今天不存在，包括一个被 8 处文档引用的幽灵守卫 | `src/i18n/__tests__/parity.test.js` 不存在（src/i18n 下无 __tests__）；`scripts/ci/check-i18n-fidelity.js` 磁盘上不存在，却被 8 处文档引用（apps/khyos-desktop/CLAUDE.md、apps/khyos-desktop/docs/[ZC-ALIGN-001]、[DESIGN-ARCH-092]、[DESIGN-ARCH-187] 自身、[DESIGN-ARCH-091]、works/record/ai/hq/prompts/feature/密钥端点中心管理-KeyManager.md）。`check-data-logic-separation.js` / `check-data-layer-purity.js` / `check-config-schema-sync.js` / `check-env-defaults.js` 同样均不存在；`check-tui-gates.js` 已存在 | B10 验证命令逐条可跑；裁定 H 要求新守卫同批登记进 FEATURE-OWNERSHIP.json rollout.mechanisms[] 并挂 check:* 别名或 wiring-exemptions.json | B10 | medium |
| Δ4-20 | 三个前端（ai-frontend / khyquant frontend / Flutter client）合计约 1.3 万行中文文案无任何 i18n 载体，方案未给它们排批次 | `delivery/web/ai-frontend/src`（Vue/JS）实测 5241 行含中文、`delivery/channel/khyquant/frontend/src` 6723 行、`delivery/mobile/khy-os-client-app/lib` 1332 行 dart 含中文；三处均无 i18n 框架（ai-frontend/src/main.js 无 i18n 引用，flutter lib 下无 i18n/l10n/locale 目录）。方案 §1.4 列了 32 个前端耦合点，但 §4 批次表只有 B10 一句「services 用户可见文案分批接 t()」 | （方案未给前端批次） | （无批次） | medium |
| Δ4-21 | domain-direction 基线实测读数与裁定 O 的前提一致，但 layout 三错误是 B0 前置 | 实跑 `node scripts/ci/check-repo-layout.js --json`：domain-direction 195（d3-purity 36 / d2-no-reach-into-d1 156 / no-reach-into-archive 3），另有 3 条 error（root-shadow-dir 2 个、root-junk 2 个、layer-registry 2 个顶层目录未登记）、root-uncatalogued 5、dangling-task 101、cross-layer-require 37、functional-unit 263、entry-buffer 2470 | 裁定 O：check-repo-layout 的 3 条既有 error 列为 B0 前置 | 裁定 O / B0 | low |
| Δ4-22 | 裁定 C 只登记了 prompts.js:18 一条 D3→D1 allowlist，但实测同级还有 28 条同类边 | `constants/prompts.js` 实测 29 处 `require('../services/')`；全仓 d3-purity 基线 36 处。未逐条拆分 constants/ 占其中多少、prompts.js 的 29 条是否全在这 36 处内 | 裁定 C：`constants/prompts.js:18` 这一条 D3→D1 边保留并登记进 `repo-layout-baseline.json` 的 allowlist，带 `// TODO(#<task>)` 与到期日；不宣称「constants 恢复零 D1 依赖」 | 裁定 C | medium |

---

### 3.5 流域五：持久化与配置数据流（40 边 / 16 真源 / 20 差异点）

#### 3.5.1 现状流（边表）

| 边号 | from（产地） | to（消费方） | 机制 | 证据 `file:line` | violates | 说明 |
|---|---|---|---|---|---|---|
| F5-E1 | `src/bootstrap/init.js:_doInit` | `process.env`（canonical .env） | env-read | `bootstrap/init.js:164-169` | none | 第一层 env 装载：`KHY_ENV_FILE` 或 `<KHYQUANT_ROOT\|backendRoot>/.env`，经 `dotenv.config` |
| F5-E2 | `src/bootstrap/init.js:_doInit` | `~/.khy/.env` 用户覆盖层 | readFileSync | `bootstrap/init.js:180-188` | none | 第二层：`path.join(getDataHome(),'.env')`，`override:false`；catch 兜底 `path.join(os.homedir(),'.khy','.env')` |
| F5-E3 | `runtime/substrate/platform/packages/shared/src/config/database.js:46-49` | `process.env`（第三处 .env） | require | `shared/src/config/database.js:19-49` | none | require 时副作用：仅当 `!KHY_ENV_FILE` 时加载 `findProjectRoot()/.env`（本仓落点 runtime/substrate/platform）。与 init.js 两处构成三套独立仓根解析 |
| F5-E4 | `src/config/database.js` | `@khy/shared/config/database` → `shared/src/config/database.js` | re-export | `src/config/database.js:1`；`runtime/substrate/platform/packages/shared/config/database.js:4` | none | src/config 下 3 个文件（database/env/sqlite-adapter）都是 1 行 re-export，真实逻辑在 D1 根 runtime/substrate/platform 下 |
| F5-E5 | `runtime/substrate/platform/packages/shared/src/config/database.js:getSQLitePath` | `src/services/accountPool.js:resolveSequelize`/`init` | require | `shared/src/config/database.js:74-88`；`accountPool.js:110-128, 250-255` | none | accountPool 的 `_db` 全部来自这里；调用方可用 `init(sequelize)` 注入 |
| F5-E6 | `runtime/substrate/platform/packages/shared/src/config/database.js:74-88` `getSQLitePath` | `~/.khy/khyquant/data/khy-quant.db`（实测存在） | env-read | `shared/src/config/database.js:74-88` | none | 第三条平行数据家链：`KHY_APP_HOME\|\|KHY_DATA_HOME\|\|KHYQUANT_DATA_HOME` → `<home>/khyquant/data/khy-quant.db`；否则 `<packages/shared>/.khy/...`。不读 `~/.khy/.location.json`、不读 .portable marker、不经 `utils/dataHome` |
| F5-E7 | `~/.khy/.location.json`（实测 dataHome=`C:\Users\25789\.khy`，projectDataHome=`D:\Portable\khy-os\works\data\khy`） | `src/utils/dataHome.js:_readPointer` | readFileSync | `dataHome.js:187-192, 270-286` | none | 指针常驻系统盘；`_fromPortablePointerValue` 支持 `~PORTABLE~/` 相对形式与拖拽迁移自愈 |
| F5-E8 | `src/utils/dataHome.js` | 375 处消费点 / 238 个文件 | function-call | `dataHome.js:353`（require 行）；导出块 `:898-923` | none | ※L1-6：实测导出块为 **25 个名字（16 公开 + 9 下划线内部）**（原记 18）；调用点实测 **590 处 / 322 文件**（原记 375/238）。6 个并列解析器（`getDataHome`/`getAppHome`/`getProjectDataHome`/`getBaseHome`/`getAppRoot`/`getLegacyDataHome`）+ `DATA_PATHS` 改名表 **65 条（表体 :45-128）**（原记 50 条 :75-128）；方案称其为 B8 唯一正解，但它自己内部分叉 |
| F5-E9 | `src/utils/dataHome.js:getAppHome` | `src/services/modelPricing.js:224` / `src/services/gateway/routingMode.js:649` / `src/services/modelFeatureRegistry.js:125`（运维覆盖层） | function-call | `dataHome.js:662-705` | none | legacy established-wins：本机 `~/.khyquant` 已 established → `getAppHome()=~/.khyquant`，而 `getDataHome()=~/.khy`。同一进程两个家 |
| F5-E10 | `src/services/accountPool.js:154-224` `ensurePoolSchema` | `khy-quant.db`（`account_pool` / `account_leases` / `account_pool_active` / `account_pool_config` 四张裸表，实测在库） | sql-query | `accountPool.js:154-224` | D1-no-literal | §2.2 D1 硬禁明列「SQL/DDL 字符串」。`src/models/` 21 个 model 无一张覆盖这四张表 |
| F5-E11 | `src/services/accountPool.js`（64 处 `_db.query`） | `khy-quant.db` | sql-query | `accountPool.js:363, 828, 840` | D1-no-literal | 实测关键字计数：CREATE 8 / SELECT 22 / UPDATE 19 / DELETE 9 / INSERT 6 / ALTER 1 / PRAGMA 1。WHERE 片段用 `${norm ? 'WHERE pool_type = :poolType' : ''}` 三元拼接（值仍走 :name 替换） |
| F5-E12 | `src/services/accountPool.js:70-93` `TRAE_STORAGE_PATHS` | 外部 IDE 登录存储（6 处 `os.homedir()`） | homedir-path | `accountPool.js:70-93` | D1-no-literal | require 时求值。属外部工具路径而非 khy 数据家——J-04 的 grep 判据无法区分这两类 |
| F5-E13 | `src/services/domain/account/accountPool/candidateDetect.js` | Cursor/Warp/Kiro(AWS SSO) 等外部凭据存储（32 处 `os.homedir()`） | homedir-path | `candidateDetect.js:41-142` | D1-no-literal | 同属外部路径。src/services/domain 下 90 处 homedir 中约 1/3 是这一类，J-04 若一律要求改走 dataHome 会误伤 |
| F5-E14 | `src/constants/serviceDefaults.js` | 全仓 env 默认值消费方 | env-read | `serviceDefaults.js:24-155`（131 处 `process.env.`） | none | §2.2 D6 硬禁把「constants/ 的 env 默认值」列为唯一例外，范式确认为模块级 `const = process.env.X \|\| 字面量`（require 时求值） |
| F5-E15 | `src/constants/serviceDefaults.js:61-85` `_discoverAiBackendUrl` | `getDataHome()/ai_manage_runtime.json` + `getLegacyDataHome()/ai_manage_runtime.json` | readFileSync | `serviceDefaults.js:61-85`（唯一 fs 使用点 :70） | D6-purity | §2.1 把 constants/ 描述为「纯叶」，§2.2 D6 硬禁「不得含 IO」；此处在 constants 内做文件系统访问与运行时状态发现 |
| F5-E16 | `src/services/aiManagementServer.js:74` | `CONVO_DIR` / `ACCOUNT_CB_FILE`（account_pool_circuit_breaker.json） | function-call | `aiManagementServer.js:74-76` | none | require 时冻结数据家。方案与既有 RUNTIME-012 守卫均未覆盖「顶层常量初始化调 getDataHome()」这一失效模式（实测 21 处 + 8 处 IIFE） |
| F5-E17 | `src/services/aiManagementServer.js:21-108` | aiManagementServer 13 组运维默认值 + `DEFAULT_PLUGIN_TEMPLATE` | inline-literal | `aiManagementServer.js:21-108`（实测 27 处 `process.env.X \|\|`） | D1-no-literal | `DEFAULT_PLUGIN_TEMPLATE` 结束于 :108（方案写 :85） |
| F5-E18 | `src/cli/replSession.js:8183-8212` | @path / 读文件安全闸（R2 执行面） | inline-literal | `replSession.js:8183-8212` | D1-no-literal | `BLOCKED_NAMES` 18 条 + `BLOCKED_EXTS` 7 条 = 25 条，声明在函数体内每次调用重建；解析基准用 `process.env.KHYQUANT_CWD \|\| process.cwd()`。※L1-6：`.some()` 带 startsWith/endsWith 的语义实际还会拦 `.env.local`、`credentials.json`、`id_rsa.pub`，比 token.txt 一例更宽 |
| F5-E19 | `src/cli/atMentionInject.js:31-50` | @mention 注入安全闸（R2 执行面·第二份） | inline-literal | `atMentionInject.js:31-50, 176` | D1-no-literal | `SENSITIVE_NAMES` 17 条 + `SENSITIVE_EXTS` 7 条。与 replSession 那份已漂移：少 'token' 一条，且用 `Set` 精确匹配而非 startsWith/endsWith → token.txt 一条放行一条拦截 |
| F5-E20 | `src/cli/handlers/gateway.js:1445-1560` | provider 目录表（`API_PROVIDER_DISPLAY_NAMES` / `API_PROVIDER_ENV_KEYS`） | inline-literal | `gateway.js:1445-1560` | D1-no-literal | 11 个 `defaultEndpoint` URL 字面量；env 键名与默认端点同表内联（主归属为供应商与渠道流 F2-E9/E10，本流只作交叉引用） |
| F5-E21 | `src/services/gateway/providerPresets.js:64-323` | provider 预设目录（470 行） | inline-literal | `providerPresets.js:64-323, 354-395` | D1-no-literal | R2 形态：只含公开 URL，剥离逻辑内联在 normalize（:391 注释说明不复制 raw.key/apiKey）。全仓 grep `stripSecrets` 0 命中——方案 §2.4.8 的接口今日无对应实现（主归属为供应商与渠道流 F2-E2） |
| F5-E22 | `src/services/freeModelChannels.js:33-40` | 智谱 7 个免费模型 id | inline-literal | `freeModelChannels.js:33-40` | D1-no-literal | 与 `src/services/gateway/zhipuFreeModels.js:39-65` 的第二份记录逐字节一致（方案 B6 已识别），权威源由 freeModelChannels.js:20 注释裁定（主归属为供应商与渠道流 F2-E6） |
| F5-E23 | `src/services/modelPricing.js:209-245` `_loadTable` | `config/models/pricing.json`（出厂）+ `<appHome>/model_pricing.json`（运维覆盖） | readFileSync | `modelPricing.js:209-245`（:213-219 env 内联、:223-225 appHome、:226-227 homedir 兜底、:228 仓内） | D1-no-literal | 四层：`KHY_MODEL_PRICING_JSON` 内联 → `KHY_MODEL_PRICING_FILE` 显式文件 → `getAppHome()` → 仓内文件；:226 有 `os.homedir()/.khyquant` 兜底。与 modelPricing 在模型流的登记（F1-E34）已统一标签与锚点 ※L2-6 |
| F5-E24 | `src/services/gateway/routingMode.js:634-670` `_loadCard` | `config/models/routing-modes.json` + `<appHome>/routing_modes.json` | readFileSync | `routingMode.js:634-670`（:655 homedir 兜底） | D1-no-literal | 同型四层（`KHY_ROUTING_MODES_JSON` / `_FILE` / appHome / 仓内）。与 modelPricing 是两份同范式的平行实现 |
| F5-E25 | `src/services/modelFeatureRegistry.js:117-175` | `config/models/features.json` + `<appHome>/model_features.json` | readFileSync | `modelFeatureRegistry.js:11-21, 63, 117-130, 160-175` | D1-no-literal | 仓内最丰富的既有分层解析器：8 层（env 内联 JSON → 内存运行时覆盖 → appHome → repo models[id] → patterns[] → tierDefaults → 代码推断 → defaults）+ TTL/mtime+size 闸 + 2000ms 编辑信任阈值。※L2-6：补记 catch 内 homedir 兜底（:124-129 `path.join(os.homedir(), '.khyquant', HOME_FILE_NAME)`），violates 由 `none` 统一为 `D1-no-literal`，与模型流 F1-E36 同标签 |
| F5-E26 | `src/cli/repl/khySettings.js:52-58` `_userSettingsFile` | `~/.khy/settings.json`（用户层） | homedir-path | `khySettings.js:44-58` | D1-no-literal | 硬编码 `_homeDir()/.khy/settings.json`，不经 `getDataHome()`；`_homeDir()` 优先 `USERPROFILE`/`HOME` env——第五套 home 解析机制，指针对它完全失效 |
| F5-E27 | `src/cli/repl/khySettings.js:79-85` `_settingsLayers` | user / project-shared / project-local / managed 四层 | readFileSync | `khySettings.js:63-85, 137-150` | none | project 两层 cwd 相对（`<cwd>/works/data/khy/settings.json`）；managed 层 fallback `'C:\\ProgramData'` 是硬编码盘符；:263-305 的 TOML 第五层从未生效 |
| F5-E28 | `src/cli/repl/configTomlOverlay.js` | `src/cli/repl/khySettings.js:288` `resolveKhySettingsWithToml` | require | `configTomlOverlay.js:25-30, 56`；`khySettings.js:285-292` | none | 死代码：文件用 `export function`（ESM）却住在 CJS 包内且内部用 require，实测 require 抛 "require is not defined in ES module scope"，被 khySettings 的 catch 吞掉 → 头注释承诺的 config.toml 只读覆盖层从不生效 |
| F5-E29 | `src/config/a2aConfig.js:36-84` `buildConfig` | A2A 11 个 env+默认值 + `workspaceBaseDir` | env-read | `a2aConfig.js:36-84`（cwd 兜底 :64） | D1-no-literal | 方案 B9 点名 `a2aConfig.js:64` 残留 cwd 兜底，已实测确认（catch 分支 `path.resolve(process.cwd(),'.khy','agent-workspaces')`） |
| F5-E30 | `src/services/configSyncService.js:84-91` | `getDataHome()/config.json` + `_UserSetting` 动态模型 | function-call | `configSyncService.js:84-91, 124` | none | require 时 IIFE 冻结 `LOCAL_CONFIG_PATH`；:124 `sequelize.define('UserSetting')` 是绕过 src/models/ 的第 23 个动态模型 |
| F5-E31 | `src/services/learningCurriculum.js:200, 223` | `src/data/curriculum.json`（包内出厂资产） | readFileSync | `learningCurriculum.js:200, 223, 1046, 1057, 1073` | none | 四个写入口（addLayer/removeLayer/updateLayer/addTopic）直接 `fs.writeFileSync` 进 src/data/；进度另走 `getBaseDataDir('growth')`。D6 纯内容资产实为运行时可变文件 |
| F5-E32 | `src/services/featureFlags.js:40, 114` | `getDataHome()/features.json` | readFileSync | `featureFlags.js:36-58, 110-121` | none | 文档/代码漂移：头注释 :6 写 `~/.khyquant/features.json`，代码用 `getDataHome()`（本机 ~/.khy） |
| F5-E33 | `src/{coordinator/taskBoard.js:67-82, services/sessionSearchIndex.js:24-38, services/deliveryLedger.js:63-69, services/a2aAgentLifecycle.js:58-64, services/dbHealthService.js:247/985/1513, routes/largeTasks.js:137}` | 各自 SQLite/JSONL 状态文件 | homedir-path | 见左列行号 | D1-no-literal | 统一的 `try{getDataDir(...)}catch{process.cwd()+'.khy'\|'.khyquant'\|'.khy-runtime'}` 模式，7 处活码。全仓另有 126 处 homedir 出现在 catch 兜底里 |
| F5-E34 | `src/services/gateway/adapters/_endpointResolver.js:18-28` | adapter 端点 URL | env-read | `_endpointResolver.js:18-28` | D1-no-literal | `defaults.CLAUDE_API_ENDPOINT` / `OPENAI_API_ENDPOINT` / `API_ENDPOINT` / `RELAY_API_ENDPOINT` / `DEEPSEEK_API_ENDPOINT` / `LOCAL_LLM_ENDPOINT` 六个 key 在 serviceDefaults.js 中均未定义（已 grep 证实）→ `defaults.X` 恒 undefined，字面量才是实际默认值 |
| F5-E35 | `src/constants/serviceDefaults.js:50`、`src/services/daemonEntry.js:25`、`src/services/daemonManager.js:20` | daemon 端口 9090 | inline-literal | `serviceDefaults.js:50`；`daemonEntry.js:25`；`daemonManager.js:20` | D1-no-literal | 同一个 `KHY_DAEMON_PORT` 默认值三份独立 `parseInt(process.env.KHY_DAEMON_PORT \|\| '9090', 10)` |
| F5-E36 | `src/cli/handlers/proxy.js` + `src/services/embeddingClient.js:98` | 代理端口 9100 | inline-literal | `cli/handlers/proxy.js:56, 623, 1133, 1158, 1171, 1261`；`embeddingClient.js:98` | D1-no-literal | 6 份 '9100' 字面量（另有多处注释内 9100） |
| F5-E37 | `src/config/sqliteCompat.js` | `runtime/substrate/platform/packages/shared/src/config/sqliteCompat.js` | require | `shared/src/config/database.js:226`（7 层深相对 require）；md5 比对两文件不同 | none | 两份 243 行的近似副本且行为已分叉（backend 版多出 null/undefined/Buffer/bigint 归一分支）。shared 版用跨 workspace 深相对路径反 require backend 版——即 check-repo-layout 的 cross-layer-require（37 处）所禁形态 |
| F5-E38 | `docs/10_规范/registry/DATA-LOCATIONS.json` | `src/utils/dataHome.js:DATA_PATHS` + `scripts/ci/check-data-layout.js` 预算常量 | json-parse | `DATA-LOCATIONS.json:2`（ssot 声明）；`dataHome.js:45-128`；`check-data-layout.js:19-25` | none | 自陈「数据落点单一真源，禁止在任何一处手写第二份」，但三处之间无代码联结，靠人工同步。`roots.khy.accessor` 写 `getProjectDataHome()`，实际运行态大量代码用 `getDataHome()`/`getAppHome()` |
| F5-E39 | `src/utils/flagRegistry/index.js:55` `isRegistryEnabled` | 275 个消费方 | function-call | `flagRegistry/index.js:4, 55`（4017 行） | none | 第三套 env 真源：`KHY_*` 开关声明式中央注册表（纯叶），与 serviceDefaults 的 131 处 env 直读、shared/config/env.js 的 `applyEnvDefaults` 11 项默认值三套并行 |
| F5-E40 | `src/constants/prompts.js` | 系统提示词装配 | env-read | `prompts.js:266, 513, 573, 601, 1370, 2116, 2472` 等 14 处直读 + 多处 `isFlagEnabled` 间接读 | none | prompts.js 自己当配置解析器（方案 §1.3 #3）；※L2-5：本流「14 处直读」口径与提示词流的统一分解一致（14 直读 / 10 isFlagEnabled / 13 对象透传），主归属为提示词与命令面流 F3-E56 |

#### 3.5.2 真源清单（16）

| # | 路径 | 角色 | driftRisk |
|---|---|---|---|
| T5-1 | `docs/10_规范/registry/DATA-LOCATIONS.json` | 数据落点单一真源（roots/tiers/budgets/formats/seedEntries），自陈派生 `utils/dataHome.js` 的 `DATA_PATHS`、`check-data-layout.js` 预算常量、.gitignore 数据段 | contested |
| T5-2 | `src/utils/dataHome.js` | 运行态数据家解析器（方案指定的 B8 唯一正解）：6 个并列解析器 + 指针读写 + portable 判定 + 65 条 DATA_PATHS 改名表 + storageRoots 驱动挑选 | single-source |
| T5-3 | `runtime/substrate/platform/packages/shared/src/config/database.js` | Sequelize 实例与 SQLite 文件路径的真源（`src/config/database.js` 只是 1 行 re-export）；同时是第三处 dotenv 装载点 | contested |
| T5-4 | `src/constants/serviceDefaults.js` | env 默认值与外部服务 URL/端口 SSOT（691 行 / 131 处 `process.env.`） | duplicate |
| T5-5 | `src/utils/flagRegistry/index.js` | `KHY_*` 开关声明式中央注册表（4017 行 FLAGS，275 个消费方），与 serviceDefaults 构成两套并行 env 真源 | duplicate |
| T5-6 | `runtime/substrate/platform/packages/shared/src/config/env.js` | `applyEnvDefaults`/`validateRequiredEnv`（11 项默认值 + `JWT_SECRET`/`DB_TYPE` 校验），`src/config/env.js` 的 1 行 re-export 目标 | duplicate |
| T5-7 | `src/services/accountPool.js` | account_pool 四张表的 DDL/CRUD/SQL 拼接唯一实现处（64 处 `_db.query`），绕过 src/models/ | single-source |
| T5-8 | `~/.khy/.location.json` | 数据家 pinned 指针（dataHome / projectDataHome），决定 `getDataHome()` 与 `getProjectDataHome()` 的落点 | single-source |
| T5-9 | `src/cli/replSession.js:8183-8212` | R2 敏感文件名/扩展名拦截清单（`BLOCKED_NAMES` 18 + `BLOCKED_EXTS` 7） | duplicate |
| T5-10 | `src/cli/atMentionInject.js:31-50` | R2 敏感文件名/扩展名拦截清单第二份（`SENSITIVE_NAMES` 17 + `SENSITIVE_EXTS` 7），已与上一份漂移 | duplicate |
| T5-11 | `src/services/gateway/zhipuFreeModels.js` | 智谱免费模型 7 条记录的权威源（freeModelChannels.js:20 注释裁定），但 id 串在 freeModelChannels.js:33-40 有第二份（主归属为供应商与渠道流 T2-2） | duplicate |
| T5-12 | `src/config/sqliteCompat.js` | sqlite3 兼容层 backend 侧副本（243 行），与 `shared/src/config/sqliteCompat.js` 是两份已分叉的近似副本 | duplicate |
| T5-13 | `src/services/modelFeatureRegistry.js` | 模型差异化画像 8 层分层解析器（env 内联/内存覆盖/appHome/repo/patterns/tierDefaults/代码推断/defaults）+ TTL 热重载 | single-source |
| T5-14 | `src/services/modelPricing.js` + `src/services/gateway/routingMode.js` | 模型价格与路由档位卡的四层装载器（env 内联 → `*_FILE` → appHome → 仓内 config/models/*.json），同范式两份平行实现 | duplicate |
| T5-15 | `src/cli/repl/khySettings.js` | khy settings 四层（+失效的 toml 第五层）解析与写入点；用户层硬编码 `~/.khy/settings.json` | contested |
| T5-16 | `src/config/settingsWhitelist.js` | admin 设置键前缀白名单（system./user./security./trading./kline.），消费方为 routes/admin.js 与 routes/settings.js | unknown |

#### 3.5.3 目标流（187 方案条文摘录）

【§2.1 新目录结构·本域相关】`config/services/ai-management.json`（aiManagementServer 13 组运维默认值：webhook/session/auth/gc/http/autoImport/circuitBreaker/rateLimit/newModelCache/defaultPluginTemplate/staticContentTypes）；`src/constants/aiManagementDefaults.js`（ai-management.json 的 getter 视图，与 compressionDefaults / gatewayRetryBudget / toolLoopDefaults / effortPresets / layoutTokens / agentColors 并列新增）；`src/dataAccess/`（唯一抽象层·接口层，新建 src 顶级目录）含 `index.js`（门面）、`khy.module.json`、`di/tokens.js`（31 个字符串 token）、`di/registry.js`（register/resolve/createScope/resetForTest）、`loaders/jsonRepository.js`（readdir+parse+fail-soft 单条隔离 + schema 校验 + mtime 热重载，meta 不写回数据对象）、`loaders/dataCardLoader.js`（四个命名装载器：loadModelPricing / loadRoutingModes / loadPublicApis / loadSearchEngines）、`configResolver.js`、`schema.js`、`contracts.js`、`paths.js`（DataPathResolver，委托 utils/dataHome）、`repositories/`（19 个，含 accountPool.js）；`src/bootstrap/dataAccess.js`（默认 file-backed provider 注册表，组装层）；`domain/account/accountPool/sql.js`（纯字符串 SQL 数据模块）；`utils/dataHome.js`（B8 唯一正解，「勿另写第三套」）。

【§2.2 分层硬禁】D6：不得 require D1/D2/D4、不得含 IO、不得含 process.env（constants/ 的 env 默认值是唯一例外，且必须是 `const X = process.env.Y \|\| 字面量` 既有范式）；D3（src/dataAccess + src/i18n/index.js + src/config/*.js）：不得 require 逻辑层、不得含业务规则；D1/D2：不得含业务字面量表、URL 与端口字面量、SQL/DDL 字符串、`os.homedir()` 拼用户家路径、提示词正文与用户可见文案、`process.env.X \|\| 默认值` 成对书写、裸 `fs.readFileSync` 读数据资产；组装层：全仓唯一允许把数据源实例化并交给逻辑层的地方，不得承载业务规则本身。

【§2.3 环境 vs 业务配置分界】环境配置载体：`src/constants/serviceDefaults.js`（env 名+默认值+||兜底）、`.env` 模板、新增 `src/config/envDefaults.js`（唯一声明真源，纯叶零 IO 可 AST 校验）；加载路径 = 模块级 const（require 时求值）或 getter；不热更；R2 真 key 只经 env 瞬时注入绝不落盘。业务配置载体：`config/**/*.json`、`src/data/**`、`src/constants/*Defaults.js`；加载路径 = ConfigResolver 四层（env 内联 → `<appHome>/<file>` 运维覆盖 → `config/<file>` 出厂 → 代码兜底）；可热更（hotReload:'mtime' opt-in，默认 'never'）；数据文件零密钥，装载器必须过 stripSecrets()。守卫：环境侧 check-agent-rules.js 的 no-hardcoded-prod-domain + 新增 check-env-defaults.js；业务侧 check-data-logic-separation.js denylist + check-data-layer-purity.js。明确不迁移：`Math.max(floor, parseInt(process.env.X \|\| 'd', 10) \|\| d)` 形站点不批量迁 utils/envInt。

【§2.4.5 ConfigResolver】`createConfigResolver(spec)`，spec = `{key, envName, parse:'string'\|'int'\|'num'\|'bool'\|'json', defaults, homeFileName, file}`；返回 `get(env)`/`reload()`/`source(env)`→'env'\|'appHome'\|'repo'；`_parse` 对空串返 undefined。

【§2.4.7 配置 Schema】`config/services/ai-management.json`，13 组，默认值与现行内联字面量逐字节相同、env 名全部保留。

【§2.4.8 仓储接口·本域】accountPool = `{ ensureSchema, ensureColumn(table,col,ddl), upsertTokenRecord, listByPoolType, acquireLease, releaseLease, getConfig, setConfig }`；SQL 字符串住在纯数据模块 sql.js。

【裁定 I】`src/config/*.json` 声明式配置入 D6；`src/config/*.js` 装载/解析入抽象层(D3)；src/config 整体不进 D6 roots；只建 `src/config/envDefaults.js`，不建 envDeclarations.json。

【B5】serviceDefaults.js 新增 `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / `AI_PROXY_DEFAULT_PORT`(+HOST)，保留 `CLAUDE_API_ENDPOINT` / `OPENAI_API_ENDPOINT` 为主覆盖口，不全局改 getter。

【B7】ai-management.json + aiManagementDefaults.js；contextCompressor 约 15 阈值 → compressionDefaults.js；重试预算 → gatewayRetryBudget.js（不合并两套）；toolUseLoopCore 约 60 处 env → toolLoopDefaults.js（一律 getter）。

【B8】accountPool.js DDL/SQL → `domain/account/accountPool/sql.js`（纯字符串）+ AccountPoolRepository 薄壳；webSearchService+webToolsService 合一为 SearchEngineRepository（含 `configPath()`）；bugCases.js 拆 `src/data/bugCases.json` + re-export 壳；routingMode/localBrainService 换命名装载器（不新增 env/appHome 层）。

【B9】按子域把 `os.homedir()` 拼路径改走 utils/dataHome；外加 `src/config/a2aConfig.js:64` 残留 cwd 兜底；`domain/data/data/DataLocation.js` 删除或挂弃用壳。

【J-03/J-04/J-05/J-06】逻辑层业务字面量 denylist（`api.anthropic.com\|api.openai.com\|api.deepseek.com\|'9100'\|'9090'\|'gpt-4o'\|CREATE TABLE\|SELECT .* FROM account_pool\|'.khyquant'\|'.khy'`）白名单外 0 命中；`os.homedir()` 白名单只降不升且每条带理由与到期日；`process.env.KHY_*\|\|` 新增 0 存量只降不升；SQL 只命中 `domain/account/accountPool/sql.js` 与 src/models。

#### 3.5.4 差异点表（20）

| # | 差异点 | 现状 | 目标态 | 批次 | 风险 |
|---|---|---|---|---|---|
| Δ5-1 | 抽象层 `src/dataAccess/` 整体不存在；D6 域未建 | `runtime/node/backend/src/dataAccess/` 目录不存在（ls 报 no such file）；`config/services/` 不存在；`src/config/envDefaults.js` 不存在；DOMAIN-DEPS.json 只有 D1-D5，无 D6，D3 roots 仅 src/utils + src/constants | §2.1 + 裁定 A/G/I：建 `src/dataAccess/{index.js,khy.module.json,di/,loaders/,configResolver.js,paths.js,repositories/}`；DOMAIN-DEPS.json 增 D6 roots 并把 D6 加进 D1/D2/D3 的 mayDependOn | B0 | blocking |
| Δ5-2 | `src/config/*.js` 的抽象层归属无法被现有守卫执行 | 裁定 I 把 `src/config/*.js` 划抽象层(D3)，但 DOMAIN-DEPS.json 的 D3 roots 只有 src/utils 与 src/constants，src/config 不在任何域 roots 里；且真实逻辑在 `runtime/substrate/platform/packages/shared/src/config/`（属 D1 根 runtime/substrate/platform） | `src/config/*.js` 入 D3、`*.json` 入 D6，src/config 整体不进 D6 roots | 裁定 I / B0 step 6 | high |
| Δ5-3 | ConfigResolver 四层优先级今天没有统一实现，且方案的规格比既有实现更弱 | 四套互不兼容的分层解析器：`modelPricing.js:209-245`（4 层）/ `routingMode.js:634-670`（4 层）/ `modelFeatureRegistry.js:117-175`（8 层，含内存运行时覆盖、`*_FILE` 显式文件、mtime 热重载、patterns/tierDefaults 逐层深合并）/ `khySettings.js:79-85`（4 层+失效的 toml 层） | §2.4.5 单一 `createConfigResolver({key,envName,parse,defaults,homeFileName,file})` → `get`/`reload`/`source`，四层 env 内联 → appHome → config/ → 代码兜底 | §2.4.5 / B7 | high |
| Δ5-4 | 「运维覆盖层」的物理落点在本机不是方案假设的那一个 | `DATA-LOCATIONS.json` `roots.khy.accessor` = `getProjectDataHome()`（→ `<repo>/works/data/khy`）；运行态 `getDataHome()` = `~/.khy`（指针 established-wins）、`getAppHome()` = `~/.khyquant`（legacy established-wins）。三个家并存，方案 dataCardLoader/configResolver 只承认 `getAppHome()` | 配置覆盖层统一经 `<appHome>/<file>`（getAppHome()） | §2.4.5 / B9 | high |
| Δ5-5 | SQLite 数据库文件路径不走 utils/dataHome，是平行的第三条数据家解析链 | `shared/src/config/database.js:74-88` `getSQLitePath()` 用 `KHY_APP_HOME\|\|KHY_DATA_HOME\|\|KHYQUANT_DATA_HOME` → `<home>/khyquant/data/khy-quant.db`；否则落 `<packages/shared>/.khy/...`。不读 `~/.khy/.location.json`、不读 .portable marker。实测库在 `~/.khy/khyquant/data/khy-quant.db` | §2.1 `dataAccess/paths.js`「DataPathResolver（委托 utils/dataHome）」+ B9 把路径收敛到 dataHome | B9 | blocking |
| Δ5-6 | `findProjectRoot()` 与 `getAppRoot()` 是两套独立的仓根解析，给出不同答案 | `shared/src/config/database.js:19-35` 向上 6 层找带 workspaces 的 package.json（本仓落点 runtime/substrate/platform）；`dataHome.js:475-485` 用 `KHY_OS_ROOT` 或 __dirname 上五层（落点仓库根）。.env 与 .khy 兜底路径因此分叉 | 路径解析归解析器（dataHome/paths.js），不归各自算法 | B9 | high |
| Δ5-7 | B0 前置「删 .khy/.khyos 影子目录」不修因，只清果 | check-repo-layout 报 root-shadow-dir 的处置说明明写「删掉它们，并修掉制造它的 cwd 相对写者」；实测仍有 7 处活码 cwd 相对写者（`a2aConfig.js:64`、`a2aAgentLifecycle.js:62`、`dbHealthService.js:247/985/1513`、`deliveryLedger.js:67`、`largeTasks.js:137`），加 126 处 catch 内 homedir 兜底 | B0 step 1 清 3 条 error 使每批闸门可跑 | B0 step 1 | blocking |
| Δ5-8 | R2 blockedPathPolicy 有两份且已实际漂移，方案只识别一份 | `replSession.js:8183-8212`（18 名 + 7 扩展，`.some()` 带 startsWith/endsWith，含 'token'）与 `atMentionInject.js:31-50`（17 名 + 同 7 扩展，`Set` 精确匹配，无 'token'）并存。token.txt：REPL 路径拦截、@mention 路径放行。※L1-6：replSession 那份的 startsWith/endsWith 语义实际还会拦 `.env.local`、`credentials.json`、`id_rsa.pub` | §2.4.8 blockedPathPolicy 仓储统一 `isBlockedName`/`isBlockedExt`/`isBlockedPath`，25 条目 golden 测试 | B1 / J-13 | high |
| Δ5-9 | `stripSecrets()` 在全仓不存在，方案的 R2 装载器契约今日无对应实现 | grep `stripSecrets` 全 src 0 命中。`providerPresets.js:391` 的密钥剥离是 normalize 内的 inline 注释式实现；`providerPresets.js:13-14` 与 `freeModelChannels.js:11-12` 的头注释自称「绝不含密钥」但无机械断言 | §2.3 + §2.4.8：providerPresets/apiProviderCatalog 装载器每条返回路过 `stripSecrets()`，schema 断言无 `/(sk-\|AKIA\|Bearer \|-----BEGIN)/` | B3 / J-13 | high |
| Δ5-10 | J-05 的 env 兜底站点基数与实测不符，且 B7 会给 contextCompressor 新增 14 个 env 覆盖口 | J-05 写 toolUseLoopCore ~60 处，实测 6 处；aiManagementServer 13 组，实测 27 处 `process.env.X \|\|`；cli/handlers/gateway.js 8 处，实测 15 处；contextCompressor「约 15 阈值」实测是 14 个无 env 层的纯常量（:28-48）+ 1 个 env 阈值（:1370）+ 2 个 `envFlagEnabled` | J-05 基线「新增 0，存量只降不升」；B7 把 contextCompressor 约 15 阈值外置为 compressionDefaults.js | J-05 / B7 | medium |
| Δ5-11 | B5 的端点/端口收敛文件清单漏了三处独立副本 | 裁定 E 已核实 serviceDefaults.js 未定义 `CLAUDE_API_ENDPOINT` 等 6 键；但 9090 另有 `daemonEntry.js:25` 与 `daemonManager.js:20` 两份独立默认值，9100 有 `cli/handlers/proxy.js` 5 处 + `embeddingClient.js:98` | B5 只列 serviceDefaults.js / _endpointResolver.js / proxyServer.js / aiManagementServer.js 四文件；grep 判据要求 `api.anthropic.com\|api.openai.com\|'9100'\|'9090'` 在 services 下 0 命中 | B5 / 裁定 E | medium |
| Δ5-12 | `src/data/` 被定义为 D6 纯内容资产，但 curriculum.json 是运行时可变文件 | `learningCurriculum.js:200,223` 的 `_saveCurriculumJSON` 对包内 `src/data/curriculum.json` 做 `fs.writeFileSync`，四个写入口（addLayer/removeLayer/updateLayer/addTopic，:1046/:1057/:1073）。pip install -U 会覆盖用户数据 | §2.1 `src/data/` = D6 纯内容资产（零 require/零 IO/零 env）；§2.4.3 jsonRepository 是只读仓储（list/get/has/reload/resetCache） | B8 / §2.1 | medium |
| Δ5-13 | 方案的 D6 roots 与既有 check-data-layout.js + DATA-LOCATIONS.json 的三态分层（T0-T4）是两套互不引用的落点台账 | §2.1 新建 src/data/、src/cli/data/、src/tools/data/、config/**/*.json 作为 D6 roots；`check-data-layout.js` L-1 要求「数据态根下出现的 T* 档必须登记在 DATA-LOCATIONS.json」，L-3 已覆盖「非 dataHome.js 的字面 .khy/.khyos 拼接」 | 裁定 G 定 D6 roots；B0 step 4 新建 check-data-logic-separation.js | B0 step 4/6 / 裁定 G | medium |
| Δ5-14 | 绕过 src/models/ 的不止 accountPool，DB 实际表数远超 21 个 model 文件 | `configSyncService.js:124` `sequelize.define('UserSetting')` 是第 23 个动态模型；实测 khy-quant.db 有约 40 张表，src/models/ 只有 21 个 model 文件；另有 8 个文件用裸 DDL 建表（bridgeAuth.js:110、taskBoard.js:129,157、auditLog.js:22、boulderState.js:53、sessionSearchIndex.js:68,77、traceAuditService.js:411） | J-06 只点名 accountPool.js 的 4 DDL + ALTER + 约 25 CRUD，目标「只命中 domain/account/accountPool/sql.js 与 src/models ORM 定义」 | J-06 / B8 | medium |
| Δ5-15 | B2 对 settingsWhitelist 三处一致的点名与实测消费方不符 | `settingsWhitelist.js` 头注释自陈消费方是 admin.js 与 settings.js；实测仅 `src/routes/admin.js:36` 与 `src/routes/settings.js:14` 两处 require，`cli/repl/khySettings.js` 不引用它 | B2 新建 `check-config-schema-sync.js` 机械校验 `src/config/settingsWhitelist.js`、`cli/repl/khySettings.js`、`cli/handlers/config.js` 三处一致 | B2 | low |
| Δ5-16 | khySettings 的 TOML 第五层是死代码，方案未登记 | `configTomlOverlay.js` 用 `export function`（ESM）却住在 CJS 包内且内部用 require；实测 require 抛 "require is not defined in ES module scope"，被 `khySettings.js:288-292` 的 catch 吞掉 → config.toml 只读覆盖层从不生效，而 khySettings 头注释 :15-26 承诺它为最高优先覆盖 | §2.3 要求两类配置「住不同文件、走不同加载路径、由不同守卫校验」 | §2.3 / B2 | medium |
| Δ5-17 | B0 新建守卫未评估与 6 个既有相邻守卫的判据重叠 | `check-data-logic-separation.js` 与 `check-env-defaults.js` 均不存在；但已有 `check-data-layout.js`（L-3 覆盖字面 .khy/.khyos 拼接）、`check-data-lifecycle.js`、`check-toplevel-side-effects.js`(RUNTIME-012)、`check-flag-registry.js`、`check-env-gateway-pin.js`、`check-model-list-truth.js`、`check-model-hardcoding.js` | 裁定 H：每个新建 scripts/ci/check-*.js 同批登记进 FEATURE-OWNERSHIP.json rollout.mechanisms[]（S1）并挂 check:* 别名 | B0 step 4 / 裁定 H | medium |
| Δ5-18 | require 时冻结数据家这一失效模式无判据覆盖 | 21 处顶层 const 直接调 `getDataHome()`/`getDataDir()`（如 `aiManagementServer.js:74`、`apiKeyPool.js:28`、`proxyServer.js:41`、`plugin-loader/index.js:154`、`cli/handlers/gateway.js:211`）+ 8 处 IIFE（configSyncService.js:84、khySettings.js:57、learningCurriculum.js:200、traceAuditService.js:138）。RUNTIME-012 只禁顶层调用会 require/spawn/connect 的函数，不拦常量初始化 | 方案未为此立判据（J-01..J-14 无对应项） | （无批次） | medium |
| Δ5-19 | replSession.js 13916 行是仓内最大文件之一，却不在方案任何批次与 J-12 列表里 | `cli/replSession.js` 13916 行，承载 B1 要搬出的 blockedPathPolicy（:8183-8212）与多处 homedir/cwd 兜底（:5947 等） | J-12 的巨石清单列 prompts.js 3251 / commandSchema.js 2381 / toolUseLoopCore 10605 / aiGatewayGenerateMethod 6864 / aiManagementServer 3781 / claudeAdapter 3504 | B1 / J-12 | medium |
| Δ5-20 | J-04 的 `os.homedir()` 判据无法区分 khy 自有状态与外部工具路径 | src 下 407 处 homedir；src/services 271 处；src/services/domain 90 处/33 文件。其中 `accountPool/candidateDetect.js` 一文件即 32 处，全部指向 Cursor/Warp/Kiro(AWS SSO)/Trae 等外部 IDE 存储，与 khy 数据家无关 | J-04「逻辑层不得 os.homedir() 拼用户家」，白名单只降不升且每条带理由与到期日 | J-04 / B9 | medium |

---

### 3.6 透镜补边（原五流域未覆盖，由双透镜 finding L2-1～L2-4 补入）

> 以下 4 条边是方案 §1.0 自点名的集中点，但五流域原追踪均无数据边承载。按透镜二建议补入本图，
> 每条带完整 `file:line` 证据；归属流域按数据性质指定，其余流域不再重复建边。

| 边号 | from（产地） | to（消费方） | 机制 | 证据 `file:line` | violates | 说明 |
|---|---|---|---|---|---|---|
| X-E1（归持久化与配置流） | `src/utils/flagRegistry/index.js` 的 per-flag off 词表（文件头 :5-13 自陈「~1500 个 KHY_* env 门控，其解析逻辑(_FALSY/_off 词表)被逐文件复制了近百遍，且方言不一致：71 个文件用 4 词 CANON、6 个用 6 词 EXTENDED、priorityTaxonomy 用 3 词 MINIMAL 且不归一」） | 163 处 `OFF_VALUES =` 定义（`src/cli` 76 处，其余 services/constants）+ 12 处 `delivery/channel/khyquant` | inline-literal | `grep -rn "OFF_VALUES *=" runtime/node/backend/src --include=*.js` → 163 处；全仓排除 node_modules/.git/.khy → 176 处（runtime/node 162、delivery/channel/khyquant 12、works/data 1）。方言 5 种：147 处 `['0','false','off','no']`、1 处 `['off','none','false','0']`、1 处 `['0','false','off','no','disable','disabled']`（6 词 EXTENDED）、1 处 `['0','false','off','no','legacy']`、1 处 `['0','false','off','no','']` | D1-no-literal | 方案 §1.0 #43 自评 high 的最严重数据复制项。迁移需按方言分桶（4 词 CANON / 6 词 EXTENDED / 3 词 MINIMAL 且不归一 / 'legacy' / ''）各立迁移项，并加方言一致性测试（同一 flag 在不同站点开关判定必须同解）。供应商与渠道流的 `KHY_FREE_MODEL_CHANNELS` 边（F2-E26）已顺带记录 `OFF_VALUES` 符号名 |
| X-E2（归持久化与配置流） | `<appHome>/search_engines.json` | `src/services/webSearchService.js:310-327` `_readEngineConfigText` 与 `src/services/webToolsService.js:23-40` `_readConfigText`（两份独立读取） | readFileSync | `webSearchService.js:317`（`const p = require('path').join(getAppHome(), 'search_engines.json')`）、:320（`if (fs.existsSync(p) && fs.statSync(p).isFile())`）、:318-319 注释明写 "a directory left over at this path (see webToolsService) must not make readFileSync throw EISDIR"；`webToolsService.js:30`、:37-39 同样的 existsSync+statSync().isFile() | D1-no-literal | 方案 §1.0 明列「search_engines.json 读取 2 份」。两份 existsSync+statSync().isFile() 防护中，webSearchService 的是从 webToolsService **复制来的**（连注释都带着出处）。收敛目标：单一 loader（与 §2.4.4 的 `loadSearchEngines` 命名装载器对齐），保留两处现有 fail-soft 语义（缺失/出错 → ''） |
| X-E3（delivery/khyquant，无既有流域归属） | `delivery/channel/khyquant/services/mlAgentService.js:795-822` `extractFeatures` 对象字面量（18 键） | `ml/train_18_features.py:22-30` `FEATURE_NAMES`（18 项）与 `ml/predict.py:45+` `DEFAULT_FEATURE_COLUMNS`（18 项） | inline-literal | `mlAgentService.js:795-822`（price/open/high/low/close/ma5/ma10/ma20/macd/rsi/kdj_k/kdj_d/kdj_j/volume/amount/pe_ratio/pb_ratio/roe）；`ml/train_18_features.py:22-30` 注释「18个特征（与 mlAgentService.js 的 extractFeatures 方法完全一致）」+ `FEATURE_NAMES` 同 18 项；`ml/predict.py:45+` `DEFAULT_FEATURE_COLUMNS` 同 18 项 | D1-no-literal | 方案 §1.0 明列「18 特征 schema 3 份」、:211 记 L2 high。三副本仅靠注释同步。锚定唯一真源建议 `ml/*.py` 的 `FEATURE_NAMES`（训练/预测两端都吃它），并加键集合与键序一致性测试。文案与界面流已把 khyquant frontend 的中文行数计入口径，但未进 services 与 ml/ 子树——本边补上该扫描盲区 |
| X-E4（agents/cli，无既有流域归属） | `src/agents/types.js:83` `AGENT_COLORS` | `src/cli/sessionColor.js:20` `AGENT_COLORS` | inline-literal | `agents/types.js:83` 与 `cli/sessionColor.js:20` 均为 `const AGENT_COLORS = ['blue', 'green', 'orange', 'purple', 'red', 'cyan', 'yellow', 'magenta'];`（全仓 grep 仅此两处定义） | D1-no-literal | 方案 §1.0 明列「AGENT_COLORS 2 处」。收敛建议：锚定 types.js 为真源、sessionColor.js 改为 require，加数组逐字节相等断言。持久化配置流的目标态提到新增 `constants/agentColors.js`，但五流域均未记录今天这两份副本 |

**对应差异点（补）**：

| # | 差异点 | 现状 | 目标态 | 批次 | 风险 |
|---|---|---|---|---|---|
| Δ5-21 | `OFF_VALUES` 词表被逐文件复制 176 处、5 种方言，无任何流域/批次覆盖（X-E1） | 见 X-E1 | 收敛到 `flagRegistry` 单一解析入口（或 §2.4.5 ConfigResolver 的 bool parse），方言分桶迁移 + 方言一致性测试 | B7 / §1.0 #43 | high |
| Δ5-22 | `search_engines.json` 双读，且 EISDIR 防护是复制的（X-E2） | 见 X-E2 | 单一 `loadSearchEngines` 命名装载器，保留两处 fail-soft 语义 | B8 | medium |
| Δ4-23 | 18 特征 schema 三副本仅靠注释同步（X-E3） | 见 X-E3 | 锚定 `ml/*.py` `FEATURE_NAMES` 为真源 + 键集合/键序一致性测试 | （无批次） | medium |
| Δ4-24 | `AGENT_COLORS` 两份逐字节相同副本（X-E4） | 见 X-E4 | 锚定 types.js + sessionColor.js 改 require + 逐字节相等断言；与方案 `constants/agentColors.js` 的关系需人裁定 | （无批次） | low |

---

## 4. 跨流汇合与冲突

> 本章是双透镜跨流 finding 的落点。§4.1 答「同一份数据被谁消费」，§4.2 答「谁在争真源」，
> §4.3 答「层归属谁说了算」，§4.4 逐条回应 14 条透镜 finding，§4.5 列出**本图不代为裁定**的高风险项。

### 4.1 同一份数据被多条流域消费的汇合点

| 数据 | 消费流域（边号） | 汇合性质 | 风险 |
|---|---|---|---|
| `constants/models.js`（型号名 SSOT） | 模型流 F1-E1/E2/E3 + 供应商流 F2-E23（`ZHIPU_DIRECT_MODELS`） | 2 流域；且 prompts.js 经 `MODEL_IDS` 形成第二暴露面（Δ3-19） | medium |
| `constants/modelContextWindows.js`（窗口真源） | 模型流 F1-E5/E10/E11/E12（单流域 4 个活消费面） | 运行期被三层覆写（gateway 缓存 → contextWindowStore 落盘 → 两份回填副本），「静态真源」只在冷启动第一笔生效 | high |
| 智谱 7 个免费模型 id | 模型流 F1-E32/E33 + 供应商流 F2-E6/E7 + 持久化流 F5-E22 | **3 流域重复追踪**（原 driftRisk 三流三个标签，已统一，见 §4.3） | medium |
| `providerPresets.js` | 供应商流 F2-E1/E2/E3 + 持久化流 F5-E21 | 2 流域（一份数据、两套指标口径） | medium |
| `cli/handlers/gateway.js` 供应商表 | 供应商流 F2-E9/E10/E11 + 持久化流 F5-E20 | 2 流域；B3 搬迁源 | medium |
| `constants/prompts.js` | 提示词流 F3（59 边主体）+ 文案流 F4-E5/E6/E29 + 持久化流 F5-E40 | **3 流域各报一套指标**（行数/env 计数/require 计数），汇总会数三遍 | high |
| `utils/dataHome.js` | 供应商流 F2-E15 + 持久化流 F5-E7/E8/E9 | 2 流域；方案称其为 B8 唯一正解，但它自己有 6 个并列解析器 | high |
| `freeModelChannels.js` | 模型流 F1-E33 + 供应商流 F2-E5/E6 + 持久化流 F5-E22 | 3 流域 | medium |
| `constants/serviceDefaults.js` | 供应商流 F2-E1 + 持久化流 F5-E14/E15/E35 | 2 流域（端点/env/端口三副面孔） | medium |
| `config/models/pricing.json` | 模型流 F1-E34 + 持久化流 F5-E23 | 2 流域，**且 violates 判定原本相反**（已统一，见 §4.3） | medium |
| `config/models/features.json` | 模型流 F1-E35 + 持久化流 F5-E25 | 2 流域，同上 | medium |
| `constants/promptLocales.js` | 提示词流 F3-E38 + 文案流 F4-E4/E29 | 2 流域（第二套 i18n） | medium |
| `cli/aliases.js` | 提示词流 T3-3 + 文案流 F4-E7 | 2 流域 | low |
| `cli/commands/registry.json` | 提示词流 Δ3-17 + 文案流 F4-E23/E24 | 2 流域（死数据） | medium |
| `<dataHome>/custom_providers.json` | 模型流 F1-E31 + 供应商流（只做存在性确认，未追内容） | 2 流域；供应商流侧未追（§5） | low |
| `MODEL_CAPABILITIES` / `EFFORT_PRESETS` | 模型流内 F1-E20/E21/E24/E25/E26 六条边 | 单流域内**引用身份三级透传**（ai.js → aiChatCore → aiTaskClassifier，同一 reference），注入形状即契约 | high |
| `OFF_VALUES` | 补边 X-E1（原 0 流域） | 补边前**完全无流域承载**——方案自评 high 项不在任何批次清单 | high |
| `search_engines.json` | 补边 X-E2（原 0 流域） | 同上（medium） | medium |
| 18 特征 schema | 补边 X-E3（原 0 流域） | 同上（medium） | medium |
| `AGENT_COLORS` | 补边 X-E4（原 0 流域） | 同上（low） | low |

### 4.2 争抢真源的点（contested 登记）

| 数据 | 争持方 | 今日状态 | 裁定状态 |
|---|---|---|---|
| 上下文窗口值 | `constants/modelContextWindows.js`（静态）vs `contextWindowStore.js` + `<getDataDir('gateway')>/context_window.json`（运行期学到） | 运行期压过静态；文件头明写「学到的值无论大小都压过静态表」 | 方案 §2.4.8 用「`resolveWindow(id)` deliberately absent」回避，未裁定运行期覆盖的存废 |
| 提示词正文 | `constants/prompts.js` vs `cli/aiChatCore.js`（约 24 个 `_xxxDirective`） | 两条链都活；aiChatCore 的追加在 makeSystemPrompt 产物之后 | **方案未裁定**（B4 清单未覆盖 aiChatCore 链，Δ3-4） |
| 指令真源 | `directiveComposer.js`（类别/次序/协调头）vs `aiChatCore.js`（正文） | 真源被劈成两半，各自自述单一 | 方案未裁定 |
| khy 的文案层 | `src/i18n/locales/*.json`（零消费）vs `constants/promptLocales.js`（唯一真翻译路径） | 两者互不知晓 | 裁定 L/B10 要扩前者，后者搬 `src/data/i18n/`；搬迁后谁是运行时文案层未明说 |
| 桌面端/手机页文案 | `renderer/i18n/zh-CN.json`（在用，5069 leaf）vs `zcode-analysis/i18n-zh.json`（5070 leaf，被 mobilePage.js:6 注释引用） | 差 1 key（`workspaceSidebar.showFileTree`） | **方案未裁定**（Δ4-13） |
| 智谱免费模型 | `zhipuFreeModels.js`（注释裁定权威）vs `freeModelChannels.js`（发现层出口） | 两份逐字节相同、无机械同步 | 注释级裁定；B6 合并时保留门控与 augment 逻辑在 JS 侧 |
| 供应商预设 | 后端 `providerPresets.js` vs 前端 `AIGateway.vue:relayProfilePresets` | 已实测漂移：anthropic defaultModel（`claude-sonnet-4-20250514` vs `claude-sonnet-4-6`） | 方案未裁定（两份都在争真源） |
| provider→env key | 五份平行表（`gateway.js`×2、`apiKeyPool`、`builtinProviderConfig`、`gatewayGuide`），键空间互不相同 | `ENV_KEY_MAP` 只管 13 个；gatewayGuide 教的 `GEMINI_API_KEY`/`MOONSHOT_API_KEY` 对池无效 | 方案 B3/B6 只认定 gateway.js 那份（Δ2-7） |
| 数据家/路径 | `utils/dataHome.js`（6 解析器）vs `shared/config/database.js`（SQLite 路径）vs `khySettings.js`（`~/.khy/settings.json`）vs `DATA-LOCATIONS.json`（登记表） | 四套；本机同时存在 ~/.khy、~/.khyquant、`<repo>/works/data/khy`、`<repo>/.khy`、`.khyos` 五个候选根 | 方案指定 dataHome 为唯一正解，但 SQLite 链与 settings 链未纳入（Δ5-5/Δ5-6） |
| env 真源 | `serviceDefaults.js`（131 处）vs `flagRegistry`（275 消费方）vs `shared/config/env.js`（11 项默认值） | 三套并行 | §2.3 只把 serviceDefaults 定为环境配置载体，另两套未处置 |
| endpoint 展示 | `gateway.js` 两个 collector vs `apiKeyPool` `ENV_KEY_MAP` | collector 不读 ENV_KEY_MAP(13) → 少报 agnes/stepfun | 方案未裁定（Δ2-9） |
| R2 拦截清单 | `replSession.js:8183-8212` vs `atMentionInject.js:31-50` | 已漂移（token.txt 一侧拦一侧放行） | §2.4.8 blockedPathPolicy 统一（B1） |
| sqliteCompat | backend 副本 vs shared 副本（243 行×2，行为已分叉） | 两份 | 方案未提及 |
| 模型价格/路由档 | `modelPricing.js` vs `routingMode.js`（同范式两份） | 两份平行实现 | §2.4.4 命名装载器各自声明合并/失败策略 |
| adapter 能力刻度 | `capabilityRegistry.js`（11 维）vs `MODEL_CAPABILITIES`（3 维）vs `modelCapability.classifyCapability`（四桶） | 三套互不引用 | **方案完全未覆盖**（§4.5-e） |

### 4.3 层归属判断不一致的点（本图统一裁定）

| 对象 | 流域 A 判定 | 流域 B 判定 | 本图统一裁定（依据 L2-5/L2-6/L2-7） |
|---|---|---|---|
| `modelPricing._loadTable` | 模型流 F1-E34 原判 `violates:none`（锚点 :26-29,94） | 持久化流 F5-E23 判 `D1-no-literal`（锚点 :209-245） | **统一 `D1-no-literal`，锚点改函数体 :209-245**（env 内联 + appHome + homedir 兜底 + 仓内四层整体是逻辑层自管 IO） |
| `modelFeatureRegistry` homedir 兜底 | 模型流 F1-E36 判 `D1-no-literal`（:124-129） | 持久化流 F5-E25 原判 `none` 且不提兜底 | **统一 `D1-no-literal`**，F5-E25 补记 :124-129 catch 兜底 |
| prompts.js env 计数 | 提示词流「37 处 / 8 flagRegistry / 29 裸直读」 | 文案流「38 处」；持久化流「14 处直读」 | **统一为 37 行 = 14 直读（10 处带 `\|\| 默认值`）+ 10 isFlagEnabled + 13 对象透传**；「29 处裸 `X \|\| 默认值`」分解不成立，撤回 |
| `zhipuFreeModels.js` driftRisk | 模型流 `single-source` | 供应商流 `contested`；持久化流 `duplicate` | **统一 `contested`，主归属供应商与渠道流**（T2-2）；模型流/持久化流只作交叉引用 |
| `constants/` 的层归属 | §2.1 称「纯叶」（D6 语境） | 裁定 G「src/constants 留 D3」 | 「数据层」概念在本仓分裂：**默认值在 D3、内容在 D6**；本图 `D6-purity` 一律指「按 §2.1 字面目录归属判 D6」 |
| `src/config/*.js` | 裁定 I 划抽象层(D3) | DOMAIN-DEPS.json 未登记 src/config（守卫不可执行） | 归属按裁定 I，**守卫可执行性列为 B0 step 6 待办**（Δ5-2） |
| `src/data/cliAnythingTemplates/**` | 物理上在 D6 目录 | 实际是 D1 代码（require IO + 反向 require src/cli） | 裁定 G 显式排除出 D6 roots；本图该边标 `D6-purity` |
| `cli/themeRegistry.js` | 数据（themes/*.json）是 D6 形状 | 读取+实例化发生在 D1 逻辑层模块作用域 | 双违：`assembly-only-instantiation` + 逻辑层裸 fs；ThemeRepository 归抽象层 |
| `src/i18n/index.js` | §2.1 字面归属 D6（locales 同级） | 裁定 G 明裁移出 D6 归抽象层 | 装载器不是内容；由 `src/dataAccess/i18n.js` 包装 |
| `accountPool.js` SQL | — | — | `D1-no-literal`（SQL/DDL 串），B8 抽 `sql.js` 纯字符串模块 |

### 4.4 双透镜 finding 逐条回应表

> 纪律：blocking/high finding 不许静默丢弃。以下 14 条全部回应；处置分「采纳改图」「采纳补边」「采纳为待裁定项」三类，无「不采纳」——本轮复核未发现需驳回的 finding。

| # | 透镜 | 严重度 | finding 摘要 | 处置 | 落点 |
|---|---|---|---|---|---|
| L1-1 | 一边真实性 | medium | stickers 两处不是逐字重复：7 条 vs 8 条（replSession 多 `'(ノಠ益ಠ)ノ彡┻━┻'`），行域应为 :1339-1347 / :6480-6489，console.log 形状亦不同 | **采纳改图**：两条边 note 与 T4-6 改写为「7/8 子集重叠、已漂移」；B10 合并前须裁定保留 7 还是 8，否则一侧用户可见输出被静默删除 | F4-E17/E18、T4-6、Δ4-8、§4.5-d |
| L1-2 | 一边真实性 | medium | `commandOverlapAudit` 两个函数不是死代码：`tests/services/commandOverlapAudit.test.js` 有 11 个活跃测试；根因是 grep 只覆盖 src/ | **采纳改图**：撤回「死代码」与「方案把死代码计入分母」两个结论；所有「零消费者」结论显式标注 src/ only 口径 | Δ3-2、F3-E52、§1.6 |
| L1-3 | 一边真实性 | medium | `resolveModelContextWindow` 调用点清单漏了活的 `aiRequestAnalysis.js:113`，又计入死代码点 `services/models/index.js:36`（且那调的是 `pin`）；ccContextWindows 行号应为 :28-30/:29 | **采纳改图**：清单改为「活调用点 4 个 + 死代码点 1 个」 | F1-E12、F1-E11 |
| L1-4 | 一边真实性 | low | 两条边 mechanism 错判：异步 fire-and-forget 标成 `process-spawn`；被调方内部 readFileSync 标成边机制 | **采纳改图**：均改判 `function-call` 并在 note 说明真实机制；enum 不新增 `async-fire-and-forget`（全流域仅 1 例，单独分类的混淆成本高于收益） | F1-E14、F1-E17、§1.3 |
| L1-5 | 一边真实性 | low | 5 处行号漂移 1-8 行（modelEscalationPolicy :320-325、claudeAdapter listModels :907、aiManagementServer :1534/:3164、aiTaskClassifier cap.context :165/:167、gateway.js envMap 10 项 :1873-1882） | **采纳改图**：逐条更正；本图定稿前已对全部边号做一次抽核（原报告约 50 个行号断言精确命中，漂移是个别手抄） | F1-E2/E9/E22/E26、F2-E11 |
| L1-6 | 一边真实性 | low | 计数夸大：child_process「9 处」实为 3 require/6 派生；statSync「约 12 处」实为 6；另 MODEL_CAPABILITIES 29 条、DATA_PATHS 65 条(:45-128)、KHY_CONTEXT_* 7 处、dataHome 25 导出/590 调用点、BLOCKED_NAMES 实际还拦 .env.local 等、constants/models 消费方 25 | **采纳改图**：全部更正；违规本身全部真实，仅计数需更正 | F1-E3/E20/E39、F3-E17/E26、F5-E8/E18 |
| L2-1 | 二完备性 | high | `OFF_VALUES`（方案 §1.0 #43 自评 high 的最严重数据复制，176 处定义/5 种方言）在五流域零边 | **采纳补边**：X-E1 + Δ5-21，归持久化与配置流；要求方言分桶迁移 + 方言一致性测试 | §3.6、§4.1、§4.5-c |
| L2-2 | 二完备性 | medium | `search_engines.json` 双读（含复制的 EISDIR 防护）缺失 | **采纳补边**：X-E2 + Δ5-22，归持久化与配置流 | §3.6 |
| L2-3 | 二完备性 | medium | 18 特征 schema 3 份（mlAgentService ↔ train_18_features.py ↔ predict.py）无流域承载 | **采纳补边**：X-E3 + Δ4-23；建议锚定 `ml/*.py` `FEATURE_NAMES` | §3.6 |
| L2-4 | 二完备性 | low | `AGENT_COLORS` 2 处无流域边 | **采纳补边**：X-E4 + Δ4-24 | §3.6 |
| L2-5 | 二完备性 | medium | prompts.js env 口径三流三个数；「29 处裸 `X \|\| 默认值`」分解不成立（实测 14 直读、23 处对象透传），B4c 批量口径虚高约 2.6 倍 | **采纳改图**：三流统一口径；B4c 只对 10 处 `X \|\| 默认值` 站点排队，对象透传站点明确判为「不在 ConfigResolver 适用范围」 | F3-E56、F4-E6、F5-E40、§4.3、§4.5-b |
| L2-6 | 二完备性 | medium | 同一条装载器边两流相反违反判定（modelPricing none vs D1-no-literal；modelFeatureRegistry 同型） | **采纳改图**：统一标签与行锚 | F1-E34/E36、F5-E23/E25、§4.3 |
| L2-7 | 二完备性 | medium | 智谱 7 模型被三流重复追踪，driftRisk 三流三个标签 | **采纳改图**：指定主归属（供应商与渠道流），其余流交叉引用；driftRisk 统一 contested | F1-E32/E33、F2-E6、F5-E22、T1-10/T2-2、§4.1/§4.3 |
| L2-8 | 二完备性 | high | `services/models/index.js` 死代码与方案两处硬绑定构成三方冲突：seed 仍走 `registerModel`（住逻辑层）vs dataAccess「不得 require 逻辑层」；J-09 以 `khy models list` 作观测点，但该命令由 `ollamaModelManager` 供数（router.js:2529/2570），与 catalog.json 无关 → 观测点不可判定 | **采纳为待裁定项**（本图不代为裁定）：B6 开工前须人二选一——(a) 保留 registerModel 为 seed 路径则先接入活路径或以 §3.4 provider 注入形态交付，并把 J-09 观测点换成真正消费 catalog 的活路径（claudeAdapter.listModels / gateway 目录面）；(b) 裁定该模块退役，则删除「seed 仍走 registerModel」与 4 条覆写断言测试，改为对 `pinModelContextWindow` 直接断言 | Δ1-1/Δ1-2、§4.5-a |

### 4.5 本图不代为裁定的高风险项（须人点头）

| # | 待裁定项 | 为什么不能由图裁定 | 选项 |
|---|---|---|---|
| a | `registerModel` seed 路径 vs D3 不得 require 逻辑层；J-09 观测点不可判定（L2-8） | 涉及「模块退役」与「方案条文修改」，均超出测绘职权 | (a) 接入活路径/provider 注入 + 换观测点；(b) 退役模块 + 改断言对象 |
| b | B4c「37 处 process.env 改经 ConfigResolver」口径虚高约 2.6 倍 | 「哪些站点算 env 默认值」是方案条文解释权 | 只对 10 处 `X \|\| 默认值` 排队；对象透传站点移出范围 |
| c | `OFF_VALUES` 5 种方言的收敛目标 | 「统一到哪一套词表」改变既有开关语义（如 `''`/`'legacy'` 站点） | 逐方言立迁移项 + 一致性测试；或显式登记为「允许方言」 |
| d | stickers 合并保留 7 条还是 8 条 | 任一侧被删都是用户可见输出变化，违反方案字节等价要求 | B10 前裁定；或两份都保留并注明出处 |
| e | `capabilityRegistry.js` 第三套能力刻度无人认领 | 方案 §1.1/§1.3 未覆盖该文件，无目标态可对照 | 补入方案（第四套 catalog？）或显式裁定「不收敛」 |
| f | 两份 345KB i18n 资产（renderer 在用 vs zcode-analysis 被注释引用）谁是真源 | 涉及桌面端构建链路，超出五流域范围 | 明确真源 + 机械同步机制；或修正 mobilePage.js:6 注释 |
| g | 三个前端（ai-frontend / khyquant frontend / Flutter）约 1.3 万行中文无 i18n 载体、无批次 | 方案 §4 未给前端批次 | 补批次或显式划出范围 |
| h | 中文行数口径（任务书锚点 cli 4630 vs 实测 30617，差 6.6 倍） | 锚点用的脚本/模式未能复现 | 以实测为准并固定可复现口径；或指出锚点脚本 |

---

## 5. 今日追不动的链

> 纪律：未核实的就是未核实。本章分两半：§5.1 是**被透镜驳回了结论的边**（原报告称 X、实测 Y，
> 本图已按实测改图）；§5.2 是**51 条未核实项**，按流域如实列出「哪里没查清、为什么」。
> 本章不包含任何为完整性而编造的边。

### 5.1 被透镜驳回或校正的结论（原报告称 → 本图改为）

| 原报告结论 | 实测（透镜一/二） | 本图处置 |
|---|---|---|
| stickers 两份「逐字重复副本，同数组、同随机取法、同 console.log 形状」 | 7 条 vs 8 条子集重叠已漂移；console.log 一用模板串一用字符串相加 | 改判「子集重叠、已漂移」；合并前须裁定 7/8（§4.5-d） |
| `commandOverlapAudit.js:88/:159` 是死代码，零外部调用者 | `tests/services/commandOverlapAudit.test.js` 11 个活跃测试；根因是 grep 只覆盖 src/ | 撤回死代码结论；「零消费者」类结论全部标注 src/ only |
| `resolveModelContextWindow` 全部 4 个静态调用点 = models:36、claudeAdapter:553、ai.js:180、ccContextWindows:31 | 活调用点 4 个（ai.js:180、**aiRequestAnalysis.js:113**、ccContextWindows:29、claudeAdapter:553）+ 死代码点 1 个（models:36 调的是 `pin`） | 清单重写；ccContextWindows 行号 :30-32→:28-30 |
| `_warmupContextWindowCache → _refreshModelsBackground` 机制 = process-spawn | `Promise.resolve().then(...)` 异步 fire-and-forget，全链路无 child_process | 改判 function-call |
| `aiGatewayRoutingMethods.js:1983 → contextWindowStore` 机制 = readFileSync | :1983 是 `require('./contextWindowStore').recordLearnedContextWindow(...)`，readFileSync 在被调方内部 | 改判 function-call |
| modelEscalationPolicy 候选在 :317-322；listModels 起于 :908；getEffortPresets 在 :1542；cap.context 在 :165/:180；envMap 9 项 | :320-325；:907；:1534（另 :3164）；:165/:167（recommendations :187）；10 项 :1873-1882 | 逐条更正 |
| prompts.js「9 处 child_process 进程派生」「约 12 处 statSync」 | 3 处 require + 6 次派生；6 处 statSync（+2 readFileSync = 8 处 fs IO） | 计数更正（违规本身真实） |
| MODEL_CAPABILITIES「30+ 型号」；DATA_PATHS「50 条（:75-128）」；dataHome「18 个导出/375 处/238 文件」；KHY_CONTEXT_*「8 处」；constants/models「24 个消费方」 | 29 条；65 条（:45-128）；25 个导出 / 590 处 / 322 文件；7 处；25 处 require | 计数更正 |
| replSession BLOCKED_NAMES 拦截面以 token.txt 为例 | startsWith/endsWith 语义实际还会拦 .env.local、credentials.json、id_rsa.pub | 拦截面描述加宽 |
| （透镜二汇总观察）constants/models 消费方数 | 实测 25 处 require，流域记 24 | 已更正 |

### 5.2 各流域未核实清单（51 项）

**流域一·模型数据流（11 项未追通）**
1. `services/models/index.js` 的「死代码」结论基于静态 grep：全仓 grep `"services/models"` 0 命中、`src/services` 内 `require('./models')` 0 命中、无 `khy.module.json`、无动态字符串 `require('.../services/'+x)` 形态。**未运行应用，未排查 CJS 之外的非标准加载**（fs 读文件后 eval、vm、桌面端/electron 的独立拷贝）。
2. 4 条 seed 窗口被覆写（claude-sonnet-4-5-20250929 / claude-opus-4-0-20250514 / gemini-2.0-flash / gemini-1.5-pro）由两张表逐条比对得出，**未实际执行 node 跑 registerModel 验证**。
3. `aiManagementServer` 的 `getAi()` 具体解析到 `cli/ai.js` 的接线点未追（只确认了 `getEffortPresets`/`getEffort` 的存在与 :1534/:1977 的调用）。
4. `aiGatewayRoutingMethods` 的 `setAiGatewayRoutingMethodsDeps` 调用点（即 `_freeCatalogGetter` 由谁注入）未定位；只读到 setter 在 :249-250。
5. 未追 `aiGateway.autoSelectModel` 的完整候选枚举路径（taskType → adapter → 默认模型），只读了 `autoModelSelect.js` 的叶子契约与注释中自陈的诚实边界。
6. `providerPresets.js` / `apiProviderCatalog` 的数据形态与密钥边界只做了存在性确认（`stripSecrets` 全仓 0 命中），**未读表内容，未验证「零密钥」现状**（R2 要求只描述形态，未读取任何 key 值）。
7. `MODEL_CAPABILITIES` 的 `Object.freeze` 缺失结论基于 cli/ai.js / aiChatCore.js / aiTaskClassifier.js / aiRequestAnalysis.js 内 grep `"freeze"`（仅 `aiRequestAnalysis.js:285` `DEFAULT_MULTIMODAL_ADAPTER_CAPS` 命中）；未排查是否存在集中 deepFreeze 工具在别处统一冻结。
8. `aiRequestAnalysis.js:103-112` 的 `MODEL_CAPABILITIES` 子串匹配是否会产生实际误命中，只做了定性推理（插入序 + includes），**未构造语料跑测试**。
9. `capabilityRegistry.js` 的 `DEFAULT_ADAPTER_CAPABILITIES` 的消费方未追（只读了文件头与表结构），因此「第三套能力刻度无人引用」与「有引用」两种可能都未排除（§4.5-e）。
10. `config/models/features.json` 与 `modelFeatureRegistry` 的既有消费方清单未列全（它是方案的挂靠样板，但不在本域 6 个文件焦点内）。
11. 三守卫（check-repo-layout / check-change-safety / check-agent-rules）在本流域未实跑（只读约束 + 本任务为只读追踪），故 B0 前置「3 条既有 error 是否仍存在」在本域未能核实（其他流域有实跑记录，见 §3.3/§3.4）。

**流域二·供应商与渠道数据流（10 项未追通）**
1. 全仓 grep `providerPresets`/`getProviderPresets` 时 `grep -rn` 超时（120s 被转后台），backend/src 与 delivery/web 之外（`works/ship/npm/bundled/runtime/khy/bundle.mjs`、`delivery/web/provider-hub/src/main/toolWriters.ts`、`delivery/extension/scripts/khy-diagnostics/model-type-providers.js`）只做了限定路径的文件名命中，**未读内容，未核实这些打包产物/旁路副本与源是否一致**。
2. `ai-backend/src/routes/userGateway.js:205-211` 只读到路由定义与 `res.json(getProviderPresets())`，未追完整响应链：MyGateway.vue 如何消费、是否有第二处前端（provider-hub）直连同一端点。
3. `tools/ConfigureModelProvider/index.js` 只读了 :176-238（executeList）与 :465-487（内置 add 成功 note）两段，`executeAdd` 的完整分支与 `freeChannels` 字段的最终序列化形态未完整追。
4. `cli/handlers/gateway.js` 共 3266 行，只读了 :1380-1560、:1563-1790、:1860-1912、:2715-2740 四段；`_resolveApiProviderLabel` 的其余调用点与 `API_PROVIDER_DISPLAY_NAMES` 的全部 4 处引用（:1392/:1593/:1697）只定位到行号，未逐处读上下文。
5. `kiroAdapter.js` 共 2659 行，只读了 :240-300（REGION_ENDPOINTS/REGION_ENDPOINTS_CN/KIRO_BASELINE_MODELS）与 :108-180（路径解析）；`REGION_ENDPOINTS` 的 :1287-1291 调用点上下文、`SOCIAL_REFRESH_URL`(:95) 的消费点未读。
6. `KHY_PROVIDER_PRESETS` / `KHY_FREE_MODEL_CHANNELS` 是否在 .env 模板、`install-khy.ps1`、docs 中被文档化并给出与代码一致的口径未核实。
7. `externalApps/_shared.js:161-175` `resolveApiKey` 的 12 个 `*Adapter` 写者（claudeCodeAdapter/opencodeAdapter/...）未逐个核实落盘位置与文件权限，只确认了口径「key 由 NL 显式给或回退池内首个 key」。
8. `apiKeyPool.maskKey` / `externalApps/_shared.maskKey` 与 `maskToken`/`maskSecret` 的「哪种口径在哪条用户可见输出上实际生效」未做全量映射，只确认了四个函数体与 `maskSecret.js` 注释里的「刻意不收敛」声明。
9. `src/data/gateway/` 与 `config/gateway/` 在仓库中不存在已由 ls 确认；但「是否已在其他分支/未提交工作区建有骨架」未核实（本任务只读，未查 git 其他分支）。
10. `src/data/publicApis.json` 与 `src/data/bugCases.js` 已存在（`localBrainService._getPublicApis` 消费），但二者与本域三份数据的装载范式差异只做了纸面对照，未实跑比对。

**流域三·提示词与命令面数据流（10 项未追通）**
1. prompts.js 37 处跨层反向 require 的逐条「可去/去不了」判定：只对守卫已点名的 29 处与裁定 O 附带着重点名的 8 处完成了定位与分类，**未逐条读函数体**判断哪些是「可纯化的字符串拼接骨架」、哪些携带真实业务逻辑。裁定 C 只对 :18（selfProfile）一条下了「去不掉」的结论，其余 36 处方案未给结论——需 B4 开工时逐条判，本图不替方案预判。
2. d3-purity 总数 36 中余下 5 条的归属未能定位：`check-repo-layout.js --list` 输出被脚本自身截断（只打印前若干条 + 首例），看到的 prompts.js 29 条 + commandSchema.js 2 条 = 31 条，另外 5 条在哪个文件没能读出。需跑不带 --list 的完整输出。
3. prompts.js 的 46 个 `getXxxSection` 中具体哪 40+ 个的「函数体可字节保留、只换字面量为 `promptStore.getSection(id)`」未能逐个验证。方案 B4a 自带安全阀（「若无法构造覆盖全部 section 组合的 golden 矩阵，B4a 降级为只抽 engine」），无法判断这个阀会不会触发。
4. 方案 §2.4.8 `promptStore.registerSection(id, fn)` 的注册时机与默认 section 集的初始化者未在所读章节中定义；不清楚 `src/bootstrap/prefetch.js` 是否就是「避免 .md 读取落进 TUI <100ms 预算」的那个预热点（方案 §2.1 只注释说明用途，未给代码）。
5. 「未注册时 self-awareness 段是否为 null」在方案中无答案：§3.4 只规定 `registerSelfAwarenessProvider()` 在 init 第一顺位执行并称「bin/khy.js cold-start path is covered by an 'already registered' assertion test」，但未规定 resolve 不到 provider 时的回退值（null / 空串 / 静态兜底）。今天是「永不 null」，目标态这一条的字节等价性无法从方案文本推出。
6. `cli/aiChatCore.js` 约 24 个 `_xxxDirective` 的正文本数未逐个人工清点（数到 24 个不同的标识符与 162 处 Directive/DirectiveText 相关行）；其中哪些受 `KHY_*` 门控、哪些是无条件注入，未逐个核实。
7. `src/cli/commands/registry.json` 的「零 require」只核了 src/ 子树，未按裁定 N 要求全仓 grep（含 works/ 与 delivery/）。
8. `promptAssemblyService` 链是否在 delivery/、`runtime/node/ai-backend/` 或 tests/ 下有消费者未核（grep 的是 `runtime/node/backend/src/` 与 `runtime/node/backend/`，对 delivery/ 与 ai-backend 只做了 constants/prompts 的定向搜索）。
9. `constants/commandSchema.js` 的 6 张表中 `BUILTIN_SLASH_COMMANDS`（:981-2136）按行号差估为约 1155 行，未逐行确认表体起止；方案 B4d 的「约 2100 行数据表」口径未对齐到具体行号区间。
10. git 工作树当前有大量未提交修改（CLAUDE.md、`runtime/node/backend/src/**` 等多个文件 M 状态）。测得的 3251 行、29 条 d3-purity、195/263/2470 计数都是**这个工作树**的读数，与方案撰写时的提交可能不同；B4 开工前应在干净树上重测。

**流域四·文案与界面数据流（10 项未追通）**
1. 中文行数量级未复现。任务书锚点写「cli/ 含中文行 4630、utils/ 873、tools/ 405」，实测（`rg --type js -c '\p{Han}'`，按文件匹配行数求和）为 cli 30617、utils 4620、tools 3112、services 68455、constants 1510，差约 6.6 倍。试过的口径都无法复现锚点：含 cli/tui 与不含 cli/tui 分别是 30617 与 21625；也没找到只数顶层 cli/*.js 能得到 4630 的切法。
2. `src/i18n` 是否绝对零消费，只覆盖了 backend。grep 的是 `runtime/node/backend` 全仓（--glob '!node_modules'）的 `'\.i18n\b'`，只命中 `src/index.js:24` 自身。未 grep 形如 `require('.../src/index')` 后取 .i18n 的间接消费者，也未跑测试套件——若某测试断言 `exports.i18n` 的形状，那里就是隐藏消费者。仓库其他域（scripts/、works/ship/、delivery/）也没查。
3. `src/tools/` 的 description 内联规模只做了抽样。src/tools/ 下 229 个目录，只确认了至少 10 个 `<ToolName>/index.js` 含 `'description:'`，没有统计总量，也没有核对方案 §1.4 说的 tools/ 229 目录与 405 行中文之间的关系。
4. `webRemoteControl/protocol.js:9,50` 声称「错误码与 i18n webRemoteControl.failure.* 一一对应」，未逐条比对 protocol.js 的枚举集合与 zh-CN.json 的 failure.* 键集合是否等长。若不等长，这条注释就是漂移承诺而不是契约。
5. `cli/handlers/config.js` 的 `SUPPORTED_CONFIG_KEYS` / `KEY_ALIASES` / `PROVIDER_TO_ADAPTER` 与 `src/config/settingsWhitelist.js`、`cli/repl/khySettings.js` 三处是否今天已经不一致，未实测差集。方案 B2 要建 `check-config-schema-sync.js` 正是因为怀疑不一致，但「怀疑」不等于「已证实」。
6. domain-direction 195 处的构成只拿到汇总数（d3-purity 36 / d2-no-reach-into-d1 156 / no-reach-into-archive 3）。未逐条拆分：constants/ 占 d3-purity 的多少、prompts.js 的 29 条 D3→D1 是否全部落在那 36 处内、裁定 C 只登记 1 条 allowlist 是否已经够。
7. `src/i18n/locales` 的 ja/fr/de 三个语言只验证了 leaf 数相等（各 131）与 zh/en 双向集合相等，**没有比对内容**——ja/fr/de 可能是真翻译，也可能是 en 的副本。若是副本，「5 语言」是名义而非事实，会影响裁定 L「各语言翻译补齐后才放开 locale 锁」的可达性判断。
8. `apps/khyos-desktop/src/renderer` 下是否还有第二处旁路 import zh-CN.json（例如组件里直接 import 绕过 i18next），未全量 grep。
9. `mobilePage.js:6` 指向的 zcode-analysis/i18n-zh.json 的 `webRemoteControl.*` 键，与 `mobilePage.js:11` COPY 的 31 条文案是否真的逐字一致，未比对。注释说「凡原案缺『目标+进度』的在本页补齐」，即声称存在有意偏差——偏差清单未列。
10. `cli/tui/ink-components/App.js`（7788 行、1348 行含中文）只确认了它是 arch-debt-baseline.json 登记的 R2-god-file，没有统计其中文文案有多少是用户可见字符串、多少是注释/代码标识符。方案的「中文字面量计数项」需要一个可复现的口径，而这个口径今天不存在。

**流域五·持久化与配置数据流（10 项未追通）**
1. 裁定 A 的前提（`src/repos`、`src/services/di/`、`src/utils/dataCard/`、`src/data/prompts/`、`src/cli/data/`、`src/tools/data`、`src/contracts/models` 今天均不存在）只核实了 src/dataAccess 不存在、src/data 存在但仅含 bugCases.js / cliAnythingRegistry / cliAnythingTemplates / curriculum.json / publicApis.json；其余目录未逐一 ls。
2. 未执行 `check-data-layout.js`（自述全量扫描 ~30s）、`check-rollout-stage.js`、`check-wiring.js`，故 `FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms` 32 条与 `wiring-exemptions.json` 的现状未核实；B0 step 5 的登记工作量无法量化。
3. 未读 `src/services/domain/account/accountPool/README.md`，B8 verify 引用的「accountPool 子域 README 记载的显式路径 102 例」未核实。
4. `aiManagementServer.js` 13 组默认值的精确行域未逐行对齐：实测 `WEBHOOK_MAX_RETRIES` 起于 :21，`DEFAULT_PLUGIN_TEMPLATE` 结束于 :108（方案写 :85），`KHY_DIR` 在 :74。
5. B3 的 `src/seeds/rebarStrategy.js` 与 B2 的 `cli/handlers/config.js:22-70` configSchema 数据未读。
6. R2 密钥注入真源 `runtime/node/backend/src/services/customProviderRegistrar.js` 与 providerPresets/apiProviderCatalog/built_in_keys 只做了形态描述（未读实现体、未触碰任何 key 值），`stripSecrets` 的缺失结论基于全 src grep 0 命中。
7. J-04 的口径差异未逐文件对齐：方案写 `src/services/domain` 105 处/39 文件、src 全量 417；实测 `src/services/domain` 90 处/33 文件、src 全量 407。差异可能来自方案统计包含 `*.test.js` 或使用不同 glob，未能定位。
8. `DATA-LOCATIONS.json` 声明的 `roots.state.accessor` = `getStateHome()` 在 `src/utils/dataHome.js` 与全 src grep 均无命中（登记表自标「尚未启用」），但是否有第二处实现未全仓确认。
9. 方案 §1.3 #23 说 `publicApis.json` 的消费方 `localBrainService.js:1205-1218`「同类数据 curriculum.json 却有 mtime 热重载的好实现，同一 data/ 目录两种访问范式」未逐行复核。
10. 后台曾跑一次全仓 grep `built_in_keys`，输出文件未读（不影响本图任何结论）。

---

## 6. 与批次计划的对应

### 6.1 差异点 → 批次映射总表（102 条差异点的落点）

| 批次 | 差异点数 | 代表项（差异点号） |
|---|---|---|
| **B0**（前置与骨架） | 13 | Δ2-1、Δ5-1、Δ5-7（三条 blocking：dataAccess 骨架 / SQLite 链 / 影子目录根因）、Δ3-14~Δ3-16、Δ4-14、Δ4-18、Δ4-21、Δ5-2、Δ5-13、Δ5-17、Δ1-7 |
| **B1**（模型常量与首批仓储） | 8 | Δ1-5、Δ1-6、Δ1-7、Δ1-10、Δ1-15、Δ2-18、Δ5-8、Δ5-19 |
| **B2**（CLI 数据外置） | 2 | Δ5-15、Δ5-16 |
| **B3**（供应商与策略目录） | 4 | Δ1-12、Δ2-3、Δ2-9、Δ5-9 |
| **B4**（提示词拆解，含 a/b/c/d） | 9 | Δ3-4、Δ3-8（两条 blocking）、Δ3-1、Δ3-2、Δ3-5、Δ3-7、Δ3-20、Δ4-5、Δ4-6 |
| **B5**（端点 SSOT） | 1 | Δ5-11（另 Δ2-5 归裁定 E） |
| **B6**（目录数据外置） | 14 | Δ1-1（blocking）、Δ2-2（blocking）、Δ1-2~Δ1-4、Δ1-8、Δ2-4、Δ2-6、Δ2-7、Δ2-10、Δ2-19、Δ4-16、Δ1-12 |
| **B7**（配置外置） | 4 | Δ5-3、Δ5-10、Δ5-21（OFF_VALUES 补边）、Δ1-15 |
| **B8**（持久化与 accountPool） | 5 | Δ2-16、Δ3-9、Δ5-12、Δ5-14、Δ5-22（search_engines 补边） |
| **B9**（路径收敛） | 4 | Δ5-4、Δ5-5（blocking）、Δ5-6、Δ5-20 |
| **B10**（文案与界面） | 10 | Δ4-1、Δ4-3（两条 blocking）、Δ4-7~Δ4-12、Δ4-17~Δ4-19 |
| **裁定 A–O**（非批次条目） | 22 | Δ1-9、Δ1-11、Δ2-5、Δ2-14、Δ2-17、Δ3-3（blocking）、Δ3-6、Δ3-10、Δ3-11、Δ3-12、Δ3-13、Δ3-17、Δ3-18、Δ4-2、Δ4-4、Δ4-15、Δ4-21、Δ4-22、Δ5-2、Δ5-13、Δ5-17 |
| **无批次归属（方案盲区）** | 14 | Δ1-14、Δ1-16、Δ2-8（high）、Δ2-11、Δ2-12、Δ2-13、Δ2-15、Δ2-20、Δ3-19、Δ4-13（high）、Δ4-20、Δ5-18、Δ4-23、Δ4-24 |

> 合计口径：102 = 98（五流域）+ 4（透镜补边）。一条差异点可同归多批次（按 batchRef 主归属计数一次，裁定条目单列）。
> 风险级分布：**blocking 13 / high 31 / medium 40 / low 18**。

### 6.2 数据流变动最大的批次（按差异点数 × 涉及边数排序）

| 排名 | 批次 | 变动面 | 为什么最大 |
|---|---|---|---|
| 1 | **B6** | 14 差异点，跨模型流（44 边）、供应商流（28 边）、文案流（30 边）三个流域 | 一次搬 6 份数据文件（catalog/claude-catalog/retired/provider-presets/free-model-channels/kiro + bugCases 壳），且直接撞击 D6 纯度核心争议：`provider-presets.json` 无法成为纯内容资产（表内联 require env 可覆盖常量，Δ2-6），以及 registerModel 三方冲突（§4.5-a）。两条 blocking 都在此批 |
| 2 | **B0** | 13 差异点，含 3 条 blocking + 全部守卫基建 | 不动业务数据，但决定后面每批闸门能否可跑：dataAccess 骨架、DOMAIN-DEPS 增 D6、影子目录根因（7 处 cwd 写者）、4 个新守卫 + 裁定 H 登记。B0 不通，B1–B10 每批的三守卫前提不成立 |
| 3 | **B4** | 9 差异点，但**审阅面覆盖提示词与命令面流全部 59 条边** | 单批触碰边数最多；blocking 密度最高（Δ3-3 时序契约、Δ3-4 第二链条未覆盖、Δ3-8 进程派生与 fs IO 无批次归属），且 B4c 口径虚高 2.6 倍（§4.5-b）、B4b「17 条正则」与实测 21 正则/16 matcher 不符 |
| 4 | **B10** | 10 差异点，覆盖文案与界面流 30 边 + 三个前端盲区（约 1.3 万行中文） | 唯一直接改用户可见输出的批次；裁定 L 的 zh-CN 锁是硬前提（否则英文 OS 上行为变更）；两条 blocking（src/i18n 零消费、locale 默认 'en'）都压在迁移第一步 |
| 5 | **B1** | 8 差异点 | 首批把 `MODEL_CAPABILITIES`（29 条）/`EFFORT_PRESETS`/`blockedPathPolicy` 搬出逻辑层；对象引用身份与冻结顺序是字节等价的生命线（REVIEW R-14） |
| 6 | **B8** | 5 差异点 | accountPool 的 64 处裸 SQL + 4 DDL 抽 `sql.js`，外加 curriculum.json 运行时写回、search_engines.json 双读、bugCases 壳；DB 实际约 40 张表 vs 21 个 model 的缺口在此批暴露 |
| 7 | **B5** | 1 差异点（+裁定 E） | 差异点少但覆盖面宽：端点 SSOT 今天只覆盖 5/15 preset，9100 有 6 处副本、9090 有 3 处独立默认值；grep 判据要求 services 下 `'9100'`/`'9090'` 0 命中 |
| 8 | **B3 / B7 / B9** | 各 4 | B3 = apiProviderCatalog 外置 + stripSecrets（R2 契约今日无实现）；B7 = 四套分层解析器收敛 + OFF_VALUES 176 处；B9 = SQLite 路径第三条数据家链（blocking）+ findProjectRoot 双轨 |
| 9 | **B2** | 2 | aliases/cleanupTargets/configSchema 三处一致性问题，面最小 |

### 6.3 无批次归属的差异点（方案盲区，汇总时最易丢）

| 差异点 | 风险 | 内容摘要 |
|---|---|---|
| Δ2-8 | high | env 自动合并只认 `ENV_KEY_MAP`(13)，gatewayGuide 文档化的一半 provider 设了 env 也无效 |
| Δ4-13 | high | 两份 345KB i18n 资产差 1 key，mobilePage.js 注释指向不在用的那份；真源未裁定 |
| Δ1-14 | medium | 四份互不引用的模型目录/能力表并存（含 capabilityRegistry 第三套刻度，方案未覆盖） |
| Δ2-12 | medium | env/appHome 两层对供应商数据今天零覆盖，方案新增 appHome 层属新功能（未记入任何批次的「新功能」清单） |
| Δ2-15 | medium | 脱敏口径四套，其中两套被注释明确「刻意不收敛」 |
| Δ3-19 | medium | prompts.js 导出 `MODEL_IDS` 形成模型名单第二暴露面 |
| Δ4-20 | medium | 三个前端约 1.3 万行中文无 i18n 载体、无批次 |
| Δ5-18 | medium | require 时冻结数据家（21 处顶层 const + 8 处 IIFE）无判据覆盖 |
| Δ4-23 / Δ4-24 | medium / low | 18 特征 schema 三副本 / AGENT_COLORS 两副本（透镜补边后仍无批次） |
| Δ1-16 / Δ2-11 / Δ2-13 / Δ2-20 | low | modelPricing 五态未入模型域清单 / 免费渠道承诺 7 > 可见 5 / 门控三种姿势 / PROVIDER_PRESETS 原始种子直出 |

### 6.4 B11 说明

187 方案 §4 批次表在本次追踪材料中出现的编号为 **B0–B10**（B0 前置与骨架、B1 模型常量、B2 CLI 数据、B3 供应商与策略目录、B4 提示词拆解、B5 端点 SSOT、B6 目录数据外置、B7 配置外置、B8 持久化与 accountPool、B9 路径收敛、B10 文案与界面）。**B11 在全部五流域追踪材料与双透镜复核中均无任何映射**——本图不为它编造内容；若方案后续版本新增 B11，应按 §6.1 同口径补映射。

---

## 附：本图的使用边界（再声明）

1. 本图是**测绘产物**：仓库无任何代码因本图被修改；所有 `file:line` 读自当前工作树（分支 `chore/hygiene-20261010`，有未提交修改），批次开工前应在干净树上重测。
2. 本图**不授权任何改动**：§4.5 八项待裁定、§6.3 十四条方案盲区，均须回到 187 方案或由人裁定后另行排期。
3. 本图**不替代方案**：目标态描述是 187 方案的摘录而非重述；两处不一致（B4b「17 条正则」、裁定 O「22 条目」）已按实测登记为差异点，未私自修改方案口径。
4. 复现方式：五流域边表的每条 `file:line` 都可用只读 Grep/Read 复核；§5.2 的 51 项未追通是下一轮追踪的输入清单。

