// capture-adb-pairing.js — record what a REAL `adb pair` sends, so the
// pairing transport's golden vectors can be re-derived instead of guessed.
//
// WHY. The pairing endpoint is the one part of the adb protocol this project
// has not fully reverse engineered: the AOSP sources are unreachable from this
// network (raw.githubusercontent / android.googlesource / jsdelivr / codeload
// all fail), and the endpoint only exists while the phone shows the "pair
// device with pairing code" screen. So the phone is the oracle and this
// script is the instrument.
//
// The endpoint is TLS-wrapped (mDNS advertises it as `_adb-tls-pairing._tcp`),
// and during pairing the client does NOT verify the server's certificate — the
// 6-digit pairing code is the trust anchor. That is what makes a self-signed
// fake server possible here at all.
//
// Usage:
//   openssl req -x509 -newkey rsa:2048 -keyout fake-adbd-key.pem \
//          -out fake-adbd-cert.pem -days 30 -nodes -subj '/CN=adb-pairing-probe'
//   node capture-adb-pairing.js <port> <cert.pem> <key.pem> <outfile>
//   adb pair 127.0.0.1:<port> 123456
//
// The output file is an artifact and belongs OUTSIDE the repository (e.g.
// under works/data/khy/T4-transient/tmp/).
//
// WHAT IS KNOWN SO FAR (2026-11-12, see AdbPairingProtocol.kt):
//   · after the TLS handshake the client sends exactly 38 bytes:
//     `01 00 00 00` + `00 20` + 32 connection-scoped bytes;
//   · those 32 bytes are fresh on every connection (same code -> different
//     bytes) and are not derived from the client's long-lived adbkey.
//
// STILL MISSING: the server's reply, and the packet that carries the pairing
// code itself. To get them, point this at the PHONE's own pairing endpoint
// (via `adb forward`) and replay the captured first packet — the phone's adbd
// is the authority. See [DESIGN-ARCH-212] §10.

'use strict';

const tls = require('tls');
const fs = require('fs');

const port = parseInt(process.argv[2] || '5558', 10);
const certFile = process.argv[3];
const keyFile = process.argv[4];
const outFile = process.argv[5] || '';
const IDLE_MS = 1200;

function hex(buf) {
  return buf.toString('hex').replace(/(..)/g, '$1 ').trim();
}

let chunks = [];
let timer = null;

function flush() {
  if (!chunks.length) return;
  const all = Buffer.concat(chunks);
  const line = JSON.stringify({ bytes: all.length, hex: hex(all) });
  console.log(line);
  if (outFile) fs.appendFileSync(outFile, line + '\n');
  process.exit(0);
}

const server = tls.createServer(
  { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) },
  (socket) => {
    console.log('[capture] TLS established');
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, IDLE_MS);
    });
    socket.on('error', (e) => console.log('[capture] socket error: ' + e.message));
  },
);

server.on('tlsClientError', (err) => {
  console.log('[capture] tls error: ' + err.message);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[capture] pairing server on 127.0.0.1:${port}`);
});
