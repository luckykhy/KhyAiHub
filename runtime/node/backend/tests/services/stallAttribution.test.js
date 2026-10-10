'use strict';

/**
 * classifyStall() — the three-way verdict and the line it earns.
 * ([DESIGN-ARCH-182])
 *
 * The whole point of this file's existence: a recovered event-loop stall used to
 * be reported as 「同步长任务或死循环嫌疑」 no matter what actually happened. A
 * machine with 10% free memory gets paged out wholesale, and from inside the
 * process that is indistinguishable from a sync block — except that the process
 * burned no CPU while it happened.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  classifyStall,
  stallNoticeLine,
  SYNC_CPU_RATIO,
  EXTERNAL_CPU_RATIO,
} = require('../../src/services/stallAttribution.js');

const us = (ms) => ms * 1000;

test('a window that burned a core is a sync block, not a paging victim', () => {
  const v = classifyStall({ driftMs: 383_300, cpuDeltaUs: us(383_000) });
  assert.strictEqual(v.kind, 'sync');
  assert.strictEqual(v.evidence, 'cpu-busy');
  assert.ok(v.cpuRatio > 0.99 && v.cpuRatio <= 1);
});

test('a window that burned nothing is the process not running at all', () => {
  // The 383.3s case from the field report: 383s of wall clock, ~0 CPU.
  const v = classifyStall({ driftMs: 383_300, cpuDeltaUs: 1_200, freePct: 10 });
  assert.strictEqual(v.kind, 'external');
  assert.strictEqual(v.evidence, 'cpu-idle');
  assert.ok(v.cpuRatio < EXTERNAL_CPU_RATIO);
  assert.strictEqual(v.freePct, 10);
});

test('the thresholds are the ones the design fixed, and they are inclusive', () => {
  assert.strictEqual(SYNC_CPU_RATIO, 0.5);
  assert.strictEqual(EXTERNAL_CPU_RATIO, 0.05);
  // Exactly at the line counts as that line — a boundary that fell the other way
  // would make the verdict depend on float noise.
  assert.strictEqual(
    classifyStall({ driftMs: 1000, cpuDeltaUs: us(500) }).kind,
    'sync'
  );
  assert.strictEqual(
    classifyStall({ driftMs: 1000, cpuDeltaUs: us(50) }).kind,
    'external'
  );
  assert.strictEqual(
    classifyStall({ driftMs: 1000, cpuDeltaUs: us(200) }).kind,
    'unknown'
  );
});

test('no usable measurement says so instead of accusing khy', () => {
  for (const input of [
    {},
    { driftMs: 0, cpuDeltaUs: 1000 },
    { driftMs: -5, cpuDeltaUs: 1000 },
    { driftMs: 1000 },
    { driftMs: 1000, cpuDeltaUs: null },
    { driftMs: 1000, cpuDeltaUs: 'abc' },
    null,
    undefined,
  ]) {
    const v = classifyStall(input);
    assert.strictEqual(v.kind, 'unknown', `input=${JSON.stringify(input)}`);
    assert.strictEqual(v.evidence, 'no-measurement');
    assert.strictEqual(v.cpuRatio, null);
  }
});

test('cpuRatio can exceed 1 (worker threads burn more than one core)', () => {
  const v = classifyStall({ driftMs: 1000, cpuDeltaUs: us(2500) });
  assert.strictEqual(v.kind, 'sync');
  assert.ok(v.cpuRatio > 1);
});

test('the input object is never mutated and a fresh object comes back', () => {
  const input = { driftMs: 1000, cpuDeltaUs: us(900), freePct: 12 };
  const snapshot = JSON.stringify(input);
  const v = classifyStall(input);
  assert.strictEqual(JSON.stringify(input), snapshot);
  assert.notStrictEqual(v, input);
});

test('the sync line keeps the old wording and gains a profiling pointer', () => {
  const line = stallNoticeLine({
    driftMs: 42_100,
    attribution: classifyStall({ driftMs: 42_100, cpuDeltaUs: us(41_800) }),
  });
  assert.match(line, /事件循环曾阻塞 42\.1s/);
  assert.match(line, /同步长任务嫌疑/);
  assert.match(line, /STARTUP_PROFILE=1/);
  assert.doesNotMatch(line, /死循环/);
});

test('the external line refuses to blame khy and quotes the headroom', () => {
  const line = stallNoticeLine({
    driftMs: 383_300,
    attribution: classifyStall({ driftMs: 383_300, cpuDeltaUs: 900, freePct: 10 }),
  });
  assert.match(line, /事件循环曾停滞 383\.3s/);
  assert.match(line, /非 khy 同步任务/);
  assert.match(line, /当前空闲 10%/);
  assert.match(line, /clipboard bridge stop/);
  // The accusation this file exists to remove.
  assert.doesNotMatch(line, /死循环/);
  assert.doesNotMatch(line, /STARTUP_PROFILE/);
});

test('an unclassifiable stall states both possibilities rather than picking one', () => {
  const line = stallNoticeLine({
    driftMs: 383_300,
    attribution: classifyStall({ driftMs: 383_300, cpuDeltaUs: us(120_000) }),
  });
  assert.match(line, /未能区分/);
  assert.match(line, /同步长任务或进程被停走/);
  assert.doesNotMatch(line, /死循环/);
});

test('the line builder survives a malformed attribution (fail-soft)', () => {
  for (const attribution of [undefined, null, {}, { kind: 'sync' }, { kind: 7 }]) {
    const line = stallNoticeLine({ driftMs: 1000, attribution });
    assert.strictEqual(typeof line, 'string');
    assert.ok(line.startsWith('[Watchdog] '));
    assert.ok(line.length > 0);
  }
});
