'use strict';

/**
 * runtimeResourceProbe.js — zero-spawn census of what a live khy process holds
 * resident: memory, module graph, live timers/watchers, machine headroom, data home.
 *
 * Every startup doc in this repo quantified first-paint time; none quantified
 * steady-state residency — which is the half users feel as "卡死". This module is
 * that ruler. It only reads in-process APIs (process.memoryUsage /
 * getActiveResourcesInfo / require.cache / os.*) plus the existing
 * cleanupService.assessRuntimeFootprint for disk. Nothing here spawns a shell:
 * on a box where Defender taxes one spawn at 3.8-7.8s ([DESIGN-PERF-005] 实测),
 * an instrument that spawns is worse than no instrument.
 *
 * Budgets are the module constants below — single source, tighten by editing here
 * ([RUNTIME-001] 零硬编码). No env gates: the TUI gate budget sits at its cap.
 *
 * @module services/runtimeResourceProbe
 */

const os = require('os');

const MB = 1024 * 1024;

// Module-graph budget, split by measurement phase ([DESIGN-ARCH-180]). `frame` is
// [DESIGN-ARCH-178] §7's pre-first-paint acceptance target; `cli`/`tui` are steady-state
// ratchet baselines (measured 2026-10-04: 1084 / 2079, plus headroom). All three may
// only be lowered — raising one means editing the design-lock test too.
const MODULE_BUDGET = Object.freeze({
  frame: 1000,
  cli: 1200,
  tui: 2200,
});

// A missing phase falls back to the loosest tier: a steady-state census should not
// manufacture noise just because a caller forgot the argument.
const DEFAULT_PHASE = 'tui';

function _moduleBudget(phase) {
  return MODULE_BUDGET[phase] != null ? MODULE_BUDGET[phase] : MODULE_BUDGET[DEFAULT_PHASE];
}

// Measured 2026-10-03: the warm boot graph alone sits at 90MB RSS. 220 leaves
// room for one loaded conversation plus the ink tree while still being tight
// enough that a regression of ~100MB cannot hide under it.
const BUDGET_RSS_MB = 220;

// Below this share of physical RAM free, paging starts turning tool calls into
// multi-second stalls — report it as environment, not as a khy defect.
const FLOOR_FREE_MEM_PCT = 15;

// Live-resource ceilings for a process that has finished booting, split by the
// SAME measurement phase as MODULE_BUDGET. The historical single value compared an
// interactive TUI session against `khy doctor`'s one-shot steady state (measured
// 2026-10-03: `khy doctor` settles at 1 timer / 0 watcher) and cried wolf at ~26
// timers: the TUI's own render scheduling plus the registered resident intervals
// (session watchdog 1s / memory monitor 30s / cleanup periodic / security monitor
// 600s) all count toward `getActiveResourcesInfo()`. `cli` keeps the tight leak
// tripwire; `tui` widens it to that interactive steady state; `frame` is the
// pre-first-paint point, where almost nothing resident should exist yet.
const HANDLE_BUDGET = Object.freeze({
  frame: Object.freeze({ timers: 20, watchers: 2 }),
  cli: Object.freeze({ timers: 20, watchers: 2 }),
  tui: Object.freeze({ timers: 30, watchers: 4 }),
});

// Back-compat aliases: the cli tier is the historical single-value reading.
const HANDLE_BUDGET_TIMERS = HANDLE_BUDGET.cli.timers;
const HANDLE_BUDGET_WATCHERS = HANDLE_BUDGET.cli.watchers;

function _handleBudget(phase) {
  return HANDLE_BUDGET[phase] != null ? HANDLE_BUDGET[phase] : HANDLE_BUDGET[DEFAULT_PHASE];
}

function _mb(bytes) {
  return Math.round((Number(bytes) || 0) / MB);
}

/**
 * Live async resources, grouped by libuv/V8 handle class. A Timeout or FSWatcher
 * count that grows across a session is a leak; this is the number that catches it.
 * `top` is the same grouping, ordered, so a notice can name what the count is made
 * of instead of asking the user to guess.
 */
function collectHandleCensus() {
  const by = {};
  let total = 0;
  if (typeof process.getActiveResourcesInfo === 'function') {
    for (const kind of process.getActiveResourcesInfo()) {
      by[kind] = (by[kind] || 0) + 1;
      total += 1;
    }
  }
  const top = Object.keys(by)
    .map((kind) => ({ kind, count: by[kind] }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  return { total, by, top };
}

function collectMemory() {
  const m = process.memoryUsage();
  return {
    rssMB: _mb(m.rss),
    heapUsedMB: _mb(m.heapUsed),
    heapTotalMB: _mb(m.heapTotal),
    externalMB: _mb(m.external),
    rssBudgetMB: BUDGET_RSS_MB,
  };
}

function collectModuleGraph(phase) {
  return { loaded: Object.keys(require.cache).length, budget: _moduleBudget(phase) };
}

function collectMachine() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  return {
    totalMB: _mb(totalBytes),
    freeMB: _mb(freeBytes),
    freePct: totalBytes > 0 ? Math.round((freeBytes / totalBytes) * 100) : 0,
    cpus: Array.isArray(os.cpus()) ? os.cpus().length : 0,
    floorFreePct: FLOOR_FREE_MEM_PCT,
  };
}

/**
 * In-process registry of the resident side children we know about. Read via the
 * service's own status getter — it inspects module state, it does not spawn.
 */
function collectResidentChildren() {
  const out = [];
  try {
    const bridge = require('./windowsClipboardImg2FileService');
    const st = bridge.getClipboardImg2FileBridgeStatus();
    if (st.supported) {
      out.push({
        name: '剪贴板图片桥 (powershell)',
        running: st.running,
        enabled: st.enabled,
        pid: st.pid,
        pollMs: st.meta && st.meta.pollMs,
      });
    }
  } catch {
    /* service unavailable → report nothing rather than a false zero */
  }
  return out;
}

/**
 * Data home size. Delegates to cleanupService so `khy doctor` and the boot notice
 * quote the same ruler as `khy clean --runtime` (two inconsistent sizes are worse
 * than none). Walks the tree — pass { disk: true } only when that cost is wanted.
 */
function collectDataHome() {
  try {
    const cleanup = require('./cleanupService');
    const f = cleanup.assessRuntimeFootprint();
    return {
      root: f.root,
      totalMB: _mb(f.totalBytes),
      totalHuman: f.totalHuman,
      reclaimableMB: _mb(f.reclaimableBytes),
      reclaimableHuman: f.reclaimableHuman,
      thresholdMB: _mb(f.thresholdBytes),
      overThreshold: f.overThreshold,
      top: f.breakdown.slice(0, 3),
    };
  } catch {
    return null;
  }
}

/**
 * One-shot census. Pure read, no side effects, never throws: every failure mode
 * degrades to a partial snapshot rather than blocking the caller.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.disk] include the data-home tree walk (seconds on a large home)
 * @param {'frame'|'cli'|'tui'} [opts.phase] measurement point; picks the module-graph AND handle budgets
 * @returns {object}
 */
function collectRuntimeCensus(opts = {}) {
  // Resolve once, up front: both the module budget and the handle budget key off
  // the same phase, and the snapshot carries it so the judge never has to guess.
  const phase = MODULE_BUDGET[opts.phase] != null ? opts.phase : DEFAULT_PHASE;
  const snap = {
    at: Date.now(),
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime() * 10) / 10,
    phase,
    memory: collectMemory(),
    modules: collectModuleGraph(phase),
    handles: collectHandleCensus(),
    machine: collectMachine(),
    children: collectResidentChildren(),
  };
  if (opts.disk) {
    snap.dataHome = collectDataHome();
  }
  return snap;
}

/**
 * The only place a reading is compared against a budget. `khy doctor`'s
 * 「驻留资源」section and the in-session boot notice both consume this, so the two
 * surfaces can never disagree about what counts as over.
 *
 * @param {object} snap result of collectRuntimeCensus()
 * @returns {Array<{id:string,label:string,exceeded:boolean,detail:string,summary:string,hint:string}>}
 */
function assessResidency(snap) {
  const c = _residencyContext(snap);
  const findings = [
    _memoryFinding(c),
    _modulesFinding(c),
    _handlesFinding(c),
    _machineFinding(c),
    _childrenFinding(c),
  ];
  if (snap.dataHome) findings.push(_dataHomeFinding(snap.dataHome));
  return findings;
}

/** 把会被多张 finding 读到的量算一次（含 phase 档位与句柄分类）。 */
function _residencyContext(snap) {
  const h = snap.handles;
  const watchers = (h.by.FSWatcher || 0) + (h.by.StatWatcher || 0) + (h.by.FSEvent || 0);
  // The count is already split into Timeout/watchers; name the remaining handle
  // classes too so a reading is a clue, not a number.
  const otherKinds = (h.top || [])
    .filter((x) => x.kind !== 'Timeout' && x.kind !== 'StatWatcher' && x.kind !== 'FSWatcher' && x.kind !== 'FSEvent')
    .slice(0, 3)
    .map((x) => `${x.kind}×${x.count}`)
    .join(' ');
  return {
    snap,
    m: snap.memory,
    g: snap.modules,
    h,
    ma: snap.machine,
    hb: _handleBudget(snap.phase),
    watchers,
    timers: h.by.Timeout || 0,
    otherKinds,
    liveChildren: (snap.children || []).filter((c) => c.running),
  };
}

function _memoryFinding(c) {
  const m = c.m;
  return {
    id: 'memory',
    label: '进程内存',
    exceeded: m.rssMB > m.rssBudgetMB,
    detail: `RSS ${m.rssMB} MB（预算 ${m.rssBudgetMB}）· 堆 ${m.heapUsedMB}/${m.heapTotalMB} MB · 外部 ${m.externalMB} MB`,
    reading: `RSS ${m.rssMB}/${m.rssBudgetMB} MB`,
    summary: m.rssMB > m.rssBudgetMB
      ? `本进程 RSS ${m.rssMB} MB，超过预算 ${m.rssBudgetMB} MB`
      : `本进程 RSS ${m.rssMB} MB，在预算 ${m.rssBudgetMB} MB 内`,
    hint: '在会话内执行 clipboard bridge stop 收起常驻子进程，或清理数据目录后重跑 khy doctor 复查',
  };
}

function _modulesFinding(c) {
  const g = c.g;
  return {
    id: 'modules',
    label: '模块图',
    exceeded: g.loaded > g.budget,
    detail: `已载入 ${g.loaded} 个模块（上限 ${g.budget}）`,
    reading: `已载入 ${g.loaded}/${g.budget}`,
    summary: g.loaded > g.budget
      ? `载入 ${g.loaded} 个模块，超过 ${g.budget} 上限——首帧前的 require 图在膨胀`
      : `载入 ${g.loaded} 个模块，在 ${g.budget} 上限内`,
    hint: '用 STARTUP_PROFILE=1 启动一次，按分阶段耗时定位是哪棵子树被 eager require，再改为按需加载',
  };
}

function _handlesFinding(c) {
  const { h, hb, timers, watchers, otherKinds } = c;
  const over = timers > hb.timers || watchers > hb.watchers;
  return {
    id: 'handles',
    label: '活体句柄',
    exceeded: over,
    detail: `活体资源 ${h.total} 项（定时器 ${timers} · 文件监视 ${watchers}${otherKinds ? ` · ${otherKinds}` : ''}）`,
    reading: `定时器 ${timers}/${hb.timers} · 监视 ${watchers}/${hb.watchers}`,
    summary: over
      ? `定时器 ${timers} 个、文件监视 ${watchers} 个，高于 ${c.snap.phase || DEFAULT_PHASE} 档判据（定时器 ≤${hb.timers} · 监视 ≤${hb.watchers}）`
      : `定时器 ${timers} 个、文件监视 ${watchers} 个，未见句柄堆积`,
    hint: '对照 services/serviceLifecyclePolicy.js 的 resident 条目降档：session watchdog(1s)/内存监视(30s)/周期清理/安全监视(600s) 均为已 unref 的常驻 interval；低余量机器可 clipboard bridge stop 省约 85 MB，watcher 必须 unref 并在卸载时关闭。启动窗口内的读数含尚未 firing 的启动 timer，结算后复测更准',
  };
}

function _machineFinding(c) {
  const ma = c.ma;
  return {
    id: 'machine',
    label: '机器余量',
    exceeded: ma.freePct < ma.floorFreePct,
    detail: `物理内存 ${ma.freeMB}/${ma.totalMB} MB 空闲（${ma.freePct}%，判据 ≥${ma.floorFreePct}%）· ${ma.cpus} 核`,
    reading: `空闲 ${ma.freePct}%/≥${ma.floorFreePct}%`,
    summary: ma.freePct < ma.floorFreePct
      ? `可用内存只剩 ${ma.freePct}%，低于 ${ma.floorFreePct}% 判据——此时任何常驻开销都会因换页被放大成卡顿`
      : `可用内存 ${ma.freePct}%，余量充足`,
    hint: '先释放系统侧占用（关闭闲置浏览器/常驻应用）再评估 khy；必须在低余量机器上工作时，在会话内执行 clipboard bridge stop 去掉约 85 MB 常驻内存',
  };
}

function _childrenFinding(c) {
  const live = c.liveChildren;
  return {
    id: 'children',
    // Deliberately never an exceedance: the image bridge is resident by design
    // (a one-shot capture would pay the Defender spawn tax on every paste). If it
    // reported "over budget" every session, this whole notice would train people
    // to ignore it — so it reads as a cost statement, and the disposal command
    // stays with the user.
    exceeded: false,
    label: '常驻子进程',
    detail: live.length === 0
      ? '本进程未持有常驻子进程'
      : live
          .map((x) => `${x.name} pid=${x.pid}${x.pollMs ? ` 轮询 ${x.pollMs}ms` : ''}`)
          .join('；'),
    reading: `常驻 ${live.length} 个`,
    summary: live.length === 0
      ? '无常驻子进程，会话期少一份常驻内存'
      : `会话期常驻子进程 ${live.length} 个：${live.map((x) => `${x.name}（实测约 85 MB 常驻内存，可在会话内 clipboard bridge stop 收起）`).join('、')}`,
    hint: '确认用途后可在会话内执行 clipboard bridge stop 收起图片桥（实测约 85 MB 常驻内存），需要粘图时再 clipboard bridge start 唤回',
  };
}

function _dataHomeFinding(d) {
  return {
    id: 'dataHome',
    label: '数据目录',
    exceeded: d.overThreshold,
    detail: `${d.root} 共 ${d.totalHuman}（提示阈值 ${d.thresholdMB} MB）· 最大三项：${d.top.map((t) => `${t.rel} ${t.human}`).join('、') || '（空）'}`,
    reading: `${d.totalMB}/${d.thresholdMB} MB`,
    summary: d.overThreshold
      ? `数据目录 ${d.totalHuman} 超过提示阈值 ${d.thresholdMB} MB，最大三项：${d.top.map((t) => `${t.rel} ${t.human}`).join('、')}`
      : `数据目录 ${d.totalHuman}，在提示阈值内`,
    hint: `运行 khy clean --runtime --dry-run 查看可回收的 ${d.reclaimableHuman}（logs/audit/tmp/cache/change-watch）；会话存档与工作区快照不在白名单内，需人工确认后再处理`,
  };
}

/** Findings the in-session notice carries: only the ones the user can act on. */
const SESSION_AUDIENCE = new Set(['memory', 'handles', 'machine', 'children', 'dataHome']);

// Machine headroom is the user's environment, not a khy defect. Merged into the
// same "over budget" sentence as our own readings, a busy box trains people to
// ignore the whole instrument — so it gets its own sentence and its own disposal.
const SESSION_ENVIRONMENT_IDS = new Set(['machine']);

/**
 * Compact single-line residency notice for a live session, or null when nothing
 * exceeds budget (silence is the normal state — a boot line that always fires
 * trains everyone to ignore it). Same findings as `khy doctor`, one ruler.
 *
 * The module graph is deliberately excluded: its disposal is "change the code",
 * a developer move — it stays visible in `khy doctor`'s 驻留资源 section.
 *
 * Two sentences at most: khy's own actionable readings first, then the machine's
 * headroom as `环境` — never the two conflated under one "均超出判据".
 *
 * @param {object} snap result of collectRuntimeCensus()
 * @returns {string|null}
 */
function buildResidencyNotice(snap) {
  const over = assessResidency(snap).filter((f) => f.exceeded && SESSION_AUDIENCE.has(f.id));
  if (over.length === 0) return null;

  const segments = [];
  const self = over.filter((f) => !SESSION_ENVIRONMENT_IDS.has(f.id));
  if (self.length > 0) {
    const readings = self.map((f) => `${f.label} ${f.reading}`).join(' · ');
    const hints = [...new Set(self.map((f) => f.hint))];
    segments.push(
      `已统计本会话进程（pid ${snap.pid}，运行 ${snap.uptimeSeconds}s）：${readings}，超出判据。处置：${hints.join('；')}`
    );
  }
  const env = over.filter((f) => SESSION_ENVIRONMENT_IDS.has(f.id));
  if (env.length > 0) {
    const readings = env.map((f) => `${f.label} ${f.reading}`).join(' · ');
    const hints = [...new Set(env.map((f) => f.hint))];
    segments.push(`环境：${readings}，低于判据（非 khy 缺陷）。处置：${hints.join('；')}`);
  }
  return segments.join(' ');
}

module.exports = {
  collectRuntimeCensus,
  assessResidency,
  buildResidencyNotice,
  collectHandleCensus,
  collectMemory,
  collectModuleGraph,
  collectMachine,
  collectDataHome,
  MODULE_BUDGET,
  BUDGET_RSS_MB,
  FLOOR_FREE_MEM_PCT,
  HANDLE_BUDGET,
  HANDLE_BUDGET_TIMERS,
  HANDLE_BUDGET_WATCHERS,
};
