# GitHub 调研 — 版本同步与治理检查板块 — 2026-10-10

> 每日板块轮转调研（索引 6/12，第二次进入本板块，上轮为 [MGMT-RPT-028] 2026-09-15）。
> 上轮 P0（semver 校验 / check-gov-status 聚合视图 / fixture 根）均已落地；本轮聚焦
> 上轮遗留的 P1（台账聚合 + SARIF、记分卡趋势）与本轮新观察（机器可读输出缺口）。

## 调研对象

khy-os 版本治理板块现状（与 028 相比的增量）：

| 组件 | 位置 | 机制 |
|---|---|---|
| 版本同步 | `scripts/ci/check-version-sync.js` | 三轨道 10 真源 + **semver 合法性校验**（028 P0-1）+ `KHY_VERSION_SYNC_ROOT` fixture 根（028 P0-3），纯函数 `runMain` 已可被聚合视图复用 |
| 统一治理视图 | `scripts/ci/check-gov-status.js` | 版本三轨道 + 规则覆盖率 + 抑制台账 + 治理接线，表格/`--json`（028 P0-2） |
| 智能体规则 | `scripts/ci/check-agent-rules.js` | 五规则静态扫描（硬编码端点/生产域名/绝对路径、含糊状态、硬超时、DECSTBM、死循环）；`scripts/tests/check-agent-rules.test.js` 已有 Rule 1/1b/1c/3/4 + scope 的 fixture 回归（028 后补齐） |
| 规则绑定层 | `scripts/ruleguard/` | `run`/`coverage`/`apply`/`manifest` 四子命令；`ledger.js`（violations.jsonl 追加台账 + 旋转 + 抑制）+ `baseline.js`（棘轮）+ `coverage.js`（覆盖率报告 + 阻断红线） |

**短板（3 条，本轮新观察；028 已落地项不再列）**：

1. **check-agent-rules 无机器可读输出**：五规则的 findings 只有人类 stdout（`[ERROR]/[WARN]` 行），没有 `--json`。CI 下游（PR 评论机器人、GitHub code scanning、趋势抓取）无法按结构消费——eslint/semgrep 的 `--format json`、reviewdog 的 rdjson 全都以机器可读为一等输出。
2. **台账只记不读（028 遗留 P1）**：`ledger.append` 落 `violations.jsonl`，`readAll`/`activeSuppressions` 已有，但**没有按规则/文件/门聚合的报告**，也没有 SARIF 方言——台账「写满即沉没」，无法回答「哪条规则最近在超基线」「哪个文件是惯犯」。
3. **覆盖率与台账互不打通（028 遗留 P1 的另一半）**：`coverage.renderCoverage` 只报登记表点值（enforced/total、红线），不消费台账历史——「这周违规数比上周升了还是降了」答不了；棘轮基线（ruleguard-baseline.json）只有单期快照，无跨期趋势。

## 对标项目

| 项目 | Star（2026-10-10） | 技术栈 | 相关度 | 链接 |
|---|---|---|---|---|
| eslint | ~27.6k | JS | 高：`--format json` 机器可读输出 + `RuleTester`（合成语料 + 断言）+ SARIF formatter | https://github.com/eslint/eslint |
| semgrep | ~16.9k | OCaml/Python | 高：`--json`/`--sarif` 输出一等公民，规则即数据 | https://github.com/semgrep/semgrep |
| reviewdog | ~9.7k | Go | 高：rdjson 统一机器可读诊断方言，消费任意工具输出 → PR 评论 | https://github.com/reviewdog/reviewdog |
| Checkov | ~9.1k | Python | 高（028 已用）：抑制即数据 + SARIF 导出给 GitHub code scanning | https://github.com/bridgecrewio/checkov |
| MegaLinter | ~2.6k | Docker/Python | 中：聚合多工具结果 + 统一报告 + 趋势 | https://github.com/oxsecurity/megalinter |

**关键发现**：028 之后本仓治理层在「登记表驱动 + 棘轮 + 台账 + fixture 回归」上已与 eslint/semgrep 的工程实践同构；剩余缺口全部集中在**输出侧**——检查器会算但不会说（无 --json）、台账会写但不会读（无聚合/SARIF）、覆盖率会报但不看历史（无趋势）。三条都只动 1–2 个脚本、纯读或纯格式化，无门禁语义变化。

## 值得借鉴的点

### 1. 机器可读输出作为一等公民：check-agent-rules `--json`（P0）

**对方怎么做**：eslint `--format json` 输出 `[{filePath, messages[{ruleId,severity,line,column,message}], errorCount, warningCount}]`；semgrep `--json` 同构。CI 侧 reviewdog 只认机器可读方言，人类输出从不被解析。

**khy-os 现状差在哪**：`check-agent-rules.js` 的 findings 结构在内存里是规整的 `{severity, rule, file, line, message, snippet}`，但 `printFindings` 只渲染人类行；`main()` 不解析 `--json`。

**改哪些文件**：`scripts/ci/check-agent-rules.js`（`printFindings` 加 JSON 分支；`main()` 解析 `--json` 标志；人类输出默认逐字节不变）。注意 `--strict-warnings` 与 exit 码语义保持不变。

### 2. 台账聚合 + SARIF 导出：ruleguard `ledger` 子命令（P0，028 遗留 P1 升级）

**对方怎么做**：Checkov 的 SARIF 输出让 GitHub code scanning 直接标注违规行；`suppress` 记录即数据。MegaLinter 聚合报告回答「哪个工具哪个文件是惯犯」。

**khy-os 现状差在哪**：`violations.jsonl` 有 append 无读侧；`activeSuppressions` 只给覆盖报告供数；没有一条命令能聚合「按规则/文件/门计数 + 活跃抑制 + 超基线项」，更没有 SARIF。

**改哪些文件**：`scripts/ruleguard/lib/ledger.js`（加 `aggregate`：byRule/byFile/byGate 计数 + byCommit 趋势序列，纯函数，`KHY_RULEGUARD_LEDGER` fixture 沿用）；`scripts/ruleguard/index.js`（加 `ledger` 子命令：人类表格 / `--json` / `--sarif`，零写操作）。

### 3. 覆盖率消费台账历史：趋势段（P0，028 遗留 P1）

**对方怎么做**：MegaLinter/Backstage 记分卡带趋势字段（↑↓）；eslint 的项目级统计靠外部聚合。

**khy-os 现状差在哪**：`coverage.renderCoverage` 只报点值；台账历史（violations.jsonl 按 ts/commit 记录）躺着没人读。

**改哪些文件**：`scripts/ruleguard/lib/coverage.js`（`buildCoverage` 加 `trend`：从台账按 commit 分组的最近违规序列 + 环比升降，纯读、台账缺失时静默跳过）；`renderCoverage` 渲染趋势段。

## 落地建议（排序）

| # | 行动 | 优先级 | 工作量 |
|---|---|---|---|
| 1 | check-agent-rules `--json`（结构化 findings，exit 语义不变） | P0 | 1 小时 |
| 2 | ruleguard `ledger` 子命令（聚合 byRule/byFile/byGate + byCommit 趋势 + `--sarif`，纯读） | P0 | 半天 |
| 3 | coverage 趋势段（renderCoverage 消费台账历史，纯读） | P0 | 1–2 小时 |
| 4 | check-gov-status 接线 PR gate（补 `check:gov-status` 脚本 + workflow 一步） | P1 | 人工点头项 |

## 参考链接

- https://github.com/eslint/eslint — `--format json` + RuleTester + SARIF formatter
- https://github.com/semgrep/semgrep — `--json`/`--sarif` 一等输出
- https://github.com/reviewdog/reviewdog — rdjson 机器可读诊断方言
- https://github.com/bridgecrewio/checkov — 抑制即数据 + SARIF
- https://github.com/oxsecurity/megalinter — 聚合报告 + 趋势

## 落地记录

> 本轮落地 3 条 P0；全程零写操作（台账只读）、无门禁语义变化（exit 码与人类输出默认逐字节不变）、未新增顶层目录/npm run 入口、未改版本号。

### 已实现条目（3 条 P0）

**P0-1 check-agent-rules `--json` 机器可读输出（eslint `--format json` / semgrep `--json` 模式）** — 已实现
- `scripts/ci/check-agent-rules.js` 新增 `printFindingsJson`：`{summary:{errors,warnings,filesScanned,skipped[]}, findings:[{severity,rule,file,line,message,snippet}]}` 结构化输出；`main()` 解析 `--json`。
- 人类输出与 exit 码语义**逐字节不变**（`--strict-warnings`、exit 2「没扫成」契约保持）；`--json` 时 `[SKIP ]` 通知并入 `summary.skipped`（机器可读侧不丢覆盖面信息）。

**P0-2 ruleguard `ledger` 子命令：台账聚合 + SARIF 导出（Checkov / MegaLinter 模式，028 遗留 P1 升级落地）** — 已实现
- `scripts/ruleguard/lib/ledger.js` 新增 `aggregate(repoRoot)`（byRule/byFile/byGate 计数 + byCommit 时间序趋势序列 + 时间跨度，纯读，空台账返回空聚合）与 `toSarif(records)`（SARIF 2.1.0：rules 去重、blocking→error/advisory→warning、`suppressed` 旗标、URI 反斜杠归一、零 IO 纯函数）。
- `scripts/ruleguard/index.js` 新增 `commandLedger`：`ledger`（别名 `trend`）子命令，人类表格（按规则/文件/门 Top-N + ASCII 趋势条）/ `--json` / `--sarif` 三出口；`--sarif` 进 parseArgs；usage 同步登记。

**P0-3 coverage 趋势段（MegaLinter/Backstage 记分卡模式，028 遗留 P1 落地）** — 已实现
- `scripts/ruleguard/lib/coverage.js` 新增 `ledgerTrend(repoRoot)`：台账最近两期（按 commit 分组）环比 `{prev,last,delta,direction,byCommit}`，纯读、台账缺失/单期/不可读 → `null` 静默跳过（趋势是软指标，绝不抛、绝不阻）；`buildCoverage` 结果带 `trend` 字段（`--json` 自动带出），`renderCoverage` 渲染 `违规趋势（台账最近两期）：↑/↓/→ prev → last（±delta）` 段。

### 改动文件清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/ci/check-agent-rules.js` | 改 | P0-1 `--json` 机器可读输出（`printFindingsJson` + main 分支 + usage 注释） |
| `scripts/ruleguard/lib/ledger.js` | 改 | P0-2 `aggregate` + `toSarif` 纯函数，导出扩展 |
| `scripts/ruleguard/index.js` | 改 | P0-2 `ledger`/`trend` 子命令（人类/`--json`/`--sarif`）+ `--sarif` 参数 + usage |
| `scripts/ruleguard/lib/coverage.js` | 改 | P0-3 `ledgerTrend` + buildCoverage `trend` 字段 + renderCoverage 趋势段 |

### 检查结果

| 检查 | 结果 |
|---|---|
| 夹具驱动功能验证（`KHY_RULEGUARD_LEDGER` 指向合成台账，真源零触碰） | **16/16 全过**：aggregate 计数/序列；SARIF 版本/规则去重/suppressed/level/URI 归一；趋势 up/缺台账 null；`ledger --json` 干净运行 |
| `node scripts/ci/check-agent-rules.js --changed --json`（真实） | ✓ JSON 可解析：0 error / 7 warning（存量文件）/ 265 文件 |
| `node scripts/ruleguard/index.js ledger`（真实台账） | ✓ 聚合 26 条（6 规则 / 按文件 / 按门 / 趋势条） |
| `node scripts/ruleguard/index.js ledger --sarif`（真实台账） | ✓ SARIF 2.1.0：6 rules / 26 results |
| `node scripts/ruleguard/index.js coverage`（真实） | ✓ 全绿；台账仅 1 个 commit → 趋势段如实静默（单期无环比） |
| `node --test scripts/tests/check-agent-rules.test.js` | 37/37 通过 |
| `node --test scripts/tests/coverage-gate.test.js check-rules-registry.test.js check-gov-rules.test.js` | 28/28 通过 |
| `node scripts/ci/check-agent-rules.js <四个改动文件>` | 零违规 |

### 未实现项（待人工决策 / 留后续：1 条）

- ~~**P1 check-gov-status 接线 PR gate**~~：**已于 2026-10-10 经人工点头接入门**（见下补记）。
- 说明：上轮（028）落地时报告的「check-agent-rules 无 fixture 回归」短板现已由 `scripts/tests/check-agent-rules.test.js`（37 条，Rule 1/1b/1c/3/4 + scope）覆盖，本轮调研时已确认并从短板清单移除。

### 接线补记（2026-10-10，人工点头）：check-gov-status 进 PR gate

> 核实：`check:gov-status` 脚本条目已在 `package.json`（本轮前已被补），缺的只是 PR gate 一步。

- `.github/workflows/pr-gate.yml` `contract-checks` 作业：在 `Check governance rules` 之后新增
  **`Check governance status (aggregate)`** 步骤（`node scripts/ci/check-gov-status.js`）——
  一表读全版本三轨道 + semver 合法性 + 规则覆盖率 + 抑制台账 + 治理接线；exit 1 只对阻断
  红线（版本不匹配 / 非 semver / P0 未执行 / 死指针 / 接线缺口），软指标只报不阻，与 coverage 步骤同口径。

**校验结果**：`check-gov-status` 本地全绿；`check-gov-rules.js`（GOV-MOD-004/TOOL-004/005/006 均满足）、
`check-wiring.js`（106 检查器全部接线，豁免 11 项不变）、`check-workflow-sanity.js`（0 error；
1 条 warning 为已接受现状的 package-lock 双锁文件提示）、`check-delivery-baseline.js` 棘轮读数
与改动前逐字一致——workflow 改动零退化。
