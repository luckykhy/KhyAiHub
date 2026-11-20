'use strict';

/**
 * phoneBridgeCredential.js — the PC half of the device-issued credential.
 *
 * <h2>What replaced what</h2>
 * The PC used to learn the bridge secret by `adb shell cat /sdcard/bridge-amoobridge/
 * token.txt`: a permanent 32-hex bearer value sitting on shared storage. Any app with
 * the storage permission, any shell, any cable could read it, so "holds the token"
 * never said anything about *who* was calling. It is now gone from the device.
 *
 * The PC instead:
 *   1. generates its own EC P-256 keypair (private half never leaves the PC),
 *   2. asks the device for a one-time code (`POST /pair/code`; the code appears in the
 *      phone's notification shade, so only someone physically at the phone can read it),
 *   3. exchanges the code + its public key for a device-signed certificate
 *      (`POST /pair`), valid for 24 h,
 *   4. presents that certificate on every request **together with a signature** made by
 *      its own private key.
 *
 * <h2>Why step 4 exists</h2>
 * Without it the certificate is just a new bearer token: copy the JSON, become the PC.
 * The signature is over `METHOD|path|ts|sha256(body)`, so it is bound to one request at
 * one moment — a copied certificate is useless without the private key, and a captured
 * signature is useless for a different path or body.
 *
 * <h2>Why the code is typed by a human</h2>
 * Because the alternative is a code on shared storage, which is the thing being removed.
 * The cost is one code per PC per 24 h, and `KHY_PAIR_CODE` exists so automated runs can
 * supply it without a TTY — the value still has to come from the phone's screen.
 */

const crypto = require('crypto');
const fsDefault = require('fs');
const pathDefault = require('path');
const osDefault = require('os');

const DEFAULT_DIR = '.khyos';
const DEFAULT_FILE = 'phone-bridge-credential.json';

/** Renew when less than this is left, so a request never races the expiry. */
const RENEW_LEAD_MS = 60 * 1000;

const ERR = {
  PAIRING_REQUIRED: 'pairing_required',
  PAIRING_REJECTED: 'pairing_rejected',
  CODE_MISSING: 'pairing_code_missing',
  CODE_UNREACHABLE: 'pairing_code_unreachable',
  DEVICE_UNREACHABLE: 'pairing_device_unreachable',
  DEVICE_MISMATCH: 'device_mismatch',
  CREDENTIAL_EXPIRED: 'credential_expired',
  CERT_INVALID: 'cert_invalid',
  KEY_UNREADABLE: 'credential_key_unreadable',
};

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The exact bytes the PC signs. Kept byte-identical to
 * `HttpBridge.popPayload` — two spellings of "the same" canonical string is how a
 * valid request starts reading as `pop_invalid`.
 */
function popPayload(method, path, ts, body) {
  return `${String(method || 'POST').toUpperCase()}|${path}|${ts}|${sha256Hex(body || '')}`;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.storePath]  Where the credential lives. Defaults to
 *        `~/.khyos/phone-bridge-credential.json` — outside the repo, outside /sdcard.
 * @param {object} [opts.fs]
 * @param {object} [opts.path]
 * @param {object} [opts.os]
 * @param {object} [opts.env]
 * @param {Function} [opts.now]
 * @param {Function} [opts.request]  `(opts) => {status, body, ok}` — the HTTP transport.
 * @param {string} [opts.baseUrl]    e.g. `http://127.0.0.1:8896`.
 * @param {Function} [opts.promptCode] `async () => string`; asked when no cached cert.
 */
function createPhoneBridgeCredential(opts = {}) {
  const fs = opts.fs || fsDefault;
  const path = opts.path || pathDefault;
  const os = opts.os || osDefault;
  const env = opts.env || process.env;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const request = opts.request;
  const storePath = opts.storePath
    || path.join(os.homedir(), DEFAULT_DIR, DEFAULT_FILE);

  let cached = null; // { cert, privateKeyPem, deviceId }

  function _read() {
    if (cached) return cached;
    try {
      if (!fs.existsSync(storePath)) return null;
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      if (!raw || !raw.cert || !raw.privateKeyPem) return null;
      cached = raw;
      return cached;
    } catch {
      // A corrupt store must not be fatal: falling through to pairing is exactly
      // the recovery the operator would do by hand.
      return null;
    }
  }

  function _write(value) {
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const tmp = `${storePath}.tmp`;
      // 0600: the private key is the whole point of this file.
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, storePath);
      cached = value;
      return true;
    } catch {
      return false;
    }
  }

  function invalidate() {
    cached = null;
    try {
      if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
    } catch {
      // Non-fatal: the in-memory copy is already gone, which is what stops the
      // next request from using it.
    }
  }

  function _usable(entry, deviceId) {
    if (!entry || !entry.cert || !entry.privateKeyPem) return false;
    const cert = entry.cert;
    if (!cert.expires_at || cert.expires_at - RENEW_LEAD_MS <= now()) return false;
    if (deviceId && cert.device_id && cert.device_id !== deviceId) return false;
    return true;
  }

  async function _pair(deviceId) {
    if (typeof request !== 'function') {
      return { ok: false, code: ERR.PAIRING_REQUIRED, error: '缺少 HTTP 传输，无法配对' };
    }
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pcKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

    // 先看手上有没有码，再决定要不要去要一个。
    //
    // WHY 顺序不能反：`/pair/code` 是**签发**（issue 会替换掉当前那个有效码），
    // 不是「查一下」。已经有码时再签发一次，等于把手里这个作废——然后拿着作废
    // 的码去 /pair，桥只会回「投递码不匹配」。这个 bug 实测吃过一次：脚本先取码
    // 再交给客户端，客户端内部又取了一次，于是每次都「不匹配」。
    let code = String(env.KHY_PAIR_CODE || '').trim();
    if (!code) {
      const codeRes = await request({
        method: 'POST',
        url: `${opts.baseUrl}/pair/code`,
        headers: {},
        body: '',
        timeoutMs: 10000,
      });
      if (!codeRes || !codeRes.ok) {
        return {
          ok: false,
          code: ERR.DEVICE_UNREACHABLE,
          error: `取配对码失败（${codeRes && codeRes.error ? codeRes.error : `HTTP ${codeRes && codeRes.status}`}）。`
            + '确认 khy phone forward 已就绪、手机上的 khy-os 桥在跑。',
        };
      }
      let codeMeta = null;
      try {
        codeMeta = JSON.parse(codeRes.body || '{}');
      } catch {
        codeMeta = null;
      }
      // 通知被关掉时桥照样回 ok，但码根本没发出去。这时候让人去「看通知栏」
      // 是最糟的提示——他会一直看，一直看不到。桥给了判据就直接说清。
      if (codeMeta && codeMeta.notifications_enabled === false) {
        return {
          ok: false,
          code: ERR.CODE_UNREACHABLE,
          error: '手机把 khy-os 的通知关掉了，配对码发不出来（桥已确认 notifications_enabled=false）。'
            + '先在手机系统设置里允许 khy-os 发通知，再重新取码。',
        };
      }
      if (typeof opts.promptCode === 'function') {
        code = String((await opts.promptCode()) || '').trim();
      }
    }
    if (!code) {
      return {
        ok: false,
        code: ERR.CODE_MISSING,
        error: '配对码没拿到：它只显示在手机通知栏（不回传，这是刻意的）。'
          + '看一眼手机通知栏，然后重跑并输入；或设 KHY_PAIR_CODE=<6 位码> 再跑。',
      };
    }

    const pairRes = await request({
      method: 'POST',
      url: `${opts.baseUrl}/pair`,
      headers: {},
      body: JSON.stringify({ code, pc_key: pcKey }),
      timeoutMs: 10000,
    });
    let parsed = null;
    try {
      parsed = JSON.parse((pairRes && pairRes.body) || '{}');
    } catch {
      parsed = null;
    }
    if (!pairRes || !pairRes.ok || !parsed || parsed.ok !== true || !parsed.sig) {
      return {
        ok: false,
        code: ERR.PAIRING_REJECTED,
        // 桥的拒因（中文，说清是过期还是码不对）比我们这句概括有用得多，
        // 原样带上——被吞掉的那次排障花了半小时。
        raw: (pairRes && pairRes.body) || '',
        error: `配对被拒（${(parsed && (parsed.code || parsed.error)) || `HTTP ${pairRes && pairRes.status}`}）。`
          + '码 120 秒内有效且只能用一次：过期就重跑一次，拿新码。',
      };
    }
    if (deviceId && parsed.device_id && parsed.device_id !== deviceId) {
      return {
        ok: false,
        code: ERR.DEVICE_MISMATCH,
        error: `配对返回的设备 ${parsed.device_id} 与本次连接的设备 ${deviceId} 不是同一台`
          + '（多半是 adb 连到了另一台机器上的手机）。',
      };
    }

    const entry = {
      v: 1,
      deviceId: parsed.device_id || deviceId || '',
      privateKeyPem,
      pcKey,
      cert: parsed,
    };
    if (!_write(entry)) {
      // A credential we cannot persist means a code per request. Say so instead of
      // silently working until the next process starts.
      return {
        ok: false,
        code: ERR.KEY_UNREADABLE,
        error: `配对成功但凭据写不进 ${storePath}（权限或磁盘问题）。`,
        cert: parsed,
        privateKeyPem,
      };
    }
    return { ok: true, paired: true, cert: parsed, deviceId: entry.deviceId };
  }

  /**
   * Ensure a usable credential. Idempotent; pairs only when there is nothing usable.
   * @param {{deviceId?: string, force?: boolean}} [options]
   */
  async function ensure(options = {}) {
    const deviceId = String(options.deviceId || '').trim();
    if (!options.force) {
      const entry = _read();
      if (_usable(entry, deviceId)) {
        return { ok: true, cached: true, deviceId: entry.deviceId || deviceId };
      }
    }
    const paired = await _pair(deviceId);
    return paired;
  }

  /**
   * Headers for one request, including proof of possession.
   *
   * @param {{method?: string, path: string, body?: string}} req
   * @returns {{ok: true, headers: object} | {ok: false, code: string, error: string}}
   */
  function signedHeaders(req) {
    const entry = _read();
    if (!entry) {
      return {
        ok: false,
        code: ERR.PAIRING_REQUIRED,
        error: '没有可用的配对凭据：先 khy phone pair（或设 KHY_PAIR_CODE 后重试）。',
      };
    }
    const ts = now();
    const payload = popPayload(req.method, req.path, ts, req.body);
    let sig;
    try {
      sig = crypto
        .sign('sha256', Buffer.from(payload, 'utf8'), {
          key: crypto.createPrivateKey(entry.privateKeyPem),
          dsaEncoding: 'der',
        })
        .toString('base64');
    } catch {
      return {
        ok: false,
        code: ERR.KEY_UNREADABLE,
        error: `凭据里的私钥读不出来（${storePath}）：删掉它重新配对。`,
      };
    }
    return {
      ok: true,
      headers: {
        Authorization: `Bearer ${Buffer.from(JSON.stringify(entry.cert), 'utf8').toString('base64')}`,
        'X-Khy-Ts': String(ts),
        'X-Khy-Sig': sig,
      },
    };
  }

  /** Read-only view for diagnostics; never includes the private key. */
  function describe() {
    const entry = _read();
    if (!entry) return { paired: false, storePath };
    const cert = entry.cert || {};
    return {
      paired: true,
      storePath,
      deviceId: entry.deviceId || cert.device_id || '',
      issuedAt: cert.issued_at || 0,
      expiresAt: cert.expires_at || 0,
      expiresInMs: Math.max(0, (cert.expires_at || 0) - now()),
      usable: _usable(entry, ''),
    };
  }

  return {
    ensure,
    invalidate,
    signedHeaders,
    describe,
    storePath,
    // exposed for tests
    _read,
    _usable,
  };
}

module.exports = {
  DEFAULT_DIR,
  DEFAULT_FILE,
  RENEW_LEAD_MS,
  ERR,
  popPayload,
  sha256Hex,
  createPhoneBridgeCredential,
};
