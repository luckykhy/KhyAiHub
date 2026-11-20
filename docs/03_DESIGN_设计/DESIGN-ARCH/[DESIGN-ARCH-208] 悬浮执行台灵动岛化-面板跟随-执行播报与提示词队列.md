<!-- IMPL-STATUS: partial -->
<!-- 文档分类: DESIGN-ARCH-208 | 阶段: 设计 / 提案（先提案后编码，B-P2.1） -->
<!-- 2026-11-09 新建：提案待批准，零代码 diff。2026-11-10 用户批准「完成 1、2 期」：期 1 / 期 2 已落地（实施态、有代码 diff），期 3（L4 输入队列）被 Q4/Q5 阻断、期 4（G5 真机探针）冻结。实施记录见 §10。同日用户批准「继续 3、4 期」并拍板 Q4=B / Q5=内存队列 / 期 4 维持冻结：期 3 已落地（§12），§11 记录两期的阻断复核与本机设备取证；真机项一律「待验证」。 -->

# [DESIGN-ARCH-208] 悬浮执行台灵动岛化 —— 面板跟随、关键执行播报与提示词队列

> **状态**：**提案已批准 · 期 1 / 期 2 / 期 3 已实施（2026-11-10）**；**期 4（G5 真机探针）维持冻结**——本机 adb 设备 offline、无 AVD，规格已在 `[DESIGN-ARCH-207] §10` 备好，见 §11.2。期 0 零代码 diff；期 1/2 记录见 §10，期 3 记录见 §12。全部真机项一律「待验证」。
> **范围**：用户在「收尾」里一次性提出的 5 个诉求，按性质拆开裁定；落点是**手机端 Android 悬浮框**，不是桌面端，也不是 Mika 的 VirtualDisplay 后台屏。
> **上游依赖**：`wangzan101/Mika@v0.1.38`（**已由 [DESIGN-ARCH-207] 登记为 `idea`**，本提案继承钉子、不重复登记）；「类灵动岛」交互范式（Apple Dynamic Island，**闭源、无版本/commit 可钉、无源码可取**）。
> **调研指针**：`[DESIGN-ARCH-200]`（G5 后台屏裁决真源）、`[DESIGN-ARCH-207]`（Mika / Shizuku 归入裁定与 G5 重估）、`[DESIGN-ARCH-056]`（桌面操控闸门）、`[DESIGN-MEM-009] §6`（不做设备能力面）、`[DESIGN-SOURCING-001]`（借鉴规则真源）、`delivery/mobile/khy-os-client-app/DESIGN-UI.md §6.7`（悬浮气泡视觉规范，已生效）。
> **模板合规**：借鉴类设计，按 B-P2 填 **7 个编号字段**（规则卡名「六字段」，`PROPOSAL-ARTIFACT-INDEX.json` 的 `countDiscrepancy.modeledAs=7` 显式建模，`check-proposal-index.js:52-71` 按 7 项断言）。只写结论与签名级结构，不贴上游源码（B-P4）。
> **证据时效**：全部取证于 2026-11-09。仓内 `file:line` 为本轮 Read / Grep / node 探针实测。⚠ 手机端 Android 源码大量为**工作区未提交态**（`[DESIGN-ARCH-200] §0.1` 已声明），`git status --porcelain` 本轮实测 73 条，其中 `[DESIGN-ARCH-206]` 与两份登记表处于并行车道改动中 —— 本文不触碰这些文件。

---

## 0. 一句话结论

**这 5 个诉求不是一件事，是 5 件不同性质的事，必须拆开裁定，不能一锅端。**

| # | 用户原话 | 真实性质 | 本提案裁定 |
|---|---|---|---|
| 1 | 「像 Mika 一样给 khyos 做个后台屏」 | **G5 后台独立屏**（VirtualDisplay 承载 activity） | **不翻案、不实施**。`[DESIGN-ARCH-200]:113` 已裁「不押」，`[DESIGN-ARCH-207]` 刚重估过但期 2/3 冻结。悬浮框 ≠ 后台屏 |
| 2 | 「悬浮球的样式需要美化，不要再只是一格桥字」 | 既有 `BridgeOverlayService` 的**绘制层改造** | **可做**（期 2）。但要先说清：现状不是「没美化」，是 `DESIGN-UI.md §6.7` 已从黑方块改成 44dp 圆形渐变，问题是**恒为一个「桥」字 + 二态变色** |
| 3 | 「悬浮窗点击展开后会随悬浮球的位置移动」 | **几何缺陷**（面板坐标硬编码，与可吸边的气泡解耦） | **可做**（期 1，最小、独立可回滚） |
| 4 | 「像灵动岛一样播报现在 ai 在做什么要做什么的关键执行情况」 | 复用既有 `AmooLoop` 零 IO 事件源 + **补一个「要做什么」事件源** | **可做**（期 2），但「现在」与「要做什么」是两种数据，不能混 |
| 5 | 「展开后随时可以输入提示词，进入队列，用户也可以选择立即发送」 | **本仓此前不存在的新能力域**（悬浮窗向 AI 执行链注入 prompt） | **B-P1 触发 → 必须走 B-P2 提案（本文件）+ 期 1 补登能力域**。且撞 3 个硬约束，见 F5/F6/F7 |

⇒ **本提案不新增任何实现**。只做：①把「后台屏」这个词从悬浮框需求里剥离，继承既有裁决；②给出 L1–L4 的组件级契约；③把「输入提示词」这个新能力域的三重冲突摆到台面上，等批准后再分期落地。

### 0.1 病灶表（全部本轮实测）

| # | 病灶 | 证据 | 性质 |
|---|---|---|---|
| F1 | **面板不随球移动**：展开坐标是常量 | `BridgeOverlayService.java:397` `wm.addView(panel, params(dp(320), WRAP_CONTENT, dp(8), dp(120)))`；而气泡 `:259-286` 可拖拽、`:289-293` `snapToEdge` 会改写 `lp.x/lp.y`。两者完全解耦 | 几何缺陷 |
| F2 | **气泡只有「桥」字 + 二态色** | `:228` `tv.setText("桥")`；`:437-444` `refreshBubbleStatus()` 仅在 `busy` 时换绿色 drawable，注释 `:428-431` 明写「Deliberately colour-only — the text stays 桥」 | 表达力缺口 |
| F3 | **「要做什么」无事件源** | `AmooLoop.java:111` `progress` 是「当前步」的 volatile String，`:210` `step()` 赋值；`:149` `lastReport()` 是**结果**不是意图；全类无 `next` / `plan` / `upcoming` 的零 IO 读 | 数据源缺口 |
| F4 | **悬浮窗零输入能力** | `BridgeOverlayService.java` 全文无 `EditText`；面板 `:344-389` 只有 4 个 `Button`（折叠 / 刷新 / 复制令牌 / 停止桥或关闭悬浮框） | 新能力域（B-P1） |
| F5 | **`FLAG_NOT_FOCUSABLE` 与输入互斥** | `:207-209` `params()` 给**气泡和面板共用** `FLAG_NOT_FOCUSABLE`；`:48` 注释「FLAG_NOT_FOCUSABLE 保证不抢输入法」。要加原生输入框就得摘这个 flag | 架构约束冲突 |
| F6 | **`ask()` 要求 amoo 前台** | `AmooLoop.java:301-305` `foregroundPackage()` 不等于 `AMOO_PKG` 时直接 `ASK_FAILED`；悬浮窗一旦拿到焦点，前台包会变成自己或打断 amoo | 与 F5 叠加冲突 |
| F7 | **单飞锁会静默丢第二笔** | `AmooLoop.java:263-265` `ask()` `synchronized`，`askRunning` 时 `return null`；`Tools.java:2231` 直接把它当 job id 用 | 队列语义缺口 |
| F8 | **「后台屏」被误当悬浮框** | 本轮 Grep `setLaunchDisplayId` / `ActivityOptions` / `launchDisplayId` 在 `android/app/src/main` **零命中**；`VirtualDisplay` 仅 `ScreenCaptureService.kt:15,66,182` 抓屏用；`KhyAccessibilityService.kt:359` 与 `KhyUi.java:310` 都钉死 `Display.DEFAULT_DISPLAY` | 术语 / 范围混淆 |

---

## 1. 现状实证

### 1.1 悬浮框真身（唯一 canonical）

| 面 | 现状 | 证据 |
|---|---|---|
| 服务形态 | `BridgeOverlayService extends Service`，纯代码构建 View，**不新增 res 资源** | `:47-50` |
| 折叠态 | 44dp 圆形渐变（TL_BR `#4D7CFF→#E363F9`）+ 1.5dp 白 25% 描边 + 13sp 粗体白「桥」字 | `:226-254`；`DESIGN-UI.md:81` |
| 状态表达 | 仅 `busy→绿色` / `idle→渐变` 两种 drawable 互换，**文本恒为「桥」** | `:437-444`；注释 `:424-435` |
| 拖拽 / 吸边 | `ACTION_MOVE` 改 `lp.x/lp.y` + `updateViewLayout(bubble)`；松手 `snapToEdge` 吸到 `dp(4)` 或 `screenW-dp(48)` | `:259-293` |
| 展开态 | `LinearLayout` 竖直：标题「khy-os 桥」+ 一个 `statusText` + 4 颗胶囊按钮；宽固定 320dp | `:311-400`；宽度理由见 `:392-397` 注释 |
| 面板内容 | 「本轮进行中」`progress()`、已耗时、端口、令牌掩码、写回、上一条错误、UI 能力、提权、工具数 | `:446-534`，其中 `progress` 在 `:464-473` |
| 刷新节奏 | `ticker` 每 2000ms 主线程跑 `refreshBubbleStatus()` + `refreshPanel()`，**契约上零 IO**（只读 volatile，不读盘、不开 socket） | `:79-87`；`:98-100`；`:433-435` |
| 开关真源 | `overlayShow` / `overlayHide` 是 `MainActivity.kt:297-298` 的 MethodChannel 方法；`MainActivity.kt:113` 是**单向** `setMethodCallHandler`（Flutter → 原生），**无反向 `invokeMethod` 通道** | `MainActivity.kt:113,297-298,1500-1531` |

### 1.2 执行链与事件源（既有 canonical，不新建第二套）

| 事件源 | 语义 | 零 IO | 证据 |
|---|---|---|---|
| `AmooLoop.progress()` | **现在在做什么**（当前步） | ✅ volatile | `:111,154`；`:209-212` `step()` 赋值；注释 `:102-110` 明写「for the floating overlay to show live」 |
| `AmooLoop.busy()` | loop 或 in-flight `amoo_ask` 在跑 | ✅ | `:182-190` |
| `AmooLoop.elapsedMs()` / `lastWriteBack()` / `lastError()` / `currentMode()` | 耗时 / 最近写回 / 最近失败 / 模式 | ✅ | `:141-180` |
| `AmooLoop.lastReport()` | 阶段性**结果 / 收尾**（不是「要做什么」） | ✅ | `:101,149`；注释 `:105-109` 已把「report」与「progress」分开 |
| `AmooLoop.ask(prompt, timeoutMs)` | 单飞提问入口 | ❌ 起线程 | `:263-265`；`Tools.java:1786,2231` `amooAsk` 消费 |
| `PENDING_FILE` | **「待确认清单」**（fences / executed 落盘），**不是输入队列** | ❌ 文件 IO | `:77,1527-1539`；`:1542-1556` `appendPending` |

⇒ 「播报现在在做什么」的数据源**已经在 `refreshPanel()` 里被消费了**（`:464`）；真正缺的是 ①折叠态气泡上的呈现，②「要做什么」这个**尚不存在**的结构化事件源。

### 1.3 四步检索结论（B-U2，写进 B-P2 第 6b）

| 步 | 检索词 | 检索范围 | 结论 |
|---|---|---|---|
| 1 别名 | `悬浮球` `悬浮窗` `floating ball` `overlay` `灵动岛` `island` `播报` `queue` `队列` `后台屏` `独立屏` | `apps/khyos-desktop/src`、`delivery/mobile/khy-os-client-app`、`docs/10_规范/registry/FEATURE-OWNERSHIP.json` | 桌面端**无**悬浮球；手机端命中 `BridgeOverlayService.java` / `MainActivity.kt` / `DESIGN-UI.md`；`FEATURE-OWNERSHIP.json` 现有 18 个 capability **无**悬浮窗 / 执行播报 / prompt 队列域 ⇒ **新能力域登记缺口** |
| 2 符号 | `BridgeOverlayService` `AmooLoop` `setLaunchDisplayId` `VirtualDisplay` `EditText` `FLAG_NOT_FOCUSABLE` `amoo_ask` `PENDING_FILE` | `delivery/mobile/khy-os-client-app/android/app/src/main` | 大量命中既有实现（§1.1/§1.2）；`setLaunchDisplayId` / `ActivityOptions` / `launchDisplayId` **零命中** ⇒ G5 后台屏确未落地 |
| 3 模式 | `adaptation` / `strategy` / `observer` 等既有模式名 | `docs/16_设计模式/registry/模式注册表.json` | 本提案**不新增模式名**（B-U4 第 3 条）；若期 1 登记能力域，`pattern` 取既有值 |
| 4 层级 | 落点全在既有 `delivery/mobile` 内 | `[DESIGN-LAY-005]` | 扩展既有 canonical，**不新建并行实现**（B-U5） |

### 1.4 三个「同名不同物」排除项（本轮实证，写进反模式）

| 名字 | 实际是什么 | 为什么不是本需求落点 |
|---|---|---|
| `lib/ui/screens/independent_screen.dart` | 「独立模式」= 直连自定义 OpenAI 兼容 API 的**设置页**（测试连接 / 预设） | `:8-13,108-111`。名字里的「独立」指「绕开 khy-os 网关」，**不是** Mika 的独立显示屏 |
| `lib/ui/widgets/amoo_composer.dart` | 「分享到 amoo」的 `Intent` 面板 | `:10-12` 明确「只有点分享才调 Intent；回车只换行不发送；不读回执」；`:155-157` `onSubmitted` 空实现。**不是**把 prompt 投进 khy-os 自身 AI 循环 |
| `AmooLoop.PENDING_FILE` | loop 的「待确认清单」落盘 | `:1527-1539` 写的是 `executed` / `fences`，不是待发 prompt。语义不同，不可复用为输入队列 |

### 1.5 既有裁决（必须继承，不得悄悄改写）

| 裁决 | 原文 | 本文处置 |
|---|---|---|
| G5 方案 3「不押」 | `[DESIGN-ARCH-200]:113`「不押（G5 未取证，且 effort 与主线重叠度高）」；`:321`「a11y 跨显示语义是平台行为，读码读不出来」；`:330`「未做任何真机验证」 | **本提案不翻案**。用户口语的「后台屏」在本仓语境实为「常驻执行台悬浮框」，与 VirtualDisplay 是两件事 |
| 207 的 G5 重估 | `[DESIGN-ARCH-207]` 期 2 探针规格（§10）、期 3 冻结、§12.5 收尾复核 | 继承。真机探针仍冻结，需人再拍板；**不写「已验证」** |
| 「不做设备能力面」 | `[DESIGN-MEM-009] §6` 含「悬浮窗」，理由「没有等价场景」 | 结论保留；`[DESIGN-ARCH-207] §1.4` 已追加式更正其**前提**（有活跃 APK 与五篇手机端设计）。本文不动原文 |
| 气泡视觉规范 | `DESIGN-UI.md:81-84` §6.7 已把气泡定为 44dp 圆形渐变 + 13sp「桥」字，且 `:84` 明写「触摸 / 吸边 / 零 IO 逻辑一律不动」；`:95` §7.4「不动业务逻辑与原生机制」 | **本提案要动的正是它声明「不动」的部分** ⇒ 必须另立 ARCH 提案并追加式说明边界，不能悄悄在 DESIGN-UI.md 里改数值（B-L3）。本文不改 DESIGN-UI.md |

---

## 2. 借鉴提案（B-P2，7 个编号字段）

### 【借鉴提案 P-01】把「一格桥字」悬浮球改造成类灵动岛执行台（面板跟随 + 关键执行播报 + 提示词队列）

1. **借鉴对象**：
   - `wangzan101/Mika@v0.1.38`（release 2026-11-07，commit `30a9a5173e4590542f4fbd8ff2d49d55364be9cb`，Apache-2.0）——**已由 `[DESIGN-ARCH-207]` 期 1 登记进 `SOURCING-PROVENANCE.json` 的 `idea` 行**，本提案**继承该钉子、不重复登记上游**（避免 `check-provenance.js:107` 的 `localPath` 重复判红）。
   - 「类灵动岛」交互范式（Apple Dynamic Island 的**折叠 / 展开双形态 + 实时状态胶囊 + 就地操作**）——**闭源商业产品，无版本号 / commit 可钉，无源码可取，无许可证文本可核**。按 B-S4.1 从严 + skill §4「闭源上游只能走 `idea`，且必须写明不引入任何上游代码 / 二进制 / 资源」处理。此处只借「一个常驻小胶囊在关键时刻展开成信息卡」这一**交互形状**，不取视觉资源、不取文案、不取代码、不取动效实现。

2. **借鉴内容**：一句话 —— 借「常驻可折叠胶囊 → 展开后展示关键执行状态 → 用户可就地追加指令」这一组**交互流程结论**（B-S1 第 3 类），不取任何实现、UI 结构、文案或二进制资源。

3. **解决的问题**：F1–F7（§0.1）全部指向两个既有 canonical：`BridgeOverlayService.java` 与 `AmooLoop.java`。**不是**「上游有这个我们没有」：
   - F1 面板坐标与气泡解耦（`:397` vs `:289-293`）；
   - F2 状态表达只有二态色（`:437-444`）；
   - F3 「要做什么」无零 IO 事件源（§1.2）；
   - F4 悬浮窗零输入框；
   - F5/F6 `FLAG_NOT_FOCUSABLE` + `ask()` 前台预检叠加冲突；
   - F7 `ask()` 单飞锁静默丢第二笔。
   ⇒ 要解的是**本仓自己的表达力 / 几何 / 接线缺陷**，不是移植 Mika。

4. **许可证与代码性质**：Mika 为 Apache-2.0，核实位置见 `[DESIGN-ARCH-207] §1.1`（`README.md:210-212` + `LICENSE` + `NOTICE` + `THIRD_PARTY_NOTICES.md` + GitHub API `license.spdx_id`），**已登记、本提案不重复引入任何上游文件**。「类灵动岛」为闭源交互惯例，**无许可证文本可核** ⇒ 按 B-S4.1 从严降级为 `idea`，并声明：**不引入任何上游代码、二进制、字体、图标、动效实现或界面文案**。B-S4.1 本仓根无 `LICENSE` 的既有缺口同样适用（`[DESIGN-ARCH-207] §2 P-01 第 4 字段` 已记）。

5. **借鉴方式**：**`idea`**。判定依据：①Mika 与本仓虽同为 Android，但本提案落点是改造既有悬浮框、不搬其实现，B-S3 禁止源码入库；②「类灵动岛」闭源无代码可取、无版本可钉，只能 `idea`；③落点是**扩展既有 `BridgeOverlayService` / `AmooLoop` canonical**，不是新建并行实现（B-U5）；④无上游运行时可调、无源码可搬、无仓库可 fork ⇒ `adapter` / `vendored` / `fork` 均不适用。B-P3：`idea` 自评 + 任一评审即可，不需维护者特批。

6. **落点与现有实现对比**：
   a. **落点**：**本轮不改任何代码**。实施期落点 =
      - `delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/BridgeOverlayService.java`（L1 折叠态绘制、L2 面板几何、L4 输入入口）；
      - `.../bridge/AmooLoop.java`（L3 新增「要做什么」零 IO 读、L4 队列真源消费处）。
      两者都是**既有 canonical 上的扩展**；不新建第二个悬浮窗 Service、不新建第二套队列真源。若期 3 采纳「独立输入 Activity」方案需新增文件，按 `[DESIGN-LAY-005]` 走新增登记。
   b. **现有同类实现**：四步检索结论见 §1.3。搜索词 `BridgeOverlayService` / `AmooLoop` / `overlayShow` / `floating` / `灵动岛` / `播报` / `queue` / `EditText` / `setLaunchDisplayId` / `VirtualDisplay` / `PENDING_FILE` 在 `apps/khyos-desktop/src`、`delivery/mobile/khy-os-client-app`、`docs/03_DESIGN_设计/DESIGN-ARCH`、`docs/10_规范/registry/FEATURE-OWNERSHIP.json` 检索。结论：桌面端无悬浮球；手机端命中**唯一** canonical `BridgeOverlayService.java` + 事件源 `AmooLoop.java`；`[DESIGN-ARCH-200]:300` 已做过 VirtualDisplay 全树检索（9 命中全在 `ScreenCaptureService.kt`、`setLaunchDisplayId` 零命中），本轮复测一致。**⇒ 这是「扩展既有 canonical」，不是新增并行实现**；三个同名不同物排除项见 §1.4。

7. **验收方式**：
   - **静态（本轮可跑）**：`node scripts/ci/check-proposal-index.js`、`check-provenance.js`、`check-doc-numbers.js`、`check-repo-layout.js` **不新增红**（208 需已收录 `00_INDEX_DESIGN-ARCH-总目录.md` 就近索引）；结构自检 `grep` 七字段齐全。
   - **分期可观察判据**（真机，未执行）：
     - L2：把气泡拖到右侧吸边后展开，面板左边缘与气泡 x 满足 §3 L2 约束且不越出屏幕；展开期间继续拖球，面板同步跟随。
     - L1：气泡在「空闲 / 执行中 / 异常」三态显示**不同内容**（而非只有颜色），且折叠态 44dp 尺寸不变。
     - L3：面板同时给出「现在在做什么」与「要做什么」两行，内容分别来自 `progress()` 与新增的零 IO 读，且不出现 `lastReport()` 的结果文案冒充意图。
     - L4：输入一条 prompt 选「加入队列」→ 面板出现待发项；选「立即发送」→ `amoo_ask` 收到该 prompt；在 `askRunning` 期间再提交**不静默丢弃**（显式排队或明确告知）。
   - **怎么算做成了**：用户能不打开 App 就从悬浮窗看明白「AI 正在做什么、接下来要做什么」，并就地追加一条指令而不打断当前执行；且 `amoo_ask` 的前台预检、单飞锁、零 IO ticker 三条既有契约**逐条不破**。
   - ⚠ **真机项一律写「待验证」，不写「已通过」**（`[DESIGN-ARCH-200] §7.4` 已声明全部探针待执行）。

### 2.2 B-P1 判定表（不要看到「提案」就套借鉴，也不要为对齐硬借上游）

| 诉求 | 借鉴外部？ | 引入新能力域？ | 判定 |
|---|---|---|---|
| #1「像 Mika 一样做个后台屏」 | 是（Mika，207 已登记 `idea`） | 否（G5 已裁决，冻结） | **继承裁决**：本提案不翻案、不实施、不重复登记上游 |
| #2 悬浮球美化 | 弱（类灵动岛的**交互形状**） | 否（绘制层行为修正） | 扩展既有 canonical |
| #3 面板跟随 | **否** | 否（几何 bugfix） | B-P1 **豁免**（行为修正）；并入本提案只为统一论证 |
| #4 灵动岛式播报 | 弱（交互形状） | 否（复用 `AmooLoop` 既有事件源） | 扩展既有 canonical |
| #5 提示词队列 / 立即发送 | **否** | **是** | **B-P1 触发 ⇒ 必须 B-P2 提案（本文件）+ 期 1 在 `FEATURE-OWNERSHIP.json` 补登能力域**（`method` 取 `self-developed` / `idea`，`ownedLayers` 单值，`pattern` 取既有值） |

⇒ #3 #5 是**本仓自研 / 自修**，按 B-P2 体例据实填「不适用 + 依据」，**不为「看起来合规」硬借一个上游**（skill §4.0）。`[DESIGN-ARCH-149] §2` 有同型先例。

---

## 3. 目标形态（组件级契约）

四层，**每层独立可回滚**；前两层不动执行链。

| 层 | 做什么 | 明确不做 | 交付物 |
|---|---|---|---|
| L1 折叠态灵动岛化 | 三态内容：空闲（品牌胶囊）/ 执行中（`progress()` 短摘要 + 运行指示）/ 异常（`lastError()` 首句 + 警示色） | **不改 44dp 折叠态尺寸**（`:428-431` 注释已警告：增大气泡会让 `snapToEdge` 的 22dp/48dp 与 `dp(44)/dp(56)` 三个常量失配）；不加 `res` 资源（`:47`）；不动 2s ticker 与零 IO 契约 | `BridgeOverlayService` 绘制层 |
| L2 面板几何跟随 | `togglePanel()` 不再用 `dp(8), dp(120)` 常量，改为从气泡当前 `LayoutParams.x/y` 推导；展开期间 `ACTION_MOVE` 同步 `updateViewLayout(panel, …)` | 不收窄 320dp 面板宽（`:392-397` 注释：那是四颗胶囊钮不裁切的下限）；不改 `snapToEdge` 吸边逻辑 | `BridgeOverlayService` 几何层 |
| L3 关键执行播报 | 「现在在做什么」= `progress()` + `elapsedMs()`；「**要做什么**」= 新增一个零 IO 的结构化读（当前模式 + 队列待发项 / 计划步） | 不复用 `lastReport()` 冒充意图（`:105-109` 注释已把两者分开）；不新建第二个事件源；所有 `AmooLoop` 之外的状态一律不写 | `AmooLoop` 事件源 + 面板文案 |
| L4 提示词队列 | 展开态加「输入」入口；两个动作「加入队列」「立即发送」；队列真源**唯一** | 不复用 `PENDING_FILE`（§1.4）；不摘全局 `FLAG_NOT_FOCUSABLE`（F5）；不绕过 `ask()` 前台预检（F6）；不静默丢第二笔（F7） | 输入入口 + 队列 + `amooAsk` 接线 |

### 3.1 L2 几何契约（可复核）

```
panelW = dp(320)                       // :392-397 的下限，不改
bubbleLP = (WindowManager.LayoutParams) bubble.getLayoutParams()
panelX = clamp(bubbleLP.x + dp(44) - panelW, dp(0), screenW - panelW)
panelY = clamp(bubbleLP.y - dp(8),      dp(0), screenH - panelH_est)
```
- 球吸右边缘（`lp.x = screenW - dp(48)`）时 `panelX` 被夹到 `screenW - panelW`，面板向左展开，不越界。
- 球在下半屏时 `panelY` 上移，避免面板底部越出屏幕。
- **语义约定**：用户说「展开后随悬浮球位置移动」包含两件事 —— ①展开位置相对球定位；②展开期间拖球，面板跟随。两者都实现。

### 3.2 L4 输入焦点：三个候选与推荐裁定（**这是本提案最需要人拍板的一处**）

| 方案 | 做法 | 判定 |
|---|---|---|
| A 面板内嵌 `EditText`，摘掉 `FLAG_NOT_FOCUSABLE` | 原生层直接输入 | ❌ **不可行**。摘 flag 会让悬浮窗抢输入法焦点（违反 `:48` 既有契约），且 `AmooLoop.ask():301-305` 要求 amoo 在前台 —— 悬浮窗获焦点后前台包改变，`ask()` 直接 `ASK_FAILED`。F5 与 F6 是**同一个屏幕上的互斥约束** |
| B 独立输入 Activity（推荐） | 面板「输入」入口 → 拉起一个透明 / 半透明输入 Activity（或 App 内预填页），在 **App 内**完成输入 → 经既有 `Tools.dispatch("amoo_ask")` / `amooAsk` 入链；**悬浮窗本身始终保持 `FLAG_NOT_FOCUSABLE`** | ✅ **推荐**。保住零抢焦点契约，输入完成后收起，悬浮窗回到纯展示态。代价：需要一次界面跳转，且 amoo 前台预检仍需按既有语义诚实处理 |
| C 加反向 MethodChannel 回 Flutter | 原生 → Flutter 传 prompt | △ 本轮实测 `MainActivity.kt:113` 是**单向** `setMethodCallHandler`，无反向 `invokeMethod` 通道；且 App 在后台时 Flutter UI 不可见，amoo 前台约束仍在。工作量与风险都高于 B |

⇒ 推荐 **B**，但**不替用户拍板**：方案选择直接决定期 3 的落点与新增文件，列为 §8 阻断项 Q4。

### 3.3 L4 队列语义（必须显式定义，否则 F7 会变成「第二条 prompt 凭空消失」）

| 动作 | 语义 | 约束 |
|---|---|---|
| 「加入队列」 | 追加到待发队列尾部，不触发 `ask()` | 队列真源唯一；不落 `PENDING_FILE`；是否在进程重启后保留**待拍板**（Q5） |
| 「立即发送」 | 插到队首并立即触发消费 | 若 `askRunning` ⇒ **不得 `return null` 静默丢**，须显式「上一笔进行中，已排入队首」或等价反馈；若 amoo 不在前台 ⇒ 按 `:301-305` 既有预检**诚实拒绝并说明原因**，不绕过 |
| 消费 | 由 `AmooLoop.ask()` / `Tools.amooAsk` 单一出口消费 | 不新建第二个 ask 调用方；`busy()` / `progress()` 契约不变 |

### 3.4 文案与视觉约束

- 沿用 `AMOO-GUIDELINES.md:90` 的「**失败就说失败**」：异常态不说「已完成」，不吞错误信息。
- 单行截断复用现成 `abbrev()`（`:547-549`），不新造截断规则。
- 不新增 i18n 键、不新增 `res` 资源、不动 `DESIGN-UI.md` 已生效的数值（B-L3：边界以本提案追加式声明，不改写原文）。
- 「要做什么」的措辞不得把 `lastReport()` 的结果句读成未来意图（`:105-109`）。

---

## 4. 实施分期（每期独立可回滚）

| 期 | 内容 | 前置 | 回滚 | 状态 |
|---|---|---|---|---|
| **期 0** | 本提案 + 就近索引补登 + 工作日志 | — | 删文档 | ✅ **已完成（2026-11-09，零代码 diff）** |
| **期 1** | ①`FEATURE-OWNERSHIP.json` 补登「悬浮执行台 / prompt 队列」能力域；②L2 面板跟随（最小、纯几何，可先落） | **用户批准** + Q4 不阻断 L2 | 撤单个 commit | ✅ **期 1 已落地（2026-11-10）** |
| **期 2** | L1 折叠态灵动岛化 + L3「要做什么」零 IO 事件源 + 面板播报文案 | 期 1 绿 | 撤单个 commit | ✅ **期 2 已落地（2026-11-10）** |
| **期 3** | L4 输入入口 + 队列 + `amooAsk` 接线 | **Q4 / Q5 拍板**（焦点方案 + 队列持久化） | 撤单个 commit | ✅ **期 3 已落地（2026-11-10）**：Q4=B、Q5=内存队列；见 §12 |
| **期 4** | G5 后台独立屏真机探针 | 人再拍板，**继承 `[DESIGN-ARCH-200] §7.3` / `[DESIGN-ARCH-207] §10`** | — | ❄ **维持冻结**：用户选「保留环境记录」，本机设备 offline / 无 AVD，见 §11.2 |

> ⚠ 分期顺序理由：L2 是纯几何、零业务风险，先落能最快给用户可见结果；L4 撞 F5/F6/F7 三个硬约束且需新增界面，**必须**等焦点方案拍板，不许先写后补（B-P2.1）。
> ⚠ 2026-11-10 实施只做期 1 / 期 2，**L4 输入队列（用户 5 个诉求里的第 5 个）仍未实现**，被 Q4/Q5 阻断；详见 §10。守卫绿 ≠ 灵动岛做完，别把「已落地」读成「五个诉求都完成」。
> ⚠ **2026-11-10 二期收口更正（只追加，上句是当时的状态记录、原文保留）**：Q4 / Q5 已由用户拍板（**B 独立输入 Activity** / **内存队列，重启即清**），期 3 已落地，上句「L4 仍未实现」**现已失效**；详见 §12。期 4 仍冻结，用户 5 个诉求里的第 1 项（Mika 式后台屏）按 G5 裁决不翻案 —— 所以仍**不能**把「期 1/2/3 已落地」读成「五个诉求全做完」。

---

## 5. 诚实边界（刻意不纳入，逐条给原因）

1. **不把悬浮框叫「后台屏」，也不假装已经做了 Mika 的 VirtualDisplay**。二者一个是 `TYPE_APPLICATION_OVERLAY` 上的 HUD，一个是承载 activity 的独立显示；`[DESIGN-ARCH-200]:113` G5「不押」原文保留。
2. **不承诺「完全不占屏 / 不干扰」**。悬浮框本身就是常驻可见抓手（`BridgeOverlayService.java:27-33` 用户原话「工作时要存在悬浮框」），与 Mika「Leaves your screen alone」是不同取舍。
3. **不写「已验证」**。a11y 跨显示可达性是平台行为、读码读不出来（`[DESIGN-ARCH-200]:321`），全部真机探针待执行（`:330`）。
4. **不改 `DESIGN-UI.md §6.7` / §7.4 原文**。它的「不动业务逻辑与原生机制」是那份**视觉规范**的边界，不是本仓永久禁令；本提案另立 ARCH 文档追加式声明边界（B-L3 只追加不改写）。
5. **不动 `amoo_composer.dart` / `independent_screen.dart` / `PENDING_FILE`**（§1.4 三个同名不同物）。
6. **不动桌面端**。本轮已确认桌面 `apps/khyos-desktop/src` 无悬浮球；桌面 CUA 的过程可观测由 `[DESIGN-ARCH-207] §11` 判定「不新增代码」，本文不重开该裁定。
7. **不新建第二个真源**：执行态只认 `AmooLoop`，队列只认一处，工作区根只认既有 canonical。
8. **不改 `FEATURE-OWNERSHIP.json` / `SOURCING-PROVENANCE.json` 的并行车道改动**。本轮 `git status` 实测这两份已被别的会话改动中（73 条 porcelain），期 1 落登记表前须重新比对。

---

## 6. 反模式（这条路别走）

| ❌ 别做 | 为什么 |
|---|---|
| 因为用户说「像 Mika 一样做后台屏」就去翻 G5 / 起 `VirtualDisplay` | 本轮实测 `setLaunchDisplayId` / `ActivityOptions` 零命中，`VirtualDisplay` 只在 `ScreenCaptureService.kt` 抓屏。G5 是已裁决 + 已重估 + 已冻结的三重状态，翻案要有真机探针结论，不是一句话 |
| 在面板里直接塞 `EditText` 并摘掉 `FLAG_NOT_FOCUSABLE` | F5 + F6：抢输入法焦点会让 `ask():301-305` 的前台预检失败，用户看到「输入了但没发送」。这两个约束在同一屏幕上互斥 |
| 把 `AmooLoop.PENDING_FILE` 当成输入队列复用 | `:1527-1539` 写的是 `executed` / `fences`「待确认清单」，且是文件 IO —— 会同时污染语义和 ticker 的零 IO 契约 |
| 把 `amoo_composer.dart` 当输入组件复用 | `:10-12` 是「分享到外部 amoo」的 Intent，回车不发送、不读回执，根本不进 khy-os 自身执行链 |
| 「立即发送」直接调 `ask()` 而不管 `askRunning` | `:263-265` 第二笔 `return null` 静默丢。用户会以为发出去了，实际什么都没发生 —— 这比报错更糟 |
| 用 `lastReport()` 渲染「要做什么」 | `:105-109` 注释已把 report（结果）与 progress（当前）显式分开；结果句当意图播报是**说谎** |
| 为了让面板跟随，把 320dp 面板宽改小或改 `snapToEdge` 常量 | `:392-397` 的 320 是四颗胶囊钮不裁切的下限；`:428-431` 警告过增大气泡会让三个常量失配。改一个要连改三处，是典型的「局部对齐破坏既有合理功能」 |
| 在 `BridgeOverlayService` 里新开一条 `amoo_ask` 调用链 | B-U5 / skill §8.4：不新建第二个真源。消费出口只走 `Tools.amooAsk` → `AmooLoop.ask` |
| 为「要做什么」伪造一个 `step()` 事件或读盘取计划 | ticker 是契约上的零 IO 主线程路径（`:98-100,433-435`）；读盘 / 开 socket 会把 2s 刷新变成卡顿源 |
| 把 `independent_screen.dart` 当「独立屏」落点 | 它是直连自定义 API 的设置页（`:108-111`），与显示设备无关 |
| 为了「看起来合规」给「队列」硬编一个上游借鉴对象 | B-P2 第 1 字段是借鉴对象；自研能力按 §4.0 据实填「不适用 + 依据」，编造借鉴关系是违规 |

---

## 7. 验收方式

**本轮（提案期，零代码 diff）**：

| 检查 | 期望 | 说明 |
|---|---|---|
| `node scripts/ci/check-proposal-index.js` | 不新增红 | 该守卫只校验索引 JSON 自身 + 它登记的 `primary` 工件，**不自动扫描新建的 208**。七字段齐全靠 §2 人工逐条核对（诚实限制，同 `[DESIGN-ARCH-207] §7`） |
| `node scripts/ci/check-provenance.js` | 不新增红 | 本提案**未新增** ledger 行（Mika 已由 207 登记），故零影响 |
| `node scripts/ci/check-doc-numbers.js` | `exit=0` | 编号 208 不撞号（本轮枚举 max=207，200–207 全占用） |
| `node scripts/ci/check-repo-layout.js` | `docs-index-complete` 不新增红 | 208 已补登 `00_INDEX_DESIGN-ARCH-总目录.md` 就近索引 |
| 结构自检 | 七字段 / 病灶表 / 反模式 / 分期 / 待核实项齐全 | 落盘后 grep 校验 |

⚠ **准确口径是「不新增红 + 存量红归因」，不是「全绿」**（沿用 `[DESIGN-ARCH-207] §7 / §12.5`：`check-license-tiers` 存量 2 error / 17 warning 来自 `T4-transient` 缓存的 GPL 全文，`check-proposal-index` 存量 8 warning 来自 `[DESIGN-ARCH-105]` 行号漂移，均与本提案无关）。

**后续各期**：见 §3 各层「分期可观察判据」与 §2 第 7 字段。真机项全部待验证。

---

## 8. 待核实项

> 按 skill §5，动摇提案**前提**的项当场查清，不留到最后一刻；只剩「设计选择」类留给批准时拍板，并标明阻断哪一期。

| # | 项 | 状态 | 结论 / 影响 |
|---|---|---|---|
| Q1 | 原生悬浮框有无反向 MethodChannel 回 Flutter？ | ✅ **本轮已查清** | `MainActivity.kt:113` 是单向 `setMethodCallHandler`（Flutter→原生）；`:297-298` 仅 `overlayShow/overlayHide`。**无反向通道** ⇒ 方案 C 成本高于 B |
| Q2 | 「要做什么」是否已有现成结构化事件源？ | ✅ **本轮已查清** | `AmooLoop` 无 `next/plan/upcoming` 零 IO 读；`lib/core/vfs/ai_plan.dart:1-3,176-212` 是 **VFS 文件操作计划**（「AI 不直接写盘，产出永远是计划，执行必须经过人确认」），属于另一条执行面，语义不同，**不可直接当播报源**。⇒ L3 确需新增零 IO 读 |
| Q3 | 「后台屏」是否因本提案翻案？ | ✅ **本轮已裁定** | **否**。F8 实测零命中，G5 冻结，见 §0 / §5.1 |
| Q4 | 输入焦点选方案 B 还是别的？ | ✅ **2026-11-10 已拍板：B** | 用户选「独立输入 Activity（推荐）」。悬浮窗保持 `FLAG_NOT_FOCUSABLE`；新增 `PromptInputActivity` + Manifest 注册，按 §2 第 6a 落在已登记层级（`check-repo-layout` 的 `layer-registry-stale=0` / `root-uncatalogued=7` 未变）|
| Q5 | 队列在进程重启后是否保留？ | ✅ **2026-11-10 已拍板：不保留** | 用户选「内存队列，重启即清空（推荐）」。零落盘、不复用 `PENDING_FILE`、不破 2s ticker 零 IO 契约；`AmooLoop` 一个 `ArrayDeque` 是唯一真源 |
| Q6 | 期 1 登记表补登时，`FEATURE-OWNERSHIP.json` / `SOURCING-PROVENANCE.json` 的并行车道改动是否已收敛？ | ✅ **2026-11-10 已重比** | 落地前实测（`.khy/tmp/impl-probe-1110.txt`）：`FEATURE-OWNERSHIP.json` 当时 18 域 / `updated=2026-11-09`（207 期 1 的两域已在），两份 canonical（`BridgeOverlayService.java` / `AmooLoop.java`）`git status --porcelain` **为空、未被并行车道占用**；`SOURCING-PROVENANCE.json` 的 diff 只有 207 期的两条 ledger，208 不重复写。⇒ 期 1 只在 18 域后**追加**第 19 域，未覆盖任何他人改动 |

---

## 9. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-11-09 | 新建提案。取证定位「一格桥字」悬浮球真身 = `BridgeOverlayService.java`；拆开 5 个诉求并裁定「后台屏 ≠ 悬浮框、G5 不翻案」；实证 F1–F8 八个病灶、三个同名不同物排除项、B-P1/B-P2 判定；给出 L1–L4 组件契约与四期实施分期。**零代码 diff、零登记表改动**，等待批准 |
| 2026-11-10 | 用户批准「完成 1、2 期」。落地期 1（`FEATURE-OWNERSHIP.json` 第 19 域 + L2 面板跟随）与期 2（L1 三态 + L3 `upcoming()` 零 IO 事件源 + 面板「接下来：」行）；改 2 个 `.java` + 1 个登记表，静态自检与守卫零新增红。期 3（L4 输入队列）/ 期 4（G5 探针）不动。实施记录见 §10 |
| 2026-11-10（二期收口） | 用户「继续34期限」= 继续 3、4 期，并拍板 **Q4=B / Q5=内存队列 / 期 4 维持冻结**。先取证（§11）：本机 adb 设备 offline、无 AVD ⇒ G5 探针不可执行，规格已在 `[DESIGN-ARCH-207] §10` 备好。落地期 3：新增 `PromptInputActivity.java` + Manifest 注册、`AmooLoop` 内存队列真源与唯一消费出口、面板输入行与待发播报；改 3 个文件 + 新增 1 个，静态自检与五条守卫零新增红。期 4 不动。实施记录见 §12 |

---

## 10. 实施记录（2026-11-10，期 1 / 期 2）

> 用户原话「按照你的建议完成1，2期」。本节只记落地事实与复核证据；§0–§8 的裁定与论证原文逐字保留（B-L3 只追加）。**真机项一律「待验证」，不写「已通过」**。

### 10.1 前置取证（Q6 已核实，先证据后动手）

| 项 | 实测 | 证据 |
|---|---|---|
| 两份 canonical 是否被并行车道占用 | `git status --porcelain` 对 `BridgeOverlayService.java` / `AmooLoop.java` **为空 ⇒ 干净** | `.khy/tmp/impl-probe-1110.txt` `=== status two java ===` |
| 登记表当期状态 | `FEATURE-OWNERSHIP.json` 18 域 / `updated=2026-11-09`（207 期 1 两域已在） | 同上 `=== FEATURE-OWNERSHIP ===` |
| `SOURCING-PROVENANCE.json` | diff 只有 207 期两条 ledger ⇒ 208 不重复登记 Mika（避免 `check-provenance.js:107` `localPath` 重复判红） | 同上 `=== diff SOURCING-PROVENANCE ===` |
| `pattern` 取值 | `Observer` 是 `docs/16_设计模式/registry/模式注册表.json` 既有值 | 同上 `=== PATTERN REGISTRY ===` |
| `currentMode.name()` 可用 | `LoopModes.Mode` 枚举 `BYPASS/PLAN/EDIT/DEFAULT` | 同上 `=== LoopModes.Mode ===` |

⇒ 期 1 只在 18 域后**追加**第 19 域，未覆盖任何并行车道改动。

### 10.2 期 1 落地明细

**（1）能力域补登** — `docs/10_规范/registry/FEATURE-OWNERSHIP.json:4,403-425`

| 字段 | 值 | 依据 |
|---|---|---|
| `domain` | `mobile-floating-execution-console` | 新能力域（B-P1 触发 B-P2） |
| `method` | `self-developed` | 本域是自研的既有 canonical 扩展，借的只是「交互形状」（`idea`）；按 `[DESIGN-ARCH-207]` `desktop-computer-use` 同型先例，避免把自研能力误述为借鉴产物（B-L4 第 3 条） |
| `pattern` | `Observer` | 悬浮框是 `AmooLoop` 零 IO 状态的观察者，取模式注册表既有值 |
| `ownedLayers` | `["L3"]` | 端侧交付层单值，与 `mobile-privileged-shell` 同层（B-U5 第 1 条） |
| `source` | `null` | `method=self-developed` ⇒ 不必填（B-U1 schema） |
| `canonical` | `BridgeOverlayService.java` | 既有唯一实现，不新建并行实现（B-U5） |
| `aliases` | 含「prompt 队列」「灵动岛」等 | 先把期 3 的归属钉在本域，防届时新开第二套 |
| `updated` | `2026-11-09` → `2026-11-10`；capabilities 18 → 19 | 追加、非改写 |

**（2）L2 面板跟随** — `BridgeOverlayService.java`

| 处 | 改动 | 证据 |
|---|---|---|
| 常量 | 新增 `PANEL_H_EST_DP = 300`（WRAP_CONTENT 高度在 `addView` 前未知，取保守估计；宁可上移也不裁切） | `:68-69` |
| 坐标推导 | 新增 `panelLayoutParams(bubbleLp)`：由气泡当前 `lp.x/y` 推 `panelX/panelY`，`clamp` 防越界；面板宽仍 `dp(320)`、气泡仍 `dp(44)` | `:315-333` |
| 边界夹取 | 新增静态 `clamp(v, lo, hi)` | `:335-338` |
| 拖拽同步 | `ACTION_MOVE` 里展开态同步 `updateViewLayout(panel, …)` | `:286-291` |
| 吸边同步 | `snapToEdge()` 改写 `lp.x` 后同样重锚面板 | `:304-313` |
| 展开入口 | `togglePanel()` 的 `addView` 从写死 `params(dp(320), …, dp(8), dp(120))` 换成 `panelLayoutParams(bubble.getLayoutParams())` | `:442-443` |

⇒ F1（面板坐标与气泡解耦）闭合：展开位置相对球定位 + 展开期间拖球跟随，两件事都做（§3.1）。

### 10.3 期 2 落地明细

**（1）L1 折叠态三态** — `BridgeOverlayService.java`

| 处 | 改动 | 证据 |
|---|---|---|
| 新 drawable | `bubbleBgError`（红 `0xFFE05252`），与 idle/busy 同为预构建 drawable，不碰 API 24+ 的 `setColors()` | `:80,252-256` |
| `refreshBubbleStatus()` | 二态换色 → **三态内容**：busy 取 `progress()` 前 2 字（空则「…」）、error 显示「!」、idle 显示「桥」；仅在内容/背景真变时才 `setText`/`setBackground` | `:470-507` |
| 尺寸 | 折叠态仍 `dp(44)`，不动 `snapToEdge` 的 22/48 与 `buildBubble` 的 44/56 三个常量（避免三常量失配） | `:263`、`:306` |

⇒ F2 闭合。error 态读 `lastError()`、语义是「有错误在册」而非「本轮正在失败」（与 `AmooLoop.report()` 不清 `lastError` 的注释一致，不说谎）。

**（2）L3「要做什么」零 IO 事件源** — `AmooLoop.java`

| 处 | 改动 | 证据 |
|---|---|---|
| 新字段 | `private static volatile String plannedGoal = ""`，与 `progress`（现在）/`lastReport`（结果）并列的第三类「意图」 | `:112-121` |
| 新读 | `public static String upcoming()`：优先返回 Amoo 的 PLAN 复述；否则 busy 时返回「等待 Amoo 下一步（MODE）」；空闲返回空串。**纯内存读、零 IO、绝不复用 `lastReport()`** | `:168-179` |
| 新写 | 私有 `markPlan(String)` | `:237-240` |
| 生命周期 | `start()` 开头清空（不带上一轮旧目标）、worker `finally` 清空、PLAN fence 分支 `markPlan(f.payload)` | `:747`、`:778`、`:951-958` |

**（3）面板播报文案** — `BridgeOverlayService.java:537-543`：`refreshPanel()` 在「本轮进行中」之后加「接下来：」行，消费 `upcoming()`，用现成 `abbrev(…, 40)` 截断，不新造截断规则。两行分开：「现在」=`progress()`，「要做什么」=`upcoming()`，不混。

⇒ F3 闭合。

### 10.4 明确未动（诚实边界）

| 未动 | 原因 |
|---|---|
| `FLAG_NOT_FOCUSABLE` / 全局 `params()` | F5：摘 flag 会抢输入法焦点；期 3 才处理（§3.2 待 Q4 拍板） |
| `EditText` / 任何输入入口 / `ask()` 接线 | F4/F6/F7：L4 输入队列整期不动，被 Q4（焦点方案）+ Q5（队列持久化）阻断 |
| `AmooLoop.ask()` / `PENDING_FILE` / `lastReport()` 语义 | 三个同名不同物与既有契约（§1.4）；`lastReport()` 仍只代表结果，不冒充意图 |
| `SOURCING-PROVENANCE.json` | 本轮零新增 ledger 行，继承 207 的 Mika `idea` 钉子 |
| `DESIGN-UI.md §6.7 / §7.4` 原文 | B-L3 只追加不改写；边界由本提案 §1.5 声明，不改视觉规范数值 |
| 治理台账 `GOVERNANCE-LEDGER.md` | 本期无新架构决策裁定（期 1/2 是实施动作，非新裁决），不为了「刷一条记录」硬加行；207 期 1 那行是 G5 重估决策，性质不同 |
| G5 / `VirtualDisplay` / 真机探针 | 期 4 冻结，继承 `[DESIGN-ARCH-200] §7.3`，不写「已验证」 |
| 桌面端 | `[DESIGN-ARCH-207] §11` 已判「不新增代码」，本文不重开 |

### 10.5 静态自检与守卫复跑

| 检查 | 结果 | 证据 |
|---|---|---|
| 括号 / 圆括号平衡 | `BridgeOverlayService.java` 646 行 `{}=108/108`、`()=427/427`；`AmooLoop.java` 1714 行 `{}=272/272`、`()=657/657`，delta 全 0 | `.khy/tmp/impl-selfcheck-1110.txt` |
| 标识符自检 | `PANEL_H_EST_DP`/`panelLayoutParams`/`clamp`/`bubbleBgError`/`upcoming()`/`接下来：`/`plannedGoal`/`markPlan` 全命中；旧 `dp(8), dp(120)` 已消失；`FLAG_NOT_FOCUSABLE`/`dp(320)` 仍在 | 同上 |
| 登记表 parse | `FEATURE-OWNERSHIP.json` parse OK、`updated=2026-11-10`、capabilities=19、新域字段齐 | 同上 |
| 本期 diff | 3 files / +186 −16（2 个 `.java` + 1 个登记表） | 同上 `=== git diff (our scope) ===` |
| `check-proposal-index` | `exit=0 / 0 error / 8 warning`（存量 8 warning 来自 `[DESIGN-ARCH-105]` 行号漂移） | `.khy/tmp/impl-verify-1110.txt` |
| `check-provenance` | `exit=0 / 0 error / 0 warning` | 同上 |
| `check-doc-numbers` | `exit=0`（208 不撞号） | 同上 |
| `check-repo-layout` | `exit=1`，但 `docs-index-complete=0` / `docs-index-delegated=508`（208 由就近索引委派收录）；其余为存量红 | 同上 |
| `check-license-tiers` | `exit=1 / 2 error / 17 warning`（存量，来自 `T4-transient` 缓存 GPL 全文） | 同上 |
| 三个 registry JSON | parse 全 OK | 同上 |

⇒ **准确口径仍是「不新增红 + 存量红归因」，不是「全绿」**（沿用 `[DESIGN-ARCH-207] §7 / §12.5`）。

**回写后复跑**（`.khy/tmp/final-verify-1110.txt`，2026-11-10 02:27）：本提案 §4/§9/§10 与就近索引、工作日志的回写完成后，五条守卫逐条重跑，读数与上表**完全一致**（`check-proposal-index` 0e/8w、`check-provenance` 0e/0w、`check-doc-numbers` exit=0、`check-repo-layout` `docs-index-complete=0`/`delegated=508`、`check-license-tiers` 2e/17w），三个 registry JSON 仍 parse OK ⇒ 文档回写**零新增红**。同时结构自检：`IMPL-STATUS: partial` / `## 10. 实施记录` / 「期 1 已落地」/「期 2 已落地」等 7 个标记全 OK，§0–§8 七个章节锚点 7/7 保留（B-L3 只追加得到机器校验）、状态头无 `todo` 残留；就近索引 208 行状态已更新、无过时「待批准」文本。

### 10.6 验证边界与反模式

- ⚠ **未跑 Android build、未做真机验证**：本机只有静态自检（括号、标识符、diff stat）。`scripts/ci/check-code-standards.js` 只处理 `.js/.mjs/.cjs/.ts`，**不覆盖 `.java`**，别把「守卫绿」读成「Java 编译通过」。§2 第 7 字段的 L1/L2/L3 可观察判据（拖球后面板是否越界、三态内容是否可读、「接下来」是否真显示）**全部仍待真机目视确认**。
- ❌ **别把「期 1/2 已落地」读成「五个诉求都做完」**：用户第 5 个诉求（输入提示词 / 队列 / 立即发送）是 L4，整期未动，被 Q4/Q5 阻断。
- ❌ **别因为守卫绿就先写 L4 后补拍板**：F5/F6/F7 三个硬约束要求界面跳转方案先定，B-P2.1 不许先写后补。
- ❌ **别改 `DESIGN-UI.md` 去「对齐」代码**：B-L3 只追加，边界已在 §1.5 声明。
- 回滚：期 1 = 登记表 1 个域 + L2 几何；期 2 = L1 绘制 + L3 事件源 + 面板文案，各自独立可撤；不影响 `AmooLoop` 的执行链语义。

### 10.7 变更清单（本期 5 个文件）

| 文件 | 性质 |
|---|---|
| `delivery/mobile/.../bridge/BridgeOverlayService.java` | M · L2 面板跟随 + L1 三态 + L3 播报文案 |
| `delivery/mobile/.../bridge/AmooLoop.java` | M · `plannedGoal` / `upcoming()` / `markPlan()` 零 IO 事件源 |
| `docs/10_规范/registry/FEATURE-OWNERSHIP.json` | M · 第 19 域 `mobile-floating-execution-console` |
| `docs/03_DESIGN_设计/DESIGN-ARCH/00_INDEX_DESIGN-ARCH-总目录.md` | M · 208 行状态由「待批准」改为「期 1/2 已落地」 |
| `.workbuddy/memory/2026-11-10.md` | A · 当日工作日志 |

（208 提案本文自身的状态头与 §4 / §9 / §10 回写不计入上表。）

---

## 11. 期 3 / 期 4 阻断复核（2026-11-10 追加，取证态 · 零产品代码 diff）

> 用户「继续 3、4 期」后，按 §4 的前置条件先取证再动手。**本节只记事实与判定，不改 §4 分期状态**：期 3 仍需 Q4 / Q5 拍板，期 4 仍需真机，两期状态维持原样。

### 11.1 期 3：两个拍板项仍在，Q5 连推荐值都没有

| 项 | 提案原文 | 本轮复核 | 判定 |
|---|---|---|---|
| Q4 输入焦点 | §3.2 推荐 B，明写「**不替用户拍板**」；§8 Q4 标「阻断期 3」 | 仍待拍板 | 需人选方案，不可默认采纳推荐 |
| Q5 队列持久化 | §3.3「是否在进程重启后保留**待拍板（Q5）**」；§8 Q5 标「阻断期 3」，**提案未给推荐值** | 仍待拍板 | 需人选；持久化还须另定落盘位置且不得复用 `PENDING_FILE` |
| `FLAG_NOT_FOCUSABLE` | §3.2 / §6 指 `:207-209` | 当前实测 `:211`（期 1/2 插入代码后**行号漂移**，语义未变） | 行号以当前文件为准，别照抄旧号 |
| 单飞锁 F7 | §3.3 指 `askRunning` 单飞 | 当前 `AmooLoop.java:292,338,435` 与 `AmooApexBridge.java:118,136` **各有一把**；`LoopModes.java:88` 记 `amoo_apex_ask` 为「免无障碍免前台」的视图桥变体 | ⚠ **新事实**：存在第二条 ask 通道。但 §6 反模式钉死「消费出口只走 `Tools.amooAsk` → `AmooLoop.ask`」，本期**不擅自改用 apex**；若要用须另案裁定，不是「顺手换条路」 |

⇒ 期 3 一动就要新增输入 Activity（按 §2 第 6a 走 `[DESIGN-LAY-005]` 新文件登记）+ Manifest 注册 + 队列真源 + 单飞锁/前台预检的诚实反馈，**返工成本高**；按 B-P2.1「不许先写后补」，拍板前不动产品代码。

### 11.2 期 4：本机跑不了 G5 探针，且规格早已备好

| 检查 | 实测 | 证据 |
|---|---|---|
| adb 设备 | `192.168.1.117:37801  offline product:pandora model:PZ261A`（网络 ADB），连续两次读数一致 | `.khy/tmp/p34-1110.txt`、`p34b-1110.txt` |
| 本机模拟器 | `emulator/` 与 `system-images/` 均 MISSING ⇒ 起不了 AVD | 同上 |
| 构建面 | `ANDROID_HOME` / `ANDROID_SDK_ROOT` 未设；但 `C:/Users/25789/AppData/Local/Android/Sdk` 与 `local.properties` 的 `sdk.dir=C:\Users\25789\.khyos\android_sdk` **两份 SDK 俱在**，`gradlew` / JDK17 / `dist/android/app-release.apk` 亦在 | 同上 |
| 探针规格 | `[DESIGN-ARCH-207] §10` 已落 P1/P2/P3 三问 + 总判据；§10.2 明写「**主机替代不了**」；`[DESIGN-ARCH-200] §7.4` 禁写「已验证」 | 本轮 Read 原文 |

⇒ **判定**：期 4 的**主机侧准备态在 207 §10 已完成**，本机再写一份规格是重复造轮子；真正的期 4 是设备项，设备 `offline` + 无 AVD ⇒ **本轮不能执行，也不能写「已验证」**。推进条件是接通在线设备 + 按 `[DESIGN-ARCH-207] §10` 的「人显式批准」触发，且探针产物不入库（`works/data/khy/feedback/`）。

### 11.3 反模式（本期新增）

- ❌ 因用户说「继续」就替他把 Q4 / Q5 拍了：§3.2 明写「不替用户拍板」，§4 写死 Q4/Q5 是期 3 前置，B-P2.1 不许先写后补。
- ❌ 看见 `amoo_apex_ask`「免前台」就拿它绕开 F6 前台预检：那是既有另一条通道，不是本提案的 L4 消费出口；§6 已钉死单一出口。
- ❌ 因本机有 SDK + gradlew 就宣布「期 4 可验证」：P1/P2/P3 全是 `[DESIGN-ARCH-200] §7.3` 设备项，设备 offline、无 AVD。
- ❌ 把 §4 的期 3 / 期 4 状态改成「已落地」：本轮零产品代码 diff，守卫读数变化必须逐条归因。

---

## 12. 实施记录（2026-11-10，期 3）

> 用户原话「继续34期限」（= 继续 3、4 期），并一次性拍板 **Q4=B / Q5=内存队列 / 期 4 维持冻结**。本节只记期 3 的落地事实；§11 是**拍板前**的取证态记录（其中「零产品代码 diff」指当时），两节按时间顺序并存、互不改写（B-L3 只追加）。

### 12.1 拍板与前置

| 项 | 拍板结果 | 依据 |
|---|---|---|
| Q4 输入焦点 | **方案 B · 独立输入 Activity** | §3.2 推荐；悬浮窗保持 `FLAG_NOT_FOCUSABLE`，A 已被 F5/F6 证伪、C 需新增反向 MethodChannel |
| Q5 队列持久化 | **内存队列，重启即清空** | §3.3 未给推荐值，由用户选；零落盘、不碰 `PENDING_FILE` |
| 期 4 | **维持冻结 + 保留环境记录** | §11.2：设备 `offline`、无 AVD、`[DESIGN-ARCH-207] §10` 规格已备 |

⇒ 期 3 前置「Q4 / Q5 拍板」满足，B-P2.1「不许先写后补」的风险解除；期 4 不启动、不写「已验证」。治理台账按 B-L3 **追加一行**记录这次方案裁定 —— 与期 1/2 不同：那两期是纯实施动作，本次是用户明确拍板的设计决策（决定新增文件与队列语义），属决策留痕，不是为刷记录硬加行。

### 12.2 落地清单（3 改 + 1 新增）

| # | 文件 | 改动 |
|---|---|---|
| 1 | `…/bridge/PromptInputActivity.java` | **新增**。纯代码构建的独立输入 Activity（`EditText` + 加入队列 / 立即发送 / 取消），不新增 res / i18n；`android:exported="false"`，主题用系统现成的 `@android:style/Theme.Material.Light.NoActionBar`，`stateVisible` 让输入法随页弹出 |
| 2 | `…/src/main/AndroidManifest.xml` | 注册 `.bridge.PromptInputActivity`（与 `.bridge.BridgeService` 同形前缀），不导出 |
| 3 | `…/bridge/AmooLoop.java` | 唯一队列真源：静态 `ArrayDeque<String>` + `enqueuePrompt()` / `submitPrompt()` / `sendPendingPrompt()` / `pendingPromptCount()` / `pendingPromptHead()` / `queueNote()`；volatile 镜像 `queueSize` / `queueHead` / `mirrorQueue()` 供 2s ticker 无锁读；`upcoming()` 与 `ask()` 本体**逐字未动** |
| 4 | `…/bridge/BridgeOverlayService.java` | 面板加**第二行**两颗按钮（输入提示词 / 发送下一笔）、`openPromptInput()`（`FLAG_ACTIVITY_NEW_TASK`）、`refreshPanel()` 加「待发：」与「上次发送：」两行 |

**明确未动**：`params()` 的 `FLAG_NOT_FOCUSABLE`、`dp(320)` 面板宽、`snapToEdge()` 的 22/48 常量、`Tools.amooAsk()` 的前台预检与单飞锁、`ask()` 本体、`PENDING_FILE`、`DESIGN-UI.md` 原文。

### 12.3 关键设计决策（逐条给原因）

| 决策 | 原因 |
|---|---|
| **不做队列自动排空**，改为显式消费（面板「发送下一笔」/ 输入页「立即发送」） | 自动消费会在「上一笔 worker `finally` 放锁 → 取队首 → 再调 `ask()`」这段与前台预检、单飞锁形成竞态，而本机无真机可验证该竞态（§11.2）。显式消费可观察、可回滚；队列是**待发清单**，不是后台守护循环 |
| 消费只走 `Tools.dispatch("amoo_ask")` 一处 | §6 反模式：不在悬浮窗 / 输入页另开 `amoo_ask` 调用链；`sendPendingPrompt()` 是唯一调用点 |
| 失败**保留队首**并回人话 | F7：`askRunning` 时 `Tools.amooAsk` 返回 `code=single_flight`，旧行为是 `ask()` 直接 `return null` 静默丢第二笔；F6：amoo 不在前台返回 `amoo_not_foreground`，按既有预检诚实拒绝，**不绕过** |
| 队列读走 volatile 镜像，不加 `synchronized` | 2s ticker 是契约上的零 IO 主线程路径；`sendPendingPrompt()` 持 class 锁时会一路走到 `Tools.dispatch` → 前台预检，不能让 ticker 为读个计数去抢那把锁 |
| 输入按钮另起一行，不塞进原四颗胶囊 | 320dp 是原四颗「不裁切」的下限（`togglePanel()` 注释），加第五颗会撑爆；改宽又要连改 `snapToEdge` 三个常量，正是 §6 的「局部对齐破坏既有合理功能」 |
| Q4 选 B 后仍**不摘** `FLAG_NOT_FOCUSABLE` | 方案 B 的全部价值就在「悬浮窗保持纯展示态」；摘 flag 会同时踩 F5（抢输入法）与 F6（前台包变化 → `ask()` 预检失败） |

### 12.4 ⚠ 方案 B 的固有代价（必须说清，不许粉饰）

从悬浮窗跳进 App 内输入页时，**amoo 会被切到后台**；`AmooLoop.ask():329-334` 的前台预检因此大概率拒绝 —— `Tools.java:2235` 那段实测注释写的正是这个坑。所以「立即发送」**很可能返回**：

> `amoo 不在前台，提问没有发出、已保留在队首：…`

这不是 bug，是 §3.2 明写的「代价：需要一次界面跳转，且 amoo 前台预检仍需按既有语义诚实处理」。用户需回到 amoo 聊天页后点面板「发送下一笔」重试。**本实现不绕过预检、不伪造前台包、不改道 `amoo_apex_ask`**（§11.1 已裁定那条属另案）。要彻底消除这次跳转代价，属后续独立提案（例如通知气泡 / 全屏 Intent 直填），不在本期。

另有一个未验证项：从 Service 用 `FLAG_ACTIVITY_NEW_TASK` 启动 Activity，在 Android 10+ 有后台启动限制；本 App 有 `SYSTEM_ALERT_WINDOW` 权限，但**真机行为待验证**。

### 12.5 验收实测（`.khy/tmp/p34self-1110.txt`）

| 检查 | 结果 |
|---|---|
| 括号 / 圆括号平衡 | `BridgeOverlayService.java` 700 行 `{}=118/118`、`()=475/475`；`AmooLoop.java` 1820 行 `285/285`、`706/706`；`PromptInputActivity.java` 135 行 `14/14`、`107/107` —— **delta 全 0** |
| 标识符自检 | overlay 12/12、loop 14/14、Activity 8/8、Manifest 3/3 全 OK；旧 `dp(8), dp(120)` 已消失、`upcoming()` 函数体完好 |
| 范围 | `git status --porcelain` 对 4 个文件：3 个 `M` + 1 个 `??`，**未碰任何并行车道文件** |
| 归因 | `git diff -U0` 三段 `foreign-looking added lines=0`；删掉的 15 行全是期 1/2 自己改的（二态注释、`dp(8), dp(120)` 那行等）。`+289/−15` 是**期 1/2 + 期 3 累计未提交 diff**，不是本期净增（本期约 +170 行改 + 135 行新文件） |
| `check-proposal-index` | `exit=0 / 0 error / 8 warning`（存量） |
| `check-provenance` | `exit=0 / 0 error / 0 warning` |
| `check-doc-numbers` | `exit=0` |
| `check-repo-layout` | `exit=1`，但 `docs-index-complete=0`、`docs-index-delegated=508`、`layer-registry-stale=0`、`root-uncatalogued=7`、`dangling-task=101`、`cross-layer-require=37` —— 与期 1/2 基线**逐条一致** ⇒ 新增 Activity 落在已登记层级，未触发 `[DESIGN-LAY-005]` 红线 |
| `check-license-tiers` | `exit=1 / 2 error / 17 warning`（存量 `T4-transient` 缓存 GPL 全文） |
| 三个 registry JSON | parse 全 OK |

⇒ 准确口径仍是「**不新增红 + 存量红归因**」，不是「全绿」。

**回写后复跑**（`.khy/tmp/p34final-1110.txt`，2026-11-10 06:50）：208 文档 §4 / §8 / §9 / §11 / §12、就近索引、治理台账、工作日志全部回写完成后，五条守卫逐条重跑，读数与上表**完全一致** ⇒ 文档回写零新增红；结构自检 10 个状态标记全 OK、§0–§12 十三个章节锚点 **13/13 保留**（B-L3「只追加」得到机器校验）、状态头无 `todo` 残留；就近索引 208 行已含「期 3 已落地」且旧状态串已消失；治理台账 4 行日期有序；四个代码文件均在盘。

### 12.6 诚实边界与反模式

- ⚠ **未跑 Android build、未真机验证**：本机 `flutterSdk` / `gradlew` wrapper / 项目 `.gradle` / JDK17 / 两份 SDK 都在，但 `~/.gradle/wrapper/dists` **无缓存**（跑 `gradlew` 要先下载发行包）、设备 `offline`、无 AVD。`check-code-standards.js` 只处理 `.js/.mjs/.cjs/.ts`，**不覆盖 `.java`** ⇒ Java 只有手工静态自检，别把「守卫绿」读成「编译通过」。
- ❌ 别把「期 1/2/3 已落地」读成「用户五个诉求全做完」：第 1 项 Mika 式后台屏按 G5 裁决不翻案，期 4 仍冻结。
- ❌ 别为了让「立即发送」看起来成功去绕过前台预检 / 改道 `amoo_apex_ask`：那是用说谎换绿。
- ❌ 别为「队列该自动发」在 2s ticker 里加自排空循环：零 IO 契约与单飞锁都在这个路径上，且本机无法验证竞态。
- 回滚：期 3 = 1 个新文件 + Manifest 1 段 + `AmooLoop` 1 个区块 + `BridgeOverlayService` 3 处，独立可撤；撤销后完全回到期 1/2 态，不影响执行链语义。

### 12.7 变更清单（本期 4 个文件）

| 文件 | 性质 |
|---|---|
| `delivery/mobile/.../bridge/PromptInputActivity.java` | A · 独立输入页（方案 B） |
| `delivery/mobile/.../android/app/src/main/AndroidManifest.xml` | M · 注册 Activity |
| `delivery/mobile/.../bridge/AmooLoop.java` | M · 内存队列真源 + 唯一消费出口 + volatile 镜像 |
| `delivery/mobile/.../bridge/BridgeOverlayService.java` | M · 第二行按钮 + 输入页跳转 + 待发播报 |

（208 提案本文、就近索引、治理台账、工作日志的回写不计入上表。）
