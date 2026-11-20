// adb-pairing-common.js — the pieces the adb pairing client and the pairing
// test server share.
//
// WHERE THE SPECIFICATION COMES FROM. Two places, both authoritative:
//
//   · AOSP `packages/modules/adb` (Android 16):
//       - `pairing_connection/pairing_connection.cpp` — the framing and the
//         order of the exchange;
//       - `pairing_auth/pairing_auth.cpp` — SPAKE2, the transcript names, and
//         the "password = code || TLS exporter output" rule;
//       - `pairing_auth/aes_128_gcm.cpp` — the AES-128-GCM key derivation.
//   · BoringSSL `crypto/curve25519/spake25519.c` — the SPAKE2 arithmetic
//     itself (the two fixed points, the mask, the transcript).
//
// And the device's own `libcrypto.so` confirms the arithmetic is the same one:
// it exports `SPAKE2_generate_msg` / `SPAKE2_process_msg`, and the fixed
// points below are the ones encoded in that binary.
//
// WHY IT IS IN JAVASCRIPT. This is the version that can be checked against the
// platform's own `adb pair` in seconds; the App carries the same algorithm in
// Kotlin, and the two are kept in step by [Spake2Test] on the device side.

'use strict';

const crypto = require('crypto');

// ── Ed25519 (only what SPAKE2 needs) ──────────────────────────────────────
const P = (1n << 255n) - 19n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;

function mod(a, b = P) { const r = a % b; return r < 0n ? r + b : r; }
function pow(base, e, m) {
  let result = 1n, b = mod(base, m);
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}
function modInverse(a, m) {
  // Extended Euclid. Fermat's little theorem (a^(m-2) mod m) would be wrong
  // here: it only works when m is prime, and one caller (the mincrypt n0inv)
  // inverts modulo 2^32, which is not. Euclid works for both.
  let [oldR, r] = [mod(a, m), m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return mod(oldS, m);
}
const D = mod(-121665n * modInverse(121666n, P));
const SQRT_M1 = pow(2n, (P - 1n) / 4n, P);

function leToBig(bytes) {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}
function bigToLE(v, width) {
  const out = Buffer.alloc(width);
  for (let i = 0; i < width; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

function decodePoint(encoded) {
  if (encoded.length !== 32) return null;
  const bytes = Buffer.from(encoded);
  const sign = (bytes[31] & 0x80) !== 0;
  bytes[31] &= 0x7f;
  const y = leToBig(bytes);
  if (y >= P) return null;
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  if (v === 0n) return null;
  const v3 = (v * v % P) * v % P;
  const v7 = (v3 * v3 % P) * v % P;
  let x = (u * v3 % P) * pow(u * v7 % P, (P - 5n) / 8n, P) % P;
  if (mod(v * x % P * x - u) !== 0n) {
    x = (x * SQRT_M1) % P;
    if (mod(v * x % P * x - u) !== 0n) return null;
  }
  if (x === 0n && sign) return null;
  if (((x & 1n) === 1n) !== sign) x = P - x;
  return { x, y, z: 1n, t: (x * y) % P };
}

function encodePoint(p) {
  const zInv = modInverse(p.z, P);
  const x = (p.x * zInv) % P;
  const y = (p.y * zInv) % P;
  const out = bigToLE(y, 32);
  if (x & 1n) out[31] |= 0x80;
  return out;
}

function addPoint(p, q) {
  if (p.z === 0n) return q;
  if (q.z === 0n) return p;
  const A = mod((p.y - p.x) * (q.y - q.x));
  const B = mod((p.y + p.x) * (q.y + q.x));
  const C = mod(p.t * 2n * D % P * q.t);
  const Dd = mod(p.z * 2n * q.z);
  const E = mod(B - A), F = mod(Dd - C), G = mod(Dd + C), H = mod(B + A);
  return { x: E * F % P, y: G * H % P, z: F * G % P, t: E * H % P };
}
function negPoint(q) { return { x: q.x, y: mod(-q.y), z: q.z, t: mod(-q.t) }; }
function subPoint(p, q) { return addPoint(p, negPoint(q)); }
function doublePoint(p) {
  if (p.z === 0n) return p;
  const A = (p.x * p.x) % P;
  const B = (p.y * p.y) % P;
  const C = mod(2n * p.z % P * p.z);
  const Dd = mod(-A);
  const E = mod((p.x + p.y) * (p.x + p.y) - A - B);
  const G = mod(Dd + B);
  const F = mod(G - C);
  const H = mod(Dd - B);
  return { x: E * F % P, y: G * H % P, z: F * G % P, t: E * H % P };
}
function mulPoint(scalar, point) {
  let result = { x: 0n, y: 1n, z: 0n, t: 0n };
  for (let bit = 255; bit >= 0; bit--) {
    result = doublePoint(result);
    const sum = addPoint(result, point);
    result = ((scalar[bit >> 3] >> (bit & 7)) & 1) === 1 ? sum : result;
  }
  return result;
}

const BASE = decodePoint(Buffer.concat([Buffer.from([0x58]), Buffer.alloc(31, 0x66)]));
const POINT_M = decodePoint(Buffer.from('5ada7e4bf6ddd9adb6626d32131c6b5c51a1e347a3478f53cfcf441b88eed12e', 'hex'));
const POINT_N = decodePoint(Buffer.from('10e3df0ae37d8e7a99b5fe74b44672103dbddcbd06af680d71329a11693bc778', 'hex'));

// The transcript names carry a trailing NUL: AOSP passes sizeof(kClientName),
// which is 15 and 16 bytes respectively — not strlen().
const CLIENT_NAME = Buffer.from('adb pair client' + String.fromCharCode(0), 'ascii');
const SERVER_NAME = Buffer.from('adb pair server' + String.fromCharCode(0), 'ascii');
// The TLS exporter label carries one too: sizeof("adb-label") is 10.
const EXPORT_LABEL = 'adb-label' + String.fromCharCode(0);

// ── SPAKE2 ────────────────────────────────────────────────────────────────
/**
 * @param {Buffer} password  code || TLS exporter output
 * @param {boolean} isClient true for Alice (the pairing client)
 * @param {Buffer|null} privateKeyOverride  pin the ephemeral scalar (test only)
 */
function spake2Generate(password, isClient, privateKeyOverride) {
  const secret = privateKeyOverride
    ? Buffer.from(privateKeyOverride)
    : bigToLE(mod(leToBig(crypto.randomBytes(64)) % L * 8n, 1n << 256n), 32);
  const privKey = secret;
  const p = mulPoint(privKey, BASE);

  const passwordHash = crypto.createHash('sha512').update(password).digest();
  let scalar = leToBig(passwordHash) % L;
  // The "password scalar hack": add multiples of the group order until the low
  // three bits are clear. The value is deliberately NOT reduced afterwards —
  // it may grow to 8*order-1, and reducing it would change the bits the next
  // two checks look at.
  let order = L;
  if (scalar & 1n) scalar += order;
  order *= 2n;
  if (scalar & 2n) scalar += order;
  order *= 2n;
  if (scalar & 4n) scalar += order;
  const maskScalar = bigToLE(scalar, 32);

  const mask = mulPoint(maskScalar, isClient ? POINT_M : POINT_N);
  return { msg: encodePoint(addPoint(p, mask)), privKey, passwordHash, maskScalar };
}

/**
 * The shared secret point, before the transcript is folded in.
 *
 * Split out from the transcript hash because the transcript is the part with
 * the easy-to-get-wrong details (the names, their order, the trailing NUL),
 * and checking those must not cost a scalar multiplication each time.
 */
function spake2Shared(state, theirMsg, isClient) {
  const qStar = decodePoint(theirMsg);
  if (!qStar) return null;
  const peersMask = mulPoint(state.maskScalar, isClient ? POINT_N : POINT_M);
  const qExt = subPoint(qStar, peersMask);
  return encodePoint(mulPoint(state.privKey, qExt));
}

function lengthPrefixed(b) {
  const len = Buffer.alloc(8);
  len.writeUInt32LE(b.length, 0);
  return Buffer.concat([len, b]);
}

/**
 * Fold the shared point into the transcript and hash it.
 *
 * @param {object} opts
 *   myName / theirName — the transcript names (default: the platform's).
 *   order — which fields go in, in which order. The platform's two roles use
 *   **different** orders, and that is what makes the two sides agree:
 *     alice: my_name, their_name, my_msg, their_msg
 *     bob:   their_name, my_name, their_msg, my_msg
 */
function spake2Key(state, theirMsg, shared, isClient, opts = {}) {
  const myName = opts.myName || (isClient ? CLIENT_NAME : SERVER_NAME);
  const theirName = opts.theirName || (isClient ? SERVER_NAME : CLIENT_NAME);
  const order = opts.order || (isClient
    ? ['myName', 'theirName', 'myMsg', 'theirMsg']
    : ['theirName', 'myName', 'theirMsg', 'myMsg']);

  const h = crypto.createHash('sha512');
  for (const field of order) {
    if (field === 'myName') h.update(lengthPrefixed(myName));
    else if (field === 'theirName') h.update(lengthPrefixed(theirName));
    else if (field === 'myMsg') h.update(lengthPrefixed(state.msg));
    else h.update(lengthPrefixed(theirMsg));
  }
  h.update(lengthPrefixed(shared));
  h.update(lengthPrefixed(state.passwordHash));
  return h.digest();
}

function spake2Process(state, theirMsg, isClient) {
  const shared = spake2Shared(state, theirMsg, isClient);
  if (!shared) return null;
  return spake2Key(state, theirMsg, shared, isClient);
}

// ── Android "mincrypt" public key encoding ────────────────────────────────
//
// struct RSAPublicKey {
//   uint32 modulus_size_words;   // 64 for a 2048-bit modulus
//   uint32 n0inv;                // -1 / n[0] mod 2^32
//   uint8  modulus[256];         // little-endian
//   uint8  rr[256];              // R^2 mod N, little-endian
//   uint32 exponent;             // 65537
// };
function mincryptPublicKey(publicKeyPem) {
  const jwk = crypto.createPublicKey(publicKeyPem).export({ format: 'jwk' });
  const n = BigInt('0x' + Buffer.from(jwk.n, 'base64url').toString('hex'));
  const e = BigInt('0x' + Buffer.from(jwk.e, 'base64url').toString('hex'));
  const MOD = 256;
  const modulusLE = Buffer.from(n.toString(16).padStart(MOD * 2, '0'), 'hex').reverse();
  const n0 = leToBig(modulusLE.subarray(0, 4)) % (1n << 32n);
  const n0inv = (1n << 32n) - modInverse(n0, 1n << 32n);
  const rr = (pow(2n, BigInt(MOD * 8), n) ** 2n) % n;
  const rrLE = Buffer.from(rr.toString(16).padStart(MOD * 2, '0'), 'hex').reverse();
  const out = Buffer.alloc(12 + MOD * 2);
  out.writeUInt32LE(MOD / 4, 0);
  out.writeUInt32LE(Number(n0inv & 0xffffffffn), 4);
  modulusLE.copy(out, 8);
  rrLE.copy(out, 8 + MOD);
  out.writeUInt32LE(Number(e & 0xffffffffn), 8 + MOD * 2);
  return out;
}

// ── framing + cipher ──────────────────────────────────────────────────────
const TYPE_SPAKE2 = 0;
const TYPE_PEER_INFO = 1;
const PEER_INFO_SIZE = 8192;
const PEER_INFO_TYPE_RSA_PUB_KEY = 0;
const PEER_INFO_TYPE_DEVICE_GUID = 1;

function frame(type, payload) {
  const head = Buffer.alloc(6);
  head[0] = 1;
  head[1] = type;
  head.writeUInt32BE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

function aesKey(keyMaterial) {
  return Buffer.from(crypto.hkdfSync('sha256', keyMaterial, Buffer.alloc(0),
    Buffer.from('adb pairing_auth aes-128-gcm key'), 16));
}

function aesEncrypt(key, seq, plain) {
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32LE(seq, 0); // the reference memcpy's a uint64 in native order
  const cipher = crypto.createCipheriv('aes-128-gcm', key, nonce);
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function aesDecrypt(key, seq, payload) {
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32LE(seq, 0);
  const tag = payload.subarray(payload.length - 16);
  const decipher = crypto.createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload.subarray(0, payload.length - 16)), decipher.final()]);
}

/** Build the 8192-byte PeerInfo blob carrying a public key. */
function peerInfoWithPublicKey(base64Text) {
  const buf = Buffer.alloc(PEER_INFO_SIZE);
  buf[0] = PEER_INFO_TYPE_RSA_PUB_KEY;
  buf.write(base64Text, 1, 'ascii');
  return buf;
}

/** Build the 8192-byte PeerInfo blob carrying a device GUID. */
function peerInfoWithGuid(guid) {
  const buf = Buffer.alloc(PEER_INFO_SIZE);
  buf[0] = PEER_INFO_TYPE_DEVICE_GUID;
  buf.write(guid, 1, 'ascii');
  return buf;
}

module.exports = {
  P, L, D,
  BASE, POINT_M, POINT_N,
  CLIENT_NAME, SERVER_NAME, EXPORT_LABEL,
  spake2Generate, spake2Process, spake2Shared, spake2Key, lengthPrefixed,
  mincryptPublicKey,
  frame, aesKey, aesEncrypt, aesDecrypt,
  peerInfoWithPublicKey, peerInfoWithGuid,
  TYPE_SPAKE2, TYPE_PEER_INFO, PEER_INFO_SIZE,
  PEER_INFO_TYPE_RSA_PUB_KEY, PEER_INFO_TYPE_DEVICE_GUID,
};
