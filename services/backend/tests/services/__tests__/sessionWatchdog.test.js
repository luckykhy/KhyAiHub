'use strict';
/**
 * sessionWatchdog leaf tests (node:test).
 *
 * Coverage:
 *   - idle hang fires once per episode with the honest onHang payload
 *   - activity (stdout writes) postpones and re-arms the idle report
 *   - self-report writes never reset the idle clock they report on
 *   - per-process idempotency (Symbol lock) and gate-off / resetForTest
 *   - sync-stall sampler is unref'd (never holds the event loop open)
 *   - onReport host handoff: only an explicit `true` takes the line; refusal,
 *     throw or an absent hook keep the historical stderr write
 *   - sync-stall notice policy: the DEFAULT is quiet (an isolated self-healed
 *     stall prints nothing), a repeated burst merges into one line, an
 *     over-long stall still speaks at once, `=all` / `=off` override the
 *     default, and nothing is lost (onHang + stats() see every stall)
 *
 * Timing: real timers with shrunken sampleMs/idleLimitMs injected via opts;
 * windows are padded so the suite stays reliable on loaded CI machines.
 */
const { installSessionWatchdog, resetForTest } = require('../../../src/services/sessionWatchdog.js');
const { activeGatewayRequests } = require('../../../src/cli/aiLocalState.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST = { sampleMs: 40, idleLimitMs: 120, stallMs: 60_000 };

// ── Pending-work fixture ────────────────────────────────────────────────
// The idle line's precondition is "work is pending AND no output" (the module
// header explains why bare silence is NOT a hang: it is what a session waiting
// at the prompt looks like). Tests that are about the onReport handoff rather
// than the judgment must therefore state that precondition explicitly — they
// used to rely on bare silence, which is now the healthy case and stays silent.
let _pendingSeq = 0;

/** Register a fake in-flight gateway request, shaped like aiGatewayClient's. */
function markPendingWork(adapter = 'test-adapter') {
  _pendingSeq += 1;
  const id = `req-test-${_pendingSeq}`;
  activeGatewayRequests.set(id, {
    abortController: { abort() {}, signal: { aborted: false } },
    createdAt: Date.now(),
    adapter,
  });
  return id;
}

function clearPendingWork() {
  activeGatewayRequests.clear();
}

// Sync-stall seams: sampleMs/stallMs shrunk so a real event-loop block is
// observed in milliseconds. idleLimitMs is pushed far out so the idle report
// never mixes into these assertions.
const STALL_FAST = {
  sampleMs: 40,
  stallMs: 50,
  idleLimitMs: 30 * 60_000,
  stallRepeat: 3,
  stallWindowMs: 60_000,
  stallAlertMs: 400,
};

/** Block the event loop for real — the sampler's late beat IS the stall. */
function blockLoop(ms) {
  const t = Date.now();
  // eslint-disable-next-line no-empty
  while (Date.now() - t < ms) {}
}

/** One stall + enough quiet for the sampler to observe it after the block. */
async function stallOnce(blockMs, quietMs = 120) {
  await sleep(quietMs);
  blockLoop(blockMs);
  await sleep(80);
}

/**
 * Intercept everything the watchdog would put on the terminal: its own stderr
 * write plus ResourceGuard's console.error line (which also reaches stderr).
 * The spy must be installed BEFORE installSessionWatchdog() — the watchdog
 * binds the write it sees at install time, so a later spy is never reached.
 * Bytes are swallowed instead of forwarded: the un-suppressed console.error is
 * itself an "activity" write, so forwarding it would re-arm the idle clock and
 * make the watchdog report in a loop while the assertions run.
 */
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
    has: (needle) => lines.some((l) => l.includes(needle)),
    stop() {
      process.stderr.write = stderrWrite;
      console.error = consoleError;
    },
  };
}

/** Poll a predicate on real timers until it holds or the window runs out. */
async function waitUntil(pred, timeoutMs = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await sleep(50);
  }
  return pred();
}

describe('Session Watchdog', () => {
  test('idle hang fires onHang after the idle window with diagnostics', async () => {
      resetForTest();
      const events = [];
      const inst = installSessionWatchdog({
        env: {},
        ...FAST,
        onHang: (e) => events.push(e),
      });
      expect(inst.reason).toBe('installed');
      await sleep(600);
      expect(events.length >= 1).toBeTruthy();
      expect(events[0].kind).toBe('idle');
      expect(events[0].idleSeconds >= 0).toBeTruthy();
      inst.stop();
  });

  test('activity postpones the idle report, then a fresh episode fires again', async () => {
      resetForTest();
      const events = [];
      const inst = installSessionWatchdog({
        env: {},
        ...FAST,
        onHang: (e) => events.push(e),
      });
      // Stay active for ~400ms via stdout writes (each write touches the guard).
      const start = Date.now();
      while (Date.now() - start < 400) {
        process.stdout.write('');
        await sleep(80);
      }
      expect(events.length).toBe(0);
      // Go quiet �?a new idle episode must arm and fire.
      await sleep(600);
      expect(events.length >= 1).toBeTruthy();
      inst.stop();
  });

  test('per-process install is idempotent (Symbol lock)', async () => {
      resetForTest();
      const a = installSessionWatchdog({ env: {}, ...FAST, onHang: () => {} });
      const b = installSessionWatchdog({ env: {}, ...FAST, onHang: () => {} });
      expect(b.reason).toBe('already-installed');
      a.stop();
  });

  test('gate off disables the watchdog entirely', async () => {
      resetForTest();
      const r = installSessionWatchdog({ env: { KHY_SESSION_WATCHDOG: '0' } });
      expect(r.reason).toBe('gate-off');
  });

  test('stop() releases the lock so a later install works again', async () => {
      resetForTest();
      const a = installSessionWatchdog({ env: {}, ...FAST, onHang: () => {} });
      a.stop();
      const b = installSessionWatchdog({ env: {}, ...FAST, onHang: () => {} });
      expect(b.reason).toBe('installed');
      b.stop();
  });

  test('stop() hands the stream writes back so a dead watchdog cannot re-arm', async () => {
      resetForTest();
      const stdoutWrite = process.stdout.write;
      const stderrWrite = process.stderr.write;
      const reports = [];
      const inst = installSessionWatchdog({
        env: {},
        ...FAST,
        idleLimitMs: 120,
        onHang: () => {},
        onReport: (line) => { reports.push(line); return true; },
      });
      expect(process.stdout.write).not.toBe(stdoutWrite);
      expect(process.stderr.write).not.toBe(stderrWrite);
      inst.stop();
      // Identity, not behaviour: a leftover closure on the stream would keep
      // touching (i.e. re-arming) on every later write, forever.
      expect(process.stdout.write).toBe(stdoutWrite);
      expect(process.stderr.write).toBe(stderrWrite);
      // And nothing fires after the streams are back.
      await waitUntil(() => reports.length >= 1, 400);
      expect(reports.length).toBe(0);
  });

  // onReport handoff (BUG-17): a raw stderr write while another renderer owns
  // the terminal is never erased by its frame ledger, so the host must be able
  // to take the line. Only an explicit `true` counts — losing the diagnosis is
  // worse than the stray row, so every other outcome falls back to stderr.

  test('onReport returning true takes the line and nothing reaches stderr', async () => {
      resetForTest();
      clearPendingWork();
      markPendingWork(); // precondition of the idle line (see the fixture)
      const cap = captureTerminal();
      const taken = [];
      let inst = null;
      try {
        inst = installSessionWatchdog({
          env: {},
          ...FAST,
          onHang: () => {},
          onReport: (line) => { taken.push(line); return true; },
        });
        expect(await waitUntil(() => taken.length >= 1)).toBeTruthy();
        expect(taken[0].startsWith('[Watchdog]')).toBeTruthy();
        expect(cap.has('[Watchdog]')).toBe(false);
      } finally {
        if (inst) inst.stop();
        clearPendingWork();
        cap.stop();
      }
  });

  test('onReport refusing (false) keeps the historical stderr write', async () => {
      resetForTest();
      clearPendingWork();
      markPendingWork(); // precondition of the idle line (see the fixture)
      const cap = captureTerminal();
      let calls = 0;
      let inst = null;
      try {
        inst = installSessionWatchdog({
          env: {},
          ...FAST,
          onHang: () => {},
          onReport: () => { calls += 1; return false; },
        });
        expect(await waitUntil(() => cap.has('[Watchdog]'))).toBeTruthy();
        expect(calls >= 1).toBeTruthy();
      } finally {
        if (inst) inst.stop();
        clearPendingWork();
        cap.stop();
      }
  });

  test('a throwing onReport falls back to stderr and never breaks the watchdog', async () => {
      resetForTest();
      clearPendingWork();
      markPendingWork(); // precondition of the idle line (see the fixture)
      const cap = captureTerminal();
      let hung = null;
      let inst = null;
      try {
        inst = installSessionWatchdog({
          env: {},
          ...FAST,
          onHang: (e) => { hung = e; },
          onReport: () => { throw new Error('host sink exploded'); },
        });
        expect(await waitUntil(() => cap.has('[Watchdog]'))).toBeTruthy();
        // The hang notification must survive a broken host sink.
        expect(hung && hung.kind).toBe('idle');
      } finally {
        if (inst) inst.stop();
        clearPendingWork();
        cap.stop();
      }
  });

  test('no onReport at all leaves the historical stderr write untouched', async () => {
      resetForTest();
      clearPendingWork();
      markPendingWork(); // precondition of the idle line (see the fixture)
      const cap = captureTerminal();
      let inst = null;
      try {
        inst = installSessionWatchdog({ env: {}, ...FAST, onHang: () => {} });
        expect(await waitUntil(() => cap.has('[Watchdog]'))).toBeTruthy();
        const line = cap.lines.find((l) => l.includes('[Watchdog]'));
        expect(line.endsWith('\n')).toBeTruthy();
      } finally {
        if (inst) inst.stop();
        clearPendingWork();
        cap.stop();
      }
  });

  test('a host that unmounts mid-session falls back to stderr for later reports', async () => {
      resetForTest();
      clearPendingWork();
      markPendingWork(); // precondition of the idle line (see the fixture)
      const cap = captureTerminal();
      let wired = true;
      let taken = 0;
      let inst = null;
      try {
        inst = installSessionWatchdog({
          env: {},
          ...FAST,
          onHang: () => {},
          onReport: () => { taken += 1; return wired; },
        });
        expect(await waitUntil(() => taken >= 1)).toBeTruthy();
        expect(cap.has('[Watchdog]')).toBe(false);
        // Unmount the host (the App effect returns false once inactive), then
        // let a DIFFERENT stuck item report. Re-arming alone must not be enough:
        // one stuck item is news once (the same-episode rule below), so a later
        // report is a later problem.
        wired = false;
        clearPendingWork();
        markPendingWork('second-adapter');
        inst.touch();
        expect(await waitUntil(() => cap.has('[Watchdog]'))).toBeTruthy();
      } finally {
        if (inst) inst.stop();
        clearPendingWork();
        cap.stop();
      }
  });

  // Sync-stall notice policy (2026-09-23). A stall that already recovered is
  // imperceptible by definition, so the DEFAULT must not narrate it; only a
  // pattern (or a genuinely long freeze) is a signal. These tests assert the
  // default itself, not just the behaviour under an explicit opt-in — the
  // historical failure mode in this repo is "all the wiring is right, nobody
  // asserted what happens when nobody sets anything".
  describe('Sync-stall notice policy (quiet by default)', () => {
    /** Install with the stall seams and capture both channels. */
    function installStall(extra = {}) {
      const lines = [];
      const hangs = [];
      const inst = installSessionWatchdog({
        env: {},
        ...STALL_FAST,
        onReport: (line) => {
          lines.push(String(line));
          return true;
        },
        onHang: (e) => hangs.push(e),
        ...extra,
      });
      return { inst, lines, hangs };
    }

    test('an isolated self-healed stall prints nothing but is still observed', async () => {
      resetForTest();
      const { inst, lines, hangs } = installStall();
      try {
        await stallOnce(200);
        expect(lines).toEqual([]);
        const stalls = hangs.filter((h) => h.kind === 'stall');
        expect(stalls.length >= 1).toBeTruthy();
        expect(stalls[0].suppressed).toBe(true);
        const st = inst.stats();
        expect(st.mode).toBe('quiet');
        expect(st.stalls.count >= 1).toBeTruthy();
        expect(st.stalls.reported).toBe(0);
        expect(st.stalls.suppressed >= 1).toBeTruthy();
      } finally {
        inst.stop();
        resetForTest();
      }
    });

    test('a repeated burst collapses into exactly one merged line', async () => {
      resetForTest();
      const { inst, lines } = installStall();
      try {
        await stallOnce(200);
        await stallOnce(200);
        await stallOnce(200);
        const observed = inst.stats().stalls.count;
        expect(observed >= 3).toBeTruthy();
        expect(lines.length).toBe(1);
        expect(lines[0]).toContain(`阻塞 ${observed} 次`);
        expect(lines[0]).toContain('最长');
        expect(lines[0]).toContain('均已自动恢复调度');
        expect(inst.stats().stalls.reported).toBe(1);
      } finally {
        inst.stop();
        resetForTest();
      }
    });

    test('a single over-long stall speaks at once — that is not "imperceptible"', async () => {
      resetForTest();
      const { inst, lines } = installStall();
      try {
        await stallOnce(600); // >= stallAlertMs (400)
        expect(lines.length >= 1).toBeTruthy();
        expect(lines.every((l) => l.includes('事件循环曾阻塞'))).toBeTruthy();
        expect(lines[0]).toContain('现已恢复调度');
        expect(inst.stats().stalls.reported >= 1).toBeTruthy();
      } finally {
        inst.stop();
        resetForTest();
      }
    });

    test('KHY_WATCHDOG_STALL_NOTICE=all restores one line per stall', async () => {
      resetForTest();
      const { inst, lines } = installStall({ env: { KHY_WATCHDOG_STALL_NOTICE: 'all' } });
      try {
        await stallOnce(200);
        await stallOnce(200);
        await stallOnce(200);
        const observed = inst.stats().stalls.count;
        expect(observed >= 3).toBeTruthy();
        expect(inst.stats().mode).toBe('all');
        expect(lines.length).toBe(observed); // 每次阻塞一行 = 旧行为
        expect(lines.every((l) => l.includes('事件循环曾阻塞'))).toBeTruthy();
      } finally {
        inst.stop();
        resetForTest();
      }
    });

    test('KHY_WATCHDOG_STALL_NOTICE=off never prints but still counts', async () => {
      resetForTest();
      const { inst, lines } = installStall({ env: { KHY_WATCHDOG_STALL_NOTICE: 'off' } });
      try {
        await stallOnce(200);
        await stallOnce(200);
        await stallOnce(200);
        expect(lines).toEqual([]);
        expect(inst.stats().stalls.count >= 3).toBeTruthy();
        expect(inst.stats().stalls.reported).toBe(0);
      } finally {
        inst.stop();
        resetForTest();
      }
    });

    test('an unrecognised mode value falls back to quiet, never to the loud path', async () => {
      resetForTest();
      const { inst, lines } = installStall({ env: { KHY_WATCHDOG_STALL_NOTICE: 'noisy' } });
      try {
        await stallOnce(200);
        expect(lines).toEqual([]);
        expect(inst.stats().mode).toBe('quiet');
      } finally {
        inst.stop();
        resetForTest();
      }
    });
  });

  // Async-hang judgment (2026-09-26). The user-visible complaint was the
  // watchdog narrating "会话已 900.5s 无任何输出（疑似异步卡死）… Ctrl+C 后重进"
  // every idle window at a session that had simply finished its turn and was
  // waiting for input. The predicate is now "work is pending AND silence", the
  // quoted number is the true idle span, and one stuck item speaks once.
  describe('Async-hang judgment (work-pending gated)', () => {
    /** Install with the idle seams, capturing lines + hang payloads. */
    function installIdle(extra = {}) {
      const lines = [];
      const hangs = [];
      const inst = installSessionWatchdog({
        env: {},
        ...FAST,
        interruptHint: 'esc 中断',
        onReport: (line) => {
          lines.push(String(line));
          return true;
        },
        onHang: (e) => hangs.push(e),
        ...extra,
      });
      return { inst, lines, hangs };
    }

    const idleEvents = (hangs) => hangs.filter((h) => h.kind === 'idle');

    test('a session at the prompt is never narrated, but is still observed', async () => {
      resetForTest();
      clearPendingWork();
      const { inst, lines, hangs } = installIdle();
      try {
        await sleep(600); // several idle windows of a turn-free session
        expect(lines.length).toBe(0);
        const idle = idleEvents(hangs);
        expect(idle.length >= 1).toBeTruthy();
        expect(idle[0].reason).toBe('waiting-input');
        expect(idle[0].reported).toBe(false);
        const st = inst.stats();
        expect(st.idleWaitingInput >= 1).toBeTruthy();
        expect(st.idleReported).toBe(0);
        expect(st.work.busy).toBe(false);
      } finally {
        inst.stop();
        clearPendingWork();
        resetForTest();
      }
    });

    test('pending work that goes silent speaks once, naming work and interrupt key', async () => {
      resetForTest();
      clearPendingWork();
      const id = markPendingWork();
      const { inst, lines, hangs } = installIdle();
      try {
        expect(await waitUntil(() => lines.length >= 1)).toBeTruthy();
        expect(lines.length).toBe(1);
        // 目标 (what is pending) + the host's own interrupt verb (what to do).
        expect(lines[0].includes(id)).toBeTruthy();
        expect(lines[0].includes('esc 中断')).toBeTruthy();
        // The remedy for a live session is never "restart it".
        expect(lines[0].includes('重进')).toBe(false);
        expect(idleEvents(hangs)[0].reason).toBe('work-pending');
        expect(inst.stats().idleReported).toBe(1);
      } finally {
        inst.stop();
        clearPendingWork();
        resetForTest();
      }
    });

    test('a repaint inside the echo window cannot re-arm the guard', async () => {
      resetForTest();
      clearPendingWork();
      markPendingWork();
      const { inst, lines, hangs } = installIdle();
      try {
        expect(await waitUntil(() => lines.length >= 1)).toBeTruthy();
        // The host repaints our line (ink writes to stdout on a later tick) —
        // the exact feedback path that used to re-arm the guard and turn one
        // report into one report per idle window, with the user doing nothing.
        for (let i = 0; i < 4; i += 1) {
          process.stdout.write('');
          await sleep(FAST.idleLimitMs + 80);
        }
        expect(lines.length).toBe(1);
        // Not merely "reported once": the echo did not even count as activity,
        // so no further idle episode was ever armed.
        expect(idleEvents(hangs).length).toBe(1);
        expect(inst.stats().idleSuppressed).toBe(0);
      } finally {
        inst.stop();
        clearPendingWork();
        resetForTest();
      }
    });

    test('the same stuck work is not re-reported even when a real write re-arms the guard', async () => {
      resetForTest();
      clearPendingWork();
      markPendingWork();
      // Shrink the echo window so the writes below are unambiguous REAL
      // activity: this test isolates the same-episode rule from the echo rule.
      const { inst, lines, hangs } = installIdle({ echoWindowMs: 20 });
      try {
        expect(await waitUntil(() => lines.length >= 1)).toBeTruthy();
        for (let i = 0; i < 2; i += 1) {
          process.stdout.write('');
          await sleep(FAST.idleLimitMs + 500); // re-armed guard fires again
        }
        expect(lines.length).toBe(1);
        const reasons = idleEvents(hangs).map((h) => h.reason);
        expect(reasons.every((r) => r === 'work-pending' || r === 'same-episode')).toBeTruthy();
        expect(reasons.includes('same-episode')).toBeTruthy();
        expect(inst.stats().idleSuppressed >= 1).toBeTruthy();
      } finally {
        inst.stop();
        clearPendingWork();
        resetForTest();
      }
    });

    test('the quoted silence is the true idle span, not time since the guard armed', async () => {
      resetForTest();
      clearPendingWork();
      markPendingWork();
      const { inst, hangs } = installIdle();
      try {
        // Stay active for much longer than the idle window: "since armed" and
        // "since the last output" now diverge by construction. The old code
        // quoted the former, so a 15-minute silence could read as 34 minutes.
        const start = Date.now();
        let lastOutputAt = start;
        while (Date.now() - start < 500) {
          process.stdout.write('');
          lastOutputAt = Date.now();
          await sleep(40);
        }
        expect(await waitUntil(() => idleEvents(hangs).length >= 1)).toBeTruthy();
        const ev = idleEvents(hangs)[0];
        const truth = (Date.now() - lastOutputAt) / 1000;
        const sinceArmed = (Date.now() - start) / 1000;
        expect(ev.silenceMs / 1000 <= truth * 1.5 + 0.1).toBeTruthy();
        expect(ev.silenceMs / 1000 < sinceArmed).toBeTruthy();
      } finally {
        inst.stop();
        clearPendingWork();
        resetForTest();
      }
    });

    test('a host isBusy opinion alone is enough to speak', async () => {
      resetForTest();
      clearPendingWork(); // no gateway request, no operation guard
      let hostBusy = true;
      const { inst, lines } = installIdle({ isBusy: () => hostBusy });
      try {
        expect(await waitUntil(() => lines.length >= 1)).toBeTruthy();
        // Pending but unattributable: the only case that keeps the old escape hatch.
        expect(lines[0].includes('未捕获到具体请求/工具')).toBeTruthy();
        // Once the host says the turn is over, the same silence is healthy again.
        hostBusy = false;
        inst.touch();
        const seen = lines.length;
        await sleep(FAST.idleLimitMs * 3);
        expect(lines.length).toBe(seen);
        expect(inst.stats().work.hostBusy).toBe(false);
      } finally {
        inst.stop();
        clearPendingWork();
        resetForTest();
      }
    });

    test('stats() exposes the probe so silence is never silence about what is pending', async () => {
      resetForTest();
      clearPendingWork();
      const id = markPendingWork('probe-adapter');
      const { inst } = installIdle();
      try {
        const st = inst.stats();
        expect(st.work.busy).toBe(true);
        expect(st.work.signature).toBe(id);
        expect(st.work.evidence[0].kind).toBe('request');
        expect(st.work.evidence[0].adapter).toBe('probe-adapter');
      } finally {
        inst.stop();
        clearPendingWork();
        resetForTest();
      }
    });
  });
});

