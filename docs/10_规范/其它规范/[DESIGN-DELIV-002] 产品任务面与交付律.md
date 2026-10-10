<!-- RULES-REGISTRY: PROCESS-014 -->

# [DESIGN-DELIV-002] 产品任务面与交付律

> 文档编号（非规则 ID）：`[DESIGN-DELIV-002]`
> 落点：`docs/10_规范/其它规范/`
> 孪生件：`[DESIGN-DELIV-002] 产品任务面与交付律.html`（由 `scripts/docs/build_docs_site.js` 生成）
> 制定日期：2026-09-24
> 规则：`PROCESS-014 可交付性基线`（执行器 `scripts/ci/check-delivery-baseline.js`）
> 上游：[`[DESIGN-DELIV-001] 可交付性判断标准`](%5BDESIGN-DELIV-001%5D%20可交付性判断标准.md)（定义"能不能交出去"，D1–D10）
> 互补：`[DESIGN-ARCH-073]`（任务怎么跑）、`[DESIGN-PROCESS-002]`（新机制怎么升阶）

---

## §0 本文补的是哪一半

交付这件事有两个问题，本仓此前只答了一半：

| 问题 | 谁能回答 | 状态 |
|---|---|---|
| **能不能交出去** | `[DESIGN-DELIV-001]` 的 D1–D10 | 已定义，**未执行** |
| **交付的是哪些任务** | **本文** | 此前无人回答 |

`[DESIGN-DELIV-001]` §5.1 的诊断是：**"治理全部指向内部一致性，没有一条指向外部可交付性"**。
本文承认这条诊断，并补上它没覆盖的一层——**连"产品是哪些任务"都没有被声明过**。
在 245 个命令平权的前提下，"交付"没有宾语，可交付性再高也不知道在交付什么。

本文给出两样东西：

1. **产品任务面**（§1）：一份封闭的、分层的任务清单，附明确的非目标。
2. **交付律**（§2–§3）：可持续的节奏——一条路径、一个周期预算、三只棘轮、一份边界声明。

本文是 `PROCESS-014` 的语义真源之一，也是该规则**阈值与任务面的单一真源**（§4 的 JSON 块）。

---

## §1 产品任务面（封闭清单）

### 1.1 划分判据

按**用户拿到的结果**分族，不按命令数、不按代码量、不按 handler 文件数。
判据三条，自上而下：

1. 用户**直接收到**它的产出（答案 / 改好的文件 / 一条消息 / 一个回测结果）；
2. 它的失败**用户能感知**（而不是只有维护者能感知）；
3. 它**出现在文档教用户用的路径**里。

三条全中 → 产品面；只中第 3 条的（如 `publish`）→ 维护者面；三条都不中的 → 非目标。

### 1.2 T0 —— 核心任务（唯一 P0）

> **把一件事交给它，它做完，并诚实告诉你做完了没有。**

这是唯一"必须支持"的任务。其余三族存在的理由，都只是"让 T0 可行"。

- 入口：`khy`（REPL 交互）/ `khy -p "任务"`（headless 一次性）/ `khy resume <taskId>`（断点续跑）
- 契约真源：`[DESIGN-ARCH-073] khyos 核心任务循环 — 稳定交付总纲`
- 不变式：登记必达 / 终态必达 / **诚实收尾** / 有界续跑 / 证据门 / 台账必记

**T0 的验收不是"命令返回 0"，是"台账里有这一条，且缺口如实写在台账里"。**

### 1.3 T1 —— 让 T0 可行的四件事（四个任务族）

| 族 | 用户拿到的结果 | 收敛后的命令面 |
|---|---|---|
| **接上通道** | 有一个能用的模型在回话 | `gateway` `model` `proxy` `pool` `channels` |
| **记得住上下文** | 它知道上次干到哪 | `session` `history` `memory` `compact` |
| **有工具可用** | 它真能动手改东西 | 文件 / 命令 / 搜索 / 浏览器 / MCP / skill |
| **诚实收尾** | 它不谎报完成 | 交付门 + 验证代理 + `deliveries` + `receipts` |

四个族**各自是任务**，不是一个功能清单。一个周期只硬化其中**一个**（§2.2）。

### 1.4 T2 —— 垂直应用（独立项目 khyquant 接入，不是基座）

khyquant 量化交易终端：`quote` `data` `backtest` `market` `watch` `account` `position`。
它装在基座之上（`[DESIGN-LAY-005]` 的 L4），**不应与基座命令共享同一张 help 菜单**。

划定边界的现实理由（实测）：`backtest` 族在 2743 个测试文件里只有 4–5 个，
`account`/`position`/`order` 中 `order` 是**预览占位**（无真实下单）。
把它当"基座能力"宣传，会让用户以为这是一个可交易的终端。

### 1.5 T3 —— 交付通道（装得上、升得动）

**仅三条**，且每条都必须有一条端到端验证过的路径（§3）：

| 渠道 | 清单 | CI |
|---|---|---|
| PyPI（`pip install khy-os`） | `pyproject.toml` | ✓ `dual-channel-release.yml` |
| npm（`@khy-os/khy-os`） | `packaging/npm/package.json` | ✓ `dual-channel-release.yml` |
| Docker（GHCR） | `Dockerfile` / `docker-compose.yml` | ✓ `docker.yml` |

### 1.6 非目标（冻结，不再扩）

**约 75 个维护者命令**：`publish` `repo` `forge` `pr` `mr` `ci` `review` `evolve` `deps`
`workflow` `bridge` `ide` `remotedev` `remote` `metadata` `maintain` `heal` `selfHeal`
`toolcheck` `toollist` `capabilities` `state` `trace` `replay` `traffic` `monitor` `debug`
`heapdump` `break-cache` `statusline` `cleanup` `clean` `cleandisk` `storage` `portable`
`cross` `uninstall` `mod署名`…

它们服务的是**仓库自己**，不是用户。当前它们和产品命令挤在同一张 help、同一份
**591 条别名表**、同一个斜杠菜单里——**这就是"功能堆砌"感的来源**：
用户看到的 245 个命令里，属于他的只有约 70 个。

**冻结语义**：不是"删除"，是"不再增加，且不再配面向用户的手册"。
删除走 `RUNTIME-009`（删除先报部位）+ `LAYOUT-004`（只隔离不删除）。

---

## §2 交付律

一句话：**一进一出** —— 每交付一个任务族，就必须退役一份治理负担。
"可持续"的全部含义在此：交付速度的上限不是"写第 1 处的难度"，
是"同步剩下 N−1 处的难度"（`[DESIGN-ARCH-127]` 公理 1）。

### 2.1 地基（一次做完，之后所有周期才有意义）

按 `[DESIGN-DELIV-001]` §5 的 1/2/3，判据文档已写好：

| 序 | 动作 | 判据 | 验收 |
|---|---|---|---|
| 1 | 修仓库完整性 | D1 | `git fsck` 的 missing blob/tree/commit、broken link、cache-tree 计数全 0；`git log --all` 退出码 0 |
| 2 | 补件与收口 | D3 | `git status --porcelain` 的 `??` = 0 且 `D` = 0 |
| 3 | 产出一次发布物并留盘 | D2 | `dist/` 内 wheel + sdist + npm tarball 均存在且非零字节 |

**在这三件之前，任何关于交付的讨论都建在流沙上。**

### 2.2 周期预算：一个周期硬化一个任务族

- 一个周期 = 从 §1.3 挑**一个**任务族，做**端到端硬化**：
  干净环境跑通 + 该族测试补全 + 文档更新 + `khy deliveries` 有真实记录。
- **周期内禁止净新增命令**。要加，先下线一条（§2.3 棘轮 1）。
- 周期的验收物不是代码行数，是**记分板上有格子动了**：
  D1–D10 记分板、任务面棘轮、交付台账三处至少动一处。

### 2.3 三只棘轮（把"堆砌"变成单调递减）

| # | 棘轮 | 基线（2026-09-24 实测） | 规则 |
|---|---|---|---|
| 1 | CLI 命令 / 别名 / handler | 245 命令 / 591 别名 / 155 handler | **只降不升** |
| 2 | 规则条目 | 94 条（含本条） | **不许净增**：新增一条先退役一条 |
| 3 | 逐命令手册 | `OPS-MAN` 209 篇 | 不再手写；不在 T0–T3 内的命令不配手册 |

**复用既有机制，不新建**：`scripts/ci/ruleguard-baseline.json` + `check:debt-ledger`
已有"measured → target 单调改善、逾期留 `slipped` 痕迹"的语义。
本律的棘轮 1 由 `scripts/ci/check-delivery-baseline.js` 承担（§4 的 JSON 块是基线真源）。

> ⚠ **本文自身的张力必须写明**：`PROCESS-014` 本身就是"净增的第 94 条规则"。
> 它被判为可接受，理由是它是**第一条指向外部的规则**——
> 93 条守"仓库内部自洽"，它是第 1 条守"陌生人能不能用上"。
> 棘轮 2 从本条之后开始生效：下一条新规则必须伴随一条退役。

### 2.4 阈值外部化（防空转断言）

`[DESIGN-DELIV-001]` §4.2 的三条硬要求，本文全部继承：

1. **结构化输出**：`--json` 可被测试消费；判读一律认 `counts`，不认人读文案；
2. **反向验证**：每个检查项必须有 fixture 让它在违规时**真变红**；
3. **阈值外部化**：阈值来自 §4 的 JSON 块，**不得硬编码在检查器内部**。

理由是本仓已有两次前科：`check-zcode-baseline.js` 打印 `PASS 7` 却自述"恒返回 0"，
`source-hygiene-scan.js` 自述 `ALWAYS exits 0`。**一个恒真的断言与没有断言等价。**

---

## §3 边界声明（D10）

> 本节即 `[DESIGN-DELIV-001]` D10 要求的"边界文档"，含**不支持清单**。
> 宣布不做什么，是"高效"的第一步。

### 3.1 支持的平台矩阵

| OS × 架构 | Python 层 | Node 后端 | Docker |
|---|---|---|---|
| Windows x64 | ✓ | ✓ | ✓（WSL2 / Docker Desktop） |
| Linux x64 (glibc) | ✓ | ✓ | ✓ |
| macOS arm64 | ✓ | ✓ | ✓ |
| macOS x64 | ✓ | ✓ | ✓ |
| Linux arm64 | ⚠ 未在 CI 覆盖 | ⚠ 未在 CI 覆盖 | ⚠ 未在 CI 覆盖 |
| Windows arm64 | ✗ **不支持** | ✗ **不支持** | ✗ **不支持** |

### 3.2 明确不支持清单

- ✗ **Windows arm64**：无 CI 矩阵、无原生依赖预编译产物，直说不支持。
- ✗ **免 Node 安装**：pip/npm 渠道在 build 期已内嵌 bundled 运行时，
  但本仓**不发布**每平台独立二进制 tarball（opencode 式的 `postinstall` 选型未做）。
- ✗ **包管理器生态**：Homebrew / Scoop / AUR / Nix —— **一个字都没有**，不承诺。
- ✗ **`order` 真实下单**：khyquant 的下单是预览占位（§1.4），不是可交易的终端。
- ✗ **`khy-dual-channel` 以外的渠道**：Electron 桌面、Android APK、NSIS 安装器、
  便携版四条**有代码、有构建脚本，但没有 CI workflow**，一律标为
  **实验性、不承诺交付**。要进 T3，先补 CI 与端到端验证。

### 3.3 降级策略

| 情况 | 行为 | 不做什么 |
|---|---|---|
| 无可用模型通道 | `gateway` 明确报"无可用通道"并给修复命令（`RUNTIME-005`） | 不静默回退到某内置免费通道 |
| 端口被占 | dev server 自动探测下一个可用端口并把实际端口传播给消费者 | 不以 `EADDRINUSE` 崩溃 |
| 无 Node | pip 渠道报缺少 bundled 运行时的**具体文件路径** | 不装作能跑 |
| 网络不可达 | 模型调用报可诊断错误（`RUNTIME-002` §2.2 错误消息具体化） | 不吞失败、不返回空壳成功 |

---

## §4 阈值与任务面真源（机器可读）

> 本块是 `PROCESS-014` 执行器读取的**唯一阈值来源**。
> 检查器**不得**在内部硬编码这些数字；读取失败必须报 finding（删除本块不能静默关掉守卫）。

```json
{
  "$schema": "khy-delivery-surface/1",
  "updated": "2026-09-24",
  "note": "PROCESS-014 阈值与任务面单一真源。执行器 scripts/ci/check-delivery-baseline.js 只读、只记为 基线；任何数字的变更都在本块进行。",
  "taskFacing": {
    "T0": ["khy", "resume", "deliveries", "receipts"],
    "T1": ["gateway", "model", "proxy", "pool", "channels", "session", "history", "memory", "compact"],
    "T2": ["quote", "data", "backtest", "market", "watch", "account", "position"],
    "T3": ["publish-pypi", "publish-npm", "docker"]
  },
  "ratchet": {
    "note": "只降不升。实测值 > 基线值即 finding delivery-surface-ratchet-breach。基线只在退役命令后下调，且必须用与 baseline.method 相同的口径重测——口径变则基线同时失效。",
    "routerCommands": { "baseline": 245, "method": "正则捕获 services/backend/src/constants/commandSchema.js 的 ROUTER_COMMANDS 数组项数", "source": "services/backend/src/constants/commandSchema.js" },
    "aliasEntries": { "baseline": 591, "method": "计数 services/backend/src/cli/aliases.js 中 `command:` 键的出现次数", "source": "services/backend/src/cli/aliases.js" },
    "handlerFiles": { "baseline": 155, "method": "计数 services/backend/src/cli/handlers/ 下 .js 文件数", "source": "services/backend/src/cli/handlers/" },
    "ruleCount": { "baseline": 94, "method": "计数 RULES-REGISTRY.json 的 rules 数组长度", "source": "docs/10_规范/registry/RULES-REGISTRY.json" }
  },
  "thresholds": {
    "s1MaxDays": 90,
    "note": "发布相关机制停在 S1/S2 的容忍天数（D8）。逾期即 GAP——防的是「登记了观察期却从不结算」的墓碑化。"
  },
  "channels": {
    "note": "T3 交付通道。ciWorkflow 为 null 即「有代码无 CI」⇒ 必须出现在 §3.2 不支持清单里。",
    "pypi": { "manifest": "pyproject.toml", "ciWorkflow": ".github/workflows/dual-channel-release.yml", "goldenPath": "pip install khy-os && khy doctor --check" },
    "npm": { "manifest": "packaging/npm/package.json", "ciWorkflow": ".github/workflows/dual-channel-release.yml", "goldenPath": "npm i -g @khy-os/khy-os && khy doctor --check" },
    "docker": { "manifest": "docker-compose.yml", "ciWorkflow": ".github/workflows/docker.yml", "goldenPath": "docker compose up -d --build" },
    "electron": { "manifest": "electron/main.js", "ciWorkflow": null },
    "android": { "manifest": "apps/khy-os-client-app/pubspec.yaml", "ciWorkflow": null },
    "nsis": { "manifest": "packaging/installer/khyos_setup.nsi", "ciWorkflow": null },
    "portable": { "manifest": "packaging/modules/modules.json", "ciWorkflow": ".github/workflows/build-executables.yml" }
  },
  "boundaryDoc": {
    "docPath": "docs/10_规范/其它规范/[DESIGN-DELIV-002] 产品任务面与交付律.md",
    "sectionAnchor": "§3 边界声明",
    "requiresUnsupportedList": true
  },
  "artifactRoot": { "path": "dist", "requiredFiles": ["wheel", "sdist"] }
}
```

---

## §5 度量与接线

### 5.1 记分板

`npm run check:delivery` 打印 D1–D10 记分板（格式对齐 `check-zcode-baseline.js`）：

```
== 可交付性记分板（PROCESS-014 / [DESIGN-DELIV-001] D1–D10）==
阶段: S1(观察者)   根: <repoRoot>
[D1 GAP] 仓库完整性        期望 fsck error=0 · log --all=0 · 实测 ...
[D2 GAP] 发布物存在        期望 dist/ 含 wheel+sdist · 实测 dist/ 不存在
...
[D7 PASS] 债务可收敛
[TS GAP] 任务面棘轮        实测 245 / 基线 245
Summary: PASS n · PARTIAL n · GAP n · 阶段 S1 只记录不阻断
```

### 5.2 阶段与升阶（PROCESS-008）

本机制按 `PROCESS-006` PP-1 登记为 **S1 观察者**：`gate=commit`（会跑）
+ `severity=advisory`（只记录不阻断），执行器 `STAGE` 常量恒 `exit 0`。
阶段登记在 `FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms[]`（id=`delivery-baseline-guard`）。

> **`[DESIGN-DELIV-001]` §4.3 的例外主张未被自动采纳。** 该文主张 D1/D4/D7
> 因引用权威外部判定（`git fsck` / 文本事实 / 既有棘轮）可直进 S3。
> 该主张**需要一次人的裁决**（PP-6 是人的决定），本文不代为豁免。
> 在裁决之前，本机制一律按 S1 记录，**不得**因"看起来是外部判定"而自行阻断。

**升阶动作**（人的决定，非脚本的决定）：改执行器 `STAGE` 常量为 `S3` +
登记表 `severity` 同步，`releaseGateStages.js` 中本阶段 `tier` 由
`recommended` 改为 `must`。回退动作：把两处常量改回（纯配置，PP-4 合规）。

### 5.3 反例（本规则要挡的东西）

```
✗ 新增第 246 个命令，且未退役任何命令      → delivery-surface-ratchet-breach
✗ 把 §4 的 JSON 块删掉"以让检查通过"        → delivery-thresholds-missing
✗ 有构建脚本但没有 CI workflow 的渠道       → delivery-channel-no-ci
✗ 边界文档删掉"不支持清单"                   → delivery-boundary-no-unsupported-list
✗ 记分板恒返回 0（空转断言）                 → 由 §6 的反向验证测试挡
```

---

## §6 实施顺序（三件事）

若只能做三件，按此顺序：

1. **产出一次 `dist/`**（D2）——没有产物，其余讨论都是空的；
2. **落地 `check-delivery-baseline.js`，并实测"关掉它会变红"**（D1/D4/D7）；
3. **冻结命令面棘轮 + 一个周期只硬化一个任务族**。

---

## §7 与既有真源的关系

| 本文说的 | 真源在哪 | 本文的角色 |
|---|---|---|
| 任务怎么跑（登记→执行→裁决→交付→台账） | `[DESIGN-ARCH-073]` | 不重复，只引用 |
| 可交付性的 D1–D10 判据 | `[DESIGN-DELIV-001]` | 继承并给出机器可读阈值块 |
| 新机制怎么升阶 | `[DESIGN-PROCESS-002]` / `PROCESS-008` | 遵守，不豁免 |
| 层级与依赖方向 | `[DESIGN-LAY-005]` | 遵守（本文落 10_规范） |
| 发布流程与触发 | `[DESIGN-SEMVER-002]` / `PROCESS-005` | 不触碰 |

本文**不替代**上述任何一份。它新增的只有两样：**任务面的封闭清单**与**交付律**。

---

## §8 版本记录

- 1.0.0 (2026-09-24) 初版。回应"仓库功能堆砌、交付才是最重要的"：
  补上从未有人回答的"需要支持哪些任务"（§1），并给出可持续交付律（§2–§3）。
  规则 `PROCESS-014` 执行器 `scripts/ci/check-delivery-baseline.js`，按 `PROCESS-008` 定 S1。
  编号说明：主 PROCESS 序列为 001–011 / 013，本条顺延为 **014**；
  101/102 是另一支「决策 / 提案权」系列，未并入。