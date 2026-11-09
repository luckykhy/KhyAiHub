'use strict';

/**
 * marketCatalog.js — the single assembly for every surface that shows the
 * plugin market (terminal, desktop, web).
 *
 * Before this module each surface assembled its own answer: the desktop
 * merged live sources inside the Electron main process, the web route served
 * the static survey only, and the CLI had no marketplace entry at all. The
 * same marketplace therefore reported different ecosystem counts and different
 * freshness depending on where you looked. Assembly lives here once:
 *
 *   static survey (delivery/market) -> khy-market/1 annotation
 *     -> live sources (StepFun / Open VSX / Kimi / MCP Registry)
 *     -> installed annotation (market-installed.json)
 *
 * Every payload carries `fetchedAt`, a per-source `sources` record and `totals`,
 * so a renderer only formats what it is told and cannot invent its own numbers.
 *
 * Two entry points on purpose:
 *   - `assembleEcoMarkets()` awaits the full result (terminal / desktop / tests).
 *   - `getMarketCatalog()` never blocks on the network: it returns the last
 *     snapshot (or a static-only one on first call) and refreshes in the
 *     background. A web page load must not spend 30s waiting for upstreams.
 */

const DEFAULT_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const ENV_SNAPSHOT_TTL_MS = 'KHY_MARKET_SNAPSHOT_TTL_MS';
// Tests and air-gapped installs must not pay for (or depend on) upstream calls.
const ENV_OFFLINE = 'KHY_MARKET_OFFLINE';
// Same page size the desktop pane used; kept here so every surface asks the
// upstreams for the same window.
const LIVE_PAGE_SIZE = 12;

const LIVE_SOURCE_DEFS = Object.freeze([
  {
    id: 'stepfun-openclaw',
    title: '阶跃水产市场',
    modulePath: './marketProtocol/stepfunOpenclaw',
    method: 'getStepfunEcosystem',
    options: { pageSize: LIVE_PAGE_SIZE },
  },
  {
    id: 'open-vsx',
    title: 'VS Code（Open VSX）扩展市场',
    modulePath: './marketProtocol/vscodeMarketplace',
    method: 'getVsCodeEcosystem',
    options: { size: LIVE_PAGE_SIZE },
  },
  {
    id: 'kimi-code',
    title: 'Kimi Code 插件市场',
    modulePath: './marketProtocol/kimiCode',
    method: 'getKimiEcosystem',
    options: {},
  },
  {
    id: 'mcp-registry',
    title: '官方 MCP Registry',
    modulePath: './marketProtocol/mcpRegistry',
    method: 'getMcpRegistryEcosystem',
    options: {},
  },
]);

function _str(value) {
  return typeof value === 'string' ? value : '';
}

function _list(value) {
  return Array.isArray(value) ? value : [];
}

function _errorText(err) {
  return err instanceof Error ? err.message : String(err);
}

function _optionalModule(loader) {
  try {
    return loader();
  } catch {
    return null;
  }
}

function _iso(nowMs) {
  return new Date(nowMs).toISOString();
}

function _counts(ecosystems) {
  let entries = 0;
  let blocked = 0;
  let installed = 0;
  let live = 0;
  for (const market of _list(ecosystems)) {
    const rows = _list(market && market.entries);
    entries += rows.length;
    blocked += _list(market && market.blocked).length;
    installed += rows.filter((entry) => entry && entry.installed).length;
    if (market && market.live) live += 1;
  }
  return { ecosystems: _list(ecosystems).length, entries, blocked, installed, live };
}

function _sourceRecord(def, fields) {
  return {
    id: _str(def.id),
    title: _str(def.title) || _str(def.id),
    kind: _str(fields.kind) || 'live',
    status: _str(fields.status) || 'ok',
    eco: _str(fields.eco),
    entries: Number(fields.entries) || 0,
    blocked: Number(fields.blocked) || 0,
    fetchedAt: _str(fields.fetchedAt),
    message: _str(fields.message),
  };
}

function _liveDefs(options) {
  if (Array.isArray(options && options.liveSources)) return options.liveSources;
  const env = (options && options.env) || process.env;
  const offline = _str(env && env[ENV_OFFLINE]).trim().toLowerCase();
  if (offline === '1' || offline === 'true' || offline === 'yes' || offline === 'on') {
    return [];
  }
  return LIVE_SOURCE_DEFS;
}

async function _runSource(def, ctx) {
  if (typeof def.fetch === 'function') return def.fetch(ctx);
  const mod = def.module || require(def.modulePath);
  const fn = mod && mod[def.method];
  if (typeof fn !== 'function') {
    throw new Error(`模块 ${def.modulePath || def.id} 缺少 ${def.method}`);
  }
  return fn({ force: ctx.force, ...(def.options || {}) });
}

// A live ecosystem replaces any static entry sharing its eco id. Each source is
// independent: one failing endpoint only drops its own tab, with a warning.
function _mergeLive(ecosystems, live) {
  if (!live || typeof live !== 'object' || !live.eco) return ecosystems;
  return [...ecosystems.filter((market) => market && market.eco !== live.eco), live];
}

/**
 * Fast half of assembly: static survey + annotation + installed badges. Never
 * touches the network, so the first web request can paint while the live
 * sources are still being fetched in the background.
 */
function _basePayload(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const ecoMarkets = opts.ecoMarkets || require('./ecoMarkets');
  const protocol =
    opts.protocol === undefined ? _optionalModule(() => require('./marketProtocol')) : opts.protocol;
  const install =
    opts.install === undefined
      ? _optionalModule(() => require('./marketInstallService'))
      : opts.install;

  const base = opts.force
    ? ecoMarkets.loadEcoMarkets({ root: ecoMarkets.resolveRoot(env).root })
    : ecoMarkets.getEcoMarkets({ env });

  const warnings = _list(base.warnings).slice();
  let degraded = _str(base.degraded);
  let ecosystems = _list(base.ecosystems);
  if (protocol) {
    ecosystems = protocol.annotateEcosystems(ecosystems);
  }
  const staticCounts = _counts(ecosystems);

  if (install) {
    try {
      ecosystems = install.annotateInstalled(ecosystems);
    } catch (err) {
      warnings.push(`读取已安装状态失败：${_errorText(err)}`);
    }
  }

  // A live source can outlive a missing static catalog: keep the survey's
  // degraded note as a warning so it stays visible without blanking the pane.
  if (degraded && ecosystems.length > 0) {
    warnings.unshift(degraded);
    degraded = '';
  }

  return {
    status: degraded ? _str(base.status) || 'degraded' : 'ok',
    generatedAt: _str(base.generatedAt),
    ecosystems,
    rules: base.rules,
    licenseGate: base.licenseGate,
    warnings,
    ...(degraded ? { degraded } : {}),
    staticCounts,
  };
}

/**
 * Full assembly, awaiting every live source. Terminal and desktop call this;
 * `force` bypasses both the static catalog TTL and every live-source TTL.
 */
async function assembleEcoMarkets(options) {
  const opts = options || {};
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const env = opts.env || process.env;
  const force = opts.force === true;

  const base = _basePayload({ ...opts, env, force });
  const { staticCounts } = base;
  const payload = { ...base };
  delete payload.staticCounts;

  let ecosystems = payload.ecosystems;
  const warnings = payload.warnings.slice();
  const sources = [
    _sourceRecord(
      { id: 'catalog', title: '静态勘察编目' },
      {
        kind: 'static',
        status: payload.status === 'degraded' ? 'error' : 'ok',
        entries: staticCounts.entries,
        blocked: staticCounts.blocked,
        fetchedAt: payload.generatedAt,
        message: payload.degraded || '',
      }
    ),
  ];

  const results = await Promise.all(
    _liveDefs(opts).map(async (def) => {
      try {
        return { def, live: await _runSource(def, { force, nowMs, env }) };
      } catch (err) {
        return { def, error: _errorText(err) };
      }
    })
  );

  for (const result of results) {
    const def = result.def;
    if (result.error) {
      warnings.push(`${def.title || def.id}未接入：${result.error}`);
      sources.push(
        _sourceRecord(def, { kind: 'live', status: 'error', message: result.error })
      );
      continue;
    }
    const live = result.live;
    if (!live || typeof live !== 'object' || !live.eco) {
      const message = '实时来源返回空载荷';
      warnings.push(`${def.title || def.id}未接入：${message}`);
      sources.push(_sourceRecord(def, { kind: 'live', status: 'error', message }));
      continue;
    }
    ecosystems = _mergeLive(ecosystems, live);
    const stale = live.stale === true;
    const notes = _list(live.uncertainties);
    sources.push(
      _sourceRecord(def, {
        kind: 'live',
        status: stale ? 'stale' : 'ok',
        eco: live.eco,
        entries: _list(live.entries).length,
        blocked: _list(live.blocked).length,
        fetchedAt: _iso(nowMs),
        message: stale ? notes[notes.length - 1] || '' : '',
      })
    );
  }

  payload.ecosystems = ecosystems;
  // Live sources can answer while the static catalog stays missing; that is a
  // warning, not a degraded pane.
  if (payload.degraded && ecosystems.length > 0) {
    warnings.unshift(payload.degraded);
    delete payload.degraded;
    payload.status = 'ok';
  }
  payload.warnings = warnings;
  payload.sources = sources;
  payload.totals = _counts(ecosystems);
  payload.fetchedAt = _iso(nowMs);
  payload.refreshing = false;
  payload.refreshStartedAt = '';
  return payload;
}

const _state = {
  payload: null,
  at: 0,
  key: '',
  running: null,
  startedAt: 0,
  lastError: '',
};

function _snapshotTtlMs(env) {
  const raw = _str(env && env[ENV_SNAPSHOT_TTL_MS]).trim();
  if (!raw) return DEFAULT_SNAPSHOT_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SNAPSHOT_TTL_MS;
}

// The snapshot belongs to one catalog root. A test (or a restart-time env
// change) that points at another root must not be served the previous one.
function _rootKey(options) {
  try {
    const ecoMarkets = (options && options.ecoMarkets) || require('./ecoMarkets');
    const env = (options && options.env) || process.env;
    return _str(ecoMarkets.resolveRoot(env).root);
  } catch {
    return '';
  }
}

function _decorate(payload, nowMs) {
  const refreshing = Boolean(_state.running);
  return {
    ...payload,
    refreshing,
    refreshStartedAt: refreshing ? _iso(_state.startedAt) : '',
    ...(_state.lastError ? { refreshError: _state.lastError } : {}),
  };
}

function _startRefresh(options) {
  if (_state.running) return _state.running;
  const key = _rootKey(options);
  _state.startedAt = Date.now();
  _state.lastError = '';
  _state.running = assembleEcoMarkets({ ...options, force: true })
    .then((payload) => {
      _state.payload = payload;
      _state.at = Date.now();
      _state.key = key;
      return payload;
    })
    .catch((err) => {
      // Keep the previous snapshot on screen; report why it is not newer.
      _state.lastError = _errorText(err);
      return null;
    })
    .finally(() => {
      _state.running = null;
    });
  return _state.running;
}

// Static-only payload. Used as the first paint while live sources are in
// flight, and as the final answer when live fetching is disabled.
function _staticSnapshot(options, refreshing, startedAt) {
  const opts = options || {};
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const env = opts.env || process.env;
  const base = _basePayload({ ...opts, env, force: false });
  const { staticCounts } = base;
  const payload = { ...base };
  delete payload.staticCounts;
  payload.sources = [
    _sourceRecord(
      { id: 'catalog', title: '静态勘察编目' },
      {
        kind: 'static',
        status: payload.status === 'degraded' ? 'error' : 'ok',
        entries: staticCounts.entries,
        blocked: staticCounts.blocked,
        fetchedAt: payload.generatedAt,
        message: payload.degraded || '',
      }
    ),
    ..._liveDefs({ ...opts, env }).map((def) =>
      _sourceRecord(def, {
        kind: 'live',
        status: refreshing ? 'pending' : 'off',
        message: refreshing ? '正在拉取' : '实时来源已关闭',
      })
    ),
  ];
  payload.totals = _counts(payload.ecosystems);
  payload.fetchedAt = refreshing ? '' : _iso(nowMs);
  payload.refreshing = refreshing;
  payload.refreshStartedAt = refreshing ? _iso(startedAt || nowMs) : '';
  return payload;
}

/**
 * Snapshot for request/response surfaces: returns immediately, refreshes in the
 * background when stale (or on the first call). `force` asks for a refresh but
 * still does not block — the caller polls `refreshing` until it turns false.
 */
function getMarketCatalog(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const ttl = _snapshotTtlMs(env);
  const force = opts.force === true;
  const key = _rootKey({ ...opts, env });

  if (_state.payload && _state.key !== key) {
    _state.payload = null;
    _state.at = 0;
  }

  // No live sources (offline/test mode): assemble the static view right here so
  // the response is complete on the first call instead of "pending".
  if (_liveDefs({ ...opts, env }).length === 0) {
    const fresh = _state.payload && nowMs - _state.at < ttl;
    if (!fresh || force) {
      const payload = _staticSnapshot({ ...opts, env, nowMs }, false, 0);
      _state.payload = payload;
      _state.at = nowMs;
      _state.key = key;
    }
    return _decorate(_state.payload, nowMs);
  }

  const fresh = _state.payload && nowMs - _state.at < ttl;
  if (!fresh || force) {
    _startRefresh({ ...opts, env });
  }
  if (!_state.payload) {
    return _staticSnapshot({ ...opts, env, nowMs }, true, _state.startedAt);
  }
  return _decorate(_state.payload, nowMs);
}

function clearMarketSnapshot() {
  _state.payload = null;
  _state.at = 0;
  _state.key = '';
  _state.running = null;
  _state.startedAt = 0;
  _state.lastError = '';
}

module.exports = {
  DEFAULT_SNAPSHOT_TTL_MS,
  ENV_SNAPSHOT_TTL_MS,
  ENV_OFFLINE,
  LIVE_SOURCE_DEFS,
  assembleEcoMarkets,
  getMarketCatalog,
  clearMarketSnapshot,
};
