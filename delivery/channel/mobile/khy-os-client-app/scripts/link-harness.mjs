// khy-canary: Khy-1.1.28+13-202611142308-0F62DE87
/**
 * link-harness — 出向链路的**测试对端**，不是产品代码。
 *
 * 它只做一件事：按 khy-os 侧 `services/crossPlatform/ws/syncServer.js` 已定义的
 * 协议说话（auth → auth:ok，ping → pong，command 下发），好让"设备出向连出去"
 * 这件事能在真机上被 adb 之外的证据判定（T1/T2/T3）。
 *
 * 为什么不在测试里另发明一套协议：发明一套就只能证明"设备会连我自己写的服务"，
 * 证明不了"设备能连现有服务端"。所以这里逐字照抄 syncServer 的消息类型。
 *
 * 用法：
 *   node scripts/link-harness.mjs --port 8787
 *   curl "http://127.0.0.1:8787/push?cmd=%7B%22tool%22%3A%22ping%22%7D"   # 下发一条指令
 *   curl "http://127.0.0.1:8787/state"                                    # 看连接/鉴权/心跳计数
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// 仓库根由本文件位置派生：本脚本在 delivery/mobile/khy-os-client-app/scripts/ 下，
// 根在上四级。不写死机器路径（RUNTIME-001）。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
let WebSocketServer;
try {
  // 复用仓库已有的 ws（后端同款），不新增依赖
  ({ WebSocketServer } = require(path.join(REPO_ROOT, 'node_modules', 'ws')));
} catch (e) {
  console.error('需要 khy-os 仓库里的 ws 模块:', e.message);
  process.exit(2);
}

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = portArg >= 0 ? parseInt(args[portArg + 1], 10) : 8787;

// 断点二身份单轨：设备签名帧的验签复用 backend 既有实现（harness 不另发明
// 协议），登记表与 deviceLinkWss 共用同一份落盘。懒加载：没有这份文件时
// 设备签名分支按 device_not_enrolled 拒——那是对的正确行为。
let _sigRegistry = null;
function sigRegistry() {
  if (!_sigRegistry) {
    const { DeviceKeyRegistry } = require(
      path.join(REPO_ROOT, 'runtime/node/backend/src/services/crossPlatform/ws/deviceSignatureAuth.js'),
    );
    _sigRegistry = new DeviceKeyRegistry({
      // env 可指到临时登记表（PC 侧自测用）；缺省与 deviceLinkWss 同一份落盘。
      stateFile: process.env.KHY_DEVICE_LINK_REGISTRY
        || path.join(REPO_ROOT, 'works/data/khy/mobile-link/device-keys.json'),
    });
  }
  return _sigRegistry;
}

const state = {
  connections: 0,
  auths: 0,
  authFailures: 0,
  pings: 0,
  pongs: 0,
  commands: 0,
  lastAuth: null,
  connectedClients: 0,
  events: [],
};

function note(kind, detail) {
  const line = { ts: Date.now(), kind, detail };
  state.events.push(line);
  if (state.events.length > 200) state.events.shift();
  console.log(JSON.stringify(line));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...state, events: state.events.slice(-20) }));
    return;
  }
  if (url.pathname === '/push') {
    const cmd = url.searchParams.get('cmd') || '';
    const sessionId = url.searchParams.get('sessionId') || '';
    // msg_id 透传：设备侧对带 msg_id 的帧做至少一次+去重（T15/T12 判据依赖）。
    // 不带 msg_id 的旧用法保持原样（帧里就没有这个字段）。
    const msgId = url.searchParams.get('msg_id') || '';
    let sent = 0;
    for (const ws of wss.clients) {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify(msgId
          ? { type: 'command', command: cmd, payload: cmd, sessionId, msg_id: msgId }
          : { type: 'command', command: cmd, payload: cmd, sessionId }));
        sent++;
      }
    }
    state.commands += sent;
    note('push', { sent, cmd, msgId });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sent }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  state.connections++;
  state.connectedClients = wss.clients.size;
  note('connection', { from: req.socket.remoteAddress });

  ws.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString('utf8'));
    } catch {
      note('bad-json', { raw: buf.toString('utf8').slice(0, 80) });
      return;
    }
    switch (msg.type) {
      case 'auth': {
        // 设备签名分支先于 token 分支：设备一旦带 publicKey/sig 就走验签，
        // 不回落 token（回落等于给「拿旧 token 冒充设备」留后门，与 syncServer
        // 的闸门语义一致）。验签失败回 auth:error 并照旧不关连接——设备侧把
        // auth:error 当鉴权失败上报（link_auth），这是判定要看的行为。
        if (msg.publicKey || msg.sig) {
          let verdict;
          try {
            verdict = sigRegistry().verifyAuthFrame({
              deviceId: msg.deviceId,
              publicKey: msg.publicKey,
              ts: msg.ts,
              sig: msg.sig,
            });
          } catch (e) {
            verdict = { ok: false, code: 'registry_unavailable' };
          }
          if (!verdict.ok) {
            state.authFailures++;
            ws.send(JSON.stringify({
              type: 'auth:error',
              error: '设备签名校验失败',
              code: verdict.code,
              deviceId: msg.deviceId || '',
            }));
            note('auth-fail', { code: verdict.code, deviceId: msg.deviceId || '' });
            return;
          }
          state.auths++;
          state.lastAuth = {
            deviceId: verdict.deviceId,
            platform: verdict.platform,
            deviceName: verdict.deviceName,
            userId: verdict.userId,
            via: 'device-signature',
          };
          ws.send(JSON.stringify({
            type: 'auth:ok',
            deviceId: verdict.deviceId,
            userId: verdict.userId,
            platforms: { android: 1 },
            via: 'device-signature',
          }));
          note('auth', state.lastAuth);
          return;
        }
        // 只校验"有没有带 token"，不校验值：取值校验在 PC 侧 policy 里，
        // harness 复制一份就成了第二个真源。
        if (!msg.token) {
          state.authFailures++;
          ws.send(JSON.stringify({ type: 'auth:error', error: 'missing token' }));
          return;
        }
        state.auths++;
        state.lastAuth = { deviceId: msg.deviceId, platform: msg.platform, deviceName: msg.deviceName };
        ws.send(JSON.stringify({ type: 'auth:ok', deviceId: msg.deviceId, platforms: ['android'] }));
        note('auth', state.lastAuth);
        return;
      }
      case 'ping':
        state.pings++;
        state.pongs++;
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        return;
      case 'session:join':
        ws.send(JSON.stringify({ type: 'session:joined', sessionId: msg.sessionId, participants: [] }));
        return;
      default:
        note('other', { type: msg.type });
    }
  });

  ws.on('close', () => {
    state.connectedClients = wss.clients.size;
    note('close', { left: state.connectedClients });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ listening: PORT, pid: process.pid }));
});
