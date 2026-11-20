'use strict';

/**
 * phoneBridgeClient.test.js — co-located suite for the phone bridge IO shell.
 *
 * Mock only: `child_process.spawn` is replaced with a throwing stub BEFORE the
 * module is required (spawn binds at module load — later patching is
 * ineffective, the same trap network/remote's suites document), and every
 * transport is injected. No adb process is ever started, no HTTP request leaves
 * the process, and the real phone is never contacted.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');

// B31-R17 同族：spawn 在模块装载时绑定，后 patch 无效。任何漏网的默认 transport
// 一启动就会炸，而不是真去连手机。
const REAL_SPAWN = childProcess.spawn;
childProcess.spawn = function throwingSpawn() {
  throw new Error('phoneBridgeClient.test.js: 未注入 transport 就想 spawn adb —— 测试必须显式注入');
};

const client = require('./phoneBridgeClient');
const bridgeConfig = require('./phoneBridgeConfig');

const TOKEN = '5500fae8db41cd054f45ea8834198d30';
const SERIAL = '192.168.2.46:33743';

/**
 * 假凭据：真实凭据要跟一台真手机配对（配对码在手机通知栏），单测里做不到。
 *
 * <p>注入点是 `options.credential`——产品默认用的是真的
 * phoneBridgeCredential（文件 + 配对 + 每请求签名）。这里只替换「凭据从哪来」，
 * 不动「拿到之后怎么用」，所以请求头、401 分支、重配逻辑都仍然在测。
 *
 * <p>Authorization 仍返回 `Bearer ${TOKEN}`：断言「恰好一个空格」的那条用例
 * 因此还在测真东西（头形状），而不是测这个假对象。
 */
function fakeCredential(overrides = {}) {
  const state = { paired: true, usable: true, invalidated: 0, ensured: 0 };
  const base = {
    async ensure() {
      state.ensured += 1;
      return { ok: true, cached: true, deviceId: 'aabbccdd11223344' };
    },
    invalidate() {
      state.invalidated += 1;
      state.paired = false;
      state.usable = false;
    },
    signedHeaders() {
      return {
        ok: true,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'X-Khy-Ts': '1700000000000',
          'X-Khy-Sig': 'c2ln',
        },
      };
    },
    describe() {
      return {
        paired: state.paired,
        usable: state.usable,
        storePath: '/home/u/.khyos/phone-bridge-credential.json',
        deviceId: 'aabbccdd11223344',
        expiresInMs: 86400000,
      };
    },
  };
  return { credential: { ...base, ...overrides }, state };
}

/**
 * 所有用例的统一入口：默认注入假凭据，需要时用 opts.credential 覆盖。
 *
 * <p>直接调 client.createPhoneBridgeClient 的用例会走真凭据（文件 + 配对），
 * 在一个没有手机的测试进程里必然失败——那不是「测出问题」，只是没接线。
 */
function createClient(opts = {}) {
  return client.createPhoneBridgeClient({
    credential: fakeCredential().credential,
    ...opts,
  });
}

const CONFIG = Object.freeze({
  adbExecutable: 'adb.exe',
  serial: SERIAL,
  httpPort: 8896,
  localPort: 8896,
  loopbackHost: '127.0.0.1',
  baseUrl: 'http://127.0.0.1:8896',
  mailboxDir: '/sdcard/bridge-amoobridge',
  tokenRemotePath: '/sdcard/bridge-amoobridge/token.txt',
  statusRemotePath: '/sdcard/bridge-amoobridge/status.json',
  httpTimeoutMs: 10000,
  adbTimeoutMs: 10000,
  retryCount: 1,
  mailboxPollMs: 10,
  mailboxTimeoutMs: 200,
});

function ok(stdout = '') {
  return { ok: true, code: 0, stdout, stderr: '', aborted: false };
}

function fail(stderr = 'boom') {
  return { ok: false, code: 1, stdout: '', stderr, aborted: false };
}

/** adb transport that answers from an ordered script; keys are argv[0] of the
 *  subcommand after the optional '-s <serial>' pair. */
function scriptedAdb(script) {
  const calls = [];
  let index = 0;
  return {
    calls,
    run(argv) {
      calls.push({ argv: argv.slice() });
      const step = script[index] || {};
      index += 1;
      const answer = typeof step === 'function' ? step(argv) : step;
      return Promise.resolve(answer || fail('script exhausted'));
    },
    push(local, remote) {
      calls.push({ argv: ['push', local, remote] });
      const step = script[index] || {};
      index += 1;
      const answer = typeof step === 'function' ? step(['push', local, remote]) : step;
      return Promise.resolve(answer || { ok: true });
    },
  };
}

function adbSub(argv) {
  return argv[0] === '-s' ? argv[2] : argv[0];
}

/**
 * 脚本化 HTTP：`script` 只喂**业务请求**（/ping /status /call /devices/register）。
 *
 * `/state` 直连通告（S0 缓存路径的节流探测）由 opts.state 罐头应答，默认
 * 「设备已在册」，且**不消耗 script 位**——否则每个既有用例都得为探测腾一格。
 * 探测单独记在 `stateCalls`，既有 `calls` 的按下标断言不受影响。
 * opts.state 传对象=固定应答，传函数=每次现算，传 undefined=默认在册。
 */
function scriptedHttp(script, opts = {}) {
  const calls = [];
  const stateCalls = [];
  let index = 0;
  const defaultState = {
    ok: true,
    registry: {
      used: 1,
      max: 8,
      devices: [{ deviceId: 'aabbccdd11223344', regSource: 'manual', registeredAt: 1700000000000 }],
    },
    reg: { reg_state: 'registered', last_reg_ms: 1700000000000, registration_source: 'manual' },
  };
  return {
    calls,
    stateCalls,
    request(opts2) {
      if (String(opts2.url || '').includes('/state')) {
        stateCalls.push(opts2);
        const canned = typeof opts.state === 'function'
          ? opts.state(opts2)
          : (opts.state !== undefined ? opts.state : defaultState);
        // 探测方按 HTTP 回执读（status/body）；传裸 payload 时在这里包一层。
        if (!canned) return Promise.resolve({ status: 0, body: '', ok: false, error: 'state probe down' });
        if (canned.status === undefined && canned.body === undefined) {
          return Promise.resolve({ status: 200, ok: true, body: JSON.stringify(canned) });
        }
        return Promise.resolve(canned);
      }
      calls.push(opts2);
      const step = script[index] || {};
      index += 1;
      const answer = typeof step === 'function' ? step(opts2) : step;
      return Promise.resolve(answer || { status: 0, body: '', ok: false, error: 'script exhausted' });
    },
  };
}

function httpOk(body) {
  return { status: 200, body: typeof body === 'string' ? body : JSON.stringify(body), ok: true };
}

/** 桥的 401 回执（2026-11-14 起带 code/token_age_ms/token_persisted）。 */
function httpUnauthorized(extra = {}) {
  return {
    status: 401,
    body: JSON.stringify({
      ok: false,
      error: 'unauthorized',
      code: 'token_mismatch',
      token_age_ms: 12345,
      token_persisted: false,
      ...extra,
    }),
    ok: false,
  };
}

function httpDown(error = 'connect ECONNREFUSED') {
  return { status: 0, body: '', ok: false, error };
}

function makeClient(overrides = {}) {
  const fake = overrides.credentialState || fakeCredential();
  const instance = createClient({
    env: overrides.env || {},
    config: overrides.config || CONFIG,
    adbTransport: overrides.adb || scriptedAdb([]),
    httpTransport: overrides.http || scriptedHttp([]),
    credential: overrides.credential || fake.credential,
    sleep: overrides.sleep || (() => Promise.resolve()),
    now: overrides.now || (() => 1700000000000),
    createId: overrides.createId || (() => 'abc123'),
    signalFactory: overrides.signalFactory || (() => new AbortController().signal),
  });
  return instance;
}

test('parseDeviceList 跳过表头与 daemon 行，只留 serial/state', () => {
  const map = client.parseDeviceList(
    'List of devices attached\n'
    + '* daemon not running; starting now at tcp:5037\n'
    + '* daemon started successfully\n'
    + `${SERIAL}\tdevice\n`
    + 'emulator-5554\toffline\n'
  );
  assert.deepEqual([...map.entries()], [[SERIAL, 'device'], ['emulator-5554', 'offline']]);
  assert.deepEqual([...client.parseDeviceList('').entries()], []);
  assert.deepEqual([...client.parseDeviceList(undefined).entries()], []);
});

test('parseDeviceList 对只有序列号没有状态的行标 unknown', () => {
  assert.deepEqual([...client.parseDeviceList('abc\n').entries()], [['abc', 'unknown']]);
});

// ── gate ─────────────────────────────────────────────────────────────────────

test('父门 KHY_PHONE_BRIDGE=0 时每个入口都诚实拒绝，不碰 adb', async () => {
  const adb = scriptedAdb([]);
  const c = makeClient({ env: { KHY_PHONE_BRIDGE: '0' }, adb });
  for (const fn of [() => c.ping(), () => c.status(), () => c.probe(), () => c.revive(),
    () => c.ensureConnected(), () => c.ensureForward(), () => c.readToken(),
    () => c.call('battery')]) {
    const res = await fn();
    assert.equal(res.ok, false);
    assert.equal(res.code, 'bridge_disabled');
    assert.match(res.error, /KHY_PHONE_BRIDGE=0/);
  }
  assert.equal(adb.calls.length, 0);
});

test('门开（默认）时不被拦住', async () => {
  const c = makeClient({ env: {} });
  assert.equal(c.getState().enabled, true);
  assert.equal(c.getState().mailboxFallbackEnabled, true);
});

// ── connect / forward ────────────────────────────────────────────────────────

test('设备已在列表里时不重复 connect', async () => {
  const adb = scriptedAdb([ok(`${SERIAL}\tdevice\n`)]);
  const c = makeClient({ adb });
  const res = await c.ensureConnected();
  assert.equal(res.ok, true);
  assert.equal(res.reused, true);
  assert.equal(adb.calls.length, 1);
  assert.deepEqual(adb.calls[0].argv, ['devices']);
});

test('设备不在列表里时才 connect，且永不 pair', async () => {
  const adb = scriptedAdb([
    ok('List of devices attached\n'),
    ok('connected to 192.168.2.46:33743\n'),
  ]);
  const c = makeClient({ adb });
  const res = await c.ensureConnected();
  assert.equal(res.ok, true);
  assert.equal(res.connected_now, true);
  assert.equal(adb.calls.length, 2);
  assert.deepEqual(adb.calls[1].argv, ['-s', SERIAL, 'connect', SERIAL]);
  for (const call of adb.calls) {
    assert.equal(call.argv.includes('pair'), false);
  }
});

test('设备在列表里但状态不是 device（offline/unauthorized）时仍然去 connect', async () => {
  const adb = scriptedAdb([
    ok(`${SERIAL}\tunauthorized\n`),
    ok('connected\n'),
  ]);
  const c = makeClient({ adb });
  const res = await c.ensureConnected();
  assert.equal(res.ok, true);
  assert.equal(adb.calls[1].argv[2], 'connect');
});

test('connect 失败时报中文 actionable 错误', async () => {
  const adb = scriptedAdb([ok('List of devices attached\n'), fail('cannot connect to 192.168.2.46:33743')]);
  const c = makeClient({ adb });
  const res = await c.ensureConnected();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'adb_connect_failed');
  assert.match(res.error, /同一局域网/);
  assert.match(res.error, /无线调试已开启/);
  assert.equal(res.error.includes('833722'), false);
});

test('adb devices 自己失败时不猜设备状态', async () => {
  const adb = scriptedAdb([fail('adb.exe 不是内部或外部命令')]);
  const c = makeClient({ adb });
  const res = await c.ensureConnected();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'adb_connect_failed');
  assert.equal(c.getState().connected, false);
});

// ── 发现链的最后一档：记住上次的 IP → 扫端口 ────────────────────────────────

test('自动档：记住的手机不在本机网段时如实说「换了 Wi-Fi」，且不白扫端口', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const tmp = path.join(os.tmpdir(), `khy-disc-${process.pid}.json`);
  // 10.99.99.99 不可能与任何机器同网段——测试不依赖这台机器的网络形态。
  fs.writeFileSync(tmp, JSON.stringify({ schema: 'khy-phone-discovery/1', serial: '10.99.99.99:5555' }));
  const adb = scriptedAdb([
    ok('List of devices attached\n'),
    ok(''),            // mdns 服务列表：空
    fail('cannot connect to :5555'),
  ]);
  const c = makeClient({
    adb,
    env: { KHY_PHONE_DISCOVERY_FILE: tmp },
    config: { ...CONFIG, serial: '', serialSource: 'default' },
  });
  try {
    const res = await c.ensureConnected();
    assert.equal(res.ok, false);
    assert.equal(res.code, 'device_not_found');
    assert.match(res.error, /Wi-Fi/, '要说清是「换了 Wi-Fi」而不是泛泛的未发现');
    assert.match(res.error, /10\.99\.99\.99/);
    // 不同网段就没必要扫——扫了也只是白等到超时。
    assert.equal(c.getState().lastPortScan, undefined);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('env 显式指定的串号是人的决定：扫描档不介入，报错仍是可执行的那句', async () => {
  const adb = scriptedAdb([ok('List of devices attached\n'), fail('cannot connect to 192.168.2.46:33743')]);
  const c = makeClient({ adb });
  const res = await c.ensureConnected();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'adb_connect_failed');
  assert.match(res.error, /同一局域网/);
  assert.equal(c.getState().lastPortScan, undefined, 'env 档不扫端口');
});


test('forward 是 tcp:<local> -> tcp:<remote>，绑定后不重复 spawn', async () => {
  const adb = scriptedAdb([
    ok(`${SERIAL}\tdevice\n`),
    ok('8896\n'),
    ok('8896\n'),
  ]);
  const c = makeClient({ adb });
  const first = await c.ensureForward();
  assert.equal(first.ok, true);
  assert.equal(first.reused, undefined);
  assert.deepEqual(adb.calls[1].argv, ['-s', SERIAL, 'forward', 'tcp:8896', 'tcp:8896']);
  // 第二次不再 spawn：forward 绑定后会一直有效，直到设备掉线或 revive 重置
  const second = await c.ensureForward();
  assert.equal(second.ok, true);
  assert.equal(second.reused, true);
  assert.equal(adb.calls.length, 2);
});

test('forward 失败时不再往下发 HTTP', async () => {
  const adb = scriptedAdb([ok(`${SERIAL}\tdevice\n`), fail('cannot bind')]);
  const http = scriptedHttp([]);
  const c = makeClient({ adb, http });
  const res = await c.ping();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'adb_forward_failed');
  assert.equal(http.calls.length, 0);
});

// ── 凭据（断点二：token.txt 已下线）─────────────────────────────────────────
//
// 这一组替换掉原来的「读 token.txt」四条。它们不是在描述新实现，而是在钉住
// 一条**产品承诺**：设备侧不再有可读的长期凭据，PC 侧也就不该再去读它。

function unusableCredential(overrides = {}) {
  return fakeCredential({
    describe: () => ({
      paired: false,
      usable: false,
      storePath: '/home/u/.khyos/phone-bridge-credential.json',
      deviceId: '',
      expiresInMs: 0,
    }),
    ...overrides,
  });
}

test('凭据可用且服务端在册时，一次都不读 status.json（收窄后的承诺）', async () => {
  // 旧承诺原文：「已经有可用凭据时**不去问设备它叫什么**——证书里就写着
  // device_id，再读一次 status.json 只多一次 adb 往返，换不到任何额外保证」。
  // S0 验收裁决（2026-11-17）收窄为：「**服务端认识这台设备时**不去问它」。
  // 凭据可用时先探一次本机 admin /state（只打 127.0.0.1，不外发设备标识）；
  // 服务端在册 → 仍然一次都不读 status.json；只有服务端真把这台设备忘了才读
  // 一次并补登记。旧断言为什么不再原样成立：服务端把设备忘了时，那次读取
  // 换到的不再只是「多一次往返」，而是链路恢复本身。
  const adb = scriptedAdb([ok(`${SERIAL}\tdevice\n`), ok('8896\n')]);
  const http = scriptedHttp([httpOk({ ok: true, pong: 1 }), httpOk({ ok: true, pong: 2 })]);
  const c = makeClient({ adb, http });
  assert.equal((await c.ping()).ok, true);
  assert.equal((await c.ping()).ok, true);

  const tokenReads = adb.calls.filter(
    (call) => call.argv.includes('cat') && call.argv.includes(CONFIG.tokenRemotePath),
  );
  assert.equal(tokenReads.length, 0, 'PC 侧不该再去读 token.txt');
  const statusReads = adb.calls.filter(
    (call) => call.argv.includes('cat') && call.argv.includes(CONFIG.statusRemotePath),
  );
  assert.equal(statusReads.length, 0, '服务端在册时不该读 status.json 取身份');
  assert.equal(http.stateCalls.length, 1, '节流：十分钟内只探一次 /state');
  assert.equal(c.getState().registration.reg_state, 'registered');
});

test('服务端登记表里没有这台设备：缓存路径补读一次身份并自动登记', async () => {
  const adb = scriptedAdb([
    ok(`${SERIAL}\tdevice\n`),
    ok('8896\n'),
    ok(JSON.stringify({ identity: { ok: true, device_id: 'aabbccdd11223344', public_key_b64: 'cHVia2V5' } })),
  ]);
  const http = scriptedHttp(
    [adminRegisterOk('aabbccdd11223344'), httpOk({ ok: true, pong: 1 }), httpOk({ ok: true, pong: 2 })],
    { state: { ok: true, registry: { used: 0, max: 8, devices: [] }, reg: { reg_state: 'unregistered', last_reg_ms: null, registration_source: null } } },
  );
  const c = makeClient({ adb, http });
  assert.equal((await c.ping()).ok, true);
  assert.equal((await c.ping()).ok, true);

  const statusReads = adb.calls.filter(
    (call) => call.argv.includes('cat') && call.argv.includes(CONFIG.statusRemotePath),
  );
  assert.equal(statusReads.length, 1, '服务端不认识时补读一次身份');
  const registerPosts = http.calls.filter(
    (x) => x.method === 'POST' && String(x.url).includes('/devices/register'),
  );
  assert.equal(registerPosts.length, 1, '补登记恰好一次');
  const reg = c.getState().registration;
  assert.equal(reg.reg_state, 're_registered');
  assert.equal(reg.registration_source, 'auto');
  assert.equal(reg.last_reg_ms, 1700000000000);
});

test('admin 不可达：缓存路径不读 status.json，且进程内失败退避不再二探', async () => {
  const adb = scriptedAdb([ok(`${SERIAL}\tdevice\n`), ok('8896\n')]);
  const http = scriptedHttp(
    [httpOk({ ok: true, pong: 1 }), httpOk({ ok: true, pong: 2 })],
    { state: httpDown('connect ECONNREFUSED 127.0.0.1:8793') },
  );
  const c = makeClient({ adb, http });
  assert.equal((await c.ping()).ok, true);
  assert.equal((await c.ping()).ok, true);

  const statusReads = adb.calls.filter(
    (call) => call.argv.includes('cat') && call.argv.includes(CONFIG.statusRemotePath),
  );
  assert.equal(statusReads.length, 0, 'admin 都不在，别白问设备');
  assert.equal(http.stateCalls.length, 1, '失败后退避：进程内不再二探');
  const reg = c.getState().registration;
  assert.equal(reg.reg_state, 'unregistered');
  assert.equal(reg.code, 'admin_unreachable');
});

test('名额满：缓存路径补登记被拒只报错，reg_state 停在 unregistered 且不静默重试', async () => {
  const adb = scriptedAdb([
    ok(`${SERIAL}\tdevice\n`),
    ok('8896\n'),
    ok(JSON.stringify({ identity: { ok: true, device_id: 'aabbccdd11223344', public_key_b64: 'cHVia2V5' } })),
  ]);
  const http = scriptedHttp(
    [
      { status: 400, ok: false, body: JSON.stringify({ ok: false, code: 'device_slots_full', used: 8, max: 8 }) },
      httpOk({ ok: true, pong: 1 }),
      httpOk({ ok: true, pong: 2 }),
    ],
    { state: { ok: true, registry: { used: 8, max: 8, devices: [{ deviceId: 'ffffffffffffffff', regSource: 'manual', registeredAt: 1 }] }, reg: { reg_state: 'registered', last_reg_ms: 1, registration_source: 'manual' } } },
  );
  const c = makeClient({ adb, http });
  assert.equal((await c.ping()).ok, true);
  assert.equal((await c.ping()).ok, true);

  assert.equal(http.stateCalls.length, 1, '失败后退避：不静默重试');
  const registerPosts = http.calls.filter(
    (x) => x.method === 'POST' && String(x.url).includes('/devices/register'),
  );
  assert.equal(registerPosts.length, 1, '补登记只试一次');
  const reg = c.getState().registration;
  assert.equal(reg.reg_state, 'unregistered');
  assert.equal(reg.code, 'device_slots_full');
});

test('没有可用凭据时按 status.json 的 device_id 去配对，且只读一次身份', async () => {
  const fake = unusableCredential();
  const adb = scriptedAdb([
    ok(JSON.stringify({ identity: { ok: true, device_id: 'aabbccdd11223344' } })),
  ]);
  const c = makeClient({ adb, credential: fake.credential });
  const res = await c.readToken();
  assert.equal(res.ok, true);
  assert.equal(fake.state.ensured, 1);
  assert.equal(adb.calls.length, 1);
  assert.deepEqual(adb.calls[0].argv, ['-s', SERIAL, 'shell', 'cat', CONFIG.statusRemotePath]);
});

test('readToken(force) 强制重取：绕开缓存再走一次配对', async () => {
  const fake = unusableCredential({
    // 第一次是新配的（cached:false），这样「缓存」与「强制重取」才区分得开。
    async ensure() {
      fake.state.ensured += 1;
      return { ok: true, cached: false, deviceId: 'aabbccdd11223344' };
    },
  });
  const adb = scriptedAdb([
    ok(JSON.stringify({ identity: { ok: true, device_id: 'aabbccdd11223344' } })),
    ok(JSON.stringify({ identity: { ok: true, device_id: 'aabbccdd11223344' } })),
  ]);
  const c = makeClient({ adb, credential: fake.credential });
  assert.equal((await c.readToken()).cached, false);
  assert.equal((await c.readToken()).cached, true);
  assert.equal((await c.readToken(true)).cached, false);
  assert.equal(fake.state.ensured, 2);
});

test('status.json 读不到时报中文错误并说明要授「所有文件访问」', async () => {
  const fake = unusableCredential();
  const adb = scriptedAdb([fail('No such file or directory')]);
  const c = makeClient({ adb, credential: fake.credential });
  const res = await c.readToken();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'device_identity_unreadable');
  assert.match(res.error, /所有文件访问/);
});

test('status.json 里没有 identity 时报版本太旧，不当成空身份硬配', async () => {
  const fake = unusableCredential();
  const adb = scriptedAdb([ok(JSON.stringify({ ok: true, ts: 1 }))]);
  const c = makeClient({ adb, credential: fake.credential });
  const res = await c.readToken();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'device_identity_missing');
  assert.equal(c.getState().tokenLoaded, false);
  assert.equal(fake.state.ensured, 0, '没有设备身份就不该发起配对');
});

test('getState 只说凭据可用与否，绝不带出凭据材料', async () => {
  const c = makeClient({});
  await c.readToken();
  const state = c.getState();
  assert.equal(state.tokenLoaded, true);
  assert.equal(JSON.stringify(state).includes(TOKEN), false);
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'token'), false);
});

test('请求头带证书与持有证明，Authorization 恰好一个空格', async () => {
  const adb = scriptedAdb([ok(`${SERIAL}\tdevice\n`), ok('8896\n')]);
  const http = scriptedHttp([httpOk({ ok: true, pong: 5 })]);
  const c = makeClient({ adb, http });
  assert.equal((await c.ping()).ok, true);
  const headers = http.calls[0].headers;
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
  // 持有证明必须在：只有证书的话，抄走证书就等于抄走了身份。
  assert.ok(headers['X-Khy-Ts'], '缺 X-Khy-Ts');
  assert.ok(headers['X-Khy-Sig'], '缺 X-Khy-Sig');
  assert.equal(http.calls[0].url, 'http://127.0.0.1:8896/ping');
  assert.equal(http.calls[0].method, 'POST');
  // Connection/Content-Length 由默认 transport 补，见下面 createHttpTransport 的用例
});

// ── ping / status ────────────────────────────────────────────────────────────

test('ping 成功回传通道与原始 body', async () => {
  const adb = scriptedAdb([ok(`${SERIAL}\tdevice\n`), ok('8896\n'), ok(`${TOKEN}\n`)]);
  const http = scriptedHttp([httpOk('{"ok":true,"pong":1792584174808}')]);
  const c = makeClient({ adb, http });
  const res = await c.ping();
  assert.equal(res.ok, true);
  assert.equal(res.channel, 'http');
  assert.equal(res.status, 200);
  assert.match(res.body, /1792584174808/);
});

test('ping 失败按 retryCount 重试后才判负', async () => {
  const adb = scriptedAdb([ok(`${SERIAL}\tdevice\n`), ok('8896\n'), ok(`${TOKEN}\n`)]);
  const http = scriptedHttp([httpDown(), httpOk({ ok: true, pong: 9 })]);
  const sleeps = [];
  const c = makeClient({ adb, http, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } });
  const res = await c.ping();
  assert.equal(res.ok, true);
  // retryCount=1 => 首发 + 1 次重试，共 2 次
  assert.equal(http.calls.length, 2);
  assert.deepEqual(sleeps, [250]);
});

test('ping 重试耗尽后报 http_ping_failed', async () => {
  const adb = scriptedAdb([ok(`${SERIAL}\tdevice\n`), ok('8896\n'), ok(`${TOKEN}\n`)]);
  const http = scriptedHttp([httpDown('ECONNREFUSED'), httpDown('ECONNREFUSED')]);
  const c = makeClient({ adb, http, sleep: () => Promise.resolve() });
  const res = await c.ping();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'http_ping_failed');
  assert.match(res.error, /ECONNREFUSED/);
  assert.equal(c.getState().lastHttpError, 'ECONNREFUSED');
});

// ── 401 的两种可执行形态：凭据死了 vs 持有证明不对 ───────────────────────────
//
// 这一组替换掉原来的 token_mismatch 四条。区别不是措辞：凭据死了要重配，
// 持有证明不对重配**永远配不好**（时钟差、签名串不一致）。把两者混成一个
// 分支，用户会陷在「反复配对、每次都失败」里。

function httpCredentialDead(code = 'credential_expired') {
  return {
    status: 401,
    body: JSON.stringify({ ok: false, error: 'unauthorized', code }),
    ok: false,
  };
}

function httpPopRejected(code = 'pop_invalid') {
  return {
    status: 401,
    body: JSON.stringify({ ok: false, error: 'unauthorized', code }),
    ok: false,
  };
}

const DEVICE_STATUS_BODY = JSON.stringify({ identity: { ok: true, device_id: 'aabbccdd11223344' } });

test('ping 遇凭据过期：清缓存重配后重试即通，不谎报桥无响应', async () => {
  const fake = unusableCredential();
  const adb = scriptedAdb([
    ok(`${SERIAL}\tdevice\n`),
    ok('8896\n'),
    ok(DEVICE_STATUS_BODY), // 重配前先问设备它是谁
  ]);
  const http = scriptedHttp([httpCredentialDead(), httpOk({ ok: true, pong: 1 })]);
  const c = makeClient({ adb, http, credential: fake.credential, sleep: () => Promise.resolve() });
  const res = await c.ping();
  assert.equal(res.ok, true);
  assert.equal(res.channel, 'http');
  assert.equal(fake.state.invalidated, 1, '凭据死了要清缓存');
  assert.equal(fake.state.ensured, 1, '清缓存后要重新配对一次');
  assert.deepEqual(adb.calls[2].argv.slice(-2), ['cat', CONFIG.statusRemotePath]);
  assert.equal(http.calls.length, 2);
});

test('ping 重配后仍被拒：code 原样带出，不伪装成 http_ping_failed', async () => {
  const fake = unusableCredential();
  const adb = scriptedAdb([
    ok(`${SERIAL}\tdevice\n`),
    ok('8896\n'),
    ok(DEVICE_STATUS_BODY),
  ]);
  const http = scriptedHttp([httpCredentialDead(), httpCredentialDead()]);
  const c = makeClient({ adb, http, credential: fake.credential, sleep: () => Promise.resolve() });
  const res = await c.ping();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'credential_expired');
  assert.match(res.error, /重跑一次配对/);
  assert.equal(fake.state.invalidated, 1, '只重配一次，不循环');
});

test('持有证明被拒时不重配：时钟差与签名串重配解决不了', async () => {
  const fake = fakeCredential();
  const adb = scriptedAdb([ok(`${SERIAL}\tdevice\n`), ok('8896\n')]);
  const http = scriptedHttp([httpPopRejected('pop_stale')]);
  const c = makeClient({ adb, http, credential: fake.credential, sleep: () => Promise.resolve() });
  const res = await c.ping();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'pop_stale');
  assert.equal(fake.state.invalidated, 0, 'pop 类失败绝不能触发重配');
  assert.match(res.error, /时钟/);
});

test('status 遇凭据过期：重配后即通', async () => {
  const fake = unusableCredential();
  const adb = scriptedAdb([
    ok(`${SERIAL}\tdevice\n`),
    ok('8896\n'),
    ok(DEVICE_STATUS_BODY),
  ]);
  const http = scriptedHttp([
    httpCredentialDead(),
    httpOk({ ok: true, up: true, port: 8896, mode: 'app', tools: 50 }),
  ]);
  const c = makeClient({ adb, http, credential: fake.credential });
  const res = await c.status();
  assert.equal(res.ok, true);
  assert.equal(res.status.tools, 50);
});

test('call 遇凭据过期：重配后照常派发，401 意味着上一拍什么都没执行', async () => {
  const fake = unusableCredential();
  const adb = scriptedAdb([
    ok(`${SERIAL}\tdevice\n`),
    ok('8896\n'),
    ok(DEVICE_STATUS_BODY),
  ]);
  const http = scriptedHttp([
    httpCredentialDead(),
    httpOk({ ok: true, percent: 71, temp: 26.9 }),
  ]);
  const c = makeClient({ adb, http, credential: fake.credential });
  const res = await c.call('battery', {});
  assert.equal(res.success, true);
  assert.equal(res.channel, 'http');
  assert.equal(http.calls.length, 2);
});

test('call 重配后仍被拒：落到信箱兜底把这条 call 走完，不按死', async () => {
  // 信箱不走凭据。把「凭据死了」判成「桥已答复、别重试」会把一条本可以成功的
  // 命令按死——这里必须看到它落到信箱上。
  const fake = fakeCredential();
  const adb = scriptedAdb([
    ok(`${SERIAL}\tdevice\n`),
    ok('8896\n'),
    ok(DEVICE_STATUS_BODY),
    { ok: true, code: 0, stdout: '1 file pushed', stderr: '' },
    { ok: false, code: 1, stdout: '', stderr: 'missing' },
    { ok: true, code: 0, stdout: JSON.stringify({ id: 'abc123', tool: 'battery', ok: true, percent: 42 }) },
  ]);
  const http = scriptedHttp([httpCredentialDead(), httpCredentialDead()]);
  const c = makeClient({ adb, http, credential: fake.credential });
  const res = await c.call('battery', {});
  assert.equal(res.success, true);
  assert.equal(res.channel, 'mailbox');
  assert.equal(res.percent, 42);
});

test('call 重配后仍被拒且信箱关闭：code 原样带出，不伪装成桥无响应', async () => {
  const fake = unusableCredential();
  const adb = scriptedAdb([
    ok(`${SERIAL}\tdevice\n`),
    ok('8896\n'),
    ok(DEVICE_STATUS_BODY),
  ]);
  const http = scriptedHttp([httpCredentialDead('cert_invalid'), httpCredentialDead('cert_invalid')]);
  const c = makeClient({
    adb, http, credential: fake.credential, env: { KHY_PHONE_BRIDGE_MAILBOX: '0' },
  });
  const res = await c.call('battery', {});
  assert.equal(res.success, false);
  assert.equal(res.code, 'cert_invalid');
});

test('status 解析 JSON 并写入快照', async () => {
  const adb = scriptedAdb([ok(`${SERIAL}\tdevice\n`), ok('8896\n'), ok(`${TOKEN}\n`)]);
  const http = scriptedHttp([httpOk({ ok: true, up: true, port: 8896, mode: 'lite', tools: 22 })]);
  const c = makeClient({ adb, http });
  const res = await c.status();
  assert.equal(res.ok, true);
  assert.equal(res.status.tools, 22);
  assert.equal(res.status.port, 8896);
  assert.deepEqual(c.getState().lastBridgeStatus, res.status);
  assert.equal(http.calls[0].url, 'http://127.0.0.1:8896/status');
});

test('status 失败时带 code，不把空响应当成成功', async () => {
  const adb = scriptedAdb([ok(`${SERIAL}\tdevice\n`), ok('8896\n'), ok(`${TOKEN}\n`)]);
  const http = scriptedHttp([httpDown()]);
  const c = makeClient({ adb, http });
  const res = await c.status();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'http_status_failed');
});

// ── probe / revive ───────────────────────────────────────────────────────────

test('信箱 sweep 的每条 adb 命令都带 -s：多 transport 时只认这一台', async () => {
  // 实测形态（2026-11-17）：同一台手机在 adb 里以 IP 与 mDNS 两条 transport
  // 出现，信箱的裸 argv（shell ls/cat/rm）没有 -s，于是
  // "adb.exe: more than one device/emulator" —— 消费通道在双 transport 时
  // 直接不可用。信箱不经过 phoneBridgePolicy 的 argv 构建器，必须自己钉住 serial。
  const adb = scriptedAdb([ok('')]);
  const c = makeClient({ adb });
  const res = await c.mailboxSweep({ dryRun: true });
  assert.equal(res.ok, true);
  assert.deepEqual(adb.calls[0].argv, ['-s', SERIAL, 'shell', 'ls', '-1', CONFIG.mailboxDir]);
});

test('信箱 push 与 rm 同样带 -s（发起方消费自己的回执，不串台）', async () => {
  const adb = scriptedAdb([
    ok('1 file pushed'),
    ok(JSON.stringify({ id: 'abc123', tool: 'battery', ok: true, percent: 88 })),
    ok(''),
  ]);
  const c = makeClient({ adb });
  const res = await c.mailboxCall('battery', {});
  assert.equal(res.ok, true);
  assert.deepEqual(adb.calls[0].argv.slice(0, 3), ['-s', SERIAL, 'push']);
  const rmCall = adb.calls.find((call) => call.argv.includes('rm'));
  assert.ok(rmCall, '应有一条 rm');
  assert.equal(rmCall.argv[0], '-s');
  assert.equal(rmCall.argv[1], SERIAL);
});

test('serial 还是默认占位值时不给信箱硬塞 -s（不把请求发给不存在的默认地址）', async () => {
  const adb = scriptedAdb([ok('')]);
  const c = makeClient({
    adb,
    config: { ...CONFIG, serial: '192.168.2.46:33743', serialSource: 'default' },
  });
  const res = await c.mailboxSweep({ dryRun: true });
  assert.equal(res.ok, true);
  assert.deepEqual(adb.calls[0].argv[0], 'shell');
});

test('probe 走 adb shell cat status.json，不需要 HTTP 端口', async () => {
  const adb = scriptedAdb([ok(JSON.stringify({
    running: true, ts: 1792584152782, pid: 31290, http_port: 8896, mode: 'lite', canWrite: true, ver: '1.0',
  }))]);
  const http = scriptedHttp([]);
  const c = makeClient({ adb, http });
  const res = await c.probe();
  assert.equal(res.ok, true);
  assert.equal(res.channel, 'adb-shell');
  assert.equal(res.httpPortBound, true);
  assert.equal(res.canWrite, true);
  assert.equal(http.calls.length, 0);
  assert.deepEqual(adb.calls[0].argv, ['-s', SERIAL, 'shell', 'cat', CONFIG.statusRemotePath]);
});

test('probe 能区分「HTTP 端口死了」与「服务死了」', async () => {
  const adb = scriptedAdb([ok(JSON.stringify({ running: true, http_port: 0, canWrite: false }))]);
  const c = makeClient({ adb });
  const res = await c.probe();
  assert.equal(res.ok, true);
  assert.equal(res.httpPortBound, false);
  assert.equal(res.canWrite, false);
  assert.equal(res.uiAvailable, false);
});

test('probe 读到心跳即服务活着；读不到即报 probe_failed', async () => {
  const dead = scriptedAdb([fail('No such file or directory')]);
  const c = makeClient({ adb: dead });
  const res = await c.probe();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'probe_failed');
  assert.match(res.error, /桥服务可能没有在运行/);
});

test('probe 对坏 JSON 不抛，只是字段全 false', async () => {
  const adb = scriptedAdb([ok('{not json')]);
  const c = makeClient({ adb });
  const res = await c.probe();
  assert.equal(res.ok, true);
  assert.equal(res.status, null);
  assert.equal(res.httpPortBound, false);
});

// 2026-11-14 实测形态：手机没授「所有文件访问」时桥每拍写盘都 EACCES，
// status.json 停在旧快照上，而 probe 只读这一个文件。age 必须报出来，
// 否则「pc_reachable:false」「token_persisted:true」会被当成现状。
test('probe 把 status.mailbox 与 toolsCount 并进返回值（老快照缺块 → null，不替桥编）', async () => {
  const now = 1700000000000;
  const adb = scriptedAdb([ok(JSON.stringify({
    running: true, ts: now - 1000, http_port: 8896,
    tools: ['ls', 'read', 'exec'],
    mailbox: { pending: 1, processing: 2, results: 3, tmp: 0, oldest_result_age_ms: 90000000, dropped: 4 },
  }))]);
  const c = makeClient({ adb, now: () => now });
  const res = await c.probe();
  assert.equal(res.toolsCount, 3);
  assert.deepEqual(res.mailbox, {
    pending: 1, processing: 2, results: 3, tmp: 0,
    oldest_result_age_ms: 90000000, dropped: 4,
  });
  // 原样透传不动：既有读者继续按自己的形状读 status。
  assert.equal(res.status.tools.length, 3);

  const legacy = scriptedAdb([ok(JSON.stringify({ running: true, ts: now - 1000, tools: 62 }))]);
  const c2 = makeClient({ adb: legacy, now: () => now });
  const r2 = await c2.probe();
  assert.equal(r2.toolsCount, 62);
  assert.equal(r2.mailbox, null);
});
test('probe 报 status.json 年龄：保鲜与停更要分得开', async () => {
  const now = 1700000000000;
  const fresh = scriptedAdb([ok(JSON.stringify({ running: true, ts: now - 2000, http_port: 8896 }))]);
  const c1 = makeClient({ adb: fresh, now: () => now });
  const r1 = await c1.probe();
  assert.equal(r1.statusFresh, true);
  assert.equal(r1.statusAgeMs, 2000);

  const stale = scriptedAdb([ok(JSON.stringify({ running: true, ts: now - 3600000, http_port: 8896 }))]);
  const c2 = makeClient({ adb: stale, now: () => now });
  const r2 = await c2.probe();
  assert.equal(r2.ok, true);
  assert.equal(r2.statusFresh, false);
  assert.equal(r2.statusAgeMs, 3600000);

  const noTs = scriptedAdb([ok(JSON.stringify({ running: true, http_port: 8896 }))]);
  const c3 = makeClient({ adb: noTs, now: () => now });
  const r3 = await c3.probe();
  assert.equal(r3.statusAgeMs, null);
  assert.equal(r3.statusFresh, null);
});

test('doctor：status.json 停更时心跳项如实说「快照不可信」并给下一步', async () => {
  const now = 1700000000000;
  const adb = scriptedAdb([
    ok(`List of devices attached\n${SERIAL}\tdevice\n`),
    ok(`List of devices attached\n${SERIAL}\tdevice\n`),
    ok('1 file pulled\n'),
    // 一小时前的快照：running=true 是死进程写的。
    ok(JSON.stringify({ running: true, ts: now - 3600000, http_port: 8896, tools: ['ping'], token_persisted: true })),
    ok('token.txt\nstatus.json\n'),
  ]);
  const instance = createClient({
    env: {},
    config: { ...CONFIG, serialSource: 'env' },
    adbTransport: adb,
    httpTransport: scriptedHttp([httpOk({ ok: true, pong: 1 }), httpOk({ ok: true, pong: 1 })]),
    sleep: () => Promise.resolve(),
    now: () => now,
    signalFactory: () => new AbortController().signal,
  });
  const res = await instance.doctor();
  assert.equal(res.ok, true);
  const beat = res.checks.find((c) => c.name === '桥心跳');
  assert.equal(beat.ok, true);
  assert.match(beat.detail, /status.json 已 3600s 未更新/);
  assert.match(res.next.join('\n'), /status\.json 停更/);
});

test('revive 是唯一实测可行的恢复命令', async () => {
  const adb = scriptedAdb([ok('Events injected: 1\n')]);
  const c = makeClient({ adb });
  const res = await c.revive();
  assert.equal(res.ok, true);
  assert.deepEqual(adb.calls[0].argv, [
    '-s', SERIAL, 'shell', 'am', 'broadcast',
    '-a', 'com.khyos.khy_os_client.bridge.REVIVE',
    '-n', 'com.khyos.khy_os_client/com.khyos.khy_os_client.bridge.ReviveReceiver',
  ]);
  assert.match(res.message, /广播唤醒/);
});

test('revive 失败时报错', async () => {
  const adb = scriptedAdb([fail('monkey crashed')]);
  const c = makeClient({ adb });
  const res = await c.revive();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'revive_failed');
});

// ── call ─────────────────────────────────────────────────────────────────────

function happyPathAdb() {
  return scriptedAdb([
    ok(`${SERIAL}\tdevice\n`),
    ok('8896\n'),
    ok(`${TOKEN}\n`),
  ]);
}

test('只读调用直接走 HTTP，不需要 confirm', async () => {
  const adb = happyPathAdb();
  const http = scriptedHttp([httpOk({ ok: true, percent: 71, temp: 26.9 })]);
  const c = makeClient({ adb, http });
  const res = await c.call('battery', {});
  assert.equal(res.success, true);
  assert.equal(res.channel, 'http');
  assert.equal(res.tool, 'battery');
  assert.equal(res.percent, 71);
  assert.equal(http.calls[0].url, 'http://127.0.0.1:8896/call');
  const sent = JSON.parse(http.calls[0].body);
  assert.deepEqual(sent, { tool: 'battery', args: {} });
});

test('写调用无 confirm 时只回计划，一次 HTTP 都不发', async () => {
  const adb = scriptedAdb([]);
  const http = scriptedHttp([]);
  const c = makeClient({ adb, http });
  const res = await c.call('exec', { cmd: 'rm -rf /sdcard/x' });
  assert.equal(res.success, false);
  assert.equal(res.requiresConfirm, true);
  assert.equal(res.code, 'requires_confirm');
  assert.deepEqual(res.plan.args, { cmd: 'rm -rf /sdcard/x' });
  assert.equal(res.plan.bridgeName, 'exec');
  assert.match(res.message, /confirm:true/);
  assert.equal(http.calls.length, 0);
  assert.equal(adb.calls.length, 0);
});

test('confirm:true 后才真正发请求', async () => {
  const adb = happyPathAdb();
  const http = scriptedHttp([httpOk({ ok: true, exit: 0, out: 'PZ261A\n', err: '' })]);
  const c = makeClient({ adb, http });
  const res = await c.call('exec', { cmd: 'getprop ro.product.model' }, { confirm: true });
  assert.equal(res.success, true);
  assert.equal(res.out, 'PZ261A\n');
  const sent = JSON.parse(http.calls[0].body);
  assert.deepEqual(sent, { tool: 'exec', args: { cmd: 'getprop ro.product.model' } });
});

// ── v2.3.0：UI 工具准入（桥的实时 ui 字段） ────────────────────────────────

test('UI 工具在桥报告 ui=true 时放行并真实调用', async () => {
  const adb = happyPathAdb();
  const http = scriptedHttp([
    httpOk({ ok: true, up: true, port: 8896, mode: 'full', ui: true, tools: 32 }),
    httpOk({ ok: true, nodes: 42 }),
  ]);
  const c = makeClient({ adb, http });
  const res = await c.call('ui_dump', {});
  assert.equal(res.success, true);
  // 准入多打的一次 /status 是刻意成本：拿真实 ui 状态换一个诚实判定。
  assert.equal(http.calls.length, 2);
  assert.match(http.calls[0].url, /\/status$/);
  assert.equal(JSON.parse(http.calls[1].body).tool, 'ui_dump');
});

// ── 结果体的字段级上限（GUI agent 的承重墙） ────────────────────────────────

test('shot_b64 的 base64 不再被静默切成 8000 字符', async () => {
  // 实测量级：默认 maxw=480/quality=60 下 b64 是 4-7 万字符，正好压在旧默认
  // 上限的 6-9 倍。修复前每次调用都被切，模型拿到半张 JPEG 且看不到任何错误。
  const b64 = 'A'.repeat(50000);
  const http = scriptedHttp([
    httpOk({ ok: true, up: true, port: 8896, mode: 'full', ui: true, tools: 39 }),
    httpOk({ ok: true, orig_w: 1200, orig_h: 2670, w: 480, h: 1068, bytes: 38000, b64 }),
  ]);
  const c = makeClient({ adb: happyPathAdb(), http });
  const res = await c.call('shot_b64', { maxw: 480, quality: 60 });
  assert.equal(res.success, true);
  assert.equal(res.b64.length, 50000, 'base64 必须原样穿过');
  assert.equal(res.truncated, undefined, '不该报截断');
  // 几何字段照旧透传——它们小，不需要豁免。
  assert.equal(res.orig_w, 1200);
  assert.equal(res.scale, undefined);
});

test('同一个 shot_b64 调用里，超过上限的 b64 仍会被截断并报出来', async () => {
  // 豁免是放大上限，不是取消上限。超过 40 万字符依然要截，且必须置 truncated，
  // 否则「截图太大」会再次变成静默腐坏。
  const http = scriptedHttp([
    httpOk({ ok: true, up: true, port: 8896, mode: 'full', ui: true, tools: 39 }),
    httpOk({ ok: true, b64: 'A'.repeat(450000) }),
  ]);
  const c = makeClient({ adb: happyPathAdb(), http });
  const res = await c.call('shot_b64', {});
  assert.equal(res.success, true);
  assert.equal(res.truncated, true);
  assert.ok(res.b64.length < 450000);
  assert.match(res.b64, /已截断，原长度 450000 字符/);
});

test('UI 工具在桥不报告 ui 时被准入拒绝，只多一次 status 探活', async () => {
  const adb = happyPathAdb();
  const http = scriptedHttp([httpOk({ ok: true, up: true, port: 8896, mode: 'full', ui: false, tools: 32 })]);
  const c = makeClient({ adb, http });
  const res = await c.call('ui_dump', {});
  assert.equal(res.success, false);
  assert.equal(res.code, 'ui_tool_unavailable');
  assert.equal(res.requiresAccessibility, true);
  assert.equal(http.calls.length, 1);
});

test('缓存说 ui=true 时后续 UI 调用不再多打 status', async () => {
  const adb = happyPathAdb();
  const http = scriptedHttp([
    httpOk({ ok: true, up: true, port: 8896, mode: 'full', ui: true, tools: 32 }),
    httpOk({ ok: true, nodes: 1 }),
    httpOk({ ok: true, nodes: 2 }),
  ]);
  const c = makeClient({ adb, http });
  await c.status();
  assert.equal((await c.call('ui_dump', {})).success, true);
  assert.equal((await c.call('ui_dump', {})).success, true);
  assert.equal(http.calls.length, 3);
});

test('confirm 只认 true，"1"/"yes" 不放行', async () => {
  const adb = scriptedAdb([]);
  const http = scriptedHttp([]);
  const c = makeClient({ adb, http });
  for (const confirm of [1, 'true', 'yes', {}, []]) {
    const res = await c.call('exec', { cmd: 'id' }, { confirm });
    assert.equal(res.success, false, JSON.stringify(confirm));
    assert.equal(res.requiresConfirm, true);
  }
  assert.equal(http.calls.length, 0);
});

test('UI 工具被拒并说明需要无障碍，不发请求', async () => {
  const adb = scriptedAdb([]);
  const http = scriptedHttp([]);
  const c = makeClient({ adb, http });
  const res = await c.call('ui_dump', { maxw: 480 }, { confirm: true });
  assert.equal(res.success, false);
  assert.equal(res.code, 'ui_tool_unavailable');
  assert.equal(res.requiresAccessibility, true);
  assert.match(res.error, /需要无障碍权限/);
  assert.match(res.detail, /KhyAccessibilityService/);
  assert.equal(http.calls.length, 0);
});

test('参数非法在本地就被拒，不发请求', async () => {
  const adb = scriptedAdb([]);
  const http = scriptedHttp([]);
  const c = makeClient({ adb, http });
  const res = await c.call('exec', { cmd: 'id', bogus: 1 });
  assert.equal(res.success, false);
  assert.equal(res.code, 'invalid_args');
  assert.equal(http.calls.length, 0);
});

test('未知工具名被拒', async () => {
  const c = makeClient({ adb: scriptedAdb([]), http: scriptedHttp([]) });
  const res = await c.call('nope', {});
  assert.equal(res.success, false);
  assert.equal(res.code, 'unknown_tool');
});

test('HTTP 挂了自动落到信箱兜底', async () => {
  const adb = scriptedAdb([
    ok(`${SERIAL}\tdevice\n`),
    ok('8896\n'),
    // mailbox: push 成功
    { ok: true, code: 0, stdout: '1 file pushed', stderr: '' },
    // mailbox: 第一次轮询空，第二次命中
    { ok: false, code: 1, stdout: '', stderr: 'missing' },
    { ok: true, code: 0, stdout: JSON.stringify({ id: 'abc123', tool: 'battery', ok: true, percent: 42 }) },
  ]);
  const http = scriptedHttp([httpDown('ECONNREFUSED'), httpDown('ECONNREFUSED')]);
  const c = makeClient({ adb, http });
  const res = await c.call('battery', {});
  assert.equal(res.success, true);
  assert.equal(res.channel, 'mailbox');
  assert.equal(res.percent, 42);
  assert.equal(c.getState().lastChannel, 'mailbox');
  // push 的目标是信箱 cmd_ 文件（信箱现在带 -s，按子命令位置取，不按下标硬编码）
  const pushCall = adb.calls.find((call) => call.argv.includes('push'));
  assert.ok(pushCall);
  const pushAt = pushCall.argv.indexOf('push');
  assert.ok(pushCall.argv[pushAt + 2].endsWith('/sdcard/bridge-amoobridge/cmd_abc123.json'));
});

test('allowMailbox:false 时不走兜底', async () => {
  const adb = happyPathAdb();
  const http = scriptedHttp([httpDown(), httpDown()]);
  const c = makeClient({ adb, http });
  const res = await c.call('battery', {}, { allowMailbox: false });
  assert.equal(res.success, false);
  assert.equal(res.channel, 'http');
  assert.equal(res.code, 'http_call_failed');
  assert.equal(adb.calls.filter((call) => call.argv[0] === 'push').length, 0);
});

test('信箱门 KHY_PHONE_BRIDGE_MAILBOX=0 时不走兜底', async () => {
  const adb = happyPathAdb();
  const http = scriptedHttp([httpDown(), httpDown()]);
  const c = makeClient({ adb, http, env: { KHY_PHONE_BRIDGE_MAILBOX: '0' } });
  const res = await c.call('battery', {});
  assert.equal(res.success, false);
  assert.equal(res.channel, 'http');
  assert.equal(adb.calls.filter((call) => call.argv[0] === 'push').length, 0);
});

test('两条路都死时报 both_channels_failed，且两个原因都在', async () => {
  const adb = scriptedAdb([
    ok(`${SERIAL}\tdevice\n`),
    ok('8896\n'),
    ok(`${TOKEN}\n`),
    { ok: false, code: 1, stdout: '', stderr: 'push denied' },
  ]);
  const http = scriptedHttp([httpDown('ECONNREFUSED'), httpDown('ECONNREFUSED')]);
  const c = makeClient({ adb, http });
  const res = await c.call('battery', {});
  assert.equal(res.success, false);
  assert.equal(res.code, 'both_channels_failed');
  assert.match(res.error, /ECONNREFUSED/);
  assert.match(res.error, /信箱兜底也未成功/);
});

test('桥侧返回 ok:false 时不伪装成成功', async () => {
  const adb = happyPathAdb();
  const http = scriptedHttp([httpOk({ ok: false, error: 'unknown tool: ui_dump', tool: 'ui_dump' })]);
  const c = makeClient({ adb, http });
  const res = await c.call('battery', {});
  assert.equal(res.success, false);
  assert.equal(res.code, 'bridge_error');
  assert.equal(res.error, 'unknown tool: ui_dump');
});

test('桥返回非 JSON 时报 bad_json', async () => {
  const adb = happyPathAdb();
  const http = scriptedHttp([httpOk('<html>oops</html>')]);
  const c = makeClient({ adb, http });
  const res = await c.call('battery', {});
  assert.equal(res.success, false);
  assert.equal(res.code, 'bad_json');
});

test('超长结果按目录上限截断并标记 truncated', async () => {
  const adb = happyPathAdb();
  const http = scriptedHttp([httpOk({ ok: true, exit: 0, out: 'x'.repeat(50000), err: '' })]);
  const c = makeClient({ adb, http });
  const res = await c.call('exec', { cmd: 'cat /sdcard/big' }, { confirm: true });
  assert.equal(res.success, true);
  assert.equal(res.truncated, true);
  assert.equal(res.out.length <= 20040, true);
});

test('短结果不标 truncated', async () => {
  const adb = happyPathAdb();
  const http = scriptedHttp([httpOk({ ok: true, percent: 71 })]);
  const c = makeClient({ adb, http });
  const res = await c.call('battery', {});
  assert.equal(res.truncated, undefined);
});

test('别名调用解析到桥侧真名', async () => {
  const adb = happyPathAdb();
  const http = scriptedHttp([httpOk({ ok: true, out: 'uid=10212\n' })]);
  const c = makeClient({ adb, http });
  const res = await c.call('shell_exec', { cmd: 'id' }, { confirm: true });
  assert.equal(res.success, true);
  assert.equal(res.tool, 'exec');
  assert.deepEqual(JSON.parse(http.calls[0].body), { tool: 'exec', args: { cmd: 'id' } });
});

test('结果里绝不出现 token', async () => {
  const adb = happyPathAdb();
  const http = scriptedHttp([httpOk({ ok: true, percent: 71 })]);
  const c = makeClient({ adb, http });
  const res = await c.call('battery', {});
  assert.equal(JSON.stringify(res).includes(TOKEN), false);
});

test('call 会计数，状态快照有据可查', async () => {
  const adb = scriptedAdb([]);
  const c = makeClient({ adb });
  await c.call('battery');
  await c.call('nope');
  assert.equal(c.getState().totalCalls, 2);
});

// ── reset ────────────────────────────────────────────────────────────────────

test('resetForTests 清掉 token 与全部连接状态', async () => {
  const adb = scriptedAdb([ok(`${TOKEN}\n`)]);
  const c = makeClient({ adb });
  await c.readToken();
  c.resetForTests();
  const state = c.getState();
  assert.equal(state.tokenLoaded, false);
  assert.equal(state.tokenLength, 0);
  assert.equal(state.connected, false);
  assert.equal(state.forwardReady, false);
  assert.equal(state.totalCalls, 0);
  assert.equal(state.lastHttpError, null);
});

// ── default transports ───────────────────────────────────────────────────────

test('createAdbTransport 默认用 argv 数组 spawn，绝不拼 shell 串', async () => {
  const seen = [];
  const transport = client.createAdbTransport({
    adbExecutable: 'adb.exe',
    timeoutMs: 5000,
    spawn: (file, args, opts) => {
      seen.push({ file, args, opts });
      const { EventEmitter } = require('events');
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        child.stdout.emit('data', 'hello\n');
        child.emit('close', 0);
      });
      return child;
    },
    signalFactory: () => new AbortController().signal,
  });
  const res = await transport.run(['devices']);
  assert.equal(res.ok, true);
  assert.equal(res.stdout, 'hello\n');
  assert.equal(seen[0].file, 'adb.exe');
  assert.deepEqual(seen[0].args, ['devices']);
  assert.equal(typeof seen[0].args.join(' '), 'string');
});

test('createAdbTransport 把输出截到 64KB，防爆上下文', async () => {
  const transport = client.createAdbTransport({
    adbExecutable: 'adb.exe',
    spawn: () => {
      const { EventEmitter } = require('events');
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        child.stdout.emit('data', 'y'.repeat(200000));
        child.emit('close', 0);
      });
      return child;
    },
    signalFactory: () => new AbortController().signal,
  });
  const res = await transport.run(['shell', 'cat', '/sdcard/big']);
  assert.equal(res.stdout.length <= 64 * 1024 + 40, true);
  assert.match(res.stdout, /adb 输出已截断/);
});

test('createAdbTransport 默认帽要标 truncated=true（调用方靠它判断输出是否完整）', async () => {
  const transport = client.createAdbTransport({
    adbExecutable: 'adb.exe',
    spawn: () => {
      const { EventEmitter } = require('events');
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        child.stdout.emit('data', 'y'.repeat(200000));
        child.emit('close', 0);
      });
      return child;
    },
    signalFactory: () => new AbortController().signal,
  });
  const res = await transport.run(['shell', 'cat', '/sdcard/big']);
  assert.equal(res.truncated, true);
});

test('createAdbTransport maxOutputChars 可调到 512KB：200KB 的 dump 原样返回', async () => {
  // androidRef's uiautomator dump is ~276KB; the 64KB cap would slice the XML.
  const transport = client.createAdbTransport({
    adbExecutable: 'adb.exe',
    maxOutputChars: 512 * 1024,
    spawn: () => {
      const { EventEmitter } = require('events');
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        child.stdout.emit('data', 'x'.repeat(200000));
        child.emit('close', 0);
      });
      return child;
    },
    signalFactory: () => new AbortController().signal,
  });
  const res = await transport.run(['exec-out', 'uiautomator', 'dump', '/dev/tty']);
  assert.equal(res.truncated, false);
  assert.equal(res.stdout.length, 200000);
  assert.doesNotMatch(res.stdout, /adb 输出已截断/);
});

test('createAdbTransport 对 spawn 同步抛错不炸', async () => {
  const transport = client.createAdbTransport({
    adbExecutable: 'adb.exe',
    spawn: () => {
      throw new Error('ENOENT');
    },
    signalFactory: () => new AbortController().signal,
  });
  const res = await transport.run(['devices']);
  assert.equal(res.ok, false);
  assert.match(res.stderr, /ENOENT/);
});

test('createAdbTransport 对子进程 error 事件不炸', async () => {
  const transport = client.createAdbTransport({
    adbExecutable: 'adb.exe',
    spawn: () => {
      const { EventEmitter } = require('events');
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' })));
      return child;
    },
    signalFactory: () => new AbortController().signal,
  });
  const res = await transport.run(['devices']);
  assert.equal(res.ok, false);
});

test('createAdbTransport 认出 AbortError 并标 aborted', async () => {
  const transport = client.createAdbTransport({
    adbExecutable: 'adb.exe',
    spawn: () => {
      const { EventEmitter } = require('events');
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => child.emit('error', Object.assign(new Error('aborted'), { name: 'AbortError' })));
      return child;
    },
    signalFactory: () => new AbortController().signal,
  });
  const res = await transport.run(['devices']);
  assert.equal(res.aborted, true);
  assert.equal(res.ok, false);
});

test('createAdbTransport 超时兜底会 SIGTERM 掉忽略 signal 的 transport', async () => {
  const killed = [];
  const transport = client.createAdbTransport({
    adbExecutable: 'adb.exe',
    timeoutMs: 20,
    spawn: () => {
      const { EventEmitter } = require('events');
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      return child; // 永不 close，也不看 signal
    },
    safeKill: (child) => {
      killed.push(child);
      setImmediate(() => child.emit('close', null));
    },
    signalFactory: () => new AbortController().signal,
  });
  const res = await transport.run(['shell', 'sleep', '300']);
  assert.equal(res.aborted, true);
  assert.equal(killed.length, 1);
});

test('createHttpTransport 拼齐 Content-Length/Connection/Content-Type', async () => {
  const seen = [];
  const { EventEmitter } = require('events');
  const transport = client.createHttpTransport({
    request: (url, opts, cb) => {
      seen.push({ url, opts });
      const res = new EventEmitter();
      res.statusCode = 200;
      res.setEncoding = () => {};
      setImmediate(() => {
        cb(res);
        res.emit('data', '{"ok":true}');
        res.emit('end');
      });
      return { on() {}, write() {}, end() {} };
    },
    signalFactory: () => new AbortController().signal,
  });
  const res = await transport.request({
    method: 'POST',
    url: 'http://127.0.0.1:8896/call',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ tool: 'battery' }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.body, '{"ok":true}');
  assert.equal(seen[0].opts.headers['Content-Type'], 'application/json');
  assert.equal(seen[0].opts.headers.Connection, 'close');
  assert.equal(seen[0].opts.headers['Content-Length'], Buffer.byteLength(JSON.stringify({ tool: 'battery' })));
  assert.equal(seen[0].opts.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(seen[0].opts.method, 'POST');
});

test('createHttpTransport 请求出错时不炸，返回 ok:false', async () => {
  const transport = client.createHttpTransport({
    request: () => {
      const { EventEmitter } = require('events');
      const req = new EventEmitter();
      setImmediate(() => req.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:8896')));
      req.write = () => {};
      req.end = () => {};
      return req;
    },
    signalFactory: () => new AbortController().signal,
  });
  const res = await transport.request({ url: 'http://127.0.0.1:8896/ping', body: '' });
  assert.equal(res.ok, false);
  assert.match(res.error, /ECONNREFUSED/);
});

test('createHttpTransport 同步抛错时不炸', async () => {
  const transport = client.createHttpTransport({
    request: () => {
      throw new Error('bad url');
    },
    signalFactory: () => new AbortController().signal,
  });
  const res = await transport.request({ url: 'nope', body: '' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'bad url');
});

// ── probe 的令牌落盘字段（token_persisted） ──────────────────────────────────

test('probe 透出令牌落盘状态：布尔照实、缺字段判未知不判失败', async () => {
  const truthy = makeClient({
    adb: scriptedAdb([ok(JSON.stringify({ running: true, http_port: 8896, canWrite: true, ui: false, token_persisted: true }))]),
  });
  assert.equal((await truthy.probe()).tokenPersisted, true);

  const falsy = makeClient({
    adb: scriptedAdb([ok(JSON.stringify({ running: true, http_port: 8896, token_persisted: false }))]),
  });
  assert.equal((await falsy.probe()).tokenPersisted, false);

  // 旧版 APK（独立 StepBridge）的 status.json 没有这个字段 → null（未知）
  const legacy = makeClient({
    adb: scriptedAdb([ok(JSON.stringify({ running: true, http_port: 8896 }))]),
  });
  assert.equal((await legacy.probe()).tokenPersisted, null);
});

// ── probe 的助手协同（Amoo 反代）组可用性三态 ─────────────────────────────────

test('probe 透出助手协同组可用性三态：判据只来自桥自报，未知不与缺席混淆', async () => {
  const { ASSISTANT_RELAY_TOOL_NAMES } = require('./phoneBridgeCatalog');
  const relay = ASSISTANT_RELAY_TOOL_NAMES;

  // 桥把 relay 组报为 withheld（缺对应 App）→ 不可用（false），并透出 withheld 数组。
  const withheld = makeClient({
    adb: scriptedAdb([ok(JSON.stringify({ running: true, http_port: 8896, tools: ['ping', 'info'], withheld: relay }))]),
  });
  const w = await withheld.probe();
  assert.equal(w.assistantAvailable, false);
  assert.deepEqual(w.relayWithheld, relay);

  // 桥在线、withheld 里没有 relay 名 → 可用（true）。
  const available = makeClient({
    adb: scriptedAdb([ok(JSON.stringify({ running: true, http_port: 8896, tools: ['ping', ...relay], withheld: [] }))]),
  });
  assert.equal((await available.probe()).assistantAvailable, true);

  // 兜底：没有 withheld 字段，靠 tools 可用集判——全在 → true，全不在 → false。
  const toolsAll = makeClient({
    adb: scriptedAdb([ok(JSON.stringify({ running: true, http_port: 8896, tools: ['ping', ...relay] }))]),
  });
  assert.equal((await toolsAll.probe()).assistantAvailable, true);
  const toolsNone = makeClient({
    adb: scriptedAdb([ok(JSON.stringify({ running: true, http_port: 8896, tools: ['ping', 'info'] }))]),
  });
  assert.equal((await toolsNone.probe()).assistantAvailable, false);

  // 旧版桥：withheld 与 tools 数组都没有 → 未知（null），不把「没报到」说成「缺 App」。
  const legacy = makeClient({
    adb: scriptedAdb([ok(JSON.stringify({ running: true, http_port: 8896 }))]),
  });
  const leg = await legacy.probe();
  assert.equal(leg.assistantAvailable, null);
  assert.equal(leg.relayWithheld, null);
});

test('probe 在 serial 仍为空（探测无命中）时报 device_not_found，不读 status.json', async () => {
  // 空 serial 时 buildAdbArgv 不加 -s，多设备机器上 `adb shell cat` 会以 more than one
  // device 失败，而返回的「读不到 status.json：桥服务可能没有在运行」会把设备歧义误指
  // 成桥没起。所以探测无命中后提前拦一道，指名道姓说「未发现手机」。
  const adb = scriptedAdb([
    ok('List of devices attached\n'), // devices: 空
    ok('No services found.\n'),        // mdns: 空
  ]);
  const c = createClient({
    env: {},
    config: { ...CONFIG, serial: '', serialSource: 'default' },
    adbTransport: adb,
    httpTransport: scriptedHttp([]),
    sleep: () => Promise.resolve(),
    now: () => 1700000000000,
    createId: () => 'abc123',
    signalFactory: () => new AbortController().signal,
  });
  const res = await c.probe();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'device_not_found');
  assert.match(res.error, /未发现手机/);
  // 没有读 status.json。
  assert.equal(adb.calls.some((call) => call.argv.includes(CONFIG.statusRemotePath)), false);
});

// ── adb 位置：IO 层把真实探针递进 resolve，SDK 位置候选才生效 ────────────────

test('createPhoneBridgeClient 默认把 fs.existsSync 探针递进 resolve（ANDROID_HOME 命中）', () => {
  const path = require('path');
  const root = path.join('C:', 'sdkroot');
  const hit = path.join(root, 'platform-tools', bridgeConfig.ADB_EXECUTABLE_NAMES[0]);
  const instance = createClient({
    env: { ANDROID_HOME: root },
    hasExecutable: (candidate) => candidate === hit,
    adbTransport: scriptedAdb([]),
    httpTransport: scriptedHttp([]),
  });
  assert.equal(instance.config.adbExecutable, hit);
});

// ── serial 自动档：探测 → 写回 PC 配置真源 ──────────────────────────────────

test('自动档：serial 是旧默认时按 adb devices 命中唯一真机并写回', async () => {
  const env = {};
  const adb = scriptedAdb([
    ok('List of devices attached\n192.168.1.117:34103\tdevice\n'),
  ]);
  const instance = createClient({
    env,
    config: { ...CONFIG, serialSource: 'default' },
    adbTransport: adb,
    httpTransport: scriptedHttp([]),
    sleep: () => Promise.resolve(),
    now: () => 1700000000000,
    signalFactory: () => new AbortController().signal,
  });
  const res = await instance.ensureConnected();
  assert.equal(res.ok, true);
  assert.equal(instance.config.serial, '192.168.1.117:34103');
  assert.equal(env.KHY_PHONE_BRIDGE_SERIAL, '192.168.1.117:34103');
  assert.equal(instance.getState().autoSerial.serial, '192.168.1.117:34103');
  // 设备表里命中，不再多跑 connect
  assert.equal(adb.calls.length, 1);
});

test('自动档：同机双形态条目（IP 形态 + mdns 实例名）按物理身份去重，不误判多台', async () => {
  const adb = scriptedAdb([
    ok('List of devices attached\n'
      + '192.168.1.117:34103\tdevice\n'
      + 'adb-1234abcd-AbCdEf._adb-tls-connect._tcp.\tdevice\n'),
  ]);
  const instance = createClient({
    env: {},
    config: { ...CONFIG, serialSource: 'default' },
    adbTransport: adb,
    httpTransport: scriptedHttp([]),
    sleep: () => Promise.resolve(),
    now: () => 1700000000000,
    signalFactory: () => new AbortController().signal,
  });
  const res = await instance.ensureConnected();
  assert.equal(res.ok, true);
  assert.equal(instance.config.serial, '192.168.1.117:34103');
  assert.equal(adb.calls.length, 1);
});

test('自动档：多台真机不猜，沿用旧默认走 connect 并如实报错', async () => {
  const adb = scriptedAdb([
    ok('List of devices attached\n'
      + '192.168.1.117:34103\tdevice\n'
      + '192.168.1.118:40001\tdevice\n'),
    ok('connected to 192.168.2.46:33743'),
  ]);
  const instance = createClient({
    env: {},
    config: { ...CONFIG, serialSource: 'default' },
    adbTransport: adb,
    httpTransport: scriptedHttp([]),
    sleep: () => Promise.resolve(),
    now: () => 1700000000000,
    signalFactory: () => new AbortController().signal,
  });
  await instance.ensureConnected();
  // 没写回：serial 还是旧默认
  assert.equal(instance.config.serial, SERIAL);
  // 多候选不解歧义，直接走 connect（argv 带 -s）
  assert.equal(adb.calls.length, 2);
  assert.equal(adb.calls[1].argv[0], '-s');
  assert.equal(adb.calls[1].argv[1], SERIAL);
});

test('自动档：设备表没有 device 态条目时走 mdns 兜底，命中后 connect 的是新 serial', async () => {
  const adopted = '192.168.1.117:34103';
  const adb = scriptedAdb([
    ok('List of devices attached\n'),
    // 服务名这一列**不带尾点**——这是真机 `adb mdns services` 的原样输出
    // （2026-11-18 实测）。旧实现按带尾点匹配，这条兜底档于是从来没解析出
    // 任何东西：手机重连后 adb 忘了旧 transport，自动发现的两条路同时失效。
    ok('adb-1234abcd-AbCdEf._adb-tls-connect._tcp\t192.168.1.117:34103\n'
      + 'adb-1234abcd-AbCdEf._adb-tls-pairing._tcp\t192.168.1.117:40001\n'),
    ok(`connected to ${adopted}`),
  ]);
  const instance = createClient({
    env: {},
    config: { ...CONFIG, serialSource: 'default' },
    adbTransport: adb,
    httpTransport: scriptedHttp([]),
    sleep: () => Promise.resolve(),
    now: () => 1700000000000,
    signalFactory: () => new AbortController().signal,
  });
  const res = await instance.ensureConnected();
  assert.equal(res.ok, true);
  assert.equal(instance.config.serial, adopted);
  // 第 2 步是 mdns services（不带 -s），第 3 步 connect 的是采纳的 serial
  assert.equal(adb.calls[1].argv[0], 'mdns');
  assert.deepEqual(adb.calls[2].argv.slice(0, 3), ['-s', adopted, 'connect']);
  assert.equal(adb.calls[2].argv[3], adopted);
});

test('自动档：env 显式指定 serial 时一步都不探测', async () => {
  const adb = scriptedAdb([ok('List of devices attached\n')]);
  const instance = createClient({
    env: { KHY_PHONE_BRIDGE_SERIAL: SERIAL },
    config: { ...CONFIG, serialSource: 'env' },
    adbTransport: adb,
    httpTransport: scriptedHttp([]),
    sleep: () => Promise.resolve(),
    now: () => 1700000000000,
    signalFactory: () => new AbortController().signal,
  });
  await instance.ensureConnected();
  assert.equal(instance.getState().autoSerial, null);
  // 只有 devices 与 connect 两次 adb，没有 mdns
  assert.equal(adb.calls.length, 2);
  assert.equal(adb.calls.filter((c) => c.argv[0] === 'mdns').length, 0);
});

// ── 拉取（设备文件 → 主机文件）──────────────────────────────────────────────

test('pullFile：先问体积再拉，超限就拒并说清多大', async () => {
  const adb = scriptedAdb([
    ok('List of devices attached\n'),
    ok(`connected to ${SERIAL}`),
    ok('524288000 /sdcard/DCIM/large.mp4\n'),
  ]);
  const instance = createClient({
    env: {},
    config: { ...CONFIG, serialSource: 'env' },
    adbTransport: adb,
    httpTransport: scriptedHttp([]),
    sleep: () => Promise.resolve(),
    now: () => 1700000000000,
    signalFactory: () => new AbortController().signal,
  });
  const res = await instance.pullFile({
    remotePath: '/sdcard/DCIM/large.mp4',
    localPath: 'out/large.mp4',
    maxBytes: 1024 * 1024,
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'too_large');
  assert.match(res.error, /500\.0 MB/);
  assert.match(res.error, /1 MB/);
  // 超限就不该真的去拉
  assert.equal(adb.calls.filter((c) => c.argv.includes('pull')).length, 0);
});

test('pullFile：体积合格才拉，argv 带 -s 与两端路径', async () => {
  const adb = scriptedAdb([
    ok('List of devices attached\n'),
    ok(`connected to ${SERIAL}`),
    ok('2048 /sdcard/Download/a.json\n'),
    ok('1 file pulled\n'),
  ]);
  const instance = createClient({
    env: {},
    config: { ...CONFIG, serialSource: 'env' },
    adbTransport: adb,
    httpTransport: scriptedHttp([]),
    sleep: () => Promise.resolve(),
    now: () => 1700000000000,
    signalFactory: () => new AbortController().signal,
  });
  const res = await instance.pullFile({
    remotePath: '/sdcard/Download/a.json',
    localPath: 'out/a.json',
  });
  assert.equal(res.ok, true);
  assert.equal(res.bytes, 2048);
  const pull = adb.calls.find((c) => c.argv.includes('pull'));
  assert.ok(pull, '应有 pull 调用');
  assert.deepEqual(pull.argv.slice(-2), ['/sdcard/Download/a.json', 'out/a.json']);
  assert.equal(pull.argv[0], '-s');
});

test('pullFile：设备路径不是绝对路径时直接拒，不碰 adb', async () => {
  const adb = scriptedAdb([]);
  const instance = createClient({
    env: {},
    config: { ...CONFIG, serialSource: 'env' },
    adbTransport: adb,
    httpTransport: scriptedHttp([]),
    sleep: () => Promise.resolve(),
    now: () => 1700000000000,
    signalFactory: () => new AbortController().signal,
  });
  const res = await instance.pullFile({ remotePath: 'relative/a.jpg', localPath: 'out/a.jpg' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'invalid_path');
  assert.equal(adb.calls.length, 0);
});

test('collectFiles：枚举 → 按类型筛 → 逐个拉 → 落清单，跳过的也写进清单', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const localDir = path.join(os.tmpdir(), `khy-collect-${process.pid}`);
  const adb = scriptedAdb([
    ok('List of devices attached\n'),
    ok(`connected to ${SERIAL}`),
    ok('/sdcard/DCIM/a.jpg\n/sdcard/DCIM/b.mp4\n/sdcard/DCIM/notes.txt\n'),
    // stat -c '%s %Y'：大小 + 修改时间（秒）
    ok('1024 1699999999\n'),
    ok('1 file pulled\n'),
  ]);
  const instance = createClient({
    env: {},
    config: { ...CONFIG, serialSource: 'env' },
    adbTransport: adb,
    httpTransport: scriptedHttp([]),
    sleep: () => Promise.resolve(),
    now: () => 1700000000000,
    signalFactory: () => new AbortController().signal,
  });
  const res = await instance.collectFiles({
    remoteDir: '/sdcard/DCIM',
    localDir,
    types: ['image'],
  });
  assert.equal(res.ok, true);
  // 只要了 image：mp4 与 txt 不该被拉
  assert.deepEqual(res.manifest.files.map((f) => f.type), ['image']);
  assert.equal(res.manifest.files[0].remotePath, '/sdcard/DCIM/a.jpg');
  assert.equal(res.manifest.files[0].bytes, 1024);
  assert.equal(res.manifest.files[0].mtimeMs, 1699999999000);
  // 清单落盘，且带上跳过的条目
  const manifestPath = path.join(localDir, 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'manifest.json 应落盘');
  const onDisk = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(onDisk.schema, 'khy-phone-collect/1');
  assert.deepEqual(onDisk.skipped.map((s) => s.reason), ['type-not-requested', 'type-not-requested']);
  fs.rmSync(localDir, { recursive: true, force: true });
});

test('collectFiles：时间窗外的文件不进清单，并记明原因', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const localDir = path.join(os.tmpdir(), `khy-collect-since-${process.pid}`);
  const now = 1700000000000;
  const old = Math.floor((now - 30 * 86400000) / 1000);
  const fresh = Math.floor((now - 3600000) / 1000);
  const adb = scriptedAdb([
    ok('List of devices attached\n'),
    ok(`connected to ${SERIAL}`),
    ok('/sdcard/DCIM/old.jpg\n/sdcard/DCIM/new.jpg\n'),
    ok(`1024 ${old}\n`),
    ok(`2048 ${fresh}\n`),
    ok('1 file pulled\n'),
  ]);
  const instance = createClient({
    env: {},
    config: { ...CONFIG, serialSource: 'env' },
    adbTransport: adb,
    httpTransport: scriptedHttp([]),
    sleep: () => Promise.resolve(),
    now: () => now,
    signalFactory: () => new AbortController().signal,
  });
  const res = await instance.collectFiles({
    remoteDir: '/sdcard/DCIM',
    localDir,
    types: ['image'],
    sinceMs: now - 7 * 86400000,
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.manifest.files.map((f) => f.remotePath), ['/sdcard/DCIM/new.jpg']);
  assert.deepEqual(res.manifest.skipped.map((s) => s.reason), ['older-than-window']);
  assert.equal(res.manifest.sinceMs, now - 7 * 86400000);
  fs.rmSync(localDir, { recursive: true, force: true });
});

test('scanFiles：只枚举不下载，并按类型与时间窗筛', async () => {
  const now = 1700000000000;
  const old = Math.floor((now - 30 * 86400000) / 1000);
  const fresh = Math.floor((now - 3600000) / 1000);
  const adb = scriptedAdb([
    ok('List of devices attached\n'),
    ok(`connected to ${SERIAL}`),
    ok('/sdcard/DCIM/new.jpg\n/sdcard/DCIM/old.jpg\n/sdcard/DCIM/clip.mp4\n'),
    ok(`2048 ${fresh}\n`),
    ok(`4096 ${old}\n`),
  ]);
  const instance = createClient({
    env: {},
    config: { ...CONFIG, serialSource: 'env' },
    adbTransport: adb,
    httpTransport: scriptedHttp([]),
    sleep: () => Promise.resolve(),
    now: () => now,
    signalFactory: () => new AbortController().signal,
  });
  const res = await instance.scanFiles({
    remoteDir: '/sdcard/DCIM',
    types: ['image'],
    sinceMs: now - 7 * 86400000,
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.entries.map((e) => e.remotePath), ['/sdcard/DCIM/new.jpg']);
  assert.equal(res.entries[0].bytes, 2048);
  assert.deepEqual(res.counts, { image: 1 });
  // 只列清单：不该发生任何 pull
  assert.equal(adb.calls.filter((c) => c.argv.includes('pull')).length, 0);
  // 没点名的时间窗丢弃项也要有说法
  assert.deepEqual(res.skipped.map((s) => s.reason), ['type-not-requested', 'older-than-window']);
});

test('collectFiles：落盘保留相对路径，不同目录的同名文件不互相覆盖', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const localDir = path.join(os.tmpdir(), `khy-collect-rel-${process.pid}`);
  const adb = scriptedAdb([
    ok('List of devices attached\n'),
    ok(`connected to ${SERIAL}`),
    ok('/sdcard/DCIM/Camera/a.jpg\n/sdcard/DCIM/Backup/a.jpg\n'),
    ok('1024 1699999999\n'),
    ok('2048 1699999999\n'),
    ok('1 file pulled\n'),
    ok('1 file pulled\n'),
  ]);
  const instance = createClient({
    env: {},
    config: { ...CONFIG, serialSource: 'env' },
    adbTransport: adb,
    httpTransport: scriptedHttp([]),
    sleep: () => Promise.resolve(),
    now: () => 1700000000000,
    signalFactory: () => new AbortController().signal,
  });
  const res = await instance.collectFiles({
    remoteDir: '/sdcard/DCIM',
    localDir,
    types: ['image'],
  });
  assert.equal(res.ok, true);
  const locals = res.manifest.files.map((f) => f.localPath);
  assert.equal(locals.length, 2);
  assert.equal(new Set(locals).size, 2, '同名文件必须落到不同路径');
  assert.ok(locals.some((p) => p.includes('Camera')), '应保留 Camera 子目录');
  assert.ok(locals.some((p) => p.includes('Backup')), '应保留 Backup 子目录');
  fs.rmSync(localDir, { recursive: true, force: true });
});

test('pushFile：先建设备侧目录再推，argv 带 -s 与两端路径', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const localPath = path.join(os.tmpdir(), `khy-push-${process.pid}.txt`);
  fs.writeFileSync(localPath, 'hello', 'utf8');
  const adb = scriptedAdb([
    ok('List of devices attached\n'),
    ok(`connected to ${SERIAL}`),
    ok(''),
    ok('1 file pushed\n'),
  ]);
  const instance = createClient({
    env: {},
    config: { ...CONFIG, serialSource: 'env' },
    adbTransport: adb,
    httpTransport: scriptedHttp([]),
    sleep: () => Promise.resolve(),
    now: () => 1700000000000,
    signalFactory: () => new AbortController().signal,
  });
  const res = await instance.pushFile({
    localPath,
    remotePath: '/sdcard/Download/hello.txt',
  });
  assert.equal(res.ok, true);
  assert.equal(res.bytes, 5);
  const mkdir = adb.calls.find((c) => c.argv.includes('mkdir'));
  assert.ok(mkdir, '应先建设备侧目录');
  assert.equal(mkdir.argv[mkdir.argv.length - 1], '/sdcard/Download');
  const push = adb.calls.find((c) => c.argv.includes('push'));
  assert.ok(push, '应有 push 调用');
  assert.deepEqual(push.argv.slice(-2), [localPath, '/sdcard/Download/hello.txt']);
  fs.rmSync(localPath, { force: true });
});

test('pushFile：主机文件不存在或超限时直接拒，不碰设备', async () => {
  const adb = scriptedAdb([]);
  const instance = createClient({
    env: {},
    config: { ...CONFIG, serialSource: 'env' },
    adbTransport: adb,
    httpTransport: scriptedHttp([]),
    sleep: () => Promise.resolve(),
    now: () => 1700000000000,
    signalFactory: () => new AbortController().signal,
  });
  const missing = await instance.pushFile({
    localPath: 'no/such/file.txt',
    remotePath: '/sdcard/Download/file.txt',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'local_file_missing');
  const relative = await instance.pushFile({
    localPath: 'x.txt',
    remotePath: 'relative/path.txt',
  });
  assert.equal(relative.ok, false);
  assert.equal(relative.code, 'invalid_path');
  assert.equal(adb.calls.length, 0);
});

test('doctor：设备与桥都就绪时判定可用并给出逐项结论', async () => {
  const adb = scriptedAdb([
    ok(`List of devices attached\n${SERIAL}\tdevice\n`),
    ok(`List of devices attached\n${SERIAL}\tdevice\n`),
    ok('1 file pulled\n'),
    ok(JSON.stringify({
      running: true,
      http_port: 8896,
      tools: ['ping', 'exec'],
      // 断点二之后这两条才是「就绪」的判据：私钥在私有目录、明文令牌已退役。
      token_persisted: false,
      token_retired: true,
      identity: {
        ok: true,
        device_id: 'aabbccdd11223344',
        key_path: '/data/user/0/com.khyos.khy_os_client/files/amoo_key.pem',
        key_private_location: true,
      },
    })),
    ok('status.json\n'),
  ]);
  const instance = createClient({
    env: {},
    config: { ...CONFIG, serialSource: 'env' },
    adbTransport: adb,
    httpTransport: scriptedHttp([httpOk({ ok: true, pong: 1 }), httpOk({ ok: true, pong: 1 })]),
    sleep: () => Promise.resolve(),
    now: () => 1700000000000,
    signalFactory: () => new AbortController().signal,
  });
  const res = await instance.doctor();
  assert.equal(res.ok, true);
  assert.equal(res.ready, true);
  const names = res.checks.map((c) => c.name);
  assert.deepEqual(names, [
    'adb 可执行文件', '设备在场', 'HTTP 通道', '串号已解析', '桥心跳',
    '设备身份（私钥在私有目录）', '本机凭据（设备签发的证书）', '采集通道',
  ]);
  assert.equal(res.checks.every((c) => c.ok), true);
  assert.deepEqual(res.next, []);
  // 就绪不再取决于「有没有一个落盘的共享秘密」——那条路已经拆了。
  assert.equal(names.includes('令牌已落盘'), false);
});

test('doctor：设备不在场时判定不可用，并给出下一步', async () => {
  const adb = scriptedAdb([
    ok('List of devices attached\n'),
  ]);
  const instance = createClient({
    env: {},
    config: { ...CONFIG, serialSource: 'env' },
    adbTransport: adb,
    httpTransport: scriptedHttp([]),
    sleep: () => Promise.resolve(),
    now: () => 1700000000000,
    signalFactory: () => new AbortController().signal,
  });
  const res = await instance.doctor();
  assert.equal(res.ok, true);
  assert.equal(res.ready, false);
  assert.equal(res.checks.find((c) => c.name === '设备在场').ok, false);
  assert.ok(res.next.length > 0, '应给出下一步');
  assert.match(res.next.join('\n'), /手机没连上/);
});

test('scanFiles：find 必须带 -s，否则两台 transport 时 adb 报 more than one device', async () => {
  const adb = scriptedAdb([
    ok(`List of devices attached\n${SERIAL}\tdevice\n`),
    ok(`List of devices attached\n${SERIAL}\tdevice\n`),
    ok(''),
  ]);
  const instance = createClient({
    env: {},
    config: { ...CONFIG, serialSource: 'env' },
    adbTransport: adb,
    httpTransport: scriptedHttp([]),
    sleep: () => Promise.resolve(),
    now: () => 1700000000000,
    signalFactory: () => new AbortController().signal,
  });
  await instance.scanFiles({ remoteDir: '/sdcard/DCIM', types: ['image'] });
  const find = adb.calls.find((c) => c.argv.includes('find'));
  assert.ok(find, '应有 find 调用');
  assert.deepEqual(find.argv.slice(0, 3), ['-s', SERIAL, 'shell']);
  assert.ok(find.argv.includes('-type'));
});

test('collectFiles：多根目录按类型分桶落盘，设备上没有的根目录记一笔继续', async () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const localDir = path.join(os.tmpdir(), `khy-collect-multi-${process.pid}`);
  const adb = scriptedAdb([
    ok(`List of devices attached\n${SERIAL}\tdevice\n`),
    ok('/sdcard/DCIM/a.jpg\n'),
    ok('1024 1699999999\n'),
    ok('/sdcard/Music/b.mp3\n'),
    ok('2048 1699999999\n'),
    fail('find: /sdcard/Nope: No such file or directory'),
    ok('1 file pulled\n'),
    ok('1 file pulled\n'),
  ]);
  const instance = createClient({
    env: {},
    config: { ...CONFIG, serialSource: 'env' },
    adbTransport: adb,
    httpTransport: scriptedHttp([]),
    sleep: () => Promise.resolve(),
    now: () => 1700000000000,
    signalFactory: () => new AbortController().signal,
  });
  const res = await instance.collectFiles({
    remoteDirs: ['/sdcard/DCIM', '/sdcard/Music', '/sdcard/Nope'],
    localDir,
    bucketByType: true,
    includeUnknown: true,
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.manifest.counts, { image: 1, audio: 1 });
  const locals = res.manifest.files.map((f) => f.localPath);
  assert.equal(locals.length, 2);
  // 按类型分桶，桶内再按根目录与相对路径
  assert.ok(locals.some((l) => l.includes(path.join('image', 'DCIM', 'a.jpg'))), locals.join('|'));
  assert.ok(locals.some((l) => l.includes(path.join('audio', 'Music', 'b.mp3'))), locals.join('|'));
  // 设备上没有的根目录：记一笔，不让整次采集失败
  assert.deepEqual(
    res.manifest.skipped.filter((x) => x.reason === 'root_unavailable').map((x) => x.root),
    ['/sdcard/Nope']
  );
  fs.rmSync(localDir, { recursive: true, force: true });
});

// 还原 spawn，避免污染同进程内的其它套件
test('收尾：还原 child_process.spawn', () => {
  childProcess.spawn = REAL_SPAWN;
  assert.equal(typeof childProcess.spawn, 'function');
});

// ── 配对（pair）───────────────────────────────────────────────────────────────
// 这条命令以前只存在于错误文案里（「先配对：khy phone pair」），而命令本身
// 并不存在——提示指向一条不存在的命令，等于把人引到死路。

const IDENTITY_STATUS = JSON.stringify({
  running: true,
  http_port: 8896,
  tools: ['ping'],
  identity: {
    ok: true,
    device_id: 'aabbccdd11223344',
    key_path: '/data/user/0/com.khyos.khy_os_client/files/amoo_key.pem',
    key_private_location: true,
  },
});

test('pair：先建转发再换证书，凭据拿到 device_id', async () => {
  const adb = scriptedAdb([
    ok(`List of devices attached\n${SERIAL}\tdevice\n`),
    ok('8896\n'),
    ok(IDENTITY_STATUS),
  ]);
  let ensured = null;
  const credential = {
    ensure: async (opts) => {
      ensured = opts;
      return { ok: true, paired: true, deviceId: opts.deviceId };
    },
    describe: () => ({ paired: true, deviceId: 'aabbccdd11223344', expiresInMs: 3600000 }),
    signedHeaders: () => ({ ok: true, headers: {} }),
    invalidate: () => {},
  };
  const instance = createClient({
    env: {},
    config: { ...CONFIG, serialSource: 'env' },
    adbTransport: adb,
    httpTransport: scriptedHttp([]),
    credential,
    sleep: () => Promise.resolve(),
    now: () => 1700000000000,
    signalFactory: () => new AbortController().signal,
  });
  const res = await instance.pair();
  assert.equal(res.ok, true);
  assert.equal(res.paired, true);
  assert.equal(res.deviceId, 'aabbccdd11223344');
  assert.equal(ensured.deviceId, 'aabbccdd11223344');
  // 转发必须在换证书之前建好——凭据层走的是 127.0.0.1:8896。
  assert.equal(adbSub(adb.calls[1].argv), 'forward');
});

test('pair：凭据层拒绝时如实把 code 带出来（配对码缺失要说清在哪看）', async () => {
  const adb = scriptedAdb([
    ok(`List of devices attached\n${SERIAL}\tdevice\n`),
    ok('8896\n'),
    ok(IDENTITY_STATUS),
  ]);
  const credential = {
    ensure: async () => ({
      ok: false,
      code: 'pairing_code_missing',
      error: '配对码没拿到：它只显示在手机通知栏（不回传，这是刻意的）。',
    }),
    describe: () => ({ paired: false }),
    signedHeaders: () => ({ ok: true, headers: {} }),
    invalidate: () => {},
  };
  const instance = createClient({
    env: {},
    config: { ...CONFIG, serialSource: 'env' },
    adbTransport: adb,
    httpTransport: scriptedHttp([]),
    credential,
    sleep: () => Promise.resolve(),
    now: () => 1700000000000,
    signalFactory: () => new AbortController().signal,
  });
  const res = await instance.pair();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'pairing_code_missing');
  assert.match(res.error, /通知栏/);
});

// ── 出向链路登记（S0：本地有密钥但服务端不认识 → 自动重登记）────────────────
// 「出向链路登记面」走的是本机 127.0.0.1 的 admin HTTP（deviceLinkWss），不是
// adb，也不是设备桥。httpTransport 恰好就是发起这类 loopback 请求的现成出口。

function adminRegisterOk(deviceId) {
  return {
    status: 200,
    ok: true,
    body: JSON.stringify({ ok: true, deviceId, alreadyEnrolled: false, regSource: 'auto', registeredAt: 1700000000000 }),
  };
}

test('pair：身份读到后自动向本机出向链路登记一次，结论并进返回值', async () => {
  const adb = scriptedAdb([
    ok(`List of devices attached\n${SERIAL}\tdevice\n`),
    ok('8896\n'),
    ok(JSON.stringify({
      running: true,
      http_port: 8896,
      tools: ['ping'],
      identity: {
        ok: true,
        device_id: 'aabbccdd11223344',
        public_key_b64: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEcHVia2V5',
        key_private_location: true,
      },
    })),
  ]);
  const http = scriptedHttp([adminRegisterOk('aabbccdd11223344')]);
  const credential = {
    ensure: async (opts) => ({ ok: true, paired: true, deviceId: opts.deviceId }),
    describe: () => ({ paired: true, deviceId: 'aabbccdd11223344', expiresInMs: 3600000 }),
    signedHeaders: () => ({ ok: true, headers: {} }),
    invalidate: () => {},
  };
  const instance = createClient({
    env: {},
    config: { ...CONFIG, serialSource: 'env' },
    adbTransport: adb,
    httpTransport: http,
    credential,
    sleep: () => Promise.resolve(),
    now: () => 1700000000000,
    signalFactory: () => new AbortController().signal,
  });
  const res = await instance.pair();
  assert.equal(res.ok, true);
  assert.equal(res.paired, true);
  // 登记请求：POST 到 admin 口的 /devices/register，带身份三件套
  assert.equal(http.calls.length, 1, `应恰好一次登记调用，实际 ${http.calls.length}`);
  const call = http.calls[0];
  assert.equal(call.method, 'POST');
  assert.match(String(call.url), /127\.0\.0\.1:\d+\/devices\/register$/);
  const sent = JSON.parse(call.body);
  assert.equal(sent.deviceId, 'aabbccdd11223344');
  assert.equal(sent.userId, 'local');
  assert.equal(sent.platform, 'android');
  assert.ok(sent.publicKey && sent.publicKey.length > 0, '登记帧必须带公钥');
  // 结论并进返回值（不覆盖既有字段）
  assert.equal(res.enroll.ok, true);
  assert.equal(res.enroll.alreadyEnrolled, false);
  assert.equal(res.enroll.deviceId, 'aabbccdd11223344');
});

test('readToken（无凭据路径）：登记失败不判配对失败，code=slots_full 带出结论', async () => {
  const adb = scriptedAdb([
    ok(JSON.stringify({ identity: { ok: true, device_id: 'aabbccdd11223344', public_key_b64: 'cHVia2V5' } })),
  ]);
  const http = scriptedHttp([{
    status: 400,
    ok: false,
    body: JSON.stringify({ ok: false, code: 'device_slots_full', used: 8, max: 8 }),
  }]);
  const fake = unusableCredential();
  const c = makeClient({ adb, http, credential: fake.credential });
  const res = await c.readToken();
  // fail-soft：出向链路登记失败≠配对失败。凭据层说了 ok，入口就 ok。
  assert.equal(res.ok, true);
  assert.equal(res.enroll.ok, false);
  assert.equal(res.enroll.code, 'device_slots_full');
  assert.equal(res.enroll.used, 8);
  assert.equal(res.enroll.max, 8);
});

test('readToken：admin 服务不在时登记收敛为 admin_unreachable，不判失败不重试', async () => {
  const adb = scriptedAdb([
    ok(JSON.stringify({ identity: { ok: true, device_id: 'aabbccdd11223344', public_key_b64: 'cHVia2V5' } })),
  ]);
  const http = scriptedHttp([httpDown('connect ECONNREFUSED 127.0.0.1:8793')]);
  const fake = unusableCredential();
  const c = makeClient({ adb, http, credential: fake.credential });
  const res = await c.readToken();
  assert.equal(res.ok, true);
  assert.equal(res.enroll.ok, false);
  assert.equal(res.enroll.code, 'admin_unreachable');
  assert.equal(http.calls.length, 1, 'admin 不在就别再打第二轮');
});

test('readToken：同 deviceId 只登记一次，进程内不重复打 admin', async () => {
  const adb = scriptedAdb([
    ok(JSON.stringify({ identity: { ok: true, device_id: 'aabbccdd11223344', public_key_b64: 'cHVia2V5' } })),
    ok(JSON.stringify({ identity: { ok: true, device_id: 'aabbccdd11223344', public_key_b64: 'cHVia2V5' } })),
  ]);
  const http = scriptedHttp([adminRegisterOk('aabbccdd11223344')]);
  const fake = unusableCredential();
  const c = makeClient({ adb, http, credential: fake.credential });
  const first = await c.readToken();
  const second = await c.readToken(true);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(http.calls.length, 1, '同 id 只登记一次');
  assert.equal(first.enroll.alreadyEnrolled, false);
  // 第二次没有复打 admin，结论取自进程内缓存：deduped=true，服务端原话
  // （alreadyEnrolled=false，即这台设备是本次自动登记进来的）保持不变。
  assert.equal(second.enroll.deduped, true);
  assert.equal(second.enroll.alreadyEnrolled, false);
});

test('status：登记结论落进 getState（reg_state / last_reg_ms / registration_source）', async () => {
  const adb = scriptedAdb([
    ok(JSON.stringify({ identity: { ok: true, device_id: 'aabbccdd11223344', public_key_b64: 'cHVia2V5' } })),
  ]);
  const http = scriptedHttp([adminRegisterOk('aabbccdd11223344')]);
  const fake = unusableCredential();
  const c = makeClient({ adb, http, credential: fake.credential });
  await c.readToken();
  const reg = c.getState().registration;
  assert.equal(reg.reg_state, 're_registered');
  assert.equal(reg.last_reg_ms, 1700000000000);
  assert.equal(reg.registration_source, 'auto');
  assert.equal(reg.deviceId, 'aabbccdd11223344');
  assert.equal(reg.code, null);
});

test('status：登记被拒时 reg_state=unregistered 且带 code，不伪造已登记', async () => {
  const adb = scriptedAdb([
    ok(JSON.stringify({ identity: { ok: true, device_id: 'aabbccdd11223344', public_key_b64: 'cHVia2V5' } })),
  ]);
  const http = scriptedHttp([{
    status: 400,
    ok: false,
    body: JSON.stringify({ ok: false, code: 'device_slots_full', used: 3, max: 3 }),
  }]);
  const fake = unusableCredential();
  const c = makeClient({ adb, http, credential: fake.credential });
  await c.readToken();
  const reg = c.getState().registration;
  assert.equal(reg.reg_state, 'unregistered');
  assert.equal(reg.code, 'device_slots_full');
  assert.equal(reg.last_reg_ms, null);
});

// ── mDNS 多端口：逐个试连，不猜死端口 ────────────────────────────────────────
// 2026-11-18 实测：同一条手机同时广播两个端口，36973 已经失效（拒绝连接），
// 42359 是活的。按字符串序取第一个会挑中死端口——用户看到的症状是「自动发现
// 找不到手机」，只好手输地址。

test('自动档：mdns 广播两个端口时逐个试连，取第一个真连上的', async () => {
  const DEAD = '192.168.2.46:36973';
  const LIVE = '192.168.2.46:42359';
  const adb = scriptedAdb([
    ok(`List of devices attached\n`),                 // devices：空 → 走 mdns 兜底
    ok(`adb-ZYPZ261A01M6870010L\t_adb-tls-connect._tcp\t${DEAD}\n` // mdns 两个实例在同一次响应里
       + `adb-ZYPZ261A01M6870010L (2)\t_adb-tls-connect._tcp\t${LIVE}\n`),
    fail(`cannot connect to ${DEAD}`),                   // 第一个是死的
    ok(`connected to ${LIVE}`),                          // 第二个是活的
  ]);
  const instance = createClient({
    env: {},
    config: { ...CONFIG, serial: '', serialSource: 'default' },
    adbTransport: adb,
    httpTransport: scriptedHttp([]),
    sleep: () => Promise.resolve(),
    now: () => 1700000000000,
    signalFactory: () => new AbortController().signal,
  });
  await instance.detectSerial();
  const state = instance.getState();
  assert.equal(state.autoSerial.serial, LIVE, '应挑到真能连上的那个端口');
  assert.equal(state.autoSerial.source, 'adb-mdns-same-host');
});

test('自动档：mdns 的端口全都连不上时，如实用第一个候选（不假装成功）', async () => {
  const adb = scriptedAdb([
    ok('List of devices attached\n'),
    ok('adb-ZYPZ261A01M6870010L\t_adb-tls-connect._tcp\t192.168.2.46:36973\n'
       + 'adb-ZYPZ261A01M6870010L (2)\t_adb-tls-connect._tcp\t192.168.2.46:42359\n'),
    fail('cannot connect to 192.168.2.46:36973'),
    fail('cannot connect to 192.168.2.46:42359'),
  ]);
  const instance = createClient({
    env: {},
    config: { ...CONFIG, serial: '', serialSource: 'default' },
    adbTransport: adb,
    httpTransport: scriptedHttp([]),
    sleep: () => Promise.resolve(),
    now: () => 1700000000000,
    signalFactory: () => new AbortController().signal,
  });
  await instance.detectSerial();
  const state = instance.getState();
  // 一个都连不上：仍写回第一个候选，让随后的 connect 报出「连不上 <地址>」
  assert.equal(state.autoSerial.serial, '192.168.2.46:36973');
  assert.equal(state.autoSerial.source, 'adb-mdns-same-host');
});

// ── mDNS 解析：对着真机原样输出 ───────────────────────────────────────────────
// 2026-11-18 实测真机 `adb mdns services` 的输出是：
//   List of discovered mdns services
//   adb-ZYPZ261A01M6870010L-R9QdlL\t_adb-tls-connect._tcp\t192.168.2.46:36973
//   adb-ZYPZ261A01M6870010L-R9QdlL (2)\t_adb-tls-connect._tcp\t192.168.2.46:42359
// 服务名这一列**不带尾点**。旧实现按 `_adb-tls-connect._tcp.` 做子串匹配，
// 于是这条兜底档一条都解析不出来——自动发现的两条路（设备表 + mDNS）在
// 「手机重连、adb 忘了旧 transport」时同时失效，用户只能手输地址。
// 旧测试用的正是带尾点那种形态，把错误的现实钉住了，所以一直没被发现。

test('mDNS 解析：真机原样输出（服务名不带尾点）能解析出全部 connect 实例', () => {
  const real = 'List of discovered mdns services\n'
    + 'adb-ZYPZ261A01M6870010L-R9QdlL\t_adb-tls-connect._tcp\t192.168.2.46:36973\n'
    + 'adb-ZYPZ261A01M6870010L-R9QdlL (2)\t_adb-tls-connect._tcp\t192.168.2.46:42359\n';
  const parsed = client.parseMdnsConnectServices(real);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map((p) => p.address), ['192.168.2.46:36973', '192.168.2.46:42359']);
  // 实例名自带空格时不能被截断
  assert.equal(parsed[1].instance, 'adb-ZYPZ261A01M6870010L-R9QdlL (2)');
});

test('mDNS 解析：带尾点的形态也认（不同 adb 版本可能这么写）', () => {
  const parsed = client.parseMdnsConnectServices(
    'adb-1234abcd-AbCdEf._adb-tls-connect._tcp.\t192.168.1.117:34103\n',
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].address, '192.168.1.117:34103');
});

test('mDNS 解析：配对实例一律不收（对它跑 adb pair 会 protocol fault）', () => {
  const parsed = client.parseMdnsConnectServices(
    'adb-1234abcd-AbCdEf._adb-tls-pairing._tcp\t192.168.1.117:40001\n'
    + 'adb-1234abcd-AbCdEf._adb-tls-connect._tcp\t192.168.1.117:34103\n',
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].address, '192.168.1.117:34103');
});

test('mDNS 解析：地址不是 IPv4:port 的行丢掉', () => {
  const parsed = client.parseMdnsConnectServices(
    'adb-1234abcd-AbCdEf._adb-tls-connect._tcp\t[fe80::1]:5555\n'
    + 'adb-1234abcd-AbCdEf._adb-tls-connect._tcp\t192.168.1.117:34103\n',
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].address, '192.168.1.117:34103');
});

// ── pullFile 会先建本地父目录 ────────────────────────────────────────────────
// 2026-11-19 真机踩的：khy phone pull <设备路径> <主机路径> 报
// "adb: error: cannot create file/directory ... No such file or directory"——
// adb pull 不会替你建父目录，报错却指向 adb，看着像手机侧的问题。

test('pullFile：本地父目录不存在时先建出来，再拉', async () => {
  const os = require('node:os');
  const nodePath = require('node:path');
  const fsMod = require('node:fs');
  const base = fsMod.mkdtempSync(nodePath.join(os.tmpdir(), 'khy-pull-'));
  const target = nodePath.join(base, 'nested', 'deep', 'x.txt');
  const adb = scriptedAdb([
    ok(`List of devices attached\n${SERIAL}\tdevice\n`),
    ok('12\n'),          // 体积
    ok('1 file pulled\n'),
  ]);
  const instance = createClient({
    env: {},
    config: { ...CONFIG, serialSource: 'env' },
    adbTransport: adb,
    httpTransport: scriptedHttp([]),
    sleep: () => Promise.resolve(),
    now: () => 1700000000000,
    signalFactory: () => new AbortController().signal,
    fs: fsMod,
  });
  const res = await instance.pullFile({ remotePath: '/sdcard/x.txt', localPath: target });
  assert.equal(res.ok, true);
  assert.equal(fsMod.existsSync(nodePath.dirname(target)), true, '父目录应被建出来');
  fsMod.rmSync(base, { recursive: true, force: true });
});
