'use strict';

/**
 * deviceRegistrationFlow.test.js — S0 名额语义与登记来源。
 *
 * 本文件按**行为**命名，不占用任务书 T 编号：仓库内两张 T 表
 * （canonical-signing-spec §4 T1-T6、delivery-table-T1-T18）都是签名鉴权/
 * 同步/抓包批次，S0「登记与名额」批次的 T1-T4 定义不在仓内，编号真源待
 * 任务书方钉住（见 feedback/device-id-reregister-s0-20261117/differential.md）。
 * 任务书已明确的 T3 判据是设备侧「同一构建连装两次、两次 status.json 的
 * identity.device_id 不变」，其运行器是
 * feedback/.../run-t3-device-criterion.cjs（本机无设备时如实报 blocked）。
 *
 * 这里覆盖的四个行为：
 *   · 缺省不限／名额满只拒新设备、既有设备原样在册且可鉴权（不顶人）
 *   · 满员时同 key 幂等重登不占名额；换 key 仍按 device_id_mismatch 拒
 *   · forget 腾位后新设备能进（腾位是显式动作，无自动淘汰）
 *   · enroll 记录 regSource(auto|manual) 与 registeredAt（status 的服务端真源）
 *
 * 真 EC P-256 + 真 ECDSA，理由同 deviceSignatureAuth.test.js：这里会静默坏掉
 * 的是跨语言（Java/Dart/Node）的派生与签名约定，桩测不出来。
 */

const crypto = require('crypto');
const assert = require('node:assert');
const test = require('node:test');

const auth = require('./deviceSignatureAuth');

const NOW = 1_780_000_000_000;

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

function freshRegistry(opts = {}, now = NOW) {
  return new auth.DeviceKeyRegistry({ now: () => now, ...opts });
}

function enroll(reg, dev, extra = {}) {
  return reg.enroll({
    deviceId: dev.deviceId,
    publicKey: dev.publicKeyB64,
    userId: 'u-1',
    platform: 'android',
    deviceName: 'Pixel',
    ...extra,
  });
}

function authOk(reg, dev, ts = NOW) {
  return reg.verifyAuthFrame({
    deviceId: dev.deviceId,
    publicKey: dev.publicKeyB64,
    ts,
    sig: dev.sign(ts),
  });
}

// ── 名额：满则拒、不顶人；腾位是显式动作 ────────────────────────────────

test('缺省 maxDevices＝不限：三台都能登记', () => {
  const reg = freshRegistry();
  const devices = [newDevice(), newDevice(), newDevice()];
  for (const dev of devices) {
    const r = enroll(reg, dev);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.alreadyEnrolled, false);
  }
  assert.strictEqual(reg.list().length, 3);
});

test('maxDevices=2：第三台被拒 device_slots_full，且既有两台原样在册', () => {
  const reg = freshRegistry({ maxDevices: 2 });
  const a = newDevice();
  const b = newDevice();
  const c = newDevice();
  assert.strictEqual(enroll(reg, a).ok, true);
  assert.strictEqual(enroll(reg, b).ok, true);

  const rejected = enroll(reg, c);
  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.code, 'device_slots_full');

  // 「不顶人」：被拒的那一刻，既有设备一个都没掉，而且仍能通过鉴权。
  assert.deepStrictEqual(
    reg.list().map((row) => row.deviceId).sort(),
    [a.deviceId, b.deviceId].sort(),
  );
  assert.strictEqual(authOk(reg, a).ok, true);
  assert.strictEqual(authOk(reg, b, NOW + 1).ok, true);
});

test('名额满时同 key 幂等重登仍成功：不占新名额、不拒已认识设备', () => {
  const reg = freshRegistry({ maxDevices: 1 });
  const a = newDevice();
  assert.strictEqual(enroll(reg, a).ok, true);
  const again = enroll(reg, a, { deviceName: '改名了' });
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.alreadyEnrolled, true);
  assert.strictEqual(reg.list().length, 1);
  assert.strictEqual(reg.lookup(a.deviceId).deviceName, '改名了');
});

test('名额满时换 key 仍被拒（device_id_mismatch），且不消耗名额', () => {
  // enroll 的闸门顺序：claimed id ≠ 新 key 派生 id → device_id_mismatch 先于
  // 一切名额判断。这条钉的是「名额语义不放宽安全语义」：满了也不能让换 key 的
  // 请求把既有设备顶掉。
  const reg = freshRegistry({ maxDevices: 1 });
  const a = newDevice();
  const b = newDevice();
  enroll(reg, a);
  const swapped = reg.enroll({
    deviceId: a.deviceId,
    publicKey: b.publicKeyB64,
    userId: 'u-1',
  });
  assert.strictEqual(swapped.ok, false);
  assert.strictEqual(swapped.code, auth.ERR.DEVICE_ID_MISMATCH);
  assert.strictEqual(reg.list().length, 1);
  assert.strictEqual(authOk(reg, a).ok, true);
});

test('forget 腾位后新设备能进（腾位是显式动作，不做自动淘汰）', () => {
  const reg = freshRegistry({ maxDevices: 1 });
  const a = newDevice();
  const b = newDevice();
  assert.strictEqual(enroll(reg, a).ok, true);
  assert.strictEqual(enroll(reg, b).code, 'device_slots_full');
  assert.strictEqual(reg.forget(a.deviceId), true);
  const r = enroll(reg, b);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.alreadyEnrolled, false);
});

// ── T2 登记来源与最后登记时刻（status 的服务端真源）─────────────────────

test('新登记记录 source=auto 与 registeredAt', () => {
  const reg = freshRegistry();
  const dev = newDevice();
  const r = enroll(reg, dev, { source: 'auto' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.regSource, 'auto');
  assert.strictEqual(r.registeredAt, NOW);
  const row = reg.get(dev.deviceId);
  assert.strictEqual(row.regSource, 'auto');
  assert.strictEqual(row.registeredAt, NOW);
});

test('幂等重登刷新 registeredAt，并接受新的 source', () => {
  let clock = NOW;
  const reg = new auth.DeviceKeyRegistry({ now: () => clock });
  const dev = newDevice();
  assert.strictEqual(enroll(reg, dev, { source: 'manual' }).regSource, 'manual');

  clock = NOW + 5000;
  const again = enroll(reg, dev, { source: 'auto' });
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.alreadyEnrolled, true);
  assert.strictEqual(again.regSource, 'auto');
  assert.strictEqual(again.registeredAt, NOW + 5000);
});

test('未给 source 时按 manual 记（账号 REST 登记面的既有语义）', () => {
  const reg = freshRegistry();
  const dev = newDevice();
  const r = enroll(reg, dev);
  assert.strictEqual(r.regSource, 'manual');
  assert.strictEqual(reg.get(dev.deviceId).regSource, 'manual');
});
