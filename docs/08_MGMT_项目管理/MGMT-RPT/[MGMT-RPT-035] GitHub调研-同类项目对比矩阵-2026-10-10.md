<!-- 文档分类: MGMT-RPT-035 | 阶段: 项目管理 | 原路径: 新建 -->
# [MGMT-RPT-035] GitHub 开源生态同类项目调研与对比矩阵 —— 2026-10-10

> **调研问题**：GitHub 上有没有与 khy-os **同类型**的开源项目？如果没有，按功能拆开后逐块对标，最后形成一张对比矩阵。
> **结论先行**：**没有同类型项目**——khy-os 是「网关层 + 智能体终端 + 跨形态 + 订阅套利」四合一，开源界每一块都有强对手，但**没有任何一个项目同时占两块以上**。故按功能拆为 **7 桶**调研 45 个项目，矩阵见 §四。
> **性质**：调研报告。不新增规范、不改任何代码、不改版本号。
> **与既有文档的分工**：商业在场者（CC / Cursor / Trae / ZCode / WorkBuddy / Abu）见 [`INIT-PRD-005`](../../01_INIT_立项/INIT-PRD/[INIT-PRD-005] 市场立足点与竞品格局.md)；编码交付力 11 维对标见 [`MGMT-RPT-016`]([MGMT-RPT-016] 竞品情报图谱.md)。本文只覆盖**前两份都没覆盖的一侧：GitHub 开源生态**，且按功能拆分而非按品牌罗列。

---

## 〇、一句话

**开源界没有一个「AI 主机」——只有「网关」「中转」「终端客户端」「自托管平台」四类零件。khy-os 是唯一把四类零件焊成一个可安装包的项目；这既是它没有对标物的原因，也是它每一块都被更专精的项目单独压制的现状。**

三条展开：

1. **同类型 = 不存在。** 检索范围内无任何开源项目同时具备「多供应商网关 + 订阅 relay + 智能体终端 + 跨形态」中的两项以上（§三 拆解依据）。
2. **零件级对手全部更强。** 网关层有 LiteLLM / new-api（star 数量级领先），订阅转 API 有整族专用转换器，终端有 opencode / Crush / aichat，自托管平台有 OpenWebUI / LibreChat。**khy-os 的单点深度不占优**。
3. **差异不在零件，在焊接。** 开源界的默认形态是「一个项目干一件事，用 Docker Compose 拼起来」；khy-os 赌的是「一个 `pip install` 全都有」。这个赌注的对错，本文不给结论，只给判据（§六）。

---

## 一、调研方法

| 步 | 动作 | 产出 |
|---|---|---|
| 1 | 先按「同类型」整体检索（AI host / AI OS / unified AI terminal / subscription arbitrage） | 无同时覆盖 ≥2 个能力域的开源项目 → 判定「无同类型」 |
| 2 | 按 khy-os 的**能力域**拆成 7 桶，逐桶检索 GitHub | 7 桶各自的对标项目表（§三） |
| 3 | 对每个项目只取 4 个字段：仓库/star+license、定位、覆盖 khy-os 哪些能力域、局限 | 剔除营销话术，只留可比事实 |
| 4 | 汇总为能力域 × 项目 的对比矩阵（§四） | 一张矩阵定「哪一仗在打」 |

**取证纪律**：star 数均标注查询日期（2026-10-10）并写「约」；凡是不能确认仓库真实存在的项目，在表中标注「未核实」而不填入矩阵——本调研中该类候选全部剔出，宁缺勿造。

---

## 二、功能拆分：khy-os 的能力域基线（自侧，全部实测）

矩阵的列 = khy-os 的能力域。**先把自己的能力域钉死，再去比**，否则矩阵会退化成「谁 star 多」。

| # | 能力域 | khy-os 实测锚点（2026-10-10） | 落地度 |
|---|---|---|---|
| **A** | 多供应商 / 多协议统一接入 | `runtime/node/backend/src/services/gateway/adapters/` 下 **19 个 `*Adapter.js`**：acpAgent / api / claude / cliTool / clipboardRelay / codex / commandCode / cursor2api / cursor / kiro / localLLM / ollama / openclaw / opencode / relayApi / trae / vscode / warp / webRelay | ✅ 已落地 |
| **B** | 订阅套利（接别家订阅） | **自实现转换**（非调外部服务）：`kiroAdapter.js` 读 `~/.aws/sso/cache/kiro-auth-token.json` + Social/IdC 自动刷新 + 调 Q Developer 流式 API（token 逻辑移植自 kiro-proxy）；`traeAdapter.js` 四级策略（Trae 原生协议 `x-cloudide-token` → CodeWhisperer → Trae Network SDK → OpenAI 兼容端点）；`warpAdapter.js` 剪贴板 relay 桥接；`relayApiAdapter.js` 接三方中转站（OpenAI-SB/API2D/OhMyGPT/CF Workers）；`cursor2apiAdapter.js` 则**委派**外部 cursor2api 服务（`cursor2apiIntegrationService`） | ✅ 机制在（覆盖 5 家），**报告缺位**（T-026 todo） |
| **C** | 容错 / 熔断 / 降级 / 自动路由 | `services/circuitBreaker.js`（`computeBackoffMs`）+ `gateway/aiGatewayCooldownMethods.js`（指数冷却升级，注释明确「熔断态 vs fast-fail 探测」边界）+ `gateway/autoModelRouting.js`（**[DESIGN-ARCH-185] §5.4**：档位带约束 + 成本 λ + 「池内任一价格不可知则 λ 整项退出」硬规则 + top1−top2 margin 供低置信升档）+ `autoModelSelect.js`（连续打分，decorate-sort-undecorate 稳定排序）+ `channelHealthBroadcaster.js` + `streamHealthSink.js` | ✅ 已落地（**含成本感知路由，本文核验后认为优于多数开源网关**） |
| **D** | 用量与成本核算 | `services/tokenUsageService.js`（`USD_TO_CNY = 7.25`，输出 `{costUSD, costCNY}`）+ `services/costByModel.js` | ✅ 计价在，**「省了多少钱」的报告缺位**（T-026 todo） |
| **E** | 智能体终端（TUI/REPL） | `src/cli/tui/` 下 **192 个 `*.js`**（CC 风格，`KHY_CC_TUI=1` 门控）+ `toolUseLoopCore.js`（工具调用循环，正按 T-021 拆分） | ✅ 已落地 |
| **F** | 跨形态同一会话（终端/桌面/Web/手机/微信） | 终端 TUI ✅；桌面 Electron（`apps/khyos-desktop`）✅；Web（`delivery/web/ai-frontend` + `provider-hub`）✅；微信 ilink（`services/domain/messaging/` 共 **85 个 `*.js`**）⚠ 代码在、端到端手测未收尾（**T-001 todo**）；手机 APK ✗ **工程不存在**（`android/` 目录实测缺失，`scripts/release/build-android.ps1` 引用了尚未创建的工程；T-013/014/015 全 todo）；四端同步 ✗（**T-022 todo**） | ⚠ **半落地** |
| **G** | 吸收第三方 agent 为工具 | `khy app cli-gen <repo-url-or-local-path> [--runtime python\|node]`（`cli/handlers/app.js:1235-1239`）+ 网关「定向指挥」类适配器：`openclawAdapter` / `opencodeAdapter` / `commandCodeAdapter` / `acpAgentAdapter`（外部智能体保留自己的模型配置，经 `preferredAdapter`/`preferredModel` 定向路由，不抢占自动 LLM 回退）+ `cliToolAdapter.js` 以子进程调本地 AI CLI（Claude Code / Codex / Aider，支持 stream-json 实时思考流）+ 仓内 Abu 案例 | ✅ 已落地（**本文核验后认为这是开源界最难复制的一格**） |
| **H** | 扩展 / 插件运行时 | 全仓 **10 个 `khy.extension.json`** + `works/ship/modules/modules.json` 模块化打包清单 | ✅ 已落地（规模小） |
| **I** | 本地优先 / 私有 / 便携 | source-available、数据全本地、`portable-setup.bat` / `portable-setup.sh` 便携安装、路径全部相对定位（无硬编码盘符） | ✅ 已落地 |
| **J** | 中文本土化 | `cli/aliases.js` 拼音命令别名、中文面向用户消息、`USD_TO_CNY` 人民币计价、国内模型与镜像优先 | ✅ 已落地 |
| **K** | 分发 | pip（PyPI `khy-os`）+ npm（`@khy-os/khy-os`）双渠道 | ✅ 已落地（无 dmg/installer/应用商店，见 INIT-PRD-005 §六） |

> **注**：`A`/`B`/`C`/`D` 四域是 khy-os 的「应用层之下」那一格（[`INIT-PRD-005`](../../01_INIT_立项/INIT-PRD/[INIT-PRD-005] 市场立足点与竞品格局.md) §一 的 L2/L1），`E`/`F` 是用户唯一认得出的那一格（L4）。**本文矩阵的核心用途就是量出：L2/L1 的零件级对手有多强。**

---

## 三、按功能拆成 7 桶后的对标项目

> 每桶只列与 khy-os 能力域**直接相关**的项目；star 数为 2026-10-10 查询值（写「约」）。
> **取证纪律**：凡不能确认仓库真实存在的候选一律剔出并在桶末列出「未核实」清单，不填入矩阵。

### 桶 1 · 网关层：多供应商 + 容错 + 成本核算（A / C / D 域）

| 项目 | Star / License | 定位 | 覆盖 | 局限 |
|---|---|---|---|---|
| **BerriAI/litellm** | 约 60.7k / MIT（`enterprise/` 另许可）/ Python | 100+ LLM 统一 OpenAI 格式网关，SDK + Proxy Server 双形态 | **A** + **C**（Router retry/fallback、负载均衡）+ **D**（virtual key + spend tracking + 多租户） | 定位「团队/企业集中式网关」，非个人终端；**无人民币计价**、无 TUI、无订阅套利 |
| **QuantumNous/new-api**（原 `Calcium-Ion/new-api`，已迁移） | 约 49.5k / **AGPL-3.0** / Go | 自托管 AI 网关，聚合上游渠道 + 多协议转换 + 计费分发 | **A** + **C**（渠道优先级/权重/重试/亲和性）+ **D**（配额/订阅/缓存计费/表达式定价）+ **J**（中文原生 7 语 UI） | 面向「中转/二次分发」运营场景，需 Web 控制台操作；非 agent 终端；AGPL 有传染性 |
| **musistudio/claude-code-router** | 约 37.6k / MIT / Node-TS | 本地模型网关 + 控制平面，让 Claude Code / Codex / Grok CLI / Kimi CLI / OpenCode / ZCode 共享一个稳定本地端点 | **A** + **C**（retries + credential pools + key rotation + 有序 fallback）+ **J**（中文 README） | **本桶与 khy-os 定位最接近的直接竞品**；但聚焦 coding agent，非通用「吃遍所有 AI 订阅」；无人民币计价、无 TUI、工具扩展靠 MCP 而非 CLI-Anything |
| songquanpeng/one-api | 约 37.1k / MIT / JS | LLM API 管理与分发系统，new-api 的上游原型 | **A** + **J**（国内模型列举最全） | **维护明显放缓**（main 分支 2025-02-21 后无提交，v0.6.10）——社区重心已转 new-api |
| Portkey-AI/gateway | 约 13.2k / MIT / Node-TS | 高速 AI 网关，路由 1600+ 模型 + 50+ guardrails | **C**（本桶最完整：自动重试至 5 次 + 指数退避 + fallback + 负载均衡 + 条件路由）+ **D** | 企业/应用侧网关；中文支持弱；公司有商业云 |
| tensorzero/tensorzero | 约 11.7k / Apache-2.0 | LLMOps 平台：统一网关 + 可观测 + 评估 + 优化 + 实验 | **A** + **D** | 偏 ML 工程工作流，非个人订阅套利 |
| maximhq/bifrost | 约 8.7k / Apache-2.0 / Go | 高性能企业网关（宣称比 LiteLLM 快 50 倍），自适应负载均衡 + 集群 + guardrails + 1000+ 模型 | **A** + **C** + **D** | 企业向；缺中文与终端形态 |
| katanemo/archgw | 约 7.1k / Apache-2.0 | AI-native 代理与数据平面，智能 LLM 路由 + 可观测 + agent 编排 + guardrails | **A** + **C** | 偏服务侧；与「智能体终端」仅部分重叠 |
| lm-sys/RouteLLM | 约 5.6k / Apache-2.0 / Python | 强弱模型分流降本的路由器框架 | **C**（成本优化） | **非生产网关**：main 最新提交 2024-08-10，基本停滞；无多协议、无计费、无部署形态 |
| LeenHawk/gproxy | 约 251★ / **AGPL-3.0** / Rust | 多通道 LLM 代理，暴露 OpenAI/Claude/Gemini 统一 API + 内置管理界面 | **A** + **C** | 体量小，但**定位与 khy-os 高度重合**——值得持续观察的小对手 |

**本桶关键发现**：
1. **「多供应商 + 容错 + 成本核算」三项已被做到极致**（LiteLLM 60.7k / new-api 49.5k），khy-os 在此维度**难以正面取胜**——A/C/D 三域的零件级对手比 khy-os 强一个数量级（star 与生态）。
2. **本桶全部项目的 README 中 RMB/CNY/¥ 命中数为 0**——人民币计价是真实的空位，且与 khy-os 的 `tokenUsageService`（USD→CNY 7.25）直接对应。
3. **claude-code-router 是最直接竞品**：它已把「一个本地端点吃遍所有 agent + 供应商 + 凭据池」做成产品（37.6k★）。khy-os 相对它的差异只剩：人民币计价核算、TUI 原生终端、CLI-Anything 工具化、pip+npm 双渠道。
4. **License 风险**：new-api 与 gproxy 是 AGPL-3.0，对商用分发有传染性；LiteLLM 核心 MIT 但 `enterprise/` 目录另许可。
5. **维护风险参照**：one-api 与 RouteLLM 已实质停滞——本桶项目不持续投入会快速掉队。

**未核实清单（已剔出矩阵）**：`y-router`（GitHub 搜索无结果，`ypwhs/y-router` 返回 404）、`Cloudflare/ai-gateway`（404）、`tpxin/gpt-load`（404）。

### 桶 2 · 订阅套利：relay / 转换（B 域）

| 项目 | Star / License | 定位 | 覆盖 khy-os 能力域 | 局限 |
|---|---|---|---|---|
| **router-for-me/CLIProxyAPI** | 约 54.7k / MIT / Go | 把 Antigravity、ChatGPT Codex、Claude Code、Grok Build、Muse Code、Devin、Kimi、Gemini CLI 的**登录态**封装成 OpenAI/Gemini/Claude/Codex 兼容 API | **B**（本族绝对头部，9 家客户端登录态） | **v6.10.0 起官方移除内置用量统计与计费**（改推第三方 CPA-Manager-Plus）；无 per-key 计费、无熔断；ToS 风险靠外链指南而非 README 声明 |
| **Wei-Shaw/sub2api** | 约 43.6k / **LGPL-3.0** / Go | 自称 "AI API Gateway Platform for Subscription Quota Distribution"，统一接入 Claude/OpenAI/Gemini/Grok 订阅 + 拼车共享分摊 | **B** + **D**（token 级精确计费）+ **C**（`billing.circuit_breaker`）+ **A**（Composite Groups 多供应商路由）+ 粘性会话 | LGPL-3.0 copyleft；依赖重（Go 1.27 + Vue + PostgreSQL 15 + Redis 7）；README 显式声明 ToS 风险与「未授权任何商业运营」 |
| **musistudio/claude-code-router** | 约 37.6k / MIT / TS | 本地控制平面，跨模型路由 orchestration | **A** + **C** | 偏「路由/反向注入」，不做订阅态转换本身 |
| **Wei-Shaw/claude-relay-service (CRS)** | 约 12.7k / MIT / JS | 自建 Claude Code 镜像中转：多账户自动轮换 + 独立 API Key + 用量统计 + 账户故障自动切换 + 监控面板 + 速率限制 + 粘性会话 | **B** + **C** + **D** | 单一大族（Claude 为主、Gemini CLI 为辅）；重依赖（Node 18+ / Redis 6+）；显式声明「可能违反 Anthropic 服务条款」 |
| **justlovemaki/AIClient2API**（仓库名**无连字符**） | 约 8.9k / **GPL-3.0** / JS | 模拟 Antigravity/Codex/Grok/Kiro/OpenAI/Claude 客户端请求，封装为本地 OpenAI 兼容接口；provider pools + smart routing + automatic failover | **B** + **C**（automatic failover） | GPL-3.0 比 MIT 更严；Docker 下载 >100k 但 star 仅 8.9k（用户/star 比反常） |
| **ccusage/ccusage** | 约 18.9k / NOASSERTION / Rust | `npx ccusage`，Claude Code 本地 JSONL 用量/成本统计（已由 TS 重写为 Rust） | **D**（可观测性单点） | **只读统计**，不代理、不套利、无容错 |
| **单家转换器（整体碎片化）** | 见下 | cursor / kiro / trae / qoder / gemini 各自一个转换器 | **B**（单家） | 全部 <2k star 且多个同名仓库互相抢注；无计费、无熔断；上游改接口即集体失效 |
| ├ `7836246/cursor2api` | 约 1.9k / MIT | Cursor Web Docs → OpenAI/Anthropic | B | **2026-06 起停更** |
| ├ `Quorinex/Kiro-Go` | 约 1.2k / MIT / Go | Kiro → OpenAI/Anthropic，账号池 + 自动刷新 token + Web 面板 | B | 与 `caidaoli/kiro2api`（约 637★）并存，另有 8 个小 fork |
| ├ trae 系 | 全部 <80★ | `linqiu919/trae2api`（**已 archived**）等 4 个同名仓库 | B | 无一家成气候 |
| └ qoder 系 | ≤105★ | 6 个仓库抢同一名字 | B | 同上 |

**本桶关键发现**：① 赛道已高度拥挤且头部集中——CLIProxyAPI + sub2api 合计约 **9.8 万 star**；② **sub2api 已把「token 级计费 + 计费熔断 + 拼车分摊」做完**，khy-os 的 D 域若停在「人民币计价」层面会被直接压制；③ 单家转换器全部碎片化，说明「一个终端吃遍所有订阅」的聚合价值真实存在，但也意味着**上游接口一变就集体失效**——容错与自愈是硬门槛而非加分项；④ **License 是隐藏战场**：本族前三名里 sub2api 是 LGPL-3.0、AIClient2API 是 GPL-3.0，大量小仓库无 license。

**未核实清单（已剔出矩阵）**：`luispater/CLIProxyAPI`（实际头部是 `router-for-me/CLIProxyAPI`）、`wei/kaisir` 系 claude-relay-service（实际是 `Wei-Shaw/`）、`y-cli`（检索命中全是 YouTube/music cli）、`gemini-cli2api` 作为独立仓库名（仅命中 `neipor/codebuddy-cli2api` 6★）。

### 桶 3 · 智能体终端：TUI / CLI / 桌面壳（E 域）

| 项目 | Star / License | 形态 | 覆盖 | 局限 |
|---|---|---|---|---|
| **anomalyco/opencode**（原 `sst/opencode`，组织已改名） | 约 212.4k / MIT / TS | TUI + 桌面 GUI + 服务端，多供应商、本地模型、LSP、MCP、会话分享 | **E** + **A** + **H** | 「The open source coding agent」定位与 khy-os **直接重叠**；Node 依赖重，冷启动与便携性非其目标。**khy-os 的 `opencodeAdapter` 正是指挥这个 21 万星的 CLI** |
| openai/codex | 约 128.4k / Apache-2.0 / Rust | CLI + IDE + 沙箱执行，MCP | **E** | 强绑定 OpenAI 订阅/API，非中立多供应商；国内网络不可直连 |
| google-gemini/gemini-cli | 约 107.3k / Apache-2.0 / TS | REPL CLI + 非交互，MCP client/server，三种鉴权 | **E** | 以 Gemini 为中心；免费额度受 ToS 约束，非本地优先 |
| **OpenHands/OpenHands**（原 `All-Hands-AI/OpenHands`） | 约 90.4k / MIT / Python | Web UI + 本地/云端沙箱 + CLI | **E** + **F**（Web） | 偏「云端开发环境」，资源占用高，与 khy-os 的便携/终端形态错位 |
| aaif-goose/goose（原 `block/goose`） | 约 55.1k / Apache-2.0 / Rust | 桌面 GUI + CLI，MCP + **ACP** + Ollama 本地模型 | **E** + **G**（ACP） | 偏通用 agent 非纯 coding；国内可用性依赖自备 key |
| earendil-works/pi | 约 113.8k / MIT / TS | TUI/CLI + SDK + RPC；monorepo 拆出 `pi-ai`（统一多供应商）/`pi-tui`（差分渲染）/`pi-durable` | **E** + **A** + **H**（**extensions / skills / prompt-templates / themes / packages 经 npm 分发**——与 khy-os 技能系统高度同构） | README 明示**无内置权限系统**、无 sub-agent 与 plan mode |
| **iOfficeAI/AionUi** | 约 33.4k / Apache-2.0 / TS-Electron | Electron 桌面壳，**自动探测并托管 20+ 已装 CLI agent**（Claude Code / Codex / Qwen Code / Gemini CLI / Goose / OpenCode / Pi / Qoder / Cursor Agent…） | **E** + **F**（**WebUI 手机/平板远程，二维码或密码登录，LAN/跨网/服务器**）+ **J**（**Telegram/飞书/钉钉/微信/企业微信/Slack/Discord 直连**）+ **A** + **G** + **H**（21 助手 + Skills + Team Mode 多代理） | ⚠ **本桶最关键的同类竞品：几乎完整覆盖 khy-os「手机远程 + 中文 IM + 多供应商 + MCP + 多智能体 + 技能」全清单**；但重 Electron、非便携、非终端原生；2026-09-09 后约一个月未提交 |
| bytedance/UI-TARS-desktop | 约 39.2k / Apache-2.0 | 多模态 GUI agent 栈，桌面控制 | **J**（中文） | 重心在 computer-use，非终端 coding agent |
| Aider-AI/aider | 约 49.4k / Apache-2.0 / Python | 终端 pair-programming，Git 集成 + repo map + 多供应商 | **E** + **A** | **2026-05-22 后近 5 个月无提交**，活跃度明显下滑；无 MCP/子代理 |
| charmbracelet/crush | 约 28.6k / **FSL-1.1-MIT（非 OSI 开源）** / Go | TUI，多供应商 + MCP + LSP + Ollama + skills | **E** + **A** + **H** | FSL 许可（两年后转 MIT），商用/二次分发受限 |
| QwenLM/qwen-code | 约 28.4k / Apache-2.0 / TS | REPL CLI，MCP + subagent + skills + 插件 + Ollama + 中文文档 | **E** + **H** + **J** | 以 Qwen3-Coder 为中心；国内云服务绑定 |
| plandex-ai/plandex | 约 15.7k / MIT / Go+TS | CLI + 自托管 server，累积 diff 沙箱 | **E** | **main 2025-10-03 后停更约一年**；Windows 仅 WSL |
| sigoden/aichat | 约 10.5k / Apache-2.0+MIT 双许可 / Rust | REPL + CMD + Shell Assistant + RAG + function calling + MCP + AI Agents + 本地 server/arena | **E** + **A** + **I**（Rust 单二进制便携思路） | **功能面与 khy-os「REPL + 一次性调用 + 多供应商 + 本地优先」重合度最高**；无 TUI 渲染层、无子代理编排；2026-02-23 后放缓 |
| shareAI-lab/Kode-CLI | 约 5.2k / Apache-2.0 / TS | CLI，skills / plugins / subagent / MCP，中文 README | **E** + **H** + **J** | star 基数小，2026-08-27 后放缓 |
| **iflow-ai/iflow-cli** | 约 5.1k / **未标注 license** | 曾定位「免费模型 + 终端 agent + MCP + subagent + 插件」 | **E** + **J** | ⚠ **已宣布 2026-04-17 停运，最后提交 2026-03-20，项目实质死亡**——国内同类 CLI 的生命周期风险警示案例 |

**本桶关键发现**：
1. **E 域是 khy-os 最拥挤的一桶，且头部星数高出 4 个数量级**（opencode 212k / codex 128k / gemini-cli 107k vs khy-os PyPI 月下载 173）。**在「终端 agent」这一格正面对攻＝结构性必输**，与 [`INIT-PRD-005`](../../01_INIT_立项/INIT-PRD/[INIT-PRD-005] 市场立足点与竞品格局.md) §2.1 结论 A 同向，但本文给出了开源侧的量级证据。
2. **AionUi 必须被正面承认**：它把 khy-os 原以为独占的「手机远程 + 微信/飞书/钉钉 + 多供应商 + 技能」做成了 33.4k★ 的产品。khy-os 的 F 域叙事（T-001/T-013/T-022 全 todo）**不是「别人没做」，而是「别人已经做了且做得更大」**——这是本文相对 INIT-PRD-005 的净增量。
3. **AionUi 的反面正是 khy-os 的位置**：重 Electron、非便携、非终端原生、一个月未提交。**「便携/随盘漂移 + 终端原生 + 冷启动 <100ms」这一格仍无人占据**（本桶无一项目以此为目标；aichat 的单二进制便携思路最接近但无 TUI）。
4. **技能/扩展是共识方向**：pi 的 packages、crush 与 qwen-code 的 skills、AionUi 的 assistants 在 2025–2026 集中落地 ⇒ khy-os 的 `khy.extension.json`（10 个）+ 模块化打包方向正确，但**缺 npm/git 可分发的打包形态**（pi 的 Pi packages 是标杆）。
5. **License 是隐性卖点**：crush 用 FSL（非 OSI 开源），codex / gemini-cli / qwen-code 强绑自家模型服务 ⇒ khy-os 的宽松许可 + 多供应商中立 + 本地优先组合在合规审查场景有优势（但前提是**先有 license**，见 §六·5）。

### 桶 4 · 自托管平台与多模型客户端（A / H / I / J 域，无 B/C/D/E）

> 本桶数据由 README 关键词计数（`ollama|multi-provider|any model|API key` / `self-host|offline|on-premise|your data` / `plugin|extension|marketplace|tool` / `中文|Chinese` / `billing|quota|pricing`）+ license 抓取获得，**非二手转述**。

| 项目 | Star / License | README 关键词证据 | 覆盖 | 局限 |
|---|---|---|---|---|
| **langgenius/dify** | 约 158k / 自定义（GitHub 未自动识别，需看仓库 LICENSE） | local=6, billing=4, zh=2, multi=0, plugin=1 | **H**（工作流/插件）+ **J** + **D**（billing 命中 4 次，本桶最高） | 是 LLMOps **平台**，不是终端；多供应商接入表述弱（multi=0）；无订阅套利、无 TUI |
| **open-webui/open-webui** | 约 154k / 自定义（含自有 branding 条款，需看仓库 LICENSE） | **multi=16**（本桶最高）, local=7, plugin=7, zh=0, billing=0 | **A** + **H**（插件/函数）+ **I**（Ollama 离线） | **中文命中 0**；无计费、无订阅套利、无终端形态；Web UI 依赖重 |
| **Yidadaa/ChatGPT-Next-Web** | 约 89k / MIT | （见桶 6） | **A** + **I** + **J** | 纯对话 UI，无 agent 交付力 |
| **lobehub/lobe-chat** | 约 83k / 自定义（需看仓库 LICENSE） | （见桶 6） | **A** + **H**（插件市场）+ **I** + **J** | 无计费、无终端 |
| **Mintplex-Labs/anything-llm** | 约 67k / MIT | plugin=6, multi=2, local=2, zh=1, billing=0 | **H**（agent/工具）+ **A** + **I** | 定位「本地 RAG/文档问答」，非编码 agent；无计费 |
| **CherryHQ/cherry-studio** | 约 52k / **AGPL-3.0** | （见桶 6） | **A** + **D△** + **H** + **J** | 非 coding agent；无网关容错 |
| **Aider-AI/aider** | 约 49.4k / Apache-2.0 | （见桶 3） | **E** + **A** | 已放缓（2026-05-22） |
| **danny-avila/LibreChat** | 约 45k / MIT | **plugin=15**（本桶最高）, multi=1, local=2, zh=2, billing=0 | **H**（插件市场最成熟）+ **A** + **I** + **J** | 无计费、无终端；多供应商表述弱 |
| **menloresearch/jan** | 约 45k / 自定义（需看仓库 LICENSE） | plugin=5, local=1, multi=0, zh=1, billing=0 | **I**（本地离线优先）+ **H** | **多供应商命中 0**（定位本地模型优先）；无计费 |
| **labring/FastGPT** | 约 30k / 自定义（需看仓库 LICENSE） | local=4, zh=1, multi=0, plugin=1, billing=0 | **H**（知识库/工作流）+ **J**（中文原生） | 定位知识库问答，非 agent 终端；无计费 |
| **chatboxai/chatbox** | 约 42k / **GPL-3.0** | zh=3（本桶最高）, multi=1, plugin=0, local=1, billing=0 | **A** + **I** + **J** | **插件命中 0**（无扩展机制）；纯客户端 |

**本桶关键发现**：
1. **本桶无一项目进入 B/C/E 三格**——自托管平台全部止步于「接多家 API + 插件 + 本地部署」，**没有一家做订阅套利，没有一家做熔断降级，没有一家是终端形态**。这从反面印证了 khy-os「应用层之下」那一格（L2/L1）的真实空位。
2. **但本桶的 A/H/I/J 四格做得比 khy-os 深**：OpenWebUI 154k★ 的插件生态、LibreChat 15 处 plugin 命中的成熟市场、Dify 158k★ 的工作流——khy-os 的 H 格（10 个 `khy.extension.json`）在这一桶面前是**最小的一份**。
3. **中文不是本桶的强项**：open-webui 与 jan 的中文命中为 **0**；中文命中最高的是 chatbox（3）。**「中文优先 + 多供应商 + 终端」三合一仍然空缺**——这解释了 cherry-studio（52k★）为何能以「非 coding agent」的身份拿到中文桌面客户端第一。
4. **License 混乱是本桶的共性**：7 个项目里 4 个是自定义许可（GitHub 无法自动识别），2 个强 copyleft（AGPL/GPL）——**没有任何一个头部项目处于「无 license」状态**，而 khy-os 正是无 license（见 §六·5）。

### 桶 5 · 手机 / IM 远程控制（F 域）

| 项目 | Star / License | 形态 | 覆盖 | 局限 |
|---|---|---|---|---|
| **openclaw/openclaw** | 约 392k / MIT | "Any OS. Any Platform" 个人 AI 助手：Gateway + 20+ 渠道（Discord/iMessage/Slack/Teams/Telegram/WhatsApp）+ 全平台原生 App | **F**（渠道矩阵的架构范式） | **无微信、无中文渠道**；定位通用助手而非 coding agent 优先 |
| **zhayujie/chatgpt-on-wechat（已更名 CowAgent）** | 约 47k / MIT / Python | 微信 AI bot 事实标准，正向 multi-agent harness 演进 | **F**（微信入口）+ **J** | 依赖 hook 协议（Windows 个人号），合规/封号风险固有 |
| **langbot-app/LangBot** | 约 18k / Apache-2.0 / Python | 生产级多平台 IM 机器人平台（Discord/Slack/微信…），agent + 知识库 + 插件 | **F** + **H** + **J**（中文原生文档） | 是「IM 机器人平台」，不带编码 agent 交付力 |
| siteboon/claudecodeui | 约 14k / **AGPL-3.0** / TS | 手机 + Web 用 CloudCLI 驱 Claude Code / Cursor CLI / Codex | **F** + **E** | AGPL copyleft；无网关层 |
| lich0821/WeChatFerry | 约 6.8k / MIT / C++ | 微信 hook 机器人底座 | **F**（微信通道底座） | 封号风险；非 agent |
| K9i-0/ccpocket | 约 1.1k / MIT / Dart | **Flutter** 手机客户端 WebSocket 桥接 | **F**（与 khy-os T-013 的 Flutter 方案同构） | 1.1k★，规模小 |
| tanS/collie | 约 1.3k / MIT / TS | 自托管 PWA（iPhone/Android）驱动 tmux 里的 Claude Code/Codex | **F** | 依赖 tmux 会话模型 |
| happier-dev/happier | 约 1.9k / MIT / TS | 手机/桌面/浏览器控制 100+ coding agent，E2E 加密 | **F** + **G**（指挥多 agent） | 只做控制面，不做模型网关 |
| omnara-ai/omnara | 约 2.9k / Apache-2.0 / Go | 自托管 managed agent 平台 | **F** | 偏云端平台，非移动优先 |
| xvxv-stack7/android-claude-wechat | 约 9★ / MIT / Shell | 「免电脑，一条命令在安卓跑 Claude Code + 接入微信 + DeepSeek 平替」 | **F** + **J** | **与 khy-os 的 (A) 维度最同构，但仅 9★**——同构不等于有人做成了 |
| 其余（JessyTsui/Claude-Code-Remote 1.3k★ 停更、Nexting-ai/nexting 1.8k★、agent-of-empires 3.3k★、codexia 0.9k★、friuns2/codex-mobile 957★、slopus/happy-cli 553★ 停更…） | — | 轻量远程控制面 | **F** | 全部 <3.5k★；`cc-mobile` 未核实（仅 1★ 个人仓库） |

**本桶关键发现**：
1. ⚠ **初版结论被推翻，特此留痕**：本轮调研初稿曾判「远程控制赛道全部止步于 Discord/Telegram/WhatsApp/iMessage，唯一触及微信的 `android-claude-wechat` 仅 9★」。桶 3 检出 **AionUi（33.4k★，桶 3）已直连微信/企业微信/飞书/钉钉 + WebUI 手机远程**，该判定**不成立**——正确的结论是：**微信 + coding agent 已有 33k★ 级在位者，khy-os 的 F 域不再是空位。**
2. 但空位仍然存在，只是换了形状：OpenClaw 定义了「IM 即遥控器」的架构范式（Gateway + 20+ 渠道 + 全平台原生 App，无付费层），**却独缺微信与中文渠道**；微信个人号 hook 路线（WeChatFerry / CowAgent 系）自带封号风险。**「合规微信通道 + 便携本地 agent」这一交叉点仍无人占据**——这是 F 域仅剩的差异形状，且必须先解决 hook 路线的合规问题。
3. 手机远程的技术方案已高度同质化：Flutter（ccpocket）、PWA（collie）、WebUI（claudecodeui / AionUi）、Termux（codex-mobile）、tmux 桥接（collie / 9remote）——**khy-os T-013 选 Flutter 没有技术风险，风险只在尚未启动**（`android/` 工程实测不存在）。

### 桶 6 · 中文本土化与便携分发（J / I 域）

| 项目 | Star / License | 覆盖 | 局限 |
|---|---|---|---|
| **CherryHQ/cherry-studio** | 约 52k / **AGPL-3.0** / TS | **J**（中文第一方桌面客户端，300+ 模型、国内模型优先、人民币计费场景） | 非 coding agent；无网关容错；AGPL |
| **Yidadaa/ChatGPT-Next-Web** | 约 89k / MIT / TS | **J**（中文作者出品，国内模型/mirror 优先生态） | 纯对话 UI，无 agent 交付力 |
| **lobehub/lobe-chat** | 约 83k / 自定义 license / TS | **J** + **H**（插件生态成熟） | 同上；license 非标准 |
| **iflow-ai/iflow-cli** | 约 5.1k / **未标注 license** / Rust | **E** + **J**（中文厂商出品的终端 AI CLI，直接对位 khy-os 的终端 + 中文） | **无拼音命令、无网关、无便携分发**；license 未标注 |
| LifeActor/Claude_zh-CN_LanguagePack | 约 213★ | 证明「coding agent 中文化」是真实需求（Claude Code 全平台中文语言包） | 只是语言包 |
| **PACHAKUTlQ/ClaudeCage** | 约 143★ / AGPL-3.0 | **I**（「单文件便携可执行、零依赖」——最贴近零安装单目录分发的 AI 工具先例） | 体量小；沙箱定位而非网关 |
| PortableApps/Installer | 约 9★ | 便携/绿色分发的老牌先例（非 AI 专用） | 非 AI |

**本桶关键发现**：① 「中文 + 拼音命令 + 国内模型镜像优先 + 人民币计价」的中文 coding agent CLI **开源供给几乎只有 iFlow CLI 一家**（且无拼音、无网关）；② **便携/绿色版在 AI 工具侧基本空白**——ClaudeCage（143★）是唯一近例——khy-os「整目录拷贝即用、路径全相对」在开源生态中基本无同类，是 I/J 域最独特的卖点；③ 但** license 是这一侧的硬伤**：本桶头部 Cherry Studio 是 AGPL-3.0，而 khy-os 两个发布渠道都**没有 license 字段**（见 §六·5）。

**未核实清单（已剔出矩阵）**：**Y-code**（未找到任何官方 GitHub 仓库，仅同名无关项目；其自身文档即 PyInstaller 打包分发形态 → 疑似非开源/仅商业产品）；**qodercli**（无官方开源仓库，仅第三方封装 → 同上）。

### 桶 7 · 「同类型」宣称最近者：AI OS / AI Host 命名圈

先说结论：**按名字自称「AI OS / AI host」的项目只有两个，且都不在 khy-os 的能力域交集上。**

| 项目 | Star / License | 自称 | 真实形态 | 与 khy-os 的关系 |
|---|---|---|---|---|
| **kortix-ai/suna** | 约 20k / 无 license 标注 | "The open-source AI Operating System" | 通用 AI agent 平台（对标 Claude Managed Agents / OpenAI Agents API 的自托管形态） | **唯一在命名上同类型的项目**，但形态是「云端 agent 运行时」，**无网关层、无订阅 relay、无终端 TUI、无人民币计价**。约 20k★ 说明「AI OS」这个命名本身不带来采纳 |
| nateherkai/AIS-OS | 约 1.6k / 无 license 标注 | "AI Operating System starter kit" | Claude Code / Codex 的 skill 包（5 个 `/onboard` 类技能） | 是「给 CC 加技能的配置包」，不是系统 |

**判据（「无同类型项目」的最终依据）**：桶 1–6 全部项目（§四 矩阵 45 个开源项目行）中，**没有任何一行同时具备网关域（A/B/C/D）与终端域（E）中的 ≥2 项**——要么是网关无终端，要么是终端无网关，要么是平台两者皆无。「无同类型项目」这一判定由此成立：**不是检索不到，而是形态上不存在**。suna 是唯一在命名上同类型的项目，而它的 20k★ 恰说明「叫 AI OS」与「是 AI 主机」是两件事。

---

## 四、对比矩阵

**列 = khy-os 的 10 个能力域**（定义见 §二）；`✓` 结构性具备、`△` 部分具备、`✗` 结构性不具备、`—` 不适用/形态错位。
**行按功能桶分组**；最后一行是 khy-os 自己。**先看最后一行，再看别人占了它几格。**

| 项目（桶） | Star | A 多供应商 | B 订阅套利 | C 容错路由 | D 成本核算 | E 终端 agent | F 跨形态/随身 | G 吸收第三方 | H 插件技能 | I 本地/便携 | J 中文化 |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| **khy-os**（自侧） | — | **✓** 19 适配器 | **✓** 5 家自实现 | **✓** 熔断+成本λ | **✓** CNY 计价 | **✓** 192 文件 TUI | **△** 半落地 | **✓** cli-gen+定向指挥 | **△** 10 扩展 | **✓** 全相对路径 | **✓** 拼音+CNY |
| LiteLLM（桶1） | 60.7k | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | △ | ✓ | ✗ |
| new-api（桶1） | 49.5k | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | △ | ✓ | ✓ |
| claude-code-router（桶1） | 37.6k | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | △ | ✓ | ✓ |
| one-api（桶1） | 37.1k | ✓ | ✗ | △ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| Portkey gateway（桶1） | 13.2k | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | △ | ✓ | ✗ |
| gproxy（桶1） | 0.25k | ✓ | ✗ | △ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ |
| CLIProxyAPI（桶2） | 54.7k | ✓ | ✓ | ✗ | **✗（v6.10 移除）** | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ |
| sub2api（桶2） | 43.6k | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | △ 重依赖 | ✗ |
| claude-relay-service（桶2） | 12.7k | △ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | △ | △ Redis | ✗ |
| AIClient2API（桶2） | 8.9k | ✓ | ✓ | △ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ Docker | ✗ |
| ccusage（桶2） | 18.9k | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ |
| opencode（桶3） | 212.4k | ✓ | ✗ | ✗ | ✗ | ✓ | △ 桌面+server | △ | ✓ | ✗ Node 重 | ✗ |
| codex（桶3） | 128.4k | ✗ 绑 OpenAI | ✗ | ✗ | ✗ | ✓ | △ IDE | ✗ | ✓ MCP | ✓ Rust | ✗ |
| gemini-cli（桶3） | 107.3k | ✗ 绑 Gemini | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ MCP | ✓ | ✗ |
| pi（桶3） | 113.8k | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ npm 包 | ✓ | ✗ |
| OpenHands（桶3） | 90.4k | ✓ | ✗ | ✗ | ✗ | ✓ | ✓ Web/云 | ✗ | ✓ MCP | ✗ 重 | ✗ |
| goose（桶3） | 55.1k | ✓ | ✗ | ✗ | ✗ | ✓ | △ 桌面 | ✓ ACP | ✓ MCP | ✓ Rust | ✗ |
| **AionUi（桶3）** | 33.4k | ✓ | ✗ | ✗ | ✗ | ✓ | **✓ 手机Web+微信/飞书/钉钉** | ✓ 托管 20+ CLI | ✓ | ✗ Electron 重 | ✓ |
| UI-TARS-desktop（桶3） | 39.2k | △ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ |
| aider（桶3） | 49.4k | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ |
| crush（桶3） | 28.6k | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ skills | ✓ Go | ✗ |
| qwen-code（桶3） | 28.4k | ✗ 绑 Qwen | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ |
| plandex（桶3） | 15.7k | △ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ |
| aichat（桶3） | 10.5k | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ Rust 单二进制 | ✗ |
| Kode-CLI（桶3） | 5.2k | △ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ |
| iflow-cli（桶3） | 5.1k | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ |
| dify（桶4） | 158k | ✓ | ✗ | ✗ | △ billing | ✗ | ✗ | ✗ | ✓ 工作流 | ✗ 重 | ✓ |
| open-webui（桶4） | 154k | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ 插件 | ✓ Ollama | ✗ |
| anything-llm（桶4） | 67k | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ 工具 | ✓ | ✗ |
| LibreChat（桶4） | 45k | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ 插件市场 | ✓ | ✓ |
| chatbox（桶4） | 42k | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| jan（桶4） | 45k | ✗ 本地优先 | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ 离线 | ✗ |
| FastGPT（桶4） | 30k | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ 知识库 | ✗ | ✓ |
| openclaw（桶5） | 392k | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ 20+ 渠道 | ✗ | ✓ | ✗ | ✗ 无微信 |
| CowAgent（桶5） | 47k | △ | ✗ | ✗ | ✗ | ✗ | ✓ 微信 | ✗ | ✓ | △ | ✓ |
| LangBot（桶5） | 18k | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ IM 平台 | ✗ | ✓ | △ | ✓ |
| claudecodeui（桶5） | 14k | ✗ | ✗ | ✗ | ✗ | ✓ 驱 CC | ✓ 手机+Web | ✓ 驱多 CLI | ✗ | ✗ | ✗ |
| WeChatFerry（桶5） | 6.8k | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ 微信底座 | ✗ | ✗ | ✗ | ✓ |
| ccpocket（桶5） | 1.1k | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ Flutter 手机 | ✗ | ✗ | ✓ | ✗ |
| happier（桶5） | 1.9k | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ 100+ agent | ✗ | ✓ | ✗ |
| cherry-studio（桶6） | 52k | ✓ | ✗ | ✗ | △ 人民币场景 | ✗ | △ 桌面 | ✗ | ✓ | △ | ✓ |
| NextChat（桶6） | 89k | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ Web | ✗ | △ | ✓ | ✓ |
| lobe-chat（桶6） | 83k | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ 插件 | ✓ | ✓ |
| ClaudeCage（桶6） | 0.14k | ✗ | ✗ | ✗ | ✗ | ✓ 沙箱 CC | ✗ | ✗ | ✗ | ✓ 单文件零依赖 | ✗ |
| suna（桶7） | 20k | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ Web/API | ✗ | △ | ✗ | ✗ |

### 4.1 覆盖度计数：谁占了几格

**计分规则**：`✓` = 1 分、`△` = 0.5 分、`✗` = 0 分，满分 10。全 46 行按此规则重算后取前 10：

| 排名 | 项目 | 得分 | 占的是哪几格 |
|---|---|:--:|---|
| **1** | **khy-os** | **9.0 / 10** | **A B C D E G I J**（F△ H△） |
| 2 | AionUi | 6.0 / 10 | A E F G H J |
| 3 | goose | 5.5 / 10 | A E G H I（F△） |
| 4 | new-api | 5.5 / 10 | A C D I J（H△） |
| 5 | LibreChat | 5.0 / 10 | A H I J |
| 6 | lobe-chat | 5.0 / 10 | A F H I J |
| 7 | LiteLLM | 4.5 / 10 | A C D I（H△） |
| 8 | sub2api | 4.5 / 10 | A B C D（I△） |
| 9 | claude-relay-service | 4.5 / 10 | B C D（A△ H△ I△） |
| 10 | cherry-studio | 4.5 / 10 | A H J（D△ F△ I△） |
| — | 其余 36 行 | ≤ 4.0 / 10 | 各占一段，互不重叠；**桶 4 七个自托管平台全部 ≤5.0 且无一家进 B/C/E** |

**这张表是全文的支点，但必须连着一个但是读**：khy-os 以 9.0 分居首，**比第二名高出 3 格**；然而**它没有任何一格是开源界第一**——§4.2 逐格列出，khy-os 只有 B/G/I 三格是第一或并列第一。**覆盖度第一 ≠ 深度第一**，这是「焊接型项目」的结构性处境：护城河在组合里，不在零件里。

### 4.2 单点深度：每一格的最强开源对手

| 能力域 | 开源界最强对手 | khy-os 的位置 |
|---|---|---|
| A 多供应商 | LiteLLM（60.7k，100+ 供应商） | **落后**：19 适配器 vs 100+ 供应商，生态与 star 差 3 个数量级 |
| B 订阅套利 | CLIProxyAPI（54.7k，9 家客户端登录态）+ sub2api（43.6k） | **并列为头部之一**：khy-os 自实现 5 家转换，且是唯一把套利做进终端而非独立服务的 |
| C 容错路由 | Portkey（5 次重试+条件路由）+ sub2api（计费熔断） | **持平或略优**：khy-os 的「档位带 + 成本 λ + 价格覆盖硬规则 + margin」是开源界少见的成本感知路由 |
| D 成本核算 | sub2api（token 级精确计费） | **落后半格**：khy-os 有 CNY 计价但**无 per-key 计费、无月度省钱报告**（T-026 todo）；sub2api 已有 |
| E 终端 agent | opencode（212.4k） | **落后 4 个数量级**：结构性必输（见 §五·1） |
| F 跨形态/随身 | AionUi（33.4k，手机 Web + 微信/飞书/钉钉） | **落后**：khy-os 的 F 域三项关键任务全 todo，`android/` 工程不存在 |
| G 吸收第三方 | AionUi（托管 20+ CLI agent）+ goose（ACP） | **独特**：`cli-gen` 的「任意源码 → App+Tool+Skill」七阶段生成，开源界无同构物 |
| H 插件技能 | pi（npm packages）+ lobe-chat 插件市场 | **落后**：khy-os 仅 10 个 `khy.extension.json`，缺可分发的打包形态 |
| I 本地/便携 | aichat（Rust 单二进制）+ ClaudeCage（单文件零依赖） | **领先**：「整目录拷贝即用 + 路径全相对」在开源生态基本无同类 |
| J 中文化 | cherry-studio（52k）+ new-api（原生中文） | **持平**：拼音命令是独有项，但中文客户端赛道供给充足 |

---

## 五、三条硬结论

### 结论 1：khy-os 原以为独占的两个差异点，都已有在位者——且都是高星在位者

| khy-os 的预设差异 | 开源界实际在位者 | 量级差 |
|---|---|---|
| 「智能体终端」（L4，用户唯一认得出的那一格） | **opencode 212.4k★** / codex 128.4k★ / gemini-cli 107.3k★ | khy-os PyPI 月下载 **173**（[`INIT-PRD-005`](../../01_INIT_立项/INIT-PRD/[INIT-PRD-005] 市场立足点与竞品格局.md) §三，2026-09-23 实拉） |
| 「随身性 / 微信里使唤」（INIT-PRD-005 §4.2 的唯一 wow 点） | **AionUi 33.4k★**：手机/平板 WebUI 远程 + 微信/企业微信/飞书/钉钉/Slack/Discord 直连 + 托管 20+ 已装 CLI agent | 同上；且 khy-os 的 F 域三项关键任务（T-001/T-013/T-022）**全为 todo**，`android/` 工程实测不存在 |

**判读**：这不是「暂时没做」，是「**已经做了而且更大**」。`INIT-PRD-005` §4.2 把随身性定为「唯一的 wow 时刻」时，AionUi 尚未进入视野；本文补上这一条。**F 域从「空位」降级为「落后」，T-001/T-013/T-022 的优先级应据此重排，而不是继续按「独占差异」排期。**

### 结论 2：「多供应商 + 容错 + 成本核算」三格已被做到极致，但「人民币计价」仍是 0 命中空位

- 三格的对手：LiteLLM 60.7k★、new-api 49.5k★、Portkey 13.2k★（容错最完整）、sub2api 43.6k★（token 级计费 + 计费熔断）。**khy-os 在 A 格是 19 适配器 vs 100+ 供应商，在 D 格是「有 CNY 计价但无 per-key 计费、无省钱报告」。**
- **但桶 1 六个项目的 README 中 `RMB` / `CNY` / `¥` 命中数为 0**——人民币计价不是「没人想到」，是「中文出海项目不做、英文项目不做」的结构性空位。
- ⇒ **空位真实存在，但只有一格宽**。它值得投入，因为它同时是获客钩子（能用钱证明）与 `INIT-PRD-005` §4.1 的判据；但它**撑不起一个 OS 叙事**。

### 结论 3：khy-os 唯一无人占据的是三格交叉点，而交叉点的载体还没修好

矩阵 §4.1 说 khy-os 覆盖度第一（9.0/10，比第二名 AionUi 高 3 格），§4.2 同时说它只有三格是第一或并列第一：

| 格 | khy-os 的地位 | 开源界最近对手 |
|---|---|---|
| **B 订阅套利** | **并列头部**（自实现 5 家转换，且唯一做进终端） | CLIProxyAPI 54.7k★ / sub2api 43.6k★（都是独立服务，不是终端） |
| **G 吸收第三方** | **独有**（`cli-gen` 任意源码 → App+Tool+Skill 七阶段生成） | AionUi 托管 20+ CLI（探测式，非生成式） |
| **I 本地/便携** | **领先**（整目录拷贝即用 + 路径全相对） | aichat Rust 单二进制 / ClaudeCage 单文件零依赖（文件级，非目录级） |

**判读**：**「B + G + I」的交叉点无人占据，任何单格都不足为护城河。** 这正是「焊接」的价值——但焊接的载体是「一次安装成功」，而它当前不成立（[`INIT-PRD-005`](../../01_INIT_立项/INIT-PRD/[INIT-PRD-005] 市场立足点与竞品格局.md) §六 / BUG-017 / T-027 doing）。**在一个装不上的包上，三格交叉点等于零格。**

> **附带警示（本矩阵的第五个信号）**：45 行里已有 **5 个项目实质停更**——one-api（main 2025-02-21 后无提交）、RouteLLM（2024-08-10）、plandex（2025-10-03）、aider（2026-05-22）、iflow-cli（2026-04-17 宣布停运）。**单人项目最大的竞品风险不是被超越，是自己停更**——这一条对所有结论都成立。

---

## 六、值得借鉴的点

> 按「对 khy-os 的净增益 × 可落地性」排序。**只登记建议，不改代码**（本文是调研报告）。

### 1. sub2api 的 token 级计费 + 计费熔断 + 拼车分摊（P0，直接对应 T-026）

**对方怎么做**：sub2api（43.6k★）把「订阅配额分发」做成了计费系统——token 级精确计费、速率限制、`billing.circuit_breaker`（计费失败也熔断）、Composite Groups 多供应商路由、拼车共享分摊成本。

**khy-os 现状差在哪**：`tokenUsageService.js` 只有 `costUSD/costCNY` 换算（`USD_TO_CNY = 7.25`），`costByModel.js` 有模型价目，但**无 per-key 计量、无预算上限、无「直连官方价 vs 实际花费」的省钱报告**——而省钱报告正是 `INIT-PRD-005` §4.1 唯一「能用钱证明」的获客判据（T-026 todo）。

**改哪些文件**：`services/tokenUsageService.js`（补 per-key 聚合维度）、`services/costByModel.js`（补「官方直连价」基准）、新增一个 `khy cost report` 类 handler（复用既有 router 注册，不新增顶层入口）。

### 2. pi 的 npm packages 分发形态（P0，对应 H 格落后）

**对方怎么做**：pi（113.8k★）把 extensions / skills / prompt-templates / themes / **packages** 做成 npm 可分发的独立单元——技能不是内置文件，是装得进别人的包。

**khy-os 现状差在哪**：全仓仅 **10 个 `khy.extension.json`**（`delivery/extension/` 下 bridges 2 + scripts 5 + tools 3）+ `works/ship/modules/modules.json` 6 个模块。**没有版本字段、没有分发渠道、没有安装命令**——技能系统方向正确（pi / crush / qwen-code / AionUi 都在 2025–2026 集中落地 skills），但形态停在「仓内文件」。

**改哪些文件**：`khy.extension.json`  schema 补 `version`/`entry`；`works/ship/modules/` 增加单扩展打包目标；`app.js` 的 `cli-gen` 输出侧直接产出一个可分发扩展包（与 G 格合流）。

### 3. AionUi 的「自动探测并托管已装 CLI agent」（P1，G 格从「生成」补到「发现」）

**对方怎么做**：AionUi 自动探测本机已装的 20+ CLI agent（Claude Code / Codex / Qwen Code / Gemini CLI / Goose / OpenCode / Pi / Qoder / Cursor Agent…）并托管为可调度后端。

**khy-os 现状差在哪**：khy-os 已有 `cliToolAdapter.js`（子进程调本地 AI CLI，支持 stream-json）+ `openclawAdapter` / `opencodeAdapter` / `commandCodeAdapter` / `acpAgentAdapter` 四个定向指挥适配器——**能力更强但是「配好了才可用」**，没有「扫一遍本机告诉用户你已装了什么」的发现面。T-025（`khy onboard` 一键纳管）正是这个缺口，目前 todo。

**改哪些文件**：`cliToolAdapter.js` 的探测逻辑提为可复用叶子 + `app.js` 或既有 onboard 命令面复用（不新增顶层入口）。

### 4. Portkey 的条件路由 + guardrails 钩子（P1，C 格补最后一块）

**对方怎么做**：Portkey Gateway 有「条件路由」（按请求特征/元数据选 provider）+ 50+ guardrails（入出口内容过滤）+ 自动重试至 5 次 + 指数退避。

**khy-os 现状差在哪**：`autoModelRouting.js` 已有档位带 + 成本 λ + 价格覆盖硬规则 + margin（[DESIGN-ARCH-185] §5.4），**成本维度甚至强于多数开源网关**；但缺「按请求特征选 provider」的条件路由，缺入出口 guardrails 钩子（`attachmentFailurePolicy.js` 只是附件失败策略，不是内容守卫）。

**改哪些文件**：`gateway/autoModelRouting.js` 的条件分支（保持默认路径逐字节不变，参照 §5.4 的「调用方没给 mode 时走旧路径」写法）。

### 5. License：先把声明补上（P0，但**这是人的决定，本文只登记**）

**事实**：`pyproject.toml` 无 `license` 字段、无 `classifiers`；`works/ship/npm/package.json` 无 `license` 字段；**仓库无 LICENSE 文件**。`node scripts/ci/check-license-tiers.js` 已就此告警（「发布包缺少 license 字段，按规则取最严档处理」）。README 徽章写 "Source-Available"，但没有任何文件兑现它。

**对比**：本矩阵 45 行里，几乎每个头部项目都做了明确 license 声明——sub2api LGPL-3.0、new-api AGPL-3.0、AIClient2API GPL-3.0、crush **FSL-1.1-MIT（非 OSI 开源）**、LiteLLM 核心 MIT + `enterprise/` 另许可。**没有一个 30k★ 级项目是「无 license」状态。**

**为何是人的决定**：选 MIT / Apache-2.0 / BUSL 类 source-available 涉及商业模型与软著申报口径（[`DESIGN-IP-001`] 相关），AI 不代拍。**建议动作：由人选定 license 后补 `pyproject.toml` + `package.json` + `LICENSE` 三处**（R2 密钥红线不涉及，但 B6 软著就绪要求「结果要人能接住」，无 license 的包他人无法合法使用）。

### 6. aichat 的 Rust 单二进制：对 I 格是印证，对首跑是助攻（P2）

**对方怎么做**：aichat 是 Rust 单二进制，开箱即用；ClaudeCage 更激进——单文件可执行、零依赖。

**khy-os 现状差在哪**：khy-os 的便携是**目录级**（整目录拷贝 + 路径全相对），这一点 aichat 做不到；但首跑仍需自动补装 Node 依赖（BUG-017：慢网 8.8 分钟 + bundled `node_modules` 缺失）。**预编译 backend 单文件分发能把「首跑 10 分钟承诺」从「修复」变成「结构上成立」。**

**改哪些文件**：发布链（`scripts/release/`）+ 首跑 bootstrap，**不改运行时逻辑**。与 T-027 同向。

### 7. 五个停更项目的警示：竞品风险的第一名是自己停更（无代码动作）

one-api（main 2025-02-21 后无提交）、RouteLLM（2024-08-10）、plandex（2025-10-03）、aider（2026-05-22）、iflow-cli（2026-04-17 宣布停运）——**本矩阵 45 行中 5 个已实质死亡（约 1/9）**。它们的共同点不是「被更好的项目击败」，是「停止投入」。

对单人项目的含义：本文 §4.2 里 khy-os 落后的 6 格（A/D/E/F/H + E 的数量级差距）**都不需要一次性补齐**，但**每一格都需要一个「不退化的最低投入」**。这与 [`INIT-PRD-005`](../../01_INIT_立项/INIT-PRD/[INIT-PRD-005] 市场立足点与竞品格局.md) §七 R1 的应对（「不要去比平台，去比不属于任何平台」）是同一件事的两种说法。

---

## 七、与既有竞品文档的关系（真源归属）

| 问题 | 真源 |
|---|---|
| 商业在场者怎么站位（CC/Cursor/Trae/ZCode/WorkBuddy/Abu） | [`INIT-PRD-005`](../../01_INIT_立项/INIT-PRD/[INIT-PRD-005] 市场立足点与竞品格局.md) |
| 编码交付力 11 维 / UX 22 维逐项打分 | [`MGMT-RPT-016`]([MGMT-RPT-016] 竞品情报图谱.md) |
| 借鉴项目清单（12 个外部项目的深度） | [`MGMT-RPT-022`]([MGMT-RPT-022] 借鉴项目清单.md) |
| **GitHub 开源生态按功能拆分的对比矩阵** | **本文** |

本文不推翻上述任何一份的口径；本文只回答它们都没回答的问题——**「把 khy-os 拆成零件后，每个零件在开源界的对手是谁、强多少」**。

**一处需要回填的裁定**：本文结论 1 表明 [`INIT-PRD-005`](../../01_INIT_立项/INIT-PRD/[INIT-PRD-005] 市场立足点与竞品格局.md) §4.2 把「随身性」定为唯一 wow 点时漏看了 AionUi。**本文不自行修改 005**（它是定位层真源），只在此登记：**005 §4.2 的「竞品为何做不到：形态锁是它们的商业模型」对 AionUi 不成立**——AionUi 是 Apache-2.0 开源项目，没有「形态锁」的商业动机，它只是还没做便携。建议由人裁定是否回填 005。

---

## 附录 · 复现命令

```bash
# khy-os 自侧锚点（2026-10-10 实测，均可复现）
ls runtime/node/backend/src/services/gateway/adapters/*Adapter.js | wc -l   # 19
find runtime/node/backend/src/cli/tui -name '*.js' | wc -l                 # 192
find . -name 'khy.extension.json' -not -path './node_modules/*' | wc -l    # 10
find runtime/node/backend/src -path '*messaging*' -name '*.js' | wc -l      # 85（微信 ilink）
grep -n "USD_TO_CNY" runtime/node/backend/src/services/tokenUsageService.js # 7.25
grep -n "app cli-gen" runtime/node/backend/src/cli/handlers/app.js         # CLI-Anything 入口
ls android/ 2>/dev/null || echo "android/ 不存在（T-013 未启动）"            # 手机 APK 缺口实测

# 任务面状态（矩阵中「落地度」列的真源）
node -e "const j=require('./works/record/ai/hq/PROGRESS.json');\
for(const i of (j.items||[])) if(/T-0(01|13|14|15|22|25|26)/.test(i.id))\
console.log(i.id, i.state, i.title)"

# 竞品事实（star 数）查询日期：2026-10-10，见各项目链接
```

---

## 参考链接

**桶 1 · 网关层**：https://github.com/BerriAI/litellm ｜ https://github.com/QuantumNous/new-api ｜ https://github.com/musistudio/claude-code-router ｜ https://github.com/songquanpeng/one-api ｜ https://github.com/Portkey-AI/gateway ｜ https://github.com/tensorzero/tensorzero ｜ https://github.com/maximhq/bifrost ｜ https://github.com/katanemo/archgw ｜ https://github.com/lm-sys/RouteLLM ｜ https://github.com/LeenHawk/gproxy

**桶 2 · 订阅套利**：https://github.com/router-for-me/CLIProxyAPI ｜ https://github.com/Wei-Shaw/sub2api ｜ https://github.com/Wei-Shaw/claude-relay-service ｜ https://github.com/justlovemaki/AIClient2API ｜ https://github.com/ccusage/ccusage ｜ https://github.com/Quorinex/Kiro-Go ｜ https://github.com/7836246/cursor2api

**桶 3 · 智能体终端**：https://github.com/anomalyco/opencode ｜ https://github.com/openai/codex ｜ https://github.com/google-gemini/gemini-cli ｜ https://github.com/earendil-works/pi ｜ https://github.com/OpenHands/OpenHands ｜ https://github.com/aaif-goose/goose ｜ https://github.com/iOfficeAI/AionUi ｜ https://github.com/bytedance/UI-TARS-desktop ｜ https://github.com/Aider-AI/aider ｜ https://github.com/charmbracelet/crush ｜ https://github.com/QwenLM/qwen-code ｜ https://github.com/plandex-ai/plandex ｜ https://github.com/sigoden/aichat ｜ https://github.com/shareAI-lab/Kode-CLI ｜ https://github.com/iflow-ai/iflow-cli

**桶 4 · 自托管平台**：https://github.com/langgenius/dify ｜ https://github.com/open-webui/open-webui ｜ https://github.com/Yidadaa/ChatGPT-Next-Web ｜ https://github.com/lobehub/lobe-chat ｜ https://github.com/Mintplex-Labs/anything-llm ｜ https://github.com/CherryHQ/cherry-studio ｜ https://github.com/danny-avila/LibreChat ｜ https://github.com/menloresearch/jan ｜ https://github.com/labring/FastGPT ｜ https://github.com/chatboxai/chatbox

**桶 5 · 手机 / IM 远程**：https://github.com/openclaw/openclaw ｜ https://github.com/zhayujie/chatgpt-on-wechat ｜ https://github.com/langbot-app/LangBot ｜ https://github.com/siteboon/claudecodeui ｜ https://github.com/lich0821/WeChatFerry ｜ https://github.com/K9i-0/ccpocket ｜ https://github.com/tanS/collie ｜ https://github.com/happier-dev/happier ｜ https://github.com/omnara-ai/omnara ｜ https://github.com/xvxv-stack7/android-claude-wechat

**桶 6 · 中文本土化与便携**：https://github.com/PACHAKUTlQ/ClaudeCage ｜ https://github.com/PortableApps/Installer ｜ https://github.com/LifeActor/Claude_zh-CN_LanguagePack

**桶 7 · AI OS 命名圈**：https://github.com/kortix-ai/suna ｜ https://github.com/nateherkai/AIS-OS

**仓内相关真源**：[`INIT-PRD-005`](../../01_INIT_立项/INIT-PRD/[INIT-PRD-005] 市场立足点与竞品格局.md) ｜ [`MGMT-RPT-016`]([MGMT-RPT-016] 竞品情报图谱.md) ｜ [`MGMT-RPT-022`]([MGMT-RPT-022] 借鉴项目清单.md) ｜ `[DESIGN-ARCH-185] 四档模式与智能路由方案` ｜ `[DESIGN-ARCH-184] khy-os 接入编辑器 ACP`

---

## 变更记录

- 2026-10-10：初版。先按「同类型」整体检索，判定开源界无同时覆盖网关域（A/B/C/D）与终端域（E）≥2 项的项目；据此把 khy-os 的 11 个能力域按 A–K **全部实测钉死**（含 3 处初稿误判的自证：F 域从「全部未落地」修正为「半落地」、B 域从「委派外部服务」修正为「自实现 5 家转换」、G 域补出四个定向指挥适配器），拆成 **7 桶**调研 45 个开源项目，形成 10 能力域 × 46 行的对比矩阵。
- 同日自纠两条：① 覆盖度计分初版混用「✓ 计」与「△ 折算」两套规则，已统一为 ✓=1/△=0.5 并重算全 46 行；② 桶 5 初版「远程控制无人做微信」的结论被桶 3 检出的 AionUi（33.4k★，微信/飞书/钉钉直连）推翻，已在桶 5  Findings 中留痕更正，并据此在 §五 结论 1 把 F 域从「空位」改判为「落后」。
- 桶 4（自托管平台）的 README 关键词证据与 license 为本报告自行抓取核实（`raw.githubusercontent.com` + shields.io），非二手转述；star 数查询日期统一为 2026-10-10。

