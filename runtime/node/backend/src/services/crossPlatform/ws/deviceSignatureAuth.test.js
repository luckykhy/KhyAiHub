'use strict';

/**
 * deviceSignatureAuth.test.js — the device-signature auth path, exercised with a
 * real EC P-256 keypair and real ECDSA signatures.
 *
 * Why real crypto instead of stubs: the thing that can silently break here is
 * the *agreement* between two languages on three details — the device id
 * derivation, the signed payload, and the signature encoding (DER vs raw r||s).
 * A stub that returns `true` verifies none of them. Node's own keypair plus
 * `crypto.sign` is the cheapest way to catch a mismatch before it shows up as
 * `signature_invalid` on a phone.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const auth = require('./deviceSignatureAuth');

const NOW = 1_780_000_000_000; // fixed clock: skew and replay are time rules

function newDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyB64 = der.toString('base64');
  const deviceId = auth.deriveDeviceId(der);
  const sign = (ts) =>
    crypto
      .sign('sha256', Buffer.from(auth.payloadOf(deviceId, ts), 'utf8'), {
        key: privateKey,
        dsaEncoding: 'der',
      })
      .toString('base64');
  return { der, publicKeyB64, deviceId, privateKey, sign };
}

function freshRegistry(now = NOW) {
  return new auth.DeviceKeyRegistry({ now: () => now });
}

test('登记 + 验签：同一把密钥签出的帧能通过，且归属登记它的用户', () => {
  const dev = newDevice();
  const reg = freshRegistry();
  const enrolled = reg.enroll({
    deviceId: dev.deviceId,
    publicKey: dev.publicKeyB64,
    userId: 'u-1',
    platform: 'android',
    deviceName: 'Pixel',
  });
  assert.strictEqual(enrolled.ok, true);
  assert.strictEqual(enrolled.alreadyEnrolled, false);

  const verdict = reg.verifyAuthFrame({
    deviceId: dev.deviceId,
    publicKey: dev.publicKeyB64,
    ts: NOW,
    sig: dev.sign(NOW),
  });
  assert.strictEqual(verdict.ok, true, JSON.stringify(verdict));
  assert.strictEqual(verdict.userId, 'u-1');
  assert.strictEqual(verdict.deviceId, dev.deviceId);
});

test('device_id 必须等于公钥指纹：自称别的 id 一律拒', () => {
  // 这条是整条链的地基：如果服务端信帧里的 deviceId，攻击者只要抄一个别人的
  // id 再配自己的公钥，就能「成为」那台设备。
  const dev = newDevice();
  const reg = freshRegistry();
  reg.enroll({ deviceId: dev.deviceId, publicKey: dev.publicKeyB64, userId: 'u-1' });

  const verdict = reg.verifyAuthFrame({
    deviceId: 'ffffffffffffffff',
    publicKey: dev.publicKeyB64,
    ts: NOW,
    sig: dev.sign(NOW),
  });
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.code, auth.ERR.KEY_MISMATCH);
});

test('未登记的设备一律拒（未鉴权 socket 不能自己创造信任）', () => {
  const dev = newDevice();
  const reg = freshRegistry();
  const verdict = reg.verifyAuthFrame({
    deviceId: dev.deviceId,
    publicKey: dev.publicKeyB64,
    ts: NOW,
    sig: dev.sign(NOW),
  });
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.code, auth.ERR.NOT_ENROLLED);
});

test('ts 超出窗口拒：太久以前与太远未来都不算数', () => {
  const dev = newDevice();
  const reg = freshRegistry();
  reg.enroll({ deviceId: dev.deviceId, publicKey: dev.publicKeyB64, userId: 'u-1' });

  const stale = NOW - auth.MAX_SKEW_MS - 1;
  const future = NOW + auth.MAX_SKEW_MS + 1;
  for (const ts of [stale, future]) {
    const verdict = reg.verifyAuthFrame({
      deviceId: dev.deviceId,
      publicKey: dev.publicKeyB64,
      ts,
      sig: dev.sign(ts),
    });
    assert.strictEqual(verdict.ok, false, `ts=${ts} 应被拒`);
    assert.strictEqual(verdict.code, auth.ERR.STALE_TS);
  }
});

test('同一 (deviceId, ts) 重放拒：窗口内的帧也只有一次机会', () => {
  // 只靠 skew 窗口不够：10 秒前抓到的帧仍在窗口内，重发一次就能再认证一条
  // socket。所以窗口与一次性必须同时成立。
  const dev = newDevice();
  const reg = freshRegistry();
  reg.enroll({ deviceId: dev.deviceId, publicKey: dev.publicKeyB64, userId: 'u-1' });
  const frame = {
    deviceId: dev.deviceId,
    publicKey: dev.publicKeyB64,
    ts: NOW,
    sig: dev.sign(NOW),
  };
  assert.strictEqual(reg.verifyAuthFrame(frame).ok, true);
  const second = reg.verifyAuthFrame(frame);
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.code, auth.ERR.REPLAY);
});

test('签名不对拒：换一把私钥签同一段 payload', () => {
  const dev = newDevice();
  const other = newDevice();
  const reg = freshRegistry();
  reg.enroll({ deviceId: dev.deviceId, publicKey: dev.publicKeyB64, userId: 'u-1' });

  const verdict = reg.verifyAuthFrame({
    deviceId: dev.deviceId,
    publicKey: dev.publicKeyB64,
    ts: NOW,
    // other 的 id 与 dev 不同，但这里只借它的私钥签 dev 的 payload。
    sig: crypto
      .sign('sha256', Buffer.from(auth.payloadOf(dev.deviceId, NOW), 'utf8'), {
        key: other.privateKey,
        dsaEncoding: 'der',
      })
      .toString('base64'),
  });
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.code, auth.ERR.BAD_SIGNATURE);
});

test('公钥不是 P-256 SPKI 一律拒，且不抛', () => {
  const reg = freshRegistry();
  for (const bad of ['', 'not-base64!!', Buffer.alloc(8).toString('base64')]) {
    const verdict = reg.verifyAuthFrame({
      deviceId: 'abc',
      publicKey: bad,
      ts: NOW,
      sig: 'x',
    });
    assert.strictEqual(verdict.ok, false);
    assert.ok(
      [auth.ERR.MISSING, auth.ERR.BAD_KEY].includes(verdict.code),
      `unexpected code ${verdict.code}`,
    );
  }
});

test('吊销后立刻失效（删设备不能只删界面）', () => {
  const dev = newDevice();
  const reg = freshRegistry();
  reg.enroll({ deviceId: dev.deviceId, publicKey: dev.publicKeyB64, userId: 'u-1' });
  assert.strictEqual(reg.forget(dev.deviceId), true);
  const verdict = reg.verifyAuthFrame({
    deviceId: dev.deviceId,
    publicKey: dev.publicKeyB64,
    ts: NOW,
    sig: dev.sign(NOW),
  });
  assert.strictEqual(verdict.code, auth.ERR.NOT_ENROLLED);
});

test('重复登记同一把公钥是幂等的，不换属主', () => {
  const dev = newDevice();
  const reg = freshRegistry();
  reg.enroll({ deviceId: dev.deviceId, publicKey: dev.publicKeyB64, userId: 'u-1' });
  const again = reg.enroll({
    deviceId: dev.deviceId,
    publicKey: dev.publicKeyB64,
    userId: 'u-2',
    deviceName: '改名了',
  });
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.alreadyEnrolled, true);
  assert.strictEqual(reg.lookup(dev.deviceId).userId, 'u-1');
  assert.strictEqual(reg.lookup(dev.deviceId).deviceName, '改名了');
});

test('同一 deviceId 换公钥被拒：换公钥就是换身份', () => {
  const a = newDevice();
  const b = newDevice();
  const reg = freshRegistry();
  reg.enroll({ deviceId: a.deviceId, publicKey: a.publicKeyB64, userId: 'u-1' });
  const verdict = reg.enroll({
    deviceId: a.deviceId,
    publicKey: b.publicKeyB64,
    userId: 'u-1',
  });
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.code, auth.ERR.DEVICE_ID_MISMATCH);
});

// ===== §3.8 错误码细化（红先绿后）=====
// 任务把 signature_invalid 拆成 6 个可区分细码：payload_mismatch / key_mismatch /
// encoding_mismatch / clock_skew / expired / nonce_replay。下列断言细码字面量，
// 当前实现返回粗码 → 红；细化后 → 绿。expired 属 PC 证书面（DeviceIdentity.java，
// APK 耦合），不在本 Node harness 内，见 canonical-signing-spec.md §3 T-e。
// 复用上方 newDevice/freshRegistry，不另起 harness。

test('§3.8 T-a 签名验不过 → payload_mismatch（不是笼统 signature_invalid）', () => {
  const dev = newDevice();
  const other = newDevice();
  const reg = freshRegistry();
  reg.enroll({ deviceId: dev.deviceId, publicKey: dev.publicKeyB64, userId: 'u-1' });
  const verdict = reg.verifyAuthFrame({
    deviceId: dev.deviceId,
    publicKey: dev.publicKeyB64,
    ts: NOW,
    sig: crypto
      .sign('sha256', Buffer.from(auth.payloadOf(dev.deviceId, NOW), 'utf8'), {
        key: other.privateKey,
        dsaEncoding: 'der',
      })
      .toString('base64'),
  });
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.code, 'payload_mismatch');
});

test('§3.8 T-b 呈现公钥不符注册身份 → key_mismatch', () => {
  const dev = newDevice();
  const other = newDevice();
  const reg = freshRegistry();
  reg.enroll({ deviceId: dev.deviceId, publicKey: dev.publicKeyB64, userId: 'u-1' });
  const verdict = reg.verifyAuthFrame({
    deviceId: dev.deviceId,
    publicKey: other.publicKeyB64,
    ts: NOW,
    sig: other.sign(NOW),
  });
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.code, 'key_mismatch');
});

test('§3.8 T-c 公钥 base64 损坏 → encoding_mismatch', () => {
  const reg = freshRegistry();
  const verdict = reg.verifyAuthFrame({
    deviceId: 'abc',
    publicKey: 'not-base64!!',
    ts: NOW,
    sig: 'x',
  });
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.code, 'encoding_mismatch');
});

test('§3.8 T-d ts 超窗 → clock_skew（不是 timestamp_out_of_window）', () => {
  const dev = newDevice();
  const reg = freshRegistry();
  reg.enroll({ deviceId: dev.deviceId, publicKey: dev.publicKeyB64, userId: 'u-1' });
  const ts = NOW - auth.MAX_SKEW_MS - 1;
  const verdict = reg.verifyAuthFrame({
    deviceId: dev.deviceId,
    publicKey: dev.publicKeyB64,
    ts,
    sig: dev.sign(ts),
  });
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.code, 'clock_skew');
});

test('§3.8 T-f 同帧重放 → nonce_replay（不是 replay_detected）', () => {
  const dev = newDevice();
  const reg = freshRegistry();
  reg.enroll({ deviceId: dev.deviceId, publicKey: dev.publicKeyB64, userId: 'u-1' });
  const frame = {
    deviceId: dev.deviceId,
    publicKey: dev.publicKeyB64,
    ts: NOW,
    sig: dev.sign(NOW),
  };
  assert.strictEqual(reg.verifyAuthFrame(frame).ok, true);
  const second = reg.verifyAuthFrame(frame);
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.code, 'nonce_replay');
});

test('§3.1/§3.4 device_id 派生公式：sha256(SPKI DER) 前 8 字节 hex，与独立计算逐字节相等', () => {
  // 地基：Android computeDeviceId 与服务端 deriveDeviceId 必须同公式，否则合法
  // 设备会在现场读成 device_id_mismatch。合成向量锁住「sha256 前 8 字节」防回归。
  const dev = newDevice();
  const independent = crypto.createHash('sha256').update(dev.der).digest('hex').slice(0, 16);
  assert.strictEqual(dev.deviceId, independent);
  assert.strictEqual(auth.deriveDeviceId(dev.der), independent);
  assert.match(dev.deviceId, /^[0-9a-f]{16}$/);
});

test('§3.3 base64 编码契约：标准为准，URL-safe/无 padding 容忍且派生同一 device_id（实测）', () => {
  // 实测 red/S3-3-encoding-characterization.txt：pubkey 路径显式归一化 -/_，sig
  // 路径靠 Node base64 原生容忍 URL-safe，两者解码到同一字节、签名仍全验。编码
  // 容忍 != 放宽验签。取含 + 与 / 的向量，确保 URL-safe 分支真被走到。
  let dev = newDevice();
  for (let i = 0; i < 64 && !(dev.publicKeyB64.includes('+') && dev.publicKeyB64.includes('/')); i++) {
    dev = newDevice();
  }
  assert.ok(dev.publicKeyB64.includes('+') && dev.publicKeyB64.includes('/'), '需要含 +// 的向量');
  const std = dev.publicKeyB64;
  const variants = [
    ['standard', std],
    ['url-safe', std.replace(/\+/g, '-').replace(/\//g, '_')],
    ['no-pad', std.replace(/=+$/, '')],
  ];
  for (const [label, enc] of variants) {
    const parsed = auth.parsePublicKey(enc);
    assert.strictEqual(parsed.ok, true, label);
    assert.strictEqual(parsed.deviceId, dev.deviceId, label);
    assert.ok(parsed.der.equals(dev.der), label);
  }
  const key = auth.parsePublicKey(std).key;
  const sigStd = dev.sign(NOW);
  const sigUrl = sigStd.replace(/\+/g, '-').replace(/\//g, '_');
  assert.strictEqual(auth.verifySignature(key, dev.deviceId, NOW, sigStd), true);
  assert.strictEqual(auth.verifySignature(key, dev.deviceId, NOW, sigUrl), true);
});
