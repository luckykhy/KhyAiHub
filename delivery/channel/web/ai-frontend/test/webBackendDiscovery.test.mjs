/**
 * Acceptance tests for the dev-proxy target discovery (web backend + daemon).
 *
 * Why this file exists: the 2026-09-26 incident — `backend_runtime.json`
 * recorded `pid 46096 / apiPort 3000`, the backend was dead, and the pid had
 * been recycled by an unrelated process (ZCode.exe), so the `isPidAlive`
 * stale-file guard judged the entry "alive" and the Vite proxy locked onto a
 * port nobody listens on → every non-daemon `/api/*` call 500 and `/ws`
 * handshakes failed. `resolveWebBackendTarget()` never reachability-probed the
 * port a runtime file hands it.
 *
 * Contract asserted here: **a target taken from a runtime file must be
 * reachability-probed before it is trusted; an unreachable one must fall
 * through the documented precedence chain.**
 *
 * Determinism notes:
 *   - "dead port" = bind an ephemeral server, capture its port, close it.
 *   - Most cases inject `opts.probe` (a pure stub) so they are independent of
 *     whatever happens to be running on this machine; two cases use real
 *     sockets to pin the real probe helper.
 * Run: `npm run test:node` (workdir apps/ai-frontend).
 */
import test from 'node:test';
import assert from 'node:assert';
import net from 'node:net';
import path from 'node:path';
import {
  resolveWebBackendTarget,
  resolveBackendTarget,
  isTargetReachable,
  DEFAULT_BACKEND_TARGET,
} from '../backendDiscovery.mjs';

// In-memory fs stub: absolute file path -> contents (string).
function makeFs(files = {}) {
  return {
    readFileSync(file) {
      if (Object.prototype.hasOwnProperty.call(files, file)) return files[file];
      const err = new Error(`ENOENT: ${file}`);
      err.code = 'ENOENT';
      throw err;
    },
  };
}

const HOME = '/home/tester';

function webRuntimeFile(home = HOME) {
  return path.join(home, '.khy', 'backend_runtime.json');
}
function daemonRuntimeFile(home = HOME) {
  return path.join(home, '.khy', 'ai_manage_runtime.json');
}

// Bind an ephemeral port, capture it, close it: the port is now (reliably)
// not listening.
async function closedPort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

// Keep a server listening for the duration of fn(port).
async function withLiveServer(fn) {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  try {
    return await fn(port);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
}

const urlOf = (port) => `http://127.0.0.1:${port}`;

// A probe stub: reachable unless the target is one of `unreachable`.
const probeExcept = (...unreachable) => (target) => !unreachable.includes(target);

// ---------------------------------------------------------------------------
// T1 — the incident: recycled (alive) pid + dead port must NOT be trusted.
// ---------------------------------------------------------------------------
test('T1 web: runtime file port is probed — unreachable target is skipped, falls back to live daemon', async () => {
  const dead = await closedPort();
  const daemonPort = 7777;
  const fs = makeFs({
    [webRuntimeFile()]: JSON.stringify({ apiPort: dead, pid: process.pid, startedAt: Date.now() }),
    [daemonRuntimeFile()]: JSON.stringify({ apiPort: daemonPort, pid: process.pid }),
  });
  const target = await resolveWebBackendTarget(
    {},
    // Only the daemon answers — the dead runtime port and the default-web
    // candidate must both be skipped, so the chain can only end at the daemon.
    { fs, homedir: HOME, probe: (t) => t === urlOf(daemonPort) }
  );
  assert.notStrictEqual(target, urlOf(dead), 'unreachable runtime port must not be returned');
  assert.strictEqual(target, urlOf(daemonPort), 'must fall through to the next candidate (daemon)');
});

// ---------------------------------------------------------------------------
// T2 — happy path stays working: a genuinely listening runtime port wins.
// ---------------------------------------------------------------------------
test('T2 web: runtime file port that is actually listening is returned', async () => {
  await withLiveServer(async (live) => {
    const fs = makeFs({
      [webRuntimeFile()]: JSON.stringify({ apiPort: live, pid: process.pid, startedAt: Date.now() }),
    });
    const target = await resolveWebBackendTarget({}, { fs, homedir: HOME });
    assert.strictEqual(target, urlOf(live));
  });
});

// ---------------------------------------------------------------------------
// T3 — nothing reachable anywhere → never the dead runtime port.
// ---------------------------------------------------------------------------
test('T3 web: dead runtime port with no other candidate never wins', async () => {
  const dead = await closedPort();
  const fs = makeFs({
    [webRuntimeFile()]: JSON.stringify({ apiPort: dead, pid: process.pid, startedAt: Date.now() }),
  });
  const target = await resolveWebBackendTarget(
    {},
    { fs, homedir: HOME, probe: () => false }
  );
  assert.notStrictEqual(target, urlOf(dead));
  assert.strictEqual(target, DEFAULT_BACKEND_TARGET, 'full fallback chain ends at the documented default');
});

// ---------------------------------------------------------------------------
// T4 — the pre-existing dead-pid guard keeps working (regression lock).
// ---------------------------------------------------------------------------
test('T4 web: dead pid in runtime file is skipped even before probing', async () => {
  const stalePort = 59991;
  const fs = makeFs({
    [webRuntimeFile()]: JSON.stringify({ apiPort: stalePort, pid: 999999999, startedAt: 0 }),
  });
  const target = await resolveWebBackendTarget({}, { fs, homedir: HOME, probe: () => true });
  assert.notStrictEqual(target, urlOf(stalePort), 'dead-pid entry must be skipped');
});

// ---------------------------------------------------------------------------
// T5 — the same blind spot on the daemon path (resolveBackendTarget).
// ---------------------------------------------------------------------------
test('T5 daemon: first data home with an unreachable port falls through to the next candidate', async () => {
  const dead = await closedPort();
  const goodPort = 8888;
  const customHome = '/data/khy';
  const fs = makeFs({
    [path.join(customHome, 'ai_manage_runtime.json')]: JSON.stringify({
      apiPort: dead,
      pid: process.pid,
    }),
    [daemonRuntimeFile()]: JSON.stringify({ apiPort: goodPort, pid: process.pid }),
  });
  const target = await resolveBackendTarget(
    { KHY_DATA_HOME: customHome },
    { fs, homedir: HOME, probe: probeExcept(urlOf(dead)) }
  );
  assert.notStrictEqual(target, urlOf(dead));
  assert.strictEqual(target, urlOf(goodPort));
});

// ---------------------------------------------------------------------------
// T6 — probe semantics: reachable wins by precedence (documents the stub contract).
// ---------------------------------------------------------------------------
test('T6 daemon: reachable port in the first data home wins (precedence unchanged)', async () => {
  const firstPort = 7001;
  const customHome = '/data/khy';
  const fs = makeFs({
    [path.join(customHome, 'ai_manage_runtime.json')]: JSON.stringify({
      apiPort: firstPort,
      pid: process.pid,
    }),
    [daemonRuntimeFile()]: JSON.stringify({ apiPort: 9090, pid: process.pid }),
  });
  const target = await resolveBackendTarget(
    { KHY_DATA_HOME: customHome },
    { fs, homedir: HOME, probe: () => true }
  );
  assert.strictEqual(target, urlOf(firstPort));
});

// ---------------------------------------------------------------------------
// T7 — the real probe helper (what the fix relies on) behaves as advertised.
// ---------------------------------------------------------------------------
test('T7 probe: isTargetReachable is true for a live port and false for a closed one', async () => {
  const dead = await closedPort();
  assert.strictEqual(await isTargetReachable(urlOf(dead)), false, 'closed port must probe false');
  await withLiveServer(async (live) => {
    assert.strictEqual(await isTargetReachable(urlOf(live)), true, 'live port must probe true');
  });
});
