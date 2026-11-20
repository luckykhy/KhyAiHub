'use strict';

/**
 * deviceRegistryShared.test.js — 产品面的共享登记表（getRegistry）必须落盘并套名额。
 *
 * 背景（验收复审点）：`syncServer.js` 与 `routes/crossPlatform.js` 都走
 * `getRegistry()` 的进程内单例，进程重启即忘（设备拿同一把 key 却被
 * device_not_enrolled）；账号 REST 登记面也不套名额。本套件钉住：
 *   · 缺省 stateFile 落在项目数据家（重启后仍认得已登记设备）
 *   · 缺省名额取 serviceDefaults（KHY_DEVICE_LINK_MAX_DEVICES），满则拒且不顶人
 *
 * 环境变量必须在 require 之前设：serviceDefaults 在模块加载时读取名额，
 * dataHome 的解析也以进程环境为准。本文件由 node --test 单独成进程运行。
 */

const crypto = require('crypto');
const fs = require('fs');
const assert = require('node:assert');
const test = require('node:test');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-dev-registry-'));
process.env.KHY_PROJECT_DATA_HOME = path.join(TMP, 'project');
process.env.KHY_DATA_HOME = path.join(TMP, 'data');
process.env.KHY_DEVICE_LINK_MAX_DEVICES = '2';

const auth = require('./deviceSignatureAuth');

const STATE_FILE = path.join(
  process.env.KHY_PROJECT_DATA_HOME,
  'T1-domains',
  '_unsorted',
  'bridge',
  'device-keys.json',
);

function resetShared() {
  auth.setRegistry(null);
  try { fs.rmSync(path.join(process.env.KHY_PROJECT_DATA_HOME, 'T1-domains'), { recursive: true, force: true }); } catch { /* fresh */ }
}

function newDevice() {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { deviceId: auth.deriveDeviceId(der), publicKeyB64: der.toString('base64') };
}

function enroll(reg, dev, extra = {}) {
  return reg.enroll({
    deviceId: dev.deviceId,
    publicKey: dev.publicKeyB64,
    userId: 'u-1',
    platform: 'android',
    ...extra,
  });
}

test('deviceLinkWss 的缺省登记文件与共享登记表同源（单点落点）', () => {
  assert.strictEqual(auth.defaultDeviceKeyStateFile(), STATE_FILE);
});

test('共享登记表缺省落盘：模拟进程重启后仍认得已登记设备', () => {
  resetShared();
  const dev = newDevice();
  const r1 = auth.getRegistry();
  const enrolled = enroll(r1, dev);
  assert.strictEqual(enrolled.ok, true, JSON.stringify(enrolled));
  assert.strictEqual(fs.existsSync(STATE_FILE), true, `登记应写进 ${STATE_FILE}`);

  // 模拟进程重启：单例归零，新的 registry 只能从盘上恢复。
  auth.setRegistry(null);
  const r2 = auth.getRegistry();
  assert.strictEqual(Boolean(r2.get(dev.deviceId)), true, '重启后应记得这台设备');
  assert.strictEqual(r2.list().length, 1);
});

test('共享登记表缺省套名额：第三台被拒 device_slots_full，前两台原样在册', () => {
  resetShared();
  const a = newDevice();
  const b = newDevice();
  const c = newDevice();
  const reg = auth.getRegistry();
  assert.strictEqual(enroll(reg, a).ok, true);
  assert.strictEqual(enroll(reg, b).ok, true);

  const rejected = enroll(reg, c);
  assert.strictEqual(rejected.ok, false);
  assert.strictEqual(rejected.code, auth.ERR.SLOTS_FULL);
  assert.deepStrictEqual(reg.list().map((r) => r.deviceId).sort(), [a.deviceId, b.deviceId].sort());
});

test('共享登记表：名额满时同 key 幂等重登仍成功（不占新名额）', () => {
  resetShared();
  const a = newDevice();
  const reg = auth.getRegistry();
  assert.strictEqual(enroll(reg, a).ok, true);
  const again = enroll(reg, a, { source: 'auto' });
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.alreadyEnrolled, true);
  assert.strictEqual(again.regSource, 'auto');
  assert.strictEqual(reg.list().length, 1);
});
