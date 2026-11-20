# [RESEARCH-029] amootool 四项目调研与 khy-os GUI / Amoo 集成方案

> 日期：2026-11-16　状态：调研结论（未实施）
> 调研对象：`D:\Portable\amootool\` 下 4 个下载归档（解压于 `D:\Portable\amootool-extract\`）
> 对照对象：本仓 `apps/khyos-desktop/`、`runtime/node/backend/`、`delivery/mobile/`
> 方法：双路只读调研（归档侧读 README/SPEC/docs；仓内摸 agentbus/amoo/GUI 现状），交叉比对后成文
> 定位：为「khy-os 如何更好地使用 GUI 与 amoo」给出接入点与优先级，不替代任何设计真源

---

## 1. 结论摘要

四个包里真正对 khy-os 有增量的是两个：

1. **android-agent-kit**（Apache-2.0）——桌面侧 GUI-agent 算法库套件。`uidref` 把
   uiautomator dump 从 276KB 压到 8.6KB（32 倍）并给出稳定元素引用；`screenpoint`
   做坐标反算；`blindspot`/`imespec` 做点击前遮挡预检；`screendiff` 做点击后效果验证。
   其中 `uidref/js`、`screendiff/js` 是**零依赖 JS 实现**，可直接内嵌进 khy-os 桌面前后端，
   不需要 Python 运行时。这正好补上本仓「Android GUI 能力缺位」——当前手机 APK 是 lite
   构建，无无障碍/截图/UI 工具，桌面侧只有零散 adb 原语。
2. **amoo-dsh / phone-dsh（hiao）**——手机端完整 agent 运行时（v2.8，72 工具），
   HTTP 桥 `:8898` 兼容 amoobridge 协议，带治理管线（审批卡 → 能力租约 → 执行 →
   审计哈希链）与无状态 MCP 端点。可成为 khy-os 的**第二手机接入目标**，
   把「裸 adb 点屏、绕过治理」升级为「带人在环审批的执行层」。

另两个包价值有限：**amoo-bridge-lite** 是 StepBridge 精简版（点按/滑动/截图已移除，
只剩只读 UI），协议与 khy-os 已对接的 PhoneBridge（`:8896`）同族；**android-dsh** 是
官方 dsh 引擎宿主，已冻结，内部协议随版本漂移，不推荐接入。

**amoo 本体**是 StepOS 设备内置助手（`com.stepos.ailauncher` 等），闭源；所有相关项目
文档都明令不逆向、不抓包、不伪装。khy-os 的 agentbus 车道（`localabstract:agentbus`，
协议 v3）已经是连它的正门，方向正确，缺的是体验与验证，不是协议。

---

## 2. 四个项目是什么

| 项目 | 性质 | 产物 | 对 khy-os 的价值 |
|---|---|---|---|
| **android-agent-kit**（= Android-will-better 的新版快照：10-31 vs 10-28，61 个共同文件有实质差异，新版补 `QUICKSTART.md`、`docs/AUDIT.md`、16 份 `README.en.md`） | 桌面侧 Python/JS 库套件 + 取证方法论文档 | Python 包（源码形态，无 wheel）+ 零依赖 JS 实现 + `uidref/http_api.py`（`:8770`） | **补 Android GUI 缺口的主力**；方法论可反哺桌面 CUA |
| **amoo-dsh / phone-dsh（hiao）** | 手机上的自管 agent 运行时（v2.8，72 工具），含治理管线 | `hiao2.apk`（约 197MB，含内嵌引擎） | **带治理的执行层**：审批、租约、审计链、MCP、任务委托 |
| **amoo-bridge-lite** | StepBridge 对外分发精简版（34 工具，点按/滑动/截图返回 `NOT_YET`） | `stepbridge-lite-2.3-lite.4.apk` | 协议参考；khy-os PhoneBridge 已覆盖同族能力，增量小 |
| **android-dsh** | 官方 deepseek-harness 引擎的 Android 宿主（已冻结为参照） | Gradle APK（`runtime.zip` 不进 git） | 不推荐接入（内部 RPC 形状随版本漂移） |

### 2.1 android-agent-kit 子模块（按四层结构）

**感知与引用层**

| 模块 | 输入 → 输出 | 要点 |
|---|---|---|
| `uidref` | uiautomator dump XML → 紧凑 digest + 稳定 ref（`e14`） | 16 真机界面 276KB→8.6KB（32.3x），可交互召回 100%；ref 过期抛 `StaleRefError`；唯一 HTTP API `:8770`（`/snapshot` `/resolve` `/tap`） |
| `scrollkey` | Snapshot → 跨滚动稳定键（`rid:/lbl:/anon:`） | 真机实测：滚动中 83% 共有行 ref 换手、键 0 冲突 |
| `fieldstate` | dump 节点/无障碍字典 → 输入框四判定 | 核心发现：`text==""` 判空是错的（hint 会伪装成 text） |
| `imespec` | XML + 窗口 JSON → 每元素 reachable/遮挡判定 | 真机 38.5% 可点元素被键盘压住；拿不到键盘信息报 `unknown` 不猜 |
| `blindspot` | XML + windows JSON + PNG → 幻影可点列表 | 「XML 说可点但被键盘盖住」；点幻影会把字符写进输入框 |

**坐标契约层**

| 模块 | 输入 → 输出 | 要点 |
|---|---|---|
| `screenpoint` | 坐标系 + 点 + 必填 `fit` → 设备像素 | 原则「反算不得委托给模型」；仅 stretch 经 648,000 像素真机逐点验证 |
| `pointparse` | 模型脏输出 → `ParsedPoint` | 支持 10+ 格式；拒答抛 `NoPointFound`、歧义抛 `Ambiguity`、空间只给线索 |
| `e2e` | 端到端演示 | 截图→模型视图→脏输出→解析→反算→真点→校验 |

**动作与变化层**

| 模块 | 输入 → 输出 | 要点 |
|---|---|---|
| `textin` | 取证报告（非可 import 库） | `adb shell input text` 19 类只 4 类干净落地；**反引号会被设备侧 shell 执行 = 注入面**；推荐 `ACTION_SET_TEXT`（19/19）；附参考 APK |
| `swipefind` | 坐标四元组 + IME rect + 观测 → 手势有效性 | 键盘区起滑会被吸收并写入文本；有效距离非单调 |
| `screendiff` | 两份 Snapshot → ChangeSet | `effect_of(ref)` 回答「我点的那个起作用了吗」；`is_stuck()` 止损；`is_loading()` |
| `crosstrack` | 两个 Snapshot → 跨页信任分级 | 只认身份 tier、绝不几何回退；跨页 100% 假匹配实证 |

**证据方法论层（零设备依赖）**

| 模块 | 作用 |
|---|---|
| `claimcheck` | 声明分级 V0 假设 / V1 同状态复现 / V2 跨状态 / V3 独立通道 / V4 已推翻 |
| `claimaudit` | 分级跑遍全部资产，抓等级虚高（曾抓到 11/16 写高） |
| `capturetrap` | uiautomator dump 抓取层四陷阱 + 正确抓取范式 |

### 2.2 amoo-dsh / phone-dsh（hiao）对外三张面

| 面 | 接入点 | 能力 |
|---|---|---|
| HTTP 桥 | `adb forward tcp:18998 tcp:8898` → `http://127.0.0.1:18998`，Bearer 配对令牌（真源 `/sdcard/hiao/token.txt`） | `POST /call`（72 工具）、`GET /events` SSE、`GET /approvals` + `POST /approve`、`GET /audit?n=`、`POST /mcp`（无状态 JSON-RPC 2.0，`tools/list`/`tools/call`） |
| 文件信箱 | `/sdcard/hiao/cmd_<id>.json` → `result_<id>.json` | 无 /sdcard 权限时 `run-as` 兜底 |
| MCP | `POST /mcp` | 可直接作为 MCP 服务端被 khy-os 消费 |

工具面含无障碍 UI 8 项（`ui_dump/ui_tap/ui_swipe/ui_click/ui_back/ui_home/ui_recents/shot`）
与 `agent_task`（整任务委托，同步/异步）。治理语义：medium 级（clipboard/exec/ui_* 等）
**阻塞等人在审批卡放行**（socket 600s，超时=拒绝）；high 级还需有效租约，无租约直接
`verdict:"deny"`。无人值守自动化需 `allowSession:true` 或预签租约。

### 2.3 命名澄清

- **amoo** = STEPX Neo 设备内置智能体助手（Step AOS 生态），闭源商业产品。
- **amoo-bridge-lite** = 给 amoo 体系提供「手」的轻量能力桥（刻意收敛到只读 UI）。
- **amoo-dsh / hiao** = 给 amoo 体系提供「脑 + 手」的自管 agent 运行时，兼容 amoobridge 协议。
- **desktop agentbus**（本仓）= 桌面主进程经 adb forward 直连手机 Amoo 特权服务的车道，
  协议 v3（4 字节大端长度 + JSON 信封，`chat.send/abort/history`、`sessions.reset`）。
- **内核态 AgentBus**（`runtime/boot/kernel/src/agentbus.c`，COM2 + COBS）与本主题无关。

---

## 3. khy-os 现状与缺口

| 缺口 | 现状证据 |
|---|---|
| **Android GUI 能力缺位** | 手机 APK lite 无无障碍/截图；`runtime/node/backend/src/tools/AmooBridgeTool/index.js` 只有散落的 adb 原语（`uiautomator dump`/`input tap`），未封装成 agent 工具；`PhoneBridgeTool` 当前约 32 工具无 GUI 项 |
| agentbus 车道全靠 env，UI 零配置 | `apps/khyos-desktop/src/main/agentbus/agentbusProtocol.ts:76-91` 只有 `KHY_AGENTBUS_*`；`AgentbusSection.tsx` 无串号输入框 |
| agentbus 结果恒标「未验证」 | `apps/khyos-desktop/src/main/agentbus/index.ts` 结果带 `unverified: true`，无验证手段 |
| agentbus 等待期进度不走秒 | `works/record/ai/audit-khy-os.md:1208`（`pullResult` 只在事件/挂载触发） |
| 桌面 CUA 有 verify 相位但无具体算法 | `runtime/node/backend/src/tools/ComputerUseTool` + `services/domain/desktop/computerUse`（observe→think→act→verify，最多 30 轮） |
| 浏览器未 agent 化 | `renderer/components/browser/BrowserPane.tsx` 是给人用的；无 CDP / `webContents.debugger` 接线 |

桌面 GUI 基础本身完整：`runtime/node/backend/src/services/domain/desktop/desktopControl/`
含 screenCapture / inputController / windowController / formFiller / uiInspector /
a11yTreeProvider / workflowRecorder / voiceBridge，全部经 `safetyGate.js` 授权
（`KHY_DESKTOP_CONTROL` 默认 off；`ask` 会话首次审批、`strict` 每次审批；
`KHY_DESKTOP_MAX_ACTUATIONS` 默认 500 熔断）。缺的是「点得准、点完能验证」的算法层。

---

## 4. 集成方案（按优先级）

### P0 — 用 android-agent-kit 补 Android GUI（不动手机 APK，纯桌面侧）

照搬 kit 的 e2e 闭环，新建 agent 工具 `AndroidUi`：

```
adb exec-out uiautomator dump
  → uidref digest（276KB→8.6KB，省 97% 上下文）
  → 模型选 ref（e14 这类稳定引用，不选坐标）
  → imespec / blindspot 预检（键盘遮挡？幻影可点？）
  → screenpoint 反算像素
  → adb input tap
  → screendiff effect_of 验证（点了到底有没有用；is_stuck 止损）
```

落地要点：

- 优先内嵌 `uidref/js`、`screendiff/js`（零依赖），避免引入 Python 运行时；
  screenpoint/pointparse 若暂不移植，先跑 `uidref/http_api.py`（本机回环 `:8770`）当 sidecar。
- 工具落点候选：`runtime/node/backend/src/tools/AndroidUiTool/`，门控沿用既有风格
  （如 `KHY_ANDROID_UI_TOOL`），写操作默认回计划、需 `confirm`。
- 端口与 adb 路径走 `constants/serviceDefaults.js` + env，不硬编码（规则 1）。
- vendored 代码按 `[DESIGN-SOURCING-001]` 登记借鉴来源，放 `vendor/` 类目录，
  不进软著登记材料候选（`PROCESS-010` C-X3）。

### P1 — hiao `:8898` 作为第二手机目标（带治理的执行层）

`runtime/node/backend/src/services/domain/network/phone/phoneBridgeConfig.js` 现在只有
StepBridge 一个 profile。新增 hiao profile：

- `adb forward tcp:18998 tcp:8898`（具体端口走 serviceDefaults/env）；
- Bearer 令牌来自手机 `/sdcard/hiao/token.txt`；
- 获得 ui_tap / ui_swipe / shot 的**审批 + 租约 + 审计链**能力，替代裸 adb 点屏；
- `agent_task` 可把整任务委托给手机端 agent；
- `POST /mcp` 可让 khy-os 把手机当 MCP 服务端消费。

接入前先确认与 `scripts/ci/check-no-shizuku-dependency.js` 无冲突（hiao 不用 Shizuku，
预期干净），并按 `DESIGN-ARCH-211/212` 的授权 broker 口径评估是否需登记。

### P1 — agentbus 车道体验补齐

1. 设置页加串号选择 + 状态展示：复用 `agentbusTransport.ts:455-486` 已有的设备表只读
   解析，保持「不替用户挑设备」的既有约定；
2. 修 `audit-khy-os.md:1208` 的走秒缺陷：round 等待循环内补 phase 广播；
3. 用 kit 的 `claimcheck` 给「未验证」结果分级：手机回的声明先 `classify()`，
   V1（同状态复现）以上才去掉 `unverified` 标——与本仓规则 5「修复先复现」同构。

### P2 — kit 方法论反哺桌面 CUA

- `screendiff.effect_of` / `is_stuck` → 给 `computerUseAgent` 的 verify 相位装具体算法，
  在 30 轮上限之外再加止损；
- `blindspot` 的「无障碍树说可点但被盖住=幻影」→ 桌面侧 `uiInspector` +
  `a11yTreeProvider` 与截图交叉验证；
- `pointparse` → 加固模型指点输出的解析（拒答/歧义分离）。

---

## 5. 安全要点

1. **`adb shell input text` 是注入面**：kit 的 `textin` 实证反引号会被设备侧 shell 执行。
   khy-os 封装 Android 文本输入必须走 `ACTION_SET_TEXT` 路径或 base64 转义，
   禁止直接拼接 `input text`。
2. **hiao 的 medium 级操作会阻塞等人审批**（600s 超时=拒绝）：无人值守场景必须显式
   设计 `allowSession` 或预签租约，不能把「审批超时」误报成「设备故障」。
3. **点屏前预检不是可选优化**：键盘遮挡（imespec）与幻影可点（blindspot）在真机上
   比例很高（38.5% / 若干），跳过预检会把字符写进错误控件。
4. **不逆向 amoo / StepOS**：只通过公开协议面（agentbus、amoobridge、MCP）接入。

## 6. 合规与工程约束

| 约束 | 内容 |
|---|---|
| 许可证 | android-agent-kit / amoo-dsh / amoo-bridge-lite 均 Apache-2.0；vendored 保留 LICENSE/NOTICE，修改文件标注改动（bridge-lite 的 NOTICE 明确要求） |
| 借鉴登记 | 按 `[DESIGN-SOURCING-001]` 登记「借鉴什么 / 怎么借鉴 / 谁实现」 |
| 软著 | 第三方代码不得进登记材料候选（`PROCESS-010` C-X3），vendored 代码隔离在 `vendor/` 类目录 |
| 零硬编码 | 新端口（8898/18998/8770）与 adb 路径走 `serviceDefaults.js` + env（规则 1） |
| 通道选择 | GUI 操作仍服从五通道矩阵（`[DESIGN-ARCH-071]`）：CH-5 是最后手段，结构化通道优先 |
| 不新增无谓机制 | 若引入审批/租约类拦截机制，按 `PROCESS-008` 走 S1 起四阶段 |

## 7. 待决问题

1. `uidref/js` / `screendiff/js` 的实际代码量与依赖面清点（决定内嵌还是 sidecar）。
2. hiao profile 的令牌管理落点：复用 `phoneBridgeCredential`，还是新开凭据面。
3. `AndroidUiTool` 的风险等级与审批档（是否归入 `KHY_DESKTOP_CONTROL` 同一总闸，
   还是独立门控）。
4. 是否同步把 `uidref http_api.py` 作为可选 sidecar 打包（涉及依赖来源规则 11，
   只能走官方源安装，不可引入镜像）。

## 8. 附录：关键文件索引

**归档侧**

- `D:\Portable\amootool-extract\android-agent-kit-main\android-agent-kit-main\README.md`（四层结构）、`docs\AUDIT.md`、`uidref\http_api.py`、`uidref\js\`、`screendiff\js\`
- `D:\Portable\amootool-extract\amoo-dsh-main\amoo-dsh-main\phone-dsh\docs\AMOO-INTEGRATION.md`（三张面）、`phone-dsh\specs\CONTRACT.md`、`docs\USER-GUIDE.md`
- `D:\Portable\amootool-extract\amoo-bridge-lite-main\amoo-bridge-lite-main\README.md`、`ROADMAP.md`
- `D:\Portable\amootool-extract\amoo-dsh-main\amoo-dsh-main\docs\ARCHITECTURE.md`（内部 RPC 形状，仅参考）

**本仓侧**

- `apps/khyos-desktop/src/main/agentbus/`（transport / protocol / round / client）
- `apps/khyos-desktop/src/main/agentbusBridge.ts`、`src/preload/agentbus.ts`
- `apps/khyos-desktop/src/renderer/components/amoon/AgentbusSection.tsx`、`AmooSecretaryPane.tsx`
- `runtime/node/backend/src/tools/AmooBridgeTool/index.js`、`PhoneBridgeTool/index.js`
- `runtime/node/backend/src/services/domain/network/phone/phoneBridgeConfig.js`
- `runtime/node/backend/src/services/domain/desktop/desktopControl/safetyGate.js`
- `runtime/node/backend/src/tools/ComputerUseTool/`、`services/domain/desktop/computerUse/`
- `docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-200] 对标 stepx 的 amoo 深度配合.md`
- `works/record/ai/audit-khy-os.md:1208`
