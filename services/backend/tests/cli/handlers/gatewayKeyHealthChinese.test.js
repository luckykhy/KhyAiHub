'use strict';

const assert = require('assert');
const nt = require('node:test');

const probePath = require.resolve('../../../src/services/keyHealthProbe');
const { displayWidth } = require('../../../src/cli/formatters');
const handler = require('../../../src/cli/handlers/gatewayProviderKeyPool');

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s) => s.replace(ANSI, '');

function stubProbe(rows) {
  require.cache[probePath] = {
    id: probePath,
    filename: probePath,
    loaded: true,
    exports: { probeAll: async () => rows },
  };
}

function capture(fn) {
  const logs = [];
  const orig = process.stdout.write;
  process.stdout.write = (c) => {
    logs.push(String(c));
    return true;
  };
  return Promise.resolve()
    .then(fn)
    .then(() => {
      process.stdout.write = orig;
      return strip(logs.join(''));
    })
    .catch((e) => {
      process.stdout.write = orig;
      throw e;
    });
}

nt('health screen renders Chinese labels, not English', async () => {
  stubProbe([
    { provider: 'claude', keyId: 'key-abc-123', healthy: true, latencyMs: 231 },
    { provider: 'openai', keyId: 'sk-live-xyz', healthy: false, error: '401 unauthorized' },
  ]);
  const out = await capture(() => handler.handleGatewayKey('health', [], {}));
  assert.ok(out.includes('密钥健康探测'), 'header should be Chinese');
  assert.ok(/健康/.test(out) && /异常/.test(out), 'status values should be Chinese');
  assert.ok(/个密钥健康/.test(out), 'summary should be Chinese');
  assert.ok(!/Key Health Probe/.test(out), 'old English header gone');
  assert.ok(!/keys healthy/.test(out), 'old English summary gone');
  assert.ok(!/\bhealthy\b|\bunhealthy\b/.test(out), 'old English status words gone');
});

nt('health table status column aligns across rows (incl. CJK provider)', async () => {
  stubProbe([
    { provider: 'claude', keyId: 'key-abc-123', healthy: true, latencyMs: 231 },
    { provider: 'openai', keyId: 'sk-live-xyz', healthy: false, error: '401' },
    { provider: '智谱', keyId: 'k9', healthy: true, latencyMs: 88 },
  ]);
  const out = await capture(() => handler.handleGatewayKey('health', [], {}));
  const widths = [];
  // A data row is: two leading spaces, provider token, keyId token, then status.
  // The header (密钥健康探测) and summary (…个密钥健康) don't match this shape.
  const ROW = /^  \S+ +\S+ +(健康|异常)/;
  for (const line of out.split('\n')) {
    if (!ROW.test(line)) continue;
    const m = line.match(/(健康|异常)/);
    widths.push(displayWidth(line.slice(0, m.index)));
  }
  assert.ok(widths.length >= 3, `expected >=3 data rows, got ${widths.length}`);
  assert.ok(
    widths.every((w) => w === widths[0]),
    `status column start width varies: ${JSON.stringify(widths)}`
  );
});

nt('empty pool message is Chinese, no English "No keys"', async () => {
  stubProbe([]);
  const out = await capture(() => handler.handleGatewayKey('health', [], {}));
  assert.ok(/号池中未配置任何密钥/.test(out), 'empty message Chinese');
  assert.ok(!/No keys configured/.test(out), 'old English empty message gone');
});

nt('gateway key help screen is localized', async () => {
  const out = await capture(() => handler.handleGatewayKey('', [], {}));
  assert.ok(out.includes('网关密钥管理'), 'help header Chinese');
  assert.ok(out.includes('用法'), 'usage label Chinese');
  assert.ok(!/Gateway Key Management/.test(out), 'old English help header gone');
  assert.ok(!/Probe all keys/.test(out), 'old English help line gone');
});
