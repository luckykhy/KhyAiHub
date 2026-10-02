'use strict';

// Co-located contract tests for the toonCodec.js host
// ([RESEARCH-018] §2.3 / C-4 功能单元含测试).
//
// toonCodec.js is a re-export shell assembled from two pure leaves. A shell keeps
// `require` working while returning NOTHING to anything that reads source as text,
// so the only thing worth proving here is the shell invariant: every exported name
// is the same binding as the leaf's, and the shell adds no behaviour of its own.

const test = require('node:test');
const assert = require('node:assert/strict');

const codec = require('./toonCodec');
const encodeLeaf = require('./toonEncode');
const decodeLeaf = require('./toonDecode');

test('the host exports exactly the four documented names and nothing else', () => {
  assert.deepEqual(Object.keys(codec).sort(), [
    '_TOON_MAX_DECODE_DEPTH',
    '_toonDepthCapEnabled',
    'decode',
    'encode',
  ]);
});

test('every host symbol is the SAME binding as its leaf (identity, not a wrapper)', () => {
  assert.equal(codec.encode, encodeLeaf.encode);
  assert.equal(codec.decode, decodeLeaf.decode);
  assert.equal(codec._toonDepthCapEnabled, decodeLeaf._toonDepthCapEnabled);
  assert.equal(codec._TOON_MAX_DECODE_DEPTH, decodeLeaf._TOON_MAX_DECODE_DEPTH);
});

test('the host adds no behaviour: its leaves never point back at it', () => {
  // The two leaves share only their own private INDENT copy, so there is no
  // host-to-leaf or leaf-to-host back-edge to form a cycle.
  assert.equal(require.cache[require.resolve('./toonCodec')] !== undefined, true);
  assert.equal(Object.prototype.hasOwnProperty.call(encodeLeaf, 'decode'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(decodeLeaf, 'encode'), false);
});

test('through the host, encode and decode still round-trip a flat object', () => {
  const value = { provider: 'deepseek', model: 'x', temperature: 0.2, stream: true };
  const { toon, stats } = codec.encode(value);
  assert.equal(toon, 'provider: deepseek\nmodel: x\ntemperature: 0.2\nstream: true');
  assert.ok(stats.savedPercent > 0, `expected TOON to beat JSON, got ${stats.savedPercent}%`);
  assert.deepEqual(codec.decode(toon), value);
});
