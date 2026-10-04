'use strict';

/**
 * ccSwitch route 契约（DESIGN-ARCH-101）：
 *   1. server.js 真挂载 /api/cc-switch（routes/ccSwitch.js 曾是死代码——文件
 *      注释声称已挂载但 server.js 无引用，网页面因此 404）；
 *   2. 路由门禁强度对齐 channelApis（authMiddleware + adminMiddleware——
 *      卡片切换会改写本机 agent 的 live 配置，属 admin 级操作）；
 *   3. POST /use 透传 mode（direct|proxy，缺省 proxy，成功响应回显 mode）。
 *
 * HTTP 层用真实 express app + listen（范式同 aiGatewayAdmin.modelSlots.test.js），
 * 门禁 mock 成放行以聚焦 mode 语义；门禁自身的接线用源码文本断言钉住。
 */

const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

jest.mock('../../src/middleware/auth', () => ({
  authMiddleware: (req, res, next) => next(),
  adminMiddleware: (req, res, next) => next(),
  authenticateToken: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));

const SERVER_SRC = fs.readFileSync(path.resolve(__dirname, '..', '..', 'server.js'), 'utf8');
const ROUTE_SRC = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'routes', 'ccSwitch.js'), 'utf8');
const API_SRC = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'src', 'services', 'domain', 'config', 'ccSwitch', 'apiHandlers.js'),
  'utf8'
);

function makeApp() {
  const app = express();
  app.use('/api/cc-switch', require('../../src/routes/ccSwitch'));
  return app;
}

function request(app, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: pathname,
          method,
          headers: payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {},
        },
        (res) => {
          let out = '';
          res.on('data', (c) => { out += c; });
          res.on('end', () => {
            server.close(() => {
              try {
                resolve({ status: res.statusCode, body: JSON.parse(out) });
              } catch {
                resolve({ status: res.statusCode, body: out });
              }
            });
          });
        }
      );
      req.on('error', (err) => server.close(() => reject(err)));
      if (payload) req.write(payload);
      req.end();
    });
  });
}

describe('server.js 挂载与门禁接线', () => {
  test('/api/cc-switch 挂载点在 server.js（漏挂即网页面 404）', () => {
    expect(SERVER_SRC).toMatch(/app\.use\('\/api\/cc-switch', require\('\.\/src\/routes\/ccSwitch'\)\)/);
  });

  test('路由内部挂 authMiddleware + adminMiddleware（对齐 channelApis 门禁）', () => {
    expect(ROUTE_SRC).toMatch(/router\.use\(authMiddleware\)/);
    expect(ROUTE_SRC).toMatch(/router\.use\(adminMiddleware\)/);
  });
});

describe('POST /api/cc-switch/use mode 透传', () => {
  const ORIGINAL_DATA_HOME = process.env.KHY_DATA_HOME;
  const ORIGINAL_OPENCODE_CONFIG = process.env.OPENCODE_CONFIG;
  let tempHome = null;

  beforeEach(() => {
    jest.resetModules();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ccswitch-route-'));
    process.env.KHY_DATA_HOME = tempHome;
    // opencode live 配置隔离：OPENCODE_CONFIG 是适配器的第一优先覆盖，
    // 指到临时文件，测试绝不触碰真实 ~/.config/opencode/opencode.json。
    process.env.OPENCODE_CONFIG = path.join(tempHome, 'opencode.json');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    if (ORIGINAL_DATA_HOME === undefined) delete process.env.KHY_DATA_HOME;
    else process.env.KHY_DATA_HOME = ORIGINAL_DATA_HOME;
    if (ORIGINAL_OPENCODE_CONFIG === undefined) delete process.env.OPENCODE_CONFIG;
    else process.env.OPENCODE_CONFIG = ORIGINAL_OPENCODE_CONFIG;
  });

  test('缺 cardId/app → 400（必填校验先于一切）', async () => {
    const app = makeApp();
    const r = await request(app, 'POST', '/api/cc-switch/use', {});
    expect(r.status).toBe(400);
  });

  test('卡片不存在 → 404', async () => {
    const store = require('../../src/services/domain/config/ccSwitch/store');
    store._reset();
    const app = makeApp();
    const r = await request(app, 'POST', '/api/cc-switch/use', {
      cardId: 'c_missing',
      app: 'opencode',
      mode: 'proxy',
    });
    expect(r.status).toBe(404);
  });

  test('mode=proxy（缺省）→ 成功回显 mode:proxy，代理未运行时给出可执行修复动作', async () => {
    const store = require('../../src/services/domain/config/ccSwitch/store');
    store._reset();
    const added = store.addCard({
      name: 'DS Route',
      baseUrl: 'https://api.deepseek.com/v1',
      protocol: 'openai',
      models: ['deepseek-chat'],
    });
    expect(added.success).toBe(true);
    const app = makeApp();
    // 不播 proxy_server_runtime.json/auth.json → 代理模式走 fail-soft 分支
    const r = await request(app, 'POST', '/api/cc-switch/use', {
      cardId: added.card.id,
      app: 'opencode',
    });
    expect(r.status).toBe(500);
    expect(r.body.success).toBe(false);
    expect(r.body.message).toContain('修复动作');
  });

  test('mode=proxy 端点+令牌齐备 → 成功回显 mode:proxy 且写出的模型为三段可路由格式', async () => {
    const store = require('../../src/services/domain/config/ccSwitch/store');
    store._reset();
    const added = store.addCard({
      name: 'DS Route',
      baseUrl: 'https://api.deepseek.com/v1',
      protocol: 'openai',
      models: ['deepseek-chat'],
    });
    fs.writeFileSync(
      path.join(tempHome, 'proxy_server_runtime.json'),
      JSON.stringify({ running: true, endpoint: 'http://127.0.0.1:9100', startedAt: new Date().toISOString() })
    );
    fs.writeFileSync(
      path.join(tempHome, 'proxy_server_auth.json'),
      JSON.stringify({ authToken: 'khy-0123456789abcdef0123456789abcdef0123456789abcdef' })
    );
    const app = makeApp();
    const r = await request(app, 'POST', '/api/cc-switch/use', {
      cardId: added.card.id,
      app: 'opencode',
    });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data.mode).toBe('proxy');
    expect(store.getActiveCardId('opencode')).toBe(added.card.id);
    // agentMode 由 applyCardToApp 记账（§5.2 步骤 5）
    expect(store.getAgentMode('opencode').mode).toBe('proxy');
    // live 配置写的是代理端点 + 代理令牌；opencode 的模型引用语法是
    // `provider/model`——斜杠后即发给上游的模型名 = 三段可路由格式。
    const live = JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG, 'utf-8'));
    expect(live.provider && live.provider.ds_route).toBeTruthy();
    expect(live.provider.ds_route.options.baseURL).toBe('http://127.0.0.1:9100/v1');
    expect(live.provider.ds_route.options.apiKey).toMatch(/^khy-/);
    expect(live.model).toBe('ds_route/api:ds_route:deepseek-chat');
  });

  test('mode=direct → 回显 mode:direct，写 provider 真实端点', async () => {
    const store = require('../../src/services/domain/config/ccSwitch/store');
    store._reset();
    const crypto = require('crypto');
    const key = 'sk-route-direct-0001';
    const keyId = crypto.createHash('md5').update(`deepseek:${key}`).digest('hex').slice(0, 12);
    fs.writeFileSync(
      path.join(tempHome, 'api_keys.json'),
      JSON.stringify({ deepseek: [{ key, endpoint: 'https://api.deepseek.com/v1' }] })
    );
    const added = store.addCard({
      name: 'DS Direct',
      baseUrl: 'https://api.deepseek.com/v1',
      protocol: 'openai',
      models: ['deepseek-chat'],
      keyId,
    });
    const app = makeApp();
    const r = await request(app, 'POST', '/api/cc-switch/use', {
      cardId: added.card.id,
      app: 'opencode',
      mode: 'direct',
    });
    expect(r.status).toBe(200);
    expect(r.body.data.mode).toBe('direct');
    // direct 不记 agentMode（历史语义不污染）
    expect(store.getAgentMode('opencode').cardId).toBe('');
  });
});

describe('GET /api/cc-switch/status 含 12 个 app（矩阵扩面对网页可见）', () => {
  test('status 列出 constants.APPS 全量并带 label', async () => {
    const ORIGINAL = process.env.KHY_DATA_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ccswitch-status-'));
    process.env.KHY_DATA_HOME = home;
    try {
      const app = makeApp();
      const r = await request(app, 'GET', '/api/cc-switch/status');
      expect(r.status).toBe(200);
      expect(r.body.success).toBe(true);
      const ids = r.body.data.map((x) => x.app);
      for (const app of ['claude-code', 'codex', 'opencode', 'zcode', 'deepseek', 'reasonix', 'openclaw', 'coze', 'trae', 'command-code', 'ycode', 'gemini']) {
        expect(ids).toContain(app);
      }
      expect(r.body.data.every((x) => x.label)).toBe(true);
    } finally {
      try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
      if (ORIGINAL === undefined) delete process.env.KHY_DATA_HOME;
      else process.env.KHY_DATA_HOME = ORIGINAL;
    }
  });
});
