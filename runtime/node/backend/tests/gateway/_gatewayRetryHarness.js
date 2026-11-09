'use strict';

/**
 * _gatewayRetryHarness.js — gateway 重试/恢复族(jest 风格)的共享脚手架。
 *
 * aiGateway.retryRecoveryEnhancements / aiGateway.cascadeJitterSelfHeal /
 * aiGateway.networkResume 三个文件各自复制过同一套:mock adapter entry 工厂、
 * 三个 neutralize* 桩、14 行 gateway 内部状态重置、env 存取。duplicationGuard
 * (4 有效行起报)把它拆成每文件 9~20 条 finding —— 是 SOURCING-005 存量重复
 * 最大的一块。此处收进一处,各文件只留自己的 ENV_KEYS 列表与断言。
 *
 * 逐字节等价:各 neutralize* 的桩覆盖面按调用方 opt 保留(见 neutralizeCacheEconomyStore),
 * 不擅自给原本没桩的调用方多桩一个字段。
 */

const BE = require('path').resolve(__dirname, '..', '..');

// ── mock adapter entry ──────────────────────────────────────────────────────────────
// options: available / enabled / detail / refreshCredential / detectAsync / listModels
// 第三个位置参数也可直接给 detectImpl(networkResume 族用:探测结果随网络状态翻转)。
function createAdapterEntry(key, generateImpl, options = {}) {
  if (typeof options === 'function') options = { detectImpl: options };
  const {
    available = true,
    enabled = true,
    detail = 'ok',
    refreshCredential,
    detectAsync = false,
    listModels = false,
    detectImpl,
  } = options;

  const generate = jest.fn(generateImpl);
  const detect = detectImpl || (() => available);
  const adapter = {
    detect,
    getStatus: () => ({ name: key, available, detail }),
    generate,
  };
  if (detectAsync) {
    adapter.detectAsync = async (force) => detect(force);
  }
  if (listModels) {
    adapter.listModels = async () => [{ id: 'm1' }];
  }
  const entry = { key, enabled, available, priority: 1, adapter, _generateMock: generate };
  if (refreshCredential) {
    entry.adapter.refreshCredential = jest.fn(refreshCredential);
  }
  return entry;
}

// ── 三个 neutralize 桩(必须在 jest.resetModules() 之后重新打) ───────────────────────
// 请求期默认模型回落会读用户真实 .khy/model_overrides.json;不桩则 'api' 被路由进
// 池化多 key 分支,被测的重试语义整个变样。
function neutralizeCuratedDefaultModel() {
  const modelCuration = require(BE + '/src/services/gateway/modelCuration');
  modelCuration.getAdapterOverride = () => null;
}

// verdict=true 时一并桩 getVerdict(默认路由排序读真实 store);否则只桩 record。
// 只桩 record 的理由:不桩 record,测试 adapter key 会写进用户真实 cache_economy.json。
function neutralizeCacheEconomyStore({ verdict = true } = {}) {
  const cacheEconomyStore = require(BE + '/src/services/gateway/cacheEconomyStore');
  if (verdict) cacheEconomyStore.getVerdict = () => 'insufficient_data';
  cacheEconomyStore.record = () => {};
}

// 让 'api' 适配器离开池化分支,使未知的测试 key 走标准单 key 流程。
function neutralizeApiKeyPool(reason = 'apiKeyPool disabled for hermetic gateway retry tests') {
  const apiKeyPool = require(BE + '/src/services/apiKeyPool');
  apiKeyPool.init = () => { throw new Error(reason); };
}

// ── gateway 内部状态重置(跳过 init / 真实 refresh,让请求直接进被测分支) ─────────────
function resetGatewayForTest() {
  const gateway = require(BE + '/src/services/gateway/aiGateway');
  gateway._initialized = true;
  gateway._initPromise = null;
  gateway._adapters = [];
  gateway._lastRefreshTime = Date.now();
  gateway._adapterFailures = {};
  gateway._adapterLastError = {};
  gateway._requestLog = {};
  gateway._localAdapters = new Set();
  gateway._serializedAdapterKeys = new Set();
  gateway.refreshAdapters = async () => {};
  gateway._enforceRateLimit = async () => {};
  return gateway;
}

// ── env 存取(三个文件原本各写一份 save/delete/restore 三段) ──────────────────────────
function saveAndClearEnv(keys) {
  const saved = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  return saved;
}

function restoreEnv(keys, saved) {
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

module.exports = {
  BE,
  createAdapterEntry,
  neutralizeCuratedDefaultModel,
  neutralizeCacheEconomyStore,
  neutralizeApiKeyPool,
  resetGatewayForTest,
  saveAndClearEnv,
  restoreEnv,
};