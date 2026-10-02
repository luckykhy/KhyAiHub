'use strict';

// Co-located contract tests for toonDecode.js ([RESEARCH-018] §2.3 / C-4 功能单元含测试).
//
// Every expectation was copied from the module's ACTUAL output (probe
// .khyos/tmp/toon-behavior-probe.js), including three round-trip breaks that encode
// and decode disagree about. Those are tagged KNOWN-DEFECT and registered for a human
// call ([DESIGN-LAY-008] §12.35) — they are NOT fixed here, because a codec change
// silently rewrites what the model receives.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decode,
  _parseLines,
  _toonDepthCapEnabled,
  _TOON_MAX_DECODE_DEPTH,
  _getIndent,
  _parseSimple,
} = require('./toonDecode');
const { encode } = require('./toonEncode');

test('non-string and empty input decode to null, never throw', () => {
  for (const input of ['', null, undefined, 5, {}, []]) {
    assert.equal(decode(input), null, JSON.stringify(input));
  }
});

test('scalar literals and truncation markers decode to their JSON equivalents', () => {
  assert.equal(decode('null'), null);
  assert.equal(decode('true'), true);
  assert.equal(decode('false'), false);
  assert.equal(decode('42'), 42);
  assert.equal(decode('-3.5'), -3.5);
  assert.deepEqual(decode('{}'), {});
  assert.deepEqual(decode('[]'), []);
  // encode() writes `<truncated>` past maxDepth; decode maps it back to null.
  assert.equal(decode('<truncated>'), null);
});

test('an object body decodes key by key at depth 0', () => {
  assert.deepEqual(decode('name: tom\ncount: 3\nok: true'), { name: 'tom', count: 3, ok: true });
});

test('a `key:` line opens a nested object at the next indent', () => {
  assert.deepEqual(decode('user:\n  name: tom\n  age: 7'), { user: { name: 'tom', age: 7 } });
});

test('a `- ` block decodes to an array, with continuation keys folded into each item', () => {
  assert.deepEqual(decode('- id: 1\n  name: a\n- id: 2\n  name: b'), [
    { id: 1, name: 'a' },
    { id: 2, name: 'b' },
  ]);
  assert.deepEqual(decode('list:\n  - a\n  - b'), { list: ['a', 'b'] });
});

test('inline arrays decode only when they are valid JSON — KNOWN-DEFECT for strings', () => {
  assert.deepEqual(decode('[1, 2]'), [1, 2]);
  // encode() inlines simple arrays WITHOUT quotes, so JSON.parse fails and the
  // whole line comes back as a string instead of an array.
  assert.equal(decode('[a, b]'), '[a, b]');
  assert.deepEqual(decode(encode([1, 2, 3]).toon), [1, 2, 3]);
  assert.equal(decode(encode(['a', 'b']).toon), '[a, b]');
});

test('encode→decode round-trips a flat object but loses nested simple arrays — KNOWN-DEFECT', () => {
  const flat = { name: 'tom', count: 3, ok: true };
  assert.deepEqual(decode(encode(flat).toon), flat);

  const nested = encode({ user: { name: 'tom', tags: ['a'] } }).toon;
  assert.deepEqual(decode(nested), { user: { name: 'tom', tags: '[a]' } });
});

test('a multi-line field round-trip drops every line after the first — KNOWN-DEFECT', () => {
  assert.deepEqual(decode('text: one\ntwo'), { text: 'one' });
});

test('the decode depth cap is on by default and honors the documented off tokens', () => {
  const key = 'KHY_TOON_DEPTH_CAP';
  const saved = process.env[key];
  try {
    delete process.env[key];
    assert.equal(_toonDepthCapEnabled(), true);
    for (const off of ['0', 'false', 'off', 'no', ' OFF ', 'No']) {
      process.env[key] = off;
      assert.equal(_toonDepthCapEnabled(), false, off);
    }
    process.env[key] = '1';
    assert.equal(_toonDepthCapEnabled(), true);
  } finally {
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  }
});

test('a pathologically deep document returns null instead of overflowing the stack', () => {
  // 3000 nested `key:` lines — well past _TOON_MAX_DECODE_DEPTH (2048) and past
  // the uncapped recursion limit that motivated the guard.
  const deep = Array.from({ length: 3000 }, () => 'a:').join('\n');
  assert.doesNotThrow(() => decode(deep));
  assert.equal(_TOON_MAX_DECODE_DEPTH, 2048);
  // Past the bound the parser returns the same null encode's <truncated> decodes to.
  assert.deepEqual(_parseLines(['a: 1'], 0, 0, _TOON_MAX_DECODE_DEPTH + 1), {
    value: null,
    nextIdx: 1,
  });
});

test('_getIndent counts INDENT units and _parseSimple keeps the null/bool/number rules', () => {
  assert.equal(_getIndent('x'), 0);
  assert.equal(_getIndent('  x'), 1);
  assert.equal(_getIndent('    x'), 2);
  assert.equal(_getIndent('\tx'), 0);

  assert.equal(_parseSimple('null'), null);
  assert.equal(_parseSimple(''), null);
  assert.equal(_parseSimple('true'), true);
  assert.equal(_parseSimple('false'), false);
  assert.equal(_parseSimple('7'), 7);
  assert.equal(_parseSimple('hello'), 'hello');
});
