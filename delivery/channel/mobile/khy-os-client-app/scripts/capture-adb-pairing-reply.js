// capture-adb-pairing-reply.js — make the phone's own adbd answer, so the
// pairing exchange can be recorded end to end.
//
// WHY. The pairing endpoint only exists while the phone shows "pair device
// with pairing code"; once the user pairs, the port closes. So this script
// does not ask the user to time anything: it POLLS the device for a
// loopback listener owned by adbd (uid 2000) that is not the sidecar port,
// forwards it to this PC, replays the first packet a real client sends, and
// records the reply.
//
// The phone's adbd is the authority here — this is the missing half of the
// pairing protocol (the client half is already captured; see
// AdbPairingProtocol.kt and capture-adb-pairing.js).
//
// Usage:
//   node capture-adb-pairing-reply.js <outfile> [timeoutSeconds]
//
// Then (on the phone): 设置 → 无线调试 → 使用配对码配对设备 → keep the screen
// open. The script catches the port the moment it appears.
//
// The output file is an artifact and belongs OUTSIDE the repository.

'use strict';

const { execFileSync } = require('child_process');
const tls = require('tls');
const fs = require('fs');
const crypto = require('crypto');

const outFile = process.argv[2] || 'pairing-reply.jsonl';
const timeoutSec = parseInt(process.argv[3] || '180', 10);

const ADB = process.env.ADB_PATH || 'adb';

/** Silence after which a capture attempt is abandoned (renewed by traffic). */
const IDLE_MS = 15000;
/** Quiet period after which the accumulated bytes are flushed to disk. */
const FLUSH_IDLE_MS = 900;

// The first packet a real client sends, per the captured golden vector:
//   version(4, LE) = 01 00 00 00 | 00 20 | 32 connection-scoped bytes
function firstPacket() {
  const material = crypto.randomBytes(32);
  return Buffer.concat([Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x20]), material]);
}

function adb(args, opts = {}) {
  return execFileSync(ADB, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
}

function deviceSerial() {
  const out = adb(['devices']);
  const rows = [];
  for (const line of out.split(/\r?\n/).slice(1)) {
    const m = line.match(/^(.+?)\s+device\s*$/);
    if (m) rows.push(m[1]);
  }
  if (!rows.length) throw new Error('no adb device');
  return rows[0];
}

function hex(buf) {
  return buf.toString('hex').replace(/(..)/g, '$1 ').trim();
}

/**
 * The phone's pairing endpoint, discovered the way the phone advertises it.
 *
 * The pairing screen advertises `_adb-tls-pairing._tcp` over mDNS, and the
 * address in that advertisement is exactly the one a PC pairs with — so the
 * port is found here instead of guessed from /proc. (The pairing listener is
 * bound to the phone's LAN address, not to loopback, so `adb forward` would
 * not reach it; connecting straight to the advertised address does.)
 *
 * Returns null while the pairing screen is closed.
 */
function findPairingEndpoint() {
  let out = '';
  try {
    out = adb(['mdns', 'services']);
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

function replay(serial, endpoint) {
  const { host, port: devicePort } = endpoint;
  const socket = tls.connect(
    { host, port: devicePort, rejectUnauthorized: false },
    () => {
      const pkt = firstPacket();
      record({ phase: 'sent', to: `${host}:${devicePort}`, bytes: pkt.length, hex: hex(pkt) });
      socket.write(pkt);
      resetIdle();
    },
  );
  const chunks = [];
  let idleTimer = null;
  let lastActivity = Date.now();

  // Idle watchdog, not a wall-clock deadline: every byte the peer sends
  // re-arms it, so a slow-but-alive peer is never cut off. Only a peer that
  // has gone silent for IDLE_MS ends the capture.
  function resetIdle() {
    lastActivity = Date.now();
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdle, IDLE_MS);
  }
  function onIdle() {
    const all = Buffer.concat(chunks);
    record({ phase: 'idle-timeout', bytes: all.length, hex: hex(all) });
    socket.destroy();
    try { adb(['-s', serial, 'forward', '--remove', `tcp:${localPort}`]); } catch (e) {}
    process.exit(2);
  }

  socket.on('data', (c) => {
    chunks.push(c);
    resetIdle();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const all = Buffer.concat(chunks);
      record({ phase: 'reply', bytes: all.length, hex: hex(all) });
      socket.destroy();
      process.exit(0);
    }, FLUSH_IDLE_MS);
  });
  socket.on('error', (e) => record({ error: 'tls: ' + e.message }));
  resetIdle();
}

function main() {
  let serial;
  try {
    serial = deviceSerial();
  } catch (e) {
    console.error('no adb device: ' + e.message);
    process.exit(1);
  }
  console.log(`[capture] watching for the phone's pairing endpoint (mDNS _adb-tls-pairing._tcp)...`);
  console.log('[capture] open 设置 → 无线调试 → 使用配对码配对设备 and keep it open.');
  const deadline = Date.now() + timeoutSec * 1000;
  const seen = new Set();
  const tick = () => {
    if (Date.now() > deadline) {
      record({ phase: 'gave-up' });
      process.exit(3);
    }
    try {
      const endpoint = findPairingEndpoint();
      if (endpoint) {
        const key = `${endpoint.host}:${endpoint.port}`;
        if (!seen.has(key)) {
          seen.add(key);
          console.log(`[capture] pairing endpoint ${key} -> replaying first packet`);
          replay(serial, endpoint);
          return;
        }
      }
    } catch (e) {
      // the device may have dropped; keep polling until the deadline
    }
    setTimeout(tick, 700);
  };
  tick();
}

main();
