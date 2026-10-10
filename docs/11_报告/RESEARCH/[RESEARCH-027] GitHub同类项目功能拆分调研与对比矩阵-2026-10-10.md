# [RESEARCH-027] GitHub 同类项目调研与功能拆分对比矩阵

> 调研日期：2026-10-10。对照对象：本仓库 khy-os（`runtime/node/backend/`，1.2.0）。
> 实测仓库约 **148 个**，星标与许可证均从一手源取数（口径见 §2.2）。
>
> **结论先行**：GitHub 上不存在与 khy-os 同类型的单一开源项目，**但有三个高重合对手**——
> `QwenLM/qwen-code`（28 386★，功能集最接近，13/15 域重合）、
> `zhayujie/CowAgent`（47 303★，定位最像的国产项目）、
> `iOfficeAI/AionUi`（33 402★，「托管约 25 个 agent 的桌面宿主」这一新物种）。
> 星标最高的相关项目是 `obra/superpowers`（297k★，技能框架 + 方法论层）与
> `openclaw/openclaw`（392k★，个人助理操作系统）。
> 因此本报告按功能拆成 15 个可比域逐域对标，最后汇成一张总矩阵。
>
> **三条最该被读到的修正**（都推翻了开工时的先验假设）：
> ① 「订阅套利网关」**不是** khy-os 独创——CLIProxyAPI 与 OmniRoute 已在对标位上；
> ② 「IM 遥控 agent」已是中国赛道**标配**，不是差异点；
> ③ khy-os 的真实护城河收窄为**工程治理（D15）**与**自愈/自治（D12）**两项——
> 这两项在约 148 个仓库中是孤例，也因此**没有外部参照系**。

---

## 1. 结论（TL;DR）

| # | 结论 | 证据 |
|---|---|---|
| 1 | **无单一同类项目** | 15 个可比域中，没有任何一个 OSS 项目覆盖超过 13 个；覆盖最多的是 OpenClaw 与 Dify（各 13/15）。把 khy-os 用 OSS 拼出来需要 ≥8 个独立项目、4 套部署、3 种语言运行时 |
| 2 | **但有三个「高重合」对手，先验假设被修正** | ① `QwenLM/qwen-code`（28k†）**功能集最接近**（13/15 域重合，含 Agent Teams/Auto-Memory/Auto-Skills/Plan Mode/LSP/Worktrees/Daemon Mode/Agent Arena）；② `zhayujie/CowAgent`（47k†）**定位最像的国产项目**（自演化 + IM + Skill Hub）；③ `iOfficeAI/AionUi`（33k†）代表新物种「托管约 25 个 agent 的桌面宿主」。另外「订阅套利网关」**不是** khy-os 独创——CLIProxyAPI（55k†）与 OmniRoute（75k†）已在对标位上 |
| 3 | **khy-os 的真实护城河收窄为两项** | ① **工程治理（D15）**：3 233 测试 + 101 守卫 + 规则登记表 + 2500 行 god-file 门——约 148 个仓库中孤例；② **自愈/自治带策略与安全闸门（D12）**：约 148 个仓库中无对应物。其余「领先项」多有对手已在追赶 |
| 4 | **「技能」已赢扩展单元之争，但 khy-os 没有市场** | `obra/superpowers`（297k†）装进约 16 个 harness；OpenClaw 有 ClawHub、Kilo 有 Marketplace、CowAgent 有 Skill Hub、cognee/Dify/Qdrant 都有市场。khy-os 有 49 个内置技能 + 双 harness 桥，**但零分发渠道** |
| 5 | **可借鉴的硬缺口有 22 个**（5×P0 / 6×P1 / 7×P2 / 4×P3，见 §7） | 排前三位：**ACP 互操作**（OpenHands/goose/AionUi/Kode/Qwen Code 全说它，没有它 khy-os 对新兴宿主层不可见）、**无头 Agent Server + SDK 拆分**（OpenHands 的共识架构）、**daemon 多客户端模式**（Qwen Code / jcode） |
| 6 | **许可证红线 6 类**（见 §9） | AGPL-3.0 ×8（QAnything/new-api/RustDesk/renovate/trufflehog/skyvern/all-api-hub）+ GPL ×3；非 OSI ×5（n8n Sustainable Use / inngest SSPL / restate BSL / Phoenix ELv2 / Vault BUSL）；Dify 改良 Apache-2.0；`anthropics/skills` 文档技能 source-available；crush FSL-1.1-MIT；autogen CC-BY-4.0——均**不可**随意拷入 |
| 7 | **可持续性警报** | 本窗口内 `Continuedev/continue`（36k†，README: "no longer actively maintained and is read-only"）与 `RooCodeInc/Roo-Code`（24k†，README: "shut down on May 15th"）**先后退场**（README 原文核实）。goose 移交 Linux Foundation、OpenClaw 由 501(c)(3) 托管——**法人托管 + 明文维护模型已成入场券** |

---

## 2. 调研方法与数据口径

### 2.1 为什么必须「按功能拆分」

本次调研的第一步就是**试图找整体同类项目**，做法是把 khy-os 的能力拆成 15 个域（§4），
再拿每个候选项目去比对。结果是：候选集里覆盖度最高的是 OpenClaw 与 Dify（各 13/15），
而**它们缺的恰好是 khy-os 最重的三块**——OpenClaw 缺 D1/D12（编码智能体工具系统、自愈），
Dify 缺 D12/D14/D15（自愈、消息通道遥控、工程治理）。
「一个 CLI 同时是编码智能体 + 多供应商网关 + 自治运行时 + 治理矩阵」这个组合在 OSS 里没有先例，
所以整体对比只能得到「都不完全像」的结论，**必须**按功能拆分才有信息量。

更关键的是：拆分之后才发现，**有几个项目在个别域上已经反超 khy-os**
（Qwen Code 的 Agent Arena / Daemon Mode / Auto-Skills，AionUi 的 Team Mode，
CLIProxyAPI 的订阅账号池，OmniRoute 的免费渠道编目方法论）。
这些在「整体对比」里会被平均值抹掉，在「逐域对比」里才看得见——
这正是按功能拆分的实际收益，而不只是形式。

### 2.2 星标与许可证的取数方式（重要口径）

GitHub REST API 在调研期间对本机 IP **返回 429 rate limit exceeded**（未认证配额耗尽，
`gh` CLI 本机未安装）。因此所有星标与许可证改由 **shields.io 的 GitHub badge API** 取数：

```bash
curl -s "https://img.shields.io/github/stars/<owner>/<repo>.json"      # → {"message":"90k"}
curl -s "https://img.shields.io/github/license/<owner>/<repo>.json"    # → 许可证短名
curl -s "https://raw.githubusercontent.com/<owner>/<repo>/HEAD/LICENSE" # → LICENSE 首行原文
```

- shields.io 的 badge 数据**派生自 GitHub 自身**，与 GitHub 页面显示一致，可作准；
- 星标为 shields 的**取整显示**（`90k` 而非 `90 137`），精度到千位；
- 少量仓库 shields 无法分类许可证（返回 `not identifiable by github`），
  这类改用 `raw.githubusercontent.com` 抓 `LICENSE` 首行原文判定，本文标注「(LICENSE 原文)」；
- 所有星标后带 `†` 者为 shields 取数，带 `‡` 者为子智能体经 GitHub API 精确取数。
- **未验证项一律标注「未验证」**，不做推测。

### 2.3 khy-os 侧读数的取数方式

khy-os 的每个数字都用可复现命令取得，格式为「读数 + 命令」：

| 项 | 读数 | 命令 |
|---|---|---|
| JS 文件数 | 6 599 | `find runtime -name "*.js" -not -path "*/node_modules/*" \| wc -l` |
| JS 总行数 | 1 450 585 | `find runtime -name "*.js" … -exec cat {} + \| wc -l` |
| `src/services/` 顶层模块 | 693 | `ls src/services/*.js \| wc -l` |
| `src/tools/` 工具子目录 | 103 | `ls -d src/tools/*/ \| wc -l` |
| 测试文件 | 3 233 | `find runtime -name "*.test.js" … \| wc -l` |
| CI 守卫脚本 | 101 | `ls scripts/ci/*.js \| wc -l` |
| 文档 `.md` | 976 | `find docs -name "*.md" \| wc -l` |
| pnpm workspace 包 | 9 | `pnpm-workspace.yaml` |

> 注：`[RESEARCH-019]` §3 记「231 个工具」。本次复测：`loadTools()`
> （`src/tools/index.js:133`）分三阶段自动发现——子目录 103 个 + 平铺 `.js` 111 个 +
> legacy `BUILTIN_TOOLS` 7 个，去重后注册表规模在 103–231 之间，取决于平铺文件里有多少
> 真的导出 `name + execute`。**两个数字都不算错，但口径不同**，本文统一用「103 个工具子目录」
> 这个可复现读数。

---

## 3. khy-os 自画像（对比矩阵的「自我列」）

### 3.1 产品定位（引自 `README.md:18`）

> 如果你手里有 2~5 家 AI 订阅（Claude / Codex / Cursor / Kiro / Trae / 国内模型…），
> 每月为一堆工具花几百块，却只能在各自的入口里分别使用——Khy-OS 把它们收进**一个终端**。

四条自述差异点：**订阅套利**（一个 CLI 接多家订阅，熔断 + 故障转移，人民币计价）／
**随身性**（微信、手机上随时使唤 agent）／**本土化**（中文拼音命令、国内模型优先）／
**私有与便携**（数据全在本地，便携版随身带）。

### 3.2 架构一句话（引自 `README.md:147`）

模型调用被当作系统调用统一收口：**壳**（CLI/TUI）→ **漏斗**（工具唯一出口）→
**网关**（多供应商路由，级联故障转移 + 熔断，无供应商锁定）。

### 3.3 分层现状（2026-10-10 实测，与 `README.md` 的分层表有出入，以盘上为准）

| 层 | 盘上位置 | 文件数 | 说明 |
|---|---|---:|---|
| 运行时主体 | `runtime/node/backend/src/` | 6 372 | CLI、AI 网关、各类服务、Web API |
| 独立后端 | `runtime/node/ai-backend/` | 114 | 独立版本轨道 G2（1.6.5） |
| 平台层 | `runtime/substrate/platform/` | 147 | Python 启动器 + `@khy/shared` / `ui-shared` / `plugin-sdk` |
| 桌面端 | `apps/khyos-desktop/` | 161 | Electron |
| 交付面前端 | `delivery/web/{ai-frontend,provider-hub}` | — | Vue 3 |
| 移动端 | `delivery/mobile/khy-os-client-app/` | — | Flutter |
| 渠道接入载体 | `delivery/channel/khyquant/` | — | **独立项目** khyquant 的接入载体 |
| 内置拓展 | `delivery/extension/tools/` | 3 | `khy-dsh-compat` / `khy-markdown` / `khy-notebook` |
| 脚本与守卫 | `scripts/` | 377 | 含 `scripts/ci/` 101 个守卫 |

> ⚠️ `README.md:163` 的分层表仍写 `software/`、`extensions/` 为顶层目录，盘上已不存在
> （实际在 `delivery/channel/`、`delivery/extension/`）。这是 5-3-1 重构后的**既有文档漂移**，
> 与本报告无关，但引用分层时请以盘上为准。

### 3.4 关键子系统清单（本报告后续矩阵的「自我列」取值来源）

| 域 | khy-os 实现 | 位置 |
|---|---|---|
| Agent 主循环 | `runToolUseLoop()`，30+ continue 点 | `services/tool/toolUseLoopCore.js` |
| 流式工具执行 | `streamingToolExecutor`（门控 `KHY_STREAM_TOOL_RAW_INPUT`） | `services/domain/query/query/streamingToolExecutor.js` |
| 工具注册表 | 三阶段自动发现，`defineTool()` + `BaseTool` | `src/tools/index.js:133` |
| 子代理 | `subAgentOrchestrator` / `AgentTool` | `services/subAgentOrchestrator.js` |
| 权限 | `permissionBroker` / `execApproval` / `approvalLedger` | `services/` |
| 会话 | `sessionPersistence` / `turnCheckpointService` / `rewindResume` / `worktreeManager` | `services/` |
| 上下文 | `contextCompressor` / `contextPruner` / `cognitiveSnapshot` | `services/` |
| 网关 | 41 个 adapter 文件，多协议注册表 | `services/gateway/adapters/` |
| 记忆 | 11 模块（distiller / dreamPromote / scoring / sessionCheckpoint / topicSwitch / vectorRecall …） | `services/domain/memory/memoryEngine/` |
| 技能 | 49 个内置技能 + CC/OpenClaw 双桥 | `src/skills/built-in/`（49 目录） |
| MCP | **客户端 + 服务端双份**（stdio + http server） | `services/domain/messaging/mcp/`（33 个非测试文件） |
| 工作流 | `flowsEngine` / `taskScheduler` / `cronScheduler` / `backgroundTaskManager` | `services/` |
| TUI | React/Ink 风格，`KHY_CC_TUI=1` 门控 | `src/cli/tui/`（60 个 `*.js`） |
| 自愈 | `selfRepair` / `selfHeal` / `selfOptimizer` / `evoEngine` / `bugSentinel` | `services/` |
| 审计 | `auditTrajectory` / `trajectoryProvenance` / `turnProvenance` / `traceAuditService` | `services/` |
| 消息通道 | 钉钉 / 飞书 / Slack / 企业微信 / iLink / 通用 IM | `services/domain/messaging/channels/` |
| A2A | `a2aRegistry` / `a2aMessageRouter` / `a2aFacade` | `services/` |

### 3.5 交付面

| 渠道 | 载体 | 版本轨道 |
|---|---|---|
| PyPI | `pip install khy-os` | G1（1.1.15） |
| npm | `@khy-os/khy-os`，bin: `khy` / `khy-os` / `khyquant` | G1 |
| Docker | `Dockerfile` + `docker-compose.yml` | — |
| 桌面 | `apps/khyos-desktop`（Electron） | — |
| 移动 | `delivery/mobile/khy-os-client-app`（Flutter） | — |
| 便携 | `portable-setup.bat` / `.sh` | — |

### 3.6 命令面（`PROCESS-014` 基线，引自 `[DESIGN-DELIV-002]` §4）

| 项 | 读数 | 取数方式 |
|---|---|---|
| CLI 命令 | **245** | 正则捕获 `src/constants/commandSchema.js` 的 `ROUTER_COMMANDS` 数组项数 |
| 别名 | **591** | 同上（`aliases.js` 中含中日韩字符的行 468 行——**中文/拼音命令面**） |
| handler | **155** | `PROCESS-014` 任务面棘轮，**只降不升** |

> 这三个数字同时是**债务**：`[DESIGN-DELIV-002]` §101 自评「用户看到的 245 个命令里，
> 属于他的只有约 70 个」。本报告在 §7 未把「命令面精简」列为可借鉴项——因为它不是
> 从外部项目学来的，而是 khy-os 自己的既登记债务。

---

## 4. 功能拆分：15 个可比域

拆域依据是「**khy-os 里有哪些可独立成立、且在 OSS 里有专门项目对标的子系统**」。
一个域成立的条件是：它有自己的注册表/生命周期/协议，而不是别的域的附属。

| 域 | 名称 | khy-os 侧代表符号 | OSS 是否有专门项目 |
|---|---|---|---|
| D1 | Agent 主循环与工具系统 | `runToolUseLoop`、`loadTools` | ✅ 很多（cline / OpenHands / Aider） |
| D2 | 子代理与多智能体 | `subAgentOrchestrator`、`a2aRegistry` | ✅（LangGraph / CrewAI / AutoGen / A2A） |
| D3 | 权限、审批与沙箱 | `permissionBroker`、`toolSandbox`、`wasm-sandbox` | ✅（E2B / Daytona / microsandbox） |
| D4 | 会话与恢复 | `sessionPersistence`、`rewindResume`、`worktreeManager` | ✅（各家 CLI 都有，深度不一） |
| D5 | 上下文工程 | `contextCompressor`、`cognitiveSnapshot` | ⚠️ 少有专门项目 |
| D6 | 多供应商网关 | `gateway/adapters/`（41 文件） | ✅（LiteLLM / one-api / new-api） |
| D7 | 记忆系统 | `domain/memory/memoryEngine/`（11 模块） | ✅（Mem0 / Letta / Zep / cognee） |
| D8 | RAG 与检索 | `vectorStore` / `rerank` / `vectorRecall` | ✅（RAGFlow / LightRAG / GraphRAG） |
| D9 | 技能 / 插件 / MCP | `src/skills/built-in/`（49）+ MCP 双端 | ✅（AgentSkills / MCP / OpenClaw） |
| D10 | 工作流编排 | `flowsEngine`、`cronScheduler` | ✅（n8n / LangGraph / Temporal） |
| D11 | TUI / UI | `src/cli/tui/`（60 文件） | ✅（Ink / Bubble Tea / Textual） |
| D12 | 自愈、自治与审计 | `selfRepair`、`evoEngine`、`auditTrajectory` | ❌ **几乎没有专门项目** |
| D13 | 交付与分发 | pip + npm + Docker + Electron + Flutter | ⚠️ 各家单渠道为主 |
| D14 | 消息通道遥控 | `messaging/channels/`（7 个通道） | ✅（CowAgent / OpenClaw / CLI-WeChat-Bridge / AionUi） |
| D15 | 工程治理 | 3 233 测试 + 101 守卫 + 规则登记表 | ❌ **几乎没有专门项目** |

> D12 与 D15 是「OSS 里没人专门做」的两域——这既是 khy-os 的独创性所在，
> 也是它**没有外部参照系**的风险所在（见 §8.2）。

---

## 5. 第一层：整体同类项目横向总矩阵

选入标准：在 ≥3 个域上有实质实现、且是「平台/智能体」形态而非纯库。
`khy-os` 与「组合拳」行固定置末。

图例：`●●●` 完整且有深度｜`●●` 有但浅｜`●` 有明显缺口｜`○` 无｜`—` 不适用

| 项目 | ★ | D1 | D2 | D3 | D4 | D5 | D6 | D7 | D8 | D9 | D10 | D11 | D12 | D13 | D14 | D15 | 覆盖 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **khy-os**（自我评估） | — | ●●● | ●●● | ●●● | ●●● | ●●● | ●●● | ●●● | ●● | ●●● | ●● | ●●● | ●●● | ●●● | ●●● | ●●● | 14+/15 |
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | 392k† | ●● | ● | ●● | ●● | ● | ●●● | ●● | ● | ●●● | ●● | ●● | ○ | ●●● | ●●● | ●● | 13/15 |
| [sst/opencode](https://github.com/sst/opencode) | 212k† | ●●● | ●● | ●● | ●●● | ●● | ●● | ● | ● | ●●● | ● | ●●● | ○ | ●●● | ○ | ●● | 11/15 |
| [langgenius/dify](https://github.com/langgenius/dify) | 158k† | ●● | ●● | ●● | ● | ● | ●●● | ●● | ●●● | ●●● | ●●● | ●●● | ○ | ●●● | ● | ●● | 13/15 |
| [openai/codex](https://github.com/openai/codex) | 128k† | ●●● | ● | ●● | ●●● | ●● | ● | ● | ○ | ●● | ○ | ●● | ○ | ●● | ○ | ●● | 9/15 |
| [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) | 107k† | ●●● | ● | ●● | ●●● | ●● | ●● | ● | ● | ●● | ● | ●● | ○ | ●● | ○ | ●● | 10/15 |
| [All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands) | 90k† | ●●● | ●● | ●●● | ●● | ●● | ● | ○ | ● | ●● | ● | ●● | ○ | ●●● | ● | ●● | 11/15 |
| [diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute) | 75k† | ○ | ○ | ○ | — | ○ | ●●● | ○ | ○ | ●● | ●● | ●● | ○ | ●●● | ● | ●● | 7/15 |
| [cline/cline](https://github.com/cline/cline) | 70k† | ●●● | ● | ●● | ●● | ●● | ●● | ● | ● | ●● | ● | ●● | ○ | ●● | ○ | ●● | 11/15 |
| [block/goose](https://github.com/block/goose) | 55k† | ●●● | ●● | ●● | ●● | ●● | ●● | ● | ● | ●● | ●● | ●● | ○ | ●● | ○ | ●● | 12/15 |
| [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | 55k† | ○ | ○ | ○ | — | ○ | ●●● | ○ | ○ | ● | ○ | ●● | ○ | ●● | ○ | ●● | 5/15 |
| [Aider-AI/aider](https://github.com/Aider-AI/aider) | 49k† | ●● | ○ | ● | ● | ●● | ● | ● | ● | ● | ○ | ●● | ○ | ●● | ○ | ●● | 9/15 |
| [BerriAI/litellm](https://github.com/BerriAI/litellm) | 61k† | ○ | ○ | ○ | — | ○ | ●●● | ○ | ○ | ● | ● | ○ | ○ | ●●● | ○ | ●● | 6/15 |
| [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) | 38k† | ● | ● | ● | ● | ● | ●●● | ○ | ○ | ●● | ● | ●● | ○ | ●● | ●●● | ●● | 9/15 |
| [obra/superpowers](https://github.com/obra/superpowers) | 297k† | ● | ●● | ○ | ● | ● | ○ | ○ | ○ | ●●● | ●● | ○ | ● | ●● | ○ | ●● | 8/15 |
| [earendil-works/pi](https://github.com/earendil-works/pi) | 114k† | ●● | ○ | ● | ●● | ●● | ●● | ○ | ○ | ●●● | ○ | ●● | ○ | ●●● | ○ | ●● | 9/15 |
| [farion1231/cc-switch](https://github.com/farion1231/cc-switch) | 142k† | ○ | ○ | ○ | ○ | ○ | ●● | ○ | ○ | ●● | ○ | ●● | ○ | ●● | ○ | ●● | 6/15 |
| [bytedance/deer-flow](https://github.com/bytedance/deer-flow) | 84k† | ●● | ●●● | ●● | ●● | ●● | ●● | ●● | ●● | ●●● | ●●● | ●● | ● | ●● | ○ | ●● | 12/15 |
| [iOfficeAI/AionUi](https://github.com/iOfficeAI/AionUi) | 33k† | ●●● | ●●● | ●● | ●● | ● | ● | ○ | ● | ●●● | ●● | ●●● | ○ | ●● | ●●● | ●● | 11/15 |
| [zhayujie/CowAgent](https://github.com/zhayujie/CowAgent) | 47k† | ●● | ●●● | ●● | ●● | ●● | ●● | ●●● | ●● | ●●● | ●● | ●● | ●● | ●● | ●●● | ●● | 13/15 |
| [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) | 28k† | ●●● | ●●● | ●● | ●●● | ●● | ●●● | ●● | ● | ●●● | ●● | ●● | ○ | ●●● | ●●● | ●● | 13/15 |
| **组合拳**（业界最佳 OSS 拼装） | — | ●●● | ●●● | ●●● | ●●● | ●● | ●●● | ●●● | ●●● | ●●● | ●●● | ●●● | ○ | ●●● | ●●● | ●● | 14/15 |

> **覆盖列是本次调研作者的主观判级**（判据见 §4 各域的「khy-os 侧代表符号」是否在该项目有对应物），
> 不是实测数字；`khy-os` 行同样按此标准自评，未给自己放水——D8 只给 `●●`
> （`vectorStore` 仅 InMemory + File 两个后端），D10 只给 `●●`（有 `flowsEngine` 但无 durable-execution 语义命名）。

**怎么读这张表**：

1. **`组合拳` 行的含义**：要把 khy-os 的能力用 OSS 拼出来，需要
   `opencode`（D1/D11）+ `LangGraph`（D2/D10）+ `microsandbox`（D3）+ `Mem0`（D7）+
   `RAGFlow`（D8）+ `OpenClaw`（D9/D14）+ `LiteLLM`（D6）+ `Dify`（平台/D13），
   **至少 8 个独立项目、4 套部署、3 种语言运行时**。即便如此，D12（自愈）与 D15（治理）
   仍然无件可拼——这是 khy-os 真正的护城河，也是它最缺外部参照的地方。
2. **两个新出现的整体同类**（本次调研最重要的补充，详见 §6.9c）：
   - **`QwenLM/qwen-code`（28k†）是功能集上最接近 khy-os 的双胞胎**——它自列的对等表里有
     SubAgents / Agent Teams / Dynamic Workflows / Auto-Memory / Auto-Skills / Hooks /
     Plan Mode / LSP 集成 / Sandbox / Git Worktrees / 多协议 / Agent Arena / Daemon Mode，
     **13/15 域与 khy-os 重合**。差异在：它没有 khy-os 的网关账号池深度、自愈子系统、守卫矩阵。
   - **`zhayujie/CowAgent`（47k†）是定位最像的国产项目**——自述「Agent Harness 工程的参考实现」，
     同样有主动规划、自创并运行 Skills、个人知识库 + 长期记忆、多 agent 团队、自演化、
     Skill Hub、web + 全部主流 IM。**这是国产赛道最直接的对手。**
   - **`obra/superpowers`（297k†）是星标第二高的相关项目**，但它不是 harness 而是
     **技能框架 + 方法论层**。它的存在本身是一条结论：**「技能」已经赢了扩展单元之争**，
     而 khy-os 有技能但**没有方法论层、没有市场**。
   - **`iOfficeAI/AionUi`（33k†）代表一个新物种**：桌面宿主，自动探测并托管约 25 个外部
     agent，统一 MCP 管理，Team Mode 子代理编排。它不竞争「谁的 agent 强」，
     而竞争「谁能托管更多 agent」——这与 khy-os 的「平台 OS」定位正面相撞。
3. **OpenClaw 仍是最接近的整体同类**，但它与 khy-os 的差异是**方向性**的：
   OpenClaw 是「个人助理操作系统」（channels + companion apps + gateway），
   khy-os 是「编码智能体操作系统」（tool loop + god-file guards + 订阅套利）。
   两者在 D6（网关）上都做多供应商，但 OpenClaw 的做法是「模型与 harness 是可换插件」，
   khy-os 的做法是「说对方 CLI 的原生协议把订阅当源」——后者更激进，也更有合规风险。
4. **D6 一列出现了四个直接对手**：OmniRoute（75k）、CLIProxyAPI（55k）、LiteLLM（61k）、
   claude-code-router（38k）。**这是本次调研对先验假设的修正**——「订阅套利网关」
    **不是** khy-os 的独创，CLIProxyAPI 已把「把 Claude Code/Codex 包装成兼容 API + 多账号轮询」
    做成参考实现，OmniRoute 已在免费渠道编目上对齐。khy-os 在这一列的真实差异点收窄为
   **「Anthropic 原生深度 + 中文/本土化 + 与编码智能体同进程 + 内置成本核算」**。
5. **D14 一列有五个 `●●●`**：khy-os、OpenClaw、claude-code-router、AionUi、Qwen Code
   （另有 CowAgent）。AionUi 有 Telegram/Lark/钉钉/微信远端访问，Qwen Code 有
   Telegram/钉钉/微信/飞书，CCR 的 AgentClaw 覆盖微信 iLink/企业微信/Slack/Discord/
   Telegram/LINE/飞书/钉钉。**「IM 遥控 agent」已是中国赛道标配，不是差异点**；
   khy-os 的差异在 IM 是「遥控编码 agent」而非「聊天机器人」。
6. **D15 一列只有 khy-os 是 `●●●`**。这是本次调研最反直觉的发现：一个 145 万行的项目
   拥有 3 233 个测试文件和 101 个 CI 守卫，而星标高出它两个数量级的项目里，
   只有 LangChain / Dify / RAGFlow 这个量级才有可比的测试规模，且**都没有**
   「规则登记表（`RULES-REGISTRY.json`）+ 守卫强制」这种把工程纪律本身产品化的做法。
7. **⚠️ 可持续性警报**（详见 §6.9d）：本窗口内 `Continuedev/continue`（36k†）与
   `RooCodeInc/Roo-Code`（24k†）**先后退场**（README 原文核实）。goose 已移交
   Linux Foundation 的 Agentic AI Foundation，OpenClaw 由独立 501(c)(3) 托管。
   **基金会/法人托管 + 明文维护模型已成入场券**——khy-os 的治理优先姿态是真资产，
   但目前对外不可见。

---

## 6. 第二层：按功能拆分的域矩阵

### 6.1 D7 记忆系统

| 项目 | ★ / 许可 | 形态 | 核心机制 | 时序/失效 | 自托管 | khy-os 可学 / khy-os 领先 |
|---|---|---|---|---|---|---|
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | 67k† / Apache-2.0 | 库 + 服务 + 云 | **单遍 ADD-only 提取**（一次 LLM 调用，无 UPDATE/DELETE）；实体链接；语义 + BM25 + 实体三路召回融合 | 仅「时序推理」，无显式失效窗口 | ✅ Docker Compose + dashboard + 默认开 authz | **可学**：ADD-only 与 khy-os 的 `distiller.js`/`scoring.js` UPDATE 路径是不同赌注，值得 A/B；「智能体确认的事实与用户事实同权」可低成本采纳。**领先**：khy-os 记忆在进程内、无需常驻服务；有 `dreamPromote.js` 晋升生命周期，Mem0 只有累积 |
| [letta-ai/letta](https://github.com/letta-ai/letta) → [letta-ai/letta-code](https://github.com/letta-ai/letta-code) | 25k† / Apache-2.0（code 3.6k†） | SDK + server + desktop + 云 | 「记忆 = 智能体自己用工具编辑的记忆块」（MemGPT 血脉） | 靠智能体自行维护 | ✅ | **注意**：`letta` 仓库现仅为指针，活跃代码在 `letta-code`（3.6k†）——**对标要标letta-code**。**领先**：khy-os 的记忆生命周期广度（`sessionCheckpoint`/`topicSwitch`/`memoryRecallTokens`/`progressLog`）Letta 无对应物 |
| [getzep/graphiti](https://github.com/getzep/graphiti) | 32k† / Apache-2.0 | 库 | **双时序（bi-temporal）知识图谱**：事实带显式生效窗口，自动失效且全历史保留；episodes + communities + Pydantic 自定义实体 | ✅ **业界最严** | ✅ Neo4j / FalkorDB / Neptune | **可学（最高优先）**：双时序有效性窗口语义应作为 khy-os  staleness 检测的建模基准。**注意**：`getzep/zep`（5k†）README 自述「不是 Zep 的产品」，Zep CE 已降级 `legacy/`——**对标要标 graphiti 不是 zep** |
| [topoteretes/cognee](https://github.com/topoteretes/cognee) | 32k† / Apache-2.0 | 库 + Docker 栈 + 云 | 四个一级操作 `remember` / `recall` / **`improve`** / **`forget`**；**会话蒸馏**（把被采纳的教训固化为永久记忆）；代码转为符号/依赖图 | ✅ 有 forget | ✅ 单 Postgres 起步（图存储自述为 demo 级） | **可学**：`improve` 操作 + 会话蒸馏是 khy-os `dreamPromote.js` 最近的同类，且 cognee 把它做成**有名字、有文档、用户可调用**的操作；`COGX` 交换格式可从 Mem0/Letta/Zep/Graphiti 导入记忆。**领先**：跨 harness 技能复用（khy-os 已原生读 CC 与 OpenClaw 的技能根） |
| [supermemoryai/supermemory](https://github.com/supermemoryai/supermemory) | 31k† / MIT | SDK + 服务 + 云 | 自动事实提取 + 时序变化/矛盾/自动遗忘 + **自动维护的用户画像**（~50ms）+ **RAG 与记忆合成一次查询**；多模态抽取 | ✅ | ✅ 首次启动内置图引擎 + 本地 embedding，可离线 | **可学**：「RAG+记忆一次查询」与「画像是一等对象」是两条最可迁移的设计。**领先**：khy-os 是**项目/代码库中心**的记忆，supermemory 是**用户画像中心**，无代码图概念 |
| [memodb-io/Memobase](https://github.com/memodb-io/Memobase) | 2.9k† / Apache-2.0 | server + SDK | 用户画像 + 事件时间线双结构；**声明式画像 schema**（不自由抽取）；批处理缓冲固定 3 次 LLM 调用 | ✅ 事件 gist | ✅ | **可学**：声明式 schema 是对抗记忆膨胀的强约束，值得用于 khy-os `distiller.js`。**注意**：README 首条已指向 `Acontext`，**疑似转向，低动量** |
| [langchain-ai/langmem](https://github.com/langchain-ai/langmem) | 1.7k† / MIT | 库 | **热路径工具 + 后台记忆管理器**分立；存储无关内核 | — | ✅ | **可学**：热路径 vs 后台管理器的切分，是对 khy-os「recall vs distiller」最清晰的表述 |
| [neuml/txtai](https://github.com/neuml/txtai) | 13k† / Apache-2.0 | 库 | 「embeddings DB = 向量索引（稀疏+稠密）+ 图网络 + 关系库的并集」 | — | ✅ | **可学**：与 khy-os「vectorStore + memoryEngine 并列」是最接近的架构类比，但它把三者合一了 |

**D7 小结**：业界已就三件事收敛——(a) **双时序事实是标配不是差异点**（Graphiti / supermemory / Memobase / cognee / memoripy 五家都有）；(b) **RAG 与记忆正在合成一次检索**（supermemory「一次查询」、RAGFlow「converged context engine」、txtai「并集」），khy-os 的 `vectorStore/` + `memoryEngine/` + `rerank/` **三服务并列在架构上落后于这次收敛**；(c) **技能正在变成可互操作的磁盘格式 + 市场**（`agentskills.io` 规范 / `anthropics/skills` 180k‡ / OpenClaw ClawHub / cognee 插件市场 / Dify 市场 / Qdrant 自带 skills 仓库）。
khy-os 在这一域**领先**的是：**记忆梦境/晋升作为命名子系统**（`dreamPromote.js` + `distiller.js` + `progressLog.js`）——Mem0 只有累积、supermemory/cognee 有近似物但无「梦境」生命周期、Letta 无对应物。

### 6.2 D8 RAG 与检索

| 项目 | ★ / 许可 | 语言 | 核心机制 | khy-os 可学 / khy-os 领先 |
|---|---|---|---|---|
| [infiniflow/ragflow](https://github.com/infiniflow/ragflow) | 92k† / Apache-2.0 | Python + Go | DeepDoc 深度文档理解（版面/OCR/表格）；**模板化分块 + 分块可视化供人干预**；「Knowledge Compilation」把文档转成 Wiki/图/树/思维导图/时间线/**技能** | **可学（UX 最高价值）**：分块可视化人工干预是 RAG 域最好的 UX 想法，khy-os 没有同类物。**Knowledge Compilation → Skills** 是「RAG 产出应可作为技能复用」的直接证据，正是 khy-os `SkillTool` + `VectorStoreTool` 该搭的桥。**领先**：khy-os 可进程内嵌入，RAGFlow 是多服务平台 |
| [HKUDS/LightRAG](https://github.com/HKUDS/LightRAG) | 40k† / MIT | Python | 双层（高/低层级）KG 检索；**reranker 已成默认查询模式**；四种可选分块策略；MinerU/Docling 多模态；**OpenSearch 统一存储覆盖四种存储类型** | **可学（架构最高价值）**：「一个库、N 种存储后端、全可换」正是 khy-os `vectorStore/index.js`（仅 InMemory + File 两个后端）的缺口。**rerank 作为默认查询模式**值得抄给 `services/rerank/` |
| [microsoft/graphrag](https://github.com/microsoft/graphrag) | 36k† / MIT | Python | 社区摘要 / 层次聚类，服务「全局/概括类」问题 | ⚠️ **README 明示 largely in maintenance mode，不再接受新 PR**。**只作设计参考，不作依赖也不作竞品** |
| [netease-youdao/QAnything](https://github.com/netease-youdao/QAnything) | 14k† / **AGPL-3.0** | Python | 完全离线（拔网线安装使用）；跨语言 QA；两阶段检索排序（宣称数据越多效果越好） | ⛔ **AGPL-3.0，代码不可拷入**。可学其「两阶段 retrieve-then-rerank at scale」的表述。README 最新日期 2024-05-17，**低动量** |
| [qdrant/qdrant](https://github.com/qdrant/qdrant) / [lancedb/lancedb](https://github.com/lancedb/lancedb) / [chroma-core/chroma](https://github.com/chroma-core/chroma) | 35k† / 12k† / 29k†（均 Apache-2.0） | Rust / Rust / Python | 专用向量库 | **可学**：LanceDB 是**嵌入式、落盘**向量库，与 khy-os 的「便携版随身带」定位天然契合，是 `FileVectorStore` 之外最该评估的第三个后端 |

### 6.3 D9 技能 / 插件 / MCP

| 项目 | ★ / 许可 | 形态 | 核心机制 | khy-os 可学 / khy-os 领先 |
|---|---|---|---|---|
| [anthropics/skills](https://github.com/anthropics/skills) + `agentskills.io` 规范 | 180k‡ / 混合（文档技能 source-available） | 规范 + 参考实现 | 技能 = 目录，必含 `SKILL.md`（frontmatter: `name` 必填 1–64 字符且**必须等于父目录名**、`description` 必填 1–1024、`license`/`compatibility`(≤500)/`metadata`/`allowed-tools` 可选）+ 可选 `scripts/` `references/` `assets/` | **可学**：`compatibility` 字段（声明目标产品/系统包/网络访问）是**可移植性声明钩子**，与 khy-os 自己的「禁止硬编码盘符」规约天然一对；`allowed-tools` 预授权清单是现成的安全原语；`name` 必须等于父目录名这条不变量值得纳入 khy-os 的技能校验。**领先**：khy-os 的解析器已与 AgentSkills 格式**字节兼容**（见 `src/skills/ocSkillBridge.js` 注释自述） |
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | 392k† / MIT | monorepo + Gateway + Control UI + CLI/TUI | **Tools / Skills / Plugins 三元组** + ClawHub 市场；**技能加载 7 级优先级链**（workspace → `<ws>/.agents/skills` → `~/.agents/skills` → state-dir → 每 agent workshop → bundled → custodian → `skills.load.extraDirs`）；**「Skill Workshop」= 智能体自学技能，带变更历史与 undo** | **可学（本域最高优先）**：(a) 有文档的**多级优先级链 + 冲突解决**，khy-os 只有 `skillSourceSpec.js`（258 行）值得逐条 diff；(b) **智能体自创技能 + 变更历史 + undo**——这正是 khy-os `dreamPromote`/distiller 记忆回路在技能上的自然延伸。**领先**：khy-os 已能原生读 CC 与 OpenClaw 的技能根，OpenClaw 自己反而没有跨 harness 桥 |
| [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) | 91k† / Apache-2.0（新贡献） | 参考实现集 | ⚠️ **已收缩为仅保留 7 个官方参考服务器**（Everything/Fetch/Filesystem/Git/Memory/Sequential Thinking/Time），其余 14 个（GitHub/Slack/Postgres/Redis/Puppeteer…）已移入 `servers-archived`，并**明示「非生产就绪」**；发现功能转交 [MCP Registry](https://github.com/modelcontextprotocol/registry)（7.3k† / Go + PostgreSQL，v0.1 API 冻结） | **可学（缺口）**：MCP Registry 已是工具发现的规范层，khy-os 有 `DiscoverSkillsTool` 但**没有 registry 客户端**——这是 D9 域最具体的缺口。另注：MCP 官方 **Memory** 参考服务器就是**知识图谱形态**，标准制定方自己选了图状记忆 |
| [sst/opencode](https://github.com/sst/opencode) 插件系统 | 212k† / MIT | 目录 + npm | 两条加载路径：`.opencode/plugins/`（项目）+ `~/.config/opencode/plugins/`（全局），或 `opencode.json` 里 `"plugin": ["pkg", ...]`；**零 manifest 仪式**；内置 `build`（全权）/`plan`（只读）两 agent + `@general` 子代理 | **可学（反面教材价值）**：这是**最简可行插件模型**。khy-os `skillSourceSpec.js` 258 行相对它是否过度工程，值得自查。另：OpenCode 把 **Agent Skills 与 plugins 当平级**而非父子，与 khy-os `src/skills/` 与 `services/skills/extensions/` 分立一致 |

### 6.4 D6 多供应商网关

> 这一域的调研结果**推翻了一个先验假设**：原以为「订阅套利」（把别人的订阅当模型源）
> 是 khy-os 的独创。实际上 `router-for-me/CLIProxyAPI`（55k†）做的几乎是同一件事，
> `diegosouzapw/OmniRoute`（75k†）在「免费渠道编目 + 账号池 + 熔断」上也已对齐。
> khy-os 在这一域的**真实差异点**收窄为「 Anthropic 原生深度 + 中文/本土化 + 与编码智能体同进程」。

| 项目 | ★ / 许可 | 语言 | 核心机制 | khy-os 可学 / khy-os 领先 |
|---|---|---|---|---|
| [BerriAI/litellm](https://github.com/BerriAI/litellm) | 60 686 / MIT（`enterprise/` 单独商业许可） | Python（**新增 Rust core**） | 100+ 供应商 OpenAI/原生双格式；model group 抽象；负载均衡；failover；虚拟密钥 + 按密钥预算；TPM/RPM 配额；精确 + 语义缓存；守卫；管理 dashboard；多租户；**MCP gateway + A2A agent gateway + agent harnesses**（经网关驱动 Claude Code / Codex / OpenCode / Deep Agents） | **可学**：`litellm_proxy/` 的 model-group 抽象，以及「网关 → agent 运行时」的收敛方向正是 khy-os 在走的路。**领先**：khy-os 的**订阅（OAuth）账号池**语义而非仅 API key；**免费渠道发现**（LiteLLM 无免费层编目）。⚠️ Rust core / `litellm-core` 拆分是全新的，README 自述「release integration is pending」，性能数字属厂商自述 |
| [diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute) | 74 689 / MIT | TypeScript | 358 供应商 / 1 300+ 模型 ID（152 标注免费）；**19 种路由策略**（含 power-of-two-choices、cost-optimized、headroom、reset-window、cache-optimized 前缀钉扎、lkgp 最后已知良径、fusion 扇出+裁判、pipeline）；**三层韧性**：L1 按供应商类型差异化阈值的熔断器（OAuth 8× / API-key 12× / 本地 2×）+ 60/30/15s HALF-OPEN 探测；L2 按密钥/账号冷却 ×2 指数退避 + 防惊群 + 429 `Retry-After`；L3 按模型锁定；配额感知（实时 used/remaining + Quota-Share 调度）；免费层编目方法论（489 条目、35 池密钥、共享池去重、条款风险标记、双周复审） | **可学（本域最高优先）**：免费层编目的**方法论**（去重、风险标记、定期复审）比功能本身更值得抄；三层韧性分解比多数项目更细。**这是 khy-os 免费渠道发现 + 账号池 + 熔断故事最直接的对手**。⚠️ 74.7k 星对一个此类项目偏高，两个独立源一致但仓库年龄/贡献者深度未验证 |
| [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | 54 653 / MIT | Go | **把 Antigravity / ChatGPT Codex / Claude Code / Grok Build / Muse Code / Devin 包装成 OpenAI/Gemini/Claude/Codex 兼容 API**；按供应商族做**多账号轮询负载均衡**；每供应商 OAuth 登录流；流式/非流式/WebSocket；函数调用；多模态；管理 API；**v6.10.0 起移除内置用量统计**交给生态（30+ 第三方面板） | **可学**：这是「把订阅/OAuth 账号（而非 API key）变成池化、负载均衡、协议兼容的网关」的**参考实现**，与 khy-os 账号池最同构。「主动移除内置统计、让插件生态接管可观测性」是值得研究的架构赌注。**领先**：khy-os 有内置成本/令牌核算与限流，CLIProxyAPI 两者皆无 |
| [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) | 37 602 / MIT | TypeScript | 本地 `127.0.0.1:3456` 控制面；Anthropic Messages 原生 + OpenAI Chat/Responses + Gemini；**按 header/body 条件路由**；有序回退模型；凭据池 + 密钥轮换；CCR 客户端密钥带过期 + 本地请求/令牌/图片限额；**resolved route 日志**（记录请求实际落到哪个 provider/model/credential）；wrapper 插件 + 核心网关插件；Fusion 模型；ToolHub；内置浏览器自动化；**AgentClaw 中继到微信 iLink / 企业微信 / Slack / Discord / Telegram / LINE / 飞书 / 钉钉** | **可学**：(a) resolved-route 日志是**最有用的调试呈现**；(b) header/body 条件路由；(c) 可插拔 ai-gateway 运行时形态。**这是「CC 风格 TUI + agent 网关」命题最直接的对手**。**领先**：khy-os 是有持久后端、多租户服务层、完整成本核算的平台 OS；CCR 是单用户本地工具、无服务端租户 |
| [QuantumNous/new-api](https://github.com/QuantumNous/new-api)（原 `Calcium-Ion/new-api`） | 49 544 / **AGPL-3.0** | Go | OpenAI Chat/Responses + Anthropic Messages + Gemini + Realtime WebSocket；**RelayKit** 跨四文本协议的请求/响应/流式转换库；渠道优先级 + 权重 + 重试 + **渠道亲和** + 每渠道多上游密钥；配额/订阅/用量日志/**缓存计费**/**按档表达式定价**；web 控制台（8 语言）；细粒度权限；**JS 插件市场** | **可学**：RelayKit 协议转换层与「渠道亲和 + 表达式定价」是本 cohort 最成熟的实现；插件市场是这里最强的 OSS 扩展故事。⛔ **AGPL-3.0，代码不可拷入**。**领先**：khy-os 有健康探测驱动的渠道选择与熔断（new-api 只有重试 + 亲和） |
| [songquanpeng/one-api](https://github.com/songquanpeng/one-api) | 37 107 / MIT | Go | 单可执行文件；渠道间负载均衡；失败自动重试；模型映射；令牌管理（过期/配额/IP 段/允许模型）；分组倍率；兑兑码；内存缓存 + 批量落库；**全局按 IP 限流**；**`METRIC_SUCCESS_RATE_THRESHOLD`**（成功率阈值，默认 0.8）自动降级不健康渠道 | **可学**：`METRIC_SUCCESS_RATE_THRESHOLD` 是廉价实用的「穷人版熔断器」。**领先**：其余全部——Anthropic 原生端点、语义缓存、守卫、可观测性、免费层发现。one-api 本质是**再分发/计费**系统，不是**可靠性**系统 |
| [Portkey-AI/gateway](https://github.com/Portkey-AI/gateway) | 13 159 / MIT | TypeScript | **声明式 JSON "Configs" 作为路由原语**（config-as-code，可进 git）；条件路由；跨密钥/供应商加权负载均衡；**按错误码的差异化回退触发**；5 次指数退避重试；请求超时；虚拟密钥；RBAC；简单 + 语义缓存；**40+ 预建守卫 + BYO**（本列表最深的 OSS 守卫目录）；MCP gateway；实时 WebSocket | **可学（架构最高价值）**：**Config-as-code 路由**——网关规则必须能在 git 里被 review，而不是只能在 DB/UI 里改。**按错误码的回退触发**也比一刀切重试策略更有表达力。**领先**：密钥池轮换、账号池、健康探测、免费层发现、内置成本核算在 khy-os 是原生，在 Portkey 缺或企业版门控 |
| [maximhq/bifrost](https://github.com/maximhq/bifrost) | 8 676 / Apache-2.0 | Go | **Anthropic 原生路由**（`/anthropic` drop-in）；23+ 供应商；跨密钥与供应商负载均衡（~10ns 加权选键）；failover；语义缓存；MCP gateway；**可插拔后端接口**（configstore/logstore/vectorstore）+ 插件注册表布局；层级预算（虚拟密钥→团队→客户）；Prometheus 原生指标；OIDC/OAuth2 供给 | **可学**：可插拔后端接口 + 插件注册表布局是**可直接照搬**的模块化架构。⚠️ README「Enterprise Deployments」把**自适应负载均衡、集群、守卫、自定义插件、OIDC** 门控在付费层——Apache-2.0 核心比功能列表窄 |
| [katanemo/plano](https://github.com/katanemo/plano)（原 `katanemo/arch-gateway`） | 7 082 / Apache-2.0 | **Rust + Envoy** | **用 4B 参数专用编排模型**（`plano_orchestrator_v1`）做意图分类与路由，替代 GPT-4 做分类器；YAML 声明式 agent 注册（自然语言描述）；model agility（按名/别名/语义名/偏好路由）；**Agentic Signals**（零码信号捕获 + OTEL traces/metrics）；**Filter Chains**（越狱防护、审核策略、记忆钩子作为可组合过滤器） | **可学**：「**用一个小的专用模型替换意图分类器**」这个洞察又便宜又好——直接可用于 khy-os 的模型分层选路（配合 RouteLLM 思路）。另：**带自然语言描述的声明式 agent 注册**是 agent 层的好模式。⚠️ 编排智能大量依赖 katanemo 托管 LLM，OSS 仓库并非完全自足 |
| [Helicone/helicone](https://github.com/Helicone/helicone) | 6 209 / Apache-2.0 | TypeScript | AI Gateway（100+ 模型一个 key）+ 智能路由 + 自动回退 + 统一可观测；成本/延迟追踪；agent 追踪；**异步非阻塞日志路径**（OpenLLMetry + Cloudflare Worker）；**自称最大的开源定价库**（300+ 模型/供应商） | **可学**：**异步非阻塞日志路径**是「可观测性不得增加延迟」的正确答案，直接相关于 khy-os 的 SSE/背压工作；公开定价库是 khy-os 成本核算的可效法模型。**领先**：路由深度、密钥池、管理面 |
| [theagentrouter/agent-router](https://github.com/theagentrouter/agent-router)（原 `envoyproxy/ai-gateway`） | 2 206 / Apache-2.0 | Go | **两层网关**：Tier One（auth、顶层路由、全局限流）→ Tier Two（细粒度自托管模型访问、推理感知选端点）；K8s 原生 CRD（`AIGatewayRoute`/`AIServiceBackend`/`BackendSecurityPolicy`）；`aigw run` 独立跑 `localhost:1975/v1` | **可学**：控制面 vs 推理面的两层切分，是 khy-os 若要在付费供应商之外前置自托管/vLLM 推理时的清晰心智模型。**领先**：多密钥/账号池、成本核算、免费层发现整条「经济轴」；Agent Router 是基础设施形态，不是经济形态 |
| [luohy15/y-router](https://github.com/luohy15/y-router) | 383 / MIT | TypeScript | Anthropic `/v1/messages` ↔ OpenAI chat-completions 双向翻译；单一上游；健康检查——**就这些**。⚠️ **已归档**，README 指向 OpenRouter 官方 Claude Code 集成 | **可学**：历史意义——证明了 Anthropic↔OpenAI 协议桥的最小可行形态与真实需求；也是「纯协议 shim 能承载多少」的标尺。已被 OpenRouter 一方集成 + CCR/CLIProxyAPI 取代 |

### 6.5 D2 / D3 / D10 编排、多智能体与沙箱

| 项目 | ★ / 许可 | 域 | 核心机制 | khy-os 可学 / khy-os 领先 |
|---|---|---|---|---|
| [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) | 43k† / MIT | D2/D10 | **durable execution**（故障后持久化，精确从断点续跑）；**human-in-the-loop 中断**（运行中检视/修改 agent 状态）；短时 + 长时记忆；可插拔 checkpointer 的图/状态机 | **可学**：durable-execution + 中断/续跑语义已是任何工作流引擎的地板。khy-os 已有 `flowsEngine` / `orchestrationFlow` / `taskScheduler`，**显式命名它们为 durable-execution 原语（带 checkpoint/resume）即可对外宣称对齐**。**领先**：khy-os 交付的是 OS 级调度器/cron（`cronScheduler` + `cronStepGuard`），不是要用户自己托管的库 |
| [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) | 60k† / MIT | D2/D10 | **Crews（自治）vs Flows（控制）两层切分**——Crews 是带角色/目标/工具/任务的智能体（层级与顺序两种过程），Flows 是带状态/分支/路由的事件驱动工作流，Crew 作为 Flow 的一步嵌入；记忆、知识、checkpoint、结构化输出、**MCP + A2A 双支持** | **可学（表述最高价值）**：Crews/Flows 的切分是对 khy-os 该有的「`subAgentOrchestrator`（自治） vs `flowsEngine`（确定性 DAG）」分离**最清晰的公开表述**；同时验证了 MCP+A2A 双栈共存 |
| [n8n-io/n8n](https://github.com/n8n-io/n8n) | 207k† / **Sustainable Use License（非 OSI，source-available）** | D10 | 可视化画布 + 自定义代码；1 500+ 集成；9 000+ 工作流模板；人工审批节点；RBAC；审计轨迹；队列模式水平扩展 | **可学**：生态引力来自**模板 + 节点/集成注册表**，不是引擎优雅度；人工审批节点与一等审计轨迹正好映射 khy-os 的 `permissionBroker` / `healAuditService`。⛔ **非 OSS 许可，代码不可借用**。**领先**：khy-os 是真正可安装的 OS 产物（pip/npm 双渠道），不是 Dockerized web 应用 |
| [temporalio/temporal](https://github.com/temporalio/temporal) | 24k† / MIT | D10 | workflow/activity 切分；自动重试；**事件历史回放 + 确定性 worker**；版本化；可见性/搜索；cron 调度 | **可学**：事件溯源历史 + 确定性回放是 `backgroundTaskManager` / `taskScheduler` / `cronScheduler` 崩溃恢复的黄金标准；khy-os 的 `auditTrajectory/` + `restoreProvenanceCheck` 是同思路的小规模版，**值得对齐词汇**。**领先**：运维足迹（无需集群） |
| [a2aproject/A2A](https://github.com/a2aproject/A2A) | 26k† / Apache-2.0 | D2 | JSON-RPC 2.0 over HTTP(S)；**Agent Cards** 做能力发现；同步 + SSE 流式 + 异步推送；text/file/结构化 JSON 载荷；**「保持不透明」**——智能体协作不暴露内部状态/记忆/工具；与 MCP 互补 | **可学**：khy-os 的 `a2aRegistry` / `a2aMessageRouter` / `a2aFacade` / `a2aAgentLifecycle` **应暴露 Agent-Card 形态的能力元数据**，免费换来互操作。**领先**：khy-os 已有进程内 registry+router+facade，A2A 只是线上协议 |
| [e2b-dev/E2B](https://github.com/e2b-dev/E2B) | 14k† / Apache-2.0 | D3 | 云沙箱基础设施；`Sandbox.create()` / `commands.run()`；独立 **Code Interpreter** SDK；文件系统操作；长时/持久沙箱；JS + Python SDK | **可学**：SDK 人机工效与「shell 命令 vs code interpreter」的原语切分，正是 khy-os `sandbox/` + `wasm-sandbox/` + `shellSafetyValidator` 该有的形状。**领先**：**本地性**——E2B 纯云且需 API key，khy-os 是便携本地优先 OS，离线/气隙场景是真护城河 |
| [microsandbox/microsandbox](https://github.com/microsandbox/microsandbox) | 8.6k† / Apache-2.0 | D3 | 硬件级隔离的微型 VM；**分叉活跃沙箱**；**快照/保存-恢复运行中状态**；跨 Linux/macOS/**Windows**；**OCI 兼容**（跑 Docker Hub/GHCR 镜像）；即时启动 | **可学（本域最高优先）**：**fork/snapshot/restore 与 khy-os 的 `restore/`、`restoreAgentService`、`restoreArchiveExtractCheck`、`restoreProvenanceCheck` 直接对应**——分叉一个**运行中**沙箱并稍后恢复，是比文件级回退强得多的原语；OCI 兼容意味着可复用现有镜像而非自定格式。**领先**：`credentialLease/`、`permissionBroker`、`ssrfGuard` 位于隔离边界**之上**，microsandbox 不涉及这一层 |
| [google/gvisor](https://github.com/google/gvisor) | 20k† / Apache-2.0 | D3 | 用户态应用内核（Sentry）拦截系统调用，以 OCI runtime `runsc` 接入 Docker/K8s；README **明确列非目标**（不是 seccomp 过滤器、不是 firejail/AppArmor 包装、不是 VirtualBox/QEMU 意义上的 VM） | **可学**：**「显式非目标」框架**是记录 khy-os 沙箱边界该抄的写法——它刻意**不**是什么。khy-os 的 wasm 沙箱（`wasm-sandbox/`、`chainWasm`、`contextWasm`）是更轻更便携的取舍，与 gVisor 互补而非竞争 |
| [firecracker-microvm/firecracker](https://github.com/firecracker-microvm/firecracker) | 37k† / Apache-2.0 | D3 | E2B 与 microsandbox 底层的 microVMM | 参考实现层；khy-os 若要自建本地 microVM 隔离，这是上游 |

### 6.6 D11 TUI

| 项目 | ★ / 许可 | 语言 | 核心机制 | khy-os 可学 / khy-os 领先 |
|---|---|---|---|---|
| [vadimdemedes/ink](https://github.com/vadimdemedes/ink) | 40k† / MIT（v8.0.0） | TypeScript（Node ≥ 22, ESM） | **React reconciler for the terminal**；**Yoga Flexbox 布局**；`<Static>` 永久渲染区；`useStdin`/`useStdout`；组件级可测 | **khy-os 就在这个栈上**。关键差异：**Ink 给你 `<Static>` 与 Flexbox，但不给安全的全屏渲染**。khy-os 自书的规则（禁 DECSTBM 滚动区、禁 `\x1B[2J`、用 ED0 + 绝对定位，见 `src/cli/tui/AGENTS.md` 并在 `app.js` 强制）是相对朴素 Ink 应用的**真实差异点**；khy-os 还量化了预算（冷启 <100ms、渲染 <16ms、内存 <50MB、resize 防抖 50ms），Ink 不强制这些。⚠️ README 明示**不接受完全 AI 生成的 PR** |
| [Textualize/textual](https://github.com/Textualize/textual) | 37k† / MIT | Python（async 内核） | CSS 式样式；大控件库（按钮/树/数据表/输入/文本域）；**预定义主题**；解耦组件；**专门测试框架**；底层 async 但不强制 | **可学**：Textual 是「主题 + 面板 + 组件 + 测试」最成熟的答案。若 khy-os TUI 继续长大，方向是**声明式主题 token 系统**——而 khy-os 自己的门控规则（「禁止组件内颜色分支，顶层门控」）已经指向同一处。**TUI 回归测试框架**值得抄 |
| [charmbracelet/bubbletea](https://github.com/charmbracelet/bubbletea) | 45k† / MIT（v2） | Go | **The Elm Architecture**（Model/Update/View）；**高性能 cell-based 渲染器**；内置**颜色降采样**；高保真键盘 + 鼠标；原生剪贴板；inline / full-window / mixed 三模式；配套 Bubbles 组件库 | **可学**：**cell-based diff 渲染器 + 颜色降采样**是 khy-os 16ms 渲染预算的具体答案；「inline vs full-window vs mixed」也比「CC 模式/Legacy」二元门控是更干净的心智模型。**领先**：对齐 Claude Code 风格目标视觉规范的品牌/视觉完成度 |
| [sst/opentui](https://github.com/sst/opentui) | 14k† / MIT | TypeScript + Zig 内核 | TS 原生 TUI | 与 khy-os 同语言生态的替代 Ink 之路；若 Ink 的渲染成为瓶颈可评估 |

### 6.7 D12 自愈、自治与审计

| 项目 | ★ / 许可 | 核心机制 | khy-os 可学 / khy-os 领先 |
|---|---|---|---|
| [All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands)（**已改名 "Agent Canvas"**，beta） | 90k† / MIT | 自托管开发者控制中心；开箱跑开源 OpenHands agent，**同时能驱动 Claude Code / Codex / Gemini CLI / Pi / OpenCode 或任何 ACP agent**；多可插拔 agent 后端（本地/Docker/VM/公司基础设施/云）；**定时/Webhook 自动化**接 Slack/GitHub/Linear/Notion；BYO 模型 LLM 配置 | **可学（架构最接近）**：这是与 khy-os 整体主张**最接近的架构类比**——多 agent mesh + 远端后端 + 定时自动化 + BYO 模型。它还验证了 **ACP 是与 A2A 并列的第二互操作协议**，khy-os 应考虑支持。**领先**：khy-os 有打包好的 **Electron 桌面端**（`apps/khyos-desktop`）+ pip/npm 双分发 + CC 风格 Ink TUI；OpenHands 是 web 优先、无桌面端故事。⚠️ 仓库已更名 Agent Canvas 并标 beta，星标覆盖含原 agent |
| [langfuse/langfuse](https://github.com/langfuse/langfuse) | 36k† / MIT 核心（`ee/` 目录单独许可） | LLM 调用/检索/embedding/**agent 动作** trace 摄取；**prompt 管理带版本化 + 强服务端/客户端缓存**；评估（LLM-as-judge / 代码评估器 / 用户反馈 / 人工标注 / 自定义 pipeline）；**数据集与基准跑**；LLM playground 且可从 trace 跳入 | **可学**：prompt 版本化 + 评估 pipeline + 数据集回放正是 `selfOptimizer` / `evolutionPolicy` / `evolutionSafety` 缺的反馈环；**trace → playground → 重跑**回路是「带安全门的自我改进环」该抄的形态。**领先**：khy-os 把**演进策略与演进安全**做成一等概念 |
| [traceloop/openllmetry](https://github.com/traceloop/openllmetry) | 7.5k† / Apache-2.0 | 基于 OpenTelemetry 的自动插桩（OpenAI/Anthropic/向量库/框架）；厂商中立 traces/metrics 可导出到任意 OTel 后端 | **可学（本域最高优先）**：`auditTrajectory/` + `restoreProvenanceCheck` 最便宜的出路是**发 OTel GenAI span 而非自研 trace 格式**——立刻让 Langfuse/Phoenix/Jaeger 与任意 OTel collector 都能当后端。**领先**：khy-os 的 turn 级 provenance 概念已超出 OTel GenAI semconv 所能表达。⚠️ semconv 仍在演进，钉死它有 churn 风险 |
| [AgentOps-AI/agentops](https://github.com/AgentOps-AI/agentops) | 5.9k† / MIT | agent 可观测 + **时间旅行调试** | 时间旅行调试与 khy-os `rewindResume` / `turnCheckpointService` 同一意图，可对照其回放数据模型 |
| [SWE-agent/SWE-agent](https://github.com/SWE-agent/SWE-agent) / [sweepai/sweep](https://github.com/sweepai/sweep) / [nus-apr/auto-code-rover](https://github.com/nus-apr/auto-code-rover) / [gptme/gptme](https://github.com/gptme/gptme) | 21k† MIT / 7.7k† 混合 / 3.1k† 未检出 / 4.4k† MIT | 自动化缺陷修复 agent（SWE-bench 血统）；gptme 是本地优先终端 agent | **注意**：这一批是「自治修 Bug」的最近同类，但**没有一个把自愈做成带策略与安全闸门的子系统**（khy-os 的 `selfRepair` + `selfHeal` + `healEscalationService` + `evolutionSafety` 组合在本次调研中没有对应物）。这是 khy-os 的独创域，也是**缺外部参照系**的域 |

### 6.8 D14 消息通道遥控 + D13 交付分发

| 项目 | ★ / 许可 | 核心机制 | khy-os 可学 / khy-os 领先 |
|---|---|---|---|
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | 392k† / MIT | 助手活在 Discord/iMessage/Slack/Teams/Telegram/WhatsApp + 20 余个通道；macOS/iOS/Android/Windows/Linux 原生 app；一个 Gateway 兼作笔记本个人助理与团队部署；**可信网关 / 不可信执行 / 确定性策略**三分；**入站消息默认按不可信输入处理**，DM 通道默认给未知发送者配对审批 | **可学（安全最高价值）**：**「入站消息即不可信输入」+ DM 默认配对审批**是 khy-os 消息通道该抄的默认安全姿态（khy-os 现有 `messaging/channels/` 七个通道，需核对是否同样 fail-closed）。**领先**：khy-os 的通道面更贴近国内生态（钉钉/飞书/企业微信/iLink） |
| [zhayujie/chatgpt-on-wechat](https://github.com/zhayujie/CowAgent)（**已更名 CowAgent**，README 徽章已指向 `zhayujie/CowAgent`） | 47 303 / MIT | 把 LLM 接入微信个人号/公众号/企业微信；多模型多后端；插件化技能；Docker 一键。更名后自述「**Agent Harness 工程的参考实现**」：planning 循环、multi-agent team、**三层记忆**（context → daily → core）+ Deep Dream 蒸馏、Markdown wiki 知识图谱、**自我进化**；**Skill Hub**（`skills.cowagent.ai`）；web + 全部主流 IM；7×24 部署 | **定位与 khy-os 最像的国产项目**——连「自演化 + IM + Skill Hub + 三层记忆/梦境」四条都对上了，是国产赛道最直接的对手。⚠️ **不要与 `chatgpt-on-wechat` 重复计数**：这是同一个仓库的更名 |
| [rustdesk/rustdesk](https://github.com/rustdesk/rustdesk) | 125k† / **AGPL-3.0** | P2P 直连带 TCP 打洞；独立 **rendezvous/relay server**；屏幕捕获 + 输入控制 + 剪贴板同步 + 文件传输；protobuf 消息 | **可学**：**rendezvous-mediator + relay 分离**正是 khy-os 远端控制/设备配对需要的形态（小信令服务 + P2P 直连 + relay 兜底）。⛔ **AGPL-3.0 强 copyleft，代码不可借用**。**领先**：把桌面端与 AI 运行时 + agent mesh 配对，RustDesk 是通用屏幕共享、无 agent 故事 |
| [juanfont/headscale](https://github.com/juanfont/headscale) | 44k† / BSD-3-Clause | 自托管 Tailscale 控制服务器实现；WireGuard 公钥交换点、IP 分配、用户/节点边界、机器共享、宣告路由；**刻意收窄范围——单一 tailnet，自托管者优先** | **可学**：**「收窄范围」的纪律决策**（单一 tailnet、自托管者优先、多租户特性刻意不做）正是 khy-os 设备配对该明写的边界。BSD-3-Clause **许可宽松，可安全研究借鉴**——与 RustDesk 的关键区别 |

### 6.8a D14 深挖：IM 桥接层（星标不高，但定位与 khy-os 最贴）

大厂级的 IM 遥控（OpenClaw 392k / CowAgent 47k / AionUi 33k / Qwen Code 28k）之外，
还有一批**小而专**的「把本地 CLI 桥到聊天软件」项目。它们星标低，但**设计取向与 khy-os 的
「本地原生终端是主界面、IM 只是远程入口」几乎逐字相同**，是这一域最该逐条对照的一层。

| 项目 | ★ / 许可 | 语言 | 机制 | 对 khy-os 的意义 |
|---|---|---|---|---|
| [UNLINEARITY/CLI-WeChat-Bridge](https://github.com/UNLINEARITY/CLI-WeChat-Bridge) | 526 / **AGPL-3.0** | TS（Node ≥22） | **把微信/企业微信桥接到本地 Codex / Claude Code / OpenCode / Pi CLI**；明确设计成「本地原生终端仍是主界面，微信只是远程入口」；支持线程共享、文件互传、双向 `/resume`；npm 包 `cli-wechat-bridge` | **定位与 khy-os 的 IM 通道几乎逐字相同的一个实现**——连「本地终端是主界面、微信只是入口」这句设计声明都一样。⛔ AGPL-3.0，**只可读设计、不可拷代码**。它是 khy-os `messaging/channels/` 最直接的小型参照 |
| [kaida-palooza/ccpoke](https://github.com/kaida-palooza/ccpoke) | 103 / MIT | TS | Telegram 双向桥：完成通知 / 提问回复 / **权限审批** / 多会话并行；Claude Code + Codex + Cursor；插件架构 | **「经 IM 做权限审批」是 khy-os 该有的能力**（把 `permissionBroker` 的审批面延伸到 IM）。MIT 可安全借鉴 |
| [overwirehq/claude-code-telegram](https://github.com/overwirehq/claude-code-telegram) | 2.8k / 无 LICENSE | Python | Telegram ↔ Claude Code 远程访问；per-project 会话持久化、目录沙箱、审计日志、webhook/CI 通知、agentic 双模式 | per-project 会话持久化 + 审计日志的组合可作参照；⚠️ 无 LICENSE，不可拷 |
| [godagoo/claude-telegram-relay](https://github.com/godagoo/claude-telegram-relay) | 326 / MIT | TS/Bun | Claude Code 常驻 Telegram 个人助理：Supabase 语义记忆、**主动 check-in**、每日简报、语音转写 | 「主动 check-in + 每日简报」与 khy-os 的「随身性/活干完回来汇报」是同一产品意图 |
| [1935417243/AnyBot](https://github.com/1935417243/AnyBot) | 19 / MIT | TS | 本地 AI Coding Agent 控制台 + 远程入口：桌面/Web/**微信/QQ/Telegram/飞书/钉钉**，经 SDK 驱动 Codex/Claude Code/CodeBuddy | 国产全 IM 覆盖 + 「经 SDK 驱动多个 CLI」的形态 |
| [gurudin/anycoding](https://github.com/gurudin/anycoding) | 17 / Apache-2.0 | Java | 把 pty 终端 AI 会话实时镜像到**原生 Android App**（Termux 终端视图，非 web embed，保留 ANSI truecolor / CJK 宽字符 / alt-screen）；cloudflared 直连或托管中继 | **「原生终端视图而非 web embed」是对的技术选择**——与 khy-os 的 Ink TUI 保留 ANSI 语义同一取向。cloudflared 直连 vs 托管中继的两条路也是设备配对的现成方案 |
| [Jeffrey0117/ClaudeBot](https://github.com/Jeffrey0117/ClaudeBot) | 64 / 无 LICENSE | TS | 「手机上的指挥中心」：300ms 草稿式流式编辑、多 AI 路由、任务队列 + 跨 bot mutex、`--resume` 会话记忆、本地 Sherpa-ONNX 语音转码、零 API key 零云中继 | 「零云中继」与 khy-os 私有优先同向；⚠️ 无 LICENSE |

**D14 小结**：这一域的**功能已被中国赛道做成标配**（OpenClaw / CowAgent / AionUi / Qwen Code /
AnyBot 全有微信/飞书/钉钉）。khy-os 的真实差异只剩两条：
① IM 是「**遥控编码 agent**」而非聊天机器人——消息是任务入口，回来汇报的是执行轨迹；
② **七个通道全在一个进程内**（`services/domain/messaging/channels/`），不需外挂桥进程。
而 `UNLINEARITY/CLI-WeChat-Bridge` 的存在说明第 ② 条也不是独创——它是独立项目，
khy-os 是内建通道。

### 6.8b D13 自托管 AI 平台（交付与分发的同类形态）

| 项目 | ★ / 许可 | 语言 | 核心机制 | khy-os 可学 / khy-os 领先 |
|---|---|---|---|---|
| [langgenius/dify](https://github.com/langgenius/dify) | 158k† / **改良 Apache-2.0** | TS/Python | 模型供应商抽象层 + 插件市场（带版本与签名）+ 可观测 + RAG 管道 + agent 编排 | **可学**：**插件市场 + 版本化 + 签名**模型，值得研究后用于 khy-os `services/skills/extensions/`。⛔ 许可附加多租户 SaaS 限制，**用前读全文** |
| [open-webui/open-webui](https://github.com/open-webui/open-webui) | 154k† / Open WebUI License（BSD-3 基底 + 品牌限制） | Python | 自托管 LLM 前端；多后端（Ollama/OpenAI-compatible）；RAG；RBAC； Pipelines 插件框架 | **可学**：Pipelines 的外挂进程模型。**领先**：khy-os 有 CLI/TUI 命令面，OpenWebUI 纯 web |
| [lobehub/lobe-chat](https://github.com/lobehub/lobe-chat) | 83k† / LobeHub Community License | TypeScript | 聊天框架 + 插件市场 + 多模型 + TTS/视觉/知识库 | **可学**：插件市场形态。**领先**：khy-os 是 OS 而非聊天前端 |
| [Mintplex-Labs/anything-llm](https://github.com/Mintplex-Labs/anything-llm) | 67k† / MIT | TypeScript | 本地 RAG 桌面/ Docker 应用；多用户；agent 技能；多向量库后端 | **可学**：多向量库后端选择的产品化呈现。**领先**：khy-os 有编码智能体工具系统 |
| [1Panel-dev/MaxKB](https://github.com/1Panel-dev/MaxKB) | 23k† / **GPL-3.0** | Python | 国内知识库问答；RAG；工作流编排 | ⛔ GPL-3.0 强 copyleft，**代码不可拷入** |
| [labring/FastGPT](https://github.com/labring/FastGPT) | 30k† / 未检出 § | TypeScript | 国内知识库 + 可视化工作流 + 多租户 | 可作国内知识库产品形态参照；许可需先核实 |
| [dataelement/bisheng](https://github.com/dataelement/bisheng) | 12k† / Apache-2.0 | Python | 国内 LLM 应用平台；工作流 + 编排 | 同上 |
| [onyx-dot-app/onyx](https://github.com/onyx-dot-app/onyx) | 32k† / 未检出 § | Python | 团队 AI 助手；连接器生态（Slack/Confluence/Drive…） | **可学**：连接器生态是「随身性」的另一种解法；许可需先核实 |

**D13 小结**：这一域的项目几乎全是 **Docker-first 的 web 平台**。khy-os 的差异是
**双渠道 pip/npm + Electron 桌面 + Flutter 移动 + 便携版**——「一个 `pip install` 就能跑的
编码智能体」在这个集合里没有第二个。代价是 khy-os 没有插件市场（Dify/OpenWebUI/LobeChat 都有），
这与 §7 的「MCP Registry 集成」是同一个缺口的两个面。

**D13 补充：两条值得注意的机制**：

1. **[langflow-ai/langflow](https://github.com/langflow-ai/langflow)（155k†/MIT）每个 flow 可同时导出为
   REST API 和 MCP server**——「一次构建、两种协议暴露」是对外接口的低成本打法，
   khy-os 若要做 ACP/MCP 双面（§7 P0 第 1 项）可直接照搬这个导出思路。
   其 **Langflow Desktop**（Windows/macOS 全依赖打包、免 Python 环境管理）也是
   khy-os 便携版打包的现成参照。
2. **便携/免安装分发**的对标：[pkgxdev/pkgx](https://github.com/pkgxdev/pkgx)（9.9k†/Apache-2.0，
   **4 MiB 独立二进制「能跑任何东西」、无需安装**——最贴近 khy-os 便携版叙事）、
   [jdx/mise](https://github.com/jdx/mise)（35k†/MIT，单二进制管 dev 工具 + env + tasks）、
   [ScoopInstaller/Scoop](https://github.com/ScoopInstaller/Scoop)（25k†，Windows 免 UAC 用户级安装）、
   [AppImage/AppImageKit](https://github.com/AppImage/AppImageKit)（9.4k†/MIT，Linux 单文件免 root）。
   khy-os 的 `portable-setup.bat` / `.sh` 在这条线上没有直接对手，但 pkgx 的
   「一个极小二进制跑任何东西」是比「打包整个 node_modules」更激进的便携答案，值得对照。

### 6.9 D1 / D4 / D5 Agent 主循环、会话与上下文

> 这一域的深度对标已由 `[RESEARCH-019]`（Claude Code 源码架构逐章对照）承担，本报告不重复。
> 这里只补 OSS 侧的横向位置。

| 项目 | ★ / 许可 | D1 主循环/工具 | D4 会话恢复 | D5 上下文工程 |
|---|---|---|---|---|
| [openai/codex](https://github.com/openai/codex) | 128k† / Apache-2.0（**Rust**） | ●●● Rust TUI + 沙箱 + 审批模式，是**双域最强参照** | ●●● | ●● |
| [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) | 107k† / Apache-2.0 | ●●● | ●●● | ●● |
| [sst/opencode](https://github.com/sst/opencode) | 212k† / MIT | ●●● | ●●● | ●● |
| [All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands) | 90k† / MIT | ●●● | ●● | ●● |
| [cline/cline](https://github.com/cline/cline) | 70k† / Apache-2.0 | ●●● | ●● | ●● |
| [Aider-AI/aider](https://github.com/Aider-AI/aider) | 49k† / Apache-2.0 | ●● | ● | ●● |
| **khy-os** | — | ●●●（`runToolUseLoop` 30+ continue 点 + 流式工具执行 + 三阶段工具注册表） | ●●●（`sessionPersistence`/`turnCheckpointService`/`rewindResume`/`worktreeManager`） | ●●●（`contextCompressor`/`contextPruner`/`cognitiveSnapshot`） |

**D5 的特殊性**：整个对标集里**没有专门项目**做「上下文工程」。最接近的是各家 CLI 自带的
compact 机制，以及 Mem0/supermemory 的记忆压缩。khy-os 的 `cognitiveSnapshot/`
（`compressionEngine` + `overflowInterceptor` + `offloadStore` + `snapshotManager` + `workbench`）
在本次调研的约 148 个仓库中**没有同类物**。

### 6.9b D1 补充：其余 Agent CLI 的横向位置

| 项目 | ★ / 许可 | 语言 | 一句话定位 | 与 khy-os 的关系 |
|---|---|---|---|---|
| [sst/opencode](https://github.com/sst/opencode) | 212k† / MIT | TypeScript（Bun monorepo） | 开源 AI 编码 agent：TUI + 桌面 + CLI + web + IDE | **同形态最近的一个**（TUI + 多入口 + 插件 + Skills 平级）。差异：opencode 无网关账号池、无自愈子系统、无守卫矩阵 |
| [openai/codex](https://github.com/openai/codex) | 128k† / Apache-2.0 | **Rust** | OpenAI 官方编码 agent | **双域最强参照**（Rust TUI + 沙箱 + 审批模式）。用 Rust 重写是对 khy-os Node 技术栈的对照实验 |
| [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) | 107k† / Apache-2.0 | TypeScript | Google 官方开源编码 agent | 同技术栈；大规模开源项目，可对照其上下文管理实现 |
| [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) | 28k† / Apache-2.0 | TypeScript | Gemini CLI 的 Qwen 分支 | 证明「fork 官方 CLI 换模型」是一条低成本的进入路径 |
| [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode) | 28k† / MIT | TypeScript | VS Code 内编码 agent | IDE 优先形态 |
| [RooCodeInc/Roo-Code](https://github.com/RooCodeInc/Roo-Code) | 24k† / Apache-2.0 | TypeScript | Cline 分支，模式化 agent | IDE 优先形态 |
| [CodebuffAI/codebuff](https://github.com/CodebuffAI/codebuff) | 13k† / Apache-2.0 | TypeScript | 多 agent 协同编码 CLI | 多 agent 分工形态的参照 |
| [plandex-ai/plandex](https://github.com/plandex-ai/plandex) | 16k† / MIT | Go | 长任务规划型编码 agent | **plan mode 的深度参照**（khy-os 也有 `planModeService`） |
| [gptme/gptme](https://github.com/gptme/gptme) | 4.4k† / MIT | Python | 本地优先终端 agent | 本地优先形态的小型参照 |
| [SWE-agent/SWE-agent](https://github.com/SWE-agent/SWE-agent) | 21k† / MIT | Python | SWE-bench 研究型 agent | 研究血统；不是产品形态 |
| [charmbracelet/crush](https://github.com/charmbracelet/crush) | 29k† / **FSL-1.1-MIT** | Go | Charm 的编码 agent CLI | ⚠️ 功能性源码许可，非标准 MIT |
| [Aider-AI/aider](https://github.com/Aider-AI/aider) | 49k† / Apache-2.0 | Python | 配对编程式编码 agent | 最早的开源编码 agent 之一；**无子代理、无 MCP、无会话恢复**，是「单 agent 能走多远」的标尺 |

**D1 小结**：这一域的格局是「**四家大厂官方 CLI**（OpenAI/Google/Qwen fork + Anthropic 的
Claude Code）+ **三 IDE 系**（Cline/Roo/Kilo）+ **若干独立 TUI**（opencode/crush/aider）」。
khy-os 在功能广度上超过其中任何一家，但**在「单点深度」上未必**：
codex 的 Rust 沙箱、plandex 的长任务规划、aider 的 diff 工作流，都是值得逐项对照的具体实现。
这也是 `[RESEARCH-019]`（Claude Code 逐章对照）已经开过工的方向，本报告不重复。

### 6.9c D1 深挖：harness 生态层（本次调研最重要的发现）

如果把「编码智能体」再往下拆一层，会发现 2026 年已经长出了一个 **harness 生态层**——
不再竞争「谁的 agent 强」，而是竞争「谁能托管更多 agent」。这一层与 khy-os 的
「平台 OS」定位**正面相撞**，是本报告最该被读到的部分。

| 项目 | ★ / 许可 | 语言 | 定位 | 关键机制 | 对 khy-os 的意义 |
|---|---|---|---|---|---|
| [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) | 28 386 / Apache-2.0 | TS/Node | **功能集上最接近 khy-os 的双胞胎** | 自列对等表：SubAgents、**Agent Teams**、**Dynamic Workflows**、**Auto-Memory**、**Auto-Skills**、Hooks、内置技能（`/review` `/batch` `/loop` `/bugfix`）、MCP、**Plan Mode**、**LSP 集成**、Auto Mode、Sandbox、**Git Worktrees**、IDE 插件、**多协议**（OpenAI/Anthropic/Gemini/Qwen + 任意供应商，运行时可切）、**Agent Arena**（同一任务多模型对抗评测）、**Daemon Mode**（`qwen serve`，多客户端共享 agent）、ACP 桥。harness 上限：`max_iterations=500`、`runtime_timeout_sec=7200`、`agent_timeout_multiplier=3.0` | **最该逐条对照的一份清单**。khy-os 缺两样：**Agent Arena**（同任务多模型并排，是廉价却有差异的评测功能）与 **daemon mode**（一个 agent server 多客户端——khy-os 的 backend + gateway 结构上正适合）。它的**中文 IM 集成**（Telegram/钉钉/微信/飞书）也直接对口 khy-os 用户群 |
| [iOfficeAI/AionUi](https://github.com/iOfficeAI/AionUi) | 33 402 / Apache-2.0 | Rust + 桌面 | **统一桌面宿主，托管约 25 个外部 agent** | 自动探测并托管 Claude Code / Codex / Qwen Code / Gemini CLI / Goose / OpenClaw / Kimi CLI / OpenCode / Factory Droid / Copilot / Qoder / Cursor Agent / Pi / Antigravity…；并行会话独立上下文；**统一 MCP 管理**（按 agent 能力注入/同步 transport）；外部 agent 经 **ACP** 接入；WebUI + **Telegram/Lark/钉钉/微信远端访问**；**Team Mode**——Leader agent 拆解指令并委派 Teammate，经内置 **Team MCP Server** 通信，队友并行、共享**异步邮箱**、写**共享任务板**、运行中可动态增删、**每 agent 独立权限对话框 + 侧栏待批徽标** | **Team Mode 是整个调研里最成熟的子代理编排设计**，khy-os 的子代理比它简单。「约 25 agent 自动探测 + 统一 MCP 同步」也是「宿主而非竞争」的最佳表达 |
| [obra/superpowers](https://github.com/obra/superpowers) | 296 906 / MIT | Markdown/技能 | **Agentic 技能框架 + SD 方法论** | 装进约 16 个 harness（Claude Code / Codex CLI+App / Cursor / Gemini CLI / OpenCode / Pi / Qwen Code / Devin CLI / Factory Droid / Copilot CLI / Grok Build / Kimi Code / Antigravity / Hermes / Muse…）；强制自动触发的工作流技能链：brainstorming → 设计文档 → 计划 → **subagent-driven-development**（每个任务一个新 subagent + review）或 executing-plans → requesting-code-review（按严重度排序，critical 阻断）；compaction 后重新注入 bootstrap；含一个读自己会话转录做行级取证的 `diagnosing-superpowers` 技能 | **「技能赢了扩展单元之争」的最清晰信号**。khy-os 有技能，但**没有方法论层、没有市场** |
| [bytedance/deer-flow](https://github.com/bytedance/deer-flow) | 83 587 / MIT | Python | **超级 agent harness**：子代理 + 记忆 + 沙箱 | 由可扩展技能驱动；2.0 全面重写（2026-02 登 GitHub Trending 第一）；附带 `LLM Space` 桌面工具——可原型化 agent 想法、**检视 harness 每一步、回放失败、跑基准** | **harness 可观测性与回放**的强参照，正是 khy-os 缺的一整块 |
| [farion1231/cc-switch](https://github.com/farion1231/cc-switch) | 142k† / MIT | TS | 跨 harness 统一控制面 / 供应商切换器 | 一套桌面端管 Claude Code / Codex / OpenCode / OpenClaw / Grok Build / Hermes Agent | 证明「统一控制面」有真实需求——**khy-os 的网关正可以占这个位** |
| [zhayujie/CowAgent](https://github.com/zhayujie/CowAgent) | 47 303 / MIT | — | 中文；自述「**Agent Harness 工程的参考实现**」 | 主动规划、computer control、**自创并运行 Skills**、个人知识库 + 长期记忆、多 agent 团队、自演化；**Skill Hub**（`skills.cowagent.ai`）；web + 全部主流 IM 平台；7×24 部署 | **定位与 khy-os 最像的国产项目**（连「自演化 + IM + Skill Hub」三条都对上了），是国产赛道最直接的对手 |
| [1jehuang/jcode](https://github.com/1jehuang/jcode) | 20 372 / MIT | **Rust** | 「最省内存的 harness」 | **共享 daemon 多会话**：每增一会话约 3.1 MB，对比 Claude Code 约 164 MB（约 54×）；记忆图 + 记忆 sideagent + 显式记忆工具 + 会话 RAG；**self-dev 模式**（agent 改/编/测自己的源码并重载自己的二进制）；**跨 harness 会话续跑**（codex / Claude Code / OpenCode / Pi）；同仓多 agent 协作带代码移位冲突通知 + DM/广播；`~/.claude.json`/`.mcp.json`/`.claude/mcp.json`/`~/.codex/config.toml` 的 MCP 配置导入器 | **会话可移植**与 **daemon 多客户端**两个概念的参考实现。khy-os 若做出可移植转录格式，就能成为「记录系统」 |
| [Gentleman-Programming/engram](https://github.com/Gentleman-Programming/engram) | 7.1k† / MIT | Go | **编码 agent 的持久记忆（独立服务）** | agent 无关单二进制；SQLite + FTS5；MCP server + HTTP API + CLI + TUI；支持 14 个 agent | 「记忆即独立服务」模式；khy-os 的记忆在进程内，这是另一种取舍 |
| [shareAI-lab/Kode](https://github.com/shareAI-lab/Kode) | 5.2k† / Apache-2.0 | TS | 中文；AGENTS.md 标准原生支持（60k+ 项目） | `@run-agent-name` 子代理委派；插件市场（GitHub/URL）；**ACP agent server over stdio JSON-RPC**（供 Toad/Zed）；⚠️ **YOLO 默认 + `--safe` 选入**（安全姿态警告）；斜杠命令补全 | 国产 ACP 实现的参照；其「YOLO 默认」是**反面教材** |
| [earendil-works/pi](https://github.com/earendil-works/pi) | 113 820 / MIT | TS（Node） | 「最小、可扩展、你可自塑的 agent harness」——**反克隆 Claude Code** 立场 | 扩展/技能/提示模板/主题打包为 **Pi packages** 经 npm/git 分发；interactive / print / JSON 三模式；**RPC 控制面**；TS SDK；**明确不做子代理与 plan mode**；**明确没有内置权限系统**（「以启动它的用户与进程的权限运行」，沙箱靠容器化或 Gondolin micro-VM 扩展）；配套 `chord`（应用组合运行时）/`pi-ai`（统一多供应商 LLM API）/`pi-agent-core` | **「harness + packages」分层是让广度可维护的关键**——这是对 khy-os 145 万行单体的最重要架构启示。Pi 的诚实（明说没有权限系统）也值得学 |
| [ultraworkers/claw-code](https://github.com/ultraworkers/claw-code) | 195k† / MIT | Rust | ⚠️ 自述「**博物馆展品**」，不是产品 | agent 管理的产物，指向 `code-yeongyu/lazycodex` 与 `Yeachan-Heo/gajae-code` 为真 harness | **仅作为「meme 驱动星标虚高」的证据收录；不得把它的星标当质量信号** |

**仓库更名（本次已核实，旧名重定向）**：

| 旧名 | 新名 | ★（核实一致） |
|---|---|---|
| `sst/opencode` | `anomalyco/opencode` | 212k† |
| `All-Hands-AI/OpenHands` | `OpenHands/OpenHands` | 90k† |
| `block/goose` | `aaif-goose/goose` | 55k† |
| `Calcium-Ion/new-api` | `QuantumNous/new-api` | 50k† |
| `envoyproxy/ai-gateway` | `theagentrouter/agent-router` | 2.2k† |
| `katanemo/arch-gateway` | `katanemo/plano` | 7.1k† |
| `CodebuffAI/codebuff` | 更名 Freebuff | 13k† |

### 6.9d D1 可持续性警报（2026-10 实测，README 原文核实）

| 项目 | ★ | 状态 | 证据 |
|---|---|---|---|
| [Continuedev/continue](https://github.com/Continuedev/continue) | 36k† | ⛔ **已停止维护，仓库对全员只读** | README 第 19 行原文：*"The `continuedev/continue` repository is no longer actively maintained and is read-only for all users."* |
| [RooCodeInc/Roo-Code](https://github.com/RooCodeInc/Roo-Code) | 24k† | ⛔ **VS Code 扩展已于 5 月 15 日关停** | README 第 66 行原文：*"The Roo Code Extension was shut down on May 15th."* |
| [aws/amazon-q-developer-cli](https://github.com/aws/amazon-q-developer-cli) | 2k† | ⛔ 已被闭源 Kiro CLI 取代 | 子智能体报告，README 未逐字核实 |
| [block→aaif-goose/goose](https://github.com/aaif-goose/goose) | 55k† | ⚠️ 已移交 **Linux Foundation 旗下 Agentic AI Foundation** | 子智能体报告；基金会托管是可持续性答案的信号 |
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | 392k† | ✅ **OpenClaw Foundation（独立 501(c)(3)）托管，无付费层/无代币** | README 原文核实 |

> **这一节的意义**：两个曾经的对标项目（continue 36k、Roo-Code 24k）在本次调研窗口内
> 先后退场。结合 goose 移交基金会、OpenClaw 成立 501(c)(3)，
> **「基金会/法人托管 + 明文的维护模型」已成入场券**。
> khy-os 的治理优先姿态在这件事上是真资产——但它目前**对外不可见**
> （没有对外的治理文档、贡献模型、发布节奏说明），这是 §7 的一条软缺口。

### 6.10 D15 工程治理

**这一域没有对标项目**，只有 khy-os 自己在做。可对照的最近物是：

| 参照 | ★ / 许可 | 它做了什么 | 与 khy-os 的差距 |
|---|---|---|---|
| [koalaman/shellcheck](https://github.com/koalaman/shellcheck) | 40k† / GPL-3.0 | 单一职责的静态分析器，做到领域内事实标准 | khy-os 是**101 个守卫**的矩阵而非单一工具；形态不同，不可比 |
| [trufflesecurity/trufflehog](https://github.com/trufflesecurity/trufflehog) | 28k† / AGPL-3.0 | 密钥泄露扫描 | 与 khy-os R2 出厂件明文密钥守卫（`scripts/check_builtin_keys.py`）同目的，但 trufflehog 是通用扫描器、khy-os 是**出厂件专用判据** |
| [open-policy-agent/opa](https://github.com/open-policy-agent/opa) | 12k† / Apache-2.0 | Rego 策略引擎 | 可作 `permissionBroker` 的策略求值器候选（khy-os 现在是内嵌 JS 策略） |
| [mvdan/sh](https://github.com/mvdan/sh) | 9.1k† / BSD-3-Clause | Go shell 解析器（AST 级） | `shellSafetyValidator` 若要 AST 级校验可借鉴其解析思路；BSD-3-Clause 许可宽松 |

> **结论**：khy-os 的「规则登记表（`RULES-REGISTRY.json`）+ 101 个守卫 + 3 233 个测试文件」
> 这套把工程纪律本身产品化的做法，在本次调研的约 148 个仓库里**是孤例**。
> 这既是护城河，也意味着**没有外部参照系**——一旦纪律退化，只能靠自己发现。

---

## 7. 差距清单：可借鉴项（按可执行性排序）

> 「可执行性」= 改动面是否收窄、是否有明确的参照实现、是否触碰红线 R1–R4。
> 每条给出来源项目、khy-os 侧落点、以及预估改动面。**本清单是调研结论，不是实施承诺**；
> 是否立项、按什么顺序做，属项目决策，需走 `[DESIGN-PROCESS-001]` 委派判据与需求五问。

| 优先级 | 差距 | 来源 | khy-os 落点 | 为什么值得做 | 预估改动面 |
|---|---|---|---|---|---|
| **P0** | **ACP（Agent Client Protocol）互操作** | [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) 90k†、[aaif-goose/goose](https://github.com/aaif-goose/goose) 55k†、[iOfficeAI/AionUi](https://github.com/iOfficeAI/AionUi) 33k†、[shareAI-lab/Kode](https://github.com/shareAI-lab/Kode) 5.2k†、[QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) 28k† 的「Claw」桥 | 新增 ACP 服务面（khy-os 已有 `acpTransport.js` / `acpAgentAdapter.js`，需核实是否是对外可用的 server） | **没有 ACP 面，khy-os 对新兴宿主层完全不可见**——AionUi 一家就自动探测约 25 个 agent，Kode 用 ACP 供 Toad/Zed 驱动，goose 用 ACP 做订阅认证。这是本次调研**优先级最高的单项** | 中（协议适配 + 服务端） |
| **P0** | **无头 Agent Server + SDK 拆分** | [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk) 1.2k† → REST/WS Agent Server → 薄前端 | `runtime/node/backend/` 拆出可 pip 安装的 SDK + 文档化 REST 面 | 这是 2026 年的**共识架构**（SDK → OpenAPI 契约 → 多前端）。khy-os 的 backend 已经走了一大半，抽出 SDK 即可解锁 CI/云/远端用法与第三方前端 | 中偏大 |
| **P0** | **daemon / 多客户端模式** | [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) 的 `qwen serve`；[1jehuang/jcode](https://github.com/1jehuang/jcode) 的共享 daemon（每增一会话 3.1 MB vs Claude Code 164 MB） | `services/daemonManager.js` + gateway | khy-os 的「backend + gateway」结构上**正适合**做这个，且已有 daemon 管理器；jcode 的内存数字说明这个模式的收益量级 | 中 |
| **P0** | **向量库后端广度** | [HKUDS/LightRAG](https://github.com/HKUDS/LightRAG) 40k† | `services/domain/memory/memoryEngine/vectorStore.js` | khy-os 只有 InMemory + File 两个后端；LightRAG 证明「一个库、N 种存储后端全可换」是可行形态。**LanceDB**（12k†/Apache-2.0，嵌入式落盘）与「便携版随身带」定位天然契合，是最该评估的第三个后端 | 中（新增一个后端实现 + 选择开关） |
| **P0** | **MCP Registry 集成** | [modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry) 7.3k†（Go + PostgreSQL） | `services/domain/messaging/mcp/mcpEcosystemRegistry.js` / `DiscoverSkillsTool` | MCP Registry 已是工具发现的规范层（MCP 服务器的 app store）。khy-os 有发现工具但**没有 registry 客户端**——这是 D9 域最具体的缺口，且是对外生态入口 | 中（HTTP 客户端 + 缓存 + 安装流） |
| **P1** | **技能/插件市场（分发渠道）** | [obra/superpowers](https://github.com/obra/superpowers) 297k†（装进约 16 个 harness）、OpenClaw ClawHub、Kilo Marketplace、[zhayujie/CowAgent](https://github.com/zhayujie/CowAgent) Skill Hub | `services/skills/extensions/` + `skillPackageService.js` | **「技能赢了扩展单元之争」，但 khy-os 零分发渠道**。49 个内置技能 + 双 harness 桥是资产，没有市场就变不成生态引力。这与 MCP Registry 是同一缺口的两个面 | 大 |
| **P1** | **子代理编排成熟度（Team Mode）** | [iOfficeAI/AionUi](https://github.com/iOfficeAI/AionUi) 33k† | `subAgentOrchestrator.js` / `AgentTool` | AionUi 的 Team Mode 是整个调研里最成熟的子代理编排：Leader 拆解 → 经 Team MCP Server 委派 Teammate → 队友并行 + 共享**异步邮箱** + **共享任务板** + 运行中动态增删 + **每 agent 独立权限对话框与待批徽标**。khy-os 的子代理比它简单 | 中偏大 |
| **P1** | **Config-as-code 路由** | [Portkey-AI/gateway](https://github.com/Portkey-AI/gateway) 13k† 的声明式 JSON Configs；[katanemo/plano](https://github.com/katanemo/plano) 7.1k† 的 YAML | `services/gateway/` 路由规则落盘处 | 网关规则必须能在 git 里被 review，而不是只能在 DB/UI 里改。这与 khy-os 自己的「真源进 git」文化同构，属文化内改进 | 中（规则序列化 + 加载 + 校验） |
| **P1** | **harness 可观测性与失败回放** | [bytedance/deer-flow](https://github.com/bytedance/deer-flow) 84k† 的 `LLM Space`（检视每一步、回放失败、跑基准）；[traceloop/openllmetry](https://github.com/traceloop/openllmetry) 7.5k† 的 OTel GenAI span | `services/auditTrajectory/` + `restoreProvenanceCheck` | khy-os 有轨迹 provenance（超出 OTel semconv 表达力），但**没有「回放失败 + 跑基准」这一步**。发标准 span 可让 Langfuse/Phoenix/Jaeger 直接当后端 | 中（⚠️ semconv 仍在演进，钉死它有 churn 风险） |
| **P1** | **LSP 作为上下文源** | [charmbracelet/crush](https://github.com/charmbracelet/crush) 29k†（"uses LSPs for additional context, just like you do"）；[QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) 28k† 的 LSP 集成 | `services/lspClient.js`（已存在，需核实是否进上下文链） | 这是被采纳得最不足的好想法。khy-os 已有 `lspClient.js`，问题是它是否真的喂进了上下文 | 小（若已接线则仅需验证） |
| **P1** | **沙箱分层** | [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands)（每会话一容器）、[aaif-goose/goose](https://github.com/aaif-goose/goose)（sandbox mode）、[microsandbox/microsandbox](https://github.com/microsandbox/microsandbox) 8.6k†（fork/snapshot/restore + OCI 兼容） | `services/sandbox/` + `services/restore/` | 分叉一个**运行中**沙箱并稍后恢复，是比文件级回退强得多的原语；OCI 兼容意味着可复用现有镜像而非自定格式。⚠️ Pi 的诚实（明说没有权限系统，靠容器化）是前车之鉴 | 大（涉及隔离边界） |
| **P2** | **多模型对抗评测（Agent Arena）** | [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) 28k† | `services/evals/` + `services/arenaManager.js`（两者均已存在） | 同一任务多模型并排，是**廉价却有差异**的评测功能。khy-os 已有 `arenaManager.js` 与 `evals/`，可能已部分具备——**先核实再决定是否立项** | 小（若已有则仅需产品化） |
| **P2** | **会话/转录可移植** | [1jehuang/jcode](https://github.com/1jehuang/jcode) 20k†（跨 harness 续跑 codex / Claude Code / OpenCode / Pi 会话） | `services/sessionPersistence.js` + `ccSkillBridge` 同型的桥 | 可移植转录格式可让 khy-os 成为「记录系统」——这是把护城河变成网络效应的少数路径之一 | 中偏大 |
| **P2** | **双时序（bi-temporal）事实建模** | [getzep/graphiti](https://github.com/getzep/graphiti) 32k† | `services/domain/memory/memoryEngine/` 的 staleness 检测 | 业界已就「带显式生效窗口的事实 + 自动失效 + 全历史保留」收敛（Graphiti/supermemory/Memobase/cognee/memoripy 五家都有）。khy-os 的 staleness 检测应以此为建模基准 | 中偏大（触及记忆数据模型） |
| **P2** | **技能多级优先级链 + 智能体自创技能（带历史与 undo）** | [openclaw/openclaw](https://github.com/openclaw/openclaw) 392k† | `services/skills/skillSourceSpec.js`（258 行）+ `src/skills/built-in/` | OpenClaw 有**文档化的 7 级优先级链 + 冲突解决**；其「Skill Workshop」= 智能体自学技能带历史与 undo，正是 khy-os `dreamPromote`/distiller 记忆回路在技能上的自然延伸 | 中 |
| **P2** | **显式压缩档位开关** | [cline/cline](https://github.com/cline/cline) 70k† 的 `--compaction agentic\|basic\|off` | `services/contextCompressor.js` / `compact/` | 小而高杠杆的 UX 细节：让用户选压缩策略，而不是只有一个隐式行为 | 小 |
| **P2** | **治理对外可见化** | [aaif-goose/goose](https://github.com/aaif-goose/goose)（Linux Foundation）、[openclaw/openclaw](https://github.com/openclaw/openclaw)（501(c)(3)） | 新增对外治理/贡献/发布节奏文档 | **§6.9d 的直接结论**：两个对标项目在本窗口退场，幸存者都有法人托管或明文的维护模型。khy-os 的治理是真资产但**对外不可见** | 小（纯文档） |
| **P2** | **入站消息默认不可信 + DM 配对审批** | [openclaw/openclaw](https://github.com/openclaw/openclaw) 392k† | `services/domain/messaging/channels/` | OpenClaw 安全指南明示「Treat inbound messages as untrusted input」且 DM 通道默认给未知发送者配对审批。khy-os 有七个通道，**需核对是否同样 fail-closed**——这是安全姿态，不是功能 | 小（但重要） |
| **P3** | **按错误码的差异化回退触发 + header/body 条件路由** | Portkey（按错误码）；[musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) 38k†（header/body 条件） | `services/gateway/aiGatewayRoutingMethods.js` | 比一刀切重试策略更有表达力：对 429 退避、对 5xx 切换、对上下文超限压缩后重试，各走各路 | 中 |
| **P3** | **记忆即独立服务** | [Gentleman-Programming/engram](https://github.com/Gentleman-Programming/engram) 7.1k†（Go 单二进制 + SQLite FTS5 + MCP server，支持 14 个 agent） | `services/domain/memory/memoryEngine/` | 「记忆即独立服务」是与 khy-os「记忆在进程内」并列的另一种取舍；若要走 MCP 路线，engram 是现成参照 | 中 |
| **P3** | **分块可视化人工干预** | [infiniflow/ragflow](https://github.com/infiniflow/ragflow) 92k† | `vectorStore` / 检索链路 | RAG 域最好的 UX 想法，khy-os 无同类物。属体验层，不紧急 | 大 |
| **P3** | **AgentSkills 规范细节补全 + Agent-Card 元数据** | [anthropics/skills](https://github.com/anthropics/skills) 180k‡ + `agentskills.io`；[a2aproject/A2A](https://github.com/a2aproject/A2A) 26k† | `services/skills/skillLoader.js`；`a2aRegistry` / `a2aFacade` | 技能侧三条：`name` 必须等于父目录名、禁连续连字符、**`compatibility` 字段**（与 Portable 规约天然一对）、`allowed-tools` 预授权。A2A 侧：暴露 Agent-Card 形态元数据可免费换来互操作 | 小 |

---

## 8. khy-os 的独有位置（调研确认的领先项）

### 8.1 确认领先

| 领先项 | 证据 | 对手状态 |
|---|---|---|
| **工程治理（D15）** | 3 233 测试文件 + 101 CI 守卫 + `RULES-REGISTRY.json` 规则登记表 + 三守卫 CI | **约 148 个仓库中孤例**。最近的同类是 shellcheck/trufflehog 这类单一职责工具，形态不同不可比 |
| **自愈/自治带策略与安全闸门（D12）** | `selfRepair` + `selfHeal` + `healAuditService` + `healEscalationService` + `evolutionPolicy` + `evolutionSafety` + `bugSentinel` | SWE-agent / sweep / auto-code-rover 都在做自治修 Bug，但**没有一个把自愈做成带策略与安全闸门的子系统** |
| **认知快照（D5）** | `cognitiveSnapshot/`（compressionEngine + overflowInterceptor + offloadStore + snapshotManager + workbench） | **无同类物**。整个对标集没有专门项目做上下文工程 |
| **记忆梦境/晋升生命周期（D7）** | `dreamPromote.js` + `distiller.js` + `progressLog.js` | Mem0 只有 ADD-only 累积；supermemory 无梦境；cognee 有 `improve` 操作但无梦境回路；Letta 无对应物 |
| **跨 harness 技能复用** | `ccSkillBridge.js` + `ocSkillBridge.js`：零 IO、env 门控、fail-soft 地发现 CC 与 OpenClaw 的技能根，解析器与 AgentSkills 格式**字节兼容** | cognee 与 Zep **才刚刚**开始发 Claude Code / Codex 插件；khy-os 已能原生读它们的技能根 |
| **项目/代码库中心记忆** | `sessionCheckpoint` / `topicSwitch` / `sessionMemory` / `progressLog` 全按项目/会话/主题切分 | 业界几乎全是**用户画像中心**（Memobase、supermemory）或**文档中心**（RAGFlow、QAnything），无代码图概念（supermemory 只有 AST 感知分块） |
| **本地性 / 便携** | pip + npm + Docker + Electron + Flutter + `portable-setup`；数据全在本地 | E2B 纯云且需 API key；Daytona 云；microsandbox 本地但年轻。khy-os 的「便携版随身带」在离线/气隙场景是真护城河 |
| **本土化（命令面）** | 中文与拼音命令（245 命令 / 591 别名，`aliases.js` 中 468 行含 CJK）、中文错误消息、用量按人民币计价 | 国产对手（CowAgent / Qwen Code / AionUi / Kode）都有**中文 IM 接入**，但**未发现第二个有中文命令面 + 中文错误消息**的项目。⚠️ 注意：「中文 IM 接入」已是国产标配，不是差异点——差异仅在「中文命令面」这一条 |

### 8.2 ⚠️ 缺外部参照系的风险（必须自己盯）

D12（自愈/自治）与 D15（工程治理）是本次调研确认的**两个没有外部参照系的域**。
这有两面：
- **好的一面**：没有对手在这两个域竞争，护城河真实存在。
- **坏的一面**：**一旦纪律退化，没有外部项目可以对照发现**。业界不会有人发一篇
  「khy-os 的守卫退化了」的文章，因为没人知道该拿什么标准衡量。

可落地的对冲（不违反「本清单是调研结论不是实施承诺」）：

1. **把 D12/D15 的判据写成可对外的数字**（守卫数、测试文件数、规则登记表条目数、
   三守卫通过率），定期快照进 `docs/11_报告/metrics/`，让退化在数字上可见。
2. **给 D12 找一个半参照系**：Langfuse 的「trace → playground → 重跑」回路 +
   LangGraph 的 durable-execution 语义，可以作为自愈环的**外部词汇表**，
   即使它们不做自愈，也能用来校验 khy-os 的自愈环是否闭环。
3. **把 D15 变成对外可见的资产**（见 §6.9d）：goose 移交 Linux Foundation、
   OpenClaw 成立 501(c)(3)、而 continue 与 Roo-Code 在本窗口退场。
   khy-os 的治理姿态是这三件事里唯一还没被外部看到的——一份对外的治理/贡献/发布节奏
   文档，是把内部纪律转成外部信任的最低成本动作。

---

## 9. 许可证红线（拷代码前必读）

调研中确认**不是 OSI 开放源码**或**有额外约束**的高星项目。这些项目的代码
**不可随意拷入 khy-os**（khy-os 双渠道分发，含 pip wheel）：

| 项目 | ★ | 许可证 | 约束 |
|---|---|---|---|
| [netease-youdao/QAnything](https://github.com/netease-youdao/QAnything) | 14k† | **AGPL-3.0** | 强 copyleft，不可进宽松/商业分发 |
| [QuantumNous/new-api](https://github.com/QuantumNous/new-api) | 50k† | **AGPL-3.0** | 同上 |
| [rustdesk/rustdesk](https://github.com/rustdesk/rustdesk) | 125k† | **AGPL-3.0** | 同上 |
| [renovatebot/renovate](https://github.com/renovatebot/renovate) | 23k† | **AGPL-3.0** | 同上 |
| [trufflesecurity/trufflehog](https://github.com/trufflesecurity/trufflehog) | 28k† | **AGPL-3.0** | 同上 |
| [Skyvern-AI/skyvern](https://github.com/Skyvern-AI/skyvern) | 23k† | **AGPL-3.0** | 同上 |
| [qixing-jk/all-api-hub](https://github.com/qixing-jk/all-api-hub) | 4.9k† | **AGPL-3.0** | 同上 |
| [koalaman/shellcheck](https://github.com/koalaman/shellcheck) | 40k† | **GPL-3.0** | 强 copyleft |
| [netblue30/firejail](https://github.com/netblue30/firejail) | 7.7k† | **GPL-2.0** | 强 copyleft |
| [1Panel-dev/MaxKB](https://github.com/1Panel-dev/MaxKB) | 23k† | **GPL-3.0** | 强 copyleft |
| [n8n-io/n8n](https://github.com/n8n-io/n8n) | 207k† | **Sustainable Use License** | **非 OSI**，source-available |
| [inngest/inngest](https://github.com/inngest/inngest) | 5.9k† | **SSPL v1.0** | **非 OSI** |
| [restatedev/restate](https://github.com/restatedev/restate) | 4.5k† | **BSL 1.1** | **非 OSI** |
| [Arize-ai/phoenix](https://github.com/Arize-ai/phoenix) | 12k† | **Elastic License 2.0** | **非 OSI**（LICENSE 原文核实） |
| [hashicorp/vault](https://github.com/hashicorp/vault) | 36k† | **BUSL 1.1** | **非 OSI**，限制竞争性使用 |
| [charmbracelet/crush](https://github.com/charmbracelet/crush) | 29k† | **FSL-1.1-MIT** | 功能性源码许可，非标准 MIT |
| [langgenius/dify](https://github.com/langgenius/dify) | 158k† | **改良 Apache-2.0** | 附加条件（多租户 SaaS 限制），**用前读全文** |
| [anthropics/skills](https://github.com/anthropics/skills) | 180k‡ | 混合 | 多数技能 Apache-2.0，但 `docx`/`pdf`/`pptx`/`xlsx` 文档技能是 **source-available，非开源** |
| [BerriAI/litellm](https://github.com/BerriAI/litellm) | 61k† | MIT + `enterprise/` 单独商业许可 | 核心 MIT，企业目录不可用 |
| [langfuse/langfuse](https://github.com/langfuse/langfuse) | 36k† | MIT 核心，`ee/` 单独许可 | 核心可用，`ee/` 不可 |
| [maximhq/bifrost](https://github.com/maximhq/bifrost) | 8.7k† | Apache-2.0 | ⚠️ 自适应负载均衡/集群/守卫/自定义插件/OIDC **门控在付费层**，核心比功能列表窄 |
| [microsoft/autogen](https://github.com/microsoft/autogen) | 61k† | **CC-BY-4.0**（仓库级 LICENSE） | 代码用 CC 许可不寻常，**复用前逐文件核实** |
| [Significant-Gravitas/AutoGPT](https://github.com/Significant-Gravitas/AutoGPT) | 188k† | 混合 | `autogpt_platform/` 为 Polyform Shield，其余另一套——**读 LICENSE** |
| [open-webui/open-webui](https://github.com/open-webui/open-webui) | 154k† | Open WebUI License（BSD-3 基底 + 品牌限制） | 可自用，改品牌分发前读全文 |
| [lobehub/lobe-chat](https://github.com/lobehub/lobe-chat) | 83k† | LobeHub Community License | Apache-2.0 基底 + 品牌限制 |

> **可安全借鉴（宽松许可）**：`juanfont/headscale`（BSD-3-Clause）、`mvdan/sh`（BSD-3-Clause）、
> `weaviate/weaviate`（BSD-3）、`open-policy-agent/opa`（Apache-2.0）、`google/gvisor`（Apache-2.0）、
> `firecracker-microvm/firecracker`（Apache-2.0）、`microsandbox/microsandbox`（Apache-2.0）、
> `katanemo/plano`（Apache-2.0）、`theagentrouter/agent-router`（Apache-2.0）、
> `LangGraph`/`CrewAI`/`Textual`/`Bubble Tea`/`Ink`（均 MIT）。

### 9.1 ⚠️ 一条横向发现：source-available 已是本品类的新常态

逐字读 LICENSE 原文后确认：LobeHub 用 **LobeHub Community License**（非 OSI）、
OpenWebUI 用 **Open WebUI License**（非 OSI）、Dify 用**修改版 Apache 2.0**（多租户限制）、
FastGPT 用 **Apache 2.0 + 附加条款**、Onyx 与 n8n 均为**分段许可**、MaxKB 用 **GPL-3.0**。

即：**khy-os 的源码可见但与标准 OSS 许可有距的姿态，与 LobeHub / OpenWebUI / Dify /
FastGPT / n8n 同属该品类的普遍状态，不是异类。**

但由此产生一条**对软著申报与对外宣传有直接影响**的合规提示：

- 真正「无保留开源」的对标是另一批——`bisheng`、`ragflow`、`langflow`、`LibreChat`、
  `anything-llm`（均 Apache-2.0/MIT）。
- 因此**对外表述必须区分 "source-available" 与 "open-source"**：
  若申报材料或宣传语需要「开源」表述，建议明确用的是哪一个词，避免与上述真开源项目
  被读者等同看待。这与 `[DESIGN-IP-001]` 的「结果要人能接住」是同一要求的不同面
  （可解释性也包括许可可解释性）。
- 本报告**不改动任何许可判断**，只把这条事实摆出来；是否调整对外措辞属项目决策。

---

## 10. 附录 A：星标与许可证实测表

> 取数方式见 §2.2。`†` = shields.io 取整取数；`‡` = 子智能体经 GitHub API 精确取数；
> `§` = shields 无法分类，改用 `raw.githubusercontent.com` 抓 LICENSE 首行判定。

### A.1 Agent CLI / 编码智能体 / harness 生态

| 仓库 | ★ | 许可 | 主语言 |
|---|---|---|---|
| `obra/superpowers` | 297k† | MIT | Markdown/技能 |
| `farion1231/cc-switch` | 142k† | MIT | TypeScript |
| `earendil-works/pi` | 113 820 | MIT | TypeScript |
| `sst/opencode`（→`anomalyco/opencode`） | 212k† | MIT | TypeScript |
| `openai/codex` | 128k† | Apache-2.0 | **Rust** |
| `google-gemini/gemini-cli` | 107k† | Apache-2.0 | TypeScript |
| `bytedance/deer-flow` | 83 587 | MIT | Python |
| `All-Hands-AI/OpenHands`（→`OpenHands/OpenHands`） | 90k† | MIT | TS/Python |
| `OpenHands/software-agent-sdk` | 1.2k† | MIT | Python |
| `cline/cline` | 70 084 | Apache-2.0 | TypeScript |
| `block/goose`（→`aaif-goose/goose`） | 55k† | Apache-2.0 | Rust |
| `Aider-AI/aider` | 49k† | Apache-2.0 | Python |
| `zhayujie/CowAgent` | 47 303 | MIT | — |
| `iOfficeAI/AionUi` | 33 402 | Apache-2.0 | Rust + 桌面 |
| `charmbracelet/crush` | 28 574 | FSL-1.1-MIT § | Go |
| `QwenLM/qwen-code` | 28 386 | Apache-2.0 | TypeScript |
| `Kilo-Org/kilocode` | 27 540 | MIT | TypeScript |
| `RooCodeInc/Roo-Code` | 24k† | Apache-2.0（**扩展已关停**） | TypeScript |
| `SWE-agent/SWE-agent` | 21k† | MIT | Python |
| `1jehuang/jcode` | 20 372 | MIT | **Rust** |
| `Continuedev/continue` | 36k† | Apache-2.0（**仓库已只读**） | TypeScript |
| `plandex-ai/plandex` | 16k† | MIT | Go |
| `CodebuffAI/codebuff`（→Freebuff） | 13k† | Apache-2.0 | TypeScript |
| `ultraworkers/claw-code` | 195k† | MIT（**自述博物馆展品**） | Rust |
| `gptme/gptme` | 4.4k† | MIT | Python |
| `shareAI-lab/Kode` | 5.2k† | Apache-2.0 | TypeScript |
| `sweepai/sweep` | 7.7k† | 混合 § | Python |
| `nus-apr/auto-code-rover` | 3.1k† | 未检出 § | Python |
| `aws/amazon-q-developer-cli` | 2k† | Apache-2.0 | TypeScript |
| `anthropics/claude-code` | 150k† | 未指定 § | — |

### A.2 网关 / 路由 / 多供应商

| 仓库 | ★ | 许可 | 主语言 |
|---|---|---|---|
| `diegosouzapw/OmniRoute` | 74 689 | MIT | TypeScript |
| `router-for-me/CLIProxyAPI` | 54 653 | MIT | Go |
| `BerriAI/litellm` | 60 686 | MIT（+enterprise 商业） | Python（+Rust core） |
| `QuantumNous/new-api` | 49 544 | **AGPL-3.0** | Go |
| `Calcium-Ion/new-api`（旧名，重定向） | 50k† | AGPL-3.0 | Go |
| `songquanpeng/one-api` | 37 107 | MIT | Go |
| `musistudio/claude-code-router` | 37 602 | MIT | TypeScript |
| `Portkey-AI/gateway` | 13 159 | MIT | TypeScript |
| `coaidev/coai` | 9 323 | Apache-2.0 | TypeScript |
| `maximhq/bifrost` | 8 676 | Apache-2.0 | Go |
| `katanemo/plano` | 7 082 | Apache-2.0 | **Rust + Envoy** |
| `Helicone/helicone` | 6 209 | Apache-2.0 | TypeScript |
| `theagentrouter/agent-router` | 2 206 | Apache-2.0 | Go |
| `bricks-cloud/BricksLLM` | 1 230 | MIT | Go |
| `luohy15/y-router` | 383 | MIT（**已归档**） | TypeScript |
| `lm-sys/RouteLLM` | 5 585 | Apache-2.0 | Python |
| `aurelio-labs/semantic-router` | 3 942 | MIT | Python |
| `Kong/kong` | 44k† | Apache-2.0 | Lua |
| `apache/apisix` | 17k† | Apache-2.0 | Lua |
| `kgateway-dev/kgateway` | 5.7k† | Apache-2.0 | Go |
| `TykTechnologies/tyk` | 11k† | 未检出 § | Go |
| `qixing-jk/all-api-hub` | 4.9k† | **AGPL-3.0** | TypeScript |

### A.3 记忆 / RAG / 检索

| 仓库 | ★ | 许可 | 主语言 |
|---|---|---|---|
| `infiniflow/ragflow` | 92k† | Apache-2.0 | Python + Go |
| `mem0ai/mem0` | 67k† | Apache-2.0 | Python |
| `letta-ai/letta` | 25k† | Apache-2.0（活跃代码在 `letta-code` 3.6k†） | TS/Python |
| `topoteretes/cognee` | 32k† | Apache-2.0 | Python |
| `supermemoryai/supermemory` | 31k† | MIT | TypeScript |
| `getzep/graphiti` | 32k† | Apache-2.0 | Python |
| `getzep/zep` | 5k† | Apache-2.0（**已非产品本体**） | Python |
| `HKUDS/LightRAG` | 40k† | MIT | Python |
| `microsoft/graphrag` | 36k† | MIT（**维护模式**） | Python |
| `milvus-io/milvus` | 46k† | Apache-2.0 | Go/Python |
| `qdrant/qdrant` | 35k† | Apache-2.0 | Rust |
| `chroma-core/chroma` | 29k† | Apache-2.0 | Python |
| `weaviate/weaviate` | 17k† | BSD-3 § | Go |
| `lancedb/lancedb` | 12k† | Apache-2.0 | Rust/Python |
| `neuml/txtai` | 13k† | Apache-2.0 | Python |
| `netease-youdao/QAnything` | 14k† | **AGPL-3.0** | Python |
| `memodb-io/Memobase` | 2.9k† | Apache-2.0（**疑似转向**） | Python |
| `langchain-ai/langmem` | 1.7k† | MIT | Python |
| `caspianmoon/memoripy` | 694 | Apache-2.0 | Python |

### A.4 编排 / 多智能体 / 可观测

| 仓库 | ★ | 许可 | 主语言 |
|---|---|---|---|
| `n8n-io/n8n` | 207k† | **Sustainable Use** | TypeScript |
| `Significant-Gravitas/AutoGPT` | 188k† | 混合 | Python |
| `langflow-ai/langflow` | 155k† | MIT | Python |
| `langchain-ai/langchain` | 148k† | MIT | Python |
| `run-llama/llama_index` | 52k† | MIT | Python |
| `crewAIInc/crewAI` | 60k† | MIT | Python |
| `microsoft/autogen` | 61k† | **CC-BY-4.0** | Python |
| `apache/airflow` | 47k† | Apache-2.0 | Python |
| `langchain-ai/langgraph` | 43k† | MIT | Python |
| `agno-agi/agno` | 43k† | Apache-2.0 | Python |
| `langfuse/langfuse` | 36k† | MIT 核心（`ee/` 单独） | TypeScript |
| `a2aproject/A2A` | 26k† | Apache-2.0 | polyglot |
| `activepieces/activepieces` | 25k† | 未检出 § | TypeScript |
| `temporalio/temporal` | 24k† | MIT | Go |
| `PrefectHQ/prefect` | 24k† | Apache-2.0 | Python |
| `windmill-labs/windmill` | 18k† | 未检出 § | TypeScript |
| `dagster-io/dagster` | 16k† | Apache-2.0 | Python |
| `inngest/inngest` | 5.9k† | **SSPL v1.0** | TypeScript |
| `restatedev/restate` | 4.5k† | **BSL 1.1** | Rust |
| `ag2ai/ag2` | 5k† | Apache-2.0 | Python |
| `traceloop/openllmetry` | 7.5k† | Apache-2.0 | Python/JS |
| `AgentOps-AI/agentops` | 5.9k† | MIT | Python |
| `Arize-ai/phoenix` | 12k† | **Elastic-2.0** | Python |
| `assafelovic/gpt-researcher` | 30k† | Apache-2.0 | Python |

### A.5 技能 / 插件 / MCP

| 仓库 | ★ | 许可 | 主语言 |
|---|---|---|---|
| `openclaw/openclaw` | 392k† | MIT | TypeScript |
| `anthropics/skills` | 180k‡ | 混合（文档技能 source-available） | Python |
| `modelcontextprotocol/servers` | 91k† | Apache-2.0（新贡献）/ MIT（旧代码） | multi |
| `modelcontextprotocol/python-sdk` | 25k† | MIT | Python |
| `modelcontextprotocol/typescript-sdk` | 14k† | 未检出 § | TypeScript |
| `modelcontextprotocol/registry` | 7.3k† | 未检出 § | Go |
| `modelcontextprotocol/inspector` | 11k† | 未检出 § | TypeScript |
| `ComposioHQ/composio` | 30k† | MIT | Python |

### A.6 TUI

| 仓库 | ★ | 许可 | 主语言 |
|---|---|---|---|
| `charmbracelet/bubbletea` | 45k† | MIT | Go |
| `vadimdemedes/ink` | 40k† | MIT | TypeScript |
| `Textualize/textual` | 37k† | MIT | Python |
| `ratatui-org/ratatui` | 23k† | MIT | Rust |
| `sst/opentui` | 14k† | MIT | TypeScript + Zig |
| `chjj/blessed` | 12k† | 未检出 § | JavaScript |
| `charmbracelet/lipgloss` | 12k† | MIT | Go |
| `Yomguithereal/react-blessed` | 4.5k† | MIT | JavaScript |

### A.7 沙箱 / 安全 / 自托管平台 / 消息通道 / 其它

| 仓库 | ★ | 许可 | 主语言 |
|---|---|---|---|
| `rustdesk/rustdesk` | 125k† | **AGPL-3.0** | Rust + Flutter |
| `browser-use/browser-use` | 117k† | MIT | Python |
| `langgenius/dify` | 158k† | 改良 Apache-2.0 § | TS/Python |
| `open-webui/open-webui` | 154k† | Open WebUI License § | Python |
| `lobehub/lobe-chat` | 83k† | LobeHub Community License § | TypeScript |
| `daytonaio/daytona` | 72k† | 未检出 § | Go |
| `Mintplex-Labs/anything-llm` | 67k† | MIT | TypeScript |
| `danny-avila/LibreChat` | 45k† | MIT | TypeScript |
| `juanfont/headscale` | 44k† | BSD-3-Clause | Go |
| `firecracker-microvm/firecracker` | 37k† | Apache-2.0 | Rust |
| `hashicorp/vault` | 36k† | **BUSL 1.1** | Go |
| `onyx-dot-app/onyx` | 32k† | 未检出 § | Python |
| `infisical/infisical` | 30k† | 未检出 § | TypeScript |
| `labring/FastGPT` | 30k† | 未检出 § | TypeScript |
| `openai/openai-agents-python` | 30k† | MIT | Python |
| `trufflesecurity/trufflehog` | 28k† | **AGPL-3.0** | Go |
| `vercel/ai` | 27k† | 未检出 § | TypeScript |
| `renovatebot/renovate` | 23k† | **AGPL-3.0** | TypeScript |
| `Skyvern-AI/skyvern` | 23k† | **AGPL-3.0** | Python |
| `1Panel-dev/MaxKB` | 23k† | GPL-3.0 | Python |
| `google/gvisor` | 20k† | Apache-2.0 | Go |
| `pydantic/pydantic-ai` | 21k† | MIT | Python |
| `e2b-dev/E2B` | 14k† | Apache-2.0 | Python/JS |
| `koalaman/shellcheck` | 40k† | **GPL-3.0** | Haskell |
| `posthog/posthog` | 40k† | 未检出 § | Python |
| `dataelement/bisheng` | 12k† | Apache-2.0 | Python |
| `bytedance/UI-TARS` | 12k† | Apache-2.0 | Python |
| `open-policy-agent/opa` | 12k† | Apache-2.0 | Go |
| `cloudflare/workerd` | 8.9k† | Apache-2.0 | C++/Rust |
| `microsandbox/microsandbox` | 8.6k† | Apache-2.0 | Rust |
| `cloudflare/agents` | 5.8k† | MIT | TypeScript |
| `netblue30/firejail` | 7.7k† | **GPL-2.0** | C |
| `mvdan/sh` | 9.1k† | BSD-3-Clause | Go |
| `google-a2a/a2a-samples` | 1.8k† | Apache-2.0 | multi |
| `inngest/agent-kit` | 942 | Apache-2.0 | TypeScript |
| `UNLINEARITY/CLI-WeChat-Bridge` | 526 | **AGPL-3.0** | TypeScript |
| `godagoo/claude-telegram-relay` | 326 | MIT | TypeScript/Bun |
| `overwirehq/claude-code-telegram` | 2.8k | 无 LICENSE | Python |
| `kaida-palooza/ccpoke` | 103 | MIT | TypeScript |
| `Jeffrey0117/ClaudeBot` | 64 | 无 LICENSE | TypeScript |
| `1935417243/AnyBot` | 19 | MIT | TypeScript |
| `gurudin/anycoding` | 17 | Apache-2.0 | Java |
| `jdx/mise` | 35k† | MIT | Rust |
| `pkgxdev/pkgx` | 9.9k† | Apache-2.0 | Rust/C |
| `ScoopInstaller/Scoop` | 25k† | 未检出 § | PowerShell |
| `AppImage/AppImageKit` | 9.4k† | 未检出 § | C |

**合计实测仓库数：约 148 个。**

---

## 11. 附录 B：被排除或降级的项目及理由

| 项目 | 处置 | 理由 |
|---|---|---|
| `microsoft/graphrag` | 降级为设计参考 | README 明示 largely in maintenance mode，不再接受新 PR |
| `luohy15/y-router` | 降级为历史标尺 | 已归档，被 OpenRouter 一方集成 + CCR/CLIProxyAPI 取代 |
| `getzep/zep` | 排除，改对标 `getzep/graphiti` | zep 仓库 README 自述「不是 Zep 的产品」，Zep CE 已降级 `legacy/` |
| `letta-ai/letta` | 降级，改对标 `letta-code` | `letta` 仓库现仅为指针，活跃代码在 `letta-code`（3.6k†） |
| `Calcium-Ion/new-api` | 合并入 `QuantumNous/new-api` | 仓库已更名，旧链接重定向 |
| `envoyproxy/ai-gateway` | 合并入 `theagentrouter/agent-router` | 仓库已迁移，旧链接重定向 |
| `katanemo/arch-gateway` | 合并入 `katanemo/plano` | 仓库已更名 |
| `zhayujie/chatgpt-on-wechat` | **合并入 `zhayujie/CowAgent`，勿重复计数** | 同一仓库已更名/重塑；README 徽章与图片已全部指向 `zhayujie/CowAgent`（2026-10-10 核实） |
| `memodb-io/Memobase` | 标「低动量」 | README 首条已指向 `Acontext`，疑似转向 |
| `netease-youdao/QAnything` | 标「低动量」 | README 最新日期 2024-05-17 |
| `Continuedev/continue` / `RooCodeInc/Roo-Code` | 标「已退场」 | 各自 README 逐字核实（见 §6.9d） |
| `kestra-io/kestra` | 未收录 | shields 星标返回 `invalid`（默认分支为 `master` 非 `main`），未能取数 |
| Cloudflare AI Gateway / Vercel AI Gateway / OpenRouter / Requesty / Docker AI Gateway | 明确排除 | **均无 OSS 仓库**（SaaS 或闭源服务端）。OpenRouter 有第一方 Claude Code 集成 |
| `LangServe` | 排除 | 服务 LangChain chain，不是 LLM 网关/路由器 |
| `cognee-ai/cognee`、`topoterates/cognee` | 取数失败 | 正确仓库名是 `topoteretes/cognee`（`topoteretes`，带 s） |
| `ultraworkers/claw-code` | 仅作星标虚高证据收录 | 自述「博物馆展品」，不是产品；不得把 195k† 当质量信号 |

---

## 12. 未验证项与后续动作

**未验证（本次调研明确未能核实的）**：

1. `diegosouzapw/OmniRoute` 的 74 689 星——两个独立源（GitHub search API + shields.io）一致，
   但仓库年龄与贡献者深度未验证，**存在虚高可能**。
2. `katanemo/plano` 的编排智能依赖 katanemo 托管 LLM 的程度——README 提示生产需 API key，
   但 OSS 仓库的自足边界未实测。
3. `modelcontextprotocol/registry` 的 v0.1 API 冻结与 GA 时间线——来自 README，GA 是否已发布未验证。
4. `maximhq/bifrost` 的付费层门控清单——来自 README「Enterprise Deployments」节，未实测。
5. khy-os 的 7 个消息通道是否**同样 fail-closed**（对标 OpenClaw 的「入站消息默认不可信」）——
   本次只确认了通道存在，未审计其安全姿态。**这是本报告最该补的一条实测**。
6. §5 总矩阵与 §4 各域的覆盖度判级是**作者主观判断**，非实测。
7. khy-os 的 `acpTransport.js` / `acpAgentAdapter.js` 是否已构成**对外可用的 ACP 服务面**——
   本次只确认文件存在，未验证其协议完整度。§7 的 P0 第 1 项立项前**必须先核实这条**。
8. khy-os 的 `services/lspClient.js` 是否真的接进了上下文链——本次只确认文件存在。
9. khy-os 的 `arenaManager.js` / `evals/` 是否已具备 Agent Arena 式多模型对抗评测——
   本次只确认文件存在，未验证功能完整度。
10. `aws/amazon-q-developer-cli` 被 Kiro CLI 取代一说来自子智能体报告，README 未逐字核实。
11. `Continuedev/continue` 与 `RooCodeInc/Roo-Code` 的退场已从各自 README **逐字核实**
    （continue 第 19 行、Roo-Code 第 66 行），但两者**是否已彻底归档**（GitHub archived 标记）
    未经 API 确认。
12. 各项目的**当前发布节奏**未经核实——`WebFetch` 对 `github.com` 被环境阻断，
    `curl` 只能取 README/raw 与 badge，无法读 Releases 页面。

**后续动作（若立项）**：

1. 补实测 #5 与 #7：审计 `services/domain/messaging/channels/` 的入站输入信任模型（对照
   OpenClaw 安全指南），并核实 `acpTransport.js` / `acpAgentAdapter.js` 是否已构成对外可用的
   ACP 服务面。**这两条是 P0 缺口的前置条件，不做完不该立项。**
2. 对 P0 其余三项（无头 Agent Server + SDK / daemon 多客户端 / 向量库后端）各出一份可行性设计，
   走 `[DESIGN-PROCESS-001]` 委派判据决定自做还是交子智能体。
3. **对外措辞区分 "source-available" 与 "open-source"**（见 §9.1）——这一条不涉及代码改动，
   但直接影响软著申报材料与对外宣传的准确性，且**改动成本近零**，建议优先处理。
4. 本报告 §8.2 的对冲动作 1（把 D12/D15 判据数字定期快照）可与现有
   `docs/11_报告/metrics/` 机制合并，不必新建。
5. `[RESEARCH-019]`（Claude Code 逐章对照）已覆盖 D1/D4/D5 的深度对标；本报告 §6.9c
   新发现的 harness 生态层（Qwen Code 对等表 / AionUi Team Mode / superpowers 方法论 /
   Pi 的 harness+packages 分层）**值得各开一份逐条对照**，尤其是 Pi 的
   「harness + packages」分层——它是对 khy-os 145 万行单体最重要的架构启示。

---

*报告完。所有星标与许可证数据可依 §2.2 的命令复现；khy-os 侧读数可依 §2.3 的命令复现。*
