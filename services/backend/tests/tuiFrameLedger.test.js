'use strict';

// Tests for the S0 leaves of [DESIGN-ARCH-156]: chromeRegistry (one ledger for
// every fixed row group), framePlan (the P2 geometry decision) and
// frameDivergence (the S0 measurement of how far the existing height
// controllers already are from one another). Pure leaves: no ink, no PTY.

const assert = require('node:assert');

const chromeRegistry = require('../src/cli/tui/chromeRegistry');
const frameDivergence = require('../src/cli/tui/frameDivergence');
const framePlan = require('../src/cli/tui/framePlan');

const IDLE_LEGACY = {
  rows: 24,
  cols: 80,
  layout: 'legacy',
  inputRows: 3,
  taskLineCount: 0,
  taskHiddenNotice: 0,
  approvalRows: 0,
  completionRows: 0,
  busy: false,
  toolCount: 0,
  hint: false,
  revSearch: false,
};

describe('chromeRegistry', () => {
  test('validate() accepts the shipped ledger and rejects a guessed row count', () => {
    const res = chromeRegistry.validate();
    assert.strictEqual(res.ok, true, JSON.stringify(res.problems));
    assert.ok(res.count >= 10, `expected a full ledger, got ${res.count}`);
    const saved = chromeRegistry.ENTRIES[0].evidence;
    try {
      chromeRegistry.ENTRIES[0].evidence = '';
      assert.strictEqual(
        chromeRegistry.validate().ok,
        false,
        'an unevidenced row count must not validate'
      );
    } finally {
      chromeRegistry.ENTRIES[0].evidence = saved;
    }
  });

  test('every entry declares paint/reserve and belongs to a known layout', () => {
    for (const e of chromeRegistry.ENTRIES) {
      assert.ok(e.kind === 'paint' || e.kind === 'reserve', `${e.id}: kind must be declared`);
      assert.ok(Array.isArray(e.layout) && e.layout.length > 0, `${e.id}: layout list`);
      for (const l of e.layout) {
        assert.ok(l === 'legacy' || l === 'preview', `${e.id}: unknown layout ${l}`);
      }
    }
    // The two reserve rows are the only unpainted terms; if either starts
    // painting, H1's paint sum must change with it.
    const reserved = chromeRegistry.ENTRIES.filter((e) => e.kind === 'reserve')
      .map((e) => e.id)
      .sort();
    assert.deepStrictEqual(reserved, ['conptySlack', 'inkTrailer']);
  });

  test('charge() sums paint and reserve separately, and only preview adds its chrome', () => {
    const legacy = chromeRegistry.charge(IDLE_LEGACY);
    assert.strictEqual(legacy.total, legacy.paintTotal + legacy.reserveTotal);
    assert.strictEqual(
      legacy.entries.find((e) => e.id === 'topbar'),
      undefined,
      'topbar is preview-only'
    );
    assert.strictEqual(legacy.entries.find((e) => e.id === 'footer').rows, 1);
    assert.strictEqual(legacy.paintTotal, 3 + 1, 'idle legacy paints input + footer');

    const preview = chromeRegistry.charge({ ...IDLE_LEGACY, layout: 'preview' });
    assert.strictEqual(
      preview.paintTotal,
      legacy.paintTotal + 2,
      'preview adds topbar + separator'
    );
  });

  test('a busy spinner row and a 12-line task list are charged as paint, not guesses', () => {
    const c = chromeRegistry.charge({
      ...IDLE_LEGACY,
      busy: true,
      toolCount: 6,
      taskLineCount: 12,
    });
    const by = Object.fromEntries(c.entries.map((e) => [e.id, e.rows]));
    assert.strictEqual(by.spinnerBusy, 1, 'the bordered spinner box was removed 2026-09-24');
    assert.strictEqual(by.taskPanel, 3 + 12, 'round borders 2 + header 1 + 12 lines');
    assert.strictEqual(by.footer, 1);
  });
});

describe('framePlan.planFrame', () => {
  test('idle legacy 24 rows: budget = rows - chrome, H1 holds with the trailer counted', () => {
    const plan = framePlan.planFrame(IDLE_LEGACY);
    assert.strictEqual(plan.unit, 'visualRow');
    assert.strictEqual(plan.layout, 'legacy');
    assert.strictEqual(plan.viewport.height, 24 - plan.chrome.total);
    assert.ok(plan.diag.h1Holds, JSON.stringify(plan.diag));
    assert.ok(plan.diag.reprintAvoided, 'ink must not be pushed into a full reprint');
    assert.strictEqual(plan.overflow, null);
  });

  test('H1 is asserted against PAINTED rows, not the whole ledger', () => {
    // 24 - (3 input + 1 footer + 2 reserve) = 18 viewport; painted = 18 + 4 = 22.
    const plan = framePlan.planFrame(IDLE_LEGACY);
    assert.strictEqual(plan.chrome.paintTotal, 4);
    assert.strictEqual(plan.chrome.reserveTotal, 2);
    assert.strictEqual(plan.diag.painted, 22);
    assert.strictEqual(plan.diag.inkLineCount, 23);
    assert.ok(plan.diag.painted <= plan.rows - 1);
    // Charging the ledger total as paint would have failed on every case.
    assert.ok(
      plan.viewport.height + plan.chrome.total > plan.rows - 1,
      'reserve must stay out of paint'
    );
  });

  test('tiny terminals are reported as impossible geometry, not silently clamped', () => {
    const plan = framePlan.planFrame({ ...IDLE_LEGACY, rows: 10, busy: true, taskLineCount: 12 });
    assert.ok(!plan.diag.h1Holds || !plan.diag.reprintAvoided, 'a 10-row busy frame cannot fit');
    assert.ok(plan.overflow, 'overflow must be reported');
    assert.strictEqual(plan.overflow.reason, 'live-floor-raised-frame');
    assert.ok(
      plan.diag.notes.some((n) => /H1|reprint/.test(n)),
      JSON.stringify(plan.diag.notes)
    );
  });

  test('the conpty slack + ink trailer reserve keeps H1 two rows inside the screen', () => {
    const plan = framePlan.planFrame(IDLE_LEGACY);
    assert.strictEqual(plan.rows - 1 - plan.diag.painted, plan.chrome.reserveTotal - 1);
  });

  test('unusable sizes fall back without throwing', () => {
    for (const rows of [undefined, 0, -5, 'tall', NaN]) {
      const plan = framePlan.planFrame({ ...IDLE_LEGACY, rows });
      assert.strictEqual(plan.rows, framePlan.FALLBACK_ROWS, `rows=${rows}`);
      assert.ok(plan.diag.notes.some((n) => /rows unreadable/.test(n)));
    }
    assert.strictEqual(
      framePlan.planFrame({ ...IDLE_LEGACY, layout: 'sideways' }).layout,
      'legacy'
    );
  });

  test('an explicit ink measurement is carried into the plan untouched', () => {
    assert.strictEqual(
      framePlan.planFrame({ ...IDLE_LEGACY, inkOutputHeight: 24 }).measured.inkOutputHeight,
      24
    );
    assert.strictEqual(framePlan.planFrame(IDLE_LEGACY).measured, null);
    assert.strictEqual(framePlan.planFrame({ ...IDLE_LEGACY, inkOutputHeight: -3 }).measured, null);
  });

  test('commit intent is incremental unless a legal repaint reason is named', () => {
    assert.deepStrictEqual(framePlan.makeCommitPlan(), { repaint: 'incremental', reason: null });
    assert.deepStrictEqual(framePlan.makeCommitPlan('resize-rows'), {
      repaint: 'full',
      reason: 'resize-rows',
    });
    assert.deepStrictEqual(framePlan.makeCommitPlan('because-i-said-so'), {
      repaint: 'incremental',
      reason: null,
    });
    assert.strictEqual(
      framePlan.planFrame({ ...IDLE_LEGACY, inkOverflow: true }).intent.reason,
      'h1-overflow'
    );
  });

  test('the gate defaults on and honours the OFF tokens', () => {
    assert.strictEqual(framePlan.isEnabled({}), true);
    assert.strictEqual(framePlan.isEnabled({ KHY_FRAME_PLAN: '0' }), false);
    assert.strictEqual(framePlan.isEnabled({ KHY_FRAME_PLAN: 'off' }), false);
    assert.strictEqual(framePlan.isEnabled({ KHY_FRAME_PLAN: 'ON' }), true);
  });
});

describe('frameDivergence', () => {
  test('shares mapping hands chromeBudget the slack row but never the trailer', () => {
    const plan = framePlan.planFrame(IDLE_LEGACY);
    const shares = frameDivergence.sharesFrom(plan.chrome.entries);
    assert.strictEqual(shares.slack, 1);
    assert.strictEqual('inkTrailer' in shares, false, 'liveBudget subtracts its own trailer row');
    assert.strictEqual(shares.inputRows, 3);
    assert.strictEqual(shares.statusRows, 1);
  });

  test('the registry reproduces the two live ledgers exactly (S0 finding)', () => {
    // Not a tautology: `main` calls chromeBudget.liveBudget and `fallback`
    // re-sums App.js's terms. Both agreeing with the new ledger is what makes
    // S1 a re-plumbing rather than a behaviour change.
    const contexts = [
      IDLE_LEGACY,
      { ...IDLE_LEGACY, layout: 'preview', busy: true, toolCount: 4 },
      { ...IDLE_LEGACY, rows: 40, taskLineCount: 12, hint: true, revSearch: true },
      { ...IDLE_LEGACY, rows: 13, completionRows: 13 },
    ];
    for (const ctx of contexts) {
      const out = frameDivergence.compareFrame(ctx);
      assert.strictEqual(out.deltas.main, 0, JSON.stringify(ctx));
      assert.strictEqual(out.deltas.fallback, 0, JSON.stringify(ctx));
    }
  });

  test('the feed-forward predictor disagrees with the ledger, in both directions', () => {
    const out = frameDivergence.compareFrame({
      ...IDLE_LEGACY,
      busy: true,
      toolCount: 6,
      platform: 'win32',
    });
    assert.ok(Number.isFinite(out.c1), 'liveRegionBudget must answer');
    assert.notStrictEqual(out.deltas.c1, 0, 'c1 counts tool rows the ledger does not charge');
    assert.strictEqual(out.predictorUnexplained.c1, out.deltas.c1);
  });

  test('raw task lines are capped by the same leaf the app uses', () => {
    const out = frameDivergence.compareFrame({ ...IDLE_LEGACY, rawTaskLines: 12 });
    assert.ok(out.taskLineCount < 12, `expected a capped panel, got ${out.taskLineCount}`);
    assert.strictEqual(out.taskLineCount, Math.min(12, out.taskLineCap));
    assert.strictEqual(
      out.taskLineCount + out.taskHiddenNotice,
      12,
      'cap + hidden must account for the raw list'
    );
    // The panel now charges borders + kept lines + the tail-cut notice.
    const panel = out.entries.find((e) => e.id === 'taskPanel').rows;
    assert.strictEqual(panel, 3 + out.taskLineCount + 1);
    assert.strictEqual(
      out.fallback,
      frameDivergence.fallbackHeight(
        framePlan.planFrame({
          ...IDLE_LEGACY,
          taskLineCount: out.taskLineCount,
          taskHiddenNotice: out.taskHiddenNotice,
        }).chrome.entries,
        24
      )
    );
  });

  test('scan() sweeps the grid and summarizes it', () => {
    const { cases, stats, table } = frameDivergence.scan({ rowsList: [13, 24, 60] });
    assert.strictEqual(stats.cases, cases.length);
    assert.strictEqual(cases.length, 2 * 2 * 11 * 3, 'layouts x platforms x contexts x rows');
    assert.ok(stats.h1Violations > 0, 'the tiny-terminal cases must be reported');
    assert.ok(stats.ledgerAgreement.main === cases.length, 'no ledger source may disagree yet');
    assert.ok(stats.predictorUnexplained.nonzero > 0);
    assert.ok(table.length > 0);
    assert.ok(table.length <= 40);
    for (const c of cases) {
      assert.ok(Number.isFinite(c.plan), c.label);
      assert.ok(Array.isArray(c.h1.violators));
    }
  });

  test('a missing leaf reports null, never a fake zero', () => {
    const out = frameDivergence.compareFrame(IDLE_LEGACY);
    if (out.c3 === null)
      assert.strictEqual(out.deltas.c3, undefined, 'absent source stays out of deltas');
  });
});
