'use strict';

/**
 * mcpRegistry — live read-only catalog for the official MCP Registry.
 *
 * The registry is the only public source where publishers state how a server
 * is launched (npm/pypi/oci package or a remote endpoint), so entries here can
 * be written into mcp.json as-is instead of being translated by hand. Queries
 * pick a spread of tool families; the registry itself has no popularity sort.
 */

const { MCP_REGISTRY_BASE_URL } = require('../../constants/serviceDefaults');
const { fromMcpRegistryServer, toCatalogEntry } = require('./index');

const ECO = 'mcp-registry';
const SOURCE_NAME = '官方 MCP Registry';
const DEFAULT_QUERIES = [
  'github',
  'filesystem',
  'browser',
  'database',
  'search',
  'slack',
  'notion',
  'memory',
  'fetch',
  'shell',
];
const DEFAULT_SIZE = 20;
const MAX_SIZE = 100;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;

const _cache = new Map();

function baseUrlOf(value) {
  return String(value || MCP_REGISTRY_BASE_URL).replace(/\/+$/, '');
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
  const raw = String(process.env.KHY_MCP_REGISTRY_TTL_MS || '').trim();
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
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境缺少 fetch，无法读取官方 MCP Registry');
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

async function searchServers(options) {
  const opts = options || {};
  const url =
    `${baseUrlOf(opts.baseUrl)}/v0/servers?search=${encodeURIComponent(opts.query)}` +
    `&limit=${clampSize(opts.size)}&version=latest`;
  const payload = await getJson(url, opts);
  return Array.isArray(payload && payload.servers) ? payload.servers : [];
}

async function fetchMcpRegistryEcosystem(options) {
  const opts = options || {};
  const baseUrl = baseUrlOf(opts.baseUrl);
  const size = clampSize(opts.size);
  const queries = queriesOf(opts.queries);
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();

  const searches = await Promise.allSettled(
    queries.map((query) => searchServers({ ...opts, baseUrl, size, query }))
  );
  const failures = [];
  const rows = [];
  const seen = new Set();
  searches.forEach((result, index) => {
    if (result.status === 'rejected') {
      failures.push(`${queries[index]}：${result.reason && result.reason.message ? result.reason.message : String(result.reason)}`);
      return;
    }
    for (const row of result.value) {
      const registryName = String((row && row.server && row.server.name) || '');
      if (!registryName) continue;
      if (seen.has(registryName)) continue;
      seen.add(registryName);
      rows.push(row);
    }
  });
  if (rows.length === 0) {
    throw new Error(
      `官方 MCP Registry 读取失败：${queries.length} 组检索全部无结果（首个错误：${failures[0] || '未知'}）。` +
        '修复：检查网络或 KHY_MCP_REGISTRY_ENDPOINT 后点「刷新编目」重试；其余生态编目不受影响。'
    );
  }

  const entries = [];
  const blocked = [];
  for (const row of rows) {
    const canonical = fromMcpRegistryServer(row, { eco: ECO, baseUrl });
    const entry = toCatalogEntry(canonical);
    entries.push(entry);
    if (canonical.route.compat === 'blocked') {
      blocked.push({
        name: entry.name,
        upstreamUrl: entry.upstreamUrl,
        author: entry.author,
        compat: 'blocked',
        reason: entry.compatNote,
      });
    }
  }

  const uncertainties = [
    `按 ${queries.length} 组关键词各取前 ${size} 条：${queries.join(' / ')}；官方登记表没有下载量排序，本来源不做热度猜测。`,
    '登记信息由发布者提交：许可证与运行安全需按仓库自行核对，本来源只转录启动规格。',
    '需要环境变量或请求头的 server 会在详情页列出必填项，未填值也能先写入配置。',
  ];
  for (const failure of failures) uncertainties.push(`该检索本次失败，已跳过：${failure}`);

  return {
    eco: ECO,
    title: '官方 MCP Registry（模型上下文协议服务器登记表）',
    surveyedAt: new Date(nowMs).toISOString().slice(0, 10),
    live: true,
    marketplaces: [
      {
        name: SOURCE_NAME,
        url: `${baseUrl}/v0/servers`,
        kind: '公开 REST v0：/v0/servers?search=&limit=&version=latest',
        note: '条目自带 npm/pypi/oci 启动规格或远程端点；安装写入用户级 mcp.json。',
      },
    ],
    entries,
    blocked,
    uncertainties,
    counts: { queries: queries.length, servers: entries.length },
  };
}

async function getMcpRegistryEcosystem(options) {
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
    const payload = await fetchMcpRegistryEcosystem({ ...opts, baseUrl, size, queries, nowMs });
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

function clearMcpRegistryCache() {
  _cache.clear();
}

module.exports = {
  ECO,
  SOURCE_NAME,
  DEFAULT_QUERIES,
  DEFAULT_SIZE,
  searchServers,
  fetchMcpRegistryEcosystem,
  getMcpRegistryEcosystem,
  clearMcpRegistryCache,
  DEFAULT_TTL_MS,
};
