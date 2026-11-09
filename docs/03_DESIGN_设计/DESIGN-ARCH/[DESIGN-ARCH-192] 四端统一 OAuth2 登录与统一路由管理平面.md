<!-- IMPL-STATUS: todo -->
# [DESIGN-ARCH-192] 四端统一 OAuth2 登录与统一路由管理平面

> **需求来源**：用户原话「khyos的四端要支持oauth2的统一登录，统一管理，不要产生歧义」（逐问拆解见 §1）。
> **定位**：四端（网页 / 桌面 / 手机 / 终端）统一 OAuth2 登录 + 统一路由管理平面（= 既有 MCR）的目标形态与落地路径。
> **不替代**既有真源，只声明衔接：`[DESIGN-ARCH-179]`、`[DESIGN-AUTH-002]`、`[DESIGN-ARCH-071]`、`[DESIGN-ARCH-117]`、`[DESIGN-ARCH-185]`/`162`/`181`、`[DESIGN-ARCH-091]`、`[DESIGN-ARCH-190]`、`[DESIGN-API-001]`/`002`、`[DESIGN-PROCESS-002]`，以及**既有统一管理面 MCR**（本文新增的衔接对象，见 §6.0）。
> **状态**：草案 · 待批准（第 4 版；独立复核 16 条意见已逐条并入，处理见「独立复核意见的逐条处理」）。所有验收命令均指向尚不存在的代码，本次**未跑**，不得记为已通过。
> **范围**：backend 单进程内新增 OAuth2 AS 面（`/api/oauth/*` 与 `/.well-known/oauth-authorization-server`）；把既有 MCR 的 HTTP 适配器补挂到 backend；四端登录接入；新增 MCR 资源 `endpoint-registry` / `auth-clients` / `failover-order` / `routing-mode`。
> **不改**：不新增规则 ID（`PROCESS-014` 棘轮已满），本文**不是任何规则的语义真源，因此不携带 `RULES-REGISTRY` 标记**（体例同 `[DESIGN-ARCH-117]`）；不新增顶层命令（`khy manage` / `khy login` / `khy channels` 均为既有）；不新建第二套管理 API；不改 daemon 的 `handleManage*` 鉴权模型；不动 AI 路由算法与四档生效门控（185/162 的 S1 stage 不变）。
> **边界**：khyquant 是独立项目，本文只留「可作为 OAuth2 客户端接入」的接口形态。
> **上游依赖**：`authSessionService` 与 `AuthSession` 模型、`managementRegistry`（MCR 单漏斗）、`apiResponse` 信封与既有 `CODES`、`serviceDefaults` + `backendRuntime` 端口解析、`[DESIGN-PROCESS-002]` 四阶段。
> **调研指针**：证据逐条见「## 证据口径与本次实跑」与「本轮读过的关键行」，全部 `[读]` / `[实查]` 可复核。
> **模板合规**：非借鉴类设计（无外部项目实现移植），`[DESIGN-SOURCING-001]` B 系列模板豁免；与既有机制的衔接声明见 §7。
> **路径时效**：文中路径与实测读数记录于 2026-10-22（E1–E7）；`runtime/node/backend/src/...` 为现行层。

---

## 证据口径与本次实跑

| 标记 | 含义 |
|---|---|
| `[读]` | 本次实际读过的文件与行 |
| `[实查]` | 本次实际运行过的命令（逐条给出） |
| `[勘]` | 六路勘察材料 |

| # | 命令 | 输出 |
|---|---|---|
| E1 | `node scripts/ci/check-delivery-baseline.js --json`（过滤棘轮行） | `routerCommands=248/245 · aliasEntries=591/591 · handlerFiles=161/155 · ruleCount=99/94`，并判「任务面棘轮被突破（只降不升）」⇒ **棘轮今天已超，不能当门** |
| E2 | `node scripts/ci/check-agent-rules.js delivery/mobile/khy-os-client-app/lib` | `No target files found. Use --changed or pass file/directory paths.` ⇒ **该判据今天既没扫到东西也不是 exit 0** |
| E3 | `node scripts/ci/check-agent-rules.js delivery/mobile/khy-os-client-app` | `Summary: 49 error(s), 0 warning(s) across 49 file(s) scanned.`；70 行命中含 `dart_tool` ⇒ 全部来自生成树（与上版一致） |
| E4 | `node scripts/ci/check-delivery-baseline.js --json`（棘轮以外） | 本次只取了棘轮行；**D1–D10 明细未逐条复跑** |
| E5 | `git grep -n "KHY_ACCESS_TOKEN"` / `git grep -rn "Set-Cookie" -- runtime/node/backend` | 前者零命中；后者仅 `tests/utils/toolResultSanitizer.test.js:43` ⇒ 后端无 cookie 写入 |
| E6 | `node -e` 列 MCR 资源目录与 `index.js` | 资源：`users` / `apiKeys` / `dependencies` / `customProviders` / `modelOverrides` / `modelConfig` / `cron`；模块依赖只有 `gatewayEnvFile`/`dataHome`/`apiKeyPool`/`models`/`maskSecret` ⇒ **backend 进程可承载，无需 daemon** |
| E7 | `grep /api/manage runtime/node/backend/server.js` | **零命中** ⇒ MCR 的 Web 适配层只存在于 daemon（9090），dev 代理由「非 daemon 命名空间」默认打到 backend ⇒ `/api/manage` 今天 404 |

**本轮读过的关键行**：`src/services/domain/project/management/managementRegistry.js:1-20`（自陈 `invoke()` 是 CLI 与 Web 共同且唯一入口）；`src/cli/handlers/manage.js:1-14`（`khy manage` 是 MCR CLI 适配层）；`src/services/aiManagementGatewayAdmin.js:1875-1941`（`handleManageList`/`handleManageResource`/`handleManageInvoke`，**函数内无逐 op 鉴权**）；`src/services/aiManagementServer.js:2532-2547`（`/api/manage`、`POST /api/manage/:resource/:op`、`GET /api/manage/:resource`）；`docker-compose.yml:47-50、85-86`（backend 与 ai-backend **同 `JWT_SECRET`**）、`:99`（nginx 反代 9090）、`:112-115`（web 依赖 ai-backend）；`delivery/web/ai-frontend/nginx.conf:1-41`（单一 upstream `ai-backend:9090`；只有 `/`、`/api`、`/ws`）；`server.js:276`（`app.set('trust proxy',1)` 无条件）、`:331`（`PORT_AUTO_RETRY||20`）、`:853`（`listenWithAutoPort(…,'0.0.0.0')`）、`:1402`、`:1417-1418`、`:1428-1430`（**全文无 `module.exports`，require 即启动**）；`src/services/authSessionService.js:222-232`、`:341-355`（legacy 分支）、`:445-457`、`:477-491`；`src/middleware/auth.js:135-173`（401 只有 `{success:false,message}`）；`src/cli/handlers/channels.js:1-12`（只有 `status` / `order` / `order set` / `order reset` / `reset <adapter>`）；`src/cli/routerDispatchTail.js:1000-1026`（`khy login` 是交互账密）；`src/views/Login.vue:175-181`（`?redirect=` 经 `safeRedirectPath`）；`vite.config.js:129-157`（proxy 键：daemon 命名空间、`/api`、`/ws/cross-platform`、`/ws`，**无 `/.well-known`**）；`src/services/aiFrontendLocator.js:272-295`（`discoverKhyFrontend({host='127.0.0.1'})`）。

**未执行**：所有验收命令均指向尚不存在的代码，本次**未跑**，不得记为已通过。

## 独立复核意见的逐条处理

| # | 复核意见 | 处理 | 结论 |
|---|---|---|---|
| 1 | 另造 `/api/management/*`，未与既有 MCR 合并 | **采纳**：**撤销 `/api/management/*`**。管理平面 = MCR；新增资源注册进 `managementRegistry`；HTTP 复用既有 `/api/manage` 形状；AI 路由写入复用既有 `model-config`/`model-overrides` 资源，新增 `failover-order`/`routing-mode` 资源而不新开路径；Web 适配器在 backend 挂一份（同一 registry 模块、同一资源），消除跨服务令牌验证 | §6.0–§6.6 全面改写 |
| 2 | legacy JWT（无 `sessionId`）被无条件接受，且两 issuer 共享 `JWT_SECRET` | **采纳**：把 legacy 分支显式建模（`grantType:'legacy'`、`scopes:[]`、`clientId:'legacy'`），S1 记录 / S2 加头 / S3 对 scope 类端点**默认拒绝**；加 `iss`/`aud`/`tokenType` 断言；**拆 secret** 列为硬要求（`KHY_BACKEND_JWT_SECRET` / `AI_BACKEND_JWT_SECRET`），未拆前不得视为可信身份 | §4.2、§4.5、§4.8 铁律 11、§9.10、Q6/Q11 |
| 3 | 容器态 nginx 把 `/api` 全量打到 ai-backend:9090，设计声称可用 | **采纳**：S0/S1 就增加**精确前缀** location：`/api/oauth`、`/api/auth`、`/api/manage` → `backend:3000`，其余 `/api` 保持 `ai-backend:9090`；`web` profile 增加对 `backend` 依赖；三态表按事实改写 | §3.3 B10、§4.4(c′)、§8 S1 |
| 4 | Q4#8「临时造 dist 再挂载」不可实现（无 `module.exports`、require 即 listen） | **采纳**：S0 增加「AS 路由注册与 dist 解析抽成可注入工厂」前置；Q4#8 拆为「工厂单测 + 真实启动冒烟」两段，不再要求导出 app | §4.4(a′)、§8 S0、Q4#8 |
| 5 | `/api/auth/me`、`/api/auth/sessions`、`/api/ai/*` 今天已 401，S1「只记录」不可达；401 体无 `error.code` | **采纳**：§4.5 增加「现状」列（这三个已是 S3）；S1 明确只对**新增**端点只记录；并把「统一 `sendAuthFailure` 输出 `error.code`」列为 S1 显式改动 + 影响面清单 | §4.5、§4.7、§8 S1 |
| 6 | `browserFacingOrigin` 被当服务端唯一值；`discoverKhyFrontend` 只探 loopback | **采纳**：改为**按消费者解析** `browserFacingOrigin(consumer)`；`capabilities.oauthServer.issuers[]` 返回 `{kind,url}` 列表由客户端自选；远程消费者**必须拒绝 loopback** 并回落到 LAN（`getLanIPv4()`，`[勘]` `handlers/mobile.js:42/:265`） | §4.4(c′)、§5.2–§5.4 |
| 7 | 铁律 10 与自己第 4 级兜底矛盾 | **采纳**：把第 4 级限定为「后端自托管 dist 且请求来自 loopback」并附 `// khy-allow-RUNTIME-001: <理由>` 豁免注释；铁律 10 改写成可机检形式（禁止 `BACKEND_HOST/PORT` 拼**非 loopback** 地址；唯一豁免点显式标注） | §4.4(c′)、§4.8.10 |
| 8 | AS 内部地址用静态常量，但端口会自动顺延 | **采纳**：所有内部调用与机检命令改为 `backendRuntime.readBackendRuntime().apiPort` 优先、`serviceDefaults` 兜底（与 `handlers/mobile.js:118-129` 同一解析口径） | §4.3、§4.7、Q4#1 |
| 9 | `/.well-known` 不在 dev/nginx 代理里 | **采纳**：vite 与 nginx 都增加**精确路径** `/.well-known/oauth-authorization-server` 转发（不整段转发 `/.well-known`，避免与 A2A agent-card 混路），并加内容类型断言 | §4.4(a)、§8 S0/S1、Q4#9 |
| 10 | `/api/oauth/activate` 未登录后「登录后回跳」机制未定义 | **采纳**：`/api/oauth/activate` → 302 `/login?redirect=<encodeURIComponent('/api/oauth/activate?user_code=…')>`，复用既有 `safeRedirectPath`；与 `request_id` 的优先级写明；Q4#6 补该往返用例 | §4.4(a)(e)、Q4#10 |
| 11 | 交付棘轮今天已超（248/245、161/155、99/94） | **采纳**：S0 记录快照（本次实测值），S2/S3 判据改为「不高于开工快照」；并声明存量超额不归因本次工作、须另立退役任务 | §8 S0/S2/S3 |
| 12 | `check-agent-rules …/lib` 今天 `No target files found` | **采纳**：判据改为 `--include-dart` 下期望，并先断言「扫描文件数 > 0」 | §8 S3、Q4#12 |
| 13 | `trust proxy=1` 无条件 + XFF 可伪造 | **采纳**：`KHY_TRUST_PROXY` 显式开关；`user_code` 限流键改为 `<user_code> + socket 地址`，XFF 仅作审计且标注可信条件 | §4.4(e)、§8 S1、R19 |
| 14 | web 的 `redirect_uri` 用相对路径违反 RFC 6749 | **采纳**：客户端传**绝对** URI；AS 校验 scheme+host 等于**本次请求所在的浏览器面 origin**（动态比对，不落静态白名单），path 精确；不匹配只渲染错误页、绝不 302 | §4.3、§4.4(c)、§4.8.4 |
| 15 | `khy channels show/open/set` 不存在 | **采纳**：终端管理入口改为既有 `khy manage <resource> <op>`；`khy channels` 只保留既有 `status` / `order set` / `order reset` / `reset`；不新增子命令 | §6.4 |
| 16 | `khy login` 账密语义被隐式改成设备码 | **采纳**：`khy login` 保持交互账密（AS 的一种身份源）；设备码走显式 **flag** `khy login --device`（flag 不计入 `routerCommands`，实施时用基线复核） | §5.4、Q4#1、Q9 |

---

## 1. 需求五问

### Q1 谁用？

| 角色 | 端 | 要用什么 |
|---|---|---|
| 普通使用者 | 网页/桌面/手机 | 同一账号登录四端，不必每端记一套密码 |
| 运维/管理员 | 网页/桌面/终端 | 一处看清「哪条请求走了哪个通道、哪段前缀归谁、四端各几个会话」，并能改 AI 路由策略 |
| 脚本/CI | 终端 | 无浏览器也能拿到**可撤销**凭据（设备码或既有 API key） |
| 移动端使用者 | 手机 | 先配对（存端点 + 浏览器面 origin），再登录（取令牌） |

> `source:` 用户原话「khyos的四端要支持oauth2的统一登录，统一管理，不要产生歧义」；角色拆分据 `[勘]`。

### Q2 什么时候用？

1. 首次在某一端使用**需要身份**的功能（跨端配置、管理平面、会话审计）；
2. 令牌过期或服务端吊销后（`[勘]` web 已有 401→refresh；终端无 refresh、logout 不吊销 `cliAuthService.js:551`）；
3. 要跨端共享同一份 AI 路由策略时（`[勘]` 三处写入平面互不相通）；
4. 从局域网/远程访问时（`[勘]` `server.js:853` 监听 `0.0.0.0`；`handlers/mobile.js:211-255` 配对分支无鉴权提示）。

### Q3 现在的替代做法是什么？

| 端 | 现状 | 代价 |
|---|---|---|
| 网页 | 密码 → localStorage（`[勘]` `stores/user.js:30-45`） | refresh 在 localStorage，违背 `[读]` `AUTH-002` §8.1 |
| 桌面 | `LoginPage.tsx:22-25` 假登录、`App.tsx` 未引用（`[勘]`） | 无闸门、无会话层 |
| 手机 | 只有配对存 `apiBaseUrl`（`[勘]` `khyos_api.dart:104`） | remote 永远 `Bearer null`，401 被显示成「连接失败」 |
| 终端 | 交互账密 + 离线 PBKDF2（`[读]` `routerDispatchTail.js:1000-1026`、`[勘]` `cliAuthService.js:59-65`） | 无 OAuth；本机会话无服务端令牌 |
| 管理 | **MCR 已存在**（`[读]` `managementRegistry.js:1-20`、`khy manage`、`/api/manage`），但：dev 代理把 `/api/manage` 打到 backend（`[实查 E7]` 零挂载 ⇒ 404）；容器态 `/api` 全量打 daemon（`[读]` `nginx.conf:23-32`） | 同一概念的「管理面」在不同拓扑下落到不同进程；AI 路由写入虽有 `/api/ai-gateway/*` 走 MCR，但与「端点/会话」无统一入口 |

### Q4 成功长什么样？（每条标阶段；全部未跑）

| # | 判据 | 命令 | 期望 | 阶段/前置 |
|---|---|---|---|---|
| 1 | 四端各完成一次**服务端**登录后列出四条会话 | `node -e "const p=require('path'),fs=require('fs');const rd=require('./runtime/node/backend/src/utils/backendRuntime').readBackendRuntime();const d=require('./runtime/node/backend/src/constants/serviceDefaults');const port=(rd&&rd.apiPort)||d.BACKEND_PORT;const {getAppHome}=require('./runtime/node/backend/src/utils/dataHome');const f=p.join(getAppHome(),'session.json');if(!fs.existsSync(f)){console.log('NO_LOCAL_SESSION：先运行 khy login --device');process.exit(1)}const s=JSON.parse(fs.readFileSync(f,'utf8'));if(!s.serverToken){console.log('LOCAL_ONLY_SESSION：离线兜底会话，不产生服务端令牌，不算判据失败');process.exit(0)}fetch(`http://127.0.0.1:${port}/api/auth/sessions`,{headers:{Authorization:'Bearer '+s.serverToken}}).then(r=>r.json()).then(j=>console.log(j.data.sessions.map(x=>x.clientId).sort().join(',')))"` | `cli,desktop,mobile,web` | **S1 末**（`clientId` 列落地）；前置：`khy login --device` 走 AS。端口取运行时值（`[读]` `server.js:331/:853` 会顺延）；会话形状据 `[读]` `auth.js:614-618` |
| 1b | 「本机会话」可归因 | 用无 `serverToken` 的会话调 `GET /api/manage` + 看 `khy status` | **S3**：401 `AUTH_REQUIRED`，hint 明说「本机会话，需 `khy login`」；CLI 文案同样区分 | S3 |
| 2 | 能力发现只从单一真源出；issuer 按消费者给候选 | `node -e` 取 `/api/auth/capabilities` | `oauthServer.issuers` 含 `{kind:'loopback'}` 与（LAN 可达时）`{kind:'lan'}`；未配 GitHub/Gitee 时 `oauthProviders: []`；`grants` 恰三项；`pkce:['S256']` | S1 |
| 3 | 管理面未登录可归因 | 无凭据 `GET /api/manage` | **S3**：401 且**响应体含 `error.code='AUTH_REQUIRED'`**（S1 先把 `sendAuthFailure` 统一成该形状）；S1 对新增端点仅记录；S2 加 `X-Khy-Scope-Warning` | S1（形状）/S3（强制） |
| 4 | 端点登记表无漂移 | `node scripts/ci/audit-endpoint-registry.js`；`GET /api/manage/endpoint-registry` | S1：`devDiff` 可非 0，只记录，exit 0；S2：`devDiff=0`；**S3：`drift.length===0` 且 `devDiff===0`** | 见左 |
| 5 | 新克隆可编译 | `git check-ignore -v …/AndroidManifest.xml`；`(git ls-files --others --exclude-standard delivery/mobile/khy-os-client-app \| Measure-Object).Count` | exit 1 无输出；`0` | S0 |
| 6 | 重放/未认证被拒；activate 往返 | `node --test runtime/node/backend/tests/services/oauth/` | `code`/`request_id`/`user_code` 重放→400；无 `khy_as` 的 `device_verify`→401；`plain`→400；**无登录访问 `/api/oauth/activate?user_code=X` → 302 `/login?redirect=…activate…`，登录后回跳并批准** | S1 |
| 7 | cookie Path 不变量 | `node --test …/cookiePathInvariant.test.js` | `khy_as`/`khy_ap` Path=`/api`；`khy_rt` Path=`/api/oauth`；每个 Path 是其读取端点路径的公共前缀 | S1 |
| 8 | 挂载顺序（两段） | (a) `node --test …/oauthMount.test.js`（注入临时 dist 到工厂）；(b) 启动后 `GET /api/oauth/activate` | (a) dist 存在时 activate 仍 HTML、token 不被 404 吃；(b) 200 + `text/html` | S0 工厂前置后 / S1 冒烟 |
| 9 | RFC 8414 元数据经代理可达且是 JSON | `curl -sI <browserFacingOrigin>/.well-known/oauth-authorization-server` | 200 且 `content-type: application/json`（**不是** `text/html`——不能被 SPA fallback 吃掉） | S1 |
| 10 | 设备页登录往返 | 无 `khy_as` 访问 `/api/oauth/activate?user_code=X` | 302 到 `/login?redirect=%2Fapi%2Foauth%2Factivate%3Fuser_code%3DX`；`safeRedirectPath` 放行（同源相对路径） | S1 |
| 11 | 棘轮不恶化 | `node scripts/ci/check-delivery-baseline.js --json` | `routerCommands<=248`、`aliasEntries<=591`、`handlerFiles<=161`、`ruleCount<=99`（**开工快照**，非 245/155/94） | S0 记录 / S2 复核 |
| 12 | Dart 扫描真的扫到文件 | `node scripts/ci/check-agent-rules.js delivery/mobile/khy-os-client-app/lib --include-dart` | `Summary: 0 error(s) … across N file(s) scanned` 且 **N>0** | S3 |
| 13 | 设备码限流不依赖 `req.ip` | 单测：轮换 `X-Forwarded-For` 仍计数 | 第 6 次尝试仍 `RATE_LIMITED` | S1 |

### Q5 不做会怎样？

| 不做 | 后果 |
|---|---|
| 不统一登录 | 五套登录/令牌实现继续并存；终端 AI 主链路不带身份 |
| **不与 MCR 合并** | 「统一管理」先分裂成两套：MCR 已有 `khy manage` + `/api/manage` + parity guard，本设计再造一套 ⇒ CLI 与 Web 永不矛盾的物理点被绕开 |
| **不处理 legacy JWT** | 无 `sessionId` 的令牌（含 ai-backend 签发、与 backend 共享 secret）被当有效身份，且无 `clientId`/`scopes`；scope 模型一上线就漏 |
| **不改容器 nginx** | `--profile web` 下 `/api/oauth`、`/api/auth`、`/api/manage` 全落 daemon ⇒ 登录与管理在容器态不可用 |
| 不定义浏览器面 origin（按消费者） | 手机拿到 `127.0.0.1` 的登录页地址，打不开；或与后端不同源，`khy_as` 永不闭环 |
| 不把 cookie Path 与消费端点对齐 | 登录闭环恒失败（第 2 版评审 #1 即此） |
| 不建设备验证面 | 设备码无人批准，`khy login --device` 永远超时 |
| 不做 S0 | `[实查 E3]` 手机目录 49 error 全在生成树；`.gitignore:40` 让新克隆出不了 APK |

---

## 2. 术语表

### 2.1 命名硬规则

1. **「路由」必须带限定语**：只允许 **端点路由** / **AI 路由** / **导航路由**。裸 `route`/`routes` 不得作标识符、API 路径、文件名、scope 名（`ai-routes` 这类限定复合词除外）。注：本版已把 API 收敛到 `/api/manage`，不再有 `/api/management/*`。
2. **「配对」≠「登录」；「会话」≠「令牌」；「声明」≠「生效」；「待授权请求句柄」≠「凭证」。**
3. **origin 有两个且必须分开叫**：**浏览器面 origin**（`browserFacingOrigin`，且**按消费者解析**）与 **AS 内部地址**（`asInternalOrigin`）。给浏览器用的地址只允许从前者的解析结果来。
4. **cookie 的 `Path` 必须是所有读取它的端点路径的公共前缀**（单测断言，Q4#7）。
5. **「管理平面」只有一名字一落点**：`managementPlane` = MCR（`managementRegistry`），HTTP 形状 `/api/manage`，CLI 形状 `khy manage`。不另起 `/api/management`。

### 2.2 词汇表

| 中文名 | 标识符 | 定义 | 禁止/易混 |
|---|---|---|---|
| 端点 | `endpoint` | 协议级 URL | 「路由」「地址」 |
| 浏览器面 origin | `browserFacingOrigin(consumer)` | 该消费者浏览器实际访问并承载 cookie 的 origin（本机=loopback；远程=LAN/反代域名） | 「后端地址」 |
| AS 内部地址 | `asInternalOrigin` | 运行时发现的后端监听地址（`readBackendRuntime().apiPort` 优先） | 「issuer」 |
| 签发者 | `issuer` | 浏览器面 origin，出现在 `oauthServer.issuers[]` 与 `verification_uri` | 「后端地址」 |
| **管理平面 / MCR** | `managementPlane` / `managementRegistry` | 既有「可管理资源注册中心」单漏斗；CLI 与 Web 共同唯一入口 | 「控制台」「管理 API」 |
| 可管理资源 | `managementResource` | MCR 里注册的一项（如 `model-config` / `api-keys`） | 「管理端点」 |
| 资源操作 | `managementOp` | 资源契约声明的 op（如 `get` / `set` / `list`） | 「动词」 |
| 前缀归属 | `namespaceOwner` | 哪段前缀归哪个服务 | 「路由表」 |
| 通道 | `channel` | `[DESIGN-ARCH-071]` CH-1…5 | 「路由」 |
| AI 路由 / 策略 / 事实 | `aiRoute` / `routingPolicy` / `routeFact` | 同前 | 同前 |
| 声明 / 生效配置 | `declaredConfig` / `effectiveConfig` | 同前 | 同前 |
| 导航路由 | `navigationRoute` | 端内页面路由 | 本文不管 |
| 登录 / 配对 | `login` / `pairing` | 取令牌 / 存端点 | 不得互换 |
| 身份源 / 授权服务器 | `identityProvider` / `authorizationServer` | 认证方式 / 签发方 | 方向相反 |
| OAuth2 客户端 | `oauthClient` | 四端各自的 `client_id` | 「身份源」 |
| 浏览器会话 / 令牌会话 | `browserSession` / `tokenSession` | `khy_as` 指向的服务端记录 / `AuthSession` 一行 | 不得混 |
| **legacy 令牌** | `legacyToken` | 无 `sessionId` 的 JWT（`[读]` `authSessionService.js:341-355`）；历史上由任一共享 secret 的签发方产生 | 不得叫「匿名令牌」或默认「有效」 |
| 待授权请求 / 绑定 | `authorizeRequest` / `pendingCookie` | 参数快照 / `khy_ap` | 「登录票据」 |
| 设备验证页 | `activatePage` | `/api/oauth/activate` | 「/activate」 |
| 授权码 / 设备码 / 用户码 | `authorizationCode` / `deviceCode` / `userCode` | 同前 | 后两者不得混 |
| 访问/刷新令牌 | `accessToken` / `refreshToken` | 同前 | 「token」 |
| 权限范围 | `scope` | 令牌能力 | 「角色」 |
| 登录票据 | `loginTicket` | **不引入** | 「授权码」 |

---

## 3. 现状与差距

### 3.1 登录面

| 维度 | 网页 | 桌面 | 手机 | 终端 | 后端（共用底座） |
|---|---|---|---|---|---|
| 现有登录 | 密码→localStorage | 假登录未接线 | 无登录，只有配对 | 交互账密 + 离线兜底 | 密码/扫码/WebAuthn/API key；`oauthProviders: []` |
| 浏览器会话 | 无（`[实查 E5]`） | 不适用 | 不适用 | 不适用 | 无该机制 |
| 令牌校验 | Bearer | 无 | `Bearer null` | Bearer（bootstrap） | Bearer + `X-API-Key`；**legacy 无 `sessionId` 分支恒有效**（`[读]` `:341-355`） |
| 刷新 | 401→刷新→重发 | 无 | 有定义零调用 | 无 `/refresh` 调用 | 轮换有、**复用检测无** |
| 登出 | 只清本地 | 无 | 无 | 只删本地 | 有 `/logout` |

### 3.2 三种「路由」+ 管理面

| 维度 | 网页 | 桌面 | 手机 | 终端 |
|---|---|---|---|---|
| 端点路由（发现） | Vite proxy 主动发现；**浏览器 origin=Vite 端口** | host 按 `KHY_OS_DIR` require | 配对存 `apiBaseUrl`（无浏览器面 origin） | `serviceDefaults` |
| 端点路由（归属） | `DAEMON_ONLY_NAMESPACES` 硬编码 11 条（`[读]` `vite.config.js:38-52`）；容器 `nginx.conf` 单一 upstream | 无 | 无 | 无 |
| AI 路由 | `/api/ai` 代理到 ai-backend | 进程内直调 | standalone 绕开后端 | 进程内直调 |
| **管理面** | 开发态 `/api/ai-gateway/*`、`/api/manage` 经代理落到 backend（后者 404，`[实查 E7]`）；容器态全落 daemon | KeyManager（091） | 无 | `khy manage` / `khy channels` |

### 3.3 阻断级现状（S0 入场券）

| # | 事实 | 证据 | 处置 |
|---|---|---|---|
| B1 | `AndroidManifest.xml` 被 `.gitignore:40` 忽略 | `[勘]` | S0 |
| B2 | 35 个未跟踪文件 | `[勘]` | S0 |
| B3 | 手机无 CI | `[勘]` | S0 |
| B4 | `pubspec.yaml` 不在版本同步 | `[勘]` | Q12 |
| B5 | 两条死端点调用 | `[勘]` | S0 |
| B6 | `CODE_EXTS` 无 `.dart`；`IGNORE_DIRS` 无 `.dart_tool` | `[读]` `check-agent-rules.js:31-38/40-74`；`[实查 E2/E3]` | S3 前置 |
| B7 | 后端 dist 落点指向不存在目录（`[实查]` `dist exists:false`） | `[读]` `server.js:1417-1444` | S0 |
| B8 | 配对载荷无浏览器面 origin；配对分支无鉴权提示 | `[勘]` | S1 |
| **B9** | **MCR 已存在，但 Web 适配层只在 daemon（9090）；backend 无 `/api/manage`，dev 代理默认打到 backend ⇒ 404** | `[实查 E7]`；`[读]` `aiManagementServer.js:2532-2547` | **S1 把同一 registry 的 HTTP 适配器挂到 backend**（§6.0） |
| **B10** | **容器 nginx `/api` 全量→`ai-backend:9090`；`web` profile 只依赖 ai-backend** | `[读]` `nginx.conf:1-4/23-32`、`compose:99/112-115` | **S0/S1 加精确前缀 location + 依赖** |
| **B11** | **`server.js` 无 `module.exports`，require 即 `listen`** | `[读]` 全文 grep；`:851-853` | **S0 抽工厂**（Q4#8） |
| **B12** | **交付棘轮已超：248/245、591/591、161/155、99/94** | `[实查 E1]` | S0 记录快照；不作为本次门 |
| **B13** | **`app.set('trust proxy',1)` 无条件；`0.0.0.0` 监听 ⇒ XFF 可伪造** | `[读]` `server.js:276/:853` | S1 改 `KHY_TRUST_PROXY` |

---

## 4. 目标架构

### 4.1 分层

```text
  身份源（GitHub/Gitee/密码/WebAuthn/扫码）
        │ AS 作为 IdP 的客户端（179 A 片）
        ▼
┌────────┐┌────────┐┌────────┐┌────────┐
│ 网页   ││ 桌面   ││ 手机   ││ 终端   │
│code+   ││loopback││scheme  ││device  │
│PKCE    ││+PKCE   ││+PKCE   ││flow    │
└───┬────┘└───┬────┘└───┬────┘└───┬────┘
    │         └─系统浏览器(khy_as)─┘  │
    ▼                               ▼
  浏览器面 origin（按消费者：loopback / LAN / 反代域名）
    │  代理：/api/oauth  /api/auth  /api/manage  /.well-known/oauth-authorization-server
    ▼
┌──────────────────────────────────────────────────────────┐
│ khy-os backend（同一进程）                                │
│  · 唯一授权服务器 AS（AuthSession + BrowserSession）      │
│  · MCR HTTP 适配器 /api/manage → managementRegistry.invoke│
│  · 资源：endpoint-registry / auth-clients / failover-order │
│          + 既有 model-config / model-overrides / api-keys  │
└──────────────────────────────────────────────────────────┘

管理平面 = MCR（唯一漏斗） + 两适配层（CLI `khy manage` / Web `/api/manage`）
原则：令牌不跨端共享；共享的是同一 userId 与服务端配置。
```

### 4.2 三层身份与 `AuthSession` 变更

| 层 | 角色 | 签发方 | 存储 |
|---|---|---|---|
| L1 身份源 | GitHub/Gitee/密码/WebAuthn/扫码 | 外部或本机 | `User.oauthAccounts`（Q1）；`authMethod` 列已存在（`[读]` `AuthSession.js:34-39`） |
| L2 AS | backend | `authSessionService` | `AuthSession` + `AuthBrowserSession`（新表） |
| L3 客户端 | 四端 | AS | 各端安全存储（§5） |

**`AuthSession` 新增列**：`clientId` / `grantType`（含 `legacy`）/ `scopes` / `familyId` / `priorRefreshTokenHash`。复用 `authMethod`。

**legacy 令牌建模（回应复核 #2）**：

| 项 | 现状 | 本设计 |
|---|---|---|
| 判定 | `if (!decoded.sessionId)` → `isLegacyTokenStillValid()` → 通过即返回 `{ok:true, legacy:true, session:null}`（`[读]` `:341-355`） | 保留该分支**但显式打标**：`grantType:'legacy'`、`clientId:'legacy'`、`scopes:[]` |
| 默认有效性 | `UserAuthState.tokenInvalidBefore` 不存在时 `return true`（`[读]` `:222-232`）⇒ **默认恒有效** | scope 类端点：S1 记录 / S2 加 `X-Khy-Scope-Warning` / **S3 默认 401 `AUTH_REQUIRED`**（只留显式 `KHY_LEGACY_TOKEN_ALLOW` 清单作迁移窗） |
| 来源 | backend 与 ai-backend **共享 `JWT_SECRET`**（`[读]` compose `:50/:86`），ai-backend 只签 `{userId}`（`[勘]`） | 加 `iss`/`aud`/`tokenType` 断言；**拆 secret**（`KHY_BACKEND_JWT_SECRET` / `AI_BACKEND_JWT_SECRET`）为硬要求；未拆前 legacy 一律不获得 scope |
| 审计 | 无来源标识 | 事件里记 `subjectType:'legacy'` 与 `tokenIssuer`（若 claim 存在） |

### 4.3 客户端注册

| `client_id` | 端 | grant | redirect | PKCE | scope 上限 |
|---|---|---|---|---|---|
| `khy-web` | 网页 | `authorization_code`+`refresh_token` | **绝对 URI**：`${browserFacingOrigin}/auth/callback`（由页面把 `window.location.origin` 拼上；AS 动态比对，见 §4.4(c)） | S256 | `profile.read ai.generate management.read management.write session.read session.revoke` |
| `khy-desktop` | 桌面 | 同上 | `http://127.0.0.1:<port>/oauth/callback`（只校验 scheme=`http`、host=`127.0.0.1`、path 固定；端口任意） | S256 | 同上减 `session.revoke` |
| `khy-mobile` | 手机 | 同上 | `khyos://oauth/callback`（scheme/host/path 精确） | S256 | `profile.read ai.generate management.read` |
| `khy-cli` | 终端 | `device_code`+`refresh_token` | 无 | — | 全量 |

- `client_id` 是标识不是密钥，常量落 `serviceDefaults`，四端引用同一处（RUNTIME-001）。
- 四端 public client，无 `client_secret`。

### 4.4 AS 面

#### (a) 端点表

| 端点 | 方法 | 用途 | 认证 | 关键约束 |
|---|---|---|---|---|
| `/.well-known/oauth-authorization-server` | GET | RFC 8414 元数据 | 公开 | 在 `routes/wellKnown.js` 内新增分支（该前缀已被 `server.js:605` 独占，未知子路径 404）；门控 `KHY_OAUTH_AS`；裸 JSON 不套信封（`[读]` `wellKnown.js:14-25`）；**dev/nginx 必须加精确转发**（§4.4(c′) 表） |
| `/api/oauth/authorize` | GET | 授权码 | 认 `khy_as` | `response_type=code`；S256 唯一 |
| `/api/oauth/token` | POST | 换/刷新/设备轮询 | 公开 | 三种 grant；错误体 RFC 6749 §5.2 裸体 |
| `/api/oauth/device_authorization` | POST | 设备授权 | 公开 | `verification_uri = ${browserFacingOrigin(consumer)}/api/oauth/activate` |
| `/api/oauth/activate` | GET | 设备验证页（最小 HTML） | 认 `khy_as`；无 → 302 `/login?redirect=<encodeURIComponent('/api/oauth/activate?user_code=X')>` | 必须在 `/api` 下（dev 代理覆盖；且天然在 SPA catch-all 之前）；登录回跳复用 `safeRedirectPath`（`[读]` `Login.vue:175-181`） |
| `/api/oauth/device_verify` | POST | 批准 device_code | **必须有效 `khy_as`** | `approvedUserId = browserSession.userId`；`user_code` 走 POST |
| `/api/oauth/revoke` | POST | 吊销 | 公开（凭令牌） | 真撤销 `AuthSession` |
| `/api/auth/login`（扩展） | POST | 既有密码登录；可选 `request_id` | 公开 | 带 `request_id` 时校验 `khy_ap`（Path=`/api`）→ 写 `khy_as` → 记 pending → 相对 `continueUrl`；否则保持旧行为（**不拒绝**——没有 `request_id` 的普通登录照旧） |
| `/api/auth/oauth/:provider` + `/callback` | GET | 上游 IdP | 公开 | `state` 一次性；302 用相对路径；成功写 `khy_as` |
| `/api/auth/capabilities` | GET | 能力发现唯一真源 | 公开 | 既有 `oauthProviders` + 新 `oauthServer`（`issuers[]`、`activatePath`、`managementResourceIds[]`） |
| **`/api/manage` / `/api/manage/:resource` / `POST /api/manage/:resource/:op`** | GET/POST | **MCR 适配层（既有形状）** | Bearer + scope | 见 §6.0；daemon 那份保留但不新增消费者 |

#### (a′) 挂载顺序（回应复核 #4）

| 屏障 | 位置 | 规避 |
|---|---|---|
| API 404 | `[读]` `server.js:1402` | AS 与 MCR 适配器必须注册在它**之前** |
| SPA catch-all | `[读]` `:1428-1430` | AS 的 HTML 面挂在 `/api` 下，路径上不可能命中 |
| dist 判定 | `[读]` `:1417-1418`（`fs.existsSync` 在 require 时求值） | **S0 抽工厂**：`src/routes/oauthMount.js` 导出 `mountOAuthRoutes(app, {distPath, fs})`；`resolveFrontendDist()` 单独成模块。`server.js` 只调用工厂 |
| require 即 listen | `[读]` `:851-853`，全文无 `module.exports` | 测试用**工厂单测**（注入临时 dist）+ **真实启动冒烟**；不要求导出 app |

#### (b) 浏览器会话 `browserSession`

| 属性 | 值 |
|---|---|
| cookie | `khy_as`（`<id>.<secret>`，服务端存 `sha256(secret)`） |
| 存储 | 新模型 `src/models/AuthBrowserSession.js`（`id`/`user_id`/`secret_hash` unique/`ip_address`(仅审计)/`user_agent`/`created_at`/`last_seen_at`/`expires_at`/`revoked_at`） |
| **Path** | **`/api`**（读取它的端点全在 `/api` 下） |
| 属性 | HttpOnly、`SameSite=Lax`、https 时 `Secure`、**不写 Domain** |
| TTL | 12h 滑动，硬上限 30 天 |
| 写/读 | `res.cookie()`（Express 内建）+ 手工解析 `req.headers.cookie`，**零新依赖** |
| 撤销 | `/logout`、`/logout-all`、`DELETE /api/auth/sessions/:id` 同时撤销两类会话 |
| CSRF | SameSite=Lax + `state` + pending secret（本期不加独立 CSRF 字段，§9.17） |

#### (c) 待授权请求与 `khy_ap`

| 属性 | 值 |
|---|---|
| `request_id` | 32 字节随机；**参数快照句柄**，不携带认证结果 |
| 记录 | `{clientId, redirectUri, scope, state, codeChallenge, userId(null→pending), issuedAt, expiresAt(10min), consumed}`；内存 Map + TTL（仿 `qrLoginStore`） |
| `khy_ap` | `<request_id>.<pendingSecret>`；HttpOnly、Lax、**Path=`/api`**、TTL 10 分钟、不写 Domain |
| 校验点 | ① `/authorize` 重新读 `khy_as`；② `/api/auth/login?request_id` 必须匹配 `khy_ap`；③ 换令牌时 `code`/`verifier`/`redirect_uri`/`client_id` 四项全等；④ 任一失败 `invalid_request`，不 fallback |
| **redirect_uri 校验（回应复核 #14）** | 客户端传**绝对 URI**；AS 取本次请求的 scheme + Host（经 `KHY_TRUST_PROXY` 校验后）得到本次 `browserFacingOrigin`，要求 `redirect_uri.scheme` 与 `.host` 与之一致、path 精确等于注册值；不一致**只渲染错误页，绝不 302**。这是**动态比对**，因此不落静态 origin 白名单（反驳复核担心的「换 IP 就失效」） |

#### (c′) 浏览器面 origin：按消费者解析（回应复核 #6/#7/#8）

**概念**：`browserFacingOrigin(consumer)`，`consumer ∈ {web, desktop, mobile, cli}`。同一个后端对不同消费者可能给出不同 origin，这是**正确**的，不是缓存不一致。

| 消费者 | 解析规则 | 拒绝条件 |
|---|---|---|
| `web` | 请求自身的 scheme+Host（经 `KHY_TRUST_PROXY` 校验） | Host 不在 loopback/LAN/`KHY_OAUTH_ISSUER` 主机集内 → `INVALID_REQUEST` |
| `desktop` | 1) `KHY_OAUTH_ISSUER` → 2) 运行时发现的前端 origin（`[实查 V4]` 导出可用） → 3) **仅当后端自托管 dist** 时用后端 loopback origin | 解析结果是 `127.0.0.1` 且后端未托管 dist → 不回退，报 `CONFIG_MISSING` |
| `mobile` | 1) `KHY_OAUTH_ISSUER` → 2) **LAN 地址**（`getLanIPv4()`，`[勘]` `handlers/mobile.js:42/:265`）+ 浏览器面端口 | **必须拒绝 loopback 结果**；无 LAN 地址 → `CONFIG_MISSING`（不静默给 127.0.0.1） |
| `cli` | 与 `desktop` 相同（终端与后端通常同机） | 同上 |

**`capabilities.oauthServer.issuers[]`** 返回候选而非单一值：

```json
{
  "issuers": [
    { "kind": "loopback", "url": "http://127.0.0.1:<frontendPort>" },
    { "kind": "lan",      "url": "http://<lanIp>:<frontendPort>" },
    { "kind": "configured","url": "https://<KHY_OAUTH_ISSUER>" }
  ],
  "activatePath": "/api/oauth/activate",
  "managementResourceIds": ["endpoint-registry", "auth-clients", "failover-order", "routing-mode"]
}
```

桌面/终端用 `loopback` 或 `configured`；手机用 `lan` 或 `configured`。**选择规则写进各端代码，不由服务端猜**。

**第 4 级兜底的显式豁免（回应复核 #7）**：仅当 `resolveFrontendDist()` 找到 dist **且** 请求来自 loopback 时，允许用后端自身 origin；该分支必须写
`// khy-allow-RUNTIME-001: 单源部署：本机请求 + 后端自托管 dist，无代理存在`
否则不得使用。铁律 10 据此改成可机检形式：「禁止用 `BACKEND_HOST`/`BACKEND_PORT` 拼**非 loopback** 的浏览器可达地址；唯一豁免点必须有上述注释」。

**三态对照（按事实改写，回应复核 #3）**

| 形态 | 浏览器面 origin | `/api/oauth`·`/api/auth`·`/api/manage` 去哪 | `/.well-known/oauth-authorization-server` 去哪 | 需要改什么 |
|---|---|---|---|---|
| dev | Vite `AI_FRONTEND_HOST:resolveServePort()`（`[读]` `vite.config.js:33-34`） | Vite `/api` → backend:3000（现已是「其余命名空间」默认） | **当前没有代理**（`[读]` `:129-157`）→ 需加精确键 | S0：vite 加 `/.well-known/oauth-authorization-server` 代理 |
| 容器 `--profile web` | nginx origin | **当前全量 → `ai-backend:9090`**（`[读]` `nginx.conf:1-4/23-32`、`compose:99`）→ 设计不可用 | 同上，落 daemon | **S0/S1**：加 `location /api/oauth`、`/api/auth`、`/api/manage` → `backend:3000`；`/.well-known/oauth-authorization-server` 同；`web` 增 `depends_on: backend` |
| LAN 裸后端（手机直连） | 后端 origin（须 dist 已托管，B7） | 直连 backend | 直连 backend | S0 修 B7 |

#### (d) 四端浏览器如何拿到 `khy_as`

| 端 | 路径 |
|---|---|
| 网页 | 全程在 `browserFacingOrigin(web)`：`/api/oauth/authorize` → 302 相对 `/login` → 写 `khy_as`（Path=/api）→ `/auth/callback?code` |
| 桌面 | main 打开 `${browserFacingOrigin(desktop)}/api/oauth/authorize`；`code` 回 loopback；`khy_as` 留在浏览器 |
| 手机 | Custom Tabs 打开配对载荷 `authBaseUrl`（= `browserFacingOrigin(mobile)`，LAN）；`code` 回 `khyos://` |
| 终端 | 打印 `${browserFacingOrigin(cli)}/api/oauth/activate` + `user_code` |

#### (e) `user_code` / `device_code` 与限流（回应复核 #13）

- `user_code`：8 字符、`XXXX-XXXX`、剔除 `O0I1L`、TTL 5 分钟、一次性；**不是凭证**；
- **限流键** = `<user_code>` + **socket 远端地址**（`req.socket.remoteAddress`），**不用 `req.ip`**；XFF 仅作审计字段，且只在 `KHY_TRUST_PROXY` 显式开启时可信（`[读]` `server.js:276` 现为无条件信任，须改）；
- `device_code`：CLI 机密，只走 POST body；`verification_uri_complete` 默认不打印（`--print-link` 才给）。

### 4.5 scope 表（含「现状」列，回应复核 #5）

| scope | 覆盖 | **现状（今天）** | S1 | S2 | S3 |
|---|---|---|---|---|---|
| `profile.read` | `/api/auth/me` | **已挂 `authMiddleware`（`[读]` `auth.js:572`）⇒ 未登录恒 401** | 不改行为；只补 `error.code` 形状 | 加 warning 头 | 强制（保持） |
| `ai.generate` | `/api/ai/*` | **已挂 `authMiddleware`（`[读]` `server.js:586`）⇒ 已 401** | 同上 | 同上 | 保持；`/api/ai` 不因本设计变得更严 |
| `session.read` | `/api/auth/sessions` | **已挂 `authMiddleware`（`[读]` `auth.js:608`）⇒ 已 401** | 同上 | 同上 | 强制（保持） |
| `management.read` | `/api/manage` 读 op、`GET /api/manage/:resource` | **新适配器**（B9） | 只记录 | warning 头，仍 200 | 强制 401/403 |
| `management.write` | `POST /api/manage/:resource/:op` 写 op | 新 | 只记录 | warning 头 + 允许写 | 强制 403 |
| `session.revoke` | `DELETE /api/auth/sessions/:id`、`/logout` | 已 401 | 同上 | 同上 | 强制 |

**因此 S1 的「只记录」只适用于新增的 MCR 适配器与新增 OAuth 端点，不适用于既有受保护端点**——后者的阻断语义今天就在 S3 档，本设计不得声称它们「S1 会返回 200」。

**S1 显式改动（形状统一，影响面必须列出）**：`sendAuthFailure()`（`[读]` `middleware/auth.js:135-173`）当前只输出 `{success:false,message}`。改为在保留 `message` 的同时附加 `error:{code:'AUTH_REQUIRED'|'AUTH_INVALID', hint}`。影响面 = **所有挂 `authMiddleware`/`flexibleAuth` 的既有端点**；判据 = 现有测试全绿 + 新增一条「401 体含 `error.code` 且 `message` 不变」的契约测试。这是 S1 唯一触碰共享中间件的改动，必须单独提交。

- `apiResponse.fail` 的 `opts` 只支持 `status`/`hint`（`[读]` `apiResponse.js:190-196`），scope 名写进 `hint`；要 `details.scope` 须先扩 `apiResponse` 并同步 `DESIGN-API-002` §2。
- legacy 令牌（§4.2）`scopes:[]`：S3 起对 `management.*`/`session.*` 一律 401；`ai.generate` 仅在显式迁移清单内允许。
- API key 默认只映射 `ai.generate`，不自动获得 `management.write`（Q8）。
- 按 `[DESIGN-AGENT-002]`：只读角色不持 `management.write`/`session.revoke`；未知 `client_id` fail-closed。

### 4.6 令牌与会话生命周期

| 项 | 目标 | 现状 | 节奏 |
|---|---|---|---|
| access | `AUTH-002` 15 分钟 | 默认 7d | S1 沿用；S3 收敛 |
| refresh | 轮换、单次、只存哈希 | 有轮换，**无复用检测**（`[读]` `:445-457`/`:477-491`） | S1 加列 → S2 判定 → 再统一四端刷新 |
| 承载 | web：`khy_rt`（Path=/api/oauth）+ `khy_as`（Path=/api）；其余三端响应体+安全存储 | 两个 cookie 都不存在（`[实查 E5]`） | Q6 |
| 签名 | HS256 + `iss`/`aud`/`tokenType`；不发 id_token/JWKS | 无 `iss`/`aud`（`[勘]` payload 只有 userId/sessionId/tokenVersion/tokenType） | S1 加 claim；**拆 secret** |

### 4.7 统一失败语义

**资源面/管理面**用既有信封（`[读]` `apiResponse.js:9-16`），`hint` 承担修法，**无 `remedy`**：

| 场景 | HTTP | `code` | message / hint |
|---|---|---|---|
| 未登录 | 401 | `AUTH_REQUIRED` | 「未登录：该资源要求已认证」/「运行 `khy login --device` 或打开登录页」 |
| **本机会话当服务端会话用** | 401 | `AUTH_REQUIRED` | 「这是本机会话，不产生服务端令牌」/「运行 `khy login --device`」 |
| **legacy 令牌访问 scope 端点（S3）** | 401 | `AUTH_REQUIRED` | 「该令牌没有会话与权限范围」/「重新登录，或在迁移清单内显式放行」 |
| 缺 scope | 403 | `PERMISSION_DENIED` | 「权限不足 (403)：需要 `management.write`」 |
| 参数/流程非法 | 400 | `INVALID_ARGUMENT` | 具体问题 + 修法 |
| `.env` 独占项 | 409 | `INVALID_ARGUMENT` | 「该项由本机 `.env` 持有」/「运行 `khy gateway config`」 |
| 刷新被拒 | 401 | `AUTH_INVALID` | 「登录已失效」/「重新登录」 |
| 后端不可达 | 传输层 | `NETWORK_UNREACHABLE` | 「无法连接 `<browserFacingOrigin>`：确认服务在跑」——不得只说「连接失败」 |

**协议面**（`/api/oauth/*`、`/.well-known/oauth-authorization-server`、`/api/oauth/activate`）返回 RFC 6749 §5.2 / RFC 8628 / RFC 8414 裸体或 HTML，不套信封（`[读]` `apiResponse.js:227-234`：`envelopeMiddleware` 只包带布尔 `success` 的对象）。四端逐码映射中文文案，无 default 放行分支。

**内部地址解析（回应复核 #8）**：一切内部调用与机检命令用 `readBackendRuntime().apiPort || serviceDefaults.BACKEND_PORT`（`server.js:331` 允许顺延 20 次；`[勘]` `handlers/mobile.js:118-129` 已采用同口径）。

### 4.8 防呆铁律

1. fail-closed：未知 `client_id`/grant/缺 PKCE/redirect 不匹配/缺 `khy_ap`/缺 `khy_as` → 拒绝。
2. PKCE 只允许 S256。
3. `code`/`state`/`request_id`/`user_code` 一次性。
4. **redirect_uri 绝对 URI + 动态 origin 比对**（§4.4(c)），不匹配只渲染错误页，绝不 302。
5. 令牌不进 URL/日志；不跨端复制；`user_code` 走 POST。
6. 不新造签发：必须走 `issueSessionForUser()`。
7. 管理面写只走 `managementRegistry.invoke()`（MCR 单漏斗）；**任何新增写路径都判违规**。
8. 协议边界不套信封，例外在文件头写原因。
9. **cookie Path 不变量** + AS 面全挂 `/api` 下。
10. **给用户看的 URL 只用 `browserFacingOrigin(consumer)`**；禁止用 `BACKEND_HOST/PORT` 拼非 loopback 地址，唯一豁免点必须带 `// khy-allow-RUNTIME-001: <理由>`。
11. **无 `sessionId` 的令牌不得默认获得 scope**；`iss`/`aud`/`tokenType` 必须断言；**两个 issuer 不得共享 `JWT_SECRET`**。
12. **不新增管理 HTTP 路径**：管理读写在 `/api/manage` 的形状内，以资源/op 表达。

---

## 5. 各端接入流程

### 5.1 网页

1. `Login.vue` 读 capabilities → 渲染第三方按钮；
2. 生成 verifier/challenge/state → 跳 `/api/oauth/authorize?...&redirect_uri=${location.origin}/auth/callback`（**绝对**）；
3. AS 建 `authorizeRequest` + `khy_ap`；已有 `khy_as` → 直接出 code；否则 302 相对 `/login?request_id=`；
4. 登录成功 → 写 `khy_as` + 标记 pending → 回 `/api/oauth/authorize` → 302 `/auth/callback?code&state`；
5. `/auth/callback` 公开路由（须排除 `router/index.js:532-562` 的 `requiresAuth`）→ 校 `state` → `POST /api/oauth/token`；AS 下发 `khy_rt`。

**存储/刷新/失败**：access 只在 Pinia 内存；`khy_rt` 只在 cookie；刷新复用 `tryRefreshAndRotate()`（`src/api/request.js:46-66`）改指 `/api/oauth/token`（`withCredentials`），并把 `/api/oauth/token`、`/api/oauth/revoke` 加白名单；失败清内存 → `/401?redirect=`（保留 `safeRedirect`）。
**衔接**：密码登录保留为 AS 身份源；旧 `/api/auth/login` 响应 S1 续返、S3 加 `Deprecation`。**SSE 先改**：`useConfigSync.js:215-221`（读从未写入的 `'khy_token'`）与 `useAIMonitor.js:46-50`（不带凭据）改 `fetch`+`ReadableStream` 带 Bearer，禁 query 传令牌。

### 5.2 桌面

1. IPC `auth:capabilities` → main 取 `issuers[]`，选 `configured` 或 `loopback`；
2. verifier/state 只在 main 内存；`listen(0)` 绑 `127.0.0.1` 起一次性回调（60s 自关）；`shell.openExternal(${issuer}/api/oauth/authorize?…)`；
3. 浏览器已有 `khy_as` → 秒出 code；否则登录一次；
4. main 收 code → `POST ${asInternalOrigin}/api/oauth/token` → `safeStorage` 加密落 `auth/desktop-session.bin`（非 win32 加 0600）。

**渲染层只拿** `{loggedIn, username, clientId, issuer}`，永不接触令牌/cookie。刷新：`ensureFreshAccessToken()`（到期前 60s；401 刷新一次；失败清会话并推 `auth:state`）。
**失败**：60s 未完成 → `AUTH_INVALID` + hint；后端不可达 → 管理面板降级「本机只读」并如实标注。
**衔接**：删假登录接真实 IPC；新增 IPC 通道名先填 `src/shared/rpc/channels.ts`（现空 stub）；桌面新增的 HTTP 窄通路只有 `/api/oauth/*` 与 `/api/manage/*`，AI 生成仍走 CH-2。

### 5.3 手机

**前置**：S0 五项（manifest/未跟踪文件、`login()` Set 字面量、`Bearer null`、两条死端点、B7 dist）。
**授权**：
1. 配对载荷：`{"apiBaseUrl": <AS 内部可达地址>, "authBaseUrl": <browserFacingOrigin(mobile)>}`（生成端用 `getLanIPv4()`；消费端 `pairing.dart:77-101` 解析，缺字段回退 `apiBaseUrl` 并提示）；同时补鉴权提示（对齐 `handlers/mobile.js:168-189`）；
2. Custom Tabs 打开 `${authBaseUrl}/api/oauth/authorize?...&redirect_uri=khyos://oauth/callback`；
3. 有 `khy_as` → 确认；否则登录；
4. `khyos://oauth/callback?code&state` 接回 → 换令牌。

**存储**：`flutter_secure_storage` 键 `khyos_session_v2`（含 `authBaseUrl`）。刷新：单一拦截器 401→刷新一次→重发。失败：`invalid_grant`→「登录已失效」；网络→显示具体 origin；standalone 与 remote 文案分开。
**衔接**：`isConnected`（配对）与 `isAuthenticated`（登录）拆两态（现只判前者 `chat_screen_new.dart:112`）。Custom scheme 被抢注时 PKCE 使其换不到令牌（仅 DoS）；App Links 后续。

### 5.4 终端

**语义保持（回应复核 #16）**：
- `khy login` **保持交互账密**（既有 `routerDispatchTail.js:1000-1026` 行为不变）；
- 设备码走 **`khy login --device`**（新 flag，不是新命令；flag 是否计入 `routerCommands` 需用 `check-delivery-baseline` 复核，不计入则无棘轮影响）。

```text
$ khy login --device
在浏览器打开 http://<browserFacingOrigin(cli)>/api/oauth/activate 并输入 K7QM-3P2X
（5 分钟内有效；只在你自己的浏览器输入）
等待授权（第 1/60 次轮询，间隔 5s）...
已登录：<username>（terminal · client=khy-cli · scope: …）
```

**刷新/登出**：新增单一拦截器（现状零 `/refresh` 调用）；`khy logout` 先 `POST /api/oauth/revoke` 再删本地。**离线兜底**：保留 PBKDF2，但 `session.json` **无 `serverToken`**（`[实查 E1 段]` 本机 keys = `username,role,loginAt,deviceId,expiresAt`），`khy status` 必须显示「本机会话·不产生服务端会话·不可用于管理面写入」。

---

## 6. 统一路由管理平面（= 既有 MCR）

### 6.0 与 MCR 单漏斗的关系（回应复核 #1）

**结论：本设计不新建管理面，而是把新对象注册进 MCR，并把 MCR 的 HTTP 适配层补到 backend 一份。**

| 维度 | 既有事实 | 本设计 |
|---|---|---|
| 单漏斗 | `managementRegistry.invoke()` 是 CLI 与 Web 共同且唯一入口（`[读]` `managementRegistry.js:1-20`） | **不动**。所有新资源也走 `invoke()` |
| CLI 适配层 | `khy manage [list\| <resource> [op] [k=v]]`（`[读]` `handlers/manage.js:1-14`） | **复用**，零新命令 |
| Web 适配层 | 只在 daemon：`GET /api/manage`、`GET /api/manage/:resource`、`POST /api/manage/:resource/:op`（`[读]` `aiManagementServer.js:2532-2547`）；backend 无（`[实查 E7]`） | **在 backend 挂同一 registry 的适配器**（同 URL 形状），使 AS 与 scope 校验同进程；daemon 那份保留给其既有页面，**不新增消费者** |
| 既有 AI 路由资源 | `model-config`（`[读]` `aiManagementGatewayAdmin.js:1151-1180` 已经 MCR）、`model-overrides`、`api-keys`、`custom-providers`、`users`、`cron`、`dependencies`（`[实查 E6]`） | **复用**；不新开 `/api/management/ai-routes` |
| 一致性守卫 | `parityGuard.js` + `tests/management.test.js` | **扩测**：新资源加入 parity 清单 |
| 鉴权 | 三个 handler **函数内无逐 op 鉴权**（`[读]` `:1881-1941`），依赖宿主级 gate | **新适配器必须自己校验** scope（fail-closed），不依赖宿主 |

**新增/扩展的资源（通过 MCR 注册，不新增 HTTP 路径）**

| resource id | ops | 真源 | 写否 |
|---|---|---|---|
| `endpoint-registry` | `list` | `ENDPOINT-REGISTRY.json` + 探活 + `drift` | 只读（改登记走 PR） |
| `auth-clients` | `list` / `revoke` | `AuthSession` 按 `clientId` 聚合；`revoke` 委派 `authSessionService` | 仅吊销 |
| `failover-order` | `get` / `set` / `reset` | 既有 `failoverOrderStore` | 是（S2 起） |
| `routing-mode` | `get`（S2 起 `set-declared`） | 既有 `routing-modes.json` / `routingMode` | 声明参数；生效仍受 stage 门控 |
| （既有）`model-config` / `model-overrides` | 不变 | `gatewayEnvFile` 等 | 不变 |

> 这样「统一管理」的承诺落在**一个漏斗 + 两个既有适配层**上；不存在第二套 API、第二份写路径。

### 6.1 管什么、不管什么

| 对象 | 管 | 不管 |
|---|---|---|
| 端点路由 | 前缀归属、声明来源、本机可达性、四端发现一致性、两个 origin 是否混用 | 不改监听端口、不在界面改登记表 |
| AI 路由 | 钉选/故障转移/四档参数、候选健康只读、最近事实 | 不改算法、不让 S1 机制生效、不展示 key |
| 客户端与会话 | 四端注册、scope、会话、吊销 | 不签发/复制令牌、不改角色模型 |
| 导航路由 | 完全不纳入（另按 `RUNTIME-009` 清理手机死路由） | — |

### 6.2 真源与接线

| 类别 | 真源 | 写方 |
|---|---|---|
| 前缀归属 | **新增** `docs/10_规范/registry/ENDPOINT-REGISTRY.json`（不存端口） | PR/评审；管理面只读 |
| 本机生效端点 | `serviceDefaults` + 运行时 JSON（`backend_runtime` / `ai_manage_runtime` / `ai_frontend_runtime`） | 运行时进程 |
| AI 路由 | `failoverOrderStore` / `routing-modes.json` / env / key 池 | **只能** `managementRegistry.invoke()` |

**接线（回应复核 #5（上轮））**：S1 `vite.config.js` 读登记表只打印 `devDiff`、行为仍用硬编码；S2 `devDiff=0`；S3 删除 `DAEMON_ONLY_NAMESPACES` 字面量、改由登记表生成，并把 nginx 改 include `entries/endpoint-registry/nginx-endpoints.conf`（`LAYOUT-005` 登记 `path`+`rebuild`）。

**`drift` 三项可判定定义**：`registryVsGenerated`（片段哈希 ≠ 当前 JSON 生成结果）、`declaredVsProbed`（owner 与探活矛盾）、`consumedVsDeclared`（消费者调用了未登记前缀）。

### 6.3 API 契约（形状 = 既有 `/api/manage`）

| 端点（既有形状） | 用途 | scope |
|---|---|---|
| `GET /api/manage` | 列出资源（`registry.describe()`） | `management.read` |
| `GET /api/manage/:resource` | 资源契约 | `management.read` |
| `POST /api/manage/:resource/:op` | 调用（body 即 args） | 读 op → `management.read`；写 op → `management.write` |
| `DELETE /api/auth/sessions/:id` | 吊销单条（既有端点） | `session.revoke` |

**适配器必须做的三件事**（显式，因为既有 handler 不做）：① 校验 Bearer + scope（按静态 `RESOURCE_OP_SCOPE` 表，未知 resource/op → 404/400，fail-closed）；② 写 op 记录审计（`<dataHome>/oauth/management-events.jsonl`）；③ 把 `req.auth` 作为 `ctx.user` 传给 `invoke()`（既有签名已支持 `{source:'web', user}`，`[读]` `:1935`）。

**披露边界**：管理面响应含服务名/端口，属 `DESIGN-API-002` §5「不可外露」集合；禁被对客路由复用、禁入对客日志。

**`.env` 独占项**：资源 op 返回 409 + hint（如 `model-config set` 需写 env 时由 `gatewayEnvFile` 处理，不经界面直写）。

### 6.4 四端如何到达同一管理平面

| 端 | 到达 | 身份 |
|---|---|---|
| 网页 | `/admin/management` → `GET /api/manage`、`POST /api/manage/:resource/:op` | 自己的 `khy-web` 会话 |
| 桌面 | `ManagementPanel` → IPC → main 用自己令牌调同一路径 | 自己的会话；未登录降级本机只读 |
| 手机 | 系统浏览器打开 `${authBaseUrl}/admin/management` | 浏览器自己的会话 |
| 终端 | **既有 `khy manage`**（`khy manage` / `khy manage <resource>` / `khy manage <resource> <op> k=v`）；健康与钉序用既有 `khy channels status` / `khy channels order set` | 自己的 `khy-cli` 会话（离线本机会话不得写） |

**不新增子命令**（回应复核 #15）：`khy channels` 保持 `[status]` / `order` / `order set` / `order reset` / `reset <adapter>`（`[读]` `channels.js:1-12`）；管理页 URL 在 `khy manage` 输出尾部打印一行（不是新子命令）。

### 6.5 界面信息架构

```text
┌ 统一管理 /admin/management（同一 MCR 漏斗）────────────────────┐
│ Tab: [端点路由]  [AI 路由]  [客户端与会话]                      │
├ 端点路由（resource: endpoint-registry，只读）──────────────────┤
│ 浏览器面 origin   loopback / LAN / configured（按消费者）       │
│ AS 内部地址       runtime.apiPort（顺延后仍正确）               │
│ /api/auth  backend  可达  消费者 web,desktop,mobile,cli         │
│ /api/workflow daemon 不可达  drift: declaredVsProbed           │
├ AI 路由（resources: failover-order / routing-mode / model-config）┤
│ 声明 vs 生效并排；候选链与健康；机制 stage=S1（不可一键生效）    │
├ 客户端与会话（resource: auth-clients）──────────────────────────┤
│ web 3 · desktop 1 · mobile 1 · cli 2（含 LOCAL_ONLY 标注）[吊销]│
└────────────────────────────────────────────────────────────────┘
```

### 6.6 登记与豁免

| 面 | 进 `API-SURFACE.json`？ | 依据 |
|---|---|---|
| `/api/manage*` | **已在**（既有端点，非本设计新增） | 不新增 REST 端点，仅新增资源/op |
| `/api/oauth/*`、`/.well-known/oauth-authorization-server`、`/api/oauth/activate` | 本期不进，`gaps` 记一条 | 第一方协议面，非「第三方 SDK 可调」；khyquant 接入时触发五要素登记 |
| 错误码 | **不新增** | 复用 `CODES`（`AUTH_REQUIRED`/`AUTH_INVALID`/`PERMISSION_DENIED`/`INVALID_ARGUMENT`/`RATE_LIMITED`/`INTERNAL`）；协议面用 RFC 原词 |
| 审计依赖 | — | **新增独立执行器 `scripts/ci/audit-endpoint-registry.js`**（S1 只记录、exit 0），**不复用拦截型门 `check-api-contracts.js`**（回应复核 #17（上轮）） |

---

## 7. 与既有机制的关系

| 机制 | 管什么 | 本文 | 衔接声明 |
|---|---|---|---|
| **MCR（`managementRegistry` + `khy manage` + `/api/manage` + `parityGuard`）** | 可管理资源单漏斗 | 新对象以**资源**形式注册；backend 加一份 HTTP 适配器；不新开 `/api/management` | 不造第二漏斗；写路径唯一 |
| `[DESIGN-ARCH-071]` | 操作者通道 | 管理读写 = CH-4；终端 = CH-3；桌面本机读 = CH-2 | 不开第六通道 |
| `[DESIGN-ARCH-179]` | 身份源、按需登录 | 补 AS 层与四端客户端 | A5 的「登录票据」由 code + `browserSession` 取代；须同步订正 179 |
| `[DESIGN-AUTH-002]` | 令牌生命周期/存储/吊销 | 复用 `AuthSession`；两个 cookie HttpOnly | 三处偏差（access 时长、RS256、非 web refresh 载体）列 Q6 |
| `[DESIGN-API-001]/[002]` | 信封、五要素 | 只用既有信封/码 | 不新增码/字段 |
| `[DESIGN-AGENT-002]` | 默认拒绝、显式授予 | scope 是新授予面；只读角色不持写 scope | 不新增规则 ID |
| AI 网关 / `routeFact` / `failoverOrderStore` | 选路算法与事实 | 通过 `failover-order` 资源读写；展示读 `routeFact` | 不改算法 |
| `[DESIGN-ARCH-185]/162` | 四档、健康路由（S1） | 只显示 stage；只改声明 | 生效仍需 flag + 人工升档 |
| `[DESIGN-ARCH-181]` | 兜底披露 | 展示 cascade | 不改判据 |
| `[DESIGN-ARCH-091]` | provider key | 管理面不显示 key | 「身份」与「凭据」分开 |
| `[DESIGN-ARCH-117]`/`entries.json` | 端与入口 | 手机 `status:ready` 不实，S0 订正 | 不新增端 |
| `[DESIGN-ARCH-190]` | 一 key 一租户 | 第一方客户端，不建租户 | 不开 9100 |
| `[DESIGN-PROCESS-002]` | 四阶段 | scope 强制、登记表审计 S1 起步 | 见 §8 |
| `PROCESS-013` | 官方源 | 零新依赖（Express `res.cookie`、内置 crypto、`safeStorage`、既有 `flutter_secure_storage`） | 需要新库只能官方源 |
| `PROCESS-014` | 棘轮 | 不新增命令/规则；`khy login --device` 只是 flag | **棘轮已超（`[实查 E1]`），本次只保证不恶化** |
| `LAYOUT-005` | 产物落点 | nginx 片段落 `entries/endpoint-registry/` 并登记 | 不手写第二份 ignore |
| RUNTIME-001 | 零硬编码 | 浏览器地址只从 `browserFacingOrigin(consumer)` 来；内部地址从运行时文件来 | 铁律 10 + 豁免注释 |

---

## 8. 阶段化落地（S1 起步）

> `[读]` `[DESIGN-PROCESS-002]`：PP-1 禁直进 S3；PP-3 S1/S2 禁阻断；PP-4 每阶段有回退；PP-6 一次一阶。登记进 `FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms[]`，`executorStage.constant` 必须与执行器一致。

### S0 前置（入场券）

| 动作 | 判据（回退） |
|---|---|
| `.gitignore:40` 锚定 + 补 35 个未跟踪文件 | Q4#5（`git checkout -- .gitignore`） |
| 修 `login()` Set 字面量、`Bearer null`、两条死端点 | grep 断言 |
| **B7 dist 单一真源** | 未认证访问 `${browserFacingOrigin}/api/oauth/authorize` → 302 相对 `/login` 且该页可渲染 |
| **B11 抽 AS 挂载工厂 + `resolveFrontendDist()`** | `node --test …/oauthMount.test.js` 全绿 |
| **B10 nginx 双路由 + `web` 依赖 backend** | 容器内 `curl /api/auth/capabilities` 落到 backend（响应含 `oauthServer`） |
| **vite/nginx 加 `/.well-known/oauth-authorization-server` 精确转发** | Q4#9 返回 `application/json` |
| **记录棘轮快照**：248 / 591 / 161 / 99 | `check-delivery-baseline --json` 原样存档 |
| 订正 `entries.json` 的 `mobile.status` | 与实际一致 |

### S1 观察者（只记录；对既有端点不改行为）

- AS 端点 + `KHY_OAUTH_AS` 门控（默认关；关时 `/api/oauth/*` 404、`oauthServer` 缺省）；
- `AuthBrowserSession` + `khy_as`/`khy_ap`（均 Path=`/api`）+ `authorizeRequestStore`；
- `/api/oauth/activate` + `/api/oauth/device_verify`；挂载工厂与测试（Q4#8）；
- **backend 挂 MCR HTTP 适配器**（同一 registry，`/api/manage` 形状），scope 只记录；注册 `endpoint-registry`/`auth-clients`/`failover-order`/`routing-mode(get)`；
- `AuthSession` 加列（含 `familyId`/`priorRefreshTokenHash`）；`iss`/`aud`/`tokenType` 写入与断言；legacy 令牌只记录；
- **`sendAuthFailure` 输出 `error.code`**（单独提交，影响面 = 全部受保护端点，现有测试全绿 + 契约测试）；
- **`KHY_TRUST_PROXY`** 开关（默认关；compose/nginx 显式设 1）；`user_code` 限流改用 socket 地址；
- 四端接通登录；管理面只读；`vite.config.js` 只打印 `devDiff`；手机配对补 `authBaseUrl` + 鉴权提示；
- 独立审计器 `scripts/ci/audit-endpoint-registry.js`（恒 exit 0）。

**验收（未跑）**

```bash
node -e "…/api/auth/capabilities…"                              # Q4#2
node --test runtime/node/backend/tests/services/oauth/            # Q4#6/#10/#13
node --test runtime/node/backend/tests/oauth/cookiePathInvariant.test.js   # Q4#7
node --test runtime/node/backend/tests/routes/oauthMount.test.js  # Q4#8(a)
node scripts/ci/audit-endpoint-registry.js                        # Q4#4，exit 0
wc -l <dataHome>/oauth/events.jsonl                               # ≥200，0 条解释不了
node scripts/ci/check-rollout-stage.js                            # 0 error
```

**回退**：unset `KHY_OAUTH_AS`；删审计器调用；`vite.config.js` 删 diff 打印；nginx 恢复原 conf；factory 模块不被调用即无行为。

**登记**：`oauth2-authorization-server`、`mcr-scope-adapter`、`endpoint-registry-audit` 均 `stage:'S1'`、`previousStage:null`、`samples:0/200`、`executorStage.constant:'S1'`。

### S2 顾问

- 四端未登录引导 + `X-Khy-Scope-Warning`（不改状态码）；
- `failover-order`/`routing-mode` 写 op 开放（warning + 审计）；
- `devDiff=0`（登记表覆盖全部 11 条前缀与 WS 归属，行为仍走硬编码）；
- **refresh 复用检测落地**（`familyId` 判定），随后四端统一刷新链路。

**验收（未跑）**：提示 ≥50、误报 <10%；复用单测；`check-delivery-baseline` 不高于 **S0 快照（248/591/161/99）**。

**回退**：关 `KHY_OAUTH_PROMPT`；停发 warning 头；资源写 op 改回只读。

### S3 门禁

- 只对「必须登录清单」内端点强制（清单人评审，Q5）；`management.read/write`、`session.*` 强制；legacy 令牌默认拒绝（仅迁移清单例外）；
- access 收敛 15 分钟；
- 删 `DAEMON_ONLY_NAMESPACES` 字面量、nginx 改 include；
- `IGNORE_DIRS += .dart_tool` 等生成树；`CODE_EXTS` 先经 `--include-dart` 观察档修完存量再并默认。

**验收（未跑）**

```bash
node scripts/ci/check-agent-rules.js delivery/mobile/khy-os-client-app/lib --include-dart  # 0 error 且 N>0
node scripts/ci/audit-endpoint-registry.js --strict    # devDiff=0、drift=0
node scripts/release/gen-nginx-endpoints-conf.js --check
node -e "…/api/manage…"                                 # 401 + error.code
# blocked ≥20，豁免率 <20%
```

**回退**：清单移除条目；`KHY_OAUTH_ENFORCE=0`；`git revert` vite/nginx 两处提交（登记表继续存在但无人读）。

### S4 主动修复：本期不规划。

---

## 9. 不支持清单

1. 不做 OIDC（无 `id_token`/JWKS/discovery）。
2. 不做动态客户端注册、不开放第三方开发者。
3. 不做 SAML/LDAP/多租户/组织/团队。
4. 不支持 `implicit`、`client_credentials` 访问用户数据、对第三方提供 password grant。
5. 不做令牌跨端复制。
6. 不管理导航路由。
7. 不在管理面管理 provider key（属 091）。
8. 不把 S1 路由轴一键生效。
9. 不新建账号级 AI 路由配置面（Q7）。
10. **不长期保留「两个 issuer 共享 `JWT_SECRET`」**：本期允许过渡，但拆 secret 是 A 片硬要求（§4.2）；未拆前 legacy 令牌只算审计对象，不获得 scope。
11. 不让桌面渲染层直连 HTTP。
12. 不自动生成/改写 `.env` 密钥。
13. 不做手机 WebView 注入令牌。
14. 不承诺 Windows 文件权限保护令牌。
15. 不为 khyquant 定制（接入时触发 §6.6 对客登记条件）。
16. 不规划 S4。
17. 本期不引入独立 CSRF token 字段。
18. 不做跨设备批准（手机给桌面授权）。
19. **不新增管理 HTTP 路径**（一律 `/api/manage` 形状 + 资源/op）。
20. **不新增顶层 CLI 命令**；`khy login --device` 是 flag，`khy manage` 已存在。
21. **不改 daemon 的 `handleManage*` 鉴权模型**：新适配器自带 scope 校验；daemon 那份留给其既有页面。

---

## 10. 风险与待拍板

### 10.1 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | access 从 localStorage 迁内存，整页刷新丢会话 | `khy_rt`+`khy_as` 在 cookie；重载静默换回 |
| R2 | SSE 改 fetch 流破坏 AIChat/配置同步 | 按消费者灰度 |
| R3 | `AuthBrowserSession` 是新可重放凭据 | 只存哈希、TTL 12h、`/logout-all` 一并撤、`Secure` |
| R4 | cookie Path 与消费端点脱节 | 铁律 9 + Q4#7 单测 |
| R5 | 两个 origin 混用 | 铁律 10 + 三态表 + 管理页并排显示 |
| R6 | dist 未修（B7）导致 LAN/手机不可用 | S0 唯一修法；未修时报 `CONFIG_MISSING`/`INTERNAL` 带原因 |
| R7 | loopback 被防火墙拦 | 只绑 `127.0.0.1`、60s 自关、失败提示改用浏览器 |
| R8 | custom scheme 抢注 | PKCE（仅 DoS） |
| R9 | 设备码钓鱼 | 已认证浏览器批准 + 5 分钟 + `user_code`+socket 限流 |
| R10 | dev 归属表接线回归 | 登记表带 `matchPriority`；S1 diff / S2 0 / S3 替换，三段可回退 |
| R11 | 打包态 `KHY_OS_DIR` 解析不到后端 | 管理面降级本机只读 |
| R12 | legacy 令牌误用 | §4.2 建模 + S3 默认拒绝 + 拆 secret |
| R13 | 两份 `@khy/shared` 漂移 | 不碰 shared 的 provider OAuth |
| R14 | 手机仓库状态 | S0 先行 |
| R15 | 管理面暴露内部端口 | §6.3 披露边界 |
| R16 | 棘轮已超 | 本次只保证不恶化（Q4#11） |
| R17 | 加列/新表 `sync({alter:true})` 抖动 | 先 `describeTable` 判存在 |
| R18 | 旧 App 无 `authBaseUrl` | fail-soft + UI 明示 |
| **R19** | `trust proxy` 误配：关掉后 nginx 场景下 `req.ip` 变代理地址 | compose/nginx 显式 `KHY_TRUST_PROXY=1`；文档写清；限流不依赖 `req.ip` |
| **R20** | backend 与 daemon 各挂一份 MCR 适配器，资源行为不一致 | 同一 `management` 模块 + 同一 resources；parityGuard 扩测；daemon 不新增消费者 |
| **R21** | 容器 nginx 精确 prefix 漏配（新增前缀时） | 端点登记表 `namespaceOwners` 驱动生成 include；`--check` 漂移判红 |

### 10.2 待拍板（AI 不代决）

| # | 问题 | 选项 | 影响 |
|---|---|---|---|
| Q1 | OAuth 身份存哪 | `User.oauthAccounts`（推荐）/ 复用 `aliases` | 动 User 模型 vs 污染键空间 |
| Q2 | GitHub 无 email 怎么建号 | 占位 / 补填 / 允许空 | 唯一约束 |
| Q3 | OAuth 账号设密码 | 免旧密码 / 另立端点 | 安全面 |
| Q4 | 桌面是否复用同一后端 | 复用（假设）/ 独立 | §5.2 与 IPC |
| Q5 | 必须登录清单；`/api/ai` 入不入 | 逐页评审 / 按现状 | S3 范围 |
| Q6 | 令牌口径 | AUTH-002（15m+RS256+cookie）/ 保留 HS256 且非 web 走响应体 | 一次性登出 vs 规范 |
| Q7 | ai-backend per-user 路由配置是否并入 | 并入 / 本期不并入 | 「谁的策略生效」 |
| Q8 | API key 能否获得 `management.write` | 否（默认）/ 显式登记 | 自动化 vs 安全 |
| Q9 | `khy login --device` 的 flag 是否需登记（棘轮口径） | 不登记（flag）/ 按新入口登记 | `PROCESS-014` 判据 |
| Q10 | `routeFact` 是否持久化 | 内存环形 / JSONL | 排障 |
| Q11 | **两个 issuer 何时拆 `JWT_SECRET`** | 本期拆（推荐，A 片硬要求）/ 过渡期共享并只记录 legacy | 拆后 ai-backend 互通需改 |
| Q12 | `pubspec.yaml` 纳入版本同步 | 纳入 / 不纳入 | 软著与下载页对账 |
| Q13 | H5 桥/远控页/8896 去留 | 保留其一 / 收敛 | 登记表成唯一真源的前提 |
| Q14 | 手机 standalone 直连 provider 是否保留 | 保留并标注 / S3 禁用 | 账号/额度/审计 |
| Q15 | 是否允许登录页与 AS 不同源 | 不允许（本设计） / 允许并要求 HTTPS+`SameSite=None` | cookie 与 origin 策略 |
| Q16 | 跨设备批准是否要做 | 不做（§9.18）/ 另立提案 | headless 主机可用性 |
| Q17 | GitHub/Gitee OAuth App 注册与 secret 注入 | 人建、人写 env（AI 不碰） | A 片前置 |
| Q18 | **MCR 是否接受 backend 这份新适配器**（还是把 daemon 整体前移） | backend 加适配器（本文）/ 改 daemon 为唯一入口 | 影响令牌验证拓扑与部署 |

---

## 附：歧义对照

| 歧义点 | 固定答案 |
|---|---|
| 「路由」 | 三种带限定语；裸词不合格 |
| 有几个 origin | 浏览器面 origin（按消费者）+ AS 内部地址；给用户的地址只取前者 |
| 「统一管理」是不是新 API | 不是。是既有 MCR（`khy manage` + `/api/manage` + `parityGuard`）；本设计只加资源与一份 backend 适配器 |
| 手机「连上了」 | 只是配对；登录才取令牌 |
| AS 怎么知道浏览器登录过 | `khy_as`（Path=/api）→ `browserSession`；`request_id` 只是参数句柄 |
| 设备码谁批准 | 已登录浏览器的 `/api/oauth/activate` + `/api/oauth/device_verify`；`user_code` 不是凭证 |
| 「本机会话」vs「服务端会话」 | 离线兜底无 `serverToken`；不算登录成功、不能写管理面 |
| 统一登录是不是共享 token | 不是；共享 `userId` 与配置 |
| 管理界面改的是不是 `.env` | 不是；`.env` 独占项 409+hint |
| 显示的是不是「真实走的通道」 | 同时显示 `declaredConfig` / `effectiveConfig` / `routeFact` |
| S1 能否靠改配置生效 | 不能；`stage!=='S3'` 时只表示「已写入声明」 |
| legacy 令牌算不算登录 | 算一个**有缺陷的历史身份**：可读但无 scope；S3 起对 scope 端点拒绝；两个 issuer 共享 secret 属待拆项 |
