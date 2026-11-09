'use strict';

/**
 * vscodeMarketplace — live read-only catalog for VS Code extensions.
 *
 * Open VSX is used instead of the official Marketplace: the official gallery
 * has no API published for third-party use, while Open VSX documents its REST
 * surface and serves every file needed here (license, icon, package.json).
 *
 * Routing needs the packaged package.json, not just registry metadata: an
 * extension that registers MCP servers is a different route from a theme pack.
 * Listing therefore fetches detail + manifest, bounded by query count.
 */

const { VSCODE_OPEN_VSX_BASE_URL } = require('../../constants/serviceDefaults');
const { fromVsCodeExtension, toCatalogEntry } = require('./index');

const ECO = 'vscode';
const SOURCE_NAME = 'Open VSX（VS Code 扩展开放市场）';
const DEFAULT_QUERIES = ['mcp', 'agent'];
const DEFAULT_SIZE = 8;
const MAX_SIZE = 24;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;
const CONCURRENCY = 4;

const _cache = new Map();

function baseUrlOf(value) {
  return String(value || VSCODE_OPEN_VSX_BASE_URL).replace(/\/+$/, '');
}

function clampSize(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SIZE;
  return Math.min(MAX_SIZE, Math.max(1, Math.floor(parsed)));
}

function queriesOf(value) {
  const list = Array.isArray(value) ? value : DEFAULT_QUERIES;
  const cleaned = list.map((query) => String(query || '').trim()).filter(Boolean);
  return cleaned.length ? cleaned : DEFAULT_QUERIES;
}

function ttlMsOf(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  const raw = String(process.env.KHY_VSCODE_MARKET_TTL_MS || '').trim();
  if (!raw) return DEFAULT_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TTL_MS;
}

function timeoutMsOf(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 10000) : DEFAULT_TIMEOUT_MS;
}

async function getJson(url, options) {
  const opts = options || {};
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境缺少 fetch，无法读取 Open VSX');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMsOf(opts.timeoutMs));
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`请求超时：${timeoutMsOf(opts.timeoutMs)}ms 内未返回（${url}）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function searchExtensions(options) {
  const opts = options || {};
  const url =
    `${baseUrlOf(opts.baseUrl)}/api/-/search?query=${encodeURIComponent(opts.query)}` +
    `&size=${clampSize(opts.size)}&sortBy=downloadCount&sortOrder=desc`;
  const payload = await getJson(url, opts);
  return Array.isArray(payload && payload.extensions) ? payload.extensions : [];
}

/**
 * Fetch the registry detail + packaged package.json for one extension. Both
 * are optional: a missing detail still yields a descriptor with license
 * unknown, and a missing manifest becomes an explicit user-decision blocker.
 */
async function fetchExtensionFiles(item, options) {
  const opts = options || {};
  const namespace = String(item && item.namespace ? item.namespace : '');
  const name = String(item && item.name ? item.name : '');
  if (!namespace || !name) return { detail: item, manifest: null, errors: ['扩展缺少 namespace/name'] };
  const errors = [];
  let detail = item;
  try {
    detail = await getJson(`${baseUrlOf(opts.baseUrl)}/api/${namespace}/${name}`, opts);
  } catch (error) {
    errors.push(`详情读取失败（${namespace}.${name}）：${error && error.message ? error.message : String(error)}`);
  }
  let manifest = null;
  const manifestUrl = detail && detail.files && typeof detail.files.manifest === 'string' ? detail.files.manifest : '';
  if (manifestUrl) {
    try {
      manifest = await getJson(manifestUrl, opts);
    } catch (error) {
      errors.push(`package.json 读取失败（${namespace}.${name}）：${error && error.message ? error.message : String(error)}`);
    }
  } else {
    errors.push(`登记表未提供 package.json 地址（${namespace}.${name}）`);
  }
  return { detail, manifest, errors };
}

async function fetchVsCodeEcosystem(options) {
  const opts = options || {};
  const baseUrl = baseUrlOf(opts.baseUrl);
  const size = clampSize(opts.size);
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const queries = queriesOf(opts.queries);

  const searches = await Promise.allSettled(
    queries.map((query) => searchExtensions({ ...opts, baseUrl, size, query }).then((items) => ({ query, items })))
  );
  const failures = [];
  const rows = [];
  const seen = new Set();
  searches.forEach((result, index) => {
    if (result.status === 'rejected') {
      failures.push(`${queries[index]}：${result.reason && result.reason.message ? result.reason.message : String(result.reason)}`);
      return;
    }
    for (const item of result.value.items) {
      const key = `${item.namespace}.${item.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(item);
    }
  });
  if (rows.length === 0) {
    throw new Error(
      `VS Code 扩展市场读取失败：${queries.length} 组检索全部无结果（首个错误：${failures[0] || '未知'}）。` +
        '修复：检查网络或 KHY_OPEN_VSX_ENDPOINT 后点「刷新编目」重试；其余生态编目不受影响。'
    );
  }

  const fileErrors = [];
  const files = await mapLimit(rows, CONCURRENCY, async (item) => {
    const result = await fetchExtensionFiles(item, { ...opts, baseUrl });
    for (const line of result.errors) fileErrors.push(line);
    return result;
  });

  const entries = [];
  const blocked = [];
  files.forEach(({ detail, manifest }) => {
    const canonical = fromVsCodeExtension(detail, manifest, { eco: ECO, baseUrl });
    const entry = toCatalogEntry(canonical);
    entries.push(entry);
    if (canonical.route.compat === 'blocked') {
      blocked.push({
        name: entry.name,
        upstreamUrl: entry.upstreamUrl,
        avatarUrl: entry.avatarUrl,
        author: entry.author,
        compat: 'blocked',
        reason: entry.compatNote,
      });
    }
  });

  const uncertainties = [
    `每组检索取下载量前 ${size} 条，查询串：${queries.join(' / ')}；完整检索请在 open-vsx.org 进行。`,
    '官方 Visual Studio Marketplace 未开放第三方 API，本来源改用 Open VSX（开放登记表）；返回结果与官方市场不完全相同。',
    'VSIX 依赖 VS Code 宿主 API：只有声明的 MCP 提供者与可重写命令面能映射，其余按阻塞或需适配登记。',
  ];
  for (const failure of failures) uncertainties.push(`该查询本次失败，已跳过：${failure}`);
  for (const failure of fileErrors.slice(0, 3)) uncertainties.push(failure);
  if (fileErrors.length > 3) uncertainties.push(`另有 ${fileErrors.length - 3} 条清单读取失败未逐条列出。`);

  return {
    eco: ECO,
    title: 'VS Code 扩展市场（Open VSX）',
    surveyedAt: new Date(nowMs).toISOString().slice(0, 10),
    live: true,
    marketplaces: [
      {
        name: SOURCE_NAME,
        url: baseUrl,
        kind: '公开 REST：/-/search + /api/{namespace}/{name}',
        note: '条目与图标来自上游登记表；安装命令为 code --install-extension，KhyOS 侧只接 MCP / 可重写命令面。',
      },
    ],
    entries,
    blocked,
    uncertainties,
    counts: { queries: queries.length, extensions: entries.length },
  };
}

async function getVsCodeEcosystem(options) {
  const opts = options || {};
  const baseUrl = baseUrlOf(opts.baseUrl);
  const size = clampSize(opts.size);
  const queries = queriesOf(opts.queries);
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const ttlMs = ttlMsOf(opts.ttlMs);
  const key = `${baseUrl}|${size}|${queries.join(',')}`;
  const cached = _cache.get(key);

  if (!opts.force && cached && nowMs - cached.at < ttlMs) return cached.payload;

  try {
    const payload = await fetchVsCodeEcosystem({ ...opts, baseUrl, size, queries, nowMs });
    _cache.set(key, { at: nowMs, payload });
    return payload;
  } catch (error) {
    if (!cached) throw error;
    const ageMinutes = Math.max(0, Math.round((nowMs - cached.at) / 60000));
    return {
      ...cached.payload,
      stale: true,
      uncertainties: [
        ...(Array.isArray(cached.payload.uncertainties) ? cached.payload.uncertainties : []),
        `本次刷新失败，显示 ${ageMinutes} 分钟前的缓存：${error && error.message ? error.message : String(error)}`,
      ],
    };
  }
}

function clearVsCodeCache() {
  _cache.clear();
}

module.exports = {
  ECO,
  SOURCE_NAME,
  DEFAULT_QUERIES,
  DEFAULT_SIZE,
  searchExtensions,
  fetchExtensionFiles,
  fetchVsCodeEcosystem,
  getVsCodeEcosystem,
  clearVsCodeCache,
  DEFAULT_TTL_MS,
};
