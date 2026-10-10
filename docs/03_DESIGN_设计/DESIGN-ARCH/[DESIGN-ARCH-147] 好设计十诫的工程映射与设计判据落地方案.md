# [DESIGN-ARCH-147] 好设计十诫的工程映射与设计判据落地方案

> **隶属**：横切判据层（同时服务 TUI 设计族 `[DESIGN-ARCH-122]` 与桌面端契约 `[DESIGN-ARCH-078]`，但本文不隶属任何一族——它管的是「什么算好设计」这个上游问题）。
> **状态**：**P0 判据文档已随本提案落盘**（`[DESIGN-PRIN-001]`，纯文档、零代码）· **日期**：2026-09-24 · **编号**：[DESIGN-ARCH-147] · **落点目录**：`docs/03_DESIGN_设计/`
> **单一真源声明**：本文把 Dieter Rams 好设计十诫**翻译**为 khy-os 工程判据并给出落点与分期；**判据正文的真源是 `[DESIGN-PRIN-001]`（P0 产物）**，本文只是它的提案与论证。本文不覆盖任何既有规范——规则冲突时，TUI 以 `[DESIGN-ARCH-102]` 为准、桌面端以 `desktopUiContract.test.cjs` D1–D10 为准、工程红线以 `AGENTS.md` 规则 1–11 为准。
> **证据基准**：2026-09-24 实测，仓库 `D:\Portable\khy-os`。全部 file:line 均当日读源核对；凡推测项显式标注「【推测】」。
> **关联**：`[DESIGN-PRIN-001]` 好设计十诫工程判据（P0 产物）· `[DESIGN-RES-001]` §0.3 Agent UI 十诫（同名不同源，边界见 §2.6）· `[DESIGN-ARCH-134]`（体例先例 + 视觉收敛先例）· `[DESIGN-ARCH-127]`（减负）· `[DESIGN-GOV-001]`（治理总纲）· `[DESIGN-SOURCING-001]`（B-P2 真源）

---

## 0. 一句话结论

Rams 十诫在 khy-os **不是待引进的新方法论**——十条里六条半已被仓内机制工程化：含蓄 = chrome 预算阶梯、诚实 = 失败信封 + 诚实 rebase、细致 = 「每个数字都是测出来的」纪律、少即是多 = env 门预算棘轮、经久 = 债务台账、有用 = 空壳命令清除、创新 = 「不建第二台引擎」文化。本提案做三件事：**翻译**（十条 → 工程判据，落 `[DESIGN-PRIN-001]`）、**盘点**（每条给 file:line 证据与现状判定，见 §1）、**补缺**（三个真缺口登记为后续独立提案入口，见 §4）。**零代码改动、零新增守卫、零新增 env。**

**为什么值得做**：仓内「不为列表好看留空壳」「诚实红线」「重叠即违规」这些判据**各自为战**，散落在各文档的「诚实边界」节与规则正文里。Rams 十诫给了它们一个**可检索的共同出处**（一个十行表 + 每条一句「符合/违背」判据），评审时两分钟过一遍——收拢，不是新增。

---

## 1. 现状实证：十诫 → khy-os 工程语义映射

### 1.0 总表

| # | Rams 诫条（一句） | khy-os 工程语义 | 最强证据（file:line） | 判定 |
|---|---|---|---|---|
| 1 | 有创意——但不「为了不同而不同」 | 创新 = 在既有真源上补真空白，不并排造第二台引擎 | `[DESIGN-ARCH-141]:10-26` | ✓ 满分（文化层） |
| 2 | 有用——被使用，放大人的能力 | 每个用户可见控件必须有真实行为；接不了线的**删掉**，不置灰不留空壳 | `CommandCenter.tsx:51-61` | ⚠ 有修复先例，缺预防判据（G-01） |
| 3 | 优美——美感即可用性的一部分 | 美来自一致的设计令牌与单一品牌资产，不来自散落硬编码 | `globals.css:9-46` + `check-frontend-design-tokens.js` | ✓ 满分（有守卫） |
| 4 | 易懂——产品自己解释自己 | 用户打什么都认；按键有单一真源；键位**在界面里可见** | `aliases.js:1-16` + `chatChords.js:3-7` | ⚠ 输入侧满分，可发现性缺口（G-02） |
| 5 | 含蓄——工具不争抢主人的位置 | 装饰性 chrome 永远让位于内容：预算先行、降级有序、不闪烁 | `chromeBudget.js:188-193` | ✓ 满分（TUI 范本级） |
| 6 | 诚实——不兑现不了的承诺，不假装 | 只翻译已发生的信号；失败如实披露；门禁超标如实 rebase；红着的门等于没有门 | `cliFailureEnvelope.js:25-26` + `check-tui-gates.js:31-39` | ✓ 满分（仓内最强项） |
| 7 | 经久不衰——经得起岁月 | 真源单一、债务显式、基线只降不升；三处算术收敛为一 | `check-debt-ledger.js:14-19` | ✓ 满分（机制级） |
| 8 | 细致——不放过任何细节 | 每个数字都是**测出来的**，不是猜的；真帧字节级验证 | `chromeBudget.js:21-23` + `desktopUiContract.test.cjs:6-15` | ✓ 满分（纪律级） |
| 9 | 环保——不浪费资源 | 一切资源都有账本：token 有人民币账本、终端行有 chrome 账本、CI 有 changed 档 | `tokenUsageService.js:4-31` | ⚠ 机制满分，可见性待核实（G-03） |
| 10 | 尽可能少的设计——克制 | 删到不能再删；env 门只降不升；无用户可见权衡就不加门 | `check-tui-gates.js:27-40` + `selectGates.js:18-21` | ⚠ 棘轮在、债务在路上（G-04，已登记不重开） |

### 1.1 创新：「不建第二台引擎」

Rams 的创新观反对「为不同而不同」。khy-os 对应的文化写进了最活跃的设计文档头部——`[DESIGN-ARCH-141] 动态工作流`（2026-09-23）§0 原话：

> 「本方案**不新建工作流引擎**」——动笔前按 `[MGMT-STD-008]` §2.2「重叠即违规」做了检索……若不先讲清这点就动笔，会造出与既有件冲突的重复真源……「所以本方案的定位是『补四个真空白 + 补一条守卫』，不是重建。」

同型证据：`[DESIGN-ARCH-133]`（桌面端接入智能体工具循环——把既有 `runToolUseLoop` 接到桌面端，而非重写一层 AI 调用）。**判据**：新方案的创新点必须表述为「既有真源 X 之上的真空白 Y」，说不出 Y 的「不同」是噪音。

### 1.2 有用：空壳的清除与预防缺位

病灶与修复都留了案底——`apps/khyos-desktop/src/renderer/components/message/CommandCenter.tsx:51-61`：

> 「此前 28 条里有 20 条的 action 是 `console.log('[cmd] ...')` 空壳——包括『新建任务』和『打开工作区』，用户点了没有任何反应。已删除且**不再恢复**的条目（连同其假快捷键）……留着就是假功能（诚实红线）……等它们各自有了可调用的通道再回到本面板登记。」

这是**事后清除**。预防侧现状：`file-ratchet.config.json` 的 `consoleCount ≤ 5` 是全局预算，不是「UI 动作必须接线」判据；无任何评审条目要求新控件回答「action 接到哪里」。⇒ **G-01**：预防判据缺失，由 `[DESIGN-PRIN-001]` 诫条 2 承担（评审层，不写守卫，理由见 §5）。

### 1.3 优美：令牌与单一品牌资产

- `apps/khyos-desktop/src/renderer/theme/globals.css:9-46`：`@theme` 语义令牌（`--color-*` 全套），utilities 一律 `var()` 引用，暗/亮主题切换由此成立；`check-frontend-design-tokens.js` 是既有 CI 守卫（实测 exit=0 非阻断）。
- `[DESIGN-ARCH-134]` §1.1 B3/B7：三枚品牌标记并存 → 收敛为 `logoArt.js` 单一资产；品牌名三种写法 → 统一。「美」在 khy-os 的工程形态 = **一致性**，不是装饰。

### 1.4 易懂：输入侧满分，可发现性有缺口

- `services/backend/src/cli/aliases.js:1-16`：拼音 / 中文 / 英文缩写全认（`huice` / `回测` / `bt` → `backtest`），文件头原话「Users type whatever feels natural; the router normalizes via this table」。**这是「易懂」在 CLI 的最硬证据：无需说明书的输入容错。**
- `chatChords.js:3-7`：快捷键 → 动作名收敛为单一真源纯叶子，注释明确「叶子只做纯映射，绝不执行动作」。
- 缺口实测（**实施期修正，见 §10**）：`?` 帮助浮层**已存在**（`ink-components/HelpMenu.js:4`「toggled with "?" on an empty prompt」，键位单一真源 `keybindingCatalog`，文件头明写「绝不在此再内联一份」）；完整目录已登记全部四键（`keybindingCatalog.js:69-71` chat 组 Meta+P/O/T、`:56` global Ctrl+T）。真缺口收窄为：**精简速查表 `ESSENTIAL_SHORTCUTS`（curated 15 条）漏登 chatChords 三键**——chatChords 接线晚于精简表定稿。⇒ **G-02**（已由 P1 补齐，见 §10）。

### 1.5 含蓄：chrome 预算阶梯（TUI 范本级）

`services/backend/src/cli/tui/chromeBudget.js` 是十诫在仓内最完整的一次工程化：

- `:188-193` 降级有序，先舍最无用：「Shed order = least useful first: tagline, then the whole banner, then the two marginTop blank rows」；
- `:204-211` 装饰不闪烁：降级档位按 busy 几何一次定档、rest 复用同档（「A frame that does not move is worth those rows」——宁可闲置 2 行，不让横幅每回合闪一次）；
- `:26-28` 连 ink 尾行 `\n` 都入账（`CC_TRAILER_ROWS`），账本与渲染同源。

**判据**：任何装饰性 UI 资源（品牌行 / 横幅 / 提示行）必须先过预算再上屏，且必须能陈述自己的「降级顺位」。

### 1.6 诚实：失败信封 + 诚实 rebase（仓内最强项）

Rams 对硬件的「诚实」= 不假装更精确、更光鲜、更强大。软件的对应物是**状态与失败披露**：

- `cliFailureEnvelope.js:25-26` 把这条写成了代码注释级的红线：「**诚实边界**：只翻译**已发生**的信号……不做任何写入/网络/重试/**猜测**」；`:6-11` 记录了它治的病灶——旧实现把诊断截断 180 字符，恰好切掉通道名 / 机器码 / 钉选元原因，「用户知道『失败了』，但不知道哪条通道、什么码、本轮路由是否被钉死」。这就是软件版的「硬件假装精度」。
- `check-tui-gates.js:31-39`：门预算实测 226 > 上限 220 时的处置是**如实 rebase 到 227** 并逐条登记原因（「so this is an honest rebase, not a new allowance」）+ 写明 KHY_PERMISSION_NOTICE 是临时门、与债务台账共担收敛——不偷偷放水、不静默重置。
- `check-debt-ledger.js:12` 一句话立碑：「**红着的门等于没有门——因为它训练所有人忽略红色**」。
- 规则层：`AGENTS.md` `RUNTIME-002` 状态透明（含糊 token 判 warning）。

### 1.7 经久不衰：债务台账与算术收敛

- `check-debt-ledger.js:14-19`：每类门禁指标必须在台账有条目（覆盖完整性）、有 owner/dueBy/target、`target` 严格小于 `measured`（只降不升）、逾期显式 `slipped`（禁止静默滑动）、90 天未更新测量值 → 警告。
- `chromeBudget.js:5-16` 的历史自述：固定行算术曾在**三处**各持一套常量，一次改动就能让帧悄悄溢出视口——本模块把它收敛为单一定义，旧函数降级为薄适配器（「keeping their signatures so existing call sites and tests keep working」）。这就是「经久」的工程形态：**改内部不改契约**。
- `AGENTS.md` 绑定层：门成员资格从 `RULES-REGISTRY.json` 派生，不在 `&&` 链硬编码——规则比脚本活得久。

### 1.8 细致：「每个数字都是测出来的」

- `chromeBudget.js:21-23` 原话：「every number here is a row that was **MEASURED** on the painted frame, **not guessed**」，并附复现文件路径（BUG-77b repro）；`:148-152` 记录 80×5/6/7 三档高度下逐帧数 `\x1b[2J` 的实测过程。
- `apps/khyos-desktop/tests/desktopUiContract.test.cjs:6-15`：D1–D10 十条 UI 不变量契约（尺寸 / 无框 / 安全 / IPC 命名 / 品牌文本 / 禁硬编码端点），每条可断言。
- 流程层：`AGENTS.md` 规则 8（`PROCESS-008`）新机制落地阶段可校验；`[DESIGN-ARCH-134]` §1.2 的门禁基线表逐条列 `# tests / # pass / # fail` 实测值——「基线数字必须实测，不许估」已是仓内文档纪律。

### 1.9 环保：一切资源都有账本

「环保」在软件里的对应物是**资源成本可见且被约束**：

- `tokenUsageService.js:4-6`：token 按会话/日/月记账，`:18-31` 按供应商逐一计价（USD→CNY `:15`），`:43-46` 会话级代码改动账本（刀110）——AI 的电费被翻译成用户可读的人民币。
- `chromeBudget.js` 本身：终端行是稀缺资源，预算纪律 = 不浪费屏幕。
- `AGENTS.md` 门档：`rules:gate:commit` 只跑支持 `--changed` 的执行器（pre-commit 快档）——CI 资源不浪费在未改动面。
- ⚠ 缺口（**实施期证伪，见 §10**）：原判「成本是查询式而非界面常驻」不成立——`hudRenderer.js:568-588` 已在 HUD **常驻渲染** `Cost ¥<会话> ¥本月`（chalk 黄色人民币前缀，消费 `tokenUsageService.getSessionCost/getMonthUsage`），三层验证（存在/调用方/用户可见）全过。⇒ **G-03 证伪，P2 无需立项**。

### 1.10 少即是多：门预算棘轮

- `check-tui-gates.js:27-28`：「This constant is the machine-enforced cap: **it only moves DOWN**」；`:40`「Down-only resumes from here; ≤40 target unchanged」——上限 227，目标 40，只降不升。
- `selectGates.js:18-21`：三个子开关**别合并**——每个对应一种真实的用户可见权衡（`KHY_SELECT` 接管与否 / `_CLIP` 自动复制与否 / `_DRAG` 拖动追踪与否）。「无权衡不开门」是「少即是多」的门禁化表述。
- `CommandCenter.tsx:55-56`：空壳命令**删除且不再恢复**（而不是置灰保留）——删到不能再删。
- 现状：实测 226/227（2026-09-23 rebase 基准），收敛至 ≤40 的债务已在 debt-ledger 条目（tui.gates）名下。⇒ **G-04 不新开任务，避免重复登记**（§4）。

---

## 2. 借鉴提案

### 2.0 B-P1 豁免判定：**不成立**

`[DESIGN-SOURCING-001]` §3 B-P1 的豁免判据是「该能力域已在注册表中存在且有 `canonical` 路径」。**设计品质判据**这一能力域未登记——`[DESIGN-GOV-001]` 十板块管规则治理，`[DESIGN-RES-001]` §0.3 管行业功能形态，均非「好设计的品质判据」。⇒ 本文与 `[DESIGN-PRIN-001]` 就是补这个空白的提案，不走豁免。

### 【借鉴提案 P-01】Dieter Rams 好设计十诫 → 工程判据翻译

1. **借鉴对象**：Dieter Rams（博朗首席设计师）「好设计十诫」（*Ten principles for good design*），1970 年代提出并多次重述，现行通行文本以 Vitsoe 官网刊载版为准。非代码项目，无 commit 可引。
2. **借鉴内容**：借的是**结论**——十条设计价值观，经工程语义翻译后作为 khy-os 的评审判据。不引入任何结构 / 行为 / 测试形态。
3. **解决的问题**：khy-os 评审链已有 B-P2（借鉴合规）、`RUNTIME-001~010`（工程红线），但缺一层统一收拢的「这东西对用户是不是好设计」判据——「不为列表好看留空壳」（`CommandCenter.tsx:56`）、「诚实红线」（同处）、「重叠即违规」（`[DESIGN-ARCH-141]:12`）各自为战，无单一可检索出处。
4. **许可证与代码性质**：理念本身非代码、无许可证条款；判据句全部为本仓自写（对照 §1 的仓内机制反向归纳），**不引入任何上游代码、二进制或资源**。文本性引用仅限诫条标题与通行释义。
5. **借鉴方式**：`idea`。判定依据：纯理念借鉴，零物质复制，无闭源解包产物参与。
6. **落点与现有实现对比**：
   - a. **落点**：`docs/10_规范/其它规范/[DESIGN-PRIN-001] 好设计十诫工程判据.md`（P0 新增，本次随提案落盘）。
   - b. **现有同类实现**：已搜过的词与目录——`docs/` 全树 grep `Rams|拉姆斯|十诫|十大设计原则`（命中 `[DESIGN-RES-001]` §0.3「Agent UI 十诫」，边界见 §2.6，不冲突）；`docs/10_规范/` 两层枚举（既有专题板块为 API/DOC/FE/GIT/LAY/MEM，通用桶 `其它规范/` 72 篇里无设计原则类真源）；`AGENTS.md` 规则表（工程红线，非品质判据）。结论：**收拢散见判据**（CommandCenter 注释、各文档「诚实边界」节）为一份可检索文档，**不新增并行的规则真源**。
7. **验收方式**：见 §7。

### 2.6 与 `[DESIGN-RES-001]` §0.3「Agent UI 十诫」的边界

| 方 | 内容 | 管什么 |
| --- | --- | --- |
| `[DESIGN-RES-001]` §0.3 | 权限即产品 / 流式一切 / 生成式 UI 等（2025-2026 行业共识） | Agent UI 的**功能形态**——该有什么能力 |
| `[DESIGN-PRIN-001]`（本提案） | 有用 / 含蓄 / 诚实 / 少即是多（Rams 1970s） | 设计的**品质属性**——做成什么样算好 |

两份「十诫」同名不同源、层次互补不冲突：Agent UI 十诫的条目同样要过 Rams 十诫的体检（例如「生成式 UI」若做成装饰性空转组件，会在诫条 2「有用」上判负）。`[DESIGN-PRIN-001]` 头部已作同源声明。

---

## 3. 目标形态：`[DESIGN-PRIN-001]` 的文档契约

**文件**：`docs/10_规范/其它规范/[DESIGN-PRIN-001] 好设计十诫工程判据.md`

**结构契约**（已按此落盘）：

1. 头部单一真源声明：本文是十诫的工程判据翻译，**评审判据参考层**——不构成新的强制规则域、不设守卫、不进 RULES-REGISTRY；与 `[DESIGN-RES-001]` §0.3 的边界一句话写明；冲突时既有规则赢。
2. §1 判据总表：每条 = Rams 诫条一句 + 工程判据（**符合 = … / 违背 = …** 可判例句）+ 既有机制指针（file:line）。
3. §2 评审用法：新提案 / 新功能 / 新组件评审时逐条过一遍（两分钟体检）；只对**改动涉及**的诫条写结论，不对十条全量填空。
4. §3 与既有规则的关系：机器可判的子集**已由既有门承担**（D1–D10、design-tokens、tui-gates、debt-ledger）；判据只管机器判不了的 remainder。
5. §4 诚实边界：判据不扩张成守卫的理由（§5 同文）。

**文案约束**：判据句必须是「符合 = 可陈述的事实 / 违背 = 可指认的现象」的形态，禁止「应当尽量」「建议注意」级别的软话——软判据等于没有判据（同 `check-debt-ledger.js:12` 的逻辑）。

---

## 4. 实施分期

| 期 | 内容 | 状态 | 回滚方式 |
| --- | --- | --- | --- |
| **P0** | `[DESIGN-PRIN-001]` 判据文档落盘（本文 §3 契约） | ✓ 随本提案完成（纯文档） | 删文件即回滚 |
| **P1** | G-02 键位速查补登：`ESSENTIAL_SHORTCUTS` 补 chatChords 三键（Meta+P/O/T）+ 双向一致性测试 | ✓ **已实施（2026-09-24，见 §10）** | git revert 三个文件 |
| **P2** | G-03 token 成本常驻可见性 | ✗ **证伪，无需立项**（`hudRenderer.js:568-588` 已常驻 ¥，见 §1.9） | — |
| 不做 | G-04 门收敛 227→40 | **已在 debt-ledger 条目（tui.gates）名下，不重复登记** | — |

P1 落地时的纪律预告（详细论证留待其独立提案）：帮助层必须从单一真源渲染（禁第二份键位表）、内容是信息不是装饰（过 chrome 预算，参照 `CC_HINT_ROWS` 先例）、门控不加新 env（撞 227 棘轮 + B-P1 判定漂移双重代价，`selectGates.js` 的「无权衡不开门」）。

---

## 5. 诚实边界（刻意不纳入，逐条给原因）

1. **不为十诫写新 CI 守卫**——机器可判子集已有门（D1–D10 / design-tokens / tui-gates / debt-ledger）；机器判不了的（「含蓄吗」「诚实吗」）写成守卫 = 永远红或永远绿的门 = 没有门（`check-debt-ledger.js:12`）。
2. **不动 RULES-REGISTRY 十大域与治理总纲十板块**——十诫是评审判据不是规则域；动域结构牵动 `[MGMT-STD-008]` 十大域对应关系，收益配不上爆炸半径。
3. **不改 AGENTS.md 正文**——`[MGMT-STD-008]` §3.2 指针原则：正文只做指针 + 摘要；判据真源在 `[DESIGN-PRIN-001]`，AGENTS.md 是否加一行指针**留给维护者决定**（本文不代改）。
4. **六条满分条目不加新机制**——含蓄 / 诚实 / 细致 / 经久 / 创新 / 优美已各有承担者（§1），再建机制 = 第二真源。
5. **不做皮肤式「美化运动」**——三红线之一：不为好看重写代码。十诫的「优美」在 khy-os 走令牌与一致性，不走重绘。
6. **G-04 不重复登记**——门收敛债务已在台账，同一债务两处登记会让「谁欠的」失焦。

---

## 6. 反模式（这条路别走）

| ✗ 别做 | 为什么 |
| --- | --- |
| 把十条全写成 CI 检查器 | 「红着的门等于没有门」（`check-debt-ledger.js:12`）；软判据机器化必然制造假门 |
| 借「十诫」之名重写既有视觉/交互 | 三红线：不为好看重写代码；六条已满分的条目再动就是破坏 |
| 为落地判据新增 env 门或配置键 | 撞 227 只降不升的棘轮（`check-tui-gates.js:27`）；且把本可豁免的后续 bugfix 拖成非豁免（B-P1 判据含「新增配置键」） |
| 硬套 Rams 原文到不匹配的域 | 「环保」≠ 把 UI 做成绿色主题；「硬件诚实」的软件对应物是失败披露（`cliFailureEnvelope.js`），不是物理参数表 |
| 判据文档升级成「新真源」与既有规则打架 | 判据层永远输给规则层；发现打架时修判据文档，不修规则 |
| 评审时十条全量填空 | 软判据全量勾选会退化为仪式；只写改动涉及条目的结论（`[DESIGN-PRIN-001]` §2 已约束） |

---

## 7. 验收方式

| # | 判据 | 命令 / 操作 | 期望 |
| --- | --- | --- | --- |
| 1 | 两份文档落盘且可读回 | `Read` 两个路径 | 内容与 §3 契约一致 |
| 2 | 编号无撞 | 目录枚举（`docs/03_DESIGN_设计/DESIGN-ARCH/` 内 `DESIGN-ARCH-147` 唯一；`10_规范` 两层内 `DESIGN-PRIN` 前缀唯一） | 唯一 |
| 3 | 治理门不受影响 | `node scripts/ci/check-gov-rules.js` | 与改动前同为绿（新文档不挂总纲入口） |
| 4 | 零代码改动 | git porcelain 对比（本提案前后，仅 +2 文档） | 无源码/测试/配置变更 |
| 5 | 后续引用规范 | 后续提案按 `[DESIGN-PRIN-001]` §N 引用判据 | 引用可解析 |

> 说明：验收 3 的基线在 P0 落盘**之后**补测一次（本文落盘时点该门为绿——2026-09-24 与 `check-tui-gates` 同批 CI 均绿【推测，依据为 09-23 rebase 后流水线恢复；以实测为准，§8 第二条】）。验收 4 在本仓「并行会话常驻」的现实下按「本次新增的唯一标识符探针」法执行（本文新增标识符即 `DESIGN-PRIN-001`）。

---

## 8. 待核实项

1. ~~G-03 立项前提~~ **已关闭（2026-09-24）**：消费方三层验证完成——`hudRenderer.js:570` 调 `tokenUsageService.getSessionCost/getMonthUsage`，`:579-585` 在 HUD 渲染 `¥` 会话/本月成本，用户可见。缺口证伪。
2. ~~`check-gov-rules.js` 对 `其它规范/` 新增文件的行为~~ **已关闭（2026-09-24）**：P0 落盘后实测 `exit=0`（治理规则检查通过：GOV-MOD-004 十板块、GOV-TOOL-004/005/006 均满足）。
3. **AGENTS.md 是否加指针行**：留给维护者；加了以后 `[DESIGN-PRIN-001]` 的可发现性从「总目录生成物」升级为「指针可达」。

---

## 10. 实施记录（2026-09-24，P1）

### 10.1 与方案的偏离及原因（最重要的一段）

原 P1 设想「**新建** `keymapHelp.js` 帮助层 + App.js 接线」。实施动工前按三层验证纪律摸接线点，发现 **`HelpMenu.js` 帮助浮层已存在**（`?` 空 prompt 触发、`keybindingCatalog` 单一真源、App.js `:6832` 已渲染、App.js `:5396` Esc 关闭已接线），且完整目录已登记全部四个 chord。⇒ 按 `[DESIGN-PRIN-001]` 判据一「不建第二台引擎」，实施收敛为**补登记 + 钉一致性**，App.js **零改动**、零新建组件、零新增 env。原设想的「帮助层消费 chatChords 单一真源」以**双向一致性测试**形态落地（见 §10.2 第 3 项）。

同法证伪 G-03（§1.9）：提案阶段只查了 `tokenUsageService` 本身、没查消费方——正是本提案 §8 第一条自己警告过的误判模式，特此留痕。

### 10.2 落地清单

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `services/backend/src/services/domain/config/keybindings/keybindingCatalog.js` | `ESSENTIAL_SHORTCUTS` 15→18：Shift+Tab 后补 `Meta + P` / `Meta + O` / `Meta + T` 三条（消费 SSOT 的 HelpMenu 自动带上，零组件改动） |
| 2 | `services/backend/tests/services/keybindings/keybindingCatalog.test.js` | LEGACY 基线同步 +3，注释登记「第三处有意改动」及理由（沿用该文件既有的事由登记文化） |
| 3 | `services/backend/tests/cli/tui/chatChordsHelpSync.test.js`（新增，node:test） | 双向一致性守卫：① chatChords 每个 chord 在完整目录有同名条目；② ESSENTIAL 每个 `Meta + X` 经 `resolveChatChord` 实测解析出动作（防假承诺）；③ ESSENTIAL 无孤儿（自造键位判红）；④ 决策钉：Ctrl+T 因「仅宽屏 ≥120 列」的条件性**刻意不入精简表**（防向窄屏用户承诺按了没反应的键） |
| 4 | `services/backend/tests/tui/helpMenuSize.test.js`（test:tui 套件，jest 风格只改断言不重写） | 80×24 断言从「15 条全显无 hint」更新为新稳态「14 条 + 另有 4 条、新增三键可见」（数据增补后 BUG-58 收缩机制按设计接管，非视觉回归） |

**明确不做**：Ctrl+T 进精简表（理由见上）；CcHelpMenu（CC 预览态表面，自持 `GENERAL_SHORTCUTS`，不在本缺口射程）；任何 App.js 改动。

### 10.3 验收实测（2026-09-24，node 22.22.2）

| # | 验收项 | 命令 | 结果 |
| --- | --- | --- | --- |
| 1 | 目录契约 | `node --test tests/services/keybindings/keybindingCatalog.test.js` | **exit=0，# tests 20 / pass 20 / fail 0** |
| 2 | 双向一致性（新增） | `node --test tests/cli/tui/chatChordsHelpSync.test.js` | **exit=0，# tests 4 / pass 4 / fail 0** |
| 3 | 80×24 收缩稳态 | 影子验证（真 require `wrapCell.visualRows` 复算 HelpMenu 算式） | shown=14、hidden=4、Meta+P/O/T 全可见，与第 4 项断言一致 |
| 4 | helpMenuSize（node --test 视角） | `node --test tests/tui/helpMenuSize.test.js` | 改前改后同为 `exit=1`（`ReferenceError: describe is not defined`）——**存量红，与本改动无关，零漂移**。其真帧语义属 test:tui 套件（本机未装 jest，无法跑 ink 真帧；断言更新经 §10.3-3 影子验证背书，如实声明） |
| 5 | 门预算 | `node scripts/ci/check-tui-gates.js` | FAIL 229>227——**归因闭合非本改动引入**：工作区 vs HEAD 的 token 集合差全部来自并行会话在途文件（`AGENTS.md/html`、`app.js`、`ProgressBar.js`、`useQueryBridge.js` 等 11 个 `M` 文件 + 12 个 untracked 新文件，多为 `[DESIGN-ARCH-134]` 启动屏与 TUI 并行会话产物；−3 删除）。本改动落点（`services/domain/config` + `tests/`）不在 tui 扫描范围，零贡献。rebase 与否由该会话/维护者决定，本文不代改 |
| 6 | 零新增 env | 上述文件 diff | 未引入任何 `KHY_*` token |

---

## 9. 变更日志

| 日期 | 变更 |
| --- | --- |
| 2026-09-24 | 初版：十诫工程映射（§1 十条逐一实证）+ B-P2 P-01（idea 方式）+ P0 判据文档 `[DESIGN-PRIN-001]` 随提案落盘 + G-01~G-04 缺口登记与分期 |
| 2026-09-24 | **改号 145→147**：并行会话在本提案取号（16:50 实测 max=144）与落盘（17:02）之间先后抢注 145（用户DIY空间分层）与 146（TUI 卡片点击交互）。本文件改号为 147，`[DESIGN-PRIN-001]` 内三处交叉引用同步更新；取号期间生成的旧号构建镜像 html 已删除，下次 docs 构建按 147 重新生成（`00_INDEX` 系列均为生成物，不手改） |
| 2026-09-24 | **P1 实施（§10）**：发现 `HelpMenu` 帮助浮层已存在，实施从「新建帮助层」收敛为「ESSENTIAL 精简表补登 chatChords 三键 + 双向一致性测试」，App.js 零改动；G-03 证伪（HUD 已常驻 ¥ 成本），P2 关闭；新增 §10 实施记录、§1.4/§1.9/§4/§8 同步修正 |
| 2026-09-24 | **改号 145→147**：并行会话在本提案取号（16:50 实测目录 max=144）与落盘（17:02）之间先后抢注 145（用户DIY空间分层与安全边界统一方案）与 146（TUI 卡片点击交互）；本文件改号为 147，`[DESIGN-PRIN-001]` 内交叉引用同步更新，旧号 145 的构建镜像 html 已删除（下次 docs 构建将按 147 重新生成）。此事件本身即本仓并行会话常态的证据，编号唯一性以**落盘时刻的目录枚举**为准、以**撞号即改**为纪律 |
