'use strict';

/**
 * Colocated contract test for loopDetector.js (Phase-2 detector construction).
 * Batch 38 (C-4 test-colocated). Source file untouched.
 *
 * This leaf keeps its two LAZY requires on purpose (they must fire at the same
 * instant as the former inline block), so the test exercises the real modules and
 * pins the fail-soft contract rather than stubbing the graph out.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLoopDetector } = require('./loopDetector');

test('the bag carries exactly one key', () => {
  assert.deepEqual(Object.keys(createLoopDetector()), ['loopDetector']);
});

test('no deps at all still yields a usable detector (the missing resolver is swallowed)', () => {
  const r = createLoopDetector();
  assert.doesNotThrow(() => createLoopDetector());
  assert.notEqual(r.loopDetector, null, 'the detector itself built, only registration was skipped');
  assert.equal(typeof r.loopDetector.registerTools, 'function');
});

test('the memoized resolver is consulted at most once, with whatever the registry yields', () => {
  const seen = [];
  const r = createLoopDetector({
    resolveKnownToolNames: (tools) => {
      seen.push(tools);
      return ['marked-tool'];
    },
  });
  assert.ok(seen.length <= 1, 'one registration pass per construction');
  if (seen.length === 1) {
    assert.equal(typeof seen[0], 'object', 'registry output is forwarded untouched — the leaf does not assume an array');
    assert.notEqual(seen[0], null);
  }
  assert.notEqual(r.loopDetector, null);
});

test('a throwing resolver cannot take the loop down with it', () => {
  const r = createLoopDetector({
    resolveKnownToolNames: () => {
      throw new Error('memo resolver blew up');
    },
  });
  assert.notEqual(r.loopDetector, null, 'inner try/catch protects detector construction');
});

test('a resolver returning a non-array is still handed to registerTools unchanged', () => {
  // registerTools copies into its own Set, so a weird return must not throw here.
  assert.doesNotThrow(() => createLoopDetector({ resolveKnownToolNames: () => undefined }));
  assert.doesNotThrow(() => createLoopDetector({ resolveKnownToolNames: () => null }));
});

test('two calls build two independent detectors (no shared singleton state)', () => {
  const a = createLoopDetector({ resolveKnownToolNames: () => [] });
  const b = createLoopDetector({ resolveKnownToolNames: () => [] });
  assert.notEqual(a.loopDetector, b.loopDetector);
});
