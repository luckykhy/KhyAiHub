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

function scriptedHttp(script) {
  const calls = [];
  let index = 0;
  return {
    calls,
    request(opts) {
      calls.push(opts);
      const step = script[index] || {};
      index += 1;
      const answer = typeof step === 'function' ? step(opts) : step;
      return Promise.resolve(answer || { status: 0, body: '', ok: false, error: 'script exhausted' });
    },
  };
}

function httpOk(body) {
  return { status: 200, body: typeof body === 'string' ? body : JSON.stringify(body), ok: true };
}

function httpDown(error = 'connect ECONNREFUSED') {
  return { status: 0, body: '', ok: false, error };
}

function makeClient(overrides = {}) {
  const instance = client.createPhoneBridgeClient({
    env: overrides.env || {},
    config: CONFIG,
    adbTransport: overrides.adb || scriptedAdb([]),
    httpTransport: overrides.http || scriptedHttp([]),
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

// ── token ────────────────────────────────────────────────────────────────────

test('token 首次读取后缓存，重复调用不再打 adb', async () => {
  const adb = scriptedAdb([
    ok(`${SERIAL}\tdevice\n`),
    ok('8896\n'),
    ok(`${TOKEN}\n`),
  ]);
  const http = scriptedHttp([httpOk({ ok: true, pong: 1 }), httpOk({ ok: true, pong: 2 })]);
  const c = makeClient({ adb, http });
  assert.equal((await c.ping()).ok, true);
  assert.equal((await c.ping()).ok, true);
  const tokenReads = adb.calls.filter((call) => call.argv.includes('cat') && call.argv.includes(CONFIG.tokenRemotePath));
  assert.equal(tokenReads.length, 1);
  assert.deepEqual(tokenReads[0].argv, ['-s', SERIAL, 'shell', 'cat', CONFIG.tokenRemotePath]);
});

test('readToken(force) 强制重取', async () => {
  const adb = scriptedAdb([ok(`${TOKEN}\n`), ok(`${TOKEN}\n`)]);
  const c = makeClient({ adb });
  assert.equal((await c.readToken()).cached, false);
  assert.equal((await c.readToken()).cached, true);
  assert.equal((await c.readToken(true)).cached, false);
  assert.equal(adb.calls.length, 2);
});

test('token 文件读不到时报中文错误并说明要授「所有文件访问」', async () => {
  const adb = scriptedAdb([fail('No such file or directory')]);
  const c = makeClient({ adb });
  const res = await c.readToken();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'token_read_failed');
  assert.match(res.error, /所有文件访问/);
});

test('token 形状不对时报 token_invalid，不当成空 token 硬发', async () => {
  const adb = scriptedAdb([ok('not-a-token\n')]);
  const c = makeClient({ adb });
  const res = await c.readToken();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'token_invalid');
  assert.equal(c.getState().tokenLoaded, false);
});

test('Authorization 头是 "Bearer " + token，恰好一个空格', async () => {
  const adb = scriptedAdb([ok(`${SERIAL}\tdevice\n`), ok('8896\n'), ok(`${TOKEN}\n`)]);
  const http = scriptedHttp([httpOk({ ok: true, pong: 5 })]);
  const c = makeClient({ adb, http });
  assert.equal((await c.ping()).ok, true);
  assert.equal(http.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(http.calls[0].url, 'http://127.0.0.1:8896/ping');
  assert.equal(http.calls[0].method, 'POST');
  // Connection/Content-Length 由默认 transport 补，见下面 createHttpTransport 的用例
});

test('getState 只暴露 token 是否加载与长度，绝不暴露 token 本体', async () => {
  const adb = scriptedAdb([ok(`${TOKEN}\n`)]);
  const c = makeClient({ adb });
  await c.readToken();
  const state = c.getState();
  assert.equal(state.tokenLoaded, true);
  assert.equal(state.tokenLength, 32);
  assert.equal(JSON.stringify(state).includes(TOKEN), false);
  assert.equal(Object.prototype.hasOwnProperty.call(state, 'token'), false);
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
    ok(`${TOKEN}\n`),
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
  // push 的目标是信箱 cmd_ 文件
  const pushCall = adb.calls.find((call) => call.argv[0] === 'push');
  assert.ok(pushCall);
  assert.ok(pushCall.argv[2].endsWith('/sdcard/bridge-amoobridge/cmd_abc123.json'));
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

// ── adb 位置：IO 层把真实探针递进 resolve，SDK 位置候选才生效 ────────────────

test('createPhoneBridgeClient 默认把 fs.existsSync 探针递进 resolve（ANDROID_HOME 命中）', () => {
  const path = require('path');
  const root = path.join('C:', 'sdkroot');
  const hit = path.join(root, 'platform-tools', bridgeConfig.ADB_EXECUTABLE_NAMES[0]);
  const instance = client.createPhoneBridgeClient({
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
  const instance = client.createPhoneBridgeClient({
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
  const instance = client.createPhoneBridgeClient({
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
  const instance = client.createPhoneBridgeClient({
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
    ok('adb-1234abcd-AbCdEf._adb-tls-connect._tcp.\t192.168.1.117:34103\n'
      + 'adb-1234abcd-AbCdEf._adb-tls-pairing._tcp.\t192.168.1.117:40001\n'),
    ok(`connected to ${adopted}`),
  ]);
  const instance = client.createPhoneBridgeClient({
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
  const instance = client.createPhoneBridgeClient({
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

// 还原 spawn，避免污染同进程内的其它套件
test('收尾：还原 child_process.spawn', () => {
  childProcess.spawn = REAL_SPAWN;
  assert.equal(typeof childProcess.spawn, 'function');
});
