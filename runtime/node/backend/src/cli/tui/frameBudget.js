'use strict';

/**
 * frameBudget.js — rolling per-frame render-time guard for the ink TUI.
 *
 * Pure leaf: zero IO on the hot path, deterministic, never throws, env-gated.
 * Closes the gap where AGENTS.md §0.3 documents a "< 16ms single render" floor
 * but nothing in the render path actually measured it. ink 6.8.0 already emits
 * `options.onRender({ renderTime })` (ink.js:252); app.js feeds that into
 * `record()` here and the guard reports a rolling window of frame times.
 *
 * What it does:
 *   - record(renderTimeMs): append to a bounded rolling window, O(1) amortized
 *     (window is a fixed-size ring; pN is computed lazily on demand, not per
 *     frame, so the hot path stays near-zero cost).
 *   - stats(): p50 / p95 / p99 / max / count over the window.
 *   - overBudget(): whether p95 exceeds the budget (SSOT perfTunables.frameBudgetMs).
 *   - A one-time degraded-warning hook so a budget breach is surfaced ONCE to
 *     stderr (the TUI owns stdout), not spammed every frame.
 *
 * Folding contract (2026-10-12, P0-9b): the breach notice is COLLAPSED BY DEFAULT.
 * On a clean start the rolling window is still filling (boot frames), so p95 blew
 * past the 16ms floor on every launch and the raw line (`p95=244.4ms > 预算 16ms`
 * + "tune KHY_TUI_FRAME_BUDGET_MS" + streaming/re-render jargon) reached the user
 * on stderr, sharing the TTY with the TUI. Nothing there is actionable for a user,
 * and it reads as a defect report. It now prints ONLY when a debug switch is on
 * (KHY_TUI_DIAG / KHY_TUI_DIAG_H / KHY_TUI_DIAG_FRAME / KHY_VERBOSE — all
 * pre-existing, see VERBOSE_ENV_KEYS), or when the caller injects `verbose: true`.
 * `stats()` stays available to the scorecard / ratchet either way, so no
 * observability is lost — only the default user-facing noise is.
 *
 * Ratchet baseline: the guard can be told to compare the current window p95
 * against a committed `tui-perf-baseline.json` (only-gets-better, mirroring
 * ruleguard-baseline.json). Absent file / absent repoRoot = no ratchet, the
 * guard still reports and warns on the absolute budget.
 */

const DEFAULT_WINDOW = 120; // ~2s at 60fps; enough for a stable p95
const MAX_RING = 4096; // hard cap so an extremely long session can't grow unbounded

// Debug switches that opt IN the (default-collapsed) technical breach notice.
// Deliberately reuses EXISTING switches (no new env token — DESIGN-ARCH-102 H7 caps
// the unique KHY_* gates in this directory): KHY_TUI_DIAG / KHY_TUI_DIAG_H /
// KHY_TUI_DIAG_FRAME are this directory's stderr diagnostics family, KHY_VERBOSE is
// the TUI-wide "show me why" flag (App.js). Default off, never a behavior branch.
const VERBOSE_ENV_KEYS = ['KHY_TUI_DIAG', 'KHY_TUI_DIAG_H', 'KHY_TUI_DIAG_FRAME', 'KHY_VERBOSE'];

/** Truthy env value ('1' / 'true' / 'yes' / 'on'); anything else is off. */
function _flagOn(raw) {
  const v = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Create a frame-budget guard. Pure — no IO. Pass `budgetMs` (from
 * perfTunables.frameBudgetMs) so the guard does not re-parse env itself.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowSize=120]
 * @param {number} [opts.budgetMs=16]
 * @param {object} [opts.sink] - `{ warn(msg) }` for the one-time breach notice
 *   (defaults to a no-op; app.js injects a stderr sink so stdout stays clean).
 * @param {object} [opts.env] - env bag for the verbose gate (defaults to process.env).
 * @param {boolean} [opts.verbose] - explicit override of the verbose gate
 *   (wins over env; lets callers/tests force the technical notice on).
 * @returns {object} guard
 */
function createGuard(opts = {}) {
  const cap = Math.min(Math.max(1, Math.floor(opts.windowSize || DEFAULT_WINDOW)), MAX_RING);
  const budgetMs = Number.isFinite(opts.budgetMs) && opts.budgetMs > 0 ? opts.budgetMs : 16;
  const sink = opts.sink && typeof opts.sink.warn === 'function' ? opts.sink : { warn() {} };
  // Read the gate ONCE at construction (never per frame): the env bag is injected
  // so the fold decision stays testable without touching process.env.
  const env = opts.env || process.env;
  const verbose =
    opts.verbose === undefined ? VERBOSE_ENV_KEYS.some((k) => _flagOn(env[k])) : !!opts.verbose;

  const ring = new Float64Array(cap);
  let head = 0;
  let size = 0;
  let warned = false;

  /** Append a single frame duration (ms). Clamped to >= 0, finite. */
  function record(renderTimeMs) {
    const v = Number.isFinite(renderTimeMs) ? Math.max(0, renderTimeMs) : 0;
    ring[head] = v;
    head = (head + 1) % cap;
    if (size < cap) size += 1;
  }

  /** Percentile over the current window (nearest-rank). Empty window -> 0. */
  function percentile(pct) {
    if (size === 0) return 0;
    const p = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 95;
    const sorted = snapshot().sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length);
    const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
    return sorted[idx];
  }

  function snapshot() {
    const out = new Array(size);
    for (let i = 0; i < size; i++) {
      out[i] = ring[(head - size + i + cap) % cap];
    }
    return out;
  }

  function max() {
    let m = 0;
    for (let i = 0; i < size; i++) {
      const v = ring[(head - size + i + cap) % cap];
      if (v > m) m = v;
    }
    return m;
  }

  /**
   * Current rolling stats. Cheap: one pass to snapshot + one sort (only called
   * on demand by the scorecard / ratchet, NOT per frame).
   * @returns {{p50: number, p95: number, p99: number, max: number, count: number,
   *   overBudget: boolean, budgetMs: number}}
   */
  function stats() {
    const p95 = percentile(95);
    return {
      p50: percentile(50),
      p95,
      p99: percentile(99),
      max: max(),
      count: size,
      overBudget: p95 > budgetMs,
      budgetMs,
    };
  }

  /**
   * Emit the ONE-TIME budget-breach warning. Callers invoke this from a
   * low-frequency heartbeat (e.g. the 1s/2s status timer), never per frame.
   * Fail-soft: never throws, never writes to stdout.
   *
   * COLLAPSED BY DEFAULT (P0-9b): only emitted when the verbose gate is on.
   * The technical line names env knobs and render-path internals, which is
   * debug-channel material — a user cannot act on it and it reads as a defect.
   */
  function maybeWarn() {
    if (warned || !verbose) return;
    const s = stats();
    if (s.count < 2 || !s.overBudget) return;
    warned = true;
    sink.warn(
      `[tui:frame] 渲染帧超预算：p95=${s.p95.toFixed(1)}ms > 预算 ${s.budgetMs}ms ` +
        `(窗口 ${s.count} 帧, max=${s.max.toFixed(1)}ms)。` +
        `调试信息：可调大 KHY_TUI_FRAME_BUDGET_MS，或排查流式批量/重渲染热点；` +
        `本行仅在开启 KHY_TUI_DIAG 等调试开关时输出。`
    );
  }

  /** Whether the technical breach notice is armed (verbose gate). Test/DI only. */
  function isVerbose() {
    return verbose;
  }

  /** Test-only: force re-arm so a second breach can be asserted. */
  function reset() {
    head = 0;
    size = 0;
    ring.fill(0);
    warned = false;
  }

  return { record, stats, maybeWarn, reset, isVerbose };
}

module.exports = { createGuard, DEFAULT_WINDOW, MAX_RING, VERBOSE_ENV_KEYS };
