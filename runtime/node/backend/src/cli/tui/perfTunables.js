'use strict';

/**
 * perfTunables — pure leaf holding the TUI's timer cadence tunables.
 *
 * Zero dependencies, zero IO, deterministic, never throws. Single source of
 * truth for the render/timer cadence defaults so no consumer hard-codes them.
 *
 * Background: profiling showed the busy-state TUI stacks THREE periodic
 * timers — the Spinner braille rotation, the 1s elapsed heartbeat
 * (App.js nowTick) and the topicBar working-dot animation — each of which
 * forces a repaint. Cadences were once relaxed to cut idle-busy CPU:
 *   - spinnerFrameMs: 80 → 160 (12.5fps → ~6fps)
 *   - topicBarAnimMs: 180 → 320
 *
 * **2026-09-29 partial reversion ([DESIGN-PERF-004] §6 A0/Q-1).**
 *   - topicBarAnimMs: **reverted to 180ms.** It had no row in tui/AGENTS.md
 *     §3.3, so nothing pinned it; 180 is the original hard-coded value in
 *     runtime/topicBar.js, which still carries it as its fallback. The spec
 *     table now lists it.
 *   - spinnerFrameMs: **still 160ms — deliberately NOT reverted.** 160 is not
 *     an incidental relaxation: five normative docs adjudicate it
 *     ([DESIGN-ARCH-079] §12.6.1, [101] §1.1 + §8 冲突 1, [102] §6.4,
 *     [115] §2.2), and [101] §8 names the 80ms as the *stale* third source.
 *     [DESIGN-ARCH-134] additionally warns that an 80ms spinner on a
 *     saturated frame means a near-full-screen rewrite every tick. Going
 *     back to 80 requires moving those docs first — not a silent default
 *     change. Convergence target stays 160 ([115] §2.2, deferred P1/D10).
 * The heartbeat never took part in that relaxation: 1000 → 2000 was tried and
 * reverted on 2026-09-24 because the 2s granularity is a **correctness** cost,
 * not a cosmetic one — the elapsed readout skips seconds (see heartbeatMs).
 *
 * Env overrides (KHY_SPINNER_FRAME_MS / KHY_HEARTBEAT_MS /
 * KHY_TOPIC_BAR_ANIM_MS) accept any finite positive number; garbage
 * (NaN / 0 / negative / empty string) falls back to the default — the same
 * reject-garbage paradigm used across the repo's env parsing.
 *
 * A fourth knob, suspendSettleMs, is not a cadence but a **barrier**: how long
 * the shell waits after suspending the live UI before calling app.clear(). It
 * must EXCEED ink's own render throttle window, or the clear races a pending
 * trailing render (see the function docstring).
 *
 * Umbrella switch: KHY_TUI_LOW_POWER === '1' relaxes the cadence defaults
 * further (320 / 2000 / 640) for battery / remote-shell scenarios. A per-knob
 * env var, when explicitly set to a valid value, always wins over the umbrella.
 * The umbrella's own values did NOT move in the 2026-09-29 reversion: that
 * tier's contract is "explicitly accept slower animation to save power", so
 * re-tightening it would break the one thing it promises.
 */

/**
 * Parse an env var as a finite positive number; anything else → fallback.
 * @param {*} raw - raw env value
 * @param {number} fallback
 * @returns {number}
 */
function _pos(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** True when the KHY_TUI_LOW_POWER umbrella is on ('1' only, by design). */
function _lowPower(env) {
  return String((env && env.KHY_TUI_LOW_POWER) || '') === '1';
}

/**
 * Spinner braille frame interval. Default 160ms (was a hard-coded 80ms in
 * Spinner.js — 12.5fps; 160ms halves spinner-driven repaints while keeping
 * the rotation visibly smooth). LOW_POWER umbrella → 320ms.
 *
 * ⚠ 160 is **adjudicated**, not incidental: [DESIGN-ARCH-101] §8 冲突 1 rules
 * "以 perfTunables 的 160ms 为准" and marks the 80ms as the stale source. Read
 * the header Background before changing this default.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function spinnerFrameMs(env = process.env) {
  const def = _lowPower(env) ? 320 : 160;
  return _pos(env && env.KHY_SPINNER_FRAME_MS, def);
}

/**
 * Busy-state elapsed heartbeat interval. Default 1000ms.
 *
 * 历史:80ms spinner / 1000ms 心跳 / 180ms topicBar 三只定时器各自触发 ink 重渲染,
 * 为压 CPU 曾把心跳放到 2000ms。**2026-09-24 回退到 1000ms**:2s 粒度的代价不是
 * 「读起来粗」而是「数不准」——秒数每跳一次跨 2,用户看到的是 1s→3s→5s,与真实
 * 经过时间对不上(用户原话:「时间应该 1s、1s 的跳,而不是一下跳几秒」)。
 * 心跳是**正确性**参数而非纯节奏参数:它的频率直接决定「已 Ns」有多准。
 * 省 CPU 的正道是别让心跳渲染整棵树(见 Spinner 的 React.memo 与 App 侧
 * 只在活跃回合挂表),不是把钟调慢。
 * LOW_POWER umbrella(电池/远程 shell)→ 2000ms,那里**显式接受**粒度变粗。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function heartbeatMs(env = process.env) {
  const def = _lowPower(env) ? 2000 : 1000;
  return _pos(env && env.KHY_HEARTBEAT_MS, def);
}

/**
 * 心跳 tick 到**下一个整秒边界**的等待时长(ms)。
 *
 * 为什么需要它:心跳 tick 的时刻与回合起点无关。若回合在 t=3.4s 起跑,固定相位
 * 的 tick 落在 4.0/5.0/6.0…,而 `floor((now - started)/1000)` 在 4.4/5.4/6.4…
 * 才进位 —— 显示会在 4.0s 那一刻从 0 **直接跳到 1**,紧接着 4.4s 又变 1,
 * 用户看到的节奏是「0 … 1(闪)… 1 … 2」,而且每一次进位都晚于真实整秒。
 * 自校正后:重算 delay = 下一整秒 - (now - started),让 tick 恰好落在
 * started + 1.0s / +2.0s / … 上,显示每次 **正好 +1** 且与实际经过时间对齐。
 *
 * 纯函数 + 可单测。边界(诚实映射,不假装):
 *   · started=0(回合未起跑)→ 回落 cadence,不自校正;
 *   · 已越过整秒边界 → 立即 tick(0),让下一帧先追上,再重新对齐;
 *   · delay > cadence → 用 cadence 封顶,故障时钟(now 落后于 started)也不会
 *     把下一次 tick 推到很远。
 *
 * @param {number} now 当前毫秒(生产上是 Date.now())
 * @param {number} turnStartedAt 回合起点毫秒;0/非有限 → 不做自校正
 * @param {number} cadenceMs 基础心跳间隔(heartbeatMs 的产物)
 * @returns {number} 毫秒,恒 ≥ 0 且 ≤ cadenceMs(或 cadenceMs 本身)
 */
function heartbeatAlignDelayMs(now, turnStartedAt, cadenceMs) {
  const cad = _pos(cadenceMs, 1000);
  const n = Number(now);
  const started = Number(turnStartedAt);
  if (!Number.isFinite(n) || !Number.isFinite(started) || started <= 0) {
    return cad;
  }
  const elapsed = n - started;
  if (elapsed < 0) {
    return cad;
  }
  const overshoot = elapsed % cad;
  const delay = overshoot === 0 ? cad : cad - overshoot;
  return delay > cad ? cad : delay;
}

/**
 * topicBar working-dot animation interval. Default 180ms — the original
 * hard-coded _ANIM_MS in runtime/topicBar.js, which still carries it as its
 * fallback. Restored from 320ms on 2026-09-29 (see the header Background).
 * LOW_POWER umbrella → 640ms.
 *
 * Unlike spinnerFrameMs, this knob had **no row** in tui/AGENTS.md §3.3, so
 * nothing pinned it and it drifted to 320ms unnoticed. The spec table now
 * carries it; do not relax it again without a spec entry.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function topicBarAnimMs(env = process.env) {
  const def = _lowPower(env) ? 640 : 180;
  return _pos(env && env.KHY_TOPIC_BAR_ANIM_MS, def);
}

/**
 * ink 自身的渲染节流窗口(ms)。ink render 默认 `maxFps: 30` →
 * `Math.ceil(1000/30)` = 34ms 的 throttle(leading + trailing)。这是**上游常量的镜像**,
 * 不是可调参数:改它不会改变 ink 的行为,只会让下面的 settle 算错。
 */
const INK_THROTTLE_MS = 34;

/**
 * Per-frame render-time budget (AGENTS.md §0.3: single render < 16ms, the 60fps
 * floor). This is the SSOT for the frame-budget guard that consumes ink's
 * `onRender({ renderTime })` metric — frameBudget.js reads it here so the
 * documented floor and the enforcement share one source.
 *
 * Env override KHY_TUI_FRAME_BUDGET_MS accepts a finite positive number; garbage
 * falls back to 16. LOW_POWER does NOT relax it — it is a correctness floor
 * (a frame over 16ms means the user perceives jank), not a cadence knob.
 */
function frameBudgetMs(env = process.env) {
  return _pos(env && env.KHY_TUI_FRAME_BUDGET_MS, 16);
}

/**
 * 任务清单「扫盘结果」的新鲜度窗口(ms)。默认 250ms。
 *
 * 背景(2026-09-29 实测,补 taskLinesMemo 未竟的那一半):
 * `_readMergedTaskLines()`(`ink-components/appHostHelpers.js:32`)在 App **渲染体**里被调
 * (`App.js:6313`),它先跑 `taskStore.snapshot()` —— 该调用**同步** statSync + readdirSync
 * 扫会话快照目录与大任务库(profile 调用链:`snapshot`→`list`→`_isStoreStale`→`_statMtimeMs`
 * →`statSync`;并列支 `getCurrentSessionId`→`listPersistedSessions`→`_collectSnapshotFiles`
 * →`readdirSync`)。`taskLinesMemo` 只记忆 `mergeTaskLines` 的**字符串解析**(便宜的那半),
 * `snapshot()` 的**扫盘**仍每帧跑 —— 其注释自陈「留 snapshot 构建给未来的 store 版本号信号」,
 * 本值即补上这一层。
 *
 * 实测收益:把 `snapshot()` 打桩成常量,单帧省 **45%(110.18→60.90ms,≈49ms/帧)**;
 * App 一次重渲 62ms(dev)/52ms(prod),而帧预算是 16ms(见 frameBudgetMs)。本窗口把扫盘
 * 摊销到 49ms/250ms ≈ **0.2ms/帧**。
 *
 * 语义:**这是数据新鲜度窗口,不是动画节拍**。窗口内的渲染复用上次扫盘结果 ⇒ 任务面板
 * 最多滞后本值才反映变化;250ms 远低于人对面板刷新的感知阈值。
 * LOW_POWER 放宽到 1000ms(电池/远程场景**显式接受**面板更迟钝)。
 *
 * 门控:总开关**复用 `KHY_TASK_LINES_MEMO`**(布尔,默认开;关 → 逐帧真扫,逐字节回退今日)。
 * ⚠ **刻意不提供独立 env override**:本方案 §7 R4 要求「净新增 `KHY_*` 门控 = 0」
 * (check-tui-gates 已超标,见其 `MAX_GATES` 注释)。档位差异由既有的 `KHY_TUI_LOW_POWER`
 * 承担 —— 两个门控都是既有的,故本函数**净新增 token = 0**。有单测锁定这一约束。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function taskSnapshotTtlMs(env = process.env) {
  return _lowPower(env) ? 1000 : 250;
}

/**
 * 「挂起 live UI → app.clear()」之间的沉降等待(ms)。默认 50ms。
 *
 * 背景(goal「/命令后出现输入框残影」):壳在跑交互子命令前会 setInputActive(false) 让 live 区
 * 变空,等一帧提交后再 app.clear(),使处理器从干净的瞬态区开始。此处历史上硬编码等 **16ms**,
 * 但 ink 的节流窗口是 **34ms**(maxFps 30,leading+trailing)—— 16 < 34,那帧「空 live 区」提交
 * 通常还挂在 trailing 队列里没落地。于是次序变成:
 *   clear() 擦掉并 log.sync(**clear 前**那帧的行数)→ 随后 trailing onRender 把刚被擦掉的
 *   输入框 chrome 又画了回来 → 残影。
 * 取 50ms(> 34ms 一个安全余量)让 trailing 帧先落地,clear() 才擦到真正的最新帧。
 *
 * 门控 KHY_TUI_SUSPEND_SETTLE_MS 接受任意有限正数;垃圾值回落默认。LOW_POWER 不放宽本值——
 * 它是正确性屏障而非动画节奏,放宽只会让命令启动更迟钝。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
function suspendSettleMs(env = process.env) {
  return _pos(env && env.KHY_TUI_SUSPEND_SETTLE_MS, INK_THROTTLE_MS + 16);
}

module.exports = {
  spinnerFrameMs,
  heartbeatMs,
  heartbeatAlignDelayMs,
  topicBarAnimMs,
  suspendSettleMs,
  frameBudgetMs,
  taskSnapshotTtlMs,
  INK_THROTTLE_MS,
};
