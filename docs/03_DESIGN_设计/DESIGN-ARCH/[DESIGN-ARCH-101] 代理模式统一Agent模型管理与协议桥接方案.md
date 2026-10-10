<!-- IMPL-STATUS: done -->
# [DESIGN-ARCH-101] 代理模式统一 Agent 模型管理与协议桥接方案

> 状态：**已实施（2026-09-24；步骤 1–4 落地，步骤 5 协议桥接复用既有 proxyServer 未改代码）** · 2026-09-24
> 实施说明：本方案按 §8 文件改动清单落地。核心新增 `proxyAccess.js`（端点/令牌/poolKey 解析）、
> `traeAppAdapter.js`（switch-chain 桥接）；`appWriters.applyCardToApp` 加 `mode:'proxy'` 分支
> （走 `buildProxyCard` 字段替换复用适配器 add()，适配器零侵入），并接线 4 个存量适配器 + Trae。
> provider-hub 侧透传 mode + 工具矩阵加代理/直连切换。验收：backend 78 测试 + provider-hub 36 测试全绿，
> check:wiring / check:rules / check:gov-rules 全绿。
> 上位文档：`AGENTS.md`（工程红线）、[`[DESIGN-ARCH-094]`](./[DESIGN-ARCH-094]%20Provider卡片枢纽（CardHub）GUI设计规范.md) ProviderHub GUI 设计规范、`[DESIGN-ARCH-071]` 通道选择决策矩阵
> 关联实测：`D:\Portable\AI模型配置汇总.md`（本机 16 个 agent 配置位置与协议实测）、`[DESIGN-ARCH-118]` HQ 能力吸收与多机协作规范

<!-- RULES-REGISTRY: RUNTIME-001, RUNTIME-002, RUNTIME-003, PROCESS-008 -->

---

## 1. 背景与问题

### 1.1 现状

khy-os 已有两层合一的统一管理基础设施（汇总文档 §8.1 / §8.6 实测确认）：

- **层 A（代理网关）**：`services/backend/src/services/gateway/proxyServer.js`（3103 行）暴露四协议端点（OpenAI Chat / Anthropic Messages / Gemini / Codex Responses），端口默认 9100，含端口冲突自动探测、CORS、客户配额执行器、响应缓存。
- **层 B（agent 配置写入）**：`services/backend/src/services/domain/config/ccSwitch/appWriters.js`（250 行）通过 7 个 `externalApps/` 适配器写各 agent 的 live 配置文件。
- **provider-hub GUI**：`apps/provider-hub/`（Electron + vanilla JS，DESIGN-ARCH-094 M0–M3 + P3 已落地），管理 `cc_switch.json` 卡片库 + `api_keys.json` 密钥池。

### 1.2 三个待解问题

| # | 问题 | 根因 |
|---|------|------|
| 1 | "通过符号链接或 junction 聚合在 khy-os 中"——跨 agent 配置能否靠 junction 共享 | junction 是目录级重定向，集中的是**数据落点**不是**配置内容**；不同 agent 的配置 schema 互不兼容，无法共享同一文件 |
| 2 | "opencode 配置某个模型后 opencode 能用，zcode 同样能用"——一处配置多 agent 共享 | 现有 `appWriters` 只做**直连模式**（写 `card.baseUrl` + 真实 key），每 agent 各存一份密钥直连 provider；需要**代理模式**让所有 agent 指向同一代理端点 |
| 3 | "Claude Code 只支持 anthropic 协议，OpenAI chat 或 responses 协议怎么接入" | khy 代理的 `handleMultiProtocol` **已实现** Anthropic↔OpenAI 双向协议转换（源码验证见 §4），但 `appWriters` 未把 Claude Code 的配置写成指向代理——需要代理模式接入 |

### 1.3 已有但未接线的资产

- `cc_switch.json` 的 `agentMode` 字段（`types.ts` 第 24–27 行 `AgentModeEntry = { mode: 'proxy' | 'direct', cardId, ts }`）——代理/直连双模式已在类型层定义，但 `appWriters.js` 只实现了 direct，proxy 分支未写。
- `externalApps/` 目录下 `deepseekTuiAdapter.js`、`reasonixAdapter.js`、`openclawAdapter.js`、`cozeAdapter.js` 四个适配器文件已存在，但 `appWriters.js` 的 switch 无对应 case——接线即生效。
- Trae 的配置写入由 `proxySwitchProfiles.js`（switch-center，trae-only）负责，但未纳入 `appWriters` 统一矩阵。

---

## 2. 聚合机制判断：Junction vs 代理

### 2.1 Junction 能做的——数据家目录集中化（已完成）

汇总文档 §7 / §7.8 已实测确认本机以下 junction 到位：

| Junction | 声明路径 | 真实位置 | 作用 |
|---|---|---|---|
| `~/.khy` | `C:\Users\25789\.khy` | 便携根 `.khy` | khy CLI / khyos-desktop / provider-hub 三方共享同一份 `cc_switch.json` + `api_keys.json` |
| `~/.zcode` | `C:\Users\25789\.zcode` | `D:\zcode-home` | ZCode 数据家目录重定向到便携位置 |
| `~/.khyquant` | `C:\Users\25789\.khyquant` | `C:\.khyquant` | khyquant 运行时数据集中 |
| `~/.gradle` | `C:\Users\25789\.gradle` | `D:\GradleHome` | Gradle 缓存重定向 |

**junction 的本质**：把一个目录的物理存储搬到别处，让"声明路径"与"真实路径"分离。它集中的是**数据落点**——让多个工具读同一份文件，但文件内容的格式由各自的 schema 决定。

**对统一管理的贡献**：`~/.khy` junction 保证 provider-hub 改一张卡片后，khy CLI 和 khyos-desktop 重启即见——三方不锁死、不各存一份。这是**同体系内**的共享。

### 2.2 Junction 不能做的——跨 agent 配置内容共享

| 想法 | 为什么不行 | 证据 |
|---|---|---|
| 让 opencode 的 `opencode.json` 与 zcode 的 `config.json` 共享同一物理文件 | **格式不同**：opencode 用 provider 树 `{provider:{baseURL,apiKey,model}}`；zcode 用 `provider.zai` 单槽位 + `model.main/lite` 双角色 | 汇总文档 §1.3 vs §1.1；`appWriters.js` 第 144–152 行 vs 第 183–193 行 |
| junction 单个配置文件 | Windows junction 是**目录级**（`IO_REPARSE_TAG_MOUNT_POINT` `0xa0000003`），不支持单文件 | 汇总文档 §7.3 重解析点类型表 |
| symlink 单文件 | symlink 支持文件但需管理员权限或开发者模式；且 agent 启动时可能删重建文件导致断链 | 汇总文档 §7.2 第 4 条 `ResolveLinkTarget()` 限制 |
| junction 整个 `~/.config/opencode/` 进 khy | opencode 目录里还有 cache/skills/sessions 等 khy 不该管的状态；junction 整棵树会让 khy 承担不属于它的子目录 | 汇总文档 §7.2 第 6 条"只解析根不够，必须递归" |

### 2.3 结论

**Junction 负责"数据家目录在哪"，代理负责"模型配置怎么共享"。两者互补，不可互替。**

- junction = 同体系内（khy 三工具）共享数据落点 → **已完成**
- 代理 = 跨体系（opencode / zcode / Claude Code 等异构 agent）共享模型与密钥 → **待实现（本方案）**

---

## 3. 代理模式架构

### 3.1 核心拓扑

```
                    ┌───────────────────────────────────────────┐
                    │  khy 代理服务器（:9100，proxyServer.js）       │
                    │                                           │
                    │  持有全部 provider 密钥（api_keys.json 池）    │
                    │  聚合全部模型（GET /v1/models）              │
                    │  四协议端点：                               │
                    │    POST /v1/chat/completions   (OpenAI)    │
                    │    POST /v1/messages          (Anthropic)  │
                    │    POST /v1/responses         (Codex)      │
                    │    POST /v1beta/.../generateContent(Gemini) │
                    │  协议互转（protocolConverter）               │
                    │  故障转移 + 级联 + 用量统计                  │
                    └───────────┬───────────────────────────────┘
                                │ 所有 agent 指向同一端点 + 同一令牌
              ┌─────────────────┼─────────────────────┐
              ▼                 ▼                     ▼
        opencode            zcode               Claude Code
   baseUrl=代理:9100/v1  endpoint=代理:9100/v1  ANTHROPIC_BASE_URL=代理:9100
   apiKey=代理令牌        key=代理令牌           ANTHROPIC_API_KEY=代理令牌
   model=api:ds:chat      model=api:ds:chat      ANTHROPIC_MODEL=api:ds:chat
   (说 OpenAI 协议)        (说 OpenAI 协议)        (说 Anthropic 协议)
```

### 3.2 代理端点与令牌的发现（零硬编码）

复用 provider-hub 已有的 `proxyStatus.ts`（`apps/provider-hub/src/main/proxyStatus.ts`）模式：

| 数据 | 来源 | 已有实现 |
|---|---|---|
| 代理端点 | dataHome 下 `proxy_server_runtime.json` | `proxyStatus.ts` 第 22–45 行 `proxyStatus()` |
| 代理令牌 | dataHome 下 `proxy_server_auth.json` | 代理启动时自动生成 `khy-<48hex>`（`proxyServer.js` 第 482–770 行 auth 段） |
| dataHome 解析 | 四级顺序：`KHY_DATA_HOME` env → 便携根 → `.portable` 标记上溯 → `os.homedir()/.khy` | `providers.ts` 第 25–49 行 `getDataHome()` |

**合规**：端点 + 令牌全来自运行时文件 / env，不写死 host:port（契约 C4 / 规则 1 `RUNTIME-001`）。

### 3.3 可路由模型名

代理的 `modelRouter.resolveModelRoute`（`proxyServer.js` 第 1215 / 1483 行）支持以下模型名格式：

| 格式 | 示例 | 路由目标 |
|---|---|---|
| `api:<poolKey>:<model>` | `api:deepseek:deepseek-chat` | `apiAdapter` → `api_keys.json` 池中 poolKey 对应的密钥 → 上游 OpenAI 端点 |
| `adapter/model` | `api/deepseek-chat` | 指定适配器 + 模型 |
| 裸模型名 | `deepseek-chat` | 经 `PROXY_MODEL_ROUTE_MAP` / `GATEWAY_API_POOL_DEFAULT_MODEL_MAP` 映射 |

**代理模式写入时用 `api:<poolKey>:<defaultModel>` 三段格式**——始终可路由，不依赖路由表条目是否存在。

---

## 4. Claude Code 协议桥接（已验证可用）

### 4.1 问题

Claude Code 只发 Anthropic `/v1/messages` 请求。如果上游是 OpenAI Chat（DeepSeek）或 Responses（Codex）协议的 provider，直连模式不可能接入——协议不匹配。

### 4.2 答案

khy 代理已实现完整的协议互转。以下结论全部来自源码逐行验证。

### 4.3 已验证的转换链路

```
Claude Code
  │ POST /v1/messages（Anthropic 格式，model="api:deepseek:deepseek-chat"）
  ▼
handleMultiProtocol(req, res, PROTOCOLS.ANTHROPIC)          [proxyServer.js:1385]
  │
  ├─ protocolConverter.convertRequest(body, ANTHROPIC)       [行 1412]
  │    Anthropic 请求体 → canonical 内部格式
  │    提取 messages / system / tools / images / metadata
  │
  ├─ modelRouter.resolveModelRoute({model:"api:deepseek:..."})  [行 1483]
  │    → 路由到 apiAdapter（OpenAI 格式上游）
  │
  ├─ Anthropic 协议特殊处理                                   [行 1490-1495]
  │    非显式路由时 strictPreferred=false → 允许级联到任意适配器
  │    （不只 claude 适配器；deepseek/glm 等都能接）
  │
  ├─ generateByRoute(gw, route, prompt, {onChunk})           [行 1259 / 1658]
  │    → gateway.generate() → apiAdapter → DeepSeek API（OpenAI Chat 格式）
  │    → DeepSeek 返回 OpenAI 格式响应 → 适配器归一化为 chunks
  │
  └─ onChunk 回调：normalized chunks → Anthropic SSE 事件    [行 1716-1733]
       message_start → ping → content_block_start → 
       content_block_delta(text) → content_block_stop →
       message_delta(usage) → message_stop
       → Claude Code 收到 Anthropic 格式 SSE 流 → 正常工作 ✓
```

### 4.4 关键源码证据

| 断言 | 源码位置 | 原文 / 行为 |
|---|---|---|
| 函数存在且注释明确 | `proxyServer.js` 第 1382–1383 行 | 注释原文："Handle multi-protocol requests — converts input protocol to canonical, generates via gateway, then converts response back to source protocol." |
| 入站协议→canonical | 第 1412 行 | `const { canonical, detectedProtocol } = protocolConverter.convertRequest(body, sourceProtocol);` |
| 路由到任意适配器 | 第 1483 行 | `const route = modelRouter.resolveModelRoute({ model: canonical.model \|\| null });` |
| Anthropic 允许级联 | 第 1490–1495 行 | `if (sourceProtocol === PROTOCOLS.ANTHROPIC) { if (routeSource !== 'explicit' && routeSource !== 'route-map') { route.strictPreferred = false; route.preferredAdapter = null; } }` |
| 出站 chunks→Anthropic SSE | 第 1716–1733 行 | `if (isAnthropic) { sseEvent('message_start', {...}); sseEvent('ping', {...}); }` |
| 路由分发确认 | 第 2889–2937 行 | `pathname === '/v1/messages' → handleMultiProtocol(req, res, PROTOCOLS.ANTHROPIC)` |
| WebSearch 服务端工具拦截 | 第 1389–1410 行 | Claude Code 的 web_search 子请求被专用拦截器处理，避免非 Anthropic 后端死循环 |
| tool_use/tool_result 配对修复 | 第 1558–1565 行 | `_repairToolUsePairing(repairedRawMessages)` 修复中断的 tool 会话 |

### 4.5 四种协议全覆盖

| 入站协议 | 端点 | 上游可以是 | 转换方向 |
|---|---|---|---|
| Anthropic | `POST /v1/messages` | OpenAI / Gemini / Codex / 任意 | Anthropic→canonical→任意适配器→Anthropic SSE |
| OpenAI Chat | `POST /v1/chat/completions` | Anthropic / Gemini / Codex / 任意 | OpenAI→canonical→任意适配器→OpenAI SSE |
| Codex Responses | `POST /v1/responses` | OpenAI / Anthropic / 任意 | Responses→canonical→任意适配器→Responses SSE |
| Gemini | `POST /v1beta/models/{model}:generateContent` | OpenAI / Anthropic / 任意 | Gemini→canonical→任意适配器→Gemini SSE |

**结论**：Claude Code 经代理能用任意协议的上游模型，**无需额外开发**——代理已实现。只需在 `appWriters` 里把 Claude Code 的配置写成指向代理（代理模式），而非直写 provider 端点（直连模式）。

### 4.6 Anthropic 直通优化（不经过 parse→reconstruct）

当入站 Anthropic 且目标也是 claude 适配器（Anthropic 上游）时，代理有 SSE 原样透传路径（`proxyServer.js` 第 1644–1648 行 `isAnthropicPassthrough`），跳过 parse→reconstruct 链路降低延迟。此路径仅在 claude 适配器可用时生效；OpenAI 上游走正常转换链路。

---

## 5. 一处配置多 agent 共享的完整流程

### 5.1 场景

用户有一张 DeepSeek 卡片（key + endpoint + models）。想让 opencode、zcode、Claude Code 三个 agent 都能用 DeepSeek 的 `deepseek-chat` 模型。

### 5.2 流程（代理模式）

```
步骤 1：添加卡片（一次性）
  用户在 provider-hub 添加 DeepSeek 卡片
  → card 存入 cc_switch.json（含 baseUrl / keyId / models / defaultModel）
  → 密钥存入 api_keys.json 池（provider="deepseek", key=真实密钥）
  → 代理的 apiAdapter 从同一 api_keys.json 池读密钥
  → 代理现在能路由到 DeepSeek（GET /v1/models 会列出 api/deepseek-chat）

步骤 2：应用到 opencode（代理模式）
  tools:apply(app="opencode", cardId=卡片ID, mode="proxy")
  → appWriters.applyCardToApp(card, "opencode", {mode:"proxy"})
  → resolveProxyAccess() → 读 proxy_server_runtime.json 得 endpoint=http://127.0.0.1:9100
                          → 读 proxy_server_auth.json 得 token=khy-<48hex>
  → resolvePoolKeyFromCard(card) → 扫 api_keys.json 得 poolKey="deepseek"
  → 写 ~/.config/opencode/opencode.json:
      provider.khy_proxy.baseURL = "http://127.0.0.1:9100/v1"
      provider.khy_proxy.apiKey  = "khy-<48hex>"        ← 代理令牌，非 DeepSeek 真实 key
      model                      = "api:deepseek:deepseek-chat"
  → agentMode["opencode"] = {mode:"proxy", cardId, ts}

步骤 3：应用到 zcode（代理模式，同一张卡）
  → 写 ~/.zcode/cli/config.json:
      provider.zai.endpoint = "http://127.0.0.1:9100/v1"
      provider.zai.key      = "khy-<48hex>"
      model.main            = "api:deepseek:deepseek-chat"
  → agentMode["zcode"] = {mode:"proxy", cardId, ts}

步骤 4：应用到 Claude Code（代理模式，同一张卡）
  → 写 ~/.claude/settings.json env block:
      ANTHROPIC_BASE_URL = "http://127.0.0.1:9100"      ← 不带 /v1，CC 自己拼 /v1/messages
      ANTHROPIC_API_KEY  = "khy-<48hex>"
      ANTHROPIC_MODEL    = "api:deepseek:deepseek-chat"
  → agentMode["claude-code"] = {mode:"proxy", cardId, ts}

结果：
  opencode → POST 代理/v1/chat/completions（OpenAI）→ 代理路由到 DeepSeek → OpenAI SSE 回
  zcode    → POST 代理/v1/chat/completions（OpenAI）→ 同上
  CC       → POST 代理/v1/messages（Anthropic）→ 代理转 OpenAI → DeepSeek → 转回 Anthropic SSE
  
  三个 agent 用同一张卡、同一份密钥（在代理池里）、同一端点。
  DeepSeek 真实密钥只在 api_keys.json 池里，agent 配置文件里只有代理令牌。
```

### 5.3 各 agent 代理模式写入差异

| Agent | 写入文件 | 代理端点字段 | 令牌字段 | 模型字段 | 协议桥接 |
|---|---|---|---|---|---|
| Claude Code | `~/.claude/settings.json` env | `ANTHROPIC_BASE_URL` | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` | Anthropic→OpenAI（代理转） |
| Codex | `~/.codex/config.toml` | `base_url` | `env_key` 引用 | `model` | Responses→OpenAI（代理转） |
| opencode | `~/.config/opencode/opencode.json` | `provider.baseURL` | `provider.apiKey` | `model` | OpenAI→OpenAI（直通） |
| zcode | `~/.zcode/cli/config.json` | `provider.zai.endpoint` | `provider.zai.key` | `model.main` | OpenAI→OpenAI（直通） |
| ycode | `~/.ycode/config.json` | `endpoint` | `api_key_env` 引用 | `active_model_id` | OpenAI→OpenAI（直通） |
| gemini | `~/.gemini/settings.json` env | `GOOGLE_GEMINI_BASE_URL` | `GEMINI_API_KEY` | `GEMINI_MODEL` | Gemini→OpenAI（代理转） |
| command-code | `~/.commandcode/providers.json` | `endpoint` | env 引用 `$KHY_CC_SWITCH_*` | `config.json model` | 按卡片协议选端点 |

---

## 6. 直连 vs 代理模式对比

| 维度 | 直连模式（现有） | 代理模式（本方案新增） |
|---|---|---|
| agent 持有的密钥 | provider 真实 key | 代理令牌（`khy-<48hex>`，非 provider key） |
| 协议 | 必须与上游一致（CC 只能接 Anthropic provider） | 任意（代理翻译） |
| 一处配置多 agent | 能（同一卡应用到 N agent），但各存真实 key | 能，且 agent 不存真实 key |
| 故障转移 | 无（单 provider 挂了就挂了） | 有（代理级联 + failover 队列） |
| 用量统计 | 各 agent 各自记账 | 代理统一记账（`token_usage.json`） |
| 密钥轮换 | 改 N 个 agent 配置 | 改池一处，所有 agent 自动生效 |
| 代理依赖 | 无（agent 直连 provider） | 代理必须在跑（`:9100`） |
| Claude Code + OpenAI provider | **不可能**（协议不匹配） | **可能**（代理翻译） |
| 端点迁移 | 改 N 个 agent 配置 | 改代理一处 |

**默认推荐代理模式**——它解决了核心问题（Claude Code 用 OpenAI 模型 + 一处配置多 agent 共享 + 密钥不外泄）。直连模式保留为 fallback（代理未运行时用）。

---

## 7. 落地步骤（✓ 2026-09-24 已实施）

### 步骤 1：在 appWriters 实现代理模式写入（核心改动）

**现状**：`appWriters.js` 的 `applyCardToApp(card, app, opts)` 只做直连模式——写 `card.baseUrl` + 真实密钥。`cc_switch.json` 的 `agentMode` 字段已在类型层定义（`types.ts` 第 24–27 行）但未接线。

**改动**：

```
appWriters.applyCardToApp(card, app, opts) 加 mode 参数：
  - opts.mode = 'direct'（现有逻辑不变）
  - opts.mode = 'proxy'（新增）：
      1. resolveProxyAccess() → 读 runtime + auth 文件得 endpoint + token
      2. resolvePoolKeyFromCard(card) → 扫 api_keys.json 得 poolKey
      3. 构造 routableModel = `api:${poolKey}:${card.defaultModel}`
      4. 调对应 agent 适配器的代理模式写入（写代理端点 + 令牌 + routableModel）
      5. 成功后 store 记 agentMode[app] = {mode:'proxy', cardId, ts}
```

代理模式写入要复用各 `externalApps/` 适配器的 `add()` 方法，但传入代理端点 + 令牌而非 card.baseUrl + 真实 key。两种方式：
- (a) 给每个适配器的 `add()` 加代理模式参数（侵入性中等，接口统一）
- (b) 在 `appWriters` 层构造一个"代理卡片"（把 card.baseUrl 替换成代理端点、key 替换成令牌、model 替换成 routableModel），复用现有 `add()` 不改适配器（侵入性最低）

**推荐 (b)**：在 `appWriters` 层做字段替换，适配器零改动。代理卡片构造：

```javascript
// 伪代码（方案级，不执行）
function buildProxyCard(card, { proxyEndpoint, proxyToken, routableModel }) {
  return {
    ...card,
    baseUrl: proxyEndpoint,        // 替换为代理端点
    // key 在 applyCardToApp 调用时通过 opts.key 传入代理令牌
    defaultModel: routableModel,   // 替换为可路由模型名
  }
}
```

### 步骤 2：新建 proxyAccess 模块（代理端点 + 令牌 + poolKey 解析）

```
services/backend/src/services/domain/config/ccSwitch/proxyAccess.js（新建）
  - resolveProxyAccess(): 
      读 dataHome/proxy_server_runtime.json 得 endpoint
      读 dataHome/proxy_server_auth.json 得 token
      代理未运行 → 返回 {proxyEndpoint:'', error:'代理未运行…'}（状态透明）
  - resolvePoolKeyFromCard(card):
      读 dataHome/api_keys.json，扫各 provider 的 entries，
      找 keyIdFor(provider, entry.key) === card.keyId 的 provider 名
      未找到 → 回退用 card.name.toLowerCase() 作 poolKey
```

### 步骤 3：provider-hub UI 加代理/直连切换

| 文件 | 改动 |
|---|---|
| `src/main/ipc.ts` | `tools:apply` handler 透传 `mode` 参数 |
| `src/main/toolWriters.ts` | `applyCardToTool(app, card, {key, mode})` 透传 mode |
| `src/preload/index.ts` | `tools.apply(app, cardId, mode?)` 签名扩展 |
| `src/renderer/app.js` | 工具矩阵每行加代理/直连单选；默认代理模式 |
| `src/renderer/index.html` | 工具矩阵行加 mode 切换控件 |

### 步骤 4：接入已有但未连线的适配器 + Trae（与代理模式独立，可并行）

| 适配器 | 状态 | 接入方式 |
|---|---|---|
| `deepseekTuiAdapter.js` | 文件已存在，switch 缺 case | `appWriters.js` 加 `case APPS.DEEPSEEK_TUI` |
| `reasonixAdapter.js` | 文件已存在，switch 缺 case | 加 `case APPS.REASONIX` |
| `openclawAdapter.js` | 文件已存在，switch 缺 case | 加 `case APPS.OPENCLAW` |
| `cozeAdapter.js` | 文件已存在，switch 缺 case | 加 `case APPS.COZE` |
| Trae | `proxySwitchProfiles.js` 有写入能力，未纳入矩阵 | 新建 `externalApps/traeAppAdapter.js` 桥接适配器，`add()/list()` 委托 switch-center 的 `use/list` 动作 |

### 步骤 5：验证协议桥接（不改代码，只验证）

代理模式接线后，验证三种跨协议场景：

| 场景 | Agent 协议 | 上游协议 | 代理端点 | 预期 |
|---|---|---|---|---|
| Claude Code → DeepSeek | Anthropic | OpenAI Chat | `/v1/messages` → 转 → DeepSeek | CC 收到 Anthropic SSE ✓ |
| Claude Code → GLM | Anthropic | OpenAI Chat | 同上 | ✓ |
| Codex → DeepSeek | Responses | OpenAI Chat | `/v1/responses` → 转 → DeepSeek | Codex 收到 Responses SSE ✓ |
| opencode → Claude | OpenAI | Anthropic | `/v1/chat/completions` → 转 → Claude | opencode 收到 OpenAI SSE ✓ |

### 步骤 6：Junction 辅助——集中 khy 数据家目录（已有，无需新做）

确认 `~/.khy` → 便携根、`~/.khyquant` → `C:\.khyquant` junction 到位（汇总文档 §7.8 实测已确认）。新机器用 `resolve-location.ps1`（汇总文档 §7.5）检测后 `mklink /J` 创建。这是**部署态**操作，不是代码改动。

---

## 8. 文件改动清单（✓ 2026-09-24 已实施）

### 后端

| 文件 | 改动 | 性质 |
|---|---|---|
| `services/backend/src/services/domain/config/ccSwitch/appWriters.js` | `applyCardToApp` 加 `mode:'proxy'` 分支 + `buildProxyCard` 字段替换 | 改（核心） |
| `services/backend/src/services/domain/config/ccSwitch/proxyAccess.js` | `resolveProxyAccess()` + `resolvePoolKeyFromCard()` | **新建** |
| `services/backend/src/services/domain/config/ccSwitch/constants.js` | `APPS` 枚举加 `DEEPSEEK_TUI` / `REASONIX` / `OPENCLAW` / `COZE` / `TRAE` | 改 |
| `services/backend/src/services/domain/network/externalApps/traeAppAdapter.js` | 桥接适配器，委托 `proxySwitchProfiles` | **新建** |

### provider-hub

| 文件 | 改动 |
|---|---|
| `src/main/ipc.ts` | `tools:apply` 透传 mode |
| `src/main/toolWriters.ts` | `applyCardToTool` 透传 mode + 默认工具列表扩到 12 |
| `src/preload/index.ts` | `tools.apply` 签名加 mode |
| `src/renderer/app.js` | 工具矩阵加代理/直连切换 + 工具列表扩到 12 |
| `src/renderer/index.html` | 工具矩阵行加 mode 控件 |

### 零改动

| 文件 | 理由 |
|---|---|
| `proxyServer.js` | 协议桥接已实现（§4 验证），不需要改 |
| `protocolConverter` / `_protocolPipeline` / `_protocolRegistry` | 已实现 |
| `modelRouter` | 已实现 |
| `aiGateway.js` | 不涉及（代理路由在 proxyServer 层完成） |
| `ai-frontend` / `khyos-desktop` | 不涉及（代理模式写入经 appWriters SSoT，前端零改动） |

---

## 9. 风险与降级

| 风险 | 降级 |
|---|---|
| 代理未运行时代理模式不可用 | `resolveProxyAccess()` 检测 `proxyStatus().running===false` 时返回具体错误（状态透明，规则 2.2）；用户切直连模式用 |
| `proxy_server_auth.json` 不存在 | `resolveProxyAccess()` fail-soft 返回 `{proxyEndpoint:'', error:'代理未启动…'}`，不假装成功 |
| 代理令牌泄露给 agent 配置文件 | 令牌是 `khy-<48hex>`（非 provider 真实 key）；泄露后代理侧 `rotateAuthToken()` 一键轮换，无需改 provider key |
| 协议翻译损耗（工具调用格式差异） | 代理已有 `_toolSchemaConverter` + tool_use/tool_result 配对修复（`proxyServer.js` 第 1558–1565 行）；Claude Code 的 web_search 服务端工具有专用拦截器（第 1389–1410 行） |
| poolKey 解析失败（card.keyId 无对应池条目） | `resolvePoolKeyFromCard` 返回空 → 回退用 `card.name.toLowerCase()` 作 poolKey → 仍可路由 |
| 代理模式写入后 agent 不认模型名 | `api:deepseek:deepseek-chat` 三段格式是 apiAdapter 原生格式（`apiAdapter.js` `parseProviderModel`）；如 agent 截断模型名，回退用裸名 + `PROXY_MODEL_ROUTE_MAP` 条目 |
| Trae 桥接委托 switch-center 路径复杂 | 步骤 4 的 Trae 接入可独立于代理模式先行或后行；不阻塞核心流程 |

---

## 10. 证据索引

### 本机 agent 配置实测

| 结论 | 出处 |
|---|---|
| 16 个本机 agent 的配置位置 / 协议 / CLI 面 | `D:\Portable\AI模型配置汇总.md` 第一节（16 项逐条实测） |
| khy-os 是两层合一（代理 + 适配器） | 汇总文档 §8.1 / §8.6 |
| cc-switch 是隐藏中枢（只覆盖 Claude Code + opencode） | 汇总文档 §8.5 |
| GUI-only agent（WorkBuddy / Qoder）无法文件管理 | 汇总文档 §8.6 结构性排除 |
| Junction 实测（`.zcode` / `.khyquant` / `.gradle`） | 汇总文档 §7.8 |
| 重解析点类型与判定方法 | 汇总文档 §7.2 / §7.3 |

### khy-os 源码验证

| 断言 | 源码文件 | 行号 |
|---|---|---|
| 代理四协议端点路由 | `services/backend/src/services/gateway/proxyServer.js` | 2889–2937 |
| `handleMultiProtocol` 协议互转 | 同上 | 1385（函数定义）/ 1412（入站转换）/ 1483（路由）/ 1716（出站转换） |
| Anthropic 级联允许（非绑死 claude 适配器） | 同上 | 1490–1495 |
| Anthropic SSE 出站事件 | 同上 | 1716–1733 |
| WebSearch 服务端工具拦截 | 同上 | 1389–1410 |
| tool_use/tool_result 配对修复 | 同上 | 1558–1565 |
| Anthropic 直通优化 | 同上 | 1644–1648 |
| 代理端口 + 端口冲突探测 | 同上 | 373–450（`resolveStartConfig`）/ `PORT_RETRY_LIMIT=10` |
| 代理 auth（自动令牌 + managed tokens） | 同上 | 482–770 |
| 代理运行时文件写 `proxy_server_runtime.json` | 同上 | exports 段 3085–3102 |
| appWriters 7 agent 直连写入 | `services/backend/src/services/domain/config/ccSwitch/appWriters.js` | 110–200 |
| `agentMode` 类型定义（proxy/direct） | `apps/provider-hub/src/main/types.ts` | 24–27 |
| 代理端点发现（零硬编码） | `apps/provider-hub/src/main/proxyStatus.ts` | 22–45 |
| dataHome 四级解析 | `apps/provider-hub/src/main/providers.ts` | 25–49 |
| 11 个内置厂商 | `services/backend/src/services/gateway/builtinProviderConfig.js` | 32–126 |
| 12 个公共适配器 | `proxyServer.js` | 64–77 |
| apiAdapter 三段模型名 `api:<poolKey>:<model>` | `services/backend/src/services/gateway/adapters/apiAdapter.js` | `parseProviderModel` |
| externalApps 已有但未连线的 4 适配器 | `services/backend/src/services/domain/network/externalApps/` | `deepseekTuiAdapter.js` / `reasonixAdapter.js` / `openclawAdapter.js` / `cozeAdapter.js` |
| Trae switch-center | `services/backend/src/cli/handlers/proxySwitchProfiles.js` | 全文 301 行 |

---

## 附录 A：与 DESIGN-ARCH-094 的关系

本方案是 `[DESIGN-ARCH-094]` 的**增量扩展**：

| 094 已落地 | 本方案新增 |
|---|---|
| 卡片库 CRUD + 密钥池 + 脱敏不变式 | 代理模式写入（appWriers 加 mode 分支） |
| 7 agent 直连写入 | +5 agent 接入（4 个已有适配器 + Trae 桥接） |
| 代理端点发现（proxyStatus.ts） | 代理令牌发现 + poolKey 解析（proxyAccess.js） |
| 工具矩阵 UI（应用/撤销） | 工具矩阵加代理/直连切换 |
| failover 备卡队列 | 直连 vs 代理模式对比 |
| — | 协议桥接验证（Anthropic↔OpenAI，已确认可用） |

094 的所有不变式（零硬编码端点、卡片不含凭据、明文 key 单一出口、写必走正门、空闲超时不硬挂、fail-soft）在本方案中**全部沿用，不放宽**。

## 附录 B：未纳入本方案的范围

| 事项 | 理由 | 后续 |
|---|---|---|
| 桌面识图（截图 + 视觉模型读 GUI-only agent 当前模型） | 用户另行讨论；本方案聚焦协议桥接与代理模式 | 独立设计文档 |
| GUI 自动化写入（模拟点击设置面板切模型） | 风险高、平台相关、易误操作 | 暂不纳入 |
| Qoder / Qoder CN 接入 | catalog 加密 + uid 本机绑定，结构性排除（汇总文档 §8.6） | 不可行 |
| WorkBuddy 模型列表外部分发 | `acc-product-config-v3.json` 是输出文件，手改无效（汇总文档 §1.9） | 不可行（路由可经代理，模型列表不可） |
| new-api / litellm 引入 | 单人本机无收益；多机协作时再评估（汇总文档 §8.8 步骤 7） | 后续 |
