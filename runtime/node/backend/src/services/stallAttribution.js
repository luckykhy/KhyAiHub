'use strict';

/**
 * stallAttribution.js — attribute a recovered event-loop stall to a CAUSE, not
 * to a guess. (pure leaf: zero IO, deterministic, fail-soft, reads no env)
 *
 * The stall detector in `sessionWatchdog` can only prove that its sampler beat
 * arrived late (`drift`). Three very different things produce that same
 * observation, and the old line asserted the worst-looking one ("sync long task
 * or dead loop") for all of them:
 *
 *   1. a real sync block  — the process burns CPU for the whole window;
 *   2. the process was NOT running at all (paging under memory pressure, laptop
 *      sleep, CPU starvation by other processes) — CPU time barely advances;
 *   3. something in between.
 *
 * The discriminator is `process.cpuUsage()`: it is a Node built-in, microsecond
 * resolution, and — unlike `wmic`/PowerShell — spawns nothing, so sampling it
 * right after a recovered stall does not add to the very stall it explains
 * (the zero-spawn rule `services/runtimeResourceProbe.js` is built on).
 *
 *   cpuRatio = cpuDeltaUs / (driftMs * 1000)
 *     ≥ SYNC_CPU_RATIO     → 'sync'     (CPU was busy: ours to fix)
 *     ≤ EXTERNAL_CPU_RATIO → 'external' (the process was descheduled: not a khy defect)
 *     in between           → 'unknown'  (say so; never pick a side)
 *
 * `freePct` rides along for the notice text only. The headroom judgement stays
 * where it belongs — `runtimeResourceProbe.FLOOR_FREE_MEM_PCT` — so this leaf
 * does not become a second source of truth for "is this machine short on memory".
 * A read taken after the stall ended says nothing about what it was during, and
 * the notice is worded to match that.
 *
 * Thresholds are module constants, not KHY_* gates: a correct attribution is
 * not a user-visible trade-off, and a new env knob would both break the B-P1
 * bugfix exemption and burn the `check-tui-gates` budget for nothing.
 *
 * @module services/stallAttribution
 */

/** Window CPU share at or above which the process itself was busy. */
const SYNC_CPU_RATIO = 0.5;
/** Window CPU share at or below which the process was not running at all. */
const EXTERNAL_CPU_RATIO = 0.05;

const KINDS = Object.freeze({
  SYNC: 'sync',
  EXTERNAL: 'external',
  UNKNOWN: 'unknown',
});

/**
 * A finite number, or null. `Number(null)` is 0 and `Number(true)` is 1, so a
 * plain `Number.isFinite(Number(v))` would silently read "the probe returned
 * nothing" as "the process burned no CPU at all" — turning a missing reading
 * into a verdict, which is the exact failure this leaf exists to remove.
 */
function _finite(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Classify one recovered stall. Never throws: a caller on the watchdog's hot
 * path must not be able to die asking why it stalled.
 *
 * @param {object} [input]
 * @param {number} [input.driftMs] - How late the sampler beat arrived.
 * @param {number} [input.cpuDeltaUs] - Process CPU microseconds consumed inside
 *   that window (a `process.cpuUsage()` delta: user + system).
 * @param {number} [input.freePct] - Free physical memory percent at recovery
 *   time. Carried for the notice text; never part of the verdict.
 * @returns {{kind:string, cpuRatio:number|null, freePct:number|null, evidence:string}}
 */
function classifyStall(input) {
  const p = input && typeof input === 'object' ? input : {};
  const driftMs = _finite(p.driftMs);
  const cpuDeltaUs = _finite(p.cpuDeltaUs);
  const freePct = _finite(p.freePct);

  // No usable measurement is a verdict of its own: "we could not tell" must not
  // degrade into the sync accusation, and must not be rounded to a clean 0.
  if (driftMs === null || driftMs <= 0 || cpuDeltaUs === null) {
    return {
      kind: KINDS.UNKNOWN,
      cpuRatio: null,
      freePct,
      evidence: 'no-measurement',
    };
  }

  const windowUs = driftMs * 1000;
  if (windowUs <= 0) {
    return { kind: KINDS.UNKNOWN, cpuRatio: null, freePct, evidence: 'no-measurement' };
  }

  const cpuRatio = cpuDeltaUs / windowUs;
  let kind = KINDS.UNKNOWN;
  let evidence = 'partial-cpu';
  if (cpuRatio >= SYNC_CPU_RATIO) {
    kind = KINDS.SYNC;
    evidence = 'cpu-busy';
  } else if (cpuRatio <= EXTERNAL_CPU_RATIO) {
    kind = KINDS.EXTERNAL;
    evidence = 'cpu-idle';
  }
  return { kind, cpuRatio, freePct, evidence };
}

/**
 * The one line a classified stall earns. The remedy must match what was found:
 * telling a user on a paging box to go profile their startup is the same class
 * of mistake as telling a user with a real dead loop to close a browser tab.
 *
 * @param {object} input
 * @param {number} input.driftMs
 * @param {{kind:string, cpuRatio:number|null, freePct:number|null}} input.attribution
 * @returns {string}
 */
function stallNoticeLine({ driftMs, attribution } = {}) {
  const seconds = (ms) => (Math.max(0, Number(ms) || 0) / 1000).toFixed(1);
  const drift = seconds(driftMs);
  const a = attribution && typeof attribution === 'object' ? attribution : {};
  const ratio = _finite(a.cpuRatio);
  const used = ratio === null ? null : (ratio * (Number(driftMs) || 0) / 1000).toFixed(1);

  if (a.kind === KINDS.SYNC) {
    return (
      `[Watchdog] 事件循环曾阻塞 ${drift}s（同步长任务嫌疑：期间本进程 CPU 占用约 ${used}s/${drift}s），` +
      '现已恢复调度。若反复出现，设 STARTUP_PROFILE=1 启动一次定位慢子树。'
    );
  }
  if (a.kind === KINDS.EXTERNAL) {
    const free = _finite(a.freePct);
    const headroom = free === null ? '' : `（当前空闲 ${free}%）`;
    return (
      `[Watchdog] 事件循环曾停滞 ${drift}s——期间本进程几乎未获 CPU（约 ${used || '0.0'}s/${drift}s），` +
      '系统换页/休眠/调度嫌疑，非 khy 同步任务。' +
      `处置：先释放系统侧内存${headroom}；低余量机器可 clipboard bridge stop 省约 85 MB。`
    );
  }
  return (
    `[Watchdog] 事件循环曾阻塞 ${drift}s（同步长任务或进程被停走，本次未能区分：` +
    `期间本进程 CPU 占用约 ${used || '未知'}/${drift}s），现已恢复调度。`
  );
}

module.exports = {
  classifyStall,
  stallNoticeLine,
  KINDS,
  SYNC_CPU_RATIO,
  EXTERNAL_CPU_RATIO,
};
