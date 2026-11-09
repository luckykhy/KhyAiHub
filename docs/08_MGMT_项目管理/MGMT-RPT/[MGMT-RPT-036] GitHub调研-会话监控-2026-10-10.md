# GitHub 调研 — 会话健康监控板块 — 2026-10-10

> 每日板块轮转调研（索引 7/12，首次进入本板块）。

## 调研对象

khy-os 会话健康监控板块现状（三层分工 + 配套探针）：

| 组件 | 位置 | 机制 |
|---|---|---|
| 交互会话挂起观察器 | `runtime/node/backend/src/services/sessionWatchdog.js` | 双类挂起判定（异步静默 = 「有活在途且无输出」才说话；同步阻塞 = 采样节拍漂移事后归因 `[DESIGN-ARCH-182]` CPU 采样三分：sync/external/unknown）；**绝不杀进程**（规则 3）；quiet 通知策略（成串合并/单次超阈值才说话）；`onHang` 全量观察通道 + `stats()` 账本；幂等锁防 TUI→REPL 双装 |
| daemon 心跳看门狗 | `runtime/node/backend/src/services/watchdogService.js` | 10s 心跳（`KHY_WATCHDOG_INTERVAL`），3 连败触发重启；指数退避 5s→60s；**5 次连续失败即放弃**（`_abandonedAt` 置位，`_tick`/`triggerRecovery` 短路）；每次动作写 healAudit（JSONL，10MB 旋转×3） |
| companion 巡检脊柱 | `runtime/node/backend/src/services/heartbeatService.js` | 声明式清单巡检：静默默认、24h 去重、**只提醒不执行**（审批旁路不可能）；events.json 持久 |
| 配套探针 | `resourceGuard.js`（活动操作守卫）/ `stallAttribution.js`（阻塞归因）/ `heartbeatCooldown.js`（意图矩阵）/ `networkHealthMonitor.js` | 被 watchdog 复用的原语 |

**短板（4 条）**：

1. **watchdogService 放弃态永不自愈**：5 次重启失败 → `_abandonedAt` 置位 → `_tick()` 与 `triggerRecovery()` 双双短路，而 `reset()` **全仓零调用方**（本轮 grep 实证）——放弃后没有任何恢复入口。后果：提示语让人「手动 `khy daemon restart`」，人修好后看门狗**仍是放弃态、不再心跳监控**，直到宿主进程整体重启；且监控失效是静默的——不翻 healAudit 无人知晓。
2. **`_tick` 无防重入**：`setInterval` 不等上轮 `_checkHealth()`（异步、可慢）完成就发下一轮，慢 probe 期间多轮 tick 堆叠并发，可同帧触发多次 `_attemptRestart` 会计——重启风暴风险恰是它自己的指数退避要防的形态。
3. **健康判定是单比特**：`_checkHealth` 只返回 `running===true/false`，probe 耗时（半死的唯一可见前兆）不记录——`status()` 答不了「最近一次心跳多慢」。
4. **持久观察面无命令入口**：watchdogService 每次重启/放弃都写 healAudit、heartbeatService 有 events.json，但 `khy health` 体检不含这一族——「最近发生过哪些自愈/放弃事件、巡检提醒了什么」要人手翻 JSONL。

## 对标项目

| 项目 | Star（2026-10-10） | 技术栈 | 相关度 | 链接 |
|---|---|---|---|---|
| kubernetes | ~128k | Go | 高：liveness probe 语义——放弃态在**探测恢复成功时自愈**（probe 成功 → 计数清零），不是「放弃后永不再看」 | https://github.com/kubernetes/kubernetes |
| pm2 | ~43.3k | Node | 高：进程守护 + `pm2 monit` 统一读视图；重启退避 + 放弃后仍持续探测 | https://github.com/Unitech/pm2 |
| healthchecks | ~10.4k | Python/Django | 高：心跳缺失检测——「期望节奏 + 迟到即事件」的诚实告警哲学，与 sessionWatchdog 同源 | https://github.com/healthchecks/healthchecks |
| supervisor | ~9.1k | Python | 中：`startretries`/`startsecs` 放弃语义 + FATAL 态的显式可恢复设计 | https://github.com/Supervisor/supervisor |

**关键发现**：本仓 `sessionWatchdog.js`（活动感知判定 + 归因 + quiet 策略）在工程精细度上**超过**多数开源同类；短板集中在**daemon 看门狗的生命周期收尾**（放弃态无自愈）与**观察面的可读性**（持久证据无入口）——恰好是最老的两条 Linux 守护传统（supervisor 的 FATAL 可恢复、pm2 的 monit 视图）三十年前就答过的两题。

## 值得借鉴的点

### 1. 放弃态探测自愈（k8s liveness probe 模式）（P0）

**对方怎么做**：k8s liveness probe 失败 N 次 → 重启容器，但 **probe 本身永不停止**——容器/进程恢复后下一次 probe 成功即回到正常计数；supervisor 的 FATAL 态也可 `restart` 显式恢复。放弃是**重启动作**的放弃，不是**探测**的放弃。

**khy-os 现状差在哪**：`_abandonedAt` 置位后 `_tick` 直接 return——连健康判定都不做了。daemon 手动修好，看门狗永远不再监控。`reset()` 存在但零调用方。

**改哪些文件**：`runtime/node/backend/src/services/watchdogService.js`——`_tick()` 的放弃短路**从「跳过探测」改为「跳过重启」**：放弃态下照常心跳，一旦 `healthy === true` 清除放弃态（计数/退避归零）并写一条 `watchdog_recovered` healAudit 留痕（诚实：谁恢复的、何时、静默了多久）。

### 2. `_tick` 防重入 + probe 耗时观测（pm2 模式）（P0）

**对方怎么做**：pm2 的 God daemon 对每个探测记录耗时，慢 probe 是「半死」的可见前兆；探测循环防重入（上一轮未完成不发下一轮）。

**khy-os 现状差在哪**：`_tick` 无 in-flight 门闩（异步 `_checkHealth` 可慢，interval 照发）；probe 耗时丢弃。

**改哪些文件**：`watchdogService.js`——`_tick` 加 in-flight 标志（重入直接 return，不堆叠）；`_checkHealth` 记录耗时进 `lastProbeMs`/`lastProbeAt`，`status()` 带出。

### 3. 会话健康读视图 `khy health session`（pm2 monit / healthchecks dashboard 模式）（P0 补位）

**对方怎么做**：pm2 `monit`/`healthchecks` dashboard 把守护事件的持久台账变成一眼可读；本仓已落的 `khy health tui`（MGMT-RPT-031 补记）就是同款接线。

**khy-os 现状差在哪**：heal-audit.jsonl（watchdog 重启/放弃留痕）与 heartbeat events.json 都是持久、跨进程可读的，但没有命令读它们。

**改哪些文件**：`runtime/node/backend/src/cli/handlers/health.js`（`handleHealth` 增 `session` 子命令分派——零棘轮影响，同 `tui` 接线模式）：聚合 healAudit 最近 N 条（watchdog_*/daemon 族）+ heartbeat events 摘要（24h 内通知数）+ watchdogService `status()`，表格/`--json`；`commandSchema.js` 补 `ROUTER_SUB_COMMANDS.health`。

### 4. 心跳「迟到」事件化（healthchecks 模式）（P2，待人工决策）

**对方怎么做**：healthchecks 把「预期节奏未到」本身当事件（不只在失败时说话）。

**khy-os 现状差在哪**：watchdogService 只记失败计数，心跳**变慢但未失败**不产生任何记录。

**为什么是 P2**：把「迟到」当事件需要定「正常节奏基线」，引入误报面（机器休眠、CPU 抢占都会迟到）；sessionWatchdog 的 stallAttribution 已覆盖同族问题（进程被停走）。建议先攒 `lastProbeMs` 样本（P0-2 顺带产出）再议阈值，人工裁决后再动。

## 落地建议（排序）

| # | 行动 | 优先级 | 工作量 |
|---|---|---|---|
| 1 | watchdogService 放弃态探测自愈（healthy→清 abandoned + healAudit 留痕） | P0 | 1 小时 |
| 2 | `_tick` 防重入 + probe 耗时入 status() | P0 | 1 小时 |
| 3 | `khy health session` 子命令（healAudit + heartbeat events 聚合读视图） | P0 | 半天 |
| 4 | 心跳迟到事件化（需基线与误报面裁决） | P2 | 待人工决策 |

## 参考链接

- https://github.com/kubernetes/kubernetes — liveness probe：放弃重启不放弃探测
- https://github.com/Unitech/pm2 — God daemon 探测耗时 + `pm2 monit` 统一读视图
- https://github.com/healthchecks/healthchecks — 心跳缺失检测、迟到即事件
- https://github.com/Supervisor/supervisor — startretries / FATAL 态显式可恢复

## 落地记录

（第 6 步完成后回填）
