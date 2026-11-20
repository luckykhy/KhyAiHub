<!-- 文档分类: DESIGN-ARCH-217 | 阶段: 设计 -->
<!-- IMPL-STATUS: todo -->
<!-- DOCS-CLAIMS-EXEMPT: 本文（DESIGN-ARCH-217）是尚未实现的设计文档，/api/agent-hub 全族端点均为目标态契约而非已存在的路由；check-doc-claims 的 endpoint-claim-unsupported 对设计文档必然命中（同类存量见 [DESIGN-ARCH-192]——它在本轮 33 条名单里贡献 20 条；[DESIGN-ARCH-203] 不在此列，它自带同款标记、贡献 0 条），不构成缺陷陈述 -->
# [DESIGN-ARCH-217] 四端统一智能体管理面

> **定位**：用户 2026-11-16 原话「khyos我希望四端都提供一个统一管理电脑上所有智能体的位置」。[DESIGN-ARCH-203] 已把「一个 agentHub service + 两条暴露路径（桌面 CH-2、Web CH-4）」定为本机智能体统一管理的单一真源（见其 §2.1）；本文是它的**四端扩面增补**——把手机与外网网页定义为 owner 的远程接入点（远程 CH-4，同一 `/api/agent-hub` 命名空间、同一套 `authenticateToken`）、把终端定义为 CH-3（`khy agent-assets hub` / `hub --json`），四端共用同一份 service、同一套 R/W1/W2/W3/W3+ 分级与确认令牌语义，不造第二写者。单人多机：每台电脑各跑一份 agentHub 后端、各持本机智能体清单；手机与外网网页保存设备列表，选中哪台就管哪台（requirement-5q.md:178）。本文**不推翻** [DESIGN-ARCH-203] §0–§13 的既有裁决，与其原文不一致处一律写「订正记录」留痕（契约级集中于 §3.6，各端口径另见 §6.3 / §7.3 / §8.3）；其注册表形状（§3.2）、操作分级（§6.1）、确认与回滚（§6.2）、落地阶段（§8）等契约按原文沿用，本文引用不复述。
> **口径来源**：`works/data/khy/feedback/agent-hub/requirement-5q.md` 的「2026-11-16 四端统一管理口径（现行）」一节（:141-411），含用户两次拍板——四端全可写（:150-151）、单人多机（:152-153）。该文件上半部（2026-11-07 第一版，只覆盖桌面端）原样保留作历史存证。
> **编号说明**：本文是独立文档，章节号自成体系。两份上游草稿的原始编号（后端契约草稿 §14.1–14.4、四端接线草稿 §14.1–14.4）映射见 §13.2。
> **上位约束**：`AGENTS.md` 工程规则 1–12；`[DESIGN-LAY-005]`（层级与落点）；`[DESIGN-ARCH-071]`（通道选择）；`[DESIGN-ARCH-192]` / `[DESIGN-ARCH-216]`（身份与配对选型，属契约决策员事项，见 §11.3）。
> **状态**：设计（todo）。文中所有 `/api/agent-hub` 端点、`agentHub` service、`khy agent-assets hub` 子命令均为**目标态**，今日均不存在（实测见 §12 A1、H2）。

## 0. 结论先行

1. **一个 service、四端三条暴露路径**：桌面 CH-2（`createRequire` 载同一 service，零 HTTP 零 token）、网页 + 手机 CH-4（同一 `/api/agent-hub` 命名空间，同一套 `authenticateToken`）、终端 CH-3（`khy agent-assets hub`，handler 内 CH-2 直调）。四端共用一套分级与确认令牌语义（§2）。桌面打 `/api/agent-hub` 是明令反模式（[DESIGN-ARCH-203]:470）。
2. **注册表不增「端」维度**：`AGENT_HUB_SOURCES` 只声明后端主机磁盘事实；「哪端可见、哪端裁剪」由各暴露层自理（§3.1）。「每端暴露矩阵」是文档级解释，不是注册表字段（§3.3）。
3. **鉴权只有一种语义**：`/api/agent-hub` 只挂后端 `middleware/auth.js` 的 `authenticateToken`（仅用户 JWT、无回环豁免；同模块另导出的 `flexibleAuth` 带 X-API-Key 第二腿、`originGuard` / `requireLoopback` 族属本地控制面语义，**两族均禁挂**——符号级区分见 §3.4）；不引入 `aiManagementServer` 自管 `authenticate()` 的 X-API-Key / loopback / LAN 豁免（§3.4、§5）。
4. **手机是写端，不是只读端**：与网页同档共用 R/W1/W2/W3/W3+；不引入 Web 的角色裁剪（单人 owner）；W2/W3/W3+ 是否加二次生物识别 / 独立审批为用户保留待拍板（§3.5、§11.1）。
5. **终端只扩不加**：不新增顶层 CLI 命令，只在 `khy agent-assets` 内加 `hub` 子命令，五处同步点一次补齐（§4.2）；TUI 不是第六处（§4.3）。
6. **范围排除两条**：khyquant 前端（独立项目、另案申报）与 provider-hub（自带写腿、并入即第二套写者）不纳入，全文见 §10。

---

## 1. 需求五问更新（四端口径）

### 1.1 本轮输入

| # | 输入 | 出处 |
|---|---|---|
| 1 | 用户原话：「khyos我希望四端都提供一个统一管理电脑上所有智能体的位置」 | requirement-5q.md:148-149 |
| 2 | 拍板一 · 四端全可写：手机端与不在同一台电脑上打开的网页端，本期必须与桌面端、终端同权——装/卸程序本体、改模型配置、增删 MCP、导入导出 skill/记忆都可写，不是只读查看 | requirement-5q.md:150-151 |
| 3 | 拍板二 · 单人多机：同一个 owner、多台电脑；手机/外网网页是 owner 的接入点，不是「机器本身的界面」。没有团队，没有第二个有写权的人 | requirement-5q.md:152-153 |
| 4 | 口径变更：第一版 Q2 的「入口走哪个通道用户未指定，AI 按桌面端取桌面 UI」作废；四端各自成表面，写权限同权 | requirement-5q.md:155 |

### 1.2 Q1 谁用？（角色）

同一个 owner，多端、多台电脑；没有团队，没有第二个有写权的人。手机与外网网页只是这个 owner 的接入点，不是「机器本身的界面」。权限模型只需两层：**owner 身份**（可撤销凭据，四端共用；**「可撤销」依赖接入面走 backend 本地 `middleware/auth` 的会话校验**——shared 版不查 AuthSession，令牌撤销后仍有效，见 §3.4 表第 4 行）+ **每台电脑一个可撤销的设备身份**；未登录、未与目标设备配对的一切请求拒绝。**执行面现状（第 2 版订正：不是「没有执行面」，见 §13.6 第 2 条；第 5 版再订正：原来只拆成两截，漏了仓内既有的 `devicePairing.js`，现在拆成三截，见 §13.9 第 2 条）**——后半句要拆成三截看：

- **会话语义已在**：`issueSessionForUser`（`authSessionService.js:265-305`）签发会话时写入 `tokenVersion`（`:275`）、`ipAddress` / `userAgent`（`:278-279`）、`deviceLabel`（`:280-284`，由 UA 派生，`detectDeviceLabel` `:90-128`）；`authenticateAccessToken` 按会话粒度拒绝（`session_revoked` `:363-365`、`session_expired` `:367-370`、`token_version_mismatch` `:372-382`）；撤销有单会话 `revokeSessionById`（`:399-415`）与全量 `revokeUserSessions`（`:417-437`，含 `excludeSessionId`），清单 `listUserSessions`（`:513`）。即「可撤销」这一半已有现成实现（粒度 = 登录会话，不是物理设备）。
- **缺的是另一半**：「配对设备 ↔ 目标 origin」绑定与「未配对请求拒绝」——`authenticateAccessToken` 不做 origin 校验，`deviceLabel` 是 UA 字符串标注而非可注册/撤销的设备身份，配对载荷现状也不下发任何凭据（`cli/handlers/mobile.js:145-148` 只返回 `{ apiBaseUrl }`）。
- **但缺口不是「从零建」——仓内已有第三块实现：`services/devicePairing.js`（第 5 版按评审第 2 条补登，此前本文 0 处提及）**：文件头自述「Cryptographic device pairing and identity management」（`:3-18`，含 Ed25519 keypair 身份、SHA256 指纹、role hierarchy `owner > admin > operator > viewer` `:26-33`、token scope `:37-50`、配对生命周期 `request → approve/reject → active → revoke` `:16`），状态机含 `REVOKED` / `EXPIRED`（`PAIRING_STATE` `:54-60`），TTL `TOKEN_TTL_MS` 24h / `PAIRING_REQUEST_TTL_MS` 10min（`:62-63`）；API 面 `getLocalIdentity` `:157`、`createPairingRequest` `:192`、`approvePairing` `:237`、`revokePairing` `:278`、`validateToken` `:301`、`hasScope` `:345`。**它已经在被消费**：`webRemoteControl/pairingCode.js:19` 引入、`:58` 实例化 `DevicePairingManager`，`webRemoteControl/protocol.js:77` 注明「配对码有效期：与 `devicePairing.PAIRING_REQUEST_TTL_MS` 同值」。**但 agentHub 的四端链路与手机配对（`khy mobile app`）都没接它**——它是「桌面 Web 远控」那套配对，与 `cli/handlers/mobile.js` 的二维码载荷互不相干。**角色层级与本文「不做团队角色」不冲突**：`devicePairing` 的 `viewer` / `operator` 是**设备访问档位**（Web 远控面板的 `viewer` / `operator` / `reject` 三按钮即消费它，§7.4 形态③），不是「第二个有写权的人」——单人 owner 给同一台设备签不同 scope 仍然只有一个 owner 主体。因此本节的事实是：**设备身份有三块输入（会话链 / originGuard 族的裁决 / devicePairing 的现成机制），不是两块**；实施者若照本文前文（只有会话链与 originGuard）施工，会在一个已存在的设备身份机制之外再造一套，正是本文反复防的「第二套」。

设备身份由谁实现（改 `authenticateToken` 链、复用 `devicePairing.js`，还是 [DESIGN-ARCH-192] / [DESIGN-ARCH-216] 的选型产物）整体委托 §11.3 第 1 条；**选型落定前不得声称该层已达成，也不得用「自造设备头」「改挂宽豁免」「加 `requireLoopback` / `originGuard` 冒充设备校验」等临时手段凑数**——`requireLoopback` 只认回环地址（`originGuard.js:88-94`），手机与外网网页会被全量 403，直接击穿 §1.5 验收（详见 §3.4 表第 3 行、§5.2 第 4/5 条）。**同样不得「另造一套设备身份」而绕开 `devicePairing.js`**：本轮实测 [DESIGN-ARCH-192] 与 [DESIGN-ARCH-216] 两篇选型文档**各 0 次提及** `devicePairing`（关键字计数见 §12 B16），所以这条缺口不能靠「已委托给 216」兜住，必须作为决策输入显式带上（§11.3 第 1 条）。每台电脑各跑一份 agentHub 后端、各持有本机智能体清单；手机/外网网页保存设备列表，选哪台就管哪台。本期不做团队角色、不做多人审计归属。

- source：用户 2026-11-16 拍板「单人多机」（第 1、2、3、5 条）；写入 `works/data/khy/feedback/agent-hub/requirement-5q.md:171-182`。
- **待拍板（AI 自答）**：桌面端本期只管本机（桌面是那台电脑的界面，跨机由手机/外网网页承担）。用户未说桌面端是否也要设备列表；若需要，是后续扩展，不改本期通道（requirement-5q.md:182）。→ §11.2 第 1 条。

### 1.3 Q2 什么时候用？哪个端触发？

四个管理时机沿用第一版（新装纳管、改模型、配 MCP/导 skill/记忆、卸载；requirement-5q.md:186-193），新增两个由多机场景带来的时机：**换电脑/切设备**、**远程审批**。逐端触发：

| 端 | 触发场景 | 触发路径 | 写操作落点 |
|---|---|---|---|
| 网页 | owner 在任意浏览器（本机或外网）打开管理台，想看/改某台电脑 | 登录 → 选设备（本机为默认设备）→ 打开「智能体」页 | CH-4 `/api/agent-hub/*`，干跑 → 确认令牌 → apply |
| 桌面 | owner 坐在这台电脑前，要管本机智能体 | 打开桌面应用 → 侧栏「智能体」页 | CH-2 直调本机 service |
| 手机 | 人不在电脑前，或要临时处理另一台电脑 | 扫 `khy mobile app` 二维码配对 → owner 登录 → 设备列表选机 → 总表 | 远程 CH-4，打所选设备 |
| 终端 | 人在 shell 里，或脚本 / CI 要机读 | `khy agent-assets hub` / `hub --json`（目标态） | CH-3，管终端所在的那台电脑 |

（表内容照 requirement-5q.md:197-203，原样转录。**唯一需要加注的一格是网页行的「干跑 → 确认令牌 → apply」**：那是 5q 的简写，不是全档必经步骤——按 [DESIGN-ARCH-203] §6.1 分级，W1 资产写不需要确认令牌（203:414），只有 W2/W3/W3+ 才带令牌，W3+ 另加更高一级确认（203:417）。口径以 §6.5 / §7.4 为准。）

远程连回那台电脑必须**三要素齐备**：登录身份（owner 登录、真实令牌）+ 设备配对（保存设备列表，配对过期可续）+ 可达地址解析（局域网/公网 origin 由配对载荷下发）；**不得用 `127.0.0.1` 兜底**（requirement-5q.md:206-214）。

- source：用户原话「khyos我希望四端都提供一个统一管理电脑上所有智能体的位置」+ 用户 2026-11-16 拍板「四端全可写」（第 1、2 条）+ 拍板「单人多机」；写入 requirement-5q.md:184-217。
- **待拍板（AI 自答）**：终端只管它所在的那台电脑、本期不做终端跨机代理（requirement-5q.md:202、:397）。→ §11.2 第 4 条。

### 1.4 Q3 现在的替代做法是什么？

四端勘察计数（本轮任务给定，非本次复测）：网页 existing 6 / gaps 9；桌面 6 / 13；手机 10 / 9；终端 11 / 11。逐端实况（代码点为实测读取与实跑）：

**① 网页**——有零散管理物，没有统一入口：`/admin/agents` 路由存在（`delivery/web/ai-frontend/src/router/index.js:379-383`）却不在侧栏 NAV 的「管理控制台」组（15 项，`src/nav/index.js:119-169`，无 agents），唯一 UI 入口是 AIDashboard 的「查看全部」按钮（`src/views/admin/AIDashboard.vue:119`）；且该页数据源是后端进程内存的 worker agent 层级（`coordinator/workerAgent.js:1157-1201` 读 `_workers` / `_childrenOf`），不是外部智能体的安装/配置清单。模型切换只有 AIGateway 的「Agent 应用矩阵（CC-Switch）」12 个 agent 的模型卡（`src/views/admin/AIGateway.vue:349-358`），只管模型卡，不管装卸/MCP/资产。**② 桌面**——只有 KeyManager 写卡（`src/main/keyManager/agentWriters.ts:2` 自述「apply KeyManager cards to external agent live-configs」），无统一页。**③ 手机**——只有配对 + 聊天：只存单个 `apiBaseUrl`（`delivery/mobile/khy-os-client-app/lib/core/gateway/khyos_api.dart:92-115`），无外部智能体管理代码；pc-bridge 是纯聊天流（[DESIGN-ARCH-216]:59 的 E-A09：只映射 content/reasoning/done/error，不发工具事件）。**④ 终端**——`agent-assets` 注册表 6 家（`runtime/node/backend/src/services/domain/agents/agentAssets/registry.js:27-34`），实跑 discover 只报「6 家，合计 4 项」（§12 H1）；`hub` 子命令实跑退出码 1（未知子命令，§12 H2）。后端 `routes/agentHub.js` 与 `services/domain/agents/agentHub/` 均不存在（§12 A1）；`externalApps` 11 个适配器不含 qoder / workbuddy / kiro / cursor（§12 A2）。

- source：四端勘察计数为本轮任务给定材料；逐端代码点为实测读取与实跑（`git grep`、目录列举、node 读文件、`khy agent-assets discover/hub`）；写入 requirement-5q.md:218-260。

### 1.5 Q4 成功长什么样？（命令 + 期望输出，逐端）

> 命令分两类：**今天可跑的**给出实跑读数；**目标态**标注「未实现」——`agentHub` 路由与 service 今天都不存在（§1.4），跑不通就是跑不通，不记为已通过。

- **终端**：`khy agent-assets hub` 输出全实例总表（行粒度 = 实例，含状态、资产计数、MCP 数、模型摘要；未安装列检查过的路径）；`hub --json` 供四端同源比对。今天 `hub` 退出码 1，属目标态（§12 H2）。
- **网页**：`curl /api/agent-hub/overview` 无令牌 → **401（且非 404）**。验收**只断言状态码，不断言响应体形状**——`authenticateToken` 的 401 体只有 `{ success: false, message }`，两版实现都没有 `error.code` 字段（`runtime/node/backend/src/middleware/auth.js:178-183` 无 token、`:193-197` catch，`:145-172` 的 `sendAuthFailure` 各分支同形；`runtime/substrate/platform/packages/shared/src/middleware/auth.js:123-128` 同形）；`error.code` 只在 `runtime/node/backend/src/utils/apiResponse.js:193-196` 的 `fail()`→`error()` 路径，或 `shared/src/errorEnvelope.js:223`（`classifyKhyError`）/`:234-235`（STATUS_TABLE 命中）/`:306`（`toEnvelope`）的 envelope 路径产生，本中间件链一处都不走。原义是「命名空间漏挂载必须表现为 401 而非静默 404」([DESIGN-ARCH-203]:302，原文只要求状态码、未要求 body)，断言 `401 且非 404` 已覆盖。**这条验收必须写明打哪个 origin**（第 4 版按评审第 4 条补，否则与 §6.5 登记的 dev 404 后果互相打脸）：它打的是 **daemon（`aiManagementServer`）origin**——`/api/agent-hub` 按 [DESIGN-ARCH-203]:300-301 挂 daemon，而 203:302 的原义载体是 `__test__.getAgentHubApp` 的**进程内守卫测**（不经 vite、不经代理）；若改为对 dev-server 端口 curl，**前提是 §6.4 第 6 行的 dev 代理名单已补齐**——名单未补时整个 `/api/agent-hub` 被 `/api` 兜底转给 web 后端（`delivery/web/ai-frontend/vite.config.js:143-146` → `webBackendTarget` `:24`），读到的 404 是**代理配置造成的**，按本行原措辞会被误判成「命名空间漏挂载」（正是评审第 1 条与本文 §6.5 想防的方向）。带 owner JWT → 200，且 `instances[].id` 集合与终端 `hub --json` **逐项相同**（该集合的可比单元以 §4.4 的行粒度收口为准，见 §4.4 第 4 版补登）。UI 有「智能体」入口（四端入口名称互不相同，对照表与定名待拍板见 §9.5、§11.2 第 8 条）；写操作按 [DESIGN-ARCH-203] §6.1 分级走，**不是所有写都要确认令牌**：W1 资产写只要干跑计划 + 冲突清单（203:414 原文「不需要额外确认令牌」），W2/W3 才加写前备份 + 确认令牌（203:415-416），W3+ 另需单独的高一级确认并把 `losses[]` 摊开（203:417、:458）。
- **桌面**：`node` 直调 `agentHub/overview.js` 的 `buildOverview()`，id 集合与终端相同；页面逐行一致；全程零 HTTP（桌面不走 `/api/agent-hub`）。
- **手机**：`khy mobile app` 配对 → owner 登录 → 设备列表选机 → 总表与桌面同源 → `POST plan` 出干跑计划 → **只有需要令牌的档位**才走 `POST apply` 带 `confirmToken` → 回滚点 → `POST rollback`（W1 资产写按 [DESIGN-ARCH-203]:414「不需要额外确认令牌」，别把「apply 必带令牌」写成全档要求——见 §6.5、§7.4）；401 / 403 / 配对过期 / PC 离线 / **扫错二维码（既有防呆文案，`pairing.dart:119-142`）** / 设备不匹配各有明确降级文案（逐端载体见 §8.5）。**以下四处必须按「本期能不能验收」拆开写（第 4 版按评审第 9、10 条补，原文未拆；第 5 版把「跨设备确认令牌」也并入同一清单）**：
  - **A → B 切换**：`KhyOsConnection` 今天只有一条 SecureStorage 记录 `khyos_connection`，地址与令牌同存（`khyos_api.dart:92-119`、`:162-166`），`logout()` 删的是整条记录（`:254-267`）——**「逐设备登录 / 每设备各存一份凭据 / 按设备登出」在本文定义的接入面上不成立**：每台电脑各跑一份 backend、各有自己的 `JWT_SECRET` 与本机 DB（§3.4、§8.2），A 机签发的 owner JWT 到 B 机要么验签失败、要么查不到本机会话（`authSessionService.js:235-245` 用本机 `process.env.JWT_SECRET` 签、`:314` 验签、`:333` `User.findByPk`、`:358` `AuthSession.findByPk`）→ **401**。故「A 切 B 后总表、模型摘要、写目标、回滚点全部跟随 B」**本期不可验收**，与「跨设备令牌拒绝」同源，依赖 §11.3 第 1 条选型与 §8.5 行 1 的逐设备凭据口径；**不得靠「B 机沿用 A 的令牌」凑数**。
  - **配对过期**：**手机端 `lib/` 全树** `PAIRING_EXPIRED` / `配对过期` / `pairing_expired` **0 命中**（本轮 `git --no-pager grep -n -i -E "pairing_expired|PAIRING_EXPIRED|配对过期" -- delivery/mobile/khy-os-client-app/lib` 无输出）——但**全仓不是没有这件事**（第 5 版按评审第 1 条订正：原文写「全树 0 命中」是事实错误，正确范围是手机端 lib/）。既有事实：`PAIRING_EXPIRED` 是**已登记的错误码**——`runtime/substrate/platform/packages/shared/src/errorEnvelope.js:47`（hint「配对码已过期，在主端生成新码后重新配对」），`:139-140` 的 MESSAGE_TABLE 正则 `/pair(ing)?[_ ]?(code|expired)|session[_ ]?expired/i` 映射到它；后端另有 `utils/khyError.js:53`、`utils/khyErrorCategory.js:56` 同名登记，网页镜像 `classifyKhyError.mjs:16`、`:109` 已同步。实现侧也已有配对有效期：`webRemoteControl/pairingCode.js:78-83` 按 `expiresAt` 清码、`:93` 签发时写 `expiresAt = now + ttl`、`:106-108` 过期返回 `{ ok:false, code:'SESSION_EXPIRED' }`，TTL 取自 `devicePairing.PAIRING_REQUEST_TTL_MS`（`protocol.js:77` 注明同值）。**所以「本期不可交付」的理由不是「全仓没有过期」，而是手机配对链路不携带过期语义**——`khy mobile app` 的二维码载荷只有 `{ apiBaseUrl }`（`cli/handlers/mobile.js:145-148`），`pairing.dart:144` 也只解析出 apiBaseUrl，既无 `expiresAt` 也无凭据。要落这个态，须先让载荷带有效期并把上表那套现成 `PAIRING_EXPIRED` 码接到手机链路（错误面归 §11.3 第 2 条），故**本期不可验收**（原文只给设备不匹配码加了「依赖选型、本期不可验收」的标注，本条同步补齐，不给读者「本期可交付」的错觉）。
  - **PC 离线**：真载体是 `marketDescribeDioError` 的 Dio 分支——`connectionTimeout` / `receiveTimeout` / `sendTimeout` 在 `market_catalog.dart:617-623`、`connectionError` 在 `:624-627`（本轮实读）；`NETWORK_UNREACHABLE` + 带具体 origin 的文案口径按 §6.6。原文引用区间止于 `:606`，漏了这两支，已按实测补登到 §8.5。
  - **跨设备确认令牌**：**「A 的确认令牌对 B 下发必须拒绝并给明确错误码」本期不可验收**——它要求跨设备的令牌签发/消费边界（真源 requirement-5q.md:363），而本期接入面 `authenticateToken` 无设备绑定（§1.2 执行面缺口），该能力依赖尚未选型的身份/配对机制（§11.3 第 1 条），设备不匹配的错误码也仍待新增（§11.3 第 2 条）。403 的呈现面与文案口径另见 §8.4（既有手机 403 文案引导「换用管理员账号」，与单人 owner 口径不自洽，agent-hub 不得沿用）。
- **写操作**：四端共用 R/W1/W2/W3/W3+ 分级（[DESIGN-ARCH-203]:411-417；requirement-5q.md:351-364），远程不得绕过、不造第二套写者。
- **四端同源校验**：终端 `--json` 与各端 overview 的 `instances[].id` 集合必须一致（requirement-5q.md:342-349）；**状态列用什么字段比对以 §4.4 收口稿为准**（两值 / 两值+组合键 / 三值三案待契约决策员确认；未定前按 5q:280-281 的三档状态 + `checked[]` 判定）；任何一端少一行、状态不同、数字不同都算失败，不允许各端自己算一份。

- source：用户原话 + 用户 2026-11-16 拍板「四端全可写」（第 2、3、4 条）+ 拍板「单人多机」（第 4、6 条）+ [DESIGN-ARCH-203] §4 / §6.1；写入 requirement-5q.md:262-373。注：所有目标态命令今日不可跑（agentHub 未实现），不计通过。

### 1.6 Q5 不做会怎样？（不做清单）

1. 四端继续各自为政：网页是内存 worker 监控、桌面只有写卡、手机只能聊天、终端只认 6 家，「统一位置」不存在，四端看到的不是同一件东西。
2. 远程管理不存在：手机/外网网页无法管 PC 上的智能体，人必须回到电脑前。
3. 单人多机没有设备清单：手机只存一个 `apiBaseUrl`，换机器要重新配对。
4. 写操作无统一分级与回滚：W2/W3/W3+ 只活在设计文档，远程删数据会从显式决策退化成误触。
5. 未纳管黑洞持续：注册表 6 家，点名的 zcode / workbuddy / command code / kiro / trae / qoder / cursor 不在表内，实跑 discover 只报 6 家 4 项。
6. 换工具资产清零的代价继续由人肉承担（`docs/17_AI协作预设包/给AI看/功能提示词-03-外部Agent资产管理.md` 开篇原话）。

- source：用户原话「四端都提供一个统一管理电脑上所有智能体的位置」+ 两次拍板；第 1–5 条现状形态为实测代码证据，第 6 条为既有文档原话；写入 requirement-5q.md:375-384。

### 1.7 确认状态

- 用户已拍板：四端全可写、单人多机（含「远程端与桌面端必须走同一个 agentHub 服务、同一套确认令牌语义，不造第二套写者」，requirement-5q.md:166-167）。
- **AI 自答待确认 9 条** + **用户保留待拍板 2 条** + **委托契约决策员 6 条**，全文见 §11。**第 4 版把正文里散落的 4 项未决项回登为 §11.2 第 6–9 条**（终端 W2/W3 命令面缺口、桌面入口落点、四端统一定名、手机新页宿主）——原文只在 §2.3 / §7.4 / §8.6 / §9.4 各处出现且指向错位，按 §11 收口会被误当已决（评审第 7、11、12 条）。凡本文正文中标「待拍板」处，实施前不得自行定案。

---

## 2. 总扩面裁决：一个 service、四端三条暴露路径

> 本节对应上游草稿编号 §14.1。它不推翻 [DESIGN-ARCH-203] §0–§13 的既有裁决；与原文不一致处一律写「订正记录」留痕（集中在 §3.6）。引用行号为本轮实测（2026-11-16）；`handlers/agentAssets.js` 等工作树有未提交改动，落笔前以现场 `Select-String` 定位为准。
> 口径来源：用户 2026-11-16 拍板「四端全可写」与「单人多机」（`works/data/khy/feedback/agent-hub/requirement-5q.md:150-153`；source 行 :167、:216）。

### 2.1 总裁决

四端（网页 / 桌面 / 手机 / 终端）共用同一份 `services/domain/agents/agentHub/` service 与同一套 R/W1/W2/W3/W3+ 分级、确认令牌语义，**不造第二写者**（拍板原文「远程端与桌面端必须走同一个 agentHub 服务、同一套确认令牌语义」，requirement-5q.md:166-167）。三条暴露路径：

1. **桌面 CH-2**：Electron main `createRequire` 载同一 service，renderer 经 preload IPC，零 HTTP、零 token。
2. **网页 + 手机 CH-4**：同一 `/api/agent-hub` 命名空间，同一套 `authenticateToken`。
3. **终端 CH-3**：`khy agent-assets hub` / `hub --json`，handler 内 CH-2 直调同一 service。

### 2.2 端 × 通道总表

| 端 | 载体（仓内路径） | 通道判定（[DESIGN-ARCH-071] 五问） | 鉴权语义 | 依据 |
|---|---|---|---|---|
| 网页 | `delivery/web/ai-frontend` | CH-4：前端/远程/并发命中第 4 问（[DESIGN-ARCH-071]:39）；`:53` 禁止前端 L3 require 后端 L2。本端智能体数据今天全部走 axios（`src/api/request.js:13`，baseURL 取 `VITE_AI_API_BASE_URL`） | Bearer owner JWT，经 `authenticateToken`（`middleware/auth.js:175-199`，无回环豁免） | [DESIGN-ARCH-203]:111；requirement-5q.md:197-199 |
| 桌面 | `apps/khyos-desktop`（Electron） | CH-2：同一 Node 进程语义（[DESIGN-ARCH-071]:34-35）；既有裁决见 [DESIGN-ARCH-203]:110-113 与 §6.3 `:465-467` | 无 HTTP 鉴权；renderer → main 走 preload IPC（进程内边界，§6.3 `:467`） | `host/index.ts:3-4` 文件头自述 CH-2；`:68` 定义 `nodeRequire`，`:128` 等载入后端模块（`:124-130` 实测）；`App.tsx:161-163` 无登录门注释 |
| 手机 | `delivery/mobile/khy-os-client-app`（Flutter） | 远程 CH-4：第 4 问命中（[DESIGN-ARCH-071]:39）。CH-2 物理不成立（Dart 进程无 Node 运行时，`pubspec.yaml:7`、`:10-11`）；CH-3 前置「本机可运行 khy」（`:16`）不成立 | 同一 `authenticateToken`：owner Bearer JWT（**由登录获得**，`khyos_api.dart:192`）；可达 origin 由配对载荷下发（`cli/handlers/mobile.js:145-148`），不得 127.0.0.1 兜底 | requirement-5q.md:202、:206-214；`khyos_api.dart:192` login、`:216-233` refresh、`:261/:275/:410-411` Bearer 头（本轮抽查） |
| 终端 | `khy` CLI | CH-3：人/脚本/CI（[DESIGN-ARCH-071]:38）；机器高频消费优先 `--json`（`:54`）；handler 内同进程 CH-2（`:34-35`） | 本机执行面，无 HTTP 鉴权、不需 JWT；写操作仍受分级与干跑 / `--apply` 约束（见 §5.3） | [DESIGN-ARCH-203] §4.4 `:306-330`；requirement-5q.md:202 |

### 2.3 每端一句话

- **网页**：登录 → 设备列表选机 → 总表与写操作全部走 `/api/agent-hub`；多设备时目标 origin 来自设备列表/配对，不新增第二套 baseURL 常量（工程规则 1：端点只来自 env / 运行时发现 / 服务注册表三类合法来源）。
- **桌面**：主进程 `createRequire` 载同一 service、renderer 经 preload IPC，全程零 HTTP、零 token；桌面打 `/api/agent-hub` 是明令反模式（[DESIGN-ARCH-203]:470——没有 token 必 401）。
- **手机**：先配对拿可达 origin、再 owner 登录拿 JWT，之后对所选设备打同一命名空间；手机有登录能力，[DESIGN-ARCH-203] §2.1「无登录态走 HTTP 必 401」的论证只对桌面成立，不可照搬。
- **终端**：`hub` / `hub --json` 只做总表呈现（§4.4），管终端所在的那台电脑、不做跨机代理（requirement-5q.md:202，AI 自答待确认）。**终端今天的写腿只有 W1（资产写）**：`import / export / sync`（`handlers/agentAssets.js:446-463` 分派、`:420-425` 的 `--apply` 帮助）= W1；**W2 改模型、W3 装卸程序本体在 CLI 没有任何命令落点**——`commandSchema.js:641-651` 的 9 项里没有模型/装卸动词，实跑 `khy agent-assets hub` 亦只回「未知子命令:hub。可用:discover / caps / list / plan / import / export / sync。」（§12 H2）。故拍板① 的「装/卸、改模型」在终端这一端**本期未覆盖**，登记为 §11.2 第 6 条待定；**不得据 §2.1「四端共用一套分级」反推终端已具备 W2/W3**（分级是语义契约，不是既有命令面）。

### 2.4 四端 surfaces 裁决原文

| 端 | 通道裁决（原文要点） | 详细落点 |
|---|---|---|
| 网页 | CH-4 Web API（`/api/agent-hub`，`authenticateToken` JWT）；本端职责 = 登录 → 设备列表选机 → 总表与写操作（requirement-5q.md:197-199）；目标 origin 来自设备清单/配对，不新增第二套 baseURL 真源 | §6 |
| 桌面 | CH-2 服务直调（Electron main `createRequire` 载 agentHub service；renderer 经 preload IPC，全程零 HTTP）；单人多机后桌面本期仍只管本机（AI 自答，requirement-5q.md:182） | §7 |
| 手机 | 远程 CH-4（同一命名空间；**可达 origin 由配对载荷下发，owner Bearer JWT 由登录获得**——扩面决定原文「配对载荷下发 origin + owner Bearer JWT」已由 §8.3 按实测订正，本表跟随订正后口径）；硬前提三条见 §3.4 / §5.2 | §8 |
| 终端 | CH-3（`khy agent-assets hub` / `hub --json`；handler 内 CH-2 直调）；只扩展、不新增（[DESIGN-ARCH-203] §4.4 `:306-330`） | §4、§9 |

（裁决理由的逐条展开分布在上表「详细落点」各节；本节不重复抄录。）

### 2.5 范围排除

**不为 khyquant 前端与 provider-hub 开条目**。两条的完整理由收在 §10 不做清单（第 1、2 条），此处不重复。

### 2.6 与既有阶段裁决的关系（第 3 版订正）

**先把事实写准**：[DESIGN-ARCH-203] §8 的写操作确认令牌闸门**尚未登记**，不是「仍为 S1 观察者档」。203 §8 给的是**登记建议**——其 `:502-525` 的建议条目 `id=agent-hub-write-confirm-gate`（`:508`）、`stage: 'S1'`（`:513`）、`executorStage` 必填（`:516-520`），`samples` 与 `rollback` 也在建议里；但实测 `docs/10_规范/registry/FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms` 共 **40 条**（全部 `stage=S1`），`agent-hub` / `agentHub` / `agent_hub` / `AGENT_HUB` / `确认令牌` 五个关键字**命中 0**（§12 B15）；且执行器 `planner.js` 今天不存在（`services/domain/agents/agentHub/` 整个目录 ABSENT，§12 A1）。所以正确写法是「**落地时同批登记为 S1**」，不是「已在册、仍为 S1」。四端扩面只增加样本来源，**不改变阶段、不构成升阶理由**（`AGENTS.md` 规则 8 / `PROCESS-008`：升阶看样本量、一次一阶）。

**四端扩面新增或依赖的四个拦截面，落地时按同一张表登记**：

| 拦截面 | 语义与本文落点 | 是否本期 | 登记要求 |
|---|---|---|---|
| a) 未登录 · 未配对拒绝 | §1.2 `:36-41`、§5.2 第 5 条。**「未登录」复用现有 `authenticateToken` 的 401，不算新机制**；「未配对」是 §11.3 第 1 条的选型产物 | 「未配对」**非本期** | 选型落地同批登记 `stage=S1` |
| b) 设备不匹配码（跨设备令牌拒绝） | §1.5 手机行、§11.3 第 2 条；语义原文 requirement-5q.md:363 | 码值属 §11.3 第 2 条新增；**拒绝行为的验收非本期**（§1.5 已标） | 新拒绝分支落地同批登记 `stage=S1` |
| c) 远程二次审批 / 生物识别 | §11.1 第 1 条、§3.5 | **否**——用户未拍板 | 若拍板要做，同批登记 `stage=S1` |
| d) 后端 `requireAdmin` | §6.2、§11.3 第 6 条 | **否**——委托项未定 | 若叠加，同批登记 `stage=S1` |

每行的登记要求统一为：`stage=S1` + `executorStage.{file, constant}` + `samples` + `rollback`。**缺 `executorStage` 则漂移校验不生效**——`scripts/ci/check-rollout-stage.js:485-527` 的入口条件是 `if (auth && auth.file && auth.constant)`（`:486`），不满足就整段跳过，「登记说 S1、代码其实在拦」这条防护对该机制完全不起作用（[DESIGN-ARCH-203]:527 §11 R5 同判；登记表实测 40 个 mechanism 里 33 个带 `executorStage.file` + `constant`、7 个不带，名单见 §12 B15）。硬红线：禁直进 S3（PP-1 / `rollout-stage-skip-s1`）、S1/S2 不得阻断（PP-3）、一次只升一阶（PP-6）。

---

## 3. agentHub 注册表的端维度

> 本节对应上游草稿编号 §14.2。本组九条注册表/文档级裁决的落点如下（第 1、2、3、4、5、6、9 条落本节；第 7、8 条落 §4）：

| # | 裁决（一句话） | 落点 |
|---|---|---|
| 1 | `AGENT_HUB_SOURCES` 不增「端」维度 | §3.1 |
| 2 | `tier` 字段注释补一句（写能力与调用端无关） | §3.2 |
| 3 | [DESIGN-ARCH-203] §2.1 文案修订为「四端三条暴露路径」 | §3.6 |
| 4 | 新增「每端暴露矩阵」一节（文档级、非注册表字段） | §3.3 |
| 5 | `/api/agent-hub` 鉴权裁定（只挂 `authenticateToken`） | §3.4 |
| 6 | 手机端写分级裁定（与网页同档、不做角色裁剪） | §3.5 |
| 7 | 终端子命令同步基线修订（先补存量漂移，再加 `hub`） | §4.2 |
| 8 | `hub --json` 字段集合收口稿（**待契约决策员确认，非定稿**） | §4.4 |
| 9 | 不做清单增补两条 | §10（第 2、3 条；§3.7 留裁决摘要） |

### 3.1 裁决：`AGENT_HUB_SOURCES` 不增「端」维度

表项形状维持 [DESIGN-ARCH-203] §3.2（`:189-195`：`id / label / module / vendor / kind / tier / assetsModule / configModule / evidence`），不加入 `visibleOn` / `writableOn` / `surfaces` 之类端字段。

理由：注册表的语义是「声明后端主机磁盘事实」——与 `agentAssets/registry.js:21-26` 的字段注释（只有 id / label / module 三样）和 `:27-34` 的六条表项实测同构；「支持哪几类资产、能不能写、资产根在哪」全部由适配器 `detect()` / `capabilities()` 自证（`registry.js:4-9` 头注释同判）。「哪端可见、哪端裁剪」是 UI 政策，由各暴露层（桌面归一层 / CH-4 路由层 / CH-3 formatter / 手机薄归一）各自裁剪——写进注册表它就从「磁盘事实」漂成「UI 政策」，四端共享一张表的前提也被破坏。

### 3.2 `tier` 字段语义补注（防误读）

在 [DESIGN-ARCH-203] §3.2 字段清单处补一句：`tier` 描述适配器对**后端主机磁盘**的写能力，由 `capabilities()` 自证（[DESIGN-ARCH-203]:230），**与调用端无关**——不得把「手机端」「终端」误解成 read-only / assets tier。tier 不足的操作在 UI 置灰并说明原因，不造「看起来能点、点了报错」。

### 3.3 每端暴露矩阵（文档级，非注册表字段；置于 [DESIGN-ARCH-203] §3.2 注册表之后）

| 端 | 暴露路径与装配 | 通道判定 | 鉴权 | 待拍板 |
|---|---|---|---|---|
| 网页 | CH-4 `/api/agent-hub`；多设备时目标 origin 来自设备列表/配对，不新增第二套 baseURL 常量 | [DESIGN-ARCH-071]:39、:53 | Bearer owner JWT（`authenticateToken`） | 网页页角色门：挂 `/admin` 需 `ROLE.ADMIN`（`nav/index.js:121`）还是顶层入口（requirement-5q.md:411 委托第 5 条）。**用户可见后果**：不升出去则非 ADMIN 的 owner **侧栏整组不可见**（`:121`，组 15 项 `:123-167`），不是灰显 |
| 桌面 | CH-2 服务直调：Electron main `createRequire` 载 agentHub service，renderer 经 preload IPC，全程零 HTTP | [DESIGN-ARCH-071]:34-35；[DESIGN-ARCH-203]:110-113 | 进程内，无 token（renderer → main IPC） | 桌面是否也要设备列表（requirement-5q.md:394 AI 自答第 1 条，待确认） |
| 手机 | 远程 CH-4：同一命名空间；**可达 origin 由配对载荷下发**（`cli/handlers/mobile.js:145-148` 现状只含 `apiBaseUrl`），**owner JWT 由登录获得**（`khyos_api.dart:192`），非配对下发 | [DESIGN-ARCH-071]:39 | Bearer owner JWT（JWT_SECRET + DB 用户） | W2/W3/W3+ 是否加二次生物识别/独立审批（requirement-5q.md:402） |
| 终端 | CH-3：`khy agent-assets hub` / `hub --json`；handler 内 CH-2 直调 | [DESIGN-ARCH-071]:38、:54、:34-35 | 本机执行面，无 HTTP 鉴权（见 §5.3） | 终端是否做跨机代理（requirement-5q.md:397 AI 自答第 4 条：本期不做） |

说明：矩阵回答「哪个端从哪条路径看到同一份表、用哪种鉴权」，是文档级解释，不是 `AGENT_HUB_SOURCES` 的字段。桌面已有的「四端互跳」菜单组（`TitleBar.tsx:136-137`、`:204-208`：打开网页版 / 下载 Android 版 / 下载桌面版，本轮实测）说明四端互指是产品既有概念，矩阵与之对齐即可；agent-hub 的跨端入口若挂桌面菜单，应与该组并列并注明各端可达性。

### 3.4 `/api/agent-hub` 鉴权裁定（补进 [DESIGN-ARCH-203] §4.3）

只挂 `runtime/node/backend/src/middleware/auth.js:175-199` 的 `authenticateToken`（导出名见 `:267-275`）：`:176` 取 Bearer token → `:186` `authSessionService.authenticateAccessToken` → `authSessionService.js:307-320`（`:314` `jwt.verify(token, process.env.JWT_SECRET)`）；`:178-183` 无 token 401、`:193-197` 异常 401，全段无回环/本机豁免。**鉴权语义 = 仅用户 JWT**。

不使用 `aiManagementServer` 自管 `authenticate()`（`runtime/node/backend/src/services/aiManagementServer.js:1198-1261`：`:1198-1222` JWT Bearer、`:1224-1235` X-API-Key、`:1248-1261` `AI_MGMT_ALLOW_LOOPBACK_ADMIN` / `AI_MGMT_ALLOW_LAN` opt-in 豁免）作为本命名空间接入面——那是 daemon 旧管理页的另一套鉴权语义，引入即第二套鉴权。

ecoMarkets 样板（`aiManagementServer.js:385-386`：`:385` 从 `khy-ai-backend/middleware/auth` 解构 `authenticateToken`、`:386` `a.use('/api/eco-markets', authenticateToken, require('../routes/ecoMarkets'))`）：注意该 import 走的是包 exports 映射（`runtime/node/ai-backend/package.json:8` → `runtime/node/ai-backend/src/middleware/auth.js:1` → re-export `@khy/shared/middleware/auth`）。**「同为 JWT-only」这句只对 `authenticateToken` 这一个符号成立，不对整个 auth 模块成立**，必须与同模块的另一个导出分清：


| 符号 | 后端本地版（本节选定的接入面） | shared 版（样板实际 import 的那一份） |
|---|---|---|
| `authMiddleware` / `authenticateToken` | `backend/src/middleware/auth.js:175-199`——`:176` `extractBearerToken` → `:186` `authenticateAccessToken`，`:178-183`/`:193-197` 两处 401；无 X-API-Key、无回环豁免。导出映射 `:271` | `shared/src/middleware/auth.js:119-155`——`:121` 取 Bearer、`:130` `jwt.verify(token, process.env.JWT_SECRET)`；无 X-API-Key、无回环豁免。别名 `authenticateToken = authMiddleware` 在 `:218` |
| `flexibleAuth`（**另一条腿，本命名空间禁挂**） | 同文件 `:217-260`——Bearer 分支 `:218-234`、X-API-Key 分支 `:236-254`、两者皆无时 401「需要认证（Bearer Token 或 X-API-Key）」`:256-259` | 同文件 `:169-215`——Path A JWT `:170-190`、**Path B X-API-Key `:192-211`**、两者皆无时 401「Authentication required (Bearer token or X-API-Key)」`:213-214` |
| `originGuard` / `requireLoopback` 族（**第 2 版新增：同模块再导出的第三族，本命名空间禁挂**） | 同文件 `:273-278` 再导出 6 个符号（`ALLOWED_ORIGINS_ENV` / `requireLoopback` / `originGuard` / `isLoopbackAddress` / `isTrustedBrowserOrigin` / `parseAllowedOrigins`），实现在 `middleware/originGuard.js`——`requireLoopback` 对非回环连接回 403「仅允许本机访问」（`originGuard.js:88-94`）、`originGuard` 拒绝不可信浏览器来源（`:96-102`），白名单走 env `KHY_ALLOWED_ORIGINS`（`:22`）；现有消费者 `routes/daemon.js:33`、`:38` | shared 版无此族——shared `middleware/auth.js` 不导出 originGuard 任何符号（模块导出面只有 `authMiddleware` / `adminMiddleware` / `flexibleAuth` / `authenticateToken` / `requireAdmin`，`:221-227`） |
| **会话撤销 / tokenVersion（两版实质差异，第 2 版补登）** | **有**：`:186` 走 `authSessionService.authenticateAccessToken`，查会话存在/吊销/过期（`authSessionService.js:358-370`）与 `tokenVersion`（`:372-382`）；撤销 API 在册（`revokeSessionById` `:399-415`、`revokeUserSessions` `:417-437` 含 `excludeSessionId`、清单 `listUserSessions` `:513`） | **无**：`:119-155` 只做 Bearer → `jwt.verify` → `User.findByPk` → status 校验，**全程不查 AuthSession**——令牌被撤销后仍有效，只能等自然过期 |

所以「照 ecoMarkets 样板同款挂载」拿到的是 JWT-only 那一份（样板只解构 `authenticateToken`；实测 `aiManagementServer.js` 现有挂载 `:326` / `:346` / `:386` / `:429` / `:446` 全部只用 `authenticateToken` 与 `requireAdmin`，`flexibleAuth` 零使用；被挂路由自身头注释同判——`routes/ecoMarkets.js:9`「鉴权挂在挂载点（authenticateToken），与 proxy-subscriptions / gui-eval 同款」），**不会**因此获得 X-API-Key 旁路。但符号选错即旁路成立：实施时解构名必须是 `authenticateToken`，**不得误取 `flexibleAuth`**（误取即与 §5.2 第 4 条「拆宽豁免」、§8.2 第 2 条「手机不能用 X-API-Key」直接冲突），**也不得取 `originGuard` / `requireLoopback` 族充当「设备校验」**——`requireLoopback` 会把手机（LAN/公网 origin）与外网网页全量 403 挡死，直接击穿 §1.5 的手机/网页验收与「四端全可写」拍板。

**import 源必须用后端本地版，除「同包」外还有一条语义理由（第 2 版补登）**：`requirement-5q.md:175` 口径是「登录后拿到**可撤销**的凭据」——只有 backend 本地版校验会话吊销与 `tokenVersion`（上表第 4 行），shared 版不查 AuthSession，令牌撤销后仍可用。现状 `aiManagementServer.js` 全部 5 处解构（`:325` / `:345` / `:385` / `:428` / `:445`）都走 `khy-ai-backend/middleware/auth` → shared，即**本仓所有管理命名空间今天都不校验会话吊销**——这是既有事实，不是本文引入；agent-hub 不沿袭它。「照 ecoMarkets 样板」因此限定为**照其挂载形状** `a.use(<命名空间>, authenticateToken, <router>)`，**不是照其 import 源**（[DESIGN-ARCH-203] §4.3 `:300` 只写「+ `authenticateToken` +」，本就未指定 import 源）：import 必须用后端本地 `middleware/auth`（与 `routes/agentHub.js` 同包，挂载与测试同一套路径，且可撤销语义成立），不走 `khy-ai-backend/middleware/auth` 的 re-export，两套实现不得一处挂一个。

手机硬前提：部署须有 `JWT_SECRET` + DB 用户——`/api/auth/login`（`aiManagementServer.js:2327-2328` → `handleAuthLogin` `:1369`）的 builtin 分支（`:1405-1424`）返回 `builtin-<时间戳>-<hex>` token（`:1410`），**不是 JWT**，过不了 `authenticateToken`（`authSessionService.js:314` 要求 `jwt.verify` 成功）；无 `JWT_SECRET` 时登录直接 500（`:1429-1434`）。不得为手机改挂宽豁免、不得造 X-API-Key 旁路。

### 3.5 手机端写分级裁定

依 2026-11-16 拍板「四端全可写」（requirement-5q.md:150-153、:167、:216）+ Q1「单人 owner、不做团队角色」：手机与网页同为远程写端，共用 R/W1/W2/W3/W3+ 分级与确认令牌，不封顶 read-only / assets；不引入 Web 的 `ROLE.ADMIN` / `requiredRole` / `isAdminPath` 角色裁剪（那是 `delivery/web/ai-frontend` 的团队角色机制，`nav/index.js:121` 的 `requiredRole: ROLE.ADMIN` 即该机制；Q1 已裁不做）——`authenticateToken` 通过即 owner 本人。W2/W3/W3+ 在手机上是否加二次生物识别/独立审批：用户明确保留待拍板（requirement-5q.md:402），矩阵该格标「待拍板」，实施前不得自行加严或放宽、不得默认实现第二套审批机制。

### 3.6 订正记录：[DESIGN-ARCH-203] §2.1 文案修订

- **原文**（`:15`）：「一个 service、两条互不重叠的暴露路径，两个前端表面」。
- **订正为**：「一个 service、四端三条暴露路径」——桌面 CH-2（`createRequire` 载同一 service，零 HTTP 零 token）、网页 + 手机 CH-4（同一 `/api/agent-hub` 命名空间，同一套 `authenticateToken`）、终端 CH-3（handler 内 CH-2 直调同一 service）。
- **依据**：手机是 Flutter/Dart 进程（`pubspec.yaml:1` name=khy_os_client、`:7` dart sdk ^3.13.2、`:10-11` flutter sdk），无 Node 运行时，CH-2 的「同一 Node 进程」前提物理不成立（[DESIGN-ARCH-071]:15、`:34-35`）；CH-3 的前置「本机可运行 khy」（`:16`）对手机也不成立；故手机必须走远程 CH-4（第 4 问命中，`:39`）。
- **不推翻的部分**：[DESIGN-ARCH-203] §2.1 对桌面「无登录态、走 HTTP 必 401」的论证仍然成立（`App.tsx:161-163` 注释仍在；桌面 src 全树 grep `/api/` 仅 2 处命中且均非后端消费——`keyStore.ts:760` 外部供应商 OpenRouter URL、`renderer/i18n/zh-CN.json:3185` 示例文案，本轮复验），且**只对桌面成立**——手机有完整 JWT 链，不可照搬。
- **共用语义不变**：四端共用一套 R/W1/W2/W3/W3+ 分级与确认令牌语义，不造第二写者（拍板原文，requirement-5q.md:166-167）。

### 3.7 不做清单增补两条（裁决摘要）

1. 不并入 provider-hub（`delivery/web/provider-hub`）：独立 Electron GUI，自带写腿，并入即第二套 provider/agent-model 写者与第五个暴露面；写者归并另案，本期不改其契约。
2. 跨设备批量操作 / 跨设备资产同步维持不做；设备列表（选哪台管哪台）不在其列——那是单人多机拍板已定的范围。

（两条全文与理由见 §10 第 2、3 条，此处不重复。）

---

## 4. 终端面（khy agent-assets hub · CLI/TUI）

> 本节对应上游草稿编号 §14.3。

### 4.1 判定与约束

终端面 = **CH-3**（[DESIGN-ARCH-071]:38：人 / Shell 脚本 / CI / 跨语言）；`hub --json` 并行提供，因为该矩阵 `:54` 要求机器高频消费优先 `--json`。handler 内调同一 service 是**同进程 CH-2**（`:34-35`），不是第二条写路径。

**不新增顶层 CLI 命令**：命令面只扩 `khy agent-assets` 子命令。[DESIGN-ARCH-203] §4.4（`:306-330`）已裁「只扩展、不新增」，依据是 `checkSurfaceRatchet` 数四个数（命令 / 别名 / handler 文件 / 规则登记，计法见 `scripts/ci/check-delivery-baseline.js:615-648`，复核记录见 [DESIGN-ARCH-203] §13.3 F21）——棘轮只降不升。**守卫强度按实测写明，不照抄 [DESIGN-ARCH-203]:316 的「超基线即 error」**：`check-delivery-baseline.js:668` 确实以 `error` 登记 `delivery-surface-ratchet-breach`，但同文件 `:69` `STAGE = 'S1'`、`:72` `OBSERVER_STAGES`、`:771-775` 在非 `--strict` 时把 error 降级为 warning 并恒 exit 0——准确表述是「**登记 error、S1 观察档降级 WARN 不阻断**」（`AGENTS.md` 规则 12 同判）。本轮实跑 `node scripts/ci/check-delivery-baseline.js`（即 `npm run check:delivery`）：EXIT=0、`Summary: 0 error(s), 5 warning(s)`，其中棘轮一项读数为 `routerCommands=249/245 · aliasEntries=595/591 · handlerFiles=167/155 · ruleCount=101/94`——**四个数在本仓当前工作区已全部破基线**。破口是既有工作区状态（agentHub 与 `hub` 今日都不存在，§12 A1、H2），不是本功能造成的；用「棘轮只降不升」论证「不新增顶层命令」时须同时说明这一点，否则读者会误以为本仓棘轮尚在基线内。机械结论仍成立且可核对：加 `hub` 子命令不动这四项计数（`:619` 只数 `commandSchema.js` 的 `ROUTER_COMMANDS` 顶层数组、`:629` 数 `aliases.js` 里的 `command:` 条目、`:635` 数 `handlers/*.js` 文件、`:641-648` 数登记表 rules 条数）；若实施时另为 `hub` 新增别名条目，**写进 `aliases.js` 才会让 `aliasEntries` +1、写进 handler manifest 不计**（计法实测见 §9.4 ②），届时按规则 12「先退役再登记」处理。

### 4.2 五处同步清单（照 [DESIGN-ARCH-203] §4.4 `:320-326`，行号本轮实测 2026-11-16）

| # | 文件:行（实测） | 现状 | 要改什么 |
|---|---|---|---|
| 1 | `runtime/node/backend/src/constants/commandSchema.js:641-651` | `'agent-assets'` 子命令 9 项：`discover / caps / capabilities / list / plan / import / export / sync / help`；无 `hub` | 加 `'hub'`。`router` 只认这里的词才进 `subCommand`，否则 `hub` 被当散落 token 扔进 `args`（[DESIGN-ARCH-203] §4.4 表第 1 行） |
| 2 | `runtime/node/backend/src/cli/handlers/agentAssets.js:446-463`（函数体 `:433-470`） | 分派 if 链：`discover` `:446` / `caps`+`capabilities` `:449` / `list` `:452` / `plan` `:455` / `import`+`export`+`sync` `:458` / `help` `:461`；无 `hub` | 加 `if (sub === 'hub') return _handleHub(args[0], options)`；`:437` 的 `args[0]` 回退是兜底，不是正门 |
| 3 | `runtime/node/backend/src/cli/handlers/agentAssets.js:466` | 未知子命令菜单只列 7 个（`discover / caps / list / plan / import / export / sync`），不含 `capabilities` / `help`，也没有 `hub` | 补 `hub`；`capabilities` / `help` 是否入菜单与 #4 的存量漂移一并定 |
| 4 | `runtime/node/backend/src/cli/handlers/agentAssets.js:474-482` | manifest：`usage` `:478` 与 `subCommands` `:479` 均只有 6 项（`discover / caps / plan / import / export / sync`），比 commandSchema 少 `list` / `capabilities` / `help` | **先补存量漂移到 9 项，再加 `hub`**；`:478`、`:479` 两行一起改 |
| 5 | `runtime/node/backend/src/cli/handlers/agentAssets.js:409-427` | `_printHelp()`；`:410-411` 的「已接入家数」从 `registry.AGENT_ASSET_SOURCES` 推导，`:413-419` 是子命令清单区 | 加 `hub` 一行；若 `hub` 展示 agentHub 登记表全量，`:411` 的推导源须换成 agentHub 注册表，否则两表家数不一致 |

**顺序（以并集为准）**：先补存量漂移，再统一加 `hub`。本轮实测三处互不一致——commandSchema 9 项、错误菜单 7 项、manifest 6 项；只改一处会让「补全能敲、帮助不列、清单不认」并存。基线取 9 项并集。

**规则 7 说明**：本清单全是「加分支 / 加词」，不含删除动作；若实施时改为删除旧子命令或旧帮助行，须先按规则 7 报部位（`scrub-plan.md` + 可执行的 `rollback.txt`），不得顺手清理。

**行号稳定性**：[DESIGN-ARCH-203] §4.4 `:328` 已注明这些文件有未提交改动、行号会漂移；落笔前用 `Select-String` 现场定位，不照抄本节数字。

### 4.3 TUI 侧入口：不是第六处同步点

- **耦合实测**：对 `runtime/node/backend/src/cli/tui/` 全树检索 `agent-assets` / `agentAssets` → **0 命中**；该目录本轮计数 **211 个 `.js` 文件**（node 递归计数，§12 F4）。差异登记：勘察材料记「tui/ 83 个文件」，与本轮 211 个 `.js` 的口径不同（未复现其计法），零命中结论不受影响。
- **也不是独立清单**：TUI 的补全/菜单从 SSOT 派生——`cli/tui/hooks/useCompletions.js:23` 并入 `slashExtraCommands`（与经典 REPL 共用）、`:32` require `router`、`:42` 读 `router().SLASH_COMMANDS`、`:75` 用 `commandSchema.getBuiltinSlashCommands()`、`:105` 用 `commandSchema.getMenuSubCommands()`。子命令建议来自 commandSchema，故 `:641-651` 加 `hub` 后 TUI 子命令建议理论上自动跟随。
- **结论**：`hub` 在 TUI 命令面板/补全里的实际可见性属**实现期验证项**（本轮未实跑 TUI），不是第六处同步点，也不新增代码面。

### 4.4 `hub --json` 字段集合收口稿（文案级；与 overview 同源，formatter 只投影不重算；**待契约决策员确认，非定稿**）

```text
顶层: { ok, degraded?, generatedAt, host?, instances[], unregistered[] }
instances[] 每行:
  { id, label, kind, tier,
    status: 'installed' | 'not-installed',
    version?, hitSources[], checked[],
    assets: { memory, tool, skill },
    mcpCount, modelSummary, notes? }
```

- **列来源对齐 [DESIGN-ARCH-203] §5.2**（`:385`）表格列（安装状态 / 版本 / 形态 / tier / 模型摘要 / MCP 数 / skill 数 / 记忆数）：`status / version / kind / tier / modelSummary / mcpCount / assets.memory / assets.skill` 逐列对应。**有一列今天对不上（第 4 版按评审第 13 条订正）**：203:385 的列清单**没有「工具数」**，而本稿 `assets.*` 含 `tool`、requirement-5q.md:275 的样表首行又确有「工具」列——三处口径未收口。要么实现时按 5q 样表加「工具」列（则 203:385 需补列），要么 `assets.tool` 只进 JSON 不进表格；两条都属契约决策员一并定的事（§11.2 第 3 条），本文不代裁。
- **行粒度是实例、id 粒度是品牌——两者今天没对齐（第 4 版按评审第 13 条补）**：[DESIGN-ARCH-203]:72 与 requirement-5q.md:272 都要求行粒度 = **实例**（workbuddy CN/Intl、qoder IDE/CLI、zcode 桌面/CLI 各占一行，5q:278-279 样表里 workbuddy-CN 还要「四个数据根分别标注」），但 §3.1 声明注册表条目形状维持 203 §3.2（`:189-195`：一家一条、`id` 是品牌级），本稿字段集合也只有 `id`——同一品牌的两行会**共用一个 id**，于是 §1.5 / §9.3 的「四端 `instances[].id` 集合逐项相同」**没有可比单元**。两条路：给实例行加 `installationId`（`id` 仍作品牌外键，同源比对改用 `installationId`），或把 `id` 定为实例级并在注册表侧承载多实例；本文不代裁，与 status 枚举同批交契约决策员（§11.2 第 3 条）。
- `checked[]` 按 `detect()` 契约回报「未安装」的检查路径（[DESIGN-ARCH-203]:179）——formatter 只投影，不自行推断检查面。
- `unregistered[]` = 路 B「发现未识别项」分组（[DESIGN-ARCH-203]:217 红线：只列清单给手动登记入口，绝不猜格式）。
- **实例行没有承载「能不能写」的字段（第 3 版补登）**：§6.8 第 4 条要求 qoder / workbuddy / kiro / cursor 在四端 UI 显式标「只读：后端尚无写器」，但 `instances[]` 字段集合里只有 `tier` 与自由文本 `notes?`，没有 `writable` / `capabilities`。两种落法：塞 `notes`（零字段变更，但四端得按同一句约定解析，等于拿自然语言当契约），或补一个布尔/枚举字段（改契约，须契约决策员一并定）。**本文不代裁**；`khy agent-assets caps` 的「读/写」列（`handlers/agentAssets.js:169`）是现成的能力来源，可作该字段的投影依据。
- 同源校验锚点：四端 overview 的 `instances[].id` 集合与 `hub --json` 逐项一致（requirement-5q.md Q4，`:342-349`）。**比对键待定**（第 4 版按评审第 13 条补）：在上一条的「行粒度=实例 vs `id`=品牌」问题收口前，这条锚点只对「一家一行」的品牌级条目成立；多实例条目要先定 `installationId` 还是实例级 `id`，四端同源比对才能换成实例键（§11.2 第 3 条）。
- **收口稿（不是定稿）**：requirement-5q.md:290 的原文是「必需字段（**AI 拟定，待契约决策员定稿**）：…`status`（`installed` / `data-only` / `not-detected`）」，:396 又把该字段集合列为 AI 自答第 3 条「为 AI 拟定，待契约决策员定稿」；本轮给定材料与仓内均无该枚举的定稿记录（可检索证据：全仓 `not-installed` 8 处命中全是无关代码、`data-only` 12 处命中无一处属本功能，`works/data/khy/feedback/agent-hub/` 只有 `impl-plan.md` 与 `requirement-5q.md`）。本文据 [DESIGN-ARCH-203]:179 的 `detect()` 契约**拟定**以 `installed` / `not-installed` 两值收口：5q:280 要求的「仅数据 / 未安装 + 已查路径」两种形态由 `notes` 与 `checked[]` 承载，具体文案实现期定、不改枚举。第 0 版把本条写成「契约决策员定稿」系越权表述，已订正；**契约决策员确认前，5q:290 的三值枚举仍是唯一在册版本，本条只是收口建议**（§11.2 第 3 条同判）。
- **两值化的代价与替代判定字段（第 2 版补登，评审第 4 条）**：在册验收表要求状态列承载**三档**——5q:272「未安装的显式标注『未检测到』并列出检查过的路径」、:280 示例 `command-code 仅数据 / 未安装`（程序已移除、数据仍在、assets 非 0）、:281 示例 `kiro 未检测到` 三态并存；:284 计数纪律「未安装行不得显示 0 冒充『已检查且为空』」与 :349 四端同源「任何一端少一行、**状态不同**、数字不同都算失败」都以状态列作判定。收成 `installed` / `not-installed` 两值后，「仅数据」与「未检测到」塌成同一个值：:284 的判定与 :349 的可比较性都失去 status 承载位。**若坚持两值，必须同时定死同源比对的替代判定字段**（建议组合键：`notes` 的形态标记 + `checked[]` 是否非空 + `assets.*` 是否非 0，四端按同一规则投影）；否则应保留 `data-only` 三值。**本文不代裁**——把「两值」「两值 + 组合键」「三值」三案一并交契约决策员，确认后再实现 formatter 与同源比对。
- 现状注记：今天 `khy agent-assets hub --json` 退出码 1（未知子命令，§12 H2）；本项验收在实现前不成立，不记为已通过。

> 截断说明：上方代码块与第一条要点为草稿正文原文（草稿在第二条「`checked[]` 按 `」处被截断，见 §13.4 R0-1）；第二条起的契约要点按扩面裁决原文（§3 映射表第 8 条）与 requirement-5q Q4 补齐；「订正」「现状注记」两条为本轮整合所加，不引入新语义。

---

## 5. 安全边界扩面（手机端凭据/配对语义、终端面只读豁免）

### 5.1 状态说明

上游后端契约草稿的 §14.4「安全边界扩面」在派发时**正文未随任务到达**（截断，见 §13.4）。按其标题语义，把已到达材料中明确属于本节的条目收拢如下（§3.4 鉴权裁定、§3.5 手机写分级、§8.2 手机鉴权三条硬前提、§2.2 总表终端行）。第 0–2 版此处写「**未新增任何内容**」；**第 3 版新增 1 条**——§5.2 第 6 条「跨设备确认令牌不通用」，依据是 requirement-5q.md:363 的 arrived 原文（此前只在 §1.5 作验收项，本节语义层缺载）。完整正文仍待草稿全文到达后补全；除该 1 条外不增收任何内容。

### 5.2 手机端凭据/配对语义

1. **凭据只有一种**：owner Bearer JWT，经 `authenticateToken`（`middleware/auth.js:175-199` → `authSessionService.js:307-320`，`:314` `jwt.verify(token, JWT_SECRET)`）。部署目标机须有 `JWT_SECRET` + DB 用户；`builtin-*` token（`aiManagementServer.js:1410`）不是 JWT，过不了该中间件（§3.4）。
2. **配对载荷只负责「可达地址」，不负责令牌**：现状 `buildPairingPayload` 返回 `JSON.stringify({ apiBaseUrl })`（`cli/handlers/mobile.js:145-148`），手机侧注释亦明说「配对二维码只带地址不带令牌，所以第一次打开市场必然要在这里补一次登录」（`market_catalog.dart:434-437`）。owner JWT 由登录获得（`khyos_api.dart:192`），**不是配对下发**。
3. **三要素齐备**（§1.3）：登录身份 + 设备配对 + 可达 origin（配对载荷下发，不得 127.0.0.1 兜底）。身份/配对机制选型（[DESIGN-ARCH-192] 的 `authBaseUrl` 计划见其 `:466`；[DESIGN-ARCH-216] 授权 broker）属契约决策员事项（§11.3）。
4. **拆掉宽豁免的诱惑（第 2 版扩列）**：不改挂 `aiManagementServer` 自管 `authenticate()`（X-API-Key / loopback / LAN 豁免，`:1198-1261`）作手机接入面；不得为手机改 `middleware/auth.js` 加回环豁免（[DESIGN-ARCH-203] §9 第 14 条同判）；**也不得挂同模块再导出的 `requireLoopback` / `originGuard` 族**（`middleware/auth.js:273-278`；实现 `middleware/originGuard.js:88-94`、`:96-102`）——`requireLoopback` 只接受回环连接（403「仅允许本机访问」），手机走 LAN/公网 origin 会被全量挡死；`originGuard` 的白名单走 env `KHY_ALLOWED_ORIGINS`（`originGuard.js:22`）并放行 `null` / `file://`（`:52-60`，Electron `loadFile()` 生产构建的现实约束）。二者是「本地控制面」语义，不是「设备配对」，拿来顶「未配对拒绝」会把远程端打死，与 §1.5 验收直接冲突。
5. **设备身份：三块既有输入（会话链 / originGuard 裁决 / `devicePairing.js`）+ 一块真缺口（第 2 版改写见 §13.6 第 2 条；第 5 版补第三块，见 §13.9 第 2 条）**：Q1 的「每台电脑一个可撤销的设备身份、未配对请求一律拒绝」（requirement-5q.md:176）不是从零开始——**① 会话粒度已有签发/标注/撤销链**：`issueSessionForUser`（`authSessionService.js:265-305`）写 `deviceLabel` / `tokenVersion` / `ipAddress` / `userAgent`，`authenticateAccessToken` 按会话拒绝（`:358-382`），撤销 `revokeSessionById` / `revokeUserSessions`（`:399-437`），清单 `listUserSessions`（`:513`）。**② `services/devicePairing.js` 是仓内现成的加密设备身份与配对机制**（Ed25519 keypair + SHA256 指纹 + 角色层级 `:26-33` + token scope `:37-50` + 配对生命周期 `request → approve/reject → active → revoke`，状态含 `REVOKED` / `EXPIRED` `:54-60`，TTL 24h / 10min `:62-63`；API `getLocalIdentity` `:157`、`createPairingRequest` `:192`、`approvePairing` `:237`、`revokePairing` `:278`），并已被 `webRemoteControl/pairingCode.js`（`:19` 引入、`:58` 实例化）与 `protocol.js:77`（TTL 同源）消费——**但它服务的是桌面 Web 远控，与 `khy mobile app` 的手机二维码互不相干，agentHub 四端链路今天也不经过它**。**③ 既有裁决约束**：`originGuard.js:52-60` 已裁 `null` / `file://` 必须放行。**真缺口只有一块**：设备↔origin 绑定与配对校验落在上述哪一层——`deviceLabel` 由 UA 派生（`:90-128`）不是可注册/撤销的设备身份，`authenticateAccessToken` 不做 origin 校验，手机配对载荷现状只带 `{ apiBaseUrl }`（`cli/handlers/mobile.js:145-148`）。实现该项属 §11.3 第 1 条选型事项，**选型必须在「复用 `devicePairing.js`」与「另建」之间显式选择并给出理由**——实测 [DESIGN-ARCH-192] 与 [DESIGN-ARCH-216] 各 0 次提及 `devicePairing`（§12 B16），本文此前也只登记了会话链与 originGuard 两块，等于默认「另建」，那会造出第二套设备身份（与本仓「杜绝第二写者」同一口径）。**不在本期四端接线（§6–§9）的执行面内**；选型落定前，涉及设备身份的验收项（§1.5 手机验收的跨设备令牌拒绝、设备不匹配码）**不可验收**，也不得用临时手段凑数。
6. **跨设备的确认令牌不通用（第 3 版按 arrived 材料增收，非草稿原文）**：令牌在配对设备上签发与消费——A 机签发的确认令牌对 B 机下发必须拒绝，且要给明确错误码（requirement-5q.md:363 原文：「跨设备的确认令牌不通用（令牌在配对设备上签发与消费）」）。该语义此前只在 §1.5 手机验收里作为验收项出现，§5 语义层缺载，现补齐。**可达性依赖**：拒绝行为要求接入面知道「令牌属于哪台设备」，而 `authenticateToken` 无设备绑定（本条第 5 项），故 §1.5 已把该条标为**本期不可验收**；错误码与 HTTP 状态归 §11.3 第 2 条（新增码须按 §8.5 的逐端载体同改）。

### 5.3 终端面（只读豁免的边界）

1. **终端不经 HTTP，无鉴权可豁免**：`hub` 是 CH-3 本机执行面（§2.2 终端行），不存在 token 语义；它是「同进程直调」而非「HTTPS 免鉴权接口」。
2. **写操作仍受约束，但今天只覆盖 W1**：终端的既有写腿是 `import / export / sync`（= W1 资产写），它们沿用干跑默认、`--apply` 才落盘（[DESIGN-ARCH-203] §6.1–§6.2；`handlers/agentAssets.js:420-425` 的 `--apply` / `--on-conflict` / `--idle-timeout` 帮助即现状），并受 `KHY_AGENT_ASSETS=off` 门控（`:440-444`）。**`--apply` 这处证据只能证明 W1 的干跑默认，不能证明终端已有 W2/W3 落点**——模型写与程序装卸在 CLI 今天没有命令（§2.3、§11.2 第 6 条）；分级契约是四端共用的语义，终端要交付 W2/W3 须先加命令面，届时按 §2.6 的登记要求同批登记确认闸门。
3. **CH-1 只读豁免不延伸到写**：终端读本机事实可直接读状态文件（[DESIGN-ARCH-071] Q2 只读豁免），但「统一总表」必须经 service 装配（各端同源校验的前提），不得各端直读拼装；写一律走 service 正门。

---

## 6. 网页端（/admin/agent-hub · CH-4 Web API）

> 本节对应上游草稿编号 §14.1（四端接线稿）。沿用 [DESIGN-ARCH-203] §5.3 的「同源第二表面」裁决，不推翻任何既有结论；冲突处以「订正记录」标注。行号均为 2026-11-16 本机工作树实测（这些文件有未提交改动，实施时以现场 `Select-String` 定位为准）。

### 6.1 通道判定

[DESIGN-ARCH-071] 五问走到第 4 问命中——前端页面 · 远程机器 · 多并发消费者 → CH-4（`docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-071] 通道选择决策矩阵.md:37-39`）。写操作在 Q1 被拦（「改变系统状态 → 禁止直写 → 进 Q4 选带副作用的正门」，`:28-29`）。同矩阵 `:53` 明令：前端（L3）require 后端（L2）源码禁止，L3→L2 仅 HTTP；`:55` 禁止端点写死 `localhost:port`（规则 1）。既有裁决 [DESIGN-ARCH-203]:15、:111 已定 Web 管理台走 CH-4，本节不改。

### 6.2 鉴权语义与一处不对称

`/api/agent-hub` 挂 `authenticateToken`（照 [DESIGN-ARCH-203] §4.3 的 ecoMarkets 样板，`aiManagementServer.js:385-386` 同款挂载形状）。**「照样板」只指挂载形状**：import 用后端本地 `middleware/auth`，解构名必须是 `authenticateToken`；同模块另导出的 `flexibleAuth` 带 X-API-Key 第二腿（shared 版 `:169-215`、backend 本地版 `:217-260`），禁挂——符号级区分见 §3.4。该中间件只认用户 JWT、无回环豁免（`middleware/auth.js:175-199`：`extractBearerToken` → `authSessionService.authenticateAccessToken` → `jwt.verify(token, JWT_SECRET)`，`authSessionService.js:307-320`）；前端 Bearer token 由既有链供给（`src/api/authedFetch.js:21-27` 从 `useUserStore()` 读，`src/api/request.js:12-15` 的 axios 实例 baseURL 取 `VITE_AI_API_BASE_URL || ''`，本页不自建第二套 baseURL 拼接，规则 1）。

**必须如实写明的一处不对称**：挂载按 §4.3 是 `authenticateToken` 一层，不带 `requireAdmin`——页面入口的 admin 门在前端（`/admin` 命名空间盖 `meta.requiresAdmin`，`router/index.js:519-528` 的 `isAdminPath` + `:542-548` 的 `stampAdminMeta` + `:570-571` 守卫弹 `/403`），后端不对非 admin JWT 返回 403。单 owner 场景（requirement-5q.md:171-182）无实害，但机制语义是「任何 active 用户 JWT 可全档写」。**「后端要不要叠 `requireAdmin`」是本文新增的委托项，不是 requirement-5q.md:411 的原文内容**——5q:411 只裁前端落点与角色门（「若挂 `/admin`，owner 账号须具备 ADMIN；是否改为顶层入口由设计定」），不含后端守卫层；该新增项已单列 §11.3 第 6 条并对齐 §6.8 第 2 条（第 2 版订正出处）。

### 6.3 订正记录：[DESIGN-ARCH-203] §5.3 盘点结论

[DESIGN-ARCH-203] §5.3 盘点说「`/admin/agents` 的路由与 viewLoaders 已在，缺的只有 NAV 一项」——该盘点对象是 `AgentDashboard.vue`（管 khy 自己的 worker agent 层级，数据源是后端进程内存 `_workers` / `_childrenOf`：`coordinator/workerAgent.js:1157-1163`），与外部智能体统一管理不是一回事（§5.3 自己也点明）。对 `/admin/agent-hub` 本身，**四处 UI 接线 + dev 代理名单今天全缺**：NAV 无项、viewLoaders 无键、router 无 child、view 文件不存在（`src/views/admin/AgentHub.vue` 与 `routes/agentHub.js`、`services/domain/agents/agentHub/` 均实测 ABSENT，§12 A1），dev 代理的 `DAEMON_ONLY_NAMESPACES` 也没有 `/api/agent-hub`（`vite.config.js:38-60`，实测 13 项，§12 C13）。故本端是「新增四处 UI 接线 + 一处 dev 代理名单」，不是「补 NAV 一项」。另：admin 子路由自 §5.3 盘点后新增了 `traffic`（`router/index.js:374-378` 实测），child 插入位置以现场为准。

### 6.4 落点文件表

| # | 文件 | 动作 | 现状核实（本轮实测） |
|---|---|---|---|
| 1 | `delivery/web/ai-frontend/src/nav/index.js` | 「管理控制台」组加 `{ path: '/admin/agent-hub', label: '智能体', … }`，位于「统一设置」（`:167`）之前。**label 现值与 §9.4 的「未占用词」规则冲突（「智能体」已是 `khy agent` 的中文别名，`aliases.js:477`），四端定名待 §11.2 第 8 条，对照表见 §9.5** | 组 `:119-169`，`requiredRole: ROLE.ADMIN` `:121`，现有 15 项 `:123-167`；NAV 头注释自陈「单一真源，三处消费」`:1-9`；`visibleNavGroups` `:181-195`、`NAV_PATHS` `:198`、`navLabelFor` `:202-208`。NAV 的 requiredRole 只管侧栏显隐，requiresAdmin 由路由机制独立盖章（[DESIGN-ARCH-203] §11 R11 结论） |
| 2 | `delivery/web/ai-frontend/src/composables/useRoutePrefetch.js` | viewLoaders 加 `'/admin/agent-hub': () => import('@/views/admin/AgentHub.vue')` | `viewLoaders` `:20-77` 起（单一真源，router 消费同一张表 `:13-15`）；`'/admin/agents'` 键在 `:64`；`prefetchView` 对未知键静默 return `:83-86`；空闲预热 `:99-118`（未复验） |
| 3 | `delivery/web/ai-frontend/src/router/index.js` | `/admin` 父路由下加 child `{ path: 'agent-hub', name: 'AgentHub', component: viewLoaders['/admin/agent-hub'] }` | `/agents` redirect `:103-104`；`/admin` 父路由 `:292-299`；`agents` child `:379-383`；守卫三段 `:557-587`（requiresAuth `:562-568`、requiresAdmin `:570-571`、resolveAuthGuard `:573-585`） |
| 4 | `delivery/web/ai-frontend/src/views/admin/AgentHub.vue` + `src/composables/useAgentHub.js` | 新页面 + composable | 均不存在（新文件）；页面标题进 `documentTitleFor` 自动生效（`:615-621` 先查 `navLabelFor`，命中 NAV 即无需登记 `DOCUMENT_TITLES` `:604-611`） |
| 5 | 后端 `routes/agentHub.js` + `aiManagementServer.js` 三处挂载 | 按 [DESIGN-ARCH-203] §4.2/§4.3 原文实施；**import 用后端本地 `middleware/auth` 并解构 `authenticateToken`（不得解构 `flexibleAuth`、不得改走 `khy-ai-backend/middleware/auth` re-export），挂载形状照 ecoMarkets——见 §3.4** | `getEcoMarketsApp` 样板 `:383-388`（`:385` 解构、`:386` 挂载）；`/api/eco-markets` pathname 分发实测在 `:2414`（草稿记 `:2393-2395` 已漂移，该段现为 proxy-subscriptions `:2393-2396`）；`__test__` 导出 `:3846` 均实测在场 |
| 6 | `delivery/web/ai-frontend/vite.config.js` | `DAEMON_ONLY_NAMESPACES`（`:38-60`）加 `'/api/agent-hub'`，并照 `:53-56` 的 eco-markets 先例在名单里留一行注释，写明「不在名单会被 `/api` 兜底（`:143-146`）转给 web 后端，得到 404「接口不存在」」（`:57-59` 的 proxy-egress 同型注释可作模板）。**同时**照 `src/views/EcoMarkets.wiring.test.js:141-153` 新增同款断言测试（见 §6.5） | 名单实测 **13 项**（`:39`/`:40`/`:41`/`:42`/`:43`/`:44`/`:45`/`:46`/`:47`/`:48`/`:52`/`:56`/`:59`），无 `/api/agent-hub`；`/api` 兜底 `:143-146` → `webBackendTarget`（`:24` 由 `resolveWebBackendTarget()` 解析）；`backendDiscovery.mjs:206-214` 自陈 web 后端与 daemon 是两个 server、daemon「does NOT serve those routes」，解析链 `:224-235`；`/api/agent-hub` 按 [DESIGN-ARCH-203]:300-301 挂 `aiManagementServer`（daemon，pathname 分发）；先例测试 `EcoMarkets.wiring.test.js:141-153` 实测在场 |

### 6.5 守卫与页面形态

**守卫**：`delivery/web/ai-frontend/src/router/nav.wiring.test.js` 的断言是**单向**的，必须按方向逐个说清它锁得住哪几处（第 4 版按评审第 6 条订正——原文「这四处 UI 接线漏任何一处该测试会红」不成立，本轮实读该文件核方向，未跑 vitest，本机 `node_modules/vitest` 缺见 §12 C6）：
- `:126-131` 只查 NAV 内部（≥2 组、ADMIN 组非空、路径不重复）；
- `:151-159`、`:182-185` 是 **NAV → route**（NAV 里每个 admin 页/每一页都必须有真路由）；
- `:232-261` 是 **router → viewLoaders → 磁盘文件**（键已登记 `:232-251`、指向文件存在 `:252-261`）；
- `:171-179` 是写死的 detail 路由抽查清单（含 `'/admin/agents'`），方向仍是「这些路由必须存在」，不是「每条路由必须在 NAV 里」。

**没有任何 route → NAV 的反向断言**，所以「加了路由 + viewLoader + 页面文件、漏加 NAV 项」——恰好是 §6.4 表第 1 行那一处——**测试全绿**。仓内 `/admin/agents` 就是这个活样本：路由在（`router/index.js:379-383`）、viewLoaders 键在（`useRoutePrefetch.js:64`）、页面文件在（`views/admin/AgentDashboard.vue`），而 NAV 15 项里没有它（`nav/index.js:119-169`），与本文 §1.4 / §6.3 的自述一致；上述四组断言对它全部通过。故 §6.4 第 1 行（NAV 加项）**没有自动守卫**，只能人工核对或另写一条 route→NAV 断言；后者的判据须排除 redirect / legacy 转发（`:187-230`）与 detail 路由（`:171-179` 那类），否则会反向误伤。是否补这条断言本期不代裁，登记在 §6.8 第 5 条。

**但 `nav.wiring.test.js` 管不到 dev 代理名单**：它只查 NAV / router / viewLoaders / 磁盘文件，`DAEMON_ONLY_NAMESPACES` 不在它的断言范围里（本轮实读该测试文件，§12 C13）。**漏了名单，`nav.wiring.test.js` 会全绿，而 dev 环境整个 `/api/agent-hub` 被 `/api` 兜底（`:143-146`）转给 web 后端得到 404「接口不存在」**（`:53-56` 的注释已就 eco-markets 写明这一后果）。

**但名单并非「只能手测」——已有先例测试可直接照抄**：`delivery/web/ai-frontend/src/views/EcoMarkets.wiring.test.js:141-153` 就是为 eco-markets 写的同款断言——切片取 `DAEMON_ONLY_NAMESPACES` 数组体（`:142-144`）、断言含 `'/api/eco-markets'`（`:145-149`，失败信息原话「dev 下请求会落进 '/api' 兜底被转给 web 后端得 404」）、并断言 `'/api': {` 兜底注册在名单之后（`:151-152`）。agent-hub 应**照此新增一条**（`src/views/admin/AgentHub.wiring.test.js`，或并入现有 wiring 测试），把 `'/api/agent-hub'` 钉住，而**不是**只靠实现期手测。注意：该测试落在 `test.include: ['src/**/*.test.{js,mjs}']`（`vite.config.js:82-86`）范围内，**跑 vitest 才会执行**；本机 `node_modules/vitest` 缺（§12 C6），故「写了测试但没跑」不算通过。**接线集合至此完整**：四处 UI 接线 + dev 代理名单一处，后者由同款 wiring 测试锁（`npx vitest run src/router/nav.wiring.test.js src/views/admin/AgentHub.wiring.test.js`）。

**入口名称与位置（第 3 版补登，UI 实测）**：
- 入口 = 侧栏「管理控制台」组的「智能体」项，插在「统一设置」（`src/nav/index.js:167`）之前；该组现 **15 项**（`:123-167`），无 agents 类项，`requiredRole: ROLE.ADMIN` 在 `:121`。**label 取值与四端定名规则冲突，待 §11.2 第 8 条，对照表见 §9.5**。
- **用户可见后果**：owner 账号非 ADMIN 时**整组不可见**（不是灰显），即入口对 owner 直接消失；路由仍在，直接敲 `/admin/agent-hub` 会被 `requiresAdmin` 弹 `/403`（`router/index.js:570-571`）。这是 §11.3 第 5 条「入口是否升出 `/admin`」的现实代价，未拍板前按挂 `/admin` 写。
- 页面标题进 `documentTitleFor` 自动生效：它先查 `navLabelFor`（`router/index.js:615-621`），命中 NAV 即无需登记 `DOCUMENT_TITLES`（`:604-611`）。
- **设备选择器是本期新增状态面但表里没有行**（拍板②要求手机与外网网页存设备列表）：§6.4 的六行只覆盖单机入口，设备选择器的落点由身份/配对选型定（§11.3 第 1 条），本期**不接线**；实施时若照表施工会漏掉拍板②的一半，故在此显式登记为**待选型占位**。

**页面形态**：按 EcoMarkets 约定写（[DESIGN-ARCH-203] §5.3 原判不推翻）：`KhyPageHeader`（`src/components/KhyPageHeader.vue` 实测存在）+ `LoadErrorBanner`（`src/components/LoadErrorBanner.vue` 实测存在）+ degraded 告警 + composable 只归一化不重算（`src/composables/useEcoMarkets.js:6-9` 自陈「only normalizes shapes」、`:52` `degraded` ref）。页面结构 = [DESIGN-ARCH-203] §5.2 单页四区的 Web 版；写操作**按 §6.1 分级走，不是一律带令牌**（第 4 版按评审第 5 条订正——原文「写操作全部走 POST plan → confirmToken → apply」把 W1 也说成必带令牌，与真源相反）：R 只读无闸；**W1 资产写 = 干跑计划 + 冲突清单，`[DESIGN-ARCH-203]:414` 明写「不需要额外确认令牌」**；W2 配置写 / W3 程序装卸 = 干跑 + 写前备份 + 确认令牌（W3 另加逐项「会丢什么」+ 回滚点，`:415-416`）；**W3+ 删用户数据 = W3 全部要求 + 单独的更高一级确认 + `losses[]` 逐项摊开**（`:417`、`:458`；requirement-5q.md:361 同口径）。四端共用同一 service 与同一套分级，但**W3+ 的第二级确认必须在 UI 上有独立载体**：W1 无令牌 → W2/W3 一张确认卡 → W3+ 在确认卡之后再走一次独立确认并摊开 losses 清单，三档三形态，不是一张卡通吃（桌面形态见 §7.4，手机同）。**设备列表切换是本期新增状态面**（现状网页只有单一 baseURL，无「选机」概念），落点由身份/配对选型定（requirement-5q.md:178、:407），本节不代定。

### 6.6 降级与状态文案（规则 2 口径）

- 探测降级：后端 200 + `degraded` 载荷 → 横幅显示后端下发的原文（composable 不重算）；
- 后端不可达：「连接 khy-os 后端失败 (`NETWORK_UNREACHABLE`)：无法连接 `<origin>`。修复：确认服务在跑，或点重试」——**码值由本端 `src/utils/classifyKhyError.mjs` 归类得出**：`STATUS_TABLE` 401→`AUTH_REQUIRED`（`:46`）、403→`PERMISSION_DENIED`（`:47`），`ERRNO_TABLE` `ECONNREFUSED`→`NETWORK_UNREACHABLE`（`:73`）；这三张表是 `runtime/substrate/platform/packages/shared/src/errorEnvelope.js:75-83`（STATUS_TABLE）、`:49`（`NETWORK_UNREACHABLE` 在 CODES 表）、`:104-106`（ERRNO 族）的**镜像**（镜像自述见 `classifyKhyError.mjs:3-5`）。网页**不得直接 import shared 真源**（[DESIGN-ARCH-071]:53：禁止 L3 require L2 源码，L3→L2 仅 HTTP），故网页读的是镜像文件，不是 shared 包；
- 未登录/过期：HTTP **401 → 前端归类码 `AUTH_REQUIRED`**（`classifyKhyError.mjs:46`）+「请重新登录」；**403 → `PERMISSION_DENIED`**（`:47`）。**这两个是网页侧显示层的归类码，不是后端 401 响应体字段**——后端 `authenticateToken` 的 401 体只有 `{ success:false, message }`（证据见 §1.5），实施者不得去断言 `error.code`（断言了验收永红）；
- **404 必须有专属文案，不得沿用镜像的 404 归类（第 4 版按评审第 8 条补）**：现状 `classifyKhyError.mjs:48` 把 404 归成 `MODEL_NOT_FOUND`、hint 是「模型标识拼错或已下架，刷新模型列表后重选」（`:23`），真源 `shared/src/errorEnvelope.js:79` 同——套到「`/api/agent-hub` 命名空间没挂上」上，给出的修复建议与成因无关，正好违反本文自己引的规则 2.2（问题 + 原因 + 修复）。故本页须**按 HTTP 404 单独判定**，文案形如「接口不存在 (404)：后端没有 `/api/agent-hub`。修复：确认连的是 khy-os 后端守护进程 origin（不是 web 后端，也不是 dev 代理的 `/api` 兜底路径）+ 补齐 §6.4 第 6 行名单」；四端现成先例是手机端 `market_catalog.dart:607-612`（`case 404` → 「接口不存在 (404)：后端没有 $endpoint」+ 升级/确认后端指引），比 `:601-606` 的 401/403 两支更贴近本语义。**专属码与复用 404 直判二选一，归 §11.3 第 2 条与设备不匹配码一并定**；
- 显示出口：`src/api/notify.js:129`（`_ensureKhy` → `classifyKhyError`）与 `:156`（`deriveErrorMessage`）；
- 写操作过程态吃后端 `onProgress` 三维契约（[DESIGN-ARCH-203] §7 的「正在探测 claude-code 安装位置（已查 3/5 处）」式样）；错误一律「问题 + 识别码 + 修复」三段（[DESIGN-ARCH-203] §4.2 错误码表）。

### 6.7 与既有 bridge/配对机制的关系

网页端本机打开时不经配对，直接用既有登录态；多机目标 origin 待设备清单/配对机制落定后由列表下发，**不得新增第二套 baseURL 真源，也不得 127.0.0.1 兜底**（requirement-5q.md:206-214 三要素）。

### 6.8 待拍板项引用

1. 本表面是否本轮做（[DESIGN-ARCH-203] §9 待拍板第 3 条）；
2. **后端要不要叠 `requireAdmin`（本文新增委托项，非 5q 既有——见 §11.3 第 6 条）** / 入口是否升出 `/admin`（requirement-5q.md:411 第 5 条只裁前端落点与角色门）；若叠加，**落地时按 §2.6 的四拦截面登记要求表补 `rollout.mechanisms[]` 条目**（`stage=S1` + `executorStage.{file,constant}`）；
3. W2/W3/W3+ 远程二次审批（requirement-5q.md:402 待拍板第 1 条）；
4. qoder / workbuddy / kiro / cursor 模型写腿（[DESIGN-ARCH-203] §9 第 4 条；落定前四端 UI 显式标「只读：后端尚无写器」）；
5. **是否补一条 route → NAV 反向断言**（第 4 版新增；`nav.wiring.test.js` 今天只有 NAV → route 与 router → viewLoaders → 磁盘两个方向，漏 NAV 项不会红——见 §6.5）。补的话判据须排除 redirect / legacy 转发（`:187-230`）与 detail 路由（`:171-179` 那类），否则反向误伤；不补则 §6.4 第 1 行只能人工核对。本文不代裁。

---

## 7. 桌面端（Electron 主表面 · CH-2 服务直调）

> 本节对应上游草稿编号 §14.2（四端接线稿）。逐条复核 [DESIGN-ARCH-203] §5.1 的六处接线；结论：**六处的结构性裁决全部成立，但行号全面漂移，且第 5 处引用的先例已失真**，逐条订正如下。

### 7.1 通道判定与鉴权语义

桌面端没有登录态（`App.tsx:161-163`「ZCode has no login/welcome gate」注释仍在），本轮实测 `apps/khyos-desktop/src` 全量 grep `/api/` 仅 2 处命中且均非后端消费（`main/keyManager/keyStore.ts:760` OpenRouter 外部供应商 URL、`renderer/i18n/zh-CN.json:3185` 示例文案）——桌面从未调过后端 `/api/*`，走 HTTP 必 401（`middleware/auth.js:175-199` 无回环豁免），故按 [DESIGN-ARCH-071] 五问 Q3「与 backend 同一 Node 进程 → CH-2」（`:34-35`）走 `createRequire` 服务直调，**零 HTTP、零 token**；打 `/api/agent-hub` 是明令反模式（[DESIGN-ARCH-203]:470）。桌面 renderer → main 走 preload IPC 是进程内边界（[DESIGN-ARCH-203] §6.3 通道表），不算第二通道。单人多机后桌面本期仍只管本机（AI 自答待确认，requirement-5q.md:182、:394）。

### 7.2 六处接线逐条核实（文档值 → 实测值）

| # | [DESIGN-ARCH-203] §5.1 所述 | 实测（2026-11-16） | 判定 |
|---|---|---|---|
| 1 | 新页面 `renderer/components/agentHub/AgentHubPage.tsx` | 不存在（`renderer/components/` 实列无 agentHub 目录，现有 agentbus / amoon 等目录） | 成立，纯新增 |
| 2 | lazy 注册 `App.tsx:41-51` | 实测 `App.tsx:54-65`：四个 lazy 页 KeyManagerPage `:54` / SettingsPage `:57` / AutomationsPage `:60` / EnvironmentsPage `:63` | 行号漂移；加第五个同款 lazy |
| 3 | 路由常量 `App.tsx:352-361` | 实测 `App.tsx:366-379` 是 hash 路由 state（`:368` onHash）与四常量（keyManager `:372`、settings `:377`、automations `:378`、environments `:379`） | 行号漂移；加 `const agentHub = route === 'agent-hub'` |
| 4 | 渲染早退分支 `App.tsx:669-724` | 实测四分支 `:708`（keyManager）/`:722`（settings）/`:736`（automations）/`:750`（environments），均 `ErrorBoundary + Suspense + ToastContainer` 同形态，主界面 `return` 在 `:764` | 行号漂移；**漏做此条入口即死**的警告维持 |
| 5 | 快捷键守卫 `App.tsx:451` | 实测 `App.tsx:469` `if (keyManager \|\| settings) return`；另发现 `:425-434` 有第二处 settings 短路（设置页打开期间跳过 `getSettings` 读取，`:427`） | 行号漂移；agentHub 是否纳入此守卫随设计定，但 `:427` 这处是勘察未登记的同类分支 |
| 6 | `main/agentHub/service.ts + ipc.ts + preload` | 全不存在（`src/main/` 实列无 agentHub）；先例机制核实：`src/host/index.ts:3-4` 文件头明写「CH-2 服务直调」，`nodeRequire` 定义 `:68`、载入点 `:128` 等；`main/keyManager/agentWriters.ts:33-55` 的 `resolveBackendServicesRoot()` 4 级降级（`KHY_BACKEND_SERVICES` env 在列 `:36-37`）、`:58` `_auditBackendResolution` 留痕；`main/keyManager/ipc.ts` 实测 25 个 `ipc.handle`（`keys:list` 起 `:52`）；`preload/index.ts:348` 单点 `exposeInMainWorld('__KHYOS__', api)` | 成立：service 复用 `resolveBackendServicesRoot` + `createRequire` 载 `services/domain/agents/agentHub/{overview,planner,executor}`，`agentHub:*` 通道照 `ipc.handle` 命名法注册，暴露进 `__KHYOS__` 同一对象（不新开第二个暴露点） |

### 7.3 订正记录（第 5 格先例失真）

[DESIGN-ARCH-203] §5.1 引 TitleBar「密钥与端点管理」作 hash 路由菜单项先例——该先例已失真：`TitleBar.tsx:176` 现在调 `api.openKeyManagerWindow()` 开**独立窗口**（`:172-175` 注释记着入口迁移史）。现行 hash 写入先例是 `App.tsx:488-491`（openSettings 快捷键 `window.location.hash = '#/settings'`）。新菜单项照此形态：`{ kind: 'action', label: '智能体统一管理', run: () => { window.location.hash = '#/agent-hub' } }`，位置在 `:176` 之后；若要与跨端可达性对齐，`TitleBar.tsx:204-208` 已有「四端互跳」组（打开网页版 `:206` / 下载 Android 版 `:207` / 下载桌面版 `:208`，`openWebVersion` `:138-147` 由 main 解析地址、渲染层不拼 URL），agent-hub 的跨端入口如需挂菜单应与这组并列并注明「本页只管本机、网页/手机端可达多机」。TitleBar menuItems 全文实测在 `:171-222`。是否做成独立窗口 vs 主窗口 hash 路由，[DESIGN-ARCH-203] §5.1 原裁决（hash 路由，理由见其 `:360` 段）不推翻。

### 7.4 页面形态

[DESIGN-ARCH-203] §5.2 单页四区的桌面版——左实例列表（已纳管 / 发现未识别项 / 未安装·默认折叠不隐藏）+ 右详情四 tab（概览 / 模型配置 / MCP·skill·记忆 / 安装卸载），底部状态行。写分级四端同权（requirement-5q.md:150-151 拍板「四端全可写」），但**分级与确认闸门的实现落在 service 层**（planner 的 `STAGE='S1'`、`severity: advisory`，[DESIGN-ARCH-203] §8）——四端自动共享，桌面端不重写分级逻辑，只透传计划 `steps[] / backup[] / losses[] / risks[]` 与令牌确认。

**入口位置（第 3 版补登：UI 实测有三处候选，须择一）**：

1. **TitleBar 窗口菜单**，紧跟「密钥与端点管理」（`TitleBar.tsx:176`）之后——照 `App.tsx:488-491` 的 hash 写法：`{ kind:'action', label:'智能体统一管理', run: () => { window.location.hash = '#/agent-hub' } }`；
2. **TitleBar「四端互跳」组**（`TitleBar.tsx:204-208`：打开网页版 / 下载 Android 版 / 下载桌面版）并列——但该组的语义是「去别的端」，与本页「管本机」不同，若挂这里必须注明「本页只管本机」；
3. **WorkspaceSidebar 顶部导航区**（`:855-895`，现有新建任务 / 搜索 / 自动化 / 插件市场 / 开发环境五行，hash 写法 `:875`、`:882`、`:889`）——这是与 TitleBar 并列的**第二个入口面**，[DESIGN-ARCH-203] §5.1 与本文章第 2 版都未登记它。

**建议择①**（TitleBar 菜单），理由：它与「密钥与端点管理」同类，都是本机管理面；侧栏顶部区是任务工作流的骨架，不宜塞配置入口。**这是 AI 建议，不是裁决**——入口落点已上提为 §11.2 第 7 条（第 4 版按评审第 12 条订正：原文错指 §11.2 第 1 条，而第 1 条的议题是「桌面本期只管本机、不带设备列表」，与菜单落点无关）。

**确认 UX 的形态（第 3 版补登：不得新造第四种）**：桌面今天已有三种确认形态——① 设置页开关**即时保存**（无确认）；② 工具调用的**三选一审批卡**（`buildControlCard`，`App.tsx:131-159`：`允许本次 / 始终允许 / 拒绝`，选项 `:154`）；③ 配对审批**三选一**（`WebRemoteControlPanel.tsx:149` 的 `decide(pairingId, role)`，按钮 `:311` / `:317` / `:323` 对应 `viewer` / `operator` / `reject`）。agent-hub 的「干跑 → 确认令牌」应**复用形态②**，但**必须按档位分成两级，不能只做「一张卡 + 确认/取消」**（第 4 版按评审第 5 条订正）：**W1 资产写不弹确认卡**（[DESIGN-ARCH-203]:414「不需要额外确认令牌」，只出干跑计划与冲突清单）；**W2/W3 用一张卡**呈现 `steps[]`、`backup[]`、`losses[]`、`risks[]` 摘要 + 确认/取消；**W3+ 删用户数据在确认卡之后再加一级独立确认**，且这一级必须把 `losses[]` **逐项摊开**（203:417「W3 全部要求 + 单独的更高一级确认 + losses 清单摊开」、:458「删用户数据目录是单独的、更高一级确认的 W3+ 动作，且必须先把 losses 清单摊开」）。**不要为确认令牌另造第四种交互**（令牌是 service 层机制，UI 不应把令牌字符串暴露给用户）；「不要另造一种交互」约束的是**令牌载体**，不是禁止为 W3+ 增加第二级确认——把 W3+ 压回一张卡正是「远程删数据从显式决策退化成误触」（§1.6 第 4 条的风险）。

**码值与文案的边界（第 3 版澄清）**：桌面走 CH-2、码值来自 **service 叶子契约**（[DESIGN-ARCH-071]:35 的 `fail-soft {ok,error}`，码值由 `shared/src/errorEnvelope.js` 生成），**不消费** `classifyKhyError.mjs` 那层镜像，**也不消费设备不匹配码**（桌面无设备列表——本条依赖 §11.2 第 1 条与 §11.3 第 1 条）。「四端文案一致」指的是同一错误语义在四端读起来是同一件事，**不是四端共享同一张码表**（逐端载体见 §8.5）。

### 7.5 降级与状态文案（规则 2 口径）

- 后端模块不可用：`resolveBackendServicesRoot()` 返 null → 全屏横幅「agentHub 后端模块不可用：已按 4 级顺序查找 backend src 根（`KHY_BACKEND_SERVICES` / 仓库相对路径 / portable root / 全部未命中）。修复：设置 `KHY_BACKEND_SERVICES` 指向 `runtime/node/backend/src` 后重启」——不写死路径兜底、不静默吞（`agentWriters.ts:57-62` 的留痕精神）；
- 门控关：`KHY_AGENT_HUB=off` → 拒绝并说明，照 CLI 侧 `KHY_AGENT_ASSETS=off` 文案模板（`handlers/agentAssets.js:440-444`）；
- 过程态：吃 service `onProgress` 三维契约（「正在探测 <label> 安装位置（已查 3/5 处）」，[DESIGN-ARCH-203] §7）；错误「问题 + 识别码 + 修复」；
- 双写者告知：claude-code / opencode 两行的模型 tab 显式标注「本机另有 KeyManager 卡片矩阵在写此文件」（[DESIGN-ARCH-203] §2.1 缺口二处置，UI 告知义务随扩面带进桌面页）。
- **码表边界（第 3 版补登）**：桌面显示层**不引入** `classifyKhyError` 镜像、**不持有**设备不匹配码（桌面无设备列表）；错误码一律来自 service 叶子契约，文案按「问题 + 识别码 + 修复」三段直出。逐端载体与边界理由见 §7.4、§8.5，不要为了「四端一致」把网页的镜像搬进主进程。

### 7.6 与既有 bridge/配对机制的关系

桌面端不参与配对、不持设备列表（本期只管本机，AI 自答待确认 requirement-5q.md:182）；它读的就是本机 service，与终端 CH-3 打的是同一台机器的同一份装配结果，四端同源校验（requirement-5q.md:342-349）里桌面读数 = `hub --json` 读数。

### 7.7 待拍板项引用

1. 桌面是否也要设备列表/跨机（requirement-5q.md:394 自答第 1 条，用户未问）；
2. claude-code / opencode 第三个写入面是否接受（[DESIGN-ARCH-203] §9 待拍板第 5 条）；
3. qoder 等 4 家写腿归属（[DESIGN-ARCH-203] §9 第 4 条）。

---

## 8. 手机端（Flutter 远程面 · CH-4 远程）

> 本节对应上游草稿编号 §14.3（四端接线稿）。依证据把扩面决定落成契约。

### 8.1 通道判定

[DESIGN-ARCH-071] 五问——Q3「与 backend 同一 Node 进程？」否，手机是 Flutter/Dart 进程（`delivery/mobile/khy-os-client-app/pubspec.yaml:1` name=khy_os_client、`:7` dart sdk ^3.13.2、`:10-11` flutter sdk，无 Node 运行时），CH-2 物理不成立；CH-3 前置「本机可运行 khy」（[DESIGN-ARCH-071]:16）不成立；Q4「远程机器 → CH-4」命中（`:39`）。既有裁决 [DESIGN-ARCH-203]:15、:111 只覆盖桌面/Web 两表面；**手机并入既有 CH-4 这条路径（与网页同命名空间、同一套 `authenticateToken`），第三条路径由终端 CH-3 承担**（第 5 版按评审第 3 条订正：原文「本节把『两条暴露路径』扩为第三条远程路径」把手机自己数成第三条、终端成第四条，与 §0 第 1 条 / §2.1 / §2.4 手机行 / §3.6 的「四端三条」冲突）。本节的扩面与 requirement-5q.md:157-166 的四端通道表一致，不推翻原裁决。

### 8.2 鉴权语义（三条硬前提，写入契约）

1. `/api/agent-hub` 只挂 `authenticateToken`（JWT-only）：`authenticateAccessToken` 只 `jwt.verify`（`authSessionService.js:307-320`），`middleware/auth.js:175-199` 无回环豁免、无 X-API-Key 分支。部署目标机须有 `JWT_SECRET` + DB 用户——实测登录分支：`handleAuthLogin`（`aiManagementServer.js:1369` 起）里 envToken 与 builtin 账号（`:1405-1424`，`builtin-${Date.now()}-…` token `:1410`）返回的都不是 JWT，**过不了 authenticateToken**；JWT 分支 `:1429-1434` 在 `JWT_SECRET` 未配置时直接 500。手机端已有完整 JWT 链可复用：`khyos_api.dart:192-213` login → `:216-233` refresh → Bearer 头 `:261`（logout）/:275（fetchModels）/:303-304（streamChat）/:410-411（apiFetch）。
2. 不改挂 `aiManagementServer` 自管 `authenticate()` 作手机接入面：那是另一套鉴权（JWT Path A `:1198-1222` / X-API-Key Path B `:1224-1235` / loopback·LAN opt-in 豁免 `:1248-1261`），与 `authenticateToken` 是两套；照 ecoMarkets 样板的**挂载形状**挂 `authenticateToken`（`aiManagementServer.js:385-386`，import 用后端本地 `middleware/auth`——见 §3.4），不造第二套鉴权，也把「手机能否用 X-API-Key」这个问题关闭（不能：`authenticateToken` 两套实现都只认 Bearer JWT，X-API-Key 只存在于同模块的 `flexibleAuth` 里，本命名空间禁挂）。
3. 可达 origin 由配对载荷下发、不得 127.0.0.1 兜底（requirement-5q.md:206-214 三要素）。

### 8.3 订正记录（配对载荷与 JWT 的关系；连接态只有单端点）

**配对载荷与 JWT 的关系**：扩面决定原文写「配对载荷下发可达 origin + owner Bearer JWT」——实测**现状载荷只带地址不带任何令牌**：`buildPairingPayload`（`cli/handlers/mobile.js:145-148`）返回 `JSON.stringify({ apiBaseUrl })`；`handlePairing`（`:216-249`，二维码打印 `:234-246`）同；手机侧注释也明说「配对二维码只带地址不带令牌，所以第一次打开市场必然要在这里补一次登录」（`market_catalog.dart:434-437`）。owner JWT 由登录获得（`khyos_api.dart:192`），不是配对下发。

**单端点现状**：`KhyOsConnection` 只存一个 `apiBaseUrl`，`isConnected` 即 apiBaseUrl 非空、`isAuthenticated` 即 accessToken 非空（`khyos_api.dart:91-105`）；且**地址与凭据在同一条 SecureStorage 记录里**（`khyos_connection`，`:137-138`），`logout()` 删整条（`:254-267`）——**设备列表是新增状态面，「逐设备凭据 / 按设备登出」则是同一批工作的新增缺口**（§8.5 行 1；评审第 10 条）；「remote 永远 Bearer null、401 显示成连接失败」的既有缺口（[DESIGN-ARCH-192]:89）在手机面属实待补。

### 8.4 角色裁剪的不对称（必须写明，不代决）

手机端没有 Web 的角色体系——`lib` 全树无 admin **角色判定逻辑**（`isAdmin` / `ROLE_ADMIN` / `role == 'admin'` 本轮检索零命中，§12 E5），`role` 一词的其余出现均为聊天消息角色字段。但**「没有角色判定」不等于「没有 403 呈现面」**：全树 403 命中 32 处（本轮 `node` 递归扫描 `delivery/mobile/khy-os-client-app/lib` 222 个文件实测，排除 `node_modules` / `.dart_tool`），其中 `lib/core/gateway/market_catalog.dart:605-606` 正是 `authenticateToken` 命名空间（/api/eco-markets、/api/skills/install）的 403 文案——「权限不足 (403)：当前账号无权$action。修复：换用管理员账号，或联系后端维护者分配权限。」；同类呈现另有 `lib/ui/screens/settings_screen_new.dart:1520`（`case 403: return '权限不足'`）、`lib/ui/screens/chat_screen_new.dart:2849`、`lib/core/services/arena_runner.dart:192-193`。

若 `/api/agent-hub` 只挂 `authenticateToken`，任意 active 用户的 JWT 即可从手机触发 W2/W3/W3+ 写与 W3+ 删数据——单 owner 部署（requirement-5q.md:171-182）下无实害，但机制语义如实写明。另有一处**口径冲突必须澄清**：上述市场 403 文案引导用户「换用管理员账号」，隐含「存在管理员角色」的团队模型，与 §3.5「不引入 Web 的 ROLE.ADMIN 角色裁剪、authenticateToken 通过即 owner 本人」的单人模型并不自洽；本文不代改那条既有文案，但 agent-hub 的手机端 403 文案**不得沿用「换用管理员账号」引导**（单人模型下无管理员可换），落 `PERMISSION_DENIED` 码 + owner 自查文案，码值与措辞归 §11.3 第 2 条契约决策员新增码时一并定。四端扩面据此保留拍板项：手机端操作分级是否裁剪（封顶 read-only / assets？W3 装卸是否允许从手机远程触发桌面主机？）——用户已拍板「四端全可写」（requirement-5q.md:150-151），故**默认不裁剪**，但二次审批机制待拍板（§11.1 第 1 条）。

### 8.5 落点与状态面清单（草稿表截断，按已到达材料收拢）

上游草稿的落点文件表自第 1 行 `lib/core/gateway/khyos…` 起被截断（见 §13.4）。下表前三行为已到达材料可确证项，第 4、5 行是**第 3 版按 arrived 材料增收**（表头口径不变：增收行不是草稿原文）：

| # | 文件 | 动作 | 依据 |
|---|---|---|---|
| 1 | `lib/core/gateway/khyos_api.dart` | `KhyOsConnection` 由「单 apiBaseUrl」扩成「设备列表 + 当前选中设备」；复用既有 JWT 链（login / refresh / apiFetch）。**依赖标注（第 4 版按评审第 10 条补全）**：① 按设备隔离写权限与确认令牌、跨设备令牌拒绝，依赖 §11.3 第 1 条选型，**本期不可验收**（§1.2、§1.5）；② **逐设备凭据与逐设备登出今天没有定义，也必须在同一行写死**——现状是一条 SecureStorage 记录 `khyos_connection` 同时装地址与 `accessToken`/`refreshToken`/`user`（`:92-119`、`:137-138`、`:162-166`），`logout()` 调 `clearConnection()` 删整条记录（`:254-267`），多设备下「按设备登出」「换设备后旧令牌怎么办」都不存在；且按 §3.4/§8.2 每台电脑各持本机 `JWT_SECRET` 与本机 DB，**A 机令牌到 B 机必 401**（`authSessionService.js:235-245`、`:314`、`:333`、`:358`），故「A 切 B 后全部跟随 B」在补出逐设备登录前**不可实现**（§1.5 已标本期不可验收） | `:91-105` 现状；`:92-119`、`:137-138`、`:162-166`、`:254-267`；`:192-213`、`:216-233`、`:410-411` |
| 2 | `lib/core/gateway/pairing.dart`（配套 `cli/handlers/mobile.js`） | 配对载荷补可达 origin 字段（[DESIGN-ARCH-192]:466 的 `authBaseUrl` 计划）与设备身份；扫码后入设备列表。**现状配对载荷只含 `{ apiBaseUrl }`、不含任何凭据**（`mobile.js:145-148`；`pairing.dart:68-71` 的 `token` 字段注释自陈「current producer does not emit one」），**「设备身份」同样依赖 §11.3 第 1 条，本期不可验收** | `mobile.js:145-148`；[DESIGN-ARCH-192]:466 |
| 3 | 手机端「智能体」页（**宿主壳须先定，见下「两套导航真源」**） | 设备列表 → 总表 → 干跑 → **按档位走确认**（W1 免令牌；W2/W3 确认卡；W3+ 第二级确认 + losses 摊开，§6.5/§7.4 同口径）→ apply → 回滚点；**A/B 切换「全跟随」依赖逐设备登录，本期不可验收**（§1.5、§8.5 行 1） | requirement-5q.md:330-340（Q4 手机验收七步） |
| 4（增收） | `lib/core/gateway/market_catalog.dart:589-635` 与 `lib/ui/screens/settings_screen_new.dart:1516-1529` | agent-hub 的 403 / 404 / 降级文案**必须新落一个专属路径**：403 不沿用市场页「换用管理员账号」引导（单人模型下无管理员可换，§8.4）；404 照 `case 404` 的「接口不存在」语义（不得走网页镜像的 `MODEL_NOT_FOUND`，§6.6）；离线文案照 Dio 分支；码值由 §11.3 第 2 条新增 | `marketDescribeDioError` `:589-635`（`case 401` `:602-604`、`case 403` `:605-606`、**`case 404` `:607-612`**、超时 `:617-623`、`connectionError` `:624-627`）；`_describeHttpStatus` `:1516-1529`；§8.4、§6.6 |
| 5（增收） | `delivery/web/ai-frontend/src/utils/classifyKhyError.mjs` 的登记与同步 | 该镜像按 `LAYOUT-008` 在 `DATA-SSOT.json` 补登记真源与授权镜像，并加可执行同步校验（交付义务详见 §11.3 第 2 条） | `classifyKhyError.mjs:3-5`（镜像自述）；`DATA-SSOT.json` 实测无该项（§12 B14） |

**手机 UI 的两套导航真源（第 3 版补登，落点必须择一写死）**：今天并存两套——

1. `lib/core/router.dart:12-56` 的 go_router：`ShellRoute` 下挂 `/chat` `/agent` `/skills` `/independent` `/settings`，其中 `/agent` 指向 `lib/ui/screens/agent_screen.dart:5-42`，内容是**占位页**（标题「Agent 模式」`:12`、正文「即将推出」`:32`）；
2. `lib/main.dart:230-235`、`:351-385` 的 `IndexedStack` **六页签**（文件 / 控制台 / AI / 技能 / 设备 / 设置），第 4 页签「技能」挂 `ToolsHubScreen`（`:370`），`IndexedStack` 让各页 State 不重建（`:394-398`）。

**若把新页挂到 go_router 的 `/agent`，它会落在 `main.dart` 根本不消费的那套壳里**——用户从主页签进不去（go_router 壳里的底部 nav 是 `home_shell.dart`，与 main.dart 的六页签是两套）。新页必须写明宿主是 `main.dart` 的 `IndexedStack`（加第 7 页签，或挂「技能」页内的 tab），草稿原文如何定的落点仍列 §13.4 R0-3 待核对项。

**「智能体」一名在手机有三层含义，必须区分**：① go_router 壳的底部 tab「Agent」（`home_shell.dart:29`）；② 主页签「技能」里的「工具与智能体」页，其页内 tab「智能体」（`tools_hub_screen.dart:88-93`，`:92`）内容为写死的 4 个借来智能体 + 内置子智能体静态卡（`:502-533`），**只读、无设备列表、无装卸**；③ go_router 的 `AgentScreen` 占位页。**建议新页定名「智能体管理」或「外部智能体」**，与现有三层显式区分；定名属设计事项，本条只登记冲突，不代裁。

**新增状态面清单（第 4 版按评审第 9、10 条补「本期可交付 / 不可交付」标注，并补登两处原清单漏掉的态）**：

- **设备列表（多设备）、当前设备选择**：本期新增状态面，落点依赖 §11.3 第 1 条选型；**逐设备凭据与逐设备登出是同一批工作**（§8.5 行 1 已写死现状缺口）；
- **该设备未登录态**（第 4 版新增）：多设备下「A 已登录、B 未登录」是常态，必须有独立状态与「仅对本设备登录」动作——现状 `isAuthenticated` 只反映那一条连接（`khyos_api.dart:105`），没有逐设备概念，`logout()` 删的是整条记录（`:254-267`）；
- **PC 离线态**：**本期可交付**，载体是 Dio 分支——`connectionTimeout` / `receiveTimeout` / `sendTimeout` `market_catalog.dart:617-623`、`connectionError` `:624-627`（原文只写了「PC 离线态」四字、没有载体，等于不可实现）；
- **配对过期态**：**本期不可交付**——**手机端 `lib/` 全树** `配对过期` / `PAIRING_EXPIRED` / `pairing_expired` 0 命中（范围仅限手机端；全仓其实有 `PAIRING_EXPIRED` 码与 `pairingCode.js` 的 TTL 实现，见 §1.5 该子项与 §12 B16），手机配对载荷只有 `{apiBaseUrl}`（`mobile.js:145-148`）、解析只回 apiBaseUrl（`pairing.dart:144`），既不携带也不校验有效期；要交付须先给载荷加有效期并接既有码（§11.3 第 2 条）；
- **设备不匹配错误码**：**本期不可验收**（§1.5、§11.3 第 2 条）；
- **扫错二维码的既有防呆态**：已有且必须保留（`pairing.dart:119-142`，两套文案分别对应管理页二维码与桌面 Web 远控链接）。

**码值与文案的逐端载体（第 3 版补登）**——「四端文案一致」不等于「四端共享同一张码表」，四端各有载体：

| 端 | 载体 | 说明 |
|---|---|---|
| 后端 / 桌面 | service 叶子契约的 `error.code`（[DESIGN-ARCH-071]:35 的 `fail-soft {ok,error}`） | 码值由 `shared/src/errorEnvelope.js:223`（`classifyKhyError`）/`:234-235`（STATUS_TABLE 命中）/`:306`（`toEnvelope`）生成；桌面经 CH-2 直调消费，不经过 `classifyKhyError` 镜像（边界见 §7.4） |
| 网页 | `delivery/web/ai-frontend/src/utils/classifyKhyError.mjs`（shared 四张表的镜像，`:3-5` 自述） | 页面显示层用，禁止直接 import shared 真源（[DESIGN-ARCH-071]:53）；显示出口 `src/api/notify.js:129`、`:156` |
| 手机 | **无共享表**，各自 `switch` | `lib/core/gateway/market_catalog.dart:601-627`（`marketDescribeDioError` 的 `case 401` `:602-604`、`case 403` `:605-606`、**`case 404` `:607-612`**、Dio 超时 `:617-623`、`connectionError` `:624-627`）、`lib/ui/screens/settings_screen_new.dart:1516-1529`（`_describeHttpStatus`，实测区间） |
| 终端 | formatter 直出文案，**无码表** | 同一份 service 装配（§5.3），不引入第二套码值体系 |

设备不匹配专用码今天不存在：`CODES` 无此项，403 只映射 `PERMISSION_DENIED`（`shared/src/errorEnvelope.js:77-78`），新增码与 HTTP 状态由契约决策员定（requirement-5q.md:408，§11.3 第 2 条）。

**既有防呆态不得漏登记**：扫成管理页二维码（`pairing.dart:119-127`）与扫成桌面 Web 远控链接（`:133-142`）今天都有专门文案、且都明确说「所有请求都会 404」；agent-hub 的设备列表扫码入口**不得绕过 `PairingPayload.tryParse`** 自写一套解析，否则这两条防呆文案会失效。

### 8.6 待拍板项引用

1. W2/W3/W3+ 手机端是否加二次生物识别/独立审批（requirement-5q.md:402）；
2. 身份与配对机制选型（[DESIGN-ARCH-192] 与 [DESIGN-ARCH-216] 如何衔接，requirement-5q.md:407）；
3. 设备列表与「智能体」页在手机端的具体落点（草稿截断未定，见 §13.4）。**第 3 版补：宿主壳已由 UI 实测收窄**——新页必须挂在 `main.dart` 的 `IndexedStack`（六页签壳），不能挂 go_router 的 `/agent`（那是 `main.dart` 不消费的另一套壳，见 §8.5）；剩待定的是「加第 7 页签」还是「挂『技能』页内的 tab」，以及页面定名（建议「智能体管理 / 外部智能体」）。**第 4 版：这两项已分别回登 §11.2 第 9 条（宿主）与第 8 条（定名）**——此前只在本节出现，按 §11 收口会被误当已决（评审第 12 条）。

---

## 9. 终端接线与验收（草稿正文未送达）

> 本节对应上游草稿编号 §14.4（四端接线稿）。该节正文在派发时未随任务到达（截断，§13.4）；其通道裁决原文完整（§2.4 终端行），接线契约由 §4 承载，验收由 requirement-5q Q4.1 承载。本节**以索引为主**；§9.4 是第 3 版按 arrived 材料与 UI 实测补登的「命令面现状三项」，不是草稿正文。

### 9.1 通道裁决（原文）

终端 = CH-3 CLI（`khy agent-assets hub` / `hub --json` 子命令扩展，已有裁决；handler 内 CH-2 直调同一 service）。依据：[DESIGN-ARCH-203] §4.4（`:306-330`）「只扩展、不新增」；[DESIGN-ARCH-071] 五问：人/脚本/CI → CH-3（`:38`），机器高频消费优先 `--json`（`:54`）故 `hub --json` 并行提供；handler 内调 service 是同 Node 进程 CH-2（`:34-35`）。实测目标态缺口：`commandSchema.js:641-651` 9 项无 `hub`，`handlers/agentAssets.js:446-470` switch 无 `hub` 分支、`:479` manifest 6 项——加 `hub` 时按 §4.2「先补存量漂移再统一加」。终端只管它所在的那台电脑、不做跨机代理（AI 自答待确认，requirement-5q.md:202）。

### 9.2 接线落点

见 §4.2 五处同步清单（文件:行与改法）；TUI 侧判定见 §4.3。

### 9.3 验收

- 命令与期望输出：requirement-5q.md:266-298（Q4.1；`hub` 全实例总表、`hub --json` 机读、未安装列检查路径、计数纪律）；
- 字段集合：§4.4；
- 四端同源：requirement-5q.md:342-349（`instances[].id` 集合逐项一致）；
- 写操作：§2.1 共用分级（[DESIGN-ARCH-203] §6.1 `:411-417`）、§5.3 终端约束。

### 9.4 命令面现状三项（第 3 版补登，UI 实测）

**① 命名空间混淆：`hub` 挂在 `agent-assets` 下，但终端里已有三个近义词**——实施者与用户都会撞上，必须显式区分：

| 命令 | 语义 | 证据 |
|---|---|---|
| `khy agent` | **代理角色模板**（`list` / `templates` / `run` / `spawn`），与本功能无关 | `commandSchema.js:426`；分派 `routerDispatchOps.js:1466-1489`；实跑 `khy agent list` → 「代理角色模板」|
| `khy agent-assets` | **外部 agent 资产**（本功能宿主族） | `commandSchema.js:1289-1292`，面板 label「外部 agent 资产」 |
| `khy agent-assets hub` | 本功能新增子命令（总表 / `--json`） | 目标态（§12 H2） |

命令面板里 `/agent` 的 label 是「**代理管理**」（`commandSchema.js:2148`），`/agent-assets` 是「外部 agent 资产」（`:1289-1292`）；**`aliases.js:475-478` 的中文别名「智能体」已被顶层 `khy agent` 占用**（`智能体 → command: 'agent'`、`智能体状态 → agent status`，实测 `:477` / `:478`）——故 `hub` **不得复用「智能体」别名**，四端统一名称只能落在「智能体管理 / 外部智能体」这类未占用词上（命名建议见 §8.5；四端现有 label 的逐端对照与冲突见下 **§9.5**）。

**② 别名计法：写 manifest 不触发棘轮，写 `aliases.js` 才触发 +1**——`checkSurfaceRatchet` 的 `aliasEntries` 只数 `aliases.js` 里的 `command:`（`scripts/ci/check-delivery-baseline.js:625-630`，按文件文本正则计数，运行时合并进来的不算）。`agent-assets` 现有的两个别名 `agentassets` / `aassets` 声明在 **handler manifest**（`handlers/agentAssets.js:475-477`），由 `aliases.js:829-832` 的 `commandAutoRegistry.getAliases()` 在运行时并入（注释原话「Handlers that export a manifest with `aliases` don't need entries here」），**不在 `aliases.js` 的文本里**（该文件检索 `agent-assets` / `agentassets` 均 0 命中，本轮实测）。§4.1 那句「若为 `hub` 新增别名条目，`aliasEntries` 会 +1」须按此限定：**加在 manifest 不计、加在 `aliases.js` 才计**。

**③ `--json` 是新增能力，不是给既有命令加开关**——`handlers/agentAssets.js` 全文检索 `json` / `JSON` **均 0 命中**、`printTable` **7 处**（本轮实测），即该族今天没有任何机读通道；`hub --json` 属于**新写一条投影路径**，不能按「既有命令加个 `--json`」估工作量。表格输出侧（`hub` 无 `--json` 时）行粒度 = 实例（§1.5 终端行），列对齐 [DESIGN-ARCH-203] §5.2 的表格列（§4.4 已逐列映射）。

### 9.5 四端入口名称对照（第 4 版按评审第 11 条增；定名待拍板）

四端 label 今天互不相同，且与本文自己给的定名规则冲突——没有这张对照表，实施者会各端按各自章节原名落地：

| 端 | 当前 label / 落点 | 出处 | 与「未占用词」规则的关系 |
|---|---|---|---|
| 网页 | 侧栏「智能体」 | §6.4 第 1 行、§6.5「入口名称与位置」；沿用 [DESIGN-ARCH-203]:397 的 `label: '智能体'` | **违规候选**——「智能体」是顶层 `khy agent` 的中文别名（`runtime/node/backend/src/cli/aliases.js:477`） |
| 桌面 | 「智能体统一管理」 | §7.3、§7.4 入口候选① | 未占用 |
| 手机 | 「智能体管理」或「外部智能体」（二选一建议） | §8.5「一名三层」段 | 未占用 |
| 终端 | `khy agent-assets hub`（无中文 label） | §9.4 ① | 未占用；明确不得复用「智能体」 |

- **冲突一 · 四端不统一**：网页「智能体」、桌面「智能体统一管理」、手机「智能体管理」是**同一件东西的三个名字**，用户跨端会当成三个功能。
- **冲突二 · 与本文自己的规则相反**：§9.4 ① 判「四端统一名称只能落在未占用词上」，而 §6.4 钉死的网页 label 是「智能体」（已占用）——两处直接对立。要么把网页 label 改成「智能体管理」，要么把该规则降为建议；本文不代裁，已上提 §11.2 第 8 条。
- **冲突三 · 同台混淆（用户可感知）**：网页管理台已有 `/admin/agents`，页内标题「Agent 监控」（`delivery/web/ai-frontend/src/views/admin/AgentDashboard.vue:3`，数据源是后端进程内存 worker，§1.4），与新增「智能体」页同处「管理控制台」组——两个都叫「智能体/Agent」的页面并排，用户分不清「worker 监控」与「外部 agent 安装配置」。本条只登记；实施时须靠副标题/图标/分组区分，具体文案归定名拍板一并定。
- **定名是横跨四端的单一决定**：不能由某一端章节单独定（§8.6 第 3 条只管手机端定名）；落定前四端按上表现值实施，不得各端自行改名。

---

## 10. 不做清单

### 10.1 本轮增补三条

1. **不接管 khyquant 前端**（`delivery/channel/khyquant/frontend`）。理由：独立项目边界——`AGENTS.md:106` 明写「khyquant（量化交易终端）是独立项目（人 2026-09-28 明示），它连接 Khy OS 使用，不是 Khy OS 的内置组成部分」，`delivery/channel/khyquant/frontend` 只是随平台分发的载体；[DESIGN-ARCH-203]:548 不做清单第 5 条「不接管 khyquant」既有裁决同判。**另案申报、另案管理，agentHub 注册表与四端暴露矩阵均不为其开条目。** 它也不算进本期写权限范围（requirement-5q.md:369）。
2. **不并入 provider-hub**（`delivery/web/provider-hub`）。理由：非用户点名的第五端——`package.json:6` 自述「Provider Card Hub — standalone desktop GUI for unified provider/agent-model management (DESIGN-ARCH-094)」，是独立 Electron GUI（`src/main` + `preload` + `renderer`），有既有设计文档 [DESIGN-ARCH-094]，且**已带自己的写腿**——`src/main/toolWriters.ts:117` 载入后端 `domain/config/ccSwitch/appWriters.js`、`src/main/providers.ts:78-95` 的 `atomicWriteJson` 写 `cc_switch.json` / `api_keys.json`。若并入统一管理面即成第二套 provider/agent-model 写者与第五个暴露面，违反「杜绝第二写者」（[DESIGN-ARCH-203]:115）。**本期四端扩面不并入、不改其契约；日后若要并，须先做写者归并裁决。**
3. **跨设备批量操作 / 跨设备资产同步维持不做**（[DESIGN-ARCH-203] §9 第 4 条「不做多机同步」的延伸）。理由：用户明确保留待拍板（requirement-5q.md:403）。**设备列表（选哪台管哪台）不在其列**——那是单人多机拍板已定的范围（requirement-5q.md:178：手机/外网网页保存设备列表，选中哪台，总表与写操作就指向哪台）。

### 10.2 沿用 [DESIGN-ARCH-203] §9（指针，不复制）

其 16 条不做（不做一键清理配置、不猜未知智能体格式、不做多机同步、不接管 khyquant、不做凭据统一托管、不新增 CLI 顶层命令、不改四套既有契约、不做全盘递归扫描、不做智能体市场、不为 4 家新写后端写器、不给 installationCandidates 补三平台、不归并 claude-code / opencode 双写者、不给 auth.js 加回环豁免、不改 install-ledger Schema、不改 00_INDEX 手计数等）与 5 条待拍板中的 **4 条**继续有效（第 4 版按评审第 3 条订正）；**第 1 条已被 2026-11-16 用户拍板回答，不再算待拍板**：[DESIGN-ARCH-203]:565 问的是「Q1『谁用』：是否只限本机 owner 单人单机？要不要团队/多机视图？」，而拍板二给的是「单人多机、没有团队、没有第二个有写权的人」（requirement-5q.md:152-153、:171-182；本文 §1.7 同判）——把它并进「全部继续有效」会让读者以为 §11.1 之外还有一个用户级未决项，也与本文 §1.7「用户已拍板」自相矛盾。其余 4 条（`cusur` / `command code` 指代、Web 管理台本轮是否做、qoder 等 4 家写腿归谁、claude-code / opencode 第三写者）继续有效，后两条本文 §11.3 第 3、4 条已承接。本文只增补上述三条。降级指针：逐条原文见 [DESIGN-ARCH-203] §9 `:540-570`（不做清单 `:544-559`、待拍板表 `:561-569`）。

### 10.3 拍板明确排除（requirement-5q §4.7）

1. 不做团队角色、不做多人审计归属——单人多机，只有一个 owner（requirement-5q.md:368）；
2. khyquant 前端不在四端内，不算进本期写权限范围（:369，同上述第 1 条）；
3. 不做「智能体市场」（分发归 `khy-market` / `ecoMarkets`，:370，同 [DESIGN-ARCH-203]:553）；
4. 不做全盘递归扫描（探测只用五源：PATH → 安装候选目录 → 注册表 → 用户数据目录 → 运行中进程，:371，同 [DESIGN-ARCH-203]:552）。

---

## 11. 待拍板清单

### 11.1 用户保留待拍板（2 条，不得代决）

| # | 问题 | 原话口径 | 出处 |
|---|---|---|---|
| 1 | **远程写操作的默认安全档位**：W2/W3/W3+ 在手机上是否要求二次生物识别或独立审批（例如另一台已登录设备批准）？ | 用户明确保留此项待拍板，本文件不替用户定 | requirement-5q.md:402 |
| 2 | **是否为多设备做批量操作 / 跨设备同步资产**：一次把 A 机 skill 同步到 B 机、一次对多台电脑执行同一计划？ | 用户明确保留此项待拍板；不做也不影响本期验收 | requirement-5q.md:403 |

### 11.2 AI 自答待确认（9 条）

> 第 1–5 条为第 0 版起的既有自答项；**第 6–9 条是第 4 版按评审第 7、11、12 条补登的正文未决项**——原正文在 §7.4 / §8.6 / §9.4 / §2.3 分别提出它们，却只指向别处或压根没有指向，按 §11 收口时会被当成已决（评审第 12 条）。

| # | 自答内容 | 出处 |
|---|---|---|
| 1 | 桌面端本期只管本机、不带设备列表——用户只把手机与外网网页定义为接入点，桌面是否也要跨机未问 | requirement-5q.md:394 |
| 2 | 四端 UI 能力一致、载体各异（各自原生页面 + 终端表格 / `--json`），不要求像素级同一套布局 | requirement-5q.md:395 |
| 3 | `hub --json` 的字段集合（`instances[]` 的 id / status / hitSources / assets / mcpCount / modelSummary）为 AI 拟定，待契约决策员定稿（本文 §4.4 拟以 `installed` / `not-installed` 两值收口，**仍待契约决策员确认**；确认前 5q:290 的三值枚举仍是唯一在册版本；两值 / 两值+组合键 / 三值三案并列，代价与替代判定字段见 §4.4。**第 4 版增补**：同一条一并定「行粒度=实例、`id` 粒度=品牌」的键名（`installationId` 或实例级 `id`）与「工具数」列的归属——见 §4.4 两条补登） | requirement-5q.md:396；§4.4 |
| 4 | 终端只管它所在的那台电脑，本期不做终端跨机代理（SSH 到目标机后仍用同一命令） | requirement-5q.md:397 |
| 5 | 「等等」的外延本期按用户拍板逐项列举的五类收口（装卸 / 模型 / MCP / skill / 记忆）；凭据与 API key、提示词库、插件、终端配置不在本期范围——依拍板枚举收窄，未见用户逐项否决 | requirement-5q.md:398 |
| 6 | **终端 W2/W3 没有命令落点**：拍板① 要求四端都能「装/卸、改模型」，但 `khy agent-assets` 今天只有读命令（`discover / caps / capabilities / list / plan`）与 W1 写（`import / export / sync`），W2 改模型与 W3 装卸程序本体在 CLI **无任何动词**（`commandSchema.js:641-651`、`handlers/agentAssets.js:446-463`），本文 §4.2 五处同步清单也只加只读 `hub`。两条路：本期给终端补 W2/W3 命令（扩命令面，须过任务面棘轮并同批登记确认闸门），或如实把终端标为「本期 W1 可写、W2/W3 只读」并请用户确认不违背拍板① | 第 4 版按评审第 7 条补；requirement-5q.md:150-151；§2.3、§5.3 第 2 条 |
| 7 | **桌面入口落点三候选择一**：① TitleBar 窗口菜单（紧跟「密钥与端点管理」，`TitleBar.tsx:176`）、② TitleBar「四端互跳」组并列（`:204-208`）、③ WorkspaceSidebar 顶部导航区（`:855-895`）。本文建议①，不代裁 | 第 4 版按评审第 12 条补；§7.4 |
| 8 | **四端统一定名**：网页「智能体」/ 桌面「智能体统一管理」/ 手机「智能体管理」是同一件事的三个名字，且「智能体」已被顶层 `khy agent` 占用（`aliases.js:477`）；建议落在「智能体管理 / 外部智能体」，须四端一次定死并同步 §6.4 第 1 行的 label | 第 4 版按评审第 11、12 条补；§9.5 |
| 9 | **手机新页宿主**：必须挂 `main.dart` 的 `IndexedStack`（六页签壳），不能挂 go_router 的 `/agent`（那是 `main.dart` 不消费的另一套壳）；剩「加第 7 页签」还是「挂『技能』页内 tab」待定 | 第 4 版按评审第 12 条补；§8.5、§8.6 第 3 条 |

### 11.3 委托契约决策员的事项（非用户级，6 条）

1. 身份与配对机制选型：[DESIGN-ARCH-192] 四端 OAuth2（含 `khy login --device`、手机配对载荷补 `authBaseUrl`）与 [DESIGN-ARCH-216] 手机端授权 broker，二者如何衔接（requirement-5q.md:407）。**本条同时决定 §1.2 / §5.2 第 5 条登记的「设备身份」缺口如何补齐、§1.5 哪些手机验收项可解锁——选型落定前相关验收不可通过。** 既有约束须作为决策输入（第 2 版补登，**第 5 版增第三块，见 §13.9 第 2 条**）：① `originGuard.js:52-60` 已裁 `null` / `file://` 必须放行（Electron 生产构建 `loadFile()` 的 Origin 即 `null`，拒绝会打断桌面端；收紧到「连本机网页也不放行」需引入登录前 token，是另一个量级的改动）；② 会话粒度签发/标注/撤销链已在（`authSessionService.js:265-305` / `:358-382` / `:399-437`）；③ **`services/devicePairing.js` 是仓内现成的加密设备身份与配对机制**（Ed25519 + SHA256 指纹 + 角色/scope + 配对生命周期 + `EXPIRED`/`REVOKED` 态 + 24h/10min TTL；已被 `webRemoteControl/pairingCode.js:19`/`:58` 与 `protocol.js:77` 消费）。**决策必须显式回答「复用 `devicePairing.js` 还是另建」并说明理由**——实测 [DESIGN-ARCH-192] 与 [DESIGN-ARCH-216] 各 0 次提及 `devicePairing`（§12 B16），若本表不写这一项，实施者会在既有机制外再造一套设备身份。选型是在②之上补「设备↔origin 绑定」，**不是从零建，也不得绕开③**。
2. 设备不匹配的错误码与 HTTP 状态：现有 `CODES` 无「设备不匹配」专用码（403 只映射 `PERMISSION_DENIED`，`errorEnvelope.js:77-78`）——注意 **`PAIRING_EXPIRED`（配对码过期）不在此列，它已在册**（`:47`、`:139-140`，见 §12 B16）；本条要新增的是「跨设备令牌/设备不匹配」语义的码，需保证四端文案一致（requirement-5q.md:408）。**「一致」的交付义务按逐端载体拆开**（载体清单见 §8.5）：新增码时四端载体同改——后端码值（service 叶子契约 / `errorEnvelope.js` 生成）、网页镜像 `classifyKhyError.mjs`、手机各 `switch`（`market_catalog.dart:601-606`、`settings_screen_new.dart:1516-1529`）、终端 formatter 文案。**且镜像须按 `LAYOUT-008` 在 `docs/10_规范/registry/DATA-SSOT.json` 登记真源与授权镜像**——实测该登记表今天没有 `errorEnvelope` / `classifyKhyError` / `STATUS_TABLE` 任何一项（三关键字检查全 false，§12 B14），同步义务不得只靠 `classifyKhyError.mjs:3-5` 那句注释：该注释点名要同步的 `apps/khy-mobile/src/utils/classifyKhyError.mjs` 实测**已不存在**（手机端已迁到 Flutter 的 `delivery/mobile/khy-os-client-app`，不走 mjs 镜像），即「靠注释自觉同步」已经失效。故本条应一并交付**可执行同步校验**（test 或守卫），与码值新增同批落地，不得只写在文档里。
3. qoder / workbuddy / kiro / cursor 的模型配置写腿归谁（[DESIGN-ARCH-203] §9 待拍板第 4 条）；在此之前这 4 家在四端都只能读，UI 必须显式标注「只读：后端尚无写器」，不得静默失败（requirement-5q.md:409）。
4. claude-code / opencode 双写者是否接受 agentHub 成为第三个写入面（[DESIGN-ARCH-203] §9 待拍板第 5 条；requirement-5q.md:410）。
5. 网页「智能体」页的落点与角色门：若挂在 `/admin` 命名空间，owner 账号须具备 ADMIN（NAV 管理组 `requiredRole: ROLE.ADMIN`，`src/nav/index.js:121`）；是否改为顶层入口由设计定（requirement-5q.md:411）。
6. **后端是否给 `/api/agent-hub` 叠 `requireAdmin`（本文新增委托项——requirement-5q.md:411 只裁前端落点与角色门，不含后端守卫层，第 2 版订正出处）；不叠的现状语义是「任何 active 用户 JWT 可全档写」**。实测两侧先例都在：`adminMiddleware` 在册且已导出（`backend/src/middleware/auth.js:201-215`、`:272`），`ecoMarkets`/`proxy-subscriptions` 只挂一层（`aiManagementServer.js:386`、`:326`），而 `gui-eval` / `web-frontend-eval` 叠了两层（`:429-430`、`:445-447`）、`/api/wx` 条件叠（`:346-349`）——补与不补都是现成动作，正因如此不能靠「照着某处惯例」默认处置。本文不代裁（§6.2、§6.8 第 2 条）；**若叠加，落地时按 §2.6 的四拦截面登记要求表补 `rollout.mechanisms[]` 条目**（`stage=S1` + `executorStage.{file,constant}`，禁直进 S3）。

---

## 12. 事实主张清单

> 逐条给证据。「本轮核验」列含义：**复验** = 本次整合会话用 node 读文件 / 实跑命令核对过；**转引** = 来自上游草稿或 requirement-5q 的实测记录，本次未复跑（行号有未提交改动漂移的风险，实施前现场定位）。

### A. 总体与缺口

| # | 主张 | 证据 | 本轮核验 |
|---|---|---|---|
| A1 | 后端 `routes/agentHub.js` 与 `services/domain/agents/agentHub/` 均不存在；网页 `views/admin/AgentHub.vue` 不存在 | fs 存在性检查（node） | 复验 |
| A2 | `externalApps` 适配器 11 家：claudeCode / commandCode / coze / deepseekTui / geminiCli / openclaw / opencode / reasonix / traeApp / ycode / zcode，不含 qoder / workbuddy / kiro / cursor；实体在 `services/domain/network/externalApps/`，`services/externalApps/index.js:1-16` 为 shim re-export | 目录实列 + `index.js:4-16` | 复验 |
| A3 | 桌面 src 全树 `/api/` 仅 2 处命中且非后端消费 | `main/keyManager/keyStore.ts:760`、`renderer/i18n/zh-CN.json:3185` | 复验 |
| A4 | 桌面 `App.tsx:161-163` 无登录门注释仍在 | 行读取 | 复验 |

### B. 鉴权与后端

| # | 主张 | 证据 | 本轮核验 |
|---|---|---|---|
| B1 | `authenticateToken` 仅用户 JWT、无回环豁免 | `middleware/auth.js:175-199`；`authSessionService.js:307-320`，`:314` `jwt.verify` | 复验 |
| B2 | `authenticateToken` 导出名映射 | `middleware/auth.js:267-275`（`:271`） | 复验 |
| B3 | ecoMarkets 样板挂 `authenticateToken`（来自 `khy-ai-backend/middleware/auth` 解构）；同文件 `flexibleAuth` 零挂载使用 | `aiManagementServer.js:383-388`（`:385` 解构、`:386` 挂载）；全文 `flexibleAuth` 命中 0（`:326`/`:346`/`:429`/`:446` 的守卫只用 `authenticateToken`/`requireAdmin`）；被挂路由自身头注释同判：`routes/ecoMarkets.js:9`「鉴权挂在挂载点（authenticateToken），与 proxy-subscriptions / gui-eval 同款」 | 复验 |
| B4 | `aiManagementServer` 自管 `authenticate()` 是三合一另一套（JWT / X-API-Key / loopback·LAN 豁免） | `aiManagementServer.js:1198-1261` | 复验 |
| B5 | `/api/auth/login` → `handleAuthLogin`；builtin 分支返回非 JWT token；无 `JWT_SECRET` 登录 500 | `aiManagementServer.js:2327-2328`、`:1369`、`:1405-1424`（`:1410`）、`:1429-1434` | 复验 |
| B6 | `/api/eco-markets` pathname 分发实测在 `:2414`（草稿记 `:2393-2395`，该段现为 proxy-subscriptions） | `aiManagementServer.js:2414`、`:2393-2396` | 复验 |
| B7 | `__test__` 导出 `getEcoMarketsApp` | `aiManagementServer.js:3846` | 复验 |
| B8 | `khy-ai-backend/middleware/auth` 是 re-export；shared 版 `authenticateToken = authMiddleware`（`:218`）、验签 `jwt.verify`（`:130`）；**shared 版同模块的 `flexibleAuth` 含 X-API-Key 第二腿**（Path A `:170-190` / Path B `:192-211` / 双无 401 `:213-214`），backend 本地版同构（`flexibleAuth` `:217-260`，X-API-Key 分支 `:236-254`）——但两套实现的 `authenticateToken` 符号本身都无 X-API-Key 分支。**两版的实质差异是会话撤销：backend 版查 AuthSession（吊销/过期/tokenVersion），shared 版不查（B11）；shared 版另无 originGuard 族（B12）** | `runtime/node/ai-backend/src/middleware/auth.js:1`；`shared/src/middleware/auth.js:119-155`（authMiddleware）、`:169-215`（flexibleAuth）、`:218`、`:221-227`（导出面无 originGuard 族）；`backend/src/middleware/auth.js:175-199`、`:217-260`、`:262-279`、`:271` | 复验 |
| B9 | 错误码映射：401→`AUTH_REQUIRED`、403→`PERMISSION_DENIED`、ECONNREFUSED→`NETWORK_UNREACHABLE` | `shared/src/errorEnvelope.js:77`、`:78`、`:104-106`、`:49` | 复验 |
| B10 | `authenticateAccessToken` 全链路无设备/origin 绑定（只校签名/tokenType/userId/账户状态/会话有效期/吊销/tokenVersion），配对载荷现状只含 `apiBaseUrl`——缺的是「设备↔origin 绑定与配对校验」这一半（§1.2 / §5.2 第 5 条；会话级撤销链已在，见 B11） | `authSessionService.js:307-370`（`:314` verify、`:322-340` tokenType/userId/status、`:342-370` session 有效期/吊销/tokenVersion）；`backend/src/middleware/auth.js:119-127`（`attachAuthContext` 只写 user/auth/authSession）；`cli/handlers/mobile.js:145-148` | 复验 |
| B11 | **会话级的签发 / 标注 / 撤销 / 清单链已在**（第 2 版新增；两版 `authenticateToken` 的实质差异即在此）：`issueSessionForUser` 写 `tokenVersion`/`ipAddress`/`userAgent`/`deviceLabel`，`authenticateAccessToken` 按会话粒度拒绝（revoked / expired / tokenVersion 不符），`revokeSessionById` 单会话撤销、`revokeUserSessions` 全量撤销（可 `excludeSessionId`），`listUserSessions` 出清单；`serializeSession` 输出 deviceLabel/revokedAt/revokedReason；`detectDeviceLabel` 由 UA 派生。**shared 版 `authMiddleware`（`shared/src/middleware/auth.js:119-155`）不查 AuthSession——只 `jwt.verify` + `User.findByPk` + status，令牌撤销后仍有效，只能等自然过期**，故 requirement-5q.md:175 的「可撤销的凭据」在 shared 版下不成立 | `authSessionService.js:265-305`（`:275` tokenVersion、`:278-284` ip/UA/deviceLabel）、`:90-128`（`detectDeviceLabel`）、`:131-154`（`serializeSession`）、`:358-382`、`:399-415`、`:417-437`、`:513`，导出 `:528-541`；`shared/src/middleware/auth.js:119-155` | 复验 |
| B12 | **backend 本地 auth 模块还再导出 `originGuard` 一族**（第 2 版新增）：`ALLOWED_ORIGINS_ENV` / `requireLoopback` / `originGuard` / `isLoopbackAddress` / `isTrustedBrowserOrigin` / `parseAllowedOrigins`；`requireLoopback` 对非回环连接回 403「仅允许本机访问」，`originGuard` 对不可信浏览器来源回 403「请求来源不被允许」，白名单走 env `KHY_ALLOWED_ORIGINS`；`isTrustedBrowserOrigin` 已裁 `null` / `file://` 必须放行（Electron 生产构建 `loadFile()` 的 Origin 即 `null`），收紧需登录前 token。现有消费者只有 `routes/daemon.js`（`:33` 解构、`:38` `router.use(requireLoopback, originGuard)`）。**本文 0 处要求把该族用于 `/api/agent-hub`，且明令禁用作「设备配对」的替代**（§3.4、§5.2 第 4 条） | `backend/src/middleware/auth.js:262-279`（再导出 `:273-278`）；`backend/src/middleware/originGuard.js:22`、`:52-60`、`:88-94`、`:96-102`、`:104-111`；`routes/daemon.js:33`、`:38`；对照：shared 版导出面无此族（`shared/src/middleware/auth.js:221-227`） | 复验 |
| B13 | **两版 `authenticateToken` 的 401 响应体形状相同、且都不含 `error.code`**：只有 `{ success: false, message }`。`error.code` 只产生于 `utils/apiResponse.js:193-196` 的 `fail()`→`error()` 路径，或 `shared/src/errorEnvelope.js:223`（`classifyKhyError`）/`:234-235`（STATUS_TABLE 命中）/`:306`（`toEnvelope`）的 envelope 路径——`authenticateToken` 一处都不走 | `backend/src/middleware/auth.js:178-183`（无 token）、`:193-197`（catch）、`:145-172`（`sendAuthFailure` 各分支同为 `{success,message}`）；`shared/src/middleware/auth.js:123-128`；`utils/apiResponse.js:193-196`；`shared/src/errorEnvelope.js:223`、`:234-235`、`:306`；[DESIGN-ARCH-203]:302 原文只要求「401 而非 404」 | 复验 |
| B14 | **码值在四端不是同一张表**：后端/桌面取 service 叶子契约的 `error.code`（`errorEnvelope.js` 生成）、网页取镜像 `src/utils/classifyKhyError.mjs`（`:3-5` 自陈 MIRRORS，`:46`/`:47`/`:73` 映射）、手机各自 `switch`（`market_catalog.dart:601-606`、`settings_screen_new.dart:1516-1529`）、终端 formatter 直出无码表；`DATA-SSOT.json` 无 `errorEnvelope` / `classifyKhyError` / `STATUS_TABLE` 任何登记；镜像注释点名同步的 `apps/khy-mobile/src/utils/classifyKhyError.mjs` 实测不存在 | `classifyKhyError.mjs:3-5`、`:46`、`:47`、`:73`；`shared/src/errorEnvelope.js:75-83`、`:49`、`:104-106`；`market_catalog.dart:601-606`；`settings_screen_new.dart:1516-1529`；`notify.js:129`、`:156`；`node` 关键字检查 `DATA-SSOT.json` 三项全 `false`；fs 检查该 mjs 路径 ABSENT | 复验 |
| B15 | **写操作确认令牌闸门尚未登记**：`FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms` 共 **40 条**（全部 `stage=S1`），`agent-hub` / `agentHub` / `agent_hub` / `AGENT_HUB` / `确认令牌` 五关键字命中 **0**；[DESIGN-ARCH-203] §8 只是**登记建议**（`id=agent-hub-write-confirm-gate`、`stage: 'S1'`、`executorStage` 必填）；执行器 `planner.js` 不存在。另：40 条里 33 条带 `executorStage.file` + `constant`、7 条不带（`tool-challenge-cadence` / `domain-direction-guard` / `functional-unit-guard` / `entry-buffer-guard` / `q1-root-uncatalogued` / `q1-registry-path-dangling` / `q1-floor-closed-set`） | `node` 读 `docs/10_规范/registry/FEATURE-OWNERSHIP.json` → `count 40`、`stages {"S1":40}`、五关键字全 `false`、`executorStage` 覆盖 33/7；[DESIGN-ARCH-203]:502-525（`:508` id、`:513` stage、`:516-520` executorStage、`:527`）；`services/domain/agents/agentHub/` fs 检查 ABSENT | 复验 |
| B16 | **设备身份/配对的仓内既有实现与码（第 5 版新增）**：① `services/devicePairing.js` 是现成的加密设备身份与配对机制（Ed25519 / SHA256 指纹 / 角色 owner>admin>operator>viewer `:26-33` / scope `:37-50` / `PAIRING_STATE` 含 `REVOKED`·`EXPIRED` `:54-60` / `TOKEN_TTL_MS` 24h·`PAIRING_REQUEST_TTL_MS` 10min `:62-63`；API `getLocalIdentity` `:157`、`createPairingRequest` `:192`、`approvePairing` `:237`、`revokePairing` `:278`、`validateToken` `:301`、`hasScope` `:345`），消费者只有 `webRemoteControl/pairingCode.js`（`:19` 引入、`:58` 实例化）与 `webRemoteControl/protocol.js:77`（TTL 同源注释）——agentHub 与手机配对（`cli/handlers/mobile.js`）都不经过它；② `PAIRING_EXPIRED` 是在册错误码：`shared/src/errorEnvelope.js:47`（hint「配对码已过期…」）、`:139-140` MESSAGE_TABLE 正则映射、`backend/src/utils/khyError.js:53`、`khyErrorCategory.js:56`、网页镜像 `classifyKhyError.mjs:16`/`:109`；③ 配对有效期机制在场：`pairingCode.js:78-83` 按 `expiresAt` 清码、`:93` 签发写 `expiresAt`、`:106-108` 过期返回 `{ok:false, code:'SESSION_EXPIRED'}`；④ 手机端 `lib/` 对 `pairing_expired`/`PAIRING_EXPIRED`/`配对过期` **0 命中**（范围限定手机端，全仓非零）；⑤ [DESIGN-ARCH-192]、[DESIGN-ARCH-216]、[DESIGN-ARCH-216-附1] 三篇文档对 `devicePairing`/`DevicePairingManager`/`PAIRING_STATE`/`Ed25519` 关键字**各 0 次**，本文第 4 版及此前同样 0 次 | 本轮实跑 `git --no-pager grep -n "PAIRING_EXPIRED"` → 11 命中（含上述 5 处真源/镜像 + vendor 副本 + bundle）；`git --no-pager grep -n "配对过期"` → 1 命中（`phoneBridgeClient.js:1529` 注释）；`git --no-pager grep -n -i -E "pairing_expired\|PAIRING_EXPIRED\|配对过期" -- delivery/mobile/khy-os-client-app/lib` → 无输出；`git --no-pager grep -ln "devicePairing"` → 消费者仅 `services/devicePairing.js`、`webRemoteControl/pairingCode.js`、`webRemoteControl/protocol.js`（+文档/生成器）；实读 `devicePairing.js:1-70`、`pairingCode.js:50-112`、`errorEnvelope.js:44-50`/`:136-142`；三篇选型文档关键字计数 node 实测各 0 | 复验 |

### C. 网页

| # | 主张 | 证据 | 本轮核验 |
|---|---|---|---|
| C1 | `/admin/agents` child 路由存在；`/agents` redirect | `router/index.js:379-383`、`:103-104` | 复验 |
| C2 | NAV「管理控制台」组 15 项、`requiredRole: ROLE.ADMIN`、无 agents；头注释「单一真源，三处消费」；`visibleNavGroups` / `NAV_PATHS` / `navLabelFor` 行号 | `nav/index.js:1-9`、`:119-169`（requiredRole `:121`，items `:123-167`）、`:181-195`、`:198`、`:202-208` | 复验 |
| C3 | AIDashboard「查看全部」是 `/admin/agents` 唯一 UI 入口 | `views/admin/AIDashboard.vue:119` | 复验 |
| C4 | 该页数据源是后端进程内存 worker 层级 | `coordinator/workerAgent.js:1157-1163`（`_workers` / `_childrenOf`）；`routes/aiGatewayAdmin.js:749-762` 转引 | 复验（workerAgent）/转引（aiGatewayAdmin） |
| C5 | AIGateway CC-Switch「12 个 agent」模型卡 | `views/admin/AIGateway.vue:349-360` | 复验 |
| C6 | 本机 `delivery/web/ai-frontend/node_modules/vitest` 缺（`node_modules` 存在） | fs 存在性检查 | 复验 |
| C7 | `nav.wiring.test.js` 断言组：NAV 每组一份 `:126-131`、admin 页有真路由 `:151-180`、NAV 页可路由 `:182-185`、viewLoaders 键已登记 + 文件存在 `:232-261`（错误信息 `:258`）；**断言方向只有 NAV→route 与 router→viewLoaders→磁盘两组，无 route→NAV 反向断言**（第 4 版补，依据见 §6.5——漏 NAV 项测试全绿） | 行读取 | 复验 |
| C8 | viewLoaders 单一真源与 `/admin/agents` 键；`prefetchView` 未知键静默 return | `useRoutePrefetch.js:13-15`、`:64`、`:83-86` | 复验 |
| C9 | `/admin` 父路由、admin 守卫三段、`isAdminPath` / `stampAdminMeta`、traffic child、`documentTitleFor` / `DOCUMENT_TITLES` | `router/index.js:292-299`、`:374-378`、`:519-528`、`:542-548`、`:557-587`、`:604-621` | 复验 |
| C10 | 前端 axios baseURL 与 Bearer 链 | `src/api/request.js:12-15`、`src/api/authedFetch.js:21-27` | 复验 |
| C11 | EcoMarkets 约定：composable 只归一化不重算；`degraded` ref；`KhyPageHeader.vue` / `LoadErrorBanner.vue` 存在 | `useEcoMarkets.js:6-9`、`:52`；组件文件存在性 | 复验 |
| C12 | 空闲预热 `:99-118` | `useRoutePrefetch.js` 段 | 转引（未复验） |
| C13 | dev 代理名单 `DAEMON_ONLY_NAMESPACES` 实测 **13 项**、不含 `/api/agent-hub`；漏名单时 `/api` 兜底把请求转给 web 后端得到 404「接口不存在」；`/api/agent-hub` 按 [DESIGN-ARCH-203]:300-301 挂 daemon（`aiManagementServer`）。**评审与勘察材料记「11 项」，本轮实测为 13 项**（逐条见证据列）。**另：名单虽不受 `nav.wiring.test.js` 覆盖，但有 per-namespace 先例测试**——`EcoMarkets.wiring.test.js:141-153` 断言 `'/api/eco-markets'` 在名单内且 `/api` 兜底注册在其后；agent-hub 应照抄一条 | `delivery/web/ai-frontend/vite.config.js:38-60`（13 项：`:39`/`:40`/`:41`/`:42`/`:43`/`:44`/`:45`/`:46`/`:47`/`:48`/`:52`/`:56`/`:59`）、`:53-56`（eco-markets 404 注释先例）、`:57-59`（proxy-egress 同型）、`:82-86`（`test.include`）、`:143-146`（`/api` → `webBackendTarget`）、`:24`（`resolveWebBackendTarget()`）；`backendDiscovery.mjs:206-214`（web 后端不服务 daemon 路由自述）、`:224-235`（解析链）；`src/views/EcoMarkets.wiring.test.js:141-153`；[DESIGN-ARCH-203]:300-301 | 复验 |

### D. 桌面

| # | 主张 | 证据 | 本轮核验 |
|---|---|---|---|
| D1 | 四个 lazy 页 | `App.tsx:54-65`（`:54`/`:57`/`:60`/`:63`） | 复验 |
| D2 | 四个路由常量与 hash state | `App.tsx:368-379`（`:372`/`:377`/`:378`/`:379`） | 复验 |
| D3 | 四个渲染早退分支 + 主界面 return | `App.tsx:708`/`:722`/`:736`/`:750`、`:764` | 复验 |
| D4 | 快捷键守卫 + 第二处 settings 短路 | `App.tsx:469`、`:425-434`（`:427`） | 复验 |
| D5 | openSettings 写 hash 先例 | `App.tsx:488-491`（`:490`） | 复验 |
| D6 | host 文件头 CH-2 自述、`nodeRequire`、载 aiGateway | `src/host/index.ts:3-4`、`:68`、`:120-130` | 复验 |
| D7 | TitleBar：密钥管理已开独立窗口（先例失真）；四端互跳组；menuItems 全文区间 | `TitleBar.tsx:171-222`、`:176`、`:172-175`、`:136-137`、`:138-147`、`:204-208` | 复验 |
| D8 | `agentWriters.ts` 自述、4 级降级函数、留痕、两处 live 写腿 | `main/keyManager/agentWriters.ts:2`、`:33-55`（env `:36-37`）、`:57-62`、`:191-205`、`:207-225` | 复验 |
| D9 | keyManager IPC：`ipc.handle` 实测 25 处（`keys:list` 起 `:52`）；草稿记 26，差 1 按本轮复测收口 | `main/keyManager/ipc.ts:52`，全文计数 | 复验 |
| D10 | preload 单点暴露 `__KHYOS__` | `src/preload/index.ts:348`（文件 350 行） | 复验 |
| D11 | host 其余载入点 `:172/:208/:242/:273/:334`；TitleBar `:117` 声明 | 草稿记录 | 转引（未复验） |

### E. 手机

| # | 主张 | 证据 | 本轮核验 |
|---|---|---|---|
| E1 | Flutter/Dart 载体（无 Node） | `pubspec.yaml:1`、`:7`、`:10-11` | 复验 |
| E2 | `KhyOsConnection` 单端点 / 单令牌 | `khyos_api.dart:91-105`（`:104`、`:105`） | 复验 |
| E3 | JWT 链：login / refresh / Bearer 头 | `khyos_api.dart:192-213`、`:216-233`、`:261`、`:275`、`:303-304`、`:410-411` | 复验 |
| E4 | 配对载荷只含 `apiBaseUrl`；二维码打印；App 侧注释同判 | `cli/handlers/mobile.js:145-148`、`:216-249`（`:246`）；`market_catalog.dart:434-437` | 复验 |
| E5 | 手机 lib 无 admin **角色判定逻辑**；但**有 403 呈现面**（32 处命中，其中 `market_catalog.dart:605-606` 是 authenticateToken 命名空间的 403 文案「权限不足 (403)：当前账号无权$action。修复：换用管理员账号…」，其「换用管理员账号」引导与 §3.5 单人模型口径冲突，处置见 §8.4） | 全树检索 `isAdmin` / `ROLE_ADMIN` / `role == 'admin'` 零命中；`node` 递归扫描 `lib/` 222 文件，403 命中 32 处（`market_catalog.dart:605-606`、`settings_screen_new.dart:1520`、`chat_screen_new.dart:2849`、`arena_runner.dart:192-193` 等） | 复验 |
| E6 | pc-bridge 纯聊天流（E-A09）；「Bearer null、401 显示成连接失败」；配对载荷补 `authBaseUrl` 计划 | [DESIGN-ARCH-216]:59；[DESIGN-ARCH-192]:89、`:466` | 复验（文档行） |
| E7 | `GET /api/health` 校验与 `pairing.dart` 解析 | requirement-5q.md:163 转引 | 转引（未复验） |
| E8 | **手机并存两套导航真源、「智能体」一名三层含义**（第 3 版新增）：go_router（`ShellRoute` + 5 路由，`/agent` 是占位页）与 `main.dart` 的 `IndexedStack` 六页签是两套壳；「智能体」分别指 go_router 壳底部 tab「Agent」、主页签「技能」里的页内 tab「智能体」（内容为写死的 4 个借来智能体静态卡）、以及占位页 `AgentScreen` | `lib/core/router.dart:12-56`（`/agent` `:25-31`）；`lib/ui/screens/agent_screen.dart:5-42`（标题 `:12`、占位文案 `:32`）；`lib/main.dart:230-235`（六页签）、`:351-385`（`ToolsHubScreen` `:370`）、`:394-398`（`IndexedStack`）；`home_shell.dart:26-30`（tab「Agent」`:29`）；`tools_hub_screen.dart:88-93`（页内 tab `:92`）、`:502-533`（`_borrowedAgents` 4 项，`:500-501` 注释自述「4 个」） | 复验 |

### F. 终端

| # | 主张 | 证据 | 本轮核验 |
|---|---|---|---|
| F1 | `agent-assets` 注册表 6 家（khy-os / opencode / claude-code / harness / deepseek-harness / openclaw），字段只 id/label/module，能力由 `capabilities()`/`detect()` 自证 | `agentAssets/registry.js:4-9`、`:21-26`、`:27-34` | 复验 |
| F2 | commandSchema `'agent-assets'` 9 项、无 `hub` | `constants/commandSchema.js:641-651` | 复验 |
| F3 | handler 分派 if 链 / 未知子命令菜单 7 项 / manifest usage 与 subCommands 各 6 项 / `_printHelp` 家数推导 | `handlers/agentAssets.js:433-470`（`:437`/`:446`/`:449`/`:452`/`:455`/`:458`/`:461`/`:466`）、`:474-482`（`:478`/`:479`）、`:409-427`（`:410-411`） | 复验 |
| F4 | TUI 目录 211 个 `.js`、`agent-assets`/`agentAssets` 零命中；补全从 commandSchema 派生 | node 递归计数；`cli/tui/hooks/useCompletions.js:23`、`:32`、`:42`、`:75`、`:105` | 复验 |
| F5 | 棘轮四数计法与守卫强度：`checkSurfaceRatchet` 以 `error` 登记（`:668`），但 `STAGE='S1'`（`:69`）观察者档把 error 降级 warning、恒 exit 0（`:72`、`:771-775`）；本仓当前四项全部破基线（249/245 · 595/591 · 167/155 · 101/94） | `scripts/ci/check-delivery-baseline.js:615-648`（计数）、`:650-677`（判定，`:664` `measured > cfg.baseline`、`:666-673` 登记）、`:69`、`:72`、`:771-775`；本轮实跑 `node scripts/ci/check-delivery-baseline.js` → EXIT=0、`Summary: 0 error(s), 5 warning(s)`、`[TS GAP] routerCommands=249/245 · aliasEntries=595/591 · handlerFiles=167/155 · ruleCount=101/94` | 复验（第 0 版标「转引（未跑 check:delivery）」，本轮已实跑并按实测改写守卫强度） |
| F6 | **终端命令面三项现状**（第 3 版新增）：① 顶层 `khy agent` 是代理角色模板（`list`/`templates`/`run`/`spawn`）、面板 label「代理管理」，与 `agent-assets`「外部 agent 资产」是两族；`aliases.js:475-478` 的中文别名「智能体」已被 `agent` 占用。② `aliasEntries` 只数 `aliases.js` 的 `command:`（按文件文本），`agent-assets` 的 `agentassets`/`aassets` 声明在 handler manifest、由 `aliases.js:829-832` 运行时并入，不在 `aliases.js` 文本里。③ `handlers/agentAssets.js` 全文 `json`/`JSON` 0 命中、`printTable` 7 处，无任何机读通道 | `commandSchema.js:426`、`:1289-1292`、`:2148`；`routerDispatchOps.js:1466-1489`；实跑 `khy agent list` → 「代理角色模板」（EXIT=0）；`aliases.js:475-478`、`:829-832`（`commandAutoRegistry.getAliases()` 合并，注释「manifest 里给了 aliases 就不必在这里写」）；`check-delivery-baseline.js:625-630`；`handlers/agentAssets.js:475-477`；该文件检索计数 `json=0`/`JSON=0`/`printTable=7` | 复验 |

### G. 排除面与外部文档

| # | 主张 | 证据 | 本轮核验 |
|---|---|---|---|
| G1 | khyquant 是独立项目、「连接 Khy OS 使用」 | `AGENTS.md:106`；[DESIGN-ARCH-203]:548 | 复验 |
| G2 | provider-hub 自述与自带写腿 | `delivery/web/provider-hub/package.json:6`；`src/main/toolWriters.ts:112-122`（`:117`）；`src/main/providers.ts:74-98`（`atomicWriteJson`） | 复验 |
| G3 | [DESIGN-ARCH-203] 关键行：§2.1 `:15`、`:110-115`、`:119`；§3.2 `:189-195`；§3.3 `:217`；§3.4 `:230`；§4.3 `:302-304`；§4.4 `:306-330`；§5.2 `:385`；§6.1 `:411-417`；§6.2 `:423-428`；§6.3 `:465-470`；§9 `:540-570`（含 `:548`、`:552-553`） | 行读取 | 复验 |
| G4 | [DESIGN-ARCH-071] 关键行：`:15`/`:16`（CH-2/CH-3 前置）、`:28-29`（Q1）、`:34-35`（Q3）、`:37-39`（Q4）、`:53`/`:54`/`:55`（反模式与 `--json` 偏好） | 行读取 | 复验 |
| G5 | requirement-5q.md 关键行：`:148-153`（原话+拍板）、`:166-167`、`:171-182`（Q1 权限两层，含 `:176` 设备身份，第 1 版新增引用）、`:178`、`:182`、`:197-203`（四端触发）、`:206-214`（三要素）、`:217`、`:280`（仅数据/未安装形态）、`:290`（AI 拟定三值枚举，待契约决策员定稿）、`:330-340`、`:342-349`、`:351-364`（含 `:363` 跨设备令牌不通用）、`:368-371`、`:392-398`（含 `:396` 字段集合待定稿）、`:402-403`、`:405-411` | 行读取（全文 411 行） | 复验 |

### H. 实跑与未运行项

| # | 项 | 结果 | 本轮核验 |
|---|---|---|---|
| H1 | `node runtime/node/backend/bin/khy.js agent-assets discover` | 输出「已注册外部 agent 工具 6 家,合计资产 4 项」；khy-os / opencode / claude-code 已检测到（资产 0/1/3），harness / deepseek-harness / openclaw 未检测到并列出已查路径 | 实跑 |
| H2 | `node runtime/node/backend/bin/khy.js agent-assets hub` | 退出码 1，「未知子命令:hub。可用:discover / caps / list / plan / import / export / sync。」（第 3 版复跑，用 `spawnSync` 取 `status` 得 `EXIT=1`，stdout 原文同上） | 实跑（第 3 版复验） |
| H3 | **文档检查读数（第 3 版实跑三项 + 第 4 版按 `--list=<finding-id>` 逐条复核）**：`npm run check:doc-claims`（= `node scripts/ci/check-doc-claims.js`）EXIT=0，扫 364 份、端点主张 216 条、源码无实现 **33 条** warning；`npm run check:doc-drift`（= `node scripts/ci/check-doc-drift.js`）EXIT=0，扫 1033 份 md、范围内 364、todo 类缺路径 **109 处** warning；`npm run check:doc-numbers` EXIT=0，104 处「常量=数值」主张、可判定 55 处、不符 12 处（**12 条逐条列出且无一条属本文**；此项第 4 版未复跑）。三者均 S1 观察者、**恒 exit 0，输出是读数不是通过**。**`--list` 分两档，第 3 版把两档混为一谈（评审第 1 条）**：裸 `--list` 只出摘要（本轮实测只给聚合数）；**`--list=<finding-id>` 逐条打印「文档 -> 端点/路径」**。所以结论是**可判定的**，不是「不能断言」：① 本文**不在** doc-claims 的 33 条端点名单内——`node scripts/ci/check-doc-claims.js --list=endpoint-claim-unsupported` 本轮输出 33 行，按文件聚合 `[DESIGN-ARCH-192]`×20、`[DESIGN-ARCH-218]`×4、`[DESIGN-API-003]`×4、`[DESIGN-ARCH-009]`/`[DESIGN-ARCH-080]`/`[DESIGN-ARCH-154]`/`[DESIGN-OTHER-006]`/`[DESIGN-RL-001]` 各 1，合计 33，**含 217 或 agent-hub 的行数 = 0**；成因是本文头部 `DOCS-CLAIMS-EXEMPT` 使该文档**全部**端点主张免判（`scripts/ci/check-doc-claims.js:77` 原文「该文档的全部端点主张免判」、`:80` `EXEMPT_MARK`、`:194-196` 按文档判一次）。`node scripts/ci/check-doc-drift.js --list=impl-status-todo-but-missing` 本轮输出 **107 行**（同轮摘要口径仍报 109 处）；其中本文占 **1 条**：`[DESIGN-ARCH-217] 四端统一智能体管理面.md -> delivery/web/ai-frontend/src/views/admin/AgentHub.vue (todo)`——该路径确不存在（§12 A1），是 §6.4 第 4 行的正常规划路径，不是缺陷；107 与 109 的差额成因未查明（计数在 `check-doc-drift.js:271-273` 把非 done/superseded 一律记 todo，名单 `:330-334` 只收字面 `todo`）。逐条断言以 `--list` 为准，聚合数只作读数。仍未运行：`npx vitest run src/router/nav.wiring.test.js`（本机 `delivery/web/ai-frontend/node_modules/vitest` 缺，§12 C6）；`npm run check:delivery` 第 3/4 版均未复跑（读数沿用第 1 版，见 F5/H4） | 第 4 版实跑裸 `--list` 与 `--list=<id>` 两档（doc-claims / doc-drift）；doc-numbers、check:delivery 未复跑；vitest 未运行——未跑不计通过 | 部分复验 |
| H4 | `245 / 591 / 155 / 94` 是任务面棘轮的**基线**（阈值真源 `[DESIGN-DELIV-002]`，守卫 `:657` 读 `cfg.baseline`），**不是「棘轮读数」**；当前实测读数为 `249 / 595 / 167 / 101`，四项均已超基线，findings 以 warning 呈现、守卫 exit 0（S1）。[DESIGN-ARCH-203]:19 的「245/591/155」同为基线表述；其 §13.3 F21「verified」只核对计法（`:615`/`:625`/`:633`/`:641`、`:650-677`），不含「未破基线」的承诺 | 实跑 `node scripts/ci/check-delivery-baseline.js` 输出；`check-delivery-baseline.js:657`/`:664`、`:771-775`；[DESIGN-ARCH-203]:19、`:774`（F21 verified） | 复验（第 0 版把基线当读数并标「转引（未复跑）」，已订正） |

---

## 13. 修订记录

### 13.1 版本表

| 日期 | 版次 | 改动 | 执笔 |
|---|---|---|---|
| 2026-11-16 | 第 0 版 | 由上游材料首次整合成文：需求五问更新（四端口径）、扩面总裁决、后端契约四节（总扩面裁决 / 注册表端维度 / 终端面 / 安全边界扩面）、四端接线四节（网页 / 桌面 / 手机 / 终端）、不做清单、待拍板清单、事实主张清单。**本轮为整合轮，未做独立评审**（评审与修订在本工作流的后续轮次）。 | 整合员 |
| 2026-11-16 | 第 1 版 | 评审修订轮：处理评审意见 5 条（1 blocker + 4 major）。逐条处置与证据见 §13.5。要点：§3.4 鉴权「同为 JWT-only」按实测改写为符号级区分表（评审指认的 Path B 属 `flexibleAuth` 而非 `authenticateToken`，但含糊表述已收紧，`flexibleAuth` 明令禁挂）；§8.4 手机 403 呈现面不实断言改写为实测（32 处命中）并澄清与 §3.5 的文案口径冲突；§4.4 status 枚举「已定稿」降为「收口稿待确认」；§4.1/§12 F5/H3/H4 按 `check:delivery` 实跑结果改写守卫强度与棘轮读数（基线 vs 读数、四项已破基线）；§1.2/§1.5/§5.2/§11.3/§12 B10 登记设备身份执行面缺口与不可验收项。 | 修订执笔人 |
| 2026-11-16 | 第 2 版 | 第二轮评审修订：处理 major 5 条，逐条处置与证据见 §13.6。要点：§3.4 符号表补两行——**会话撤销 / tokenVersion 是两版 `authenticateToken` 的实质差异**（backend 查 AuthSession，shared 不查，requirement-5q.md:175 的「可撤销」在 shared 版下不成立）、`originGuard` / `requireLoopback` 族（`middleware/auth.js:273-278` 再导出）在册且禁用作设备校验；import 源裁决补语义理由；§1.2 / §5.2 第 5 条把「设备身份本期无执行面」订正为「会话级签发/标注/撤销链已在，缺设备↔origin 绑定与配对校验」；§0 第 3 条、§5.2 第 4 条、§11.3 第 1 条同步（originGuard.js:52-60 的 `null`/`file://` 裁决进决策输入）；§4.4 登记两值化代价与替代判定字段、三案并列；§6.2 / §6.8 第 2 条出处订正（后端 `requireAdmin` 非 5q:411 原文）并在 §11.3 增列第 6 条；§12 B8 改写、新增 B11（会话撤销链）与 B12（originGuard 族）。 | 修订执笔人 |
| 2026-11-16 | 第 3 版 | 第三轮评审修订：逐条处置 5 条意见（2 条为**事实错误**、3 条 major），逐条证据见 §13.7。要点：§1.5 / §6.6 的 401 验收改为「401 且非 404」并写明**响应体形状不成立**（新增 §12 B13）；§6.3 / §6.4 / §6.5 补 **dev 代理名单**这一处接线并写明「漏名单测试全绿而 dev 环境整体 404」（新增 §12 C13，实测 13 项而非评审所称 11 项）；§6.6 / §8.5 / §11.3 第 2 条把码值真源改为**逐端载体清单**并登记镜像同步义务（新增 §12 B14）；§2.2 / §2.4 / §3.3 手机行按实测订正「配对载荷下发 JWT」；§2.6 改写为「**尚未登记** + 四拦截面登记要求表」（新增 §12 B15）；§5.2 增第 6 条（跨设备确认令牌不通用）；§7.4 / §7.5 补入口三候选、确认 UX 形态与码表边界；§8.5 增收手机文案载体行与两套导航真相（新增 §12 E8）；§9.4 补终端命令面三项（新增 §12 F6）；§13.4 四行按可补性改写。 | 修订执笔人 |
| 2026-11-16 | 第 4 版 | 第四轮评审修订：逐条处理 13 条意见（3 blocker + 10 major），处置与证据见 §13.8。要点：§12 H3 / §13.4 把「`--list` 只有摘要」订正为「裸 `--list` 出摘要、`--list=<finding-id>` 出逐条名单」，并给出**可判定**结论（本文不在 doc-claims 33 条内、在 doc-drift todo 名单 1 条）；文档头免判括注删去 `[DESIGN-ARCH-203]`（它自带同款标记、贡献 0 条）；§10.2 把 203 的「5 条待拍板」订正为 4 条（第 1 条已被拍板二回答）；§1.5 / §6.5 / §7.4 把「写操作全部走 plan→confirmToken→apply」按 203 §6.1 分级拆开（W1 免令牌、W2/W3 一张确认卡、W3+ 第二级确认 + losses 摊开）；§6.5 守卫段按 `nav.wiring.test.js` 的单向断言改写（漏 NAV 不红），§6.8 增第 5 条；§2.3 / §5.3 / §11.2 第 6 条登记**终端 W2/W3 命令面缺口**；§6.6 增 404 专属文案条（镜像 404→`MODEL_NOT_FOUND` 会给错修复建议）；§8.5 / §1.5 / §8.3 补「逐设备凭据 / 按设备登出」缺口、配对过期标本期不可交付、PC 离线载体补到 Dio 分支；§4.4 登记「行粒度=实例 vs `id`=品牌」无可比单元与 203:385 无「工具数」列；新增 **§9.5 四端入口名称对照**与三处冲突，§11.2 增至 9 条、§1.7 同步。 | 修订执笔人 |
| 2026-11-16 | 第 5 版 | 第五轮评审修订：逐条处理 3 条意见（1 blocker + 2 major），处置与证据见 §13.9。要点：§1.5 / §8.5 把「配对过期＝全树 0 命中、今天没有过期这件事」订正为「**手机端 `lib/`** 范围 0 命中；全仓 `PAIRING_EXPIRED` 码在册（`errorEnvelope.js:47`、MESSAGE_TABLE `:139-140`、`khyError.js:53`、`classifyKhyError.mjs:16`/`:109`）、`pairingCode.js` 已有配对有效期实现（`expiresAt` → `SESSION_EXPIRED`，TTL 取 `devicePairing.PAIRING_REQUEST_TTL_MS`）」，「本期不可交付」的理由改为「手机配对载荷不携带过期语义」（新增 **§12 B16**）；§1.2 / §5.2 第 5 条 / §11.3 第 1 条补**第三块决策输入 `services/devicePairing.js`**（Ed25519 设备身份/指纹/角色/scope/配对生命周期，已被 `pairingCode.js` 与 `protocol.js` 消费；192 / 216 / 216-附1 三篇 0 提及），选型必须显式回答「复用还是另建」；§8.1 通道判定末句订正为「**手机并入既有 CH-4 这条路径，第三条路径由终端 CH-3 承担**」，消除与 §0 / §2.1 / §2.4 / §3.6「四端三条」的双读数。 | 修订执笔人 |

### 13.2 章节号映射（上游草稿 → 本文）

| 上游草稿原始编号 | 本文编号 | 说明 |
|---|---|---|
| 后端契约草稿 §14.1 总扩面裁决（四端 × 通道总表） | §2 | 两份草稿都从 §14.1 起编，本文按「总裁决在前」重排 |
| 后端契约草稿 §14.2 agentHub 注册表的端维度（14.2.1–14.2.7） | §3（3.1–3.7） | — |
| 后端契约草稿 §14.3 终端面（CLI/TUI）（14.3.1–14.3.4） | §4（4.1–4.4） | — |
| 后端契约草稿 §14.4 安全边界扩面 | §5 | 正文未送达，按已到达材料收拢（§13.4） |
| 四端接线草稿 §14.1 网页端 | §6 | — |
| 四端接线草稿 §14.2 桌面端 | §7 | — |
| 四端接线草稿 §14.3 手机端 | §8 | 落点文件表截断（§13.4） |
| 四端接线草稿 §14.4 终端面 | §9 | 正文未送达，按裁决原文与 §4 索引（§13.4） |
| 草稿内互引「见 14.4.3」 | 见 §5.3 | 已按本文编号改写 |

### 13.3 去重与收口说明

1. **九条注册表裁决**：§3 开头的映射表一行一裁决，细节落在对应小节；
2. **四条 surfaces 裁决**：§2.4 保留一行一裁决，理由全文由 §6–§9 各端章节承载；
3. **两条范围排除**：全文只出现在 §10 第 1、2 条；§2.5、§3.7 只留指针；
4. **requirement-5q.md 行号**：草稿原引的写入区间（:171-190 / :191-246 / :247-300 / :301-378 / :379-392）与实测略有出入，本文正文已按实测改写（Q1 :171-182、Q2 :184-217、Q3 :218-260、Q4 :262-373、Q5 :375-384）；
5. **订正两处草稿数值**：`keyManager/ipc.ts` 的 `ipc.handle` 计数 26→25（本轮复测）；`/api/eco-markets` pathname 分发 `:2393-2395`→`:2414`（本轮实测）。两处均为 minor 漂移，语义不变；
6. **`hub --json` status 枚举**：本文 §4.4 拟以 `installed` / `not-installed` 两值收口；requirement-5q.md:290 的 `installed` / `data-only` / `not-detected` 为在册 AI 拟定值，**该收口尚未由契约决策员定稿，确认前以 5q:290 三值为准**（第 0 版误写为「已定稿」，已订正）。两值化会让「仅数据」与「未检测到」塌成一档、5q:284 计数纪律与 :349 四端同源失去 status 承载位——§4.4 已登记该代价并把三案并列交契约决策员。

### 13.4 截断与待补清单（如实登记）

派发本轮整合任务时，两份草稿以 `JSON.stringify(...).slice(0, 12000)` 截断传入（工作流运行文件 `.zcode/workflow-runs/dwfrun-9dc2efab-0045-426e-807f-9039bdd761e7.mjs` 可证），以下四处未随任务到达。本文按「已到达材料收拢 + 明示截断」处理，**未杜撰任何内容**：

| # | 截断位置 | 本文现状（第 3 版复核） | 待补 / 可补性 |
|---|---|---|---|
| R0-1 | 后端契约草稿 §14.3.4 尾部（`checked[]` 按 ` 处截断） | §4.4：字段集合与 `checked[]` / `unregistered[]` 要点已按「§3 映射表第 8 条 + requirement-5q Q4（`:262-298`）」重建；第 3 版另增「实例行无 writable/capabilities 字段」一条 | **保持待补**。丢失的只是草稿自身字句，arrived 材料（5q / §2.4 / §4.2）无法还原原文，只能等草稿全文到达做措辞核对——语义内容已可证，不再有可增收项 |
| R0-2 | 后端契约草稿 §14.4 全节（仅有标题） | §5 按标题语义收拢已到达条目（§5.1 明示「未新增任何内容」已随之订正：第 3 版新增 §5.2 第 6 条，故该句改为「本轮新增 1 条，标 arrived 材料增收」） | **正文保持待补**。第 3 版可补 1 条：§5.2 第 6 条「跨设备确认令牌不通用」——依据 requirement-5q.md:363 原文，此前只在 §1.5 作验收项、§5 语义层缺载。其余不可补：§5.2 / §5.3 已是 §3.4 / §3.5 / §8.2 / §2.2 收拢的最大化重建，无法证明草稿 §14.4 不含超出标题语义的条目 |
| R0-3 | 四端接线草稿 §14.3 手机端落点文件表（首行 `lib/core/gateway/khyos…` 起截断） | §8.5：前三行按 arrived 材料可确证项，第 4、5 行为第 3 版按 arrived 材料**增收**（手机 403/降级文案载体、`classifyKhyError` 镜像登记），表头已写明「增收行不是草稿原文」 | 草稿表其余行**保持待补**。首行之后草稿究竟列了哪些文件仍未知；增收行不得冒充草稿原文，故表头口径必须保留。另「新页宿主的壳」也归此项：草稿原文如何定的落点未知，§8.5 已按 UI 实测给出冲突登记与择一要求 |
| R0-4 | 四端接线草稿 §14.4 终端面全节 | §9：§9.1 收录 §2.4 终端行裁决原文、§9.2 索引 §4.2 五处同步清单与 §4.3 TUI 判定、§9.3 索引 5q Q4.1（`:266-298`，含样表 `:275-282` 与计数纪律 `:284`）、§9.4 为第 3 版按 arrived 材料与 UI 实测补登的命令面现状三项 | **正文保持待补**。本轮无实质可补项：arrived 材料可推出的内容已 100% 装配，仅剩「草稿到达后核对原文」这一动作 |

> 另：`check:delivery` 已在第 1 版修订轮实跑（见 §12 F5/H4）；第 3 版修订轮另实跑 `check:doc-claims` / `check:doc-drift` / `check:doc-numbers` 三项，结果与口径见 §13.7 与 §12 H3。**已运行不等于通过**：这三个是 S1 观察者（恒 exit 0），其输出只作读数，本文件头 `DOCS-CLAIMS-EXEMPT` 只声明 `/api/agent-hub` 全族端点为目标态，不豁免其他事实主张。
>
> **第 4 版改正一处口径（评审第 1 条）**：第 3 版曾写「`--list` 模式输出只有摘要，故不能据聚合数断言本文不在其中」——该说法低估了工具：裸 `--list` 只出摘要，`--list=<finding-id>` 逐条打印「文档 -> 端点/路径」。第 4 版实跑两档后的**可判定**结论与逐条证据见 §12 H3：本文**不在** doc-claims 的 33 条端点名单内（头部 `DOCS-CLAIMS-EXEMPT` 使全部端点主张免判），**在** doc-drift 的 todo 缺路径名单内 **1 条**（目标路径是网页端尚未创建的 `views/admin/AgentHub.vue`，属正常规划路径）。

### 13.5 评审意见处置记录（第 1 版，逐条）

> 每条给出：评审指认 → 实测复核 → 处置。**评审的事实前提凡与实测不符者，按实测改写并在此如实登记，不按错误前提改文。**

| # | 等级 | 评审指认（摘要） | 实测复核（本会话执行） | 处置 |
|---|---|---|---|---|
| 1 | blocker | §3.4「两套实现同为 JWT-only、都无回环/X-API-Key 旁路」错误：认为 ecoMarkets 样板经 `khy-ai-backend/middleware/auth` 拿到的是带 X-API-Key Path B 的 shared 版 `authMiddleware`，因此照样板挂载即引入 X-API-Key，与 §5.2 第 4 条/§8.2 冲突 | **评审的核心机制断言不成立**：shared `auth.js` 的 Path B 在 `:192-211`，但它在 **`flexibleAuth`（:169-215）** 函数体内；`authenticateToken = authMiddleware`（`:218`），`authMiddleware`（`:119-155`）只取 Bearer + `jwt.verify`（`:130`），无 X-API-Key。ecoMarkets 只解构 `authenticateToken`（`aiManagementServer.js:385-386`），全文 `flexibleAuth` 零挂载（`:326`/`:346`/`:429`/`:446`）。backend 本地版同构（`auth.js:175-199` JWT-only、`:217-260` flexibleAuth 带 X-API-Key、`:271` 别名）。**故「照 ecoMarkets 样板挂载拿到 X-API-Key」在实测上不成立**；但评审指出的「等价断言含糊」成立——原句未区分 `authenticateToken` 与同模块 `flexibleAuth`，确有被误读为「整个 auth 模块 JWT-only」的空间 | ①§3.4 改写为符号级区分表（两套实现的 `authenticateToken` 与 `flexibleAuth` 逐行给证据），保留「两套 `authenticateToken` 同为 JWT-only」的实测事实，并明写「照 ecoMarkets 样板 = 照挂载形状，import 用后端本地版、解构名禁取 `flexibleAuth`」；②§0 第 3 条、§6.2、§6.4 第 5 行、§8.2 第 2 条同步收紧措辞；③§12 B3、B8 补 `flexibleAuth` Path B 证据与「零挂载」实测 |
| 2 | major | §8.4「手机端没有 403 呈现面」不实：手机 lib 有 32 处 403，`market_catalog.dart:605-606` 即 authenticateToken 命名空间的 403 文案；E5「无 admin 角色判定」成立但结论需改写；既有文案「换用管理员账号」与 §3.5 单人口径冲突 | **成立**：`node` 递归扫 `lib/` 222 文件，403 命中 32 处，`market_catalog.dart:605-606` 的 `case 403` 文案与注释 `:587-588` 指向 `/api/eco-markets`、`/api/skills/install`；`isAdmin`/`ROLE_ADMIN`/`role == 'admin'` 0 命中 | §8.4 改写为「有 403 文案、无角色判定逻辑」，列出 4 处代表性命中；新增口径冲突澄清（市场页文案引导「换用管理员账号」在单人模型下不可兑现，agent-hub 不得沿用，码值归 §11.3 第 2 条）；§12 E5 主张与证据同步改写 |
| 3 | major | §4.4「字段集合定稿」「契约决策员定稿」把待拍板写成定案；5q:290/:396 均为「AI 拟定，待契约决策员定稿」；与 §11.2 第 3 条互斥 | **成立**：5q:290 原文「必需字段（AI 拟定，待契约决策员定稿）…`status`（installed / data-only / not-detected）」、:396 同；全仓 `not-installed` 8 处命中全为无关代码、`data-only` 12 处无一处属本功能；`works/data/khy/feedback/agent-hub/` 仅 `impl-plan.md` + `requirement-5q.md`，无定稿记录 | §4.4 标题与订正条降为「收口稿，待契约决策员确认」并明写「确认前 5q:290 三值为在册唯一版本」；§3 映射表第 8 条、§11.2 第 3 条、§13.3 第 6 条同步改写 |
| 4 | major | §4.1「超基线即 error」与守卫现状不符；§12 H4 把 245/591/155 当「棘轮读数」；实测四数 249/595/167/101 已全部破基线 | **成立**：实跑 `node scripts/ci/check-delivery-baseline.js`（= `npm run check:delivery`）→ EXIT=0、`Summary: 0 error(s), 5 warning(s)`、`[TS GAP] routerCommands=249/245 · aliasEntries=595/591 · handlerFiles=167/155 · ruleCount=101/94`；代码 `:668` 登记 error、`:69` STAGE='S1'、`:72` OBSERVER_STAGES、`:771-775` 非 strict 时 error→warning | §4.1 改写为「登记 error、S1 观察档降级 WARN 不阻断」，附实跑读数并说明破口非本功能造成、加子命令不动四数（`aliasEntries` 例外说明）；§12 F5 由「转引」改「复验」、H3/H4 同步订正（基线 vs 读数） |
| 5 | major | §1.2/§1.5 把「设备身份」写进口径与验收，但本期契约无执行面（`authenticateToken` 无设备绑定、配对载荷不发令牌），也未标注依赖未定选型、本期不可验收 | **成立**：`authSessionService.js:307-370` 只校签名/tokenType/userId/status/session 有效期/吊销/tokenVersion，无设备或 origin 绑定；`cli/handlers/mobile.js:145-148` 只返回 `{ apiBaseUrl }`；选型在 §11.3 第 1 条 | §1.2 追加「执行面缺口」标注；§1.5 手机验收的「A 令牌对 B 下发必须拒绝」标「本期不可验收」；§5.2 新增第 5 条缺口登记；§11.3 第 1 条注明其决定执行面是否存在；§12 新增 B10 事实主张与证据 |

> 遗留与边界：本条修订只改 `[DESIGN-ARCH-217]` 一篇；§3.4 的符号级澄清与 [DESIGN-ARCH-203]:316「超基线即 error」的表述差异未回改 203（不在本任务授权范围），若需统一以本文为准并在 203 落订正记录。评审第 1 条要求「删掉『同为 JWT-only』这句」未执行——该句对 `authenticateToken` 为真，按实测保留并收紧了适用对象；如评审方认为仍需删除，请给出 Path B 属 `authenticateToken` 的反证。

### 13.6 第二轮评审意见处置记录（第 2 版，逐条）

| # | 等级 | 评审指认（摘要） | 实测复核（本会话执行） | 处置 |
|---|---|---|---|---|
| 1 | major | §3.4 符号表只分了 X-API-Key 一族，漏掉两版 `authenticateToken` 的实质差异——**会话撤销**；shared 版不查 AuthSession，req-5q:175「可撤销的凭据」在其下不成立；import 源裁决的理由只写了「同包」，§12 B8 未登记该维度；203 §4.3 原文未指定 import 源，实施者会顺同文件惯例解构 shared 版 | **成立**：shared `auth.js:119-155` 只做 Bearer(:121)→`jwt.verify`(:130)→`User.findByPk`(:131)→status(:140)，**不查 AuthSession**；backend `auth.js:186` → `authenticateAccessToken` → 会话存在/吊销/过期（`authSessionService.js:358-370`）+ `tokenVersion`（`:372-382`），撤销面 `:399-415`/`:417-437` 在册；`aiManagementServer.js` 全部 5 处解构（`:325`/`:345`/`:385`/`:428`/`:445`）都走 `khy-ai-backend/middleware/auth`→shared；203 §4.3 `:300` 确只写「+ `authenticateToken` +」，未指定 import 源 | §3.4 符号表新增「会话撤销 / tokenVersion」行（两版逐格给证据），import 源裁决补语义理由（「可撤销」只有 backend 版成立），并写明现状 5 处解构全走 shared 是既有事实；§1.2「可撤销凭据」挂钩 import 源；§12 B8 改写并新增 B11 |
| 2 | major | §1.2/§5.2 第 5 条/§12 B10 把「设备身份」整层判为「没有执行面」，与自身证据冲突——会话级签发/标注/撤销链已在（`issueSessionForUser` 写 deviceLabel/tokenVersion/ip/UA，`authenticateAccessToken` 按会话拒绝，撤销与清单在册），缺的是设备↔origin 绑定与配对校验 | **成立**：`issueSessionForUser` `:265-305`（`:275` tokenVersion、`:278-284` ip/UA/deviceLabel）、`detectDeviceLabel` `:90-128`、`serializeSession` `:131-154`、按会话拒绝 `:358-382`、`revokeSessionById` `:399-415`、`revokeUserSessions` `:417-437`、`listUserSessions` `:513` | §1.2 拆成「会话语义已在 / 缺的是设备↔origin 绑定与配对校验」两截；§5.2 第 5 条改写并注明粒度=登录会话、deviceLabel 由 UA 派生非注册设备身份；§12 B10 改写、新增 B11；§11.3 第 1 条把「已在的会话链」列为选型既有输入，不再当作从零开始 |
| 3 | major | 凑数禁令清单不完整：backend `middleware/auth.js:262-279` 还再导出 `requireLoopback` / `originGuard` 族（实现 `originGuard.js:88-94`/`:96-102`），文档 0 处提及；若有人挂 `requireLoopback` 兑「未配对拒绝」，手机（LAN/公网）与外网网页会被 403 全量挡死；`originGuard.js:52-60` 的 `null`/`file://` 既有裁决是 §11.3 选型的既有约束，未进决策输入 | **成立**：`auth.js:273-278` 再导出 6 个符号；`originGuard.js:22`（`KHY_ALLOWED_ORIGINS`）、`:52-60`（`null`/`file://` 放行，Electron loadFile）、`:88-94`（403「仅允许本机访问」）、`:96-102`（403「请求来源不被允许」）；现有消费者 `routes/daemon.js:33`/`:38`；对本文件实跑 `git grep originGuard\|requireLoopback\|KHY_ALLOWED_ORIGINS\|isTrustedBrowserOrigin` → **0 命中** | §3.4 符号表新增「`originGuard` / `requireLoopback` 族」行并写明 shared 版无此族；§0 第 3 条、§1.2 凑数禁令、§5.2 第 4 条扩列（禁用作「设备校验」）；§11.3 第 1 条把 `originGuard.js:52-60` 列为选型既有约束；§12 新增 B12 |
| 4 | major | §4.4 两值方案与在册验收表冲突未登记：5q:272/:280/:281 的状态列实为三档（仅数据 vs 未检测到），:284 计数纪律与 :349 四端同源「状态不同即失败」都以状态列判定；收成两值后两类塌成一档、失去承载位，文档也没写同源比对以哪个字段为准 | **成立**：5q:272「未安装的显式标注『未检测到』并列出检查过的路径」、:280 `command-code 仅数据 / 未安装`、:281 `kiro 未检测到`、:284「未安装行不得显示 0 冒充『已检查且为空』」、:349「一端少一行、状态不同、数字不同都算失败」 | §4.4 新增「两值化的代价与替代判定字段」条：登记三档塌缩代价、给出组合键替代方案（`notes` 形态 + `checked[]` 非空 + `assets.*` 非 0，四端同规则），并把「两值 / 两值+组合键 / 三值」三案并列交契约决策员；§1.5 四端同源校验条挂钩比对字段；§11.2 第 3 条、§13.3 第 6 条同步 |
| 5 | major | §6.2/§6.8 第 2 条把「后端要不要叠 `requireAdmin`」挂在 requirement-5q.md:411 名下，但 5q:411 只裁前端落点与角色门；后果是该本文自认最重的安全语义没进 §11.3 待裁总表 | **成立**：5q:411 原文只有「网页『智能体』页的落点与角色门：若挂 `/admin`，owner 账号须具备 ADMIN…；是否改为顶层入口由设计定」，无后端守卫；`adminMiddleware` 在册且导出（`backend/src/middleware/auth.js:201-215`、`:272`）；`ecoMarkets`/`proxy-subscriptions` 单层（`aiManagementServer.js:386`/`:326`），`gui-eval`/`web-frontend-eval` 双层（`:429-430`/`:445-447`），`/api/wx` 条件双层（`:346-349`） | §6.2 与 §6.8 第 2 条出处改标「本文新增委托项（5q:411 不含）」；§11.3 标题改「6 条」并新增第 6 条（列双侧先例、明写现状语义「任何 active 用户 JWT 可全档写」） |

> 边界：本轮仍只改 `[DESIGN-ARCH-217]`。[DESIGN-ARCH-203] §4.3 `:300` 未指定 `authenticateToken` 的 import 源，与本文 §3.4 的符号级裁决存在落笔差异——按授权不回改 203，203 的实施者若照同文件惯例解构 shared 版，会拿到「不校验会话吊销」的那一份；建议后续在 203 落一条指向本文 §3.4 的订正记录。

### 13.7 第三轮评审意见处置记录（第 3 版，逐条）

> 每条给出：评审指认 → 实测/修改（本会话执行）→ 落点。**评审事实前提与实测不符处按实测改写并登记**（第 1 条即一例：评审与勘察材料记「11 项」，实测 13 项）。

| # | 等级 | 评审指认（摘要） | 实测 / 修改（本会话执行） | 落点 |
|---|---|---|---|---|
| 1 | blocker | §6.4 只列 4 处 UI 接线 + 后端挂载，全表**没有 dev 代理命名空间**；`DAEMON_ONLY_NAMESPACES` 不含 `/api/agent-hub`，漏它会被 `/api` 兜底转给 web 后端得到 404；§6.5 却称「四处接线漏任何一处该测试会红」，而 `nav.wiring.test.js` 锁不住 vite 名单 | **成立**。实测 `vite.config.js:38-60` 名单**13 项**（评审记 11，逐条核为 `:39`/`:40`/`:41`/`:42`/`:43`/`:44`/`:45`/`:46`/`:47`/`:48`/`:52`/`:56`/`:59`），无 `/api/agent-hub`；`/api` 兜底 `:143-146` → `webBackendTarget`（`:24`）；`backendDiscovery.mjs:206-214` 自陈 web 后端不服务 daemon 路由、解析链 `:224-235`；`vite.config.js:53-56`、`:57-59` 的 404「接口不存在」注释先例在场。**自查订正**：本条初稿写「名单没有任何测试断言」，实测**为假**——`src/views/EcoMarkets.wiring.test.js:141-153` 正是 per-namespace 断言（含 `/api/eco-markets` 且兜底在其后），已按实测改为「照抄该先例」 | §6.4 增第 6 行（vite 名单 + 同款测试）；§6.5 改写为「四处 UI 接线 + dev 代理名单一处」、写明「漏名单 → `nav.wiring.test.js` 全绿而 dev 整体 404」并给出 `EcoMarkets.wiring.test.js:141-153` 先例（含 `test.include` 与 vitest 缺依赖的边界）；§6.3 改「四处 UI 接线 + dev 代理名单今天全缺」；§4.1 别名计法限定指向 §9.4；§12 新增 **C13** |
| 2 | blocker | §1.5 网页验收要求「401 且响应体 `error.code = AUTH_REQUIRED`」实测不成立——两版 `authenticateToken` 的 401 只回 `{success,message}`；`error.code` 只在 `fail()`/envelope 路径产生；ARCH-203:302 只要求「401 而非 404」；§6.6 的措辞会让实施者断言不存在字段 | **成立**。实测 `backend/src/middleware/auth.js:178-183`、`:193-197`，`sendAuthFailure` `:145-172`，`shared/src/middleware/auth.js:123-128` 全为 `{success,message}`；`apiResponse.js:193-196`（`fail`→`error`）、`shared/src/errorEnvelope.js:223`/`:234-235`/`:306` 才有 `error.code`；[DESIGN-ARCH-203]:302 原文「守卫测『401 而非 404』」无 body 要求。**采方案①**（改验收为「401 且非 404」、显式写明不断言响应体形状、理由句直接给上述证据），不采方案②（不新增 envelope 委托项）——理由：ARCH-203:302 的原义就是状态码，把 401 体改成 envelope 是跨命名空间契约变更，无用户可见收益 | §1.5 网页验收行改写（含 6 处代码证据）；§6.6 两条改写（码值由本端镜像归类、AUTH_REQUIRED 是显示层归类码非后端字段）+ 显示出口 `notify.js:129`、`:156`；§12 新增 **B13** |
| 3 | major | §6.6 把码值真源写成 shared `errorEnvelope.js`，但网页不能 import shared（ARCH-071:53）；§8.5 / §11.3 第 2 条称「四端文案一致」却未拆载体；手机端根本不消费共享表；镜像属 LAYOUT-008 影子副本且未在 DATA-SSOT 登记 | **成立**。`classifyKhyError.mjs:3-5` 自陈 MIRRORS、`:46`/`:47` 401/403、`:73` ECONNREFUSED；手机 `market_catalog.dart:601-606`（`case 401` `:602-604`、`case 403` `:605-606`）、`settings_screen_new.dart:1516-1529`（评审区间 `:1516-1525` 略窄，`_describeHttpStatus` 实到 `:1529`）；`DATA-SSOT.json` 三关键字全 false；**加测**：镜像注释点名同步的 `apps/khy-mobile/src/utils/classifyKhyError.mjs` 实测 ABSENT（手机已迁 Flutter）——即注释式同步已失效 | §6.6 改写；§8.5 增「逐端载体」表 + 第 5 增收行；§11.3 第 2 条补交付义务（四端载体同改 + DATA-SSOT 登记 + 可执行同步校验）；§7.4 / §7.5 补码表边界；§12 新增 **B14** |
| 4 | major | §3.3 与 §2.4 手机行写「配对载荷下发可达 origin + owner Bearer JWT」，与 §5.2 第 2 条 / §8.3 订正冲突——实测配对载荷只含 `{apiBaseUrl}`，JWT 来自登录 | **成立**。`buildPairingPayload`（`mobile.js:145-148`）返回 `JSON.stringify({ apiBaseUrl })`；`pairing.dart:68-71` 的 `token` 字段注释自陈「current producer does not emit one」；`khyos_api.dart:192-213` login（`:203-209` 落 accessToken） | §3.3 手机行改写（含两处代码证据）；§2.4 手机行改写并挂钩 §8.3 订正记录；§2.2 手机行鉴权格补「由登录获得」（绝歧义）；§1.2 / §1.3 / §2.3 / §5.2 / §8.2 复核后无该措辞，未改 |
| 5 | major | §2.6 把「未登记」写成「仍为 S1 观察者档」；`FEATURE-OWNERSHIP.json` 实测无 agent-hub 条目；执行器 `planner.js` 不存在；四端扩面新增/依赖四个拦截面而 §2.6 一字未提，§12 无对应主张 | **成立**。`node` 读 registry：`rollout.mechanisms` 共 **40 条**、`stages {"S1":40}`、`agent-hub`/`agentHub`/`agent_hub`/`AGENT_HUB`/`确认令牌` 全 false；`executorStage` 覆盖 33/7（与 ARCH-203:527 一致）；`services/domain/agents/agentHub/` ABSENT；`check-rollout-stage.js:485-527` 的漂移校验入口条件是 `:486` 的 `auth && auth.file && auth.constant` | §2.6 全文改写（事实订正 + **四拦截面登记要求表** a–d + 统一登记要求 + 三条硬红线）；§6.8 第 2 条、§11.3 第 6 条各加指针；§12 新增 **B15** |

**本轮可补的截断项（逐条，均标「arrived 材料增收」）**：

| 截断项 | 本轮补了什么 | 依据 | 仍待补 |
|---|---|---|---|
| R0-2（§5） | §5.2 第 6 条「跨设备确认令牌不通用」 | requirement-5q.md:363 原文 | 草稿 §14.4 其余正文 |
| R0-3（§8.5） | 增收第 4 行（手机 403/降级文案载体）、第 5 行（`classifyKhyError` 镜像登记）；补「两套导航真源」「一名三层」「既有防呆态」三段 | 本文 §8.4 / §12 E5、E8；`market_catalog.dart:589-606`、`settings_screen_new.dart:1516-1529`、`pairing.dart:119-142`、`main.dart:230-235`、`router.dart:12-56` | 草稿落点表其余行 |
| R0-1（§4.4） | 无新增语义，仅增「实例行无 writable/capabilities 字段」一条（与 §6.8 第 4 条的要求不自洽） | 本文 §4.4 字段集合 vs §6.8 第 4 条；`handlers/agentAssets.js:169` 的 caps 读写列 | 草稿原文字句 |
| R0-4（§9） | §9.4 命令面现状三项（命名空间 / 别名计法 / `--json` 现状）；正文仍以索引替代 | `commandSchema.js:426`/`:1289-1292`/`:2148`、`routerDispatchOps.js:1466-1489`、`aliases.js:475-478`、`check-delivery-baseline.js:625-630`、`agentAssets.js:475-477` 与全文检索计数 | 草稿 §14.4 正文 |

**本轮未做的事（如实登记）**：

1. **未改 [DESIGN-ARCH-203]**：本轮授权只改本篇。评审第 1 条涉及的 203 §4.3 `:300`（import 源未指定）与第 2 条涉及的 203 §4.2 也照此处理，建议后续在 203 落指向本文 §3.4 / §1.5 的订正记录。
2. **未运行 `npx vitest run src/router/nav.wiring.test.js`**：本机 `delivery/web/ai-frontend/node_modules/vitest` 实测缺（§12 C6）——**不计通过**。
3. **未复跑 `npm run check:delivery`**：读数沿用第 1 版（§12 F5/H4）；本轮已实跑 `check:doc-claims` / `check:doc-drift` / `check:doc-numbers` 三项（EXIT=0，S1 观察者，读数见 §12 H3），**三者恒 exit 0，输出不算通过**。
4. **未代裁 §11 的待裁项**（用户保留待拍板 2 条 + AI 自答待确认 5 条 = 7 条，另有委托契约决策员 6 条同样未定）：本轮只登记依赖关系与用户可见后果（如 §3.3 网页行的「非 ADMIN 侧栏整组不可见」、§8.5 的设备列表依赖标注），不替用户或契约决策员定案。
5. **未编造 §5 / §8.5 / §9 的草稿原文**：可补项全部标「arrived 材料增收」，不可补项保留「待补」并写明可补性（§13.4）。

### 13.8 第四轮评审意见处置记录（第 4 版，逐条）

> 每条给出：评审指认 → 实测复核（第 4 版会话执行）→ 落点。**13 条全部成立并已修**；其中第 1 条同时是「第 3 版把可判定结论写成不可判定」的自纠。评审指认中的行号指**第 3 版**的行位，修订后行号已漂移，以「落点」列的章节号为准。

| # | 等级 | 评审指认（摘要） | 实测复核（本会话执行） | 落点 |
|---|---|---|---|---|
| 1 | blocker | §12 H3 / §13.4 写「`--list` 只出摘要、故不能断言本文不在其中」——低估工具能力，且把一个可判定结论写成不可判定 | **成立**。实跑 `node scripts/ci/check-doc-claims.js --list=endpoint-claim-unsupported` → **33 行**，按文件聚合 `[DESIGN-ARCH-192]`×20、`[DESIGN-ARCH-218]`×4、`[DESIGN-API-003]`×4、`009`/`080`/`154`/`OTHER-006`/`RL-001` 各 1，**含 217 或 agent-hub 的行数 = 0**；实跑 `node scripts/ci/check-doc-drift.js --list=impl-status-todo-but-missing` → **107 行**，含本文 **1 条** `-> delivery/web/ai-frontend/src/views/admin/AgentHub.vue (todo)`；实跑裸 `--list` → 只出 6 行摘要。免判机制：`check-doc-claims.js:77`「该文档的全部端点主张免判」、`:80` `EXEMPT_MARK`、`:194-196` 按文档判一次；本文标记在 `:3`。**附带发现**：`--list` 107 行 vs 摘要 109 处，差 2 条成因未查明（`:271-273` 的 `else` 计入 vs `:330-334` 只收字面 `todo`） | §12 H3 全行重写（含命令、聚合数、两数差异登记）；§13.4 顶注新增「第 4 版改正一处口径」段 |
| 2 | major | 文档头把 `[DESIGN-ARCH-203]` 说成同类「存量」，但 203 自带同款免判标记、在 33 条名单里贡献 0 条 | **成立**。`--list` 聚合中 `[DESIGN-ARCH-203]` = **0 行**；`[DESIGN-ARCH-203] 智能体统一管理.md:3` 的括注只列 `[DESIGN-ARCH-192]` | 文档头 `:3` 括注改写（只留 192，并写明 203 自带标记、贡献 0） |
| 3 | major | §10.2「5 条待拍板全部继续有效」与已答事实冲突——203:565 的第 1 条正是「Q1 谁用 / 要不要团队·多机」 | **成立**。`[DESIGN-ARCH-203]:565` = 「Q1『谁用』：是否只限本机 owner 单人单机？要不要团队/多机视图？」；5q:152-153 / :171-182 = 单人多机、没有团队（已拍板）；203 §9 不做 16 条 `:544-559`、待拍板 5 条 `:561-569`（逐条数过为 5） | §10.2 改写：4 条继续有效 + 第 1 条已答（附 203:565 与 5q 证据），并点明与 §1.7 的自相矛盾 |
| 4 | major | §1.5 网页验收「401 且非 404」没写打哪个 origin，与 §6.5 登记的「dev 漏名单得 404」会互相打脸 | **成立**。`vite.config.js:38-60` 名单 13 项、无 `/api/agent-hub`；`:143-146` `/api` → `webBackendTarget`（`:24`）；[DESIGN-ARCH-203]:300-302 的落点是 `aiManagementServer` + `__test__.getAgentHubApp` 进程内守卫测（不经 vite） | §1.5 网页行补「打哪个 origin」段：daemon origin / 203:302 进程内守卫，dev 端口 curl 以 §6.4 第 6 行落地为前提 |
| 5 | blocker | §6.5「写操作全部走 POST plan → confirmToken → apply」把 W1 也说成必带令牌；§7.4 把确认交互钉死成一张卡 + 两个动作，四端无 W3+ 第二级确认与 losses 摊开载体 | **成立**。[DESIGN-ARCH-203]:414「W1…不需要额外确认令牌」、`:417`「W3+…单独的更高一级确认 + losses 清单摊开」、`:458` 同；在 217 全文计数「更高一级」「摊开」「逐项列明」各 **0 命中**（node 实测） | §1.5 手机行（写操作按档位）、§6.5 页面形态（三档三形态 + W3+ 独立载体）、§7.4 确认 UX（W1 不弹卡 / W2·W3 一张卡 / W3+ 第二级确认并摊开 losses） |
| 6 | blocker | §6.5「这四处 UI 接线漏任何一处该测试会红」不成立——`nav.wiring.test.js` 只有 NAV→route 与 router→viewLoaders→磁盘两组方向，无 route→NAV | **成立**。实读该测试：`:126-131` 只查 NAV 内部；`:151-159`/`:182-185` 是 NAV→route；`:232-261` 是 router→viewLoaders→文件；`:171-179` 是写死 detail 抽查。仓内 `/admin/agents` 即活样本（route `router/index.js:379-383`、viewLoader `useRoutePrefetch.js:64`、文件 `AgentDashboard.vue`、NAV 15 项无它 `nav/index.js:119-169`）。**未跑 vitest**（`node_modules/vitest` 缺，§12 C6），结论来自逐区间实读而非测试执行 | §6.5 守卫段重写（逐方向说明 + 活样本 + 补断言须排除 redirect/legacy/detail）；§6.8 新增第 5 条（本文新增委托项，不代裁） |
| 7 | major | 拍板① 要求四端都能装卸/改模型，但终端写腿只有 `agent-assets import/export/sync`（W1）；W2/W3 无命令落点且未登记 | **成立**。`commandSchema.js:641-651` 9 项无 hub/模型/装卸动词；`handlers/agentAssets.js:446-463` 分派只有 discover/caps/list/plan/import/export/sync/help；实跑 `node runtime/node/backend/bin/khy.js agent-assets hub` → 「未知子命令:hub。可用:discover / caps / list / plan / import / export / sync。」；`--apply` 帮助 `:420-425` 只覆盖 W1 | §2.3 终端行补「今天只有 W1」；§5.3 第 2 条限定 `--apply` 的证据力；§11.2 新增第 6 条（补命令面 or 标 W1 可写，请用户确认） |
| 8 | major | 网页 404 有语义要求却无文案载体；§6.6 只登记四条；镜像把 404 归成 `MODEL_NOT_FOUND`，给出与成因无关的修复建议；手机 404 先例未被引用 | **成立**。`classifyKhyError.mjs:48` 404→`MODEL_NOT_FOUND`、`:23` hint「模型标识拼错或已下架」；`shared/src/errorEnvelope.js:79` 同；手机 `market_catalog.dart:607-612` 有「接口不存在 (404)：后端没有 $endpoint」现成先例 | §6.6 新增 404 条（按 404 直判、给专属文案、禁沿用镜像归类、码归属 §11.3 第 2 条）；§8.5 行 4 与载体表补到 `:607-612` |
| 9 | major | §1.5:79 把「配对过期」「PC 离线」列为有明确降级文案，§8.5 却无载体；配对今天没有「过期」这件事却未标注 | **成立**。`git --no-pager grep -n -i -E "pairing_expired\|PAIRING_EXPIRED\|配对过期" -- delivery/mobile/khy-os-client-app/lib` → **0 命中**；`mobile.js:145-148` 只发 `{apiBaseUrl}`；`pairing.dart:144` 只回 apiBaseUrl；离线真载体 = `market_catalog.dart:617-623`（超时）、`:624-627`（connectionError）。**第 5 版更正本行结论的适用范围**：「0 命中」只在手机端 `lib/` 内成立；`PAIRING_EXPIRED` 全仓在册、`pairingCode.js` 已有配对有效期实现（见 §13.9 第 1 条与 §12 B16），正文当时写的「全树 0 命中」「今天没有过期这件事」不实，已订正 | §1.5 手机行拆三条子项（A→B / 配对过期 / PC 离线）；§8.5 新增状态面清单逐态标「本期可交付/不可」，行 4 补 Dio 两分支；**配对过期子项于第 5 版再改写**（§13.9 第 1 条） |
| 10 | major | 拍板② 要手机存设备列表，但没写逐设备登录/凭据；按本文接入面，A 机 JWT 到 B 机必 401；§8.5 行 1 也没写持久化迁移与按设备登出 | **成立**。`authSessionService.js:235-245` 用本机 `process.env.JWT_SECRET` 签、`:314` 验签、`:333` `User.findByPk`、`:358` `AuthSession.findByPk`；`khyos_api.dart:92-119` 单条记录含地址+token、`:137-138` 单个 SecureStorage key、`:254-267` `logout()` 删整条 | §1.5 A→B 子项标「本期不可验收」并给 401 链路；§8.5 行 1 补逐设备凭据/登出缺口；§8.3 单端点现状同步；状态面清单增「该设备未登录态」 |
| 11 | major | 四端入口名称互相冲突且与 §9.4 的定名规则冲突；无四端名称对照表；网页「智能体」与既有 `/admin/agents`（「Agent 监控」）同台混淆未登记 | **成立**。217 内三处 label 为「智能体」（§6.4/§6.5）、「智能体统一管理」（§7.3/§7.4）、「智能体管理 / 外部智能体」（§8.5）；`aliases.js:477` 「智能体 → agent」；`AgentDashboard.vue:3` title「Agent 监控」 | 新增 §9.5 四端名称对照 + 三处冲突；§6.4 第 1 行、§6.5 入口条、§9.4 尾各加指针；§11.2 第 8 条（四端统一定名） |
| 12 | major | 正文新增的未决项没有回登 §11：桌面入口三候选错指 §11.2 第 1 条（议题无关）、手机新页宿主只在 §8.6、四端定名无条目 | **成立**。§7.4 原句「入口落点在 §11.2 第 1 条的确认范围内一并定」而 §11.2 第 1 条是「桌面本期只管本机」；§11 原共 13 条（11.1 两条 + 11.2 五条 + 11.3 六条），三项均不在内 | §7.4 改指 §11.2 第 7 条；§11.2 增至 9 条（第 6–9 条 = 终端写腿 / 桌面入口 / 四端定名 / 手机宿主）；§1.7 计数与说明同步；§8.6 第 3 条加回登指针 |
| 13 | major | 终端 `instances[]` 行粒度=实例、`id` 粒度=品牌，两者未对齐，「四端 id 集合相同」无比较单元；§4.4 声称与 203:385 逐列对应，但 203:385 没有「工具数」列 | **成立**。[DESIGN-ARCH-203]:72「行粒度是实例（installation），不是品牌」；203:189-195 注册表 `id` 一家一条；217 §4.4 字段只有 `id`（全文「多实例」0 命中、「installation」仅 1 处指针行）；5q:272 行粒度=实例、:275-281 样表含实例名与「工具」列；203:385 八列无工具数 | §4.4 新增两条补登（实例键缺位：`installationId` or 实例级 `id`；「工具数」列三处口径未收口）；§11.2 第 3 条同批交契约决策员 |

**本轮未做的事（如实登记）**：

1. **未改 [DESIGN-ARCH-203]**：本轮授权只改本篇；203 `:565` 的待拍板第 1 条已在本文 §10.2 按拍板二注明「已答」，但未回改 203 原文——建议后续在 203 落一条指向 §10.2 / 5q:152-153 的订正记录。
2. **未运行 `npx vitest run src/router/nav.wiring.test.js`**：本机 `delivery/web/ai-frontend/node_modules/vitest` 缺（§12 C6）。第 6 条的「断言单向」结论来自逐区间实读测试源码，**不是测试执行结果**——不计通过。
3. **未复跑 `npm run check:doc-numbers` 与 `npm run check:delivery`**：读数沿用第 3 版 / 第 1 版（§12 H3 / F5）。本轮实跑的是 `check-doc-claims` 与 `check-doc-drift` 的数据面（裸 `--list` 与 `--list=<id>` 两档），两者恒 exit 0，输出不算通过。
4. **未查明 doc-drift「107 行 vs 109 处」的 2 条差额**：原因范围已定位到 `check-doc-drift.js:271-273`（计数）与 `:330-334`（名单）口径不同，但未逐条找出那 2 条的 doc/status；已在 §12 H3 如实登记，逐条断言一律以 `--list` 为准。
5. **未代裁任何待拍板项**：用户的 2 条、AI 自答的 9 条（含本轮新增 4 条）、委托契约决策员的 6 条，本轮只改登记与依赖关系，不替任何一方定案。

### 13.9 第五轮评审意见处置记录（第 5 版，逐条）

> 每条给出：评审指认 → 实测复核（第 5 版会话执行）→ 落点。**3 条全部成立并已修**；第 1 条是本文上一轮自己写出的范围错误（把手机端的 0 命中写成「全树」），第 2 条是漏登记既有实现，第 3 条是本文内部计数冲突。评审指认中的行号指第 4 版的行位，修订后已漂移，以「落点」列的章节号为准。

| # | 等级 | 评审指认（摘要） | 实测复核（本会话执行） | 落点 |
|---|---|---|---|---|
| 1 | blocker | §1.5「配对过期」子项与 §8.5 同项写「全树 `PAIRING_EXPIRED`/`配对过期`/`pairing_expired` 0 命中」「今天没有过期这件事」，是事实错误：该码是全仓在册错误码，且仓内已有配对有效期实现；只有限定到手机端 `lib/` 才成立 | **成立**。实跑 `git --no-pager grep -n "PAIRING_EXPIRED"` → **11 命中**：`shared/src/errorEnvelope.js:47`（hint「配对码已过期，在主端生成新码后重新配对」）、`:140`（MESSAGE_TABLE）、`backend/src/utils/khyError.js:53`、`backend/src/utils/khyErrorCategory.js:56`、`delivery/web/ai-frontend/src/utils/classifyKhyError.mjs:16`/`:109`，另有 vendor 副本与 bundle；实读 `errorEnvelope.js:139-140` 正则 `/pair(ing)?[_ ]?(code\|expired)\|session[_ ]?expired/i → PAIRING_EXPIRED`；实读 `webRemoteControl/pairingCode.js:78-83`（`_pruneCodes` 按 `expiresAt` 清）、`:93`（签发写 `expiresAt = now + ttl`）、`:106-108`（过期返回 `{ok:false, code:'SESSION_EXPIRED'}`），`protocol.js:77` 注明 TTL 与 `devicePairing.PAIRING_REQUEST_TTL_MS` 同值；实跑 `git --no-pager grep -n "配对过期"` → 1 命中（`phoneBridgeClient.js:1529` 注释）；复验限定范围：`git --no-pager grep -n -i -E "pairing_expired\|PAIRING_EXPIRED\|配对过期" -- delivery/mobile/khy-os-client-app/lib` → **无输出**（手机端 0 命中为真）。§13.8 第 9 条自己记的命令本就带该 pathspec，正文却写成「全树」，确属自相矛盾 | §1.5 配对过期子项全条重写（范围改「手机端 `lib/` 全树」，另起句登记既有码/映射/登记点/TTL 实现，交付理由改为「载荷不携带过期语义」）；§8.5 状态面清单同项同步；§13.8 第 9 条加「第 5 版更正适用范围」；新增 **§12 B16**；§11.3 第 2 条补「`PAIRING_EXPIRED` 已在册，不在新增之列」的区分 |
| 2 | major | §1.2 / §5.2 第 5 条 / §11.3 第 1 条的决策输入漏了仓内已有的 `services/devicePairing.js`（Ed25519 设备身份、指纹、角色/scope、配对生命周期、`EXPIRED` 态，已被 `pairingCode.js` 与 `protocol.js` 消费）；照本文施工会在既有机制外再造一套；且 192/216 两篇选型文档也未提，委托兜不住 | **成立**。实读 `runtime/node/backend/src/services/devicePairing.js`：`:3-18` 头注释（Ed25519 / SHA256 fingerprint / role-based token scopes / pairing lifecycle）、`:26-33` `ROLE` 层级、`:37-50` `SCOPE` 与 `ROLE_SCOPES`、`:54-60` `PAIRING_STATE`（含 `REVOKED` / `EXPIRED`）、`:62-63` `TOKEN_TTL_MS` 24h / `PAIRING_REQUEST_TTL_MS` 10min、`:124` `class DevicePairingManager`、`:157`/`:192`/`:237`/`:278`/`:301`/`:345` 六个方法；实跑 `git --no-pager grep -ln "devicePairing"` → 源码消费者仅 `services/devicePairing.js`、`webRemoteControl/pairingCode.js`（`:19` 引入、`:58` 实例化）、`webRemoteControl/protocol.js`（`:77` TTL 同源注释）；关键字计数：本文第 4 版 `devicePairing`/`DevicePairingManager`/`PAIRING_STATE`/`Ed25519` **各 0**，[DESIGN-ARCH-192]、[DESIGN-ARCH-216]、[DESIGN-ARCH-216-附1] 三篇**各 0** | §1.2「拆成两截」改为「三截」并新增第三块 bullet（含 API/状态机/TTL/消费者/「与手机二维码互不相干」），同时写明「不得另造一套」与「192/216 0 提及、委托兜不住」；§5.2 第 5 条改写为「三块既有输入 + 一块真缺口」，选型必须显式选「复用 or 另建」；§11.3 第 1 条决策输入增 ③；新增 **§12 B16** |
| 3 | major | §8.1 末句「本节把『两条暴露路径』扩为第三条远程路径」与本文总裁决冲突：三条路径应是 桌面 CH-2 / 网页+手机 CH-4 / 终端 CH-3；按该句手机自成第三条、终端成第四条 | **成立**。本文 §0 第 1 条（`:14`）：「桌面 CH-2…、网页 + 手机 CH-4…、终端 CH-3」；§2.1（`:114-118`）列三条、第 3 条即终端 CH-3；§2.4 手机行与 §3.6 订正（`:234`）均按「四端三条暴露路径」；[DESIGN-ARCH-203]:15 原文「一个 service、两条互不重叠的暴露路径，两个前端表面」 | §8.1 末句改为「手机并入既有 CH-4 这条路径（与网页同命名空间、同一套 `authenticateToken`），第三条路径由终端 CH-3 承担」，并把原文的计数错误与冲突对象写进括号 |

**本轮未做的事（如实登记）**：

1. **未改 [DESIGN-ARCH-203] / [DESIGN-ARCH-192] / [DESIGN-ARCH-216]**：本轮授权只改本篇。192 与 216 各 0 次提及 `devicePairing` 这一事实已在 §12 B16 登记；是否在其原文补「决策输入含 devicePairing」属另案授权，本轮不改。
2. **未查其它 `配对过期` 相关的既有 UI/协议面是否还有第三处实现**：本轮只核到 `PAIRING_EXPIRED` 码（errorEnvelope / khyError / khyErrorCategory / 网页镜像）与 `pairingCode.js` 的 TTL 实现、`phoneBridgeClient.js:1529` 一处注释；`webRemoteControl` 前端是否有独立的过期提示文案未逐文件核（不影响本轮结论：手机端 0 命中是实测的）。
3. **未运行 `npx vitest`、未复跑 `check:doc-numbers` / `check:delivery`**：依赖与范围同 §13.8 第 2、3 条，本轮未新增运行。
4. **未代裁任何待拍板项**：用户 2 条、AI 自答 9 条、委托契约决策员 6 条维持原状；本轮只补决策输入（`devicePairing` 的复用/另建须由选型回答）。
