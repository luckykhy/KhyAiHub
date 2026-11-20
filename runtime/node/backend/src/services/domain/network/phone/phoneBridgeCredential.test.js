'use strict';

/**
 * phoneBridgeCredential.test.js — the PC half of the pairing handshake.
 *
 * Real crypto throughout: the thing that can silently break is the agreement
 * between this module and the bridge on two strings (the PoP payload and the
 * certificate shape). A stubbed signer would verify neither.
 *
 * The device is faked at the HTTP boundary — that is the only part that needs
 * a real phone (the code is read off the notification shade by a human).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cred = require('./phoneBridgeCredential');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cred-'));
  return path.join(dir, 'phone-bridge-credential.json');
}

/** A device stand-in: signs the cert with its own key, exactly like DeviceIdentity.java. */
function fakeDevice(clock) {
  const readClock = typeof clock === 'function' ? clock : () => clock;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const deviceId = crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
  const requests = [];
  function request(opts) {
    requests.push(opts);
    if (opts.url.endsWith('/pair/code')) {
      return { status: 200, ok: true, body: JSON.stringify({ ok: true, ttl_ms: 120000 }) };
    }
    if (opts.url.endsWith('/pair')) {
      const body = JSON.parse(opts.body || '{}');
      const now = readClock();
      const issued = now;
      const expires = now + 24 * 60 * 60 * 1000;
      const canonical = `1|${deviceId}|${body.pc_key}|${issued}|${expires}`;
      const sig = crypto
        .sign('sha256', Buffer.from(canonical, 'utf8'), { key: privateKey, dsaEncoding: 'der' })
        .toString('base64');
      return {
        status: 200,
        ok: true,
        body: JSON.stringify({
          ok: true, v: 1, device_id: deviceId, pc_key: body.pc_key,
          issued_at: issued, expires_at: expires, sig,
        }),
      };
    }
    return { status: 404, ok: false, body: '{}' };
  }
  return { deviceId, publicKey, request, requests };
}

function make(opts = {}) {
  const now = opts.now || 1_780_000_000_000;
  const dev = opts.device || fakeDevice(() => now);
  // 只算一次：两次 tmpStore() 会给出两个不同目录，凭据写到一个、断言查另一个。
  const store = opts.store || tmpStore();
  return {
    dev,
    store,
    now,
    credential: cred.createPhoneBridgeCredential({
      storePath: store,
      request: opts.request || dev.request,
      baseUrl: 'http://127.0.0.1:8896',
      env: opts.env || { KHY_PAIR_CODE: '123456' },
      now: () => now,
      fs,
      path,
      os,
    }),
  };
}

test('配对：取码 → 换证书 → 落盘，之后 signedHeaders 能自证', async () => {
  const { credential, store, dev, now } = make();
  const res = await credential.ensure({ deviceId: dev.deviceId });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.paired, true);
  assert.equal(fs.existsSync(store), true);

  const signed = credential.signedHeaders({ method: 'POST', path: '/ping', body: '' });
  assert.equal(signed.ok, true);
  // Authorization 是证书 JSON 的 base64 —— 证书本身不是秘密，抄走也没用，
  // 因为下一个请求还需要 X-Khy-Sig。
  const cert = JSON.parse(Buffer.from(signed.headers.Authorization.slice(7), 'base64').toString('utf8'));
  assert.equal(cert.device_id, dev.deviceId);
  assert.equal(signed.headers['X-Khy-Ts'], String(now));

  // 签名必须能用证书里的 pc_key 验过——这条就是「证书不可转移」的全部内容。
  const payload = cred.popPayload('POST', '/ping', now, '');
  const ok = crypto.verify(
    'sha256',
    Buffer.from(payload, 'utf8'),
    { key: crypto.createPublicKey({ key: Buffer.from(cert.pc_key, 'base64'), format: 'der', type: 'spki' }), dsaEncoding: 'der' },
    Buffer.from(signed.headers['X-Khy-Sig'], 'base64'),
  );
  assert.equal(ok, true);
});

test('签名绑定了路径与请求体：换一个 path 就验不过', async () => {
  const { credential, dev, now } = make();
  await credential.ensure({ deviceId: dev.deviceId });
  const signed = credential.signedHeaders({ method: 'POST', path: '/ping', body: '{"a":1}' });
  const cert = JSON.parse(Buffer.from(signed.headers.Authorization.slice(7), 'base64').toString('utf8'));
  const key = crypto.createPublicKey({ key: Buffer.from(cert.pc_key, 'base64'), format: 'der', type: 'spki' });
  const verify = (p, body) => crypto.verify(
    'sha256', Buffer.from(cred.popPayload('POST', p, now, body), 'utf8'),
    { key, dsaEncoding: 'der' }, Buffer.from(signed.headers['X-Khy-Sig'], 'base64'),
  );
  assert.equal(verify('/ping', '{"a":1}'), true);
  assert.equal(verify('/status', '{"a":1}'), false, '换个路径就不该通过');
  assert.equal(verify('/ping', '{"a":2}'), false, '换个请求体就不该通过');
});

test('私钥落盘在 storePath，且 describe 不带出私钥', async () => {
  const { credential, store, dev } = make();
  await credential.ensure({ deviceId: dev.deviceId });
  const raw = JSON.parse(fs.readFileSync(store, 'utf8'));
  assert.match(raw.privateKeyPem, /BEGIN PRIVATE KEY/);
  const described = credential.describe();
  assert.equal(described.paired, true);
  assert.equal(JSON.stringify(described).includes('PRIVATE KEY'), false);
  assert.equal(JSON.stringify(described).includes(raw.privateKeyPem), false);
});

test('有效证书直接复用，不再去要配对码', async () => {
  const { credential, dev } = make();
  await credential.ensure({ deviceId: dev.deviceId });
  const before = dev.requests.length;
  const again = await credential.ensure({ deviceId: dev.deviceId });
  assert.equal(again.ok, true);
  assert.equal(again.cached, true);
  assert.equal(dev.requests.length, before, '缓存命中时不该再打 HTTP');
});

test('证书过期后重新配对（不是把过期证书继续用）', async () => {
  const store = tmpStore();
  const now = 1_780_000_000_000;
  let clock = now;
  // 设备的时钟也跟着走：它签的证书必须以「当下」为准，否则重配出来的那张
  // 一落地就是过期的，测试会以为「重配没生效」。
  const dev = fakeDevice(() => clock);
  const first = cred.createPhoneBridgeCredential({
    storePath: store, request: dev.request, baseUrl: 'http://x',
    env: { KHY_PAIR_CODE: '123456' }, now: () => clock, fs, path, os,
  });
  await first.ensure({ deviceId: dev.deviceId });

  clock = now + 24 * 60 * 60 * 1000 + 1;
  const second = cred.createPhoneBridgeCredential({
    storePath: store, request: dev.request, baseUrl: 'http://x',
    env: { KHY_PAIR_CODE: '654321' }, now: () => clock, fs, path, os,
  });
  const res = await second.ensure({ deviceId: dev.deviceId });
  assert.equal(res.ok, true);
  assert.equal(res.paired, true, '过期后必须重新配对');
  assert.equal(second.describe().usable, true);
});

test('没有配对码时报 pairing_code_missing，并说清码在哪看', async () => {
  const { credential, dev } = make({ env: {} });
  const res = await credential.ensure({ deviceId: dev.deviceId });
  assert.equal(res.ok, false);
  assert.equal(res.code, cred.ERR.CODE_MISSING);
  assert.match(res.error, /通知栏/);
});

test('配对被拒时报 pairing_rejected，并带上桥的 code', async () => {
  const now = 1_780_000_000_000;
  const dev = fakeDevice(() => now);
  const request = (opts) => {
    if (opts.url.endsWith('/pair/code')) {
      return { status: 200, ok: true, body: JSON.stringify({ ok: true }) };
    }
    return {
      status: 401,
      ok: false,
      body: JSON.stringify({ ok: false, code: 'pairing_rejected', error: '投递码已过期' }),
    };
  };
  const { credential } = make({ device: dev, request, now });
  const res = await credential.ensure({ deviceId: dev.deviceId });
  assert.equal(res.ok, false);
  assert.equal(res.code, cred.ERR.PAIRING_REJECTED);
  assert.match(res.error, /120 秒/);
});

test('通知被关掉时直说「码发不出来」，不让人一直盯通知栏', async () => {
  const now = 1_780_000_000_000;
  const dev = fakeDevice(() => now);
  const request = (opts) => {
    if (opts.url.endsWith('/pair/code')) {
      return {
        status: 200,
        ok: true,
        body: JSON.stringify({ ok: true, ttl_ms: 120000, notifications_enabled: false }),
      };
    }
    throw new Error('不该走到 /pair：码都没发出来');
  };
  const { credential } = make({ device: dev, request, now, env: {} });
  const res = await credential.ensure({ deviceId: dev.deviceId });
  assert.equal(res.ok, false);
  assert.equal(res.code, cred.ERR.CODE_UNREACHABLE);
  assert.match(res.error, /通知/);
});

test('已给码时不再自己签发一次（签发会作废手里的码）', async () => {
  // 实测踩过的坑：脚本先 /pair/code 拿到码，再交给客户端；客户端内部又调了一次
  // /pair/code，把那个码作废，然后拿作废的码去 /pair → 桥回「投递码不匹配」。
  const { credential, dev } = make();
  await credential.ensure({ deviceId: dev.deviceId });
  const codeRequests = dev.requests.filter((r) => r.url.endsWith('/pair/code'));
  assert.equal(codeRequests.length, 0, '手里有码时不该再签发');
  const pairRequests = dev.requests.filter((r) => r.url.endsWith('/pair'));
  assert.equal(pairRequests.length, 1);
});

test('配对返回的设备与本次连接的设备不一致时报 device_mismatch', async () => {
  // adb 连到另一台手机时，配对会「成功」但签的是另一台——不比对就会把凭据
  // 装到错误的设备上，之后每个请求都 401 而原因看起来像密钥坏了。
  const now = 1_780_000_000_000;
  const dev = fakeDevice(now);
  const { credential } = make({ device: dev, now });
  const res = await credential.ensure({ deviceId: 'ffffffffffffffff' });
  assert.equal(res.ok, false);
  assert.equal(res.code, cred.ERR.DEVICE_MISMATCH);
});

test('invalidate 之后 signedHeaders 立刻拒绝，且盘上文件被删', async () => {
  const { credential, store, dev } = make();
  await credential.ensure({ deviceId: dev.deviceId });
  credential.invalidate();
  assert.equal(fs.existsSync(store), false);
  const signed = credential.signedHeaders({ method: 'POST', path: '/ping', body: '' });
  assert.equal(signed.ok, false);
  assert.equal(signed.code, cred.ERR.PAIRING_REQUIRED);
});

test('没有凭据时 signedHeaders 明确报 pairing_required，不返回空头硬发', async () => {
  const { credential } = make();
  const signed = credential.signedHeaders({ method: 'POST', path: '/ping', body: '' });
  assert.equal(signed.ok, false);
  assert.equal(signed.code, cred.ERR.PAIRING_REQUIRED);
  assert.match(signed.error, /khy phone pair/);
});

test('损坏的凭据文件不炸，落到重新配对', async () => {
  const store = tmpStore();
  fs.writeFileSync(store, '{not json', 'utf8');
  const { credential, dev } = make({ store });
  const res = await credential.ensure({ deviceId: dev.deviceId });
  assert.equal(res.ok, true);
  assert.equal(res.paired, true);
});
