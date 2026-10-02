'use strict';

/**
 * historyReverseSearch.js contract tests — the pure Ctrl+R reverse-incremental
 * search decision core. Input history is old→new; matches come back new→old.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { isEnabled, search, nextMatch, OFF_VALUES } = require('./historyReverseSearch');

const H = ['git status', 'npm test', 'git log', 'khy doctor', 'git commit -m x'];

test('isEnabled: default on; only the four off values close it', () => {
  assert.deepEqual(OFF_VALUES, ['0', 'false', 'off', 'no']);
  assert.equal(isEnabled({}), true, 'unset → on');
  assert.equal(isEnabled(), true, 'no argument → on (falls back to the ambient default)');
  for (const off of ['0', 'false', 'off', 'no', ' OFF ', 'No']) {
    assert.equal(isEnabled({ KHY_HISTORY_REVERSE_SEARCH: off }), false, `${off} closes it`);
  }
  for (const on of ['1', 'true', 'on', 'yes', 'whatever', '']) {
    assert.equal(isEnabled({ KHY_HISTORY_REVERSE_SEARCH: on }), true, `${on} keeps it open`);
  }
  assert.equal(isEnabled(null), true, 'a hostile env argument must not throw');
});

test('search: empty query waits for input instead of matching everything', () => {
  for (const q of ['', null, undefined]) {
    assert.deepEqual(search(H, q), { query: q == null ? '' : q, matches: [], index: -1, current: '' });
  }
});

test('search: case-insensitive substring, ordered new→old, indices point into the input', () => {
  const r = search(H, 'GIT');
  assert.deepEqual(r.matches, [4, 2, 0], 'latest hit first, then progressively older');
  assert.equal(r.index, 0);
  assert.equal(r.current, 'git commit -m x');
  assert.equal(r.query, 'GIT', 'the query is echoed verbatim, not lowercased');
  r.matches.forEach((i) => assert.ok(H[i].toLowerCase().includes('git')));
});

test('search: no hit yields an empty selection, not an error', () => {
  const r = search(H, 'docker');
  assert.deepEqual(r, { query: 'docker', matches: [], index: -1, current: '' });
});

test('search: opts.from selects the nth match and is clamped at both ends', () => {
  assert.equal(search(H, 'git', { from: 1 }).current, 'git log');
  assert.equal(search(H, 'git', { from: 2 }).current, 'git status');
  assert.equal(search(H, 'git', { from: 99 }).index, 2, 'clamped to the oldest match, no wrap');
  assert.equal(search(H, 'git', { from: -5 }).index, 0, 'clamped to the newest match');
  assert.equal(search(H, 'git', { from: 'nope' }).index, 0, 'non-numeric from behaves as 0');
});

test('search: non-array histories and non-string entries never throw', () => {
  for (const bad of [null, undefined, 'string', 42, {}]) {
    const r = search(bad, 'git');
    assert.deepEqual(r, { query: 'git', matches: [], index: -1, current: '' }, String(bad));
  }
  const mixed = [null, 7, 'a git thing', undefined, 'git two'];
  assert.deepEqual(search(mixed, 'git').matches, [4, 2], 'only string entries can match');
});

test('nextMatch: Ctrl+R again walks older and stops at the oldest (bash semantics)', () => {
  const s0 = search(H, 'git');
  assert.equal(s0.current, 'git commit -m x');
  const s1 = nextMatch(H, s0);
  assert.equal(s1.index, 1);
  assert.equal(s1.current, 'git log');
  const s2 = nextMatch(H, s1);
  assert.equal(s2.current, 'git status');
  const s3 = nextMatch(H, s2);
  assert.equal(s3.index, 2, 'pinned at the last match');
  assert.equal(s3.current, 'git status', 'no wrap-around to the newest');
});

test('nextMatch: degenerate states degrade to an empty selection instead of throwing', () => {
  for (const st of [undefined, {}, { matches: [] }, { matches: null }, { matches: 'x' }]) {
    const r = nextMatch(H, st);
    assert.deepEqual(r.matches, [], JSON.stringify(st));
    assert.equal(r.index, -1);
    assert.equal(r.current, '');
  }
  const lost = nextMatch([], { query: 'git', matches: [0, 1], index: 0 });
  assert.equal(lost.current, '', 'an index into a history that no longer holds it yields empty text');
  assert.equal(lost.query, 'git', 'the query survives the mismatch');
});

test('the search core touches neither fs nor the clock (purity lock)', () => {
  const src = require('node:fs').readFileSync(require.resolve('./historyReverseSearch'), 'utf8');
  const code = src
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/)/.test(l))
    .join('\n');
  assert.ok(!/writeFileSync|openSync|spawn|execFile|render\(/.test(code), 'no IO, no rendering here');
  assert.ok(!/Date\.|Math\.random|crypto\./.test(code), 'deterministic: no clock, no randomness');
});
