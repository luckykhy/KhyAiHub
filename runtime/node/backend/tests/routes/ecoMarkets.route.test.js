'use strict';

/**
 * ecoMarkets 路由契约（HTTP 层）。
 *
 * 用真实 express app + ephemeral port 打真请求，数据根经 KHY_ECO_MARKET_DIR 指到
 * tmp 夹具（绝不依赖未入仓的 delivery/market）。鉴权不在这里验——它挂在挂载点，
 * 由 aiManagementServer.apiRouteDispatch.test.js 的 401-not-404 用例看守；这里只验
 * 信封形状、/:eco 未知生态的可读错误、以及编目读不到时的降级分流。
 *
 * 写成 node:test 而非 jest：test:node（node --test tests/**）会把 jest 风格文件
 * 当加载失败（ccSwitch.route.test.js 即如此），而 jest.config.js 又会跳过
 * require('node:test') 的套件，两个 runner 都不撞车。
 *
 * 跑法：node --test tests/routes/ecoMarkets.route.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const router = require('../../src/routes/ecoMarkets');

// Route-level contract only: live upstreams are covered by marketCatalog tests
// with injected sources. Leaving them on here would make this suite depend on
// the network and on 30s+ fetch timing.
process.env.KHY_MARKET_OFFLINE = '1';

// 接线（挂载 + 分发 + __test__ 导出）用源码文本钉住：分发器没有兜底代理，
// 少任何一环前端只会看到 404「Not found」，运行时没有任何报错。
const SERVER_SRC = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'services', 'aiManagementServer.js'), 'utf8');

const _fixtures = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-eco-route-'));
  _fixtures.push(root);
  return root;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// 夹具只有一个生态：两条 entries、一条 blocked、一条 uncertainty。
// 形状照真实编目：uncertainties 是字符串数组（见 services/ecoMarkets.js 的说明）。
function buildRoot() {
  const root = makeRoot();
  writeJson(path.join(root, 'catalogs', 'zcode.json'), {
    eco: 'zcode',
    surveyedAt: '2026-10-29',
    marketplaces: [{ name: 'zai-org/zcode-plugins', url: 'https://github.com/zai-org/zcode-plugins' }],
    entries: [{ name: 'computer-use', type: 'plugin', khyosMarket: 'skill', compat: 'adapter-needed' }],
    blocked: [{ name: 'excalidraw', reason: 'khyos 拓展 kind 枚举无 UI 面' }],
    uncertainties: ['许可证冲突未解'],
  });
  writeJson(path.join(root, 'index.json'), {
    generatedAt: '2026-10-29',
    ecosystems: [{ eco: 'zcode', file: 'catalogs/zcode.json', title: 'ZCode 生态', entryCount: 42 }],
    markets: { rules: ['1. compat=blocked → 不路由。'], licenseGate: 'A 档可 vendored 进仓' },
  });
  return root;
}

function request(method, pathname) {
  const app = express();
  app.use(express.json());
  app.use('/api/eco-markets', router);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const req = http.request({ host: '127.0.0.1', port, path: pathname, method }, (res) => {
        let out = '';
        res.on('data', (chunk) => {
          out += chunk;
        });
        res.on('end', () => {
          server.close(() => {
            try {
              resolve({ status: res.statusCode, body: JSON.parse(out) });
            } catch {
              resolve({ status: res.statusCode, body: out });
            }
          });
        });
      });
      req.on('error', (err) => server.close(() => reject(err)));
      req.end();
    });
  });
}

test('GET /api/eco-markets：清单信封带 success+data+metadata，计数由数组现算', async () => {
  const prev = process.env.KHY_ECO_MARKET_DIR;
  process.env.KHY_ECO_MARKET_DIR = buildRoot();
  try {
    const r = await request('GET', '/api/eco-markets');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.success, true);
    assert.ok(r.body.metadata && r.body.metadata.timestamp, 'metadata 必带');
    assert.ok(!('message' in r.body), '非降级不应带 degraded 提示');
    assert.deepStrictEqual(r.body.data.ecosystems.map((m) => m.eco), ['zcode']);
    const eco = r.body.data.ecosystems[0];
    assert.strictEqual(eco.entries.length, 1, 'index 写 42，实际 1 条');
    assert.ok(!('entryCount' in eco));
    assert.strictEqual(eco.blocked.length, 1);
    assert.strictEqual(eco.marketplaces.length, 1);
    // uncertainties 是字符串数组：写对象夹具时这里会是 0，「残留风险」整块消失。
    assert.strictEqual(eco.uncertainties.length, 1);
    assert.strictEqual(eco.uncertainties[0], '许可证冲突未解');
    assert.strictEqual(r.body.data.generatedAt, '2026-10-29');
    assert.deepStrictEqual(r.body.data.rules, ['1. compat=blocked → 不路由。']);
    assert.strictEqual(r.body.data.licenseGate, 'A 档可 vendored 进仓');
    assert.deepStrictEqual(r.body.data.warnings, []);
  } finally {
    if (prev === undefined) delete process.env.KHY_ECO_MARKET_DIR;
    else process.env.KHY_ECO_MARKET_DIR = prev;
  }
});

test('GET /api/eco-markets/:eco：单市场全量 + 闸门规则', async () => {
  const prev = process.env.KHY_ECO_MARKET_DIR;
  process.env.KHY_ECO_MARKET_DIR = buildRoot();
  try {
    const r = await request('GET', '/api/eco-markets/zcode');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.success, true);
    assert.strictEqual(r.body.data.eco, 'zcode');
    assert.strictEqual(r.body.data.title, 'ZCode 生态');
    assert.strictEqual(r.body.data.surveyedAt, '2026-10-29');
    assert.strictEqual(r.body.data.entries[0].name, 'computer-use');
    assert.strictEqual(r.body.data.blocked[0].name, 'excalidraw');
    assert.deepStrictEqual(r.body.data.uncertainties, ['许可证冲突未解']);
    assert.deepStrictEqual(r.body.data.rules, ['1. compat=blocked → 不路由。']);
    assert.strictEqual(r.body.data.licenseGate, 'A 档可 vendored 进仓');
  } finally {
    if (prev === undefined) delete process.env.KHY_ECO_MARKET_DIR;
    else process.env.KHY_ECO_MARKET_DIR = prev;
  }
});

test('GET /api/eco-markets/:eco 未知生态 → 404 + 问题/识别码/修复建议', async () => {
  const prev = process.env.KHY_ECO_MARKET_DIR;
  process.env.KHY_ECO_MARKET_DIR = buildRoot();
  try {
    const r = await request('GET', '/api/eco-markets/nope');
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.success, false);
    const { code, message, hint } = r.body.error;
    assert.strictEqual(code, 'INVALID_ARGUMENT');
    assert.match(message, /未知生态市场「nope」/);
    assert.match(message, /识别码 ECO_MARKET_UNKNOWN_ECO/);
    assert.match(message, /修复：/);
    assert.match(message, /当前可用：zcode/);
    assert.ok(hint && hint.length > 0, 'hint 必带可执行指引');
  } finally {
    if (prev === undefined) delete process.env.KHY_ECO_MARKET_DIR;
    else process.env.KHY_ECO_MARKET_DIR = prev;
  }
});

test('编目读不到：清单 200 降级（metadata.message=degraded），单市场 503', async () => {
  const prev = process.env.KHY_ECO_MARKET_DIR;
  process.env.KHY_ECO_MARKET_DIR = makeRoot();
  try {
    const list = await request('GET', '/api/eco-markets');
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.body.success, true);
    assert.strictEqual(list.body.message, 'degraded');
    assert.strictEqual(list.body.data.status, 'degraded');
    assert.deepStrictEqual(list.body.data.ecosystems, []);
    assert.match(list.body.data.degraded, /KHY_ECO_MARKET_DIR/);
    assert.match(list.body.data.degraded, /修复：/);

    const one = await request('GET', '/api/eco-markets/zcode');
    assert.strictEqual(one.status, 503);
    assert.strictEqual(one.body.success, false);
    assert.strictEqual(one.body.error.code, 'IO_FAILED');
    assert.match(one.body.error.message, /KHY_ECO_MARKET_DIR/);
  } finally {
    if (prev === undefined) delete process.env.KHY_ECO_MARKET_DIR;
    else process.env.KHY_ECO_MARKET_DIR = prev;
  }
});

test('GET-only：POST 不注册路由（无幂等写入面）', async () => {
  const prev = process.env.KHY_ECO_MARKET_DIR;
  process.env.KHY_ECO_MARKET_DIR = buildRoot();
  try {
    const r = await request('POST', '/api/eco-markets');
    assert.strictEqual(r.status, 404);
  } finally {
    if (prev === undefined) delete process.env.KHY_ECO_MARKET_DIR;
    else process.env.KHY_ECO_MARKET_DIR = prev;
  }
});

test('守护进程接线：惰性 getter + 分发分支 + __test__ 导出三环齐全', () => {
  assert.match(SERVER_SRC, /let _ecoMarketsApp;/);
  assert.match(
    SERVER_SRC,
    /a\.use\('\/api\/eco-markets', authenticateToken, require\('\.\.\/routes\/ecoMarkets'\)\)/
  );
  assert.match(
    SERVER_SRC,
    /if \(pathname\.startsWith\('\/api\/eco-markets'\)\) \{\s*return getEcoMarketsApp\(\)\(req, res\);/
  );
  assert.match(SERVER_SRC, /\n\s*getEcoMarketsApp,\n/);

  // 分支必须落在 routeRequest 内、任何 parseBody 之前（子应用要独占原始请求流）。
  const dispatch = SERVER_SRC.indexOf("pathname.startsWith('/api/eco-markets')");
  const dispatcher = SERVER_SRC.indexOf('async function routeRequest(');
  const firstParseBody = SERVER_SRC.indexOf('await parseBody(req);', dispatcher);
  assert.ok(dispatcher !== -1 && dispatch > dispatcher, '分发分支不在 routeRequest 内');
  assert.ok(firstParseBody === -1 || dispatch < firstParseBody, '分发分支必须早于 routeRequest 内首个 parseBody 调用');
});

test.after(() => {
  for (const item of _fixtures) {
    fs.rmSync(item, { recursive: true, force: true });
  }
  _fixtures.length = 0;
});
