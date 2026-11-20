'use strict';

/**
 * deviceSignatureAuth.js — verify a device's own signature instead of a shared token.
 *
 * <h2>Why this file exists</h2>
 * The bridge used to authenticate with a 32-hex Bearer token stored at
 * `/sdcard/bridge-amoobridge/token.txt`. Anyone with a storage permission, an
 * adb shell, or a cable could read it, so "holds the token" never was a claim
 * about *who* is calling. The device now holds an EC P-256 keypair whose
 * private half never leaves the app's private directory, and signs
 * `deviceId|ts` per connection.
 *
 * <h2>Why the server must not trust `deviceId` from the frame</h2>
 * Accepting the device's self-declared id on first sight is worse than a token:
 * an attacker would simply claim someone else's id. So the id is *derived* from
 * the presented public key, and that derived id must (a) equal the frame's
 * `deviceId` and (b) already be enrolled by an authenticated user. Enrollment
 * happens over the authenticated REST surface (`POST /devices/register`), not
 * over this socket — an unauthenticated socket cannot create trust.
 *
 * <h2>Why the derivation matches the client byte for byte</h2>
 * `DeviceIdentity.computeDeviceId` (Android) hashes the SPKI DER and keeps the
 * first 8 bytes as hex. Two independent derivations of "the same" id is exactly
 * how a valid device starts reading as `device_id_mismatch` in the field, so the
 * formula lives in one comment here and one method there, both spelled out.
 *
 * <h2>Replay</h2>
 * `ts` must be within {@link MAX_SKEW_MS} of server time, and each
 * `(deviceId, ts)` pair is single-use for the lifetime of the process. A skew
 * window alone is not enough: a frame captured 10 seconds ago is still inside
 * the window, and re-sending it would re-authenticate a second socket.
 */

const crypto = require('crypto');

const { DEVICE_LINK_MAX_DEVICES } = require('../../../constants/serviceDefaults');

/** ±5 minutes. Wide enough for a phone whose clock drifts, narrow enough to bound replay. */
const MAX_SKEW_MS = 5 * 60 * 1000;

/** How many `(deviceId, ts)` pairs to remember for replay rejection. */
const SEEN_LIMIT = 4096;

const ERR = {
  MISSING: 'signature_missing',
  // §3.8: split the coarse signature_invalid into receipt-distinguishable codes
  // so the client can tell "key wrong" from "clock off" from "replay" apart.
  BAD_KEY: 'encoding_mismatch', // base64/DER decode failure (§3.3)
  DEVICE_ID_MISMATCH: 'device_id_mismatch', // enroll face: claimed id != derived id
  NOT_ENROLLED: 'device_not_enrolled',
  BAD_SIGNATURE: 'payload_mismatch', // signed payload / signature mismatch (§3.1)
  STALE_TS: 'clock_skew', // ts outside the 300s window (§3.5)
  REPLAY: 'nonce_replay', // same (deviceId, ts) frame replayed (§3.7)
  KEY_CHANGED: 'key_mismatch', // presented key != enrolled key (§3.4)
  KEY_MISMATCH: 'key_mismatch', // verify face: claimed id != derived id, or wrong curve
  // 名额满：只拒绝新设备，不做淘汰。既有登记一个都不动——「顶掉别人」在这里
  // 等于把一台正在用的手机静默下线，而它没有任何办法自己发现。
  SLOTS_FULL: 'device_slots_full',
};

/**
 * `sha256(spkiDer)` first 8 bytes as lowercase hex — the same 16-char id the
 * Android side computes in `DeviceIdentity.computeDeviceId`.
 *
 * @param {Buffer} spkiDer
 * @returns {string}
 */
function deriveDeviceId(spkiDer) {
  return crypto.createHash('sha256').update(spkiDer).digest('hex').slice(0, 16);
}

/**
 * @param {string} b64 SPKI DER, base64 (standard alphabet, no wrap).
 * @returns {{ok: true, key: crypto.KeyObject, der: Buffer, deviceId: string}
 *          | {ok: false, code: string}}
 */
function parsePublicKey(b64) {
  const text = String(b64 || '').trim();
  if (!text) return { ok: false, code: ERR.MISSING };
  let der;
  try {
    der = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } catch {
    return { ok: false, code: ERR.BAD_KEY };
  }
  if (!der || der.length < 32) return { ok: false, code: ERR.BAD_KEY };
  let key;
  try {
    key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    return { ok: false, code: ERR.BAD_KEY };
  }
  // Only P-256: the client generates secp256r1, and accepting anything else
  // would silently widen the contract to curves nobody tested. A valid decode
  // with the wrong type/curve is a key problem, not an encoding problem (§3.8).
  if (key.asymmetricKeyType !== 'ec') return { ok: false, code: ERR.KEY_MISMATCH };
  const curve = key.asymmetricKeyDetails && key.asymmetricKeyDetails.namedCurve;
  if (curve && curve !== 'prime256v1' && curve !== 'secp256r1') {
    return { ok: false, code: ERR.KEY_MISMATCH };
  }
  return { ok: true, key, der, deviceId: deriveDeviceId(der) };
}

/** The exact bytes the client signs. Kept identical to `MainActivity.bridgeLinkConfig`. */
function payloadOf(deviceId, ts) {
  return `${deviceId}|${ts}`;
}

/**
 * Verifies `sig` over `deviceId|ts`.
 *
 * @param {crypto.KeyObject} key
 * @param {string} deviceId
 * @param {number|string} ts
 * @param {string} sigB64 base64 DER ECDSA signature.
 * @returns {boolean}
 */
function verifySignature(key, deviceId, ts, sigB64) {
  try {
    const sig = Buffer.from(String(sigB64 || ''), 'base64');
    if (!sig.length) return false;
    return crypto.verify(
      'sha256',
      Buffer.from(payloadOf(deviceId, ts), 'utf8'),
      { key, dsaEncoding: 'der' },
      sig,
    );
  } catch {
    return false;
  }
}

/**
 * Registry of device public keys, each bound to the user who enrolled it.
 *
 * <p>Enrollment is an authenticated act: it happens on the REST surface where
 * `req.user` exists. This class only stores the result and answers "does this
 * key belong to this device, and to whom".
 */
class DeviceKeyRegistry {
  /**
   * @param {{stateFile?: string|null, now?: () => number, maxDevices?: number}} [opts]
   *        `stateFile` is optional: without it the registry is process-local,
   *        which is enough for tests and for a server that re-enrolls on boot.
   *        `maxDevices` 缺省＝不限；>0 时只限制**新** deviceId 的登记。
   */
  constructor(opts = {}) {
    this._byDeviceId = new Map();
    this._seen = new Map(); // deviceId → Set<ts>
    this._stateFile = opts.stateFile || null;
    this._now = opts.now || (() => Date.now());
    this._maxDevices = Number(opts.maxDevices) > 0 ? Math.floor(Number(opts.maxDevices)) : 0;
    if (this._stateFile) this._load();
  }

  /**
   * Bind a public key to a device id for a user.
   *
   * <p>Re-enrolling the *same* key for the same user is idempotent (the PC may
   * register on every connect). Enrolling a *different* key for an existing
   * device id is refused: that is either a reinstall (the device id changes
   * with the key, so it cannot collide) or an attempt to take over the id.
   *
   * <p>`source` 记「谁把这条登记写进来的」：`auto`＝设备自动重新登记（S0），
   * `manual`＝人显式登记（账号 REST 面的既有语义）。同一台设备幂等重登会刷新
   * `registeredAt` 与 `source`——这正是「自动重新登记」要的那条时间线。
   *
   * @param {{deviceId: string, publicKey: string, userId: string,
   *          platform?: string, deviceName?: string, source?: string}} args
   * @returns {{ok: true, deviceId: string, alreadyEnrolled: boolean,
   *          regSource: string, registeredAt: number}
   *          | {ok: false, code: string}}
   */
  enroll({ deviceId, publicKey, userId, platform, deviceName, source }) {
    const parsed = parsePublicKey(publicKey);
    if (!parsed.ok) return parsed;
    const claimed = String(deviceId || '').trim();
    if (claimed && claimed !== parsed.deviceId) {
      return { ok: false, code: ERR.DEVICE_ID_MISMATCH };
    }
    if (!userId) return { ok: false, code: 'user_required' };

    const existing = this._byDeviceId.get(parsed.deviceId);
    if (existing) {
      if (existing.publicKey !== String(publicKey).trim()) {
        return { ok: false, code: ERR.KEY_CHANGED };
      }
      // Same key, possibly a different name/platform: refresh the display
      // fields but never the owner — a second user must not inherit a device
      // by re-registering it.
      existing.platform = platform || existing.platform;
      existing.deviceName = deviceName || existing.deviceName;
      existing.lastSeenAt = this._now();
      existing.regSource = source === 'auto' ? 'auto' : 'manual';
      existing.registeredAt = this._now();
      this._save();
      return {
        ok: true,
        deviceId: parsed.deviceId,
        alreadyEnrolled: true,
        regSource: existing.regSource,
        registeredAt: existing.registeredAt,
      };
    }

    // 名额闸门放在「确定是新设备」之后：已知设备永远进得来（幂等分支），只有
    // 新 id 才消耗名额。拒绝时什么都不删——没有淘汰路径，这就是「不顶人」。
    if (this._maxDevices > 0 && this._byDeviceId.size >= this._maxDevices) {
      return { ok: false, code: ERR.SLOTS_FULL };
    }
    const registeredAt = this._now();
    this._byDeviceId.set(parsed.deviceId, {
      deviceId: parsed.deviceId,
      publicKey: String(publicKey).trim(),
      userId: String(userId),
      platform: platform || 'android',
      deviceName: deviceName || '',
      enrolledAt: registeredAt,
      lastSeenAt: registeredAt,
      regSource: source === 'auto' ? 'auto' : 'manual',
      registeredAt,
    });
    this._save();
    return {
      ok: true,
      deviceId: parsed.deviceId,
      alreadyEnrolled: false,
      regSource: source === 'auto' ? 'auto' : 'manual',
      registeredAt,
    };
  }

  /** @returns {{userId: string, platform: string, deviceName: string}|null} */
  lookup(deviceId) {
    const row = this._byDeviceId.get(String(deviceId || ''));
    if (!row) return null;
    return { userId: row.userId, platform: row.platform, deviceName: row.deviceName };
  }

  get(deviceId) {
    return this._byDeviceId.get(String(deviceId || '')) || null;
  }

  list() {
    return [...this._byDeviceId.values()].map((r) => ({ ...r }));
  }

  forget(deviceId) {
    const id = String(deviceId || '');
    const had = this._byDeviceId.delete(id);
    this._seen.delete(id);
    if (had) this._save();
    return had;
  }

  clear() {
    this._byDeviceId.clear();
    this._seen.clear();
    this._save();
  }

  /**
   * Verify a whole auth frame.
   *
   * Order: shape → key → derived id vs claimed id → enrollment → ts window →
   * replay → signature. Signature goes last among the cryptographic checks
   * because it is the expensive one, and it goes *after* enrollment so an
   * unenrolled key never reaches the verifier at all.
   *
   * @param {{deviceId: string, publicKey: string, ts: number|string, sig: string}} frame
   * @returns {{ok: true, userId: string, deviceId: string, platform: string, deviceName: string}
   *          | {ok: false, code: string}}
   */
  verifyAuthFrame(frame) {
    const f = frame || {};
    const parsed = parsePublicKey(f.publicKey);
    if (!parsed.ok) return parsed;

    const claimed = String(f.deviceId || '').trim();
    if (!claimed || claimed !== parsed.deviceId) {
      return { ok: false, code: ERR.KEY_MISMATCH };
    }
    const enrolled = this._byDeviceId.get(parsed.deviceId);
    if (!enrolled) return { ok: false, code: ERR.NOT_ENROLLED };
    if (enrolled.publicKey !== String(f.publicKey).trim()) {
      return { ok: false, code: ERR.KEY_CHANGED };
    }

    const ts = Number(f.ts);
    if (!Number.isFinite(ts) || ts <= 0) return { ok: false, code: ERR.STALE_TS };
    const now = this._now();
    if (Math.abs(now - ts) > MAX_SKEW_MS) return { ok: false, code: ERR.STALE_TS };

    let seen = this._seen.get(parsed.deviceId);
    if (!seen) {
      seen = new Set();
      this._seen.set(parsed.deviceId, seen);
    }
    if (seen.has(ts)) return { ok: false, code: ERR.REPLAY };

    if (!verifySignature(parsed.key, claimed, ts, f.sig)) {
      return { ok: false, code: ERR.BAD_SIGNATURE };
    }

    seen.add(ts);
    if (seen.size > SEEN_LIMIT) {
      // Drop the oldest insertions; the set iterates in insertion order.
      const drop = seen.size - SEEN_LIMIT;
      let i = 0;
      for (const v of seen) {
        if (i++ >= drop) break;
        seen.delete(v);
      }
    }
    enrolled.lastSeenAt = now;
    return {
      ok: true,
      userId: enrolled.userId,
      deviceId: parsed.deviceId,
      platform: enrolled.platform,
      deviceName: enrolled.deviceName,
    };
  }

  _load() {
    try {
      const fs = require('fs');
      if (!fs.existsSync(this._stateFile)) return;
      const raw = JSON.parse(fs.readFileSync(this._stateFile, 'utf8'));
      for (const row of raw.devices || []) {
        if (row && row.deviceId && row.publicKey) this._byDeviceId.set(row.deviceId, row);
      }
    } catch {
      // A corrupt registry must not take the server down; unenrolled devices
      // simply fail closed until the PC registers them again.
    }
  }

  _save() {
    if (!this._stateFile) return;
    try {
      const fs = require('fs');
      const path = require('path');
      fs.mkdirSync(path.dirname(this._stateFile), { recursive: true });
      const tmp = `${this._stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, devices: this.list() }, null, 2), 'utf8');
      fs.renameSync(tmp, this._stateFile);
    } catch {
      // Non-fatal: the in-memory registry still authorises this process.
    }
  }
}

/** Process-wide registry used by syncServer unless a test injects its own. */
let _shared = null;

/**
 * 产品面共享登记表的缺省落点。
 *
 * <p>没有它，主 backend 这一面（syncServer 的签名鉴权 + 账号 REST 登记）
 * 只在进程里存：PC 重启后同一把 key 就被 device_not_enrolled 拒掉——设备侧
 * 看不出区别，只会无限重连。放项目数据家的既有 `bridge` 域，路径逻辑名走
 * DATA_PATHS，不手写 T 档字面量。
 *
 * @returns {string|null} 解析失败返回 null（registry 退回进程内，绝不因
 *          数据家不可用而启动失败）。
 */
function defaultDeviceKeyStateFile() {
  try {
    const { getProjectDataPath } = require('../../../utils/dataHome');
    return getProjectDataPath('bridge', 'device-keys.json');
  } catch {
    return null;
  }
}

function getRegistry(opts) {
  if (!_shared) {
    // 缺省同时接上「落盘」与「名额」：只落盘不套名额，账号 REST 登记面会绕过
    // 名额策略；只套名额不落盘，重启后设备又全被拒。名额是**本进程共享表**
    //（多账号部署下即全局上限），按 KHY_DEVICE_LINK_MAX_DEVICES 可调。
    _shared = new DeviceKeyRegistry(opts || {
      stateFile: defaultDeviceKeyStateFile(),
      maxDevices: DEVICE_LINK_MAX_DEVICES,
    });
  }
  return _shared;
}

function setRegistry(registry) {
  _shared = registry;
}

module.exports = {
  MAX_SKEW_MS,
  SEEN_LIMIT,
  ERR,
  deriveDeviceId,
  parsePublicKey,
  payloadOf,
  verifySignature,
  DeviceKeyRegistry,
  defaultDeviceKeyStateFile,
  getRegistry,
  setRegistry,
};
