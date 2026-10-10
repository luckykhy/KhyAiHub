'use strict';

/**
 * zenRetiredModels — Zen 目录里「已宣告不可用」的模型 id 账本。
 *
 * 为什么需要（用户实测 2026-10-09，存证 works/data/feedback/zen-model-list-refresh/）：
 *   apiAdapter.listModels() 已经每次直连远端 /v1/models 自动刷新，但上游**目录本身**
 *   仍挂着已废弃的 id —— `exo-free` 调用返回 410 ModelDeprecated，`mimo-v2.5-free` /
 *   `deepseek-v4-flash-free` 返回 401 not supported，`muse-spark-*-contributor-free`
 *   返回 403 RegionError（按地区封锁，换模型无用）。zenGatekeeper.isFreeZenModelId()
 *   只判 `-free` 后缀，于是这些 id 一路无损送到选型器，用户选中后才在调用时炸。
 *   「刷新」解决不了：刷新只能反映上游目录，而目录自己就不干净。
 *
 * 因此分两路（都不额外消耗 per-IP 配额）：
 *   1. 本文件的静态废弃名单 —— 兜底已知废弃项，零请求。
 *   2. markRetired() —— 调用侧真撞上 410/401 ModelError 时就地补录（见 zenRetiredModels
 *      的 recordFromUpstreamError），下次列表刷新即自动消失，即「用过一次就自愈」。
 *
 * 落盘：<dataHome>/zen_retired_models.json，形态 { "<id>": { reason, at, source } }。
 *   与 custom_providers.json 分家：那份是用户/provider 元数据，这份是上游事实的观测账本，
 *   两者生命周期不同（前者用户维护，后者只增不减直到人工清理）。
 */

const fs = require('fs');
const path = require('path');

const { getDataHome, getLegacyDataHome } = require('../utils/dataHome');

/**
 * 已知废弃/永久不可用的 Zen id。
 *
 * reason 取值决定它是否**可自愈**：
 *   'deprecated'  上游明文宣告下线（410 ModelDeprecated）—— 永久，换任何网络/节点都不会回来。
 *   'unsupported' 目录挂着但上游拒绝（401 ModelError not supported）—— 永久。
 *   'unavailable' 上游自述不可用（400 Upstream: Model is unavailable）—— 可能是暂时的，
 *                  故 TTL 短一些，让它有机会自动回到列表。
 *   'region'      地区封锁（403 RegionError）—— **不因地区变化自愈**，但换出口 IP 可能解开，
 *                  故同样给短 TTL，让换节点成为一条真实的自愈路径。
 *
 * 全部为 2026-10-09 对 opencode.ai/zen/v1 实测所得；非实测项不写入本表。
 */
// 静态名单用日期字面量便于人读；转成时间戳再入库，因为临时项的 TTL 判定吃的是时间戳。
const _PROBED_AT = Date.parse('2026-10-09T00:00:00Z');

const BUILTIN_RETIRED = Object.freeze({
  'exo-free': { reason: 'deprecated', at: _PROBED_AT },
  'mimo-v2.5-free': { reason: 'unsupported', at: _PROBED_AT },
  'deepseek-v4-flash-free': { reason: 'unsupported', at: _PROBED_AT },
  'muse-spark-1.2-contributor-free': { reason: 'region', at: _PROBED_AT },
  'muse-spark-1.3-contributor-free': { reason: 'region', at: _PROBED_AT },
  'ling-3.0-flash-fin-free': { reason: 'unavailable', at: _PROBED_AT },
});

/** 永久性废弃：无论过多久都不该回到列表。 */
const PERMANENT_REASONS = new Set(['deprecated', 'unsupported']);

/** 暂时性废弃的复检窗口。过了就放回列表，让上游有机会翻案。 */
const TRANSIENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let _cache = null;
let _cacheFile = null;
let _cacheMtimeMs = -1;

function _file() {
  // env 覆盖优先（对齐 toolCapabilityStore 的 KHY_TOOL_CAP_FILE 约定），测试与人工复位用。
  const override = process.env.KHY_ZEN_RETIRED_FILE;
  if (override && String(override).trim()) {
    return String(override).trim();
  }
  if (_cacheFile) {
    return _cacheFile;
  }
  try {
    _cacheFile = path.join(getDataHome(), 'zen_retired_models.json');
  } catch {
    _cacheFile = path.join(getLegacyDataHome(), 'zen_retired_models.json');
  }
  return _cacheFile;
}

function _norm(id) {
  return String(id == null ? '' : id).trim().toLowerCase();
}

function _isRetired(record) {
  if (!record) {
    return false;
  }
  const reason = String(record.reason || '').trim().toLowerCase();
  if (PERMANENT_REASONS.has(reason)) {
    return true;
  }
  const at = Number(record.at || 0);
  if (!at || !Number.isFinite(at)) {
    // 无时间戳的临时项：宁可保守放回列表，由真实调用再淘汰一次。
    return false;
  }
  return Date.now() - at <= TRANSIENT_TTL_MS;
}

function _read() {
  return _readFresh();
}

function _write(state) {
  _cache = state;
  _cacheMtimeMs = 0; // 强制下次 _readFresh 重新 stat，避免与新文件的 mtime 竞合
  try {
    const file = _file();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch {
    /* 账本丢一次只意味着下次多一个坏 id，不值得因此让调用失败 */
  }
}

/**
 * 该 id 是否应从列表中剔除。查静态名单 + 落盘账本（含 TTL 判定）。
 * @param {*} id
 * @returns {boolean}
 */
function isRetired(id) {
  const key = _norm(id);
  if (!key) {
    return false;
  }
  if (_isRetired(BUILTIN_RETIRED[key])) {
    return true;
  }
  try {
    return _isRetired(_read()[key]);
  } catch {
    return false;
  }
}

/**
 * 读账本，带 mtime 复查：常驻进程（网关 / 桌面端宿主）生命周期可能远长于账本被写入的
 * 时刻，纯内存缓存会让别的进程补录的条目在本进程内永远不可见。
 */
function _readFresh() {
  const file = _file();
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  if (_cache && _cacheMtimeMs === mtimeMs) {
    return _cache;
  }
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    parsed = {};
  }
  _cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  _cacheMtimeMs = mtimeMs;
  return _cache;
}

/**
 * 记一条废弃事实。永久原因（deprecated/unsupported）即刻生效；
 * 临时原因（unavailable/region）带 TTL，过期自动放回列表。
 * @param {string} id
 * @param {{reason?: string, detail?: string}} [meta]
 */
function markRetired(id, meta = {}) {
  const key = _norm(id);
  if (!key) {
    return;
  }
  const reason = String(meta.reason || 'unavailable')
    .trim()
    .toLowerCase();
  try {
    const state = _read();
    state[key] = {
      reason,
      at: Date.now(),
      detail: String(meta.detail || '').slice(0, 300),
    };
    _write(state);
  } catch {
    /* 同上：记不上账不该让调用失败 */
  }
}

/**
 * 清掉过期的临时废弃项（永久项不动）。
 *
 * 顺带修剪过长的账本：永久项无限增长没有意义（上游目录总共几十条），而它们已由
 * BUILTIN_RETIRED 或调用反馈覆盖，按 id 去重后只保留最近 MAX_LEDGER_ENTRIES 条。
 */
const MAX_LEDGER_ENTRIES = 200;

function pruneExpired() {
  let removed = 0;
  try {
    const state = _read();
    for (const [key, record] of Object.entries(state)) {
      if (!_isRetired(record)) {
        delete state[key];
        removed += 1;
      }
    }
    const keys = Object.keys(state);
    if (keys.length > MAX_LEDGER_ENTRIES) {
      keys
        .sort((a, b) => Number(state[b].at || 0) - Number(state[a].at || 0))
        .slice(MAX_LEDGER_ENTRIES)
        .forEach((key) => {
          delete state[key];
          removed += 1;
        });
    }
    if (removed > 0) {
      _write(state);
    }
  } catch {
    /* ignore */
  }
  return removed;
}

/** 清空内存态（静态名单不受影响）。测试与人工复位用。 */
function _reset() {
  _cache = null;
  _cacheFile = null;
  _cacheMtimeMs = -1;
}

/**
 * 从一次上游失败里认出「这个模型永久没了」。
 *
 * 只认**上游明文宣告**的两类，避免把配额/网络抖动误判成模型下线（那正是本次事故
 * 之前 403 频发时被误诊为「模型不存在」的老毛病）：
 *   - `ModelDeprecated` / `has been deprecated` → deprecated
 *   - `is not supported` → unsupported
 * 状态码只当准入（401/404/410），**不参与定性**：410 也可能来自网关侧或配额窗口，
 * 只凭状态码就记永久废弃会把暂时故障焊死。宁可漏记（下次列表刷新再撞一次），
 * 不可误记（模型被永久藏起来）。
 * 明确**不**认：403（既可能是地区封锁，也可能是免费层 gate 未过或配额耗尽）、
 * 429、5xx、超时 —— 这些都不构成「模型已下线」的证据。
 *
 * @param {*} status   HTTP 状态码（仅作准入）
 * @param {*} body     响应体（对象或 JSON 串；流式分支由调用方负责取回）
 * @param {string} modelId
 * @returns {{id: string, reason: string, detail: string}|null} 命中则返回应记的条目
 */
function recordFromUpstreamError(status, body, modelId) {
  const code = Number(status) || 0;
  if (code !== 410 && code !== 401 && code !== 404) {
    return null;
  }
  let text = '';
  let type = '';
  let message = '';
  try {
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const err = parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed;
    type = String(err.type || '');
    message = String(err.message || '');
  } catch {
    return null;
  }
  text = `${type} ${message}`;
  // 状态码只做**准入**，判定一律看上游明文：410 也可能来自网关侧/配额窗口而非模型下线，
  // 只凭状态码记永久废弃会把暂时故障焊死，正是本模块要避免的那类误诊。
  if (!/modeldeprecated|has been deprecated/i.test(text)) {
    if (!/\bis not supported\b/i.test(text)) {
      return null;
    }
  }
  const isDeprecated = /modeldeprecated|has been deprecated/i.test(text);
  const id = _norm(modelId);
  if (!id) {
    return null;
  }
  return {
    id,
    reason: isDeprecated ? 'deprecated' : 'unsupported',
    detail: `${code} ${type} ${message}`.trim().slice(0, 300),
  };
}

module.exports = {
  BUILTIN_RETIRED,
  TRANSIENT_TTL_MS,
  isRetired,
  markRetired,
  pruneExpired,
  recordFromUpstreamError,
  _file,
  _reset,
};