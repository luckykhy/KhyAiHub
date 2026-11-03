'use strict';

/**
 * Colocated contract test for toolExecutionStats.js (zone 3: the structured summary).
 *
 * What is pinned here (the zone-3 half of the display contract):
 *   ① the session-stats shape per mode — `none` / `summary` / `detail` give exactly the keys
 *      opencode's session-stats.ts gives, so no consumer has to branch on "when is this key in".
 *   ② `unfinished` is a first-class count on both totals and every usage row: a tool that never
 *      finished is visible, never looks frozen.
 *   ③ totals have exactly one producer (the D2 leaf). Passing them in or letting this module
 *      derive them must give the same reading — otherwise the two numbers drift apart on screen.
 *   ④ the summary is count lines, not prose: an empty usage list does not print a bare header,
 *      and a tool with no duration sample does not print "0 seconds".
 *
 * The zone-1/zone-2/order gates live in toolExecutionReport.test.js; this file only looks at
 * the stats module's own surface.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const foundation = require('../services/domain/catalog/toolUseLoop/toolExecutionGroups');
const stats = require('./toolExecutionStats');

const STEPS = [
  { id: 'a', name: 'Read', status: 'success', durationMs: 120 },
  { id: 'b', name: 'Edit', status: 'success', durationMs: 240 },
  { id: 'c', name: 'Bash', status: 'error', error: { code: 'E', message: 'boom' } },
  { id: 'd', name: 'Bash', status: 'paused' },
  { id: 'e', name: 'Bash', status: 'running' },
];

// ── ① 封闭集合 ───────────────────────────────────────────────────────────

test('SUMMARY_MODE and USAGE_FIELDS are frozen closed sets', () => {
  assert.equal(Object.isFrozen(stats.SUMMARY_MODE), true);
  assert.deepEqual([...stats.SUMMARY_MODE], ['none', 'summary', 'detail']);
  assert.equal(Object.isFrozen(stats.USAGE_FIELDS), true);
  assert.deepEqual([...stats.USAGE_FIELDS], [
    'name', 'calls', 'succeeded', 'failed', 'unfinished', 'durationP50',
  ]);
});

test('an unregistered mode degrades to the most informative one, never throws', () => {
  const out = stats.buildSessionStats(STEPS, { mode: 'everything' });
  assert.equal(out.mode, 'detail');
  assert.ok(Array.isArray(out.usage));
});

// ── ② 三档形状（opencode session-stats.ts） ──────────────────────────────

test('the three modes give exactly the documented key sets', () => {
  assert.deepEqual(Object.keys(stats.buildSessionStats(STEPS, { mode: 'none' })), ['mode']);
  assert.deepEqual(Object.keys(stats.buildSessionStats(STEPS, { mode: 'summary' })), ['mode', 'totals']);
  assert.deepEqual(Object.keys(stats.buildSessionStats(STEPS, { mode: 'detail' })), [
    'mode', 'totals', 'usage',
  ]);
  // 默认档是 detail：统计面最大，端侧要少就自己降。
  assert.equal(stats.buildSessionStats(STEPS).mode, 'detail');
});

test('unfinished is first-class on totals and on every usage row', () => {
  const detail = stats.buildSessionStats(STEPS, { mode: 'detail' });
  assert.equal(detail.totals.unfinished, 2, 'paused and running both count as unfinished');
  assert.equal(detail.totals.failed, 1);
  assert.equal(detail.totals.succeeded, 2);
  const bash = detail.usage.find((u) => u.name === 'Bash');
  assert.deepEqual(bash, {
    name: 'Bash', calls: 3, succeeded: 0, failed: 1, unfinished: 2, durationP50: 0,
  });
  const text = stats.renderStatsText(detail);
  assert.ok(text[0].includes('未完成 2'), text[0]);
  assert.ok(text.some((l) => l.includes('Bash 3 次') && l.includes('未完成 2')));
});

// ── ③ totals 只有一个生产者 ─────────────────────────────────────────────

test('totals passed in and totals derived are the same reading', () => {
  const expected = foundation.projectToolExecution({ steps: STEPS }).totals;
  assert.deepEqual(stats.buildSessionStats(STEPS, { mode: 'summary', totals: expected }).totals, expected);
  assert.deepEqual(stats.resolveTotals(STEPS, expected), expected);
  assert.deepEqual(stats.resolveTotals(STEPS, null), expected);
  assert.deepEqual(stats.resolveTotals(STEPS, {}), expected, 'an empty bag is not a totals object');
  assert.deepEqual(stats.buildSessionStats(STEPS, { mode: 'summary' }).totals, expected);
});

// ── ④ usage 的排序与中位数 ──────────────────────────────────────────────

test('usage rows are sorted by call count, then by name (deterministic)', () => {
  const usage = stats.buildToolUsage(STEPS);
  assert.deepEqual(usage.map((u) => u.name), ['Bash', 'Edit', 'Read']);
  const same = stats.buildToolUsage(STEPS);
  assert.deepEqual(usage, same);
  const tie = stats.buildToolUsage([
    { id: '1', name: 'Zeta', status: 'success' },
    { id: '2', name: 'alpha', status: 'success' },
  ]);
  assert.deepEqual(tie.map((u) => u.name), ['alpha', 'Zeta']);
});

test('durationP50 is the median, and a missing sample is not a zero-duration sample', () => {
  const odd = stats.buildToolUsage([
    { id: '1', name: 'Bash', status: 'success', durationMs: 100 },
    { id: '2', name: 'Bash', status: 'success', durationMs: 900 },
    { id: '3', name: 'Bash', status: 'success', durationMs: 300 },
  ]);
  assert.equal(odd[0].durationP50, 300);
  const even = stats.buildToolUsage([
    { id: '1', name: 'Bash', status: 'success', durationMs: 100 },
    { id: '2', name: 'Bash', status: 'success', durationMs: 400 },
  ]);
  assert.equal(even[0].durationP50, 250, 'even count → mean of the two middles');
  const none = stats.buildToolUsage([{ id: '1', name: 'Bash', status: 'success' }]);
  assert.equal(none[0].durationP50, 0);
  const line = stats.renderStatsText({ mode: 'detail', totals: foundation.projectToolExecution({ steps: [] }).totals, usage: none })
    .find((l) => l.includes('Bash'));
  assert.equal(line.includes('中位耗时'), false);
});

// ── ⑤ 汇总文本是计数行，不是散文 ────────────────────────────────────────

test('renderStatsText emits one head line plus optional family/tool blocks', () => {
  const detail = stats.buildSessionStats(STEPS, { mode: 'detail' });
  const text = stats.renderStatsText(detail);
  assert.ok(/^执行工具 5 次 · 完成 2 · 失败 1 · 未完成 2$/.test(text[0]), text[0]);
  assert.ok(text[1].startsWith('按族：'));
  assert.equal(text[2], '按工具：');
  assert.ok(text.slice(3).every((l) => l.startsWith('  ')), 'tool rows are indented under the header');
});

test('an empty usage list prints no bare "by tool" header', () => {
  const empty = stats.buildSessionStats([], { mode: 'detail' });
  assert.deepEqual(empty.usage, []);
  assert.deepEqual(stats.renderStatsText(empty), ['执行工具 0 次 · 完成 0 · 失败 0 · 未完成 0']);
});

test('duration wording is injected, not reimplemented', () => {
  const detail = stats.buildSessionStats(STEPS, { mode: 'detail' });
  const text = stats.renderStatsText(detail, { formatDuration: (ms) => `${ms}ms` });
  assert.ok(text.some((l) => l.includes('120ms')), text.join('\n'));
});

test('renderStatsText never throws and never invents a zone', () => {
  assert.deepEqual(stats.renderStatsText(null), []);
  assert.deepEqual(stats.renderStatsText({ mode: 'none' }), []);
  assert.deepEqual(stats.renderStatsText({ mode: 'summary', totals: null }), []);
  assert.doesNotThrow(() => stats.buildSessionStats(null));
  assert.doesNotThrow(() => stats.buildSessionStats('nope', 'nope'));
  assert.doesNotThrow(() => stats.buildToolUsage([null, 3, '']));
  assert.deepEqual(stats.buildSessionStats(null, { mode: 'none' }), { mode: 'none' });
});
