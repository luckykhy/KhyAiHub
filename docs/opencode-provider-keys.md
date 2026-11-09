# OpenCode Provider & Key 清单

> 最后更新：2026-10-28
> 生效配置：`D:\Portable\Tools\opencode\xdg\opencode\opencode.json`
> （经用户级环境变量 `XDG_CONFIG_HOME=D:\Portable\Tools\opencode\xdg` 生效——opencode 启动时
> 按 XDG 读取该路径，**增删 provider 必须落到这个文件**，改别的副本不生效。
> 注意：`C:\Users\25789\.config\opencode\opencode.json` 是历史遗留的非生效副本，勿改）
> 用途：在其他电脑快速重建 opencode provider 配置

---

## 1. SupXH（免费聚合）

| 项目 | 值 |
|------|-----|
| Base URL | `https://speed44.toter.me/v1` |
| 备用地址 | `https://api.supxh.xin` |
| API Key | `{env:SUPXH_API_KEY}`（需设置环境变量） |
| API 类型 | OpenAI 兼容 |

**可用模型：**
- `claude-sonnet-4-5` — Claude Sonnet 4.5（200K ctx）
- `claude-opus-4-5` — Claude Opus 4.5（200K ctx）
- `gemini-3-flash` — Gemini 3 Flash（1M ctx）
- `gemini-2.5-pro` — Gemini 2.5 Pro（1M ctx）
- `gemini-3.1-pro` — Gemini 3.1 Pro（1M ctx）
- `入梦 Flash`

---

## 2. Command Code

| 项目 | 值 |
|------|-----|
| Base URL | `https://api.commandcode.ai/provider/v1` |
| API Key | `{env:COMMAND_CODE_API_KEY}`（需设置环境变量） |
| API 类型 | OpenAI 兼容 |

**可用模型（部分）：**
- `claude-sonnet-5` / `claude-sonnet-4-6` / `claude-opus-5` / `claude-opus-4-8`
- `gpt-5.6-luna` / `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.5`
- `deepseek/deepseek-v4-pro` / `deepseek/deepseek-v4-flash`
- `moonshotai/Kimi-K3`
- `zai-org/GLM-5.3` / `zai-org/GLM-5.2`
- `MiniMaxAI/MiniMax-M3` / `minimax/minimax-m3-free`
- `xiaomi/mimo-v2.5-pro` / `xiaomi/mimo-v2.5`
- `Qwen/Qwen3.8-Max` / `Qwen/Qwen3.7-Max`
- `google/gemini-3.7-flash`
- `xai/grok-4.5` / `xai/grok-4.6`
- `poolside/laguna-s-2.1-free`
- `meituan/LongCat-2.0:free`

---

## 3. 智谱 GLM Coding Plan

| 项目 | 值 |
|------|-----|
| Base URL | `https://open.bigmodel.cn/api/coding/paas/v4` |
| API Key | `{env:GLM_API_KEY}`（需设置环境变量） |
| API 类型 | OpenAI 兼容 |

**可用模型：**
- `glm-5.3` — GLM-5.3
- `glm-5.3-flash` — GLM-5.3-Flash

---

## 4. OpenCode Go

| 项目 | 值 |
|------|-----|
| Base URL | `https://opencode.ai/zen/go/v1` |
| API Key | `{env:OPENCODE_GO_API_KEY}`（需设置环境变量） |
| API 类型 | OpenAI 兼容 |

**可用模型：**
- `grok-4.5`, `gpt-5.6-luna`, `glm-5.3`, `glm-5.2`, `glm-5.1`
- `kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`
- `mimo-v2.5`, `mimo-v2.5-pro`
- `minimax-m3`, `minimax-m2.7`, `minimax-m2.5`
- `qwen3.8-max`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`
- `deepseek-v4-pro`, `deepseek-v4-flash`
- `hy3`, `ox-alpha-free`

---

## 5. OpenRouter

| 项目 | 值 |
|------|-----|
| Base URL | `https://openrouter.ai/api/v1` |
| API Key | `<your-openrouter-api-key>` |
| API 类型 | OpenAI 兼容 |

**白名单模型（free）：**
- `z-ai/glm-5.2:free`
- `cohere/north-mini-code:free`
- `nvidia/nemotron-3-ultra-550b-a55b:free`
- `nvidia/nemotron-3.5-lightning:free`
- `nvidia/nemotron-3-super-120b-a12b:free`
- `nvidia/nemotron-3-nano-30b-a3b:free`
- `nvidia/nemotron-nano-9b-v2:free`
- `thinkingmachines/inkling:free`
- `thinkingmachines/inkling-small:free`
- `poolside/laguna-s-2.1:free`
- `poolside/laguna-xs-2.1:free`
- `google/gemma-4-31b-it:free`
- `google/gemma-4-26b-a4b-it:free`
- `dots-studio/dots-3-note-preview:free`
- `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`
- `minimax/minimax-m3:free`
- `openrouter/free`
- `nvidia/nemotron-3.5-content-safety:free`
- `liquid/lfm-2.5-2.6b:free`

---

## 6. StepFun（阶跃星辰）

| 项目 | 值 |
|------|-----|
| Base URL | `https://api.stepfun.com/step_plan/v1` |
| API Key | `{env:STEPFUN_API_KEY}`（需设置环境变量） |
| API 类型 | OpenAI 兼容 |

**可用模型：**
- `step-3.7-flash`

---

## 7. Sense Nova（商汤）

| 项目 | 值 |
|------|-----|
| Base URL | `https://token.sensenova.cn/v1` |
| API Key | `{env:SENSENOVA_API_KEY}`（需设置环境变量） |
| API 类型 | OpenAI 兼容 |

**可用模型：**
- `sensenova-6.7-flash-lite`

---

## 8. Agnes

| 项目 | 值 |
|------|-----|
| Base URL | `https://apihub.agnes-ai.com/v1` |
| API Key | `{env:AGNES_API_KEY}`（需设置环境变量） |
| API 类型 | OpenAI 兼容 |

**可用模型：**
- `agnes-2.0-flash`, `agnes-2.5-flash`, `agnes-2.5-pro-alpha`
- `agnes-image-2.0-flash`, `agnes-image-2.1-flash`
- `agnes-video-v2.0`

---

## 9. OpenCode Zen（官方免费免登录）

| 项目 | 值 |
|------|-----|
| Base URL | `https://opencode.ai/zen/v1` |
| API Key | 免登录（客户端指纹门控），无需配置 key |
| API 类型 | OpenAI 兼容 |
| 模型清单来源 | opencode 内置 `opencode` provider（`opencode/<模型id>`），**无需在 opencode.json 中配置** |

**当前免费模型（2026-10-24 实测上游目录，`opencode models` 的 `opencode/*` 项）：**
- `mimo-v2.6-flash-free` — MiMo V2.6 Flash（实测可用）
- `big-pickle`（实测可用）
- `glm-5.3-flash-free` — GLM 5.3 Flash
- `deepseek-v4.1-flash-free` — DeepSeek V4.1 Flash
- `flint-40b-free` — 2026-10-24 上游新增
- `jev-1.13-free` — 10-21 曾下线、10-24 上游已恢复
- `nemotron-3.5-lightning-free`
- `nemotron-3.5-super-vl-free`（支持图像）
- `beam-free` — 上游仍在目录，但实测 403 地区封锁（见下「出口 IP 与配额」）

**已废弃（勿用；实测 2026-10-09 上游返回 401/410/403）：**
- `mimo-v2.5-free` / `deepseek-v4-flash-free` — 上游 401 not supported
- `exo-free` — 410 ModelDeprecated
- `ling-3.0-flash-fin-free` — 上游不可用
- `muse-spark-1.2/1.3-contributor-free` — 403 地区封锁
- `minimax-m3.1-flash-free` / `longcat-2.5-preview-free` / `nemotron-3-ultra-free` — 2026-10-24 上游目录已收

> 目录里「消失」的 id **不写进废弃台账**：`jev-1.13-free` 10-21 下线、10-24 回来即证——记成永久废弃会把还能用的模型藏起来。台账只记「目录里挂着但调用会炸」的那批。

### 出口 IP 与配额（2026-10-24 实测）

上游免费层的三道门，khy-os 侧各自对应：

| 上游现象 | 实测响应 | 含义 |
|---|---|---|
| 裸 curl / 非 opencode UA | `403 FreeTierError`（can only be used from within OpenCode） | 指纹门控：`User-Agent` 须是 `opencode/<channel>/<version>/<client>` 形态 |
| 共享代理 IP | `403`（abusive traffic from this IP address） | IP 信誉 |
| 本机 IP、合法 UA | `429 FreeUsageLimitError`（Free usage limit reached） | **免费配额按出口 IP 计** |

推论：**一个 IP 的配额被共享，等于所有人一起被限**。所以免费渠道要「在哪台机器上允许，就在
那台机器上用它的机器码和 IP」——服务端代发时，所有用户共用服务端的 IP 与配额。

**khy-os 侧的身份（机器码）**：`services/zenIdentity.js` 提供**每机一份、跨重启稳定**的身份：
- session id 沿用 opencode `Identifier.create` 形态 `ses_<12 hex><14 base62>`（上游门控拒收非 12 hex 开头）；
- project uuid 为 v4 形态；
- 从 `KHY_MACHINE_ID`（否则 hostname）确定性派生 → 同机恒定、异机相异；
- 落盘 `<dataHome>/zen_identity.json` → **重启不再是「新设备」**（旧实现是进程级随机，每重启换一次）。

**显式覆盖（用户明确指定修改的唯一入口）：**

| env | 作用 |
|---|---|
| `KHY_ZEN_IDENTITY` | 主门。默认开；`0/false/off/no` 关 → 逐字节回退旧的进程级随机行为 |
| `KHY_ZEN_SESSION_ID` | 显式指定 session id |
| `KHY_ZEN_PROJECT_ID` | 显式指定 project uuid |
| `KHY_ZEN_IDENTITY_FILE` | 身份落盘路径（对齐 `KHY_ZEN_RETIRED_FILE` 约定） |

**khy-os 侧同步**：免费渠道发现清单 `services/freeModelChannels.js` 与网关路由种子
`services/gateway/builtinProviderConfig.js` 的 opencode-zen 条目均已同步为上述目录；
废弃项以 `services/zenRetiredModels.js` 台账为准（调用撞上 410/401 会自动补录，下次
列表刷新即消失）。

---

## 10. Requesty Free

| 项目 | 值 |
|------|-----|
| Base URL | `https://router.requesty.ai/v1` |
| API Key | `{env:REQUESTY_API_KEY}`（key 在生效配置 opencode.json 中） |
| API 类型 | OpenAI 兼容 |

**可用模型：**
- `nvidia/nemotron-3-ultra-550b-a55b` — Nemotron 3 Ultra 550B（免费）
- `nvidia/nemotron-3-super-120b-a12b` — Nemotron 3 Super 120B（免费）
- `nvidia/nemotron-3.5-lightning-30b-a3b` — Nemotron 3.5 Lightning 30B（免费）
- `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` — Nemotron 3 Nano Omni 30B（免费，支持图像）
- `nvidia/nemotron-3-nano-30b-a3b` — Nemotron 3 Nano 30B（免费）
- `nvidia/nemotron-3.5-content-safety`
- `nvidia/muse-glimmer-30b`
- `google/gemma-4-31b-it`
- `mistral/leanstral-1-5`
- `poolside/laguna-m.1` / `poolside/laguna-xs.2`
- `novita/inclusionai/ling-3.0-tiny`

---

## 11. TierFlow Free

| 项目 | 值 |
|------|-----|
| Base URL | `https://tierflow.cn/v1` |
| API Key | `{env:TIERFLOW_API_KEY}`（key 在生效配置 opencode.json 中） |
| API 类型 | OpenAI 兼容 |

**可用模型：**
- `GLM-5.3-Flash` / `GLM-5.3-FlashX` / `GLM-5.3`
- `DeepSeek-V4.1-Flash`
- `Qwen3.8-Flash`
- `tierflow` / `tierflow_pro`

---

## 12. MiniMax（复用本机 MiniMax Code 订阅）

| 项目 | 值 |
|------|-----|
| Base URL（opencode 侧） | `http://127.0.0.1:8790`（本地凭据代理，见下） |
| 真实上游 | `https://agent.minimax.cn/mavis/api/v1/llm/v1` |
| 协议 | Anthropic Messages（`npm: "@ai-sdk/anthropic"`） |
| 鉴权 | `Authorization: Bearer <accessToken>`，**由代理按请求注入** |
| API Key（写进 opencode 配置的） | `minimax-local-proxy` —— 占位串，真 token 不进配置文件 |
| 续期端点 | `https://account.minimax.cn/oauth2/token`（`grant_type=refresh_token`，`client_id=mcode-public`） |

> 官方开放平台的 Anthropic 兼容地址是 `https://api.minimax.io/anthropic`（海外）/
> `https://api.minimaxi.com/anthropic`（国内），走平台 API Key（`sk-…`）。本条目**不用**那条路，
> 走的是 MiniMax Code 订阅侧的 agent 端点，两者额度不同、不可混用。

### 为什么中间要垫一层代理

MiniMax Code（MCode）的 access token **短效（约 1 小时）**，由 MCode 在后台自动续期；
而 opencode 的 provider 凭据只从**进程启动那一刻的环境变量**读一次。
于是常驻的 `opencode serve --service` 与 TUI 握着一小时后就过期的 token，
一过点连 `small_model`（摘要/标题）都会开始报错——而这类失败没有任何显式开关能关掉。

代理把这件事挪到**请求时**解决：每个请求现取一次当前可用 token（30 秒缓存），
换上 `Authorization` 头再转发给上游。opencode 侧只看到一个普通 Anthropic 兼容端点，
不知道 token 存在，也不需要在配置里写 `{env:…}`。

### 落点（便携目录 `Tools/opencode/bin/`）

| 文件 | 作用 |
|------|------|
| `minimax-token.js` | 读 MCode 凭据库 `~/.minimax/auth/prod/<region>/mcode-public/auth.json` 取当前 token；已过期则用 refreshToken 续期并**回写**凭据库（generation+1） |
| `minimax-proxy.js` | `127.0.0.1:8790` 凭据代理；`GET /__health` 返回 `{ok, expiresAt, source}` |
| `minimax-opencode.js` | 启动前确保代理在跑，再 exec opencode |
| `opencode-mm.cmd` | 入口：`opencode-mm [任意 opencode 参数]`（PATH 已含该目录） |

守护：计划任务 `khy-opencode-watchdog`（每 5 分钟）额外检查代理健康，端掉就补拉，
与它对 `opencode service` 的看门狗逻辑同一套机制。

### 可用模型（2026-10-28 实测上游）

| 模型 id | 说明 |
|---|---|
| `MiniMax-M3.1-Flash` | 默认；`small_model` 也指向它 |
| `MiniMax-M3` | 完整版 |
| `MiniMax-M2.7` | |
| `MiniMax-M2.7-highspeed` | |
| `MiniMax-M2.5` | |
| ~~`MiniMax-M2.1`~~ | 已下线：上游 404 `not_found_error` |

> 该端点**只有 Anthropic Messages 形态可用**：`/chat/completions` 路径实测 503
> `direct_route_not_configured`，因此 `npm` 必须是 `@ai-sdk/anthropic`，不能图省事写成
> `@ai-sdk/openai-compatible`。

---

## 其他凭据

### DeepSeek Eyes（MCP 本地工具）
- VISION_BACKEND: `openrouter`
- OPENROUTER_API_KEY: `<your-openrouter-api-key>`
- VISION_MODEL: `dots-studio/dots-3-note-preview:free`

---

## 快速配置指南

在其他电脑上配置时，只需在 `opencode.json` 的 `provider` 字段中添加对应条目：

```json
{
  "provider": {
    "<provider-id>": {
      "api": "openai",
      "name": "显示名称",
      "options": {
        "apiKey": "你的API Key",
        "baseURL": "API地址"
      },
      "models": {
        "model-id": {
          "id": "model-id",
          "name": "显示名称"
        }
      }
    }
  }
}
```

切换模型：在 opencode 中输入 `/model` 然后选择 `provider-id/model-id`

**v2 CLI 注意（2.0.x）**：顶层 `-m/--model` 参数已移除；一次性指定模型用
`opencode run --model provider/model "..."`（khy-os 的 `opencodeInvocation.js`
已按此形状构造调用参数）。

**`enabled_providers` 是白名单，不是黑名单**：配了 provider 却没把它写进
`enabled_providers`，它就**不会出现在 `/model` 列表里**（v2 把它编译成
「先 deny 全部 provider，再逐个 allow」的策略）。本机当前白名单是
`["opencode", "agnes", "minimax"]`。

**顶层 `model` 指向未启用的 provider 会静默降级**：`model` 写的是
`deepseek/deepseek-chat`，而 `deepseek` 既不在白名单里、也没有配 API Key，
opencode 实际会退回到可用模型（实测退到 `opencode/flint-40b-free`，而该渠道按出口 IP
计免费配额，用超即报 `Free usage limit reached`）。想让默认模型真的落在某个渠道上，
需要「配 key + 加白名单 + 改顶层 `model`」三件事一起做。

### MiniMax 的 provider 条目（照抄即可）

```json
{
  "provider": {
    "minimax": {
      "npm": "@ai-sdk/anthropic",
      "name": "MiniMax",
      "options": {
        "baseURL": "http://127.0.0.1:8790",
        "apiKey": "minimax-local-proxy"
      },
      "models": {
        "MiniMax-M3.1-Flash": { "name": "MiniMax-M3.1-Flash", "reasoning": true, "attachment": true, "limit": { "context": 512000, "output": 128000 } },
        "MiniMax-M3": { "name": "MiniMax-M3", "reasoning": true, "attachment": true, "limit": { "context": 512000, "output": 128000 } },
        "MiniMax-M2.7": { "name": "MiniMax-M2.7" },
        "MiniMax-M2.7-highspeed": { "name": "MiniMax-M2.7-highspeed" },
        "MiniMax-M2.5": { "name": "MiniMax-M2.5" }
      }
    }
  },
  "enabled_providers": ["opencode", "agnes", "minimax"],
  "small_model": "minimax/MiniMax-M3.1-Flash"
}
```

