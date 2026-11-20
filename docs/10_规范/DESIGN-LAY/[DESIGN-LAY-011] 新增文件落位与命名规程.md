<!-- 文档分类: DESIGN-LAY-011 | 阶段: 设计 | 原路径: 新建 -->
<!-- IMPL-STATUS: active -->
> **标记依据**：操作规程随本批落盘；判定真源为 `[DESIGN-LAY-010]`，落点名册为 `[DESIGN-LAY-005]`。

# [DESIGN-LAY-011] 新增文件落位与命名规程

> **操作规程 · 「这个东西放哪、叫什么、谁来登记」的可执行判据** · 回答三个问题：① 新出现的文件/目录按什么顺序判定落点；② 每类对象该叫什么名；③ 老存量怎么迁进来而不制造第二份真相。
>
> **定位（防重叠，`[MGMT-STD-008]` §2.2）**：本篇只出**操作步骤**，不复制任何真源条文。层级名册 → `[DESIGN-LAY-005]`；层内可见性与语言轴 → `[DESIGN-LAY-002]`；整理与巡检 → `[DESIGN-LAY-003]`；数据三态 → `[DESIGN-LAY-007]`；数据 SSOT → `[DESIGN-LAY-009]`；判据（凭什么说这棵树是好的） → `[DESIGN-LAY-010]`。
>
> **效力**：本文是规程，无独立规则号（规则 12 棘轮：规则数只降不升）。检测由 `npm run check:hygiene`（S1 观察者，恒 exit 0）承担，见 §五。
>
> **谁该读**：任何要新增文件、新增目录、造临时物、迁移存量的人与 AI 智能体。

---

## 一、六问定坐标（决策树）

新东西出现时，**自上而下**逐问，**首个命中即停**：

```text
新出现的文件 / 目录
│
├─ ① 有人会「打开它读内容」？
│    ├─ 业务 / 设计 / 报告文档
│    │    → docs/NN_中文/  ·  文件名 [<STAGE>-<TYPE>-NNN] 中文名.md
│    │    → 双索引登记：该目录 00_INDEX_*.md + docs/00_INDEX_文档索引.md
│    └─ 软著 / 登记存证材料
│         → works/record/evidence/  ·  登记 docs/10_规范/registry/COPYRIGHT-MATERIALS.json
│
├─ ② 有人会「跑它复现结论」？
│    ├─ 可复跑的探针 / 扫描 / 诊断
│    │    → works/data/khy/T4-transient/tmp/<task>/
│    └─ 要长期保留的检查器（进 CI / 被门引用）
│         → scripts/ci/  ·  必须接线：npm run check:wiring 不得报零接线
│
├─ ③ 是某个任务的诊疗记录？
│    → works/data/khy/feedback/<task-id>/
│      （主诉 complaint.md / 复现 repro-before.txt / 差分 differential.md / 回滚 rollback.txt）
│
├─ ④ 是运行期产生的数据？
│    → works/data/khy/T<n>-<语义>/
│      先登记 docs/10_规范/registry/DATA-LOCATIONS.json，
│      再在 runtime/node/backend/src/utils/dataHome.js 的 DATA_PATHS 加逻辑名映射
│
├─ ⑤ 是代码？
│    → 按层落 runtime/ · apps/ · delivery/
│      命名随语言轴（[DESIGN-LAY-002] §4）：Node camelCase / Python snake_case / 横切 kebab-case
│
└─ ⑥ 以上皆否 → 一次性临时物
     → works/data/khy/T4-transient/tmp/<task>-<date>-<slug>.<ext>
     收工：删掉，或隔离进 .../tmp/housekeeping/<YYYY-MM-DD>/ 并留 manifest
```

**落地后须跑结构锁确认无 drift**：`npm run check:structure-lock`（S1 观察者，恒 exit 0）——根目录条目、docs 编号轴、数据档位凡快照外新增或快照内消失，即 finding；授权通道见 §五。

## 二、四桶落位（取代已废止的 `_产物/` 与 B8 禁区 `.khyos/`）

| 桶 | 判据 | 落点 |
|---|---|---|
| 交付物 | 有人会打开读 | `docs/NN_中文/`（编号 + 双索引）或 `works/record/evidence/` |
| 任务证据 | 为某次诊疗留证、要能复诊 | `works/data/khy/feedback/<task-id>/` |
| 过程态工具 | 有人会跑它复现结论 | `works/data/khy/T4-transient/tmp/<task>/`；长期检查器入 `scripts/ci/` |
| 一次性临时 + 隔离区 | 用完即弃 / 已淘汰待撤回 | `.../T4-transient/tmp/`；隔离进 `.../tmp/housekeeping/<YYYY-MM-DD>/` |

三条硬约束：

1. **`_产物/` 已于 2026-09-27 溶解，`.khyos/` 属 B8 禁区**——二者不得再作为落点。历史上指向它们的文档（`[DESIGN-LAY-002]` §3.1、`[DESIGN-LAY-003]` §3）已订正。
2. **四个桶都是磁盘上的真目录**：禁 `junction` / `symlink` / 硬链接。链接会让 `dir`/`tree` 看到的与磁盘真实的分离，视觉层开始说谎。
3. 临时物**不得**落在仓库根、`scripts/`、`docs/`、`runtime/` 等语义目录内。

## 三、命名语法总表

| 对象 | 语法 | 例 | 真源 |
|---|---|---|---|
| 顶层目录（章） | 小写单词，名册封闭、不随手新建 | `runtime` `delivery` `works` | `[DESIGN-LAY-005]` §一 / `check-repo-layout.js` `LAYERS` |
| 层内目录 | 随语言轴：Node `camelCase`、Python `snake_case`、横切 `kebab-case` | `desktopControl` / `check-repo-layout.js` | `[DESIGN-LAY-002]` §4 |
| 文档目录 | `NN_中文/`：`01`–`09` 生命周期阶段（冻结）、`10`–`19` 跨阶段资产（续编） | `10_规范` | `[DESIGN-LAY-005]` §3.1 |
| 文档文件 | `[<STAGE>-<TYPE>-NNN] 中文名.md`；`NNN` 由 AI 取**下一个未占用**号，删除的号不复用 | `[DESIGN-LAY-011] 新增文件落位与命名规程.md` | `[MGMT-STD-007]` R3 / §2.3 |
| 数据落点 | 先登记 `T0`–`T4` × 领域轴，再落目录；代码经 `getDataDir()` / `resolveDataPath()` 取址 | `T1-domains/sessions/conversations` | `DATA-LOCATIONS.json` / `dataHome.js` |
| 过程 / 临时 / 隔离 | `<task>-<date>-<slug>`；隔离区 `<YYYY-MM-DD>/` + `manifest.json` | `verify-218-20261116.js` | 本规程 |
| 扩展名 | 随层：`.c/.asm`→L0，`.py`→L1/L4，`.js`→L2，`.ts/.vue`→L3，`.md/.html` 成对 | — | `[DESIGN-LAY-002]` §5 |

## 四、存量迁移流程（老东西怎么改）

每批同构，五步：

```text
清点 → 四桶分类 → 写 manifest(+sha256, 可撤回) → 分批迁移 → 守卫对账
                                                      │
                                        计数下降 → 进下一批
                                        计数上升 → 立即 restore 撤回
```

- **分批口径**：目录算 1 件；散件 ≤10 件/批，多轮执行。
- **只隔离不删除**（`[DESIGN-LAY-003]` HK-3）：淘汰进 `.../tmp/housekeeping/<日期>/`，凭 manifest 原路撤回。
- **零触碰**：`git ls-files` 跟踪的文件不动（HK-1）；运行期数据只读（HK-2）。
- **不覆盖**：目标同名加 `_1` 后缀（HK-8）。
- 每批结束跑 `node scripts/ci/check-repo-layout.js`，把 `root-junk` / `root-shadow-dir` / `layer-registry` / `root-uncatalogued` 的前后计数记进批次报告。

## 五、检测与守卫

| 层 | 机制 | 行为 |
|---|---|---|
| 硬闸 | `node scripts/ci/check-repo-layout.js` | 根级杂物 / 影子数据家 / 未登记顶层目录 → error |
| 观察者 | `npm run check:hygiene`（`scripts/ci/check-litter.js`，Node 版 S1） | 全树 `.tmp-*`、碎片名、junction、根白名单外条目 → findings，**恒 exit 0**（S1，`PROCESS-008`） |
| 结构锁 | `npm run check:structure-lock`（S1） | 对照 `docs/10_规范/registry/STRUCTURE-LOCK.json` 的快照，新增/删除已登记条目 → drift finding；授权 = 更新快照 version+1 + 提交信息 `structure-lock-approved-by: <批准人>` |
| 巡检 | `python scripts/maintenance/organize.py --report`（仅在有 Python 的机器） | 每日巡检；L2 隔离需人工确认 |

> 2026-11-19：观察者由 `organize.py --check` 迁移到 Node 版 `scripts/ci/check-litter.js`——本机无可用 Python 解释器（Microsoft Store 残桩 `exit 9009`），python 系检查不可运行；`organize.py` 保留为 LAYOUT-004 巡检执行器。两版共处期以 npm 脚本 `check:hygiene` 为唯一入口。

**任何智能体在收工前必须跑一次硬闸与观察者**，见 `AGENTS.md` §智能体卫生契约。

---

## 附录一：禁物清单

- `junction` / `symlink` / 硬链接（2026-11-18 用户裁决：不再使用，视觉真实优先）
- 碎片名文件：引号、括号、分号事故（如 `NUL`、`'`、`0)out.push(m[1])`、`{const`）
- Windows 保留设备名：`NUL` `CON` `PRN` `AUX` `COM1`–`COM9` `LPT1`–`LPT9`
- 根目录白名单外的新文件（真源 `[MGMT-STD-001]` §1.3 + `check-repo-layout.js`）
- 在仓库根或任意子目录造 `.khy` / `.khyos` / `.khy-runtime`
- `.tmp-*` / `*.tmp-*` 出现在 `works/data/khy/T4-transient/` 之外
- 未接线的检查器放进 `scripts/ci/`（`check:wiring` 判零接线）

## 附录二：工具家点目录的允许项

`.claude` `.cursor` `.zcode` `.opencode` `.workbuddy` `.workbuddy-ai` `.codeartsdoer` `.mavis` `.qoder` `.ai` 属于**工具硬编码路径**，允许存在，但三条必须同时成立：

1. 必须是磁盘上的**真目录**——不得用 junction 伪装（2026-11-18 已拆 6 个垫片）；
2. 必须在 `.gitignore` 内，属本机态，不入库；
3. 真数据住 `works/data/<tool>/`，**不得在其中存放项目交付物**（交付物按 §一 落 `docs/` 或 `works/record/`）。

## 附：与既有规范的关系

| 问题 | 去哪 |
|---|---|
| 有哪些层、每层担什么责 | `[DESIGN-LAY-005]` |
| 层内怎么分、谁能看见谁、语言轴命名 | `[DESIGN-LAY-002]` |
| 已乱的存量怎么回收 | `[DESIGN-LAY-003]` |
| 数据三态与寻址 | `[DESIGN-LAY-007]` |
| 同一份数据只写一遍 | `[DESIGN-LAY-009]` |
| 凭什么说这棵树是好的（判据） | `[DESIGN-LAY-010]` |
| **新东西放哪、叫什么、怎么迁** | **本篇** |
