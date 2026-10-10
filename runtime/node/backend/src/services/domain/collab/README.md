# collab — 协作机会识别、IDE 状态与「伪协作」检测（D2）

子上下文：`ide` / `proactiveCollaboration` / `weipuxiezuo`。
本目录 11 个文件**全部纯函数**（目录内 grep 无 `fs` / `net` / `child_process`）。

## 谁要（角色）

- **跑 `/ide` 的人**：`constants/commandSchema.js:249`（slash 侧 `:1330`，
  派发 `cli/routerDispatchSlash.js:273`）→ `cli/handlers/ideStatus.js:20` 取
  `ide/idePlan.js`。
- **要「维普改写」这个模型工具的调用方**：`tools/WeipuRewriteTool/index.js:3`
  经壳 `services/weipuxiezuo/index.js` 取 `weipuxiezuo/`。
- **让 AI 自己判断「这件事值不值得并行分派」**：
  `services/tool/toolUseLoopCore.js:4381` 消费 `proactiveCollaboration`
  （`proposeCollaboration` / `detectCollaborationOpportunity` / `planDelegation`）。
  注意：**这条链没有 CLI 命令**，它是委派边界（`PROCESS-004` / G1-G3 三闸门）
  在代码里的判定载体之一。

## 为什么这么做

三件事都不该由 IO 决定：`idePlan.js` 把「检测到哪些 IDE、该给哪条命令」做成
纯计划（`parseIdeArgs / summarizeDetections / buildListText / buildStatusText`，
env 从注入的 `env` 对象取，见 `:145-150`）；`proactiveCollaboration` 用
`opportunityDetector` 的枚举/并列抽取来判断是否真有可分派目标
（`_distinctTargets`、`_extractEnumerated`），配 `constants.js` 的
`LIMITS` / `ROLE_SIGNALS` / `PARALLEL_MARKERS`；`weipuxiezuo/` 是文本统计与规则表
（`textStats` 的段落/句长方差、`rules.js` 的高频词与口语黑名单、`scorer` 打分）。
纯函数化的直接收益：**委派判据可被追问**「你说这事能并行，依据是哪几个目标」。

## 怎么验

```bash
cd services/backend
node --test tests/services/ide/idePlan.test.js                   # 15 tests / 15 pass / 0 fail
node --test tests/services/proactiveCollaboration/proactiveCollaboration.test.js
                                                               # 21 tests / 21 pass / 0 fail
```
`tests/weipuxiezuo.test.js` 是 jest 形态，本机 jest 渠道不可用（见下）。

## 已知缺陷（登记，不在本单元擅自修）

`ide/idePlan.js` 当前是 ` M`（作者在做中改动）；上面那条 15 pass 的绿读数
测的正是这个脏文件，落地后必须复跑，本卡绿读数不可外推。
