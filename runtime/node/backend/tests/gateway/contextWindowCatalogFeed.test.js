'use strict';

/**
 * contextWindowCatalogFeed.test.js — 网关免费目录供血（[DESIGN-ARCH-154] 一期）。
 *
 * 病灶回顾：zen /v1/models 实测零窗口元数据 → _contextWindowCache 对 zen 系
 * 永远空 → 全部消费面落 128000 兜底。供血助手 _feedContextWindowCacheFromFreeCatalog
 * 按「本轮 rows 的裸 id」精确反查 dynamicFreeModelService 目录（models.dev 真值），
 * 只填缺失、绝不覆盖 adapter 真值/缓存正值；api:<pool>:<bareId> 命中后完整 id
 * 与裸 id 双写。
 *
 * 运行：node --test tests/gateway/contextWindowCatalogFeed.test.js
 * （node:test 风格 —— 禁 jest 全局，CI 的 node --test 全量扫描会扫到本文件。）
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  AIGatewayRoutingMethods,
  setAiGatewayRoutingMethodsDeps,
  feedContextWindowFromCatalogById,
} = require('../../src/services/gateway/aiGatewayRoutingMethods');

const FULL_ID = 'api:opencode-zen:mimo-v2.6-flash-free';
const BARE_ID = 'mimo-v2.6-flash-free';
const CATALOG = [
  { id: BARE_ID, provider: 'zen', contextWindow: 200000, source: 'models.dev' },
  { id: 'deepseek-v4-flash-free', provider: 'zen', contextWindow: 200000, source: 'zen' },
];

/** 构造最小宿主：只混入被测方法依赖的字段与方法。 */
function makeHost() {
  return {
    _contextWindowCache: new Map(),
    _adapters: [],
    _setContextWindowCache: AIGatewayRoutingMethods._setContextWindowCache,
    getModelContextWindow: AIGatewayRoutingMethods.getModelContextWindow,
    setModelMaxOutputTokens: AIGatewayRoutingMethods.setModelMaxOutputTokens,
    _resolveContextWindowAsync: AIGatewayRoutingMethods._resolveContextWindowAsync,
    _refreshModelsBackground: AIGatewayRoutingMethods._refreshModelsBackground,
    _feedContextWindowCacheFromFreeCatalog:
      AIGatewayRoutingMethods._feedContextWindowCacheFromFreeCatalog,
    _syncChannelLifecycle() {},
    _resolveActiveChannelKey() {
      return null;
    },
  };
}

/** 注入固定目录，隔离网络/文件（真实 getter 默认走 dynamicFreeModelService）。 */
function injectCatalog(models) {
  setAiGatewayRoutingMethodsDeps({
    _freeCatalogGetter: async () => models,
  });
}

/** 轮询等待 fire-and-forget 的异步供血落到缓存。 */
async function waitFor(cache, key, ms = 1500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cache.get(key)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return !!cache.get(key);
}

test('供血命中：api: 前缀 row 按裸 id 反查，完整 id 与裸 id 双写', async () => {
  injectCatalog(CATALOG);
  const host = makeHost();
  const fed = await AIGatewayRoutingMethods._feedContextWindowCacheFromFreeCatalog.call(host, [
    { id: FULL_ID },
  ]);
  assert.strictEqual(fed, 1);
  const full = host._contextWindowCache.get(FULL_ID);
  const bare = host._contextWindowCache.get(BARE_ID);
  assert.strictEqual(full && full.value, 200000);
  assert.strictEqual(full && full.source, 'free-catalog');
  assert.strictEqual(bare && bare.value, 200000);
  // 两种查询形态都精确命中（不依赖部分匹配遍历序）
  assert.strictEqual(
    AIGatewayRoutingMethods.getModelContextWindow.call(host, FULL_ID),
    200000
  );
  assert.strictEqual(AIGatewayRoutingMethods.getModelContextWindow.call(host, BARE_ID), 200000);
});

test('adapter 真值在场（row.contextWindow > 0）→ 供血让位，绝不覆盖', async () => {
  injectCatalog(CATALOG);
  const host = makeHost();
  const fed = await AIGatewayRoutingMethods._feedContextWindowCacheFromFreeCatalog.call(host, [
    { id: FULL_ID, contextWindow: 150000 },
  ]);
  assert.strictEqual(fed, 0);
  assert.strictEqual(host._contextWindowCache.get(FULL_ID), undefined);
});

test('缓存已有正值（probe/error-extract 等来源）→ 不覆盖', async () => {
  injectCatalog(CATALOG);
  const host = makeHost();
  host._contextWindowCache.set(FULL_ID, { value: 111111, expiresAt: 0, source: 'probe' });
  const fed = await AIGatewayRoutingMethods._feedContextWindowCacheFromFreeCatalog.call(host, [
    { id: FULL_ID },
  ]);
  assert.strictEqual(fed, 0);
  assert.strictEqual(host._contextWindowCache.get(FULL_ID).value, 111111);
});

test('目录 getter 抛异常 → 返回 0、不抛、缓存零写入（fail-soft）', async () => {
  setAiGatewayRoutingMethodsDeps({
    _freeCatalogGetter: async () => {
      throw new Error('catalog unavailable');
    },
  });
  const host = makeHost();
  const fed = await AIGatewayRoutingMethods._feedContextWindowCacheFromFreeCatalog.call(host, [
    { id: FULL_ID },
  ]);
  assert.strictEqual(fed, 0);
  assert.strictEqual(host._contextWindowCache.size, 0);
});

test('目录为空 / rows 为空 → 返回 0', async () => {
  injectCatalog([]);
  const host = makeHost();
  assert.strictEqual(
    await AIGatewayRoutingMethods._feedContextWindowCacheFromFreeCatalog.call(host, [{ id: FULL_ID }]),
    0
  );
  injectCatalog(CATALOG);
  assert.strictEqual(
    await AIGatewayRoutingMethods._feedContextWindowCacheFromFreeCatalog.call(host, []),
    0
  );
  assert.strictEqual(
    await AIGatewayRoutingMethods._feedContextWindowCacheFromFreeCatalog.call(host, null),
    0
  );
});

test('裸 id row（无 api: 前缀）→ 单 key 写入', async () => {
  injectCatalog(CATALOG);
  const host = makeHost();
  const fed = await AIGatewayRoutingMethods._feedContextWindowCacheFromFreeCatalog.call(host, [
    { id: BARE_ID },
  ]);
  assert.strictEqual(fed, 1);
  assert.strictEqual(host._contextWindowCache.get(BARE_ID).value, 200000);
});

test('接线冒烟：_resolveContextWindowAsync 对缓存 miss 模型触发目录供血', async () => {
  injectCatalog(CATALOG);
  const host = makeHost();
  host._adapters = [
    {
      enabled: true,
      available: true,
      adapter: {
        // zen 实测形态：零窗口元数据
        listModels: async () => [{ id: FULL_ID, owned_by: 'opencode' }],
      },
    },
  ];
  AIGatewayRoutingMethods._resolveContextWindowAsync.call(host, FULL_ID);
  const landed = await waitFor(host._contextWindowCache, FULL_ID);
  assert.strictEqual(landed, true);
  assert.strictEqual(host._contextWindowCache.get(FULL_ID).value, 200000);
});

test('接线冒烟：_refreshModelsBackground 供血 listModels 零元数据的模型', async () => {
  injectCatalog(CATALOG);
  const host = makeHost();
  host._adapters = [
    {
      enabled: true,
      available: true,
      adapter: {
        listModels: async () => [{ id: FULL_ID, owned_by: 'opencode' }],
      },
    },
  ];
  await AIGatewayRoutingMethods._refreshModelsBackground.call(host);
  const entry = host._contextWindowCache.get(FULL_ID);
  assert.ok(entry, 'refresh 后缓存应已供血');
  assert.strictEqual(entry.value, 200000);
  assert.strictEqual(entry.source, 'free-catalog');
});

test('两段 id 供血：zen rows 实测形态 opencode-zen:mimo-v2.6-flash-free 命中 200000', async () => {
  // 2026-09-26 实测 apiAdapter.listModels 两种形态并存：agnes 池走三段
  // `api:<pool>:<model>`，zen 池走两段 `<pool>:<model>`（`Cloud provider` 分支，
  // apiAdapter.js `${p.key}:${mid}`）。两段裸 id = 最后一段，旧逻辑整体当裸 id 查目录必 miss。
  injectCatalog([{ id: 'mimo-v2.6-flash-free', provider: 'opencode', contextWindow: 200000, source: 'models.dev' }]);
  const host = makeHost();
  const fed = await AIGatewayRoutingMethods._feedContextWindowCacheFromFreeCatalog.call(host, [
    { id: 'opencode-zen:mimo-v2.6-flash-free' },
  ]);
  assert.strictEqual(fed, 1);
  assert.strictEqual(host._contextWindowCache.get('opencode-zen:mimo-v2.6-flash-free').value, 200000);
  assert.strictEqual(host._contextWindowCache.get('mimo-v2.6-flash-free').value, 200000);
});

test('两段 id 让位：adapter 真值在场 → 跳过', async () => {
  injectCatalog([{ id: 'mimo-v2.6-flash-free', provider: 'opencode', contextWindow: 200000, source: 'models.dev' }]);
  const host = makeHost();
  const fed = await AIGatewayRoutingMethods._feedContextWindowCacheFromFreeCatalog.call(host, [
    { id: 'opencode-zen:mimo-v2.6-flash-free', contextWindow: 180000 },
  ]);
  assert.strictEqual(fed, 0);
  assert.strictEqual(host._contextWindowCache.size, 0);
});

// ── [DESIGN-ARCH-154] 热修 4：实际探测升级覆盖目录标称值 ─────────────────────

/** makeHost 变体：注入 probe stub（真值来自上游实际请求，不来自注册表）。 */
function makeProbeHost(probeValue) {
  const host = makeHost();
  host.probeCalls = [];
  host._probeContextWindowForModel = async function (modelId) {
    host.probeCalls.push(modelId);
    return probeValue;
  };
  return host;
}

test('探测升级：目录标称值在场 → 实际探测真值覆盖（source probe）', async () => {
  injectCatalog(CATALOG);
  const host = makeProbeHost(777777);
  host._adapters = [
    {
      enabled: true,
      available: true,
      adapter: { listModels: async () => [{ id: FULL_ID }] },
    },
  ];
  await AIGatewayRoutingMethods._resolveContextWindowAsync.call(host, FULL_ID);
  const landed = await waitFor(host._contextWindowCache, FULL_ID);
  assert.strictEqual(landed, true);
  // 目录先填 200000 占位 → probe 真值 777777 升级覆盖
  assert.strictEqual(host._contextWindowCache.get(FULL_ID).value, 777777);
  assert.strictEqual(host._contextWindowCache.get(FULL_ID).source, 'probe');
  assert.strictEqual(host.probeCalls.length, 1); // 探测恰好一次（pending 去重内）
});

test('探测失败（0）→ 目录占位值保留，不空窗', async () => {
  injectCatalog(CATALOG);
  const host = makeProbeHost(0);
  host._adapters = [
    {
      enabled: true,
      available: true,
      adapter: { listModels: async () => [{ id: FULL_ID }] },
    },
  ];
  await AIGatewayRoutingMethods._resolveContextWindowAsync.call(host, FULL_ID);
  const landed = await waitFor(host._contextWindowCache, FULL_ID);
  assert.strictEqual(landed, true);
  assert.strictEqual(host._contextWindowCache.get(FULL_ID).value, 200000);
  assert.strictEqual(host._contextWindowCache.get(FULL_ID).source, 'free-catalog');
});

test('adapter 真值在场（source listModels）→ 不花探测请求', async () => {
  injectCatalog(CATALOG);
  const host = makeProbeHost(777777);
  host._adapters = [
    {
      enabled: true,
      available: true,
      adapter: {
        listModels: async () => [{ id: FULL_ID, contextWindow: 150000 }],
      },
    },
  ];
  await AIGatewayRoutingMethods._resolveContextWindowAsync.call(host, FULL_ID);
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(host._contextWindowCache.get(FULL_ID).value, 150000);
  assert.strictEqual(host.probeCalls.length, 0);
});

// ── [DESIGN-ARCH-154] 热修 2：付费自有 key 通道（全量目录）───────────────────

test('付费模型供血：api:agnes:agnes-3.0-flash 命中全量目录 524288（2026-09-26 实测截图回归）', async () => {
  // live 形态：agnes-3.0-flash 是付费模型（cost 0.05/0.15），挂在 models.dev 的
  // nano-gpt provider 名下，免费列表永远收不进 —— 全量目录是唯一真值来源。
  injectCatalog([{ id: 'agnes-3.0-flash', provider: 'nano-gpt', contextWindow: 524288, source: 'models.dev' }]);
  const host = makeHost();
  const fed = await AIGatewayRoutingMethods._feedContextWindowCacheFromFreeCatalog.call(host, [
    { id: 'api:agnes:agnes-3.0-flash' },
  ]);
  assert.strictEqual(fed, 1);
  const full = host._contextWindowCache.get('api:agnes:agnes-3.0-flash');
  const bare = host._contextWindowCache.get('agnes-3.0-flash');
  assert.strictEqual(full && full.value, 524288);
  assert.strictEqual(full && full.source, 'free-catalog');
  assert.strictEqual(bare && bare.value, 524288);
  assert.strictEqual(
    AIGatewayRoutingMethods.getModelContextWindow.call(host, 'api:agnes:agnes-3.0-flash'),
    524288
  );
});

test('付费模型让位：adapter 真值 / 缓存正值在场时全量目录绝不覆盖', async () => {
  injectCatalog([{ id: 'agnes-3.0-flash', provider: 'nano-gpt', contextWindow: 524288, source: 'models.dev' }]);
  const host = makeHost();
  assert.strictEqual(
    await AIGatewayRoutingMethods._feedContextWindowCacheFromFreeCatalog.call(host, [
      { id: 'api:agnes:agnes-3.0-flash', contextWindow: 524288 },
    ]),
    0
  );
  host._contextWindowCache.set('api:agnes:agnes-3.0-flash', {
    value: 400000,
    expiresAt: 0,
    source: 'probe',
  });
  assert.strictEqual(
    await AIGatewayRoutingMethods._feedContextWindowCacheFromFreeCatalog.call(host, [
      { id: 'api:agnes:agnes-3.0-flash' },
    ]),
    0
  );
  assert.strictEqual(host._contextWindowCache.get('api:agnes:agnes-3.0-flash').value, 400000);
});

// ── 目录直查级（[DESIGN-ARCH-154]）：不要求 adapter 枚举过该型号 ────────────────
// 病灶：供血级只遍历「adapter 本轮产出的 rows」。一个刚发布、端点 /v1/models 还没
// 列出的新型号既不在 rows 里，也就永远查不到目录 —— 而那正是最需要兜底的一类。
// 直查级按名字直接问目录，静态表因此不必为每个新代型号改一次。

test('直查：端点从未枚举过的型号也能从目录拿到窗口', async () => {
  injectCatalog([{ id: 'brand-new-9000', provider: 'zhipuai', contextWindow: 1000000 }]);
  const host = makeHost();
  // 关键前提：rows 为空（adapter 没列出它），供血级此时完全帮不上忙
  assert.strictEqual(await AIGatewayRoutingMethods._feedContextWindowCacheFromFreeCatalog.call(host, []), 0);
  assert.strictEqual(await feedContextWindowFromCatalogById(host, 'brand-new-9000'), 1000000);
  assert.strictEqual(host._contextWindowCache.get('brand-new-9000').value, 1000000);
  assert.strictEqual(
    AIGatewayRoutingMethods.getModelContextWindow.call(host, 'brand-new-9000'),
    1000000
  );
});

test('直查：完整 id 与裸 id 双写，且按裸 id 查得到', async () => {
  injectCatalog([{ id: 'brand-new-9000', provider: 'zhipuai', contextWindow: 1000000 }]);
  const host = makeHost();
  await feedContextWindowFromCatalogById(host, 'api:agnes:brand-new-9000');
  assert.strictEqual(host._contextWindowCache.get('api:agnes:brand-new-9000').value, 1000000);
  assert.strictEqual(host._contextWindowCache.get('brand-new-9000').value, 1000000);
});

test('直查：认得 vendor 路径与 :free 尾巴（聚合网关形态）', async () => {
  injectCatalog([{ id: 'glm-6', provider: 'zai', contextWindow: 1000000 }]);
  const host = makeHost();
  await feedContextWindowFromCatalogById(host, 'openrouter/z-ai/glm-6:free');
  assert.strictEqual(host._contextWindowCache.get('openrouter/z-ai/glm-6:free').value, 1000000);
});

test('直查：已有真值（probe/error-extract）时让位，绝不覆盖', async () => {
  injectCatalog([{ id: 'brand-new-9000', provider: 'zhipuai', contextWindow: 1000000 }]);
  const host = makeHost();
  host._contextWindowCache.set('brand-new-9000', { value: 262144, expiresAt: 0, source: 'probe' });
  assert.strictEqual(await feedContextWindowFromCatalogById(host, 'brand-new-9000'), 0);
  assert.strictEqual(host._contextWindowCache.get('brand-new-9000').value, 262144);
});

test('直查：目录里没有 / 目录不可得 / 入参非法 → 0，绝不抛', async () => {
  injectCatalog([{ id: 'known-one', provider: 'zai', contextWindow: 1000000 }]);
  const host = makeHost();
  assert.strictEqual(await feedContextWindowFromCatalogById(host, 'never-heard-of-it'), 0);
  assert.strictEqual(await feedContextWindowFromCatalogById(host, ''), 0);
  assert.strictEqual(await feedContextWindowFromCatalogById(null, 'known-one'), 0);
  injectCatalog([]);
  assert.strictEqual(await feedContextWindowFromCatalogById(makeHost(), 'known-one'), 0);
});
