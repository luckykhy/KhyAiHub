/**
 * oauthTokenStore.test.js — 钉死 MCP OAuth 令牌库的三后端语义、刷新缓冲方向与 PKCE 纯函数。
 *
 * 为什么这支套件必须存在：这个模块决定"访问令牌何时算过期、往哪落盘、刷新失败
 * 是放行还是拦下"。任何一条方向飘掉，要么把过期令牌当好的发出去（401 风暴），
 * 要么把 Bearer 令牌明文落错目录（泄漏）。网络路径全部用 127.0.0.1 本地 http
 * 打桩驱动，绝不打真实 OAuth 服务商；落盘路径钉到全新临时目录。
 *
 * 实测更正（与源码注释/直觉不同处，按真实行为钉死，缺陷只注册不修）：
 * 1. win32 后端不对称：backend:'keychain' 时 store() 在无 keychain 的平台上
 *    catch/else 回落写文件（oauthTokenStore.js:500-507），但 _load() 的同源
 *    分支只在 try 里赋值，平台不匹配时 json 为 undefined 且【不抛错】，直接
 *    return null（:540-558）——存进去了却永远读不出来。listServers 走
 *    _keychainList（永远列文件键，:528-531）→ getStatus 逐个 _load 得 null
 *    被 continue 吞掉 → 界面显示"无任何服务器"。缺陷注册 + 实测钉住。
 * 2. getToken 有 5 分钟提前刷新缓冲（:122 REFRESH_BUFFER_MS），getStatus 的
 *    expired 用裸到期时间（:260）→ 同一令牌可同时"已触发刷新"且"未过期"。
 * 3. 刷新失败是 fail-open：getToken catch 后原样返回旧 accessToken（:129）。
 * 4. refresh() 需要 refreshToken【且】oauthConfig，缺一律静默 return null，
 *    不抛错（:153）；有 token 无 config 的条目会永远带着缓冲期空转。
 * 5. getTokenStore 单例忽略后续 options（:665-670）——第二次传 filePath 无效。
 * 6. _fileSaveAll 用 mode 0o600，Windows 静默忽略（:480 注释自认），保存的
 *    JSON 无前导空格差异但【无尾换行】，与 atomicWriteJson 家族字节不同。
 * 7. _fileLoadAll 对坏 JSON 回落 {}（fail-open），但对合法 JSON 标量（如 42）
 *    原样返回标量：Object.keys(42)=[]、all[id]=undefined → 静默当"无令牌"。
 * 8. store(id, null) 在字段读取处抛 TypeError（async → rejected），不是校验错误。
 * 9. pollDeviceCode 的 interval 是秒且 (interval||5) —— 传 0 回落 5s；
 *    timeout 传 0 因 || 回落 900_000ms，永远测不到"0 超时"。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// ── 数据主目录隔离：必须在 require 任何会碰 getAppHome() 的模块之前钉住 ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mcpoauth-'));
const SAVED_ENV = {
  KHY_APP_HOME: process.env.KHY_APP_HOME,
  KHY_DATA_HOME: process.env.KHY_DATA_HOME,
  KHY_PROJECT_DATA_HOME: process.env.KHY_PROJECT_DATA_HOME,
};
process.env.KHY_APP_HOME = path.join(TMP, 'apphome');
process.env.KHY_DATA_HOME = path.join(TMP, 'datahome');
process.env.KHY_PROJECT_DATA_HOME = path.join(TMP, 'projhome');

const leaf = require('./oauthTokenStore');
const { McpOAuthTokenStore, getTokenStore } = leaf;

test.after(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TMP, { recursive: true, force: true });
});

// 本地 OAuth 打桩服务器：记录收到的请求体，按脚本队列应答。
async function makeStub() {
  const requests = [];
  let queue = [];
  let always = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      requests.push({ url: req.url, body: raw, headers: req.headers, count: requests.length + 1 });
      const next = queue.shift() || always || { json: { access_token: 'tok-default' } };
      res.writeHead(next.status || 200, { 'Content-Type': 'application/json' });
      res.end(typeof next.raw === 'string' ? next.raw : JSON.stringify(next.json));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    requests,
    port,
    endpoint: (p = '/token') => `http://127.0.0.1:${port}${p}`,
    respondWith(...items) { queue = items.slice(); },
    alwaysWith(item) { always = item; },
    close: () => new Promise((r) => server.close(r)),
  };
}

function freshFileStore(name) {
  return new McpOAuthTokenStore({ backend: 'file', filePath: path.join(TMP, name, 'tokens.json') });
}

// 绕开 store() 的自动刷新调度，直接铺内存条目：用于把"读取方向"与"调度副作用"分开钉。
function seed(s, serverId, entry) {
  s._memoryStore.set(serverId, {
    accessToken: entry.accessToken,
    refreshToken: entry.refreshToken || null,
    expiresAt: entry.expiresAt || null,
    tokenType: entry.tokenType || 'Bearer',
    scope: entry.scope || null,
    oauthConfig: entry.oauthConfig || null,
    storedAt: Date.now(),
  });
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

test('oauth: 导出面与构造缺省（file 后端 + getAppHome 落盘在钉住目录内）', () => {
  assert.deepStrictEqual(Object.keys(leaf).sort(), ['McpOAuthTokenStore', 'getTokenStore']);
  const dflt = new McpOAuthTokenStore();
  assert.equal(dflt._backend, 'file');
  assert.ok(dflt._filePath.startsWith(TMP), `默认落盘必须落在钉住的临时 app home：${dflt._filePath}`);
  assert.equal(path.basename(dflt._filePath), 'mcp_oauth_tokens.json');
  // options=null 走 `options || {}`，不抛
  assert.equal(new McpOAuthTokenStore(null)._backend, 'file');
});

test('oauth: memory 后端 —— 字段归一、缺省 Bearer、未知 id 全静默', async () => {
  const s = new McpOAuthTokenStore({ backend: 'memory' });
  const before = Date.now();
  await s.store('srv1', { accessToken: 'AT', scope: 'read write' });
  const entry = await s.getEntry('srv1');
  assert.equal(entry.accessToken, 'AT');
  assert.equal(entry.tokenType, 'Bearer');           // 缺省补 Bearer
  assert.equal(entry.refreshToken, null);
  assert.equal(entry.expiresAt, null);
  assert.equal(entry.oauthConfig, null);
  assert.equal(entry.scope, 'read write');
  assert.ok(entry.storedAt >= before && entry.storedAt <= Date.now() + 2, 'storedAt 应为构造时刻');
  assert.equal(await s.getToken('srv1'), 'AT');
  assert.equal(await s.getToken('nope'), null);
  assert.equal(await s.getEntry('nope'), null);
  assert.deepEqual(await s.listServers(), ['srv1']);
  assert.deepEqual((await s.getStatus())[0], {
    serverId: 'srv1', hasToken: true, hasRefreshToken: false, expired: false, expiresAt: null, tokenType: 'Bearer',
  });
  // 边界：tokenSet 缺失 → 字段读取抛 TypeError（rejected 而非校验错误）— 实测钉住
  await assert.rejects(s.store('x'), TypeError);
  await assert.rejects(s.store('x', null), TypeError);
  assert.equal(await s.getToken(undefined), null);   // Map.get(undefined) 静默
});

test('oauth: file 后端 —— 字节形态（2 空格、无尾换行）、revoke 删键、坏文件 fail-open', async () => {
  const s = freshFileStore('filebackend');
  await s.store('a', { accessToken: 'A1', tokenType: 'MAC' });
  await s.store('b', { accessToken: 'B1' });
  const bytes = fs.readFileSync(s._filePath, 'utf8');
  assert.ok(bytes.includes('\n'), '2 空格缩进的 pretty JSON，内部必有换行');
  assert.ok(!bytes.endsWith('\n'), '实测结尾无换行');
  const parsed = JSON.parse(bytes);
  assert.deepEqual(Object.keys(parsed), ['a', 'b']);
  assert.equal(parsed.a.tokenType, 'MAC');
  assert.equal(bytes, JSON.stringify(parsed, null, 2)); // 精确字节合同

  await s.revoke('a');                                  // 无 revokeEndpoint → 纯本地删
  assert.deepEqual(await s.listServers(), ['b']);
  assert.equal(await s.getToken('a'), null);

  // 坏 JSON → _fileLoadAll 回落 {} → 静默无令牌（fail-open）
  fs.writeFileSync(s._filePath, '{not json!!');
  assert.equal(await s.getToken('b'), null);
  assert.deepEqual(await s.listServers(), []);
  // 合法 JSON 标量 → Object.keys(42)=[]，all[id]=undefined → 也静默（第 7 条更正）
  fs.writeFileSync(s._filePath, '42');
  assert.equal(await s.getToken('b'), null);
  assert.deepEqual(await s.listServers(), []);
});

test('oauth: win32 keychain 后端不对称 —— store 回落写文件，_load 永远读 null（缺陷钉住）', async () => {
  assert.equal(os.platform(), 'win32', '本机平台前提；darwin/linux keychain 路径无法在盒内驱动');
  const s = new McpOAuthTokenStore({ backend: 'keychain', filePath: path.join(TMP, 'kc', 'tokens.json') });
  await s.store('kc1', { accessToken: 'SECRET', tokenType: 'Bearer' });
  // store 侧确实落到了文件（回落分支）
  const onDisk = JSON.parse(fs.readFileSync(s._filePath, 'utf8'));
  assert.equal(onDisk.kc1.accessToken, 'SECRET');
  // 读侧却不对称：_load 不抛错、json undefined → null —— 缺陷注册
  assert.equal(await s._load('kc1'), null);
  assert.equal(await s.getToken('kc1'), null);
  assert.deepEqual(await s.listServers(), ['kc1']);     // _keychainList 直接列文件键
  assert.deepEqual(await s.getStatus(), []);            // load null → continue 吞掉
  // revoke 走 _keychainDelete（win32 两分支都不进）→ 文件里的键【残留】
  await s.revoke('kc1');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(s._filePath, 'utf8'))), ['kc1']);
  assert.equal(fs.existsSync(s._filePath), true);
});

test('oauth: getToken 刷新缓冲 5 分钟 vs getStatus 裸到期（不对称钉住）+ 刷新成功链路', async () => {
  const stub = await makeStub();
  try {
    const s = new McpOAuthTokenStore({ backend: 'memory' });
    const expiresAt = Date.now() + 60_000; // 1 分钟后到期，落在 5 分钟缓冲内
    // 直接播种内存条目：绕开 store() 的 0ms 自动调度（缺陷见下一支），让缓冲方向断言可复现
    seed(s, 'r', {
      accessToken: 'OLD',
      refreshToken: 'RT',
      expiresAt,
      oauthConfig: { tokenEndpoint: stub.endpoint('/refresh'), clientId: 'cid', clientSecret: 'sec' },
    });
    stub.respondWith({ json: { access_token: 'NEW', expires_in: 3600, token_type: 'bearer' } });
    assert.equal((await s.getStatus())[0].expired, false); // getStatus 说"没过期"
    const tok = await s.getToken('r');                       // getToken 说"该刷新"
    assert.equal(tok, 'NEW');
    assert.equal(stub.requests.length, 1);
    const form = new URLSearchParams(stub.requests[0].body);
    assert.equal(form.get('grant_type'), 'refresh_token');   // 实测钉住刷新请求形状
    assert.equal(form.get('refresh_token'), 'RT');
    assert.equal(form.get('client_id'), 'cid');
    assert.equal(form.get('client_secret'), 'sec');
    assert.equal(stub.requests[0].headers['content-type'], 'application/x-www-form-urlencoded');
    const upd = await s.getEntry('r');
    assert.equal(upd.accessToken, 'NEW');
    assert.equal(upd.refreshToken, 'RT');                    // 响应无 refresh_token → 沿用旧值
    assert.equal(upd.tokenType, 'bearer');                   // 响应字段直接覆盖，缺省才沿用
    assert.ok(upd.expiresAt > expiresAt);
    s.destroy();
  } finally {
    await stub.close();
  }
});

test('oauth: 刷新失败 fail-open 返回旧令牌；refresh 缺 config/缺 refreshToken 静默 null', async () => {
  const stub = await makeStub();
  try {
    const s = new McpOAuthTokenStore({ backend: 'memory' });
    seed(s, 'f', {
      accessToken: 'OLD', refreshToken: 'RT', expiresAt: Date.now() + 60_000,
      oauthConfig: { tokenEndpoint: stub.endpoint('/bad'), clientId: 'c' },
    });
    stub.respondWith({ status: 400, json: { error: 'invalid_grant', error_description: '令牌吊销' } });
    assert.equal(await s.getToken('f'), 'OLD');              // 第 3 条：吞掉错误放行旧令牌
    assert.equal((await s.getEntry('f')).accessToken, 'OLD'); // 旧条目未被污染
    // refresh 前置不足 → 静默 null（第 4 条）
    assert.equal(await s.refresh('ghost'), null);
    await s.store('nc', { accessToken: 'X', refreshToken: 'RT' }); // 无 oauthConfig
    assert.equal(await s.refresh('nc'), null);
    await s.store('nr', { accessToken: 'Y', oauthConfig: { tokenEndpoint: stub.endpoint() } }); // 无 refreshToken
    assert.equal(await s.refresh('nr'), null);
    s.destroy();
  } finally {
    await stub.close();
  }
});

test('oauth: _httpPost 方向 —— error 字段用 error_description 作消息；非法 JSON 报 Invalid response；网络失败 reject', async () => {
  const stub = await makeStub();
  try {
    const s = new McpOAuthTokenStore({ backend: 'memory' });
    seed(s, 'e', {
      accessToken: 'OLD', refreshToken: 'RT', expiresAt: Date.now() + 60_000,
      oauthConfig: { tokenEndpoint: stub.endpoint('/e'), clientId: 'c' },
    });
    stub.respondWith({ raw: '{"error":"server_error","error_description":"上游炸了"}' });
    await assert.rejects(s.refresh('e'), /上游炸了/);          // error_description 优先
    stub.respondWith({ raw: 'not-json-at-all' });
    await assert.rejects(s.refresh('e'), /Invalid response/);
    stub.respondWith({ json: {} });                            // 200 但无 access_token
    await assert.rejects(s.refresh('e'), /No access_token in refresh response/);
    s.destroy();
  } finally {
    await stub.close();
  }
  // 端口关闭后 → req error → reject
  const s2 = new McpOAuthTokenStore({ backend: 'memory' });
  await s2.store('n', { accessToken: 'OLD', refreshToken: 'RT', expiresAt: Date.now() + 60_000, oauthConfig: { tokenEndpoint: 'http://127.0.0.1:1/x', clientId: 'c' } });
  await assert.rejects(s2.refresh('n'), /ECONNREFUSED|Invalid URL|failed/i);
  s2.destroy();
});

test('oauth: startAuthCodeFlow —— 纯函数：S256 挑战可复算、state 随机、scope 可选', () => {
  const s = new McpOAuthTokenStore({ backend: 'memory' });
  const cfg = {
    authorizationEndpoint: 'https://idp.example/auth',
    tokenEndpoint: 'https://idp.example/token',
    clientId: 'cid-1',
    redirectUri: 'http://127.0.0.1:1/callback',
  };
  const a = s.startAuthCodeFlow('x', cfg);
  const b = s.startAuthCodeFlow('x', cfg);
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.codeVerifier, b.codeVerifier);
  assert.match(a.state, /^[0-9a-f]{32}$/);
  assert.equal(a.codeVerifier.length, 43);                      // 32 字节 base64url
  const expected = crypto.createHash('sha256').update(a.codeVerifier).digest('base64url');
  const u = new URL(a.authUrl);
  assert.equal(u.searchParams.get('code_challenge'), expected); // PKCE 服务端可验证
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), 'cid-1');
  assert.equal(u.searchParams.get('redirect_uri'), cfg.redirectUri);
  assert.equal(u.searchParams.get('state'), a.state);
  assert.equal(u.searchParams.get('scope'), null);              // 无 scope 不塞空键
  assert.ok(u.origin + u.pathname === 'https://idp.example/auth');
  const scoped = s.startAuthCodeFlow('x', { ...cfg, scope: 'a b' });
  assert.equal(new URL(scoped.authUrl).searchParams.get('scope'), 'a b');
});

test('oauth: completeAuthCodeFlow —— 请求体形状、落盘、oauthConfig 持久化与 scope 回落', async () => {
  const stub = await makeStub();
  try {
    const s = freshFileStore('authcode');
    const cfg = {
      tokenEndpoint: stub.endpoint('/tok'),
      clientId: 'cid',
      clientSecret: 'sec',
      redirectUri: 'http://cb',
      scope: 'fallback-scope',
      revokeEndpoint: stub.endpoint('/revoke'),
    };
    stub.respondWith({ json: { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600, token_type: 'Mac', scope: 'real' } });
    const ts = await s.completeAuthCodeFlow('p1', cfg, 'the-code', 'the-verifier');
    assert.equal(ts.accessToken, 'AT1');
    assert.equal(ts.refreshToken, 'RT1');
    assert.equal(ts.tokenType, 'Mac');
    assert.equal(ts.scope, 'real');                             // 响应 scope 优先
    assert.ok(Math.abs(ts.expiresAt - (Date.now() + 3600_000)) < 5_000); // 大 TTL：避免 0ms 刷新定时器搅局
    const body = new URLSearchParams(stub.requests[0].body);
    assert.equal(stub.requests.length, 1);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'the-code');
    assert.equal(body.get('code_verifier'), 'the-verifier');
    assert.equal(body.get('client_secret'), 'sec');
    // 落盘验证（文件后端真实写入）
    const disk = JSON.parse(fs.readFileSync(s._filePath, 'utf8'));
    assert.equal(disk.p1.accessToken, 'AT1');
    assert.deepEqual(disk.p1.oauthConfig, { tokenEndpoint: cfg.tokenEndpoint, clientId: 'cid', clientSecret: 'sec', revokeEndpoint: cfg.revokeEndpoint });
    // 无 expires_in → expiresAt null；无 scope → 回落 config.scope
    stub.respondWith({ json: { access_token: 'AT2' } });
    const ts2 = await s.completeAuthCodeFlow('p2', cfg, 'c2', 'v2');
    assert.equal(ts2.expiresAt, null);
    assert.equal(ts2.scope, 'fallback-scope');
    assert.equal(ts2.refreshToken, null);
    assert.equal(ts2.tokenType, 'Bearer');
    s.destroy();
  } finally {
    await stub.close();
  }
});

test('oauth: startDeviceCodeFlow + pollDeviceCode（毫秒级 interval）—— pending/slow_down 续Poll、硬错误上抛、超时抛错', async () => {
  const stub = await makeStub();
  try {
    const s = new McpOAuthTokenStore({ backend: 'memory' });
    stub.respondWith({ json: { user_code: 'ABCD-1234', verification_url: 'https://idp/verify', expires_in: 60 } });
    const d = await s.startDeviceCodeFlow('dv', { deviceAuthorizationEndpoint: stub.endpoint('/dev'), tokenEndpoint: stub.endpoint('/tok'), clientId: 'cid', scope: 'sc' });
    assert.equal(stub.requests.length, 1);
    assert.equal(new URLSearchParams(stub.requests[0].body).get('scope'), 'sc');
    assert.deepEqual(d, { userCode: 'ABCD-1234', verificationUri: 'https://idp/verify', deviceCode: undefined, interval: 5, expiresIn: 60 }); // verification_uri 回落 url；interval 缺省 5

    // 1) pending → slow_down → 成功；2) interval 传 0.001 秒（≈1ms）避免套件拖 5s
    stub.respondWith(
      { json: { error: 'authorization_pending' } },
      { json: { error: 'slow_down' } },
      { json: { access_token: 'DEV-AT', expires_in: 10 } }
    );
    const got = await s.pollDeviceCode('dv', { tokenEndpoint: stub.endpoint('/tok'), clientId: 'cid' }, 'DC', 0.001, 5000);
    assert.equal(got.accessToken, 'DEV-AT');
    assert.equal(stub.requests.length, 4);                      // 1 dev + 3 poll
    assert.equal(fs.existsSync(s._filePath), false);            // memory 后端绝不落盘
    assert.ok(s._filePath.startsWith(TMP));                     // 且默认落点仍在钉住的临时根内
    assert.equal((await s.getEntry('dv')).accessToken, 'DEV-AT');
    // 硬错误直接上抛
    stub.respondWith({ status: 400, json: { error: 'expired_token' } });
    await assert.rejects(s.pollDeviceCode('dv', { tokenEndpoint: stub.endpoint('/tok'), clientId: 'c' }, 'DC', 0.001, 5000), /expired_token/);
    // 永远 pending + 极短 timeout → 超时抛错（timeout=0 会被 || 吞成 900_000 — 第 9 条）
    stub.respondWith({ json: { error: 'authorization_pending' } }, { json: { error: 'authorization_pending' } });
    await assert.rejects(s.pollDeviceCode('dv', { tokenEndpoint: stub.endpoint('/tok'), clientId: 'c' }, 'DC', 0.001, 1), /Device code flow timed out/);
    s.destroy();
  } finally {
    await stub.close();
  }
});

test('oauth: 调度器与 destroy —— 仅 expiresAt+refreshToken 才挂 timer，unref，destroy 清空', async () => {
  const s = new McpOAuthTokenStore({ backend: 'memory' });
  await s.store('no-timer', { accessToken: 'A', expiresAt: Date.now() + 3_600_000 }); // 无 refreshToken
  assert.equal(s._refreshTimers.size, 0);
  await s.store('t1', { accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 3_600_000, oauthConfig: { tokenEndpoint: 'http://127.0.0.1:1/x' } });
  assert.equal(s._refreshTimers.size, 1);
  await s.store('t2', { accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 7_200_000 });
  assert.equal(s._refreshTimers.size, 2);
  await s.revoke('t1');                                        // revoke 清对应 timer
  assert.equal(s._refreshTimers.size, 1);
  s.destroy();
  assert.equal(s._refreshTimers.size, 0);
  assert.equal(s._memoryStore.has('t2'), true);                // destroy 不动数据
});

test('oauth: getTokenStore 单例 —— 首次 options 定终身，后续被忽略', async () => {
  const a = getTokenStore({ backend: 'memory' });
  const b = getTokenStore({ backend: 'file', filePath: path.join(TMP, 'singleton', 'x.json') });
  assert.equal(a, b);                                          // 第 5 条：后者被静默忽略
  assert.equal(b._backend, 'memory');
  await a.store('sg', { accessToken: 'V' });
  assert.equal(await b.getToken('sg'), 'V');                   // 同一实例共享内存
  assert.equal(fs.existsSync(path.join(TMP, 'singleton')), false); // 文件路径从未启用
  a.destroy();
});
