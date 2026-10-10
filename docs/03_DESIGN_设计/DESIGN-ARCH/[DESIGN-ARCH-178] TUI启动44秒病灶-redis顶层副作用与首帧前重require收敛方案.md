<!-- IMPL-STATUS: done -->
# [DESIGN-ARCH-178] TUI 启动 44 秒病灶：redis 顶层副作用与首帧前重 require 收敛方案

<!-- RULES-REGISTRY: RUNTIME-012 -->
> **隶属**：TUI 设计族（总纲 `[DESIGN-ARCH-122]`）；承接 `[DESIGN-ARCH-140]`（启动卡顿定位，2026-09-23）。
> **状态**：**P0 + P3 已落地**（2026-10-04，见 §9 变更日志）；P1/P2 未接线（P1 经评估判定无可用的首帧信号，见 §9） · **日期**：2026-10-03 · **编号**：[DESIGN-ARCH-178] · **落点目录**：`docs/03_DESIGN_设计/`
> **证据基准**：2026-10-03 本机实测。方法 = 伪造 `isTTY=true` + `Module._load` 全图插桩 +
> `child_process` 全量拦截，跑到 `require('./tui/app.js')` 那一刻停手。所有毫秒数均为实测，非估算。
> **与 140 号的关系**：140 号实测的是 **5.83s**，本提案实测 **44.1s**，差 7.6 倍。140 号的病灶清单
> （E1–E6）**依然全部成立**，但它**漏掉了头号病灶** —— redis。140 号的 P0「首帧前置」在 redis
> 面前只能省下 3.3s（44.1 → 40.8），真正的 33 秒在它视野之外。本提案是 140 号的补充，不是替代。

---

## 0. 一句话

`khy` 启动慢的主因**不是动画排在链尾**（那是 140 号的 E1），而是
**`vendor/shared/src/services/cacheService.js:157` 在模块顶层裸调 `initRedis()`**，
导致任何一次 `require` 都会同步加载整棵 redis 客户端树 —— **实测 20.4 秒 / 542 个模块**；
它被一条自称「非阻断」的启动预检（`replSession.js:328`）在首帧门口触发。
把 redis 改成懒加载，**首帧从 44.1s → 10.9s（-75%）**；再把两个非首帧必需的重 require
挪到首帧之后，**→ 9.2s**。

| 变体（实测，同一机器同一命令） | 首帧 | 模块数 | 增量 |
|---|---|---|---|
| V0 现状 | **44 131ms** | 1523 | — |
| V1 redis 改懒加载 | **10 933ms** | 981 | **−33.2s** |
| V2 ＋ 预检挪出首帧路径 | **10 557ms** | 840 | −0.4s |
| V3 ＋ git 上下文延后 | **9 169ms** | 839 | −1.4s |

---

## 1. 现状实证

### 1.1 完整时间线（`Module._load` 全图插桩，节选关键节点）

从 `require('bin/khy.js')` 到 `require('./tui/app.js')`（ink 即将挂载）共 **75.5s**
（该轮为冷态；V0 复测热态 44.1s，两者都是实测，取值不同因工具链缓存状态不同）。

| 时刻 | Δ | 事件 | 证据 |
|---|---|---|---|
| 135ms | 135 | `chcp.com 65001` | `khy.js` 模块顶层同步 spawn |
| 547ms | 413 | `require winston` 137ms | `src/utils/logger.js` |
| 845ms | 710 | `spawnSync node -e <sqlite 探针>` | `bootstrap/startupSqliteProbe.js:54`（有 1200ms 预算，符合预期） |
| 1564ms | 719 | `require sequelize` 344ms | `config/database.js` |
| 1990ms | 138 | `spawn node server.js` | TUI 模式也起服务进程 |
| 12051ms | **10061** | `cmd /c start http://localhost:3000` | `tools/platformUtils.js:255`（`spawnGuiApp` 通用工具，**调用方待核实**） |
| 20752ms | 8656 | `require replSession` | 顶层 `replSession.js` 图 |
| 19688ms | 6054 | ↳ `require featureCapabilityMap` | `replSession.js` 内部 |
| 21262ms | — | `claude/codex/aider --version` ×3 | `replSession.js:395` prewarm（后台） |
| 25246→35074ms | **~9.8s** | **6 个串行 `git` spawn** | `gitContextService`（见 §1.3） |
| 41507ms | 4068 | `require toolUseLoop` | `replSession.js:422` setImmediate 预热 |
| 47626ms | 6007 | `require tui/ink-components/App` | `replSession.js:472` setImmediate 预热 |
| 49149ms | 5725 | ↳ `require gateway/aiGateway` ← `baseSelfCheckService.js:500` | `replSession.js:328` |
| **69619ms** | **14576** | `require @redis/client/lib/client` **14377ms** | 🔴 **头号病灶** |
| 69844ms | 14660 | `require @redis/client` | |
| 72003→75478ms | ~3.5s | `@redis/bloom` 2159 / `search` 1370 / `json` 871 / `time-series` 819 | |
| **75488ms** | **20410** | `require @khy/shared/services/cacheService` | 🔴 **总计 20.4s / 542 模块** |
| 75534ms | 46 | `require ./tui/app.js` ← **首帧** | |
| — | | `require.cache` = **1524 个模块** | |

### 1.2 病灶 E1：`cacheService.js:157` 顶层副作用

```js
// vendor/shared/src/services/cacheService.js
let redisClient = null;
let useRedis = false;
const memoryCache = new Map();

async function initRedis() {
  const { createClient } = require('redis');   // ← :20 惰性 require 写对了
  ...
}
initRedis();                                      // ← :157 模块顶层裸调 ❌
module.exports = { get, set, del, ... };
```

`:20` 的 `require('redis')` **写在函数体内**（写法正确），但 `:157` 的顶层 `initRedis()`
让这个「惰性 require」在**模块被 require 的瞬间**就同步执行。
`redis` 客户端树（`@redis/client` + bloom/search/json/graph/time-series 五个插件子模块）
共 **542 个模块**，本机实测 **20.4 秒**。

> **关键性质**：`initRedis()` 是 `async`，调用它返回 Promise 不阻塞 —— 但函数体在
> **第一次 await 之前**的所有同步代码（含 `require('redis')`）**立即执行**。
> 也就是说，写了 `async` 反而更容易骗过审查：它看起来像"非阻塞"。

**它没有任何开关。** `GATEWAY_REDIS_HEALTH_ENABLED` / `GATEWAY_REDIS_RATELIMIT_ENABLED`
（`aiGateway.js:2249`/`:2256`）只控制 *用不用* RedisHealthStore，
**管不到 `require('redis')` 本身** —— 那发生在 `require('@khy/shared/services/cacheService')`
的时刻，早于任何 env 判断。

### 1.3 病灶 E2：6 个串行 `git` spawn（~9.8s）

`replSession.js:410-416` 用 `setImmediate` 调 `gitContextService.collectGitContext`，
注释自认「defer it off the mount path」。但**同一个 `setImmediate` 批里的同步
`require` 会互相阻塞**，实测这 6 个 spawn 落在 25.2s–35.1s，**在首帧（75.5s）之前**：

```
git --version                                106ms
git rev-parse --show-toplevel               756ms
git rev-parse --abbrev-ref HEAD              847ms
git symbolic-ref refs/remotes/origin/HEAD  1418ms
git status --short --branch -u              1132ms
git log --oneline -15 --no-decorate        3664ms
git diff --cached --stat                    2012ms
```

`workspaceGitInit.js:59` 的注释已经承认「Windows 进程创建昂贵」并做了减半，
但**采集侧仍是 6 次**。`gitContextService` 有 60s 缓存（`replSession.js:409` 注释），
可缓存**填满之前**的这一次成本无人承担。

### 1.4 病灶 E3：`replSession.js:328` 的「非阻断」预检实际阻断了 5.7s

```js
// replSession.js:325
// **绝不 await、绝不抛** —— 自检失败不得阻塞启动。
function _kickoffGatewayPinStartupCheck({ toTui = false } = {}) {
  try {
    Promise.resolve(require('../services/baseSelfCheckService').checkGatewayPreferredOnce())
```

注释的意图完全正确，但 `require()` 是**同步**的：
`baseSelfCheckService`（`:500`）→ `gateway/aiGateway`（`:2242`）→ `cacheService` → **redis**。
实测这条「非阻断」路径贡献了 **5.7s**（`require gateway/aiGateway` 自身耗时），
并**顺带引爆了 E1 的 20.4s**。调用点在 `:751`，位于 `await inkRuntime.loadInk()` 之后、
`startInkApp(options)`（`:757`）之前 —— **首帧门口**。

### 1.5 病灶 E4：`setImmediate` 不是「不抢首帧」

`:422`（toolUseLoop 4.1s）与 `:472`（App.js 6.0s）都用 `setImmediate` 预热。
注释说「off the hot path」「用户还在打字时」。但 Node 是**单线程**：
`setImmediate` 只是把回调排到下一轮事件循环，**同批回调之间是串行的**，
且它们与 ink 的 `await` 竞争同一个线程。实测离线对比：

| 变体 | 总时长 | 备注 |
|---|---|---|
| E1 只 ink + App（无 toolUseLoop 预热） | 1279ms | |
| E2 ink + setImmediate(toolUseLoop) + App（**现状**） | 1350ms | 预热推迟了 App |
| E3 ink → App → toolUseLoop（顺序） | 1332ms | 首帧就绪 897ms |

结论：预热**确实**在推迟首帧（+71ms，热态；冷态下放大）。它的收益在「用户打字时」，
不在「首帧前」—— 位置放错了。

### 1.6 环境地板（不是病灶，但必须写进账）

| 项 | 实测 |
|---|---|
| `node -e ""` 裸启 | 237–314ms（Defender `RealTimeProtectionEnabled=True`；D: 是 NVMe SSD） |
| `python -c pass` | 693ms |
| `python -m khy_platform --version` 全程 | 397–740ms |
| `import('ink')` 冷 | 954–2500ms（react 67 / react-reconciler 201 / yoga-layout 312 / ink 其余 ~700） |
| V8 compile cache | **已启用**（`enableCompileCache()` → `%TEMP%\node-compile-cache`，`status:1`） |

⇒ 跨进程 + 模块加载的物理地板约 **1.2–1.5s**。**任何方案不可能把 `khy` 做到 1s 以内**，
`bin/khy.js` + python 启动器这一层就已经吃掉 1s。

---

## 2. 借鉴提案（B-P2）

| # | 字段 | 内容 |
|---|---|---|
| 1 | 借鉴对象 | **不适用** —— 本提案零外部借鉴。`enableCompileCache`（`bin/khy.js:71-74`）是 Node 内建，非借鉴。 |
| 2 | 借鉴内容 | **不适用** —— 纯本仓缺陷修复。 |
| 3 | 解决的问题 | 本仓 `cacheService.js:157` 的顶层副作用 + `replSession.js:328/422/472` 三处重 require 排在首帧之前。 |
| 4 | 许可证与代码性质 | **不适用** —— 未引入任何上游代码/二进制/资源。 |
| 5 | 借鉴方式 | **不适用**。 |
| 6 | 落点与现有实现对比 | 落点 = `vendor/shared/src/services/cacheService.js`（已存在）+ `services/backend/src/cli/replSession.js`（已存在）。同类实现搜索：`Grep 'initRedis\|cacheService'` 命中 3 处（`aiGateway.js:2242`、`redisHealthStore.js:329` 注释、cacheService 自身），**无并行实现**；`getRedisClient`（`:146`）是唯一出口，本提案只改初始化时机，**不改出口**。 |
| 7 | 验收方式 | `node .khy/tmp/perf-variants.js`（探针，见 §7）—— V1 变体首帧 ≤ 12s 且模块数 ≤ 1000。 |

**B-P1 豁免判定**：本提案是**行为修正**（把本仓自己的顶层副作用改成惰性 + 调整顺序），
零借鉴 ⇒ B-P2 本就不触发。上表按体例逐字段据实声明「不适用 + 依据」，不留空。

---

## 3. 目标形态

### 3.1 核心不变量：模块加载**不得**有顶层副作用

> **新纪律（**已于 2026-10-04 登记为规则 `RUNTIME-012`「模块顶层副作用收敛」**）**：
> **任何被启动路径 require 的模块，顶层只允许声明与常量初始化；
> 禁止在顶层调用会 `require`/`spawn`/`connect` 的函数。**
> `async` 不豁免 —— 函数体在第一个 `await` 之前是同步执行的。

这条比逐个修更重要：仓库有 1524 个模块进首帧，只有加门才防得住下一个。

**判据已机械化**：`scripts/ci/check-toplevel-side-effects.js`（纯叶子 `scripts/lib/toplevelSideEffectGuard.js`），
门档 `gate=commit` + 强度 `severity=advisory`（S1 观察者，恒 exit 0）。判据是「**同步可达**」而非
「函数体里出现过」—— 包在嵌套函数（箭头 / 函数表达式）里的 `require` 是惰性 thunk，**不判**。
已知且已裁决的命中登记在叶子的 `KNOWN_TOPLEVEL_SIDE_EFFECTS`（必须给出处）；跨文件导入的被调方只盘点不判违规。
判据边界与取舍见 §9 变更日志 2026-10-04 第三行。

### 3.2 `cacheService` 改惰性（E1）

```js
// 现状（:157）                      改后
initRedis();                          // 删除顶层裸调

let _initPromise = null;              // 新增：单次惰性初始化
function _ensureInit() {
  if (!useRedis && !_initPromise) {
    _initPromise = initRedis();       // 真正的 require 在这里，才发生
  }
  return _initPromise;
}
// get/set/del/clearByPrefix/getStats 每个出口先 _ensureInit()（它们本就是 async）
```

**回滚能力**：不需要 env 门（门预算已顶格 227/227，见 §6.1）；
`require('redis')` 移进函数后，**首次真正用到缓存时**才付这 20.4s。
若该功能在 TUI 启动路径上永不被调用，收益全额落袋（实测如此：1523→981 模块）。

**不做**：不给 `initRedis` 加 `setImmediate` 包装 —— 那是把同步成本推到事件循环尾，
首帧仍会撞上（§1.5 已证）。

### 3.3 首帧前的重 require 清单收敛（E2/E3/E4）

| 位置 | 现状 | 改后 | 依据 |
|---|---|---|---|
| `replSession.js:751` `_kickoffGatewayPinStartupCheck` | 首帧前 | 挪到 `startInkApp` **之后**（挂载完成回调里） | §1.4 实测 5.7s；钉选告警本来就靠 `notificationPort` 挂载前缓冲回放，晚 100ms 无感 |
| `replSession.js:422` `require toolUseLoop` | `setImmediate` | 延到首帧就绪之后 | §1.5 实测预热推迟首帧；它的收益是"用户打字时"，首帧后才开始打字 |
| `replSession.js:410` `gitContextService` | `setImmediate` | 保留 `setImmediate`，但改为**首帧就绪后**触发 | §1.3 实测 9.8s |
| `replSession.js:472` `require App.js` | `setImmediate` | **保留不动** | App 是首帧必需品，提前预热是净收益（离线实测 App 自身 214–273ms） |

### 3.4 其余已量化的等待（登记，本期不做）

| 项 | 实测 | 处置 |
|---|---|---|
| `cmd /c start http://localhost:3000` | Δ 10.0s | 服务端自动开浏览器。TUI 模式为何要开浏览器，需另案核实 |
| `spawn node server.js` | 138ms | TUI 模式起独立服务进程，需确认是否必要 |
| `python --version`（`localLLMService`） | Δ 4.0s | `hardwareProfileService` 顶层探测 |
| SQLite 探针 `spawnSync node` | 710ms | 有 1200ms 预算、fail-soft，**保留** |
| `mdEditorRegister` `reg query` | 1.0s | 有 sentinel 快路径 + 4s 超时，**保留** |

---

## 4. 实施分期

| 期 | 内容 | 预期首帧 | 独立可回滚 |
|---|---|---|---|
| **P0** | `cacheService.js` 顶层副作用改惰性（§3.2） | 44.1 → **10.9s** | ✅ 单文件，`git revert` 即回退 · **已落地 2026-10-04（实测 require 模块增量 543 → 1）** |
| **P1** | `_kickoffGatewayPinStartupCheck` 挪到首帧后（§3.3 行 1） | 10.9 → **10.6s** | ✅ 单点移动 |
| **P2** | `toolUseLoop` / `gitContextService` 预热延后（§3.3 行 2-3） | 10.6 → **9.2s** | ✅ 两处 `setImmediate` 换位置 |
| **P3** | 加顶层副作用守卫（§3.1），扫 `src/` + `vendor/shared/src/` | 防回归 | ✅ 新增只读检查器 · **已落地 2026-10-04 → 规则 `RUNTIME-012`**（`scripts/ci/check-toplevel-side-effects.js`，S1 观察者） |

> **P0 单独就有 75% 收益。** 若只做一件事，做 P0。

---

## 5. 诚实边界

| 边界 | 说明 |
|---|---|
| **本提案的 44.1s 与 140 号的 5.83s 差 7.6 倍，未完全解释** | 140 号在 `D:\Portable`（非仓库）跑，本提案在 `D:\Portable\khy-os`。cwd 决定 `gitContextService` 打多少字（340+ porcelain 条目 ⇒ `git log` 单次 3.7s）。但 redis 那 20.4s 与 cwd 无关，**在任意 cwd 都会付**。 |
| **伪造 `isTTY=true` ≠ 真 PTY** | 本机 `node-pty` 未安装，PowerShell 工具 `TERM=dumb` 无真 TTY（实测 `stdout_isTTY` 未定义）。伪造 TTY 后 ink 分支的代码路径全部走到，但 ink 真正的首帧**渲染**（yoga 布局 + 写终端）未被测量。⇒ **本提案的数字是"到达挂载点"，不是"用户看见第一帧"**，后者还需 +（ink 布局 + 首次 output）。 |
| **`reg.exe` 被沙箱黑名单拦下**，探针内以 no-op + 120ms 模拟 | 真实耗时未知。`mdEditorRegister` 那次 1.0s 是模拟值。但它有 sentinel 快路径 + 4s 超时，**量级不改变结论**。 |
| **Redis 从未成功连上** | `useRedis` 恒 false，20.4s 全部白付。这是本机事实；装了 Redis 的机器上这笔钱会变成"有用"，但**依然不该在首帧前付**（首帧不依赖缓存内容）。 |
| **`gitContextService` 的 9.8s 高度依赖仓库状态** | 340+ porcelain 条目 vs 干净仓库差异巨大。干净仓库上应显著低于 9.8s。 |
| **未测冷启动** | 本机工具链已有 compile cache（`status:1`）。真实冷启（换机/清 TEMP）会更慢，倍数未知。 |
| **V2/V3 的收益在噪声边缘** | 10.9→10.6→9.2s。P1 的 0.4s 在单次测量噪声内，只有 V3 的 1.4s 比较确定。**P1/P2 的收益是"不倒退"，不是"明显变快"。** |

---

## 6. 反模式（这条路别走）

1. ❌ **只做 140 号的 P0「首帧前置」就以为解决了**。实测：即使 Ink 首帧提到 `main()` 入口，
   redis 那 20.4s 仍在 `require('./tui/app.js')` 之前的某个同步 `require` 里。
   140 号的 P0 最多省 3.3s。**先治病灶，再谈观感。**

2. ❌ **给 `initRedis` 加 `setImmediate` / `process.nextTick` 包装**。
   §1.5 已证：预热挪到下一轮事件循环 ≠ 不抢首帧（Node 单线程）。
   唯一正确的解是**不 require**。

3. ❌ **加 `KHY_REDIS_LAZY` 之类的 env 门**。
   门预算 `check-tui-gates.js:41` `MAX_GATES = 227`，当前实测**恰好 227**（顶格，只降不升）。
   且本仓已有先例判据（`[DESIGN-ARCH-124]`）：**「让功能变正确」不构成权衡，不值得加门**。
   redis 懒加载是修缺陷，不是给用户一个开关。

4. ❌ **把 `require('redis')` 从顶层挪到 `getRedisClient()` 里就算完**。
   必须同时确认**所有**出口（`get`/`set`/`del`/`clearByPrefix`/`getStats`）都先触发初始化，
   否则会出现「第一次 get 返回 undefined」的静默降级 —— 比慢更糟。
   写一条测试钉住「模块被 require 后 `useRedis===false`，首次调用后才变」。

5. ❌ **把三个重 require 删掉**。它们有真实用途（预检告警、toolUseLoop 热路径、git 上下文）。
   本提案只**换位置**，不删功能。删掉会让首次发消息卡住 —— 那是把启动慢换成操作慢。

6. ❌ **用 `git` 的 `--no-optional-locks` 或换 `libgit2` 优化 6 个 spawn**。
   病根是「6 次串行 spawn」，不是 git 本身慢。正确方向是延后到首帧后（P2），
   或做 60s 磁盘缓存（`.khy/cache/git-context.json`）—— 后者是 P2 之后的可选项。

7. ❌ **把 1524 个模块当优化目标去逐个瘦身**。实测模块数与首帧不是线性关系
   （V1 砍掉 542 个模块 = 33.2s，但 `replSession` 96 个模块只占 170ms）。
   **先找单体量最大的那一个**，别做全面瘦身。

---

## 7. 验收方式

### 7.1 主判据（可复现）

```powershell
# 探针：伪造 TTY + Module._load 插桩，跑到 require('./tui/app.js') 停手
& "<node>" ".khy/tmp/perf-variants.js"
# 读 .khy/tmp/perf-variants-view.txt
```

| # | 判据 | 门槛 |
|---|---|---|
| 1 | V1（redis 懒加载）首帧 | **≤ 12s**（现状 44.1s） |
| 2 | V1 模块数 | **≤ 1000**（现状 1523） |
| 3 | V3 累计首帧 | **≤ 10s** |
| 4 | `cacheService` 惰性单测 | 新增：require 后 `isRedisConnected()===false`，首次 `get()` 后才可能 true |
| 5 | **零新增 `KHY_*`** | `node scripts/ci/check-tui-gates.js` 仍为 227 |
| 6 | 既有启动套件零回归 | `node --test services/backend/tests/cli/startupBeats.test.js tests/cli/tui/startupBeatsWiring.test.js` |
| 7 | cacheService 既有测试 | `node --test services/backend/tests/**/cacheService*.test.js`（落地前先跑，记基线条数） |

> ⚠ **探针不是 CI**。`node-pty` 未安装 ⇒ 沙箱内拿不到真 PTY ⇒ 首帧判据只能本地跑。
> 提案**不声称 CI 覆盖启动耗时**。CI 只能保证「不红」（判据 4–7）。

### 7.2 人工确认（探针测不到的部分）

- 真的敲 `khy`，确认输入框在 **10s 内**出现（不是"到达挂载点"）。
- 首次发一条消息，确认**没有**因为 toolUseLoop 延后而卡顿。
- 确认钉选告警（若本机有）**仍然出现**。

---

## 8. 待核实项

| # | 事项 | 影响 | 优先级 |
|---|---|---|---|
| 1 | 谁在 TUI 启动路径上调用 `spawnGuiApp('http://localhost:3000')`（Δ **10.0s**） | 若可延后，这是 P0+P1+P2 之后的最大单项。`platformUtils.js:245` 是通用工具函数，**不是病灶本身** | **高** |
| 2 | TUI 模式是否真需要 `spawn node server.js` | 独立服务进程的生命周期与必要性 | 中 |
| 3 | `localLLMService` 顶层 `spawnSync python --version`（Δ 4.0s）能否懒化 | 与 E1 同型病（顶层探测） | 中 |
| 4 | 1524 个模块里，除 redis 外还有没有第二个"单体量 > 3s"的 | 决定 P0 之后是否还有第二个 20s | 中 |
| 5 | 沙箱外 `reg.exe` 的真实耗时 | 影响 §1.6 账目，不影响结论 | 低 |
| 6 | 干净仓库（无 340 porcelain 条目）下 `gitContextService` 的真实成本 | 决定 P2 的收益是 1.4s 还是 0.1s | 低 |

---

## 9. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-10-03 | 初版。伪造 TTY + 全图插桩实测：首帧 **44.1s / 1524 模块**（冷态 75.5s）。
登记 E1（`cacheService.js:157` 顶层 `initRedis()` → redis **20.4s / 542 模块**，无开关）、
E2（6 个串行 git，~9.8s）、E3（`replSession.js:328`「非阻断」预检在首帧门口引爆 E1 + 自身 5.7s）、
E4（`setImmediate` 预热推迟首帧，离线实测 +71ms 暖 / 冷态放大）、E5（环境地板 1.2–1.5s 不可破）。
四变体实测：44.1 → 10.9（redis）→ 10.6（预检）→ 9.2s（git）。
方案 = P0 redis 惰性（-75%）+ P1/P2 首帧前 require 收敛 + P3 顶层副作用守卫；
含 5 条实证边界、7 条反模式、7 条验收、6 项待核实。**明确指出 140 号漏掉了 redis 这头号病灶。** |
| 2026-10-04 | **P0 落地**：`cacheService.js` 顶层 `initRedis()` 改惰性（新增 `_ensureInit()`，`get`/`set`/`del`/`clearByPrefix`/`getStats` 五个 async 出口首行 `await _ensureInit()`；`getRedisClient`/`isRedisConnected` 保持同步不触发 —— 否则 aiGateway 构造时会同步 `require('redis')`，收益消失）。**两份副本同改**：`vendor/shared`（backend 实际加载）与 `substrate/packages/shared`（真源）。A/B 实测（`require.cache` 结构事实，非耗时）：模块增量 **543 → 1**、redis 模块 **522 → 0**（与本文预测的 542 吻合）。新增判据测试 `runtime/node/backend/tests/services/cacheServiceLazy.test.js`（3/3，含反向对照）。既有 `cacheService.test.js` 9/9、启动套件 59/59 无回归。**P1–P3 未做。** |
| 2026-10-04 | **P3 落地 → 规则 `RUNTIME-012`「模块顶层副作用收敛」**。新增 `scripts/lib/toplevelSideEffectGuard.js`（纯叶子，**零外部依赖**：原型曾用 `acorn`，但 acorn 在根 `node_modules` 里只是 espree/terser 的**传递依赖**、且本仓 94 个检查器无一 require 外部 npm 包 ⇒ 改手写词法扫描）+ `scripts/ci/check-toplevel-side-effects.js`（薄壳）+ `scripts/tests/check-toplevel-side-effects.test.js`（27 用例）。门档 `gate=commit` + `severity=advisory`（S1 观察者，恒 exit 0）。<br>**精度核验（本仓最贵的一步）**：拿原型当 oracle 对拍 `runtime/node/backend/src` 2953 个非测试 .js —— **4/4 完全一致，零漏报零误报**。核验中抓到并修掉两类误报：① 原型 v1 用正则扫函数体**文本**，把 `() => require('./x')` 惰性 thunk 误判为命中（`adapterRegistry._defineBuiltins` / `serviceRegistry._autoRegister`）；② 行首 `ident(` 但处于**多行实参列表续行**（`router.post(\n [\n body('username')`）被误判为顶层语句 ⇒ 补上圆/方括号深度判据。<br>**存量清点**：4 条命中**无一条在启动首帧路径上**（2 条独立入口脚本 `migrations/run.js` / `daemonEntry.js`，2 条刻意 eager 且被函数内惰性 require）⇒ 全部登记 `KNOWN_TOPLEVEL_SIDE_EFFECTS` 降为 info，S1 baseline = **0 error / 0 warning / 9 info**（4 已知 + 5 盲区盘点）。**判据边界（诚实标注）**：跨文件导入的被调方只盘点不判违规；单行表达式体箭头与顶层 `if/try` 块内的调用**不判**（保守方向，宁可漏报不可误报）。<br>接线四触点齐（package.json 别名 / 登记表条目 + `meta.ruleCount` 96 / 本文件第 3 行 marker / `FEATURE-OWNERSHIP.json` 阶段登记）；规则卡已重生成、全站孪生件已重生成。验收：`check-wiring` 100 个检查器全接线、`check-gov-rules` / `check-rules-registry` 通过、`check-rollout-stage` **0 error / 3 warning（未新增 —— 那 3 条是既有的 editFile/crossModelVerify/trajectoryStatsStore 同族先例）**、反例矩阵 7/7、变异测试 5/5 被杀死。 |
| 2026-10-04 | **P1 经评估后判定不可做（本轮放弃）**：P1 的前提是「把 `_kickoffGatewayPinStartupCheck` 挪到首帧**挂载完成回调**」，但实测 `startInkApp(options)` **没有 onMount 回调** ⇒ 没有可用的首帧就绪信号，P1 无从落地。且其收益仅 0.4s（在本文 §5 已自陈「单次测量噪声内」），却要改 `replSession.js` 这尊重量级巨石（受 R2b「只许减不许增」约束）⇒ **性价比不成立**。P2（1.4s）仍待做，但需要先造首帧就绪钩子。 |
