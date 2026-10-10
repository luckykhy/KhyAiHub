'use strict';

/**
 * Colocated contract test for checkpointThrottle.js (throttled UI checkpoint emit).
 * Batch 38 (C-4 test-colocated). Source file untouched.
 *
 * Date.now is stubbed only inside the two tests that need clock control, and the
 * original is restored in a finally.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCheckpointThrottle } = require('./checkpointThrottle');

function callWith(throttle, events, iteration, logSize = 3) {
  const toolCallLog = Array.from({ length: logSize }, (_, i) => i);
  throttle.maybeCheckpoint({
    onCheckpoint: (p) => events.push(p),
    iteration,
    totalToolCalls: iteration * 2,
    toolCallLog,
    fileReadHashes: new Map([['/a', 'h1']]),
  });
}

function withClock(now, body) {
  const real = Date.now;
  Date.now = () => now();
  try {
    return body();
  } finally {
    Date.now = real;
  }
}

test('the factory exposes only maybeCheckpoint', () => {
  assert.deepEqual(Object.keys(createCheckpointThrottle()), ['maybeCheckpoint']);
});

test('emits every 3rd iteration and skips the others', () => {
  const events = [];
  const ct = createCheckpointThrottle();
  for (let i = 1; i <= 6; i += 1) callWith(ct, events, i);
  assert.deepEqual(events.map((e) => e.iteration), [3, 6]);
});

test('the payload carries the throttle-relevant snapshot, not the whole log', () => {
  const events = [];
  const ct = createCheckpointThrottle();
  callWith(ct, events, 3, 25);
  assert.equal(events.length, 1);
  assert.equal(events[0].iteration, 3);
  assert.equal(events[0].totalToolCalls, 6);
  assert.equal(events[0].toolCallLog.length, 20, 'capped at the last 20 entries');
  assert.deepEqual(events[0].toolCallLog.slice(-1), [24]);
  assert.deepEqual([...events[0].fileReadHashes.entries()], [['/a', 'h1']]);
});

test('a short log is passed through the slice unchanged', () => {
  const events = [];
  const ct = createCheckpointThrottle();
  callWith(ct, events, 3, 2);
  assert.deepEqual(events[0].toolCallLog, [0, 1]);
});

test('time-based emit fires past 45s even off the 3-iteration grid', () => {
  let now = 1_000_000;
  const events = [];
  withClock(() => now, () => {
    const ct = createCheckpointThrottle(); // captures lastCheckpointTime = now
    now += 45_000; // exactly the threshold: the test is `>`, not `>=`
    callWith(ct, events, 1);
    assert.equal(events.length, 0, '45s on the nose does NOT fire');
    now += 1;
    callWith(ct, events, 1);
    assert.equal(events.length, 1, '45s + 1ms fires');
  });
});

test('a fired checkpoint resets the clock, so the next one waits another 45s', () => {
  let now = 2_000_000;
  const events = [];
  withClock(() => now, () => {
    const ct = createCheckpointThrottle();
    now += 45_001;
    callWith(ct, events, 1);
    assert.equal(events.length, 1);
    now += 44_000; // 44s after the emit → still silent
    callWith(ct, events, 2);
    assert.equal(events.length, 1);
    now += 2_000;
    callWith(ct, events, 2);
    assert.equal(events.length, 2, '46s after the previous emit → fires again');
  });
});

test('the callback throwing is swallowed and the throttle still advances', () => {
  let now = 3_000_000;
  withClock(() => now, () => {
    const ct = createCheckpointThrottle();
    now = 3_046_000; // the grid fires it (iteration 3); the clock is already past 45s too
    assert.doesNotThrow(() =>
      ct.maybeCheckpoint({
        onCheckpoint: () => {
          throw new Error('UI renderer died');
        },
        iteration: 3,
        totalToolCalls: 1,
        toolCallLog: [],
        fileReadHashes: new Map(),
      })
    );
    // Had the swallowed call failed to advance the clock, this next off-grid call
    // would sit 90s past construction and fire. It must not.
    now = 3_090_000;
    let fired = 0;
    ct.maybeCheckpoint({ onCheckpoint: () => { fired += 1; }, iteration: 2, totalToolCalls: 1, toolCallLog: [], fileReadHashes: new Map() });
    assert.equal(fired, 0, 'the swallowed call still consumed the throttle window');
  });
});

test('no callback, or no args at all, is a silent no-op', () => {
  const ct = createCheckpointThrottle();
  assert.doesNotThrow(() => ct.maybeCheckpoint());
  assert.doesNotThrow(() => ct.maybeCheckpoint({ iteration: 3 }));
  assert.doesNotThrow(() => ct.maybeCheckpoint({ onCheckpoint: 'not-a-function', iteration: 3, toolCallLog: [] }));
});

test('KNOWN BEHAVIOUR (B38-S2, registered not fixed): a non-array log drops the checkpoint silently', () => {
  // toolCallLog.slice(-20) runs INSIDE the best-effort try, so a log without
  // .slice throws there and the emit is discarded with it — the UI never sees the
  // checkpoint and nothing is logged.
  const ct = createCheckpointThrottle();
  let fired = 0;
  assert.doesNotThrow(() =>
    ct.maybeCheckpoint({ onCheckpoint: () => { fired += 1; }, iteration: 3, toolCallLog: undefined })
  );
  assert.equal(fired, 0, 'undefined log → the emit silently vanishes');
  // A string DOES survive .slice(-20), so the shape guard is accidental, not designed:
  ct.maybeCheckpoint({ onCheckpoint: () => { fired += 1; }, iteration: 6, toolCallLog: 'abcdefghij' });
  assert.equal(fired, 1, 'a string log reaches the callback as a string slice');
  assert.equal(typeof ct.maybeCheckpoint, 'function');
});

test('two throttles keep independent clocks', () => {
  const a = [];
  const b = [];
  const ct1 = createCheckpointThrottle();
  const ct2 = createCheckpointThrottle();
  callWith(ct1, a, 3);
  assert.equal(a.length, 1);
  callWith(ct2, b, 1);
  assert.equal(b.length, 0, 'a fresh throttle is not "already on iteration 3"');
  callWith(ct2, b, 3);
  assert.equal(b.length, 1);
});
