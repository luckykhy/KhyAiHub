'use strict';

// Unit-level contract tests for deadLoopDetector.js (co-located, per [RESEARCH-018] §2.3).
// RUNTIME-003/004 posture: the detector is a pure in-memory decision function — these
// tests drive it with synthetic call sequences only (no spinning, no timers, no IO).
// The semantic core: a call is dead if it repeats the immediately-preceding signature
// OR any signature already seen this session; "retry allowed" requires changed()===true.

const test = require('node:test');
const assert = require('node:assert/strict');

const { DeadLoopDetector } = require('./deadLoopDetector');
const { callSignature } = require('./errorSignature');

test('module face exports exactly the detector class', () => {
  assert.deepEqual(Object.keys(require('./deadLoopDetector')), ['DeadLoopDetector']);
});

test('fresh session: first sighting of any signature is alive', () => {
  const d = new DeadLoopDetector();
  const r = d.inspect('WebFetch', { url: 'a' });
  assert.deepEqual(r, {
    signature: callSignature('WebFetch', { url: 'a' }),
    sameAsLast: false,
    repeats: 1,
    dead: false,
  });
});

test('immediate repeat is dead, and inspect() registers as it decides', () => {
  const d = new DeadLoopDetector();
  const p = { url: 'a' };
  assert.equal(d.inspect('T', p).dead, false);
  const second = d.inspect('T', p);
  assert.equal(second.dead, true);
  assert.equal(second.sameAsLast, true);
  assert.equal(second.repeats, 2);
  // A third send keeps counting and stays dead.
  assert.equal(d.inspect('T', p).repeats, 3);
});

test('non-adjacent repeat is dead via the session count table (sameAsLast false)', () => {
  const d = new DeadLoopDetector();
  assert.equal(d.inspect('T', { n: 1 }).dead, false); // A
  const mid = d.inspect('T', { n: 2 });               // B
  assert.equal(mid.dead, false);
  assert.equal(mid.sameAsLast, false);
  const back = d.inspect('T', { n: 1 });             // A again, not adjacent
  assert.equal(back.dead, true);
  assert.equal(back.sameAsLast, false, 'the counts table, not _last, catches this one');
  assert.equal(back.repeats, 2);
});

test('fingerprint equality is logical, not identity: fresh object, same content = dead', () => {
  const d = new DeadLoopDetector();
  d.inspect('T', { url: 'x', headers: { a: 1 } });
  const r = d.inspect('T', { headers: { a: 1 }, url: 'x' }); // new object, key order shuffled
  assert.equal(r.dead, true, 'the "same bullet in disguise" case the protocol targets');
});

test('inspect registers even when the executor will skip (probe-then-skip still counts)', () => {
  const d = new DeadLoopDetector();
  d.inspect('T', { p: 1 });          // shot fired
  d.inspect('T', { p: 1 });          // dead-skip: registered, repeats becomes 2
  const third = d.inspect('T', { p: 1 });
  assert.equal(third.repeats, 3);
  assert.equal(third.dead, true);
});

test('changed(): only a different fingerprint counts as "really repaired"', () => {
  const d = new DeadLoopDetector();
  assert.equal(d.changed('T', { url: 'a' }, 'T', { url: 'b' }), true);
  assert.equal(d.changed('T', { url: 'a' }, 'T2', { url: 'a' }), true, 'tool swap counts as change');
  assert.equal(d.changed('T', { url: 'a' }, 'T', { url: 'a' }), false);
  assert.equal(d.changed('T', { url: 'a' }, ' T ', { url: 'a' }), false,
    'tool name case/space is normalized away before comparing');
  assert.equal(d.changed('T', { a: 1, b: 2 }, 'T', { b: 2, a: 1 }), false,
    'key order is irrelevant — "reordered" is not "repaired"');
});

test('changed() and signature() are side-effect free: they never register', () => {
  const d = new DeadLoopDetector();
  d.inspect('T', { p: 1 }); // 1 real registration
  for (let i = 0; i < 5; i++) {
    d.changed('T', { p: 1 }, 'T', { p: 2 });
    d.signature('T', { p: 2 });
  }
  const r = d.inspect('T', { p: 1 });
  assert.equal(r.repeats, 2, 'saw exactly the one earlier registration for p:1');
  assert.equal(r.dead, true);
  const fresh = d.inspect('T', { p: 2 });
  assert.equal(fresh.repeats, 1, 'p:2 was only hashed, never registered → alive');
  assert.equal(fresh.dead, false);
});

test('signature() mirrors callSignature exactly (single fingerprint source)', () => {
  const d = new DeadLoopDetector();
  assert.equal(d.signature('Web', { q: 'x' }), callSignature('Web', { q: 'x' }));
  assert.equal(d.signature('Web'), callSignature('Web', {}));
});

test('reset() clears both the last-shot pointer and the count table', () => {
  const d = new DeadLoopDetector();
  d.inspect('T', { p: 1 });
  d.inspect('T', { p: 1 }); // dead at repeats 2
  d.reset();
  const after = d.inspect('T', { p: 1 });
  assert.deepEqual(after.repeats, 1);
  assert.equal(after.dead, false, 'post-reset the session is blank again');
  assert.equal(after.sameAsLast, false);
});

test('inspect tolerates hostile inputs without throwing (pure memory, 绝不抛错)', () => {
  const d = new DeadLoopDetector();
  const c = {}; c.self = c;
  for (const junk of [undefined, null, 0, 'str', c]) {
    const r = d.inspect('T', junk);
    assert.equal(typeof r.signature, 'string');
    assert.equal(typeof r.dead, 'boolean');
  }
});
