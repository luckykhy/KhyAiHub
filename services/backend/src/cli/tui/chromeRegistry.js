'use strict';

// chromeRegistry.js — pure leaf (zero IO, deterministic, never throws).
//
// Registry of every FIXED (non-scrolling) row group the TUI paints, i.e. the
// chrome that H1 (`frame height <= rows - 1`) must charge before the viewport
// gets a single row. It replaces the three hand-copied ledgers documented in
// [DESIGN-ARCH-156] §1.2: the AGENTS.md 0.9.2 table, the inline sum in
// ink-components/App.js, and the `shares` field enumeration in chromeBudget.js.
//
// Contract per entry (all fields are mandatory — an entry without `evidence`
// is treated as unregistered and reported by check-frame-ledger):
//   id       stable name, used as the ledger key and in the frame record
//   owner    the module that actually paints those rows
//   evidence where the row count came from ("measured:<file:line>" or a spec id)
//   rows     (ctx) => rows >= 0, or a constant
//   layout   which layout modes charge this entry ('legacy' / 'preview')
//   kind     'paint'   — a row that really appears on screen this frame, so it
//                        counts against H1's painted height
//            'reserve' — a row deliberately left unpainted as slack (conpty
//                        pending-wrap, ink's trailing '\n'). Charging it as
//                        paint double-counts and reports 280/280 fake H1
//                        violations; not charging it at all is what lets a
//                        frame hit ink's `outputHeight >= rows` branch.
//
// Deliberate design choice: the trailer row (ink writes `output + '\n'`) and
// the conpty pending-wrap slack are BOTH listed here. chromeBudget.liveBudget()
// subtracts its own `- 1` for the trailer, so a caller that feeds this registry
// into liveBudget() would double-charge and silently lose a viewport row — the
// exact class of bug this registry exists to make impossible. framePlan.js
// therefore computes the budget from the ledger itself and ASSERTS H1 against
// the painted total instead of baking the `- 1` into the subtraction.

const LEGACY = 'legacy';
const PREVIEW = 'preview';
const PAINT = 'paint';
const RESERVE = 'reserve';

function num(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

function positive(v) {
  return Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0;
}

const ENTRIES = [
  {
    id: 'promptFrame',
    owner: 'ink-components/PromptFrame.js',
    evidence: 'measured:App.js:6363-6376 (frameRowCount; floor 3)',
    layout: [LEGACY, PREVIEW],
    kind: PAINT,
    rows: (ctx) => num(ctx.inputRows, 3),
  },
  {
    id: 'footer',
    owner: 'ink-components/FooterBar.js',
    evidence: 'measured:App.js:6381',
    layout: [LEGACY, PREVIEW],
    kind: PAINT,
    rows: () => 1,
  },
  {
    id: 'spinnerBusy',
    owner: 'ink-components/Spinner.js',
    // Was 3 (bordered box); the border was removed on 2026-09-24, so the block
    // is paddingX + one content row = 1. Charging 3 here costs the transcript
    // two rows on every busy frame.
    evidence: 'measured:App.js:6385-6394',
    layout: [LEGACY, PREVIEW],
    kind: PAINT,
    rows: (ctx) => (ctx.busy && !ctx.awaitingUserChoice ? 1 : 0),
  },
  {
    id: 'taskPanel',
    owner: 'ink-components/TaskListPanel.js',
    // header 1 + entries + optional tail-cut notice. 边框已于 2026-10-02 移除
    // （DESIGN-ARCH-176 §3.1「去线条、用底色分层」），故 round border 那 2 行不再计入。
    // 同一改动也必须落在 App.js 的 `taskH` —— **两处是并行真源，漏改其一会让
    // reserve 虚高 ⇒ StreamingBlock 每帧被压矮 ⇒ 长输出时「莫名少行」。**
    // 同类处置先例：本文件 2026-09-24 移除 spinner 边框时同样把该块 3 → 1。
    evidence: 'measured:App.js:6501 (taskH)',
    layout: [LEGACY, PREVIEW],
    kind: PAINT,
    rows: (ctx) => {
      const lines = positive(ctx.taskLineCount);
      return lines > 0 ? 1 + lines + (positive(ctx.taskHiddenNotice) > 0 ? 1 : 0) : 0;
    },
  },
  {
    id: 'planApproval',
    owner: 'ink-components/PlanApproval.js',
    evidence: 'measured:App.js:6404 (_approvalRows)',
    layout: [LEGACY, PREVIEW],
    kind: PAINT,
    rows: (ctx) => positive(ctx.approvalRows),
  },
  {
    id: 'completionMenu',
    owner: 'ink-components/CompletionMenu.js',
    // 10 items/page + footer 1 + rounded border 2 = 13 max. BUG (App.js:6405-6411):
    // the ledger used to charge 4 while the component painted 13.
    evidence: 'measured:App.js:6405-6424',
    layout: [LEGACY, PREVIEW],
    kind: PAINT,
    rows: (ctx) => positive(ctx.completionRows),
  },
  {
    id: 'hintNotice',
    owner: 'ink-components/App.js (hint row)',
    evidence: 'measured:App.js:6395',
    layout: [LEGACY, PREVIEW],
    kind: PAINT,
    rows: (ctx) => (ctx.hint ? 1 : 0),
  },
  {
    id: 'revSearch',
    owner: 'ink-components/HistorySearchOverlay.js',
    evidence: 'measured:App.js:6396',
    layout: [LEGACY, PREVIEW],
    kind: PAINT,
    rows: (ctx) => (ctx.revSearch ? 1 : 0),
  },
  {
    id: 'topbar',
    owner: 'ink-components/PreviewLayout.js',
    // Historically the only term nobody charged (AGENTS.md 0.9.2 note 2).
    // Gated on the layout the ledger is being materialized for, not a second
    // ctx flag — two switches for one fact is a ledger that can disagree.
    evidence: 'measured:App.js:6397-6399',
    layout: [PREVIEW],
    kind: PAINT,
    rows: (ctx) => (ctx.layout === PREVIEW ? 1 : 0),
  },
  {
    id: 'separator',
    owner: 'ink-components/PreviewLayout.js',
    evidence: 'measured:App.js:6400',
    layout: [PREVIEW],
    kind: PAINT,
    rows: (ctx) => (ctx.layout === PREVIEW ? 1 : 0),
  },
  {
    id: 'conptySlack',
    owner: '(none — discipline)',
    evidence: 'spec:[DESIGN-ARCH-102] H1 / App.js:6401 slack = 1',
    layout: [LEGACY, PREVIEW],
    kind: RESERVE,
    rows: () => 1,
  },
  {
    id: 'inkTrailer',
    owner: '(ink writes output + "\\n")',
    evidence: 'measured:chromeBudget.js:24 CC_TRAILER_ROWS',
    layout: [LEGACY, PREVIEW],
    kind: RESERVE,
    rows: () => 1,
  },
];

/**
 * Entries applicable to one layout mode.
 * @param {string} layout 'legacy' | 'preview'
 * @returns {object[]}
 */
function forLayout(layout = LEGACY) {
  const want = layout === PREVIEW ? PREVIEW : LEGACY;
  return ENTRIES.filter((e) => Array.isArray(e.layout) && e.layout.includes(want));
}

/**
 * Materialize the ledger for a context: one { id, rows, kind, evidence } per
 * charged entry. Zero-row entries are kept (they are part of the audit:
 * "we looked").
 *
 * `total` is the full ledger; H1 must be asserted against `paintTotal`
 * (rows actually on screen) while `budget` arithmetic consumes `total`
 * (reserve is still money spent out of `rows`).
 * @param {{ layout?: string }} [ctx]
 * @returns {{ entries: object[], total: number, paintTotal: number, reserveTotal: number }}
 */
function charge(ctx = {}) {
  const c = ctx || {};
  const entries = [];
  let total = 0;
  let paintTotal = 0;
  let reserveTotal = 0;
  for (const e of forLayout(c.layout)) {
    let r = 0;
    try {
      r = Math.max(0, Math.floor(Number(e.rows(c)) || 0));
    } catch {
      r = 0; // never throws (leaf contract); an unpaintable term charges 0 and shows up as a short frame
    }
    const kind = e.kind === RESERVE ? RESERVE : PAINT;
    entries.push({ id: e.id, owner: e.owner, rows: r, kind, evidence: e.evidence });
    total += r;
    if (kind === RESERVE) reserveTotal += r;
    else paintTotal += r;
  }
  return { entries, total, paintTotal, reserveTotal };
}

/**
 * Registry self-audit used by check-frame-ledger (S1 observer): an entry is
 * valid only when it names its owner and carries evidence for its row count.
 * @returns {{ ok: boolean, problems: string[], count: number }}
 */
function validate() {
  const problems = [];
  const seen = new Set();
  for (const e of ENTRIES) {
    if (seen.has(e.id)) problems.push(`duplicate id: ${e.id}`);
    seen.add(e.id);
    if (!e.id || !/^[a-z][A-Za-z0-9]*$/.test(e.id)) problems.push(`bad id: ${e.id}`);
    if (!e.owner || !String(e.owner).trim()) problems.push(`${e.id}: missing owner`);
    if (!e.evidence || !/^(measured|spec):/.test(String(e.evidence))) {
      problems.push(`${e.id}: missing or malformed evidence (rows are guesses)`);
    }
    if (e.kind !== PAINT && e.kind !== RESERVE) {
      problems.push(`${e.id}: kind must be 'paint' or 'reserve' (guessing it double-counts H1)`);
    }
    if (typeof e.rows !== 'function') problems.push(`${e.id}: rows must be a function of ctx`);
    if (!Array.isArray(e.layout) || e.layout.length === 0)
      problems.push(`${e.id}: layout list empty`);
  }
  return { ok: problems.length === 0, problems, count: ENTRIES.length };
}

module.exports = {
  LEGACY,
  PREVIEW,
  PAINT,
  RESERVE,
  ENTRIES,
  forLayout,
  charge,
  validate,
};
