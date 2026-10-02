# [RESEARCH-020] 差距①实施计划：Token 预算正向语义（target + nudge 续跑）

> 日期：2026-09-29。
> 差距来源：[RESEARCH-019] 差距汇总表 #1 —— 「token budget 只有截停语义，缺 CC 的接近目标注入 nudge 继续的正向语义」。
> 上游素材：《Claude Code 源码架构深度解析 V2.0》§7.3 Token Budget。
> 状态：**计划稿，未开工**。开工前需客户确认文末 3 个拍板点。

---

## 一、现状核实（代码即真源，均已现场复核）

| 事实 | 位置 | 说明 |
|---|---|---|
| 预算叶子已存在且健康 | `src/services/tokenBudget.js`（247 行，纯叶：零 I/O、确定性、fail-soft、门关逐字节回退） | `resolveBudget` / `extractTokenCount` / `assessBudget`（ok/warn/stop）/ `buildBudgetStopNotice` / `parseTokenBudget` / `resolvePromptBudget` |
| 在提示词内指令已解析 | `tokenBudget.js:124-210` | `+500k` / `use 2M tokens` 三种识别式是 CC 逐字移植，默认开（`KHY_PROMPT_TOKEN_BUDGET`） |
| **in-prompt 指令被当上限接线** | `src/services/tool/toolUseLoopCore.js:1937-1941`：`_tokenBudgetCfg.ceiling = _promptCeiling` | 语义错位：CC 中「+500k」是**目标**（朝它干），khy 现在当**上限**（到它停） |
| **warn 档是死代码** | `toolUseLoopCore.js:2119-2160` 只有 `_verdict.state === 'stop'` 一个消费点；全文件无 `'warn'` 消费 | `warnRatio`（默认 0.8）算了但永远没人读 |
| stop 语义健康，保留不动 | `toolUseLoopCore.js:2125-2158`：不额外烧模型调用、合成收尾 + `budgetStopped: true` | 这是「保险丝」，与目标语义共存 |
| nudge 注入形态模板 | `src/services/domain/query/query/shortStopContinuation.js` | 纯叶子 + 单次封顶 + 默认关（opt-in）+ `isEnabled` 委托 flagRegistry、不可用时逐字节回退 |
| goal 级拦截已存在 | `src/services/goalStopGate.js`（默认开） | 与本计划的 budget nudge 是**两个独立驱动源**，须防双重续跑 |
| 既有单测 | `tests/services/tokenBudget.test.js` | 直接扩，不新建机制 |

**结论**：缺口不是「没有预算系统」，而是「预算系统只有负向半边」。改动 = 给 in-prompt 目标补正向语义 + 激活 warn 死档。

---

## 二、需求五问（`RUNTIME-008` 草案，`source` 待客户原话回填）

| # | 问 | 草案答 | source |
|---|---|---|---|
| 1 | 谁用？ | 在提示里写「+500k 写份详尽报告」的用户——明确表达「往这个量干」的人 | 待客户原话 |
| 2 | 什么时候用？ | agent 循环**自然终局点**（模型不再调用工具、准备返回 finalResponse）且本轮目标未达 | 待客户原话 |
| 3 | 现在的替代做法？ | 用户手动说「继续」，或重发消息。每次都要人盯 | 待客户原话 |
| 4 | 成功长什么样？ | 见 §六验收判据（命令 + 期望输出） | 待客户原话 |
| 5 | 不做会怎样？ | 「+500k」指令语义倒置：用户要的是详尽，系统却拿来当停止线；warn 档永远无人消费 | 待客户原话 |

> 按规则 6，落 `.khy/feedback/<task-id>/requirement-5q.md` 时每条须带 `source: <用户原话>`，否则判 `self-answered`。

---

## 三、语义设计：ceiling 与 target 双轨分离

核心裁决：**两种预算来源，两种语义，互不串线。**

| 来源 | 语义 | 行为 |
|---|---|---|
| `KHY_TOKEN_BUDGET`（env 上限） | **保险丝**（成本控制意图） | 只有 warn→提示、stop→截停。永不触发 nudge 续跑（用户设上限的意图是省钱，不是烧钱） |
| 提示内 `+500k` / `use 2M tokens` | **目标**（详尽度意图，CC 原语义） | ① 同时仍作保险丝（stop 照旧）；② 新增：模型想停但 `spent < target` → 注入 nudge 让它继续，单次封顶 |

为什么 nudge 不作用于 env 上限：env 设了 500k 上限的用户，在 400k 时被系统「鼓励」继续烧到 500k，是荒谬的。CC 的 `tokenBudget.ts` nudge 也只服务 in-prompt 目标。

### nudge 判定条件（全部满足才续跑）

1. 本轮预算来自 **in-prompt 指令**（来源标记 `_budgetSource === 'prompt'`，接线时置位）；
2. 模型回复**不含 tool_use**（自然终局意图）；
3. `spent < ceiling`（还没到停止线）；
4. 本 turn nudge 已用次数 < `maxNudges`（默认 1，见 §九代决）；
5. `KHY_TOKEN_BUDGET_NUDGE` 开关开（**默认关**，opt-in）；
6. goalStopGate 本轮**未**驱动续跑（防双重驱动：同一轮只许一个「再来一轮」源，goalStopGate 优先）。

### nudge 文案（防灌水条款必须写进去）

```
[SYSTEM: 预算续跑] 本轮 token 目标 500k，已用 340k。若任务确已完成，请直接给出最终结论并
明确说明「已完成」，**不要为凑预算灌水**；若仍有未完成的实质工作（未读的代码、未跑的验证、
未写的章节），请继续推进并优先完成它。
```

诚实条款（「已完成就直说，不许凑字」）是弱模型场景的护栏——否则 nudge 退化为 token 焚化炉。

### warn 档激活（顺手修死代码）

`state === 'warn'` 且本轮尚未提醒过 → 在状态行/HUD 一次性输出：
`预算提醒: 已用 410k/500k（剩 90k），来源 KHY_TOKEN_BUDGET`。
纯告知，不拦截、不注入模型上下文——符合规则 2「动作+目标+进度」。

---

## 四、改动集（4 文件 + 1 测试，刻意极小）

| 文件 | 改动 | 量级 |
|---|---|---|
| **新增** `src/services/tokenBudgetNudge.js` | 纯叶子：`isEnabled(env)`（**自包含 opt-in 解析：仅 `'true'\|'1'` 开**，不委托 flagRegistry，理由见 §十二 实施中发现）/ `shouldNudge({budgetSource, spent, ceiling, nudgesUsed, maxNudges, hadToolCalls, goalGateDroveRedrive})` / `buildNudgeMessage({spent, ceiling, round})` / `buildWarnNotice({spent, ceiling, source})` | ~150 行 |
| `src/services/tokenBudget.js` | 叶子内**语义修正 + 新导出**：`resolvePromptBudget` 返回值改 `{ceiling, source:'prompt'}`（或加 `resolvePromptBudget2`，避免破坏现有调用点）；其余不动 | ~15 行 |
| `src/services/tool/toolUseLoopCore.js` | 接线两处极小缝：① `:1937-1941` 置 `_budgetSource`；② 自然终局 return 之前（`:2260`/`:2311` 一带，**实施时以符号锚点现场定位**，勿硬依赖行号）插 `shouldNudge` 分支：push nudge 消息进 `conversationMessages`、`nudgesUsed++`、`continue`（新 continue 点）。③ `:2125` 同块加 warn 一次性提醒 | ~50 行 |
| `src/services/goalStopGate.js` | 只读取其本轮是否已 redrive 的标记（若无现成返回，由接线点局部变量传递，**不改此文件**） | 0 行（优先） |
| `tests/services/tokenBudget.test.js` | 新增叶子测试：门关逐字节回退 / 六条件矩阵 / env 上限永不 nudge / 封顶生效 | ~120 行 |

**不改**：`tokenBudget.js` 的 stop 路径、`shortStopContinuation.js`、HUD 之外的任何渲染层。

### 新增开关

| env | 默认 | 语义 |
|---|---|---|
| `KHY_TOKEN_BUDGET_NUDGE` | **关**（仅 `'true'\|'1'` 开） | nudge 总开关；门关 = 现行为逐字节保持。**不委托 flagRegistry**（见 §十二） |
| `KHY_TOKEN_BUDGET_NUDGE_MAX` | 1，clamp [0,10] | 单 turn nudge 上限（对齐 goalStopGate redrive=1；§九代决已把计划原拟 2 下调为 1） |

> ~~注册进 flagRegistry~~ **实施中作废**，改自包含 opt-in 解析——原因见 §十二「实施中发现」。

---

## 五、实施步骤（含每步验证）

1. **S0 存证建档**（规则 6/5）：建 `.khy/feedback/token-budget-nudge/`，回填需求五问（需客户原话）+ `mode.json` 声明 BUILD 模态。
2. **S1 纯叶子**：写 `tokenBudgetNudge.js` + 单测。验证：`node -e "require('./services/backend/src/services/tokenBudgetNudge')"`；跑该测试文件全绿且**断言输入>0**（防空转套件）。
3. **S2 基线留档**：门关状态跑一次真实回合记录输出，作 before 存证（`repro-before.txt`，即便这是新增不是修复，升档评审要用）。
4. **S3 接线**：toolUseLoopCore 三处缝 + `_budgetSource`。验证：`node --check` 语法 + 既有 loop 相关测试套件不红（注意：ink 套件有 5 个作者 in-flight 红族，与本改动无关，不背锅也不修）。
5. **S4 开关门实测**：`KHY_TOKEN_BUDGET_NUDGE=1` 跑 §六验收命令，观察 breadcrumb `token-budget-nudge` ×≤2、最终回复、总用量；门关复跑同命令，diff 输出应逐字节等于 S2。
6. **S5 规则自检 + 文档**：`node scripts/ci/check-agent-rules.js --changed` 零新增 error；更新 [RESEARCH-019] 差距表 #1 状态为「已实现（默认关）」；CHANGELOG 段按 `### Added` 记（MINOR，是否 bump 由客户按 `PROCESS-005` 决定，**本改动不自动 bump**）。

**前置闸门（硬性）**：`toolUseLoopCore.js` 是 `#7` god-file 重构标的。若实施时该文件仍处 ` M`/`A ` in-flight 态（本项目共享 worktree 有活跃重构与 nightly 进程），接线改动**必须等作者重构落定**，或由客户明示允许并行改。叶子（S1）不受此闸门约束，可先行。

---

## 六、验收判据（命令 + 期望输出）

```bash
KHY_TOKEN_BUDGET_NUDGE=1 KHY_PROMPT_TOKEN_BUDGET=1 \
  node services/backend/bin/khy.js ai "+60k 请分章节详细解释事件循环的六个阶段"
```

期望（全部命中即 PASS）：

1. 输出流中出现 ≤2 次预算续跑状态行，形如
   `预算续跑 1/2：已用 34k/60k，继续未完成部分`（含动作+目标+进度，规则 2）；
2. 最终回复为分章节长文，且模型若认为已写完会**直接说完成并停止**（nudge 未被用满即为诚实条款生效的证据）；
3. 用量 HUD/统计里本轮总 token ≥ 首次自然停止点（对比门无关测）；
4. **无 nudge 死循环**：nudge 次数恒 ≤ `KHY_TOKEN_BUDGET_NUDGE_MAX`；
5. 门关回归：同命令去掉 `KHY_TOKEN_BUDGET_NUDGE=1`，输出与本改动前基线逐字节一致；
6. `KHY_TOKEN_BUDGET=50000`（纯 env 上限）场景：只出现 warn 提醒与 stop 截停，**永不**出现 nudge 续跑。

---

## 七、风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 弱模型为「凑预算」灌水烧钱 | 中 | nudge 文案内置诚实条款；`maxNudges=2` 封顶；默认关门控住爆炸半径 |
| 与 goalStopGate 双重驱动同轮续跑 | 中 | 条件 6：goalGate redrive 优先，同轮互斥；实施时若发现 goalGate 有自带计数器，复用其「单轮一次」纪律 |
| 接线落在 #7 重构热点文件，冲突/回滚难 | 高 | 前置闸门（S3 前检查 git status）；接线 diff ≤50 行、独立函数块，可整体撤回；叶子先行 |
| `resolvePromptBudget` 返回值形状变更破坏既有调用点 | 低 | 实施前 `grep -rn "resolvePromptBudget" src/` 全量核调用点；有顾虑就加新函数不改旧签名 |
| nudge 注入消息污染 conversationMessages 的压缩/投影 | 低 | 文案以 `[SYSTEM: 预算续跑]` 前缀标识，与既有 `[SYSTEM: 续写]` 同族；对照 ccMessageProjection 契约（本项目 HCI/投影有镜像纪律）确认投影层不把它当用户消息展示 |
| 触及红线 R1 | 无 | 本计划只到「计划」；commit/push 一律人工执行 |

---

## 八、合规自检卡

- **规则 1 零硬编码**：新增全是阈值默认与文案，无端点/路径字面量 ✔
- **规则 2 状态透明**：nudge/warn 文案含动作+目标+进度；错误路径复用 `buildBudgetStopNotice` 既有样式 ✔
- **规则 3 活动式超时**：不新增任何 `setTimeout`；nudge 封顶是**计数**不是计时 ✔
- **规则 4 终端渲染**：不引入新转义序列，warn 提醒走既有状态行通道 ✔
- **规则 6 新增先提问**：本计划 §二即五问草案，实施前须回填客户原话出处 ✔（待客户）
- **规则 8 落地阶段**：非拦截型门（不阻断 AI/CI），opt-in 开关即天然 S1 观察形态，不占 FEATURE-OWNERSHIP 门档 ✔
- **规则 12 棘轮**：不新增 CLI 命令/别名/handler/规则条目 ✔
- **版本**：不动 9 真源；发布时按 CHANGELOG `Added`→MINOR 走 `PROCESS-005`（人工点头）✔

---

## 九、拍板结论（客户授权代决 2026-09-29，source:「由你决定」）

客户把三点交给我定，取保守档：

1. **默认关（opt-in）**。多烧钱的特性不默认生效。`KHY_TOKEN_BUDGET_NUDGE` 关时逐字节回退现状。
   > 代决 `source: 客户「由你决定」`；规则 6 的 Q1/Q2 用户角色与时机据此回填，非客户逐字原话，评审时按「代决」标注。
2. **maxNudges 默认 = 1**（计划原拟 2，下调）。对齐 `goalStopGate` 单轮 redrive=1。nudge 语义是「提醒一次继续未完成的工作」，**不是**「把预算烧到上限」；诚实条款已允许模型「已完成就直说」，一次 nudge 后仍想停即视为真完成，不该再推。`KHY_TOKEN_BUDGET_NUDGE_MAX` 仍可 env 覆盖，clamp [0,10]。
3. **warn 仅终端状态行一次性提示**。HUD 已有同源预算显示（`hudRenderer.js:484`），不新增常驻元素，避免重复渲染与改动面扩大。

工作量估计：叶子+测试 半天，接线+实测 半天，合计 **~1 人日**（不含等 #7 落定的挂起时间）。

---

## 十、实施进度（本文件随做随更）

- [x] 拍板三点（§九）：默认关 / maxNudges=1 / warn 仅状态行一次性提示
- [x] `tokenBudgetNudge.js` 叶子 + 单测（18/18 绿；既有 tokenBudget 33/33、flagRegistry 自测 4/4 无回归；`check-agent-rules.js --changed` 0 违规）
- [ ] `toolUseLoopCore.js` 接线（**已确认闸门未开**：`git status` 实测该文件 ` M` 15+/10- 在途——#7 重构未落定，接线挂起）
- [ ] 门关回归 + 门开实测（§六验收 6 条，须接线后）
- [ ] 更新 [RESEARCH-019] 差距表 #1 状态；CHANGELOG `Added` 段（须接线后）

**当前交付物（未提交，R1 红线：人工执行 commit）**：
`services/backend/src/services/tokenBudgetNudge.js`（叶子）、
`services/backend/tests/services/tokenBudgetNudge.test.js`（单测）。

---

## 十二、实施中发现（回写计划）

**flagRegistry 目录未跟踪且活跃再生 → 放弃委托，改自包含门控。**

登记 flag 时实测发现 `src/utils/flagRegistry/`（真源目录，非那个 tracked shim）：

1. 整目录 `git status` = `??`（**未跟踪**，`git ls-files` 为空）；
2. 非 gitignore；index.js 321KB，README.html mtime 08:37 / index.js 08:40——会话期间被**活跃进程翻动**（非本次编辑所为），属 #7 重建/再生 territory。

由此暴露一个**语义反噬**风险：`isFlagEnabled` 对「未登记的 name 保守放行为 **true**」（其 index.js:21 注释自陈）。若把 `KHY_TOKEN_BUDGET_NUDGE` 登记进去、而后再生把登记抹掉，委托分支会返回 true → 本门**误判为默认开**，与「默认关」红线相悖；且叶子 catch 兜底救不了「返回错值」（catch 只在抛错时触发）。

**裁决**：改**自包含 opt-in 解析**（仅 `'true'|'1'` 开），零外部依赖，语义恒定。这同时是**更正确的兄弟先例**——`tokenBudget.js` 自己的 `KHY_TOKEN_BUDGET` / `KHY_PROMPT_TOKEN_BUDGET` 门本就是手写 off 词表、从不碰注册表。计划 §四 原「委托+回退双保险」据此作废。

**待人工定夺**：待 #7 落定、flagRegistry 转为 tracked 后，是否把该 flag 补登记进注册表以统一口径（登记与否都不影响门语义，只影响「flag 清单可发现性」）。届时若登记，须同步把 `isEnabled` 改回「委托优先 + 本自包含逻辑为兜底」，保持单一真源。

**未动他人文件**：曾对 flagRegistry/index.js 加过一条登记，发现上述问题后**已原样撤回**（grep 计数 0、语法校验通过、其自测 4/4 仍绿）。
