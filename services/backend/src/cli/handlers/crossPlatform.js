'use strict';

/**
 * crossPlatform.js — `khy cross` CLI: 四端跨设备同步 + 跨端启动.
 *
 * 子命令:
 *   khy cross status                     查看跨设备同步状态
 *   khy cross connect                    连接跨设备同步服务器
 *   khy cross disconnect                 断开连接
 *   khy cross devices                    列出已连接设备
 *   khy cross sessions                   列出活跃会话
 *   khy cross join <sessionId>           加入会话
 *   khy cross leave <sessionId>          离开会话
 *   khy cross send <deviceId> <message>  发送消息到指定设备
 *   khy cross notify <userId> <title>    发送通知到指定用户
 *   khy cross route <platform> <command> 路由命令到指定平台
 *   khy cross start <platform>          启动另一个平台
 *   khy cross start all                 启动所有平台
 *   khy cross stop <platform>           停止另一个平台
 *
 * @param {string} subCommand
 * @param {string[]} args
 * @param {object} options
 */

const { printSuccess, printError, printInfo, printTable } = require('../formatters');
const { MANIFEST_EXPORT_KEY } = require('../commandManifest');
const { AI_BACKEND_DEFAULT_URL, BACKEND_PORT, WEB_FRONTEND_PORT } = require('../../constants/serviceDefaults');

let _client = null;

function _getClient() {
  if (_client) return _client;
  const { createTerminalClient } = require('../../services/crossPlatform/clients/terminalClient');
  const backendUrl = process.env.KHY_BACKEND_URL || AI_BACKEND_DEFAULT_URL;
  const wsUrl = backendUrl.replace(/^http/, 'ws') + '/ws/cross-platform';
  _client = createTerminalClient({
    url: wsUrl,
    token: process.env.KHY_AUTH_TOKEN,
    autoReconnect: true,
  });
  // An 'error' event with no listener makes EventEmitter throw ERR_UNHANDLED_ERROR,
  // and the non-interactive fallback then exits 1 printing nothing at all. Keep one
  // listener so the failure is observable, and let callers report it themselves.
  _client._lastError = null;
  _client.on('error', (err) => { _client._lastError = err; });
  return _client;
}

async function handleCross(subCommand, args, options = {}) {
  // r204: parseInput 对未知动词置 null,旧兜底把它和裸命令一起默认成 status,
  // 于是 default 的「未知子命令」✗ 分支整体不可达(#143 同族, 病根在此),
  // `khy cross zz词` 悄悄打状态屏 rc=0。args[0] 回捞区分两者;裸 cross
  // 仍走 status(crossSubCommandRouting.test.js 钉住)。
  const _sub = subCommand
    || (Array.isArray(args) && typeof args[0] === 'string' && !args[0].startsWith('-')
      ? args[0]
      : '');
  const KNOWN_SUBS = ['status', 'connect', 'disconnect', 'devices', 'sessions',
    'join', 'leave', 'send', 'notify', 'route', 'start', 'stop'];
  // `cross help` 是合法帮助动词（portable.js 同族先例），落清单 rc=0。
  if (_sub === 'help') {
    printInfo(`可用子命令: ${KNOWN_SUBS.join(', ')}`);
    return;
  }
  if (_sub && _sub !== 'status' && !KNOWN_SUBS.includes(_sub)) {
    printError(`未知子命令: cross ${_sub}（可用: ${KNOWN_SUBS.join(', ')}）`);
    require('../../utils/markProcessFailure')();
    return;
  }
  const sub = _sub || 'status';

  switch (sub) {
    case 'status':
      return _handleStatus(options);
    case 'connect':
      return _handleConnect(options);
    case 'disconnect':
      return _handleDisconnect(options);
    case 'devices':
      return _handleDevices(options);
    case 'sessions':
      return _handleSessions(options);
    case 'join':
      return _handleJoin(args, options);
    case 'leave':
      return _handleLeave(args, options);
    case 'send':
      return _handleSend(args, options);
    case 'notify':
      return _handleNotify(args, options);
    case 'route':
      return _handleRoute(args, options);
    case 'start':
      return _handleStart(args, options);
    case 'stop':
      return _handleStop(args, options);
    default:
      printError(`未知子命令: ${sub}`);
      printInfo('可用子命令: status, connect, disconnect, devices, sessions, join, leave, send, notify, route, start, stop');
  }
}

const CONNECT_WAIT_MS = 5000;

function _syncServerHint(url) {
  return `跨设备同步服务器 (${url}) 未就绪；先运行 khy server status 确认服务是否在听`;
}

/**
 * Resolve once the sync server authenticates this device, or after
 * CONNECT_WAIT_MS carrying a ready-to-print failure sentence. `status` and
 * `connect` both need exactly this, and neither may end silently: a command
 * that failed to connect has to say so, otherwise its exit 0 reads as success.
 */
function _awaitAuth(client, url) {
  return new Promise((resolve) => {
    const settle = (outcome) => {
      client.off('authenticated', onAuth);
      client.off('auth:error', onAuthError);
      clearTimeout(timer);
      resolve(outcome);
    };
    const onAuth = () => settle({ ok: true });
    const onAuthError = (err) => settle({
      ok: false,
      msg: `认证失败：${url} 拒绝了本机的 token —— ${err}；先运行 khy cloud login 登录后重试`,
    });
    client.once('authenticated', onAuth);
    client.once('auth:error', onAuthError);
    const timer = setTimeout(() => {
      // The socket reports failures through 'error', which _getClient keeps a
      // listener for; without a reply here the server never answered at all.
      const reason = (client._lastError
        ? (client._lastError.message || String(client._lastError))
        : `${CONNECT_WAIT_MS / 1000}s 内未收到任何应答`).replace(/[.。;；,，\s]+$/, '');
      settle({ ok: false, msg: `连接失败：${reason}。${_syncServerHint(url)}` });
    }, CONNECT_WAIT_MS);
  });
}

function _handleStatus(options) {
  const client = _getClient();
  const state = client.state;
  const deviceId = client.deviceId;

  printInfo(`设备ID: ${deviceId || '未分配（连上服务器后由服务端下发）'}`);
  printInfo(`连接状态: ${state}`);

  // Try to connect if not connected
  if (state === 'disconnected' || state === 'error') {
    const url = AI_BACKEND_DEFAULT_URL;
    printInfo(`连接跨设备同步服务器 (${url})，等待应答 (最多 ${CONNECT_WAIT_MS / 1000}s)...`);
    client.connect();
    return _awaitAuth(client, url).then((r) => {
      if (r.ok) printSuccess(`已连接 ${url}`);
      else { printError(r.msg); require('../../utils/markProcessFailure')(); }
    });
  }

  if (state === 'connected') {
    printSuccess('已连接');
    client.once('device:list', (devices) => {
      if (devices && devices.length > 0) {
        printInfo(`\n已连接设备 (${devices.length}):`);
        const rows = devices.map(d => [d.deviceId, d.platform, d.deviceName || '-']);
        printTable(['设备ID', '平台', '名称'], rows);
      } else {
        printInfo('暂无其他设备连接');
      }
    });
    client.listDevices();
    return new Promise(resolve => setTimeout(resolve, 2000));
  }
}

function _handleConnect(options) {
  const client = _getClient();
  const url = AI_BACKEND_DEFAULT_URL;
  if (client.state === 'connected') {
    printSuccess(`已连接 ${url}，无需重连`);
    return;
  }
  printInfo(`连接跨设备同步服务器 (${url})，等待应答 (最多 ${CONNECT_WAIT_MS / 1000}s)...`);
  client.connect();
  return _awaitAuth(client, url).then((r) => {
    if (r.ok) printSuccess(`连接成功：${url}`);
    else { printError(r.msg); require('../../utils/markProcessFailure')(); }
  });
}

function _handleDisconnect(options) {
  const client = _getClient();
  client.disconnect();
  printSuccess('已断开连接');
}

function _handleDevices(options) {
  const client = _getClient();
  if (client.state !== 'connected') {
    printError('未连接。请先运行: khy cross connect');
    require('../../utils/markProcessFailure')();
    return;
  }
  client.listDevices();
  return new Promise((resolve) => {
    client.once('device:list', (devices) => {
      if (!devices || devices.length === 0) {
        printInfo('暂无设备');
      } else {
        printInfo(`设备列表 (${devices.length}):`);
        const rows = devices.map(d => [d.deviceId, d.platform, d.deviceName || '-']);
        printTable(['设备ID', '平台', '名称'], rows);
      }
      resolve();
    });
    setTimeout(resolve, 2000);
  });
}

function _handleSessions(options) {
  const { hub } = require('../../services/crossPlatform/crossPlatformHub');
  const status = hub.getStatus();
  printInfo(`活跃会话数: ${status.totalSessions}`);
  if (hub._sessions && hub._sessions.size > 0) {
    const rows = [];
    for (const [id, s] of hub._sessions) {
      rows.push([id, s.version, new Date(s.lastModified).toLocaleTimeString()]);
    }
    printTable(['会话ID', '版本', '最后修改'], rows);
  }
}

function _handleJoin(args, options) {
  const sessionId = args[0];
  if (!sessionId) {
    printError('用法: khy cross join <sessionId>');
    require('../../utils/markProcessFailure')();
    return;
  }
  const client = _getClient();
  if (client.state !== 'connected') {
    printError('未连接。请先运行: khy cross connect');
    require('../../utils/markProcessFailure')();
    return;
  }
  client.joinSession(sessionId);
  printSuccess(`已加入会话: ${sessionId}`);
}

function _handleLeave(args, options) {
  const sessionId = args[0];
  if (!sessionId) {
    printError('用法: khy cross leave <sessionId>');
    require('../../utils/markProcessFailure')();
    return;
  }
  const client = _getClient();
  client.leaveSession(sessionId);
  printSuccess(`已离开会话: ${sessionId}`);
}

function _handleSend(args, options) {
  const targetDeviceId = args[0];
  const message = args.slice(1).join(' ');
  if (!targetDeviceId || !message) {
    printError('用法: khy cross send <deviceId> <message>');
    require('../../utils/markProcessFailure')();
    return;
  }
  const client = _getClient();
  if (client.state !== 'connected') {
    printError('未连接。请先运行: khy cross connect');
    require('../../utils/markProcessFailure')();
    return;
  }
  client.sendMessage({ targetDeviceId, payload: { text: message } });
  printSuccess(`消息已发送到 ${targetDeviceId}`);
}

function _handleNotify(args, options) {
  const userId = args[0];
  const title = args[1];
  const body = args.slice(2).join(' ');
  if (!userId || !title) {
    printError('用法: khy cross notify <userId> <title> [body]');
    require('../../utils/markProcessFailure')();
    return;
  }
  const syncServer = require('../../services/crossPlatform/ws/syncServer');
  syncServer.notifyUser(userId, title, body);
  printSuccess(`通知已发送到用户 ${userId}`);
}

function _handleRoute(args, options) {
  const targetPlatform = args[0];
  const command = args[1];
  if (!targetPlatform || !command) {
    printError('用法: khy cross route <platform> <command>');
    require('../../utils/markProcessFailure')();
    return;
  }
  const client = _getClient();
  if (client.state !== 'connected') {
    printError('未连接。请先运行: khy cross connect');
    require('../../utils/markProcessFailure')();
    return;
  }
  client.routeCommand(targetPlatform, command, {});
  printSuccess(`命令已路由到 ${targetPlatform}`);
}

function _handleStart(args, options) {
  const { startPlatform, startMultiple } = require('../../services/crossPlatform/crossLauncher');
  const target = args[0];
  
  if (!target) {
    printError('用法: khy cross start <platform|all>');
    require('../../utils/markProcessFailure')();
    printInfo('可用平台: backend, cli, web, desktop, mobile, all');
    return;
  }

  if (target === 'all') {
    printInfo('正在启动所有平台...');
    return startMultiple(['backend', 'web', 'desktop']).then(results => {
      results.forEach(r => {
        if (r.success) {
          printSuccess(`${r.platform} 已启动 (PID: ${r.pid})`);
        } else {
          printError(`${r.platform} 启动失败: ${r.error}`);
        }
      });
    });
  }

  printInfo(`正在启动 ${target}...`);
  return startPlatform(target).then(result => {
    if (result.success) {
      printSuccess(`${target} 已启动 (PID: ${result.pid})`);
    } else {
      printError(`${target} 启动失败: ${result.error}`);
    }
  });
}

function _handleStop(args, options) {
  const target = args[0];
  if (!target) {
    printError('用法: khy cross stop <platform>');
    require('../../utils/markProcessFailure')();
    return;
  }

  // Use taskkill to stop by port or process name
  const { execSync } = require('child_process');
  const portMap = { backend: BACKEND_PORT, web: WEB_FRONTEND_PORT };
  const port = portMap[target];

  if (!port) {
    if (target === 'mobile') {
      // The mobile client is a native Flutter process, not a port-bound
      // dev server, so there is nothing to kill by port.
      printError(
        'mobile 是原生 Flutter 进程，不按端口停止：请直接在模拟器/真机上关闭 App，'
        + '或在开发时按 Ctrl+C 中断 `flutter run`'
      );
      require('../../utils/markProcessFailure')();
    } else {
      printError(`未知平台: ${target}`);
      require('../../utils/markProcessFailure')();
    }
    return;
  }

  try {
    const output = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf-8' });
    const lines = output.split('\n').filter(l => l.includes('LISTENING'));
    if (lines.length === 0) {
      printInfo(`${target} (端口 ${port}) 未在运行`);
      return;
    }
    const pid = lines[0].trim().split(/\s+/).pop();
    execSync(`taskkill /PID ${pid} /F`);
    printSuccess(`${target} (PID: ${pid}) 已停止`);
  } catch (err) {
    printError(`停止失败: ${err.message}`);
  }
}

module.exports = {
  handleCross,
  [MANIFEST_EXPORT_KEY]: {
    name: 'cross-platform',
    aliases: ['cross', 'sync-devices'],
    description: '跨设备同步 + 跨端启动（四端：CLI/TUI/移动端/桌面端）',
    usage: 'cross-platform <status|connect|disconnect|devices|...>',
    subCommands: [
      'status', 'connect', 'disconnect', 'devices', 'sessions',
      'join', 'leave', 'send', 'notify', 'route', 'start', 'stop',
    ],
    category: 'system',
    handler: async (parsed) => handleCross(parsed.subCommand, parsed.args, parsed.options),
  },
};
