/**
 * mcpHttpServer.test.js — 钉死 HTTP/SSE 传输的绑定闸门、令牌方向、Origin 判定与会话宽严切换。
 *
 * 为什么这支套件必须存在：这台 server 暴露全量工具（含 shell/文件写），安全
 * 默认是它唯一的边界：非 loopback 无 token 拒启、401 带 WWW-Authenticate、
 * Origin 校验排在鉴权之前、会话宽严切换点是 `sessionSeq > 0`。这些方向全部
 * 可以离线纯函数测 + 127.0.0.1 环回真 socket 驱动（绝不外网）。
 *
 * 实测更正（与源码注释/上游直觉不同处，按真实语义钉死）：
 * 1. isLoopbackHost('127.abc') === true —— 只查 `127.` 前缀不做八位组校验，
 *    恶意 host 头可命中"loopback 免 token"闸 — 偏差注册（实测钉住）。
 * 2. isLoopbackHost('')/null → true：空 host 当 loopback。
 * 3. port 传 0 被 `Number(opts.port) || DEFAULT_PORT` 吞成 3737 —— 0 端口（OS 任选）不可能。
 * 4. startHttpServer 不转发 opts.registry：注入假 registry 无效，横幅数字来自真注册表 — 偏差注册。
 * 5. 'Bearer ' 前缀大小写敏感（'bearer x' 拒）；'Bearer  x  ' 双空格 trim 后放行。
 * 6. isAuthorized 对 queryToken 字段一律无视（OWASP 迁移后的遗留形参）。
 * 7. 会话校验：只要本进程签发过会话（sessionSeq>0），未知/已删 id 的 POST 一律 404
 *    SESSION_NOT_FOUND；未签发前一切放行（curl 探活兼容）— 宽严切换点实测钉住。
 * 8. 模块加载即在 process 上注册 SIGTERM 监听（跨套件状态泄漏）——本测用加载前后
 *    listenerCount 差量实测钉住。
 * 9. Streamable HTTP 的 SSE 回包路径：body 是 `id:/event: message/data:` SSE 形，
 *    但 Content-Type 头被 Object.assign 的后者（application/json）覆盖 —— 头体不一致，
 *    客户端按头解析会当场炸 — 高价值偏差注册（实测钉住，mcpHttpServer.js:435-441）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PassThrough } = require('node:stream');

// SIGTERM 监听泄漏钉死：require 前后差量
const beforeRequire = process.listenerCount('SIGTERM');
const leaf = require('./mcpHttpServer');
const afterRequire = process.listenerCount('SIGTERM');

const {
  DEFAULT_HOST, DEFAULT_PORT, ALLOWED_ORIGINS_ENV, RESOURCE_METADATA_ENV, DEFAULT_RESOURCE_METADATA,
  isLoopbackHost, canStartOnHost, isAuthorized, timingSafeEqualStr, parseAllowedOrigins, isAllowedOrigin, startHttpServer,
} = leaf;

async function waitUp(server) { return new Promise((resolve) => { server.once('listening', () => resolve('up')); server.once('error', (e) => resolve('err:' + (e && e.code))); }); }
const PORT = 45873;
const BASE = `http://127.0.0.1:${PORT}`;

function req(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(`${BASE}${path}`, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

test('httpServer: 导出面', () => {
  assert.deepStrictEqual(Object.keys(leaf).sort(), [
    'ALLOWED_ORIGINS_ENV', 'DEFAULT_HOST', 'DEFAULT_PORT', 'DEFAULT_RESOURCE_METADATA',
    'RESOURCE_METADATA_ENV', 'canStartOnHost', 'isAllowedOrigin', 'isAuthorized',
    'isLoopbackHost', 'parseAllowedOrigins', 'startHttpServer', 'timingSafeEqualStr',
  ]);
  assert.equal(DEFAULT_HOST, '127.0.0.1');
  assert.equal(DEFAULT_PORT, 3737);
  assert.equal(ALLOWED_ORIGINS_ENV, 'KHY_MCP_ALLOWED_ORIGINS');
  assert.equal(RESOURCE_METADATA_ENV, 'KHY_MCP_RESOURCE_METADATA');
  assert.equal(DEFAULT_RESOURCE_METADATA, '/.well-known/oauth-protected-resource');
});

test('httpServer: 模块加载注册 SIGTERM 监听（跨套件状态泄漏实测钉住）', () => {
  assert.equal(afterRequire - beforeRequire, 1);
});

test('httpServer: isLoopbackHost —— 127. 前缀不做八位组校验（偏差注册）', () => {
  for (const lo of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '0:0:0:0:0:0:0:1', '', null, undefined, ' 127.0.0.1 ']) {
    assert.equal(isLoopbackHost(lo), true, String(lo));
  }
  assert.equal(isLoopbackHost('127.abc'), true);   // 畸形但前缀命中 — 实测钉住
  assert.equal(isLoopbackHost('127.999.999'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('192.168.1.1'), false);
  assert.equal(isLoopbackHost('localhost.evil.test'), false);
});

test('httpServer: canStartOnHost —— 非 loopback 无 token 拒启，reason 中文完整', () => {
  assert.deepEqual(canStartOnHost('127.0.0.1'), { ok: true });
  assert.deepEqual(canStartOnHost('0.0.0.0', 'tok'), { ok: true });
  const bad = canStartOnHost('0.0.0.0', '');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /拒绝在非 loopback 地址 0\.0\.0\.0 上无 token 启动/);
  assert.equal(canStartOnHost('10.0.0.5', '  ').ok, true); // '  ' 长度>0 → 放行 — 弱 token 实测钉住
});

test('httpServer: isAuthorized/timingSafeEqualStr —— header-only、大小写敏感', () => {
  assert.equal(isAuthorized(null, ''), true);          // 无 token 配置一律放行
  assert.equal(isAuthorized({}, undefined), true);
  assert.equal(isAuthorized({ authorization: 'Bearer s3cret' }, 's3cret'), true);
  assert.equal(isAuthorized({ authorization: 'Bearer  s3cret  ' }, 's3cret'), true); // trim 宽容
  assert.equal(isAuthorized({ authorization: 'bearer s3cret' }, 's3cret'), false);   // 大小写敏感
  assert.equal(isAuthorized({ authorization: 'Bearer wrong' }, 's3cret'), false);
  assert.equal(isAuthorized({ authorization: 'Bearer ' }, 's3cret'), false);
  assert.equal(isAuthorized({ queryToken: 's3cret' }, 's3cret'), false);             // 查询串无视
  assert.equal(isAuthorized(null, 's3cret'), false);
  assert.equal(timingSafeEqualStr('a', 'a'), true);
  assert.equal(timingSafeEqualStr('a', 'bb'), false); // 长度不等先 false（长度信息仍泄露？不：等长才比对）
  assert.equal(timingSafeEqualStr(NaN, 'NaN'), true);
  assert.equal(timingSafeEqualStr(undefined, null), false); // 'undefined' vs 'null' 长度不等 → false
});

test('httpServer: parseAllowedOrigins/isAllowedOrigin —— null/file:// 默认拒', () => {
  assert.deepEqual(parseAllowedOrigins({ [ALLOWED_ORIGINS_ENV]: ' HTTP://A.Test ,b' }), ['http://a.test', 'b']);
  assert.deepEqual(parseAllowedOrigins({}), []);
  assert.deepEqual(parseAllowedOrigins(null), []);
  assert.equal(isAllowedOrigin(undefined, {}), true);
  assert.equal(isAllowedOrigin('', {}), true);
  assert.equal(isAllowedOrigin('null', {}), false);
  assert.equal(isAllowedOrigin('file://', {}), false);
  assert.equal(isAllowedOrigin('http://localhost:3000', {}), true);
  assert.equal(isAllowedOrigin('http://[::1]:3000', {}), true);   // IPv6 括号剥离
  assert.equal(isAllowedOrigin('https://evil.test', {}), false);
  assert.equal(isAllowedOrigin('ftp://127.0.0.1', {}), false);     // 非 http(s) scheme
  assert.equal(isAllowedOrigin('garbage', {}), false);
  assert.equal(isAllowedOrigin('http://evil.test', { [ALLOWED_ORIGINS_ENV]: 'http://evil.test' }), true); // 白名单放行
});

test('httpServer: 非 loopback 无 token 启动 → ok:false 且横幅进 errOutput（不启 socket）', () => {
  const err = new PassThrough();
  const buf = [];
  err.on('data', (c) => buf.push(String(c)));
  const r = startHttpServer({ host: '0.0.0.0', env: {}, errOutput: err });
  assert.equal(r.ok, false);
  assert.match(r.reason, /绝不裸奔上网/);
  assert.equal(buf.length, 1);
  assert.match(buf[0], /^khy MCP server \(http\): 拒绝/);
});

test('httpServer: port:0 被吞成 DEFAULT_PORT=3737（0 端口不可能 — 实测钉住）', async () => {
  const err = new PassThrough();
  const buf = [];
  err.on('data', (c) => buf.push(String(c)));
  const h = startHttpServer({ port: 0, env: {}, errOutput: err, version: 'p0' });
  assert.equal(h.ok, true);
  const outcome = await new Promise((resolve) => {
    h.server.once('listening', () => resolve('up'));
    h.server.once('error', (e) => resolve(`err:${e && e.code}`));
  });
  assert.equal(outcome, 'up', `3737 端口不可用(${outcome})——本钉住测依赖端口空闲，属环境前提`);
  assert.equal(h.server.address().port, DEFAULT_PORT); // listen 成功后地址即 3737 — 偏差钉住
  assert.ok(buf.join('').includes('绑定 127.0.0.1:3737'));
  await new Promise((res) => h.server.close(res));
});

test('httpServer: 环回真链路 —— 401/403/initialize 签会话/旧 id 404/SSE 回包/DELETE/探活', async (t) => {
  const err = new PassThrough();
  const h = startHttpServer({ port: PORT, token: 'tok123', env: {}, version: 'http-test' });
  assert.equal(h.ok, true);
  // 真注册表暴露非零工具（startHttpServer 不转发 opts.registry — 偏差实测）
  assert.ok(h.core.exposedTools().length > 0);
  assert.equal(await waitUp(h.server), 'up');
  t.after(async () => { await new Promise((res) => h.server.close(res)); });

  const JH = { 'content-type': 'application/json' };
  // 无令牌 → 401 + WWW-Authenticate(RFC 9728 resource_metadata 默认路径)
  const un = await req('POST', '/mcp', { headers: JH, body: '{}' });
  assert.equal(un.status, 401);
  assert.match(un.headers['www-authenticate'], /Bearer realm="khy-mcp", resource_metadata="\/.well-known\/oauth-protected-resource"/);
  // 坏 Origin（即便带对 token）→ 403，校验排在鉴权前
  const forb = await req('POST', '/mcp', { headers: { ...JH, origin: 'https://evil.test', authorization: 'Bearer tok123' }, body: '{}' });
  assert.equal(forb.status, 403);
  // 正确 initialize → 200 + 签发 Mcp-Session-Id
  const ini = await req('POST', '/mcp', {
    headers: { ...JH, authorization: 'Bearer tok123' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } }),
  });
  assert.equal(ini.status, 200);
  const sid = ini.headers['mcp-session-id'];
  assert.match(String(sid), /^khy-\d+$/);
  assert.equal(JSON.parse(ini.text).result.protocolVersion, '2024-11-05');
  // 已签发会话后，乱 id → 404 SESSION_NOT_FOUND（宽严切换点实测）
  const ghost = await req('POST', '/mcp', { headers: { ...JH, authorization: 'Bearer tok123', 'mcp-session-id': 'khy-99999' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) });
  assert.equal(ghost.status, 404);
  assert.equal(JSON.parse(ghost.text).code, 'SESSION_NOT_FOUND');
  // 好 id ping → 200
  const ping = await req('POST', '/mcp', { headers: { ...JH, authorization: 'Bearer tok123', 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }) });
  assert.equal(ping.status, 200);
  assert.deepEqual(JSON.parse(ping.text), { jsonrpc: '2.0', id: 3, result: {} });
  // Accept: text/event-stream → 回包体是 SSE 形（带事件 id），但 Content-Type 头却被
  // Object.assign(base, headers) 里的 headers {'Content-Type':'application/json'} 反向覆盖 ——
  // "SSE 体 + JSON 头"双重违反规范 2025-03-26 §Streamable HTTP — 高价值偏差注册（实测钉住）。
  const sse = await req('POST', '/mcp', { headers: { ...JH, authorization: 'Bearer tok123', 'mcp-session-id': sid, accept: 'text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'ping' }) });
  assert.equal(sse.status, 200);
  assert.equal(sse.headers['content-type'], 'application/json'); // 缺陷钉住：应为 text/event-stream
  assert.match(sse.text, /^id: 1\nevent: message\ndata: .*\n\n$/); // 体却是 SSE 形 — 头体不一致钉死
  // 通知 → 202 空体
  const notif = await req('POST', '/mcp', { headers: { ...JH, authorization: 'Bearer tok123', 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled' }) });
  assert.equal(notif.status, 202);
  assert.equal(notif.text, '');
  // 坏 MCP-Protocol-Version 头 → 400 + supported 列表
  const ver = await req('POST', '/mcp', { headers: { ...JH, authorization: 'Bearer tok123', 'mcp-session-id': sid, 'mcp-protocol-version': '2099-01-01' }, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' }) });
  assert.equal(ver.status, 400);
  assert.deepEqual(JSON.parse(ver.text).supported, ['2024-11-05', '2025-03-26']);
  // DELETE 会话 → 204；随后旧 sid 再 POST → 404（删了不能白名单回来 — 实测钉住）
  const del = await req('DELETE', '/mcp', { headers: { authorization: 'Bearer tok123', 'mcp-session-id': sid } });
  assert.equal(del.status, 204);
  const afterDel = await req('POST', '/mcp', { headers: { ...JH, authorization: 'Bearer tok123', 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'ping' }) });
  assert.equal(afterDel.status, 404);
  // 未知路由 404 not found
  const nf = await req('GET', '/whatever', { headers: { authorization: 'Bearer tok123' } });
  assert.equal(nf.status, 404);
  assert.equal(JSON.parse(nf.text).error, 'not found');
  // 401 resource_metadata 可经 env 覆盖（零硬编码纪律）
  const h2 = startHttpServer({ port: PORT + 1, token: 'a', env: { [RESOURCE_METADATA_ENV]: 'https://meta.example/.well-known/oauth-protected-resource' } });
  assert.equal(await waitUp(h2.server), 'up');
  try {
    const un2 = await new Promise((resolve, reject) => {
      const r = http.request(`http://127.0.0.1:${PORT + 1}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, (res2) => {
        const cs = []; res2.on('data', (c) => cs.push(c)); res2.on('end', () => resolve({ headers: res2.headers, text: Buffer.concat(cs).toString() }));
      });
      r.on('error', reject); r.end();
    });
    assert.match(un2.headers['www-authenticate'], /resource_metadata="https:\/\/meta\.example\/.well-known\/oauth-protected-resource"/);
  } finally {
    await new Promise((res) => h2.server.close(res));
  }
});

test('httpServer: 传统 SSE —— GET /sse 开流先发 endpoint 事件；POST /messages 经流回推 + 202', async (t) => {
  const h = startHttpServer({ port: PORT + 2, env: {} });
  assert.equal(await waitUp(h.server), 'up');
  t.after(async () => { await new Promise((res) => h.server.close(res)); });
  const gotEndpoint = new Promise((resolve) => {
    const r = http.get(`http://127.0.0.1:${PORT + 2}/sse`, (res) => {
      assert.equal(res.headers['content-type'], 'text/event-stream');
      res.once('data', (c) => {
        const text = String(c);
        const m = text.match(/event: endpoint\ndata: (\/messages\?sessionId=[^\n]+)/);
        assert.ok(m, `endpoint 事件缺失: ${text}`);
        resolve({ res, r, postPath: m[1] });
      });
    });
    r.on('error', (e) => t.diagnostic(String(e)));
  });
  const { res, postPath } = await gotEndpoint;
  const post = await new Promise((resolve, reject) => {
    const pr = http.request(`http://127.0.0.1:${PORT + 2}${postPath}`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (r2) => {
      const cs = []; r2.on('data', (c) => cs.push(c)); r2.on('end', () => resolve({ status: r2.statusCode, text: Buffer.concat(cs).toString() }));
    });
    pr.on('error', reject);
    pr.end(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }));
  });
  assert.equal(post.status, 202);
  assert.deepEqual(JSON.parse(post.text), { ok: true });
  const messageEvent = await new Promise((resolve) => {
    res.once('data', (c) => resolve(String(c)));
  });
  assert.match(messageEvent, /event: message\ndata: .*"id":7.*\n\n/);
  res.destroy();
});
