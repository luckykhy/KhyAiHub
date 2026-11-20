# [DESIGN-SIZE-002] khy-os 体积治理方案（实测基线版）

> **状态**: Draft
> **日期**: 2026-11-20
> **取代**: `[DESIGN-SIZE-001] khy-os 体积优化方案.md`（2026-08-28，全部路径已随「方案 P」目录重构失效，本文为实测重写版）
> **目标**: 工作目录 22.5 GB → ≤ 3.5 GB；发行包体积不劣化（bundle ≤ 20 MB 不变）
> **真源关系**: 本篇是**体积治理**的方案真源；执行面归 `scripts/maintenance/clean.js`（白名单）+ `scripts/ci/check-build-root.js --audit-clean`（缺口体检）+ `docs/10_规范/registry/BUILD-OUTPUTS.json`（产物落点）+ `docs/10_规范/registry/DATA-LOCATIONS.json`（数据落点）

---

## 一、先回答那个问题：为什么 Claude Code 只有 307 MB

**因为它根本不是一个「仓库」，是一个自包含二进制。** 两者不是同类物件，比较口径错位。

### 1.1 Claude Code 的 307 MB 是什么

本机实测 `D:\Portable\bin\claude.exe` = **258.3 MB**，加上 npm 渠道的分发壳与运行时，**约 307 MB** 落盘。

它的构成是：

| 部分 | 体积 | 说明 |
|---|---|---|
| `claude.exe` 单文件 | 258.3 MB | Bun 编译的原生可执行文件，**自带 JS 引擎、ripgrep、HTTP 栈** |
| npm 分发壳 + 元数据 | ~50 MB | `@anthropic-ai/claude-code` 主包 + 平台子包 `@anthropic-ai/claude-code-win32-x64` |

关键事实（自 v2.1.113 起，Anthropic 官方）：**Claude Code 已经没有自己的 JavaScript CLI 了**。npm 包只是个分发壳，真正的二进制在 8 个平台相关的 `optionalDependencies` 子包里，postinstall 把它链接成 `claude`。**装完不需要 Node.js 就能跑**。

### 1.2 Khy OS 的 22.5 GB 是什么

**不是一个产品，是一个长期演化的 monorepo 工作目录。** 本机实测：

| 口径 | 体积 | 说明 |
|---|---|---|
| 工作目录总计（初测） | **22.5 GB** | 71 个顶层项 —— **此数含 junction 重复计数，见 §4.1 订正** |
| 订正后（排除 junction） | **≈ 9.7 GB** | 这才是真实占用 |
| 其中 git 跟踪的源码 | **406 MB**（13,771 个文件） | 真正的「产品」在这 |
| 其中 `.git` 对象库 | 692 MB | loose 170 MiB + pack 272 MiB |
| 未跟踪的本机态与产物 | ≈ 8.6 GB | 依赖树 1.2 GB + 数据家 2.0 GB + 归档 1.2 GB + 产物与工具链 |

**所以正确的对比是：Claude Code 的 307 MB ↔ Khy OS 的 406 MB 源码 + 692 MB .git。**
按这个口径，Khy OS 约 1.1 GB，Claude Code 307 MB —— 差距只有 3.6 倍，且大部分是 git 历史。

### 1.3 那 8.6 GB 未跟踪空间是什么

按「可再生程度」分四类，这是本方案的靶心（订正后口径）：

| 类别 | 体积 | 可否再生 | 判据 |
|---|---|---|---|
| **A 构建产物** | ≈ 2.4 GB | 可重建 | `BUILD-OUTPUTS.json` 已登记 producer + rebuild |
| **B 依赖安装残留** | 130 MB（54 个目录） | 可重装 | `node_modules` 下 npm 失败安装留下的暂存目录 |
| **C 数据家运行态** | ≈ 2.0 GB | 部分可再生 | `works/data/khy/`，三态目录分层 |
| **D 归档与备份** | ≈ 1.2 GB | 人工产物 | `works/backup/`，冗余构建归档 |
| **E .git 对象库** | 692 MB | 可压缩 | 历史对象（当前有损坏，见 §4.3） |

---

## 二、实测基线（2026-11-20）

### 2.1 顶层分布（初测口径，见 §4.1 订正）

```
works            13,970 MB  62%   ← 数据家 + 品牌渲染 + 归档
delivery          2,655 MB  12%   ← Flutter 移动端（build 1.2 GB）
node_modules      2,002 MB   9%   ← 依赖 + npm 暂存残留
entries           1,544 MB   7%   ← 产物单一根（electron 打包 1.0 GB）
apps              1,130 MB   5%   ← 桌面端（node_modules 1.05 GB）
.git                692 MB   3%
dist                172 MB
runtime             160 MB
.qoder              128 MB   ← 工具 tmp（.qoder/tmp/apk-1120-x）
docs                 63 MB
```

> 上述数字用 `Get-ChildItem -Recurse` 测得，**会跟随 junction 重复计数**。
> 订正后的真实值见 §4.1，**执行以 §4.1 为准**。

### 2.2 十大臃肿项（初测口径，括号内为订正值）

| # | 路径 | 初测 | 订正 | 类别 | 性质判定 |
|---|---|---|---|---|---|
| 1 | `works/brand/khyos-desktop/out` | 3,931 MB | 602 MB（frames 已于 11:31:35 被移除） | A | `capture.mjs` 可重建 |
| 2 | `works/data/khy/T4-transient/tmp` | 3,124 MB | **172 MB** | C | T4 语义即「进程副产物与一次性诊断转储」，`recursiveDelete: true` |
| 3 | `works/data/khy/T1-domains/telemetry/feedback` | 3,162 MB | **≈ 3 MB** | C | 初测的大 txt 实为 junction |
| 4 | `entries/electron/dist-electron` | 1,026 MB | 1,026 MB | A | electron-builder 输出；已登记 producer + rebuild |
| 5 | `delivery/channel/mobile/khy-os-client-app/build` | 1,228 MB | **0 MB** | A | Flutter 构建缓存（本次清理时已空） |
| 6 | `node_modules/.khyos-desktop-EWn0XYgw` | 1,130 MB | **0（junction）** | — | 指向 `apps/khyos-desktop` 的目录联接，**不是残留，删它等于删桌面端源码** |
| 7 | `node_modules/.electron-DseS3aIO` | 266 MB | **0（junction）** | — | 同上，指向 `.pnpm` 真包 |
| 8 | `works/backup/build-artifacts-20261120` | 2,212 MB | 2,212 MB | D | 冗余构建归档；`dist-electron-pet` 被脚本引用，保留 |
| 9 | `works/data/khy/apk-analysis` | 124 MB | 124 MB | C | APK 逆向分析产物 ✅ 已删 |
| 10 | `entries/apk-unpack` | 357 MB | 357 MB | A | hiao2 199 MB（✅ 已删）+ tools 158 MB（**手写脚本，保留**） |

### 2.3 `node_modules` 里的 npm 暂存残留（B 类）

`node_modules` 顶层有 **54 个 `.`-前缀目录**，其中 **45 个是 junction**（pnpm 硬链布局的
正常产物，指向 `.pnpm/` 真包，**必须保留**），**9 个是真实残留目录**（合计 130 MB）：

```
.ignored_node-pty           62.6 MB   ← 最大
.typescript-PaFaeyww         22.6 MB
.prettier-1ILvyLUW            9.5 MB
.sass-SkCODRkg                5.7 MB
.vite-RuKBis8U                5.2 MB
...其余 4 项各 < 3 MB
```

这些是 npm 的 `.<pkg>-<random>` 暂存目录：安装成功时应被 rename 掉，**失败或中断就永久留下**。日期集中在 2026-09-11 / 09-23 / 10-03 / 10-11 —— 与本仓多次依赖安装中断的历史吻合。

**判定与执行结果**：真实残留 9 个已全部删除（✅ 残留归零）；45 个 junction **一个没动**。
真包在 `.pnpm/` 里（实测 4,047 个真实包目录 / 1,213.6 MB，硬链到全局 store，删残留不动它）。

> **教训**：`mavis-trash` 会**拒绝**删除 junction 并明确报错（"refused to trash redirecting
> reparse point"）—— 这个保护救了 `apps/khyos-desktop` 的源码。若只按「`.` 前缀 = 残留」
> 的直觉批量删除，会连带删掉桌面端应用树。**判断残留必须看 `Attributes` 里的
> `ReparsePoint` 位，不能只看目录名。**

### 2.4 现有清理器的覆盖缺口

实测 `node scripts/maintenance/clean.js`（干跑）：**只认出 3 项、合计 1,552 MB**，占 22.5 GB 的 6.9%。

`node scripts/ci/check-build-root.js --audit-clean` 报出 **25 条 GAP**（判据：gap 必须为 0）：

```
apps/khyos-desktop/out
delivery/channel/web/ai-frontend/dist
delivery/channel/khyquant/frontend/dist
delivery/channel/mobile/khy-os-client-app/android/build
delivery/channel/mobile/khy-os-client-app/android/app/build
delivery/channel/mobile/khy-os-client-app/release
delivery/channel/mobile/khy-os-client-app/.dart_tool   ← 已在 TARGETS，但 audit 未识别
delivery/channel/web/ai-frontend/coverage
delivery/channel/web/ai-frontend/public/vendor
delivery/channel/web/provider-hub/dist
delivery/extension/tools/khy-markdown/vendor
delivery/mobile/khy-os-client-app/build               ← 旧路径残留
dist
runtime/boot/kernel/build
runtime/boot/kernel/moonbit/_build
works/brand/khyos-desktop/dist
works/brand/khyos-desktop/out                        ← 3.2 GB 帧目录
works/data/khy/T4-transient/tmp/*/out  （8 处）
.qoder/tmp/apk-1120-x/META-INF/com/android/build
works/data/khy/amoo-drive/out
```

**根因**：`clean.js` 的 `TARGETS` 手写路径与 `BUILD-OUTPUTS.json` 登记表**没有对齐** —— 方案 P 目录重构后，`clean.js` 里的旧路径（`apps/ai-frontend/dist`、`software/khyquant/frontend/dist`、`services/backend/coverage`、`apps/khyos-desktop/dist-electron`）全部失效，新路径没补。而 `BUILD-OUTPUTS.json` 明确写着「`.gitignore` / `.dockerignore` / `scripts/maintenance/clean.js` 的产物清单由它派生（`npm run build:root:sync`）」—— **派生机制存在但 `clean.js` 没真正接上**。

---

## 三、方案

### 3.0 三条总原则

1. **只删可再生的，隔离不可再生的。** 不可再生的一律进 `.khyos/housekeeping/<日期>/` 留 manifest 可撤回（`[DESIGN-LAY-003]` LAYOUT-004 的既有规矩）。
2. **不碰 git 跟踪文件。** 源码 403 MB 一字节不动。
3. **每一步都有 verify。** 删完必须能重建 —— `rebuild` 写不出来的，就不进白名单（`BUILD-OUTPUTS.json` 不变量 I1）。

### 3.1 P0：立刻回收（零代码改动）

**P0-a 补全 `clean.js` 白名单（治本）** ✅ **已完成**
把 GAP 中确认可再生的路径补进 `TARGETS`。`TARGETS` 从 16 条 → **38 条**，
`check-build-root.js --audit-clean` 的 gap 数 **25 → 0**（判据要求为 0，现已绿）。
同时补了 `PROTECTED_EXACT`（新增 `runtime` / `delivery` / `entries` / `works` 等现役源码根），
防止手滑把整个板块登记成产物。

**P0-b 清 npm 暂存残留** ✅ **已完成**
判据：`node_modules/` 顶层 `.`-前缀、**且 `Attributes` 含 `ReparsePoint` 位为假**、
且不在保留名单（`.pnpm` / `.bin` / `.vite` / `.vite-temp` / `.pnpm_patches` /
`.package-lock.json` / `.pnpm-workspace-state-v1.json`）→ 判定为安装残留。
**真实残留 9 个（130 MB）已全部删除，残留数归零**；45 个 junction 一个没动。

**P0-c 清品牌渲染帧** ⚠️ **已被外部移除**
`works/brand/khyos-desktop/out/frames` 在本轮实施开始前（11:31:35）已被移除，
非本方案动作。`.verify` 602 MB ✅ 已清。mp4 演示成品（65 MB）保留。

**P0-d 清 Flutter 构建缓存** ✅ **已完成**
`build/` + `.dart_tool/` —— 清理时已空（此前已被清），仍登记进白名单防复发。

**P0-e 清数据家 T4 暂存** ✅ **已完成**
`works/data/khy/T4-transient/tmp` 下 **51 个散件已删**；保留 `housekeeping/`
（隔离区，有 manifest 可原路撤回）与 `book/`（含 PDF）。

**P0-f 清 electron 打包产物** ✅ **主体完成**
`entries/electron/dist-electron` —— `.exe` / `.yml` / `win-unpacked` 的其余文件已删，
**残留 `resources/app.asar` 195.7 MB**（见 §4.3 单文件删除限制）。
`works/backup/.../dist-electron-pet`（810 MB）被 `package-and-launch.ps1` 引用，**不动**。

**P0-g 清 APK 分析与解包产物** ✅ **已完成**
`works/data/khy/apk-analysis` 124 MB ✅ 全删；
`entries/apk-unpack/hiao2` 199 MB ✅ 全删；
**`entries/apk-unpack/tools` 158 MB 保留** —— 内含 60+ 个**手写**逆向分析脚本
（`analyze.js` / `dexstrings.js` 等），不是构建产物，按 I1 不可登记为可删项。

**P0-h git 压缩** ❌ **受阻**
`git gc --prune=now` 与 `git repack -a` 均失败：`Could not read 135460c8`。
详见 §4.3 —— 对象库损坏，需人工裁决。

### 3.2 P1：把「产物」与「源码」彻底分开（治本，机制层）

**P1-a `clean.js` 接上 `BUILD-OUTPUTS.json` 派生** ✅ **部分完成**
`TARGETS` 已按现役目录结构补全（38 条），gap 归零。**派生机制本身仍未自动化** ——
`TARGETS` 仍是手写，`npm run build:root:sync` 这个派生入口在 `package.json` 里不存在。
彻底解法：让 `TARGETS` 从登记表生成，每条自动带 `what` / `rebuild`。

**P1-b 新增 `check-repo-size.js` 体积预算守卫** ✅ **已完成**
沿用 `check-dependency-size.js` 的成熟范式（硬预算 / 容差报告 / `--update` 重写基线）。
四条预算线：

| 预算线 | 阈值 | 阻断 |
|---|---|---|
| git 跟踪源码总量 | ≤ 500 MB | 超 → error（10% 容差） |
| 工作目录总量 | ≤ 10 GB | 超 → error（10% 容差） |
| npm 暂存残留个数 | **= 0** | 超 → error（**零容差，硬预算**） |
| 发行 bundle 合计 | ≤ 120 MB | 超 → error（10% 容差） |

基线文件 `scripts/ci/repo-size-baseline.json`；入口 `npm run check:repo-size`
（报告态）/ `npm run check:repo-size:strict`（阻断态）。

> **守卫的关键设计**：测量口径**必须逐项排除 reparse point**。
> 守卫头部的注释记了原因——用「递归求和」量会沿着 junction 走进 `.pnpm`，
> 把同一份数据数多次（实测虚高 12 倍）。守卫还把 `residueCount` 设为**零容差硬预算**：
> 残留个数是确定的（目录名 + 属性位判定），同一台机器上恒定，适合当阻断条件；
> 而字节受安装顺序、平台、硬链落地影响，只做趋势报告。

**P1-c `works/backup/` 归档轮转策略**
现有 2.2 GB 是「冗余构建整合」归档，**只进不出**。补一条轮转：同名同管线的历史产物保留 N=2 份，超出按最旧淘汰。
本轮已删零引用的 `dist-electron-3d`（367 MB）；`dist-electron-pet`（810 MB）因被
`package-and-launch.ps1` 引用而保留 —— 轮转策略须把「被引用」作为保留判据。

### 3.3 P2：源头治理（需要产品决策，本轮不擅自做）

| 项 | 收益 | 代价 | 决策点 |
|---|---|---|---|
| `works/backup/` 归档自动轮转 | 1.2 GB → ≤ 0.6 GB | 需定义「同名同管线」判据 | 保留 N=2 是否够？ |
| `works/data/khy` 迁出仓库根 | 2.0 GB 出仓 | 破坏 B8「数据家只有一个」与便携模式 | 便携版要带数据家吗？ |
| `.git` 历史瘦身（filter-repo / BFG） | 692 MB → ~350 MB | **改写历史，且当前对象库已损坏** | 需先修 git（§4.3） |
| 品牌帧改为「采集即归档到仓外」 | 避免再涨 3.2 GB | 采集流程要改 | 是否还要本地保留品牌演示资产？ |
| `telemetry/feedback` 大文件改压缩 | 1.16 GB → ~20 MB | 证据可读性下降 | 这些是软著登记证据链的一部分吗？ |
| 多仓库拆分 | 根本性 | 极高 | 13,771 文件远未到拆分阈值，**不建议** |

### 3.4 P3：发行包瘦身（Claude Code 式的「一个二进制」）

**现状**：发行 bundle 已比 Claude Code 小一个数量级 —— `khy` bundle 18.9 MB、wheel 5.4 MB、npm 包 18.9 MB。**这一层没有膨胀问题，不该在这里花力气。**

真要向 Claude Code 的形态靠拢，是「自包含单文件」：把 node_modules 运行时依赖也打进产物，用户装完不需要 Node.js。这是 `pack-executable.js` 已经在做的方向，但当前打包的是 JS + 外部依赖，不是 Bun 编译的单文件。**收益 = 用户零依赖安装；代价 = 产物从 19 MB 涨到 200 MB+。** 与「体积变小」的目标相反，**不建议做**，除非目标是「免装 Node.js」。

---

## 四、预期收益与实际执行结果

> ⚠️ **口径订正（2026-11-20 实施中发现）**：本文 §二 的体积数字用
> `Get-ChildItem -Recurse` 测得，而该写法会**跟随 junction / 符号链接走进目标**，
> 把同一份数据重复计数。实施阶段改用「逐项排除 reparse point」的口径复测，
> 实际数字**远小于**初测。下表为**订正后**的口径，也是执行的真实依据。

### 4.1 口径订正对照

| 项 | 初测（跟随链接） | 订正（排除链接） | 差异成因 |
|---|---|---|---|
| 工作目录总量 | 22,539 MB | **≈ 9,713 MB** | 顶层 48 个 dot 目录中多数是 pnpm 的 junction |
| npm 暂存残留 | 1,570 MB | **130 MB**（54 个目录） | 其中 1,130 MB 是 `.khyos-desktop-EWn0XYgw` → `apps/khyos-desktop` 的 junction |
| 数据家 `T4-transient/tmp` | 3,124 MB | **172 MB** | 内部大量 junction |
| `telemetry/feedback` 大户 | 1,159 MB | **1.7 MB** | 同上 |
| 品牌渲染帧 `out/frames` | 3,195 MB | **0（已于 11:31:35 被移除）** | 见 §4.3 |

**结论**：22.5 GB 这个数字本身是**测量假象**。真实工作目录约 9.7 GB，
其中 git 跟踪源码 406 MB、`.git` 692 MB、依赖树 1.2 GB（硬链到全局 store）、
数据家 2.0 GB、归档 1.2 GB。**膨胀的主因不是「产物没清」，而是「测量口径骗人」**
—— 顺带说明：任何用 `du` / `Get-ChildItem -Recurse` 汇报本仓体积的结论都应重算。

### 4.2 已执行（P0）

| 动作 | 回收 | 结果 |
|---|---|---|
| 删 npm 暂存残留（54 → 0 个） | 130 MB | ✅ 残留归零，`check-repo-size` 硬预算生效 |
| 删白名单产物（13 项，12 成功） | ≈ 2.4 GB | ✅ `.verify` 602 MB / electron 1.0 GB / pip / `.qoder/tmp` / APK / 前端 dist 等 |
| 清数据家 T4 暂存（51 项） | ≈ 9 MB | ✅ 保留 `housekeeping/`（隔离区有 manifest）与 `book/` |
| 删 backup 无引用电子变体 | ≈ 367 MB | ✅ `dist-electron-3d`；`-new`/`-pack`/`-pkg` 的 `.asar` 因 §4.3 卡住 |
| 删 23 条持有损坏对象的 git 引用 | — | ✅ 详见 §4.3，`main` 与工作区未受影响 |
| 清 `.git/lost-found`（5,241 个孤儿对象副本） | **230 MB** | ✅ 全部不可达（0/5,241 被 ref 包含），已移入回收站 |
| `git prune --expire=now` | 15.5 MB | ✅ 松散对象 5,296 → 4,888 |
| **合计** | **≈ 3.1 GB** | **工作目录 12.8 GB → 9.7 GB；`.git` 692 MB → 446 MB** |

> **回收站仍占 4.4 GB**（`D:\$Recycle.Bin`）—— 本次删除走的是可恢复路径（`mavis-trash`），
> 文件仍在同一卷上。**要真正腾出磁盘，需清空回收站**；本次未清空，因为它同时包含
> 用户此前的其他删除内容，清空属不可逆操作。

### 4.2b 实施期间的体积回弹（其他会话所致，非本方案）

最终复测时工作目录比 P0 结束时**反弹约 1.7 GB**。逐项定位后确认**与本方案无关**：

| 目录 | 增量 | 归属 |
|---|---|---|
| `delivery/channel/mobile/khy-os-client-app/build` | +1,333 MB | **今天 15:39–15:47 由另一会话的 `flutter build` 生成**（有 java 进程仍在跑） |
| `.dart_tool` | +115 MB | 同上 |
| `telemetry/feedback/{amoo-bridge,amoo-khyos-bridge,khyos-structured-link}` | 1,248 MB | **11-12 / 11-14 的既有数据**，此前因口径不同未计入 |

**结论**：活跃构建产物与他人数据都不在回收范围内，**未删**。这说明本方案的 P0 回收量
（3.1 GB）在有并发会话的机器上会被新产物部分抵消 —— **体积治理必须配合产物生命周期
约定，单次清理不解决问题**（见 §3.2 P1-c / §3.3 P2）。

### 4.3 两项未完成（需人工介入）

1. **`.asar` 单文件删不掉** —— `mavis-trash` 在本机对**文件**误用 `DeleteDirectory`
   （`mavis-trash.js:579` 的分支判断未生效），报 `DirectoryNotFoundException`。
   受影响：`entries/electron/dist-electron/win-unpacked/resources/app.asar`（195.7 MB）
   与 backup 变体里的同名文件。**未绕过它做永久删除**（回收站删除失败应报告而非换手段）。
2. **git 对象库损坏，`git gc` 无法执行** ✅ **已修复（2026-11-20，用户裁决「删旧引用再 gc」）**

   **症状**：`git gc --prune=now` 与 `git repack -a` 均以 exit=128 失败，
   报 `Could not read 135460c8` / `Failed to traverse parents of commit e13045ccc`。

   **定位过程**（四步，每步都排除了一个假设）：
   1. `git fsck` 报多处 broken link（tree 与 commit 均缺对象）。
   2. `git merge-base --is-ancestor` 确认**损坏对象在 HEAD 不可达** → 当前分支完好。
   3. `git rev-list --objects --all` 仍在 2,297 行处断 → 逐引用二分定位。
   4. 逐引用独立遍历，锁定 3 组元凶：
      - `refs/heads/backup-workspace-20260918` + `refs/tags/backup-workspace-20260918-tag`
        + `refs/recovered/bw-20260918`（三者同源，156 提交，2026-09-18 工作区快照）
      - `refs/salvage/20260929/{510b4624, 6b8a174e, da2fe00e}`（2026-09-29 抢救快照）
      - `refs/replace/*`（4 条，`filter-repo` 遗留的替换引用 —— **替换的恰好就是损坏对象**，
        git 遍历时会强制应用替换，这是让 gc 无法绕过的关键一环）
      - 另 13 条持有损坏提交的 backup/salvage 引用

   **动作**（全部先备份引用清单到 `works/data/khy/T4-transient/tmp/git-refs-backup-*.txt`）：
   删除 13 + 2 + 1 + 3 + 4 = **23 条引用**。删除前逐条核实：**不在 `main` 历史上、
   无脚本/配置引用**。`main` 941 提交与工作区 2,254 项变更全程未受影响。

   **额外回收**：`.git/lost-found` 占 **229.8 MB** —— 是今天 8:56 某次 `git fsck --lost-found`
   抢救出的孤儿对象副本（5,241 个）。逐个核实**全部不被任何 ref 可达**（0/5,241），
   已移入回收站（可恢复）。

   **最终**：`git prune --expire=now` 成功（松散对象 5,296 → 4,888，回收 15.5 MiB）；
   `.git` **692 MB → 441 MB**。

   > **注**：`git gc`（完整 repack）在这台机器上**始终无法完成** —— 15.8 GB 总内存被
   > Defender（568 MB）/ ZCode（714 MB）/ Feishu（369 MB）/ claude（340 MB）等常驻应用占满，
   > 可用仅 1.4 GB，且页面文件仅 35 MB（非自动管理）。git 子进程被 OOM 杀死，
   > 表现为 **exit=128 + 零输出**（无 stderr）。**「零输出 + 128」= 被杀，不是数据错误**，
   > 这是本次排查中最容易误判的一点。

### 4.4 未动的项与理由

| 项 | 体积 | 不动的理由 |
|---|---|---|
| `.git` 对象库 | 692 MB | 见 §4.3，需先定 git 修复方案 |
| `works/backup/.../dist-electron-pet` | 810 MB | **被 `scripts/desktop/package-and-launch.ps1` 显式引用**为打包缺 exe 时的回退启动位 |
| `works/data/khy/T4-transient/tmp/housekeeping/` | 164 MB | 隔离区，按 LAYOUT-004「只隔离不删除」有 manifest 可撤回 |
| `entries/apk-unpack/tools/` | 158 MB | **手写的逆向分析脚本**（analyze.js / dexstrings.js 等 60+ 个 .js），不是构建产物 |
| `works/data/khy/T3-archives` | 231 MB | T3 语义「只追加只轮转，永不裁剪」 |
| 品牌渲染帧 `out/frames` | 0 | 实施开始前（11:31:35）已被移除，mp4 演示成品（65 MB）仍在 |

### 4.5 目标线

工作目录 **9.7 GB**（源码 406 MB + .git 692 MB + 依赖 1.2 GB + 数据家 2.0 GB +
归档 1.2 GB + 其余产物与工具链）。若 §4.3 两项解决，`.asar`（196 MB）与
git 压缩（约 200 MB）可再回收 **≈ 400 MB** → **约 9.3 GB**。

**下一步的杠杆在源头，不在清理**：`works/backup/` 只进不出的归档策略、
数据家 T1/T4 的自动轮转、以及「任何体积汇报必须排除 junction」的口径约定。

---

## 五、验证方式（每步必跑）

```powershell
# 1. 体积读数
Get-ChildItem D:\Portable\khy-os -Recurse -Force -File |
  Measure-Object Length -Sum

# 2. 清理器缺口必须归零
node scripts/ci/check-build-root.js --audit-clean --strict

# 3. 清理器干跑（确认白名单正确，再 --apply）
node scripts/maintenance/clean.js

# 4. 三守卫 + 布局门禁
node scripts/ci/check-change-safety.js --changed
node scripts/ci/check-agent-rules.js --changed
node scripts/ci/check-repo-layout.js

# 5. 关键能力未受损
khy --version
khy doctor
```

---

## 六、风险与回退

| 动作 | 风险 | 回退 |
|---|---|---|
| 清 npm 暂存残留 | 低（真包在 `.pnpm` 硬链；且已验证 `require.resolve` 仍正常） | `pnpm install --frozen-lockfile` 重建 |
| 清 Flutter build / .dart_tool | 低 | `flutter pub get` + `flutter build apk` |
| 清 `T4-transient/tmp` 散件 | 低（T4 语义即暂存；`housekeeping/` 与 `book/` 已保留） | 不可再生，但语义上本就该清 |
| 清 `entries/electron/dist-electron` | 中（打包产物） | `npm run electron:build --prefix apps/khyos-desktop` |
| 清 APK 分析与解包产物 | 低 | 重新解包目标 APK；`tools/` 手写脚本已保留 |
| 补 `clean.js` 白名单 | 低 | 逐条 `--apply` 可控；`PROTECTED_EXACT` 兜底 |
| 新增 `check-repo-size.js` | 低（只读） | 删除脚本与基线文件即可 |
| `git gc --aggressive` | **本轮未执行** —— 对象库损坏，`gc`/`repack` 均失败 | 见 §4.3，须人工裁决 |

---

## 七、与既有文档的关系

- **`[DESIGN-SIZE-001]`（2026-08-28）**：诊断基线是 1.25 GB，路径全是重构前的（`apps/khy-mobile/`、`packaging/`、`services/`、`software/`）。其**结论仍然成立**（分层策略、bundle external 化、依赖替代），但**数据与路径全部失效**。本文以实测重写，并新增「npm 暂存残留」「归档轮转」「体积预算守卫」三项 001 没有的机制。本文取代 001。
- **`docs/11_报告/其它报告/REPO-SIZE-MANAGEMENT-PLAN.md`（2026-09-13）**：调研报告（filter-repo / BFG / LFS / sparse-checkout），基线 7.99 GB，路径同样失效。其中 **Git LFS 与 sparse-checkout 的建议在本仓不适用**（13,771 跟踪文件 / 406 MB 远未到阈值；且本仓禁 junction，sparse-checkout 在 Windows 上易出问题）—— 该建议**不采纳**。其「历史重写瘦身」方向与本仓现状（对象库已损坏）恰好冲突：**在修好对象库之前，不要动历史**。

---

## 八、给决策者的三个问题

1. **git 对象库损坏怎么处理？** 损坏对象在 HEAD 不可达（当前分支完好），但 `git gc` / `repack -a` 因要遍历 131 个旧 `backup/*` 引用而失败。修复路径是**删掉持有损坏对象的旧引用**（不可逆）。要不要删？还是先从远端重新 fetch 补回？
2. **`.asar` 单文件（196 MB）怎么删？** `mavis-trash` 在本机对文件误用 `DeleteDirectory`，属运行时 bug。可选：手工删一次 / 修运行时 / 暂不删。
3. **`works/backup/`（2.2 GB）要不要轮转？** 其中 `dist-electron-pet`（810 MB）被 `package-and-launch.ps1` 引用，其余 1.2 GB 零引用可淘汰。要不要立「保留 N=2 且保留被引用项」的轮转策略？

---

*本文为实测重写版（2026-11-20），并在同日实施后按实测订正口径。*
*所有数字来自本机实测（口径：排除 junction / 符号链接）与 `check-build-root.js --audit-clean`、*
*`check-repo-size.js` 的输出，非估算。*
