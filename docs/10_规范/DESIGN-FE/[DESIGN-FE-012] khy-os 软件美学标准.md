<!-- IMPL-STATUS: done -->
<!-- IMPL-DRIFT-AUDIT: 2026-10-18 · DOCS-005 范围补标，依据见下 -->
> **标记依据**：38 条根锚定路径全部可解析，且文中自述已实现；据 DOCS-005 §二 标 done。
# [DESIGN-FE-012] khy-os 软件美学标准

> **状态**：正式规范（2026-10-14 落地；同日 §7 的 Q1–Q9 全部落定）。编号 `DESIGN-FE-012`（由工作流固定）。
> 机器可读令牌真源：`docs/10_规范/registry/AESTHETICS-TOKENS.json`（本文 §3 的机器可读形态）。
> 来源草案：`.khy/aesthetics/standard.draft.md`（落地前形态，本机保留，不在仓内）。
>
> **证据基础**：`.khy/aesthetics/research/` 下六篇面向研究（均标注 evidenceBasis=web，逐条给出联网/仓内出处），
> 以及本仓既有约定与守卫（`docs/14_维护者/taste.md`、`runtime/node/backend/src/cli/tui/theme/ccTheme.js`、
> `delivery/web/ai-frontend/src/styles/newapi-theme.css`、`apps/khyos-desktop/src/renderer/theme/globals.css`、
> `[DESIGN-FE-004]`、`[DESIGN-FE-001]`、`[DESIGN-LAY-005]`、`scripts/ci/check-frontend-design-tokens.js`、
> `delivery/web/ai-frontend/src/__tests__/designTokenCompliance.test.js`、`RULES-REGISTRY.json`）。
> 凡研究文件标「未能确立」的，本文不据以立条；凡需人拍板的，进 §7（原「未决问题」，2026-10-14 已逐条落定），本文不代拍。
>
> **本文的定位（先说清楚，避免与既有规范打架）**：本标准**不新增规则 ID**。它把既有规范
> （FE-004 管 Web CSS 架构、FE-001 管网页端实测口径、`RUNTIME-002/004` 管状态与终端渲染、`RUNTIME-011` 管 TUI 节拍）
> 的美学语义收拢成一份「跨端可对齐」的定义与令牌清单，并**指向**它们，而不是复制或覆盖它们。
> 依据元规则 `[MGMT-STD-008]` §2.2「重叠即违规」。**新要求一律挂到既有规则（FE-004）的 `exec.findings`，
> 或新增一个「服务既有规则」的执行器**（见 §5）——不建第二套规则真源。

---

## 0. 本标准的适用面与不适用面

**适用面**：khy-os 的五个展示端 —— TUI/CLI（`runtime/node/backend/src/cli/`）、
Web（`delivery/web/ai-frontend/`）、桌面端（`apps/khyos-desktop/`）、
移动端（`delivery/mobile/khy-os-client-app/`），以及独立项目 khyquant 的接入前端
（`delivery/channel/khyquant/frontend/`，独立项目，随平台分发；其前端沿用 `--khy-*` 命名，如 `theme.css` 的 `--khy-primary`）。

**不适用面**：
- 内核（`kernel/`）无图形/终端 UI 约定，不在美学标准内。
- 文档排版（`docs/` 的 `.md`/`.html` 形态）归 `[MGMT-STD-001]` 与文档站守卫，本文不涉。
- **视觉重绘不在本文范围**：本文只定义「怎么算对」，不负责把既有界面按标准重画。
  按研究结论与工作流约束，视觉重绘须人眼验收，不得由 AI 单方执行。

**⚠ 适用面 ≠ 强制面（重要澄清）**：本文适用五端，但**强制面仍以 Web 端为主** ——
既有执行器 `check-frontend-design-tokens.js` 默认只扫 `ai-frontend/src`、`khyquant/frontend`、`ui-shared`
三处，`RULES-REGISTRY` FE-004 的 `scope`/`paths` 亦只含这三处；**新增执行器 `check-aesthetics.js` 已落地**
（`scripts/ci/check-aesthetics.js`，2026-10-14 落地并在 `package.json` 注册 `check:aesthetics`），
校验令牌 schema 与跨端必需项存在性，当前校验面为 TUI + Web。把它扩到桌面/移动端已由 **§7 Q9 本轮决定**
（登记与守卫代码待落）。**桌面端与移动端当前无美学守卫执行路径**，TUI 侧亦无色板守卫。故
KHY-AES-01~04（跨端语义一致）在桌面/移动端是「已定义、未强制」。

---

## 1. 「软件美学」在本仓的定义

> 六篇研究各给出一句面向定义，本文取它们的交集，落成本仓口径。

**定义（本仓口径）**：

> **khy-os 的「软件美学」= 用一套可执行的令牌真源，把「可读、可辨、可扫读」做成机器可判的底线，
> 在此底线之上按端做取舍 —— 终端里在极窄信道里做减法，图形界面里分面调密度 ——
> 并使动效与装饰始终服务于信息，而不是相反。**

拆成四句，每句给研究出处：

1. **美学是可测的底线，不是配色偏好。** 对比度由前景/背景的相对亮度决定、与色相无关，
   因此可在灰度下测量与验证（`research/3-色彩与无障碍对比.md` §定义 / P1 / P12，
   引 WCAG 2.2 SC 1.4.3 Intent「hue and saturation have minimal or no effect on legibility」
   与 Material「remains functional even in its gray-scale format」）。
2. **终端的美学 = 在极窄信道里做减法。** 颜色、字符、单元格位置是仅有的三个自由度，
   因此业界收敛为：颜色必须能降级且不劫持用户配色；结构靠单元格网格与语义角色而非装饰；
   刷新必须无闪烁且不破坏回滚（`research/2-终端与TUI美学.md` §定义）。
3. **信息密度的美学 = 分面调密度 + 有边界地做减法 + 把可读性底线写成可机判的规则。**
   （`research/6-信息密度与数据可视化.md` §定义；「有边界」指 Tufte 数据墨水比的实证批评，
   InfoVis:Wiki 转述 Inbar 2007「过度极简反而更难读」）。
4. **设计系统是「约定 + 文档」，设计令牌是它的可执行原子。**
   令牌至少由「名称 + 值 + 类型」构成、可被别名引用、可跨端解析（`research/1-设计系统与设计令牌.md` §0，
   引 DTCG Format Module 2025.10 §5.1）。

**与本仓治理模式的接合（措辞已校准，避免与 §5 冲突）**：本仓已有一套「真源 / 指针 / 守卫」的治理语言
（`[MGMT-STD-008]`）。本标准把美学也纳入同一模式，但**分清两类真源**：
- **美学语义与命名有真源** —— 即本标准（落地后为 `[DESIGN-FE-012]`）；
- **取值当前分散在各端令牌文件**，尚无单一取值真源 —— §7 Q1/Q2 本轮已裁决：**不收敛到单一取值真源**
  （Q1 定平台基准值 + 端自有偏离；Q2 走轻路径，DTCG 全量派生登记 `deferred`）。故本文仍**不宣称「取值已有真源」**。

**必须尊重的既有审美偏好（`docs/14_维护者/taste.md`，用户原话记录）** —— 本文不得与之冲突：

| taste.md 条目 | 偏好 | 对本标准的影响 |
|---|---|---|
| 行 22 | WelcomeBanner 首屏「呼吸感」，白色空行多比少好（明确要求加到 9 行） | 首屏一次性界面**宽**，反复出现的界面**紧** —— 见原则 KHY-AES-09 |
| 行 20 | FooterBar 紧凑（约 3 行，协作块 ≤2 行），拒绝换行产生的「右侧白条」 | TUI 状态区用**显式列布局**，不靠 `flexWrap` 折行 |
| 行 21 | PROMPT（输入框）必须在 FOOTER（状态栏）之上，代码服从文档几何契约 | TUI 区域顺序是**契约**，不是实现自由 |
| 行 19 | Markdown 水平线（`---`）**静音为空白行**，不要满屏 `───` | 「减噪」优先于「完整还原 Markdown」 |
| 行 60 | `prefers-reduced-motion` 下**降级为直接报告目标**，「假动画是第二种谎言」 | 动效的静态等价物是**义务**，不是可选项 —— 见 KHY-AES-11 |
| 行 63 | khy-mobile **偏好**森林治愈系（嫩叶绿/奶白/大圆角 14–20px/柔和阴影/emoji 图标；原文「Will explicitly request this style when re-skinning」，属换肤时提出的**偏好记录**，非现状） | 移动端允许**端自有**审美，与平台底线并存 —— 见 §4.4 与 §7 Q3（本轮决定） |
| 行 64 | 用**叙事化中文名**替代功能化标签（「森林小屋」/「湖畔工坊」） | 文案属 UX 写作，不在色彩令牌内；本文只记录「允许」 |

---

## 2. khy-os 美学原则

> 每条格式：**原则名 / 一句话 / 理由（为什么单独立这条）/ 出处**。
> 编号 KHY-AES-01…，共 **15** 条。原则面向「怎么算对」，实现与取值落在 §3、§5。

### 底线类（可机判）

#### KHY-AES-01 · 平台基准 + 端自有偏离
- **一句话**：同一语义令牌以**平台基准值**定义（取平台自有端现状），各端派生/映射；偏离基准的端必须登记为**端自有偏离**，禁止**未登记**的自造口径。
- **理由**：现状实测**同名令牌多种值** —— `accent` 在 Web 为 `#2563eb`（`newapi-theme.css` 的 `--khy-primary`）、
  khyquant 为 `#1890ff`（`theme.css` 的 `--khy-primary`）、移动端为 `#2F7EF7`（`app_colors.dart` 的 `AppColors.primary`）、
  桌面端 `--color-primary:#ffffff`（`globals.css` 的 `--color-primary`）。§7 Q1 本轮决定：**Web 为平台基准**、
  khyquant/mobile 为**已登记**端自有偏离、desktop 无对应。不立此条，任何一致性守卫都无处挂载。
- **出处**：`research/1` §2.1（实测三处漂移）/ §2.2 建议 1、2；原则 14「单一真源 + 构建期派生」。
- **落地范围**：本原则**当前仅 Web 端可强制**（见 §0 澄清）；**在桌面/移动端不可强制**。

#### KHY-AES-02 · 令牌三元组 + 名称即路径
- **一句话**：每个令牌具备「名称、值、类型」三要素；名称按维度分组、以点路径寻址。
- **理由**：无类型的裸变量无法被工具跨端解析（DTCG 要求 name+value 必需、类型取有限枚举）；
  本仓既有 `--khy-{category}-{variant}` 已是路径式命名，只需补「类型」一维即可机读。
- **出处**：`research/1` 原则 1、2、3；DTCG Format Module 2025.10 §5.1/§4；`[DESIGN-FE-004]` §3.1 命名约定。

#### KHY-AES-03 · 三层令牌（primitive → semantic → component）
- **一句话**：基础层存原始标度（色阶/间距），语义层描述用途，组件层只引用语义层；**组件不得直接引基础层**。
- **理由**：现状 `newapi-theme.css` 把色阶（`--khy-gray-*`）、角色（`--khy-text-*`）与组件色
  （`--khy-md-*`、`--khy-accent-*`）混在同一 `:root`，无法回答「换个主题要动哪些」。
- **出处**：`research/1` 原则 5；Material 3「key colors → roles → components」；Radix 12 步色阶。

#### KHY-AES-04 · 语义角色命名 + on-* 配对
- **一句话**：令牌名描述「用在哪」而非「是什么颜色」；前景/背景成对命名以表达对比关系。
- **理由**：TUI 侧 `ccTheme.js` 已用 7 个语义 token（`accent/muted/success/warn/danger/border/focus`，
  `ccTheme.js` 的 `SEMANTIC`），但 Web 侧用 `--khy-primary/success/warning/danger`，
  命名**对不上**（`accent`↔`primary`、`warn`↔`warning`）。不统一角色名，跨端对齐无从谈起。
- **出处**：`research/1` 原则 6；`research/3` P6/P7；`ccTheme.js` 的 `CC_COLORS` / `SEMANTIC`；Material `--md-sys-color-on-*` 配对。
- **反例（本条要防的正是这种）**：桌面端 `--color-primary`（`globals.css` 的 `--color-primary`）字面叫「primary」，
  但取值 `#ffffff`、暗色 `#000000`（`globals.css` 暗色块的同名令牌），语义是**主前景/表面色**，不是品牌强调色 ——
  「同名不同义」。本标准的映射表（§3.1）**不**把 canonical `accent` 映射到它。

#### KHY-AES-05 · 双主题成对且必须相异
- **一句话**：每个颜色/阴影令牌在亮、暗两套下都有定义，且两值不得相同。
- **理由**：本仓已有硬守卫在跑 —— `designTokenCompliance.test.js` W1 校验 21 个 critical token
  「在 `:root` 和 `html.dark` 都有定义」且「值不相同」（`designTokenCompliance.test.js` 的 W1 断言）；
  `[DESIGN-FE-004]` §3.2 把「仅定义浅色 → 暗色下静默失效」列为错误。此条是**既有守卫的语义化**，不是新发明。
- **出处**：`research/1` 原则 15；`research/3` P8；`[DESIGN-FE-004]` §3.2；`designTokenCompliance.test.js` W1。

#### KHY-AES-06 · 对比度是硬下限，且与色相无关
- **一句话**：文本与背景的相对亮度比有可机测下限 —— 正文 ≥4.5:1、大字 ≥3:1、UI 组件/图形 ≥3:1；暗色不得降低标准。
- **口径（Q5 本轮决定）**：**WCAG 2.2 双阈值**（SC 1.4.3 / 1.4.11）为**唯一合规口径**；APCA 仅作暗色主题的设计参考、**不入守卫**。口径的机器可读形态见 `AESTHETICS-TOKENS.json` 的 `$meta.contrast`。
- **「硬下限」与执行档的关系（须讲清，防误读）**：「硬下限」= 语义阈值**不可放宽**；其**强制档位随机制阶段升档** —— 对比度断言当前按 **warning（advisory）** 判级，与 FE-004 `gate=advisory`、`PROCESS-008` S1 观察期一致，**当前不会拦截**；升到 S3 后才真正拦截（单点改执行器的阶段常量，不改判定逻辑）。
- **理由**：这是当前**唯一**能把「颜色是否达标」从人工目测变成机器可判的一步（`research/3` §khy-os 现状表 P1/P2 行：`palette.js` 有加权亮度转换但无 WCAG 相对亮度对比度计算）。
- **落地载体（须明确，否则本条落空）**：`check-frontend-design-tokens.js` 是**正则文本扫描器**，**无法**解析 `var()` 实际取值、**算不了**对比度。故对比度断言**不落**在该脚本，也不改 `designTokenCompliance.test.js` 的既有 W1–W4 判定；它落在**新增执行器** `scripts/ci/check-aesthetics.js`。实现**必须**显式做 **var() 链递归解析（带环检测）+ rgba()/hex alpha 合成**，分别取 `:root` 与 `html.dark` 的解析值——**不得**沿用只抽原始字符串的 `extractBlock`（`designTokenCompliance.test.js`）。此执行器**服务既有规则 FE-004**，不是新规则（见 §5）。
- **实现状态（2026-10-15 订正）**：上述载体**已落地并恒不阻断**——`scripts/ci/check-aesthetics.js` 存在、`package.json` 注册 `check:aesthetics`、`STAGE='S1'` 使 error 一律降级 warning 且 exit 恒 0（PROCESS-008 PP-3）。§3.2 规则③指派的**对比度断言亦已实现**：var() 链递归解析 + alpha 合成 + WCAG 2.2 相对亮度比，配对表 `WEB_CONTRAST_PAIRS` / `KHYQUANT_CONTRAST_PAIRS`，按 `CONTRAST_ENDS` 覆盖 Web 与 khyquant 两端，亮暗分别取 `:root` 与 `html.dark`。**当前唯一未闭合项是桌面/移动端扩面**（§7 Q9）：`CONTRAST_ENDS` 只含 web/khyquant，`CHECKED_ENDS` 虽已五端全覆盖，但桌面与移动的令牌文件尚未纳入对比度读取面。§4.3/§4.4 把对比度列为桌面/移动的「平台底线」仍是**目标口径**，其跨端强制依赖 Q9。
- **出处**：`research/1` 原则 8；`research/3` P1/P2/P3；WCAG 2.2 SC 1.4.3 / 1.4.6 / 1.4.11。

#### KHY-AES-07 · 颜色不是唯一的信息载体
- **一句话**：状态与分类一律「颜色 + 符号/图标 + 文字」三重编码，单色终端与色觉缺陷下仍可辨。
- **理由**：现状部分违规 —— 桌面端 `usageCharts.tsx` 用 `--color-trajectory-*` **仅按颜色**区分系列
  （`research/3` §khy-os 现状表 P4 行）；TUI 已有符号体系（`ccTheme.js` 注释「绿=成功、红=错误、黄=警告、灰=系统」）。
- **出处**：`research/2` P16；`research/3` P4/P10/P12；`research/6` P16；WCAG 2.2 SC 1.4.1。

#### KHY-AES-08 · 终端不劫持用户配色，且能降级
- **一句话**：TUI/CLI 颜色按终端能力降级（真彩→256→16→无色），默认继承终端配色、不强制覆盖，尊重 `NO_COLOR`。
- **理由**：本仓**已具备**且方向正确 —— `ccTheme.js` 文件头明写「完全继承终端颜色主题，不强制覆盖」
  （`ccTheme.js` 文件头注释）、`text: undefined`「终端默认前景色（不覆盖）」（`ccTheme.js` 的 `CC_COLORS.text`），
  `resolvePalette()` 走 NO_COLOR/CLICOLOR/colorDepth 三档（`ccTheme.js` 的 `resolvePalette()`）。此条是**固化既有正确做法**，防回归。
- **出处**：`research/2` P2/P3/P15；`ccTheme.js`（文件头注释 / `CC_COLORS.text` / `resolvePalette()`）；NO_COLOR（no-color.org）。

### 取舍类（面向「怎么做减法」）

#### KHY-AES-09 · 密度分面：反复出现者紧，一次性者宽
- **一句话**：同一系统在不同界面采用不同密度档，且以「是否每轮重复出现」为主判据 —— 重复出现的（状态栏、列表、表格）走紧凑，一次性的（首屏、空状态、向导）走宽松。
- **理由**：这条把 taste.md 里两条看似矛盾的偏好统一起来 —— FooterBar「紧凑」（taste 行 20）
  与 WelcomeBanner「呼吸感」（taste 行 22）不是矛盾，而是**分面**的结果。研究也印证：Material 明说默认低密度、
  处理大量信息时切高密度（`research/6` P1）。
- **出处**：`research/6` P1/P5；`research/2` P9；`docs/14_维护者/taste.md` 行 20、22。

#### KHY-AES-10 · 有边界地做减法，不牺牲可读性
- **一句话**：删掉不承载数据的墨（边框、网格、背景），但**不得**以「极简」为由删除轴标题、单位、图例所必需的语境。
- **理由**：研究明确记录了反例 —— 去掉图表上边框会移走一条隐含的 20% 参考线（`research/6` P7 引 Inbar 2007）。
  同源偏好：taste.md 行 19 把 Markdown 水平线静音为空白行，正是「减噪」而非「减信息」。
- **出处**：`research/6` P6/P7；`docs/14_维护者/taste.md` 行 19。

#### KHY-AES-11 · 动效必须有目的、可关、克制
- **一句话**：每处动效答得上「解决什么问题」，答不上就删；非必要动效必须可被 `prefers-reduced-motion` 关闭或替换，且**不靠动画传达唯一信息**。
- **理由**：taste.md 行 60 有明确原话 —— reduce 下「降级为直接报告目标」，「假动画是第二种谎言」。
  研究把它归为「忙状态不得依赖持续动画，须有静态等价物」（`research/5` P2/P8）。
- **出处**：`research/5` P1/P2/P8/P9/P10；`docs/14_维护者/taste.md` 行 60；WCAG 2.2 SC 2.3.3 / 2.3.1。

#### KHY-AES-12 · 状态透明：动作 + 目标 + 进度（**引用** `RUNTIME-002`，不重述）
- **一句话**：状态/spinner 文本须含「动作 + 目标 + 进度」；动画不替代信息。
- **本文只做指针**：三维定义、6 个含糊 token、合法例外清单的**语义真源**是
  `AGENTS.md` 工程规则 2 / `RUNTIME-002`，守卫 `scripts/ci/check-agent-rules.js` 已覆盖。
  按 `[MGMT-STD-008]` §2.2，本文**不复制**其条文；本标准的增量只有一句：
  **任何新增 spinner/脉冲/骨架屏都必须配一段符合该规则的静态文本**（动画不是唯一信息载体）。
- **出处**：`AGENTS.md` 工程规则 2（`RUNTIME-002`）；`research/5` P8；`research/6` P2。

#### KHY-AES-13 · 终端不用滚动区（**引用** `RUNTIME-004`，不重述）
- **一句话**：与回滚输出共存的 CLI 绝不用 ANSI 滚动区（`\x1B[n;mr`）；固定行走光标保存/恢复或 OSC，全屏才进备用屏幕。
- **本文只做指针**：语义真源是 `AGENTS.md` 工程规则 4 / `RUNTIME-004`，守卫 `check-agent-rules.js`
  （DECSTBM 判 error）；本仓落地佐证 `topicBar.js`、`app.js`。本文不复制条文。
- **出处**：`AGENTS.md` 工程规则 4（`RUNTIME-004`）；`research/2` P10；`topicBar.js`、`app.js`。

#### KHY-AES-14 · 排版：有限标度 + 随字号联动 + 中英混排
- **一句话**：字号取有限标度（不随手取整数），行高/字距随字号联动（标题≈1.2、正文 1.5、中文正文 1.6–1.75），中英混排加 ≤1/4 em 字距。
- **理由**：现状 `newapi-theme.css` 的 `--khy-text-xs…2xl` = 12/13/15/17/20/24px
  相邻比约 1.08/1.15/1.13/1.18/1.2，**不是任何比例尺**（`research/4` P1 实测）；
  中英混排 `text-autospace` 全仓未见处理（`research/4` P13）。
- **出处**：`research/4` P1–P8、P13–P15；`research/6` P22；`newapi-theme.css` 的 `--khy-text-*`。

#### KHY-AES-15 · 不新增规则 ID，新要求挂到既有规则
- **一句话**：本标准的新要求以**扩既有执行器**（`check-frontend-design-tokens.js` 的 `exec.findings`）
  或**新增一个服务既有规则的执行器**（`check-aesthetics.js`，服务 FE-004）落地；
  **不新增规则 ID、不建第二套规则真源**。
- **措辞澄清（防自我否定）**：「不新建平行检查器」的准确含义是「**不建与既有规则并行的第二套规则真源**」，
  它**不禁止**为既有规则新增执行器文件。`check-aesthetics.js` 校验的是 FE-004 名下的令牌 schema、
  跨端必需项与对比度，是 FE-004 的**新执行器**，不是新规则。
- **理由**：本仓规则数有棘轮（`PROCESS-014` 三只棘轮之一：「规则 94，新增一条先退役一条」）；
  工作流约束亦明示「绝不新增规则 ID」。且 `[MGMT-STD-008]` §2.2 把「重叠即违规」立为元规则 ——
  两处判定即两份真源。
- **出处**：`AGENTS.md` 规则 12 / `PROCESS-014`；`RULES-REGISTRY.json` meta；`check-frontend-design-tokens.js` 的 `addFinding` 判级口径。

---

## 3. 令牌体系

> 分类依据：`[DESIGN-FE-004]` §3.1 已有 8 类（表面/文本/线条/品牌/状态/几何/阴影/字体），
> 研究补齐 **动效** 与 **图标** 两类（`research/5` 原则 12、`research/1` 原则 12）。
> 机器可读清单见 `docs/10_规范/registry/AESTHETICS-TOKENS.json`。此处只给**必需语义令牌**清单与命名对齐规则。

### 3.1 命名对齐规则（跨端）

**canonical 语义名 → 各端本地名**（本文只声明映射，不改取值）：

| canonical | TUI（`ccTheme.js`） | Web（`newapi-theme.css`） | khyquant（`theme.css`） | 桌面端（`globals.css`） | 移动端（`app_colors.dart`） |
|---|---|---|---|---|---|
| `accent`（品牌/强调） | `accent` / `toolName` | `--khy-primary` | `--khy-primary` | **无对应**（`--color-primary` 实为主前景/表面色 #ffffff/#000000，非品牌色） | `AppColors.primary` |
| `accent-strong` | — | `--khy-primary-strong` | `--khy-primary-strong` | — | `AppColors.primaryStrong` |
| `accent-soft` | — | `--khy-primary-soft` | `--khy-primary-soft` | — | `AppColors.primaryContainer` |
| `success` | `success` | `--khy-success` | `--khy-success` | — | —（自有 M3 角色） |
| `warning` | `warn` | `--khy-warning` | `--khy-warning` | — | — |
| `danger` | `danger` | `--khy-danger` | `--khy-danger` | — | — |
| `info` | `info` | —（缺） | `--khy-info` | — | — |
| `text` | `text`（终端默认前景） | `--khy-text-main` | —（无 `--khy-text-*`） | `--color-foreground` | `onSurfaceLight / onSurfaceDark`（双主题对，无单一名） |
| `text-secondary` / `muted` | `muted` / `textSecondary` | `--khy-text-secondary` | — | — | — |
| `text-strong` | — | `--khy-text-strong` | — | — | — |
| `border` | `border` | `--khy-border` | — | — | — |
| `bg-main` | `background`（终端默认背景） | `--khy-bg-main` | — | `--color-background` | — |
| `focus` | `focus` | `:focus-visible` outline（非令牌） | — | — | — |

> 表中「—」= 该端当前无对应令牌（缺失，进 §6 状态矩阵与 §7，**不代造值**）。
> **khyquant 令牌面**（实测 `theme.css`）：仅有 `--khy-primary*`、`--khy-success`/`--khy-success-50`、
> `--khy-danger`、`--khy-warning`、`--khy-info`、`--khy-gray-*`、`--khy-white`、`--khy-black`；
> **无** `--khy-text-*`/`--khy-bg-*`/`--khy-border-*`（故上表 text 行 khyquant 为「—」）。
> 桌面端 `accent` 映射为**无对应**是刻意的：`--color-primary` 在亮/暗间于 `#ffffff`/`#000000` 翻转
> （`globals.css` 的 `--color-primary`，亮/暗两块同名），语义是主前景/表面色；桌面另有 `--color-accent:#001d3d`（暗色 `#ebf4ff`），
> 但它是**表面着色**而非品牌强调蓝，本文**不**把它当作 `accent` 的品牌载体（无把握不造映射，见 §7 Q1）。

### 3.2 色彩（color）

**必需语义令牌**（required=true）：`accent`、`accent-strong`、`accent-soft`、`on-accent`、
`success`、`warning`、`danger`、`info`、`success-soft`/`warning-soft`/`danger-soft`/`info-soft`（成对淡底）、
`text`、`text-strong`、`text-secondary`、`text-muted`、`border`、`border-light`、`focus`、
`bg-main`、`bg-elevated`、`bg-soft`。

**规则**：①状态四家族固定为 `success/warning/danger/info`（`research/3` P6）；
②每个状态家族成对提供 `*-fg`（文字/图标）与 `*-bg`（淡底），并**按配对校验**对比度（`research/3` P7）；
③正文文字对 ≥4.5:1、大字 ≥3:1、UI 组件/图形 ≥3:1（WCAG 2.2 SC 1.4.3/1.4.11，Q5 本轮决定；APCA 仅暗色设计参考、不入守卫）。

**取值状态**：`accent` 的取值见 §7 Q1（本轮决定）——平台基准值 = Web 现状（亮 `--khy-primary: #2563eb` / 暗 `#3b82f6`）；
khyquant（`#1890ff`）、mobile（`#2F7EF7`）为**端自有偏离**（登记于 registry 的 `endDeviations`）；desktop 无对应。

### 3.3 排版（typography）

**必需令牌**：`font-sans`、`font-mono`、`text-*`（角色 × 档位，至少 `body`/`label`/`title` 三档）、
`leading-*`（至少 `tight`≈1.2 / `normal` 1.5 / `relaxed` 1.6–1.75）、`weight-*`（4 档 400/500/600/700）、
`tracking-*`（至少一正一负）。

**规则**：①字号取固定比例尺（建议 1.2 或 1.25，`research/4` P1）；
②token 内绑定 `size+line-height+weight+tracking` 四元组，禁止只给字号（`research/4` P3）；
③中文正文行高宜 1.6–1.75，勿与英文共用 1.5（`research/4` P14）。

**现状**：Web 有 `--khy-font`/`--khy-font-mono`/`--khy-text-*`/`--khy-leading-*`/`--khy-tracking-tight`（均在 `newapi-theme.css` 的 `:root`），
但无字重令牌、无正向字距、字号非比例尺。

### 3.4 间距（spacing）

**必需令牌**：`space-*` 比例标度（`research/1` P9 建议 `4/8/12/16/24/32/48/64`）。

**规则**：①以 4px 为基准、数值成比例（`research/1` P9）；②组件的 margin/padding/gap 只取令牌值，不写魔法数字；
③工具类映射到令牌（`[DESIGN-FE-004]` §7.1：`.mt-8 → var(--khy-space-2)`）——**注意这是目标态**：`[DESIGN-FE-004]` §7 整节（含该工具类层）在仓内**尚未落地**，实测无任何间距工具类， Utilities 层在代码中不存在。当前可用的只有令牌本身。

**现状**：Web 已有 `--khy-space-1…16 = 4/8/12/16/20/24/32/40/48/64px`（**10 档**，`newapi-theme.css` 的 `--khy-space-1…16`）；
`--khy-gap-page` 引用 `space-5`（`newapi-theme.css` 的 `--khy-gap-page`）。`AESTHETICS-TOKENS.json` 收录全部 10 档。
**注意**：`[DESIGN-FE-001]` §3 与 §12 G5 原写「间距/字号无 token，文档曾虚构 `--khy-space-*`」——
**该表述已过时并于 2026-10-15 订正**：CSS 早已定义，真实缺口是**消费率 0**（`.vue` 中 `--khy-space-*` 0 处引用）。

### 3.5 圆角（radius）

**必需令牌**：`radius-sm`、`radius`（默认）、`radius-lg`、`radius-pill`。

**规则**：有限档位，组件引用档位而非具体像素（`research/1` P10）。

**现状**：Web `--khy-radius-sm:6px / --khy-radius:8px / --khy-radius-lg:16px`（`newapi-theme.css` 的 `--khy-radius*`）；
移动端 `AppRadius.small/medium/large/xLarge = 8/12/16/28`（`app_colors.dart` 的 `AppRadius.*`，**现行 xLarge=28，非 14–20px**）。
**注意**：taste.md 行 63 记录移动端**偏好**更大圆角（14–20px，pill 形）—— 属**换肤时提出的偏好记录**、非现状；与 Web 的 8px 口径不同，属端自有审美（见 §7 Q3，本轮决定）。

### 3.6 阴影（shadow）

**必需令牌**：`shadow`（常态）、`shadow-lift`（悬浮/弹层）、`overlay-shadow`（模态）。

**规则**：①elevation 有限档、与 surface 层级对应（`research/1` P11）；
②暗色主题用「更亮的表面色」而非纯阴影表达层级（`research/1` P11；`research/3` P8）。

**现状**：Web `--khy-shadow`/`--khy-shadow-lift` 亮暗各一套（`newapi-theme.css` 的 `--khy-shadow` / `--khy-shadow-lift`）✓。

### 3.7 动效（motion）

**必需令牌**：`duration-fast/normal/slow`（FE-004 §8.2 定 150/200/300ms）、`ease-standard`（**通用曲线**）、`ease-enter`（入场减速）、`ease-exit`（出场加速）。

**规则**：①时长+缓动成对令牌化（`research/1` P12）；②入场用减速曲线、出场用加速曲线，线性只用于持续/不确定语义（`research/5` P4）；
③`prefers-reduced-motion: reduce` 下时长归零或替换为不触发前庭反应的形式（`research/5` P2）。

**现状**：Web 真源**已补**（Q4 本轮决定）—— `newapi-theme.css` 的 `:root` 已定义
`--khy-duration-fast/normal/slow`（150/200/300ms）与 `--khy-easing-standard/enter/exit`
（逐字照抄 FE-004 §8.2）。**未绑定任何现有过渡**，故既有散落字面量（`0.3s ease`、`0.22s ease`、`0.12s ease`、`0.15s ease`，见 `newapi-theme.css` 的 `body` / `.el-card` hover / `.el-button` / `.el-radio-button__inner` 过渡）**保持原样**，视觉零回归。
**TUI 侧无「时长令牌」**：终端无插值，其节拍（`ccTheme.js` 的 `CC_THEME.animation.spinnerFrames` 盲文字符串、
刷新间隔）由 `RUNTIME-011` / `check-tui-cadence.js` 管辖，**不属本动效令牌**。

### 3.8 图标（icon）

**必需约定**：①尺寸档（至少 `sm`/`md`/`lg`）；②与文字成对时按「功能性图标须 3:1、纯装饰图标可豁免」判定（`research/3` P3）；
③状态图标与语义色**三重编码**（KHY-AES-07）。

**现状**：Web 有 `.khy-brand-logo`/`.khy-icon`（SVG monogram，`newapi-theme.css` 的 `.khy-brand-logo` / `.khy-icon`）；
移动端用 emoji（taste 行 63）；TUI 用符号前缀（`▌●○❯│`，`research/2` P8）。
**当前无统一图标令牌**（进 §6 状态矩阵第 17 行）。

---

## 4. 各端应用规则

### 4.1 TUI / CLI（`runtime/node/backend/src/cli/`）

| 规则 | 依据 |
|---|---|
| 色深四档降级，`NO_COLOR` 只关色不关粗体/下划线 | `research/2` P2/P3；`ccTheme.js` 的 `resolvePalette()` |
| 语义色取 `resolvePalette()` 解算结果，不直接取字面 hex | `ccTheme.js` 的 `CC_COLORS` 注释「组件应取用语义 token」 |
| 不劫持终端配色，`text`/`background` 用终端默认（不覆盖） | `research/2` P15；`ccTheme.js` 的 `CC_COLORS.text` / `CC_COLORS.background` |
| 信息层级靠颜色/字重/缩进，不靠字号；符号前缀词表统一 | `research/2` P8 |
| 不用滚动区；固定行走光标保存/恢复或 OSC；全屏才进备用屏幕 | KHY-AES-13（引用 `RUNTIME-004`）；`topicBar.js`、`app.js` |
| 非 TTY 剥离 ANSI 与动画（CI 日志不成「圣诞树」） | `research/5` P6；`research/6` P19 |
| 状态「符号 + 颜色 + 文字」三重编码 | KHY-AES-07；`research/2` P16 |
| 动画节拍三方一致（规范/默认值/兜底字面量） | `RUNTIME-011`（已有守卫 `check-tui-cadence.js`） |
| 区域顺序：PROMPT 在 FOOTER 之上；首屏宽、状态区紧 | taste.md 行 20、21、22 |

### 4.2 Web（`delivery/web/ai-frontend/`）

| 规则 | 依据 |
|---|---|
| 颜色/圆角/阴影一律 `var(--khy-*)`，禁止字面量 hex | `[DESIGN-FE-004]` §3.1；KHY-AES-01 |
| 双主题强制：`:root` + `html.dark` 成对且相异 | `[DESIGN-FE-004]` §3.2；`designTokenCompliance.test.js` W1 |
| 六层 ITCSS 架构（Base→Tokens→Layout→Components→Utilities→Overrides） | `[DESIGN-FE-004]` §2（**目标态**：Utilities 层在代码中不存在，见 `[DESIGN-FE-004]` §7 顶部标注） |
| BEM 命名 + 作用域前缀（`khy-`/`c-`/`l-`/`u-`/`t-`） | `[DESIGN-FE-004]` §4 |
| 流式值优先 `clamp()` 而非媒体查询 | `[DESIGN-FE-004]` §6.3 |
| `prefers-reduced-motion` 下关闭非必要动画（含骨架屏 shimmer） | `[DESIGN-FE-004]` §8.3；`newapi-theme.css` 的 `@media (prefers-reduced-motion: reduce)`（三处） |
| 正文对比度 ≥4.5:1，双主题各自达标（`--khy-text-muted` 是已知临界项） | `research/3` P2；`[DESIGN-FE-001]` §9 |
| 中英混排启用 `text-autospace`（≤1/4 em） | `research/4` P13；§7 Q8（机制已定：CSS `text-autospace: normal` 渐进增强；本轮不应用，登记 P3） |
| 行宽上限（正文 ≤80 字符 / 中文 40 字） | `research/6` P22 |

### 4.3 桌面端（`apps/khyos-desktop/`）

> ⚠ 本端**当前无美学守卫**（见 §0）；下列规则为「已定义、待接入守卫」。

| 规则 | 依据 |
|---|---|
| 令牌以 Tailwind 4 `@theme` 的 `--color-*` 表达，**须与 canonical 语义名对齐**（`--color-primary` 是主前景/表面色，不得当作品牌强调色） | `research/1` §2.1；`globals.css` 的 `--color-primary` / `--color-accent`（亮/暗两块）；KHY-AES-04 |
| 补齐 `prefers-reduced-motion` 处理（Electron 可用 `nativeTheme` / `matchMedia`） | `research/5` §2 缺口（桌面端 grep 未见处理） |
| 图表序列不得仅按颜色区分 | KHY-AES-07；`research/3` §khy-os 现状表 P4 行（`usageCharts.tsx`） |
| 每张图配等价数据表 | `research/6` P11 |

### 4.4 移动端（`delivery/mobile/khy-os-client-app/`）

> ⚠ 本端**当前无美学守卫执行路径**（见 §0）。

| 规则 | 依据 |
|---|---|
| 平台底线（对比度、颜色非唯一载体、目标尺寸 ≥24×24、`prefers-reduced-motion`）同 Web | `research/3` P3；`research/1` P18；WCAG 2.2 SC 2.5.8 |
| 320 CSS px 可重排，不出现横向滚动（数据表除外） | `research/6` P26；WCAG 2.2 SC 1.4.10 |
| **端自有审美**：允许端自有色板偏离平台色；平台只强制底线（令牌存在性、对比度、颜色非唯一载体、动效可关） | taste.md 行 63；§7 Q3（本轮决定） |
| 独立/远程模式用「模式色条 + 差异化图标」区分，不得仅靠文字 | taste.md 行 61；`research/3` P4 |
| 传感器/手势操作须有按钮等价物且可禁用 | `research/5` P13；WCAG 2.2 SC 2.5.4 |

> **现状（非规则，勿读作要求）**：移动端现行色板为**蓝紫系**（`app_colors.dart` 的 `AppColors.primary #2F7EF7` /
> `secondary #6D5EFC` / `tertiary #D946EF` / `accent #6D5EFC`），**非**森林绿；taste.md 行 63 的森林治愈系是
> **偏好记录**（原文「Will explicitly request this style when re-skinning」，换肤时提出），非现状。色值属端自有，
> 本规则表不写具体色值。

---

## 5. 与既有规范的关系（谁是真源、谁指向谁）

> 依据元规则 `[MGMT-STD-008]` §3.2「正文只做指针+摘要，语义真源另存」。
> 本节的目的是**消歧**：读标准的人应能一眼看出「这条该改哪个文件」。

| 关注点 | 语义真源（谁撰写规则） | 本标准的关系 |
|---|---|---|
| **美学语义与跨端令牌清单**（本文档） | **本标准**（`[DESIGN-FE-012]`） | 真源 |
| **令牌取值（当前）** | **各端令牌文件**（Web `newapi-theme.css` / TUI `ccTheme.js` / 桌面 `globals.css` / 移动 `app_colors.dart` / khyquant `theme.css`） | 本标准是**语义真源**，当前**不是**取值真源；取值漂移的处置已定（§7 Q1：平台基准 + 端自有偏离；Q2：轻路径，不收敛到单一取值真源） |
| **Web CSS 架构**（分层/命名/BEM/响应式/动画参数） | `[DESIGN-FE-004]` | 本标准**引用**，不复制；§3.1/§3.2/§8 与本文 §3 互补 |
| **网页端实测口径与令牌现状速查** | `[DESIGN-FE-001]`（实测对齐版） | 本标准指向它；其 §3/§12 有滞后（见 §6） |
| **目录层级与文档落点** | `[DESIGN-LAY-005]` | 本标准落地文档落 `docs/10_规范/DESIGN-FE/`（`NN_中文/`，编号轴） |
| **状态透明（动作+目标+进度）** | `AGENTS.md` 工程规则 2 / `RUNTIME-002` | KHY-AES-12 只**引用**，守卫 `check-agent-rules.js` 已覆盖 |
| **终端无滚动区** | `AGENTS.md` 工程规则 4 / `RUNTIME-004` | KHY-AES-13 只**引用** |
| **TUI 动画节拍** | `RUNTIME-011` / `[DESIGN-PERF-004]` | §4.1 **引用**，守卫 `check-tui-cadence.js` 已覆盖 |
| **规则登记** | `docs/10_规范/registry/RULES-REGISTRY.json` | 本标准**不新增规则 ID**（KHY-AES-15）；新要求**扩** FE-004 的 `exec.findings` |
| **令牌机器可读真源** | `docs/10_规范/registry/AESTHETICS-TOKENS.json` | 本标准 §3 的机器可读形态 |
| **守卫** | `scripts/ci/check-frontend-design-tokens.js`（Web，LOW）+ `designTokenCompliance.test.js`（W1–W4 vitest 硬断言）+ `scripts/ci/check-aesthetics.js`（已落地并恒不阻断，服务 FE-004：令牌 schema + 跨端必需项存在性 + Web/khyquant 两端对比度断言；桌面/移动对比度扩面待落） | 见下方「三条落地纪律」 |

**三条落地纪律（消解自相矛盾）**：

1. **`check-aesthetics.js` 是既有规则的新执行器，不是新规则。** 它服务 `FE-004`，校验
   `AESTHETICS-TOKENS.json` 的 schema、必需语义令牌在各端令牌文件中的存在性、以及 §3.2 的对比度阈值。
   KHY-AES-15 的「不建第二套规则真源」**不禁止**为既有规则新增执行器文件。该执行器**已落地**
   （`scripts/ci/check-aesthetics.js`，`package.json` 注册 `check:aesthetics`，`STAGE='S1'` ⇒ 恒 exit 0），
   现已实现 schema 校验 + 跨端必需项存在性 + §3.2 对比度阈值（Web/khyquant 两端，var() 链递归解析 + alpha 合成）。
   唯一**待落实现**的是桌面/移动端对比度扩面（§7 Q9）。这消解了旧稿「一边禁止新建检查器、一边点名新建 check-aesthetics.js」的矛盾。
2. **`[DESIGN-FE-012]` 不携带 `RULES-REGISTRY` 标记行。** FE-004 的标记行只在其语义真源
   `[DESIGN-FE-004]` 文档头部（`[DESIGN-FE-004].md:3`）。若 `[DESIGN-FE-012]` 也加
   `<!-- RULES-REGISTRY: FE-004 -->`，`check:rules`（TOOLING-007）的「登记表↔真源双向可达」会出现
   **一规则两真源**，有接线冲突风险。故 `[DESIGN-FE-012]` 作为**伴随/指针文档**存在，**不加**标记行。
3. **既存错位须一并订正**：`RULES-REGISTRY` FE-004 的 `exec.findings` 记为
   `["css-token","bem-naming","dual-theme"]`，但 `check-frontend-design-tokens.js` 实际
   `addFinding` 传的 rule 是 `'FE-004'`/`'A11Y-001'`（脚本的各 `addFinding` 调用），
   **并无** css-token/bem-naming/dual-theme 这三个 finding 名。扩 `exec.findings` 时须一并把这两个真源对齐。

**关键澄清（避免两套真源）**：本仓**已有两个**前端设计守卫，职责不同 ——
`check-frontend-design-tokens.js` 是 CI 侧软检查（`addFinding` 仅 CRITICAL/HIGH 置 exit=1，LOW/MEDIUM 不阻断，见其判级口径），
`designTokenCompliance.test.js` 是 vitest 硬断言（W1 双主题成对/W2 `--khy-white`/W3 无字面量 hex 基线 999/W4 `--el-*`→`--khy-*`）。
本标准落地**不新造**第二个「前端样式」检查器；`check-aesthetics.js` 现已实现**令牌 schema + 跨端必需项存在性 + Web/khyquant 两端对比度**（对比度断言的实现细节见 §7 Q5），职责与前两者不重叠。

---

## 6. 状态矩阵（文档 / 实现 / CI 强制）

> 三列口径：**文档** = 规范里写没写；**实现** = 仓内代码有没有对应；**CI 强制** = 有没有守卫会因它变红。
> 图例：✓ 有 · ⚠ 部分/弱 · ✗ 无 · (P) 待落地（本标准提出）。
> 每格证据来自本次真实读取（见各节出处）。**CI 强制列只对 Web 端可信** —— 桌面/移动端无守卫路径（§0）。

| # | 美学项 | 文档 | 实现 | CI 强制 |
|---|---|---|---|---|
| 1 | 令牌命名 `--khy-*` | ✓ FE-004 §3.1 | ✓ `newapi-theme.css`（120 个唯一 `--khy-*`） | ✓ 弱 `check-frontend-design-tokens.js`（LOW）+ W4 硬断言 |
| 2 | 双主题成对且相异 | ✓ FE-004 §3.2 | ⚠ Web ✓ / TUI 明暗成对（`ccTheme.js`）/ CLI JSON 无亮色主题（Q6：补亮色登记 P3） | ✓ W1（**仅 Web**）；TUI/CLI ✗ |
| 3 | 无字面量 hex | ✓ FE-004 §3.1 | ⚠ 存量庞大（W3 基线 **999**） | ✓ W3 回归基线（只降不升）+ `check-frontend-design-tokens` LOW |
| 4 | 语义色角色令牌 | ✓ 本标准 + `ccTheme.js` 的 `CC_COLORS` 注释 | ✓ TUI 7 token / ✓ Web `--khy-*` | ⚠ W1 critical 列表部分覆盖 |
| 5 | 跨端语义名对齐 | ✓ 本标准 §3.1 + registry `endDeviations`（Q1 本轮决定） | ⚠ 平台基准已定（Web）；`warn`↔`warning` 等命名差异登记为端自有（Q1 不强制同值） | ✗（Q9 决定扩守卫，代码待落） |
| 6 | 对比度阈值（4.5/3/3） | ✓ 本标准 §3.2 规则③ + registry `$meta.contrast`（Q5 本轮决定：WCAG 2.2 双阈值） | ✓ `check-aesthetics.js` 已落地对比度断言（`relativeLuminance`/`contrastRatio` + var() 链解析 + alpha 合成），按 `WEB_CONTRAST_PAIRS`/`KHYQUANT_CONTRAST_PAIRS` 覆盖 Web 与 khyquant 亮暗两端；⚠ 桌面/移动未纳入（Q9 待落） | ⚠ 已按 warning/advisory 判级并挂在 S1 观察期（`STAGE='S1'` ⇒ error 降级 warning、exit 恒 0） |
| 7 | 颜色非唯一载体 | ✓ 本标准 KHY-AES-07 | ⚠ TUI ✓（符号体系）/ 桌面 ✗（`usageCharts` 仅色） | ✗ |
| 8 | 终端色深降级 + `NO_COLOR` | ✓ 本标准 KHY-AES-08 | ✓ `ccTheme.js` + `terminalCapabilities.js` | ✗（无 TUI 色板守卫） |
| 9 | 密度分面 | (P) 本标准 KHY-AES-09 | ⚠ 部分（TUI spacing 常量） | ✗ |
| 10 | 动效令牌 | ✓ FE-004 §8.2 + 本标准 §3.7（Q4 本轮决定：standard/enter/exit 三条） | ✓ `newapi-theme.css` 的 `:root` 已定义 `--khy-duration-*` / `--khy-easing-*`（未绑定现有过渡，视觉零回归） | ⚠ `check-aesthetics.js` 存在性校验（未接门） |
| 11 | `prefers-reduced-motion` | ✓ FE-004 §8.3 | ⚠ Web ✓ / 桌面 ✗（研究 5 缺口） | ✗ |
| 12 | 状态透明（动作+目标+进度） | ✓ AGENTS 规则 2 / RUNTIME-002 | ✓ 广泛实现 | ✓ `check-agent-rules.js`（含糊 token 判 warning） |
| 13 | 终端无滚动区 | ✓ AGENTS 规则 4 / RUNTIME-004 | ✓ `topicBar.js`/`app.js` | ✓ `check-agent-rules.js`（DECSTBM 判 error） |
| 14 | TUI 动画节拍一致 | ✓ RUNTIME-011 / DESIGN-PERF-004 | ⚠ `perfTunables`（Spinner 160 已知漂移） | ✓ `check-tui-cadence.js`（S1 观察者） |
| 15 | 排版比例尺 | ⚠ FE-004 §3.1 命名；研究 4 详述 | ⚠ `--khy-text-*` 非比例尺；无字重/正字距令牌 | ✗ |
| 16 | 中英混排 `text-autospace` | ✓ 本标准 §4.2 + §7 Q8（机制已定：CSS 渐进增强） | ✗（Q8 本轮不应用，登记 P3——应用即视觉变化，须人验收） | ✗（渲染期行为，不入守卫） |
| 17 | 图标令牌 | ✗（无统一约定） | ⚠ Web SVG / 移动 emoji / TUI 符号 | ✗ |
| 18 | 令牌机器可读真源 | ✓ 本标准 §3 + registry（Q2 本轮决定：轻路径） | ✓ `AESTHETICS-TOKENS.json`（Q1/Q2/Q4 已补齐）；DTCG 全量派生登记 `deferred`（P3） | ⚠ `check-aesthetics.js` schema 校验（未接门） |

**读法**：第 11、15、16 行是**文档写了但实现/CI 没跟上**的项（真实缺口，非本文新要求）；
第 5、9、18 行是**本文提出的增量**（(P)）。第 2 行是「同一要求在不同端覆盖不均」的典型。
第 10 行本轮已由 Q4 补齐实现（Web 真源已定义动效令牌）。
第 6 行（对比度）**已实现**：`check-aesthetics.js` 落地了 `relativeLuminance`/`contrastRatio`，
覆盖 Web 与 khyquant 的亮暗两端，判级 warning/advisory、挂 S1 观察期；**唯一未闭合项**是
桌面/移动两端尚未纳入对比度读取面（Q9）。载体见 KHY-AES-06 / §5 纪律 1。

---

## 7. 已决问题

> **2026-10-14 本轮裁决**：Q1–Q9 全部落定。每条**保留原问题描述**，并补「**决定** / **理由** / **证据** / **落地物**」。
> 标「**本轮决定**」者 = 本轮工作流给出的决定，**非维护者的人类裁决**；§7 原设的「最终追认权」仍在维护者
> —— 尤其 Q1 的品牌色取值，本轮只登记平台基准与端自有偏离，**改值须维护者追认**。
> 凡「落地物」中标注**待落实现**的，是本轮只登记决定、代码/登记表改动另行落地。

### Q1 · 品牌主色 `accent`/`--khy-primary` 取哪个值？——**本轮决定**

**原问题**：现状四端四值：Web `#2563eb`（`newapi-theme.css` 的 `--khy-primary`）、khyquant `#1890ff`（`theme.css` 的 `--khy-primary`）、移动端 `#2F7EF7`（`app_colors.dart` 的 `AppColors.primary`）、桌面端 `--color-primary:#ffffff`（`globals.css` 的 `--color-primary`，且该令牌语义是主前景色、非品牌色）。改品牌色是人的决定。

**决定（本轮决定，非人类裁决）**：
- canonical `accent` 的**平台基准值 = Web 现状**（亮 `--khy-primary: #2563eb` / 暗 `#3b82f6`，同属基准端，暗色配对**不算**偏离）。
- **四端不强制同值**：khyquant `#1890ff`、移动端 `#2F7EF7` 登记为**端自有色板偏离**（非错误，本轮不改值）。
- 桌面端**不**映射到 `--color-brand`，保持 `surfaces.desktop = null`。
- 行号引用不再重算，改为**全量换内容锚点**（跨文件引用用令牌名/选择器名）。

**理由**：平台自身图形界面是 Web（`delivery/web/ai-frontend`），其品牌色即平台口径（`newapi-theme.css` 注释「低饱和度，ZCode 对齐」）；khyquant 依 `AGENTS.md` 是独立项目，移动端为端自有；强行同值＝改值＝视觉回归。桌面端不映射依据是代码事实：`--color-brand` 亮 `#000000`/暗 `#ffffff`，用作 `--color-input-border-focused` 与焦点环，仅在 `.khy-tui` 作用域内变暖橙——当 accent 会重演 KHY-AES-04 自己警告的「同名不同义」。

**证据**：行号漂移为**三段**（`newapi-theme.css` 三处插入 7+4+2=13 行：文件头、亮色块 `--khy-on-primary`、暗色块 `--khy-on-primary`），故原始 ≤82 → **+7**、83–268 → **+11**、≥269 → **+13**；`ccTheme.js` 整体 **+9**（文件头 9 行）。实测：标准原引 `newapi-theme.css:345,491,700-701,726`，实际过渡字面量在 `:358/:504/:713/:739`（全 +13）；registry 引 `:561-572`，实际 `.status-dot` 在 `:574`。规模：registry `newapi-theme.css:` 43 处 + `ccTheme.js:` 12 处；标准 12 处。

**落地物**：
1. registry `color.accent`：`value` → `"#2563eb"`、新增 `valueDark: "#3b82f6"`、新增 `endDeviations`（khyquant/mobile 登记、desktop `null`）；`surfaces.desktop` 保持 `null`。
2. registry `$meta.valueSemantics` 增 `baseline` 态、`$meta.shape` 同步。
3. 修正 **KHY-AES-01**（§2）：改为「平台基准 + 端自有偏离」，补「桌面/移动端不可强制」。
4. §7 Q1 标「本轮决定」；品牌色最终取值**待维护者追认**。
5. **行号引用改内容锚点（全量）**：registry 与标准中跨文件的 `文件:行号` 一律换成令牌名/选择器名（如 `newapi-theme.css` 的 `--khy-primary`、`ccTheme.js` 的 `SEMANTIC.accent`）。
6. 四端令牌文件（`newapi-theme.css` / `theme.css` / `app_colors.dart` / `globals.css`）**取值一字不动**。

**未采纳**：把四端收敛到同一值（＝改值＝视觉回归）；把 `--color-accent`（桌面）当品牌蓝。

### Q2 · 采纳「DTCG 单一真源 + 构建期派生五端」的重架构，还是先走「补齐 + 标注 + 守卫」轻路径？——**本轮决定**

**原问题**：研究 1 §2.2 建议全量派生（把 `newapi-theme.css`/`ccTheme.js`/`themes/*.json`/`app_colors.dart` 全部降级为**产物**）。但这与「绝不动任何现有令牌取值、视觉零回归」冲突 —— 派生会把现有取值整体迁移，任一映射错即视觉回归。

**决定**：走**轻路径**（补齐 + 标注 + 守卫），**不采纳**「DTCG 单一真源 + 构建期派生五端」的重架构。DTCG 全量派生登记为 **P3 未来项（deferred）**，本轮不实施。

**理由**：重架构会把五端现有取值整体迁移为产物，任一端映射错即视觉回归——与「视觉零回归」硬约束正面冲突，且收益（跨端同值）在当前尚无第二主题/皮肤需求时为零。

**证据**：标准 §7 Q2 原文（全量派生「把现有取值整体迁移，任一映射错即视觉回归」）；`AESTHETICS-TOKENS.json` `$meta` 已把「语义真源」与「取值真源」分为两类。

**落地物**：
1. 不动任何现有令牌文件的取值。
2. registry `$meta` 增 `deferred` 数组（`dtcg-single-source-derivation`，P3）。
3. 同次提交改 `$meta.shape`（含 `deferred` / `endDeviations`）与 `$meta.note`。
4. 标准 §1 与 §7 Q2 回写：本轮取轻路径；取值真源仍归各端。
5. 「补齐」范围严格限定为「补守卫缺口 + 订正文档滞后」，不新增/不改动任何令牌取值。

**未采纳**：全量派生（登记 `deferred`，触发条件见 registry）。

### Q3 · 移动端「森林治愈系」审美是否写进本标准作为强制？——**本轮决定**

**原问题**：taste.md 行 63 记录的是 **khy-mobile 项目**的偏好（嫩叶绿/奶白/大圆角/emoji），与平台 Web 的低饱和度蓝口径（`--khy-primary:#2563eb`）**不同**。是把「端自有审美 + 平台底线并存」写进 §4.4，还是要求移动端也收敛到平台色板？

**决定**：**不强制**森林治愈系。§4.4 维持「平台强制底线（令牌存在性、对比度、颜色非唯一载体、动效可关）+ 项目自有色板允许偏离平台色」。**并纠正标准里的现状描述**：taste.md 行 63 是**偏好记录**（原文「Will explicitly request this style when re-skinning」），**非**移动端现状；现行 `app_colors.dart` 是**蓝紫系**（primary `#2F7EF7` / secondary `#6D5EFC` / tertiary `#D946EF` / accent `#6D5EFC`）。现状描述移出规则表本体，措辞统一为「端自有」。

**理由**：taste.md 是偏好台账而非实现现状（行 63 自述「重新换肤时会要求」，属未来时）；代码事实是 `app_colors.dart` 全为蓝紫、`lib/` 下零森林色板。平台只该强制可机判底线；色相/色板属端自有。

**证据**：`docs/14_维护者/taste.md` 行 63；`app_colors.dart` 的 `AppColors.primary` / `secondary` / `tertiary` / `accent`；标准 §4.4；registry `radius-pill` rationale。实测 `grep -rniE "6fa978|f4f1e6|6ea4b8|forest|森林|嫩叶|奶白" delivery/mobile/khy-os-client-app/lib/` → 零命中。

**落地物**：
1. §4.4 规则表该行改为纯规则（不写具体色值）；现行色板进脚注。
2. §1 表「采用」→「偏好」。
3. §3.5 与 registry `radius-pill` rationale 保留「偏好」并补「现行 `AppRadius.xLarge=28`，非 14–20px」。
4. 措辞统一「端自有」（`AGENTS.md` 只豁免 khyquant；标准 §0 把移动端列为 khy-os 五端之一）。
5. §7 Q3 标「本轮决定」；「要求移动端收敛到平台色板」记为**未采纳**。
6. `app_colors.dart` **一字不动**。

**未采纳**：强制森林治愈系；要求移动端收敛到平台色板。

### Q4 · 是否本轮补入 Web 动效令牌（`--khy-duration-*`/`--khy-easing-*`）？——**本轮决定**

**原问题**：`[DESIGN-FE-004]` §8.2 已定义这些令牌（时长 150/200/300ms），但 `newapi-theme.css` 未落地（仅散落字面量）。补入 = 给现有过渡绑定取值，触碰「视觉零回归」边界。

**决定**：**补 Web 动效令牌**，且按 FE-004 §8.2 / 标准 §3.7 补全**三条缓动**（standard/enter/exit），不只 standard+exit；并订正 registry 的 canonical 语义（新增 `ease-enter`、把 `ease-standard` 从「入场减速」改为「**通用曲线**」）。取值照抄 FE-004 §8.2；**只在 `:root` 定义**；**不动任何现有过渡字面量**。视觉零回归。

**理由**：registry 把 `ease-standard` 的 rationale 错标为「入场减速」，而 FE-004 §8.2 的入场曲线是 `--khy-easing-enter`、`--khy-easing-standard` 是通用曲线；用 standard 顶 enter 会把非入场曲线登记成入场语义。标准 §3.7 与 FE-004 §8.2 都点名 standard/enter/exit 三条，registry 是唯一漏掉 enter 的一方。

**证据**：FE-004 §8.2（`--khy-easing-standard: cubic-bezier(0.4,0,0.2,1)` / `--khy-easing-enter: cubic-bezier(0,0,0.2,1)` / `--khy-easing-exit: cubic-bezier(0.4,0,1,1)`）；registry 原 `ease-standard` rationale「入场减速」。

**落地物**：
1. `newapi-theme.css` 的 `:root`（`--khy-shadow-lift` 之后）新增 6 个令牌（duration-fast/normal/slow、easing-standard/enter/exit），逐字照抄 FE-004 §8.2；**不**加进 `html.dark`（非颜色/阴影）。
2. registry `motion` 新增 `ease-enter`（required、`surfaces.web=--khy-easing-enter`）；订正 `ease-standard` rationale 为「通用曲线」；`ease-exit` 举例对齐 FE-004。
3. 回填 `motion.duration-*` 与 `ease-*` 的 `surfaces.web`。
4. 订正 registry 三处滞后（删「Web 真源缺失」表述）；标准 §3.7 与 §6 行 10 更新。
5. 复跑 `check-aesthetics.js`：motion 的 web 缺失 warning 消失、新增 1 条 `ease-enter` tui warning（预期，与 `ease-standard`/`ease-exit` 同类）。

**未采纳**：把动效令牌加进 `html.dark`；改动任何现有过渡字面量。

### Q5 · 对比度守卫的合规口径？——**本轮决定**

**原问题**：本文建议 **WCAG 2.2 双阈值为合规口径**（正文 4.5:1 / 大字 3:1 / UI 3:1），APCA 仅作暗色主题的设计补充（研究 3 P5：APCA 是 WCAG 3 候选、**非规范**）。且 TUI 侧当前**无对比度断言**。

**决定**：**WCAG 2.2 双阈值**（正文 ≥4.5:1、大字 ≥3:1、UI 组件/图形 ≥3:1）为**唯一合规口径**；APCA 仅暗色设计参考、**不入守卫**。并修正两点落地缺口：(a) 断言实现须显式交代 **var() 链递归解析 + alpha 合成**，不能沿用只抽原始字符串的 `extractBlock`；(b) 判级为 **warning（advisory）**，并在标准里把「硬下限」与 S1 观察期/advisory 的关系写明。

**理由**：WCAG 2.2 双阈值可机测、APCA 为非规范候选。`newapi-theme.css` 大量值经 `var()` 别名 + `rgba()`/`color-mix()` 表达，而设计测试的 `extractBlock`/`extractCustomProps` 只抽原始字符串、不解析取值，故对比度断言必须自建 var() 链解析与 alpha 合成。KHY-AES-06 称「硬下限」而机制整体是 advisory/S1，判级只能 warning。

**证据**：`newapi-theme.css` 的 `--khy-bg-elevated: var(--khy-white)` / `--khy-on-primary: var(--khy-white)` / `--khy-ripple: color-mix(...)` / `--khy-overlay-shadow: rgba(...)`；`designTokenCompliance.test.js` 的 `extractCustomProps`/`extractBlock`（只抽原始字符串）；FE-004 `gate=advisory`。

**落地物**：
1. 口径写定于 §3.2 规则③ + registry `$meta.contrast`（本轮已落）。
2. `check-aesthetics.js` 新增对比度计算须显式做 var() 链递归解析（带环检测）+ alpha 合成（**已实现**：`relativeLuminance`/`contrastRatio`/`resolveToken` + `composite`）。
3. 判级 warning（advisory）；标准 §3.2/§6 写明「硬下限 = 语义阈值不可放宽；强制档随阶段升档，当前 S1=advisory」。
4. 订正标准 §5 与脚本头注释关于「脚本是否含对比度」的矛盾（**已落**：脚本头注释现已写明 contrast 在管）。
5. khyquant/TUI/桌面/移动只做存在性、不做对比度断言（**部分已落**：khyquant 已纳入 `KHYQUANT_CONTRAST_PAIRS`；TUI/桌面/移动仍只做存在性，属 Q9 未闭合项）。

**未采纳**：APCA 入守卫；对比度判 error。

### Q6 · CLI 是否补一套亮色 JSON 主题？——**本轮决定**

**原问题**：现状 `runtime/node/backend/src/cli/themes/*.json` 8 套主题**全是暗色取向**（`default.json` 标签「Claude Dark」、`solarized` 标签「Solarized Dark」）。`ccTheme.js` 已有 `*Light` 变体可据此抽出亮色主题，但补主题 = 新增取值。

**决定**：**本轮不补** CLI 亮色 JSON 主题，登记 **P3**。

**理由**：8 套 CLI 主题实测全为暗色取向，补亮色＝新增一组未经人验收的颜色取值，而 TUI 侧当前无任何色板守卫可校验它，且 §0 明示视觉重绘须人眼验收。在「视觉零回归」硬约束下，最稳的取法是不新增取值。

**证据**：`cli/themes/` 下 8 套 JSON（Claude Dark / Dracula / Forest Green / Monochrome / Nord / Ocean Blue / Solarized Dark / Sunset Warm，均暗色取向）；`ccTheme.js` 的 `*Light` 变体；标准 §6 第 8 行「无 TUI 色板守卫」。

**落地物**：
1. 本轮不改 `cli/themes/`，不新增亮色 JSON 主题。
2. §7 Q6 标注 **P3 待办**，附条件：补亮色须先有 TUI 色板守卫（或走人工视觉验收）。

**未采纳**：本轮补亮色主题。

### Q7 · 是否新增规则 ID，还是扩既有 FE-004？——**本轮决定**

**原问题**：本文按 KHY-AES-15 主张**不新增**（规则数棘轮 + 工作流约束），把新要求挂到 FE-004 的 `exec.findings` 与新执行器 `check-aesthetics.js`。但「美学标准」是否值得一条独立规则 ID（如 `FE-005`）须人定 —— 若新增，须同步 `RULES-REGISTRY.json` 与退役另一条。

**决定**：**不新增规则 ID**。三条做法 (a)(b)(c)，但对 (b) 作两处必要修正：(b-1) 落地面从 quality-gate 的 `STAGES`/`MODE_STAGES` 改为 `.github/workflows/pr-gate.yml` 的**显式 step**（前者无任何自动调用者，接了也不会跑）；(b-2) `check-aesthetics.js` 必须先加 `STAGE='S1'` 常量并把 schema error 降级为 warning（恒 exit 0），否则接进任何 CI 步骤都有红门风险。

**理由**：规则数有棘轮（`PROCESS-014`：规则 94，新增一条先退役一条）+ `[MGMT-STD-008]` §2.2「重叠即违规」，且 `exec.script` 是单值 schema，加第二执行器必改 schema → 否决新规则 ID。quality-gate 与 `check:changed`/`check:all-standards` 全无调用者、FE-004 `gate=advisory` 又被 ruleguard 全档排除，唯一能让守卫真跑起来的落地面就是 `pr-gate.yml` 的显式 step。

**证据**：`RULES-REGISTRY.json` FE-004 条目（`exec.script` 单值、`gate='advisory'`）；`grep -rn "quality:gate\|check:quality-gates\|quality:pr" .github/ works/build/githooks/` → 零命中；`check:aesthetics` 在 `package.json` 注册但 `grep -rn "check:aesthetics" scripts/ .github/ works/build/githooks/` 无 workflow/hook 命中。

**落地物（均待落实现，本轮只登记决定）**：
- (a) 扩 FE-004 的 `paths`/`scope`（精确落点见 Q9）。
- (b-1) `pr-gate.yml` 新增 step `Check aesthetics tokens`。
- (b-2) `check-aesthetics.js` 顶部加 `STAGE='S1'` 与降级逻辑（照抄 `check-agent-feedback.js`）。
- (c) `FEATURE-OWNERSHIP.json` 的 `rollout.mechanisms[]` 增 `aesthetics-tokens-guard` 条目（S1）。
- (d) 不改 `RULES-REGISTRY.json` 的 `exec`。
- (e) 订正标准 §5 与 §7 Q9 中「`check-aesthetics.js` 不存在」的过时表述。

**未采纳**：新增规则 ID（如 `FE-005`）；接进无调用者的 quality-gate。

### Q8 · 中英混排 `text-autospace` 的实现方式？——**本轮决定**

**原问题**：CSS `text-autospace` 浏览器支持度不一；备选是 JS 自动空格。且它是**渲染期行为**，守卫难判。

**决定**：实现方式 = CSS `text-autospace: normal` 作**渐进增强**（支持的浏览器生效、不支持者回退现状）；**JS 自动空格方案不采用**；**不纳入守卫强制**（渲染期行为、浏览器支持度不一、无法静态判定）。**但本轮不应用**（应用即视觉变化），整项登记 **P3**。

**理由**：CSS `text-autospace` 是标准的渐进增强形态；JS 方案要侵入渲染、成本高且更脆。它本质是渲染期行为，静态守卫无法可靠判定。一旦应用就是一次真实视觉变化，按 §0 须人验收。

**证据**：全仓 `grep text-autospace` 仅命中 `apps/khyos-desktop/node_modules/csstype/index.d.ts`（第三方类型定义），无源码使用；标准 §4.2 与 §6 第 16 行。

**落地物**：
1. 机制决定：CSS `text-autospace: normal` 渐进增强；JS 方案标注不采用。
2. 本轮不把 `text-autospace` 写入任何 Web 样式文件。
3. §7 Q8 记 **P3**：整项待人工验收后应用；不入守卫。

**未采纳**：JS 自动空格；纳入守卫强制。

### Q9 · 是否把美学守卫范围扩到桌面端与移动端？——**本轮决定**

**原问题**：现状唯一执行器 `check-frontend-design-tokens.js` 只扫 Web/khyquant/ui-shared 三处，`RULES-REGISTRY` FE-004 的 `scope`/`paths` 亦然。故 KHY-AES-01~04 的「跨端一致」在桌面/移动端**无可强制**。扩范围 = 触碰 FE-004 的 `scope`（登记表变更），且桌面/移动的令牌表达（Tailwind `@theme` / Dart 常量）需各自写解析器。

**决定**：**扩**。守卫增扫桌面（`globals.css` 的 `--color-*`）与移动（`app_colors.dart` 的 `AppColors.*`），只做**存在性检查**（不做对比度）。取法比建议更精确：对 desktop/mobile 只校验「**已声明（非 null）的本地名是否真实存在**」；**null 视为「该端未确立映射」，不产生 warning**。同步 FE-004 的 `paths`/`scope`，但落点收窄为**两端的令牌文件目录**，不是整棵源码树。null 语义分叉须同时写进 registry `$meta`，并同步订正标准 §3.1。

**理由**：扩范围收益可验证、噪声可控：实测桌面 3 个声明名全存在（0 新 warning），移动 11 个中仅 1 条真缺口。若对 null 也报警，会一次性新增 76 条「该端本来就没此令牌」的噪声，把门刷成长红。

**证据**：`check-aesthetics.js` 的 `CHECKED_ENDS = ENDS`（五端全扫，2026-10-15 订正：旧稿记为 `['tui','web']`，实况已含 desktop/mobile）；桌面 `globals.css` 的 `--color-background` / `--color-primary-foreground` / `--color-foreground` 全部命中；移动 `app_colors.dart` 的 11 个声明名中**唯独 `AppColors.text` 不存在**（该文件用 `onSurfaceLight` / `onSurfaceDark` 表达前景色，是双主题对）；registry 中 desktop=null 42 个、mobile=null 34 个（required=true）。

**落地物**：
1. `check-aesthetics.js`：`CHECKED_ENDS` 扩为五端；desktop/mobile 令牌文件读取与存在性校验（**已实现**：`readText(DESKTOP_THEME_REL)` / `readText(MOBILE_THEME_REL)` + `collectColorTokens` 正则抽 `--color-*` + 移动点路径词边界）。
2. desktop/mobile 分支仅在 decl 非 null 且查不到时发 warning；decl 为 null 时跳过（**已实现**，且按 `$meta.nullSemantics` 逐端口径分流：tui/web 记 info、desktop/mobile 静默跳过）。
3. `changedTouchesRelevant()` 的相关文件集加入两端令牌文件（**已实现**）。
4. `RULES-REGISTRY.json` FE-004 的 `scope`/`paths` 各增两端令牌文件目录；constraint 补限定句（**待落实现**）。
5. registry `$meta` 增 `nullSemantics`（**本轮已落**）。
6. 一并订正两处真源不一致（**本轮已落**）：①`color.on-accent.surfaces.web` → `--khy-on-primary`；②`color.text.surfaces.mobile` → `null`。
7. 同步订正标准 §3.1 的移动端 `text` 格 → `onSurfaceLight / onSurfaceDark`（**本轮已落**）。
8. 不选「在 `app_colors.dart` 新增 `AppColors.text` 常量」这条路（属设计决定，不在守卫扩范围名义下顺带做）。

**未采纳**：对 null 也报警；扩到整棵源码树；新增 `AppColors.text`。

---

## 8. 参考

- 研究结论（本仓）：`.khy/aesthetics/research/1-设计系统与设计令牌.md` … `6-信息密度与数据可视化.md`
- 既有规范：`[DESIGN-FE-004]`（Web CSS 架构）、`[DESIGN-FE-001]`（网页端实测口径）、`[DESIGN-LAY-005]`（目录层级）
- 既有守卫：`scripts/ci/check-frontend-design-tokens.js`、`delivery/web/ai-frontend/src/__tests__/designTokenCompliance.test.js`（W1–W4）
- 既有令牌文件：`runtime/node/backend/src/cli/tui/theme/ccTheme.js`、`delivery/web/ai-frontend/src/styles/newapi-theme.css`、
  `apps/khyos-desktop/src/renderer/theme/globals.css`、`delivery/mobile/khy-os-client-app/lib/ui/theme/app_colors.dart`、
  `delivery/channel/khyquant/frontend/src/styles/theme.css`
- 用户偏好：`docs/14_维护者/taste.md`
- 登记表风格：`docs/10_规范/registry/RULES-REGISTRY.json`
- 外部规范（研究文件已逐条引证）：W3C WCAG 2.2、APCA、W3C DTCG Format Module 2025.10、W3C clreq、
  Material 3（经 `material-components/material-web`）、IBM Carbon、GitHub Primer、charmbracelet lipgloss/bubbletea、
  ratatui、clig.dev、NO_COLOR。
