'use strict';
/**
 * aiFrontendLocator — reuse-first discovery of the running KHY AI frontend.
 *
 * Why these assertions matter: 8090 is only a *base* port. The entry point must be
 * able to tell "the KHY frontend is already running over there" from "some stranger
 * owns that port", because getting it wrong produces either a second stack on a new
 * port (the bug this guards) or a browser pointed at somebody else's page (the
 * "blank page" symptom).
 *
 * Hermetic: a throwaway data home is injected through KHY_DATA_HOME, every peer is a
 * local HTTP server on an ephemeral port, and no test touches the real install.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-frontend-locator-'));
// Must be set before the locator (and the data-home module it requires) is loaded.
process.env.KHY_DATA_HOME = tempHome;

const locator = require('../src/services/aiFrontendLocator');

const HOST = '127.0.0.1';
const RUNTIME_FILE = path.join(tempHome, locator.FRONTEND_RUNTIME_FILENAME);
// tests/ → backend → node → runtime → repo root: four levels up since the R4 move.
const REPO_ROOT = path.resolve(__dirname, '../../../..');
// A pid that is certainly not alive, for the stale-pointer case.
const DEAD_PID = 999999;

function startHttpServer(handler, port = 0) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(port, HOST, () => resolve({ server, port: server.address().port }));
  });
}

function closeHttpServer(server) {
  return new Promise((resolve) => {
    // Node's global agent keeps sockets alive, so a plain close() would wait for the
    // probe's idle socket and hang the test. Drop the connections explicitly.
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    server.close(resolve);
  });
}

/** A peer that answers like delivery/web/ai-frontend does (identity endpoint + KHY title). */
function frontendHandler({ app = locator.FRONTEND_APP_ID, title = 'KHY AI 管理平台', withIdentity = true } = {}) {
  return (req, res) => {
    res.setHeader('Connection', 'close');
    if (String(req.url || '').startsWith(locator.FRONTEND_IDENTITY_PATH)) {
      if (!withIdentity) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ app, host: HOST, port: 0, pid: process.pid }));
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><title>${title}</title></head><body>ok</body></html>`);
  };
}

/** A plain TCP listener: makes a port genuinely busy without speaking HTTP. */
function occupyPort() {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
    });
    server.listen(0, HOST, () => resolve({ server, sockets, port: server.address().port }));
  });
}

async function releaseOccupied({ server, sockets }) {
  // net.Server.close() waits for accepted sockets; destroy them so the port is freed.
  for (const sock of sockets || []) {
    sock.destroy();
  }
  await new Promise((resolve) => server.close(resolve));
}

function writeRuntime(record) {
  fs.mkdirSync(tempHome, { recursive: true });
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify(record, null, 2), 'utf-8');
}

function clearRuntime() {
  fs.rmSync(RUNTIME_FILE, { force: true });
}

async function withHttpServer(handler, fn) {
  const { server, port } = await startHttpServer(handler);
  try {
    return await fn(port);
  } finally {
    await closeHttpServer(server);
  }
}

test.beforeEach(() => clearRuntime());
test.after(() => fs.rmSync(tempHome, { recursive: true, force: true }));

test('identity endpoint: a KHY frontend is recognized', async () => {
  await withHttpServer(frontendHandler(), async (port) => {
    assert.equal(await locator.isKhyFrontend(HOST, port), true);
  });
});

test('identity endpoint: a stranger on the port is NOT recognized', async () => {
  await withHttpServer(frontendHandler({ app: 'some-other-app', title: 'Other Admin' }), async (port) => {
    assert.equal(await locator.isKhyFrontend(HOST, port), false);
  });
});

test('title fallback: an older dev server without the identity endpoint still counts', async () => {
  await withHttpServer(frontendHandler({ withIdentity: false }), async (port) => {
    assert.equal(await locator.isKhyFrontend(HOST, port), true);
  });
});

test('title fallback: an unrelated page is rejected', async () => {
  await withHttpServer(frontendHandler({ withIdentity: false, title: 'PostgreSQL Admin' }), async (port) => {
    assert.equal(await locator.isKhyFrontend(HOST, port), false);
  });
});

test('nothing listening on the port is reported as "not ours"', async () => {
  const blocker = await occupyPort();
  const { port } = blocker;
  await releaseOccupied(blocker);
  assert.equal(await locator.isKhyFrontend(HOST, port), false);
});

test('canBindPort separates a busy port from a free one', async () => {
  const blocker = await occupyPort();
  try {
    assert.equal(await locator.canBindPort(HOST, blocker.port), false);
    const free = await locator.findFreePort(HOST, blocker.port + 1);
    assert.ok(free > blocker.port, `expected a port above ${blocker.port}, got ${free}`);
    assert.equal(await locator.canBindPort(HOST, free), true);
  } finally {
    await releaseOccupied(blocker);
  }
});

test('findFreePort skips the occupied base port instead of returning it', async () => {
  const blocker = await occupyPort();
  try {
    const found = await locator.findFreePort(HOST, blocker.port, { scan: 5 });
    assert.notEqual(found, blocker.port);
    assert.ok(found > blocker.port && found <= blocker.port + 5, `unexpected port ${found}`);
  } finally {
    await releaseOccupied(blocker);
  }
});

test('findFreePort returns null (never a made-up port) for an invalid base', async () => {
  assert.equal(await locator.findFreePort(HOST, 0), null);
  assert.equal(await locator.findFreePort(HOST, 'not-a-port'), null);
});

test('runtime file: a live record is read back with its url', async () => {
  writeRuntime({ app: locator.FRONTEND_APP_ID, host: HOST, port: 8123, pid: process.pid });
  const record = locator.readFrontendRuntime();
  assert.ok(record, 'expected the published record');
  assert.equal(record.port, 8123);
  assert.equal(record.url, `http://${HOST}:8123`);
  assert.equal(record.source, 'runtime-file');
});

test('runtime file: a record whose pid is dead is a stale pointer, not a location', async () => {
  writeRuntime({ app: locator.FRONTEND_APP_ID, host: HOST, port: 8123, pid: DEAD_PID });
  assert.equal(locator.readFrontendRuntime(), null);
});

test('discoverKhyFrontend: the published runtime file wins and is labelled as such', async () => {
  await withHttpServer(frontendHandler(), async (port) => {
    writeRuntime({ app: locator.FRONTEND_APP_ID, host: HOST, port, pid: process.pid });
    // Base port far away from the real one, so only the runtime file can explain a hit.
    const found = await locator.discoverKhyFrontend({ host: HOST, basePort: 62123 });
    assert.ok(found, 'expected a discovered frontend');
    assert.equal(found.port, port);
    assert.equal(found.source, 'runtime-file');
  });
});

test('discoverKhyFrontend: without a record it scans past a port that is ours-free', async () => {
  // Deterministic layout: a stranger occupies the lower port, our frontend the next
  // one — so a hit can only come from scanning past the stranger.
  const p1 = await locator.findFreePort(HOST, 44500);
  assert.ok(p1, 'expected a free base port');
  const p2 = await locator.findFreePort(HOST, p1 + 1);
  assert.ok(p2 && p2 > p1, `expected a free port above ${p1}`);
  const stranger = await startHttpServer(
    frontendHandler({ app: 'postgres-admin', title: 'PostgreSQL Admin' }),
    p1
  );
  const frontend = await startHttpServer(frontendHandler(), p2);
  try {
    const found = await locator.discoverKhyFrontend({ host: HOST, basePort: p1 });
    assert.ok(found, 'expected the scan to find the running frontend');
    assert.equal(found.port, p2, 'the stranger on the base port must be skipped, not reused');
    assert.equal(found.source, 'scan');
  } finally {
    await closeHttpServer(frontend.server);
    await closeHttpServer(stranger.server);
  }
});

test('discoverKhyFrontend: no KHY frontend anywhere returns null', async () => {
  const free = await locator.findFreePort(HOST, 45000);
  assert.ok(free, 'expected a free base port for the probe window');
  assert.equal(await locator.discoverKhyFrontend({ host: HOST, basePort: free, scan: 3 }), null);
});

test('contract parity: the frontend module publishes exactly what the locator reads', async () => {
  const mod = await import(pathToFileURL(path.join(REPO_ROOT, 'delivery/web/ai-frontend/frontendRuntime.mjs')).href);
  assert.equal(mod.FRONTEND_APP_ID, locator.FRONTEND_APP_ID);
  assert.equal(mod.FRONTEND_RUNTIME_FILENAME, locator.FRONTEND_RUNTIME_FILENAME);
  assert.equal(mod.FRONTEND_IDENTITY_PATH, locator.FRONTEND_IDENTITY_PATH);
  // The published record shape is what readFrontendRuntime() consumes.
  const published = mod.publishFrontendRuntime({ host: HOST, port: 8124, env: { KHY_DATA_HOME: tempHome } });
  assert.equal(published.ok, true);
  const record = locator.readFrontendRuntime();
  assert.ok(record, 'the locator must be able to read what the frontend published');
  assert.equal(record.port, 8124);
  assert.equal(record.pid, process.pid);
  assert.equal(record.app, locator.FRONTEND_APP_ID);
});

test('the frontend module never turns its runtime file into a directory', async () => {
  const mod = await import(pathToFileURL(path.join(REPO_ROOT, 'delivery/web/ai-frontend/frontendRuntime.mjs')).href);
  const published = mod.publishFrontendRuntime({ host: HOST, port: 8125, env: { KHY_DATA_HOME: tempHome } });
  assert.equal(published.ok, true);
  // A `getAppDataDir('*.json')` style call would mkdir a directory of that name and
  // leave the write failing with EISDIR — assert we really have a file.
  assert.equal(fs.statSync(RUNTIME_FILE).isFile(), true);
  const cleared = mod.clearFrontendRuntime({ port: 8125, env: { KHY_DATA_HOME: tempHome } });
  assert.equal(cleared.ok, true);
  assert.equal(fs.existsSync(RUNTIME_FILE), false);
});

// ── 端口占用者诊断（「8090 被占用怎么办」的可视化） ─────────────────────────────

test('parseListeningPid matches the exact port and never a suffix port', () => {
  const sample = [
    '',
    '  活动连接',
    '  协议  本地地址          外部地址        状态           PID',
    '  TCP    127.0.0.1:8090         0.0.0.0:0              LISTENING       1234',
    '  TCP    0.0.0.0:18090          0.0.0.0:0              LISTENING       2000',
    '  TCP    [::]:8090              [::]:0                 LISTENING       1234',
    '  TCP    127.0.0.1:9090         127.0.0.1:5555         ESTABLISHED     3000',
  ].join('\r\n');
  assert.equal(locator.parseListeningPid(sample, { port: 8090 }), 1234);
  assert.equal(locator.parseListeningPid(sample, { port: 18090 }), 2000);
  assert.equal(locator.parseListeningPid(sample, { port: 9090 }), 0, 'non-LISTEN rows are not owners');
  assert.equal(locator.parseListeningPid('  TCP    [::1]:8090    [::]:0    LISTENING    777', { port: 8090 }), 777);
  assert.equal(locator.parseListeningPid('garbage', { port: 8090 }), 0);
  assert.equal(locator.parseListeningPid('', { port: 0 }), 0);
});

test('parseProcessNameFromCsv picks the name paired with the pid', () => {
  const csv = '"other.exe","99","Console","1","1,000 K"\r\n"node.exe","1234","Console","1","9,999 K"';
  assert.equal(locator.parseProcessNameFromCsv(csv, 1234), 'node.exe');
  assert.equal(locator.parseProcessNameFromCsv(csv, 4321), '');
  assert.equal(locator.parseProcessNameFromCsv('', 1234), '');
});

if (process.platform === 'win32') {
  test('describePortOwner names the real listener (our own test server)', async () => {
    const { server, port } = await startHttpServer((req, res) => {
      res.end('ok');
    });
    try {
      const who = await locator.describePortOwner(port);
      assert.match(who, new RegExp(`端口 ${port} 被进程 .+（PID ${process.pid}）占用`));
    } finally {
      await closeHttpServer(server);
    }
  });

  test('describePortOwner returns "" for a free port (unknown, not invented)', async () => {
    const blocker = await occupyPort();
    const { port } = blocker;
    await releaseOccupied(blocker);
    assert.equal(await locator.describePortOwner(port), '');
  });
}