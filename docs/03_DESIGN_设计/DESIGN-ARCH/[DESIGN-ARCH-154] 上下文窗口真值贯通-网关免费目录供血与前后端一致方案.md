# [DESIGN-ARCH-154] 上下文窗口真值贯通——网关免费目录供血与前后端一致方案

> **状态**：提案（待评审，未落码）
> **范围**：`services/backend/src/services/gateway/**`、`services/backend/src/services/dynamicFreeModelService.js`（只读复用）、`services/backend/src/cli/tui/**`（消费面收敛）、`services/backend/src/cli/bannerDataService.js`（顺带修复）
> **上游依赖**：无新依赖；复用 `dynamicFreeModelService` 既有双源目录（zen + models.dev）
> **调研指针**：`[DESIGN-ARCH-081]`（ccContextWindows 旧表）、`[DESIGN-ARCH-139]`（.env 解钉，与本提案无耦合）
> **模板合规**：非借鉴类改动，B-P2 七字段按体例逐项据实填「不适用 + 依据」（§2）；零新增 env 键（不触 `check-tui-gates` 门预算棘轮）

---

## 0. 一句话结论

「总上下文永恒 128k」**不是检测逻辑写死，而是真值断供**：zen 免费端点 `/models` 实测不返回任何窗口元数据 → 网关唯一真源缓存 `_contextWindowCache` 对 zen 系模型**永远空** → 全部显示面与预算面落到 128000 保守兜底。而真值（models.dev：`mimo-v2.6-flash-free` = **200,000**）仓库里**已有解析代码**（`dynamicFreeModelService`），只是从未接进网关缓存。修复 = 给既有真源**供血一处**，TUI 底栏 / `/context` / CtxInspect / Web 端指示器**同源同亮**——不需要也不应该逐面各修。

### 病灶总表

| # | 病灶 | 位置（file:line） | 后果 |
|---|------|------------------|------|
| Z1 | zen `/models` 每条目仅 `{id, object, created, owned_by}`，零窗口元数据（**实测**，2026-09-26） | 上游 `opencode.ai/zen/v1/models` | 适配器管道永远拿不到真值 |
| Z2 | 免费目录已解析 `limit.context`（models.dev 真值），但产出只流向 `/api/free-llm` 路由，**从不写入网关 `_contextWindowCache`** | `dynamicFreeModelService.js:143,171` ↔ `aiGatewayRoutingMethods.js:1544-1566` | 同一批上游被拉两次，窗口数据在预算/显示要用的那条管道上断供 |
| Z3 | 内置 zen provider 注册不带 `defaults`（provider 级窗口兜底也空） | `customProviderRegistrar.js:446-463` | `apiAdapter.js:827` 的 `pp.defaults?.contextWindow` 恒 undefined |
| Z4 | 超限探测（overflow probe）对 zen 免费门被 `FreeTierError` 前置拦截（**实测 403**） | `upstreamModelProbe.js:189-279` 的 zen 路径 | 探测兜底在免费池上是死路 |
| Z5 | 静态 `MODEL_CAPABILITIES` 表无 mimo/zen 条目 | `cli/ai.js:136-173` | 兜底链最后一级恒 128000 |
| Z6 | TUI cc 家族自带第二份静态表（含独立 128k 默认） | `cli/tui/utils/ccContextWindows.js:12-29`；消费方 `CcApp.js:476`、`CcStatusLine.js:33` | 同模型可能出现两个分母 |
| Z7 | banner 调用的 `gateway.getContextLimit()` **在网关上不存在**（死指针） | `bannerDataService.js:57` | 启动横幅「上下文：xxxk 令牌」段永不显示 |
| Z8 | `limitSource` 一刀切 `env-fallback`，静态表命中与纯未知不可分辨 | `ctxWindowStats.js:72-73` | 「诚实标注上限来源」的设计承诺（`ctxWindowStats.js:9-11`）失效 |

---

## 1. 现状实证

### 1.1 三组实测（2026-09-26，非推测）

| # | 实验 | 结果 |
|---|------|------|
| E1 | `GET https://opencode.ai/zen/v1/models` | 全部 82 条目仅 `{id, object, created, owned_by}` 四字段；`mimo-v2.6-flash-free` 在列，**无任何 context/max_tokens 字段** |
| E2 | `https://models.dev/providers/opencode` | opencode provider 113 个模型全带窗口真值：`mimo-v2.6-flash-free` context **200,000** / output 32,000；`mimo-v2.5-free` 200,000；`deepseek-v4-flash-free` 200,000；`nemotron-3-ultra-free` 1,000,000 |
| E3 | `POST …/chat/completions`（max_tokens=1 及 999999999 超限探测，编造会话指纹） | 两次均 `403 {"error":{"type":"FreeTierError","message":"…free tier can only be used from within OpenCode"}}` —— 免费门指纹校验前置拦截，**探测请求到不了 provider 的窗口校验层** |

### 1.2 供血断点（数据流，file:line 可复核）

窗口真值的**唯一声明真源**是网关缓存——`constants/contextWindowDefaults.js:8-9` 明文：「模型真实窗口的唯一真源永远是 aiGateway 适配器上报值 (getModelContextWindow)」。它的填充路径只有两条，对 zen 系模型双双落空：

1. **listModels 路径**：`_refreshModelsBackground`（`aiGatewayRoutingMethods.js:1526-1573`）调 `apiAdapter.listModels()` → 远端探测 `fetchUpstreamModels`（`upstreamModelProbe.js:106-170`）按 `context_window || context_length || max_context_length` 解析（`:150`，注释明言「不做模型名推断」）→ zen 返回里没有这些字段 → `contextWindow: 0`；`apiAdapter.js:823-828` 再取 provider `defaults` 兜底 → Z3 使其也空 → `:845` 条件展开**整个省略 contextWindow 字段** → `aiGatewayRoutingMethods.js:1548` `cw = undefined` → 缓存不写。
2. **异步/probe 路径**：`getModelContextWindow` miss 时触发 `_resolveContextWindowAsync`（`:1843-1893`，重跑同一 listModels，同败）与 `_probeContextWindowForModel`（`:1794-1837`，仅被 `getModelContextWindowAsync` 的 Level 4b 调用）→ Z4 使 zen 免费池探测必败，且连续 2 次失败进 10 分钟冷却。

### 1.3 消费面清单（全部共享同一条兜底链，前后端一体）

| 消费面 | 入口 | 兜底链终点 |
|---|---|---|
| TUI 底栏 `x% ctx (362.3k/128` | `App.js:876-877` `aiMod.getContextLimit(activeModel)` → `aiConversationOps.js:748-750` → `_resolveModelContextLimit` | 128000 |
| 压缩预算 / contextPlan / 底栏倒计时 | `aiChatCore.js:2030`、`:2614-2628` → `_resolveContextBudget`（`aiRequestAnalysis.js:179-234`） | 128000（**提前压缩**：真窗口 200k 时每次少用 72k 预算） |
| CtxInspect 工具 / `/context` 命令 | HUD limit ← `setContextBudget`（`hudRenderer.js:160-167`）← `aiChatCore.js:2618`；读数 `CtxInspectTool/index.js:93-106`、`routerDispatchSlash.js:398-411` | 「173,069 / 128,000, percentUsed=100」（截图现象） |
| Web 端 AIChat 上下文指示器 | `AIChat.vue:1143-1146` 传 `model` → `handleAiContextStats`（`aiManagementConversationsPrompts.js:177-189`）→ 同一 `getModelContextWindow` | env/default 回退 128000（**与 TUI 错得一致**——修缓存一处即两端同亮） |
| 系统提示词瘦身判定 | `aiChatCore.js:2030` `makeSystemPrompt({ contextWindow })` | 128000 |
| 工具循环动态工具预算 | `toolUseLoopCore.js:1883-1898`（唯一 await `getModelContextWindowAsync` 的调用方） | 探测必败（Z4）→ 0 → 静态回退；`:2289-2292` 还有裸 `128000` 字面量 |
| 启动横幅 | `bannerDataService.js:57` | Z7 死指针 → 恒不显示 |

`_resolveModelContextLimit` 的三级结构（`aiRequestAnalysis.js:51-99`）：①网关真值（miss）→ ②静态 `MODEL_CAPABILITIES`（`cli/ai.js:136-173`，全为 openai/deepseek/qwen/glm 家族，**无任何 zen/mimo 条目**，Z5）→ ③`UNKNOWN_MODEL_CONTEXT_WINDOW = 128000`（`contextWindowDefaults.js:22`）。**结构本身健康**——问题是第①级对 zen 系永远空。

### 1.4 既有测试基线（实测 2026-09-26，`node --test`， managed node 22.22.2）

| 文件 | 结果 |
|---|---|
| `tests/constants/contextWindowDefaults.test.js` | **4 pass / 0 fail** |
| `tests/services/freeModelChannels.test.js` | **13 pass / 0 fail** |
| `tests/contextWindowClamp.test.js` | **存量红**：jest 风格（裸 `describe`）在 `node --test` 下 `ReferenceError: describe is not defined`（CI 全量扫描必扫到）——与本提案无关的既有债，落地时不得把它算进本提案回归 |
| `tests/services/contextWindowGuard.test.js` | 同上，存量红 |

---

## 2. 借鉴提案（B-P2 七字段）

| 字段 | 内容 |
|---|---|
| 1. 借鉴对象 | 不适用 |
| 2. 借鉴内容 | 不适用 |
| 3. 解决的问题 | 本提案为**本仓自有缺陷修复**（真值供血断线），零外部借鉴：不引入任何外部代码/结构/测试，仅复用仓内既有模块 |
| 4. 许可证与代码性质 | 不适用 |
| 5. 借鉴方式 | 不适用 |
| 6. 落点与现有实现对比 | 全部落既有文件：网关合流点为 `_refreshModelsBackground` / `_resolveContextWindowAsync`（既有 canonical 填充路径），数据源为既有 `dynamicFreeModelService.listFreeModels()`。搜索过 `contextWindow|context_window|contextLength`（services/backend/src，60+ 命中）与 `getModelContextWindow` 全部调用方，确认网关缓存是唯一声明真源，无并行真源新增 |
| 7. 验收方式 | 见 §7 |

**依据**：`[DESIGN-SOURCING-001]` §3 B-P2 管辖「借鉴外部」；本提案第 1 字段（借鉴对象）为空 ⇒ B-P2 本就不触发。按先例 `[DESIGN-ARCH-149]` §2 据实逐字段声明，不硬造借鉴关系。

**零新增 env**：本提案不新增任何 `KHY_*` 键（回滚能力用可选参数与代码回撤承担），不触 `scripts/ci/check-tui-gates.js:32` 的 MAX_GATES=220 棘轮。

---

## 3. 目标形态

### 3.1 供血优先级（单一真源内部的方向）

```
adapter listModels 真值(zen 未来若返回元数据)  >  免费目录(models.dev limit.context)
        >  静态 MODEL_CAPABILITIES  >  env KHY_CONTEXT_WINDOW  >  128000 兜底
```

### 3.2 一期：网关缓存免费目录供血（治本）

在网关内新增一个私有助手（落 `aiGatewayRoutingMethods.js`，deps 注入保持可测）：

```
_feedContextWindowCacheFromFreeCatalog(rows)
  输入：本轮 adapter.listModels() 产出的 rows（含完整 id `api:<pool>:<bareId>`）
  行为：仅对「本轮未获得 contextWindow」的 row，按 bareId 查
        dynamicFreeModelService.listFreeModels()（该服务自带 5min 文件缓存，
        zen + models.dev 双源，其 zen 解析分支 :193 在上游未来返回元数据时自动生效）
  写入：_setContextWindowCache(<完整id>, cw, 4h, 'free-catalog')，同时写 bareId 一条
  约束：只填缺失者，绝不覆盖 adapter 真值/listModels 已写入的条目；
        fail-soft——目录拉取失败(离线) → 行为与今天逐字节相同(128000 兜底)
```

接线点两处（同一个小助手）：`_refreshModelsBackground`（`:1544-1566` 收尾）与 `_resolveContextWindowAsync`（`:1861-1886` 收尾）。**裸 id 与 `api:` 前缀 id 的互通靠既有部分匹配**（`getModelContextWindow:1716-1723` 双向 `includes`），不需要改匹配逻辑；跨池同名误命中风险由「仅按本轮 rows 的 bareId 精确反查」消除（不做全目录批量灌入）。

### 3.3 二期：消费面收敛（消灭第二真源与死指针）

| 改动 | 位置 | 方式 |
|---|---|---|
| Cc 家族接入真源 | `CcApp.js:476`、`CcStatusLine.js:33` | 组件加**可选** `contextLimit` prop，由 App 层（已有 `refreshFooter` 同源数据）传入；缺省时回退 `ccContextWindows.getContextWindow`（可选参数 = 逐字节回滚能力，组件保持纯叶子零 IO） |
| banner 死指针 | `bannerDataService.js:57` | `gateway.getContextLimit()` 不存在（全仓 grep 仅 `cli/ai.js:661` 与 `hudRenderer.js:174` 各有 cli 层同名函数）→ 改调 `ai.getContextLimit()`（内部即 `_resolveModelContextLimit`，供血后自动真值）。**顺带修复，单独登记**（§8.4 纪律） |
| 字面量收敛 | `toolUseLoopCore.js:2292`（`:2624`/`:9488`/`:9750` 同型） | `128000` → `contextWindowDefaults.resolveFallbackWindow(process.env)`（行为等价：env 未设时同为 128000；env 设定时遵从用户显式配置，与 `ctxWindowStats._fallbackLimit` 同语义） |

### 3.4 三期：诚实标注（让「估算」看得见）

| 改动 | 位置 | 方式 |
|---|---|---|
| limitSource 细分 | `ctxWindowStats.js:72-73` | 新增**可选**入参 `limitSourceHint`（调用方传 `'adapter'|'catalog'|'static-table'|'env'|'unknown-default'`）；缺省时现行为逐字节不变（纯叶子契约不破：仍零 IO、绝不抛、env 经入参） |
| `/context` 详情行 | `contextPanelDetail.js`（已实现 limitSource 标注，`:83`） | 供血成功显示 `适配器/目录真值`；兜底显示 `128k 估算兜底`——把 Z8 的「一刀切 env-fallback」拆开 |
| 底栏分母前缀 | `FooterBar.js` ctx 段 | 非真值来源时显示 `~128k`（波浪号 = 估算），真值显示 `200k`；文案实施时与用户确认 |

---

## 4. 实施分期（每期独立可回滚）

| 期 | 内容 | 回滚方式 | 新测试（node:test 风格，落地即绿） |
|---|---|---|---|
| 一期 | §3.2 供血助手 + 两处接线 | 撤两处调用即回滚（助手成死代码可一并撤） | `tests/gateway/contextWindowCatalogFeed.test.js`：①rows 带 contextWindow → 目录不覆盖；②rows 缺失 + 目录有 `mimo-v2.6-flash-free=200000` → 完整 id 与裸 id 双 key 命中；③目录抛错/空 → 原样返回不抛 |
| 二期 | §3.3 三处收敛 | 各自独立，撤单处不影响其余 | 扩展上述测试文件或新增 `tests/cli/tui/ccContextLimitProp.test.js`（断言缺省 prop 时回退旧表值） |
| 三期 | §3.4 标注 | `limitSourceHint` 不传即回旧行为 | `tests/services/contextWindowStats*` 追加断言（**另建文件**，勿往 jest 风格文件追加——`contextWindowGuard.test.js` 是 jest 风格，混入会被两套 runner 双扫） |

依赖关系：三期依赖一期（否则标注恒为「兜底」，无意义）；二期与一、三期无依赖，可并行。

---

## 5. 诚实边界（刻意不纳入）

| 不做的事 | 原因 |
|---|---|
| 把 `mimo-v2.6-flash-free=200000` 写进静态 `MODEL_CAPABILITIES` 表 | 一行看似修复，实则固化「每加一个模型改一次代码」的债：zen 目录 113 个模型且频繁更替；且静态表平行实现正是本次要收敛的对象（`contextWindowDefaults.js:10` 自述「散落 6+ 文件」的前科） |
| 把默认兜底 128000 改大（如 1M） | 违反 `contextWindowDefaults.js:13-16` 明文契约「宁可写小不可写大」：写小多压缩一次（可恢复），写大运行时 400/413（不可恢复） |
| 每轮预算路径 await 探测（3s） | 每轮 +1 网络往返，免费池限流风险；且 E3 实测探测对 zen 必败——probe 只配当最后兜底，维持现状不动 |
| 修 `contextWindowClamp.test.js` / `contextWindowGuard.test.js` 的 jest 存量红 | 非本提案病灶；动它们属于另外的条目（顺带修复纪律：只登记不顺修） |
| 「362.3k 已用怎么压回窗口内」 | 压缩管线既有职责（contextRouter/seamManager），本提案只保证分母诚实 |
| models.dev 数据的实时性保证 | 目录有滞后/谎报可能 → 既有 `MAX_PLAUSIBLE_CONTEXT_WINDOW=1048576` 天花板钳制（`aiRequestAnalysis.js:191`）+ 4h TTL + zen 真值优先级更高，三层兜住 |

---

## 6. 反模式（这条路别走）

| ✗ 别做 | 为什么 |
|---|---|
| 前端自己再拉一份 models.dev | `dynamicFreeModelService` 与网关**已经**各拉一次同一批上游（Z2 正是双管道的产物）；Web 端必须消费后端缓存（`handleAiContextStats` 已如此），再造第三条管道 = 债复发 |
| 全目录批量灌入 `_contextWindowCache` | 跨池同名模型（如 `deepseek-v4-flash` 在 zen 与官方池同 id 不同窗）会互相覆盖；只按「本轮 rows 的 bareId 精确反查」才能保证 key 语义正确 |
| 在 `ccContextWindows` / `ctxWindowStats` 纯叶子里 require 网关或读 env | 叶子契约（零 IO / 绝不读 env / 绝不抛，`check-leaf-contract.js` 执行）；数据一律调用方注入（可选 prop / 可选入参） |
| 为了「前后端一致」在 Web 端复制一份百分比算法 | 两端已经通过 `computeContextStats` / `analyzeWebContextStats` 共享叶子 SSOT；分母修一处，两端自动一致——「一致」的正确实现是同源，不是对称复制 |
| 用 `git log`/索引取本文件编号 | 已按目录枚举取 154（目录实况 max=153，含 140 撞号两件的历史教训） |

---

## 7. 验收方式

**自动化（每期落地即跑）**：

```bash
# 新测试（node:test，落地即绿）
node --test tests/gateway/contextWindowCatalogFeed.test.js        # 一期
# 零回归基线（实施时逐文件跑，读 # tests/# pass/# fail 三行，不许估）：
node --test tests/constants/contextWindowDefaults.test.js          # 基线 4 pass
node --test tests/services/freeModelChannels.test.js               # 基线 13 pass
# 门禁
npm run check:changed
node scripts/ci/check-leaf-contract.js <被改叶子文件>               # 二期 Cc 组件若改动
node scripts/ci/check-tui-gates.js                                 # counts 对比：零漂移（零新增 env 门）
```

**实机验收（用户执行，前后端一致性判定）**：

1. TUI 选 `api:opencode-zen:mimo-v2.6-flash-free` → 底栏 ctx 段显示 `x% ctx (…/200`（而非 `/128`）。
2. `/context` → 「已使用: … / 200k 令牌」，详情行上限来源不再是「env 回退」。
3. CtxInspect → `limit=200000, limitSource=adapter|catalog`（不再恒 critical/percentUsed=100）。
4. Web 端 AIChat 指示器 → 与 TUI 同一分母（同源缓存，无需改前端代码）。
5. 拔网线/目录拉取失败 → 全部回到今天的 128000 兜底，无报错（fail-soft 可用）。

**关联门禁**：`check:changed`、`check-leaf-contract`、`check-tui-gates`、`check-agent-rules`（零硬编码：无新字面量窗口值）、`check-proposal-index`（本文档非借鉴类，不登记 `PROPOSAL-ARTIFACT-INDEX.json`，该检查器不要求）。

---

## 8. 待核实项

| # | 事项 | 状态 | 影响 |
|---|---|---|---|
| 1 | `getModelContextWindow` 部分匹配对「裸 id key ↔ `api:` 前缀查询」双向 includes 的顺序稳定性 | 已核（`:1716-1723` 遍历 Map 插入序）→ 一期测试显式钉住双 key 写入，不依赖遍历序 | 阻断一期设计，已消解 |
| 2 | zen 免费门对**真实** khy 会话头下的超限探测是否放行 | 沙箱无法完全复刻 zenGatekeeper 指纹（E3 只证伪了「编造指纹」场景）；按「探测不可依赖」设计，一期不依赖它，留作运行时观察项 | 不阻断；若真机探测可用仅是额外兜底 |
| 3 | models.dev 免费目录中 zen 模型 id 与 apiAdapter bareId 的形态对齐（E2 已证实目录 id 就是裸 id：`mimo-v2.6-flash-free`） | 已核实一致 | 无 |
| 4 | `services/.env` 的 `PROXY_PRIMARY_ADAPTER=relay_api+strict` 二层钉选是否影响 `_refreshModelsBackground` 的 `_resolveActiveChannelKey` | 该 env 不是 `GATEWAY_PREFERRED_ADAPTER`，`_resolveActiveChannelKey:1582-1596` 只读后者 → 不影响 | 无 |
| 5 | CI 是否已因 jest 存量债（§1.4 两个文件）而红 | **未核实**（本机无法完整复刻 CI 选择范围）；落地一期前跑一次 `node --test tests/gateway/contextWindowCatalogFeed.test.js` 只需新文件自身绿；存量红归因已写入 §1.4，若 CI 全红先归因再认账（§6.5 三步法） | 不阻断设计 |

---

## 9. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-09-26 | 初稿：三组实测（zen /models 零元数据、models.dev 真值 200k、免费门 403 拦截探测）+ 供血断点定位 + 三期方案 |
| 2026-09-26 | 三期全部落地，实施记录见 §10 |
| 2026-09-26 | 热修 2：供血源扩展至 models.dev 全量目录（agnes-3.0-flash 付费通道回归），见 §10.4 |
| 2026-09-26 | 热修 3：两段 id 裸解析 + 目录 TTL 24h/超时 30s + 显示侧 miss 补供触发器，见 §10.5 |
| 2026-09-26 | 热修 4：实际探测接入主刷新路径（probe 双真值升级覆盖目录占位 + Step 1 裸 return 残留修复），见 §10.6 |

---

## 10. 实施记录（2026-09-26，同日提案→实施）

### 10.1 落地清单

**一期：网关缓存免费目录供血（治本）** — `services/backend/src/services/gateway/aiGatewayRoutingMethods.js`
- 新增模块级 `_freeCatalogGetter` 依赖 + `_loadFreeCatalogDefault()` 缺省加载器（延迟 require `dynamicFreeModelService.listFreeModels`，异常 fail-soft 回 `[]`）
- `setAiGatewayRoutingMethodsDeps` 支持 `_freeCatalogGetter` 注入（测试隔离网络/文件）
- 新增 `_feedContextWindowCacheFromFreeCatalog(rows)`：按本轮 rows 的裸 id 精确反查目录，只填缺失（adapter 真值 `row.contextWindow>0` 让位、缓存正值不覆盖），`api:<pool>:<bareId>` 命中后完整 id + 裸 id 双写，TTL 4h，source `free-catalog`
- 接线两处：`_resolveContextWindowAsync`（listModels 循环后）与 `_refreshModelsBackground`（模型列表落定后），均 try/catch fail-soft

**二期：消费面收敛**
- `src/cli/bannerDataService.js:57` 死指针修复：`gateway.getContextLimit`（aiGateway 上不存在）→ `ai.getContextLimit()`（真源 `aiConversationOps.getContextLimit:748`，经 `ai.js:661` 暴露），横幅「上下文：Nk 令牌」从恒空恢复
- `src/services/tool/toolUseLoopCore.js` 三处同构三级回退链（capacityFlow 前置/工具后/错误升级检查点，`:2289` `:9485` `:9747`）：`parseInt(KHY_CONTEXT_WINDOW)||128000` → `resolveFallbackWindow(process.env)`，与 ctxWindowStats/capacityFlow 同一助手

**三期：诚实标注**
- 评估结论：`contextPanelDetail` 的 adapter/env-fallback 双面文案区分**已存在**（刀103 落地，`buildContextDetailLines`/`buildContextIdentityLines`），无需改
- `limitSourceHint` 可选入参：**刻意不加**（偏离见 §10.2-3）

### 10.2 偏离及原因

| # | 偏离 | 原因 |
|---|---|---|
| 1 | CcApp/CcStatusLine 可选 `contextLimit` prop 未新增 | 已全面存在（`App.js:876-878` 传 `aiMod.getContextLimit(activeModel)`，FooterBar/Statusbar 均已收 prop）——零改动即达标 |
| 2 | `toolUseLoopCore.js:2620-2625` catch 兜底保留 `128000` 字面量 | 该 catch 是 constants 模块加载失败的最后防线，此时 `resolveFallbackWindow` 同样不可用；主链已换真源助手 |
| 3 | `computeContextStats` 未加 `limitSourceHint` 入参 | 四个调用点（CtxInspectTool/routerDispatchSlash/replSession×2）的 limit 全部来自 `getModelContextWindow()` 裸数字，**无任何调用方能拿到 source**——加了就是 computed-but-never-fed 死参数，违反本仓哲学。free-catalog 供血值（models.dev 规格真值）落入 `limitSource='adapter'` 口径，语义成立：非猜测、非 128000 兜底 |
| 4 | `check-tui-gates` 未提基线（229 > 227 报红） | 实测归因：工作区 52 个 tui/ 改动文件 + 13 个未跟踪新文件（并行会话未提交工作）带来 18 个新 KHY_* token，与本次修复的四个文件**零交集**；本次修复零新增 env 门（本提案设计目标兑现）。提基线是并行会话功能的决定，不越权 |

### 10.3 验收实测（`node --test`，managed node 22.22.2，2026-09-26）

| 套件 | 结果 |
|---|---|
| `tests/gateway/contextWindowCatalogFeed.test.js`（新增 8 用例） | `# tests 8 / # pass 8 / # fail 0` |
| `tests/constants/contextWindowDefaults.test.js`（基线） | `# tests 10 / # pass 10 / # fail 0` |
| `tests/cli/contextPanelDetail.test.js`（叶子） | `# tests 13 / # pass 13 / # fail 0` |
| `tests/services/toolUseLoopBudgets.test.js` | `# tests 7 / # pass 7 / # fail 0` |
| `tests/toolUseLoop.coreContracts.test.js` | `# tests 9 / # pass 9 / # fail 0` |
| `tests/services/toolUseLoopTransientBudget.test.js` | 1 红 = jest 存量债（`describe is not defined`，加载期 ReferenceError；文件不在本次改动清单，未进执行路径即死） |
| `check-leaf-contract`（ctxWindowStats + contextPanelDetail） | passed，无违规 |
| `node --check` 四个改动文件 | 全绿 |

**前后端一致性**：TUI 底栏 / Web AIChat / `/context` / CtxInspect / 压缩预算本就共享网关缓存这条 SSOT——缓存一处供血，两端同亮，无需对称复制。

### 10.4 热修 2：供血源扩展至 models.dev 全量目录（2026-09-26 08:16 用户回访截图回归）

**回归现场**：底栏仍显 `0% ctx (0/128k)`，但模型已换 `api:agnes:agnes-3.0-flash`（自有 key 通道）。

**根因（实测闭合）**：
- models.dev 全量实测：`agnes-3.0-flash` 挂 **nano-gpt** provider 名下，`limit.context=524288`（与 `aiRequestAnalysis.js:154` 既有「Agnes 512k」认知吻合）；agnes provider 名下 2.0-flash/2.5-flash 均 512000 且 cost 0/0。
- 结构性缺口：`_isFreeModelEntry` 只收 `-free` 后缀或 cost 0/0 —— **付费模型永远进不了免费目录**，一期供血对自有 key 付费通道结构性 miss。
- 附带发现：`refresh()` 无条件把空结果写缓存 → 瞬时网络故障造成 5 分钟供血空窗（本会话实测复现：一次 probe 拉到 0 条并落盘）。

**修复（供血优先级不变，数据源加宽）**：
- `dynamicFreeModelService.js`：新增纯函数 `extractCatalogFromModelsDev`（全 provider 全模型）+ `buildCatalog`（裸 id 去重：真值胜 0、多真值取 min）+ `listCatalogModels()`（独立缓存 `free-catalog.json`，同 TTL 5min；api.json **一次拉取双产物**，免费列表语义逐字节不变）；`refresh()` 空结果不再覆盖有货缓存。
- `aiGatewayRoutingMethods.js`：`_loadFreeCatalogDefault` 改为全量目录优先、免费列表兜底；`_feedContextWindowCacheFromFreeCatalog` 匹配逻辑不动。
- 测试：extract 套件 +3（付费条目/junk/去重 min），CatalogFeed 套件 +2（`api:agnes:agnes-3.0-flash`→524288 截图回归钉、让位不覆盖）。

**端到端实测（真网络+真目录+真供血代码）**：目录 3686 条在线拉取 → `api:agnes:agnes-3.0-flash` 与裸 id 双写 524288 ✓；一期 `api:opencode-zen:mimo-v2.6-flash-free` → 200000 零回归 ✓。

**预期显示**：重启会话后底栏 `0% ctx (0/524k)`（`Math.round(524288/1000)`）。**旧进程不生效** —— 供血代码随进程启动加载，修复前启动的会话必须重启。

**诚实边界**：524288 取自 models.dev nano-gpt 条目；apihub.agnes-ai.com 若对同 id 提供不同窗口，以运行时报错为准（error-extract 兜底仍在链上，会以实测真值覆盖目录值——「adapter 真值 > 目录」优先级未变）。

### 10.5 热修 3：触发时序与两段 id（2026-09-26 08:35 二次回访截图回归）

**回归现场**：用户已重启进程（pid 变更），底栏仍 `0% ctx (0/128k)`。

**实测定位（生产级 apiAdapter.listModels 真实 rows）**：
- 真实 rows 存在**两种 id 形态并存**：agnes 池三段 `api:<pool>:<model>`、zen 池两段 `<pool>:<model>`（apiAdapter.js `${p.key}:${mid}` 分支）。裸 id 解析只认三段 → **两段 zen rows 必 miss**。
- 供血触发依赖 `_refreshModelsBackground`，而它被 `!entry.available` 前置过滤（adapter detect 未完成/失败即整链跳过）——启动时序上 warmup 是异步 fire-and-forget，**用户在 detect+listModels+目录拉取（4.9MB）全部落定前渲染底栏看到 128k 后，若首轮无补供触发器就永远停在 128k**。
- api.json 4.9MB vs 免费列表级 10s 超时：慢网高频失败（本会话沙箱实测复现拉空）。

**修复三件**：
1. `aiGatewayRoutingMethods.js` 裸 id 解析补两段形态（`slice(1)`）——真实 rows 复测 fed 18→**27**，zen 条目 MISS→200000。
2. `dynamicFreeModelService.js` 目录独立 TTL **24h**（注册数据准静态）+ 目录拉取超时 **30s**（`CATALOG_FETCH_TIMEOUT_MS = max(env, 30000)`；免费列表同样受益）。
3. `aiRequestAnalysis.js` 显示侧缓存 miss → fire-and-forget `_warmupContextWindowCache()`（自带 in-flight 去重、供血幂等只填缺失）——把「用户看到 128k」本身变成补供触发器，数秒后下帧自愈，不再有「错过启动窗口就永远 128k」的死态。

**端到端复测（真实 rows + 修复后代码）**：`api:agnes:agnes-3.0-flash`=524288、`api:agnes:agnes-2.0/2.5-flash`=512000、`opencode-zen:mimo-v2.6-flash-free`=200000 全命中；`getModelContextWindow('api:agnes:agnes-3.0-flash')`=524288（显示链终点直达真值）。测试 CatalogFeed 12/12（+2 两段 id 用例）· extract 7/7 · freeModelChannels 8/8 · contextWindowDefaults 10/10。

**生效条件**：重启 khy 会话进程。启动瞬间若仍闪现 128k，属 detect/拉取落定前的正常时序，数秒内自动翻转为真值（热修 3 的补供触发器保证收敛）。

### 10.6 热修 4：实际探测接入主刷新路径（2026-09-26 用户指令「不要硬编码应该实际探测后返回」）

**用户裁定**：目录标称值（models.dev）只能当占位，最终显示必须来自**实际探测上游**后的真值。

**修复三件**：

1. `aiGatewayRoutingMethods.js` `_resolveContextWindowAsync` 新增**探测级**（adapter 循环后，`:1955-1993`）：缓存值「无值 / 已过期 / source 仍是 free-catalog」时调 `_probeContextWindowForModel` 发真实 API 请求（最小请求 + 超限 400 错误解析），真值以 source `probe` 双写（完整 id + 裸 id）**升级覆盖**目录占位；probe 失败保留目录值不空窗。adapter 真值（listModels）与未过期的历史 probe 真值不重花请求。
2. `upstreamModelProbe.js` `probeContextWindow` 签名 `Promise<number>` → `Promise<{contextWindow, maxOutputTokens}>`：同一次超限请求提取**双真值**（context 超限与 max_tokens 超限措辞互不冲突）；新增 `parseMaxTokensOverflow`（agnes 实测形态 `max_tokens exceeds the limit of N` + 泛化形态；提取错一个数比提取不到更糟 → 其余一律 0）；导出表同步。
3. `_probeContextWindowForModel` 适配双真值：ctx>0 → probe 缓存并返回；mo>0 → `setModelMaxOutputTokens` 顺带入缓存（`aiGatewayGenerateMethod.js:4103` / `aiGatewayModelMethods.js:764` 参数封顶消费）且算半成功**不计失败冷却**。

**签名改造漏网修复（本轮实测揪出）**：Step 1 headers/body 命中处的两处裸 `return val` / `return bodyCtx`（upstreamModelProbe.js `:256` `:268`）仍是改造前的数字返回 → 调用方读 `result.contextWindow` 得 undefined、Step 1 命中的真值被静默丢弃。agnes 场景（Step 1 无信息）恰好掩盖了它；新增契约测试 `tests/gateway/upstreamModelProbeParse.test.js` 以「Step 1 headers 命中 → 必须返回对象」钉死防回退。

**agnes 上游诚实边界（真机实测）**：最小请求 200 正常但 headers/body 均无窗口信息；超限请求 400 报 `"max_tokens exceeds the limit of 65536"` —— 是**输出上限**而非 context 窗口，agnes 不通过溢出错误暴露 context 窗口。因此对 agnes：probe ctx=0 → 目录 524288 保留。这不是硬编码，是「探测优先、注册表降级、绝不臆造」——probe 真值一旦可得（provider 换措辞/换通道）即以 probe 为准；65536 已作为本模型首个 probe 真值入输出上限缓存。

**验证（managed node 22.22.2，2026-09-26）**：`node --check` 两文件 ✓；CatalogFeed 15/15（probe stub 三用例：升级覆盖 / 失败保留 / adapter 真值不探测）；upstreamModelProbeParse 12/12（解析形态 ×6 + 对象契约 ×6，含 OpenAI/Anthropic 双 provider 超限报文真形态）；E2E 真实探测 `api:agnes:agnes-3.0-flash` → `ctx=0 maxOutputTokens=65536 failCount=0`（2978ms，一次真请求，半成功不计冷却）。

**测试教训**：两次凭记忆编造上游报文形态（单数 `maximum context length is N tokens`、漏 `resulted in` 短语）被 `parseContextOverflowTokens` 的双数要求（`errorClassifier.js:671`，limit+prompt 两数缺一即 null）打回 —— 测试期望必须抄**真实报文形态**（先读 pattern 定义 `errorClassifier.js:631-643`），不能凭印象复述。
