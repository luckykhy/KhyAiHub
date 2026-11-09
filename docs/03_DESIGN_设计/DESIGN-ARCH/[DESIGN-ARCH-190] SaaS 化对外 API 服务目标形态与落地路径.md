<!-- IMPL-STATUS: todo -->
<!-- IMPL-DRIFT-AUDIT: 2026-10-18 · DOCS-005 范围补标，依据见下 -->
> **标记依据**：13 条路径可解析，但文中未自述已实现；保守标 todo 待人工复核。
# [DESIGN-ARCH-190] SaaS 化对外 API 服务目标形态与落地路径

> **本文要读者做的决定有两件，请分开看——它们的结论不同：**
>
> | 决定 | 本文给的答案 | 依据强度 |
> |---|---|---|
> | **决定 A：现在就把 9100 端口开放出去收钱吗？** | **不要。** 先做 §四 的 P0 止血（四条资损/失控通道），再谈开放 | 强：每条都有 `path:line` 或可复跑命令 |
> | **决定 B：Khy OS 未来该不该走「对外卖推理 API」这条路？** | **本文不替你决定。** §二 列出这条路线的完整待验证清单与准入门槛，§九 列出「不走的代价」供你比较 | 弱：这条路线缺成本、收入、工期数据，见 §八 |
>
> **为什么分成两件事**：止血是**无条件该做**的（不开放端口也要做，因为代码里的洞是客观存在的）；
> 上路是**需要单独论证**的。本文档第一版把两者捆在一个包里交付，导致读者读完只得到
> 「做 P0，别开端口」却以为本文在论证「应该做 SaaS」——那是误读，本文在此明确纠正。
>
> **事实纪律**：每条结论带可复核的 `path:line` 或可复跑命令与输出。
> 未复跑、未验证的断言一律标 `【待验证】` 并列入 §八，不混入 §一。
> 调查材料与实测冲突处，以实测为准并显式标出。

---

## 一、术语表（先看这个，否则下文看不懂）

本仓代码里四个词并存，**它们不是同一批人**，混用会让按 key 计费的设计出错：

| 代码里的词 | 指谁 | 存在哪 | 计费口径 |
|---|---|---|---|
| **User / 用户** | 登录 `khy` 账号的人。有 username/email/role。会持有多把 ApiKey | Sequelize `users` 表 | **不计费**（自有账号） |
| **ApiKey / 入站密钥** | User 持有的机器凭证。`khy_` 前缀。SHA-256 存哈希，明文只返回一次 | `packages/shared/src/models/ApiKey.js` | 见下 |
| **customer / 客户** | 计费主体。有 id/name/quota/group，可持有多把 token | `ai_gateway_customers.json`（`aiAssetCustomerService.js`） | **计费主体**，用量与账都挂 customerId |
| **per-user / source:'user'** | 某个 User 自配了 relay 上游后的请求路由分支 | `dataPlaneEnforcer.js:127` 的 1.5 档 | **当前不计费**（§三 缺陷③） |

**关键事实**：`userGatewayResolver.js:61-63` 的 `ApiKey.findOne({ where: { keyHash, isActive: true } })`
对**任意 User 的任意 active ApiKey** 生效——也就是说 1.5 档不是一个独立的客户类型，
而是「有 ApiKey 的 User」这个集合。而 customer 是另一套注册表。
**User 与 customer 之间今天没有绑定关系**，这是 §三 缺陷⑦。

**按 key 计费的直接后果**：限流按 token 计量、配额按 customer 判定（`dataPlaneEnforcer.js:215`
限流键是 `${token.id}:${model}`，`:232` 配额查的是 `usage.checkQuota(customer)`）。
一个 customer 可持有多把 token（`:242 touchTokenLastUsed(customer.id, token.id)` 证明这是设计常态），
所以**客户可以多签几把 key 把自己��� RPM/TPM 额度乘以 N**。这条在本文判为待修（§四 P1）。

---

## 二、目标形态与它的准入门槛

### 2.1 目标形态（一句话）

> **一个 API Key = 一个计费租户。** 第三方拿标准 SDK 调四协议端点，
> 我按真实 token 用量计价、计量、限流、落审计行；客户能自助注册、开 key、充值、查用量、
> 下载对账单、吊销 key。

**为什么是这个粒度**：全库无应用级 `tenantId` / `orgId`，组织/席位是与现状不相称的粒度跃迁。
但请注意——**「不做组织」不等于「不做多租户」**。多个客户的 key 会打同一进程、共享同一份
`customerRegistry`、同一份 usage 文件、同一份 SQLite、同一批审计 JSONL。
**这本身就是多租户隔离问题**，验收标准见 §五 P1-3，第一版文档漏了这条，是读者指出的正确批评。

### 2.2 路线选择的准入门槛（本文**未**论证的部分，先摊开说）

要判断「值不值」，需要下面这些数字。**本文一个都给不出**，因为它们不存在于本仓任何文件里：

| 维度 | 需要什么 | 现状 |
|---|---|---|
| **单位经济** | 每 token 卖多少、上游成本占比、毛利率 | **零个数字。** `pricingService.js` 有计价机制（分组 ratio × 每模型 CNY），但那是**机制**不是**定价决定**。全文无一个价格、无一个毛利、无一个盈亏平衡点 |
| **工期与人力** | 各阶段几人天 | **零个估算。** P0–P4 有依赖顺序，无量级 |
| **客户证据** | 有没有真实客户在用 / 愿意付费 | **无。** 无访谈、无试点、无意向 |
| **需求规模** | 预期多少 QPS / 多少 token | **无。** 而 P3（扩容）整节建立在「要扩容」的假设上——这是循环论证，见 §三 缺陷⑫ |
| **运营责任** | 谁值班、谁赔、谁处理盗刷与申诉 | **零。** 见 §八 |

**诚实结论**：本文能证明「现在不能开端口」，**不能证明「应该走这条路」**。
若要论证后者，最小充分证据是：（i）一次真实第三方 SDK 端到端成功调用（§三 缺陷⑬）；
（ii）一份单位经济测算（毛利结构 + 保本点）；（iii）至少一个愿意试用的客户。
这三样在本次调查范围内**都不可能拿到**。

---

## 三、现状事实与缺口

> 排序口径先说清楚：**①②③ 是「上线当天就会发生」级别的；④⑤⑥⑦⑧ 是「做起来就撞上」级别的；
> ⑨⑩⑪⑫ 是「治理层，会让上面几项被误判为已修」**。
> 三者不同量纲，第一版把它们混排成一列「按危险程度排序」是排序错误，已更正。

### A 类：上线当天就会发生

**① 支付回调在非 production 环境零校验（production 下是拒绝）**

`paymentGatewayService.js:380-382`：
```js
if (!rawSecret) { return process.env.NODE_ENV !== 'production'; }
```
即：**secret 未配时，非 production 放行、production 拒绝**。调用点 `processWebhook:706-709`
（`skipSignatureVerification` 为假时校验），路由 `paymentWebhooks.js:9-15` 原样透传 `req.body`，
挂在 `server.js:659` 的公开路径上。

> ⚠ **更正第一版的过度断言**。第一版写「任何人 POST 一个 `{orderId,status:'paid'}` 就能给自己加额度」——
> **在 production 下不成立**，production 会拒。第一版正确的地方是 P0(a) 与 Q5 都限定了「非 production」，
> 但小标题与「即」字把两个独立缺陷接成了一条链，读起来像无条件成立。已改写为分级表述。

**另有一个 production 下也成立的问题**：`paymentGatewayService.js:739-744`
```js
if (amountCny != null && amountCny > 0 && amountCny !== order.amountCny) throw ...
```
客户端不传 `amountCny` 即**整段跳过金额校验**。但要利用它需先通过 `:706-709` 的签名校验——
**在 production 且 secret 已配的前提下，攻击者必须先伪造合法 HMAC**，
本文**没有**任何证据表明这条在 production 可达。**降级为待验证**，列入 §八。

**结论分级**：
- 非 production（staging / 预发 / 忘记设 `NODE_ENV`）：**零校验，可被任意刷额度** → 上线前必修
- production + secret 已配：签名把关，但**金额校验可被绕过**（需合法 HMAC）→ **【待验证】可达性**

**② 生产路径的判定器 fail-open**

真正对外监听 9100 的是 **backend 版** proxyServer——
`runtime/node/backend/scripts/proxy-daemon.js:11` `require('../src/services/gateway/proxyServer')`，
另 4 处 require 同指 backend 版（`cli/handlers/proxy.js:41`、`services/aiManagementServer.js:202`、
`services/gateway/customerRegistry.js:25`、`services/khyosAgentChannel.js:139/:261`）。

`customerQuotaEnforcer.js` 文件头 `:24-25` 原文：
> `Enforcement fails OPEN on internal errors (an enforcement bug must never take the gateway down)`

且 `:320-322` 说明无绑定令牌的调用方**按设计 quota-exempt**。调用点 `proxyServer.js:2862`。
判定链 = 「enabled → 月请求/token/预算三档」，**无 RPM/TPM 限流**。

**③ dataPlaneEnforcer 没接上线，但它写的那套编排是全仓最好的设计**

**ai-backend 版 proxyServer 全仓无 `start()` 调用点**——只有
`routes/aiGatewayAdmin.js:1420` 与 `routes/userGateway.js:28` 读它的 `getPort`。
`runtime/node/ai-backend/server.js` 的 `start()` 只起管理面（`:122 PORT = AI_MGMT_PORT || 9090`），
全文无 proxyServer 引用。

**这条对 P0 有直接影响，见 §四 P0 的诚实标注。**

### B 类：做起来就撞上

**④ 一条不过计费、不受限流、不占配额的旁路（存在于未接线的代码里）**

`dataPlaneEnforcer.js` 的求值规则（第一版没写，读者指出）：**自上而下、首个命中即返回，
互斥、不继续向下**。档位编号与含义：

| 档 | 行 | 条件 | 返回 | 限流 | 配额 | 计费 |
|---|---|---|---|---|---|---|
| 1 | `:123` | bearer == `PROXY_AUTH_TOKEN` | ok, `source:'global'` | ✗ | ✗ | ✗ |
| **1.5** | `:127` | bearer 命中某 User 的 ApiKey **且该 User 配了 relay** | ok, `source:'user'` | **✗** | **✗** | **✗** |
| 1.5b | `:165` | 同上但未配 relay 且 `GATEWAY_USER_ISOLATION_STRICT=true` | 403 `gateway_unconfigured` | — | — | — |
| 1.5c | `:165` | 同上但未配 relay 且非 strict | **落到 2** | — | — | — |
| 2 | `:180` | bearer 解析为托管 customer token | ok, `source:'customer'` | ✓ `:215` | ✓ `:232` | ✓ `:307` |
| 3 | `:247` | bearer 不认识，且有 global token 或存在托管 token | 401 `invalid_token` | — | — | — |
| 3b | `:252` | 有 global token 但没带 bearer | 401 `missing_token` | — | — | — |
| 4 | `:257` | 以上全不命中 | ok, `source:'open'` | ✗ | ✗ | ✗ |

1.5 档 `:146-163` 一旦 `relay.baseUrl` 成立即 `return`，**不走 `:215` 限流、不走 `:232` 配额**；
而 `settleOutbound` 的计费分支写死 `if (ctx.source === 'customer' && ctx.customerId)`（`:307`）→ **永不进账**。
`GATEWAY_USER_ISOLATION_STRICT` 默认非严格（`:165`）→ **配了 relay 就是永久免计费，用户有正向激励保持漏洞开启**。

**但请注意 ③**：这段代码目前**没接上线**。它是「接线当天就会变成资损」的地雷，不是今天的洞。

**⑤ 付一次钱，此后每月白拿一份额度**

`customerRegistry.js:436-440` 把 `monthlyBudgetCny` 累加成**永不复位的标量**；
`customerUsageService.js:162-177` 的 `checkQuota` 按 `monthKey()`（`:41-43` 直接取 `new Date()` 的 YYYY-MM）
取本月用量比这个标量。每月 1 日用量归零、额度不归零 → **这是本次调查中最确定的收入漏洞，
且它在线上路径上**（`customerQuotaEnforcer` 是线上判定器）。

**⑥ 幂等键跨客户串单**

`paymentGatewayService.js:521-523`：`store.payments.find((item) => item.idempotencyKey === idempotencyKey)`
全表 find，无 `customerId` 过滤 → A 的 key 能命中 B 的订单。

**⑦ 额度写入是丢更新**

`customerRegistry.js:427-449` 的 `adjustCustomerQuota` 在 `:442` 调 `saveStore(store)` **不传第二参数**；
`saveStore` 签名 `:194` 是 `saveStore(store, baseVersion)`，`:198` 仅在 `baseVersion !== undefined`
时拒绝陈旧基线，省略即走 `:205-206` 无条件写。两个 webhook 并发 → 后写静默吃掉前一个的额度增补。

**⑧ User 与 customer 无绑定，注册面完全开放**

`auth.js:198` 的 `/register` 中间件只有 username/email/password 三条校验，无验证码、无邀请码、
无邮箱验证（`:267` 立即发会话），挂 `server.js:447` 公开路径。
> ⚠ **更正调查材料**：材料称「不存在 `/register`、账号只能由管理侧预置」——实测不成立。

### C 类：治理层（会让上面几项被误判为已修）

**⑨ 对客端点清单不存在 —— 这是本文最大的结构缺口**

P1 要「只对对客端点加 `/api/v1`」，机制 #1 的守卫要判「什么算对客端点」，
但**全文没有一处列出对客端点到底有哪些**。没有清单就无法估工作量，
也无法判断守卫将来能不能升 S2（判据是误报率，而误报率的分母就是这份清单）。
**§四 P1 的第一项交付物就是建立它。**

**⑩ 现有守卫的绿近乎是空的**

本轮实跑 `node scripts/ci/check-api-contracts.js` → `[api-contracts] checked=61 findings=0 exit=0`。
读全文 215 行：四个检查函数全是启发式单行正则，**无鉴权、无版本段、无五要素登记检查**，
扫描根 `:65` 写死在 `runtime/node/backend/src/routes`——对客端点所在的两个 proxyServer 整棵树不在射程。

**⑪ 记分板有假绿**

本轮实跑 `node scripts/ci/check-golden-path.js` → `汇总: PASS 0 · FAIL 1 · SKIP 6 · UNKNOWN 0`，**脚本自身 exit=0**；
同刻 `node scripts/ci/check-delivery-baseline.js` 给 `[D9 PASS]`（注「黄金路径检查存在且已被门引用」）。
「跑过」不等于「红」——必须配「FAIL 即红」。

**⑫ 部署无数据库配置**

`docker-compose.yml` / `Dockerfile` / `fly.staging.toml` 里 `DB_TYPE|DATABASE_URL|POSTGRES` 零命中。
**但「零命中」只能推出「默认 SQLite」，推不出「必须分布式改造」**——
还缺三环：预期负载、SQLite 在该量级下够不够、SQLite 以哪种锁失败。
本文**不**假设要扩容（见 §2.2），P3 因此标注为**条件阶段**。

**⑬ 没有任何一次真实第三方 SDK 的端到端调用记录**

附录的实跑清单全是本仓脚本与三个单测，**没有一条打向真实上游**。
因此「拿官方 SDK 改 base_url 即可接入」（§2.1）**是读码推断，不是验证结论**——
SSE 分块格式、错误信封形状、`/v1beta/models/{model}:generateContent` 的路径与真实 SDK 行为
都未经真实调用证实。**这是决定 B 的第一个必补证据（§2.2）。**

**⑭ 任务面棘轮已破口**

同一次实跑：`routerCommands=246/245 · aliasEntries=591/591 · handlerFiles=158/155 · ruleCount=96/94`。
真源 `[DESIGN-DELIV-002] §2.3`：**只降不升，基线只在退役后下调**。

**⑮ 令牌门槛的一处误判（第一版更正，此处保留）**

第一版写「删掉 compose 默认 `JWT_SECRET` 可让自签发触发」——**错的**。
`ensureAuthSecret.js:37 MIN_SECRET_LEN = 32`、`:73-75` 判定 `>= MIN_SECRET_LEN`，
而 `node -e "console.log('change_this_in_production'.length)"` → **25**，低于门槛，
**默认值本来就走自签发**，删掉不改变行为。真正的不一致：`docker-compose.yml` 有**两处**（`:48`、`:80`），
且 `runtime/node/ai-backend/src/routes/auth.js:22` 自带硬编码兜底 `'dev-only-secret-do-not-use-in-production'`，
其 `:18-20` 的 production 检查只看「是否存在」不查长度。

---

## 四、分层设计

| 层 | 职责 | 复用什么 |
|---|---|---|
| **L0 商品层** | 一个 key 进来 → 协议转换 → 转发 → 计价计量 | **backend 版 proxyServer 为真源**（`runtime/node/backend/src/services/gateway/proxyServer.js:2855-2860` 四协议判定）；协议归一复用 `services/gateway/protocolConverter/` 与 `adapters/_openaiSseStream` / `_anthropicSseStream` / `_responsesSseStream` / `_sseParser` / `_sseTextDecoder`。**ai-backend 版降级为设计参考** |
| **L1 准入层** | 唯一判定点，缺一票即拒；**不得存在不过计费的旁路** | 线上：`customerQuotaEnforcer.js` 三档配额（`:369-404` 整数分 `toFen`）+ `customerRegistry.js` 绑定。离线：`dataPlaneEnforcer.js` 五级编排（§三④的表）把**判定顺序与限流配额接线**搬进 backend 版。`userGatewayResolver.js:61-63` 既是隔离实现也是漏洞成因 |
| **L2 计费账本层** | 请求后收口：算钱、记用量、核配额、写可出账明细行，重复结算不重复计 | `pricingService.js` 双账；`requestLogService.js` 逐请求 JSONL + `:24` 90 天保留期；`modelPricing.js` 五态（priced/free/flat/assumed/unknown）；`toFen` |
| **L3 收款层** | 真钱进得来，伪造回调拿不到额度 | `paymentGatewayService.js` 骨架（五态机 `:19`、HMAC `:352-388`、eventId 去重 `:718-730`、归属判定 `:60-100`）。改：`:380-382` 分级 fail 策略、`:739-744` 金额缺失即拒 |
| **L4 契约层** | 第三方自查「能调什么、出错查哪笔、重试安不安全」 | `docs/10_规范/DESIGN-API/[DESIGN-API-002]`（§4 版本化、§7 目录）；`src/contracts/a2a/` 的「协议先落 JSON Schema」范式；`wellKnown.js:22-25` 与 `a2a.js:21-23` 的边界纪律（对外协议面**故意不套** `{success,data}`）；`@khy/shared/utils/apiKeyHash` |
| **L5 运行层** | 扩容不丢额度、自有上游不打爆、客户数据可删可查 | `redisRateLimiter.js`（ZSET + Lua，Redis 缺席降级）、`redisHealthStore.js`、`requestDedup.js`；`accountPool.js` / `apiKeyPool.js` / `concurrencySlots.js`；`vaultCore.js` 密钥处理四条（列举不回显明文、占位符替换值不回灌上下文、响应意外回显一律 redact、`vault.json` 与 `.bak` 双 0600） |

---

## 五、分阶段落地

> **阶段顺序上，P0 与 P1-0 无条件该做（不开放端口也做）；P1 其余部分与 P2 及以后属于「上路」，
> 只有在 §2.2 的门槛被满足后才启动。** 第一版没分开，本版分开。

### P-1 需求存证（前置，无代码）

落 `works/data/khy/feedback/<task-id>/requirement-5q.md`：五问答案逐条带 `source`
（只能引需求原话「Khy OS 我希望能提供 SaaS 化的 API 服务」或本文实测记录，**不得编造用户原话**）。
另落 `differential.md`；若采纳 P2.5 则落 `scrub-plan.md` + `rollback.txt`。

**gate**：`node scripts/ci/check-agent-feedback.js --changed` 对本批次报
`fix-without-repro` / `missing-*` / `delete-documented-code` 为 0 error。
该守卫当前 S1、恒 exit 0，**须读 `--json` 的 findings 而非退出码**，并按路径过滤——
本轮实跑时工作区已有 324 项改动产生的 5 条 warning，与本方案无关。

### P0 止血（无条件该做，与是否开放端口无关）

| # | 通道 | 影响线上吗 | 修法 |
|---|---|---|---|
| a | webhook 签名分级 fail | **是**（非 production 零校验） | `:380-382` 改为 secret 缺失即拒（不分环境）；`:739-744` 补「amountCny 缺失即拒」 |
| b | quota fail-open | **是**（`customerQuotaEnforcer.js:24-25` 就是线上判定器） | 改 env 可关且默认关；`:320-322` 的 quota-exempt 旁路在对外模式下取消 |
| c | 1.5 per-user 免费旁路 | **否**（`dataPlaneEnforcer` 未接线） | `:146-163` 保留隔离路由但必须同时走限流与配额；`GATEWAY_USER_ISOLATION_STRICT` 默认改严格 |
| d | open 档 | **否**（同上） | `:257` 在 production 下返回 401 `missing_token` |

> ⚠ **c/d 改的是未接线的代码，对当前线上零影响**，它们的真正生效点是 P2.5 之后。
> 第一版把四条并列称为「止血」，读者指出这是误导，本版标注清楚。
> **c/d 仍应在 P0 做**，因为它们是「接线前的最后一道编辑机会」，且成本低。

**JWT_SECRET 按 §三⑮ 处置**：删 `docker-compose.yml:48` 与 `:80` 两处默认值**之前**，
先确认容器内 `.env` 可写（`:46 KHY_HOME` 是数据落点，不等于 `.env` 可写）——
`ensureAuthSecret.js:91-105` 的失败分支原文是「重启后密钥会变化、已签发的登录态将失效」，
删错会把弱密钥问题换成可用性问题。`ai-backend/src/routes/auth.js:22` 的字面量兜底改为复用同一把 32 位门槛。

**gate（全部机判）**：
- `node -e` 在 `NODE_ENV=production` 下对无 bearer / 已配 relay 的 bearer / 未知 bearer
  三种输入调 `enforceInbound`，须得 401 / 403 / 429 三种拒绝，无一种 `ok:true`（覆盖 c/d）
- 新增断言：非 production 下未配 secret 的 webhook 必须拒绝（覆盖 a）
- 新增断言：`customerQuotaEnforcer` 在 store 不可读时按新默认拒绝（覆盖 b）
- 回归：`node --test runtime/node/backend/tests/paymentGatewayService.test.js` → `# pass 2`
- 回归：`node --test runtime/node/backend/tests/paymentGateway.httpRoutes.test.js` → `# pass 2`
- 回归：`node node_modules/jest/bin/jest.js --rootDir runtime/node/backend tests/gateway/customerQuotaEnforcer.test.js` → `Tests: 12 passed`

**回滚（必须有）**：每条 env 驱动（`KHY_WEBHOOK_FAIL_CLOSED` / `KHY_QUOTA_FAIL_OPEN` /
`GATEWAY_USER_ISOLATION_STRICT` / `KHY_DATA_PLANE_REQUIRE_TOKEN`），改一行 env 即回退。

#### P0 执行记录（2026-10-15，存证 `works/data/khy/feedback/190-saas-p0-stopbleed/`）

四条洞全部复现并关闭，`repro-before.txt` / `repro-after.txt` / `gate-after.txt` 为实跑原始输出。
**与上文原方案有四处偏差，均为实施中发现，以本记录为准：**

| 项 | 上文原方案 | 实际做法 | 为什么改 |
|---|---|---|---|
| a | env 名 `KHY_WEBHOOK_FAIL_CLOSED` | `KHY_WEBHOOK_ALLOW_UNSIGNED`（默认关） | 「默认关的回滚开关」读起来像默认不安全。改为「默认拒绝 + 显式 opt-in 放行」，与规则 11「判据是默认是否原生」同一口径 |
| b | 「改 env 可关且默认关」 | 同义，但**修的是豁免路径不是 catch 路径** | 实测：store 损坏时 `resolveCustomerByToken` 返回 `null`，走的是 `:455` 的内部通道豁免，**根本没进 catch**。只改 catch 等于没修。改为新增 `isStoreUnreadable()` 显式判定「文件在但解析不了」 |
| c | 「必须同时走限流与配额」 | 只补了**限流**，未加配额 | 该通道走的是**用户自己的上游 key**，计费给他们等于二次收费。真正的洞是「无限流」不是「不计量」，故只补限流 |
| d | `GATEWAY_USER_ISOLATION_STRICT` 默认改严 | **未改，保持 opt-in** | 试过「网关已武装则默认严」，判据 `hasManagedTokens()` 读真实数据目录，同一份构建会随本机配置给出不同答案，并打破 `dataPlane.userRouting.test.js` 记录的零回归回落。是否允许未配 relay 的 ApiKey 继续用 owner 的 key，是**双向都有真实爆炸半径的策略决定**，见 §八 |

**JWT_SECRET 的实际处置与上文不同**：上文说「删默认值前先确认容器内 `.env` 可写」。
实测发现该担忧的前提不成立——占位值 `change_this_in_production` 只有 25 字符，
本就低于 `ensureAuthSecret.js:37` 的 32 位门槛，**今天已经在走自签发**；删掉它不改变自签发行为，
因此不存在「把弱密钥问题换成可用性问题」的新风险。实际改动为：
`docker-compose.yml` 两处占位值改为空（backend 由 `ensureAuthSecret` 自签发，
ai-backend 因 production 下短于 32 位直接拒启动，故不给占位值）；
`ai-backend/src/routes/auth.js:17` 的生产校验由「判有无」改为「判长度 ≥32」，
与 `shared/src/config/env.js:57` 同一门槛。开发态字面量兜底**保持原样**
（它有 38 字符、本就达标，且两个服务要共用同一把开发密钥，改它会打断凭据互通）。

**新增测试 3 条**（`customerQuotaEnforcer.test.js`，12 → 15）：
- 原「enforce fails open when stores are unreadable」**名不副实**——它走的是「无 store 文件 → 豁免」的正常路径，
  从未进入 catch，即内部异常时的 fail-open **一直没有任何测试覆盖**。已改名并补齐两条真实分支：
  内部异常默认拒绝、`KHY_QUOTA_FAIL_OPEN=true` 恢复放行；
- 新增：store 存在但解析不了 → `customer_store_unreadable` 拒绝。

**已知未修**（留 P2）：`adjustCustomerQuota` 的无条件覆盖写（并发回调仍可能丢额度增补）、
限流按 token 维度而配额按 customer 维度（客户多签 token 可放大额度）、
`settleOutbound` 十出口重复计费。

### P1 契约面（**上架的必要条件**，但属于「上路」）

**P1-0 建对客端点清单**（第一版缺此项，是最大结构缺口）：
一份机器可读清单，逐条登记四协议推理端点、用量查询、key 管理、充值、webhook 回调，
每条带：路径 / 认证方式 / 请求响应字段 / 错误码 / 迁移说明（`DESIGN-API-002` §4 五要素）。
**这份清单是后续所有工作的估算基数与守卫误报率的分母**，没有它无法判断工作量。

#### P1-0 执行记录（2026-10-15）

产出 `docs/10_规范/registry/API-SURFACE.json`，17 条端点（五要素逐条齐备，已机判校验），
并按 `DESIGN-API-002` §4「登记位置：§7 目录表」把 §7 从占位表改为面级速查 + 指向登记表；
同文件已登记进 `registry/00_INDEX_registry-总目录.md`。文档站已重建（1336 页，链接全通）。

**清点结果：13 条已存在、4 条被承诺但不存在。**

| 面 | 条数 | 认证 |
|---|---|---|
| 对客数据面（四协议 + `/v1/models` + `/health`） | 6 | bearer（客户托管 token） |
| 对客 REST（`/api/ai-gateway/payments/**`） | 6 | JWT |
| 支付回调（`POST /api/payment-webhooks/mock`） | 1 | HMAC-SHA256 |
| **缺失**：用量查询 / key 管理 / 退款 / 账单下载 | 4 | — |

**清点过程带出的三条实测结论**（都推翻了一处既有说法）：

1. **客户自助面根本不存在。** 用量与 key 管理确实有端点（`ai-backend/src/routes/aiGatewayAdmin.js`
   的 `usage/summary`、`usage/customers/:id`、`customers/:id/tokens/**`），但该文件
   `router` 级挂了 `authenticateToken + requireAdmin`（`:389`），**仅管理员可达**。
   §2.1 对客户承诺的六件事里，只有「充值」一项有端点承载。这印证并量化了 P3 的必要性。
2. **§2 的机器码表与实现完全脱节。** 代码里实际发出的 14 个码（`missing_token` /
   `invalid_token` / `rate_limited_rpm` / `arrears_refunded` 等）**无一**在 `DESIGN-API-002` §2
   表内，且命名风格不同名（snake_case vs SCREAMING_SNAKE）。§2 写的是「新增机器码必须先入表再用」，
   实测**先用了 14 个再入表 0 个**。客户端目前只能靠 `message` 文本匹配，而 `message` 受规则 2.2
   约束会改写——这是 P1-1 的第一件事。
3. **`mock` 支付确认端点无 provider 门禁**（`POST /api/ai-gateway/payments/{id}/mock/confirm`
   仅需登录 JWT）。若它出现在对客面，等同于自助充值。已登记为 `severity: blocker-for-launch`。

**修正本节原描述的两处不准确**：

- 原文把「webhook 回调」写成泛指，实测**唯一**回调端点是 `POST /api/payment-webhooks/mock`
  （`server.js:659` 挂的是 `/api/payment-webhooks`，实际路由为 `/mock` 子路径）。
- 原文的 P1-1「对客端点加 `/api/v1`」**不能一刀切**：Gemini 端点路径是
  `/v1beta/models/{model}:generateContent`，带 `v1beta` 段与冒号方法名，
  不是简单加前缀能解决的，须单列迁移规则。

**验证**：`node scripts/ci/check-repo-layout.js` exit 0 / errors 0；
`node scripts/ci/check-wiring.js`「109 个检查器全部接线」；
`node scripts/ci/check-rules-registry.js` 通过；`docs:verify`「每个 md 都有 html，
所有本地链接可达」。

#### P1-1a 执行记录（2026-10-15）：错误码映射

先确认了一个前提：`code` **确实外部可见**——`sendEnforcementRejection`（ai-backend
`proxyServer.js:121`）把它直接放进响应体 `{error:{message, code}}`。所以 P1-1 不是
「登记一下」，而是**真的改了码值**。

**映射表（14 条，已落 `API-SURFACE.json` 的 `errorCodeRegistry.mapping`）**：

| 原码 | 登记码 | details |
|---|---|---|
| `missing_token` / `invalid_token` | `UNAUTHORIZED` | `reason` |
| `token_disabled` / `model_forbidden` / `gateway_unconfigured` / `customer_disabled` | `FORBIDDEN` | `reason` |
| `rate_limited_{rpm\|tpm}` | `RATE_LIMITED` | `scope` + `reason` |
| `quota_exceeded_{requests\|tokens\|budget}` | `CREDITS_EXHAUSTED` | `scope` + `reason` |
| `monthly_{requests,tokens,budget}_exceeded` | `CREDITS_EXHAUSTED` | `reason` + `scope` |
| `arrears_refunded` | **`ARREARS`（新码）** | `reason=refund_exceeds_paid` |
| `customer_store_unreadable` / `quota_check_failed` | **`SERVICE_UNAVAILABLE`（新码）** | `reason` |

**设计取舍**：细粒度区分（限流的 rpm/tpm、额度的 requests/tokens/budget、403 的四种成因）
**不进 code，进 `details`**。理由是 code 应稳定、枚举值越少越好；而 §5 已规定 `details`
只放白名单字段，`scope` / `reason` 属可外露的判定结果，不含内部对象。

**新增两个码入 §2 表**：`ARREARS`（退款后余额为负——P2 引入的欠费语义，
`CREDITS_EXHAUSTED` 的「额度已用完」表达不了）和 `SERVICE_UNAVAILABLE`
（配额存储不可读 / 内部校验失败——`UPSTREAM_ERROR` 的「模型服务暂不可用」是错的，
上游是好的，是我们自己的存储坏了）。

**顺带修掉两处违规，且两处都是本仓自己引入的**（复查 §5 时发现）：

1. **路径外泄**：P0 那两条 503 消息把 `customersFile()` / `proxyAuthFile()` 的**绝对路径**
   写进了响应体——违反 §5「内部文件路径不可外露」，等于把服务端文件系统布局告诉第三方。
   已把路径与 `KHY_QUOTA_FAIL_OPEN` 提示移入运维日志，响应体只留人话模板，
   并加了两条断言守住（响应消息不得匹配盘符/家目录，日志必须含该路径）。
2. **英文消息**：数据面 7 条拒绝消息原为英文，违反规则 2.2。已改写为 §2 模板风格的中文。

**回归**：既有断言从「断言旧码值」升级为「断言新码 + `details.reason`」，比原来更强。
`customerQuotaEnforcer.test.js` 15 / 15、`customerQuotaEnforcer.http.test.js` 3 / 3、
`dataPlane.userRouting` 5 / 5、`paymentGatewayService` 7 / 7 全绿。

**未覆盖**（已在 `errorCodeRegistry.residual` 登记）：webhook 回调的错误仍靠 message
正则判 httpStatus，未映射为机器码；上游供应商错误尚未经 `gatewayErrorClassifier`
归一到 §2 表。**`/api/v1` 版本化未做**——Gemini 端点路径带 `v1beta` 段与冒号方法名，
须单列迁移规则，是 P1-1 的下一半。



**P1-1 版本化与文档**：对客端点加 `/api/v1`（只对清单内的端点，内部 `/api/*` 不动）；
目录由 P1-0 清单渲染，与清单逐条一致（沿用 `npm run docs:rules-cards` 那种
「由登记表渲染 + 守卫校验逐字节一致」的既有范式，不新立一套）。

**P1-2 traceId**：`server.js` 加 traceId 入口中间件并贯穿 SSE/WS 与 requestLogService
（今天 `_metadata` 只在客户端已带 requestId 时回填，`utils/apiResponse.js:48-49`）。

**P1-3 跨客户可见性验收**（第一版完全缺失，读者指出的正确批评）：
明确并测试四条——A 能否读到 B 的用量 / 对账单 / 审计行 / 定价策略。
已知 `requestLogService` 的落盘字段含 `customerId`（`dataPlaneEnforcer.js:319-338`），
但**是否有 customerId 之外的隔离维度，本文未查到**——**【待验证】**。

**P1-4 守卫接线**：`check-saas-surface.js` 必须同时登记进根 `package.json` 的 `check:*`
别名与 `.github/workflows/pr-gate.yml`。本轮实跑 `node scripts/ci/check-wiring.js` →
「109 个检查器全部接线（豁免 11 项）」，判据是 `scripts/ruleguard/lib/wiring.js:150-157`
枚举 `scripts/ci/` 全部 `.js`、`:193-196` 按文本引用计数、零引用即判 error。

**gate**：
- `node scripts/ci/check-wiring.js` exit 0（**真门**）
- `node scripts/ci/check-api-contracts.js` 覆盖数从 61 上升且 findings=0
- P1-3 的四条断言各有独立测试
- `node scripts/ci/check-rules-registry.js` exit 0

> ⚠ **S1 读数不进 gate**。按 PROCESS-008 PP-3，S1/S2 必须旁路记录禁止阻断。
> 真门是 check-wiring 与 check-api-contracts（后者 gate 档实读为 `pr`）。

### P2 账本与计价正确性（**上架前必须完成**）

第一版把生死押在「计价口径修正」上却没给它一行任务，读者指出了这个矛盾。现补入：

| # | 缺陷 | 复现判据 |
|---|---|---|
| **e** | **计价口径**：`customerQuotaEnforcer.js:505-506` 把 `result.provider \|\| adapterKey` 传给 `tokenUsageService.calculateCost`，**是 provider 名不是 model 名**；而 `pricingService.js` 支持 model 级覆盖与分组倍率。同一次调用在两条数据面上算出的钱不同 | 同一次调用分别经两条路径计价，断言金额一致；且 claude-opus 与 gpt-4o-mini 的单价**不相等**（若相等即落进 provider 粗价表） |
| a | 预付语义（§三⑤） | 同一客户连充两次后 `checkQuota` 判定的月度上限 |
| b | 幂等键跨客户（§三⑥） | 用客户 B 的身份带客户 A 的 `idempotencyKey` 下单，断言拿到的不是 A 的订单 |
| c | 结算幂等 | 同一 `requestId` 重复 settle 后该月 usage 只增一次 |
| d | CAS（§三⑦） | 两个并发回调后额度增补等于两份而非一份 |

**gate**：每集各留 `repro-before.txt`（**原始输出，非转述**；规则 5 缺此项判 error）
+ `differential.md`；回归按真实 runner 跑（**不要**用
`jest tests/services/paymentGatewayService.test.js` —— 该路径不存在，
且两个支付测试是 `node:test` 风格，jest 加载会报 “Your test suite must contain at least one test.”）。

#### P2 执行记录（2026-10-15，存证 `works/data/khy/feedback/190-saas-p2-ledger/`）

已闭合 **a 预付语义 / b 幂等键跨客户 / c 结算幂等** 三项，均有 `repro-before.txt` /
`repro-after.txt` 原始输出。**实测推翻了本文的两处前提，须先更正：**

**更正一：`0` 在配额判定里意为「无限」，所以「只放开负数」是错的修法。**
`checkQuota` 的判据是 `limit > 0 && spent >= limit`，即 **0 = 不设限**。
若照本文原意只把 `Math.max(0, …)` 放开，则「退款退到 0」会把一个**付费客户变成无限额度客户**
——比「不能退款」更危险。故实际修法是三件事一起做：

| 子项 | 做法 |
|---|---|
| 余额可带符号 | `normalizeGrant` / `customerRegistry.normalizeQuota` / `customerQuotaEnforcer.normalizeQuota` 三处都改为保留 `monthlyBudgetCny` 的符号（`monthlyRequests` / `monthlyTokens` 仍夹到非负——它们是使用量上限，负值无意义） |
| 欠费拦截 | `checkQuota` 新增 `monthlyBudgetCny < 0` → `scope: 'arrears'`，`buildRejection` 给 `arrears_refunded` / 429，消息提示充值补足 |
| 恰好归零即拒 | `adjustCustomerQuota` 在「冲正后余额恰为 0」时抛错，并指向 `setCustomerEnabled(id, false)`——**撤销访问是另一个动作、有自己的原语**，不在这里猜调用方意图 |

**更正二：`normalizeGrant` 的零值回落会吃掉「显式全零」。** 改前只要三项全 0 就回落到订单
金额，所以「不发放」与「未指定」无法区分。现在只在**调用方一个字段都没给**时才回落，
显式给 0 即「不发放」。

**已闭合的实现细节**：

- **幂等键按 customerId 定域**：`createPayment` 原为 `store.payments.find(item => item.idempotencyKey === key)`
  全表匹配，B 猜到 A 的 key 就能取走 A 的订单。现为 `idempotencyKey === key && customerId === customer.id`。
  同客户重试仍幂等（回归断言 `replay.id === 'pay_a_1'`），跨客户不再串单。
- **结算幂等**：`settleOutbound` 加 `（customerId|userId, traceId）` 定容去重表（上限 5000，FIFO 淘汰）。
  `traceId` 是 proxy 每请求现生成的 UUID；流式与 JSON 路径各自的成功分支与 catch 分支都会结算
  （如 `proxyServer.js:250` 与 `:259`），先结算后抛异常即双计。
  **无 traceId 时不去重**（宁可重复也不静默丢计量），已单列为回归断言。

**回归**：`paymentGatewayService.test.js` 2 → 6 条；新增
`ai-backend/test/dataPlane.settleIdempotency.test.js` 3 条。

**本批次仍未修**（明确登记）：`adjustCustomerQuota` 的无条件覆盖写（并发回调仍可能丢额度增补，
需 CAS 版 `saveStore`）、计价口径传 `provider` 而非 `model`、限流按 token 而配额按 customer
维度（客户多签 token 可放大额度）。

#### P2-d 执行记录（2026-10-15，同一存证目录）

**实测推翻了「补 CAS 即可」这一做法。** 本文原写「需 CAS 版 `saveStore`」，实测表明**不够**：

| 候选病因 | 实测结果 |
|---|---|
| `saveStore(store)` 不传 `baseVersion`，无条件覆盖写 | 成立，但补上 CAS 后**仍有**丢更新（125 / 100）——CAS 的「检查再写」非原子，两个进程可在对方写入前都通过版本检查（TOCTOU） |
| `writeJsonAtomic` 的 tmp 名 `.tmp.<Date.now()>` 不含 pid，同毫秒两进程算出同一路径 | 成立，但不是主因；补 pid 后 ENOENT 消失，**EPERM 仍在** |
| tmp+rename 在 Windows 上不支持并发写同一目标 | **成立且是主因之一**：`EPERM: operation not permitted, rename …tmp.PID.TS -> …customers.json`，即**支付回调会直接崩** |

改前实测（`repro-cas-before.txt`，6 轮 × 6 并发各 +25 元，期望 150）：
`75 / 75 / 125 / 100 / 100 / 125`，并伴随子进程 EPERM 崩溃。

**实际修法**（`withStoreLock`，基于 `fs.openSync(lock, 'wx')` 的跨进程互斥）：

- 锁覆盖整段 read-modify-write，`saveStore(store, store.version)` 的 CAS 降为锁内第二道防线；
- 冲突时重读并**在对方结果之上**重放 delta，最多 8 次，超限报「lost N consecutive races」；
- 锁过期 10 秒自动打破（应对进程被 SIGKILL 的残留），5 秒拿不到锁则报错并指明手工删除路径；
- 同步等待用 `Atomics.wait`（本模块是同步契约，不引异步）。

改后实测（`repro-cas-after.txt`，同一条命令 6 轮）：**6/6 轮终值 150，零 EPERM/ENOENT。**

回归：`paymentGatewayService.test.js` 6 → 7 条，新增的并发断言**在 HEAD 版下确实变红**
（`not ok 7`），故它是真守卫而非空断言——同进程循环做不到这一点，改前的 bug 只在真正
并发的子进程间出现。

**本批次仍未修**（同族的其余写路径）：
`createCustomer` / `issueToken` / `setCustomerEnabled` 等其它写路径**未纳入同一把锁**，
仍可能与 `adjustCustomerQuota` 互相覆盖；`paymentGatewayService.saveStore` 同样是无条件写，
且其 eventId 去重只在单进程内有效。资金路径已闭合，订单表未闭合。

> ⚠ **回滚前必看**：若已在生产产生负余额记录，回滚代码会把它们夹回 0，而 0 = **无限**。
> 即回滚本身会把欠费客户变成无限额度客户。须先手工置回正数或停用客户。命令见
> 存证目录 `rollback.txt` §三。

### P2.5 收敛两个 proxyServer（单独立项，带 DELETE 存证）

把 `dataPlaneEnforcer` 的判定链搬进 backend 版后，删除或改薄 ai-backend 版。

**约束**：backend 版已 3102 行，超过 `LAYOUT-002` 的 2500 行上限，
**把 733 行并进去只会更超标**——须走 god-file governance（同名 re-export 壳 + DI、保函数体字节等价）。

**删除边界（第一版未交代，读者指出的正确批评）**：若走 god-file governance，
ai-backend 版变成 re-export 壳，则 **§五 登记的三个新模块（`usageLedger.js` / `billingPeriod.js` /
`dataRights.js`）必须建在 backend 版**，不能建在壳里。本文按此约定：
**这三个文件的落点一律是 `runtime/node/backend/src/services/`，不是 ai-backend。**

**gate**：`scrub-plan.md` + 可执行 `rollback.txt`（规则 7：rollback 缺失判 error）；
被删对象在 `docs/` 有大量背书（材料实测 20+ 份文档、92 处引用），
**须先救活或订正文档，不得静默清理**；`node scripts/ci/check-agent-rules.js --changed` 无该 finding；
代理路由矩阵与鉴钥令牌两套测试全绿。

### P3 客户自助面（**目标形态承诺过、但第一版无任何阶段承载**）

第一版在 §2.1 承诺「自助注册、开 key、充值、查用量、下载对账单、吊销 key」，
却在 P-1→P4 七个子阶段里**没有任何一个交付它们**，同时 Q5 又说「不做自助面则每个客户都要人代为开户」——
这是被文档认定为必需、却无阶段承载的能力。本版补上：

| 交付 | 复用 | gate |
|---|---|---|
| 注册 → 自动建 customer 并双向绑定 | `auth.js:198` 注册流程；`customerRegistry.js:127-146` 的 `resolveOwnerBinding` 双向唯一绑定 | 新客户注册后 `GET /api/ai-gateway/payments/my-customer`（`routes/aiGatewayPayments.js:55-67` 已存在）能查到自己的 customer |
| 开 key（多把并存 + scope + 过期） | `routes/apiKey.js`（**注意 `:188-189` 现会先 revoke 该用户所有旧 key，一人一 key 是硬伤**）；`@khy/shared/utils/apiKeyHash` | 一个用户能同时持有 ≥3 把不同 label 的 active key；只读 key 与全权 key权限可区分 |
| 充值 | `routes/aiGatewayPayments.js` + P2(a) 的余额语义 | 充 ¥100 后，跨月不重复发放 |
| 查用量 + 下载对账单 | `requestLogService.js` 的 `summary()` 五维聚合（`:201-273`）+ P1-2 的 traceId | 客户只能看到自己的行；对账单可下载且与逐行明细对得上 |
| 吊销 key | `customerRegistry.js` 的 issueToken/rotateToken/setTokenEnabled | 吊销到生效的时延被测量并写入契约（多副本下时延**【待验证】**） |

**注意**：`ApiKey` 模型当前只有 `userId/keyHash/keyPrefix/label/isActive/lastUsedAt` 六个字段，
**无 scope、无 expiresAt**——补这两列是 schema 变更，且属新功能（RUNTIME-008，须走需求五问）。

### P4 扩容与护栏（**条件阶段：仅当 §2.2 的需求规模被填上后才启动**）

第一版把 P3 当无条件阶段，读者指出这是循环论证。本版改为条件阶段：

(a) 两处限流统一到 `redisRateLimiter.js`；
(b) 月桶换共享后端，并给存量 `~/.khyquant/ai_gateway_customer_usage*.json` 定迁移路径
（先 dry-run 对账再切换，回滚靠单写者文件留着）；
(c) 上游成本护栏；(d) 对客数据留存与删除面。

**gate**：双实例打同一 `customerId`，`node scripts/ci/check-saas-multitenant.js --json`
断言用量合计等于两实例之和、限额判定只有一个实例放行；Redis 缺席时显式报 `degraded:true`。
该脚本同样**必须接进 package.json 与 pr-gate.yml**。

### P5 对外交付

走完 `DESIGN-API-002` §4 的版本化五要素与弃用流程；上游韧性接
accountPool / apiKeyPool / concurrencySlots；真实支付渠道端到端联调。

**gate**：D3 转 PASS（`?? = 0` 且 `D = 0`）；D9 **必须实跑并配「FAIL 即红」**（见 §三⑪）。

> **D2 的真源冲突——第一版说「只能由人裁决」，读者质疑。补两个选项的代价：**
>
> | 选项 | 做法 | 代价 |
> |---|---|---|
> | **甲** | 改 `DESIGN-DELIV-002 §4:245` 的 `artifactRoot.path` 为 `entries/pip` | 改规范与守卫阈值；需确认 `check-build-root` 对 legacyPath 的 sunset 处理能接受；改的是**判据** |
> | **乙** | 保留 `dist` 判据，在 `entries/pip` 产出后建软链或副本 | 复活带 `sunset: 2026-12-31` 的遗留路径；与 `BUILD-OUTPUTS.json` 的迁移意图相悖 |
>
> **本文倾向甲**（判据应跟随已完成的迁移，而非让迁移迁就判据），但**这仍是一次取舍不是技术判断，
> 最终由人拍板**。在裁决前 P5 的 gate 只保留 D3。

---

## 六、新机制登记（PROCESS-008）

四条新机制一律登记到 `docs/10_规范/registry/FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms[]`
（本轮实读：现有 33 条，全部 S1），**不新增 RULES-REGISTRY 条目**（ruleCount 96/94 已破口，§三⑭）。

| # | 机制 | 路径 | 阶段 | 为什么不能直进 S3 |
|---|---|---|---|---|
| 1 | 对客面守卫（open/旁路禁令 + 版本段 + 五要素 + traceId） | `scripts/ci/check-saas-surface.js`（+ 接 package.json 与 pr-gate.yml） | **S1** | 判据依赖 P1-0 的对客端点清单；**没有清单就无法定义「什么算对客端点」**，误报率无从谈起。清单建成前开闸必误报上百处。且按 PP-3，S1 读数不进 gate |
| 2 | 多副本一致性检查 | `scripts/ci/check-saas-multitenant.js` | **S1** | 需真实多实例环境，而当前默认 SQLite、第二副本就抢锁；守卫在单机上只会永远 PASS，恰恰是 §三⑪ 那种假绿。且 P4 本身是条件阶段 |
| 3 | 上游成本护栏 | `runtime/node/backend/src/services/gateway/upstreamCostGuard.js` | **S1** | 阈值（上游余额百分比、单客户流量占比）无可从本仓推出的默认值，必须由人给；无人给值就开闸 = 让守卫用编造阈值替人做停服决定 |
| 4 | 对客数据留存与删除面 | `runtime/node/backend/src/routes/dataRights.js` + requestLogService 增删入口 | **S1** | 保留期与删除语义必须由人先定；无人定就开闸 = 让守卫替人决定删数据还是留数据 |

### 明确**不**走 rollout 四阶段的

以下四项**是记账 / 中间件代码，不是门禁机制**。PROCESS-008 管的是「会阻断 AI 或 CI 的钩子 / 检查器 /
门禁」，它们的正确性由代码与回归测试保证，**不由 finding 拦截率保证**。
把它们挂成「观察者机制长期只记录」是错误的处置方式：

| 项 | 落点 | 正确路径 |
|---|---|---|
| append-only 用量账本 + request 级唯一键 | `runtime/node/backend/src/services/usageLedger.js` | 规则 5 缺陷修复，走 P2(c) |
| 账期与冻结（as-of 快照） | `runtime/node/backend/src/services/billingPeriod.js` | 同上，**且必须等人工裁决**（账期起止、跨月归属、调价是否重算已出账单） |
| 退款 / 冲正反向路径 | `runtime/node/backend/src/services/gateway/refundService.js` | 同上。**但见 §八 的读者纠正：这不是可选项，是上线硬阻塞** |
| `Idempotency-Key` 头 + 中间件 | `runtime/node/backend/src/middleware/idempotencyKey.js` | **先修 P2(b) 的语义再谈铺开** |

---

## 七、需求五问（RUNTIME-008）

> 落盘：`works/data/khy/feedback/<task-id>/requirement-5q.md`。
> source 只能引需求原话或本文实测记录，**不得编造用户原话**。

**Q1 谁用？**
两类：（a）有下游应用 / 服务要调大模型的开发者与小团队；（b）自建中转 / 聚合层的服务方。
**（b）的含义需要澄清**——若指「每个客户要独立部署与独立定价」，则它与 §八 的组织/白标需求冲突，
与非目标 4 矛盾；**本文倾向把（b）理解为「中转层的技术采购方，非白标客户」，
但这是本文的推断，未经确认，列入 §八。**（b）的付费意愿与量级**需人拍板**。

**Q2 什么时候用？**
按 `[DESIGN-ARCH-071]`：调用方是外部进程 / 脚本 / 第三方应用 → CH-3 CLI 或 CH-4 Web API，
二者收敛到同一个 HTTP 面；同进程内部复用走 CH-2 服务层直调。触发时机是「第三方程序发起推理调用」
这一瞬间，**无需先登录 Khy OS——API Key 即身份**。

**Q3 现在的替代做法是什么？**
(a) 自拿上游 key 直连供应商：零代码，但无统一定价、无缓存计费、无故障转移；
(b) sub2api / one-api 这类通用中转：纯转发，不带轨迹、审计与工具生态。
**竞品判断无可核实出处**（哪一年、什么版本、什么价位的产品），**【待验证】**，列入 §八。

**且须诚实**：本文无法给出「为什么要买我们」的有力论证。可列举的差异化候选是
18 适配器级联、`_cacheUsage.js` + `cacheEconomyStore.js` 的缓存计费探针
（能把「声称支持 prompt cache 实则全价」的中转商标出来）、跨机模型网格、逐请求审计流水——
但**这些在当前状态下并不构成「可售卖」**：`settleOutbound:307` 的计费分支只覆盖 `source:'customer'`，
而 §三②(e) 的计价口径使多数模型落进 provider 粗价表。
**按 P2 做完才成立，现在不成立。**

**Q4 成功长什么样？**
1. `curl -sS -H "Authorization: Bearer ${KHY_KEY}" "${KHY_ENDPOINT}/v1/chat/completions"
   -H 'Content-Type: application/json'
   -d '{"model":"<model>","messages":[{"role":"user","content":"hi"}]}'`
   （`KHY_ENDPOINT` 须由部署方按 `runtime/node/backend/src/constants/serviceDefaults.js` 导出，
   本仓无此 env 的默认值，不得在文档里写死主机名）
   返回 OpenAI 形状 completion，且 `GET /v1/usage/summary` 里该 key 的 used 随之增加。
2. 三种拒绝可分：超额 429 带 `used/limit/month`（`dataPlaneEnforcer.js:230-240` 已有）；
   无令牌 401 `missing_token`（`:252`）；未知令牌 401 `invalid_token`（`:247`）。
3. 治理全绿：`node scripts/ci/check-wiring.js` exit 0；
   `node scripts/ci/check-api-contracts.js` 覆盖数上升且 findings=0。

**Q5 不做会怎样？**
不做 P0：非 production 环境下 webhook 零校验可被刷额度；线上 quota 判定器 fail-open；
**一旦开放端口，这些是当天生效的**。
> ⚠ **第一版写「任何一次把端口暴露出去当天就会发生的事」，读者指出这是用条件性风险论证无条件投入。
> 本版更正**：P0 的正当性**不依赖**开放端口——⑤⑥⑦ 是**线上路径上今天就存在**的收入漏洞
> （`customerQuotaEnforcer` 就是线上判定器），即使只做本地自用，付费客户用预付额度时也会踩到 ⑤。
> **P0 该做的理由是「⑤⑥⑦ 今天就在漏钱」，不是「我们要开放端口」。**

不做客户自助面（P3）：每个客户都要人代为开户与充值——**这是一个被本文认定为必需、
却曾无阶段承载的能力**（第一版的缺陷，本版已补 P3）。

---

## 八、未决项（需人拍板，本文不代劳）

| # | 未决项 | 为什么本文不能替人定 |
|---|---|---|
| 1 | **单位经济**：每 token 卖多少、上游成本占比、毛利结构、保本点 | 全仓无一个价格数字。`pricingService.js` 是**计价机制**不是**定价决定**。**这是决定 B 的第二个必补证据** |
| 2 | **需求规模**：预期 QPS / token 量 | 无。**P4 因此是条件阶段**——第一版把 P3 当无条件阶段是循环论证（先假设要扩容再论证扩容难） |
| 3 | **工期与人力** | 零估算。**P1-0 的对客端点清单是估算的基数**，清单建成前本文不提供工期 |
| 4 | **退款是上线硬阻塞，不是可选项**（第一版误列为普通未决项，读者纠正） | `normalizeGrant` 的 `Math.max(0, …)` 把负值夹成 0，连构造冲正都做不到。**一个不能退款的收款服务无法上线**，须在 P2 完成前解决 |
| 5 | **跨客户可见性的验收标准** | A 能否读到 B 的用量 / 对账单 / 审计行 / 定价策略。已知落盘字段含 `customerId`，但**是否有 customerId 之外的隔离维度未查到**——【待验证】 |
| 6 | **运营责任**：SLA、故障公告、key 盗刷响应、滥用封禁与申诉 | 开闸当天就开始计费的东西，第一版**完全没提**。无 owner 的对客服务 = 把风险敞口开给未来的自己 |
| 7 | **第二类客户（Q1 的 b）是否意味白标/多租户需求** | 若是，与非目标 4 冲突；本文的推断未经确认 |
| 8 | **上游熔断阈值**（余额百分比、单客户流量占比） | 无可从本仓推出的默认值 |
| 9 | **数据保留期与删除权语义**（删数据后账单是否保留） | 合规口径属人的决定 |
| 10 | **webhook 金额校验在 production 的可达性** | 需先伪造合法 HMAC；本文**无证据**表明可达，故 §三① 已降级为【待验证】 |
| 11 | **真实第三方 SDK 的端到端验证** | 附录实跑清单无一条打向真实上游；「改 base_url 即可接入」是读码推断。**这是决定 B 的第一个必补证据** |
| 12 | **竞品判断的可核实出处** | Q3 的 sub2api/one-api 论断无版本、无年份、无出处 |
| 13 | **D2 真源冲突：改判据（甲）还是复活 legacy 路径（乙）** | 见 §五 P5，两选项代价已列出。本文倾向甲但仍需人拍板 |
| 14 | **「不开放端口、只做本地自用」这条路的关门时点** | 读者问「继续不开放会在什么时间点关门门外的什么机会」——**本文答不出**，因为无市场数据。这是决定 B 的反向论证，缺它则路线选择是默认而非论证 |
| 15 | **未配 relay 的 ApiKey 是否仍可用 owner 的 key**（`GATEWAY_USER_ISOLATION_STRICT` 默认值） | 2026-10-15 实施 P0 时试过「默认严」，判据读真实数据目录导致行为随本机漂移，遂撤回。两侧爆炸半径都真实：改严 → 现存单机用户的 key 全部 403；不改严 → 网关一旦多用户化，**任何注册用户都能白用 owner 的上游**。这是策略决定不是技术决定，须人拍板。落地只需一行 env：`GATEWAY_USER_ISOLATION_STRICT=true` |
| 16 | **「0 = 无限」这条旧约定是否保留**（2026-10-15 实施 P2 时新发现） | P2 只用「恰好归零即拒绝」的安全阀绕开了它，**没有改约定本身**。代价是：`customerRegistry.createCustomer` 的 `DEFAULT_QUOTA` 三项全 0，即**不显式给额度的客户默认无限额度**；且退款无法把余额恰好退到 0。要不要把「无限」改成显式哨兵、默认改为「必须显式给额度」，属策略决定且需要数据迁移，本轮不代劳 |
| 17 | **退款是否需要独立权限位与审批流** | `adjustCustomerQuota` 是管理员可调的**低层原语**，退款走它不区分「调额度」与「退钱」。是否拆出独立权限位与审批留痕，属产品与合规决定 |

---

## 九、路线选择的反面论证（读者指出第一版完全缺失）

**「不开放端口、只做本地自用」这条路会怎样？**

第一版没有这一节，等于默认了「要开放」。补上：

**这条路的收益**：零获客成本、零运营责任、零合规义务；
⑤⑥⑦ 的预付/幂等/CAS 三个漏洞**依然要修**（线上付费客户在用预付额度时会踩到），但不紧急；
P0 之外的一切（P1–P5）都可以无限期推迟。

**这条路的代价**：无法判断会关掉什么——因为本文**没有任何市场数据、客户访谈或竞争态势**。
能说的只有结构性事实：预付语义（⑤）与计价口径（②e）会持续让账本不可信，
**而账本不可信的越久，将来要做的历史数据迁移与对账成本越高**（存量 JSON 已按月分桶且无冻结点）。

**结论**：本文**不**主张立即上路，也**不**主张放弃。
它主张的是：P0 与 P2(e) 的账本修正无论走哪条路都要做（因为它们在今天的付费路径上就在漏），
而「是否上架」应等 §八 第 1、2、11、14 项被填上之后再谈。

---

## 非目标

1. **不新增 CLI 命令 / 别名 / handler**（实测 routerCommands 246/245、handlerFiles 158/155 已破口）。
   四条新机制全在 `scripts/ci/` 与现有服务目录。
2. **不新增 RULES-REGISTRY 条目**（ruleCount 96/94 已破口）。靠**扩写既有 API-001/002/003 的检查项与扫描根**覆盖。
3. **不把已破口的棘轮值当新基线**。正确表述是「**不得进一步恶化**」；基线只能由人在**实际退役后**下调。
   顺带退役建议（供人拍板）：`cli/handlers/proxy.js` 的 `proxy start/stop/status` 与对外 HTTP 面功能重叠，
   若 P2.5 收敛后 CLI 启动路径废弃，可作为 handlerFiles 158→157 的第一笔退役。
4. **不做组织 / 团队 / 席位**（全库无应用级 `tenantId` / `orgId`）。
   ⚠ **但这不等于不做租户隔离**——多客户的用量 / 对账单 / 审计 / 定价必须互不可见，
   验收标准见 §五 P1-3。
5. **不做发票 / 税务 / 多币种**。
6. **不把 khyquant 纳入本件**——它按申报口径是独立项目、另案申报。
7. **不把 ai-backend 版 proxyServer 的代码直接并进 backend 版**（会突破 LAYOUT-002 行数上限）；
   走 god-file governance 且作为 P2.5 单独立项带 DELETE 存证。
8. **不新增支付渠道以外的收款形态**。
9. **不把全量 286 个 `/api/*` 迁到 `/api/v1`**——版本段只加在 P1-0 清单内的对客端点。

---

## 附：本文事实来源

**本轮实跑（写本文时执行）**：

| 命令 | 输出 |
|---|---|
| `node scripts/ci/check-delivery-baseline.js` | `D2 GAP` / `D9 PASS`（注「检查存在且被门引用」）/ `[TS GAP] routerCommands=246/245 · aliasEntries=591/591 · handlerFiles=158/155 · ruleCount=96/94` / 汇总 PASS 8 · GAP 3 · UNKNOWN 1 |
| `node scripts/ci/check-api-contracts.js` | `[api-contracts] checked=61 findings=0 exit=0` |
| `node scripts/ci/check-golden-path.js` | `汇总: PASS 0 · FAIL 1 · SKIP 6 · UNKNOWN 0`，脚本自身 `exit=0` |
| `node scripts/ci/check-wiring.js` | `109 个检查器全部接线（豁免 11 项）` |
| `node scripts/ci/check-rollout-stage.js` | `mechanisms: 33`，`0 error(s), 3 warning(s)` |
| `node scripts/ci/check-repo-layout.js` | 仅既有 warning，本方案未引入新 finding |
| `node --test runtime/node/backend/tests/paymentGatewayService.test.js` | `# tests 2 · # pass 2 · # fail 0` |
| `node --test runtime/node/backend/tests/paymentGateway.httpRoutes.test.js` | `# tests 2 · # pass 2 · # fail 0` |
| `node node_modules/jest/bin/jest.js --rootDir runtime/node/backend tests/gateway/customerQuotaEnforcer.test.js` | `Test Suites: 1 passed · Tests: 12 passed` |
| `node -e "console.log('change_this_in_production'.length)"` | `25` |

**本轮实读的关键代码段**：`paymentGatewayService.js:340-395`（签名校验，确认 production 下拒绝）、
`:693-735`（processWebhook 入口）、`:735-770`（金额校验与履约）；
`dataPlaneEnforcer.js:127-182`（1.5 档完整逻辑）、`:240-258`（3/3b/4 档）、`:300-340`（计费分支与日志字段）；
`customerQuotaEnforcer.js:18-30`（fail-open 注释）、`:280-320`（quota-exempt 边界）、`:505-506`（计价传 provider）；
`customerUsageService.js:155-185`（checkQuota）；`customerRegistry.js:185-210`（saveStore CAS）、`:425-450`（adjustCustomerQuota）；
`userGatewayResolver.js:50-75`、`:160-180`；`ensureAuthSecret.js:35-108`；`ai-backend/server.js:120-132`；
`docker-compose.yml` JWT_SECRET 两处（`:48`、`:80`）。

**本文未复跑、来源为调查材料的项**（已在正文标注）：
MGMT-RPT-035 同类项目对比矩阵、`docs/` 内 proxyServer 的 92 处引用计数、
`billing.circuit_breaker` 不存在、`DESIGN-ARCH-185 §3.4` 的 13/14 采样结论、
`archive` 相关分支对象库损坏的恢复排查。

**本文新增的【待验证】项**（第一版误作已确认，第二版降级）：
webhook 金额校验在 production 的可达性（§三①、§八第 10 项）；
跨客户可见性是否有 customerId 之外的隔离维度（§五 P1-3、§八第 5 项）；
竞品判断出处（Q3、§八第 12 项）；
真实第三方 SDK 端到端兼容性（§三⑬、§八第 11 项）。

**命名与层级合规**：`check-repo-layout.js` 的 `docs-index-complete` 只扫 `docs/` 一级阶段目录
（正则 `^0[1-9]_`）下的**平铺** `.md`，`DESIGN-ARCH/` 是子目录不参与；`docs-index-first` 只查
`docs/` 一级子目录是否含居首位的 `00_INDEX_*`，本目录已有 `00_INDEX_DESIGN-ARCH-总目录.md`。
`ARCHITECTURE-POLICY.json` 管 `runtime/node/backend/src` 内的模块级边界，不收设计文档；
`PROPOSAL-ARTIFACT-INDEX.json` 只管外部借鉴提案工件（SOURCING-003/006），
本方案不借鉴外部项目，**故两份登记表均无需登记**。