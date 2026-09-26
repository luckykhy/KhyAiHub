# 任务完成判断地图

> **单一真源**:本文档是 khy-os「任务何时算做完」的架构地图。
> 代码变更触及收尾/停止/预算逻辑前,必须先核对本文档对应的模块与行号。
> 若发现文档与代码不一致,以代码为准并同步更新本文档。

---

## 1. 三条决策通道(平行存在,各管一段)

khy-os 有三种「任务」,各有独立的完成判断通道:

| 通道 | 入口 | 判定模块 | 何时介入 | 是否有界 |
|------|------|----------|----------|----------|
| **普通请求** | 用户在 REPL/TUI/Web 发一条消息 | `taskClosure.decideClosure` | 每轮模型收尾时(模型不再调用工具) | redrive [0,6],默认 1 |
| **持久目标 /goal** | 用户设置 `/goal <目标>` | `goalStopGate.evaluateGoalStop` | /goal 模式下,模型「想停」时 | 单轮 [0,10],默认 1;跨轮由 goalCore 轮次预算兜底 |
| **后台持久任务** | `backgroundTaskManager` / `largeTaskRuntimeStore` | FSM 状态机 | 跨进程,任务生命周期全程 | `TERMINAL_STATUSES` 终态集合 |

**关键**:三条通道互不干扰。普通请求不会触发 goalStopGate(无活动目标时直接 `pass`);持久目标在 goalStopGate 之外还叠加 taskClosure 的通用判定。

---

## 2. 普通请求:taskClosure 三态仲裁

**模块**: `services/backend/src/services/taskClosure.js`
**接线点**: `services/backend/src/services/toolUseLoopCore.js:318-337`(`_looksConcluded`)

### 2.1 三态裁决

```
decideClosure({ reply, planSteps, toolCallLog, redriveCount, maxRedrives })
  │
  ├─ isFinalDelivery(reply) == false ?
  │   ├─ 预算耗尽 → close_partial (诚实降级,绝不假装成功)
  │   └─ 预算未耗尽 → redrive (注入 buildRedriveMessage)
  │
  ├─ isFinalDelivery(reply) == true ?
  │   ├─ 有未完成步骤(steps.length > 0) ?
  │   │   ├─ 预算耗尽 → close_partial
  │   │   └─ 预算未耗尽 → redrive (reason: steps-incomplete)
  │   │
  │   ├─ 声称验证却无真实验证(claimsVerify && !ranVerify) ?
  │   │   ├─ 预算耗尽 → close_partial
  │   │   └─ 预算未耗尽 → redrive (reason: verification-missing)
  │   │
  │   └─ 步骤齐 + 验证已跑 → close (reason: concluded)
  │
  └─ (不可能到达)
```

### 2.2 isFinalDelivery 判定优先级

| 优先级 | 条件 | 结果 |
|--------|------|------|
| 1 | 空回复 | false |
| 2 | 否定完成信号(`_NEGATED_RE`: 尚未/还没/未完成/not done…) | false |
| 3 | 显式目标达成(`_goalLooksDone`: 目标已完成/大功告成…) | true |
| 4 | 终态交付信号(`_FINAL_SIGNAL_RE`) 且未被未来时遮蔽 | true |
| 5 | 终态信号 + 未来时计划主导(`_FUTURE_DOMINANT_RE` + `_PROGRESS_MARKER_RE`) | false (阶段性小结,不是终态) |
| 6 | 其余 | false |

### 2.3 信号词表

**终态交付信号** (`_FINAL_SIGNAL_RE`):
```
已完成|已全部完成|已达成|已实现|已交付|已整理|已创建|已修改|已启动|已打开|
已执行|已运行|已验证|已发送|已部署|已安装|大功告成|完成|成功|无需|不需要|
没有.*需要|已经.*整理|看起来.*整洁|桌面.*干净|结果|总结|结论|以上|如下|本次|
done|completed|finished|accomplished|summary|result|launched|opened|executed|
verified|started|no.*needed|already.*clean|organized
```

**否定完成信号** (`_NEGATED_RE`):
```
尚未|还没|还未|仍未|未能完成|未完成|没(?:有)?完成|不能.*(?:确认|视为)|
not\s+(?:yet\s+)?(?:done|complete(?:d)?|finished)|incomplete|still\s+(?:working|pending)
```

**未来时计划主导** (`_FUTURE_DOMINANT_RE`):
```
接下来|下一步|接下来我|下一步我|我(?:将|会|准备|打算|先|接下来|下一步)|即将|
然后|之后|稍后|再(?:接|继)|还会|还需要|仍需|还有|剩余|待办|继续(?:推进|执行|处理)|
go(?:ing)?\s+to\b|i\s*(?:'|')ll\b|i\s+will\b|let\s+me\b|still\s+(?:need|to\s+do|working)
```

### 2.4 预算

| 参数 | 默认值 | 范围 | env 覆盖 |
|------|--------|------|----------|
| `maxRedrives` | 1 | [0,6] | `KHY_TASK_CLOSURE_REDRIVE_MAX` |

**关闭后行为**: `maxRedrives=0` → 模型第一次无终态回复就直接 `close_partial`(诚实降级,绝不无限续跑)。

---

## 3. 持久目标:goalStopGate 四门裁决

**模块**: `services/backend/src/services/goalStopGate.js`
**接线点**: `services/backend/src/services/toolUseLoopCore.js:7108-7172`

### 3.1 四道门(串行,任一失败 → redrive)

```
evaluateGoalStop({ goal, reply, redriveCount, env, userMessage, toolCallLog })
  │
  ├─ 门关(KHY_GOAL_STOP_GATE=0) → pass (行为回退到无 goal 感知)
  ├─ 无活动目标 → pass
  │
  ├─ looksLikeGoalSatisfied(reply) == false ?
  │   ├─ 预算耗尽 → pass (reason: redrive-exhausted)
  │   └─ 预算未耗尽 → redrive (reason: not-satisfied)
  │
  └─ looksLikeGoalSatisfied(reply) == true ?
      │
      ├─ 【证据门】claimsVerificationWithoutEvidence(reply) ?
      │   ├─ 预算耗尽 → pass (不自动清除未经证实的目标)
      │   └─ 预算未耗尽 → redrive (reason: evidence-missing)
      │
      ├─ 【验证行为门】声称验证但 verificationCommandRan(toolCallLog)==false ?
      │   ├─ 预算耗尽 → pass
      │   └─ 预算未耗尽 → redrive (reason: verify-not-run)
      │
      ├─ 【契约门】parseCompletionContract 有标准 且 matchEvidenceAgainstContract 未全覆盖 ?
      │   ├─ 预算耗尽 → pass
      │   └─ 预算未耗尽 → redrive (reason: contract-unmet)
      │
      └─ 全部通过 → clear (自动清除目标) 或 pass (KHY_GOAL_AUTO_CLEAR=0)
```

### 3.2 looksLikeGoalSatisfied 判定优先级

| 优先级 | 条件 | 结果 |
|--------|------|------|
| 1 | 空回复 | false |
| 2 | 否定完成(`_NEGATED_DONE_RE`) | false |
| 3 | 显式「目标达成」措辞(`_GOAL_DONE_PHRASE_RE`) | true |
| 4 | 完成态通用信号(`_PERFECTIVE_DONE_RE`) 且未被未来时计划遮蔽 | true |
| 5 | 完成态信号 + 未来时计划(`_FUTURE_PLAN_RE`) | false |
| 6 | 其余 | false |

### 3.3 证据门(参考 Hermes v0.18.0)

**验证声称信号** (`_VERIFICATION_CLAIM_RE`):
```
已验证(?:通过)?|验证(?:已)?通过|(?:全部|所有)?\s*测试(?:全部|均)?\s*(?:通过|全绿)|
测试全绿|全部通过|检查(?:已)?通过|校验(?:已)?通过|构建(?:成功|通过)|编译(?:成功|通过)|
all\s+tests?\s+pass(?:ed|ing)?|checks?\s+pass(?:ed|ing)?|build\s+(?:succeeded|passed|success(?:ful)?)|
lint\s+(?:pass(?:ed|ing)?|clean)|verified|\bpassed\b
```

**具体证据信号** (`_EVIDENCE_RE`):
```
``` | ~~~ | 数字+passed/passing/通过 | 数字/数字 | exit code | tests: 数字 |
ok 数字 | # pass/fail | ✓✔√✅❌✗× | PASS | FAIL | $ 命令 | npm test |
node --test | pytest | jest | go test | cargo test
```

### 3.4 验证行为门

**验证命令签名** (`_VERIFY_CMD_RE`):
```
npm\s+(?:run\s+)?(?:test|check|lint|build|verify|arch|maintainer)|
yarn\s+(?:run\s+)?(?:test|check|lint|build)|pnpm\s+(?:run\s+)?(?:test|check|lint|build)|
node\s+--test|node\s+--check|\bpytest\b|\bjest\b|\bvitest\b|\bmocha\b|
go\s+test|cargo\s+test|\beslint\b|\btsc\b|\bruff\b|\bflake8\b|
make\s+(?:test|check|lint)|khy\s+(?:doctor|metadata\s+(?:check|refresh))|
python\s+-m\s+(?:pytest|unittest)
```

### 3.5 完成标准契约门(completionContract)

**模块**: `services/backend/src/services/completionContract.js`

用户可在 `/goal` 目标文本中预先声明「完成标准」:
- 反引号命令: `npm test`、`arch:god` 等(任意位置)
- 标准段:「完成标准 / 验收标准 / definition of done」标题后的条目

契约门据回复证据逐条核对,未被证据全覆盖 → redrive 指名缺哪条。

### 3.6 预算

| 参数 | 默认值 | 范围 | env 覆盖 |
|------|--------|------|----------|
| 单轮再驱动上限 | 1 | [0,10] | `KHY_GOAL_STOP_GATE_MAX` |
| 跨轮轮次预算 | 由 goalCore 管理 | — | `KHY_GOAL_MAX_TURNS` |

**门控层级**(父子嵌套,父关 → 子全关):

| 门控 | 默认 | 作用 |
|------|------|------|
| `KHY_GOAL` | 开 | 持久目标总开关 |
| `KHY_GOAL_STOP_GATE` | 开 | Stop-gate 总开关 |
| `KHY_GOAL_AUTO_CLEAR` | 开 | 达成后自动清除目标 |
| `KHY_GOAL_EVIDENCE_GATE` | 开 | 证据门 |
| `KHY_GOAL_COMPLETION_CONTRACT` | 开 | 完成标准契约门 |
| `KHY_GOAL_VERIFY_RAN_GATE` | 开 | 验证行为门 |

---

## 4. 工具循环硬上限(最终兜底)

**模块**: `services/backend/src/services/toolUseLoopCore.js:341-342`

| 参数 | 默认值 | 范围 | env 覆盖 |
|------|--------|------|----------|
| `MAX_ITERATIONS` | 100 | [1,100] | `KHY_TOOL_LOOP_MAX_ITERATIONS` |
| `MAX_ELAPSED_MS` | 600000 (10min) | [5000, 1800000] | `KHY_TOOL_LOOP_MAX_MS` |

**20 倍模式** (`twentyXMode`):开启后迭代上限顶到硬顶 100。

**IterationBudget**:带 grace call 支持——耗尽后允许一次「grace」迭代让模型总结。

---

## 5. 反无限制续跑:全部 5 道闸

| # | 闸 | 模块 | 默认 | 关闭后行为 |
|---|---|---|---|---|
| 1 | 工具循环硬上限 | `toolUseLoopCore.js:341-342` | 100 轮 / 10min | 跑死(永不退出) |
| 2 | taskClosure redrive 预算 | `taskClosure.js:57,202` | 1 次 | 多烧轮但最终 close_partial |
| 3 | goalStopGate 单轮预算 | `goalStopGate.js:176,185` | 1 次 | 多烧轮但最终 pass |
| 4 | goalCore 跨轮预算 | `goalCore/*` | 由 `KHY_GOAL_MAX_TURNS` | 跨轮无限循环 |
| 5 | FSM TERMINAL_STATUSES | `largeTaskRuntimeStore.js:27` | 终态集合不可逆 | 状态机兜底 |

**关键设计**:每道闸都是**独立有界**的。关闭任何一道闸,其他闸仍然生效。不可能出现「所有闸都关了还无限跑」的情况——至少 `MAX_ITERATIONS=100` 是硬编码的最终兜底。

---

## 6. 辅助守卫(增强完成判断质量)

### 6.1 doomLoopGuard — 同工具重复调用防护

**模块**: `services/backend/src/services/doomLoopGuard.js`

| 工具类型 | escalate 阈值 | ask_user 阈值 | env 覆盖 |
|----------|---------------|---------------|----------|
| 写工具(write_file/shell 等) | 3 次连续相同 | 5 次 | `KHY_DOOM_LOOP_THRESHOLD_WRITE` |
| 读工具(read_file/grep 等) | 5 次连续相同 | — | `KHY_DOOM_LOOP_THRESHOLD_READ` |

**门控**: `KHY_DOOM_LOOP_GUARD`(默认开)

### 6.2 shortStopContinuation — 弱模型早停续写

**模块**: `services/backend/src/services/query/shortStopContinuation.js`

条件:自然 stop(非 length) + 异常短(<40 字符) + 中途断句(无终止标点) → 一次性续写。

**门控**: `KHY_SHORT_STOP_CONTINUATION`(默认**关**,opt-in)

### 6.3 inertiaCompletion — 断线惯性完成

**模块**: `services/backend/src/services/query/inertiaCompletion.js`

条件:流式层瞬断(`interrupted:true`) + 已有 toolUseBlocks → 惯性执行已下达的工具调用 + 无感衔接。

**门控**: `KHY_INERTIA_COMPLETION`(默认开)

### 6.4 crossTurnRepeatDecision — 跨轮工具调用重复防护

**模块**: `services/backend/src/services/toolUseLoopCore.js:1379-1559`

检测跨轮重复的成功工具调用,引导模型「基于已有结果回答,不要重跑」。

**门控**: `KHY_CROSS_TURN_TOOL_DEDUP`(默认开)

### 6.5 answerEchoGuard — 回声断路器

防止模型重复输出已交付的答案(同一答案出现 2+ 次 → 断路)。

### 6.6 followThroughGuard — 智能体纪律兜底

零工具调用的动作轮次里,识别「虚构阻碍就放弃 / 空头承诺却不执行」→ 强制闭环。

### 6.7 resultGuard — 结果守卫

杜绝「执行了工具但只给了承诺式前言、未交付结论、也无收尾」就静默返回。

### 6.8 adaptiveExecution — 边做边想

执行中持续拿过程/结果对照模型最初的设想,出现偏差而模型未自发反思时提示「停一下,原计划是否仍成立?」。

### 6.9 devCourseMonitor — 开发轨迹监控

监听开发轨迹(测试回归 / 未验证 churn / 反复改同一文件 / 连续失败),在跑偏酿成大错前及早提示修正航向。

---

## 7. 后台持久任务:FSM 状态机

**模块**: `services/backend/src/tasks/largeTaskRuntimeStore.js:13-41`

### 7.1 状态集合

```
queued → claimed → running → succeeded
                       ↓
                  retry_wait → claimed (重试)
                       ↓
                  dead_letter (重试耗尽)
                       ↓
任何状态 → cancelling → cancelled
任何状态 → pausing → paused → running
```

### 7.2 终态(不可逆)

```javascript
TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'dead_letter'])
```

### 7.3 状态转换表

| 当前状态 | 可转移到 |
|----------|----------|
| queued | claimed, cancelling, cancelled |
| claimed | running, retry_wait, cancelling, cancelled, failed |
| running | retry_wait, pausing, cancelling, succeeded, failed |
| retry_wait | claimed, dead_letter, cancelling, cancelled |
| pausing | paused, cancelling, cancelled |
| paused | running, cancelling, cancelled |
| cancelling | cancelled |
| succeeded | (终态) |
| failed | (终态) |
| cancelled | (终态) |
| dead_letter | (终态) |

---

## 8. 交付台账:persistent deliveryLedger

**模块**: `services/backend/src/services/deliveryLedger.js`

任务终态经 `backgroundTaskManager.complete/fail/cancel` 或 headless 入口追加一条 JSONL 记录到 `<dataHome>/tasks/delivery_ledger.jsonl`。

**记录字段**: ts, taskId, source, task, status, closure, verdict, iterations, toolCalls, failedToolCalls, summary, gaps, error, cwd

**自裁剪**:默认保留最近 500 条(`KHY_DELIVERY_LEDGER_MAX` 可调)。

---

## 9. 修改路径速查

| 要改什么 | 改哪里 | 注意事项 |
|----------|--------|----------|
| 普通请求的「完成」定义 | `taskClosure.js` 的 `_FINAL_SIGNAL_RE` / `_NEGATED_RE` | 纯叶子,改后跑 `taskClosure.decideClosure.test.js` |
| 持久目标的「达成」定义 | `goalStopGate.js` 的 `_PERFECTIVE_DONE_RE` / `_NEGATED_DONE_RE` | 纯叶子,改后跑 `goalStopGate` 测试 |
| 证据门开关 | `goalStopGate.js` 的 `isEvidenceGateEnabled` | 嵌套父门控 `KHY_GOAL_STOP_GATE` |
| 完成标准契约解析 | `completionContract.js` 的 `parseCompletionContract` | 纯叶子,改后跑 `completionContract` 测试 |
| 再驱动预算 | `taskClosure.js:resolveMaxRedrives` / `goalStopGate.js:resolveMaxRedrives` | clamp 范围在函数内 |
| 工具循环硬上限 | `toolUseLoopCore.js:341-342` | `MAX_ITERATIONS` / `MAX_ELAPSED_MS` |
| Doom Loop 阈值 | `doomLoopGuard.js:107-109` | `DEFAULT_WRITE_THRESHOLD` / `DEFAULT_READ_THRESHOLD` |
| 后台任务终态 | `largeTaskRuntimeStore.js:27` | `TERMINAL_STATUSES` 不可逆集合 |

---

## 10. 测试覆盖

| 测试文件 | 覆盖范围 |
|----------|----------|
| `__tests__/taskClosure.decideClosure.test.js` | 三态仲裁 + 预算语义 |
| `__tests__/toolUseLoop.taskClosureGate.smoke.test.js` | 接线冒烟:无终态 → redrive → close_partial |
| `__tests__/goalStopGate.*.test.js` | 四门裁决 + 证据门 + 契约门 |
| `__tests__/completionContract.*.test.js` | 契约解析 + 证据核对 |
| `__tests__/doomLoopGuard.*.test.js` | 同工具重复检测 |
| `__tests__/shortStopContinuation.*.test.js` | 弱模型早停续写 |
| `__tests__/inertiaCompletion.*.test.js` | 断线惯性完成 |
| `__tests__/deliveryLedger.*.test.js` | 交付台账落盘 |
| `tests/toolUseLoop.*.test.js` (30+ 文件) | 工具循环各场景 |

---

## 11. 决策流程图(文本版)

```
用户发送消息
  │
  ▼
runToolUseLoop 进入循环
  │
  ├─ 每轮:模型回复
  │   │
  │   ├─ 有工具调用? → 执行工具 → 继续循环
  │   │
  │   └─ 无工具调用(模型「想停」)?
  │       │
  │       ├─ [闸1] IterationBudget 耗尽? → 强制退出(grace call)
  │       │
  │       ├─ [闸2] goalStopGate 有活动目标?
  │       │   ├─ 四门裁决 → clear / redrive / pass
  │       │   └─ redrive → 注入再驱动指令 → continue
  │       │
  │       ├─ [闸3] taskClosure.decideClosure
  │       │   ├─ close → 正常退出
  │       │   ├─ redrive → 注入再驱动指令 → continue
  │       │   └─ close_partial → 诚实标注 → 退出
  │       │
  │       ├─ [闸4] doomLoopGuard.assess
  │       │   ├─ continue → 正常
  │       │   ├─ escalate → 提示模型换思路
  │       │   └─ ask_user → 升级为用户询问
  │       │
  │       └─ [闸5] 硬上限 MAX_ITERATIONS / MAX_ELAPSED_MS
  │           └─ 超限 → 强制退出
  │
  └─ 循环结束 → 返回 finalResponse
```

---

## 12. 小步多轮策略(渐进完成,避免硬截断)

### 12.1 核心原则

**不要硬截断,要小步多轮**。任务完成判断的目标不是「在预算耗尽时强制停止」,而是「每步确认后继续,渐进完成」。

现有机制的 `close_partial` 是「预算耗尽后诚实降级」——这仍然是一种截断。更好的模式是:

```
大任务 → 拆成小步骤 → 每步执行 → 每步确认 → 继续下一步 → 全部完成 → 整体验收
```

### 12.2 现有的小步多轮机制

**planModeService.js** 已实现完整的小步多轮工作流:

| 阶段 | 函数 | 作用 |
|------|------|------|
| 生成计划 | `enterPlanMode` | AI 生成结构化执行计划(含步骤/依赖/风险/验证) |
| 用户审批 | `presentForApproval` | 用户可 skip/edit/add 步骤,确认后才执行 |
| 逐步执行 | `executePlanSteps` | 每步独立 chat(),有校验和重试(`maxStepRetry`) |
| 验证落地 | `_runPlanVerification` | 实地运行验证段,用真实证据判定交付是否达标 |

**taskScale.js** 自动检测任务规模:

| 规模 | 判定条件 | 预期轮次 |
|------|----------|----------|
| small | 问候/闲聊/简单问答 | 1 轮 |
| normal | 单文件修改/Bug 修复 | 2~5 轮 |
| large | 多文件重构/架构变更 | 5+ 轮 |

**关键**:large 任务自动触发 planMode,生成计划后逐步执行,而不是一次性做完。

### 12.3 每步确认机制

**步骤校验** (`validateStepResult`):
- 检查 AI 回复是否包含失败信号
- 检查预期文件是否存在(`inferStepFileTargets`)
- 检查写操作是否真的修改了文件(`mtime` 对比)
- 检查运行命令是否有真实证据(`hasRuntimeEvidence`)

**步骤重试** (`maxStepRetry`):
- 默认 1 次重试(`KHY_PLAN_STEP_RETRY` 可调)
- 重试时注入上次失败原因,要求模型修正
- 重试耗尽后标记步骤为 `error`,继续下一步

**人闸门** (`requiresHumanGateStep`):
- 高危/破坏性步骤(删除/清空/重置/覆盖/迁移/发布/部署)执行前暂停确认
- 用户可选择执行或跳过
- Goal Mode 或 `KHY_HUMAN_GATE=off` 时自动放行

### 12.4 两种执行模式

| 模式 | env | 行为 |
|------|-----|------|
| **逐步执行**(默认) | `KHY_PLAN_CONTINUOUS=0` | 每步独立 chat(),步骤间有校验/重试/人闸门 |
| **连续执行** | `KHY_PLAN_CONTINUOUS=1` | 整个计划交给一次 chat(),工具循环连续执行,跨步骤保持上下文 |

**逐步执行**更适合需要精确控制的场景(每步确认、失败隔离)。
**连续执行**更适合上下文连续的场景(跨步骤复用结果、减少模型调用开销)。

### 12.5 与 taskClosure 的协作

taskClosure 的 `planSteps` 参数接收 planModeService 生成的步骤列表:

```javascript
taskClosure.decideClosure({
  reply: strippedReply,
  planSteps: plan.steps,  // 来自 planModeService
  toolCallLog,
  redriveCount,
  maxRedrives,
  taskDescription,
})
```

**协作流程**:
1. planModeService 生成计划,用户审批
2. 逐步执行,每步完成后更新 `step.status`
3. 所有步骤完成后,taskClosure 检查 `incompleteSteps(planSteps)`
4. 若有未完成步骤 → redrive(要求完成剩余步骤)
5. 若声称验证却无真实验证 → redrive(要求实际运行验证)
6. 若步骤齐 + 验证已跑 → close

### 12.6 最佳实践

1. **大任务必须拆步骤**:超过 3 个文件或 5 个步骤的任务,应触发 planMode 生成计划
2. **每步有明确完成条件**:步骤描述应包含「如何验证这一步成功」
3. **失败不阻塞后续**:某步失败后,继续执行不依赖它的后续步骤
4. **验证段必须实地运行**:计划的「验证」段不是装饰,必须实际执行并报告证据
5. **人闸门保护高危操作**:删除/覆盖/部署等操作必须经过用户确认

---

### 12.7 回退锚点:从「有校验」到「可还原」(S1 已落地,观察者)

> **状态**:截至 2026-09-26 **S1 观察者已落地**(门控 `KHY_STEP_ANCHOR` 默认开)。
> 本节 12.7.1 / 12.7.2 是**缺口与边界**(仍成立);12.7.3 起**已按实现回写**——
> 凡与初稿不同的地方都标了「⚠ 与初稿的偏离」并写明理由。
> 用户诉求原话见 `.khy/feedback/rollback-anchor-design/requirement-5q.md`。
>
> **S1 语义(不许含糊)**:每步完成后**只写锚点 + 旁路台账**,**绝不自动还原**。
> 失败分支刻意**不**调用 `restoreAnchor`——还原只走**显式调用**。

#### 12.7.1 缺口:步与步之间有「校验」和「重试」,但没有「还原」

§12.3 的 `maxStepRetry` 回答的是「这一步没做对,再让它改一次」——重试只注入失败原因,
**在同一个(可能已被改坏的)基础上继续**。它不回答、也不打算回答「退到哪」。

⚠ **本仓 `checkpoint` 一词是假朋友**。下面这些全部是**往对话里注入自检/进度提示**,
**不产生快照、不构成还原点**:

| 名字 | 位置 | 实际语义 |
|------|------|----------|
| `createCheckpointTracker` / `checkpointInterval` | `pipelineOrchestrator.js:282` / `:47` | 每 N 个**已完成步骤**注入一次自检提示(同步骤同相位去重) |
| `PHASE_SELF_CHECK` / `PHASE_SUMMARY` | `toolUseLoopCore.js:9005` / `:4521` | 检查点 B/C 的**注入时机**(post-step 自检、收尾前小结) |
| `checkpointThrottle` | `toolUseLoopCore.js:1695` | 给上述注入**限流**,防刷屏 |

**取证**(2026-09-26 实测):`planModeService.js` 中 grep `snapshot|rollback|checkpoint|stash` **零命中**。
(2026-09-26 二次实测:该零命中在实现落地后**依然成立**——锚点逻辑全在
`stepAnchorStore.js`,对 `planModeService.js` 只是三处 `require` + 一个调用点。)

⇒ 后果:某步把文件改坏后,可用手段只有「在坏掉的基础上再试一次」或「人闸门拦下后续步骤」,
**没有回到上一步完成时磁盘状态的能力**。这正是「一次很大的改变改坏无法修复」的机制成因。

#### 12.7.2 与相邻机制的分工(边界表)

| 机制 | 它回答的问题 | 与本节的关系 |
|------|--------------|--------------|
| §12.3 `validateStepResult` / `maxStepRetry` | 这一步**做对了吗**?没对就再试 | **互补**:它管「重试」,本节管「还原」 |
| §12.3 `requiresHumanGateStep` | 这一步**该不该做**? | 上游拦截;本节是它拦不住时的**下游兜底** |
| `RUNTIME-009` `rollback.txt` | 动手前**说清怎么退**(书面方案) | **不是同一件事**:那条是「先声明退路」,本节是「退路真的存在且可执行」 |
| `RUNTIME-007` `fix-blast-radius`(≥4 文件 / ≥3 顶层目录) | 这次改动**是否太大** | **互补**:它限爆炸半径,本节限**爆炸后的可恢复性** |
| `taskClosure.close_partial` | 预算耗尽后**诚实降级** | 正交:那是**收尾**语义,不是回退语义 |
| §12.6 最佳实践「大任务必须拆步骤」 | 怎么**少犯错** | 本节是「**已经错了**」时的补救 |

#### 12.7.3 落地形状(已实现)

落点:`services/backend/src/services/stepAnchorStore.js`(纯逻辑 + 可注入 FS 适配器)。

- **锚点粒度**:每**步**完成即锚(不是每工具调用、不是每帧)——与 §12.2 `executePlanSteps`
  的步骤边界对齐。**实现位置**:`planModeService.js` 的 `if (acceptedResult)` 分支内,
  `step.status = 'completed'` 之后、`results.push(...)` 之前。整段包 `try/catch`,**fail-soft**。
- **锚点内容**:该步**目标文件**的快照(原始字节 + sha256),而非全仓快照。
  - ⚠ **与初稿的偏离**:初稿写「由该步 `toolCallLog` 推出」。实现改用**既有纯函数
    `inferStepFileTargets(step.description, plan)`**(该函数此前已用于 `validateStepResult`
    的 missing/stale 判定)。理由:复用现成真源可省掉 13 处触点里最重的一处(改造工具循环
    去收集 toolCallLog),风险面小得多。
  - **代价(必须知道)**:推断法的输入是**步骤描述**⇒**描述里没提到的文件不会被锚**。
    缓解:`inferStepFileTargets` 已同时吃 `plan.dataNeeds / expectedOutputs / risks`
    与描述里的绝对路径,覆盖面不差;且锚点记 `skipped` 而非静默丢。
- **还原验收**:**逐字节相等**(sha256 比对,对齐本仓既有范式,不靠「看着一样」)。
  `restoreAnchor()` 返回 `verified` 与 `mismatches[]`,**验收可以为假**——有反向用例锁死
  (dryRun 场景断言 `verified === false`)。
- **落点(锚点数据)**:⚠ **与初稿的偏离**:初稿写「非 git 索引路径(`.khyos/` 下)」,
  实现改判为**数据家目录** `~/.khyquant/projects/<hash>/step-anchors/<runId>/`
  (与 `trajectoryStatsStore` 同族)。
  **理由**:锚点的用途是「工作区被改坏后还能退回去」,把它放在**工作区里面**意味着
  `git clean -xfd` / 误删目录会连锚点一起毁掉——恰恰在最需要它的时候失效。
  初稿担心的两件事仍成立:不进 git 索引 ⇒ 不污染 `git status`,也不计入 `SECURITY-001` 的 20 文件硬闸。
  可用 `KHY_STEP_ANCHOR_ROOT` 重定位。
- **强度**:fail-soft;`KHY_*` 门控(`KHY_STEP_ANCHOR` 默认开,已登记 `flagRegistry`);
  **S1 观察者起步、旁路记录、禁阻断**(禁跳阶)。阶段选择器 `KHY_STEP_ANCHOR_STAGE` 默认 `S1`,
  非法值一律回落 `S1`(**不许 fail-open**)。
- **接线**:登记 `FEATURE-OWNERSHIP.json → rollout.mechanisms[]`(`stage: S1`,`rules: []`)。
  ⚠ **本机制没有新规则**(不挂 ruleguard 门)⇒ `[DESIGN-ARCH-127]` 的 13 处硬触点里,
  与规则登记相关的那 8 处(规则表条目 / AGENTS.md marker / 规则卡 / 阶段表 / 取号 / 孪生件…)
  **本就不适用**。实际触点是:① `flagRegistry` 登记门控;② `FEATURE-OWNERSHIP` 登记阶段;
  ③ 接线点(`planModeService`);④ 测试(模块单测 12 条 + 接线端到端 8 条)。
- ⚠ **刻意不接线的一处**:`_executePlanContinuous`(`KHY_PLAN_CONTINUOUS=1`)。
  那条路径所有步骤在**一次** `chat()` 返回之后被同时标为 `completed`,中间没有磁盘边界
  ⇒ 逐步锚点只会产出同一份末态快照,**是假信息**。要支持它得先让主循环在每个步骤完成时回调。

#### 12.7.4 未决问题(裁定状态)

1. 锚点存**内容快照**还是**反向补丁**?→ **已定:内容快照**。理由:反向补丁的还原路径更长、
   更易失效,而本机制的失败代价是「退不回去」,宁可多占空间。单文件上限 `MAX_FILE_BYTES = 8 MiB`,
   超限记 `skipped`(不静默丢)。
2. 步骤失败时**自动还原**还是**仅提示用户可还原**?→ **仍未裁定**。当前取「仅可显式还原」:
   代码里**不存在**任何自动还原路径,`restoreAnchor` 只由显式调用触发。
   ⚠ 这是**有意的保守选择**,不是实现遗漏——擅自自动回滚会改变既有失败语义
   (当前语义是「标记 `error` 并把 error 结果 push 出去」),且涉及 `RUNTIME-010` 工具授权边界。
   **升 S2/S3 前必须先裁定本条。**
3. 与 git 工作区既有改动如何共存?→ **已定**:锚点**只记计划目标文件**,还原**只动这些文件**
   (计划外的在途改动一律不碰);`restoreAnchor` 读回 manifest 后**再做一次越界检查**
   (防被篡改的 manifest 写到 cwd 之外),越界项记 `skipped`。
   ⚠ 口径变更(2026-09-26 第二轮):原为「只记**本步**目标文件」,按 Q5 的裁定改为
   「只记**全计划**目标文件」。「计划外不动」这条边界**未变**,变的只是**计划内**的覆盖范围。
4. 锚点建立后文件被外部修改时如何避免覆盖?→ **部分解决**。sha256 验收能**检测**「已被改过」
   (`mismatches` 非空),但还原**不会因此停下**——当前语义是「还原就是还原到那一步」。
   若将来要「检测到外部修改则拒绝还原」,属 S2+ 的强度问题。
5. ✅ **已裁定并落地(2026-09-26 第二轮):采用 (a) 累积式 manifest。**
   裁定前状态:「退回第 N 步完成态」**做不到**,只能做「把第 N 步碰过的文件恢复成第 N 步完成态」;
   已由多步用例**实测钉死**(当时写成 characterization 断言)。
   成因:每步 manifest **只含该步自己的目标文件**;第 2 步**创建**的 `b.md` 在第 1 步的锚点里
   **没有任何记录** ⇒ 退回第 1 步时**无从知道它当时不存在**,于是不会被删掉。
   **落地形状**:每步 manifest 覆盖**全计划目标**的当前状态(`plan.steps` 开工时已知 ⇒ 一次算全),
   于是 `restoreToStep(N)` 一次即正确——既写回「当时存在的」,也删掉「当时还不存在的」。
   配套(否则存储量是 O(步数 × 文件数)):blob 改为**运行级内容寻址** `blobs/<sha256>.bin`,
   同内容跨步只落一份(实测:3 步 × 3 目标只落 **2 份** blob,因为全程只有 2 种内容)。
   ⚠ 与 Q3 的边界**不冲突**:仍是「计划外不动」,只是「计划内」覆盖到全部目标。
   备选 (b)(保持按步隔离 + 改名 `restoreStepFiles(N)`)**未被采用**。
6. ⚠ **可达性:部分收口(2026-09-26 第二轮)。**
   裁定前状态:三个导出(`restoreToStep` / `getLastAnchorRun` / `listStepAnchors`)在
   `services` `scripts` `apps` `software` 下**零命中**(除 `planModeService.js` 自身)
   ⇒ 锚点是**只写**的:数据在磁盘上,但用户/AI 都够不到。
   **已落地的收口(只读面)**:`planModeService.formatAnchorSummary()` 把「已保存几份 /
   哪几步 / 覆盖几个计划目标文件 / runId / 阶段」压成一行,挂在**两条**计划执行路径上——
   TUI(`App.js` 的 `executePlan`,**默认路径**)与 readline REPL(`replSession.js`)。
   无可报内容时返回 `null` ⇒ 调用方**不打印**(不往转录里塞噪声)。
   摘要**只报事实、不承诺能力**:S1 阶段没有任何入口能触发还原,所以文案里**不写**
   「可退回第 N 步」——那是一句没有判据的声称。
   **未落地的部分(仍是缺口)**:`restoreToStep` **仍然没有任何用户入口**。用户看得见
   「存了哪些锚点」,但**没有任何命令能触发还原**。这是**刻意的**:棘轮禁止新增命令/别名/
   handler/规则(`check-delivery-baseline` 的 `delivery-surface-ratchet-breach` 量
   `routerCommands` / `aliasEntries` / `handlerFiles` / `ruleCount` 四项,只降不升)。
   后续可行落点(须先裁定,涉及 `RUNTIME-010` 工具授权):
   - **给既有命令加选项**,或**扩展既有工具**。
   - `PlanRetryTool`(`risk: 'medium'`,只改**状态**)语义上最接近,但它**不碰磁盘**,
     而 `restoreToStep` **会写/删用户文件** ⇒ 直接塞进去会**严重低估风险**
     (`riskGate` 只把 `critical || isDestructive` 判为不可绕过的人闸门)。

#### 12.7.5 验证状态

- **第一轮(2026-09-26 上半天)做了什么**:
  - 新增 `services/backend/src/services/stepAnchorStore.js`(`createAnchor` / `readAnchor` /
    `listAnchors` / `restoreAnchor` / `verifyRestore` + 纯函数 `planAnchor` / `planRestore`)。
  - 接线 `planModeService.executePlanSteps` 步骤边界,并导出
    `getLastAnchorRun` / `listStepAnchors` / **显式** `restoreToStep`。
  - `flagRegistry` 登记 `KHY_STEP_ANCHOR`(默认开,CANON 方言)。
  - `FEATURE-OWNERSHIP.json → rollout.mechanisms[]` 登记 `step-anchor`(`stage: S1`)。
  - 测试 **21 条全绿**:模块单测 12 条(`stepAnchorStore.test.js`)+ 接线端到端 9 条
    (`planModeStepAnchor.test.js`,含「门控关 ⇒ 零痕迹且返回值与开启时**逐字段一致**」、
    「dryRun 下 `verified === false`」两条反向用例,以及一条**多步** characterization 用例)。
  - 守卫:`check:rollout-stage` 0 error(本机制**不产生** `authority-drift` warning——
    阶段真源写成**字面常量** `KHY_STEP_ANCHOR_STAGE = 'S1'` 供守卫比对);
    `check:flag-registry` / `check:wiring`(95 检查器全接线) / `check:agent-rules` 均通过;
    `check:feature-ownership` 0 error;`check-arch-debt` 未因本机制新增条目。
  - 既有 jest 套件 `planModeService.*` **31 条全绿**(无回归)。
- **第一轮未做什么 / 已知遗留**(⚠ 前 3 条已在**第二轮**解决,保留在此以留痕):
  - **未实现任何自动还原**(见 12.7.4 Q2),**未升阶**(仍在 S1)。
  - ⚠ ~~未接任何调用方~~ ⇒ **第二轮已接只读面**(见 12.7.4 Q6);`restoreToStep` 仍无入口。
  - ⚠ ~~「退回第 N 步完成态」语义未达成~~ ⇒ **第二轮已达成**(见 12.7.4 Q5)。
  - **`KHY_PLAN_CONTINUOUS` 路径未接线**(理由见 12.7.3)。
  - ⚠ **`flagRegistry.js` 是 arch-debt 基线里的存量巨石**(基线 `loc: 3840`,规则 R2b
    「存量巨石只许减不许增」)⇒ 本次登记该门控的 **+7 行**会贡献到一条**已经红的**
    `R2b` 项上(该项同时被其他在途会话的改动推高)。这是本仓一条**结构性张力**:
    「新机制必须登记门控」与「`flagRegistry` 不许增长」互相冲突,需要一次专门裁定。
  - ⚠ **`.html` 孪生件仍陈旧**:本轮**未跑** `npm run docs:build`——它从仓库根扫全部 `.md`
    并重写数百已跟踪 `.html`,会卷入他人在途改动。
    (`verify_docs_site.js` 只断言孪生件**是否存在**、不校验新鲜度,且未接线到任何门档
    ⇒ 不会因此变红。)
  - ⚠ **未改 `check-rollout-stage.js`**:另三个同族机制(`read-before-edit-guard` /
    `cross-model-verify` / `trajectory-routing`)因为只从 env 读阶段、没有字面常量,
    各自挂着一条 `rollout-stage-authority-drift` warning。**那是它们的条目,未擅动**;
    本机制只是**不跟随**该形态。
- **第二轮(2026-09-26 晚)做了什么**:
  - **缺口 A(语义)**:按裁定落地**累积式 manifest**。`executePlanSteps` 开工时把
    **全计划目标集**一次算全(`_anchorFiles`),每步都拿它建锚(不再只传本步目标);
    `stepAnchorStore` 的 blob 改为**运行级内容寻址** `blobs/<sha256>.bin`(同内容不重写),
    并保留**步级布局回退读**(兼容落地当天更早创建的锚点)。
  - **缺口 B(可达性)**:按裁定**只暴露只读面**。新增 `planModeService.formatAnchorSummary()`
    作为**唯一**投影真源(TUI 与 REPL 共用,避免两套漂移),挂到 `App.js` 的 `executePlan`
    与 `replSession.js` 的计划收尾处。**不含** `restoreToStep` 的任何入口。
  - 测试 **25 条全绿**:`stepAnchorStore.test.js` 14 条(新增「blob 去重」与「步级布局回退读」)
    + `planModeStepAnchor.test.js` 11 条(多步用例由 characterization **反转**为「缺口已修」;
    新增摘要用例,含**同名 `getStage()` 撞车**的反向断言;新增一条**接线检查**)。
  - ⚠ **本轮修掉一个自己引入的真回归**:blob 挪到运行级之后,`step-NNNN/` 不再是 mkdir 的
    副产物 ⇒ 真 fs 下 manifest 写入 **ENOENT**、`createAnchor` 整体失败。**内存 FS 适配器上
    完全看不出来**(它的 `writeFileSync` 不检查父目录)⇒ 由**端到端用例**抓出。
    教训:纯逻辑单测 + 内存 FS **不能**替代真 fs 端到端。
- **第二轮未做什么 / 已知遗留**:
  - ⚠ **`restoreToStep` 仍无用户入口**(见 12.7.4 Q6)——用户看得见锚点,**触发不了**还原。
  - ⚠ **只读面的 TUI/REPL 接线是「结构断言」不是「行为断言」**:测试只证明调用点还在
    (判定面 = 源码文本),**未**跑通整条 TUI 渲染链。见下「验证状态分级」。
  - **未实现任何自动还原**(见 12.7.4 Q2),**未升阶**(仍在 S1)。
  - ⚠ **`.html` 孪生件仍陈旧**(未跑 `npm run docs:build`,理由同第一轮)。
- **验证状态分级**(⚠ 按本仓「已实测 / 仅主张」纪律):
  - **已实测**(有可复跑的判据):25 条测试;`check:rollout-stage` 0 error(本机制**无**
    `authority-drift` warning);`check:flag-registry` 通过;`check:wiring` 通过(95 检查器全接线);
    `check:agent-rules` 定向改动集 0 error;`check:agent-feedback` **本笔改动集**判
    **BUILD**(1.10 vs FIX 0.05)0 error。
  - **仅主张**(读代码路径得出,无自动判据):「只读面在 TUI/REPL 运行时真会执行到」——
    接线测试只做**文本判定**;`formatAnchorSummary` 在**真实运行状态**下非空这一点有断言,
    但「渲染器真把它画出来」**没有**断言。
  - **本轮未做**:跑 `npm run docs:build`;跑整仓 `rules:gate:commit`。
- **本轮验收时的环境噪声**(⚠ 非本机制引入,已**按文件归属分解**):
  - `check-arch-debt` 报 16 项新增:15 项明显属**他人在途**(`router.js` / `App.js` /
    `replSession.js` / `useQueryBridge.js` / `aiGatewayGenerateMethod.js` … 全是**存量巨石增长**,
    各自 +75~486 行);本机制**未新增条目**(`planModeService.js` 不在新增清单里)。
  - `check-delivery-baseline` 的 `delivery-surface-ratchet-breach`(`handlerFiles=157/155`)
    来自 `cli/handlers/` 下 4 个**未跟踪**文件(`about.js` / `commands.js` / `commit.js` /
    `publishCmd.js`,均他人 WIP)。本机制**未新增**命令/别名/handler/规则。
  - `check-tui-gates` 报 **233/227**,但**实测 HEAD 只有 223**——超限的 +10 全在**他人在途**的
    `KHY_CC_*` / `KHY_DIFF_*` 等新 token 里。`KHY_STEP_ANCHOR*` **不在** TUI 扫描面内
    (`services/backend/src/cli/tui/**`)。⚠ 这条**订正**了此前「HEAD 即超限」的判断。

---

## 13. 已知边界与限制

1. **信号词表是启发式的**: `_FINAL_SIGNAL_RE` / `_PERFECTIVE_DONE_RE` 等正则基于自然语言模式匹配,无法覆盖所有表述。新增完成表述时需同步更新信号词表。

2. **证据门只看回复文本**: `hasConcreteEvidence` 检查回复里是否有证据形状的文字(````、数字/数字、PASS 等),不验证证据是否真实。验证行为门(`verificationCommandRan`)补充了「是否真的跑过验证命令」的检查。

3. **契约门依赖用户声明**: `parseCompletionContract` 只在目标文本含「完成标准」段或反引号命令时生效。用户未声明标准时,契约门不介入。

4. **跨轮预算由 goalCore 管理**: `goalStopGate` 只管单轮内再驱动;跨轮的无限循环由 `goalCore` 的轮次预算(`KHY_GOAL_MAX_TURNS`)结构性兜底。本文档不覆盖 goalCore 的具体实现。

5. **后台任务 FSM 不感知 AI 回复**: `largeTaskRuntimeStore` 的状态机只跟踪任务生命周期(queued→running→succeeded),不参与 AI 回复的内容判定。
