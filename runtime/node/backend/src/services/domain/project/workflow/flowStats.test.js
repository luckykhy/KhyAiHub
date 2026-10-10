'use strict';
// Co-located unit test for ./flowStats.js — batch B31 (D2 functional-unit conformance).
// Pure aggregation helpers (parseJsonl / aggregateEntries / mergeSummary /
// computeSuccessRate / computeAvgDuration) run with zero IO. The IO layer
// (record / getSuccessRate / getAvgDuration / recentRuns) writes only into a
// THROWAWAY data home (KHY_APP_HOME / KHY_DATA_HOME / KHY_PROJECT_DATA_HOME pinned
// to an fs.mkdtempSync directory before require). Roll-up uses rename/append but no
// timers, sockets or child processes. Pure node:test.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-wf-'));
process.env.KHY_APP_HOME = TMP_HOME;
process.env.KHY_DATA_HOME = TMP_HOME;
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;

const st = require('./flowStats.js');

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

// ── surface ───────────────────────────────────────────────────────────────────

test('exported surface is exactly the documented 9 keys', () => {
  assert.deepEqual(Object.keys(st).sort(), [
    'aggregateEntries',
    'computeAvgDuration',
    'computeSuccessRate',
    'getAvgDuration',
    'getSuccessRate',
    'mergeSummary',
    'parseJsonl',
    'recentRuns',
    'record',
  ]);
});

// ── parseJsonl ─────────────────────────────────────────────────────────────────

test('parseJsonl keeps object lines, skips blanks / corrupt / non-object scalars', () => {
  assert.deepEqual(st.parseJsonl(''), []);
  assert.deepEqual(st.parseJsonl(null), []);
  const text = '{"a":1}\n\nnot json\n{"b":2}\n5\n"str"\ntrue\n';
  assert.deepEqual(st.parseJsonl(text), [{ a: 1 }, { b: 2 }]);
});

test('parseJsonl accepts a top-level JSON array line as one entry (documented quirk)', () => {
  // JSON.parse of an array yields typeof "object" and a truthy value, so an array
  // row is pushed as a single "entry". Aggregation then treats it as one run.
  const entries = st.parseJsonl('[{"x":1},{"x":2}]\n');
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], [{ x: 1 }, { x: 2 }]);
});

// ── aggregateEntries ─────────────────────────────────────────────────────────

test('aggregateEntries folds runs / successes / durations / retries', () => {
  const agg = st.aggregateEntries([
    { status: 'completed', durationMs: 100, retryTotal: 2 },
    { status: 'failed', durationMs: 50, retryTotal: 0 },
    { status: 'completed', durationMs: 'bad', retryTotal: -1 },
    null,
    'not-an-object',
  ]);
  assert.equal(agg.runs, 3);
  assert.equal(agg.successes, 2);
  assert.equal(agg.totalDurationMs, 150); // the 'bad' duration is ignored
  assert.equal(agg.totalRetries, 2); // retryTotal must be > 0 to count
});

test('aggregateEntries on non-array returns the neutral aggregate', () => {
  assert.deepEqual(st.aggregateEntries(null), { runs: 0, successes: 0, totalDurationMs: 0, totalRetries: 0 });
});

// ── mergeSummary ───────────────────────────────────────────────────────────────

test('mergeSummary sums the four counters, coercing junk to 0', () => {
  const a = { runs: 2, successes: 1, totalDurationMs: 100, totalRetries: 3 };
  const b = { runs: 3, successes: 2, totalDurationMs: 50, totalRetries: 'x' };
  assert.deepEqual(st.mergeSummary(a, b), { runs: 5, successes: 3, totalDurationMs: 150, totalRetries: 3 });
  assert.deepEqual(st.mergeSummary(null, { runs: 1, successes: 1, totalDurationMs: 10, totalRetries: 0 }), { runs: 1, successes: 1, totalDurationMs: 10, totalRetries: 0 });
});

// ── computeSuccessRate / computeAvgDuration ──────────────────────────────────

test('computeSuccessRate / computeAvgDuration: null with no data, ratio otherwise', () => {
  assert.equal(st.computeSuccessRate(null, []), null);
  assert.equal(st.computeAvgDuration(null, []), null);
  const summary = { runs: 1, successes: 1, totalDurationMs: 10, totalRetries: 0 };
  const entries = [{ status: 'completed', durationMs: 20 }, { status: 'failed', durationMs: 30 }];
  // merged runs 3, successes 2 -> 2/3; durations 60 / 3 -> 20
  assert.equal(st.computeSuccessRate(summary, entries), 2 / 3);
  assert.equal(st.computeAvgDuration(summary, entries), 20);
});

// ── record + read-back (IO against the throwaway home) ───────────────────────

test('record refuses an entry without flowName', () => {
  assert.equal(st.record({}).ok, false);
  assert.match(st.record({}).errors[0], /需要含 flowName/);
});

test('record appends and getSuccessRate / getAvgDuration read it back', () => {
  const name = 'Stats Readback';
  assert.equal(st.record({ flowName: name, status: 'completed', durationMs: 100 }).ok, true);
  assert.equal(st.record({ flowName: name, status: 'failed', durationMs: 300 }).ok, true);
  assert.equal(st.getSuccessRate(name), 0.5);
  assert.equal(st.getAvgDuration(name), 200);
});

test('record normalises any non-"completed" status to a counted failure', () => {
  const name = 'Stats Status';
  st.record({ flowName: name, status: 'success', durationMs: 10 }); // NOT 'completed'
  assert.equal(st.getSuccessRate(name), 0);
});

test('getSuccessRate / getAvgDuration of an unknown flow are null', () => {
  assert.equal(st.getSuccessRate('Never Recorded Flow XYZ'), null);
  assert.equal(st.getAvgDuration('Never Recorded Flow XYZ'), null);
});

test('recentRuns returns newest-first detail rows', () => {
  const name = 'Stats Recent';
  st.record({ flowName: name, executionId: 'e1', status: 'completed', durationMs: 1 });
  st.record({ flowName: name, executionId: 'e2', status: 'completed', durationMs: 2 });
  st.record({ flowName: name, executionId: 'e3', status: 'completed', durationMs: 3 });
  const runs = st.recentRuns(name, 2);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].executionId, 'e3'); // newest first
  assert.equal(runs[1].executionId, 'e2');
});

// ── roll-up keeps total counts (summary + detail merge) ───────────────────────

test('record rolls the oldest half into the summary once the detail file exceeds the limit, without losing counts', () => {
  const name = 'Stats Roll';
  const dir = path.join(TMP_HOME, 'workflow_stats');
  fs.mkdirSync(dir, { recursive: true });
  // Lower the bound so a handful of rows triggers _rollUp deterministically.
  withEnv('KHY_FLOW_STATS_LIMIT', '2', () => {
    for (let i = 0; i < 5; i += 1) {
      const r = st.record({ flowName: name, status: i % 2 === 0 ? 'completed' : 'failed', durationMs: 10, retryTotal: 1 });
      assert.equal(r.ok, true);
    }
  });
  const summaryFile = path.join(dir, 'stats-roll.summary.json');
  const detailFile = path.join(dir, 'stats-roll.jsonl');
  assert.ok(fs.existsSync(summaryFile), 'summary file should exist after roll-up');
  // The detail file is bounded to <= limit after rolling.
  const detailCount = st.parseJsonl(fs.readFileSync(detailFile, 'utf8')).length;
  assert.ok(detailCount <= 2, `detail rows should be <= limit, got ${detailCount}`);
  // Total runs preserved across summary + detail = 5.
  assert.equal(st.getSuccessRate(name) !== null, true);
  const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  const merged = summary.runs + detailCount;
  assert.equal(merged, 5);
});

test('limit reads KHY_FLOW_STATS_LIMIT and falls back to 200 on garbage', () => {
  // Indirectly: with an invalid env value, a couple of rows never roll.
  const name = 'Stats No Roll';
  withEnv('KHY_FLOW_STATS_LIMIT', 'abc', () => {
    st.record({ flowName: name, status: 'completed', durationMs: 1 });
    st.record({ flowName: name, status: 'completed', durationMs: 1 });
  });
  const dir = path.join(TMP_HOME, 'workflow_stats', 'stats-no-roll.summary.json');
  assert.equal(fs.existsSync(dir), false); // default 200 not exceeded
});
