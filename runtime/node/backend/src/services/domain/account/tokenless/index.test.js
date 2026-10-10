'use strict';

// Co-located contract tests for the account/tokenless host index.js
// ([RESEARCH-018] §2.3 / C-4 功能单元含测试).
//
// The index is the unit's only public surface; expectations below were read from
// actual behavior (probe .khyos/tmp/tokenless-behavior-probe.js). Two naming facts
// are pinned on purpose: `toonEncode` / `toonDecode` are the FUNCTIONS, not the leaf
// modules, and `toonCodec` is the module object — an asymmetry a caller can trip on.

const test = require('node:test');
const assert = require('node:assert/strict');

const idx = require('./index');
const codecHost = require('./toonCodec');

const KEYS = [
  'compressSchema',
  'compressTools',
  'compressResponse',
  'compressToolOutput',
  'rewriteHistory',
  'stripCompletedToolCalls',
  'toonEncode',
  'toonDecode',
  'toonCodec',
  'tokenlessPlugin',
  'getStats',
  'resetStats',
];

test('the unit publishes exactly the documented 12 names', () => {
  assert.deepEqual(Object.keys(idx).sort(), [...KEYS].sort());
});

test('naming asymmetry: toonEncode/toonDecode are functions, toonCodec is the module', () => {
  assert.equal(typeof idx.toonEncode, 'function');
  assert.equal(typeof idx.toonDecode, 'function');
  assert.equal(typeof idx.toonCodec, 'object');
  assert.equal(idx.toonCodec, codecHost);
  // `toonEncode` is the encode() function itself, so it returns {toon, stats}.
  assert.equal(idx.toonEncode({ a: 1 }).toon, 'a: 1');
  assert.equal(idx.toonDecode('a: 1').a, 1);
});

test('stats start at zero and resetStats restores them to the same shape', () => {
  const shape = {
    schemaTokensSaved: 0,
    responseTokensSaved: 0,
    historyTokensSaved: 0,
    totalRequests: 0,
  };
  idx.resetStats();
  assert.deepEqual(idx.getStats(), shape);
});

test('compressSchema renders the field-shape shorthand, marking optional fields', () => {
  const out = idx.compressSchema({
    type: 'object',
    properties: { a: { type: 'string' } },
  });
  assert.equal(typeof out, 'string');
  assert.equal(out, '{a:s?}');
});

test('compressResponse returns {text, stats} and never mutates the payload shape', () => {
  const payload = { a: 'x'.repeat(40) };
  const out = idx.compressResponse(payload);
  assert.ok(out && typeof out === 'object');
  assert.deepEqual(Object.keys(out).sort(), ['stats', 'text']);
  assert.deepEqual(out.text, payload);
  for (const k of ['original', 'compressed', 'savedPercent']) {
    assert.equal(typeof out.stats[k], 'number', k);
  }
});

test('rewriteHistory and stripCompletedToolCalls are re-exported unchanged from the leaf', () => {
  const leaf = require('./commandRewriter');
  assert.equal(idx.rewriteHistory, leaf.rewriteHistory);
  assert.equal(idx.stripCompletedToolCalls, leaf.stripCompletedToolCalls);
});

test('tokenlessPlugin is the object the gateway can register', () => {
  assert.equal(typeof idx.tokenlessPlugin, 'object');
  assert.ok(idx.tokenlessPlugin !== null);
});
