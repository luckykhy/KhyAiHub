'use strict';

// Regression for the tool-call tally distortion (IMPL-RPT-063 / P7): real
// sessions rendered "已执行 4 次工具调用（0 成功, 0 失败）" because 16 of the 18
// toolCallLog.push sites only set result.success while the summary only counted
// entry-level success flags. toolCallTally.js is the single-source tally with
// mutually exclusive buckets that always sum to the log length.

const { test } = require('node:test');
const assert = require('node:assert');

const { tallyToolCallLog } = require('../src/services/tool/loop/toolCallTally.js');

test('entries with only result.success are counted (the real-session distortion)', () => {
  const log = [
    { tool: 'writeFile', params: {}, result: { success: true } },
    { tool: 'shell_command', params: {}, result: { success: true, data: { outputTail: 'ok' } } },
    { tool: 'web_search', params: {}, result: { success: false, error: 'ECONNREFUSED' } },
    { tool: 'readFile', params: {}, result: { success: true } },
  ];
  const t = tallyToolCallLog(log);
  assert.strictEqual(t.total, 4);
  assert.strictEqual(t.succeeded.length, 3, 'result.success===true entries must count as success');
  assert.strictEqual(t.failed.length, 1, 'result.success===false entries must count as failure');
  assert.strictEqual(t.skipped.length, 0);
  assert.strictEqual(t.denied.length, 0);
});

test('either level saying failure counts as failure (conservative both ways)', () => {
  const log = [
    { tool: 'x', success: false, result: { success: true } },
    { tool: 'y', success: true, result: { success: false } },
    { tool: 'z', success: true, result: { success: true } },
  ];
  const t = tallyToolCallLog(log);
  assert.strictEqual(t.failed.length, 2, 'entry- or result-level failure must count as failure');
  assert.ok(t.failed.some((e) => e.tool === 'x') && t.failed.some((e) => e.tool === 'y'));
  assert.strictEqual(t.succeeded.length, 1);
  assert.strictEqual(t.succeeded[0].tool, 'z');
});

test('deduped / loop-blocked calls are their own bucket, never success', () => {
  const log = [
    { tool: 'shell', result: { _deduped: true, success: true } },
    { tool: 'shell', result: { _loopDetected: true } },
    { tool: 'shell', result: { success: true } },
  ];
  const t = tallyToolCallLog(log);
  assert.strictEqual(t.skipped.length, 2);
  assert.strictEqual(t.succeeded.length, 1);
  assert.strictEqual(t.failed.length, 0);
});

test('denied calls are excluded from success/failure; buckets always sum to total', () => {
  const log = [
    { tool: 'rm', denied: true, success: false },
    { tool: 'rm', denied: true, result: { success: false } },
    { tool: 'ok', result: { success: true } },
    { tool: 'bad', result: { success: false } },
    { tool: 'mystery' }, // no marker at all → counts as success (缺省视为成功)
  ];
  const t = tallyToolCallLog(log);
  assert.strictEqual(t.denied.length, 2);
  assert.strictEqual(t.failed.length, 1);
  assert.strictEqual(t.succeeded.length, 2);
  assert.strictEqual(t.skipped.length, 0);
  assert.strictEqual(
    t.succeeded.length + t.failed.length + t.skipped.length + t.denied.length,
    t.total,
    'buckets are mutually exclusive and exhaustive'
  );
});

test('non-array / empty input degrades to zeros, never throws', () => {
  for (const input of [undefined, null, [], 'nope']) {
    const t = tallyToolCallLog(input);
    assert.strictEqual(t.total, Array.isArray(input) ? 0 : 0);
    assert.strictEqual(t.succeeded.length + t.failed.length + t.skipped.length + t.denied.length, 0);
  }
});
