/**
 * Integration tests for the bridge collaboration upload path: the mobile page
 * POSTs attachments to /api/upload (bearer-authenticated, multipart) and rides
 * the resulting ids on the WS {type:'input'} payload, which the server forwards
 * to onBridgeEvent('input').
 *
 *   node --test tests/bridge/uploadRoute.test.js
 *
 * Uses real http/ws/multer (Node 18+ global fetch/FormData/Blob) against an
 * ephemeral bridge instance — the handlers are not exported, so we exercise
 * them over the wire exactly as the phone does.
 */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Deterministic JWT secret + throwaway data home BEFORE requiring the modules.
process.env.BRIDGE_JWT_SECRET = process.env.BRIDGE_JWT_SECRET || 'bridge-upload-test-secret';
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-bridge-upl-'));
process.env.KHY_DATA_HOME = TMP_HOME;
process.env.BRIDGE_PORT = process.env.BRIDGE_PORT || '18741';
// Skip transcription/extraction noise — we only test transport here.
process.env.KHY_UPLOAD_ENRICH = '0';

const server = require('../../src/bridge/bridgeServer');
const auth = require('../../src/bridge/bridgeAuth');

let depsOk = true;
try { require('ws'); require('multer'); require('better-sqlite3'); } catch { depsOk = false; }

let base = '';
let jwt = '';
let wsToken = '';

before(async () => {
  if (!depsOk) return;
  // Seed credentials come from the unified generator (persisted under the
  // throwaway KHY_DATA_HOME set above) — no hardcoded username/password.
  const credGen = require('../../src/services/credentialGenerator');
  const creds = credGen.loadOrCreateDefaultAdminCredentials();
  auth.initUserDb();
  const login = auth.loginUser(creds.username, creds.password);
  assert.ok(login.ok && login.token, 'seeded admin login issues a JWT');
  jwt = login.token;

  const started = await server.startBridgeServer();
  assert.ok(started.port > 0, 'bridge server bound a port');
  base = `http://127.0.0.1:${started.port}`;
  wsToken = started.token;
});

after(async () => {
  try { await server.stopBridgeServer(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('POST /api/upload without bearer → 401', { skip: !depsOk && 'ws/multer/sqlite unavailable' }, async () => {
  const fd = new FormData();
  fd.append('file', new Blob(['hi'], { type: 'text/plain' }), 'note.txt');
  const r = await fetch(`${base}/api/upload`, { method: 'POST', body: fd });
  assert.equal(r.status, 401);
});

test('POST /api/upload with bearer → commits + returns descriptor; GET streams it back', { skip: !depsOk && 'deps unavailable' }, async () => {
  const fd = new FormData();
  fd.append('file', new Blob(['hello attachment'], { type: 'text/plain' }), 'note.txt');
  const r = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}` },
    body: fd,
  });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.success, true);
  assert.equal(data.attachments.length, 1);
  const desc = data.attachments[0];
  assert.match(desc.id, /^[a-f0-9]{32}$/);
  assert.equal(desc.kind, 'text');
  assert.equal(desc.url, `/api/ai/upload/${desc.id}`);

  // Download / preview path streams the stored bytes back.
  const dl = await fetch(`${base}/api/upload/${desc.id}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), 'hello attachment');

  // 4) WS {type:'input'} carries attachment ids → forwarded to onBridgeEvent.
  const WebSocket = require('ws');
  const events = [];
  const off = server.onBridgeEvent((event, payload) => {
    if (event === 'input') events.push(payload);
  });
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/`);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('ws timeout')); }, 4000);
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', token: wsToken }));
      } else if (msg.type === 'auth_ok') {
        ws.send(JSON.stringify({ type: 'input', text: 'look at this', attachments: [desc.id, 42, null] }));
        setTimeout(() => { clearTimeout(timer); try { ws.close(); } catch {} resolve(); }, 200);
      } else if (msg.type === 'auth_failed') {
        clearTimeout(timer); try { ws.close(); } catch {} reject(new Error('ws auth failed'));
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  off && off();

  assert.equal(events.length, 1, 'one input event forwarded');
  assert.equal(events[0].text, 'look at this');
  // Non-string ids are filtered out before forwarding.
  assert.deepEqual(events[0].attachments, [desc.id]);
});

// ── SEC-04：附件下载的对象级授权 ────────────────────────────────────────────
test('GET /api/upload/:id 取他人附件 → 404（属主校验，不泄露存在性）', { skip: !depsOk && 'deps unavailable' }, async () => {
  // A（默认管理员）上传一个附件
  const fd = new FormData();
  fd.append('file', new Blob(['A private body'], { type: 'text/plain' }), 'a-only.txt');
  const up = await fetch(`${base}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}` },
    body: fd,
  });
  assert.equal(up.status, 200);
  const upData = await up.json();
  const id = upData.attachments[0].id;

  // 注册并登录用户 B
  const reg = auth.registerUser('bridge_bob', 'bob-secret-123');
  assert.ok(reg.ok || /已存在/.test(reg.error || ''), 'user B registered');
  const loginB = auth.loginUser('bridge_bob', 'bob-secret-123');
  assert.ok(loginB.ok && loginB.token, 'user B logs in');

  // B 用自己的 token 取 A 的附件 → 404（不是 403，避免泄露「该 id 存在」）
  const cross = await fetch(`${base}/api/upload/${id}`, {
    headers: { Authorization: `Bearer ${loginB.token}` },
  });
  assert.equal(cross.status, 404);

  // A 自己取 → 200，内容完整
  const own = await fetch(`${base}/api/upload/${id}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  assert.equal(own.status, 200);
  assert.equal(await own.text(), 'A private body');
});
