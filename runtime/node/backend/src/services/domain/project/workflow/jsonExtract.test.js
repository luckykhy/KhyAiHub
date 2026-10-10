'use strict';
// Co-located unit test for ./jsonExtract.js — batch B31 (D2 functional-unit conformance).
// jsonExtract is a pure leaf (zero IO, never throws): no sandbox pinning is strictly
// needed, but the standard preamble is kept uniform across the unit (see README §4).
// Pure node:test; no timers, no sockets, no worker/child processes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-wf-'));
process.env.KHY_APP_HOME = TMP_HOME;
process.env.KHY_DATA_HOME = TMP_HOME;
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;

const { extractFirstJson } = require('./jsonExtract.js');

test('exports are exactly the documented surface', () => {
  assert.deepEqual(Object.keys(require('./jsonExtract.js')), ['extractFirstJson']);
});

test('non-string input returns null (contract: any input, never throws)', () => {
  assert.equal(extractFirstJson(null), null);
  assert.equal(extractFirstJson(undefined), null);
  assert.equal(extractFirstJson(42), null);
  assert.equal(extractFirstJson({ a: 1 }), null);
  assert.equal(extractFirstJson([1, 2]), null);
  assert.equal(extractFirstJson(true), null);
});

test('empty / whitespace-only text returns null', () => {
  assert.equal(extractFirstJson(''), null);
  assert.equal(extractFirstJson('   \n\t '), null);
});

test('fast path: whole string is JSON object / array / scalar', () => {
  assert.deepEqual(extractFirstJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractFirstJson('[1,2,3]'), [1, 2, 3]);
  // Current behaviour: '42' parses via the fast path into the NUMBER 42, not null.
  assert.equal(extractFirstJson('42'), 42);
  assert.equal(extractFirstJson('true'), true);
});

test('fenced ```json block is unwrapped', () => {
  const fenced = '```json\n{"op":"connect"}\n```';
  assert.deepEqual(extractFirstJson(fenced), { op: 'connect' });
  const fencedNoLang = '```\n[{"op":"addNode"}]\n```';
  assert.deepEqual(extractFirstJson(fencedNoLang), [{ op: 'addNode' }]);
});

test('array is accepted as a delimiter (superset over the ai-backend twin)', () => {
  // Header: the twin in services/ai-backend only anchors on '{'; this leaf must
  // return the OUTER ARRAY for graphPatch.onVar patch payloads.
  const text = '前文 [{"op":"x"}] 后文';
  assert.deepEqual(extractFirstJson(text), [{ op: 'x' }]);
});

test('first delimiter wins: leading object beats a later array', () => {
  const text = 'note: {"a":[1,2]} then [9]';
  assert.deepEqual(extractFirstJson(text), { a: [1, 2] });
});

test('braces and escaped quotes inside strings do not affect balance', () => {
  const payload = { k: '} "quoted" { brace' };
  const text = 'pre ' + JSON.stringify(payload) + ' post';
  assert.deepEqual(extractFirstJson(text), payload);
});

test('earliest balanced value is returned, later ones ignored', () => {
  assert.deepEqual(extractFirstJson('a [1] b [2]'), [1]);
});

test('unbalanced / unparsable text returns null without throwing', () => {
  assert.equal(extractFirstJson('no json at all here'), null);
  assert.equal(extractFirstJson('{"a":'), null); // never closes
  assert.equal(extractFirstJson('[1,2'), null);
  assert.equal(extractFirstJson('{,}'), null); // balanced slice but invalid JSON
});

test('B31-W11 (low): a non-JSON code fence before the payload discards the payload', () => {
  // The fence regex strips the FIRST ``` pair unconditionally (jsonExtract.js:55),
  // then the scan runs only on the fenced content. JSON that appears AFTER the
  // closing fence is lost. Current (wrong) behaviour pinned here.
  const text = '```note\nhi there```\n[{"op":"connect","from":"a","to":"b"}]';
  assert.equal(extractFirstJson(text), null);
});

test('fence with real JSON inside but prose after the closing fence still works', () => {
  const text = '答案：\n```json\n[{"op":"addNode","node":{"id":"n"}}]\n```\n以上就是补丁。';
  assert.deepEqual(extractFirstJson(text), [{ op: 'addNode', node: { id: 'n' } }]);
});
