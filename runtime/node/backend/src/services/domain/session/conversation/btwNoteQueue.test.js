'use strict';

/**
 * btwNoteQueue.js contract tests — the process-level `/btw` queue singleton.
 * In-memory only (no file IO by design), so every case drains/clears the shared
 * state it touches; node --test gives each file its own process, so ordering
 * between files cannot leak.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const queue = require('./btwNoteQueue');
const leaf = require('./btwNote');

test('module surface is exactly the four queue operations', () => {
  assert.deepEqual(Object.keys(queue).sort(), ['clear', 'count', 'drainAll', 'enqueue']);
  for (const k of Object.keys(queue)) {
    assert.equal(typeof queue[k], 'function', `${k} must be a function`);
  }
});

test('enqueue normalizes through the leaf and reports whether it stored anything', () => {
  queue.clear();
  assert.equal(queue.count(), 0);
  assert.equal(queue.enqueue('  补一句  '), true);
  assert.equal(queue.count(), 1);
  for (const empty of ['', '   ', null, undefined]) {
    assert.equal(queue.enqueue(empty), false, `${String(empty)} must not enter the queue`);
  }
  assert.equal(queue.count(), 1, 'rejected entries did not grow the queue');
  assert.deepEqual(queue.drainAll(), ['补一句'], 'stored entry is the normalized form, not the raw one');
});

test('FIFO order is preserved and capped the same way as the leaf', () => {
  queue.clear();
  queue.enqueue('first');
  queue.enqueue('second');
  queue.enqueue('third');
  assert.equal(queue.count(), 3);
  assert.deepEqual(queue.drainAll(), ['first', 'second', 'third']);
  assert.equal(queue.count(), 0, 'drainAll empties');

  queue.clear();
  queue.enqueue('x'.repeat(5000));
  assert.equal(queue.drainAll()[0].length, leaf._MAX_NOTE_LEN, 'the leaf cap applies on the way in');
});

test('drainAll empties in one shot and hands back a detached copy', () => {
  queue.clear();
  queue.enqueue('a');
  queue.enqueue('b');
  const drained = queue.drainAll();
  assert.deepEqual(drained, ['a', 'b']);
  assert.equal(queue.count(), 0);
  drained.push('mutated');
  assert.equal(queue.count(), 0, 'mutating the returned array cannot refill the queue');
  assert.deepEqual(queue.drainAll(), [], 'a second drain is empty');
});

test('clear drops pending notes without returning them', () => {
  queue.clear();
  queue.enqueue('to be dropped');
  assert.equal(queue.clear(), undefined, 'clear is a void operation (unlike drainAll)');
  assert.equal(queue.count(), 0);
  assert.deepEqual(queue.drainAll(), []);
});

test('the queue is one instance per process (require cache is the single source)', () => {
  assert.equal(require('./btwNoteQueue'), queue, 'second require must return the same singleton');
  queue.clear();
  queue.enqueue('visible through the other handle');
  assert.equal(require('./btwNoteQueue').count(), 1, 'state is shared, not per-require');
  queue.clear();
});

test('pending notes reach the next turn through the leaf merge format', () => {
  queue.clear();
  queue.enqueue('先看 CI');
  queue.enqueue('再看 lint');
  const merged = leaf.mergeHints('跑测试', queue.drainAll());
  assert.equal(merged, '跑测试\n\n' + leaf._HINT_HEADER + '\n先看 CI\n再看 lint');
  assert.equal(queue.count(), 0, 'merging consumed the queue exactly once');
});

test('the store holds no file/network IO (purity lock on the source text)', () => {
  const src = require('node:fs').readFileSync(require.resolve('./btwNoteQueue'), 'utf8');
  const code = src
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/)/.test(l))
    .join('\n');
  assert.ok(!/writeFileSync|readFileSync|openSync|spawn|execFile|fetch\(/.test(code), 'no IO in the store');
  assert.ok(!code.includes('process.env'), 'the gate lives in the leaf, not here');
});
