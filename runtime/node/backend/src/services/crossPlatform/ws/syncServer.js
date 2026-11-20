'use strict';

/**
 * crossPlatformSyncServer.js — WebSocket server for 4-platform real-time sync.
 *
 * Attaches to the existing aiManagementServer HTTP server and handles
 * WebSocket connections from Terminal, Web, Desktop, and Mobile clients.
 *
 * Protocol:
 *   Client → Server:
 *     { type: 'auth', token, deviceId, platform, deviceName, userId }
 *     { type: 'ping' }
 *     { type: 'session:join', sessionId }
 *     { type: 'session:leave', sessionId }
 *     { type: 'session:update', sessionId, delta }
 *     { type: 'message:send', targetDeviceId?, targetPlatform?, payload }
 *     { type: 'command:route', targetPlatform, command, payload }
 *     { type: 'device:list' }
 *
 *   Server → Client:
 *     { type: 'auth:ok', deviceId, platforms, via }
 *       ↑ via 是 'token' 或 'device-signature'：排障时先看这条才知道该查哪边。
 *     { type: 'auth:error', error }
 *     { type: 'pong' }
 *     { type: 'session:updated', sessionId, state, version, modifiedBy }
 *     { type: 'session:joined', sessionId, participants }
 *     { type: 'message', fromDeviceId, fromPlatform, payload }
 *     { type: 'command', fromDeviceId, fromPlatform, command, payload }
 *     { type: 'presence', devices }
 *     { type: 'device:list', devices }
 *     { type: 'notification', title, body, data }
 *
 * @module services/crossPlatform/ws/syncServer
 */

const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { getRegistry: getDeviceKeyRegistry } = require('./deviceSignatureAuth');

// 设备公钥登记表（断点二）。进程内单例：注册走 REST（有 req.user），
// 校验走这里。没有它，设备签名分支只能 fail closed。
const deviceKeys = getDeviceKeyRegistry();

// ── Module state ────────────────────────────────────────────────────
let _wss = null;
let _hub = null;
let _authenticate = null;
let _clients = new Map(); // deviceId → { ws, userId, platform, deviceName, sessions: Set }
// 会话归属：sessionId → userId。跨设备同步的会话属于某个用户，他人不得加入、
// 读取或改写（SEC-01）。此前 hub 里的 session 记录只有 createdBy（设备号），
// 没有属主，join/update 都不做对象级鉴权。
const _sessionOwners = new Map();
let _persistenceDir = null;
let _persistenceFile = null;
let _persistenceDirty = false;
let _persistenceTimer = null;
let _httpServer = null; // kept so detach() can remove the upgrade listener
let _upgradeListener = null;
const PERSIST_INTERVAL_MS = 5000;

// ── Persistence helpers ─────────────────────────────────────────────

function _ensurePersistenceDir() {
  if (_persistenceDir) return;
  try {
    const { getDataDir } = require('../../../utils/dataHome');
    _persistenceDir = getDataDir('sync');
    fs.mkdirSync(_persistenceDir, { recursive: true });
    _persistenceFile = path.join(_persistenceDir, 'crossPlatformHub.json');
  } catch {
    _persistenceDir = null;
    _persistenceFile = null;
  }
}

function _loadFromDisk() {
  _ensurePersistenceDir();
  if (!_persistenceFile || !fs.existsSync(_persistenceFile)) return null;
  try {
    const raw = fs.readFileSync(_persistenceFile, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function _saveToDisk() {
  if (!_persistenceFile || !_hub) return;
  try {
    const snapshot = {
      savedAt: Date.now(),
      devices: _hub.listDevices({ connectedOnly: false }),
      sessions: Array.from(_hub._sessions?.entries() || []).map(([id, s]) => ({
        sessionId: id,
        state: s.state,
        version: s.version,
        lastModified: s.lastModified,
        modifiedBy: s.modifiedBy,
      })),
    };
    const tmp = `${_persistenceFile}.tmp.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf-8');
    fs.renameSync(tmp, _persistenceFile);
    _persistenceDirty = false;
  } catch {
    /* best effort */
  }
}

function _schedulePersistence() {
  _persistenceDirty = true;
  if (_persistenceTimer) return;
  _persistenceTimer = setTimeout(() => {
    _persistenceTimer = null;
    if (_persistenceDirty) _saveToDisk();
  }, PERSIST_INTERVAL_MS);
}

// ── Client management ───────────────────────────────────────────────

function _registerClient(deviceId, ws, info) {
  _clients.set(deviceId, {
    ws,
    userId: info.userId || 'anonymous',
    platform: info.platform,
    deviceName: info.deviceName || '',
    sessions: new Set(),
    connectedAt: Date.now(),
  });
}

function _unregisterClient(deviceId) {
  const client = _clients.get(deviceId);
  if (!client) return;

  // Leave all sessions
  for (const sessionId of client.sessions) {
    _hub?.unsubscribe?.(`${sessionId}:update`, deviceId);
  }
  _clients.delete(deviceId);
}

function _sendToClient(deviceId, message) {
  const client = _clients.get(deviceId);
  if (!client || client.ws.readyState !== WebSocket.OPEN) return false;
  try {
    client.ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function _broadcastToUser(userId, message, excludeDeviceId = null) {
  let delivered = 0;
  for (const [deviceId, client] of _clients) {
    if (client.userId === userId && deviceId !== excludeDeviceId) {
      if (_sendToClient(deviceId, message)) delivered++;
    }
  }
  return delivered;
}

function _broadcastToPlatform(platform, message, excludeDeviceId = null, onlyUserId = null) {
  let delivered = 0;
  for (const [deviceId, client] of _clients) {
    if (client.platform !== platform || deviceId === excludeDeviceId) continue;
    // onlyUserId 给了就只投给同一个用户的设备 —— 跨平台消息/命令不是广播给
    // 「该平台上的所有连接」的（那会把一个用户的指令送到别人的设备上）。
    if (onlyUserId && client.userId !== onlyUserId) continue;
    if (_sendToClient(deviceId, message)) delivered++;
  }
  return delivered;
}

function _broadcastPresence() {
  // 设备清单只披露**同一个用户**的设备。此前向所有连接广播整个清单（含他人
  // deviceId / userId / 设备名），本身也是一处跨用户信息泄露。
  for (const [deviceId, client] of _clients) {
    const devices = [];
    for (const [did, c] of _clients) {
      if (c.userId === client.userId) {
        devices.push({
          deviceId: did,
          platform: c.platform,
          deviceName: c.deviceName,
          userId: c.userId,
          connectedAt: c.connectedAt,
        });
      }
    }
    _sendToClient(deviceId, { type: 'presence', devices, timestamp: Date.now() });
  }
}

// ── Message handlers ────────────────────────────────────────────────

async function _handleAuth(ws, msg) {
  const { token, deviceId, platform, deviceName } = msg;

  if (!deviceId || !platform) {
    ws.send(JSON.stringify({
      type: 'auth:error',
      error: '认证信息缺失：deviceId 与 platform 为必填项，请检查客户端初始化后重连',
    }));
    return;
  }

  // ── 设备签名（断点二：身份单轨）─────────────────────────────────────
  //
  // 设备侧不再出示共享 token，改成「用自己私钥签 deviceId|ts，服务端拿注册
  // 公钥验签」。这条分支必须先于 token 分支：一旦设备开始带 publicKey，它就
  // 不该再回落到 token 校验——回落等于给「拿旧 token 冒充设备」留了后门。
  //
  // 拒因码要具体：`device_not_enrolled` 的下一步是「让 PC 去注册」，
  // `signature_invalid` 的下一步是「密钥不对/被篡改」，两者动作完全不同。
  if (msg.publicKey || msg.sig) {
    const verdict = deviceKeys.verifyAuthFrame({
      deviceId,
      publicKey: msg.publicKey,
      ts: msg.ts,
      sig: msg.sig,
    });
    if (!verdict.ok) {
      ws.send(JSON.stringify({
        type: 'auth:error',
        error: '设备签名校验失败',
        code: verdict.code,
        deviceId,
      }));
      ws.close(1008, `Device auth failed: ${verdict.code}`);
      return;
    }
    return _completeAuth(ws, msg, {
      deviceId: verdict.deviceId,
      platform: verdict.platform || platform,
      deviceName: verdict.deviceName || deviceName,
      userId: verdict.userId,
      via: 'device-signature',
    });
  }

  // 认证是**强制**的。此前 token 缺失或校验失败都会 fall through，把客户端在
  // 消息体里自填的 userId 当成身份，还照样回 auth:ok —— 等于「登录 + 越权」
  // 两步合成一步（SEC-01）。现在：没有接入认证器 / 没有 token / token 校验不过
  // / token 里没有用户身份，一律 close(1008)，不注册、不回 auth:ok。
  if (!_authenticate) {
    ws.close(1008, 'Authentication service unavailable');
    return;
  }
  if (!token) {
    ws.send(JSON.stringify({ type: 'auth:error', error: '缺少认证令牌' }));
    ws.close(1008, 'Missing token');
    return;
  }

  let authUserId = null;
  try {
    const result = await _authenticate(token, null, {});
    if (result?.ok && result.user?.id) {
      // 用**原始** user id，不加 'user:' 前缀：REST 侧的通知入口用
      // notifyUser(String(req.user.id))（routes/crossPlatform.js:185），两边
      // 格式必须一致，否则通知投不到自己的设备上。
      authUserId = String(result.user.id);
    }
  } catch {
    authUserId = null;
  }
  if (!authUserId) {
    ws.send(JSON.stringify({ type: 'auth:error', error: '认证失败' }));
    ws.close(1008, 'Authentication failed');
    return;
  }

  return _completeAuth(ws, msg, {
    deviceId,
    platform,
    deviceName,
    userId: authUserId,
    via: 'token',
  });
}

/**
 * 两条鉴权路径（token / 设备签名）的公共后半段。
 *
 * 抽出来是为了让「通过鉴权之后做什么」只有一份：注册 hub、登记客户端、
 * 回 auth:ok、广播 presence。两条路径各写一遍的话，迟早一条加了字段另一条
 * 没加——而那种差异只会在某类客户端上表现出来，最难查。
 */
function _completeAuth(ws, msg, { deviceId, platform, deviceName, userId, via }) {
  // Register with hub
  if (_hub) {
    _hub.registerDevice({
      deviceId,
      platform,
      userId,
      deviceName,
      capabilities: msg.capabilities || {},
    });
  }

  _registerClient(deviceId, ws, {
    userId,
    platform,
    deviceName,
  });

  // Send auth confirmation with current platforms
  const platforms = {};
  for (const [, client] of _clients) {
    if (client.userId === userId) {
      platforms[client.platform] = (platforms[client.platform] || 0) + 1;
    }
  }

  ws.send(JSON.stringify({
    type: 'auth:ok',
    deviceId,
    userId,
    platforms,
    // 鉴权方式要报出来：PC 侧排障时「这条连接是签名进来的还是 token 进来的」
    // 决定了下一步看哪一边（设备密钥 / 账号令牌）。
    via,
    timestamp: Date.now(),
  }));

  // Broadcast presence update
  _broadcastPresence();
  _schedulePersistence();

  return deviceId;
}

function _handlePing(ws, msg, deviceId) {
  _hub?.touchDevice(deviceId);
  ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
}

function _handleSessionJoin(ws, msg, deviceId) {
  const { sessionId } = msg;
  if (!sessionId) return;

  const client = _clients.get(deviceId);
  if (!client) return;

  // 对象级授权：会话有属主。他人不得加入（加入即拿到该会话全量 state）。
  const owner = _sessionOwners.get(sessionId);
  if (owner && owner !== client.userId) {
    ws.send(JSON.stringify({ type: 'session:error', sessionId, error: '无权访问该会话' }));
    return;
  }
  if (!owner) {
    _sessionOwners.set(sessionId, client.userId);
  }

  client.sessions.add(sessionId);
  _hub?.subscribe?.(`${sessionId}:update`, deviceId);

  // Register session if new
  if (_hub && !_hub.getSession(sessionId)) {
    _hub.registerSession(sessionId, { createdBy: deviceId });
  }

  // Notify other participants
  const participants = [];
  for (const [did, c] of _clients) {
    if (c.sessions.has(sessionId)) participants.push({ deviceId: did, platform: c.platform });
  }

  for (const [did, c] of _clients) {
    if (c.sessions.has(sessionId) && did !== deviceId) {
      _sendToClient(did, {
        type: 'session:joined',
        sessionId,
        deviceId,
        platform: client.platform,
        participants,
      });
    }
  }

  // Send current session state to joiner
  const session = _hub?.getSession(sessionId);
  if (session) {
    ws.send(JSON.stringify({
      type: 'session:updated',
      sessionId,
      state: session.state,
      version: session.version,
      modifiedBy: session.modifiedBy,
      timestamp: session.lastModified,
    }));
  }
}

function _handleSessionHandoff(ws, msg, deviceId) {
  const { sessionId, targetDeviceId, targetPlatform } = msg;
  if (!sessionId) return;

  const client = _clients.get(deviceId);
  if (!client) return;

  // Find target device
  let target = null;
  if (targetDeviceId) {
    target = _clients.get(targetDeviceId);
    // 指定目标设备时也必须是同一用户的设备（此前按 deviceId 直取，可指派到别人）。
    if (target && target.userId !== client.userId) target = null;
  } else if (targetPlatform) {
    for (const [did, c] of _clients) {
      if (c.platform === targetPlatform && c.userId === client.userId) {
        target = c;
        break;
      }
    }
  }

  if (!target) {
    _sendToClient(deviceId, {
      type: 'error',
      error: '目标设备不在线：请确认目标设备已连接并完成认证，然后重试会话移交',
    });
    return;
  }

  // Get current session state
  const session = _hub?.getSession(sessionId);
  if (!session) {
    _sendToClient(deviceId, {
      type: 'error',
      error: '会话不存在',
    });
    return;
  }

  // Send handoff request to target
  _sendToClient(target.deviceId, {
    type: 'session:handoff:request',
    sessionId,
    state: session.state,
    version: session.version,
    fromDeviceId: deviceId,
    fromPlatform: client.platform,
    timestamp: Date.now(),
  });

  // Notify source that handoff was initiated
  _sendToClient(deviceId, {
    type: 'session:handoff:initiated',
    sessionId,
    targetDeviceId: target.deviceId,
    timestamp: Date.now(),
  });
}

function _handleSessionHandoffAccept(ws, msg, deviceId) {
  const { sessionId } = msg;
  if (!sessionId) return;

  const client = _clients.get(deviceId);
  if (!client) return;

  // 对象级授权：他人不得接受移交（否则等于用「接受」路径加入他人会话）。
  const owner = _sessionOwners.get(sessionId);
  if (owner && owner !== client.userId) {
    ws.send(JSON.stringify({ type: 'session:error', sessionId, error: '无权访问该会话' }));
    return;
  }
  if (!owner) {
    _sessionOwners.set(sessionId, client.userId);
  }

  // Add target to session
  client.sessions.add(sessionId);

  // Notify all participants
  const participants = [];
  for (const [did, c] of _clients) {
    if (c.sessions.has(sessionId)) {
      participants.push({ deviceId: did, platform: c.platform });
    }
  }

  for (const [did, c] of _clients) {
    if (c.sessions.has(sessionId) && did !== deviceId) {
      _sendToClient(did, {
        type: 'session:handoff:accepted',
        sessionId,
        deviceId,
        platform: client.platform,
        participants,
      });
    }
  }

  // Send current session state to accepter
  const session = _hub?.getSession(sessionId);
  if (session) {
    ws.send(JSON.stringify({
      type: 'session:updated',
      sessionId,
      state: session.state,
      version: session.version,
      modifiedBy: session.modifiedBy,
      timestamp: session.lastModified,
    }));
  }
}

function _handleSessionLeave(ws, msg, deviceId) {
  const { sessionId } = msg;
  if (!sessionId) return;

  const client = _clients.get(deviceId);
  if (!client) return;

  client.sessions.delete(sessionId);
  _hub?.unsubscribe?.(`${sessionId}:update`, deviceId);
}

function _handleSessionUpdate(ws, msg, deviceId) {
  const { sessionId, delta } = msg;
  if (!sessionId || !delta) return;

  if (!_hub) return;

  const client = _clients.get(deviceId);
  if (!client) return;

  // 对象级授权：只有会话属主、且确实参与了该会话的客户端才能改写它。
  // 此前任意客户端都能改任意会话的状态（SEC-01）。
  const owner = _sessionOwners.get(sessionId);
  if ((owner && owner !== client.userId) || !client.sessions.has(sessionId)) {
    ws.send(JSON.stringify({ type: 'session:error', sessionId, error: '无权改写该会话' }));
    return;
  }

  const session = _hub.updateSession(sessionId, delta, deviceId);
  _schedulePersistence();

  // Broadcast to all participants in this session
  const message = {
    type: 'session:updated',
    sessionId,
    state: session.state,
    version: session.version,
    modifiedBy: deviceId,
    timestamp: session.lastModified,
  };

  for (const [did, client] of _clients) {
    if (client.sessions.has(sessionId) && did !== deviceId) {
      _sendToClient(did, message);
    }
  }
}

function _handleMessageSend(ws, msg, deviceId) {
  const { targetDeviceId, targetPlatform, payload } = msg;
  if (!payload) return;

  const client = _clients.get(deviceId);
  if (!client) return;

  const message = {
    type: 'message',
    fromDeviceId: deviceId,
    fromPlatform: client.platform,
    payload,
    timestamp: Date.now(),
  };

  if (targetDeviceId) {
    // 指定目标设备时也必须是**同一个用户**的设备：此前可以点名投递到别人的设备。
    const target = _clients.get(targetDeviceId);
    if (!target || target.userId !== client.userId) return;
    _sendToClient(targetDeviceId, message);
  } else if (targetPlatform) {
    _broadcastToPlatform(targetPlatform, message, deviceId, client.userId);
  } else {
    _broadcastToUser(client.userId, message, deviceId);
  }
}

function _handleCommandRoute(ws, msg, deviceId) {
  const { targetPlatform, command, payload } = msg;
  if (!targetPlatform || !command) return;

  const client = _clients.get(deviceId);
  if (!client) return;

  const message = {
    type: 'command',
    fromDeviceId: deviceId,
    fromPlatform: client.platform,
    command,
    payload: payload || {},
    timestamp: Date.now(),
  };

  _broadcastToPlatform(targetPlatform, message, deviceId, client.userId);
}

function _handleDeviceList(ws, msg, deviceId) {
  const client = _clients.get(deviceId);
  if (!client) return;

  const devices = [];
  for (const [did, c] of _clients) {
    if (c.userId === client.userId) {
      devices.push({
        deviceId: did,
        platform: c.platform,
        deviceName: c.deviceName,
        connectedAt: c.connectedAt,
      });
    }
  }

  ws.send(JSON.stringify({ type: 'device:list', devices }));
}

// ── WebSocket connection handler ────────────────────────────────────

function _handleConnection(ws, req) {
  let deviceId = null;

  // Liveness flag for the 30s heartbeat sweeper in attach(). It must start true
  // AND be reset by the 'pong' listener below: the sweeper flips it to false and
  // pings, then terminates any socket still false on the next pass. Without a
  // 'pong' handler nothing ever sets it back to true, so EVERY client — browser
  // included — was terminated ~60s after connecting and immediately reconnected,
  // which is the endless "WebSocket connection ... failed" loop in the console.
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
      return;
    }

    if (!msg || !msg.type) return;

    // 鉴权闸门：除 auth / ping 外，任何消息都要求该连接已通过认证并注册。
    // 此前 deviceId 直接取自 auth 消息，未认证的连接照样能发 session:join /
    // session:update / command:route —— 等于未认证即可读写他人会话（SEC-01）。
    if (msg.type !== 'auth' && msg.type !== 'ping') {
      const registered = deviceId ? _clients.get(deviceId) : null;
      if (!registered || registered.ws !== ws) {
        ws.close(1008, 'Not authenticated');
        return;
      }
    }

    try {
      switch (msg.type) {
        case 'auth': {
          const authed = await _handleAuth(ws, msg);
          // 只有认证成功才登记 deviceId：否则认证失败的连接在 close 时会拿
          // 「自称的 deviceId」去注销 hub 里的真实设备记录，把别人的设备挤下线。
          if (authed) deviceId = authed;
          break;
        }
        case 'ping':
          _handlePing(ws, msg, deviceId);
          break;
        case 'session:join':
          _handleSessionJoin(ws, msg, deviceId);
          break;
        case 'session:handoff':
          _handleSessionHandoff(ws, msg, deviceId);
          break;
        case 'session:handoff:accept':
          _handleSessionHandoffAccept(ws, msg, deviceId);
          break;
        case 'session:leave':
          _handleSessionLeave(ws, msg, deviceId);
          break;
        case 'session:update':
          _handleSessionUpdate(ws, msg, deviceId);
          break;
        case 'message:send':
          _handleMessageSend(ws, msg, deviceId);
          break;
        case 'command:route':
          _handleCommandRoute(ws, msg, deviceId);
          break;
        case 'device:list':
          _handleDeviceList(ws, msg, deviceId);
          break;
        default:
          ws.send(JSON.stringify({ type: 'error', error: `Unknown message type: ${msg.type}` }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', error: err.message }));
    }
  });

  ws.on('close', () => {
    if (deviceId) {
      _unregisterClient(deviceId);
      _hub?.unregisterDevice(deviceId);
      _broadcastPresence();
      _schedulePersistence();
    }
  });

  ws.on('error', () => {
    if (deviceId) {
      _unregisterClient(deviceId);
      _hub?.unregisterDevice(deviceId);
    }
  });

  // Send initial hello
  ws.send(JSON.stringify({
    type: 'hello',
    server: 'khy-os-cross-platform-sync',
    protocol: 1,
    timestamp: Date.now(),
  }));
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Attach the cross-platform sync WebSocket server to an existing HTTP server.
 * @param {http.Server} httpServer - The HTTP server instance
 * @param {object} options
 * @param {object} options.hub - CrossPlatformHub instance
 * @param {function} [options.authenticate] - Auth function (token, apiKey, opts) => { ok, user }
 * @param {string} [options.path] - WebSocket path (default: /ws/cross-platform)
 */
function attach(httpServer, options = {}) {
  if (_wss) return; // Already attached

  _hub = options.hub || null;
  _authenticate = options.authenticate || null;

  // Load persisted state from disk
  const persisted = _loadFromDisk();
  if (persisted && _hub) {
    // Restore sessions (devices will re-register on connect)
    for (const s of persisted.sessions || []) {
      _hub.registerSession(s.sessionId, s.state);
      const session = _hub.getSession(s.sessionId);
      if (session) {
        session.version = s.version || 1;
        session.lastModified = s.lastModified || Date.now();
        session.modifiedBy = s.modifiedBy || 'restored';
      }
    }
  }

  // noServer + own listener, scoped to exactly this path. The app-level
  // socket in server.js shares this HTTP server and handles every OTHER
  // path; a { server, path } WebSocketServer here would also intercept
  // (and abort) upgrades another listener already handled on the same
  // socket — two handleUpgrade() calls on one socket kill the process.
  // Unit tests pass a bare mock without .on — fall back to the legacy
  // { server, path } form there (the mocked ws module never attaches).
  const wsPath = options.path || '/ws/cross-platform';
  if (typeof httpServer?.on === 'function') {
    _wss = new WebSocket.Server({ noServer: true, maxPayload: 1024 * 1024 });
    _httpServer = httpServer;
    _upgradeListener = (req, socket, head) => {
      let pathname = req.url;
      try {
        pathname = new URL(req.url, 'http://localhost').pathname;
      } catch {
        /* keep raw url for comparison below */
      }
      if (pathname !== wsPath) return;
      _wss.handleUpgrade(req, socket, head, (ws) => _wss.emit('connection', ws, req));
    };
    httpServer.on('upgrade', _upgradeListener);
  } else {
    _wss = new WebSocket.Server({
      server: httpServer,
      path: wsPath,
      maxPayload: 1024 * 1024, // 1MB
    });
  }
  _wss.on('error', (err) => {
    console.error('[syncServer] WebSocket error:', err && err.message);
  });

  _wss.on('connection', _handleConnection);

  // Periodic heartbeat / cleanup
  const heartbeat = setInterval(() => {
    if (!_wss) { clearInterval(heartbeat); return; }
    for (const ws of _wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);

  _wss.on('close', () => clearInterval(heartbeat));

  return _wss;
}

/**
 * Detach the WebSocket server.
 */
function detach() {
  if (_persistenceTimer) {
    clearTimeout(_persistenceTimer);
    _persistenceTimer = null;
  }
  _saveToDisk();

  if (typeof _httpServer?.removeListener === 'function' && _upgradeListener) {
    _httpServer.removeListener('upgrade', _upgradeListener);
  }
  _upgradeListener = null;
  _httpServer = null;

  if (_wss) {
    for (const ws of _wss.clients) {
      ws.close(1001, 'Server shutting down');
    }
    _wss.close();
    _wss = null;
  }
  _clients.clear();
}

/**
 * Get connected client count.
 */
function getClientCount() {
  return _clients.size;
}

/**
 * Get sync server status.
 */
function getStatus() {
  return {
    connected: _wss !== null,
    clients: _clients.size,
    devices: Array.from(_clients.entries()).map(([id, c]) => ({
      deviceId: id,
      platform: c.platform,
      deviceName: c.deviceName,
      userId: c.userId,
      sessions: c.sessions.size,
    })),
  };
}

/**
 * Send a notification to a specific user across all their devices.
 */
function notifyUser(userId, title, body, data = {}) {
  const message = {
    type: 'notification',
    title,
    body,
    data,
    timestamp: Date.now(),
  };
  return _broadcastToUser(userId, message);
}

/**
 * Broadcast a message to all connected clients.
 */
function broadcast(message) {
  for (const deviceId of _clients.keys()) {
    _sendToClient(deviceId, message);
  }
}

module.exports = {
  attach,
  detach,
  getClientCount,
  getStatus,
  notifyUser,
  broadcast,
};
