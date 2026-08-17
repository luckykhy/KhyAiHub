'use strict';

/**
 * dynamicFreeModelService — 动态免费模型列表服务。
 *
 * 数据源（优先级从高到低）：
 *   1. 本地文件缓存（TTL 5 分钟）
 *   2. 在线拉取：https://opencode.ai/zen/v1/models + https://models.dev/api.json
 *
 * 免费模型判定：
 *   - Zen 端点：返回的模型列表即为免费可用模型
 *   - models.dev 端点：cost.input === 0 && cost.output === 0 的模型
 *
 * 刷新策略：
 *   - 启动时：检查缓存 TTL，过期则重新拉取
 *   - 后台定时：每 60 分钟自动刷新
 *   - 手动触发：调用 refresh() 强制刷新
 *
 * @pattern Singleton
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 配置 ─────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟缓存 TTL
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 60 分钟后台刷新间隔
const FETCH_TIMEOUT_MS = parseInt(process.env.KHY_FREE_MODEL_FETCH_TIMEOUT_MS || '10000', 10);

// models.dev 数据源（OpenCode 使用的中央模型注册库）
const MODELS_DEV_URL = 'https://models.dev/api.json';
// OpenCode Zen 网关免费模型端点 — endpoint SSOT in constants/serviceDefaults (Zero Hardcoding)
const { ZEN_BASE_URL, OPENCODE_USER_AGENT } = require('../constants/serviceDefaults');
const ZEN_FREE_MODELS_URL = `${ZEN_BASE_URL.replace(/\/+$/, '')}/models`;

// ── 缓存路径 ─────────────────────────────────────────────────────────────────

let _cacheDir = null;
function getCacheDir() {
  if (_cacheDir) {
    return _cacheDir;
  }
  try {
    const dataHome = require('../utils/dataHome').getDataDir('cache');
    _cacheDir = path.join(dataHome, 'free-models');
  } catch {
    _cacheDir = path.join(os.homedir(), '.khy', 'cache', 'free-models');
  }
  try {
    fs.mkdirSync(_cacheDir, { recursive: true });
  } catch {
    /* best effort */
  }
  return _cacheDir;
}

const CACHE_FILE = () => path.join(getCacheDir(), 'free-models.json');
const CACHE_META_FILE = () => path.join(getCacheDir(), 'free-models-meta.json');
// ── 全量目录缓存（[DESIGN-ARCH-154] 热修 2）：付费自有 key 通道的模型（如 agnes-3.0-flash，
// 挂 models.dev 的 nano-gpt 名下，cost 0.05/0.15）永远进不了免费列表，但窗口真值同源 ——
// api.json 一次拉取双产物，免费列表语义不变。
// TTL 24h（注册数据准静态）+ 拉取超时 30s：api.json 实测 4.9MB，沿用免费列表的 10s 超时
// 在慢网下高频失败（2026-09-26 实测复现：10s 内拉不完 → 目录空 → 供血空转 5 分钟）。
const CATALOG_FILE = () => path.join(getCacheDir(), 'free-catalog.json');
const CATALOG_META_FILE = () => path.join(getCacheDir(), 'free-catalog-meta.json');
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const CATALOG_FETCH_TIMEOUT_MS = Math.max(FETCH_TIMEOUT_MS, 30000);

// ── 状态 ─────────────────────────────────────────────────────────────────────

let _refreshTimer = null;
let _refreshPromise = null; // 防止并发刷新
let _lastCatalog = null; // 最近一次在线拉取产出的全量目录（内存兜底）
let _lastDevCatalog = null; // 最近一次 api.json 原始数据的全量提取（fetch 中间产物）

// ── 工具函数 ─────────────────────────────────────────────────────────────────

/** Fail-soft: 任何错误返回 null */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || FETCH_TIMEOUT_MS);
  if (timeoutId.unref) {
    timeoutId.unref();
  }

  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...(options.headers || {}) },
      signal: controller.signal,
    });
    if (!resp.ok) {
      return null;
    }
    return await resp.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Unwrap OpenAI-style list envelopes: bare array | {data} | {models}. */
function _unwrapModelList(data) {
  if (Array.isArray(data)) {
    return data;
  }
  if (data && typeof data === 'object') {
    if (Array.isArray(data.data)) {
      return data.data;
    }
    if (Array.isArray(data.models)) {
      return data.models;
    }
  }
  return null;
}

/** Free if cost is explicitly 0/0, or id carries a free tier suffix. */
function _isFreeModelEntry(m) {
  if (!m || typeof m !== 'object') {
    return false;
  }
  const id = String(m.id || '');
  if (/(^|[:/])[^:/]+:free$/.test(id) || /-free$/.test(id)) {
    return true;
  }
  if (m.cost && typeof m.cost === 'object') {
    const costIn = Number(m.cost.input ?? m.inputCost ?? NaN);
    const costOut = Number(m.cost.output ?? m.outputCost ?? NaN);
    return costIn === 0 && costOut === 0;
  }
  return false;
}

/**
 * models.dev live shape is a flat map `{ [providerId]: { name, models: { [id]: model } } }`.
 * Keep supporting the older documented `{ providers: { … } }` / `{ data: [ … ] }` envelopes.
 */
function extractFreeModelsFromModelsDev(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return [];
  }
  const free = [];
  if (Array.isArray(data.data)) {
    for (const m of data.data) {
      if (_isFreeModelEntry(m)) {
        free.push({
          id: String(m.id || '').trim(),
          provider: String(m.provider || 'models.dev'),
          providerName: m.providerName || m.provider || 'models.dev',
          contextWindow: m.contextWindow || m.context_window || m.limit?.context || 0,
          source: 'models.dev',
        });
      }
    }
    return free.filter((m) => m.id);
  }
  const providers =
    data.providers && typeof data.providers === 'object' ? data.providers : data;
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== 'object' || !provider.models) {
      continue;
    }
    const models = Array.isArray(provider.models)
      ? provider.models
      : Object.values(provider.models);
    for (const m of models) {
      if (!_isFreeModelEntry(m)) {
        continue;
      }
      const id = String(m.id || '').trim();
      if (!id) {
        continue;
      }
      free.push({
        id,
        provider: providerId,
        providerName: provider.name || providerId,
        contextWindow: m.contextWindow || m.context_window || m.limit?.context || 0,
        source: 'models.dev',
      });
    }
  }
  return free;
}

/**
 * 全量目录提取（[DESIGN-ARCH-154] 热修 2）：不做免费过滤，收全 provider 全模型的窗口真值。
 * 纯函数，与 extractFreeModelsFromModelsDev 同构（flat map + legacy envelopes）。
 */
function extractCatalogFromModelsDev(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return [];
  }
  const out = [];
  if (Array.isArray(data.data)) {
    for (const m of data.data) {
      if (!m || typeof m !== 'object' || !String(m.id || '').trim()) {
        continue;
      }
      out.push({
        id: String(m.id).trim(),
        provider: String(m.provider || 'models.dev'),
        providerName: m.providerName || m.provider || 'models.dev',
        contextWindow: m.contextWindow || m.context_window || m.limit?.context || 0,
        source: 'models.dev',
      });
    }
    return out;
  }
  const providers =
    data.providers && typeof data.providers === 'object' ? data.providers : data;
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== 'object' || !provider.models) {
      continue;
    }
    const models = Array.isArray(provider.models)
      ? provider.models
      : Object.values(provider.models);
    for (const m of models) {
      if (!m || typeof m !== 'object') {
        continue;
      }
      const id = String(m.id || '').trim();
      if (!id) {
        continue;
      }
      out.push({
        id,
        provider: providerId,
        providerName: provider.name || providerId,
        contextWindow: m.contextWindow || m.context_window || m.limit?.context || 0,
        source: 'models.dev',
      });
    }
  }
  return out;
}

/** 从 Zen 端点提取免费模型（仅 *-free 后缀；目录混有需付费 key 的 401 模型名） */
function extractFreeModelsFromZen(data) {
  const list = _unwrapModelList(data);
  if (!list) {
    return [];
  }
  const { filterFreeZenModels } = require('./zenGatekeeper');
  return filterFreeZenModels(
    list
      .filter((m) => m && m.id)
      .map((m) => ({
        id: String(m.id).trim(),
        provider: 'zen',
        providerName: m.owned_by || 'OpenCode Zen',
        contextWindow: m.context_window || m.context_length || m.limit?.context || 0,
        source: 'zen',
      }))
  );
}

/** 合并并去重模型列表 */
function mergeModels(zenModels, devModels) {
  const seen = new Set();
  const merged = [];
  for (const m of [...zenModels, ...devModels]) {
    const key = `${m.provider}::${m.id.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push({
      id: m.id,
      provider: m.provider,
      providerName: m.providerName,
      contextWindow: m.contextWindow || 0,
      source: m.source,
    });
  }
  return merged;
}

// ── 文件缓存 ─────────────────────────────────────────────────────────────────

function readCacheFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeCacheFile(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    /* best effort */
  }
}

function loadFromCache() {
  const meta = readCacheFile(CACHE_META_FILE());
  if (!meta || !meta.expiresAt || Date.now() > meta.expiresAt) {
    return null;
  }
  const data = readCacheFile(CACHE_FILE());
  if (!data) {
    return null;
  }
  return { models: data, cachedAt: meta.cachedAt, expiresAt: meta.expiresAt };
}

function saveToCache(models) {
  const now = Date.now();
  writeCacheFile(CACHE_FILE(), models);
  writeCacheFile(CACHE_META_FILE(), {
    cachedAt: now,
    expiresAt: now + CACHE_TTL_MS,
    count: models.length,
  });
}

// ── 全量目录缓存（同 TTL；独立文件，免费列表语义不变） ──────────────────────

function loadCatalogFromCache() {
  const meta = readCacheFile(CATALOG_META_FILE());
  if (!meta || !meta.expiresAt || Date.now() > meta.expiresAt) {
    return null;
  }
  const data = readCacheFile(CATALOG_FILE());
  if (!Array.isArray(data)) {
    return null;
  }
  return { models: data, cachedAt: meta.cachedAt, expiresAt: meta.expiresAt };
}

function saveCatalogCache(models) {
  const now = Date.now();
  writeCacheFile(CATALOG_FILE(), models);
  writeCacheFile(CATALOG_META_FILE(), {
    cachedAt: now,
    expiresAt: now + CATALOG_TTL_MS,
    count: models.length,
  });
}

/** 目录条目去重：同 id 优先有窗口真值者；都有真值取 min（宁可写小，对齐 contextWindowDefaults 原则）。 */
function _mergeCatalogEntry(map, m) {
  if (!m || !m.id) {
    return;
  }
  const key = String(m.id).trim().toLowerCase();
  if (!key) {
    return;
  }
  const n = Number(m.contextWindow);
  const cw = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  const prev = map.get(key);
  if (!prev) {
    map.set(key, { ...m, contextWindow: cw });
    return;
  }
  if (cw > 0 && (prev.contextWindow <= 0 || cw < prev.contextWindow)) {
    map.set(key, { ...m, contextWindow: cw });
  }
}

/** 由 zen 免费池条目 + models.dev 全量目录合成去重后的全量目录。 */
function buildCatalog(zenModels, devCatalog) {
  const map = new Map();
  for (const m of [...(zenModels || []), ...(devCatalog || [])]) {
    _mergeCatalogEntry(map, m);
  }
  return [...map.values()];
}

// ── 在线拉取 ─────────────────────────────────────────────────────────────────

async function fetchZenFreeModels() {
  try {
    // Free gate may fingerprint the UA on catalog fetches too (same SSOT as chat).
    const data = await fetchWithTimeout(ZEN_FREE_MODELS_URL, {
      headers: { 'User-Agent': OPENCODE_USER_AGENT },
    });
    if (!data) {
      return [];
    }
    return extractFreeModelsFromZen(data);
  } catch {
    return [];
  }
}

async function fetchModelsDevFreeModels() {
  try {
    // 目录双产物共用水这一次拉取；api.json 实测 4.9MB —— 超时单独放宽（见 CATALOG_FETCH_TIMEOUT_MS），
    // 但免费列表自身的解析语义不变。注意：免费列表 fetch 也走这里，放宽对两者都是纯收益
    //（免费列表此前同样受 10s 限制，慢网下 641 条变 0 条）。
    const data = await fetchWithTimeout(MODELS_DEV_URL, { timeoutMs: CATALOG_FETCH_TIMEOUT_MS });
    if (!data) {
      return [];
    }
    // 一次拉取双产物（[DESIGN-ARCH-154] 热修 2）：免费列表走既有过滤；全量目录
    //（付费模型含窗口真值）存模块级内存，fetchAllOnline 统一并落目录缓存。
    try {
      const catalog = extractCatalogFromModelsDev(data);
      if (catalog.length > 0) {
        _lastDevCatalog = catalog;
      }
    } catch {
      /* catalog extraction is best-effort */
    }
    return extractFreeModelsFromModelsDev(data);
  } catch {
    return [];
  }
}

async function fetchAllOnline() {
  const [zenModels, devModels] = await Promise.all([
    fetchZenFreeModels(),
    fetchModelsDevFreeModels(),
  ]);
  // 双产物：api.json 在 fetchModelsDevFreeModels 内已顺带提取全量目录（_lastDevCatalog）。
  const catalog = buildCatalog(zenModels, _lastDevCatalog || []);
  if (catalog.length > 0) {
    _lastCatalog = catalog;
    saveCatalogCache(catalog);
  }
  return mergeModels(zenModels, devModels);
}

// ── 核心 API ─────────────────────────────────────────────────────────────────

/**
 * 获取免费模型列表（优先读缓存）。
 * @returns {Promise<{models: Array, cachedAt: number|null, source: string}>}
 */
async function listFreeModels() {
  // 1. 尝试本地缓存
  const cached = loadFromCache();
  if (cached) {
    return {
      models: cached.models,
      cachedAt: cached.cachedAt,
      source: 'cache',
    };
  }

  // 2. 无有效缓存 → 在线拉取
  return refresh();
}

/**
 * 全量模型目录（[DESIGN-ARCH-154] 热修 2）：免费 + 付费全收，带窗口真值。
 * 供血源升级的单一入口 —— 网关侧 `_loadFreeCatalogDefault` 优先取这里，
 * miss 后回退 listFreeModels（一期行为）。缓存/刷新与免费列表同 TTL。
 * @returns {Promise<{models: Array, cachedAt: number|null, source: string}>}
 */
async function listCatalogModels() {
  const cached = loadCatalogFromCache();
  if (cached && cached.models.length > 0) {
    return { models: cached.models, cachedAt: cached.cachedAt, source: 'cache' };
  }
  if (_lastCatalog && _lastCatalog.length > 0) {
    return { models: _lastCatalog, cachedAt: null, source: 'memory' };
  }
  await refresh();
  if (_lastCatalog && _lastCatalog.length > 0) {
    return { models: _lastCatalog, cachedAt: null, source: 'online' };
  }
  // 目录拉取失败 → 免费列表兜底（有总比没有好，一期语义）
  const fallback = await listFreeModels();
  return { models: fallback.models || [], cachedAt: fallback.cachedAt || null, source: 'free-fallback' };
}

/**
 * 强制刷新：在线拉取并更新缓存。
 * @returns {Promise<{models: Array, cachedAt: number, source: string}>}
 */
async function refresh() {
  // 防止并发刷新
  if (_refreshPromise) {
    return _refreshPromise;
  }
  _refreshPromise = (async () => {
    const models = await fetchAllOnline();
    // 空结果不覆盖有货缓存（瞬时网络故障 → 5 分钟空窗 → 供血空转的实测教训 2026-09-26）：
    // 保留旧缓存且不续 meta TTL，下次调用仍会触发 refresh 重试。
    const prevFree = readCacheFile(CACHE_FILE());
    const hasLiveFreeCache = Array.isArray(prevFree) && prevFree.length > 0;
    if (models.length > 0 || !hasLiveFreeCache) {
      saveToCache(models);
    }
    const now = Date.now();
    return {
      models,
      cachedAt: now,
      source: 'online',
    };
  })();

  try {
    return await _refreshPromise;
  } finally {
    _refreshPromise = null;
  }
}

/**
 * 获取缓存状态（TTL 信息 + 模型数量）。
 */
function getCacheStatus() {
  const meta = readCacheFile(CACHE_META_FILE());
  if (!meta) {
    return { hasCache: false, cachedAt: null, expiresAt: null, ttlMs: CACHE_TTL_MS, count: 0 };
  }
  return {
    hasCache: true,
    cachedAt: meta.cachedAt,
    expiresAt: meta.expiresAt,
    ttlMs: CACHE_TTL_MS,
    remainingMs: Math.max(0, meta.expiresAt - Date.now()),
    count: meta.count || 0,
  };
}

// ── 后台定时刷新 ─────────────────────────────────────────────────────────────

function startBackgroundRefresh() {
  if (_refreshTimer) {
    return;
  }
  // 首次延迟 30 秒启动，避免启动即并发
  _refreshTimer = setInterval(() => {
    refresh().catch(() => {
      /* fire-and-forget */
    });
  }, REFRESH_INTERVAL_MS);
  if (_refreshTimer.unref) {
    _refreshTimer.unref();
  }
}

function stopBackgroundRefresh() {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}

// ── 启动时预热 ───────────────────────────────────────────────────────────────

// 启动时检查缓存 TTL，过期则在后台刷新（不阻塞）
function warmUp() {
  const cached = loadFromCache();
  if (!cached) {
    // 无缓存，后台拉取
    refresh().catch(() => {});
  }
  // 启动后台定时刷新
  startBackgroundRefresh();
}

// ── 模块接口 ─────────────────────────────────────────────────────────────────

module.exports = {
  listFreeModels,
  listCatalogModels,
  refresh,
  getCacheStatus,
  startBackgroundRefresh,
  stopBackgroundRefresh,
  warmUp,
  // pure parsers exported for unit tests
  extractFreeModelsFromZen,
  extractFreeModelsFromModelsDev,
  extractCatalogFromModelsDev,
  buildCatalog,
  // 配置常量（可被测试覆盖）
  _CONFIG: { CACHE_TTL_MS, REFRESH_INTERVAL_MS, FETCH_TIMEOUT_MS },
};
