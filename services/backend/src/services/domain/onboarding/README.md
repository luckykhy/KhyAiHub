# onboarding — 首次引导的纯逻辑单元（D2）

业务上下文：`/onboarding` 这条 slash 命令与首启向导里，**能脱离终端渲染和读盘独立成立**
的那一部分——参数解析、步骤元数据、只读状态文案、首次安全须知。

## 谁要（角色）

- **首次在新机器/陌生目录启动 khy 的人**：在配置模型之前先看到一屏「接受前审阅改动 /
  只在信任的项目上用」的安全须知（`onboarding/safetyNotice.js`）。
- **在 REPL 里敲 `/onboarding trust` / `status` / `help` 的人**：要一份诚实的只读现状，
  而不是一句「已完成」（`onboarding/onboardingPlan.js` 的 `buildTrustStatusText` /
  `buildStatusText` / `buildHelpText`）。
- **两个薄壳**（`cli/handlers/onboarding.js`、`cli/onboarding.js`）与聚合器
  `services/onboarding/index.js`：它们是仅有的三个消费者，负责门控、采状态快照、着色与打印。

## 为什么这么做

历史上这两块逻辑散在 CLI 薄壳里，导致同一份引导文案有两条不一致的路径（slash 命令一条、
首启向导一条），而且**没法在不起终端的情况下验证**。`[RESEARCH-018]` §2.3 的功能单元模板
要求的正是这个形态：业务逻辑（`capability`）不 require 任何基础设施，IO 留在薄壳。
本单元的两个文件都是**零 require 的纯叶子**——所有外部事实（门控、cwd、信任判定、
MCP 数量）由调用方作为参数注入，缺就诚实留白，绝不编造。

## 怎么验

```bash
# 1) 契约与共置测试（node:test，jest 会自动忽略 node:test 形态的文件）
#    注意传 glob 而不是裸目录：本仓便携版 Node 把 `node --test <目录>/` 当模块去 require，会报
#    "Cannot find module .../onboarding"；`.../*.test.js` 形态才 14 pass。
cd services/backend && node --test src/services/domain/onboarding/onboarding/*.test.js

# 2) 真实命令面：门控关 → 逐字节回退今日引导
cd services/backend && KHY_ONBOARDING_SAFETY_NOTICE=0 node -e \
  "console.log(require('./src/services/domain/onboarding/onboarding/safetyNotice.js').buildSafetyNoticeLines().length)"
# 期望 0；不带该 env 时期望 8 行。
# 别在这里传 `{}`：buildSafetyNoticeLines(env = process.env) 的默认参数一旦被你显式传空对象覆盖，
# 门控就读不到真实 env，实测会两档都返回 8——那是命令写错，不是叶子失效。

# 3) 单元完整性由两条守卫执行（S1，只降不升）
cd <repo root> && node scripts/ci/check-repo-layout.js   # functional-unit + entry-buffer
```

## 已知缺陷（登记，不在本单元修）

源文件实际住在 `onboarding/onboarding/`——目录名重复了一层，违反 5-3-1 §1
「任何目录直接子项 5±2」背后的认知负载意图，也让路径读起来像笔误。修法是把内层
`onboarding/` 的内容上提一层，但那是一次 `git mv`，在本篇第 0 步（`.git` 重建）
闭合前禁止执行，故先登记。

另有 160 + 67 行行为测试住在 `services/backend/tests/services/onboarding/`。
它们与本目录的共置测试**不重复**：那边测的是逐条解析行为与别名表覆盖，
这边测的是单元契约（导出面、纯度、绝不抛、确定性、门控以注入 env 为准）。
两份合并同样卡在 `git mv` 禁令上。
