# agents — 智能体定义、授权契约与顾问面（D2）

子上下文：`advisor` / `agentAssets` / `agentFs` / `agents` / `agentsight` /
`assistant` / `autonomy`。

## 谁要（角色）

- **跑顾问/自治/伴随的人**：`cli/handlers/advisor.js`、`agentAssets.js`、
  `autonomy.js`、`companion.js`、`proactive.js` 各自 require 本目录。
- **要「系统提示词里那段智能体定义」的人**：`src/agents/prompt.js` 与
  `src/constants/prompts.js` 取 `agents/`。
- **每次工具调用的权限判定**：真源在 `domain/state/orchestrator/roleToolScope.js`，
  本目录提供的是**角色与资产的定义面**（壳 `services/advisor/index.js`）。

## 为什么这么做

规则 10 的立场是「默认拒绝，权力只能被明确授予」，因此定义面（谁能被实例化成
一个角色、带哪些提示词与资产）与判定面（这个角色实际拿到哪些工具）**必须是两份
文件**：判定面单独放在 `state/orchestrator/roleToolScope`，正是为了避免 A2-5
「同一个『只读角色』概念有两份不一致定义」。设计契约由
`tests/agents/agentAuthz.designContract.test.js` 锁住——它测的就是这条分离。

## 怎么验

```bash
cd services/backend
node --test tests/agents/agentAuthz.designContract.test.js        # 10 tests / 10 pass / 0 fail
node --test tests/agents/auditAgent.test.js                        # 9 tests / 8 pass / 1 fail
```
第二条**当前有 1 条红**（失败用例名未在本卡采集，不做推断）。
`assistant/` 是作者在做中的伴随/助手面，本卡不复述其行为。

## 已知缺陷（登记，不在本单元擅自修）

1. `auditAgent.test.js` 的 1 条红（待按规则 5 复现）。
2. `assistant/` 子上下文与作者的助手改动同侧，README 刻意不写其行为细节。
