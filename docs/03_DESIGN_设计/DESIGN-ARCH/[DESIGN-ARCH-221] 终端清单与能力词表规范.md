# [DESIGN-ARCH-221] 终端清单与能力词表规范（khy.terminal.json 设计稿 v2）

> 产出：2026-11-17 · 角色：终端清单规范修订者（工作流子任务）
> 关系：**v1 `terminal-manifest.md` 原样保留**（不改、不删），本稿是它的修订稿，
> 只改被点名的问题（§0 修订表 R1–R7），未被点名的节**沿用 v1 原文**，逐节点名。
> 上游口径：`decisions-v2.md` 的 D1–D10（本轮已实读）；产品意图 2026-11-16（一核心+多终端）。
> 证据口径：仓库实测 > 产品意图 > 方案原文。每个结论给仓库相对路径 + 行号，或本轮实跑命令与输出；
> 没读到的写「未核实」；不声称任何门禁已绿（基线读数见 §11）。
> 编号：规范篇 = **[DESIGN-ARCH-221]**（§0 R3；写前实测，见 §11-1）。
> 本稿只写 `.khyos/refactor-drafts/`；生产代码、登记表、索引、版本号均未改动。

### 0.0 复核修正（2026-11-17 第二轮；只改被点名的六处，其余保留）

| # | 位置 | 问题 | 修正 |
|---|---|---|---|
| X1 | §5.2 / §5.3 机制登记 | `samples.source.key=counts.entry-matrix-stale` 是 finding 计数，结构上限 1，PP-2 用实测值比 200（`check-rollout-stage.js:90` 的 `{S1:200,S2:50,S3:20}`、`:399-410`、`:429-438`）⇒ 毕业机械上不可达 | 改用「每次运行的断言计数」`counts.checks-run`（算式写进 §5.2，常态约 200 上下、可随词表/能力面增长）；`observed` 保留 0 作占位但注明「落地首跑必须回填实测数字」；补 PP-1/PP-2 的逐行依据与「为什么不能用 finding 计数」 |
| X2 | §9.5 ② 示例 | `status:"planned"` 无 `statusNote`，与 §2.2「非 ready 必填」冲突；`entries.json` 现有 7 条实测全部带 `statusNote` | 示例补 `statusNote`；§9.5 ③ 增加 `status`/`statusNote` 规则一条 |
| X3 | §9.1 exports / A2 | 声明 `"./terminal-manifest": "./terminal-manifest/index.js"`，但 §5.4 生成器只产两份 JSON，无任何步骤产出 `index.js`；档 1 又把 `validateTerminalManifest` 当包内容 | 删掉 JS 子路径，exports 只留 `.` + 两个 JSON 子路径；A2 改为 `require.resolve` 两个 JSON；档 1 与 §9.5 ④ 统一写明 `validateTerminalManifest` 不在本批及将来落地的前置顺序 |
| X4 | §5.1 / §5.2 / §5.4 / §0.4-2 | `sdk-dist-stale` 双发射器（gen --check 与 check-manifests 各说一次） | 钉死**唯一发射器 = `check-manifests.js`**（counts 契约提供者）；`gen-entry-matrix --check` 改为只以非零退出码表达 |
| X5 | §5.4 / §8 场景 1 | 生成器输入固定 7 份清单、投影只含 7 端，却要求新增 `demo-terminal` 后 `entries` 出现该端——断言不可能 PASS | 生成器显式声明 `const TERMINAL_MANIFESTS = [...]`（顺序即投影顺序），新增仓内端必须同批改该列表；场景 1 补此前置，并把生态端改用 `KHY_TERMINAL_ROOTS` + `--root --loose` 验收 |
| X6 | §0.4-3 / §1.3 | schema / 词表两份手写真源在 DATA-SSOT 零锚点（既不进 sources[] 也不进 facts[]） | facts[] 各登记一条：`capability-vocab-size`（json-count `/capabilities`）与 `terminal-manifest-schema-version`（json-pointer `/properties/schemaVersion/const`，带 `detect.identifiers:["schemaVersion"]` 并把 `detect.paths` 收窄成两个精确文件——不能写目录前缀，否则 `$schemaVersion` 三行会误判矛盾），分发副本以同 kind/pointer + reason 登记为 mirror（长度/标量级锁步）；仍不进 `sources[]`（避免 D4 把逐字节副本判 `ssot-source-shadow-copy`）；内容级边界如实写清，列为 §10-10 待确认 |

---

## 0. 修订表（v1 → v2，逐条留痕）

### 0.1 被点名的七项

| # | v1 位置 | v1 写法（问题） | v2 定稿口径 | 本轮证据 |
|---|---|---|---|---|
| R1 | `terminal-manifest.md:56` | 「也可以不登记（`entries/` 不在 facts 语料里，现状即如此）」——**与实测相反** | `entries/` **在**语料内（`scan.include` 有它）；不判红的真实原因是：facts 影子扫描按**已登记 fact 的 `detect.identifiers`** 锚定，11 条 fact 无一锚定 `entries/entries.json`，无 matcher 即 `continue`。改写见 §1.3 | `DATA-SSOT.json:14` 含 `"entries/"`；`check-ssot-data.js:135-142` 的 `inInclude('entries/entries.json')` 复算 = **true**（本轮 node 复算）；`ssotDataGuard.js:615-617`（`if (!matcher) continue`）；11 条 fact 的 identifiers/paths 全量打印（§11-3）——9 条端口常量名 + `runtime/`/`delivery/`/`apps/` 作用域，2 条 json-count 无 identifiers |
| R2 | `terminal-manifest.md:315` | `samples.source.key: "findings"`——`findings` 是**数组** | 改 `counts.<finding-id>` **标量**；`check-manifests.js --json` 的 `counts` 键名全列（§5.2），每个 finding id 一个整数键（0 也要在） | `check-rollout-stage.js:157-168`：`pickKey` 逐段下钻，`:165-167` 对 `typeof cur === 'object'` 判「不是标量读数」；既有三个合法先例 `FEATURE-OWNERSHIP` 的 `domain-direction-guard` / `functional-unit-guard` / `entry-buffer-guard`，key 全为 `counts.*`（本轮解析 40 条机制实测）；`check-repo-layout.js --json` 的 `counts` 就是「一个 finding id 一个计数」（本轮实跑） |
| R3 | `terminal-manifest.md:21/:197/:201/:305/:383/:474` | 规范篇编号写 218（「下一可用编号实测 218」）；218 实占、219 被总案占用 | 规范篇 = **[DESIGN-ARCH-221]**；落盘前重测，被占顺延 | 本轮实跑：`DESIGN-ARCH` 共 **214** 篇 `.md`、最大编号 **219**；`[DESIGN-ARCH-219] 一核心+多终端重构施工总案.md` 存在；**220/221/222/223 全空闲**（输出见 §11-1）。218 已占见 `docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-218] 单模型直通与路由可解释性方案.md` |
| R4 | `entries/entries.json:7`、`[DESIGN-ARCH-117]:5` | ssot 指针失实；117 头注「改端先改数据表」与 A 方案相反 | 列入**迁移批步骤 6（人批留痕）**：`meta.ssot` → `docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-117] khy-多端入口矩阵.md`；117 头注翻转为「改端先改终端清单 + 重跑生成器」，§四 schema 表同批；两处 `00_INDEX` 登记 | `entries.json:7` 原文 = `docs/03_DESIGN_设计/[DESIGN-ARCH-117] khy-多端入口矩阵.md`；`fs.existsSync(顶层)=false`、`fs.existsSync(DESIGN-ARCH 子目录)=true`（本轮实测）；`[DESIGN-ARCH-117]:5` 原文「两者是『规范 ↔ 落地』关系，不是两份真源：改端先改数据表，改约定先改本文件」；主索引已登记 219（`docs/00_INDEX_文档索引.md:201`），子索引同轮 grep 未见 219 行（落盘时按 MGMT-STD-007 R4 一并处理） |
| R5 | `terminal-manifest.md:459-463`（§9.4 三选一）、`:471`（§10-3） | 分发通道「(a)/(b)/(c) 三选一，待拍板」 | **已拍板 (a)**：`@khy/plugin-sdk` 补 `files`/`exports`/`publishConfig`，与 `@khy/core` **同批 npm 发布**（对齐 D1 档 1）；(c) 降为档 2 机制、不单独立项；schema/词表以**生成副本**随包分发，锁步由生成器 + `check-manifests.js` 承担。验收见 §9.1，与 D1 两档发布逐条对齐 | `plugin-sdk/package.json:1-16` 实测无 `files`/`exports`/`publishConfig`；`works/ship/npm/package.json` 的 `files = ["bin/","bundled/","scripts/postinstall-compress.js","scripts/install/enable-fs-compression.sh"]`、`name=@khy-os/khy-os`、`version=1.2.2`；根 `install:core = corepack pnpm install --frozen-lockfile --filter …` |
| R6 | `terminal-manifest.md:306/:322/:326-334` | S1 期「不新增规则 ID」但机制 `rules:["LAYOUT-008"]`；毕业期 LAYOUT-009 未写「先退役一条」的硬顺序 | 与 D3 统一：机制 `rules: []`；S1 不新增规则 ID；**毕业（S3）才新增 `LAYOUT-009`，且必须同批退役/合并一条既有规则**（PROCESS-014），退役候选由人定 | 本轮实跑 `check-delivery-baseline.js --json`：`ruleCount=101/94`（另三项 `routerCommands=249/245 · aliasEntries=595/591 · handlerFiles=167/155`），finding `delivery-surface-ratchet-breach`，stage=S1；`RULES-REGISTRY.json` 实测 101 条，LAYOUT 域只有 001–008（`LAYOUT-009` 空闲）；`check-rollout-stage.js:442-459` 的 PP-3 只复算 `rules[]` 强度 |
| R7 | v1 全篇（§9 只有「设计契约」与「发现根」，无最小示例） | 第三方接入只有原则，没有可照抄的目录/清单/校验命令 | 新增 **§9.5 最小示例**：目录结构、`khy.terminal.json`、能力声明、校验命令（第三方侧 + 仓内 fixture 侧）、7 步接入；全部路径为**包内相对路径**，不出现 monorepo 路径 | `plugin-sdk/index.js:20-23` 自述「零依赖、require 时无副作用（无 fs/网络/env 读取）」——示例因此不把 ajv 塞进 SDK 的运行时依赖；ajv 6 API 本轮实跑确认（§11-2）；发现根 v1 只有 env（`KHY_TERMINAL_ROOTS`），不新增未登记落点（`DATA-LOCATIONS.json` roots 实测无 terminals 类的既有事实由 v1 给出，本轮未复跑） |

### 0.2 对齐决策的改动（不带新问题，但会改变 v1 文字）

| # | 位置 | 改动 | 依据 |
|---|---|---|---|
| A1 | §2.2 / §4 | `coreVersion` 只协商 **G1**；`@khy/core` **不并入 G2**、不改 `check-version-sync.js` 的 10 源；core 起步版本与轨道归组**人拍板**。v1 §4.1 的「只协商 G1」保留，补一句「D1 已裁决不并 G2」 | D1；`check-version-sync.js` 本轮实跑输出 G1=1.2.2 / G2=1.6.5 / G3=0.1.0（§11-4）；`core-handle.md:750` 仍写「`@khy/core` 入 G2」→ 落盘折叠 220 时改，本稿只标注 |
| A2 | §1.3 | DATA-SSOT 登记口径按 D2 + 本轮复核改写：**投影不登记为授权镜像**（聚合不是标量）；schema/词表各登记一条标量级 fact + 分发副本 mirror（长度/版本级），详见 §0.4 第 3 条与 §1.3-4 | D2；`ssotDataGuard.js:52/:428-457/:440-443/:499-534` |
| A3 | §5.2/§5.3 | `--json` 契约必须含 `counts`（每 finding id 一个标量）；机制 `rules: []`；`GUARD_STAGE='S1'` 字面常量、S1 恒 exit 0、finding 一律 warning、不进 `LAYOUT-001` 的 `--promote=` 名单 | D3；`LAYOUT-001` 实测 gate=pr、priority=P1、无 severity（派生 blocking）、`exec.args` 含 `--promote=root-whitelist,docs-index-first,layer-registry`；`LAYOUT-008` 实测 severity=advisory |
| A4 | §7.2 步骤 2 | 拆表时 **web-quant 清单的 `artifactOutput` 写 `quant-frontend-dist`**（由清单承载、生成器投影，不手改 `entries.json`）；khyquant 的 dev 脚本**本轮不改**（生产代码只读边界） | D7；`BUILD-OUTPUTS.json` 实测 `quant-frontend-dist → entries/quant-frontend`、`rebuild=npm run build --prefix delivery/channel/khyquant/frontend`、`inBuildAll=true`；`entries.json` 的 web-quant 实测 `artifactOutput=null, ports=[]`；`delivery/channel/khyquant/frontend/package.json` 的 `dev` = `vite --host 0.0.0.0 --open`（`dev-no-browser`/`dev-auto-port` 同为 `0.0.0.0`） |
| A5 | §6 / §8 | 验收与用户可见路径只用 `npm run` 脚本 + `node --test`，引用既有 `khy doctor` / `khy entry`；**不新增任何 CLI 命令**（D5）；单实例/计量的任何断言在 D4 收敛前一律报 `metering-dual-writer` | D4/D5；`runtime/node/backend/src/cli/handlers/entrypoints.js` 存在（v1 转录，本轮未复跑） |
| A6 | §6 | 组合态对**自己拉起的 listener** 注入 `AI_MGMT_HOST=127.0.0.1`，仲裁顺序 = 用户显式 env > suite 注入 > `serviceDefaults`；ai-backend 的 `0.0.0.0` 默认保留、登记进 `KNOWN-EXCEPTIONS.json`（清单侧不新增字段） | D6；`runtime/node/ai-backend/server.js:124-138`（v1 未读，本稿未复读——按决策原文引用，标注为转录） |
| A7 | 全篇 | 编号、suite（222）、`apps/suite` workspace、`BUILD-OUTPUTS` 的 `electron-out`/`electron-dist` rebuild 修正等属 219/222 的范围，本稿只在迁移批引用，不重复设计 | D8/D10；`BUILD-OUTPUTS.json` 实测两条 rebuild 仍为 `pnpm run build --filter khyos-desktop` |

### 0.3 顺带更正的事实（不改裁决，只防下一手照抄错）

| # | v1/输入材料 | 实测更正 |
|---|---|---|
| F1 | v1:63「投影元数据不能丢：`meta.kinds/statuses/modes`」 | 三块枚举是 `entries.json` 的**顶层键**，不在 `meta` 下：顶层键实测 `[meta, kinds, statuses, modes, entries]`，`kinds` 在 `:18-23`、`statuses` 在 `:24-29`、`modes` 在 `:30-34`；`registry.js:413-417` 按 `raw.kinds/raw.statuses/raw.modes` 读。生成器必须产**顶层**三块（与 D2 的「顶层枚举」一致），v1 的 `meta.` 前缀是笔误 |
| F2 | v1:159「135 个点分 id 中有 32 个含段内连字符」 | 今日实测 `ATOMIC-CAPABILITIES.json` 的 `capabilities` = **137** 条、含连字符 **34** 条、对 §3.1 修正正则 **0** 条不匹配（§11-5）。结论不变，数字更新；词表校验以此为准时请重测 |
| F3 | `assets-facts.json:165`「`pnpm-lock.yaml` 的 importers 与 9 个包一一对应」 | 今日实测 **7 个 importer**：`.`、`delivery/channel/khyquant/frontend`、`delivery/web/ai-frontend`、`delivery/web/provider-hub`、`runtime/node/ai-backend`、`runtime/node/backend`、`runtime/substrate/platform/packages/shared`（§11-6）。`ui-shared`/`plugin-sdk` 的 importer 本就缺失，与 decisions D1 的读数一致；facts 文件那行是错的 |
| F4 | v1:345 引 `atomicCapabilityRegistry.js:1985-1986` 作 version/updated 常量 | 今日实测常量在 `scripts/lib/atomicCapabilityRegistry.js:2013-2014`（`version: '1.0.0'`、`updated: '2026-10-30'`）；行号随文件生长漂移，落盘引用请以当时实测为准 |

---

## 0.4 三问直答（ask 明确要求：入库 / 逐字节复算 / DATA-SSOT 授权镜像）

1. **生成物是否入库：是。** `entries/entries.json` 作为 7 份 `khy.terminal.json` 的机器投影**入库**。理由：读取方横跨 L1（Python 启动器）/ L2（`entrypoints` 服务）/ 横切（scripts、文档），checkout 后不跑生成器也必须可用；先例是同样入库的生成物 `docs/10_规范/registry/ATOMIC-CAPABILITIES.json`（`:12-15` 自述「本文件是生成物……不要手改本文件——改 ATOMIC_GROUPS 后重跑生成器」，守卫 `scripts/ci/check-atomic-capabilities.js`）。
2. **如何逐字节复算：** `node scripts/ci/gen-entry-matrix.js --check` —— 生成器在内存里重建三份产物（投影 + 两份分发副本），与盘上文件做**原始字节比较**（不做 JSON 语义归一），不等则以**非零退出码**表达（本地便利入口，不发射规则 finding）。**finding 的唯一发射器是 `check-manifests.js`**（它是 `counts` 契约的提供者）：`entry-matrix-stale` 判投影、`sdk-dist-stale` 判两份副本。字节规则钉死：2 空格缩进、LF、文件末尾单换行、键序按生成器源码固定顺序（不写时间戳；`meta.version` / `meta.updated` 是生成器里的手写常量，先例 `atomicCapabilityRegistry.js:2013-2014`）。执行面 = `pr-gate.yml` 显式步骤（形状照 `:279-280` 的 atomic 步骤）。
3. **在 DATA-SSOT 如何登记为授权镜像：投影不能登记为授权镜像；分发副本只能登记为「标量级」mirror。** 「授权镜像」是 `facts[].mirrors[]` 的概念，判据是「同一**标量**事实的另一处表述」：每条 mirror 必须给 `kind`（6 种取值之一）+ `pointer` + `reason`（`ssotDataGuard.js:52`、`:444-457`），且镜像失步按标量值比对（`:580-611`）。投影是 **7 份清单 → 1 份聚合**，不是标量事实：
   - 走 `json-pointer` 且 `detect.identifiers=[]` → `ssot-registry-invalid`（缺 identifiers，`:441-443`）；`exempt` 不是合法 `kind`（`:52` 的集合里没有它）。
   - 走 `json-count` 合法，但 `json-count` 只判「真源自洽」，**没有影子副本这一层**（`:440-443`、`:283-293` 只取数组长度）。
   - 因此 v1 的「投影登记为授权镜像」设想不可行，D2 的替代口径成立：**7 份清单路径进 `sources[]`（title 标明真源）**；`facts[]` **可选**登记一条 `terminal-matrix`（`ssot.kind="json-count"`、`pointer="/entries"`，note 写明「不提供影子副本保护，锁步由 `check-manifests.js` 的 `entry-matrix-stale` 判、`gen-entry-matrix --check` 同口径本地复算」）；投影锁步由生成器承担。**`entries.json` 本身不进 `sources[]`**（它不是真源；D4 的整文件指纹只对 `sources[]` 生效，投影不需要这层）。
   - **额外的坑（本轮实测发现，必须写进 221）**：若把 `TERMINAL-MANIFEST.schema.json` / `CAPABILITY-VOCAB.json` 登记进 `sources[]`，则 D4 会把**同批分发的逐字节副本**（§9.1 通道 (a)）判成 `ssot-source-shadow-copy`（error）——`ssotDataGuard.js:499-534` + `check-ssot-data.js:263-269`（指纹语料 = 全仓所有 `.json`）+ `:131-137`（`canonicalJson` 先归一，键序/空白不同也算同指纹）。⇒ 这两份**不进 `sources[]`**。
   - **但两份手写真源不能零锚点**：改用 `facts[]` 各登记一条（facts 不参与 D4——D4 的指纹源只从 `sources[]` 建，`:501-516`，所以副本可保持逐字节一致而不会误报）：
     1. `capability-vocab-size`：`ssot = {path:"docs/10_规范/registry/CAPABILITY-VOCAB.json", kind:"json-count", pointer:"/capabilities"}`；`mirrors = [{path:"runtime/substrate/platform/packages/plugin-sdk/terminal-manifest/capability-vocab.json", kind:"json-count", pointer:"/capabilities", reason:"独立 npm 包物理无法 import 仓内 registry；长度级锁步，内容级由 check-manifests 的 sdk-dist-stale 承担"}]`。`json-count` 允许 `identifiers` 为空（`:441-443` 只对非 json-count 强制）。
     2. `terminal-manifest-schema-version`：`ssot = {path:"docs/10_规范/registry/TERMINAL-MANIFEST.schema.json", kind:"json-pointer", pointer:"/properties/schemaVersion/const"}`；**必须**带 `detect.identifiers:["schemaVersion"]`（非 json-count 的事实无 anchors 直接判 `ssot-registry-invalid`，`:441-443`——本稿前一版「json-pointer 无 identifiers」是非法形态），且 `detect.paths` 必须收窄成**两个精确文件**：`["docs/10_规范/registry/TERMINAL-MANIFEST.schema.json","runtime/substrate/platform/packages/plugin-sdk/terminal-manifest/terminal-manifest.schema.json"]`。**不能写目录前缀**：`buildIdentifierMatcher` 的负向后顾只排除 `[A-Za-z0-9_]`（`:325`），`"$schemaVersion": "1.0.0"` 会被当作 `schemaVersion` 命中（`MEMORY-RECORD-SCHEMA.json` / `PROPOSAL-ARTIFACT-INDEX.json` / `SOURCING-PROVENANCE.json` 实测各有一行），而对象属性形态会抽出 `1.0.0` 与真值 `1` 矛盾 → `ssot-value-contradiction`（error）。精确路径下真源与 mirror 都在排除集内（`:622`），标识符在这里主要满足登记形态，真正的锁步是 mirror 的标量比对（`:580-611`）+ `sdk-dist-stale`。mirror 指向副本同指针 + reason 同上。前提：schema 里 `schemaVersion` 写成 `const: 1`（v1 §2.2 已定「恒 1」）；若实现成 `enum`，指针改 `/properties/schemaVersion/enum/0`（JSON Pointer 支持数组下标，`:147-157`）。
   - **能力边界如实写清**：这两条 fact 只给**长度 / 标量级**锁步（`json-count` 只判真源自洽与长度相等——`ssotDataGuard.js:440-443`；`json-pointer` 只比一个标量）；**内容级**（改一条能力的语义、改一个枚举）DATA-SSOT 看不见，唯一防线是 `sdk-dist-stale` 的逐字节比对（S1 不阻断）。这是本仓 fact 模型的已知边界，不假装它更强。

---

## 1. A / B 裁决（v1 §1 沿用；§1.3 重写）

### 1.1–1.2 沿用 v1 原文

- 冲突本体、A/B 定义、「为什么不是 B」三条理由：**沿用 `terminal-manifest.md` §1.1–§1.2 原文**（未发现新证据推翻）。
- 补充一条实测（不改结论）：`layout-facts.json:190` 判 `apps/*/khy.terminal.json = duplicate` 的前提是「`entries.json` 仍是手写真源」；A 把 `entries.json` 降为生成投影后该前提消解。翻转理由须在 221 正文显式记录，防两份文档各说各话（D2 的 rollback 同旨）。

### 1.3 为什么是 A，以及它与 LAYOUT-008 / check:ssot-data 的真实关系（v2 全文替换）

A 的形态：**每端一份 `khy.terminal.json` 承载该端声明的全部事实；`entries/entries.json` 是这些清单的机器投影（生成物），入库、逐字节可复算。**

- **为什么不是影子副本**：LAYOUT-008 判的是「同一数据事实在真源之外再写一遍」。投影是同一真源的**单链派生**，带逐字节再生成校验；生效先例两处：
  - `docs/10_规范/registry/ATOMIC-CAPABILITIES.json:12-15`（生成物自述 + 改真源后重跑生成器）；
  - 规则卡：登记表改动后必须重跑 `npm run docs:rules-cards`，`check:rules` 做逐字节比对（AGENTS.md「规则遵守保障」节）。
- **生成物入库 / 逐字节复算 / DATA-SSOT 登记**：见 §0.4（三问直答）。
- **`entries/` 与 `check:ssot-data` 的真实关系（v1 此处写错，按本轮实测重写）**：
  - `entries/` **在** `scan.include` 里（`docs/10_规范/registry/DATA-SSOT.json:14`），`entries/entries.json` 也确实进语料（`scripts/ci/check-ssot-data.js:135-142` 的 `inInclude` 复算 = true，本轮 node 复算）。
  - 它**不被判**，是因为字段级影子扫描按**逐条已登记 fact 的 `detect.identifiers`** 锚定：`ssotDataGuard.js:615-617` 先 `buildIdentifierMatcher(detect.identifiers)`，取不到 matcher 就 `continue`。11 条 fact（本轮全量打印，§11-3）里 9 条 `js-const` 的 identifiers 是端口常量名、2 条 `json-count`（`rule-count` / `amoo-tool-contract`）identifiers 为空；`detect.paths` 只覆盖 `runtime/` / `delivery/` / `apps/`（两条 json-count 无 paths）——**没有一条指向 `entries/entries.json`**。
  - `detect.paths` 的作用域过滤（`:626` + `:729-736` 的 `pathAllowed`）是**事实级收窄**，不是语料闸门；「entries 在不在语料」由 `scan.include` 决定（`check-ssot-data.js:124-142`）。
  - D4 的整文件指纹（`ssotDataGuard.js:499-534`）只对 `sources[]` 登记的文件生效；`entries.json` 不在 `sources[]`，故也不走这一层。
  - ⇒ 准确结论：**LAYOUT-008 不会对 manifest ↔ 投影报红，原因是它没有锚点可见（不是「entries 不在语料」）。** 这层唯一机器防线是 `check-manifests.js` 的 `entry-matrix-stale` / `sdk-dist-stale`，而它在 S1 期恒 exit 0、不阻断（§5.3）。S1 期「手改 `entries.json` / 改清单不重跑生成器」**没有任何门会拦**——pr-gate 只打印 finding，靠评审兜底。是否在 S1 期就接进 pre-commit 是门档改动，须人批（v1 §10-8 保留）。
- **登记表写法（D2 定稿）**：
  1. `DATA-SSOT.json` 的 `sources[]` 增补 7 份 `khy.terminal.json` 路径（`kind: "json"`，title 标明「终端清单（编写真源）」）。**顺序约束**：该增补必须与 7 份清单同 PR 落地——`sources[]` 登记后文件缺失会报 `ssot-source-missing`（error，`ssotDataGuard.js:502-510`）。
  2. `facts[]` **可选**登记一条 `terminal-matrix`，唯一合法形态 `ssot.kind="json-count"` + `ssot.pointer="/entries"`（`declaredPointer` 省略——投影里没有声明字段），note 写「本事实不提供影子副本保护，锁步由 `check-manifests.js` 的 `entry-matrix-stale` 判、`gen-entry-matrix --check` 同口径本地复算」。**不提供保护**是 `json-count` 的语义决定的（`:440-443`）。登记它的意义只是「在 DATA-SSOT 留下端矩阵这条数据事实的名录锚点」。
  3. `entries.json` 与 schema/词表**都不进 `sources[]`**（理由见 §0.4 第 3 条的「额外的坑」）。
  4. schema/词表**各登记一条 fact + 分发副本 mirror**：`capability-vocab-size`（`json-count` `/capabilities`）与 `terminal-manifest-schema-version`（`json-pointer` `/properties/schemaVersion/const`，**带 `detect.identifiers` + 收窄 `detect.paths`**，否则非法或误报，细节见 §0.4 第 3 条），mirror 的 `reason` 写「独立 npm 包物理无法 import 仓内 registry」。它们只提供**长度/标量级**锁步；内容级由 `sdk-dist-stale` 的逐字节比对承担（§0.4 第 3 条）。

---

## 2. schema（ask 第 1 问；沿用 v1 §2，三处微调）

- **文件名与落点（7 份）**：沿用 v1 §2.1 表（`runtime/substrate/platform/khy_platform/`、`runtime/node/backend/`、`apps/khyos-desktop/`、`delivery/web/provider-hub/`、`delivery/web/ai-frontend/`、`delivery/channel/khyquant/frontend/`、`delivery/mobile/khy-os-client-app/`）。
- **字段表**：沿用 v1 §2.2 全表（`schemaVersion/id/kind/title/artifactKind/coreVersion/embed/capabilities/entry/launch/build/artifactOutput/ports/status/statusNote/delivery/notes/compose`）。本轮对表内三点只做**规范澄清**，不改字段：
  1. `coreVersion` 语义 = **只协商 G1**；`@khy/core` 不并入 G2（A1）。
  2. `artifactOutput` 一律写 `BUILD-OUTPUTS.json` 的 **id 指针**（v1 已写）；web-quant 的首个取值是 `quant-frontend-dist`（A4）。
  3. `status` / `statusNote` / `notes` 随端搬进清单（v1 §1.4-2 保留）。
- **`kinds/statuses/modes` 的位置（F1 更正）**：这三块是 `entries.json` 的**顶层键**（`:18-34`），生成器从 schema 渲染进投影顶层；`registry.js:413-417` 按 `raw.kinds/raw.statuses/raw.modes` 读取，`launcher.js:70-71,117` 消费 `plan.mode`（`attach`/`wait`/`detach`，文档见 `launcher.js:7-9`）。
- **schema 单一结构真源**：`docs/10_规范/registry/TERMINAL-MANIFEST.schema.json`（JSON Schema，含全部枚举 + `coreVersion` 的 `pattern`）。三个消费者读同一文件：`check-manifests.js`（ajv 校验）、`gen-entry-matrix.js`（渲染三块枚举）、第三方（用 §9.1 分发的 schema 副本 + 自带 ajv 校验；`validateTerminalManifest` 不在本批）。ajv 实测可从仓根解析（根 devDependencies `^6.15.0`，`require.resolve` 成功）。
- **embed.mode 硬约束**：沿用 v1 §2.4（`web|mobile + embedded` → `manifest-embed-invalid`；web 端不可 embedded 的实测闭包证据见 v1 §2.4）。

---

## 3. capabilities 与词表（ask 第 2 问；沿用 v1 §3，数字与分发更新）

- **命名规约**：沿用 v1 §3.1 的正则 `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*){1,2}$`。今日复测：对 `ATOMIC-CAPABILITIES.json` 的 **137** 条 id **0 条不匹配**，其中 **34** 条含段内连字符（F2）。
- **保留域 / atomic 对齐 / 生命周期**：沿用 v1 §3.1（`gateway.* session.* event.* usage.* config.* plugin.*` 为 core 保留域；`terminal.*` 不列入；同 id 必写 `atomicRef`）。
- **provides / consumes 语义**：沿用 v1 §3.2（`required` 无缺省；`required:true` 必须 `providedBy:"core"`，违反即 `capability-required-not-core`——这是「终端只带 core 也能独立运行」的静态判据）。
- **词表真源**：`docs/10_规范/registry/CAPABILITY-VOCAB.json`（手写真源；结构由 schema 校验；与外部分发副本的关系见 §9.1）。**规范篇 = 221**（R3）。
- **能力词表的四重同名消歧**：沿用 v1 §3.1 的对照表（ATOMIC-CAPABILITIES / FEATURE-OWNERSHIP `capabilities[]` / 两个 `capabilityRegistry.js` / 本稿的词表），落盘时放 221 首节。
- **既有第三方方言**：沿用 v1 §3.3 末段（`delivery/extension/tools/khy-markdown/khy.extension.json` 的自由 `capabilities/provides` 字段；是否并入同一规约为待拍板，§10-3）。

---

## 4. 版本协商（ask 第 3 问；沿用 v1 §4，补 D1 裁决）

- **G1 取值**：本轮实跑 `node scripts/ci/check-version-sync.js` → `Main package version: 1.2.2` / `AI-backend ecosystem version: 1.6.5` / `Browser UI shared package version: 0.1.0` / `All version sync checks passed.`（§11-4）。`coreVersion` **只绑 G1**。
- **不并 G2（A1）**：`@khy/core` 本重构**不并入 G2**、不改 `check-version-sync.js` 的 10 源；core 起步版本与轨道归组由人拍板。`core-handle.md:750` 的「`@khy/core` 入 G2（§2.3）」是待订正项，落盘折叠 220 时改（decisions D10 已列）。
- **运行时来源**：装配面从 G1 真源读（`runtime/node/backend/package.json` 的 `version`）；取不到一律 `core-version-source-unresolved` 响亮拒绝，**禁止回退默认值**（v1 理由：`plugin-loader/index.js:180` 的 `_hostVersion` 默认 `'1.0.0'` 会把 1.2.2 误判成 1.0.0——v1 转录，本稿未复读该行）。
- **文法钉死 + 不复用 `plugin-loader` 的 `satisfies`**：沿用 v1 §4.2。fail-open 证据本轮复读：`plugin-loader/index.js:97`「minimal implementation to avoid extra dependency」、`:106-109` 对匹配失败片段 `continue`（`^1.2.0` 会被静默判兼容）。两份实现（CI 侧 / core 侧）+ 共享测试向量锁步的代价与先例，沿用 v1 §4.2。
- **拒绝消息四要素**：沿用 v1 §4.2 的两段模板与「端 id / 声明 range / 实际版本 / 修复命令」机判。
- **多版本共存：不支持**：沿用 v1 §4.3 三条实测理由；补一句 D4：在计量写者收敛前，任何「单一 core 实例 + 一份计量」的宣称一律报 `metering-dual-writer`（`check-*` 的 finding 名，不是 CLI 命令，D5）。

---

## 5. 校验器 `scripts/ci/check-manifests.js`（ask 第 4 问；v2 重写 §5.1–§5.4）

### 5.1 检查项与 finding 码

| finding | 设计级别（S1 期一律按 warning 发射、exit 0；S3 起按下表判） | 判据 |
|---|---|---|
| `manifest-schema-invalid` | error | JSON 解析失败 / 必填缺失 / 枚举非法（按 `TERMINAL-MANIFEST.schema.json`，ajv） |
| `manifest-duplicate-id` | error | 清单间 id 重复，或清单 id 与投影条目 id 不一致 |
| `manifest-path-missing` | error | `entry.source` / `markers` / `entryFiles` 在盘上不存在（生态端在其发现根内解析） |
| `capability-name-invalid` | error | 不符合 §3.1 正则 |
| `capability-name-reserved` | error | 终端 `provides` 占用 core 保留域 |
| `capability-atomic-collision` | error | id 与 `ATOMIC-CAPABILITIES.json` 同名但未写 `atomicRef` |
| `capability-consume-shape-invalid` | error | consumes 项缺 `id` 或缺 `required`（boolean，无缺省） |
| `capability-unknown` | error | consumes 的 id 不在词表 |
| `capability-required-unmet` | error | required consume 的 id 不在词表 |
| `capability-required-not-core` | error | required consume 指向终端提供的能力（违反「只带 core 可独立运行」） |
| `capability-optional-unmet` | info | optional consume 无提供者（合法降级，报入口注销项） |
| `capability-provides-collision` | warning | 同能力被 ≥2 端 provides |
| `core-version-invalid` | error | 不符合 §4.2 钉死文法（含非 cli/cli-node 端写 `"self"`） |
| `core-version-unsatisfiable` | warning | range 与 G1（实测 1.2.2）无交集；`"self"` 跳过 |
| `manifest-embed-invalid` | error | `web|mobile` 声明 `embedded` |
| `entry-matrix-stale` | error | `entries/entries.json` ≠ 生成器再输出（原始字节） |
| `entry-matrix-orphan` | warning | 仓内出现端特征目录却无清单 |
| `vocab-entry-invalid` | error | 词表条目命名 / 生命周期 / 保留域非法 |
| `port-ref-unverifiable` | info | 仅 `--loose`：`ports[].ref` 不在生态档解析 |
| `sdk-dist-stale` | error | `@khy/plugin-sdk` 的 schema/词表分发副本 ≠ registry 真源（原始字节；§5.4、§9.1）。**唯一发射器 = 本脚本**；`gen-entry-matrix --check` 只以退出码表达，不另发 finding |

### 5.2 `--json` 契约（R2 定稿，**counts 键名全列**）

```json
{
  "stage": "S1",
  "findings": [ { "id": "<finding id>", "severity": "warning", "file": "<repo-rel path>", "line": 0, "message": "..." } ],
  "counts": {
    "manifest-schema-invalid": 0,
    "manifest-duplicate-id": 0,
    "manifest-path-missing": 0,
    "capability-name-invalid": 0,
    "capability-name-reserved": 0,
    "capability-atomic-collision": 0,
    "capability-consume-shape-invalid": 0,
    "capability-unknown": 0,
    "capability-required-unmet": 0,
    "capability-required-not-core": 0,
    "capability-optional-unmet": 0,
    "capability-provides-collision": 0,
    "core-version-invalid": 0,
    "core-version-unsatisfiable": 0,
    "manifest-embed-invalid": 0,
    "entry-matrix-stale": 0,
    "entry-matrix-orphan": 0,
    "vocab-entry-invalid": 0,
    "port-ref-unverifiable": 0,
    "sdk-dist-stale": 0,
    "checks-run": 0
  }
}
```

- 契约硬约束：**21 个 counts 键永远在**（零也要在），每个值是非负整数标量；`findings` 数组可以为空。其中 20 个键 = §5.1 的 20 个 finding id（每个一个计数），第 21 个 `checks-run` 是**每次运行的断言计数**（见下），不是 finding。理由：`check-rollout-stage.js:157-168` 的 `pickKey` 会逐段取数，`:165-167` 把对象/数组判为「不是标量读数」——键缺了报「输出里没有 counts.X」，值不是标量报「不是标量读数」，两种都会让完整档复算失败并报 `rollout-stage-samples-unverified`。
- **`counts.checks-run` 的语义与算式（毕业通道的输入，必须写死）**：本次运行**实际执行的断言数**，算式 = `Σ每份清单 × schema 实际 properties 数`（ajv 对每个属性执行 required/enum/pattern 判定，无论该属性是否出现）+ `Σ词表条目 × 3`（命名正则 / 生命周期 / 保留域）+ `Σ(provides+consumes) 条目 × 2`（命名/保留域与词表成员、atomic 对齐）+ `2`（两份分发副本的字节比对）。**不写死下限数字**：按 v1 §2.2 表 ≈20 个属性、7 端 × 每端约 6 条能力引用估算，常态在 **200 以上**；落地后用首跑实测值写 `observed`（必须是数字）。**不用 finding 计数做 samples 键的原因**：`entry-matrix-stale` 只有一个目标文件、健康态恒 0，结构上限 1；任何 finding 计数最多到「端数 × 每端条目数」（≤ 两位数），永远够不到 PP-2 的 200（`check-rollout-stage.js:90` 的 `GRADUATION_SAMPLES = {S1:200,S2:50,S3:20}`，`:429-438` 按**实测值**判）——那样的 key 会让 S1→S2 机械上不可达。若将来 checks-run 实测不足 200，PP-2 报 samples-insufficient 是**正确行为**（样本不足就不该毕业），补词表/加断言即可，不是结构性死路。
- 键名带连字符没问题：`pickKey` 只按 `.` 切段（`:159-163`），既有的 `counts.domain-direction` / `counts.entry-buffer` 等先例同形。
- 实现形状照 `check-repo-layout.js --json`：本轮实跑其输出为 `{counts, baseline, baselineUpdated, regressions, findings}`，`counts` 就是「一个 finding id 一个计数」（如 `counts.entry-buffer = 2416`）。

### 5.3 运行语义与接线（S1 三件套；R6 定稿）

- **S1 观察者：恒 exit 0**（PROCESS-008 PP-3）。执行器源码必须含字面常量 `const GUARD_STAGE = 'S1';`——`check-rollout-stage.js:484-524` 用正则定位它并比较阻断语义，找不到常量报 `rollout-stage-authority-drift`（warning）。正确先例：`check-ssot-data.js:47-48`（`STAGE='S1'` + `OBSERVER_STAGES`）、`check-data-layout.js:23`（`GUARD_STAGE='S1'`）。
- **finding 一律 `severity:'warning'`**，且**不进** `LAYOUT-001.exec.args` 的 `--promote=` 名单（该参数实测为 `--promote=root-whitelist,docs-index-first,layer-registry`，进名单即升 error；`LAYOUT-001` 无 severity、P1 ⇒ 派生 blocking）。
- `--changed`：commit 档只跑支持 `--changed` 的执行器（`scripts/ruleguard/lib/run.js:137-142`）；diff 触及 `entries/**`、任一 `khy.terminal.json`、registry 的 schema/词表、`scripts/lib/terminalManifest.js` 才跑全套，否则 exit 0。
- `--root <dir>`：对仓外 fixture 跑同一套检查（验收场景 2–4、第三方包根校验用）。
- `--loose`：生态档（§9.3）。
- **S1 盲区（如实声明）**：本机制不进 `RULES-REGISTRY.json`，因此 `rules:gate` / `rules:apply` / `rules:coverage` / `pre-commit`（`works/build/githooks/pre-commit:108` 调 ruleguard `--mode commit`）**都看不见它**；唯一执行面 = pr-gate 显式步骤 + 本地手动。与 `[DESIGN-ARCH-194]` 的守卫处境相同（其执行面同为 pr-gate 显式步骤），区别是本机制 S1 期不阻断。
- **三件套接线**：① `package.json` 别名 `check:manifests` / `check:manifests:json` / `gen:entry-matrix`（实测今日无这两个别名；`check:manifest-sync` 是 `MANIFEST.in` ↔ `pip_packaging_rules.py`，无关）；② pr-gate 步骤（形状照 `:279-280`）；③ FEATURE-OWNERSHIP 机制登记（下）。
- **机制登记（R2/R6 定稿；与 D3 同形）**：

```json
{
  "id": "terminal-manifest-guard",
  "name": "终端清单与能力词表守卫（端矩阵投影 + 能力寻址契约）",
  "ssot": "docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-221] 终端清单与能力词表规范.md",
  "rules": [],
  "_rules_note": "刻意留空，与 entry-buffer-guard / domain-direction-guard / functional-unit-guard 同一登记手法（本轮实测：40 条机制中仅这三条带 samples.source，key 全为 counts.*）。PP-3 只复算 rules[] 的强度（check-rollout-stage.js:442-459），本机制 S1 本就只记不拦；把 LAYOUT-008 写进 rules 会给「机制守护哪条规则」制造第二个语义来源。",
  "executor": "scripts/ci/check-manifests.js",
  "stage": "S1",
  "stageSince": "<实施日>",
  "previousStage": null,
  "executorStage": { "file": "scripts/ci/check-manifests.js", "constant": "GUARD_STAGE" },
  "samples": {
    "observed": 0,
    "target": 200,
    "source": { "script": "scripts/ci/check-manifests.js", "args": ["--json"], "key": "counts.checks-run" },
    "note": "observed=0 是占位：落地首跑后必须回填实测数字（快照）。选 checks-run 而不是 finding 计数：finding 计数结构上限是「端数 × 每端条目数」（entry-matrix-stale 更只有 1），永远够不到 PP-2 的 200；checks-run 是单次运行的断言数（算式见规范 §5.2），常态 ≥200，毕业通道才可达。"
  },
  "rollback": "摘除本条机制登记 + 摘除 package.json 的 check:manifests / check:manifests:json / gen:entry-matrix 别名 + 摘除 pr-gate 的 Check terminal manifests 步骤 + 删除 scripts/ci/check-manifests.js 与 gen-entry-matrix.js。清单文件与 entries.json 均为纯数据，保留即回到迁移前语义；无运行时行为变更。"
}
```

- `samples.source` 只允许 `scripts/` 下的执行器（`check-rollout-stage.js:134-140`）；完整档会真跑复算（`:380-410`，`--changed` 档不复算）。
- **样本量与毕业的机械通道（本轮逐行复读 `check-rollout-stage.js`，修掉 v1/v2 前一版的死键）**：
  - PP-2 用**实测值**判阈值：`:399-410` 把 `evaluateSamples` 返回的 `state.value` 赋给 `sampleValue`；`:429-438` 要求 `sampleValue ≥ GRADUATION_SAMPLES[上一阶]`，实测常量 `:90` 为 `{S1:200, S2:50, S3:20}`。⇒ S1→S2 要求单次读数 **≥200**；只用 finding 计数（结构上限 1 或「端数×条目数」）永远到不了，本机制会**结构性地毕不了业**。故 v2 取 `counts.checks-run`（断言数，算式与量级见 §5.2）。
  - `observed` 落地时必须回填**首跑实测快照**，不要留 0：`:308-320` 里 `live !== declared` 只报 `rollout-stage-samples-unverified`（WARN，且 `value` 用实测值），但快照长期失真会掩盖读数变化——首跑后回填当时读数并注明口径。
  - PP-1（`:417-425`）：升到 S3 时 `sampleValue` 必须 >0——`checks-run` 常态为正（按算式约 200 上下），天然满足；这正是不能选 finding 计数的第二个理由（健康态恒 0 的键会让 S3 判定依赖「当时恰好有违规」）。
- **毕业（S3，人的决定，PP-6 一次一阶）**：新增 **`LAYOUT-009`**（本轮实测 LAYOUT 域已被 001–008 占满，009 空闲）**且必须同批退役/合并一条既有规则**（PROCESS-014「新增一条先退役一条」；当前 `ruleCount=101/94` 已越界，只加不减会把越界从 +7 扩到 +8）。退役候选名单由人定；退役动作本身受 RUNTIME-009 约束（留 `scrub-plan.md` + 可执行 `rollback.txt`）。
  - S3 登记草案（字段照 `RULES-REGISTRY.json` 现有条目）：`id=LAYOUT-009`、`name=终端清单与端矩阵投影一致性`、`gate=commit`、`severity=blocking`（S3 允许）、`paths` 见 v1 §5.3 表、`exec={script:"scripts/ci/check-manifests.js",args:["--changed"],findings:[§5.1 全表]}`。
  - 落盘前必须重测 `LAYOUT-009` 是否仍空闲。

### 5.4 生成器：一份投影 + 两份分发副本

- `scripts/ci/gen-entry-matrix.js`（别名 `gen:entry-matrix`）一次产出**三份**；`--check` 在内存重建三份并逐字节比对，**以退出码表达**（不发射 finding——finding 的唯一发射器是 `check-manifests.js`，§5.1）：
  1. `entries/entries.json`（`TERMINAL_MANIFESTS` 列出的仓内端 + 顶层 `kinds/statuses/modes`）；
  2. `runtime/substrate/platform/packages/plugin-sdk/terminal-manifest/terminal-manifest.schema.json`（§9.1 档 1 分发副本）；
  3. 同目录 `capability-vocab.json`。
- **生成器输入是一张显式清单**：`gen-entry-matrix.js` 内声明 `const TERMINAL_MANIFESTS = [<7 条仓库相对路径>]`（顺序即投影顺序）。新增/退役仓内端 = 改这份清单 + 增删 `khy.terminal.json`，**不是**靠目录扫描——扫描会把生态端/临时目录卷进投影，破坏逐字节复算。§8 场景 1 的「新增 demo-terminal」因此必须同批把它的清单路径加进 `TERMINAL_MANIFESTS`，否则该端不会出现在投影里（断言不可能 PASS）。
- 展平映射、枚举渲染、**不写时间戳**（`meta.version`/`meta.updated` 为生成器内手写常量，先例 `atomicCapabilityRegistry.js:2013-2014`）、`meta.notes` 首条改写为「本文件是生成投影，不要手改——改对应 `khy.terminal.json` 后重跑 `gen:entry-matrix`」，沿用 v1 §5.4 的明细；补一条 F1 更正：三块枚举在**顶层**。
- 分发副本是「真源的逐字节拷贝」，不加工、不嵌元数据（保持第三方可直接当 JSON Schema 用）。它**不能当整文件 mirror**（`mirrors[]` 只能存标量事实），登记的是**长度/版本级** mirror（`capability-vocab-size`、`terminal-manifest-schema-version`，§0.4 第 3 条）；**内容级**锁步靠 `sdk-dist-stale` 的逐字节比对。**不要**给副本加 `$comment`/外层包裹去「规避」检查——加包装会让它与真源不再逐字节一致，反而制造第三个形态。
- 谁生成、何时生成：作者在改清单的同一 PR 内跑生成器（人工）；CI 的 pr-gate 跑 `check-manifests.js` 验「投影/副本是否最新」。不设 pre-commit 自动生成（钩子写文件与 PROCESS-001 红线相邻）。
- 生态端**不进投影、不进分发包的清单副本**：投影只含 `TERMINAL_MANIFESTS` 列出的仓内端（初始 7 端，§9.2）。

---

## 6. 装配消费（ask 第 5 问；沿用 v1 §6，补 D4/D6 两行）

- composer/suite 只读 JSON，不 `require` 终端代码；启动终端走既有 `entrypoints/launcher.js`（`attach/wait/detach`，零超时，合 RUNTIME-003）或 attach 到 aiManagementServer——**沿用 v1 §6.1 全文**。
- 组合态「一个窗口、一套设置、一个核心实例」= 数据面合并 + 设置路由到 core 单实例，不 fork/不复制终端代码（意图 3）；`compose` 字段 v1 只登记。
- **补 D4**：单实例宣称前须计量收敛（`metering-dual-writer`），清单侧不新增字段承载计量。
- **补 D6**：`AI_MGMT_HOST` 只由 suite 对**自己拉起的 listener** 注入 `127.0.0.1`，仲裁顺序 `用户显式 env > suite 注入 > serviceDefaults`；ai-backend 的 `0.0.0.0` 默认保留并登记 `KNOWN-EXCEPTIONS.json`；清单的 `embed.transport = ai-management-http-ws` 不变。
- 独立态零开销：消费者只有 CI 校验器、组合态 composer、`khy entry` 只读视图；终端自身构建/启动链零新增——沿用 v1 §6.2（其 `loadRegistry` 未知字段容忍实验是 v1 会话实测，本会话**未复跑**）。

---

## 7. 迁移步骤与差异表（ask 第 6 问；v2 重写）

### 7.1 三方差异表

沿用 v1 §7.1 表，两处更新：①「字段」行补「顶层 `kinds/statuses/modes`」（F1）；②「变更」行补 `sdk-dist-stale`。

### 7.2 迁移步骤（每步带验收；顺序不可交换）

1. **编号重测 + 规范落地**：落盘当天重跑编号实测（本轮：最大 219、220–223 空闲 → 取 **221**，被占顺延）；写 221（schema / 词表 / 版本 / 生态 / §9.5 示例）+ `TERMINAL-MANIFEST.schema.json` + `CAPABILITY-VOCAB.json`；两处 `00_INDEX_*` 登记（**人批**，本稿禁改索引）。验收：schema 过 ajv 自校验；词表过命名/生命周期校验（脚本临时跑亦可）。
2. **拆表（7 份清单）**：从现 `entries.json` 反向拆出 7 份 `khy.terminal.json`，`status/statusNote/notes` 随迁；**web-quant 的 `artifactOutput` 写 `quant-frontend-dist`**（A4/D7），不再留 `null`。验收：7 份文件存在；与现条目逐字段对得上（除 web-quant 的 artifactOutput 是有意修正）。
3. **生成器落地**：`gen-entry-matrix.js` 产出三份（§5.4）；与现 `entries.json` 做 diff——条目逐字段等价 + 顶层 `kinds/statuses/modes` **逐字节等价**（枚举缺失会让 `registry.js:322-333` 全表报「未在 kinds/statuses 里登记」——v1 会话实测 14 条，本会话未复跑）。通过后替换。验收：`node scripts/ci/gen-entry-matrix.js --check` exit 0。
4. **运行时回归**：`runtime/node/backend/tests/entrypoints.test.js`（本轮 `fs.existsSync` 实测**存在**）全绿。
5. **校验器落地 + 登记（同 PR）**：`check-manifests.js`（`GUARD_STAGE='S1'` 字面常量、`counts` 21 键含 `checks-run`）+ 3 个别名 + pr-gate 步骤 + FEATURE-OWNERSHIP 条目 + **DATA-SSOT**：`sources[]` 增补 7 份清单（**必须与本步同 PR**，否则 `ssot-source-missing`）；`facts[]` 登记 `terminal-matrix`（json-count `/entries`，可选）、`capability-vocab-size` 与 `terminal-manifest-schema-version`（两条含分发副本 mirror，§1.3-4）；**schema/词表不进 `sources[]`**（§0.4）。验收：`node scripts/ci/check-manifests.js --json` 的 `counts` 含全部 21 键且为整数；`npm run check:ssot-data` 不因新增登记报 error（本会话未跑）；`npm run check:wiring` 不把新脚本判孤儿（脚本有别名引用）；`node scripts/ci/check-rollout-stage.js` 不再为本机制新增 error。
6. **规范订正（人批留痕，D10）**：`entries/entries.json:7` 的 `meta.ssot` → `docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-117] khy-多端入口矩阵.md`；`[DESIGN-ARCH-117]:5` 头注翻转为「改端先改终端清单 + 重跑生成器」、§四 schema 表同批；两处 `00_INDEX_*` 登记（主索引已登记 219 在 `:201`，子索引同轮未见 219 行）。验收：`npm run check:layout` 的 `docs-index-complete` 不新增 finding；`docs:verify` 不报新错（两项本会话均未跑）。
7. **生态发现根（v1 只启用 env）**：`KHY_TERMINAL_ROOTS`（多路径分隔，RUNTIME-001 合规）；若要默认目录，**必须先登记 `DATA-LOCATIONS.json`**（LAYOUT-007），否则 `check:data-layout` 报 L-1。`compose.surface` 仍只登记（待拍板 §10-2）。
8. **升阶观察**：机制在 S1 攒样本（≥200 且无解释不了的样本）；毕业按 PP-2/PP-6，**先退役后新增 LAYOUT-009**（§5.3）。

---

## 8. 验收四场景（ask 第 7 问；沿用 v1 §8，命令按 v2 契约更新）

> 以下为**验收条款**：实施后可机判。当前 `check-manifests.js` / `gen-entry-matrix.js` / schema / 词表**均不存在**（本轮实测），因此本会话**一条验收命令都没跑**，只跑了基线（§11）。fixture 落仓库外临时目录。
> 所有命令都是 `node` / `npm run` 级，**不新增 CLI 命令**（D5）。

1. **新增仓内终端**（前置：把清单路径加进 `gen-entry-matrix.js` 的 `TERMINAL_MANIFESTS`，§5.4——不加则投影里不会出现该端）：
   ```
   node scripts/ci/gen-entry-matrix.js --check                 → exit 0（三份产物最新）
   node scripts/ci/check-manifests.js --json                   → counts 全为 0 或仅含已知 info/warning
   node -e "const r=require('./runtime/node/backend/src/services/entrypoints/registry').loadRegistry({appRoot:process.cwd()});console.log(r.entries.some(e=>e.id==='demo-terminal')?'PASS':'FAIL')"
                                                              → PASS
   ```
   生态端不适用本场景（它不进投影）：改为把包根加进 `KHY_TERMINAL_ROOTS`，用 `check-manifests.js --root <包根> --loose --json` 校验，并验装配面能读到清单。
2. **required 缺失**：fixture `consumes:[{id:"acme.notes",required:true}]` →
   `node scripts/ci/check-manifests.js --root <fixture> --loose --json` 的 `counts` 中
   `capability-required-not-core` 或 `capability-required-unmet` ≥ 1（省掉 `required` 则 `capability-consume-shape-invalid`）。
3. **optional 缺失**：同 fixture 改 `required:false` → `counts["capability-optional-unmet"] ≥ 1`，且 required 系 error 计数为 0；运行时装配报告 `degradedEntrances` 含该入口。
4. **版本不匹配**：`coreVersion:">=99.0.0"` → `counts["core-version-unsatisfiable"] ≥ 1`；`"^1.2.0"` → `counts["core-version-invalid"] ≥ 1`（CI 与装配期同一文法拒绝）。运行时消息含四要素（§4.2）。

---

## 9. 第三方接入（ask 第 8 问；R5/R7 定稿）

### 9.1 分发通道：已定 (a)，验收与 D1 两档逐条对齐

**通道 (a)**：`@khy/plugin-sdk` 补 `files` / `exports` / `publishConfig`，与 `@khy/core` **同批** npm 发布（对齐 D1 档 1）。档 2（embedded）由官方发行包的 `bundled/` 承担**同一份 core 实现**，清单/词表的副本**不进 `bundled/`**（避免第三个载体）。

| 档 | 内容 | 验收（实施后可机判；本会话未跑） |
|---|---|---|
| 档 1（生态默认） | `@khy/core/contracts` + `/client` 可独立 npm 安装、零 `node:`、零副作用；`@khy/plugin-sdk` 同批发布，含 `terminal-manifest/{terminal-manifest.schema.json,capability-vocab.json}` 两份 JSON（第三方自备 ajv 校验；`validateTerminalManifest` 不在本批，见 §9.1 末） | A1 `npm pack runtime/substrate/platform/packages/plugin-sdk` 的 tarball 列表含上述两份 JSON；A2 空目录 `npm i <tgz>` 后 `require.resolve('@khy/plugin-sdk/terminal-manifest/schema.json')` 与 `…/capability-vocab.json` 均成功（两个 JSON 子路径已声明、文件由生成器产出）；A3 同批 `npm pack packages/core` → 空目录安装 → `require('@khy/core/contracts')`、`require('@khy/core/client')` 可解析，且两个目录 `node:` / `process.env.` 扫描为 0（`core-handle.md:747` 的 browser-safety 判据，唯一豁免 `coreEnv.js`）；A4 从 `packages/core` 包根 `require.resolve('zod')` 可解析（D9 conformance）；A5 版本：两包 bump 走 PROCESS-005/R-2a 人批，core 轨道归组人拍板；lockfile 在有 pnpm/corepack 的机器再生（本机实测二者均缺，§11-7） |
| 档 2（embedded 全量） | 官方发行包（npm `@khy-os/khy-os` 的 `bundled/` + pip wheel）内含 core 全量；**不承诺** `npm i @khy/core` 跑通 embedded（网关切子集单列 B8） | B1 发行包内含 core 全量实现；清单/词表副本不进包（今日 `works/ship/npm/package.json` 的 `files` 实测为 `bin/`、`bundled/`、两脚本，`bundled/` 下只有 `runtime/khy`——`entries/` 是否随包属既有分发事实，不在本稿修）；B2 装机态不要求 `node_modules/@khy/core`（定位顺序支持宿主传入 bundled 入口，D1 CH-4）；B3 `bundled/` 内不出现 schema/词表副本 |

- **镜像/副本规则**：仓内 registry 是唯一真源；分发副本是**生成物**。**内容级**锁步由 `check-manifests.js` 的 `sdk-dist-stale` 承担（唯一发射器，§5.1）；**长度/版本级**另由 `facts[]` 的 `capability-vocab-size` / `terminal-manifest-schema-version` mirror 兜一层（§1.3-4）。两份文件**仍不进 `sources[]`**（否则 D4 会把逐字节副本判 `ssot-source-shadow-copy`，§0.4 第 3 条）。v1 §9.4-3 的「把副本按 mirrors 登记」按整文件语义作废，改为上面这条标量级 + 字节级的组合。
- **`exports` 只声明真实存在的文件**（封闭 exports 的教训来自 `core-handle.md:152-153`：未声明子路径的深导入 = `ERR_PACKAGE_PATH_NOT_EXPORTED`；反过来，声明了却不存在同样验不过）：
  ```json
  "exports": {
    ".": "./index.js",
    "./terminal-manifest/schema.json": "./terminal-manifest/terminal-manifest.schema.json",
    "./terminal-manifest/capability-vocab.json": "./terminal-manifest/capability-vocab.json"
  }
  ```
  `files` 同步含 `terminal-manifest/`。**不声明 `./terminal-manifest` JS 入口**：§5.4 的生成器只产两份 JSON，没有任何步骤产出 `terminal-manifest/index.js`，声明它就是造一个验收必挂的空指针。若将来要随包提供 `validateTerminalManifest`，必须先把「谁产出 index.js / 它如何与 schema 锁步」写进 §5.4 与迁移步骤，再补对应 exports——v1 的「v1 不实现第三方 validator」仍然有效。§9.5 ④ 的两条命令按**上面两个 JSON 子路径**写，第三方侧才可 `require` 成功。
- **今天的状态**：通道未建成——`plugin-sdk/package.json` 无三字段（实测），`works/ship/npm` 的 `files` 不含它（实测），本机无 pnpm/corepack（实测）。因此 §9.5 的校验命令**在通道落地前不可执行**，只能停在设计契约；不得宣称「今日已可脱离 monorepo 接入」。

### 9.2 发现根（v1：只支持两路，不新增未登记落点）

1. 仓内投影：`entries/entries.json`（仅 `TERMINAL_MANIFESTS` 列出的仓内端，初始 7 端）；
2. env 显式注入：`KHY_TERMINAL_ROOTS`（多路径分隔）。

默认目录暂不设（`~/.khyos/terminals/` 会违反 LAYOUT-007，理由沿用 v1 §9.2；若启用先登记 `DATA-LOCATIONS.json`）。生态端**不写进** `entries.json`。

### 9.3 两档严格度（沿用 v1 §9.3）

`--strict`（本仓 CI）：provides/consumes 都查词表；`ports[].ref` 按 `serviceDefaults` 解析。
`--loose`（生态）：consumes 必须在词表、required 必须 `providedBy:"core"`（core 契约面不放宽）；provides 只查命名/保留域/atomic 对齐；`ports[].ref` 不解析 → `port-ref-unverifiable`（info）。

### 9.4 与 `[DESIGN-ARCH-011]` 的边界（沿用 v1 §9.2 末段）

`~/.khyos/apps/<name>.json` 管 Python 侧应用进程发现；终端清单管装配契约。两者字段与消费方不同，边界写进 221。

### 9.5 第三方终端最小示例（R7；**不依赖任何 monorepo 路径**）

**① 目录结构**（第三方自有仓，包根即可分发单元）：

```
acme-viewer/
├─ khy.terminal.json          ← 唯一声明面（清单）
├─ package.json               ← 普通 npm 包
├─ src/
│  └─ main.js                 ← entry.source 指向的包内目录
├─ scripts/
│  └─ validate-manifest.mjs   ← ④ 两条命令的封装（CI 调它，别各写一份）
└─ test/
   └─ terminal-manifest.test.js
```

**② `khy.terminal.json`**（attached；路径一律包内相对；`coreVersion` 的区间按第三方实测兼容档写——下例按今日 G1=1.2.2 给一个满足它的区间）：

```json
{
  "schemaVersion": 1,
  "id": "acme-viewer",
  "kind": "web",
  "title": "ACME Viewer",
  "artifactKind": "html",
  "coreVersion": ">=1.2.0 <2.0.0",
  "embed": { "mode": "attached", "transport": "ai-management-http-ws" },
  "capabilities": {
    "provides": ["acme.viewer-panel"],
    "consumes": [
      { "id": "gateway.generate", "required": true },
      { "id": "usage.report",   "required": false }
    ]
  },
  "entry": {
    "source": "src",
    "markers": ["package.json", "src/main.js"],
    "toolchain": ["node"]
  },
  "launch": { "default": { "command": "node", "args": ["src/main.js"], "mode": "wait" } },
  "artifactOutput": null,
  "ports": [],
  "status": "planned",
  "statusNote": "示例骨架：清单先定稿，attached 握手与 UI 入口尚未实现——按 §2.2「非 ready 必填 statusNote」如实标注（entries.json 现有 7 条全部带 statusNote，本轮实测）",
  "notes": ["attached 终端：连官方 core 进程，不自带 core；不写任何 khy-os 仓库路径"]
}
```

**③ 能力声明规则**（照 §3）：
- `provides` 用自有域前缀（`acme.*`），**不得占用** `gateway.* session.* event.* usage.* config.* plugin.*`；若与 `ATOMIC-CAPABILITIES.json` 同 id，必须写 `atomicRef`；
- `consumes[].required` 是必填 boolean：`true` 的能力**必须** `providedBy:"core"`（否则 `capability-required-not-core`）——这条保证「只带 core 也能独立运行」；
- `status` 与 `statusNote` 同 §2.2：`status` 必填；**非 `ready` 时 `statusNote` 必填**（示例用 `planned` 并带了 `statusNote`，否则会被 `manifest-schema-invalid` 拒掉）；
- `required:false` 缺提供者时不报错，装配报告记 `degradedEntrances`、入口不注册。

**④ 校验命令**（第三方侧，**通道 (a) 落地后可执行**；今天不可跑）：

```sh
# 结构校验（用 SDK 分发的 schema；第三方自带 ajv）
node -e "const Ajv=require('ajv');const a=new Ajv({allErrors:true});const ok=a.validate(require('@khy/plugin-sdk/terminal-manifest/schema.json'),require('./khy.terminal.json'));if(!ok){console.error(a.errorsText());process.exit(1)};console.log('manifest schema OK')"

# 能力契约校验（consumes 在词表、required 必须 core 提供）
node -e "const m=require('./khy.terminal.json');const v=require('@khy/plugin-sdk/terminal-manifest/capability-vocab.json');const by=new Map(v.capabilities.map(c=>[c.id,c]));let bad=0;for(const c of (m.capabilities&&m.capabilities.consumes)||[]){const e=by.get(c.id);if(!e){console.log('unknown capability:',c.id);bad++}else if(c.required&&e.providedBy!=='core'){console.log('required but not core-provided:',c.id);bad++}}process.exit(bad?1:0)"
```

（ajv 6 的 `validate(schema,data)` / `errorsText()` 本轮实跑确认，§11-2。`validateTerminalManifest` **不在本批**（§9.1）；若将来随包提供，须先把它与 schema 的锁步测试向量落到 `scripts/tests/fixtures/terminal-manifest-vectors.json`，再在 `exports` 与 `files` 补对应条目——顺序反了就是又一个「声明了但不存在」的空指针。）

**仓内 fixture 侧**（实施期 / 品牌合规评审用；第三方拿不到本仓脚本）：

```sh
node scripts/ci/check-manifests.js --root <第三方包根> --loose --json
```

**⑤ 接入步骤（7 步）**：
1. 在包根写 `khy.terminal.json`（上面②），`entry.source` 只写包内相对路径；
2. `npm i @khy/core`（档 1：contracts + client，零 `node:`、零副作用）——attached 消费官方 core，不嵌 core；
3. `npm i -D @khy/plugin-sdk`（与 `@khy/core` 同批发布的版本）用于清单校验；
4. 在 CI 里跑上面④两条命令；失败即修清单，**不要**改本仓 `entries.json`（生态端不进投影）；
5. 启动时连 core：显式注入 `KHY_CORE_ENDPOINT` / `KHY_CORE_TOKEN`（或由宿主注入）；定位顺序 = 显式注入 > 宿主 bundled 入口 > `node_modules` > 诚实报错（D1 ③）；`coreVersion` 不满足时 core 侧拒绝并给出四要素消息；
6. `required:true` 能力无提供者 → 启动期响亮报错；`required:false` → 注销入口并计入 `degradedEntrances`；
7. 要进组合态：把包根加入 `KHY_TERMINAL_ROOTS`，suite 装配面读清单并二次校验（`--loose`）；要进 KhyOS 品牌合规清单，则按 §3 词表流程投稿（可选）。

---

## 10. 待拍板项（v2 更新）

1. **规范真源订正（R4）**：`entries.json:7` + `[DESIGN-ARCH-117]` 头注/§四 + 两处索引——人批，实施期步骤 6。
2. **组合态 UI 承载面**：`compose.surface` 枚举与 suite 窗口机制仓内不存在，v1 只登记不校验；`embed.transport` 同（待 222 落地）。
3. **能力映射与方言收编**：`khy.extension.json` 的自由 `capabilities/provides`（`delivery/extension/tools/khy-markdown/khy.extension.json` 实例）是否并入同一规约，人定。
4. **ARCH-011 边界**：AppManifest 与终端清单是否长期并存，或由 221 宣布吸收关系。
5. **生态默认发现根**：若要默认目录，须先在 `DATA-LOCATIONS.json` 登记；v1 只用 env。
6. **S1 期门档**：是否在 S1 就把 `check:manifests` 接进 pre-commit（门档改动，须人批；不接则 S1 期无阻断面，§5.3）。
7. **G2/G3 的清单表达**：`coreVersion` 只协商 G1；web 类端对 `@khy/ui-shared`（G3，0.1.0）的依赖对齐是否要在清单里新增字段，或继续只由 `check-version-sync.js` 承担。
8. **`@khy/core` 版本轨道**：起步版本与归组（D1 明示不并 G2）——首个发布前由人拍板。
9. **原勘察判定的翻转背书**：`layout-facts.json:190` 的 duplicate 判定在 A 下不成立，221 正文须显式记录（§1.1）。
10. **schema/词表的事实级锁步边界**：本稿给它们登记的是「长度 / 标量级」facts（§1.3-4），内容级只有 `sdk-dist-stale`（S1 不阻断）。是否接受这层弱保护、或另立更强的整文件镜像 kind（需改 `ssotDataGuard`，超本重构边界），由人定。

> 已关闭（v1 的 §10-3 分发通道）：**已定 (a)**，见 §9.1。

---

## 11. 诚实区：本轮实际执行 / 未执行

**已跑（只读，仓库零改动；本稿是唯一写入物）**：

1. **编号实测**（写前，2026-11-17 本地 / UTC 2026-11-16T16:07）：`docs/03_DESIGN_设计/DESIGN-ARCH` 共 **214** 篇 `.md`、最大 **219**、`[DESIGN-ARCH-219] 一核心+多终端重构施工总案.md` 存在；220/221/222/223 输出 `FREE`。
2. **ajv 6 API 探针**：`new Ajv({allErrors:true})` + `ajv.validate(schema,data)` + `ajv.errorsText()` 实测可用（true / false 两例）。
3. **DATA-SSOT / ssot guard 实测**：`scan.include` 含 `entries/`（`DATA-SSOT.json:14`）；`facts` 11 条、`sources` 25 条；11 条 fact 的 id/identifiers/detect.paths/mirrors 全量打印（确认无一锚定 `entries/`）；`inInclude('entries/entries.json') = true`；`check-ssot-data.js --json` → `stats.facts=11, mirrors=8, sourceShadowCopies=0`、`findings=0`（S1，只记录）。
4. **版本**：`node scripts/ci/check-version-sync.js` → G1 1.2.2 / G2 1.6.5 / G3 0.1.0，`All version sync checks passed`。
5. **原子能力计数**：`ATOMIC-CAPABILITIES.json` 的 `capabilities` = 137、含连字符 34、对 §3.1 正则 0 不匹配。
6. **lockfile**：`pnpm-lock.yaml` 的 importers = **7**（列出全部 7 个路径）。
7. **环境**：`node v22.18.0`；`where pnpm` / `where corepack` 均未找到。
8. **登记/守卫现状**：`check-manifests.js`、`gen-entry-matrix.js`、`check-core-boundary.js`、`TERMINAL-MANIFEST.schema.json`、`CAPABILITY-VOCAB.json`、`KNOWN-EXCEPTIONS.json` **均不存在**；根 `package.json` 无 `check:manifests` / `gen:entry-matrix` / `check:core-boundary` 别名（`check:manifest-sync` 是 MANIFEST.in 同步，无关）；`FEATURE-OWNERSHIP` 40 条机制中无 `terminal-manifest-guard` / `core-boundary-guard` / `suite-assembly-guard`。
9. **基线红在案（不得写成已修）**：`check-delivery-baseline.js --json` → stage **S1**、counts PASS 7 / GAP 5、TS 项 `routerCommands=249/245 · aliasEntries=595/591 · handlerFiles=167/155 · ruleCount=101/94`、findings 含 `delivery-surface-ratchet-breach`（warning）；`check-rollout-stage.js` → **0 error / 44 warning**（含 `core-layers-guard` 的两条：samples 无 source、`STAGE` 常量找不到 ⇒ `rollout-stage-authority-drift`）；`check-core-layers.js` → **exit 非 0**（本轮实跑）；`check-ssot-data.js` → exit 0 / 0 findings（S1）。**没有任何门禁可称为绿。**
10. **源码证据逐行读取**：`scripts/lib/ssotDataGuard.js`（:52/:131-157/:263-297/:390-457/:499-534/:580-617/:729-736）、`scripts/ci/check-ssot-data.js`（:118-150/:236-270）、`scripts/ci/check-rollout-stage.js`（:82-110 毕业阈值/:150-180 pickKey/:196-322 evaluateSamples/:380-440 PP-1、PP-2）、`scripts/ci/check-repo-layout.js`（:111-124/:300-322/:740-745）、`runtime/node/backend/src/services/entrypoints/registry.js`（:50-56/:318-340/:366-425）、`runtime/node/backend/src/services/entrypoints/launcher.js`（:7-9/:70-71/:117）、`runtime/node/backend/src/plugin-loader/index.js`（:95-112）、`runtime/substrate/platform/packages/plugin-sdk/{package.json,index.js}`、`works/ship/npm/package.json`、`pnpm-workspace.yaml`/根 `package.json`、`docs/10_规范/registry/{DATA-SSOT,BUILD-OUTPUTS,RULES-REGISTRY,FEATURE-OWNERSHIP,ATOMIC-CAPABILITIES}.json`、`entries/entries.json`、`[DESIGN-ARCH-117]`/`[DESIGN-ARCH-219]`、`delivery/channel/khyquant/frontend/package.json`。
11. **实跑守卫（只读）**：`check-delivery-baseline.js --json`、`check-rollout-stage.js`、`check-core-layers.js`、`check-ssot-data.js --json`、`check-version-sync.js`、`check-repo-layout.js --json`（取 counts 形状）。
12. **复核轮补测**：`check-rollout-stage.js:90` 的 `GRADUATION_SAMPLES = {S1:200,S2:50,S3:20}` 与 `:399-410` / `:429-438` 的实测值判定、`:308-320` 的快照偏差降级为 WARN——逐行复读；`entries/entries.json` 7 条条目的 `status`/`statusNote` 全量打印（7/7 带 statusNote）。

**未跑 / 未核实**：

- `check-manifests.js` / `gen-entry-matrix.js` / schema / 词表 / plugin-sdk 分发副本都**是设计稿**，§8/§9.1 的验收命令当前**一条都不可跑**。
- `npm pack` / 空目录安装 / `@khy/core` 与 `@khy/plugin-sdk` 的发布链**未验证**（本机无 pnpm/corepack，且本轮禁止改包与发布）。
- `khy entry probe` 未跑；`entrypoints.test.js` 存在性已实测（存在），但测试**未执行**；第三方真实安装链路未验证。
- v1 的 `loadRegistry` 未知字段容忍实验、删 `kinds/statuses` 后 14 条报错实验、`plugin-loader:180` 默认 1.0.0 的行号——**均为 v1 会话实测转录，本会话未复跑**，标注为转录引用。
- `check:layout`、`check:wiring`、`rules:coverage`、`docs:verify` 本轮**未跑**（v1 基线材料另有读数，不属本轮）。
- `runtime/node/ai-backend/server.js:124-138`（D6 证据）按决策原文引用，本会话未复读。
