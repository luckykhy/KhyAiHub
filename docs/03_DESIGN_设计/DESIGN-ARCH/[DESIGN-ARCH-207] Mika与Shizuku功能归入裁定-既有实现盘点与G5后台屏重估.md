<!-- IMPL-STATUS: partial -->
<!-- 文档分类: DESIGN-ARCH-207 | 阶段: 设计 / 提案（先提案后编码，B-P2.1） -->
<!-- 期 1 已落地（2026-11-09，零代码 diff）；期 2 探针为准备态（需真机，§10）；期 3 冻结；期 4 判定「不新增代码」（§11）；收尾复核 Q4/Q9/Q10 见 §12.5（仍零代码 diff）。实施记录见 §12。 -->

# [DESIGN-ARCH-207] Mika / Shizuku 功能归入裁定 —— 既有实现盘点与 G5 后台屏重估

> **状态**：提案已批准（2026-11-09「按照你的建议完成所有内容」）· **期 1 已实施**。期 1 只改两份登记表与一行治理台账，**零代码 diff**；期 2/3/4 的处置见 §4、§10–§12。**本文始终不改任何运行时代码**。
> **范围**：两个 Android 上游项目（Mika、Shizuku）的「功能」如何归入 khy-os；哪些已在仓里、哪些是真实缺口、哪些不能做。
> **上游依赖**：`wangzan101/Mika@v0.1.38`、`RikkaApps/Shizuku@v13.6.0`（元信息经 GitHub API + raw README/LICENSE 实测，见 §1.1）。
> **调研指针**：`[DESIGN-ARCH-056]` 桌面操控、`[DESIGN-ARCH-026]` 系统级服务调用审批网关、`[DESIGN-ARCH-193]` 手机端职责划界、`[DESIGN-ARCH-195]` 手机版插件架构、`[DESIGN-ARCH-196]` 手机侧直连通道、`[DESIGN-ARCH-200]` 对标 stepx（G5 裁决真源）、`[DESIGN-ARCH-206]` 文件管理器基座、`[DESIGN-MEM-009]` §6 既有不做裁决、`[DESIGN-SOURCING-001]` 借鉴规则真源。
> **模板合规**：借鉴类设计，按 B-P2 填 **7 个编号字段**（规则卡名「六字段」，`PROPOSAL-ARTIFACT-INDEX.json` 的 `countDiscrepancy.modeledAs=7` 已显式建模此差异；`check-proposal-index.js:52-71` 亦按 7 项断言）。只写结论与签名级结构描述，不贴上游源码（B-P4）。
> **证据时效**：全部取证于 2026-11-09。上游元信息为本轮联网实取；仓内 `file:line` 为本轮 Read/Grep 实测。**手机端 Android 源码大量为工作区未提交态**（`[DESIGN-ARCH-200] §0.1` 已声明），本文凡转引处均标「转引」。

---

## 0. 一句话结论

**这两个项目的功能不是「缺」，是「已经分两处实现了」**：

- **Shizuku** 的免 root 提权通道，已以 `adapter` 档落在手机端 `ShizukuServiceManager.kt`（直接调官方 `rikka.shizuku.Shizuku` binder），并接进 `Tools.java` 三级提权链与文件管理器 shell 后端。
- **Mika** 的「一句话 → 操作 App/Web 直到完成」GUI Agent 闭环，已落在桌面端 `ComputerUseTool` + `computerUseAgent`（observe→think→act→verify），配 `[DESIGN-ARCH-056]` 的结构化感知与四级授权闸门。

**真正未闭合的只有一项**：Mika 的「hidden background screen（隐藏后台屏，用户主屏不被占）」。它在 `[DESIGN-ARCH-200]` 里叫 **G5**，且已被明确裁决「**不押**（G5 未取证，且 effort 与主线重叠度高）」。

⇒ 所以本提案**不新增任何实现**，只做三件事：①把两个上游补进借鉴溯源链（B-M2，当前缺失）；②用 Mika 这个量产实证重新裁定 G5 值不值得开探针（**重估 ≠ 翻案**）；③按 B-L3 追加式更正 `[DESIGN-MEM-009] §6` 那条「没有等价场景」的**前提**，不动原文结论。

### 0.1 病灶表

| # | 病灶 | 证据 | 性质 |
|---|---|---|---|
| F1 | **借鉴溯源链缺失**：手机端直接 import 上游包，但归属表与来源台账都没有这两条 | `ShizukuServiceManager.kt:6-8` import `rikka.shizuku.Shizuku` / `IShizukuService`；`FEATURE-OWNERSHIP.json` 实测 16 个 capability **无** computer-use / desktop-control / shizuku 域（上一轮误记 17，Q6 已更正）；`SOURCING-PROVENANCE.json:100-211` ledger 无此二项 | B-M2 / B-U1 违规（**已存在，非本提案引入**） |
| F2 | **「没有等价场景」前提已失效** | `[DESIGN-MEM-009]:241` 写「本仓是本地优先的 CLI/服务端形态，没有等价场景」；但 `dist/android/SHA256SUMS.txt:4` 记 `Khy-1.1.17+2-202611090908-8KTSBYDR`（**今天 09:08 构建**），且 193/195/196/200/206 五篇手机端设计为在产 | 决策依据过期（B-L3：只追加，不改写） |
| F3 | **G5 判「不押」时没有 Mika 这个量产反证** | `[DESIGN-ARCH-200]:49`（差距 holds）、`:108-113`（方案 3 裁决「不押」）、`:321`（跨显示可达性需设备） | 需重新裁定，不是自动翻案 |
| F4 | **桌面 CUA 直接占用户当前屏幕** | `computerUseAgent.js:6-11`（截当前屏 + 真实键鼠）、`[DESIGN-ARCH-056]:40-43`（默认 off 的 fail-closed 闸门） | 与 Mika「Leaves your screen alone」的真实差距；但 Windows **无 VirtualDisplay 等价物** |

---

## 1. 现状实证

### 1.1 两个上游的实测元信息（本轮联网取，非记忆）

| 项 | Mika | Shizuku |
|---|---|---|
| 定位 | Android on-device AI agent，自然语言操作 App/Web 直到完成 | 用 `app_process` 起 Java 进程，让普通 App 经 ADB/root 权限直接调系统 API |
| 版本钉子 | `v0.1.38`（2026-11-07 release）；commit `30a9a5173e4590542f4fbd8ff2d49d55364be9cb` | `v13.6.0`（2025-05-25 release）；commit `b844bc491f1790c72328e1a8e5b2349f8978f0ea` |
| 主语言 / 平台 | Kotlin / Android 11+（操控 App 需 12+，**14+ 推荐**，因后台屏有独立焦点） | Kotlin / Android，依赖 Binder + ADB 或 root |
| 许可证 | Apache-2.0（`LICENSE`）+ `NOTICE`（Copyright 2026 wangzan101）+ `THIRD_PARTY_NOTICES.md` | Apache-2.0（`LICENSE`），**附三条 Section 6 额外限制**（见 §2 P-01 第 4 字段） |
| 核实位置 | `README.md:210-212`、`LICENSE`、`NOTICE`；GitHub API `license.spdx_id=Apache-2.0` | `README.md:358-366`、`LICENSE`；GitHub API `license.spdx_id=Apache-2.0` |
| 活跃度 | 7,826 stars，`pushed_at=2026-11-09T07:43:22Z` | 33,205 stars，`pushed_at=2025-06-18T04:21:02Z` |
| 关键机制 | 隐藏后台屏 + 无障碍/截屏 + 无线调试配对；Ask / Autonomous 双模式；任务转 skill | Binder 中转 `transactRemote`；`getUid` / `checkPermission` 前置能力探测；避免逐次 spawn + 文本解析 |
| 两者关系 | **Q4 已核实：不依赖 Shizuku**（§12.5）。上游完整树 2831 条目零 `shizuku` 路径命中、30 份声明/文档（含 `libs.versions.toml` 27 依赖、`AndroidManifest.xml`、中英文 setup-guide 全文）零关键词命中；`docs/setup-guide.en.md:2102` 明写 Mika 借 Android 原生「Wireless debugging」自起内置 helper，Step 4/5 走 6 位配对码、无电脑无数据线 ⇒ 两者是**同一类 ADB 权限面、各自独立实现**；「同属 ADB 权限面」推断成立，「依赖 Shizuku」假设证伪 | — |

### 1.2 功能 → khy-os 落点逐条对照（✓ 已有 / △ 部分 / ✗ 缺）

| Mika 的功能 | khy-os 落点 | 判定 | 证据 |
|---|---|---|---|
| 一句话 → 多步操作直到完成 | `ComputerUseAgent` observe→think→act→verify 循环 | ✓ | `computerUseAgent.js:4-23,36-37`（`DEFAULT_MAX_ITERATIONS=30`）；`ComputerUseTool/index.js:55-65` |
| 看屏幕找按钮，不做 per-app 集成 | `uiInspector` / `elementModel` / `setOfMarks` 结构化元素清单 | ✓ | `[DESIGN-ARCH-056]:28-36,70-85` |
| 操作前确认 / 花钱才问（Ask 模式） | `KHY_DESKTOP_CONTROL` 四级授权光谱 + 按动作风险分级 + `EXEC_APPROVED` 不可伪造戳 | ✓ **更细** | `[DESIGN-ARCH-056]:91-101`；`ComputerUseTool/index.js:38-52,64-65` |
| 内置浏览器 / 任意网页调用 | 桌面 CUA 可操作浏览器；无独立内置浏览器 | △ | `ComputerUseTool/index.js:57-61` |
| 经验沉淀（完成的任务变 skill） | `KHY_COMPUTER_USE_EXPERIENCE` few-shot + `JOURNAL` 轨迹 | △ | `computerUseAgent.js:53-56` |
| 随时打断 / 继续从断点接 | 有 journal 与 notes，未见「continue」语义 | △ | `computerUseAgent.js:61-64` |
| 定时 / 条件触发 | 桌面端有 `schedulerProcess` fork，未见与 CUA 接线 | △ | `apps/khyos-desktop/src/main/index.ts:787` |
| **隐藏后台屏，不占用户主屏** | **无**；桌面截当前屏、键鼠是全局注入；手机端 G5 未落地 | ✗ | `computerUseAgent.js:6-11`；`[DESIGN-ARCH-200]:49,113,300` |

| Shizuku 的功能 | khy-os 落点 | 判定 | 证据 |
|---|---|---|---|
| 一次提权、长驻服务、Binder 中转系统 API | `ShizukuServiceManager` 直连官方 `IShizukuService` stub | ✓ | `ShizukuServiceManager.kt:6-8,26-44,93-98` |
| `checkPermission` / 能力前置探测 | `Shizuku.checkSelfPermission()` + `Status{installed,connected,version,reason}` + `available` 诚实降级 | ✓ | `ShizukuServiceManager.kt:30-44,80-85`；`[DESIGN-ARCH-206]:107,117` |
| 三级降级（sidecar → shizuku → app）且返回值带 `via` | `Tools.java` 三级提权链 | ✓（**转引**） | `[DESIGN-ARCH-200]:54`；`[DESIGN-ARCH-193]:497,545` |
| 结构化 IPC 而非逐次 spawn 解析文本 | 手机端 AIDL 满足；桌面 `backendRegistry` 仍是 `execFile` argv 逐次调用 | △ | `[DESIGN-ARCH-056]:46-49,58` |
| 系统级调用审批 / fail-closed | `SyscallGateway` 意图声明 + 三级审批 + 不可伪造 `EXEC_APPROVED` | ✓ **更严** | `[DESIGN-ARCH-026]:25-27,51-52,68-89` |
| 长驻进程 + IPC（桌面侧同构） | `fork(hostProcess/schedulerProcess, stdio ipc)` | ✓ | `apps/khyos-desktop/src/main/index.ts:759,787` |
| 隐藏 API 绕过 | 桌面无此问题 | 不适用 | — |

### 1.3 四步检索结论（B-U2，写进 B-P2 第 6b）

| 步 | 检索了什么 | 在哪检索 | 结论 |
|---|---|---|---|
| 1 别名 | `computer` / `desktop` / `GUI` / `提权` / `mobile` / `android` / `桌面` / `权限` | `docs/10_规范/registry/FEATURE-OWNERSHIP.json` | 16 个 capability 全枚举（Q6 更正，上一轮误记 17），**无**本能力域；命中均为「权限卡」「canonical-state-snapshot」等无关项 ⇒ **登记缺口** |
| 2 符号 | `runToolUseLoop` / `CUA` / `computerUse` / `cuaPermission` / `execViaShizuku` / `ShizukuServiceManager` / `VirtualDisplay` / `setLaunchDisplayId` | `runtime/node/backend/src`、`apps/khyos-desktop/src`、`delivery/mobile`、`docs/03_DESIGN_设计/DESIGN-ARCH` | 大量命中既有实现（见 §1.2），**不是空白地带** |
| 3 模式 | 未新增实现 ⇒ 不触发模式登记 | `docs/16_设计模式/registry/模式注册表.json` | 本提案**不新增模式名**（B-U4 第 3 条） |
| 4 层级 | 落点全在既有 L 层内，不新建层 | `[DESIGN-LAY-005]` | 扩展既有 canonical，不新增并行实现 |

### 1.4 既有裁决（必须继承，不得悄悄改写）

| 裁决 | 原文 | 本文如何处置 |
|---|---|---|
| G5 方案 3「不押」 | `[DESIGN-ARCH-200]:113`「不押（G5 未取证，且 effort 与主线重叠度高）」；`:321`「a11y 跨显示语义是平台行为，读码读不出来」 | §3 只做**重估**，开不开探针由人拍板（B-L3 追加式） |
| 「不做设备能力面」 | `[DESIGN-MEM-009]:241` 含「无障碍读屏、悬浮窗」，理由「没有等价场景；收益为零」 | **结论保留**（不把短信/通讯录/通知监听做成 LLM 工具）；**前提更正**：今天有活跃 APK 与五篇手机端设计，正确理由是「有场景但按零信任收口，只做执行面不做数据面」 |
| 「零隐式提权」 | `[DESIGN-ARCH-026]:51-52`；`AMOO-INTEGRATION.md §六`「不要走 root」（转引自 `[DESIGN-ARCH-200]:47,121`） | 继承。Shizuku 走 `adapter` 而非 root，正是这条裁决的产物 |

---

## 2. 借鉴提案（B-P2，7 个编号字段）

### 【借鉴提案 P-01】Shizuku 免 root 提权通道的溯源补登与边界确认

1. **借鉴对象**：`RikkaApps/Shizuku@v13.6.0`（release 2025-05-25，commit `b844bc491f1790c72328e1a8e5b2349f8978f0ea`；`master` 分支 `pushed_at 2025-06-18`）。
2. **借鉴内容**：只取「一次提权、长驻服务、按调用方身份鉴权、结构化 IPC 回传、能力前置探测」这一组**协议形态与交互结论**（B-S1 第 1 / 3 类），不取任何代码。
3. **解决的问题**：**不是功能缺口**（§1.2 已证功能在仓里）。真实缺口是 F1 —— 手机端 `ShizukuServiceManager.kt:6-8` 直接依赖上游运行时，但 `FEATURE-OWNERSHIP.json` 无对应能力域、`SOURCING-PROVENANCE.json` ledger 无来源行，违反 B-M2「借鉴必须可追溯」与 B-U1「无登记不新增」。
4. **许可证与代码性质**：Apache-2.0，核实位置 `README.md:358-366` + 仓库 `LICENSE` 原文 + GitHub API `license.spdx_id=Apache-2.0`。**三条 Section 6 额外限制必须同步登记**：禁止使用 `manager/src/main/res/mipmap*/ic_launcher*.png`（除非展示 Shizuku 自身）、禁止以 `Shizuku` 作 app 名、禁止用 `moe.shizuku.privileged.api` 作 applicationId 或声明 `moe.shizuku.manager.permission.*`。按 B-S4 表 Apache-2.0 属 `verbatim` 档，但 **B-S4.1 已知缺口**（`[DESIGN-SOURCING-001]:96-100`「仓库根目录当前没有 LICENSE 文件」）⇒ 本提案不取 `verbatim`，不引入任何上游代码。
5. **借鉴方式**：既有实现是 **`adapter`**（B-M0「不搬代码，只调上游的官方分发版本」，实测 `ShizukuServiceManager.kt:95-98` 走 `Shizuku.getBinder()` + `IShizukuService.Stub.asInterface`，且 `:99-100` 失败返回 null 诚实降级）；**本提案自身是 `idea`**（只补溯源与裁定，零代码）。判定依据：上游有官方 APK 分发 ⇒ B-M1 第 2 条排除 `vendored`；上游在维护 ⇒ B-M3 排除 `fork`；B-S3 红线排除源码入库。B-P3：`adapter`/`idea` 自评 + 任一评审即可，**不需**维护者特批。
6. **落点与现有实现对比**：
   a. **落点**：不新增源码文件。补登落点 = `docs/10_规范/registry/FEATURE-OWNERSHIP.json`（新增 `mobile-privileged-shell` 能力域，`canonical` 指向 `delivery/mobile/khy-os-client-app/android/app/src/main/kotlin/com/khyos/khy_os_client/ShizukuServiceManager.kt`，`method=adapter`，`source` 填本字段 1）+ `docs/10_规范/registry/SOURCING-PROVENANCE.json`（新增一条 `relationship=adapter`、`license=Apache-2.0`、`versionPin=v13.6.0` 的台账行）。**两处均属期 1，本文不改。**
   b. **现有同类实现**：四步检索结论见 §1.3。搜索词 `execViaShizuku` / `ShizukuServiceManager` / `ShizukuBinder` / `shizuku` 在 `delivery/mobile` 命中 `ShizukuServiceManager.kt`（Glob 实证存在）；`docs/03_DESIGN_设计/DESIGN-ARCH` 命中 `[DESIGN-ARCH-193]:351,497,545`、`[DESIGN-ARCH-200]:54,407`、`[DESIGN-ARCH-206]:52,79,107,134,140`。**结论：这是「补登既有 canonical 的溯源」，不是新增并行实现**；按 B-U5，若将来要改提权链，只能在 `ShizukuServiceManager.kt` / `Tools.java` 上扩展。
7. **验收方式**：`node scripts/ci/check-proposal-index.js`、`node scripts/ci/check-provenance.js`、`node scripts/ci/check-license-tiers.js` 三条不新增红；且 `grep -n "RikkaApps/Shizuku" docs/10_规范/registry/{FEATURE-OWNERSHIP,SOURCING-PROVENANCE}.json` 两处各有命中（source 可独立复核）。**怎么算做成了**：溯源链闭合，行为零变化 —— 手机端提权链在补登前后输出逐字节相同。

### 【借鉴提案 P-02】Mika 后台独立屏结论对 G5 的重估（不是移植）

1. **借鉴对象**：`wangzan101/Mika@v0.1.38`（release 2026-11-07，commit `30a9a5173e4590542f4fbd8ff2d49d55364be9cb`；`main` 分支 `pushed_at 2026-11-09`）。
2. **借鉴内容**：只取一条**行为结论** —— 「把 GUI 自动化放到独立显示/独立焦点上执行，用户主屏不被占用，过程可随时查看与接管」（B-S1 第 3 类交互流程）；不取其实现、不取 UI 结构、不取文案。
3. **解决的问题**：F3 + F4。`[DESIGN-ARCH-200]` G5 判定「VirtualDisplay 承载 activity」差距 holds 但**跨显示可达性未取证**，方案 3 被裁「不押」；当时没有「这条路已被量产产品跑通」的外部证据。Mika README `:26,87,155` 给出反证：后台屏是它的**主卖点**，且明确写「Android 14+ 推荐（后台屏有独立焦点，不干扰主屏输入）」。桌面侧 F4 同样成立（`computerUseAgent.js:6-11` 截当前屏 + 全局键鼠注入）。⇒ **要重估的是「值不值得花半天做探针」，不是「直接开工做后台屏」**。
4. **许可证与代码性质**：Apache-2.0，核实位置 `README.md:210-212` + `LICENSE` 原文 + `NOTICE`（`Mika / Copyright 2026 wangzan101`）+ `licenses/THIRD_PARTY_NOTICES.md`；GitHub API `license.spdx_id=Apache-2.0`。**NOTICE 与第三方清单是 Apache-2.0 的归因义务**，若将来走 `verbatim`/`vendored` 必须随附；本提案不引入任何上游文件，故不触发。同样受 B-S4.1 本仓 LICENSE 缺口约束。
5. **借鉴方式**：**`idea`**（B-M0「只取结论，本仓从零实现，不留上游痕迹」）。判定依据：①上游是 Kotlin/Android 工程，与本仓桌面 + Flutter 手机端不同平台，B-S3 禁止源码入库；②上游有官方 APK 分发，B-M1 第 2 条排除 `vendored`；③上游活跃维护中，B-M3 排除 `fork`；④只取结论不碰代码，`reference`/`adapter` 均不适用。B-P3：`idea` 自评 + 任一评审即可。
6. **落点与现有实现对比**：
   a. **落点**：**本期不改代码**。落点是决策记录 —— 本提案 §3 + `.ai/GOVERNANCE-LEDGER.md` 追加一行（B-L3 决策记录位置之一，见 `PROPOSAL-ARTIFACT-INDEX.json:174-179`）。若人批准 G5 探针，代码落点才是 `delivery/mobile/khy-os-client-app/.../KhyAccessibilityService.kt:350-359`（`DEFAULT_DISPLAY` 钉死处，`[DESIGN-ARCH-200]:49` 指认）与 `ScreenCaptureService.kt`（现有 VirtualDisplay 仅 AUTO_MIRROR 抓屏，`:182,185`）。桌面侧落点仅限既有 CUA 展示面（`apps/khyos-desktop/src/renderer/i18n/zh-CN.json` 已有 `chat.toolCall.cua.*` / `cuaPermission.*` 文案族）。
   b. **现有同类实现**：搜索词 `VirtualDisplay` / `setLaunchDisplayId` / `localabstract` / `LocalSocket` / `后台屏` / `独立屏` / `不抢占` / `offscreen` 在 `docs/03_DESIGN_设计/DESIGN-ARCH` 与 `delivery/mobile` 检索。结论：`[DESIGN-ARCH-200]:300` 已做过全树检索 —— `VirtualDisplay` 9 命中**全在** `ScreenCaptureService.kt`，`setLaunchDisplayId` **零命中**；`[DESIGN-ARCH-200]:108-113` 已有方案 3 完整对比与「不押」裁决。**本提案不重写该对比、不新建第二个 GUI Agent canonical**；桌面既有 `ComputerUseAgent`、手机既有 `AmooLoop` + `KhyUi` 均是必须扩展的 canonical（B-U5）。
7. **验收方式**：本期验收 = `node scripts/ci/check-proposal-index.js` 不新增红 + 决策台账出现一行可检索的 G5 重估记录。若人批准进入期 2，**真机探针**给出三选一结论（a11y 跨显示可达 / 不可达 / 需降级），以 `[DESIGN-ARCH-200] §7.3` 列的设备项为判据；**不写「探针已通过」这种话**（该文档 §7.4 已声明探针全部待执行）。**怎么算做成了**：人能凭一条可复核的探针结论决定「押 / 继续不押」，而不是凭上游 star 数拍脑袋。

---

## 3. 目标形态（组件级契约）

三层收敛，**每层独立可回滚**，且前两层零行为改动：

| 层 | 做什么 | 不做什么 | 交付物 |
|---|---|---|---|
| L1 溯源层 | 补登两个上游的 `source` / `versionPin` / `license` / `relationship`；`FEATURE-OWNERSHIP` 补 `mobile-privileged-shell` 与 `desktop-computer-use` 两个能力域 | 不改任何运行时代码；不一次性大补登存量（B-L1 禁止 P3 批量合并） | 2 个 JSON 的增量行 |
| L2 决策层 | 按 B-L3 **追加**一条「G5 重估」决策，保留 `[DESIGN-ARCH-200]:113` 原裁决原文；更正 `[DESIGN-MEM-009]:241` 的**前提**而非结论 | 不改写、不删除任何既有决策文字 | `.ai/GOVERNANCE-LEDGER.md` 一行 + 本提案 |
| L3 执行层 | **仅当人批准**才动：手机端 G5 探针 → 若可达才改 `DEFAULT_DISPLAY` 取屏目标；桌面端只借「过程可观测不干扰」做实时缩略视图 + 一键接管 | 不新建 `MikaAgent` / `MikaTool`；不移植 VirtualDisplay 到 Windows；不改 `ComputerUseAgent` 循环 | 探针报告 / 增量 diff |

**单一真源约束**：提权链只在 `ShizukuServiceManager.kt` + `Tools.java` 扩展；GUI 闭环只在 `ComputerUseAgent` / `AmooLoop` 扩展。任何「新开一条更干净的实现」都按 B-U5.1 判 ERROR。

---

## 4. 实施分期（每期独立可回滚）

| 期 | 内容 | 前置 | 回滚点 | 状态 |
|---|---|---|---|---|
| **0** | 本文落盘（提案 + 裁定），零代码零登记改动 | 无 | 删本文即可 | **本轮完成** |
| **1** | L1 溯源补登（P-01 第 6a 的两处 JSON + 决策台账一行） | 人批准本提案 | 单条 JSON 行 revert | **已完成 2026-11-09**（§12.1 实测） |
| **2** | G5 真机探针 APK：只回答「a11y 跨显示可达吗 / `dispatchGesture` 注入目标 / amoo 特权 activity 能否被拉进虚拟屏」 | 人**显式**批准重估（不因提案通过自动触发） | 探针产物不入库，丢弃即可 | **规格就绪 · 未执行**（§10；需真机，不写「已通过」） |
| **3** | 仅当期 2 结论为「可达」：把 `KhyAccessibilityService.kt:350-359` 的 `Display.DEFAULT_DISPLAY` 改为可传参，配套 `setLaunchDisplayId` | 期 2 可达 | 单文件 revert | **冻结**（前置未满足，本轮不动） |
| **4** | 桌面端「过程可观测不干扰」：复用既有 `chat.toolCall.cua.*` 文案族，加实时缩略视图 + 一键接管 | 期 0 后即可独立立项 | 前端单组件 revert | **判定完成：不新增代码**（§11；上一轮 F4 估计过高，既有能力已覆盖，硬造会撞 B-U5.1） |

期 2/3 的判定门槛照抄 `[DESIGN-ARCH-200] §7.3`：这些是**设备项**，主机侧读码给不出结论，不许写成「已验证」。

---

## 5. 诚实边界（刻意不纳入，逐条给原因）

| 不做什么 | 为什么 |
|---|---|
| 不把 Mika / Shizuku 的 Kotlin 源码或 Android 工程搬进仓 | B-S3 绝对红线；且平台不同（本仓桌面 Electron + 手机 Flutter），搬进来也不能编译 |
| 不新增第二个「特权服务进程」 | 手机端已有官方 Shizuku binder + 三级提权链，桌面已有 `fork(... ipc)`；B-U5.1 禁止「旧实现有 bug 所以新写一个」 |
| 不重写 `ComputerUseAgent` / `AmooLoop` | B-L4 第 3 条「换实现范式重做已有功能」默认不受理；且 §1.2 已证功能齐备 |
| 不把「设备能力面」（短信 / 通讯录 / 通知监听 / 应用使用统计）做成 LLM 工具 | `[DESIGN-MEM-009] §6` 的**结论仍成立**：这类数据面收益为零、合规负担重。本文只更正其「没有等价场景」的**前提** |
| 不改 `[DESIGN-MEM-009]` 与 `[DESIGN-ARCH-200]` 原文一字 | B-L3 决策只追加不改写；悄悄改措辞让旧决策看起来「原本就如此」是明令禁止的 |
| 桌面端不承诺「完全不占屏」 | Windows 没有 Android `VirtualDisplay` 的等价物；`SendInput` 是全局注入，隐藏窗口拿不到定向输入。只能做到「过程可见 + 可随时接管」，不能做到「物理隔离」。写成承诺就是假数据 |
| 不声称 Mika 依赖 Shizuku | **Q4 已证伪**（§12.5）：上游 tree / 30 份声明文档 / `libs.versions.toml` 零命中，Mika 走 Android 原生无线调试自起 helper。两者只**同属 ADB 权限面**、各自独立实现；写成「依赖」会凭空造出一条不存在的溯源关系 |
| 不因本提案通过就自动实施 G5 | `[DESIGN-ARCH-200]:113` 的「不押」是已记录决策；重估只产出「是否值得开探针」的建议，开工需人再拍一次板 |

---

## 6. 反模式（这条路别走 —— 逐条给为什么）

| ❌ 别做 | 为什么 |
|---|---|
| `git clone` 两个仓库进 `vendor/` 或 `third_party/` | B-S3 红线 + B-M1 第 2 条（有官方分发版/包就必须走 `adapter` 或正常依赖，不得为省事 vendored）；且 `fork` 默认禁止（B-M3） |
| 因为上游 star 高（7.8k / 33k）就重写既有 canonical | B-L4 第 4 条「借上游新结构重写本仓同功能模块」默认不受理；§1.2 已证重写等于造第二份 |
| 新建 `MikaAgent` / `MikaTool` / `ShizukuBridgeV2` | B-U3 第 1/2/3 条：输入输出同型、职责动词相同、可互相替换 ⇒ 判定同一功能，必须共用 canonical |
| 把 G5 的「不押」改成「待定」并删掉原句 | B-L3；正确做法是**追加**一条「2026-11-09 因 Mika 量产实证重估，原裁决保留」 |
| 用 `vendored` 档绕过许可证审查 | `[DESIGN-SOURCING-001]:96-100` 登记「仓库根目录无 LICENSE」，`verbatim` 档必须附 khyos 自身许可的书面确认，否则一律降级 `reference`；B-S4.1 无法核实即按最严 `idea` |
| 用 `Shizuku` 作产品名 / 用它的 launcher 图标 / 声明 `moe.shizuku.*` 权限 | 上游 `README.md:362-366` 在 Apache-2.0 Section 6 下**明确 FORBIDDEN**，是许可证条款不是社区惯例 |
| 把「后台屏」照搬到 Windows 桌面 | 无 OS 等价物；硬做会得到「截图是隐藏窗口、键鼠却打到用户屏幕」的错位系统，比现状更危险 |
| 在探针结论出来前先写「VirtualDisplay 方案已可行」 | `[DESIGN-ARCH-200] §7.3/§7.4` 已把这类未实测声明列为必须避免的过度表述 |

---

## 7. 验收方式（可复现命令 + 关联门禁）

**本期（期 0）**，三条守卫本机**实跑**（2026-11-09，`spawnSync` 逐段落盘后读回，非估计）：

| 守卫 | exit | error | warning | 归因 |
|---|---|---|---|---|
| `check-proposal-index.js` | 0 | 0 | 8 | 8 条全是存量：`[DESIGN-ARCH-105]` P-01~P-07 的 `proposal-line-drifted` 7 条（索引登记行号 62/94/139/178/213/243/277，实际 66/98/143/182/217/247/281）+ `mapping-empty` 1 条；**与本提案无关** |
| `check-provenance.js` | 0 | 0 | 0 | 干净 |
| `check-license-tiers.js` | **1** | **2** | 17 | **⚠ 本机本来就是红的，不是本提案引入**：2 条 error 均为 `7zip@1.0.0/7zip-win-x64-a34pt/COPYING` 的 GPL 全文，落在 `khy-Trajectory/T4-transient/tmp/electron-builder-cache/` 与 `works/data/khy/T4-transient/tmp/electron-builder-cache/` 两处缓存；17 条 warning 全是「发布包缺 license 字段」与 `LicenseRef-Source-Available` 需复核的存量 |

⇒ **准确口径是「不新增红」，不是「三条全绿」**。本提案只新增一个 `.md`，不落在 `check-license-tiers` 的 manifest 扫描面内（该守卫自报 `manifests: 37 checked, 15 skipped`），2 条 error 不可能由本文件引起。按 `[DESIGN-SOURCING-001]` 与仓库既有归因纪律（窗口 commit vs 并行车道、A/B 分类）：这是**窗口外的 B 类缓存债**，本期只记录、不修 —— 修它等于清理 `T4-transient/` 缓存，属另一次任务且会动用户数据目录。

```
node scripts/ci/check-proposal-index.js
node scripts/ci/check-provenance.js
node scripts/ci/check-license-tiers.js
```

**关联既有门**（AGENTS.md 工程规则，提交前跑）：`npm run check:agent-rules --changed`、`npm run check:layout`、`npm run check:duplication`、`npm run check:gov-rules`。

**行为零变化判据**：本提案不含代码 diff，故不存在行为回归面；期 1 完成后需证明手机端提权链输出逐字节相同（`via` 字段、`Status.available` 语义不变）。

**关联门禁的诚实限制**：`check-proposal-index.js:146-196` 只校验 `PROPOSAL-ARTIFACT-INDEX.json` 里登记的**那一个 primary 工件**（`[DESIGN-ARCH-105]`），**不会自动扫描本文件**。所以「守卫绿」不等于「本提案 7 字段被机器验过」—— 七字段齐全靠人工按 §2 逐条核对，这一点不许写成「守卫已覆盖」。

---

## 8. 待核实项（按优先级；会动摇前提的当场查清，不留悬念）

| # | 项 | 状态 | 影响 |
|---|---|---|---|
| Q1 | **本轮是否已把「六字段 / 七字段」口径查清** | ✅ **当场查清**：`PROPOSAL-ARTIFACT-INDEX.json:27-31` `countDiscrepancy.modeledAs=7`，`check-proposal-index.js:52-71` 按 7 项断言；规则卡 SOURCING-003 名「六字段」是历史命名。本文按 **7 个编号字段**填齐 | 若按 6 项填会缺第 7 项「验收方式」⇒ 直接违反 B-P2「缺一不落地」 |
| Q2 | **本仓是否有 LICENSE 文件** | ✅ **当场查清**：`[DESIGN-SOURCING-001]:96-100` 明确登记缺失；`SOURCING-PROVENANCE.json:240-242` gap-2 亦记「无 NOTICE / THIRD_PARTY 清单」 | 决定不能走 `verbatim`/`vendored`，已据此把两案都判为 `idea`/`adapter` |
| Q3 | **手机端 Android 源码是否已提交入仓** | ✅ **期 1 开工前当场查清**：`git status --porcelain` 对 `ShizukuServiceManager.kt` / `ComputerUseTool/index.js` / `computerUseAgent.js` 三者全空，`git ls-files` 三者全命中、磁盘均存在（2026-11-09 探针落盘） | **[DESIGN-ARCH-200] §0.1 的「大量未提交态」担忧对本提案的 canonical 不适用**；期 1 登记路径不会指向未跟踪文件，Q3 收口 |
| Q4 | **Mika 是否真的依赖 Shizuku** | ✅ **收尾查清：不依赖**（§12.5.1）。上游 `git/trees/<commit>?recursive=1` 返回 `status=200 / truncated=false / entries=2831`，路径含 `shizuku\|rikka\|moe.shizuku` **零命中**；唯一 `.aar/.jar` 是 `gradle/wrapper/gradle-wrapper.jar`；抓 30 份声明/文档（两份 `build.gradle.kts`、`gradle/libs.versions.toml` 27 依赖、`AndroidManifest.xml`、中英文 setup-guide 全文）`totalHits=0`。`docs/setup-guide.en.md:2102` 原文「borrows Android's built-in "Wireless debugging" to start a small built-in helper」，Step 4/5 为原生 6 位配对码、无电脑无数据线，Step 3 配对后自开无障碍服务 | 结论：两者**同一类 ADB 权限面、各自独立实现**；「同属 ADB 权限面」推断成立，「依赖 Shizuku」假设证伪。§1.1 关系行、§5、§12.4 已同步更正；**溯源链不变**（Mika 仍只作 `idea` 登记，不补依赖行） |
| Q5 | **G5 跨显示可达性** | ⚠ 需真机（`[DESIGN-ARCH-200]:321`） | **期 2 的唯一目的**；不解决就不进期 3，不作为本提案前提 |
| Q6 | **`FEATURE-OWNERSHIP.json` 是否已有同义能力域** | ✅ **读数更正**：上一轮记「17 个 domain」，期 1 用 `JSON.parse` 实测为 **16** 个 capability（`"domain":` 全文计数亦为 16），无命中（§1.3 第 1 步结论不变）；新增两域后为 18，无重名 | 「17」为上一轮误记，已在此更正；期 1 新增两域不与既有域重名，若并行会话期间新增同义域以 B-U3.1 交维护者裁决一次 |
| Q7 | **编号 207 是否空闲** | ✅ 本轮枚举目录 `max=206`、`DESIGN-ARCH-207*` Glob 零命中 | 防并行会话撞号（同 §3 取号纪律） |
| Q8 | **三条守卫是否真的全绿** | ✅ **当场查清**：`check-proposal-index` 0e/8w、`check-provenance` 0e/0w、`check-license-tiers` **1 exit / 2e/17w**（§7 已逐条归因，2 error 为 electron-builder 缓存里的 7zip GPL `COPYING`）。**期 1 落地后复跑读数逐条一致，零新增红**（§12.3） | 若把「守卫绿」写进验收而实际是红，等于给后来者一把错尺；口径为「不新增红 + 存量红归因」；**收尾补充**：`check-proposal-index` 的 B-L3 台账形状检查当前为空转（Q10 / §12.5.3），守卫绿 ≠ 台账被验过 |
| Q9 | **前端 `cua.stop` 是否真接到中断执行链** | ✅ **收尾查清：代码层零消费**（§12.5.2）。`apps/khyos-desktop/src`、`delivery/web`、`delivery` 全目录、`runtime/node/backend/src` 四范围代码文件对 `chat.toolCall` / `toolCall.cua` / `cua.stop` **零命中**；`zh-CN.json` 实测 `chat.toolCall.cua.*` 共 **115** 个 key（上一轮「约 70」为低估）、`cua.stop` 存在；`WebRemoteControlPanel.tsx:9` 注释自述该批组件「一律用中文字面量而非 i18n」；`cua` 命中全在 settings 页（`CuaSettings` / `CUA_GATE_KEYS`）。⇒ **「动态 key 拼接」假设被证伪**（拼接必带前缀字符串） | 只收紧 §11 措辞，**不改「期 4 不新增代码」判定**：后端 `AbortController` 取消链与 settings 四级闸门是实的，前端展示面接线未证实；若确为缺口属独立前端任务，不得借本提案另起组件。边界：本轮只做代码层静态检索，未做运行时追踪 |
| Q10 | **`PROPOSAL-ARTIFACT-INDEX.json:177` 过时指针能否顺手改掉** | ✅ **收尾查清：本轮不改，另案**（§12.5.3）。该指针不是一行文字 —— `.ai/GOVERNANCE-LEDGER` 共 **6 处**引用：`PROPOSAL-ARTIFACT-INDEX.json:177`、`RULES-REGISTRY.json`、`[DESIGN-LAY-008] 目录层级重设计执行路线图.md`、`check-proposal-index.js:18`（硬编码 `DECISION_LEDGER_REL`）、`artifactCheckers.test.js:275-277`（测试 fixture），另加本轮日志。**更要紧的是守卫当前空转**：`check-proposal-index.js:235` `if (!ledger \|\| !exists(DECISION_LEDGER_REL)) return;` 因 `.ai/` 不存在直接 return ⇒ B-L3 台账形状**根本没被机器校验**，期 1 追加那行也没被验 | 只改 JSON ⇒ JSON 说 `works/record/ai/`、守卫仍查 `.ai/`，制造「看起来修好了」的隐形不一致；一起改 ⇒ 需动 2 个 JS（守卫 + 测试），破本提案「零代码 diff」且属「动仪器」。实测若改对守卫：真实台账 3 行日期 `08-17→08-17→11-09` 有序，`ledger-out-of-order=0`，**不会新增红** ⇒ 另案范围与前置已查清，交人拍板 |

---

## 9. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-11-09 | 初版。联网实取两个上游元信息/许可证/README；仓内实证既有实现（§1）；按 B-P2 出 P-01/P-02 两份七字段提案；按 B-L3 追加式提出 G5 重估与 MEM-009 前提更正；明确「不新增实现、不改代码」的边界。零代码 diff。 |
| 2026-11-09 | 期 1 实施：FEATURE-OWNERSHIP 新增 2 域、SOURCING-PROVENANCE 新增 2 条 ledger、治理台账按 B-L3 追加一行；状态行 `todo`→`partial`；更正 Q3/Q6/Q8 读数并新增 Q9；追加 §10 期 2 探针规格（准备态）、§11 期 4 不新增代码判定、§12 实施记录。零代码 diff，三条守卫不新增红。 |
| 2026-11-09 | 收尾复核（Q4/Q9/Q10）：联网取证判「Mika 不依赖 Shizuku」、四目录检索判「`chat.toolCall.cua.*` 115 个文案 key 代码层零消费」、查清过时指针的 6 处引用面与 `check-proposal-index.js` B-L3 台账守卫空转；同步更正 §1.1 关系行、§5、§11 措辞、§12.1 指针说明，顺手把 §0.1 F1 与 §1.3 的「17 个 domain」订正为 16；追加 §12.5 收尾复核记录。**本轮仍零代码 diff，未改任何登记表 / 守卫 / 前端 / 规则真源**。 |

---

## 10. 期 2 探针规格（准备态 · 未执行）

> 本节是**规格**，不是结果。`[DESIGN-ARCH-200] §7.4` 第 3 条已把「真机验证」列为待执行项，本提案不因 Mika 量产实证就跳过设备。
> **触发条件**：人**显式**批准重估后才做；不因本提案被批准而自动触发（§4 期 2 前置）。
> **形态**：一次性探针 APK / adb 脚本，**不改产品代码**，产物不入库、丢弃即可。照抄 `[DESIGN-ARCH-200] §7.2` 的纪律：**每步门槛都是「可判定的观察」，不是「感觉对了」**。

### 10.1 三问与可判定观察

| # | 要回答的问题 | 可判定观察（命令 + 原始输出，缺一不算数） | 现状锚点 |
|---|---|---|---|
| P1 | a11y 在跨显示下可达吗 | 在 `VirtualDisplay` 上起一个带可识别文本的 activity；用 `KhyAccessibilityService` 读 `AccessibilityNodeInfo` 树，**看能否命中该 activity 的节点**（命中 / 只拿到 DEFAULT_DISPLAY 的空树 / 抛异常，三选一落盘） | `KhyAccessibilityService.kt:350-359` 钉死 `Display.DEFAULT_DISPLAY`；`[DESIGN-ARCH-200]:321`「a11y 跨显示语义是平台行为，读码读不出来」 |
| P2 | `dispatchGesture` 注入到哪个 display | 对 P1 的虚拟屏发一次可观察手势（如滑动改变 SeekBar / 点击翻转 TextView），记录 `dispatchGesture` 的 `DisplayId` 参数与**实际生效的 display**；区分「注入被拒」「注入到主屏」「注入到虚拟屏」 | `[DESIGN-ARCH-200]:300` 全树检索：`setLaunchDisplayId` 零命中，现有 VirtualDisplay 9 命中全在 `ScreenCaptureService.kt`（AUTO_MIRROR 抓屏） |
| P3 | 特权 activity 能否被拉进虚拟屏 | 用 `ActivityOptions.setLaunchDisplayId()` 启动目标 activity 到 `VirtualDisplay`，记录是否抛 `SecurityException` / 是否落到 DEFAULT_DISPLAY / 是否成功；**第三方应用无特权时是否为硬失败** | `[DESIGN-ARCH-200]:108-113` 方案 3 对比；`:442`「跨显示可达性未取证；不押工程份量，除非探针反转」 |

### 10.2 设备项（照抄 `[DESIGN-ARCH-200] §7.3`，主机替代不了）

| 项 | 为什么主机给不出 |
|---|---|
| `VirtualDisplay` 跨显示可达性（G5） | a11y 跨显示语义是平台行为，读码读不出来（`:321`） |
| `dumpsys display` / `dumpsys activity` 的 display 归属 | 要装包、要设备（`:317`） |
| 装机后 `dumpsys package` 与权限方向 | 「可见」不等于「bind 得上」（`:319`） |
| logcat 探针标记 | 系统侧 / 助手侧行为，主机无对方（`:318`） |

### 10.3 输出落盘与结论口径

- 探针输出（命令 + 原始输出 + 截图）落 `works/data/khy/feedback/`（B8：临时文件不进仓库根，见 `[DESIGN-ARCH-200]:157`），**不入库**。
- 三问各自给**三选一**：`可达` / `不可达` / `需降级（附降级路径）`；每个结论必须附原始输出，不许写「感觉可行」。
- **总判据**：仅当 P1/P2/P3 **全部**为「可达」才允许进期 3；任一「不可达」⇒ G5 维持「不押」，`[DESIGN-ARCH-200]:113` 原裁决不动；「需降级」⇒ 另出提案，不在本提案内扩展。
- **诚实边界**：本节**不写**「探针已通过」「VirtualDisplay 方案已可行」；`[DESIGN-ARCH-200] §7.4` 已把这类未实测声明列为必须避免的过度表述。Mika 的 star 数与 README 只能作为「值得花半天做探针」的理由，**不是**探针结论。

### 10.4 期 3 的门槛（冻结项，本轮不动）

仅当 §10.3 总判据为「可达」，才允许把 `KhyAccessibilityService.kt:350-359` 的 `Display.DEFAULT_DISPLAY` 改为可传参并配套 `setLaunchDisplayId`；改动必须单文件可 revert，且不新建第二个 GUI Agent canonical（B-U5）。

---

## 11. 期 4 判定 —— 桌面端「过程可观测不干扰」不新增代码

### 11.1 上一轮 F4 估计过高的实测证据

| 要素 | 既有实现 | 证据 |
|---|---|---|
| 逐步动作明细 | `chat.toolCall.cua.*` **115 个 key**（收尾实测；上一轮「约 70」为低估）（`clickElement` / `typeText` / `pressKey` / `scroll` / `performAction` …） | `apps/khyos-desktop/src/renderer/i18n/zh-CN.json:1064-1178`；`.khy/tmp/wrapup-probe-1109.txt` |
| 截图 / 放大预览 | `details.screenshot` / `screenshotCaptured` / `openScreenshot` / `zoomPreview` / `zoomed` | 同上 `:1107,1120-1122,1135-1137` |
| 活跃与权限状态 | `details.active` / `denied` / `granted` / `accessReady` / `accessIncomplete` | 同上 `:1070-1071,1074,1086,1100` |
| 完成 / 失败 / 原因 | `details.completed` / `failed` / `failureReason` / `suggestedAction` | 同上 `:1084,1094-1095,1125` |
| 过程分组统计 | `group.event.*` / `group.message.*` / `group.completedLabel` | 同上 `:1142-1146` |
| 权限引导与就绪 | `chat.cuaPermission.*`（4 条）、`chat.cuaReadiness.*`（2 条） | 同上 `:618-623` |
| **一键中断（文案）** | `chat.toolCall.cua.stop`「停止控制电脑」 | 同上 `:1171` |
| **一键中断（执行链）** | `AbortController` signal 透传 + 每轮 `aborted` 检查 + `stoppedReason:'cancelled'` | `computerUseAgent.js:1381,1510,1533-1540,1712` |
| 授权闸门 | `KHY_DESKTOP_CONTROL` 默认 off 四级、`EXEC_APPROVED` 不可伪造戳 | `[DESIGN-ARCH-056]:40-43,91-101`；`ComputerUseTool/index.js:38-52,64-65` |

⇒ **收尾更正（Q9，§12.5.2）**：「可中断」的**后端能力面**确实具备（`computerUseAgent.js` 的 `AbortController` 链 + settings 四级闸门），但「过程可观测」的**前端展示面接线未证实** —— `chat.toolCall.cua.*` 115 个文案 key 在四目录代码层零消费。F4 把它列作缺口仍属**过高估计**（i18n 文案族与 settings 页都在），但据此说「能力面已经具备」是**过度表述**，应限定为「后端链已具备、前端展示面待接线」。真实差距仍是物理隔离一项；**§11.2 判定不变**。

### 11.2 判定

**期 4 不新增代码**。理由三条：

1. **会造重复组件**：在既有 `chat.toolCall.cua.details.*` 卡片族之外再建「实时缩略视图 + 一键接管」面板，输入输出同型、职责动词相同 ⇒ B-U3 判定同一功能，B-U5.1 判 ERROR。
2. **真差距不是展示面，是物理隔离**：`computerUseAgent.js:6-11` 截当前屏、`SendInput` 全局注入；Windows **没有** Android `VirtualDisplay` 等价物，隐藏窗口拿不到定向输入。写成「完全不占屏」就是假数据（§5 已列）。
3. **前端文案族未被消费，但属独立任务**：Q9 收尾已**证伪**「动态 key 拼接」——`chat.toolCall.cua.*` 115 个 key 在四目录代码层零命中（§12.5.2），「一键接管」按钮当前无静态接线。若确为缺口，应在既有工具调用卡片组件上补一个按钮触发 `AbortController.abort()`，**属独立前端任务**，不得借本提案另起一套组件，也不在本轮「零代码 diff」范围内。**收窄措辞不等于改判定**：B-U5.1 仍禁止另起组件，真差距仍是物理隔离。

### 11.3 反模式

| ❌ 别做 | 为什么 |
|---|---|
| 新建 `CuaLiveView` / `CuaTakeoverPanel` 组件 | B-U5.1；既有卡片族已是 canonical |
| 把 `cua.stop` 文案改成别的名字再并一套 | B-U3「已存在的名称不得被更准确的同义词替换而并存两套」 |
| 承诺 Windows 上「后台屏不占主屏」 | 无 OS 等价物；硬做会得到「截图是隐藏窗口、键鼠却打到用户屏幕」的错位系统（§5、§6） |
| 因 Q9 查清「文案族零消费」就宣布「一键接管不可用」 | 后端取消链实证齐备；Q9 只证伪了静态引用与带前缀拼接，未做运行时追踪，不能据此断言功能不存在 |

---

## 12. 实施记录（2026-11-09）

### 12.1 落地清单（本期实际改动）

| # | 文件 | 改动 | 性质 |
|---|---|---|---|
| 1 | `docs/10_规范/registry/FEATURE-OWNERSHIP.json` | `updated` → `2026-11-09`；新增 `mobile-privileged-shell`（adapter / Adapter / L3）与 `desktop-computer-use`（self-developed / Facade / L2）两个能力域；capabilities 16→18 | 登记补登，零运行时改动 |
| 2 | `docs/10_规范/registry/SOURCING-PROVENANCE.json` | `$updated` → `2026-11-09`；ledger 13→15，新增 Shizuku（adapter / Apache-2.0 / v13.6.0）与 Mika（idea / Apache-2.0 / v0.1.38）两条 | 溯源补登 |
| 3 | `works/record/ai/GOVERNANCE-LEDGER.md` | 按 B-L3 **追加一行** G5 重估决策 | 决策台账，只追加不改写 |
| 4 | 本文 | 状态行 `todo`→`partial`；§4 状态列；§8 Q3/Q6/Q8 更正 + Q9 新增；§10/§11/§12 追加；§9 变更日志追加一行 | 提案实施记录 |

**指针过时说明（收尾已查清，见 §12.5.3 / Q10）**：真实台账路径是 `works/record/ai/GOVERNANCE-LEDGER.md`，**不是** `PROPOSAL-ARTIFACT-INDEX.json:174-179` 与本文 §2 P-02 第 6a 写的 `.ai/GOVERNANCE-LEDGER.md` —— 后者已不存在（AGENTS.md 记载 `.ai/hq/` → `works/record/ai/hq/` 的 W9′ 迁移把 `.ai/` 整个作废）。期 1 按实测路径追加。**本轮收尾查清该指针不是一行文字**：`.ai/GOVERNANCE-LEDGER` 共 6 处引用（5 个仓库文件 + 本轮日志），其中 `check-proposal-index.js:18` 硬编码 `DECISION_LEDGER_REL`、`:235` 因 `.ai/` 不存在直接 early-return ⇒ **B-L3 台账形状守卫当前空转**，`artifactCheckers.test.js:275-277` 的测试 fixture 亦写死旧路径。⇒ **判定：本轮不改**（只改 JSON 会造成 JSON / 守卫不一致；一起改要动 2 个 JS，破「零代码 diff」且属动仪器），另案需连 `RULES-REGISTRY.json`、`[DESIGN-LAY-008]` 一并处置，范围与前置已记在 Q10。

### 12.2 与方案的偏离及原因

| 偏离 | 原因 |
|---|---|
| 治理台账落在 `works/record/ai/`，非 `.ai/` | 实测 `.ai/` 无 ledger，迁移后真身在 `works/record/ai/`（§12.1） |
| `desktop-computer-use` 的 `method` 定为 `self-developed` 而非 `idea` | 桌面 CUA 是本仓自研；标 `idea` 会误述历史并踩 B-L4 第 3 条。Mika 的 `idea` 关系单独登记在 SOURCING-PROVENANCE |
| Mika 台账行的 `localPath` 指向本文（决策文档）而非代码 | `idea` 无代码落点；`check-provenance.js:107` 要求 `localPath` 磁盘存在，指向「未来可能改的文件」会伪造已落地事实 |
| 期 4 不新增代码 | §11 实测既有能力已覆盖，硬造撞 B-U5.1 |
| 期 2 只出规格不跑探针 | 三问全是 `[DESIGN-ARCH-200] §7.3` 设备项，主机给不出结论；§7.4 明令不许写「已验证」 |
| Q6 读数由 17 更正为 16 | `JSON.parse` 与 `"domain":` 计数双证；上一轮为误记 |
| Q3 由「⚠ 未提交态」收口为「✅ 已提交」 | 三个 canonical 的 `git status --porcelain` 全空、`ls-files` 全命中 |

### 12.3 验收实测（2026-11-09，落盘探针复跑，非估计）

| 检查 | 期 0 基线 | 期 1 后 | 判定 |
|---|---|---|---|
| 两份 JSON `JSON.parse` | OK | **OK** | 通过 |
| capabilities 数 | 16 | **18**（+2，无重名） | 通过 |
| 新域 `pattern` 在既有值域 / `ownedLayers` 单值 / `source` 规则 / `canonical` 磁盘存在 | — | **4/4 全 true** | 通过 |
| ledger 行数 / 重复 `localPath` | 13 | **15 / 无重复** | 通过 |
| 两条新行 `relationship` 在枚举 / `localPath` 磁盘存在 | — | **均 true**（Mika 行指向本文，已验证） | 通过 |
| 溯源可检索：`RikkaApps/Shizuku` / `wangzan101/Mika` 于两 JSON | 无 | **两 JSON × 两上游 4/4 命中**（P-01 第 7 字段达成） | 通过 |
| `check-proposal-index.js` | 0e/8w | **0e/8w**（8 条全 `[DESIGN-ARCH-105]` 存量） | 不新增红 |
| `check-provenance.js` | 0e/0w | **0e/0w**（加两行仍干净） | 不新增红 |
| `check-license-tiers.js` | 2e/17w | **2e/17w**（同为 7zip GPL `COPYING` 两处缓存 + 存量 warning） | 不新增红 |
| 行为零变化 | — | 本期无代码 diff；手机端提权链 `via` / `Status.available` 语义未触碰 | 达成 |

`check-license-tiers` 的 2 条 error 仍是 `khy-Trajectory/T4-transient/tmp/electron-builder-cache/7zip@1.0.0/.../COPYING` 与 `works/data/khy/T4-transient/tmp/.../COPYING` 的 GPL 全文，属**窗口外 B 类缓存债**，本期不修（修它要动用户数据目录，属另一次任务）。

**关联门禁实测（2026-11-09 补）**：

- `check-doc-numbers.js` exit=0（干净）。
- `check-repo-layout.js` **全量实跑**（非 `--changed`；本机全仓 5 万+ 文件，单次约 2 分钟）：**`docs-index-complete=0`，与基线 0 一致**，`docs-index-delegated=507` ⇒ 207 已被 DESIGN-ARCH 就近索引正确委派收录，**索引门没红**，本次补登那一行是有效的。exit=1 来自 `extension-id-hardcode=1`（基线 0；该规则扫 `delivery/extension/`，`check-repo-layout.js:749-757` 自述，本轮改动面完全不在该目录，属窗口外并行/存量项）与基线自身漂移（`functional-unit` 272 vs 290、`entry-buffer` 2407 vs 2470 均为下降）；均与本提案无关，不修。
- `check:agent-rules --changed` / `check:duplication --changed` / `check:gov-rules` 按 git 状态取改动集，本机工作区有并行车道大量已暂存项，会给出与本提案无关的存量红；本期按「不新增红 + 存量红归因」口径，未按「全绿」自欺。

### 12.4 明确不做（本期）

- 不改任何运行时代码（零代码 diff）。
- 不改 `[DESIGN-ARCH-200]`、`[DESIGN-MEM-009]` 原文一字（B-L3）。
- 不改 `PROPOSAL-ARTIFACT-INDEX.json` 的过时路径（越权改真源，另案）。
- 不进期 3（`DEFAULT_DISPLAY` 改造冻结）。
- 不新建 `MikaAgent` / `ShizukuBridgeV2` / 第二套 CUA 展示组件。
- 不声称 Mika 依赖 Shizuku（**Q4 已证伪，见 §12.5.1**）、不声称 G5 探针已通过（§7.4）。
- 不改 `PROPOSAL-ARTIFACT-INDEX.json:177` / `RULES-REGISTRY.json` / `[DESIGN-LAY-008]` 的旧指针，也不改 `check-proposal-index.js` / `artifactCheckers.test.js`（Q10 已查清，另案）。

---

## 12.5 收尾复核（2026-11-09 追加，Q4 / Q9 / Q10）

> 用户「继续收尾」后，主机侧三个口子的取证与判定。**本小节仍零代码 diff**：未改任何登记表、守卫、前端或规则真源。证据文件 `.khy/tmp/q4-mika-1109.txt`（联网）与 `.khy/tmp/wrapup-probe-1109.txt`（本机），均为逐段 `appendFileSync` 落盘后读回，非估计。

### 12.5.1 Q4 —— Mika 是否依赖 Shizuku：**不依赖**

| 取证项 | 读数 |
|---|---|
| GitHub API `git/trees/30a9a517…?recursive=1` | `status=200`、`truncated=false`、`entries=2831` ⇒ 完整树，未截断 |
| 路径含 `shizuku\|rikka\|moe.shizuku\|IShizukuService` | `path-hits=0` |
| 唯一 `.aar/.jar` | `gradle/wrapper/gradle-wrapper.jar`（Gradle wrapper 自身，非依赖库） |
| 抓 30 份声明/文档：`app/build.gradle.kts`、`core/build.gradle.kts`、`gradle/libs.versions.toml`（27 个依赖全枚举）、`AndroidManifest.xml`、`README.md`、中英文 `setup-guide` 全文等 | `totalHits=0`、`hitFiles=[]` |
| `docs/setup-guide.en.md:2102` 原文 | 「Mika borrows Android's built-in "Wireless debugging" to **start a small built-in helper**」；`:2103`「no computer, no cable」；Step 4 开无线调试、Step 5 输 6 位配对码；`:2175` 配对后「Mika turns on its own accessibility service **by itself**」 |

⇒ **判定：不依赖 Shizuku 这个上游项目 / 库**。两者是**同一类 ADB 权限面、各自独立实现**：Shizuku 需另装 app 并借其 binder，Mika 用系统原生无线调试自起 helper 并自行开启无障碍服务（绕过 Restricted setting）。上一轮「同属 ADB 权限面」的**推断方向成立**，「依赖 Shizuku」的**具体假设证伪**。已同步更正 §1.1 关系行、§5、§12.4；**溯源链不变** —— Mika 仍只作 `idea` 登记，不补任何依赖行。`[DESIGN-ARCH-200]` 的 G5 重估与 Q4 无关，不受影响。

### 12.5.2 Q9 —— `cua.stop` 是否接到组件层：**代码层零消费**

| 检索范围（代码文件 `.vue/.js/.ts/.tsx/.jsx/.mjs/.cjs`） | `chat.toolCall` / `toolCall.cua` / `cua.stop` |
|---|---|
| `apps/khyos-desktop/src` | 零命中 |
| `delivery/web` | 零命中 |
| `delivery`（全目录） | 零命中 |
| `runtime/node/backend/src` | 零命中 |

配套读数：`zh-CN.json` 总 5100 key，`chat.toolCall.cua.*` **115 个**（上一轮「约 70」为低估），`cua.stop` 存在；`WebRemoteControlPanel.tsx:9` 注释自述「（SettingsPage / UsageSettings / BrowserCuaSettings）一律用中文字面量而非 i18n」；`cua` 命中全在 settings 页（`CuaSettings` / `CUA_GATE_KEYS` / `SettingsPage`），无过程展示或停止按钮。

⇒ **判定：动态 key 拼接假设被证伪**（拼接必带 `chat.toolCall` 前缀字符串），该文案族当前**未被任何代码显式消费**。影响边界：§11.1「能力面已经具备」属过度表述，已收紧为「后端取消链与授权闸门已具备、前端展示面接线未证实」；**§11.2「期 4 不新增代码」判定不变**（B-U5.1 仍禁止另起组件、真差距仍是物理隔离、补按钮属独立前端任务）。
诚实边界：本轮只做代码层静态检索，未做运行时追踪，不排除 key 由外部数据完整下发（`t(receivedKey)`）而不留静态字符串的情形。

### 12.5.3 Q10 —— 过时指针与 B-L3 守卫空转：**本轮不改，另案**

| 事实 | 证据 |
|---|---|
| `.ai/GOVERNANCE-LEDGER.md` 不存在、`works/record/ai/` 真身存在 | `wrapup-probe-1109.txt`：OLD=false / NEW=true |
| 指针是 6 处引用面，不是一行 | `PROPOSAL-ARTIFACT-INDEX.json:177`、`RULES-REGISTRY.json`、`[DESIGN-LAY-008] 目录层级重设计执行路线图.md`、`check-proposal-index.js:18`、`artifactCheckers.test.js:275-277`，另 `.workbuddy/memory/2026-11-09.md` |
| **守卫空转** | `check-proposal-index.js:18` `DECISION_LEDGER_REL='.ai/GOVERNANCE-LEDGER.md'`；`:235` `if (!ledger \|\| !exists(DECISION_LEDGER_REL)) return;` ⇒ 因 `.ai/` 不存在直接返回，`:236-246` 的日期顺序检查**从未执行** ⇒ 期 1 追加那行台账没有被机器验过 |
| 若改对守卫不会新增红 | 真实台账 3 行日期 `2026-08-17 → 2026-08-17 → 2026-11-09` 单调递增，模拟 `ledger-out-of-order=0` |

⇒ **为什么本轮不改**：
1. 只改 JSON `:177` ⇒ JSON 说 `works/record/ai/`、守卫仍查 `.ai/`，制造「看起来修好了」的**隐形不一致**，比现状（两边一致地错）更隐蔽；
2. 一起改 ⇒ 必须动 `check-proposal-index.js` 与 `artifactCheckers.test.js` 两个 JS 文件，破本提案「零代码 diff」承诺，且属**动仪器**（守卫是量尺，不是被量对象），按仓库纪律应另出提案评审；
3. 连带 `RULES-REGISTRY.json` 与 `[DESIGN-LAY-008]` 也须一并处置，超出「收尾」范围。

⇒ **另案范围已查清**：4 个文档 / 登记（`PROPOSAL-ARTIFACT-INDEX.json`、`RULES-REGISTRY.json`、`[DESIGN-LAY-008]`、本提案 §2 P-02 第 6a）+ 2 个 JS（守卫常量 + 测试 fixture）+ 1 条提案；前置已验证（改对守卫不新增红）。**交人拍板，本轮零改动**。

⇒ **对 §7 口径的补充**：`check-proposal-index` 报 `0e/8w` 时，其中「B-L3 台账形状已校验」这一层**实际未执行**；§7 原有「守卫绿 ≠ 本提案 7 字段被机器验过」的诚实限制仍成立，且现在多一条 —— **「守卫绿 ≠ B-L3 台账被验过」**。不因此把 `0e/8w` 改写成红，读数照实记录。

### 12.5.4 收尾改动面

| 文件 | 改动 |
|---|---|
| 本文 | 状态注释、§0.1 F1 与 §1.3 读数（17→16）、§1.1 关系行、§5、§8 Q4/Q8/Q9 + 新增 Q10、§9 变更日志、§11.1（70→115 + 结论收紧）、§11.2 第 3 条、§11.3 反模式、§12.1 指针说明、§12.4、追加本小节 |
| `PROPOSAL-ARTIFACT-INDEX.json` / `RULES-REGISTRY.json` / `[DESIGN-LAY-008]` / `check-proposal-index.js` / `artifactCheckers.test.js` | **未改**（Q10，另案） |
| `FEATURE-OWNERSHIP.json` / `SOURCING-PROVENANCE.json` / 前端组件 / 守卫 | **未改** |

**`git status` 复核（收尾开工前）**：`M works/record/ai/GOVERNANCE-LEDGER.md`（期 1 追加行）、`?? [DESIGN-ARCH-207]…md`（本提案，未跟踪）；其余目标文件干净 ⇒ 本轮收尾没有把改动扩散到任何新文件。

**收尾守卫复跑（2026-11-09，实跑非估计）**：

| 守卫 | 读数 | 与期 1 基线 |
|---|---|---|
| `check-proposal-index.js` | `exit=0 / 0 error / 8 warning` | 一致（8 条全 `[DESIGN-ARCH-105]` 存量） |
| `check-provenance.js` | `exit=0 / 0 error / 0 warning` | 一致（干净） |
| `check-license-tiers.js` | `exit=1 / 2 error / 17 warning` | 一致（2 error 仍为 `7zip@1.0.0/…/COPYING` 两处缓存 GPL 全文；`manifests: 37 checked, 15 skipped`） |
| `check-doc-numbers.js` | `exit=0` | 一致（仅 S1 观察者 warning，存量文档常量漂移，不阻断） |

⇒ **四条逐条一致，零新增红**。本轮只改一个 `.md`，不在 `check-license-tiers` 的 manifest 扫描面内，也不可能引入编号红。
⚠ **本机守卫超时记录（诚实边界）**：`check-license-tiers` 与 `check-doc-numbers` 在本轮首次串行复跑时分别 `180s / 90s ETIMEDOUT`（本机全仓扫描变慢），后各自**单独给足超时**（300s / 240s）才取得上表读数；两次超时的落盘输出保留在 `.khy/tmp/wrapup-verify-1109.txt` / `wrapup-verify2-1109.txt`，**不把「没跑出读数」写成「守卫绿」**。
