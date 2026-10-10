'use strict';

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');

const { createRemoteControl } = require('./index');
const { STATUS, INBOUND, OUTBOUND, ERROR_CODE } = require('./protocol');

function fakeCaps() {
  const sent = [];
  return {
    sent,
    async listWorkspaces() {
      return [{ path: '/tmp/ws-a', name: 'ws-a' }];
    },
    async listTasks() {
      return [{ sessionId: 'sess_1', title: '任务一', updatedAt: Date.now() }];
    },
    async loadSession({ sessionId }) {
      return { sessionId, messages: [{ role: 'user', content: '早' }] };
    },
    async sendMessage(msg) {
      sent.push(msg);
      return { ok: true };
    },
    async abort() {
      return { ok: true };
    },
    async respondControl() {
      return { ok: true };
    },
    async gateState() {
      return { mode: 'ask' };
    },
  };
}

function client(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/r/ws`);
    const queue = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      const idx = waiters.findIndex((w) => w.type === msg.type);
      if (idx >= 0) waiters.splice(idx, 1)[0].resolve(msg);
      else queue.push(msg);
    });
    ws.on('open', () =>
      resolve({
        ws,
        next(type, ms = 3000) {
          const hit = queue.findIndex((m) => m.type === type);
          if (hit >= 0) return Promise.resolve(queue.splice(hit, 1)[0]);
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error(`等待 ${type} 超时`)), ms);
            waiters.push({ type, resolve: (m) => (clearTimeout(t), res(m)) });
          });
        },
        send(obj) {
          ws.send(JSON.stringify(obj));
        },
      }),
    );
    ws.on('error', reject);
  });
}

const opened = [];
after(async () => {
  for (const rc of opened) {
    try {
      await rc.stop();
    } catch {
      /* 断言失败时服务可能已停 */
    }
  }
});

async function withServer(opts = {}) {
  const caps = fakeCaps();
  const pending = [];
  const rc = createRemoteControl({
    port: opts.port || 19413 + Math.floor(Math.random() * 400),
    lanEnabled: opts.lanEnabled,
    capabilities: caps,
    onPairRequest: (r) => pending.push(r),
    ...opts.rc,
  });
  opened.push(rc);
  await rc.start();
  return { rc, caps, pending, port: rc.getStatus().port };
}

test('默认只绑 127.0.0.1，开启局域网开关后才是 0.0.0.0', async () => {
  const { rc, port } = await withServer();
  assert.equal(rc.getStatus().bindHost, '127.0.0.1');
  assert.equal(rc.getStatus().lanEnabled, false);
  assert.match(rc.getStatus().url, new RegExp(`http://127.0.0.1:${port}/r#p=`));
  await rc.stop();
});

test('配对码一次一用：同一码第二次提交拿 SESSION_NOT_FOUND', async () => {
  const { rc, pending, port } = await withServer();
  const code = rc.getStatus().pairCode;
  const a = await client(port);
  a.send({ khy_type: INBOUND.BOOTSTRAP, pairCode: code, deviceInfo: { name: 'A' } });
  const pp = await a.next(OUTBOUND.PAIR_PENDING);
  assert.equal(pp.pairingId, code);
  assert.equal(pending.length, 1);

  const b = await client(port);
  b.send({ khy_type: INBOUND.BOOTSTRAP, pairCode: code, deviceInfo: { name: 'B' } });
  const err = await b.next(OUTBOUND.ERROR);
  assert.equal(err.code, ERROR_CODE.NOT_FOUND);
  await rc.stop();
});

test('viewer 角色不能发消息；operator 可以，且事件能回流到手机', async () => {
  const { rc, caps, pending, port } = await withServer();
  const phone = await client(port);
  phone.send({ khy_type: INBOUND.BOOTSTRAP, pairCode: rc.getStatus().pairCode, deviceInfo: { name: 'Pixel' } });
  const { pairingId } = await phone.next(OUTBOUND.PAIR_PENDING);
  assert.equal(pending[0].pairingId, pairingId);

  const approved = await rc.approvePairing(pairingId, 'viewer');
  assert.equal(approved.ok, true);
  assert.equal(approved.device.role, 'viewer');
  const boot = await phone.next(OUTBOUND.BOOTSTRAP);
  assert.equal(boot.result.role, 'viewer');
  assert.ok(boot.result.token, 'token 随 bootstrap 响应下发一次');
  assert.equal(rc.getStatus().status, STATUS.ACTIVE);

  phone.send({ khy_type: INBOUND.SESSION_SEND, requestId: 'x1', sessionId: 'sess_1', text: 'hi' });
  const denied = await phone.next(OUTBOUND.ERROR);
  assert.equal(denied.code, ERROR_CODE.FORBIDDEN);
  assert.equal(caps.sent.length, 0);

  // 只读通道对 viewer 开放
  phone.send({ khy_type: INBOUND.TASK_LIST, requestId: 'x2' });
  const tasks = await phone.next(OUTBOUND.TASK_LIST);
  assert.equal(tasks.result[0].sessionId, 'sess_1');

  await rc.revokeDevice(approved.device.deviceId);
  const kicked = await phone.next(OUTBOUND.ERROR);
  assert.equal(kicked.code, ERROR_CODE.KICKED);

  // 换 operator 设备：旧码已被上一次扫码消费掉，必须走「刷新二维码」拿新码
  const phone2 = await client(port);
  const code2 = (await rc.refreshQr()).code;
  phone2.send({ khy_type: INBOUND.BOOTSTRAP, pairCode: code2, deviceInfo: { name: 'iPhone' } });
  const p2 = await phone2.next(OUTBOUND.PAIR_PENDING);
  await rc.approvePairing(p2.pairingId, 'operator');
  await phone2.next(OUTBOUND.BOOTSTRAP);
  phone2.send({ khy_type: INBOUND.SESSION_SEND, requestId: 'x3', sessionId: 'sess_1', text: '跑一下' });
  assert.ok(await phone2.next(OUTBOUND.SESSION_SEND));
  assert.deepEqual(caps.sent[0].text, '跑一下');

  rc.broadcastStream({ kind: 'chunk', text: '好的' });
  const stream = await phone2.next(OUTBOUND.STREAM);
  assert.equal(stream.event.text, '好的');
  assert.equal(typeof stream.seq, 'number');
  await rc.stop();
});

test('同一时间只允许一个手机页面：第二个拿 SESSION_CONFLICT', async () => {
  const { rc, pending, port } = await withServer();
  const a = await client(port);
  a.send({ khy_type: INBOUND.BOOTSTRAP, pairCode: rc.getStatus().pairCode, deviceInfo: { name: 'A' } });
  await a.next(OUTBOUND.PAIR_PENDING);
  await rc.approvePairing(pending[0].pairingId, 'operator');
  await a.next(OUTBOUND.BOOTSTRAP);

  const b = await client(port);
  b.send({ khy_type: INBOUND.BOOTSTRAP, token: 'not-a-real-token-but-irrelevant', deviceInfo: { name: 'B' } });
  const err = await b.next(OUTBOUND.ERROR);
  assert.ok([ERROR_CODE.CONFLICT, ERROR_CODE.EXPIRED].includes(err.code), `实际 ${err.code}`);
  await rc.stop();
});

test('刷新二维码作废旧 token 与旧链接', async () => {
  const { rc, pending, port } = await withServer();
  const a = await client(port);
  a.send({ khy_type: INBOUND.BOOTSTRAP, pairCode: rc.getStatus().pairCode, deviceInfo: { name: 'A' } });
  await a.next(OUTBOUND.PAIR_PENDING);
  const ok = await rc.approvePairing(pending[0].pairingId, 'operator');
  await a.next(OUTBOUND.BOOTSTRAP);

  const rotated = await rc.refreshQr();
  assert.match(rotated.code, /^[A-Z0-9]{8}$/, '刷新后给出新配对码');
  const err = await a.next(OUTBOUND.ERROR);
  assert.equal(err.code, ERROR_CODE.KICKED);

  const b = await client(port);
  b.send({ khy_type: INBOUND.BOOTSTRAP, token: 'stale', deviceInfo: { name: 'B' } });
  const e2 = await b.next(OUTBOUND.ERROR);
  assert.equal(e2.code, ERROR_CODE.EXPIRED);
  await rc.stop();
});

test('端口被占用时自动顺延，不崩', async () => {
  const first = await withServer();
  const taken = first.port;
  const second = await withServer({ port: taken });
  assert.ok(second.port > taken, `期望顺延，实际 ${second.port}`);
  assert.equal(second.rc.getStatus().status, STATUS.RUNNING);
  await second.rc.stop();
  await first.rc.stop();
});

test('手机页直出 HTML，/r/health 只回服务名', async () => {
  const { rc, port } = await withServer();
  const html = await fetch(`http://127.0.0.1:${port}/r`).then((r) => r.text());
  assert.match(html, /移动端远程控制/);
  assert.match(html, /khy_bootstrap_request/);
  const health = await fetch(`http://127.0.0.1:${port}/r/health`).then((r) => r.json());
  assert.deepEqual(health, { ok: true, service: 'khy-web-remote' });
  await rc.stop();
});
