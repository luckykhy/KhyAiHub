# `network/amoo` — Amoo 协作层（D2 业务上下文单元）

> 5-3-1 定位：**D2 / network 上下文**的功能单元（[RESEARCH-018] §3 P3、C-4/C-5 判据见
> `docs/10_规范/registry/DOMAIN-DEPS.json`）。生命周期记录在同目录 `khy.module.json`。
>
> 服务对象：**StepX PZ261A（Android 16 / SDK 36）上的手机智能体 Amoo**（包
> `com.stepos.ailauncher`）与 PC 侧 khy-os。两个方向都在这个单元里，主方向是
> 「Amoo 主动来调 khy-os」。

## 三问（规则 9 / `PROCESS-010`）

**谁要？** 人要的是「手机上那个 Amoo 能和 PC 上的 khy-os 互相使唤」，而且两件事
都得可审计：谁发的、发了什么、拿到了什么。调用方有三类——① 人（经 CLI
`khy amoo …` 与工具面 `AmooBridgeTool`，2026-10-21 晚间接入，fanIn=2）；
② Amoo 自己（经 `client/amoo-khy-client.js`，方向反过来）；
③ 只读状态消费者（`runner.collectStatus()`）。

**为什么在这里而不是别处？** 这块业务的知识是「这台手机 + 这个桥 + 这个助手」的
实测事实，全部集中在一处才有意义：

| 实测事实（2026-10-21） | 后果 |
| --- | --- |
| StepBridge 装在 `com.stepx.amoobridge`，真实端口 **8896**（不是 8898），绑定 0.0.0.0 | 端口只在本单元出现一次，env 可覆盖 |
| 令牌与信箱在 `/sdcard/bridge-amoobridge`（不是 `/sdcard/bridge`） | 路径同上 |
| **lite 版没有无障碍服务、没有任何 UI 工具**（`ui_dump`/`ui_tap`/`shot_b64` 全部 `unknown tool`，源码 manifest 无 `BIND_ACCESSIBILITY_SERVICE`） | 读屏与点击**只能走 PC 侧 adb**（`uiautomator dump` / `input tap` / `input keyevent`，shell uid 可用且已验证） |
| Amoo 聊天组件 `com.stepos.ailauncher/.chat.activity.ChatMainActivity`，**无 LAUNCHER 类别** | 只能按组件+动作打开，`monkey`/launcher intent 无效 |
| `adb shell input text` 不认 CJK，`cmd clipboard` 未实现，无 ADBIME | **中文只能走桥 clipboard + `keyevent 279`（粘贴键）**，已验证可粘贴 |
| 空输入框的 `text` 是**提示语**（待机 `发消息或按住说话`，聚焦 `发消息`） | 「输入框空不空」不能看字数，要看是否含载荷 |
| **空会话时 `chat_list` 铺满整个内容区**（实测 `[0,196][1200,2660]`），输入框在几何上落在它里面 | 抽聊天文本必须按 resource-id 排除输入框/发送按钮，否则提示语会被当成一条聊天气泡 |
| 输入框坐标随软键盘上移约 1300px，发送按钮只在有文本时出现 | 所有点击坐标**从当次 dump 现算**，不记忆 |
| **一台手机会在 `adb devices` 里出现两条记录**（`192.168.2.46:33743` 与 mDNS/TLS 的 `adb-<序列号>._adb-tls-connect._tcp`） | 除 `connect`/`devices` 外**每条命令都必须带 `-s <serial>`**，否则报 `more than one device/emulator`（`buildRecoverBridgeArgv` 曾在这里漏了 serial，真机一跑就暴露） |
| 桥服务 `am force-stop` 后不会自恢复；`am start -n .../.MainActivity` 被 AMS 过期 top-most 记录吞掉；`am start-service` 因 exported=false 被拒 | 唯一恢复路是 `monkey -p <pkg> -c android.intent.category.LAUNCHER 1`（进程活着但 HTTP 线程卡死时同样有效，已实测） |
| 33743 是无线调试 **connect** 端口，不是 pairing 端口 | `adb pair` 在本单元**不可表示** |
| 桥 HTTP 每连接一线程，但一次卡死的 `clipboard` 调用曾把整个服务冻住 | 卡死按「桥需要重启」处理，且请求体必须走文件/UTF-8，不能经 shell 重引号 |

放 D2 而不是 D3：这是「这一台手机这一个助手」的业务上下文，不是被 30 个模块复用
的底座。真正的共享件（`utils/envFlagByName`、`utils/dataHome`）在 D3，本单元按
允许方向取用。

**怎么验？** 三层，全部命令可复跑：

1. **语法**：`node --check` 逐个文件（12 个源文件）。
2. **单元内共置 node:test**：12 个源文件各有同名同目录测试，共 **169 例**：
   ```bash
   cd runtime/node/backend
   node --test src/services/domain/network/amoo/*.test.js \
              src/services/domain/network/amoo/client/*.test.js
   ```
   实测 `# tests 169 / # pass 169 / # fail 0`。隔离方式：`HOME`/`USERPROFILE`/
   `KHY_DATA_HOME`/`XDG_CONFIG_HOME` 钉进 `mkdtemp`；`child_process.spawn` 在
   require 之前换成 argv 路由器（`pair` 直接判失败）；桥的 HTTP 端口用**真实
   loopback 临时服务器**（ephemeral port）；provider 测试的 runner / liveness /
   时钟全注入假件。不打真手机、不发真消息。
3. **真机只读联验**（2026-10-21，`KHY_AMOO_ADB_PATH` 指向本机 platform-tools）：
   `khy amoo status` 回报 `设备已连接 / forward 已建 / 桥在线 22 工具 / 令牌 5500…8d30 /
   当前界面 18 节点`；`khy amoo plan <文本>` 渲染出 10 步下发计划且**一条 adb 都没发**。
   **全程未向 Amoo 发送任何消息**（`khy amoo send` 需人显式 `--confirm`，属用户的手机）。
3. **守卫**：`node scripts/ci/check-repo-layout.js`（functional-unit / entry-buffer），
   `node scripts/ci/check-agent-rules.js <本目录>`（RUNTIME-001 零硬编码端点/绝对
   路径、no-opaque-status、no-hard-timeout-kill、no-unbounded-loop）。

## 契约（改动前必读）

### 目录与角色

```
amoo/
├── amooBridgeConfig.js     纯叶子：所有端口/路径/超时的 env 解析 + 来源记账
├── amooBridgePolicy.js     纯叶子：桥工具允许清单、参数校验、confirm 门、adb argv 构造器
├── amooUiSnapshot.js       纯叶子：uiautomator XML 解析、坐标现算、回复抽取与稳定判据
├── amooDispatchPlan.js     纯叶子：下发步骤序、轮询退避、停止条件、中文渲染（含 stopReason 映射）
├── amooBridgeClient.js     薄 IO：唯一 spawn/开 socket 的文件（adb + 桥 HTTP + 令牌）
├── amooMailbox.js          薄 IO：文件信箱兜底通道
├── amooDispatchRunner.js   薄 IO：一次「任务进、答复出」的编排（可选 onStep/onPoll 进度钩子）
├── amooCliPlan.js          纯叶子：`khy amoo` 的 argv 解析与中文文案
├── amooPanelViewModel.js   纯叶子：collectStatus 快照 + dispatch 结果 → 面板行模型（固定 7 行）
├── amooStatusProvider.js   薄 IO：状态 TTL 缓存供数器（单飞/完成时刻起算/deadline/忙位停读屏）
├── index.js                星形装配 + 测试复位（provider/视图模型只导出引用，不建单例）
├── client/
│   └── amooKhyClient.js    手机侧可执行资产（单文件零依赖，Amoo 工作区里跑）
└── prompts/
    └── amooPrompts.md      中文提示词包 K0–K8 + 交接记忆模板 + 连通速查
```

**新逻辑一律进纯叶子，不要往 IO shell 里加判断。** 判据（argv、参数校验、风险档、
文案）必须能在**不接手机**的情况下断言。

### 面板供数路径（视图模型 + provider）

面板（CC TUI 的 `Cc*` 组件）**不直接调 collectStatus()**，链路是：

```
useAmooStatus（hook，轮询，间隔唯一真源 utils/ccTimers 的 TIMING）
   └─ AmooStatusProvider（amooStatusProvider.js，唯一碰 IO 的外壳）
        ├─ runner.collectStatus()         全量快照（实测 3.1s ~ 28s）
        ├─ liveness.probe()               忙位期间只读 status.json 心跳（~180ms）
        └─ buildAmooPanelModel()          纯叶子，快照 + 结果 → 固定 7 行 + dispatch 段
```

四条从实测逼出来的纪律（缺一条就会出事）：**单飞**（并发轮询会叠成真实 adb.exe
子进程堆积）、**TTL 从完成时刻起算**（28s 的坏样本会让「发起时刻起算」永久排队）、
**outer deadline + 序号判废**（deadline 杀不掉已 spawn 的 adb，晚到的结果不许覆盖
新快照）、**忙位停读屏**（uiautomator dump 是设备级争用资源，面板的 dump 和 dispatch
自己的 dump 同时跑会把成功的下发伪造成 `screen_unreadable`）。失败语义：一次
collectStatus 失败不抛不清空，返回上一份好快照 + 陈旧徽章。

**当前状态**：provider 与视图模型已落地并有共置测试（48 例），但**还没有消费方**——
`src/cli/tui/` 侧的 hook（`useAmooStatus`：轮询 + `TIMING.mcp.interval` 间隔 +
KHY_CC_TUI 门控）与 `Cc*` 面板是下一批的事，所以 fanIn 仍记 2。dispatch 的实时进度
由 `dispatchTask({ onStep, onPoll })` 喂给 provider 的 `noteStep` / `notePoll` /
`noteDispatchResult`（三个都零 IO，只入队重画）。

### D1 接入点（2026-10-21 晚间）

| 消费方 | 形态 | 入口 |
| --- | --- | --- |
| `src/cli/handlers/amoo.js` | `khy amoo <status\|plan\|send\|client\|prompts\|help>` | 经 index.js 单点；解析/文案在 amooCliPlan.js |
| `src/tools/AmooBridgeTool/index.js` | AI 工具 `AmooBridge`（risk high、shouldDefer） | 经 index.js 单点；门控读 amooBridgeConfig 的 gates |

`src/cli/**` 是 D1 root 且 `commandAutoRegistry` 只扫 `handlers/` 下的**扁平**
`.js`，所以这两个 handler 无法像本单元一样带 `khy.module.json`——
`check-repo-layout.js` 的 entry-buffer 因此各记一条 manifest-missing（基线本就超限，
见该守卫的 remaining reds）。

### 安全边界

- **执行闸门**：`dispatchTask({ confirm: true })` 才真的动手机；缺 confirm 只返回
  计划（`plan` + `planText`），一条 adb 都不发。总闸 `KHY_AMOO_BRIDGE_ENABLED`
  （默认开）、信箱闸 `KHY_AMOO_MAILBOX_ENABLED`（默认开）。
- **`exec` / `rm` 需要 `confirm: true`**，否则只回计划（同 DeviceAppsTool 契约）。
- **令牌是秘密**：只在 `readToken()` 的返回值里出现一次，永不进日志、状态行、
  结果体；对外一律 `maskToken()`（`5500…8d30`）。测试对每条返回路径断言不含原文。
- **绝不 `adb pair`**：argv 构造器只产出 `connect`；测试对每次 spawn 断言无 `pair`。
- **子进程只用 argv 数组**，永不拼 shell 字符串；杀进程走 `safeKill`
  （`src/tools/platformUtils`，Windows 上 `taskkill /T /F`）。
- **SSRF 卫兵不适用**：`services/urlSafety.js` 按设计拒绝回环/私网字面量，而本单元
  打的正是 `adb forward` 出来的回环地址——刻意不走那条路，理由记在
  `amooBridgeClient.js` 文件头。

### 已知边界（不是缺陷，是事实）

- **lite 桥没有任何 UI 工具**：本单元不提供、也不承诺 UI 自动化。读屏/点击走 PC 侧
  adb；要真正的 `ui_dump`/`shot_b64` 需要 2.x 完整版 APK（README 自述「2.0 以后的
  还没有压测完」），由人提供后再议。
- **方向 2（PC 驱动 Amoo）天生不能无人值守**：Amoo 必须在前台，平台不允许助手打开
  侧载应用（桥服务死了只能用户手点）。日常走方向 1。
- **`exec` 的 timeout 基本无效**（先读 stdout 到 EOF 才进退出轮询），且一个卡死的
  exec 会冻结整个文件信箱——所以优先 HTTP `/call`，信箱只作兜底。
- **fanIn=2**：两个 D1 消费方（`cli/handlers/amoo.js`、`src/tools/AmooBridgeTool/index.js`）
  都经 index.js 单点进入，未形成第二条装配路径。行为契约尚未经真实使用期检验，
  所以单元仍记 `staged`。
- **`src/tools/**` 不在 DOMAIN-DEPS 任何 roots 里**：`safeKill` 这一条出边守卫
  看不见（remote 单元已第三次撞上同一登记盲区）。登记缺口属人的裁决，本清单不
  自抬 `mayDependOn`。

## 命令行面（`khy amoo`）

```bash
node runtime/node/backend/bin/khy.js amoo status              # adb/转发/桥/令牌/当前界面
node runtime/node/backend/bin/khy.js amoo plan <任务文本>      # 只出计划，一条 adb 都不发
node runtime/node/backend/bin/khy.js amoo send <任务文本> --confirm   # 真的输入并发送（需确认）
node runtime/node/backend/bin/khy.js amoo client help         # 转发给手机侧客户端
node runtime/node/backend/bin/khy.js amoo prompts             # 提示词包位置
```

`send` 的 confirm 门在 `amooDispatchRunner.dispatchTask` 里，命令行只是把它透传；
`--help` 会被 `bin/khy.js` 的快速路径变成命令卡片（这是全仓统一行为），所以手机侧
客户端的用法走 `khy amoo client help`。

## 手机侧资产的送达

`client/amooKhyClient.js` 是给 Amoo 的单文件零依赖 CLI（Node 22+）。三条送达路，
优先顺序：

1. **`adb push`（首次，首选）**：推到 `/sdcard/Download/`，用设备侧 `sha256sum`
   核对字节数与 SHA-256，再从 Amoo 附件入口选文件（附件会原样落盘）。
2. **附件（日常更新）**：复制成 `amoo-khy-client.js.txt`（手机文件选择器不显示
   `.js`），经微信/数据线送到手机 Download，Amoo 附件入口选文件。**必须比对
   SHA-256**，不一致立即回到 1。
3. **桥 `write` / 文件信箱**：桥装好并授权后，PC 可用桥把脚本推到
   `/sdcard/Download/`；服务死时改走 `cmd_<id>.json` 信箱。

提示词（K0–K8）、交接记忆模板、连通速查都在 `prompts/amooPrompts.md`。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `KHY_AMOO_ADB_PATH` | 走 PATH 找 `adb` | 找不到时报「请设置本变量」，不硬编码任何盘符 |
| `KHY_AMOO_DEVICE_SERIAL` | `192.168.2.46:33743` | 设备序列号（connect 形式） |
| `KHY_AMOO_CONNECT_PORT` | `33743` | `adb connect` 用的端口 |
| `KHY_AMOO_BRIDGE_PORT` | `8896` | 桥真实 HTTP 端口 |
| `KHY_AMOO_BRIDGE_ALIAS_PORT` | `8898` | forward 别名端口（兼容按简报写的脚本） |
| `KHY_AMOO_BRIDGE_TRANSPORT` | `forward` | `forward` 走回环，`lan` 直连设备 IP |
| `KHY_AMOO_BRIDGE_HOST` | `127.0.0.1` | forward 模式下的主机 |
| `KHY_AMOO_BRIDGE_DIR` | `/sdcard/bridge-amoobridge` | 令牌 + 信箱目录 |
| `KHY_AMOO_INPUT_HINTS` | `发消息或按住说话,发消息` | 输入框提示语，判空用 |
| `KHY_AMOO_POLL_INTERVAL_MS` / `_MAX_INTERVAL_MS` / `_MAX_ROUNDS` | `3000` / `8000` / `40` | 轮询策略 |
| `KHY_AMOO_REPLY_STABLE_ROUNDS` | `3` | 连续几轮文本不变判定完成 |
| `KHY_AMOO_BRIDGE_ENABLED` / `KHY_AMOO_MAILBOX_ENABLED` | 开 / 开 | 两层闸门 |

---

*最后更新：2026-10-21（首版，随 Amoo 协作层落地）*
