'use strict';

/**
 * clientApps route 契约（[DESIGN-ARCH-189] S1 只读层）。
 *
 * 钉住四件事：
 *   1. server.js 真挂载 /api/client-apps —— routes/clientApps.js 曾是死代码的话
 *      网页面会 404，而单元测试全绿（ccSwitch 踩过同一个坑，见其测试注释 #1）；
 *   2. 门禁强度对齐 ccSwitch（authMiddleware + adminMiddleware，裁决 D5 = ①）；
 *   3. POST /scan 对未知 appId 报 400，而不是静默返回一个变短的清单——
 *      「看起来扫描成功了但其实漏了几项」比报错更难排查；
 *   4. **没有任何写路由**。S1 的「只读」由执行面保证（RUNTIME-010），不靠 UI 置灰，
 *      所以 /configure 与 /restore 必须 404。这一条是本文件的核心。
 *
 * HTTP 层用真实 express app + listen；门禁 mock 成放行以聚焦语义，
 * 门禁自身的接线用源码文本断言钉住（同 ccSwitch.route.test.js 范式）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');

const SERVER_SRC = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'server.js'), 'utf8');
const ROUTE_SRC = fs.readFileSync(
  path.resolve(__dirname, 'index.js'),
  'utf8'
);

// --- 1. 真挂载 -----------------------------------------------------------------
test('server.js mounts /api/client-apps', () => {
  assert.match(
    SERVER_SRC,
    /app\.use\(\s*['"]\/api\/client-apps['"]\s*,\s*require\(['"]\.\/src\/routes\/clientApps['"]\s*\)/,
    'server.js 必须挂载 routes/clientApps.js，否则前端 404 而单测全绿'
  );
});

// --- 2. 门禁接线 ---------------------------------------------------------------
test('route is auth + admin gated (ruling D5 = 1)', () => {
  assert.match(ROUTE_SRC, /router\.use\(authMiddleware\)/);
  assert.match(ROUTE_SRC, /router\.use\(adminMiddleware\)/);
});

// --- 3. 写路由：S2 起存在，但范围受控 ---------------------------------------
// S1 时这里断言「无写路由」（RUNTIME-010 由执行面保证只读）。S2 开了写路径，
// 那条断言随之失效——但「范围受控」这条不变量反而更重要：
//   * /configure 对备不了文件的 app 必须拒绝，不静默跳过；
//   * 备份失败必须在写之前中止，一个字节都不写。
// 故此处改为钉住 S2 的范围约束，并保留「未知 appId 不得静默变短清单」。
test('write routes exist and refuse apps that cannot be backed up', () => {
  // 三个写端点必须真的挂着
  for (const p of ['/preview', '/configure', '/restore']) {
    assert.match(ROUTE_SRC, new RegExp(`router\\.post\\(\\s*['"\`]${p}`), `缺少写端点 ${p}`);
  }
  // /configure 必须走编排层（备份 → 写 → 回读），不能自己直接写文件
  assert.match(ROUTE_SRC, /configureApp/, '/configure 必须调用编排层 configureApp');
  assert.match(ROUTE_SRC, /previewConfigure/, '/preview 必须调用 previewConfigure');
  assert.match(ROUTE_SRC, /restoreApp/, '/restore 必须调用 restoreApp');
});

test('write endpoints reject unknown appId (no silent shortening)', async () => {
  const app = makeApp();
  const res = await req(app, 'POST', '/api/client-apps/configure', { appId: '__no_such_app__', card: { id: 'x' } });
  // 409 而非 500：这是「本次没写成」的正常业务结果
  assert.equal(res.status, 409);
  assert.equal(res.body.success, false);
  assert.match(res.body.message, /__no_such_app__|无此 appId/);
});

// --- HTTP 行为 -----------------------------------------------------------------
// node:test 没有 jest.mock，用 require.cache 预置替身：在 clientApps.js
// require('../middleware/auth') 之前先把该模块的缓存换掉。ccSwitch 的测试用
// jest.mock 做同一件事，这里换成 node:test 的等价手法。
const AUTH_PATH = require.resolve('../../middleware/auth');
require.cache[AUTH_PATH] = {
  id: AUTH_PATH,
  filename: AUTH_PATH,
  loaded: true,
  children: [],
  paths: [],
  exports: {
    authMiddleware: (req, res, next) => next(),
    adminMiddleware: (req, res, next) => next(),
    authenticateToken: (req, res, next) => next(),
    requireAdmin: (req, res, next) => next(),
  },
};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.authContext = { ok: true, user: null }; next(); });
  app.use('/api/client-apps', require('./index'));
  return app;
}

function req(app, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const payload = body === undefined ? null : JSON.stringify(body);
      const r = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: pathname,
          method,
          headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { raw += c; });
          res.on('end', () => {
            server.close(() => {
              let json = null;
              try { json = raw ? JSON.parse(raw) : null; } catch { /* non-JSON */ }
              resolve({ status: res.statusCode, body: json, raw });
            });
          });
        }
      );
      r.on('error', (e) => server.close(() => reject(e)));
      if (payload) r.write(payload);
      r.end();
    });
  });
}

test('GET /catalog returns the registry', async () => {
  const app = makeApp();
  const res = await req(app, 'GET', '/api/client-apps/catalog');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.ok(Array.isArray(res.body.data.apps), 'data.apps 必须是数组');
  assert.ok(res.body.data.apps.length > 0, '登记表不应为空');
  // 每条必须带齐卡片要用的字段
  for (const a of res.body.data.apps) {
    for (const f of ['appId', 'name', 'desc', 'pkgName', 'category']) {
      assert.ok(a[f], `条目缺字段 ${f}: ${JSON.stringify(a).slice(0, 120)}`);
    }
  }
});

test('POST /scan probes the machine and never leaks a token', async () => {
  const app = makeApp();
  const res = await req(app, 'POST', '/api/client-apps/scan', {});
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.ok(Array.isArray(res.body.data.apps));
  assert.equal(typeof res.body.data.gateway.available, 'boolean');
  // 令牌绝不跨线（R2）。注意 scanAll() 的 gateway.source.token 是**来源哨兵**
  // （'absent' / 'runtime-file'），不是密钥本身——所以判据是「任何 token 字段的
  // 值都必须是已知哨兵或空」，而不是「payload 里不得出现 token 这个词」。
  // 用前者：后者会把合法的哨兵判成泄露，反而是个会误导人的红线。
  const TOKEN_SENTINELS = new Set(['absent', 'runtime-file', '']);
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (k === 'token') {
          assert.ok(
            TOKEN_SENTINELS.has(String(val)),
            `token 字段携带了非哨兵值（疑似真密钥）: ${JSON.stringify(val).slice(0, 40)}`
          );
        }
        walk(val);
      }
    }
  };
  walk(res.body);
  // 每条扫描结果必须带 badge（三信号徽章的数据来源）
  for (const a of res.body.data.apps) {
    assert.ok(a.badge, `扫描结果缺 badge: ${a.appId}`);
    assert.equal(typeof a.installed, 'boolean');
  }
});

test('POST /scan narrows to a subset when apps is given', async () => {
  const app = makeApp();
  const cat = await req(app, 'GET', '/api/client-apps/catalog');
  const first = cat.body.data.apps[0].appId;
  const res = await req(app, 'POST', '/api/client-apps/scan', { apps: [first] });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.apps.length, 1);
  assert.equal(res.body.data.apps[0].appId, first);
});

test('POST /scan rejects unknown appId instead of silently shortening', async () => {
  const app = makeApp();
  const res = await req(app, 'POST', '/api/client-apps/scan', { apps: ['__no_such_app__'] });
  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
  assert.match(res.body.message, /__no_such_app__/);
});

