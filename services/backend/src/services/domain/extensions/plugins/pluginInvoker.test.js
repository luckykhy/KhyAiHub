'use strict';

/**
 * pluginInvoker.test.js — 钉死插件 OpenAPI 操作 → 一次 HTTP 调用的构建/鉴权/SSRF 语义。
 *
 * @khy/shared/plugins/openapiTools 用真件（vendored 纯函数，findOperation 的形状是本层
 * 输入契约的一部分，stub 掉就测不到「只经由这两个出口」）。urlSafety 必须 stub：
 * assertPublicHttpUrlResolved 会做 DNS 解析，测试不许依赖网络栈；stub 同时把
 * 「API URL 与 OAuth token URL 都过闸」钉成可断言的调用记录。nativeHttp 也 stub：
 * 注入 _http 后真传输层一行都不该被碰。
 *
 * 实测钉死的怪异行为（非理想行为）：
 *   · GET/HEAD 带 body 参数被静默丢弃（hasBody 判据排除 GET/HEAD），headers 里也
 *     不会加 Content-Type。
 *   · 非 2xx 不抛——回 {ok:false,status}；只有构造期错误（无 server URL / 缺必填
 *     path 参数 / 鉴权配置非法）才抛带 statusCode 的 Error。
 *   · authorization_code 且无过期信息时（expiresAt 缺省），旧 accessToken 原样续用。
 *   · client_credentials 的 expires_in 用注入时钟换算；缺 expires_in → expiresAt=null
 *     → _expired 恒 false → 缓存永久有效（对短命 token 是隐患，如实钉死不修）。
 *   · cookie 参数刻意不支持：出现在 args 里也不会进任何一处。
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const US_PATH = require.resolve('../../../urlSafety');
const NH_PATH = require.resolve('../../../../utils/nativeHttp');
const SAVED = [
  [US_PATH, require.cache[US_PATH]],
  [NH_PATH, require.cache[NH_PATH]],
];

const guardCalls = [];
let guardReject = null;
require.cache[US_PATH] = {
  id: US_PATH,
  filename: US_PATH,
  loaded: true,
  exports: {
    assertPublicHttpUrlResolved: async (urlObj, label) => {
      guardCalls.push({ href: urlObj.href, label });
      if (guardReject) throw guardReject;
    },
  },
};
require.cache[NH_PATH] = {
  id: NH_PATH,
  filename: NH_PATH,
  loaded: true,
  exports: {
    request: () => Promise.reject(new Error('native transport must not run with _http injected')),
  },
};

const P = require('./pluginInvoker');

after(() => {
  for (const [p, v] of SAVED) {
    if (v) require.cache[p] = v;
    else delete require.cache[p];
  }
});

const DOC = {
  openapi: '3.0.0',
  servers: [{ url: 'https://api.example.com/v1/' }],
  paths: {
    '/pets/{petId}': {
      get: {
        operationId: 'getPet',
        parameters: [
          { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'tags', in: 'query', schema: { type: 'array' } },
          { name: 'x-tenant', in: 'header', schema: { type: 'string' } },
          { name: 'sid', in: 'cookie', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/pets': {
      post: {
        operationId: 'createPet',
        parameters: [],
        responses: { '200': { description: 'ok' } },
      },
    },
  },
};

function httpReturning(result) {
  const seen = [];
  const http = async (config) => {
    seen.push(config);
    return typeof result === 'function' ? result(config, seen.length) : result;
  };
  return { http, seen };
}

// ── _baseUrl ───────────────────────────────────────────────────────────

test('_baseUrl：servers 首个绝对 URL、尾斜杠剥掉；manifest.api.base_url 仅兜底', () => {
  assert.equal(P._baseUrl(DOC), 'https://api.example.com/v1');
  assert.equal(
    P._baseUrl({ servers: [{ url: '/relative' }, { url: 'https://ok.example.com/x/' }] }),
    'https://ok.example.com/x'
  );
  assert.equal(
    P._baseUrl({ servers: [] }, { api: { base_url: 'https://coze.example/api/' } }),
    'https://coze.example/api'
  );
  assert.throws(() => P._baseUrl({}), /no absolute server URL/);
});

// ── _bindRequest ──────────────────────────────────────────────────────

test('_bindRequest：path 参数 encodeURIComponent、query/header 各归各位、cookie 丢弃', () => {
  const b = P._bindRequest(DOC, 'getPet', {
    petId: 'a b/c',
    tags: ['x', 'y'],
    'x-tenant': 't1',
    sid: 'leak-me',
  });
  assert.equal(b.method, 'GET');
  assert.equal(b.pathTemplate, '/pets/a%20b%2Fc');
  assert.deepEqual(b.query, { tags: ['x', 'y'] });
  assert.deepEqual(b.headers, { 'x-tenant': 't1' });
  assert.equal(b.body, undefined);
  assert.ok(!JSON.stringify(b).includes('leak-me'), 'cookie 参数不得出现在任何绑定面');
});

test('_bindRequest：缺必填 path 参数抛 400；未知 operationId 抛 404；args 非对象按空处理', () => {
  assert.throws(() => P._bindRequest(DOC, 'getPet', {}), (err) => err.statusCode === 400);
  assert.throws(() => P._bindRequest(DOC, 'nope', {}), (err) => err.statusCode === 404);
  const b = P._bindRequest(DOC, 'createPet', 'not-an-object');
  assert.deepEqual(b, { method: 'POST', pathTemplate: '/pets', query: {}, headers: {}, body: undefined });
});

// ── invoke 主链路 ─────────────────────────────────────────────────────

test('invoke 参数强制：无 openapi / 无 operationId → 400（statusCode 挂在 Error 上）', async () => {
  await assert.rejects(() => P.invoke({ operationId: 'x' }), (e) => e.statusCode === 400);
  await assert.rejects(() => P.invoke({ openapi: DOC }), (e) => e.statusCode === 400);
});

test('GET 主链路：URL 拼装完整、不带 Content-Type 也不带 data、SSRF 闸收最终 URL', async () => {
  guardCalls.length = 0;
  const { http, seen } = httpReturning({ status: 200, headers: { 'content-type': 'text/plain' }, data: 'hello' });
  const res = await P.invoke({
    openapi: DOC,
    operationId: 'getPet',
    args: { petId: 42, tags: ['a', 'b'], sid: 'ck' },
    _http: http,
  });
  assert.equal(seen.length, 1);
  const cfg = seen[0];
  assert.equal(cfg.method, 'GET');
  assert.equal(cfg.url, 'https://api.example.com/v1/pets/42?tags=a&tags=b');
  assert.equal(cfg.data, undefined);
  assert.ok(!('Content-Type' in cfg.headers));
  assert.ok(!JSON.stringify(cfg).includes('ck'));
  assert.deepEqual(
    guardCalls.map((g) => g.label),
    ['Plugin request URL']
  );
  assert.deepEqual(
    { ok: res.ok, status: res.status, data: res.data, contentType: res.contentType },
    { ok: true, status: 200, data: 'hello', contentType: 'text/plain' }
  );
});

test('字符串 JSON 响应仅在 content-type 含 json 时解析，解析失败保留原文', async () => {
  const mk = (contentType, data) =>
    P.invoke({
      openapi: DOC,
      operationId: 'getPet',
      args: { petId: 1 },
      _http: httpReturning({ status: 200, headers: { 'content-type': contentType }, data }).http,
    });
  const parsed = await mk('application/json; charset=utf-8', '{"a":1}');
  assert.deepEqual(parsed.data, { a: 1 });
  const raw = await mk('application/json', '{not json');
  assert.equal(raw.data, '{not json'); // _tryJson 失败 → 保留字符串（不吞成 null）
});

test('POST 主链路：body 原样透传并补 Content-Type: application/json', async () => {
  const { http, seen } = httpReturning({ status: 201, headers: {}, data: { id: 9 } });
  const res = await P.invoke({
    openapi: DOC,
    operationId: 'createPet',
    args: { body: { name: 'mochi' } },
    _http: http,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'POST');
  assert.deepEqual(seen[0].data, { name: 'mochi' });
  assert.equal(seen[0].headers['Content-Type'], 'application/json');
  assert.equal(res.ok, true);
  assert.equal(res.status, 201);
});

test('4xx/5xx 不抛，回 ok:false 并保留 status/data（agent 自行反应）', async () => {
  const res = await P.invoke({
    openapi: DOC,
    operationId: 'getPet',
    args: { petId: 1 },
    _http: httpReturning({ status: 503, headers: { 'content-type': 'text/plain' }, data: 'down' }).http,
  });
  assert.equal(res.ok, false);
  assert.equal(res.status, 503);
  assert.equal(res.data, 'down');
});

test('SSRF 闸抛错时 invoke 直接拒绝，且请求根本没发出去', async () => {
  guardReject = new Error('blocked');
  try {
    const { http, seen } = httpReturning({ status: 200, headers: {}, data: 1 });
    await assert.rejects(
      () => P.invoke({ openapi: DOC, operationId: 'getPet', args: { petId: 1 }, _http: http }),
      /blocked/
    );
    assert.equal(seen.length, 0);
  } finally {
    guardReject = null;
  }
});

// ── 鉴权 ──────────────────────────────────────────────────────────────

test('apiKey：默认头名 Authorization（可改名），in=query 时并入最终 URL；缺 value 抛 400', async () => {
  const { http, seen } = httpReturning({ status: 200, headers: {}, data: {} });
  await P.invoke({
    openapi: DOC,
    operationId: 'getPet',
    args: { petId: 1 },
    authConfig: { type: 'apiKey', name: 'X-Key', value: 'k1' },
    _http: http,
  });
  assert.equal(seen[0].headers['X-Key'], 'k1');
  const h2 = httpReturning({ status: 200, headers: {}, data: {} });
  await P.invoke({
    openapi: DOC,
    operationId: 'getPet',
    args: { petId: 1 },
    authConfig: { type: 'apiKey', in: 'query', value: 'k2' },
    _http: h2.http,
  });
  // 未指定 name 时 in=query 用的也是默认名 Authorization（怪异点如实钉死）
  assert.ok(h2.seen[0].url.includes('Authorization=k2'), h2.seen[0].url);
  await assert.rejects(
    () =>
      P.invoke({
        openapi: DOC,
        operationId: 'getPet',
        args: { petId: 1 },
        authConfig: { type: 'apiKey' },
        _http: h2.http,
      }),
    (e) => e.statusCode === 400
  );
});

test('bearer 头拼装与缺 token 抛 400；未知鉴权类型抛 400', async () => {
  const { http, seen } = httpReturning({ status: 200, headers: {}, data: {} });
  await P.invoke({
    openapi: DOC,
    operationId: 'getPet',
    args: { petId: 1 },
    authConfig: { type: 'bearer', token: 't0k' },
    _http: http,
  });
  assert.equal(seen[0].headers.Authorization, 'Bearer t0k');
  await assert.rejects(() =>
    P.invoke({ openapi: DOC, operationId: 'getPet', args: { petId: 1 }, authConfig: { type: 'bearer' }, _http: http })
  , /missing "token"/);
  await assert.rejects(() =>
    P.invoke({ openapi: DOC, operationId: 'getPet', args: { petId: 1 }, authConfig: { type: 'digest' }, _http: http })
  , /Unsupported auth type/);
});

test('oauth client_credentials：首呼取 token 并入缓存，复呼零 token 请求', async () => {
  const cache = new Map();
  const calls = [];
  const http = async (config) => {
    calls.push(config);
    if (config.url === 'https://auth.example.com/token') {
      return { status: 200, headers: {}, data: JSON.stringify({ access_token: 'AT', expires_in: 3600 }) };
    }
    return { status: 200, headers: {}, data: { pong: 1 } };
  };
  const opts = {
    openapi: DOC,
    operationId: 'getPet',
    args: { petId: 1 },
    authConfig: { type: 'oauth', grant: 'client_credentials', tokenUrl: 'https://auth.example.com/token', clientId: 'cid', clientSecret: 'cs', scope: 's1' },
    _http: http,
    _now: () => 1_000_000,
    _tokenCache: cache,
  };
  await P.invoke(opts);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.ok(calls[0].data.includes('grant_type=client_credentials'));
  assert.ok(calls[0].data.includes('client_id=cid') && calls[0].data.includes('scope=s1'));
  assert.equal(calls[1].headers.Authorization, 'Bearer AT');
  const entry = cache.get('https://auth.example.com/token|cid|s1');
  assert.deepEqual({ accessToken: entry.accessToken, expiresAt: entry.expiresAt }, { accessToken: 'AT', expiresAt: 1_000_000 + 3600000 });
  await P.invoke(opts);
  assert.equal(calls.length, 3, '第二次只发 API 请求，token 走缓存');
});

test('oauth authorization_code：未过期直用；过期且有 refreshToken 走 refresh_token；两者皆无抛 401', async () => {
  const ctx = { headers: {}, query: {} };
  const cache = new Map();
  const fetches = [];
  ctx.http = async (config) => {
    fetches.push(config.data);
    return { status: 200, headers: {}, data: { access_token: 'NEW' } };
  };
  let now = 5_000_000;
  ctx.now = () => now;
  const base = { type: 'oauth', grant: 'authorization_code', tokenUrl: 'https://auth.example.com/token' };
  assert.equal(await P._resolveOAuthToken({ ...base, accessToken: 'A', expiresAt: now + 60000 }, { ...ctx, tokenCache: cache }), 'A');
  assert.equal(fetches.length, 0);
  assert.equal(await P._resolveOAuthToken({ ...base, accessToken: 'A', expiresAt: now + 10000, refreshToken: 'R' }, { ...ctx, tokenCache: cache }), 'NEW');
  assert.ok(fetches[0].includes('grant_type=refresh_token') && fetches[0].includes('refresh_token=R'));
  // expiresAt 缺省 → _expired 恒 false → 旧 token 原样续用（怪异但如实钉死）
  assert.equal(await P._resolveOAuthToken({ ...base, accessToken: 'B' }, { ...ctx, tokenCache: cache }), 'B');
  await assert.rejects(() => P._resolveOAuthToken(base, { ...ctx, tokenCache: cache }), (e) => e.statusCode === 401);
});

test('oauth token 端点失败映射为 502（上游异常不裸透传）', async () => {
  const ctx = {
    headers: {},
    query: {},
    tokenCache: new Map(),
    now: () => 0,
    http: async () => ({ status: 401, headers: {}, data: { error: 'bad_client' } }),
  };
  await assert.rejects(
    () => P._resolveOAuthToken({ grant: 'client_credentials', tokenUrl: 'https://auth.example.com/token', clientId: 'c' }, ctx),
    (e) => e.statusCode === 502
  );
  ctx.http = async () => ({ status: 200, headers: {}, data: 'not-json' });
  await assert.rejects(
    () => P._resolveOAuthToken({ grant: 'client_credentials', tokenUrl: 'https://auth.example.com/token', clientId: 'c' }, ctx),
    /no access_token/
  );
});
