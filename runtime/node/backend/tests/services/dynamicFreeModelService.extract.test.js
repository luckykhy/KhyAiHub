'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach, afterEach } = require('node:test');

const {
  extractFreeModelsFromZen,
  extractFreeModelsFromModelsDev,
  extractCatalogFromModelsDev,
  buildCatalog,
} = require('../../src/services/dynamicFreeModelService');

const retired = require('../../src/services/zenRetiredModels');

let _sandbox;

beforeEach(() => {
  // 隔离废弃账本：extractFreeModelsFromZen 会经 filterFreeZenModels 读它。
  _sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dyn-free-'));
  process.env.KHY_ZEN_RETIRED_FILE = path.join(_sandbox, 'zen_retired_models.json');
  retired._reset();
});

afterEach(() => {
  delete process.env.KHY_ZEN_RETIRED_FILE;
  retired._reset();
  try {
    fs.rmSync(_sandbox, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('extractFreeModelsFromZen: OpenAI list envelope {object,data}', () => {
  const kept = extractFreeModelsFromZen({
    object: 'list',
    data: [
      { id: 'claude-fable-5', owned_by: 'opencode' },
      { id: 'mimo-v2.6-flash-free', owned_by: 'opencode' },
      { id: 'jev-1.13-free', owned_by: 'opencode' },
    ],
  });
  // deepseek-v4-flash-free 曾在此处作样本，但它实测返回 401 not supported
  // （2026-10-09），已进 zenRetiredModels 静态废弃名单，故不再期望出现在结果里。
  assert.deepEqual(
    kept.map((m) => m.id),
    ['mimo-v2.6-flash-free', 'jev-1.13-free']
  );
  assert.equal(kept[0].source, 'zen');
  assert.equal(kept[0].provider, 'zen');
});

test('extractFreeModelsFromZen: retired ids never reach the free list', () => {
  // 上游目录会继续挂着已废弃的 id（exo-free 至今仍在 /v1/models，调用返回 410）。
  const kept = extractFreeModelsFromZen({
    object: 'list',
    data: [
      { id: 'exo-free', owned_by: 'opencode' },
      { id: 'mimo-v2.5-free', owned_by: 'opencode' },
      { id: 'space-bunny-free', owned_by: 'opencode' },
    ],
  });
  assert.deepEqual(
    kept.map((m) => m.id),
    ['space-bunny-free']
  );
});

test('extractFreeModelsFromZen: bare array still works; junk returns []', () => {
  const bare = extractFreeModelsFromZen([
    { id: 'mimo-v2.6-flash-free' },
    { id: 'gpt-6-astra' },
  ]);
  assert.deepEqual(
    bare.map((m) => m.id),
    ['mimo-v2.6-flash-free']
  );
  assert.deepEqual(extractFreeModelsFromZen(null), []);
  assert.deepEqual(extractFreeModelsFromZen({ object: 'list' }), []);
  assert.deepEqual(extractFreeModelsFromZen('not-json'), []);
});

test('extractFreeModelsFromModelsDev: flat provider map (live models.dev shape)', () => {
  const kept = extractFreeModelsFromModelsDev({
    'some-cloud': {
      id: 'some-cloud',
      name: 'Some Cloud',
      models: {
        'some-cloud/paid': {
          id: 'some-cloud/paid',
          cost: { input: 1, output: 2 },
        },
        'some-cloud/free': {
          id: 'some-cloud/free',
          cost: { input: 0, output: 0 },
          limit: { context: 128000 },
        },
        'openrouter/model:free': {
          id: 'openrouter/model:free',
          cost: { input: 0.1, output: 0.2 },
        },
      },
    },
    notAProvider: { env: ['X'] },
  });
  assert.deepEqual(kept, [
    {
      id: 'some-cloud/free',
      provider: 'some-cloud',
      providerName: 'Some Cloud',
      contextWindow: 128000,
      source: 'models.dev',
    },
    {
      id: 'openrouter/model:free',
      provider: 'some-cloud',
      providerName: 'Some Cloud',
      contextWindow: 0,
      source: 'models.dev',
    },
  ]);
});

test('extractFreeModelsFromModelsDev: legacy envelopes + junk', () => {
  const nested = extractFreeModelsFromModelsDev({
    providers: {
      acme: {
        name: 'Acme',
        models: [{ id: 'acme/free', cost: { input: 0, output: 0 } }],
      },
    },
  });
  assert.equal(nested.length, 1);
  assert.equal(nested[0].provider, 'acme');

  const flatList = extractFreeModelsFromModelsDev({
    data: [{ id: 'x:free', cost: { input: 0, output: 0 } }],
  });
  assert.equal(flatList.length, 1);

  assert.deepEqual(extractFreeModelsFromModelsDev(null), []);
  assert.deepEqual(extractFreeModelsFromModelsDev([]), []);
  assert.deepEqual(extractFreeModelsFromModelsDev({ providers: {} }), []);
});

// ── [DESIGN-ARCH-154] 热修 2：全量目录（免费 + 付费全收）─────────────────────

test('extractCatalogFromModelsDev: paid models kept with limit.context (agnes-3.0-flash live shape)', () => {
  const catalog = extractCatalogFromModelsDev({
    'nano-gpt': {
      id: 'nano-gpt',
      name: 'NanoGPT',
      models: {
        'agnes-3.0-flash': {
          id: 'agnes-3.0-flash',
          name: 'Agnes 3.0 Flash',
          limit: { context: 524288, input: 524288, output: 65536 },
          cost: { input: 0.05, output: 0.15 },
        },
        'other-paid': { id: 'other-paid', cost: { input: 1, output: 2 } },
      },
    },
    agnes: {
      id: 'agnes',
      name: 'Agnes AI',
      models: {
        'agnes-2.0-flash': {
          id: 'agnes-2.0-flash',
          limit: { context: 512000, output: 65536 },
          cost: { input: 0, output: 0 },
        },
      },
    },
    notAProvider: { env: ['X'] },
  });
  const byId = new Map(catalog.map((m) => [m.id, m]));
  assert.equal(byId.get('agnes-3.0-flash').contextWindow, 524288);
  assert.equal(byId.get('agnes-3.0-flash').provider, 'nano-gpt');
  assert.equal(byId.get('other-paid').contextWindow, 0);
  assert.equal(byId.get('agnes-2.0-flash').contextWindow, 512000);
  assert.equal(catalog.length, 3);
});

test('extractCatalogFromModelsDev: junk inputs → []', () => {
  assert.deepEqual(extractCatalogFromModelsDev(null), []);
  assert.deepEqual(extractCatalogFromModelsDev('nope'), []);
  assert.deepEqual(extractCatalogFromModelsDev({ providers: {} }), []);
  assert.deepEqual(extractCatalogFromModelsDev({ data: [{ noId: true }, null, { id: '  ' }] }), []);
});

test('buildCatalog: dedupe by bare id — prefer window truth, min wins among truths', () => {
  const merged = buildCatalog(
    [
      // zen 池条目：实测零窗口元数据 → contextWindow 0
      { id: 'mimo-v2.6-flash-free', provider: 'zen', contextWindow: 0, source: 'zen' },
    ],
    [
      { id: 'mimo-v2.6-flash-free', provider: 'opencode', contextWindow: 200000, source: 'models.dev' },
      { id: 'agnes-3.0-flash', provider: 'nano-gpt', contextWindow: 524288, source: 'models.dev' },
      { id: 'agnes-3.0-flash', provider: 'elsewhere', contextWindow: 600000, source: 'models.dev' },
      { id: 'dupe-zero-first', provider: 'a', contextWindow: 0 },
      { id: 'dupe-zero-first', provider: 'b', contextWindow: 99000 },
    ]
  );
  const byId = new Map(merged.map((m) => [m.id, m]));
  assert.equal(byId.get('mimo-v2.6-flash-free').contextWindow, 200000); // 真值胜过 0
  assert.equal(byId.get('mimo-v2.6-flash-free').provider, 'opencode');
  assert.equal(byId.get('agnes-3.0-flash').contextWindow, 524288); // 同真值取 min
  assert.equal(byId.get('dupe-zero-first').contextWindow, 99000); // 真值补 0
  assert.equal(merged.length, 3); // 裸 id 去重：mimo / agnes-3.0 / dupe-zero-first
});
