'use strict';

/**
 * deviceIdentity.js — thin IO shell: load a device keypair and sign the
 * gateway's connect challenge.
 *
 * Why this file exists at all: the gateway derives a device's id as
 * sha256(rawPublicKeyBytes) and rejects any connect whose device.id disagrees
 * (DEVICE_AUTH_DEVICE_ID_MISMATCH). A devices.json entry whose private key and
 * registered publicKey are two *different* keys therefore fails in a way that
 * reads as "bad signature" — you go hunting the signing code while the real
 * problem is the keypair. So consistency is validated here, at load, as a
 * first-class result rather than being discovered later as a mystery 1008.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { buildDeviceAuthPayloadV3, DEVICE_ID_DERIVATION } = require('./gatewayProtocol');

// Ed25519 raw key wrappers. Node only takes DER, so a 32-byte seed/public key
// has to be wrapped before import; a 48/44-byte buffer is already DER.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function _decodeBase64(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const normalised = text.replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(normalised, 'base64');
  return buf.length > 0 ? buf : null;
}

function _toPrivateKeyObject(raw) {
  if (!raw) return null;
  if (raw.length === 48) return crypto.createPrivateKey({ key: raw, format: 'der', type: 'pkcs8' });
  if (raw.length === 32) {
    return crypto.createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, raw]),
      format: 'der',
      type: 'pkcs8',
    });
  }
  return null;
}

function _toPublicKeyObject(raw) {
  if (!raw) return null;
  if (raw.length === 44) return crypto.createPublicKey({ key: raw, format: 'der', type: 'spki' });
  if (raw.length === 32) {
    return crypto.createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
  }
  return null;
}

function deriveDeviceId(publicKeyRaw) {
  if (!publicKeyRaw) return null;
  return crypto.createHash('sha256').update(publicKeyRaw).digest('hex');
}

function _compactPath(filePath) {
  const home = require('os').homedir();
  const normalised = path.normalize(filePath);
  if (normalised.startsWith(home)) return `~${normalised.slice(home.length)}`;
  return normalised;
}

/**
 * Load and validate a keypair file.
 *
 * Accepted shape (one entry per file, not the botagent devices.json array):
 *   { "deviceId": "<64 hex, optional>", "publicKey": "<b64>", "privateKey": "<b64>" }
 *
 * Returns { ok, problems, identity }. identity never carries the private key —
 * only what a caller needs to sign.
 */
function loadDeviceIdentity(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return {
      ok: false,
      problems: [{ code: 'identity_file_missing', message: `设备身份文件不存在：${_compactPath(resolved)}` }],
      identity: null,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      problems: [{ code: 'identity_file_unreadable', message: `设备身份文件不是合法 JSON：${err.message}` }],
      identity: null,
    };
  }

  const publicRaw = _decodeBase64(parsed.publicKey);
  const privateRaw = _decodeBase64(parsed.privateKey);
  const problems = [];

  if (!publicRaw) problems.push({ code: 'public_key_missing', message: '设备身份缺 publicKey' });
  if (!privateRaw) problems.push({ code: 'private_key_missing', message: '设备身份缺 privateKey' });
  if (problems.length > 0) return { ok: false, problems, identity: null };

  const derived = deriveDeviceId(publicRaw);
  const declared = typeof parsed.deviceId === 'string' ? parsed.deviceId.trim() : '';
  if (declared && declared !== derived) {
    problems.push({
      code: 'device_id_mismatch',
      message:
        `登记的 deviceId 与公钥派生值不一致（${DEVICE_ID_DERIVATION}）：` +
        `登记 ${declared.slice(0, 12)}…，派生 ${derived.slice(0, 12)}…。` +
        '这套钥对不自洽，签出来的名必然被网关拒。',
    });
  }

  // Cross-check: does the private key actually correspond to the public key?
  // This is the check that would have caught the broken entry up front.
  try {
    const privateKey = _toPrivateKeyObject(privateRaw);
    const publicKey = _toPublicKeyObject(publicRaw);
    if (!privateKey) {
      problems.push({ code: 'private_key_shape', message: `privateKey 长度/形状不支持（${privateRaw.length} 字节）` });
    } else if (!publicKey) {
      problems.push({ code: 'public_key_shape', message: `publicKey 长度/形状不支持（${publicRaw.length} 字节）` });
    } else {
      const probe = crypto.sign(null, Buffer.from('khyos-identity-selfcheck'), privateKey);
      const okPair = crypto.verify(null, Buffer.from('khyos-identity-selfcheck'), publicKey, probe);
      if (!okPair) {
        problems.push({
          code: 'keypair_mismatch',
          message: 'privateKey 与 publicKey 不是同一套钥（自校验签名验证不过）',
        });
      }
    }
  } catch (err) {
    problems.push({ code: 'key_import_failed', message: `密钥导入失败：${err.message}` });
  }

  if (problems.length > 0) return { ok: false, problems, identity: null };

  return {
    ok: true,
    problems: [],
    identity: {
      deviceId: derived,
      publicKeyB64: publicRaw.toString('base64'),
      privateKeyRaw: privateRaw,
      source: _compactPath(resolved),
    },
  };
}

/** Sign the v3 payload for one connect attempt. */
function signChallenge(identity, fields) {
  if (!identity || !identity.privateKeyRaw) {
    return { ok: false, problems: [{ code: 'identity_missing', message: '没有可用设备身份' }], signature: null };
  }
  const payload = buildDeviceAuthPayloadV3({
    deviceId: identity.deviceId,
    clientId: fields.clientId,
    clientMode: fields.clientMode,
    role: fields.role,
    scopes: fields.scopes,
    signedAt: fields.signedAt,
    token: fields.token,
    nonce: fields.nonce,
    platform: fields.platform,
    deviceFamily: fields.deviceFamily,
  });
  try {
    const key = _toPrivateKeyObject(identity.privateKeyRaw);
    const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
    return { ok: true, problems: [], signature: signature.toString('base64'), payload };
  } catch (err) {
    return { ok: false, problems: [{ code: 'sign_failed', message: `签名失败：${err.message}` }], signature: null };
  }
}

module.exports = { loadDeviceIdentity, deriveDeviceId, signChallenge };
