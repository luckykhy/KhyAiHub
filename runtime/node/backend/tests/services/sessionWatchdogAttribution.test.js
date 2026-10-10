'use strict';

/**
 * Stall attribution as the watchdog actually wires it ([DESIGN-ARCH-182]).
 *
 * The sibling suite `__tests__/sessionWatchdog.test.js` (jest) proves the notice
 * POLICY — quiet by default, burst merging, `=all` / `=off`. It blocks the loop
 * for real to do it, which is the right way to test that policy and the wrong
 * way to test attribution: a real busy loop burns CPU, so every stall it
 * produces is legitimately `sync` and the external branch is never reached.
 *
 * These cases inject `cpuUsage` / `freemem` / `totalmem` through the same seams
 * the real caller leaves open, so a 383-second verdict is driven in
 * milliseconds and the `external` path — the one the field report was about —
 * is exercised end to end: beat → classify → ledger → line → onHang → stats().
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  installSessionWatchdog,
  resetForTest,
} = require('../../src/services/sessionWatchdog.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same seams the jest suite uses; only the attribution inputs differ.
const FAST = {
  sampleMs: 40,
  stallMs: 50,
  idleLimitMs: 30 * 60_000,
  stallRepeat: 3,
  stallWindowMs: 60_000,
  stallAlertMs: 400,
};

/** Block the loop long enough for the next beat to see a drift. */
function blockLoop(ms) {
  const t = Date.now();
  // eslint-disable-next-line no-empty
  while (Date.now() - t < ms) {}
}

/** Swallow everything the watchdog would put on the terminal. */
function captureTerminal() {
  const lines = [];
  const stderrWrite = process.stderr.write.bind(process.stderr);
  const consoleError = console.error;
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  console.error = (...args) => {
    lines.push(args.map(String).join(' '));
  };
  return {
    lines,
    stop() {
      process.stderr.write = stderrWrite;
      console.error = consoleError;
    },
  };
}

/**
 * A `process.cpuUsage()` stand-in that models what actually happens: CPU time
 * accrues with WALL CLOCK at the current rate, not per call. A busy process
 * burns ~1 core while it spins; a descheduled one burns nothing no matter how
 * long the wall clock runs. Set `rate` between beats to switch worlds —
 * `1` is "khy is looping", `0` is "the box had nothing left to give".
 */
function fakeCpu(state) {
  let last = Date.now();
  let micros = 0;
  return () => {
    const now = Date.now();
    micros += Math.max(0, now - last) * 1000 * (state.rate || 0);
    last = now;
    return { user: micros, system: 0 };
  };
}

function installAttributed({ cpu, freePct = 55, env = {} } = {}) {
  const term = captureTerminal();
  const hangs = [];
  const inst = installSessionWatchdog({
    env,
    ...FAST,
    onHang: (h) => hangs.push(h),
    cpuUsage: cpu,
    freemem: () => (freePct / 100) * 16 * 1024 ** 3,
    totalmem: () => 16 * 1024 ** 3,
  });
  return { inst, term, hangs };
}

test.afterEach(() => resetForTest());

test('a busy stall is reported as a sync block, with the profiling pointer', async () => {
  resetForTest();
  const world = { rate: 1 }; // the loop burns a core while it spins
  const { inst, term, hangs } = installAttributed({ cpu: fakeCpu(world) });
  try {
    await sleep(120);
    blockLoop(600); // >= stallAlertMs (400)
    await sleep(120);

    const stall = hangs.filter((h) => h.kind === 'stall');
    assert.ok(stall.length >= 1, 'the stall must be observed');
    assert.strictEqual(stall[0].attribution, 'sync');
    assert.ok(stall[0].cpuRatio > 0.5, `cpuRatio=${stall[0].cpuRatio}`);

    const line = term.lines[0] || '';
    assert.match(line, /事件循环曾阻塞/);
    assert.match(line, /同步长任务嫌疑/);
    assert.match(line, /STARTUP_PROFILE=1/);
    assert.strictEqual(inst.stats().stalls.byKind.sync >= 1, true);
  } finally {
    inst.stop();
    term.stop();
  }
});

test('a stall that burned no CPU is NOT told it has a dead loop', async () => {
  resetForTest();
  // rate 0: the wall clock ran, the process did not get a CPU — the field case.
  const { inst, term, hangs } = installAttributed({
    cpu: fakeCpu({ rate: 0 }),
    freePct: 10,
  });
  try {
    await sleep(120);
    blockLoop(600);
    await sleep(120);

    const stall = hangs.filter((h) => h.kind === 'stall');
    assert.ok(stall.length >= 1, 'the stall must still be observed — suppression is not the fix');
    assert.strictEqual(stall[0].attribution, 'external');
    assert.ok(stall[0].cpuRatio <= 0.05, `cpuRatio=${stall[0].cpuRatio}`);

    const line = term.lines[0] || '';
    assert.match(line, /事件循环曾停滞/);
    assert.match(line, /非 khy 同步任务/);
    assert.match(line, /当前空闲 10%/);
    // The accusation this change exists to retract:
    assert.doesNotMatch(line, /死循环/);
    assert.strictEqual(inst.stats().stalls.byKind.external >= 1, true);
  } finally {
    inst.stop();
    term.stop();
  }
});

test('attribution never suppresses a line the policy already owed', async () => {
  resetForTest();
  // The isolated-stall case the 2026-09-23 quiet policy silences: still silent.
  const { inst, term, hangs } = installAttributed({ cpu: fakeCpu({ rate: 0 }) });
  try {
    await sleep(120);
    blockLoop(200); // < stallAlertMs, first of the burst
    await sleep(120);
    assert.strictEqual(term.lines.length, 0, 'quiet default still means quiet');
    assert.ok(hangs.filter((h) => h.kind === 'stall').length >= 1, 'but it is still observed');
  } finally {
    inst.stop();
    term.stop();
  }
});

test('a mixed burst merges into one line that names both causes', async () => {
  resetForTest();
  // Busy, idle, busy: the merged line must not flatten them into one cause.
  const world = { rate: 1 };
  const { inst, term } = installAttributed({ cpu: fakeCpu(world) });
  try {
    await sleep(120);
    blockLoop(200);
    await sleep(120);
    world.rate = 0;
    blockLoop(200);
    await sleep(120);
    world.rate = 1;
    blockLoop(200);
    await sleep(160);

    const merged = term.lines.filter((l) => l.includes('内阻塞'));
    assert.strictEqual(merged.length, 1, `expected one merged line, got ${merged.length}`);
    assert.match(merged[0], /同步长任务嫌疑 \d+ 次/);
    assert.match(merged[0], /进程被停走 \d+ 次/);
  } finally {
    inst.stop();
    term.stop();
  }
});

test('a broken cpuUsage probe degrades to unknown, never to an accusation', async () => {
  resetForTest();
  const { inst, term, hangs } = installAttributed({
    cpu: () => {
      throw new Error('probe unavailable');
    },
  });
  try {
    await sleep(120);
    blockLoop(600);
    await sleep(120);
    const stall = hangs.filter((h) => h.kind === 'stall');
    assert.ok(stall.length >= 1);
    assert.strictEqual(stall[0].attribution, 'unknown');
    assert.strictEqual(stall[0].cpuRatio, null);
    const line = term.lines[0] || '';
    assert.match(line, /未能区分/);
    assert.doesNotMatch(line, /死循环/);
  } finally {
    inst.stop();
    term.stop();
  }
});

test('a probe returning null is "no reading", not "zero CPU"', async () => {
  resetForTest();
  // The regression this file's sibling caught in the leaf: `Number(null) === 0`
  // used to turn a missing reading into an all-clear verdict.
  const { inst, term, hangs } = installAttributed({ cpu: () => null });
  try {
    await sleep(120);
    blockLoop(600);
    await sleep(120);
    const stall = hangs.filter((h) => h.kind === 'stall');
    assert.ok(stall.length >= 1);
    assert.strictEqual(stall[0].attribution, 'unknown');
    assert.doesNotMatch(term.lines[0] || '', /死循环/);
  } finally {
    inst.stop();
    term.stop();
  }
});

test('stats() reports the byKind split without disturbing the old fields', async () => {
  resetForTest();
  const { inst } = installAttributed({ cpu: fakeCpu({ rate: 0 }) });
  try {
    await sleep(120);
    blockLoop(200);
    await sleep(120);
    const s = inst.stats().stalls;
    // The 2026-09-23 contract: honest totals plus how many lines were seen.
    assert.ok(typeof s.count === 'number' && s.count >= 1);
    assert.ok(typeof s.reported === 'number' && typeof s.suppressed === 'number');
    assert.ok(typeof s.maxMs === 'number' && typeof s.totalMs === 'number');
    const kinds = s.byKind;
    assert.deepStrictEqual(Object.keys(kinds).sort(), ['external', 'sync', 'unknown']);
    assert.strictEqual(
      kinds.sync + kinds.external + kinds.unknown,
      s.count,
      'every stall must land in exactly one bucket'
    );
  } finally {
    inst.stop();
  }
});
