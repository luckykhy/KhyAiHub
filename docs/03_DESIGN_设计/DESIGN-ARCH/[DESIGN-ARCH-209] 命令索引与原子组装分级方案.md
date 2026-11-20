# [DESIGN-ARCH-209] 命令索引与原子组装分级方案

> 状态：提案稿（事实与提案分节；未经复核的判断一律标注「待确认」）
> 日期：2026-11-11
> 上游材料：`entries/workflow-out/cmd-index/framework.json`（categories / tiers / atoms / assignment / indexFormat / rationale）、`entries/workflow-out/cmd-index/inventory.schema.json`（295 条）、`entries/workflow-out/cmd-index/inventory.impl.json`（321 条），以及本轮 12 个类目的局部组装回传材料（各类目的索引块、组合关系、场景分组、精简候选、风险登记）。
> 汇总口径：本文由汇总编辑整编，未复跑各局部的一手实测；凡标注「实测」的结论均指对应局部在其回传材料中记录的 2026-11-11 本机运行，复现命令随文给出。
> 修订记录（2026-11-11 二次修订）：本版按三类评审意见修订——(a) 覆盖与准确性评审 10 条（数字错挂、口径基差、素材偏差，逐条订正并附本会话复算来源）；(b) 模型负担评审（L0 余量无机制背书、假想基线、旗舰示例走不通匹配规则、mission 鸡生蛋、场景分组无级无预算、中文别名缺席等，改分级模型、检索路径与落地顺序）；(c) 精简提案复核结论 79 条全部回收进第七节（逐条附证据），`clean` 的退休提案被复核推翻、改为「修复（补分发）」。凡本会话亲自复算的计数/命令均在文中标注「本会话复算」；来自复核记录而未在本会话复跑的标注「（复核记录）」；仍未执行的（自动化测试与 CI 守卫）明确记为未执行，不以通过/失败宣称。

---

## 一、问题与需求五问

需求原话（人，2026-11-11）：「khyos的命令太多杂乱，模型心智负担太重需要建立索引，分类精简，按照原子组装分级使用」。

| 五问 | 回答 |
|---|---|
| **谁用** | 两类。① 接入 Khy OS 的编码智能体（Claude Code / Codex / Cursor / Kiro / ZCode 等）——它们在每次任务开始时读指令文件，需要一份「名字 → 域」的常驻索引；② 使用 `khy` CLI 的人——记不住命令名，需要按场景找入口。 |
| **何时用** | 模型侧：每次会话注入指令时（常驻 L0）与任务意图命中某类目时（按需 L1）、要查某个命令的参数时（按需 L2）。人侧：忘了命令名、或想知道「这件事该用哪条命令」时。 |
| **现在的替代做法** | ① `khy help <名字>` 逐条查（实测 292/309 条有**可用**回显，见第三节样本口径订正）；② `khy commands --all` 平铺 265 个动词；③ `khy features` 按类浏览 slash catalog；④ 桌面设置页「命令」页 258 条。四条路都存在，但**没有一条是给模型上下文准备的**：`khy help` 全量 292 条标题合计 9791 字符（平均 33.5 字/条），平铺即击穿生态层 4000 与 own 层 8000 两个字符预算（`runtime/node/backend/src/services/instructionEcosystemRegistry.js:12-13`、`runtime/node/backend/src/services/instructionFileService.js:42-43`）。**基线是 0**：今天模型上下文里根本没有任何命令表——原稿「全塞 help 标题会涨到约 13113 字符」是对比用的构造数（13113=9791+3322，不是任何现状读数），本版删除该假想敌；基线为 0 时「省 66%」无对象可省，本方案要回答的是「首次常驻注入，预算内装不装得下」 |
| **成功长什么样** | 模型收到任务「帮我看下今天烧了多少 token」时：L0 索引（含 12 条 mission 图例）已在上下文 → 第 ①② 步 mission 与名字均 0 命中（12 条 mission 合计 454 字符无一条含 "token"，本会话复算；295 个命令名也无一个含 "token"）→ 第 ③ 步场景触发时机命中「查账」组 → 注入该组入口 → 给出 `khy cost`。期望输出可复核：注入的命令索引文件 ≤4000 字符（`ECO_MAX_FILE_CHARS`），12 张类目卡按 `inventory.schema.json` `purpose` 口径合计 6029 字符（本会话复算）、单次最多注入 2 张（≤1352 字符），单条详情一次 `khy help <名字>` ≤1398 字符（本会话复跑 309 条全量确认）。验收命令与期望输出见第八节示例 |
| **不做会怎样** | 模型继续在 265–309 个平铺名字里猜命令。代价已实测存在：`clean` 在 help 与斜杠菜单里广告却无分派（本会话实测裸命令 exit 1「未知命令 clean」；复核结论是补分发而非退休，见第七节）、`cleandisk` 一跑就崩（本会话实测阶段 2/3 扫描处中断）、`sync` 是被 `portable sync` 完全覆盖的遗留入口（本会话实测输出自述「已被 khy portable sync 取代」）——三处坏入口都会把模型引向死路；同类还有 118 个重复入口名字（`duplicate-entry` 状态计数；按 `implementedIn` 全量分组复现为 55 组、覆盖 130 个名字，两个基数不同，见 2.3） |

---

## 二、命令面实测盘点

### 2.1 口径对账表

五个数字不是矛盾，是**五张不同的面**。本文以 schema 295 条为索引总表口径（第五节表格行数 = 295），框架名册 309 条为归类口径，261 为 atom 口径。

| 口径 | 数量 | 数据源（本会话已核） | 说明 |
|---|---|---|---|
| 框架归类名册 | 309 | `framework.json` `assignment` 数组 | 12 类目逐名归类；含 14 个自注册 manifest 名 |
| schema 条目 | **295** | `inventory.schema.json`（= `getCommandSchema()`，本会话 `JSON.parse` 复算：295 条） | 静态 `ROUTER_COMMANDS` + slash 名；无 ask 指定的检查命令，未跑守卫 |
| router 动词 | 265 | `getRouterCommandNames()`（`runtime/node/backend/src/constants/commandSchema.js:2235`） | `khy commands --all` 渲染 265 条，与动词集逐一相符（局部实测） |
| 斜杠命令 | 212 | `getBuiltinSlashCommands()`（同文件 `:2297`；本会话复算：212 条、名互不重复） | 其 `route` 按「首 token」口径全部落在 295 个 schema 名字内（本会话复算：166 条非空 `route` 中仅 103 条整串是 schema 名，其余 63 条是 `gateway model` / `repo workspace` / `wx scan` 这类多词 route——「全部落在 295 个 schema 名字内」只在首 token 口径下成立） |
| 设置界面「命令」页 | 258 | 用户截图；来源已定位 | 212 内置 + 8 条 extras + 38 个用户技能（依赖本机家目录状态，见 2.3） |
| atom | 261 | `framework.json` `atoms`（本会话复算：261） | 247 个 schema atom + 14 个 manifest-only atom |
| 折叠别名 | 48 | atoms 与 assignment 的差集（本会话复算：48） | 不单独占 L0 行，折进代表名第 3 字段 |

> 口径差提示（待确认）：框架名册 309 比 schema 295 多出的 14 个名字是 `about`、`acp`、`commands`、`credentials`、`cross-platform`、`deliveries`、`entry`、`hq`、`modules`、`selfheal`、`stepneo`、`test-keys`、`traffic`、`vision`——自注册可 dispatch，但帮助/补全/设置页不可见。第五节总表按 295 口径列，14 个 manifest-only atom 只在第六节原子清单里登记。

### 2.2 现行 7 类分布与 12 类新方案的差异

`commandSchema` 现有 `category` 字段把 295 条分进 7 桶：`system` 89、`dev` 78、`workflow` 74、`model` 24、`security` 15、`data` 12、`analysis` 3。两个最大桶（`system`/`dev`）合计 167 条（56.6%），「system」实际是兜底桶——局部盘点发现 `inferCategory` 会把大量本属模型/编排面的名字兜底成 `system`（如 ai-models 类目里 20 个名字）。本文第四节改按 12 个任务域重组，最大类目降到 32 条（10.8%）。

### 2.3 实现错位（`inventory.impl.json`，本会话复算直方图）

覆盖 321 条 = 295 schema 名 + 14 manifest-only 名 + 12 个 router switch case 标签名；状态分布：`ok` 176 / `duplicate-entry` 118 / `unregistered` 26 / `ghost` 1。

| 错位类型 | 数量 | 实例（均据 `inventory.impl.json` 与局部实测） |
|---|---|---|
| 幽灵命令（有 handler 无入口） | 1 | `clean`：`handlers/clean.js` 导出 `handleCleanCommand` 且有单测，但无 manifest、无 case、无别名，全仓无人 require；实测 `node runtime/node/backend/bin/khy.js clean` → exit 1「未知命令 clean」 |
| manifest 有而 schema 无 | 14 | `hq`、`deliveries`、`vision`、`traffic` 等：可执行但帮助/补全/设置页不可见 |
| router case 标签无 schema 名 | 12 | `market`、`breakcache`、`autofixpr`、`claimmain`、`subscribepr`、`cc-switch`、`ccswitch`、`verdict`、`catalog`、`create-frontend`、`cross`、`turnrollback` |
| 同一能力多个入口 | 118 个名字 / 55 组（两个数不同基） | IDE 启动器族 8 名共用 `router.js:2495`；`dep`/`dependency`/`deps` 共用 `routerDispatchTail.js:2030`；`cost`/`usage` 同一 case 体；`exit`/`quit`、`rewind`/`undo`、`pr`/`mr`/`commit-push-pr`、`workflow`/`wf`/`workflows`、`keybindings`/`keys`/`shortcuts` 等 |

派发链（实现落点判定模型，本会话复算 case 标签数）：`route()`（`runtime/node/backend/src/cli/router.js:1081-1240`）依次尝试 `dispatchOpsCommand`（`runtime/node/backend/src/cli/routerDispatchOps.js`：**18 个 case 标签**，区间 :238-2761）→ `dispatchSlashCommand`（`routerDispatchSlash.js`：71 个）→ `dispatchTailCommand`（`routerDispatchTail.js`：52 个）→ `commandAutoRegistry.dispatch`（82 个自注册命令 + 87 个别名）→ `router.js` 主 switch（本会话复算：51 个标签，区间 :1246-2963）。三个 routerDispatch* 文件合计 141 个 case 标签（18+71+52，本会话复算）——**原稿把 141 错挂到 `dispatchOpsCommand` 一家头上，已订正**。`routerHandlers.js` 无 switch，是经 `setRouterDispatchOpsDeps` 注入的工厂。

> **118 / 55 的基数（二次修订订正）**：两个数不同基。118 = `inventory.impl.json` 中 `status=duplicate-entry` 的条目数；55 只有把全部 321 条按 `implementedIn` 分组且组内 >1 名才复现（覆盖 130 个名字，多出的 12 个正是未标 `duplicate-entry` 的 router case 标签，见上表第三行）；若只按这 118 条自带的同伴列表归并，得 52 组。引用时必须带基数，否则「118 个名字/55 组」看似矛盾。

已定位并精确复现的一处：设置界面「命令」页 258 条 = 212 内置 slash + 8 条 extras（`/push` 与内置撞名实际并入）+ 38 个用户技能（本机 `~/.khy/skills` 发现 43 个、5 个撞名被优先级守卫丢弃）。该复现依赖本机家目录状态（待确认：截图机器的精确目录内容无法证明）。

### 2.4 顺带登记的仓库缺陷（不代改）

- 路由分歧 4 处：`push`（键入落 `notify` 别名；菜单 `/push` → `repo publish`）、`websearch`（键入 → `search web`；菜单 flag → `replSession.js:5385`）、`resume`/`upgrade`（自身 switch case 被别名归一遮蔽成死路径）、`cross`（自动注册别名抢先，`router.js:1691` case 永不可达）。
- 孤儿模块 3 个：`handlers/taste.js`、`handlers/provider.js`、`handlers/doctorCmdc.js`。
- `docs.js` 声明的别名 `doc` 被 `handlers/doc.js` 自有命令名占用（`commandAutoRegistry` 先注册先得，静默无告警）。
- 遗留 `commands/registry.json` 全仓无人加载。

---

## 三、分级使用模型（L0/L1/L2）

分级的唯一目的：**让模型按任务强度逐级取信息，不一次性吞下全部命令面**。L0/L1/L2 三级规则取自 `framework.json` `tiers`（本会话已读原文）；二次修订增设第 4 行「场景（附加层）」——原稿的 83 组场景分组没有级、没有预算、没有注入点，却占 7662 字符，本版把它定为按需注入层并写入下表。

| 级 | 名称 | 准入规则 | 预算（实测） | 何时升级到下一级 |
|---|---|---|---|---|
| **L0** | 常驻索引 | 每个 atom 一行进模型上下文：`<代表名>` TAB `<类目键>` [ TAB `=<别名1>,<别名2>` ]。名字 = 首个 TAB 前的全部内容，故 `prompt compose` 这类多词名可无歧义解析；类目键恒为第 2 字段、长度 2，与 309 个命令名逐一比对过不相撞。别名不单独占行。**只做「名字 → 域」路由，不含中文用途**；首行图例扩展为「键→中文名→mission」12 行常驻（mission 归属见下表后裁决） | 261 行 / 3322 字符（含图例；本会话逐行复算：261 行 name+键 2740 + 48 个别名字段 426 + 图例 116 + `=` 号 ≈3296，与 3322 差 <1%），约 831 token（÷4 粗估，未过真实 tokenizer）。**三种口径分歧已统一**：原稿及评审曾给出 3322（逐行复算）/ 3755（行均 12.73 字符 ×295）/ 5113（§8.2 三条示例行均 17.33 ×295）三个相差 39%–55% 的数——本版以逐行复算的 3322 为权威值，其余两种记为上限估计不采用。mission 常驻后 L0 ≈ 3780 字符（+454），占 `ECO_MAX_FILE_CHARS=4000` 的 94.5%。**减负只来自别名折叠**：295→261 全部是 48 个别名折进第 3 字段（行数 −11.5%），分级本身没有减少任何一个名字；余量由命令面棘轮背书——`AGENTS.md` 工程规则 12 / `PROCESS-014` / `[DESIGN-DELIV-002]`「命令/别名/handler/规则数只降不升」，守卫 `npm run check:delivery`（`scripts/ci/check-delivery-baseline.js`）：新增 atom 须先退役一条，6% 余量有机制兜底而非文档自称 | 任务意图已能对某条命令点名、需要知道它干什么 → 取该命令所在类目的 L1 卡 |
| **L1** | 分类速查 | 按当前任务意图只注入命中的类目卡：`## <中文名> <mission>` + 每成员一行 `<名字>` TAB `<用途 ≤18 字>`。命中判据 = 任务关键词与类目 mission（现常驻）/成员名/用途文本做大小写不敏感包含匹配，与 `runtime/node/backend/src/routes/commands.js:33-51` 的 `?q=` 同构。排序确定性：按类目数组顺序取前 N 张，N=2；不引用执行频次（本机态数据会破坏「与 SSOT 逐字节一致」）。**0 命中降级链**：mission 0 命中 → L0 名字/别名字串匹配 → 场景触发时机匹配（见下）→ 仍 0 → L2 `khy help <最接近的名字>` 或 `khy features` | 按 `inventory.schema.json` 的 `purpose` 复算（本会话）：最大卡 675 字符（platform-runtime，35 成员）、12 张合计 6029 字符；单次最多 2 张 = ≤1352 字符，永不全量注入。**口径来源差异（二次修订订正）**：原稿 919/8511 是「L1 用途取 `khy help` 标题截断」口径（抽查 15 条 help 标题平均 20.9 字 vs inventory `purpose` 平均 10.6 字）；第五节用途列与 §8.1 示例用的是 `purpose`——两处不同源，本版统一为 `purpose` 口径并登记该差。**token 低估警示**：÷4 只对 L0（英文名+2 字符键为主）尚可；L1 卡约 2/3 是中文，按中文约 1 token/字符量级，单卡实际约 450–600 token、两卡约 900–1200 token，不是 675÷4≈170——任务书要减的是心智负担，全部用字符表述又配偏小常数会把真实负担低估数倍 | 已经点名某条命令、要它的参数/子命令 → L2 |
| **L2** | 按需详情 | 单条命令取一次 `khy help <名字>`（主路径）。`GET /api/commands?q=` 是检索不是取单条：它返回全部命中，且 catalog 只消费 212 条 slash 命令（`runtime/node/backend/src/services/domain/catalog/commandCatalog/commandCatalog.js:88-90` 只调 `getBuiltinSlashCommands`；本会话复算 `getBuiltinSlashCommands()`=212），59 个 router-only atom 在这条路径上取不到，只能当 L1 的补充索引。**59 的基数（二次修订订正）**：= 247 个 schema atom 中不在 212 条 slash 名内的数量（本会话复算确认）；按 261 全 atom 算是 73、按 295−212 算是 83、按 247−212+14 算是 49——四个数基数不同，原稿两处写 59 却未给基数，本版统一采用 59（schema atom 口径）并登记其余三个数 | 本会话复跑 309 条 `khy help` 全量（295 schema + 14 manifest-only）：max=1398、p50=79、>600 字符 4 条、>1400 为 0、<40 字符 74 条（框架材料记 79，差 5 条待确认）；309/309 均有输出，其中 17 条无**可用**回显（13 条标题只有命令名 + `models`/`model`/`doctor`/`gateway` 4 条错块或无描述）。故单次 ≤1398 字符；一次任务累计 ≤3 次 = ≤4194 字符。**样本口径（二次修订订正）**：第一节「292/309 有回显」应理解为「有可用回显」（309−17），与「309 全量有输出」不矛盾，两处基数已统一。**回退路径无预算（待人工确认）**：13 条错块回落到「slash.label 或 handler 文件」，读 handler 文件无上限，既不计入 4194 也不在 4000 文件预算内；三套预算（文件注入 4000 / 类目卡 1352 / help 输出 4194）互不换算，L2 的 shell 输出是否计入生态层 `ECO_MAX_TOTAL_CHARS=8000` 未验证；`cost`/`usage` 不在这 13 条里却同属 dm 组合体——本会话实测两者 help 回显正常（`cost` 30 字符「查看 Token 用量和费用统计」、`usage` 52 字符），动词表只注册在 `usage` 上的风险仍在 | 已到 L2，无下一级 |
| **场景（附加层）** | 场景速查 | §6.3 的 83 组场景分组：同一场景里的命令互为上下文，模型命中一个就该看见同组其它成员。**不常驻、不占 L0/L1 预算**：全量 7662 字符（本会话复算 §6.3 表，83 行）只存在于机读索引（§8.1 `scenarios`）与检索面；模型上下文只在命中后收到该组入口（单组 ≤140 字符，本会话复算最大行），以类目卡下方「同场景」追加行呈现（≤2 行 × ≤40 字） | 全量 7662 字符 = L0（3322）的 2.3 倍、L1 两次注入上限（1352）的 5.7 倍——场景常驻则 4000 预算直接爆，按需则文档必须说清怎么按需（原稿未说，二次修订补为本行 + §6.3 分级定位） | 已到场景层，取入口命令后要参数 → L2 |

**L2 已知缺陷（必须回落，不得把错块当详情）**：`models`/`model` 的 help 返回的是 gateway 的帮助块（1398 字符，标题「· khy help gateway」，与 `khy help gateway` **逐字节相同**——本会话实测 `khy help gateway` == `khy help models` == `khy help model`，三者均 1398 字符）；`doctor` 的 775 字符块标题是「· khy help ops」（本会话实测 `khy help doctor` == `khy help ops`）；`gateway` 自身标题无描述；`cache`/`inertia`/`orchestrate`/`evolve`/`deps`/`remotedev` 及其别名共 13 条标题只有命令名（本会话实测这 13 条 = cache/inertia/orchestrate/orch/remotedev/rdev/mr/evolve/evolution/deps/dep/dependency/wf，与框架材料逐一相符）。遇到这些，L2 回落到 slash.label 或 handler 文件。

**与素材的偏差（二次修订登记，未回写素材）**：本文引用的 `framework.json` `tiers` 的 L2 rule 写「catalog 只含 203 条 slash 命令」，与本文口径（212 = `getBuiltinSlashCommands()` 实测 + `commandCatalog.js:88-90`）不一致——照素材复跑的人会得到不同数字；本文以代码实测为准。同批偏差还有 framework 的 L0/L1/L2 预算数（3322/919/8511/1838）与本文二次修订后的口径（3780/675/6029/1352）不同步。

**mission 归属（二次修订裁决，修订「鸡生蛋」）**：12 条 mission 合计 454 字符（本会话复算 `framework.json` `categories[].mission`）。原稿 mission 只写在 L1 卡首行「## <中文名> <mission>」，而 L1 卡是按命中结果才注入的——选哪张卡要匹配 mission，mission 却只在被选中的卡里；常驻 L0 的图例只给「键→中文名」不含 mission。本版裁决：**mission 上移常驻**，L0 图例扩展为 12 行「键→中文名→mission」，L0 从 3322 涨到约 3780 字符（若把每条 mission 压缩到 ≤18 字可降到约 3690）。代价是余量从 17% 压到 5.5%，由命令面棘轮兜底（见 L0 行）；另一个选项（mission 继续只放 L1）已被否决——那条路按文档自己的匹配规则永远选不中类目。

**跨类成员的统一渲染（二次修订订正，消除同一现象两种处理）**：`notify`（ao）与 `ci`（cv）组成 subscribe-pr 组合体、`resource`（dm）/`clipboard`（st）随 pl 块索引——同一类跨类事实，原稿一处禁止（「L0/L1 不得把 `notify` 渲染成本类 atom」）一处允许（「随块保留」）。本版统一规则：跨类成员一律**不占 atom 行**，在被命中类目卡里以「跨类参见」一行标注（格式 `→ <类目键>:<名字> <用途 ≤18 字>`，≤2 行）；N=2 限制的是**类目卡张数**，不限制「同场景/同组合」追加行——否则跨类组合/场景的其它成员按文档规则永远看不见，直接违背「命中一个就该看见同组其它成员」。`resource`/`clipboard` 从「随块保留」改按本条渲染（§6.3 同步改）。

**检索路径（确定性四步，二次修订补 0 命中降级）**：① 任务意图 → 与 12 条 mission（现常驻 L0 图例）做大小写不敏感包含匹配，得 1–2 个类目键；② 在 L0 里按第 2 字段等于该类目键取行（顺带匹配名字/别名字串）；③ 前两步 0 命中时 → 与场景触发时机做包含匹配（§6.3，83 组；场景表不常驻，只注入命中组）；④ 仍 0 → L2 `khy help <最接近的名字>` 或 `khy features`。TAB 分隔保证 `ai`/`data`/`skill`/`help` 这些「既是键又是命令名」的 token 不会误判。**旗舰示例走通性（二次修订订正）**：「帮我看下今天烧了多少 token」——12 条 mission 合计 454 字符无一条含 "token"（本会话复算），295 个命令名也无一个含 "token"，第 ①② 步必然 0 命中；原稿未定义 0 命中行为，且唯一含 "token" 的路由信号（L1 用途列 `cost`「查看 Token 费用统计」、§6.3 触发时机「今天/近 14 天烧了多少 token 和钱」）都在三步路径之外。补了第 ③ 步后，该示例命中「查账：Token 用量与会话导出」组，注入该组入口后给出 `khy cost`（本会话实测 `khy cost` 与 `khy usage` 均 exit 0 且首两行一致）。

---

## 四、分类体系

12 个类目 = 12 个任务域。类目键（第 2 字段）与中文名的映射同时是 L0 首行键位图例。

| 类目键 | 类目 | 职责（mission） | 名册条数 | 其中 atom | 其中折叠别名 |
|---|---|---|---|---|---|
| `dm` | 数据与行情 | 取数与存数：市场行情/账户/订单/回测 + 本机数据家的备份/清理/同步/用量账 | 28 | 26 | 2 |
| `am` | 模型与推理 | 选哪个脑子、出多大力：模型/服务商/网关/通道/推理档位/算力/识图端点配置 | 29 | 25 | 4 |
| `cs` | 会话与上下文 | 这一轮对话本身：开合、压缩、检查点、撤销、分享、回顾、上下文文件 | 25 | 22 | 3 |
| `mk` | 记忆与知识 | AI 记住什么、知道什么：记忆/知识库/提示词/学习进度/画像/指令文件 | 19 | 14 | 5 |
| `st` | 技能与工具 | 给 AI 装能力：技能/扩展/插件/MCP/工具清单/识图/联网/格式转换/剪贴板 | 18 | 15 | 3 |
| `cv` | 编码与版本管理 | 把代码写对并交付：git/PR/CI/发布/部署/依赖/评审/隔离工作区/模块打包 | 32 | 25 | 7 |
| `rh` | 仓库体检与诊断 | 系统/仓库好不好：诊断/日志/轨迹/自愈/健康/监控/项目分析/交付与流量台账 | 27 | 23 | 4 |
| `sa` | 安全与账号 | 谁能进门、什么被允许：登录/权限/密钥/凭据/沙箱/扫描/账号池 | 20 | 15 | 5 |
| `ao` | 自动化与编排 | 无人值守与多步执行：定时/守护/推送/多实例/代理/工作流/计划/目标/任务状态 | 32 | 26 | 6 |
| `pl` | 平台与运行时 | 跑在什么机器上、接哪些外部工具：内核/外壳/服务/设备/远程/IDE/多端/运维台 | 31 | 30 | 1 |
| `ui` | 界面与偏好 | 长什么样、怎么交互、出多省力：皮肤/语言/快捷键/输出风格/行为档位 | 18 | 14 | 4 |
| `hs` | 帮助与系统入口 | 我在哪、有什么、怎么用：帮助/版本/清屏/退出/文档/功能索引/自定位/产品自述 | 16 | 12 | 4 |
| — | **合计** | — | **295** | **247** | **48** |

条数为 `framework.json` `assignment` 归入该类目的 schema 名字数（本会话复算）。各类目局部回传材料的成员数与上表的差（如 ai-models 回传称 30 条、chat-sessions 回传 22 条、coding-vcs 回传 38 个名字）已在第九节登记为待确认项，本文一律以框架名册为准。

> **atom 口径两套（二次修订登记，订正「同一个数两个答案」）**：本表「其中 atom」列 = **schema 口径**（合计 247，不含 14 个 manifest-only）；§6.1 的 atom 数 = **含 manifest-only 口径**（合计 261）。§8.1 的 `atomCount` 字段填 §6.1 口径。以 platform-runtime 为例有四个数：31（本表 schema 名册）、30（本表 schema atom）、34（§6.1 含 manifest-only）、35（L1 卡成员口径 = 名册 31 + 4 manifest-only，含折叠别名 `rdev` 故比 atom 口径多 1）、29（局部回传，第九节待确认）——本文以框架名册为准，L1 卡按成员口径渲染，用户按「到底有几条」核对时五个答案都在本文，故逐个数注明来源。


---

## 五、命令索引总表

按类目分组的全部 295 条 schema 命令，每条一行。「分级」= 该名字在 L0/L1/L2 体系中的位置
（L0 = 独占常驻索引行；L1 = 别名，折进代表名 L0 第 3 字段，不单独占行）。「原子/组合」= 该名字是
独立原子、别名、还是某个组合的成员。用途列取自模式面盘点的实测判定
（`entries/workflow-out/cmd-index/inventory.schema.json` 的 `purpose`，均 ≤20 字）。
14 个 manifest-only atom 不在 295 口径内，见 6.1。

> **「原子/组合」列的判定规则（二次修订统一，订正两节互斥）**：**是某组合成员即标「组合」**，「组合来源」列给出 §6.2 的同名组合。原稿有两向矛盾：`autofix-pr`/`subscribe-pr`/`theme`/`docs` 四行标「组合」并给出组合来源，但 §6.2 同名组合的成员列分别只有 `ci`、`ci`/`notify`、`skin`、`menu`，均不含该命令本人（第五节说它是组合成员、第六节说它不是）；反向地，`plugin`/`extension`/`web-tools` 三行标「原子」且组合来源为「—」，却被 §6.2 的「reload-plugins 别名宿主」「ext 别名宿主」「webtools 别名宿主」列为组合成员。本版改 §6.2 的成员列（补入那四个同名命令）并改本表后三行的标记（原子→组合），使两节按同一规则互洽——295 行数与命令名一个未动，只改标记与来源列。
>
> **五条死入口仍在表内（二次修订登记，不划行）**：`clean`（本会话实测 exit 1）、`cleandisk`（一跑就崩）、`sync`（被 `portable sync` 完全覆盖）、`plan`（exit 1，实为 REPL 模式开关）、`wxscan`（exit 1）——五条全部仍以 L0 行形式出现在本表。删除或标注都会改动 295 行的行数与命令名（脚本逐字校验），故本版不划行，改为在第九节第 50 条登记「生成器对不可 dispatch 的名渲染 `†` 标记」；落地顺序 P0 修入口即为此。

#### 数据与行情（`data-market`，28 条）

| 名字 | 分级 | 原子/组合 | 一句话用途 | 组合来源 |
|---|---|---|---|---|
| `quote` | L0 | 原子 | 查询股票实时行情 | — |
| `data` | L0 | 原子 | 下载与查看行情数据 | — |
| `cache` | L0 | 原子 | 清空行情缓存 | — |
| `backtest` | L0 | 组合 | 运行策略回测 | 回测工作台 |
| `strategy` | L0 | 组合 | 列出可用回测策略 | 回测工作台 |
| `db` | L0 | 原子 | 初始化播种查看数据库 | — |
| `account` | L0 | 组合 | 查看账户资金信息 | 账户与持仓 |
| `position` | L0 | 组合 | 查看当前持仓 | 账户与持仓 |
| `order` | L0 | 原子 | 预览模式模拟下单 | — |
| `search` | L0 | 原子 | 搜索标的或联网搜索 | — |
| `watch` | L0 | 组合 | 管理自选股并看行情 | 自选行情面板 |
| `rank` | L0 | 组合 | 查看行情涨跌排行 | 自选行情面板 |
| `analyze` | L0 | 原子 | AI 分析走势与机会 | — |
| `cost` | L0 | 组合 | 查看 Token 费用统计 | Token 用量账 |
| `usage` | L1 | 别名（折进代表名） | 查看用量统计 | 折进 `cost`（L0 第 3 字段） |
| `cleanup` | L0 | 组合 | 按保留策略清理历史数据 | 磁盘回收三兄弟 |
| `workspace` | L0 | 原子 | 保存恢复对比工作区 | — |
| `resource` | L0 | 原子 | 管理数据资源记录 | — |
| `storage` | L0 | 组合 | 查看迁移数据家位置 | 数据家运维 |
| `clean` | L0 | 组合 | 回收构建产物与依赖 | 磁盘回收三兄弟 |
| `cleandisk` | L0 | 组合 | 大规模清理磁盘垃圾 | 磁盘回收三兄弟 |
| `backup` | L0 | 组合 | 备份恢复数据库与状态 | 数据家运维 |
| `metadata` | L0 | 组合 | 生成刷新项目元数据 | 可维护性元数据 |
| `meta` | L1 | 别名（折进代表名） | 元数据命令（metadata 别名） | 折进 `metadata`（L0 第 3 字段） |
| `export` | L0 | 原子 | 导出对话到文件 | — |
| `stats` | L0 | 原子 | 查看会话统计 | — |
| `sync` | L0 | 组合 | 同步数据到云端 | 数据家运维 |
| `portable` | L0 | 组合 | 同步代码到便携版 | 数据家运维 |

#### 模型与推理（`ai-models`，29 条）

| 名字 | 分级 | 原子/组合 | 一句话用途 | 组合来源 |
|---|---|---|---|---|
| `gateway` | L0 | 组合 | 管理 AI 网关与适配器 | apikey/provider 别名宿主 |
| `init` | L0 | 原子 | 生成项目记忆元数据脚手架 | — |
| `persona` | L0 | 组合 | 切换 AI 人格预设 | mode 别名宿主 |
| `train` | L0 | 原子 | 管理模型训练任务 | — |
| `compute` | L0 | 原子 | 管理计算资源 | — |
| `voice` | L0 | 原子 | 切换语音输入输出 | — |
| `model` | L0 | 原子 | 切换 AI 供应商与模型 | — |
| `models` | L0 | 原子 | 管理本地 Ollama 模型 | — |
| `khymodel` | L0 | 原子 | 查看 KHY 与本地模型 | — |
| `runtime` | L0 | 原子 | 安装管理推理运行时 | — |
| `channels` | L0 | 原子 | 查看通道健康与转移 | — |
| `role` | L0 | 原子 | 扮演指定角色人设 | — |
| `rtk` | L0 | 原子 | 省 token 模式开关 | — |
| `20x` | L0 | 原子 | 满负荷档开关 | — |
| `arena` | L0 | 原子 | 多模型并行对比 | — |
| `moa` | L0 | 原子 | 多模型合成最终答案 | — |
| `effort` | L0 | 组合 | 设置投入档位 | poor 别名宿主 |
| `fast` | L0 | 原子 | 切换快速响应模式 | — |
| `advisor` | L0 | 原子 | 推荐当前最佳模型 | — |
| `mode` | L1 | 别名（折进代表名） | 切换人格（persona 别名） | 折进 `persona`（L0 第 3 字段） |
| `provider` | L1 | 别名（折进代表名） | 配置 AI 服务商端点 | 折进 `gateway`（L0 第 3 字段） |
| `poor` | L1 | 别名（折进代表名） | 切到低 token 档 | 折进 `effort`（L0 第 3 字段） |
| `local` | L0 | 原子 | 强制使用本地能力 | — |
| `apikey` | L1 | 别名（折进代表名） | 引导配置 API Key | 折进 `gateway`（L0 第 3 字段） |
| `max` | L0 | 原子 | 切最高精度模式 | — |
| `high` | L0 | 原子 | 切高精度模式 | — |
| `medium` | L0 | 原子 | 切标准精度模式 | — |
| `low` | L0 | 原子 | 切快速响应模式 | — |
| `thinking` | L0 | 原子 | 切换扩展思考显示 | — |

#### 会话与上下文（`chat-sessions`，25 条）

| 名字 | 分级 | 原子/组合 | 一句话用途 | 组合来源 |
|---|---|---|---|---|
| `history` | L0 | 组合 | 查看与恢复历史对话 | 历史会话恢复 |
| `resume` | L1 | 别名（折进代表名） | 恢复上次对话上下文 | 折进 `history`（L0 第 3 字段） |
| `rewind` | L0 | 组合 | 恢复会话或文件检查点 | 检查点与回滚 |
| `undo` | L1 | 别名（折进代表名） | 撤销最近文件编辑 | 折进 `rewind`（L0 第 3 字段） |
| `turn-rollback` | L0 | 组合 | 按回合回滚文件改动 | 检查点与回滚 |
| `insights` | L0 | 原子 | 回顾会话轮次与工具 | — |
| `brief` | L0 | 原子 | 生成工作简报 | — |
| `compact` | L0 | 组合 | 压缩对话省上下文 | 上下文瘦身 |
| `snip` | L0 | 组合 | 裁剪近期消息省上下文 | 上下文瘦身 |
| `context` | L0 | 原子 | 查看上下文占用 | — |
| `files` | L0 | 原子 | 列出上下文中的文件 | — |
| `session` | L0 | 组合 | 浏览管理历史会话 | 历史会话恢复 |
| `share` | L0 | 原子 | 分享当前对话 | — |
| `summary` | L0 | 组合 | 总结当前对话 | 会话回顾 |
| `fork` | L0 | 原子 | 复制对话成分身探索 | — |
| `btw` | L0 | 原子 | 排队一条补充提示 | — |
| `recap` | L0 | 组合 | 回顾当前会话 | 会话回顾 |
| `thinkback` | L0 | 组合 | 周期回顾本地使用数据 | 会话回顾 |
| `copy` | L0 | 原子 | 复制回复到剪贴板 | — |
| `rename` | L0 | 原子 | 重命名当前会话 | — |
| `tag` | L0 | 原子 | 给会话打搜索标签 | — |
| `force-snip` | L1 | 别名（折进代表名） | 手动裁剪消息省上下文 | 折进 `snip`（L0 第 3 字段） |
| `sessions` | L0 | 组合 | 浏览管理历史会话 | 历史会话恢复 |
| `checkpoint` | L0 | 组合 | 手动保存项目状态 | 检查点与回滚 |
| `rollback` | L0 | 组合 | 回滚到检查点 | 检查点与回滚 |

#### 记忆与知识（`memory-knowledge`，19 条）

| 名字 | 分级 | 原子/组合 | 一句话用途 | 组合来源 |
|---|---|---|---|---|
| `profile` | L0 | 组合 | 查看使用习惯与画像 | 习惯与画像 |
| `skill` | L0 | 原子 | 安装与管理技能 | — |
| `growth` | L0 | 原子 | 查看学习成长进度 | — |
| `prompt` | L0 | 组合 | 管理提示词模板 | 提示词工作台 |
| `habit` | L0 | 组合 | 预测使用习惯 | 习惯与画像 |
| `knowledge` | L0 | 原子 | 搜索管理量化知识 | — |
| `memory` | L0 | 组合 | 管理 khy.md 指令记忆 | 记忆生命周期 |
| `dream` | L0 | 组合 | 蒸馏整理长期记忆 | 记忆生命周期 |
| `learn` | L0 | 原子 | 交互式学习课程 | — |
| `remember` | L0 | 组合 | 追加一条记忆到 khy.md | 记忆生命周期 |
| `instructions` | L0 | 原子 | 审核待写入指令候选 | — |
| `skills` | L1 | 别名（折进代表名） | 列出可用技能 | 折进 `skill`（L0 第 3 字段） |
| `skill-learning` | L1 | 别名（折进代表名） | 从会话学习沉淀技能 | 折进 `skill`（L0 第 3 字段） |
| `skill-search` | L1 | 别名（折进代表名） | 按关键词搜索技能 | 折进 `skill`（L0 第 3 字段） |
| `learn-skill` | L1 | 别名（折进代表名） | 目录网页提炼成技能 | 折进 `skill`（L0 第 3 字段） |
| `local-memory` | L1 | 别名（折进代表名） | 查看管理本地记忆 | 折进 `memory`（L0 第 3 字段） |
| `prompt compose` | L0 | 组合 | 编辑器撰写长提示词 | 提示词工作台 |
| `prompt normalize` | L0 | 组合 | 静态体检提示词 | 提示词工作台 |
| `prompt optimize` | L0 | 组合 | LLM 改写优化提示词 | 提示词工作台 |

#### 技能与工具（`skills-tools`，18 条）

| 名字 | 分级 | 原子/组合 | 一句话用途 | 组合来源 |
|---|---|---|---|---|
| `plugin` | L0 | 组合 | 管理插件 | reload-plugins 别名宿主 |
| `web_search` | L0 | 原子 | 联网搜索关键词 | — |
| `toollist` | L0 | 原子 | 按类列出全部 AI 工具 | — |
| `toolcheck` | L0 | 原子 | 审计工具契约与冲突 | — |
| `extension` | L0 | 组合 | 管理扩展插件 | ext 别名宿主 |
| `ext` | L1 | 别名（折进代表名） | 扩展市场（extension 别名） | 折进 `extension`（L0 第 3 字段） |
| `capability` | L0 | 原子 | 展示已学习能力与覆盖 | — |
| `agent-assets` | L0 | 原子 | 迁移外部 agent 资产 | — |
| `convert` | L0 | 原子 | 文档格式转换 | — |
| `mcp` | L0 | 原子 | 管理 MCP 服务器 | — |
| `web-tools` | L0 | 组合 | 查看联网搜索配置 | webtools 别名宿主 |
| `webtools` | L1 | 别名（折进代表名） | 搜索配置（web-tools 别名） | 折进 `web-tools`（L0 第 3 字段） |
| `md` | L0 | 原子 | Markdown 可视化工作台 | — |
| `reload-plugins` | L1 | 别名（折进代表名） | 重新加载插件 | 折进 `plugin`（L0 第 3 字段） |
| `image` | L0 | 原子 | 加载图片做视觉分析 | — |
| `paste` | L0 | 原子 | 粘贴剪贴板图片分析 | — |
| `clipboard` | L0 | 原子 | 剪贴板中继与图片桥接 | — |
| `websearch` | L0 | 原子 | Kiro 联网搜索 | — |

#### 编码与版本管理（`coding-vcs`，32 条）

| 名字 | 分级 | 原子/组合 | 一句话用途 | 组合来源 |
|---|---|---|---|---|
| `update` | L0 | 原子 | 检查并安装新版本 | — |
| `image2web` | L0 | 原子 | 截图还原为可运行网页 | — |
| `publish` | L0 | 原子 | 构建发布包与自发布 | — |
| `restore` | L0 | 原子 | 解包内嵌源码快照 | — |
| `repo` | L0 | 原子 | 大白话版本管理入口 | — |
| `deploy` | L0 | 原子 | 部署并启动项目 | — |
| `pr` | L0 | 原子 | 管理 Pull Request | — |
| `mr` | L1 | 别名（折进代表名） | 合并请求（pr 别名） | 折进 `pr`（L0 第 3 字段） |
| `ci` | L0 | 组合 | 查看 CI 运行状态 | autofix-pr 组合体；subscribe-pr 组合体 |
| `forge` | L0 | 原子 | 搜索侦察克隆远端项目 | — |
| `evolve` | L0 | 原子 | 查询可变性分级与义务 | — |
| `evolution` | L1 | 别名（折进代表名） | 进化查询（evolve 别名） | 折进 `evolve`（L0 第 3 字段） |
| `deps` | L0 | 原子 | 按需安装依赖 | — |
| `dep` | L1 | 别名（折进代表名） | 依赖命令（deps 别名） | 折进 `deps`（L0 第 3 字段） |
| `dependency` | L1 | 别名（折进代表名） | 依赖命令（deps 别名） | 折进 `deps`（L0 第 3 字段） |
| `devenv` | L0 | 原子 | 开发环境盘点与安装 | — |
| `diff` | L0 | 原子 | 查看近期改动 diff | — |
| `hooks` | L0 | 原子 | 管理生命周期钩子 | — |
| `upgrade` | L1 | 别名（折进代表名） | 检查并安装更新 | 折进 `update`（L0 第 3 字段） |
| `branch` | L0 | 原子 | 创建切换 git 分支 | — |
| `gitignore` | L0 | 原子 | 生成维护 .gitignore | — |
| `autofix-pr` | L0 | 组合 | 本地跑 CI 修复闭环 | autofix-pr 组合体 |
| `claim-main` | L0 | 原子 | 认领主角色 | — |
| `subscribe-pr` | L0 | 组合 | 订阅 PR CI 并推送 | subscribe-pr 组合体 |
| `pr-comments` | L0 | 原子 | 拉取 PR 评论进会话 | — |
| `prcomments` | L1 | 别名（折进代表名） | PR 评论别名 | 折进 `pr-comments`（L0 第 3 字段） |
| `commit-push-pr` | L1 | 别名（折进代表名） | 提交推送并开 PR | 折进 `pr`（L0 第 3 字段） |
| `git` | L0 | 原子 | 看工作区分支与改动 | — |
| `commit` | L0 | 原子 | 保存版本快照 | — |
| `push` | L0 | 原子 | 推送版本到远程 | — |
| `review` | L0 | 原子 | AI 审查 Git 改动 | — |
| `worktree` | L0 | 原子 | 开退隔离 worktree | — |

#### 仓库体检与诊断（`repo-health`，27 条）

| 名字 | 分级 | 原子/组合 | 一句话用途 | 组合来源 |
|---|---|---|---|---|
| `state` | L0 | 组合 | 查看状态机现状与转移 | 健康总览 |
| `doctor` | L0 | 组合 | 诊断依赖数据库网络 | 健康总览 |
| `log` | L0 | 组合 | 查看系统日志 | 排障取证 |
| `monitor` | L0 | 组合 | 监控 AI 请求指标 | 健康总览 |
| `services` | L0 | 组合 | 查看外部服务状态 | 健康总览 |
| `self` | L0 | 原子 | 查看 khy 能力边界状态 | — |
| `verify` | L0 | 组合 | 跨平台验证发布物 | 交付前验收 |
| `trace` | L0 | 组合 | 查看校验执行轨迹 | 轨迹审计与确定性复现 |
| `replay` | L0 | 组合 | 导出轨迹复现包 | 轨迹审计与确定性复现 |
| `guide` | L0 | 原子 | 蒸馏成功轨迹为地图 | — |
| `receipts` | L0 | 组合 | 浏览结构化执行回执 | 轨迹审计与确定性复现 |
| `heal` | L0 | 组合 | 修复缺失损坏的源码 | 交付前验收 |
| `maintain` | L0 | 组合 | 维护者健康总览 | 健康总览 |
| `health` | L0 | 组合 | 聚合体检各项健康信号 | 健康总览 |
| `debug` | L0 | 组合 | 调试工具调用 | 排障取证 |
| `perf-issue` | L0 | 组合 | 生成本会话性能报告 | 排障取证 |
| `perfissue` | L1 | 别名（折进代表名） | 性能报告（perf-issue 别名） | 折进 `perf-issue`（L0 第 3 字段） |
| `init-verifiers` | L0 | 组合 | 引导创建校验器技能 | 交付前验收 |
| `initverifiers` | L1 | 别名（折进代表名） | 校验器别名 | 折进 `init-verifiers`（L0 第 3 字段） |
| `debug-tool-call` | L0 | 组合 | 回看最近工具调用 | 排障取证 |
| `debugtoolcall` | L1 | 别名（折进代表名） | 工具回看别名 | 折进 `debug-tool-call`（L0 第 3 字段） |
| `heapdump` | L0 | 组合 | 落 V8 堆快照 | 排障取证 |
| `break-cache` | L0 | 组合 | 击穿前缀提示缓存 | 排障取证 |
| `project` | L0 | 原子 | 分析大项目结构 | — |
| `proj` | L1 | 别名（折进代表名） | 项目分析（project 别名） | 折进 `project`（L0 第 3 字段） |
| `maintainer` | L0 | 原子 | 查看维护地图与入口 | — |
| `docs-check` | L0 | 组合 | 检查文档是否过时 | 交付前验收 |

#### 安全与账号（`security-account`，20 条）

| 名字 | 分级 | 原子/组合 | 一句话用途 | 组合来源 |
|---|---|---|---|---|
| `ai` | L0 | 原子 | AI 模式与权限开关 | — |
| `pool` | L0 | 原子 | 管理登录账号池 | — |
| `security` | L0 | 原子 | 安全扫描与完整性校验 | — |
| `login` | L0 | 原子 | API 认证登录 | — |
| `register` | L0 | 原子 | 本机注册新账号 | — |
| `logout` | L0 | 原子 | 清除认证信息 | — |
| `whoami` | L0 | 原子 | 查看当前登录用户 | — |
| `passwd` | L0 | 原子 | 修改账号密码 | — |
| `forgot` | L0 | 原子 | 找回账号密码 | — |
| `user` | L0 | 原子 | 重命名登录账号 | — |
| `vault` | L0 | 原子 | 本地存放机密供模型引用 | — |
| `add-dir` | L0 | 原子 | 授权额外工作目录 | — |
| `adddir` | L1 | 别名（折进代表名） | 加目录（add-dir 别名） | 折进 `add-dir`（L0 第 3 字段） |
| `sandbox-toggle` | L0 | 原子 | 切换 OS 命令沙箱 | — |
| `sandboxtoggle` | L1 | 别名（折进代表名） | 沙箱开关别名 | 折进 `sandbox-toggle`（L0 第 3 字段） |
| `permissions` | L0 | 原子 | 编辑细粒度权限策略 | — |
| `security-review` | L1 | 别名（折进代表名） | 跑安全扫描 | 折进 `security`（L0 第 3 字段） |
| `local-vault` | L1 | 别名（折进代表名） | 管理本地密钥库 | 折进 `vault`（L0 第 3 字段） |
| `sandbox` | L1 | 别名（折进代表名） | 切换沙箱执行模式 | 折进 `sandbox-toggle`（L0 第 3 字段） |
| `scan` | L0 | 原子 | ClamAV 病毒扫描项目 | — |

#### 自动化与编排（`automation-orchestration`，32 条）

| 名字 | 分级 | 原子/组合 | 一句话用途 | 组合来源 |
|---|---|---|---|---|
| `inertia` | L0 | 组合 | 按计划文件惯性执行任务 | 多步任务编排执行 |
| `agent` | L0 | 组合 | 管理 AI 代理 | 多执行体协同 |
| `job` | L0 | 组合 | 从模板实例化任务 | 任务与交付台账 |
| `goal` | L0 | 组合 | 设定持久目标每轮提醒 | 目标与自治 |
| `mesh` | L0 | 组合 | 多实例互发消息 | 多执行体协同 |
| `notify` | L0 | 组合 | 推送消息到手机桌面 | subscribe-pr 组合体；外部消息触达 |
| `msg` | L0 | 组合 | 向钉钉飞书微信发消息 | 外部消息触达 |
| `wx` | L0 | 组合 | 扫码接入微信个人号 | 外部消息触达 |
| `feishu` | L0 | 组合 | 接入飞书收发消息 | 外部消息触达 |
| `coordinator` | L0 | 组合 | 多代理协调者模式 | 多执行体协同 |
| `orchestrate` | L0 | 组合 | 运行多代理编排 | 多步任务编排执行 |
| `orch` | L1 | 别名（折进代表名） | 编排命令（orchestrate 别名） | 折进 `orchestrate`（L0 第 3 字段） |
| `assistant` | L0 | 组合 | 后台助理与每日简报 | 无人值守底盘 |
| `ultraplan` | L0 | 组合 | 查看深度规划会话 | 规划与强度 |
| `ulw-loop` | L0 | 组合 | ultrawork 高强度执行 | 规划与强度 |
| `daemon` | L0 | 组合 | 管理后台守护进程 | 无人值守底盘 |
| `cron` | L0 | 组合 | 持久化定时任务调度 | 无人值守底盘 |
| `workflow` | L0 | 组合 | 工作流编排与回放 | 多步任务编排执行 |
| `wf` | L1 | 别名（折进代表名） | 工作流（workflow 别名） | 折进 `workflow`（L0 第 3 字段） |
| `tasks` | L0 | 组合 | 查看控制运行时任务 | 任务与交付台账 |
| `agents` | L0 | 组合 | 列出可用代理类型 | 多执行体协同 |
| `issue` | L0 | 组合 | 创建 GitHub issue | 反馈回路 |
| `feedback` | L0 | 组合 | 对 khy 提反馈报缺陷 | 反馈回路 |
| `bug` | L1 | 别名（折进代表名） | 反馈命令（feedback 别名） | 折进 `feedback`（L0 第 3 字段） |
| `topology` | L0 | 组合 | 可视化会话分叉拓扑 | 多执行体协同 |
| `forest` | L1 | 别名（折进代表名） | 拓扑（topology 别名） | 折进 `topology`（L0 第 3 字段） |
| `autonomy` | L0 | 组合 | 只读巡检自治活动 | 目标与自治 |
| `proactive` | L0 | 组合 | 开关主动 idle 模式 | 无人值守底盘 |
| `workflows` | L1 | 别名（折进代表名） | 工作流编排 CLI | 折进 `workflow`（L0 第 3 字段） |
| `schedule` | L1 | 别名（折进代表名） | 定时任务（cron 别名） | 折进 `cron`（L0 第 3 字段） |
| `plan` | L0 | 组合 | 先出计划再执行 | 规划与强度 |
| `wxscan` | L0 | 组合 | 调出微信登录二维码 | 外部消息触达 |

#### 平台与运行时（`platform-runtime`，31 条）

| 名字 | 分级 | 原子/组合 | 一句话用途 | 组合来源 |
|---|---|---|---|---|
| `server` | L0 | 原子 | 启动与查看后端服务 | — |
| `cloud` | L0 | 原子 | 管理云服务配置 | — |
| `kiro` | L0 | 组合 | 启动 Kiro 编码智能体 | IDE 启动器族 |
| `cursor` | L0 | 组合 | 启动 Cursor 编码智能体 | IDE 启动器族 |
| `claude` | L0 | 组合 | 启动 Claude Code 后端 | IDE 启动器族 |
| `codex` | L0 | 组合 | 启动 Codex 编码智能体 | IDE 启动器族 |
| `trae` | L0 | 组合 | 启动 Trae 编码智能体 | IDE 启动器族 |
| `opencode` | L0 | 组合 | 启动 OpenCode 后端 | IDE 启动器族 |
| `warp` | L0 | 组合 | 启动 Warp 编码智能体 | IDE 启动器族 |
| `vscode` | L0 | 组合 | 启动 VS Code 智能体 | IDE 启动器族 |
| `proxy` | L0 | 原子 | 配置代理服务与令牌 | — |
| `admin` | L0 | 原子 | 系统管理面板 | — |
| `app` | L0 | 原子 | 管理平台应用安装运行 | — |
| `khyos` | L0 | 原子 | 进入裸机内核终端 | — |
| `linux` | L0 | 原子 | 网络诊断与 Linux 命令 | — |
| `shell` | L0 | 原子 | 执行 shell 命令 | — |
| `device` | L0 | 原子 | 管理设备应用装卸 | — |
| `mobile` | L0 | 原子 | 生成手机访问二维码 | — |
| `phone` | L0 | 组合 | 调用手机 StepBridge 桥接 | 手机联动族 |
| `amoo` | L0 | 组合 | 与手机 Amoo 协作 | 手机联动族 |
| `companion` | L0 | 原子 | 管理 AgentFS 伴随代理 | — |
| `uninstall` | L0 | 原子 | 预览并清理卸载残留 | — |
| `bridge` | L0 | 原子 | 查看 IDE 桥接状态 | — |
| `remote` | L0 | 组合 | 远程开发连接管理 | 远程开发两面 |
| `remotedev` | L0 | 组合 | 远程开发设备管理 | 远端开发统一入口；远程开发两面 |
| `rdev` | L1 | 别名（折进代表名） | 远程开发（remotedev 别名） | 折进 `remotedev`（L0 第 3 字段） |
| `manage` | L0 | 原子 | 统一管理运维操作面 | — |
| `ide` | L0 | 原子 | 查看 IDE 与桥接状态 | — |
| `tools` | L0 | 原子 | 管理数据家便携 CLI | — |
| `hardware` | L0 | 原子 | 查看硬件与模型推荐 | — |
| `desktop` | L0 | 原子 | 开关桌面自动化 | — |

#### 界面与偏好（`ui-preferences`，18 条）

| 名字 | 分级 | 原子/组合 | 一句话用途 | 组合来源 |
|---|---|---|---|---|
| `lazy` | L0 | 原子 | 懒人方法论阶梯与债务 | — |
| `buddy` | L0 | 原子 | 查看伙伴宠物卡片 | — |
| `skin` | L0 | 组合 | 切换界面皮肤 | theme 薄壳 |
| `config` | L0 | 原子 | 查看编辑配置 | — |
| `env` | L0 | 原子 | 查看环境信息 | — |
| `statusline` | L0 | 原子 | 配置终端状态栏 | — |
| `theme` | L0 | 组合 | 切换配色主题 | theme 薄壳 |
| `stickers` | L0 | 原子 | 趣味贴纸 | — |
| `output-style` | L0 | 原子 | 切换 AI 输出风格 | — |
| `outputstyle` | L1 | 别名（折进代表名） | 输出风格别名 | 折进 `output-style`（L0 第 3 字段） |
| `lang` | L0 | 原子 | 设置输出语言偏好 | — |
| `terminal-setup` | L0 | 原子 | 检测终端配换行方案 | — |
| `terminalsetup` | L1 | 别名（折进代表名） | 终端配置别名 | 折进 `terminal-setup`（L0 第 3 字段） |
| `keybindings` | L0 | 原子 | 列出键盘快捷键 | — |
| `keys` | L1 | 别名（折进代表名） | 快捷键（keybindings 别名） | 折进 `keybindings`（L0 第 3 字段） |
| `shortcuts` | L1 | 别名（折进代表名） | 快捷键（keybindings 别名） | 折进 `keybindings`（L0 第 3 字段） |
| `color` | L0 | 原子 | 设置会话强调色 | — |
| `vim` | L0 | 原子 | 切换 Vim 按键模式 | — |

#### 帮助与系统入口（`help-system`，16 条）

| 名字 | 分级 | 原子/组合 | 一句话用途 | 组合来源 |
|---|---|---|---|---|
| `menu` | L0 | 组合 | 打开命令速查菜单 | menu 导航壳 |
| `help` | L0 | 原子 | 显示命令帮助 | — |
| `clear` | L0 | 原子 | 清空终端屏幕 | — |
| `exit` | L0 | 原子 | 保存对话并退出 | — |
| `quit` | L1 | 别名（折进代表名） | 退出 khy OS（同 exit） | 折进 `exit`（L0 第 3 字段） |
| `version` | L0 | 原子 | 查看当前版本号 | — |
| `docs` | L0 | 组合 | 查看与维护项目文档 | menu 导航壳 |
| `subscribe` | L1 | 别名（折进代表名） | 模型订阅与获取指南 | 折进 `docs`（L0 第 3 字段） |
| `sub` | L1 | 别名（折进代表名） | 文档入口（docs 别名） | 折进 `docs`（L0 第 3 字段） |
| `features` | L0 | 原子 | 按类浏览全部命令 | — |
| `doc` | L0 | 原子 | Word 标题样式重排 | — |
| `status` | L0 | 原子 | 查看当前状态 | — |
| `release-notes` | L0 | 原子 | 显示 CHANGELOG 发布说明 | — |
| `releasenotes` | L1 | 别名（折进代表名） | 发布说明别名 | 折进 `release-notes`（L0 第 3 字段） |
| `onboarding` | L0 | 原子 | 重跑首次引导步骤 | — |
| `where` | L0 | 原子 | 自定位入口与数据家 | — |

合计 295 行。

---

## 六、原子组装表

### 6.1 原子清单

atom = L0 常驻索引里独占一行、可作为组装最小单位的名词。261 个 atom 中 247 个来自 schema 295 条，14 个是自注册 manifest 名（不在帮助/补全/设置面，见 2.1）。

> **口径（二次修订登记）**：本表为**含 manifest-only 口径**（合计 261）；第四节「其中 atom」列为 **schema 口径**（合计 247）；§8.1 `atomCount` 填本表口径。platform-runtime 一行本表 34、第四节 30/31、L1 卡成员 35（多出的 1 是折叠别名 `rdev`）——四个数的来源见第四节注。

| 类目 | atom 数 | 其中 schema | 其中 manifest-only |
|---|---|---|---|
| 数据与行情（`data-market`） | 26 | 26 | 0 |
| 模型与推理（`ai-models`） | 26 | 25 | 1（`test-keys`） |
| 会话与上下文（`chat-sessions`） | 22 | 22 | 0 |
| 记忆与知识（`memory-knowledge`） | 14 | 14 | 0 |
| 技能与工具（`skills-tools`） | 16 | 15 | 1（`vision`） |
| 编码与版本管理（`coding-vcs`） | 26 | 25 | 1（`modules`） |
| 仓库体检与诊断（`repo-health`） | 25 | 23 | 2（`selfheal`、`traffic`） |
| 安全与账号（`security-account`） | 16 | 15 | 1（`credentials`） |
| 自动化与编排（`automation-orchestration`） | 28 | 26 | 2（`deliveries`、`hq`） |
| 平台与运行时（`platform-runtime`） | 34 | 30 | 4（`acp`、`cross-platform`、`entry`、`stepneo`） |
| 界面与偏好（`ui-preferences`） | 14 | 14 | 0 |
| 帮助与系统入口（`help-system`） | 14 | 12 | 2（`about`、`commands`） |
| **合计** | **261** | **247** | **14** |

48 个折叠别名不占 atom 行，其代表名见第五节「组合来源」列。

### 6.2 组合关系（41 组）

组合 = 多个 atom 在用户场景上是同一件事，或在代码层共享实现。判据只用代码事实（同一 dispatch case 体、同一 handler、别名表登记），不用「名字看着像」。

| 类目 | 组合名 | 成员 | 为什么是组合（证据） |
|---|---|---|---|
| dm | 自选行情面板 | `watch`、`rank` | `router.js:1628-1644` 两条命令真实现都在 `handlers/market.js`：`watch` 管自选清单、`rank` 对「自选∪常用」排序，共用 `marketDataService.getRealTimeQuote` 与 `userProfile.favoriteSymbols`；裸命令均活（`khy watch` 提示自选为空、`khy rank` 提示暂无可排行股票） |
| dm | 账户与持仓 | `account`、`position` | `router.js:1608-1617` 同案分派；`handleAccountInfo`/`handlePositionInfo` 同在 `routerHandlers.js:277-375`，同样 bootstrap + Trade/User 本地库查询、同样要求 `cliAuth` 登录 |
| dm | 回测工作台 | `backtest`、`strategy` | `router.js:1408-1447` 都 require `handlers/backtest`；一个管「策略是什么」、一个管「策略跑得怎样」 |
| dm | Token 用量账 | `cost`、`usage` | `routerDispatchOps.js:262-263` `case 'cost':` 直落 `case 'usage':` 同一 case 体；差异仅在动词表注册（`today`/`history`/`reset` 只注册在 `usage` 上） |
| dm | 可维护性元数据 | `metadata`、`meta` | `handlers/metadata.js` manifest 的 `aliases[0]` 即 `meta`；六件子命令（gen/refresh/check/show/link/hook）一致 |
| dm | 数据家运维 | `backup`、`storage`、`portable`、`sync` | 同域不重叠：`storage`=位置与迁移、`backup`=备份/校验/还原、`portable`=开发树→便携副本增量同步、`sync`=`portable` 的 legacy 兼容入口（`handlers/portableSync.js:4-14` 自述） |
| dm | 磁盘回收三兄弟 | `cleanup`、`clean`、`cleandisk` | 同一「回收磁盘」意图域、三个互不重叠作用域（自身数据保留策略 / 仓库构建产物 / C 盘系统垃圾）；名字邻街易选错，当前两个不可用一个行为分裂 |
| am | apikey 别名宿主 | `gateway` | `aliases.js:261` + `commandSchema.js:1611-1615/2176`（route `gateway config`），四条别名机制双中 |
| am | provider 别名宿主 | `gateway` | `aliases.js:742` + `commandSchema.js:1309-1314`；`handlers/provider.js` 为孤儿代码（零引用） |
| am | mode 别名宿主 | `persona` | `aliases.js:734` + `commandSchema.js:1240-1244/2181` |
| am | poor 别名宿主 | `effort` | `aliases.js:745`（defaultPositionals `['low']`）+ `commandSchema.js:1330-1334` |
| cs | 历史会话恢复 | `history`、`session`、`sessions` | 同服「找回过去的对话」但走两条存储面（`ai.listConversations` vs session handler 17 子命令）；恢复语义合一、管理面不同 |
| cs | 检查点与回滚 | `checkpoint`、`rollback`、`rewind`、`turn-rollback` | 一存三取：`checkpointService.saveCheckpoint` / `restoreCheckpoint` / `rollbackService` 按粒度恢复 / 按 AI 回合原子回滚；`undo` 是 `rewind` 的 patch 级名入口（`router.js:1908-1909` 同块） |
| cs | 上下文瘦身 | `compact`、`snip` | 同一目标两种机制：AI 摘要编排器 vs 直接裁消息；`routerDispatchSlash.js:346-349` 注释明确 `snip` 是 `compact` 的 user-driven 对应物；`force-snip` 是键入别名 |
| cs | 会话回顾 | `recap`、`summary`、`thinkback` | 三种尺度/机制：确定性抽取当前会话 / 总结当前对话 / 对本地使用数据做周期回顾 |
| mk | 记忆生命周期 | `remember`、`memory`、`dream` | 三个独立 dispatch case 覆盖同一条链路：追加 khy.md → 管同一个指令文件（含 distill 归档）→ 深度梦境蒸馏 |
| mk | 提示词工作台 | `prompt`、`prompt compose`、`prompt normalize`、`prompt optimize` | 四名共享同一个 dispatch case `'prompt'`（`routerDispatchOps.js:1573`，分支 :1681/:1702/:1704）；框架按多词名单列不折叠 |
| mk | 习惯与画像 | `habit`、`profile` | 同一个用户问题「AI 有多了解我」的两个读数（`usageHabitService` vs `userProfile`），服务不同源、case 在不同文件 |
| st | ext 别名宿主 | `extension` | `handlers/extension.js:371` manifest `aliases:['ext']`；`/ext` 与 `/extension` 同一 handler |
| st | webtools 别名宿主 | `web-tools` | `routerDispatchSlash.js:298-299` 同一 case fall-through，块体不按 command 分支 |
| st | reload-plugins 别名宿主 | `plugin` | `aliases.js:743` → `plugin reload`；`commandSchema.js:1315-1321` route 相同 |
| cv | autofix-pr 组合体 | `ci`、`autofix-pr` | 薄壳：读 CI 委托 `ciStatusService`，失败跑 `services/auditFixLoop`；与 `review` 自有的 Review→Fix→Verify 是两套并存。`autofix-pr` 自身即组合名宿主（二次修订补入成员列，与第五节「组合」标记互洽） |
| cv | subscribe-pr 组合体 | `ci`、`notify`、`subscribe-pr` | 薄壳：本地读 CI + PushNotify 通道推送；`notify` 属 `ao`，**跨类组合**——按第三节统一规则以「跨类参见」行标注，不把 `notify` 渲染成 cv 类 atom；`subscribe-pr` 为组合名宿主（二次修订补入） |
| rh | 健康总览 | `health`、`doctor`、`state`、`services`、`monitor`、`maintain` | 场景级组合（使用顺序）而非代码级依赖：彼此不互相调用；`maintain` 收口给「唯一下一步」且 red 时 `process.exitCode=1` 可当提交前门禁 |
| rh | 排障取证 | `log`、`debug`、`debug-tool-call`、`perf-issue`、`heapdump`、`break-cache` | 先现象后深挖：日志 → 工具调用回看 → 性能报告 → 堆快照/缓存击穿；`debug` 与 `debug-tool-call` 同后端（见第七节合并候选） |
| rh | 轨迹审计与确定性复现 | `trace`、`receipts`、`replay` | 共用轨迹存储但动词不重叠：查看/校验、浏览 A3 回执、导出复现包并复跑 |
| rh | 交付前验收 | `verify`、`heal`、`docs-check`、`init-verifiers` | 发布/合并前四件事：验证发布物真能跑、源码无缺失损坏（默认 dry-run）、文档不过时、校验器技能就位 |
| ao | 外部消息触达 | `notify`、`msg`、`wx`、`wxscan`、`feishu` | 五个入口都把 khy 的边界连到外部消息世界；前四个是能力，`wxscan` 只是 `wx scan` 的快捷壳 |
| ao | 无人值守底盘 | `cron`、`daemon`、`proactive`、`assistant` | 人不在场时系统自己动的四块地基，互为前提：排程要 daemon 承载，助理要 proactive 供 tick |
| ao | 多步任务编排执行 | `orchestrate`、`workflow`、`inertia` | 三个执行器各跑一种输入：`spec.json`（sequential/parallel/phase）/ 已定义工作流 / `plan.json` 任务级惯性执行 |
| ao | 多执行体协同 | `agent`、`agents`、`coordinator`、`topology`、`mesh` | 从代理内到进程间五层：真跑代理 → 类型清单 → 协调者看板 → 会话树拓扑 → 同机多实例网格 |
| ao | 任务与交付台账 | `hq`、`deliveries`、`tasks`、`job` | 「做到哪了」的四个账本，前三看存量、`job` 生增量 |
| ao | 规划与强度 | `ultraplan`、`ulw-loop`、`plan` | 都回答「想多深」而非「跑什么」：查看深度规划会话 / ultrawork 高强度执行 / 计划模式开关；是档位不是执行器 |
| ao | 目标与自治 | `goal`、`autonomy` | 自治闭环两半：一个定向（每轮注入提醒），一个回头看（只读巡检并可干预单个 flow） |
| ao | 反馈回路 | `issue`、`feedback` | 两条上报路径语义有别：`issue` 建 GitHub issue；`feedback` 只落本地草稿并指向上游、绝不静默外发 |
| pl | IDE 启动器族 | `kiro`、`cursor`、`claude`、`codex`、`trae`、`opencode`、`warp`、`vscode` | `router.js:2495-2502` 八个 case 落同一块，块尾统一 `handlers/ide.js:34`；块体按 command 分流（`claude`/`codex` 各有 adopt-env/use-relay/export-env）故不折叠；`inventory.impl.json` 对 8 名逐条记 duplicate-entry |
| pl | 远端开发统一入口 | `remotedev`、`rdev` | `routerDispatchTail.js:1943-1944` 同一块且块体不按 command 分流；`khy help rdev` 与 `remotedev` 除首行外逐字节相同 |
| pl | 手机联动族 | `phone`、`amoo` | 共用同一条收集式命令桥与放行集 `cli/tui/ccPhoneLinkCommand.js:24`（`ALLOWED = ['phone','amoo']`），背后分落两个 service；用途不同工故记族不折叠 |
| pl | 远程开发两面 | `remote`、`remotedev` | `remote` 的 connect 已交统一 facade 并在输出里引导看 `khy remotedev status`，但 `remote` 独有 hosts/exec/sessions/disconnect、`remotedev` 独有 attach/logs/stop，互相覆盖不全 |
| ui | theme 薄壳 | `skin`、`theme` | `routerDispatchSlash.js:1277-1302` 整个 case 只做转调（带参 → `skin set`，无参 → `skin list`），零自有实现；四条别名判据均不满足故框架不折叠，只登记组合。`theme` 为薄壳宿主本人（二次修订补入成员列，与第五节「组合」标记互洽） |
| hs | menu 导航壳 | `menu`、`docs` | `menu.js:41-371` 把 **10 个命令目标**（system/app/gateway/ai/training/docs/doctor/quote/backtest/data）+ `back` 改写为真实命令执行（`repl/startup.js:219-378` `executeMenuResult` 实际有 28 个 case，本会话复算）；本类内只覆盖 `docs` 一族，其余 **9 个**目标跨类——`menu` 是导航壳、无自有能力。**原稿订正**：原写「11 类操作…其余 10 个目标跨类」，本会话读 `menu.js:47-62` 实为 10 目标 + `back`，docs 之外仅 9 个跨类；`docs` 为组合名宿主（二次修订补入成员列） |

### 6.3 场景分组入口（83 组）

场景分组是「原子组装」的用户面：同一场景里的命令互为上下文，模型命中一个就该看见同组其它成员。

**分级定位（二次修订补——原稿没有级、没有预算、没有注入点）**：83 组场景全量 7662 字符（本会话复算本节表格，83 行），是 L0（3322）的 2.3 倍、L1 两次注入上限（1352）的 5.7 倍——常驻则 4000 预算直接爆。本版将场景定为**按需注入层**（第三节三级表第 4 行）：全量只存在于机读索引（§8.1 `scenarios` 字段）与检索面，**不常驻、不占 L0/L1 预算**；模型上下文只在命中后收到该组入口（单组 ≤140 字符，本会话复算最大行 140），以类目卡下方「同场景」追加行呈现（≤2 行 × ≤40 字）。「命中一个就该看见同组其它成员」由此实现，且不受 N=2 张卡上限约束（N=2 限的是类目卡张数，见第三节跨类成员统一渲染）。检索路径的第 ③ 步即在本层匹配触发时机文本。

| 类目 | 场景 | 入口命令 | 触发时机 |
|---|---|---|---|
| dm | 看盘：查价/找票/自选/排行/个股分析 | `quote`、`search`、`watch`、`rank`、`analyze` | 想知道某只股票现在什么价、代码是什么、自选股整体怎么样、谁涨谁跌、或让 AI 分析一只票 |
| dm | 交易：账户资金/持仓/下单预览 | `account`、`position`、`order` | 看自己还有多少钱、持有哪些仓、或想下一单（当前仅预览模式，未接交易接口） |
| dm | 验策略：回测与策略库 | `backtest`、`strategy` | 一个策略靠不靠谱，先拿历史数据回测；想知道有哪些策略可看 `strategy list` |
| dm | 管行情数据：下载/缓存/数据库/资源 | `data`、`cache`、`db`、`resource` | 行情数据要落地、缓存要清、库要初始化造数查状态、运行资源要就绪/校验/回收 |
| dm | 查账：Token 用量与会话导出 | `cost`、`usage`、`stats`、`export` | 今天/近 14 天烧了多少 token 和钱；当前会话规模；把会话导出成文件留底 |
| dm | 收磁盘：保留清理/构建回收/系统盘清理 | `cleanup`、`clean`、`cleandisk` | 磁盘紧了要回收——按保留策略收敛 / 仓库构建产物与可重装依赖 / C 盘系统垃圾与大文件 |
| dm | 保数据：备份/迁移/便携同步 | `backup`、`storage`、`portable`、`sync` | 数据家要备份校验还原、要搬家到非系统盘、开发版要增量同步到便携版 |
| dm | 留痕：工作区快照与项目元数据 | `workspace`、`metadata`、`meta` | 未提交改动要存档/对比/恢复；`works/record/ai` 种子文档要生成刷新检查 |
| am | 配钥匙·接入 AI 服务商 | `gateway`、`apikey`、`provider` | 首次安装、更换服务商或密钥失效：先配端点与 Key，再 `gateway status` 验证 |
| am | 选哪个脑子 | `model`、`advisor`、`khymodel` | 切换供应商/模型、让 khy 按实测表现推荐最佳模型（只推荐不自动切换）、看有哪些 KHY/本地模型 |
| am | 网关与通道健康 | `gateway`、`channels` | 请求报错、限流、熔断时看通道健康与故障转移顺序 |
| am | 推理档位·出多大力 | `effort`、`max`、`high`、`medium`、`low`、`poor`、`fast`、`20x`、`thinking`、`rtk` | 想更快、更省 token 或更顶格投入时逐档切换 |
| am | 本地推理与算力 | `runtime`、`models`、`local` | 离线/隐私场景或想用本机 Ollama、llama.cpp |
| am | 人格与角色 | `persona`、`mode`、`role` | 要特定语气/人设或角色扮演 |
| am | 多模型对比与合成 | `arena`、`moa` | 同一个问题想看多个模型的答案，或让 aggregator 模型合成一个最终答案 |
| am | 训练与算力摸底 | `compute`、`train` | 要 LoRA/蒸馏/导出自己的模型前先看本机算力 |
| am | 语音输入输出 | `voice` | 想开关 TTS 朗读/STT 听写时走 `/voice` 斜杠（键入裸动词目前只打印占位屏） |
| cs | 找回过去的对话 | `history`、`resume`、`session`、`sessions` | 想恢复上次或某次对话上下文，或浏览/重命名/删除历史会话 |
| cs | 上下文瘦身 | `context`、`compact`、`snip`、`force-snip` | 上下文窗口占用告急：先看占用，再选 AI 摘要压缩或手动裁消息 |
| cs | 改坏了要回头 | `checkpoint`、`rollback`、`rewind`、`undo`、`turn-rollback` | 手动存档项目状态；AI 改错文件要按检查点/快照/patch/回合回退 |
| cs | 开岔路与插话 | `fork`、`btw` | 复制当前对话去探索另一条路；或不打断当前请求先排队一句补充提示 |
| cs | 回顾与复盘 | `recap`、`summary`、`thinkback` | 复盘这轮会话做了什么、总结当前对话、周期回顾本地使用数据 |
| cs | 整理与取用 | `rename`、`tag`、`copy`、`share` | 给会话改名/打搜索标签便于检索，把回复复制到剪贴板，分享当前对话 |
| mk | 让 AI 记住这件事 | `remember`、`memory`、`local-memory` | 要把偏好/事实/约定写进 khy.md，或查看管理指令记忆文件 |
| mk | 记忆太乱，整理归档 | `dream`、`memory` | 记忆堆积、想归档陈旧/重复记忆、看记忆健康分，或周期性蒸馏 |
| mk | AI 有多了解我 | `habit`、`profile` | 想看使用习惯概况、下一步命令预测、用户画像与熟练度 |
| mk | 查量化知识 | `knowledge` | 搜索/统计/同步量化知识库条目 |
| mk | 提示词模板存着复用 | `prompt` | 保存/列表/使用/删除/检索提示词模板 |
| mk | 把提示词写好 | `prompt compose`、`prompt normalize`、`prompt optimize` | 写多行长提示词、静态体检四项、或让 LLM 按超级提示词方法论改写 |
| mk | 给 AI 装技能 | `skill`、`skills`、`skill-learning`、`skill-search`、`learn-skill` | 安装/搜索/运行/学习沉淀技能；后四个是 CC/Hermes 对齐别名，全部落 `skill` |
| mk | 从零学 KHY OS | `learn` | 新手交互式课程（10 层递进）、查学习进度/路线/排行 |
| cs | 回顾会话（误收本块 · 真源在 chat-sessions） | `insights` | 想看会话轮次/工具/话题/耗时回顾；框架归类归 chat-sessions，memory-knowledge 块按成员名单逐字登记 |
| st | 给 AI 装新能力（插件/扩展/MCP） | `plugin`、`extension`、`ext`、`reload-plugins`、`mcp` | 要给 AI 接新能力、换能力或改完让它生效 |
| st | 盘点 AI 现在有什么 | `toollist`、`toolcheck`、`capability` | 想知道模型这轮能调用哪些工具、工具契约是否完好、已学能力有没有测试覆盖 |
| st | 搬外部 agent 的资产 | `agent-assets` | 把 opencode/Claude Code 等外部 agent 的记忆·工具·技能三类资产迁进 khy |
| st | 让 AI 看图与联网 | `image`、`paste`、`web-tools`、`webtools`、`websearch` | 喂截图/剪贴板图片做视觉分析，或让它联网取最新信息、查当前搜索后端配置 |
| st | 易混入口辨异（跨类相邻） | `tools`、`agents` | `tools` 管数据家便携 CLI（归 pl），`agents` 列可用代理类型（归 ao），与 toollist/agent 名近义不同 |
| cv | 日常版本管理 | `repo`、`git`、`diff`、`branch`、`commit`、`push`、`worktree` | 写代码的过程中：看改动、判断该不该提交、存快照、推远程；另开一条互不干扰的线走 worktree |
| cv | 评审与 CI | `review`、`ci`、`autofix-pr`、`subscribe-pr` | 推送后看 CI 过没过；红了让 AI 审当前 diff 或在本地跑审计修复闭环；想让 CI 终态变化推通知 |
| cv | PR/MR 协作 | `pr`、`mr`、`commit-push-pr`、`pr-comments`、`prcomments` | 开 PR/MR（AI 生成标题正文），把评审/行内评论拉回会话继续改 |
| cv | 发布与部署 | `publish`、`restore`、`update`、`upgrade`、`deploy`、`image2web` | 打包发布、解包内嵌源码快照、检查安装新版本、部署启动、把网页截图还原成可运行页面 |
| cv | 依赖与开发环境 | `deps`、`dep`、`dependency`、`devenv` | 项目缺工具链时按需（可指定版本）安装；换电脑/开新项目前盘点并一键恢复 |
| cv | 仓库卫生与改动义务 | `gitignore`、`hooks`、`evolve`、`evolution` | 生成维护 .gitignore、看生命周期钩子、查这次改动触碰哪些可变性区域与联动义务 |
| cv | 远端项目侦察 | `forge` | 在 GitHub/Gitee/GitLab 搜索、侦察、克隆别人的项目 |
| cv | 多实例主角色 | `claim-main` | 同机跑多个 khy 实例时认领唯一「主」角色 |
| rh | 日常体检 | `health`、`doctor`、`state`、`services`、`monitor`、`self`、`maintain`、`maintainer` | 想知道整体是否健康、升级或提交前自检；先 health 一屏总览，红项再单点深挖 |
| rh | 排障取证 | `log`、`debug`、`debug-tool-call`、`debugtoolcall`、`perf-issue`、`perfissue`、`heapdump`、`break-cache` | 报错、卡顿、内存上涨、或怀疑前缀缓存导致结果异常 |
| rh | 轨迹审计与确定性复现 | `trace`、`receipts`、`replay` | 复盘某次会话做了什么、审计 A3 执行回执、或把问题现场打包给别人复现 |
| rh | 交付前验收 | `verify`、`heal`、`docs-check`、`init-verifiers`、`initverifiers` | 准备发布或合并前：验证发布物真能跑、源码无缺失损坏、文档不过时、校验器技能就位 |
| rh | 项目摸底 | `project`、`proj` | 新仓库或大项目，先看轻量地图再决定怎么改 |
| rh | 边界登记 | `files` | `files` 列的是当前会话上下文中的文件，属会话面；按成员名单要求登记，不参与仓库体检路由 |
| sa | 账号生命周期 | `register`、`login`、`whoami`、`passwd`、`forgot`、`user`、`logout` | 第一次用要注册；换机器或会话过期重新登录；忘记密码/改密码/改登录名/确认身份/退出 |
| sa | AI 危险权限门 | `ai` | 要让 AI 不经确认执行文件操作/命令时开 `ai dangerous`；无限制模式 `ai unrestricted`；owner 门 `ai owner` |
| sa | 威胁扫描与完整性校验 | `security`、`scan`、`security-review` | 跑项目安全扫描/完整性校验；要 ClamAV 病毒扫描并隔离用 `scan` |
| sa | 细粒度权限策略 | `permissions` | 按工具/路径/URL 配 auto/confirm/deny 白名单——与 `security permissions` 是两套并存机制，别混用 |
| sa | 机密存放 | `vault`、`local-vault` | 把 API token 等机密存本地（`~/.khyos/vault`，0600），模型用 `{{vault:NAME}}` 占位符引用 |
| sa | OS 命令沙箱 | `sandbox-toggle`、`sandbox`、`sandboxtoggle` | 切换 OS 级命令沙箱 on/off/auto（bwrap/Seatbelt/Job Object，持久化 .env） |
| ao | 没人在场也要跑 | `cron`、`schedule`、`daemon`、`proactive`、`assistant`、`notify` | 挂夜间任务、让 khy 后台自己运转，并在长任务完成或阻塞时通知到手机/桌面 |
| ao | 朝一个目标持续自治 | `goal`、`autonomy` | 有跨多轮的持久目标想让模型每轮都想着它；或先只读看看系统最近自治了什么 |
| ao | 一次布置多步任务 | `orchestrate`、`orch`、`workflow`、`workflows`、`wf`、`inertia`、`ultraplan`、`ulw-loop`、`plan` | 手头是「先 A 再 B、C 可并行」的多步活 |
| ao | 多个代理/多个实例一起干 | `agent`、`agents`、`coordinator`、`topology`、`forest`、`mesh` | 一个脑子不够：跑/spawn 角色代理、看代理类型、开协调者看板、看会话树、让同机多实例互相发现 |
| ao | 任务与交付做到哪了 | `hq`、`deliveries`、`tasks`、`job` | 要答「现在该干什么、干到哪了、交没交」 |
| ao | 把 khy 接进微信/飞书/钉钉 | `wx`、`wxscan`、`feishu`、`msg` | 想在聊天工具里直接驱动 khy；收消息依赖 daemon 长轮询 |
| ao | 工具本身出问题 | `issue`、`feedback`、`bug` | 对外可复现的走 `issue` 建 GitHub issue，对工具本身的反馈走 `feedback`（别名 `bug`） |
| pl | 起一个编码智能体后端 | `kiro`、`cursor`、`claude`、`codex`、`trae`、`opencode`、`warp`、`vscode` | 在终端里直接拉起某个 AI 编码后端，或 `--list` 看它有哪些模型 |
| pl | 让外部客户端接进本机 | `proxy`、`bridge`、`ide` | 让 Cursor/Trae 等客户端走本机代理服务，或让 IDE 连上 khy 的桥接通道 |
| pl | 手机与多端协作 | `mobile`、`phone`、`amoo` | 拿手机当第二块屏/协作端；三个都是「手机」语义但入口不同 |
| pl | 远端开发会话 | `remote`、`remotedev`、`rdev` | 通过 SSH 主机或统一远端会话在别的机器上写代码 |
| pl | 本机外壳与裸机内核 | `khyos`、`linux`、`shell` | 在本机跑命令、做网络连通诊断，或进 Khy OS 裸机内核（QEMU） |
| pl | 应用与伴随代理装卸 | `app`、`device`、`companion` | 装/卸/起停平台应用或设备应用，或管理 AgentFS 伴随代理 |
| pl | 本机运维与收尾 | `cloud`、`hardware`、`desktop`、`uninstall` | 同步云画像、看硬件与本地模型推荐、开桌面自动化高危闸、完整卸载并清理残留 |
| pl | 跨类参见（不占本类 atom 行） | `resource`、`clipboard` | 框架 assignment 不在本类（`resource`→dm、`clipboard`→st）；二次修订把原「随块保留」改为统一规则下的「跨类参见」标注（≤2 行），不再留在 pl 块当 atom |
| ui | 换肤与配色 | `skin`、`theme`、`color` | 换界面皮肤/主题，或给当前会话设强调色 |
| ui | 语言与输出风格 | `lang`、`output-style`、`outputstyle` | 要 AI 换种语言或说话方式 |
| ui | 键盘与输入行为 | `keybindings`、`keys`、`shortcuts`、`vim`、`terminal-setup`、`terminalsetup` | 查快捷键、开/关 Vim 按键模式、终端 Shift+Enter 换行不灵要检测配置 |
| ui | 状态栏与运行配置 | `statusline`、`config`、`env` | 查看/设置终端状态栏、查看或编辑分层配置、排查本机环境 |
| ui | 趣味与陪伴 | `stickers`、`buddy` | 想放松看贴纸，或查看/孵化伙伴宠物卡片 |
| hs | 上手引导 | `onboarding`、`docs`、`sub`、`subscribe`、`menu` | 新用户或换机后重跑首次引导、找内置教程与模型订阅指南 |
| hs | 命令发现 | `help`、`features`、`menu` | 忘了命令名、想按类浏览全部可发现功能 |
| hs | 自定位与现状 | `where`、`version`、`status` | 报障前自证环境、确认跑在哪份安装、哪个版本、当前会话状态 |
| hs | 会话收尾 | `clear`、`exit`、`quit` | 终端刷屏后清理、结束会话并保存对话 |
| hs | 产品自述 | `release-notes`、`releasenotes` | 升级后对照 CHANGELOG 确认行为变化 |
| hs | Word 文档样式重排 | `doc` | 重排 Word 标题/正文样式——与 `docs` 同名不同命令，别走错入口 |


---

## 七、精简提案与复核结论

> **本节 = 提案 + 复核结论（2026-11-11 复核已全部回收，79 条逐条有着落）**。动作列是经复核后的建议动作；「复核结论与证据」列给判定与关键证据（文件:行或本会话/复核方实测输出）。执行任何删除类动作前另须走 `RUNTIME-009`（报部位 + `rollback.txt`），修复类走 `RUNTIME-007`（先复现）；本轮只改文档，未动任何代码。**汇总统计（复核后）**：退休 3、降级 7、合并 36、保留 32、修复 1，共 79 条候选——`clean` 的退休提案被复核推翻（能力有文档背书且运行时提示仍在引导用户跑它），改为「修复（补分发）」；退休 4 → 3 即由此来。

| 命令 | 动作 | 并入 | 理由（摘要） | 复核结论与证据 |
|---|---|---|---|---|
| `clean` | 修复（补分发） | — | 原提案「退休」被复核推翻：能力有运维手册+设计文档背书，且运行时提示仍在引导用户跑这条命令；正属「文档说有、实现没有」的漂移，按规则不得判退休。派发缺失与死消费者属实 | **复核结论：退休不成立，改为补分发**。背书：`docs/07_OPS_运维/OPS-MAN/[OPS-MAN-029] 磁盘守卫-防膨胀机制.md:72/128/136/142`（「分级删除用 `khy clean --runtime --dry-run`」等 4 处）、`[DESIGN-ARCH-166]:203/245` 把 `clean.js` 的 RUNTIME_TARGETS 称作「`khy clean --runtime` 的删除真源」；活 hint：`runtime/node/backend/src/services/cleanupService.js:558` 与 `src/services/runtimeResourceProbe.js:346` 文本「运行 khy clean --runtime --dry-run 查看可回收的 …」。派发缺失属实：`inventory.impl.json` name=clean status=ghost；本会话实测 `node runtime/node/backend/bin/khy.js clean` → exit 1「⚠ 未知命令 "clean"；相近命令：clear、cleanup、learn」；`handlers/clean.js:806` 三个导出零 require 消费者；`commandSchema.js:120` 与 `:1852-1855` 确有 `/clean` 广告；本会话实测 `khy help clean` 有 75 字符正常回显（advertised 属实）。(复核记录 + 本会话实测) |
| `cleandisk` | 降级 | — | advertised 但一跑就崩（`stringWidth is not a function`；根因 `services/domain/backup/diskCleanup/index.js:19` 对 ESM 包 `require`）。能力真实存在（白名单+两道否决的 C 盘清理引擎），值得修而非删；修好前不应作为入口推荐 | **复核确认：降级成立**。崩溃根因逐字复现（复核记录）：diskCleanup 目录下 `require.resolve('string-width')` → `node_modules/.pnpm/string-width@5.1.2/.../index.js`，其 package.json `"type":"module"`，`typeof` 为 object、keys 为 `['__esModule','default']`。能力真实：`diskCleanup/index.js:6-11` 自述 junkCatalog 白名单+protectedGuard 两道否决 fail-closed。docs 检索「khy cleandisk」0 命中，无退休冲突。本会话实测：`khy cleandisk` 打印「阶段 1/3 磁盘概览（C:\）」后在「阶段 2/3 自动清理安全位置」扫描处中断、exit 非 0——崩在引擎处，与根因一致。(复核记录 + 本会话实测) |
| `sync` | 退休 | `portable` | 被 `portable sync` 完全覆盖：`handlers/portableSync.js:4-14` 自述 legacy 兼容入口；`once` 与新引擎同链。附带缺陷：help 标题「同步数据到云端」与实际「开发树→便携副本」完全不符 | **复核确认：退休成立**。`portableSync.js:4-14` 文件头自述 legacy 兼容入口；`router.js:2587-2588` `case 'sync'` → handlePortableSync。本会话实测 `khy sync` → exit 0「⚠ 旧的实时文件监听模式已被 khy portable sync 一键同步取代，不再启动监听 / khy sync 仅作为兼容入口保留（khy sync once 仍可用，已改走新同步引擎）」并主动推荐 `khy portable sync`；`khy help sync` 标题「同步数据到云端」（57 字符回显）与 `portableSync.js:90-220` once 实际走的「开发树→便携副本」引擎链不符。docs 检索「khy sync」仅命中 `docs/11_报告/历史/stash_patch.txt`（历史补丁，非设计背书）。(复核记录 + 本会话实测) |
| `cleanup` | 合并 | `cleanup`（统一为一条路径） | 同一命令两个活分派路径、契约相反：tail case 先于自注册被命中，裸命令直接执行销毁性动作（无 `--yes` 闸），`--dry-run --json` 全部落空；manifest（预览优先）100% 被 shadow。建议保留 preview-first 契约 | **复核确认：合并成立**。`router.js:1196` `dispatchTailCommand` 先于 `:1220` `commandAutoRegistry.dispatch` 返回；`routerDispatchTail.js:136-213` tail case 只判 `subCommand === 'status'`，其余分支直接 `cleanup.runCleanup()`（:194-198）完全不看 options；`handlers/cleanup.js:331-341` manifest 却是 preview-first（描述「默认只预览」、usage `[--yes] [--report] [--json] [--dry-run]`），被 100% shadow；`resolveAlias('数据保留')` → `{command:'cleanup'}` 亦落入同一 tail case。`khy help cleanup` 回显「默认只预览」与尾路径行为相反。复核方未跑裸 `cleanup` 以免触发真实删除，以上为读码判定。(复核记录) |
| `usage` | 退休 | `cost` | 同一 case 体、输出逐字节相同。**执行注意**：动词表 `today`/`history`/`reset` 只注册在 `usage` 上，`cost` 靠 args 回捞（`routerDispatchOps.js:268-283`）——保留代表名时必须把这段回捞一起保留，否则 `cost` 子命令会静默落全量报告 | **复核确认：退休成立**。`routerDispatchOps.js:262-263` `case 'cost': case 'usage':` 同一 case 体；复核方实测 `khy cost` 与 `khy usage` 输出逐字节相同（各 252 字符）；`:265-283` 注释与代码确认动词表只注册在 usage 上、cost 的 today/history/reset 靠 args 回捞——提案的执行注意事项与源码一致。`framework.json` rationale 折叠表第 38 行 `cost <= usage`（左为 atom 代表名）；docs 检索「khy usage」0 命中。本会话实测两者均 exit 0 且首两行一致（「Token 用量 & 费用 / ┌─ 本次会话」）。(复核记录 + 本会话实测) |
| `meta` | 退休 | `metadata` | 纯别名，无独立入口；`khy help meta` 回显 metadata 帮助块并自标别名 | **复核确认：退休成立**。`handlers/metadata.js:316-318` manifest aliases `['meta','元数据']`；本会话实测 `khy help meta` 回显 metadata 帮助块；`resolveAlias('meta')` → `{command:'metadata'}`；`framework.json` 折叠表第 49 行 `metadata <= meta`，meta 不在 atoms 而 metadata 在。`docs/07_OPS_运维/OPS-MAN/[OPS-MAN-038]:115` 记载「别名 meta / maintain」——折叠后别名仍可用，该文档依然为真。(复核记录 + 本会话实测) |
| `order` | 保留 | — | 无独立能力但是诚实的路标：整个 case 只有两句 printInfo（预览模式 + 用法），不接交易接口。交易动词族 `account`/`position`/`order` 少它就断链；不建议再投入，直到真有交易接口 | **复核确认：保留成立**。`router.js:1619-1623` 整个 case 体仅两句 printInfo（「下单功能需要连接交易接口，当前为预览模式」+用法），不接交易接口、不落单；`docs/07_OPS_运维/OPS-MAN/[OPS-MAN-023]:362` 如实标注为「预览桩」——与保留裁决一致，无背书冲突。(复核记录) |
| `search` | 保留 | — | 主能力（标的搜索）与 skills-tools 的联网搜索不重叠，删它会误伤。重复只在子命令级（`search web` / `web_search`） | **复核确认：保留成立**。`router.js:1450-1495`：`search web` 走 webSearchService（:1460-1465），否则 `symResolver().searchInstruments`（:1494）；`docs/07_OPS_运维/OPS-MAN/[OPS-MAN-027]:811` 记载「`khy search <keyword>` 搜索股票」。重复只在子命令级：`aliases.js:254` `websearch: {command:'search', subCommand:'web'}`；`src/services/domain/catalog/toolUseLoop/iterationSummary.test.js:80-84` 注释确认 web_search 折叠为 websearch。`framework.json` rationale:27 明确 search/websearch 跨类目切分、只登记不改写。(复核记录) |
| `max` | 合并 | `effort` | 被 `effort max` 完全覆盖（TUI `case 'effort-max'` 与 typed `effort max` 同一出口）；框架原子判据四条机制均未命中故当前留独立 atom。合并需补别名登记（代码改动） | **复核确认：合并成立**。TUI：`src/cli/tui/ink-components/App.js:3308-3317` `case 'effort-max'` → `ai().setEffort('max')`。经典 REPL：`src/cli/replSession.js:6552-6554` `selected.flag === 'effort-max'` 只写 `_effortLevel = 'max'` 并打印成功——全 backend/src 扫描 `_effortLevel` 仅 2 处命中（replSession.js:1491 声明、:6553 赋值），**零读取点**，故经典 REPL 的 /max 实际无效果。真出口是 `ai.js:305-311` setEffort（`routerDispatchSlash.js:513-537` `effort max` 同调）。附带事实：经典 REPL /max 当前是打印成功却不生效的谎话。(复核记录) |
| `high` | 合并 | `effort` | 同 `max`；`commandSchema.js:1948` route null + flag `effort-high`，无独立 route | **复核确认：合并成立**。`App.js:3308-3311` `case 'effort-high'` → setEffort('high')，与 typed `effort high`（`routerDispatchSlash.js:513-537`）同一出口；`inventory.impl.json` name=high note「仅 Ink TUI 分支；经典 REPL 选中无动作」；`commandSchema.js:1948` /high route null + flag 'effort-high'，无独立 route。(复核记录) |
| `medium` | 合并 | `effort` | 同 `max`；flag `effort-medium` | **复核确认：合并成立**。`App.js:3308-3311` `case 'effort-medium'` → setEffort('medium')；`commandSchema.js:1950-1955` /medium route null + flag 'effort-medium'；`inventory.impl.json` note 同 high。(复核记录) |
| `low` | 合并 | `effort` | 同 `max`；flag `effort-low`。注意 `/low` 与 `/fast` 文案仅几字之差但机制不同（effort 档 vs `_fastMode` 布尔），勿混并 | **复核确认：合并成立**。`App.js:3308-3311` `case 'effort-low'` → setEffort('low')；`commandSchema.js:1957-1961` /low route null + flag 'effort-low'。/low 与 /fast 机制确异：`replSession.js:1481` `_fastMode` 是布尔会话开关（:6279-6280、:7095-7096 翻转，全文件无读取点），与 effort 档位不同物。(复核记录) |
| `fast` | 保留 | — | 不是纯重复：TUI 路径开启时存当前 thinking/effort 再降档、关闭时恢复（带状态保存/恢复）。登记缺陷：REPL 路径 `_fastMode` 只写不读，typed `khy fast` 只打印提示——建议给 REPL 接线或删分支 | **复核确认：保留成立**。TUI `App.js:3353-3375`：开启时 `fastSavedRef.current = {thinking, effort}` 存底，再 setThinkingEnabled(false)+setEffort('low')，关闭时按 saved 恢复——确有状态保存/恢复，多于单纯 effort low。缺陷亦属实：`replSession.js:1481` 声明 `_fastMode`，:6279-6280 与 :7095-7096 翻转+打印，全文件无读取点；`routerDispatchSlash.js:572-575` typed `khy fast` 只打印「fast 模式是 REPL 会话级开关，请在交互模式运行 /fast」。REPL 只写不读与键入路径占位是另一笔待修账。(复核记录) |
| `voice` | 保留 | — | 有真能力：斜杠路径切 TTS/STT 并打印能力探测，开启后朗读回复，Alt+M 接入 Win+H 听写。登记缺陷：typed 裸动词是占位屏（双路径分裂）——应修键入路径而非退休命令 | **复核确认：保留成立**。双路径分裂坐实：`routerDispatchOps.js:1710-1736` typed `khy voice` 是占位屏（自述「Voice control placeholder — future integration with Windows Win+H」，打印「语音控制功能正在开发中」）；斜杠路径为真——`replSession.js:6988-7015` 与 `:5252-5269` `selected.flag === 'voice'` 调 voiceService.getVoiceSettings/setVoiceEnabled/getCapabilities。`docs/07_OPS_运维/OPS-MAN/[OPS-MAN-046]:16,146` 将 `khy voice` 列为旗舰特性。应修键入路径而非退休命令。(复核记录) |
| `provider` | 保留 | `gateway` | 入口保留（已是 gateway 别名，双 SSOT 登记）。但 `handlers/provider.js` 整文件孤儿代码（仅自身定义/导出被命中），应删或接线，属代码改动 | **复核确认：保留成立**。入口确为 gateway 别名：`aliases.js:742` `provider: {command:'gateway', subCommand:'config'}`；`commandSchema.js:1309-1312` /provider route 'gateway config'、desc 自述「对齐 Claude Code /provider → khy gateway config」；`framework.json` 折叠表第 32 行 `gateway <= apikey, provider`。孤儿文件亦属实：`handlers/provider.js:361` 导出 handleProviderCommand，backend src 全树 require 消费者为 0。另注意 `docs/10_规范/规则卡/[RUNTIME-006]:9-10` 与 `docs/10_规范/registry/RULES-REGISTRY.json:516-517` 把 `khy provider use <key>` 定为钉选通道的唯一合规写法——删/接线须走 `RUNTIME-009`，本轮未动。(复核记录) |
| `resume` | 合并 | `history` | `aliases.js:428` 把裸动词归一为 `history resume`，键入入口被遮蔽；自身 case 与 `history resume` 分支同调 `_handleResumeFlow`——同一能力两个名字，独立 case 实际不可达 | **复核确认：合并成立**。`aliases.js:428` `resume: {command:'history', subCommand:'resume'}`，resolveAlias 实测 `{command:'history',subCommand:'resume'}`；`router.js:1259-1274` `case 'resume'` 与 `routerDispatchOps.js:352-366` `history resume` 分支同调 `_handleResumeFlow`（`router.js:514` 注释自称 single source of truth）。设计文档记载的 boulder 能力不丢：`router.js:465-489` `_tryBoulderTaskResume` 处理 tasks/list 与 taskId，经别名仍可达——`[DESIGN-ARCH-077]:81/267/278`、`[OPS-MAN-026]:7/19-20`、`[DESIGN-DELIV-002]:59` 的 `khy resume <taskId>` 用法在折叠后照旧工作。(复核记录) |
| `undo` | 合并 | `rewind` | `router.js:1908-1909` 与 `rewind` 同块 fall-through 共调 `handleRollback`；handler 内按 `command==='undo'` 走 patch 级撤销，是 `rewind` 粒度族的子集 | **复核确认：合并成立**。`router.js:1908-1909` `case 'rewind': case 'undo':` 同块共调 handleRollback(command,…)；`handlers/rollback.js:41-53` 在 handler 内按 command==='undo' 走 patch 级撤销（svc.undo → `services/rollbackService.js:192` `rollback({granularity: PATCH, filePath})`）；`services/rollbackService.js:29` GRANULARITY={PATCH,TURN,SESSION,VERSION}，undo 是该粒度族子集；`framework.json` 折叠表第 59 行 `rewind <= undo`；`resolveAlias('undo')` 为 null（不走别名表，纯 case 折叠）。(复核记录) |
| `force-snip` | 合并 | `snip` | `aliases.js:736` 归一；replSession 注释「与 /force-snip 同效果」；slash route 相同——CC 对齐名的键入归一，无独立机制 | **复核确认：合并成立**。`aliases.js:736` `'force-snip': {command:'snip'}`，resolveAlias 实测 `{command:'snip'}`；`replSession.js:6613-6614` 注释「/snip — 手动裁剪近期消息以省上下文(与 /force-snip 同效果)」；`framework.json` 折叠表第 61 行 `snip <= force-snip`；`[IMPL-RPT-040]:30` 亦记为 CC 对齐名。(复核记录) |
| `sessions` | 合并 | `session` | `/sessions` route='session'，desc 与 `session` 命令 manifest 描述同义。**前置分歧**：`/session` 是 route:null+flag 的 REPL 孪生、只印会话时长/版本，合并前须先裁决这个孪生，否则合并会名不副实 | **复核确认：合并成立（附前置分歧）**。`commandSchema.js:2069` /session route null+flag 'session'；`:2070-2076` /sessions route 'session'、desc「浏览/恢复/重命名/删除历史会话（list\|show\|resume\|rename\|delete）」与 `handlers/session.js:1211-1216` manifest 描述「浏览、恢复与管理历史会话」同义。分歧亦属实：`replSession.js:6350-6355` `/session` flag 孪生只打印会话时长/版本，不触 handler——框架判据③（slash.route 相同才折叠）因此未折。合并前须先裁决该孪生。(复核记录) |
| `local-memory` | 降级 | `memory` | 别名双机制命中（`aliases.js:741` + `commandSchema.js:2177`），slash route 与 `/memory` 相同；help 自述「对齐 Claude Code /local-memory → khy memory」 | **复核确认：降级成立**。`aliases.js:741` `'local-memory': {command:'memory'}`，resolveAlias 实测 `{command:'memory'}`；`commandSchema.js:1302-1306` /local-memory route 'memory'、desc 自述「对齐 Claude Code /local-memory → khy memory」；COMMAND_ALIASES（`commandSchema.js:2177`）登记 '/local-memory': 'memory'；`framework.json` 折叠表第 48 行 `memory <= local-memory`。(复核记录) |
| `skills` | 降级 | `skill` | `aliases.js:737` → `skill(list)`；`commandSchema.js:2179` 登记 `/skills`→`skill list`；slash route 与 `/skill` 相同 | **复核确认：降级成立**。`aliases.js:737` `skills: {command:'skill', subCommand:'list'}`，resolveAlias 实测 `{command:'skill',subCommand:'list'}`；`commandSchema.js:1261-1264` /skills route 'skill list'、desc 自述「对齐 Claude Code /skills → khy skill list」；COMMAND_ALIASES（:2179）登记 '/skills': 'skill list'；`:1527` /skill route 'skill list'；`framework.json` 折叠表第 29 行 `skill <= learn-skill, skill-learning, skill-search, skills`。(复核记录) |
| `skill-learning` | 降级 | `skill` | `aliases.js:738` → `skill(learn)`；slash route 'skill learn' 与 `/learn-skill` 相同 | **复核确认：降级成立**。`aliases.js:738` `'skill-learning': {command:'skill', subCommand:'learn'}`，resolveAlias 实测一致；`commandSchema.js:1268-1271` /skill-learning route 'skill learn'、desc 自述「对齐 Claude Code /skill-learning → khy skill learn」；与 /learn-skill（:1282-1286 route 'skill learn'）同 route；`handlers/skill.js:39` 有 learn 分支、:748-749 manifest。(复核记录) |
| `skill-search` | 降级 | `skill` | `aliases.js:739` → `skill(search)`；与 `skill` 同落 `handlers/skill.js` | **复核确认：降级成立**。`aliases.js:739` `'skill-search': {command:'skill', subCommand:'search'}`，resolveAlias 实测一致；`commandSchema.js:1275-1278` /skill-search route 'skill search'；`handlers/skill.js:33` 有 search 分支、:748-749 manifest handler 注册。(复核记录) |
| `learn-skill` | 降级 | `skill` | `commandSchema.js:2183` 登记 `/learn-skill`→`skill learn`；尾参 dir/url 经 router 展开。顶层名刻意不撞 `/learn` 课程，故只折进 `skill` | **复核确认：降级成立**。`commandSchema.js:1282-1286` /learn-skill route 'skill learn'、desc 自述「对齐 Hermes /learn → khy skill learn dir\|url；顶层别名不撞 /learn 课程，尾参 dir/url 经 router 展开」；COMMAND_ALIASES（:2183）登记 '/learn-skill': 'skill learn'；`handlers/skill.js:282-283` dir/directory、:306-307 url/web 分支承接尾参展开；`resolveAlias('learn-skill')` 为 null（仅 slash 侧声明）。顶层名刻意不撞 /learn 课程的处理正确。(复核记录) |
| `insights` | 保留 | — | 非冗余入口：handler 在 `cli/handlers/insights.js`（读 sessionInsights + sessionPersistence），是会话回顾而非记忆/知识；框架归类归 chat-sessions | **复核确认：保留成立**。`handlers/insights.js:4-11` 自述「会话洞见：回顾一段会话——轮次、最常用工具、话题关键词、耗时」，读 `services/sessionInsights`（:19-21）与 sessionPersistence（:23-25）；`inventory.impl.json` name=insights status=ok；`framework.json` assignment 归 chat-sessions（非记忆与知识）。docs 背书：`[OPS-MAN-046]:13/86-89`、`[DESIGN-ARCH-159]:40/169/233`。(复核记录) |
| `ext` | 合并 | `extension` | `handlers/extension.js:371` manifest `aliases:['ext']`；`khy help ext` 返回 extension 帮助块；`/ext` 与 `/extension` 同一 handler 同语义 | **复核确认：合并成立**。`handlers/extension.js:369-381` manifest name 'extension'、aliases ['ext']；本会话实测 `khy help ext` 返回 extension 帮助块；`/ext` 与 `/extension` 同一 handler 同语义。被合并方 `extension` 有设计背书且被保留：`[DESIGN-ARCH-069]:26`、`[DESIGN-ARCH-145]:41`、`[OPS-MAN-012]:386-395`、`[DESIGN-TOOL-002]:29`。(复核记录 + 本会话实测) |
| `webtools` | 合并 | `web-tools` | 同一 case fall-through，无自有 slash 条目与 handler；`khy help webtools` 回显 web-tools 块并自标别名 | **复核确认：合并成立**。`routerDispatchSlash.js:298-299` `case 'web-tools': case 'webtools':` 同 case fall-through 共调 handlers/webTools.handleWebTools，无自有 slash 条目与 handler；本会话实测 `khy help webtools` 回显 web-tools 块；`[DESIGN-ARCH-209]`（本文）:527 记录同一判据。(复核记录 + 本会话实测) |
| `reload-plugins` | 合并 | `plugin` | `aliases.js:743` → `plugin reload`；`commandSchema.js:1315-1321` route 相同；`plugin` 的 reload 子命令已含此能力 | **复核确认：合并成立**。`aliases.js:743` `'reload-plugins': {command:'plugin', subCommand:'reload'}`；`commandSchema.js:1315-1320` /reload-plugins route 'plugin reload'、desc「重新加载插件(对齐 Claude Code /reload-plugins → khy plugin reload)」；本会话实测 `khy help reload-plugins` 标题即该 desc；`framework.json` 折叠表第 54 行 `plugin <= reload-plugins`。(复核记录 + 本会话实测) |
| `websearch` | 保留 | — | 有自有 slash 条目与独立语义（Kiro 联网搜索）；与 `search web` / `web_search` 三写法重复按框架「只登记不改写」，砍它要动 aliases 与 quant 的 search 子命令，属代码改动 | **复核确认：保留成立**。`commandSchema.js:1809-1816` /websearch route null、flag 'websearch'、desc「通过 Kiro 搜索网页获取最新信息」（本会话实测 `khy help websearch` 37 字符正常回显）；`aliases.js:254` `websearch: {command:'search', subCommand:'web'}`；`src/services/domain/catalog/toolUseLoop/iterationSummary.test.js:80-84` 注释与断言坐实 web_search 折叠为 websearch。`framework.json` rationale:27 明确「search/websearch → data-market:search, skills-tools:websearch」跨类目切分；:73-74「只登记不改写」。(复核记录 + 本会话实测) |
| `restore` | 合并 | `publish` | `publish.js:2131-2134` 注释自证「same code path as the top-level `khy restore`」；publish 侧 manifest 又登记一次。这是索引层合并，物理删除须走 `RUNTIME-009` | **复核确认：合并成立**。`handlers/publish.js:2131-2134` 注释自证「`khy publish restore` — same code path as the top-level `khy restore`」，同调 handleRestore；`:2357-2359` manifest name 'restore'、aliases ['restore-source']——publish 侧又登记一次。提案的索引层定性准确：`aliases.js:402-404`「还原/完整还原/还原项目」仍在支撑键入入口，物理删除未动。docs 侧 `[OPS-MAN-176]:32/226` 更明确规定顶层 `khy restore` 的源码包语义不可被数据恢复抢占。(复核记录) |
| `git` | 合并 | `repo` | `commandSchema.js:1749-1753` `/git` route='repo workspace'；`inventory.impl.json` 记 git 与 repo 共享 `handlers/repo.js` 且 status=duplicate-entry——只是 repo 的只读视图 | **复核确认：合并成立**。`commandSchema.js:1749-1753` /git route 'repo workspace'、label「工作区全貌」、desc「看当前工作区：位置 / 分支 / 远端 / 领先落后 / 待保存改动」（本会话实测 `khy help git` 47 字符回显即该 desc）；`inventory.impl.json` name=git implementedIn handlers/repo.js、status=duplicate-entry，note「斜杠 /git route="repo workspace" → repo」。docs 检索「khy git」0 命中，无背书冲突。(复核记录 + 本会话实测) |
| `commit-push-pr` | 合并 | `pr` | `aliases.js:744` 归一到 `pr create`；`inventory.impl.json` 记其与 pr/mr 共享 `routerDispatchTail.js:1955`。且名字比实现多承诺一步：`prCreateService.js:226-236` 只 push 当前分支，没有 commit 动作 | **复核确认：合并成立**。`aliases.js:744` `'commit-push-pr': {command:'pr', subCommand:'create'}`；COMMAND_ALIASES（`commandSchema.js:2182`）登记 '/commit-push-pr': 'pr create'；`routerDispatchTail.js:1955-1959` `case 'pr': case 'mr':` 共调 handlers/pr.handlePr；`src/services/prCreateService.js:226-236` 只有 `git push -u origin ${branch}`，无任何 commit 动作——名字比实现多承诺一步属实。(复核记录) |
| `upgrade` | 合并 | `update` | `aliases.js:462` 归一 + `commandSchema.js:2180` 登记；`routerDispatchSlash.js:305` 自身 case 转发 update，是键入不可达的死路径 | **复核确认：合并成立**。`aliases.js:462` `upgrade: {command:'update'}`；COMMAND_ALIASES（`commandSchema.js:2180`）登记 '/upgrade': 'update'；`routerDispatchSlash.js:305-314` `case 'upgrade'` 整体转调 route({command:'update', subCommand:null})——被别名归一遮蔽的键入不可达死路径；`inventory.impl.json` note 同一注记。docs 检索「khy upgrade」0 命中。本会话实测 `khy upgrade` exit 0 且走的是 update 的检查更新链（「检查 · GitHub Releases」）——经别名可用，合并不损失能力。(复核记录 + 本会话实测) |
| `mr` | 合并 | `pr` | `routerDispatchTail.js:1955-1956` 与 pr 同 case 块且块体不按 command 分支；`inventory.impl.json` status=duplicate-entry | **复核确认：合并成立**。`routerDispatchTail.js:1955-1956` `case 'pr': case 'mr':` 同一 case 块且块体（:1957-1959）不按 command 分支，共调 handlePr；`inventory.impl.json` name=mr status=duplicate-entry、note「与 pr / commit-push-pr 共享 routerDispatchTail.js:1955」；`framework.json` 折叠表第 34 行 `pr <= commit-push-pr, mr`。docs 检索「khy mr」0 命中。(复核记录) |
| `evolution` | 合并 | `evolve` | `routerDispatchTail.js:2023-2024` 与 evolve 同 case 块；duplicate-entry | **复核确认：合并成立**。`routerDispatchTail.js:2023-2027` `case 'evolve': case 'evolution':` 同块共调 handlers/evolve.handleEvolve；`inventory.impl.json` status=duplicate-entry；`framework.json` 折叠表第 42 行 `evolve <= evolution`。`docs/07_OPS_运维/OPS-MAN/[OPS-MAN-055]:4` 记载「`khy evolve`（别名 `khy evolution`）」——折叠后别名仍可用，该文档依然为真。(复核记录) |
| `dep` | 合并 | `deps` | `routerDispatchTail.js:2030-2032` 与 deps 同 case 块；duplicate-entry | **复核确认：合并成立**。`routerDispatchTail.js:2030-2035` `case 'deps': case 'dep': case 'dependency':` 三条共用同一 case 块、共调 handlers/deps.handleDeps；`inventory.impl.json` name=dep status=duplicate-entry；`framework.json` 折叠表第 30 行 `deps <= dep, dependency`。`docs/07_OPS_运维/OPS-MAN/[OPS-MAN-056]:4` 记载「`khy deps`（别名 `khy dep` / `khy dependency`）」——别名折叠后仍可用。(复核记录) |
| `dependency` | 合并 | `deps` | 同上，三条共用同一 case 块 | **复核确认：合并成立**。同 `dep`：`routerDispatchTail.js:2030-2035` 三条共块；`inventory.impl.json` status=duplicate-entry；`framework.json` 折叠表第 30 行 `deps <= dep, dependency`；`[OPS-MAN-056]:4` 将 dependency 记为 deps 别名。(复核记录) |
| `prcomments` | 合并 | `pr-comments` | `routerDispatchSlash.js:289-290` 同 case 块；duplicate-entry | **复核确认：合并成立**。`routerDispatchSlash.js:289-293` `case 'pr-comments': case 'prcomments':` 同块共调 handlers/prComments.handlePrComments；`inventory.impl.json` name=prcomments status=duplicate-entry；`framework.json` 折叠表第 55 行 `pr-comments <= prcomments`。(复核记录) |
| `push` | 保留 | — | 同一 token 两条语义且已实测坐实：裸动词落 `notify`（manifest 别名），`/push` slash route='repo publish'。框架按同类一致性裁决留独立 atom、L0 不渲染 `notify`=`push` | **复核确认：保留成立**。`handlers/notify.js:222-224` manifest aliases ['push','通知']（本会话实测 `khy help push` 182 字符返回 notify 帮助块）；`commandSchema.js:1763-1767` /push route 'repo publish'、desc「把保存的版本发布到远程仓库（= git push）」。`framework.json` rationale:74 按「同类一致性」把 push 切回独立 atom（coding-vcs）、notify 留 automation-orchestration，L0 不渲染 notify=push。docs 检索「khy push」0 命中。(复核记录 + 本会话实测) |
| `commit` | 保留 | — | 同名两种行为都是真能力：裸 `khy commit` 走提交时机判定（默认只判断不提交），`/commit` slash route='repo save' 直接提交。判定层是增量 | **复核确认：保留成立**。`handlers/commit.js:461-468` manifest 描述「判断现在该不该提交（提交时机）：判据全绿可直接提交，含删除/过大/敏感路径先问人」、usage `commit [--summary] [--yes -m "…"]`；`commandSchema.js:1756-1759` /commit route 'repo save'、desc「保存一个版本快照（= git commit）」。docs 背书：`docs/10_规范/DESIGN-GIT/[DESIGN-GIT-004] 提交时机规范.md:248`「人用命令 … `khy commit` … 默认只判断，真提交要显式 --yes」、:253、:358。(复核记录) |
| `claim-main` | 保留 | — | 无重复实现；语义偏同机多实例角色协调、与 ao 相邻；框架按 CC 对齐命令族归 cv，归类存疑已登记 | **复核确认：保留成立**。`handlers/claimMain.js:4-19` 薄壳自述「在同机多 khy 实例间认领唯一『主』角色…复用 getDataDir 的共享持久领地+指针+PID 存活+陈旧接管」，判定全在 `services/claimMain/claimMainPlan.js`；`inventory.impl.json` 记其与 claimmain 共享 `routerDispatchSlash.js:264` 但 note 标明是同一实现的第二个拼写。本文（第六/九节）均记保留、归类存疑已登记。(复核记录) |
| `branch` | 保留 | — | desc「创建/切换 git 分支」比实现宽：两条路径都只 `execSync 'git branch -a'` 只读列举。能力真且无第二入口，病症是描述失真——建议订正 desc 而非退休 | **复核确认：保留成立**。`commandSchema.js:2101-2106` desc『创建/切换 git 分支』；但两条路径都只读列举——`routerDispatchSlash.js:1304-1318` `execSync('git branch -a')`，`replSession.js:6478-6495` 同样 `execSync('git branch -a')`；`inventory.impl.json` name=branch status=ok（无 duplicate-entry）。本会话实测 `khy help branch` 28 字符回显『创建/切换 git 分支』。(复核记录 + 本会话实测) |
| `hooks` | 保留 | — | desc「管理生命周期钩子」比实现宽：只按事件列 registry 钩子数与总数，无增删子命令。只读展示是真能力，建议订正 desc | **复核确认：保留成立**。`commandSchema.js:2057` /hooks desc『管理生命周期钩子』；实现只读：`routerDispatchSlash.js:604-624` 只遍历 hookSystem.registry.events 列钩子数与总数（printTable + 「总计: N hooks」），无增删子命令；`inventory.impl.json` name=hooks status=ok。本会话实测 `khy help hooks` 23 字符回显『管理生命周期钩子』。(复核记录 + 本会话实测) |
| `debug` | 合并 | `debug-tool-call` | 同一后端零新逻辑：两门均默认开时默认行为逐字节相同，唯一差异是两门全关时的回退文案。因 debug 是独立 case 块、无 aliases 条目，框架四判据不折叠，故按重复入口登记合并 | **复核确认：合并成立**。`routerDispatchSlash.js:1320-1337` `case 'debug'` 在两门均开时 require handlers/debugToolCall 并调 handleDebugToolCall——与 `:183-188` `case 'debug-tool-call'` 调用同一函数；`cli/debugToolCall.js:22-28` isEnabled(KHY_DEBUG_TOOL_CALL)、`:35-41` menuInlineEnabled(KHY_DEBUG_MENU_INLINE) 均「仅 0/false/off/no 关闭」即默认开；本会话实测 `khy help debug` = 「调试工具调用」（21 字符）、`khy help debug-tool-call` = 「从当前会话 transcript 配对展示最近 N 个工具调用…」。差异确仅在两门全关时的回退文案（:1335 vs :186 之后路径）。因 debug 是独立 case 块、resolveAlias 无条目、/debug route null+flag 'debug'，四判据不折叠为别名，按重复入口登记。(复核记录 + 本会话实测) |
| `maintainer` | 保留 | — | 表面是别名（`aliases.js:216` → `docs maintainer`），实测活体输出「仓库维护入口」页。但 docs 属 help-system，折叠会跨类目；按框架「同类一致性」保留 | **复核确认：保留成立**。`aliases.js:216` `maintainer: {command:'docs', subCommand:'maintainer'}`（另 :219-223 维护/维护入口/维护文档/维护指南 同指）；`commandSchema.js:1721-1727` /maintainer route 'docs maintainer'；`docs.js:1000-1001` `sub === 'maintainer'` → handleDocsMaintainer；本会话实测 `khy maintainer` 输出「仓库维护入口」页、`khy help maintainer` 回显「查看维护地图、入口文档与分层验证命令」（38 字符）。`framework.json` assignment：maintainer → repo-health，docs/subscribe/sub → help-system——折叠会跨类目。本文第九节已明示此保留结论依赖「同类一致性」规则本身。(复核记录 + 本会话实测) |
| `docs-check` | 保留 | — | route 是 'docs check'，形态上是 docs 的快捷入口，但有独立 slash 条目与 help 回显，是仓库体检面的可发现入口；按同类一致性保留。若日后悔编应连同 docs 的归类一起评审 | **复核确认：保留成立**。`commandSchema.js:1728-1734` /docs-check route 'docs check'、desc「改源码后哪些文档可能过时(过时提醒 + 产物重生成 + 内嵌值同步),--fix 修复 · --ai 出改稿建议」；`docs.js:1012-1013` `sub === 'check' \|\| sub === 'freshness'` → handleDocsFreshness；`inventory.impl.json` 无 duplicate-entry 记录；`framework.json` assignment 归 repo-health（docs 归 help-system）；本会话实测 `khy help docs-check` 有独立回显。本文第九节已注明保留依赖同类一致性。(复核记录 + 本会话实测) |
| `security-review` | 合并 | `security` | `aliases.js:735` 归一 + `commandSchema.js:1247-1250` route='security scan'；与 security 共享同一 case 块、无独立实现 | **复核确认：合并成立**。`aliases.js:735` `'security-review': {command:'security', subCommand:'scan'}`；`commandSchema.js:1247-1250` /security-review route 'security scan'（复核方实测 `khy help security-review` = 「对工作树跑安全扫描(对齐 Claude Code /security-review → khy security scan)」）；`routerDispatchOps.js:1932` `case 'security'`、:1946-1948 `subCommand === 'scan'` → securityGuardService.scanForThreats；`inventory.impl.json` status=duplicate-entry；`framework.json` 折叠表第 60 行 `security <= security-review`。被合并方 `security` 有 `[OPS-MAN-052]` 背书且被保留。(复核记录) |
| `local-vault` | 合并 | `vault` | `aliases.js:740` 归一 + `commandSchema.js:1295-1298` route='vault'；共享 `handlers/vault.js` | **复核确认：合并成立**。`aliases.js:740` `'local-vault': {command:'vault'}`，resolveAlias 实测 `{command:'vault'}`；`commandSchema.js:1295-1298` /local-vault route 'vault'、desc 自述「对齐 Claude Code /local-vault → khy vault」；与 vault 共享 `handlers/vault.js`（`inventory.impl.json` status=duplicate-entry）；`framework.json` 折叠表第 65 行 `vault <= local-vault`。被合并方 vault 有 `[OPS-MAN-046]:10/25-29` 与 `[OPS-MAN-176]:101` 背书且被保留。(复核记录) |
| `sandbox` | 合并 | `sandbox-toggle` | `aliases.js:747` 归一 + `commandSchema.js:1343-1347` 及 `COMMAND_ALIASES:2178` 双登记 | **复核确认：合并成立**。`aliases.js:747` `sandbox: {command:'sandbox-toggle'}`；`commandSchema.js:1343-1349` /sandbox route 'sandbox-toggle'、desc 自述「对齐 Claude Code /sandbox → khy sandbox-toggle」；COMMAND_ALIASES（:2178）登记 '/sandbox': 'sandbox-toggle'；`inventory.impl.json` name=sandbox status=duplicate-entry（与 sandbox-toggle/sandboxtoggle 共享 `routerDispatchSlash.js:125`）；`framework.json` 折叠表第 35 行 `sandbox-toggle <= sandbox, sandboxtoggle`。(复核记录) |
| `sandboxtoggle` | 合并 | `sandbox-toggle` | aliases 无条目，仅靠同一 case 块跌落分发（四个别名里机制最弱的一个）；`khy help sandboxtoggle` 回显 sandbox-toggle 块并自标别名 | **复核确认：合并成立**。aliases.js 无该条目（复核方 findstr 'sandboxtoggle' 于 aliases.js 零命中）；`routerDispatchSlash.js:125-126` `case 'sandbox-toggle': case 'sandboxtoggle':` 同一 case 块、块体（:127-129）不按 command 名分支；复核方实测 `khy help sandboxtoggle` 回显 sandbox-toggle 帮助块并自标别名；`inventory.impl.json` name=sandboxtoggle status=duplicate-entry。(复核记录) |
| `scan` | 保留 | — | 与 `security scan` 目标重叠但引擎与入口均不同（ClamAV/antivirusService + REPL flag vs securityGuardService + router case）；实现未共享，故保留 | **复核确认：保留成立**。`replSession.js:5695-5709` `selected.flag === 'scan'` → services/antivirusService（detectTools/scanProject，ClamAV）；`routerDispatchOps.js:1932/1946-1948` security scan → securityGuardService.scanForThreats；scan 无 router case、仅 REPL flag 入口，`inventory.impl.json` name=scan status=ok（非 duplicate-entry）。本会话实测 `khy help scan` 29 字符回显『ClamAV 病毒扫描项目文件』。重叠在语义层、实现未共享。(复核记录 + 本会话实测) |
| `wxscan` | 合并 | `wx` | 无 handler 文件、四个 dispatch 文件均无 case；裸命令实测 exit 1；slash route 是 'wx scan' 而 `wx.js:944` 有真实 scan 子命令——零独立能力，纯快捷壳 | **复核确认：合并成立**。handlers/ 目录实测无 wxscan.js；四个 dispatch 文件 findstr `case 'wxscan'` 零命中；本会话实测 `khy wxscan` → exit 1「✗ 未知命令: wxscan」；`commandSchema.js:1595-1601` /wxscan route 'wx scan'、desc 自述「等价于 `/wx scan` 或 `khy wx login`」；`handlers/wx.js:944` `if (sub === 'login' \|\| sub === 'qr' \|\| sub === 'scan' \|\| sub === '扫描')` 有真实 scan 子命令。本文第六节已明示「前四个是能力，`wxscan` 只是 `wx scan` 的快捷壳」。注意 `khy help wxscan` 有 106 字符回显（advertised 但不可 dispatch）。(复核记录 + 本会话实测) |
| `plan` | 降级 | — | 它不是命令而是 REPL 模式开关（slash route:null + flag，消费点只做 `_planMode = true`）；裸命令实测 exit 1。放在自动化与编排类目是错位——它是交互行为档位，不承载任何编排 | **复核确认：降级成立**。`commandSchema.js:1509` /plan route null + flag 'plan'；本会话实测 `khy plan` → exit 1「⚠ 未知命令 "plan"；相近命令：clean、lang、pja」（相近命令里竟有 dispatch 缺失的 `clean`）；消费点 `replSession.js:5229-5233` 只做 `_planMode = true` 并打印「计划模式已开启」（该变量确有下游消费：:8487-8501 needsPlan 判定，故不是死代码）。与 /local（:1505-1506）、/thinking、/vim（:5234）同形。docs 检索「khy plan」0 命中，无背书冲突。本会话实测 `khy help plan` 27 字符正常回显（advertised）。(复核记录 + 本会话实测) |
| `schedule` | 合并 | `cron` | slash route 与 `/cron` 逐字相同；裸命令实测 exit 1 无独立执行面；help 自述「Claude Code /schedule 的 khy 等价入口 → khy cron」 | **复核确认：合并成立**。`commandSchema.js:1432-1436` /cron route 'cron'；`:1438-1444` /schedule route 'cron'——逐字相同，且 desc 自述「Claude Code /schedule 的 khy 等价入口 → khy cron」；本会话实测 `khy schedule` → exit 1「✗ 未知命令: schedule」；COMMAND_ALIASES（:2175）登记 '/schedule': 'cron'；`inventory.impl.json` name=schedule implementedIn handlers/cron.js、status=duplicate-entry；`framework.json` 折叠表第 39 行 `cron <= schedule`。被合并方 cron 有 `[OPS-MAN-067]:2893`、`[OPS-MAN-168]:71` 背书且被保留。(复核记录 + 本会话实测) |
| `bug` | 合并 | `feedback` | `routerDispatchSlash.js:117-118` 同一 fall-through 块同调 `handleFeedback`；help 自述别名；slash 表仍各占一行 | **复核确认：合并成立**。`routerDispatchSlash.js:117-122` `case 'feedback': case 'bug':` 同一 fall-through 块、块体不按 command 分支，同调 handlers/feedback.handleFeedback；`commandSchema.js:1099-1105` /feedback route 'feedback'、`:1106-1112` /bug route 'bug'、desc 自述「（/feedback 的别名…）」；`framework.json` 折叠表第 45 行 `feedback <= bug`；`inventory.impl.json` name=bug status=duplicate-entry。(复核记录) |
| `workflows` | 合并 | `workflow` | `ALIAS_MAP` 明写归一；slash route 与 `/workflow` 落同一 case；框架 L0 已折叠，slash 行是重复入口 | **复核确认：合并成立**。`aliases.js:746` `workflows: {command:'workflow'}`，resolveAlias 实测 `{command:'workflow'}`；`commandSchema.js:1336-1342` /workflows route 'workflow'、desc 自述「对齐 Claude Code /workflows → khy workflow」；`:2157` /workflow route 'workflow list'；`routerDispatchTail.js:2040-2044` `case 'workflow': case 'wf':` 共调 handleWorkflow；`framework.json` 折叠表第 36 行 `workflow <= wf, workflows`。(复核记录) |
| `agent` / `agents` | 保留 | — | 评估过重复、结论是保留：数据源与能力不同（cliAgentRunner 角色模板 16 个 vs getAgentDefinitions 30 条定义清单），`agent` 用法屏自己指向「查看全部可用代理类型请用 /agents」——代码明示互补 | **复核确认：保留成立**（角色模板数已订正为 17）。两者数据源与能力确异：`routerDispatchOps.js:1466-1532` `case 'agent'` 的 list/templates 读 `services/cliAgentRunner.listAgentTemplates`（:1470-1471），run/spawn 真跑代理（:1517-1532 agentRunner.runAgents）；`routerDispatchTail.js:895-899` `case 'agents'` 读 `../agents.getAgentDefinitions`（:896-898）——两套不同清单。**本会话复算：`listAgentTemplates()` 返回 17 个（`cliAgentRunner.js` DEFAULT_AGENT_ROLES 17 键：general/default/explorer/worker/explore/planner/coder/reviewer/implement/verify/codex/claude/general-purpose/Explore/Plan/verification/claude-code-guide）——原稿「16 个」系计数小差；同句对照的 `getBuiltInAgents()`=30 条属实（本会话实测 `src/agents/index.js` getBuiltInAgents().length=30）**。用法屏互补亦属实：:1485-1489 打印「直接运行：agent run …」并指向角色模板。docs 背书：`[DESIGN-ARCH-203]:48`「`khy agent list\|templates\|run\|spawn` \| OS 原生角色模板」。(复核记录 + 本会话复算) |
| `msg` / `feishu` | 保留 | — | 共享 messaging 核心但能力互补：msg 覆盖三平台群机器人 webhook，feishu 独有长连接传输与事件订阅。合并会丢掉长连接入站能力 | **复核确认：保留成立**。共享核心属实：`handlers/msg.js:27-37` 引 msgChannelCore/msgConfigStore/msgSender；`handlers/feishu.js:41-47` 引 msgConfigStore/msgChannelCore。但 feishu 独有长连接：`feishu.js:49-51` `adapters/im/feishuAdapter`、`:53-55` daemonManager，文件头 :11-13 自述「不需要公网入口(由客户端主动连出去)，要 app 凭据；掉线自动指数退避重连」。docs 背书：`[OPS-MAN-167]` 通篇把 `khy msg` 记为新增独立顶层命令（三平台群机器人 webhook）。(复核记录) |
| `ulw-loop` | 保留 | — | 看着像一行 shim，但它是 `ultrawork`/`ulw`/`ulwloop`/「高强度循环」/「超强循环」五个裸动词的唯一路由落点（两个是中文名）——删它一次切断 5 个入口 | **复核确认：保留成立**。`routerDispatchTail.js:2064-2074` `case 'ulw-loop'` 仅返回 `{aiForward: `ultrawork\n\n${task}`}`。但它是一条命脉：`aliases.js:481-485` `ulw`/`ultrawork`/`ulwloop`/`高强度循环`/`超强循环` 五个裸动词全部 → ulw-loop（本会话读 aliases.js:481-485 逐条确认，含两个中文名）。本文第九节已记录同为保留。(复核记录 + 本会话读码) |
| `rdev` | 合并 | `remotedev` | 同一 case 块且块体不按 command 分流；`khy help rdev` 与 `remotedev` 除首行外逐字节相同；框架 rationale 四已列折叠组 | **复核确认：合并成立**。`routerDispatchTail.js:1943-1947` `case 'remotedev': case 'rdev':` 同一块且块体不按 command 分流；复核方实测 `khy help rdev` 与 `khy help remotedev` 输出除首行命令名外逐字节相同（替换 rdev→remotedev 后相等，子命令同为 connect\|attach\|status\|logs\|stop\|help），无独立描述可喂 L1；`framework.json` 折叠表第 58 行 `remotedev <= rdev`；`inventory.impl.json` status=duplicate-entry。(复核记录) |
| `kiro` | 保留 | — | `inventory.impl.json` 记 duplicate-entry，但块体按 command 分流（框架判据①明确不折叠）；launcher 经 `resolveAgentLauncher` 解析，legacy five 与 registry-added backends 门控不同。是「同一实现的多个用户面名字」 | **复核确认：保留成立**。`router.js:2495-2502` 八名同一 case 块，但块体按 command 分流：:2509-2514 读 `subCommand \|\| args[0]` 作 verb 并 shift，:2519-2545 claude 三动词、:2550-2579 codex 三动词各自 `command === 'claude'/'codex'` 分支，末尾 :2580-2581 统一 handleIdeCommand(command,…)。`handlers/ide.js:34-44` launcher 经 agentLauncherRegistry.resolveAgentLauncher 解析，门关时 registry-added backends 不 resolve 而 legacy five 仍 resolve。`framework.json` indexFormat 更以「例：`kiro pl`（IDE launcher 族 8 名按块体按 command 分流不折叠，各自占行）」明确裁决。本会话实测 `khy help kiro` 45 字符正常回显。(复核记录 + 本会话实测) |
| `cursor` | 保留 | — | 同 kiro；用户对「启动 Cursor 编码智能体」的唯一拼写 | **复核确认：保留成立**。`router.js:2496` 与其余 7 名同一 case 块，块尾 :2580-2581 统一 handleIdeCommand；块体按 command 分流（:2509-2579）使 framework 判据①不折叠；`handlers/ide.js:39-40` resolveAgentLauncher 解析；`inventory.impl.json` 记 duplicate-entry 但 indexFormat 示例明确 8 名各自占行。(复核记录) |
| `claude` | 保留 | — | 同块共享 handler，但单开三个凭据便利动词（adopt-env / use-relay / export-env，落 `handlers/claudeAdopt.js`）——折叠会丢这三个动词的入口 | **复核确认：保留成立**。`router.js:2497` 同块共享 handleIdeCommand，但 :2519-2524（adopt-env/use-cc-env → handlers/claudeAdopt.handleClaudeAdoptEnv）、:2528-2536（use-relay/relay/relays → handleClaudeUseRelay）、:2540-2545（export-env/export-cc-env → handleClaudeExportEnv）为它单开三个凭据便利动词；codex 侧 :2550-2579 对等（handlers/codexAdopt）。(复核记录) |
| `codex` | 保留 | — | 同 claude（对等的 adopt-env / use-relay / export-env，落 `handlers/codexAdopt.js`） | **复核确认：保留成立**。`router.js:2498` 同块共享 handleIdeCommand，:2550-2555（adopt-env/use-codex-env → handlers/codexAdopt.handleCodexAdoptEnv）、:2559-2567（use-relay/relay/relays）、:2571-2579（export-env/export-codex-env）与 claude trio 对等；`inventory.impl.json` 记 duplicate-entry 但判据①不折叠。(复核记录) |
| `trae` | 保留 | — | 同块共享 handler；`aliases.js:301-304` 另有中文入口指向 proxy switch-center，说明 trae 在本仓有独立用户认知 | **复核确认：保留成立**。`router.js:2499` 同块共享 handleIdeCommand，launcher 名经 `ide.js:39-44` resolveAgentLauncher 解析；本会话读 `aliases.js:301-304`：traeswitch/traeproxy/trae切换/trae代理 指向 proxy switch-center（defaultArgs provider:'trae'），另有 :307-309 antigravity/nirvana/fanzhongli → trae——说明 trae 在本仓有独立用户认知与周边别名族。(复核记录 + 本会话读码) |
| `opencode` | 保留 | — | registry-added backend，受 `KHY_AGENT_LAUNCHERS` 门控——门控行为与 legacy five 不同，不能一并折叠 | **复核确认：保留成立**。`router.js:2500` 同块共享 handleIdeCommand；`handlers/ide.js:35-38` 注释明示「When the KHY_AGENT_LAUNCHERS gate is off, registry-added backends (opencode/warp/vscode) no longer resolve … The legacy five always resolve」——门控行为与 legacy five 不同。(复核记录) |
| `warp` | 保留 | — | 同为门控下的 registry-added backend；无第二个入口可替代 | **复核确认：保留成立**。`router.js:2501` 同块共享 handleIdeCommand；同受 `ide.js:35-38` KHY_AGENT_LAUNCHERS 门控（registry-added backend）；无第二个入口可替代它。(复核记录) |
| `vscode` | 保留 | — | 同为 registry-added backend 且带 model-select 变体；框架 indexFormat 明确裁决不退休 | **复核确认：保留成立**。`router.js:2502` 同块共享 handleIdeCommand，同为 registry-added backend（`ide.js:35-38` 门控）且带 model-select 变体（`router.js:2493-2494` 注释）；`inventory.impl.json` 记 duplicate-entry；`framework.json` indexFormat 更把「kiro pl（IDE launcher 族 8 名按块体按 command 分流不折叠，各自占行）」写成示例，明确裁决不退休。(复核记录) |
| `remote` | 保留 | — | 与 remotedev 近义但动词互补：remote 独有 hosts/exec/sessions/disconnect，remotedev 独有 attach/logs/stop；合并不是删一个能了事 | **复核确认：保留成立**。`handlers/remote.js:30-39` 有 hosts/connect/exec/sessions/disconnect 五面（:51 hosts 读 sshConfigService.listHosts），remotedev 没有；反过来 remote 的 connect 已交统一 facade（:79-81 remoteDevService.connect）并在 :92 输出「统一状态: khy remotedev status」。`[OPS-MAN-019]:5` 记载 `khy remote …` 子命令。本文第六节已明示「互相覆盖不全」。(复核记录) |
| `ide` | 保留 | — | 与 bridge 用途近义但不同工：`/ide` 只读探测本机 IDE + bridge 通道状态，bridge 管服务端起停与令牌。一个是探测报告，一个是服务控制面 | **复核确认：保留成立**。`routerDispatchSlash.js:272-276` `case 'ide'` → handlers/ideStatus（只读探测）；`commandSchema.js:1370-1376` /ide desc「查看本机已探测 IDE + khy bridge 通道状态(status\|list)，对齐 Claude Code /ide(khy 只读探测+bridge,不伪造 IDE 扩展握手)」；bridge 是控制面：`routerDispatchTail.js:2076-2089` start/stop/status/token/nginx，`commandSchema.js:1487-1493` desc「查看 IDE 桥接服务状态…只读默认,菜单不自动 start」。(复核记录) |
| `linux` | 保留 | — | 与 shell 近义但 linux 是网络诊断 + 17 个只读 allowlist 动词的安全模型；shell 是任意命令执行。allowlist 与诊断能力 shell 不覆盖 | **复核确认：保留成立**（allowlist 数已订正为 18）。`handlers/linux.js:1-5` 自述「Network diagnostics for AI connectivity + Safe allowlisted Linux command execution」；本会话读 `handlers/linux.js:19-38` ALLOWLIST **实为 18 个**动词：pwd/ls/cat/head/tail/grep/find/wc/du/df/ps/whoami/uname/date/ip/ss/ping/curl——原稿「17 个」系计数小差，不影响结论。shell 是任意命令执行 + --cwd/--timeout（`routerDispatchOps.js:2657-2685`，用法屏明示 `shell --cwd <dir> --timeout <ms> -- <cmd>`）；`inventory.impl.json` name=linux status=ok。allowlist 安全模型与网络诊断是 shell 不覆盖的独立能力，合并会丢安全边界。(复核记录 + 本会话读码) |
| `theme` | 合并 | `skin` | 整个 case 只做转调 skin（带参 → `skin set`，无参 → `skin list`），零自有实现；中文「主题」也解析到 skin。四条别名判据均不满足故不机械折叠，建议人工合并 | **复核确认：合并成立**。`routerDispatchSlash.js:1277-1302` `case 'theme'` 全部语句都是转调 route({command:'skin', subCommand:'set'\|'list'})；本会话读 `aliases.js:557` `主题` → skin list、`:560` `切换主题` → skin set（中文侧亦落 skin）；`resolveAlias('theme')` 实测 null（英文不映）；`commandSchema.js:2096` /theme route null + flag 'theme'，与 `:2156` /skin route 'skin' 不同；COMMAND_ALIASES 无 '/theme'。本会话实测 `khy help theme` 21 字符『切换配色主题』正常回显。`docs/07_OPS_运维/OPS-MAN/[OPS-MAN-016]:688` 的 `khy theme list` / `khy theme set catppuccin` 在「经 resolveAlias 落到 skin」后依然可用。(复核记录 + 本会话读码/实测) |
| `env` | 保留 | — | 无重复、仅归类存疑：只读环境展示，没有任何偏好/界面语义；现类 `system` 是兜底。属跨类目裁项而非退休/合并对象 | **复核确认：保留成立**。`routerDispatchSlash.js:539-557` 是只读环境展示（platform/Node/CWD/shell/git branch），无任何偏好/界面语义；`commandSchema.js:2032-2039` /env route null、flag 'env'、category 'system'；`inventory.impl.json` 无 duplicate-entry；`framework.json` assignment 归 ui-preferences。本会话实测 `khy help env` 19 字符『查看环境信息』。docs 检索「khy env」0 命中。跨类目裁项而非退休/合并对象，按给定分类结果保留在 ui 待人工裁。(复核记录 + 本会话实测) |
| `quit` | 合并 | `exit` | `router.js:1299-1301` 同一 case 块且块体 return 'exit' 不按 command 分支；`resolveAlias('quit')` 为 null（纯 case 折叠）；help 回显 exit 块 + 别名标注 | **复核确认：合并成立**。`router.js:1299-1301` `case 'exit': case 'quit':` 同一 case 块且块体 `return 'exit'` 不按 command 分支；`resolveAlias('quit')` 实测 null（不走别名表，纯 case 折叠）；本会话实测 `khy help quit` 回显 exit 帮助块（49 字符『khy exit — 保存对话并退出 khy OS』）；`framework.json` 折叠表第 43 行 `exit <= quit`，quit 不在 atoms。(复核记录 + 本会话实测) |
| `releasenotes` | 合并 | `release-notes` | `routerDispatchSlash.js:76-77` 同一 case 块；`resolveAlias` 为 null；help 回显别名标注 | **复核确认：合并成立**。`routerDispatchSlash.js:76-81` `case 'release-notes': case 'releasenotes':` 同一 case 块；`resolveAlias('releasenotes')` 实测 null；复核方实测 `khy help releasenotes` 回显 release-notes 块 + 别名标注；`framework.json` 折叠表第 57 行 `release-notes <= releasenotes`，releasenotes 不在 atoms。(复核记录) |
| `sub` | 合并 | `docs` | `docs.js:983` manifest 别名 + `resolveAlias` 回落自注册别名表；help 回显 docs 块 + 别名标注 | **复核确认：合并成立**。`handlers/docs.js:981-987` manifest aliases ['doc','subscribe','sub']；`resolveAlias('sub')` 实测 `{command:'docs'}`；本会话实测 `khy help sub` 回显 docs 块；`framework.json` 折叠表第 31 行 `docs <= sub, subscribe`，sub 不在 atoms。(复核记录 + 本会话实测) |
| `subscribe` | 合并 | `docs` | 同上，裸动词已折进 docs。**遗留**：`/subscribe` 是 route:null 的独立 slash 行（`commandSchema.js:1916-1922`），在 REPL 直调 `handleDocsSubscription`——裸动词折得掉，这条 slash chip 收不掉，属第二入口未收编 | **复核确认：合并（裸动词侧）成立，第二入口遗留亦属实**。裸动词侧：`docs.js:983` manifest aliases 含 'subscribe'；`resolveAlias('subscribe')` 实测 `{command:'docs'}`；`khy help subscribe` 回显 docs 块 + 别名标注。但第二入口未收编亦属实：`commandSchema.js:1915-1922` /subscribe 是 route:null + flag 'subscribe' 的独立 slash 行，`replSession.js:5892-5898` `selected.flag === 'subscribe'` 直调 handleDocsSubscription()，不经 docs 别名链——裸动词折得掉，这条 slash chip 收不掉，属第二入口需单独处理（提案已点明）。(复核记录) |
| `doc` | 保留 | — | `docs.js:983` 把 doc 列为 docs 别名，但 `commandAutoRegistry.js:423-425` 的守卫使该登记被静默跳过（doc.js 先注册先得）；`resolveAlias('doc')` 为 null；help 回显的是自己的 Word 样式块——两个不同能力。docs.js:983 的 doc 别名声明是死条目，宜删 | **复核确认：保留成立**。别名登记被静默跳过属实：`handlers/docs.js:983` 把 'doc' 列为 docs 别名，但 `commandAutoRegistry.js:423-427` `if (!_aliases.has(alias) && !_commands.has(alias))` 守卫使该登记被跳过的前提成立——`handlers/doc.js:242-249` 先注册 name 'doc'（aliases ['d','文档']），readdirSync 字母序 doc.js 在前；`resolveAlias('doc')` 实测 null；本会话实测 `khy help doc` 回显「文档操作：Word 标题/正文样式重排（Capability 实例）」而非 docs 块——两个不同能力。docs 背书：`[DESIGN-ARCH-059]:104`「`khy doc title <in.docx> [--match 文字] [--style 样式] [--size pt] [--color hex]`」。保持独立 atom 成立（docs.js:983 的 doc 别名宜删，属代码改动）。(复核记录 + 本会话实测) |
| `features` | 保留 | — | 与 `help`、`commands`/`catalog` 是三张命令清单但 SSOT 与能力不同：features 消费 slash catalog 全量 + 关键字过滤 + `--json`，与前端 FeatureCatalog、`GET /api/commands` 同源——有独立能力 | **复核确认：保留成立**。`handlers/features.js:54-107` handleFeatures 消费 `services/domain/catalog/commandCatalog/commandCatalog.buildCommandCatalog`（:57-59）+ 关键字过滤（:66-71）+ --json（:73-76）；`features.js:3-9` 注释自述「与后端 GET /api/commands、前端 FeatureCatalog 视图消费同一 SSOT」。另两张清单确非同源：`formatters.js:523` printHelp（约 30 条 curated 速查）；`router.js:1304-1310` `case 'commands': case 'catalog':` → commandCatalogUi.renderCommandCatalog（22 条精选盒）。本文第一节把 `khy features` 列为四条发现路径之一。本会话实测 `khy help features` 31 字符正常回显。(复核记录 + 本会话实测) |
## 八、机读索引提案

### 8.1 结构（提案）

由同一个生成器从 SSOT 渲染，禁手写第二份；守卫校验与 SSOT 逐字节一致，手改即判漂移。

```json
{
  "version": "1.0",
  "generatedAt": "2026-11-11",
  "ssot": ["constants/commandSchema.js", "cli/aliases.js"],
  "legend": { "dm": "数据与行情", "am": "模型与推理", "cs": "会话与上下文", "mk": "记忆与知识",
              "st": "技能与工具", "cv": "编码与版本管理", "rh": "仓库体检与诊断", "sa": "安全与账号",
              "ao": "自动化与编排", "pl": "平台与运行时", "ui": "界面与偏好", "hs": "帮助与系统入口" },
  "tiers": [
    { "level": "L0", "name": "常驻索引", "rule": "<代表名>\\t<类目键>[\\t=<别名>]", "budget": 4000,
      "note": "实测 261 行/3322 字符（本会话逐行复算 ≈3296，差 <1%）；mission 图例 12 行常驻后 ≈3780 字符，占 ECO_MAX_FILE_CHARS=4000 的 94.5%；余量由命令面棘轮背书（AGENTS.md 规则 12 / PROCESS-014，守卫 npm run check:delivery）" },
    { "level": "L1", "name": "分类速查", "rule": "按意图注入 ≤2 张类目卡", "budget": 1352,
      "note": "按 inventory.schema.json purpose 口径复算：最大卡 675 字符（platform-runtime 35 成员）、12 张合计 6029（本会话复算）；÷4 token 估算对中文为主的卡低估 3-4 倍，两卡实际约 900-1200 token" },
    { "level": "L2", "name": "按需详情", "rule": "khy help <名字>，累计 ≤3 次", "budget": 4194,
      "note": "本会话复跑 309 条全量：max=1398、p50=79、>600 共 4 条、<40 共 74 条；三套预算（文件 4000/类目卡 1352/help 4194）互不换算，L2 输出是否计入 ECO_MAX_TOTAL_CHARS=8000 未验证" },
    { "level": "SCENE", "name": "场景速查（按需注入层）", "rule": "命中场景组后注入该组入口，不常驻", "budget": 140,
      "note": "83 组全量 7662 字符（本会话复算）只存于本字段与检索面；单组 ≤140 字符；以类目卡下方「同场景」追加行呈现（≤2 行 × ≤40 字）" }
  ],
  "categories": [ { "id": "dm", "name": "数据与行情", "mission": "取数与存数：……", "atomCount": 26 } ],
  "atoms": [
    { "name": "gateway", "category": "am", "tier": "L0", "purpose": "管理 AI 网关与适配器",
      "aliases": ["apikey", "provider"], "zhAliases": [], "implementedIn": "router.js:1817" }
  ],
  "composites": [ { "name": "subscribe-pr 组合体",
                    "composedOf": [ { "name": "ci", "category": "cv" }, { "name": "notify", "category": "ao" } ],
                    "crossCategory": true, "why": "本地读 CI + PushNotify 通道推送；notify 属 ao，跨类成员以「跨类参见」行标注、不占 cv 的 atom 行" } ],
  "scenarios":  [ { "id": "dm-quotes", "name": "看盘", "commands": ["quote", "search"], "trigger": "……",
                    "inject": "按需，不常驻", "budget": 140 } ],
  "retireCandidates": [ { "name": "clean", "action": "fix-dispatch", "mergeInto": "", "reason": "退休提案被复核推翻：能力有 OPS-MAN-029/DESIGN-ARCH-166 背书且活 hint 在引导用户跑它；派发缺失属实，正确动作是补分发" } ]
}
```

> **8.1 口径与字段说明（二次修订补）**：
> ① `atomCount` 填 **§6.1 口径**（含 manifest-only，合计 261）；第四节的「其中 atom」列是 schema 口径（合计 247）——两个数都出自本文，填哪个必须写死，否则用户按类目核对时必然追问。
> ② `composites` 的成员从纯字符串数组改为 `{name, category}` 对象数组并加 `crossCategory` 标记——原格式（`"composedOf": ["watch","rank"]`）**表达不了跨类组合**，`notify`(ao) 与 `ci`(cv) 的组合会被抹平成同片；字段丢掉的维度无法被「与 SSOT 逐字节一致」的守卫校验出来，属静默信息损失。
> ③ `atoms` 增 `zhAliases` 字段承载中文入口（`健康`→`doctor`、`trae切换`/`trae代理`→`proxy`、`高强度循环`/`超强循环`→`ulw-loop` 等）——原三字段格式装不下中文入口，而本仓语言策略中文优先（`AGENTS.md` 语言策略）；该字段是否进 L0 常驻（预算 +426 字符量级）待人工裁，见第九节第 40 条。
> ④ `scenarios` 带 `inject`/`budget` 字段：场景是按需注入层，全量 7662 字符不进常驻文件；单组注入 ≤140 字符。
> ⑤ 三套预算（L0 文件 4000 / L1 卡片 1352 / L2 help 4194）互不换算，且都不等于 token 数；`ECO_MAX_TOTAL_CHARS=8000` 是否覆盖 L2 的 shell 输出未验证（第九节第 41 条）。
> ⑥ `retireCandidates` 的 `clean` 动作已按复核结论改为 `fix-dispatch`。

### 8.2 三条示例（提案）

```json
{ "name": "gateway", "category": "am", "tier": "L0", "purpose": "管理 AI 网关与适配器",
  "aliases": ["apikey", "provider"],
  "note": "apikey/provider 经 aliases.js:261/742 与 commandSchema.js:1614/1312 双机制折进；L0 渲染为 `gateway\\tam\\t=apikey,provider`" }
```

```json
{ "name": "prompt compose", "category": "mk", "tier": "L0", "purpose": "编辑器撰写长提示词",
  "aliases": [],
  "note": "多词名不拆：L0 名字字段 = 首个 TAB 前全部文本，故 `prompt compose\\tmk` 可无歧义解析" }
```

```json
{ "name": "watch", "category": "dm", "tier": "L0", "purpose": "管理自选股并看行情",
  "composite": "自选行情面板",
  "note": "与 rank 共用 handlers/market.js 与 userProfile.favoriteSymbols；场景分组 dm-quotes" }
```

### 8.3 接入点（模型上下文在哪些文件注入、怎么按需查找）

| 注入面 | 文件与常量 | 约束 |
|---|---|---|
| 生态层（L0 首选落点） | `runtime/node/backend/src/services/instructionEcosystemRegistry.js:12-14`：`ECO_MAX_FILE_CHARS=4000`、`ECO_MAX_TOTAL_CHARS=8000`、`ECO_MAX_FILES_PER_DIR=12` | L0 实测 3322 字符 + mission 454 ≈ 3780，单文件不超 4000。**落点待人工确认（二次修订登记）**：本会话读该文件确认 `.cursor/rules/*.mdc` 确被接纳（cursor 源 `{ base:'project', segs:['.cursor','rules'], mode:'dir', exts:['.mdc','.md'] }`，`instructionEcosystemRegistry.js:30-41`），但**仅 project 基**；全表只有 3 个 home 基源且都是单文件（`:24` codex `~/.codex/AGENTS.md`、`:87` gemini、`:97` qwen），没有 home 级规则目录源。第一节把第一类用户定义为「接入 Khy OS 的编码智能体（在用户自己的项目里工作）」——它们读不到 khy-os 本仓的 project 级规则文件，落点与服务对象矛盾，需人裁决（第九节第 45 条） |
| own 层（明确不走） | `runtime/node/backend/src/services/instructionFileService.js:42-43`：`MAX_FILE_CHARS=8000`、`MAX_TOTAL_CHARS=24000` | 那是记忆文件，`/remember` 会往里追加，索引与用户记忆共抢同一个 8000 单文件预算，超限被 `readFileSafe` 静默截断 |
| L1 命中判据 | `runtime/node/backend/src/routes/commands.js:33-51` 的 `?q=` | 同构的大小写不敏感包含匹配；语料 = mission（常驻）+ 成员名 + 用途文本；按类目数组顺序取前 2 张；**0 命中走四步降级链**（第三节） |
| L2 主路径 | `khy help <名字>` | 单次 ≤1398 字符（本会话复跑 309 条全量确认 max=1398）；59 个 router-only atom 在 `GET /api/commands?q=` 上取不到（catalog 只消费 212 条 slash，`.../domain/catalog/commandCatalog/commandCatalog.js:88-90`）——**59 的基数**：= 247 个 schema atom 中不在 212 条 slash 名内者（本会话复算）；按 261 全 atom 为 73、按 295−212 为 83，原稿未给基数，本版统一为 59 |
| 场景层 | §6.3 / §8.1 `scenarios` 字段 | 按需注入、不常驻：全量 7662 字符只在机读索引与检索面；命中后单组 ≤140 字符注入 |
| 防腐烂 | `services/domain/docs/docsFreshness/docMarkerSync.js:154` 的 `slash-commands ← getBuiltinSlashCommands()` 生成标记先例 | 索引由 SSOT 渲染、由守卫校验逐字节一致 |
| 命令面棘轮（余量的机制背书） | `AGENTS.md` 工程规则 12 / `PROCESS-014`；守卫 `npm run check:delivery`（`scripts/ci/check-delivery-baseline.js`），阈值真源 `[DESIGN-DELIV-002]` §4 | 命令/别名/handler/规则数只降不升：L0 余量只剩约 5.5% 不是文档自称的乐观，而是有棘轮兜底——新增 atom 须先退役一条；`--json` 可取得机读读数 |
| 素材偏差（未回写） | `entries/workflow-out/cmd-index/framework.json` `tiers` L2 rule 写「catalog 只含 203 条 slash 命令」 | 与本文 212 口径（代码实测 `getBuiltinSlashCommands()`=212 + `commandCatalog.js:88-90`）不一致；framework 的 L0/L1/L2 预算数（3322/919/8511/1838）也与本文二次修订后口径（3780/675/6029/1352）不同步——照素材复跑会得不同数字，本文以代码实测为准，是否回写素材待人裁（第九节第 47 条） |

---

## 九、落地顺序与未决问题

### 9.1 落地顺序（提案）

| 优先级 | 动作 | 理由 |
|---|---|---|
| P0 | 先修坏入口：`cleandisk`（ESM-require 崩溃，本会话实测阶段 2/3 中断）、`sync`（退休并删帮助谎言）、`cleanup` 双路径契约统一；`clean` 按复核结论**补分派**（不是退休——有文档背书且活 hint 在引导用户跑它）；给 `khy backup` 裸命令加子命令门槛 | 索引会把模型引向这些入口；入口是坏的，索引越准错得越远。原 P0 的「补分派或连广告下架」已由复核收敛为「补分派」一个选项 |
| P1 | 口径统一：14 个 manifest-only 名进 schema；裁决 `market`/`init`/`test-keys`/`growth`/`instructions`/`lazy` 等归类；收编 `/subscribe` 第二入口；统一 `atomCount` 口径（第四节 schema 口径 vs 6.1 含 manifest 口径） | 名单不齐就生成索引，「与 SSOT 逐字节一致」的守卫会从一开始就红，或从一开始就放过错值。**原稿把写生成器排在本步之前，已调序**——`market` 是活 router case 却不在 309 名单、`insights` 归类冲突会令下游按 atoms+categoryId 渲染成 mk、automation-orchestration 回传「成员名单字段为空」，名单不齐时生成器只会把错值固化 |
| P2 | 写生成器：从 `commandSchema` + `cli/aliases.js` + `khy help` 实测表渲染 L0/L1（含 mission 图例、跨类参见行、同场景追加行），落点经第九节第 45 条裁决后落地；加守卫校验与 SSOT 逐字节一致 | 让索引可生产、可防腐烂 |
| P3 | 执行第七节 79 条候选（按复核结论）：退休 3（`sync`/`usage`/`meta`）、降级 7、合并 36、修复 1（`clean` 补分派），每步一次提交；删除走 `RUNTIME-009`、修复走 `RUNTIME-007` | 精简是缩面动作，必须可回滚 |

### 9.2 未决问题（全部待确认）

> **本节不进模型上下文**：未决问题清单是给人看的裁决材料，不占 L0/L1/L2/场景任何一级预算；进上下文的只有三级表 + 场景层规定的内容（mission、类目卡、按需 help、按需场景组）。这正是「模型仍要全文背的清单」的边界：组合关系证据、错块清单、中文别名陷阱、router case 缺口等在本节登记，由生成器/守卫消费，不由模型背诵。

**归类与名单口径差**（各局部回传成员数与框架名册不一致，本文一律以框架名册为准）：

1. ai-models：回传 30 条 vs 框架 29（框架含 `init`、`test-keys`，回传未收）。且 `/init` slash desc 写「项目记忆脚手架」而 init manifest handler 是「API 密钥/模型通道初始化」——谁接手都要先裁决这个分歧。
2. chat-sessions：回传 22 vs 框架 25（`brief`/`insights`/`files` 未纳入）。
3. memory-knowledge：回传 18 vs 框架 19（`growth`/`instructions` 未收未证）。
4. skills-tools：回传 16 vs 框架 18（`convert`/`md`/`clipboard`/`vision`/`web_search` 不在本轮组装面）。
5. coding-vcs：回传 38 个名字 vs 框架 32；框架含 `modules`（模块打包管理）未被任何一方收。
6. repo-health：框架还有 `guide`/`selfheal`/`traffic` 不在回传成员名单（三者 help 实测均存在）。
7. security-account：框架 21 vs 回传 17（`pool`/`credentials`/`add-dir`/`adddir` 未纳入）。
8. automation-orchestration：回传称「成员名单字段为空，以框架 34 条为准」——34 = 32 schema + `deliveries`/`hq` 两个 manifest-only；若脚本期望另一份名单，逐字校验会失败。
9. platform-runtime：回传 29 vs 框架 31；且 `resource`/`clipboard` 归属分歧——框架 assignment 归 dm/st，回传按「现类口径」留在 pl 块随块索引（二次修订已把渲染规则统一为「跨类参见」，见第三节；归属分歧本身仍未裁）。
10. ui-preferences：回传 17 vs 框架 18（`lazy` 缺席，需确认本轮落入哪个类目）。
11. help-system：回传 19 vs 框架 16（`about`/`commands` 不在本轮成员单）。
12. `insights` 类目冲突：框架归 chat-sessions，memory-knowledge 块按成员名单逐字登记并注明「mk 不渲染其行」——若下游按 atoms+categoryId 渲染会得出 insights→mk。

**实现缺陷与未验证项**（均不代改，只登记）：

13. `market` 是活的 router case（本会话实测 `khy market` → exit 0，输出与 `rank` 相同：「暂无可排行的股票」）却不在 309 名单——名单缺口。
14. `analyze` 在 one-shot 模式下实测无回显（转发给 AI），其「个股分析」能力真实性未验证。
15. `cleandisk` 的 ESM-require 崩溃根因只在一处确认；同一模式是否还有别处副本未做全仓扫描。
16. `cleanup`「双路径」结论中「manifest 被 100% shadow」是据代码路径推断（已用中文别名实测佐证）。
17. 三处 help 文本与实现不一致：`sync` 标题「同步数据到云端」、`cleanup` 标题「默认只预览」、`clean` 整条有 help 无分派。
18. `khy backup` 裸命令直接开跑 create（实测复制 10943 个文件），与 help 列的子命令门槛不符，误敲成本高。
19. `search web` / `web_search` / `websearch` 三写法重复仍在（框架 rationale 七③ 只登记不改写）。
20. `max`/`high`/`medium`/`low` 的合并提案需补别名登记（代码改动）才会在四条别名机制下生效；当前按机械判据保留独立 atom，两者不矛盾。
21. REPL 与 TUI 双路径分裂：`/max`、`/high`、`/medium`、`/low`、`/fast`、`voice` 的真行为只在 TUI 或斜杠路径，REPL 路径只写不读或是占位屏（读码确认，未跑交互会话）。
22. `handlers/provider.js` 整文件孤儿；删文件属代码改动未动。
23. `gateway` 子命令数对不上：已归类注记写 23 个，按 `router.js:1817-1899` 数到 25 个分支（guide/help 同义则 24 个语义动词）——以代码为准。
24. `/compute` slash desc 写「管理计算资源」但 handler 只读且带参即拒；L1 用途按真实行为写「查看本地算力状态」。
25. `where` 的 manifest 描述含「数据家路径」但实跑输出没有该行——help 标题与行为不一致。
26. `subscribe` 双入口未收编：裸动词已折进 `docs`，`/subscribe` slash 行（route:null + flag）在 REPL 直调 `handleDocsSubscription`，L0 折进行覆盖不到它。
27. `status` 的 slash 元数据 route:null 与 router case 并存——`khy status` 实测可执行，但 catalog `?q=` 检索路径上取不到它。
28. `menu` 双重身份：按 L0 atom 登记，但实证它是跨命令的导航壳——本会话读 `menu.js:47-62` 实为 **10 个命令目标 + `back`**（system/app/gateway/ai/training/docs/doctor/quote/backtest/data）、`repl/startup.js:219-378` `executeMenuResult` 有 28 个 case（原稿「跨 11 个命令」已订正）；若框架后续收紧「atom = 有自有能力」需重新定性。
29. `doc`/`docs` 同名陷阱依赖注册顺序（`doc.js` 先于 `docs.js`），该守卫静默无告警——若 doc.js 改名或移除，`doc` 会静默翻成 `docs` 别名、行为翻转零提示。
30. `user rename`（改登录账号）与 chat-sessions 的 `rename`（改会话标题）同名不同义，跨类目不折叠，L0 两行并存。
31. `monitor` 与 `traffic` 语义重叠（AI 请求监控 vs 流量监控）；`traffic` 不在成员名单，重叠未处理。
32. 中文词「健康」经 `aliases.js:366`（本会话读码确认）指向 `doctor` 而非 `health`——用户说「健康体检」会落到 doctor，仓库既有歧义；这是中文别名整体缺席的一例，见第 40 条。
33. `maintain` 的 `health`/`doctor` 子命令不是独立命令的委托，而是驾驶舱总览同义词；`maintain` 真正委托的是 metadata handler——检索时容易误判为覆盖关系。
34. `doctor` 的 help 回显是 ops 块（已登记缺陷），其用途描述取自 slash.label 与 ops 块内一行，不是 help 标题。
35. `maintainer`/`docs-check` 保留为 atom 的结论依赖框架「同类一致性」规则本身；若上层裁决改判（允许跨类折叠），这两条候选应随之改为合并。
36. `app uninstall <name>` 与顶层 `uninstall` 同名不同工，按「不发明命令名、不折叠」处理，只在组里分开归口。
37. `vim` 的 dispatch 不在五个 router* 文件里，而在 TUI 层——只扫 router* 的别名判据守卫会漏掉它。
38. 设置界面 258 条的复现依赖本机家目录状态（`~/.khy/skills` 43 个、`~/.claude/commands` 0 个、命令插件 0 个）；截图机器精确目录内容无法证明。
39. 验证边界：本轮（含 2026-11-11 二次修订）只做了框架/两份 inventory 的复算、若干计数的脚本复算、309 条 `khy help` 全量复跑与十余条坏入口实测，**未运行任何自动化测试或 CI 守卫**（`check-agent-rules` / `rules:gate` / `check:delivery` 等均未跑）；各局部标注的「实测」为其回传材料中记录的本机运行，汇总编辑未复跑。**二次修订同样只读文档与代码文本、未跑守卫**——第八节验收标准「守卫校验与 SSOT 逐字节一致，手改即判漂移」建立在一个没跑过守卫的基线上，通过/失败均不可宣称，记为未执行；守卫首次实跑前，不得宣称该验收标准已满足。

**二次修订新增未决项（模型负担评审回收）**：

40. 中文别名整体缺席（高优）：L0 三字段只装英文名（「折叠别名 48」= atoms 与 assignment 的差集，纯英文）。但文档自己登记了中文入口：`aliases.js:366` 中文「健康」→ `doctor` 而非 `health`；`aliases.js:301-304` trae 另有 trae切换/trae代理 指向 proxy switch-center；`aliases.js:481-485` ulw-loop 五个裸动词含「高强度循环」「超强循环」两个中文名。这些在 L0/L1 均无位置，而本仓语言策略中文优先（`AGENTS.md` 语言策略）——索引对中文用户的路由能力为零。两选一待裁：(a) 第 3 字段扩为「全部别名（含中文）」——预算影响未复算（aliases.js 中文条目全量未点清，粗估 +400 字符量级，L0 将超 4000）；(b) L0 增第 4 字段 `中=<中文入口>`——同样需复算，且与 mission 常驻（+454）争同一份预算，两个扩张只能选一个。
41. L2 回退路径无预算：13 条错块回落到「slash.label 或 handler 文件」，读 handler 文件无上限，既不计入 4194 也不在 4000 文件预算内；三套预算（文件注入 4000 / 类目卡 1352 / help 输出 4194）互不换算，L2 的 shell 输出是否计入生态层 `ECO_MAX_TOTAL_CHARS=8000` 未验证；`cost`/`usage` 不在这 13 条里却同属 dm 组合体——本会话实测两者 help 回显正常（`cost` 30 字符、`usage` 52 字符），但动词表只注册在 `usage` 上的风险仍在（折叠 `usage` 时必须保留 args 回捞段，见第七节）。
42. L2 样本口径已统一、一处小差待确认：第一节「292/309 有回显」= 有**可用**回显（309−17，17 = 13 条标题只有命令名 + `models`/`model`/`doctor`/`gateway` 4 条错块或无描述，本会话实测逐条相符）；max/p50 等统计在 309 全量上算（本会话复跑：309/309 均有输出、max=1398、p50=79、>600 共 4 条、>1400 为 0、<40 共 **74** 条——框架材料记 79，差 5 条，计数口径待确认）。
43. 场景分组定级（本版已定为按需注入层，细节待验）：单组 ≤140 字符（本会话复算最大行）、「同场景」追加行 ≤2 行 × ≤40 字的上限未经实测校验；83 组全量 7662 字符只进机读索引与检索面，不常驻——若后续要把场景触发时机也塞进 L1 卡尾，L1 预算需重算（12 类目 × 约 120 字符 ≈ +1440）。
44. mission 常驻的取舍：12 条 mission 上移 L0 后 L0 ≈ 3780/4000（余量 5.5%）；压缩版（每条 ≤18 字）可降到约 3690。若第 40 条选 (a) 或 (b) 扩张中文字段会直接超支——mission 与中文别名两个扩张只能选一个，或先压缩 mission。
45. 注入点落点（落点与服务对象矛盾）：`.cursor/rules/*.mdc` 确被生态层接纳但**仅 project 基**（本会话读 `instructionEcosystemRegistry.js:30-41`：cursor 源 `{base:'project', segs:['.cursor','rules'], mode:'dir', exts:['.mdc','.md']}`）；全表只有 3 个 home 基源且都是单文件（`:24` codex AGENTS.md、`:87` gemini、`:97` qwen），没有 home 级规则目录源。第一节的第一类用户（外部编码智能体）在用户自己的项目里工作，读不到 khy-os 本仓的 project 级规则文件。待裁选项：家目录单文件（与 codex/gemini/qwen 同型，受 ECO_MAX_FILES_PER_DIR=12 与 4000 单文件约束）/ 随安装分发到用户项目 / 保持 project 级只服务本仓开发者（那就要改第一节的用户定义）。
46. 基线未经任何自家守卫验证：本文全部计数来自框架/两份 inventory 的复算与本会话脚本实测，**未跑 `check-agent-rules` / `rules:gate` / `check:delivery` / `check:version-sync` 等任何守卫**；文档修订也不改变这一状态。守卫首次实跑前，第八节「逐字节一致」验收标准只能记为未执行。
47. 素材偏差未回写：`framework.json` `tiers` L2 rule 写「catalog 只含 203 条 slash 命令」，与本文 212 口径（代码实测 `getBuiltinSlashCommands()`=212 + `commandCatalog.js:88-90`）不一致；framework 的 L0/L1/L2 预算数（3322/919/8511/1838）与本文二次修订后口径（3780/675/6029/1352）也不同步。素材是上游输入，本文以代码实测为准；是否回写素材、以及素材与文档谁权威，待人裁。
48. token 常数偏小：全文 token 估算用 ÷4，对中文为主的内容低估 3–4 倍（L1 卡约 2/3 中文，按中文约 1 token/字符量级，两卡实际约 900–1200 token 而非 460）；未过真实 tokenizer；`ECO_MAX_FILE_CHARS=4000` 是**字符**预算不是 token 预算，两者换算关系未验证——「减心智负担」的目标不能用字符数代答。
49. 「59 个 router-only atom」的叫法待订：本会话复算确认 59 = 247 个 schema atom 中不在 212 条 slash 名内者（按 261 全 atom 为 73、按 295−212 为 83）；但 14 个 manifest-only atom 压根不在 slash 面，把它们算进「router-only」不准确——叫法与基数需在生成器里写死（本文统一用 59 + schema atom 口径）。
50. 索引总表里五条实测跑不起来的命令仍以 L0 行出现：`clean`（本会话实测 exit 1）、`cleandisk`（崩）、`sync`（被 `portable sync` 覆盖）、`plan`（exit 1）、`wxscan`（exit 1）——落地顺序 P0 修入口、P3 才执行精简，按此顺序模型会先读到一份含 5 条死入口的索引。文档说「入口是坏的，索引越准错得越远」，却没有把死入口从第五节划掉或标注；建议生成器对 status=ghost/不可 dispatch 的名渲染 `†` 标记（第五节的 295 行与命令名不动，只加标记列）。

---

## 附：本文引用的一手材料

| 材料 | 位置 | 本文用途 |
|---|---|---|
| 分类与组装框架 | `entries/workflow-out/cmd-index/framework.json` | 第二/三/四/六节 |
| 模式面盘点 | `entries/workflow-out/cmd-index/inventory.schema.json` | 第二节口径、第五节用途列 |
| 实现面盘点 | `entries/workflow-out/cmd-index/inventory.impl.json` | 第二节实现错位、第七节判据 |
| 12 个类目局部组装结果 | 本轮各局部回传（索引块/组合关系/场景分组/精简候选/风险登记） | 第六节组装表、第七节精简提案、第九节未决问题 |
| 二次修订本会话复算（脚本实测，非文档转引） | 本会话对三个 routerDispatch* 文件的 case 标签计数（18/71/52=141）；`linux.js:19-38` ALLOWLIST（18 个动词）；`cliAgentRunner.js` DEFAULT_AGENT_ROLES（17 键）与 `src/agents/index.js` `getBuiltInAgents()`（30 条）；`menu.js:47-62`（10 目标 + back）与 `repl/startup.js:219-378`（28 个 case）；L1 卡按 `purpose` 口径逐卡复算（max 675 / 12 张 6029）；12 条 mission 合计 454 字符；L0 逐行复算（≈3296 vs 文中 3322）；`getBuiltinSlashCommands()`=212、`getCommandSchema()`=295、`getRouterCommandNames()`=265；atoms∖slash 四基数（59/73/83/49）；slash route 统计（166 非空 / 103 整串 / 63 多词）；`instructionEcosystemRegistry.js:12-14` 与 ECOSYSTEMS 全表（cursor 仅 project 基、3 个 home 单文件）；§6.3 表 83 行 7662 字符、最大行 140 | 第二/三/四/五/六/八/九节的订正 |
| 二次修订本会话实测（`node runtime/node/backend/bin/khy.js <args>`） | `khy help` 全量 309 条（295 schema + 14 manifest-only）：309/309 有输出、max=1398、p50=79、>600 共 4 条、<40 共 74 条；`khy help gateway`==`models`==`model`（1398 字节相同）、`doctor`==`ops`（775）、13 条标题只有命令名；坏入口：`clean`/`plan`/`schedule`/`wxscan` exit 1、`cleandisk` 阶段 2/3 崩溃、`sync` exit 0  legacy 提示、`market` exit 0、`upgrade` exit 0（走 update 链）、`cost`/`usage` 均 exit 0 | 第三节 L2 预算与缺陷、第七节复核证据、第九节未决项 |
