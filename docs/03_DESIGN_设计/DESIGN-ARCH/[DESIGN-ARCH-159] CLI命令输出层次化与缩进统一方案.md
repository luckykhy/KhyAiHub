# 《khy-os CLI 命令输出层次化与缩进统一方案》

> 文档编号：DESIGN-ARCH-159
> 状态：**提案**（未实施）
> 范围：`services/backend/src/cli/**` 中 handler 层的命令输出排版（console 系）；**不含** TUI ink 渲染族与模型输出卫生层
> 上游依赖：无（纯新建一个纯叶子模块 + 既有模块接线）
> 调研指针：`[DESIGN-ARCH-128] 结构化输出方案`（输出卫生层，本提案只消费不重复建）、`[DESIGN-ARCH-122] TUI 设计族总纲`（TUI 侧，本提案不碰）、`[DESIGN-SOURCING-001]`（B-P2 判定）
> 规则依据：RUNTIME-008（新机制落地阶段可校验·S1 只记录）、LAYOUT-005（新文件落点）、`check-leaf-contract.js`（纯叶子纪律）
> 取证时间：2026-09-26（全部 file:line 实测于当日工作区）

---

## 0. 一句话结论

khy CLI 的命令输出**有行级原语、没有块级原语**——`formatters.js` 提供了 printSuccess/printTable/printDivider，但「分组标题 → 条目 → 详情 → 建议」这种层次结构没有任何抽象，导致 90+ 个 handler 各自手写缩进、各造对齐、各定截断，**四个实测命令呈现四套互不相识的输出范式**。本方案新建一个纯叶子模块 `outputBlock.js`（五原语：分组/条目对齐/详情缩进/截断/空值省略），先接三个试点命令，再渐进推广，守卫 S1 只记录。

### 病灶速览

| # | 病灶 | 一眼证据 |
|---|---|---|
| P1 | 四套输出范式并存 | `khy hq status` / `khy help` / `khy modules` / `khy insights` 四种排版互不相识 |
| P2 | 缩进深度靠手写空格字面量 | `doctorCmdc.js` 同一函数内 2/9/11 三档空格 |
| P3 | 中文标签 padEnd 对不齐 | `hq.js:163` `padEnd(8)` 补中文「严重」 |
| P4 | 截断无省略号规范 | `hq.js:164` `slice(0, 36)` 硬切中文标题 |
| P5 | 空值行照样渲染 | `hq status`「OpenCode 擅长: 」（空 strengths） |
| P6 | 分隔线宽度无单一来源 | `hq.js` 同文件 `repeat(62)` 与 `repeat(50)` 并存 |
| P7 | Markdown 裸直出终端 | `insights.js:37` `console.log(text)`，`#`/`##` 是字面字符 |

---

## 1. 现状实证（2026-09-26 实测，全部可复核）

### 1.1 四套范式并存（真实输出采样，`NO_COLOR=1` 下抓取）

| 命令 | 实际范式 | 层次表达方式 |
|---|---|---|
| `khy hq status` | 【】分组标题顶格 + 条目 2 空格 | `【Bug】共 17 条` → `  BUG-001 [closed] P1 严重 …` |
| `khy help` | 分组名顶格 + 条目 4 空格 + `─` 线 | `核心` → `    app list…` |
| `khy modules` | cli-table3 画框表格 + 2 空格外框 | `┌──┬──┐` 全框 |
| `khy insights` | **裸 Markdown 文本直出** | `# 会话洞见` `## 概览` `- 消息总数:8` |

同一终端会话里，用户每敲一个新命令都要重新学习一次「这屏怎么读」。

### 1.2 逐病灶 file:line

**P2 缩进字面量散布**（`console.log('  …')` 模式在 `src/cli/**` 命中 40+ 文件）：

| 位置 | 实证 |
|---|---|
| `handlers/doctorCmdc.js:366-370` | 条目行 2 空格、详情行 **9** 空格、修复行 **9+2=11** 空格——三档深度全为字面量，无常量、无语义名 |
| `handlers/hq.js:553-558` | 手写 2 空格与 4 空格两档（「下一步」清单） |
| 命中大户 | `docs.js` 58 处、`publish.js` 36 处、`cleanup.js` 18 处、`commit.js` 17 处（2026-09-26 grep 计数） |

**P3 CJK 对齐失效**——`formatters.js` 明明有 CJK 感知三件套，handler 不用：

| 实证 | 说明 |
|---|---|
| `handlers/hq.js:163` | `_severityLabel(b.severity).padEnd(8)`——「严重」显示宽 4 列，`padEnd` 按 code unit 只补 6 空格，中文标签列**永远差 2 列** |
| `handlers/hq.js:186` | `${m.display}.padEnd(12)` 同病（display 含中文时） |
| 既有能力 | `displayWidth()`（`formatters.js:354`）、`padToWidth()`（`formatters.js:372`）、`truncateToWidth()`（`formatters.js:469`）——**能力齐全，接线为零** |

**P3 加重项：同文件三个并行 pad 实现**（「不新建并行真源」原则的既有债务）：

| 位置 | 形态 |
|---|---|
| `formatters.js:372` | `padToWidth(str, targetWidth, fill)`——canonical |
| `formatters.js:865` | `padLabel = (s) => s + ' '.repeat(10 - displayWidth(s))`——printBacktestResult 局部重造 |
| `formatters.js:926` | `pad = (s, w) => …displayWidth(s)`——printHelp 又一个局部重造 |

**P4 截断无规范**：

- `handlers/hq.js:164/179`：`String(t.title).slice(0, 36)`——按 code unit 硬切，中文标题被切在字中间，无 `…` 提示「还有后文」；
- `handlers/hq.js:744`：`slice(0, 80)` 同病。

**P5 空值行照渲染**：

- `handlers/hq.js:184-186`：模型路由组里 `strengths` 为空的条目照样输出 `OpenCode     擅长: `（冒号后空白）。违背治理体系反复强调的「列表数据没有就不渲染该分组，不塞示例项充数」原则。

**P6 分隔线宽度无单一来源**：

| 位置 | 宽度 |
|---|---|
| `handlers/hq.js:147` | `'='.repeat(62)`（status 头部） |
| `handlers/hq.js:700` | `'='.repeat(50)`（同文件另一处） |
| `formatters.js:931` | `'─'.repeat(min(contentW, 56))`（help） |

**P7 Markdown 直出**：

- `handlers/insights.js:37`：`console.log(text)` 一把梭，`text` 是 `#`/`##`/`-`/`>` 构成的 Markdown 源串——终端里这些是字面字符，层次感为零。已核实该 handler 无 `--json`/文件输出分支（2026-09-26 grep：json/writeFile/stdout.write 零命中），改排版不影响任何其他消费方。

### 1.3 与相邻规范的关系（边界）

| 相邻规范 | 它管什么 | 本提案 |
|---|---|---|
| `[DESIGN-ARCH-128]` | 模型输出的**卫生层**（ANSI 剥净、Markdown 定界符语义渲染） | 只消费其成果（`ansiSanitizer`/`markdownRenderer`），不重建 |
| `[DESIGN-ARCH-122]`/`[152]`/`[155]` | TUI ink 渲染族 | **不碰**。本提案只管 console 系命令输出 |
| `tableStyle.js` | 边框风格单一真源（borderless/有框，`KHY_TABLE_BORDERS`） | 复用其风格判定，块形态跟随（有框=左竖线块语言，无框=红色左竖条，先例 `formatters.js:582`） |

---

## 2. 借鉴提案（B-P2 七字段）

**判定：非借鉴类，豁免成立。** 本提案统一本仓自身的命令输出排版，不引入任何外部项目的代码、结论或结构；`formatters.js` 中既有的 "Claude Code aligned layout" 注释是**已落地的历史事实**，本提案不新增借鉴对象。依据 `[DESIGN-SOURCING-001]` §3 B-P1：零借鉴 ⇒ B-P2 本就不触发（第 1 字段「借鉴对象」无从填写）。以下按七字段体例逐项据实声明，参照 `[DESIGN-ARCH-149]` §2 先例：

| # | 字段 | 声明 |
|---|---|---|
| 1 | 借鉴对象 | **不适用**。零外部借鉴（依据见上） |
| 2 | 借鉴内容 | **不适用**。所有视觉语言（左竖条、`✓/✗` 行前缀、【】标题）均取自本仓既有实现 |
| 3 | 解决的问题 | khy CLI 命令输出层次结构缺失（§1 七病灶），用户原话「终端输出结构不够层次化，缩进设计这些不方便阅读」 |
| 4 | 许可证与代码性质 | **不适用**。不引入任何上游代码/二进制/资源 |
| 5 | 借鉴方式 | **不适用**。无借鉴对象即无方式 |
| 6 | 落点与现有实现对比 | 落点=新增 `src/cli/outputBlock.js` + 三个试点 handler 接线；现有同类实现=「块级原语」**不存在**（§1.2 已证：行级原语齐全、块级为零，`formatters.js` 三个并行 pad 属于待收敛的债务而非 canonical 扩展点）。对齐/截断能力**扩展既有 canonical**（`displayWidth`/`padToWidth`/`truncateToWidth`），不另造 |
| 7 | 验收方式 | §7（可复现命令 + 实测基线） |

---

## 3. 目标形态

### 3.1 新模块：`services/backend/src/cli/outputBlock.js`

**纯叶子纪律**（`check-leaf-contract.js` 强制）：零 IO、确定性、绝不抛、绝不读 env、不改入参；风格参数（borderless 与否）由**调用方传入**。**只返回 `string[]`，绝不 `console.log`**——打印权在调用方（与 `chatChords.js` 同款纪律）。

**缩进模型**（单一真源常量，禁字面量）：

```js
const INDENT = { SECTION: 0, ITEM: 2, DETAIL: 4, NESTED: 6 }; // 列，显示宽度计
```

**五原语 API 契约**：

```js
// 1) 分组：标题 + 子行数组 → string[]；children 为空 → 返回 []（空组不渲染，钉死 P5）
renderSection({ title, children })            // → string[]

// 2) 条目：徽标列 CJK 感知对齐（内部走 padToWidth，钉死 P3）
renderItem({ badge, subject, summary, badgeWidth })  // → string（单行）

// 3) 详情/嵌套：按 INDENT.DETAIL/NESTED 缩进；超宽走 truncateToWidth + '…'（钉死 P2/P4）
renderDetail(text, { indent = INDENT.DETAIL, maxWidth }) // → string

// 4) 分隔线：宽度单一来源（终端宽派生，钉死 P6）
renderRule({ width })                          // → string

// 5) 空值省略谓词：供 handler 的数据组装用
omitEmpty(rows, predicate)                     // → rows | []
```

### 3.2 视觉规范（目标形态，ANSI 色彩表达，浅深主题通用）

```
【模型路由】 共 4 条                                    ← L0 标题：bold + cyan（保留【】语言）
  Claude Code   [擅长]  refactor, quality              ← L1 条目：2sp，徽标列 padToWidth 对齐
    详见 .ai/hq/MODELS.json                            ← L2 详情：4sp + dim
    → khy gateway model 可切换                          ← L2 建议：4sp + '→' + cyan
──────────────────────────────────────────             ← 分隔线：renderRule 单一宽度
```

- 表格型数据（如 `khy modules` 的模块清单）**不硬套层级**——cli-table3 表格是对的，保持；
- 真正的自由 Markdown 文本（模型回复）仍走 `[DESIGN-ARCH-128]` 的 `markdownRenderer`，**不归本模块**；
- `insights` 这类「我们自己的结构化数据被拼成 markdown 字符串再直出」的命令，正解是**直接用块原语组装**（数据本来就是我们自己的，绕道 markdown 是多此一举）；
- 文案中文、不引入 emoji（沿用 `formatters.js:3` 与 ICON_* 表既有约定）。

### 3.3 接线形态（试点命令改后读感）

`khy hq status`（修 P3/P4/P5/P6）：徽标列 CJK 对齐、标题截断带 `…`、空 strengths 模型整行消失、头部线走 renderRule。

`khy doctor cmdc`（修 P2）：2/9/11 手写空格 → INDENT.ITEM/DETAIL/NESTED 三常量，视觉结果与现状**逐字节等宽**（9→4 的列变化需在期2 快照对比里单独标注为「刻意变化」）。

`khy insights`（修 P7）：`# 会话洞见` 直出 → renderSection 分组 + renderItem 条目，`> 起始诉求` 缩进引用块。

---

## 4. 实施分期（每期独立可回滚）

| 期 | 内容 | 回滚单位 | 风险 |
|---|---|---|---|
| **期1 原语层** | 新建 `outputBlock.js` + `tests/cli/outputBlock.test.js`（node:test 写法，覆盖：缩进常量、CJK 徽标对齐、截断省略号、空组省略、borderless 两档风格、fail-soft 畸形输入） | 删两个文件即回滚 | 零（不接线） |
| **期2 三试点接线** | `hq status` / `doctor cmdc` / `insights` 三个 handler 改走块原语；before/after 输出快照落盘 `.khy/tmp/` 对照 | 每命令一个独立改动，可单独回滚 | 低（三命令互不相干；`hqWriteErrno.test.js` 5/5 基线作回归锚点） |
| **期3 推广+守卫** | ①按 §1.2 命中数排序迁移高频命令（docs/publish/cleanup/commit…）；②新守卫 `check-cli-output-lint.js` **S1 只记录不阻断**：识别 handler 新增的 `console.log('  ` 字面量缩进、非 ASCII 字符串上的 `.padEnd(`、无省略号 `.slice(0,` 三模式；③收敛 `formatters.js` 三个并行 pad 到 `padToWidth`（顺手修，单独登记） | 每命令独立；守卫可 PAUSED | 中（面广 ⇒ 分批小步） |

---

## 5. 诚实边界（刻意不纳入）

| 不做什么 | 原因 |
|---|---|
| 不动 TUI ink 渲染族 | `[DESIGN-ARCH-122]`/`[152]`/`[155]` 已管辖；TUI 有自己的帧管线契约（156）。混做=回归面不可控 |
| 不重建输出卫生/Markdown 语义渲染 | `[DESIGN-ARCH-128]` 已建（ansiSanitizer/markdownRenderer），本提案只消费 |
| 不强迁全部 90+ handler | 一次大扫除的回归面不可控；期3 渐进 + 守卫防**新增**债务即可 |
| 不做表格型数据的层级化 | 表格就是表格（modules 的 cli-table3 是正确用法） |
| 不加新 env 门 | 风格开关复用既有 `KHY_TABLE_BORDERS`（tableStyle 单一真源）；`check-tui-gates.js` MAX_GATES=220 只降不升，且「让功能变正确」不构成加门权衡 |
| 不修 `hqStore.test.js` jest 存量红与 `hqReviewGate.test.js` 挂起 | 与渲染无关的存量债务（2026-09-26 实测：前者 `describe is not defined` 型 1 fail，后者 240s 超时）；应另立条目，不在本提案混做 |
| 不给 `printBanner`/启动屏动刀 | 已由 `[DESIGN-ARCH-134]`（启动屏视觉）与 chromeBudget 体系管辖 |

---

## 6. 反模式（这条路别走）

| ❌ 别做 | 为什么 |
|---|---|
| 造「输出 DSL / 模板引擎」 | 五原语覆盖全部实测病灶；YAGNI——病灶清单里没有一个需要嵌套模板才表达得了 |
| 让 `outputBlock.js` 自己 `console.log` | 纯叶子才可测（check-leaf-contract 拦截）；打印权在调用方意味着快照测试可以纯字符串断言 |
| 继续在 handler 里 `padEnd` 中文标签 | code unit ≠ 显示宽度，「看起来对齐」在中文标签上**永远**是错觉（P3 病根；必须走 `padToWidth`） |
| 为「统一」把表格命令也改成缩进树 | 表格数据的正确形态是表格；层级原语只服务「分组-条目-详情」型数据 |
| 把 markdownRenderer 搬进 handler 修 P7 | insights 的数据是**我们自己的结构化数据**，绕道 markdown 序列化再渲染是两次多余变换；块原语直接组装。只有「真自由文本」才归 markdownRenderer |
| 一次 PR 迁移几十个命令 | 回归面爆炸 + 归因不可能（本仓并行会话常态）；必须小步分批，每批带 before/after 快照 |
| 新增 `KHY_OUTPUT_*` env 做风格开关 | 撞门预算棘轮；且 tableStyle 已是风格单一真源，再开一个门=第二个真源 |

---

## 7. 验收方式（可复现命令 + 实测基线）

### 7.1 期1

```bash
"<node>" --test services/backend/tests/cli/outputBlock.test.js   # 全绿（计数以落地实测为准）
"<node>" scripts/ci/check-leaf-contract.js services/backend/src/cli/outputBlock.js
# → "Leaf-contract check passed: no violations found."
```

### 7.2 期2

```bash
"<node>" --test services/backend/tests/cli/hqWriteErrno.test.js
# 基线（2026-09-26 实测）：# tests 5 / # pass 5 / # fail 0 ——改后必须仍是 5/5
```

- 三个试点命令 before/after 输出快照落盘 `.khy/tmp/output-before.txt` / `output-after.txt` 对照；
- `khy hq status`：空 strengths 模型行**消失**；徽标列对齐用 `displayWidth` 断言每行等宽；
- `khy insights`：输出中不再出现字面 `#`/`##` 行首字符。

### 7.3 期3

- `check-cli-output-lint.js` 跑于 S1 模式：exit=0 只记录不阻断（RUNTIME-008 阶段纪律）；
- `npm run check-tui-gates.js` 计数与改动前零漂移（本方案零新增 `KHY_` token）；
- 新测试文件一律 `require('node:test')`（CI 全量扫描纪律：`services/backend/tests/**` 落地即绿）。

### 7.4 明确限制（如实声明）

真字节几何断言只在本地生效（`test:tui` 不在 CI）——本方案的输出快照对比同理，CI 只保证「不红」，视觉效果以本地快照对照为准。

---

## 8. 待核实项

| # | 项 | 状态 | 结论 |
|---|---|---|---|
| 1 | 试点命令有无既有渲染层测试 | **已核（2026-09-26）** | 无渲染层测试；`hqWriteErrno` 5/5 绿为回归锚点；`hqStore` jest 红 / `hqReviewGate` 挂起为存量，排除出回归面 |
| 2 | insights 有无非终端消费方 | **已核（2026-09-26）** | 无 json/文件/管道分支，改排版零外溢 |
| 3 | doctor cmdc 有无 e2e 断言输出格式的测试 | 期2 落地前 Grep `tests/` 引用 `doctorCmdc` | 不阻断设计 |
| 4 | 守卫「非 ASCII padEnd」规则全仓误报率 | 期3 落地前统计（存量命中若 >200 处，S1 只记录**新文件新增行**，不算存量） | 不阻断设计 |

---

## 9. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-09-26 | 初版提案（取证 → 编号 159 → 落盘，同日完成） |
