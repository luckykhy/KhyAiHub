'use strict';

/**
 * sessionWatchdog.js — Interactive-session hang watchdog (activity-aware, never kills).
 *
 * Responsibility split with the neighbours:
 *   - crashRecovery.js: crashes (uncaught exceptions / rejections) — classification tree.
 *   - resilience/deadLoopDetector.js: agent tool-call loops (same-signature repeats).
 *   - resourceGuard.startWatchdog: per-operation sliding watchdog — REUSED here as
 *     the idle-detection primitive.
 *   - THIS shell: installs ONE session-surface watchdog so a hung interactive
 *     session is OBSERVED (honest log + diagnostics + onHang hook) instead of
 *     silently sitting there. It never process.exit()s — governance Rule 3
 *     (timeouts must be activity-aware, no hard kill).
 *
 * Two hang classes:
 *   1) Async hang (an await never settles, a poll never exits): the event loop
 *      stays alive, so a sampler can observe idleness. Activity signal = any
 *      user-visible output (stdout/stderr writes). Stdin is deliberately NOT
 *      hooked — ink owns it in the TUI and a side-band 'data' listener changes
 *      stream modes (risk > benefit).
 *   2) Sync stall (long sync task / infinite loop): blocks the timer wheel, so
 *      nothing can fire DURING the block. Detected as beat drift AFTER the
 *      block ends. A truly infinite sync loop can never report — physical
 *      limit, documented here on purpose.
 *
 * Async-hang judgment (2026-09-26): the predicate is NOT "no output for a while"
 * — that is an interactive session's HEALTHY steady state (nobody has typed).
 * It is "**work is pending** AND no output for a while". Silence is only
 * evidence of a hang when something was waiting on it:
 *
 *   · no work pending (turn finished, session at the prompt) ⇒ SILENT, forever.
 *     Still observed: onHang({kind:'idle', reason:'waiting-input'}) + stats().
 *   · work pending (a gateway request / an operation guard is live) AND no
 *     output for the idle window ⇒ ONE line, naming what is pending and what
 *     the surface's own interrupt key is.
 *   · the SAME pending work silent again ⇒ no second line
 *     (reason:'same-episode'): a stuck request is news once, not every window.
 *
 * Two supporting fixes ride along, both measured (see .khy/feedback/
 * watchdog-idle-noise-20260926/):
 *   · the reported number is the TRUE idle duration (measured from the last
 *     activity), not "time since the guard was armed" — the old field said
 *     "会话已 2031.9s 无任何输出" for a 900s silence whenever output had
 *     happened in between (two clocks, one label);
 *   · a report's OWN echo must not re-arm the idle clock. The host renders the
 *     line (ink repaint = one stdout write) on a LATER tick than report(), so
 *     the synchronous `suppressTouch` flag never covered it: report → repaint →
 *     re-arm → report, self-powered, one line per idle window with the user
 *     doing nothing at all. `echoWindowMs` closes that loop across ticks.
 *
 * Handling is differentiated by what the probe actually found — the remedy for
 * a pending gateway request is not the remedy for a blocked event loop, and
 * "Ctrl+C 后重进" is not a remedy for a healthy session waiting for input.
 *
 * Sync-stall notice policy (2026-09-23): a sync stall that already recovered is
 * the definition of imperceptible — nothing to do, nobody to warn. Reporting
 * each one turned the transcript into noise (a real session printed
 * "事件循环曾阻塞 123.5s … 现已恢复调度。" twice within minutes). So the
 * `quiet` default (KHY_WATCHDOG_STALL_NOTICE=quiet) only speaks when the
 * pattern is a signal:
 *   · fewer than `stallRepeat` (3) stalls in a `stallWindowMs` (10 min) window
 *     AND each one shorter than `stallAlertMs` (300 s) ⇒ no line at all;
 *   · `stallRepeat` reached inside the window ⇒ ONE merged line (次数/最长/累计);
 *   · a single stall ≥ `stallAlertMs` ⇒ one immediate line — a multi-minute
 *     freeze is not "imperceptible" by any reading.
 * Nothing is lost while quiet: every stall still reaches `onHang`
 * ({kind:'stall'}) and the running totals stay readable via `stats()`.
 * `=all` restores the old per-stall line byte for byte; `=off` never prints.
 *
 * Gates: KHY_SESSION_WATCHDOG (default on), idle window
 * KHY_SESSION_WATCHDOG_IDLE_MIN (default 15 minutes), stall threshold
 * KHY_SESSION_WATCHDOG_STALL_MS (default 5000), stall notice mode
 * KHY_WATCHDOG_STALL_NOTICE (quiet|all|off, default quiet). Idempotent per
 * process (Symbol lock) so TUI → classic-REPL fallback double-install is safe.
 *
 * Host seams for the async-hang judgment (all optional, all fail-soft):
 * `opts.isBusy()` (host's own "a turn is in flight" — an ADDITIONAL opinion,
 * never a replacement for the built-in probes), `opts.interruptHint` (the
 * surface's own interrupt verb, e.g. 'esc 中断' in the TUI / 'Ctrl+C 中断' in the
 * classic REPL — the watchdog owns the judgment, the host owns its keyboard),
 * `opts.echoWindowMs` (how long after a report its own repaint is not activity).
 */

const WATCHDOG_INSTALLED_KEY = Symbol.for('khy.sessionWatchdog.installed');

const DEFAULT_SAMPLE_MS = 30_000;
const DEFAULT_STALL_MS = 5_000;
const DEFAULT_IDLE_MIN = 15;

// Sync-stall notice policy (see the header). Kept as constants rather than a
// fresh family of KHY_* gates on purpose: the only user-facing knob that earns
// its keep is the mode itself (`all` for "I want every one", `off` for "never"),
// and every extra gate name is a maintenance surface. Tests inject the numbers
// through the same `opts` seams the timings already use.
const DEFAULT_STALL_REPEAT = 3;
const DEFAULT_STALL_WINDOW_MS = 10 * 60_000;
const DEFAULT_STALL_ALERT_MS = 300_000;
const STALL_NOTICE_MODES = ['quiet', 'all', 'off'];

// How long after a report its own echo (the host repainting the line we just
// handed it) is treated as NOT activity. Covers ink's next-tick repaint, which
// the synchronous suppressTouch flag structurally cannot. Cheap: a report only
// happens after a whole idle window of silence, so the window can be generous.
const DEFAULT_ECHO_WINDOW_MS = 2_000;

function _gateEnabled(env) {
  const raw = String((env && env.KHY_SESSION_WATCHDOG) || 'true').toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off');
}

/**
 * Resolve the sync-stall notice mode. Unknown / empty ⇒ 'quiet' (the new
 * default); `all` and `off` are honoured case-insensitively so the escape
 * hatch behaves like every other KHY_* gate in the repo.
 */
function _stallNoticeMode(env) {
  const raw = String((env && env.KHY_WATCHDOG_STALL_NOTICE) || '')
    .trim()
    .toLowerCase();
  return STALL_NOTICE_MODES.includes(raw) ? raw : 'quiet';
}

function _resolvePositiveNumber(env, key, fallback) {
  try {
    const raw = env && env[key];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      return fallback;
    }
    const n = Number(String(raw).trim());
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

function _activeHandleSummary() {
  try {
    if (typeof process._getActiveHandles !== 'function') {
      return null;
    }
    const handles = process._getActiveHandles();
    const byType = {};
    for (const h of handles) {
      const t = (h && h.constructor && h.constructor.name) || typeof h;
      byType[t] = (byType[t] || 0) + 1;
    }
    return { count: handles.length, byType };
  } catch {
    return null;
  }
}

/**
 * Typed, compact handle breakdown. A bare count ("活动句柄 5 个") cannot be acted
 * on; naming the types is what turns a number into a clue.
 */
function _handleText(handles) {
  if (!handles || !handles.byType) {
    return '';
  }
  return Object.keys(handles.byType)
    .sort((a, b) => handles.byType[b] - handles.byType[a])
    .slice(0, 4)
    .map((t) => `${t}×${handles.byType[t]}`)
    .join(' ');
}

/**
 * Is any work actually pending? Silence only evidences a hang when something
 * was waiting on it. Two built-in probes — both process-level singletons that
 * BOTH interactive surfaces already maintain, so no surface has to opt in:
 *
 *   · `cli/aiLocalState.activeGatewayRequests` — registered/unregistered around
 *     every gateway request by `aiGatewayClient`; non-empty ⇒ a model call is
 *     genuinely in flight right now.
 *   · `resourceGuard.getActiveOperations()` — the per-turn 'ai-chat' guard and
 *     every natural-tool guard. The 'session' guard is THIS watchdog; ignore it.
 *
 * `isBusy()` contributes the host's own opinion in addition. Fail-soft
 * everywhere: a broken probe degrades to "nothing pending" (silence) — it must
 * never be able to turn into an accusation.
 *
 * @param {function|null} isBusy - Host hook, `() => boolean`.
 * @returns {{busy:boolean, evidence:object[], signature:string, hostBusy:boolean}}
 */
function _pendingWork(isBusy) {
  const evidence = [];
  let hostBusy = false;
  if (typeof isBusy === 'function') {
    try {
      hostBusy = isBusy() === true;
    } catch {
      hostBusy = false;
    }
  }
  try {
    const map = require('../cli/aiLocalState').activeGatewayRequests;
    if (map && typeof map.size === 'number' && map.size > 0) {
      const now = Date.now();
      for (const [id, info] of map) {
        evidence.push({
          kind: 'request',
          id: String(id),
          adapter: String((info && info.adapter) || ''),
          ageMs: info && info.createdAt ? now - info.createdAt : 0,
        });
      }
    }
  } catch {
    /* probe unavailable — fail soft toward silence */
  }
  try {
    const ops = require('./resourceGuard').getActiveOperations() || [];
    for (const op of ops) {
      if (!op || op.name === 'session') {
        continue; // our own idle guard
      }
      evidence.push({
        kind: 'operation',
        name: String(op.name),
        idleMs: Math.max(0, Number(op.idleMs) || 0),
      });
    }
  } catch {
    /* probe unavailable — fail soft toward silence */
  }

  const busy = evidence.length > 0 || hostBusy;
  // Stable identity of the pending work: the SAME stuck item must not be
  // re-reported just because a repaint re-armed the guard.
  const signature = busy
    ? evidence.map((e) => (e.kind === 'request' ? e.id : e.name)).join(',') || 'host-busy'
    : '';
  return { busy, evidence, signature, hostBusy };
}

/** Human duration: seconds under a minute, then minutes, then hours. */
function _dur(ms) {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) {
    return `${s.toFixed(1)}s`;
  }
  if (s < 3600) {
    return `${(s / 60).toFixed(1)} 分钟`;
  }
  return `${(s / 3600).toFixed(1)} 小时`;
}

/**
 * The one line a pending-work silence earns. Shape: 动作 + 目标 + 进度, then a
 * remedy that matches what was actually found — never a blanket "Ctrl+C 后重进"
 * (that is destructive advice for a session that is merely waiting, and it was
 * exactly the line this replaces).
 *
 * @param {{silenceMs:number, work:object, handles:object|null, interruptHint:string}} p
 */
function _idleLine({ silenceMs, work, handles, interruptHint }) {
  const stop = `${interruptHint || '中断'}本轮（会话保留）`;
  const req = work.evidence.find((e) => e.kind === 'request');
  if (req) {
    const who = req.adapter ? `请求 ${req.id} · ${req.adapter}` : `请求 ${req.id}`;
    return (
      `[Watchdog] 静默 ${_dur(silenceMs)}（${who} 在途、无模型输出）— ` +
      `${stop}，或 khy gateway status 查通道。`
    );
  }
  const op = work.evidence.find((e) => e.kind === 'operation');
  if (op) {
    return (
      `[Watchdog] 静默 ${_dur(silenceMs)}（操作 ${op.name} 在途、无进展）— ${stop}。`
    );
  }
  // Pending work we cannot attribute. This is the only case where the old
  // escape hatch still applies: "the UI itself may be gone" is undiagnosed here.
  const handlesText = _handleText(handles);
  return (
    `[Watchdog] 静默 ${_dur(silenceMs)}（本轮在途，未捕获到具体请求/工具` +
    `${handlesText ? `；句柄 ${handlesText}` : ''}）— ` +
    `${stop}；界面完全无响应再 Ctrl+C，会话可用 khy resume 恢复。`
  );
}

/**
 * Install the session watchdog. Idempotent; fail-soft; the returned handle
 * exposes touch() (explicit activity feed for hosts), stats() (on-demand
 * diagnosis of what was observed — including everything kept off screen) and
 * stop() (tests).
 *
 * @param {object} [opts]
 * @param {object} [opts.env] - Env source (tests inject {}).
 * @param {object} [opts.logger] - Logger with .warn() (unused on hot path).
 * @param {function} [opts.onHang] - Host hook. Fires for EVERY observation,
 *   including every one that earns no line:
 *   `{kind:'idle', idleSeconds, reported, suppressed, reason, silenceMs, work,
 *   handles}` for an async-hang observation — `reason` is `'waiting-input'`
 *   (nothing pending: healthy, never narrated), `'work-pending'` (speaks) or
 *   `'same-episode'` (this work item already spoke) — and
 *   `{kind:'stall', stallSeconds, stallMs, reported, count}` for each sync
 *   stall — including the ones the quiet policy keeps off screen. This is the
 *   "observe without printing" channel: silence on the terminal is never
 *   silence for a host that subscribes.
 * @param {function} [opts.isBusy] - The host's own "a turn is in flight"
 *   opinion, OR-ed with the built-in probes (an addition, never a replacement).
 * @param {string} [opts.interruptHint] - The surface's own interrupt verb, used
 *   verbatim in the remedy (the Ink TUI passes `interruptHint.INTERRUPT_HINT_TEXT`
 *   = 'esc 中断', the classic REPL passes 'Ctrl+C 中断'). The watchdog owns the
 *   judgment; the host owns its keyboard.
 * @param {number} [opts.echoWindowMs] - For how long after a report the host's
 *   repaint of it is not activity (defeats the self-powered report loop).
 * @param {function} [opts.onReport] - Host sink for the diagnostic line itself;
 *   return `true` to take it over. Absent/refusal/throw ⇒ direct stderr write
 *   (the historical behaviour). Exists because a raw write while another
 *   renderer owns the terminal leaves a stray, never-erased row.
 * @param {number} [opts.sampleMs] - Sampler period (tests shrink this).
 * @param {number} [opts.stallMs] - Min event-loop block to observe.
 * @param {number} [opts.idleLimitMs] - Idle window before the hang report.
 * @param {number} [opts.stallRepeat] - Stalls within the window that make the
 *   pattern a signal worth one merged line (default 3).
 * @param {number} [opts.stallWindowMs] - Window for that repeat count (default 10 min).
 * @param {number} [opts.stallAlertMs] - A single stall this long is reported
 *   immediately regardless of count (default 300 s).
 * @param {'quiet'|'all'|'off'} [opts.stallNotice] - Notice policy override
 *   (default from KHY_WATCHDOG_STALL_NOTICE, itself defaulting to 'quiet').
 */
function installSessionWatchdog(opts = {}) {
  if (globalThis[WATCHDOG_INSTALLED_KEY]) {
    return { ok: true, reason: 'already-installed' };
  }
  const env = opts.env || process.env;
  if (!_gateEnabled(env)) {
    return { ok: true, reason: 'gate-off' };
  }
  globalThis[WATCHDOG_INSTALLED_KEY] = true;

  const onHang = typeof opts.onHang === 'function' ? opts.onHang : null;
  const onReport = typeof opts.onReport === 'function' ? opts.onReport : null;
  const isBusy = typeof opts.isBusy === 'function' ? opts.isBusy : null;
  const interruptHint =
    typeof opts.interruptHint === 'string' ? opts.interruptHint.trim() : '';
  const echoWindowMs = opts.echoWindowMs || DEFAULT_ECHO_WINDOW_MS;
  const sampleMs =
    opts.sampleMs ||
    _resolvePositiveNumber(env, 'KHY_SESSION_WATCHDOG_SAMPLE_MS', DEFAULT_SAMPLE_MS);
  const stallMs =
    opts.stallMs ||
    _resolvePositiveNumber(env, 'KHY_SESSION_WATCHDOG_STALL_MS', DEFAULT_STALL_MS);
  const idleLimitMs =
    opts.idleLimitMs ||
    _resolvePositiveNumber(env, 'KHY_SESSION_WATCHDOG_IDLE_MIN', DEFAULT_IDLE_MIN) * 60_000;
  const stallNoticeMode = STALL_NOTICE_MODES.includes(opts.stallNotice)
    ? opts.stallNotice
    : _stallNoticeMode(env);
  const stallRepeat = opts.stallRepeat || DEFAULT_STALL_REPEAT;
  const stallWindowMs = opts.stallWindowMs || DEFAULT_STALL_WINDOW_MS;
  const stallAlertMs = opts.stallAlertMs || DEFAULT_STALL_ALERT_MS;

  const { startWatchdog } = require('./resourceGuard');

  let guard = null;
  let guardFired = false;
  let suppressTouch = false;
  let stopped = false;
  // Async-hang bookkeeping (2026-09-26). `lastProgressAt` is the ONLY clock an
  // idle report may quote: resourceGuard's `elapsed` argument is "since this
  // guard was armed", which overstates the silence by the whole active period
  // whenever there was output in between. `suppressTouchUntil` spans ticks so a
  // report's own echo — the host repainting it after report() returned — cannot
  // re-arm the very clock it reported on. `spokenSignature` identifies the
  // pending work already reported, so one stuck item is news exactly once.
  let lastProgressAt = Date.now();
  let suppressTouchUntil = 0;
  let spokenSignature = '';
  /** @type {{stream: any, original: function, patched: function}[]} */
  const streamPatches = [];

  function report(line) {
    // Our own diagnostic writes must not reset the idle clock they report on —
    // neither synchronously (suppressTouch) nor by their echo (§ above).
    suppressTouch = true;
    suppressTouchUntil = Date.now() + echoWindowMs;
    try {
      // A host that owns the terminal (the Ink TUI) may take the line instead —
      // a raw stderr write while ink owns the screen is never erased by its
      // frame ledger and leaves a permanent stray row (BUG-17). Only an
      // explicit `true` counts as taken; anything else (absent hook, refusal,
      // throw) falls back to the historical direct write so the diagnosis is
      // never silently lost.
      if (onReport) {
        let taken = false;
        try {
          taken = onReport(line) === true;
        } catch {
          taken = false;
        }
        if (taken) {
          return;
        }
      }
      process.stderr.write(`${line}\n`);
    } catch {
      /* sink broken — nothing to do */
    } finally {
      suppressTouch = false;
    }
  }

  // ── Observation ledgers ────────────────────────────────────────────────
  // Everything the watchdog sees is recorded here whether or not it is worth a
  // line on screen. `stats()` reads them back, so the quiet policy trades
  // verbosity for latency, never for information.
  const ledger = {
    stallCount: 0,
    stallTotalMs: 0,
    stallMaxMs: 0,
    stallReported: 0,
    idleReports: 0,
    // Idle observations, split by what the judgment concluded. `idleReports` is
    // the honest total (every fire); the three below say where the lines went.
    idleReported: 0,
    idleSuppressed: 0,
    idleWaitingInput: 0,
  };
  // Current "burst" of stalls: reset when the window rolls over. `reported`
  // makes the merged line fire at most once per burst.
  let burst = { startAt: 0, count: 0, totalMs: 0, maxMs: 0, reported: false };

  function arm() {
    if (stopped) {
      return;
    }
    guardFired = false;
    // `quiet: true` — this module owns the notification for the session guard:
    // ResourceGuard's own warning would be a second line about one event, and it
    // fires for a merely-idle session too (the exact false positive this fix is
    // about). Nothing is lost: every observation still reaches onHang/stats().
    guard = startWatchdog(
      'session',
      idleLimitMs,
      (_name, _armedSeconds, idleMs) => {
        guardFired = true;
        ledger.idleReports += 1;

        // The judgment is deliberately TWO-stage: silence is only evidence of a
        // hang when something was waiting on it. See the header.
        const work = _pendingWork(isBusy);
        // Prefer the primitive's own measurement: it is taken before any of the
        // fire path's own output. Our clock is the fallback (and the one an
        // explicit host touch() feeds).
        const silenceMs = Number.isFinite(idleMs)
          ? Math.max(0, idleMs)
          : Math.max(0, Date.now() - lastProgressAt);
        const handles = _activeHandleSummary();

        let reported = false;
        let reason;
        if (!work.busy) {
          // Healthy steady state: the turn finished, the session sits at the
          // prompt waiting for a human. Observed, never narrated.
          reason = 'waiting-input';
          spokenSignature = ''; // the episode is over; a later one may speak again
          ledger.idleWaitingInput += 1;
        } else if (work.signature === spokenSignature) {
          reason = 'same-episode'; // this stuck item already had its line
          ledger.idleSuppressed += 1;
        } else {
          reason = 'work-pending';
          reported = true;
        }

        if (reported) {
          spokenSignature = work.signature;
          ledger.idleReported += 1;
          report(_idleLine({ silenceMs, work, handles, interruptHint }));
        }

        if (onHang) {
          try {
            onHang({
              kind: 'idle',
              idleSeconds: Number((silenceMs / 1000).toFixed(1)),
              silenceMs,
              reported,
              suppressed: !reported,
              reason,
              work,
              handles,
            });
          } catch {
            /* host hook must never break the watchdog */
          }
        }
      },
      { quiet: true }
    );
  }

  const seconds = (ms) => (ms / 1000).toFixed(1);

  /**
   * A sync stall was observed. Decide whether it earns a line (see the header
   * policy): quiet by default, one merged line once a burst repeats, one
   * immediate line when a single stall is long enough to be felt.
   *
   * @param {number} driftMs - How long the loop was actually blocked.
   */
  function recordStall(driftMs) {
    const now = Date.now();
    if (now - burst.startAt > stallWindowMs) {
      burst = { startAt: now, count: 0, totalMs: 0, maxMs: 0, reported: false };
    }
    burst.count += 1;
    burst.totalMs += driftMs;
    burst.maxMs = Math.max(burst.maxMs, driftMs);
    ledger.stallCount += 1;
    ledger.stallTotalMs += driftMs;
    ledger.stallMaxMs = Math.max(ledger.stallMaxMs, driftMs);

    const single = `[Watchdog] 事件循环曾阻塞 ${seconds(driftMs)}s（同步长任务或死循环嫌疑），现已恢复调度。`;
    let reported = false;
    if (stallNoticeMode === 'all') {
      reported = true;
    } else if (stallNoticeMode === 'off') {
      reported = false;
    } else if (driftMs >= stallAlertMs) {
      reported = true; // 几分钟的冻结谈不上「无感」——单次也要说话
    } else if (!burst.reported && burst.count >= stallRepeat) {
      reported = true; // 成串 ⇒ 是信号，合并成一行
    }

    if (reported) {
      if (stallNoticeMode === 'all' || driftMs >= stallAlertMs) {
        report(single);
      } else {
        const windowLabel =
          stallWindowMs >= 60_000
            ? `近 ${Math.round(stallWindowMs / 60_000)} 分钟`
            : `近 ${Math.round(stallWindowMs / 1000)} 秒`;
        report(
          `[Watchdog] 事件循环${windowLabel}内阻塞 ${burst.count} 次` +
            `（最长 ${seconds(burst.maxMs)}s，累计 ${seconds(burst.totalMs)}s；同步长任务或死循环嫌疑），` +
            `均已自动恢复调度（同窗口内后续同类阻塞不再逐条上屏；如需逐次可见设 KHY_WATCHDOG_STALL_NOTICE=all）。`
        );
      }
      ledger.stallReported += 1;
      burst.reported = true;
    }

    if (onHang) {
      try {
        onHang({
          kind: 'stall',
          stallSeconds: Number(seconds(driftMs)),
          stallMs: driftMs,
          reported,
          count: burst.count,
          suppressed: !reported,
        });
      } catch {
        /* host hook must never break the watchdog */
      }
    }
  }

  function touch() {
    try {
      if (stopped) {
        return;
      }
      // Explicit activity: a host calling touch() always counts, even inside an
      // echo window (only the WRITE PATCH is echo-filtered — that one is the
      // path our own report travels back on).
      lastProgressAt = Date.now();
      if (guardFired || !guard) {
        arm(); // re-arm for the next idle episode
      }
      if (guard) {
        guard.touch();
      }
    } catch {
      /* activity tracking must never break the write path */
    }
  }

  // Activity = any user-visible output on the session surfaces. Patching
  // .write (not touching stdin) keeps ink's raw-mode ownership intact.
  for (const stream of [process.stdout, process.stderr]) {
    try {
      if (!stream || typeof stream.write !== 'function') {
        continue;
      }
      const original = stream.write;
      const patched = function watchdogPatchedWrite(chunk, encoding, cb) {
        // A write inside the post-report echo window is (in all likelihood) the
        // host repainting the line we just handed it — not the session making
        // progress. Counting it would re-arm the idle clock and turn one report
        // into one report per idle window, forever, with the user doing nothing.
        if (!suppressTouch && Date.now() >= suppressTouchUntil) {
          touch();
        }
        return original.call(stream, chunk, encoding, cb);
      };
      stream.write = patched;
      streamPatches.push({ stream, original, patched });
    } catch {
      /* odd stream — watchdog degrades, session unaffected */
    }
  }

  arm();

  // Sync-stall detector: a blocked loop delays this beat; the drift IS the
  // stall duration. Observed AFTER the block ends (during it nothing runs).
  // Whether an observation becomes a line is recordStall()'s decision.
  let lastBeatAt = Date.now();
  const stallTimer = setInterval(() => {
    try {
      const now = Date.now();
      const drift = now - (lastBeatAt + sampleMs);
      lastBeatAt = now;
      if (drift >= stallMs) {
        recordStall(drift);
      }
    } catch {
      /* watchdog must never throw into the event loop */
    }
  }, sampleMs);
  if (typeof stallTimer.unref === 'function') {
    stallTimer.unref();
  }

  return {
    ok: true,
    reason: 'installed',
    touch,
    /**
     * On-demand diagnosis. The quiet policies never drop an observation — they
     * only keep it off the transcript — so `stallCount` / `idleReports` are the
     * honest totals while `stallReported` / `idleReported` are how many lines
     * the user actually saw. `idleWaitingInput` is the false-positive class this
     * judgment exists to keep quiet: sessions that were merely waiting for a
     * human. `work` is the pending-work probe's live answer.
     */
    stats() {
      return {
        mode: stallNoticeMode,
        idleReports: ledger.idleReports,
        idleReported: ledger.idleReported,
        idleSuppressed: ledger.idleSuppressed,
        idleWaitingInput: ledger.idleWaitingInput,
        work: _pendingWork(isBusy),
        stalls: {
          count: ledger.stallCount,
          maxMs: ledger.stallMaxMs,
          totalMs: ledger.stallTotalMs,
          reported: ledger.stallReported,
          suppressed: ledger.stallCount - ledger.stallReported,
        },
      };
    },
    stop() {
      stopped = true;
      clearInterval(stallTimer);
      try {
        if (guard) {
          guard.done();
        }
      } catch {
        /* ignore */
      }
      // Give the stream writes back. Without this the patched .write stays on
      // the process forever: every later write keeps re-arming a new idle
      // guard (the diagnostic itself is a write), so a stopped watchdog goes on
      // reporting, and a test run inherits the leftovers of its predecessors.
      // Only unwrap our own patch — if someone patched over us since, their
      // layer stays in place and drops out when it is removed.
      for (const patch of streamPatches) {
        try {
          if (patch.stream && patch.stream.write === patch.patched) {
            patch.stream.write = patch.original;
          }
        } catch {
          /* odd stream — leave it as is */
        }
      }
      streamPatches.length = 0;
      globalThis[WATCHDOG_INSTALLED_KEY] = false;
    },
  };
}

/** Test seam: forget the per-process install lock. */
function resetForTest() {
  globalThis[WATCHDOG_INSTALLED_KEY] = false;
}

module.exports = {
  installSessionWatchdog,
  resetForTest,
};
