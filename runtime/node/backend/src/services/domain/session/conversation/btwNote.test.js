'use strict';

/**
 * btwNote.js contract tests — the pure `/btw` text leaf: normalization, the
 * merge-into-next-turn format (single source of truth shared by the classic REPL
 * and the ink TUI) and the KHY_BTW gate. Zero IO, env injected as an argument.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeNote,
  mergeHints,
  isEnabled,
  _HINT_HEADER,
  _MAX_NOTE_LEN,
} = require('./btwNote');

test('normalizeNote: trims edges, keeps inner text, empty-ish yields empty string', () => {
  assert.equal(normalizeNote('  补一句  '), '补一句');
  assert.equal(normalizeNote('a  b'), 'a  b', 'inner whitespace is not squeezed');
  for (const empty of [null, undefined, '', '   ', '\n\t ']) {
    assert.equal(normalizeNote(empty), '', String(empty));
  }
});

test('normalizeNote: non-strings are stringified, then capped at _MAX_NOTE_LEN', () => {
  assert.equal(normalizeNote(42), '42');
  assert.equal(normalizeNote({ toString: () => ' obj ' }), 'obj');
  assert.equal(normalizeNote([1, 2]), '1,2', 'Array.toString is the stringify path');
  assert.equal(_MAX_NOTE_LEN, 4000);
  const long = 'x'.repeat(_MAX_NOTE_LEN + 500);
  assert.equal(normalizeNote(long).length, _MAX_NOTE_LEN, 'over-long notes are cut, not rejected');
});

test('mergeHints: no hints means the input is returned byte-identical', () => {
  const input = '第一行\n第二行  ';
  for (const hints of [[], null, undefined, 'not-an-array', [''], ['   '], [null, undefined]]) {
    assert.equal(mergeHints(input, hints), input, JSON.stringify(hints));
  }
  assert.equal(mergeHints(null, ['a']), '\n\n' + _HINT_HEADER + '\na', 'null input becomes empty base');
  assert.equal(mergeHints(undefined, []), '');
});

test('mergeHints: SSOT join format is exactly `${input}\\n\\n[附加提示]\\n${lines}`', () => {
  assert.equal(_HINT_HEADER, '[附加提示]');
  assert.equal(mergeHints('跑测试', ['先看 CI', '再看 lint']), '跑测试\n\n[附加提示]\n先看 CI\n再看 lint');
  assert.equal(
    mergeHints('i', ['  padded  ', '', 'next']),
    'i\n\n[附加提示]\npadded\nnext',
    'each hint is normalized; blanks are dropped without leaving an empty line',
  );
});

test('isEnabled: default on, explicit falsy off, case and padding tolerated', () => {
  assert.equal(isEnabled(), true, 'no env argument at all is on');
  assert.equal(isEnabled({}), true, 'empty env is on (KHY_BTW undefined → default true)');
  for (const off of ['0', 'false', 'off', 'no', '', 'OFF', '  No  ', '   ', null]) {
    assert.equal(isEnabled({ KHY_BTW: off }), false, `${String(off)} turns it off`);
  }
  for (const on of ['1', 'true', 'on', 'yes', 'anything else']) {
    assert.equal(isEnabled({ KHY_BTW: on }), true, `${on} keeps it on`);
  }
  assert.equal(isEnabled({ KHY_BTW: ' ' }), false, 'a blank value is trimmed to empty → off');
});

test('the leaf reads no env and no fs (purity lock on the source text)', () => {
  const src = require('node:fs').readFileSync(require.resolve('./btwNote'), 'utf8');
  const code = src
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/)/.test(l))
    .join('\n');
  assert.ok(!code.includes('process.env'), 'env must only arrive via the isEnabled(env) argument');
  assert.ok(!code.includes('require('), 'the leaf is dependency-free by contract');
  assert.ok(!/Date\.|crypto\.|fs\./.test(code), 'no clock, no crypto, no filesystem');
});
