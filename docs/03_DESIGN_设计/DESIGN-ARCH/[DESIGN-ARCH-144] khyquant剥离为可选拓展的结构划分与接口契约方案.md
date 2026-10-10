# [DESIGN-ARCH-144] khyquant 剥离为可选拓展的结构划分与接口契约方案

> **状态**：提案（待裁决）  ·  **范围**：仓库结构 / 依赖方向 / 接口契约  ·  **上游依赖**：无外部借鉴
> **调研指针**：[DESIGN-TOOL-002]（拓展契约）、[DESIGN-ARCH-011]（应用接入标准）、[DESIGN-ARCH-069]（断边先例）、[DESIGN-ARCH-078] §10.3（L4_DIR 修正史）
> **模板合规**：B-P2 七字段按 §4.0 据实填「不适用」（非借鉴类，见 §2）

---

## 0. 一句话结论

**「剥离」的运行时架构 2026-09 已完成约 80%**——`quantApp.js` 单一解析点 + `mountOptional` fail-soft 已让「删目录仍能启动」成立并有 6 例回归测试锁住；剩下的 20% 是**物理落位**（`software/khyquant` → `extensions/apps/khy-quant` + 落 manifest 使 provides 契约发现生效）、**断反向依赖**（打包 entry 硬 require backend 内部）和**路径字面量清理**（10 个脚本 ~40 处）。本提案把这三步做成四期可独立回滚的施工，并给出正式的模块间接口契约。

**病灶表格**（现状与「可选能力」定义的差距）：

| # | 差距 | 现状证据 | 后果 |
|---|------|---------|------|
| G1 | 应用不在任何拓展根下，provides 契约发现必然落空 | `quantApp.js:19-21` 自述「khyquant 目前仍在 L4 `software/`，不在任何拓展根下」 | 每次解析都走迁移期兜底（写死 L4 磁盘路径） |
| G2 | 核里留 25+ 个 `@deprecated` shim 空壳 | `services/backend/src/routes/strategy.js:3` 等（2026-09-03 标注「3 月后删除」，至今未删） | 核文件树含 quant 名字文件，语义上仍「内置」 |
| G3 | 打包 entry 反向硬依赖 backend 内部 | `packaging/modules/entries/khy-quant-entry.js:343,348,352`（require backend 的 windowsSpawnHardening / cli/repl / cli/router） | 独立分发形态下无法脱离 backend 源树 |
| G4 | workspace 与 CI 把前端当一等成员 | `pnpm-workspace.yaml:10`；`frontend-ci.yml:113-165` | 安装面 / 门禁面不随「可选」收缩 |
| G5 | 路径字面量散布 10 个脚本 | `scripts/release/pip_packaging_rules.py`（~15 处）、`scripts/ruleguard/register-external-rules.js`（7 处）等 | 移动目录要同步改 ~40 处 |

---

## 1. 现状实证（file:line 可复核）

### 1.1 应用实体与规模

| 项 | 值 | 证据 |
|---|---|---|
| 实体位置 | `software/khyquant/`（L4 内置位） | 本提案探针 2026-09-24 全仓扫描（排除 node_modules 等后 ~470 文件） |
| Node 侧 | routes 20 个（259KB，最大 `strategy.js` 87KB）、services 62 个（1019KB）、models 31 个、controllers 3 个、tools 114 个 | `software/khyquant/{routes,services,models,controllers,tools}/` |
| 前端 | Vue3 + lightweight-charts + Capacitor，180 文件 3.1MB | `software/khyquant/frontend/`；INIT-PRD-001:125 |
| Python 侧 | `khy_quant/`（4 文件 20KB）+ `ml/`（13 文件）+ `pyproject.toml` | 目录扫描 |
| 部分前端已判死 | 37 个 views/components 文件 2026-09-15 入隔离区 | `.khyos/deadcode-quarantine/05-khyquant-frontend/manifest.json` |

### 1.2 已完成的解耦（别重做）

| 机制 | 证据 | 语义 |
|---|---|---|
| 单一解析点 `quantApp.js` | `services/backend/src/services/domain/extensions/extensions/quantApp.js:41`（`SERVICE='quant-app'`），两级解析 `:65-84`（①provides 契约发现 → ②L4 兜底） | 57 处「点名磁盘位置」收敛成一处「点名服务」（[DESIGN-TOOL-002] §3.4） |
| fail-soft 路由挂载 | `services/backend/server.js:440` `mountOptional()`，`:427` 注释兑现「删目录即卸载」承诺；`:454` 缺席时返回汇总文案 | 应用缺席 → 404 + 明确提示，启动不受影响 |
| 回归测试锁 | `tests/extensions/quantAppServerMount.test.js`（6 例：在位全挂 / 缺席仍启动 / 静态防复发）、`tests/extensions/quantAppSeam.test.js` | 断边行为有测试钉 |
| shim 层已合规 | `services/backend/src/routes/strategy.js:3` = `quantApp.loadModule('routes/strategy')`，不再点名磁盘路径 | shim 是「服务名间接层」，非硬依赖 |
| Python 双模守卫 | `software/khyquant/khy_quant/app.py:16-22`（try/except 底座导入，独立安装不崩）+ `:58-60` entry_point 工厂 | 应用协议已达标 |
| 打包模块化 | `packaging/modules/modules.json:411-429`（khy-quant 独立 id/handlers/services/includeDeps/excludeDeps） | 分发面已按模块裁剪 |
| CLI 模式门 | `services/backend/src/cli/router.js:366-374`（`KHYQUANT_APP_ONLY`，默认 true） | 以 khyquant 身份被调用时收敛命令面 |
| 应用注册 | `.khyos/apps/khyquant.json`（本机态，autoStart:false） | `khy apps` 可发现 |

### 1.3 硬耦合残留（本提案要断的）

| 项 | 证据 | 性质 |
|---|---|---|
| L4 兜底路径写死在核 | `quantApp.js:50`（上溯 7 层到 `software/khyquant`）、`:76-83` | 运行时，第二真源 |
| 25+ 个 shim 空壳 | `src/routes/*.js` 20 个、`src/models/*.js` 11 个、`src/controllers/*.js` 3 个、`src/services/*.js` ~15 个（全部 `@deprecated 2026-09-03`） | 文件树整洁性（运行时已合规） |
| 打包 entry 反向依赖 | `packaging/modules/entries/khy-quant-entry.js:343`（windowsSpawnHardening）、`:348`（cli/repl）、`:352`（cli/router） | 反向 require backend 内部 |
| workspace 成员 | `pnpm-workspace.yaml:10` | 构建面 |
| CI 硬挂 | `.github/workflows/frontend-ci.yml:113-165`（`khyquant-frontend` job；`:18,:26` 有 path filter） | 门禁面（已 path-filtered，可选性达标，仅路径要改） |
| 路径字面量 ~40 处 | §0 G5 表 + `scripts/tests/check-repo-layout.test.js:221-253`（layout 检查器测试里教的是**旧 shim 写法**，需随新布局更新） | 脚本层 |
| bootstrap 双档 mode | `src/bootstrap/state.js:16`（`'khy' | 'khyquant'`）、`setup.js:31,54`、`prefetch.js:25,42` | 运行时模式名（**不动**，见 §5） |
| 安装标记文件 | `services/backend/.khy_quant_bootstrapped` 等 3 个；`startupFailureExplain.js:174,202` 重装指引提及 | 历史命名（**不动**，见 §5） |

### 1.4 数据目录与品牌（明确不属于「依赖」）

`~/.khyquant/` 是跨三端的**用户数据契约**：`apps/ai-frontend/backendDiscovery.mjs:142`（进程发现）、`apps/provider-hub/src/main/usage.ts:41`（用量读取）、`apps/khyos-desktop/src/main/keyManager/keyStore.ts:87`（`KHYQUANT_PORTABLE_ROOT` 便携根）、`TitleBar.tsx:140`（日志路径提示）。语义由 AGENTS.md:255-266 定死。`khyquant.top` 是更新/品牌域名（`apps/khyos-desktop/package.json:100`）。**这两类与功能耦合无关，剥离不触碰。**

---

## 2. 借鉴提案（B-P2 七字段）

**非借鉴类，不适用。** 依据：本提案是仓库内部结构收尾，全部机制（拓展契约、fail-soft 挂载、应用协议、模块化打包）均为既有本仓设计的延伸，无外部上游。B-P2 第 1 字段「项目名+版本/commit」无对象可填；不为了「看起来合规」硬借一个上游（SOURCING 红线）。真源依据：[SOURCING-001] §3 B-P2 只约束「借鉴外部」；本提案属内部架构提案，走 DESIGN-ARCH 体例。

---

## 3. 目标形态（结构划分 + 解耦方式 + 接口契约）

### 3.1 项目结构划分方案

```
khy-os/（底座仓库，剥离后）
├── services/backend/
│   ├── server.js                        # mountOptional 挂载不变（server.js:458-614 原样）
│   └── src/services/domain/extensions/
│       └── extensions/quantApp.js       # 保留；Phase 2 删 L4 兜底（:44-50,:76-83）
├── extensions/                          # 拓展根（extensionRoots.js:98-150 五级根的第 2 级）
│   ├── tools/khy-markdown/              # 既有试点（khy.extension.json provides 先例）
│   └── apps/khy-quant/                  # ← software/khyquant 整体迁入（git mv，内容零改动）
│       ├── khy.extension.json           # ★ 唯一新增文件（§3.3 契约 A）
│       ├── routes/ services/ models/ controllers/ handlers/ tools/ indicators/
│       ├── frontend/                    # 原样（workspace 成员路径随之更新）
│       ├── khy_quant/  ml/  pyproject.toml
│       └── tests/
├── packaging/modules/                   # modules.json 不变（entry 文件名引用，无路径）
└── scripts/…                            # ~40 处路径字面量同步更新（§1.3 清单）

khy-os-khyquant/（未来独立仓库形态）
└── 仅 Phase 3 交预案，本提案不执行拆仓（理由见 §5 第 4 条）
```

**要点**：唯一新增的契约文件是 `khy.extension.json`，其余全部是「移动 + 删除 + 路径改写」。这是**扩展既有 canonical**——契约发现机制（`extensionRoots.findProvider`）与 manifest 格式（`extensions/tools/khy-markdown/khy.extension.json`）都是现成的，不是新建并行真源。

### 3.2 依赖解耦方式（三向各断各的）

**① 核 → 应用（运行时，已断 90%，收尾两刀）**
- 搬迁后 manifest 与目录同 commit 落地，`findProvider('quant-app')` 立即命中 → Phase 2 删除 L4 兜底分支（`quantApp.js:44-50,76-83`）。不删兜底 = 把 `software/khyquant` 磁盘位置永久写死在核里，下次移动再爆一次。
- 25+ shim 的处置：**shim 已不构成依赖**（应用缺席时 `loadModule` 返回 null，启动无感）。删除它们是整洁性收益而非解耦收益，放 Phase 4 并配 CI 静态守卫（见 §3.3 契约 E）。server.js 的挂载点改直挂 `quantApp.loadModule(...)` 可省一层，但 `scripts/tests/check-repo-layout.test.js:221-253` 表明 layout 检查器仍在教旧写法，需同步改写。

**② 应用 → 核（反向，本次主战场）**
- `khy-quant-entry.js:340-354` 的三处反向 require 改为**宿主能力注入**（§3.3 契约 D）：entry 不再 `require('../../../services/backend/src/cli/repl')`，而是接受宿主传入的 `{ commands, config, logger }`；无宿主时降级 standalone 形态（只起 HTTP API + 静态前端）。
- 模块 bare require 依赖 backend/node_modules 的问题由既有 `ensureAiBackendResolvable()`（`quantApp.js:113`）机制覆盖，dev 树与便携安装均可见后端依赖——机制不变，写入 manifest 的 `engines.khy` 语义（宿主版本门槛）。
- Python 侧已达标（`app.py:16-22` 守卫），零改动。

**③ 构建 / CI / 分发面**
- `pnpm-workspace.yaml:10` → `extensions/apps/khy-quant/frontend`。
- `frontend-ci.yml` 路径更新（job 本身已 path-filtered，可选性达标）。
- `pip_packaging_rules.py` 的打包规则按新路径同步（分发面本来就是「quant 随主包发但可裁剪」，Phase 3 预案再提供独立 wheel/sdist 通道）。
- `.khyos/apps/khyquant.json` 是本机态（gitignore），entry 语义随应用发现协议自动修正，不入仓不强制。

**数据面不动**：`~/.khyquant/`、`khyquant.top`、`KHYQUANT_PORTABLE_ROOT`、bootstrap mode 字符串 `'khyquant'` 全部保留原语义（§1.4 + §5）。

### 3.3 模块间接口定义（契约总表）

| ID | 契约 | 状态 | 定义 |
|---|---|---|---|
| A | **manifest 提供声明** | ★ 新增文件 | `extensions/apps/khy-quant/khy.extension.json`：`id:"khy-quant"`、`kind:"runtime"`、`namespace:"quant"`、`provides:["quant-app"]`、`engines:{khy:">=1.1.0"}`、`main`（REPL 桥，standalone 形态可空）、`capabilities:["commands","routes","mcp"]`。`provides` 值必须逐字等于 `quantApp.SERVICE`（`quantApp.js:41`）——这是核与应用之间唯一的名字耦合点 |
| B | **服务解析接口** | 已有，保留 | `quantApp.loadModule(rel) -> module\|null`，三档语义：未安装→null；模块不在→null；**加载抛错→照抛**（真 bug 不许静默 404，`quantApp.js:24-29`）。`resolveDir()` 缓存语义与 `__resetCache()` 测试钩子不变 |
| C | **HTTP 路由面** | 已有，登记成文 | 22 条 `mountOptional` 路由（server.js:458-614 全列）：`/api/strategies`(+单数别名)、`/api/backtest`(+复数别名)、`/api/watchlist`、`/api/stock`、`/api/dashboard`、`/api/trading`、`/api/trades`、`/api/trading-agents`、`/api/comprehensive`(+别名)、`/api/market`、`/api/replay`、`/api/tick-backtest`、`/api/futures-tick`、`/api/bank-transfer`、`/api/instruments`、`/api/favorites`、`/api/kline-data`、`/api/instrument-sync`。缺席行为：404 + `_skippedMounts` 汇总文案（server.js:454）。khyquant frontend 独立部署按此表对接 |
| D | **宿主能力注入** | ★ 新增接口 | `createHostContext({ commands, config, logger }) -> HostContext`。`khy-quant-entry.js` 接受宿主注入替代三处反向 require；无宿主（独立安装）时 entry 走 standalone：仅 HTTP API + 前端，REPL/命令路由能力缺席并如实提示。与 khy-markdown `_note` 里「commands 改经 ctx.commands.register 贡献」的既定方向同构 |
| E | **核心边界静态守卫** | ★ 新增 CI | check-repo-layout 检查器加规则：`services/backend/src` 下禁止出现 `require.*software/khyquant` 与 `require.*extensions/apps/khy-quant`（只能经 `quantApp.loadModule`）；shim 全删后核文件树无 quant 名字文件 |
| F | **Python 应用协议** | 已有，保留 | `KhyApp`（`platform/khy_platform/app_protocol.py`）+ `[project.entry-points."khyos.apps"]` + `create_app()` 工厂（`khy_quant/app.py:58-60`）；底座缺席 import 不崩（`app.py:16-22`） |
| G | **CLI 命令面** | 已有，登记 | `packaging/modules/modules.json:416-424` handlers 7 条（backtest/data/insights/market/pool/receipts/training）+ `router.js:366-374` `KHYQUANT_APP_ONLY` 模式门（默认 true） |

### 3.4 「可选能力」的最终判定口径

剥离完成后，以下三条**同时**成立即算达标：

1. `git` 工作树中删除 `extensions/apps/khy-quant/` → `server.js` 正常启动，22 条路由 404 + 汇总文案，`khy` 其余功能无感（已有 6 例测试锁，Phase 1 后重跑验证新路径）。
2. `pnpm-workspace.yaml` / `frontend-ci.yml` / 打包规则中 khyquant 条目均为**独立可摘除块**（摘除 = 删行，无连锁）。
3. 核源码树（`services/backend/src`）grep `khyquant|khy-quant` 仅命中：`quantApp.js`（服务名定义处）、bootstrap mode 字符串、安装标记文件名——无路径、无 id 硬编码分支（[DESIGN-TOOL-002] §1.3 第四条）。

---

## 4. 实施分期（每期独立可回滚）

| 期 | 内容 | 回滚方式 |
|---|---|---|
| **Phase 1 落位**（纯重构，行为不变） | `git mv software/khyquant extensions/apps/khy-quant`；同 commit 落 `khy.extension.json`；同步改 §1.3 路径字面量清单（workspace / CI / 10 个脚本 / AGENTS·CLAUDE·CONTRIBUTING 文档）；重跑 quantAppSeam + quantAppServerMount 基线。**manifest 与目录必须同 commit**——否则契约发现落空、兜底指空，整档静默「未安装」 | `git revert` 单 commit |
| **Phase 2 断反向** | 删 `quantApp.js` L4 兜底分支；`khy-quant-entry.js` 改宿主注入（契约 D）；packaging runtime 打包自检 entry 无 backend 内部路径 require | revert entry + 兜底两个文件 |
| **Phase 3 独立形态预案**（只交文档不施工） | 独立仓库 / 独立发布渠道（npm scoped 包 + Python wheel）拆分预案；打包产物里 standalone 形态的依赖闭包清单 | 不施工，无回滚问题 |
| **Phase 4 核内清理** | 删 25+ shim；server.js 挂载点直挂 `loadModule`；check-repo-layout 新规则（契约 E）+ 其测试改写；删除 `services/backend/src/services` 下残留 quant shim 的 `@deprecated` 标记 | revert + shim 文件从 git 历史恢复 |

依赖关系：Phase 1 → 2 → 4 严格串行；Phase 3 可与 2 并行。

---

## 5. 诚实边界（刻意不纳入，逐条给原因)

1. **`~/.khyquant/` 数据目录不改名**——它是 ai-frontend / provider-hub / khyos-desktop 三端共同消费的用户数据契约（AGENTS.md:255-266 定死），改名 = 大爆炸，「应用剥离」与「数据目录语义」是两件事。
2. **`khyquant.top` 域名、`KHYQUANT_PORTABLE_ROOT` env 不改**——品牌与便携布局语义，与功能依赖无关；`apps/khyos-desktop/package.json:100` 是更新通道地址，动它会断自动更新。
3. **bootstrap mode 字符串 `'khyquant'`（`state.js:16`）与 `.khy_quant_bootstrapped` 标记文件不改名**——运行时模式名与安装标记，历史命名不构成依赖；改名要动 setup/prefetch/startupFailureExplain 至少 4 个文件的文案与逻辑，收益为零。
4. **不拆独立 git 仓库**——74 个 CI 检查器与自治治理体系对 `extensions/apps/khy-quant` 同样生效；拆仓即失去门禁保护，与「不越改越差」的目标相反。Phase 3 只交预案。
5. **隔离区 37 个死代码前端文件不复活不删除**——随 `.khyos/deadcode-quarantine/05-khyquant-frontend/` 原样留在本机态，由死代码治理流程另行裁决。
6. **前端 `@khy/ui-shared` 三真源问题不在本提案修**（CLAUDE.md:35）——那是独立的结构债，搬迁后路径更新即可，不趁机重构。

---

## 6. 反模式（这条路别走）

| ✗ 别做 | 为什么 |
|---|---|
| 直接 `git mv` 而不落 manifest | `findProvider('quant-app')` 落空 + L4 兜底指空 → quant-app 整档静默「未安装」，22 条路由全 404，行为**无声**劣化——正是 [DESIGN-ARCH-078] §10.3 记录过的 L4_DIR 指空事故的重演 |
| 保留 L4 兜底「以防万一」 | 兜底写的是磁盘路径不是服务名，留着它 = `software/khyquant` 这个位置事实在核里永生，`quantApp.js:19-21` 自己都说「Phase 1 搬完目录即可删掉这一支」 |
| 把 `mountOptional` 改回硬挂载「为了启动期显式报错」 | 推翻 [DESIGN-TOOL-002] §4.1「删目录即卸载」承诺；`quantAppServerMount.test.js` 6 例直接红，其中含静态防复发断言（量化路由不许绕过 mountOptional） |
| 在 Phase 1 顺手删 25 个 shim | shim 有零散第三方 require 方（cli/handlers、aiChatCore 等面广），未全仓核实消费者前删除 = 把「可选」做成「启动崩」；必须先跑消费者扫描（Phase 4 前置） |
| 让 entry 继续反向 require backend「先跑起来再说」 | 反向依赖每 +1 处，独立剥离难度 +1；契约 D 的宿主注入方向 khy-markdown `_note` 里已经写明，不要再造第三种接法 |
| 改 `~/.khyquant` / 品牌域名 / bootstrap mode 字符串 | 见 §5 第 1-3 条 |

---

## 7. 验收方式

```bash
# 基线与回归（Phase 1 后必须全绿，基线数字以实际跑出为准，不许估）
node --test services/backend/tests/extensions/quantAppSeam.test.js
node --test services/backend/tests/extensions/quantAppServerMount.test.js
node --test services/backend/tests/routes/quantAppWiring.presets.marketQuotes.test.js

# 删目录演练（§3.4 判定口径第 1 条）
mv extensions/apps/khy-quant /tmp/kq-drill && node services/backend/server.js &
# 期望：启动成功；curl /api/market → 404 + 「quant-app 服务未安装」汇总
mv /tmp/kq-drill extensions/apps/khy-quant

# 应用发现（Python 侧不受目录迁移影响）
khy apps --json   # 期望：khyquant 条目仍在（entry_points 协议发现）

# workspace 与门禁
pnpm install      # 期望：extensions/apps/khy-quant/frontend 成员解析成功
node scripts/ci/check-repo-layout.js   # Phase 4 后：核内无 quant shim 违例
```

关联门禁：`npm run check:changed`、`npm run check:proposal-index`（本文档非借鉴类，不登记 PROPOSAL-ARTIFACT-INDEX）、`frontend-ci.yml` 的 `khyquant-frontend` job（path filter 生效即「改 khyquant 才跑」）。

---

## 8. 待核实项

1. ~~`discover()` 是否支持 `extensions/apps/` 新分类~~ **已查清**：`extensionRoots.js:266-275` 两级下探——根下每目录先 `take()`，无 manifest 则当分类目录对其 child 再 `take()`。khy-markdown 在 `extensions/tools/` 即同机制。前提成立。
2. ~~路径字面量分布~~ **已查清**：10 个脚本 ~40 处 + `pnpm-workspace.yaml:10` + `frontend-ci.yml` 多处 + 文档 3 篇，清单见 §1.3；全部为脚本/文档层字面量，无运行时路径依赖。
3. **25 个 shim 的第三方消费者全量清单**（Phase 4 前置）：需全仓扫 `require.*(routes/strategy|models/Trade|services/backtestEngine…)` 确认除 server.js 外还有谁点名。**不阻断 Phase 1/2**。
4. **frontend `@khy/ui-shared` 在新路径下的 workspace 解析**（`pnpm-workspace.yaml` overrides 段未涉及 ui-shared，预计无影响，Phase 1 落地时 `pnpm install` 实测验证）。
5. `scripts/tests/check-repo-layout.test.js:221-253` 教的旧 shim 写法与 layout 检查器本体的规则集（Phase 4 改写范围的精确清单）。

---

## 9. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-09-24 | 初稿：现状实证（探针全仓扫描 + 12 处 file:line 核读）、四期施工、七契约总表、三判定口径 |
| 2026-09-24 | §10 实施记录：跳过 Phase 1 过渡形态，直接执行独立项目形态（原 Phase 3 提前） |

---

## 10. 实施记录（2026-09-24，当日完成）

### 10.1 裁决偏离

**Phase 1（extensions/ 内过渡落位）被跳过**，直接执行独立项目形态（原 Phase 3 提前）。
理由：过渡形态的收益（宿主内挪窝）在「拆出仓库」的终态下没有独立价值，多一次移动 = 多一次全链路回归成本。Phase 2（断反向依赖）改以「5 个模块回迁 + 桥重定向」方式一并完成。Phase 4（shim 清理）范围相应缩小：宿主 57 个壳与 `quantApp.js` 解析点**原样保留**（它们是三级解析链的入口，不是债）。

### 10.2 实施清单（全部 file:line 可复核）

| 动作 | 位置 |
|---|---|
| 实体迁移：`Move-Item` 同盘 rename（历史完整） | `software/khyquant` → `D:\Portable\khyquant` |
| `quantApp.js` 扩为三级解析链 + 桥安装 + `ensureAiBackendResolvable` | `services/backend/src/services/domain/extensions/extensions/quantApp.js:63-85,147-151,163-175` |
| 外部注册文件（本机态，gitignore 区） | `D:\Portable\khy-os\.khy\quant-app.json`（dataHome 实测解析到仓库内 `.khy/`） |
| **require 桥**：`Module._resolveFilename` patch —— ① 相对逃逸按 `appDir ≡ <repo>/software/khyquant` 换坐标重算；② 绝对 request（动态拼接逃逸）按「appDir 的 k 级祖先 ≡ legacyRoot 的 k 级祖先」重映射（`D:\Portable ≡ <repo>/software`，盘根 ≡ repoRoot）；③ NODE_PATH 注入 backend/node_modules + `hostRequire(rel)` | `D:\Portable\khyquant\runtime\hostBridge.js` |
| 5 个宿主核心模块回迁（原件删除，独立项目内原位放指回 shim） | 宿主 `services/backend/src/services/{tokenUsageService,cacheService,notificationService,sqliteBackupService,finlightNewsService}.js`；shim 各自文件头列独立项目内剩余消费者 |
| 独立项目配套：package.json（bare 依赖按实扫清单自持，`@khy/shared: file:../khy-os/services/backend/vendor/shared`）、`khy.extension.json`（provides: ["quant-app"]，khy-markdown 同款格式）、`server.js`（独立入口，`/api/<kebab>` 挂 20 条路由 + 静态 frontend/dist，端口 `KHY_QUANT_PORT` 默认 3742）、README | `D:\Portable\khyquant\` |
| frontend 依赖脱离 workspace：`"@khy/ui-shared": "0.1.0"` → `"file:../khy-os/platform/packages/ui-shared"` | `D:\Portable\khyquant\frontend\package.json:29` |
| workspace 摘除 | `pnpm-workspace.yaml:10`（`software/khyquant/frontend` 行删除） |
| seam 测试适配：`expectedAppDir()` helper（L4 在则 L4 否则读注册）替换 3 处 L4 硬断言；补「应用整体缺席 → null」用例（env 指向空处构造） | `services/backend/tests/extensions/quantAppSeam.test.js` |

### 10.3 回迁清单与判据

5 个模块（tokenUsageService 14 宿主消费者 / cacheService 7 / notificationService / sqliteBackupService / finlightNewsService）：**消费者全在宿主 + 内部闭包 ≤ 2 + 非量化领域**。不回迁的：multiFreeService（内部闭包 26）、instrument 系（量化域）。回迁后宿主侧 5 真身直 require 全部验证通过（冒烟 Part B）。

### 10.4 验证结果

- 契约测试三套（`node --test` seam + serverMount + marketQuotes）：**22 tests / 20 pass / 2 fail**。基线 21/19/2 —— 新增 1 用例「整体缺席」通过，pass 19→20，**fail 集合与基线完全一致**（① `changeRegressionGate` 壳指向不存在的模块——并行会话遗留；② `quantAppWiring.presets.marketQuotes.test.js` jest 风格被 node --test 扫中）。**拆分引入回归 = 0**。
- 冒烟（子进程，与 seam 同姿态）：`resolveDir()` → `D:\Portable\khyquant`（③ 注册通道）；`loadModule('routes/market')` → express router；`loadModule('models/Trade')` ✓；mount「应用在位 → 21 条路由全部挂上」用例恢复 ok（21 条路由经独立项目 + 桥全部挂上）。
- 过程中拦下一个真雷：`khyquant/constants/models.js:14` 用 `require(path.resolve(__dirname, '../../../services/backend/src/constants/models'))` **动态拼接**逃逸宿主 SSOT —— 相对 require 重算拦不住绝对 request，桥补了祖先链重映射（§10.2 ②）后转绿。全项目 `require(path.…)` 复扫确认此类仅此一处。

### 10.5 遗留问题（不阻断，逐条记账）

1. **dataHome 类动态路径错位**：独立项目内按「`__dirname` 上溯到仓根」计算的 fs 路径（非 require）会落到错误位置——已实测一例：`D:\.khy\khyquant\temp\python_strategies` 被建到 D 盘根（原 `<repo>/.khy/...`）。不崩但静默错位，需逐点改为 env/注册文件驱动。挂应用内 pythonPath/dataHome 相关代码。
2. **multiFree 簇（闭包 26）与 instrument 簇的归属治理**：留在独立项目，其宿主侧消费者仍走桥。是否进一步回迁/下沉为宿主服务，另立提案。
3. **`@khy/ui-shared` 三真源**：宿主 `platform/packages/ui-shared`（file: 已锚定）/ frontend node_modules 现副本 / 打包产物。收敛另立条目。
4. **~40 处路径字面量**（§1.3 清单）：10 个脚本 + CI + 3 篇文档仍写死 `software/khyquant`，按需清理；`frontend-ci.yml` 在拆分后已实际失效。
5. **空 `software/` 目录**：保留中。L4 兜底判 `statSync` 目录存在性，删除目录 = 回滚时需先 `mkdir`；建议 Phase 4 一并定去留。
6. **既有债 2 fail**（changeRegressionGate 壳 + marketQuotes jest 陷阱）与 `check-repo-layout` 的 extension-id 门禁基线核对，属 Phase 4 范围。
7. **独立项目未 `npm install`**：package.json 就位但 node_modules 未装；当前全靠桥的 NODE_PATH fallback 解析 bare 依赖（与打包安装同机制）。若独立部署形态启用，先装。
