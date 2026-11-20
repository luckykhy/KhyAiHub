# [DESIGN-ARCH-222] Composer 与 Suite 组合态设计稿 v2 —— 八项点名问题关闭 + D1–D10 对齐

- 生成：2026-11-17（v1 = `composer-suite.md`，2026-11-16，保留不动）。作者：Composer 与 Suite 设计修订者（工作流子代理）。
- 性质：**草稿**（`.khyos/refactor-drafts/`，过程态区）。本轮只写本文件；未改任何生产代码、未 git add/commit/push、未改版本号、未删文件。
- 证据标准：**仓库实测 > 2026-11-16 产品意图 > 方案原文**。每个结论给仓库相对路径 + 行号，或本会话实跑命令与输出；没读到的写「未核实」。
- 本稿材料：`composer-suite.md`（v1 全文）、`decisions-v2.md`（D1–D10 + CS-1..CS-8 定稿）、`dual-facts.json`、`assets-facts.json`、`rules-facts.json`（以上五份本会话全文读取）；另按需直读 `refactor-master.md` §8（三形态定义）、`core-handle.md`、`terminal-manifest.md`、`[DESIGN-ARCH-219]` 的关键行。

---

## 0 修订表（八项点名问题逐条留痕）

> 编号与任务书一致。每行给：v1 的写法（位置）→ v2 修法 → 本会话证据 → 连带改动章节。

| # | 问题 | v1 写法（位置） | v2 修法 | 本会话证据 | 连带 |
|---|---|---|---|---|---|
| 1 | 高危：租约把独立态互斥化 | v1 §3.2 表：独立态 desktop embedded「**必须同样抢 §3.3 租约**」；独立态 CLI「起 AI/会话写路径前先取租约；取不到 → 走 attached 客户端」；§3.3 第二实例定义为「任何试图取得 core 租约的进程」 | 租约**只在组合态 / attached 共享核心（composed-shared）生效**；独立态 embedded **不创建/不竞争/不删除**租约、不抢全局锁、**默认不读**（只读仅限「被 suite 装配」或「显式 `--attach` / `KHY_CORE_ENDPOINT`」两种情形，见 §2.2 L2/L9）；**N 个独立态终端可并存**（含现状 desktop host 内嵌 core 与 CLI 进程内 core 同时运行）；owner 移交 = 退场后交接 + stale 接管，过期以「心跳 45s + `process.kill(pid,0)`」双条件判；第二实例定义收窄为「共享核心候选者」。**口号改「单窗口 + 组合态单 core 租约」**（见问题 7） | 桌面锁与 CLI 锁互不相干：desktop 只有 `app.requestSingleInstanceLock()`（`apps/khyos-desktop/src/main/index.ts:114-124`，注释自陈「两个 remote hub 抢同一端口」的 GUI 事故，只管 GUI 实例）；CLI 侧只有 `daemon.pid`（`runtime/node/backend/src/services/daemonManager.js:19`、`:92-99` 探活、`:108-112` 已活即抛）。二者之间没有任何互斥 → 现状并存是常态。租约字段与心跳先例：`runtime/node/backend/src/webRemoteControl/protocol.js:79-82`（心跳 10s / idle 45s / 帧上限 256KB）；stale 自愈先例 `daemonManager.js:217-228` | §2 |
| 2 | 高危：新子档寄生 `check-core-layers.js` 被父档 exit 1 连带阻断 + 登记已 authority-drift | v1 §1.3「新子档 `check:core-layers --portable`」、§4.1「`check:core-layers --suite-fork`」、§9 T1 同款、§12「检查器接线复用 `check-core-layers` 别名」 | 改为**独立执行器** `scripts/ci/check-core-boundary.js`：自带 `const GUARD_STAGE='S1'`、S1 **恒 exit 0**、支持 `--changed/--json`、finding 一律 `severity:'warning'`；**不挂** `check-core-layers.js` / `check-repo-layout.js`；宿主既有红列作为**施工前置**随文记录，不声称已绿 | 本会话实跑：`node scripts/ci/check-core-layers.js` → **exit 1**，11 条 ❌（2×`core-budget-lines`：toolUseLoopCore 30629>30175、aiGateway 71833>71078；8×`visual-budget-files/lines`；1×`visual-lazy-regression`）；`node scripts/ci/check-rollout-stage.js` → 0 error / 44 warning，含 `core-layers-guard` 两条：「samples 自填无 source」与「声明阶段权威是 check-core-layers.js 的 STAGE 常量，但文件里找不到该常量」→ `rollout-stage-authority-drift`；`scripts/ci/check-core-boundary.js` 本会话实测 **ABSENT** | §8 |
| 3 | T1 非 GUI 子集三端不可无人值守 | v1 §9 T1：对 `cli` / `cli-node` / `web` / `web-quant` / `mobile`「执行 entries.json 的 launch 并 `khy entry probe`」 | CI **只跑 headless 探针**（`entry probe --json`）；CLI 改**非交互子命令**（`--version` / `entry list --no-probe`）；web-quant 改 **BUILD-OUTPUTS 产物 + `--host 127.0.0.1` 且不开 `--open`**；**mobile 移出无人值守清单**；GUI 端（desktop / provider-hub）保持 probe-only | `entries/entries.json`：cli launch `mode:"attach"`（:49-50）、cli-node `attach`（:73）、desktop/provider-hub `detach`（:95/:119）、web-quant launch = `npm run dev` `detach`（:164-165）；`delivery/channel/khyquant/frontend/package.json` 的 `dev` = `"vite --host 0.0.0.0 --open"`、`dev-no-browser`/`dev-auto-port` 同为 `0.0.0.0`；本会话实跑 `node runtime/node/backend/bin/khy.js entry probe --json` → 7 端全部 repo 级 `ready`、`drift=null`，`mobile.machine.ok=false`（detail「本机缺少 flutter，本机无法构建或运行本端」）；`node .../bin/khy.js --version` → exit 0 / `1.2.2` / 112ms；`node .../bin/khy.js entry list --no-probe` → exit 0 | §9 |
| 4 | 三证③无可读数据面 | v1 §3.3 证③：「计量记录带写者身份；断言近窗口内所有写入的 bootId 唯一」——没有定义任何落盘 schema | 定 **schemaVersion=2** 草案：`meta.{updatedAt,lastWriterId,lastCoreId}` + 既有 `daily/monthlyTotals` 聚合保留 + 新增 `records[]` 逐条（`{at,writerId,coreId,provider,model,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,costUSD}`，环形上限 500）；**`coreId` = core 进程实例 id，计量 schema 与租约条目统一用同一字段名 `coreId`**（219 D4 要求的 coreId 不丢；按 `[DESIGN-ARCH-219]` §1.2 偏离 2 不再使用 `bootId` 别名，校验脚本断言 `records.coreId === lease.coreId`）；writerId 枚举登记在 UsageStore 叶子；**DATA-SSOT 登记** fact `token-usage-file`；**DATA-LOCATIONS 走 knownGaps 先例**（user-home 段不在任何 root 之下，不可硬塞） | 本会话实测 `%USERPROFILE%/.khyquant/token_usage.json`：顶层键 **仅 `["daily","monthlyTotals"]`**（读取时 daily 25 条），单条仅 7 个聚合字段（inputTokens/outputTokens/totalTokens/requests/costUSD/cacheReadTokens/cacheWriteTokens），全文 **无 writerId / coreId / records**；两次读取间隔内文件从 3969 → 5793 字节——本会话的 `-p` 探针（见 §1.2 F21）发起了一次真实请求并触发计量写入，正好演示 §5.4 的多写者覆盖面；**文件是运行时可变物，断言不锚字节数**。另：`docs/10_规范/registry/DATA-SSOT.json` 全文无 `token_usage`；`DATA-LOCATIONS.json` 无 `token_usage`，且 `:233-255` 的 `knownGaps[phone-discovery-user-home]` 明写「roots 只登记仓内相对路径…user-home 段（~/.khyquant/...）不在任何 root 之下…需要独立的 schema 裁决」 | §4 |
| 5 | `usageTracker.js` 自持第二份 PRICING 与 jsonl 入账路径未纳入收敛 | v1 只在 F2 提「两份 pricing 表漂移」，§3.3 未处置 usageTracker | 定：**定价副本 4 份收敛到 `tokenPricing.js` 叶子**（backend 已委托，ai-backend / khyquant / usageTracker 三份待并）；发现**键域不同**（叶子 provider 键 vs usageTracker model 键）→ 叶子增设 `MODEL_PRICING` + `calculateModelCost`，usageTracker 委托；**jsonl 路径**（`usage-<date>.jsonl`）在启用前必须登记，未启用则进 KNOWN-EXCEPTIONS（休眠写者条目），不得沉默 | `runtime/node/backend/src/services/usageTracker.js:30-41`（PRICING 以 model 为键，10 键）、`:49-59`（`_logDir=null` / `_enableLogging=false`）、`:329-338`（`usage-<date>.jsonl` 写入）、`:342`（`new UsageTracker()` 无 opts → 休眠）；`:177-182` 写 `eventLog` 的 `usage.record`；`runtime/node/backend/src/services/gateway/aiGatewayGenerateMethod.js:30`（require usageTracker）、`:6108`（`usageTracker.record`）；`tokenPricing.js:37/:40-55`（provider 键 14 项，含 DeepSeek/Together）、`:12-34` 叶子契约（I/O 与可变状态刻意留壳） | §4 |
| 6 | T6「已知例外」没有机读载体 | v1 §11-4 待拍板、§9 T6「如实写进期望输出」，无载体 | 新立 `docs/10_规范/registry/KNOWN-EXCEPTIONS.json`（条目 `id/target/owner/reason/expiry/reverify`）；消费者 = `check-core-boundary.js --lan`（T6 子档）：命中放行、过期打 warning；**表与消费者未同批落地前 T6 不判绿**；不复用 `ARCHITECTURE-POLICY.json` 的 `exceptions`（死字段） | `docs/10_规范/registry/` 目录实测仅 `ARCHITECTURE-POLICY.json` / `BUILD-OUTPUTS.json` / `CORE-LAYERS.json` 命中 KNOWN/EXCEPT/POLICY；`KNOWN-EXCEPTIONS.json` **ABSENT**；`ARCHITECTURE-POLICY.json` 的 `exceptions` 实测 `[]`，`scripts/ci/check-zcode-baseline.js` 全文 **0 处** `exceptions` 引用（只读 `policy.global`/`policy.modules`），且文件头 `:2` 自述「细粒度模块边界策略…S1 观察者档」，语义是 file-size/禁环/禁深引用，不是网络例外 | §7 |
| 7 | 单进程口号不实 | v1 §10-1「suite『单进程』→『单窗口 + 单 core 租约』」只改了一半，未写进程事实 | 口号统一为「**单窗口 + 组合态单 core 租约**」，并写清 Electron 四进程边界：main（单实例锁 / fork host / pty / 设备车道 / stores）、preload（contextBridge 收口；`ipcRenderer.invoke` 140 处 / `.on` 11 处 / `.removeListener` 11 处，通道名全为裸字符串、无常量表）、renderer（零直连网络）、host 子进程（embedded core 容器，20 处 `nodeRequire`） | `apps/khyos-desktop/src/main/index.ts:1-22`（装配 keyManager/editor/ptyHost/remote/amoon/agentbus + settingsStore）、`:114-124`（单实例锁）、`:789-799`（`fork(finalHostPath, [], {stdio:[...,'ipc']})`）；`apps/khyos-desktop/src/preload/index.ts:348`（`contextBridge.exposeInMainWorld('__KHYOS__', api)`），全文 350 行，按方法拆分实测 invoke 140 / on 11 / removeListener 11（不同正则口径可能多算 1 处 `once` 类调用，**断言不锚单一总数**，只锚「通道名裸字符串、无常量表」）；`apps/khyos-desktop/src/renderer/App.tsx:1-22` 全为 React/UI/state 导入，`findstr /s /n /r "fetch( WebSocket( EventSource(" apps\khyos-desktop\src\renderer\*.ts*` → 仅 2 处注释命中（`assets.d.ts:21`、`petRealisticAssets.ts:24`）；`apps/khyos-desktop/src/host/index.ts:68`（`createRequire`）、`:70-74`（`resolveKhyOsDir`）、`:124-132`（`loadGateway` 动态 require backend `aiGateway.js`）、`:330-337`（`nodeRequire` 加载 backend 的 tokenUsageService），全文 20 处 `nodeRequire(` | §3.4 |
| 8 | D6 LAN：suite 注入 / ai-backend 例外 / 显式 opt-in | v1 §5「§11-4 拍板：组合态是否由 core 注入 AI_MGMT_HOST=127.0.0.1」；§9 T6 期望值悬空 | 定：suite **只对自己装配面拉起的 listener** 注入 `AI_MGMT_HOST=127.0.0.1`；仲裁顺序写死 **用户显式 env > suite 注入 > serviceDefaults 默认**；ai-backend 既有 `0.0.0.0` **保留**并登记为 KNOWN-EXCEPTIONS 条目；LAN 保持显式 opt-in（`lanEnabled` / `KHY_REMOTE_BIND_HOST`） | `runtime/node/ai-backend/server.js:123-138`（默认 `'0.0.0.0'` → serviceDefaults 覆盖 → `process.env.AI_MGMT_HOST` 优先级最高）、`:177`（`app.listen(p, AI_MGMT_HOST)`）、`:204-205`（LAN 横幅）；`runtime/node/backend/src/constants/serviceDefaults.js:313-314`（`AI_MGMT_HOST = process.env.AI_MGMT_HOST || '0.0.0.0'`）；`runtime/node/backend/src/webRemoteControl/server.js:86-91`（`bindHostOf = envBind || (lanActive ? '0.0.0.0' : '127.0.0.1')`）；`serviceDefaults.js:112-115`（`REMOTE_DEFAULT_PORT=9413`、`REMOTE_BIND_HOST = process.env.KHY_REMOTE_BIND_HOST || ''`，注释 :113-114「刻意不提供 '0.0.0.0' 默认值」） | §7 |

### 0.1 v1 中被决策 D1–D10 直接覆盖的写法（对齐表）

| v1 位置 | v1 写法 | D 决策 | v2 改为 |
|---|---|---|---|
| §1.1 表 | core 源码落 `runtime/node/backend/src/core/`；生态发布物 = `works/ship/npm/` 新增 `@khy-os/core` | D1 | core 落 `runtime/substrate/platform/packages/core`（`@khy/core`，exports `./contracts` `./client` `./server`，`.js` + 手写 `.d.ts`、无编译步骤）；发布两档（档 1 contracts+client 可独立 npm 安装、零 `node:`、零副作用；档 2 embedded 全量随 npm `bundled/` + pip wheel，不承诺源码级轻包）；生态接入通道取 terminal-manifest §9.4 (a)：`@khy/plugin-sdk` 补 `files`/`exports`/`publishConfig` 并与 `@khy/core` 同批 npm 发布 |
| §1.1 表 | composer 落 `runtime/node/backend/src/composer/` | （决策未覆盖，本稿定） | composer 落 `apps/suite/src/composer/`（suite 自有纯库；CI 以相对路径 require）。理由：v1 用 R1 的 `src/composer/` 豁免把「suite import backend 源码」合法化；core 迁出 backend（D1）后该豁免只剩 composer 一条理由，而 suite 跨 workspace 相对 import backend 会触发 `check-repo-layout.js` 的 cross-layer-require（本会话实测 37 处既有命中）——composer 归 suite 自有可同时去掉豁免与跨层引用 |
| §1.3 / §4.1 / §9 T1 / §12 | 新子档挂 `check:core-layers --portable/--suite-fork` | D3 | 独立执行器 `scripts/ci/check-core-boundary.js`（S1、恒 exit 0、`--changed/--json`、warning） |
| §2.1 CLI 面 | `khy suite validate` / `khy suite build-config` | D5 | **不开新 CLI 命令**；验收走 `npm run` 脚本 + `node --test`；用户可见文案只引用既有 `khy doctor` / `khy entry` |
| §3.3 | `khy core verify-single --json` | D5 | 改为 **npm 脚本**（如 `npm run verify:core-single --json`）+ finding 名 `metering-dual-writer`；不建命令 |
| §3.3 证③ / §11-3a | 计量收敛列为待拍板 | D4 | 定：UsageStore 叶子（最小版委托 `tokenPricing.js`）、双活跃写者收敛、khyquant 休眠写者第三顺位、schema writerId/coreId、收敛前一律 `metering-dual-writer` |
| §4.2 档 A / §11-7 | web-quant 组合态「禁用 dev server」+ 待拍板 (a)/(b) | D7 | 定：只装 BUILD-OUTPUTS 的 `quant-frontend-dist`（`entries/quant-frontend`）；web-quant 清单/投影的 `artifactOutput` 由生成器从 `null` 补为 `quant-frontend-dist`（**不手改投影**）；开发态 `--host 127.0.0.1` 且不开 `--open`（改 khyquant 脚本属实施期） |
| §5 / §11-4 | 逐 listener 断言 + 待拍板 | D6 | 见修订表 #8 |
| §8 / §11-14 | suite 包管理 α/β 待拍板 | D8 | 方案 α：`pnpm-workspace.yaml` 加 `- apps/suite`、根 `workspaces` 同加；同批把 `electron-out`/`electron-dist` 的 rebuild 从 `pnpm run build --filter khyos-desktop` 修正为 `npm run build --prefix apps/khyos-desktop`；`apps/suite` 属 needs-registry-change（LAYERS `apps` 释义 + `[DESIGN-LAY-005] §1` 表，人批准） |
| §10-1 | 「单进程」→「单窗口 + 单 core 租约」 | 问题 7 | 见修订表 #7 |
| §10-6 | 「在册端加字段」+ entries.json 手写真源 | D2 | 7 份 `khy.terminal.json` 为编写真源；`entries/entries.json` 降为逐字节可复算的生成投影（入库）；同批交付 `gen-entry-matrix.js` + `check-manifests.js`（S1）；逐字节保留 `kinds/statuses/modes` 三块顶层枚举 |
| §11-9 | LAYERS.apps 释义待拍板 | D8 | 需人批准项（保留在 §11-2） |
| §11-6 | 新增 CLI 的棘轮问题 | D5 | 消失（不开命令） |

---

## 1 事实基线（本会话实测 / 沿用材料）

### 1.1 沿用 v1 §0.1 的 F1–F13（本会话抽查复核）

| # | 事实 | 本会话复核 |
|---|---|---|
| F1 | 计量两个活跃写者同写 `~/.khyquant/token_usage.json` | ✅ backend `tokenUsageService.js:27`（`USAGE_FILE = path.join(os.homedir(),'.khyquant','token_usage.json')`）；ai-backend `tokenUsageService.js:12` 同路径；两者 `saveUsageData` 写同一文件（backend `:164-181` tmp+rename；ai-backend `:60-68` `writeFileSync`） |
| F2 | pricing 表已漂移过（backend 事故注释） | ✅ backend `tokenUsageService.js:13-17`（[MGMT-RPT-035] 注释原文）；ai-backend `:15`（`USD_TO_CNY = 7.25`）、`:18-31` 自持 12 键表 |
| F3 | `aiGateway` 是模块级单例导出 | ✅ `runtime/node/backend/src/services/gateway/aiGateway.js:2646`（`const gateway = new AIGateway()`）、`:2685`（`module.exports = gateway`） |
| F4 | 「默认 loopback」只对 webRemoteControl 成立；ai-backend 默认 0.0.0.0 | ✅ 见修订表 #8 证据 |
| F5 | 配对/token 生命周期已存在 | ✅ `runtime/node/backend/src/services/devicePairing.js:62-63`（TTL 24h / 10min）、`:278-293`（revoke）、`:301-327`（validate + 过期 EXPIRED） |
| F6 | token 只存内存，落盘 = 第二真源 | ✅ `runtime/node/backend/src/webRemoteControl/pairingCode.js:11-13` 注释原文 |
| F7 | 桌面已有独立设置真源 `settings.json`（含 dataPath 指针，必须引导前可读） | ✅ `apps/khyos-desktop/src/main/settingsStore.ts:2-9` 头注（「settings.json holds the dataPath pointer itself, so it must stay findable at boot」）、`:15`（`baseHomeFile, SETTINGS_FILE`） |
| F8 | web-quant 端条目 artifactOutput=null / ports=[]，dev = 0.0.0.0 --open，但 BUILD-OUTPUTS 已有 quant-frontend-dist | ✅ `entries/entries.json:153-176`（`:170` null、`:171` []、`:172-175` 三条 note）；`delivery/channel/khyquant/frontend/package.json` scripts（本会话全文）；`BUILD-OUTPUTS.json` 的 `quant-frontend-dist` → `entries/quant-frontend`，rebuild `npm run build --prefix delivery/channel/khyquant/frontend`，note 自陈「补上 entries.json web-quant 条目 note 里登记的缺口」 |
| F9 | 插件启用是双闸（`extensions_state.json` enabled ∧ flagRegistry 门） | ✅ `runtime/node/backend/src/plugin-loader/index.js:595-596`（discover 已过滤 + 双门语义）；`runtime/node/backend/src/utils/flagRegistry/index.js:3975-3981`（双闸 fail-closed 原文 + `KHY_PLUGIN_LAZY_LOAD: {mode:'default-on', default:true}`） |
| F10 | 已有三把互不知情的锁/登记（daemon.pid、ai_manage_runtime.json 双写、Electron 锁） | ✅ `daemonManager.js:19`（PID_FILE）、`:23-24`（RUNTIME_FILE + LEGACY_RUNTIME_FILE）；`daemonEntry.js:65-83`（payload `{pid,apiPort,startupAt,updatedAt,source}`，**无 coreId**）、`:74-78`（双写）；`main/index.ts:121-124` |
| F11 | `require(变量)` 只计数不解析 | ✅ `scripts/lib/requireGraph.js:122`（返回 `{top,lazy,dynamic,mode}`）、`:153-158`（非字面量 → `dynamic++`）、`:192-195`（回退正则 `require\(\s*[^'")\s]` 再计数） |
| F12 | 本分支新增 agentbus 车道（无鉴权 / 回环硬编码 / 墙钟预算 / 第二处 usage 读数） | 沿用 dual-facts（`:94` LOOPBACK_HOST、`:753-757` no token/no auth、`:96-99` BUDGET）——本会话未重读 agentbus 文件，**未复核** |
| F13 | `apps/` 下没有任何 pnpm workspace 成员 | ✅ `pnpm-workspace.yaml` 全文 9 项、无 apps/；根 `package.json` `workspaces` 同 9 项；`pnpm-lock.yaml` 实测 **7 个 importer**（`.`、`delivery/channel/khyquant/frontend`、`delivery/web/ai-frontend`、`delivery/web/provider-hub`、`runtime/node/ai-backend`、`runtime/node/backend`、`runtime/substrate/platform/packages/shared`）→ ui-shared / plugin-sdk 的 importer 本就缺失 |

### 1.2 本会话新测事实（F14–F21）

| # | 实测 | 证据 | 后果 |
|---|---|---|---|
| F14 | **宿主既有红列（施工前置，不得声称已绿）** | `check-core-layers.js` exit 1 / 11 条 ❌（明细见修订表 #2）；`check-rollout-stage.js` 0 error / 44 warning（含 `core-layers-guard` 的 samples-declared-only + authority-drift）；`check-delivery-baseline.js --json` stage **S1**，counts PASS 7 / GAP 5，findings 含 `delivery-repo-integrity`（`git fsck` 退出码 2、missing blob=10 / tree=9 / commit=3）、`delivery-artifact-missing`（dist/ 缺 wheel、sdist）、`delivery-clone-incomplete`（`??=346 · D=9`，改动集 772 项）、`delivery-debt-not-converging`、`delivery-surface-ratchet-breach`（`routerCommands=249/245 · aliasEntries=595/591 · handlerFiles=167/155 · ruleCount=101/94`）；`check-repo-layout.js` exit 1（counts：root-uncatalogued 110、cross-layer-require 37、domain-direction 199、functional-unit 277、entry-buffer 2416） | 所有验收口径写成「不新增 error 条目 + 相关读数不劣化」，**禁止**写「全绿」；`check-core-boundary` 必须是独立执行器，否则会被这些红档连带 |
| F15 | `token_usage.json` 现状无写者身份、无逐条记录 | 见修订表 #4 证据（顶层仅 daily/monthlyTotals，无 writerId/coreId/records） | 三证③今天**没有可判数据面**；先定 schema 再谈 single |
| F16 | zod 在仓内六处不可解析，semver 是幻影依赖 | 本会话探针：`require.resolve('zod')` 于 `.`、`runtime/substrate/platform`、`.../packages`、`.../packages/shared`、`runtime/node/backend`、`runtime/node/ai-backend` **全部 NOT RESOLVABLE**；`semver` 六处全部解析到 `D:\Portable\khy-os\node_modules\semver\semver.js`（根/backend/ai-backend 的 package.json 均未声明） | 支持 D9：core 显式声明 `zod` 精确锁版 + conformance 测试；拒绝 semver |
| F17 | 本重构的新增物全部尚不存在 | `scripts/ci/check-core-boundary.js` ABSENT；`scripts/ci/gen-entry-matrix.js` ABSENT；`scripts/ci/check-manifests.js` ABSENT；`khy.terminal.json`（全仓 `dir /s /b`）**NONE FOUND**；`docs/10_规范/registry/KNOWN-EXCEPTIONS.json` ABSENT；`runtime/substrate/platform/packages/core` 不存在（packages 下仅 moonbit-plugin-sdk / plugin-sdk / shared / ui-shared） | 本稿所有「目标态」验收一律标注**未执行** |
| F18 | 现有 headless 探针可用且诚实 | `node runtime/node/backend/bin/khy.js entry probe --json` → 7 端 repo 级全 `ready`、`drift=null`；`mobile.machine.ok=false`（「本机缺少 flutter」）；`node ... --version` → exit 0 / `1.2.2` / 112ms；`node ... entry list --no-probe` → exit 0 | T1 的无人值守面有现成机判命令；mobile 的本机缺工具链被如实分离（probe.js:3-19 的四项只读检查） |
| F19 | renderer 无直连网络 | `findstr` 在 `apps/khyos-desktop/src/renderer/**/*.ts*` 对 `fetch(`/`WebSocket(`/`EventSource(` 仅 2 处注释命中；`App.tsx:1-22` 全为 UI/state 导入 | 组合态壳的「事件转发经 preload」有事实基础（§3.4） |
| F20 | 租约/端口漂移的既有先例齐全 | 心跳 10s / idle 45s（`protocol.js:80-81`）；stale pid 自愈（`daemonManager.js:217-228`）；`process.kill(pid,0)`（`:92-99`）；端口顺延 +10 且 `host:'127.0.0.1', exclusive:true`（`aiManagementServer.js:3538-3573`） | §3 的租约规则全部落在既有手法上，不新造机制 |
| F21 | 既有 headless 接力入口是 **`khy -p "<提示>" --continue`（或 `--resume <id>`）**；`chat` 不是命令，且 `--continue` 必须写在 `-p` **之后** | `printOutputFormat.js:46-47`（`--continue, -c` / `--resume <id>, -r <id>` 是 `-p` 的打印参数）、`:182-192`（在 `tail` 内解析）；`bin/khy.js:1944-1948`（`printIdx` 取 `--print`/`-p`，`tail = args.slice(printIdx+1)` → **`-p` 之前的 token 不参与解析**）。本会话探针：`node bin/khy.js zzz-unknown-cmd -p hello` → 未报 unknown-cmd，直接进入 print 分支并发起真实请求（20s 超时被杀）——证明前导 token 被静默忽略。`chat` 在 `router.js` 全文 0 处命中；`aliases.js:269-277` 记载该动词已退役（`khychat`/`aichat` → `gateway manage`，打开的是浏览器页，不是 headless 对话） | T4 必须用上述正确语序；写成 `khy chat --continue -p …` 会静默丢掉 `--continue`，测到的是全新会话（假验收）。T4 还需本地 stub 网关才可无人值守（§9.1） |

### 1.3 登记面事实（D2/D4/D6 需要）

- `docs/10_规范/registry/DATA-SSOT.json`：`scan.include` 实测含 `"entries/"`（以及 runtime/、delivery/、apps/、scripts/、tools/、works/ship/、docs/10_规范/registry/）；`facts` 11 条、`sources` 25 条，**无一条锚定 entries**，全文无 `token_usage`。
- `scripts/lib/ssotDataGuard.js:52`：`VALUE_KINDS` 仅 `js-const / py-const / text-const / json-pointer / toml-key / json-count`；`:432-441`（kind 非法、`json-count` 无标识符豁免）、`:440-441`（json-count 只判真源自洽，不走影子副本）、`:444-457`（mirror 必须带 reason）、`:616-617`（无 matcher 即 `continue`）。
- `docs/10_规范/registry/DATA-LOCATIONS.json`：`ruleId: LAYOUT-007`；`roots` 仅 khy / khyos / state 三个仓内相对根；`knownGaps` 先例在 `:233-255`（`phone-discovery-user-home`，字段 `id/status/openedAt/path/segment/gap/writers/readers/consequence/mitigation/literalSites`）；`tiers` = T0-authoritative / T1-domains / T2-regenerable / T3-archives / T4-transient。
- `docs/10_规范/registry/BUILD-OUTPUTS.json`：30 条 outputs；`quant-frontend-dist`（path `entries/quant-frontend`）、`ai-frontend`（`entries/ai-frontend`）、`electron-out`/`electron-dist`（rebuild 实测 `pnpm run build --filter khyos-desktop`，目标不在工作区）、`electron-builder`（`npm run electron:build --prefix apps/khyos-desktop`）。
- `docs/10_规范/registry/FEATURE-OWNERSHIP.json`：`rollout.mechanisms` 40 条；`core-layers-guard` 的 `samples.observed=3` **无 source**；合法先例 `domain-direction-guard`（key `counts.domain-direction`）、`entry-buffer-guard`（key `counts.entry-buffer`）。
- `scripts/ci/check-core-layers.js`：1149 行；`:38` `CONTRACT_PATH` → `CORE-LAYERS.json`；exit 逻辑 `:980` / `:1148` `process.exit(errors.length === 0 ? 0 : 1)`；**无 `GUARD_STAGE` 常量**（本会话 grep 仅见 process.exit 行）。
- `scripts/ci/check-rollout-stage.js:157-168`：`pickKey` 按点路径取值，`:165-167` 对 `typeof cur === 'object'` 直接判「不是标量读数」。
- `scripts/ruleguard/lib/run.js:337` / `:345`：`isBlocking = finding.severity === 'error'`（无理由抑制）/ `isBlocking = strength === 'blocking' && severity === 'error'`。
- `docs/10_规范/registry/ARCHITECTURE-POLICY.json:2`：自述「细粒度模块边界策略…S1 观察者档」；`exceptions` 实测 `[]`，`check-zcode-baseline.js` 0 处引用（只读 `policy.global`/`policy.modules`）。

---

## 2 形态定义（三形态）与租约规则（问题 1、7）

> 三形态口径沿用 `refactor-master.md:218-242`（§8 三形态验收矩阵）：「独立态 / 组合态 / 生态态」，与产品意图 2/3/4 一一对应。

### 2.1 三形态定义

| 形态 | 定义 | 现状锚点 |
|---|---|---|
| **独立态** | 每个终端只带 core(+shared) 单独构建、单独运行；不依赖 composer/suite；终端之间互不感知 | desktop host 内嵌 core（`host/index.ts:68-74`、`:330-337`）；CLI 进程内 require（`aiGateway.js:2646` 单例）；web 是 attach 客户端（`dual-facts` feasibility 条） |
| **组合态** | suite 装配：**一个窗口（指 suite 自己的 view 窗口）**、一套设置、**一个共享 core 实例**；不 fork/复制终端代码；被装配的终端必须处于 attached（L9） | suite 尚不存在（`apps/suite` 为新增）；共享 core 宿主候选 = daemon（`daemonManager.js`）/ 独立 Node 服务；desktop / provider-hub 是外部窗口，attached 化前不装配（L9/§5.3 档 B） |
| **生态态** | 第三方拿 `@khy/core`（contracts+client）+ `@khy/plugin-sdk`，按 KhyOS 规则实现终端/插件接入；不依赖 KhyAiHub 私有路径或 monorepo-only 解析 | `@khy/core` 尚不存在（F17）；`@khy/plugin-sdk` 在（141 行、零依赖零副作用，dual-facts）但发布面待补（D1 通道 (a)） |

### 2.2 租约作用域（修订表 #1 的规则正文）

**一句话：租约 = 「共享核心」的占用登记，不是「任何 core」的全局锁。**

| 规则 | 正文 | 机判/先例 |
|---|---|---|
| **L1 只在组合态 / attached 共享核心生效** | 租约文件 `<dataHome>/core-instance.json` **只由共享核心持有者创建**：(a) 组合态 suite 拉起的共享 core；(b) **attached 共享核心**——作为服务被远端消费者（web / mobile / attached CLI）共享的 daemon / ai-backend 服务态。终端内嵌 core（CLI 进程内、desktop host 子进程）**不创建、不竞争、不删除**该文件；**读取规则见 L2**（默认不读，仅装配态/显式 attach 只读） | 组合态判定 = suite 启动路径；服务态判定 = daemon/service 启动路径（不靠运行时计数） |
| **L2 独立态不抢全局锁；读取只发生在显式情形** | 独立态 embedded **不参与互斥**：无 `open(...,'wx')` 竞争、无心跳义务、无过期接管。**默认也不读租约**；只读仅限两种显式情形：(i) 终端被 suite 装配（组合态，§5.3 档 A/C）；(ii) 用户显式 `--attach` 或 `KHY_CORE_ENDPOINT` 指定共享核心。租约条目 schema 保留 `mode` 字段（合法值 `composed-shared` / `independent`），但 **`mode=independent` 不落盘**——它只出现在进程自述面（`verify` 输出的 `mode` 字段、`khy.core.ready.v1` 事件 payload）。独立态的 `mode` 由验证脚本按「存在且新鲜的租约文件」推导：有 → `composed-shared`，无 → `independent` | 本会话实测：桌面与 CLI 的锁互相独立（`main/index.ts:114-124` vs `daemonManager.js:19/:92-99`），两者并存是现状；v1 的「都必须抢租约」会把这个常态判成冲突。验收 a1 以此判定：临时数据家里预置一个指向死 pid 的假租约，跑独立态 `--version`，断言 exit 0、不报租约冲突、不与假租约交互 |
| **L3 多独立态终端并存合法（R1–R4）** | **R1 并存**：任意 N 个独立态终端可同时运行（现状即此）。**R2 互不感知**：独立态默认不读、不写、不竞争租约、不尝试 attach（attach 只在显式 `--attach`/`KHY_CORE_ENDPOINT` 或组合态装配时发生；独立态没有默认可 attach 的服务——CLI 是进程内 require，`aiGateway.js:2646`；desktop host 是 fork 子进程内 require，`host/index.ts:330-337`；desktop 的 attach 面 `remote/index.ts:46-57` 依赖仓库工作树，找不到 `webRemoteControl/index.js` 即 throw，安装包内没有可用的 attach 客户端）。**R3 协调面 = 数据域单写者表**（§5.4）：共享数据家每个持久文件域只有列名写者；未收敛域（`sessions.db` WAL、`api_keys.json`、会话快照）在并存下仍是**已知风险**（dual-facts blockers #5/#6），本稿不宣称已解决；**计量即便 D4 收敛为一份叶子实现，进程级仍是多写**（N 个独立态 core 各持内存累加器写同一 `USAGE_FILE` → 最后写者覆盖、丢更新，见 §5.4），同样列为并存已知风险。**R4 可检测性**：计量按 writerId 枚举 + schemaVersion 判（§4.5），coreId 唯一性**只对 composed-shared 断言**——多独立 core 并存时 coreId 必然不止一个，把它当全局不变量就是问题 1 的复现 | dual-facts blockers #5/#6；v1 F1/F2；`remote/index.ts:46-57` 本会话实读 |
| **L4 独占创建与有效期** | 创建 = `fs.openSync(path,'wx')`；有效期 = `heartbeatAt` 距今 **≤45s**（3 个心跳周期，与 `protocol.js:81` 的 socket idle 同值）**且** `process.kill(pid,0)` 成功（`daemonManager.js:92-99`）。心跳 = holder 每 **≤10s** 以 tmp+rename 原子重写 `{heartbeatAt,listeners}`（先例 `protocol.js:80`、`tokenUsageService.js:164-181`）。因只有 holder 写，文件是单写者，无并发写 | 心跳/探活/原子写全部复用既有手法（F20） |
| **L5 过期与接管（owner 移交）** | **stale** = L4 任一条件失败。接管顺序：`create-exclusive` → 失败则读 → 若 stale 则**原子替换**（新 `coreId`/`owner`/`startedAt`）→ 成功者持有，并广播 `khy.core.lease.v1{action:'takeover', previous:{pid,coreId}}`。**心跳过期但 pid 活 → 不接管**：fail-closed 退出（非零）并打印持约方 `{pid,coreId,owner,heartbeatAt}`——活进程可能只是暂停/被调试，强抢 = 双写者。**正常移交 = 退场后交接**：holder 只在自身退出路径先 flush 计量再删除租约；**运行中不得转让租约**（转让 = 两个 core 同时认为自己可写数据家）。崩溃残留由下一候选者按 stale 接管，无需人工 | stale 自愈先例 `daemonManager.js:217-228`；探活先例 `:92-99` |
| **L6 第二实例定义（改写 v1）** | 只有**共享核心候选者**才构成「第二实例」；独立态终端之间不存在此概念。组合态「第二个共享核心候选者」取约失败 → fail-closed 退出并打印持约方 | v1 §3.3 原定义过宽（任何取约进程），会把并存的独立态 CLI 判成第二实例 |
| **L7 与旧锁的关系** | `daemon.pid`（`daemonManager.js:19`）与 `ai_manage_runtime.json`（`daemonEntry.js:65-83`，payload 无 coreId、`:74-78` 双写）降级为租约的**派生投影**（由租约写者代写实际端口；或显式标注 legacy 只读）。Electron 的 `requestSingleInstanceLock`（`main/index.ts:121-124`）只管 GUI 实例，不参与 core 租约。三者的退役/降级顺序见 §11-3 | v1 F10 |
| **L8 组合态对独立态的态度** | 组合态启动时**不杀、不拦、不探测**独立态终端；只对自己装配面拉起的 listener 负责（与问题 8 的注入范围一致）。verify 脚本可用 netstat 观察「独立态 listener 存在」并作为信息项报告，不阻断启动 | §7 |
| **L9 组合态装配的终端必须处于装配态（attach / embedded-off）** | suite 装配的终端**不得**保留自己的内嵌 core：desktop 的 host 子进程现状就是 embedded core 容器（`apps/khyos-desktop/src/host/index.ts:124-132` 动态 `nodeRequire` backend 的 `aiGateway.js`、`:330-337` require `tokenUsageService`，全文 20 处 `nodeRequire`）。若 suite 的共享 core 与 desktop host 的 embedded core 同时运行 = **第二核心**（违反产品意图 3；证③ / T5 的 composed 分支会被 desktop 的 writerId/coreId 判红）。因此：组合态下 desktop 必须改走 attached CoreHandle（embedded core 关闭），或只装载其 renderer 由 suite 托管；**attached 化完成之前 desktop / provider-hub 不进入组合态装配**（只能独立态运行，此时不属于「组合态单 core」集合）。机判：装配报告断言每个终端的 `coreMode==='attached'`；`verify:core-single` 的 composed 分支断言计量窗口内 `writerId` 集合 ⊆ `{suite-core}`，出现 `desktop-host` 即报 `metering-second-core`（§6.3） | 产品意图 3（一个窗口、一套设置、一个核心实例）；`host/index.ts:124-132/:330-337` 本会话实读；Electron 不能把另一 app 的 BrowserWindow 嵌进自身窗口 → desktop 若被装配只能是外部窗口 + attached（§5.3 档 B） |

**租约 schema（草案基线；键结构在实施期定稿）**：

```json
{
  "schemaVersion": 1,
  "mode": "composed-shared",
  "owner": "suite | daemon | ai-backend-service",
  "pid": 12345,
  "coreId": "<uuid-v4>",
  "startedAt": "<ISO-8601>",
  "heartbeatAt": "<ISO-8601>",
  "listeners": { "backend": { "port": 3000 }, "aiMgmt": { "port": 9090 }, "remote": { "port": 9413 } }
}
```

**验收（目标态，`scripts/tests/core-lease.test.js`，node:test；本会话未实现）**

| 断言 | 机判 |
|---|---|
| a1 独立态不落盘 | 在临时 `KHY_DATA_HOME` 下跑独立态入口（CLI `--version`）→ `core-instance.json` **不存在** |
| a2 共享核心独占 | 进程 A 建租约 → 进程 B（共享核心候选）取约 → B **exit≠0**，stdout JSON 含 `{pid,coreId,owner}`；A 的租约未变 |
| a3 stale 接管 | 造 `{pid:<已死>, heartbeatAt: 60s 前}` → B 接管成功，`coreId` 变化，事件日志有 `khy.core.lease.v1{takeover}` |
| a4 心跳过期但活时不接管 | 造 `{pid:<当前测试进程自己>, heartbeatAt: 60s 前}` → B 拒绝接管、exit≠0、打印持约方 |
| a5 退场释放 | A 收到 stop → 先 flush 计量 → 租约文件被删；B 立即可取约 |

---

## 3 core 落点、导出面与生态态（D1 / D9 / CH-1–CH-4）

### 3.1 落点

| 概念 | 落点 | 依据 |
|---|---|---|
| core（包） | `runtime/substrate/platform/packages/core`（`@khy/core`） | D1；`runtime/substrate/platform/packages/` 实测仅 4 包（F17）；`DOMAIN-DEPS.json` 的 D1.roots 实测含 `runtime/substrate/platform`（本会话直读），core 落其下自动进入 D1 判据面 |
| exports | `.` → contracts；`./contracts`、`./client`、`./server`、`./package.json` | `core-handle.md:135-141`；`:152-153` 封闭 exports（深导入 = `ERR_PACKAGE_PATH_NOT_EXPORTED`） |
| 依赖 | `dependencies.zod` **精确锁版**（不用 `^`）+ `pnpm-lock.yaml` 同批再生 | D9；F16 六处 zod 不可解析 |
| composer | `apps/suite/src/composer/`（纯库；CI 相对路径 require） | 本稿定（决策未覆盖）：v1 靠 R1 的 `src/composer/` 豁免合法化「suite import backend 源码」；core 迁出 backend（D1）后该豁免只剩这一条理由，且跨 workspace 相对 import 会触发 cross-layer-require（本会话实测 37 处既有命中）——归 suite 自有可同时去掉豁免与跨层引用（详见 §0.1 同行） |
| suite | `apps/suite/`（pnpm workspace 成员，方案 α） | D8；`apps` 在 LAYERS 在册（`check-repo-layout.js` 的 LAYERS 段）；语义扩展需人批准（§11） |

### 3.2 D1 的四个结构性动作（同批）

1. **`WORKSPACE_ROOTS` 登记 core**：`scripts/ci/check-repo-layout.js:310-322` 实测无 core、也无 `ui-shared`/`plugin-sdk`；`:304-309` 注释记录过「根清单不匹配 → `workspaceRootOf()` 返回 null → 调用点 continue → 整个后端失明（假绿）」的事故。core 不登记 = 同一事故复发。顺带补两个存量缺口。
2. **`DOMAIN-DEPS` 只认 D1、严禁加 D3**：D1.roots 已覆盖（实测），`enforced[0] d3-purity` 的 `forbidTargets` = `["D1","D2","D4","D5"]`（实测）——把承载网关的 core 塞进 D3 会立即自相矛盾。
3. **版本轨道不并 G2**：`check-version-sync.js:38-82` 的 10 条 spec 与 `:91-110` 的组是硬编码字节一致组（G2 = ai-backend/shared/plugin-sdk，实测）；core 并入 G2 会被强制等于 1.6.5。**本批不改 10 源**；core 起步版本与归组由人拍板（§11-1）。`core-handle.md:750`「`@khy/core` 入 G2」是待订正行（D10）。
4. **CH-1–CH-4 同批**：① `resolveEmbedded` 的 Node-only 定位器移显式 `./locator-host` 子路径，`client/locator.js` 只留接口/工厂（`core-handle.md:565` 现把 `CoreLocator.resolveEmbedded()` 放 `./client/locator.js`，而 `:157`/`:747` 要求 contracts/client 内 0 处 `node:` 且唯一豁免 `coreEnv.js`——现状自相矛盾）；② `KHY_CORE_*` 真源移**已显式 exports 的 contracts 子路径**并加 `typeof process` 守卫；③ 定位顺序 = 显式注入 > 宿主传入的 bundled 入口 > `node_modules` > 诚实报错；④ `core-handle.md` §6.1 删「本体随 S5 搬」半句（`:691-693` 职责清单不变）。

### 3.3 生态态（档 1 / 档 2）

- **档 1（生态默认）**：`@khy/core/contracts` + `/client` 可独立 npm 安装、零 `node:`、零副作用；第三方以 **attached** 连官方 core 进程。发布通道取 terminal-manifest §9.4 的 **(a)**：`@khy/plugin-sdk` 补 `files`/`exports`/`publishConfig` 并与 `@khy/core` 同批 npm 发布（terminal-manifest.md:461/:471 的 (a) 口径）。
- **档 2（embedded 全量）**：随官方发行包（npm `bundled/` + pip wheel）交付，**不承诺源码级轻包**；网关切成可发布子集单列 B8；B8 完成前任何「npm i 即跑通 embedded」的宣称都不成立（219:53）。
- 反证材料（为何门面/轻包不可行）：`works/ship/npm/package.json` 的 `files` 实测仅 `["bin/","bundled/","scripts/postinstall-compress.js","scripts/install/enable-fs-compression.sh"]`——第三方 `npm i @khy-os/khy-os` 拿不到 core 源码；backend 子目录不在 D1.roots（若把 core 定义成 backend 门面，域方向判据对新 core 全盲）。

### 3.4 单窗口与进程事实（问题 7 正文）

**口号：单窗口 + 组合态单 core 租约。**「单进程」在本仓是错误表述——Electron 侧至少四条进程边界并存：

| 层 | 事实 | 证据 |
|---|---|---|
| main | 单实例锁（只管 GUI）、`fork` host 与 scheduler、持有 pty、设备车道 hub（amoon/amoo/agentbus/remote）、各 store | `apps/khyos-desktop/src/main/index.ts:1-22`、`:114-124`（锁须在 whenReady 副作用前拿到）、`:789-799`（fork，`stdio:['pipe','pipe','pipe','ipc']`） |
| preload | `contextBridge` 收口 `__KHYOS__`；`ipcRenderer.invoke` 140 处 / `.on` 11 处 / `.removeListener` 11 处（本会话按方法拆分统计），通道名全为裸字符串、无常量表 | `apps/khyos-desktop/src/preload/index.ts:348`；全文 350 行 |
| renderer | 零直连网络（只有 IPC facade 与 UI） | `App.tsx:1-22`；`findstr` 仅 2 处注释命中（F19） |
| host 子进程 | **embedded core 的容器**：`createRequire` + 20 处 `nodeRequire` 加载 backend 模块 | `apps/khyos-desktop/src/host/index.ts:68`、`:70-74`、`:330-337`；`:126` 等 |

组合态的「一个核心实例」指：**一个共享 core 进程 + 一把 composed-shared 租约**，且所有被装配终端处于 attached（L9）；「一个窗口」只指 suite 自己的 view 窗口——desktop / provider-hub 若装配只能是外部窗口 + attached，attached 化前不进入组合态。进程边界保留——这正是 L1 单写者成立的前提，不是需要消灭的东西。

---

## 4 共享数据与计量收敛（问题 4、5 / D4）

### 4.1 写者清单（实测）

| # | 写者 | 文件 | 状态 | 证据 |
|---|---|---|---|---|
| W1 | `runtime/node/backend/src/services/tokenUsageService.js` | `~/.khyquant/token_usage.json` | **活跃**；tmp+rename 异步 flush；daily/monthlyTotals 含 `cacheReadTokens/cacheWriteTokens` | `:27`、`:164-181`、`:281-323`、`:246` |
| W2 | `runtime/node/ai-backend/src/services/tokenUsageService.js` | 同路径 | **活跃**；`writeFileSync` 直写；无 cache 字段；自持 12 键 `TOKEN_PRICING` + `USD_TO_CNY=7.25` | `:12`、`:15`、`:18-31`、`:46-55`、`:60-68` |
| W3 | `delivery/channel/khyquant/services/tokenUsageService.js`（591 行） | 同路径 | **休眠**（仓内唯一调用方 `multiFreeService.js:1479` 只读 `estimateTokens`）；`saveUsageData` 直写；自持 12 键表 | `:12`、`:15`、`:18-31`、`:63-69`、`:93`、`:147`、`:534`；`runtime/node/backend/src/cli/khy.module.json` 的 `fanInEvidence` 引用它 |
| W4 | `runtime/node/backend/src/services/usageTracker.js` | `usage-<date>.jsonl`（默认关） | **休眠**；`_logDir=null`、`_enableLogging=false`；单例无 opts | `:49-59`、`:329-338`、`:342` |
| R1 | `usageTracker.record` | 事件日志 `usage.record`（非文件） | 活跃**读数** | `:177-182`；`aiGatewayGenerateMethod.js:30`、`:6108` |
| — | 桌面 agentbus | usage 读数（client-measured，no local ledger） | 第三处**视图**、非账本 | dual-facts（`:192-202` / `index.ts:14-18`），本会话未重读 |

**定价副本（4 份）**：backend 已委托叶子（`tokenUsageService.js:18`、`:34`）；ai-backend `:15/:18-31`、khyquant `:15/:18-31`、usageTracker `:30-41` 三份待并。

### 4.2 收敛目标

- **单一写者实现（≠ 进程级单写）**：backend 与 ai-backend 的 `tokenUsageService` 收敛为一份（建议：`@khy/core` 的 UsageStore 叶子，最小版直接委托既有 `tokenPricing.js`；ai-backend 改委托）。khyquant 休眠写者**纳入收敛范围但排第三**：`TOKEN_PRICING` 删表改委托、`saveUsageData`/`recordUsage` 保留签名改经共享 UsageStore（或在其写盘入口加门控），**完成后才允许报 single**。**诚实边界**：代码收敛为一份叶子只解决「同一事实两个实现」，**不解决进程级多写**——N 个独立态 core 各持内存累加器（backend `tokenUsageService.js:37-40` 的 `_sessionUsage`、`:281-323` 的 `_persistedMirror` 聚合）对同一 `USAGE_FILE` 做 tmp+rename / `writeFileSync`，并存下仍是最后写者覆盖、丢更新；`records[]` 环形只让覆盖**可审计**，不阻止覆盖。按 writerId 分文件 + 读侧合并的落盘形态见 §11-15。
- **定价叶子**：`tokenPricing.js:40-55` 的 `TOKEN_PRICING` 是 **provider 键**（14 项）；`usageTracker.js:30-41` 的 `PRICING` 是 **model 键**（10 项）——**键域不同，直接合并会改数值**。收敛方式：叶子增设 `MODEL_PRICING`（usageTracker 表**逐字迁移**）+ 纯函数 `calculateModelCost(model, input, output)`；usageTracker 委托叶子。ai-backend/khyquant 的 provider 键副本直接删除并 require 叶子——行为变化**仅在 DeepSeek / Together AI 两键**：从 `default`（0.1/0.3）回到文档值（0.27/1.1、0.88/0.88），这正是 backend `:13-17` 注释记录的事故修复（属有意的行为修正，见 §11-6）。
- **jsonl 面**：`usage-<date>.jsonl` 启用前必须登记 DATA-LOCATIONS（T3-archives 语义：只追加只轮转）；未启用时以 **KNOWN-EXCEPTIONS 的休眠写者条目**登记（`target.kind='writer'`、`reason` 写「`_enableLogging` 默认 false、单例无 opts」、`reverify` 给出启用检测命令），由 §7.3 的消费者读表——不沉默。

### 4.3 落盘 schema v2（草案基线，键结构实施期定稿）

```json
{
  "schemaVersion": 2,
  "meta": {
    "updatedAt": "<ISO-8601>",
    "lastWriterId": "cli | desktop-host | daemon | ai-backend | suite-core",
    "lastCoreId": "<uuid-v4>"
  },
  "daily": { "YYYY-MM-DD": { "inputTokens": 0, "outputTokens": 0, "totalTokens": 0, "requests": 0, "costUSD": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0 } },
  "monthlyTotals": { "YYYY-MM": { "…同 daily…": 0 } },
  "records": [
    { "at": "<ISO-8601>", "writerId": "cli", "coreId": "<uuid-v4>", "provider": "…", "model": "…",
      "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0, "costUSD": 0 }
  ]
}
```

- `coreId` = core 进程实例 id，**计量 schema 与租约条目用同一字段名**（`[DESIGN-ARCH-219]` §1.2 偏离 2：不再使用 `bootId` 别名）。**219 D4 的 `coreId` 要求不丢**：校验脚本断言 `records.coreId === lease.coreId`（composed 时）。
- `records` 环形上限 **500**（FIFO，超出丢最旧）；每条由写入进程生成。
- `writerId` 枚举常量表放 UsageStore 叶子（单一真源）；未知值 → 记录原样保留、校验脚本报 `metering-unknown-writer`。
- **legacy 双读**：无 `schemaVersion` 的旧文件按 `schemaVersion=1` 处理（只读、不写回旧格式）；首写升级为 v2 并保留 `daily/monthlyTotals` 原值。
- 落点：从 `os.homedir()`（`tokenUsageService.js:27`、ai-backend `:12`、khyquant `:12`）改为 **`utils/dataHome` 解析家**（user-home 段，见 §4.4），legacy 路径 `~/.khyquant/token_usage.json` 双读。

### 4.4 登记（DATA-SSOT + DATA-LOCATIONS）

| 登记表 | 动作 | 依据/限制 |
|---|---|---|
| **DATA-SSOT.json** | 新增 fact `token-usage-file`：`ssot.path` = UsageStore 叶子的路径常量（或 `tokenPricing.js` 旁的 `usageStore.js`），`ssot.kind` ∈ 合法六种（建议 `js-const`），`detect.identifiers` = `["USAGE_FILE"]`（四份同名副本的锚点），`note` 写明「真源 = UsageStore 叶子；写者枚举在其常量表；legacy 路径双读」；`sources[]` 增补 user-home 路径说明 | `ssotDataGuard.js:52` 的 kind 白名单；`:440-441` json-count 不提供影子副本保护（若用 json-count 须在 note 声明） |
| **DATA-LOCATIONS.json** | **走 knownGaps 先例**：新增 `token-usage-user-home` 条目（字段照 `:233-255` 的 `phone-discovery-user-home`：`id/status/openedAt/path:"<user-home>/.khyquant/token_usage.json"/segment:"user-home"/gap/writers/readers/consequence/mitigation`），`writers` 列 W1–W3 的精确行号；**不得**硬塞进 khy/khyos/state 三个 root（`:240` 原文「不得为了塞进去而歪曲现有 root 语义，也不许静默跳过」）。若人决定成批裁决 user-home schema（与 phone-discovery 合并），则该条目随裁决关闭；否则保持 open 但**可见** | LAYOUT-007；`:240` |
| **KNOWN-EXCEPTIONS.json** | （可选）`usage-tracker-jsonl-dormant` 条目（见 §4.2） | §7.3 |
| **DATA-LOCATIONS.json（租约文件）** | 新增 seedEntry `core-lease`：`<dataHome>/core-instance.json` 落在 `khy` root（`works/data/khy`，accessor `getDataHome()`）之下 → **必须登记**（LAYOUT-007；这是新增数据落点）。tier 取 `T2-regenerable`（删了能重建：stale 接管/重启即再生）。**不登记 DATA-SSOT**：租约是运行态状态，不是「值锚定的事实」，无影子副本语义（`ssotDataGuard` 的 fact 模型表达不了）。清理责任：holder 退出钩子删除；崩溃残留由 stale 接管覆盖（L5）；`verify:core-single --gc` 只允许删「pid 死 ∧ 心跳过期」的文件（与 L5 同判据），并在报告里列 `lease-orphan` | `DATA-LOCATIONS.json` 的 `roots.khy`（`works/data/khy` / `getProjectDataHome()` 实测）；LAYOUT-007 守卫 `check:data-layout`；`ssotDataGuard.js` 的 fact 模型见 §1.3 |

> 结论：**「登记 DATA-LOCATIONS」在本仓今天做不到一次性落地**——登记表表达不了 user-home 路径（`:238-240` 的能力缺口原文）。本稿的诚实口径：token_usage 进 knownGaps + DATA-SSOT fact；user-home schema 裁决另立（§11-7）。不写「已登记」。

### 4.5 三证③（按形态判定，修订表 #4）

| 形态 | 判定式（机判） |
|---|---|
| composed-shared | `records` 中 `at` 落在验证窗口内且 `records[].coreId ≠ 租约 coreId` 的条数 = **0**；`schemaVersion === 2`；窗口内 `writerId` 集合 ⊆ `{suite-core}`（出现 `desktop-host` → `metering-second-core`，见 §6.3/L9） |
| independent | `records` 中 `writerId ∉ WRITER_IDS` 的条数 = **0** 且 `schemaVersion === 2`；**多 coreId 合法** |
| 未收敛 / 旧格式 | `schemaVersion ≠ 2` **或** 双活跃写者仍在 → 报 `metering-dual-writer`，**不得报 single** |

---

## 5 终端清单、Composer 与 web-quant（D2 / D7）

### 5.1 真源与投影（D2）

- **编写真源**：7 份 `khy.terminal.json`（cli / cli-node / desktop / desktop-provider-hub / web / web-quant / mobile 各一份，落各自终端根）。
- **生成投影**：`entries/entries.json`（入库、逐字节可复算）。`gen-entry-matrix.js` 生成、`check-manifests.js` 校验（S1）；`gen-entry-matrix --check` 在 pr-gate 承担「投影逐字节一致」。
- **逐字节保留** `kinds` / `statuses` / `modes` 三块顶层枚举（`entrypoints/registry.js:322-333` 校验 kinds/statuses；`modes` 由 launcher 的 spawn 语义消费，`launcher.js:6-13`）。
- `entries.entries` 是**数组** 7 条（实测），生成器保持数组形状。
- **DATA-SSOT 口径**（照 decisions D2 最小替代）：7 份清单路径写入 `sources[]`；`facts[]` 可选登记 `terminal-matrix`（`kind json-count`，note 声明「不提供影子副本保护」）；TM-1 真实理由 = `entries/` 在 `scan.include` 内但无 fact 锚点（`ssotDataGuard.js:616-617`）。
- **`meta.ssot` 订正**（实施期步骤 6，人批留痕）：`entries/entries.json:7` 实测指向 `docs/03_DESIGN_设计/[DESIGN-ARCH-117] khy-多端入口矩阵.md`（顶层不存在，真身在 `DESIGN-ARCH/` 子目录）；改为子目录路径，并翻转 `[DESIGN-ARCH-117]` 头注「改端先改这里」为「改端先改终端清单 + 重跑生成器」。编号：总案 219（保持）、CoreHandle 220、终端清单 221、Suite 222（落盘前重测、被占顺延；219:54/:375 与 `refactor-master.md:373`、`terminal-manifest.md:21/:305` 的 218/219 引用一并改 221）。`core-handle.md:142` 的 `"zod": "^3.24.0"` 改精确锁版；`:750`「入 G2」改「不并入 G2、版本归组人拍板」。

### 5.2 Composer 四函数（v1 §2.1 保留，输入/产物按 D2/D7 更新）

| 函数 | 输入 | 输出 | 失败语义（结构化 findings，不 throw） |
|---|---|---|---|
| `collectManifests(inputs)` | 7 份 `khy.terminal.json`（在册端）+ 第三方 `package.json#khy.terminal`（同一 schema，两种载体） | 归一化 manifest `{terminalId, source, artifact{id,path,rebuild}, launch, portsRef, shellSlot, contributes{capabilities,settings}, engines}` | 重复 id / 缺 marker / artifact 指针解析不出 → `suite-manifest-*`（web-quant 现状即此类，`entries.json:170` null） |
| `resolveCapabilities(manifests, coreCaps)` | 上一步 + core capabilityRegistry 快照 | `{activated[], degraded[{id,missing[]}], excluded[]}` | required 缺失 = fail-closed（不装配，进 excluded）；optional 缺失 = 降级装配 |
| `negotiateVersions(manifests)` | `engines.khy` 区间（语义沿用 `runtime/substrate/platform/packages/plugin-sdk/index.js:37-41` 的 `MANIFEST_FIELDS`，含 `engines.khy` 必填） | `{khyCore, uiShared, conflicts[]}` | 交集为空 = fail，逐条打印「谁挡住交集」（不猜宽容版本） |
| `generateShellConfig(resolved)` | 合并结果 | `{views[{terminalId, url|artifactPath, portsRef}], navTree, settingsSchema, eventTopics, launchPlan[]}` | 无 IO；缺字段 = TypeError（编程错误） |

- **产物坐标**：只经 `artifactOutput` id → `BUILD-OUTPUTS.json` 解析（`entries.json:12` 同旨「读登记表，不抄 path」）。
- **web-quant（D7）**：组合态只装载 `quant-frontend-dist`（`entries/quant-frontend`）；清单/投影的 `artifactOutput` 由生成器从 `null` 补为 `quant-frontend-dist`；**禁止 dev server 装载**；开发态 `--host 127.0.0.1` 且不开 `--open`（改 khyquant 三个脚本属实施期，当前实测均为 `0.0.0.0`）。

### 5.3 收编档位（v1 §4.2 保留，档 C 修正）

| 档 | 终端 | 方式 |
|---|---|---|
| A `view` | ai-frontend、khyquant frontend | 加载 BUILD-OUTPUTS 登记产物。**落点实况**：两条登记 status=`migrating`，现有产物在 `legacyPath`（`delivery/web/ai-frontend/dist`、`delivery/channel/khyquant/frontend/dist`，本会话实测均 EXISTS 且含 index.html）；`entries/ai-frontend` 与 `entries/quant-frontend` 在 LAY-5 迁移完成前 **ABSENT**（khyquant `vite.config.js:116` `outDir:'dist'`、ai-frontend 未设 outDir 走默认 dist）——装配器按「`path` 优先、迁移期回退 `legacyPath`」解析（§9.1 T1 ③④、§11-16）。web 端口的 ref → `WEB_FRONTEND_PORT`（`serviceDefaults.js:285`） |
| B `external-window` | desktop、provider-hub | **不能进 suite 窗口**（Electron 不能把另一 app 的 BrowserWindow 嵌进自身窗口）。组合态下只允许：壳外启停 + 状态显示 + 事件汇聚，**且必须 attached（embedded core 关闭）**。attached 化完成前，这两端**不进入组合态装配**（只能独立态运行，不属于「组合态单 core」集合）——否则 desktop host 的 embedded core（`host/index.ts:124-132`）与 suite 共享 core 并存 = 第二核心（L9）。「单窗口」因此指 suite 自己的 view 终端（档 A），不含外部窗口终端 |
| C `external` | CLI | 壳外可启停与状态显示；**形态分流**：被 suite 装配或显式 `--attach`/`KHY_CORE_ENDPOINT` 时**只读**租约取 attached 坐标；其余情形（独立态默认）走进程内 core，不读租约（L2）。不再有 v1 的「取不到租约就 attach」死路 |

### 5.4 数据域单写者表（独立态并存的协调面，修订表 #1 R3）

| 数据 | 既有真源 | 单写者动作 | 现状 |
|---|---|---|---|
| 计量 | `tokenUsageService.js` + ai-backend 副本 + khyquant 休眠副本 | D4 = **单一写者实现**（一份 UsageStore 叶子）；**进程级仍是多写**（每进程内存累加器 + tmp+rename/writeFileSync 整文件覆盖，最后写者赢） | 双活跃写者未收敛 → `metering-dual-writer`；收敛后并存下仍丢更新（§4.2 诚实边界；按 writerId 分文件的裁决见 §11-15） |
| 会话正文 | `services/sessionPersistence.js`（append-only JSONL + 快照，tmp+fsync+rename；dual-facts 引） | 写经 core 串行化；独立态并存时双进程 append 是**已知风险**（blocker #6） | 未收敛（dual-facts blocker #6；本会话无现场复现） |
| sessions.db | FTS5 派生索引（`sessionSearchIndex.js:4-6`，dual-facts 引） | 由 core 独家重建；双进程共享 WAL 是 blocker #6，组合态禁止 | 未收敛 |
| 凭据 | `services/apiKeyPool.js:30-43`（含 fs.watch；dual-facts 引）vs 桌面 `keyManager/keyStore.ts` | 收敛到 core credentials 能力；桌面降级展示/审计层 | 未收敛（blocker #5） |
| 设置 | core `global` 域 vs 桌面 `settings.json` | 两域：`global`（跨端，写 core 并广播）/ `terminal`（私有，留 settings.json；`dataPath` 必须留引导可读域） | 分域表 = `generateShellConfig.settingsSchema` 产物 |
| daemon 运行态 | `daemon.pid` / `ai_manage_runtime.json` | 由租约写者代写（派生投影） | 待退役/降级（§11-3） |

> 单写者不是「持租约者可写一切」（v1 §3.4 原写法）——独立态并存下没有任何进程持租约。**按域列写者**才是能落地的规则。

---

## 6 Suite 壳、设置传播与单实例（D5 + T3/T4/T5）

### 6.1 壳职责（v1 §3.1 保留）

白名单：① 窗口与 view 托管；② navTree 渲染；③ 设置宿主（聚合 `contributes.settings` → UI → 经 CoreHandle 写）；④ 事件转发（core bus → view，经 preload）；⑤ 终端进程监督。
黑名单（零实现）：AI 对话、交易、PTY 渲染、凭据管理 UI、模型路由。

### 6.2 设置分域（F7）

- `scope:'global'`：跨端语义，写 core，广播 `khy.settings.changed.v1{key, revision}`。
- `scope:'terminal'`：终端私有，留 `settings.json`（`settingsStore.ts:2-9` 头注：`dataPath` 指针必须引导前可读，因此不得搬进 dataPath 之后的解析家）。
- 键归属表 = `generateShellConfig.settingsSchema` 输出；机判断言见 T3（`global` 键 ∩ `settings.json` 键 = ∅）。

### 6.3 单实例三证（D5 + 问题 1 的形态化）

**入口**：`npm run verify:core-single --json`（npm 脚本 + node:test；**不建 `khy core verify-single`**，D5）。

| 证 | 内容 | 判定 | 现状前置 |
|---|---|---|---|
| ① 租约 | composed-shared 租约条目（§2.2 schema）；心跳 ≤10s、有效期 ≤45s + pid 探活 | `verdict:'single'` 仅在租约新鲜且身份一致时给出；无租约 → `mode:'independent'`，该项 `N/A`（不是失败） | 文件不存在（F17） |
| ② listener | 只探**租约里声明的** port；健康响应必须回 `{ok,service,pid,startupAt}` 并与租约逐字比对 | 每个声明 listener 都应答且身份一致 | 现有 `/health` 不回身份（`webRemoteControl/server.js:389-391` 的 `{ok:true,service:'khy-web-remote'}` 为 v1 实测，本会话未复跑）；`aiManagementServer.js:3538-3573` 的端口顺延与「第二实例拒绝」冲突待裁决（§11-4） |
| ③ 计量 | §4.5 的形态化判定式 | composed：窗口内 `coreId` 唯一**且** `writerId` 集合 ⊆ `{suite-core}`——出现 `desktop-host` 即 `metering-second-core`（L9 的第二核心：desktop host 的 embedded core 还在跑）；independent：`writerId` 合法 + schemaVersion=2，**多 coreId 合法** | 数据面不存在（F15）→ 今天只能报 `metering-dual-writer` |

**verdict 取值**：`single` | `metering-dual-writer` | `metering-second-core` | `lease-conflict` | `independent`（合法形态，非 single 也非失败） | `core-start-timeout`。

### 6.4 会话接力（T4）

- 真相在 core（`sessionPersistence.js`）；`--continue` 已存在（F21）。
- 两个不变式：(a) 单写者（写经 core；读侧多读者不受限）；(b) 会话 id 全局唯一，由 core 分配。
- 组合态 CLI 必须 attached（§5.3 档 C），否则 T4 测的是「两个 core 各写一条链」。

---

## 7 LAN 边界与已知例外（问题 6、8 / D6）

### 7.1 逐 listener 现状表（本会话实测）

| listener | 代码 | 默认 bind | LAN 显式 opt-in | 处置 |
|---|---|---|---|---|
| backend Express | `serviceDefaults.js:100-103`（`BACKEND_PORT` 3000、`BACKEND_HOST` 默认 `127.0.0.1`） | 127.0.0.1 | `BACKEND_HOST` | **既合规**，不动 |
| ai-backend / AI_MGMT | `ai-backend/server.js:123-138`；`serviceDefaults.js:313-314` | **0.0.0.0**（ARCH-074 刻意裁决） | 仅 env（`AI_MGMT_HOST`） | **保留默认**；登记 KNOWN-EXCEPTIONS；suite 只对自己拉起的 listener 注入 |
| webRemoteControl | `webRemoteControl/server.js:86-91`；`serviceDefaults.js:112-115` | 127.0.0.1 | `lanEnabled` / `KHY_REMOTE_BIND_HOST` | **既合规** |
| agentbus | `agentbusProtocol.ts:93-94`（dual-facts） | 127.0.0.1（adb forward 出口） | n/a | 不作为 core attach 底座；其 env/鉴权面另立（§11-9） |

### 7.2 注入仲裁（D6）

- **顺序写死**：**用户显式 env > suite 注入 > `serviceDefaults` 默认**。
- 实现口径：suite 只在 **spawn 子进程的 env** 上注入 `AI_MGMT_HOST=127.0.0.1`；若 `process.env.AI_MGMT_HOST` 非空 → 原样透传（`ai-backend/server.js:136-138` 证明 env 优先级最高，无条件注入会压掉运维显式设的 0.0.0.0）。不修改 `serviceDefaults` 默认值，不全局改行为。
- LAN 保持显式 opt-in；`pairUrl` 文案**须**明示「局域网明文通道，配对码 10 分钟内有效」（TTL 常量真源：`protocol.js:78` `PAIR_CODE_TTL_MS`，经 `pairingCode.js:24` 导入、`:54` 使用；配对请求侧 `devicePairing.js:63` `PAIRING_REQUEST_TTL_MS` 同值；心跳/idle `protocol.js:80-81`）。

### 7.3 KNOWN-EXCEPTIONS.json（问题 6）

位置：`docs/10_规范/registry/KNOWN-EXCEPTIONS.json`（新文件；目录实测无同类登记表）。

```json
{
  "$schemaNote": "网络绑定与休眠写者的机读例外表。消费者 = scripts/ci/check-core-boundary.js --lan（T6）与 metering 校验脚本。过期条目由消费者打 warning，不另建调度。",
  "version": 1,
  "updated": "YYYY-MM-DD",
  "entries": [
    {
      "id": "ai-mgmt-host-lan-default",
      "target": { "kind": "listener", "ref": "AI_MGMT_HOST=0.0.0.0@runtime/node/ai-backend/server.js:127" },
      "owner": "<人>",
      "reason": "ARCH-074 刻意裁决：LAN 上其他机器可经 /api/auth/login 登录管理面；suite 装配面自己的 listener 另行注入 127.0.0.1，本例外只覆盖 ai-backend 服务自身默认值",
      "expiry": "YYYY-MM-DD",
      "reverify": { "command": "npm run check:core-boundary -- --lan --json", "expect": "known-exception-applied:ai-mgmt-host-lan-default" }
    }
  ]
}
```

- **消费者行为**（`check-core-boundary.js --lan`）：netstat 观察到的监听地址与 `target` 匹配 → 记 `known-exception-applied:<id>`（不算 finding）；`today > expiry` → warning `known-exception-expired`；条目缺 `reverify.command` → warning `known-exception-unverifiable`；**表与消费者未同批落地前 T6 不判绿**。
- **不复用** `ARCHITECTURE-POLICY.json` 的 `exceptions`：实测空数组、全仓无读者（`check-zcode-baseline.js` 0 处引用）、语义是模块边界策略（文件头 `:2` 自述）。塞网络例外进去 = 死字段复用 + 语义污染。
- **T6 期望输出**（目标态，未执行）：`webRemoteControl(9413)=127.0.0.1`；`backend(3000)=127.0.0.1`；`AI_MGMT(9090)=0.0.0.0 → known-exception-applied:ai-mgmt-host-lan-default`；`unknown-listener=0`。

---

## 8 新守卫落地（问题 2 / D3）

### 8.1 执行器规格：`scripts/ci/check-core-boundary.js`（新增）

| 项 | 规格 |
|---|---|
| 阶段 | `const GUARD_STAGE = 'S1'`（字面常量，供 `check-rollout-stage.js` 的 `executorStage.constant` 匹配；`check-core-layers.js` 无此常量 → 不能寄生） |
| 退出 | S1 **恒 exit 0**（有 finding 也 0）；`--strict` 不得在 S1 提供（防「非阻塞退化成永久忽略」的另一面：也不许提前阻断） |
| 参数 | `--changed`（pre-commit 快档）、`--json`（机读，含 `counts`）、`--portable` / `--suite-fork` / `--lan` 子档 |
| finding | 一律 `severity:'warning'`；**不进** `LAYOUT-001.exec.args` 的 `--promote=` 名单 |
| 接线 | `package.json` 别名 `check:core-boundary`；pr-gate 步骤；FEATURE-OWNERSHIP 三条机制（`core-boundary-guard` / `terminal-manifest-guard` / `suite-assembly-guard`），`rules: []` |
| 样本源 | `samples.source = {script:'scripts/ci/check-core-boundary.js', args:['--json'], key:'counts.<finding-id>'}`（标量；`pickKey` 对 object 判「不是标量读数」，`:165-167`；先例 `counts.domain-direction` / `counts.entry-buffer`） |
| 回滚 | 删脚本 + 摘别名/pr-gate 步骤 + 删三条机制条目（纯配置，无生产代码行为变更） |

### 8.2 判据与 finding（四基础 + 三子档）

| 组 | finding | 判据 |
|---|---|---|
| 基础 1 | `core-boundary-import` | `packages/core/**` 引用 `runtime/node/backend`、`apps/`、`delivery/`、`works/`、`scripts/`、`docs/`、`entries/`（迁移期白名单只允许 `backend/src/{utils,constants}`） |
| 基础 2 | `terminal-direct-gateway-import` | 终端侧四种形态匹配 core 网关文件：相对 require/import、包名说明符、`path.join(…,'gateway','aiGateway.js')` 分段动态、模板字符串；基线单独登记（219:126 初始 7 处/6 文件） |
| 基础 3 | `core-skin-into-server` | `packages/core/src/**` 出现 `node-pty`、`ink`、`readline`、`@khy/ui-shared`、页面模板资产、`document.`/`window.` |
| 基础 4 | `core-not-in-entry-closure` | **冷闭包**（仅顶层边）口径——与 `CORE-LAYERS.json` 的 `budget._note` 原文同口径（「L1 是按入口分别计的**冷闭包**预算」）；三个 L1 根实测 = `toolUseLoopCore.js` / `aiGateway.js` / `cli/repl/startup.js`。判据：`bin/khy.js` 与这三个入口的**冷闭包**（顶层边）内不得出现 `packages/core/**`（含 `@khy/core` 裸包名边）。**必须写明「冷」**：按传递闭包读会与产品意图 2（终端只带 core 运行）永久互斥——独立态 CLI 必须能到达 core，只有「入口顶层不直接 require core、走 handler 懒加载边」才自洽（219:128 同旨）。**适用范围 = 迁移期**：网关从 backend 迁进 `packages/core` 完成即退役/改写本条（§11-18）。闭包遍历自写，`requireGraph.js` 不提供传递闭包 |
| `--portable` | `core-private-path` / `core-carries-composer` / `core-dynamic-private-require` | 可携断言；动态 require 文本兜底（`requireGraph.js:153-158/:192-195` 只计数） |
| `--suite-fork` | `suite-forks-terminal` / `suite-deps-core-pkg` / `terminal-imports-suite` / `suite-bundle-leak` / `suite-dynamic-require` / `suite-runtime-fork` | 不 fork/复制终端（R1–R6；R5 动态兜底、R6 `require.cache` 交叉验证为必配） |
| `--lan` | `known-exception-applied` / `known-exception-expired` / `known-exception-unverifiable` / `unknown-listener` | §7.3 |

### 8.3 宿主既有红列 = 施工前置（不得声称已绿）

| 命令 | 本会话实测 | 施工口径 |
|---|---|---|
| `node scripts/ci/check-core-layers.js` | **exit 1**，11 ❌（F14 明细） | 新守卫**不挂**该文件；该红列随施工报告原样引用 |
| `node scripts/ci/check-rollout-stage.js` | 0 error / 44 warning；`core-layers-guard` 有 samples-declared-only + authority-drift | 新机制登记必须带 `executorStage` 字面常量与 `counts.*` 标量 source |
| `node scripts/ci/check-delivery-baseline.js --json` | stage S1，PASS 7 / GAP 5，四项棘轮全越界 | 目标 = 越界幅度**不变大** |
| `node scripts/ci/check-repo-layout.js` | **exit 1**（counts 见 F14） | 目标 = 不新增 error 条目 |
| `git fsck`（经 delivery D1） | 退出码 2、missing blob=10 / tree=9 / commit=3 | 既有基线；不在本重构修复 |

### 8.4 毕业（S3）路径

S1（本批）→ 样本 ≥200 且无解释不了的样本 → S2（≥50 提示、误报 <10%）→ S3（≥20 真实拦截、豁免率 <20%）。**S3 才新增 `LAYOUT-009`**，且按 PROCESS-014 先退役/合并一条既有规则。升阶是人的决定（PP-6 一次一阶）。

---

## 9 验收矩阵（问题 3 + 七条体验 + 三形态）

> **诚实声明**：七条体验的原文未见（219:428 同记）；下表为 v1 主题推导的 T1–T7。**落盘前置**：七条原文回填之前，本表只作**判据草案**，不得作为验收依据。今天连命令都解析不了的行：T2/T5 依赖不存在的 npm 脚本（`suite:validate` / `verify:core-single` 本会话实测 ABSENT）、T3/T7 依赖不存在的测试文件（`scripts/tests/` 下无 `suite-hotplug.test.js`、`core-lease.test.js`）、T6 依赖不存在的消费者脚本（`scripts/ci/check-core-boundary.js` ABSENT，F17）。除标注「本会话已跑」者外，全部为**目标态**，本会话未执行；未跑 ≠ 通过。

### 9.1 七条体验（T1–T7）

| # | 体验 | 机判命令 / 断言 | 期望 | 本会话 |
|---|---|---|---|---|
| **T1 独立态** | 每终端不依赖 suite/composer 可构建可运行 | ① **headless 探针**：`node runtime/node/backend/bin/khy.js entry probe --json`；断言 7 端 `status==='ready'`（repo 级）且 `drift===null`；`mobile.machine` 只作本机事实，不作失败判据。② **CLI 非交互**：`node runtime/node/backend/bin/khy.js --version`（exit 0、输出 `^\d+\.\d+\.\d+$`）+ `node ... entry list --no-probe`（exit 0）。③ **web**：`npm run build --prefix delivery/web/ai-frontend`（exit 0）→ **按 BUILD-OUTPUTS 的 `ai-frontend` 条目解析产物**：status=`migrating` 时断言 `legacyPath`（`delivery/web/ai-frontend/dist/index.html`）存在；迁移完成后断言 `path`（`entries/ai-frontend/index.html`）。④ **web-quant**：`npm run build --prefix delivery/channel/khyquant/frontend`（exit 0）→ 同法按 `quant-frontend-dist` 条目断言 `delivery/channel/khyquant/frontend/dist/index.html`（现 legacyPath；`entries/quant-frontend` 迁移前 ABSENT——本会话实测：`vite.config.js:116` `outDir:'dist'`、ai-frontend 未设 outDir 走默认 dist、两个 `dist/` 均 EXISTS 且含 index.html）；**不启动 dev server**；开发态断言 = `dev`/`dev-no-browser`/`dev-auto-port` 三个脚本含 `--host 127.0.0.1` 且不含 `--open`（**当前实测全部 `0.0.0.0`，该断言现状为红——实施期改脚本后才绿，§11-16**）。⑤ **GUI 端**（desktop / provider-hub，entries.json:95/:119 `detach`）只 probe，不无人值守 launch。⑥ **mobile 移出无人值守清单**（`flutter run` 是 `attach`，entries.json:190；本机 flutter 缺失已由 probe 如实报出） | ① 7×ready / drift null；② exit 0；③④ 产物存在（**按 BUILD-OUTPUTS 的 path/legacyPath 解析，不硬编码 `entries/`**）；⑤ 无；⑥ 不跑 | **① ② 已跑**：probe 7 端 ready/drift null（mobile machine.ok=false）；`--version` 1.2.2 exit 0；`entry list --no-probe` exit 0。③④ 构建未跑 |
| **T2 组合装配** | 装配结果幂等 | `npm run suite:validate --json` ×2 → 两次 stdout 逐字节一致；`findings` 空或如实列 required 缺失；`excluded` 与 `degraded` 可解释 | 两次一致、findings=0 | 未跑（suite 不存在） |
| **T3 设置传播** | 改一次全端生效 | node:test（stub 两个 view）：写 `CoreHandle.settings.set{key, scope:'global'}` → 两 view 各收到**一次** `khy.settings.changed.v1{key, revision:N+1}`；断言 `settings.json` 的键 ∩ `global` 键 = ∅（影子键 `settings-shadow-key` = 0）；`dataPath` 键必须在 terminal 域（`settingsStore.ts:2-9`） | 两 view revision 相等 = N+1；shadow=0 | 未跑 |
| **T4 会话接力** | web 发起 → CLI `--continue` 可见 | web 经 core append 2 条 → **`node runtime/node/backend/bin/khy.js -p "<非交互提示>" --continue`**（`--continue` 必须在 `-p` **之后**，见 F21；显式 id 用 `--resume <sessionId>`）→ 输出 `sessionId` 相同、消息数 = 2 + CLI 新增；前提 CLI attached（§5.3 档 C）；CI 需**本地 stub 网关**（端点指向 127.0.0.1 stub），否则会发起真实模型请求。**不得写成 `khy chat --continue -p …`**：`chat` 不是命令（router.js 全文 0 处），且 `-p` 之前的 `--continue` 会被静默丢弃（`bin/khy.js:1944-1948` 只解析 `-p` 之后的 token） | sessionId 相同；消息数正确 | 未跑（依赖组合态 core；本会话探针 `zzz-unknown-cmd -p hello` 已证明前导 token 被忽略——它直接发起了真实请求） |
| **T5 单实例** | 三证 | `npm run verify:core-single --json`：composed → `verdict:'single'`（①租约新鲜且身份一致 ②listener 身份匹配 ③窗口内 `coreId` 唯一**且** `writerId` ⊆ `{suite-core}`）；再起**第二个共享核心候选者** → exit≠0 且打印 `{pid,coreId,owner}`；无租约 → `mode:'independent'`（非失败）；计量未收敛 → `metering-dual-writer`；**desktop host 的 embedded core 未关 → `metering-second-core`**（L9） | 如上；**收敛前不得报 single** | 未跑 |
| **T6 LAN 边界** | 逐 listener 默认不对外的真实状态 | `npm run check:core-boundary -- --lan --json`：netstat 比对租约声明的 listeners；`webRemoteControl=127.0.0.1`、`backend=127.0.0.1`、`AI_MGMT=0.0.0.0 → known-exception-applied:ai-mgmt-host-lan-default`、`unknown-listener=0`；表过期 → warning | 如上；**表+消费者未同批落地前不判绿** | 未跑 |
| **T7 热插拔** | 杀一个终端 suite 仍工作 | `node --test scripts/tests/suite-hotplug.test.js`（headless；7 断言：a1 suite stub 存活 / a2 `khy.capability.lost.v1` 到达 / a3 required 消费者降级不退出 / a4 会话读回 N 条 / a5 重 spawn 后 re-register 并脱降级 / a6 插件双闸同步（`extensions_state.json` enabled ∧ 运行时激活，只改其一 = `plugin-gate-desync`）/ a7 无裸 `setTimeout(...,kill)`） | `# pass 7 / fail 0` | 未跑 |

### 9.2 三形态验收

| 形态 | 判据 | 机判命令 | 前置/现状 |
|---|---|---|---|
| **独立态** | 每端删掉其余终端仍可构建运行，且不加载 composer/suite | (a) **闭包证** `npm run check:core-boundary -- --suite-fork --json`：各端入口闭包 ∌ `apps/suite`、∌ composer（含动态分段文本兜底）；(b) **产物证** 产物目录（按 BUILD-OUTPUTS 的 `path`，迁移期回退 `legacyPath`）grep `composer|khy.suite|apps/suite` = 0；(c) T1 的 build/probe 断言 | 目标态；`check-core-boundary.js` ABSENT（F17）；`entries/*` 迁移前 ABSENT（§9.1 T1 ③④） |
| **组合态** | 一个窗口 + 一套设置 + 一个共享 core；不 fork 终端代码 | T2–T7 逐条通过 + `--suite-fork` 六 finding 归零 + web-quant 仅装登记产物 | suite 不存在；依赖 D4（T5）、D6（T6） |
| **生态态** | 档 1：第三方只拿 `@khy/core`（contracts+client）+ `@khy/plugin-sdk` 在**空目录 + tarball** 跑通 attached 闭环 | `npm pack` 两包到临时空目录 → `node -e "require('@khy/core/contracts')"`（CJS）与 `require('@khy/core/client')` 可解析；`contracts/`+`client/` 内 grep `require\(['"]node:` = 0；从包根 `require.resolve('zod')` 可解析（D9 conformance）；第三方清单经 `npm run check:manifests -- --loose --json` 校验；连真 core 跑 `gateway.generate`（本地 stub HTTP 端点）→ `session.append` 幂等 → `events.subscribe/ack` | 档 2 不进验收（B8 前）；本机无 pnpm/corepack（F13），lockfile 再生与 pack 需在有 pnpm 的机器；`@khy/core` ABSENT → 全部未执行 |

### 9.3 本会话已跑的验收项（可复现）

| 命令 | 输出摘要 |
|---|---|
| `node runtime/node/backend/bin/khy.js entry probe --json` | 7 端 `status=ready` / `drift=null`；`mobile.machine.ok=false`（「本机缺少 flutter，本机无法构建或运行本端」） |
| `node runtime/node/backend/bin/khy.js --version` | exit 0 / `1.2.2` / 112ms |
| `node runtime/node/backend/bin/khy.js entry list --no-probe` | exit 0；7 端清单（就绪 6 / 降级 1） |
| `node scripts/ci/check-core-layers.js` | exit 1；11 ❌ |
| `node scripts/ci/check-rollout-stage.js` | 0 error / 44 warning |
| `node scripts/ci/check-delivery-baseline.js --json` | stage S1；PASS 7 / GAP 5；四项棘轮越界 |
| `node scripts/ci/check-repo-layout.js --json` | exit 1；counts 见 F14 |

---

## 10 与方案原文 / 219 的冲突（更新 v1 §10）

| # | 原文/219 | 实测/本稿 | 矫正 |
|---|---|---|---|
| 1 | suite「单进程」 | Electron 四进程 + host 子进程（`main/index.ts:789-799` 等，F19/问题 7） | 「单窗口 + 组合态单 core 租约」 |
| 2 | `packages/core` 视为可选门面（v1 §1.1） | D1 定 packages/core｜`works/ship` files 不含 core（实测） | 按 D1 两档发布 |
| 3 | 219:411「check:core-layers exit 1（10 error）」 | 本会话实测 **11** 条 ❌（aiGateway 71833） | 读数以当日实测为准；不引用旧读数 |
| 4 | 219 §10 前言（`:289`）「finding 挂 LAYOUT-001/TOOLING-012/COMMS-001」 | §10.3（`:363`）「新执行器 + 不新增」；本稿取后者 | 删除前言旧写法（D3 同旨） |
| 5 | 219:375 的 `ssot` 写「[DESIGN-ARCH-219] 终端清单…」 | 219 是总案；终端清单 = 221 | 落盘时改 221（D10） |
| 6 | `entries.json` 手写真源（v1 §10-6） | D2 定清单为编写真源、投影可复算 | 见 §5.1 |
| 7 | `khy.terminal.json`「全仓 0 个」（v1 §10-6 判 duplicate） | 本会话实测仍 0 个（F17）；D2 决定新增 7 份 | 不是「已有重复」，是「本次新增编写真源」——措辞修正 |
| 8 | 「改端先改这里（数据表）」（`[DESIGN-ARCH-117]` 头注 :5） | D10：翻转为「改端先改终端清单 + 重跑生成器」 | 实施期步骤 6（人批留痕） |

---

## 11 剩余待拍板（人决定；AI 不代改）

1. **core 版本轨道归组**：`@khy/core` 起步版本与是否最终并入某组——本批不并入 G2、不改 `check-version-sync.js` 的 10 源（D1）。首个 npm 发布前定。
2. **`apps/suite` 的注册表语义**：`check-repo-layout.js` 的 LAYERS `apps` 释义 + `[DESIGN-LAY-005] §1` 表加入 suite（D8；needs-registry-change）。
3. **旧锁退役顺序**：`daemon.pid` / `ai_manage_runtime.json`（+legacy 双写、无 coreId）降级为派生投影的执行批次；`/health` 增加身份字段 `{ok,service,pid,startupAt}` 的范围（当前 `webRemoteControl/server.js:389-391` 无身份）。
4. **端口顺延 vs 第二实例**：`aiManagementServer.js:3538-3573`（+10 顺延 + `exclusive:true`）与「第二实例拒绝」并存——建议租约判定先于 listen、顺延只用于同一 owner 内的重试，需人确认。
5. **ai-backend `0.0.0.0` 例外到期日**：KNOWN-EXCEPTIONS 条目的 `expiry` 与 `owner`（D6 保留默认值，只登记）。
6. **DeepSeek / Together 计价修正**：收敛后这两家的 costUSD 会从 default 粗价变为文档价（§4.2）——属行为修正，需人点头（可归入 D4 实施批次）。
7. **user-home 段 schema 裁决**：`token-usage-user-home` 与既有 `phone-discovery-user-home`（DATA-LOCATIONS:233-255）合并成一次裁决（路径形状 / TTL / 清理责任 / 备份归属），还是各自登记。**不裁决则 DATA-LOCATIONS 侧只能挂 knownGaps。**
8. **plugin-loader activate 固定超时**（`index.js:160` 5s）改滑动（需进度事件）——动既有模块。
9. **agentbus 车道归置**：20 处 `KHY_AGENTBUS_*` 是否收编 flagRegistry；「无 token/无 auth」是否维持（桌面 UI 会显示其 usage 读数）。
10. **GUI 端验收手段**：desktop/provider-hub 的 `detach` GUI 目前只能 probe；真 launch 冒烟需另立工具。
11. **LAN TLS**：当前 LAN 通道是明文 + 配对码（§7）；是否要求 TLS、证书来源、与 RUNTIME-001 动态端点的关系。
12. **aiGateway factory 化**（单例 → 工厂，90+ require 站点）：单租约方案下可缓办；同进程双 core 需求出现时先做。
13. **插件 worker/vm 级崩溃隔离**是否立项。
14. **`pluginStore`/ecoMarket** 降级为市场 UI 的节奏。
15. **计量落盘形态**：D4 允许「单一实现」但进程级仍是多写（最后写者覆盖、丢更新，§4.2/§5.4）。选：(a) 单文件 + 跨进程锁；(b) **按 writerId 分文件（每进程一个）+ 读侧合并**。裁决前独立态并存的计量是「可审计但有丢更新」，证③ independent 分支不把它判绿（只判 writerId/schemaVersion）。
16. **LAY-5 产物落点迁移**：`ai-frontend` / `quant-frontend-dist` 两条 BUILD-OUTPUTS 仍 status=`migrating`，现有产物在 `legacyPath`（两个 `dist/`），`entries/*` ABSENT（本会话实测；khyquant `vite.config.js:116` `outDir:'dist'`、ai-frontend 未设 outDir）。迁移完成前验收按 `legacyPath` 解析；是否本轮把 outDir 迁进 `entries/`（或维持 legacyPath 并延长 sunset）需人定。
17. **desktop / provider-hub 的组合态装配形态**：attached host 改造（embedded core 关闭、走 CoreHandle）还是本阶段不装配（只独立态运行）？改造完成前它们不属于「组合态单 core」集合（L9）。「单窗口」的适用范围据此定（仅 view 终端）。
18. **基础 4（`core-not-in-entry-closure`）的退役时机**：该判据按**冷闭包**口径（§8.2）只在迁移期有效；网关迁进 `packages/core` 完成即退役/改写，否则会与「终端只带 core 运行」长期互斥。
19. **七条体验原文回填（落盘前置）**：原文未见（219:428 同记）；回填前 §9.1 只作判据草案，不得作为验收依据。

---

## 12 守卫接线与机制合规（PROCESS-008 / PROCESS-014）

- **不新增 RULES-REGISTRY 条目**（ruleCount 实测 101/94 已越界，F14）：`check-core-boundary.js` 的三组机制以 `rules: []` 登记；finding 全 warning；`samples.source` 用 `counts.<finding-id>` 标量。
- **S1 合规三件套**：warning 发射（`ruleguard/lib/run.js:345` 的阻断判定跟 finding 自己的 severity 走）；不进 `LAYOUT-001 --promote` 名单；执行器恒 exit 0。S1/S2 不得派生 blocking（PP-3）。
- **回退动作（PP-4）**：删脚本 / 摘别名与 pr-gate 步骤 / 删三条机制条目；不依赖未提交代码。
- **别名与接线**：`check:core-boundary`、`suite:validate`、`verify:core-single`、`check:manifests`、`gen:entry-matrix`（npm 脚本，非 CLI 命令，不触任务面棘轮）；`check:wiring` 需看到别名引用（rules-facts 记录 123 接线 / 11 豁免）。
- **schema 文件落点**：`scripts/ci/json-schemas/` 只作文档；`check:json-schemas` 在本仓实测空转（dual-facts：扫描根被 gitignore → 跳过 + 自报 COMMS-002 缺陷）——真防线是 composer 运行时校验 + `check:manifests.js`。
- **LAYOUT-005**：`entries/suite` 登记先行于首个构建（`check:build-root` 判未登记产物）；BUILD-OUTPUTS 新增 `suite-shell` 条目并同批修正 `electron-out`/`electron-dist` 的 rebuild（D8）。

---

## 13 本会话实跑清单与未核实项

**实跑命令（可复现，输出已在上文引用）**：

- `node runtime/node/backend/bin/khy.js entry probe --json` → 7 端 ready / drift null；mobile machine.ok=false。
- `node runtime/node/backend/bin/khy.js --version` → 1.2.2 / exit 0。
- `node runtime/node/backend/bin/khy.js entry list --no-probe` → exit 0。
- `node runtime/node/backend/bin/khy.js zzz-unknown-cmd -p hello` → 未报 unknown-cmd，直接进入 print 分支并发起真实请求（20s 超时被杀）——证明 `-p` 之前的 token 被静默忽略（F21）。
- `node scripts/ci/check-core-layers.js` → exit 1 / 11 ❌。
- `node scripts/ci/check-rollout-stage.js` → 0 error / 44 warning（含 core-layers-guard 两条）。
- `node scripts/ci/check-delivery-baseline.js --json` → stage S1 / PASS 7 / GAP 5 / 四项棘轮越界。
- `node scripts/ci/check-repo-layout.js --json` → exit 1 / counts（root-uncatalogued 110 等）。
- `node -e` 探针：`require.resolve('zod')` 六处 NOT RESOLVABLE；`semver` 六处可解析（F16）。
- `node -e` 读 `%USERPROFILE%/.khyquant/token_usage.json` 两次 → 顶层键始终仅 daily/monthlyTotals、无写者身份；字节数 3969 → 5793（`-p` 探针触发了一次真实计量写入；文件为运行时可变物，断言不锚字节数）（F15）。
- `node -e` 读 `pnpm-lock.yaml` importers → 7 个；`pnpm-workspace.yaml` / 根 `workspaces` → 9 项、无 apps/（F13）。
- `node -e` 读 DATA-SSOT / DATA-LOCATIONS / BUILD-OUTPUTS / FEATURE-OWNERSHIP / ARCHITECTURE-POLICY / CORE-LAYERS；`dir` 核实 `knownGaps`、registry 文件清单、`check-core-boundary.js`/`khy.terminal.json` 等 ABSENT（F17）；CORE-LAYERS roots 三入口与 `budget._note`「冷闭包」原文。
- `node -e` 读 `delivery/channel/khyquant/frontend/vite.config.js`（`:116` `outDir:'dist'`）与 `delivery/web/ai-frontend/vite.config.js`（0 处 outDir）；`dir` 核实 `entries/ai-frontend`、`entries/quant-frontend` ABSENT，两个 `*/dist` EXISTS 且含 index.html。
- `node -e` 读 `preload/index.ts` 的 `ipcRenderer` 方法分布 → invoke 140 / on 11 / removeListener 11。
- `node -e` grep `router.js` 的 `chat` → 0 处命中；`aliases.js:269-277` 记载该动词退役为 `web`/`gateway manage`。
- `node -e` 读 `pairingCode.js:21-26/:54`（TTL 从 `protocol.js` 导入并使用）与 `protocol.js:76-82`。
- `dir /b scripts\tests` → 无 `suite-hotplug.test.js` / `core-lease.test.js`。
- `findstr`：renderer 的 fetch/WebSocket/EventSource 仅 2 处注释命中（F19）。

**未读 / 未跑（不得当已证）**：

1. 七条体验 T2–T7 与三形态验收：**一条未执行**（suite/composer/@khy/core 均不存在，F17）。
2. web / web-quant 的 `npm run build` 未跑（构建可能耗时/需网络）；T1 ③④ 的产物断言未验证——只核实了现状：现有产物在 `*/dist`（含 index.html），`entries/ai-frontend` 与 `entries/quant-frontend` ABSENT，两条 BUILD-OUTPUTS status=`migrating`（§9.1 T1 ④、§11-16）。
3. `dev:suite` / `build:suite` 未跑；本机无 pnpm/corepack（F13），lockfile 再生与生态态 tarball 安装须在有 pnpm 的机器。
4. `scripts/lib/requireGraph.js` 只读源码，**未运行**；`--portable/--suite-fork` 的检出率是设计推断。
5. agentbus（F12）只按 dual-facts 引用，本会话未重读其文件；其 usage 读数是否计入证③口径取决于 §11-9。
6. 会话/凭据并发损坏（blockers #5/#6）来自代码形状与仓内事故注释，本会话无现场复现。
7. `aiManagementServer.js`（3883 行）只读了 :3-10 与 :3538-3576 两段；`check-core-layers` 的 11 条 ❌ 已全列但只取该行与退出码，未取全量统计输出。
8. `check:ssot-data` / `check:data-layout` / `check:build-root` / `check:wiring` 本会话未跑。
9. `delivery/mobile`（Flutter/Dart）不在 coupling-facts scan.roots——其耦合读数是「未扫」而非「无耦合」。
10. `219` 的全文只读了 D1–D10 表、§3.2、§10、§11、§12 风险段；其余章节未读。
