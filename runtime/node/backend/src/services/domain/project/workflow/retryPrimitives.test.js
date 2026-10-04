'use strict';
// Co-located unit test for ./retryPrimitives.js — batch B31 (D2 functional-unit conformance).
// buildRetryPrimitives wraps an INJECTED basePrimitives object so no real channel
// (chat / executeTool / http) is ever invoked. backoffMs is pinned to 0 in every
// retry test so the exponential-backoff `_sleep` is skipped (waitMs > 0 guard) —
// no timers above 0ms are created (RUNTIME-003). Requiring ./workflowExecutor only
// defines lazy closures; nothing here opens sockets or spawns processes.
// Pure node:test; async tests only await already-resolved promises.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-wf-'));
process.env.KHY_APP_HOME = TMP_HOME;
process.env.KHY_DATA_HOME = TMP_HOME;
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;

const rp = require('./retryPrimitives.js');

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

// A fully controlled base primitive bag. `calls` records executeTool invocations.
function makeBase(overrides = {}) {
  const state = { directCalls: 0, indirectCalls: 0, succeedAfter: Infinity };
  const base = {
    state,
    async chat() {
      return 'ok';
    },
    async executeTool(name) {
      state.directCalls += 1;
      if (state.directCalls >= state.succeedAfter) {
        return { ok: true };
      }
      return { success: false, error: 'boom-' + state.directCalls };
    },
    // runCode delegates to this.executeTool — the wrapper's executeTool is NOT the
    // one reached (see B31-W3), it hits the raw base.executeTool via `this`.
    async runCode(language, source) {
      state.indirectCalls += 1;
      return this.executeTool('Bash', { command: source });
    },
    ...overrides,
  };
  return base;
}

// ── surface ───────────────────────────────────────────────────────────────────

test('exported surface is exactly the documented 4 keys', () => {
  assert.deepEqual(Object.keys(rp).sort(), ['DEFAULT_RETRY_POLICY', 'buildProgressLogger', 'buildRetryPrimitives', 'createIdleWatchdog']);
  assert.deepEqual(rp.DEFAULT_RETRY_POLICY, { retries: 2, backoffMs: 1000 });
});

// ── success / passthrough ─────────────────────────────────────────────────────

test('buildRetryPrimitives: success result passes through untouched, zero retries', async () => {
  const base = makeBase();
  base.executeTool = async () => ({ value: 42 });
  const { primitives, getRetryTotal } = rp.buildRetryPrimitives({}, { basePrimitives: base, retryPolicy: { retries: 2, backoffMs: 0 } });
  const res = await primitives.executeTool('t', {});
  assert.deepEqual(res, { value: 42 });
  assert.equal(getRetryTotal(), 0);
});

test('buildRetryPrimitives: non-function base entries are copied by reference', () => {
  const base = makeBase();
  base.meta = { tag: 'x' }; // non-function
  const { primitives } = rp.buildRetryPrimitives({}, { basePrimitives: base });
  assert.equal(primitives.meta, base.meta);
});

// ── retry + exhaustion throw ──────────────────────────────────────────────────

test('buildRetryPrimitives: retries error-shaped results, then throws on exhaustion', async () => {
  const base = makeBase();
  base.state.succeedAfter = Infinity; // always error
  const seen = [];
  const { primitives, getRetryTotal } = rp.buildRetryPrimitives({}, {
    basePrimitives: base,
    retryPolicy: { retries: 2, backoffMs: 0 },
    onRetry: (info) => seen.push(info.attempt),
  });
  await assert.rejects(() => primitives.executeTool('t', {}), (err) => {
    assert.equal(err.failedTool, 't');
    assert.equal(err.retryCount, 2);
    assert.equal(err.lastResult.success, false);
    return true;
  });
  assert.equal(base.state.directCalls, 3); // 1 initial + 2 retries
  assert.equal(getRetryTotal(), 2);
  assert.deepEqual(seen, [1, 2]);
});

test('buildRetryPrimitives: throwing primitive is retried too', async () => {
  const base = makeBase();
  let n = 0;
  base.executeTool = async () => {
    n += 1;
    if (n < 3) throw new Error('transient-' + n);
    return { ok: true };
  };
  const { primitives } = rp.buildRetryPrimitives({}, { basePrimitives: base, retryPolicy: { retries: 2, backoffMs: 0 } });
  const res = await primitives.executeTool('t', {});
  assert.deepEqual(res, { ok: true });
  assert.equal(n, 3);
});

// ── B31-W4: retries:null coercion family ───────────────────────────────────────

test('B31-W4: retryPolicy.retries:null coerces to 0 (single attempt) instead of falling back to default 2', async () => {
  // retryPrimitives.js:104 `Number.isFinite(Number(policy.retries)) && Number(policy.retries) >= 0`.
  // Number(null) === 0 is finite and >= 0, so retries:null is honoured as an explicit
  // 0 rather than defaulting to 2 — an author who meant "use default" but wrote null
  // silently loses retries. Same family as healGuard maxDepth:null and
  // contractChecker expect:null.
  const base = makeBase();
  base.state.succeedAfter = Infinity;
  const { primitives } = rp.buildRetryPrimitives({}, { basePrimitives: base, retryPolicy: { retries: null, backoffMs: 0 } });
  await assert.rejects(() => primitives.executeTool('t', {}));
  assert.equal(base.state.directCalls, 1); // only the initial attempt, no retries
});

// ── B31-W3: retry wrapper bypassed via this.executeTool ─────────────────────────

test('B31-W3: runCode -> this.executeTool bypasses the retry wrapper (raw base, 1 attempt, no throw)', async () => {
  // buildRetryPrimitives wraps executeTool with retry, but every OTHER primitive is
  // `track(fn.bind(base))` (retryPrimitives.js:188). Binding to the RAW base means a
  // base method that internally calls `this.executeTool` reaches the UNWRAPPED tool
  // fn — so runCode('js'/Bash) never gets retry protection.
  const base = makeBase();
  base.state.succeedAfter = Infinity; // every executeTool call is an error
  const { primitives } = rp.buildRetryPrimitives({}, { basePrimitives: base, retryPolicy: { retries: 2, backoffMs: 0 } });
  // Via runCode: this.executeTool is the raw base, so it returns the error-shaped
  // result AS-IS — no retry loop, no throw. Exactly one underlying call happens.
  const res = await primitives.runCode('js', 'echo');
  assert.equal(base.state.indirectCalls, 1);
  assert.equal(base.state.directCalls, 1); // single raw executeTool call, NOT retried to 3
  assert.deepEqual(res, { success: false, error: 'boom-1' }); // returned, not thrown
  // Contrast: the SAME wrapper's direct executeTool DOES retry (3 attempts) + throws.
  await assert.rejects(() => primitives.executeTool('t', {}));
  assert.equal(base.state.directCalls, 4); // 1 (from runCode) + 3 (retried direct)
});

// ── B31-W2: fail-open default primitives ────────────────────────────────────────

test('B31-W2: omitting basePrimitives fail-opens to the REAL defaultPrimitives channel surface', () => {
  // retryPrimitives.js:101 `opts.basePrimitives || workflowExecutor.defaultPrimitives(ctx)`.
  // In a test harness the intended seam is basePrimitives; forgetting it silently wires
  // up live chat/executeTool/http/loadFlow closures (a hidden dependency + side-effect
  // surface) rather than failing closed. defaultPrimitives() only DEFINES these lazy
  // closures (no IO at build time), so we can assert the surface without invoking them.
  const { primitives } = rp.buildRetryPrimitives({}, {});
  assert.deepEqual(Object.keys(primitives).sort(), [
    'chat', 'executeSkill', 'executeTool', 'http', 'loadFlow', 'runCode', 'runSubAgent',
  ]);
  for (const k of Object.keys(primitives)) {
    assert.equal(typeof primitives[k], 'function', k);
  }
});

// ── createIdleWatchdog ─────────────────────────────────────────────────────────

test('createIdleWatchdog: explicit limit wins; fresh window is not idle', () => {
  const wd = rp.createIdleWatchdog(60000);
  const c = wd.check();
  assert.equal(c.limitMs, 60000);
  assert.equal(c.idle, false);
  assert.equal(typeof wd.idleMs(), 'number');
  assert.equal(wd.isIdle(), false);
});

test('createIdleWatchdog: invalid limit falls back to env default, then to 120000', () => {
  assert.equal(rp.createIdleWatchdog(0).check().limitMs, 120000);
  assert.equal(rp.createIdleWatchdog('abc').check().limitMs, 120000);
  // env override (read fresh at construction time, not require time)
  withEnv('KHY_FLOW_IDLE_LIMIT_MS', '3000', () => {
    assert.equal(rp.createIdleWatchdog(undefined).check().limitMs, 3000);
  });
  withEnv('KHY_FLOW_IDLE_LIMIT_MS', 'nope', () => {
    assert.equal(rp.createIdleWatchdog(undefined).check().limitMs, 120000);
  });
});

test('createIdleWatchdog: touch() resets the activity clock (idleMs shrinks toward 0)', () => {
  const wd = rp.createIdleWatchdog(50000);
  wd.touch();
  assert.ok(wd.idleMs() < 50000);
});

// ── buildProgressLogger ────────────────────────────────────────────────────────

test('buildProgressLogger: success line with n/m progress', () => {
  const lines = [];
  const log = rp.buildProgressLogger({ flowName: '发票整理', totalSteps: 10, print: (l) => lines.push(l) });
  log({ type: 'toolCall', name: 'DesktopControl', status: 'ok', summary: 'done' });
  log({ type: 'prompt', status: 'ok' });
  assert.equal(lines[0], '执行流程「发票整理」第 1/10 步:toolCall「DesktopControl」… 成功(done)');
  assert.match(lines[1], /第 2\/10 步:prompt「prompt」… 成功$/);
});

test('buildProgressLogger: totalSteps omitted renders a bare step counter', () => {
  const lines = [];
  const log = rp.buildProgressLogger({ flowName: 'F', print: (l) => lines.push(l) });
  log({ type: 'end', status: 'ok' });
  assert.match(lines[0], /第 1 步/);
});

test('buildProgressLogger: failed / skipped / awaiting_input variants', () => {
  const lines = [];
  const log = rp.buildProgressLogger({ flowName: 'F', print: (l) => lines.push(l), getRetryTotal: () => 4 });
  log({ type: 'toolCall', name: 't', status: 'failed', error: 'nope' });
  log({ type: 'ifElse', name: 'i', status: 'skipped', summary: 'not-taken' });
  log({ type: 'askUserQuestion', name: 'a', status: 'awaiting_input' });
  assert.match(lines[0], /失败\(nope;累计重试 4 次\)/);
  assert.match(lines[1], /跳过\(not-taken\)/);
  assert.match(lines[2], /等待用户输入/);
});

test('buildProgressLogger: default flowName and console.log fallback never throw', () => {
  const log = rp.buildProgressLogger({});
  assert.doesNotThrow(() => log(null));
  assert.doesNotThrow(() => log(undefined));
  assert.match(rp.buildProgressLogger({ flowName: null }).toString(), /function/);
});
