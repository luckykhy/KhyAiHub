# [IMPL-RPT-061] OpenCode Zen 免鉴权通道 — 核实的方案

| 项 | 值 |
| --- | --- |
| 日期 | 2026-09-23 |
| 现场 | `D:/Portable/khy-os` |
| 状态 | 已核实（live 直连 + 网关层双通过） |
| 真源 | `zenGatekeeper.js` / `multiFreeService.js` / `customProviderRegistrar.js` / `freeModelChannels.js` |
| 口径 | **仅当选中 `api:opencode-zen:*-free` 模型时，才注入免鉴权路径；其余通道不受影响** |

---

## 一、结论（先看这个）

**只有选中 OpenCode 的 free 模型时，才走 OpenCode 免鉴权路径。**

判定链（自上而下，命中即定）：

| # | 条件 | 命中动作 |
|---|------|---------|
| 1 | 模型三段式前缀不是 `api:opencode-zen:` | 不进 Zen 门禁，走该通道既有鉴权/裸请求 |
| 2 | 池 key = `opencode-zen` 且 `isZenEndpoint(baseUrl)` 为真 | 注入 Zen 门禁头 + `stream:true` + 门禁工具 |
| 3 | 模型 id **不以** `-free` 结尾 | 上游 401（付费档需真实 key），**不**按免鉴权放行 |
| 4 | 模型 id 以 `-free` 结尾 | 免鉴权通过（`Bearer public` 即可 200） |

简言之：**endpoint 匹配 Zen SSOT → 注入门禁；模型后缀 `-free` → 免 401。** 两者缺一，都不走「免鉴权可用」这条路径。

---

## 二、门禁四要素（已 live 核实）

| 要素 | 实现位置 | 核实结论 |
|------|---------|---------|
| **Headers** | `zenGatekeeper.buildZenHeaders()` | `Authorization: Bearer public`、`User-Agent`（SSOT）、`x-opencode-session/request/client/project`、`x-session-id`；header 本身基本不限 |
| **ID 格式** | `newSessionId()` / `newRequestId()` | `prefix_` + **12 hex 时间戳** + **14 base62**；session 用 descending（`~(Date.now()*0x1000+1)` 取 6 字节），message 用 ascending。纯 base62 / lower36 → **403**；正确格式 → **200** |
| **Body 门** | `applyZenBodyGate()` | `stream:true` 必需；`tools[]` 必须含名为 `bash` 与 `read` 的工具（大小写敏感，只看名字）；无调用方工具时 `tool_choice:"none"`，避免模型去调门禁合成工具 |
| **模型后缀** | 上游 401 门 + 本地清单三处对齐 | **仅 `*-free` 免鉴权**；`claude-fable-5` / `gpt-6-astra` / `gemini-3-flash` 等 → **401**；`mimo-v2.6-flash-free` → **200** |

ID 算法对齐 OpenCode 官方 `Identifier.create`（`id/id.ts`）；Body 门经 mitmproxy 对官方 `1.18.27` 抓包逆向得到。

---

## 三、路由：为什么「只选 free 才走免鉴权」

### 3.1 调用链

```
选中模型 api:opencode-zen:<model>
        │
        ▼
multiFreeService.callOpenAI
        │
        ├─ isZenEndpoint(baseUrl)?  ──否──▶ 不注入 Zen 头/体门（其它通道原样）
        │         │是
        │         ▼
        │  buildZenHeaders() + applyZenBodyGate(body)
        │         │
        │         ▼
        │  Authorization: Bearer <pool.apiKey>
        │  （opencode-zen 池 key 固定为 "public"）
        │
        ▼
上游网关
        │
        ├─ 模型不以 -free 结尾 ──▶ 401（需付费 key）
        └─ 模型以 -free 结尾   ──▶ 200 免鉴权
```

关键门在 `multiFreeService.js`：先 `isZenEndpoint(baseUrl)`，为真才 `buildZenHeaders()` / `applyZenBodyGate()`；为假则 **完全不碰** Zen 门禁。`opencode-zen` 不在 `BUILTIN_POOL_KEYS`，池 key 三段式仍是 `api:opencode-zen:<model>`。

### 3.2 三处 free 清单（必须一致）

| 文件 | 作用 |
|------|------|
| `customProviderRegistrar.BUILTIN_ZEN` | seed 内置池：`defaultModel: mimo-v2.6-flash-free`，`key: public`，6 个 `*-free` |
| `freeModelChannels.js` opencode-zen | 渠道目录展示的 6 个 `*-free` |
| `dynamicFreeModelService.extractFreeModelsFromZen` | 拉远端 `/v1/models` 后 `.filter(m => m.id.endsWith('-free'))`（目录混有 401 付费名） |

当前 6 个真免费模型（均 `-free` 后缀）：

```
mimo-v2.6-flash-free
mimo-v2.5-free
deepseek-v4-flash-free
jev-1.13-free
ling-3.0-flash-fin-free
nemotron-3-ultra-free
```

---

## 四、核实证据

| 层级 | 命令/方式 | 结果 |
|------|----------|------|
| 直连 | `multiFreeService.callOpenAI` → Zen | `LIVE_OK "PONG"` |
| 网关 | `aiGateway.generate('api:opencode-zen:mimo-v2.6-flash-free')` | `GW_OK "GATEWAY_OK"` |
| 反例（非 free 模型） | 同路径请求 `claude-fable-5` 等 | **401**（非免鉴权路径） |
| 反例（坏 ID） | 纯 base62 / lower36 session | **403** |
| 单测 | `node --test`（zenGatekeeper + freeModelChannels） | 20/20 绿 |
| 单测 | jest（ensureBuiltinZen / zenGate / customProviderRegistrar） | 3 suites / 16 tests 绿 |
| 服务默认 | serviceDefaults + registrar + zenGate | 21 tests 绿 |

端到端烟测脚本：`C:\Users\25789\AppData\Local\Temp\opencode\gw_smoke.js`（临时件，不入仓）。

---

## 五、日常使用约束

1. **免 key**：`Bearer public`（池 key），`khy init` / 网关 `_doInit` 自动 `ensureBuiltinZen` seed，跨机器 clone 后开箱可用。
2. **模型写法**：`api:opencode-zen:<id>`，`<id>` 必须以 `-free` 结尾。
3. **免费档有限额**：门禁为逆向（按官方 `1.18.27` 实现），对方改 ID 格式 / body 指纹 / 后缀白名单可能失效；失效时优先查 `zenGatekeeper.js` 注释与本文门禁表。
4. **端点 SSOT**：`ZEN_BASE_URL` 只在 `constants/serviceDefaults.js`（RUNTIME-001）；`isZenEndpoint` 容忍尾斜杠与任一侧 `/v1`。

---

## 六、改动面（本轮）

| 文件 | 改动 |
|------|------|
| `zenGatekeeper.js` | ID 生成按官方算法重写（`_timeHex` + `_base62(14)`） |
| `freeModelChannels.js` | opencode-zen `freeModels` → 6 个真 `-free` |
| `customProviderRegistrar.js` | `BUILTIN_ZEN` defaultModel / models 对齐 6 个 |
| `dynamicFreeModelService.js` | Zen 模型列表加 `-free` 过滤 |
| `multiFreeService.zenGate.test.js` | 断言模型改 `mimo-v2.6-flash-free` |
| `builtinProviderConfig.js` | 目录补 `opencode-zen`（freeNoKey、端点走 `ZEN_BASE_URL` SSOT） |
| `providerConnectivitySpec.js` | `opencode-zen` 协议族 openai；免 key 探针；注入 zen 门禁头 + body gate |
| `services/backend/.env` | `GATEWAY_PREFERRED_MODEL` → `api:opencode-zen:mimo-v2.6-flash-free`；`GATEWAY_PREFERRED_STRICT=false` |

未改：其它免费通道（OpenRouter `:free`、SenseNova 等）的鉴权路径，**不受本方案影响**。

### 6.1 `jev-1.13-free` 上游故障与首选切换（2026-09-23）

| 判据 | 结果 |
|------|------|
| 直连 zen `jev-1.13-free` | **7/7 次 HTTP 500**（与 max_tokens/stream/tools 组合无关） |
| 同端点 `mimo-v2.6-flash-free` 等 | **200**（对照证明非本机 header/body 问题） |
| 原 `.env` | `GATEWAY_PREFERRED_MODEL=api:opencode-zen:jev-1.13-free` + `STRICT=true` → TUI `strict_pinned_skip` 硬失败 |
| 改后 | preferred → `mimo-v2.6-flash-free`，`STRICT=false`；流式 generate `success=true` `"PONG"` |
| 连通探针 | `khy test-key opencode-zen` → `verdict=ok` status 200 |

`jev-1.13-free` 仍在 `listModels` / `PROXY_MODEL_ROUTE_MAP` 中；显式选中它仍会 500（上游未恢复）。首选路径与 `STRICT=false` 级联已不受其拖累。

存证：`.khy/feedback/fix-tui-jev-preferred-500/`（complaint / repro-before / differential / repro-after / mode.json）。

---

## 七、一句话备忘

> **选中 `opencode-zen` 的 free 模型 → 注入 Zen 门禁（头 + ID + body）+ `Bearer public` → 免鉴权 200；其它模型 / 其它端点 → 不走这条路径。**
