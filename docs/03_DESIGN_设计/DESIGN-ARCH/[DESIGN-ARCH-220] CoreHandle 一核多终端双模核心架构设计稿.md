# [DESIGN-ARCH-220] CoreHandle 一核多终端：双模核心架构设计稿（修订稿 v2）

- 状态：**草稿 · 必须人工评审后才可动手**（本稿不含实现代码，只给契约签名、文件落点、步骤与判据）
- 生成：2026-11-16；本文件是 **v2 修订稿**：逐条关闭 6 项未闭合并对齐决策 D1–D10，修订留痕见 §16.2
- 前版：`.khyos/refactor-drafts/core-handle.md`（第 2 版，806 行）**保留为历史、不再维护**；两稿冲突处一律以本稿为准
- 落盘：按 D10，本稿折叠为 `[DESIGN-ARCH-220]`；落盘前重测编号，被占顺延
- 输入：`.khyos/refactor-drafts/{layout,dual,assets,rules}-facts.json`、`refactor-001-coupling.md`、`decisions-v2.md`，以及 §0.2 的本会话实跑
- 产品意图优先级：**仓库实测 > 2026-11-16 产品意图 > 方案原文**
- 层级真源：`scripts/ci/check-repo-layout.js:111-121`（LAYERS 9 键）、:123-165（CROSSCUTTING 6 键）。

**本轮（v2）关闭的 6 项（逐条对应评审意见，明细在 §16.2）**

| # | 问题 | 关闭处 |
|---|---|---|
| 1 | `resolveEmbedded()` 在 `./client` 与「client 零 `node:`」冲突 | §2.2、§4.0、§8#1、§14.5；测试面 §10.2 |
| 2 | `KHY_CORE_*` 真源改到 client 后无可执行说明符 | §4.1（环境变量纪律整段重写）、§2.2、§1.3 |
| 3 | 7 个 eventLog 写者「本体随 S5 搬」扩大 core 职责 | §6.1、§12 S5、§13.3-4 |
| 4 | `resolveEmbedded` 只认 node_modules，与档 2 bundled 交付矛盾 | §4.0、§4.1 第 5 步、§8#1、§9、§3.4、§14.5 |
| 5 | 机制 `samples.source.key` 必须是 `counts.<id>` 标量 | §13.5 |
| 6 | 不寄生 `check-core-layers.js`；新守卫独立、S1、恒 exit 0 | §13.3、§13.5、§1.3、§12 S1、§10.4 |

---

## 0 证据基线

### 0.1 沿用 v1 的实测（原样保留，作为历史读数）

**实跑（v1 会话，全部 exit 与读数已捕获）**

| # | 命令 | 读数 |
|---|---|---|
| C1 | `node scripts/ci/check-repo-layout.js --json` | 有 error：**root-whitelist 11、root-shadow-dir 2、root-junk 52、layer-registry 6**；warning：root-uncatalogued 80、dangling-task 101、cross-layer-require **37**、domain-direction **199**（消息拆分：d3-purity 37 / d2-no-reach-into-d1 159 / no-reach-into-archive 3）、functional-unit 277、entry-buffer **2415**。baseline 文件值：`cross-layer-require 37`、`domain-direction 199`、`dangling-task 101`、`functional-unit 290`、`entry-buffer 2470` → **三条零余量、entry-buffer 余量 55** |
| C2 | `node scripts/ci/check-repo-layout.js --list=entry-buffer` | 2439 行，其中 **101 行命中 `runtime/substrate/platform/packages/{shared,plugin-sdk,ui-shared}`**（理由文案：「从所在目录到 runtime/substrate/platform 边界内找不到 khy.module.json」）→ 证明该根**已在** entry-buffer 扫描面内 |
| C3 | `node scripts/ci/check-core-layers.js --json` | **exit 1**，12 findings（**10 error**）：`core-budget-lines` L1 `toolUseLoopCore.js` 30629 > 30175（超 1.50%，容差 1%）；4 个 V0 视觉入口超预算（App.tsx 59/37、AppLayout 33/18、Composer 16/11、Transcript 18/17）；`visual-lazy-regression`（App.tsx 的 ToolExecutionPanel 不再懒加载）；2 条 `inversion-lazy` warning |
| C4 | `git grep -n -I -E services/gateway/aiGateway -- runtime/node/backend/src` | **75 处 / 56 文件** |
| C5 | 同上 `-- runtime/node/backend/tests` | **191 处 / 124 文件** |
| C6 | node 遍历 backend/src 内 `require(` 命中 `services/gateway/` 或 `../gateway/` 或 `./gateway/` | **321 处 / 134 文件**（宽口径：含 adapters/protocolConverter/方法分片） |
| C7 | 同上，只算方法分片 + `gateway/adapters/` + `gateway/protocolConverter` | **59 处 / 32 文件** |
| C8 | `git grep -n -I -E gateway/aiGateway -- delivery apps` | 15 行，其中**真实 require 站点 6 处 / 5 文件**：`delivery/channel/khyquant/tools/imageDetect.js:169`、`tools/imageOcr.js:101,160`、`tools/recognizeImage.js:84`、`tools/videoAnalyze.js:292`、`services/strategyRecommender.js:259`；其余 9 行是 `apps/khyos-desktop/docs/**` 与 `delivery/extension/scripts/khy-desktop-rd/**` 的文档/HTML。实测 `delivery/channel/khyquant/services/gateway/` 目录清单**不含 aiGateway.js** → 这 6 处指向的文件不存在，且全部包在 `try{...}catch`（`imageOcr.js:100`、`strategyRecommender.js:258-261`）里静默降级 |
| C9 | node 遍历 backend/src 内 `eventLog` 写入点 | `coordinator/processAgent.js:347`、`coordinator/taskBoard.js:323`、`observability/cpuProfiler.js:167`、`observability/eventLoopMonitor.js:160`、`observability/slowRequest.js:230`、`services/usageTracker.js:177`（`.append`）；`tasks/largeTaskRuntimeStore.js:1812` 是 `eventLog.snapshot(...)` |
| C10 | node 遍历 backend/src 内含 `sessions.db` 的行 | 35 行；**触库方**为 `services/sessionSearchIndex.js`、`services/sessionGroupService.js`（:4-10 自述「分组与成员关系只存在后端 SQLite（sessions.db）」、:28 require sessionSearchIndex）、`services/dbHealthService.js:217-218,229,254-255`、`services/domain/backup/backup/{restoreService.js:22,311,477,487, sqliteHotCopy.js:17, backupAssetPlan.js:13-15,314}`。实测 `services/sessionPersistence.js` **不含** `sessions.db` 字样（0 处）→ 它只写 JSONL/JSON 主副本，库文件由上述模块打开 |
| C11 | `node -e` 读 `runtime/node/backend/src/services/tokenUsageService.js` | :27 `const USAGE_FILE = path.join(os.homedir(), '.khyquant', 'token_usage.json')`；全文**不 require dataHome**（实测 `requires dataHome? false`） |
| C12 | `node -e` 读 `aiGatewayGenerateMethod.js:6108-6117` | `usageTracker.record({ sessionId, model, provider, inputTokens, outputTokens, durationMs, cached, success })` —— **无 coreId 字段** |
| C13 | `dir` 列 `runtime/node/ai-backend/src/services/gateway` | `adapters, aiGateway.js, appLaunchInterceptor.js, dataPlaneEnforcer.js, oauthManager.js, pluginChain.js, protocolConverter, proxyServer.js, rateLimiter.js, relayPage.js, tlsSidecar, ...` → ai-backend **自带整套第二网关**；`FEATURE-OWNERSHIP.json` capabilities[0]/[1] 已把 `runtime/node/ai-backend/src/services/gateway/aiGateway.js` 与 `.../services/tokenUsageService.js` 登记为 forbidden |
| C14 | `node -e` 读 `works/ship/npm/package.json`、`works/ship/modules/modules.json` | npm 清单 `files` = `["bin/","bundled/","scripts/postinstall-compress.js","scripts/install/enable-fs-compression.sh"]`；`modules.json` 全文不含 `plugin-sdk` → **`@khy/plugin-sdk` 不在任何发布面** |
| C15 | `node -e` 读 `docs/10_规范/registry/RULES-REGISTRY.json` | `TOOLING-012`（exec=`check-core-layers.js`）paths 只有 `runtime/node/backend/{src,bin}/**` + 该脚本 + CORE-LAYERS.json，findings 32 项**无** core-boundary-import；`LAYOUT-001`（exec=`check-repo-layout.js`）findings 9 项、paths **已含** `runtime/substrate/platform/**`、`runtime/node/**`、`apps/**`、`delivery/**`；`COMMS-001`（exec=`validate-protocol-contracts.js`）findings **0** 项、paths 含 `backend/src/contracts/**` |
| C16 | `node -e` 读 `check-version-sync.js:57-68` | G2 三源 = `runtime/node/ai-backend/package.json`、`.../packages/shared/package.json`、`.../packages/plugin-sdk/package.json` → **ai-backend 不在 substrate 下** |

### 0.2 v2 本会话复核（2026-11-16，命令与读数逐条可复算）

| # | 命令 | 读数 |
|---|---|---|
| V1 | `node scripts/ci/check-core-layers.js` | **exit≠0**；11 条 ❌：`core-budget-lines` ×2（`toolUseLoopCore.js` 30629>30175、`aiGateway.js` **71833>71078**）、`visual-budget-files/lines` ×8（App/AppLayout/Composer/Transcript）、`visual-lazy-regression` ×1；另有 `inversion-lazy` ×2 warning（`AgentTool/index.js → cli/ai.js`、`toolUseLoopCore.js → cli/toolPrefaceVoice.js`） |
| V2 | `node scripts/ci/check-rollout-stage.js` | **exit 0**；`Summary: 0 error(s), 44 warning(s)`；其中 `core-layers-guard` 报 `rollout-stage-authority-drift`：「声明阶段权威是 scripts/ci/check-core-layers.js 的 STAGE 常量，但文件里找不到该常量」；完整档探针复算 `check-repo-layout.js --json` → `counts.domain-direction=199 / counts.functional-unit=277 / counts.entry-buffer=**2416**` |
| V3 | `node scripts/ci/check-delivery-baseline.js --json` | `stage=S1`；`counts {PASS:7, GAP:5}`；findings 5 条全 warning，含 `delivery-surface-ratchet-breach`：**routerCommands=249/245 · aliasEntries=595/591 · handlerFiles=167/155 · ruleCount=101/94** |
| V4 | `node scripts/ci/check-version-sync.js` | **exit 0**（本批不改 10 源，D1） |
| V5 | `node scripts/ci/check-ssot-data.js` | **exit 0** |
| V6 | `dir /b runtime\substrate\platform\packages` | `moonbit-plugin-sdk、plugin-sdk、shared、ui-shared` —— **无 core** |
| V7 | `if exist scripts\ci\check-core-boundary.js` | **ABSENT**（本重构新增物） |
| V8 | `if exist docs\10_规范\registry\KNOWN-EXCEPTIONS.json` | **ABSENT**（D6 新立载体） |
| V9 | `node -e` 读 `works/ship/npm/package.json` | `name=@khy-os/khy-os 1.2.2`；`files=["bin/","bundled/","scripts/postinstall-compress.js","scripts/install/enable-fs-compression.sh"]`；**无 `dependencies` 键**（v1 C14 记作 `{}`，实测是缺键，效果相同） |
| V10 | `node -e` 数 `pnpm-lock.yaml` importers | **7 个**：`.`、`delivery/channel/khyquant/frontend`、`delivery/web/ai-frontend`、`delivery/web/provider-hub`、`runtime/node/ai-backend`、`runtime/node/backend`、`runtime/substrate/platform/packages/shared`；而 `pnpm-workspace.yaml` packages 实测 **9 项**（含 `ui-shared`、`plugin-sdk`）→ **ui-shared / plugin-sdk 的 importer 本就缺失**（对齐 D1；`assets-facts.json:165` 的「9 个 importer 与 9 包一一对应」实测不成立，以本行为准） |
| V11 | `node -e` require.resolve 探针（根 / `packages` / `packages/shared` / `runtime/node/backend` / `runtime/node/ai-backend`） | **zod 五处全部 NOT RESOLVABLE**；**semver 五处全部可解析**（`D:\Portable\khy-os\node_modules\semver\semver.js`）= 幻影依赖（对齐 D9） |
| V12 | `node -e` 读 `scripts/ci/check-rollout-stage.js:157-169` | `pickKey`（**157–169**）在 **:165-167** 对 `cur === null \|\| cur === undefined \|\| typeof cur === 'object'` 直接返回「`${key} 不是标量读数`」；`:135-154` 的 `normalizeSamplesSource` 只接受 `scripts/` 下执行器 + 非空 `key` |
| V13 | `node -e` 读 `docs/10_规范/registry/FEATURE-OWNERSHIP.json` | `rollout.mechanisms` 共 **40** 条；仅 3 条声明 `samples.source`：`domain-direction-guard`（`counts.domain-direction`）、`functional-unit-guard`（`counts.functional-unit`）、`entry-buffer-guard`（`counts.entry-buffer`），**key 全为 `counts.*`、`rules` 全为 `[]`** |
| V14 | `node -e` 读 `scripts/ci/check-agent-rules.js:621-622` | `isSourceOfTruth = normPath.endsWith('constants/serviceDefaults.js') \|\| normPath.endsWith('lib/core/config/endpoint_defaults.dart')` —— **白名单按路径后缀**，只豁免这两个文件 |
| V15 | `node -e` 读 `scripts/ci/check-repo-layout.js` | LAYERS 9 键 `:111-121`；`WORKSPACE_ROOTS` `:310-322`（11 条，**无 core、无 ui-shared、无 plugin-sdk**）；domain-direction 扫描 `git grep -E "require\(['\"]\."` `:1617`（只认相对 require）；entry-buffer 只扫 `.js/.cjs/.mjs`（`:1699-1700`）且每源文件要求同目录 `*.test.js` |
| V16 | `node -e` 读 `scripts/ci/check-version-sync.js:38-82,:91-110` | `VERSION_SPECS` 10 源、`VERSION_GROUPS` 3 组**硬编码**；G2 = ai-backend + shared + plugin-sdk（组内字节一致） |
| V17 | `node -e` 读 `scripts/ruleguard/lib/run.js:337,345` | 阻断判定 = `finding.strength === 'blocking' && finding.severity === 'error'`（`:345`；`:337` 是抑制无效分支） |

**结构性失明（沿用 v1 读源码确认，本会话未复读该段，标注为 v1 读数）**

| 位置 | 事实 | 后果 |
|---|---|---|
| `check-repo-layout.js:1617` | domain-direction 的扫描是 `git grep -E "require\(['\"]\."`（**本会话复读确认**） | **只认相对 require**；ESM `import` 与裸包名说明符（`@khy/core`）完全不进判据 |
| `check-repo-layout.js:1699,1700`（本会话复读确认） | `SOURCE_UNIT_EXT_RE = /\.(?:[cm]?js)$/`、`COLOCATED_TEST_EXTS = ['.test.js','.test.cjs','.test.mjs']` | entry-buffer 只扫 `.js/.cjs/.mjs`；`.ts/.d.ts` 不扫；每个被扫源文件**必须**有同名同目录 `*.test.js` |
| `check-repo-layout.js:1862-1900,1923-1928,1965-1971,1972-1976,2046-2064`（v1 读数） | 扫描范围 = `coreDomains`(D1,D2,D3) 的落地 roots；找不到治理 `khy.module.json` → `manifest-missing`；manifest 缺 `README.md` 或非整数 `fanIn` → `promotion-incomplete`；缺同目录测试 → `promotion-incomplete`；**超基线即 warning→error** | 在 `runtime/substrate/platform` 下新建包 = 直接落进 entry-buffer；余量 = 2470 − 2416 = **54**（本会话读数） |
| `check-core-layers.js:151,185,213-223,339`（v1 读数） | `nodeFiles = walk(SRC) + walk(BACKEND/bin)`；边收集 `if (!spec.startsWith('.')) continue`；`coldClosure(root)` 对不在 nodeFiles 的 root 返回空集 | **新增 packages/core 的文件与包名依赖对它全盲**；给它加 perRoot 预算会得到恒 0 的绿灯 |

### 0.3 本会话未运行 / 不可运行

- **未直接运行** `node scripts/ci/check-repo-layout.js --json`（`entry-buffer=2416 / domain-direction=199 / functional-unit=277` 来自 V2 的完整档探针输出，不是我直接跑的 JSON）。
- 未运行：`npm run rules:gate`、`test:delivery-baseline`、`docs:verify`、`check:data-layout`、`check:core-boundary`（不存在）。
- `check-core-layers`（V1）与 `check-rollout-stage`（V2）已由脚本本体运行，读数如上。
- **本稿不宣称任何门禁「绿」**：V4/V5 的 exit 0 是读数事实，不等于仓库整体合规（V1 exit≠0、V3 四项越界同在案）。

---

## 1 物理落点：core 放哪里

### 1.1 结论（推荐方案）

**推荐：`runtime/substrate/platform/packages/core` = 新 workspace 包 `@khy/core`，一个包四个可解析子路径
（`./contracts`、`./client`、`./locator-host`、`./server`），外加 §2.2 的 `./contracts/core-env`。**

同包不拆两包的理由：① 生态态要求 `npm i @khy/core` 一次拿到 embedded(`./server`) 与 attached(`./client`)；
② 浏览器安全由 exports 封闭子路径保证，与包数无关；③ 版本轨道只 +1 源。

**这一选的代价必须在 S1 一并付掉（V2 读数）**：该路径已在 D1 roots 内 → 落在 entry-buffer 扫描面上，
余量 **54**（2470 − 2416）。故 `@khy/core` 的 S1 交付物**必须**包含合规三件套：

| 合规件 | 位置 | 判据 |
|---|---|---|
| 治理 manifest ×1 | `packages/core/khy.module.json`（domain=**D1**, lifecycle.stage=staged, fanIn=整数）。**不再给 contracts 子目录单独挂 domain=D3 的 manifest**——D1 已裁决不进 D3（`enforced[0] d3-purity` 禁止 D3→D1/D2/D4/D5，承载网关的 core 进 D3 立即自相矛盾）；`findGoverningManifest` 自文件目录上溯到 root 边界（`check-repo-layout.js:1923`，v1 读数），包根一份即覆盖全树 | v1 :67 的「manifest ×2（contracts 挂 D3）」作废，理由见 §16.2 R26 |
| 单元 README ×1 | 与 manifest 同目录的 `README.md` | `:1965`（v1 读数） |
| 同目录测试 | **每个** `.js/.cjs/.mjs` 源文件旁放 `<base>.test.js`（`.d.ts` 不扫，`:1699-1700`） | `:1972-1976`（v1 读数） |
| 文件数上限 | S1 只提交 `contracts`+`client`+`locator-host`+`server` 骨架；合规件齐备时 entry-buffer **不增加**；任何缺失即按文件数 1:1 加读数，超 2470 直接升 error | C1/C2 + V2 |

写法约定（避免编译器与新产物登记，见 §2.2）：契约与 schema 用 **JSDoc-typed `.js` + 手写 `.d.ts`**
（`.d.ts` 不进 entry-buffer，`.js` 因有同目录测试也不进）。这与 `@khy/plugin-sdk`（141 行纯 JS、
package.json 无 `scripts`、零依赖）同型，是本仓唯一可照抄的先例。

### 1.2 逐项评估 (a)/(b)/(c)

| 候选 | 判定 | 依据 |
|---|---|---|
| **(a) `runtime/substrate/platform/packages/core`** | **采纳（附 §1.1 合规三件套）** | 已被 LAYERS 的 L1 键 `runtime/substrate/platform` 覆盖（`check-repo-layout.js:113`，V15），不新增顶层目录、不触发 `layer-registry`；同目录已有四个 workspace 包（`dir /b` 实测 V6：moonbit-plugin-sdk/plugin-sdk/shared/ui-shared）；`LAYOUT-001` 的 paths 已含该路径（C15）。代价：entry-buffer 扫描面内，须按 §1.1 付合规件 |
| (b) `runtime/node/core` | 不采纳 | ① 不在任何 DOMAIN-DEPS roots 内（`DOMAIN-DEPS.json:53-60` 只列 backend 的四个子目录）→ 域方向盲区；② 反而**躲开** entry-buffer（D1 根不覆盖它）——这是躲判据不是好设计；③ 需同改 D1.roots + WORKSPACE_ROOTS + workspace 三处，登记成本不低于 (a) |
| (c) 新增顶层 `packages/` | 不采纳 | `layout-facts.json:124-125` 判 `packages/core` = `needs-registry-change`（顶层 `packages/` 从未存在）；新建要同改 `[DESIGN-LAY-005] §1` 表 + LAYERS + DOMAIN-DEPS + ROOT_CATALOG 四处，且与「共享包已登记在 substrate」形成第二落点（`:132-138` 判 duplicate） |

### 1.3 与三张登记表的一致性（按 D1 裁决改写）

- **LAYERS**：L1 键覆盖，无需改名册。
- **DOMAIN-DEPS**：**不改**。`runtime/substrate/platform` 现属 D1（`:53-60`），core 落其下**自动**进入 D1 判据面；
  **严禁**加 D3.roots（D1 rationale：`enforced[0] d3-purity` 会立刻自相矛盾）。v1 §1.3 的「contracts → D3」两条新 roots 作废。
  contracts 的零依赖不再靠域机制兜底，改由 §13.3 的 `core-boundary-import` 判（三形态；contracts 子树同在 `packages/core/**` 内）。
- **CORE-LAYERS**：L0 预算 9 文件/3757 行、L1 三根预算、入口顶层 require 预算 6/999 —— 因
  `check-core-layers.js:151/185/213-223` 的失明（§0.2 表），**core 包不会自动进入这些读数**；
  v1「core 被入口顶层 require 就会撞预算」的说法已撤回（v1 §1.3 同款撤回保留）。闭包判据改由 §13.3-3 的独立守卫承担（D3）。
- **需改的登记文件与批准人**（全部需人批准）：

| 文件 | 改动 |
|---|---|
| `pnpm-workspace.yaml:1-10` + 根 `package.json` 的 `workspaces`（现 9 项，`assets-facts.json:164`） | 追加 `runtime/substrate/platform/packages/core` |
| `pnpm-lock.yaml`（现 **7 个 importer**，V10） | 同批再生 core 的 importer；**顺带补 `ui-shared`/`plugin-sdk` 两个存量缺口**。本机实测无 `pnpm`/`corepack`（D1），须在有 pnpm 的机器执行——在此之前「档 1 可独立安装」只到设计契约层 |
| `scripts/ci/check-repo-layout.js:310-322` WORKSPACE_ROOTS | 追加 core，**同批补 `ui-shared`/`plugin-sdk` 两个既有缺口**（否则跨包深引用判据对它们失明，前科见 :302-309 注释） |
| `runtime/node/backend/package.json` + `pnpm-workspace.yaml` overrides | **声明双件套（S1 必做）**：backend `dependencies` 加 `"@khy/core": "workspace:*"`（或 `"*"`，`.npmrc` 已 `link-workspace-packages=true`），并在 `pnpm-workspace.yaml` overrides 加 `khy-os-backend>@khy/core: workspace:*` —— 沿 `@khy/plugin-sdk` 先例（backend `peerDependencies["@khy/plugin-sdk"]="*"` + `peerDependenciesMeta.optional:true`；同文件 overrides 同名 `workspace:*`；`.npmrc` 之 `link-workspace-packages=true` 只作用于**已声明**依赖、`auto-install-peers=false` 不代装）。**只进 workspace/importer 不产生可解析链接** → `serviceDefaults` 的 `require('@khy/core/contracts/core-env')` 会 MODULE_NOT_FOUND（本会话实测 backend package.json 无 `@khy/core` 任何声明） |
| `apps/khyos-desktop/package.json` | desktop **不在** pnpm workspace（`pnpm-workspace.yaml` 9 项不含 `apps/`）：renderer/host 消费 `@khy/core/{contracts,client,locator-host}`，须在自身 `devDependencies` 声明 `"@khy/core": "file:../../runtime/substrate/platform/packages/core"`（npm 侧解析，dev/build 期）。安装包能否随带属 B8 打包验证项（electron-vite 默认外部化 `dependencies`，而 `build.files` 实测只有 `out/**`、`resources/**`，`dual-facts.json:81-83`），本稿不承诺 |
| `scripts/ci/check-agent-rules.js:621-622` | 把 `packages/core/src/contracts/core-env.js` 加入 `isSourceOfTruth` 白名单（**S1 必做**，见 §4.1；v1 §1.3 的「仅当…时同批改」条件句删除） |
| `docs/10_规范/registry/FEATURE-OWNERSHIP.json` | 机制条目**按执行器分登**（§13.5 映射表）：`core-boundary-guard` → `check-core-boundary.js`；`terminal-manifest-guard` → `scripts/ci/check-manifests.js`（D2）；`suite-assembly-guard` 的执行器随 Suite 稿（222）落地时再登，**执行器与 `counts` 键未定前不登**。全部 `stage:'S1'`、`rules:[]`、`samples.source.key=counts.<id>`（标量） |
| `docs/10_规范/registry/API-SURFACE.json` | `CORE_*`/`CAPABILITY_*` 错误码 13 个（§3.4） |
| `docs/10_规范/registry/DATA-LOCATIONS.json` + `DATA-SSOT.json` | `core.lock` / `locator.json` / 事件日志条目（§6.3） |
| `package.json` + `.github/workflows/pr-gate.yml` | `check:core-boundary` 别名 + pr-gate 步骤（D3；S1 恒 exit 0，只记录） |
| **不改** | `DOMAIN-DEPS.json`、`check-version-sync.js`（10 源）、`AGENTS.md` 版本同步节 —— 均按 D1 |

> `[DESIGN-LAY-005] §1` 正文仍写旧目录名（漂移实测见 `layout-facts.json:232-237`）；本稿按守卫名册，
> 不改该文档（只读边界），文档订正另立任务。

---

## 2 包与导出面

### 2.1 包名结论：沿用 `@khy/*`，包名 `@khy/core`

`@khy/shared`/`@khy/plugin-sdk` 已在 workspace 与 G2 轨道（`check-version-sync.js:62-68`）；
`@khy-os/*` 只出现在 `works/ship/npm/package.json:2`、一个仓内不存在的可选 peer
（`runtime/node/backend/package.json:166`）与根 `package.json:218` 的
`install:mobile --filter @khy-os/mobile-companion`（成员不在 workspace）——三处见
`assets-facts.json:151`。改作用域要动 G2 三源 + `pnpm-workspace.yaml` overrides +
backend 的 `file:./vendor/shared`，破坏性大、收益为零。

### 2.2 导出面（契约 · 按 CH-1/CH-2 改写）

```jsonc
// runtime/substrate/platform/packages/core/package.json
{
  "name": "@khy/core",
  "type": "commonjs",
  "main": "./src/contracts/index.js",
  "exports": {
    ".":                    { "types": "./src/contracts/index.d.ts",   "default": "./src/contracts/index.js" },
    "./contracts":          { "types": "./src/contracts/index.d.ts",   "default": "./src/contracts/index.js" },
    "./contracts/core-env": { "types": "./src/contracts/core-env.d.ts", "default": "./src/contracts/core-env.js" },
    "./client":             { "types": "./src/client/index.d.ts",      "default": "./src/client/index.js" },
    "./locator-host":       { "types": "./src/locator-host.d.ts",      "default": "./src/locator-host.js" },
    "./server":             { "types": "./src/server/index.d.ts",      "default": "./src/server/index.js" },
    "./package.json": "./package.json"
  },
  "dependencies": { "zod": "X.Y.Z" },   // 精确三段，不用 ^（D9）；X.Y.Z 实施期以 pnpm add 时可得的最新稳定版固化
  "scripts": { "test": "node --test src/**/*.test.js" }
}
```

- **不引入编译步骤**：源码是 `.js`（JSDoc 类型）+ 手写 `.d.ts`，与 `@khy/plugin-sdk`（无 `scripts`、零依赖、纯 JS）同型。
  理由：仓内**没有**任何 schema→TS 或 TS→JS 的 codegen（`dual-facts.json:151`），若 core 需要 tsc，就必须按 LAYOUT-005
  把产物登记进 `entries/<producer>` + `BUILD-OUTPUTS.json`——那是另一刀，且与 CH-4「不新增构建产物」直接冲突（§14.2）。
- **封闭 exports + `types` 条件**：深导入 = `ERR_PACKAGE_PATH_NOT_EXPORTED`（v1 :152-153 的结论保留）；
  `.d.ts` 只在 `types` 条件下暴露，不会被运行时解析。
- **`./locator-host` 是唯一允许 `node:` 的解析面**（CH-1）：文件 `src/locator-host.js`，不放 `src/client/` 目录内——
  按目录扫描的 browser-safety 判据（§14.5）才不会被它污染。`./client`、`./contracts` 保持零 `node:`、零副作用。
- **`./contracts/core-env` 是 `KHY_CORE_*` 的唯一真源面**（CH-2）：backend 只从这个**已导出**子路径读；
  深导入 `@khy/core/src/contracts/core-env.js` 被封闭 exports 拒绝，跨层相对 require 同时命中
  `check-repo-layout.js:1617`（domain-direction 只认相对 require）与 `:302-309` 的跨 workspace 深引用判据。
- **用子路径而不是 `browser` 条件导出**：本包要同时被 CJS（backend/host）、electron-vite（desktop）、
  vite（两个前端）解析（`assets-facts.json:171-172`）；`browser` 条件在 CJS 解析器里不生效、
  在 bundler 间行为不一致，子路径是物理隔离。
- 浏览器安全三道（v2 版）：① exports 封闭；② §14.5 的 browser-safety 扫描 **`src/contracts/**` + `src/client/**`**
  0 处 `node:`、0 处未守卫 `process.env.`（守卫式豁免只认 `readCoreEnv()` 的 `typeof process` 首行）；
  ③ 前端 vite 构建本身对 `node:` 失败。v1 的「除 coreEnv.js 外」豁免口径作废（该文件已移出 client/contracts 豁免面）。
- **桌面 renderer** 只能 import `@khy/core/contracts` 与 `@khy/core/client`（desktop 不在 pnpm workspace，
  须在自身 `package.json` 声明 file: 依赖，见 §1.3 登记表）；
  `preload/index.ts:348` 的 `contextBridge` 收口不变（`dual-facts.json:163`）。

### 2.3 版本轨道：**不并入 G2**（D1 改写，v1 §2.3 作废）

- 实测（V16）：`check-version-sync.js:38-82` 的 `VERSION_SPECS` 与 `:91-110` 的 `VERSION_GROUPS` 是**硬编码字节一致组**；
  G2 = ai-backend + `@khy/shared` + `@khy/plugin-sdk`。把 `@khy/core` 并入 G2 会强制 core 等于该组当前版本。
- 裁决（D1）：**本重构不并入 G2、不改 `check-version-sync.js` 的 10 源、不改 `AGENTS.md` 版本同步节**；
  core 起步版本与轨道归组在首个发布前由人拍板（§15-1）。
- v1 :750「`@khy/core` 入 G2（§2.3）」与 v1 §2.3 整节作废（decisions-v2 §0 已列为待订正项，本稿订正完毕）。
- 本次只读边界，**不 bump 任何版本号**。

---

## 3 CoreHandle 契约

落点：`packages/core/src/contracts/`（`.js` + 手写 `.d.ts` + zod schema `.js`，每 `.js` 配同目录测试）。
JSON Schema 镜像落 `runtime/node/backend/src/contracts/core/`（该目录已在 `COMMS-001` paths 内，C15），
两侧一致性由测试钉住（先例：`plugin-sdk` ↔ loader 回退校验器，`plugin-sdk/index.js:9-13`）。

### 3.1 顶层句柄

```ts
export type CoreMode = 'embedded' | 'attached';
export interface CoreVersion { core: string; protocol: number; enginesKhy: string } // enginesKhy 语义同 plugin manifest 的 engines.khy（plugin-sdk/index.js:40）
export interface CoreHandle {
  readonly mode: CoreMode;
  readonly coreId: string;
  readonly epoch: number;            // fencing 计数，见 §4.2
  readonly version: CoreVersion;
  readonly gateway: CoreGateway;
  readonly events: CoreEvents;
  readonly storage: CoreStorage;
  readonly session: CoreSession;
  readonly capabilities: CoreCapabilities;
  readonly plugins: CorePlugins;
  readonly paths: CorePaths;         // 只读投影，由 core 解析后下发，客户端不得自行解析
  close(): Promise<void>;            // 幂等；embedded 释放锁
}
```

### 3.2 六个成员的方法面

```ts
export interface CoreGateway {
  generate(req: GenerateRequest, ctx?: CallCtx): Promise<GenerateResult>;
  stream(req: GenerateRequest, onChunk: (c: StreamChunk) => void, ctx?: CallCtx): Promise<StreamResult>;
  abort(requestId: string): Promise<boolean>;      // true = 确实中止了在途请求
  status(): Promise<GatewayStatus>;                 // 只读投影（对应 aiGateway.health()，dual-facts.json:9）
  models(): Promise<ModelCatalog>;
  onStatus(cb: (s: GatewayStatus) => void): Unsubscribe;
}
// GenerateRequest = { prompt: string; options?: Record<string, unknown> }
// —— 与现存 host 侧形状兼容（apps/khyos-desktop/src/host/index.ts:120-122）

export interface CoreEvents {
  publish(e: Omit<CoreEvent, 'seq' | 'ts'>): Promise<CoreEvent>;
  subscribe(filter: EventFilter, handler: (e: CoreEvent) => void): Subscription;
  replay(filter: { since: number } & EventFilter): Promise<CoreEvent[]>;
}
export interface Subscription { readonly subscriberId: string; ack(seq: number): void; unsubscribe(): void }

export interface CoreStorage {
  read(ref: DataRef): Promise<Uint8Array | null>;
  write(ref: DataRef, data: Uint8Array, opts?: { ifVersion?: string }): Promise<{ version: string }>;
  list(prefix: DataRefPrefix): Promise<DataRefInfo[]>;
  watch(prefix: DataRefPrefix, cb: () => void): Unsubscribe;
}
// DataRef = { tier: 'T0'|'T1'|'T2'|'T3'|'T4'; name: string }，档位真源 DATA-LOCATIONS.json
//（dataHome.js:40-45 的 DATA_PATHS 由该表派生）；契约面不出现绝对路径

export interface CoreSession {
  create(opts: { cwd: string; title?: string; terminalId: string }): Promise<SessionMeta>;
  list(filter?: { limit?: number; since?: number }): Promise<SessionMeta[]>;
  messages(sessionId: string): Promise<SessionMessage[]>;
  append(sessionId: string, msg: SessionMessage, ctx: { clientMsgId: string }): Promise<{ seq: number; deduped: boolean }>;
  rename(sessionId: string, title: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
  search(query: string, opts?: { limit?: number }): Promise<SessionHit[]>; // optional 能力
  groups(): Promise<SessionGroup[]>;                     // 分组真源在 sessions.db，见 §6.2
  setGroup(sessionId: string, groupId: string): Promise<void>;
}

export interface CoreCapabilities {
  list(): Promise<Capability[]>; has(id: string): Promise<boolean>;
  get(id: string): Promise<Capability | null>;
  onChange(cb: (c: Capability) => void): Unsubscribe;
}
export interface Capability { id: string; version: string; state: 'available'|'degraded'|'missing'; requiredBy?: string[]; reason?: string }

export interface CorePlugins {
  list(): Promise<PluginInfo[]>;
  enable(namespace: string): Promise<PluginInfo>;
  disable(namespace: string): Promise<void>;
  status(namespace: string): Promise<PluginInfo | null>;
  onChange(cb: (i: PluginInfo) => void): Unsubscribe;
}
```

### 3.3 幂等性清单

| 方法 | 幂等 | 语义 |
|---|---|---|
| `close/abort/unsubscribe/ack` | **必须** | 重复调用结果一致、不抛 |
| `plugins.enable/disable` | **必须** | 同 namespace 重复 enable = no-op 并回当前 `PluginInfo` |
| `session.append` | **必须**（按 `clientMsgId`） | 重复 append 返回首次 `seq` 且 `deduped:true`；重连续传的基础 |
| `session.setGroup` | **必须** | upsert（`sessionGroupService.js:16` 已声明「ensureMembership 用 upsert」） |
| `storage.write` | **必须**（同 ref 同内容 → 同 version） | `ifVersion` 不匹配抛 `CORE_STORAGE_CONFLICT` |
| `capabilities.*`、`gateway.status/models`、`session.list/messages/groups` | 只读 | 可缓存 |
| `session.create` | **不幂等** | 每次新会话；重试去重归终端 |
| `events.publish` | 幂等（按 `event.id`） | 重复 id 不重复入序 |

### 3.4 错误类型（v2 增补 `CORE_LOCATOR_FAILED`，CH-4）

```ts
export type CoreErrorCode =
  | 'CORE_UNAVAILABLE' | 'CORE_LOCKED' | 'CORE_TAKEN_OVER' | 'CORE_PROTOCOL_MISMATCH'
  | 'CORE_VERSION_MISMATCH' | 'CORE_AUTH_FAILED' | 'CORE_INVALID_ARGUMENT' | 'CORE_INTERNAL'
  | 'CORE_LOCATOR_FAILED'
  | 'CAPABILITY_UNAVAILABLE' | 'CORE_STORAGE_CONFLICT' | 'CORE_SESSION_NOT_FOUND' | 'CORE_EVENT_GAP';
export class CoreError extends Error { code: CoreErrorCode; retryable: boolean; details?: Record<string, unknown> }
```

登记要求：13 个 `CORE_*`/`CAPABILITY_*` 码须先入 `docs/10_规范/registry/API-SURFACE.json` 的
`errorCodeRegistry`（实测该表已有 14 个 SCREAMING_SNAKE 码），并补 `COMMS-001` 的
`exec.findings`（实测为 0 项）——「先登记后实现」= `API-001`/`[DESIGN-API-002] §4`。
`CORE_LOCATOR_FAILED` 与 `CORE_UNAVAILABLE` 的分工：前者 = **实现定位失败**（安装/打包问题，重试无意义）；
后者 = 端点探活失败（在途调用 `retryable:true`）。

### 3.5 zod schema 落点

`packages/core/src/contracts/schemas/{core-handle,event,data-ref,session,capability,plugin,error}.schema.js`
+ 同名 `*.schema.test.js`（entry-buffer 的 colocated 判据）。桌面端 zod 早已声明
（`apps/khyos-desktop/package.json:52`）但全仓 0 处 import（`dual-facts.json:150` 的「本仓未使用」与 `:269-270` 的 `zod_import_files=0` 实测）；core 自带依赖，
不改其它包。版本按 D9 精确锁（§2.2）。

---

## 4 obtainCore() / obtainCoreNode() 判定算法

### 4.0 双入口：`client` 编排 + `locator-host` 平台实现（CH-1 / CH-4）

**换掉 v1 的「obtainCore 直接读 locator 文件 + 解析 node_modules」单一落点**——那两件事都要 `node:`，
与 `./client` 零 `node:` 的判据冲突。

| 入口 | 文件 | 允许什么 | 做什么 |
|---|---|---|---|
| 浏览器/第三方 attached | `packages/core/src/client/obtain-core.js`（导出为 `./client`） | 零 `node:`、零副作用；只用显式参数、`readCoreEnv()`、注入的 locator 内容/句柄、全局 `fetch` | 编排：显式参数 / 用户显式 env（直接调 `readCoreEnv()`，`opts.env` 可覆盖）/ suite 注入验活 / `fetch {endpoint}/core/health` 指纹比对 / 返回句柄或抛 `CORE_*` |
| Node 宿主 / CLI / embedded | `packages/core/src/locator-host.js`（导出为 `./locator-host`） | **唯一允许 `node:` 的源文件**（fs、net、child_process） | `readLocatorFile()`（fs 读 `<dataHome>/core/locator.json`；数据家由调用方传入的 `paths` 提供，本文件不造第二条解析链）、`resolveEmbedded({ entry })`（§8#1 定位顺序）、`obtainCoreNode(opts)`（组合两者，供 desktop host / CLI / daemon 使用） |

- **反向边禁令**：`src/contracts/**`、`src/client/**` 内不得出现 `locator-host` 字面量（含 require/import 动态拼接）；
  机判见 §13.3 子档 `core-client-node-free`。
- **两个入口，不是一个**：`obtainCore()`（`./client`）**只做 attach**——不读文件、不 spawn、不解析实现入口；
  `obtainCoreNode()`（`./locator-host`）是 `mode:'auto'|'embedded'` 与 `allowSpawn` 的**唯一入口**，
  负责 locator 文件读取、四段定位与进程内起 core。浏览器侧只能走显式 endpoint（web 本就只 attach，v1 §8#4 / §11-9）。
- 第①段「显式注入」同时接受**路径字符串**与**模块对象**：electron-vite 把 core 打进产物时，宿主注入的是
  已加载的模块对象而非磁盘路径——两者都算「显式注入」，不触发任何 fs 探测。

### 4.1 优先级（首个命中即停）与定位顺序

```ts
// ./client —— 浏览器 / 第三方 attached；零 node:，只 attach，绝不 spawn
export interface ObtainCoreOptions {
  endpoint?: string; token?: string;         // 显式坐标 = 最高优先级
  locator?: LocatorRecord;                   // 调用方注入的 locator 内容（client 不读文件）
  env?: CoreEnvValues;                       // 测试/宿主覆盖 readCoreEnv() 的返回值
  required?: string[];                       // 必需能力 id；缺 → 启动期失败
  terminalId: string; clientVersion: string;
}
export function obtainCore(opts: ObtainCoreOptions): Promise<CoreHandle>;   // 只 attach

// ./locator-host —— Node 宿主 / CLI / daemon；auto 与 embedded 的唯一入口
export interface ObtainCoreNodeOptions extends ObtainCoreOptions {
  mode?: 'auto' | 'embedded' | 'attached';   // 缺省 'auto'
  bundledEntry?: string | { module: unknown }; // 宿主传入的 embedded 实现（路径或已加载模块；CH-4）
  allowSpawn?: boolean;                      // 仅 embedded 有效；默认 false
  paths?: CorePaths;                         // 解析后的数据家（读 locator / 抢锁用）
}
export function obtainCoreNode(opts: ObtainCoreNodeOptions): Promise<CoreHandle>;
```

1. **显式参数** → attach，不读全局/环境/发现文件（两个入口都实现）；
2. **用户显式 env**：`KHY_CORE_ENDPOINT` / `KHY_CORE_TOKEN` / `KHY_CORE_MODE`，唯一读取点 =
   `@khy/core/contracts/core-env` 的 `readCoreEnv()`（§4.1 末段；contracts 子路径零 `node:`，client 可直接调用）。
   仲裁顺序 **用户显式 env > suite 注入 > 默认**，与 D6 写死的仲裁原则一致（D6 的对象是 `AI_MGMT_HOST`；
   本条是把同一原则用于 `KHY_CORE_*`，属本稿的设计选择）；
3. **suite 注入**：`globalThis[Symbol.for('khy.core')]`。命中后**必须验活再用**：
   `handle.version.protocol === CORE_PROTOCOL` **且** `await handle.capabilities.list()` 在 250ms 内返回；
   校验失败 → 丢弃该句柄并记 `core.stale-injection` 警告，继续第 4 步；
4. **发现端点探测**：locator 内容由**调用方注入**（`opts.locator`；Node 侧 `locator-host.readLocatorFile()` 读
   `<dataHome>/core/locator.json`）→ `GET {endpoint}/core/health`（client 用全局 `fetch`），比对 §4.5 定义的指纹；
   **探测失败的分流是确定的**：
   - 端口无响应/连接拒绝 → 视为无核心，进入第 5 步；
   - 有响应但指纹不符（`coreId`/`protocolVersion`/`pid` 任一不匹配 locator）→ **判 `CORE_PROTOCOL_MISMATCH`
     并终止**，绝不进入第 5 步（否则会对「别人占着的端口」起第二个 core）；
   - **禁止端口区间扫描**（现存反例 `apps/khyos-desktop/src/main/remote/index.ts:219-239` 扫 base..base+3）；
5. **embedded 回退（仅 `obtainCoreNode` 实现）**：仅当 `mode:'embedded'` 或 `allowSpawn===true`。
   **先按 §8#1 的四段定位顺序拿到实现**（显式注入 > 宿主传入的 bundled 入口 > `node_modules/@khy/core` >
   诚实报错 `CORE_LOCATOR_FAILED`），再抢锁（§4.2）；抢到 → 进程内起 core server（`127.0.0.1` + 临时端口）；
   抢不到且持锁者新鲜 → **转 attach**，不 spawn。**定位失败不 spawn、不猜路径、不回退仓库相对路径**。

**算法归属（评审项 1 的闭合点）**：第 1–4 步在 `./client` 的 `obtainCore()` 内实现——全部输入由调用方/宿主注入，
不碰 fs、不 spawn，因此**零 `node:` 可完成**；第 4 步的 locator **文件读取**与第 5 步整体只在 `./locator-host` 的
`obtainCoreNode()` 内。`obtainCore()` 永不 spawn、永不读文件；`obtainCoreNode()` 是 embedded 的唯一入口。

**环境变量纪律（真源在 contracts 子路径，CH-2 —— v1 §4.1 的「client/coreEnv.js 为真源 + backend 反向 re-export」作废）**

- 真源文件：`packages/core/src/contracts/core-env.js`，导出子路径 `@khy/core/contracts/core-env`（§2.2）。
  `KHY_CORE_ENDPOINT` / `KHY_CORE_TOKEN` / `KHY_CORE_MODE` 的键名与默认值只在这一处定义。
- **零副作用**：import 期不读 env；导出 `CORE_ENV_KEYS`（常量）+ `readCoreEnv()`（调用时才读）。
- **浏览器安全**：`readCoreEnv()` 首行 `if (typeof process === 'undefined' || !process.env) return {}` ——
  浏览器/worker 返回空对象而不是 ReferenceError。browser-safety 扫描因此把该文件作为**守卫式豁免**
  （判据：`typeof process` 守卫必须是函数体首条语句），不再需要 v1 的「client 内唯一豁免 coreEnv.js」口径。
- **backend 消费**：`runtime/node/backend/src/constants/serviceDefaults.js` 只 `require('@khy/core/contracts/core-env')`；
  **可解析前提** = §1.3 登记表里的 backend 依赖声明（`dependencies` 或 optional peer）与 `pnpm-workspace.yaml` override——
  只进 workspace/importer 不产生链接，今日 backend 无 `@khy/core` 任何声明；
  **禁止**跨层相对 require 上跳（`packages/core` 在 `runtime/substrate/platform/...`，相对路径逃出包根、同时命中
  `check-repo-layout.js:1617` 的 domain-direction 与 `:302` 的跨 workspace 深引用），**禁止**深导入
  `@khy/core/src/...`（封闭 exports 拒绝为 `ERR_PACKAGE_PATH_NOT_EXPORTED`，v1 :152-153）。
- **白名单硬前置（S1 必做，不是可选）**：`scripts/ci/check-agent-rules.js:621-622` 的 `isSourceOfTruth` 只豁免
  `constants/serviceDefaults.js` 与 `endpoint_defaults.dart` 两个后缀（V14 实测）；`core-env.js` 内含端点/端口默认值，
  必须同批加入豁免，否则 RUNTIME-001 立即判 error。v1 §1.3 表里「仅当 KHY_CORE_* 真源改到 core 时同批改」的模糊条件句删除。

### 4.2 单实例锁 + fencing（pid + port + token + epoch + stale）

```ts
export interface CoreLockRecord {
  coreId: string; pid: number; port: number; host: string;
  tokenHash: string; protocolVersion: number; coreVersion: string;
  epoch: number;                 // 每次接管 +1
  startedAt: number; heartbeatAt: number;
}
```

| 项 | 规则 |
|---|---|
| 创建 | `fs.openSync(lock,'wx')` 独占创建（不用 flock：Node 无内建、Windows 无 flock 语义；既有先例是 pid 文件 + `process.kill(pid,0)`，`daemonManager.js:19,30-45,92-99`） |
| 心跳 | 每 10s **带 fencing 的**重写：先读现锁，若 `lock.coreId !== self.coreId` → **不重写**，改为自己降级为 attach + 抛 `CORE_TAKEN_OVER` |
| stale 判定 | `!isAlive(pid)` **或** `now - heartbeatAt > 30s`；两者皆需再等一个 10s 周期**二次确认**（避免把一次 GC 停顿误判为死亡） |
| 接管 | 二次确认仍 stale → 旧锁改名隔离到 `<dataHome>/core/core.lock.stale.<ts>`（不删除，`LAYOUT-004`），新锁 `epoch = 旧 epoch + 1`；**写 locator/计量前必须比对 epoch**，落后即自我降级为 attach |
| 心跳超时口径 | 30s 是空闲阈值，不是固定 kill：持锁者仍活跃（有工具结果/流块）就续期，符合 `RUNTIME-003` |
| 端口漂移 | 允许（`aiManagementServer.js:3538-3573` 最多 +10），但 locator 写入必须持锁且比对 epoch；禁止后写者覆盖 |
| Windows/Linux | 统一「独占创建 + pid/心跳/epoch」；Windows 的 PID 复用窗口如实承认，缓解 = 心跳只能由持 coreId 者刷新 + health 指纹三字段匹配 + 旧锁留档；Linux 同规则 |
| 数据家 | 锁/locator 与数据文件必须在同一解析家（`dataHome.js:1-31`）；不一致时诚实播报，不静默择一 |

### 4.3 attach 握手

```http
POST /core/hello
{ "protocolVersion": 1, "clientVersion": "x.y.z", "terminalId": "desktop", "required": ["gateway","session"] }
200 → { "coreId","coreVersion","protocolVersion","enginesKhy","epoch",
        "capabilities":[{"id","state","version"}…], "paths":{…}, "sessionToken","expiresAt" }
4xx → { "code","message","retryable","details" }
```

- **版本**：`protocolVersion` 必须相等；`clientVersion` 走 `enginesKhy` semver 区间
  （同类检查先例 `plugin-loader/index.js:245-248`）。
- **能力**：客户端 `required[]`；core 回六成员各自 `available|degraded|missing`（检活沿用
  `services/entrypoints/probe.js` 的只读探测，`dual-facts.json:33`）。
- **鉴权**：同机用 locator `token`；异机复用配对机制（`webRemoteControl/protocol.js:75-78` 8 位码 +
  10min TTL + `:20` viewer/operator）。失败 → `CORE_AUTH_FAILED`，**不降级放行**
  （`RUNTIME-010` A2-3/A2-7）。

### 4.4 拒绝第二个 core 与用户可见错误

路径（`obtainCoreNode({mode:'embedded', allowSpawn:true})`）：第 2 个进程抢锁失败且持锁者新鲜 → **绝不 spawn**；
`mode:'auto'` 时先尝试 attach，成功即正常返回；否则抛 `CORE_LOCKED`。

```
第二个核心实例拒绝启动 (CORE_LOCKED)：已有核心运行于 PID 1234、端口 9090（心跳 2s 前，epoch 3），
同一数据家只允许一个写者；请运行 khy doctor 查看核心状态，或设置 KHY_CORE_ENDPOINT 连接它。
```

`khy core status` 属新 CLI 命令 → 撞 `PROCESS-014` 任务面棘轮（本会话 V3 实跑：routerCommands 249/245、
aliasEntries 595/591、handlerFiles 167/155、ruleCount 101/94 全越界）。
**决策（D5）：本重构不开任何新 CLI 命令**，文案只引用既有的 `khy doctor`。
单实例验收的 finding 名是 `metering-dual-writer`（D4/D5），不是命令名；收敛完成前**不得报 single**（§10.3）。

### 4.5 `/core/health` 响应契约（唯一指纹定义，三处引用同一份）

```ts
// contracts/health.js：指纹字段 = coreId + protocolVersion + pid（三者与 locator 全等才认）
export interface CoreHealthResponse {
  status: 'ok'; coreId: string; protocolVersion: number; pid: number;
  port: number; epoch: number; coreVersion: string; uptimeMs: number;
  capabilities: Array<Pick<Capability,'id'|'state'|'version'>>;
}
```

实测全仓无 `core/health` 字符串（v1 `git grep` 零命中）→ 该端点是**新增面**，
`tokenHash` 只存在于锁文件、绝不出现在 `/core/health`（避免把凭据散进只读探针面）。

---

## 5 网关唯一出口

### 5.1 迁入 core 的代码

| 迁入 | 现状落点（实测） | 备注 |
|---|---|---|
| 网关主入口 + 方法分片 | `runtime/node/backend/src/services/gateway/aiGateway.js`（:2646 `new AIGateway()`、:2685 导出单例）、`aiGateway{Generate,Cooldown,Model,Routing}Method(s).js`（本会话实测四文件合计 **12105** 行：Generate 7034 + Cooldown 1098 + Model 1702 + Routing 2271；v1 :410 的「7034」是**单文件**读数，被误当合计） | 先工厂化再搬 |
| 适配器族 | `gateway/adapters/`（本会话实测目录 71 项 = 70 个 `.js` + 0 子目录；`CORE-LAYERS.json:506` 登记的 68 是陈旧值）、`protocolConverter/`、`tlsSidecar/` | 引用面见 §5.4 口径 |
| 计量（**只搬契约与定价叶子**） | `usageTracker.js:30-41` 的 `TOKEN_PRICING` 表并入 `tokenPricing.js` 叶子；`tokenUsageService.js` 的落盘/计量面收敛进 core（UsageStore）。**`services/usageTracker.js` 模块本体留 backend**（§6.1 ③、R20） | 按 D4：收敛先行（schema `writerId`/`coreId`、落点改解析家、三份定价副本收敛到同一叶子）；收敛前单实例验收一律报 `metering-dual-writer` |
| 熔断/路由 | `gateway/{routingMode,autoModelRouting,autoModelSelect,keySelector,gatewayErrorClassifier,gatewayConstants}`、`rateLimiter`、`sequentialQueue`、`routeLatencyStore`、`cacheEconomyStore` | `aiGatewayCooldownMethods.js:4-16` 自述 mixin 内含 timers/账户池持久化 |
| 事件 | `observability/eventBus.js`（101 行）**与 `observability/eventLog.js`（351 行）** | eventLog/eventBus **本体**迁入；7 个写者只改调用面（§6.1，CH-3） |
| 会话族 | `services/sessionPersistence.js`、`sessionSearchIndex.js`、`sessionGroupService.js`、`services/session/`、`conversationStore.js` | 全集见 §6.2 |
| 存储/配置 | `services/configGuard.js`、`apiKeyPool.js`、`utils/dataHome.js`、`constants/serviceDefaults.js` | `KHY_CORE_*` 真源已挂 `@khy/core/contracts/core-env`（CH-2）；serviceDefaults 改为消费该子路径。涉及 DATA-SSOT/DATA-LOCATIONS/白名单同批改 |
| 插件宿主 | `plugin-loader/{index.js,contextFactory.js,sdkCompat.js}` | 契约真源仍在 `@khy/plugin-sdk` |

### 5.2 留在宿主的适配（不迁）

终端 UI（TUI/`src/cli`、desktop renderer、两个 Vue 前端）；pty（`apps/khyos-desktop/src/main/ptyHost.ts`）；
桌面 KeyManager 的 masking/reveal/审计 UX（`keyManager/keyStore.ts:4-12`）；设备车道
（amoon/amoo/agentbus）；`gateway/relayPage.js:100` 内嵌浏览器模板资产（整体作模板搬运，
`refactor-001-coupling.md:309-310`）；`works/ship`、`scripts/ci`、`docs/`（仓库私有，core 不得依赖）。

### 5.3 单份保证 + 现存第二套的处置

- **core 侧单份**：熔断/冷却/`_detectCache`(60s)/`_contextWindowCache` 挂 core 的 gateway 实例；
  embedded 直通通、attached RPC 到同一实例。
- **第二套网关（实测存在，不在本刀内合并）**：`runtime/node/ai-backend/src/services/gateway/`
  整套自带 `aiGateway.js`+adapters+protocolConverter+tlsSidecar+relayPage.js（C13），
  `FEATURE-OWNERSHIP.json` capabilities[0]/[1] 已把 ai-backend 的 `aiGateway.js` 与
  `tokenUsageService.js` 登记为 **forbidden**，且 ai-backend **不在 DOMAIN-DEPS 任何 roots 内**
  → 域方向判据对它全盲。结论：B1 **不吞并** ai-backend（它是 pip wheel 捆绑的独立服务，
  G2 轨道第 1 源），但必须把它列为「网关唯一出口」的已知例外并登记（D6 的 `KNOWN-EXCEPTIONS.json` 载体，
  本会话实测 ABSENT，V8），且 §13.3-2 的入站扫描显式覆盖 `runtime/node/ai-backend`，防止第三套。
  **网关切分为可发布子集单列 B8 工程**（D1）。
- **终端直连（实测 6 处/5 文件，C8）**：`delivery/channel/khyquant/tools/{imageDetect.js:169,
  imageOcr.js:101,160,recognizeImage.js:84,videoAnalyze.js:292}`、
  `services/strategyRecommender.js:259`。它们写的 `../services/gateway/aiGateway` 在 khyquant 内
  **不存在对应文件** → 现靠 try/catch 静默降级。处置：改经 `CoreHandle.gateway`
  （attach 或 embedded），并在 §13.3-2 建立基线棘轮（只降不升）。

### 5.4 迁移期双实现：**不允许**；门面壳与真实删除条件

门面壳：S6 把 `backend/src/services/gateway/aiGateway.js` 改为
`module.exports = require('@khy/core/server').gateway`（纯 re-export，先例：`[DESIGN-LAY-005]` §2
表 :144 的 57 处），主入口引用零改动。

基数按 v1 的实测口径（C4-C7 四行）保留；**壳的删除条件**（撤回第 1 版的「站点归零 + 2 个 PATCH 批次」）：
1. 壳保留期 = **主入口引用（src 56 文件 / 75 处）仍存在的整个期间**；这些站点由壳承接，
   **不要求归零**，因为归零意味着改写 56 个第一方文件，那是独立一刀，不在 B1 范围；
2. 真正要求归零的是「gateway 目录内部子模块被外部（cli/handlers/tools/domain）直接引用」
   ——基线 59 处（C7），逐刀降；降到 0 且 §13.3 判据无 error 时，壳才可删；
3. 毕业以**样本量**计（`PROCESS-008` PP-2 口径：以站点计数为可复算样本，不用日历期限），
   不设「逾期自动回滚」的硬日期。

---

## 6 事件 / 存储 / 会话

### 6.1 跨终端事件（②③ 按 CH-3 重写）

```ts
export interface CoreEvent<T = unknown> {
  seq: number; id: string; ts: number; type: CoreEventType;
  source: 'gateway'|'session'|'storage'|'plugin'|'capability'|'core';
  traceId?: string; terminalId?: string; payload: T;
}
export type CoreEventType =
  | 'core.ready' | 'core.stopping' | 'gateway.status' | 'ai.chunk' | 'ai.result'
  | 'tool.call' | 'tool.result' | 'usage.record' | 'session.changed'
  | 'capability.changed' | 'plugin.changed' | 'event.gap';
```

- **形状与既有 eventLog 对齐**：`observability/eventLog.js:24` 已定义
  `{ ts, seq, type, source, traceId, payload }` → 契约沿用，不新造方言。
- **seq 必须改为核心级**：现状 `:34-35` 是 `let _seq = 0` 的**进程内**单调计数
  → attached 下两进程各自从 0 起，重连/幂等无处锚定。core 化后 seq 由 core 分配并持久化。
- **eventLog 必须随事件块一起迁入 core（写者唯一）**；**`coordinator/tasks/observability` 的模块本体不搬**（CH-3）：
  ① `eventBus.js` + `eventLog.js` **本体**迁入 `packages/core/src/server/events/`（唯一写者）；
  ② C9 的 7 个写点（`coordinator/processAgent.js:347`、`coordinator/taskBoard.js:323`、
  `observability/cpuProfiler.js:167`、`observability/eventLoopMonitor.js:160`、
  `observability/slowRequest.js:230`、`services/usageTracker.js:177`、
  `tasks/largeTaskRuntimeStore.js:1812` 的 snapshot）**只改调用面**：迁移期由 backend 侧 `eventLog` 门面
  `module.exports = require('@khy/core/server').eventLog` 承接（调用点零改动、禁止第二份 JSONL 写者），
  S5 事件块交付时调用点改 `coreEvents.publish()`；
  ③ 上述 7 个模块**本体留在 backend**（任务编排/任务板/观测采样的**具体模块实现**属宿主职责；
  core 的「统筹」体现为经事件与能力面协调各终端，不靠搬运这些模块——§13.1 同步收窄为点名式）。
  v1 :493-496 的「三块本体随 S5 一起搬」删除。
- **fail-soft 必须替换**：现状 `eventBus.js:43-53` 的 `publish()` 用 try/catch 吞掉
  订阅者异常且无返回值校验、`:62-83` 的 `subscribe()` 同样静默丢弃、无队列上限（仅 :31
  `setMaxListeners(500)`）。这与 §9「禁止静默」互斥。core 事件面改为：有界队列 + 逐订阅者失败计数 +
  溢出/丢弃即发 `event.gap` 并写台账，投递语义 **at-least-once + `event.id` 幂等**。
- **方言统一**：fork IPC（`host/index.ts:6-54`，约 30 型）、`khy_*`
  （`webRemoteControl/protocol.js:23-48`，9 入 11 出）、agentbus（`phase|state`）各留宿主侧薄映射
  `CoreEventBridge`，core 只认上表；不再新增第四套。
- **顺序与重连**：`subscribe({since})` + `ack(seq)`；内存环形缓冲（先例 `aiMonitor.js` MAX_TRACES=100）
  + 持久 eventLog（`assets-facts.json:26-28`）；重连 `subscribe({since:lastAck})`，缺口由 `replay()`
  补，补不到即 `CORE_EVENT_GAP` + 全量 resync。

### 6.2 sessions.db / conversations 的单写者（清单补全）

单写者 = core。**触及 `sessions.db` 的实测清单**（C10）：

| 触库方 | 位置 | 处置 |
|---|---|---|
| 会话主副本（JSONL/JSON，**不开库**，C10） | `services/sessionPersistence.js`（:6-8 原子写） | 迁入 core/server/session |
| FTS5 索引 | `services/sessionSearchIndex.js`（:4-11 自述 JSON 才是主副本；:66-69 设 WAL；:56-63 驱动缺失即**静默关闭**） | 迁入 core；静默关闭改判 `session.search = degraded` |
| 分组真源 | `services/sessionGroupService.js:4-10`（自述分组只存 sessions.db）、`:28` 共用索引句柄 | 迁入 core，暴露 `session.groups/setGroup` |
| 健康自愈 | `services/dbHealthService.js:217-218,254-255`（按路径检查并自动恢复 sessions.db）、`:229` `path.join(process.cwd(),'khy-Trajectory','sessions.db')` | 迁入 core；`:229` 是**第 6 条路径链**（cwd 拼接），改走 `getProjectDataPath` |
| 备份还原 | `services/domain/backup/backup/restoreService.js:22,311,477,487` + `sqliteHotCopy.js:17`（就地换库 + 清 WAL + 重建 FTS） | **与 core 持锁句柄互斥**：还原前必须由 core 主动释放锁（`close()`）、还原期间拒绝新 attach，完成后重发 `core.ready`；不做这件事就会与 §4.2 的锁打架 |
| 备份清单 | `.../backupAssetPlan.js:13-15,314`（sessions.db 不备份，可由 JSON 全量重建） | 不变，登记进 DATA-SSOT |

并发写风险：`sessionSearchIndex.js:23-41` 实际是 `_dbPath()`——
`require('../utils/dataHome')` 失败即回退 `path.join(os.homedir(), '.khyquant')`，属 §6.3 的解析链
问题；WAL 设置在 `:66-69`。跨进程共享同一库的实测依据是
`dual-facts.json:105-108`（daemon 与桌面 host 两个进程族都经 `getProjectDataPath('sessions.db')`）。

### 6.3 路径真源（六条，v1 实测保留）

| # | 链 | 位置 | 处置 |
|---|---|---|---|
| 1 | 用户级 `getDataHome()` 五级链 | `dataHome.js:1-13` | 留 core，成为唯一解析器 |
| 2 | 项目级 `getProjectDataHome()` 默认 `<appRoot>/works/data/khy` | `dataHome.js:504-518` | 同上 |
| 3 | legacy `getLegacyDataHome()` = `~/.khyquant` | `dataHome.js:11-13` | 只读兼容，不再新增写入 |
| 4 | 桌面 KeyManager 手工镜像 | `apps/khyos-desktop/src/main/keyManager/keyStore.ts:40-99`（自承「mirrors utils/dataHome.js」） | 删除该解析，改由 `CorePaths`（§3.1 `paths`）下发 |
| 5 | 计量落盘直写 homedir | `tokenUsageService.js:27`（实测不 require dataHome，C11） | 按 D4：改解析家 + 加 `writerId`/`coreId`，保留 legacy 双读；同批登记 DATA-LOCATIONS/DATA-SSOT |
| 6 | `sessions.db` 索引路径回退 homedir | `sessionSearchIndex.js:31-40` | 失败不再静默回退，改为 `session.search = degraded` + 原因 |

登记：`core.lock` / `locator.json` / 事件日志 **必须**同批进 `DATA-LOCATIONS.json`（T0–T4 档位，
`LAYOUT-007`）与 `DATA-SSOT.json`（`LAYOUT-008`，守卫 `npm run check:ssot-data`，V5 本会话 exit 0）。

---

## 7 插件

- **位置**：`packages/core/src/server/plugins/`（由 `backend/src/plugin-loader/*` 迁入）；
  契约真源仍是 `@khy/plugin-sdk`（`plugin-sdk/index.js:4-24`；规范 `[DESIGN-ARCH-116]`），**不复制**。
- **激活时机**：六源优先级与 eager/lazy 边界不变（`plugin-sdk/index.js:90-97`；`ext:builtin` 唯一惰性源，
  门控 `KHY_PLUGIN_LAZY_LOAD`）。新增：**attached 终端不触发激活**，只订阅 `plugin.changed`。
- **权限边界**：`PERMISSIONS ['network','fs','shell','http']`（`:107`）由 `contextFactory`
  （`plugin-loader/contextFactory.js:38-90`）在 core 内继续强制；再加两条：
  ① 插件只能用 `ctx.ai`，不得自持 provider 密钥（`[DESIGN-ARCH-069] §1.1` 网关判据，:43-53）；
  ② 插件只拿 `DataRef`，拿不到绝对路径。
- **跨终端「一次启用全局生效」**：`plugins.enable/disable` → `plugin.changed{namespace,state,coreId,epoch}`；
  终端收到即挂/卸入口；漏收的靠重连 `replay()` 补齐；**判定标准是 `plugins.status(ns)` 终态查询**，
  事件只是失效通知（至少一次 + 幂等键）。

---

## 8 零宿主假设：blockers 逐条抽象（#1/#2 按 CH-1/CH-4 重写）

来源 `dual-facts.json:79-139`；接口落 `packages/core/src/{contracts,client,locator-host,server}`。

| # | 耦合点 | 抽象（接口 / 落点） | 判据 |
|---|---|---|---|
| 1 | host 按仓库相对路径 require 后端（`apps/khyos-desktop/src/host/index.ts:70-74,126-132`；安装包 `build.files` 只有 `out/**`、`resources/**`，`dual-facts.json:81-83`）。档 2 装机态**没有** `node_modules/@khy/core`（发行包 files 实测 = `bin/`+`bundled/`+两脚本，V9） | `CoreLocator` 接口留 `./client/locator.js`（零 `node:`）；Node-only 定位器 = `./locator-host`（`src/locator-host.js`）。**定位顺序（首个命中即停）**：① 显式注入（`bundledEntry` / `resolveEmbedded({entry})`）→ ② 宿主传入的 bundled 入口（档 2：works/ship 的 `bundled/` 面或 pip wheel 内既有路径）→ ③ `node_modules/@khy/core` → ④ 诚实报错 `CORE_LOCATOR_FAILED`。**不新增构建产物**（不改 BUILD-OUTPUTS、不新增 `entries/<producer>`） | 无工作树 + 注入 bundled 入口下 embedded 可起；三者全无时诚实报错（§9 文案），不扫仓库路径 |
| 2 | `resolveBackendSrc()` 缺文件即 throw（`remote/index.ts:46-57`） | 同 `locator-host`（`obtainCoreNode`）；webRemote 转为 core 的 attached 消费者 | 删除 `KHY_OS_DIR` 后 attached 可用 |
| 3 | 网关导出进程级单例（`aiGateway.js:2646,2685`） | `createGateway(options)` 工厂 + `CoreGateway`（`./server/gateway`） | 同进程两实例熔断互不影响 |
| 4 | 浏览器不可内嵌（1478 模块 / 523360 行，`dual-facts.json:95-98`） | **不重写**：web 只 attach（`client` 走显式 endpoint + `fetch` 探活，§4.0） | web 产物无 `node:` 导入 |
| 5 | `api_keys.json` 双写者（`apiKeyPool.js:30-43` vs `keyStore.ts:4-8`） | `CoreCredentials`（`./server/credentials`）：core 唯一写者；桌面留 masking/审计 | 双终端并发保存不整档覆盖 |
| 6 | `sessions.db`/JSONL 跨进程写（`dual-facts.json:105-108`） | `CoreSession` 单写者 + §6.2 全清单 | 双进程 append 后链完整 |
| 7 | 六条数据家解析链（§6.3） | `CorePaths`（`./contracts/paths.js`）：`hello` 下发；客户端不解析 | 客户端 0 处 `os.homedir()`/`.khyquant` |
| 8 | 桌面 IPC 通道表是空对象（`src/shared/rpc/channels.ts:1-4`） | `CoreChannel`（`./contracts/channels.js`）；host/preload/main 全量 import | 通道名无裸字面量（测试断言） |
| 9 | 端口顺延 + locator 双写覆盖（`aiManagementServer.js:3538-3573`、`daemonEntry.js:65-83`） | `CoreLifecycle`（`./server/lifecycle`）：locator 写入持锁 + epoch 比对；删除 legacy 双写 | 第 2 实例拿 `CORE_LOCKED`，locator 仍指第 1 个 |
| 10 | 契约门吃硬编码 fixture（`validate-protocol-contracts.js:13-15`）、json-schemas 空转（`validate-json-schemas.js:22-38`） | zod 为真源 + 真实帧测试；补 `COMMS-001` 的 `exec.findings`（实测 0 项） | 改字段不改 fixture 必须翻红 |
| 11 | agentbus 是设备车道（`agentbusProtocol.ts:11-16`） | 不复用；只借分帧规则；core 传输 = HTTP/WS | 协议面不出现 `KHY_AGENTBUS_*` |
| 12 | Electron 主/渲染/host 多进程（`dual-facts.json:153-163`） | `obtainCoreNode` 锁仲裁 + §4.2 fencing（client 侧 `obtainCore` 只 attach） | §10.3 三证 |

---

## 9 失败与降级（v2 增补 `CORE_LOCATOR_FAILED` 行）

| 情形 | 行为 | 用户可见文本（RUNTIME-002 模板） |
|---|---|---|
| required 能力缺失（启动期） | 拒绝启动，列出**全部**缺失 id | `缺少必需能力 gateway (CAPABILITY_UNAVAILABLE)：核心未加载 AI 网关，请运行 khy doctor 检查通道配置` |
| optional 能力缺失 | 句柄可用；`capabilities.get()` 回 `missing`+原因；终端**注销入口** | `会话搜索不可用 (CAPABILITY_UNAVAILABLE)：FTS5 驱动缺失，已隐藏搜索入口；会话列表不受影响` |
| attached 核心不可达 | `CORE_UNAVAILABLE`；**禁止自动起 embedded**（唯一例外显式 `allowSpawn:true`）；在途调用 `retryable:true` | `核心不可达 (CORE_UNAVAILABLE)：端点 http://127.0.0.1:9090 无响应（第 3/3 次重试，超时 2s），请确认核心已启动或运行 khy doctor 查看` |
| **embedded 实现定位失败**（CH-4） | `CORE_LOCATOR_FAILED`；**不扫描仓库相对路径、不猜路径、不 spawn** | `核心定位失败 (CORE_LOCATOR_FAILED)：未显式注入入口、宿主未传 bundled 入口、node_modules 内也没有 @khy/core——请安装 @khy/core 或由宿主传入发行包内的入口路径` |
| 指纹不符 | `CORE_PROTOCOL_MISMATCH`，**不落入 embedded**（§4.1 第 4 步） | `核心协议不匹配 (CORE_PROTOCOL_MISMATCH)：locator 记 protocol 1 / 端口上的服务回 protocol 2，请核对 KHY_CORE_ENDPOINT 是否指向别的进程` |
| 被接管（旧 core 复活） | 旧 core 自检 `lock.epoch > self.epoch` → 停止写 locator/计量，降级 attach，抛 `CORE_TAKEN_OVER` | `本进程已被新核心接管 (CORE_TAKEN_OVER)：epoch 3→4，已停止写入并转为连接新核心（PID 5678）` |
| 事件缺口 | `replay()` 补；补不到即 `CORE_EVENT_GAP` + 全量 resync | `事件缺口 (CORE_EVENT_GAP)：游标 1234 之前的历史已轮转，正在重同步会话与插件状态` |
| 搜索索引 init 失败 | 显式 degraded（现状 `sessionSearchIndex.js:56-63` 静默关闭） | 同 optional 行 |
| 第二个 core | `CORE_LOCKED`（§4.4） | 见 §4.4 |

禁止项：核心不可达时偷偷起第二个 core；stale 判定后不比对 epoch 就覆盖锁；能力缺失时返回空数据冒充成功；
订阅者异常被 try/catch 吞掉而不计数；定位失败时回退仓库相对路径。

---

## 10 验收

### 10.1 布局约束（entry-buffer 的 colocated 判据，C2）

每个 `.js/.cjs/.mjs` 源文件**必须**在同目录有 `<base>.test.js`；
`packages/core/test/` 仍保留**跨进程** E2E（它们不是「源文件的同名测试」，不用于满足 entry-buffer）。

### 10.2 embedded

`node --test packages/core/test/embedded.contract.test.js`：进程内 `obtainCoreNode({mode:'embedded',
allowSpawn:true, terminalId:'test'})`（embedded 入口在 `./locator-host`；`obtainCore()` 只 attach）；fake adapter 跑 generate/stream/abort；
session `create → append(clientMsgId) → 重复 append(deduped) → messages → setGroup`；
events `subscribe → publish → ack → replay(since)` 单调；`plugin.changed` 触发入口增删。
前置：fake adapter 注入不得改 18 个真适配器的探活集合（`CORE-LAYERS.json:455-461` 实测结论）。

**v2 新增测试面（CH-1 / CH-2 / CH-4 的机判）**

| 测试 | 断言 |
|---|---|
| `packages/core/test/locator-order.test.js` | `obtainCoreNode` 的四段定位顺序各一条：显式注入优先且失败即报（不静默回退）；注入缺省时 bundled 入口命中；再缺省时 `node_modules/@khy/core` 命中；全无 → `CORE_LOCATOR_FAILED`。沙箱在临时目录构造，**无工作树相对路径可用** |
| `packages/core/test/locator-host.test.js` | Node 下 `require('@khy/core/locator-host')` 成功；`readLocatorFile` / `resolveEmbedded` / `obtainCoreNode` 可调用；该文件**至少 require 一个 `node:` 内置**（防止退化成空壳） |
| `packages/core/test/browser-safety.test.js` | 遍历 `src/contracts/**` + `src/client/**`：0 处 `node:`；0 处未守卫 `process.env.`；`src/client/**` 内 0 处 `locator-host` 字面量 |
| `packages/core/test/core-env.test.js` | 无 `process` 时 `readCoreEnv()` 返回 `{}` 且不抛；有 `process` 时按注入 env 读取；require 前后 env 快照不变（import 期零副作用） |
| conformance：`require.resolve('zod')` 自包根 | packages/core 包根可解析（D9；本会话 V11 实测今日五处 NOT RESOLVABLE） |

### 10.3 attached（含两条硬前置）

`node --test packages/core/test/attached.e2e.test.js`：子进程起 core server（临时数据家 + 临时端口；
起进程用 `obtainCoreNode({mode:'embedded'})`）；第二进程 `obtainCoreNode({mode:'attached', endpoint})`
（Node 侧；纯浏览器场景对应 `obtainCore({endpoint, terminalId, clientVersion})`）；断言与 §10.2 **同一套**（复用
`packages/core/conformance`）；kill 子进程 → `CORE_UNAVAILABLE` 且锁/端口/进程数不变；
重启 → `subscribe({since:lastAck})` 收到断线期间事件。

**三证（计量证按 D4 改写）**

| 证 | 断言 | 前置改动（列入 S5） |
|---|---|---|
| 锁 | `core.lock` 存在、`pid` 存活、`heartbeatAt` 新鲜、`epoch` 单调 | §4.2 |
| 端口 | `GET /core/health` 的 `coreId`+`protocolVersion`+`pid` 与 locator **逐字段一致**（§4.5） | §4.5 新端点 |
| 计量 | 计量文件新增记录的 `writerId` 只有一个来源且等于锁值；**收敛完成前本证一律报 `metering-dual-writer`，不得报 `single`** | D4：① schema 加 `writerId`/`coreId`（现状落盘顶层只有 `daily`/`monthlyTotals`，decisions-v2 实测）；② 两份活跃写者（backend / ai-backend 的 `tokenUsageService.js`）+ 一份休眠写者（`delivery/channel/khyquant/services/tokenUsageService.js`）收敛；③ 三份定价副本（`ai-backend:18-30`、`usageTracker.js:30-41`、`khyquant:18-31`）并入 `tokenPricing.js` 叶子；④ `usageTracker.record` 入参加 `coreId`（C12 实测现无该字段）；⑤ `tokenUsageService.js:27` 的 homedir 直写改为解析家（C11） |

负例：第二次 `obtainCoreNode({allowSpawn:true})` → `CORE_LOCKED`，不产生第二个锁/端口/计量来源。

### 10.4 门（**不写「全绿」**，写「不新增 error 且读数 ≤ 当前实测」）

| 门（命令） | 当前实测 | 通过口径 |
|---|---|---|
| `node scripts/ci/check-repo-layout.js --json` | v1 C1 有 error 4 类（root-whitelist 11 / root-shadow-dir 2 / root-junk 52 / layer-registry 6）；本会话 V2 的完整档探针复算 `entry-buffer=2416`、`domain-direction=199`、`functional-unit=277`（我未直接运行该 JSON，读数来自探针） | 不新增 error；**entry-buffer 保持 2416**（合规三件套齐全即不升）；domain-direction/cross-layer-require 不得 +1（零余量，新增即 error） |
| `node scripts/ci/check-core-layers.js --json` | **本会话 V1 实跑 exit≠0**：11 ❌（含 `core-budget-lines` toolUseLoopCore 30629>30175、aiGateway 71833>71078；`visual-lazy-regression` 1 条）+ `inversion-lazy` 2 warning | 不新增 error 条目；既有超标**不由本刀负责**，但本刀不得使其变大。**新守卫不寄生于它**（D3；V2 已报 core-layers-guard authority-drift） |
| `node scripts/ci/check-core-boundary.js --json` | **ABSENT**（V7，本重构新增物） | 0 error（S1 恒 exit 0）；`counts` 键名与 §13.5 契约逐字一致；`--changed` 可运行 |
| `npm run check:version-sync` | 本会话 V4 **exit 0** | 本批不改 10 源（D1）→ 维持 exit 0；不得新增第 11 源 |
| `npm run check:delivery` | 本会话 V3：`stage=S1`、PASS 7 / GAP 5、四项棘轮越界（249/245、595/591、167/155、101/94）、finding `delivery-surface-ratchet-breach`（warning） | 不新增 CLI 命令/别名/handler/规则（D5/D3） |
| `npm run check:ssot-data` | 本会话 V5 **exit 0** | 新增 `core.lock`/`locator.json`/事件日志已登记，无影子副本 |
| `node scripts/ci/check-rollout-stage.js` | 本会话 V2 **0 error / 44 warning**（含 core-layers-guard authority-drift） | 三条新机制条目不得新增 error；其 `samples.source.key` 必须可复算为标量（§13.5） |

### 10.5 协议契约

CoreHandle 的 `hello/health/events/abort` 真实帧进 `scripts/ci/validate-protocol-contracts.js`
FIXTURES（`COMMS-001` 的 `exec.findings` 实测 0 项 → 本批补名并 `npm run docs:rules-cards` 重生成规则卡）。

---

## 11 与方案原文的冲突（逐条，v2 未改）

| # | 方案假设 | 实测 | 结论 |
|---|---|---|---|
| 1 | `services/backend` 承载后端 | `runtime/node/backend`（LAYERS :114；`DOMAIN-DEPS.json:53-60`） | 旧名 |
| 2 | 顶层 `packages/` | 从未存在（`layout-facts.json:124-126`；`assets-facts.json:154`） | 不建 |
| 3 | `kernel/platform/software/tools/extensions` | 已方案 P 物理化（`layout-facts.json:163-186`） | 禁止重建 |
| 4 | `apps/{cli,ai-frontend,electron,flutter-android,provider-hub}` | `apps/` 只有 khyos-desktop（`assets-facts.json:153`）；`apps/electron` 判 illegal（`layout-facts.json:148-150`） | 五条全落空 |
| 5 | composer 是包 | 只有 UI 组件目录（`layout-facts.json:128-130`） | 不建 |
| 6 | suite 是新板块 | 全仓无该概念（`assets-facts.json:85-89`）；`apps/suite` = needs-registry-change（`layout-facts.json:160-162`） | 落点按 D8（方案 α），须人批准 |
| 7 | 每端 `khy.terminal.json` | 全仓 0 个；端矩阵真源 `entries/entries.json:9-15` | 按 D2：清单为编写真源、投影为生成物 |
| 8 | 「任务管理器只有一个核心进程」 | Electron main + fork host + daemon + aiManagementServer 可并存（`dual-facts.json:153-177`） | 改为**锁 + epoch** 不变式（§4.2） |
| 9 | web 可内嵌 core | 不可行（`dual-facts.json:95-98,155-159`） | web 只 attach |
| 10 | 契约已有守卫 | fixture 门 + 空转的 json-schemas（`dual-facts.json:121-128`） | 补真实帧 |
| 11 | 单例即可 | 单例无法隔离两实例（:91-93） | 工厂化前置 |
| 12 | 网关只有一套 | ai-backend 自带整套（C13）+ khyquant 6 处指向不存在文件的直连（C8） | 例外登记 + 入站棘轮（§13.3-2） |

---

## 12 迁移顺序（每步可独立回滚）

> A2/A3/A5 编号取自方案原文；**v1 与本会话均未读到原文**，按 `refactor-001-coupling.md:250-270`
> 出现的 A1 先例类推为「core 抽取 / 终端独立态 / 组合装配」三线；若编号语义不符以本节内容为准。

| 步 | 内容 | 回滚 | 验收 |
|---|---|---|---|
| **S1 契约先行**（A2 前置） | 建 `packages/core`：只 `contracts`+`client`+`locator-host`+`server` 骨架，**并交齐 §1.1 合规三件套**（1 份 `khy.module.json` + 1 份 README + 每 `.js` 同目录测试）；登记件按 §1.3 表执行（workspace 两处、WORKSPACE_ROOTS 三缺口、core importer、**backend 依赖声明 + override**、**desktop 的 file: 声明**、FEATURE-OWNERSHIP 机制条目（按 §13.5 映射）、API-SURFACE 13 码、DATA-LOCATIONS/DATA-SSOT、`check:core-boundary` 别名 + pr-gate、check-agent-rules 白名单） | 删包 + 还原上述登记件（纯新增，无行为变更） | entry-buffer **仍为 2416**（本会话探针读数，施工当天重测）；`check:layout` 不新增 error；`check:version-sync` 仍 exit 0（10 源不动）；`check-core-boundary --json` 0 error |
| **S2 网关工厂化** | `createGateway(options)`；`module.exports` 仍是实例（src 75 处 / 56 文件零改，C4） | 还原 `aiGateway.js` | 网关既有套件不新增失败；V1 读数不变大 |
| **S3 句柄最小闭环（embedded，desktop host）** | `obtainCoreNode({mode:'embedded'})`（`./locator-host`；`obtainCore()` 只 attach）；`host/index.ts:124-132` 改调句柄（实现入口按 §8#1 四段定位） | 还原 host 一处 | §10.2 |
| **S3b CLI 接入** | CLI 走 **attach 到 daemon core**：接入点放 `src/cli/repl/startup.js` 或 handler 的**懒加载边**内，`bin/khy.js` 的顶层 require 预算 6/999 与 L0 预算 9/3757 **零余量**（`CORE-LAYERS.json:101-137`，v1 实测=baseline），故 CLI **不得**在入口顶层 require `@khy/core` | 还原 handler | `check-core-layers` 的 entryBudget/L0 读数不变；§13.3-3 的闭包判据通过 |
| **S4 core server + 锁 + fencing + locator + hello/health** | `./server` 起 HTTP/WS；锁与 epoch；`/core/hello`、`/core/health`（§4.5）；`daemonManager` 的 pid 判断升级为锁判断（`daemonManager.js:108-112`） | 开关 `KHY_CORE_SERVER=0`（默认 0）退回 S3；锁文件改名隔离 | §10.3 三证 + 双实例负例 |
| **S5 逐块服务迁移（一块一 PR，一块一 revert）** | 顺序：①事件（**eventBus+eventLog 本体迁入**；C9 的 7 个写者**只改调用面**、本体留 backend，§6.1）→ ②会话（含 §6.2 全清单与还原互斥）→ ③存储/配置（含 `writerId`/`coreId` 与六条解析链归一，§6.3/D4）→ ④插件 → ⑤网关 | 每块还原壳与迁入件 | 每块既有测试 + §10 全套；棘轮只降 |
| **S6 收口** | 按 §5.4 条件删壳（子模块直引基线 59 处降 0，C7）；`dataHome/serviceDefaults` 真源迁移与 `check-agent-rules` 白名单同批（**需人批准**） | 壳删前每步可逆 | 站点计数 = 0；`check:ssot-data` 不新增 |
| **S7 生态化**（A3 独立态 / A5 装配） | **两个包一起发布（D1 通道 (a)）**：`@khy/core` + `@khy/plugin-sdk`；plugin-sdk 补 `files`/`exports`/`publishConfig` 并与 core 同批 npm 发布（对齐档 1）；档 2 由发行包 `bundled/` 承担同一实现；suite 只装配；网关切分单列 B8 | 发布链回退到不含 core/plugin-sdk 的清单 | §14.5 全新克隆 E2E（档 1 + 档 2 两个测试） |

纪律：不跨目录合并提交；不删文件（`RUNTIME-009` 要 `scrub-plan.md`+可执行 `rollback.txt`）；
提交信息无 AI 署名（`PROCESS-010`）。

---

## 13 核心职责边界与机判

### 13.1 core 负责 / 不做（**收窄为点名式**，CH-3 的机判基准）

负责（= 产品意图 1 的七项 + 三件基础设施）：能力注册与发现、事件、配置、会话与计量、AI 网关、插件生命周期、
锁与 epoch、路径解析。**「统筹」在 core 的形态 = 经事件与能力面协调各终端**，不靠承载任务板实现。
不做：终端 UI（TUI/renderer/Vue）、终端专属业务（pty、KeyManager reveal UX、设备车道 amoon/amoo/agentbus、
khyquant 交易业务）、**任务编排与任务板的模块本体（`coordinator/processAgent.js`、`coordinator/taskBoard.js`、
`tasks/largeTaskRuntimeStore.js`）与观测采样的模块本体（`observability/{cpuProfiler,eventLoopMonitor,slowRequest}.js`）**、
仓库私有件（`works/`、`scripts/`、`docs/`、`entries/` 数据）。
**例外（不属「不做」）**：`observability/eventBus.js` 与 `eventLog.js` 按 §6.1 迁入 core——它们是事件面本体，
不是观测采样；§13.3-4 的黑名单只点名四个具体模块，不含这两个文件。

> v2 的措辞收窄为**点名式**：与 §6.1 的 7 个写者处置逐条对得上（CH-3），也不与产品意图 1「core 负责统筹」相抵
> ——「统筹」落在事件/能力协调，不落在承接任务板与采样模块。

### 13.3 机判（四条判据 + 机判子档；执行器 = 新增独立守卫 `scripts/ci/check-core-boundary.js`）

> **v1 §13.3 的「新增 finding 进 check-repo-layout.js、挂 LAYOUT-001」整体作废**（D3）：
> 不寄生 `check-core-layers.js`（V1 exit≠0；V2 报 authority-drift），也不寄生 `check-repo-layout.js`。
> 执行器形态固定：`const GUARD_STAGE = 'S1'`、**S1 恒 exit 0**、支持 `--changed`/`--json`、
> finding 一律 `severity:'warning'`、不进 `LAYOUT-001.exec.args` 的 `--promote` 名单、**不新增规则 ID**
> （ruleCount 101/94 已越界，V3）。毕业（S3）才新增 `LAYOUT-009`，且先退役/合并一条既有规则。

| # | 判据（finding id） | 覆盖什么 | 判据细节 |
|---|---|---|---|
| 1 | `core-boundary-import` | core 的**出站**依赖 | `packages/core/**` 内出现对 `runtime/node/backend`、`apps/`、`delivery/`、`works/`、`scripts/`、`docs/` 的引用（**三形态都匹配**：`require(['"].`、`import … from ['"]`、裸 `@khy/` 包名）；迁移期例外白名单只允许经 `@khy/core/contracts/core-env` 的 backend 消费面 |
| 2 | `terminal-direct-gateway-import` | 终端**入站**绕过与第三套网关 | `apps/**`、`delivery/**`、`runtime/node/ai-backend/**` 内出现对 `services/gateway/aiGateway`（相对或包名）的引用 → 基线棘轮，初始基线 = 实测 6 处（C8），只降不升 |
| 3 | `core-not-in-entry-closure` | L0/L1 预算的零余量 | `bin/khy.js` 与三个 L1 根的闭包内**不得**出现 `packages/core/**`（含经 `@khy/core` 的裸包名边）；守卫内直接复用 `scripts/lib/requireGraph.js`（本会话与 V6/V7/V8 同一命令实测 `REQUIROGRAPH=EXISTS`），不再挂 `check-core-layers.js` |
| 4 | `core-skin-into-server` | 终端业务反向塞进 core + 职责漂移 | `packages/core/src/**` 内出现 `node-pty`、`ink`、`readline`、`@khy/ui-shared`、`*Page.js` 模板资产、`document.`/`window.` 宿主 API；**并**出现 `coordinator/`、`tasks/largeTaskRuntimeStore`、`observability/{cpuProfiler,eventLoopMonitor,slowRequest}` 的模块路径或同名文件（CH-3 机判） |
| 子档 A | `core-client-node-free` | CH-1 | `src/contracts/**` + `src/client/**` 0 处 `node:` 内置、0 处未守卫 `process.env.`；`src/locator-host.js` 是**唯一**允许 `node:` 的源文件且必须至少 require 一个（非空壳）；`src/client/**`、`src/contracts/**` 内不得出现 `locator-host` 字面量 |
| 子档 B | `core-env-single-source` | CH-2 | `KHY_CORE_*` 的键名/默认值只出现在 `packages/core/src/contracts/core-env.js`；其它 `packages/core/src/**` 文件出现字面量 → warning；backend 内出现上跳 core 的相对路径（`../*substrate/platform/packages/core*`）→ warning |
| 子档 T6 | `net-exception-expired` | D6 | 读 `docs/10_规范/registry/KNOWN-EXCEPTIONS.json`（V8 实测 ABSENT）：命中条目的 `target` 放行，`expiry` 已过打印 warning；**例外表与消费者未同批落地前 T6 不判绿** |
| 子档 metering | `metering-dual-writer` | D4/D5 | 单实例验收的计量证：收敛完成（两份活跃写者 + 一份休眠写者 + 三份定价副本 + schema `writerId`/`coreId`）之前一律报本 finding，**不得报 single**；本子档不新建 CLI 命令（D5） |
| 子档 C | `terminal-cross-reference` | 产品意图 5 | 终端之间不直接引用、不点对点通信，只经 CoreHandle：`apps/**`、`delivery/**` 内出现**跨终端引用**（另一端的源码目录、其 workspace 包名如 `quant-trading-frontend` / `khy-ai-frontend`、或另一端的构建产物路径）→ warning 棘轮（基线 = S1 首跑实测值，只降不升）；白名单 = `@khy/core/*`、终端自身源码与自身产物。**边界**：本子档只判**静态引用**；「不点对点通信」由 §10.2 的契约测试兜底（终端入口只持有 `CoreHandle` 句柄） |

> D3 点名的「两个子档」= 子档 T6 + 子档 metering；子档 A/B/C 是评审项 1/2 与产品意图 5 的机判落点，
> 同属这一个执行器（不另立脚本），与 D3「全进新增 `check-core-boundary.js`」同向。

`d3-purity`/`domain-direction` 继续作为**相对 require** 的兜底（`:1617` 只认相对 require，V15），
但 ESM/裸包名失明面已由 1/2/4 的三形态匹配补齐。

### 13.4 core 内容黑名单的判据口径

「core 不承载终端业务」不再只是文档约定：判据 = 4 号 finding 的符号黑名单 + `contracts` 的
零依赖（由 `core-boundary-import` 与子档 B 共同判，**不再依赖 D3 域机制**）+ 导出面只暴露六成员
（§2.2 exports 封闭）；三者任一被破即 warning（S1 只记录）。

### 13.5 机制登记与样本读数契约（v2 新增，关闭评审项 5/6）

**FEATURE-OWNERSHIP 条目（按执行器分登，不共用一个 `--json`）**

公共字段：

| 字段 | 值 |
|---|---|
| `stage` / `previousStage` | `'S1'` / `null` |
| `rules` | `[]`（空数组；PP-3 复算 gateStrength 时无从派生 blocking，`check-rollout-stage.js:441-459` 的读取契约见 rules-facts.json） |
| `rollback` | 非空（删脚本 + 摘别名/步骤 + 删本条机制条目） |

各机制的执行器与 `samples.source`（**一一对应，不许交叉**）：

| 机制 | `executorStage.file` / `constant` | `samples.source` |
|---|---|---|
| `core-boundary-guard` | `scripts/ci/check-core-boundary.js` / `GUARD_STAGE`（脚本内必须有字面 `const GUARD_STAGE = 'S1'`，否则 V2 同款的 `rollout-stage-authority-drift` 会复现） | `{ "script": "scripts/ci/check-core-boundary.js", "args": ["--json"], "key": "counts.checks-run" }`（样本键 = 单次运行断言数；违规读数键见下方 counts 契约） |
| `terminal-manifest-guard` | `scripts/ci/check-manifests.js` / 脚本内自报阶段常量（D2 的 S1 执行器） | `{ "script": "scripts/ci/check-manifests.js", "args": ["--json"], "key": "counts.checks-run" }` —— 键名已由 `[DESIGN-ARCH-221]` §5.2/§5.3 钉死为断言计数 `checks-run`；在该脚本 `--json` 落地前**不登记 `samples.source`**（自填 observed 只触发 `rollout-stage-samples-declared-only`，S1 可接受） |
| `suite-assembly-guard` | 随 Suite 稿（222）落地时定 | 同左——**执行器与 `counts` 键未定前不登记该机制条目**（不登记即不判，不编造 key） |

**`key` 必须是标量（评审项 5 的硬判据）**

- `check-rollout-stage.js:157-169` 的 `pickKey` 在 **:165-167** 对 `typeof cur === 'object'` 返回
  「`${key} 不是标量读数`」→ `key:"findings"`（数组）在完整档必报 `rollout-stage-samples-unverified`。
- 合法先例（本会话 V13 实测）：`domain-direction-guard` / `functional-unit-guard` / `entry-buffer-guard`
  的 `key` 全为 `counts.*`，`rules` 全为 `[]`。
- `--json` 契约（写入脚本头注，键名**全列**，值恒为数值，0 也输出）：

```jsonc
{
  "stage": "S1",
  "findings": [{ "id": "...", "severity": "warning", "file": "...", "line": 0, "message": "..." }],
  "counts": {
    "core-boundary-import": 0,
    "terminal-direct-gateway-import": 6,
    "core-not-in-entry-closure": 0,
    "core-skin-into-server": 0,
    "core-client-node-free": 0,
    "core-env-single-source": 0,
    "terminal-cross-reference": 0,
    "metering-dual-writer": 1,
    "net-exception-expired": 0,
    "checks-run": 0
  }
}
```

- 每出现一个新的 finding id，`counts` 必须同步加键（`--json` 契约与 FEATURE-OWNERSHIP 的 `key` 一一对应）。
- `counts.checks-run` = 本次运行实际执行的断言数（健康态恒为正、随覆盖面增长），机制 `samples.source.key` 一律指它；finding 计数键保留为**违规读数**，不作样本键——`check-rollout-stage.js:429-438` 升阶按**实测值**判 ≥200，健康态恒 0 的键机械上必报 `rollout-stage-samples-insufficient`（见 `[DESIGN-ARCH-219]` §11.3 末条）。
- 毕业路径：S3 才新增 `LAYOUT-009` 并先退役/合并一条既有规则（`PROCESS-008` PP-6 一次只升一阶）。

---

## 14 生态交付

### 14.1 公开导出面

`@khy/core` 的 `.`/`contracts`/`contracts/core-env`/`client`/`locator-host`/`server`（§2.2，含 `types` 条件）；
`@khy/plugin-sdk` 维持现状（141 行、零依赖、无 scripts），S7 补发布面字段（§14.2）。

### 14.2 发布前置（D1 通道 (a) + CH-4 不新增构建产物）

- 实测（V9）：`works/ship/npm/package.json` 的 `files` 只有 `bin/`、`bundled/`、两个 install/compress 脚本，
  **无 `dependencies` 键**；`works/ship/modules/modules.json` 全文不含 `plugin-sdk`（C14）
  → **`@khy/plugin-sdk` 目前根本不是可安装产物**。
- 决策（D1 通道 (a)）：S7 同批把两个包各自排出发布面 ——
  ① `@khy/core`：以**包根源码**直接 npm publish（无编译产物；`files` 里不得出现 `dist/`；
  **不新增 BUILD-OUTPUTS 条目**，否则违反 LAYOUT-005 与 CH-4）；
  ② `@khy/plugin-sdk`：补 `files`/`exports`/`publishConfig`，与 core 同批 npm 发布（对齐档 1）；
  ③ 档 2 的 embedded 全量由发行包 `bundled/`（npm 侧）+ pip wheel（Python 侧）承担，**不承诺源码级轻包**；
  网关切分为可发布子集单列 **B8** 工程。
- `@khy/shared` 保持 `private:true`，因此 **core 不得依赖 `@khy/shared`**（它带 sequelize/pg/winston 且未发布）
  → core 运行时依赖只有 `zod`，且按 D9 精确锁版（V11：今日五处 NOT RESOLVABLE，合入前须在有 pnpm 的机器再生 lockfile）。

### 14.3 最小第三方终端（三步）

① `npm i @khy/core`；② 浏览器/纯远端终端：`const core = await obtainCore({ endpoint, token, terminalId,
clientVersion })`（`./client`，只 attach）；Node 宿主需 auto/embedded：`obtainCoreNode({ mode:'auto'|'embedded',
endpoint?, allowSpawn?, bundledEntry? })`（`./locator-host`）；③ 所有 AI/会话/事件/插件只经六成员。
仓外终端**无需任何仓内登记**；成为本仓端时按 D2 改为「写本端 `khy.terminal.json` + 重跑生成器」
（投影 `entries/entries.json` 由生成器产生，不手改）。

### 14.4 最小第三方插件（三步）

`defineKhyPlugin`（`plugin-sdk/index.js:124-131`）→ manifest 四必填（`:37-42`）→
放 `<dataHome>/plugins/<name>/`（发现源 `dir`，`:95` 与 `plugin-loader/index.js:6-15`）。

### 14.5 conformance 与兼容（browser-safety 文件面与版本口径按 v2 改写）

- `packages/core/conformance`（可被第三方复用的断言套件）+ 仓内 `packages/core/test/*`：
  契约形状、幂等语义（§3.3）、错误码枚举、真实帧 zod 校验（补 §8#10 缺口）、
  **browser-safety（扫描面 = `src/contracts/**` + `src/client/**`：0 处 `node:`、0 处未守卫 `process.env.`；
  `readCoreEnv()` 的 `typeof process` 守卫必须是函数体首条语句 = 唯一的守卫式豁免；
  `src/locator-host.js` 是唯一允许 `node:` 的源文件）**、
  **发布自足性两个测试**：
  ① 档 1：`npm pack` 后在临时空目录 install 并跑 `obtainCoreNode({mode:'embedded'})`（走 `node_modules` 分支）；
  ② 档 2：**无 `node_modules/@khy/core`** 的沙箱 + 注入 `bundledEntry` → `obtainCoreNode` 可起；
  三者全无 → `CORE_LOCATOR_FAILED` 文案三段齐全。
- `require.resolve('zod')` 从 `packages/core` 包根必须可解析（D9；本会话 V11 实测今日五处 NOT RESOLVABLE）。
- 版本：**`@khy/core` 不并入 G2**（D1，§2.3）；起步版本与轨道归组由人拍板（§15-1）；
  `protocolVersion` 相等才可连；`coreVersion` 按 `enginesKhy` 区间（先例 `plugin-loader/index.js:245-248`）；
  `protocolVersion` 升版 = MAJOR，走人批准（`PROCESS-005`/R-2a）。
- 禁止依赖：`works/`、`scripts/`、`docs/`、`apps/`、`delivery/`、`@khy/shared`（未发布）——由 §13.3-1 拦。

---

## 15 待拍板项（已由 D1–D10 定死的从清单移除）

1. **`@khy/core` 的起步版本与版本轨道归组**（D1 明示：本批不并入 G2、不改 `check-version-sync.js` 的 10 源；
   首个发布前由人拍板）。
2. Windows PID 复用口径：接受「心跳 + epoch + 三字段指纹」，还是要求平台原生锁实现（§4.2）。
3. 凭据明文（`apiKeyPool.js:43`）是否顺带引入 OS keychain/DPAPI（§8#5）。
4. ai-backend 第二套网关（C13）的归并节奏（今日口径：独立服务 + 例外登记 + B8 网关切分）。
5. entry-buffer 余量 **54**（本会话 2416/2470）：S1 的 core 文件规模是否需人给一个上限（超过即必须先降 entry-buffer 基线）。
6. `apps/suite` 注册表变更（D8：LAYERS `apps` 释义 + `[DESIGN-LAY-005] §1` 表）须人批准——属 Suite 稿（222）范围，
   不在本稿机判内。
7. `KNOWN-EXCEPTIONS.json` 的条目 schema 与首条条目（D6；本会话实测 ABSENT，V8）——落表须人/owner 给 `owner` 与 `expiry`。
8. `apps/khyos-desktop` 的 `@khy/core` file: 链接在 electron-builder 打包链里能否随安装包在场
   （electron-vite 默认外部化 `dependencies`，而 `build.files` 实测只有 `out/**`、`resources/**`，`dual-facts.json:81-83`）
   ——B8 打包验证项，S1 前须实测；未验前本稿只固化 `bundledEntry` 注入点，不承诺安装包形态。

**已定死、不再作为待拍板项**：DOMAIN-DEPS 不改 / 严禁加 D3（D1）；core 不并入 G2（D1）；不开 `khy core` 子命令（D5）；
不扩展 `check-core-layers.js` 文件宇宙（D3，判据由新守卫承担）；编号 220（D10）；`zod` 精确锁版（D9）。

---

## 16 修订记录

### 16.1 第 2 版修订（v1 §16，原样保留）

| 评审条 | 处置 |
|---|---|
| §12/§1.3/§10 测试布局（entry-buffer） | §1.1 合规四件套 + 余量 55 实测（C1/C2）；§10.1 同目录测试约束；§12 S1 登记件从 7 处改 8 处 |
| §13.3 机判失明 | §0 结构表（:1617/:151/:185/:213-223/:339）；§13.3 四条判据（v2 已再改，见 R23）；§1.3 撤回「撞预算」论证 |
| §5 第二套计量/网关 + 删除条件 | §5.3 登记 ai-backend 例外（C13）与 khyquant 6 处直连（C8）；§5.4 口径表（C4-C7）更正 198 误数 |
| §6.1 事件双写者 | §5.1/§12 S5 把 **eventLog** 与 7 个写者列入迁移（v2 改为只改调用面，见 R20）；§6.1 seq 核心级、fail-soft 替换 |
| §6.2 单写者清单不全 | §6.2 补 sessionGroupService/dbHealthService/restoreService+sqliteHotCopy 并给出还原互斥 |
| §4.2 缺 fencing | §4.2 epoch + 二次确认 + 「被接管即自我降级」+ §9 `CORE_TAKEN_OVER`；§4.1 第 2 步加句柄验活 |
| §14 生态第一步落空 | C14 实测 plugin-sdk 不可安装；§14.2 发布前置（v2 按 D1 通道 (a) 改写，见 R29） |
| §13 边界无守卫 | §13.3-4 `core-skin-into-server` 黑名单 + §13.4 |
| §2.3 G2 事实错误 | 已撤回「三者同属 substrate」，改按 :57-68 实测重写（v2 进一步改为不并入 G2，见 R24） |
| §2.2 TS/构建面 | 决策 JSDoc `.js` + 手写 `.d.ts`（无编译、无新产物登记），exports 加 `types` |
| §6.2 引证错位 | 更正为 :66-69（WAL）与 :31-40（homedir 回退），并把该回退列为解析链第 6 条（§6.3） |
| §10.4 门是红的 | §10.4 列出 C1/C3 实测读数与「不新增 error / 读数不劣化」口径 |
| §0 基数 198 | 以 C4-C7 四口径替代 |
| §4.5 health 契约 | 新增唯一指纹定义；实测全仓无 `core/health`；探测失败分流写入 §4.1 |
| §12 CLI 缺步骤 | 新增 S3b（attach + 懒加载边；L0/入口预算零余量实测） |
| §2.2 zod 声明 | v1 写 `^3.24.0`（:142）→ v2 改精确锁版（R25） |
| §2.3 G2 并入 | v1 写「入 G2」（:163-170、:750）→ v2 撤销（R24） |

### 16.2 v2 修订（本轮关闭的 6 项 + 决策对齐，逐行留痕）

| # | 改了什么 | 在哪一节 | 如何机判 |
|---|---|---|---|
| **R18**（评审项 1 / CH-1） | `resolveEmbedded()` 不再放 `./client/locator.js`：`CoreLocator` 接口与 `obtainCore` 编排留 `./client`（零 `node:`），Node-only 定位器新增显式子路径 `./locator-host`（文件 `src/locator-host.js`，不在 `src/client/` 目录内）。**入口也一分为二**：`obtainCore()` 只 attach（不读文件、不 spawn、签名不含 mode/bundledEntry/allowSpawn），`obtainCoreNode()` 是 `auto`/`embedded` 的唯一入口——§4.1 签名、§4.4、§10.2、§10.3、§12 S3、§14.3、§14.5① 全部同步，不再有 `obtainCore({mode:'embedded'})` 残留。v1 §8#1 的「`CoreLocator.resolveEmbedded()`（`./client/locator.js`）」与 §14.5「client 内 0 处 node: 除 coreEnv.js」作废。**测试同时覆盖两面**：`browser-safety.test.js`（client/contracts 0 处 node:、0 处未守卫 process.env.、client 内不得出现 locator-host 字面量）与 `locator-host.test.js`（Node 可 require、四函数可调用、至少一个 node: 内置） | §2.2（exports + 浏览器安全三道）、§4.0（新）、§4.1（双签名 + 算法归属）、§4.4、§8#1、§10.2（新测试表）、§10.3、§12 S3、§14.3、§14.5 | 新增守卫 `check-core-boundary.js` 子档 `core-client-node-free`（契约见 §13.5）+ `node --test packages/core/test/{browser-safety,locator-host}.test.js`；`git grep -n "obtainCore({mode:'embedded'\|obtainCore({allowSpawn" packages/core` = 0。本会话基线：`check-core-boundary.js` 实测 ABSENT（V7），故该判据今日不可运行 |
| **R19**（评审项 2 / CH-2） | `KHY_CORE_*` 真源从 `client/coreEnv.js` 改挂**已显式 exports 的 contracts 子路径** `@khy/core/contracts/core-env`；backend `constants/serviceDefaults.js` 只从该子路径 `require`，禁止跨层相对上跳（会命中 `check-repo-layout.js:1617` + `:302-309`）与深导入（封闭 exports → `ERR_PACKAGE_PATH_NOT_EXPORTED`，v1 :152-153）；`readCoreEnv()` 加 `typeof process` 守卫（import 期零副作用）。**可解析性同批补齐**：§1.3 登记表新增 backend 的依赖声明 + `pnpm-workspace.yaml` override（沿 `@khy/plugin-sdk` 双件套先例）与 desktop 的 file: 声明——只进 workspace/importer 不产生链接，`require` 会 MODULE_NOT_FOUND。白名单（`check-agent-rules.js:621-622`，V14 实测只认两个后缀）改为 **S1 必做**，不再是条件句 | §2.2、§4.1（环境变量纪律整段重写）、§1.3（登记表三行：backend 声明/desktop 声明/白名单）、§12 S1、§14.5 | 子档 `core-env-single-source`（`KHY_CORE_*` 写入面唯一 + backend 无上跳相对路径）+ `node --test packages/core/test/core-env.test.js`（无 process → `{}`；import 期零副作用）；实施批在 backend 目录跑 `node -e "require.resolve('@khy/core/contracts/core-env')"` 必须可解析（今日实测 backend 无 `@khy/core` 任何声明）。`npm run check:agent-rules --changed` 不得因 core-env.js 新增 error（白名单同批） |
| **R20**（评审项 3 / CH-3） | 删除 v1 §6.1 ②「coordinator/tasks/observability 三者本体也在 core 职责内、随 S5 一起搬」。改为：`eventBus.js`+`eventLog.js` **本体**迁入 core（写者唯一）；C9 的 7 个写点**只改调用面**（迁移期走 backend 侧 eventLog 门面 re-export，S5 改 `coreEvents.publish()`），`coordinator/processAgent.js`、`coordinator/taskBoard.js`、`observability/{cpuProfiler,eventLoopMonitor,slowRequest}.js`、`services/usageTracker.js`、`tasks/largeTaskRuntimeStore.js` 的模块本体留 backend。§5.1 的计量行同步改为「只搬定价叶子与契约」；§13.1 收窄为点名式并写明「统筹 = 经事件/能力面协调，不靠承载任务板」，不与产品意图 1 相抵；eventBus/eventLog 属事件面本体、不在黑名单 | §6.1、§5.1（计量行）、§12 S5 ①、§13.1、§13.3-4 | `check-core-boundary.js` 的 `core-skin-into-server` 增判 `coordinator/`、`tasks/largeTaskRuntimeStore`、`observability/{cpuProfiler,eventLoopMonitor,slowRequest}` 路径（§13.3-4，**只点名四个模块，不含 eventBus/eventLog**）+ `core-responsibility.test.js` 断言 §13.1 名单与 `packages/core/src/server` 目录一致 |
| **R21**（评审项 4 / CH-4） | `resolveEmbedded` 从「只认 node_modules」改为四段定位顺序：**显式注入 > 宿主传入的 bundled 入口 > `node_modules/@khy/core` > 诚实报错 `CORE_LOCATOR_FAILED`**；新增 `ObtainCoreNodeOptions.bundledEntry`（路径或已加载模块对象）；§8#1 判据从「无工作树目录下 embedded 仍可起」改为「注入 bundled 入口后可起；三者全无时诚实报错」；**不新增构建产物**（不改 `BUILD-OUTPUTS.json`、不新增 `entries/<producer>`），bundled 入口只指向既有发行面（V9 实测 `files` 含 `bundled/`） | §4.0、§4.1 第 5 步、§8#1、§9（新行）、§3.4（新错误码）、§14.5（两个发布自足性测试） | `node --test packages/core/test/locator-order.test.js`（四场景，`obtainCoreNode`）+ `git diff --stat entries/ docs/10_规范/registry/BUILD-OUTPUTS.json` 为空 + §9 报错文案三段断言 |
| **R22**（评审项 5） | 明写机制登记契约：`samples.source.key` 一律 `counts.<finding-id>`（标量），`--json` 的 `counts` 键名全列（§13.5 给出逐键契约）；禁止 `key:"findings"`——`check-rollout-stage.js:157-169` 的 `pickKey` 在 :165-167 对 `typeof === 'object'` 判「不是标量读数」；既有合法先例（V13）三条 key 全为 `counts.*`、`rules` 全为 `[]`。**每条机制钉在自己的执行器上**：`core-boundary-guard` → `check-core-boundary.js`；`terminal-manifest-guard` → `scripts/ci/check-manifests.js`（D2）；`suite-assembly-guard` 的执行器/键未定前不登记该条目——不把三条机制硬塞进一个 `--json`，否则后两条必报 samples-unverified | §13.5、§1.3（机制行）、§12 S1 | `node scripts/ci/check-rollout-stage.js` 完整档：**已登记**机制 0 条 `rollout-stage-samples-unverified`（`suite-assembly-guard` 不登记即不判）；`node -e` 断言各机制 `key` 匹配 `/^counts\.[a-z-]+$/` 且与各自 `samples.source.script` 的 `--json` 键对得上；`check-core-boundary.js --json` 的 `counts` 键与 §13.5 契约逐字一致 |
| **R23**（评审项 6） | §13.3 执行器从「进 `check-repo-layout.js` 挂 `LAYOUT-001`」改为**新增独立 `scripts/ci/check-core-boundary.js`**：`const GUARD_STAGE='S1'`、S1 恒 exit 0、`--changed`/`--json`、finding 一律 `severity:'warning'`、不进 `LAYOUT-001` 的 `--promote` 名单、不新增规则 ID（ruleCount 101/94 已越界，V3）。§1.3/§12 S1 登记件同步（删 RULES-REGISTRY 补 findings、删 G2 行、删 DOMAIN-DEPS 行；加 `check:core-boundary` 别名 + pr-gate 步骤）。理由随文记录：V1 `check-core-layers.js` exit≠0；V2 报 `core-layers-guard` 的 `rollout-stage-authority-drift` | §13.3、§13.5、§1.3、§12 S1、§10.4（新行）、§16 | `node scripts/ci/check-core-boundary.js --json` exit 0；脚本源码含字面 `const GUARD_STAGE = 'S1'`（与 FEATURE-OWNERSHIP `executorStage.constant` 一致，防 authority-drift）；`git grep -n "check-core-boundary" scripts/ci/check-core-layers.js scripts/ci/check-repo-layout.js` = 0；`node scripts/ci/check-rollout-stage.js` 已登记机制 0 error（`suite-assembly-guard` 未登记即不判） |
| **R24**（D1） | v1 §2.3（并入 G2 + 改 label）与 :750 作废：**不并入 G2、不改 `check-version-sync.js` 的 10 源、不改 AGENTS.md 版本同步节**；core 起步版本与归组人拍板。§10.4 的 version-sync 行改为「维持 exit 0（本会话 V4）」。实测依据：`check-version-sync.js:38-82/:91-110` 硬编码组（V16） | §2.3、§14.5、§10.4、§1.3、§15-1 | `node scripts/ci/check-version-sync.js` 仍 exit 0 且 `VERSION_SPECS` 长度不变（10）；`git diff --stat scripts/ci/check-version-sync.js AGENTS.md` 为空 |
| **R25**（D9） | v1 :142 的 `"zod": "^3.24.0"` 改为精确三段 `"X.Y.Z"`（不用 `^`），implementation 期以 `pnpm add` 可得的最新稳定版固化；新增 conformance：自 `packages/core` 包根 `require.resolve('zod')` 必须可解析；拒绝 `semver`（V11：semver 五处可解析而均未声明 = 幻影依赖） | §2.2、§3.5、§14.5、§10.2 | 包根 `node -e "require.resolve('zod',{paths:['runtime/substrate/platform/packages/core']})"`（实施期）；`git diff` 中 core/package.json 的 zod 值无 `^`/`~`；lockfile 有 zod（须在有 pnpm 的机器再生） |
| **R26**（D1） | v1 §1.1/§1.3 的「contracts → D3 新 roots + 双 manifest」作废：**DOMAIN-DEPS 不改、严禁加 D3**（`d3-purity` 禁止 D3→D1/D2/D4/D5）；合规件从「四件套」收敛为「三件套」（1 manifest domain=D1 + 1 README + 同目录测试）；contracts 零依赖改由 `core-boundary-import` + 子档 B 判 | §1.1、§1.3、§13.4 | `git diff --stat docs/10_规范/registry/DOMAIN-DEPS.json` 为空；`find` 断言 `packages/core` 只有 1 份 `khy.module.json`；`check-core-boundary --json` 的 `core-boundary-import` 计数为 0 |
| **R27**（D4/D5） | `verify-single` 不是命令而是 finding 名：§4.4 明写「不开新 CLI 命令（D5）」，§10.3 计量证改为「收敛完成前一律报 `metering-dual-writer`，不得报 single」，并列出 D4 的收敛面（两份活跃写者 + khyquant 休眠写者 + 三份定价副本 + `writerId`/`coreId`） | §4.4、§10.3、§5.1（计量行）、§13.3（子档 metering） | `check-core-boundary --json` 的 `counts['metering-dual-writer']`（§13.5）+ `git diff --stat runtime/node/backend/src/cli/{aliases.js,router.js}` 为空（未加命令） |
| **R28**（D10） | 本稿编号归 **220**（落盘前重测，被占顺延）；§0 与头部写明；不预改 `entries.json:7` 与 `[DESIGN-ARCH-117]` 头注（实施期步骤 6，人批留痕） | 头部、§16 | 落盘当天重跑 DESIGN-ARCH 编号实测；`git diff --stat entries/entries.json` 为空（本稿不动） |
| **R29**（D1 通道 (a) + CH-4） | §14.2 按 D1 改写：`@khy/plugin-sdk` 补 `files`/`exports`/`publishConfig` 并与 `@khy/core` 同批 npm 发布；core 以包根源码发布、`files` 不得含 `dist/`、**不新增 BUILD-OUTPUTS 条目**；档 2 由 `bundled/` + pip wheel 承担；网关切分单列 B8；§12 S7 同步 | §14.2、§12 S7、§14.1 | `node -e` 读两份 `package.json` 的 `files`（无 `dist/`）；`git diff --stat docs/10_规范/registry/BUILD-OUTPUTS.json` 为空；`npm pack --dry-run` 的文件清单（实施期） |
| **R30**（D6 引用） | §4.1 写死 `KHY_CORE_*` 的仲裁顺序（用户显式 env > suite 注入 > 默认），与 D6 的 `AI_MGMT_HOST` 原则同构；§13.3 的 T6 子档读 `KNOWN-EXCEPTIONS.json`（V8 实测 ABSENT），例外表未落地前 T6 不判绿 | §4.1、§13.3（子档 T6）、§15-7 | `KNOWN-EXCEPTIONS.json` 存在性与 schema（实施期）；`check-core-boundary --json` 的 `counts['net-exception-expired']` |
| **R31**（复核轮修正，2026-11-17） | 复核 6 条逐条闭合：① embedded 旧口径残留——`obtainCore()` 拆为只 attach、`obtainCoreNode()` 独占 auto/embedded，§4.1 双签名 + 算法归属 + §4.4/§10.2/§10.3/§12 S3/§14.3/§14.5① 同步（R18）；② backend/desktop 缺依赖声明——§1.3 增 backend 声明 + override 双件套（沿 plugin-sdk 先例，`.npmrc` 实测 link-workspace-packages=true / auto-install-peers=false）与 desktop file: 声明，§15-8 记打包验证项（R19）；③ usageTracker 一处自相矛盾——§5.1 计量行改为「只搬定价叶子与契约、本体留 backend」；④ 机制三条硬塞一个执行器——§13.5 改为按执行器分登，`terminal-manifest-guard` 归 `check-manifests.js`（D2），未定执行器的 `suite-assembly-guard` 不登记（R22）；⑤ §13.1 与 §6.1 字面冲突 + 产品意图 5 无机判——§13.1 收窄点名式（eventBus/eventLog 显式列为例外）、新增子档 C `terminal-cross-reference`；⑥ 四处小失真——分片合计改 12105（四文件实测）、requireGraph 引用改为「V6/V7/V8 同一命令实测」，zod 引用改 `dual-facts.json:150/:269-270`、adapters 改「目录实测 71 项（70 .js）、登记 68 陈旧」、V12 行号改 157–169/135–154 | §1.3、§2.2、§3.5、§4.0、§4.1、§4.4、§5.1、§6.1、§10.2、§10.3、§12、§13.1、§13.3、§13.5、§14.3、§14.5、§15、§0.2 | 复核后重测命令与读数：`node -e` 读四份 `aiGateway*Method(s).js` = 7034/1098/1702/2271（合计 12105）；`dir gateway/adapters` 71 项（70 `.js`、0 目录）；`node -e` 读 `runtime/node/backend/package.json` = `peerDependencies["@khy/plugin-sdk"]="*"` + `peerDependenciesMeta.optional:true`、`dependencies` 无 `@khy/core`；`.npmrc` 含 `link-workspace-packages=true` 与 `auto-install-peers=false`；`dual-facts.json:150`/`:269-270` 为 zod 的 0 import 读数；`node -e` 扫描本稿：`obtainCore({mode:'embedded'` / `obtainCore({allowSpawn` 仅出现在 R18/R31 的「作废」叙述里（无签名用法） |

---

## 附：本稿未核实项

- 方案原文 A2/A3/A5 的准确语义（v1 与本会话均未读到原文；`refactor-001-coupling.md:341-342` 自述未读）。
- `aiManagementServer.js` 全路由表（3883 行，`dual-facts.json:278`）；本稿只用其导出面（:10）与端口逻辑（:3538-3573）。
- `delivery/mobile`（Flutter）的 core 接入形态——不在任何 facts 扫描根内（`assets-facts.json:173`）。
- `[DESIGN-ARCH-219]` 全文（本会话只经 decisions-v2 引用其行号）；子档编号里只有 `T6` 由 D6 点名，A/B/C 与 metering 的编号按本稿定义（内容以本稿为准）。
- `check-repo-layout.js` 的 entry-buffer 具体读数：本会话未直接运行其 `--json`（V2 的探针输出给了 `2416/199/277`）。
- 桌面安装包如何携带 core 的打包细节（extraResources/asarUnpack）——属 B8/实施期，本稿只固化 `bundledEntry` 注入点。
- `npm run check:version-sync` / `check:delivery` / `check:ssot-data` 已在本会话运行（V3/V4/V5）；`rules:gate`、`test:delivery-baseline`、`docs:verify` 未运行。
- `tasks/largeTaskRuntimeStore.js:1812` 是 `eventLog.snapshot()`（非 `.append`），其写入目标是否与主 JSONL 同文件未逐行核实（v1 遗留）。
