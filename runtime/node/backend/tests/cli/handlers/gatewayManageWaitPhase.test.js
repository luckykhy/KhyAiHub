'use strict';
/**
 * [DESIGN-ARCH-169] P1b — phase-aware wait in gatewayManageDaemon.js.
 *
 * Proves (提案 §7 断言 4-6):
 *  4. A runtime file whose daemon pid is dead fails IMMEDIATELY (reason
 *     'daemon-pid-dead') instead of burning the rest of the 180s budget; a
 *     missing runtime file fails immediately too ('runtime-file-missing').
 *  5. While phase='starting', the wait keeps polling and emits a progress line
 *     naming the current stage, and resolves only once /status reports ready.
 *  6. The precheck branch selector returns 'adopt-starting' for a live daemon
 *     in phase='starting' — the branch that must neither _reapManagedFrontend
 *     nor _clearAiManageRuntime (the 半启动误杀 guard).
 *
 * The /status endpoint is a real local HTTP server; the runtime file lives in a
 * hermetic KHY_DATA_HOME temp dir set before the handler module loads.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cli-wait-phase-'));
// Must be set before the handler module (and the data-home module it requires) loads.
process.env.KHY_DATA_HOME = tempHome;

const handler = require('../../../src/cli/handlers/gatewayManageDaemon');

const RUNTIME_FILE = path.join(tempHome, 'ai_manage_runtime.json');

function writeRuntime(record) {
  fs.mkdirSync(tempHome, { recursive: true });
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify(record, null, 2), 'utf-8');
}

// A pid that is guaranteed dead right now: spawn a short-lived child, use its
// pid after the exit event reaped it.
function getDeadPid() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const pid = child.pid;
    child.on('exit', () => resolve(pid));
  });
}

function startStatusServer(payloadFn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const payload = payloadFn();
      res.setHeader('Connection', 'close');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(resolve);
  });
}

test.after(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
});

test('断言 4: dead daemon pid fails immediately (no budget burn)', async () => {
  const deadPid = await getDeadPid();
  let dead = false;
  try {
    process.kill(deadPid, 0);
  } catch {
    dead = true;
  }
  assert.ok(dead, 'fixture pid must be dead');

  writeRuntime({ pid: deadPid, controlPort: 1, controlToken: 'x' });
  const began = Date.now();
  const result = await handler._waitAiManageRuntimeReady(60_000);
  const elapsed = Date.now() - began;

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'daemon-pid-dead');
  assert.ok(
    elapsed < 5000,
    `wait returned after ${elapsed}ms — must fail fast, not burn the budget`
  );
});

test('断言 4b: missing runtime file fails immediately', async () => {
  fs.rmSync(RUNTIME_FILE, { force: true });
  const result = await handler._waitAiManageRuntimeReady(60_000);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'runtime-file-missing');
});

test('断言 4c: live spawnPid + absent file keeps waiting (booting, not a ghost)', async () => {
  // A freshly spawned detached child is alive but has not yet reached
  // beginStartupPhase() (node still requiring its tree) — the runtime file is
  // legitimately absent. With no spawnPid this fails fast as a ghost (4b); WITH a
  // live spawnPid it must NOT — that was the `khy chat` instant-failure bug.
  fs.rmSync(RUNTIME_FILE, { force: true });
  const began = Date.now();
  const result = await handler._waitAiManageRuntimeReady(1500, process.pid);
  const elapsed = Date.now() - began;
  assert.equal(result.ok, false);
  assert.equal(
    result.reason,
    'timeout',
    'a live-but-unregistered daemon must be waited on, not misjudged as startup failure'
  );
  assert.ok(elapsed >= 1000, `must keep polling to the budget, returned after ${elapsed}ms`);
});

test('断言 4d: dead spawnPid + absent file fails immediately (daemon-pid-dead)', async () => {
  fs.rmSync(RUNTIME_FILE, { force: true });
  const deadPid = await getDeadPid();
  const began = Date.now();
  const result = await handler._waitAiManageRuntimeReady(60_000, deadPid);
  const elapsed = Date.now() - began;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'daemon-pid-dead');
  assert.ok(elapsed < 5000, `must fail fast on a dead child, returned after ${elapsed}ms`);
});

test('断言 5: phase=starting keeps polling, prints stage progress, resolves on ready', async () => {
  const phaseSince = Date.now() - 12_000;
  const state = { ready: false };
  const { server, port } = await startStatusServer(() =>
    state.ready
      ? { ok: true, runtime: { pid: process.pid, phase: 'ready', phaseDetail: 'ready', phaseSince } }
      : { ok: true, runtime: { pid: process.pid, phase: 'starting', phaseDetail: 'frontend', phaseSince } }
  );
  writeRuntime({
    pid: process.pid,
    controlPort: port,
    controlToken: 't',
    phase: 'starting',
    phaseDetail: 'frontend',
    phaseSince,
  });

  const lines = [];
  const origLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const readyAt = Date.now() + 1200;
    setTimeout(() => {
      state.ready = true;
    }, 1200);
    const result = await handler._waitAiManageRuntimeReady(30_000);
    const waitedUntilReady = Date.now() >= readyAt - 250;

    assert.equal(result.ok, true);
    assert.ok(waitedUntilReady, 'must keep polling until ready, not resolve instantly');
    const progress = lines.join('\n');
    assert.match(progress, /管理会话启动中/, 'a progress line must be printed while starting');
    assert.match(progress, /frontend/, 'the progress line must name the current stage');
  } finally {
    console.log = origLog;
    await closeServer(server);
  }
});

test('断言 6: precheck selector adopts a live starting daemon (no reap/clear path)', () => {
  const runtime = { pid: process.pid, phase: 'starting', phaseDetail: 'frontend' };
  assert.equal(
    handler._precheckRuntimeAction(runtime, null),
    'adopt-starting',
    'file phase alone must select adopt even when /status blipped'
  );
  assert.equal(
    handler._precheckRuntimeAction(runtime, {
      ok: true,
      runtime: { phase: 'starting', phaseDetail: 'api' },
    }),
    'adopt-starting',
    'status phase wins over the file phase'
  );
  // ready → reuse as today
  assert.equal(
    handler._precheckRuntimeAction({ pid: 1 }, { ok: true, runtime: { phase: 'ready' } }),
    'reuse-ready'
  );
  // legacy daemon without a phase field + status ok → reuse (两版共存, §4 P1b)
  assert.equal(handler._precheckRuntimeAction({ pid: 1 }, { ok: true, runtime: {} }), 'reuse-ready');
  // unreachable control plane without phase info → today's recover-clear
  assert.equal(handler._precheckRuntimeAction({ pid: 1 }, null), 'recover-clear');
});
