'use strict';

// Co-located contract tests for toonEncode.js ([RESEARCH-018] §2.3 / C-4 功能单元含测试).
//
// TOON is the token-saving surface of the account/tokenless unit, so its value
// proposition is "shorter than JSON, lossy only where documented". Every assertion
// below was taken from the module's ACTUAL output (probe: .khyos/tmp/toon-behavior-probe.js),
// not from the docstring. Three places where the two disagree are pinned as-is and
// tagged KNOWN-DEFECT — they are registered for a human call ([DESIGN-LAY-008] §12.35),
// NOT fixed here, because each one changes what a model receives.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  encode,
  _encodeValue,
  _isSimple,
  _simpleValue,
  _indent,
} = require('./toonEncode');

const OPTS = { maxDepth: 8, maxArrayItems: 50, maxStringLen: 512 };

test('a flat object becomes one un-indented `key: value` line per key', () => {
  const { toon, stats } = encode({ a: 1 });
  assert.equal(toon, 'a: 1');
  // {"a":1} = 7 chars → `a: 1` = 4 chars → 43% saved.
  assert.deepEqual(stats, { originalChars: 7, toonChars: 4, savedPercent: 43 });
});

test('empty and single-key edge cases keep their documented literal form', () => {
  assert.equal(encode({}).toon, '{}');
  assert.deepEqual(encode({}).stats, { originalChars: 2, toonChars: 2, savedPercent: 0 });
  assert.equal(encode(null).toon, 'null');
  assert.equal(encode(undefined).toon, 'null');
  // undefined has no JSON.stringify form → originalChars 0, and the ratio guard
  // returns 0 rather than dividing by zero.
  assert.deepEqual(encode(undefined).stats, { originalChars: 0, toonChars: 4, savedPercent: 0 });
});

test('nested containers always start on their own line — never `key: []` inline', () => {
  assert.equal(encode({ list: [] }).toon, 'list:\n  []');
  assert.equal(encode({ list: {} }).toon, 'list:\n  {}');
  assert.equal(encode({ n: [1, 2, 3] }).toon, 'n:\n  [1, 2, 3]');
  assert.equal(encode({ s: ['a', 'b'] }).toon, 's:\n  [a, b]');
  assert.equal(encode({ a: { b: { c: 'end' } } }).toon, 'a:\n  b:\n    c: end');
});

test('a simple (<=10 items) flat array is inlined, strings WITHOUT quotes', () => {
  assert.equal(_encodeAtDepth([1, 2, 3]), '[1, 2, 3]');
  assert.equal(_encodeAtDepth(['a', 'b']), '[a, b]');
  // 11+ simple items fall through to the `- ` block form instead.
  const eleven = Array.from({ length: 11 }, (_, i) => i);
  assert.ok(_encodeAtDepth(eleven).startsWith('- 0'), _encodeAtDepth(eleven).slice(0, 20));
  assert.equal(_encodeAtDepth(eleven).split('\n').length, 11);
});

test('object array items keep the first key on the `- ` line, the rest indented', () => {
  assert.equal(
    encode([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]).toon,
    '- id: 1\n  name: a\n- id: 2\n  name: b'
  );
  assert.equal(encode([{}, {}]).toon, '- {}\n- {}');
});

test('maxDepth emits <truncated> at the offending level, deeper keys keep indent', () => {
  assert.equal(
    encode({ a: { b: { c: 'end' } } }, { ...OPTS, maxDepth: 1 }).toon,
    'a:\n  b:\n    <truncated>'
  );
  const out = [];
  _encodeValue({ a: { b: 1 } }, 9, out, { ...OPTS, maxDepth: 8 });
  assert.deepEqual(out, [`${'  '.repeat(9)}<truncated>`]);
});

test('maxArrayItems slices and reports the dropped count', () => {
  assert.equal(
    encode([{ i: 0 }, { i: 1 }, { i: 2 }], { ...OPTS, maxArrayItems: 2 }).toon,
    '- i: 0\n- i: 1\n<... 1 more items>'
  );
});

test('maxStringLen truncates a ROOT string but NOT an object field — KNOWN-DEFECT', () => {
  const long = 'x'.repeat(10);
  assert.equal(encode(long, { ...OPTS, maxStringLen: 4 }).toon, 'xxxx...');
  // The object/array branches call _simpleValue(), which never truncates, so the
  // documented option silently does nothing for the most common shape.
  assert.equal(encode({ s: long }, { ...OPTS, maxStringLen: 4 }).toon, `s: ${long}`);
});

test('a multi-line string in a field is emitted raw — KNOWN-DEFECT (block form only at value position)', () => {
  assert.equal(encode({ text: 'one\ntwo' }).toon, 'text: one\ntwo');
  assert.equal(encode('one\ntwo').toon, '|\n  one\n  two');
});

test('_isSimple / _simpleValue / _indent are the primitives the shape rests on', () => {
  for (const v of [null, undefined, 's', 1, true, false]) {
    assert.equal(_isSimple(v), true, String(v));
  }
  assert.equal(_isSimple({}), false);
  assert.equal(_isSimple([]), false);

  assert.equal(_simpleValue(null), 'null');
  assert.equal(_simpleValue(undefined), 'null');
  assert.equal(_simpleValue('raw'), 'raw');
  assert.equal(_simpleValue(0), '0');
  assert.equal(_simpleValue(false), 'false');

  assert.equal(_indent(0), '');
  assert.equal(_indent(3), '      ');
});

// Helper: encode a value at depth 0 through the internal writer, returning text.
function _encodeAtDepth(value) {
  const lines = [];
  _encodeValue(value, 0, lines, OPTS);
  return lines.join('\n');
}
