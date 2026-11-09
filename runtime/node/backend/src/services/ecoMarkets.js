'use strict';

/**
 * ecoMarkets.js — 外部生态市场编目（delivery/market）的唯一数据源。
 *
 * 编目是静态勘察产物，且不在任何分发面内（pip sdist 与 npm files 均不含
 * delivery/market），装机环境上整个目录可能不存在。所以「数据根三态解析」
 * 与「读不到即降级」是一等公民：缺失一律收敛为可展示的降级载荷，不抛给调用
 * 方、不 500。生态之间按 index 的 eco↔file 配对逐文件装配并用 catalog.eco
 * 复核，A 生态的文件结构上到不了 B 生态的响应里。
 */

const fs = require('fs');
const path = require('path');

const { getAppRoot } = require('../utils/dataHome');

const ENV_ROOT = 'KHY_ECO_MARKET_DIR';
const ENV_TTL_MS = 'KHY_ECO_MARKET_TTL_MS';
const INDEX_FILE = 'index.json';
// 与 extensionMarketplace 的 REGISTRY_CACHE_TTL 同量级：编目按「天」级变动，
// 30 分钟陈旧窗口换掉每次请求的重复磁盘读；env 可覆盖以便运维即时刷新。
const DEFAULT_TTL_MS = 30 * 60 * 1000;

function _str(value) {
  return typeof value === 'string' ? value : '';
}

function _hasIndex(dir) {
  return fs.existsSync(path.join(dir, INDEX_FILE));
}

/**
 * 数据根候选链：env 显式覆盖 → 仓库内 delivery/market → 工作区数据家
 * works/data/khy/eco-markets（装机后人工放入的编目）。全部落空返回空 root，
 * 由 loadEcoMarkets 走降级。env 指向不存在的目录仍然胜出——显式覆盖的故障
 * 必须可见，而不是静默回落到另一份编目。
 */
function resolveRoot(env) {
  const fromEnv = _str(env && env[ENV_ROOT]).trim();
  if (fromEnv) {
    return { root: path.resolve(fromEnv), source: 'env' };
  }
  const appRoot = getAppRoot();
  const repo = path.join(appRoot, 'delivery', 'market');
  if (_hasIndex(repo)) {
    return { root: repo, source: 'repo' };
  }
  const workspace = path.join(appRoot, 'works', 'data', 'khy', 'eco-markets');
  if (_hasIndex(workspace)) {
    return { root: workspace, source: 'works' };
  }
  return { root: '', source: '' };
}

// 外部 JSON 是系统边界：读不动 / 解析失败一律 null，由调用方记 warning 或降级。
function readJson(abs) {
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}

// 拒绝对路径与越界相对路径：索引是数据，file 字段可能指到数据根之外。
function catalogFile(root, rel) {
  if (!root || typeof rel !== 'string' || !rel.trim() || path.isAbsolute(rel)) {
    return null;
  }
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  const inside = abs === base || abs.startsWith(base + path.sep);
  return inside ? abs : null;
}

function normList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item));
}

function normStrings(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => typeof item === 'string' && item.trim() !== '');
}

// 降级文案按 RUNTIME-002：问题 + 识别码 + 修复建议，且必含 env 变量名。
function degradedReason(detail) {
  const problem = _str(detail).trim() || '未解析到编目数据根';
  return (
    `生态市场编目不可用：${problem}（识别码 ${ENV_ROOT}）。` +
    `修复：把 ${ENV_ROOT} 指向含 index.json 与 catalogs/ 的编目根目录，` +
    '或在仓库 delivery/market、works/data/khy/eco-markets 之一放入编目后重试。'
  );
}

function buildDegraded(reason) {
  return { status: 'degraded', ecosystems: [], degraded: _str(reason) };
}

function _buildEcosystem(root, item, warnings) {
  const eco = _str(item && item.eco).trim();
  const file = _str(item && item.file).trim();
  if (!eco || !file) {
    warnings.push(`索引条目缺少 eco/file 字段，已跳过：${JSON.stringify(item)}`);
    return null;
  }
  const abs = catalogFile(root, file);
  if (!abs) {
    warnings.push(`生态 ${eco} 的 file 越界或非法（${file}），已跳过`);
    return null;
  }
  const catalog = readJson(abs);
  if (!catalog || typeof catalog !== 'object') {
    warnings.push(`生态 ${eco} 的编目文件缺失或不是合法 JSON（${file}），已跳过`);
    return null;
  }
  // eco↔file 配对复核：索引说这是 A 的文件里写的却是 B，该条记录整体作废。
  if (catalog.eco !== eco) {
    warnings.push(`生态 ${eco} 与编目文件内的 eco（${catalog.eco}）不一致，已跳过`);
    return null;
  }
  return {
    eco,
    title: _str(item.title).trim() || eco,
    surveyedAt: _str(catalog.surveyedAt),
    marketplaces: normList(catalog.marketplaces),
    entries: normList(catalog.entries),
    blocked: normList(catalog.blocked),
    // uncertainties 与另外三个槽位形状不同：真实编目里是一条条勘察注记
    // （delivery/market/catalogs/*.json 全为字符串数组，实测 6 个生态共 36 条），
    // 视图 EcoMarkets.vue 也按 `{{ u }}` 字符串插值渲染。用 normList 会把整个
    // 「残留风险」块过滤成空数组——视图的 v-if 永不成立，页面静默丢数据。
    uncertainties: normStrings(catalog.uncertainties),
  };
}

/**
 * 按 index.ecosystems 顺序逐文件装配。计数一律由数组长度现算，不信任 index 的
 * entryCount / blockedCount——那是生成时的快照，与文件内容漂移过。
 */
function loadEcoMarkets(options) {
  const root = _str(options && options.root).trim();
  if (!root) {
    return buildDegraded(degradedReason('未解析到编目数据根'));
  }
  const index = readJson(path.join(root, INDEX_FILE));
  if (!index || !Array.isArray(index.ecosystems)) {
    // 带上实际数据根：用户可能同时有仓库内与工作区两份编目，得知道坏的是哪份。
    return buildDegraded(degradedReason(`${INDEX_FILE} 缺失或不是合法 JSON（${root}）`));
  }
  const warnings = [];
  const ecosystems = [];
  for (const item of index.ecosystems) {
    const built = _buildEcosystem(root, item, warnings);
    if (built) {
      ecosystems.push(built);
    }
  }
  const markets = index.markets || {};
  return {
    status: 'ok',
    generatedAt: _str(index.generatedAt),
    ecosystems,
    rules: normStrings(markets.rules),
    licenseGate: _str(markets.licenseGate),
    warnings,
  };
}

const _cache = { key: '', at: 0, payload: null };

function _ttlMs(env) {
  const raw = _str(env && env[ENV_TTL_MS]).trim();
  // 空串 Number() 得 0，会把缓存整个关掉；未设置与设错都回落默认值。
  if (!raw) {
    return DEFAULT_TTL_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TTL_MS;
}

/**
 * 带 TTL 的编目读取入口（路由唯一调用点）。降级载荷不落缓存：数据根修好之后
 * 必须立刻可见，而不是再等一个 TTL。
 */
function getEcoMarkets(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const { root } = resolveRoot(env);
  const ttl = _ttlMs(env);
  const fresh = _cache.payload && _cache.key === root && nowMs - _cache.at < ttl;
  if (fresh) {
    return _cache.payload;
  }
  const payload = loadEcoMarkets({ root });
  if (payload.status !== 'degraded') {
    _cache.key = root;
    _cache.at = nowMs;
    _cache.payload = payload;
  }
  return payload;
}

function findEcoMarket(payload, eco) {
  const list = payload && Array.isArray(payload.ecosystems) ? payload.ecosystems : [];
  const key = _str(eco).trim();
  if (!key) {
    return null;
  }
  return list.find((item) => item && item.eco === key) || null;
}

module.exports = {
  resolveRoot,
  readJson,
  catalogFile,
  normList,
  normStrings,
  buildDegraded,
  degradedReason,
  loadEcoMarkets,
  getEcoMarkets,
  findEcoMarket,
  DEFAULT_TTL_MS,
};
