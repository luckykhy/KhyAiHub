# [DESIGN-DOC-007] 开发版文档地图与层间关系

> 本文档回答一个问题：**「这仓的文档到底怎么组织、改东西该看哪几篇、文档之间是什么关系」。**
>
> 语义真源：`docs/10_规范/registry/DOMAIN-DEPS.json`（层间依赖与硬约束）、
> `docs/00_INDEX_仓库根.md`（根层物理盘点）、
> `docs/10_规范/registry/RULES-REGISTRY.json`（规则与守卫登记）。
> 本篇是**索引之上的索引**：它不重复任何一篇规范的内容，只回答「去哪找、彼此什么关系、冲突时谁赢」。
>
> 状态：常驻规范。改动本文后须同步 `docs/10_规范/DESIGN-DOC/00_INDEX_DESIGN-DOC-总目录.md`
> 与 `docs/00_INDEX_文档索引.md`（`docs-index-complete` 规则会盯这两处）。

---

## 一、它解决的三个具体症状

| 症状 | 实情 | 本篇给什么 |
|---|---|---|
| 「文档好多，不知道从哪看起」 | 全仓 1001 篇 `.md`，**四条并存的导航轴**，每条都成立 | §二 的唯一入口与推荐路径 |
| 「看完一篇还是不知道它和别的什么关系」 | 文档之间**没有显式的依赖图**，只能靠猜 | §三 的层间关系与硬约束 |
| 「改个东西要跑哪些检查」 | 守卫有 90+ 个，但没人告诉你这次该跑哪几个 | §四 的「改 X → 读哪篇 → 跑哪几个守卫」路由表 |

---

## 二、唯一入口：四条导航轴的分工

四轴**不是重复**，各答一个问题。**先按你的问题选轴，再进文档。**

| 轴 | 回答的问题 | 入口 | 什么时候用 |
|---|---|---|---|
| **① 生命周期轴** | 「一个功能怎么落地」 | [`docs/00_INDEX_文档索引.md`](../00_INDEX_文档索引.md) | 找某阶段的成套文档（立项→设计→实现→测试→部署→运维→管理） |
| **② 意图速查轴** | 「**某件事**怎么做」 | [`docs/10_规范/00_INDEX_规范-总目录.md`](../00_INDEX_规范-总目录.md) §二 情景速查 | 手上有一件事要做，要「一条红线」 |
| **③ 认知顺序轴** | 「从启动一路读到 Agent-as-OS 愿景」 | [`[DESIGN-ARCH-063] 对照《Claude Code 架构》一书读懂 Khy-OS](../../03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-063] 对照《Claude Code 架构》一书读懂 Khy-OS.md) | **第一次**读这仓；想按理解顺序而不是分类顺序读 |
| **④ 物理层轴** | 「根目录那些条目是什么」 | [`docs/00_INDEX_仓库根.md`](../00_INDEX_仓库根.md) | 动根目录、加/删顶层目录、搞清 `runtime/` `delivery/` `works/` 的归属 |

### 2.1 开发工作的推荐路径

```
第一次进仓  →  ③ 认知顺序轴（DESIGN-ARCH-063）
                 ↓ 建立整体印象
要动手改    →  ④ 物理层轴（根索引）定位改动落在哪一层
                 ↓
具体这件事  →  ② 意图速查轴（情景速查）取「一条红线」
                 ↓
找成套材料  →  ① 生命周期轴（文档索引）
```

> **AI 接手**：先读仓根 `AGENTS.md`（工程规则 1–4）与 `CLAUDE.md`（红线 R1–R4 / 行为准则 B1–B8），
> 再用本篇的 §四 路由表定位「这次该读哪几篇、该跑哪几个守卫」。

### 2.2 两条易混的分界

- **文档轴 vs 机器可读真源**：本文讲「去哪找」，**不**是「值是什么」。
  值（版本号、层依赖、守卫清单、材料选材）一律以 `docs/10_规范/registry/*.json` 为准。
- **人读层 vs 机器层**：`docs/` 是人读的；`works/record/ai/` 是机器生成的骨架
  （`MAP.md` / `CONTEXT.yaml` / `GUARDS.md`），由 `khy metadata refresh` 维护 —— **不要手改**。

---

## 三、层间关系：五域模型与硬约束

### 3.1 五域（物理层 ↔ 逻辑域的映射）

真源：[`DOMAIN-DEPS.json`](../registry/DOMAIN-DEPS.json) 的 `domains` 段。
**依赖方向自上而下，箭头方向 = 允许依赖的方向。**

```
D4 交付与接入   apps/  delivery/  entries/  works/ship/
      ↓ 可依赖 D1/D2/D3/D4
D1 运行时内核   runtime/boot/kernel/  runtime/substrate/platform/
                runtime/node/backend/{bin,src/cli,src/routes,src/services}
      ↓ 可依赖 D2/D3
D2 业务上下文   runtime/node/backend/src/services/domain/   （business/ 未建，见 §3.4）
      ↓ 可依赖 D3
D3 共享底座     runtime/node/backend/src/{utils,constants}   ← 温层，被大量依赖

D5 工程与档案   scripts/  docs/  .github/  works/{deploy,patches}
      ⚠ 任何域都**不得**依赖 D5（D5 只被构建与治理工具读，不被运行时读）
```

各域一句职责：

| 域 | 职责 | 温度 |
|---|---|---|
| **D1** 运行时内核 | 平台作为操作系统跑起来：引导、启动器、Node 运行时、CLI 会话 | 热 |
| **D2** 业务上下文 | 平台对外提供的业务能力，各自内聚一块（messaging / trajectory / project / network / security …） | 热/温 |
| **D3** 共享底座 | 被大量复用、只被依赖不反向依赖 | 温 |
| **D4** 交付与接入 | 面向人的产物与接入面 | 热/温 |
| **D5** 工程与档案 | 造它 / 验它 / 记它的东西 | 冷 |

### 3.2 四条硬约束（`DOMAIN-DEPS.json` → `enforced` 段，机器判）

| ID | 谁不能依赖谁 | 依据 |
|---|---|---|
| `d3-purity` | **D3 不得**依赖 D1/D2/D4/D5 | 「基础设施层不得反向知道业务」 |
| `no-reach-into-archive` | **D1/D2/D3/D4 都不得**依赖 D5 | 「D5 不被任何域依赖」 |
| `d2-no-reach-into-d1` | **D2 不得**依赖 D1 | 「领域层不依赖基础设施层」单向约束 |
| `domain-direction-*` | 各域 `mayDependOn` 白名单外的边一律禁止 | `domains.*.mayDependOn` 的真实 require 化 |

> 执行器：`scripts/ci/check-repo-layout.js` 的域向规则 + 基线棘轮
> （`scripts/ci/repo-layout-baseline.json`，只降不升）。读数用
> `node scripts/ci/check-repo-layout.js --list=domain-direction`。

### 3.3 文档放在哪一层

改代码前先想清楚「我改的是哪一层」，文档跟着层走：

| 域 | 文档主要落在 | 守卫关注 |
|---|---|---|
| D1 | `docs/03_DESIGN_设计/DESIGN-ARCH/`、`docs/04_IMPL_实现/` | 上帝文件门（`arch:god`）、分层规则 |
| D2 | `docs/03_DESIGN_设计/DESIGN-ARCH/`、`docs/05_TEST_测试/` | 域向规则（`d2-no-reach-into-d1`） |
| D3 | `docs/10_规范/DESIGN-API/`、`DESIGN-MEM/` | `d3-purity` |
| D4 | `docs/06_DEPLOY_部署/`、`docs/03_DESIGN_设计/DESIGN-FE/` | 前端 token / size 守卫 |
| D5 | `docs/10_规范/`、`docs/08_MGMT_项目管理/` | 治理规则（`check-gov-rules`） |

### 3.4 已知缺口（写下来免得再当成「没这回事」）

- **`business/` 域目录未建**：31 个上下文 / 1184 文件仍埋在
  `runtime/node/backend/src/services/domain/`（靠 `domains.D1.overrides` 逐前缀豁免成 D2）。
  缺口全貌见 [`[RESEARCH-026] 531目录架构设计与缺口重算`](../../11_报告/RESEARCH/[RESEARCH-026]%20531目录架构设计与缺口重算-2026-10-10.md)。
- **D3 物理上不再是并列根域**：`runtime/substrate/` 挂在 `runtime/` 之下，
  但 `DOMAIN-DEPS.json` 里 `targets.D3` 仍登记为独立第五域 —— **逻辑域 ≠ 物理目录**，
  读文档时别把这两者混为一谈。
- **根层仍有四个架构目录未归域**：`apps/` `docs/` `scripts/` `entries/`（见 `00_INDEX_仓库根.md` ⑤）。

---

## 四、「我要改 X」路由表

**先按改动类型定位行，再照该行的三列走。** 守卫列是**必跑**（最少集），不是全集。

| 改什么 | 改在哪层 | 动手前先读 | 必跑守卫（最少集） |
|---|---|---|---|
| 后端业务逻辑 / 新服务 | D1 或 D2 | `docs/10_规范/00_INDEX_规范-总目录.md` 情景速查 → 对应域规范；该模块的 `khy.module.json` | `check-agent-rules --changed`、`check-repo-layout`、`check:change-safety --changed` |
| 跨域依赖 / 新建跨层调用 | D1↔D2↔D3 | `DOMAIN-DEPS.json` `enforced` 段 + `docs/10_规范/DESIGN-LAY/` | `check-repo-layout`（域向规则）、`check:cycle-deps` |
| 网关 / 模型适配 | D1 | `docs/03_DESIGN_设计/DESIGN-ARCH/` 里 ai-gateway 系列 | `check:agent-rules --changed`、`check:model-hardcoding`、`check:weak-model-guard` |
| CLI / TUI 交互 | D1 | `runtime/node/backend/src/cli/tui/AGENTS.md`（**该子系统的约束真源**） | `check:tui-gates`、`check:tui-cadence`、`check:no-emoji` |
| 前端 / 桌面端 | D4 | `docs/10_规范/DESIGN-FE/` | `scripts/ci/check-frontend-tokens.js`、`check:frontend-design-tokens`、`check:frontend-size` |
| 数据家 / 存储路径 | D1 | `docs/10_规范/DESIGN-LAY/` + `runtime/node/backend/src/utils/dataHome.js` 头注释 | `check-repo-layout`（根层盘点）、`check:data-layout`、`check:path-integrity` |
| 目录搬移 / 改顶层结构 | D5 | `docs/10_规范/DESIGN-LAY/[DESIGN-LAY-008]`（方案 R/§13、§17.3 终态树） | `check-repo-layout`、`check:path-integrity`、`check:runtime-placement` |
| 文档（新增/改名/归夹） | D5 | **本文** + `[DESIGN-DOC-001] 文档结构规范` | `check:layout`（`docs-index-complete`）、`check:doc-drift`、`check:doc-claims`、`check:doc-numbers` |
| 规则 / 红线 / 治理 | D5 | `CLAUDE.md` 第一、二章 + `docs/10_规范/registry/RULES-REGISTRY.json` | `check:gov-rules`、`check:rules-registry`、`check-rule-scaffold` |
| 版本号 / 发布 | D5 | `[DESIGN-SEMVER-002]` + `scripts/release/version-mode.js` 的用法 | `check:version-sync`、`scripts/ci/check-version-bump-approval.js`、`scripts/ci/check-version-freshness.js` |
| 软著登记材料 | D5 | `works/record/evidence/06_申报材料/递交核对表.md` + `scripts/copyright/repo-contract.md` | `check:copyright`、`scripts/copyright/build-materials.js` |
| 密钥 / 凭据 | D1 + D5 | `CLAUDE.md` R2 + `scripts/check_builtin_keys.py` | `check:staged-secrets`、`scripts/ci/check-secrets-staged.js`、`scripts/ci/security-scan.js` |

### 4.1 三守卫为什么是「必跑」

`CLAUDE.md` 第三章规定的三道门（任何改动都要过）：

```
node scripts/ci/check-change-safety.js --changed
node scripts/ci/check-agent-rules.js --changed
node scripts/ci/check-repo-layout.js
```

> 三守卫须在**仓库根**跑；untracked 新叶子须**显式**传路径扫描。

### 4.2 改文档的额外义务

新增/改名/归夹一篇文档时，**同时**做这三件（漏一件 `check:layout` 亮红）：

1. 在 `docs/00_INDEX_文档索引.md` 补一行（或其就近 `00_INDEX_*` 收录）；
2. 在**就近** `00_INDEX_*` 索引收录（`docs/10_规范/DESIGN-DOC/00_INDEX_DESIGN-DOC-总目录.md` 这类）；
3. 编号唯一、不复用、不跳号（`[XXX-YYY-NNN]`）。

### 4.3 目录搬移之后：路径引用必须一起搬

方案 P（2026-09-30）把 `services/` `platform/` `kernel/` `extensions/` `software/` 等
整体搬进 `runtime/` `delivery/` `works/`。**搬完目录不等于搬完引用** ——
实测搬移后仍残留 **873 处**指向旧布局的路径引用，散在 170 多个文件里：
机器读的模块清单（`khy.module.json` 的 `fanInEvidence`）、登记真源、规则登记脚本、
文档路径索引、测试断言、Python 启动器。

查法与改法：

```
node scripts/maintenance/path-integrity.js --scan-refs        # 只报告
node scripts/maintenance/path-integrity.js --scan-refs --json  # 机器可读
```

- 判据是**功能性用法**（路径被程序消费）+ 旧路径不存在 + 重映射后存在 → 报「真断」。
  注释、散文、迁移映射表里**刻意保留**的来源列不算缺陷。
- **不要自己写正则批量改**：路径 token 会出现子串误匹配（已正确的
  `runtime/substrate/platform/…` 里的 `platform/…` 被二次重映射）与引号风格被改写（JSON 失效）。
  正确做法是按扫描器给出的**精确 span**（`spanCol` + `span`）落刀，
  并在改后重新 JSON.parse 复核。
- **只改机器读的那一类**：模块清单（`khy.module.json`）、登记真源（`docs/10_规范/registry/*.json`）、
  机器生成的元数据（`works/record/ai/CONTEXT.yaml`）、多端入口真源（`entries/entries.json`）。
  **源码与测试一律不自动改** —— 实测全量落刀会改坏 3 个测试套件
  （`docPathIndex` / `evolutionPolicy` / `evolutionSafety` 回退后全绿 ⇒ 是自动改写引入的）：
  **测试里的旧路径常是「故意夹具」**（被测函数的输入/期望），机械改写会改变被测语义。
  仓库自己的设计也是「自动改写源码风险远高于收益，交给人裁决」。
- **两类永不得改**：锁文件（`package-lock.json` / `pnpm-lock.yaml`，生成物）与
  `docs/11_报告/历史/` 里的 stash 转储（里面的旧路径是**那一次转储的事实**，改了等于造假）。

> 2026-10-24 实测：873 处 → **401 处**（已安全修复 **472 处 / 49 份机器读配置**，
> 逐批跑相关测试套件确认零回归）。剩余 401 处的分布：
> 历史 stash 转储 104 + 生成锁文件 18 + **源码与测试 279**（路径敏感、被测试断言 → 需逐条人工裁决）。
> 同批还修掉了扫描器自身的重复报告缺陷（计数虚高 76%），记于 `works/record/ai/hq/BUGS.json` BUG-020。

### 4.4 「死代码」怎么认：写好了 ≠ 生效了

**症状**：某个修复的纯函数早就写好、单元测试全绿，但**生产代码里一处调用都没有** ——
功能根本没上线，而探针测试一直红着、被登记进 `tests-debt/DEBT.md` 当成「已知缺陷」躺着。

**2026-10-25 的实例**（BUG-022）：TUI 选区锚点漂移的修复，第一期（2026-09-23）已写好
`relocateLine` / `relocateSelection` / `extractTextRelocated` 并配了 17 条全绿的单测，
但 **App 层从未接线** —— 三个函数在生产里是**字面意义的死代码**，而端到端探针
`selectionAnchorDrift.test.js` 的 D-02 从 2026-09-23 一直红到 2026-10-25，**躺了一个月**。

**认出它的三条判据**：

| # | 判据 | 怎么查 |
|---|---|---|
| 1 | 导出但**无人调用** | `rg` 搜函数名在 `runtime/` 下的调用点 —— 只有定义与导出就是死代码 |
| 2 | 纯函数单测全绿，**端到端探针却红** | 两边对不上 ⇒ 中间缺接线（纯函数测的是「能力」，探针测的是「用起来」） |
| 3 | 修复被**分期**且中间态没有出口 | 「纯新增 + 未接线」是分期实施的天然中间态 —— 每一期都该有一张「本期是否真的接上了」的判据 |

**动线**：端到端探针（`tests/cli/tui/selectionAnchorDrift.test.js` 那种把多层串起来、
中途换掉输入的）比纯函数单测更早暴露接线缺失 —— 它红着时不要只当「已知缺陷」登记，
要问「**接线的判据在哪**」。

**接线期的验收必须包含「反向变异对照」**：改了判据（守卫/断言）之后，
把缺陷重新注入（改真源码 → 跑真测试 → 还原），确认它**真的变红**。
2026-10-25 改 `viewportDragEdgeScroll` 的 T6 时正是这一步救下了场 ——
第一版新判据漏抓「调用点挪到分支外」，变异对照当场把它顶出来，换掉才作数。

---

## 五、冲突时谁赢（文档真源优先级）

同一件事有**两处**写法时，按此顺序取信：

| 序 | 层级 | 例 | 为什么它赢 |
|---|---|---|---|
| 1 | **机器可读真源**（registry JSON） | `COPYRIGHT.json`、`DOMAIN-DEPS.json`、`RULES-REGISTRY.json` | 守卫直接消费它；散文只是它的说明 |
| 2 | **规范**（`10_规范/`） | `[DESIGN-LAY-005]`、`[DESIGN-IP-001]` | 判据与红线所在地 |
| 3 | **设计文档**（`03_DESIGN_设计/`） | `[DESIGN-ARCH-xxx]` | 决策与取舍的记录 |
| 4 | **索引**（`00_INDEX_*`） | 本文、`docs/00_INDEX_文档索引.md` | 导航层；索引写错不改变真源 |
| 5 | **实现报告 / 叙述性文档** | `04_IMPL_实现/`、`07_OPS_运维/` | 快照，可能过期 |
| 6 | **聊天结论 / 历史留档** | `18_归档/`、体检报告 | 只作追溯，不作依据 |

> ⚠ **第 5、6 级的数字会过期**。第 20 号守卫
> （`check-doc-numbers` / DOCS-007）专治「同名常量的值在文档里写错」，
> 报告这类漂移；`check-doc-drift`（DOCS-005）专治「文档声称的实现路径已不存在」。
> **两者都是 S1 观察者：只记录、不阻断** —— 但它们的读数是「文档正在腐烂」的指标。

---

## 六、维护义务

- 本文的事实若与 `DOMAIN-DEPS.json` / `RULES-REGISTRY.json` 冲突，**改本文**（它们是真源）。
- 域、守卫、索引轴有增删时，本文相应章节**必须同步** —— 本文的价值全在「不落后」。
- 本文的路由表新增一行时，同步补上该行对应的守卫入口确实存在（否则读者照着跑会报错）。

---

## 附：相关文档

- 根层物理盘点：[`docs/00_INDEX_仓库根.md`](../00_INDEX_仓库根.md)
- 域依赖真源：[`DOMAIN-DEPS.json`](../registry/DOMAIN-DEPS.json)
- 规则登记真源：[`RULES-REGISTRY.json`](../registry/RULES-REGISTRY.json)
- 文档结构规范：[`[DESIGN-DOC-001] 文档结构规范`]([DESIGN-DOC-001] 文档结构规范.md)
- 意图速查：[`docs/10_规范/00_INDEX_规范-总目录.md`](../00_INDEX_规范-总目录.md)
- 认知顺序读法：[`[DESIGN-ARCH-063] 对照《Claude Code 架构》一书读懂 Khy-OS`](../../03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-063] 对照《Claude Code 架构》一书读懂 Khy-OS.md)
- 架构缺口体检：[`[RESEARCH-026] 531目录架构设计与缺口重算`](../../11_报告/RESEARCH/[RESEARCH-026]%20531目录架构设计与缺口重算-2026-10-10.md)
