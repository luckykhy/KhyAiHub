'use strict';

/**
 * gatewayClient.js — thin IO shell: the only file in this unit that opens a
 * socket. Everything above it (config / protocol / identity) is pure, so the
 * handshake is assertable without a server.
 *
 * The handshake, in order, as measured against the live gateway:
 *   1. ws connect → the server pushes connect.challenge with a fresh nonce
 *      (one per connection; reusing a nonce is not possible)
 *   2. client answers with a connect frame carrying a device signature over
 *      "v3|deviceId|clientId|clientMode|role|scopes|signedAt|token|nonce|platform|deviceFamily"
 *   3. server replies res{id:"connect-1"} — either hello-ok (with scopes) or an
 *      auth error and a 1008 close
 *
 * Contract: no method throws. Every method resolves to a result object with ok.
 */

const WebSocket = require('ws');

const protocol = require('./gatewayProtocol');
const { ensureTunnel } = require('./gatewayTunnel');

function _now() {
  return Date.now();
}

class GatewayClient {
  constructor(deps = {}) {
    this._deps = deps;
    this._ws = null;
    this._tunnel = null;
    this._identity = null;
    this._config = null;
    this._seq = 0;
    this._pending = new Map();
    this._eventHandlers = [];
    this._closed = false;
    this.hello = null;
  }

  _nextId(prefix) {
    this._seq += 1;
    return `${prefix || 'req'}-${this._seq}`;
  }

  _emitEvent(event, payload) {
    for (const handler of this._eventHandlers.slice()) {
      try {
        handler(event, payload);
      } catch {
        // a bad handler must not kill the socket
      }
    }
  }

  _failAll(error) {
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this._pending.clear();
  }

  /**
   * Full connect: tunnel → ws → challenge → signature → hello-ok.
   *
   * @returns {Promise<{ok:boolean, code?:string, message?:string, hello?:object}>}
   */
  async connect(config, identity, deps = {}) {
    const ensure = deps.ensureTunnelImpl || ensureTunnel;
    const WebSocketImpl = deps.WebSocketImpl || WebSocket;

    if (!config || !config.sshAlias) {
      return { ok: false, code: 'config_invalid', message: '网关配置不可用（缺 ssh 别名）' };
    }
    if (!identity || !identity.deviceId || !identity.privateKeyRaw) {
      return { ok: false, code: 'identity_invalid', message: '设备身份不可用' };
    }

    const tunnelResult = await ensure(config);
    if (!tunnelResult.ok) {
      return { ok: false, code: tunnelResult.code, message: tunnelResult.message };
    }
    this._tunnel = tunnelResult.tunnel;
    this._config = config;
    this._identity = identity;
    this._closed = false;

    const url = `ws://127.0.0.1:${this._tunnel.localPort}`;
    const ws = new WebSocketImpl(url, { handshakeTimeout: config.connectTimeoutMs });
    this._ws = ws;

    // Frame routing is attached before we yield to the event loop, not after
    // the open event: the gateway pushes connect.challenge the instant the
    // socket is up, and a frame that arrives before the handler exists is
    // dropped — the handshake then waits forever for a frame that already came.
    ws.on('message', (data) => this._onMessage(String(data)));
    ws.on('close', (code) => {
      this._failAll(new Error(`gateway closed (${code})`));
      this._emitEvent('gateway.closed', { code });
    });
    let openSettled = false;
    let openResolve = null;
    const opened = new Promise((resolve) => {
      openResolve = resolve;
    });
    ws.on('open', () => {
      if (!openSettled) {
        openSettled = true;
        openResolve({ ok: true });
      }
    });
    ws.on('error', (err) => {
      if (!openSettled) {
        openSettled = true;
        openResolve({ ok: false, message: err.message });
      }
      this._failAll(err);
      this._emitEvent('gateway.error', { message: err.message });
    });

    const openResult = await opened;
    if (!openResult.ok) {
      this._teardown();
      return { ok: false, code: 'ws_open_failed', message: `WS 连接失败：${openResult.message}` };
    }

    // 1) wait for the challenge. The server always speaks first.
    const challenge = await this._waitFor('connect.challenge', config.connectTimeoutMs);
    if (!challenge.ok) {
      this._teardown();
      return {
        ok: false,
        code: challenge.code || 'challenge_timeout',
        message: challenge.message || '未在时限内收到 connect.challenge',
      };
    }

    // 2) sign and answer
    const signedAt = _now();
    const signed = deps.signChallengeImpl
      ? deps.signChallengeImpl(identity, {
        clientId: config.clientId,
        clientMode: config.clientMode,
        role: config.role,
        scopes: config.scopes,
        signedAt,
        token: deps.authToken || '',
        nonce: challenge.nonce,
        platform: config.platform,
        deviceFamily: config.deviceFamily,
      })
      : null;
    if (signed && !signed.ok) {
      this._teardown();
      return { ok: false, code: 'sign_failed', message: (signed.problems[0] || {}).message || '签名失败' };
    }

    const connectFrame = protocol.buildConnectFrame({
      id: 'connect-1',
      clientId: config.clientId,
      clientVersion: config.clientVersion,
      clientMode: config.clientMode,
      platform: config.platform,
      role: config.role,
      scopes: config.scopes,
      auth: {
        token: deps.authToken || '',
        deviceToken: deps.authDeviceToken || '',
      },
      device: signed
        ? {
          id: identity.deviceId,
          publicKey: identity.publicKeyB64,
          signature: signed.signature,
          signedAt,
          nonce: challenge.nonce,
        }
        : {},
    });
    this._send(connectFrame);

    // 3) wait for hello-ok (or the auth rejection)
    const res = await this._waitForRes('connect-1', config.connectTimeoutMs);
    if (!res.ok) {
      this._teardown();
      return { ok: false, code: res.code || 'hello_timeout', message: res.message || '未在时限内收到 hello' };
    }
    if (!res.frame.ok) {
      const err = protocol.extractConnectError(res.frame);
      this._teardown();
      return {
        ok: false,
        code: err.code || 'connect_rejected',
        message: err.message || '网关拒绝了连接',
      };
    }

    const hello = protocol.parseHelloOk(res.frame.payload);
    this.hello = hello;
    if (!protocol.helloIsUsable(hello)) {
      // Connected but powerless. Say so instead of letting every later call
      // fail with "missing scope" one at a time.
      this._teardown();
      return {
        ok: false,
        code: 'no_scopes',
        message: '握手成功但未获得任何 scope——共享 token 只能连上、不能调用',
        hello,
      };
    }
    return { ok: true, hello };
  }

  _waitFor(eventName, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._challengeWaiters = this._challengeWaiters.filter((w) => w !== entry);
        resolve({ ok: false, code: 'challenge_timeout' });
      }, timeoutMs);
      const entry = {
        eventName,
        resolve: (payload) => {
          clearTimeout(timer);
          resolve({ ok: true, ...payload });
        },
      };
      this._challengeWaiters = this._challengeWaiters || [];
      this._challengeWaiters.push(entry);
    });
  }

  _waitForRes(id, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        resolve({ ok: false, code: 'response_timeout', message: `等待 ${id} 超时` });
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
    });
  }

  _onMessage(raw) {
    const frame = protocol.classifyFrame(raw);
    if (frame.kind === 'res') {
      const entry = this._pending.get(frame.id);
      if (entry) {
        clearTimeout(entry.timer);
        this._pending.delete(frame.id);
        entry.resolve({ ok: true, frame });
      }
      return;
    }
    if (frame.kind === 'event') {
      if (frame.event === 'connect.challenge' && this._challengeWaiters) {
        const waiters = this._challengeWaiters;
        this._challengeWaiters = [];
        const nonce = frame.payload && frame.payload.nonce;
        for (const w of waiters) w.resolve({ nonce });
        return;
      }
      this._emitEvent(frame.event, frame.payload);
    }
  }

  _send(frame) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return false;
    this._ws.send(JSON.stringify(frame));
    return true;
  }

  /** One RPC. Resolves with the payload or a structured error; never rejects. */
  async request(method, params = {}) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      return { ok: false, code: 'not_connected', message: '网关未连接' };
    }
    const id = this._nextId('req');
    const timeoutMs = (this._config && this._config.requestTimeoutMs) || 60000;
    const res = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        resolve({ ok: false, code: 'timeout', message: `${method} 超时（${timeoutMs}ms）` });
      }, timeoutMs);
      this._pending.set(id, { resolve, reject: resolve, timer });
      this._send(protocol.buildRequestFrame(id, method, params));
    });
    if (!res.ok) return res;
    if (!res.frame.ok) {
      const err = protocol.extractConnectError(res.frame);
      return { ok: false, code: err.code || 'request_failed', message: err.message || `${method} 失败` };
    }
    return { ok: true, payload: res.frame.payload };
  }

  onEvent(handler) {
    if (typeof handler === 'function') this._eventHandlers.push(handler);
    return () => {
      this._eventHandlers = this._eventHandlers.filter((h) => h !== handler);
    };
  }

  _teardown() {
    this._closed = true;
    this._failAll(new Error('client torn down'));
    try {
      if (this._ws) this._ws.close();
    } catch {
      // ignore
    }
    try {
      if (this._tunnel) this._tunnel.stop();
    } catch {
      // ignore
    }
    this._ws = null;
    this._tunnel = null;
  }

  close() {
    this._teardown();
    return { closed: true };
  }
}

function createGatewayClient(deps = {}) {
  return new GatewayClient(deps);
}

module.exports = { GatewayClient, createGatewayClient };
