'use strict';
/**
 * ai-manage-daemon resolveFrontend — reuse before starting a second stack.
 *
 * The user-visible requirement: entering the manage entry point must REUSE an already
 * running KHY frontend instead of binding another port. 8090 is only a base port, so
 * the daemon has to recognize the running instance (identity endpoint / published
 * runtime file) and skip the dev-server spawn entirely.
 *
 * The strongest assertion here is the absence of a spawn: `frontendDir` points at a
 * throwaway package whose `dev` script writes a marker file. If the daemon started a
 * second frontend, the marker would appear.
 *
 * Hermetic: KHY_DATA_HOME is a temp dir, every peer is local, nothing spawns npm on a
 * successful reuse.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-daemon-frontend-reuse-'));
// Must be set before the locator (and the data-home module it requires) is loaded.
process.env.KHY_DATA_HOME = tempHome;

const locator = require('../src/services/aiFrontendLocator');
const daemon = require('../scripts/ai-manage-daemon');

const HOST = '127.0.0.1';
const RUNTIME_FILE = path.join(tempHome, locator.FRONTEND_RUNTIME_FILENAME);

// Throwaway "frontend" whose dev script proves whether a spawn happened.
const fakeFrontendDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-fake-frontend-'));
const MARKER = path.join(fakeFrontendDir, 'spawned.marker');
fs.writeFileSync(
  path.join(fakeFrontendDir, 'package.json'),
  JSON.stringify({ name: 'khy-fake-frontend', version: '0.0.0', scripts: { dev: 'node dev-marker.js' } }),
  'utf-8'
);
fs.writeFileSync(
  path.join(fakeFrontendDir, 'dev-marker.js'),
  `require('node:fs').writeFileSync(${JSON.stringify(MARKER)}, String(process.pid))\n`,
  'utf-8'
);

function startHttpServer(handler, port = 0) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(port, HOST, () => resolve({ server, port: server.address().port }));
  });
}

function closeHttpServer(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    server.close(resolve);
  });
}

function frontendHandler({ app = locator.FRONTEND_APP_ID, title = 'KHY AI 管理平台' } = {}) {
  return (req, res) => {
    res.setHeader('Connection', 'close');
    if (String(req.url || '').startsWith(locator.FRONTEND_IDENTITY_PATH)) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ app, host: HOST, port: 0, pid: process.pid }));
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><title>${title}</title></head></html>`);
  };
}

function writeRuntime(record) {
  fs.mkdirSync(tempHome, { recursive: true });
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify(record, null, 2), 'utf-8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Assert that no dev server was spawned for this call, and clean up if one was. */
async function assertNoSpawn(result, label) {
  if (result.child) {
    try {
      result.child.kill();
    } catch {
      /* ignore */
    }
    assert.fail(`${label}: the daemon spawned a second frontend (pid ${result.child.pid})`);
  }
  await sleep(400);
  assert.equal(
    fs.existsSync(MARKER),
    false,
    `${label}: a dev server was really started — ${MARKER} exists`
  );
}

test.beforeEach(() => {
  fs.rmSync(RUNTIME_FILE, { force: true });
  fs.rmSync(MARKER, { force: true });
});

test.after(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
  fs.rmSync(fakeFrontendDir, { recursive: true, force: true });
});

test('a running KHY frontend on the requested port is reused, not restarted', async () => {
  const frontend = await startHttpServer(frontendHandler());
  try {
    const result = await daemon.resolveFrontend({
      host: HOST,
      requestedPort: frontend.port,
      autoFrontend: true,
      noFrontend: false,
      frontendDir: fakeFrontendDir,
      apiPort: 9090,
    });
    assert.equal(result.available, true);
    assert.equal(result.managed, false, 'a reused frontend must not be owned by this process');
    assert.equal(result.port, frontend.port);
    assert.equal(result.reason, 'reused');
    await assertNoSpawn(result, 'same-port reuse');
  } finally {
    await closeHttpServer(frontend.server);
  }
});

test('a KHY frontend that drifted off the base port is still reused', async () => {
  // Deterministic layout: a stranger holds the base port, our frontend sits above it —
  // this is exactly the "8090 was taken" case.
  const base = await locator.findFreePort(HOST, 45100);
  assert.ok(base, 'expected a free base port');
  const drifted = await locator.findFreePort(HOST, base + 1);
  assert.ok(drifted && drifted > base, `expected a free port above ${base}`);
  const stranger = await startHttpServer(
    frontendHandler({ app: 'postgres-admin', title: 'PostgreSQL Admin' }),
    base
  );
  const frontend = await startHttpServer(frontendHandler(), drifted);
  try {
    const result = await daemon.resolveFrontend({
      host: HOST,
      requestedPort: base,
      autoFrontend: true,
      noFrontend: false,
      frontendDir: fakeFrontendDir,
      apiPort: 9090,
    });
    assert.equal(result.available, true);
    assert.equal(result.reason, 'reused');
    assert.equal(result.port, drifted, 'the reused port must be the real one, not the base');
    await assertNoSpawn(result, 'drifted-port reuse');
  } finally {
    await closeHttpServer(frontend.server);
    await closeHttpServer(stranger.server);
  }
});

test('the published runtime file is trusted over the requested port', async () => {
  const frontend = await startHttpServer(frontendHandler());
  const freeBase = await locator.findFreePort(HOST, 45300);
  try {
    writeRuntime({ app: locator.FRONTEND_APP_ID, host: HOST, port: frontend.port, pid: process.pid });
    const result = await daemon.resolveFrontend({
      host: HOST,
      requestedPort: freeBase,
      autoFrontend: true,
      noFrontend: false,
      frontendDir: fakeFrontendDir,
      apiPort: 9090,
    });
    assert.equal(result.available, true);
    assert.equal(result.reason, 'reused-runtime');
    assert.equal(result.port, frontend.port);
    assert.equal(result.host, HOST);
    await assertNoSpawn(result, 'runtime-file reuse');
  } finally {
    await closeHttpServer(frontend.server);
  }
});

test('--no-frontend stays authoritative even when a frontend is running', async () => {
  const frontend = await startHttpServer(frontendHandler());
  try {
    const result = await daemon.resolveFrontend({
      host: HOST,
      requestedPort: frontend.port,
      autoFrontend: true,
      noFrontend: true,
      frontendDir: fakeFrontendDir,
      apiPort: 9090,
    });
    assert.deepEqual(result, {
      available: false,
      managed: false,
      port: frontend.port,
      reason: 'disabled',
    });
  } finally {
    await closeHttpServer(frontend.server);
  }
});

test('a stranger on the base port is "external", never mistaken for our frontend', async () => {
  const stranger = await startHttpServer(frontendHandler({ app: 'postgres-admin', title: 'PostgreSQL Admin' }));
  try {
    const result = await daemon.resolveFrontend({
      host: HOST,
      requestedPort: stranger.port,
      autoFrontend: false,
      noFrontend: false,
      frontendDir: fakeFrontendDir,
      apiPort: 9090,
    });
    assert.equal(result.available, true);
    assert.equal(result.managed, false);
    assert.equal(result.reason, 'external');
    await assertNoSpawn(result, 'stranger port');
  } finally {
    await closeHttpServer(stranger.server);
  }
});

test('with nothing running the result is "unavailable" (the caller decides)', async () => {
  const free = await locator.findFreePort(HOST, 45500);
  assert.ok(free, 'expected a free base port');
  const result = await daemon.resolveFrontend({
    host: HOST,
    requestedPort: free,
    autoFrontend: false,
    noFrontend: false,
    frontendDir: fakeFrontendDir,
    apiPort: 9090,
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'unavailable');
  assert.equal(result.port, free);
  await assertNoSpawn(result, 'nothing running');
});