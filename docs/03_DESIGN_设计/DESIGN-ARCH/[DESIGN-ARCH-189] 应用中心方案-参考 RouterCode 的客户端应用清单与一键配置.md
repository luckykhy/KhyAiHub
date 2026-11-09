# [DESIGN-ARCH-189] 应用中心方案 —— 参考 RouterCode 的客户端应用清单与一键配置

> **状态**：§8 八条决策与 §1 需求五问已于 2026-10-14 经用户逐条裁决（见 §8「裁决」列与 §1 source 列）；仍未动一行代码
> **适用范围**：`delivery/web/ai-frontend/`（页面）、`runtime/node/backend/src/routes/` + `src/services/domain/config/`（目录、探测、写配置）
> **解决的问题**：khy-os 已经有能力把外部 AI 客户端（Claude Code / Codex CLI / OpenCode …）指到自家网关——`ccSwitch` 卡片矩阵 + `externalApps` 写配置器 + `MyGateway.vue` 我的网关页，路都通了；但这些能力**没有一个"以应用为中心"的门面**：用户看不到本机装了哪些客户端、每个客户端该配什么模型、配置到底成没成、想拆掉怎么写回。RouterCode Desktop 的应用中心把这个面做成了卡片清单（截图见 §3），本方案定义 khy-os 侧等价的**客户端应用目录与一键配置**架构，并明确它与既有 `ccSwitch` / `appRegistry` 的边界。
> **强制手段**：本方案落地后由 `check-client-apps-catalog.js`（登记表 ↔ 实际写配置器双向可达）与前端 nav/router wiring 测试执行；文档命名与放置遵循 `[DESIGN-LAY-005]` 与 `[MGMT-STD-001]`。
> **相关文档**：`[DESIGN-ARCH-101]`（代理模式统一 Agent 模型管理与协议桥接方案 —— 卡片矩阵语义真源，**本文只用不重定义**）、`[DESIGN-ARCH-011]`（应用接入标准 —— **平台应用**，与本文对象不同，见 §0）、`[DESIGN-ARCH-026]`（系统级服务调用审批网关）、`[DESIGN-ARCH-111]`（规则绑定层）、`[DESIGN-ARCH-071]`（通道选择）、`[DESIGN-DELIV-002]`（棘轮阈值）、`[DESIGN-LAY-005]`（层级与命名）、`[DESIGN-LAY-007]`（数据落点）
> **参考来源（外部行为参考，非本仓真源）**：RouterCode Desktop 应用中心。证据两类：① 用户提供的界面截图 `upload_20261014_093134_1.png`；② 本机 RouterCode 运行时资料 `%LOCALAPPDATA%\routercode\`（`skills/installer/references/appcenter-and-gateway-pages.md`、`skills/installer/tools/<app_id>/config.json`、`appcenter.ccswitch`）。**其源码不在本机、不可读**，故本文只对齐**行为与信息架构**，不复刻其实现、不引入其运行时文件名（见 §0）。

---

## 0. 术语红线（先读）

本仓已有两个词会被本方案撞上，不先钉死必然混淆：

| 词 | 本仓既有含义（真源） | 本文一律怎么用 |
|----|---------------------|----------------|
| **应用** | `runtime/node/backend/src/services/appRegistry.js`：khy 平台的**独立子应用**（khyquant 一类），落 `~/.khyquant/apps/<name>.json` | 本文对象一律写「**客户端应用**」＝ 外部 AI 客户端（Claude Desktop / Codex CLI / Cursor …）。**不写"应用"两个字单独出现**——单独出现即指 `appRegistry` 那一类 |
| **一键配置** | 无既有含义 | 本文特指：一次操作把「网关地址 + 密钥 + 模型绑定」写进某客户端应用的配置文件（§7.3 的三档模式） |
| **卡片 / switch** | `ccSwitch`（`[DESIGN-ARCH-101]` §5/§7）：provider 卡片，改写本机 CLI 的 live 配置 | 保持不变。应用中心是**卡片之上的目录面**，不新造第二套切换语义 |

**命名约束（落地时强制）**：

- 代码标识符用 `clientApps` / `client-apps`，**禁止**用 `appcenter` / `app-center` 作文件名或模块名——`appcenter.ccswitch` 是 RouterCode 的运行时文件名，同名会在两个产品之间制造「同一个文件」的错觉。
- 现有运行时写者（`services/domain/network/externalApps/*Adapter.js`）**不改名、不搬家**；应用中心是调用方，不是它们的替代。
- 「应用中心」的英文在**代码里**统一 `client apps`；文档里保留中文「应用中心」以便与用户口吻对齐。

## 1. 需求五问（`RUNTIME-008`）

| # | 问题 | 答案 | source |
|---|------|------|--------|
| 1 | 谁用？ | 本机使用者：装了一到多个 AI 客户端，想把它们统一指到 khy 网关（拿多供应商容错、用量台账、审计），但不想手改每个客户端的配置文件 | `source: 用户原话「参考routercode实现应用中心」+ 截图（2026-10-14）` |
| 2 | 什么时候用？ | 新装一个客户端之后（要接网关）；换模型/换上游之后（要重配）；排查"客户端连不上"时（要看配置到底写成什么样）；换机器/卸载时（要能干净拆掉） | `source: 用户确认 2026-10-14` |
| 3 | 现在的替代做法？ | ① 手改 `~/.claude/settings.json` 之类的文件（易错、无备份、无校验）；② 用 `khy ccswitch` CLI 切卡片（已存在：`cli/routerDispatchTail.js` 的 `case 'ccswitch'`，但只有 CLI 面，且只覆盖 12 个在册项）；③ 完全不用网关，各客户端直连各家 API（丢掉容错/台账/审计） | `source: 代码事实（ccSwitch 的 Web 端点全 admin 门禁；MyGateway.vue 不讲"应用"叙事）` |
| 4 | 成功长什么样？ | 打开「应用中心」：卡片列出本机已装/可装的客户端应用，每张卡显示**安装状态**、**配置状态徽章**（已配置 / 配置未完成 / 未配置）、模型绑定的下拉；点「一键配置」后配置写入目标文件且**必有备份**、界面给出逐键结果；「扫描应用」能重新探测本机状态；全过程不静默、不硬编码、超时可续。验收命令见 §10 | `source: 用户确认 2026-10-14（验收口径以 §10 为准）` |
| 5 | 不做会怎样？ | 网关能力对「非 CLI 用户」不可达：`MyGateway.vue` 讲的是"你的上游与密钥"，不是"你的客户端配好了没"。用户每接一个客户端都得读一遍文档手改文件，出错即静默失败（客户端报鉴权错，用户不知道是路径错了还是 key 错） | `source: 用户确认 2026-10-14` |

> 问 2/4/5 已于 **2026-10-14 经用户逐条确认**（§1 五问全部闭环，本文不再是评审草案）。
> §8 的八条决策同日裁决完毕，见该节「裁决」列。按 `RUNTIME-008`，本文所载均可作为需求依据。

## 2. 目标 / 非目标

**目标（一个页面 + 一个目录真源 + 三类动作）**：

- **目录真源**：一份机器可读的客户端应用登记表（`§6` 给出落点），每项描述：`app_id`、中文名、英文包名、描述、分类（桌面端 / CLI）、图标、安装探测方式、配置写者、模型能力分组。登记表是**唯一真源**，页面与 API 都从它派生。
- **扫描（只读）**：探测本机每个客户端的「装了没 / 配了没 / 配对了没」，产出徽章所需的三信号（对齐 §3 的 `configured` / `configuredVerified` / `manualConfig`）。
- **一键配置（写）**：复用既有写配置能力（`ccSwitch/appWriters.js` + `services/domain/network/externalApps/*`），前置备份，事后逐键回报。
- **页面**：卡片清单 + 分类页签 + 搜索 + 扫描按钮 + 三档配置模式选择 + 每卡模型下拉 + 安装/一键配置/诊断/恢复厂商配置/卸载五个动作位。

**非目标**：

- **不新增 CLI 命令**。`[DESIGN-DELIV-002]` §1 的三只棘轮（命令 245 / 别名 591 / handler 155）只降不升，新增命令要退役一条旧命令才谈得上。本方案全部能力走 Web（§5）。
- **不改 `appRegistry` 语义**，`~/.khyquant/apps/` 那一套与本文无关。
- **khyquant 不在本方案内**（独立项目，人 2026-09-28 明示）。
- **不在本阶段做"下载并静默安装客户端"**。安装涉及系统级服务调用与外部安装器，须先过 `[DESIGN-ARCH-026]` 审批网关，列为 S3（§9）。
- **不做密钥分发/账号体系**（`routes/apiKey.js` 的 `/generate` `/refresh` `/revoke` `/current` 已存在，本文只引用）。
- **不引入 RouterCode 的运行时契约**：`clients/*.json`、`configs/*.json`、`appcenter.ccswitch`、`backups/app-configs/*.orig` 一律**不读不写**（即便同机存在）。khy-os 自己定契约（§7）。

## 3. 参考对象拆解（RouterCode 应用中心）

截图元素 → 语义 → 本仓对应物（"无" 即本方案要补的缺口）：

| 截图元素 | RouterCode 侧语义（证据） | khy-os 现状 |
|---------|--------------------------|-------------|
| 顶部三勾选：永久配置 / 动态配置 / API 配置 | 全局配置模式，落 `appcenter.ccswitch`（`permanent` / `dynamic` / `api`），决定"一键配置"派给哪个技能 | **无**（khy-os 无可切换的全局模式概念） |
| 「扫描应用」按钮 | 重新探测本机已装客户端，刷新卡片 | **无**（`ccSwitch` 有 per-app 状态查询，无整机扫描入口） |
| 页签：全部 / 桌面端 / CLI Code | 分类过滤 | **无**（`ccSwitch` 的 12 项全是 CLI，无分类轴） |
| 卡片标题下的 `claude-desktop` / `chatgpt-codex-desktop` / `codex-cli` | `app_id`，也是安装记录文件名 `clients/<app_id>.json` | 部分有（`ccSwitch` 的 `APPS` 常量有 `claude-code` / `codex` / `opencode` …） |
| 「共享绑定」标签 | 该卡与另一张卡共用一份模型绑定 | **无** |
| 每卡「生图模型」「视频模型」下拉 | 模型绑定（按能力分组），落 `configs/<app_id>.json` | **无**（有 provider/模型池，无 per-app 绑定与能力分组） |
| 「安装」「一键配置」按钮 | 五操作之二：Install（派 `/installer` 消息）/ Configure（四步：写绑定 → 写 `configs/<app_id>.json` → 按模板深合并写目标文件并备份 → 开会话带 checklist） | **无**（写配置能力在，编排与门面不在） |
| 卡片上的状态徽章 | 三信号：`configured`（intent）/ `configuredVerified`（机器校验）/ `manualConfig`；已配置 = 前两者之一满足 | **无** |
| 另有：诊断、恢复厂商配置、卸载 | 五操作其余三个；备份契约 `<basename>.orig`（永不覆盖）/ `<basename>.prev`（每次刷新） | **无**（无备份契约） |

**行为层可借鉴、实现层不复刻**：五操作的分工、三信号徽章、备份语义（`.orig` 不覆盖）这三条是**产品逻辑**，值得照搬；`appcenter.ccswitch`、`clients/`、`configs/`、技能包派发是**它的运行时形状**，khy-os 一律另立（§0）。

## 4. 现状盘点：地基到哪一步，缺口在哪

| 能力 | 现状（文件） | 差距 |
|------|-------------|------|
| 在册客户端列表 | `services/domain/config/ccSwitch/constants.js` 的 `APPS`（12 项：claude-code / codex / opencode / gemini / deepseek / reasonix / command-code / ycode / zcode / openclaw / coze / trae）+ `APP_LABELS` | 只有 id 与中文名，**没有**描述、分类、图标、探测方式（页面要的四样都缺） |
| 写配置文件 | `services/domain/config/ccSwitch/appWriters.js` → `services/domain/network/externalApps/claudeCodeAdapter.js` 等 | 存在且可用；**没有**备份契约、没有 per-app 模型绑定、没有逐键回报 |
| 切换（卡片） | `routes/ccSwitch.js`（全端点 admin 门禁，见其头注） | admin-only；面向"卡片切换"叙事，非"应用配置"叙事 |
| 网关地址与密钥 | `delivery/web/ai-frontend/src/views/MyGateway.vue`（1062 行，我的网关页）+ `routes/apiKey.js` | 已有；但讲的是"上游与密钥池"，用户拿不到"我的 Claude Desktop 配好没" |
| 平台子应用 | `services/appRegistry.js` | **语义不同**，本方案不碰（§0） |
| 应用中心页面 | 无（`npm` 侧、`views/` 侧均无；`应用中心`/`appcenter` 全仓零命中） | 本方案主体 |

**结论**：缺口集中在"**目录数据 + 探测 + 编排 + 门面**"四件，写配置与密钥这两件地基已经在了。方案因此**不新建写配置能力**，只加编排层。

## 5. 架构设计

```
            ┌──────────────── 登记表（唯一真源）────────────────┐
            │  services/domain/config/clientApps/catalog.json  │
            └───────────────┬─────────────────────────────────┘
                            │ 只读
   页面 ──HTTP──▶ routes/clientApps.js ──▶ services/domain/config/clientApps/
   (Vue)                                    ├── catalog.js   登记表装载 + 校验
                                            ├── scan.js      探测（只读：装了没/配了没/配对了没）
                                            ├── configure.js 编排写配置（备份 → 写 → 逐键回报）
                                            └── mode.js      三档配置模式（§7.3）
                                                     │ 复用（不重造）
                                            ccSwitch/appWriters.js
                                            externalApps/*Adapter.js
```

**分层落点（`[DESIGN-LAY-005]` 的 L 名册以 `scripts/ci/check-repo-layout.js` 的 `LAYERS` 为准）**：

| 新增物 | 落点 | 层/域 | 理由 |
|-------|------|-------|------|
| 页面与子组件 | `delivery/web/ai-frontend/src/views/` | 交付面 | 与 `MyGateway.vue` 同层，前端只此一处 |
| HTTP 端点 | `runtime/node/backend/src/routes/clientApps.js` | 运行时内核 | 与 `ccSwitch.js` / `apiKey.js` 同层，`server.js` 挂载 |
| 服务与登记表 | `runtime/node/backend/src/services/domain/config/clientApps/` | 业务上下文（D2） | 与 `ccSwitch/` 同域同层，紧邻其被复用的写配置器 |

**准入判据（为什么是 Web 路由而不是新 CLI 命令）**：调用方是浏览器与页面脚本（`[DESIGN-ARCH-071]` 第 5 问 → 前端/远程 → **CH-4 Web API**）。CLI 面已有 `khy ccswitch`，本方案**不扩展**它——棘轮已满（§2）。

**门禁强度（待裁决，见 §8 D5）**：`ccSwitch.js` 当前全端点 admin 门禁。应用中心写的是**本机某用户的客户端配置**，与"卡片切换"同属越权面，建议**同等强度（admin）起步**，S2 再评估是否按「操作者 = 本机用户」放宽——**不放宽比放宽安全**，且放宽需要新的判据（谁的本机？多用户主机怎么办？）。

## 6. 目录与文件设计（待落地的精确清单）

| 文件 | 新增/改动 | 用途 |
|------|----------|------|
| `runtime/node/backend/src/services/domain/config/clientApps/catalog.json` | 新增 | 登记表真源（§7.1 schema） |
| `runtime/node/backend/src/services/domain/config/clientApps/catalog.js` | 新增 | 装载 + schema 校验（缺字段即报，不静默补默认值） |
| `runtime/node/backend/src/services/domain/config/clientApps/scan.js` | 新增 | 只读探测，产出三信号 |
| `runtime/node/backend/src/services/domain/config/clientApps/configure.js` | 新增 | 备份 → 写 → 逐键回报 |
| `runtime/node/backend/src/services/domain/config/clientApps/mode.js` | 新增 | 三档配置模式的读写与语义映射 |
| `runtime/node/backend/src/routes/clientApps.js` | 新增 | `/api/client-apps/catalog`、`/scan`（S1 只读）；`/preview`、`/configure`、`/restore`（S2，先预览后写） |
| `runtime/node/backend/src/server.js` | 改动 | 挂载路由（一行） |
| `delivery/web/ai-frontend/src/views/apps/AppCenter.vue` | 新增 | 页面主体 |
| `delivery/web/ai-frontend/src/views/apps/components/AppCard.vue` | 新增 | 卡片（徽章 / 模型下拉 / 五动作位） |
| `delivery/web/ai-frontend/src/router/index.js` + `src/nav/index.js` | 改动 | 注册页面（两处必须同改，有 wiring 测试） |
| `docs/10_规范/registry/FEATURE-OWNERSHIP.json` | 改动 | 登记 `client-apps-catalog` 特性归属，防日后第二份实现 |
| `docs/10_规范/registry/RULES-REGISTRY.json` | **不改** | 本方案不新增规则 ID，复用既有规则 + 绑定层（§8 D7） |

**不新增**：顶层目录、`npm run` 入口、CLI 命令、环境变量（除非 S2 需要，届时按 `KHY_` 前缀登记）。

## 7. 数据契约

### 7.1 登记表条目（`catalog.json` 的一条）

```jsonc
{
  "appId": "claude-desktop",        // 稳定标识；与 ccSwitch 的 APPS 值同名者复用其值
  "name": "Claude Code 桌面端",      // 卡片中文名
  "pkgName": "claude-desktop",      // 卡片第二行的英文包名
  "desc": "……",                     // 一句话描述
  "category": "desktop",            // desktop | cli（对应页签）
  "icon": "…",                      // 图标资源标识，缺省走占位
  "installProbe": { "kind": "path|registry|command", "spec": "…" },
  "configWriter": "claudeCodeAdapter", // 指向既有的 externalApps 写者；无则本卡只读
  "modelSlots": ["image", "video"],    // 卡片下拉的能力分组（空数组 = 不显示下拉）
  "backupKey": "claude-desktop",       // 备份目录 key（可与他卡共用 = 「共享绑定」来源）
  "sharedBindingWith": "claude-code"   // 可选：与谁共用绑定
}
```

**约束**：`configWriter` 必须在 `ccSwitch/appWriters.js` 的 switch 表里可达，否则该卡**只读**（不得 fail-open 成"写成功"）。这条由 §"强制手段"的 `check-client-apps-catalog.js` 校验。

### 7.2 探测结果（`/scan` 的返回，按 appId 聚合）

```jsonc
{
  "appId": "claude-desktop",
  "installed": true,          // 安装探测命中
  "configured": false,        // intent：用户曾在本中心为它选过模型
  "configuredVerified": false,// 机器校验：目标文件里存在组装后的 base_url + key 路径段
  "manualConfig": false,      // 手工配置标记（用户自己配的，intent 即算数）
  "badge": "未配置",           // 已配置 = configured && (configuredVerified || manualConfig)，否则「配置未完成」/「未配置」
  "detail": { "configPath": "…", "reason": "…" }
}
```

**徽章判据照搬参考对象的三信号**（§3）——它的价值在于把"用户以为配了"与"机器验过"分开，khy-os 直接采用。

### 7.3 三档配置模式（**语义映射需裁决，见 §8 D1**）

RouterCode 三档的实际差别（证据：`skills/installer`、`skills/installerccswift`、`skills/installerapi` 三个技能包的定位）：**永久 = 静态写入本机网关地址与密钥；动态 = 走 CC-Switch 卡片、可随时切换、单模型绑定；API = 不改本机文件，应用直连远端数据面（Bearer）**。

khy-os 侧的候选映射（**本文不给结论**）：

| 档 | 候选语义 | 落点 |
|----|---------|------|
| 永久配置 | 静态写入：网关地址 + 用户密钥 + 绑定模型，写死进目标文件 | `appWriters.js` 现有路径 |
| 动态配置 | 走 `ccSwitch` 卡片：配置随卡片切换而变，支持多卡 | `ccSwitch` 既有 store + 写者 |
| API 配置 | 不改本机文件，只给「base_url + key」让用户自填/复制分发 | 复用 `routes/apiKey.js`，本中心**只读展示 + 复制** |

**共同要求（三档都必须满足）**：① 写入前备份，`.orig` 永不覆盖、`.prev` 每次刷新；② 写后逐键回报（`[ok]` / `[MISSING]` / `[DIFF]`）；③ 幂等：同一配置连写两次，第二次必须 0 diff（验收命令见 §10）。

## 8. 关键决策与开放问题（**已于 2026-10-14 逐条裁决，见末列**）

| # | 问题 | 备选 | 影响 | 裁决（2026-10-14 用户） |
|---|------|------|------|------|
| D1 | 三档配置模式在 khy-os 的语义 | §7.3 的候选映射 / 只做一档（永久）先落地 / 不做模式概念 | 决定 `mode.js` 是否存在，以及"一键配置"要不要带模式参数 | **先只做「永久」一档**，三档模式概念推迟。依据：RouterCode 逆向研究最值钱的发现是「绑定应在网关侧强制改写，而非写进客户端配置文件」（L1）。若认 L1，「永久/动态」的模式区分即被架空——配置只写一次网关地址+key，模型切换全在网关。建议 L1 落地后回头重议模式；本期不建 `mode.js`，「一键配置」不带模式参数。 |
| D2 | 首期覆盖范围 | ① 只覆盖 `ccSwitch` 在册 12 项 CLI；② 12 项 + 新增桌面端（Claude Desktop 等，需新写配置器）；③ 全量对齐参考对象（含 Coze/Trae 等） | ②③ 需要新增 `externalApps` 写者，工作量最大的分支 | **① 只覆盖 `ccSwitch` 在册 12 项 CLI**。依据：②③ 需新写 `externalApps` 写者，是工作量最大分支；且实测 trae / codex / coze 三个 adapter 已不同构（位置参数签名 / `configPath()` 返回目录 / 销毁性 DELETE），盲扩会踩坑。 |
| D3 | 安装 / 卸载是否真执行 | ① S1/S2 只做"探测 + 跳转/提示"；② 走 `[DESIGN-ARCH-026]` 审批网关后真执行 | 系统级操作，②才涉及下载与安装器，风险最高 | **① S1/S2 只做探测 + 跳转/提示**，安装/卸载列 S3。依据：系统级操作须先过 `[DESIGN-ARCH-026]` 审批网关，与 §9 原规划一致。 |
| D4 | 登记表真源位置 | ① 代码侧 `services/domain/config/clientApps/catalog.json`（本文默认）；② `docs/10_规范/registry/`（文档侧登记表） | ②会让运行时代码读 `docs/`（D5 域），需先确认是否触犯"D1–D4 不得依赖 D5"的口径；若有疑虑选 ① | **① 代码侧 `catalog.json`**（本文默认）。依据：② 会让运行时代码读 `docs/`，有触犯「D1–D4 不得依赖 D5」口径的疑虑。 |
| D5 | 门禁强度 | ① 与 `ccSwitch` 一致 admin；② 按本机用户放宽 | 放宽需要新判据（多用户主机、远程访问），无判据不放宽 | **① 与 `ccSwitch` 一致 admin**。依据：② 放宽需要新判据（多用户主机、远程访问），文档原话「无判据不放宽」。 |
| D6 | 模型下拉的数据来源 | ① 复用网关的 modelCapability 元数据；② 新增 per-app 绑定表 | 决定"生图/视频模型"分组是真数据还是摆设 | **② 新增 per-app 绑定表**。依据：与 L1 同向——绑定放网关侧才需要 per-app 绑定表。代价：「生图/视频模型」分组在绑定表就绪前可能是摆设，须在页面上明示，**不得 fail-open 成"可选"**。 |
| D7 | 是否需要新规则 ID | ① 不新增，复用规则 1/2/3/6 + 绑定层；② 新增一条"登记表可达性"规则 | 棘轮规定新增一条规则要先退役一条（`[DESIGN-DELIV-002]`）；①更省 | **① 不新增，复用规则 1/2/3/6 + 绑定层**。依据：`[DESIGN-DELIV-002]` 棘轮规定新增一条规则要先退役一条。 |
| D8 | 与 `MyGateway.vue` 的关系 | ① 平级新页；② 合并进"我的网关"的页签 | 影响 nav/router 改动面与用户心智（"网关"vs"我的客户端"） | **② 合并进「我的网关」的页签**。依据：实测 `MyGateway.vue:74-215` 已在渲染「模型总览 · 多视角」且八视角单选组与本方案完全相同；平级新页会造成两块重叠 UI。 |

**已知既有缺陷（顺手记录，不在本方案修复范围）**：`docs/03_DESIGN_设计/DESIGN-ARCH/` 下 `[DESIGN-ARCH-101]` **两名同号**——`TUI 交互与展示规则细则.md` 与 `代理模式统一Agent模型管理与协议桥接方案.md`。本文引用卡片矩阵时按**标题**指代，避免歧义；重号本身建议另起一轮清理。

## 9. 分阶段落地路线（`PROCESS-008`）

| 阶段 | 做什么 | 不做什么 | 退出条件 | 实测状态（2026-10-15） |
|------|--------|---------|---------|------|
| **S1 观察者** | 登记表 + `/catalog` + `/scan`（**全只读**）+ 只读页面（卡片、分类、搜索、扫描、徽章、模型下拉**禁用**） | 不写任何文件；不出现「一键配置」可点按钮（可置灰并给出"未开放"的状态文案） | ① 扫描结果与人工核对一致（手工改过一个客户端的配置，扫描能看出来）；② `npm run check:layout` / `docs:verify` 全绿；③ 连续两次扫描结果稳定 | **已落地**。`routes/clientApps/index.js`（GET /catalog + POST /scan，admin 门禁）+ `api/clientApps.js` + `MyGateway.vue`「客户端应用」页签（按 D8=② 并入）。退出条件②实测通过；①③**未实测**——需要在装有真实客户端的机器上人工核对，本次只做了静态取证 |
| **S2 写入** | `/configure` 预览（返回 diff 不落盘）→ 真实写入（备份 + 逐键回报）+ 恢复厂商配置 | 不做安装/卸载 | ① 幂等：连写两次第二次 0 diff；② 备份文件存在且 `.orig` 未被第二次覆盖；③ 写入失败时目标文件字节级不变（有回滚证据） | **编排层已落地，真实写入未实测**。`clientApps/backup.js`（双档原语）+ `clientApps/configure.js`（备份→写→逐键回报）+ 三个写端点。退出条件②③有单测证据（`.orig` 二次不被覆盖、写失败从 `.prev` 还原）；①**未实测**——幂等要对真实客户端跑两遍才知道，且 trae 按项豁免（见 §11） |
| **S3 自动化** | 安装/卸载（经 `[DESIGN-ARCH-026]` 审批网关） | — | 审批链路与审计留痕可用 | 未开始 |

**阶段纪律**：S1 阶段**禁止**把写通道提前接线（`RUNTIME-010`：声明面收窄须有执行面强制；S1 的"只读"要由**不挂写路由**来保证，不能只靠按钮置灰）。

> **S2 后该纪律的适用范围已变**：写路径接线后，「不挂写路由」这条执行面保证不再成立，
> 取而代之的是**范围保证**——`configure.js` 的 `WRITE_BLOCKED` 对备不了文件的 app
> 明确拒绝，且备份失败在写之前中止。`routes/clientApps/index.test.js` 的断言已随之
> 从「无写路由」改为「写路由存在且范围受控」。

## 10. 验收命令（落地后照此验）

```bash
<!-- IMPL-STATUS: todo -->
<!-- IMPL-DRIFT-AUDIT: 2026-10-18 · DOCS-005 范围补标，依据见下 -->
> **标记依据**：16 条路径可解析，但文中未自述已实现；保守标 todo 待人工复核。
# 目录与探测（S1）
npm run check:layout                     # 层级：无新增顶层目录、无越层依赖
npm run docs:verify                      # 文档孪生完整

# 单元/契约测试（S1+S2，本次实测 64 例全绿）
cd runtime/node/backend
node --test src/services/domain/config/clientApps/catalog.test.js \
            src/services/domain/config/clientApps/scan.test.js \
            src/services/domain/config/clientApps/backup.test.js \
            src/services/domain/config/clientApps/configure.test.js \
            src/routes/clientApps/index.test.js

# 三守卫 + god-file + 软著
node scripts/ci/check-repo-layout.js
node scripts/ci/check-change-safety.js --changed
node scripts/ci/check-agent-rules.js --changed
node scripts/ci/check-gov-rules.js
node scripts/ci/check-copyright-readiness.js
npm run arch:god --workspace runtime/node/backend

# 前端构建 + lint
cd delivery/web/ai-frontend && npx vite build && node scripts/lint.mjs

# 幂等（S2，关键判据；需真实客户端，本次未跑）
#   同一 appId 连跑两次 /configure 后：
#   ① 目标配置文件 0 diff；② backups/<key>/*.orig 的 mtime 未变

# 前端接线（改了 nav/router 必跑）
npx vitest run delivery/web/ai-frontend/src/**/*wiring*.test.js
```

> `<port>` 从 `serviceDefaults` / 环境变量取，**不得硬编码**（`RUNTIME-001`）。
>
> **本次实测结论**：上述除「幂等」与「扫描人工核对」外的命令全部通过。
> `repo-layout` 曾在收尾时因仓库根出现影子目录 `.khy/aesthetics/` 报红——
> 该目录内容是一份关于四端启动的侦察文档、与本文改动无关，已移至 Portable
> 暂存区保住内容后守卫转绿；其记录的 `entrypoints.js:595,597`
> （Promise 被赋给 `process.exitCode`）是独立待修缺陷，不在本文范围。

## 11. 风险与红线

| 风险 | 对策 |
|------|------|
| 写的是用户本机的真实配置文件，写坏即客户端不可用 | 备份契约（`.orig` 永不覆盖）+ 失败不落盘 + S2 才开写 |
| 安装/卸载属系统级操作 | 不过 `[DESIGN-ARCH-026]` 审批网关不进 S3（§9） |
| 长耗时的安装/探测被硬超时截断 | 活动式超时（`RUNTIME-003`）：按"最近一次进度信号"重置，不用固定 `setTimeout` 截止 |
| 卡片全屏/滚动区 UI | 遵守 `RUNTIME-004`：Web 页面视角，滚动是浏览器职责，不产生终端滚动区转义 |
| 状态含糊（"处理中…"） | `RUNTIME-002`：文案必须写清"正在对哪个客户端做什么、第几步" |
| 与 RouterCode 的运行时互相污染 | §0 命名约束：不写 `appcenter.*`、不读写其 `clients/` `configs/` `backups/` |
| 第二份实现悄悄长出来 | 登记 `FEATURE-OWNERSHIP.json`（§6）+ `configWriter` 可达性守卫（§7.1） |

## 12. 与既有文档的关系（本文不覆盖任何既有真源）

- `[DESIGN-ARCH-101]`「代理模式统一 Agent 模型管理与协议桥接方案」＝ 卡片矩阵与协议桥接的**语义真源**；本文只用其概念，不重定义。
- `[DESIGN-ARCH-011]`「应用接入标准」＝ **平台应用**接入标准（khyquant 一类）；本文对象是**外部客户端应用**，两不相干。
- `[DESIGN-DELIV-002]`＝ 任务面与棘轮阈值真源；本文的"不新增 CLI 命令"直接引用它，不另立数字。
- `[DESIGN-LAY-005]` / `[DESIGN-LAY-007]`＝ 层级/命名与数据落点真源；本文 §5/§6 的落点须与它们的守卫一致。

## 13. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-10-14 | 首稿（草案）。参考用户提供的 RouterCode 应用中心截图与同机 RouterCode 运行时资料，盘点 khy-os 现状后成文；未动代码，§8 待评审裁决。 |
| 2026-10-14 | **§8 八条决策 + §1 五问全部裁决/确认**（用户逐条点头）。D1 改判「先只做永久一档、模式概念推迟」、D6 定为「新增 per-app 绑定表」——二者均以 RouterCode 逆向研究的核心发现 **L1「绑定在网关侧强制改写，而非写进客户端配置文件」** 为前提；L1 本身是独立工作量（L 级，需改 `proxyServer.js` 认证热路径），**不在本方案范围内，需单独一轮**。另修正首稿一处自相矛盾：§0 术语红线禁止 `appcenter` 作文件名，但「强制手段」段写的却是 `check-appcenter-catalog.js`，已改为 `check-client-apps-catalog.js`（全文 2 处）。 |
| 2026-10-15 | **S1 + S2 编排层落地**，并据实测修正三处首稿事实：① **登记表是 13 条不是 12 条**——首稿与 D2 裁决都写「12 个在册 CLI」，实际 catalog.json 有 13 个 appId，其中 codex 与 claude-desktop 的 adapter 为 null；② **codex 的写者不在 externalApps**（在 ccSwitch/codexWriter.js + gateway/adapters/codexAdapter.js，D1 侧），故编排层本期不接它（WRITE_BLOCKED），需单独的目标解析器；③ **command-code / ycode 不落文件**（只写 env 引用）、**trae 无独立 live 配置**（其 configPath() 指向 khy-os 自己的 store）、**coze 目标按模型分发**——三者均不配 backupKeys 而以 backupNote 说明理由，13 条中只有 7 条配了 key。另：trae 的 remove() 是**位置参数**签名（其余 10 个 adapter 均为解构 options），编排层按 adapter 分派调用形状；repo-layout 收尾时因仓库根影子目录 .khy/aesthetics/ 报红，该目录内容与本文无关，已移出保住内容（详见 §10 注）。 |
