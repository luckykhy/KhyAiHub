'use strict';

/**
 * 跨设备同步 WebSocket 的认证与对象级授权（SEC-01）。
 *
 * 此前：无 token 或 token 校验失败都放行，身份取客户端消息里自填的 userId，
 * 并且消息分发没有任何鉴权闸门 —— 未认证的连接能读会话全量 state、改写他人
 * 会话、把 command 广播给某平台上的**所有**连接（含别人的设备）。
 *
 * 现在：认证强制（失败即 close 1008），身份只认已验证 token 里的用户，
 * 会话有属主，命令/消息只投给同一用户的设备。
 *
 * 用真实 http.Server + 真实 ws 客户端跑（只连 127.0.0.1，无外网）。
 */

const http = require('http');
const WebSocket = require('ws');

const syncServer = require('../src/services/crossPlatform/ws/syncServer');
const { CrossPlatformHub } = require('../src/services/crossPlatform/crossPlatformHub');

const AUTH_TIMEOUT_MS = 5000;

describe('跨设备同步 WS：认证强制 + 对象级授权（SEC-01）', () => {
  let server;
  let port;
  let hub;
  const openSockets = [];

  const authenticate = async (token) => {
    if (token === 'tok-A') return { ok: true, user: { id: 'A' } };
    if (token === 'tok-B') return { ok: true, user: { id: 'B' } };
    return { ok: false };
  };

  beforeAll(async () => {
    hub = new CrossPlatformHub();
    server = http.createServer();
    syncServer.attach(server, { hub, authenticate });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    // 收干净所有客户端连接，别给 jest 留悬挂句柄
    for (const ws of openSockets) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    openSockets.length = 0;
    try {
      syncServer.detach();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => server.close(resolve));
  });

  /** 连上并收集消息；resolve 于 open。 */
  function connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/cross-platform`);
      ws.inbox = [];
      ws.closed = null;
      openSockets.push(ws);
      ws.on('message', (data) => {
        try {
          ws.inbox.push(JSON.parse(data.toString()));
        } catch {
          /* ignore non-JSON */
        }
      });
      ws.on('close', (code, reason) => {
        ws.closed = { code, reason: String(reason || '') };
      });
      ws.on('open', () => resolve(ws));
      ws.on('error', () => {
        /* close 事件会带出结果 */
      });
      setTimeout(() => reject(new Error('连接超时')), AUTH_TIMEOUT_MS);
    });
  }

  /** 等某条消息出现；超时则 reject。 */
  function waitFor(ws, predicate, timeoutMs = AUTH_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const found = ws.inbox.find(predicate);
      if (found) return resolve(found);
      const timer = setInterval(() => {
        const hit = ws.inbox.find(predicate);
        if (hit) {
          clearInterval(timer);
          resolve(hit);
        }
      }, 20);
      setTimeout(() => {
        clearInterval(timer);
        reject(new Error('等待消息超时'));
      }, timeoutMs);
    });
  }

  function waitForClose(ws, timeoutMs = AUTH_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (ws.closed) {
          clearInterval(timer);
          resolve(ws.closed);
        }
      }, 20);
      setTimeout(() => {
        clearInterval(timer);
        reject(new Error('等待关闭超时'));
      }, timeoutMs);
    });
  }

  async function authedClient(token, deviceId, platform) {
    const ws = await connect();
    ws.send(
      JSON.stringify({
        type: 'auth',
        token,
        deviceId,
        platform,
        deviceName: deviceId,
        capabilities: {},
      })
    );
    await waitFor(ws, (m) => m.type === 'auth:ok' || m.type === 'auth:error');
    return ws;
  }

  it('不带 token 的连接被关闭，且拿不到 auth:ok', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'auth', deviceId: 'dev-x', platform: 'web' }));
    const closed = await waitForClose(ws);
    expect(closed.code).toBe(1008);
    expect(ws.inbox.find((m) => m.type === 'auth:ok')).toBeUndefined();
  });

  it('token 校验失败被关闭；身份不得取自消息里的自填 userId', async () => {
    const ws = await connect();
    ws.send(
      JSON.stringify({
        type: 'auth',
        token: 'bogus',
        userId: 'user:forged',
        deviceId: 'dev-y',
        platform: 'web',
      })
    );
    const closed = await waitForClose(ws);
    expect(closed.code).toBe(1008);
    expect(ws.inbox.find((m) => m.type === 'auth:ok')).toBeUndefined();
  });

  it('合法 token 认证成功，身份取自 token 里的用户', async () => {
    const ws = await connect();
    ws.send(
      JSON.stringify({
        type: 'auth',
        token: 'tok-A',
        userId: 'user:forged',
        deviceId: 'dev-A1',
        platform: 'web',
      })
    );
    const ok = await waitFor(ws, (m) => m.type === 'auth:ok');
    expect(ok.userId).toBe('A'); // 身份取自 token 里的原始 user id（与 REST 侧同格式），不是自填值
  });

  it('未认证的连接发任何业务消息都被断开', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'auth', deviceId: 'dev-z', platform: 'web' }));
    await waitForClose(ws);
    ws.send(JSON.stringify({ type: 'session:join', sessionId: 's-1' }));
    await new Promise((r) => setTimeout(r, 200));
    // 连接已关闭，后续业务消息不可能被处理：hub 里不该出现这个会话
    expect(hub.getSession('s-1')).toBeNull();
  });

  it('B 用户不能加入 A 用户的会话，也拿不到它的 state', async () => {
    const a = await authedClient('tok-A', 'dev-A2', 'web');
    const b = await authedClient('tok-B', 'dev-B1', 'web');

    // A 先建会话并写入状态
    a.send(JSON.stringify({ type: 'session:join', sessionId: 's-owned' }));
    await waitFor(a, (m) => m.type === 'session:updated');
    a.send(JSON.stringify({ type: 'session:update', sessionId: 's-owned', delta: { secretNote: 'A-private' } }));
    await new Promise((r) => setTimeout(r, 150));

    // B 试图加入同一会话
    b.send(JSON.stringify({ type: 'session:join', sessionId: 's-owned' }));
    const err = await waitFor(b, (m) => m.type === 'session:error');
    expect(err.error).toMatch(/无权/);
    // B 没拿到 state
    const leaked = b.inbox.find((m) => m.type === 'session:updated' && m.state && m.state.secretNote);
    expect(leaked).toBeUndefined();

    a.close();
    b.close();
  });

  it('B 用户不能改写 A 用户的会话', async () => {
    const a = await authedClient('tok-A', 'dev-A3', 'web');
    const b = await authedClient('tok-B', 'dev-B2', 'web');

    a.send(JSON.stringify({ type: 'session:join', sessionId: 's-owned-2' }));
    await waitFor(a, (m) => m.type === 'session:updated');
    a.send(JSON.stringify({ type: 'session:update', sessionId: 's-owned-2', delta: { secretNote: 'A-private-2' } }));
    await new Promise((r) => setTimeout(r, 150));

    b.send(JSON.stringify({ type: 'session:update', sessionId: 's-owned-2', delta: { secretNote: 'TAMPERED' } }));
    const err = await waitFor(b, (m) => m.type === 'session:error');
    expect(err.error).toMatch(/无权/);

    const session = hub.getSession('s-owned-2');
    expect(session.state.secretNote).toBe('A-private-2'); // 没被改掉

    a.close();
    b.close();
  });

  it('命令只投给同一用户的设备，不投给同平台的他人设备', async () => {
    const a = await authedClient('tok-A', 'dev-A4', 'desktop');
    const b = await authedClient('tok-B', 'dev-B3', 'desktop');

    b.send(
      JSON.stringify({
        type: 'command:route',
        targetPlatform: 'desktop',
        command: 'exec',
        payload: { cmd: 'whoami' },
      })
    );
    await new Promise((r) => setTimeout(r, 300));

    const got = a.inbox.find((m) => m.type === 'command');
    expect(got).toBeUndefined(); // A 是另一个用户，不该收到 B 的命令

    a.close();
    b.close();
  });
});
