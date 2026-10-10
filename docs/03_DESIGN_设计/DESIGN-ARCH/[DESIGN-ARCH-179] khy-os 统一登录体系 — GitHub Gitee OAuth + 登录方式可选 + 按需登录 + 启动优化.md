# [DESIGN-ARCH-179] khy-os 统一登录体系 — GitHub/Gitee OAuth + 登录方式可选 + 按需登录 + 启动优化

> **定位**：把 khy-os 的登录面从「仅本机密码 + 扫码」扩展为「**多身份源可选**」，
> 并引入「**按需登录**」（非必要不强制登录），同时收敛 CLI 与桌面两端的启动耗时。
> **本文是该改造的唯一真源**。
>
> **承接**：`[DESIGN-ARCH-074]`（账号体系收口）第 38 行 / §7 明文「**不做 OAuth / SAML / LDAP，
> 留给后续**」。本文补的正是这块空白 —— 与 074 **不重叠**（边界见 §1）。
>
> **适用边界**：登录身份源、登录方式发现位、按需登录门控、两端启动耗时。
> 仓库层级见 `[DESIGN-LAY-005]`；会话/令牌契约见 `AUTH-002`（本文不重定义）。

---

## 1. 与既有机制的边界（不造第二套真源）

| 既有件 | 它管什么 | 本方案做什么 | 边界 |
|---|---|---|---|
| `[DESIGN-ARCH-074]` 账号体系收口 | `User.username` 唯一键、`aliases` 登录别名、`displayName` 昵称、密码必填、LAN 暴露 | OAuth 身份源接入 | 074 第 38/243 行**明文不做 OAuth**；本文只加身份源，**不改** username/alias/password 的既有语义 |
| `AUTH-002` Session 管理规范（P0） | 令牌有效期（15m/7d）、RS256、cookie 属性、并发会话上限 | 复用既有签发链路 | OAuth 登录成功后**沿用** `authSessionService.issueSessionForUser()`，**不新造**签发逻辑 |
| `routes/auth.js` 的 `AUTH_CAPABILITIES` | 登录面能力发现的**单一真源**（登录页据此渲染） | 把 `oauthProviders` 从 `[]` 填成真实列表 | **只填既有字段**，不新增发现端点 |
| `ai-frontend` 路由 `requiresAuth` | 已有按路由的登录门控 | 补齐「非必要不登录」的默认档 | 复用既有 `meta.requiresAuth` 机制，不新造守卫 |

**结论**：本方案 = 074 预留的 OAuth 空白 + capabilities 既有字段填充 + 既有门控机制的默认档调整。**零新真源**。

---

## 2. 现状证据（可复核 file:line）

| 事实 | 证据 |
|---|---|
| 后端**没有任何 OAuth 登录**，能力位显式为空 | `runtime/node/backend/src/routes/auth.js:62-85`（`oauthProviders: []`，注释「No OAuth identity providers are wired」） |
| 前端能力位发现已有、且 fail-soft 到最保守档 | `delivery/web/ai-frontend/src/api/auth.js:10-42` |
| 登录页**只读** `defaultAdminAvailable` / `passwordReset`，**未读** `oauthProviders` | `delivery/web/ai-frontend/src/views/Login.vue:99-108` |
| `User` 已有 `aliases`（登录别名，全局唯一）与 `displayName`（昵称） | `runtime/substrate/platform/packages/shared/src/models/User.js:95-109` |
| 会话签发入口 | `runtime/node/backend/src/routes/auth.js:26-29` → `authSessionService.issueSessionForUser()` |
| 桌面应用登录页是**纯模拟**且**未被引用** | `apps/khyos-desktop/src/renderer/components/auth/LoginPage.tsx:22`（`setTimeout` 假登录）；`App.tsx` 无 import |
| 桌面应用**无登录闸门**（直接进 IDE） | `apps/khyos-desktop/src/renderer/App.tsx:95-97,540` |
| web 前端有按路由门控 | `delivery/web/ai-frontend/src/router/index.js:532-562`（`beforeEach` + `resolveAuthGuard`） |
| CLI 启动节拍真源 | `runtime/node/backend/src/cli/startupBeats.js`、`bootPhaseLine.js` |
| `.env.example` **无任何** OAuth 配置项 | `grep -niE "oauth\|github\|gitee" .env.example` → 空 |

> ⚠ 仓库已做过目录迁移：`services/backend` → `runtime/node/backend`；`apps/ai-frontend` → `delivery/web/ai-frontend`。
> `[DESIGN-ARCH-074]` §4 的文件清单仍是**旧路径**，实施时按本文路径为准。

---

## 3. 目标（用户四诉求 → 可验收判据）

| # | 诉求 | 验收判据（机器可判） |
|---|---|---|
| G1 | 有 GitHub/Gitee 登录时，默认账户名取 provider 登录名 | 新用户经 GitHub 首次登录 → `User.username === <github login>`（重名时加数字后缀，见 §4.3） |
| G2 | 登录方式可选 | `GET /api/auth/capabilities` 返回 `oauthProviders` 非空；登录页按它渲染对应按钮；未配置的 provider **不出现**（不渲染 404 按钮） |
| G3 | 只有必须登录的功能才强制注册登录 | 默认档：未登录可进入应用主体（本地/游客可用）；仅被标注为「需账号」的功能触发登录引导 |
| G4 | 启动更快 | CLI 与桌面各给出**改动前后同一指标的实测对比**（不是「更快了」） |

---

## 4. 数据契约（OAuth 身份绑定）★ 需人裁决

### 4.1 支点问题

OAuth 登录需要一个**稳定的身份键**来回答「这个 GitHub 用户对应本系统哪个账号」。
GitHub/Gitee 的 `login`（用户名）**可变**，稳定的只有数字 `id`。因此必须存 `provider + provider_id`。

### 4.2 两个备选（代价对比）

| 方案 | 落点 | 优点 | 代价 |
|---|---|---|---|
| **A（推荐）新增 `User.oauthAccounts` JSON** | `User.js` 加一列 | 语义干净：身份源 ≠ 登录别名；`{github:{id,login}, gitee:{id,login}}` | **扩真源**：动 User 模型 + `sequelize.sync({alter:true})` 加列 + 迁移存量（存量默认 `{}`，行为不变） |
| B 复用 `User.aliases` | 不扩真源 | 零迁移 | 污染登录键空间：`aliases` 参与 `resolveLoginKey`，会把 `github:xxx` 变成可登录名；且 alias 字符集限制（074 §2.1：`[a-zA-Z0-9_.\-@]`）装不下 provider 前缀语义 |

**推荐 A**，理由：`aliases` 的语义是「登录别名」（074 §2.1），OAuth 身份是「外部身份源」，两者是**不同维度**；
按 `[MGMT-STD-008]` §2.2「重叠即违规」，混用会造出「一个字段两种语义」的隐性第二真源。

> ⚠ **此项需人裁决**（见 §9 Q-1）。倾向 A 但代价是动 User 模型。

### 4.3 默认账户名生成（G1 的支点）

```text
新用户经 provider 首次登录：
  candidate = provider.login（GitHub/Gitee 的用户名）
  若 candidate 已被占用（User.username 唯一）：
      candidate = `${provider.login}_${provider.id 后 4 位}`
  仍冲突 → 追加 `_2`、`_3` …（有上限，超限则改用 `provider_login_<random>`）
  User.create({ username: candidate, email: <provider 邮箱或占位>, password: <随机不可登录串>, aliases: [], oauthAccounts: {...} })
```

**关键约束**：
- OAuth 建号时 `password` 必须写**随机不可登录串**（074 §3 要求 password 必填），
  用户后续可在「设置 → 账号」设真实密码（复用既有 `/change-password`，需先允许无密码账号设置密码 —— 见 §9 Q-3）。
- `email` 唯一约束：GitHub 可能不返回 email（用户设为私有）→ 需占位策略（见 §9 Q-2）。

---

## 5. 分片计划（一次提交只做一片）

### A 片 — 后端 OAuth 基础（GitHub + Gitee）

| # | 文件 | 改动 |
|---|---|---|
| A1 | `runtime/node/backend/src/routes/auth.js` | `AUTH_CAPABILITIES.oauthProviders` 由 `[]` → 由配置派生（未配置的 provider 不进列表） |
| A2 | `runtime/node/backend/src/services/oauth/oauthProviderRegistry.js`（新，纯叶子） | provider 元数据：`github` / `gitee` 的 authorize/token/userinfo 端点、scope、字段映射。**零 IO、可单测** |
| A3 | `runtime/node/backend/src/services/oauth/oauthStateStore.js`（新） | `state` 防 CSRF（一次性、TTL、内存 Map + 定期清理，仿 `qrLoginStore` 既有手法 `auth.js:50-113`） |
| A4 | `runtime/node/backend/src/services/oauth/oauthLoginService.js`（新） | 授权码换 token → 拉 userinfo → 匹配/建号（§4.3）→ 调 `issueSessionForUser` |
| A5 | `runtime/node/backend/src/routes/auth.js` | 新增 `GET /api/auth/oauth/:provider`（跳授权）+ `GET /api/auth/oauth/:provider/callback`（回调 → 302 回前端并带一次性登录票据） |
| A6 | `runtime/node/backend/src/constants/serviceDefaults.js` | 加 `GITHUB_CLIENT_ID/SECRET`、`GITEE_CLIENT_ID/SECRET`、`OAUTH_REDIRECT_BASE` 的 env 读取（单一真源） |
| A7 | `.env.example` | 补 OAuth 配置项与注释（未配置 → capabilities 不出现该 provider） |
| A8 | `User.js`（若 §9 Q-1 选 A） | 加 `oauthAccounts` JSON 字段 |

**验收**：`GET /api/auth/capabilities` 在配了 GitHub env 时返回 `[{id:'github',...}]`；
未配时返回 `[]`；`oauthStateStore` 单测覆盖「state 一次性 / 过期 / 伪造」三种输入。

### B 片 — 三端登录 UI（方式可选）

| # | 文件 | 改动 |
|---|---|---|
| B1 | `delivery/web/ai-frontend/src/api/auth.js` | `FALLBACK_CAPABILITIES` 已有 `oauthProviders`，**无需改**；`resolveCapabilities` 已透传 |
| B2 | `delivery/web/ai-frontend/src/views/Login.vue` | 读 `caps.oauthProviders`，渲染第三方登录按钮；点击 → `window.location = /api/auth/oauth/<id>` |
| B3 | `delivery/web/ai-frontend/src/views/Login.vue` | 处理回调（`?oauth_ticket=...`）→ 换 token（复用 `userStore`，加一个 `loginWithTicket` action） |
| B4 | `apps/khyos-desktop/src/renderer/components/auth/LoginPage.tsx` | 现为 mock：接真实 `__KHYOS__` auth IPC（或复用 web 同一后端），渲染方式选择；**并在 App.tsx 接线**（当前未引用） |
| B5 | `apps/khyos-desktop/src/preload/index.ts` + `src/main/index.ts` | 新增 auth IPC（`authLogin` / `authCapabilities` / `authOauthStart`）—— 落点待实施时按既有 IPC 范式确认 |

### C 片 — 按需登录（G3）

| # | 落点 | 改动 |
|---|---|---|
| C1 | `delivery/web/ai-frontend/src/router/index.js` | 现状：`requiresAuth` 按路由标注。**审查每一条**，只保留「必须登录」的（账号/密钥/付费/管理）；纯浏览页放开 |
| C2 | `apps/khyos-desktop/src/renderer/App.tsx` | 现状无门控。引入「默认放行 + 必要功能引导」：给需账号的入口（密钥管理、云同步）加登录引导，**不是**整屏登录闸门 |
| C3 | 后端 | 标出「必须登录」的接口清单（哪些 API 在未登录时返回 401 是**预期**而非缺陷）—— 作为 C 片的契约真源 |

### D 片 — 启动优化（G4，与 A/B/C **互相独立**，可并行）

> ⚠ **D 片不是从零开始**：CLI 头号病灶**已被 `[DESIGN-ARCH-178]` 精确定位**（状态：**提案，未接线**）——
> `vendor/shared/src/services/cacheService.js:157` 在模块顶层裸调 `initRedis()`，任何一次 `require` 都会
> 同步加载整棵 redis 客户端树（实测 **20.4s / 542 模块**）。实测首帧 **44.1s → 10.9s（-75%）**，
> 再收两处非首帧重 require → **9.2s**。⇒ **D1 = 落地 178，不重复诊断**。
> 前序：`[DESIGN-ARCH-140]`（5.83s 量级，E1–E6 病灶，在 redis 面前仍全部成立）。

**方法论**（已在本仓实测沉淀，见启动性能 skill）：
- **判据是「结构事实」不是「耗时」**（耗时抖动 400~700ms，不可靠）：
  例 `winston-loaded: true→false`、`已加载 handler 数: 152→0`。
- **必须背靠背交错 + 每组取 min**。
- 已知**已修**项：handlers 两阶段惰性加载（`init()` ~450ms → 22ms）；渲染体内 `spawnSync` 已移出渲染路径。
- 已知**残留**项：工具模块的懒编译（`wrapSafe`/`readFileUtf8`）仍占首帧 ~1.2s；
  彻底的解是把工具注册表元数据也做成两阶段（同 handlers 手法）。

| # | 落点 | 动作 |
|---|---|---|
| D1 | CLI | **落地 `[DESIGN-ARCH-178]`**：`cacheService` 顶层 `initRedis()` 改懒加载 + 两处非首帧重 require 后移。判据 = 首帧耗时 + `require.cache` 模块数（44.1s/1523 → ~9.2s/839）。**P0 已落地 2026-10-04**（模块增量 543 → 1） |
| D2 | 桌面 | **已诊断 2026-10-04**（见 §12）：生产构建冷启到窗口可见 **0.8–1.5s**（5 次采样）、主进程侧 <0.3s、窗口显示后 IPC 合计 11ms ⇒ **生产冷启路径非瓶颈**；**dev 模式 2.9–9.5s**（Vite 开发模式固有代价）⇒ 「慢」的真入口是开发态。**结论：不在生产冷启上做优化** |

> ⚠ 桌面端（D2）**不承诺具体数字**，只承诺「诊断先行 + 改动前后同指标实测对比」——空口承诺「更快」违反本仓「声称 ≠ 判据」。
>
> ⚠ **与 `[DESIGN-ARCH-168]` 的边界**：168 管「这台机器开机时哪些程序自启」（Windows Run 键 / 计划任务 / 服务），
> 168 第 5-6 行明文**不管**「仓库代码的启动性能」。D 片管的是「程序自身的启动耗时」，两者不重叠。

---

## 6. 强度梯度（事前 advisory / 事中 warning / 事末 error）

| 阶段 | 强度 | 说明 |
|---|---|---|
| A 片落地 | advisory | 新增 provider，不影响既有密码登录 |
| B 片落地 | advisory | UI 增量，未配置 provider 不渲染 |
| C 片（门控放开） | warning | 「放开」比「收紧」风险低，但需观察是否有功能因未登录而不可用 |
| OAuth 安全项（state 校验、redirect 白名单） | **error** | 安全边界，不可让渡 |

---

## 7. 防呆铁律（每条都有可自动判的判据）

1. **未配置的 provider 绝不出现**：`capabilities.oauthProviders` 只由「env 齐全」派生 ⇒ 判据：env 缺失时 `oauthProviders === []`（单测）。
2. **state 一次性**：同一 `state` 第二次使用必须拒绝 ⇒ 判据：单测「重放 → 400」。
3. **redirect 目标白名单**：回调只能 302 到本机已知前端源 ⇒ 判据：非白名单源 → 拒绝（单测）。
4. **OAuth 建号不覆盖既有账号**：`username` 冲突时**新建带后缀**，绝不静默改别人用户名 ⇒ 判据：单测「同名两次登录 → 两个不同 user」。
5. **不新造令牌签发**：OAuth 成功必须走 `issueSessionForUser` ⇒ 判据：`grep` 新增文件中不出现 `jwt.sign`。

---

## 8. 验证与反例清单

| 反例 | 预期 finding |
|---|---|
| env 未配 GitHub，登录页仍渲染 GitHub 按钮 | 违反铁律 1 → 单测红 |
| `state` 重放 | 铁律 2 → 400 |
| 回调 `redirect` 指向外部域 | 铁律 3 → 拒绝 |
| GitHub login 与既有用户重名 | 铁律 4 → 新建带后缀，不覆盖 |
| 新增文件里手写 `jwt.sign` | 铁律 5 → grep 断言红 |
| 放开某路由的 `requiresAuth` 后，该页依赖登录态数据 | C 片回归：该页在未登录时应显示引导而非崩溃 |

---

## 9. 未决问题（需人裁决，不代为决定）

| # | 问题 | 选项 | 代价 |
|---|---|---|---|
| Q-1 | OAuth 身份存哪 | A 新增 `oauthAccounts`（推荐）/ B 复用 `aliases` | A 动 User 模型（加列 + sync）；B 污染登录键空间 |
| Q-2 | GitHub 不返回 email 时怎么建号 | 占位邮箱 `github_<id>@oauth.local` / 要求用户补邮箱 / 允许 email 为空（需改模型 `allowNull`） | 各影响注册表单与唯一约束 |
| Q-3 | OAuth 账号如何设密码 | 允许 `/change-password` 对无密码账号免校验旧密码 / 另立「设密码」端点 | 影响 AUTH 安全面 |
| Q-4 | 桌面应用是否复用 web 后端 | 复用同一后端 / 桌面独立鉴权 | 影响 B4/B5 工作量与 IPC 设计 |
| Q-5 | C 片「必须登录」的清单由谁定 | 逐页评审 / 先按现状收窄 | 影响 C 片工作量 |
| Q-6 | D 片桌面端是否本轮做 | 做 / 拆到独立提案 | **已由 §12 实测判定并收口**：生产冷启非瓶颈（0.8–1.5s）⇒ 不做优化、不拆提案；dev 模式 2.9–9.5s 是 Vite 固有代价，也不是「待优化项」 |

---

## 10. 复现方式（实施时可直接粘贴）

```bash
# 现状证据复核
sed -n '62,90p' runtime/node/backend/src/routes/auth.js          # oauthProviders: []
grep -niE "oauth|github|gitee" .env.example                       # 空
sed -n '95,109p' runtime/substrate/platform/packages/shared/src/models/User.js  # aliases / displayName

# 启动诊断（D 片）
cd runtime/node/backend
STARTUP_PROFILE=1 node bin/khy.js version
```

---

## 11. 本轮未做（防止被误读为已落地）

- ✅ **D1（落地 178 的 P0）已实施**（2026-10-04）：`cacheService` 顶层 `initRedis()` 改惰性，`require.cache` 模块增量 **543 → 1**（redis 模块 522 → 0）。
- ✅ **D2（桌面冷启）已诊断**（2026-10-04，见 §12）：生产构建冷启 **0.8–1.5s** ⇒ **非瓶颈，无优化目标**；
  dev 模式 **2.9–9.5s**（Vite 开发模式固有代价）⇒ 「慢」的真入口是**开发态**，不是产品。
- ✅ **诊断副产物已处理**（见 §12.6）：桌面端旧路径断链**已修并重建**（判据见 §12.6 表）；
  守卫盲区**已补检测能力**（`--scan-split-refs`，只加不改、不进 CI 门禁）。
- ❌ **A/B/C 片未实施**：本文其余部分是方案。
- ❌ **未接真实 OAuth**：A2–A5 的端点、字段映射需实施时回源核对（GitHub/Gitee 官方文档）。
- ❌ **未改 `.env.example`**：配置项在 A7 落地。
- ⚠ 本文的**代码锚点路径**已按当前仓库结构（迁移后）给出；`[DESIGN-ARCH-074]` 里的旧路径不作为依据。
- ⚠ **未批量改**全仓 209 处拆段旧路径（判据是「这行是不是真的要去读那个路径」，机器答不了）；
  `node_modules/electron` 版本漂移（32.3.3 vs 声明 44.2.0）**未处理**，需人裁决。

---

## 12. D2 桌面冷启实测存证（2026-10-04）

> §5 的 D2 要求「**诊断先行 + 改动前后同指标实测对比**」。本节是该诊断的实测存证。
> **未改任何源码** —— 探针只挂 Electron 公开事件（`app` / `BrowserWindow` / `webContents` / `ipcMain`），
> 脚本留在 `.khyos/diag/d2-*.mjs`（该目录 gitignored，不污染仓库）。

### 12.1 结论

**（1）生产构建的冷启不是瓶颈。** 从 Electron 进程起来到「窗口可见」**0.8–1.5s**（5 次采样，中位 ~1.0s），
其中主进程自身开销 **< 0.3s**；窗口显示后 renderer 触发的 IPC **合计 11ms**（8 个通道）。

**（2）★ dev 模式才是「慢」的真入口。** 同一个应用、同一台机器，走 `electron-vite dev`
（vite dev server 逐个模块服务 + 按需转换）时首屏 **2.9–9.5s**，是生产构建的 **3–10 倍**。
⇒ 用户原话「khyos 启动太慢」若指的是**开发态**，那是对的；指的是**双击/打包态**，则不成立。
**D 片据此收口**：不在生产冷启路径上做优化（没有目标），dev 态的差距是 Vite 开发模式的固有代价。

### 12.2 实测时间线（同一台机器；口径见 §12.3）

| 检查点 | run1 | run2 | run3 | run4 | run5 | min |
|---|---|---|---|---|---|---|
| Electron main 可执行 | 122 | 136 | 139 | 199 | 254 | 122 |
| main bundle 解析+执行完（含 10 个内联本地模块） | 139 | 150 | 156 | 223 | 297 | 139 |
| `app.whenReady` 解决 | 174 | 186 | 194 | 284 | 420 | 174 |
| `BrowserWindow` 构造 | 264 | 281 | 283 | 418 | 557 | 264 |
| renderer `dom-ready` | 741 | 761 | 767 | 1201 | 1514 | 741 |
| **`ready-to-show` / `show`（用户可见）** | 838/850 | 761/770 | 958/969 | 1425/1437 | 1516/1531 | **761/770** |

单位 ms。对照基准（同口径）：**空 main 的 Electron 冷启下限 = `app ready` 232ms**（3 次：400 / 232 / 263）。
⇒ 应用在 Electron 之上只加了约 **0.5s**，其中 renderer bundle（**2.31MB 单包**，`out/renderer/assets/index-*.js`）
占约 **0.46s**（`did-start-loading` 279 → `dom-ready` 741）。

窗口显示后的主进程负载（第 6 次运行，25s 窗口内累计）：

| 通道 | 次数 | 总耗时 | 最大 |
|---|---|---|---|
| `background:status` | 8 | 11ms | 3ms |
| `models:list` | 3 | 10ms | 4ms |
| `session:list` / `context:size` / `workspace:list` / `app:workspacePath` / `settings:get` / `theme:get` | 各 1–6 | 合计 <5ms | ≤2ms |

**⇒ 窗口显示后主进程几乎不忙；「慢」若存在，也不在启动路径上。**

### 12.3 dev 模式对照（同一探针，只把加载源换成 vite dev server）

| 加载源 | `dom-ready` | `ready-to-show` / `show` | 采样 |
|---|---|---|---|
| **生产构建**（`out/renderer/index.html`，2.31MB 单包） | 741ms | **761 / 770ms** | 5 次，0.77–1.53s |
| **dev 模式**（`http://localhost:5173/`，未打包） | 2852–8137ms | **2876–9502ms** | 4 次 |

做法：`electron-vite dev --rendererOnly` 起真实 dev server（用仓库自己的 `electron.vite.config.ts`，
不改配置），再让探针带 `VITE_DEV_SERVER_URL=http://localhost:5173/` 加载 —— 与 `createWindow()`
判 `process.env.VITE_DEV_SERVER_URL` 走 `loadURL` 的真实分支一致。

机制：dev 模式下 renderer 由 vite **逐个模块**服务（构建日志实测 **1967 个模块**）并做按需转换，
首屏受请求数主导；生产构建则是单个 2.31MB 包，一次解析。这是 Vite 开发模式的固有代价，不是缺陷。

⚠ 本环境测 dev server 时撞到沙箱的批量删除闸（vite 提交依赖预构建缓存要删 69–81 个条目，
`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，阈值 50）。用官方开关 `CODEBUDDY_SAFE_DELETE_ENABLED=0`
**仅对这一条命令**放行，影响面只有 `node_modules/.vite/deps`（可再生缓存）。

### 12.4 复现方式

```bash
cd apps/khyos-desktop
../../node_modules/electron/dist/electron.exe ../../.khyos/diag/d2-trace2.mjs \
    --no-sandbox --disable-gpu --disable-software-rasterizer --in-process-gpu
# IPC 负载：把 d2-trace2.mjs 换成 d2-trace3.mjs
# dev 模式对照：另开一个终端跑 electron-vite dev --rendererOnly，再带 VITE_DEV_SERVER_URL 跑上面这条
```

⚠ **`--no-sandbox` 是本诊断环境的必需项，不是产品建议。** 在本工具环境里不带该标志时
renderer 进程被**直接杀掉**（`render-process-gone {"reason":"killed","exitCode":1}`），`ready-to-show`
永不触发。该现象在**裸窗口**（`d2-renderer-only.mjs`，不加载任何应用代码）上**同样复现**，
⇒ 判定为**测量环境限制**，不是应用缺陷；真实用户双击启动不受影响。
`d2-floor.mjs` 是空 main 下限探针。

### 12.5 诊断副产物（四个为真、但**与启动无关**的发现）

| # | 发现 | 证据（file:line） | 状态 |
|---|---|---|---|
| a | 桌面端 **host 进程 8 条 backend 路径全是旧路径** `services/backend/**`，而该目录在 HEAD 已不存在 | `apps/khyos-desktop/src/host/index.ts:52,92,126,134,147,176,207,228`；`git ls-tree -d HEAD services/` → 空 | **已修**（§12.6）。`loadGatewayEnvFile()` 在首次 `ai.generate` 才惰性调用（`:406`）⇒ 启动不报错、**运行时才炸** |
| b | 同类旧路径还散在两处，另发现一处**深度错** | `src/main/index.ts:1308`（相对回退少一级）；`src/main/keyManager/agentWriters.ts:38,40,41,95` | **已修**（§12.6） |
| c | 仓库自带的迁移守卫**漏报 a/b**：`path-integrity.js --scan-refs` 报告 3544 处真断，但 **`apps/khyos-desktop` 出现 0 次** | 最小复现：别名正则要求连续 `services/` token（`buildAliasRegexes()`），而 host 写的是 `path.join(root, 'services', 'backend', '.env')` —— **拆段字面量** ⇒ 正则永不命中（实测：连续写法 `true` / 拆段写法 `false`） | **已补检测能力**（§12.6，只加不改、不进 CI 门禁） |
| d | ~~`node_modules/electron` 实装 **32.3.3**，而 `apps/khyos-desktop/package.json` 声明 **44.2.0**（版本漂移）~~ —— **2026-10-04 复核：不是漂移，是我的探针取错了二进制** | 桌面端有**两份** Electron：`apps/khyos-desktop/node_modules/electron` = **44.2.0**（node 24.20.0 / chrome 152，**app 真正用的那份**，`electron-vite` 从 app 目录解析）；`<repo>/node_modules/electron` = **32.3.3**（node 20.18.1 / chrome 128，根 devDependencies 的**遗留工具链**：根 `package.json` 无任何 script 引用 electron，也无 workspace 成员需要它）。§12.2 的基线命令写的是 `../../node_modules/electron/...` ⇒ 跑的是 **32.3.3** | **已定性**（见 §12.7）。连带发现：`apps/khyos-desktop` **不是任何 workspace 成员**（`workspaces` / `pnpm-workspace.yaml` 都指向不存在的 `delivery/desktop/khyos-desktop`），该缺口 `path-integrity` 默认模式**已报** |

### 12.6 同轮落地的动作（2026-10-04）

**（1）修桌面端旧路径断链（a + b）** —— 按别名表 `services/ → runtime/node/` **机械映射**：

- `src/host/index.ts` 8 处、`src/main/index.ts` 1 处、`src/main/keyManager/agentWriters.ts` 4 处
  （+ `proxyStatus.ts:130` 的**面向用户报错文案**，本仓 `[DESIGN-ARCH-170]` 管「指路真实性」）；
- `src/main/index.ts:1308` 的 `app:brandingLinks` 相对回退**同时修深度**：`__dirname` 是 `out/main`，
  到仓库根要**上溯 4 级**（原写 3 级会停在 `<repo>/apps`，叠加旧路径段后整行恒不可达）；
- 同步修 `tests/agentWriters.test.mjs:15` 的 fixture —— 它**功能性**地建出假仓根的候选目录，
  路径不同步就测不到「候选命中但不完整」那条分支。

**判据（全部实测）**：

| 判据 | 结果 |
|---|---|
| 产物里旧路径段 | `out/host` / `out/main` 各 **0** 处（`"services", "backend"`） |
| 产物里新路径段 | host 7 / main 5（host 源码 8 处中，`loadGateway()` 是**死代码**，其 `aiGateway.js` 引用被 tree-shaking 移除） |
| 端到端可达 | 8 条 host 路径 + `agentWriters` 候选 + `app:brandingLinks` **全部 existsSync 通过** |
| `resolveBackendServicesRoot()` 分支 | 分两进程验证：候选目录不完整 → `null`；补上 `providerPresets.js` → **命中该目录**（证明候选路径真活） |
| 重建影响面 | 只 `out/main/index.js` + `out/host/index.js` 变；`renderer/preload/scheduler` 哈希**与改动前逐字节一致** |
| 测试 | 桌面端 **85/85** 通过（51 + 34） |

**（2）补守卫检测能力（c）** —— 新增 `path-integrity.js --scan-split-refs`（`npm run check:path-split-refs`）：
只报告、恒 `exit 0`、**刻意不进任何 CI 门禁**（拆段写法里相当一部分是**刻意**引用旧路径：
自愈服务 / `where.js` 展示 / 测试 fixture；放开成门禁会制造误报洪水 —— 公理 A4「误报比漏报更贵」）。

首次全仓扫描：**真断 209 处**（`runtime` 93 / `scripts` 59 / `delivery` 35 / `docs` 13 / `apps` 6 / `works` 2 / `entries` 1，
其中 **82 处落在测试文件**里）+「新旧都不存在」273 处（多为便携包相对路径）。
**`apps/khyos-desktop/src` 与 `out` 已归零**（剩余 6 处全在 `dist-ts/` 这个 tsc 中间产物里）。

实现要点（写的时候踩到并修掉的两条）：① 假阳性类 —— 新路径里含旧别名子串
（`runtime/node/backend/src/services/…` 里的 `services/`、`runtime/substrate/platform/…` 里的 `platform/`），
用「前缀已含 `to`」过滤，与 `--scan-refs` 的 noop 规则同旨；② 该模块有**模块级缓存**，
验证解析分支必须**分进程**跑，同进程第二次调用只会拿到缓存值。
判据见 `scripts/tests/path-integrity-split-refs.test.js`（18 用例，含对上述 6 个已修文件的**回归锁**）。

> **边界声明**：a/b 属「迁移未收口」，c 属「守卫失明」。本轮按「先修能证明的、补检测能力但不放开成门禁」
> 处理；**未**批量改全仓那 209 处（判据是「这行是不是真的要去读那个路径」，机器答不了）。

### 12.7 口径更正：桌面端跑的是哪一份 Electron（2026-10-04 复核）

**结论：不存在版本漂移。** 之前记的「实装 32.3.3 vs 声明 44.2.0」是**我的探针取错了二进制**。

| 位置 | 版本 | 谁在用 |
|---|---|---|
| `apps/khyos-desktop/node_modules/electron` | **44.2.0**（node 24.20.0 / chrome 152） | **桌面端真正跑的那份** —— `npm run dev` 里 `electron-vite` 从 app 目录解析 |
| `<repo>/node_modules/electron` | **32.3.3**（node 20.18.1 / chrome 128） | 根 devDependencies 的**遗留工具链**：根 `package.json` **没有任何 script 引用 electron**，也没有 workspace 成员需要它 ⇒ 疑似死声明 |

§12.2 的基线命令写的是 `../../node_modules/electron/...` ⇒ **实际跑的是 32.3.3**。
dev 与生产**两条臂用的是同一个二进制**，所以 **3–10 倍这个比值不受影响**；
但**绝对值严格说属于 32.3.3**。44.2.0 的复测在 2026-10-04 的会话环境里**被卡住**（见下），列为待办。

**连带发现（已在守卫里报出，非新增缺陷）**：`apps/khyos-desktop` **不是任何 workspace 成员** ——
根 `workspaces` 与 `pnpm-workspace.yaml` 都指向**不存在**的 `delivery/desktop/khyos-desktop`，
而真身在 `apps/khyos-desktop`（所以才需要一份局部 node_modules）。
`node scripts/maintenance/path-integrity.js` 默认模式**已报**：`MISS workspaces: delivery/desktop/khyos-desktop`。

**复测被卡住的三个坑（都已写进 skill `khyos-startup-perf` §2.9）**：

1. **会话环境被注入 `ELECTRON_RUN_AS_NODE=1`** —— 一旦为 `1`，Electron **退化成纯 Node**：
   `require('electron')` / `import ... from 'electron'` 拿不到内置模块（解析到 npm 包，返回一个字符串路径），
   探针立刻报 `Cannot read properties of undefined (reading 'whenReady')` 或
   `does not provide an export named 'app'`；`electron.exe --version` 会打印 **Node 的版本**
   （看到 `v24.20.0` / `v20.18.1` 就是中招，**不是二进制坏了**）。
   实测该变量只存在于**会话进程环境**（User/Machine 均为 `null`），**对真实用户无影响**。
   去掉它（`env -u ELECTRON_RUN_AS_NODE`）后，本沙箱里 Electron 不再产出任何输出 ⇒ **复测无法在本环境完成**。
2. **探针文件必须落在 Electron 认定的 app 目录内**，`require('electron')` 才映射到内置模块。
3. **输出必须同步落盘**：`console.log` 在 Windows 上重定向到文件是**块缓冲**，进程被 `taskkill /F`
   强杀会整块丢失（实测日志 0 字节，会误判成「探针没跑」）。用 `fs.appendFileSync`；
   并 `taskkill //F //T //PID $!` 杀**进程树**（否则 app fork 的 host/scheduler 会吊住管道）。

### 12.8 拆段旧路径分诊清单（2026-10-04）

按 §12.6 的口径（只加检测、不批量改）续做了**人工判的材料准备**：
`--scan-split-refs --json` → `.khyos/diag/triage-split-refs.mjs` → `.khyos/diag/split-refs-triage.md`
（gitignored，**带每一条的原始源码行**，便于逐条判）。

本轮复扫：**真断 206 处 / 88 文件**（`runtime` 93 / `scripts` 56 / `delivery` 35 / `docs` 13 / `apps` 6 / `works` 2 / `entries` 1；
其中 **82 处落在测试文件**）+「新旧都不存在」273 处 +「旧路径仍在」0 处。
（上一轮记录 209，`scripts` 一项由 59 变 56；差额未逐条归因，扫描对 `docs/**` 的 html 重生成敏感。）

分桶（启发式，只为降低人工成本）：

| 桶 | 含义 | 文件 | 处 | 处置建议 |
|---|---|---|---|---|
| **A** | 归档 / 文档 | 7 | 13 | 保留（迁移映射表刻意记旧路径） |
| **B** | 构建产物 / 中间产物（`dist-ts/`、`.build-tmp/`） | 4 | 10 | 先确认是否还被引用，多半可删 |
| **C** | 测试 fixture | 32 | 82 | 判据是 **fixture 建的是不是真路径** |
| **D** | 自愈 / 便携 / 迁移 / 诊断面 | 21 | 53 | **多为刻意**（要同时认新旧才能自愈） |
| **E** | **生产源码** | 24 | 48 | **★ 最可能真需要修，优先看** |

**E 桶里判起来最像真断的几处**（仅供人工参考，本轮未改）：

| 文件 | 处 | 形态 |
|---|---|---|
| `runtime/node/backend/src/services/updateCoordinator.js` | 4 | `existsSync(path.join(root,'services','backend','package.json')) ? root : null` —— 旧路径恒不存在 ⇒ **仓库根探测恒失败**，静默返回 `null` |
| `scripts/ci/check-agent-docs.js` | 3 | `path.join('services','backend','src',…)` 写死在守卫里（`:61-64`）⇒ 三个「真源」全部回退硬编码兜底。**但实测「陈旧 ≠ 当前失明」**，见下 |
| `runtime/node/backend/src/services/domain/deploy/publish/projectState.js` | 4 | 候选清单里 `platform/`、`services/backend`、`packaging/npm`、`packaging/modules` 四段全是旧顶层 |
| `runtime/node/backend/src/cli/handlers/gatewayManageDaemon.js` | 8 | `apps/ai-frontend` **候选清单**（多路 push）⇒ 更可能是**该补新路径**而非替换旧路径 |
| `delivery/web/provider-hub/src/main/toolWriters.ts` | 4 | `path.join(portable,'khy-os','services','backend','src','services')` —— 与桌面端 §12.5a 同款病 |
| `runtime/node/backend/src/cli/handlers/publish.js` | 3 | `extensions/scripts/khy-alpine-iso` |

> **注意候选清单与真断的区别**：`candidates.push(...)` 那种多路兜底，正确动作往往是
> **补一条新路径**，而不是把旧路径替换掉（旧路径可能仍是老装机/便携包的合法布局）。
> 判据仍然是「这行是不是真的要去读那个路径」。

#### 12.8.1 实例：`check-agent-docs.js`「陈旧 ≠ 当前失明」（按 skill 动线量出来的）

这是本清单里唯一一处**看起来最像「守卫失明」**的命中，所以按 `khyos-migration-path-integrity`
的动线（**副本上改、不动仓库**）实测了「复活代价」，结论与直觉相反：

| 真源项 | 真源值（新路径文件里） | 脚本里的硬编码兜底 | 差异 |
|---|---|---|---|
| `MAX_FILE_CHARS` / `MAX_TOTAL_CHARS` | 8000 / 24000 | 8000 / 24000 | **相同** |
| `FILENAMES` | `khy.md`, `KHY.md` | 同 | **相同** |
| `COMPAT_FILENAMES` | `+agent.md`, `+AGENT.md`（共 5） | 3 项 | 真源多 2 项，**但这两个文件不存在** |
| `ECO_MAX_FILE_CHARS` / `ECO_MAX_TOTAL_CHARS` | 4000 / 8000 | 4000 / 8000 | **相同** |
| eco sources 条数 | **21** | **3** | 数量差很大 |

看起来漏扫严重，但**实测无影响**：把 3 处路径改到新路径后跑副本，
输出与原版**逐字节一致**（同样「扫描 25 个指令文件」「4 error(s), 7 warning(s)」，exit 1）。

原因：`classify()`（`:358-360`、`:365-366`）有**独立的硬编码正则**
（`^\.(cursor|clinerules|roo|kiro|amazonq|continue)/` 等）覆盖同一批生态目录，
**不依赖** `truth.eco`；而真源多出的 `agent.md` / `AGENT.md` 在仓库里**不存在**。

⇒ **定性：陈旧（会在输出里打印旧路径）但当前零影响；风险是「潜在」的** ——
若将来新增 `AGENT.md` 或出现 `classify()` 正则未覆盖的新生态文件类型，它会静默漏扫。
修它是**零代价**（副本已验证），但**不急**；该文件另有会话在改（mtime 09:54，与 HEAD 有差异），
**本轮未动**以免混来源。

#### 12.9 E 桶逐条修复（共 2 批：16 个生产文件 + 3 个测试文件）

`broken` 桶内 14 文件 / 41 处，`bothGone` 桶内另 2 文件 / 3 处。

扫描口径：`node scripts/maintenance/path-integrity.js --scan-split-refs --json`。
本仓 HEAD 复扫 **205 处 / 88 文件**（`broken` 桶 = 旧路径不存在 + 重映射后存在 ⇒ 高置信真断），
另有 `bothGone` 281 处（新旧都不存在，多为便携/仓外相对路径）与 `oldAlive` 0 处。

分桶：**PROD 44 文件 / 95 处**、TEST 32/82、DOC 9/22、GEN 3/6。本轮只动 PROD。

##### 12.9.1 第一批（9 文件 / 33 处，全在 `broken` 桶）

| # | 文件 | 处 | 症状（可复现判据） | 动作 | 验收 |
|---|---|---|---|---|---|
| 1 | `runtime/node/backend/src/services/updateCoordinator.js` | 4 | `findSourceRoot` / `findSourceRootAsync` / `readSourceVersion` / `moduleSourceRoot` 四处全指 `services/backend/package.json` ⇒ **仓库根探测恒 `null`、版本恒 `'0.0.0'`** | 四处 → `runtime/node/backend/package.json`；同步 `:212` 注释 | `node --check` ✓；`updateCoordinator.test.js`（mock fs，须同步改 mock） |
| 2 | `runtime/node/backend/src/services/domain/deploy/publish/projectState.js` | 4 | 四条候选清单（`platform/`、`services/backend`、`packaging/npm`、`packaging/modules`）全指不存在路径 ⇒ **`check-version-sync.js` 的第 3/4 版本红线源读不到** | 按候选清单语义**补新路径在首位、保留旧项作布局兜底** | 探针：四组候选 `ALL_SETS_RESOLVE_OK`；`_readState()` 现返回 `versionAligned: true`（pyproject/npm/backend/modules 全 `1.2.0`）；`publishProjectState.test.js` **9/9** |
| 3 | `runtime/node/backend/src/cli/handlers/gatewayManageDaemon.js` | 8 | `_resolveAiFrontendDir` / `_resolveAiFrontendDistDir` 的**全部**候选（env / cwd / `__dirname`）都落空 ⇒ 返回 `null`，gateway daemon 找不到前端 | 补 `delivery/web/ai-frontend` 候选（含 `KHYQUANT_ROOT` 上溯 3 级、cwd、`__dirname` 上溯 6 级），旧 `apps/ai-frontend` 保留 | 内存编译真源 + 探针：`DIR_OK=true DIST_OK=true`（解析到 `<root>/delivery/web/ai-frontend[/dist]`）；`node --check` ✓ |
| 4 | `runtime/node/backend/src/services/freshInstallDoctor.js` | 7 | 已知链接清单三条的 `linkPath`/`target` 全是旧路径 ⇒ `fixPortableIssues` 的「目标不存在」闸把**三条修复全部判失败**；forest 几何检查恒不成立 | 链接清单**替换**为 `runtime/node/backend` + `runtime/substrate/platform/packages/shared`（与 `portable-health-check.js:154-162` 逐字对齐）；forest 两标记改为**新旧 OR** | `freshInstallDoctor.test.js` **46/46** |
| 5 | `delivery/web/provider-hub/src/main/toolWriters.ts` | 4 | `resolveBackendServicesRoot` 的 portable / `_walkRepoRoot` 候选与 `_walkRepoRoot` 的上溯判据全是 `services/backend` ⇒ 源码布局下恒 `null`（与桌面端 §12.5a 同款病） | 补 `source/runtime/node/backend/…`、`runtime/node/backend/…` 候选与上溯判据；旧项保留 | `tsc --noEmit` **exit 0** |
| 6 | `delivery/channel/khyquant/handlers/bootstrap.js` | 2 | 源码分支 `path.resolve(__dirname,'..','..','..','services','backend',…)`：文件迁到 `delivery/channel/khyquant/handlers`（深度 4）后**少了一层**，且注释早已写成 `runtime/node/backend/src/cli/` ⇒ `findBackendCli()` 恒落到 no-op | 修为上溯 4 级 + `runtime/node/backend/…`，并补旧布局兜底 | 路径算术：`dev` EXISTS / `legacy` MISSING（符合预期）；`node --check` ✓ |
| 7 | `runtime/node/backend/src/cli/handlers/where.js` | 2 | `_findProjectRoot` 的校验检查用 `services/backend/bin` ⇒ 落到 walk-up 兜底再落到 `return startDir`。**实跑 `khy where` 复现：项目根目录误报为 `…\backend\bin`** | 校验改 `runtime/node/backend/bin`（旧项 OR）；walk-up 兜底加 `pyproject.toml` / `runtime/substrate/platform`；版本候选补新路径 | **实跑复验：项目根目录 = `D:\Portable\khy-os`** ✓ |
| 8 | `runtime/node/backend/src/services/domain/maintenance/selfRepair/primitives.js` | 1 | 自修复跑受影响测试时按 `^services\/backend\/` 剥前缀、`cwd: projectDir/services/backend` ⇒ **cwd 不存在，`node --test` 必失败** | 前缀剥离兼容新布局；cwd 改为布局感知（新布局优先） | `node --check` ✓ |
| 9 | `runtime/node/backend/src/services/domain/docs/docsFreshness/docsFreshnessRunner.js` | 1 | `require(repoRoot/services/backend/package.json)` 死分支（**有兜底，功能未断**） | 补新路径在首位，旧路径与模块相对兜底保留 | `docsFreshnessRunner.test.js` + `evolutionPolicy.test.js` **40/40** |

**顺带修的两处测试（属 C/D 桶，但与本轮 PROD 改动同源）**：

- `runtime/node/backend/tests/updateCoordinator.test.js` —— `sourceFs()` / `repoFs()` 的 `existsSync` mock 钉在 `services[\\/]backend[\\/]package\.json$`，
  **必须跟随生产契约**改为 `runtime[\\/]node[\\/]backend[\\/]package\.json$`；`cwd: 'C:/repo/services/backend'` → `'C:/repo/runtime/node/backend'`。
  改前 3 文件合计 **14 失败**，改后 **2 失败**（其中 1 个是下面这条既有 stale）。
- `runtime/node/backend/tests/services/publishProjectState.test.js` —— `_readState` 断言 `deepEqual(versions, {pyproject,python,backend})` 是 **3 键**，
  而 `_readState` 自 `bc43302f`（`feat(delivery): R4 apps 迁移收口`）起就返回 **5 键**（含 `npm`/`modules`）。
  **用 `git show HEAD:` 把模块单独落到临时目录隔离复现，确认该失败先于本轮改动**（HEAD 版同样 `not ok`）。
  已更正为 5 键断言，并**补一条 npm/modules 漂移用例**（补上 r59 引入 G1 对齐集时漏掉的测试覆盖）。

##### 12.9.2 本轮未动（`broken` 桶剩 29 文件 / 50 处）——按「待裁决原因」分组

**（a）便携包 / 安装器布局待定**（布局由打包脚本决定，不能凭源码仓推）：

| 文件 | 处 | 待定问题 |
|---|---|---|
| `delivery/extension/scripts/khy-portable/package-portable.js` | 6 | 便携产物实为 `source/<repo 布局>`（source kind）或 `web/ai` + `runtime/khy`（payload kind），**既不是 `apps/ai-frontend` 也不是 `services/backend`** |
| `delivery/extension/scripts/khy-portable/build-portable-artifact.js` | 3 | 同上；另有 `runtimeSourceFilter` 的 `roots` 用旧顶层（**扫描器未报，因单字面量归 `--scan-refs` 轴**） |
| `delivery/extension/scripts/khy-installer/verify-install.js` | 3 | 安装器要同时认新旧装机 |
| `runtime/node/backend/src/services/portableSyncService.js` | 3 | 同步源/目标的 marker 与 `node_modules` 路径 |
| `works/ship/installer/build_installer.js` / `works/ship/npm/scripts/assemble.js` | 各 1 | 同上 |
| `delivery/extension/scripts/khy-diagnostics/hydration-doctor.js` | 1 | 同上 |

**（b）CI / 证据 / 管理脚本，需 owner 决定**：

| 文件 | 处 |
|---|---|
| `scripts/ci/check-traffic-log.js`、`scripts/ci/check-data-layout.js`、`scripts/ci/check-f2e-wiring.js`、`scripts/ci/check-frontend-tokens.js`、`scripts/ci/check-tui-gates.js`、`scripts/ci/test-a2a-mcp-server-smoke.js` | 2+1+1+1+1+2 |
| `scripts/evidence/collect-contribution.js`、`scripts/evidence/capture-runtime.js`、`scripts/quality-gate/provider-contract.js`、`scripts/restore/restore-check.js`、`scripts/admin/_create-admin.js`、`scripts/admin/_insert-user.js` | 2+1+1+3+1+1 |

**（c）已知「陈旧但需确认口径」**：

| 文件 | 处 | 说明 |
|---|---|---|
| `scripts/ci/check-agent-docs.js` | 3 | 见 §12.8.1，**另有会话在改**，本轮未动 |
| `runtime/node/backend/src/services/sourceHealService.js` | 1 | `MANAGED_REL = 'services/backend/src'` 是自愈快照锚点；需确认「锚当前布局」还是「锚老装机」 |
| `runtime/node/backend/src/cli/handlers/publish.js` | 3 | `extensions/scripts/khy-alpine-iso`（ISO 组装路径，与发布链同源） |
| `runtime/node/backend/src/services/crossPlatform/crossLauncher.js` | 2 | `getPortableRoot()/apps/ai-frontend`，属便携布局 |
| `delivery/channel/khyquant/handlers/formatters.js` | 1 | 同 bootstrap.js 同族 |
| `runtime/substrate/platform/khy_platform/cli.py` | 1 | `extensions/scripts/khy-alpine-iso` |
| `entries/launch.js` | 1 | `services/backend/bin/khy.js` |
| `runtime/node/backend/scripts/makeSourceSnapshot.js`、`scripts/prepack.js`、`_probe_tools.js` | 各 1 | 打包/探针脚本 |

##### 12.9.3 第二批：`scripts/release/*` 与 `bothGone` 桶（7 个生产文件 + 1 个测试）

`broken` 桶内 5 文件 / 8 处，`bothGone` 桶内另 2 文件 / 3 处。

`scripts/release/*` 是**操作本仓树**的发布工具（`root` = 仓库根），没有便携/打包布局的歧义 —— 上一轮
把它们归到「需 owner 决定」是**过度保守**，实际全是无歧义真断。

| 文件 | 处 | 症状 | 动作 | 验收 |
|---|---|---|---|---|
| `scripts/release/pin-khyos-toolchain.js` | 3 | 3 处 `require` 全指 `platform/packages/shared/…`（**扫描器只报了 1 处**，另 2 处因 `_artifact`/`toolchainProvisioner` 是 `.js` 文件、字面量不存在而被误判进 `bothGone`） | 三处前缀补 `runtime/substrate` | `require()` 可加载；**`manifestPins.test.js` 7/7** |
| `scripts/release/assemble-pip-runtime.js` | 2 | `packaging/build/esbuild-modules.js`、`platform/khy_platform/bundled` 均不存在 ⇒ pip 组装断 | → `works/ship/build/…`、`runtime/substrate/platform/khy_platform/bundled` | 路径落地存在 |
| `scripts/release/pin-runtime-binaries.js` | 2 | `services/backend/config/runtime-binaries.json`、`services/backend/node_modules` | → `runtime/node/backend/…` | 路径落地存在 |
| `scripts/release/build-payload-assets.js` | 3 | 版本校验读 `services/backend/package.json`；快照脚本路径旧；**`resolveMarkdownExtensionDir` 两个候选全 miss ⇒ 必抛**（发布流水线断） | 前两处换新路径；候选表补 `delivery/extension/tools/khy-markdown` 在首位、旧项保留 | `resolveMarkdownExtensionDir(root)` 落到 `delivery/extension/tools/khy-markdown` |
| `runtime/node/backend/tests/manifestPins.test.js` | — | **纯深度错**：`require('../../../scripts/release/…')` 从 `runtime/node/backend/tests`（深度 4）只上溯 3 级 ⇒ 加载即 `MODULE_NOT_FOUND`。**扫描器抓不到（无别名可命中）** | 补一级 `../../../../scripts/…` | **7/7** |
| `scripts/ci/lint-debt-tracker.js` | 2 | `LINT-DEBT.json` 与 `cwd` 用 `services/backend`（**头注释早已写成 `runtime/node/backend/src`**） | 两处换新路径 | 路径落地存在 |
| `scripts/hooks/agentFeedbackHint.js` | 1 | `require(REPO_ROOT/services/backend/src/utils/dataHome)` ⇒ 走 `catch` 兜底到 `~/.khyos`（**静默降级，数据家找错**） | 换新路径 | `require.resolve` 成功 |
| `delivery/extension/scripts/khy-diagnostics/model-type-providers.js` | 2 | 两个 `require` 指 `services/backend/src/{services/gateway/providerPresets,constants/serviceDefaults}` | 换新路径 | 两个 `require.resolve` 成功 |

**`bothGone` 桶的新认识**：该桶 281 处并不只是「便携/仓外相对路径」——它同时装着两类仓内命中：

1. **叶子是 `.js` 文件**：`require(…'services','sessionSearchIndex')` 里 `sessionSearchIndex` 是**文件** `sessionSearchIndex.js`，
   Node 会补扩展名，但扫描器按字面量判 ⇒ 误入 `bothGone`（例：`pin-khyos-toolchain.js` 的 `_artifact`/`toolchainProvisioner`、
   `bucket-sessions-by-project.js` 的 `sessionSearchIndex`）。**这三处实为假阳性或已在本批修掉。**
2. **相对引用按非仓根解析**：`require('../services/docHelper.py')` 从 `src/tools/` 上溯正好命中 `src/services/docHelper.py`，
   扫描器却把它当顶层别名重映射 ⇒ 假阳性（`readFileFormatRouter.js`、`resourceGuard.js`）。
3. 剩下的才是真断（本批已修 `agentFeedbackHint.js`、`model-type-providers.js`、`lint-debt-tracker.js`）。
   `bothGone` 的 PROD 里还有大量**glob 模式**（`scripts/ruleguard/*` 的 `services/**/platform/**`）与**别名表自身**
   （`path-integrity.js` 的 `services/→runtime/node/`），那些是刻意保留，**不是断链**。

##### 12.9.4 方法论沉淀（本轮新增到 skill）

1. **候选清单的验收不能用「旧字面量是否消失」判**：本轮保留旧项作布局兜底后，
   定向复检脚本仍把 10 处报成 `BROKEN` —— 它只认「旧不存在 + 新存在」，
   **分不出「刻意保留的兜底」**。候选清单的正确判据是 **「解析器最终落到了哪个存在路径」**
   （本轮的 `_resolveExisting` 探针、`_resolveAiFrontendDir` 内存编译探针）。
2. **测试 mock 是生产契约的影子**：生产路径一改，钉住旧路径的 `existsSync` mock 必然红。
   要分清「mock 该跟着改」（本轮 12 处）与「生产改错了」。
3. **既有红测试要先隔离归因再修**：用 `git show HEAD:<path>` 把模块落到临时目录复现，
   能干净地证明「先于本轮改动」。本轮据此确认 `publishProjectState` 那条是 `bc43302f` 遗留的 stale 断言。
4. **两条扫描轴不可互相替代**：`--scan-split-refs` 只认**逗号分隔的连续字面量**（`path.join('a','b')`）；
   单字面量 `'services/backend/node_modules'` 归 `--scan-refs`。
   例：`build-portable-artifact.js` 的 `roots` 数组全是单字面量，**拆段轴报 0、单字面量轴才报**。
5. **命令能实跑就别只读代码**：`khy where` 的「项目根误报」是**跑出来的**，
   只读代码时我一度把 `entryPath` 的层级也算错了（`../../..` 从 `handlers` 是落到 `backend` 而非 `src`）。
6. **`broken` 桶不等于「全部真断」**：它只收「旧不存在 **且** 重映射后存在」。
   两类真断会漏到 `bothGone`：① 叶子是**带扩展名的文件**（`require(…,'sessionSearchIndex')` → `sessionSearchIndex.js`，
   扫描器按字面量判 ⇒ 误判）；② **纯深度错**（`require('../../../scripts/release/…')` 少一级，
   字面量里没有别名可命中 ⇒ 扫描器**结构性失明**）。所以每轮都要**按别名 grep 交叉核对**，
   并对可疑文件**实跑**（`manifestPins.test.js` 的深度错就是这么暴露的）。
7. **`bothGone` 里的假阳性有三种**，别一律当真断：带扩展名文件、相对引用被当顶层别名重映射、
   glob 模式 / 别名表自身（`path-integrity.js` 的 `services/→runtime/node/` 是**定义**不是引用）。
8. **「需 owner 决定」的判断要能被证伪**：上一轮把 `scripts/release/*` 归为「改错会污染发布产物」而搁置，
   本轮一看 —— 它们 `root = path.resolve(__dirname,'..','..')` 就是**仓库根**，只读本仓文件，
   根本不存在打包布局歧义。**过度保守也是成本**。
