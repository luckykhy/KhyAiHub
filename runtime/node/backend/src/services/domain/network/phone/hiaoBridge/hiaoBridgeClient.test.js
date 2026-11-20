'use strict';

/**
 * hiaoBridgeClient.test.js — co-located suite for the hiao IO shell.
 *
 * Both transports are injected: `runAdb` is a scripted argv recorder, the HTTP
 * transport returns canned responses. Nothing here spawns adb, opens a socket,
 * or reads a token off a device — the real-device paths are smoke-only and are
 * an explicit non-goal of this batch.
 *
 * What is asserted is the contract that is expensive to get wrong:
 *   · `adb forward tcp:0` output is the only source of the loopback port;
 *   · a write call without confirm:true sends NOTHING (not even a forward);
 *   · /call rides on the 600s+ deadline while GETs use the short one;
 *   · a refusal never surfaces as a device fault;
 *   · the pairing token appears in no result and no error text.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHiaoBridgeClient } = require('./hiaoBridgeClient');

const TOKEN = 'abcdef0123456789abcdef0123456789';

function testConfig(overrides = {}) {
  return {
    adbExecutable: 'adb',
    serial: '',
    devicePort: 8898,
    forwardPort: 18998,
    baseUrl: 'http://127.0.0.1:18998',
    tokenRemotePath: '/sdcard/hiao/token.txt',
    httpTimeoutMs: 1234,
    callTimeoutMs: 660000,
    ...overrides,
  };
}

function forwardOk(port = '54321') {
  return { ok: true, code: 0, stdout: `${port}\n`, stderr: '' };
}

function tokenOk(token = 'tok-abc') {
  return { ok: true, code: 0, stdout: `${token}\n`, stderr: '' };
}

function harness({ adb = [], http = [], config = testConfig() } = {}) {
  const adbScript = [...adb];
  const httpScript = [...http];
  const adbCalls = [];
  const httpCalls = [];
  const runAdb = async (argv) => {
    adbCalls.push(argv);
    const next = adbScript.shift();
    if (!next) {
      throw new Error(`unexpected adb call: ${JSON.stringify(argv)}`);
    }
    return next;
  };
  const httpTransport = {
    request: async (req) => {
      httpCalls.push(req);
      const next = httpScript.shift();
      if (!next) {
        throw new Error(`unexpected http call: ${req.method} ${req.url}`);
      }
      return next;
    },
  };
  const client = createHiaoBridgeClient({ config, runAdb, httpTransport });
  return { client, adbCalls, httpCalls };
}

test('forward 用 tcp:0 让 adb 自选端口，回填值是 baseUrl 的唯一来源', async () => {
  const h = harness({
    adb: [forwardOk('54321'), tokenOk()],
    http: [{ status: 200, bodyText: '{"ok":true,"tools":[{"name":"info"}]}', ok: true }],
  });
  const res = await h.client.status();
  assert.equal(res.ok, true);
  assert.equal(res.status.tools[0].name, 'info');
  assert.deepEqual(h.adbCalls[0], ['forward', 'tcp:0', 'tcp:8898']);
  assert.equal(h.httpCalls[0].url, 'http://127.0.0.1:54321/status');
  assert.equal(h.httpCalls[0].headers.Authorization, `Bearer tok-abc`);
  assert.equal(h.httpCalls[0].timeoutMs, 1234);
});

test('配置了 serial 时每条 adb 命令都带 -s', async () => {
  const h = harness({
    config: testConfig({ serial: 'SER-1' }),
    adb: [forwardOk(), tokenOk()],
    http: [{ status: 200, bodyText: '{"ok":true}', ok: true }],
  });
  await h.client.status();
  assert.deepEqual(h.adbCalls[0], ['-s', 'SER-1', 'forward', 'tcp:0', 'tcp:8898']);
  assert.deepEqual(h.adbCalls[1], ['-s', 'SER-1', 'shell', 'cat', '/sdcard/hiao/token.txt']);
});

test('ping 不带鉴权头：桥活着但尚未配对时也要能探活', async () => {
  const h = harness({
    adb: [forwardOk()],
    http: [{ status: 200, bodyText: '{"ok":true,"version":"2.8"}', ok: true }],
  });
  const res = await h.client.ping();
  assert.equal(res.ok, true);
  assert.equal(res.version, '2.8');
  assert.equal(h.httpCalls[0].url, 'http://127.0.0.1:54321/ping');
  assert.equal(h.httpCalls[0].headers.Authorization, undefined);
  // 没有读令牌：ping 的路径上不该出现 cat。
  assert.equal(h.adbCalls.length, 1);
});

test('写调用不带 confirm 只回计划，一个字节都不发', async () => {
  const h = harness();
  const res = await h.client.call('exec', { cmd: 'id' });
  assert.equal(res.success, false);
  assert.equal(res.requiresConfirm, true);
  assert.equal(res.code, 'requires_confirm');
  assert.match(res.message, /600s/);
  assert.equal(h.adbCalls.length, 0);
  assert.equal(h.httpCalls.length, 0);
});

test('写调用带 confirm 才 POST /call，且不把 confirm 转发给手机', async () => {
  const h = harness({
    adb: [forwardOk(), tokenOk()],
    http: [{ status: 200, bodyText: '{"ok":true,"verdict":"allow"}', ok: true }],
  });
  const res = await h.client.call('exec', { cmd: 'id' }, { confirm: true });
  assert.equal(res.success, true);
  assert.equal(res.verdict, 'allow');
  assert.equal(h.httpCalls[0].method, 'POST');
  assert.equal(h.httpCalls[0].url, 'http://127.0.0.1:54321/call');
  assert.deepEqual(h.httpCalls[0].body, { tool: 'exec', args: { cmd: 'id' } });
  // /call 走审批截止（600s+），不是 GET 的短超时。
  assert.equal(h.httpCalls[0].timeoutMs, 660000);
});

test('只读工具（info/status/agent_status）不需要 confirm 直接发', async () => {
  const h = harness({
    adb: [forwardOk(), tokenOk()],
    http: [{ status: 200, bodyText: '{"ok":true,"agents":2}', ok: true }],
  });
  const res = await h.client.call('agent_status', {});
  assert.equal(res.success, true);
  assert.equal(h.httpCalls.length, 1);
});

test('verdict=deny 归 hiao_deny，不报成设备故障', async () => {
  const h = harness({
    adb: [forwardOk(), tokenOk()],
    http: [{ status: 200, bodyText: '{"ok":false,"verdict":"deny","reason":"policy"}', ok: true }],
  });
  const res = await h.client.call('ui_tap', { x: 1 }, { confirm: true });
  assert.equal(res.success, false);
  assert.equal(res.code, 'hiao_deny');
  assert.match(res.error, /拒绝/);
  assert.doesNotMatch(res.error, /设备侧故障/);
});

test('2xx 但 ok:false 且无标记 → 归 hiao_deny（拒绝），不谎报设备故障', async () => {
  const h = harness({
    adb: [forwardOk(), tokenOk()],
    http: [{ status: 200, bodyText: '{"ok":false,"error":"args.path is not absolute"}', ok: true }],
  });
  const res = await h.client.call('exec', { path: 'rel' }, { confirm: true });
  assert.equal(res.success, false);
  assert.equal(res.code, 'hiao_deny');
  assert.match(res.error, /args\.path is not absolute/);
  assert.doesNotMatch(res.error, /设备侧故障/);
});

test('手机端在正文里自报审批超时（下划线机器码）→ approval_timeout，不是 hiao_deny/设备故障', async () => {
  for (const [status, ok] of [[200, true], [504, false]]) {
    const h = harness({
      adb: [forwardOk(), tokenOk()],
      http: [{ status, bodyText: '{"ok":false,"code":"approval_timeout"}', ok }],
    });
    const res = await h.client.call('ui_tap', { x: 1 }, { confirm: true });
    assert.equal(res.code, 'approval_timeout', `status ${status}`);
    assert.match(res.error, /600s|放行/);
    assert.doesNotMatch(res.error, /设备侧故障|拒绝了这次调用/);
  }
});

test('GET 超时的文案不自相矛盾：说「被拒或无响应」，不只说「连接被拒」', async () => {
  const h = harness({
    adb: [forwardOk(), tokenOk()],
    http: [{ status: 0, bodyText: '', ok: false, aborted: true, error: '请求 1234ms 内未收到手机端回应' }],
  });
  const res = await h.client.status();
  assert.equal(res.code, 'unreachable');
  assert.match(res.error, /没有回应|无响应/);
  assert.doesNotMatch(res.error, /已建立但连接被拒。/);
});

test('401 归 unauthorized 并给重新配对的路', async () => {
  const h = harness({
    adb: [forwardOk(), tokenOk()],
    http: [{ status: 401, bodyText: '', ok: false }],
  });
  const res = await h.client.status();
  assert.equal(res.success, false);
  assert.equal(res.code, 'unauthorized');
  assert.match(res.error, /配对令牌/);
});

test('请求被截止（aborted）归 approval_timeout，而不是设备故障', async () => {
  const h = harness({
    adb: [forwardOk(), tokenOk()],
    http: [{ status: 0, bodyText: '', ok: false, aborted: true, error: '请求 660000ms 内未收到手机端回应' }],
  });
  const res = await h.client.call('ui_tap', { x: 1 }, { confirm: true });
  assert.equal(res.success, false);
  assert.equal(res.code, 'approval_timeout');
  assert.match(res.error, /600s/);
  assert.doesNotMatch(res.error, /设备侧故障|device_fault/);
});

test('aborted 分支的 transport error 也过 redactSecrets（与其它分支同一道闸）', async () => {
  const h = harness({
    adb: [forwardOk(), tokenOk(TOKEN)],
    http: [{
      status: 0,
      bodyText: '',
      ok: false,
      aborted: true,
      error: `socket died while carrying Bearer ${TOKEN}`,
    }],
  });
  const res = await h.client.status();
  const serialized = JSON.stringify(res);
  assert.equal(serialized.includes(TOKEN), false, '超时分支把令牌原样带进了结果');
  assert.equal(res.code, 'unreachable');
});

test('读不到令牌 → hiao_not_paired，零 HTTP 请求，并说清去哪配对', async () => {
  const h = harness({
    adb: [forwardOk(), { ok: false, code: 1, stdout: '', stderr: 'cat: /sdcard/hiao/token.txt: Permission denied' }],
  });
  const res = await h.client.call('info', {});
  assert.equal(res.success, false);
  assert.equal(res.code, 'hiao_not_paired');
  assert.match(res.error, /配对/);
  assert.equal(h.httpCalls.length, 0);
});

test('令牌绝不进结果或错误文案', async () => {
  const h = harness({
    adb: [forwardOk(), tokenOk(TOKEN)],
    http: [{ status: 401, bodyText: '', ok: false, error: `unauthorized: Bearer ${TOKEN}` }],
  });
  const res = await h.client.status();
  const serialized = JSON.stringify(res);
  assert.equal(serialized.includes(TOKEN), false, '令牌原文出现在返回值里');
  assert.match(serialized, /redacted-token/);
});

test('令牌只读一次并缓存（两次调用只 cat 一次）', async () => {
  const h = harness({
    adb: [forwardOk(), tokenOk()],
    http: [
      { status: 200, bodyText: '{"ok":true}', ok: true },
      { status: 200, bodyText: '{"ok":true}', ok: true },
    ],
  });
  await h.client.status();
  await h.client.status();
  assert.equal(h.adbCalls.length, 2, '第二次不该再读令牌');
  assert.equal(h.adbCalls[1].includes('cat'), true);
});

test('forward 失败归 device_fault 并带上 adb 的原始错误', async () => {
  const h = harness({
    adb: [{ ok: false, code: 1, stdout: '', stderr: 'error: more than one device/emulator' }],
  });
  const res = await h.client.status();
  assert.equal(res.success, false);
  assert.equal(res.code, 'device_fault');
  assert.match(res.error, /more than one device/);
});

test('forward 没有回填数字端口 → device_fault，不拼一个假 baseUrl', async () => {
  const h = harness({ adb: [{ ok: true, code: 0, stdout: 'not-a-port\n', stderr: '' }] });
  const res = await h.client.status();
  assert.equal(res.success, false);
  assert.equal(res.code, 'device_fault');
  assert.match(res.error, /转发端口/);
});

test('连接被拒归 unreachable，并丢掉已死的 forward 让下次重转发', async () => {
  const h = harness({
    adb: [forwardOk(), tokenOk(), forwardOk('60001')],
    http: [
      { status: 0, bodyText: '', ok: false, error: 'connect ECONNREFUSED' },
      { status: 200, bodyText: '{"ok":true}', ok: true },
    ],
  });
  const first = await h.client.status();
  assert.equal(first.success, false);
  assert.equal(first.code, 'unreachable');
  const second = await h.client.status();
  assert.equal(second.ok, true);
  assert.deepEqual(h.adbCalls[2], ['forward', 'tcp:0', 'tcp:8898']);
  assert.equal(h.httpCalls[1].url, 'http://127.0.0.1:60001/status');
});

test('GET 超时归 unreachable，不冒充审批超时（不得出现 600s 文案）', async () => {
  const h = harness({
    adb: [forwardOk(), tokenOk()],
    http: [{ status: 0, bodyText: '', ok: false, aborted: true, error: '请求 1234ms 内未收到手机端回应' }],
  });
  const res = await h.client.status();
  assert.equal(res.success, false);
  assert.equal(res.code, 'unreachable');
  assert.equal(res.code === 'approval_timeout', false);
  assert.doesNotMatch(res.error, /600s|放行/);
  assert.match(res.error, /1234ms|不可达/);
});

test('401 后清掉缓存令牌：重试会重读设备上的新令牌', async () => {
  const h = harness({
    adb: [forwardOk(), tokenOk('old-token'), tokenOk('new-token')],
    http: [
      { status: 401, bodyText: '', ok: false },
      { status: 401, bodyText: '', ok: false },
    ],
  });
  const first = await h.client.status();
  assert.equal(first.code, 'unauthorized');
  const second = await h.client.status();
  assert.equal(second.code, 'unauthorized');
  // 两次都真的 cat 了令牌：第二次没有复用第一次的死令牌。
  assert.equal(h.adbCalls.filter((argv) => argv.includes('cat')).length, 2);
  assert.equal(h.httpCalls[1].headers.Authorization, 'Bearer new-token');
});

test('不设 on/off 门：缺令牌也会先建转发、再读令牌，能力门就是令牌本身', async () => {
  const h = harness({
    adb: [forwardOk(), { ok: false, code: 1, stdout: '', stderr: 'No such file or directory' }],
  });
  const res = await h.client.status();
  assert.equal(res.code, 'hiao_not_paired');
  assert.equal(h.adbCalls.length, 2);
  assert.equal(h.httpCalls.length, 0);
});

test('approve：缺 id 拒绝；不带 confirm 回计划；带 confirm 才 POST /approve', async () => {
  const missing = harness();
  const noId = await missing.client.approve('');
  assert.equal(noId.success, false);
  assert.equal(noId.code, 'invalid_args');
  assert.equal(missing.adbCalls.length, 0);

  const planned = harness();
  const plan = await planned.client.approve('ap-1', true);
  assert.equal(plan.requiresConfirm, true);
  assert.equal(plan.code, 'requires_confirm');
  assert.equal(planned.httpCalls.length, 0);

  const sent = harness({
    adb: [forwardOk(), tokenOk()],
    http: [{ status: 200, bodyText: '{"ok":true}', ok: true }],
  });
  const res = await sent.client.approve('ap-1', true, 'yes', { confirm: true });
  assert.equal(res.ok, true);
  assert.equal(sent.httpCalls[0].url, 'http://127.0.0.1:54321/approve');
  assert.deepEqual(sent.httpCalls[0].body, { id: 'ap-1', approve: true, answer: 'yes' });
});

test('audit 带 n 参数，approvals/tools 从 /status 与 /approvals 读出', async () => {
  const h = harness({
    adb: [forwardOk(), tokenOk()],
    http: [
      { status: 200, bodyText: '{"audit":[{"seq":1}]}', ok: true },
      { status: 200, bodyText: '{"approvals":[{"id":"a1"}]}', ok: true },
      { status: 200, bodyText: '{"tools":48}', ok: true },
      { status: 200, bodyText: '{"tools":["info","exec"]}', ok: true },
    ],
  });
  const audit = await h.client.audit(7);
  assert.deepEqual(audit.audit, [{ seq: 1 }]);
  assert.equal(h.httpCalls[0].url, 'http://127.0.0.1:54321/audit?n=7');

  const approvals = await h.client.approvals();
  assert.deepEqual(approvals.approvals, [{ id: 'a1' }]);

  const countOnly = await h.client.tools();
  assert.equal(countOnly.count, 48);
  assert.equal(countOnly.names, null);
  assert.match(countOnly.note, /MCP/);

  const named = await h.client.tools();
  assert.deepEqual(named.names, ['info', 'exec']);
});

test('resetForTests 丢弃 forward 与令牌缓存', async () => {
  const h = harness({
    adb: [forwardOk('50000'), tokenOk(), forwardOk('50002'), tokenOk()],
    http: [
      { status: 200, bodyText: '{"ok":true}', ok: true },
      { status: 200, bodyText: '{"ok":true}', ok: true },
    ],
  });
  await h.client.status();
  h.client.resetForTests();
  await h.client.status();
  assert.equal(h.adbCalls.length, 4);
  assert.equal(h.httpCalls[1].url, 'http://127.0.0.1:50002/status');
});
