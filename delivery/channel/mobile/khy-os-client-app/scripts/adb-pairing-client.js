// adb-pairing-client.js — the adb *pairing* client, in Node.
//
// WHY THIS FILE EXISTS. The App has to pair with the phone's own wireless
// debugging endpoint so it can get a uid-2000 shell without a computer
// ([DESIGN-ARCH-212]). The pairing protocol needs the platform's crypto
// (SPAKE2 over Ed25519), and an app cannot borrow the platform's copy of it,
// so it is re-implemented. This script is that re-implementation in a language
// where it can be iterated in seconds.
//
// The protocol, from AOSP `packages/modules/adb` (Android 16) and BoringSSL's
// `crypto/curve25519/spake25519.c`:
//
//   1. TCP connect to the pairing port (loopback only).
//   2. TLS 1.3 handshake. The client MUST present a certificate (the server
//      sets SSL_VERIFY_PEER | SSL_VERIFY_FAIL_IF_NO_PEER_CERT) but it may be
//      any certificate: the pairing server accepts every peer certificate, and
//      the client does not verify the server's — the 6-digit code is the trust
//      anchor. The TLS exporter output ("adb-label\0", 64 bytes) is appended
//      to the password on BOTH sides, which is what makes the two agree.
//   3. SPAKE2 over Ed25519, password = code || exporter output.
//      Names bound into the transcript: "adb pair client\0" / "adb pair server\0"
//      — with the NUL, because AOSP passes sizeof(), not strlen().
//   4. 6-byte frame header (version, type, payload length, big-endian) then
//      the payload. Type 0 = SPAKE2 message, type 1 = encrypted PeerInfo.
//   5. PeerInfo is 8192 bytes: a type byte plus 8191 bytes of data. The client
//      sends ADB_RSA_PUB_KEY (0) carrying the base64 text of the Android
//      "mincrypt" public key; the server replies with ADB_DEVICE_GUID (1).
//   6. PeerInfo is encrypted with AES-128-GCM: the key is
//      HKDF-SHA256(ikm = SPAKE2 key material, info = "adb pairing_auth
//      aes-128-gcm key"), and the nonce is a 12-byte counter that starts at
//      zero.
//
// Usage:
//   node adb-pairing-client.js --port <pairing port> --code <6 digits>
//                               [--host 127.0.0.1] [--key <adbkey.pem>]
//                               [--cert <cert.pem> --certkey <key.pem>]
//
// The key file is the adb identity in PEM form; its public half is re-encoded
// into Android's mincrypt layout, which is what the device writes into
// /data/misc/adb/adb_keys.

'use strict';

const tls = require('tls');
const fs = require('fs');
const common = require('./adb-pairing-common');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const host = arg('host', '127.0.0.1');
const port = parseInt(arg('port', '0'), 10);
const code = String(arg('code', '')).trim();
const keyFile = arg('key', '');
const certFile = arg('cert', '');
const certKeyFile = arg('certkey', '');

if (!port || !code || !keyFile) {
  console.error('用法: node adb-pairing-client.js --port <port> --code <6位码> --key <adbkey.pem> [--cert cert.pem --certkey key.pem]');
  process.exit(2);
}

const tlsOptions = {
  rejectUnauthorized: false,   // the pairing code is the trust anchor
  minVersion: 'TLSv1.3',
  maxVersion: 'TLSv1.3',
};
if (certFile && certKeyFile) {
  tlsOptions.cert = fs.readFileSync(certFile);
  tlsOptions.key = fs.readFileSync(certKeyFile);
} else {
  console.error('[pair] 没有客户端证书：设备的配对服务端要求客户端必须出示证书');
  process.exit(2);
}

const socket = tls.connect({ host, port, ...tlsOptions }, () => {
  console.log('[pair] TLS 已建立');
  let keyMaterial;
  try {
    keyMaterial = socket.exportKeyingMaterial(64, common.EXPORT_LABEL, Buffer.alloc(0));
  } catch (e) {
    console.error('[pair] 导出 keying material 失败:', e.message);
    process.exit(5);
  }
  console.log('[pair] 导出的 keying material 长度', keyMaterial.length);

  const password = Buffer.concat([Buffer.from(code, 'ascii'), keyMaterial]);
  const state = common.spake2Generate(password, true);
  console.log('[pair] 本端 SPAKE2 消息', state.msg.toString('hex'));

  let buffer = Buffer.alloc(0);
  let step = 'await-spake2';
  let spakeKey = null;

  const onFrame = (type, payload) => {
    if (step === 'await-spake2') {
      if (type !== common.TYPE_SPAKE2) {
        console.error('[pair] 期望 SPAKE2 帧，收到 type', type);
        process.exit(3);
      }
      console.log('[pair] 服务端 SPAKE2 消息', payload.toString('hex'));
      // 客户端是 Alice：转录顺序是 my_name, their_name, my_msg, their_msg。
      spakeKey = common.spake2Process(state, payload, true);
      if (!spakeKey) { console.error('[pair] 派生密钥失败'); process.exit(3); }
      console.log('[pair] 派生出的密钥材料长度', spakeKey.length);
      socket.write(common.frame(common.TYPE_SPAKE2, state.msg));
      step = 'await-peerinfo';
      return;
    }
    if (step === 'await-peerinfo') {
      if (type !== common.TYPE_PEER_INFO) {
        console.error('[pair] 期望 PEER_INFO 帧，收到 type', type);
        process.exit(3);
      }
      const key = common.aesKey(spakeKey);
      const pub = common.mincryptPublicKey(fs.readFileSync(keyFile, 'utf8'));
      const plain = common.peerInfoWithPublicKey(pub.toString('base64'));
      console.log('[pair] 发送 PeerInfo（公钥 base64 长度', pub.toString('base64').length, '）');
      socket.write(common.frame(common.TYPE_PEER_INFO, common.aesEncrypt(key, 0, plain)));
      step = 'await-guid';
      return;
    }
    if (step === 'await-guid') {
      const key = common.aesKey(spakeKey);
      let plain;
      try {
        plain = common.aesDecrypt(key, 0, payload);
      } catch (e) {
        console.error('[pair] 解密服务端 PeerInfo 失败：', e.message);
        process.exit(3);
      }
      console.log('[pair] 服务端 PeerInfo 类型', plain[0]);
      console.log('[pair] 设备 GUID:', plain.subarray(1).toString('ascii').replace(/\0+$/, ''));
      console.log('[pair] 配对成功');
      socket.end();
      process.exit(0);
    }
  };

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 6) return;
      const len = buffer.readUInt32BE(2);
      if (buffer.length < 6 + len) return;
      const type = buffer[1];
      const payload = buffer.subarray(6, 6 + len);
      buffer = buffer.subarray(6 + len);
      onFrame(type, payload);
    }
  });
});

socket.on('error', (e) => { console.error('[pair] socket 错误:', e.message); process.exit(4); });
