# [DESIGN-ARCH-142] 用户数据安全更新与可选更新机制

> **状态**：提案（未实施）
> **范围**：`services/backend/src/services/updateCoordinator.js`、`services/backend/src/bootstrap/migrations.js`、`services/backend/src/cli/routerDispatchOps.js`
> **上游依赖**：无外部依赖
> **调研指针**：本文件 §1 现状实证（全部 file:line 实测，2026-09-23）
> **模板合规**：照 `[DESIGN-ARCH-124]` 体例

---

## 0. 一句话结论

**程序侧的更新管线已经闭环**——检查、暂存、安装、回滚、「现在安装 / 稍后 / 跳过此版本」的用户三选全部存在且接线。真正的缺口在**数据侧**：迁移直接改用户数据（`~/.khy`），但**迁移前没有数据快照、迁移失败只回滚程序不回滚数据、老程序遇到新数据没有降级守卫**。这三条不补，「更新不破坏用户数据」就只是一句碰运气的承诺。

### 病灶表格

| # | 病灶 | 证据 | 后果 |
|---|------|------|------|
| 1 | 迁移前无数据快照 | `applyUpdate`（updateCoordinator.js:740）→ `runPostApplyChecks`（:703）→ `runMigrations` 直接改 `~/.khy`；回滚只装回旧版 pip/npm 包（`rollbackPackage` :717-738） | 迁移改坏数据后，程序能回滚，**数据回不去** |
| 2 | 迁移可半途而废且不可逆 | `runMigrations`（migrations.js:133-179）逐条 try/catch 失败仅记日志；成功条目照常写入版本文件（:154-160） | 数据停留**半迁移态**；程序回滚后老版本读到新版本号，跳过后续迁移，半迁移态**永久化** |
| 3 | 无降级守卫 | 用户手动 `pip install khy-os==旧版` 后，老程序对 `bootstrap_version.json` 高于自己内置迁移列表**毫无感知**，静默读写 | 手动降级 = 用旧代码写新格式数据，腐化无声发生 |
| 4 | 「永不更新」只有环境变量 | 总开关是 `KHY_SELF_UPDATE`（updateCoordinator.js:31-33），无用户可见的持久化开关 | 普通用户没有不碰环境变量的关闭方式 |

---

## 1. 现状实证（先承认已经做对的，别重复造轮子）

### 1.1 更新管线（已存在，勿重做）

| 能力 | 位置 | 说明 |
|------|------|------|
| CLI 五动作 `check/stage/apply/status/skip` | `services/backend/src/cli/routerDispatchOps.js:186` → `handleUnifiedUpdateCommand` | `khy update <action>` |
| 交互三选：现在安装 / 稍后 / 跳过此版本 | routerDispatchOps.js:142-152（`uiPrompt.promptCompat`） | **「用户可以选择不更新」已经存在** |
| 跳过版本持久化 | updateCoordinator.js:814-818（`skipUpdate` 写 `skippedTarget`）；check 时尊重 :616 | 只跳当前目标版本，下个新版本会重新提示（合理：安全修复不应被永久屏蔽） |
| 启动后台检查 | `services/backend/src/bootstrap/prefetch.js:298-299` | 只 check 不 apply；开关 `KHY_SELF_UPDATE`（updateCoordinator.js:31-33），默认开 |
| 状态机 | updateCoordinator.js:14-23 | `idle→checking→available→staged→blocked→applying→applied/failed` |
| 三种安装形态 | updateCoordinator.js:657-696 | git（ff-only 合并）/ package（pip+npm）/ portable（目录换装） |
| 安装后检查失败自动回滚程序 | updateCoordinator.js:786-799 | git `reset --hard` / restorePortable / pip `--force-reinstall` 旧版 |
| portable 跨重启延迟回滚 | updateCoordinator.js:446-486、:428（`schedulePortableRollback`） | 重启后确认回滚结果并做完整性校验 |

### 1.2 数据侧（缺口的所在）

| 事实 | 位置 |
|------|------|
| 迁移直接改用户数据（如 1.0.1 删 7 天前缓存文件） | migrations.js:54-79 |
| 逐条 try/catch，失败不阻断、不回滚已成功的条目 | migrations.js:150-173 |
| 版本状态存 `~/.khyquant/bootstrap_version.json` | migrations.js:105-108 |
| 备份目录 `getDataDir('backups')` 已建（1.0.0 迁移），但更新路径**从不往里写快照** | migrations.js:48-51 vs updateCoordinator.js 全文无 backups 引用 |
| 数据家红线：解析器只选目录不搬数据，活体迁移走显式 `khy storage migrate` | `services/backend/src/utils/dataHome.js:27-29` |

---

## 2. 借鉴提案（B-P2 七字段）

**不适用。** 本提案修复的是本仓自身更新链路的数据保护缺口，所有落点均为既有文件扩展（§6 判据 a、b 均满足：落点已存在；已搜索 `migrat|schemaVersion|dataVersion` 于 `services/backend/src` 并确认无并行实现）。未借鉴任何外部项目代码或结构，无许可证问题。

---

## 3. 目标形态

### 3.1 更新数据安全三层防线（P1+P2 落地后）

```
 khy update apply
   │
   ▼
 ┌─────────────────────────────────────────────────────┐
 │ 第 0 步（新增）：数据快照                             │
 │   把「本次迁移声明会触碰的文件」复制到                │
 │   backups/pre-update-<目标版本>-<时间戳>/            │
 │   + 写 manifest.json（文件清单+哈希，供恢复校验）     │
 └──────────────────┬──────────────────────────────────┘
                    ▼
   安装新程序（现有逻辑，git/package/portable 三适配）
                    ▼
   runPostApplyChecks → runMigrations（现有逻辑）
                    │
        ┌───────────┴───────────┐
        ▼ 成功                   ▼ 失败（skipped 非空）
   清理快照（保留 3 份）    ┌─────────────────────────────┐
   pendingRestart=true     │ 第 1 步（新增）：先恢复数据快照 │
                           │ 第 2 步（现有）：再回滚程序     │
                           │ 顺序不可颠倒（见 §6 反模式 1） │
                           └─────────────────────────────┘
```

### 3.2 迁移声明 `touches`（P1 的前置纪律）

每条 MIGRATIONS 新增可选字段 `touches: ['<相对数据家的路径或目录>']`：

- 快照只复制 `touches` 声明的文件——不整目录复制（用户数据家可达数百 MB，见 §6 反模式 2）。
- **未声明 `touches` 且 `up` 内有文件写操作的迁移，检查器判 error**（新检查器 `check-migration-touches.js`，接线到 PR 门档）。
- 存量 4 条迁移补声明：1.0.0（建目录，无写文件，可空）、1.0.1（`cache/`）、1.1.0/1.2.0（no-op，空）。

### 3.3 降级守卫（P2）

启动时（`runMigrations` 入口处）比较 `bootstrap_version.json` 的版本与程序内置 `MIGRATIONS` 最高版本：

- 数据版本 **≤** 程序版本：正常路径（现状行为，零改动）。
- 数据版本 **>** 程序版本：用户在手动降级。默认**拒绝运行迁移并打警告**「数据来自更新版本 X.Y.Z，当前程序 W.V.U；继续运行可能损坏数据」。迁移本身照旧跳过（无 pending），但警告必须发出且写入日志——第一期不阻断启动（阻断会让回滚流程自锁），后续视事故率再收紧。

### 3.4 用户选择权补全（P3）

| 需求 | 现状 | 补全 |
|------|------|------|
| 跳过当前版本 | ✓ 已有（`skip`，:814） | 不动 |
| 本次稍后 | ✓ 已有（staged 保留，`khy update apply` 随时可装） | 不动 |
| 永不自动检查 | ⚠ 只有 `KHY_SELF_UPDATE` 环境变量（:31-33） | 新增 `khy update off/on`：把 `autoCheck: false` 写进既有 state 文件（updateCoordinator.js:48 `getStateFile`），prefetch.js:298 检查前先读它。**不加新 env**（见 §6 反模式 4） |

---

## 4. 实施分期（每期独立可回滚）

| 期 | 内容 | 落点 | 回滚方式 |
|----|------|------|----------|
| P1a | MIGRATIONS 条目补 `touches` 字段 + `check-migration-touches.js` 检查器接线 PR 门 | migrations.js、scripts/ci/ | 撤检查器接线一个文件 |
| P1b | `applyUpdate` 第 0 步快照 + 失败路径「先复数据、再回程序」 | updateCoordinator.js | 可选参数 `opts.snapshot` 缺省时保持现行为（逐字节），调用方一处接线 |
| P2 | `runMigrations` 入口降级守卫警告 | migrations.js | 删守卫块即回到现状 |
| P3 | `khy update off/on` + prefetch 尊重 | updateCoordinator.js、prefetch.js、routerDispatchOps.js | 撤 CLI 分支与 prefetch 一处判断 |

依赖关系：P1b 依赖 P1a（没 touches 清单就没有快照范围）；P2、P3 与 P1 相互独立。

**CI 纪律**（照 skill 实测结论）：新测试文件一律 `require('node:test')` 写，放 `services/backend/tests/**` 下落地即须绿——`deploy-staging.yml` 的 `test:node` 通配符会扫到它们（该文件 :97-104，实测 1288 个文件全量展开）。改 `updateCoordinator` 相关既有 jest 风格测试时**只追加断言值更新，不重写 runner 风格**（一文件双 runner 会双双扫到）。

---

## 5. 诚实边界（刻意不纳入）

| 不做 | 原因 |
|------|------|
| 双向迁移（up/down） | 单向迁移 + 快照恢复比双向迁移可靠一个数量级：down 脚本本身就是新代码，同样可能有 bug，还让每条迁移的维护成本翻倍。恢复的是**迁移前快照**，正确性不依赖任何新代码 |
| 整个数据家的全量快照 | `~/.khy` 含缓存、会话历史等，体量不可控；且 `dataHome.js:27-29` 红线明确「解析器绝不搬数据」。快照范围必须由 `touches` 声明并经检查器守卫 |
| 自动安装（静默 apply） | `prefetch.js` 现在只 check 不 apply——这是对的。自动安装等于剥夺用户选择权，与「用户也可以选择不更新」直接冲突 |
| 阻断式降级守卫 | 第一期只警告不阻断：阻断会让「更新失败 → 自动回滚程序」这条自救链路自锁（回滚后的程序必然版本更低） |
| 数据 schema 独立版本号体系 | `bootstrap_version.json` 已是事实上的数据 schema 版本（migrations.js:105-108）。再立一个版本号就是第二真源，违反本仓「不新建并行真源」红线 |

---

## 6. 反模式（这条路别走）

| ✗ 别做 | 为什么 |
|--------|--------|
| 回滚时先装旧程序、后（或根本不）恢复数据 | 旧程序读到已被新迁移改过的数据 + 偏新的版本号 → 跳过补迁移，半迁移态永久化。**顺序必须：先复数据快照，再回滚程序**——因为恢复快照后版本文件也回到旧值，旧程序才能正确地重新走迁移 |
| 快照整个 `~/.khy` 目录 | 体量不可控（缓存/会话历史），拖慢 apply 数秒到数分钟，且违反数据家红线精神。只快照 `touches` 声明的文件 |
| 给「更新提示」加新环境变量开关 | `KHY_SELF_UPDATE` 已是总开关，再加一个就是第二真源；用户可见偏好应持久化到 state 文件（`khy update off`），env 只留给 CI/自动化场景 |
| 在 `runMigrations` 的 try/catch 里加「失败时自动恢复快照」 | 迁移层不知道快照存在（分层职责）；恢复是 `applyUpdate` 失败路径的职责。迁移层自己恢复会在「非更新场景的日常启动」里误触发 |
| 用 `pip --force-reinstall` 当数据回滚手段 | `rollbackPackage`（:717-738）只管程序包。它已有的职责不动，数据恢复必须走快照 |

---

## 7. 验收方式

```bash
# P1a：迁移 touches 检查器
node scripts/ci/check-migration-touches.js   # 存量 4 条补声明后 0 error

# P1b：快照与回滚顺序（node:test，落地即绿）
node --test services/backend/tests/update/dataSnapshot.test.js
# 断言：① apply 失败路径先调 restoreSnapshot 再调 rollbackPackage（调用顺序桩）
#       ② 快照内容与 touches 清单一致（哈希比对）
#       ③ opts.snapshot 缺省时 updateCoordinator 行为与改动前逐字节一致

# P2：降级守卫
node --test services/backend/tests/update/downgradeGuard.test.js
# 断言：bootstrap_version 高于内置最高版时发警告且不阻断；低于时零输出

# P3：off/on
node --test services/backend/tests/update/autoCheckToggle.test.js
# 断言：off 后 readState().autoCheck===false；prefetch 的 checkUpdate 收到跳过；on 恢复

# 既有回归基线（改动前后各跑一遍，数字必须一致）
node --test services/backend/tests/update/   # 以跑出的 # tests/# pass 为基线尺，见 §8
```

关联门禁：`npm run check:layout`（新增 tests 子目录）、`npm run rules:gate:commit`、`npm run check:changed`。

---

## 8. 待核实项

| # | 事项 | 状态 |
|---|------|------|
| 1 | `services/backend/tests/update/` 是否已存在、既有更新相关测试的基线数字 | **未核实**——落 P1b 前必须先跑一遍取基线（skill 纪律：基线数字必须实测，不许估） |
| 2 | packageAdapter / portableAdapter 是否有独立于 updateCoordinator 的数据写路径 | 抽查未见，未逐行确认；P1b 实施时须确认快照覆盖两个 adapter 的 postApply 路径 |
| 3 | `khy update off` 的 state 字段与 `sanitizeState`（:80）白名单是否兼容 | P3 实施时确认，若白名单需要加字段属于同文件小改 |

## 9. 变更日志

- 2026-09-23：初版提案。实证基于当日源码（updateCoordinator.js 1089 行全量结构扫描 + 关键段精读、migrations.js 全文、routerDispatchOps.js 更新分支、prefetch.js 调用点）。
