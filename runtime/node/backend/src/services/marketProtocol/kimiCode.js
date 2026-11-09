'use strict';

/**
 * kimiCode — live read-only catalog for Kimi Code plugin marketplaces.
 *
 * Kimi Code markets plugins as marketplace JSON v2: {plugins:[{id,source}]}.
 * The marketplace entry carries only the source; skills / agents / MCP live in
 * each plugin repo's kimi.plugin.json, so the reader resolves the repo and
 * fetches that manifest before routing.
 *
 * Only public marketplaces are listed (KIMI_CODE_MARKETPLACE_URLS). The
 * official in-CLI market is served by Kimi itself and has no documented public
 * endpoint, so it is not guessed at here.
 */

const {
  KIMI_CODE_MARKETPLACE_URLS,
  KIMI_CODE_RAW_BASE_URL,
} = require('../../constants/serviceDefaults');
const { fromKimiPlugin, toCatalogEntry } = require('./index');

const ECO = 'kimi-code';
const SOURCE_NAME = 'Kimi Code 公开插件市场';
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;
const CONCURRENCY = 4;
const MANIFEST_CANDIDATES = ['kimi.plugin.json', '.kimi-plugin/plugin.json'];

const _cache = new Map();

function urlsOf(value) {
  const list = Array.isArray(value) ? value : KIMI_CODE_MARKETPLACE_URLS;
  return list.map((url) => String(url || '').trim()).filter(Boolean);
}

function ttlMsOf(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  const raw = String(process.env.KHY_KIMI_MARKET_TTL_MS || '').trim();
  if (!raw) return DEFAULT_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TTL_MS;
}

function timeoutMsOf(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 10000) : DEFAULT_TIMEOUT_MS;
}

// GitHub raw reads are anonymous by default and share a tight per-IP quota;
// an existing token only raises that quota, it does not change what is read.
function githubToken() {
  return String(process.env.KHY_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '').trim();
}

function headersFor(url) {
  const headers = { accept: 'application/json' };
  if (/^https:\/\/raw\.githubusercontent\.com\//i.test(url)) {
    const token = githubToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

async function getJson(url, options) {
  const opts = options || {};
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境缺少 fetch，无法读取 Kimi 市场');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMsOf(opts.timeoutMs));
  try {
    const response = await fetchImpl(url, {
      headers: headersFor(url),
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

function resolveSource(source, marketplaceUrl) {
  const raw = String(source || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw, marketplaceUrl).toString();
  } catch {
    return raw;
  }
}

/**
 * Resolve a GitHub URL (with optional /tree/<ref>/<subdir>) into the pieces
 * needed for a raw manifest fetch. Non-GitHub sources keep repoUrl but cannot
 * be manifest-probed.
 */
function parseGitHubSource(url) {
  const value = String(url || '').trim();
  if (!/^https?:\/\/github\.com\//i.test(value)) return { repoUrl: value, owner: '', repo: '', ref: '', subdir: '' };
  const rest = value
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git(?=$|\/)/, '')
    .replace(/[?#].*$/, '');
  const parts = rest.split('/').filter(Boolean);
  if (parts.length < 2) return { repoUrl: value, owner: '', repo: '', ref: '', subdir: '' };
  const owner = parts[0];
  const repo = parts[1];
  let ref = '';
  let subdir = '';
  if (parts[2] === 'tree' && parts[3]) {
    ref = parts[3];
    subdir = parts.slice(4).join('/');
  }
  return { repoUrl: `https://github.com/${owner}/${repo}`, owner, repo, ref, subdir };
}

function manifestUrlsOf(github) {
  if (!github.owner || !github.repo) return [];
  const ref = github.ref || 'HEAD';
  const base = `${KIMI_CODE_RAW_BASE_URL.replace(/\/+$/, '')}/${github.owner}/${github.repo}/${ref}`;
  const split = github.subdir ? [`${base}/${github.subdir}`] : [];
  const roots = split.length ? [...split, base] : [base];
  const urls = [];
  for (const root of roots) {
    for (const candidate of MANIFEST_CANDIDATES) urls.push(`${root}/${candidate}`);
  }
  return urls;
}

async function fetchKimiManifest(github, options) {
  const urls = manifestUrlsOf(github);
  let lastError = '';
  for (const url of urls) {
    try {
      return { manifest: await getJson(url, options), url };
    } catch (error) {
      lastError = `${url}：${error && error.message ? error.message : String(error)}`;
    }
  }
  return { manifest: null, error: lastError || '来源不是 GitHub 仓库，无法读取清单' };
}

/**
 * Read one marketplace JSON and return its plugin entries with resolved
 * absolute sources. Malformed files are reported, never thrown into the pane.
 */
async function readMarketplace(url, options) {
  const payload = await getJson(url, options);
  const plugins = Array.isArray(payload && payload.plugins) ? payload.plugins : [];
  return plugins
    .filter((plugin) => plugin && typeof plugin === 'object')
    .map((plugin) => {
      const source = resolveSource(plugin.source, url);
      return { ...plugin, source, marketplaceUrl: url, github: parseGitHubSource(source) };
    });
}

async function fetchKimiEcosystem(options) {
  const opts = options || {};
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const urls = urlsOf(opts.marketplaceUrls);

  const settled = await Promise.allSettled(urls.map((url) => readMarketplace(url, opts)));
  const failures = [];
  const plugins = [];
  settled.forEach((result, index) => {
    if (result.status === 'rejected') {
      failures.push(`${urls[index]}：${result.reason && result.reason.message ? result.reason.message : String(result.reason)}`);
      return;
    }
    plugins.push(...result.value);
  });
  if (plugins.length === 0) {
    throw new Error(
      `Kimi Code 市场读取失败：${urls.length} 个公开 marketplace 均未返回插件（首个错误：${failures[0] || '未知'}）。` +
        '修复：检查网络或 KHY_KIMI_MARKETPLACE_URLS 后点「刷新编目」重试；其余生态编目不受影响。'
    );
  }

  const seen = new Set();
  const rows = [];
  for (const plugin of plugins) {
    const key = `${plugin.github.repoUrl}|${plugin.github.subdir}|${plugin.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(plugin);
  }

  const manifestErrors = [];
  const entries = [];
  const blocked = [];
  const manifests = await mapLimit(rows, CONCURRENCY, async (plugin) => {
    const result = await fetchKimiManifest(plugin.github, opts);
    if (!result.manifest && result.error) {
      manifestErrors.push(`${plugin.displayName || plugin.id}：${result.error}`);
    }
    return { plugin, manifest: result.manifest };
  });

  for (const { plugin, manifest } of manifests) {
    const canonical = fromKimiPlugin(plugin, manifest, {
      eco: ECO,
      marketplaceUrl: plugin.marketplaceUrl,
      repoUrl: plugin.github.repoUrl,
      subdir: plugin.github.subdir,
    });
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
  }

  const uncertainties = [
    `公开 marketplace ${urls.length} 个；Kimi 官方内置市场没有公开接口，本来源不猜测其地址。`,
    '市场清单只给 source；技能目录、许可证与命令取自各插件仓库的 kimi.plugin.json，读取失败按待裁决阻塞登记。',
    '插件清单从 GitHub raw 匿名读取，受每 IP 速率限制；设置 KHY_GITHUB_TOKEN 可提高额度，不影响读取内容。',
  ];
  for (const failure of failures) uncertainties.push(`该市场本次读取失败，已跳过：${failure}`);
  for (const failure of manifestErrors.slice(0, 3)) uncertainties.push(`插件清单未读到：${failure}`);
  if (manifestErrors.length > 3) uncertainties.push(`另有 ${manifestErrors.length - 3} 个插件清单未读到，未逐条列出。`);

  return {
    eco: ECO,
    title: 'Kimi Code 插件市场（公开源）',
    surveyedAt: new Date(nowMs).toISOString().slice(0, 10),
    live: true,
    marketplaces: urls.map((url) => ({
      name: SOURCE_NAME,
      url,
      kind: '公开 marketplace JSON v2（Kimi Code /plugins marketplace）',
      note: '条目保留上游 source；技能与 MCP 声明来自插件仓库，安装走 Kimi 自己的 /plugins 或 khy skill add。',
    })),
    entries,
    blocked,
    uncertainties,
    counts: { marketplaces: urls.length, plugins: entries.length },
  };
}

async function getKimiEcosystem(options) {
  const opts = options || {};
  const urls = urlsOf(opts.marketplaceUrls);
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const ttlMs = ttlMsOf(opts.ttlMs);
  const key = urls.join('|');
  const cached = _cache.get(key);

  if (!opts.force && cached && nowMs - cached.at < ttlMs) return cached.payload;

  try {
    const payload = await fetchKimiEcosystem({ ...opts, marketplaceUrls: urls, nowMs });
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

function clearKimiCache() {
  _cache.clear();
}

module.exports = {
  ECO,
  SOURCE_NAME,
  parseGitHubSource,
  resolveSource,
  manifestUrlsOf,
  readMarketplace,
  fetchKimiEcosystem,
  getKimiEcosystem,
  clearKimiCache,
  DEFAULT_TTL_MS,
};
