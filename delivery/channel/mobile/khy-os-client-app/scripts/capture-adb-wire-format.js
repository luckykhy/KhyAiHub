// capture-adb-wire-format.js — re-derive the adb golden vectors from the REAL
// adb client, so the pinned test vectors in AdbProtocolTest can be refreshed
// instead of rotting.
//
// WHY THIS EXISTS. khyos' own privilege bootstrapper (see DESIGN-ARCH-212)
// speaks the adb host protocol to the phone's own wireless-debugging endpoint.
// The framing has three details that are routinely misremembered and that
// fail SILENTLY — a broken handshake is indistinguishable from "the service is
// off" on a phone:
//
//   · the 6th header word is `command XOR 0xffffffff`, not a constant;
//   · the 5th header word ("data_crc32") is the SUM of the payload bytes, not
//     a CRC32, and only CNXN carries it;
//   · service strings are NUL-terminated, but the CNXN banner is NOT.
//
// The golden vectors pinned in `AdbProtocolTest` were captured from
// `platform-tools/adb.exe` on this machine. When adb changes its framing, run
// this script and update the test — never "fix" the test to match a guess.
//
// WHAT IT DOES. Listens on a local port, speaks just enough of the adb server
// side to get the client through CNXN -> AUTH -> OPEN, and records every
// packet the client sends. The fake adbd is deliberately minimal: it is a
// measuring instrument, not an emulator.
//
// Usage:
//   node capture-adb-wire-format.js [port] [outfile]
//   adb connect 127.0.0.1:<port>
//   adb -s 127.0.0.1:<port> shell echo hello
//
// The output file is an artifact and belongs OUTSIDE the repository
// (e.g. under works/data/khy/T4-transient/tmp/).

'use strict';

const net = require('net');
const fs = require('fs');
const crypto = require('crypto');

const port = parseInt(process.argv[2] || '5555', 10);
const outFile = process.argv[3] || '';
// What the fake server does after the client publishes its public key:
//   'challenge'  reply AUTH arg0=4 with a fresh 20-byte token (the old adb
//                shape: server challenges, client signs).
//   'okay'       reply OKAY and wait — maybe the client signs the token it
//                already has, but only after its public key is acknowledged.
//   'silent'     say nothing at all.
// The point of the switch is to find out which one the REAL client accepts,
// by measurement instead of by recollection.
const mode = process.argv[4] || 'challenge';

// A real RSA-2048 modulus, used when the fake server answers the client's
// public key with ITS OWN public key (mode='serverkey'). The old adb auth
// shape is: host publishes its key, the device publishes its key back, and
// only then does a signature appear.
const { publicKey: fakePub } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const fakeModulus = (() => {
  const n = Buffer.from(fakePub.export({ format: 'jwk' }).n, 'base64url');
  const out = Buffer.alloc(256);
  n.copy(out, 256 - n.length);
  return out;
})();

const HEADER_SIZE = 24;
const MAGIC = 0xb1a7b1bc;
const AUTH = 0x48545541; // "AUTH"
const OKAY = 0x59414b4f; // "OKAY"
const OPEN = 0x4e45504f; // "OPEN"
const WRTE = 0x45545257; // "WRTE"
// AUTH arg0 values, MEASURED 2026-11-12 from the real adb client:
//   1 = the device's challenge (20 bytes)
//   2 = the client's answer: the 256-byte RSA signature
//   3 = a public key (the pairing flow sends this)
//   4 = a challenge (the older layout's second round)
//
// NOTE: most write-ups say 2 = public key and 3 = signature. That is the OLD
// layout. The current platform-tools answers the challenge with arg0=2, and a
// fake server that expects 3 will see nothing at all.
const AUTH_TOKEN = 1;
const AUTH_SIGNATURE = 2;
const AUTH_RSAPUBLICKEY = 3;
const AUTH_RSACHALLENGE = 4;

function hex(buf) {
  return buf.toString('hex').replace(/(..)/g, '$1 ').trim();
}

function crcTable() {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}
const CRC_TABLE = crcTable();

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

// The 6th header word is `command XOR 0xffffffff` — NOT a constant.
//
// MEASURED 2026-11-12: the real client sends CNXN -> 0xb1a7b1bc and OPEN ->
// 0xb1baafb0. This fake server used to send the CNXN magic for EVERY command,
// which the real client silently rejected: it checks the magic of each packet
// it reads, so the AUTH TOKEN we sent looked corrupt and the client hung up
// before ever answering it. That is why the capture used to stop at CNXN.
function magicFor(command) {
  const v = Buffer.from(command, 'ascii').readUInt32LE(0);
  return (v ^ 0xffffffff) >>> 0;
}

function build(command, arg0, arg1, payload) {
  const header = Buffer.alloc(HEADER_SIZE);
  header.write(command, 0, 4, 'ascii');
  header.writeUInt32LE(arg0 >>> 0, 4);
  header.writeUInt32LE(arg1 >>> 0, 8);
  header.writeUInt32LE(payload.length, 12);
  header.writeUInt32LE(crc32(payload) >>> 0, 16);
  header.writeUInt32LE(magicFor(command), 20);
  return Buffer.concat([header, payload]);
}

// AUTH packets travel with a ZERO checksum.
//
// MEASURED 2026-11-12: the real client's own AUTH packet (arg0=2, the public
// key) carried data_crc32 = 0, while its CNXN carried the byte sum. The
// checksum is therefore not a property of the payload — it is a property of
// the message type, and guessing "crc32 like the server does for CNXN" is
// what made the server-side AUTH invisible to the client.
function buildAuth(arg0, payload) {
  const header = Buffer.alloc(HEADER_SIZE);
  header.write('AUTH', 0, 4, 'ascii');
  header.writeUInt32LE(arg0 >>> 0, 4);
  header.writeUInt32LE(0, 8);
  header.writeUInt32LE(payload.length, 12);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(magicFor('AUTH'), 20);
  return Buffer.concat([header, payload]);
}

const token = crypto.randomBytes(20);
// The challenge the fake server signs off with: a fresh 20 bytes, different
// from `token` so the two can never be confused in the capture.
const challenge = crypto.randomBytes(20);

const server = net.createServer((socket) => {
  let buf = Buffer.alloc(0);
  let phase = 'cnnn';

  const emit = (rec) => {
    console.log(JSON.stringify(rec));
    if (outFile) fs.appendFileSync(outFile, JSON.stringify(rec) + '\n');
  };

  // Record what the fake server sends too. The token the server challenges
  // with and the signature the client answers with have to come from the SAME
  // run — that pair is what proves the signing algorithm.
  const emitServer = (command, arg0, arg1, payload) => {
    emit({
      dir: 'server->client',
      command,
      arg0,
      arg1,
      dataLength: payload.length,
      dataCrc32: '0x0',
      magic: '0x' + magicFor(command).toString(16),
      payloadHex: hex(payload),
      payloadText: payload.toString('utf8').replace(/[^\x20-\x7e]/g, '.'),
    });
  };

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= HEADER_SIZE) {
      const command = buf.toString('ascii', 0, 4);
      const arg0 = buf.readUInt32LE(4);
      const arg1 = buf.readUInt32LE(8);
      const dataLength = buf.readUInt32LE(12);
      const dataCrc32 = buf.readUInt32LE(16);
      const magic = buf.readUInt32LE(20);
      const total = HEADER_SIZE + dataLength;
      if (buf.length < total) break;
      const payload = buf.subarray(HEADER_SIZE, total);
      emit({
        dir: 'client->server',
        command,
        arg0,
        arg1,
        dataLength,
        dataCrc32: '0x' + dataCrc32.toString(16),
        magic: '0x' + magic.toString(16),
        payloadHex: hex(payload),
        payloadText: payload.toString('utf8').replace(/[^\x20-\x7e]/g, '.'),
      });
      buf = buf.subarray(total);

      if (command === 'CNXN' && phase === 'cnnn') {
        phase = 'await-auth';
        emitServer('CNXN', 0x01000001, 1048576, Buffer.from('device::ro.product.name=fake_device\0', 'utf8'));
        socket.write(
          build('CNXN', 0x01000001, 1048576, Buffer.from('device::ro.product.name=fake_device\0', 'utf8')),
        );
        emitServer('AUTH', AUTH_TOKEN, 0, token);
        socket.write(buildAuth(AUTH_TOKEN, token));
      } else if (command === 'AUTH' && phase === 'await-auth') {
        // The client answered our AUTH TOKEN with its SIGNATURE
        // (AUTH arg0=2, 256 bytes). What it does next depends on what we do
        // next — that is the thing being measured.
        phase = 'await-signature';
        if (mode === 'challenge') {
          emitServer('AUTH', AUTH_RSACHALLENGE, 0, challenge);
          socket.write(buildAuth(AUTH_RSACHALLENGE, challenge));
        } else if (mode === 'okay') {
          socket.write(build('OKAY', 0, 0, Buffer.alloc(0)));
        } else if (mode === 'serverkey') {
          // Answer with OUR public key: 256-byte raw modulus, same shape as the
          // one the client just sent us.
          socket.write(buildAuth(AUTH_RSAPUBLICKEY, fakeModulus));
        }
      } else if (command === 'AUTH' && phase === 'await-signature') {
        phase = 'authed';
        socket.write(build('OKAY', 0, 0, Buffer.alloc(0)));
      } else if (command === 'OPEN' && phase === 'authed') {
        phase = 'open';
        socket.write(build('OKAY', 0, 0, Buffer.alloc(0)));
        const out = Buffer.from('fake-shell-ok\n', 'utf8');
        socket.write(build('WRTE', 0, 0, out));
        socket.write(build('OKAY', 0, 0, Buffer.alloc(0)));
      } else if (command === 'WRTE') {
        socket.write(build('OKAY', 0, 0, Buffer.alloc(0)));
      }
    }
  });

  socket.on('error', () => {});
  socket.on('close', () => console.log('[fake-adbd] peer closed'));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[fake-adbd] listening on 127.0.0.1:${port}`);
});
