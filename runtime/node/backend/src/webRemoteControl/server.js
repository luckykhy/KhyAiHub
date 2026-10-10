'use strict';

/**
 * server.js — 移动端远程控制（Web Remote Control）的 HTTP + WebSocket 服务。
 *
 * 与 src/bridge/bridgeServer.js 的分工：bridge 远程控制的是**本机正在跑的 CLI REPL**，
 * 本服务控制的是桌面端窗口自己的工作区会话（任务列表、消息流、发消息、工具审批）。
 * 两者是两条独立通道，不互相代理。
 *
 * 传输只有局域网直连：ZCode 真源走的是厂商云 relay（见 [DESIGN-ARCH-092] §7.21 与
 * zcode-analysis 反解出的 WebRemoteControlDeviceTransport），本仓没有任何中继服务，
 * relay 档另案登记，不在本文件里假装存在。
 *
 * 安全默认：bind 127.0.0.1。开局域网必须显式（lanEnabled 或 KHY_REMOTE_BIND_HOST）。
 * 鉴权：一次性配对码 → 桌面端人肉确认 → token；角色 viewer 只读、operator 可发消息。
 * 工具执行权限始终由桌面端 desktopGate 判定，本服务只转达同意/拒绝。
 */

const http = require('http');
const path = require('path');
const { URL } = require('url');

const {
  STATUS,
  ROLE,
  INBOUND,
  OUTBOUND,
  ERROR_CODE,
  PAIR_CODE_TTL_MS,
  HEARTBEAT_INTERVAL_MS,
  SOCKET_IDLE_LIMIT_MS,
  parseFrame,
  scopeAllows,
  makeError,
} = require('./protocol');
const { getLanIPv4 } = require('../cli/handlers/mobile');
const { renderMobilePage } = require('./mobilePage');

const MAX_PORT_RETRIES = 3;
const HEALTH_PATH = '/r/health';
const PAGE_PATH = '/r';
const WS_PATH = '/r/ws';

function loadWs() {
  try {
    const mod = require('ws');
    return mod.WebSocketServer || mod.Server || mod;
  } catch {
    throw new Error('ws 依赖缺失：请在 runtime/node/backend 下执行 npm install');
  }
}

async function renderQrDataUrl(url) {
  let QRCode;
  try {
    QRCode = require('qrcode');
  } catch {
    return null; // 面板有「复制链接」兜底，二维码不是唯一路径
  }
  try {
    return await QRCode.toDataURL(String(url), { margin: 1, width: 280, errorCorrectionLevel: 'M' });
  } catch {
    return null;
  }
}

/**
 * @param {object} opts
 * @param {object} opts.pairing        PairingStore 实例
 * @param {object} opts.capabilities   { listWorkspaces, listTasks, loadSession,
 *                                       sendMessage, abort, respondControl, gateState }
 * @param {number} [opts.port]
 * @param {boolean} [opts.lanEnabled]
 * @param {(s:object)=>void} [opts.onStatus]
 * @param {(r:object)=>void} [opts.onPairRequest]
 * @param {object} [opts.logger]
 */
function createWebRemoteServer(opts = {}) {
  const pairing = opts.pairing;
  const caps = opts.capabilities || {};
  const logger = opts.logger || null;
  const basePort = Number(opts.port) > 0 ? Number(opts.port) : null;
  if (!pairing) throw new Error('createWebRemoteServer: pairing 必填');
  if (!basePort) throw new Error('createWebRemoteServer: port 必填（取自 serviceDefaults）');

  // env 显式给出绑定地址即视为知情开启局域网；否则 lanEnabled 开关决定。
  // isLanEnabled() 优先于静态值：调用方（桌面 main）在运行期切开关时不必重建服务。
  const envBind = String(process.env.KHY_REMOTE_BIND_HOST || '').trim();
  const lanActive = () =>
    typeof opts.isLanEnabled === 'function' ? Boolean(opts.isLanEnabled()) : Boolean(opts.lanEnabled);
  const bindHostOf = () => envBind || (lanActive() ? '0.0.0.0' : '127.0.0.1');

  let server = null;
  let wss = null;
  let port = 0;
  let status = STATUS.IDLE;
  let detail = '等待连接。';
  let code = null; // { code, expiresAt }
  let qrDataUrl = null;
  let browser = null; // 当前唯一的手机连接
  let browserAuth = null; // { deviceId, role, token }
  let seq = 0;
  let forwarded = 0;
  let theme = 'dark';
  let idleTimer = null;

  function emit(next, nextDetail) {
    status = next;
    detail = nextDetail ?? detail;
    onStatusChange();
  }

  function onStatusChange() {
    try {
      opts.onStatus?.({ status, detail, url: pairUrl(), code, qrDataUrl, port });
    } catch (err) {
      logger?.warn?.(`[web-remote] onStatus 回调异常: ${String(err)}`);
    }
  }

  function displayHost() {
    const bind = bindHostOf();
    if (bind !== '0.0.0.0') return bind === '0.0.0.0' ? '127.0.0.1' : bind;
    return getLanIPv4().best || '127.0.0.1';
  }

  function pairUrl() {
    if (!port) return null;
    const host = displayHost();
    const base = `http://${host}:${port}${PAGE_PATH}`;
    return code ? `${base}#p=${code.code}` : base;
  }

  function send(ws, payload) {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      logger?.warn?.(`[web-remote] 发送失败: ${String(err)}`);
      return false;
    }
  }

  function sendError(ws, codeName, message) {
    send(ws, makeError(codeName, message));
  }

  function dropBrowser(ws, codeName, message) {
    const target = ws || browser;
    if (target && target.readyState === 1) {
      try {
        // 必须等 send 刷完再 close：立刻 close 会把刚排队的错误帧丢掉，
        // 手机就永远不知道为什么被踢，还会拿着作废的 token 无限重连。
        target.send(JSON.stringify(makeError(codeName, message)), () => {
          try {
            target.close();
          } catch {
            /* 已关闭 */
          }
        });
      } catch {
        try {
          target.close();
        } catch {
          /* 已关闭 */
        }
      }
    }
    if (target === browser || !ws) {
      browser = null;
      browserAuth = null;
    }
  }

  async function ensureCode() {
    if (code && code.expiresAt > Date.now()) return code;
    code = pairing.issueCode();
    qrDataUrl = await renderQrDataUrl(pairUrl());
    return code;
  }

  // ── 入站消息处理 ──────────────────────────────────────────────

  async function handleBootstrap(ws, msg) {
    // 一次只允许一个手机页面（ZCode singlePageNote / sessionConflict 的兑现）。
    if (browser && browser !== ws && status === STATUS.ACTIVE) {
      return dropBrowser(ws, ERROR_CODE.CONFLICT, '这个链接已经被其他页面占用，请关闭旧页面后重新扫码。');
    }
    const presented = String(msg.pairCode || '').trim().toUpperCase();
    const token = String(msg.token || '').trim();

    if (token) {
      const v = pairing.validateToken(token);
      if (!v.valid) {
        return dropBrowser(ws, ERROR_CODE.EXPIRED, '这次 Web 远程控制会话已经结束了，需要在桌面端重新生成新的链接。');
      }
      browser = ws;
      browserAuth = { deviceId: v.device.deviceId, role: v.device.role, token };
      await replyBootstrap(ws, true);
      emit(STATUS.ACTIVE, `手机已连接 · ${v.device.name || v.device.deviceId}（${v.device.role}），已转发 ${forwarded} 条事件`);
      return;
    }

    if (!presented) {
      return dropBrowser(ws, ERROR_CODE.UNAUTHORIZED, '缺少配对码：请回到桌面端重新扫码或打开链接。');
    }
    const submitted = pairing.submitPairing(presented, msg.deviceInfo || null);
    if (!submitted.ok) {
      const expired = submitted.code === 'SESSION_EXPIRED';
      return dropBrowser(
        ws,
        expired ? ERROR_CODE.EXPIRED : ERROR_CODE.NOT_FOUND,
        expired
          ? '配对码已过期（10 分钟有效），请在桌面端刷新二维码后重新扫码。'
          : '当前 Web 远程控制链接已经失效，请回到桌面端重新开启一次。',
      );
    }
    send(ws, { type: OUTBOUND.PAIR_PENDING, pairingId: submitted.pairingId, ttlMs: PAIR_CODE_TTL_MS });
    // 记住这个 socket：桌面端点「同意」时要凭它把 bootstrap 响应发回去。
    // browserAuth 仍为 null，所以确认前它只能收到 UNAUTHORIZED。
    browser = ws;
    browserAuth = null;
    pairing.pendingRequests().forEach((r) => opts.onPairRequest?.(r));
    emit(STATUS.RUNNING, `等待桌面端确认配对 · ${submitted.deviceInfo?.name || '未知设备'}（配对码 ${submitted.pairingId}，10 分钟内有效）`);
    return undefined;
  }

  async function replyBootstrap(ws, ok, issuedToken) {
    let workspaces = [];
    let gate = null;
    try {
      workspaces = (await caps.listWorkspaces?.()) || [];
      gate = caps.gateState ? await caps.gateState() : null;
    } catch (err) {
      logger?.warn?.(`[web-remote] bootstrap 工作区枚举失败: ${String(err)}`);
    }
    send(ws, {
      type: OUTBOUND.BOOTSTRAP,
      requestId: 'bootstrap',
      ok,
      result: {
        workspaces,
        gate,
        role: browserAuth?.role || null,
        // token 只在桌面端刚签发的那一次随响应下发，手机存 sessionStorage 供重连。
        token: issuedToken || null,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        theme,
      },
    });
  }

  async function dispatch(ws, msg) {
    const type = msg.khy_type;
    if (!browserAuth) {
      return sendError(ws, ERROR_CODE.UNAUTHORIZED, '尚未完成配对：请在桌面端点「同意」后重试。');
    }
    if (!scopeAllows(browserAuth.role, type)) {
      return sendError(
        ws,
        ERROR_CODE.FORBIDDEN,
        `当前是 ${browserAuth.role} 角色，不支持 ${type}。需要发消息请在桌面端设备列表把角色改为 operator。`,
      );
    }
    const rid = msg.requestId;
    try {
      switch (type) {
        case INBOUND.HEARTBEAT:
          return send(ws, { type: OUTBOUND.HEARTBEAT, client_ts: msg.client_ts ?? Date.now() });
        case INBOUND.WORKSPACE_LIST:
          return send(ws, { type: OUTBOUND.WORKSPACE_LIST, requestId: rid, ok: true, result: await caps.listWorkspaces() });
        case INBOUND.TASK_LIST:
          return send(ws, { type: OUTBOUND.TASK_LIST, requestId: rid, ok: true, result: await caps.listTasks({ workspacePath: msg.workspacePath }) });
        case INBOUND.SESSION_MESSAGES:
          return send(ws, { type: OUTBOUND.SESSION_MESSAGES, requestId: rid, ok: true, result: await caps.loadSession({ sessionId: msg.sessionId }) });
        case INBOUND.SESSION_SEND: {
          const text = String(msg.text || '').trim();
          if (!text) return sendError(ws, ERROR_CODE.UNSUPPORTED_ACTION, '消息内容为空：请说点什么再发送。');
          send(ws, { type: OUTBOUND.SESSION_SEND, requestId: rid, ok: true, result: { accepted: true } });
          const p = caps.sendMessage({ sessionId: msg.sessionId, text });
          Promise.resolve(p).catch((err) => {
            sendError(ws, ERROR_CODE.HOST_UNAVAILABLE, `模型无输出：${String(err && err.message ? err.message : err).slice(0, 200)}，可在桌面端运行 khy gateway status 检查通道`);
          });
          return undefined;
        }
        case INBOUND.SESSION_ABORT:
          await caps.abort?.();
          return send(ws, { type: OUTBOUND.SESSION_SEND, requestId: rid, ok: true, result: { aborted: true } });
        case INBOUND.CONTROL_RESPONSE:
          await caps.respondControl?.({ requestId: msg.requestId, response: msg.response });
          return undefined;
        default:
          return sendError(ws, ERROR_CODE.UNSUPPORTED_ACTION, `不支持的动作：${type}`);
      }
    } catch (err) {
      logger?.warn?.(`[web-remote] ${type} 处理失败: ${String(err)}`);
      return sendError(ws, ERROR_CODE.HOST_UNAVAILABLE, `桌面端处理 ${type} 失败：${String(err && err.message ? err.message : err).slice(0, 200)}`);
    }
  }

  // ── 生命周期 ─────────────────────────────────────────────────

  function listenOn(candidate) {
    return new Promise((resolve, rejectFn) => {
      const probe = http.createServer();
      const onError = (err) => {
        probe.removeListener('listening', ok);
        rejectFn(err);
      };
      const ok = () => probe.close(() => resolve(candidate));
      probe.once('error', onError);
      probe.listen(candidate, bindHostOf(), ok);
    });
  }

  function attachSocket(ws, req) {
    // 同源校验：手机页由本服务直出，Origin 必须等于本服务地址（原生客户端无 Origin 放行）。
    const origin = String(req.headers.origin || '').trim();
    if (origin) {
      try {
        const o = new URL(origin);
        if (o.hostname !== displayHost() && o.hostname !== 'localhost' && o.hostname !== '127.0.0.1') {
          ws.close(1008, 'cross-origin');
          return;
        }
      } catch {
        ws.close(1008, 'bad-origin');
        return;
      }
    }
    ws.__lastActivity = Date.now();
    logger?.info?.(
      `[web-remote] 手机页接入 ${req.socket.remoteAddress || '?'} origin=${req.headers.origin || '-'} ua=${String(req.headers['user-agent'] || '').slice(0, 60)}`,
    );
    ws.on('message', (raw) => {
      ws.__lastActivity = Date.now();
      const parsed = parseFrame(raw);
      if (!parsed.ok) {
        logger?.warn?.(`[web-remote] 入站帧被拒 ${req.socket.remoteAddress || '?'}: ${parsed.reason}`);
        sendError(ws, parsed.code, parsed.reason);
        return;
      }
      const m = parsed.message;
      logger?.info?.(
        `[web-remote] 收到 ${m.khy_type} · ${req.socket.remoteAddress || '?'}${m.token ? ' token=有' : ''}${m.pairCode ? ' pairCode=有' : ''}`,
      );
      if (m.khy_type === INBOUND.BOOTSTRAP) {
        theme = ['dark', 'light'].includes(m.theme) ? m.theme : theme;
        void handleBootstrap(ws, m);
        return;
      }
      void dispatch(ws, m);
    });
    ws.on('close', () => {
      if (ws === browser) {
        browser = null;
        browserAuth = null;
        if (status === STATUS.ACTIVE) {
          emit(STATUS.RUNNING, `等待手机连接 · ${pairUrl() || '本地地址'}（桌面端会话仍在运行，未中断）`);
        }
      }
    });
  }

  async function start() {
    if (server) return { port, url: pairUrl(), status };
    emit(STATUS.STARTING, `启动远程控制服务，探测端口 ${basePort}…`);
    let lastErr = null;
    for (let i = 0; i <= MAX_PORT_RETRIES; i += 1) {
      const candidate = basePort + i;
      try {
        // eslint-disable-next-line no-await-in-loop
        await listenOn(candidate);
        port = candidate;
        break;
      } catch (err) {
        lastErr = err;
        logger?.warn?.(`[web-remote] 端口 ${candidate} 被占用，顺延中（第 ${i + 1}/${MAX_PORT_RETRIES + 1} 次）`);
      }
    }
    if (!port) {
      emit(STATUS.ERROR, `远程控制启动失败：端口 ${basePort}-${basePort + MAX_PORT_RETRIES} 均被占用（${String(lastErr && lastErr.code ? lastErr.code : lastErr)}），请设置 KHY_REMOTE_PORT 后重试`);
      throw new Error(detail);
    }

    server = http.createServer((req, res) => {
      const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (u.pathname === HEALTH_PATH) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, service: 'khy-web-remote' }));
        return;
      }
      if (u.pathname === PAGE_PATH || u.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(renderMobilePage({ heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS }));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    });
    const WebSocketServer = loadWs();
    wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (u.pathname !== WS_PATH) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => attachSocket(ws, req));
    });

    await new Promise((resolve, rejectFn) => {
      server.once('error', rejectFn);
      server.listen(port, bindHostOf(), resolve);
    });

    // 空闲清扫：只按「多久没收到消息」判定，不设墙钟 kill（RUNTIME-003）。
    idleTimer = setInterval(() => {
      const now = Date.now();
      for (const client of wss?.clients || new Set()) {
        if (now - (client.__lastActivity || now) > SOCKET_IDLE_LIMIT_MS) {
          sendError(client, ERROR_CODE.EXPIRED, '手机侧 45 秒无心跳，已断开这个页面（桌面端会话仍在运行）。');
          try {
            client.terminate();
          } catch {
            /* ignore */
          }
          if (client === browser) {
            browser = null;
            browserAuth = null;
          }
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    idleTimer.unref?.();

    await ensureCode();
    emit(STATUS.RUNNING, `等待手机连接 · ${pairUrl()}（配对码 ${code.expiresAt - Date.now() > 0 ? Math.round((code.expiresAt - Date.now()) / 60000) : 0} 分钟后过期）`);
    logger?.info?.(`[web-remote] 已监听 ${bindHostOf()}:${port}`);
    return { port, url: pairUrl(), status };
  }

  async function stop() {
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
    dropBrowser(browser, ERROR_CODE.KICKED, '桌面端已关闭 Web 远程控制。');
    browser = null;
    browserAuth = null;
    if (wss) {
      for (const c of wss.clients) {
        try {
          c.terminate();
        } catch {
          /* ignore */
        }
      }
      wss.close();
      wss = null;
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    port = 0;
    code = null;
    qrDataUrl = null;
    pairing.clear();
    emit(STATUS.IDLE, '等待连接。');
    logger?.info?.('[web-remote] 已停止');
  }

  return {
    start,
    stop,
    getStatus: () => ({
      status,
      detail,
      url: pairUrl(),
      port,
      bindHost: bindHostOf(),
      lanEnabled: bindHostOf() === '0.0.0.0',
      pairCode: code ? code.code : null,
      pairCodeExpiresAt: code ? code.expiresAt : null,
      qrDataUrl,
      phoneConnected: Boolean(browser),
      role: browserAuth ? browserAuth.role : null,
      forwardedEvents: forwarded,
      devices: pairing.listDevices(),
      pending: pairing.pendingRequests(),
    }),
    /** 桌面端点了「同意」：发 token 并把当前等待中的 socket 升级为已连接。 */
    async approvePairing(pairingId, role) {
      const r = await pairing.approve(pairingId, role === ROLE.OPERATOR ? ROLE.OPERATOR : ROLE.VIEWER);
      if (!r.ok) return r;
      const target = browser;
      if (target) {
        browserAuth = { deviceId: r.device.deviceId, role: r.device.role, token: r.token };
        await replyBootstrap(target, true, r.token);
        emit(STATUS.ACTIVE, `手机已连接 · ${r.device.name}（${r.device.role}），已转发 ${forwarded} 条事件`);
      }
      return { ok: true, device: r.device };
    },
    rejectPairing: (pairingId) => pairing.reject(pairingId),
    async revokeDevice(deviceId) {
      await pairing.revoke(deviceId);
      if (browserAuth && browserAuth.deviceId === String(deviceId)) {
        dropBrowser(browser, ERROR_CODE.KICKED, '桌面端已撤销这台设备的配对。');
      }
      return { ok: true };
    },
    async refreshQr() {
      code = await pairing.rotate();
      qrDataUrl = await renderQrDataUrl(pairUrl());
      dropBrowser(browser, ERROR_CODE.KICKED, '桌面端刷新了二维码，这次链接已失效，请重新扫码。');
      emit(STATUS.RUNNING, `等待手机连接 · ${pairUrl()}（新配对码已生成，旧链接同时作废）`);
      return { url: pairUrl(), qrDataUrl, code: code.code };
    },
    /** 桌面 main 把 host 的 ai.* 事件灌进来转发给手机。 */
    broadcastStream(event) {
      if (!browser) return false;
      seq += 1;
      forwarded += 1;
      return send(browser, { type: OUTBOUND.STREAM, seq, event });
    },
    broadcastControl(request) {
      if (!browser) return false;
      return send(browser, { type: OUTBOUND.CONTROL_REQUEST, ...request });
    },
    paths: { PAGE_PATH, WS_PATH, HEALTH_PATH },
  };
}

module.exports = {
  createWebRemoteServer,
  renderQrDataUrl,
  MAX_PORT_RETRIES,
  PAGE_PATH,
  WS_PATH,
  HEALTH_PATH,
};
