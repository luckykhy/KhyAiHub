'use strict';

/**
 * stepfunOpenclaw — live read-only catalog for 阶跃「水产市场」.
 *
 * The marketplace is a Connect RPC service. Two methods are public: SearchAssets
 * and GetReversionDownloadUrl (verified 2026-11-02 against the live endpoint).
 * Listing therefore needs no account; installing still belongs to the terminal
 * gates, so this module only reads metadata.
 *
 * Network failures degrade, never throw into the marketplace renderer: the six
 * asset types are fetched independently, a failed type is reported as an
 * uncertainty, and a refresh failure returns the previous payload as stale.
 */

const zlib = require('zlib');

const { STEPFUN_OPENCLAW_MARKET_BASE_URL } = require('../../constants/serviceDefaults');
const { fromOpenClawAsset, toCatalogEntry } = require('./index');

const CATALOG_SERVICE = 'step.seafood.catalog.CatalogService';
const SEARCH_METHOD = 'SearchAssets';
const DOWNLOAD_METHOD = 'GetReversionDownloadUrl';
const ECO = 'stepfun-openclaw';
const SOURCE_NAME = '阶跃水产市场（OpenClaw Marketplace）';
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;

// Archive probes are opt-in (getStepfunEcosystem enables them): they are the
// only way to tell an experience/trigger/connector package that actually ships
// a SKILL.md from one that is just knowledge text. Bounded so one refresh
// cannot pull an unbounded amount of data.
const PROBE_CONCURRENCY = 4;
const PROBE_MAX_BYTES = 8 * 1024 * 1024;
const PROBE_TTL_MS = 30 * 60 * 1000;

// Order is the display order inside the source tab. Numbers are the public
// CatalogService asset types (1 experience, 2 skill, 3 plugin, 4 trigger,
// 5 connector/channel, 6 agent).
const ASSET_TYPES = Object.freeze([
  ['skill', 2],
  ['plugin', 3],
  ['agent', 6],
  ['experience', 1],
  ['trigger', 4],
  ['connector', 5],
]);

const _cache = new Map();

function baseUrlOf(value) {
  return String(value || STEPFUN_OPENCLAW_MARKET_BASE_URL).replace(/\/+$/, '');
}

function serviceUrl(baseUrl, service, method) {
  return `${baseUrlOf(baseUrl)}/api/${service}/${method}`;
}

function clampPageSize(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(parsed)));
}

function ttlMsOf(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  const raw = String(process.env.KHY_STEPFUN_MARKET_TTL_MS || '').trim();
  if (!raw) return DEFAULT_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TTL_MS;
}

function timeoutMsOf(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 10000) : DEFAULT_TIMEOUT_MS;
}

function describeFetchFailure(method, status, payload, fallbackText) {
  const message =
    payload && typeof payload === 'object'
      ? payload.message || payload.msg || payload.code
      : String(fallbackText || '').slice(0, 200);
  return `${method} 调用失败：HTTP ${status}${message ? ` · ${message}` : ''}`;
}

async function connectPost(options) {
  const opts = options || {};
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('当前运行环境缺少 fetch，无法读取阶跃市场');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMsOf(opts.timeoutMs));
  try {
    const response = await fetchImpl(serviceUrl(opts.baseUrl, opts.service, opts.method), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'connect-protocol-version': '1',
      },
      body: JSON.stringify(opts.body || {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new Error(describeFetchFailure(opts.method, response.status, payload, text));
    }
    if (!payload || typeof payload !== 'object') {
      throw new Error(`${opts.method} 返回的不是 JSON 对象：${String(text).slice(0, 120)}`);
    }
    return payload;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`${opts.method} 超时：${timeoutMsOf(opts.timeoutMs)}ms 内未返回`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function searchAssets(options) {
  const opts = options || {};
  return connectPost({
    ...opts,
    service: CATALOG_SERVICE,
    method: SEARCH_METHOD,
    body: {
      ...(opts.query ? { query: opts.query } : {}),
      assetType: opts.assetType,
      pageSize: opts.pageSize,
    },
  });
}

function assetTypeName(type) {
  return ASSET_TYPES.find(([, number]) => number === type)?.[0] || String(type);
}

function tarNames(buf) {
  const names = [];
  let longName = '';
  for (let offset = 0; offset + 512 <= buf.length; ) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
    const type = String.fromCharCode(header[156] || 0x30);
    const body = buf.subarray(offset + 512, offset + 512 + size);
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/, '');
    } else if (type === 'x') {
      const path = /(?:^|\n)\d+ path=([^\n]+)\n/.exec(body.toString('utf8'));
      if (path) longName = path[1];
    } else if (type !== 'g') {
      const name = longName || header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
      longName = '';
      if (name) names.push(name);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

function skillDirOf(names) {
  const hit = names.find((name) => /(^|\/)SKILL\.md$/i.test(name));
  if (!hit) return '';
  const dir = hit.replace(/\/?SKILL\.md$/i, '').replace(/^\.\//, '');
  return dir || '.';
}

/**
 * Download one archive and list its tar entries. Archives are gzipped tar in
 * practice; a zip or an oversized body is reported as "not probeable" instead
 * of being half-parsed.
 */
async function probeArchive(assetId, options) {
  const opts = options || {};
  const payload = await connectPost({
    ...opts,
    service: CATALOG_SERVICE,
    method: DOWNLOAD_METHOD,
    body: { assetId },
  });
  const downloadUrl = typeof payload.downloadUrl === 'string' ? payload.downloadUrl : '';
  if (!downloadUrl) throw new Error(`${DOWNLOAD_METHOD} 未返回 downloadUrl`);
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境缺少 fetch');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMsOf(opts.timeoutMs));
  try {
    const response = await fetchImpl(downloadUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`归档下载失败：HTTP ${response.status}`);
    const declared = Number(response.headers && response.headers.get ? response.headers.get('content-length') : 0);
    if (Number.isFinite(declared) && declared > PROBE_MAX_BYTES) {
      throw new Error(`归档超过探测上限 ${PROBE_MAX_BYTES} 字节`);
    }
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.length > PROBE_MAX_BYTES) throw new Error(`归档超过探测上限 ${PROBE_MAX_BYTES} 字节`);
    const buf = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;
    if (buf[0] === 0x50 && buf[1] === 0x4b) throw new Error('归档是 zip，当前只解析 tar(.gz)');
    return tarNames(buf);
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`归档下载超时：${timeoutMsOf(opts.timeoutMs)}ms 内未返回`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const _probeCache = new Map();

/** Probe result is cached per assetId so a repeat refresh does not re-download. */
async function probeSkillDir(assetId, options) {
  const opts = options || {};
  if (!assetId) return '';
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const cached = _probeCache.get(assetId);
  if (cached && nowMs - cached.at < PROBE_TTL_MS) return cached.skillDir;
  const skillDir = skillDirOf(await probeArchive(assetId, opts));
  _probeCache.set(assetId, { at: nowMs, skillDir });
  return skillDir;
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

/**
 * Fetch up to `pageSize` newest assets per type and translate them into the
 * catalog shape the desktop/web panes already render. Pure with respect to
 * options: no cache, no clock hidden inside.
 */
async function fetchStepfunEcosystem(options) {
  const opts = options || {};
  const baseUrl = baseUrlOf(opts.baseUrl);
  const pageSize = clampPageSize(opts.pageSize);
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const types = Array.isArray(opts.types) && opts.types.length ? opts.types : ASSET_TYPES;

  const settled = await Promise.allSettled(
    types.map(([name, assetType]) =>
      searchAssets({
        baseUrl,
        fetch: opts.fetch,
        timeoutMs: opts.timeoutMs,
        assetType,
        pageSize,
      }).then((payload) => ({ name, assetType, items: Array.isArray(payload.items) ? payload.items : [] }))
    )
  );

  const groups = [];
  const failures = [];
  settled.forEach((result, index) => {
    const [name] = types[index];
    if (result.status === 'fulfilled') {
      groups.push(result.value);
    } else {
      failures.push(`${name}：${result.reason && result.reason.message ? result.reason.message : String(result.reason)}`);
    }
  });

  if (groups.length === 0) {
    throw new Error(
      `阶跃水产市场读取失败：${types.length} 类资产全部请求失败（首个错误：${failures[0] || '未知'}）。` +
        '修复：检查网络或 KHY_STEPFUN_MARKET_ENDPOINT 后点「刷新编目」重试；其余生态编目不受影响。'
    );
  }

  // Only entries the metadata route cannot place are worth downloading: an
  // experience/trigger/connector with no Source link may still ship a SKILL.md.
  const plans = groups.flatMap((group) => group.items.map((asset) => ({ group, asset })));
  const probeDirs = new Map();
  const probeFailures = [];
  if (opts.probeArtifacts) {
    const targets = plans
      .filter(({ asset }) => fromOpenClawAsset(asset, { eco: ECO, baseUrl, nowMs }).route.compat === 'blocked')
      .map(({ asset }) => asset);
    await mapLimit(targets, PROBE_CONCURRENCY, async (asset) => {
      const assetId = String(asset.assetId || '');
      if (!assetId) return;
      try {
        const skillDir = await probeSkillDir(assetId, {
          baseUrl,
          fetch: opts.fetch,
          timeoutMs: opts.timeoutMs,
          nowMs,
        });
        if (skillDir) probeDirs.set(assetId, skillDir);
      } catch (error) {
        probeFailures.push(`${String(asset.name || assetId).slice(0, 40)}：${error && error.message ? error.message : String(error)}`);
      }
    });
  }

  const entries = [];
  const blocked = [];
  for (const { asset } of plans) {
    const canonical = fromOpenClawAsset(asset, {
      eco: ECO,
      baseUrl,
      nowMs,
      artifactSkillDir: probeDirs.get(String(asset.assetId || '')),
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
    `每类资产只取最新 ${pageSize} 条（SearchAssets 首页）；完整检索请在水产市场站内进行。`,
    '接口不返回 license 与包内文件清单：可路由条目的许可证按 unknown 处理，导入前须人工核验。',
  ];
  const probed = probeDirs.size + probeFailures.length;
  if (probed > 0) {
    uncertainties.push(
      `已对 ${probed} 条无 Source 的阻塞资产下载归档探测产物（单条上限 ${Math.round(PROBE_MAX_BYTES / 1024 / 1024)} MB，结果缓存 ${PROBE_TTL_MS / 60000} 分钟），其中 ${probeDirs.size} 条命中 SKILL.md 并改按技能接入。`
    );
  }
  for (const failure of probeFailures.slice(0, 3)) {
    uncertainties.push(`产物探测失败，仍按阻塞处理：${failure}`);
  }
  for (const failure of failures) {
    uncertainties.push(`该类型本次拉取失败，已跳过：${failure}`);
  }

  return {
    eco: ECO,
    title: '阶跃 OpenClaw · 水产市场',
    surveyedAt: new Date(nowMs).toISOString().slice(0, 10),
    live: true,
    marketplaces: [
      {
        name: SOURCE_NAME,
        url: baseUrl,
        kind: '公开 Connect RPC：CatalogService.SearchAssets（免登录只读）',
        note: '技能 / 插件 / Agent / 经验 / 触发器 / 通信器六类资产；条目为实时检索结果，安装仍走终端闸门或 openclawmp。',
      },
    ],
    entries,
    blocked,
    uncertainties,
    counts: Object.fromEntries(groups.map((group) => [group.name, group.items.length])),
  };
}

async function getStepfunEcosystem(options) {
  const opts = options || {};
  const baseUrl = baseUrlOf(opts.baseUrl);
  const pageSize = clampPageSize(opts.pageSize);
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const ttlMs = ttlMsOf(opts.ttlMs);
  const key = `${baseUrl}|${pageSize}`;
  const cached = _cache.get(key);

  if (!opts.force && cached && nowMs - cached.at < ttlMs) {
    return cached.payload;
  }

  try {
    const payload = await fetchStepfunEcosystem({
      ...opts,
      baseUrl,
      pageSize,
      nowMs,
      probeArtifacts: opts.probeArtifacts !== false,
    });
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

function clearStepfunCache() {
  _cache.clear();
  _probeCache.clear();
}

module.exports = {
  ECO,
  ASSET_TYPES,
  CATALOG_SERVICE,
  SEARCH_METHOD,
  DOWNLOAD_METHOD,
  serviceUrl,
  searchAssets,
  fetchStepfunEcosystem,
  getStepfunEcosystem,
  clearStepfunCache,
  assetTypeName,
  tarNames,
  skillDirOf,
  probeSkillDir,
  DEFAULT_PAGE_SIZE,
  DEFAULT_TTL_MS,
  PROBE_MAX_BYTES,
};
