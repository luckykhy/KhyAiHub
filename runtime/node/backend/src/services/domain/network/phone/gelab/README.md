# phone/gelab — GELab-Zero 动作文法接入

## 谁要

想让一个 GUI agent 模型（默认 StepFun GELab-Zero-4B）自己操作这台手机的人。
典型触发：`PhoneGuiAgent` 工具的 `start` action，或 `khy phone gui`。

## 为什么

上游 [stepfun-ai/gelab-zero](https://github.com/stepfun-ai/gelab-zero)（STEP-GUI）把 GUI
agent 的脏活做完了，但它的执行层是 **PC 侧 adb 脚本**：`adb shell input tap` 那一套。
本仓早就有一条更好的执行通道——手机内的 HTTP 桥（8896，39 个工具，含无障碍手势）。
这个单元就是把两者的接缝做出来：

- 模型说的语言 → `gelabActionGrammar`（0-1000 归一化坐标 + 11 个动作的文法解析）
- 归一化坐标 → 像素 → 桥工具调用 → `gelabActionMap`（唯一翻译表）
- 截图/观测 → `gelabScreenSource`（桥优先，adb 兜底）
- 执行与回报 → `gelabActuator` / `gelabAgentRunner`

**关键设计：模型的坐标是 0-1000 归一化的**，所以它不需要知道这台机器是 1200×2670。
旋屏、换机、折叠都不改 prompt，只改 `geometry`。

### 为什么执行走桥而不走 PC 侧 adb argv

同一个动作，走桥拿到的比裸 argv 多：参数校验、UI 准入门（`ui_tool_unavailable`）、
confirm 门、mailbox 兜底。在「模型自主点用户手机」这个场景里，这不是洁癖，是安全边界。
adb 只作为桥不可用时的后端 B，且 argv 一律经 `phoneBridgePolicy.buildAdbArgv` 生成。

### 为什么模型按需拉取、绝不内置

模型 8.88 GB（bf16），内置进服务器或 APK 都荒谬。整条拉取链由
`KHY_LOCAL_MODEL_ON_DEMAND` 门控、**默认关**，`PhoneGuiAgent` 的 `plan` action 负责把
「怎么开、怎么拉」原样告诉用户。本单元因此**不 require** provisioner（D1）——那是
enforced 规则 `d2-no-reach-into-d1` 的要求，也是分层本来的样子。

## 裁定记录（2026-10-23，人裁决，AI 提案）

七条待裁决问题的结论。每条都标了依据，方便日后条件变了重新裁。

| # | 问题 | 裁定 | 依据 |
|---|---|---|---|
| 1 | 默认 prompt 按哪代文法 | **0920 老文法（9 动作）**，adv 作可切 | 出货的 `mcp_server_config.yaml` 写 `task_type: "parser_0922_summary"`，而 `parser_factory.py` 把这个别名映射到 `copilot_tools.parser_0920_summary`。**别名是陷阱**：名字说 0922，类是 0920。直接后果：`ABORT` 的原因在 `value`（不是无必填）、`WAIT` 的 value 是**秒**（不是毫秒启发式）、`TYPE` 要求 value+point。 |
| 2 | 截图尺寸 | **等比缩放，不做 728×728 正方体** | 上游 `image_preprocess.target_image_size: [728,728]` 会把 1200×2670 拉变形；Qwen3-VL 原生动态分辨率，等比大概率不差。且正方体需要给 `shot_b64` 加 w/h，**要动手机侧**，与「手机侧 0 改动」冲突。上线前跑两轮 A/B 再定。 |
| 3 | full 还是 lite 构建 | **full（`ui:true` 可达）**，后端 A 可达 | 真机实测。lite 下 adb-screencap 通道仍可验。 |
| 4 | `KhyAccessibilityService.kt` 2 秒 latch 修不修 | **修，但拆成独立批次、排在 gelab 之前** | 该 bug 真实且与 gelab 无耦合：`latch.await(2, TimeUnit.SECONDS)` 与 `durationMs` 解耦，ms>1900 必误报「手势被系统取消」。但它动手机侧唯一一个文件，会破坏 gelab 批次的「手机侧 0 改动」CI 断言。先修它，gelab 批次才干净。修完 `longpressMaxMs` 才放开到 10000。 |
| 5 | B6：prompt 放不放仓库 | **内置一段自写中文技能文本 + `KHY_GELAB_PROMPT_FILE` 可一指切到用户自备上游原文** | B6 第 4 条禁的是第三方代码进登记材料；逐字搬上游 prompt 撞这条，自写不撞。留文件逃逸通道，团队若改变主意不用改代码。 |
| 6 | 父 `phone/khy.module.json` 的 `tests` 数组变旧 | **不改父 manifest** | `check-repo-layout` 不校验该数组；嵌套 manifest 已覆盖本目录，`_lifecycle_note` 里写明了为什么刻意不改（守 B3）。 |
| 7 | `KHY_GELAB_AGENT_TOOL` 走 config 叶子还是 flagRegistry | **只走 config 叶子** | 照 `AmooBridgeTool/index.js` 先例。同一个开关两个真源，正是该先例要避的；`unregistered-child` 仅可选 warning、默认不进 CI。 |

**上游参数对齐**（裁定 1 的附带产物，全部来自 `mcp_server_config.yaml` 实测）：
`temperature 0.1`、`top_p 0.95`、`max_tokens 4096`、`delay_after_capture 2s`——
本单元默认值逐项对齐。唯一刻意偏离：上游 `max_steps: 400`，本单元默认 **100**
（工具 schema 上限 200；400 步是「模型无人看管地点真人手机 400 次」）。

## 怎么验

```
cd runtime/node/backend
node --test src/services/domain/network/phone/gelab/*.test.js
```

三个守卫重点：
- `check-model-list-truth` — provisioner 不得直连 `ollamaAdapter.listModels()`，
  只能用 `ollamaModelManager.listModels()`。
- `check-model-hardcoding` — 模型名只在 `gelabConfig.js` 出现一次。
- `check-agent-rules` Rule 3 — deadline 必须是循环内按步检查的墙钟，
  绝不 `setTimeout` 杀进程。

**手机侧零改动**：`delivery/mobile/` 下所有文件对本单元只读。
`git diff --stat -- delivery/mobile/` 必须为空。
