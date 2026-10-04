# `domain/maintenance/evoEngine` — 自举创世引擎（需求内源发生 → 沙箱验证 → 受控热载）

> 本 README 是本单元的上下文真源之一。机器可读的契约、扇入与登记缺陷见同目录
> `khy.module.json`（守卫 `npm run check:layout` 的 `functional-unit` 规则要求二者并存）。
> 本单元是**自进化 / 自修复引擎**，目录内含 `hostPatcher.js`（会热补丁源码的执行端）——
> 因此 §4 的测试隔离是本单元的头号注意事项，先读它再读别的。

## 1. 三问（规则 9 / `PROCESS-010`）

| 问 | 答 |
|---|---|
| **谁要的** | 用户。这是一条把「人类提需求 → Agent 实现」替换成运行态自举的闭环（`index.js:5` 明写此意图）；扇入实测 **15 个非测试消费者 / 19 个 require 站点**（quencher 家族 `selfSustainingInfra` / `dataSovereignty` / `envSymbiosis` / `intentArbiter` / `dualTrackForge` 等 12 个 D2，外加 3 个 D1 shim/入口），第一消费族是各 domain 的 quencher（`infraGapQuencher` / `conflictQuencher` / `compatibilityQuencher` / `misjudgmentQuencher`）。 |
| **为什么要这么做** | 这个单元解决的是**痛点无法自我表达**的问题：运行态遭遇阻力（工具失败 / 拦截器误杀 / 压缩丢失 / 上下文熔断）时，没有一层把它「归因 → 铸成严格需求规格 → 影子验证 → 受控热载」，就只能靠人写 Issue。`painPointScanner`+`evoRequirement`+`evoLevels` 把这段收敛成确定性纯函数，`organogenesisSandbox`+`hostPatcher`+`evoTrustBreaker`+`evoLedger` 提供「绝不跳过沙箱 / 绝不改写锁具 / 绝不篡改黑历史」的四道防呆。 |
| **怎么验证** | `node --test services/backend/src/services/domain/maintenance/evoEngine/evoLedger.test.js services/backend/src/services/domain/maintenance/evoEngine/evoLevels.test.js services/backend/src/services/domain/maintenance/evoEngine/evoRequirement.test.js services/backend/src/services/domain/maintenance/evoEngine/evoTrustBreaker.test.js services/backend/src/services/domain/maintenance/evoEngine/frictionBridge.test.js services/backend/src/services/domain/maintenance/evoEngine/hostPatcher.test.js services/backend/src/services/domain/maintenance/evoEngine/index.test.js services/backend/src/services/domain/maintenance/evoEngine/organogenesisSandbox.test.js services/backend/src/services/domain/maintenance/evoEngine/painPointScanner.test.js`（**必须显式列 9 个路径**，本环境给目录会得到假读数）→ **246 例 / 56 套件 / 246 pass / 0 fail / 0 skip**（串行与并行一致，见 §4）。 |

## 2. 契约（改本单元前先读这段）

- **对外面分两层**。聚合面 `index.js` 导出 **10 个键**（`index.test.js:92` 逐字钉死）：
  `SelfBootstrapEngine`（闭环门面）+ 再导出的六个构件类
  `PainPointScanner` / `OrganogenesisSandbox` / `HostPatcher` / `EvoTrustBreaker` +
  两个错误类 `SandboxBypassError` / `ConstitutionViolation` + 三个纯模块命名空间
  `evoRequirement` / `evoLevels` / `evoLedger`。其余 8 个文件各自独立导出（无聚合），键数见 §3 表。
- **三种文件角色，改法不同**。纯叶子（零 IO、确定性、可整包注入）：`evoLevels`（进阶格 + `planL2` 防呆②）、
  `evoRequirement`（`signatureOf`/`forge`/`validate`，ID 由签名稳定派生）、
  `evoTrustBreaker`（纯状态机，持久化交给 engine）。薄 IO / 影子执行：
  `organogenesisSandbox`（只在 `vm` 空上下文里跑，不碰宿主）、
  `hostPatcher`（热载写**进程内 Map 影子注册表**，绝不覆写磁盘核心源文件）、
  `frictionBridge`（运行态抄送观测，落 `observations` 分支）。有状态主体：
  `evoLedger`（**唯一落盘写通道**：`append`→原子写哈希链 JSON）与 `index.js`（编排 + 进程内 collaborator）。
- **信任 / 熔断 / 锁模型**：
  - 「熔断一个分支（fusing a branch）」= `EvoTrustBreaker.recordSandboxResult(id,false)`，同一
    `EvoRequirement.id` 连续 `DEFAULT_BRANCH_FUSE=2` 次沙箱失败 → 该痛点分支进 `_fusedBranches`，
    engine 之后为其直接 `branch-fused` 停止自举，并产 **架构级人类告警**（`evoTrustBreaker.js:97`）。
  - 「锁定引擎（locking the engine / 引擎只读）」= 跨痛点连续 `DEFAULT_ENGINE_FUSE=2` 次失败 →
    `_engineReadOnly=true`（防呆④）。`HostPatcher.applyPatch` 与 `engine.evolve` 都据此拒绝一切热载，
    直到人工复位。
  - 防呆③（锁具不可自改）：`PROTECTED_INVARIANTS`（`evoTrustBreaker.js:22`）是片段匹配表，
    `applyPatch` 同时扫 `patch.target` **与 `patch.code`**，命中即 `ConstitutionViolation`。
  - 防呆⑤（黑历史不可篡改）：`evoLedger` append-only 哈希链，`verify()` 定位首个坏块；无 update/delete API。
- **门控（本单元源文件里出现的全名，非抽样）**：**两个，且都不由本单元读取**。
  `KHY_EVO_ENGINE`（`frictionBridge.js:17` 文档注释；桥自身**不读该 env**，门控由各调用方
  `toolCalling` / `learningImprove` 按统一约定执行）与 `KHY_ATOMIC_FSYNC`（`evoLedger.js:91` **注释**；
  实际 `fsync` 被写死 `true`，**故意不跟随**该全局默认——断电丢最后一条等于丢证据）。
  9 个源文件里 **`process.env.*` 的直接读取数为 0**（`grep` 实测）：真正的 env 依赖是经由
  D3 `utils/dataHome` 的 `getProjectDataDir` 间接解析路径（`KHY_PROJECT_DATA_HOME` 等）。
- **写通道清单（§4 的对象）**：本单元只有**一条真·落盘写通道** = `evoLedger.append` →
  `utils/atomicWriteJson(file, chain, {mode:0o666, fsync:true})`，落点
  `getProjectDataDir('evo_engine')/ledger.<branch>.json`。它被 `engine._log`（6 个阶段）与
  `frictionBridge.observeFailure`（`observations` 分支）触发。其余「写」都是**进程内**：
  `HostPatcher.registry`（一个 Map）、`EvoTrustBreaker` 的 Set/Map、`frictionBridge._seen`。
  `hostPatcher._compile` 走 `vm`，`organogenesisSandbox` 走 `vm`，均不落盘。

## 3. 实测数字（2026-09-29，全数清点非抽样）

| 文件 | 行(census) | 导出键 | test() | assert 调用点 |
|---|---|---|---|---|
| `evoLedger.js` | 176 | 8 | — | — |
| `evoLevels.js` | 126 | 11 | — | — |
| `evoRequirement.js` | 135 | 4 | — | — |
| `evoTrustBreaker.js` | 167 | 5 | — | — |
| `frictionBridge.js` | 142 | 4 | — | — |
| `hostPatcher.js` | 162 | 3 | — | — |
| `index.js` | 237 | 10 | — | — |
| `organogenesisSandbox.js` | 301 | 6 | — | — |
| `painPointScanner.js` | 158 | 2 | — | — |
| **源合计** | **1604**（`wc -l` 实测 1595，census 每文件 +1） | | | |
| `evoLedger.test.js` | 330 | | 26 | 87 |
| `evoLevels.test.js` | 262 | | 24 | 92 |
| `evoRequirement.test.js` | 318 | | 25 | 88 |
| `evoTrustBreaker.test.js` | 410 | | 30 | 107 |
| `frictionBridge.test.js` | 352 | | 19 | 74 |
| `hostPatcher.test.js` | 415 | | 30 | 100 |
| `index.test.js` | 662 | | 28 | 157 |
| `organogenesisSandbox.test.js` | 546 | | 41 | 127 |
| `painPointScanner.test.js` | 375 | | 23 | 81 |
| **测试合计** | 3670 行 / 9 份 | | 246 例（node:test 计入嵌套）| **913 个 assert 调用点** |
| 扇入（非测试） | 15 文件 / 19 站点：D2 12（quencher 家族）+ D1 3 | | | |
| 出边 | CORE 7 / D3 3 / SAME_UNIT 13 / D2 1；**D2→D1 反向 0、D5 伸手 0、unmapped 0** | | | |
| 本批改动 | **零源文件修改**。只新增 9 份共置测试 + 本 README + `khy.module.json`；`git status` 本目录全 `??`，跑完 repo 全仓 ` M` 计数不变（2194 → 2194） | | | |

## 4. ⚠ 测试隔离与已知警告（跑本目录测试前必读）

**这是本单元的核心注意事项**。它是一个会热补丁源码的自进化引擎，任何测试都不得对仓库产生写入。

- 9 份共置测试**全部**在 `require` 任何模块**之前**，把
  `HOME` / `KHY_DATA_HOME` / `KHY_PROJECT_DATA_HOME` / `XDG_CONFIG_HOME`（Windows 另含 `USERPROFILE`）
  钉到 `fs.mkdtempSync` 一个**全新临时目录**，并在 `after()` 里 `rmSync` 它。`engine` 的写通道
  (`evoLedger.append`) 因 `getProjectDataDir` 读这些 env 而全部落在临时目录内；
  多数测试再注入内存 `ledger` 双（`fakeLedger`），根本不打开真实文件。
  实测跑完 `git status --porcelain -- <本目录>` 仍只有 `??`，**repo 全仓 ` M` 计数不变**。
- **唯一注入缝在 `index.js`**：`opts.ledger` / `opts.sandbox` / `opts.patcher` / `opts.scanner` /
  `opts.breaker` 五个（`index.js:36-44`）。`frictionBridge` **没有** ledger/scanner 注入缝——
  它的模块级 `_getLedger()`/`_getScanner()` 惰性 require 真实件，其写通道的隔离**完全依赖
  调用方在 require 前钉好 env**（登记为 B31-E35）。
- **`evoLedger._dir()` 的兜底是一个洞**：`require('.../utils/dataHome')` 抛错时，落点静默回退到
  `os.tmpdir()/khy-evo-engine`——一个**在所有测试的 mkdtemp 之外、且 `after()` 不会删**的
  机器全局目录（登记为 B31-E36）。正常路径（dataHome 可用）测试是隔离的；此兜底路径不是。
- **B31-E34（本批实测踩到并修正）**：`organogenesisSandbox` 默认是固定 **200ms vm 墙钟**
  （`organogenesisSandbox.js:24`，非活动感知，违反 `RUNTIME-003`）。并行跑（本环境每文件一个子进程 +
  兄弟 agent 抢 CPU）时，连 `x*2` 这种良性器官的编译/执行都可能越过 200ms → 判决翻成 `passed:false` →
  不签 `passToken` → `applyPatch` 抛 `SandboxBypassError` → engine 停在 `sandbox-bypass-blocked` 而非
  `evolved`，把一个**接线/构造断言**因环境负载判红。首轮并行实测 `fail 1~3`，串行 `fail 0`。
  修法：凡「必须走到通过判决」的测试注入 `new OrganogenesisSandbox({ timeoutMs: 20000 })`
  （`index.test.js` 的 `fastSandbox()`、`hostPatcher.test.js` 的 `verdictFor()`、`organogenesisSandbox.test.js`
  良性位点）。**没有弱化任何断言**——`passed`/`evolved`/`passToken` 语义照旧，只是移除了与 CPU 争用的耦合。
  两个故意保留默认 200ms 的点：构造面断言 `timeoutMs === 200`（B31-E3 钉默认值）与
  B31-E3 那条「重活器官必须超时」的用例。修正后 8 次并行 + 强 CPU 负载下**恒 `246/246/0`**。
- **单元外的 `tests/services/evoEngine/frictionBridge.test.js`（属消费方，本批未改）**：node:test 方言、可跑，
  当前 1 个文件级红——根因是**测试结束后仍有异步 logger 写**打开
  `<tmp>/khy-evobridge-test-<pid>/logs/active/*.log`，而该 tmp 已被清，`ENOENT` 触发 `uncaughtException`。
  这是消费方测试自身的收尾缺陷（写通道在临时 HOME 内，不污染跟踪文件），不是本单元源码缺陷，**不据此判红**。
