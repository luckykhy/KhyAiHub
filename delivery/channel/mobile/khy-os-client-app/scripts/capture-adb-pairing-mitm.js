// capture-adb-pairing-mitm.js — read the REAL pairing exchange, both ways.
//
// WHY a MITM. The pairing endpoint is TLS-wrapped, and adbd tears the
// pairing socket down as soon as it sees a packet it cannot accept — so a
// blind replay gets exactly ONE guess per time the user opens the pairing
// screen, and a wrong guess costs the socket.
//
// This proxy removes the guessing entirely: the real `adb pair` client
// connects HERE (it does not verify the server certificate during pairing —
// the 6-digit code is the trust anchor, which is why the earlier recording
// server could sit on that side at all), and this proxy opens a second TLS
// session to the phone's pairing endpoint and forwards the plaintext.
//
// What lands in the log is therefore the genuine conversation:
//   · what the real client sends (its real first packet, with the real code),
//   · what the phone's adbd answers.
//
// Usage:
//   node capture-adb-pairing-mitm.js <proxyPort> <outfile> <cert.pem> <key.pem>
//
// Then (on the phone): 设置 → 无线调试 → 使用配对码配对设备 → keep it open.
// And on this PC:  adb pair 127.0.0.1:<proxyPort> <the 6-digit code>
//
// The output file is an artifact and belongs OUTSIDE the repository.

'use strict';

const tls = require('tls');
const { execFileSync } = require('child_process');
const fs = require('fs');

const proxyPort = parseInt(process.argv[2] || '45672', 10);
// The upstream endpoint is resolved dynamically at connect time (see findPairingEndpoint).
const outFile = process.argv[3] || 'pairing-mitm.jsonl';
const certFile = process.argv[4] || 'fake-adbd-cert.pem';
const keyFile = process.argv[5] || 'fake-adbd-key.pem';

function hex(buf) {
  return buf.toString('hex').replace(/(..)/g, '$1 ').trim();
}

/**
 * The phone's pairing endpoint as advertised over mDNS.
 *
 * adbd re-issues a fresh port every time the pairing screen is opened, and a
 * failed attempt takes the old pairing socket down with it — so the address
 * has to be resolved when a client actually connects, not at start-up.
 */
function findPairingEndpoint() {
  let out = '';
  try {
    out = execFileSync(process.env.ADB_PATH || 'adb', ['mdns', 'services'], { encoding: 'utf8' });
  } catch (e) {
    return null;
  }
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes('_adb-tls-pairing._tcp')) continue;
    const m = line.match(/(\d{1,3}(?:\.\d{1,3}){3}):(\d+)\s*$/);
    if (m) return { host: m[1], port: parseInt(m[2], 10) };
  }
  return null;
}

function record(obj) {
  console.log(JSON.stringify(obj));
  fs.appendFileSync(outFile, JSON.stringify(obj) + '\n');
}

// --- client side: the real `adb pair` speaking to us ------------------------
const clientServer = tls.createServer(
  { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) },
  (clientSocket) => {
    record({ phase: 'client-connected' });
    // Resolve the phone's CURRENT pairing endpoint at connect time: adbd
    // re-issues a fresh port every time the pairing screen is opened, and a
    // failed attempt takes the old pairing socket down with it — so the
    // address must not be baked in at start-up.
    const endpoint = findPairingEndpoint();
    if (!endpoint) {
      record({ error: 'no pairing endpoint advertised (is the pairing screen open?)' });
      clientSocket.destroy();
      return;
    }
    const upstream = tls.connect(
      { host: endpoint.host, port: endpoint.port, rejectUnauthorized: false },
      () => {
        record({ phase: 'upstream-connected', to: `${endpoint.host}:${endpoint.port}` });
        // client -> phone
        clientSocket.on('data', (chunk) => {
          record({ phase: 'client->phone', bytes: chunk.length, hex: hex(chunk) });
          upstream.write(chunk);
        });
        // phone -> client
        upstream.on('data', (chunk) => {
          record({ phase: 'phone->client', bytes: chunk.length, hex: hex(chunk) });
          clientSocket.write(chunk);
        });
        const bye = () => {
          try { upstream.end(); } catch (e) {}
          try { clientSocket.end(); } catch (e) {}
        };
        clientSocket.on('end', bye);
        upstream.on('end', bye);
        clientSocket.on('error', bye);
        upstream.on('error', bye);
      },
    );
    upstream.on('error', (e) => record({ error: 'upstream: ' + e.message }));
  },
);

clientServer.on('tlsClientError', (err) => {
  record({ error: 'client tls: ' + err.message });
});

clientServer.listen(proxyPort, '127.0.0.1', () => {
  console.log(`[mitm] proxy on 127.0.0.1:${proxyPort} (upstream resolved per connection)`);
  console.log('[mitm] now run: adb pair 127.0.0.1:' + proxyPort + ' <6-digit code>');
});
