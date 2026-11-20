// adb-pairing-server.js — a fake adbd pairing server, for checking the
// pairing implementation against the platform's own client.
//
// WHY. The App has to speak the adb pairing protocol to authorize its own key
// on the phone ([DESIGN-ARCH-212]). The protocol is implemented twice in this
// repository — in Kotlin for the App, and here — and the only oracle that
// counts is **the platform's own client**: point the real `adb pair` at this
// server and it either says "Successfully paired" or it does not. A server that
// the real client cannot pair with is a server that is wrong somewhere, and
// the server's own log says which part.
//
// The server is deliberately a server (not a client): the real `adb pair` is
// the client, so the platform's crypto — SPAKE2, the exporter output, the
// framing, the AES-128-GCM — all come from the platform, and only this side
// is ours.
//
// Usage:
//   openssl req -x509 -newkey rsa:2048 -keyout fake-adbd-key.pem \
//          -out fake-adbd-cert.pem -days 30 -nodes -subj '/CN=adb-pairing-probe'
//   node adb-pairing-server.js --port 5599 --code 123456 \
//          --cert fake-adbd-cert.pem --key fake-adbd-key.pem
//   adb pair 127.0.0.1:5599 123456
//
// The `--code` is the 6-digit pairing code. The device normally generates it
// and shows it on screen; here the operator picks it, and the client is told
// the same value.

'use strict';

const tls = require('tls');
const fs = require('fs');
const common = require('./adb-pairing-common');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const port = parseInt(arg('port', '5599'), 10);
const code = String(arg('code', '')).trim();
const certFile = arg('cert', '');
const keyFile = arg('key', '');
const guid = arg('guid', 'fake-device-guid');
// --label plain：标签不带结尾 NUL（用来对齐 OpenSSL 侧「label||0x00||context」的构造）
const labelMode = arg('label', 'nul');
const exportLabel = labelMode === 'plain'
  ? common.EXPORT_LABEL.slice(0, -1)
  : common.EXPORT_LABEL;

if (!code || !certFile || !keyFile) {
  console.error('用法: node adb-pairing-server.js --port <port> --code <6位码> --cert cert.pem --key key.pem');
  process.exit(2);
}

const server = tls.createServer({
  cert: fs.readFileSync(certFile),
  key: fs.readFileSync(keyFile),
  requestCert: true,          // the pairing server demands a client certificate
  rejectUnauthorized: false,   // …but accepts any certificate
  minVersion: 'TLSv1.3',
  maxVersion: 'TLSv1.3',
}, (socket) => {
  console.log('[server] TLS 已建立；对端证书', socket.getPeerCertificate() ? '已出示' : '没有');
  let keyMaterial;
  try {
    keyMaterial = socket.exportKeyingMaterial(64, exportLabel, Buffer.alloc(0));
  } catch (e) {
    console.error('[server] 导出 keying material 失败:', e.message);
    process.exit(5);
  }
  console.log('[server] 导出的 keying material 长度', keyMaterial.length);
  // 诊断：带 NUL 的标签与不带 NUL 的标签，导出结果是否相同？相同即说明 Node
  // 在 NUL 处截断了标签（那样就永远对不上平台的 10 字节标签）。
  try {
    const withNul = socket.exportKeyingMaterial(64, common.EXPORT_LABEL, Buffer.alloc(0));
    const withoutNul = socket.exportKeyingMaterial(64, common.EXPORT_LABEL.slice(0, -1), Buffer.alloc(0));
    console.log('[server] 标签带 NUL 与不带 NUL 的导出是否相同：', withNul.equals(withoutNul));
    console.log('[server] 不带 NUL 的导出长度', withoutNul.length);
  } catch (e) {
    console.log('[server] 诊断导出失败:', e.message);
  }

  const password = Buffer.concat([Buffer.from(code, 'ascii'), keyMaterial]);
  const state = common.spake2Generate(password, false);

  let buffer = Buffer.alloc(0);
  let step = 'await-spake2';
  let spakeKey = null;

  const onFrame = (type, payload) => {
    if (step === 'await-spake2') {
      if (type !== common.TYPE_SPAKE2) {
        console.error('[server] 期望 SPAKE2 帧，收到 type', type);
        process.exit(3);
      }
      console.log('[server] 收到客户端 SPAKE2 消息', payload.toString('hex'));
      // isClient 必须是 false：服务端是 Bob，转录的字段顺序与 Alice 不同
      // （Bob 是 their_name, my_name, their_msg, my_msg）。传错这一位，
      // 派生出的密钥就与客户端不同，表现为「客户端不回 PeerInfo」。
      spakeKey = common.spake2Process(state, payload, false);
      if (!spakeKey) { console.error('[server] 派生密钥失败'); process.exit(3); }
      console.log('[server] 派生出的密钥材料长度', spakeKey.length);
      console.log('[server] 本端 SPAKE2 消息', state.msg.toString('hex'));
      socket.write(common.frame(common.TYPE_SPAKE2, state.msg));
      step = 'await-peerinfo';
      return;
    }
    if (step === 'await-peerinfo') {
      if (type !== common.TYPE_PEER_INFO) {
        console.error('[server] 期望 PEER_INFO 帧，收到 type', type);
        process.exit(3);
      }
      const key = common.aesKey(spakeKey);
      let plain;
      try {
        plain = common.aesDecrypt(key, 0, payload);
      } catch (e) {
        console.error('[server] 解密客户端 PeerInfo 失败:', e.message);
        process.exit(3);
      }
      const type_ = plain[0];
      const text = plain.subarray(1).toString('ascii').replace(/\0+$/, '');
      console.log('[server] 客户端 PeerInfo 类型', type_);
      console.log('[server] 客户端公钥 base64 长度', text.length);
      console.log('[server] 客户端公钥 base64:', text);
      const mine = common.peerInfoWithGuid(guid);
      socket.write(common.frame(common.TYPE_PEER_INFO, common.aesEncrypt(key, 0, mine)));
      console.log('[server] 已回送设备 GUID，握手完成');
      step = 'done';
      setTimeout(() => { socket.end(); }, 200);
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
  socket.on('error', (e) => console.error('[server] socket 错误:', e.message));
});

server.on('tlsClientError', (err) => console.error('[server] TLS 错误:', err.message));
server.listen(port, '127.0.0.1', () => {
  console.log(`[server] 配对服务端在 127.0.0.1:${port}，配对码 ${code}`);
});
