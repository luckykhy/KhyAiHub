<!-- 文档分类: DESIGN-ARCH-203 | 阶段: 设计 -->
<!-- IMPL-STATUS: todo -->
<!-- DOCS-CLAIMS-EXEMPT: 本文是尚未实现的设计文档，/api/agent-hub 全族端点均为目标态契约而非已存在的路由；check-doc-claims 的 endpoint-claim-unsupported 对设计文档必然命中（同类存量见 [DESIGN-ARCH-192]），不构成缺陷陈述 -->
# [DESIGN-ARCH-203] 智能体统一管理

> **定位**：在桌面端给出「本机全部 AI 编程智能体」的单一管理入口——一张表列出已发现的所有智能体（含发现但未纳管的），安装/卸载、模型配置、MCP、skill、记忆都在这一个地方管。
> **不是从零起**：仓内已有 `khy agent-assets`（6 家 × 三类资产读写）、`khy tools`（4 家便携安装）、`externalApps` 11 家配置适配器、`ccSwitch` 卡片矩阵四套皮肉，本文做的是**补一个统一入口 + 把纳管面从 6 家扩到用户点名的 9 类 + 目录扫描**。
> **状态**：设计（todo）· 待人裁决后落地。本文只做设计，不含实现代码。
> **上位约束**：`AGENTS.md` 工程规则 1–12；`[DESIGN-LAY-005]`（层级与落点）；`[DESIGN-ARCH-071]`（通道选择）；`[MGMT-STD-007]`（文档命名）。

---

## 0. 结论先行

1. **一个 service、两条互不重叠的暴露路径，两个前端表面**。后端 service（`services/domain/agents/agentHub/`）与注册表是全功能唯一真源；**桌面 Electron 主表面走 CH-2 服务层直调**（`createRequire` 载入 service 模块，与 `host/index.ts`、`keyManager/keyStore.ts` 同一条既有通道——桌面端没有登录态、从未调过后端 `/api/*`，走 HTTP 会每个请求 401）；**`/api/agent-hub` HTTP 命名空间只服务 Web 管理台第二表面**（有真实 JWT 登录态，挂 `authenticateToken`）。两条路径共用同一份 service，不造第二个真源，也不给桌面端硬造一个它没有的 token。
2. **适配器是唯一的扩展点**。每家智能体一个适配器文件；注册表是一张冻结的声明式表，加一家 = 加一个文件 + 加一行，编排层与暴露层零改动。**MCP 的跨家读写不新造契约**——直接复用 `agentAssets` 的 `tool` 类资产（`claudeCode.js:405-428` 今天就能把 mcp_server 合并进别家 `mcpServers` 并用目标侧现值填回凭据），本功能只做「发现与呈现」，不做第二套 MCP 形状。
3. **未知智能体走两条路，都不猜**：① 内置登记表（人工增补，条目带证据）；② 目录扫描命中**已知指纹**才生成候选，纯未知指纹只报「发现未识别项」并给手动登记入口——沿用 `mcpEcosystemRegistry.js:300` 已立下的「不猜路径」规矩。
4. **写操作一律干跑优先 + 备份 + 可回滚，但回滚分两类、不共用一份账**。安装/卸载/改别家配置默认只出计划不落盘，显式确认后才写。**「改别家 live 配置」的回滚 = 从 `backups/` 把原文件原子写回**，记在 agentHub 自己的备份索引里；**它绝不写进共享的 `.install-ledger.jsonl`**——那份账的唯一读者 `khy uninstall` 会把每条当 khy 自己的安装副作用回滚（`cli/handlers/uninstall.js:401-410`），而 `installLedger.js:67` 的 meta 白名单记不下「属于哪个 agent」，串台会让 khy 下次卸载时去删别家工具的配置文件（详见 §6.2 与 §11 R2/R3、§12 R2/R3）。
5. **不新增任何 CLI 命令**。`[DESIGN-DELIV-002]` §2.3 的任务面棘轮（命令 245 / 别名 591 / handler 155，只降不升）下，新增顶层命令即破闸；本功能的命令面是**扩展现有 `khy agent-assets` 的子命令**，零新命令、零新别名、零新 handler 文件。
6. **模型配置写腿今天只覆盖 9 类中的 5 类，且其中 2 家已有双写者**。`externalApps` 11 家 + `ccSwitch/appWriters.js` 的 `APPS` 12 项里没有 qoder / workbuddy / kiro / cursor；本轮**不为这 4 家新写后端写器**，其 tier 封顶在 `assets`。更隐蔽的是：**claude-code 与 opencode 今天就有两个活着的写者**——桌面 `agentWriters.ts:191-224` 直写 `~/.claude/settings.json` 与 `~/.config/opencode/opencode.json`，后端 `externalApps/*Adapter` + `ccSwitch/appWriters.js` 写同一批文件。新统一页的「改模型」会成为同一文件的第三个写入面，这一点必须在 UI 上显式告知（详见 §2.1 双写者审计与 §12 R5）。

---

## 1. 需求与差距

### 1.1 输入（来自需求五问，非本文推导）

用户原话：**「我想在桌面端中加一个智能体统一管理的入口：claude code, opencode, zcode, workbuddy, command code, kiro, trae, qoder, cusur 还有我不知道的智能体等」**，管理动作是**「要能管理卸载安装，各个智能体的模型配置，mcp，skill 记忆等等」**（`works/data/khy/feedback/agent-hub/requirement-5q.md`）。

五问中有多条是 AI 自答，**待用户确认后再动工**（见 §9 的「待拍板」）：

| 项 | AI 自答内容 | 为什么不能直接当事实 |
|---|---|---|
| Q1 角色 | 机器 owner 本人、单人单机 | 用户未说谁用；团队/多机未问 |
| Q1 两处指代 | `cusur` → Cursor、`command code` → Command Code | 仓内有 `services/gateway/adapters/cursorAdapter.js`（网关 AI 适配器，`cursorAdapter.js:2-5` 自述「connect to Cursor IDE's AI models. Reads Cursor's auth token」）与 `externalApps/commandCodeAdapter.js`。但**前者不是配置适配器**——`externalApps/` 11 个适配器里没有 cursor，故「Cursor 可被管理配置」今天没有代码支撑；用户亦未确认指的就是它们 |
| Q2 触发时机 | 新装纳管 / 改模型 / 配 MCP·导 skill·记忆 / 卸载 | 四个时机全部由管理动作反推，用户未陈述任何时机 |
| Q2 通道 | 用户只说桌面端 | REPL / TUI / Web API 是否要同一入口是留白 |
| Q4 验收命令 | `khy agent-assets discover` 输出覆盖本机已装全部智能体 | 命令与输出格式均为 AI 拟，用户只给了桌面端载体 |
| 「等等」外延 | 是否含凭据 / API key、提示词库、插件、终端配置 | 未定义 |
| 范围边界 | 是否含 khyquant（独立项目另案申报）、是否要多机同步 | 未问 |

### 1.2 仓内既有四套入口与本功能的缺口

| 既有入口 | 覆盖 | 缺口 |
|---|---|---|
| `khy agent-assets discover\|caps\|list\|plan\|import\|export\|sync`（`runtime/node/backend/src/cli/handlers/agentAssets.js:10-16`） | 6 家 × 记忆/工具/技能三类资产读写，默认干跑（:18-20） | 注册表仅 6 家（`registry.js:27-34`）：khy-os / opencode / claude-code / harness / deepseek-harness / openclaw。用户点名的 zcode / workbuddy / command code / kiro / trae / qoder / cursor **不在表内**；且是 CLI，桌面端无对应页 |
| `khy tools list\|install\|update\|path`（`runtime/node/backend/src/cli/handlers/tools.js`） | 4 个便携 CLI（`services/gateway/adapters/portableCliRegistry.js`） | 只管便携 CLI 的安装，不管配置/资产 |
| `khy agent list\|templates\|run\|spawn` | OS 原生角色模板 | 管的是 khy 自己的 agent，不是外部工具管理 |
| 八个并列启动命令 `khy claude\|codex\|opencode\|kiro\|cursor\|trae\|warp\|vscode`（`runtime/node/backend/src/cli/router.js:2495-2502` 实测 8 个 `case`） | 启动外部 agent 后端 | 只启动，不管理；模型配置散落 `works/data/khy/cc_switch.json`、`trae_switch_profiles.json` 及每智能体一个数据目录 |

MCP 的写腿**在 2026-08-16 的调研里是缺口，今天已经不是**：`[DESIGN-RES-003]` §1.1（`:13`）记「没有任何『写他人 Agent 配置』的入口」，但此后两条写腿都已落地——① 模型/连接配置走 `externalApps/*Adapter` + `ccSwitch/appWriters.js`；② **MCP 走 `agentAssets` 的 `tool` 类资产**：`adapters/claudeCode.js:405-428` 的 `writeAsset(kind='tool')` 把 mcp_server 合并进别家 `mcpServers.<name>` 并用目标侧现值填回凭据，`adapters/opencode.js:337-364` 同样只承载 `mcp_server`，`sync.js` 的 import/export/sync 已把它暴露成命令。**故本功能对 MCP 不做第二套契约、不写第二个写者**，只做「发现与呈现」（§3.1、§12 R4）。真正仍未补的是：① 安装/卸载程序本体的通道；② 用户点名的 9 类里 4 家的模型配置写腿；③ 桌面端入口。

### 1.3 本机实测的安装面（只读探测，供适配器探测判据对标）

| 点名项 | 本机状态 | 探测到的安装形态 |
|---|---|---|
| claude-code | 已装 | 便携二进制（`D:\Portable\bin\claude.exe` + `claude.cmd`），配置三处分裂（用户级、便携级、仓库级） |
| opencode | 已装 | 便携二进制 + `$XDG_CONFIG_HOME` 改指到便携树；存在一套**影子配置**（`~/.config/opencode` 不被读取） |
| zcode | 已装 | NSIS 安装 + 便携启动器；`%USERPROFILE%\.zcode` 是 junction；CLI 经 `HOME` 重定向到**另一套配置树** |
| workbuddy | 已装（两套） | CN 版与国际版两套便携 exe，四个数据根 |
| qoder | 已装 | IDE 便携装 + CLI exe；`.qoder` 是 junction |
| command-code | **未装**（数据目录仍在） | npm 包已从 npm-global 移除，`~/.commandcode` 全量数据仍在 |
| kiro | **未装** | 无 |
| trae | **未装**（数据残留） | 程序目录已不在，`~/.trae` 与 `%APPDATA%\Trae` 残留 |
| cursor | **未装** | 无（仓库内 `.cursor/rules/khy-maintainability.mdc` 是项目级规则，非安装） |

未点名但扫到的：MiniMax Code（CLI + 桌面端）、Y-code（CLI + GUI）、RouterCode（桌面 + CLI）、华为 CodeArts Agent / Doer、CodeScope / CodeBaseCLI、Tencent CodeBuddy CLI（仅痕迹）、OpenAI Codex CLI（仅空目录痕迹）。**这些进内置登记表的种子清单**，其中「仅痕迹 / 空目录」类按「检测到数据但检测不到程序」单独标注，不与「已安装」混为一谈。

### 1.4 三条设计原则（从上面两张表推出来的）

1. **「未安装」是常态，不是错误**。`registry.js:94-97` 已确立「任何一家探测失败都不影响其余家」；统一表必须把「未检测到」与「已安装」并排显示，并列出**检查过的路径**——只说「未找到」让用户无从下手（`_adapterBase.js:96-106` 已实现此契约）。
2. **一个工具可能有多实例**。workbuddy CN / Intl 两套、Qoder IDE / CLI 两套、zcode 桌面端 / CLI 两套，各自有独立数据根。统一表的行粒度是**实例**（installation），不是品牌。
3. **「装没装」的判据不能只有一种**。本机 9 类里 5 类是便携二进制、1 类 npm 已卸、3 类未装；`npm ls -g` 只能看到 npm 渠道。探测必须按「PATH 可执行 → 安装候选目录 → 注册表 Uninstall → 用户数据目录 → 运行中进程」五源交叉，任一源命中即报「已检测到」并记录命中源。

---

## 2. 总体架构

### 2.1 四层一条主链

```text
桌面 Electron renderer                 Web 管理台 renderer
  AgentHubPage.tsx                       /admin/agent-hub (AgentHub.vue)
        │ __KHYOS__ preload IPC                    │ authedFetch (Bearer JWT)
        ▼                                          ▼
  main/agentHub/service.ts                 routes/agentHub.js
  （CH-2 服务层直调：                        （薄路由层：信封/鉴权/降级）
    createRequire 载入 service 模块，           authenticateToken（JWT，无回环豁免）
    零 HTTP、零 token）                              │
        └───────────────┬───────────────────────────┘
                        ▼
              services/domain/agents/agentHub/          ← 唯一真源，两条路径共用
                ├── registry.js        声明式 SSOT（冻结表）
                ├── discovery.js       目录扫描（两条路之一）
                ├── overview.js        全表装配（只归一化，不重算）
                ├── planner.js         干跑计划 + 确认令牌
                ├── executor.js        落盘执行 + 备份 + 备份索引
                └── adapters/<id>.js   每家一个
                        │
        ┌───────────────┼───────────────┬────────────────┬──────────────┐
        ▼               ▼               ▼                ▼              ▼
   agentAssets/     externalApps/    ccSwitch/       uninstall/       mcp/
   (资产 IR + sync)  (模型配置写)     (卡片矩阵)       (台账纯叶子)     (mcpConfigStore)
```

**两条暴露路径的分工不是偏好，是被现实逼出来的**（§12 R1）：

| 表面 | 通道 | 为什么 |
|---|---|---|
| 桌面 Electron（主表面，用户原话载体） | **CH-2 服务层直调** | 桌面端**没有登录态**（`App.tsx:149-151` 自述「ZCode has no login/welcome gate… LoginPage stays in components/auth for that future entry point」），也**从未调用过后端 `/api/*`**（`apps/khyos-desktop/src` 全量 grep `/api/` 只命中一个外部供应商 URL 字符串 `keyStore.ts:760`）；它的后端集成全是 host 进程内 require（`src/host/index.ts:120/164/200`）。而 `/api/*` 挂的 `authenticateToken` 只认用户 JWT、**无回环豁免**（`middleware/auth.js:175-199`：`extractBearerToken` + `authSessionService.authenticateAccessToken`，拿不到 token 直接 401）。走 HTTP = 桌面端每个请求 401 = 用户点名的载体开箱即死 |
| Web 管理台（第二表面） | **CH-4 HTTP `/api/agent-hub`** | 前端有真实登录态与 Bearer token（`api/authedFetch.js` 从 `useUserStore()` 取 token），与既有全部管理页同款 |

**这也修正了第 1 轮 §4.5 的一处错误前提**：原文写「Electron 主进程不满足 CH-2 的同一 Node 进程前提」，但本仓**早已为关键路径做过相反的裁决**——`src/host/index.ts:3-4` 的文件头明写「通道选择（AGENTS.md 五通道决策矩阵）：host 与 backend 同为 Node 进程语义，用 CH-2 服务直调（运行时 require aiGateway）；main↔host 用 Electron fork IPC」，并实际在 `:120/164/200/233/264/325` 用 `createRequire` 载入六个后端模块。`keyManager/keyStore.ts`  likewise（`createRequire` 载 `gateway/providerPresets.js`）。**故 agentHub 跟随这条既有先例，而不是新开一条 HTTP+JWT 的路**——那才需要给桌面端造一个它没有的 token，或给 `auth.js` 加一个回环豁免（后者是安全模型变更，不在本功能范围）。

**关键约束**：`agentHub` 是**薄编排层**，不重复实现任何一家的磁盘布局知识。凡是 `agentAssets` 已认的记忆/工具/技能（含 MCP，见 §3.1），`agentHub` 直接委派；凡是 `externalApps` 已认的 provider 增删改查，直接委派；凡是 `ccSwitch` 已认的卡片矩阵，直接委派。这与 `marketInstallService.js` 的头注释自述「only dispatches」是同一个模式——**装进与 `khy skill add` / `khy mcp add` 同一个 store，杜绝第二写者**。

**这条委派有两个必须写在前面的缺口**。

**缺口一：后端没有写器的 4 家。** `externalApps` 的 11 个适配器与 `ccSwitch/constants.js:32-45` 的 `APPS` 12 项（claude-code / codex / opencode / gemini / deepseek / reasonix / command-code / ycode / zcode / openclaw / coze / trae）合起来，**覆盖不到用户点名的 qoder / workbuddy / kiro / cursor**：

| 点名项 | 后端有模型配置写器？ | 证据 | 本设计的处置 |
|---|---|---|---|
| claude-code | 有 | `externalApps/claudeCodeAdapter.js` + `APPS.CLAUDE_CODE` | tier `config`，**但见缺口二（双写者）** |
| opencode | 有 | `externalApps/opencodeAdapter.js` + `APPS.OPENCODE` | tier `config`，**但见缺口二（双写者）** |
| zcode | 有 | `externalApps/zcodeAdapter.js` + `APPS.ZCODE` | tier `config` |
| command-code | 有 | `externalApps/commandCodeAdapter.js` + `APPS.COMMAND_CODE` | tier `config` |
| trae | 有（间接） | `externalApps/traeAppAdapter.js` + `APPS.TRAE`；`appWriters.js:28-29` 注明它桥接 switch-center 的 `trae_switch_profiles.json`，**不是独立 live 配置文件** | tier `config`，但 UI 须标明「改的是 khy 侧的 profile store」 |
| qoder | **无** | 只有 Electron 主进程 `apps/khyos-desktop/src/main/keyManager/agentWriters.ts:226-237` 的 builtin 降级件，且它写的是 **khy 自己的 gateway `.env`**（`KHY_QODER_PROXY` / `QODER_PROXY_ENDPOINT`），不是 qoder 的配置文件 | tier 封顶 `assets`；写腿归属待拍板（§9） |
| workbuddy | **无** | `externalApps/` 无适配器，`APPS` 无条目 | tier 封顶 `assets` |
| kiro | **无** | 同上 | tier 封顶 `assets` |
| cursor | **无** | `externalApps/` 无 cursor 适配器（`services/gateway/adapters/cursorAdapter.js` 是网关 AI 适配器，读 Cursor 的 auth token 用它的模型，不是配置写器） | tier 封顶 `assets` |

**为什么不本轮补写器**：若在后端新写 qoder 适配器，就会与 `agentWriters.ts:226-237` 成为「同一个关注点（qoder 实际生效的模型）的两个写者」——即使落盘文件不同（一个写 khy 的 `.env`、一个写 qoder 的配置），用户看到的仍是「两处都能改、改了互相不知道」，这正是本文自己援引的「杜绝第二写者」要禁的形态。补写器属于架构决策，不搭本功能的车；本轮如实把这 4 家标成「只能读、不能改模型」，好过假装能改。

**缺口二：已经存在双写者的 2 家（第 1 轮漏审，§12 R5）。** 「杜绝第二写者」的审计不能只问「后端有没有写器」——**claude-code 与 opencode 今天就有两个活着的写者写同一批文件**：

| 家 | 写者 A（Electron 主进程） | 写者 B（后端） | 同一文件？ |
|---|---|---|---|
| claude-code | `agentWriters.ts:191-205`：`agentTargetPath('claude-code')` 定位 → `backupLive` 留 `.pre-khy.bak` → 写 `env.ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` → `writeJsonAtomic` | `externalApps/claudeCodeAdapter.js` + `ccSwitch/appWriters.js:13`（`~/.claude/settings.json` env 块） | **是** |
| opencode | `agentWriters.ts:207-224`：定位 → `backupLive` → 写 `provider.khy`（baseURL/apiKey/models）与 `doc.model` → `writeJsonAtomic` | `externalApps/opencodeAdapter.js` + `ccSwitch/appWriters.js:17`（`~/.config/opencode/opencode.json` provider 树） | **是** |

**后果与处置**：桌面 KeyManager 的 `agents:apply` 与后端 ccSwitch 卡片矩阵都在改这两个文件，互不知情；agentHub 的「改模型」会成为**同一文件的第三个写入面**。本轮不做归并（那是 `[DESIGN-ARCH-091]` 的账），但必须：① UI 在这两家的模型配置页**显式标注「本机另有 KeyManager 卡片矩阵也在写此文件」**；② `overview` 返回该文件的 `mtime` 与最近一次写入来源，让用户能对账；③ 列入 §9 不做清单与待拍板，不假装统一。

### 2.2 与既有四张表的关系（刻意不合并）

| 表 | 管什么 | 为什么不并进 agentHub 注册表 |
|---|---|---|
| `agentAssets/registry.js` | 外部 agent 的**资产**在哪、怎么读写 | 它的表项只有 id/label/module 三样，`detect()` 由适配器自证；并入会让「资产」与「安装/模型」两种关注点混在一张表里 |
| `agentLauncherRegistry.js` | `khy <agent>` 怎么**启动** | 按 gateway adapter 组织（一家可能有多个 launcher）；资产/安装按磁盘布局组织（一家一份布局）。`registry.js:11-13` 已把这条分工写明 |
| `externalApps/*Adapter` | 别家软件的**模型 provider 配置**读写 | 六件套契约（`configPath/list/get/add/remove/usable`）是「反向使用外部软件的模型」的形状，与统一管理页的「行 + 摘要」形状不同 |
| `appRegistry.js` | khy 作为宿主托管的**应用**（L4 `software/` 侧） | 与 agent 注册表是两个概念，混用会把「应用」和「智能体」并成一张表 |

**唯一的新增真源是 `agentHub/registry.js`**，它只回答「本机有哪些 AI 编程智能体、各自是什么形态、纳管到什么程度」。它**引用**上面四张表，不复制它们。

---

## 3. 适配器契约与注册表

### 3.1 适配器契约（每家一个文件）

```text
detect(env)                 → { ok, root, version, via, checked[], instances[] }
capabilities(env)           → { tier, kinds:{memory,tool,skill,model},
                                install, uninstall, notes }
readModelConfig(env)        → IR（脱敏后的模型配置摘要 + 完整结构）
writeModelConfig(patch,opts)→ 干跑优先；opts.dryRun 默认 true
listAssets(kind, env)       → 复用 agentAssets 适配器契约（memory / tool / skill 三类）
writeAsset(kind, asset,opts)→ 复用 agentAssets 适配器契约；MCP 即 kind='tool' 的 mcp_server
planInstall(env)            → 步骤清单 + 备份清单 + 风险清单（不落盘）
applyInstall(plan, token)   → 落盘 + 记账
planUninstall(env)          → 同上
applyUninstall(plan, token) → 落盘 + 记账 + 回滚点
```

**刻意不设 `listMcpServers` / `writeMcpServer`**（§12 R4）。第 1 轮草稿同时列了这两个方法与「复用 agentAssets 适配器契约」，正是它自己 §0.2 禁止的**第二契约 / 第二写者**：MCP 的跨家读写今天已由 `agentAssets` 的 `tool` 类资产完整承载——`adapters/claudeCode.js:405-428` 把 mcp_server 合并进别家 `mcpServers.<name>` 并用目标侧现值填回凭据，`adapters/opencode.js:337-364` 同样只接受 `mcp_server`。agentHub 对 MCP 只做**发现与呈现**（读 `listTools` 后按 `toolKind === 'mcp_server'` 过滤）与**转发**（写直接调 `writeAsset('tool', …)`），一套形状、一个写者。UI 上的「MCP」tab 是这层过滤的视图，不是新契约。

四条硬规则：

1. **`detect()` 必须回报 `checked[]`**——找过哪些位置、每个位置为什么找（`_adapterBase.js:56-107` 的 `probeRoot` 已实现）。未检测到的行在 UI 上要能展开看到这份清单，这是「未安装」与「探测失败」的唯一区分手段。
2. **写必走原子写**：`_shared.atomicWrite`（同目录 temp + rename）或 `_adapterBase.writeText`。对方软件随时可能在读这份配置，半截文件会直接毁掉用户的工具。
3. **凭据不进 IR**。`assetModel.js:14-20` 已确立「IR 绝不承载凭据明文」；`agentHub` 的模型配置摘要同样只回掩码（复用 `_shared.maskKey`），真 key 只在写路径内从源侧流向目标侧，绝不经过 UI、日志或返回值。
4. **env 注入是隔离承诺**：所有公开函数签名收 `env`，测试据此打在临时目录。`externalApps/README.md:40-42` 已记有两个成员破坏了这条（`traeAppAdapter._readStore` 丢参数、`opencodeAdapter` 便携根候选不看 env）——新适配器不得重犯。

### 3.2 注册表：内置登记表

形状与 `agentAssets/registry.js:27-34` 同构，只加字段不加概念：

```text
AGENT_HUB_SOURCES = [
  { id, label, module, vendor, kind: 'cli'|'gui'|'both'|'ide-extension',
    tier: 'read-only'|'assets'|'config'|'full',
    assetsModule?,      // 指向 agentAssets 适配器（可省）
    configModule?,      // 指向 externalApps 适配器（可省）
    evidence: { doc, probed } }
]
```

**种子条目**（分三批，全部有本机实测或上游文档依据）：

- **第一批（用户点名 9 类）**：claude-code、opencode、zcode、workbuddy、command-code、kiro、trae、qoder、cursor。
- **第二批（本机扫到的未点名项）**：minimax-code、y-code、routercode、codearts-doer、codebase-cli、codebuddy-cli、codex-cli。其中 codebuddy-cli 与 codex-cli 的 `tier` 只能是 `read-only`（本机仅存运行痕迹 / 空目录，无稳定配置约定）。
- **第三批（仓内已有适配器可直接挂）**：gemini-cli、coze、reasonix、deepseek-tui、openclaw —— `externalApps/` 已有适配器，缺的只是 agentHub 侧的安装/资产视角。

### 3.3 未知智能体如何纳入（两条路，都不猜）

**路 A：内置登记表增补**。维护者（人或 AI 经评审）加一行 + 加一个 `adapters/<id>.js`。条目的 `evidence` 字段必须能回答「这个磁盘布局是谁告诉你的」——上游文档 URL 或本机实测路径，二选一，不许空着。这与 `agentAssets/adapters/khy.module.json:21` 的 gates 自述「非猜测」是同一条纪律。

**路 B：目录扫描（`discovery.js`）**。扫四个面：

| 扫什么 | 判据 | 命中后 |
|---|---|---|
| PATH 上的可执行名 | 与登记表的 `probe.execNames` 对撞 | 直接标「已安装」，记录命中源 `path` |
| 常见安装候选目录 | `constants/installationCandidates.js` 的 `WINDOWS_IDE_INSTALL_PATHS`（kiro / cursor / trae / warp / vscode 五家）。⚠ **该文件全文 76 行、只有 Windows 一面**（`programFiles` / `programFilesX86` / `SystemDrive`，`pathJoin` 用 `'\\'`，导出仅 `GIT_BASH_CANDIDATES` / `GIT_PORTABLE_CANDIDATES` / `NIRVANA_*` / `WINDOWS_IDE_INSTALL_PATHS` 五项，**无 darwin / linux 分支**）。跨平台发现层不能直接复用它——要么给该文件补三平台模板（属改动既有 D3 常量的独立工作），要么在 `agentHub/discovery.js` 内自建并按 §4.5 从 env 取根，不得把 Windows 候选当成全平台 | 同上 |
| 注册表 Uninstall 键 / AppX / 开始菜单 | DisplayName 模糊匹配登记表 `label` 别名 | 同上 |
| 用户数据目录（`~`、`$XDG_CONFIG_HOME`、`%APPDATA%`） | 与登记表的 `probe.dataDirNames` 对撞 | 标「检测到数据，未检测到程序」 |

**路 B 的红线**：扫到**不在登记表里**的指纹时，只做一件事——把它列进「发现未识别项」分组，展示命中的目录名与路径，并给「手动登记」入口（引导到路 A）。**绝不按目录名猜配置格式、绝不生成半自动适配器**。`mcpEcosystemRegistry.js:299-300` 已经为 warp 和 trae 立了这条规矩（「配置在应用内部数据库,非可读 JSON 文件」「未找到稳定的公开配置约定,不猜路径」），本功能沿用而不新开例外。

用户原话的「还有我不知道的智能体」正是路 B 的存在理由：**发现本身必须是常态动作，而不是等人来登记**。

### 3.4 适配器分级（tier）

| tier | 能做 | 不能做 | 本机实例 |
|---|---|---|---|
| `read-only` | 探测 + 读模型配置摘要 + 列 MCP/skill/记忆 | 任何写 | codebuddy-cli、codex-cli、warp；trae 的 **MCP** 亦在此档（`mcpEcosystemRegistry.js:300` 已裁「未找到稳定的公开配置约定,不猜路径」） |
| `assets` | + skill/记忆/MCP 的导入导出（委派 `agentAssets/sync.js`） | 改对方 live 配置 | 登记表内 6 家的现状；**qoder / workbuddy / kiro / cursor 封顶在此**（后端无模型配置写器，见 §2.1 覆盖缺口表） |
| `config` | + 模型/连接配置写（委派 `externalApps` + `ccSwitch/appWriters`） | 装/卸程序本体 | claude-code、opencode、zcode、command-code、y-code；trae 亦在此档但写的是 khy 侧 profile store 而非 Trae live 配置 |
| `full` | + 安装/卸载程序本体 | — | 仅当官方提供非交互式安装/卸载通道时（claude 有 `claude install`；多数没有） |

**`tier` 由 `capabilities()` 自证，不由注册表声明**——注册表一个字都不知道哪家能干什么（沿用 `registry.js:4-9` 的设计）。UI 按 tier 显示可用的操作按钮，tier 不足的操作置灰并说明原因，不做「看起来能点、点了报错」。对 §2.1 表里那 4 家封顶 `assets` 的，UI 的「模型配置」tab 必须显示**只读 + 明确的原因**（「本机该工具的模型配置写器尚未接入」），而不是一个可编辑却写不进去的表单。

---

## 4. 后端落点与接口契约

### 4.1 service 落点

`runtime/node/backend/src/services/domain/agents/agentHub/`（D2 业务上下文，`agents` 域下与 `agentAssets` 平级）。照既有约定带 `khy.module.json`（`domain: D2`、`mayDependOn: [D2, D3]`、`fanIn`、`lifecycle`、`contract`、`tests` 六段，形状见 `agentAssets/adapters/khy.module.json`）。

**不要再手写 `services/<名>/index.js`**——`services/domain/` 下大量「目录 + index.js」是 auto-generated shim（文件头写明 Do not edit），真身在 `domain/<域>/<名>/`。

| 文件 | 职责 |
|---|---|
| `registry.js` | 声明式 SSOT 冻结表 + `resolveAdapter` / `listSourceIds` / `describeSources`。纯叶子可单测 |
| `discovery.js` | 目录扫描。只读；产出 candidate 清单；绝不猜格式 |
| `overview.js` | 全表装配：把注册表、探测结果、`agentAssets` 资产计数、`externalApps` 模型摘要、`uninstall` 台账并成一行一个实例。**只归一化形状，不重算**——装配在后端一次完成，前端不做二次加工（`useEcoMarkets.js` 的约定） |
| `planner.js` | 干跑计划生成 + 确认令牌。计划带 `backup[]` / `losses[]` / `risks[]` / `steps[]` |
| `executor.js` | 落盘执行：先备份 → 写 → 分类记账 → 回报。记账**分两类不混写**（§6.2）：A 类「改别家 live 配置」只写 `backups/<planId>/` + 备份索引，**绝不进 `.install-ledger.jsonl`**；B 类「装卸程序本体」写 agentHub 自己的 `ledger.jsonl`，计算复用 `installLedger.recordSideEffect`（零 IO 纯叶子）与 `computeRollback`，落盘用 agentHub 自己的 append（**不调 `ledgerWriter.appendSideEffect`**——那是共享台账的 IO 边界，而本设计已决定不写共享台账，见 §12 R2/R3） |
| `adapters/<id>.js` | 每家一个 |

依赖方向：`agentHub → agentAssets / externalApps / ccSwitch / uninstall / mcp`（同域 D2）；`agentHub → utils/dataHome`（D3）。**不得反向**：D3 不得 require D1/D2（`domain-direction` 守卫的 `d3-purity`）。

### 4.2 routes 落点与接口契约

`runtime/node/backend/src/routes/agentHub.js`。照 `routes/ecoMarkets.js` 的样板：**文件头即契约**（端点清单 / 鉴权挂载点 / `apiResponse` 信封 / 降级载荷），路由层零装配逻辑，全部委托 `services/domain/agents/agentHub/`。

```text
GET  /api/agent-hub/overview                全表：一行一个实例
GET  /api/agent-hub/adapters                已登记适配器 + 能力声明 + 探测结果（含 checked[]）
GET  /api/agent-hub/discover                目录扫描结果（含「发现未识别项」分组）
GET  /api/agent-hub/agents/:id              单实例详情
GET  /api/agent-hub/agents/:id/model        模型配置（脱敏）
GET  /api/agent-hub/agents/:id/mcp          MCP server 列表
GET  /api/agent-hub/agents/:id/skills       skill 列表
GET  /api/agent-hub/agents/:id/memories     记忆文件列表

POST /api/agent-hub/agents/:id/plan         { action } → 计划（不落盘）
POST /api/agent-hub/agents/:id/apply        { planId, confirmToken } → 落盘
POST /api/agent-hub/agents/:id/model        { patch, dryRun }
POST /api/agent-hub/agents/:id/mcp          { server, dryRun }
DELETE /api/agent-hub/agents/:id/mcp/:name  { dryRun }
POST /api/agent-hub/assets/sync             { from, to, kinds, dryRun } → 委派 sync.js
POST /api/agent-hub/agents/:id/rollback     { backupId } → 从 backups/ 把原文件原子写回（**不委派 computeRollback**，见 §6.2）
```

**`GET /agents/:id/mcp` 是视图不是契约**：它读 `agentAssets` 的 `listTools` 后按 `toolKind === 'mcp_server'` 过滤；`POST /agents/:id/mcp` 与 `DELETE /agents/:id/mcp/:name` 内部都转调 `writeAsset('tool', …)`（§3.1）。端点形状保留是为了 UI 好用，底层只有一套 MCP 写者。

**错误码与消息模板**（规则 2.2「问题 + 识别码 + 修复」）：

| 码 | 场景 | 消息形态 |
|---|---|---|
| `AGENT_HUB_UNKNOWN_AGENT` | `:id` 不在注册表 | `未知智能体「x」：登记表里没有这一项（识别码 AGENT_HUB_UNKNOWN_AGENT）。修复：请求 GET /api/agent-hub/adapters 取回已登记清单` |
| `AGENT_HUB_NOT_DETECTED` | 对该实例执行写操作但未检测到安装 | `未检测到「x」的安装：已查找 N 处（…）。修复：先安装，或用 GET /api/agent-hub/adapters 查看检查过的路径` |
| `AGENT_HUB_UNSUPPORTED_OP` | 该适配器 tier 不足 | `「x」的能力等级为 read-only：不支持安装/卸载（识别码 AGENT_HUB_UNSUPPORTED_OP）。修复：改用 tier 为 config/full 的智能体，或登记更高等级适配器` |
| `AGENT_HUB_NEEDS_CONFIRM` | 写操作未带确认令牌 | `该操作会修改「x」的配置：需要显式确认（识别码 AGENT_HUB_NEEDS_CONFIRM）。修复：先 POST /plan 取 confirmToken，再带它 POST /apply` |
| `AGENT_HUB_BACKUP_FAILED` | 写前备份失败 | `备份失败，已中止写入：「x」的配置未被修改（识别码 AGENT_HUB_BACKUP_FAILED）。修复：检查目标路径可写后重试` |
| `AGENT_HUB_NO_BACKUP` | 回滚时找不到对应备份 | `找不到「x」的备份 <backupId>：该次写入可能早于备份索引建立（识别码 AGENT_HUB_NO_BACKUP）。修复：用 GET /api/agent-hub/agents/:id 查看现有备份清单` |
| `AGENT_HUB_GATED_OFF` | `KHY_AGENT_HUB=off` | 与 `agentAssets` 的 `KHY_AGENT_ASSETS=off` 同款：明确拒绝并说明原因，不做半吊子降级 |

**新门控 `KHY_AGENT_HUB` 必须登记进 `utils/flagRegistry/index.js`**（真身在 D3 共享底座；`services/flagRegistry.js` 只是路径兼容壳，`module.exports = require('../utils/flagRegistry')`，不承载逻辑）。兄弟门 `KHY_AGENT_ASSETS`（`index.js:2724`）、`KHY_INSTALL_LEDGER`（`:1670`）、`KHY_AGENT_LAUNCHERS`（`:2715`）都在册且同为 `{ mode: 'default-on', off: 'CANON', default: true }`。

**漏登记的真实后果**（§12 R6 修正了第 1 轮的错误说法）：`flagRegistry` 的 `isFlagEnabled(name, env)` 对**未登记 flag** 的行为是「缺值 → 默认开；显式值 → 按 CANON off-words 解析，绝不吞掉用户的关闭词」——**不是**「取不到就静默走某个本地兜底分支」，也不存在一个叫 `agentModel` 的模块（全仓 grep `agentModel` 只命中注释里的「agent 模型」字样与无关的 `agentModelProjection.js` / `guiEval` 的 `agent_model` 字段）。所以漏登记不会让功能失效，代价是：① 该 flag 脱离 `flagRegistry` 的父子优先级（`spec.parent`）与集中内省（`khy capability` 一类的统一视图）；② 与仓内其余门控的治理形态不一致，将来做 flag 审计时会漏掉它。**结论（必须登记）仍成立，但理由要说对**——实施者按图索骥找不到那个被虚构的模块，也会误判漏登记的严重性。

**降级不 500**：探测全失败时 `overview` 仍返回 200 + `degraded` 载荷（含可修复原因），与 `ecoMarkets.js:38-46` 的 `buildDegraded` 同构。本机没装某个工具是常态，不是服务端错误。

### 4.3 挂载三处（照 `getEcoMarketsApp` 一套）

> **作用域提醒**：这三处只服务 **Web 管理台第二表面**。桌面主表面走 CH-2 服务层直调，不经过 HTTP、不需要这套挂载（§2.1）。

1. `aiManagementServer.js` 加 `getAgentHubApp()`：`express.json({ limit: '256kb' })` + `authenticateToken` + `require('../routes/agentHub')`（写操作的 body 比只读编目大，取 256kb 档而非 ecoMarkets 的 64kb）。
2. `aiManagementServer.js` 的 pathname 分发器加分支 `if (pathname.startsWith('/api/agent-hub')) return getAgentHubApp()(req, res)`，位置与 ecoMarkets 相邻（`:2393-2395`）。
3. `__test__.getAgentHubApp` 导出（`:3775` 同款），守卫测「401 而非 404」——命名空间漏挂载时不能静默 404。

**一处必须同时接受的语义**：`authenticateToken` 只认用户 JWT、无回环豁免（`middleware/auth.js:175-199`），所以 `/api/agent-hub` **只能被带登录态的前端页面调用**。桌面端不要试图打这个命名空间（§2.1 已说明它没有 token）；若将来要开放给本机回环调用方，那是给 `auth.js` 加豁免的**安全模型变更**，须独立评审，不搭本功能的车。

### 4.4 CLI 命令面：只扩展，不新增

`khy agent-assets` 下新增子命令（在 `handlers/agentAssets.js` 的既有 switch 内加分支，**不新增 handler 文件、不新增 `ROUTER_COMMANDS` 条目、不新增 `aliases.js` 的 `command:` 行**）：

```text
khy agent-assets hub                — 统一表（同一份 overview 装配的终端呈现）
khy agent-assets hub --json         — 机读（给 CI / 脚本用）
khy agent-assets discover           — 已存在；扩展为同时列出 agentHub 登记表全量
```

**为什么不新开 `khy agent-hub`**：`scripts/ci/check-delivery-baseline.js:615-677` 的 `checkSurfaceRatchet` 数四个数——`ROUTER_COMMANDS` 条目数、`aliases.js` 的 `command:` 出现数、`handlers/` 目录 `.js` 文件数、规则登记条数，**超基线即 error**（`delivery-surface-ratchet-breach`）。新增顶层命令会同时顶破前三个。`[DESIGN-DELIV-002]` §2.3 的棘轮语义是「要加一个命令，先退役一个」，本功能不主张为此退役任何命令，所以走子命令扩展。

**但「只改 switch」不够——子命令要真正可见需同步五处**（少任何一处，新子命令对补全 / 帮助 / 命令清单不可见，只能靠 `args[0]` 回退跑起来）：

| # | 文件:行 | 改什么 |
|---|---|---|
| 1 | `runtime/node/backend/src/constants/commandSchema.js:641-651` | `'agent-assets'` 的 `SUB_COMMANDS` 数组加 `'hub'`。`router.js:1022` 只认这里的词才会进 `subCommand`，否则 `hub` 被 `parseInput` 当成散落 token 扔进 `args` |
| 2 | `runtime/node/backend/src/cli/handlers/agentAssets.js:433-470` | `handleAgentAssets` 的 if 链加 `if (sub === 'hub') return _handleHub(args[0], options)`；`:437` 的 `sub` 已做 `args[0]` 回退，故不加也能跑，但那是兜底不是正门 |
| 3 | `runtime/node/backend/src/cli/handlers/agentAssets.js:466` | 未知子命令报错菜单补 `hub`，否则用户敲错时看到的可用清单不含它 |
| 4 | `runtime/node/backend/src/cli/handlers/agentAssets.js:474-482` | `MANIFEST_EXPORT_KEY` 的 `usage` / `subCommands` 同步（`usage` 现在是 `agent-assets [discover\|caps\|plan\|import\|export\|sync]`） |
| 5 | `runtime/node/backend/src/cli/handlers/agentAssets.js:409-427` | `_printHelp()` 加一行；注意 `:410-411` 的「已接入家数」是从 `registry.AGENT_ASSET_SOURCES` 推导的——若 `hub` 要展示 agentHub 登记表全量，这里也要换成 agentHub 的推导源，否则两表家数不一致 |

> 行号说明（§12 R8）：上述文件均有未提交改动（`git status --porcelain` 全为 `M`），行号相对第 1 轮已漂移 1–2 行。**落笔前以 `Select-String` 现场定位为准**，不要照抄行号。

**不新增**：`ROUTER_COMMANDS` 条目（`:136` 的 `'agent-assets'` 已在）、`aliases.js` 的 `command:` 行（现有 `agentassets` / `aassets` 别名直接可用）、`handlers/` 目录文件数（不新建 handler 文件）。故棘轮四个数一个都不动。

### 4.5 端点零硬编码（规则 1）

**桌面主表面一个端点都没有，所以这条规则对它自动满足**——它走 CH-2 服务层直调（§2.1），`createRequire` 载入的是**文件路径**而非网络地址，不存在 host:port 可硬编码。

- 前端 Web 侧：走既有 `api/authedFetch.js` + `api/request.js`，base URL 由既有 axios/fetch 配置解析，**新页面不自建第二套 baseURL 拼接**。
- 桌面主进程侧：需要解析的是**后端 src 根目录**，不是 daemon 地址。复用 `keyManager/agentWriters.ts:33-55` 的 `resolveBackendServicesRoot()`（4 级降级：`KHY_BACKEND_SERVICES` env → repo 相对 → `KHY_PORTABLE_ROOT`/`KHYQUANT_PORTABLE_ROOT` → 返回 null 由调用方降级；已带 `_auditBackendResolution` 留痕），再用 `createRequire` 从该根载入 `services/domain/agents/agentHub/<模块>`。这与 `host/index.ts:62/120/164/200/233/264/325` 和 `keyStore.ts` 载 `gateway/providerPresets.js` 是同一套机制。
- **`serviceDefaults.js` 的端口发现在本功能里用不到**：那条路径（`AI_BACKEND_DEFAULT_PORT` 与读 `ai_manage_runtime.json` 的 `apiPort`，见 `serviceDefaults.js:50-82`）是给「打 HTTP」的消费方用的。桌面端不打 HTTP，故不需要它；Web 前端打 HTTP 但 base URL 由既有请求层解析，也不需要新页面自己发现。**第 1 轮把这条列成桌面侧必改点，是建立在「桌面走 HTTP」这个错误前提上的，一并撤销**（§12 R1）。
- 降级：`resolveBackendServicesRoot()` 返回 null 时**诚实降级**为「后端模块不可用」横幅并给出修复建议，**不写死任何路径兜底、不静默吞掉**。`agentWriters.ts:59-63` 的 `_auditBackendResolution` 已有同款留痕先例。

---

## 5. 桌面端入口落点与页面结构

### 5.1 桌面 Electron（主表面，用户原话载体）

**为什么不做成 SettingsPage 的第八个左导航项**：用户要的是「一张表列出本机全部智能体 + 行内可执行安装/卸载/改配置」，这是**全屏替换式**的管理页形态，与 `KeyManagerPage`（独立窗口 + 四个 tab）同级；塞进 `SettingsPage.tsx:46-58` 的「Agent 能力」七项组里会让它和「记忆/子智能体/插件/MCP/技能/命令/钩子」这些**本进程内**设置混在一起——而那些项管的是 khy 自己的 agent，不是本机外部工具。两件事放在一组里，用户会分不清改的是谁。

**落点与接线（六处）**：

| # | 文件 | 动作 |
|---|---|---|
| 1 | `apps/khyos-desktop/src/renderer/components/agentHub/AgentHubPage.tsx` | 新页面。全屏替换式（左导航实例列表 + 右滚动详情区），照 `SettingsPage.tsx:20-23` 的布局与 `KeyManagerPage.tsx:4-8` 的多 tab 形态 |
| 2 | `apps/khyos-desktop/src/renderer/App.tsx:41-51` | 加 `const AgentHubPage = lazy(() => import('./components/agentHub/AgentHubPage').then(m => ({ default: m.AgentHubPage })))`——与既有 lazy 页同款（一天开不了一次，不该进首屏闭包）。**注意该区域当前有四个 lazy 页而非第 1 轮写的三个**（`KeyManagerPage` :42 / `SettingsPage` :45 / `AutomationsPage` :48 / `EnvironmentsPage` :51，工作树已变动） |
| 3 | `apps/khyos-desktop/src/renderer/App.tsx:352-361` | 加 `const agentHub = route === 'agent-hub'`（既有四个路由常量：keyManager / settings / automations / environments）；在 `:451` 的 `if (keyManager \|\| settings) return` 里把 `agentHub` 一并纳入（全局快捷键只在主界面接管） |
| 4 | **`apps/khyos-desktop/src/renderer/App.tsx:669-724` 的渲染分支** | **这一步最易漏，漏了入口就是死的**。全屏页各有一个早退分支，**当前是四个而非第 1 轮写的三个**：`if (keyManager)`（`:669`）、`if (settings)`（`:683`）、`if (automations)`（`:697`）、`if (environments)`（`:711`），每个都包 `<ErrorBoundary><Suspense fallback={<div style={{ padding: 24 }} />}><XxxPage /></Suspense></ErrorBoundary>` + `<ToastContainer />`。新页面必须加第五个同形态分支 `if (agentHub) { return (…<AgentHubPage />…) }`，位置在 environments 分支之后、主界面 `return`（约 `:725`）之前。**只做 #2/#3 而不做本条，TitleBar 菜单把 hash 改成 `#/agent-hub` 后会直落主界面，新页面永远不渲染** |
| 5 | `apps/khyos-desktop/src/renderer/components/layout/TitleBar.tsx:135-169` | `menuItems` 加一项 `{ kind: 'action', label: '智能体统一管理', icon: 'plugins', run: () => { window.location.hash = '#/agent-hub' } }`，位置在「密钥与端点管理」之后——两者是并列的管理入口，且密钥管理已有先例（`:140` 的注释记着「自绘窗口菜单才是当前形态下唯一活着的菜单面」） |
| 6 | `apps/khyos-desktop/src/main/agentHub/service.ts` + `ipc.ts` + `src/preload/index.ts` | **service.ts 是 CH-2 直调层**（不是 HTTP 客户端）：复用 `agentWriters.ts:33-55` 的 `resolveBackendServicesRoot()` 定位后端 src 根，`createRequire` 载入 `services/domain/agents/agentHub/{overview,planner,executor}`，把结果归一成 renderer 可用的形状；零 HTTP、零 token（§2.1）。`ipc.ts` 按 `keyManager/ipc.ts:52-182` 的 `ipc.handle` 命名法注册 `agentHub:*` 通道，preload 暴露 `window.__KHYOS__.agentHubXxx()`。**第 1 轮此格写的是 `{ipc,api}.ts` 且 api.ts 是 HTTP 客户端——整格推翻** |

**为什么不复用 KeyManager 的独立窗口**：`keyManagerWindow.ts` 是 `--key-manager` 启动参数驱动的独立 BrowserWindow，且 `TitleBar.tsx:138` 记着它「入口① 名存实亡」的历史。统一管理页是高频页（换模型是反复操作），放主窗口 hash 路由比再开一个窗口更贴合「一天可能开不一次」那条注释的反面。

> 行号说明（§12 R8）：`App.tsx` 等文件均有未提交改动，行号相对第 1 轮已漂移。**落笔前以 `Select-String` 现场定位为准**（如 `Select-String -Path apps/khyos-desktop/src/renderer/App.tsx -Pattern 'if \(keyManager\)|if \(settings\)|if \(automations\)|if \(environments\)'`），不要照抄行号。

### 5.2 页面结构（单页四区）

```text
┌─────────────────────────────────────────────────────────────┐
│ 顶栏：标题 + 「重新扫描」按钮 + 降级横幅（后端不可达/门控关）      │
├──────────┬──────────────────────────────────────────────────┤
│ 左：实例   │ 右：选中实例的详情，四个 tab                       │
│ 列表      │   ① 概览（安装状态/版本/形态/数据根/纳管等级）        │
│          │   ② 模型配置（摘要卡 + 编辑，脱敏）                   │
│ 每行：    │   ③ MCP / skill / 记忆（三张表 + 导入导出）           │
│ 状态点    │   ④ 安装与卸载（计划 → 确认 → 执行 → 回滚点）        │
│ 名称      │                                                  │
│ 版本      │ 未纳管的实例在右区顶部给「登记适配器」引导            │
│ 资产计数  │                                                  │
├──────────┴──────────────────────────────────────────────────┤
│ 底部：状态行——当前动作 + 目标 + 进度（规则 2）                   │
└─────────────────────────────────────────────────────────────┘
```

**左列表的分组**（对应 §3.3 两条路）：`已纳管` / `发现未识别项` / `未安装（已登记）`。「未安装」组**默认折叠但不隐藏**——用户点名了 9 类，其中 4 类本机没装，折叠起来用户会以为功能漏了。

**表格列**（用户点名的验收形态）：安装状态、版本、形态（CLI/GUI/IDE 扩展）、模型配置摘要、MCP 数、skill 数、记忆文件数、纳管等级（tier）。未纳管的行在「安装状态」列显式标「未纳管」，**不静默跳过**。

**行内操作**：安装/卸载、改模型配置、增删 MCP、导入导出 skill/记忆。除「改模型配置」外全部**先出计划**（§6.2）。

### 5.3 Web 管理台（同源第二表面）

盘点结论：`/admin/agents` 的**路由与 viewLoaders 已在**（`router/index.js:103-104` 的 `/agents` → redirect `/admin/agents`；`useRoutePrefetch.js:62` 的 importer 指向 `@/views/admin/AgentDashboard.vue`），**缺的只有 NAV 一项**。但那个页面管的是 khy 自己的 agent 角色，与外部智能体统一管理不是一回事，故新开 `/admin/agent-hub` 而不改占它。

接线（三处，与既有 `nav.wiring.test.js` 锁的 NAV↔router↔viewLoaders 三方对齐）：

| # | 文件 | 动作 |
|---|---|---|
| 1 | `delivery/web/ai-frontend/src/nav/index.js:108-158` | 「管理控制台」组（`requiredRole: ROLE.ADMIN`）加一项 `{ path: '/admin/agent-hub', label: '智能体', icon: ..., desc: '本机 AI 编程智能体的统一管理：安装卸载、模型配置、MCP、技能与记忆' }`。注意：NAV 的 `requiredRole` **只控制侧栏显隐**（`nav/index.js:109` 的组级 floor + `visibleNavGroups`），路由的 `requiresAdmin` 由另一套机制盖——`router/index.js:509-517` 的 `isAdminPath()`（命中 `/admin` 前缀或 `ADMIN_NAV_PATHS`）经 `:530-538` 的 `stampAdminMeta` 递归盖 `route.meta.requiresAdmin`，路由守卫 `:558-559` 据此弹 `/403`。两处机制不同但结论一致：`/admin/agent-hub` 落在 `/admin` 前缀下，**不需要**为它单独改 `isAdminPath` |
| 2 | `delivery/web/ai-frontend/src/composables/useRoutePrefetch.js` | view importers 单一真源加 `'/admin/agent-hub': () => import('@/views/admin/AgentHub.vue')` |
| 3 | `delivery/web/ai-frontend/src/router/index.js` | `/admin` 父路由下加 child（`path`/`name`/`component = viewLoaders[...]`） |

**页面样板**：`MyGateway.vue`（1451 行，多 tab 管理页 + `scope=user` 卡片化）是配置项重的新管理页最贴近的结构；`EcoMarkets.vue` + `useEcoMarkets.js` 是最新约定（`KhyPageHeader` / `LoadErrorBanner` / degraded 告警 / 刷新态「动作+目标+进度」文案 / composables 只归一化形状不重算）。**新页面按 EcoMarkets 约定写**，因为它与本功能的降级语义完全同构。

**这一表面是否本轮做，待拍板**（见 §9 第 3 条）：后端命名空间同时服务两端，但前端是两份工作量。

---

## 6. 安全边界

### 6.1 操作分级（对应规则 7「删除先报部位」）

| 级 | 操作 | 要求 |
|---|---|---|
| **R 只读** | 探测、列资产、读模型配置摘要 | 无。默认全部可点 |
| **W1 资产写** | skill/记忆/MCP 的导入导出 | 干跑计划 + 冲突清单（`sync.js` 的 keep-both 已有）；不需要额外确认令牌 |
| **W2 配置写** | 改别家 live 配置的模型/provider | 干跑计划 + 写前备份 + 确认令牌 |
| **W3 程序装卸** | 安装 / 卸载程序本体 | 干跑计划 + **逐项列明会丢什么** + 写前备份 + 确认令牌 + **agentHub 自己的台账**（B 类，§6.2）+ 回滚点 |
| **W3+ 删用户数据** | 删除某家智能体的数据目录 | W3 全部要求 + **单独的更高一级确认** + losses 清单摊开（§6.2 末段） |

**「逐项列明会丢什么」是 W3 的核心**。本机实测的高危删除点（都在盘点证据里）：claude-code 的 `CLAUDE_CONFIG_DIR` 一删就没 61 个会话 jsonl 约 60 MB + auto-memory + 插件市场缓存；opencode 删 `xdg/` 丢 167 MB 会话库；workbuddy 有**四个数据根**，按「删 `~/.workbuddy`」清理会漏掉 portable 根里真正的 106 条会话与 7 个技能；qoder 删 `.qoder/` 丢 1.46 MB 项目记忆与 109 MB 转录；zcode 的 `%USERPROFILE%\.zcode` 是 junction，删联接点与删目标效果不同。**计划里必须把这些逐条列成「不可再生」清单**，不能只写「将删除目录 X」。

### 6.2 先确认、先备份、可回滚

```text
plan（不落盘）
  ├─ steps[]        按序执行步骤，每步带目标路径与动作
  ├─ backup[]       将备份哪些文件、备份到哪（默认 <dataHome>/agent-hub/backups/<planId>/）
  ├─ losses[]       「删了不可再生」清单（§6.1 W3）
  └─ risks[]        凭据泄露风险、多实例串台风险、junction 风险、双写者风险（§2.1 缺口二）
        │
        ▼ 用户确认 → confirmToken
apply
  ├─ 1. 备份（先复制到 backups/<planId>/，再改原文件）
  ├─ 2. 落盘（每步经适配器；适配器写必走原子写）
  ├─ 3. 分类记账（见下方两类，**不混写**）
  └─ 4. 回报 rollbackPoint（backupId 或 agentHub 台账序号）
        │
        ▼ 用户反悔
rollback —— 两类，机制不同：
  A. 配置写回滚：从 backups/<planId>/ 读原文件 → 原子写回原路径
  B. 程序装卸回滚：读 agentHub 自己的台账 → 逆序执行（撤注册/停进程先于删文件）
```

**回滚分两类，是因为共享的 `.install-ledger.jsonl` 装不下 agentHub 的写**（§12 R2/R3，这是第 1 轮「委派 `computeRollback`」的推翻）：

| | A 类：改别家 live 配置 | B 类：安装 / 卸载程序本体 |
|---|---|---|
| 逆操作 | 把备份写回原路径 | 撤注册 / 停进程 / 删 khy 造成的副作用 |
| 共享台账能表达吗 | **不能**。`installLedger.js:54-61` 的 `_KNOWN_ACTIONS` 只有 6 个词（`unlink` / `rmdir` / `unregister-autostart` / `unregister-md-editor` / `stop-process` / `remove-runtime`），全是「撤销 khy 自己的安装副作用」的形状，**没有「从备份恢复」这一形**；`computeRollback` 对词表外动作一律记 `skipped` 不执行（`:253-256`） | 部分能（unlink/rmdir/stop-process 可复用） |
| 读者在哪 | — | `computeRollback` 是零 IO 纯函数，读 jsonl 的 `_readLedgerEntries` 是 **D1 CLI handler 的私有函数**（`cli/handlers/uninstall.js:299-323`）。D2 service 去 require D1 handler 会新增 `cross-layer-require` 边，而 §4.2 原文「委派 computeRollback」根本没有可委派的读者 |
| 本设计怎么做 | **不写进共享台账**。回滚点 = `backups/<planId>/` 里的原文件 + agentHub 自己的备份索引（`<dataHome>/agent-hub/backups/index.json`，记 `backupId / agentId / 原路径 / 写入时间 / 计划摘要`） | agentHub 自己的 `<dataHome>/agent-hub/ledger.jsonl`，**计算仍复用 `installLedger.recordSideEffect` 归一化**，落盘用 agentHub 自己的 append；逆序与去重逻辑同样复用 `computeRollback`（词表内的动作） |

**为什么 B 类也不写进共享台账——串台问题**（§12 R3）：`.install-ledger.jsonl` 的唯一读者是 `khy uninstall`，它读**全文件**后把每条当 **khy 自己的**安装副作用回滚（`cli/handlers/uninstall.js:401-410` → `:352-398` 的 `_executeRollbackStep` 做 unlink/rmdir）。而 `installLedger.js:67` 的 meta 白名单只有 `scope / platform / package / label / reason` **五项**（实测 `new Set([...])` 恰 5 项；本文第 1 轮曾误写「四项」，第 3 轮复核已按实测更正），**记不下「属于哪个 agent」**，`computeRollback` 又按 `target` 全局去重（`:249-251`）。于是 agentHub 一旦把「写了 `~/.claude/settings.json`」记进共享台账，**khy 自己下次卸载就会去删别家工具的配置文件**；反向的 `POST /agents/:id/rollback` 也无法从共享台账里按 `:id` 取子集。

**故第 1 轮「不另起一份 agent-hub 台账」的结论在此修正**：那句话只论证了「两份台账等于没有台账」，没处理**作用域不同**的情形。正确的判据不是「几份」，而是「**读者是否同一批**」——共享台账的读者是 `khy uninstall`（管 khy 自己的安装副作用），agentHub 台账的读者是 agentHub（管本工具对外部智能体做过的程序装卸）。两者读者不同、meta  Schema 不同、回滚动词表不同，**合并才会串台**。agentHub 台账因此是**作用域隔离**，不是重复造账。

**第 1 轮「两层都要接」的教训仍然有效，且适用范围收窄**：`installLedger.recordSideEffect` 是纯函数（零 IO，`:13-17` 自述），只调它不落盘 = 台账只在内存。第 1 轮据此要求「必须同时接 `ledgerWriter.appendSideEffect`」——那条对**写共享台账**成立（`ledgerWriter.js` 是共享台账的唯一 IO 边界，`:4-9` 自述）；但本设计已改为**不写共享台账**，故 B 类的落盘由 agentHub 自己的 append 完成，`ledgerWriter` 不再被 agentHub 调用。**这条修正同时消解了 R1 的风险**（不再有「接了计算层没接落盘层」的中间态），但 R1 的诊断——「零 IO 叶子不能当落盘用」——作为通用教训保留。

**卸载的边界**：官方卸载通道只删程序、不删用户数据（kiro 官方文档明说「using your operating system's standard application removal process」，trae 本机即是「程序目录已不在、`~/.trae` 残留至今」的活证）。所以 agentHub 的「卸载」**默认只走官方卸载通道 + 摘 PATH/注册表条目**，删用户数据目录是**单独的、更高一级确认的 W3+ 动作**，且必须先把 §6.1 的 losses 清单摊开。

### 6.3 通道选择（[DESIGN-ARCH-071]）

| 操作 | 通道 | 依据 |
|---|---|---|
| 探测、列资产、读配置 | CH-1 直读状态文件 + 经适配器聚合 | 只读豁免；但「要不要业务规则聚合」不过关时走 CH-2/CH-4（矩阵 Q2） |
| 改别家配置 / 装 / 卸（桌面端） | **CH-2 服务层直调**（`main/agentHub/service.ts` → `createRequire` 载 service 模块） | 矩阵 Q1：改变系统状态 → 禁止 CH-1 直写 → 进 Q4 选带副作用的正门。桌面端选 CH-2 而非 CH-4 的理由见 §2.1（无登录态、无 token、`host/index.ts:3-4` 既有先例） |
| 改别家配置 / 装 / 卸（Web 管理台） | **CH-4 Web API** `/api/agent-hub` | 矩阵 Q4：前端/远程/多并发消费者 → CH-4 |
| 桌面 renderer → 主进程 | Electron preload IPC（`__KHYOS__.agentHub*`） | 进程内边界，与 `keyManager/ipc.ts` 同款；renderer 不直连后端（`[DESIGN-LAY-005]` §二 `L3 → L2` 仅 HTTP，桌面 renderer 不经 HTTP 故走 IPC） |
| CLI handler / 单测调 service | CH-2 服务层直调 | 矩阵 Q3：同一 Node 进程 |

**三条反模式明令禁止**（矩阵 §3）：直写状态文件改状态；看屏幕读自家结构化信息；前端绕过 HTTP。**补一条本功能特有的**：桌面端不要试图打 `/api/agent-hub`（没有 token，必 401，§4.3）。

### 6.4 凭据

- 一切对外展示走 `_shared.maskKey`（只留头尾各 4 字符）；IR 与返回值只带掩码。
- 真 key 只在**写路径内**从源侧磁盘流向目标侧磁盘，不经 UI、不经日志、不经返回值（`externalApps/README.md:46-47` 已立此约）。
- 台账侧的掩码**由 `recordSideEffect` 内部完成**，调用方无感也无需调用：`installLedger.js:19-20` 的密钥红线自述「meta 只保留白名单标量字段,且任何疑似 key/token 形态一律丢弃」。⚠ 不要试图 `require` 一个 `_sanitizeMeta`——它是 `installLedger.js:126` 的模块私有函数，`:296-305` 的 `module.exports` 只导出 `isLedgerEnabled / ledgerPath / recordSideEffect / computeRollback / describeInstallLedger / LEDGER_VERSION / LEDGER_FILENAME / KIND`（§11 R14）。
- 本机实测的凭据散落面（claude 两份 settings.json 的 `ANTHROPIC_AUTH_TOKEN`、opencode 七处、zcode 三处、qoder 的 `mcp-router.json` apiKey）说明：**「清理配置」动作要么泄露要么永久丢失这些 key**。故 agentHub 不提供「一键清理某家配置」，只提供「导出脱敏摘要」与「备份原文件」。

---

## 7. 状态透明（规则 2）

**后端 `onProgress` 契约**（照 `sync.js:78-86` 的 `formatProgress` 三维）：

```text
正在探测 <label> 安装位置（已查 3/5 处）
正在备份 <label> 模型配置（1/2 个文件）
正在写入 <label> MCP 服务器 deepseek-eyes（第 2/3 步）
正在卸载 <label>（备份完成 4/4，将删除 3 个目录）
```

**每条状态消息都必须含**：动作（探测/备份/写入/卸载）+ 目标（哪家、哪个文件/服务器）+ 进度（`n/m`、百分比、「第 n 次」、路径、字节数）。`check-agent-rules.js` 认可的进度信号包括 `n/m` 数字比例、百分比、「第 n 次」、`attempt`/`retry`、`host`/`port`/`bytes`、「节点/记录/条目」——新写的状态文本照这些形态组织，别赌人工评审。

**错误消息**：一律「问题 + 识别码 + 修复」三段（§4.2 的表是模板）。禁止「AI 请求失败」式空泛指。

**长任务超时**：照 `sync.js:41-42` 与规则 3——**不按总时长硬杀**。每完成一项刷新 `lastActivity`，只有连续无进展超过 `idleTimeoutMs`（默认 60s）才中止，且错误里说明卡在第几步第几项。探测/备份/搬运都可能因某家工具的数据目录极大而慢，但不能因此被杀。

---

## 8. 新机制落地阶段（规则 8）

本功能**含一个拦截型机制**：`planner.js` 的确认令牌闸门（`AGENT_HUB_NEEDS_CONFIRM`——不带令牌的写操作一律拒绝）。按 `PROCESS-008` 不得直进 S3。

**登记建议**（落点 `docs/10_规范/registry/FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms[]`，字段形状照既有条目）：

```json
{
  "id": "agent-hub-write-confirm-gate",
  "name": "智能体统一管理写操作确认闸门",
  "ssot": "docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-203] 智能体统一管理.md",
  "rules": ["RUNTIME-009"],
  "executor": "runtime/node/backend/src/services/domain/agents/agentHub/planner.js",
  "stage": "S1",
  "stageSince": "<落地日>",
  "stageAuthority": "planner.js 的 STAGE 常量",
  "executorStage": {
    "file": "runtime/node/backend/src/services/domain/agents/agentHub/planner.js",
    "constant": "STAGE",
    "note": "阶段权威在执行器源码里（STAGE 常量），登记表只是镜像。check-rollout-stage.js 比对两者的**阻断语义**（STAGE_ORDER[常量]>=3 与 stage>=3 是否一致），漂移即报 rollout-stage-authority-drift——防止「登记说 S1、代码其实在拦」。"
  },
  "samples": { "observed": 0, "target": 200 },
  "rollback": "删 routes/agentHub.js 的 apply 分支 / 将 STAGE 常量改回 S1",
  "blockedBy": []
}
```

**`executorStage` 不是可选项**（§11 R5）。`scripts/ci/check-rollout-stage.js:485-527` 的代码/登记漂移校验**只在 `m.executorStage.file && m.executorStage.constant` 都存在时才生效**：缺它，守卫连「文件里有没有这个常量」都不查，「登记说 S1、代码其实在拦」这条防护对该机制完全不起作用——正是 `AGENTS.md` 规则 8 点名要防的形态。`FEATURE-OWNERSHIP.json` 现有 **40** 个 mechanism，其中 **33** 个带 `executorStage.file` + `constant`、**7** 个不带（`tool-challenge-cadence` / `domain-direction-guard` / `functional-unit-guard` / `entry-buffer-guard` / `q1-root-uncatalogued` / `q1-registry-path-dangling` / `q1-floor-closed-set`——实测 `node -e require('docs/10_规范/registry/FEATURE-OWNERSHIP.json')` 逐条列出，§12 R7 更正了第 1 轮误写的「47 个」）。先例如 `agent-feedback-contract` 的 `{file: scripts/ci/check-agent-feedback.js, constant: STAGE}`、`rollout-stage-guard` 的 `{file: scripts/ci/check-rollout-stage.js, constant: GUARD_STAGE}`；新条目不得成为第 8 个漏网者。另注意 `:501-511` 的注释记着一个真实踩过的坑：守卫比的是**阻断语义**而非字面相等——登记 S1/S2 时执行器 `STAGE` 必须是 `'S1'`/`'S2'`，拿 `STAGE` 去和 `stage` 比字面会把正确搭配误报成漂移。

**为什么是 S1**：毕业看样本量不看时间（PP-2）。S1 需 ≥200 条相关事件且无解释不了的样本；S2 需 ≥50 条提示后误报 <10%；S3 需 ≥20 次真实拦截且豁免率 <20%。本机制的「解释不了的样本」大概率来自 tier 判定与多实例消歧，必须先观察。

**同时登记的两个观察者档执行器**（S1 只记录不阻断，与 `check-agent-authz` / `check-native-registry` / `check-delivery-baseline` 同档）：

- 适配器契约守卫（新适配器缺 `detect()` 的 `checked[]` / 缺 env 注入 / 缺同名同目录测试 → warning）
- 登记表漂移守卫（`agentHub/registry.js` 与 `agentAssets/registry.js` / `agentLauncherRegistry.js` / `externalApps` 四张表的 id 集合差异 → warning，差异是常态不许判 error）

**一处必须避开的坑**（`AGENTS.md` 规则 8 已点名）：判「S1/S2 有没有在拦」时守卫复算 `gateStrength()`，未声明 `severity` 时 P0/P1 会**派生**成 `blocking`。所以 `planner.js` 的闸门必须**显式写 `severity: advisory`**，否则「没写 severity」会被当成在拦，直接违反 PP-3。

---

## 9. 不做清单

**本轮明确不做**：

1. **不做「一键清理某家配置」**。见 §6.4——要么泄露要么永久丢失凭据。只做「导出脱敏摘要」与「备份原文件」。
2. **不猜未知智能体的配置格式**。`discovery.js` 扫到未登记指纹只报「发现未识别项」，不生成半自动适配器（§3.3 路 B 红线）。
3. **不为未知智能体生成安装/卸载命令**。安装卸载只对 `tier: full` 且**有官方非交互式通道**的条目开放；其余一律引导到官方页面。
4. **不做多机同步**。范围边界未问（§1.1），且「哪台机器装了哪家」是本机态，同步它会引入租约/冲突全套问题。
5. **不接管 khyquant**。它是独立项目、另案申报（`AGENTS.md` 项目概览），本表只管 AI 编程智能体。
6. **不做凭据/API key 的统一托管**。「skill 记忆等等」里的「等等」外延未定义（§1.1）；把别家的 key 搬进 khy 的池子是另一个安全模型，不在本功能范围。
7. **不新增 CLI 顶层命令**（§4.4 棘轮）。
8. **不改 `agentAssets` / `externalApps` / `ccSwitch` / `uninstall` 四者的既有契约**。只委派，不重构；它们各自的已知缺陷（`externalApps/README.md:54-59` 登记的 B30-S1…S11）归人裁决，不搭本功能的车。
9. **不做全盘递归扫描**。本机实测两次 `where /R` 全盘搜索均超时中止（Cursor.exe 一例）。探测只用「PATH + 安装候选目录 + 注册表 + 数据目录 + 进程」五源，不遍历整盘。
10. **不做「智能体市场」**。发现/安装/配置是管理，不是分发；分发归 `khy-market` / `ecoMarkets`。
11. **本轮不为 qoder / workbuddy / kiro / cursor 新写后端模型配置写器**。见 §2.1 覆盖缺口表——补写器要么与 Electron 主进程的 builtin 写器构成「同一关注点两个写者」，要么是改动 D3 常量的独立工作，都属架构决策。这 4 家本轮只能读、不能改模型。
12. **不给 `constants/installationCandidates.js` 补 darwin / linux 分支**。那是改动既有 D3 共享常量、影响面超出本功能的工作（见 §3.3 路 B 表第 2 行与 §11 R3）；本功能的目录扫描在 `agentHub/discovery.js` 内自建候选，Windows 之外的目标平台候选留空并如实标注。
13. **不归并 claude-code / opencode 的既有双写者**。见 §2.1 缺口二——那是 `[DESIGN-ARCH-091]` KeyManager 与 ccSwitch 卡片矩阵之间的账，属独立架构工作。本轮只在 UI 上显式告知、在 `overview` 里回报 mtime 与写入来源。
14. **不给 `middleware/auth.js` 加回环/本机豁免**。桌面端因此走 CH-2 而非 HTTP（§2.1、§4.3）；若要开放 `/api/agent-hub` 给本机回环调用方，那是安全模型变更，须独立评审。
15. **不改 `.install-ledger.jsonl` 的 Schema 与 `_KNOWN_ACTIONS` 词表**。agentHub 因此用自己的台账与备份索引（§6.2、§12 R2/R3）；给共享台账加「agent 域」字段是影响 `khy uninstall` 语义的变更，不搭本功能的车。
16. **不把 `00_INDEX_DESIGN-ARCH-总目录.md` 第 5 行的「收录 194 篇」改成动态推导**。见 F2b——本文只把失真记成可证伪事实，是否保留手计数属维护者决策。

**待用户拍板（五条，答完再动工）**：

| # | 问题 | 为什么不能 AI 代答 |
|---|---|---|
| 1 | Q1「谁用」：是否只限本机 owner 单人单机？要不要团队/多机视图？ | 用户未陈述使用者 |
| 2 | `cusur` → Cursor、`command code` → CommandCode 两处指代是否成立？ | 仓内 `services/gateway/adapters/cursorAdapter.js` 是**网关 AI 适配器**（读 Cursor 的 auth token 用它的模型），不是配置适配器；`externalApps/` 无 cursor。用户未确认指的就是它们 |
| 3 | Web 管理台表面（§5.3）本轮是否一并做？ | 后端命名空间同时服务两端，但前端是两份工作量；用户原话只点名桌面端 |
| 4 | **qoder / workbuddy / kiro / cursor 的模型配置写腿归谁？** | 三条路各有代价：① 后端新写适配器（与 `agentWriters.ts:226-237` 成为同一关注点的两个写者，违反本文的「杜绝第二写者」）；② 让桌面端 builtin 成为唯一写器、后端只读（则统一管理页对 qoder 的「改模型」实际是改 khy 的 `.env`，语义要说清）；③ 本轮只读（§9 第 11 条）。这是架构决策，不是实现细节 |
| 5 | **claude-code / opencode 的双写者是否接受「第三个写入面」？** | 今天已有两个写者（§2.1 缺口二）。agentHub 的「改模型」会成为同一文件的第三个写入面。要么接受（UI 明确告知 + mtime 对账），要么先做归并再上统一页——归并影响 KeyManager 与 ccSwitch 两端，是独立工作 |

---

## 10. 事实主张清单

> 逐条可证伪。复核方式：路径用 `Test-Path` / `Get-Content`，行号用 `Select-String -Path <file> -Pattern <pat>`，命令存在性用 `Select-String` 对 `router.js` / `commandSchema.js`。
>
> **第 3 轮事实复核已并入 §13**：本清单全部 60 条主张 + N1–N9 共 69 项经第三方逐条复核，**verified 50 / unconfirmed 8 / verified 附校正 5**。8 条未确认在本清单中原样保留并在行内标注 **【未确认】**（不删条目、不改 verdict）；5 处行内小差以「（校正：…）」注明。**未确认的 8 条**：F1（设计时前提已被现实证伪）、F5（`_adapterBase.js` 目录归属写错）、F17e（`_META_ALLOW` 计数 4→5）、F30（半数被证伪）、F39（未复跑扫描）、N2 / N3 / N5（均未复跑）。

### 编号可用性

| # | 主张 | 复核方式 |
|---|---|---|
| F1 | `docs/03_DESIGN_设计/DESIGN-ARCH/` 下不存在以 `[DESIGN-ARCH-203]` 开头的 `.md`；该目录最大已用编号为 202（`[DESIGN-ARCH-202] 开工裁决-任务与项目两级可复算判定.md`），故 203 是下一个可用编号 | **【未确认】** 设计时前提，当前已被现实证伪——203 已落盘（本文自身）、`[DESIGN-ARCH-204] 统一开发环境管理器-盘点清单与一键恢复.md` 已于 2026-11-07 19:25:45 由本机其他进程新建，最大已用编号现为 204。属「已失真」而非「未验证」；主张原样保留。复核见 §13.1 | `Get-ChildItem 'docs/03_DESIGN_设计/DESIGN-ARCH/' -Filter '*203*'` 返空；`-Filter '*202*'` 返上述一篇 |
| F2 | 该目录的就近索引是 `00_INDEX_DESIGN-ARCH-总目录.md`，其第 5 行自述「收录 194 篇」——**该声明在追加 203 后已失真且无守卫会发现**：实测该目录现有 **197** 个 `.md`（1 个索引 + **196** 篇正文，`Get-ChildItem -Filter '*.md' | Group-Object` 分组计数），与声明值 194 差 2。`check-repo-layout.js` 的 `docs-index-complete`（`:630-641`）只比对**文件名是否出现在主索引或就近索引**，不校验这个声明计数。另：无生成脚本（`scripts/docs/fix-doc-index.js` 与 `auto-fix-doc-index.js` 的 `INDEX_FILE` 都只指向主索引 `docs/00_INDEX_文档索引.md`），故该计数是手工维护的 | `Get-Content` 读第 5 行；`Get-ChildItem -Filter '*.md' | Group-Object`；`Select-String` 两个脚本的 `INDEX_FILE`；读 `check-repo-layout.js:630-641` |
| F2b | 本文未顺手改掉该失真计数：它是**会再次漂移的手工数**（本会话进行中该目录 .md 数就在变），改一个数不等于修好机制；是否保留这个手计数、还是改成「以索引行数动态推导」，属维护者决策（列入 §12 R9） | — |
| F3 | 本设计文档落盘后需手工往该就近索引追加一行，否则 `check-repo-layout.js` 的 `docs-index-complete`（基线 0）会超基线，把 warning 升为 error | `npm run check:layout` 前后各跑一次对比计数（实测两轮均为 0，见 N8） |

### 仓内结构与职责

| # | 主张 | 证据 |
|---|---|---|
| F4 | `runtime/node/backend/src/services/domain/agents/agentAssets/registry.js` 存在，`AGENT_ASSET_SOURCES` 冻结表恰有 6 条：khy-os / opencode / claude-code / harness / deepseek-harness / openclaw | 该文件 `:27-34` |
| F5 | `runtime/node/backend/src/services/domain/agents/agentAssets/adapters/` 下有 6 个适配器文件（claudeCode / deepseekHarness / harness / khyOs / openclaw / opencode）+ `_adapterBase.js` + `khy.module.json` | **【未确认】** 6 个适配器与 `khy.module.json` 属实，但 `_adapterBase.js` **不在 `adapters/` 下**——它在上一级 `agentAssets/_adapterBase.js`（另有 `_adapterBase.test.js`）。目录归属写错；主张原样保留。复核见 §13.2 | `Get-ChildItem` 该目录；`Get-ChildItem -Recurse -Filter '_adapterBase*'` 定位真实位置 |
| F6 | `runtime/node/backend/src/cli/handlers/agentAssets.js` 头注释列出 7 个子命令（discover/caps/list/plan/import/export/sync），并写明「默认只出计划不落盘，必须显式 `--apply`」 | 该文件 `:10-20` |
| F7 | `_adapterBase.js` 的 `probeRoot` 在探测失败时回报「已查找 N 处目录」清单，并区分「未设的环境变量」与「找过的目录」 | 该文件 `:96-106` |
| F8 | `assetModel.js` 定义 `ASSET_KINDS = ['memory','tool','skill']`，并有「IR 绝不承载凭据明文」的 REDACTED 机制 | 该文件 `:35`、`:14-20`、`:44` |
| F9 | `sync.js` 有四条不可协商行为：干跑优先、绝不静默覆盖（keep-both）、状态透明三维、活动感知超时（`DEFAULT_IDLE_TIMEOUT_MS = 60_000`） | 该文件 `:17-24`、`:42`、`:78-86` |
| F10 | `runtime/node/backend/src/services/agentLauncherRegistry.js` 的 `AGENT_LAUNCHERS` 有 8 条（kiro/cursor/claude/codex/trae/opencode/warp/vscode），`LEGACY_LAUNCHER_COMMANDS` 有 5 条，门控 `KHY_AGENT_LAUNCHERS` 默认开 | 该文件 `:44`、`:53-63`、`:28-30` |
| F11 | `runtime/node/backend/src/cli/router.js:2495-2502` 有 **8** 个并列 per-agent `case`（kiro / cursor / claude / codex / trae / opencode / warp / vscode） | `Select-String` 该行段 |
| F12 | `runtime/node/backend/src/services/domain/network/externalApps/` 下有 11 个 `*Adapter.js`（claudeCode / commandCode / coze / deepseekTui / geminiCli / openclaw / opencode / reasonix / traeApp / ycode / zcode）+ `_shared.js` + `appModelImporter.js` + `tomlLite.js` / `tomlLiteFormat.js` | `Get-ChildItem` 该目录；`README.md:35` 自述「11 家适配器同一个六件套」（`:23-24` 是测试段，非此句） |
| F13 | `externalApps/README.md:40-42` 自述有两个成员破坏「env 注入」隔离承诺（`traeAppAdapter._readStore` 丢参数、`opencodeAdapter` 便携根候选不看 env）；`:54-59` 登记 11 条已知缺陷 B30-S1…S11 且「修法涉及改 D1/D2 源码…属人的裁决」 | 该文件对应行 |
| F14 | `runtime/node/backend/src/routes/ecoMarkets.js` 存在，GET-only，文件头写明鉴权挂载点、`apiResponse` 信封、降级载荷 | 该文件 `:4-17` |
| F15 | `aiManagementServer.js` 的 eco-markets 挂载是三处一套：`getEcoMarketsApp()`（`:368-378`）、pathname 分发分支（`:2393-2395`）、`__test__.getEcoMarketsApp`（`:3775`） | `Select-String` 该文件 |
| F16 | `runtime/node/backend/src/services/marketInstallService.js` 头注释自述「only dispatches」，skill 走 `skillInstallService`、MCP 走 `mcpConfigStore`，杜绝第二写者 | 该文件 `:3-12` |
| F17 | `runtime/node/backend/src/services/domain/maintenance/uninstall/installLedger.js` 是**零 IO 纯叶子**（`:13-17` 自述），有 `recordSideEffect`（`:162`，归一化不落盘）、`computeRollback`（`:222`）、`describeInstallLedger`（`:282`），门控 `KHY_INSTALL_LEDGER`（`utils/flagRegistry/index.js:1670`），自述「真 key 永不落台账」。同目录 `ledgerWriter.js:4-9` 自述「安装台账的**唯一写入 IO 边界**」，其 `appendSideEffect`（`:55-85`）是真正的落盘函数；`:296-305` 的 exports **不含** `_sanitizeMeta`（模块私有，`:126` 定义） | `Select-String` 两文件；`Get-ChildItem` 确认同目录关系 |
| F17b | `ledgerWriter.appendSideEffect` 的现有调用方恰为四处：`services/mdEditorRegister.js:51`、`services/payloadProvisioner.js:163`、`services/runtimeProvisioner.js:336`、`services/domain/data/resources/resourceManager.js:142` | `Get-ChildItem 'runtime/node/backend/src' -Recurse -Include '*.js' \| Select-String -Pattern 'appendSideEffect'` |
| F17c | `ccSwitch/constants.js:32-45` 的 `APPS` 冻结表恰有 12 项（claude-code / codex / opencode / gemini / deepseek / reasonix / command-code / ycode / zcode / openclaw / coze / trae），**无** qoder / workbuddy / kiro / cursor | `Get-Content` 该文件 `:32-45` |
| F17d | `apps/khyos-desktop/src/main/keyManager/agentWriters.ts:226-237` 的 qoder 写的是 **khy 自己的 gateway `.env`**（`KHY_QODER_PROXY` / `QODER_PROXY_ENDPOINT`），不是 qoder 的配置文件；`:5-6` 自述 P1 覆盖 claude-code / opencode / qodercli | `Select-String` 该文件 |
| F17e | `installLedger.js:54-61` 的 `_KNOWN_ACTIONS` 冻结集恰有 6 个词（`unlink` / `rmdir` / `unregister-autostart` / `unregister-md-editor` / `stop-process` / `remove-runtime`），`:253-256` 对词表外 action 一律记 `skipped` 不执行；`:67` 的 `_META_ALLOW` 恰有 4 项（`scope` / `platform` / `package` / `label` / `reason`），**没有「属于哪个 agent」的字段**；`:249-251` 按 `target` 全局去重 | **【未确认】** 6 词、`:253-256` skipped、`:249-251` 去重三项均实测成立；但 `_META_ALLOW` 实测为 **5 项**（`:67` `new Set(['scope','platform','package','label','reason'])`）而非主张的「4 项」——主张自己的括号里也列了 5 个名字，属文档内部计数错误（§6.2 引用处已按 5 项表述）。「没有属于哪个 agent 的字段」的结论不受影响。主张原样保留。复核见 §13.2 | `Get-Content` 该文件对应行 |
| F17f | 共享台账的唯一读者是 `khy uninstall`：`cli/handlers/uninstall.js:401-410` 的 `_rollbackLedger` 先 `require` 纯叶子取 `computeRollback`，再调 `:299-323` 的私有 `_readLedgerEntries(env)` 读全文件，步骤交给 `:352-398` 的 `_executeRollbackStep` 做 unlink/rmdir。`_readLedgerEntries` 是 **D1 handler 私有函数**（`:691` 才导出给测试），D2 service 无法在不新增 `cross-layer-require` 边的前提下复用它 | `Select-String` 该文件 |
| F17g | `agentAssets/adapters/claudeCode.js:405-428` 的 `writeAsset(kind='tool')` 今天就能把 mcp_server 合并进别家 `mcpServers.<name>`，并调 `M.restoreRedacted(merged, existing, a.source.redactedFields)` 用**目标侧现值**填回凭据；`:406-412` 对非 `mcp_server` 型工具明确拒绝。`adapters/opencode.js:337-364` 同样只接受 `mcp_server` | `Get-Content` 两文件对应行 |
| F17h | **claude-code 与 opencode 今天就有两个活着的写者写同一批文件**：`agentWriters.ts:191-205` 写 `agentTargetPath('claude-code')`（定位在 `:75-78`）的 `env.ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL`（`:193` 先 `backupLive` 留 `.pre-khy.bak`，`:202` `writeJsonAtomic`）；`:207-224` 写 `agentTargetPath('opencode')`（`:79-91`）的 `provider.khy` 与 `doc.model`（`:209` 备份、`:221` 原子写）。后端 `externalApps/claudeCodeAdapter.js` + `ccSwitch/appWriters.js:13` 与 `externalApps/opencodeAdapter.js` + `appWriters.js:17` 写同一批文件 | `Select-String` 两文件 |
| F17i | `middleware/auth.js:175-199` 的 `authMiddleware` 只做 `extractBearerToken(req)` → `authSessionService.authenticateAccessToken(token)`，**无 token 直接 401、无回环/本机豁免** | `Get-Content` 该文件对应行 |
| F17j | `apps/khyos-desktop/src` 全量 grep `/api/` **只命中一处**，且是外部供应商 URL 字符串（`main/keyManager/keyStore.ts:760` 的 `https://openrouter.ai/api/v1`）——桌面端从未调用过后端 `/api/*` | `Get-ChildItem 'apps/khyos-desktop/src' -Recurse -Include '*.ts','*.tsx' \| Select-String -Pattern '/api/'` |
| F17k | `apps/khyos-desktop/src/renderer/App.tsx:149-151` 自述「ZCode has no login/welcome gate: the app boots straight into the IDE layout」「LoginPage stays in components/auth for that future entry point」——桌面端**没有登录态** | `Select-String` 该文件 |
| F17l | `apps/khyos-desktop/src/host/index.ts:3-4` 文件头明写「通道选择（AGENTS.md 五通道决策矩阵）：host 与 backend 同为 Node 进程语义，用 CH-2 服务直调（运行时 require aiGateway）；main↔host 用 Electron fork IPC」，并在 `:62/120/164/200/233/264/325` 用 `createRequire` 载入六个后端模块——**本仓早已把 Electron 侧对后端的直调裁定为 CH-2**，不是新偏差 | （校正：`nodeRequire` 实际用法在 `:62`（定义）、`:122`、`:166`、`:202`、`:235`、`:266`、`:327`，本行的 `:120/164/200/233/264/325` 各漂移 2 行，与 §12 R8 自述的「行号随工作树漂移 1–2 行」一致） `Get-Content` 该文件 |
| F17m | 全仓 grep `agentModel` **不存在该模块**：命中全是注释里的「agent 模型」字样（如 `services/domain/state/orchestrator/roleToolScope.js:7/15`）、`gateway/agentModelProjection.js`（另一个职责）与 `guiEval` 的 `agent_model` 字段。`utils/flagRegistry/index.js` 的 `isFlagEnabled` 对**未登记 flag** 的真实行为是「缺值 → 返回 true；显式值 → `!OFF_WORDS.CANON.includes(...)`」，**不是**「取不到就走某个本地兜底分支」 | `Get-ChildItem 'runtime/node/backend/src' -Recurse -Include '*.js' \| Select-String -Pattern 'agentModel'`；读 `isFlagEnabled` 函数体 |
| F17n | `runtime/node/backend/src/constants/commandSchema.js:641` 是 `'agent-assets': [` 子命令表的起始行（共 9 词：discover / caps / capabilities / list / plan / import / export / sync / help），`hub` 不在其中 | `Select-String -Path ... -Pattern "'agent-assets': \["` |
| F18 | `runtime/node/backend/src/services/domain/messaging/mcp/mcpEcosystemRegistry.js:299-300` 为 warp 与 trae 标注「MCP 配置存在应用内部数据库,非可读 JSON 文件」「未找到稳定的公开配置约定,不猜路径」 | `Select-String` 该文件 |
| F19 | `runtime/node/backend/src/constants/serviceDefaults.js` 有 `AI_BACKEND_DEFAULT_PORT`（env `KHY_DAEMON_PORT`，默认 9090）、`AI_BACKEND_DEFAULT_URL`，以及读 `ai_manage_runtime.json` 的 `apiPort` 的运行时发现逻辑 | 该文件 `:47-82` |
| F20 | `runtime/node/backend/src/utils/apiResponse.js` 存在，导出 `success` / `fail`，信封形状为 `{ success, data, metadata }` / `{ success:false, error:{code,message,hint,category,severity} }` | 该文件 `:9-16`、`:244-252` |
| F21 | `scripts/ci/check-delivery-baseline.js` 的 `checkSurfaceRatchet`（`:650-677`）数四个数：`ROUTER_COMMANDS` 条目（`:615-623`）、`aliases.js` 的 `command:` 出现数（`:625-631`）、`handlers/` 目录 `.js` 文件数（`:633-639`）、规则登记条数（`:641-648`），超基线报 `delivery-surface-ratchet-breach`（error） | `Select-String` 该文件 |
| F22 | `scripts/ci/check-rollout-stage.js` 存在；`docs/10_规范/registry/FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms[]` 是阶段登记位置，字段含 `id/name/ssot/rules/executor/stage/stageSince/stageAuthority/executorStage/samples/rollback/blockedBy`。`:485-527` 的代码/登记漂移校验**只在 `m.executorStage.file && m.executorStage.constant` 均存在时生效**，缺该字段则「登记说 S1、代码其实在拦」不设防。实测 `rollout.mechanisms.length = 40`，其中 33 个带 `executorStage.file`+`constant`、7 个不带（`tool-challenge-cadence` / `domain-direction-guard` / `functional-unit-guard` / `entry-buffer-guard` / `q1-root-uncatalogued` / `q1-registry-path-dangling` / `q1-floor-closed-set`） | `Test-Path`；`node -e "const j=require('docs/10_规范/registry/FEATURE-OWNERSHIP.json');console.log(j.rollout.mechanisms.length)"`；读该 JSON 的 rollout 段 + `Select-String` 该守卫 |
| F22b | `runtime/node/backend/src/constants/installationCandidates.js` 全文 76 行，导出恰 5 项（`GIT_BASH_CANDIDATES` / `GIT_PORTABLE_CANDIDATES` / `NIRVANA_CACHE_CANDIDATES` / `NIRVANA_STORAGE_CANDIDATES` / `WINDOWS_IDE_INSTALL_PATHS`），`pathJoin` 用 `'\\'`，**无 darwin / linux 分支**；`WINDOWS_IDE_INSTALL_PATHS` 只覆盖 kiro / cursor / trae / warp / vscode 五家 | （校正：`(Get-Content).Count` = 75 行 + 文件尾换行，与 §11 R3 自述的「75 行 + 末行空」是同一事实的两种计法；本行记 76 行） `Get-Content` 该文件（全文） |
| F22c | `utils/flagRegistry/index.js` 已登记 `KHY_INSTALL_LEDGER`（`:1670`）、`KHY_AGENT_LAUNCHERS`（`:2715`）、`KHY_AGENT_ASSETS`（`:2724`），三者同为 `{ mode: 'default-on', off: 'CANON', default: true }`；**无** `KHY_AGENT_HUB`。`services/flagRegistry.js` 是路径兼容壳（`module.exports = require('../utils/flagRegistry')`），不承载逻辑 | `Select-String` 两文件 |
| F22d | `runtime/node/backend/src/constants/commandSchema.js:639-649` 是 `'agent-assets'` 的子命令表（discover / caps / capabilities / list / plan / import / export / sync / help 共 9 词），`hub` 不在其中 | （校正：精确区间为 `:641-651`，`:639-640` 是注释；本行的 `:639-649` 覆盖其绝大部分） `Get-Content` 该行段 |
| F23 | `runtime/node/backend/src/services/domain/agents/` 下已有 7 个单元（advisor / agentAssets / agentFs / agents / agentsight / assistant / autonomy）+ README | `Get-ChildItem` 该目录 |
| F24 | `services/backend` 目录**不存在**；`runtime/node/backend/src` **存在**。`[DESIGN-LAY-005]` 第一节层级表仍写 `services/`，而该文 §1.4b（2026-10-02）另登记 `runtime/` 为 D1 运行时域根——文档与物理布局存在已知漂移，本文一律按物理路径书写 | `Test-Path` 两处；读 DESIGN-LAY-005 `:43` 与 `:443-448` |

### 桌面端与前端

| # | 主张 | 证据 |
|---|---|---|
| F25 | `apps/khyos-desktop/src/renderer/components/settings/SettingsPage.tsx:34-68` 的 `NAV_GROUPS` 有三组，「Agent 能力」组恰有 7 项（memory/subagents/plugins/mcp/skills/commands/hooks），无「智能体」项 | （校正：精确区间为 `:35-69`，本行的 `:34-68` 差 1 行） 该文件对应行 |
| F26 | `apps/khyos-desktop/src/renderer/App.tsx:342-361` 是 hash 路由（`#/key-manager`、`#/settings[/<page>]`、`#/automations`、`#/environments`，四个路由常量），`:41-51` 有四个 lazy 全屏页；**:669（keyManager）/ :683（settings）/ :697（automations）/ :711（environments）** 各有一个早退渲染分支，均包 `ErrorBoundary` + `Suspense fallback={<div style={{ padding: 24 }} />}` + `ToastContainer`；约 `:725` 起是主界面。**行号随工作树漂移，实测以 `Select-String -Pattern 'if \(keyManager\)|if \(settings\)|if \(automations\)|if \(environments\)'` 为准** | `Get-Content` 该文件对应行段 |
| F26b | `apps/khyos-desktop/src/renderer/App.tsx:451` 的 `if (keyManager || settings) return` 是全局快捷键守卫（主界面才接管） | `Select-String` 该行 |
| F27 | `apps/khyos-desktop/src/renderer/components/layout/TitleBar.tsx:135-169` 的自绘 `menuItems` 里有「密钥与端点管理」项（`:140`），其注释记着「自绘窗口菜单才是当前形态下唯一活着的菜单面」 | 该文件对应行 |
| F28 | `apps/khyos-desktop/src/renderer/keyManager/api.ts` 存在，`khyosApi()` 读 `window.__KHYOS__` | 该文件 `:148-151` |
| F29 | `apps/khyos-desktop/src/main/keyManager/ipc.ts` 有约 25 个 `ipc.handle` 通道，命名形如 `keys:` / `providers:` / `cards:` / `agents:` / `health:` | `Select-String` 该文件 |
| F30 | `apps/khyos-desktop/src/main/keyManager/keyStore.ts:769-774` 与 `proxyStatus.ts:126-136` 用 `createRequire` 跨进程载入后端 `gateway/providerPresets.js`；`agentWriters.ts:33-55` 的 `resolveBackendServicesRoot()` 是 4 级降级 | **【未确认】** `keyStore.ts` 侧成立（`:772-774` createRequire + `req(...).getProviderPresets()`）、`agentWriters.ts:33-55` 四级降级成立；但 **`proxyStatus.ts` 侧被证伪**——该文件无 providerPresets 命中，`:135-137` 载入的是 `gateway/proxyServer.js`（非 providerPresets.js）。「两文件都载 providerPresets.js」这半句不成立；主张原样保留。复核见 §13.3 | `Select-String` 三文件；Read `proxyStatus.ts:125-149` |
| F31 | `delivery/web/ai-frontend/src/composables/useRoutePrefetch.js:62` 有 `'/admin/agents': () => import('@/views/admin/AgentDashboard.vue')` | `Select-String` 该文件 |
| F32 | `delivery/web/ai-frontend/src/router/index.js:103-104` 有 `/agents` → redirect `/admin/agents` | `Select-String` 该文件 |
| F33 | `delivery/web/ai-frontend/src/nav/index.js:108-158` 的「管理控制台」组有 **15** 项（`:110-154`：overview / gui-eval / web-frontend-eval / models / channels / bridge / settings-wx / accounts / assets-customers / payments / usage / pricing / monitor / tasks / settings），`requiredRole: ROLE.ADMIN`（`:109`），无 agent-hub 项 | （校正：`requiredRole: ROLE.ADMIN` 实测在 `:110` 而非 `:109`，差 1 行） 该文件对应行 |
| F33b | `delivery/web/ai-frontend/src/router/index.js:507-538`：`ADMIN_NAMESPACE = '/admin'`（`:507`），`isAdminPath()`（`:509-517`）命中 `/admin` 前缀或 `ADMIN_NAV_PATHS` 即判管理路径，`stampAdminMeta()`（`:530-538`）递归盖 `route.meta.requiresAdmin`；路由守卫 `:558-559` 据此弹 `/403`。**NAV 的 `requiredRole` 不参与这一步** | `Select-String` 该文件 |
| F34 | `delivery/web/ai-frontend/src/router/nav.wiring.test.js` 存在（锁 NAV↔router↔viewLoaders 三方不漂移） | `Test-Path` |
| F35 | `delivery/web/ai-frontend/src/views/` 下存在 `Marketplace.vue`、`MyGateway.vue`、`EcoMarkets.vue`、`admin/AgentDashboard.vue`，`src/composables/` 下存在 `useEcoMarkets.js`、`useAgentDashboard.js` | `Test-Path` 逐一 |
| F36 | `delivery/web/ai-frontend/src/api/authedFetch.js` 存在，是「裸 fetch 的统一带认证入口」，token 来自 `useUserStore()` | 该文件 `:1-27` |

### 调研与输入材料

| # | 主张 | 证据 |
|---|---|---|
| F37 | `docs/03_DESIGN_设计/DESIGN-RES/[DESIGN-RES-003] 跨Agent技能MCP统一管理-阶段一调研.md` 存在，`:12` 记「现有一个单点投资：read 方向桥接」，`:13` 记「没有任何『写他人 Agent 配置』的入口」 | 该文件对应行 |
| F38 | 本机 9 类点名智能体的安装状态为：claude-code / opencode / zcode / workbuddy / qoder 已装；command-code / kiro / trae / cursor 未装 | 需求输入「点名智能体画像」字段 `installed`（本轮会话输入材料，**本次未复测**） |
| F39 | 本机扫到的未点名智能体含 MiniMax Code、Y-code、RouterCode、华为 CodeArts Agent/Doer、CodeScope/CodeBaseCLI、Tencent CodeBuddy CLI、OpenAI Codex CLI | **【未确认】** 未复跑目录扫描。复核者仅按猜测路径抽查：`~/.ycode`/`~/.codebuddy`/`~/.codex` True 与清单吻合，但 `~/.minimax-code`/`~/.routercode`/`~/.codebasecli`/`~/.codearts` 在猜测路径下不存在——**布局可能不同或仅为 CLI 痕迹，不能据此证伪**。主张原样保留。复核见 §13.4 | 需求输入「未点名智能体扫描.found」（本轮会话输入材料，**本次未复测**） |
| F40 | 需求五问存证路径为 `works/data/khy/feedback/agent-hub/requirement-5q.md` | 需求输入 `evidencePath` |

### 未运行 / 未验证（如实登记）

| # | 项 | 状态 |
|---|---|---|
| N1 | `npm run check:layout` | **未在本次运行**。盘点员报告其实跑退出码 1，3 条 error 为既有存量（root-shadow-dir / root-junk / layer-registry），与本文只读设计无关；本文落盘并补索引行后需复跑一次确认 `docs-index-complete` 仍为 0 |
| N2 | `npm run check:agent-rules`（`check-agent-rules.js --changed`） | **【未确认】** **未运行到完成**。盘点员先后 3 次启动均在 300s/420s/600s 预算内未结束且无 finding，被主动停止；本文为新增文档、无代码改动，预期无命中，但**不得据此记 PASS**。复核者本次亦未复跑（复跑成本高且对纯文档改动无判定价值），无法直接验证历史运行。复核见 §13.4 |
| N3 | 9 类智能体的安装状态 | **【未确认】** **未在本次复测**。本文引用的是本轮会话输入材料（F38）；其证据链（`where` / `npm ls -g` / 目录列举 / 注册表查询）在输入材料里有逐条记录，但本文作者未重跑。复核者同样只做了文件级抽查（见 F38），未跑五源全探。复核见 §13.4 |
| N4 | 适配器契约、路由契约、页面结构 | **纯设计，未写任何实现代码**，故无编译/测试/类型检查可跑 |
| N5 | `delivery/web/ai-frontend` 的 NAV 接线 | **【未确认】** 设计态。若实施 §5.3，须跑 `npx vitest run src/router/nav.wiring.test.js` 验证三方不漂移；本次未跑。复核者补充事实：`nav.wiring.test.js` 文件存在（F34 已验证），但 `Test-Path delivery/web/ai-frontend/node_modules/vitest` → **False，本机前端未装 vitest，此刻跑 npx 需现拉依赖**。复核见 §13.4 |
| N6 | `npm run check:doc-drift` | **已在本次运行**（第 1 轮修订后）：`node scripts/ci/check-doc-drift.js` 退出码 0，Summary 为 4 + 26 + 106 + 2 条 warning，全为既有存量（impl-status-done-but-missing 4 / superseded-historical 26 / todo-but-missing 106 / missing-in-scope 2）；本文的 `IMPL-STATUS: todo` 落在 todo-but-missing 一类，属规划态文档的正常形态。（校正：复核者复跑得 todo-but-missing **107**、missing-in-scope **3**，各 +1——会话期间又有新文档落盘，属时间性漂移；退出码与「全为既有存量」的性质不变） |
| N7 | `npm run check:no-emoji` | **已在本次运行**（第 1 轮修订后）：`node scripts/ci/check-no-emoji.js` 退出码 0，Summary `0 error(s), 600 warning(s)`（colored-emoji 594 / escaped-emoji 5 / initial-as-avatar 1）——与修订前同一读数，本文未贡献新 finding |
| N8 | `node scripts/ci/check-repo-layout.js --promote=root-whitelist,docs-index-first,layer-registry` | **已在本次会话运行四次**（第 1 轮修订前后、第 2 轮修订后、第 2 轮补索引后各一次），四次均退出码 1。**关键读数 `docs-index-complete`：第 1 轮两轮均 0；第 2 轮修订后一度变 1（超基线、warning 升 error），补一行索引后复跑回到 0**。3 条 error 中 2 条自始一致（`root-shadow-dir` 指向仓库根影子数据目录 `.khyos`、`root-junk` 指向根目录 3 个事故残留文件）；第 3 条 `layer-registry` 的未登记项由 1 个（`-p`）变 2 个（`-p` + `vibe_images`）——**`vibe_images` 不是本文造成的**（`Get-ChildItem` 实测其 CreationTime 为 2026-11-07 17:54:55，会话进行中由本机其他进程创建；本文改动只是 `.md` 文件与索引行，物理上不可能新建根级目录）。同轮 `functional-unit` 272→275、`entry-buffer` 2402→2405、`root-uncatalogued` 7→8 亦为同一环境原因，且前两者仍在基线内（290 / 2470）。**第 2 轮 `docs-index-complete` 0→1 也不是本文造成的**：守卫的点名对象是 `[DESIGN-ARCH-204] 统一开发环境管理器-盘点清单与一键恢复.md`（实测 CreationTime 2026-11-07 19:25:45，本机其他进程新建，未登记就近索引）；本文的 203 行当时已在索引里。已在 `00_INDEX_DESIGN-ARCH-总目录.md` 末尾补一行 204 的索引登记（守卫对任何新文档的强制要求，一行家务；**未代写 204 的核心职责摘要**——本文作者未读过它，不编造），复跑后计数回 0 |
| N9 | `node scripts/ci/check-doc-claims.js --list=endpoint-claim-unsupported` | **已在本次运行两次**。第一次（修订前）输出含 `docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-203] 智能体统一管理.md -> /api/agent-hub`；在文档首行加 `<!-- DOCS-CLAIMS-EXEMPT: … -->` 后第二次复跑，`Select-String 'DESIGN-ARCH-203'` 命中数 **0**（豁免生效，该守卫全量 exit 0）。同类存量仍有若干（[DESIGN-ARCH-192]、[DESIGN-OTHER-006]、[DESIGN-API-003]、[DESIGN-RL-001] 等未豁免文档） |

---

## 11. 修订记录（第 1 轮独立评审）

> 独立评审员对本文提了 14 条意见。逐条复核后**全部接受**（其中 4 条经代码复核后加重了原判定的后果描述）。下表留痕：改了哪、为什么改、依据是读到的还是跑到的。

| # | 评审意见（摘要） | 处置 | 依据 |
|---|---|---|---|
| R1 | **台账写入边界指错（high）**：把 `installLedger.recordSideEffect` 当记账动作，但它是零 IO 纯叶子，真正的落盘是 `ledgerWriter.appendSideEffect。按原文实施会得到「记了台账但磁盘上没有」的假回滚 | **接受并加重**。§0 第 4 条、§4.1 `executor.js` 行、§6.2 的 apply 流程图与台账真源段全部改写：明确「计算层 / 落盘层」两层都要接，只接前者 = 台账只在内存、`computeRollback` 逆序读 jsonl 一条都读不到，而本文同时声明「不另起一份台账」故实施者不会自建写入器——W3 承诺静默失效。新增 F17/F17b 两条可证伪主张 | 读 `installLedger.js:13-17`（自述零 IO）、`ledgerWriter.js:4-9`（自述唯一写入 IO 边界）与 `:55-85`；`Get-ChildItem -Recurse \| Select-String 'appendSideEffect'` 实测 4 个调用方 |
| R2 | **桌面端入口落点表缺渲染分支（medium）**：`App.tsx:663-702` 三个 `if (x) return` 早退分支未列，照表接线后 TitleBar 改 hash 会直落主界面，新页面永不渲染 | **接受**。§5.1 表由五处改六处，新增第 4 行专写 `App.tsx:663-702` 的渲染分支，并写明漏掉的后果；F26 补上三个分支的行段与共用的 ErrorBoundary/Suspense/ToastContainer 形态 | 读 `App.tsx:663-702` |
| R3 | **`installationCandidates.js` 不是三平台（medium）**：全文 76 行、只有 Windows 一面，跨平台发现层会静默只剩 Windows | **接受**。§3.3 路 B 表第 2 行改为完整描述该文件的真实形态（5 个导出、`'\\'` 拼接、无 darwin/linux 分支），并给出两条出路（补 D3 常量 vs `agentHub/discovery.js` 自建）；新增 §9 不做清单第 12 条「本轮不给该文件补跨平台分支」；新增 F22b | 读 `installationCandidates.js` 全文（75 行 + 末行空） |
| R4 | **模型配置写委派目标对 4 家不存在（medium）**：`APPS` 12 项与 externalApps 11 家都无 qoder/workbuddy/kiro/cursor；qodercli 写器只在 Electron 主进程；同表还把 qoder 列进 config 档却漏了有写器的 trae 与 command-code | **接受**。§2.1 新增「覆盖缺口」九行表（逐家列有无后端写器 + 证据 + 处置）；§3.4 tier 表把 qoder/workbuddy/kiro/cursor 改判封顶 `assets`、补入 trae 与 command-code，并要求 UI 对只读家显示明确原因而非可编辑表单；§0 新增第 6 条结论；§9 新增不做清单第 11 条 + 待拍板第 4 条（写腿归谁的三条路）。新增 F17c/F17d | 读 `ccSwitch/constants.js:32-45`（APPS 12 项）、`appWriters.js:12-29`（含 trae 走 switch-center 的注明）、`agentWriters.ts:226-237`（qoder 写 khy 的 .env）、`externalApps/` 目录清单 |
| R5 | **§8 登记 JSON 缺 `executorStage`（medium）**：守卫的代码/登记漂移校验只在该字段存在时生效，缺它则「登记说 S1、代码其实在拦」不设防 | **接受**。JSON 补 `executorStage: {file, constant, note}` 与 `blockedBy: []`，并补一段说明 `:485-527` 的生效条件、以及 `:501-511` 记的「比阻断语义而非字面相等」的坑。F22 同步更正字段清单 | 读 `check-rollout-stage.js:480-527`；`node -e require(FEATURE-OWNERSHIP.json)` 列出全部 mechanism 的 `executorStage` |
| R6 | **用 `cursorAdapter.js` 佐证 cusur→Cursor 误导（low）**：那是网关 AI 适配器，不是 externalApps 配置适配器 | **接受**。§1.1 该行改写：点明 `cursorAdapter.js:2-5` 的自述（「connect to Cursor IDE's AI models. Reads Cursor's auth token」）与「externalApps 11 个适配器里没有 cursor」；§9 待拍板第 2 条同步 | 读 `gateway/adapters/cursorAdapter.js:2-5`；`Get-ChildItem externalApps -Filter '*ursor*'` 返空 |
| R7 | **本文自身会触发 `check-doc-claims` 的 endpoint-claim-unsupported（low）** | **接受（按守卫约定加豁免）**。文档首行加 `<!-- DOCS-CLAIMS-EXEMPT: 本文是尚未实现的设计文档，/api/agent-hub 全族端点均为目标态契约… -->`。**如实登记：豁免后的复跑未做**（N9） | 实跑 `node scripts/ci/check-doc-claims.js --list=endpoint-claim-unsupported` 命中本文；读 `check-doc-claims.js` 的 `EXEMPT_MARK` 正则确认豁免语法 |
| R8 | **「九个并列启动命令」与自列 8 个矛盾（low）** | **接受**。改「八个」并在括号内注明「实测 8 个 case」；F11 同步改为 8 并列出八个名字 | 读 `router.js:2495-2502` |
| R9 | **F33「管理控制台组 14 项」实测 15 项（low）** | **接受**。F33 改 15 并逐项列出；新增 F33b 写清 `requiresAdmin` 的真实机制 | 读 `nav/index.js:105-149` 计数；读 `router/index.js:499-530`、`:550-551` |
| R10 | **F12 行号引用错位（low）**：「11 家适配器同一个六件套」在 `:35` 不在 `:23-24`（后者是测试段） | **接受**。F12 改引 `:35` 并注明 `:23-24` 是测试段 | 读 `externalApps/README.md` 对应行 |
| R11 | **§5.3「requiresAdmin 由 NAV 派生」机制说错（low）**：实际由 `router/index.js:501-530` 的 `isAdminPath` + `stampAdminMeta` 盖 | **接受**。该行改写为两套机制的准确描述，并指出结论碰巧一致（`/admin/agent-hub` 落 `/admin` 前缀下，无需改 `isAdminPath`）；新增 F33b | 读 `router/index.js:499-530`、`:550-551` |
| R12 | **CLI 子命令改动清单不完整（low）**：还需 `commandSchema.js:639-649` 的子命令表、`:466` 报错菜单、`:474-482` manifest、`:409-427` 帮助文本 | **接受**。§4.4 由「只改 switch」扩为五处同步表，并说明少任何一处的后果（新子命令对补全/帮助/命令清单不可见）；另指出 `:410-411` 的「已接入家数」从 `AGENT_ASSET_SOURCES` 推导，`hub` 若展示 agentHub 全量须换推导源。新增 F22d | 读 `commandSchema.js:639-649`、`handlers/agentAssets.js:409-427`、`:433-470`、`:472-483` |
| R13 | **新门控未提 flagRegistry 登记（low）** | **接受**。§4.2 错误码表后补一段：`KHY_AGENT_HUB` 必须登记进 `utils/flagRegistry/index.js`（真身在 D3，`services/flagRegistry.js` 只是壳），兄弟三门的行号与同款 `{mode:'default-on', off:'CANON', default:true}` 形状，并说明漏登记的后果。新增 F22c | `Select-String` 实测 `KHY_INSTALL_LEDGER:1670` / `KHY_AGENT_LAUNCHERS:2715` / `KHY_AGENT_ASSETS:2724`、`KHY_AGENT_HUB` 不在；读 `services/flagRegistry.js:1-5` 确认壳 |
| R14 | **`_sanitizeMeta` 是模块私有、未导出（low）**：实施者无法调用 | **接受**。§6.4 该条改写为「掩码由 `recordSideEffect` 内部完成，调用方无感」，并明确警告不要 require 一个不存在的导出。F17 同步更正 exports 清单 | 读 `installLedger.js:126`（定义）与 `:296-305`（exports 八项） |

**一条未接受的意见**：无。14 条全部接受，其中 R1 / R4 两条在复核后**加重**了原判定的后果描述（R1 从「指错」升为「W3 承诺静默失效」，R4 从「覆盖缺口」升为「与本文自订的『杜绝第二写者』冲突」）。

**本次修订未做的事**（如实登记）：只改文档，未写任何实现代码；未跑 `check:agent-rules`（N2 仍然有效）；未复跑 9 类智能体的安装状态探测（N3 / F38 仍然引用输入材料）。已复跑并记录的守卫：`check:doc-drift`（N6）、`check:no-emoji`（N7）、`check-repo-layout.js`（N8）、`check-doc-claims.js`（N9）。

---

## 12. 修订记录（第 2 轮独立评审）

> 第 2 轮提了 9 条意见。逐条复核后**全部接受**，其中 R1 推翻了第 1 轮的核心架构假设（桌面端走 HTTP），R2/R3 推翻了第 1 轮的台账结论。下表留痕。

| # | 评审意见（摘要） | 处置 | 依据 |
|---|---|---|---|
| R1 | **桌面主表面走 HTTP 会开箱即死（high）**：`authenticateToken` 只认用户 JWT、无回环豁免（`middleware/auth.js:175-199`），而桌面端没有登录态（`App.tsx:149-151`）、从未调过后端 `/api/*`（全量 grep `/api/` 只命中一个外部供应商 URL `keyStore.ts:760`）；其后端集成全是 host 进程内 require（`host/index.ts:120/164/200`）。§4.5 还说 CH-2 的「同一 Node 进程」前提不成立，也被现实反证 | **接受，并推翻第 1 轮的暴露层设计**。§0 第 1 条、§2.1 架构图与通道分工表、§4.3（加作用域提醒）、§4.5（整节重写）、§5.1 第 6 格、§6.3 通道表全部改写：**桌面主表面改走 CH-2 服务层直调**（`main/agentHub/service.ts` 用 `resolveBackendServicesRoot()` + `createRequire` 载 service 模块，零 HTTP、零 token）；**`/api/agent-hub` 只服务 Web 管理台第二表面**。同时承认第 1 轮「Electron 主进程不满足 CH-2 同进程前提」是错的——`host/index.ts:3-4` 文件头明写「host 与 backend 同为 Node 进程语义，用 CH-2 服务直调」并实际 require 六个后端模块，本仓早已做过这个裁定。`serviceDefaults.js` 端口发现在本功能里用不到（桌面不打 HTTP），一并撤销。新增 F17i–F17l | 读 `middleware/auth.js:175-199`；`Select-String App.tsx` 定位无登录注释；`Get-ChildItem -Recurse \| Select-String '/api/'` 全量 grep；读 `host/index.ts:1-20` 与 `:120/164/200/233/264/325` |
| R2 | **W3 的回滚在共享台账上无法表达（medium）**：`_KNOWN_ACTIONS` 只有 6 个词（`:54-61`），没有「从备份恢复」这一形，`computeRollback` 对词表外动作一律 skipped（`:253-256`）；且 `computeRollback` 零 IO，读 jsonl 的 `_readLedgerEntries` 是 D1 handler 私有函数（`cli/handlers/uninstall.js:299-323`），D2 去 require D1 会新增 cross-layer-require 边 | **接受**。§6.2 的 apply/rollback 流程图改写为**两类回滚**：A 类「改别家 live 配置」= 从 `backups/<planId>/` 原子写回；B 类「装卸程序本体」= agentHub 自己的 `ledger.jsonl`（计算仍复用 `recordSideEffect`/`computeRollback`，落盘用自己的 append）。§4.1 `executor.js` 行、§4.2 的 rollback 端点（`{ ledgerSeq }` → `{ backupId }`，新增 `AGENT_HUB_NO_BACKUP` 错误码）、§6.1 W3 行同步改。**R1 第 1 轮的诊断（零 IO 叶子不能当落盘用）作为通用教训保留**，但「必须同时接 `ledgerWriter.appendSideEffect`」那条结论随本设计不再写共享台账而失效。新增 F17e/F17f | 读 `installLedger.js:44-67`、`:249-256`；读 `cli/handlers/uninstall.js:299-323`、`:352-398`、`:401-410`、`:691` |
| R3 | **共写一份 `.install-ledger.jsonl` 会串台（medium）**：唯一读者 `khy uninstall` 读全文件把每条当 khy 自己的副作用回滚，而 meta 白名单（`:67`）记不下「属于哪个 agent」、`computeRollback` 按 target 全局去重（`:249-251`）——agentHub 记进去就会被 khy 卸载时删掉别家配置；反向也无法按 `:id` 取子集 | **接受，并修正第 1 轮「不另起一份 agent-hub 台账」的结论**。§6.2 新增「为什么 B 类也不写共享台账」段：正确判据不是「几份台账」而是「**读者是否同一批**」——共享台账读者是 `khy uninstall`（管 khy 自己的安装副作用），agentHub 台账读者是 agentHub（管对外部智能体的程序装卸）；读者不同、meta Schema 不同、回滚动词表不同，**合并才会串台**。故 agentHub 台账是**作用域隔离**而非重复造账。新增 F17e/F17f | 读 `installLedger.js:67`、`:249-251`；读 `cli/handlers/uninstall.js:401-410` → `:352-398` |
| R4 | **MCP 写腿立论已过期且与新契约自相矛盾（medium）**：`claudeCode.js:405-428` 今天就能把 mcp_server 写进别家配置，`[DESIGN-RES-003]:13` 之后这条腿已落地；§3.1 同时列 `listMcpServers`/`writeMcpServer` 与「复用 agentAssets 契约」正是它自己禁止的第二契约 | **接受**。§1.2 末段改写为「MCP 写腿今天已由 `agentAssets` 的 `tool` 类资产承载，本功能只做发现与呈现」；§3.1 契约**删掉** `listMcpServers` / `writeMcpServer` 两个方法，改为 `listAssets(kind, env)` / `writeAsset(kind, asset, opts)` 并注明「MCP 即 `kind='tool'` 的 `mcp_server`」；§4.2 补一段说明 `/mcp` 端点是视图不是契约。新增 F17g | 读 `claudeCode.js:379-428`；读 `opencode.js:337-364`；重读 `[DESIGN-RES-003]:12-13` |
| R5 | **双写者审计漏掉 claude-code/opencode（medium）**：`agentWriters.ts:191-224` 直写 `~/.claude/settings.json` 与 `~/.config/opencode/opencode.json`，与后端 `externalApps` + `ccSwitch/appWriters.js:13/17` 写同一批文件；§2.1 只问「后端有没有写器」就把这 5 家一律判 tier config | **接受**。§2.1 的覆盖缺口由「一个缺口」改为「两个缺口」，新增**缺口二：已存在双写者的 2 家**（逐家列写者 A / 写者 B / 是否同一文件），并给出三条处置（UI 显式标注另有 KeyManager 也在写此文件、`overview` 返回 mtime 与最近写入来源、列入不做清单与待拍板）。§6.2 的 `risks[]` 补「双写者风险」；§0 第 6 条同步。新增 F17h | 读 `agentWriters.ts:75-91`（`agentTargetPath`）、`:191-224`；读 `ccSwitch/appWriters.js:12-29` |
| R6 | **「第四处必改点」的依据是虚构的（medium）**：全仓没有 `agentModel` 模块也没有 `agentModel.isEnabled`；`isFlagEnabled` 对未登记 flag 的真实行为是「缺值 → 默认开、显式值按 CANON off-words 解析」，并非文档说的「静默走本地兜底」 | **接受**。§4.2 该段重写：删掉虚构的模块名与错误后果，改为如实描述 `isFlagEnabled` 的真实分支，并把「必须登记」的理由改为三条真实代价（脱离父子优先级、脱离 `khy capability` 集中内省、将来 flag 审计会漏）。结论仍成立。新增 F17m | `Get-ChildItem 'runtime/node/backend/src' -Recurse -Include '*.js' \| Select-String 'agentModel'`（命中全是注释与无关模块）；读 `isFlagEnabled` 函数体 |
| R7 | **mechanism 数是 40 不是 47（low）**：实测 `rollout.mechanisms.length = 40`，33 个带 `executorStage.file`+`constant`、7 个不带（并列出 7 个 id）；「绝大多数都带」仍成立，但 §10 自称逐条可证伪 | **接受**。§8 与 §10 F22 的数字改为 40 / 33 / 7 并列出 7 个漏网 id，复核命令写进 F22；§11 R5 行同步去掉 47 | `node -e "const j=require('docs/10_规范/registry/FEATURE-OWNERSHIP.json');console.log(j.rollout.mechanisms.length)"` 及逐条过滤 |
| R8 | **多处行号引用相对当前工作树漂移 1–2 行（low）**：`App.tsx` 三个渲染分支实测在 `:665/:679/:693`、主界面 `:707`、快捷键守卫 `:447`；`commandSchema.js` 子命令表 `:641-651`；`useRoutePrefetch.js` `:62`；`nav/index.js` 组 `:108-158`；`router/index.js` `isAdminPath` `:509`、守卫 `:559`。结构与条数逐条核过均正确，漂移的只是行号 | **接受**。§4.4 表、§5.1 表 #2/#3/#4、§5.3 表 #1、§10 F26/F26b/F31/F33/F33b/F22d 全部更新为实测行号；并在 §4.4 与 §5.1 各加一条「行号说明」：这些文件均有未提交改动（`git status --porcelain` 全为 `M`），**落笔前以 `Select-String` 现场定位为准，不要照抄行号**。另发现**工作树新增了第四个全屏页 `EnvironmentsPage`**（`App.tsx:51/361/711`），接线表由「三个分支」改「四个分支」，F26 同步 | `Select-String` 逐文件定位；`Get-ChildItem -Filter '*.md'` 与 `Group-Object` 计数 |
| R9 | **索引第 5 行「收录 194 篇」失真且无守卫发现（low）**：实测该目录 196 篇正文（本文实测 197 个 `.md` = 1 索引 + 196 正文），203 的索引行已加在 `:212`，而 `docs-index-complete`（`:630-641`）只比对文件名不校验声明计数 | **接受**。F2 改写为实测值并注明差 2、无守卫覆盖；新增 F2b：**本文未顺手改掉该计数**——它是会再次漂移的手工数（本会话进行中该目录 .md 数就在变），改一个数不等于修好机制，是否保留手计数还是改为动态推导属维护者决策 | `Get-ChildItem -Filter '*.md' \| Group-Object` 分组计数；读 `check-repo-layout.js:630-641` |

**一条未接受的意见**：无。9 条全部接受；其中 R1 / R2 / R3 三条各自推翻了第 1 轮的对应结论（暴露层走 HTTP、台账「两层都要接」、台账「不另起一份」），已在正文就地改写而非打补丁，并在 §0 结论先行里同步。

**第 2 轮修订未做的事**（如实登记）：只改文档，未写任何实现代码；未跑 `check:agent-rules`（N2 仍有效）；未复跑 9 类智能体安装状态探测（N3 / F38 仍引用输入材料）；未读过 `[DESIGN-ARCH-204]` 正文（只按守卫要求补了它的索引行，未代写摘要）。**第 2 轮改动后已复跑的守卫**：`check-repo-layout.js`（N8，四次）。**未在第 2 轮复跑**（第 1 轮的读数对纯文档改写仍有效，但非最新）：`check:doc-drift`（N6）、`check:no-emoji`（N7）、`check-doc-claims.js`（N9）。

---

## 13. 复核记录（事实主张清单的独立复核）

> §10 自称「逐条可证伪」，本节是第三方按该清单自带复核方式的**逐条复核结果**。裁定三值：`verified`（实测成立）/ `unconfirmed`（未验证或已被现实证伪，**主张在正文保留并标注「未确认」，不删除**）/ 其余。复核者复跑的守卫读数一并记入，与 N1–N9 对照。
>
> **汇总**：60 条主张 + 9 条守卫登记中，**verified 50 条、unconfirmed 8 条、另有 2 条 verified 但附计数/行号校正**（F17e 的「4 项」实为 5 项、F30 的半数被证伪、N6 的两个计数各 +1）。
>
> **8 条未确认**：F1（设计时前提已被现实证伪）、F5（`_adapterBase.js` 目录归属写错）、F17e（`_META_ALLOW` 计数错）、F30（半数被证伪）、F39（未复跑扫描）、N2 / N3 / N5（均未复跑）。

### 13.1 编号与索引（F1–F3、F2b）

| # | 主张 | 裁定 | 证据 / 复核命令 |
|---|---|---|---|
| F1 | 203 是下一个可用编号（最大已用 202） | **unconfirmed** | 按文档自带说明执行 `Get-ChildItem 'docs/03_DESIGN_设计/DESIGN-ARCH/' -Filter '*203*'` → 命中 `[DESIGN-ARCH-203] 智能体统一管理.md`（本文自身，已落盘）；`-Filter '*202*'` 命中 202 篇；再按 `DESIGN-ARCH-(20[4-9]\|2[1-9][0-9])` 过滤 → 另命中 `[DESIGN-ARCH-204] 统一开发环境管理器-盘点清单与一键恢复.md`（LastWriteTime 2026/11/7 19:25:45）。**该主张是设计时前提，当前已被现实证伪**——203 文件存在、最大已用编号已是 204 而非 202。属「已失真」而非「未验证」 |
| F2 | 索引第 5 行自述「收录 194 篇」；实测 197 个 .md（1 索引 + 196 正文）差 2；`docs-index-complete`（`:630-641`）只比对文件名；两个 doc-index 脚本的 `INDEX_FILE` 都只指向主索引 | verified | Read 索引第 5 行 = 「> 收录 194 篇。」；`Get-ChildItem … -Filter '*.md'` 计数 197，其中 `-notlike '00_INDEX*'` 为 196、索引 1；`Select-String` 两脚本 → `fix-doc-index.js:12` 与 `auto-fix-doc-index.js:12` 的 `INDEX_FILE = path.join(ROOT,'docs','00_INDEX_文档索引.md')`；Read `check-repo-layout.js:630-647` → 循环只做 `text.includes(name)` / `docDir.index.includes(name)`，计数在 `:647`，无声明值校验 |
| F2b | 本文未顺手改掉该失真计数 | verified | 复读索引第 5 行仍为「收录 194 篇。」，与实测 197 的差仍在；§9 不做清单第 16 条明确记录「不改成动态推导」的决策留痕 |
| F3 | 需手工往就近索引追加一行，否则 `docs-index-complete`（基线 0）超基线把 warning 升为 error | verified | `Select-String` 索引 → 第 212 行已存在 203 的登记行；实跑 `npm run check:layout`（`package.json` 该入口 = `node scripts/ci/check-repo-layout.js`）：退出码 1，`docs-index-complete:0`，baseline 同为 0，3 条 error 为 root-shadow-dir / root-junk / layer-registry（既有存量）——索引行已在、计数 0，主张的机制与现状均属实 |

### 13.2 仓内结构与职责（F4–F24）

| # | 主张 | 裁定 | 证据 / 复核命令 |
|---|---|---|---|
| F4 | `agentAssets/registry.js` 的 `AGENT_ASSET_SOURCES` 冻结表恰有 6 条 | verified | Read `registry.js:27-34` → `Object.freeze([...])` 恰 6 条，id 与顺序与主张逐字一致 |
| F5 | `adapters/` 下有 6 个适配器 + `_adapterBase.js` + `khy.module.json` | **unconfirmed** | `Get-ChildItem .../agentAssets/adapters/` → 6 个适配器 + `khy.module.json` + README + 6 个 `*.test.js`，**确无 `_adapterBase.js`**；`Get-ChildItem -Recurse -Filter '_adapterBase*'` → 该文件在上一级 `agentAssets/_adapterBase.js`。故「6 适配器 + khy.module.json」属实，但 **`_adapterBase.js` 的目录归属写错**（不在 `adapters/` 下） |
| F6 | `agentAssets.js` 头注释列 7 个子命令并写明默认干跑必须 `--apply` | verified | Read `:10-20` → `:10-16` 逐行列 7 个；`:18-20` 「干跑优先:import/export/sync **默认只出计划不落盘**,必须显式 `--apply`（或 `--no-dry-run`）才真正写入」 |
| F7 | `probeRoot` 回报「已查找 N 处目录」并区分未设环境变量与找过的目录 | verified | Read `_adapterBase.js:56-107` → `:96-106` 把 `checked` 分成 dirs 与 unsetVars，文案 `未检测到该工具的资产目录。已查找 ${dirs.length} 处目录:…` + `可用环境变量 … 显式指定资产根`（文件实际在 `agentAssets/` 而非 `adapters/`） |
| F8 | `assetModel.js` 的 `ASSET_KINDS` 三类 + REDACTED 机制 | verified | `Select-String` → `:35` `const ASSET_KINDS = Object.freeze(['memory', 'tool', 'skill']);`；`:14-20` 「IR 绝不承载凭据明文…」；`:44` `const REDACTED = '__KHY_REDACTED__';` |
| F9 | `sync.js` 四条不可协商行为 + `DEFAULT_IDLE_TIMEOUT_MS = 60_000` | verified | Read `:16-24` → 四条逐条对上；`:41-42` `const DEFAULT_IDLE_TIMEOUT_MS = 60 * 1000;`；`:78-86` `formatProgress` 产出「动作 + 目标 + 进度」 |
| F10 | `AGENT_LAUNCHERS` 8 条 / `LEGACY_LAUNCHER_COMMANDS` 5 条 / 门控默认开 | verified | Read `:53-63` 恰 8 条且命令名逐项一致；`:44` 5 条；`:28-30` 「Gate KHY_AGENT_LAUNCHERS (default on)」 |
| F11 | `router.js:2495-2502` 有 8 个并列 per-agent case | verified | Read `:2488-2502` → `:2495-2502` 依次 8 个 case，行号与名字完全吻合（注：`case 'vscode': {` 带花括号，纯正则 grep 易漏，已直读原文确认） |
| F12 | `externalApps/` 11 个 `*Adapter.js` + `_shared.js` + `appModelImporter.js` + `tomlLite*`；`README.md:35` 自述六件套 | verified | `Get-ChildItem` → 11 个 `*Adapter.js`（名字一致）+ 其余文件 + `khy.module.json` + README；Read `README.md:35` → 「**11 家适配器同一个六件套**：configPath / list / get / add / remove / usable」 |
| F13 | `README.md:40-42` 两个成员破坏 env 注入；`:54-59` 登记 11 条缺陷且属人的裁决 | verified | Read `:40-42` → 「两个成员破坏了这条（`traeAppAdapter._readStore` 丢参数、`opencodeAdapter` 的便携根候选不看 env）」；`:54-59` → 「11 条实测缺陷登记在 … `contract.registered_defects`（编号 B30-S1…S11）…**修法涉及改 D1/D2 源码与删改跟踪文件，属人的裁决**」 |
| F14 | `ecoMarkets.js` GET-only、文件头三要素 | verified | Read `:3-17` → 三要素俱全；`Select-String 'router\.(get\|post\|put\|delete\|patch)'` 仅 `:57` 与 `:63` 两个 `router.get`，确无写方法 |
| F15 | eco-markets 挂载三处一套（`:368-378` / `:2393-2395` / `:3775`） | verified | `Select-String` → `:368` `function getEcoMarketsApp()`（`:376` 挂载行）；`:2393-2394` 分发分支；`:3775` `getEcoMarketsApp,`（`__test__` 导出，`:3772-3773` 注释「401-not-404 guard」） |
| F16 | `marketInstallService.js` 头注释「only dispatches」 | verified | Read `:3-12` → 「…a second writer would drift. This module only dispatches: skills go through skillInstallService, MCP servers through mcpConfigStore…」 |
| F17 | `installLedger.js` 零 IO 纯叶子、三个函数行号、门控行号、`_sanitizeMeta` 私有；`ledgerWriter.js:4-9` 唯一 IO 边界、`appendSideEffect` `:55-85` | verified | `Select-String` installLedger.js → `:13` 零 IO、`:20`/`:291` 真 key 不落台账、`:162`/`:222`/`:282` 三函数、`:126` `_sanitizeMeta`；Read `:296-305` exports 恰 8 项无 `_sanitizeMeta`；Read `ledgerWriter.js:4` + `:55-85`（`:80` `fs.appendFileSync`）；`flagRegistry/index.js:1670` 门控行 |
| F17b | `appendSideEffect` 现有调用方恰四处 | verified | `Get-ChildItem -Recurse -Include '*.js' \| Select-String 'appendSideEffect'` → 非测试调用点恰 4 处（`mdEditorRegister.js:51`、`payloadProvisioner.js:163`、`runtimeProvisioner.js:336`、`resourceManager.js:142`），其余为自身 `:55`/`:88`、各 `.test.js` 与注释 |
| F17c | `ccSwitch/constants.js:32-45` 的 `APPS` 恰 12 项，无 qoder/workbuddy/kiro/cursor | verified | Read `:32-45` → 恰 12 项、顺序一致，四家均不在 |
| F17d | `agentWriters.ts` qoder 写 khy 自己的 `.env`；`:5-6` 自述 P1 三家 | verified | Read `:5-6` → 「P1 scope: … claude-code / opencode / qodercli」；`:226-239` `case 'qodercli':` → `:230` agentTargetPath、`:232-235` `patchEnvFile(file, { KHY_QODER_PROXY: 'true', QODER_PROXY_ENDPOINT: … })`，`:227-229` 注释明说 gateway-side .env patch（case 块实到 `:239`，主张的 `:226-237` 覆盖其主体） |
| F17e | `_KNOWN_ACTIONS` 6 词；词表外 skipped；`_META_ALLOW` **恰有 4 项**；按 target 全局去重 | **unconfirmed** | `_KNOWN_ACTIONS` 6 词 ✓、`:249-251` 按 target 去重 ✓、`:253-256` 词表外 `skipped.push({reason:'unknown-action'})` ✓。但 `:67` 实测 `const _META_ALLOW = new Set(['scope','platform','package','label','reason'])` 为 **5 项**，与「恰有 4 项」不符——主张自己的括号里也列了 5 个名字，属**文档内部计数错误**（正文已按实测改为 5 项并保留未确认标注） |
| F17f | 共享台账唯一读者是 `khy uninstall`，`_readLedgerEntries` 是 D1 私有函数 | verified | `Select-String` `cli/handlers/uninstall.js` → `:400` 注释、`:401` `_rollbackLedger`、`:402` require 纯叶子、`:403` `_readLedgerEntries(env)`；`:299` 定义；`:352` `_executeRollbackStep`；`:691` exports 列表中才有 `_readLedgerEntries` |
| F17g | `claudeCode.js:405-428` 合并 mcpServers 并 restoreRedacted；`:406-412` 拒绝非 mcp_server；`opencode.js:337-364` 同 | verified | Read `claudeCode.js:405-428` → `:419` `M.restoreRedacted(merged, existing, a.source.redactedFields)`、`:427` reason「凭据字段沿用目标侧现值」；Read `opencode.js:337-366` → `:337` writeAsset、`:360-366` 非 mcp_server 拒绝 |
| F17h | claude-code / opencode 今天就有两个活着的写者写同一批文件 | verified | Read `agentWriters.ts:191-205`（`:193` backupLive、`:198-200` env.ANTHROPIC_*、`:202` writeJsonAtomic）与 `:207-224`（`:209` backupLive、`:213-218` provider.khy、`:220` doc.model、`:221` writeJsonAtomic）；`:75-78`/`:79-91` agentTargetPath 两个目标路径；Read `ccSwitch/appWriters.js:13`/`:17` 两个 live 配置路径 |
| F17i | `auth.js:175-199` 只认 JWT、无回环豁免 | verified | Read `:175-199` → `:176` extractBearerToken、`:178-183` 无 token 401、`:186` authenticateAccessToken、`:193-197` catch 401；全段无任何 loopback/127.0.0.1 豁免分支 |
| F17j | 桌面 src 全量 grep `/api/` 只命中一处且是外部供应商 URL | verified | `Get-ChildItem 'apps/khyos-desktop/src' -Recurse -Include '*.ts','*.tsx' \| Select-String '/api/'` → 恰 1 条：`keyManager/keyStore.ts:760` `https://openrouter.ai/api/v1` |
| F17k | `App.tsx:149-151` 自述无登录态 | verified | `Select-String -Pattern 'no login\|LoginPage'` → `:149`/`:151` 两行原文 |
| F17l | `host/index.ts:3-4` 明写 CH-2 + 六处 createRequire | verified | Read `:1-10` → `:3-4` 原文 ✓；`Select-String 'nodeRequire'` → 实际用法 `:62`（定义）、`:122`、`:166`、`:202`、`:235`、`:266`、`:327` 共 6 处载入——**主张行号 120/164/200/233/264/325 各漂移 2 行**，与 §12 R8 自述的「行号随工作树漂移 1–2 行」一致，实质成立 |
| F17m | 无 `agentModel` 模块；`isFlagEnabled` 对未登记 flag 的真实行为 | verified | `Get-ChildItem -Recurse -Include '*.js' \| Select-String 'agentModel'` → 命中仅 guiEval 的 `agent_model` 字段、orchestrator 注释、`agentModelProjection.js`、`subAgentModelSelect.js`、flagRegistry 注释，无该模块；Read `utils/flagRegistry/index.js` 未登记分支 → 空值 `return true`，否则 `return !OFF_WORDS.CANON.includes(...)`，逐字一致 |
| F17n | `commandSchema.js:641` 是 `'agent-assets': [` 起始行，共 9 词无 hub | verified | Read `:639-651` → `:641` 起始、`:642-650` 九词、`:651` `]`，hub 不在表内 |
| F18 | `mcpEcosystemRegistry.js:299-300` warp/trae 不猜路径 | verified | `Select-String` → `:299`/`:300` 两行原文 |
| F19 | `serviceDefaults.js` 端口真源 + `ai_manage_runtime.json` 发现 | verified | `Select-String` → `:50` `AI_BACKEND_DEFAULT_PORT = parseInt(process.env.KHY_DAEMON_PORT \|\| '9090', 10)`、`:51` URL、`:64-65` 两处路径、`:71-73` apiPort 解析 |
| F20 | `apiResponse.js` 信封形状 + success/fail 导出 | verified | Read `:9-16` 信封定义；`Select-String` → `:63` success、`:193` fail；Read `:244-255` exports 含 success（`:246`）与 fail（`:252`） |
| F21 | `checkSurfaceRatchet` 数四个数 + 超基线 error | verified | Read `:614-677` → `:615`/`:625`/`:633`/`:641` 四个计数函数、`:650` checkSurfaceRatchet、`:664` `measured > cfg.baseline`、`:666-673` `add('error','delivery-surface-ratchet-breach',…)` |
| F22 | `check-rollout-stage.js` 存在 + 字段清单 + `:485-527` 生效条件 + 40/33/7 | verified | `Test-Path` → True；Read `:484-527` → `:486` `if (auth && auth.file && auth.constant)`、`:501-511` 「比的是阻断语义而非字面相等」；跑 node 读 JSON：total=40、with=33、without=7，7 个 id 逐字一致；样例 mechanism keys 与 `executorStage={file: scripts/ci/check-agent-feedback.js, constant: STAGE}` |
| F22b | `installationCandidates.js` 76 行、导出 5 项、`'\\'` 拼接、无 darwin/linux、五家 | verified | `(Get-Content).Count` = 75 行 + 文件尾换行（**§11 R3 自述「75 行 + 末行空」，F22b 记 76 行，属同一事实的两种计法**）；Read 全文 → `:69-75` exports 恰 5 项、`:65-67` pathJoin、grep darwin/linux 零命中、`:27-41` 五键 |
| F22c | 三个兄弟门在册 + `KHY_AGENT_HUB` 不在 + `services/flagRegistry.js` 是壳 | verified | `Select-String` → `:1670`/`:2715`/`:2724` 三行均 `{ mode: 'default-on', off: 'CANON', default: true }`，`KHY_AGENT_HUB` 零命中；Read `services/flagRegistry.js:1-5` → 壳 + `module.exports = require('../utils/flagRegistry')` |
| F22d | `commandSchema.js:639-649` 是 agent-assets 子命令表，9 词无 hub | verified | Read `:639-651` → `:639-640` 为注释、`:641` 起始、`:642-650` 九词、`:651` `]`；hub 不在（**精确区间为 `:641-651`，主张的 `:639-649` 覆盖其绝大部分**） |
| F23 | `services/domain/agents/` 下 7 个单元 + README | verified | `Get-ChildItem` → advisor / agentAssets / agentFs / agents / agentsight / assistant / autonomy 共 7 目录 + README.md / README.html |
| F24 | `services/backend` 不存在、`runtime/node/backend/src` 存在、DESIGN-LAY-005 双处记载 | verified | `Test-Path` 两处 services/backend 均 False、runtime/node/backend/src True；Read DESIGN-LAY-005 `:43` L2 行写 `services/`、`:37` 「目录名刻意不改（services/backend 被 832 个文件引用…）」、`:443-448` §1.4b 列 `runtime/` = D1 |

### 13.3 桌面端与前端（F25–F36）

| # | 主张 | 裁定 | 证据 / 复核命令 |
|---|---|---|---|
| F25 | `SettingsPage.tsx:34-68` 三组，「Agent 能力」恰 7 项无「智能体」 | verified | Read `:35-69` → 三组 basic/agent/data；agent 组 `:51-59` 恰 7 项，无「智能体」（**精确区间 `:35-69`，主张 `:34-68` 差 1 行**） |
| F26 | `App.tsx` 四个路由常量、四个 lazy 页、四个早退分支、主界面约 `:725` | verified | Read `:346-353` 路由解析、`:354`/`:359`/`:360`/`:361` 四常量；`:42`/`:45`/`:48`/`:51` 四个 lazy 页；`Select-String` → `:669`/`:683`/`:697`/`:711` 四个分支，行号与主张完全一致；Read `:669-730` → 四分支均为 ErrorBoundary + Suspense + ToastContainer，`:724` 注释「主界面」、`:725` `return (` |
| F26b | `App.tsx:451` 快捷键守卫 | verified | `Select-String -Pattern 'keyManager \|\| settings'` → `:451` `if (keyManager \|\| settings) return` |
| F27 | `TitleBar.tsx:135-169` 菜单含「密钥与端点管理」（`:140`）+ 注释 | verified | `Select-String` → `:135` `const menuItems`、`:139` 注释「自绘窗口菜单才是当前形态下唯一活着的菜单面。」、`:140` 该项 |
| F28 | `renderer/keyManager/api.ts` 存在，`khyosApi()` 读 `__KHYOS__` | verified | `Test-Path` True；`Select-String` → `:148` `khyosApi()`、`:150` `return (window as any).__KHYOS__` |
| F29 | `keyManager/ipc.ts` 约 25 个 `ipc.handle` | verified | `Select-String 'ipc\.handle'` → 恰 25 条，命名形如 keys:/providers:/endpoints:/models:/cards:/agents:/proxy:/health: |
| F30 | `keyStore.ts:769-774` 与 `proxyStatus.ts:126-136` 都用 createRequire 载 `gateway/providerPresets.js` | **unconfirmed** | keyStore.ts 侧成立：`:772-774` createRequire + `req(path.join(root,'gateway/providerPresets.js')).getProviderPresets()`。**proxyStatus.ts 侧不成立**：`Select-String` 该文件无 providerPresets 命中，Read `:125-149` 实为 `startProxy()`，`:135-137` 载入的是 `gateway/proxyServer.js`（非 providerPresets.js）。agentWriters.ts:33-55 四级降级 ✓。**故「两文件都载 providerPresets.js」这半句被证伪**（正文已改为如实描述并保留未确认标注） |
| F31 | `useRoutePrefetch.js:62` 的 importer | verified | `Select-String` → `:62` 原文逐字一致 |
| F32 | `router/index.js:103-104` `/agents` → redirect | verified | `Select-String` → `:103` `path: '/agents',`、`:104` `redirect: '/admin/agents',` |
| F33 | `nav/index.js:108-158` 管理控制台组 15 项，`requiredRole: ROLE.ADMIN`（`:109`），无 agent-hub | verified | Read `:108-158` → `:109` label「管理控制台」、**:110** `requiredRole: ROLE.ADMIN`（**主张记 `:109`，实为 `:110`，差 1 行**）；`:112-156` 逐条数出 15 项且路径一致；无 `/admin/agent-hub` |
| F33b | `router/index.js:507-538` ADMIN_NAMESPACE / isAdminPath / stampAdminMeta + 守卫 `:558-559` | verified | Read `:503-538` → `:503-505` ADMIN_NAV_PATHS 由 NAV 派生、`:507` `const ADMIN_NAMESPACE = '/admin';`、`:509-517` isAdminPath、`:530-536` stampAdminMeta（`:535` 递归）、`:538` routes.forEach；`:558-559` 守卫 |
| F34 | `nav.wiring.test.js` 存在 | verified | `Test-Path` → True |
| F35 | 四个 view + 两个 composable 存在 | verified | 逐一 `Test-Path`（`delivery/web/ai-frontend/src/` 下）全部 True |
| F36 | `authedFetch.js` 是统一带认证入口，token 来自 `useUserStore()` | verified | Read `:1-27` → `:1` 「authedFetch — 裸 fetch 的统一带认证入口。」、`:16` import、`:21-27` readToken() → `useUserStore().token` |

### 13.4 调研、本机状态与守卫登记（F37–F40、N1–N9）

| # | 主张 | 裁定 | 证据 / 复核命令 |
|---|---|---|---|
| F37 | `[DESIGN-RES-003]` 存在，`:12` 单点投资、`:13` 写腿缺失 | verified | Read `:12`/`:13` 两行原文（注意：PowerShell 的 `Test-Path` 会把路径里的 `[]` 当通配符而误报不存在，已用 Read 直读确认文件在） |
| F38 | 9 类点名智能体安装状态 | verified | 做了**文件级抽查（非文档所述五源全探）**：`Test-Path` → `D:\Portable\bin\claude.exe`/`opencode.cmd`/`~/.zcode`/`~/.workbuddy`/`~/.qoder` 均 True（5 家已装，与 §1.3 安装形态描述一致）；`~/.kiro`/`~/.cursor` False（2 家未装）；`~/.commandcode`/`~/.trae`/`%APPDATA%\Trae` True（数据残留，与「未装但数据仍在」一致）。**抽查 corroborates 该表，但未复跑 where / npm ls -g / 注册表五源交叉** |
| F39 | 本机扫到的未点名智能体七家 | **unconfirmed** | 未复跑目录扫描。仅按猜测路径 `Test-Path` 抽查：`~/.ycode`/`~/.codebuddy`/`~/.codex` True 与清单吻合；`~/.minimax-code`/`~/.routercode`/`~/.codebasecli`/`~/.codearts` 在猜测路径下不存在（布局可能不同或仅为 CLI 痕迹，**不能据此证伪**）。该主张源自本轮会话输入材料，本文档自身也登记为「本次未复测」（N3） |
| F40 | 需求五问存证路径 | verified | `Test-Path works/data/khy/feedback/agent-hub/requirement-5q.md` → True；该目录仅此一个文件 |
| N1 | `check:layout` 未在作者本次运行；盘点员报退出码 1、3 条 error 为既有存量 | verified | 实跑 `npm run check:layout`：退出码 1，3 条 error 的 id 恰为 root-shadow-dir / root-junk / layer-registry，`docs-index-complete:0`。与所引读数一致；**「落盘后需复跑确认 docs-index-complete 仍为 0」这项要求现已满足** |
| N2 | `check:agent-rules` 未运行到完成（3 次均在预算内被停） | **unconfirmed** | 本次未复跑该守卫（文档自述 300s/420s/600s 三次均未跑完，复跑成本高且对纯文档改动无判定价值）。「未运行到完成」是对作者会话的事实登记，复核者无法直接验证历史运行，仅照实登记为未复跑 |
| N3 | 9 类安装状态未在本次复测（引用 F38） | **unconfirmed** | 未做五源全探；仅对 F38 做了文件级抽查（见 F38 条目）。文档此项登记与复核者处置一致：同样没有重跑完整探测链 |
| N4 | 纯设计态，所有新增落点均不存在 | verified | 逐一 `Test-Path` → `agentHub/` service 目录、`routes/agentHub.js`、`main/agentHub/`、`renderer/components/agentHub/`、`views/admin/AgentHub.vue` **全部 False**，纯设计态属实 |
| N5 | Web NAV 接线为设计态；须跑 `npx vitest run src/router/nav.wiring.test.js`，本次未跑 | **unconfirmed** | 未跑该测试。补充事实：`nav.wiring.test.js` 文件存在（F34 已验证），但 `Test-Path delivery/web/ai-frontend/node_modules/vitest` → **False，本机前端未装 vitest，此刻跑 npx 需现拉依赖** |
| N6 | `check:doc-drift` 退出码 0，4+26+106+2 条 warning 全为既有存量 | verified | 实跑 `node scripts/ci/check-doc-drift.js`：退出码 0 ✓；四类 warning 复现为 done-but-missing 4、superseded-historical 26、todo-but-missing **107**、missing-in-scope **3**。**退出码与「全为既有存量」的性质成立，但后两个计数比文档登记的 106/2 各 +1**（会话期间又有新文档落盘，属时间性漂移，非文档错误陈述） |
| N7 | `check:no-emoji` 退出码 0，600 warning | verified | 实跑 `node scripts/ci/check-no-emoji.js`：退出码 0，输出 `Summary: 0 error(s), 600 warning(s).`——与登记读数逐字一致 |
| N8 | `check-repo-layout.js` 四次运行、`docs-index-complete` 补索引后回 0、3 条 error 归属 | verified | 以相同命令**复跑一次**：退出码 1、`docs-index-complete:0`、3 条 error 与 detail 完全对上（root-shadow-dir 点名 `.khyos`；root-junk 列 `-p` / `getProjectInstructionsSection(cwd)` / `{try{return`；layer-registry 列 `-p, vibe_images`）。`Get-Item vibe_images` → CreationTime 2026/11/7 17:54:55（与文档记载一致）、LastWriteTime 19:50:11（仍在被其他进程写）。functional-unit 272（基线 290）、entry-buffer 2404（基线 2470）、root-uncatalogued 9 均未超基线。**注：复核者只跑了 1 次而非文档说的 4 次，无法验证历史次数，仅验证当前读数** |
| N9 | `check-doc-claims.js` 两次运行；加豁免后 203 命中 0、全量 exit 0 | verified | 实跑 `node scripts/ci/check-doc-claims.js --list=endpoint-claim-unsupported` 并 `findstr DESIGN-ARCH-203` → **0 条命中**，退出码 0。文档首行 `:3` 的 `<!-- DOCS-CLAIMS-EXEMPT: … -->` 豁免标记在场，豁免生效 |

### 13.5 复核后对正文的修订

按「verified 的原样保留；unconfirmed 的主张在正文标注『未确认』，不许删」执行：

1. **§10 中 8 条 unconfirmed 主张全部保留原文字**，仅在行内追加 `【未确认】` 标注与一句更正/说明，不删条目、不改 verdict。
2. **F1**：标注「未确认——设计时前提，当前已被现实证伪（203 已落盘、最大已用编号为 204）」。
3. **F5**：标注「未确认——`_adapterBase.js` 实际在 `agentAssets/` 而非 `adapters/`（复核者 `Get-ChildItem -Recurse` 实测）」。
4. **F17e**：标注「未确认——`_META_ALLOW` 实测 **5 项**而非主张的 4 项，属文档内部计数错误（§6.2 引用处已按 5 项表述）」。
5. **F30**：标注「未确认——`keyStore.ts` 侧成立，`proxyStatus.ts` 侧被证伪（该文件 `:137` 载入的是 `gateway/proxyServer.js`，非 providerPresets.js）」。
6. **F39 / N2 / N3 / N5**：标注「未确认——均未复跑」并附复核者的补充事实（N5 附「本机未装 vitest」）。
7. **另有 5 处 verified 但附校正的行内小差**（不改变 verdict）：F22b 行数计法（75+尾换行 vs 76）、F22d 精确区间 `:641-651`、F25 精确区间 `:35-69`、F33 `requiredRole` 实为 `:110`、F17l 六个 require 行号各漂移 2 行、N6 两个计数各 +1——已在对应主张行内以「（校正：…）」注明。
8. **§13 本身不改动任何设计结论**；§6.2 引用 `_META_ALLOW` 处按实测改为 5 项。

---

*创建：2026-11-07 · 架构师 · 隶属 [DESIGN-GOV-001] 治理体系的架构设计层*
*第 1 轮修订：2026-11-07 · 独立评审 14 条意见全部采纳（R1/R4 加重），留痕见 §11*
*第 2 轮修订：2026-11-07 · 独立评审 9 条意见全部采纳；R1 推翻「桌面走 HTTP」改 CH-2 服务层直调，R2/R3 推翻「两层接台账 / 不另起台账」改「两类回滚 + 作用域隔离」，R4 删掉重复的 MCP 契约，R5 补双写者审计，R6 删虚构模块名，R7/R8/R9 更正计数与行号，留痕见 §12*
*第 3 轮（事实复核）：2026-11-07 · §10 全部 60 条主张 + N1–N9 共 69 项经第三方逐条复核，verified 50 / unconfirmed 8 / verified 附校正 5；8 条未确认在正文原样保留并标注「未确认」，留痕见 §13*
