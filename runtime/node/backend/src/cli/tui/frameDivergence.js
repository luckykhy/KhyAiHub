'use strict';

// frameDivergence.js — pure leaf (zero IO, deterministic, never throws).
//
// Stage S0 of [DESIGN-ARCH-156] §5: before anything is rewired, MEASURE how far
// apart the existing height controllers actually are. The design claims five of
// them chase one inequality (AGENTS.md 0.9.2, [DESIGN-ARCH-102] H1) while never
// reading each other's output. This module asks each one, for identical inputs,
// "how many rows may the live region have?" and reports the disagreement.
//
// Why that is the honest first step rather than a code sweep: if the max |delta|
// is 0 across the sweep, the premise is wrong and the plan should shrink to the
// registry alone (§5 S0 exit condition). A number, not a narrative.
//
// Sources compared (all via their real exported functions — no re-implemented
// arithmetic, which would add the very 4th copy this design exists to delete).
// They do NOT all answer the same question, and pretending otherwise produced
// the first false finding of this stage, so they are grouped by quantity:
//   LEDGER (rows the live region may take, same question as framePlan):
//     main     chromeBudget.liveBudget      (App.js:6483-6491 primary path)
//     fallback App.js:6492-6507 arithmetic  (the "同式兜底" copy)
//   PREDICTOR (rows a STREAMING block should reserve — a different consumer
//     that overlaps the ledger rather than replacing it; its delta is reported
//     as "rows the predictor spends that no registry entry can explain"):
//     c1       rows - liveRegionBudget.resolveStreamReserve     (feed-forward)
//     c12      c1 additionally reduced by resolveExtraReserve   (feed + feedback)
//   OVERLAY (body rows of a full-screen overlay, only when one is active):
//     c3       overlayLiveBudget.overlayBodyRows

const chromeRegistry = require('./chromeRegistry');
const framePlan = require('./framePlan');

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_FRAME_PLAN_DIVERGENCE;
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  return !OFF_VALUES.includes(v);
}

function _req(p) {
  try {
    return require(p);
  } catch {
    return null; // leaf absent (moved/renamed) → that source reports null, never a fake 0
  }
}

const _has = (v) => v !== null && v !== undefined;

function _num(v) {
  return Number.isFinite(Number(v)) ? Math.floor(Number(v)) : null;
}

function _rowsOf(i) {
  const n = Number(i && i.rows);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : framePlan.FALLBACK_ROWS;
}

/**
 * Map a charged registry ledger onto the untyped `shares` bag chromeBudget and
 * App.js speak. Lives here (one place) so the mapping itself is testable.
 * @param {object[]} entries
 * @returns {object}
 */
function sharesFrom(entries = []) {
  const by = {};
  for (const e of entries) by[e.id] = e.rows;
  const extra =
    (by.taskPanel || 0) +
    (by.planApproval || 0) +
    (by.completionMenu || 0) +
    (by.hintNotice || 0) +
    (by.revSearch || 0) +
    (by.topbar || 0) +
    (by.separator || 0);
  return {
    inputRows: by.promptFrame || 0,
    statusRows: by.footer || 0,
    streamingRows: by.spinnerBusy || 0,
    extraRows: extra,
    slack: by.conptySlack || 0,
    // NOTE: inkTrailer is intentionally NOT in shares — liveBudget() applies its
    // own `- 1` for it. Passing both would double-charge.
  };
}

/**
 * The App.js:6492-6507 fallback sum, expressed as the named terms it actually
 * uses. Deliberately does not copy the source line's literal `1`: those literal
 * rows are registry entries now, so a mismatch here is a real finding.
 * @param {object[]} entries
 * @param {number} rows
 * @returns {number}
 */
function fallbackHeight(entries, rows) {
  let charged = 0;
  for (const e of entries) charged += e.rows;
  return Math.max(3, rows - charged);
}

/**
 * Ask every source the same question for one frame.
 * @param {object} input see framePlan.planFrame + { platform?, env? }
 * @returns {object} { plan, main, fallback, c1, c12, c3, deltas, worst }
 */
function compareFrame(input = {}) {
  const i = input || {};
  const env = i.env || process.env;
  const lrbForCap = _req('./ink-components/liveRegionBudget');

  // Task panels reach the ledger ALREADY capped: App.js:6207 runs
  // capTaskLines(_rawTaskLines, rows) before anything computes a height, so a
  // sweep that charged the raw count would test a frame the TUI can never
  // build. `rawTaskLines` therefore goes through the same leaf the app uses.
  let taskLineCount = i.taskLineCount;
  let taskHiddenNotice = i.taskHiddenNotice;
  let cap = null;
  if (
    Number.isFinite(Number(i.rawTaskLines)) &&
    lrbForCap &&
    typeof lrbForCap.capTaskLines === 'function'
  ) {
    const n = Math.max(0, Math.floor(Number(i.rawTaskLines)));
    const fake = Array.from({ length: n }, () => '·');
    const capped = lrbForCap.capTaskLines(fake, _rowsOf(i), env);
    taskLineCount = Array.isArray(capped && capped.lines) ? capped.lines.length : n;
    taskHiddenNotice = (capped && capped.hidden) || 0;
    cap = lrbForCap.resolveTaskLineCap ? lrbForCap.resolveTaskLineCap(_rowsOf(i), env) : null;
  }

  const plan = framePlan.planFrame({ ...i, taskLineCount, taskHiddenNotice });
  const entries = plan.chrome.entries;
  const shares = sharesFrom(entries);

  const cb = _req('./chromeBudget');
  const lrb = lrbForCap;
  const olb = _req('./ink-components/overlayLiveBudget');

  const out = {
    rows: plan.rows,
    layout: plan.layout,
    overlay: plan.overlay,
    chromeTotal: plan.chrome.total,
    paintTotal: plan.chrome.paintTotal,
    entries: plan.chrome.entries,
    plan: plan.viewport.height,
    painted: plan.diag.painted,
    inkLineCount: plan.diag.inkLineCount,
    planH1Held: plan.diag.h1Holds,
    planReprintAvoided: plan.diag.reprintAvoided,
    h1Impossibility: plan.overflow ? plan.overflow.rows : 0,
    rawTaskLines: Number.isFinite(Number(i.rawTaskLines))
      ? Math.floor(Number(i.rawTaskLines))
      : null,
    taskLineCount: _has(taskLineCount) ? taskLineCount : null,
    taskHiddenNotice: _has(taskHiddenNotice) ? taskHiddenNotice : null,
    taskLineCap: typeof cap === 'number' && Number.isFinite(cap) ? cap : null,
    main: null,
    fallback: fallbackHeight(entries, plan.rows),
    c1: null,
    c12: null,
    c3: null,
    deltas: {},
  };

  if (cb && typeof cb.liveBudget === 'function') {
    out.main = _num(cb.liveBudget(plan.rows, shares));
  }

  if (lrb && typeof lrb.resolveStreamReserve === 'function') {
    const reserve =
      Number(
        lrb.resolveStreamReserve(
          {
            rows: plan.rows,
            toolCount: i.toolCount,
            taskLineCount,
            taskHasHiddenNotice: (taskHiddenNotice || 0) > 0,
            planActive: (i.approvalRows || 0) > 0,
            collabActive: !!i.collabActive,
            topicInFooter: !!i.topicInFooter,
            platform: i.platform || process.platform,
          },
          env
        )
      ) || 0;
    out.c1 = plan.rows - reserve;
    if (typeof lrb.resolveExtraReserve === 'function') {
      // Feedback needs a measured frame; the sweep is feed-forward-only unless the
      // caller supplies inkOutputHeight, in which case c12 is the honest pair.
      const extra =
        Number(
          lrb.resolveExtraReserve(
            {
              lastOutputHeight: i.inkOutputHeight,
              rows: plan.rows,
              prevExtra: 0,
            },
            env
          )
        ) || 0;
      out.c12 = plan.rows - reserve - extra;
      out.extraReserve = extra;
    }
  }

  if (plan.overlay && olb && typeof olb.overlayBodyRows === 'function') {
    out.c3 = _num(olb.overlayBodyRows(plan.rows, env));
  }

  const named = { main: out.main, fallback: out.fallback, c1: out.c1, c12: out.c12 };
  for (const [k, v] of Object.entries(named)) {
    if (!_has(v)) continue;
    out.deltas[k] = v - out.plan;
  }
  if (_has(out.c3)) out.deltas.c3 = out.c3 - out.plan;

  // `worst` and the H1 sweep compare only the sources that answer the SAME
  // question as the plan (live-region rows). c1/c12 are a different consumer —
  // their disagreement is reported separately as `predictorUnexplained`, and
  // mixing them in would re-manufacture the false finding this module exists
  // to replace with a number.
  const comparable = { main: out.main, fallback: out.fallback, c3: out.c3 };
  let worst = 0;
  let worstSource = null;
  for (const [k, v] of Object.entries(comparable)) {
    if (!_has(v)) continue;
    const d = v - out.plan;
    if (Math.abs(d) > Math.abs(worst)) {
      worst = d;
      worstSource = k;
    }
  }
  out.worst = { delta: worst, source: worstSource };
  // Paint semantics: a source's answer is legal when the rows it hands the
  // live region, plus the rows actually PAINTED as chrome, stay under rows-1.
  // Charging reserve rows (slack/trailer) here would flag every case.
  out.h1 = {
    planHolds: plan.diag.h1Holds,
    violators: Object.entries(comparable)
      .filter(([, v]) => _has(v) && v + plan.chrome.paintTotal > plan.rows - 1)
      .map(([k]) => k),
  };
  // The predictor's own reading of the finished frame: rows it withheld from
  // the live region that the registry has no entry for. Positive = the
  // feed-forward reserve spends rows nobody can point at in the ledger.
  out.predictorUnexplained = {
    c1: _has(out.c1) ? out.c1 - out.plan : null,
    c12: _has(out.c12) ? out.c12 - out.plan : null,
  };
  return out;
}

const DEFAULT_ROWS = [13, 14, 18, 24, 30, 40, 60];

function baseContexts() {
  return [
    { name: 'idle-empty', ctx: {} },
    { name: 'busy-1tool', ctx: { busy: true, toolCount: 1 } },
    { name: 'busy-manytools', ctx: { busy: true, toolCount: 9 } },
    // `rawTaskLines` mirrors how the app feeds the ledger: the cap leaf runs
    // first, so this is a long list that actually reaches the screen.
    { name: 'tasklist-3-raw', ctx: { busy: true, rawTaskLines: 3 } },
    { name: 'tasklist-12-raw', ctx: { busy: true, rawTaskLines: 12 } },
    { name: 'tasklist-40-raw', ctx: { busy: true, rawTaskLines: 40 } },
    { name: 'slash-completion', ctx: { completionRows: 13 } },
    { name: 'plan-approval', ctx: { approvalRows: 2, busy: true } },
    { name: 'hint+revsearch', ctx: { hint: true, revSearch: true } },
    { name: 'collab+topicfooter', ctx: { busy: true, collabActive: true, topicInFooter: true } },
    { name: 'overlay-modelpicker', ctx: { overlay: 'modelPicker', busy: false } },
  ];
}

/**
 * Sweep the sweep space and summarize the disagreement.
 * @param {{ rowsList?: number[], layouts?: string[], platforms?: string[], env?: object }} [opts]
 * @returns {{ cases: object[], stats: object, table: string[] }}
 */
function scan(opts = {}) {
  const o = opts || {};
  const env = o.env || process.env;
  const rowsList = Array.isArray(o.rowsList) && o.rowsList.length ? o.rowsList : DEFAULT_ROWS;
  const layouts =
    Array.isArray(o.layouts) && o.layouts.length
      ? o.layouts
      : [chromeRegistry.LEGACY, chromeRegistry.PREVIEW];
  const platforms =
    Array.isArray(o.platforms) && o.platforms.length ? o.platforms : ['linux', 'win32'];

  const cases = [];
  for (const layout of layouts) {
    for (const platform of platforms) {
      for (const c of baseContexts()) {
        for (const rows of rowsList) {
          cases.push({
            label: `${layout}/${platform}/${c.name}/rows=${rows}`,
            ...compareFrame({ rows, cols: 100, layout, platform, env, ...c.ctx }),
          });
        }
      }
    }
  }

  const stats = { cases: cases.length, bySource: {}, h1Violations: 0, overlayCases: 0 };
  for (const src of ['main', 'fallback', 'c1', 'c12', 'c3']) {
    const ds = cases.map((c) => c.deltas && c.deltas[src]).filter((v) => Number.isFinite(v));
    if (!ds.length) continue;
    const abs = ds.map(Math.abs);
    stats.bySource[src] = {
      n: ds.length,
      min: Math.min(...ds),
      max: Math.max(...ds),
      maxAbs: Math.max(...abs),
      nonzero: ds.filter((d) => d !== 0).length,
    };
  }
  // Sources that answer the plan's question: agreement here is the S0 exit
  // number for "is the ledger already single-owned".
  stats.ledgerAgreement = {
    main: cases.filter((c) => c.deltas.main === 0).length,
    fallback: cases.filter((c) => c.deltas.fallback === 0).length,
  };
  // Sources that answer a different question: how many rows they withhold that
  // no registry entry accounts for.
  const unexplained = cases
    .map((c) => c.predictorUnexplained && c.predictorUnexplained.c1)
    .filter((v) => Number.isFinite(v));
  stats.predictorUnexplained = unexplained.length
    ? {
        n: unexplained.length,
        min: Math.min(...unexplained),
        max: Math.max(...unexplained),
        nonzero: unexplained.filter((v) => v !== 0).length,
        // The predictor hands the stream block a NEGATIVE height: its reserve is
        // larger than the whole terminal. It has no floor of its own, so every
        // consumer downstream has to invent one.
        negative: cases.filter((c) => Number.isFinite(c.c1) && c.c1 < 0).length,
        // Positive = more rows granted than the ledger can pay for. This is the
        // dangerous direction: the frame overshoots instead of shrinking.
        permissive: unexplained.filter((v) => v > 0).length,
      }
    : null;
  // Does the FRAME each source would produce stay legal? This is the finding
  // that matters for H1/H2, and it is asserted against PAINTED rows.
  stats.h1Violations = cases.filter((c) => c.h1 && c.h1.violators.length).length;
  stats.h1ViolationSources = {};
  for (const c of cases) {
    for (const v of (c.h1 && c.h1.violators) || []) {
      stats.h1ViolationSources[v] = (stats.h1ViolationSources[v] || 0) + 1;
    }
  }
  stats.planH1Violations = cases.filter((c) => c.planH1Held === false).length;
  // H1 holds but ink would still reprint: the frame leaves ZERO rows for the
  // trailing newline ink appends. One row of margin, and it is the difference
  // between an incremental repaint and clearTerminal + fullStaticOutput.
  stats.trailerOnly = cases.filter(
    (c) => c.planH1Held === true && c.planReprintAvoided === false
  ).length;
  stats.planReprintRisk = cases.filter((c) => c.planReprintAvoided === false).length;
  stats.trailerOnlyCases = cases
    .filter((c) => c.planH1Held === true && c.planReprintAvoided === false)
    .slice(0, 8)
    .map((c) => `${c.label} painted=${c.painted}=rows-1 inkLines=${c.inkLineCount}`);
  stats.overlayCases = cases.filter((c) => c.overlay).length;
  stats.worstCase = cases.reduce(
    (a, c) =>
      Math.abs((c.worst && c.worst.delta) || 0) > Math.abs(a.delta)
        ? { label: c.label, delta: c.worst.delta, source: c.worst.source }
        : a,
    { label: null, delta: 0, source: null }
  );
  stats.worstH1 = cases
    .filter((c) => c.h1Impossibility > 0)
    .sort((a, b) => b.h1Impossibility - a.h1Impossibility)
    .slice(0, 5)
    .map((c) => `${c.label} over-by=${c.h1Impossibility} painted=${c.painted} rows=${c.rows}`);

  const table = cases
    .filter((c) => Object.values(c.deltas || {}).some((d) => d !== 0))
    .slice(0, 40)
    .map(
      (c) =>
        `${c.label.padEnd(52)} plan=${String(c.plan).padStart(3)} painted=${String(c.painted).padStart(3)} ${[
          'main',
          'fallback',
          'c1',
          'c12',
          'c3',
        ]
          .filter((s) => _has(c.deltas[s]))
          .map((s) => `${s}:${c.deltas[s] >= 0 ? '+' : ''}${c.deltas[s]}`)
          .join(' ')}`
    );

  return { cases, stats, table };
}

module.exports = {
  isEnabled,
  sharesFrom,
  fallbackHeight,
  compareFrame,
  scan,
  DEFAULT_ROWS,
  baseContexts,
};
