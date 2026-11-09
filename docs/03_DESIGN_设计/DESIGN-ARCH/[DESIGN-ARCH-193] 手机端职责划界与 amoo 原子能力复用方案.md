<!-- IMPL-STATUS: todo -->
# [DESIGN-ARCH-193] 手机端职责划界与 amoo 原子能力复用方案

> **需求来源**：用户原话（逐条拆解见 §一）——「khyos 的 apk 我希望可以直接使用 amoo 中的模型」「amoo 的历史、记忆、工具是否能让 khyos 复用 amoo 的原子能力，避免重复使用」「工作时可以用一个悬浮窗显示」「希望具备完整肉包能力，但如果已有更优实现不要盲目照搬」「划清手机中 khyos 与 amoo 的职责」「khyos 与 amoo 都要可以单独使用但是又要能相互协作」「要有过程步骤的显示」。
> **定位**：回答「手机端 khyos 与第三方 amoo 之间职责怎么划、哪些原子能力可复用、悬浮窗与过程步骤怎么落地、肉包（roubao）哪些能力值得借鉴」这一组互相牵连的问题。本文是这些问题的**方案真源**。
> **不替代**既有真源，只声明衔接：`[DESIGN-ARCH-117]`（多端入口登记）、`[DESIGN-ARCH-120]`（移动端合并与幸存者）、`[DESIGN-ARCH-001]`（khy 移动智能体协议）、`[DESIGN-ARCH-071]`（通道选择决策矩阵）、`[DESIGN-ARCH-016]`（AI Agent 显示规范）、`[DESIGN-ARCH-113]`（AI 修改三模态反馈契约）、`[DESIGN-SOURCING-001]`（借鉴与实现统一规则），见 §十二。
> **状态**：草案 · 待批准。**本文引用的手机端/桥/PC 侧 amoo 代码大量尚未入仓**（见 §四.2 的证据前提），任何「已在仓里」的推断都不成立。所有验收命令中标注「未跑」的，不得记为已通过。
> **范围**：手机 APK 的模型通道选型；amoo 三形态（a 读配置 / b 当后端 / c 自带云模型）的取舍；悬浮窗生命周期与步骤显示；三端职责边界与共享契约；roubao 借鉴清单。
> **不改**：不新增规则 ID（`PROCESS-014` 棘轮已满）；本文**不是任何规则的语义真源，因此不携带 `RULES-REGISTRY` 标记**（体例同 `[DESIGN-ARCH-117]`/`192`）；不改 amoo 第三方应用的任何行为；不改 PC 侧既有 `khy amoo` 命令面的门控与语义；不引入第二套 amoo 协议。
> **边界**：khyquant 是独立项目，不在本文范围。amoo 是第三方应用（`com.stepos.ailauncher`），本文只定义「我能驱动它到哪里」，不定义它的内部。
> **上游依赖**：手机侧 `built_in_keys.dart` / `app_config.dart` / `chat_screen_new.dart` / `builtin_tools.dart` / `ToolEngine`；原生 `Tools.java` / `LoopModes.java` / `AmooLoop.java` / `AmooMemory.java` / `LoopVerify.java` / `BridgeService.java` / `BridgeOverlayService.java` / `HttpBridge.java`；PC 侧 `amooPanelViewModel.js` / `amooStatusProvider.js` / `amooDispatchRunner.js` / `amooBridgePolicy.js`；bridge 侧 `contracts.js`。
> **模板合规**：**借鉴类设计**（对象 roubao），按 `[DESIGN-SOURCING-001]` B-P2 六字段提案见 §十；只写结论不贴上游源码（B-P4）。
> **证据时效**：全部实跑与读码发生于 2026-10-23（E1–E13），工作区 HEAD `ed684bfe`、`git status --porcelain` 计 870 项。

---

## 一、需求来源：逐条原话与章节映射

用户在一段话里提了七个诉求。逐条拆开，每条给出**它在本文哪一节被回答**，以及**回答的前提是什么**。

| # | 用户原话 | 拆出的真实诉求 | 本文回答处 | 前提 |
|---|---|---|---|---|
| R1 | 「khyos 的 apk 我希望可以直接使用 amoo 中的模型」 | 手机上 khyos 用上 amoo 那套模型 | §七（模型通道） | **本仓物理上做不到「直接读 amoo 的模型」**——见 §七.2 |
| R2 | 「amoo 的历史、记忆、工具是否能让 khyos 复用 amoo 的原子能力，避免重复使用」 | 反向复用：拿 amoo 的原子能力 | §六（复用矩阵）；§七.2 形态 a 否决；§九.8 记忆真源 | 历史与工具**不可读**；记忆只能单向注入；「避免重复」的落点是 §六.1 |
| R3 | 「工作时可以用一个悬浮窗显示」 | 跨应用常驻浮层 | §八.1–§八.2 | 已有浮层，但生命周期绑在桥上 |
| R4 | 「希望具备 https://github.com/Turbo1123/roubao 完整的肉包能力，但是如果已有更优实现不要盲目照搬」 | 逐项比对，优者保留 | §十 B-P2 提案；§六.2 逐项对照表 | roubao `main` 的 manifest 未注册无障碍服务，见 E12 |
| R5 | 「划清手机中 khyos 与 amoo 的职责」 | 职责表 + 在场组合 | §五 | 三端职责表见 §五.1，四组合见 §五.2 |
| R6 | 「khyos 与 amoo 都要可以单独使用但是又要能相互协作」 | 独立性判据 + 协作判据 | §五.3（独立性判据）、§九（协作契约） | 独立可用性今天**部分不成立**（无内置密钥） |
| R7 | 「要有过程步骤的显示」 | 结构化步骤，不止一行文字 | §八.3–§八.4 | 今天只有一行 60 字，见 §八.2.3 |

> 一条必须提前说清的口气修正：用户说「直接使用 amoo 中的模型」。这句话在代码层面**没有实现面**（§七.2 形态 a）。能落地的只有「把 amoo 当聊天后端」（形态 b）。本文不把 b 伪装成 a。

---

## 二、定位 / 范围 / 不改 / 边界 / 上游依赖 / 模板合规

### 2.1 定位

本文是「手机端与第三方 amoo 协作面」的方案真源。它回答四个互相牵连的问题：**谁负责什么**（§五）、**哪些能力复用、怎么复用**（§六）、**界面怎么显示过程**（§八）、**哪些借鉴要付代价**（§十、§六.2）。

它**不是**：
- 不是 amoo 的规格文档（第三方，未反编译、未读其数据目录）；
- 不是安卓端架构总纲（那在 `[DESIGN-ARCH-001]` 与 `[DESIGN-ARCH-120]`）；
- 不是 PC 侧 `khy amoo` 命令面的规格（那在 `runtime/node/backend/src/cli/handlers/amoo.js` 与同目录 `README.md`）。

### 2.2 范围

| 在范围内 | 说明 |
|---|---|
| 手机 APK 的模型通道选型 | 自带云模型 / amoo 当后端 / 读 amoo 配置，三选一 + 切换条件 |
| 悬浮窗生命周期与内容 | 从「桥的生命周期」改到「有执行器在跑」 |
| 过程步骤的数据结构与三处采集点 | `StepEvent` + 三端渲染 |
| 三端职责表与四种在场组合 | khyos APK / amoo / PC / 共享契约 |
| 共享契约的字段清单 | 工具名集合、风险档、确认语义、步骤行形状、状态码 |
| roubao 借鉴提案（B-P2 六字段） | 见 §十 |

### 2.3 不改

- **不改 amoo 的任何行为**。不注入、不 hook、不读它的私有目录（§七.6、§九.7）。
- **不改 `Tools.NAMES` 的 39 项语义**，只把「工具名集合」抽出为契约（§九.6）。
- **不改 `LoopModes.defaultMode() = BYPASS`** 这一既有裁决。§九.7 把它列为必须由人拍板的开放问题（Q5），不自行修改。
- **不改 PC 侧 `khy amoo` 的门控**（`KHY_AMOO_BRIDGE_ENABLED` / `KHY_AMOO_MAILBOX_ENABLED`，`handlers/amoo.js:16-19` 自述）。
- **不动 `built_in_keys.dart` 的密钥数组**——仓库内保持空是消毒结论（该文件 `:1-9`、`:29-62`）。

### 2.4 边界

| 边界 | 含义 |
|---|---|
| amoo 是第三方 | `com.stepos.ailauncher`（`AmooLoop.java:71`）。它改一版 resource-id，整条闭环失效；本仓无法控制 |
| 手机 ≠ PC | 手机提供被调用的原语，不复制 PC 的跨设备编排（§五.1.3） |
| khyquant 是独立项目 | 不在本文范围 |
| 本文不改代码 | IMPL-STATUS 为 `todo`。所有「待建」标注即为此意 |

### 2.5 上游依赖

| 层 | 依赖 | 今天的状态 |
|---|---|---|
| 手机 Dart | `built_in_keys.dart`（9 provider 注册表） | 有表，**7 个密钥数组为空**（E6） |
| 手机 Dart | `app_config.dart`（`effectiveApiKey` / `isConfigured`） | 可读可写，`isConfigured` 今天恒 false（除非用户自填） |
| 手机 Dart | `chat_screen_new.dart`（`_sendWithAgentLoop` 是唯一真实循环） | 可用，`for (loop < 5)`（`:182`） |
| 手机原生 | `Tools.java`（39 工具唯一入口）、`KhyUi.java`、`KhyAccessibilityService.kt` | 可用；UI 类需无障碍授权 |
| 手机原生 | `AmooLoop.java` / `AmooMemory.java` / `LoopModes.java` / `LoopVerify.java` | 可用，**15 个 native 文件未入仓**（§四.2） |
| 桥 | `BridgeService.java` / `HttpBridge.java` / `BridgeOverlayService.java` | 可用；8896 只绑 loopback（`:302`） |
| PC | `amooPanelViewModel.js` / `amooStatusProvider.js` / `amooDispatchRunner.js` | 可用，叶子测试全绿（E2、E3） |
| bridge | `contracts.js`（12 工具名，`PROTOCOL='khy-amoon/1'`） | 可用，**与 8896 栈不共用凭据**（§九.1） |
| 外部 | amoo 应用（第三方） | 未装时 `foregroundPackage()` 不等于 `AMOO_PKG`，报 `amoo_not_foreground`（语义错，§五.2.1） |

### 2.6 模板合规

本文**属借鉴类设计**（借鉴对象 roubao），按 `[DESIGN-SOURCING-001]` §三 B-P2 填六字段提案，见 §十。

- **B-P2.1 强制顺序**：本文只提提案，**不含任何 vendored 的上游代码**；实施时先提案后编码。
- **B-P4 不保存上游源码**：本文只记录结论、签名级结构描述（如回调名 `stopCallback`）与文件行号，不贴上游实现。
- **B-P3 决策权限**：本文所提借鉴方式均为 `idea`/`reference`（自评 + 任一评审即可），**不主张 `vendored` 或 `fork`**。若后续要对 `skills.json` 数据资产做 vendored，须按 B-P3 由仓库 owner 显式批准并单独立项。

---

## 三、证据口径

| 标记 | 含义 |
|---|---|
| `[读]` | 本次实际读过的文件与行 |
| `[跑]` | 本次实际运行过的命令，逐条给出输出 |
| `[未跑]` | 声称需要但本次没有执行的检查 |
| `[未读]` | 明确没有读的材料 |

### 3.1 证据前提（先说清楚，否则后面的引用会误导）

工作区 HEAD `ed684bfe`（`git rev-parse --short HEAD`），`git status --porcelain` 计 **870** 项。本文引用的**大量代码尚未入仓**：

- `delivery/extension/bridges/khy-amoon-bridge/`、`runtime/node/backend/src/services/domain/network/amoo/`、`.../network/phone/` 三个目录整体为未跟踪；
- APK 侧 15 个 native 文件（`AmooLoop.java`、`AmooMemory.java`、`AmooProtocol.java`、`LoopModes.java`、`LoopState.java`、`LoopVerify.java`、`HttpBridge.java`、`BridgeService.java`、`BridgeOverlayService.java`、`BridgeToken.java`、`ReviveReceiver.java`、`BootReceiver.java`、`ShellSidecarClient.java`、`AmooChatText.java`、`AmooSelfDesc.java`）、`lib/core/services/amoo_service.dart`、`lib/ui/widgets/amoo_composer.dart` 同样未跟踪；
- 桌面端 `apps/khyos-desktop/src/renderer/components/amoon/` 未跟踪。

`Tools.java` 与 `KhyUi.java` 是已跟踪的。所以下文的 `file:line` 都指向**工作区今天存在的代码**，不是已提交内容。

### 3.2 E 表：本次实跑与已读

| # | 命令 / 检查 | 输出（原样或摘要） | 结论 |
|---|---|---|---|
| E1 | `cd runtime/node/backend && node --test src/services/domain/network/amoo/*.test.js src/services/domain/network/amoo/client/*.test.js` | `# tests 187` / `# pass 187` / `# fail 0` / `# skipped 0`（14 个测试文件，`dir /b ... \| find /c /v ""` = 14） | PC 侧 amoo 叶子全绿 |
| E2 | `cd delivery/extension/bridges/khy-amoon-bridge && node --test test/*.test.js` | `# tests 186` / `# pass 186` / `# fail 0` / `# skipped 0`（16 个测试文件） | bridge 全绿 |
| E3 | `cd delivery/mobile/khy-os-client-app && D:\Portable\2-tools\flutter\flutter\bin\flutter.bat test` | `00:14 +257 -1: Some tests failed.`；唯一失败 `test/app_config_test.dart:165` → `Expected: <true>` / `Actual: <false>`（`BuiltInKeys defaultProvider has a key`） | **Dart 侧 257 通过 / 1 失败**；失败点即「内置密钥全空」。`flutter` 不在 PATH，必须用该绝对路径 |
| E4 | `cd delivery/mobile/khy-os-client-app/android && gradlew.bat :app:testDebugUnitTest --offline --rerun-tasks` | `BUILD SUCCESSFUL in 2m 48s` / `158 actionable tasks: 158 executed`；从 `build/app/test-results` 聚合 11 suite / 216 testcase / 0 failures+errors | Android 单测全绿 |
| E5 | `node -e` 解析 `built_in_keys.dart`（临时脚本，已删除） | `providers=9`；`SupXH \| Command Code \| 智谱 GLM \| OpenCode Go \| OpenRouter \| Sense Nova \| Agnes \| StepFun \| OpenCode Zen`；`keyArrays: _supxh:EMPTY _commandcode:EMPTY _glm:EMPTY _opencodego:EMPTY _sensenova:EMPTY _agnes:EMPTY _stepfun:EMPTY` | 9 provider，**7 个密钥数组全空** |
| E6 | `node -e` 比对 `Tools.NAMES` 与 `LoopModes.KNOWN_TOOLS`（临时脚本，已删除） | `Tools.NAMES=39` / `KNOWN_TOOLS=36` / `onlyInTools=amoo_ask,amoo_result,amoo_memory` / `onlyInKnown=`（空） | **差集正是三个 amoo 工具** |
| E7 | `node -e` 读 `amooPanelViewModel.buildAmooPanelModel` | `empty tone=idle headline=尚未读取手机状态 rows=7`；20 步输入 → `capped=12 first=s8 headline=正在向 Amoo 下发任务…` | 固定 7 行、步骤截 12，行为与 `:26`/`:42` 声明一致 |
| E8 | `cd delivery/extension/bridges/khy-amoon-bridge && node -e "require('./lib/contracts').listToolNames()"` | `toolNames=12`：`ping,bridge_status,khy_ask,phone_screenshot,phone_ui_dump,phone_info,phone_app_list,phone_ls,phone_exec,amoon_send,amoon_inbox,mailbox_status` | bridge 契约 12 项 |
| E9 | `node -e` 读 `amooBridgePolicy.BRIDGE_TOOLS` | `BRIDGE_TOOLS=22`：`ping,info,ls,read,stat,list_apps,battery,clipboard,write,mkdir,mv,cp,rm,exec,start_app,open_url,share_text,toast,notify,volume,brightness,vibrate` | **与 E8 交集只有 `ping`** |
| E10 | `node -e` 读 `phoneBridgeCatalog` | `bridgeTools=28` / `uiTools=11` | 第四份清单 |
| E11 | `cd %TEMP%\roubao_up && git rev-parse --short HEAD && git log -1 --format=%ci` | `c8a6d7f` / `2026-01-08 18:41:05 +0800` | 上游基线 |
| E12 | `cd %TEMP%\roubao_up && findstr /s /i /m /c:"AccessibilityService" app\src\main\java\*.kt`；`findstr /n /c:"Baozi" app\src\main\AndroidManifest.xml`；`findstr /n /c:"accessibility" /c:"BIND_ACCESSIBILITY" app\src\main\AndroidManifest.xml`；`dir /b app\src\main\res\xml` | 第一个命令零输出；manifest 里 `Baozi` 只命中 `Theme.Baozi`（`:64`、`:93`）两处主题名，`accessibility` 零命中；`res/xml` 只有 `file_paths.xml`、`network_security_config.xml` | **`main` 分支有 `acs_svc.kt` 定义的 `BaoziAccessibilityService` 类，但 manifest 未注册该服务、也没有 `accessibility-service` 配置 XML**；manifest 的 service 只有 `.ui.OverlayService`（`:102`）。所以无障碍能力在 `main` 上不可用 |
| E13 | `node runtime/node/backend/bin/khy.js amoo help` | 打印 `khy amoo` / `status` / `plan` / `send` / `client` / `prompts` / `workspace` 七个入口 + 三条诚实边界（lite 桥无 UI 工具、Amoo 必须在前台、日常优先走 `khy amoo client`） | PC 侧命令面**存在且可跑** |

**本轮读过的关键行**（全部 `[读]`）：

- 手机 Dart：`built_in_keys.dart:1-9`（消毒说明）、`:29-62`（七个空数组）、`:66-205`（9 个 `_KeyEntry`）、`:240-245`（`defaultProvider` 兜底）、`:298`（`hasKey` 排除 `'public'`）；`app_config.dart:35-43`（`effectiveApiKey` / `isConfigured`）、`:114-134`（`effective`）、`:137-169`（`FlutterSecureStorage`）；`model_registry.dart:32-50`（`fetchModels` 吞异常返回 `[]`）、`:53-68`（`fetchAllModels` 首句 `if (!p.hasKey) continue`）；`chat_screen_new.dart:118-121`（未配置报错）、`:182`（`for (loop < 5)`）、`:193-202`（`dio.post` 无 `stream`）、`:260-320`（步骤登记 + 执行 + 结果）、`:1290-1315`（429 处理）、`:1401-1438`（`_autoFailover`）、`:1484-1513`（`_dangerousPatterns` 子串匹配与审批名单）、`:1582-1621`（`_getToolLabel` 已是「动词: 目标」）；`execution_log.dart:4`（`ExecState` 五态）、`:7-79`（`ExecutionStep` + `durationMs` + `summary`）；`tool_engine.dart:91-96`（`canExecute` 只看 `deny`）、`:105-138`（`execute` 无取消钩）；`builtin_tools.dart:13`（`createBuiltinTools`）、31 处 `ToolDef(`、`:412-438`（`exec_shell_elevated`）；`settings_screen_new.dart:716-749`（模型清单降级链）；`khyos_api.dart:176/201/255-258`（`/api/ai/models`、`/api/ai/chat/stream`、`/api/mobile/execution-log`）；`amoo_service.dart:17-22`（包名/组件/`OPEN_CHAT` 常量）、`:50-93`（`shareText`）、`:129-164`（`installed`）、`:182-187`（`displayMessage`）。
- 手机原生：`AmooLoop.java:30-64`（六条设计注记）、`:71-74`（resource-id）、`:101`（`volatile String progress`）、`:146-148`（`step()`）、`:199-247`（`ask`）、`:212-217`（前台检查）、`:305-321`（`askResult`）、`:328-381`（`runAsk`）、`:443-477`（`start` / `stop`）、`:481-640`（`runLoop`）、`:651-699`（`executeOne`）、`:676-693`（三态写回）、`:397-417`（`loadMemory` / `saveMemory`）、`:1037-1054`（`describeStop`）；`AmooMemory.java:13-19`（云端环境自述）、`:38-43`（两档确信度）、`:67`（`/sdcard/bridge-amoobridge/amoo_memory.json`）、`:69`（`MAX_ENTRIES=60`）、`:140-166`（`with` 不降级）、`:178-198`（`renderForInjection` 加 `[未证实]`）；`LoopModes.java:62`（`HIGH_RISK_TOOLS = exec, rm`）、`:70-76`（`KNOWN_TOOLS` 36）、`:116-152`（`decide`）、`:163-165`（`defaultMode()=BYPASS`）、`:424-445`（`normalizeTool`）、`:455-463`（`isKnownTool`）；`LoopState.java:40-58`（六个原因码 + `STALL_AFTER_POLLS=5`）、`:115-147`（`shouldStop`）；`LoopVerify.java:21`（四种 `Kind`）、`:57-86`（`plan`）；`Tools.java:106-114`（`NAMES` 39）、`:116-123`（别名折叠）、`:227-234`（`loop_*` / `amoo_*` 分派）、`:325-345`（`amooAsk`）、`:534-572`（`exec` 三级降级 + `via`）；`KhyUi.java:40-71`（`isReady` + 未授权中文指引）、`:75-88`（`dump` 走 `rootInActiveWindow`）；`BridgeOverlayService.java:47-52`（2s 节拍）、`:75-78`（无权限 `stopSelf`）、`:132-141`（气泡 44dp）、`:198-248`（面板 + 四按钮）、`:265-327`（`refreshPanel`，注释声明零 IO）、`:329-346`（`copyToken` 用 `currentToken`）；`BridgeService.java:40-46`（`onCreate` 拉起浮层）、`:64-70`（`stopBridge` 撤浮层）、`:112-146`（`loop` + 10s 自愈）、`:148-173`（`status.json` 十一个字段）、`:175-206`（文件信箱 `cmd_*.json`）；`HttpBridge.java:41`（`DEFAULT_PORT=8896`）、`:50`（`PC_REACHABLE_WINDOW_MS=90000`）、`:104`（`tokenFile`）、`:125-127`（`currentToken` 零 IO）、`:283-324`（`start` 绑 `127.0.0.1`）、`:342-394`（`handle` + `/ping` `/status` `/call`）、`:372-375`（Bearer 校验）；`AmooSelfDesc.java:46-62`（按 `Tools.NAMES` 派生分组）、`:72-90`（`groupsCoverEveryToolExactlyOnce`）；`AmooProtocol.java:236`（`isKnownTool` 过滤）；`MainActivity.kt:30-46`（`SHELL_ALLOW` / `SHELL_DENY`）、`:56-160`（MethodChannel handler 列表，无 loop/amoo 工具）、`:563-572`（`isCommandAllowed`）、`:839-980`（`amooStatus` / `sendToAmoo` / `openAmoo`）、`:1190-1194`（四个 Intent 常量）。
- PC 侧：`amooPanelViewModel.js:26`（`ROW_KEYS` 7 项）、`:36`（`TONES`）、`:40`（`MAX_DETAIL_CHARS=120`）、`:42`（`MAX_STEPS=12`）、`:345-360`（`_progressRows`）、`:362-369`（`_capSteps`）、`:441-487`（`buildAmooPanelModel` 返回体）；`amooStatusProvider.js:44`（`MAX_PROGRESS_STEPS=24`）、`:249-266`（`noteStep`）、`:272-287`（`notePoll`）、`:293-298`（`noteDispatchResult`）；`amooDispatchRunner.js:326`（`onStep({id, ok, detail})`）、`:374-451`（十步固定 id 序列）；`amooDispatchPlan.js:259-271`（`STOP_REASON_TEXT` 三键）；`amooBridgePolicy.js:31-177`（`BRIDGE_TOOLS` 22 项）；`phoneBridgeCatalog.js:601-679`（`UI_TOOLS` / `getPhoneBridgeUiTools`）；`routes/a2a.js:37/42`（`createServerMethods()` 无参构造）、`:54-61`（`maybeAuth` fail-open）；`services/a2a/serverMethods.js:42-57`（`defaultExecutor` 回显 `received: ...`）、`:66-68`（executor 注入点）；`agentCardSpec.js:90`（`streaming: false`）、`:13`（注释自述「全仓没有一行 SSE 实现」）；`cli/handlers/amoo.js:16-19`（门控）、`:217-246`（`handleAmoo` 分派）、`:251-259`（manifest 声明）、`:11-14`（README 式方向说明）。
- bridge：`contracts.js:27-28`（`PROTOCOL='khy-amoon/1'`、`BRIDGE_VERSION='0.1.0'`）、`:34-46`（`SIDES`/`RISKS`/`SCOPES`）、`:54-61`（`STATES`）、`:78-80`（`ERROR_CODES`）。
- 上游 roubao（`%TEMP%\roubao_up`，HEAD `c8a6d7f`）：`LICENSE:1`（MIT License）、`AndroidManifest.xml:102`（`.ui.OverlayService`）、`OverlayService.kt:43-45`（三个回调）、`:65-68`（`hide` 清空回调）、`:84`（`setVisible`）、`:91-94`（`showTakeOver`）、`:111-114`（`showConfirm`）、`:272-321`（三按钮分支）；`MobileAgent.kt:171-175` 与 `:408-411`（截图前后 `setVisible(false/true)`）、`:428-434`（`reflector.getPrompt` / 解析 A/B/C）、`:1098-1105`（`errorFlagPlan`）；`ShellTool.kt:31`（`ALLOWED_PREFIXES`）、`:121`（**该行是注释掉的校验**）；`app/src/main/assets/skills.json`（21 条，`related_apps[].type ∈ {delegation, gui_automation}`）。

### 3.3 未跑与未读

| 项 | 状态 | 说明 |
|---|---|---|
| 构建 APK | **未跑** | 本轮只跑单测，没有 `assembleRelease`，也没有装真机 |
| 真机验证（无权限路径、软键盘遮挡、浮层是否进 `rootInActiveWindow`） | **未跑** | 全部只有代码阅读结论 |
| amoo 单轮实际耗时 | **未跑** | 代码注释自述「约 6 分钟」（`AmooLoop.java:46-49`、`Tools.java:328`），本轮未计时 |
| `amoo_ask` 端到端 | **未跑** | 需 amoo 在前台 + 无障碍授权 |
| 远程模式实际响应码 | **未跑** | §七.7 的「大概率 404」是从路由表读出来的（`server.js:586` 透明代理 + `ai-backend/src/routes/ai.js:34` 只有 `POST /chat`），不是实测响应码 |
| PC 侧六套记忆存储 | **未读** | 只沿用仲裁材料结论，未逐套读 |
| `amooBridgeClient.js` 全文 | **未读** | 只读了令牌读取路径相关片段 |
| `scripts/gen_keys.py` / `scripts/check_builtin_keys.py` | **未读** | 只在 `built_in_keys.dart:5/8` 注释里见到文件名 |
| amoo 应用内部实现 | **未读** | 第三方，未反编译、未读其数据目录 |

---

## 四、现状盘点

三端各一小节。只保留判据需要的行号，细节在 §七–§九 展开。

### 4.1 手机 APK（khyos 侧）

| 维度 | 今天的事实 | 证据 |
|---|---|---|
| 模型通道 | 自有 provider 注册表 9 项，走 `${baseUrl}/chat/completions`（无 `stream`）；**7 个密钥数组全空**，`defaultProvider` 落到第一个 provider 但 `hasKey=false` | `built_in_keys.dart:66-205`、`:29-62`、`:240-245`；`chat_screen_new.dart:193-202`；E5 |
| 配置可用性 | `isConfigured = baseUrl 非空 && effectiveApiKey 非空`；无存档时返回空配置；独立模式因此直接报「API 未配置」 | `app_config.dart:42-43`、`:147`；`chat_screen_new.dart:118-121` |
| 模型清单 | 在线 `GET $baseUrl/models`，异常一律 `return []`；静态清单取自 `_registry.models`（不看密钥，可用） | `model_registry.dart:32-50`、`:71-79`；`settings_screen_new.dart:716-749` |
| agent 循环 | 唯一真实路径是 `_sendWithAgentLoop`，`for (loop < 5)`；`AgentLoop` 类无调用者 | `chat_screen_new.dart:152`、`:182` |
| 工具（Dart） | `createBuiltinTools()` 返回 31 个 `ToolDef(`（含 `exec_shell`、`exec_shell_elevated`、11 个 `a11y_*`） | `builtin_tools.dart:13`、E 表实测 31 处 `ToolDef(` |
| 工具（原生） | `Tools.NAMES` 39 项；`exec` 三级降级并回 `via` | `Tools.java:106-114`、`:534-572` |
| 危险命令判定 | Dart 侧 `_dangerousPatterns` 是 12 条子串匹配；审批名单只含 `exec_shell`/`android` | `chat_screen_new.dart:1484-1513` |
| 权限执行面 | `PermissionLevel.ask` 无执行面（`canExecute` 只看 `deny`）；`exec_shell_elevated` 不在 Dart 审批名单内 | `tool_engine.dart:91-96`、`:105-138`；`builtin_tools.dart:412-438` |
| 历史 | `FlutterSecureStorage` 单 key blob + 索引 | `conversation_db.dart:3-7` |
| 无障碍 | `KhyAccessibilityService` 提供 tap/swipe/find/dumpUi/typeText/global/clickable；未授权时 `KhyUi.dispatch` 返回中文指引 | `KhyAccessibilityService.kt:37-295`；`KhyUi.java:44-71` |
| 浮层 | `BridgeOverlayService` 由 `BridgeService.onCreate` 拉起；一行 60 字进度 + 四按钮 | `BridgeService.java:44`、`:67`；`BridgeOverlayService.java:279-285`、`:225-241` |
| 桥 | `HttpBridge` 绑 `127.0.0.1:8896`，Bearer 32 hex，`/ping` `/status` `/call` | `HttpBridge.java:41`、`:283-324`、`:372-391` |

### 4.2 amoo（第三方）

| 维度 | 事实 | 证据 |
|---|---|---|
| 身份 | `com.stepos.ailauncher`；khyos 与它的接触面只有 UI 自动化 + Intent 分享 | `AmooLoop.java:71`；`amoo_service.dart:17-22`；`MainActivity.kt:839-980` |
| 模型 / 密钥 | **不可读**。全仓无 `data/data/com.stepos.ailauncher` 相关路径拼接 | §七.2 形态 a |
| 历史 | **不可读**。`AmooMemory.java:13-19` 自陈 amoo 执行环境在云端、`/sdcard` 对它不存在 | 同上 |
| 反向使用 | 只能把 amoo 当聊天后端：`ask` 异步、单发、必须前台、约 6 分钟/轮 | `AmooLoop.java:199-247`、`:212-217`、`:328-381` |
| 协议 | 围栏 `khy-exec/khy-plan/khy-done` 在这台设备上**不进入无障碍树**，退化为「整行是一个 JSON 对象」形状判据 | `AmooLoop.java:571-580` 注释；`AmooProtocol.java:225-240` |
| 自描述 | `AmooSelfDesc.render()` 按 `Tools.NAMES` 派生 39 工具分组，`MAX_CHARS=2600` | `AmooSelfDesc.java:46-62`、`:33`、`:118-149` |

### 4.3 PC 侧 khy-os

| 维度 | 事实 | 证据 |
|---|---|---|
| 命令面 | `khy amoo` 七个子命令；`send` 默认只给计划，需 `--confirm` | E13；`handlers/amoo.js:11-14`、`:230-245` |
| 下发链 | 十步固定 id：`ensure-device → ensure-forward → bridge-ping → launch-amoo → focus-input → focus-input-tap → fill-text → verify-input → tap-send → poll-reply` | `amooDispatchRunner.js:384-451` |
| 行模型 | 固定 7 行 `ROW_KEYS`；`MAX_STEPS=12`；`MAX_DETAIL_CHARS=120`；`TONES = ok/warn/error/idle/busy` | `amooPanelViewModel.js:26`、`:42`、`:40`、`:36` |
| 供数 | `noteStep/notePoll/noteDispatchResult`；进度步上限 24 | `amooStatusProvider.js:249-298`、`:44` |
| 渲染 | TUI `CcPhoneLinkPanel` 逐条渲染 `<icon> id  detail`；桌面 `AmoonPane` **不消费行模型**（grep `steps`/`progress`/`badges` 零命中） | `CcPhoneLinkPanel.js:157-184`；`AmoonPane.tsx` |
| 策略 | `amooBridgePolicy.BRIDGE_TOOLS` 22 项，`rm`/`exec` 为 `requiresConfirm` | `amooBridgePolicy.js:31-177` |
| A2A | `createServerMethods()` 无参构造 → `defaultExecutor` 只回显；`streaming: false` | `routes/a2a.js:42`；`serverMethods.js:42-57`、`:66-68`；`agentCardSpec.js:90` |

---

## 五、职责边界

> 先说一个口径问题：用户说「手机中 khyos 与 amoo 的职责」。物理上不是两个对等方——amoo 是第三方应用，khyos 只能驱动它。所以「职责边界」的实际形态是**「谁有能力，谁就只能用它」+「谁能决定，谁就只决定它」**，而不是分工协商。

### 5.1 三端职责表

「三端」的准确说法是**四类主体**：khyos APK、amoo 第三方应用、PC 侧 khy-os，外加一份共享契约。契约没有运行时，但它是所有跨端名字的唯一真源。

#### 5.1.1 khyos APK —— 自己也是一台完整 agent

| 维度 | 必须自己有什么 | 可以从对方借什么 | 绝不代管什么 |
|---|---|---|---|
| 模型 | 自己的云模型通道（`built_in_keys` 9 provider + `chat_screen_new.dart:193-202` 直连） | 把 amoo 当**可选上游模型**（分钟级、单发、需前台），见 §七.3 | amoo 的模型选择/上下文/配额。`AmooLoop.java:207-217` 只能往输入框写文本、读屏幕文本 |
| 记忆 | `AmooMemory.java:34-249`（60 条上限、VERIFIED/UNVERIFIED 两档、只有「执行成功且验证通过」写 VERIFIED） | 无。amoo 记忆不可读（`AmooMemory.java:13-19`） | amoo 的会话历史 |
| 工具 | `Tools.java:106-114` 39 个 + `builtin_tools.dart:13` 起的 31 个 Dart 工具 | amoo 的「脑子」可下发命令文本，但**命令永远是 khyos 自己的工具名**（`AmooSelfDesc.java:46-62` 按 `Tools.NAMES` 派生） | amoo 自己的工具（它没有对外工具 API） |
| 身体 | 无障碍（`KhyAccessibilityService.kt`）、截图（`KhyUi.java:75-88`，API 30+）、三级 `exec`（`Tools.java:534-572`）、悬浮窗 | 无。这是不可被 amoo 替代的资产 | 无 |
| 过程显示 | 悬浮窗自绘（`BridgeOverlayService.java:265-327`），步骤自己攒 | 行模型形状与 PC 面板对齐（`amooPanelViewModel.js:345-369`） | PC 面板的下发计划与 TTL 快照 |

**今天不成立的一条**：APK 内部自己发起 amoo 闭环。`Tools.loopStart` 只经 `HttpBridge` 的 `/call`（`HttpBridge.java:384-391`）与文件信箱（`BridgeService.java:175-206`）可达；`MainActivity.kt:56-160` 的 MethodChannel handler 列表里**没有任何 loop_/amoo_ 项**；`findstr /s /n /c:"amoo_ask" /c:"loop_start" lib\*.dart` 零输出。所以「手机 App 自己起闭环」是**待建**。

#### 5.1.2 amoo —— 第三方，只能被驱动

| 维度 | 它必须自己有 | khyos 可以借 | khyos 绝不代管 |
|---|---|---|---|
| 模型 | 云端大脑 | 仅「把它的一轮对话当推理调用」（`AmooLoop.java:328-381`） | 它的模型清单、key、流式协议 |
| 记忆 | 它自己的会话 | 无 | 它的私有存储（`MANAGE_EXTERNAL_STORAGE` 也到不了第三方私有目录） |
| 工具 | 它自己的云端工具 | 无 | 它的工具执行 |
| UI | `com.stepos.ailauncher` 聊天页，三个 resource-id | 读它渲染出的文本、往它输入框写文本 | 它的进程、它的界面结构 |

**依赖的脆弱处必须写进契约**：资源 id 是量出来的（`AmooLoop.java:68-70` 注明输入框随软键盘上移约 1300px，坐标必须当次现算），对方改版整条闭环就断。

#### 5.1.3 PC 侧 khy-os —— 跨设备编排与审计

| 维度 | 必须自己有什么 | 可以从手机借 | 绝不代管 |
|---|---|---|---|
| 编排 | `amooDispatchRunner.dispatchTask`、`amooStatusProvider` 的 TTL 单飞供数、固定行模型 | 手机的 8896 桥（PC 经 adb forward 进来） | 手机侧的安全判定（`LoopModes.java:116-152` 与 `amooBridgePolicy.js` 是两份口径） |
| 审计 | `amooPanelViewModel` 步骤行（上限 12） | — | 手机悬浮窗的渲染 |
| 模型面入口 | bridge 的 `khy_ask`（`contracts.js` 的 12 工具之一） | — | 手机端工具执行 |

#### 5.1.4 共享契约 —— 名字与语义的唯一真源

今天**不存在**一份跨三端的契约文件。现存的是**四份互不相干的清单**（E8–E10）：

| 清单 | 位置 | 项数 |
|---|---|---|
| `contracts.listToolNames()` | `bridges/khy-amoon-bridge/lib/contracts.js` | 12 |
| `amooBridgePolicy.BRIDGE_TOOLS` | `services/domain/network/amoo/amooBridgePolicy.js:31-177` | 22 |
| `phoneBridgeCatalog`（`khyName` + `UI_TOOLS`） | `services/domain/network/phone/phoneBridgeCatalog.js` | 28 + 11 |
| `Tools.NAMES` | `Tools.java:106-114` | 39 |
| `LoopModes.KNOWN_TOOLS` | `LoopModes.java:70-76` | 36（差 3 个 amoo 工具） |

**交集**：12 与 22 之间只有 `ping`（E8/E9 逐项比对）。连「同一个文件工具叫 `read` 还是 `phone_read`」都没统一。

契约必须**待建**，且必须是构建期校验而非运行期可选（§九.6）。

### 5.2 四种在场组合

#### 5.2.1 只有 APK（没装 amoo、PC 不在线）

| 维度 | 今天的行为 |
|---|---|
| 模型 | 自己直连；**但开箱不可用**——7 个密钥数组全空，`isConfigured=false`，报「API 未配置」（`chat_screen_new.dart:118-121`）。这是配置缺口，不是架构缺口 |
| 记忆 | `amoo_memory.json` 仍可读写（`AmooLoop.java:397-417`），落盘失败被静默忽略（`:398-406` 设计如此），退为进程内存态 |
| 工具 | Dart 31 个走 MethodChannel；原生 39 个只有桥在跑时才经 HTTP/信箱可达 |
| 悬浮窗 | 桥在跑就在（`BridgeService.java:44`）；无 `SYSTEM_ALERT_WINDOW` 时浮层 `stopSelf`（`BridgeOverlayService.java:75-78`），桥照常 |
| **行为判据（今天做不到）** | amoo 相关工具必须显式报「amoo 未安装」，而不是 `amoo_not_foreground`。`AmooLoop.java:212-216` 只检查前台包名，未装时 `foregroundPackage()` 不等于 `AMOO_PKG` → 报 `amoo_not_foreground`，**语义错了**。这条是待建 |

#### 5.2.2 只有 amoo（没装 khyos）

amoo 功能完全不受影响。不是推断：`AmooMemory.java:13-19` 自陈两边唯一介质是 amoo 的对话流、剪贴板与桥目录；`amoo_service.dart:9-12` 同样只声称 Intent 与读屏两条路。khyos 缺席时没有任何代码会对 amoo 注入。

#### 5.2.3 两者都在（khyos 驱动 amoo）

这是「APK 用上 amoo 的模型」唯一可落地的形态。能力分配：

| 能力 | 落点 | 证据 |
|---|---|---|
| 模型 | amoo 的云端 | `AmooLoop.java:328-381`；单轮预算 `Tools.java:337` 夹在 15s..30min，默认 420s |
| 记忆 | 两端各一份，**真源在手机** | §九.8 |
| 工具 | 全部在手机本地 | `AmooLoop.java:668` `Tools.dispatch(parse.tool, parse.args)` |
| 悬浮窗 | 手机原生，只有一行 | `BridgeOverlayService.java:279-285` |

**三条今天立不住的前提，必须写进契约而不是藏起来**：

1. 同时只能一个 ask：`AmooLoop.java:199-202` 见 `askRunning` 直接返回 null，`Tools.java:339-342` 翻成「已有一个反代任务在进行中」。排队语义**待建**。
2. 必须 amoo 在前台：`AmooLoop.java:212-217`；`:207-211` 注释说清为什么（提示词会落进自家输入框，然后白等整个预算）。
3. 返回的是「最新气泡原文」，靠两次连续相同采样判稳（`AmooLoop.java:357-371`）。流式中途恰好停在相同片段会被提前判完——这是已知风险，不是 bug。

#### 5.2.4 APK + PC（PC 作中介）

| 维度 | 事实 |
|---|---|
| 模型 | 仍在各自。PC 的模型额度**不能**给手机用——`routes/a2a.js:42` 用 `createServerMethods()` 无参构造，`serverMethods.js:42-57` 的 `defaultExecutor` 只回显 `received: ...`，`:66-68` 才是注入点；`agentCardSpec.js:90` 的 `streaming` 钉死 false。**今天「手机用 PC 的模型」是零** |
| 记忆 | 不共享 |
| 工具 | PC 经 adb forward 到 8896 调 39 个工具（`HttpBridge.java:384-391`，Bearer 校验 `:372-375`）；`pc_reachable` 由 `PC_REACHABLE_WINDOW_MS=90000` 判定（`:50`、`:84-87`），写进 `status.json`（`BridgeService.java:163`）。PC 不在线是**正常模式**不是故障 |
| 悬浮窗 | 今天**没有读 `pcReachable()`**，所以「独立工作 / 协作中」这一行是待建。PC 面板与手机悬浮窗是两条互不相通的显示通道 |

### 5.3 独立性判据（R6 的可验收形态）

| 场景 | 判据 | 今天成立吗 |
|---|---|---|
| khyos 单独可用 | 卸载 amoo 后 app 可启动、可对话、可执行 `open_app`/`exec_shell`/`a11y_*`；amoo 卡片显示「未安装」 | **部分**：启动与工具成立，但「可对话」需要用户自填 key（E5/E3）；amoo 卡片的是否「未安装」文案未验证 |
| amoo 单独可用 | 未装 khyos 时功能不受影响 | **成立**（§5.2.2） |
| 两者协作·形态一（khyos 驱动 amoo） | amoo 前台 + 无障碍已授权 + 由 PC 或 App 发起 `loop_start` | **PC 侧成立**（E13），**App 侧待建** |
| 两者协作·形态二（amoo 调 khyos 模型） | 需一次真实 executor 注入 | **不成立**（§5.2.4） |
| 两者协作·形态三（PC 中介） | 需 adb forward + Bearer + 设备侧 `pc_reachable` | **成立**（`HttpBridge.java:283-324`） |
| 失败隔离 | 任一方缺席都不得把另一方显示为故障 | **部分**：`amoo_not_foreground` 与「未安装」没分开（§5.2.1） |

---

## 六、原子能力复用矩阵

九项能力逐行给出：持有者 / 复用方式 / 降级。**「复用方式」是建议，不是现状**——现状列在「降级」里。

| 能力 | 持有者（唯一） | 复用方式 | 降级（今天的行为） |
|---|---|---|---|
| **模型（云模型直连）** | khyos APK | **复用**：`built_in_keys.dart:66-205` 的 9 provider 注册表 + `app_config.dart:35-38` 的 `effectiveApiKey` + `chat_screen_new.dart:193-202` 直连 | 无密钥且用户未填 → `chat_screen_new.dart:118-121` 直接报「API 未配置」，不静默降级。**这是正确行为，保留** |
| **模型清单** | khyos APK | **扩展**：把 `built_in_keys` 的静态 `models` 与 `provider_adapter.dart` 的 DeepSeek/Anthropic 适配器收敛为一份清单来源；不是新建第二套 | provider 不可达 → `model_registry.dart:47-49` 返回空；`:71-79` 回退内置清单；两者都空时设置页无法选模型（`settings_screen_new.dart:743-747`） |
| **模型通道（把 amoo 当后端）** | khyos APK | **扩展**：把 `AmooLoop.askResult` 接进 Dart 的 `ToolEngine`，在桥里补排队语义。**代价必须写清**（见 §七.3 表） | amoo 未装/不在前台 → `amoo_not_foreground`；无障碍未授权 → 读屏在 `AmooLoop.java:518-528` 每轮失败并 `continue`、写回在 `:846-852` 直接放弃（内容转存 pending 文件），整轮只能靠 deadline 收尾（`LoopState.DEADLINE`）；两者都不影响自带云模型通道 |
| **对话历史** | khyos APK（各自持有） | **复用**：`conversation_db.dart`（单 key blob + 索引），chat 页在结束时保存。amoo 历史读不出也写不回 | 无跨端同步。`khyos_api.dart:255-258` 上报 `/api/mobile/execution-log`，但 `runtime/node/backend/src` 全量 grep `execution-log`/`executionLog` 零命中——**该端点在 PC 侧不存在**，日志只在本地 |
| **长期记忆** | khyos APK | **扩展**：把 `AmooMemory` 提升为 APK 本地记忆底座（同一份文件被云模型通道与 amoo 通道共用），不新建第二套 | 落盘失败被静默忽略（`AmooLoop.java:409-417`），退为进程内存态 |
| **工具调用面** | khyos APK | **扩展**：把 Java 侧 `ui_*`/`loop_*`/`amoo_*` 经 MethodChannel 暴露给 Dart；把两套白名单收敛。**注意**：`ToolEngine` 的 `PermissionLevel.ask` 无执行面（`tool_engine.dart:91-96`），`exec_shell_elevated`（`builtin_tools.dart:412-438`）不在 Dart 审批名单内（`chat_screen_new.dart:1509-1513`） | 无障碍未授权 → `KhyUi.java:47-51` 全工具返回中文指引，9 个 `ui_*`（`ui_dump`/`ui_tap`/`ui_click`/`ui_swipe`/`ui_longpress`/`ui_type`/`ui_back`/`ui_home`/`ui_recents`）+ 2 个截图工具（`shot`/`shot_b64`）全废（`Tools.java:112-113` 逐项数出）；Shizuku/sidecar 都不可用 → `Tools.java:534-572` 静默退回 app uid（`via=app`），`input`/`am`/`pm`/`dumpsys` 实际空转 |
| **读屏与点击** | khyos APK | **复用**：`KhyAccessibilityService` + `KhyUi` 是驱动 amoo 的唯一前提，也是不可被 amoo 替代的资产 | 无障碍被清 → 全部 `ui_*` 失败（`ReviveReceiver.java:44-73` 自陈只能发通知让人去点）；API<30 → 截图不可用；MediaProjection 每次进程重启要重新授权 |
| **悬浮窗与过程显示** | khyos APK | **扩展**：把 `AmooLoop` 步骤结构化（对齐 PC 的 `{id, ok, detail}`，最多 12）+ 把 Flutter 的 `ExecutionStep` 经反向通道推给浮层；两处都受零 IO 硬约束（`BridgeOverlayService.java:267-268`） | 无悬浮窗权限 → `:75-78` 直接 `stopSelf`，桥照常；进程被杀 → 不续跑（`AmooLoop.java:52-56`），步骤列表随之丢失（故意不持久化） |
| **计划与反思（多步任务）** | khyos APK | **扩展**：把规划-执行-反思收敛到 `chat_screen_new` 真实路径，并补「动作后验证」 | 无验证手段 → `AmooLoop.java:747-749` 返回「该工具没有可验证的手段，结果未经独立核对」，`:686-692` 标「未能验证」并写回，不冒充成功。Flutter 侧工具执行完只判 `success/failed`（`chat_screen_new.dart:296-300`），无副作用复核 |
| **技能包** | khyos APK | **不借鉴 roubao**：roubao `skills.json` 21 条的 `related_apps[].type ∈ {delegation, gui_automation}`（E11 侧实测），delegation 是「用 deep_link 打开另一个 AI 助手」——把任务甩给别的 app。**数据格式可参考，语义不可抄** | 无技能数据时模型自由发挥（`chat_screen_new.dart:169-170` 把技能摘要拼进 system prompt，空则无此约束），不报错 |
| **凭据** | khyos APK（两套，不共用） | **复用**：app 侧 `flutter_secure_storage` 单 key（`app_config.dart:137-169`）；桥令牌 32 hex（`BridgeToken` + `HttpBridge.java:104`）。**不照搬 roubao 的 EncryptedSharedPreferences**——本仓已有同级方案，换存储层是净损失 | 无「所有文件访问」→ 令牌写盘失败，`HttpBridge.java:89-102` 的心跳补写路径在授权补齐后自愈；存储不可用 → `app_config.dart:140-147` 回退空配置 |
| **共享契约** | 契约（待建） | **新建**：工具名集合 + 风险档 + 确认语义 + 步骤行形状 + 状态码。必须有单一定义，否则必然多份漂移（今天已是四份，E8–E10） | 契约文件不在 → 各端退回各自 local 常量；这正是漂移来源，因此契约应作构建期校验（缺则 CI 红），不是运行期可选 |

### 6.1 反重复实现规则：同一原子能力只允许一个持有者

| 原子能力 | 唯一持有者 | 反例（今天存在的第二份） | 处置 |
|---|---|---|---|
| 无障碍点击/输入/dump | 手机 `KhyAccessibilityService` + `KhyUi` | 无 | 保持。PC 侧 `amooDispatchRunner` 走 **adb `input`**，是不同手段，不是重复实现 |
| `exec` 三级提权 | 手机 `Tools.java:534-572` | Flutter 侧 `exec_shell` → `MainActivity.kt:563-572` 的**另一套** `SHELL_ALLOW`/`SHELL_DENY` | **重复且口径不同**：白名单只能有一份 |
| 危险命令判定 | 手机 `LoopModes`（按命令位匹配、能解 `sh -c`） | Flutter `_dangerousPatterns` 子串匹配（`chat_screen_new.dart:1484-1507`） | **重复且弱**：`echo rm -rf` 会被误拦，`env rm -rf` 会漏过。必须收敛到 `LoopModes` 语义 |
| 步骤行模型 | 契约（待建） | `amooPanelViewModel` 与 `AmooLoop.step()` 各一份 | 收敛后两端只做渲染 |
| 工具名集合 | 契约（待建） | 今天四份（§5.1.4） | **最高优先级** |
| amoo 包名/组件常量 | 契约（待建） | `AmooLoop.java:71-74`、`MainActivity.kt:1190-1194`、`amoo_service.dart:17-22`、bridge 侧 | 至少四份 |

### 6.2 与 roubao 的逐项对照（R4 的答复）

基线：`%TEMP%\roubao_up`，HEAD `c8a6d7f`（2026-01-08），MIT（`LICENSE:1`）。

| roubao 能力 | 本仓是否已有更优实现 | 证据 | 结论 |
|---|---|---|---|
| Shell 白名单 | **是** | roubao `ShellTool.kt:31` 定义 `ALLOWED_PREFIXES`，但 `:121` 那一行校验**被注释掉了**；本仓 `MainActivity.kt:563-572` 在 shizuku 与普通 shell 两条路都先过 allow/deny（`:682` 注释自述「enforce the same allow/deny rules」） | **不照搬** |
| 危险命令识别 | **是** | 本仓 `LoopModes` 按命令位匹配、能解 `sh -c`、能识 `env rm`；roubao 是子串黑名单 | **不照搬** |
| 无障碍能力 | **是** | 本仓 `KhyAccessibilityService` 每次现查节点（`:87-295`）；roubao 的 `main` 分支 manifest 未注册无障碍服务（E12） | **不照搬**，索引寻址的坑不要引进来 |
| 悬浮窗三按钮（停止/接管/确认） | **否** | roubao `OverlayService.kt:43-45` 有 `stopCallback`/`continueCallback`/`confirmCallback`，`:272-321` 三个分支；本仓 `BridgeOverlayService.java:225-241` 只有折叠/刷新/复制令牌/停止桥 | **借鉴形状**，但见 §九.7 第 3 条的前提（Q5） |
| 动作后验证 | **否** | roubao `MobileAgent.kt:408-443`：隐藏浮层 → 再截图 → `reflector` 判 A/B/C；本仓 `LoopVerify` 只有三种可机检手段（`:57-86`），读屏类动作仍 `NONE` | **借鉴思路**，成本要写清：roubao 一步至少 2 次 VLM |
| 失败重规划 | **否** | roubao `MobileAgent.kt:1098-1105` 连续 B/C 计数后置 `errorFlagPlan`；本仓 `LoopState` 的 `STALLED` 是**停机**不是重规划 | **借鉴思路**；本仓今天是把问题交回人 |
| 悬浮窗自身遮挡截图 | **否** | roubao 用 `setVisible(false)`（`OverlayService.kt:84`，调用点 `MobileAgent.kt:171-175`、`:408-411`）在截图前后隐藏；本仓 `BridgeOverlayService` 无隐藏/恢复逻辑 | **必须借鉴**——这是 bug 级缺口 |
| 敏感页刹车 | **否，且 roubao 是假的** | roubao 的 `STOP_SENSITIVE` 是**提示词判断**，模型不说就不停；本仓无任何本地敏感页判据 | **不照搬**；若要这条能力，判据必须落在本地 |
| 技能数据 | **否** | roubao `skills.json` 21 条，语义是「把任务甩给别的 app」 | **不照搬语义**；数据格式可参考，要补的是本仓自己的步骤型技能数据 |

**明确不照搬的原则**：roubao 的 `main` 分支没有测试目录（`dir /s /b test` 零输出），它的逻辑正确性零自动证据。把它当参考实现读，不当正确实现抄。例外是 roubao 的**当前版本本身仍在演进**（本轮只检出 `main`，未检分支）。

---

## 七、设计正文之一：模型通道 —— APK 如何使用 amoo 的模型

### 7.1 一句话结论

「APK 直接使用 amoo 中的模型」这句话，今天在这台手机的代码里只能落成一种形态：**把 amoo 聊天页当推理后端**（形态 b）。另外两条要么没有实现面（形态 a），要么本来就已经是另一件事（形态 c）。amoo 的模型配置、密钥、原生流式输出，khy-os 一个都拿不到——这不是待办，是第三方应用的物理边界。

推荐主路径是**形态 c（自带云模型直连）为主，形态 b（amoo 当后端）为可选旁路，形态 a 不做**。但必须先说清一个今天就能实测到的坏消息：主路径现在**开箱不可用**，因为七个内置密钥数组全空（E5）。

### 7.2 形态 a：amoo 暴露模型配置供读取 —— 不做，物理上做不到

判据是「khy-os 进程能不能读到 amoo 的模型名/baseUrl/key」。结论是**不能**：

1. amoo 是第三方包 `com.stepos.ailauncher`（`AmooLoop.java:71`、`amoo_service.dart:17`）。khy-os 的全部接触面是 UI 自动化（`ui_type`/`ui_tap`/`ui_dump`）与 Intent 分享（`amoo_service.dart:50-103`、`MainActivity.kt:890-980`）。
2. 全仓没有任何 `data/data/com.stepos.ailauncher`、`shared_prefs`、`getSharedPreferences` 命中；`MainActivity.kt:1190-1194` 只有四个 Intent 常量。
3. 即便去抓，Android 进程隔离也不允许——除非设备 root；而这条路径同时违反凭据纪律（§7.6）。

**代价**：没有实现代价，因为它没有实现面。把它写进需求等于写一条永远为假的断言。

### 7.3 形态 b：把 amoo 聊天页当推理后端 —— 已实现，但是分钟级单发旁路

| 事实 | 证据 |
|---|---|
| 异步启动，返回 job id，结果靠轮询 | `AmooLoop.ask` `:199-247`；`Tools.amooAsk` `:331-345` |
| 结果面 | `AmooLoop.askResult` `:305-321`，`state` 取 `running/done/failed`，`done` 时才有 `reply`；Javadoc `:301-303` 明说 reply 是「最新气泡原文，未解析、未摘要、未信任」 |
| 同时只能一个 | `if (askRunning) return null;`（`:200-202`） |
| 必须 amoo 在前台 | 前台包名不等于 `AMOO_PKG` 就置 `amoo_not_foreground` 并拒绝（`:212-217`） |
| 单轮约 6 分钟 | `Tools.java:325-330`「Amoo 在本机一想就是约 6 分钟」、`AmooLoop.java:46-50`「measured ~6 min/turn」 |
| 完成判据是「两次采样相同」 | `:357-371`，`stable >= 2` 才 `ASK_DONE`；中途恰停在同一片段会被提前判完 |
| 输入框资源 id 硬编码 | `ID_CHAT_LIST/ID_INPUT/ID_SEND`（`:72-74`），注释承认输入框随软键盘上移约 1300px（`:68-70`） |
| 依赖无障碍 | 读屏与写回全走 `KhyUi`，未授权时 `KhyUi.dispatch` 整体返回中文指引（`KhyUi.java:44-51`） |

暴露面只有本机 HTTP 桥：`HttpBridge` 的 `/call` 直接把工具名转给 `Tools.dispatch`（`:384-391`），绑定 `127.0.0.1`（`:302`）。**Flutter 侧调不到它**：`lib/` 下 `amoo_ask`/`amoo_result`/`loop_start` 零命中，`MainActivity.kt:56-160` 的 MethodChannel 处理器里也没有这三个方法。

**代价必须写清**：这条通道的每一次调用都是**一轮真实的 amoo 对话**，分钟级、单发、无流式、受 amoo 自己的配额与上下文约束，且 amoo 改版（改资源 id）即整体失效。把它当主模型 = 把主路径押在第三方 UI 不变上。

### 7.4 形态 c：用户在 khy-os 侧自行配置同一供应商 —— 今天唯一健康的主路径骨架

数据面已经齐：`AppConfig.save` 写 `baseUrl/apiKey/model/vision*`（`app_config.dart:150-169`），设置页有 Base URL / API Key / Model 三个输入框与「保存配置」「测试连接」（`settings_screen_new.dart:254-289`）。

它不依赖 amoo 的任何东西——这里的「同一供应商」与 amoo 用哪家完全无关，只是用户自己在 khy-os 里填一次。

缺口只有一个（但是硬缺口）：**开箱没有 key**（E5）。填了用户自己的 key 就能用；不填就停在 `chat_screen_new.dart:118-121` 的报错上——这是**正确**行为，不能改成静默降级。

### 7.5 推荐：c 为主、b 为补充、a 不做

```
独立模式（默认）
  └─ cfg.isConfigured ? 直连 /chat/completions（chat_screen_new.dart:193）
                       : 报「API 未配置」并引导去设置页（:118-121）
远程模式（可切换）
  └─ _api.isConnected ? khyos_api.streamChat（:407-436）
                       : 模式芯片置灰不可点（:609）
旁路（手动触发，非默认）
  └─ amoo 当后端：PC 经 8896 调 amoo_ask / amoo_result
```

切换条件：

| 从 | 到 | 触发条件 |
|---|---|---|
| 独立·直连 | 独立·备用 provider | 仅 429 且连续 2 次：`_handleDioErr`（`:1295-1311`）达标后调 `_autoFailover`（`:1401-1438`） |
| 独立·直连 | 远程 | 用户手点模式芯片且 `_api.isConnected`（`:609`）；没有自动切换 |
| 任意 | amoo 旁路 | **只能手动**。Dart 侧没有入口，必须由 PC 经桥调 `amoo_ask`。这是现状，也应保持 |

自动 failover 的现状要如实说：它只在 429 且 `_consecutive429 >= 2` 时才动（`:1305`），挑的是「有 key 且没试过」的 provider（`:1413-1419`）——在空 key 现状下这个 `firstWhere` 必然落到 `orElse` 的空 provider（`:1417-1418`），然后走「所有 provider 均不可用」提示（`:1421-1426`）。**今天的自动 failover 实际上是一条死路**。

**关于「把 amoo 当聊天后端」是否要做成产品能力**：建议不做成 App 内可发起的路径，只保留 PC 侧工具面的手动调用。理由不是实现难度，是三条当下就成立的约束：分钟级单轮、只能单发、必须在前台。任何一条都足以否掉「像用模型一样用 amoo」这个心智模型。

若人坚持要开，必须先补三件今天不存在的东西（**待建**）：

1. Flutter→原生的 `amoo_ask` 通道（`MainActivity.kt:56-160` 现无此方法）；
2. 排队语义（现在第二个请求直接被 `return null` 拒绝，`:200-202`）；
3. 过程显示（现在只有一个 `volatile String progress`，`AmooLoop.java:146-148`）。

### 7.6 凭据边界

1. **不得从 amoo 的数据目录抓密钥**。今天代码里没有这么做，也不要加。理由不只是许可：`data/data/com.stepos.ailauncher` 在非 root 设备上读不到，写了也是死代码。
2. **不得把 `built_in_keys.dart` 的回填结果提交进仓**。文件头 `:1-9` 明说「paste the output over the empty arrays WITHOUT committing it」，消毒记录在 `:29-62`。回填脚本是 `scripts/gen_keys.py`，检查脚本是 `scripts/check_builtin_keys.py`——两者本轮**未读**，只在本文件注释里看到它们被点名。
3. **不得为了「共享」去复制 amoo 的凭据**。用户若想让两边用同一家，正确动作是自己在 khy-os 设置页填一次（`settings_screen_new.dart:258`）。
4. **存储与展示**：`flutter_secure_storage` 单 key `app_config`（`app_config.dart:137-138`）；`maskedEffectiveKey` 只露前 8 后 4（`:49-60`）；浮层令牌只露前 4 后 4（`BridgeOverlayService.java:269-273`）。桥令牌是另一套，落 `/sdcard/bridge-amoobridge/token.txt`（`HttpBridge.java:104`），两者**不共用**。
5. **用户显式共享的正确形态**：想让 amoo「知道自己配了哪个模型」，唯一合规动作是往对话里写一段文字（`KhyUi.type` 或 `amoo_service.shareText`）。「已交给 amoo」≠「已送达」（`amoo_service.dart:182-187`）。**不要**把这种「告诉它」包装成「共享配置」。

### 7.7 与 PC 侧 aiGateway 的关系

- **手机单独可用时**走手机自己的直连，不经过 PC。
- **多端在线时**手机按 `_mode` 自己决定（`chat_screen_new.dart:50`、`:79`、`:607-641`），PC 完全不知道手机在用哪个模型。PC 的 `aiGateway` 是一条按优先级排的适配器级联，与手机 provider 表**没有任何共享数据**。
- **两份路由规则的实际分叉点**（这正是「避免分叉」今天做不到的地方）：

| 问题 | 实况 |
|---|---|
| 手机要连的远程端点存在吗 | 代码打 `/api/ai/chat/stream`（`khyos_api.dart:201`）与 `/api/ai/models`（`:176`）。backend `server.js:586` 挂的是 `createAiProxy`（透明转发），不是同名 router |
| 转发目标会应答吗 | 转发目标是 ai-backend；ai-backend 的 `/api/ai` 只有 `POST /chat`（`runtime/node/ai-backend/src/routes/ai.js:34`），**没有 `/chat/stream`，也没有 `/models`**。所以 `streamChat` 打过去大概率 404（未实测） |
| 手机有没有入口配后端 | `verifyAndSave` 只在 `connection_screen.dart` 被调用，而 `ConnectionScreen` 只在旧设置页可达，旧设置页不可达 |

**结论：远程模式今天事实上不可用**，而且不是一个 bug 能修的——是端点契约对不上 + 入口不可达。要给手机一条「走 PC 模型额度」的路，必须先在 PC 侧**建**一个对手机友好的端点（OpenAI 兼容的 models 列表 + SSE chat），并让手机有可达的设置入口。**两件都是待建**。

### 7.8 避免两份规则分叉的办法

不在手机里复制 PC 的优先级/冷却/健康评分逻辑：

1. 手机的 provider 表只保留「用户选了哪个」，不实现自动择优（`_autoFailover` 是唯一例外，且只在 429 时保守触发）。
2. 若将来接 PC，PC 返回什么模型手机就用什么模型，`ModelRegistry` 的静态清单退化为「离线兜底」，不并列真源。
3. 同一份「provider 名 → baseUrl」的真源只能有一个。

---

## 八、设计正文之二：悬浮窗与过程步骤显示

### 8.1 与提法冲突的现状：悬浮窗在「桥」的生命周期里，不在「一次任务」的生命周期里

`BridgeOverlayService` 由 `BridgeService.onCreate` 拉起（`BridgeService.java:44`），随 `stopBridge()` 撤掉（`:64-70`）。也就是说：只要桥在跑，浮层就在；桥不跑（用户没开桥、或 App 只用独立模式聊天），**一次 agent 任务的全过程在屏幕上没有任何表示**。

这是本节所有设计的前提：要做「任何应用里都能看到 agent 正在做什么」，第一件事不是加步骤列表，是把浮层的**生命周期**从「桥」改成「桥 或 任一执行器在跑」。

### 8.2 今天的 BridgeOverlayService 能显示什么、挂在哪里、没权限怎么退化

#### 8.2.1 两层结构，全部代码建 View（无 res 资源）

| 部件 | 位置 | 实测行为 |
|---|---|---|
| 气泡 44dp | `:132-141` | 文字写死「桥」（`:134`），初始 `dp(8), dp(220)`（`:141`） |
| 拖拽 + 吸边 | `:146-173` / `:176-180` | `ACTION_UP` 时若位移 ≤6dp 视为点击展开面板（`:160`、`:166`），否则吸左边或右边（`:178`）；**y 不动** |
| 面板 | `:198-248` | 264dp 宽、初始 `dp(8), dp(120)`（`:245`），内容 = 一个 `statusText` + 四个按钮（`:225-241`） |
| 刷新节拍 | `:47-52` | `handler.postDelayed(this, 2000)`，2 秒一次 |

面板按输出顺序逐行：

1. `状态：在线/离线` ← `HttpBridge.healthy()`（`:276`；定义 `:58` `running && port > 0`）
2. `进行中：<AmooLoop.progress() 截 60 字>` 或 `进行中：循环运行中`（`:279-285`）
3. `端口：` ← `HttpBridge.port()`（`:286`）
4. `令牌：` 掩码（`:269-273`、`:287`）
5. `UI 能力：无障碍已开 / 无障碍未开（点此恢复）`（`:291`）
6. `提权：sidecar / Shizuku / 未提权`（`:295-305`）
7. `工具：39 个` ← `Tools.NAMES.length`（`:306`）

**硬约束（不能破坏）**：这条刷新路径被注释写死为**零文件 IO**（`:267-268`），且 `copyToken` 也刻意用 `currentToken()` 而非 `ensureToken()`，理由同样写在注释里（`:329-334`）。任何「步骤列表从磁盘读」的改法都会重新引入存储 IO 卡死。

#### 8.2.2 无 SYSTEM_ALERT_WINDOW 时的退化（已实现，不是待建）

- `onCreate` 先查 `Settings.canDrawOverlays`，没有就 `running = false; stopSelf()`（`:75-78`，权限判定 `:103-106`）。
- **桥照常工作**：`BridgeOverlayService.start()` 被 `try{...}catch(Throwable ignored){}` 包住（`:58-63`）。
- App 侧看得见：`bridgeStatus` 回 `overlayRunning` / `overlayGranted`，设置页据此显示并给「去授权」。
- **这一层今天是完整的**，缺的不是权限降级，而是「浮层存在时能显示的内容太少」。

#### 8.2.3 今天**做不到**的五件事

| 缺什么 | 证据 |
|---|---|
| 没有「第 n/m 步」 | `AmooLoop.step()` 只把整句字符串赋给一个 `volatile String`（`:101`、`:146-148`），无列表、无计数、无开始时间 |
| 没有耗时 | `refreshPanel` 全文无时钟读取（grep `currentTimeMillis`/`elapsed`/`duration` 均零命中） |
| 不能停当前任务 | 四个按钮是折叠/刷新/复制令牌/停止桥（`:225-241`），没有 `AmooLoop.stop()` 的入口；`loop_stop` 只经 `Tools.dispatch` 暴露（`Tools.java:231-234`） |
| Flutter 的步骤进不了浮层 | 浮层是 Android Service 自绘 View；`MainActivity` 只有一个正向 MethodChannel（`:56`），**无 EventChannel、无 BasicMessageChannel**，也没有任何 native→Dart 的 `invokeMethod` |
| 浮层会污染自己的读屏 | `KhyUi.dump` 走 `rootInActiveWindow`（`KhyUi.java:75-88`），而 `BridgeOverlayService` 全文没有 `setVisibility(` / `INVISIBLE` / `GONE`。roubao 在截屏前后显式隐藏（`OverlayService.kt:84`，调用点 `MobileAgent.kt:171-175`），本仓没有这一步 |

### 8.3 步骤数据从哪来：三个可采集点，一个统一事件

#### 8.3.1 采集点 A — Flutter 侧真实执行路径

真实入口是 `ChatScreenNew._sendWithAgentLoop`，**不是** `AgentLoop`。`lib/` 下 `AgentLoop` 只命中 `agent_loop.dart` 自身与 `chat_screen_new.dart` 里的私有方法名 `_sendWithAgentLoop`（`:148`、`:152`）；`AgentLoop` 类本身无任何调用者。

可采集的时刻（全部在 `chat_screen_new.dart`）：

| 时刻 | 行 | 现有数据 |
|---|---|---|
| 轮次开始 | `:182-184` | `loop`(0..4)、`_currentAction` 设成「分析请求 / 继续执行 (n/4)」 |
| 步骤登记 | `:261-263` | `execLog.addStep(toolName,args)` 返回下标，`step.start()` 记开始时间 |
| 动作开始 | `:274` | `_currentAction = label`，`label` 来自 `_getToolLabel`（`:1582-1621`，已是「动词: 目标」形态） |
| 等待用户 | `:279-289` | `_needsApproval` 为真 → 弹 `_showApprovalDialog`（`:1516-1568`）；拒绝时写 `ToolResult.fail('用户拒绝了该操作')`（`:282`） |
| 结束 | `:296-299`、`:293` | `step.complete/fail` + `elapsed` 毫秒 |
| 整体收尾 | `:345-347`、`:363-367` | `execLog.finish('达到最大步骤数')`；`finally` 清 `_busy` / `_currentAction` |

今天这些数据只到 `ToolCardData` 与 `ExecutionStep`（`execution_log.dart:7-79`）为止，且只在聊天页最后一条助手消息下面显示。

#### 8.3.2 采集点 B — 原生 `Tools.dispatch` 的横切点

`Tools.dispatch(String tool, JSONObject a)`（`Tools.java:116`）是原生侧 39 个工具的唯一入口。它今天**没有任何进/出埋点**。

可插入的事件点（**待建**，逻辑改动极小）：
- 入口：`(tool, a)` 已足够拼「动作 + 目标」——`exec` 取 `a.optString("cmd")`（`:150`），文件类取 `path`（`:154-178`），`ui_*` 取 `KhyUi` 内部参数。
- 出口：`:244` 与 `:245-251` 是仅有的两个返回点，加一行事件发射不会改变返回语义。
- **必须带 `via` 字段**：`exec` 的三级降级是静默的（`sidecar → shizuku → app`，`:534-572`；返回值带 `via`），注释本身写明「`via` 必须被展示出来才能知道实际权限级别」（`:533-536`）。步骤行不带这个字段，等于把「app uid 空转」显示成「命令成功」。

#### 8.3.3 采集点 C — amoo 驱动循环（原生，已有最细的步骤语义）

`AmooLoop` 今天有 21 处 `step("...")`（本轮逐行匹配得出，行号即当前工作区代码）：

`329` `357` `369` `380`（反代四态）、`467`（循环启动）、`496`（注入记忆）、`517`（读屏中·第 n 轮）、`523`（读屏失败）、`535`（截断）、`549`（等围栏闭合）、`623`（停机等人确认）、`634`（本轮 N 条已处理）、`667`（执行 i/total）、`672`（验证 i/total）、`681`/`688`/`694`（写回 已验证/未验证/失败）、`845`/`850`（写回输入框）、`240`/`512`（清空）。

其中**已经天然是三维的**：`667` = 「执行」(动作) + `parse.tool`(目标) + `i/total`(进度)；`681`/`688`/`694` 三态还区分了「已验证 / 未验证 / 失败」——这个区分是产品级语义，**不能压成 success/failed 两态**（`AmooLoop.java:676-693`）。

可用的**旁路数据**（不改 `step()` 也能拿到）：`st.round` / `st.elapsedMs`（每轮刷新，`:508`）、`LoopState.shouldStop` 纯函数（`:115-147`）、停机原因码 `DONE_SIGNAL/MAX_ROUNDS/DEADLINE/STALLED/ABORTED/STATE_LOST`（`LoopState.java:40-55`）与中文映射单一真源 `describeStop`（`AmooLoop.java:1037-1054`）、`isRunning()`（`:111-113`）、`askRunning()`（`:294-296`）。

#### 8.3.4 统一「步骤事件」结构（**待建**）

设计目标：一份结构，三处采集都能填，手机浮层与 PC 面板都能渲染，且**天然满足 `RUNTIME-002` 的三维判据**。

```
StepEvent {
  seq      : int      // 单调递增，本任务内从 1 开始
  state    : running | waiting_user | ok | failed | unverified | aborted
  action   : string   // 动作：执行 / 验证 / 写回 / 读屏 / 注入记忆 / 分析请求
  target   : string   // 目标：工具名 + 关键参数（file path / command 前 40 字 / 应用名）
  progress : { done:int, total:int|null }   // 进度：i/total 或 第 n 轮
  detail   : string|null  // <= 120 字，失败原因放这里
  startedAt: long     // 用于耗时显示；为 0 表示未开始
  endedAt  : long|null
  via      : string|null  // 原生 exec 的 sidecar/shizuku/app；其他为 null
}
```

四条设计约束：

1. **action + target 分离**，因为今天两者已分别存在于原生与 Dart 两侧，只是没合并：原生 `step("执行 " + i + "/" + total + "：" + tool)`（`:667`）把三维塞进一句；Dart `_getToolLabel` 已是 `动词: 目标`。用这个结构两侧都能无损映射，不必造第三种文案。
2. **`unverified` 必须是独立状态**，不是 `failed` 的子类。依据 `AmooLoop.java:686-693`。
3. **`waiting_user` 是一等状态**，因为「等人确认」在三条路径里都是**停机**：原生路径 `LoopModes.decide` 返回非 EXECUTE 即写 pending 文件 + 通知 + 停产（`AmooLoop.java:661-665`、`:58-62`），Dart 路径弹模态框。两者都要在浮层上显示「等你确认」而不是「正在跑」。
4. **`detail` 上限 120 字**，与 PC 侧 `MAX_DETAIL_CHARS = 120`（`amooPanelViewModel.js:40`）取同一数，避免两端截断口径不同。

**`RUNTIME-002` 对齐**：每条事件渲染出来至少包含「动作 + 目标」，有 `progress.total` 时再拼 `i/total`。注意守卫的实际覆盖面——`scripts/ci/check-agent-rules.js` 的 `GENERIC_STATUS_TOKENS` 只对 `.js/.ts/.tsx/.vue/.py/.json/.yaml/.ps1/.sh/.bat/.cmd` 生效，**不扫 `.java/.kt/.dart`**。所以 `AmooLoop.java:523` 的「读屏失败，重试中」这类文案不受自动检查管，只能靠人工评审。这一节的结构是对齐手段，不是「跑一遍守卫就绿」。

### 8.4 三态显示

#### 8.4.1 运行中：`第 n/m 步 · 动作 目标 · 12s`

- **n/m 从哪来**：Dart 侧 `for (loop<5)`（`:182`）+ 当前轮内工具数；原生侧 `index/total`（`AmooLoop.java:667`）。两者都是**已知总数**；跨轮总数未知时 `total = null`，显示成 `第 n 步`（不要编一个 m）。
- **耗时**：`ExecutionStep.startTime` + `durationMs` 已有（`execution_log.dart:14`、`:49-50`）；原生侧需按 `StepEvent.startedAt` 现算（今天没有）。
- **刷新节拍**：浮层已有 2s 节拍（`:50`），够用；步骤事件应是**推**进来的内存变量，浮层 2s 拉一次——与今天 `AmooLoop.progress()` 的读法一致（`:279`），保持零 IO。
- **一句可直接套用的渲染**：`执行 2/3：write /sdcard/game/main.py · 4s`。同时命中 `\d+/\d+` 与动作/目标/进度三维。

#### 8.4.2 等待用户：三种成因必须分开显示

| 成因 | 今天的行为 | 浮层应显示 |
|---|---|---|
| 危险命令确认 | Dart 弹模态框（`:1516-1568`） | `等你确认：执行命令 rm -rf …` + 两个按钮（批准/拒绝） |
| 原生安全底/模式不许 | `LoopModes.decide` 非 EXECUTE → 写 `/sdcard/bridge-amoobridge/amoo_pending.json` + 通知 + 停（`AmooLoop.java:661-665`） | `等你确认：<工具> 未执行，原因 …` + 「打开清单」。**不要显示「继续」**——今天没有续跑路径，写了就是撒谎 |
| 权限缺失 | 无障碍未授权 → 全部 UI 工具直接失败（`KhyUi.java:44-51`）；悬浮窗未授权 → 浮层根本不画（`:75-78`） | 无障碍：浮层自己在 `:291` 已写「点此恢复」并绑了跳转（`:309-326`）。悬浮窗未授权时**没有浮层可显示**，只能靠 App 内设置页 + 桥通知 |

**这一格有一个今天必须直说的产品缺口**：`LoopModes.defaultMode()` 返回 `BYPASS`（`:163-165`），而手机 App 内既无确认 UI、也无法发起 `loop_start`。所以「等你确认」这一态**今天只可能出现在 Dart 的工具审批上**，不会出现在 amoo 循环上——因为那条循环手机端起不动。

#### 8.4.3 结束：成功 / 失败 / 中断，失败可点开看原因

现有可用的结局枚举（别新造一套）：

- Dart：`ExecState { queued, running, success, failed, timeout }`（`execution_log.dart:4`），`ExecutionStep.summary` 已给「成功 (123ms)」「失败 (123ms): <error>」（`:53-66`）。
- 原生 amoo：`describeStop` 六因（`AmooLoop.java:1037-1054`）。
- 原生 amoo 的「不可验证」：`LoopVerify.Kind.NONE`（`:21`）→ 结果标「未能验证」（`AmooLoop.java:686-693`）。**这一态在浮层上必须可见**，否则与「成功」无法区分。

「点开看原因」需要的展开能力，今天只有**折叠整个面板**（`:189-196`、`:225-227`）；没有「单条步骤展开」。这是要新做的交互，但数据源已经够：`ExecutionStep.error`（`:13`）与 `output`（`:12`）都在。

### 8.5 跨应用常驻、不抢焦点、不遮输入法、可拖拽吸边、一键停止、点开展开

#### 8.5.1 已经做到的

| 要求 | 实现 | 行 |
|---|---|---|
| 跨应用常驻 | `TYPE_APPLICATION_OVERLAY`（API 26+）/ `TYPE_PHONE`（旧） | `:108-113` |
| 不抢焦点 | `FLAG_NOT_FOCUSABLE` | `:118` |
| 不拦别处触摸 | `FLAG_NOT_TOUCH_MODAL` | `:119` |
| 可拖拽 | `ACTION_MOVE` 直接改 `lp.x/y` 并 `updateViewLayout` | `:157-164` |
| 吸边 | `snapToEdge` 只改 x | `:176-180` |
| 点开/收起 | 点气泡 `togglePanel` | `:166`、`:198-248` |

#### 8.5.2 还缺的，以及为什么不能「顺手加」

1. **不遮挡输入法**：`FLAG_NOT_FOCUSABLE` 只保证不抢焦点，**不保证不被 IME 顶起或压住输入框**。今天用 `FLAG_LAYOUT_NO_LIMITS`（`:120`），窗口可越出屏幕边界，配合 `Gravity.TOP|START` 固定 y（`:122-124`），软键盘弹出时不会自动让位。`ALT_FOCUSABLE_IM` / `SOFT_INPUT` / `setSoftInputMode` / `LAYOUT_IN_SCREEN` 全部零命中。
2. **一键停止当前任务**：必须新增。可调的两个已有入口：`AmooLoop.stop()`（`:471-477`，语义是「跑完当前命令再退」）与 `AmooLoop.stopAsk()`（`:323-326`，语义是「已发出的 prompt 收不回」）。Dart 侧执行中的工具**没有取消通道**：`ToolEngine.execute` 无 `CancelToken`/取消钩（`tool_engine.dart:105-138`），`_sendWithAgentLoop` 也没有置位中断标志。所以「停止」在 Dart 任务上今天**只能做到「停止后不再发下一步」**，不能掐断正在跑的 `dio.post`（无 cancelToken）。**必须如实呈现这个限制，不能做成看起来能停**。
3. **展开完整步骤列表**：今天面板是固定 264dp 宽 + `WRAP_CONTENT` 高（`:245`），没有 `ScrollView`。步骤超过约 6 行就会顶到屏幕外。要展开就得引 `ScrollView` 或在浮层内分页——`RUNTIME-004` 禁的是**终端**滚动区，Android 的 `ScrollView` 不在其管辖内，但**浮层高度必须自己限死**。
4. **浮层自隐藏**（读屏/截图时）：roubao 的做法是 `setVisible(false/true)`（`OverlayService.kt:84`，调用点 `MobileAgent.kt:171-175`、`:408-411`）。本仓没有。加它的收益是「`ui_dump` 不会读到自己」——不过 `KhyUi.dump` 走 `rootInActiveWindow`，浮层是独立 window，是否出现在树里取决于 ROM。**这一点未真机验证，不写成结论**；设计上按「可能出现」处理，即读屏前后各隐藏一次。

### 8.6 与 PC 侧显示语义对齐

> 先纠正一个提法：仓里没有 `CcAmooPanel`。全仓（排除 `node_modules`）`CcAmoo` 零命中。PC 侧真实的名字是：

| 层 | 文件 | 作用 |
|---|---|---|
| 纯叶子（行模型） | `amooPanelViewModel.js` | `buildAmooPanelModel`（`:385`），固定 7 行 `ROW_KEYS`（`:26`）、`MAX_STEPS = 12`（`:42`）、`MAX_DETAIL_CHARS = 120`（`:40`） |
| 供数器 | `amooStatusProvider.js` | `noteStep / notePoll / noteDispatchResult`（`:249-298`），`_progress.steps` 上限 `MAX_PROGRESS_STEPS = 24`（`:44`） |
| TUI 渲染 | `CcPhoneLinkPanel.js` | `_pushDispatchSection`（`:157-184`），步骤行渲染成 `<icon> id  detail`（`:177-182`） |
| 桌面面板 | `AmoonPane.tsx` | 挂载但**不消费行模型**（grep `steps`/`progress`/`badges` 全部零命中）；只读 inbox（`:53-56` 的 `unverified: true` 类型钉死）、15s 轮询（`:172`） |

#### 8.6.1 两端已有的共同词表（应作为单一真源）

**步骤行形状** `{id, ok, detail}`，三处已一致：

- 生产端：`amooDispatchRunner.dispatchTask` 的 `onStep({id, ok, detail})`（`:326`、`:376-381`），id 取值例：`ensure-device` / `ensure-forward` / `bridge-ping` / `launch-amoo` / `focus-input` / `fill-text` / `verify-input` / `tap-send` / `poll-reply`（`:384-451`）。
- 存储端：`noteStep` 原样入队并按 `MAX_PROGRESS_STEPS` 踢队首（`:249-266`）。
- 渲染端：`_capSteps` 取最后 12 条并 `{id, ok, detail}` 收窄（`:362-369`）；TUI 逐条渲染（`:177-182`）。

**状态词**：`tones = ok | warn | error | idle | busy`（`amooPanelViewModel.js:36`）。

#### 8.6.2 对齐方案（**待建**，形状已由两端逼出）

把 `{id, ok, detail}` 扩成 §8.3.4 的 `StepEvent` 的超集是可行的：

- `id` ↔ `action + target`（PC 侧 id 本身就是「动作段名」）；
- `ok:boolean` ↔ `state ∈ {ok, failed}`；扩出 `waiting_user / unverified / running` 三值；
- PC 侧缺 `progress`（done/total）：`_progressRows` 只有 `steps.length` 步数和 `第 round/maxRounds 轮`（`:345-360`）——这是 **PC 侧也要加**的字段，不是只改手机。

**唯一允许的两端差异**：渲染形状。PC 是固定 7 行 + 详情段，手机是 264dp 面板。**这属于「渲染不共享」，不是「词表分家」**。验收标准一句话：拿一份 `StepEvent` 数组，两端都能不查表地渲染出可读行。

**已存在的漂移（本轮发现）**：手机 `describeStop` 六因（`AmooLoop.java:1037-1054`）与 PC `STOP_REASON_TEXT` 三键（`amooDispatchPlan.js:259-271`：`screen_unreadable` / `round_cap_reached` / `deadline_reached`）**没有交集**。`LoopState.java:15-17` 的注释还自述 nextPollDelay 与 PC「语义一致」，但停机原因这一层没有对应声明。共用一份文案映射是必须的下一步。

### 8.7 三种降级

#### 8.7.1 权限被拒

| 权限 | 拒了以后今天发生什么 | 证据 |
|---|---|---|
| 悬浮窗 | 浮层不画、`stopSelf`；桥照常 | `:75-78`、`:58-63` |
| 无障碍 | 9 个 `ui_*` + 2 个 `shot*`（合计 11 个）全部立即失败，返回中文指引 | `KhyUi.java:44-51`；`Tools.java:112-113` |
| 所有文件访问 | 令牌写盘失败，令牌只剩内存，PC 每个请求 401 | `HttpBridge.java:89-102` 注释自述 |

**降级要求**：三种都不能让 App 主流程报错退出。今天已满足。**要做的是**：把「无障碍被清」这条从「工具报错」提升为**浮层常驻提示**——今天已有（`:288-291` 注释解释为什么选浮层而非通知），但只显示一行字，没有把「因为无障碍没了，所以这次任务不会成功」说清楚。

#### 8.7.2 后台被杀

- `AmooLoop` **不跨进程重启**，源码自述「`armed` 只在内存，重启后没有任何东西重新 arm 它；续跑会重复执行云端以为已经跑过的命令」（`:52-56`）。
- 反代 `ask` 的状态也是纯内存（`:168-172`），`askResult()` 只读内存对象（`:305-321`）。
- 浮层没有「恢复上次任务」的任何持久化。
- 桥本身有 `START_STICKY` + 10s 心跳（`BridgeService.java:61`、`:112-146`），所以**桥会回来，任务不会**。

**降级要求**：进程重建后浮层要显示「上一轮任务已中断（原因未知）」，而不是清空成「空闲」。数据只能落在**内存之外的一处轻量位置**（最快的是 `SharedPreferences` 一条 JSON，容量几百字节），**不能**是 `/sdcard`（那里的 IO 是被显式禁的）。这条与「AmooLoop 不续跑」并不冲突：记录**结局**不等于**恢复执行**。

#### 8.7.3 无障碍未授权（与 8.7.1 不是同一件事）

- 判据唯一可靠来源是 secure 设置本身，而非实例存活：`ReviveReceiver.isAccessibilityEnabled`（`:54-73`），注释明确写「force-stop 后实例必然为 null，但设置被清才是根因」（`:44-52`）。
- 恢复只能靠人点：写 secure settings 需系统签名。
- **浮层比通知更可靠**（通知要 POST_NOTIFICATIONS，用户可能没授）——这条判断写在 `BridgeOverlayService.java:288-290`，是有意为之。
- 但注意：**无障碍没开时，amoo 那整条路是瘫痪的**——`ui_type`/`ui_dump`/`ui_tap` 全废，`writeBack` 第一步就失败。所以无障碍未授权时，浮层不应显示「正在读屏」，应显示「已停机：无障碍未开启」。今天 `progress` 会停在最后一句（`:146-148` 只赋值不清理），这就是**会撒谎的表现形式**。

### 8.8 落地顺序（按「不改就白做」排序）

1. **浮层生命周期解绑桥**（`BridgeService.java:44`/`:67`）——否则独立模式聊天时屏幕上什么都没有。
2. **`StepEvent` 内存队列 + 浮层读队列**（新增一个持有队列的静态类，浮层在 `refreshPanel` 内读，遵守零 IO 约束）。
3. **Dart → 原生推步骤**：新增一个反向通道。今天 `MainActivity` 只有正向 MethodChannel，EventChannel 为 0；最小改动是再加一个同名 channel 的 `invokeMethodFromNative`，或新增 `BasicMessageChannel`。**待建，依赖第 1、2 步。**
4. **`Tools.dispatch` 进出埋点 + `via` 透传**（`Tools.java:116`、`:534-572`）。
5. **一键停止**：先接 `AmooLoop.stop()`/`stopAsk()`（已存在），Dart 侧如实标「本步无法中断」。
6. **浮层读屏自隐藏**（对齐 `OverlayService.kt:84`）。
7. **两端词表合一**（把 `describeStop` 与 `STOP_REASON_TEXT` 收敛）。

---

## 九、设计正文之三：职责边界与协作契约

### 9.1 协作协议：能力握手

| 层 | 今天已有什么 | 缺什么 |
|---|---|---|
| 手机→PC | `status.json` 带 `running/pid/http_port/mode/ui/canWrite/token_persisted/pc_reachable/pc_idle_ms/ver/tools[]`（`BridgeService.java:148-173`），每 2s 写一次 | 无 amoo 侧能力字段（装没装、前台没前台） |
| PC→手机 | `HttpBridge` 的 `/ping` 只回 `pong/pid`（`:376-378`），`/status` 回 `up/port/mode/ui/tools` 计数（`:379-383`） | 无版本协商、无能力矩阵 |
| 手机→amoo | `amooStatus` 用 `resolveActivity` 判 `installed/canShare/canOpenChat/versionName`（`MainActivity.kt:847-883`），并显式区分「检测失败」与「未安装」（`amoo_service.dart:129-164`） | 「已解析到分享入口」≠「能启动」（`:159-162` 自己写了「启动未验证」） |
| amoo→手机 | **无**。amoo 是第三方，没有任何握手入口 | — |
| bridge↔PC | `contracts.js:27-28` 的 `PROTOCOL='khy-amoon/1'`、`BRIDGE_VERSION='0.1.0'`，经 `bridge_status` 暴露 | 这是**另一条栈**，与 8896 不共用凭据 |

**结论**：能力握手在三对里有两对是空的（amoo→手机 完全空，PC→手机 只有端口号），且存在**四套互不共用的凭据**：8896 的 `token.txt`（`BridgeToken`/`HttpBridge.java:104`）、A2A 的 `KHY_A2A_API_KEY`（`a2a.js:54-61`，未配置即放行）、bridge 的 `operator.token`+`tokens.json`、以及 amoo 侧无凭据。契约必须把「谁用哪套凭据」也纳进来。

### 9.2 任务委派：谁发起、谁执行、谁回报

今天有**三条真实在跑的委派路径**，一条都不经过 A2A：

1. **PC→手机工具**：`amooBridgeClient`（Bearer）→ `HttpBridge` `/call`（`:384-391`）→ `Tools.dispatch`。回报是同一个 HTTP 响应体。
2. **PC→amoo 界面**：`amooDispatchRunner.dispatchTask` 的固定十步，每步 `onStep({id, ok, detail})`。**回报是「答复抽到了」还是「没抽到」**，`poll-reply` 的 `stopReason` 由 `describeStopReason` 翻成中文——单一真源。
3. **amoo→手机执行**：`AmooLoop.runLoop`，amoo 在文本里下命令，手机执行完 `writeBack` 回写。**回报 = 往 amoo 输入框写一段中文**，没有任何机器可读回执。

A2A（`routes/a2a.js`）是**第四条**，今天不可用：它建任务、能查、能撤，但 executor 是回声（`serverMethods.js:42-57`）。要把它变成「手机调 PC 模型」的真路径，必须先有一次 `createServerMethods({ executor })` 注入——**待建**。

### 9.3 状态回报的幂等与超时

| 机制 | 位置 | 语义 | 可用性 |
|---|---|---|---|
| HTTP 幂等 | bridge `idempotency.js` | `id` + args 摘要，同 id 同摘要回放、同 id 异摘要 409 | 可用（E2 覆盖） |
| 信箱幂等 | bridge `mailbox.js` | `res_<id>.json` 已存在就不重跑 | 可用（E2 覆盖） |
| 手机侧去重 | `AmooLoop.java:556-569` 按气泡 hashCode 记已处理；`:199-202` 的 `askRunning` | 单发；重放不会重复执行 | 可用 |
| 超时-手机 | `HttpBridge.java:344` 每连接 20s；`Tools.java:152` `exec` 上限 120s；`AmooLoop.java:422` 循环默认 600s | 硬超时，语义清晰 | 可用 |
| 超时-PC | `amooStatusProvider` 的 outer deadline + 序号判废 | — | 可用（E1 覆盖） |
| 超时-闭环 | `LoopState.shouldStop` 五因，`STALL_AFTER_POLLS=5`（`:58`） | 「没有新命令」才计 stall；「屏幕没变」**故意不计**（`AmooLoop.java:46-50` 自陈） | 可用 |

**缺的一条**：`amoo_ask` 的排队。`Tools.java:339-342` 用中文拒绝已有任务，调用方拿不到 ETA、拿不到排队号。契约要定「拒绝 vs 排队 vs 覆盖」三选一，今天是隐式的「拒绝」。

### 9.4 失败如何不装作成功（必须原样保留）

- **手机闭环**：`AmooLoop.java:676-698` 三态——验证通过写「已执行，验证通过」；执行成功但验证不过写「执行了，但【未能验证】…请据此判断下一步，不要假设它成功了」；执行失败写失败原因。`LoopVerify` 只有 `READ_EQUALS/EXIT_ZERO/UI_TEXT_EQUALS` 三种可机检手段，其余一律 `NONE` 并如实报「无独立核对手段」（`:747-749`）。
- **记忆**：`AmooMemory.java:21-30` 写明「A fact is never silently promoted」，`UNVERIFIED` 永不降级已有 `VERIFIED`（`:140-166`）。
- **投递**：bridge 的 `khy_ask` 恒 `verified:false`；`amoon_inbox` 的每条消息与整体都带 `unverified:true`，因为 ack/reply 文件可被任何能写 `/sdcard` 的应用伪造。桌面端 `AmoonPane.tsx:53-56` 把这个类型钉死成 `unverified: true`。
- **A2A**：`serverMethods.js:42-57` 默认 executor 只回显 ack，注释明写「诚实占位，不假装跑了 LLM」。

**缺的一条**：Flutter 侧工具执行完只判 `success/failed`（`chat_screen_new.dart:296-300`），没有副作用复核，也没有「未验证」这一档。这是与手机闭环最大的不一致，契约里应把 `unverified` 定为**合法终态**，Flutter 侧接不进来之前不能声称「完成」。

### 9.5 现有载体能承载哪几条

| 协议要素 | 现有载体 | 承载情况 |
|---|---|---|
| 工具名 + 参数（手机→amoo→手机） | `AmooProtocol` 的围栏与形状双路 | **能**。围栏 `khy-exec/khy-plan/khy-done` 在这台设备上不进入无障碍树，退化为「整行是一个 JSON 对象」形状判据（`:225-240`），并明确列出残留误判风险 |
| 命令风险评估 | `LoopModes.java:116-152` | **能，但只用于 amoo 闭环**。`ExecFlags` 之外的工具（`ui_type`/`write`）不在安全底内 |
| 执行与验证 | `Tools.dispatch` + `LoopVerify` | **能** |
| 步骤行 | PC `amooPanelViewModel` / 手机 `AmooLoop.step()` | **不能**。两边形状不同：PC 是 `{id,ok,detail}` 列表（上限 12），手机是单个字符串。中间无通道 |
| 握手/版本 | `contracts.js:27-28` | **不能跨到 8896 栈**。协议号属于 18765 的 bridge，与 APK 的桥无关 |
| 任务幂等 | bridge `idempotency.js` / `mailbox.js` | **能**，但只覆盖 PC 与 bridge 之间，不覆盖手机 → amoo |
| 真模型面 | A2A `serverMethods` | **不能**（回声） |

### 9.6 共享契约（**待建**）的字段清单

必须是构建期校验而不是运行期可选。它至少要定：

1. **工具名集合**（含别名折叠规则——`LoopModes.java:424-445` 与 `Tools.java:119-123` 各写了一份）；
2. **风险档**（`low/medium/high`，与 `contracts.js:42` 的 `RISKS` 对齐）；
3. **确认语义**（今天的 `requiresConfirm` 在 `amooBridgePolicy` 只给 `rm`/`exec`，而 `phoneBridgeCatalog` 写操作全部要确认——两份口径）；
4. **步骤行形状** `{id, ok, detail}` + 上限 12 + `StepEvent` 超集字段；
5. **状态码**（`amoo_not_foreground` / `amoo_not_installed` / `timeout` / `no_reply` / `unverified` 等）；
6. **凭据归属**（哪条栈用哪套令牌）。

**依赖方**：APK（`Tools.java`、`LoopModes.java`、`AmooProtocol.java`）、PC（`amooBridgePolicy.js`、`phoneBridgeCatalog.js`）、bridge（`contracts.js`）。

### 9.7 安全边界

1. **不读对方私有数据**：`MANAGE_EXTERNAL_STORAGE` 到不了第三方 `/data/data/`；全仓无相关路径拼接。契约条目：新增任何「读 amoo 数据」的实现即违规，唯一合法读法是 UI dump（`KhyUi.java:75-88`）。
2. **不注入对方进程**：全仓没有 hook / instrument / Xposed 类实现（本轮未做全仓枚举，标**未做**）。现有交互只有 Intent 与读屏/点击。
3. **不在对方 UI 上做未确认的破坏性操作**：这一条今天**没有完全兑现**，必须直说——

   - `LoopModes.defaultMode()` 返回 `BYPASS`（`:163-165`）；`Tools.loopStart` 未传 mode 时走它。
   - BYPASS 下只要不踩安全底就直接 `EXECUTE`（`:131-135`）。安全底只覆盖 `rm` 与 `exec`（`HIGH_RISK_TOOLS`，`:62`），**不覆盖 `ui_type`/`write`/`start_app`**。
   - 手机端**没有任何确认 UI**（MethodChannel 无 loop 项，`lib/` 无 `LoopModes` 引用）。CONFIRM 的语义是「写文件 + 通知 + 停机」。

   所以当前形态是：**手机端无人值守地跑本地命令，靠安全底兜底**。契约必须做一个明确决定（这是产品取舍，不是实现细节）：(a) 手机端发起时强制 `EDIT` 或更高；或 (b) 保持 BYPASS 但把安全底扩到 `ui_type`/`write` 与 `start_app`；或 (c) 明说「只允许 PC 发起闭环」，手机端不开放 `loop_start`。**在 (a)/(b)/(c) 三者选一之前，不应在手机 App 里加「开始」按钮。**

4. **已兑现的一条**：`amoo_ask` 在前台检查失败时**拒绝**而不是盲发（`AmooLoop.java:207-217` 的注释写明「最危险的失败模式不是超时，是提示词落进我们自己的输入框」）。这条要保留。

### 9.8 历史与记忆的「真源在哪」判据

**记忆**：真源在**手机**的 `amoo_memory.json`（`AmooMemory.java:67`）。判据：

- 任一条目必须带 `provenance` 与 `confidence`。
- **只有** `confidence == VERIFIED` 的条目可以被当作事实陈述；`renderForInjection` 会给 UNVERIFIED 加 `[未证实]` 前缀（`:186-187`）。
- 注入给 amoo 的那份（`AmooLoop.java:493-502`）是**派生物**：截断（`renderForInjection(1200)`）、不落盘、不进回库。

**历史**：真源在**各自的会话存储**，不做跨端同步。谁产生的谁持有；任何跨端「历史」只能是引用（如 `amoo_ask` 的 `reply` 字段），不能是副本。

**投递记录**：真源在 bridge 的 `replies/` 索引，且它**恒为 unverified**。任何一侧展示时都必须带这个标记。

---

## 十、借鉴提案（[DESIGN-SOURCING-001] B-P2 六字段）

```
【借鉴提案】roubao 手机 GUI agent 的过程显示与动作后验证

1. 借鉴对象
   Turbo1123/roubao，本机 clone 于 %TEMP%\roubao_up，HEAD c8a6d7f（2026-01-08），
   分支 main。用户给出的仓库地址 https://github.com/Turbo1123/roubao。

2. 借鉴内容
   借三样「结论与形状」，不借实现：
   (a) 悬浮窗承载 停止 / 接管继续 / 敏感操作确认 三类回调的形状；
   (b) 截图与读屏之前先隐藏浮层、之后恢复（避免读到自家窗口）；
   (c) 动作之后再做一次观测并判定 A/B/C 的三态反思结构。

3. 解决的问题（khyos 当前的具体缺口）
   (a) BridgeOverlayService.java:225-241 只有 折叠/刷新/复制令牌/停止桥 四个按钮，
       不能停当前任务、不能确认待执行命令；
   (b) BridgeOverlayService.java 全文无 setVisibility，读屏与截图时浮层仍在屏上，
       KhyUi.java:75-88 的 dump 可能把自家窗口读进去（ROM 相关，未真机验证）；
   (c) AmooLoop.java:747-749 对无验证手段的命令一律返回 NONE 并报「无独立核对手段」，
       没有任何「动作后二次观测」的结构位；Flutter 侧 chat_screen_new.dart:296-300
       只判 success/failed，无副作用复核。

4. 许可证与代码性质
   MIT License，核实位置：%TEMP%\roubao_up\LICENSE 第 1 行 "MIT License"。
   上游为 Android/Kotlin 应用，无官方包依赖可复用；本提案不引入其代码。

5. 借鉴方式
   idea（(a)(c)）+ reference（(b) 的调用时序）。
   判定依据：三样都只需在既有类上添加少量逻辑，不新增能力域的外部实现，
   不需要 fork/vendored。按 B-P3，idea/reference 由作者自评 + 任一评审即可。

6. 落点与现有实现对比
   a. 落点（均为既有文件）：
      delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/BridgeOverlayService.java
      delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/AmooLoop.java
      delivery/mobile/khy-os-client-app/android/app/src/main/java/com/khyos/khy_os_client/bridge/KhyUi.java
      （以及本文 §8.3.4 新增的 StepEvent 载体类，为新增文件）
   b. 现有同类实现检索结论（四步，B-U2）：
      - 别名检索：docs/10_规范/registry/FEATURE-OWNERSHIP.json 共 16 个 capability，
        无「悬浮窗 / overlay / 步骤显示 / 反思 / 动作后验证」任一条目；无 roubao 相关 source。
      - 符号检索：`findstr /s /n /c:"setVisibility" BridgeOverlayService.java` 零命中；
        `currentTimeMillis|elapsed|duration` 零命中；`loop_stop|AmooLoop.stop` 零命中。
        `LoopVerify` 只有三种可机检 Kind，无「二次观测」概念。
      - 模式检索：docs/16_设计模式/registry/模式注册表.json 中无「overlay callback」类模式；
        本提案沿用既有 Service + Handler 结构，不引入新模式。
      - 层检索：按 [DESIGN-LAY-005]，三处落点均在既有 L? 手机端层内（delivery/mobile），
        不新建层、不新建顶层目录。
      - 结论：这是「扩展既有 canonical」，不是新增并行实现；唯一新增件是 StepEvent 载体类，
        它属于「本仓此前不存在的对外契约形状」，按 B-P1 需本提案覆盖，已覆盖。

7. 验收方式
   一次性操作（需真机）：
   - 启动桥 → 长按浮层面板能看到「停止当前任务」按钮，点它后 AmooLoop.isRunning() 转 false；
   - 触发一次 ui_dump → 浮层在调用前后各隐藏一次，dump 结果中不含 khy-os 自身窗口；
   - 构造一条无验证手段的命令走闭环 → 结果标「未能验证」，且步骤行带独立 state（非 ok/failed）。
   可复现的单测（不需真机，当前即可跑）：
   `cd delivery/mobile/khy-os-client-app/android && gradlew.bat :app:testDebugUnitTest --offline --rerun-tasks`
   （本轮实跑：BUILD SUCCESSFUL in 2m 48s，11 suite / 216 testcase / 0 失败；
     新增行为须补进该套件，届时以新增用例计数为判据。）
```

**明确不做的事**：不 vendored roubao 源码；不抄 `skills.json` 的 `related_apps` 语义；不抄它的 Shell 白名单（`ShellTool.kt:121` 的校验是被注释掉的）；不把它当正确实现基线（其 `main` 分支无测试目录）。

---

## 十一、实施分期

每期写依赖与今天已存在的落点。**没有一项可以在缺依赖时跳过前一行**。

### D0 只读对齐（不改行为）

| 项 | 内容 | 今天已存在的落点 |
|---|---|---|
| D0-1 | 把「工具名集合 / 风险档 / 确认语义 / 步骤行形状 / 状态码 / 凭据归属」六项写成契约文件的初稿（**构建期校验的骨架**） | `contracts.js`（12 名）、`amooBridgePolicy.js`（22 名）、`phoneBridgeCatalog.js`（28+11）、`Tools.NAMES`（39）、`LoopModes.KNOWN_TOOLS`（36）五份现存清单 |
| D0-2 | 把 `LoopModes.KNOWN_TOOLS` 缺 `amoo_ask/amoo_result/amoo_memory` 这条漂移登记为待修（它会导致 amoo 在纯文本里下发 `amoo_ask` 被 `AmooProtocol.java:236` 的 `isKnownTool` 静默忽略） | `LoopModes.java:70-76`、`AmooProtocol.java:236`；E6 已实测差集 |
| D0-3 | 把 `describeStop`（6 因）与 `STOP_REASON_TEXT`（3 键）的差集登记为待收敛 | `AmooLoop.java:1037-1054`、`amooDispatchPlan.js:259-271` |
| D0-4 | 确认「内置密钥为空」是配置缺口而非架构缺口，并把 `app_config_test.dart:165` 的失败作为**已知基线**记录，不擅自改测试 | E3 |
| 依赖 | 无 | — |

### D1 契约落地

| 项 | 内容 | 依赖 | 今天已存在的落点 |
|---|---|---|---|
| D1-1 | 契约文件 + 构建期校验（缺则 CI 红） | D0-1 | `FEATURE-OWNERSHIP.json`（可作登记位，今日 16 个 capability、status=seeded） |
| D1-2 | 三端各自改为**从契约读**工具名集合，删掉 local 常量 | D1-1 | `Tools.java:106-114`、`LoopModes.java:70-76`、`amooBridgePolicy.js:31-177`、`phoneBridgeCatalog.js`、`contracts.js` |
| D1-3 | 别名折叠规则收敛到一处（`shell_exec→exec` 等五条） | D1-1 | `LoopModes.java:424-445`、`Tools.java:119-123`（今天各写一份） |
| D1-4 | `amoo_not_installed` 与 `amoo_not_foreground` 分开 | D1-1 | `AmooLoop.java:212-217` |

### D2 复用与悬浮窗

| 项 | 内容 | 依赖 | 今天已存在的落点 |
|---|---|---|---|
| D2-1 | 浮层生命周期解绑桥（改为「桥 或 任一执行器在跑」） | D1 | `BridgeService.java:44`、`:67` |
| D2-2 | `StepEvent` 内存队列 + 浮层读队列（零 IO） | D2-1 | `BridgeOverlayService.java:265-327` |
| D2-3 | Dart→原生反向通道（推 `ExecutionStep`） | D2-2 | `MainActivity.kt:56`（正向 channel）、`execution_log.dart:7-79` |
| D2-4 | `Tools.dispatch` 进出埋点 + `via` 透传 | D2-2 | `Tools.java:116`、`:534-572` |
| D2-5 | 一键停止（接 `AmooLoop.stop()` / `stopAsk()`，Dart 侧如实标「本步无法中断」） | D2-2 | `AmooLoop.java:471-477`、`:323-326` |
| D2-6 | 记忆提升为 APK 本地底座（云模型通道与 amoo 通道共用一份） | D1 | `AmooMemory.java:34-249`、`AmooLoop.java:397-417` |
| D2-7 | 白名单收敛：Flutter 的 `exec_shell` 改调 `Tools.dispatch` 或共用同一份名字表 | D1-3 | `MainActivity.kt:563-572`、`builtin_tools.dart:335` |

### D3 roubao 能力补齐

| 项 | 内容 | 依赖 | 今天已存在的落点 |
|---|---|---|---|
| D3-1 | 浮层读屏/截图自隐藏 | D2-1 | `BridgeOverlayService`、`KhyUi.java:75-88` |
| D3-2 | 浮层三按钮（停止 / 接管继续 / 确认取消）——**前置：§9.7 第 3 条 (a)/(b)/(c) 选一** | D2-5 | `BridgeOverlayService.java:225-241` |
| D3-3 | 动作后二次观测的反思结构（不默认两次 VLM/步，那是成本结构问题） | D2-4 | `LoopVerify.java:57-86`、`AmooLoop.java:747-749` |
| D3-4 | 步骤行单条展开（数据源已有） | D2-2 | `execution_log.dart:12-13`（`output`/`error`）、`amooPanelViewModel.js:362-369` |

---

## 十二、验收

每期一条可复现命令或操作。**需要 Flutter 环境/真机的显式标注**。

| 期 | 验收 | 命令 / 操作 | 本机可执行吗 |
|---|---|---|---|
| D0 | PC 侧 amoo 叶子全绿 | `cd runtime/node/backend && node --test src/services/domain/network/amoo/*.test.js src/services/domain/network/amoo/client/*.test.js` → 期望 `# fail 0`（本轮实测 187/187） | **可** |
| D0 | bridge 全绿 | `cd delivery/extension/bridges/khy-amoon-bridge && node --test test/*.test.js` → 期望 `# fail 0`（本轮实测 186/186） | **可** |
| D0 | 工具名差集可复现 | `node -e` 比对 `Tools.NAMES` 与 `LoopModes.KNOWN_TOOLS` → 期望 `onlyInTools=amoo_ask,amoo_result,amoo_memory` | **可**（本轮用临时脚本，已删） |
| D1 | 契约缺项会让 CI 红 | 待建：契约校验脚本（今日不存在，命令待建） | 命令**待建** |
| D1 | 原生单测仍全绿 | `cd delivery/mobile/khy-os-client-app/android && gradlew.bat :app:testDebugUnitTest --offline --rerun-tasks` → 期望 `BUILD SUCCESSFUL`（本轮 2m 48s、11 suite / 216 testcase / 0 失败） | **可**（需 Android SDK，本机已具备） |
| D1 | Dart 侧不退化 | `cd delivery/mobile/khy-os-client-app && D:\Portable\2-tools\flutter\flutter\bin\flutter.bat test` → 本轮 `+257 -1`，唯一失败即内置密钥空（`app_config_test.dart:165`）。**该失败是已知基线，不是本次引入** | **可**（`flutter` 不在 PATH，必须用该绝对路径） |
| D2 | 浮层在独立模式聊天时可见 | 真机：不开桥，只在 App 内发一条消息 → 浮层出现并显示步骤 | **本机无法执行**（需真机） |
| D2 | 步骤行显示 n/m 与耗时 | 真机：发一条会调用 ≥2 个工具的消息 → 浮层出现「执行 2/3：… · 4s」形态 | **本机无法执行** |
| D2 | 一键停止不撒谎 | 真机：任务执行中点「停止」→ 浮层显示「本步无法中断，停止后不再发下一步」 | **本机无法执行** |
| D2 | 记忆跨通道共用 | 真机：用云模型通道跑一条 `write` 成功 → `amoo_memory.json` 出现一条 VERIFIED；再让 amoo 通道的 preamble 带上它 | **本机无法执行** |
| D3 | 浮层不污染读屏 | 真机：触发 `ui_dump` → 结果 XML 中不含 khy-os 自身窗口节点 | **本机无法执行**（且 ROM 相关，可能本来就不可见） |
| D3 | 「未能验证」是独立终态 | 真机：走一条无验证手段的命令 → 结果标「未能验证」，浮层状态既非 ok 也非 failed | **本机无法执行** |

**一句话**：本机能跑的只有「单测不退化」这一层；所有与浮层、真机、amoo 前台有关的验收都**未跑**，不得记为已通过。

---

## 十三、开放问题

以下六条来自仲裁 `openQuestions`，逐条写清**需要人决定什么**。在它们被回答前，§九.7 第 3 条与 D3-2 不能开工。

### Q1 「APK 直接使用 amoo 中的模型」最终要哪一种？

- **A** 把 amoo 当聊天后端（分钟级、单发、必须前台、无流式，amoo 改版即失效）；
- **B** 放弃这条，由 khyos 自带云模型承担主通道、amoo 只作可选旁路；
- **C** 其他。

需要人决定：**是否为 A 付一次产品级代价**。本文建议 B（§7.5），但这是产品取舍，不是技术判断。

### Q2 amoo 是第三方且 khyos 依赖它的三个硬编码 resource-id 与几何假设

`AmooLoop.java:71-74` 的 `chat_list` / `et_input_bar` / `btn_text_send`，以及 `:68-70` 的「输入框随软键盘上移约 1300px」。对方一次改版就会让整条闭环读不到输入框，而本仓无法控制。

需要人决定：**这条依赖是否可接受为长期产品路径**。

### Q3 roubao 是 vendored 还是只借鉴设计？

若 vendored，按本仓既有口径（`scripts/copyright/` 的 vendored 规则、`PROCESS-010` 的 C-X3「第三方代码不得作为登记材料源程序」）需单独裁决它是否进入软著候选之外；若只借鉴设计，「技能包数据」这类纯数据资产也要单独定来源与许可。

需要人决定：**走哪一档**。本文提案取 `idea`/`reference`（§十 第 5 字段），不主张 vendored。

### Q4 A2A 服务端的真 executor 接谁？

现在 `routes/a2a.js:42` 是回声占位、全仓无注入点（`serverMethods.js:66-68` 是唯一入口）。接内置 agent 运行时意味着手机可通过 A2A 调用 PC 的模型额度，这是一条**新对外能力面**，且 `KHY_A2A_API_KEY` 未配置时是 fail-open（`a2a.js:54-61`）。

需要人决定：**要不要开、谁能调**。

### Q5 手机端是否允许在 App UI 内发起 amoo 闭环（`loop_start`）？

现在 Flutter 完全不可达（`lib/` 下 `loop_start` 零命中），且 `LoopModes.defaultMode()` 是 `BYPASS`、无交互确认 UI。放开等于让手机自己无人值守地跑本地命令。

需要人决定：**这是产品定位取舍**，不是实现细节。三个候选见 §9.7 第 3 条 (a)/(b)/(c)。

#### P0-2 实施留痕（2026-11-03）：安全底扩到不可逆项，`zip`/`unzip` 的 BYPASS 取舍待裁决

本条与 Q5 同源——Q5 问的是「BYPASS 档下手机能自己跑哪些本地命令」，而 P0-2
（报告 `works/data/khy/reports/stepx-khyos-amoo-20261102.md` §四）把 12 项工具
补进手机循环之后，BYPASS 档的覆盖面第一次有了实质变化，必须在这里留痕而不是
默默定案。

已实施（可复核）：

| 项 | 实施内容 | 位置 |
|---|---|---|
| 清单补齐 | `LoopModes.KNOWN_TOOLS` 36 → 48，成为 `Tools.NAMES` 的**集合镜像**；此前差的 12 项（`adou_signin` / `amoo_ask` / `amoo_result` / `amoo_memory` / `amoo_stop` / `zip` / `unzip` / `secret_code` / `secret_put` / `secret_list` / `secret_del` / `tools`）在 `AmooProtocol.extractCommands` 的解析期被静默丢弃 | `LoopModes.java` / `AmooProtocol.java` |
| 安全底 | 不可逆项（`secret_*` / `adou_signin` / `amoo_*`）进**模式无关**安全底：BYPASS 也返回 `CONFIRM` + `floorTripped=true` | `LoopModes.floorReason` / `IRREVERSIBLE_TOOLS` |
| 环内特判 | `amoo_ask` 在循环路径被拒并给中文原因（环内自调用必撞单飞锁，确认解决不了）；PC 经 HTTP /call 或信箱驱动不受影响（沿用 `ui_type` 先例） | `AmooLoop.executeOne` |

**待人裁决（本轮未定案）**：

1. **`zip` / `unzip` 在 BYPASS 下按当前取舍直接 `EXECUTE`**（不进安全底）。理由：破坏面
   是「覆盖目标目录里的同名文件」（可逆），而 `unzip` 自带 Zip Slip 防护。**但**
   「不可逆只限 `secret_*` / `adou_signin` / `amoo_*`」是一条**取舍**，
   需要人确认是否把 `zip`/`unzip` 也纳入安全底。
2. **`amoo_stop` 的环内紧急出口**：它被列进不可逆集合（安全底对它的通用结论是
   「先问人」），但环内「喊停」必须立刻生效——安全底否决的是**不可撤销的动作**，
   中止是相反方向的。实现上，旁路档（BYPASS）里环内的 `amoo_stop` 走
   `AmooLoop.executeStopInLoop` 直接执行（写回「已中止提问，单飞锁已释放」），
   其余档位仍先经人确认。**这处 carve-out 需要人复核**。

另记：本文正文里的 `Tools.NAMES` 39 项 / `KNOWN_TOOLS` 36 项是 2026-10-23 的旧数
（当时 `Tools.NAMES` 就是 39），本次只订正了 P0-2 直接改动的那一处，其余旧数
属 P1-4 的文档漂移批次，未在本轮顺手清理。

### Q6 「过程步骤显示」要不要做到可交互（停止/接管/确认）？

roubao 有 `stopCallback`/`confirmCallback`（`OverlayService.kt:43-45`、`:272-321`），本仓浮层只有折叠/刷新/复制令牌/停止桥四个按钮，不能停当前任务。做交互就要先解决 `LoopModes` 在 CONFIRM 时的「无 UI 只能停机写文件」语义（`AmooLoop.java:58-62`、`:661-665`）。

需要人决定：**做到哪一档**（只读显示 / 显示 + 停止 / 显示 + 停止 + 确认）。

---

## 十四、与既有文档的衔接

### 14.1 本文引用但不替代

| 文档 | 关系 |
|---|---|
| `[DESIGN-ARCH-117] khy-多端入口矩阵` | 端矩阵与声明状态的**真源**。本文只引用「手机端幸存者是 `mobile`」，不改矩阵 |
| `[DESIGN-ARCH-120] khy-移动端合并方案` | 决定 `apps/khy-mobile` 与 `apps/khy-os-client-app` 谁是幸存者。本文的 `delivery/mobile/khy-os-client-app` 落点以它为准 |
| `[DESIGN-ARCH-001] khy-移动智能体协议` | 移动智能体的协议层定义。本文的 `AmooProtocol` 形状判据是它的一次实现，不重定义协议 |
| `[DESIGN-ARCH-071] 通道选择决策矩阵` | 「一次读取/操作前五问」。本文所有「谁执行」的判断沿用 CH-1..CH-5，不另立通道 |
| `[DESIGN-ARCH-016] AI_Agent显示规范` | 过程显示的上层规范。本文的 `StepEvent` 是它在手机端的落地形状，不替代它 |
| `[DESIGN-ARCH-113] AI修改三模态反馈契约` | 「修复先复现 / 新增先提问 / 删除先报部位」的语义真源。本文不改它 |
| `[DESIGN-SOURCING-001] 借鉴与实现统一规则` | 本文 §十 的 B-P2 提案按它的六字段模板写；B-U2 四步检索结论写在提案第 6b 字段 |
| `[DESIGN-LAY-003]`（`LAYOUT-004`）/ `[DESIGN-LAY-004]`（`LAYOUT-005`） | 产物落盘与仓库整理。本文不新增落盘路径 |
| `[DESIGN-LAY-005] 仓库层级板块规范` | 层级落点。本文所有落点均在既有层内（`delivery/mobile`、`delivery/extension/bridges`、`runtime/node/backend/src/services/domain/network`） |

### 14.2 本文是这些问题的方案真源

- 「手机端 khyos 与 amoo 的职责怎么划」→ §五、§六
- 「哪些原子能力可复用、怎么复用」→ §六
- 「悬浮窗与过程步骤怎么落地」→ §八
- 「roubao 哪些值得借鉴」→ §六.2、§十

### 14.3 与 `README` 自述的区分

`delivery/extension/bridges/khy-amoon-bridge/README.md`（35,628 字节）与 `runtime/node/backend/src/services/domain/network/amoo/README.md`（14,511 字节）**本轮未读**。凡本文与它们表述不一致处，需以**代码实测**为准（E1–E13），不以 README 自述为准。

### 14.4 编号说明

本文编号 `DESIGN-ARCH-193` 为 `DESIGN-ARCH` 组的下一个空号（该组现存 001–192，见 `00_INDEX_DESIGN-ARCH-总目录.md`）。本文**不新增规则 ID**，不携带 `RULES-REGISTRY` 标记。

---

## 十五、本轮实际执行的检查（如实记录）

| 检查 | 命令 | 结果 |
|---|---|---|
| PC amoo 叶子单测 | `cd runtime/node/backend && node --test src/services/domain/network/amoo/*.test.js src/services/domain/network/amoo/client/*.test.js` | `# tests 187` / `# pass 187` / `# fail 0`（14 个文件） |
| bridge 单测 | `cd delivery/extension/bridges/khy-amoon-bridge && node --test test/*.test.js` | `# tests 186` / `# pass 186` / `# fail 0`（16 个文件） |
| Dart 单测 | `cd delivery/mobile/khy-os-client-app && D:\Portable\2-tools\flutter\flutter\bin\flutter.bat test` | `+257 -1`，唯一失败 `app_config_test.dart:165`（`defaultProvider has a key`，`Expected: <true>` / `Actual: <false>`） |
| Android 单测 | `cd delivery/mobile/khy-os-client-app/android && gradlew.bat :app:testDebugUnitTest --offline --rerun-tasks` | `BUILD SUCCESSFUL in 2m 48s`；聚合 `suites=11 tests=216 failuresAndErrors=0` |
| PC 命令面存在性 | `node runtime/node/backend/bin/khy.js amoo help` | 打印七个子命令与三条诚实边界 |
| 契约工具名读取 | `node -e "require('./lib/contracts').listToolNames()"` | 12 项 |
| 策略工具名读取 | `node -e "require(.../amooBridgePolicy).BRIDGE_TOOLS"` | 22 项 |
| 手机工具名读取 | `node -e` 解析 `phoneBridgeCatalog` | 28 + 11 |
| `Tools.NAMES` vs `KNOWN_TOOLS` | `node -e` 解析两个 Java 文件（临时脚本已删） | 39 / 36，差集三个 amoo 工具 |
| 内置密钥空数组 | `node -e` 解析 `built_in_keys.dart`（临时脚本已删） | 9 provider，7 个数组 EMPTY |
| 面板行模型行为 | `node -e` 调 `buildAmooPanelModel` | 空输入 → `tone=idle` / `rows=7` / `headline=尚未读取手机状态`；20 步 → 截到 12、首条 `s8` |

**未跑**：构建 APK、装真机、任何真机交互验证、amoo 单轮计时、`amoo_ask` 端到端、远程模式实际响应码。

**未读**：PC 侧六套记忆存储、`amooBridgeClient.js` 全文、`KhyAccessibilityService.kt` 全文（只读了函数清单）、`scripts/gen_keys.py`、`scripts/check_builtin_keys.py`、两个 `README.md`、amoo 应用内部实现。

---

## 十六、与并行施工的 Claude Code 会话对齐（2026-10-23 晚实测）

> **为何单列一节**：本文 §七–§十一 的「待建 / 现状」写于本轮盘点期间，而同一台机器上另一个 Claude Code 会话（标题「工作桥 amoo 与 khyos 互联」）正在**同时施工**这批文件。施工进度会直接改写本文的若干结论，因此以本节为准：**§七–§十一 中凡与本节冲突处，本节优先**。

### 16.1 对齐口径与证据时点

| 项 | 事实 |
|---|---|
| 观测时点 | 2026-10-23 23:00–23:10（`date` 实读；本文 §三 E 表止于 17:5x，晚于它的结论需重验） |
| 施工方 | 另一个 Claude Code 会话，工作区同一份（`D:\Portable\khy-os`），`git status` 计 899 项（§三.1 记的 870 是 17:5x 的读数） |
| 施工依据 | `works/data/khy/T4-transient/tmp/wf2_spec.md`（258 行，批次 0–6 的文件级施工单，含逐条测试用例名与验证命令） |
| 会话记录可得性 | **本机无该会话的 `.jsonl` 轨迹**：`~/.claude/projects/` 下只有 2026-09-20 的 8 个 10KB 文件，`find /c/Users /d/Portable -name '*.jsonl' -newermt 2026-10-22` 无新增命中。故本节**不从对话记录推断**，一切以磁盘产物与源码实测为准 |
| 活跃证据 | 观测窗内 `MainActivity.kt` 仍在被写（23:04 之后仍有 mtime 变化），说明施工未收口 |

### 16.2 施工批次完成度（按 `wf2_spec.md` 的批次号，逐文件实测存在性）

| 批次 | 交付物 | 实测 |
|---|---|---|
| 批次 0（PC 契约层） | `phoneBridgeEnvelope.js` + 同名测试 | **未开始**（两文件均不存在） |
| 批次 1（zen 门纯叶 + SSE） | `zen_gate.dart`、`zen_stream.dart`、`zen_gate_test.dart` | **未开始** |
| 批次 2（public 免费通道 + 模型表去硬编码） | `zen_chat_client.dart`、改 `built_in_keys.dart`/`app_config.dart`/`model_registry.dart`/`provider_presets.dart` | **未开始**：`built_in_keys.dart` 无 `isPublicPlaceholder`、无 `hasSecretKey`、无 `kZenBaseUrl`（`hasBuiltInKey` 已在 `:264`，`defaultProvider` 已改 agnes 在 `:251`——那是另一笔小改，不是批次 2） |
| 批次 3（桥自我描述 + 单飞闸 + 首页反代 amoo） | 见 16.3 | **大部分已落地**，但桥侧四项未做 |
| 批次 4（结构化数字信封） | `message_envelope.dart`、`AmooEnvelope.java`、两份测试 | **未开始** |
| 批次 5（内置工具收敛三处注册） | `bridge_tools.dart`、`shared_tool_engine.dart`、`bridge_tools_test.dart` | **未开始** |
| 批次 6（内置智能体三元组 + 中断） | `builtin_agents.dart`、`builtin_agents_test.dart`、停止键修复 | **未开始**（停止键仍是死的，见 16.4） |

### 16.3 批次 3 已落地的部分（这直接改写 §七.3 与 §五.1.1）

| 施工内容 | 实测证据 | 对本文的影响 |
|---|---|---|
| Flutter→原生 `amooAsk` / `amooAskResult` / `amooAskStop` 三通道 | `MainActivity.kt:196`、`:201`、`:202` 分派；`:1029`、`:1051`、`:1091` 实现 | **§7.5「待建 1」已消除**：App 内已可发起 amoo 反代 |
| `AmooChatService`（Three-call 拆分：发起 / 轮询 / 中断） | `lib/core/services/amoo_chat_service.dart` 232 行；`ask`/`poll`/`stop` 各带 8s 超时，注释自述「桥 socket 超时 20s，一条阻塞调用必然超时」 | §七.3 的「无流式、单发」性质未变，但**入口已存在** |
| 提问先落盘再发起（`pending` 态） | `lib/core/db/amoo_turn.dart` 204 行（五态 `pending/running/done/failed/interrupted`）；`amoo_turn_store.dart` 206 行（sqflite，`insertPending` 在原生 ask 之前） | 本文未预见的一条**诚实边界**：`interrupted`（进程死、amoo 可能已答）与 `failed`（明确错误）被刻意分开，且未知态回落 `interrupted` 而非 `running` |
| 首页 `AmooTaskCard` | `lib/ui/widgets/amoo_task_card.dart` 415 行；`chat_screen_new.dart:951`、`:1314` 两处挂载 | §五.2.3「两者都在」的入口从「PC 侧」扩到「App 内」 |
| `ChatTargetNotifier`（主输入框对 amoo 时卡片收起自己的输入框） | `lib/core/services/chat_target.dart` 26 行 | 避免双光标，属本文未列的实现细节 |
| 提问期间保屏 | `MainActivity.kt:1063` `setKeepScreenOn`，注释写明「熄屏后无障碍树会过期」 | 本文 §八 未覆盖的一条硬约束：**一轮 6 分钟必须保屏**，否则读回空气泡 |
| `Tools`/`AmooLoop` 的前台预检与 `foregroundPackage()` | `AmooLoop.java:214` `amoo_not_foreground`；`public static String foregroundPackage()` 已存在 | §七.3 表内该行已从「脆弱处」变为「已实现」 |

**批次 3 未做的四项（本文仍需保留为待建）**：

1. `Tools.NAMES` 未增 `amoo_stop`（实测仍 39 项，`amoo_stop` 零命中）——故闭环保留 PC 侧 `loop_stop` 一条路。
2. `BRIDGE_ACTUATE_LOCK` 不存在（`Tools.java` 全文零命中）：`amooAsk` 与 `loopStart` **仍无共享互斥**，二者共用 memory / writeBack / progress 会互踩。这是**并发正确性缺口**，非风格问题。
3. `HttpBridge` 的 `/status` 仍未输出 `tool_names`（`:383` 只有 `.put("tools", Tools.NAMES.length)`）：PC 侧**无法在调用前判断某项能力在不在**，只能撞 `unknown tool`。`BridgeService` 的信箱路径同样零命中。
4. `amooAskResult` 未回传 `progress` 与 `ask_ms`（`AmooLoop.askResult` 处未见该两字段）：Dart 侧 `AmooTaskCard` 因此拿不到「进行到哪一步」，与 §八 的步骤显示需求仍断在最后一米（卡片全文 `progress` 零命中）。

### 16.4 本文原本要修、施工方尚未修的两个真缺陷（复核后仍成立）

| 缺陷 | 实测证据 | 影响 |
|---|---|---|
| **停止键是死的** | `chat_screen_new.dart:1239` `final ready = _canSend;` → `:1247` `onTap: ready ? ... : null`；而 `:1275` `bool get _canSend => _input.text.trim().isNotEmpty && !_busy;`——`_busy` 为真时 `ready` 恒假，`onTap` 为 null；但 `:1267` 仍画 `_busy ? Icons.stop : Icons.send_rounded`。**图标是停止，点击无反应** | 用户在 6 分钟的 amoo 轮次里看到一个停止键，按下去什么也不发生。`_stopCurrent` 全仓零命中 |
| **技能摘要承诺了不存在的工具** | `chat_screen_new.dart:2085` `- a11y_tap / a11y_swipe / a11y_type_text: 模拟操作`；而 `builtin_tools.dart` 的工具表中无 `a11y_swipe`、无 `a11y_type_text`（`a11y_*` 的实际名字是 `ui_*` 系列） | 模型被 system prompt 引导去调不存在的工具，每次都是 `unknown tool` 空转。属 §六.1「同一能力不许两套名字」的直接反例 |

### 16.5 对 §七–§十一 的具体订正（以本节为最终口径）

| 位置 | 原文说法 | 订正后 |
|---|---|---|
| §7.5 待建第 1 条 | 「Flutter→原生的 `amoo_ask` 通道（`MainActivity.kt:56-160` 现无此方法）」 | **已完成**：`amooAsk`/`amooAskResult`/`amooAskStop` 在 `MainActivity.kt:196-202` 分派、`:1029-1110` 实现 |
| §7.5 待建第 3 条 | 「过程显示（现在只有一个 `volatile String progress`）」 | **仍成立**，且更精确：原生侧 `progress` 未透出给 Dart（`askResult` 不回传），卡片无进度可显示 |
| §7.5 待建第 2 条 | 「排队语义（第二个请求直接被 `return null` 拒绝）」 | **仍成立**：`AmooLoop.java:200` 的 `if (askRunning) return null` 未变，且未加互斥锁保护 `loopStart` |
| §5.1.1「今天不成立的一条」 | 「APK 内部自己发起 amoo 闭环是待建」 | **部分成立**：`amooAsk`（问一句、拿回复）已通；`loop_start`（让 amoo 下发命令并在本机执行）仍未暴露（`MainActivity` 内 `loop_start`/`loopStart` 零命中） |
| §6 复用矩阵「对话历史」行 | 「无跨端同步，日志只在本地」 | **仍成立**，但新增一条本地事实：amoo 反代的一笔提问现已落 sqflite（`amoo_bridge.db`），带五态与 `synced` 字段——是「待同步」的雏形，但不是跨端同步 |
| §三 E 表 | E3 记 Flutter 测试 `+257 -1`（唯一失败为 `defaultProvider has a key`） | **已过期**：该测试已被改写为「没有任何内置供应商携带明文 key（R2 守卫）」，本轮复跑 `flutter test` 为 **274 全绿**。E3 的**结论**（七个密钥数组全空）仍成立，但「有一条红测试」的说法不再成立 |
| §八.2.3「没有耗时」 | 「`refreshPanel` 全文无时钟读取」 | 仍成立；另注 `amoo_turn.dart` 的 `askedAt`/`settledAt` 已在 Dart 侧提供耗时数据源，浮层只需读它 |
| 全文行号 | 引用 `chat_screen_new.dart:118-121`、`:1295-1311`、`:1401-1438`、`:1509-1513` 等 | **已漂移**：该文件从 1697 行涨到 **2117 行**；实测现落点为 `API 未配置` 在 `:144`/`:182`、`_autoFailover` 在 `:1724`/`:1819`、`_consecutive429` 在 `:1714-1733`、`_dangerousPatterns` 在 `:1902-1920`。**本文所有 `chat_screen_new.dart` 行号在施工收口后需按符号重新 grep，不可按数字照抄** |

### 16.6 本轮对齐实际执行的检查

| 检查 | 方式 | 结果 |
|---|---|---|
| 批次交付物存在性 | `node` 脚本逐文件 `fs.existsSync`（18 个文件） | 7 个 MISS（批次 0/1/2/4/5/6 的新文件全缺）、11 个 DONE |
| `Tools.NAMES` 是否含 `amoo_stop` | `node` 读 `Tools.java` 正则取 `NAMES = {...}` | 39 项，`amoo_stop` 零命中 |
| 互斥锁 | 全文检索 `BRIDGE_ACTUATE_LOCK` | 零命中 |
| `/status` 能力名 | 检索 `tool_names`（`HttpBridge` + `BridgeService`） | 均零命中 |
| 停止键 | 读 `chat_screen_new.dart:1239-1275` | `_canSend` 含 `!_busy`，`_stopCurrent` 零命中 → **死键确认** |
| 技能摘要 vs 工具表 | 检索 `a11y_swipe`（`chat_screen_new` 与 `builtin_tools`） | prompt 里有、工具表里没有 → **承诺不存在工具确认** |
| Flutter 测试 | `D:\Portable\2-tools\flutter\flutter\bin\flutter.bat test` | **274 全绿**（§三 E3 的 `+257 -1` 已过期） |
| PC 侧 amoo 单测 | `node --test src/services/domain/network/amoo/*.test.js src/services/domain/network/amoo/client/*.test.js` | 187/187 通过 |
| 会话轨迹 | `find /c/Users /d/Portable -name '*.jsonl' -newermt 2026-10-22` | 零命中（施工方无本地轨迹可读） |

**未做**：APK 构建（本机有 Flutter 3.47.2，但真机不在手）、`gradlew` 全量单测（施工方在跑，本轮未复跑）、与施工方通信（无通道）。

### 16.7 与施工方分工的结论

施工方（Claude Code 会话）在按 `wf2_spec.md` 推进**实现**；本文负责**职责划界与复用裁决**。二者的重叠面只有两处，均已在上表订正：

1. **「App 内发起 amoo 反代」**——本文 §7.5 曾建议「不做成 App 内可发起的路径」，施工方已做成。这不是谁对谁错：本文的反对理由是「分钟级/单发/需前台」，而施工方用「三调用拆分 + 8s 超时 + 先落盘 + 保屏 + 五态诚实边界」把这三点各自绕开了一步。**结论应修订为**：可做成 App 内路径，但必须同时具备四件：三调用拆分、`interrupted` 独立终态、提问期间保屏、单飞锁；缺任一件则退回 §7.5 原议（只作 PC 侧手动旁路）。
2. **「工具名集合唯一真源」**——本文 §6.1 判为最高优先级，施工方的批次 5（`bridge_tools.dart` 从 `Tools.NAMES` 派生）正是这件事，尚未开工。本文的 `共享契约（待建）` 与它的 `bridge_tools` 应合并为同一件事，不要各做一份。
