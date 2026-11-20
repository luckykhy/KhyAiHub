'use strict';

const express = require('express');
const request = require('supertest');

// K线获取走真实 comprehensiveDataService,会外联 AData/akshare 并把重试日志灌爆
// jest 缓冲。这三个依赖在这里全部换成桩:路由接线本身才是被测对象。
jest.mock('../../src/services/comprehensiveDataService', () => ({
  getComprehensiveData: jest.fn(async () => ({ kline: [] })),
}));
jest.mock('../../src/services/instrumentService', () => ({
  saveInstrumentIfNotExists: jest.fn(async () => ({})),
}));
jest.mock('../../src/services/klineDataService', () => ({
  saveKlineData: jest.fn(async () => ({ success: true, count: 0 })),
  getKlineData: jest.fn(async () => ({ kline: [] })),
  getDataStats: jest.fn(async () => ({})),
}));

// 只桩令牌校验这一层，保留**真实**的 authMiddleware / adminMiddleware 逻辑
// （401 的返回体、req.user 的挂载、admin 的 403 判定）。
jest.mock('../../src/services/authSessionService', () => ({
  authenticateAccessToken: jest.fn(async (token) => {
    if (token === 'admin-token') {
      return { ok: true, user: { id: 1, username: 'admin1', role: 'admin' } };
    }
    if (token === 'user-token') {
      return { ok: true, user: { id: 2, username: 'bob', role: 'user' } };
    }
    return { ok: false, code: 'invalid_token', message: 'invalid token' };
  }),
}));

const router = require('../../src/routes/cache');

describe('cache routes', () => {
  let app;

  const asUser = (req) => req.set('Authorization', 'Bearer user-token');
  const asAdmin = (req) => req.set('Authorization', 'Bearer admin-token');

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/cache', router);
  });

  test('router is defined', () => {
    expect(router).toBeDefined();
    expect(typeof router).toBe('function');
  });

  test('POST /cache/save-instrument-data route exists', async () => {
    const res = await request(app).post('/cache/save-instrument-data').send({});
    expect(res.status).not.toBe(404);
  });

  test('POST /cache/batch-save route exists', async () => {
    const res = await request(app).post('/cache/batch-save').send({});
    expect(res.status).not.toBe(404);
  });

  test('GET /cache/kline-data/:symbol route exists', async () => {
    const res = await request(app).get('/cache/kline-data/AAPL');
    expect(res.status).not.toBe(404);
  });

  test('GET /cache/stats/:symbol route exists', async () => {
    const res = await request(app).get('/cache/stats/AAPL');
    expect(res.status).not.toBe(404);
  });

  test('POST /cache/save-instrument-data accepts JSON body', async () => {
    const res = await request(app)
      .post('/cache/save-instrument-data')
      .send({ symbol: 'AAPL', data: [] })
      .set('Content-Type', 'application/json');
    expect(res.status).not.toBe(404);
  });

  test('POST /cache/batch-save accepts JSON body', async () => {
    const res = await request(app)
      .post('/cache/batch-save')
      .send({ instruments: [] })
      .set('Content-Type', 'application/json');
    expect(res.status).not.toBe(404);
  });

  test('GET /cache/kline-data/:symbol with special symbol', async () => {
    const res = await request(app).get('/cache/kline-data/BRK.B');
    expect(res.status).not.toBe(404);
  });

  test('GET /cache/stats/:symbol with special symbol', async () => {
    const res = await request(app).get('/cache/stats/BRK.B');
    expect(res.status).not.toBe(404);
  });

  test('router has correct number of routes', () => {
    const routes = router.stack.filter((layer) => layer.route);
    expect(routes.length).toBe(4);
  });

  test('router routes have correct methods', () => {
    const routes = router.stack.filter((layer) => layer.route);
    const methods = routes.map((r) => r.route.stack[0].method);
    expect(methods).toContain('post');
    expect(methods).toContain('get');
  });

  // ── SEC-03：鉴权与批量上限 ───────────────────────────────────────────────
  describe('SEC-03：写端点必须鉴权，批量必须有上限', () => {
    test('无 token 的写请求被拒(401)', async () => {
      for (const path of ['/cache/save-instrument-data', '/cache/batch-save']) {
        const res = await request(app).post(path).send({ symbol: 'AAPL', instruments: [{ symbol: 'AAPL' }] });
        expect(res.status).toBe(401);
      }
    });

    test('无效 token 的写请求被拒(401)', async () => {
      const res = await request(app)
        .post('/cache/batch-save')
        .set('Authorization', 'Bearer bogus-token')
        .send({ instruments: [{ symbol: 'AAPL' }] });
      expect(res.status).toBe(401);
    });

    test('非管理员的写请求被拒(403)', async () => {
      for (const path of ['/cache/save-instrument-data', '/cache/batch-save']) {
        const res = await asUser(request(app).post(path)).send({ symbol: 'AAPL', instruments: [{ symbol: 'AAPL' }] });
        expect(res.status).toBe(403);
      }
    });

    test('管理员的写请求能进到控制器', async () => {
      const res = await asAdmin(request(app).post('/cache/batch-save')).send({ instruments: [{ symbol: 'AAPL' }] });
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    test('读端点也要认证', async () => {
      const res = await request(app).get('/cache/kline-data/AAPL');
      expect(res.status).toBe(401);
    });

    test('批量标的数超上限被拒(400)，不超过上限则放行', async () => {
      const many = Array.from({ length: 51 }, (_, i) => ({ symbol: `S${i}` }));
      const over = await asAdmin(request(app).post('/cache/batch-save')).send({ instruments: many });
      expect(over.status).toBe(400);
      expect(over.body.message).toMatch(/50/);

      const atLimit = Array.from({ length: 50 }, (_, i) => ({ symbol: `S${i}` }));
      const ok = await asAdmin(request(app).post('/cache/batch-save')).send({ instruments: atLimit });
      expect(ok.status).not.toBe(400);
    });
  });
});
