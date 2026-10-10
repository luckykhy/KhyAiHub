> 状态：提案（**A 层四件最小改动已逐条给出 file:line，未实施**；B 层防复发零新增规则 ID / 零新增门控）｜范围：① `cli/tui/` 的**子进程 fd 出口**、② `utils/dataHome.js` 的**目录创建收口**、③ `cleanupService` ↔ `clean` 的**清理目标真源**、④ `bootstrap/prefetch.js` 的**轻量入口裁剪面**｜上游依赖：`[DESIGN-ARCH-156]` §1.5/§7/§8、`[DESIGN-ARCH-102]` §3 H7、`tui/AGENTS.md` §0.9.7 单写者原则、`[DESIGN-LAY-002]` §3.1、`[DESIGN-LAY-003]` HK-3｜调研指针：本文 §1、`.khyos/diag/2026-09-29-storage-notice-and-tui-leak-diagnosis.md`｜模板合规：B-P2 七字段据实声明见 §2.1

# [DESIGN-ARCH-166] 静默失效与真源漂移四例收敛方案 —— 出口逃逸·幽灵目录·提示虚高·裁剪漏挂

## 0. 一句话结论

2026-09-29 的一次截图诊断（`.khy` 体积提示 + 半行 `WARNING: Package(s) not found: khy-os`）挖出**四条彼此独立、却同属两个病因的缺陷**：

- **病因 A —— 能力/输出绕过了既有契约**（「代码全在、判据全绿、在某个入口上从不生效」）：
  - ① 子进程 **fd 2 继承**绕过了 `consoleMute` 的 TUI 会话静音，是 `[DESIGN-ARCH-156]` §1.5 写者清单里**漏掉的第 4 类写者**；
  - ④ `trimQuarantine()` **已存在、已导出、参数正确**，但只挂在 `khyquant` 模式的 `runCleanup` 上 —— `khy` 入口从不调它。
- **病因 B —— 同一件事有两份语义输入，只对齐了一半**：
  - ③ `assessRuntimeFootprint` 抄了 `RUNTIME_TARGETS` 的 `rel` 列表，**漏抄 `RUNTIME_KEEP_PREFIXES`** ⇒ 提示报「可回收 187 MB」，实际只有 **55.4 MB**。
- **第三族 —— `catch {}` 把可诊断的失败变成不可诊断**：
  - ② 4 个名为 `*.json` 的**空目录**顶掉了同名文件，写入 **EISDIR** 被 `catch` 吞掉 ⇒ skills 缓存与工具权限静默不落盘。

四条修法的共同约束：**规则棘轮 94/94 已满**（新增一条须先退役一条）、**TUI 门控实测 236 > `MAX_GATES` 227 已超限**（零余量）。因此本方案**不新增规则 ID、不新增 `KHY_*` 门控**，全部落在既有机制上。

| # | 缺陷 | 判据锚点 | 修法规模 |
|---|---|---|---|
| ① | pip stderr 打穿 TUI | `khySelfUpdateService.js:231` 缺 `stdio` | A1 = **1 行**；A2 = 新增 1 叶子 + 1 接线点 |
| ② | 4 个 JSON 存储 EISDIR 静默失效 | `dataHome.js:346-350` + `:506-516` | A3 = 2 个函数加 fail-fast；现场清理需点名 |
| ③ | 「可回收」虚高 3.4× | `cleanupService.js:460` 漏 `RUNTIME_KEEP_PREFIXES` | A4 = 抽 1 叶子 + 2 处消费 |
| ④ | `interaction_quarantine.jsonl` 547.8 MB 无界增长 | `prefetch.js:188-203` 少 2 行调用 | A5 = **2 行**；**A5' = 修 `trimQuarantine` 的读取路径（见 §5-A5，2026-09-29 执行时发现 A5 单靠接线是 no-op）** |

---

## 1. 现状实证（file:line 可复核）

### 1.1 ① 子进程 fd 出口 —— 单写者名单里漏掉的一类

**症状**（截图）：`WARNING: Package(s) not found: khy-os` 落在**输入框与状态栏下方**，不在 TUI 的受管区域内。

**根因**：`services/backend/src/services/khySelfUpdateService.js:229-237`

```js
function _readInstalledVersion(execImpl, pkgName) {
  const info = execImpl(`${_pipCmd()} show ${pkgName}`, { encoding: 'utf-8', timeout: 5000 });
  //                                                        ^^^^^^^^ 未指定 stdio
```

**Node 的行为（实测，两条对照）**：

| 调用形态 | 子进程 stderr 去向 |
|---|---|
| `execSync(cmd, {encoding, timeout})`（无 `stdio`） | **转发到父进程 stderr** ⇒ 落在终端上 |
| `execSync(cmd, {stdio:['pipe','pipe','pipe']})` | 被 pipe 捕获，**不出现**在终端 |

**触发链**（全部为启动路径，非用户命令）：

```
bootstrap/prefetch.js:296-313   versionUpdateNotice（+5s 后台 runner）
  └─ services/updateCoordinator.js:435 checkUpdate
       └─ services/updateCoordinator.js:371-377 checkPackage
            └─ khySelfUpdateService.js:173 checkUpdate
                 └─ :239 _detectInstalledPackage   ← 逐个试候选表
                      └─ :231 _readInstalledVersion ← 裸 execSync，stderr 泄漏
```

**为什么本机必然命中**：`versionService.js:28 PACKAGE_CANDIDATES = ['khy-os', 'khy-quant']`，而本机是源码树运行：

```
$ pip show khy-os      → WARNING: Package(s) not found: khy-os   ← 与截图逐字节一致
$ pip show khy-quant   → Name: khy-quant / Version: 0.1.78        ← 命中，故只出现一条告警
```

「只出现**一条**」这一点反证了泄漏源是 `_detectInstalledPackage` 的**第一轮**循环。

**同族既有机制（本方案要复用的）**：`services/backend/src/cli/tui/consoleMute.js:1-21` 的注释把失败模式写成了「英文内部日志**压在状态栏下面**、重绘后还残留」，并登记为 BUG-13 家族（含 BUG-17 watchdog、BUG-29 陈旧行）。接线在 `cli/tui/app.js:316-332`，逃生阀 `KHY_TUI_CONSOLE_LOG`（`consoleMute.js:36`）。

> **它治的是 winston 的 `console._stdout/_stderr.write`；本方案的 ① 治的是「子进程继承数字 fd 2」——同族、不同逃逸路径。**

**`[DESIGN-ARCH-156]` §1.5 的写者清单**（① ink stdout Proxy、② 带外看板、③ 主题条 OSC/启动锚点/DECSET 裸写）**不含子进程 fd 继承**；其 §8 已预告「名单继续有效，但新增绕过者的判定标准变成『是否走了 `frameWriter`』」。⇒ ① 是本方案要补登记的第 4 类。

**门控预算实测**：`node scripts/ci/check-tui-gates.js` → `FAIL — 236 unique KHY_* tokens (limit 227)`。⇒ ① 的防复发**不得新增 token**。

### 1.2 ② 幽灵 `*.json` 目录 —— 4 个存储写入 EISDIR

`.khy/` 顶层存在 4 个**名字以 `.json` 结尾的空目录**（创建时间 Sep 25 14:47）：

```
ai_gateway_customer_usage.json/    ai_gateway_pricing.json/
skills_cache.json/                 tool_permissions.json/
```

**写入实测（4/4 失败）**：

```
WRITE-FAIL tool_permissions.json           -> EISDIR: illegal operation on a directory
WRITE-FAIL skills_cache.json               -> EISDIR: illegal operation on a directory
WRITE-FAIL ai_gateway_pricing.json         -> EISDIR: illegal operation on a directory
WRITE-FAIL ai_gateway_customer_usage.json  -> EISDIR: illegal operation on a directory
```

**根因**：`services/backend/src/utils/dataHome.js:346-350`

```js
function getDataDir(...segments) {
  const dir = path.join(getDataHome(), ...segments);
  _ensureDir(dir);          // ← 对「拼接后的完整路径」无条件 mkdir
  return dir;
}
```

配套 `_ensureDir`（`:506-516`）把错误也吞了：`catch { /* ignore */ }`。`getAppDataDir`（`:600-602`）同构。

⇒ 任何 `getDataDir('xxx.json')` 这类**调用方误用**都会造出一个同名空目录，且**不报错**。

**仓库已知但未修**：`services/backend/src/services/domain/backup/backup/backupAssetPlan.js:237-251` 注释原文：

> 幽灵 `*.json` 目录:既存 bug 的产物,不是状态。……**根因在调用方误用,应另开任务修**；备份侧只需认出它们不是状态。

备份侧只做了剪枝（`isPhantomJsonDir:249-251` → `classifyDir:264-266` prune），**根因仍在**。

**静默失效的两个实证点**：

- `services/skillRegistry.js:145-161` `saveCache()` 的 `writeFileSync` 落在 `catch { /* ignore */ }` 里 ⇒ skills 缓存**永远写不进**；`loadCache:126-138` 同样静默（`existsSync` 对目录返回 true → `readFileSync` 抛 EISDIR → 被吞）。
- `services/tool/toolCallingBuiltins.js:52` `PERMISSIONS_FILE = path.join(_appHome(), 'tool_permissions.json')` ⇒ 工具权限**无法持久化**。

**★ 影响面实测（决定修法强度）**：全仓 `get(Data|AppData)Dir('<含扩展名的段>')` 只有 **2 处命中，且都是「警告不要这么写」的注释**（`backupAssetPlan.js:241`、`tipHistoryStore.js:28`）——**没有任何活跃误用调用点**。⇒ 加 fail-fast 的**爆炸半径 = 0**，这是本方案里风险最低的一处改动。

**附带发现**：另有 `api_keys.json.stale-dir-20260828/`、`custom_providers.json.stale-dir-20260828/` 两个空目录；对应的 `api_keys.json` / `custom_providers.json` 已是正常文件（说明曾被人工恢复）。`stale-dir-` 这个命名**全仓无代码生产者**——只有 `docs/10_规范/registry/DATA-LOCATIONS.json:103` 把它登记为机器树模式（`"machineTreePatterns"` 里的 `"\\.stale-dir-"`）。生成它那一步不在仓里，见 §12-Q4。

### 1.3 ③ 「可回收 187 MB」虚高 3.4 倍 —— 真源只对齐一半

**提示来源**：`services/backend/src/services/cleanupService.js:455-507` `assessRuntimeFootprint`，其 `:460`：

```js
const RECLAIMABLE = ['logs', 'audit', 'tmp', 'cache', 'break-cache', 'change-watch'];
```

按**整目录体积**累加（`:464-478`）。

**真实口径（实测，直接调 `buildCleanPlan`）**：

```
totalBytes = 58096106 = 55.4 MB
    28.3 MB  .khy/audit          10.8 MB  .khy/logs        10.8 MB  .khy/tmp
     4.9 MB  .khy/change-watch    0.7 MB  .khy/cache        0.0 MB  .khy/break-cache
held:
   131.7 MB  .khy/tmp/{quarantine-20260915}   [HK-3：只隔离不删除 —— 本命令按前缀保留，不清理]
   106.6 MB  .khy/checkpoints                 [工作区快照，--runtime 不清]
```

⇒ 187.1 − 55.4 = **131.7 MB**，正好等于被保留的 `tmp/quarantine-20260915`。

**这个不变量在两处被明文写死，却被违反**：

| 位置 | 原文 |
|---|---|
| `cleanupService.js:457-459`（就在出问题的 `RECLAIMABLE` 上方） | 「提示里报的「可回收」必须与那条命令实际会删的一致,否则用户跑完发现回收数字对不上,下一次就不信这个提示了。」 |
| `cli/handlers/clean.js:476-477`（`push` 内） | 「预报告的数字必须等于实际会删的量，否则用户跑完发现对不上，下次就不信了。」 |

而 `clean.js` 侧**确实做到了**：`:466-493` 的 `bytes: Math.max(0, stats.bytes - keptBytes)`，保留前缀来自 `:183 RUNTIME_KEEP_PREFIXES = { tmp: ['quarantine'] }`，`:548` 传入。**只有 `assessRuntimeFootprint` 没做。**

**★ 修法的分层约束（这一步决定了落点，别踩）**：`cleanupService.js` 在 `services/`，`clean.js` 在 `cli/handlers/`。`services/backend/scripts/archDebtScan.js:12,239-256` 的 **R1 分层倒置**明文规定：

> R1 分层倒置（Layering inversion）：`src/services/**` 反向 require `src/cli/**`。

⇒ **不能**用「让 `cleanupService` require `clean.js`」这种最直觉的写法——它会当场把 `check:arch-debt` 变红。真源必须**下沉到两侧都能消费的叶子**。

**叶子落点可行性**：`services/backend/src/constants/` 现有 31 个文件（`retryBudget.js` / `serviceDefaults.js` / `riskOrder.js` …），**无同类件**；R1 只拦 `cli/`，`constants/` 不在拦截面内；`clean.js:34` 已有 `require('../../utils/dataHome')` 这类跨目录先例。

**★ 架构上它就是指定层（不是「恰好可行」）**：`docs/10_规范/registry/DOMAIN-DEPS.json` 把 `constants/` 与 `utils/` 同列为 **D3「共享底座」**，其原文定义是「被大量复用的策略与设施：**只被依赖，不反向依赖**」，`roots` 显式含 `services/backend/src/constants`，`mayDependOn` 仅 `["D3"]`，`evidence` 举的例子正是 `utils/dataHome.js`（入度 323）与 `constants/serviceDefaults.js`。⇒ ③ 的真源下沉到 `constants/` 是**走 D3 的既有职责**，且叶子**零 require** 天然满足 `d3-purity`（`check-repo-layout` 的 37 处告警全与本方案无关）。判据真源 `[RESEARCH-018]` §4 C-5/C-7。

### 1.4 ④ `interaction_quarantine.jsonl` 547.8 MB —— 裁剪能力绕过轻量入口

**实测 `.khy/training`（合计 550.1 MB）**：

| 文件 | 体积 | 自身上限 | 超限 |
|---|---|---|---|
| `interaction_quarantine.jsonl` | **547.8 MB** | `QUARANTINE_MAX_BYTES = 20 MB`（`:85`） | **27.4×** |
| `interaction_records.jsonl` | 2.3 MB / 799 行 | `TRAINING_MAX_BYTES = 50 MB` / `TRAINING_MAX_LINES = 10_000`（`:58-59`） | 未超 |

⇒ **真凶是 quarantine，不是 records**（首轮判断被实测推翻，如实记录）。

**裁剪函数存在、已导出、参数正确**：

- `trimQuarantine()` `cleanupService.js:881`，**已在 `:2055` 导出**；`trimTrainingData` `:2049` 也已导出。
- 调用点**只有** `runCleanup` 内部：`:1714`（training-data）、`:1720`（training-quarantine）。

**而 `runCleanup` 只挂在完整模式**：`serviceLifecyclePolicy.js:69` 的 `cleanupService` 条目 mode 为 `khyquant`。

**轻量入口的裁剪面**：`bootstrap/prefetch.js:188-203`

```js
runtimeFootprintNotice: () => {
  cleanup.cleanRuntimeLogs();     // ← 只有这两个
  cleanup.cleanTraceAudit();
  emitFootprintNotice(cleanup);
},
```

`serviceLifecyclePolicy.js:225` 的 note 自陈这条正是为补缺口而加：

> 轻量模式 +3.5s 滚动 `.khy/logs` 与 `.khy/audit` 一次并做体积自检……完整模式由 `cleanupService` 条目一并覆盖,**这里只补 khy 模式那条缺口**

⇒ **当时补的是 logs + audit，漏了 training/quarantine。** ④ 是**同一次补口的遗漏**，不是新机制。

**并且 `khy clean` 也救不了它**：`cli/handlers/clean.js` 全文件不含 `training`；四个档位 `BUILD_TARGETS:62` / `RUNTIME_TARGETS:158` / `TOOLS_TARGETS:156` / `_discoverDeps:528` 均不覆盖。⇒ 提示给出的唯一动作即便跑完，`.khy` 仍有 **925.5 MB**，是阈值 500 MB 的 **1.85 倍**，用户照做后还会看到同一条提示。

---

## 2. 契约可行性实证

### 2.1 B-P2 七字段声明

| # | 字段 | 声明 |
|---|---|---|
| 1 | 借鉴对象 | 不适用 —— 零外部引入 |
| 2 | 借鉴内容 | 不适用。沿用的**本仓既有**模式三处：`consoleMute.js:14-16`「只动音量、不动记录 + 逃生阀」、`prefetch.js:151-163`「完整/轻量共用一份提示发射」、`backupAssetPlan.js:249-251`「按名识别幽灵目录」 |
| 3 | 解决的问题 | §1.1–§1.4 四项，均附 file:line 与实测数字 |
| 4 | 许可证与代码性质 | 不适用 —— 不引入上游代码，**不 fork / 不 patch ink**（承 `[DESIGN-ARCH-156]` §7） |
| 5 | 借鉴方式 | 不适用 |
| 6 | 落点与现有实现对比 | 见 §2.2 对照表。新落点 `src/constants/runtimeCleanTargets.js` 已搜 `runtimeCleanTargets\|cleanTargets` 零命中；`dataHome.getDataFile` 已搜零命中 |
| 7 | 与既有约束的冲突 | **两处，均已在设计内规避**：① R1 分层倒置 ⇒ 真源下沉到 `constants/`（§1.3）；② TUI 门控棘轮已超限 ⇒ ① 的防复发**复用既有 `KHY_TUI_CONSOLE_LOG`**，零新 token（§6） |

### 2.2 逐字段对照表（初稿写的 → 真源实况 → 处置）

| 初稿写法 | 真源实况 | 处置 |
|---|---|---|
| `RUNTIME_TARGETS` 是字符串数组 | `clean.js:158-169` 实为 `[{rel, why, rebuild}]` | **照抄对象形态**，不自造 |
| 保留规则叫 `KEEP_PREFIXES` | `clean.js:183` 实为 `RUNTIME_KEEP_PREFIXES = { tmp: ['quarantine'] }`（**对象，按 rel 索引**） | **沿用原名原形** |
| 真源从 `clean.js` 导入 | `services → cli` 属 R1 倒置（`archDebtScan.js:239-256`） | **改落 `src/constants/`**，两侧同源消费 |
| `assessRuntimeFootprint` 已有可回收字段 | ✅ `:502 reclaimableBytes` 存在，但算法错 | **保留字段名**，只换算法来源 |
| `trimQuarantine` 需要新写 | ✅ `:881` 已实现、`:2055` 已导出 | **零新增函数**，只补调用点 |
| `getDataDir` 需新增校验参数 | `:346-350` 无任何校验 | **新增 `getDataFile()`**（加法 API），并在 `getDataDir` 内加 fail-fast |
| 幽灵目录需要新的识别正则 | ✅ `backupAssetPlan.js:249-251` 已有 `isPhantomJsonDir` | **不重复实现**，如需共用则导出复用 |

> ⚠ **一处如实登记为「不做」**：`isPhantomJsonDir` 目前在 `backupAssetPlan.js` 内**未导出**。本方案**不**为了共用去改它的导出面（那会牵动备份域的测试）；`dataHome` 侧用**自己的判据**（见 §5-A3），两处判据的**语义边界写进 §8-R3 铁律**，由测试守住一致性。

---

## 3. 与既有机制的边界表

| 既有件 | 它管什么 | 本方案做什么 | 边界 |
|---|---|---|---|
| `[DESIGN-ARCH-156]`（帧高账本 + `frameWriter` 出口收敛） | 几何账本层与**字节出口层**；§1.5 登记 3 类写者；§7 明确「不 fork / 不 patch ink」「不新增规则 ID」 | 补登记并收编**第 4 类写者：子进程 fd 继承**（§1.5 名单之外） | **不动** `frameWriter` / 几何账本 / `App.js` 内联算术。是否把捕获内容纳入 `frameWriter` 属 156 的收敛范围 ⇒ §12-Q1 |
| `cli/tui/consoleMute.js`（BUG-13 家族） | winston 的 `console._stdout/_stderr` 通道（TUI 会话期静音，文件 transport 照写） | 把**同族的 fd 逃逸路径**并入同一会话静音机制，**复用同一逃生阀** `KHY_TUI_CONSOLE_LOG` | 不改 consoleMute 的既有语义（音量），只新增「出口」维度 |
| `tui/AGENTS.md` §0.9.7 单写者原则 | 「绕过者名单」的登记处 | 名单**增列**「子进程 fd 继承」，并写明收编方式 | 不改条文本身；156 §8 已预告判定标准演进，本方案是其中一条的具体化 |
| `bootstrap/prefetch.js:188-203` 轻量入口 | 轻量模式的**有界**清理面（logs + audit）+ 体积自检 | **增补** `trimTrainingData` + `trimQuarantine` 两个调用 | **不加周期 timer**（承 `serviceLifecyclePolicy.js:225` 的「轻量模式该轻的地方仍然轻」） |
| `clean.js` 的 `RUNTIME_TARGETS` / `RUNTIME_KEEP_PREFIXES` | `khy clean --runtime` 的**删除真源** | 下沉为 `src/constants/` 叶子，`clean.js` 与 `cleanupService` **同源消费** | `clean.js` 的公开导出面**保持不变**（`RUNTIME_TARGETS` / `RUNTIME_KEEP_PREFIXES` 继续导出，供既有测试用） |
| `backupAssetPlan.js` 幽灵目录剪枝 | **备份侧**「认出它们不是状态」 | **收口侧**：让幽灵目录无法再被造出来（fail-fast） | 不动备份侧逻辑；现场清理是破坏性操作，单列 §12-Q3 |
| `[DESIGN-LAY-003]` HK-3「只隔离不删除」 | 隔离件的去向由人决定 | ④ 的 `trimQuarantine` 只裁**超出 5000 行的最旧行**（既有行为），不改语义 | **不**把 quarantine 加进 `khy clean` 白名单（那会违反 HK-3 精神）⇒ §12-Q2 |

---

## 4. 设计公理（不可让渡）

- **P1 一处语义输入。** 同一个数字/名单只能有一个产生点。③ 的修法必须让 `assessRuntimeFootprint` 与 `buildCleanPlan` **消费同一份数据**，而不是各抄一份。抄一份就是下一次漂移的种子。
- **P2 静默 `catch` 只许用在「失败无害」上，不许用在「失败=功能没了」上。** ② 的 `_ensureDir` / `saveCache` 属于后者 ⇒ 必须变响。判据：问「这段 catch 吞掉之后，用户能不能自己发现？」答不上来就不许静默。
- **P3 强度必须与「有可行解」同步。** ② 的 fail-fast 之所以敢做，是因为**实测影响面 = 0**；④ 只补调用点而不改裁剪参数，是因为既有参数已经正确。**过早阻断比不阻断更危险。**
- **P4 不新增棘轮负担。** 规则 94/94 已满、TUI 门控 236/227 已超 ⇒ 防复发一律落在**既有门控/既有机制/测试**上，不新开 ID、不新开门控。

---

## 5. 修法 A 层 —— 五件最小改动

### A1（①，必做）给 `_readInstalledVersion` 补 `stdio`

`services/backend/src/services/khySelfUpdateService.js:231`：

```js
const info = execImpl(`${_pipCmd()} show ${pkgName}`, {
  encoding: 'utf-8',
  timeout: 5000,
  stdio: ['pipe', 'pipe', 'pipe'],   // ← 新增
});
```

⚠ **必须同时覆盖候选表的两轮循环**（`_detectInstalledPackage:239-246` 会依次试 `khy-os`、`khy-quant`），否则只是把泄漏点从 `khy-os` 挪到 `khy-quant`。

**信息不丢**：pip 的 `Package(s) not found` 对用户无价值；`_readInstalledVersion` 的返回值语义不变（`catch` 后仍返回 `''`）。

### A2（①，防复发，**需裁决强度**）TUI 会话期收编子进程 fd 出口

新增叶子 `services/backend/src/cli/tui/childStdioMute.js`（**不新增 `KHY_*` token**）：

- 语义与 `consoleMute` 同构：**只动出口，不动结果**。
- 在 TUI 挂载期，对 `child_process` 的 `exec / execFile / execSync / execFileSync / spawn / spawnSync` 包一层：
  - 调用方**显式声明了 `stdio`** ⇒ **原样透传**（零行为变更，`app.js:515` 的 `stdio:'inherit'` 安装流不受影响）；
  - **未声明** ⇒ 补 `['pipe','pipe','pipe']`。
- 逃生阀**复用既有 `KHY_TUI_CONSOLE_LOG=1`**（`consoleMute.js:36` 同一语义：「想看打屏日志时回到旧行为」）⇒ **门控 token 净增 0**。
- 退出时恢复（`process.once('exit')`，与 `app.js:330` 同址同法）。
- 接线点：`cli/tui/app.js:332` 之后，紧邻 `consoleMute` 的接线块。

> ⚠ **默认丢弃还是转发，是本方案的裁决点**（§12-Q1）。默认**丢弃**（与 `consoleMute`「只动音量」对齐，且捕获内容多为工具告警）；若要保留可见性，正确归宿是 `[DESIGN-ARCH-156]` 的 `frameWriter` 带外写者通道，属 156 的范围。

### A3（②，必做）`dataHome` 收口：把静默变成响

`services/backend/src/utils/dataHome.js`：

1. `:346-350 getDataDir` 与 `:600-602 getAppDataDir` 增加段校验：任一段匹配 `/\.(json|jsonl|ndjson|db|sqlite3?|log|pid|lock)$/i` ⇒ **抛错**（附「你是不是想用 `getDataFile()`」的提示）。
2. 新增加法 API `getDataFile(...segments)`：`path.join` 后 `_ensureDir(path.dirname(p))`，**不** mkdir 末段。
3. `_ensureDir:506-516` 的 `catch {}` 收窄：`EEXIST`（并发 mkdir，无害）静默，**其余错误上抛**。

**风险 = 0 的依据**：§1.2 实测「全仓无活跃误用调用点」（仅 2 处注释提及）。实施前复跑该检索命令确认。

### A4（③，必做）清理目标真源下沉

1. 新增叶子 `services/backend/src/constants/runtimeCleanTargets.js`：**纯数据、零 IO、绝不抛**，导出 `RUNTIME_TARGETS`（对象数组，原形）与 `RUNTIME_KEEP_PREFIXES`（对象，原形）。
2. `cli/handlers/clean.js:158-183` 改为从叶子导入；**`:815-816` 的导出面保持不变**（既有测试依赖）。
3. `cleanupService.js:455-507 assessRuntimeFootprint`：
   - 删 `:460` 的 `RECLAIMABLE` 字面量；
   - 改为遍历叶子导出的 `RUNTIME_TARGETS`，并对每个 `rel` **扣掉 `RUNTIME_KEEP_PREFIXES[rel]` 命中的子项体积**——算法与 `clean.js:466-493 push()` **同构**（`bytes - keptBytes`）。

### A5（④，必做）轻量入口补两个调用

`services/backend/src/bootstrap/prefetch.js:188-203`：

```js
runtimeFootprintNotice: () => {
  try {
    const cleanup = require('../services/cleanupService');
    try { cleanup.cleanRuntimeLogs(); } catch {}
    try { cleanup.cleanTraceAudit(); } catch {}
    try { cleanup.trimTrainingData(); } catch {}   // ← 新增
    try { cleanup.trimQuarantine(); } catch {}     // ← 新增
    emitFootprintNotice(cleanup);
  } catch {}
},
```

**零新增函数、零参数调整**（`trimQuarantine:881` 与 `trimTrainingData` 均已实现并导出）。每个调用**独立 try/catch**，一项失败不影响其余（承 `prefetch.js:189-196` 既有风格）。

#### ⚠ A5'（④，执行时新增）—— 光补调用是 **no-op**，必须同时修读取路径

2026-09-29 执行步 1 时实测发现：**A5 单独落地后，它要修的那个文件一行都不会被裁**。链条如下（每一步都有可跑判据）：

| 步 | 事实 | 判据 |
|---|---|---|
| 1 | 文件 574,366,048 B（547.8 MB），而 `QUARANTINE_MAX_BYTES = 20 MB` | `fs.statSync(...).size` |
| 2 | 走 `cleanupService.js` 的「超字节上限」分支 | `size > QUARANTINE_MAX_BYTES` |
| 3 | 该分支用 `fs.readFileSync(filePath, 'utf-8')` 整文件读 | 旧 `:912` |
| 4 | 文件 **超过 Node 单字符串上限** `0x1fffffe8`（≈512 MB）⇒ 必抛 | `ERR_STRING_TOO_LONG: Cannot create a string longer than 0x1fffffe8 characters` |
| 5 | 旧实现的 `catch { continue; }` 把它吞成 `{trimmed:false}` | 旧 `:921-923` |
| 6 | 结论：**永不裁，且静默** | 实测裁前/裁后同尺寸 |

同一文件上还有第二个反直觉事实：**单行均值 761 KB**（尾部 8 MB 窗口内仅 11 行完整记录，全文件约 754 行）。因此 `QUARANTINE_MAX_LINES = 5000` 对它是**无约束力**的——5000 行合 3.6 GB；旧「超限保留最后 `floor(5000/2)=2500` 行」的语义在该文件上**根本不可表达**（2500 行 ≈ 1.8 GB，比文件本身还大）。**真正起作用的只有字节上限**，所以修法必须按字节而非按行。

修法（三处，同属 `cleanupService.js`）：

1. **新增有界尾读助手 `_readTailText(filePath, maxBytes)`**：`openSync` + `readSync` 只读尾部 `min(size, maxBytes)` 字节，返回 `{ text, truncated }`（`truncated=true` 表示窗口首行被切断）。代价有界，绝不整文件加载。
2. **两个「超限」分支改为按字节保留尾部**（`trimQuarantine` / `trimTrainingData`）：取尾窗 → **丢弃被切断的首行**（半条 JSON 留下会让下游 `JSON.parse` 炸）→ 写回。
3. **失败不再静默**：`trimQuarantine` 的 `catch { continue }` 改为记录 `lastError`，最终返回 `{ trimmed:false, error }`。承 §4-P2（静默 catch 只许用在失败无害上）——此处失败**正是全部意义所在**，属必须可诊断。

同时把两处摘要文案（`runCleanup` 的 `results.summary.actions`）从 `${before} → ${after} lines` 改为 `_trimmedAction()`：按行裁的仍报行数（既有文案不变），按字节裁的报「保留多少行 + 释放多少」，避免打印 `undefined → 28 lines`。

**验收（真实尺度，原文件只读）**：在 547.8 MB 文件的**副本**上跑 `trimQuarantine()` ⇒ `{trimmed:true, after:28, freedBytes:553687864}`，裁后 **19.72 MB ≤ 20 MB**，尾部逐字节与原文一致，耗时 **368 ms**（回应 §12-Q6：无感）。

> ★ 方法论教训（已回写 §6-B4）：**「调用面计数 > 0」不足以判定「真裁掉了」**。B4 打桩计数在 A5 单独落地时**全绿**——函数确实被调了，只是内部抛错被吞。判据必须下沉到**字节路径**（不许整文件读 + 结果尺寸真的下降）。这是本方案自身病因 C 的一个实例：**我差点把它当成「已修」上报。**

---

## 6. 防复发 B 层 —— 零新增规则 ID、零新增门控

| # | 机制 | 形态 | 为什么不是新守卫 |
|---|---|---|---|
| B1 | **③ 的一致性测试** | `tests/` 用例：在 fixture（含 `tmp/quarantine-x/`）上断言 `assessRuntimeFootprint(root).reclaimableBytes === buildCleanPlan({tiers:['runtime'], dataHome:root}).totalBytes` | 把两处**明文不变量**变成机器判据。这是「一处语义输入」的直接验收，比任何静态扫描都准 |
| B2 | **② 的双向测试** | `getDataDir('x.json')` **必须抛**（应拦）+ `getDataDir('logs')` / `getDataFile('x.json')` **必须通过**（应放行） | 只测「应拦」时，把函数改成恒抛也能全绿 |
| B3 | **① 的双向测试** | 在 mute 生效下 `execSync` 未声明 stdio ⇒ 终端无裸输出（应拦）+ 显式 `stdio:'inherit'` ⇒ 仍 inherit（应放行） | 同上；且「显式 inherit 仍生效」是 A2 不破坏安装流的唯一证据 |
| B4 | **④ 的双向测试** | (a) 调用面：断言轻量入口 runner 调用了 `trimQuarantine` 与 `trimTrainingData`（打桩计数）；(b) **字节路径**：超限文件上 `trimQuarantine` 必须真裁掉、且**不得调用整文件 `readFileSync`**（把 `fs.readFileSync` 打桩成对该路径必抛 `ERR_STRING_TOO_LONG`，仍须成功）；(c) 失败须带 `error` 出来 | ④ 的病根是「函数存在但没人调」，但**只测 (a) 会漏掉「调了却内部抛错被吞」**——2026-09-29 实测 (a) 在 A5 单独落地时全绿而文件一行没裁（见 §5-A5'）。判据必须下沉到「结果尺寸真的下降」 |
| B5 | **名单登记（唯一语义输入）** | `tui/AGENTS.md` §0.9.7 绕过者名单 + `[DESIGN-ARCH-156]` §1.5 写者表 增列「子进程 fd 继承」 | 156 §8 已把名单定义为「绕过者判定标准」的真源；**名单只有一处**，不在本方案重开一份 |

> ⚠ **不新增 `scripts/ci/` 检查器的理由（必须写清，否则会被当成漏做）**：静态判据「源码里有没有写 `stdio`」的**触发面是全部 `child_process` 调用点**，而未来新增的调用点又会漏——按 `[DESIGN-ARCH-156]` §5 的先例，低精度守卫比没有守卫更糟。A2 的**运行时兜底是单点且完备的**（不看源码、只看实际是否逃逸），所以防复发选运行时而非静态。若日后仍要静态守卫，正确形态是「**在 TUI 可达文件集上**扫裸调用」，且必须先解决「可达集怎么算」——列入 §12-Q1。

---

## 7. 强度梯度

| 阶段 | ①（A1+A2） | ②（A3） | ③（A4） | ④（A5） |
|---|---|---|---|---|
| **A 层（立即）** | A1 直接修（无强度问题） | fail-fast 直接生效 | 直接修 | 直接补调用 |
| **B 层（观察）** | A2 若采纳 ⇒ 先 S1：只记录「本会话拦了几次逃逸」到日志，不改行为 | 双向测试上线 | 一致性测试上线 | 调用面测试上线 |
| **S3（门禁）** | A2 转默认拦截（需 §12-Q1 裁决） | — | — | — |

**回退**：① 用 `KHY_TUI_CONSOLE_LOG=1` 一键回到旧行为；②③④ 均为 `git revert` 单文件可回退（③ 涉及 3 文件，但纯重接线，无行为变更）。

---

## 8. 防呆铁律（每条都有可自动判的判据）

| # | 铁律 | 可自动判的判据 |
|---|---|---|
| **R1** | 提示里报的「可回收」必须等于命令实际会删的量 | `assessRuntimeFootprint(root).reclaimableBytes === buildCleanPlan({tiers:['runtime'], dataHome:root}).totalBytes`（B1 测试） |
| **R2** | 保留/豁免规则改动时，两侧必须同改 | 叶子 `runtimeCleanTargets.js` 是唯一产生点；`git grep -n "RECLAIMABLE\|RUNTIME_KEEP_PREFIXES"` 在 `services/` 下命中数 == 0（只允许 `constants/` 与 `cli/handlers/clean.js`） |
| **R3** | 目录创建 API 不得被用于创建文件路径 | `getDataDir`/`getAppDataDir` 对 `\.(json\|jsonl\|db\|sqlite3?\|log\|pid\|lock)$` 段抛错（B2 测试双向） |
| **R4** | 静默 `catch` 不得吞掉「功能失效」类错误 | `_ensureDir` 仅 `EEXIST` 静默；`saveCache` 的失败必须至少落一条日志 |
| **R5** | 净新增 TUI 门控 = 0 | `node scripts/ci/check-tui-gates.js` 的 unique token 数**不上升**（当前 236，已超限 ⇒ 只降不升） |
| **R6** | 不新增规则 ID | `RULES-REGISTRY.json` 的 `rules.length` 与 `meta.ruleCount` 保持 94 |
| **R7** | 裁剪类能力必须有「入口覆盖 + 真裁掉」两条判据 | 轻量入口 runner 的 `trimQuarantine` / `trimTrainingData` 调用计数 > 0（B4a）**且** 超限文件上真裁掉、不得整文件读（B4b）。只满足前者 = 可能全绿而文件一行没裁 |

> **R2 是本方案最贵的一条**：③ 的病根就是「抄了列表、漏了保留规则」。判据必须是**产生点唯一**，而不是「两处数值当前相等」——后者正是 §1.2 里 156 遇到的「三份抄本今天 Δ=0，危害是漂移敞口」。

---

## 9. B-L2 三步接线清单（一次提交只做一步）

| 步 | 内容 | 出口条件 | 回退 |
|---|---|---|---|
| **步 1 标记** | A1 + A5 + **A5'**（三处最小改动；A5' 为执行时新增，见 §5-A5）+ B3/B4 双向测试 + B4b 字节路径测试 | 测试全绿；`khy` 启动 5s 后终端**无** `WARNING: Package(s) not found`（真边界探针已证：未声明 stdio 时标记出现、声明后消失）；`trimQuarantine()` 在 547.8 MB 副本上裁到 **19.72 MB**、尾部逐字节一致（实测 368 ms）。⚠ `.khy/training` 真正降到 20 MB 需**下次启动 khy**（或点名执行一次裁剪）——本步未替你执行这次不可逆删除 | `git revert` 单文件 |
| **步 2 迁移** | A4（真源下沉 + 两处消费）+ B1 一致性测试 | B1 绿；`assessRuntimeFootprint().reclaimableBytes` 与 `buildCleanPlan().totalBytes` 在真实 `.khy` 上**数值相等**（当前应为 55.4 MB） | `git revert` 3 文件 |
| **步 3 收口** | A3（`dataHome` fail-fast）+ A2（若 §12-Q1 裁决采纳） | A3：B2 双向测试绿 + 全量 `khy` 冒烟无新增异常；A2：B3 双向测试绿 + `KHY_TUI_CONSOLE_LOG=1` 逐字节回到旧行为 | A3 `git revert`；A2 门控关闭即回旧路径 |

**每步的公共验收**：

```bash
node scripts/ci/check-tui-gates.js        # R5：token 数不上升
node scripts/ci/check-repo-layout.js      # 无新增违规（注意：本仓存量本就红，需逐条比对）
cd services/backend && npm run check:arch-debt   # R1 分层倒置不新增
```

---

## 10. 验证与反例清单

| 反例 | 预期 finding / 现象 |
|---|---|
| ③ 把 `tmp/quarantine-x/`（100 MB）加进 fixture | B1 **必须红**（提示 100 MB vs 实际 0）——这条反例证明测试不是恒真 |
| ③ 把保留前缀改成空数组 | B1 仍绿（两者都算 100 MB）⇒ 说明测试测的是「两侧一致」而非「某侧算对」——**这是设计意图**，如实标注 |
| ② 把 `getDataDir('a.json')` 的校验删掉 | B2 的「应拦」分支**必须红** |
| ② 把校验收得过宽（连 `getDataDir('logs')` 也拒） | B2 的「应放行」分支**必须红** |
| ① 把 `stdio` 去掉 | B3 的「应拦」分支**必须红** |
| ① 把 A2 改成「强制覆盖所有 stdio（含显式 inherit）」 | B3 的「应放行」分支**必须红**（安装流会被破坏） |
| ④ 把 `trimQuarantine()` 调用删掉 | B4 **必须红** |
| ④ 只补 `trimTrainingData` 不补 `trimQuarantine` | B4 **必须红**（这正是首轮误判的形态：records 没超限、quarantine 超 27 倍） |

---

## 11. 复现方式（可直接粘贴）

```bash
# ── ① 证明 execSync 默认转发子进程 stderr ──
node -e "const{execSync}=require('child_process');execSync('node -e \"process.stderr.write(\\\"LEAK\\n\\\")\"')"   # LEAK 出现在终端
node -e "const{execSync}=require('child_process');execSync('node -e \"process.stderr.write(\\\"LEAK\\n\\\")\"',{stdio:['pipe','pipe','pipe']})"  # 无输出

# ── ① 证明本机必然命中 ──
pip show khy-os      # WARNING: Package(s) not found: khy-os
pip show khy-quant   # Name: khy-quant / Version: 0.1.78

# ── ② 幽灵目录 + 写入失败 ──
cd .khy && for d in */; do n="${d%/}"; case "$n" in *.json) ls -ld "$n";; esac; done
node -e "const fs=require('fs');try{fs.writeFileSync('.khy/tool_permissions.json','{}')}catch(e){console.log(e.code)}"   # EISDIR

# ── ② 确认无活跃误用（A3 爆炸半径 = 0 的依据）──
git grep -nE "get(Data|AppData)Dir\(\s*'[^']*\.(json|jsonl|db)'" -- services/backend/src

# ── ③ 提示 vs 实际 ──
node -e "const c=require('./services/backend/src/services/cleanupService');console.log(c.assessRuntimeFootprint().reclaimableHuman)"
node -e "const m=require('./services/backend/src/cli/handlers/clean.js');console.log(m.buildCleanPlan({tiers:['runtime']}).totalBytes/1048576,'MB')"

# ── ④ training 构成与超限倍数 ──
node -e "const fs=require('fs'),p='.khy/training';fs.readdirSync(p).forEach(n=>{const s=fs.statSync(p+'/'+n);console.log((s.size/1048576).toFixed(1)+' MB  '+n)})"
# interaction_quarantine.jsonl 547.8 MB  vs  QUARANTINE_MAX_BYTES = 20 MB

# ── 预算约束 ──
node scripts/ci/check-tui-gates.js    # FAIL — 236 unique KHY_* tokens (limit 227)
node -e "const j=require('./docs/10_规范/registry/RULES-REGISTRY.json');console.log(j.rules.length)"   # 94
```

---

## 12. 未决问题（**不代裁决**）

| # | 问题 | 每一条路的代价 | 建议方向 |
|---|---|---|---|
| **Q1** | ① 的 A2 要不要做？做到什么强度？（a）只做 A1；（b）A2 只记录不拦截（S1）；（c）A2 默认拦截；（d）A2 拦截并把捕获内容经 156 的 `frameWriter` 显示 | (a) 症状消失但**会复发**（下一次谁写裸 `execSync` 谁再犯）；(b) 有观测无防护；(c) 单点完备，但**属 monkey-patch 核心模块**，且需接受「TUI 期子进程 stderr 默认不可见」；(d) 最完整，但**侵入 156 的范围**，需与 156 的 S1–S3 排期对齐 | (c)，因为 156 §7 只禁 patch ink、不禁 patch node 核心；且显式 `stdio` 一律透传 ⇒ 破坏面可控 |
| **Q2** | ④ 补了自动裁剪后，**要不要给 `training` 一个 `khy clean` 档位**？ | 给档位 = 多一个删除面，且与 HK-3「隔离只隔离不删除」的精神有张力；不给 = 用户想手动回收时无路可走 | 不给。自动裁剪（5000 行/20 MB 上限）已够，手动删除面保持现状 |
| **Q3** | ② 的 4 个现场空目录（+ 2 个 `*.stale-dir-*`）**何时清、由谁清**？ | 属破坏性操作。本报告已确认 6 个目录**全为空**，但按仓库铁律必须**列清单 → 点名 → 分批** | 请点名后执行；建议与步 3 同批 |
| **Q4** | `stale-dir-` 这个命名**全仓无代码生产者**（仅 `DATA-LOCATIONS.json:103` 登记为机器树模式）。是手工产物、还是某个已删脚本的遗留？ | 若是遗留 → 该模式登记应标注来源；若仍有活跃生产者 → 说明还有一处未入仓的写入路径 | 先查清再决定是否动 `DATA-LOCATIONS.json` |
| **Q5** | ② 的 `getDataFile()` 与 `backupAssetPlan.isPhantomJsonDir` 的判据**要不要合一**？ | 合一 = 改 `backupAssetPlan` 导出面，牵动备份域测试；不合一 = 两处判据语义需靠测试守一致（本方案采此路，见 §2.2） | 保持不合一，靠 R3 测试守边界 |
| **Q6** | ④ 的 `interaction_quarantine.jsonl` 547.8 MB 首次裁剪会**一次性重写 547 MB 文件**（`atomicWriteText`），在弱机上是可感卡顿 | 直接裁 = 首次启动慢一次；先归档再裁 = 多一份 20 MB 以内的文件 | 首次裁剪走**后台延后**（如 +30s）而非 +3.5s，避免与启动节拍抢主线程 |

---

## 13. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-29 | 初始提案。来源：`.khyos/diag/2026-09-29-storage-notice-and-tui-leak-diagnosis.md`（截图诊断）。§1 四项均附 file:line 与实测数字；§2.2 七字段对照；§3 与 156 / consoleMute / prefetch / clean / backupAssetPlan 的边界；§5 五件最小改动（A1=1 行、A5=2 行）；§6 防复发零新增规则 ID / 零新增门控；§8 七条防呆铁律；§10 八条反例（含四条「应放行」对照）；§12 六项待裁决 |
| 2026-09-29 | **首轮误判已推翻并如实记录**：④ 最初判断为「`training/interaction_records.jsonl` 无界增长」，实测该文件仅 2.3 MB / 799 行（远低于 10000 行上限），真凶是 `interaction_quarantine.jsonl` 547.8 MB（超 20 MB 上限 27.4 倍）。§1.4 已按实测改写 |
| 2026-09-29 | **执行步 1 时发现 A5 单独落地是 no-op，新增 §5-A5'**：`trimQuarantine` 走「整文件 `readFileSync(utf-8)`」而该文件 547.8 MB 超 Node 单字符串上限（0x1fffffe8 ≈512 MB）⇒ 必抛 `ERR_STRING_TOO_LONG` ⇒ 旧 `catch { continue }` 吞成 `{trimmed:false}` ⇒ 永不裁。且该文件单行均值 761 KB，`QUARANTINE_MAX_LINES=5000` 对它无约束力（5000 行 ≈ 3.6 GB）⇒ 修法必须按字节。同时补记：B4 的「调用面计数 > 0」在 A5 单独落地时**全绿**（函数确实被调、只是内部抛错被吞）⇒ §6-B4 与 §8-R7 已加「真裁掉 / 不得整文件读」判据 |
