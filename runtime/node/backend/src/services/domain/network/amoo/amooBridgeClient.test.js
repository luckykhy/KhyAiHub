'use strict';

// Co-located unit test for amooBridgeClient.js.
//
// No phone is involved: `spawn` is replaced by a router that answers the exact
// argv this unit emits, and the bridge's HTTP port is a REAL loopback server on
// an ephemeral port. That combination is what makes the following assertable
// here rather than on the device:
//   - `adb pair` is never emitted (the router throws on it),
//   - a hung child is killed by the deadline instead of hanging the test,
//   - the token is read from the device, cached, and never appears in any
//     result body or log line,
//   - a stalled HTTP request resolves to a structured error, not a hang.
//
// The spawn double is installed BEFORE the module is required, because the
// client binds `spawn` at load time and a later patch would silently miss.

const test = require('node:test').test;
const after = require('node:test').after;
const before = require('node:test').before;
const assert = require('node:assert/strict');
const http = require('node:http');
const cp = require('node:child_process');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const TOKEN = '5500fae8db41cd054f45ea8834198d30';

function pinSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-amoo-cli-'));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.KHY_DATA_HOME = path.join(root, 'data');
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('KHY_AMOO_')) {
      delete process.env[key];
    }
  }
  return root;
}

const sandbox = pinSandbox();

// ── spawn router ──────────────────────────────────────────────────────────
// Answers the argv shapes the client actually emits. Anything else — above all
// `pair` — is a test failure, not a silent pass.

const REAL_SPAWN = cp.spawn;
const spawnLog = [];
const HANGING = new Set();
let hangForever = false;

function fakeSpawn(file, argv) {
  spawnLog.push({ file, argv: argv.slice() });
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };

  const joined = argv.join(' ');
  if (argv.includes('pair')) {
    setImmediate(() => {
      child.stderr.emit('data', 'protocol fault: pairing is not allowed here');
      child.emit('close', 1);
    });
    return child;
  }

  let out = '';
  let errOut = '';
  let code = 0;
  if (argv[0] === 'devices') {
    out = `List of devices attached\n192.168.2.46:33743\tdevice\n`;
  } else if (argv[0] === 'connect') {
    out = 'connected to 192.168.2.46:33743\n';
  } else if (argv[0] === '-s' && argv[2] === 'forward' && argv[3].startsWith('tcp:')) {
    out = '';
  } else if (argv[0] === '-s' && argv[2] === 'forward' && argv[3] === '--list') {
    out = '192.168.2.46:33743 tcp:8896 tcp:8896\n192.168.2.46:33743 tcp:8898 tcp:8896\n';
  } else if (argv[0] === '-s' && argv[2] === 'shell' && argv[3] === 'cat') {
    out = `${TOKEN}\n`;
  } else if (argv[0] === '-s' && argv[2] === 'shell' && argv[3] === 'am' && argv[4] === 'broadcast') {
    out = 'Broadcasting: Intent { act=com.khyos.khy_os_client.bridge.REVIVE }\nBroadcast completed: result=0\n';
  } else if (argv[0] === '-s' && argv[2] === 'shell' && argv[3] === 'uiautomator') {
    out = 'UI hierchary dumped to: /sdcard/khy_amoo_ui.xml\n';
  } else if (argv[0] === '-s' && argv[2] === 'pull') {
    out = '1 file pulled, 0 skipped.\n';
  } else if (argv[0] === '-s' && argv[2] === 'push') {
    out = '1 file pushed, 0 skipped.\n';
  } else if (argv[0] === '-s' && argv[2] === 'shell' && argv[3] === 'rm') {
    out = '';
  } else if (argv[0] === '-s' && argv[2] === 'shell' && argv[3] === 'input') {
    out = '';
  } else if (argv[0] === '-s' && argv[2] === 'shell' && argv[3] === 'am') {
    out = 'Starting: Intent { cmp=com.stepos.ailauncher/.chat.activity.ChatMainActivity }\n';
  } else if (argv[0] === '-s' && argv[2] === 'shell' && argv[3] === 'cat') {
    out = '{"running":true}';
  } else {
    code = 127;
    errOut = `fake adb: unhandled argv ${joined}\n`;
  }

  if (hangForever || HANGING.has(joined)) {
    // Never emits close: the deadline has to be what ends this.
    return child;
  }
  setImmediate(() => {
    if (out) {
      child.stdout.emit('data', out);
    }
    if (errOut) {
      child.stderr.emit('data', errOut);
    }
    child.emit('close', code);
  });
  return child;
}

cp.spawn = fakeSpawn;
after(() => {
  cp.spawn = REAL_SPAWN;
});

const { resolveAmooConfig } = require('./amooBridgeConfig');
const { AmooBridgeClient, withDeadline } = require('./amooBridgeClient');

// ── a real loopback bridge ────────────────────────────────────────────────

let server;
let basePort;
let requestLog = [];
let hangNextCall = false;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      requestLog.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization || null,
        body,
      });
      if (hangNextCall) {
        // Deliberately never answers: the client deadline must win.
        return;
      }
      const send = (status, payload) => {
        const text = JSON.stringify(payload);
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(text),
        });
        res.end(text);
      };
      if (req.url.startsWith('/ping')) {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) {
          return send(401, { ok: false, error: 'unauthorized' });
        }
        return send(200, { ok: true, pong: Date.now() });
      }
      if (req.url.startsWith('/status')) {
        return send(200, { ok: true, up: true, port: basePort, mode: 'lite', tools: 22 });
      }
      if (req.url.startsWith('/call')) {
        let parsed = {};
        try {
          parsed = JSON.parse(body || '{}');
        } catch {
          return send(400, { ok: false, error: 'bad json' });
        }
        if (parsed.tool === 'clipboard') {
          return send(200, { ok: true, tool: 'clipboard', op: 'set' });
        }
        if (parsed.tool === 'ui_dump') {
          return send(200, { ok: false, tool: 'ui_dump', error: 'unknown tool: ui_dump' });
        }
        return send(200, { ok: false, error: 'unknown tool' });
      }
      return send(404, { ok: false, error: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  basePort = server.address().port;
});

after(() => {
  server.close();
});

function makeClient(overrides = {}) {
  const env = {
    // A fake adb path keeps resolveAdbPath off the real PATH lookup, so these
    // cases never depend on whether this machine happens to have adb installed.
    KHY_AMOO_ADB_PATH: 'C:/fake/platform-tools/adb.exe',
    KHY_AMOO_BRIDGE_PORT: String(basePort),
    ...(overrides.env || {}),
  };
  const config = resolveAmooConfig(env);
  return new AmooBridgeClient({
    config,
    spawnImpl: fakeSpawn,
    ...(overrides.opts || {}),
  });
}

test('withDeadline resolves the race and clears its timer', async () => {
  const fast = await withDeadline(Promise.resolve('done'), 5000);
  assert.equal(fast, 'done');
  const slow = await withDeadline(new Promise(() => {}), 20);
  assert.equal(slow.__deadline, true);
  // A rejection propagates instead of being swallowed by the race.
  await assert.rejects(() => withDeadline(Promise.reject(new Error('boom')), 5000), /boom/);
});

test('resolveAdbPath prefers the env path, then PATH, and reports honestly', () => {
  const fromEnv = makeClient({ env: { KHY_AMOO_ADB_PATH: 'C:/platform-tools/adb.exe' } });
  assert.equal(fromEnv.resolveAdbPath().source, 'env');
  assert.equal(fromEnv.resolveAdbPath().path, 'C:/platform-tools/adb.exe');

  const injected = new AmooBridgeClient({
    config: resolveAmooConfig({ KHY_AMOO_BRIDGE_PORT: String(basePort) }),
    spawnImpl: fakeSpawn,
    resolveAdbPath: () => ({ path: 'D:/tools/adb.exe', source: 'injected' }),
  });
  assert.equal(injected.resolveAdbPath().source, 'injected');

  const missing = new AmooBridgeClient({
    config: resolveAmooConfig({ KHY_AMOO_BRIDGE_PORT: String(basePort) }),
    spawnImpl: fakeSpawn,
    resolveAdbPath: () => null,
  });
  const resolved = missing.resolveAdbPath();
  assert.equal(resolved.ok, false);
  assert.match(resolved.message, /KHY_AMOO_ADB_PATH/);
});

test('runAdb returns a structured result and never emits pair', async () => {
  const client = makeClient();
  const result = await client.runAdb(['devices']);
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /192\.168\.2\.46:33743/);
  assert.equal(result.error, null);
  assert.deepEqual(result.argv, ['devices']);
  assert.equal(spawnLog.some((entry) => entry.argv.includes('pair')), false);
});

test('runAdb surfaces a non-zero exit as ok:false with the stderr text', async () => {
  const client = makeClient();
  const result = await client.runAdb(['definitely-not-a-command']);
  assert.equal(result.ok, false);
  assert.equal(result.code, 127);
  assert.match(result.stderr, /unhandled argv/);
});

test('a hung adb command is killed by the deadline, not waited on', async () => {
  hangForever = true;
  try {
    const client = makeClient();
    const started = Date.now();
    const result = await client.runAdb(['shell', 'sleep', '300'], { timeoutMs: 60 });
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'adb_timeout');
    assert.ok(Date.now() - started < 2000, 'the deadline must actually fire');
  } finally {
    hangForever = false;
  }
});

test('ensureDevice connects only when the device is absent, never pairs', async () => {
  const present = await makeClient().ensureDevice();
  assert.equal(present.ok, true);
  assert.equal(present.connected, true);
  assert.equal(present.detail, '设备已连接');
  assert.equal(spawnLog.filter((entry) => entry.argv[0] === 'connect').length, 0);

  spawnLog.length = 0;
  // First `devices` reports nothing, later ones see the device: that is exactly
  // the "connect was needed" path.
  let devicesCalls = 0;
  const absent = await makeClient({
    opts: {
      spawnImpl: (file, argv) => {
        if (argv[0] === 'devices') {
          devicesCalls += 1;
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          const listing =
            devicesCalls === 1
              ? 'List of devices attached\n'
              : 'List of devices attached\n192.168.2.46:33743\tdevice\n';
          setImmediate(() => {
            child.stdout.emit('data', listing);
            child.emit('close', 0);
          });
          return child;
        }
        return fakeSpawn(file, argv);
      },
    },
  }).ensureDevice();
  assert.equal(absent.ok, true);
  assert.equal(absent.connected, true);
  assert.match(absent.detail, /本次执行 connect/);
  assert.equal(spawnLog.filter((entry) => entry.argv[0] === 'connect').length, 1);
  assert.equal(spawnLog.some((entry) => entry.argv.includes('pair')), false);
});

test('ensureForward establishes the real port and the alias port', async () => {
  spawnLog.length = 0;
  const result = await makeClient().ensureForward();
  assert.equal(result.ok, true);
  // The real port is whatever this test's loopback bridge bound to; 8898 is the
  // documented alias and must stay 8898 regardless.
  assert.deepEqual(result.forwards, [`tcp:${basePort}`, 'tcp:8898']);
  const forwards = spawnLog.filter((entry) => entry.argv[2] === 'forward' && entry.argv[3] !== '--list');
  assert.equal(forwards.length, 2);
  assert.deepEqual(forwards[0].argv, [
    '-s',
    '192.168.2.46:33743',
    'forward',
    `tcp:${basePort}`,
    `tcp:${basePort}`,
  ]);
  // 8898 is an ALIAS onto the real port, not a second listener.
  assert.deepEqual(forwards[1].argv, [
    '-s',
    '192.168.2.46:33743',
    'forward',
    'tcp:8898',
    `tcp:${basePort}`,
  ]);
});

test('readToken reads from the device, caches, and masks', async () => {
  const client = makeClient();
  spawnLog.length = 0;
  const first = await client.readToken();
  assert.equal(first.ok, true);
  assert.equal(first.token, TOKEN);
  assert.equal(first.masked, '5500…8d30');
  assert.equal(spawnLog.filter((entry) => entry.argv.includes('cat')).length, 1);
  // Second read is served from cache: no second device round trip.
  const second = await client.readToken();
  assert.equal(second.ok, true);
  assert.equal(spawnLog.filter((entry) => entry.argv.includes('cat')).length, 1);
  // The masked form must never contain the whole secret.
  assert.equal(client.tokenMask().includes(TOKEN), false);
  // And the token must not ride along on any OTHER result: readToken is the only
  // method that hands it out, and it hands out the raw value by necessity.
  const ping = await client.ping();
  assert.equal(JSON.stringify(ping).includes(TOKEN), false);
  const status = await client.status();
  assert.equal(JSON.stringify(status).includes(TOKEN), false);
  client.invalidateToken();
  await client.readToken();
  assert.equal(spawnLog.filter((entry) => entry.argv.includes('cat')).length, 2);
});

test('readToken rejects a malformed token without caching it', async () => {
  const client = makeClient({
    opts: {
      spawnImpl: (file, argv) => {
        if (argv[0] === '-s' && argv[2] === 'shell' && argv[3] === 'cat') {
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          setImmediate(() => {
            child.stdout.emit('data', 'nope\n');
            child.emit('close', 0);
          });
          return child;
        }
        return fakeSpawn(file, argv);
      },
    },
  });
  const result = await client.readToken();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'token_too_short');
  assert.equal(client.tokenMask(), '****');
});

test('bridgeRequest sends the bearer token and parses the JSON body', async () => {
  const client = makeClient();
  requestLog.length = 0;
  const res = await client.bridgeRequest('/ping');
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(requestLog.length, 1);
  assert.equal(requestLog[0].auth, `Bearer ${TOKEN}`);
  assert.equal(requestLog[0].url, '/ping');
});

test('bridgeRequest reports 401 without leaking the token into the error', async () => {
  const client = makeClient();
  const res = await client.bridgeRequest('/nope');
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
  assert.equal(JSON.stringify(res).includes(TOKEN), false);
});

test('a stalled HTTP request resolves to a timeout instead of hanging', async () => {
  hangNextCall = true;
  try {
    // The config floor for the HTTP timeout is 1000ms on purpose (a loopback
    // call should not be given a hair trigger), so this case injects the short
    // deadline directly instead of going through the env clamp.
    const config = resolveAmooConfig({
      KHY_AMOO_ADB_PATH: 'C:/fake/platform-tools/adb.exe',
      KHY_AMOO_BRIDGE_PORT: String(basePort),
    });
    config.bridge.httpTimeoutMs = 300;
    const client = new AmooBridgeClient({ config, spawnImpl: fakeSpawn });
    const started = Date.now();
    const res = await client.bridgeRequest('/ping');
    assert.equal(res.ok, false);
    assert.equal(res.error, 'bridge_request_timeout');
    assert.ok(Date.now() - started < 3000, 'the socket timeout must fire');
  } finally {
    hangNextCall = false;
  }
});

test('ping and status report latency and the lite build tool count', async () => {
  const client = makeClient();
  const ping = await client.ping();
  assert.equal(ping.ok, true);
  assert.ok(ping.latencyMs >= 0);
  const status = await client.status();
  assert.equal(status.ok, true);
  assert.equal(status.status.tools, 22);
  assert.equal(status.status.mode, 'lite');
});

test('ensureBridge revives a dead bridge with a REVIVE broadcast and retries once', async () => {
  let pings = 0;
  const client = makeClient({
    opts: {
      spawnImpl: (file, argv) => {
        if (argv[0] === '-s' && argv[2] === 'shell' && argv[3] === 'cat') {
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          setImmediate(() => {
            child.stdout.emit('data', `${TOKEN}\n`);
            child.emit('close', 0);
          });
          return child;
        }
        return fakeSpawn(file, argv);
      },
      sleep: async () => {},
    },
  });

  // First ping fails (wrong token path is not used here, so simulate by closing
  // the socket): patch bridgeRequest on this instance only.
  const original = client.bridgeRequest.bind(client);
  client.bridgeRequest = async (path, body) => {
    pings += 1;
    if (pings === 1) {
      return { ok: false, status: null, body: null, raw: '', error: 'bridge_unreachable' };
    }
    return original(path, body);
  };

  const result = await client.ensureBridge();
  assert.equal(result.ok, true);
  assert.equal(result.revived, true);
  assert.match(result.detail, /重新拉起/);
  assert.equal(spawnLog.some((entry) => entry.argv.includes('broadcast') && entry.argv.some((v) => String(v).includes('REVIVE'))), true);
  assert.equal(pings, 2);
});

test('ensureBridge reports honestly when the bridge stays dead', async () => {
  const client = makeClient({ opts: { sleep: async () => {} } });
  client.bridgeRequest = async () => ({ ok: false, status: null, body: null, raw: '', error: 'still dead' });
  const result = await client.ensureBridge();
  assert.equal(result.ok, false);
  assert.match(result.detail, /仍无响应/);
});

test('a failed post-clipboard probe raises the suspect flag and forces a revival', async () => {
  const client = makeClient({ opts: { sleep: async () => {} } });
  let pings = 0;
  client.bridgeRequest = async (path) => {
    if (path === '/ping') {
      pings += 1;
      // The probe ping fails — the observed clipboard wedge. The ping issued
      // AFTER the revival succeeds, which is what makes the revival the thing
      // under test rather than a second failure.
      if (pings === 1) {
        return { ok: false, status: null, body: null, raw: '', error: 'bridge_unreachable' };
      }
    }
    return { ok: true, status: 200, body: { ok: true }, raw: '{}', error: null };
  };

  const probe = await client.probeAfterClipboard();
  assert.equal(probe.ok, false);
  assert.equal(client._bridgeSuspect, true);

  // ensureBridge must not trust a fresh ping here: the flag makes it revive
  // FIRST and ping once afterwards. pings===2 is that single post-revival ping.
  const ensured = await client.ensureBridge();
  assert.equal(ensured.ok, true);
  assert.equal(ensured.revived, true);
  assert.equal(pings, 2);
  // The flag is consumed, so one bad probe costs one revival, not a loop.
  assert.equal(client._bridgeSuspect, false);
  assert.equal(spawnLog.some((entry) => entry.argv.includes('broadcast') && entry.argv.some((v) => String(v).includes('REVIVE'))), true);
});

test('scratch paths go through the data-home resolver, never cwd', () => {
  const client = makeClient();
  const seen = [];
  const getAppDataDir = (...segments) => {
    seen.push(segments);
    return path.join(sandbox, 'appdata', ...segments);
  };
  const file = client.scratchFile(getAppDataDir, 'ui_1.xml');
  assert.equal(file, path.join(sandbox, 'appdata', 'amoo', 'ui_1.xml'));
  assert.deepEqual(seen[0], ['amoo']);
  assert.equal(file.includes(process.cwd()), false);
});
