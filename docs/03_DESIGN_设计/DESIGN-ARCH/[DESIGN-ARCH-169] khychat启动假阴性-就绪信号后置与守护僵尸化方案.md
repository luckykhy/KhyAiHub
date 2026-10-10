# [DESIGN-ARCH-169] khychat 启动假阴性 —— 就绪信号后置与守护僵尸化方案

> 状态：已实施（2026-09-30 晚，P1a/P1b/P2/P3 全部落地，见 §9 实施记录） · 范围：`services/backend`（ai-manage-daemon + gatewayManageDaemon + aiManagementServer MCP 段） · 上游依赖：无 · 调研指针：2026-09-30 晚实测（见 §1.1） · 模板合规：照 [DESIGN-ARCH-124] 体例

## 0. 一句话结论

`khy chat`（≡ `khy gateway manage open`）的失败不是「起不来」，而是**结构性假阴性**：CLI 的就绪判据（控制面 + runtime 文件）在 daemon 串行启动链的**最末尾**才产生，而链条各阶段名义上界之和 ≈ 206s，天然越过 CLI 的 180s 预算 —— daemon 随后照样健康，但 CLI 已经报败退出；没人开页面 → daemon 600s 零会话自杀 → 用户重试 → 循环。若 daemon 在更早阶段卡死/挂起，则**永远不会自愈也永远不会自杀**（GC 循环尚未启动），僵尸化占住 9090/3000 毒化下一次启动。

病灶表格：

| # | 病灶 | 位置 | 后果 |
|---|---|---|---|
| 1 | 就绪信号（控制面 bind + runtime 写入）是启动链**最后一步** | `scripts/ai-manage-daemon.js:1083-1094` | CLI 只能在整条链走完后才看到 daemon |
| 2 | 各阶段上界之和 206s > CLI 预算 180s | §1.3 对账 vs `cli/handlers/gatewayManageDaemon.js:36-39` | 即使无任何故障也会假阴性 |
| 3 | GC 自杀循环在 runtime 写入**之后**才启动 | `scripts/ai-manage-daemon.js:1096`（GC 内自杀判定 :851-861） | 卡在 :1088 之前的 daemon 无限存活，占端口毒化后续 run |
| 4 | `startup-timeout` 标签名不副实 | `scripts/ai-manage-daemon.js:852` | 实为「启动宽限内零会话」，误导排障方向 |
| 5 | daemon 日志行无时间戳 | 全文件裸 `console.log` | 多轮时间线只能靠猜（本案排障实测受害） |
| 6 | MCP 自动连接失败无整段墙钟上限 | `services/aiManagementServer.js:3572`（connectAll 内部 30s/server，非整段） | 日志里「连接 deepseek-eyes...」挂 150s+ 无下文，把排障引向假方向 |

## 1. 现状实证

### 1.1 2026-09-30 晚实测时间线（多轮循环，日志 `.khy/logs/ai_manage_daemon.log`）

| 时刻（近似） | 事件 | 证据 |
|---|---|---|
| 21:10:20 | 用户截图 run A：回退独立会话、启动中 | 截图 `screenshot_20260930_211020` |
| 21:26:17 | 用户截图 run B：**「启动 AI 管理会话失败或超时」退出**，但失败信息自带的日志尾巴里 daemon 明明已「Web 后端已就绪 + workflow-worker started」，且 MCP「连接 deepseek-eyes...」已 pending 150s+ 无下文；vite 日志（`ai_frontend_dev.log`）自 21:15:41 后零新行 | 截图 `screenshot_20260930_212617` |
| ~21:30 | 实测 runtime 文件健康、9090/8090/3000 全 LISTENING、`sessions: 0` | `.khy/ai_manage_runtime.json` + netstat |
| 21:39:05 | 该 daemon 因「无活动=603616ms 曾见会话=false」自杀，runtime 随之删除、端口全空 | daemon log 末行 |
| 整晚 | deepseek-eyes 每轮失败（exit 1 / 30s timeout），≥4 个完整「起→灭」周期 | daemon log |

### 1.2 代码事实（file:line 可复核）

| 事实 | 依据 |
|---|---|
| 启动链顺序：web 后端 → API `start()` → workflow-worker → 前端 → **控制面 bind** → **runtime 写入** → **GC 启动** | `scripts/ai-manage-daemon.js:964-1096`（关键 :989/:1005/:1013/:1035/:1083/:1088/:1096） |
| web 后端等待上界 120s（实测冷启 2.6s~45s+） | `:536` `WEB_BACKEND_WAIT_MS = 120_000`，注释 :534 |
| vite 等待上界 30s | `:88` `DEFAULT_FRONTEND_WAIT_MS`，`waitPortOpen :345` |
| 复用探测有界（900ms×(1+20端口)×2探针） | `services/aiFrontendLocator.js:36-37, 277-297` |
| `terminatePid` 有界（3s+4s+1.5s）；`safeKill` 5s 硬界 | `scripts/ai-manage-daemon.js:288-308`、`tools/platformUtils.js:1087-1091`（execSync timeout 5000） |
| CLI 就绪判据 = runtime 文件 + pid 活 + 控制面 `/status` ok，预算 `max(20000, env‖180000)` | `cli/handlers/gatewayManageDaemon.js:36-39, 497-516, 1434` |
| CLI 失败分支打印通用「失败或超时」+ 日志尾 5 行 | `:1436-1461` |
| 预检查遇到 pid 死亡会 reap 前端 + 清 runtime | `:1319-1324`（`_reapManagedFrontend :168-193` 会树杀仍占端口的残留前端） |
| MCP 自动连接在 `_deferredInit` 内、**不阻塞** `start()`（`resolve()` 先行） | `services/aiManagementServer.js:3445-3454`（`resolve(tryPort)` 先于 `_deferredInit()`，且未 await）、await 点 :3572 |
| MCP 配置真源：`.khy/mcp.json` → `{"type":"stdio","command":"python","args":["-m","deepseek_eyes"]}` | 实测读取 |
| `khy chat` ≡ `khy gateway manage open` | `cli/handlers/gatewayManageDaemon.js:1488` 自证 |

### 1.3 预算对账（§0 病灶 2 的算术）

| 阶段 | 名义上界 |
|---|---|
| web 后端（`waitWebBackendHealthy`） | 120.0s |
| 复用探测（最坏：端口有监听但不应答） | ~37.8s |
| vite spawn → 端口等待 | 30.0s |
| `terminatePid`（超时回收路径） | ~8.5s |
| `describePortOwner`（baseBusy 时） | ~9.5s |
| **合计** | **≈205.8s** |
| CLI 预算 | 180.0s |

各阶段单独都有界，**但和已经越界**：只要 web 后端冷启 >30s 或探测路径走了慢分支，假阴性就是必然结果，不需要任何「挂死」。§1.1 的 run B 是实锤样本。

### 1.4 测试基线（2026-09-30 实测，`node --test` 单文件）

| 文件 | 结果 | 性质 |
|---|---|---|
| `tests/aiManageDaemonFrontendReuse.test.js` | 6/6 绿 exit 0 | node:test 风格，**回归锚点** |
| `tests/cli/handlers/gatewayManageDaemonLeaf.test.js` | 4/4 绿 exit 0 | node:test 风格，**回归锚点** |
| `tests/aiManageDaemonControlApi.test.js` / `Gc` / `LogEncoding` / `routes/daemon` / `services/__tests__/aiManageDaemonLifecycle` | 各 1/1 红 exit 1（~400ms 文件级失败） | **存量 jest 风格**（`jest.useFakeTimers`/`beforeAll` 裸全局），node --test 下必红，与本案无关；CI 对它们的容忍度见 §8 |

## 2. 借鉴提案（B-P2 七字段）

本案为**本仓自身缺陷的行为修正**（启动时序 bugfix），零外部借鉴。按 B-P1 豁免体例逐项据实声明：

| 字段 | 值 |
|---|---|
| 1 借鉴对象 | 不适用 —— 无任何上游/外部项目参与本方案，第 1 字段所要求的「项目名 + 版本/commit」不存在 |
| 2 借鉴内容 | 不适用 —— 全部设计来自对本仓 `ai-manage-daemon.js` / `gatewayManageDaemon.js` / `aiManagementServer.js` 现状的反推 |
| 3 解决的问题 | 本仓自身：§0 病灶表六条（khy chat 假阴性、守护僵尸化、标签误导、日志无时间戳） |
| 4 许可证与代码性质 | 不适用 —— 未引入任何外部代码/二进制/资源 |
| 5 借鉴方式 | 不适用 —— 非借鉴类改动 |
| 6 落点与现有实现对比 | 落点均为既有文件（见 §4），属「扩展既有 canonical」：`ai_manage_runtime.json` 真源不新增第二份，`AI_MANAGE_*` env 家族内扩展（同族已有 `AI_MANAGE_READY_TIMEOUT_MS` 等 4 键） |
| 7 验收方式 | 见 §7 |

依据：B-P2 触发前提是「借鉴外部」，其第 1 字段为借鉴对象名；本案无对象可填 ⇒ 整表不适用（先例：[DESIGN-ARCH-149] §2 的据实填法）。不引用任何注册表当豁免凭据。

## 3. 目标形态

### 3.1 daemon 侧：早期就绪信号 + 启动看门狗（P1a）

```
main() 入口（现 :989 之前新增）：
  createControlServer(); await listenControlServer();   // 端口 0 随机，提前绑无副作用
  phase = 'starting';
  writeRuntime({ phase, phaseDetail: 'web-backend(0s)' });   // runtime 从第一步就存在
  启动独立看门狗 timer（非 GC 循环）：
      phase !== 'ready' 且已过 STARTUP_WATCHDOG_MS(默认 300_000) → shutdown('startup-watchdog')

既有串行链每完成一段 → 重写 runtime：
  web 后端就绪   → phaseDetail: 'api(0s)'
  start() 返回   → phaseDetail: 'frontend(0s)'
  前端解析完成   → phase='ready'（现 :1088 的 writeRuntime 保留，追加 phase 字段）
```

- `/status` payload（`buildStatusPayload` :744-767）追加 `phase` / `phaseDetail` —— 与 runtime 文件**同一变量源**，不造第二真源。
- 看门狗是独立 timer，不依赖 GC 循环启动（这正是它存在的意义：覆盖「卡死在 :1088 之前」的僵尸）。
- 上界取 300s > §1.3 最坏 206s；env `AI_MANAGE_STARTUP_WATCHDOG_MS` 挂入既有 `AI_MANAGE_*` 家族，缺省行为不变。

### 3.2 CLI 侧：阶段感知等待（P1b）

```
_waitAiManageRuntimeReady（现 :497-516）改造：
  轮询 runtime：
    文件不存在 或 pid 死 → 立即失败（不再空转剩余预算）
    phase==='starting'   → 每 ~3s 打一行进度：
        i 管理会话启动中: frontend(12s)（已等待 47s/180s）
    phase==='ready' 且 /status ok → 成功
  失败信息带上最后 phaseDetail：
    x 启动 AI 管理会话失败：卡在 frontend 阶段 (最后状态 frontend(29s)，已等待 180s)

预检查（现 :1306-1325）增加 phase 分支：
  pid 活 且 phase==='starting' → 不得 reap、不得 clear（防误杀半启动前端）
  → 打印「检测到启动中的管理会话（frontend(29s)），继续等待」并进入同一等待循环
```

### 3.3 MCP 段：整段墙钟 + 降噪（P2）

- `services/aiManagementServer.js:3568-3593` 的 `await ensureMcpConnected(...)` 外包 `Promise.race` 硬上限 45s；超时打 `[MCP] auto-connect 整段超时(45s)，已放弃本轮（不影响页面可用）`。
- 该调用本就不阻塞就绪（:3453 fire-and-forget），此刀只治「pending 150s+ 无下文」的日志黑洞与 latch 永久滞留。

### 3.4 日志与文案（P3）

- daemon 脚本内所有 `console.log/warn/error` 收敛到一个 `_log()` 包装：`[HH:mm:ss] [ai-manage-daemon] ...`（`aiManagementServer.js` 的 `[MCP]` 两行同包装）。
- `:858` 人类可读行改为：`正在关闭守护进程: 原因=startup-timeout（启动宽限 600s 内无任何会话接入） 无活动=… 阈值=… 曾见会话=…`——**机器 reason key 不动**（jest 存量测试与日志 grep 依赖它），只改人读部分。

## 4. 实施分期（每期独立可回滚）

| 期 | 内容 | 落点 | 回滚方式 |
|---|---|---|---|
| P1a | 早期控制面 + runtime（带 phase）+ 启动看门狗 | `scripts/ai-manage-daemon.js` 单文件 | 删新增段即回原形；runtime 新增字段向后兼容（旧 CLI 读到多余字段无感） |
| P1b | CLI 阶段感知等待 + 预检查 phase 分支 + 失败信息带阶段 | `cli/handlers/gatewayManageDaemon.js` 单文件 | 等待循环回退为现轮询体（旧 daemon 无 phase 字段时按 ready 处理，两版可共存） |
| P2 | MCP 整段 45s 硬墙钟 | `services/aiManagementServer.js` 一处 race 包装 | 删包装 |
| P3 | 时间戳包装 + 人读文案 | `scripts/ai-manage-daemon.js` + `aiManagementServer.js` MCP 两行 | 删包装 |

P1a 与 P1b 顺序不可颠倒：先有 phase 字段，CLI 的 phase 分支才有数据。P2/P3 与 P1 无依赖可并行。

## 5. 诚实边界（刻意不纳入）

| 不做 | 原因 |
|---|---|
| 不修 `deepseek-eyes` 本身（`.khy/mcp.json` 的 `python -m deepseek_eyes`） | 那是用户配置的 MCP server，修它是另一个案子的活；本案只保证它坏了不拖累任何人。是否删除/修该条目由用户单独决定 |
| 不把 CLI 180s 加大 | 治标：等得更久、失败更晚，§1.3 的越界依旧存在 |
| 不做并发 `khy chat` 互斥锁 | P1b 的「starting 会话继续等待」已把重复 run 收敛到同一次启动，锁文件是过度设计 |
| 不动 600s 零会话自杀策略本身 | 策略正确（释放端口）；错的只是标签与无人知晓 daemon 活着这件事 |
| 不重写 5 个存量 jest 风格 daemon 测试 | 存量问题单独立案；本案新测试全部 node:test，不与两套 runner 交叉 |

## 6. 反模式（这条路别走）

| ❌ 别做 | 为什么 |
|---|---|
| 给 `waitPortOpen`/`waitWebBackendHealthy` 各自再放宽 | 单阶段上界放宽会直接推高 §1.3 总和，把假阴性从「可能」变「稳定」；要让用户看见进度，而不是把黑箱等得更久 |
| 在 daemon 里用「启动失败即 process.exit」的早期兜底替代看门狗 | 等于把看门狗的判定交给每个阶段自己——卡死恰恰发生在「阶段自己不知道自己卡了」的地方；看门狗必须独立于阶段推进 |
| 把 phase 状态存进独立文件或让 `/status` 与 runtime 各记一份 | 两个真源必然漂移（本仓 `main/index.ts:85-89` 的「一处真源」纪律同源）；phase 只活在 daemon 进程内，经 `writeRuntime` 与 `buildStatusPayload` 同源广播 |
| 新测试用 jest 全局（裸 `describe`/`test`/`expect`） | `services/backend` CI 走 `node --test tests/**/*.test.js`（shell 展开 1288 文件），jest 全局未定义 → 落地即红；§1.4 五个存量红文件就是现成受害者 |
| 往既有 jest 风格文件里追加 node:test 用例 | 一个文件被两套 runner 扫到，双跑双红；要加就另建文件 |
| 把「连接 deepseek-eyes...」这类 pending 行静音 | 静音会吞掉唯一的过程信号；要的是给它墙钟和终结行，不是删它 |

## 7. 验收方式

```bash
# 回归锚点（改动前后数字必须不变）
& $node --test services/backend/tests/aiManageDaemonFrontendReuse.test.js   # 基线 6/6
& $node --test services/backend/tests/cli/handlers/gatewayManageDaemonLeaf.test.js  # 基线 4/4

# 新增（P1a）：node:test 风格，落地即绿
services/backend/tests/aiManageDaemonEarlyReadiness.test.js
#   断言 1：main() 入口（mock 掉各阶段为 pending promise）≤1s 内产生 runtime 文件且 phase='starting'
#   断言 2：watchdog 决策函数——phase='starting' 超 300s → shutdown('startup-watchdog')
#   断言 3：phase='ready' 后看门狗不再触发

# 新增（P1b）：node:test 风格
services/backend/tests/cli/handlers/gatewayManageWaitPhase.test.js
#   断言 4：runtime pid 死 → 立即失败（不消耗预算）
#   断言 5：phase='starting' → 打印进度行、继续轮询
#   断言 6：预检查遇 phase='starting' 且 pid 活 → 不调用 _reapManagedFrontend / _clearAiManageRuntime

# 端到端（人工，一次性）
khy chat            # 观察进度行逐段出现；人为制造 MCP 慢（或拔网）不再出现 180s 黑箱后报败
```

关联门禁：`npm run check:changed`；本案不触碰前端令牌/尺寸门禁。CI 归属：`services/backend` 由 pr-gate/deploy-staging 的 `test:node` 扫描（新测试文件落地即进扫描范围，必须绿）。

## 8. 待核实项

| 项 | 状态 | 说明 |
|---|---|---|
| run B（21:26:17）卡点的精确归位（resolveFrontend 内哪一步吃掉的时间） | **未决，不阻断** | 现场无时间戳（病灶 5），静态证据只能圈定区间（workflow 已打印、vite 零输出）。P3 落地后复现一次即可归位；P1 的阶段进度让这一步从「考古」变成「看进度行」 |
| MCP `connectAll` 内部 30s 超时为何未约束整段墙钟（观测 pending 150s+） | 未决，不阻断 | 30s 上界在 `services/mcp/index.js` 内部；P2 的整段 race 使其不再重要，根因解剖可在 P2 落地后按需跟进 |
| CI 对 §1.4 五个存量 jest 红文件的容忍方式 | 未决，与本案无关 | 2026-09-30 实测单文件 `node --test` 全红；若 CI 全量扫到它们理应红。本案不动它们，仅登记 |
| `AI_MANAGE_STARTUP_WATCHDOG_MS` 是否需要登记 | 已决：无需 | 挂入既有 `AI_MANAGE_*` env 家族（该家族 ≥4 键已在产），非 TUI 门（不撞 `check-tui-gates` 预算棘轮） |

## 9. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-09-30 | 初版。勘误声明：初诊时曾把「MCP await 挡在启动关键路径」列为根因，读 `aiManagementServer.js:3445-3454` 后证伪（`_deferredInit` fire-and-forget，`resolve()` 先行）——根因修正为「就绪信号后置 + 预算越界 + 僵尸无看门狗」三件套 |
| 2026-09-30 | **实施记录**：P1a/P1b/P2/P3 全部落地。落点：`scripts/ai-manage-daemon.js`（早期 `beginStartupPhase()` 控制面绑定 + `phase`/`phaseDetail`/`phaseSince` 随每次 `writeRuntime` 广播 + 独立 300s 看门狗 `_evalStartupWatchdog` + `_log` 时间戳包装 + GC 文案正名）；`cli/handlers/gatewayManageDaemon.js`（`_waitAiManageRuntimeReady` 阶段感知重写 + `_precheckRuntimeAction` 预检查选择器 + `_printAiManageStartupFailure` 失败信息带阶段 + starting 会话收养分支不 reap/不 clear）；`services/aiManagementServer.js`（MCP 自动连接 `Promise.race` 整段 45s 硬墙钟 + 超时终结行 + 进度行时间戳）。与提案的字面偏差（均不改变行为设计）：① daemon 的 `phaseDetail` 存**阶段名**（`web-backend`/`api`/`frontend`），`(Ns)` 秒数由 CLI 依据新增的 `phaseSince` 字段计算——与 §3.2 CLI 渲染 `frontend(12s)` 一致；② `runtime` 新增 `phaseSince` 字段（提案未列，进度秒数所需，向后兼容）；③ §7 断言 6 的测试落在纯决策函数 `_precheckRuntimeAction` 层（handleGatewayManage 级端到端 mock 成本过高，该函数即预检查的分支选择器）；④ 控制面提前绑定后，早期 runtime 写入携带模块加载时刻的 `startupAt`，ready 后照旧重置——GC 行为不变。测试基线：新增 `tests/aiManageDaemonEarlyReadiness.test.js`（4 用例）与 `tests/cli/handlers/gatewayManageWaitPhase.test.js`（4 用例）`node --test` 落地即绿；回归锚点 `aiManageDaemonFrontendReuse` 6/6、`gatewayManageDaemonLeaf` 4/4 保持；三个改动文件 `node --check` 通过。端到端人工验收（`khy chat` 观察进度行）待用户下次实际启动时观察 |
