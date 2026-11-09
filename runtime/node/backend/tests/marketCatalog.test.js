'use strict';

const test = require('node:test');
const assert = require('node:assert');

const catalog = require('../src/services/marketCatalog');

function fakeEcoMarkets(base) {
  const calls = { get: 0, load: 0 };
  return {
    calls,
    resolveRoot: () => ({ root: '/fake/market' }),
    getEcoMarkets: () => {
      calls.get += 1;
      return base;
    },
    loadEcoMarkets: () => {
      calls.load += 1;
      return base;
    },
  };
}

function entry(name, extra) {
  return { name, what: `${name} 说明`, license: 'MIT', ...extra };
}

function staticBase(overrides) {
  return {
    status: 'ok',
    generatedAt: '2026-10-29',
    rules: ['规则一'],
    licenseGate: '仅 MIT',
    warnings: [],
    ecosystems: [
      {
        eco: 'static-a',
        title: '静态 A',
        marketplaces: [],
        entries: [entry('a1'), entry('a2')],
        blocked: [entry('blocked-a')],
        uncertainties: ['风险 a'],
      },
    ],
    ...overrides,
  };
}

test('assembles static and live sources with per-source status and totals', async () => {
  const base = staticBase();
  const ecoMarkets = fakeEcoMarkets(base);
  const liveSources = [
    {
      id: 'ok-source',
      title: '实时正常',
      fetch: async () => ({
        eco: 'live-ok',
        title: '实时正常',
        live: true,
        entries: [entry('l1'), entry('l2', { installed: true })],
        blocked: [],
        uncertainties: [],
      }),
    },
    {
      id: 'stale-source',
      title: '实时缓存',
      fetch: async () => ({
        eco: 'live-stale',
        title: '实时缓存',
        live: true,
        stale: true,
        entries: [entry('s1')],
        blocked: [],
        uncertainties: ['本次刷新失败，显示 5 分钟前的缓存：网络错误'],
      }),
    },
    {
      id: 'down-source',
      title: '实时失败',
      fetch: async () => {
        throw new Error('上游 503');
      },
    },
  ];

  const payload = await catalog.assembleEcoMarkets({
    ecoMarkets,
    protocol: null,
    install: null,
    liveSources,
    nowMs: Date.UTC(2026, 10, 2, 9, 30, 0),
  });

  assert.strictEqual(payload.status, 'ok');
  assert.strictEqual(payload.generatedAt, '2026-10-29');
  assert.strictEqual(payload.fetchedAt, '2026-11-02T09:30:00.000Z');
  assert.deepStrictEqual(
    payload.ecosystems.map((m) => m.eco),
    ['static-a', 'live-ok', 'live-stale']
  );
  assert.deepStrictEqual(payload.totals, {
    ecosystems: 3,
    entries: 5,
    blocked: 1,
    installed: 1,
    live: 2,
  });

  const byId = Object.fromEntries(payload.sources.map((s) => [s.id, s]));
  assert.strictEqual(byId.catalog.kind, 'static');
  assert.strictEqual(byId.catalog.entries, 2);
  assert.strictEqual(byId['ok-source'].status, 'ok');
  assert.strictEqual(byId['ok-source'].entries, 2);
  assert.strictEqual(byId['stale-source'].status, 'stale');
  assert.match(byId['stale-source'].message, /本次刷新失败/);
  assert.strictEqual(byId['down-source'].status, 'error');
  assert.match(byId['down-source'].message, /503/);
  assert.ok(payload.warnings.some((w) => w.includes('实时失败未接入')));
});

test('a live ecosystem replaces a static one sharing its eco id', async () => {
  const base = staticBase();
  const payload = await catalog.assembleEcoMarkets({
    ecoMarkets: fakeEcoMarkets(base),
    protocol: null,
    install: null,
    liveSources: [
      {
        id: 'same-eco',
        title: '同名来源',
        fetch: async () => ({
          eco: 'static-a',
          title: '实时 A',
          live: true,
          entries: [entry('fresh')],
          blocked: [],
        }),
      },
    ],
    nowMs: Date.UTC(2026, 10, 2, 9, 30, 0),
  });
  assert.deepStrictEqual(payload.ecosystems.map((m) => m.eco), ['static-a']);
  assert.strictEqual(payload.ecosystems[0].title, '实时 A');
  assert.strictEqual(payload.totals.entries, 1);
});

test('force bypasses the static catalog cache and install annotation feeds totals', async () => {
  const ecoMarkets = fakeEcoMarkets(staticBase());
  const install = {
    annotateInstalled: (list) =>
      list.map((market) => ({
        ...market,
        entries: market.entries.map((row) => ({ ...row, installed: true })),
      })),
  };
  const payload = await catalog.assembleEcoMarkets({
    ecoMarkets,
    protocol: null,
    install,
    liveSources: [],
    force: true,
    nowMs: Date.UTC(2026, 10, 2, 9, 30, 0),
  });
  assert.strictEqual(ecoMarkets.calls.load, 1);
  assert.strictEqual(ecoMarkets.calls.get, 0);
  assert.strictEqual(payload.totals.installed, 2);
});

test('a missing static catalog is demoted to a warning when a live source answered', async () => {
  const ecoMarkets = fakeEcoMarkets({
    status: 'degraded',
    degraded: '编目数据根不可用（识别码 KHY_ECO_MARKET_DIR）',
    ecosystems: [],
    warnings: [],
  });
  const payload = await catalog.assembleEcoMarkets({
    ecoMarkets,
    protocol: null,
    install: null,
    liveSources: [
      {
        id: 'live-only',
        title: '仅实时',
        fetch: async () => ({ eco: 'live-only', live: true, entries: [entry('x')], blocked: [] }),
      },
    ],
    nowMs: Date.UTC(2026, 10, 2, 9, 30, 0),
  });
  assert.strictEqual(payload.status, 'ok');
  assert.strictEqual(payload.degraded, undefined);
  assert.ok(payload.warnings.some((w) => w.includes('KHY_ECO_MARKET_DIR')));
});

test('snapshot returns a static view immediately and swaps in live data later', async () => {
  catalog.clearMarketSnapshot();
  const base = staticBase();
  const ecoMarkets = fakeEcoMarkets(base);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const liveSources = [
    {
      id: 'slow',
      title: '慢来源',
      fetch: async () => {
        await gate;
        return { eco: 'live-slow', live: true, entries: [entry('slow1')], blocked: [] };
      },
    },
  ];
  const options = {
    ecoMarkets,
    protocol: null,
    install: null,
    liveSources,
    nowMs: Date.UTC(2026, 10, 2, 9, 30, 0),
  };

  const first = catalog.getMarketCatalog(options);
  assert.strictEqual(first.refreshing, true);
  assert.strictEqual(first.fetchedAt, '');
  assert.deepStrictEqual(first.ecosystems.map((m) => m.eco), ['static-a']);
  assert.strictEqual(first.sources.find((s) => s.id === 'slow').status, 'pending');
  assert.strictEqual(first.totals.entries, 2);

  release();
  let second = catalog.getMarketCatalog(options);
  for (let i = 0; i < 20 && second.refreshing; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    second = catalog.getMarketCatalog(options);
  }
  assert.strictEqual(second.refreshing, false);
  assert.strictEqual(second.fetchedAt, '2026-11-02T09:30:00.000Z');
  assert.deepStrictEqual(second.ecosystems.map((m) => m.eco), ['static-a', 'live-slow']);
  assert.strictEqual(second.sources.find((s) => s.id === 'slow').status, 'ok');
  catalog.clearMarketSnapshot();
});
