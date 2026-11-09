# dependency — Agent 依赖自愈子系统

D2 业务上下文里的一个功能单元：当一次工具调用因为**本机依赖缺失**而失败时，
不把硬中断抛回用户，而是走「探测缺失 → 询问是否安装 → 隔离执行安装 → 回环重试」的交互式修复。

2026-11-07 起（[DESIGN-ARCH-204]）在同一单元上叠加「开发环境盘点/清单」增量：
语言工具链的全量盘点、版本采集、随身清单导出/导入、manual 条目短路闸——
复用同一套 registry/installRunner 底座，不建第二套探测/安装机器。

11 个源文件，全部有同名同目录的共置测试（`node --test`，188 例 / 0 fail，2026-11-07 复验）。

## 各文件的职责（取自各文件头注释，未做二次概括）

| 文件 | 角色 |
|---|---|
| `index.js` | 单元门面，串起探测 → 询问 → 安装 → 重试；补导出盘点/清单面 |
| `registry.js` | 依赖缺失场景的**单一真源**：每个逻辑依赖收敛为四件事，禁止散落硬编码 |
| `resolver.js` | 依赖探测（含 `probe.bins` 多候选）、回溯辨认与安装计划构建 |
| `installRunner.js` | 隔离执行依赖安装命令 |
| `installLocation.js` | 决定 project 作用域依赖装到哪里（应对 backend 跑在只读目录的形态） |
| `healingLoop.js` | 自愈循环编排（核心流程） |
| `toolchainVersions.js` | 「按客户需求选版本」的工具链版本矩阵，纯叶子：零 IO、确定性、绝不抛 |
| `versionProbe.js` | depId → 已装版本探针（`<bin> --version` + 正则提取），盘点面专用叶子 |
| `inventory.js` | 开发环境盘点：DEV_ENV_CATALOG 三态目录 + scanInventory 全量盘点 + 快照原子写 + assertInstallable 短路闸（单点实现） |
| `manifestIo.js` | 随身清单 buildManifest/previewImport/applyImport；导入文件按不可信输入只取 depId+version 两个 token |
| `installJobs.js` | HTTP 通道内存任务表：单队列顺序执行、无 wall-clock kill、不持久化 |

## 谁在用本单元（非测试消费者，去重 3 个）

- `src/services/dependency/index.js:4` —— D1 侧的历史路径再导出壳（`module.exports = require('../domain/network/dependency')`）。
- `src/services/domain/maintenance/selfHeal/fixActions.js:45` —— D2 内惰性 require，自愈动作面。
- `src/services/domain/project/management/resources/dependencies.resource.js:12-13` —— D2 内，取 `runInstall` 与 `resolver`。

2026-11-07 盘点增量后另有两个消费者：`src/routes/devEnv/index.js`（HTTP 门面）与
`src/cli/handlers/devenv.js`（CLI 门面，经 services/dependency 壳）。

## 出域边（如实登记，不写白名单把它合法化）

- `installLocation.js:32` → `utils/dataHome`（D3，箭头函数内惰性 require，取数据根）。
- `resolver.js:19` → `services/toolError.js`（**D1**）：`DOMAIN-DEPS.json` 里 D2 的 `mayDependOn` 只有 `["D2","D3"]`，
  这条属 `declared_not_enforced` 的 D2→D1，交 `archDebtScan` R1 与 `cross-layer-require` 棘轮管辖。
- `resolver.js:31` → `tools/platformUtils.js`：`src/tools/**` 在 `DOMAIN-DEPS.json` 中**没有域根映射**，
  既不是 D1 也不是 D3。该归属空洞见 `[RESEARCH-018]` C-7 与 `[DESIGN-LAY-008]` §12.43 的 Q4。
- `inventory.js`（getSnapshotPath）→ `utils/dataHome`（D3，惰性 require，取盘点快照落点，与 installLocation 同边）。

## 已知缺陷（共置测试里以 `KNOWN-DEFECT:` 钉住，一律登记不修）

- `registry.js` 的 `getDependency()` 头注释承诺「冻结副本浅引用」，实现既不判 own-property、
  交出的又是真表引用 —— 调用方改写即污染共享真源。
- `resolver.js` 的缺失判定可产生 `{depId: undefined, dependency: Object}` 形态的**假检测**并流入 heal/install。
- `resolver.js:191/196` 的真值门把合法的 `0` / `false` 信号静默当缺失。
- `installRunner.runInstall` 对 `manager:'script'` 无分支强制：registry.js moonbit 条目的
  「永不自动执行官方脚本」只是注释契约、无代码背书（实测 `buildInstallPlan('moonbit')` 返回非空计划
  且 runInstall 只验 command 数组非空即执行）。[DESIGN-ARCH-204] 的 `assertInstallable` 闸因此
  落在 devenv 层（inventory.js）并先于 buildInstallPlan 调用；`inventory.test.js` 以 KNOWN-DEFECT
  断言钉住现状。是否把硬拒下沉到 installRunner/buildInstallPlan 属自愈链行为变更
  （healingLoop 同消费该链），交人工单独裁决。
