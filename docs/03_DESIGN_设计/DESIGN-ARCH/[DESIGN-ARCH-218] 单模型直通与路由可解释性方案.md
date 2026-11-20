<!-- IMPL-STATUS: done -->
# [DESIGN-ARCH-218] 单模型直通与路由可解释性方案

<!-- RULES-REGISTRY: RUNTIME-001, RUNTIME-002, RUNTIME-007, RUNTIME-008, PROCESS-008, PROCESS-014 -->

> **状态**：已实施（2026-11-16，P0–P3 全绿）。本提案只做「单模型直通 + 可解释字段 + 零硬编码清理」三件事；
> 档位统一（performance/balanced/fast）经裁决**另案**处理，见 §5。
> **范围**：`runtime/node/backend/src/services/gateway/modelRouter.js` 的调用面、
> `src/services/gateway/upstreamModelProbe.js` 的输出消费面、
> `src/services/dynamicPromptAssembler.js` / `src/services/perRequestAdaptationPipeline.js` 的输出外显、
> `src/services/telemetryService.js` 的路由记录字段、
> `config/models/routing.json`（本提案新增）。
> **不改**：`modelRouter.js` 既有的钉选语义（`userPinned` / `strictPreferred`）——沿用
> `[DESIGN-ARCH-162]` §0 红线；`modelTier.js` 的 T0–T3、`capabilityProbe.js` 的
> guest/standard/cage 一律不动；`toolUseLoopCore.js` / `replSession.js` 不碰。
> **上游依赖**：`[DESIGN-ARCH-162]`（模型粒度候选池 + 健康账本）、`[DESIGN-ARCH-185]`
> （四档用户模式轴，S1 观察者/todo——档位统一须与它合并，不得并行新建）、
> `[DESIGN-ARCH-167]`（选择器分层字段）。
> **调研指针**：`[DESIGN-ARCH-185]` §4.2 档位语义边界、§3.4 价格真源雷、
> `[DESIGN-ARCH-162]` §0 钉选红线。
> **模板合规**：零外部借鉴的纯自修；§2 按 B-P2 体例逐项据实填「不适用 + 依据」，不留空。

---

## 0. 一句话结论

用户方案的六层架构，khy-os **已有五层的可用实现**；真正缺的只有三件事：
一个能区分「测到 1 个 / 测到 0 个 / 没测到」的**单模型判定信号**、一组**可解释响应字段**、
以及一处**零硬编码违规**。单模型直通按定义要跳过档位阈值校验，因此不依赖任何档位重构。

| # | 病灶 | 证据（file:line） | 后果 |
|---|---|---|---|
| G1 | 无「候选数=1」统一出口 | `upstreamModelProbe.js:126-129` 返回 `{ok,status,models,error}`，调用方各自解释 | 单模型仍进 UCB1 打分与级联回退，Router 耗时不为零 |
| G2 | 路由响应无可解释字段 | `modelRouter.js:365-381` 返回 9 字段，无 `tier`/`reason`/`probes` | 无法回答「为什么是它」 |
| G3 | 零硬编码违规 | `modelRouter.js:239-245` 写死 5 个模型名 | 换模型要改代码，违反方案红线与 `RUNTIME-001` 精神 |
| G4 | 适配结果不外显 | `dynamicPromptAssembler.js:571` 无 `matched_by` / `final_system_prompt` 输出 | 无法用「有无适配」对比验证适配真的生效 |
| G5 | Router 非纯函数 | `modelRouter.js:274,322,339,347` 读 5 处 env | 单模型路径无法做确定性单测，方案「纯函数约束」落不了地 |

**不把它做成大改的理由**：G1–G5 全部可以用「外层纯函数包装 + 附加字段 + 配置注入」解决，
不必重写 `resolveModelRoute()` 本体，也不必碰档位体系。

---

## 1. 现状实证（file:line 可复核）

### 1.1 方案六层 ↔ 仓库真实落点

| 方案层 | 仓库现状 | 与本提案的关系 |
|---|---|---|
| 一 运行时能力探测 | `upstreamModelProbe.js:76` `buildModelsUrl()`（失败返回 null，零编造）；`localOllamaProbe.js:28` 仅 `/api/tags`；`modelCapability.js:87` 分类；env `KHY_MODEL_CAPABILITY_MAP`（`modelCapability.js:53`） | **有**。本提案只新增对 `probeUpstreamModels()` 输出的**统一判定**，不新增探针 |
| 二 能力档位判定 | `modelTier.js:46,92` T0–T3；`capabilityProbe.js:52-53` guest/standard/cage 75/50 | **有，但不止一套**。本提案不动，见 §5 |
| 三 候选过滤 | `autoModelRouting.js:13` 候选池、`ucbRouter.js:6-16` UCB1、级联在 `aiGateway.js` | **有**。单模型时由外层短路，不改内部 |
| 四 路由决策 | `modelRouter.js:266` `resolveModelRoute()`，返回结构见 `:365-381` | **有**。附加 `explain`，不改既有 9 字段 |
| 五 提示词适配 | `config/models/features.json:191` 家族注册表（11 维能力矩阵）；`modelFeatureRegistry.js:362-380` 编译正则；`dynamicPromptAssembler.js:571` 动态拼装；`perRequestAdaptationPipeline.js:137` 七阶段编排；缺口补偿已存在（`prompts.js:2398` `!hasNativeToolUse` 注入 `<tool_call>` 教学） | **有，且本来就独立于模型数量**。只补输出外显 |
| 六 可观测与反馈 | `autoModelRouting.js:735-796` 决策落盘；`telemetryService.js:408` `selectRouteKey`；`scripts/ci/route-replay.js` 回放 | **有**。补单模型专用字段；反馈打通画像另行 |

### 1.2 方案第九节四个疑点——实测结论

| 疑点 | 实测答案 |
|---|---|
| 是否已有默认模型 / 占位符机制 | **有**。`constants/models.js:61-82` `primaryOf()` / `PRIMARY` 单一真源（设计意图见文件头 `:3-18`）；`autoModelRouting.js:162` 有 `'auto'` 哨兵。不必新建占位符 |
| 单 Key 下 `/v1/models` 特殊格式 / 错误码 | 容错已在：`probeUpstreamModels()` 返回 `ok/status/error`，非 2xx 不编造（`:126-129`）。**但特殊错误码仍需真 Key 实测**，见 §8 |
| 提示词模板是否假设多模型 | 仅 `prompts.js:1676` 一句 "AI Gateway (multi-model)" 措辞，非硬前提；无需改模板 |
| Ollama `/api/show` 响应结构 | **探针不存在**（全 backend 零匹配），只有 `/api/tags`（`localOllamaProbe.js:28`）。本提案不实现，见 §5 |

### 1.3 一个必须写清的事实：仓库里有三套档位

| 层 | 落点 | 状态 |
|---|---|---|
| 能力 tier T0–T3 | `modelTier.js:46,92`（正则 + `KHY_CAPABILITY_TIER` + `KHY_MODEL_TIER_MAP`） | 代码既有 |
| 能力带 guest/standard/cage | `capabilityProbe.js:52-53`（阈值 75/50） | 代码既有 |
| 用户模式轴 auto/极致/性能/经济 | `[DESIGN-ARCH-185]` §4.2 | **提案 todo，未落地** |

方案里的 performance/balanced/fast **三套都不是**。若此刻引入，就是第四套——
与 `[DESIGN-ARCH-185]` 的正式设计方向直接冲突，且会三/四套并存。

### 1.4 单模型判定的正确地基（关键细节）

`probeUpstreamModels()` 的契约（`upstreamModelProbe.js:112-114` 注释原文）：

> `null = 探测没跑成（网络/超时/非 2xx），[] = 跑成了但上游没报模型。两者语义不同。`

因此判定必须三值分流，不能塌成一个数字：

| 探测结果 | 语义 | 路由行为 |
|---|---|---|
| `{ok:false, ...}` | **没测到** | 回退到配置默认模型，`reason='default_fallback'` |
| `{ok:true, models:[]}` | **测到 0 个** | 同上，但 `probes.probeOk=true`，可诊断 |
| `{ok:true, models:[X]}` | **测到 1 个** | 直通 X，`reason='only_available_model'` |
| `{ok:true, models:[A,B,...]}` | 多候选 | 走既有打分/级联 |

❌ **别写** `Number(models?.length ?? 0) <= 1`：那会把「没测到」伪装成「测到 0 个」。
这是本仓已有教训（`[khyos-design-proposal]` §1.1）：**判定必须能区分「测到 0」与「没测到」**。

---

## 2. 借鉴提案（B-P2 七字段）：不适用 + 依据

本方案由用户提供，是对**本仓自身**行为修正与字段补齐；未借鉴任何外部项目/论文/代码，
B-P2 第 1 字段「借鉴对象」为空 ⇒ B-P1 豁免成立（零借鉴 ⇒ B-P2 本就不触发）。
按体例逐项据实填，不留空：

| # | 字段 | 填写 |
|---|---|---|
| 1 | 借鉴对象 | **不适用**——无外部项目/版本/commit；方案来源为用户提供的改造文字 |
| 2 | 借鉴内容 | **不适用**——未借结论、结构、行为或测试 |
| 3 | 解决的问题 | 本仓 G1–G5：无单模型判定出口、路由不可解释、5 个模型名硬编码、适配不外显、Router 非纯函数（证据见 §0） |
| 4 | 许可证与代码性质 | **不适用**——未引入任何外部代码/二进制/资源 |
| 5 | 借鉴方式 | **不适用**——非 `idea`/`reference`/`adapter`/`vendored`/`fork` 中任一种 |
| 6a | 落点 | `src/services/gateway/modelRouter.js`（已存在，扩展）；`src/services/gateway/modelAvailability.js`（**本提案新增**）；`config/models/routing.json`（**本提案新增**）；`telemetryService.js` / `dynamicPromptAssembler.js`（已存在，扩展） |
| 6b | 现有同类实现与搜索 | 已搜 `only_available_model`/`single_model_bypass`/`final_system_prompt`/`matched_by` 于 backend 全域：**零命中**；搜 `capability`/`route`/`adapter` 命中 §1.1 所列模块。⇒ 本提案是**扩展既有 canonical**，不是新建并行路由 |
| 7 | 验收方式 | §7 的可复现命令：单模型注入下断言 `explain.path === 'single_model_bypass'`，且 `tests/modelRouter.test.js` 基线 7/7 不退化 |

---

## 3. 目标形态（组件级契约）

### 3.1 `modelAvailability.js` — 纯叶子（新增）

按仓库 TUI 叶子纪律的同一形状：零 IO、**绝不读 env**、确定性、**绝不抛**、不改入参。

```
classifyModelAvailability({ probe, configured } = {})
  probe      := { ok:boolean, status:number, models:string[], error:string } | null
  configured := string[]（人工配置/默认模型，由调用方传入；不读 env）
  return     := { state:'single'|'multiple'|'empty'|'unprobed', modelIds:string[],
                  reason:'only_available_model'|'default_fallback'|null }
```

规则表（顺序即优先级，与方案「数据源优先级」一致）：

1. `configured` 非空且长度为 1 → `single`（人工配置最高优先）
2. `probe?.ok === true && models.length === 1` → `single` / `only_available_model`
3. `probe?.ok === true && models.length > 1` → `multiple`
4. `probe?.ok === true && models.length === 0` → `empty`（**不是 single**）
5. 其余（含 `probe===null`、`ok===false`）→ `unprobed`

`state ∈ {empty, unprobed}` 时由调用方取配置默认模型，reason 为 `default_fallback`。

### 3.2 `resolveSingleModelRoute()` — `modelRouter.js` 的外层包装（新增导出）

**不修改 `resolveModelRoute()` 本体**——它读 5 处 env 是既有契约，重写会破坏 7 条既有断言。

```
resolveSingleModelRoute({ availability, routeInput, defaultModelId } = {})
  → { ...既有 9 字段, explain: {...} }
```

- `state === 'single'` → 直接返回该模型的 route，`explain.path='single_model_bypass'`
- 否则 → 委托 `resolveModelRoute(routeInput)`，`explain.path='multi_model_routed'`
- 能力缺口（如模型不支持工具调用但任务需要）→ `explain.capabilityGap='capability_gap_accepted'`
  （由适配层补偿，**不拒绝服务**——方案红线）
- 相同输入必得相同输出（`availability` 由调用方注入，函数自身零 IO）

### 3.3 `explain` 字段契约

| 字段 | 单模型取值 | 多模型取值 | 消费者 |
|---|---|---|---|
| `candidateCount` | `1` | `n` | 日志 / 回放 |
| `path` | `'single_model_bypass'` | `'multi_model_routed'` | 可观测 |
| `reason` | `'only_available_model'` / `'default_fallback'` | 既有原因或 `'routed'` | 响应披露 |
| `tier` | `'single_model_bypass'` | 既有 tier（T0–T3 / guest…），**不引入第四套** | 响应披露 |
| `filter` | `'skipped'` | 实际过滤原因 | 日志 |
| `scores` | `{}` | UCB1 打分明细 | 日志 |
| `fallbackChain` | `[]` | 实际回退链 | 日志 |
| `sessionLock` | `'session_lock_implicit'` | 既有会话锁 | 日志 |
| `capabilityGap` | `'capability_gap_accepted'` / `null` | 同 | 适配层触发补偿 |
| `probes` | 探针原始三态（`ok`/`status`/`count`/`error`） | 同 | 诊断 |

内部 JS 用 camelCase；对外 wire / 日志按方案要求映射为 `tier` / `reason` / `matched_by` /
`final_system_prompt` 等 snake_case 键（映射集中在一处，不散落）。

### 3.4 提示词适配外显（层五，全量执行）

- `dynamicPromptAssembler.js:571` 与 `perRequestAdaptationPipeline.js:137` 的返回结果附加
  `matchedBy`（家族名 + 命中标签）与 `finalSystemPrompt`（最终拼装结果）。
- **单模型下不得打折**：适配依据是 family + 能力标签（`features.json:191`），不是候选集大小。
- 注册表无匹配 → 用唯一模型跑元提示生成片段；元提示也失败 → 用内置通用片段，
  并在 `explain.reason` 标注，**不抛错**。
- 能力缺口补偿沿用 `prompts.js:2398` 的既有 `<tool_call>` 教学注入，不另写第二份。

### 3.5 零硬编码落点

`modelRouter.js:239-245` 的 5 个模型名迁到 `config/models/routing.json` 的
`builtinRouteMap` 段；`modelRouter.js` 改为从 `input.routeMap` 注入读取，
env 覆盖优先级不变。**保留 `constants/models.js` 不动**——它是仓库刻意的单一真源
（文件头 `:3-18` 写明设计意图），把它改成配置文件是另一种形式的重写。

---

## 4. 实施分期（每期独立可回滚）

| 期 | 内容 | 独立验收 | 回滚方式 |
|---|---|---|---|
| **P0** | `modelAvailability.js` 纯叶子 + `node:test` 用例（覆盖 §1.4 四态） | `node --test tests/gateway/modelAvailability.test.js` 全绿 | 删新文件，零调用方 |
| **P1** | `resolveSingleModelRoute()` + `explain` 字段（可选参数注入，缺省走旧路径） | `tests/modelRouter.test.js` 仍 7/7；新用例断言单模型字段 | 撤掉调用方一处接线 |
| **P2** | 适配层输出外显 + telemetry 记录字段 | 对比「有适配 / 无适配」两次输出断言不同 | 撤掉外显字段，行为不变 |
| **P3** | `BUILTIN_MODEL_ROUTE_MAP` → `config/models/routing.json` | 路由决策回放逐条等价（`scripts/ci/route-replay.js`） | 恢复常量表 |

每期都用**可选参数**：`undefined` → 与旧行为逐字节相同，接线是纯增量。

---

## 5. 诚实边界（刻意不纳入，逐条给原因）

| 不纳入 | 原因 |
|---|---|
| performance/balanced/fast 三档统一 | 单模型直通按定义跳过档位阈值校验，**不依赖它**；仓库已有三套档位且 `[DESIGN-ARCH-185]` 有未落地的四档正式提案。此时引入第四套 = 新建并行真源，直接违反「不越改越差」。与 185 合并另案 |
| `/api/show` 探针 | 方案第九节自己要求「本地实测确认」；当前零实测数据，先取证再设计（§8） |
| 离线评测数据源 | 仓库无现成离线评测层，凭空造一个会变成假数据入口 |
| 用户反馈打通能力画像 | `models/Feedback.js` 仅 re-export，与 `modelFeatureRegistry.js:629` 内存覆盖未打通，属独立链路；本提案不借道 |
| 重写 `resolveModelRoute()` 为纯函数 | 它读 5 处 env 是既有契约，重写会破坏 7 条既有断言；单模型纯函数走外层包装 |
| 改 `constants/models.js` 为配置文件 | 它是刻意的单一真源（文件头写明意图），改成配置是另一种重写；真正违规的是 `modelRouter.js:239-245` |

---

## 6. 反模式（这条路别走）

| ❌ 别做 | 为什么 |
|---|---|
| 引入第四套档位命名 | `[DESIGN-ARCH-185]` §4.2 已给档位语义边界；并行新建会让「性能」同时指两个东西 |
| 把 `ok:false` 和 `models:[]` 合并成一个数字判定 | `Number(null)===0`：把「没测到」伪装成「测到 0 个」，告警与回退都会失真 |
| 单模型场景下跳过提示词适配 | 方案最高优先级红线；适配依据是 family + 标签，与候选数无关 |
| 能力缺口时拒绝服务或返回空 | 当事人的最高优先级要求；必须 `capability_gap_accepted` + 补偿 |
| 为「看起来纯函数」重写 `resolveModelRoute()` 本体 | 破坏既有 7 条断言与 env 覆盖语义；用外层包装 |
| 把 5 个模型名从 `modelRouter.js` 挪到另一个 `.js` 常量文件 | 那不是配置化，只是换个地方硬编码 |
| 在 `tests/modelRouter.test.js` 里追加 `node:test` 用例 | 会让一个文件被 jest 与 node --test 两套 runner 同时扫到；另建文件 |

---

## 7. 验收方式（可复现命令 + 关联门禁）

**基线（2026-11-16 实测，不是估的）**：

```
cd runtime/node/backend
node node_modules/jest/bin/jest.js tests/modelRouter.test.js --runInBand
→ Test Suites: 1 passed, 1 total / Tests: 7 passed, 7 total / exit=0（4.786s）
```

`tests/modelRouter.test.js:9` 是 jest 风格（`describe`/`test`/`expect`），**必须真 jest 跑**，
不能用 `node --test`（会 `ReferenceError: describe is not defined`）。

新增用例一律用 `require('node:test')` 写在**新文件**
（`tests/gateway/modelAvailability.test.js`）——`jest.config.js:25-80` 会按标记自动忽略，
不会造成双 runner。

| 判据 | 命令 / 操作 | 通过条件 |
|---|---|---|
| A1 单模型直通 | 注入 `availability={state:'single',modelIds:['X']}` | `explain.path==='single_model_bypass'`，`reason==='only_available_model'` |
| A2 默认回退 | 注入 `{state:'unprobed'}` + `defaultModelId` | `reason==='default_fallback'`，不抛、不空 |
| A3 适配不打折 | 单模型下对比有/无适配两次输出 | `finalSystemPrompt` 不同；缺口时含补偿段 |
| A4 既有不回归 | 上述 jest 命令 | 仍 `7 passed, 7 total` |
| A5 叶子契约 | `node scripts/ci/check-leaf-contract.js runtime/node/backend/src/services/gateway/modelAvailability.js` | `no violations found`（须显式传路径，否则报 "No target files found"） |
| A6 配置化等价 | `scripts/ci/route-replay.js` | P3 前后逐条等价 |
| A7 提案门禁 | `npm run check:proposal-index`、`npm run check:changed` | 不新增 finding |

> ⚠️ 本机 `check:file-ratchet` 整跑是**假通过**（base=HEAD~1，未提交改动看不见），
> 别拿它的 exit 0 当验收；按提案技能 §6.6 复刻算法做工作树 vs HEAD 对比。

### 7.1 提案自身门禁实测（2026-11-16）

| 检查 | 结果 | 归因 |
|---|---|---|
| `check-proposal-index.js` | exit 0 / **0 error** / 8 warning | 8 条全是 `[DESIGN-ARCH-105]` 行号漂移 + mapping-empty 历史映射，与本提案无关 |
| `check-repo-layout.js` | exit 1，但 `docs-index-complete` **1 → 0** | 首跑因本提案新文档漏就近索引而 +1；已在 `00_INDEX_DESIGN-ARCH-总目录.md` 登记 218 并回落到基线 0。剩余 4 类 error（root-whitelist 11 / root-shadow-dir 2 / root-junk 52 / layer-registry 6）均为既有仓库脏状态，本提案不碰 |

> 新增 DESIGN-ARCH 文档必须同步登记就近索引，否则 `check-repo-layout` 的
> `docs-index-complete` 会从基线 0 升到 1 并阻断（本提案已就地修复，未留给后续会话）。

---

## 8. 待核实项（优先项标明阻断什么）

| # | 待核实 | 阻断 | 归属 |
|---|---|---|---|
| U1 | `probeUpstreamModels()` 的各调用方是否都保留 `ok`/`status`/`error`（而非提前降成 `models[]`） | **阻断 P0 的信号设计** | P0 前 |
| U2 | 单 Key 服务商在 `/models` 返回 401/429 时的实际 body | 影响 `default_fallback` 的 reason 细粒度，不阻断 P0 | P1 |
| U3 | Ollama `/api/show` 真实响应结构（需本地起实例实测） | 阻断 `/api/show` 探针提案，本提案不做 | 另案 |
| U4 | 新增 `explain` 是否触发任务面棘轮（`[DESIGN-DELIV-002]` §4 命令/别名/规则数只降不升） | 阻断 P1 合入 | P1 前 |
| U5 | `dynamicPromptAssembler` 的输出对象是否被下游做严格 schema 校验 | 阻断 P2 的字段附加方式 | P2 前 |

---

## 9. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-11-16 | 初稿。实测核实六层现状、三套档位共存、四个第九节疑点；取编号 218；jest 基线 7/7。裁决档位统一另案，本提案聚焦单模型直通 + 可解释 + 零硬编码 |
| 2026-11-16 | 实施完成（P0–P3）。落盘：`src/services/gateway/modelAvailability.js`（纯叶子，9 用例）、`modelRouter.js` 外层包装 + explain + 配置注入（9 用例）、`dynamicPromptAssembler.js` / `perRequestAdaptationPipeline.js` 输出外显（4 用例）、`autoModelRouting.js` 决策日志 explain 白名单、`config/models/routing.json`（5 条内置路由，4 条等价用例）。验收：jest `modelRouter.test.js` 7/7；`check-leaf-contract` / `check-agent-rules` / `check-proposal-index` 零违规；`check-delivery-baseline` 0 error（棘轮 5 条 warning 为既有） |
| 2026-11-16 | 三处实施期实测修正（原提案描述与代码真实形态不符）：① §1.1 的 `telemetryService.js:408 selectRouteKey` 实为 HTTP 慢请求路由键，模型决策落盘真源在 `autoModelRouting.js:701 observeSelection`，explain 字段补在后者；② §3.4 `finalSystemPrompt` 为装配器产出的 system 适配段（= appendix），非完整 system prompt——装配器从不持有完整 system，不伪造；③ §7 A6 `route-replay` 本机 exit 0 但 3865 行样本零轮可 join（outcome 3532 行无 turnId），判据**不可执行**，属既有数据状态，非本次引入 |
| 2026-11-16 | 接线边界：`resolveSingleModelRoute()` 为**可选注入的外层包装**，未在 `proxyServer.js` 两处调用点强制接线——接线需要给请求热路径引入异步 `probeUpstreamModels()`，超出本提案「不改 toolUseLoopCore / replSession、不重写本体」的边界。单模型短路能力已可通过注入 availability 独立验收；生产接线另案 |
