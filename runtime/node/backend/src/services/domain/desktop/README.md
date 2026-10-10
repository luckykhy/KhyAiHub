# desktop — 屏幕操作、浏览器与设备应用的执行面（D2）

业务上下文：`/device`、`/terminal-setup` 与两个智能体工具
（`DesktopControlTool` / `ComputerUseTool`）背后的一切：看屏幕、读无障碍树、
点/填/滚、以及设备应用管理。

## 谁要（角色）

- **让 AI 操作本机界面的人**：`tools/ComputerUseTool/index.js:15` 直接 require
  `domain/desktop/computerUse/computerUseAgent`，`:118` 经 shim 取 `DesktopController`；
  `tools/DesktopControlTool/index.js:380` 同源。
- **跑 `/device` 的人**：`constants/commandSchema.js:102` → `cli/handlers/device.js:27`；
  `/terminal-setup` 在 `commandSchema.js:215`（路由 `:1034`）。
- **用内置浏览器工具的人**：`services/browser/index.js:7` 是 re-export 壳，
  真身在本目录 `browser/`。

## 为什么这么做

这条线唯一的安全承重是**「总闸 + 审批」**：`desktopControl/safetyGate.js` 提供
`authorize / classifyOp / riskOf / OP_RISK / DEFAULT_BUDGET`，把每个操作分成风险档并
计量预算，`index.js` 的 `create()` 把闸门装在控制器前面。因此凡是要碰真实输入
（`inputController`、`windowController`、`screenCapture`）的文件都归 IO 侧，
而**判定逻辑**（`elementModel` 的角色归一与点击目标解析、`browser/scrollPlan` 的
滚动规划、`browser/ariaSnapshot`、`deviceApps/uninstallRoute` 的卸载路由决策）
全部做成纯函数——风险判定必须能在不开屏幕、不动鼠标的前提下逐条断言，
否则「物理 Escape 立刻停手」这类边界无法测试。

## 怎么验

```bash
cd services/backend
node --test tests/services/browser/scrollPlan.test.js        # 31 tests / 31 pass / 0 fail
```
第二条渠道是 `npm test`（jest，`tests/webBrowserTool.test.js`）——**本卡的复跑口径**：
上面那条 `node --test` 是本次实际执行过的；jest 那条只指出正式入口，
便携 shell 无 npm/npx，未在此复跑，不作为验收依据。

## 已知缺陷（登记，不在本单元擅自修）

`computerUse/computerUseAgent.js` 与 `desktopControl/safetyGate.js` 当前是 ` M`
（作者在做中的改动），本 README 不复述其内部行为细节；改动集落地后需复核本卡。
