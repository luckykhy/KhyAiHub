'use strict';

/**
 * deviceLinkWss.test.js — S0：出向链路服务的登记名额与 status 面（真服务、真 TLS）。
 *
 * 本套件按行为命名，不占用任务书 §2 的 T1-T4 编号（逐条对表见
 * feedback/device-id-reregister-s0-20261117/acceptance-t1-t4-s0.md）。覆盖：
 *   · 名额满只报错不顶人（POST 被拒时既有设备仍在册且仍能 auth:ok）
 *   · 显式腾位（admin DELETE 后该设备立刻被拒、名额释放）
 *   · status 面（/state 的 registry.used/max/devices 与 reg_state/last_reg_ms/
 *      registration_source）
 *
 * 为什么起真服务：名额与 /state 都长在 startDeviceLinkServer 的闭包里，把逻辑
 * 抽出来单测等于另写一份会漂的镜像。真起服务需要 keytool 生成自签证书；缺 JDK
 * 的环境显式 skip 并写明原因，不伪造通过。
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const assert = require('node:assert');
const test = require('node:test');
const os = require('os');
const path = require('path');

const wssMod = require('./deviceLinkWss');
const auth = require('./deviceSignatureAuth');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function httpJson(port, method, pathname, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method, timeout: 5000, headers: { 'content-type': 'application/json' } },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch { parsed = null; }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null, error: 'timeout' }); });
    req.on('error', (err) => resolve({ status: 0, body: null, error: String(err && err.message) }));
    req.end(payload);
  });
}

function newDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyB64 = der.toString('base64');
  const deviceId = auth.deriveDeviceId(der);
  const ts = Date.now();
  const sig = crypto
    .sign('sha256', Buffer.from(auth.payloadOf(deviceId, ts), 'utf8'), { key: privateKey, dsaEncoding: 'der' })
    .toString('base64');
  return { publicKeyB64, deviceId, ts, sig };
}

function waitListening(server) {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

/** 真 TLS + 真 auth 帧，只返回第一帧 auth 响应。 */
function authOverWss(port, dev) {
  const WebSocket = require('ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* gone */ }
      reject(new Error('auth frame timeout'));
    }, 8000);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'auth',
        deviceId: dev.deviceId,
        publicKey: dev.publicKeyB64,
        ts: dev.ts,
        sig: dev.sig,
        platform: 'android',
        deviceName: 'Pixel',
      }));
    });
    ws.on('message', (buf) => {
      let msg = null;
      try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }
      if (!msg || (msg.type !== 'auth:ok' && msg.type !== 'auth:error')) return;
      clearTimeout(timer);
      try { ws.close(); } catch { /* gone */ }
      resolve(msg);
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function hasKeytool() {
  try {
    wssMod.findKeytool();
    return true;
  } catch {
    return false;
  }
}

test('出向链路：名额满只报错不顶人；/state 报 registry 与 reg；DELETE 腾位', { timeout: 180000 }, async (t) => {
  if (!hasKeytool()) {
    t.skip('本机没有 keytool（JDK），起不了 TLS；不是实现问题');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-device-link-test-'));
  const wssPort = await freePort();
  const adminPort = await freePort();
  const server = wssMod.startDeviceLinkServer({
    wssPort,
    adminPort,
    certDir: path.join(tmp, 'cert'),
    registryFile: path.join(tmp, 'registry.json'),
    maxDevices: 2,
  });
  t.after(() => {
    try { server.close(); } catch { /* noop */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });
  await waitListening(server.tlsServer);
  await waitListening(server.admin);

  // 1) 初始：空登记表
  const s0 = await httpJson(adminPort, 'GET', '/state');
  assert.strictEqual(s0.status, 200);
  assert.deepStrictEqual(s0.body.registry, { used: 0, max: 2, devices: [] });
  assert.strictEqual(s0.body.reg.reg_state, 'unregistered');
  assert.strictEqual(s0.body.reg.last_reg_ms, null);
  assert.strictEqual(s0.body.reg.registration_source, null);

  // 2) 自动重新登记（source=auto）：服务端本来不认识 → re_registered
  const a = newDevice();
  const r1 = await httpJson(adminPort, 'POST', wssMod.ADMIN_REGISTER_PATH, {
    deviceId: a.deviceId,
    publicKey: a.publicKeyB64,
    userId: 'local',
    platform: 'android',
    source: 'auto',
  });
  assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
  assert.strictEqual(r1.body.ok, true);
  assert.strictEqual(r1.body.alreadyEnrolled, false);
  assert.strictEqual(r1.body.regSource, 'auto');
  assert.strictEqual(typeof r1.body.registeredAt, 'number');

  const s1 = await httpJson(adminPort, 'GET', '/state');
  assert.strictEqual(s1.body.registry.used, 1);
  assert.strictEqual(s1.body.registry.max, 2);
  assert.deepStrictEqual(s1.body.registry.devices.map((d) => d.deviceId), [a.deviceId]);
  assert.strictEqual(s1.body.registry.devices[0].regSource, 'auto');
  assert.strictEqual(s1.body.registry.devices[0].registeredAt, r1.body.registeredAt);
  assert.strictEqual(s1.body.reg.reg_state, 're_registered');
  assert.strictEqual(s1.body.reg.registration_source, 'auto');
  assert.strictEqual(s1.body.reg.last_reg_ms, r1.body.registeredAt);

  // 3) 第二台（manual）：已知设备之外的正常登记 → registered
  const b = newDevice();
  const r2 = await httpJson(adminPort, 'POST', wssMod.ADMIN_REGISTER_PATH, {
    deviceId: b.deviceId,
    publicKey: b.publicKeyB64,
    userId: 'local',
    platform: 'android',
  });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.body.regSource, 'manual');
  const s2 = await httpJson(adminPort, 'GET', '/state');
  assert.strictEqual(s2.body.reg.reg_state, 'registered');
  assert.strictEqual(s2.body.reg.registration_source, 'manual');

  // 4) 名额满：第三台被拒且带 used/max；既有两台一个不掉
  const c = newDevice();
  const r3 = await httpJson(adminPort, 'POST', wssMod.ADMIN_REGISTER_PATH, {
    deviceId: c.deviceId,
    publicKey: c.publicKeyB64,
    userId: 'local',
    platform: 'android',
    source: 'auto',
  });
  assert.strictEqual(r3.status, 400);
  assert.strictEqual(r3.body.ok, false);
  assert.strictEqual(r3.body.code, 'device_slots_full');
  assert.strictEqual(r3.body.used, 2);
  assert.strictEqual(r3.body.max, 2);
  const s3 = await httpJson(adminPort, 'GET', '/state');
  assert.deepStrictEqual(
    s3.body.registry.devices.map((d) => d.deviceId).sort(),
    [a.deviceId, b.deviceId].sort(),
  );

  // 5) 「不顶人」还要在链路上成立：既有设备仍能 auth:ok
  const okA = await authOverWss(wssPort, a);
  assert.strictEqual(okA.type, 'auth:ok', JSON.stringify(okA));
  const okB = await authOverWss(wssPort, b);
  assert.strictEqual(okB.type, 'auth:ok', JSON.stringify(okB));

  // 6) 显式腾位：DELETE 后该设备立刻被拒，名额释放
  const del = await httpJson(adminPort, 'DELETE', `/devices/${a.deviceId}`);
  assert.strictEqual(del.status, 200);
  assert.strictEqual(del.body.removed, true);
  const s4 = await httpJson(adminPort, 'GET', '/state');
  assert.strictEqual(s4.body.registry.used, 1);
  assert.deepStrictEqual(s4.body.registry.devices.map((d) => d.deviceId), [b.deviceId]);
  const rejectedA = await authOverWss(wssPort, a);
  assert.strictEqual(rejectedA.type, 'auth:error');
  assert.strictEqual(rejectedA.code, auth.ERR.NOT_ENROLLED);
  // 还有一台在册：一条陌生 key 被拒不该把整条链路判成「未登记」。
  const s4b = await httpJson(adminPort, 'GET', '/state');
  assert.strictEqual(s4b.body.reg.reg_state, 'registered');

  // 7) 删空最后一台 → 链路未登记；被删设备重新登记 → re_registered
  const delB = await httpJson(adminPort, 'DELETE', `/devices/${b.deviceId}`);
  assert.strictEqual(delB.body.removed, true);
  const s5 = await httpJson(adminPort, 'GET', '/state');
  assert.strictEqual(s5.body.registry.used, 0);
  assert.deepStrictEqual(s5.body.registry.devices, []);
  assert.strictEqual(s5.body.reg.reg_state, 'unregistered');

  const r4 = await httpJson(adminPort, 'POST', wssMod.ADMIN_REGISTER_PATH, {
    deviceId: a.deviceId,
    publicKey: a.publicKeyB64,
    userId: 'local',
    platform: 'android',
    source: 'auto',
  });
  assert.strictEqual(r4.status, 200);
  assert.strictEqual(r4.body.alreadyEnrolled, false);
  const s6 = await httpJson(adminPort, 'GET', '/state');
  assert.strictEqual(s6.body.registry.used, 1);
  assert.strictEqual(s6.body.reg.reg_state, 're_registered');
  assert.strictEqual(s6.body.reg.registration_source, 'auto');

  // 8) 腾出的名额能被真正的新设备用掉
  const r5 = await httpJson(adminPort, 'POST', wssMod.ADMIN_REGISTER_PATH, {
    deviceId: c.deviceId,
    publicKey: c.publicKeyB64,
    userId: 'local',
    platform: 'android',
    source: 'auto',
  });
  assert.strictEqual(r5.status, 200);
  const s7 = await httpJson(adminPort, 'GET', '/state');
  assert.strictEqual(s7.body.registry.used, 2);
});
