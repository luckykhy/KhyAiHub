# [DESIGN-ARCH-162] Auto 模式模型粒度健康路由方案

<!-- RULES-REGISTRY: PROCESS-008, RUNTIME-002, RUNTIME-003 -->

> **状态**：已批准待实施（S1 观察者档起步，见 §6）
> **范围**：`services/backend/src/services/gateway/**` 的 auto 选型链路与成败记账路径。
> **不改** `toolUseLoopCore.js` / `replSession.js` / `toolUseLoop/*`（在途神文件重构线，任务 #7），
> 亦不改 `modelRouter.js` 的钉选（userPinned/strict）语义——钉选渠道绝不擅自换模型是既定红线。
> **上游依赖**：`autoModelSelect.js`（现成的模型粒度纯排序 `rankAutoModels`）、
> `_recordAdapterFailure` 的 `meta.model` 归因（已存在，见 §1 证据 E4）、
> `aiGateway.js` 的 `_probeCooldownUntil` 探活机制（复活用）。

## 0. 一句话结论

Auto 模式「总会路由到不能用的模型」的根因是**决策粒度与健康粒度双双停在 adapter 级**：
`autoSelectModel` 每次选的是渠道、落地的是该渠道的**默认模型**，模型从未被 auto 选过；
而「不能可用」恰恰多是**模型级**事实（默认模型 404 / 账号未开通 / 复合路由 id 漏到上游）。
本方案把 auto 收敛到 `(adapter, model)` 二元组：新增模型粒度健康账本 + 跨渠道候选池，
运行时按「渠道优先旧序 → 全局 rank」重排（用户裁决：跨渠道全局选模型），
失败级联沿同一 rank 顺序落到次优**二元组**而非次优渠道的默认模型。
全程按 `PROCESS-008` 走 S1 观察者档：先只记分歧样本，样本达标后一次性人工升 S2 生效。

## 1. 需求五问（RUNTIME-008 / 规则 6）

1. **谁用？** —— 用 auto 模式的终端用户：`/model` 里选「★ Auto」或 env
   `GATEWAY_PREFERRED_ADAPTER=auto` 的一切生成请求。（source: 用户原话「khyos的auto模式
   总会路由到不能用的模型，需要设计一个方案」）
2. **什么时候用？** —— 每次 AI 生成请求的选型时刻（gateway 热路径内），以及每次
   生成成功/失败后的记账时刻。入口不变（仍由既有 auto 哨兵触发），无新增用户入口。
3. **现在的替代做法是什么？** —— 用户手动 `/model` 挑一个能用的模型并钉住。这证明
   auto 已不可用：auto 存在的意义就是免除此手工动作。（source: 同上用户原话）
4. **成功长什么样？** —— 命令 + 期望输出，见 §7 验收判据 A1–A4。核心一条：
   auto 指向默认模型必 404 的渠道，第 1 次失败记账后，TTL 内第 2 次请求**不再出现该 404**，
   直接落到可用模型。（source: 用户批准方案时未对此提出异议，判据为本方案承诺）
5. **不做会怎样？** —— 用户每轮都撞同一堵墙：坏默认模型不进入任何记忆，
   排障指引（`modelNotFoundRecovery.js`）只能事后安慰；「两种失败都有」的用户
   （source: 用户答复「两种都有/不确定」）将同时被 404 与瞬时限流反复灼伤。

**方向性裁决（用户已确认，2026-09-26）**：

| 决定点 | 裁决 |
|---|---|
| 选模型策略 | **跨渠道全局选模型**（(adapter,model) 统一候选池排序，非「渠道内选模型」） |
| 候选列表来源 | **init 后台异步刷 + TTL 惰性缓存**（未就绪渠道退化为默认模型 + `source:'hint'`） |
| 失败形态分布 | 404/未开通与鉴权/限流/超时**两类都有** → 账本必须 permanent/transient 分计 |

## 2. 根因：粒度错配（证据链）

| # | 证据（file:line） | 说明 |
|---|---|---|
| E1 | `aiGatewayModelMethods.js:106-259` | `autoSelectModel` 全部排序在 **adapter 粒度**；除 user_preference 分支外**所有分支返回 `model: null`** |
| E2 | `aiGatewayGenerateMethod.js:2638-2648` | auto 消费点：`model: null` → `options.model` 原样 → 实际送出**该 adapter 的默认模型**。auto 从未在模型粒度上做过选择 |
| E3 | `autoModelSelect.js:29-32`（头部「诚实边界」） | 代码自认：模型粒度排序 `rankAutoModels` 只用于 /model 选择器预览，「运行时逐请求把 auto 收敛到具体模型 id……**留作后续**」。卡点：热路径无按 adapter 的模型枚举缓存（catalog 的 provider 是 poolKey 而非 adapter key） |
| E4 | `aiGatewayGenerateMethod.js:3629-3650` | fast-fail 冷却按 adapter 键控，`model_not_found` 是模型级错误 → 已打「按模型放行」补丁（`modelNotFoundCooldownScope`），且仅对视觉 describe 透传放行。**补丁本身即粒度错配的症状** |
| E5 | `aiGateway.js:349`（`GATEWAY_MODEL_NOT_FOUND_COOLDOWN_MS`≈30s） | model_not_found 冷却记在**渠道**头上：一个坏默认模型污染整渠道 30s，同渠道其它好模型被误伤 |
| E6 | `autoSelectModel` 的 available 判据 = `detect()`（二进制/凭据存在） | 「渠道活着」≠「模型能响应」。坏默认模型渠道恒排首位 → 每轮先撞它再级联，用户体感「auto 总路由到不能用的模型」 |

**失败闭环形态**（E1+E2+E5+E6 叠加）：

```
auto → 选渠道 A（detect 通过，无模型级信息）→ 送 A 的默认模型 m_bad
     → 404 model_not_found → 冷却记在 A 头上 30s → 级联撞墙或降级
     → 30s 后一切照旧，下轮重复。m_bad 从未被任何记忆标记。
```

## 3. 设计：两个新单元 + 一处消费

### 3.1 `modelHealthLedger.js` —— 纯叶子（零 IO、确定性、绝不抛）

- key：`<adapterLower>|<modelTrimLower>`。值：`{ class, errorType, until, score }`。
- errorType 二分（对应 §1 裁决 3）：
  - **permanent**：`model_not_found`、账号未开通/未领取类 404/403-on-model、
    复合 id 漏上游被 `classifyModelNameShape` 判 composite/prefixed 的送出串
    （复用 `modelNotFoundRecovery.js:122` 的形状判定，不重造正则）。
    → 记 `broken`，TTL 默认 30 分钟（env 可覆盖，走 gatewayConstants 惯例）。
  - **transient**：`rate_limit`(429)、`timeout`、`network`、`5xx` → **软降权分**，
    按滑动窗口衰减，**绝不**产生「跳过该模型」的硬决定（一次 429 打入冷宫即误报）。
- 判定纯函数面：`classifyFailure(errorType, message, modelShape) → 'permanent'|'transient'|'ignore'`、
  `applyRecord(ledgerState, {key, class, now, ttlMs}) → newState`、
  `filterBroken(ledgerState, candidates, now) → candidates'`、`penalize(ledgerState, candidates)`。
  时钟/随机不进叶子——`now` 由 IO 壳传入，保持确定性可测。
- 门控 `KHY_AUTO_MODEL_HEALTH_AWARE`（flagRegistry，CANON off-words）；
  关 = 一切函数按「空账本」短路，调用方逐字节回退现状。

### 3.2 `autoModelRouting.js` —— IO 壳（候选池 + 双写 + 探活复活）

- **候选池**：gateway `initialize()` 完成后，对每个 `enabled && available` 的 adapter
  异步（不 await、失败静默）调既有 `adapter.listModels()`（apiAdapter/claudeAdapter/
  codexAdapter/cursorAdapter/kiroAdapter/ollamaAdapter/localLLMAdapter/… 均已实现），
  归一成 `{ adapter, model, tier, capability, source:'remote' }` 入进程内缓存。
  - TTL 默认 10 分钟惰性重刷（读取时过期才触发后台刷新，不阻塞热路径）。
  - 单 adapter 枚举失败 → 只丢该渠道候选，退化为 `{ adapter, defaultModel, source:'hint' }`
    ——`rankAutoModels` 的来源权重（remote > config > hint）天然让「猜的」排在「真通告」后。
  - poolKey→adapter 映射：复用 `modelRouter.js:5-28` 的 `DEFAULT_PREFIX_TO_ADAPTER`
    反查 + 自定义 provider 路由表（`PROXY_MODEL_ROUTE_MAP`）的 target 头段。解掉 E3 卡点。
- **双写**：挂在既有记账点——成功路径与 `_recordAdapterFailure`（其 `meta.model` 已透传
  实际送出模型串，见 E4）各加一次 `ledger.record(adapter, meta.model, outcome)`。
  既有 adapter 级冷却/健康**原样保留**（非 auto 路径仍在消费），账本只做增量。
- **复活**：`broken` 到期不立即解禁，交后台探活（复用 `_probeCooldownUntil` 的
  冷却-跳过-重试形态，`aiGatewayRoutingMethods.js:1846` 附近），探活成功 → 清 broken；
  失败 → 顺延 TTL 并累加「连续 broken 轮次」，≥3 轮 → 整渠道模型全灭时该 adapter
  在候选池中整体降权（此时才影响渠道级排序，替代现状的误伤式渠道冷却）。

### 3.3 运行时消费：auto 分支重排（核心变更点）

`aiGatewayGenerateMethod.js:2638`（`preferredAdapter === 'auto'` 分支）改为：

```
ranked = autoModelRouting.rank(taskType, options)
       = rankAutoModels(taskType, pool − broken − 渠道级disabled/cooldown, { taskScale })
if (ranked[0]):
    options.model            = ranked[0].model      // ← 首次，auto 收敛到模型 id
    orderedAdapters          = 按 ranked 顺序生成 adapter 序列（同渠道多模型自然聚堆）
    cascade 的 fallback 顺序 = ranked 剩余项        // 次优=次优二元组，非次优渠道默认模型
else: 池未就绪/全灭 → 逐字节走今日 autoSelectModel 旧路径
```

- `userPinned` / strict 钉选**不进本逻辑**（范围红线）。
- 状态行按 RUNTIME-002「动作+目标+进度」：
  `自动选型: <adapter>/<model>（已跳过 2 个失效模型: x(404), y(未开通)）`——
  跳过必须点名，不许含糊。

## 4. 兼容 / 回退矩阵

| 场景 | 行为 |
|---|---|
| `KHY_AUTO_MODEL_HEALTH_AWARE=0` | 候选池不建、账本不写、auto 分支短路回旧 `autoSelectModel`，逐字节回退 |
| 池未就绪（冷启动头几秒） | 同上旧路径，不阻塞首请求 |
| 单渠道 listModels 失败 | 该渠道退 hint 一条，其余渠道正常 |
| 钉选/strict 请求 | 完全不感知本方案 |
| 非 auto 路径的既有冷却 | 不动（账本是增量读者，不是替代者） |

## 5. 红线自查（对照 AGENTS.md 工程规则）

- **RUNTIME-001**：TTL/冷却时长全部 env 化 + gatewayConstants 单源，无新硬编码端点。
- **RUNTIME-002**：跳过/降权状态行点名模型与原因（§3.3）。
- **RUNTIME-003**：探活与刷新全部后台/惰性，**无**对活跃请求的固定硬 kill；
  listModels 单次调用带既有 3s 超时形态（`aiGatewayRoutingMethods.js:1799` 同源）。
- **PROCESS-010**：架构决策由用户三裁决点驱动（§1 表），AI 实现，人验收。

## 6. 落地阶段（PROCESS-008，登记 `FEATURE-OWNERSHIP.json`）

| 阶段 | 内容 | 毕业条件 |
|---|---|---|
| **S1 观察者**（首版） | 实际路由**照旧**；后台并行算 `ranked[0]`，落盘分歧样本：「旧选了 (A,m_bad) 且失败 / 新会选 (B,m_ok)」至 `.khy/ruleguard/auto-route.jsonl`。账本双写**真实生效**（只写不读路由） | ≥200 样本且无解释不了的样本 |
| S2 顾问 | 状态行提示「auto 会改选 X」，路由照旧 | ≥50 提示、误报 <10% |
| S3 门禁（生效） | §3.3 全量生效 | ≥20 次真实跳过、豁免率 <20% |

升档是人的决定；每档回滚 = 一个 env（门关即回退）。守卫侧只需在登记表留
`stage/samples/rollback/executorStage` 字段，本机制非拦截型 gate，由
`check-rollout-stage.js` 覆盖率兜住登记漂移。

## 7. 验收判据

- **A1**（主诉复诊）：auto 指向默认模型必 404 的渠道 → 第 1 次失败并记账；
  TTL 内第 2 次请求不再出现该 404，直落可用模型，状态行点名跳过原因。
  （S3 档后测；S1 档以分歧样本账本可回放为验收）
- **A2**：一次 429 后该模型仍可被选（transient 只降权不拉黑）。
- **A3**：`adapter/model` 显式钉选行为**逐字节不变**（既有 router 测试全绿）。
- **A4**：`KHY_AUTO_MODEL_HEALTH_AWARE=0` 时 auto 路径输出与改前逐字节一致。
- **A5**：纯叶子单测（classify/apply/filter/penalize 零 IO、确定性、绝不抛）；
  IO 壳用注入时钟测 TTL/复活。

## 8. 涉及文件清单

| 动作 | 文件 |
|---|---|
| 新增（纯叶子） | `services/backend/src/services/gateway/modelHealthLedger.js` |
| 新增（IO 壳） | `services/backend/src/services/gateway/autoModelRouting.js` |
| 改（auto 分支消费 + 双写挂点） | `services/backend/src/services/gateway/aiGatewayGenerateMethod.js` |
| 改（旧边界注释订正，删「留作后续」） | `services/backend/src/services/gateway/autoModelSelect.js` |
| 登记 | `services/backend/src/services/flagRegistry.js`、`docs/10_规范/registry/FEATURE-OWNERSHIP.json`、`docs/10_规范/registry/RULES-REGISTRY.json` |
| 测试 | `tests/` 两叶子单测 + auto 路由集成用例（A1–A4 各一） |
