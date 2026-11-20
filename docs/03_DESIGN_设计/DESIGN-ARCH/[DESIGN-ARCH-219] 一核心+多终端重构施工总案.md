# [DESIGN-ARCH-219] 一核心 + 多终端重构施工总案（refactor-master v2 收口稿）

- 生成：2026-11-17 · 角色：总案编写员（工作流子代理，「总案 v2 编写员」）
- 性质：**施工总案收口草稿**。本文件**未改任何生产代码**、未 `git add/commit/push`、未改版本号、未删文件、未动 `docs/00_INDEX_*` 既有条目、未动 `runtime/boot/kernel`（L0）、`runtime/substrate/platform`（L1）既有定位、`delivery/channel`（L4）既有定位。唯一写入 = 本文件（`.khyos/` 被 `.gitignore:80` 排除，不入仓）。
- 合成来源（本会话全文读取）：`decisions-v2.md`、`core-handle-v2.md`（1012 行）、`terminal-manifest-v2.md`（476 行）、`composer-suite-v2.md`（543 行）、`refactor-001-coupling.md`、五份 facts JSON（`coupling/layout/assets/dual/rules`）、`refactor-master.md`（v1 总案，495 行）、未闭合项复核结果 21 条（本 ask 材料）。
- 决策授权口径：**用户 2026-11-16 授权由 AI 决策**（本 ask 原文），D1–D10 即该授权下的定稿口径（真源 `decisions-v2.md` §1）。仍须人点头的五处（`apps/suite` 注册表语义、core 起步版本与轨道归组、`KNOWN-EXCEPTIONS` 的 owner/expiry、计价两处行为修正、`entries.json:7` 与 `[DESIGN-ARCH-117]` 头注订正）在本稿 §2/§13/§16 **逐条列明**，AI 不代改。
- 优先级：**仓库实测 > 2026-11-16 产品意图 > 方案原文**。
- 证据口径：现状断言一律引「本 ask §0 实跑读数」或「facts/草稿路径:行号」或「本轮 node 探针」。方案原文未在本会话读取（仓内无该文档），§14 的「方案禁止事项」逐条以任务书已知偏差清单 + 三份设计稿记录的方案主张为对照对象，**实施前须以原文回填校对**。
- 层级真源：`scripts/ci/check-repo-layout.js:111-121`（LAYERS 9 键，本轮复读）、`:123-165`（CROSSCUTTING 6 键）。
- 阅读顺序建议：§0（门现在多红）→ §2（评审 21 条落点）→ §10/§12（施工与接线）→ §16（哪些事 AI 没资格定）。

---

## 0 施工前基线（实跑）

> 下表 **B1–B9 共 9 条**（B1–B7 = 任务书画定的门禁基线；B8–B9 = 本稿为 T1 判据补跑的 headless 命令），全部是**本会话亲自执行**的命令与退出码（cmd 下用 `cmd /v:on /c "... & echo !errorlevel!"` 取码，避免 `&&` 解析歧义）。
> **易漂项**（根目录杂物计数、`??`/改动集、条目/机制计数、行号类引证）当作**当日快照**，实施前必须重取；不随并发写入变化的读数（三轨道版本、规则总数、entry-buffer 基线、`GRADUATION_SAMPLES` 常量）可直接引用。

| # | 命令 | 本轮读数（2026-11-17） | 易漂？ |
|---|---|---|---|
| B1 | `node scripts/ci/check-core-layers.js` | **exit 1**；11 条 ❌：`core-budget-lines` ×2（`toolUseLoopCore.js` 冷闭包 30629 > 预算 30175；`gateway/aiGateway.js` 71833 > 71078）、`visual-budget-files/lines` ×8（App.tsx 59/37 与 14729/9415、AppLayout 33/18 与 8540/4535、Composer 16/11 与 3387/2382、TUI Transcript 18/17 与 4295/4178）、`visual-lazy-regression` ×1（App.tsx 的 ToolExecutionPanel 不再是懒加载）；另有 `inversion-lazy` warning 2 条 | 行号/读数易漂 |
| B2 | `node scripts/ci/check-rollout-stage.js` | **exit 0**；`Summary: 0 error(s), 44 warning(s)`；其中 `[WARN ] rollout-stage-authority-drift scripts/ci/check-core-layers.js:1` —— 「机制 `core-layers-guard` 声明阶段权威是 `scripts/ci/check-core-layers.js` 的 STAGE 常量，但文件里找不到该常量」（本轮另用 node 复读该文件：`GUARD_STAGE`/`const STAGE` **均不存在**） | 条目数易漂 |
| B3 | `node scripts/ci/check-delivery-baseline.js --json` | **exit 0**；`stage=S1`；`counts {PASS:7, PARTIAL:0, GAP:5, UNKNOWN:0, SKIPPED:0}`；5 条 finding 全 warning：`delivery-repo-integrity`（`git fsck` 退出码 2）、`delivery-artifact-missing`（`dist/` 存在但缺非零字节 wheel/sdist）、`delivery-clone-incomplete`（**`?? = 346 · D = 9`，改动集 772 项**）、`delivery-debt-not-converging`（`check-debt-ledger` 退出码 1）、`delivery-surface-ratchet-breach`（**routerCommands 249/245 · aliasEntries 595/591 · handlerFiles 167/155 · ruleCount 101/94**，四项全越界） | 改动集/`??` 易漂 |
| B4 | `node scripts/ci/check-ssot-data.js` | **exit 0**；「语料 249 文件 / 事实 11 条 / 授权镜像 8 个；影子副本 0 · 值矛盾 0 · 镜像失步 0 · 整文件副本 0 · 自相矛盾 0」；S1 观察者档 | 语料数易漂 |
| B5 | `node scripts/ci/check-version-sync.js` | **exit 0**；G1 **1.2.2** / G2 **1.6.5** / G3 **0.1.0**；`runtime/substrate/platform/khy_platform/__init__.py: <dynamic from pyproject.toml>`；`All version sync checks passed.` | 版本号随发布漂 |
| B6 | `node scripts/ci/check-repo-layout.js` | **exit 1**；error 4 类：**root-whitelist 14**、**root-shadow-dir 2**（`.khy`、`.khyos`）、**root-junk 80**、**layer-registry 7**；warning：root-uncatalogued 110、dangling-task 101、cross-layer-require **37**、domain-direction **199**、functional-unit **277**、entry-buffer **2416**（manifest-missing 375 + promotion-incomplete 2041）。baseline 同屏打印：`dangling-task 101 / cross-layer-require 37 / domain-direction 199 / functional-unit 290 / entry-buffer 2470` ⇒ **三条零余量、entry-buffer 余量 54** | 根面计数极易漂（v1 已实测两次读数不同） |
| B7 | `npm run docs:verify` | **exit 1**；「源 Markdown 1599 · 生成 HTML 1600 · 校验本地链接 18181」→「✗ 失败：1 个问题」：断链 `works/record/ai/audit-khy-os.html -> ../../../login` | 断链数易漂 |
| B8 | `node runtime/node/backend/bin/khy.js entry probe --json` | **exit 0**；7 端全部 `status=ready`、`drift=null`；`mobile.machine.ok=false`（「本机缺少 flutter，本机无法构建或运行本端（仓库级声明不受影响）」）；**`desktop-provider-hub` 的 `declaredStatus=degraded` 而 `status=ready`、`drift` 仍 `null`** ⇒ `drift` 只报单向缺口（判据修正见 §9.1） | 端状态随工作树漂 |
| B9 | `node runtime/node/backend/bin/khy.js --version` / `... entry list --no-probe` | 均 **exit 0**；前者输出 `1.2.2`（与 B5 的 G1 同源） | — |

**口径**：`check-core-layers=1；check-rollout-stage=0；check-delivery-baseline=0；check-ssot-data=0；check-version-sync=0；check-layout=1；docs-verify=1`。
**禁止**在任何施工报告里把上述任一项写成「已修/全绿」；全部验收口径统一为「**不新增 error 条目 + 相关读数不劣化**」（§12）。

### 0.1 新增物存在性（本轮 node `fs.existsSync` 实测，全部 ABSENT）

| 路径 | 状态 | 归属 |
|---|---|---|
| `runtime/substrate/platform/packages/core` | ABSENT（`packages/` 下实测仅 `moonbit-plugin-sdk,plugin-sdk,shared,ui-shared`） | D1 / 220 |
| `apps/suite` | ABSENT（`apps/` 实测只有 `khyos-desktop`） | D8 / 222 |
| `scripts/ci/check-core-boundary.js` / `check-manifests.js` / `gen-entry-matrix.js` | ABSENT | D3 / D2 |
| `docs/10_规范/registry/{TERMINAL-MANIFEST.schema.json, CAPABILITY-VOCAB.json, KNOWN-EXCEPTIONS.json}` | ABSENT | D2 / D6 |
| `khy.terminal.json`（任意位置） | 全仓 0 份（v1 M6 实测；本轮 `entries/entries.json` 侧写一致） | D2 |
| 根 `package.json` 别名 `check:core-boundary` / `check:manifests` / `check:manifests:json` / `gen:entry-matrix` / `suite:validate` / `verify:core-single` | **六个别名全部不存在**（本轮读 `scripts` 对象逐个核；`scripts` 总数 346；`check:core-layers`/`check:layout`/`check:delivery`/`check:ssot-data`/`check:version-sync`/`docs:verify`/`check:wiring`/`check:rules` 存在） | D3/D2/D5 |
| `FEATURE-OWNERSHIP.rollout.mechanisms` 里的 `core-boundary-guard`/`terminal-manifest-guard`/`suite-assembly-guard` | 不存在（实测 40 条机制，**带 `samples.source` 的只有 3 条**，key 全为 `counts.domain-direction` / `counts.functional-unit` / `counts.entry-buffer`） | D3 |

### 0.2 本轮补测的既有结构读数（写进决策依据，非易漂项可长期引用）

- `docs/10_规范/registry/DATA-SSOT.json`：`scan.include` = `["runtime/","delivery/","apps/","scripts/","tools/","works/ship/","entries/","docs/10_规范/registry/"]` —— **`entries/` 在语料内**（TM-1 的事实基础）；`facts` 11 条（id 全列：ai-backend-port, web-frontend-port, web-frontend-port-window, bridge-port, remote-control-port, phone-bridge-port, inference-server-port, rule-count, ollama-port, backend-port, amoo-tool-contract）、`sources` 25 条；**全文无 `token_usage`**。
- `docs/10_规范/registry/DATA-LOCATIONS.json`：`roots` 只有 `khy/khyos/state` 三项；`knownGaps` 只有 `phone-discovery-user-home`；**无 `token_usage`**（D4 的登记缺口）。
- `docs/10_规范/registry/RULES-REGISTRY.json`：`rules.length = 101`；LAYOUT 域实测只有 `LAYOUT-001…008` ⇒ **`LAYOUT-009` 空闲**；`LAYOUT-001.exec = {script:"scripts/ci/check-repo-layout.js", args:["--promote=root-whitelist,docs-index-first,layer-registry"], findings:[9 项]}`；`COMMS-001.exec.findings` 长度 **0**。
- `docs/10_规范/registry/BUILD-OUTPUTS.json`：30 条；`quant-frontend-dist`（path `entries/quant-frontend`，status `migrating`，legacyPath `delivery/channel/khyquant/frontend/dist`，rebuild `npm run build --prefix delivery/channel/khyquant/frontend`）与 `ai-frontend` 同型；**`electron-out`/`electron-dist` 的 rebuild 实测仍是 `pnpm run build --filter khyos-desktop`**（desktop 不在 workspace ⇒ 注定失败的假命令，D8 同批修）。
- `entries/entries.json`：顶层键 `meta,kinds,statuses,modes,entries`；`kinds`=cli/desktop/mobile/web、`statuses`=ready/degraded/broken/planned、`modes`=attach/wait/detach（**三块枚举在顶层，不在 `meta` 下** —— terminal-manifest-v2 F1 的更正本轮复核一致）；7 条端：cli/cli-node/desktop/web/web-quant/mobile 为 `ready`、desktop-provider-hub 为 `degraded`，**7/7 带 `statusNote`**；`web-quant` 的 `artifactOutput = null`、`ports = []`（D7 要补的指针）；`meta.ssot` = `docs/03_DESIGN_设计/[DESIGN-ARCH-117] khy-多端入口矩阵.md`（顶层该路径不存在，真身在 `DESIGN-ARCH/` 子目录 —— TM-4）；launch 形态：cli `./khy.sh`/attach、cli-node `node`/attach、desktop & provider-hub & web & web-quant `npm`/detach、mobile `flutter`/attach（CS-3 的不可无人值守面）。
- `pnpm-workspace.yaml` packages **9 项**（无 `apps/`）；`pnpm-lock.yaml` importers **7 个**（`.`、khyquant/frontend、ai-frontend、provider-hub、ai-backend、backend、packages/shared）⇒ **`ui-shared`/`plugin-sdk` 的 importer 本就缺失**（D1/D8/D9 的 lockfile 前置成立）。
- `runtime/node/backend/package.json`：`dependencies` **无** `@khy/core`；`peerDependencies["@khy/plugin-sdk"] = "*"`；`.npmrc` 实测 `link-workspace-packages=true` + `auto-install-peers=false` ⇒ **只进 workspace 不产生可解析链接**（core-handle-v2 §1.3「双件套声明」的依据）。
- `require.resolve('zod')` 本轮探针：`.`、`runtime/substrate/platform`、`.../packages`、`.../packages/shared`、`runtime/node/backend`、`runtime/node/ai-backend`、`.../packages/plugin-sdk` **七处全部 NOT RESOLVABLE**；`semver` 七处全部解析到 `D:\Portable\khy-os\node_modules\semver\semver.js` 而未在任何 `dependencies`/`devDependencies` 声明 = 幻影依赖（D9）。
- 计量现状（CS-4）：`%USERPROFILE%\.khyquant\token_usage.json` 实测顶层键仅 `["daily","monthlyTotals"]`，**全文无 bootId / coreId / writerId / records**；写者三处同一路径字符串（backend `services/tokenUsageService.js:27`、ai-backend 同名文件、khyquant `services/tokenUsageService.js:12`；本轮 node 复读 `tokenUsageService.js:27` 一致）。
- 定价副本（CS-5）：`runtime/node/backend/src/services/usageTracker.js:30-41` 自持 `PRICING`（**9 个具名键 + `default`，共 10 项**；本轮逐行数过：claude-3.5-sonnet / claude-3-haiku / claude-3-opus / gpt-4 / gpt-4o / gpt-4o-mini / deepseek-v3 / deepseek-r1 / qwen-plus + default），`:49-59` `_logDir=null`/`_enableLogging=false`，`:329-338` 写 `usage-<date>.jsonl`，`:342` `new UsageTracker()` 无 opts ⇒ 休眠；`:177-182` 向 `observability/eventLog` 写 `usage.record`（活跃事件写者，CH-3 清单第 6 条）；`aiGatewayGenerateMethod.js:30` require、`:6108` `usageTracker.record` ⇒ 网关计量活跃路径。
- LAN 现状（CS-8）：`runtime/node/ai-backend/server.js:124-138`（ARCH-074 注释 :124-125、`let AI_MGMT_HOST = '0.0.0.0'` :127、serviceDefaults 覆盖 :129-132、**`process.env.AI_MGMT_HOST` 优先级最高 :136-138**）；`runtime/node/backend/src/constants/serviceDefaults.js:314` `const AI_MGMT_HOST = process.env.AI_MGMT_HOST || '0.0.0.0'`。
- 桌面进程事实（CS-7）：`apps/khyos-desktop/src/main/index.ts:121` `app.requestSingleInstanceLock()`、`:799` `fork(finalHostPath, [], {stdio:['pipe','pipe','pipe','ipc']})`、`:827` fork scheduler；`src/host/index.ts` 全文 2034 行、**`nodeRequire(` 实测 20 处**、`:70` `resolveKhyOsDir()`、`:126` 拼 `runtime/node/backend/src/services/gateway/aiGateway.js`。
- 既有 stale 自愈先例（L5 的手法来源）：`runtime/node/backend/src/services/daemonManager.js:217-228`（`!isAlive(pid)` → 清理 stale PID 文件并回 not-running，本轮亲测）。
- 编号（TM-3）：`docs/03_DESIGN_设计/DESIGN-ARCH` 本轮实测 **214 篇 `.md`、最大编号 219**（`[DESIGN-ARCH-219] 一核心+多终端重构施工总案.md` 存在）、**220/221/222/223/224 全空闲**；主索引 `docs/00_INDEX_文档索引.md:201` 已登记 219，DESIGN-ARCH 子索引本轮未见 219 行。

### 0.3 复现方式（本轮 §0.2 读数的来源，全部只读）

- 登记表/包结构：`node -e` 读 `runtime/substrate/platform/packages`、`works/ship/npm/package.json`、`runtime/substrate/platform/packages/plugin-sdk/package.json`、`entries/entries.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`（importers 用 `^ {2}\S[^:]*:$` 精确切段）、`.npmrc`、`runtime/node/backend/package.json`、`docs/10_规范/registry/{DATA-SSOT,DATA-LOCATIONS,RULES-REGISTRY,FEATURE-OWNERSHIP,BUILD-OUTPUTS,ATOMIC-CAPABILITIES,CORE-LAYERS,ARCHITECTURE-POLICY}.json`、`works/ship/modules/modules.json`、根 `package.json` 的 `scripts`。
- 源码行：`node -e` 按行号打印 `check-repo-layout.js`（:304-309/:310-322/:1617/:1699-1700）、`check-rollout-stage.js`（:90/:157-168/:308-320/:399-410/:429-438/:442-459）、`ssotDataGuard.js`（:52/:614-618）、`ruleguard/lib/run.js`（:325-350）、`check-core-layers.js`（:151/:185/:213-223/:339）、`usageTracker.js`、`tokenUsageService.js`、`serviceDefaults.js`、`ai-backend/server.js`、`eventLog.js`/`eventBus.js`/`sessionSearchIndex.js`/`daemonManager.js`/`aiManagementServer.js`/`webRemoteControl/server.js`/`plugin-loader/index.js`、`apps/khyos-desktop/{src/main/index.ts,src/main/remote/index.ts,src/host/index.ts,package.json}`。
- 依赖可达性：对 7 个目录分别 `node -e "require.resolve('zod'|'semver',{paths:[<dir>]})"`。
- 环境：`node -v`（v22.18.0）、`where pnpm`、`where corepack`（后两者 NOT FOUND）、`git status --porcelain` 计数（`find /c /v ""`）。
- 临时探针脚本一律写在仓库外（`%TEMP%`），**未落进仓库**；本轮仓库内唯一新增文件 = 本稿。

---

## 1 决策记录（D1–D10；用户 2026-11-16 授权由 AI 决策）

> 十项均已定稿（基线真源 `decisions-v2.md` §1）。每项四段：**口径 / 理由（实测锚点）/ 回滚 / 可逆性**。**与 `decisions-v2` 字面不同的 3 处已逐条登记在 §1.2，不做暗改。**
> 决策不是「AI 替人拍板发布」：涉及版本号、门档升阶、既有对外行为三项，决策**只收窄范围、不越权执行**（§13/§16）。

### D1 —— core 落点、发布两档与生态通道

- **口径**：core 落 `runtime/substrate/platform/packages/core` = 新 workspace 包 `@khy/core`；exports 共 **7 条键**：`.`（= contracts 入口）、`./contracts`、`./contracts/core-env`、`./client`、`./locator-host`、`./server`、`./package.json`；源码 JSDoc-typed `.js` + 手写 `.d.ts`，**不引编译步骤**。发布两档：**档 1**（生态默认）`contracts`+`client` 可独立 npm 安装、零 `node:`、零副作用，第三方以 **attached** 连官方 core 进程；**档 2** embedded 全量随官方发行包（npm `bundled/` + pip wheel）交付，**不承诺源码级轻包**；网关切成可发布子集单列 **B8**。生态接入通道取 terminal-manifest §9.4 三选一的 **(a)**：`@khy/plugin-sdk` 补 `files`/`exports`/`publishConfig` 并与 `@khy/core` 同批 npm 发布；(c) 降为档 2 机制、不单独立项。同批落 **CH-1~CH-4** 四项修正（① Node-only 定位器移 `./locator-host`；② `KHY_CORE_*` 真源挂已 exports 的 `./contracts/core-env` + `typeof process` 守卫；③ 定位顺序 = 显式注入 > 宿主传入 bundled 入口 > `node_modules` > 诚实报错 `CORE_LOCATOR_FAILED`；④ 删「coordinator/tasks/observability 本体随 S5 搬」半句）。
- **理由**：门面方案第三方拿不到 core（`works/ship/npm/package.json` 实测 `files` = `["bin/","bundled/","scripts/postinstall-compress.js","scripts/install/enable-fs-compression.sh"]`、**无 `dependencies` 键**，本轮 B0.2）；`check-repo-layout.js:310-322` 的 `WORKSPACE_ROOTS` 实测 11 条、**无 core、无 ui-shared、无 plugin-sdk**，不登记即 `workspaceRootOf()` 返回 null → 调用点 `continue`（`:304-309` 注释自陈假绿前科）；`DOMAIN-DEPS.json` D1.roots 已覆盖 `runtime/substrate/platform`，落其下**自动**进 D1 判据面，而 `enforced[0] d3-purity` 禁止 D3→D1/D2/D4/D5 ⇒ **严禁加 D3**；`check-version-sync.js` 的 10 源三组硬编码 ⇒ **不并入 G2**；lockfile 实测 7 importer 而 workspace 9 包 ⇒ core importer 必须同批再生，且本机无 pnpm/corepack（v1 M18、composer-suite-v2 §13）。
- **回滚**：删 `packages/core` 整目录；逐 hunk 还原 `pnpm-workspace.yaml`、根 `package.json`（workspaces + overrides）、`pnpm-lock.yaml`、`check-repo-layout.js` 的 WORKSPACE_ROOTS、`runtime/node/backend/package.json`（`@khy/core` 依赖声明）、`apps/khyos-desktop/package.json`（file: 声明）、`FEATURE-OWNERSHIP.json`、`API-SURFACE.json`、`DATA-LOCATIONS.json`/`DATA-SSOT.json`、`.github/workflows/pr-gate.yml`。**禁止** `git checkout .` / `git reset --hard`（本轮 `git status --porcelain` 实测改动集 **772 行**、已跟踪改动 426 项，`git status -uno` 计数 426）。
- **可逆性**：true（纯新增目录 + 登记表条目；未发布、无数据迁移、无对外契约变更）。

### D2 —— 终端清单真源与端矩阵投影

- **口径**：采纳 **A**：7 份 `khy.terminal.json`（platform、backend、desktop、provider-hub、ai-frontend、khyquant frontend、mobile）为**编写真源**；`entries/entries.json` 降为**生成投影**（入库、逐字节可复算）；同批交付 `scripts/ci/gen-entry-matrix.js` + `scripts/ci/check-manifests.js`（S1）；**逐字节保留顶层 `kinds`/`statuses`/`modes` 三块枚举**（本轮实测三块确在顶层；`registry.js:322-333` 按 `registry.kinds/registry.statuses` 校验，本轮复读一致）。DATA-SSOT 登记走**最小替代**：7 份清单路径进 `sources[]`；`facts[]` 可选一条 `terminal-matrix`（`json-count` + `/entries`，note 明写「不提供影子副本保护」）；schema/词表**不进 `sources[]`**，各登记一条 fact + 分发副本 mirror（长度/标量级）。
- **理由**：`VALUE_KINDS` 只有 6 种、fact 模型是「单标量 + 单指针 + 逐条 mirrors」，表达不了「7 份 → 1 份聚合」（`scripts/lib/ssotDataGuard.js:52`、`:432-457`，terminal-manifest-v2 §0.4 第 3 条）；若把 schema/词表进 `sources[]`，D4 的整文件指纹会把逐字节分发副本判成 `ssot-source-shadow-copy`（`:499-534`）。
- **回滚**：`git checkout -- entries/entries.json`（按 hunk，回手写真源语义）；删 7 份清单 + schema + 词表 + 两个脚本；还原别名、pr-gate 步骤、机制条目、DATA-SSOT 条目。回滚后 `gen-entry-matrix --check` 报投影不存在，无半份残留。
- **可逆性**：true（生成物与登记表；`entries.json` 入库不属数据迁移）。

### D3 —— 新判据的落地形态（规则棘轮与 S1）

- **口径**：**S1 期不新增规则 ID**。四条基础判据 + 子档全部进**新增独立执行器** `scripts/ci/check-core-boundary.js`：自带字面 `const GUARD_STAGE = 'S1'`、S1 **恒 exit 0**、支持 `--changed/--json`、finding 一律 `severity:'warning'`、**不进** `LAYOUT-001.exec.args` 的 `--promote=` 名单、**不挂** `check-core-layers.js`/`check-repo-layout.js`。机制登记**按执行器分登**（一执行器一机制）：`core-boundary-guard` → `check-core-boundary.js`；`terminal-manifest-guard` → `check-manifests.js`；`suite-assembly-guard` 在执行器与 `counts` 键未定前**不登记**。`samples.source.key` 一律**可复算标量**：违规计数（`counts.<finding-id>`）只允许用于**健康态非零**的判据；两个新执行器统一另给 `counts.checks-run`（断言数）作样本键（理由与机判依据见 §11.3 末条）。毕业（S3）才新增 `LAYOUT-009` 且必须先退役/合并一条既有规则。
- **理由**：`scripts/ruleguard/lib/run.js:345` 阻断判定 = `strength==='blocking' && severity==='error'`（warning 发射即不阻断）；`check-rollout-stage.js:157-168` 的 `pickKey` 在 `:165-167` 把 `typeof cur === 'object'` 判「不是标量读数」（本轮逐行复读）；`FEATURE-OWNERSHIP` 40 条机制中带 `samples.source` 的 3 条 key 全是 `counts.*`（本轮实测）；ruleCount 101/94 已越界（本轮 B3）；`check-core-layers.js` 无 `STAGE`/`GUARD_STAGE` 常量且实跑 exit 1（本轮 B1 + 文件复读），寄生它 = 把 authority-drift 复制一份 + 被父档红连带。
- **回滚**：删脚本；摘 `check:core-boundary` 别名与 pr-gate 步骤；删机制条目（纯配置，无行为变更）。
- **可逆性**：true。

### D4 —— 计量收敛先行于单实例宣称

- **口径**：`UsageStore` 叶子进 core（最小版：直接委托既有 **`runtime/node/backend/src/services/tokenPricing.js`** 叶子 —— 该文件本轮实测 `:37` `USD_TO_CNY = 7.25`；`services/gateway/` 下**没有**同名文件，勿写错路径）；两份活跃写者（backend / ai-backend 的 `tokenUsageService.js`）收敛为**单一写者实现**，khyquant 同名文件为**休眠写者、排第三**；落盘 schema 加 `writerId` + **`coreId`**（`schemaVersion:2`、`meta.lastWriterId/lastCoreId`、`records[]` 环形 500）；**`coreId` 与租约里的实例 id 用同一字段名**（见 §1.2 偏离 3）；落点从 `os.homedir()` 改解析家并保留 legacy 双读；同批登记 `DATA-SSOT.json`（fact `token-usage-file`）与 `DATA-LOCATIONS.json`（**走 `knownGaps` 先例**，因登记表表达不了 user-home 路径）。**待并定价副本 3 份**（ai-backend `:18-31`、khyquant `:18-31`、`usageTracker.js:30-41`）+ **1 处已委托消费点**（backend `tokenUsageService.js`，已 require 叶子）⇒ 收敛后全仓只剩 `tokenPricing.js` 一处定价真源；`usageTracker` 是 model 键表 ⇒ 叶子增设 `MODEL_PRICING` + `calculateModelCost`，逐字迁移，**不直接并表**；`usage-<date>.jsonl` 启用前必须登记，未启用则进 KNOWN-EXCEPTIONS 的休眠写者条目。**收敛完成前，任何「single」断言一律报 `metering-dual-writer`。**
- **理由**：本轮实测 `token_usage.json` 顶层只有 `daily`/`monthlyTotals`、无写者身份 ⇒ 三证③今天**没有可判数据面**；`usageTracker.js` 的 `PRICING`/jsonl/`eventLog` 三面本轮复核（§0.2）；khyquant 那份是随平台分发的在仓实现（`runtime/node/backend/src/cli/khy.module.json` 的 `fanInEvidence` 数组实测含 `delivery/channel/khyquant/services/tokenUsageService.js` —— 本轮 node 复读证实），不处置则「收敛完成」会被它推翻。
- **回滚**：逐文件还原两份 `tokenUsageService.js`、`aiGatewayGenerateMethod.js`、khyquant `services/tokenUsageService.js`；`USAGE_FILE` 指回 `path.join(os.homedir(),'.khyquant','token_usage.json')` 并保留 legacy 读；数据文件不迁移 ⇒ 回滚无损。
- **可逆性**：true。

### D5 —— 不开新 CLI 命令

- **口径**：本重构**不开**任何新 CLI 命令（`khy core status` / `khy suite validate` / `khy core verify-single` 均不建）。验收走 `npm run` 脚本 + `node --test`；用户可见文案只引用既有 `khy doctor` / `khy entry`。「verify-single」按此降格为**npm 脚本 + finding 名**（`metering-dual-writer`），不是命令名。
- **理由**：本轮 B3 实测 routerCommands 249/245、aliasEntries 595/591、handlerFiles 167/155 三项越界；`check:delivery` 在 S1 只 warning，再加命令会把越界长期挂着（正是 `[DESIGN-ARCH-111]` 批判的「无绑定层」形态的反面教材）。
- **回滚**：无代码可回滚（纯口径）。
- **可逆性**：true。

### D6 —— LAN 边界与 ai-backend 的 `0.0.0.0`

- **口径**：组合态**只对 suite 装配面自己拉起的 listener** 注入 `AI_MGMT_HOST=127.0.0.1`；仲裁顺序写死 **用户显式 env > suite 注入 > `serviceDefaults` 默认**；ai-backend 既有 `0.0.0.0` **默认保留**，登记为**机读遗留例外** —— 新立 `docs/10_规范/registry/KNOWN-EXCEPTIONS.json`（条目 `id/target/owner/reason/expiry/reverify`），消费者 = `check-core-boundary.js --lan`（T6 子档：命中放行、过期 warning、缺 `reverify.command` warning）；**例外表与消费者未同批落地前 T6 不判绿**；LAN 保持显式 opt-in（`webRemoteControl` 既有 `lanEnabled`/`KHY_REMOTE_BIND_HOST`）。**不挤占** `ARCHITECTURE-POLICY.json` 的 `exceptions`（实测 `[]` 且全仓无读者）。人批动作相应缩小为「不动 ai-backend 默认值」。
- **理由**：本轮逐行复读 `ai-backend/server.js:136-138` 证明 env 优先级最高 ⇒ 无条件注入会压掉运维显式设的 `0.0.0.0`，让「LAN 显式开关」失效；registry 目录无例外类载体（CS-6）。
- **回滚**：移除注入（不设 `AI_MGMT_HOST`）即回 `serviceDefaults` 默认；删例外条目；无代码删除、无数据迁移。
- **可逆性**：true。

### D7 —— web-quant 进组合态

- **口径**：组合态**只装载 BUILD-OUTPUTS 登记的产物** `quant-frontend-dist`（path `entries/quant-frontend`、status `migrating`、legacyPath `delivery/channel/khyquant/frontend/dist`）；**禁止 dev server 装载**；web-quant 清单的 `artifactOutput` 由生成器从 `null` 补为 `quant-frontend-dist`（**不手改投影**）；开发态 `--host 127.0.0.1` 且不开 `--open`（改 khyquant 三个 dev 脚本属实施期）。
- **理由**：本轮实测 `delivery/channel/khyquant/frontend/package.json` 的 `dev`/`dev-no-browser`/`dev-auto-port` **三个脚本都是 `vite --host 0.0.0.0`**（其中两个还带 `--open`），而 `entries/entries.json` 的 web-quant `artifactOutput=null, ports=[]`；对照 `delivery/web/ai-frontend` 的 `dev` = `vite`（无 0.0.0.0）。
- **回滚**：从组合态摘掉 quant 装载 slot；不触碰 khyquant 生产代码。
- **可逆性**：true。

### D8 —— suite 落点与包管理

- **口径**：方案 α —— `pnpm-workspace.yaml` 的 `packages` 加 `- apps/suite`（实测现 9 项、无 `apps/`）、根 `package.json` `workspaces` 同加；同批把 `BUILD-OUTPUTS.json` 的 `electron-out`/`electron-dist` 两条 `rebuild` 从 `pnpm run build --filter khyos-desktop` 修正为 `npm run build --prefix apps/khyos-desktop`；`apps/suite` 属 needs-registry-change ⇒ 须同改 `check-repo-layout.js` LAYERS `apps` 释义 + `[DESIGN-LAY-005] §1` 表，**并经人批准**。composer 归 suite 自有（`apps/suite/src/composer/`，本稿采纳 composer-suite-v2 §0.1 的理由：core 迁出 backend 后「src/composer 豁免」只剩一条理由，而跨 workspace 相对 import 会撞 cross-layer-require，实测 37 处零余量）。
- **回滚**：摘除 `apps/suite` 三处登记、删目录、`BUILD-OUTPUTS` 两条 rebuild 按 hunk 还原；lockfile importer 在有 pnpm 的机器再生。
- **可逆性**：true。

### D9 —— core 的运行时依赖

- **口径**：core **直接声明 `zod` 并精确锁版**（`dependencies.zod` 写死 `X.Y.Z`，无 `^`/`~`，实施期以 `pnpm add` 可得的最新稳定版固化），同批更新 `pnpm-lock.yaml`；加 conformance：**从 `packages/core` 包根 `require.resolve('zod')` 必须可解析**。拒绝 `semver`。
- **理由**：本轮七处 `require.resolve('zod')` 全部 NOT RESOLVABLE；`semver` 七处可解析而三处 `package.json` 均未声明（幻影依赖）。`pnpm-lock.yaml` 今日 zod 命中 0 行（v1/terminal-manifest-v2 一致读数）。
- **回滚**：`git checkout -- pnpm-lock.yaml`（按 hunk）；删 core 的 zod 依赖与 conformance 测试；全仓无生产代码 import zod（唯一文本命中是内置 skill 提示词示例，非可执行代码）。
- **可逆性**：true。

### D10 —— 编号与真源订正

- **口径**：总案 **219**（已入仓，保持）、CoreHandle **220**、终端清单 **221**、Suite **222**；**落盘前重测、被占顺延**（本轮 2026-11-17 实测 220–224 空闲）。折叠时一并订正：219 D2 行与 §10.3 机制 `ssot` 里的「219 终端清单」→ 221；`terminal-manifest.md:21` 的「下一可用编号 218」→ 221；`core-handle.md:142` 的 `"zod": "^3.24.0"` → 精确锁版；`core-handle.md:750` 的「`@khy/core` 入 G2」→「不并入 G2、版本归组人拍板」；`composer-suite.md:71/:185/:301/:369` 的 `check:core-layers --portable/--suite-fork` → `check-core-boundary.js`。**实施期步骤 6（人批留痕）**：`entries/entries.json:7` 的 `meta.ssot` 改指 `DESIGN-ARCH/` 子目录真实路径；`[DESIGN-ARCH-117]` 头注 :5「改端先改数据表」翻转为「改端先改终端清单 + 重跑生成器」，§四 schema 表同批；两处 `00_INDEX_*` 登记。
- **理由**：本轮实测 218/219 已占、220–224 空闲；`entries.json:7` 实测指向顶层不存在的路径（§0.2）。
- **回滚**：删新增三篇；`entries.json`/两个索引按 hunk 还原。
- **可逆性**：true。

### 1.1 十项之外的定稿口径（同样随终稿带走）

| 项 | 定稿 |
|---|---|
| 租约作用域（CS-1/CS-7） | 租约 = 「共享核心」的占用登记，**不是全局锁**：只在组合态/attached 共享核心（`mode:'composed-shared'`）生效；独立态 embedded **不创建、不竞争、不删除、默认不读**租约；**N 个独立态终端并存合法**；口号统一「**单窗口 + 组合态单 core 租约**」；租约条目带 `mode` 字段，owner 移交 = 退场后交接 + stale 接管，心跳 ≤10s / 有效期 ≤45s + `process.kill(pid,0)` 双条件 |
| 「统筹」的形态（CH-3） | core 的统筹 = **经事件面与能力面协调各终端**，不靠承接任务板/观测采样模块；`eventBus.js`+`eventLog.js` **本体**迁入 core，7 个写者只改调用面 |
| 生态通道（TM-5） | 取 (a)，与 D1 档 1 对齐；`plugin-sdk` 只分发两份 JSON 副本（**不声明 JS 子路径**，因为没有步骤产出 `index.js`） |
| 毕业样本键（CH-5/TM-2） | 两执行器统一 `counts.checks-run`（单次运行断言数，值恒为正、随覆盖面增长）；违规计数键（`counts.<finding-id>`）保留在 `--json` 里作**违规读数**，但不当样本键 —— 健康态恒 0，升 S2 时 PP-2 机械上必报 `samples-insufficient`；先例 `counts.domain-direction=199` 本轮实测就已 <200（§11.3 末条） |
| T1 无人值守子集（CS-3） | CI 只跑 headless 探针（`entry probe --json`，断言 `status=ready ∧ drift=null ∧ declaredStatus=status` 三条件）+ CLI 非交互（`--version`、`entry list --no-probe`）；web-quant 用登记产物 + `--host 127.0.0.1`；**mobile 移出无人值守清单**；GUI 端（desktop/provider-hub）只 probe |
| 例外载体（CS-6/CS-8） | `KNOWN-EXCEPTIONS.json`（新文件），不放 `ARCHITECTURE-POLICY.json` |
| 计量 schema（CS-4/CS-5） | 归 D4，schema v2 + **待并定价副本 3 份（+1 已委托消费点）** + jsonl 登记（与 `decisions-v2` D4 的「3 份」口径一致，见 §1.2 偏离 3） |
| 第三方最小示例（TM-7） | 终稿 §9.5 给目录树 + 清单 + 两条校验命令 + 7 步接入；标注「可执行验收待发布通道建成」 |

### 1.2 与 `decisions-v2` §1 的偏离登记（逐条声明，不做暗改）

> §1 的 D1–D10 以 `decisions-v2` §1 为基线；以下 **3 处**是本稿在真源之上做的明确修正，其余逐字一致。凡实施者看到本稿与 `decisions-v2` 字面不同，以本表为准，并据此同步 220/221/222 终稿。

| # | 偏离项 | decisions-v2 原文 | 本稿口径 | 为什么必须改（可复算理由） |
|---|---|---|---|---|
| 偏离 1 | 机制 `samples.source.key` | D3 写「`samples.source` 用 **`counts.<finding-id>` 标量**」 | 两个新执行器统一用 **`counts.checks-run`**；`counts.<finding-id>` 保留为违规读数键、不作样本键 | `check-rollout-stage.js:429-438` 在升 S2 时要求实测值 ≥ `GRADUATION_SAMPLES.S1=200`（`:90`）；健康态恒 0 的 finding 计数永远到不了 ⇒ 机制结构性毕不了业。既有先例 `counts.domain-direction=199`（本轮 B6 实测）今天就已 <200，正好证明该坑真实存在。详见 §11.3 末条 |
| 偏离 2 | 计量/租约的实例 id 字段名 | D4 写「落盘 schema 加 `writerId`/`bootId`」；219 D4 起用词为 `coreId`；`composer-suite-v2` §4.3 用「计量 `coreId` / 租约 `bootId` 两值同源」 | **统一取 `coreId`**：计量 `records[].coreId`、`meta.lastCoreId` 与租约条目都用同一字段名 `coreId`（`bootId` 不再作为别名出现） | 「两值同源但异名」会让机判退化成 `records.coreId === lease.bootId` 这种跨名比较，任一侧改名即静默失配。统一为 `coreId` 后，证③ = `records[].coreId` 与租约 `coreId` 直接比对，机判可定义。落盘时 220 §4.2（`CoreLockRecord`）与 222 §2.2（租约 schema）同步改名 |
| 偏离 3 | D4 的「定价副本几份」 | D4 写「**定价副本 3 份**（ai-backend、`usageTracker.js`、khyquant）收敛到叶子」 | 表述改为「**待并副本 3 份 + 1 处已委托消费点**（backend `tokenUsageService.js` 已 require 叶子）= 4 个引用点」 | 只是措辞澄清：backend 那份已是叶子消费方、不是待并副本；写成「4 份」会让人去找一张不存在的第四张表。收敛目标不变（全仓只剩 `tokenPricing.js` 一处定价真源） |

---

## 2 未闭合项收口表（评审 21 条逐条；closed / deferred）

> 本 ask 材料给了 **21 条**（CH-1…CH-6 = 6、TM-1…TM-7 = 7、CS-1…CS-8 = 8），任务书写「12 条」——**以材料为准，21 条逐条收口**，不省略任何一条。
> `closed` = 设计口径已定死且写进本稿（**不等于生产代码已改**）；`deferred` = 本轮明确延后，给理由 + 承接步骤。

| ID | 一句话问题 | 判定 | 收口落点（本稿）/ 承接步骤 | 证据 |
|---|---|---|---|---|
| **CH-1** | `resolveEmbedded()` 设计在 `./client/locator.js`，需 `path/fs/require.resolve`，与「client 零 `node:`」正面冲突 | **closed** | §4.3 防线子档 A + §5 摘要第 2 条：接口留 `./client`，Node-only 定位器移显式 `./locator-host`；browser-safety 测试扫 `src/contracts/**`+`src/client/**`，Node 测试另扫 `locator-host` | core-handle-v2 §4.0/§13.3 子档 A/R18；§0.1 本轮实测 `packages/core` ABSENT（冲突仍在设计层） |
| **CH-2** | `KHY_CORE_*` 真源放 `client/coreEnv.js` 后 backend「反向 re-export」无可执行说明符（深导入被封闭 exports 拒、跨层相对 require 零余量） | **closed** | §5 摘要第 3 条：真源 = 已 exports 的 `@khy/core/contracts/core-env`；backend 只从该子路径 require；`readCoreEnv()` 首行 `typeof process` 守卫；`check-agent-rules.js:621-622` 白名单**同批改（S1 必做）** | core-handle-v2 §2.2/§4.1/R19；本轮实测 `isSourceOfTruth` 只认两个后缀 |
| **CH-3** | 「coordinator/tasks/observability 本体也在 core 职责内、随 S5 搬」扩大 core 职责、与 §13.1 互斥 | **closed** | §4.2 职责边界点名式（黑名单四模块 + eventBus/eventLog 显式列为例外）；§5 摘要第 6 条：7 个写者只改调用面 | core-handle-v2 §6.1/§13.1/R20；`decisions-v2` D1 ④ |
| **CH-4** | `resolveEmbedded` 只认 `node_modules/@khy/core`，与档 2 发行包 `bundled/` 交付矛盾，且「不得新增构建产物」堵死再造入口 | **closed** | §5 摘要第 4 条 + §8：四段定位顺序；**不新增 core 的构建产物**。机判写成：`git diff BUILD-OUTPUTS.json` **只允许 D8 的三处**（`electron-out`/`electron-dist` 两条 rebuild 修正 + 新增 `suite-shell`），**不得出现任何 core 相关条目**；`git diff --stat entries/` 不得出现 core 产物目录 | core-handle-v2 §8#1/R21；本轮实测 `works/ship/npm` files 含 `bundled/`、无 `node_modules/@khy/core` 语义 |
| **CH-5** | 机制 `samples.source.key="findings"` 是数组，`pickKey` 判「不是标量读数」，完整档真跑必翻红 | **closed** | §11.3：改**标量**键 —— 两个新执行器统一用 `counts.checks-run`（违规计数键保留但不当样本键，理由见 §11.3 末条）；`--json` 的 counts 键名全列 | 本轮逐行亲测 `check-rollout-stage.js:157-168`（:165-167 拒 object）、`:90`、`:429-438`；40 条机制中 3 条先例 key 全为 `counts.*`（本轮解析实测） |
| **CH-6** | 「不要寄生 `check-core-layers.js`（实跑 exit 1 且 authority-drift）」 | **closed**（复核已判 already-fixed，本稿保持措辞） | §11.1 独立执行器；§12 把 B1/B2 的红列为施工前置；**残留清理**：`composer-suite.md:71/:185/:301/:369` 旧文案在折叠 222 时统一改写（承接：§10 A5 终稿落盘 + 222 落盘） | 本轮 B1 exit 1 + B2 authority-drift + `check-core-layers.js` 无 GUARD_STAGE（node 复读） |
| **TM-1** | 「`entries/` 不在 facts 语料里」与实测相反 | **closed** | §6.3：`entries/` **在** `scan.include`（数组共 8 项，`entries/` 是**第 7 项**；`DATA-SSOT.json:14` 是文件行号，勿混用），不报红的真因是 11 条 fact 无一锚定 entries、影子扫描逐条 fact 走 `detect.identifiers`，无 matcher 即 `continue` | 本轮 `DATA-SSOT.json` include 数组实测（8 项）+ `ssotDataGuard.js:615-617` |
| **TM-2** | `terminal-manifest-guard` 的 key 与 counts 契约不可指向 | **closed（并修正原修法）** | §6.4 / §11.3：改 `counts.checks-run`（单次运行断言数，算式写进 221 §5.2）。**注意**：评审建议的 `counts.<finding-id>` 对本机制**不可用** —— `entry-matrix-stale` 目标只有一个文件、健康态恒 0，结构上限 1，永远够不到 `GRADUATION_SAMPLES.S1=200` ⇒ 那样 S1→S2 机械上不可达。`--json` 的 21 个键（20 finding + `checks-run`）全列 | `terminal-manifest-v2` §0.0-X1/§5.2/§5.3；本轮复读 `check-rollout-stage.js:90` = `{S1:200,S2:50,S3:20}`、`:429-438` 按实测值判 |
| **TM-3** | 全篇按「下一可用编号 218」写，而 218/219 已占 | **closed** | §1 D10 + §12：规范篇 = **221**（本轮实测 220–224 空闲）；落盘前重测、被占顺延 | 本轮 DESIGN-ARCH 编号实测（214 篇 / max 219 / 220–224 FREE） |
| **TM-4** | `entries.json:7` 的 `ssot` 指针失实、`[DESIGN-ARCH-117]` 头注与 A 方案相反 | **closed（设计层）/ deferred（实施层）** | 设计侧写进 §6.5 步骤 6；**仓内文件本轮一字未改**（只读边界）⇒ 实施期人批留痕执行 | 本轮实测 `entries.json:7` 原文指向顶层不存在路径；`[DESIGN-ARCH-117]:5` 原文「改端先改数据表」（terminal-manifest-v2 R4 引用） |
| **TM-5** | 分发通道三选一未定 | **closed（决定已下）/ deferred（通道未建）** | 取 **(a)**：`plugin-sdk` 补 `files`/`exports`/`publishConfig` 与 `@khy/core` 同批 npm 发布（§8.1 档 1 验收）；副本只两份 JSON、不声明 JS 子路径。**deferred 理由**：本机无 pnpm/corepack + 本轮禁止改包与发布 ⇒ 验收命令今天不可执行；**承接**：B7/S7 步在有 pnpm 的机器跑 `npm pack` → 空目录 install → `check-manifests --loose --root` | 本轮实测 `plugin-sdk/package.json` 七键（无 files/exports/publishConfig）、`works/ship/modules/modules.json` 不含 plugin-sdk、`where pnpm/corepack` 未找到（v1 M18） |
| **TM-6** | 规则棘轮 101/94 越界；S1 不新增规则 ID | **closed** | §11.1–§11.4：机制 `rules: []`；`LAYOUT-009`/`LAYOUT-010`/`TOOLING-013`/`PROCESS-015` 四张草案**明确标注「毕业期（S3）第二层，不随 S1 落地」**，防实施期误当 S1 交付 | 本轮 B3 `ruleCount=101/94`；`RULES-REGISTRY` LAYOUT 只到 008 |
| **TM-7** | 第三方接入只有原则、无可照抄示例 | **closed（设计层）** | §8.2 给目录树（6 行）+ 清单要点 + 两条校验命令 + 7 步接入；「可执行验收待 TM-5 通道建成」随文标注 | `terminal-manifest-v2` §9.5（R7） |
| **CS-1** | 租约把独立态互斥化（高危：与产品意图 2 相抵） | **closed** | §7.1 规则 L1–L9：租约只在 `composed-shared` 生效；独立态不创建/不竞争/不删除、默认不读；N 个独立态并存合法（R1–R4）；`mode` 字段 + owner 移交/过期语义；机判 a1–a5 | 本轮实测两把锁互不相干：`main/index.ts:121` Electron 单实例锁 vs `daemonManager.js:19` `daemon.pid`；`dual-facts.json` blockers #6（daemon 与桌面 host 两进程族共享 sessions.db ⇒ 并存是今天的事实） |
| **CS-2** | 子档寄生 `check-core-layers.js` | **closed**（总案已修；残留见 CH-6 末） | §11.1 + §12；折叠 222 时改写 composer-suite §1.3/§4.1/§9-T1/§12 | 本轮 B1/B2 实跑 |
| **CS-3** | T1 的「非 GUI 子集」三端不可无人值守 | **closed** | §9.2 组合态/独立态两行的命令改为：`entry probe --json` + `--version` + `entry list --no-probe` + 产物按 BUILD-OUTPUTS 的 `path`/`legacyPath` 解析 + web-quant 不启 dev server + **mobile 移出清单**。**本轮实跑再加一条硬修正**：`entry probe` 的 `drift` 是**单向**的 —— 实测 `desktop-provider-hub` 声明 `degraded`、探测 `ready` 而 `drift` 仍 `null`，故 T1 断言必须写成 `status==='ready' && drift===null && declaredStatus===status`，只判 `drift===null` 会漏掉反向漂移 | 本稿会话实跑三条命令（§9.1 首行）；launch 形态本轮实测（cli/cli-node/mobile = attach、web-quant = `npm` detach 且 dev 脚本 `0.0.0.0 --open`）；composer-suite-v2 F18 同向读数 |
| **CS-4** | 三证③的 `bootId` 断言无数据面可读（本稿字段名统一为 `coreId`，见 §1.2 偏离 2） | **closed** | §7.3 证③按形态判定 + §4/D4 的 schema v2（`schemaVersion`/`meta.lastWriterId`/`lastCoreId`/`records[]` 环形 500）与 DATA-SSOT/DATA-LOCATIONS 登记动作；**schema 落地前保持报 `metering-dual-writer`** | 本轮实测 `token_usage.json` 顶层仅 `daily`/`monthlyTotals`、全文无 bootId/coreId/writerId/records；`DATA-SSOT`/`DATA-LOCATIONS` 均无 `token_usage` |
| **CS-5** | `usageTracker` 的第三份 `PRICING` 与 jsonl 路径三稿沉默 | **closed** | §4.4：**待并定价副本 3 份**（ai-backend + khyquant + usageTracker）+ 1 处已委托消费点（backend）；键域不同（provider 键 vs model 键）⇒ 叶子加 `MODEL_PRICING` + `calculateModelCost` 逐字迁移；jsonl 启用前登记 DATA-LOCATIONS，未启用进 KNOWN-EXCEPTIONS 休眠写者条目 | 本轮复读 `usageTracker.js:30-41/:49-59/:329-338/:342/:177-182` 与 `runtime/node/backend/src/services/tokenPricing.js:37`（`USD_TO_CNY=7.25`） |
| **CS-6** | 「已知例外」无机读载体 | **closed** | §7.5 + §12：新立 `KNOWN-EXCEPTIONS.json`（`id/target/owner/reason/expiry/reverify`）+ 消费者 `check-core-boundary.js --lan`；表与消费者未同批落地前 T6 不判绿 | 本轮 `fs.existsSync` 实测 ABSENT；`ARCHITECTURE-POLICY.json` 的 `exceptions` 实测 `[]` 且 `check-zcode-baseline.js` 0 处引用 |
| **CS-7** | 口号缺「组合态」限定词 | **closed** | §7.2 口号「单窗口 + 组合态单 core 租约」；进程事实表（main/preload/renderer/host 四边界）；**行号本轮重取**：fork 在 `main/index.ts:799`（第二处 scheduler `:827`），不是旧稿的 `:776-786` | 本轮 node 复读 `main/index.ts`/`host/index.ts`（§0.2） |
| **CS-8** | D6 拍板方向与评审修法不一致（改 ai-backend 既有对外行为） | **closed（口径已按评审收窄）** | §7.5：suite 侧注入只覆盖自己拉起的 listener；ai-backend `0.0.0.0` 保留 + 机读登记；LAN 显式 opt-in；**不改默认值**，人批范围相应缩小。owner/expiry 两值仍 deferred（见下行） | 本轮 `ai-backend/server.js:124-138` 逐行复读（env 优先级最高）；`serviceDefaults.js:313-314` |
| CS-6/CS-8 附带 | `KNOWN-EXCEPTIONS` 条目的 `owner` 与 `expiry` 取值 | **deferred** | 理由：AI 无权替 owner 定期限。承接：§16-4，人给值后随 T6 消费者同批落表 | 219 §12 风险 9 同旨 |

**统计**：表体共 **22 行** = 21 条编号项（CH-1…CS-8，**全部 closed**；其中 TM-4、TM-5、TM-7 标「设计层 closed」、CS-3 的无人值守改造与 CH-6 的 222 折叠另挂实施承接步）+ 1 行**纯 deferred**（`KNOWN-EXCEPTIONS` 的 owner/expiry）。**没有一条是被丢弃的。**

---

## 3 现状校准（保留 v1 差异表 + 修正；编辑层残留清理）

### 3.1 v1 编辑层残留的清理项（本轮逐条落实）

| 残留 | v1 现场 | v2 处理 |
|---|---|---|
| **表头** | §0 表头写「本会话 M1–M17」，实际列到 **M24** | 本稿 §0 表头改「本轮 B1–B9 + §0.1/§0.2/§0.3」，并按「命令 / 读数 / 是否易漂」三列重排 |
| **行序** | §2 差异表行序 1–12 后跳 **15、13、14**（D1/D15 错位） | §3.2 按 1…16 连续编号，并把「core 可轻量发布」（旧 #15）插在 #9「重量守卫失明」之后（同属体量主题） |
| **重复列举** | 「`@khy-os/*` 三处」在 §2#6 与 §4 各列一遍；`build.files` 三条在 §8.1/M20/§12-3 三处重复；「1471 模块 / 521377 行」在 §1 D1、§2#15、§7、§8.1、§12-3 五处重复 | 本稿把「1471 模块 / 521377 行」收敛为 **§3.2 #15 一处**（标 v1 M19 出处），其余处引该行号；`build.files` 只在 §0.2 与 §8.3 各出现一次（后者是未决项说明）；`@khy-os/*` 只在 §3.2 #6 出现一次 |
| **`check:core-boundary` 别名** | §11 把 `npm run check:core-boundary` 列为「存在性 = Absent（M7）」，但 §3.2/§10.1/§14.1 直接当既有门写 | §12 表里逐行列「今天是否存在 + 谁新增」，六个新别名本轮实测均 ABSENT（§0.1），文档一律标注 **（本次新增）** |
| **`verdicts` 路径层级** | §1 D8/§3.1 引用 `layout-facts verdicts` 时按「目录」直引（`packages/core`、`apps/suite`），未说明 verdicts 是**方案原文路径**而非仓库真实路径 | §3.3 重排 verdicts 表，明确「`proposed` = 方案原文路径；`verdict` 针对的是『在顶层按原名新建』这件事」，并给出落点换算 |
| **facts 读数失真** | `assets-facts.json:165` 称 lockfile「9 个 importer 与 9 包一一对应」 | §0.2 实测 **7 importer / 9 包**，`ui-shared`、`plugin-sdk`、`khy-markdown` 三个 importer 缺失 —— 以本稿为准（core-handle-v2 V10 同向） |
| **行号漂移** | `main/index.ts` 的 fork 旧稿写 `:786`/`:776-786`；`serviceDefaults` 的 `AI_MGMT_HOST` 旧稿写 `:302` | 本轮重取：fork **`:799`**（scheduler fork `:827`）、锁 **`:121`**、`AI_MGMT_HOST` **`:314`**（注释 `:313`）。§0.2 落表；所有行号引证标「当日实测、实施前重取」 |

### 3.2 方案原文假设 vs 仓库实测（连续编号，含 v1 全部 15 行并修正）

> 「实测」列引 §0 的 B1–B9（或 §0.2 的结构读数），或 facts 的路径:行号。

| # | 方案原文假设 | 仓库实测 | 对施工的影响 |
|---|---|---|---|
| 1 | 顶层有 `services/` | ABSENT（§0.2 verdicts[11]=duplicate）；真实落点 `runtime/node`（L2，`check-repo-layout.js:114`） | 方案里 `services/backend/src/...` 一律换成 `runtime/node/backend/src/...` |
| 2 | 顶层有 `kernel/ platform/ software/ tools/ extensions/` | 五项全 ABSENT（verdicts[12]/[13]/[14]/[15]/[10]）；真实落点 `runtime/boot/kernel`(L0 :112)、`runtime/substrate/platform`(L1 :113)、`delivery/channel`(L4 :116)、`delivery/extension`(L5 :117)、`delivery/extension/tools`(L6 :118) | 重建任一旧名 = `layer-registry` error（本轮实测该 finding 已 7 条）。**本任务明令不动 L0/L1/L4 既有定位，本稿对它们零动作** |
| 3 | 顶层有 `packages/` | `packages` ABSENT 且从未存在（verdicts[0] = `packages/core` needs-registry-change）；共享包真实落点 `runtime/substrate/platform/packages/*`（本轮实测 4 包） | core 只能落 substrate 下的 `packages/core`（D1），不新建顶层 |
| 4 | `apps/{cli,ai-frontend,electron,flutter-android,provider-hub}` | `apps/` 实测只有 `khyos-desktop`；verdicts[4]/[5]/[7]/[8] = duplicate、**verdicts[6] `apps/electron` = illegal**（Q10 2026-10-02 退役） | 五条假设全落空；拆分不搬终端物理位置，改用清单 + 装配 |
| 5 | 新引入 terminals 清单即端矩阵 | `entries/entries.json` 已是单一真源（本轮 7 条实测），且**目前无任何 CI 强制**（v1 M15：`git grep entries/entries.json` 于 scripts/ci、scripts/ruleguard、.github/workflows 0 命中）；verdicts[16] 的 duplicate 判定前提是「entries.json 仍为手写真源」 | 走 A 方案（清单真源 + 投影生成物 + 校验器锁步），顺带补 CI 强制缺口；翻转理由须在 221 正文显式记录（D2 rollback 同旨） |
| 6 | 统一到 `@khy-os/*` 作用域 | `@khy/*` 是 workspace 三包；`@khy-os/*` 只三处：`works/ship/npm/package.json:2`、backend 的可选 peer `@khy-os/khy-chain`（仓内无此包）、根 `install:mobile --filter @khy-os/mobile-companion`（成员不在 workspace） | core 沿用 `@khy/core`（core-handle-v2 §2.1） |
| 7 | 版本「两条/三条真源」 | **三轨道 10 源**，本轮 B5 实跑 G1 1.2.2 / G2 1.6.5 / G3 0.1.0 exit 0；G2 = ai-backend + `@khy/shared` + `@khy/plugin-sdk`（组内字节一致、跨两个根） | **D1：不并入 G2、不改 10 源、不改 AGENTS 版本节**；旧稿「入 G2」措辞作废 |
| 8 | 规则可自由新增 | 本轮 B3：`ruleCount=101/94` 越界；命令/别名/handler 三项同步越界 | 走 D3：S1 不新增规则 ID，机制 `rules: []` |
| 9 | 「core 有重量守卫兜底」 | `check-core-layers.js` 对新 core 失明（`:151` 文件宇宙 = backend/src+bin；`:185` 非 `.` 开头说明符 `continue`；`:213-223 coldClosure()` 对不在宇宙的 root 返回空集；`:339` perRoot 只 `existsSync`）；本轮 B1 实测它自己 exit 1 | 给它加 perRoot 预算 = 恒 0 绿灯；闭包判据改由新守卫的测试代防（§4.3 #3/#4） |
| 10 | 「只有一个核心进程」 | Electron main（锁 `:121`）+ preload + renderer + **fork 的 host 子进程（`:799`）**；host 内 20 处 `nodeRequire` 加载 backend 模块；另有 daemon（`daemonManager.js:19`）与 aiManagementServer 可并存 | 口号「单窗口 + 组合态单 core 租约（锁 + epoch）」；进程边界保留 = 单写者前提（§7.2） |
| 11 | 已有 `check:manifests` 这道门 | 本轮实测六个新别名全 ABSENT；相近但无关的是 `check:manifest-sync`（管 `MANIFEST.in`）与 `rules:manifest` | 属本次新增，不得在文档/CI 写成既有门 |
| 12 | 「domain-direction 能守住 core 的依赖方向」 | `check-repo-layout.js:1617` 扫描 = `git grep -E "require\(['\"]\."`（只认相对 require）；本轮 B6：domain-direction 199 = 基线 199、cross-layer-require 37 = 37 ⇒ **零余量** | 新判据必须自己匹配三形态（require / import / 裸包名 / `path.join` 分段 / 模板串）；新增跨域边直接升 error |
| 13 | 「新文件随便加，门不会响」 | 本轮 B6：entry-buffer **2416 / 基线 2470（余量 54）**；判据 = 只扫 `.js/.cjs/.mjs`（`.ts/.d.ts` 不扫）+ 每个被扫源文件须有同名同目录 `*.test.js` + 治理 `khy.module.json` + 单元 README | `runtime/substrate/platform/packages/**` 已在扫描面内 ⇒ core 的**合规三件套**必须 S1 同批交齐（1 份 D1 manifest + 1 份 README + 每 `.js` 同目录测试），否则 1:1 加读数、超 2470 升 error |
| 14 | 工作区可就地开工 | 本轮 B3：改动集 772 项（`??` 346、`D` 9）；`git status -uno` 计数 426；分支 `feat/thinking-fold-20261103`（HEAD `4424c00d`）；`git fsck` 缺 22 对象（B3 的 `delivery-repo-integrity`）⇒ `git gc` 不可用 | **施工第一步不是写代码，是人收口工作区**（`PROCESS-001`，AI 不代做）；不收口则 D3 永远 GAP、回滚无法界定本刀范围 |
| 15 | 「core 可轻量发布给第三方」 | 网关沿相对 require 的传递闭包 **1471 模块 / 521377 行**（v1 M19 自写遍历；`dual-facts.json` feasibility 记 1478/523360，同量级），裸模块含 `fs/child_process/net/dns/worker_threads/vm`，三方含 sequelize/pg/express/winston/undici/yjs | 生态态 v1 只承诺 **attached**（档 1）；embedded 全量随官方发行包（档 2）；「npm i 即 embedded」必须等 B8 切分，**不得用 fake adapter 自证可达** |
| 16 | 「端矩阵 launch 可直接进 CI 无人值守」 | 本轮实测 `cli`/`cli-node`/`mobile` 的 `launch.default.mode = "attach"`（交互/需设备），`web-quant` 的 dev = `vite --host 0.0.0.0 --open` | T1 的无人值守子集改为 headless 探针 + 非交互子命令 + 登记产物；mobile 移出清单（CS-3，§9.2） |

### 3.3 `layout-facts.json` verdicts 重排（`proposed` 是方案原文路径，非仓库路径）

| verdicts[i] | proposed（方案原文） | verdict | 本重构的真实落点 / 动作 |
|---|---|---|---|
| [0] | `packages/core` | needs-registry-change | 改落 `runtime/substrate/platform/packages/core`（L1 键已覆盖 ⇒ **不**触发 layer-registry；只需 WORKSPACE_ROOTS + workspace + importer 登记） |
| [1] | `packages/composer` | needs-registry-change | 改落 `apps/suite/src/composer/`（D8/§7；suite 已在 [9] 的批准面内） |
| [2] | `packages/plugin-sdk` | duplicate | 已存在 `runtime/substrate/platform/packages/plugin-sdk`（本轮实测无发布面三字段）→ **补发布面**（D1 通道 (a)） |
| [3] | `packages/shared` | duplicate | 已存在，`private:true` ⇒ **core 不得依赖它** |
| [4] | `apps/cli` | duplicate | CLI 真源 = `runtime/substrate/platform/khy_platform` + `runtime/node/backend/bin/khy.js` |
| [5] | `apps/ai-frontend` | duplicate | `delivery/web/ai-frontend` |
| [6] | `apps/electron` | **illegal** | 不复活；桌面唯一产物线 `apps/khyos-desktop` |
| [7] | `apps/flutter-android` | duplicate | `delivery/mobile/khy-os-client-app`；**不在 coupling-facts scan.roots** ⇒ 其耦合读数是「未扫」不是「无耦合」（C 阶段前置） |
| [8] | `apps/provider-hub` | duplicate | `delivery/web/provider-hub` |
| [9] | `apps/suite` | needs-registry-change | 新建（D8）：须同改 LAYERS `apps` 释义 + `[DESIGN-LAY-005] §1`，**经人批准** |
| [10]–[15] | `extensions/ services/ kernel/ platform/ software/ tools/` | duplicate | 方案 P 旧名，一律换算（本表 #1/#2 行） |
| [16] | `apps/*/khy.terminal.json` | duplicate | 前提是 `entries.json` 仍为手写真源；A 方案后前提消解 ⇒ 221 正文须显式记录翻转理由 |

---

## 4 目标结构：一核心 + 多终端在 L0–L6 的落点

### 4.1 落点表（层 = `check-repo-layout.js:111-121` 名册）

| 构件 | 真实落点 | 层/域 | 动作 | 同批要改的登记/接线件 | 批准人 |
|---|---|---|---|---|---|
| `@khy/core` | `runtime/substrate/platform/packages/core` | L1（D1 roots 已覆盖） | **新建 workspace 包**（本轮 ABSENT） | `pnpm-workspace.yaml`（现 9 项）+ 根 `workspaces` + overrides；`pnpm-lock.yaml` importer（现 7 个）；`check-repo-layout.js:310-322` WORKSPACE_ROOTS（现 11 条，**顺带补 `ui-shared`/`plugin-sdk` 两个存量缺口**）；backend `dependencies["@khy/core"]="workspace:*"` + overrides 同名（双件套，沿 plugin-sdk 先例）；`apps/khyos-desktop/package.json` 的 `file:` 声明；`check-agent-rules.js:621-622` 白名单；`FEATURE-OWNERSHIP` 机制；`API-SURFACE` 14 个错误码 + `COMMS-001.exec.findings`（现 0 项）；`DATA-LOCATIONS`/`DATA-SSOT`（`core.lock`/`locator.json`/计量） | 人（`LAYOUT-005`/`LAYOUT-007`/`LAYOUT-008`）；**不改** `DOMAIN-DEPS`、`check-version-sync`、AGENTS |
| core 合规三件套 | 同上包根 + 每 `.js` 旁测试 | — | 与包同 PR | 1 份 `khy.module.json`（domain=**D1**、lifecycle.stage=staged、整数 fanIn）+ 1 份 README + 每源文件同名测试 | — |
| 终端清单 ×7 | 各端 source 根（platform / backend / desktop / provider-hub / ai-frontend / khyquant frontend / mobile） | L1/L2/L3/L4 | 新建（A 方案） | `TERMINAL-MANIFEST.schema.json` + `CAPABILITY-VOCAB.json` + plugin-sdk 分发副本目录；`DATA-SSOT.sources[]` + 两条 fact + mirrors | 人 |
| 端矩阵投影 | `entries/entries.json` | 横切（CROSSCUTTING.entries） | 降为生成物 | `gen-entry-matrix.js` + `check-manifests.js` + pr-gate 步骤 | — |
| composer | `apps/suite/src/composer/`（纯库四函数） | L3 | 新建（随 suite） | 随 `apps/suite` 一次批准 | 人 |
| suite 壳 | `apps/suite/` | L3 | 新建（D8） | `pnpm-workspace.yaml` + 根 workspaces + LAYERS `apps` 释义 + `[DESIGN-LAY-005] §1` 表 + `BUILD-OUTPUTS` 新条目 `suite-shell → entries/suite`（**登记先行于首个构建**） | 人（`LAYOUT-005`） |
| `runtime/boot/kernel`(L0)、`runtime/substrate/platform`(L1 既有四包)、`delivery/channel`(L4，khyquant 独立项目) | — | — | **不动其定位**（任务书硬约束） | — | — |

### 4.2 core 职责边界（点名式，CH-3 的机判基准）

- **负责**（产品意图 1 的七项 + 三件基础设施）：能力注册与发现、事件、配置、会话与计量、AI 网关（唯一出口）、插件生命周期、锁与 epoch、路径解析（`CorePaths` 下发）。
- **不做**：终端 UI（TUI/`src/cli`、desktop renderer、两个 Vue 前端）；终端专属业务（pty、KeyManager 的 masking/reveal/审计 UX、设备车道 amoon/amoo/agentbus、khyquant 交易业务）；**任务编排与任务板的模块本体**（`coordinator/processAgent.js`、`coordinator/taskBoard.js`、`tasks/largeTaskRuntimeStore.js`）与**观测采样的模块本体**（`observability/{cpuProfiler,eventLoopMonitor,slowRequest}.js`）；仓库私有件（`works/`、`scripts/`、`docs/`、`entries/` 数据）。
- **显式例外（不属「不做」）**：`observability/eventBus.js` 与 `observability/eventLog.js` 的**本体**迁入 core —— 它们是事件面本体，不是观测采样，也不在黑名单里。
- **「统筹」的定义**：core 的统筹 = 经事件与能力面协调各终端，**不靠搬运任务板/采样模块实现**。

### 4.3 机判防线（执行器 = 新增 `scripts/ci/check-core-boundary.js`，S1 恒 exit 0）

| # | finding | 判据（形态匹配必须覆盖：相对 `require(` / `import … from` / 裸包名 / `path.join` 分段 / 模板串） |
|---|---|---|
| 1 | `core-boundary-import` | `packages/core/**` 引用 `runtime/node/backend`、`apps/`、`delivery/`、`works/`、`scripts/`、`docs/`、`entries/`；迁移期白名单只允许经 `@khy/core/contracts/core-env` 的 backend 消费面 |
| 2 | `terminal-direct-gateway-import` | `apps/**`、`delivery/**`、`runtime/node/ai-backend/**` 对 `services/gateway/aiGateway` 的引用；基线棘轮只降不升。**基线**：真实入站 7 处 / 6 文件（khyquant 6 处死引用 `tools/{imageDetect:169,imageOcr:101,160,recognizeImage:84,videoAnalyze:292}` + `services/strategyRecommender:259`、desktop `host/index.ts:126` 动态形态）；**不计入**：ai-backend 3 处自包引用（第二套网关，例外登记面）、`diagnose-gateway.bat:48`（非边扩展名）、文档 8 行 |
| 3 | `core-not-in-entry-closure` | `bin/khy.js` 与三个 L1 根的**冷闭包（仅顶层边）**内不得出现 `packages/core/**`（含裸包名边）。必须写明「冷」——按传递闭包读会与产品意图 2（终端只带 core 运行）永久互斥；本条**仅迁移期有效**，网关进 core 后退役/改写（§16-9）。闭包遍历自写（`scripts/lib/requireGraph.js` 不提供传递闭包） |
| 4 | `core-skin-into-server` | `packages/core/src/**` 出现 `node-pty`、`ink`、`readline`、`@khy/ui-shared`、`*Page.js` 模板资产、`document.`/`window.`；**并**出现 §4.2 黑名单四模块的路径或同名文件 |
| 子档 A | `core-client-node-free` | `src/contracts/**`+`src/client/**` 0 处 `node:`、0 处未守卫 `process.env.`；`src/locator-host.js` 是唯一允许 `node:` 的源文件且**必须至少 require 一个**（防退化成空壳）；contracts/client 内不得出现 `locator-host` 字面量 |
| 子档 B | `core-env-single-source` | `KHY_CORE_*` 键名/默认值只在 `contracts/core-env.js`；backend 内出现上跳 core 的相对路径 → warning |
| 子档 `--portable` | `core-private-path` / `core-carries-composer` / `core-dynamic-private-require` | 可携断言 + 动态 require 文本兜底 |
| 子档 `--suite-fork` | `suite-forks-terminal` / `suite-deps-core-pkg` / `terminal-imports-suite` / `suite-bundle-leak` / `suite-dynamic-require` / `suite-runtime-fork` | 不 fork/复制终端（R5 文本兜底、R6 `require.cache` 交叉验证为必配） |
| 子档 `--lan` | `known-exception-applied` / `-expired` / `-unverifiable` / `unknown-listener` | 读 `KNOWN-EXCEPTIONS.json`（§7.5） |
| 子档 metering | `metering-dual-writer` / `metering-second-core` / `metering-unknown-writer` | §7.3 证③的形态化判定 |
| 子档 C | `terminal-cross-reference` | 产品意图 5：终端之间不直接引用（另一端源码目录/其 workspace 包名/其产物路径），只经 CoreHandle 消费能力；基线 = S1 首跑实测值，只降不升 |

**边界声明**：以上 finding 全部 `severity:'warning'`、S1 恒 exit 0；「不点对点通信」由契约测试兜底（子档 C 只判静态引用）。

---

## 5 CoreHandle 摘要（全文 = 220 / `core-handle-v2.md`，逐节指针）

> 本节只锁口径，不复制全文。§号指向 `core-handle-v2.md`。

1. **包与导出面**（§2.2）：`@khy/core`，`type: commonjs`，exports 封闭七条（`.`/`contracts`/`contracts/core-env`/`client`/`locator-host`/`server`/`package.json`）+ `types` 条件；深导入 = `ERR_PACKAGE_PATH_NOT_EXPORTED`；**不引编译步骤**（JSDoc `.js` + 手写 `.d.ts`，与 `@khy/plugin-sdk` 同型 —— 本仓唯一可照抄先例）；不用 `browser` 条件导出（本包同时被 CJS/electron-vite/vite 解析，子路径是物理隔离）。
2. **双入口**（§4.0/§4.1）：`obtainCore()`（`./client`）**只 attach**，零 `node:`，不读文件、不 spawn，签名不含 `mode/bundledEntry/allowSpawn`；`obtainCoreNode()`（`./locator-host`）是 `auto|embedded` 的唯一入口，负责 locator 文件读取、四段定位、进程内起 core。**反向边禁令**：contracts/client 内不得出现 `locator-host` 字面量。
3. **环境变量纪律**（§4.1 末段）：真源 `contracts/core-env.js`（零副作用：`CORE_ENV_KEYS` 常量 + `readCoreEnv()`）；`readCoreEnv()` 首行 `typeof process === 'undefined'` 守卫 = 唯一守卫式豁免；backend 只 `require('@khy/core/contracts/core-env')`，**禁止跨层相对上跳与深导入**；`check-agent-rules.js:621-622` 白名单**同批改**（S1 必做，非条件句）。仲裁顺序：用户显式 env > suite 注入 > 默认。
4. **定位顺序（CH-4）**：① 显式注入（路径或已加载模块对象）→ ② 宿主传入的 bundled 入口（档 2 发行包既有 `bundled/` 面）→ ③ `node_modules/@khy/core` → ④ `CORE_LOCATOR_FAILED` 诚实报错。**不新增构建产物**。
5. **单实例锁 + fencing**（§4.2）：`fs.openSync(...,'wx')` 独占创建（不用 flock：Node 无内建、Windows 无该语义；探活先例 = `daemonManager.js:19` `PID_FILE` + `:94` `process.kill(pid, 0)`，本轮亲测）；心跳 10s 且**带 fencing**（`lock.coreId !== self.coreId` 即不重写、降级 attach + `CORE_TAKEN_OVER`）；stale = `!isAlive(pid)` 或心跳 >**30s**，**二次确认**后才接管；**两把锁的阈值不许混用**：`core.lock`（本条的 embedded 单实例锁）= **30s**（+ 二次确认）；`core-instance.json`（§7.1 的共享核心租约）= **45s**（= 3×心跳周期）。两者是不同文件、不同职责，机判各按自己那一份阈值，不许拿一个去判另一个；接管把旧锁改名隔离到 `core.lock.stale.<ts>`（不删除，`LAYOUT-004`），`epoch+1`；写 locator/计量前必比对 epoch。
6. **事件面**（§6.1）：`CoreEvent` 形状沿用 `eventLog.js:24`（不造第四套方言）；`seq` 改为核心级持久单调（现状 `:34-35` 进程内 `let _seq = 0`）；`eventBus.js`+`eventLog.js` **本体迁入**；7 个写者（C9 清单，含 `usageTracker.js:177`）只改调用面（迁移期 backend 侧门面 re-export，S5 改 `coreEvents.publish()`）；**替换 fail-soft**（现状 `eventBus.js:43-53` 吞订阅者异常）为有界队列 + 逐订阅者失败计数 + 溢出即 `event.gap`；投递语义 at-least-once + `event.id` 幂等。
7. **会话与数据家**（§6.2/§6.3）：单写者 = core；`sessions.db` 触库清单 6 项（persistence/searchIndex/groupService/dbHealth/restoreService+sqliteHotCopy/backupAssetPlan）；备份还原与 core 持锁句柄**互斥**（还原前 `close()`、期间拒绝新 attach、完成后重发 `core.ready`）；六条路径解析链归一为 `CorePaths` 一条。
8. **失败与降级**（§9）：`CORE_LOCATOR_FAILED` / `CORE_PROTOCOL_MISMATCH`（指纹不符**绝不落入 embedded**）/ `CORE_LOCKED` / `CORE_TAKEN_OVER` / `CAPABILITY_UNAVAILABLE` / `CORE_EVENT_GAP` 文案齐全（动作+目标+进度，`RUNTIME-002`）；禁止端口区间扫描（反例 `main/remote/index.ts:219-239`）。
9. **迁移顺序 S1–S7**（§12）：S1 契约先行（含合规三件套与全部登记件）→ S2 网关工厂化 → S3 embedded 句柄（desktop host）→ **S3b CLI 接入（attach 到 daemon core，走 handler 懒加载边；入口顶层 require 预算 6/999 与 L0 9/3757 零余量）** → S4 core server + 锁 + locator + hello/health（开关 `KHY_CORE_SERVER` 默认 0）→ S5 逐块迁移（事件→会话→存储/配置→插件→网关，一块一 PR）→ S6 收口删壳 → S7 生态化（两包同批发布）。
10. **验收**（§10）：embedded 契约测试、attached E2E、**三证**（锁 / `/core/health` 指纹三字段与 locator 逐字段一致 / 计量按 §7.3 形态化）；新增测试面 `locator-order`、`locator-host`、`browser-safety`、`core-env`、`require.resolve('zod')` conformance。

---

## 6 终端清单摘要（全文 = 221 / `terminal-manifest-v2.md`）

### 6.1 A 方案（定稿）

每端 `khy.terminal.json` = 编写真源；`entries/entries.json` = 生成投影（入库、逐字节可复算）；生成器 `scripts/ci/gen-entry-matrix.js` 一次产**三份**（投影 + plugin-sdk 的 schema 副本 + 词表副本）；校验器 `scripts/ci/check-manifests.js`（S1）。**生成器输入是显式清单 `const TERMINAL_MANIFESTS = [<7 条路径>]`**（顺序即投影顺序，新增/退役仓内端必须同批改它）—— 靠目录扫描会把生态端/临时目录卷进投影，破坏逐字节复算。生态端**不进投影、不进分发包副本**。

### 6.2 schema / 词表 / 版本（沿用 v1，四处口径钉死）

- 字段名用 **`kind`**（不是方案的 `type`）；`kinds/statuses/modes` 在投影**顶层**（本轮实测）。
- `artifactOutput` 一律写 BUILD-OUTPUTS 的 **id 指针**；web-quant 首个取值 = `quant-frontend-dist`（本轮实测现为 `null`）。
- `capabilities.consumes[].required` 必填 boolean、无缺省；`required:true` 必须 `providedBy:"core"` —— 产品意图 2 的机判化。
- `embed.mode`：`web|mobile` + `embedded` → `manifest-embed-invalid`（浏览器内嵌物理不可能，§3.2 #15）。
- `coreVersion` **只协商 G1**（本轮 B5：1.2.2），文法钉死 `>=X.Y.Z [ <A.B.C ]`；**不复用 `plugin-loader` 的手写 `satisfies`**（`:106-109` 对不可解析片段 `continue` = fail-open）；取不到真源即 `core-version-source-unresolved` 响亮拒绝，禁止回退默认值。
- 词表命名正则（允许段内连字符）本轮复测：`ATOMIC-CAPABILITIES.json` **137 条 / 34 条含连字符 / 0 条不匹配**（v1 记 135/32 已过期）。

### 6.3 SSOT 登记（A 方案的落地形态，TM-1/D2）

1. `sources[]` 增补 7 份清单路径 —— **必须与 7 份清单同 PR**（否则 `ssot-source-missing` error）。
2. `facts[]` 可选一条 `terminal-matrix`（`json-count` + `/entries`），note 明写「不提供影子副本保护，锁步由 `entry-matrix-stale` 判」。
3. **`entries.json` 与 schema/词表都不进 `sources[]`**：`sources[]` 的整文件指纹（D4）会把逐字节分发副本判成 `ssot-source-shadow-copy`（error）。
4. schema/词表各登记一条 **fact + mirror**：`capability-vocab-size`（`json-count` `/capabilities`）与 `terminal-manifest-schema-version`（`json-pointer` `/properties/schemaVersion/const`，**必须带 `detect.identifiers:["schemaVersion"]` 且 `detect.paths` 收窄成两个精确文件** —— 写目录前缀会让 `$schemaVersion` 三行误判矛盾）。能力边界如实写清：**只给长度/标量级锁步**，内容级唯一防线是 `sdk-dist-stale` 的逐字节比对（S1 不阻断）。
5. TM-1 的正确理由写进 221：`entries/` **在** `scan.include` 内，不报红是因为 fact 无锚点（`ssotDataGuard.js:615-617` 无 matcher 即 `continue`）。

### 6.4 校验器契约（`check-manifests.js`，S1）

`--json` 形状 = `{stage, findings[], counts{21 键}}`：20 个 finding id 各一键（0 也在）+ `counts.checks-run`（单次运行断言数，算式在 221 §5.2 写死）。机制 `terminal-manifest-guard` 的 `samples.source.key = "counts.checks-run"`（**不是 finding 计数**，见 §2 表 TM-2）。三件套接线：别名 3 个 + pr-gate 显式步骤 + 机制条目（`rules: []`、`GUARD_STAGE='S1'` 字面常量）。**S1 盲区如实声明**：不进 `RULES-REGISTRY` ⇒ `rules:gate/apply/coverage` 与 pre-commit 都看不见它，唯一执行面 = pr-gate 步骤 + 手动。

### 6.5 迁移批 8 步（顺序不可交换）

① 编号重测 + 写 221 + schema + 词表（索引登记属实施期，人批）→ ② 从现 `entries.json` 反向拆 7 份清单（`status/statusNote/notes` 随迁；web-quant 补 `artifactOutput`）→ ③ 生成器落地 + 与现投影 diff 等价（顶层三块逐字节）→ ④ `runtime/node/backend/tests/entrypoints.test.js` 回归（本轮实测该测试文件**存在**；测试**未执行**）→ ⑤ 校验器 + 全部登记（DATA-SSOT 与清单同 PR）→ ⑥ **规范订正（人批）**：`entries.json:7` ssot 指针 + `[DESIGN-ARCH-117]` 头注/§四 + 两处 `00_INDEX` → ⑦ 生态发现根 `KHY_TERMINAL_ROOTS`（默认目录暂不设；要设先登记 DATA-LOCATIONS）→ ⑧ S1 攒样本。

---

## 7 Composer / Suite 摘要（全文 = 222 / `composer-suite-v2.md`）

### 7.1 三形态与独立态租约规则（CS-1 定稿）

| 形态 | 定义 | 现状锚点（本轮/本会话实测） |
|---|---|---|
| 独立态 | 每终端只带 core(+shared) 单独构建运行，互不感知 | desktop host 内嵌 core（`host/index.ts:70`/`:126`/20 处 `nodeRequire`）；CLI 进程内 require（`aiGateway.js:2646,2685` 单例）；web 只 attach |
| 组合态 | suite 装配：一个窗口（suite 自己的 view 窗口）、一套设置、**一个共享 core 实例**；被装配终端必须 attached | `apps/suite` ABSENT（§0.1） |
| 生态态 | 第三方 `@khy/core`(contracts+client) + `@khy/plugin-sdk` | 两包发布面未建（TM-5） |

租约九条 **L1–L9**（正文在 222 §2.2，此处为口径）：**L1** 租约文件 `<dataHome>/core-instance.json` 只由共享核心持有者创建（组合态 suite 拉起的 core / 被远端消费的 daemon·服务态）；**L2** 独立态不创建/不竞争/不删除、**默认不读**（只读仅限「被 suite 装配」或显式 `--attach`/`KHY_CORE_ENDPOINT`），`mode=independent` **不落盘**，验证脚本按「存在且新鲜的租约文件」推导；**L3** N 个独立态并存合法（R1 并存 / R2 互不感知 / R3 协调面 = 数据域单写者表，未收敛域如实列 blocker #5/#6 / **R4 bootId 唯一性只对 composed-shared 断言**）；**L4** 独占创建 + 心跳 ≤10s + 有效期 ≤45s + `process.kill(pid,0)`；**L5** stale 才接管（原子替换 + `khy.core.lease.v1{takeover}`）；**心跳过期但 pid 活 ⇒ fail-closed 不抢**；运行中不得转让，正常移交 = 退场后交接；**L6** 「第二实例」只指共享核心候选者；**L7** `daemon.pid` / `ai_manage_runtime.json` 降级为派生投影，Electron 锁不参与 core 租约；**L8** 组合态启动不杀不拦不探测独立态终端；**L9** **被装配的终端必须 attached（embedded core 关闭）** —— desktop host 现状就是 embedded core 容器，attached 化完成前 desktop / provider-hub **不进入组合态装配**（否则 = 第二核心）。

### 7.2 单窗口口径（CS-7）

**口号：单窗口 + 组合态单 core 租约（锁 + epoch）。「单进程」在本仓是错误表述。**四条进程边界：main（`main/index.ts:121` 锁只管 GUI、`:799` fork host、`:827` fork scheduler、pty、设备车道、各 store）/ preload（`:348` `contextBridge`，通道名全为裸字符串、无常量表）/ renderer（零直连网络）/ host 子进程（embedded core 容器）。「一个核心实例」= 一个共享 core 进程 + 一把 `composed-shared` 租约 + 所有被装配终端 attached；「一个窗口」只指 suite 自己的 view 终端（档 A），不含外部窗口终端（Electron 不能把另一 app 的 BrowserWindow 嵌进自身窗口）。

### 7.3 单实例三证与 verdict

| 证 | 内容 | 现状前置 |
|---|---|---|
| ① 租约 | `composed-shared` 条目新鲜 + 身份一致 | 文件不存在（§0.1）→ 无租约 = `mode:'independent'`，**N/A 不是失败** |
| ② listener | 只探租约声明的 port；响应必须回 `{ok,service,pid,startupAt}` 并逐字比对 | 现有 `/r/health` 不回身份（`webRemoteControl/server.js:40` 的 `HEALTH_PATH` 与 `:389-391` 只回 `{ok,service:'khy-web-remote'}`，本轮亲测）；端口顺延 +10（`aiManagementServer.js:3540` `maxAttempts=10`、`:3572` `listen({host:'127.0.0.1',exclusive:true})`，本轮亲测）与「第二实例拒绝」冲突待裁（§16-6） |
| ③ 计量 | **按形态判定**（字段名统一 `coreId`，见 §1.2 偏离 2，不存在 `bootId` 别名）：composed → 窗口内 `records[].coreId` 与租约 `coreId` **不一致**的条数 = 0 且 `writerId ⊆ {suite-core}`（出现 `desktop-host` → `metering-second-core`）；independent → `writerId` 合法 + `schemaVersion===2`，**多 `coreId` 合法**（N 个独立 core）；未收敛/旧格式 → `metering-dual-writer` | 数据面不存在（§0.2）⇒ **今天只能报 `metering-dual-writer`** |

verdict 取值：`single | metering-dual-writer | metering-second-core | lease-conflict | independent | core-start-timeout`。入口 = `npm run verify:core-single --json`（**不是 CLI 命令**，D5）。

### 7.4 共享数据域与 web-quant

数据域按域列写者（不是「持租约者可写一切」）：计量（§7.3）、会话正文 JSONL、sessions.db FTS5、凭据 `api_keys.json`、设置分域（`global` 写 core 并广播 / `terminal` 留 `settings.json`，`dataPath` 必须留引导可读域）、daemon 运行态（派生投影）。**诚实边界**：D4 收敛的是**实现份数**，进程级仍是多写（N 个独立 core 各持内存累加器写同一 `USAGE_FILE` ⇒ 最后写者覆盖）；`records[]` 只让覆盖可审计，不阻止覆盖；按 writerId 分文件的落盘形态 = §16-5 待裁。web-quant 见 D7。

### 7.5 LAN 与例外（D6 / CS-6 / CS-8）

逐 listener 现状：backend Express 默认 `127.0.0.1`（既合规）；**ai-backend / AI_MGMT 默认 `0.0.0.0`**（`server.js:127` + `serviceDefaults.js:314`，ARCH-074 刻意裁决）→ 保留 + 登记 `KNOWN-EXCEPTIONS.json`；webRemoteControl 默认 loopback（`lanEnabled`/`KHY_REMOTE_BIND_HOST` 显式 opt-in）；agentbus 是设备车道、不作 core attach 底座。仲裁顺序 **用户显式 env > suite 注入 > serviceDefaults**（实现口径：只在 spawn 子进程 env 上注入；`process.env.AI_MGMT_HOST` 非空即原样透传）。`pairUrl` 文案须明示「局域网明文通道，配对码 10 分钟内有效」。

### 7.6 七条体验矩阵（T1–T7，判据草案）

> **落盘前置**：七条体验**原文未见**（219 §12 风险 10 同记）。原文回填之前本表只作判据草案，**不得作为验收依据**（§16-8）。除「本会话已跑」列标注者外，全部为**目标态、未执行**。

| # | 体验 | 机判命令 / 断言 | 本会话状态 |
|---|---|---|---|
| T1 | 独立态可构建可运行 | ① `node runtime/node/backend/bin/khy.js entry probe --json`，断言三条件同判：`status==='ready'` **且** `drift===null` **且** `declaredStatus===status`（第三条是本稿实跑新增 —— `drift` 只报单向缺口）；`mobile.machine.ok=false` 只作本机事实，不作失败判据 ② `--version` + `entry list --no-probe` ③④ 前端构建后**按 BUILD-OUTPUTS 的 `path`/`legacyPath` 解析产物**（两条 `migrating`，`entries/*` 迁移前 ABSENT）⑤ GUI 端只 probe ⑥ mobile 移出清单 | ①② **本稿会话亲测**：`--version`→`1.2.2` exit 0、`entry list --no-probe` exit 0、probe 7 端 `status=ready`/`drift=null`，其中 `desktop-provider-hub` 为 `declaredStatus=degraded` 而 `status=ready`（反向漂移 `drift` 抓不到，故加第三条）；mobile `machine.ok=false`（本机缺 flutter）。③④ 构建未跑 |
| T2 | 组合装配幂等 | `npm run suite:validate --json` ×2 逐字节一致 | 未跑（脚本不存在） |
| T3 | 设置传播 | `settings.set{scope:'global'}` → 两 view 各收到一次 `khy.settings.changed.v1{revision:N+1}`；`settings.json` 键 ∩ global 键 = ∅ | 未跑 |
| T4 | 会话接力 | web append 2 条 → `node runtime/node/backend/bin/khy.js -p "<提示>" --continue`（**`--continue` 必须在 `-p` 之后**；`chat` 不是命令）+ CI 需本地 stub 网关 | 未跑（语序事实由 composer-suite-v2 F21 实测钉死） |
| T5 | 单实例三证 | `npm run verify:core-single --json`（§7.3） | 未跑；**收敛前不得报 single** |
| T6 | LAN 逐 listener | `npm run check:core-boundary -- --lan --json`（§7.5） | 未跑；表 + 消费者未同批落地前**不判绿** |
| T7 | 热插拔 | `node --test scripts/tests/suite-hotplug.test.js`（a1–a7，含插件双闸同步 `plugin-gate-desync`） | 未跑（测试文件不存在，本轮 `dir /b scripts\tests` 无该文件） |

---

## 8 生态态交付

### 8.1 两档发布（D1）

| 档 | 交付物 | 承诺 | 不承诺 | 验收（实施后可机判） |
|---|---|---|---|---|
| **档 1 · attached** | `@khy/core` 的 `contracts` + `client`（+ `contracts/core-env`、`./package.json`）；`@khy/plugin-sdk` 同批发布（通道 (a)），含 `terminal-manifest/{schema.json, capability-vocab.json}` 两份 JSON | 第三方 `npm i` 后以 attached 连官方 core 进程；零 `node:`、零副作用、自带可校验清单 | 不承诺第三方在自己进程里跑 AI 网关 | A1 `npm pack plugin-sdk` 的 tarball 含两份 JSON；A2 空目录安装后 `require.resolve` 两个 JSON 子路径成功；A3 `require('@khy/core/contracts')`/`('@khy/core/client')` 可解析 + 两目录 `node:`/未守卫 `process.env.` 扫描 = 0；A4 包根 `require.resolve('zod')` 可解析；A5 两包 bump 走 `PROCESS-005`/R-2a 人批；lockfile 在有 pnpm 的机器再生 |
| **档 2 · embedded 全量** | core server 实现随官方发行包（npm `bundled/` + pip wheel）交付 | 本仓发行包内 embedded 可用 | 不承诺源码级轻包；不承诺「`npm i @khy/core` 即 embedded」（待 **B8** 网关切分） | B1 发行包含 core 全量；B2 装机态不要求 `node_modules/@khy/core`（定位顺序第 ② 段）；B3 `bundled/` 内不出现 schema/词表副本（防第三载体） |

**发布自足性硬前置**（本轮实测）：`plugin-sdk/package.json` 只有 7 个键、`works/ship/modules/modules.json` 不含 plugin-sdk、`works/ship/npm/package.json` 的 `files` 不含它 ⇒ **`@khy/plugin-sdk` 今天根本不是可安装产物**；本机无 pnpm/corepack ⇒ 在通道建成前，任何「第三方只凭 manifest + core 契约接入」只能停在**设计契约层**，**不得宣称「今日已可脱离 monorepo 接入」**。

### 8.2 第三方最小接入（7 步 + 目录树，TM-7）

```
acme-viewer/                 ← 第三方自有仓，包根即分发单元
├─ khy.terminal.json         ← 唯一声明面（清单）
├─ package.json              ← 普通 npm 包
├─ src/main.js               ← entry.source 指向包内目录
├─ scripts/validate-manifest.mjs
└─ test/terminal-manifest.test.js
```

步骤：① 包根写 `khy.terminal.json`（`entry.source` 只写包内相对路径，**不出现任何 khy-os 仓库路径**）；② `npm i @khy/core`（档 1）；③ `npm i -D @khy/plugin-sdk`（同批版本）；④ CI 跑两条校验命令（schema ajv 校验 + 能力契约校验，见 221 §9.5 ④）；⑤ 启动时经显式 `KHY_CORE_ENDPOINT`/`KHY_CORE_TOKEN` 或宿主注入连 core，定位按四段顺序；⑥ `required:true` 缺提供者 → 启动期响亮报错，`required:false` → 注销入口并计入 `degradedEntrances`；⑦ 进组合态 = 包根加入 `KHY_TERMINAL_ROOTS`，suite 读清单并 `--loose` 二次校验。**仓外终端无需任何仓内登记**；进本仓端 = 写本端清单 + 重跑生成器（投影不手改）。

### 8.3 conformance 与版本兼容

- `packages/core/conformance`（第三方可复用断言集）+ 仓内 `test/`：契约形状、幂等清单、错误码枚举与 `API-SURFACE` 一致、真实帧 zod 校验（补 `validate-protocol-contracts.js:13-15` 的硬编码 fixture 缺口）、browser-safety、**发布自足性两个测试**（档 1 走 node_modules 分支；档 2 用无 node_modules 的沙箱 + 注入 `bundledEntry`；三者全无 → `CORE_LOCATOR_FAILED` 文案三段齐全）。
- **fake adapter 只用于 CI 的句柄形状测试，不得作为生态可达性证据**；生态验收必须跑真 core 进程 + 真 transport（AI 调用可指向本地 stub HTTP 端点，但网关本体、适配器链、计量落盘必须是真的）。
- 兼容：`protocolVersion` **相等**才可连；`clientVersion` 走 `engines.khy` 区间（先例 `plugin-loader/index.js:245-248`）；`coreVersion` 绑 G1；**`@khy/core` 不并入 G2**；`protocolVersion` 升版 = MAJOR 且须人批（`PROCESS-005`/R-2a）；**本稿不给任何版本号**。多版本共存**明确不支持**。
- 禁止依赖：`works/`、`scripts/`、`docs/`、`apps/`、`delivery/`、`entries/`、`@khy/shared`（`private:true` 未发布、带 sequelize/pg/winston）—— 由 §4.3 判据 #1 拦。
- 未决：桌面安装包如何携带 core（`build.files` 实测只有 `out/**`、`resources/**`，`extraResources` undefined）——属 B8 打包验证项，本稿只固化 `bundledEntry` 注入点，**不承诺安装包形态**。

---

## 9 三形态验收矩阵（逐条机判命令 + 期望）

> 三条纪律：**当前一格都不成立**（§0.1 全部 ABSENT）；下表是判据与命令，实施期逐格回填读数；**未跑 ≠ 通过**。所有命令为 `node`/`npm run` 级（D5）。

### 9.1 独立态（产品意图 2）

| 判据 | 命令 | 期望 | 前置 |
|---|---|---|---|
| 闭包不加载 composer/suite | `node scripts/ci/check-core-boundary.js --suite-fork --json` | `counts.terminal-imports-suite=0`、`counts.suite-forks-terminal=0`；各端入口闭包 ∌ `apps/suite`、∌ composer（含动态分段文本兜底） | 脚本本次新增 |
| 产物不含 suite 痕迹 | 对每端产物目录（按 BUILD-OUTPUTS 的 `path`，迁移期回退 `legacyPath`）grep `composer` 或 `khy.suite` 或 `apps/suite`（三词任一） | 0 命中 | LAY-5 迁移未完成时按 legacyPath |
| headless 可运行 | `node runtime/node/backend/bin/khy.js entry probe --json`；`--version`；`entry list --no-probe` | probe 7 端 **`status=ready` ∧ `drift=null` ∧ `declaredStatus===status`**（三条件同判，与 §7.6 T1 同一口径）；`mobile.machine.ok=false` 只作本机事实；版本行匹配 `^\d+\.\d+\.\d+$`；exit 0 | **本稿会话亲测 = B8/B9**（三条均 exit 0、`--version`=`1.2.2`）。**按三条件判，今天有一格是红的**：`desktop-provider-hub` 为 `declaredStatus=degraded` / `status=ready` ⇒ 只能报「反向漂移待处理」，不得把 §9.1 写成已满足；只判 `drift===null` 会把它误判为绿 |
| 独立构建证 | `scripts/tests/independent-build.test.js`（`git worktree add` HEAD → 删其余终端 → 剩余树跑该端 build + probe） | 每端 exit 0 | **需 pnpm 与网络，本机不可执行**（未核实「删 workspace 成员后 pnpm 行为」）；标「未运行」 |
| 生态端 | `node scripts/ci/check-manifests.js --root <第三方包根> --loose --json` | `capability-required-not-core` = 0；`port-ref-unverifiable` 允许 info | 通道未建（TM-5） |

### 9.2 组合态（产品意图 3）

| 判据 | 命令 | 期望 | 前置 |
|---|---|---|---|
| 装配幂等 | `npm run suite:validate --json` ×2 | 两次 stdout 逐字节一致；findings 空或如实列 required 缺失 | suite 不存在 |
| 一套设置 | `node --test`（T3） | 两 view revision 相等 = N+1；`settings-shadow-key` = 0 | 依赖设置分域表 |
| 一个共享 core | `npm run verify:core-single --json` | composed → `verdict:'single'`；第二共享核心候选者 → exit≠0 且打印 `{pid,coreId,owner}`；无租约 → `independent`（非失败） | **D4 计量收敛前只能报 `metering-dual-writer`** |
| 不 fork 终端 | `check-core-boundary --suite-fork` 六 finding | 全 0 | — |
| web-quant 只装登记产物 | 装配报告断言 `artifactOutput` 解析到 `quant-frontend-dist` | 不出现 dev server | 清单补指针（D7） |
| LAN | `check-core-boundary --lan --json` | `backend=127.0.0.1`、`webRemoteControl=127.0.0.1`、`AI_MGMT=0.0.0.0 → known-exception-applied:ai-mgmt-host-lan-default`、`unknown-listener=0` | 表 + 消费者同批 |
| 多独立态并存不被互斥 | `scripts/tests/core-lease.test.js` a1–a5 | a1 独立态不落租约文件（临时数据家预置指向死 pid 的假租约 → 独立态 `--version` 仍 exit 0、不报冲突）；a2–a5 见 222 §2.2 | 租约 schema 定稿 |

### 9.3 生态态（产品意图 4）

见 §8.1 档 1 的 A1–A5 与 §8.3 两个发布自足性测试；**档 2 在 B8 完成前不进生态验收**。硬证四件套：静态证（`--portable` A/B/C）、登记证（机制条目对 `packages/core/**` 生效）、发布自足性证（`npm pack` → 空目录 `npm i <tarball>` → attached 闭环 + conformance 子集）、体量证（包体读数 + 网关闭包文件数/行数登记进 `BUILD-OUTPUTS.json` 与 `CORE-LAYERS.json` 的 `runtimeFootprint`；基线 §3.2 #15）。**没有体量证，「core 可交付给第三方」不算证明。**

---

## 10 执行路线（A / B / C；每步改哪些文件、门禁、回滚、验收）

> 阶段命名是本总案口径（方案原文 A2/A3/A5 的确切语义**未读到**）：**A = 勘察与契约登记**、**B = core 物理化与句柄接通**（= 220 §12 的 S2–S6）、**C = 三形态收口**。纪律：不跨目录合并提交；不删文件（`RUNTIME-009`：`scrub-plan.md` + 可执行 `rollback.txt`）；提交信息无 AI 署名（`PROCESS-010`）；**commit/push 由人执行**（`PROCESS-001`，本稿不绕过）。

### A 阶段

| 步 | 内容 / 改哪些文件 | 门禁命令 | 回滚 | 验收 |
|---|---|---|---|---|
| **A1（已完成）** | 勘察与草稿：`refactor-001-coupling.md`（201 条有向边 / 248 加权位点）+ 五份 facts + 三份 v1 稿 + 三份 v2 稿 + `decisions-v2.md` + 219 已入仓 + **本收口稿**。全部落 `.khyos/refactor-drafts/`（`.gitignore:80` 排除） | 无（纯勘察） | 删草稿目录即可 | A1 的产出**不含任何生产代码改动**（本会话 `git status` 计数与 §3.2 #14 一致；本轮唯一写入 = 本文件） |
| **A2 工作区收口（前置，人做）** | 由**人**提交/归档本轮 B3 实测的 **772 项改动**（含已 staged 的 agentbus 等），并为重构另切分支；AI 不代做 | `git status --porcelain` 计数归零；`check-delivery-baseline --json` 的 D3 应转 PASS | 无代码可回滚；可另打 `backup/workspace-<日期>` 分支仅作取证 | 后续每步 diff 只含本刀内容，`--changed` 类门才有意义 |
| **A3 core 契约与登记件（一次提交）** | 新建 `packages/core`：`contracts`+`client`+`locator-host`+`server` 骨架（零业务）+ **合规三件套**；登记件全批（§4.1 表：workspace 两处 + overrides、lockfile importer、WORKSPACE_ROOTS 三条、backend 依赖声明、desktop `file:` 声明、`check-agent-rules` 白名单、`FEATURE-OWNERSHIP` 机制、`API-SURFACE` 14 码 + `COMMS-001.exec.findings`、`DATA-LOCATIONS`/`DATA-SSOT`）；新增 `scripts/ci/check-core-boundary.js`（`GUARD_STAGE='S1'`、恒 exit 0、`--changed/--json/--portable/--suite-fork/--lan`）+ `check:core-boundary` 别名 + pr-gate 步骤。**不改** `DOMAIN-DEPS`、`check-version-sync`、AGENTS、`RULES-REGISTRY` | `check-repo-layout.js --json`、`check-core-layers.js --json`、`check-core-boundary.js --json`、`check-rollout-stage.js`、`check-version-sync.js`、`check-ssot-data`、`check:wiring`、`rules:coverage`、`node --test packages/core/test/*.test.js` | 删包 + 删脚本/别名/pr-gate 步骤 + 逐 hunk 还原登记件（纯新增、零行为变更） | entry-buffer **仍为 2416**（施工当天重测）；domain-direction 199 / cross-layer-require 37 **不得 +1**；version-sync 仍 exit 0 且 `VERSION_SPECS` 长度 **仍 10**；ruleCount **仍 101**；`check-rollout-stage` error **仍 0**，新机制无 `samples-unverified` |
| **A4 清单与投影（一次提交，依赖 D2）** | 7 份 `khy.terminal.json` + `TERMINAL-MANIFEST.schema.json` + `CAPABILITY-VOCAB.json` + `gen-entry-matrix.js` + `check-manifests.js` + 3 个别名 + pr-gate 步骤 + 机制条目 + DATA-SSOT 登记（§6.3，与清单同 PR）+ 221 新篇 | `gen-entry-matrix.js --check`（exit 0）、`check-manifests.js --json`、`runtime/node/backend/tests/entrypoints.test.js` | 删清单与两脚本 + 还原别名/pr-gate/机制/SSOT 条目 + `entries.json` 按 hunk 还原 | 投影与迁移前 `entries.json` 逐字段等价 + 顶层三块逐字节等价；`--json` 的 counts **21 键齐**；`khy entry`/registry 回归通过（**实施期执行，本会话未运行**） |
| **A5 终稿落盘（本轮之后由「落盘编辑 v2」执行）** | 折叠 220/221/222 三篇 + 主/子索引各一行；落盘前重测编号；订正清单见 §1 D10 | `check:layout` 的 `docs-index-complete` 不新增 finding；`npm run docs:verify` 断链数不新增（本轮基线 **1**） | 删新增三篇 + 索引按 hunk 还原 | 三篇终稿无旧措辞残留（`check:core-layers --portable/--suite-fork`、「入 G2」、「^3.24.0」、「本体随 S5 搬」、「218 可用」全部消失） |

### B 阶段（= 220 §12 S2–S6；一块一 PR、一块一 revert）

| 步 | 内容 | 改哪些文件（要点） | 门禁 | 回滚 | 验收 |
|---|---|---|---|---|---|
| B1 | 网关工厂化 `createGateway(options)`，`module.exports` 仍是实例（主入口 src 侧 75 处 / 56 文件零改动） | `backend/src/services/gateway/aiGateway.js` | `check:core-layers`（读数不得变大：aiGateway 已超预算，本轮 71833>71078）+ 网关既有测试 | 还原一个文件 | 熔断/冷却不再共享进程级状态；无新 error 条目 |
| B2 | embedded 句柄（desktop host）：`obtainCoreNode({mode:'embedded'})` 替换 `resolveKhyOsDir()+nodeRequire` | `apps/khyos-desktop/src/host/index.ts:70-74,126,330-337` | `check:layout` + desktop 构建 | 还原 host 一处 | 注入 bundled 入口后 embedded 可起；三者全无 → `CORE_LOCATOR_FAILED` 文案三段齐全 |
| B3 | CLI 接入 = attach 到 daemon core（S3b）：接入点放 `src/cli/repl/startup.js` 或 handler 懒加载边 | `runtime/node/backend/src/cli/repl/startup.js` 或具体 handler | `check-core-layers` 的 entryBudget/L0 读数不变 | 还原 handler | `bin/khy.js` 顶层**不出现** `@khy/core`；判据 #3 通过 |
| B4 | 事件块：**`eventBus.js`+`eventLog.js` 本体迁入 core**；`coreEvents.publish/subscribe/replay/ack`；seq 核心级持久化 | 新增 `packages/core/src/server/events/**`；backend 侧 `observability/eventLog.js` 改门面 re-export；**7 个写者只改调用面**（`coordinator/processAgent.js:347`、`coordinator/taskBoard.js:323`、`observability/{cpuProfiler:167,eventLoopMonitor:160,slowRequest:230}.js`、`services/usageTracker.js:177`、`tasks/largeTaskRuntimeStore.js:1812` 是 `eventLog.snapshot()`）—— 行号本轮逐个 node 复读证实 | `check-core-boundary --json`（判据 #4 不得命中四个黑名单模块路径）+ 既有事件测试 | 还原壳与迁入件；`git diff --stat` 确认上述模块本体未动 | 无第二份 JSONL 写者；订阅者失败计数可见；`event.gap` 可触发；**总案 B4 的「7 个写者改道」措辞为准**（CH-3） |
| B5 | 会话块：`CoreSession` 单写者 + §5 第 7 条全清单 + 备份还原互斥；`sessionSearchIndex` 静默关闭改 `session.search=degraded` | `services/sessionPersistence.js`/`sessionSearchIndex.js`/`sessionGroupService.js`/`dbHealthService.js`/`domain/backup/backup/{restoreService,sqliteHotCopy,backupAssetPlan}.js` 的消费面 | 会话既有测试 + `node --test packages/core/test/attached.e2e.test.js` | 还原壳 | 双进程 append 后链完整；还原期间拒绝新 attach |
| B6 | 存储/配置 + 计量收敛（D4）：UsageStore 叶子、定价副本 3 份待并（+1 已委托点）、schema v2（`writerId`/`coreId`）、解析家 + legacy 双读、DATA-LOCATIONS(knownGaps)/DATA-SSOT 登记、jsonl 休眠写者例外条目 | 两份 `tokenUsageService.js`、`delivery/channel/khyquant/services/tokenUsageService.js`、`usageTracker.js`、`tokenPricing.js`（加 `MODEL_PRICING`+`calculateModelCost`）、`serviceDefaults.js`、`core-env` 消费面 | `check:ssot-data`、`check:data-layout`、`check:core-boundary --json`（`counts.metering-dual-writer` 应由 1 → 0） | 逐文件还原（§1 D4 rollback） | 证③按形态判绿；`api_keys.json` 双写者收敛（凭据属 `RUNTIME-009` 范畴，另出 scrub-plan） |
| B7 | 插件宿主进 core（`plugin-loader/{index,contextFactory,sdkCompat}` 搬入，契约真源仍 `@khy/plugin-sdk`，不复制）；两包发布面（D1 通道 (a)） | `packages/core/src/server/plugins/**`；`plugin-sdk/package.json` 补 `files/exports/publishConfig` | `check:core-boundary --portable`；`plugins.enable/disable` 幂等测试 | 还原壳与发布配置 | attached 终端不触发激活、只订阅 `plugin.changed`；**lockfile/pack 在有 pnpm 的机器** |
| B8 | **网关切分为可发布子集**（新增工程，独立立项） | `gateway/adapters/**` 惰性边、闭包缩减分层 | 包体读数单调下降 + 冷闭包文件数/行数登记 | 分层回退 | 档 2 的「空目录 embedded 起 core 并跑一次真实 generate」双证；**没有本步，档 2 不进对外承诺** |

### C 阶段（三形态收口）

| 步 | 内容 | 门禁 | 回滚 | 验收 |
|---|---|---|---|---|
| C1 | 端矩阵清单收编：各端 source 已有清单，投影由生成器产 | `gen-entry-matrix --check`、`check-manifests` | 回 A4 前状态 | §9.1 的三条 headless 命令 exit 0 且读数达标（**本稿会话已亲测**，见 §0 B8） |
| C2 | 终端独立态收口：逐端跑 §9.1 的 (a)/(b)/(c) 三证 | `check-core-boundary --suite-fork/--portable` | 摘除该端装配 | 「删掉其余终端仍可构建运行」有读数 |
| C3 | 终端直连改走 CoreHandle + 例外登记：khyquant 5 文件 6 处（死引用，现靠 try/catch 静默降级）、desktop `host/index.ts:126`（B2 后归零）、provider-hub `modelCatalog.ts:35,145`；ai-backend 第二网关登记为例外（`FEATURE-OWNERSHIP` 已 forbidden） | `check-core-boundary --json` 判据 #2 棘轮只降 | 逐文件还原 | 基线 7 → 目标 0（ai-backend 3 处自包引用单列例外面，不进本基线） |
| C4 | 组合态交付：`apps/suite`（需人批注册表）+ `entries/suite` 登记先行于首个构建 + T2–T7 逐条 | §9.2 全部命令 | 摘 suite 装配 slot | 「单窗口 + 组合态单 core 租约」三证按形态判绿 |
| C5 | 文档真源订正（人批留痕，§6.5 步骤 6）：`entries.json:7` + `[DESIGN-ARCH-117]` 头注/§四 + 两处索引 | `check:layout` 不新增 `docs-index-*` finding；`docs:verify` 断链数不新增（基线 1） | 按 hunk 还原 | 指针与真源路径一致 |
| C6 | 生态态发布：档 1 两包同批 npm 发布（`PROCESS-005`/R-2a 人批）+ 四证（§9.3） | 档 1 A1–A5 | 发布链回退到不含两包的清单 | 全新克隆/空目录 E2E 通过 |

---

## 11 规则与守卫（S1 不新增规则 ID；一执行器 + 一机制）

### 11.1 一执行器一机制（本刀 A3 = 一个新执行器 + 一条机制登记；A4 再各加一对）

| 步 | 新增执行器 | 新增机制条目 | 规则 ID 变化 |
|---|---|---|---|
| A3 | `scripts/ci/check-core-boundary.js`（`GUARD_STAGE='S1'`、恒 exit 0） | `core-boundary-guard`（`rules: []`） | **0**（ruleCount 保持 101） |
| A4 | `scripts/ci/check-manifests.js` | `terminal-manifest-guard`（`rules: []`） | **0** |
| 222 落地时 | `check-core-boundary.js --suite-fork` 子档（不新建脚本） | `suite-assembly-guard`：**执行器与 `counts` 键未定前不登记**（不编造 key） | **0** |

机制公共字段：`stage:'S1'`、`previousStage:null`、`rules:[]`、`executorStage={file:<执行器>,constant:'GUARD_STAGE'}`（脚本源码必须有该字面常量，否则复现 `rollout-stage-authority-drift`）、`rollback` 非空、`samples.source={script,args:["--json"],key:"counts.checks-run"}`（**样本键只能是这种「健康态恒正」的断言计数**，见 §11.3 末条；不许写 `counts.<finding-id>` 的违规计数，也不许写 `"findings"`）。

### 11.2 S1 合法落地的四条件（前三条缺一即「S1 机制实际在拦」，第四条是口径清理）

1. finding 一律 `severity:'warning'` 发射 —— 阻断判定跟 finding 自己的 severity 走（`scripts/ruleguard/lib/run.js:345`）。
2. **不进** `LAYOUT-001.exec.args` 的 `--promote=` 名单（本轮实测现名单 = `root-whitelist,docs-index-first,layer-registry`；进名单即升 error，而 `LAYOUT-001` 未写 severity、P1 ⇒ `gateStrength()` 派生 blocking）。
3. 机制 `rules: []`（照 `entry-buffer-guard`/`domain-direction-guard`/`functional-unit-guard` 三条先例的 `_rules_note` 手法，本轮实测三者的 key 全为 `counts.*`、rules 全为 `[]`）。
   **禁止**给 `LAYOUT-001` 写 `severity=advisory` —— 会把它现有 root-whitelist/layer-registry 等 error 面整体降权。
4. **`[DESIGN-ARCH-219]` §10 前言（`:289`）**里「finding 挂 LAYOUT-001/TOOLING-012/COMMS-001」的旧写法**与同文 §10.2（`:363`）互斥**，本稿统一取 §10.2（外挂执行器不在 ruleguard 规则认领链上），落盘 219/220 时删前言旧口径。**注意**：该措辞在 219 正文里，不在 `RULES-REGISTRY.json` 内（本轮 grep 该 JSON 无此文本），别改错文件。

### 11.3 样本读数契约（CH-5 / TM-2）

- `check-core-boundary.js --json` 的 `counts` **键名全列、值恒为数值（0 也输出）**，与 §4.3 全表逐组一一对应：
  **基础**：`core-boundary-import`、`terminal-direct-gateway-import`、`core-not-in-entry-closure`、`core-skin-into-server`；
  **子档 A/B/C**：`core-client-node-free`、`core-env-single-source`、`terminal-cross-reference`；
  **`--portable`**：`core-private-path`、`core-carries-composer`、`core-dynamic-private-require`；
  **`--suite-fork`**：`suite-forks-terminal`、`suite-deps-core-pkg`、`terminal-imports-suite`、`suite-bundle-leak`、`suite-dynamic-require`、`suite-runtime-fork`；
  **`--lan`**：`known-exception-applied`、`known-exception-expired`、`known-exception-unverifiable`、`unknown-listener`；
  **metering**：`metering-dual-writer`、`metering-second-core`、`metering-unknown-writer`；
  **样本键**：`checks-run`（单次运行断言数；`samples.source.key` 指它，理由见本节末条）。
  ⇒ 共 **24 个键**（23 个 finding 键 + `checks-run`）；新增任何 finding id 时 `counts` 必须同批加键（`--json` 契约与 FEATURE-OWNERSHIP 的 `key` 一一对应）。
- `check-manifests.js --json` 的 `counts` = 20 个 finding id + **`checks-run`**（共 21 键）。
- **禁止 `key:"findings"`**（数组；`pickKey` :165-167 判「不是标量读数」，完整档真跑必报 `rollout-stage-samples-unverified`）。
- **样本键的选法**：健康态恒 0 的 finding 计数**不能**当 `samples.source.key`（PP-2 在升 S2 时需要 ≥200 的**实测值**；`counts.domain-direction=199` 本轮实测就已 <200，正好演示这个坑）；两个新执行器统一用 `counts.checks-run`。
- 毕业只看样本量：`GRADUATION_SAMPLES = {S1:200, S2:50, S3:20}`（`check-rollout-stage.js:90`，本轮亲测），PP-2 用**实测值**判（`:404-405` `sampleValue = state.value`、`:429-438` `sampleValue < need` 即报 `samples-insufficient` error；`:308-320` 快照失真只降为 WARN 且值取实测）—— 四段本轮逐行亲测。⇒ 落地首跑必须回填实测数字。
- **本稿新增的一条硬规则（CH-5/TM-2 的收口引申，非评审原文）**：PP-2 只在 `stage ≥ S2` 时评（`:431` 的 `STAGE_ORDER[stage] >= 2`），评的是「从上一阶毕业所需的样本量」——**健康态恒为 0 的 finding 计数不能当 samples 键**（例：`counts.core-boundary-import` 健康 = 0，升到 S2 时机械上必报 `samples-insufficient`，机制永远毕不了业）。既有三条先例里 `counts.functional-unit=277` 与 `counts.entry-buffer=2416` 当下确 >200（本轮 B6 实测），**`counts.domain-direction=199` 反而 <200** —— 即该机制今天若升 S2 会直接撞 `rollout-stage-samples-insufficient`（这不是设计得好，是恰好没被触发；也说明「违规计数当样本量」本身脆：违规一旦修完，样本量就归零）。
  ⇒ 两个新执行器的 `--json` 都必须带 **`counts.checks-run`**（单次运行的断言数，值恒为正、随覆盖面增长），机制条目的 `samples.source.key` 一律指它：`terminal-manifest-guard` → `counts.checks-run`（221 §5.2 已定）；`core-boundary-guard` → `counts.checks-run`（**落盘 220 时把 `core-handle-v2` §13.5 的 `counts.core-boundary-import` 改为此键**，`core-boundary-import` 仍留在 counts 里作为违规读数，只是不当样本键）。若将来某键实测 <200，PP-2 报 samples-insufficient 是**正确行为**（样本不足就不该毕业），补断言即可，不是结构性死路。

### 11.4 `PROCESS-008` 六条红线逐条对应

| 红线 | finding | 本设计怎么满足 |
|---|---|---|
| 阶段只取 S1–S4 | `rollout-stage-unknown` | 三条机制一律 `stage:'S1'` |
| 禁止直进 S3（PP-1） | `rollout-stage-skip-s1` | 全部从 S1 起；`suite-assembly-guard` 未定执行器 ⇒ **不登记**（不用「先登 S3 再说」） |
| 升阶以样本量计（PP-2） | `rollout-stage-samples-insufficient` | `samples.source` 指向**可复算标量**（`counts.*`）；`checks-run` 算式写死在 221 §5.2；不设日历期限 |
| S1/S2 必须旁路记录、禁止阻断（PP-3） | `rollout-stage-blocks-too-early` | 恒 exit 0 + `severity:'warning'` + `rules:[]` + 不进 promote 名单（§11.2）；`--strict` 在 S1 **不提供**（也不许提前阻断） |
| 每阶段必须有回退动作（PP-4） | `rollout-stage-no-rollback` | `rollback` 字段非空且可执行（删脚本 + 摘别名/pr-gate 步骤 + 删机制条目；不依赖未提交代码） |
| 一次只升一阶（PP-6） | `rollout-stage-jump` | 升阶是人的决定，守卫只校验不代劳；毕业批只动一阶 |
| （附带）登记表与代码不得漂移 | `rollout-stage-authority-drift` | 脚本内必须有字面 `const GUARD_STAGE = 'S1'`；**既有漂移（`core-layers-guard` → `check-core-layers.js` 无 STAGE 常量，本轮 B2 实测）不由本刀擅自修**（改守卫源码需人批准），列 §13 风险 |

### 11.5 毕业期（S3，第二层）草案 —— **不随 S1 落地**

`LAYOUT-009`（终端清单与端矩阵投影一致性）、`LAYOUT-010`（终端独立态可携性）、`TOOLING-013`（清单与插件能力契约）、`PROCESS-015`（组合态只装配不 fork）四张逐字段草案保留在 219 §10.1，**标注为「毕业期（S3）第二层」**；本轮实测 LAYOUT 域只到 008 ⇒ 009/010 空闲，但落盘前必须重测。S3 新增任何一条时**必须同批退役/合并一条既有规则**（`PROCESS-014`），退役候选由人定，退役动作受 `RUNTIME-009` 约束。

---

## 12 门禁与 CI 接线（真实命令 + 新增标注；**基线是红的，不声称全绿**）

| 命令 | 今天是否存在 | 接线与用途 | 本轮实测状态 / 施工口径 |
|---|---|---|---|
| `npm run check:layout`（`node scripts/ci/check-repo-layout.js [--json]`） | **存在** | 层级/结构守卫（`LAYOUT-001`，gate=pr） | **exit 1**（B6：error 4 类 14+2+80+7）；新判据**不寄生它**；目标 = 不新增 error 条目、entry-buffer 2416 不升、domain-direction/cross-layer-require 不 +1 |
| `npm run check:core-layers` | **存在** | 重量/芯纯净 | **exit 1**（B1：11 ❌）；**不再**作为新子档宿主；无 `GUARD_STAGE`；「文件宇宙扩展」属改守卫源码，**另一次人批准** |
| **`npm run check:core-boundary`** | **不存在（本次新增，A3）** | core 边界四判据 + `--portable/--suite-fork/--lan` 子档 | 自带 `GUARD_STAGE='S1'`、恒 exit 0；pr-gate 步骤 + 别名 |
| **`npm run check:manifests` / `check:manifests:json` / `gen:entry-matrix`** | **不存在（本次新增，A4）** | 清单/schema/词表校验 + 投影与副本逐字节复算 | pr-gate 显式步骤（形状照 `pr-gate.yml` 的「Check atomic capabilities」先例）；`check:manifest-sync`（管 `MANIFEST.in`）**不改** |
| `npm run check:delivery` | 存在 | 任务面/规则棘轮 | **exit 0 但 4 项越界**（B3）；目标 = 越界幅度**不变大**；D3 的 `??`/改动集当日重取 |
| `npm run check:ssot-data` | 存在 | 影子副本/值矛盾/镜像失步 | **exit 0**（B4）；新增 `core.lock`/`locator.json`/计量/清单登记后仍须 0 error |
| `npm run check:data-layout` | 存在（**本轮未运行**） | 数据落点（`LAYOUT-007`，S1 观察者） | 新增 `core-instance.json` 必须同批登记 DATA-LOCATIONS；token_usage 走 knownGaps |
| `npm run check:version-sync` | 存在 | 三轨道 10 源一致 | **exit 0**（B5）；**不新增第 11 源**、不 bump 任何版本号 |
| `npm run docs:verify` | 存在 | 文档站与孪生 | **exit 1**（B7：断链 1）；A5/C5 目标 = 断链数不新增，**不声称已修** |
| `npm run check:wiring` | 存在 | 反孤儿守卫 | 新脚本必须被别名引用，否则进孤儿名单（与 A3/A4 同批）；本轮未运行 |
| `npm run rules:gate` / `:commit` / `rules:coverage` / `rules:apply` | 存在 | 门成员资格从登记表派生 | 新机制**不进 `RULES-REGISTRY`** ⇒ 这四条**看不见它**（S1 盲区，如实写进 221/222）；`exec.findings` 的认领发生在 ruleguard 运行时（`run.js:265,287-294`），不是 `check:rules` |
| `npm run check:agent-rules` / `check:agent-feedback` / `check:change-safety` | 存在（本轮未运行） | 状态文案/超时/端点；三模态存证；改动集大小 | `core-env.js` 含端点默认值 ⇒ 白名单与它同批改（§5 第 3 条）；每步文件集须按块切，否则 change-safety 直接红 |
| `npm run docs:rules-cards` | 存在 | 登记表改动后重渲染卡片 | 若本批改 `COMMS-001.exec.findings`，卡片必须重生成（`check:rules` 逐字节比对） |
| `node --test packages/core/test/*.test.js` | 不存在（本次新增） | 双模式构建门 + 五个 v2 新增测试面 | 本机 node v22.18.0 支持 `--test` |
| `node scripts/ci/check-core-boundary.js --lan --json` / `npm run suite:validate` / `npm run verify:core-single` / `scripts/tests/{core-lease,suite-hotplug,independent-build}.test.js` | **全部不存在** | T5/T6/T7/独立构建证 | **目标态**：今天一条都跑不了（§0.1 + `dir /b scripts\tests` 实测无相关文件）；写进验收条款但不写进结果 |

**门是红的怎么办（施工纪律）**：B1 `check-core-layers` exit 1、B6 `check-repo-layout` exit 1、B7 `docs:verify` exit 1、B3 四项棘轮越界 + D1 `git fsck` 缺对象 + D2 无 wheel/sdist —— 这些是**本重构开始前的既有状态**（本轮亲测，非转述）。因此：① 全部验收口径写「不新增 error 条目 + 读数不劣化」，**禁止写「全绿」**；② 根面杂物清理属 `LAYOUT-004`（`organize.py --report`，只隔离不删除），**另立任务，不塞进拆分刀里**；③ `git gc` 不可用（缺 22 对象），压缩只走 `git prune-packed` + `git repack -d`（AGENTS 分支备份节 2026-11-04 口径）。

---

## 13 风险与前置（开工前必须满足；与 `decisions-v2` §4 的 10 条 prerequisites 逐条对齐）

| # | 前置（decisions 原文编号） | 本轮实测支撑 | 不满足的后果 |
|---|---|---|---|
| P1 | 编号写前重测（prereq 1） | §0.2：214 篇 / max 219 / 220–224 FREE | 撞号违反 `MGMT-STD-007` R3 |
| P2 | 基线红随施工报告原样引用，`check-core-layers`/`check-repo-layout` 不得描述为已修（prereq 2） | B1 exit 1、B6 exit 1、B7 exit 1、B3 越界四项 | 报告失真 = 本仓 `[DESIGN-ARCH-111]` 批判的无绑定层形态 |
| P3 | core-handle 终稿**先**落 CH-1~CH-4 修正（prereq 3） | `packages/core` ABSENT（冲突仍在设计层，本轮 §0.1） | browser-safety 测试与深导入落地即翻红 |
| P4 | WORKSPACE_ROOTS 同批登记 core（并补 `ui-shared`/`plugin-sdk`）；DOMAIN-DEPS 只认 D1、**严禁加 D3**（prereq 4） | 本轮 WORKSPACE_ROOTS 11 条无 core/无 ui-shared/无 plugin-sdk；`:304-309` 假绿前科 | 跨包深引用判据对新 core 全盲 = 第二次假绿事故 |
| P5 | 版本轨道不并 G2（prereq 5） | B5 exit 0（10 源）+ `check-version-sync` 硬编码组 | 11 源会强制 core = 1.6.5 |
| P6 | D4 计量收敛先行（prereq 6） | `token_usage.json` 无写者身份（本轮）；`DATA-LOCATIONS`/`DATA-SSOT` 无 token_usage | 「single」口号为假；证③无数据面 |
| P7 | D6 仲裁顺序写死 + `KNOWN-EXCEPTIONS.json` 建立（prereq 7） | `ai-backend/server.js:136-138` env 优先级最高（本轮逐行）；registry 无例外载体 | 压掉运维显式设置；T6 永远无法判绿 |
| P8 | D1/D8/D9 的 lockfile 再生必须在有 pnpm/corepack 的机器（prereq 8） | 本轮 lock **7 importer** vs workspace **9 包**；v1 M18 实测两者均缺 | 根 `install:core = corepack pnpm install --frozen-lockfile` 直接失败；档 1「可独立安装」停在契约层 |
| P9 | `apps/suite` 注册表变更须人批准（prereq 9） | verdicts[9] = needs-registry-change；`apps/` 实测只有 khyos-desktop | 未批即建 = `layer-registry`/释义漂移 |
| P10 | 回滚纪律：逐 hunk 还原，禁 `git checkout .`/`reset --hard`（prereq 10） | 本轮 `git status` 计数：已跟踪 426、总 772；B3 `??` 346 | 覆盖并发工作 = 丢别人的改动 |

**风险（延续，不重复 §0 数字）**

| # | 风险 | 处置 |
|---|---|---|
| R1 | 工作区**正被并发写入**（同一工作树多执行者） | A2 由人收口；施工期要求独占工作树；回滚一律 per-file（`PROCESS-001`：AI 不 commit/push） |
| R2 | 计量/凭据/会话并发 → 最坏是**数据损坏**而非崩溃（dual-facts blockers #5/#6） | D4 + §7.4 按域列写者；未收敛域在独立态并存下**如实列为已知风险**，不宣称已解决 |
| R3 | entry-buffer 余量 **54** + 三条零余量 | A3 合规三件套同批；超件即先降基线（列人拍板） |
| R4 | 守卫「双重失明」+ `require(变量)` 只计数不解析 | 三形态自匹配 + 文本兜底 + R6 `require.cache` 交叉验证为必配 |
| R5 | ai-backend 第二套网关且不在任何 DOMAIN-DEPS roots 内 | 不吞并；例外登记 + 判据 #2 入站扫描显式覆盖，防第三套；切分归 B8 |
| R6 | `delivery/mobile` 不在耦合扫描根内 | 其耦合读数是「未扫」不是「无耦合」；列为 C 阶段前置（C2 前补一次扫描） |
| R7 | 文档真源与守卫口径漂移（`[DESIGN-LAY-005] §1` 表仍写旧目录名；AGENTS 规则 12 的 D4/D6/D9 读数与本轮 B3 不同） | 以执行器读数为准、文档为快照（`PROCESS-011` T3）；订正归 C5/独立治理任务 |
| R8 | 七条体验原文未见、T5/T6 现状无法判绿 | §7.6 如实标「目标态、未执行」；原文回填前不作验收依据 |
| R9 | 既有阶段真源漂移（`core-layers-guard`） | 本刀机制一律自带 `GUARD_STAGE`；既有漂移不擅自修，列 §12/P 表 |

---

## 14 禁止事项对照（含「核心不得承载终端业务」）

| # | 禁止事项（记录态） | 裁决 | 依据 / 机判 |
|---|---|---|---|
| 1 | 不得新建顶层 `packages/ services/ kernel/ platform/ software/ tools/ extensions/` | **采纳** | core 落 `runtime/substrate/platform/packages/core`；§3.3 verdicts[0]–[15]；本轮 B6 已有 7 个未登记顶层项 |
| 2 | 不得把终端物理搬进 `apps/` | **采纳** | 不搬；清单 + 装配（§4.1） |
| 3 | 不得复活 `apps/electron` | **采纳** | verdicts[6] = illegal（Q10 2026-10-02） |
| 4 | **不得改 `kernel` / `runtime/boot/kernel` / `delivery/channel` 的既有定位** | **采纳，本稿对 L0/L1/L4 零动作** | 任务书只读边界；khyquant 仍是**独立项目**、另案申报（`PROCESS-010` 申报口径）；`delivery/channel/khyquant/frontend` 的 dev 脚本本轮**未改** |
| 5 | **核心不得承载终端业务** | **采纳并机判** | §4.2 点名式黑名单（任务编排/任务板/观测采样模块本体 + pty/KeyManager reveal/设备车道/UI）+ 判据 #4 `core-skin-into-server`（node-pty/ink/readline/`@khy/ui-shared`/`*Page.js`/`document.`/`window.`）+ 导出面只暴露六成员；三者任一被破即 warning（S1 只记录） |
| 6 | 不得引入第二端矩阵真源 | **改为「翻转真源 ownership」** | D2：清单真源 + 投影生成物 + `entry-matrix-stale` 锁步（先例 `ATOMIC-CAPABILITIES.json` 生成物自述） |
| 7 | 不得给 core 加编译步骤 / 新构建产物 | **采纳** | JSDoc `.js` + 手写 `.d.ts`（与 plugin-sdk 同型）；机判 = `git diff BUILD-OUTPUTS.json` **只允许 D8 的三处**（两条 rebuild 修正 + `suite-shell`）、**不得出现 core 条目**，且 `entries/` 下不得出现 core 产物目录（CH-4 同口径） |
| 8 | 不得让 core 依赖 composer / works / scripts / docs / apps / delivery / entries / `@khy/shared` | **采纳并机判** | 判据 #1 + 子档 `--portable` + 空目录安装证（§9.3） |
| 9 | 不得让终端互相直接引用或点对点通信 | **采纳并机判** | 子档 C `terminal-cross-reference`（基线只降不升）+ 契约测试兜底（产品意图 5） |
| 10 | 不得绕过 `PROCESS-001`（AI 不 commit/push、不直改主干） | **遵守** | 本会话**未做任何 git 写操作**（只有只读命令 + 本文件写入）；A2 收口与每步提交均由人执行 |
| 11 | 不得改版本号 / 不得自行 MINOR·MAJOR 递增 | **遵守** | 全稿无版本号变更；B5 读数只作事实引用；`protocolVersion` 升版 = MAJOR 须人批（R-2a） |
| 12 | 不得把新机制直进 S3 门禁档 | **遵守** | 全 S1 + `rules:[]` + warning + 恒 exit 0（§11.4） |
| 13 | 不得静默清理有文档背书的代码 / 不得删文件 | **遵守** | 删壳一律 `RUNTIME-009`（`scrub-plan.md` + 可执行 `rollback.txt`）；`delete-documented-code` 判 error 须先救活或订正文档；`core.lock.stale.*` 改名隔离而非删除 |
| 14 | 不得在发布链吞掉校验失败（`continue-on-error` 与 shell 兜底两种形态） | **遵守** | 不得使 B3 的 D4 读数变大；`sync-gitee.yml` 等失败步骤保持响亮（AGENTS 分发仓纪律 2） |
| 15 | 不得引入镜像源 | **遵守** | 新增 zod 依赖时只走官方源（`PROCESS-013` C1/C2/C3） |
| 16 | 不得把「未跑」写成「通过」 | **遵守** | 本稿所有目标态验收均标 **未执行**；§0 读数全是本轮实跑命令 + 退出码 |

---

## 15 交付物与验收口诀

### 15.1 交付物（★ = 本轮实测 ABSENT，属本次新增；未标记者为已存在的既有件）

- **A**：`runtime/substrate/platform/packages/core/**`★（contracts + contracts/core-env + client + locator-host + server + 1 份 D1 manifest + 1 份 README + 每 `.js` 同名测试）、`scripts/ci/check-core-boundary.js`★（`GUARD_STAGE='S1'`）+ `check:core-boundary` 别名★ + pr-gate 步骤★、`khy.terminal.json` ×7★、`TERMINAL-MANIFEST.schema.json`★、`CAPABILITY-VOCAB.json`★、`scripts/ci/gen-entry-matrix.js`★、`scripts/ci/check-manifests.js`★ + 三个别名★ + pr-gate 步骤★、`docs/10_规范/registry/KNOWN-EXCEPTIONS.json`★、登记件同批（workspace ×2、WORKSPACE_ROOTS ×3、backend 依赖声明、desktop `file:` 声明、`check-agent-rules` 白名单、FEATURE-OWNERSHIP ×2 机制、API-SURFACE 13 码、COMMS-001.exec.findings、DATA-LOCATIONS/DATA-SSOT、BUILD-OUTPUTS 的 `suite-shell` 与两条 rebuild 修正）、`[DESIGN-ARCH-220/221/222]`★ + 索引行★。
- **B**：`createGateway` 工厂、`obtainCore`/`obtainCoreNode`/`CoreLocator`/`contracts/core-env`、core server（锁 + epoch + locator + `/core/hello` + `/core/health`★）、事件块（eventBus+eventLog 本体迁入 + 7 个写者改调用面）、会话块（6 项单写者清单 + 还原互斥）、计量与凭据收敛（UsageStore 叶子 + `MODEL_PRICING` + schema v2）、插件宿主进 core、门面壳按 §5.4 条件删除、**B8 网关可发布子集切分**★。
- **C**：`apps/suite/**`★（含 `src/composer/` 四函数）、`khy.suite.json`★、`entries/suite` 登记★、三形态验收读数表★、两包发布面★。
- **纪律件**：每步回滚说明；`check:change-safety` 的按块切分；修复类改动配 `repro-before.txt`（`RUNTIME-007`，S1 阶段只记录）。

### 15.2 验收口诀（三问，各一条硬判据）

**拆得开吗（独立态）** —— 随便删掉一个终端，其余终端仍能只带 core(+shared) 构建并运行；各端入口闭包与产物里都找不到 composer/suite；**且 N 个独立态终端并存不被任何全局锁互斥**（§9.1 + L1–L3 + a1 断言）。
**合得拢吗（组合态）** —— 一个窗口 + **组合态单 core 租约**；三证按形态判绿（租约 / `/core/health` 指纹三字段逐字段一致 / 计量按 §7.3）；被装配终端全部 `coreMode==='attached'`；杀一个终端不崩壳、不丢会话。**计量未收敛前第三证只能报 `metering-dual-writer`。**
**接得上吗（生态态）** —— 第三方在**空目录 + tarball** 里 `npm i @khy/core @khy/plugin-sdk`，自带一份 `khy.terminal.json`，以 **attached** 连真 core 进程跑通最小闭环并通过 conformance；不需要 KhyAiHub 或 monorepo 的任何路径；四证齐（静态 / 登记 / 发布自足性 / **体量**）。「npm i 即 embedded」在 B8 完成前**不在承诺内**。

**三问共同的反问**：这三形态是**跑出来的**，还是**文档里写的**？截至本稿，答案是「写在稿里」——§0 九项实跑里 **3 项 exit≠0**（B1/B6/B7）、**1 项四项棘轮越界**（B3），本次新增物全部 ABSENT（§0.1）。三道硬前置（计量与凭据双写者未收敛、core 物理落点与发布面未建、清单与投影真源未翻转）未闭合前，**任何一格都不许判绿**。

---

## 16 本稿未覆盖与仍待人工的事

**A. 本稿未覆盖（诚实边界，不是「已解决」）**

1. **方案原文未读**：全文（含 §十一 禁止事项与 A2/A3/A5 的确切语义）；§14 与阶段命名以任务书偏差清单 + 三份稿记录的主张为对照对象，**须人回填校对**。
2. **七条体验原文未见**：T1–T7 是本总案主题推导的判据草案（§7.6 前置声明）。
3. `aiManagementServer.js`（3883 行）只读端口逻辑与导出面两段；全路由表未读。
4. `delivery/mobile`（Flutter/Dart）不在耦合扫描根内 ⇒ 其耦合面**未扫**。
5. 桌面安装包如何携带 core（extraResources/asarUnpack）未验证 —— B8 打包验证项。
6. 「删除 workspace 成员目录后 pnpm 的行为」未核实 ⇒ (c) 独立构建证的可行性未证。
7. `tasks/largeTaskRuntimeStore.js:1812` 的 `eventLog.snapshot()` 写入目标是否与主 JSONL 同文件，未逐行核实（v1 遗留）。
8. 本轮**未运行**：`check:data-layout`、`check:wiring`、`rules:gate/coverage/apply`、`check:agent-rules`、`check:agent-feedback`、`test:delivery-baseline`、任何前端构建、`npm pack`、`entrypoints.test.js`（文件存在性已实测，测试未执行）。
9. 判据 #3（`core-not-in-entry-closure`）只在迁移期有效，网关进 core 后须退役/改写 —— 退役时机未定（§16-B-8）。
10. **本稿全部为设计条款**：没有任何一条生产代码/登记表/索引被本轮改动；所有「目标态」验收命令当前**一条都不可跑**。

**B. 仍待人工（AI 不代拍）**

| # | 待拍板 | 为什么 AI 不能定 |
|---|---|---|
| 1 | `@khy/core` 起步版本与版本轨道归组（最终是否并某组） | 版本号是用户判断升级依据（R-2a）；D1 只裁决「本批不并 G2」 |
| 2 | `apps/suite` 的 LAYERS `apps` 释义 + `[DESIGN-LAY-005] §1` 表变更 | 顶层语义/注册表变更须人批准（`LAYOUT-005`） |
| 3 | `entries.json:7` ssot 指针 + `[DESIGN-ARCH-117]` 头注/§四 订正 + 两处 `00_INDEX` 登记 | 真源文档订正与索引属实施期人批动作（步骤 6 / C5） |
| 4 | `KNOWN-EXCEPTIONS` 首条的 `owner` 与 `expiry` | 只有 owner 能定期限 |
| 5 | 计量落盘形态：(a) 单文件 + 跨进程锁 vs (b) 按 writerId 分文件 + 读侧合并；以及 user-home 段 schema 是否与 phone-discovery 合并一次裁决 | 会改数据文件格式（T 档语义 + 备份归属） |
| 6 | 端口顺延（+10）与「第二实例拒绝」的关系：建议租约判定先行、顺延只用于同一 owner 内重试 | 改既有端口韧性契约 |
| 7 | DeepSeek / Together 计价从 default 粗价回到文档价（收敛的附带行为修正） | 改用户可见计费数字 |
| 8 | desktop / provider-hub 的组合态装配形态：attached host 改造 vs 本阶段不装配 | 决定「单窗口」适用范围与改造预算 |
| 9 | #3 判据的退役时机 | 判据寿命属治理决定 |
| 10 | Windows PID 复用口径（接受「心跳 + epoch + 三字段指纹」还是要求平台原生锁）；凭据是否引入 OS keychain/DPAPI；agentbus 车道归置（20 处 `KHY_AGENTBUS_*`、无 token/无 auth）；LAN TLS；插件 worker/vm 崩溃隔离；GUI 端验收手段；`pluginStore`/ecoMarket 降级节奏；ai-backend 第二套网关的归并节奏 | 均涉既有对外行为、安全语义或新工程立项 |
| 11 | entry-buffer 余量 54：S1 的 core 文件规模上限是否由人给数（超即先降基线） | 基线调整是人的决定 |
| 12 | `check:manifests` 是否在 S1 就接进 pre-commit（门档改动）；`--strict` 何时开 | `PROCESS-008` 升阶是人的决定 |

---

## 17 修订记录（v1 总案 → v2 收口稿）

| # | 改了什么 | 落点 |
|---|---|---|
| N1 | §0 全部换成本会话实跑的 **9 条命令（B1–B9）** + 退出码 + 明细（v1 §0 的 M1–M24 压缩为 B1–B9 + §0.1/§0.2/§0.3，并标易漂列） | §0 |
| N2 | D1–D10 由「建议 + 待点头」改为**已定稿口径**（用户 2026-11-16 授权 AI 决策），每项补 rollback/reversible；五处仍需人批的部分**单列** §16-B | §1 |
| N3 | 新增 §2 未闭合项收口表：评审 21 条逐条 closed/deferred（任务书写 12 条，材料实为 21 条，以材料为准），并给出每条在终稿的位置 | §2 |
| N4 | 现状校准表重排（行序连续、重复列举改引编号、`@khy-os/*`/`build.files`/闭包体量各只列一次）；新增 verdicts 层级表；行号全部重取（fork `:799`/`:827`、`AI_MGMT_HOST :314`、`serviceDefaults:313-314`） | §3.1–§3.3 |
| N5 | 落点表按 D1 改写：core 子路径由 3 个增为 **6 个**（`contracts/core-env`、`locator-host` 新增）；composer 落点由 `backend/src/services/composer` 改为 **`apps/suite/src/composer/`**（理由 = 去掉 R1 豁免 + 避 cross-layer-require 零余量）；DOMAIN-DEPS 由「D1/D3 各加一条」改为 **不改、严禁加 D3**；合规四件套收敛为**三件套**（contracts 不再单独挂 D3 manifest）；版本轨道由「G2 +1 源」改为 **不并 G2** | §4.1、§5 |
| N6 | 机判防线：执行器明确为**新增 `check-core-boundary.js`**（v1 §3.2 已改，但 §10.1 R1–R4 仍留「挂既有规则」的前言口径 → 本稿删除前言旧写法）；新增子档 A/B/C/T6/metering；判据 #4 明确「**冷**闭包」与迁移期限定 | §4.3、§11.2 |
| N7 | 租约：由 v1「四类取约者共用一把全局锁」改为 **L1–L9 作用域规则**（独立态不抢、不读、可并存；`mode` 字段；实例 id 唯一性只对 composed-shared 断言，字段名统一 `coreId` 见 §1.2 偏离 2）；口号加「组合态」限定词 | §7.1、§7.2 |
| N8 | 计量：写者由「2 份」扩为 **2 活跃 + 1 休眠（khyquant）+ usageTracker 定价/jsonl 面**，待并定价副本 **3 份 + 1 已委托点**并分 model/provider 键域；三证③按形态判定；补 `metering-second-core` | §4/D4、§7.3、§1.2 偏离 3 |
| N9 | 例外载体：由「挂 ARCHITECTURE-POLICY.exceptions（死字段）」改为**新立 `KNOWN-EXCEPTIONS.json`** + 消费者 + 「表与消费者未同批则 T6 不判绿」 | §7.5、§12 |
| N10 | 清单：DATA-SSOT 口径由「投影登记为授权镜像」改为 D2 最小替代（sources 7 + 可选 json-count fact + schema/词表 fact/mirror 且**不进 sources**）；TM-1 理由改写；`checks-run` 取代 finding 计数做样本键 | §6.3、§6.4 |
| N11 | 生态：新增通道 (a) 的决定与「今天不可安装」硬前置；`validateTerminalManifest`/JS 子路径按 X3 收窄；档 2 的 bundled 入口与 `CORE_LOCATOR_FAILED` | §8.1、§8.2 |
| N12 | 执行路线：A3 登记件按 D1 重写（含 backend 依赖双件套与白名单 S1 必做）；B 阶段补 **B6 计量、B7 发布面、B8 网关切分**；C 阶段 C5/C6 拆分并标人批 | §10 |
| N13 | 规则与守卫：新增 §11（一执行器一机制、四条件、PROCESS-008 六红线逐条对应、毕业四张草案标「不随 S1」） | §11 |
| N14 | 门禁表逐行标「今天是否存在 + 本轮实测读数 + 施工口径」，并把 `docs:verify` 与 `check:data-layout` 纳入；写明 S1 盲区（ruleguard/pre-commit 看不见新机制） | §12 |
| N15 | 前置表与 `decisions-v2` §4 的 10 条逐条对齐并各挂本轮实测支撑；风险表去重压缩为 9 条 | §13 |
| N16 | 禁止事项补 #5「核心不得承载终端业务」的机判化、#9 终端互不引用、#16「不得把未跑写成通过」；#4 明确本稿对 L0/L1/L4 零动作 | §14 |
| N17 | §16 拆成「本稿未覆盖（10 项）」与「仍待人工（12 项）」两张，杜绝含糊 | §16 |
