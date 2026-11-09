'use strict';

/**
 * visionConfig.resource.js contract tests — the manage funnel for the
 * eyes-only vision endpoint.
 *
 * utils/dataHome, services/visionEndpointStore and services/apiKeyPool are
 * replaced in require.cache (keyed by their fully resolved absolute paths)
 * before this resource is required, and the originals are restored in `after`.
 * Nothing touches the real dataHome: the only path the module can see is an
 * mkdtemp scratch directory that is never populated.
 *
 * The store is stubbed rather than used for real on purpose: what is under test
 * here is the *funnel's* contract (merge semantics, dep wiring, no key echo),
 * not the store's file format — that is pinned in
 * services/visionEndpointStore.test.js.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const P = {
  self: require.resolve('./visionConfig.resource'),
  dataHome: require.resolve('../../../../../utils/dataHome'),
  store: require.resolve('../../../../visionEndpointStore'),
  pool: require.resolve('../../../../apiKeyPool'),
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-manage-vision-'));
const savedCache = {};

function stubModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

const calls = [];
const R = {};

function resetStore() {
  calls.length = 0;
  // null = "not configured yet"; ops.get must pass it through untouched.
  R.current = null;
  R.described = null;
  R.written = { baseUrl: 'https://v.example.com/v1', model: 'step-2-16k', hasApiKey: false };
  R.writeThrows = null;
}

const storeStub = {
  configFilePath: () => path.join(TMP, 'vision_endpoint.json'),
  describeVisionEndpoint: (pool) => {
    calls.push({ fn: 'describeVisionEndpoint', pool });
    return R.described;
  },
  writeVisionEndpoint: (input, pool) => {
    calls.push({ fn: 'writeVisionEndpoint', input, pool });
    if (R.writeThrows) {
      throw R.writeThrows;
    }
    return R.written;
  },
  clearVisionEndpoint: (pool) => {
    calls.push({ fn: 'clearVisionEndpoint', pool });
    return null;
  },
};

const poolStub = { __id: 'apiKeyPool' };

let contract = null;

describe('management/resources/visionConfig.resource', () => {
  before(() => {
    for (const key of Object.keys(P)) {
      savedCache[key] = Object.prototype.hasOwnProperty.call(require.cache, P[key]) ? require.cache[P[key]] : undefined;
      delete require.cache[P[key]];
    }
    require.cache[P.dataHome] = stubModule(P.dataHome, { getDataHome: () => TMP });
    require.cache[P.store] = stubModule(P.store, storeStub);
    require.cache[P.pool] = stubModule(P.pool, poolStub);
    resetStore();
    contract = require(P.self);
    // Deps arrive by injection, not by require — the stubs above only prove the
    // module holds no static D1 require. Without this the ops are unbound.
    contract.bind({ store: storeStub, pool: poolStub });
  });

  after(() => {
    for (const key of Object.keys(P)) {
      if (savedCache[key]) require.cache[P[key]] = savedCache[key];
      else delete require.cache[P[key]];
    }
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetStore();
  });

  it('出厂契约声明：file 真源 + get/set/clear 三能力', () => {
    assert.equal(contract.id, 'vision-config');
    assert.equal(contract.source, 'file');
    assert.deepEqual(contract.capabilities, ['get', 'set', 'clear']);
    assert.deepEqual(Object.keys(contract.ops), ['get', 'set', 'clear']);
    assert.deepEqual(Object.keys(contract.schema).sort(), ['clear', 'set']);
    assert.ok(contract.label.includes('视觉'), 'label 要让人一眼看出这是识图端点');
    assert.equal(typeof contract.bind, 'function');
  });

  it('契约通过 resourceContract 的真·校验', () => {
    const { validateContract } = require('../resourceContract');
    assert.deepEqual(validateContract(contract), { ok: true, errors: [] });
  });

  it('sourceDetail 指向 vision_endpoint.json，与 api-keys / custom-providers / model-config 都不同', () => {
    assert.equal(contract.sourceDetail, path.join(TMP, 'vision_endpoint.json'));
    // The uniqueness guard in managementRegistry.register() rejects two
    // resources on one sourceDetail, so this literal must not drift onto any
    // sibling's file. custom_providers.json is the nearest collision risk.
    assert.notEqual(contract.sourceDetail, path.join(TMP, 'custom_providers.json'));
  });

  it('未绑定时任何 op 都抛「经装配入口调用」，且不静默降级', async () => {
    // A D2 resource required directly (bypassing services/management) has no
    // deps. Silently doing nothing would look like "not configured" forever.
    const boundEntry = require.cache[P.self];
    delete require.cache[P.self];
    const fresh = require(P.self);
    require.cache[P.self] = boundEntry;
    await assert.rejects(() => fresh.ops.get(), /未绑定依赖 store/);
    await assert.rejects(() => fresh.ops.set({ model: 'm' }), /未绑定依赖 store/);
    await assert.rejects(() => fresh.ops.clear(), /未绑定依赖 store/);
    assert.equal(calls.length, 0, 'nothing reached the store stub');
  });

  it('get 原样透传 describe 结果（含 null = 未配置），并把 pool 传下去派生掩码', async () => {
    R.described = null;
    assert.equal(await contract.ops.get(), null);
    assert.deepEqual(calls, [{ fn: 'describeVisionEndpoint', pool: poolStub }]);

    R.described = {
      baseUrl: 'https://v.example.com/v1',
      model: 'step-2-16k',
      poolKey: 'khy-vision',
      pin: 'khy-vision/step-2-16k',
      hasApiKey: true,
      apiKeyMasked: 'sk-…9f2a',
      keyCount: 1,
    };
    assert.deepEqual(await contract.ops.get(), R.described);
  });

  it('get 的回执里没有裸 key（R2 回归锁）', async () => {
    // The mask is derived live by the store from the pool; this funnel must not
    // add a second code path that could reintroduce the raw value.
    R.described = { hasApiKey: true, apiKeyMasked: 'sk-…9f2a', keyCount: 1 };
    const out = await contract.ops.get();
    assert.equal(JSON.stringify(out).includes('sk-test-1234567890abcdef'), false);
  });

  it('set 只做形状归一后逐字透传，不自己判断哪个字段「算给了」', async () => {
    // The merge lives in the store (it owns the file). This layer must not
    // second-guess presence — an empty string is a value the caller typed, and
    // swallowing it here would silently resurrect the old base URL.
    await contract.ops.set({
      baseUrl: 'https://v.example.com/v1',
      model: 'step-2-16k',
      apiKey: 'sk-xxxxx',
      clearApiKey: false,
    });
    assert.deepEqual(calls.map((c) => c.fn), ['writeVisionEndpoint']);
    assert.deepEqual(calls[0].input, {
      baseUrl: 'https://v.example.com/v1',
      model: 'step-2-16k',
      apiKey: 'sk-xxxxx',
      clearApiKey: false,
    });
    assert.equal(calls[0].pool, poolStub);
  });

  it('set 只给一个字段也照样转发——半配置在 store 里合并，这里不加「必须两个」的闸', async () => {
    // `khy config set model.vision.model` on a fresh install must not demand
    // the base URL again. The store merges over the on-disk draft; the funnel
    // just forwards.
    await contract.ops.set({ model: 'step-2-16k' });
    assert.deepEqual(calls[0].input, {
      baseUrl: undefined,
      model: 'step-2-16k',
      apiKey: undefined,
      clearApiKey: false,
    });
  });

  it('set 把 clearApiKey 的字符串形式归一成布尔，其余字段原样', async () => {
    await contract.ops.set({ baseUrl: 'https://v.example.com/v1', model: 'm', clearApiKey: 'true' });
    assert.deepEqual(calls[0].input, {
      baseUrl: 'https://v.example.com/v1',
      model: 'm',
      apiKey: undefined,
      clearApiKey: true,
    });
    // 'false' 也要归一，否则 store 会把它当真值去清钥匙。
    await contract.ops.set({ baseUrl: 'https://v.example.com/v1', model: 'm', clearApiKey: 'false' });
    assert.strictEqual(calls[1].input.clearApiKey, false);
  });

  it('clear 委托 store 并传池——删端点必须同时收回钥匙', async () => {
    assert.equal(await contract.ops.clear(), null);
    assert.deepEqual(calls, [{ fn: 'clearVisionEndpoint', pool: poolStub }]);
  });

  it('store 抛错原样上抛：坏配置不能让 CLI/Web 报成成功', async () => {
    R.writeThrows = new Error('baseUrl 不能为空，且必须是 http(s):// 开头');
    await assert.rejects(() => contract.ops.set({ baseUrl: 'ftp://x', model: 'm' }), { message: /baseUrl 不能为空/ });
  });
});
