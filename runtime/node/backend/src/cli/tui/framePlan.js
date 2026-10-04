'use strict';

// framePlan.js — pure leaf (zero IO, deterministic, never throws).
//
// Stage P2 of the frame pipeline ([DESIGN-ARCH-156] §3.1): the ONE place that
// turns "how tall is the terminal and what is on screen" into a single
// immutable geometry decision that every later stage consumes. Before this
// module the same inequality (`live region < rows`) was approached by five
// controllers that never talk to each other (see [DESIGN-ARCH-156] §1.1).
//
// Two properties make it a contract rather than another helper:
//   1. Rows are charged ONLY from chromeRegistry — no caller may hand-assemble
//      a sum, so the ledger cannot drift from what is painted.
//   2. H1 (`frame height <= rows - 1`) is ASSERTED against the finished plan
//      instead of being baked into the subtraction the way
//      chromeBudget.liveBudget() does it (that `- 1` is now the registry's
//      `inkTrailer` entry; keeping both would double-charge).
//
// All heights are VISUAL rows (soft-wrap and CJK/emoji aware). ink counts
// LOGICAL rows (`output.split('\n').length`, AGENTS.md 0.9.2); that conversion
// happens exactly once, at the commit boundary in frameWriter (stage P6), and
// `inkOutputHeight` is where a caller reports ink's own back-counting so the
// plan and the measurement can be diffed in the frame ledger.
//
// S0 status: nothing consumes this plan yet. ink-components/App.js keeps its
// inline ledger until stage S2, which is also why the gate defaults to on —
// flipping `KHY_FRAME_PLAN=0` is the S2 byte-for-byte escape hatch.

const chromeRegistry = require('./chromeRegistry');

const OFF_VALUES = ['0', 'false', 'off', 'no'];
const ROW_UNIT = 'visualRow';
const FALLBACK_ROWS = 24;
const FALLBACK_COLS = 80;
// Below this many terminal rows the fixed chrome physically does not fit, so
// no arithmetic can keep the frame under rows - 1. AGENTS.md 0.9.2 measures the
// floor at ~14 rows (13 borderline). This is reported, not hidden.
const MIN_USABLE_ROWS = 14;
// Live region floor: a transcript viewport shorter than this is not worth
// painting. Same value chromeBudget pins as LIVE_MIN.
const LIVE_MIN = 3;

/**
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  const raw = env && env.KHY_FRAME_PLAN;
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  return !OFF_VALUES.includes(v);
}

function _int(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

function _entryRows(charged, id) {
  const e = (charged.entries || []).find((x) => x.id === id);
  return e ? e.rows : 0;
}

/**
 * The only legal repaint reasons. `incremental` is the steady state; anything
 * that says `full` is an explicit, logged decision (a resize reflow, or a frame
 * that already overflowed) — never a side effect of touching ink internals.
 */
const REPAINT_REASONS = Object.freeze({
  incremental: null,
  'resize-cols': 'full',
  'resize-rows': 'full',
  'h1-overflow': 'full',
  'expand-state': 'full',
});

/**
 * Build the commit intent for one frame. Returned to stage P6, which is the
 * only module allowed to translate it into ink internals.
 * @param {string|null} [reason] one of REPAINT_REASONS keys
 * @returns {{ repaint: 'incremental'|'full', reason: string|null }}
 */
function makeCommitPlan(reason = null) {
  if (!Object.prototype.hasOwnProperty.call(REPAINT_REASONS, reason)) {
    return { repaint: 'incremental', reason: null };
  }
  return { repaint: REPAINT_REASONS[reason] || 'incremental', reason };
}

/**
 * Plan one frame.
 *
 * @param {{
 *   rows?: *, cols?: *, layout?: 'legacy'|'preview',
 *   inputRows?: *, taskLineCount?: *, taskHiddenNotice?: *, approvalRows?: *,
 *   completionRows?: *, busy?: boolean, awaitingUserChoice?: boolean,
 *   hint?: boolean, revSearch?: boolean, overlay?: string|null,
 *   inkOutputHeight?: *, contentVisualRows?: *
 * }} [input]
 * @returns {Readonly<object>} FrameGeometry
 */
function planFrame(input = {}) {
  const i = input || {};
  const rows = _int(i.rows, FALLBACK_ROWS);
  const cols = _int(i.cols, FALLBACK_COLS);
  const layout =
    i.layout === chromeRegistry.PREVIEW ? chromeRegistry.PREVIEW : chromeRegistry.LEGACY;

  const charged = chromeRegistry.charge({ ...i, layout });
  const budget = rows - charged.total;
  const viewportHeight = Math.max(LIVE_MIN, budget);

  const notes = [];
  if (!Number.isFinite(Number(input.rows)) || Number(input.rows) <= 0) {
    notes.push(`rows unreadable, planned at ${FALLBACK_ROWS}`);
  }
  if (rows < MIN_USABLE_ROWS) {
    notes.push(`terminal is ${rows} rows, fixed chrome needs ${charged.total}`);
  }

  // H1 asserted against what is PAINTED. conptySlack and inkTrailer are
  // `reserve`: they consume budget but never appear as content, so charging
  // them as paint double-counts (chromeBudget draws the same distinction).
  const painted = viewportHeight + charged.paintTotal;
  const h1Holds = painted <= rows - 1;
  // Line count ink derives from the frame it receives (`output` + its trailing
  // newline). `>= rows` is precisely the branch that triggers ink's
  // clearTerminal + fullStaticOutput reprint.
  const trailerRows = _entryRows(charged, 'inkTrailer');
  const inkLineCount = painted + trailerRows;
  const reprintAvoided = inkLineCount < rows;
  if (!h1Holds) {
    notes.push(`H1 violated: painted ${painted} > rows-1 ${rows - 1}`);
  }
  if (!reprintAvoided) {
    notes.push(`ink would reprint: line count ${inkLineCount} >= rows ${rows}`);
  }

  const plan = {
    unit: ROW_UNIT,
    rows,
    cols,
    layout,
    chrome: charged,
    live: {
      budget,
      min: LIVE_MIN,
      allowedMax: Math.max(0, rows - 1),
    },
    viewport: { height: viewportHeight },
    overlay: i.overlay ? String(i.overlay) : null,
    content: {
      visualRows: Number.isFinite(Number(i.contentVisualRows))
        ? Math.max(0, Math.floor(Number(i.contentVisualRows)))
        : 0,
    },
    // Stage P6's only input: what to do about repaint, and how many visual rows
    // to hand ink. Never derived from painted height > rows (that IS the bug).
    intent: i.inkOverflow === true ? makeCommitPlan('h1-overflow') : makeCommitPlan(null),
    measured:
      Number.isFinite(Number(i.inkOutputHeight)) && Number(i.inkOutputHeight) > 0
        ? { inkOutputHeight: Math.floor(Number(i.inkOutputHeight)) }
        : null,
    overflow:
      h1Holds && reprintAvoided
        ? null
        : {
            // Rows the frame must shed to become legal. With any reserve at all,
            // `viewport + paint` cannot exceed rows-1 on its own — so a non-zero
            // figure here means LIVE_MIN won over H1 (the frame was inflated to the
            // floor). Reported instead of hidden under a clamped number.
            rows: Math.max(painted - (rows - 1), inkLineCount - (rows - 1), 0),
            reason: budget < LIVE_MIN ? 'live-floor-raised-frame' : 'ledger-mismatch',
          },
    diag: { h1Holds, painted, inkLineCount, reprintAvoided, notes },
  };

  return Object.freeze({
    ...plan,
    chrome: Object.freeze({
      entries: Object.freeze(charged.entries.map((e) => Object.freeze({ ...e }))),
      total: charged.total,
      paintTotal: charged.paintTotal,
      reserveTotal: charged.reserveTotal,
    }),
    live: Object.freeze(plan.live),
    viewport: Object.freeze(plan.viewport),
    content: Object.freeze(plan.content),
    intent: Object.freeze(plan.intent),
    measured: plan.measured ? Object.freeze(plan.measured) : null,
    overflow: plan.overflow ? Object.freeze(plan.overflow) : null,
    diag: Object.freeze({ ...plan.diag, notes: Object.freeze(plan.diag.notes) }),
  });
}

module.exports = {
  isEnabled,
  planFrame,
  makeCommitPlan,
  REPAINT_REASONS,
  ROW_UNIT,
  FALLBACK_ROWS,
  FALLBACK_COLS,
  MIN_USABLE_ROWS,
  LIVE_MIN,
};
