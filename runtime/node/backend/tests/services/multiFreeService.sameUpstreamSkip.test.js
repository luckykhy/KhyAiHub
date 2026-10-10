'use strict';

/**
 * multiFreeService.sameUpstreamSkip.test.js — 「同上游预跳过」接线守卫。
 *
 * 背景（用户实测 2026-10-09，存证 works/data/khy/feedback/upstream-truth-label-20261009/）：
 * 免费级联里 zen 池失败后，OPENAI_BASE_URL 指到同一端点的 openai 通道会把同一个
 * 429「Endpoint is unavailable」原样再等一轮（那条会话空转 132s 的成因之一）。
 * 本套件用本地 HTTP 服务器实测：同 baseUrl 的第二个 provider 不再真发、留 virtualSkip
 * 记录；门关（KHY_SKIP_SAME_UPSTREAM_RETRY=0）→ 两个都真发（旧行为）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const MultiFreeService = require('../../src/services/multiFreeService');

function startServer() {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    req.resume();
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(
      '{"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}'
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ close: () => server.close(), port: server.address().port, hits: () => hits })
    );
  });
}

function twoProvidersOn(port) {
  const mk = (name, model, priority) => ({
    name,
    apiKey: 'public',
    enabled: true,
    model,
    priority,
    supportsVision: false,
    baseUrl: `http://127.0.0.1:${port}/v1`,
  });
  return {
    'opencode-zen': mk('ZenFake', 'm-free', 0),
    trae: mk('TraeFake', 'm2', 1),
  };
}

test('同上游预跳过：同 baseUrl 的第二个 provider 不再真发，留 virtualSkip 记录', async () => {
  const srv = await startServer();
  delete process.env.KHY_SKIP_SAME_UPSTREAM_RETRY;
  try {
    const svc = new MultiFreeService();
    svc.providers = twoProvidersOn(srv.port);
    const out = await svc.generateResponse('hello', { temperature: 0, maxTokens: 16 });
    assert.strictEqual(out.success, false);
    assert.strictEqual(srv.hits(), 1, '第二个 provider 不应再真发同一上游');
    const skip = (out.attempts || []).find((a) => a && a.virtualSkip);
    assert.ok(skip, '应有 virtualSkip 记录');
    assert.ok(/同上游端点/.test(String(skip.error)), '跳过记录应点名同上游');
    assert.strictEqual(skip.provider, 'TraeFake');
  } finally {
    srv.close();
  }
});

test('门关（KHY_SKIP_SAME_UPSTREAM_RETRY=0）：两个 provider 都真发（旧行为）', async () => {
  const srv = await startServer();
  process.env.KHY_SKIP_SAME_UPSTREAM_RETRY = '0';
  try {
    const svc = new MultiFreeService();
    svc.providers = twoProvidersOn(srv.port);
    const out = await svc.generateResponse('hello', { temperature: 0, maxTokens: 16 });
    assert.strictEqual(out.success, false);
    assert.strictEqual(srv.hits(), 2, '门关应回到旧行为（两个都发）');
    const skips = (out.attempts || []).filter((a) => a && a.virtualSkip);
    assert.strictEqual(skips.length, 0, '门关不应产生 virtualSkip');
  } finally {
    delete process.env.KHY_SKIP_SAME_UPSTREAM_RETRY;
    srv.close();
  }
});

test('不同上游端点的两个 provider 不合并（各自真发）', async () => {
  const srvA = await startServer();
  const srvB = await startServer();
  delete process.env.KHY_SKIP_SAME_UPSTREAM_RETRY;
  try {
    const svc = new MultiFreeService();
    svc.providers = {
      'opencode-zen': {
        name: 'ZenFake',
        apiKey: 'public',
        enabled: true,
        model: 'm-free',
        priority: 0,
        supportsVision: false,
        baseUrl: `http://127.0.0.1:${srvA.port}/v1`,
      },
      trae: {
        name: 'TraeFake',
        apiKey: 'k',
        enabled: true,
        model: 'm2',
        priority: 1,
        supportsVision: false,
        baseUrl: `http://127.0.0.1:${srvB.port}/v1`,
      },
    };
    const out = await svc.generateResponse('hello', { temperature: 0, maxTokens: 16 });
    assert.strictEqual(srvA.hits(), 1);
    assert.strictEqual(srvB.hits(), 1, '不同端点不应被合并跳过');
    const skips = (out.attempts || []).filter((a) => a && a.virtualSkip);
    assert.strictEqual(skips.length, 0);
  } finally {
    srvA.close();
    srvB.close();
  }
});
