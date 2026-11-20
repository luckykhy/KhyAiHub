'use strict';

/**
 * deviceLinkWss.js — 设备出向链路（手机 → PC）的 WSS 服务端。
 *
 * 与 syncServer.js 的分工：syncServer 挂在 aiManagementServer 的明文 HTTP 上，
 * 服务多端会话同步；本模块给 Android 端 BridgeLink 一条**自签证书 TLS** 的
 * 独立入口——设备侧用 App 内置指纹 pin 校验（bridge_link_tls.dart），所以
 * 证书不需要 CA 签发，也不进系统信任库。
 *
 * 协议与 syncServer 逐字同形（设备只学会一种说话方式）：
 *   Client → Server: { type:'auth', deviceId, publicKey, ts, sig, platform, deviceName }
 *                     { type:'ping', ts }
 *                     { type:'session:join', sessionId }
 *   Server → Client: { type:'auth:ok', deviceId, userId, platforms, via, timestamp }
 *                     { type:'auth:error', error, code }
 *                     { type:'pong', timestamp }
 *                     { type:'session:joined', sessionId, participants }
 *                     { type:'command', command, payload, sessionId, msg_id }
 *
 * 鉴权只走设备签名这一条路（deviceSignatureAuth.verifyAuthFrame）：没有
 * token 分支可回落——回落等于给「拿旧 token 冒充设备」留门。设备公钥先经
 * admin 口（只绑 127.0.0.1）登记，登记数据来自桥已鉴权面读到的身份，未经
 * 鉴权来源的公钥不能进登记表。
 *
 * 证书：keytool（本机 JDK）生成自签 RSA-2048 PKCS12，持久在数据目录；
 * PC 重启、进程回收都复用同一张，指纹才与 App 内置 pin 保持一致。
 *
 * <h2>生命周期归属（S0 验收复审 2026-11-17）</h2>
 * 本模块只提供 startDeviceLinkServer，**不自己决定何时常驻**：src/ 内没有
 * 调用方，当前由 runner/harness 起（如 gitignored 的
 * works/data/khy/feedback/khyos-structured-link-20261114/harness/wss-link.mjs）。
 * 产品里没有服务在跑时，phoneBridgeClient 的自动登记会如实收敛为
 * admin_unreachable 并跳过——这是正常状态，不是错误。要把它变成产品常驻
 * 入口（新增 CLI 命令或并入既有进程）会触碰交付棘轮，属独立裁决。
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { WebSocketServer } = require('ws');
const { DeviceKeyRegistry, defaultDeviceKeyStateFile, ERR } = require('./deviceSignatureAuth');
const {
  DEVICE_LINK_WSS_PORT, DEVICE_LINK_ADMIN_PORT, DEVICE_LINK_MAX_DEVICES,
  DEVICE_LINK_ADMIN_REGISTER_PATH, DEVICE_LINK_ADMIN_STATE_PATH,
} = require('../../../constants/serviceDefaults');

const CERT_META_VERSION = 1;
// TLS 证书 10 年：指纹 pin 在 App 里，换证书等于让所有装机换链路配置。
const CERT_VALIDITY_DAYS = 3650;

// 登记面的路径只写一次：真源在 constants/serviceDefaults.js，本文件与 PC 侧
// （domain/network/phone/phoneBridgeClient）都从那里取，免得「客户端抄一份字符串」
// 再次漂移。放在 constants 而不是这里，是因为手机桥侧（D2 域）也要用这两个路径去
// 调同一条 admin 口，而 D2 不得反向 require D1 的 services/。
const ADMIN_REGISTER_PATH = DEVICE_LINK_ADMIN_REGISTER_PATH;
const ADMIN_STATE_PATH = DEVICE_LINK_ADMIN_STATE_PATH;

/**
 * 找 keytool。顺序：KHY_KEYTOOL 显式指定 → JAVA_HOME → PATH（where/command -v）。
 * 不写任何绝对路径字面量——JDK 的落点每台机器都不同。
 */
function findKeytool() {
  const exe = process.platform === 'win32' ? 'keytool.exe' : 'keytool';
  const candidates = [];
  if (process.env.KHY_KEYTOOL) candidates.push(process.env.KHY_KEYTOOL);
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', exe));
  for (const c of candidates) {
    try {
      execFileSync(c, ['-help'], { stdio: 'ignore', timeout: 15000, windowsHide: true });
      return c;
    } catch (e) {
      // ENOENT = 文件不存在，换下一个；能跑起来但 -help 退出非 0 的 keytool
      // 变体也照样能用，不因 exit code 误判成「没找到」。
      if (e && e.code === 'ENOENT') continue;
      return c;
    }
  }
  try {
    const probe = process.platform === 'win32'
      ? execFileSync('where.exe', ['keytool'], { timeout: 15000, windowsHide: true, encoding: 'utf8' })
      : execFileSync('command', ['-v', 'keytool'], { timeout: 15000, windowsHide: true, shell: true, encoding: 'utf8' });
    const first = String(probe).split(/\r?\n/).find((l) => l.trim().length > 0);
    if (first) return first.trim();
  } catch {
    /* fall through */
  }
  throw new Error('keytool 未找到：设置 KHY_KEYTOOL 或 JAVA_HOME，或把 JDK 的 bin 加入 PATH');
}

/** Node 的 X509Certificate.fingerprint256 是冒号分隔大写 hex；pin 侧统一成小写无冒号。 */
function normalizeFingerprint(fp) {
  return String(fp || '').replace(/:/g, '').toLowerCase();
}

/**
 * 生成（或复用）自签证书。幂等：cert/meta 都在 → 直接返回。
 *
 * @param {{dir: string, force?: boolean}} opts dir 下落 device-link.p12 /
 *        device-link-cert.pem / device-link-cert-meta.json
 */
function ensureDeviceLinkCert({ dir, force = false } = {}) {
  if (!dir) throw new Error('证书目录不能为空');
  fs.mkdirSync(dir, { recursive: true });
  const p12Path = path.join(dir, 'device-link.p12');
  const pemPath = path.join(dir, 'device-link-cert.pem');
  const metaPath = path.join(dir, 'device-link-cert-meta.json');

  if (!force && fs.existsSync(p12Path) && fs.existsSync(pemPath) && fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const fp = normalizeFingerprint(new crypto.X509Certificate(fs.readFileSync(pemPath)).fingerprint256);
    if (fp !== meta.fingerprint) {
      // pem 与 meta 漂移（手改/半次写入）：指纹以 pem 现算为准并回写。
      meta.fingerprint = fp;
      fs.writeFileSync(metaPath, JSON.stringify({ ...meta, fingerprint: fp }, null, 2), 'utf8');
    }
    return { p12Path, pemPath, metaPath, fingerprint: fp, generated: false, passphrase: meta.passphrase };
  }

  const keytool = findKeytool();
  // passphrase 只在本机 meta 文件里：它防的是「拿到 p12 文件的其他本地进程」，
  // 挡不了同盘读写，不是跨机凭据；私钥不出这台机器。
  const passphrase = crypto.randomBytes(18).toString('base64url');
  const dname = 'CN=khy-os-device-link, O=KhyOS, C=CN';
  execFileSync(keytool, [
    '-genkeypair', '-alias', 'device-link',
    '-keyalg', 'RSA', '-keysize', '2048',
    '-validity', String(CERT_VALIDITY_DAYS),
    '-storetype', 'PKCS12',
    '-keystore', p12Path, '-storepass', passphrase,
    '-dname', dname,
  ], { stdio: 'ignore', timeout: 60000, windowsHide: true });
  execFileSync(keytool, [
    '-exportcert', '-rfc', '-alias', 'device-link',
    '-keystore', p12Path, '-storepass', passphrase, '-file', pemPath,
  ], { stdio: 'ignore', timeout: 30000, windowsHide: true });

  const fingerprint = normalizeFingerprint(new crypto.X509Certificate(fs.readFileSync(pemPath)).fingerprint256);
  const meta = {
    v: CERT_META_VERSION,
    fingerprint,
    passphrase,
    dname,
    validityDays: CERT_VALIDITY_DAYS,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  return { p12Path, pemPath, metaPath, fingerprint, generated: true, passphrase };
}

function _now() { return Date.now(); }

/**
 * 起服务。返回句柄；进程生命周期归调用方（CLI/harness/gate）管。
 *
 * @param {{wssPort?: number, adminPort?: number, certDir?: string,
 *          registryFile?: string, maxDevices?: number}} opts 端口缺省取
 *        serviceDefaults；maxDevices 缺省取 DEVICE_LINK_MAX_DEVICES，显式 0＝不限。
 */
function startDeviceLinkServer(opts = {}) {
  const wssPort = opts.wssPort || DEVICE_LINK_WSS_PORT;
  const adminPort = opts.adminPort || DEVICE_LINK_ADMIN_PORT;
  // 名额：显式传 0 表示不限；缺省取 serviceDefaults（默认 8）。
  const maxDevices = Number(opts.maxDevices) > 0
    ? Math.floor(Number(opts.maxDevices))
    : (opts.maxDevices === 0 ? 0 : DEVICE_LINK_MAX_DEVICES);
  if (!opts.certDir) throw new Error('certDir 不能为空');
  const cert = ensureDeviceLinkCert({ dir: opts.certDir });

  const state = {
    startedAt: _now(),
    connections: 0,
    auths: 0,
    authFailures: 0,
    pings: 0,
    pongs: 0,
    commands: 0,
    tlsHandshakes: 0,
    nonTlsRejected: 0,
    lastAuth: null,
    lastPongAt: 0,
    lastCommandAt: 0,
    devices: new Map(), // deviceId → { ws, platform, deviceName, sessions:Set, connectedAt }
    events: [],
    // 登记状态（status 面）：registered＝链路认得已登记设备；unregistered＝
    // 一台都没有 / 设备带着未知 key 上门；re_registered＝刚刚把一台服务端不
    // 认识的设备自动补登记了。last_reg_ms/source 只在成功登记时刷新。
    reg: {
      reg_state: 'unregistered',
      last_reg_ms: null,
      registration_source: null,
    },
  };
  // 登记表：显式 registryFile 优先（harness 用），否则落产品面共享文件——
  // 「登记」本来就该活过进程生命周期，进程内表等于每次重启都让设备重新被拒。
  const registryFile = opts.registryFile || defaultDeviceKeyStateFile();
  const registry = registryFile
    ? new DeviceKeyRegistry({ stateFile: registryFile, maxDevices })
    : new DeviceKeyRegistry({ maxDevices });
  // 被删/被服务端遗忘的 deviceId：它们再回来时才算一次「重新登记」。
  const lostDeviceIds = new Set();
  // 落盘的登记表里已有设备 = 链路启动时就认得它们。
  if (registry.list().length > 0) state.reg.reg_state = 'registered';

  function noteRegistration(result) {
    const isReRegister = result.alreadyEnrolled === false
      && (state.reg.reg_state === 'unregistered' || lostDeviceIds.has(result.deviceId));
    lostDeviceIds.delete(result.deviceId);
    state.reg.reg_state = isReRegister ? 're_registered' : 'registered';
    state.reg.last_reg_ms = Number.isFinite(result.registeredAt) ? result.registeredAt : _now();
    state.reg.registration_source = result.regSource === 'auto' ? 'auto' : 'manual';
  }

  function note(kind, detail) {
    state.events.push({ ts: _now(), kind, detail: detail || {} });
    if (state.events.length > 200) state.events.shift();
  }

  function sendTo(ws, obj) {
    try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  function sendCommand(frame) {
    let sent = 0;
    for (const [, dev] of state.devices) {
      if (dev.ws.readyState === 1) {
        sendTo(dev.ws, {
          type: 'command',
          command: frame.command,
          payload: frame.payload !== undefined ? frame.payload : frame.command,
          sessionId: frame.sessionId || '',
          msg_id: frame.msgId || '',
        });
        sent++;
      }
    }
    if (sent > 0) {
      state.commands += sent;
      state.lastCommandAt = _now();
      note('command', { command: String(frame.command).slice(0, 120), msg_id: frame.msgId || '' });
    }
    return sent;
  }

  // ── TLS + WebSocket ────────────────────────────────────────────────
  // https.Server（= http.Server over TLS）而不是裸 tls.Server：ws 的升级握手
  // 挂在 http 语义的 'upgrade' 事件上，tls.Server 不解析 HTTP、不发该事件。
  const tlsServer = https.createServer({
    pfx: fs.readFileSync(cert.p12Path),
    passphrase: cert.passphrase,
  });

  tlsServer.on('tlsClientError', (err, tlsSocket) => {
    note('tls-error', { message: err && err.message });
    try { tlsSocket.destroy(); } catch { /* already gone */ }
  });

  const wss = new WebSocketServer({ server: tlsServer, maxPayload: 1024 * 1024 });

  wss.on('connection', (ws, req) => {
    const isTls = Boolean(req.socket && typeof req.socket.getCipher === 'function');
    if (!isTls) {
      // 理论到不了（listener 挂在 TLS server 上）；保底拒绝明文升级。
      state.nonTlsRejected++;
      try { ws.close(1008, 'plaintext upgrade rejected'); } catch { /* closed */ }
      return;
    }
    state.connections++;
    state.tlsHandshakes++;
    const cipher = req.socket.getCipher();
    note('connection', {
      from: req.socket.remoteAddress,
      transport: 'tls',
      cipher: cipher ? `${cipher.name}/${cipher.version}` : '',
    });

    let deviceId = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString('utf8')); } catch {
        sendTo(ws, { type: 'error', error: 'Invalid JSON' });
        return;
      }
      if (!msg || !msg.type) return;

      // 鉴权闸门（与 syncServer 同语义）：auth / ping 之外都要已注册连接。
      if (msg.type !== 'auth' && msg.type !== 'ping') {
        const registered = deviceId ? state.devices.get(deviceId) : null;
        if (!registered || registered.ws !== ws) {
          ws.close(1008, 'Not authenticated');
          return;
        }
      }

      switch (msg.type) {
        case 'auth': {
          const verdict = registry.verifyAuthFrame({
            deviceId: msg.deviceId,
            publicKey: msg.publicKey,
            ts: msg.ts,
            sig: msg.sig,
          });
          if (!verdict.ok) {
            state.authFailures++;
            if (verdict.code === ERR.NOT_ENROLLED) {
              // 服务端不认识这把 key：登记进 lostDeviceIds，等 PC 侧自动重新
              // 登记把它捞回来时才算 re_registered。只有登记表空着时才把整条
              // 链路判「未登记」——多设备时一台陌生 key 上门不该抹掉别人的在册。
              lostDeviceIds.add(String(msg.deviceId || '').toLowerCase());
              if (registry.list().length === 0) state.reg.reg_state = 'unregistered';
            }
            sendTo(ws, {
              type: 'auth:error',
              error: '设备签名校验失败',
              code: verdict.code,
              deviceId: msg.deviceId || '',
            });
            ws.close(1008, `Device auth failed: ${verdict.code}`);
            note('auth-fail', { code: verdict.code, deviceId: msg.deviceId || '' });
            return;
          }
          deviceId = verdict.deviceId;
          state.auths++;
          // 已登记设备成功鉴权 = 链路确实认得它；但 re_registered 的证据不覆盖
          // （那是「刚补登记过」的历史，不是当前在线状态）。
          if (state.reg.reg_state === 'unregistered') state.reg.reg_state = 'registered';
          state.lastAuth = {
            deviceId,
            platform: verdict.platform,
            deviceName: verdict.deviceName,
            userId: verdict.userId,
            via: 'device-signature',
          };
          state.devices.set(deviceId, {
            ws,
            platform: verdict.platform || 'android',
            deviceName: verdict.deviceName || '',
            sessions: new Set(),
            connectedAt: _now(),
          });
          sendTo(ws, {
            type: 'auth:ok',
            deviceId,
            userId: verdict.userId,
            platforms: { android: 1 },
            via: 'device-signature',
            timestamp: _now(),
          });
          note('auth', state.lastAuth);
          return;
        }
        case 'ping': {
          state.pings++;
          state.pongs++;
          state.lastPongAt = _now();
          sendTo(ws, { type: 'pong', timestamp: _now() });
          return;
        }
        case 'session:join': {
          const id = String(msg.sessionId || '');
          if (!id) return;
          const dev = state.devices.get(deviceId);
          if (!dev) return;
          dev.sessions.add(id);
          sendTo(ws, { type: 'session:joined', sessionId: id, participants: [] });
          note('session-join', { deviceId, sessionId: id });
          return;
        }
        case 'session:leave': {
          const dev = state.devices.get(deviceId);
          if (dev) dev.sessions.delete(String(msg.sessionId || ''));
          return;
        }
        default:
          sendTo(ws, { type: 'error', error: `Unknown message type: ${msg.type}` });
      }
    });

    ws.on('close', () => {
      if (deviceId) {
        state.devices.delete(deviceId);
        note('close', { deviceId, left: state.devices.size });
      }
    });
    ws.on('error', () => {
      if (deviceId) state.devices.delete(deviceId);
    });
  });

  // 30s 心跳清扫（与 syncServer 同参数）：半开链路由 terminate 收尸。
  const sweeper = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* dying socket */ }
    }
  }, 30000);

  tlsServer.listen(wssPort, '0.0.0.0');

  // ── loopback admin：只绑 127.0.0.1，登记/下发/状态全在这条口上 ──────
  const admin = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === ADMIN_STATE_PATH) {
      return json(200, {
        ok: true,
        wssPort,
        adminPort,
        fingerprint: cert.fingerprint,
        connections: state.connections,
        tlsHandshakes: state.tlsHandshakes,
        nonTlsRejected: state.nonTlsRejected,
        auths: state.auths,
        authFailures: state.authFailures,
        pings: state.pings,
        pongs: state.pongs,
        commands: state.commands,
        lastAuth: state.lastAuth,
        lastPongAt: state.lastPongAt,
        lastCommandAt: state.lastCommandAt,
        // 登记面（S0 status）：used/max/devices＋reg_state/last_reg_ms/
        // registration_source。名额一旦存在就必须看得见——看不见的名额
        // 满就是一条无声死路（与 ui=false 要带原因同一个教训）。
        registry: {
          used: registry.list().length,
          max: maxDevices,
          // 每台带 regSource/registeredAt：PC 侧缓存路径据它判断「服务端认不
          // 认识这台」并填 status 的 registration_source/last_reg_ms，不用为此
          // 再读一次设备的 status.json。
          devices: registry.list().map((row) => ({
            deviceId: row.deviceId,
            regSource: row.regSource === 'auto' ? 'auto' : 'manual',
            registeredAt: Number.isFinite(row.registeredAt) ? row.registeredAt : (row.enrolledAt || null),
          })),
        },
        reg: { ...state.reg },
        devices: [...state.devices.entries()].map(([id, d]) => ({
          deviceId: id,
          platform: d.platform,
          deviceName: d.deviceName,
          sessions: [...d.sessions],
          connectedAt: d.connectedAt,
        })),
        events: state.events.slice(-40),
      });
    }
    if (url.pathname === ADMIN_REGISTER_PATH && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
      req.on('end', () => {
        let m;
        try { m = JSON.parse(body); } catch { return json(400, { ok: false, error: 'Invalid JSON' }); }
        const r = registry.enroll({
          deviceId: m.deviceId,
          publicKey: m.publicKey,
          userId: m.userId || 'local',
          platform: m.platform || 'android',
          deviceName: m.deviceName || '',
          source: m.source,
        });
        if (!r.ok) {
          // 名额满时把 used/max 一起带回：调用方要的就是「还差几个位子、去哪腾」。
          const extra = r.code === ERR.SLOTS_FULL
            ? { used: registry.list().length, max: maxDevices }
            : {};
          return json(400, { ok: false, code: r.code, ...extra });
        }
        noteRegistration(r);
        return json(200, {
          ok: true,
          deviceId: r.deviceId,
          alreadyEnrolled: r.alreadyEnrolled,
          regSource: r.regSource,
          registeredAt: r.registeredAt,
        });
      });
      return;
    }
    if (url.pathname === '/command' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        let m;
        try { m = JSON.parse(body); } catch { return json(400, { ok: false, error: 'Invalid JSON' }); }
        if (!m.command) return json(400, { ok: false, error: 'command 不能为空' });
        const sent = sendCommand(m);
        return json(200, { ok: sent > 0, sent });
      });
      return;
    }
    if (url.pathname === '/cert') {
      return json(200, { ok: true, fingerprint: cert.fingerprint, pemPath: cert.pemPath });
    }
    // DELETE /devices/<id>：就地腾位。这个 runner 形态的 wss 服务不在主 backend
    // 进程里，账号 REST 那条 DELETE 触不到它——名额满又没有这条口，就是死路。
    // 语义抄 routes/crossPlatform.js：吊销 = 界面删了，链路就不能再签名进来。
    const deleteMatch = /^\/devices\/([0-9a-fA-F]{16})$/.exec(url.pathname);
    if (deleteMatch && req.method === 'DELETE') {
      const deviceId = deleteMatch[1].toLowerCase();
      const removed = registry.forget(deviceId);
      if (removed) {
        lostDeviceIds.add(deviceId);
        // 删空 = 链路手上没有任何已登记设备，status 必须这么说。
        if (registry.list().length === 0) state.reg.reg_state = 'unregistered';
      }
      return json(200, { ok: true, removed, deviceId });
    }
    res.writeHead(404);
    res.end('not found');
  });
  admin.listen(adminPort, '127.0.0.1');

  function close() {
    clearInterval(sweeper);
    for (const ws of wss.clients) {
      try { ws.close(1001, 'Server shutting down'); } catch { /* gone */ }
    }
    try { wss.close(); } catch { /* noop */ }
    try { tlsServer.close(); } catch { /* noop */ }
    try { admin.close(); } catch { /* noop */ }
  }

  return {
    wss,
    tlsServer,
    admin,
    close,
    registry,
    state,
    cert,
    endpoint: `wss://0.0.0.0:${wssPort}`,
  };
}

/** PC 局域网 IP：设备要把出向链路连到这台机器，端点里得有真实 IP。
 * 本机可能有多张网卡（2026-11-15 实测同时有 192.168.1.x 与 192.168.2.x），
 * 给了 peerSubnet（如设备 IP 所在 /24）就优先挑同网段的 iface。 */
function lanIpForDevice(peerSubnet) {
  const ifs = os.networkInterfaces();
  const prefs = [];
  for (const [name, addrs] of Object.entries(ifs)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      prefs.push({ name, addr: a.address });
    }
  }
  if (peerSubnet) {
    const same = prefs.find((p) => p.addr.startsWith(`${peerSubnet}.`));
    if (same) return same.addr;
  }
  // 192.168 / 10. / 172. 优先，其余按出现顺序兜底。
  const lan = prefs.find((p) => p.addr.startsWith('192.168.'))
    || prefs.find((p) => p.addr.startsWith('10.'))
    || prefs.find((p) => /^172\.(1[6-9]|2\d|3[01])\./.test(p.addr))
    || prefs[0];
  return lan ? lan.addr : '';
}

module.exports = {
  ensureDeviceLinkCert,
  startDeviceLinkServer,
  findKeytool,
  lanIpForDevice,
  normalizeFingerprint,
  ADMIN_REGISTER_PATH,
  ADMIN_STATE_PATH,
  // 判定脚本与 runner 从这里取端口真源，避免再引 serviceDefaults 一份。
  DEVICE_LINK_WSS_PORT,
  DEVICE_LINK_ADMIN_PORT,
  DEVICE_LINK_MAX_DEVICES,
};
