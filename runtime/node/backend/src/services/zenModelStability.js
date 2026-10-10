'use strict';

/**
 * zenModelStability — Zen 免费模型的「抖动评分」账本。
 *
 * 为什么需要（用户实测 2026-10-09，存证 works/data/khy/feedback/upstream-truth-label-20261009/）：
 *   step-5-preview-free 在同一天里 429「Endpoint is unavailable」与 200 交替出现，
 *   而 mimo-v2.6-flash-free 稳定。用户**选之前**对这件事零知情——选中了才知道抖。
 *   废弃账本（zenRetiredModels）管的是「永久没了」，抖动是另一回事：不能因 429 就
 *   把模型藏起来，但应该把「近期失败率」端到选型面上。
 *
 * 落盘：<dataHome>/zen_model_stability.json，形态
 *   { "<modelId>": { "outcomes": [ { ok: true|false, at: <ms> }, … ] } }
 *   每模型只留最近 MAX_OUTCOMES 条（滚动窗口），账本不无限增长。
 *
 * 冷启动无样本 → classify 返回 null，列表不打标、不误报。
 * 零成本换来的收益：只增一条同步小 JSON 写盘，fail-soft（写失败不影响调用）。
 */

const fs = require('fs');
const path = require('path');

const { getDataHome, getLegacyDataHome } = require('../utils/dataHome');

const _OFF = new Set(['0', 'false', 'off', 'no']);

/** 门控 KHY_ZEN_MODEL_STABILITY：默认开；0/false/off/no → 关（读写全停）。 */
function isEnabled(env = process.env) {
  const v = String((env && env.KHY_ZEN_MODEL_STABILITY) || '')
    .trim()
    .toLowerCase();
  return !_OFF.has(v);
}

/** 每模型滚动窗口大小：只看最近 N 次调用结果。 */
const MAX_OUTCOMES = 30;

/** 观测窗口：窗口外的样本不参与判级。 */
const WINDOW_MS = 24 * 60 * 60 * 1000;

/** 判级的样本下限：低于它一律 insufficient（不打标），宁可无标记不误报。 */
const MIN_SAMPLES = 5;

/** 抖动阈值：窗口内失败率 ≥ 它判 flappy。 */
const FLAPPY_FAIL_RATE = 0.3;

let _cache = null;
let _cacheMtimeMs = -1;

function _file() {
  const override = process.env.KHY_ZEN_STABILITY_FILE;
  if (override && String(override).trim()) {
    return String(override).trim();
  }
  try {
    return path.join(getDataHome(), 'zen_model_stability.json');
  } catch {
    return path.join(getLegacyDataHome(), 'zen_model_stability.json');
  }
}

function _norm(id) {
  return String(id == null ? '' : id).trim().toLowerCase();
}

/** 读账本带 mtime 复查（多进程共写，纯内存缓存会让别的进程的记录不可见）。 */
function _read() {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(_file()).mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  if (_cache && _cacheMtimeMs === mtimeMs) {
    return _cache;
  }
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(_file(), 'utf8'));
  } catch {
    parsed = {};
  }
  _cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  _cacheMtimeMs = mtimeMs;
  return _cache;
}

function _write(state) {
  _cache = state;
  _cacheMtimeMs = 0;
  try {
    const file = _file();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch {
    /* 记不上账只意味着少一个样本，不值得让调用失败 */
  }
}

function _pruneOutcomes(outcomes, now) {
  return outcomes
    .filter((o) => o && Number(o.at || 0) > 0 && now - Number(o.at) <= WINDOW_MS)
    .slice(-MAX_OUTCOMES);
}

/**
 * 记一次调用结果。ok=false 时带可选 meta（errorType/statusCode）只进 detail 字段，
 * 不参与判级——判级只看 ok/at（分类语义见 failureReasonRanking，那边管「哪条失败新鲜」）。
 * @param {string} modelId
 * @param {boolean} ok
 * @param {object} [opts] { env, errorType, statusCode }
 */
function recordOutcome(modelId, ok, opts = {}) {
  try {
    if (!isEnabled(opts.env)) {
      return;
    }
    const key = _norm(modelId);
    if (!key) {
      return;
    }
    const state = _read();
    const rec = state[key] && Array.isArray(state[key].outcomes) ? state[key] : { outcomes: [] };
    rec.outcomes.push({ ok: !!ok, at: Date.now() });
    // 先推再剪（不是先剪再推）：保证落盘条数封顶在 MAX_OUTCOMES，窗口不越界。
    rec.outcomes = _pruneOutcomes(rec.outcomes, Date.now());
    if (!ok && opts.errorType) {
      rec.lastErrorType = String(opts.errorType).slice(0, 60);
    }
    if (!ok && Number(opts.statusCode) > 0) {
      rec.lastStatusCode = Number(opts.statusCode);
    }
    state[key] = rec;
    _write(state);
  } catch {
    /* fail-soft */
  }
}

/**
 * 该模型的近期稳定度。样本不足 / 门关 → null（调用方不打标）。
 * @param {string} modelId
 * @param {object} [opts] { env }
 * @returns {{tier:'stable'|'flappy', label:string, failRate:number, samples:number}|null}
 */
function classify(modelId, opts = {}) {
  try {
    if (!isEnabled(opts.env)) {
      return null;
    }
    const key = _norm(modelId);
    if (!key) {
      return null;
    }
    const rec = _read()[key];
    if (!rec || !Array.isArray(rec.outcomes)) {
      return null;
    }
    const now = Date.now();
    const outcomes = _pruneOutcomes(rec.outcomes, now);
    if (outcomes.length < MIN_SAMPLES) {
      return null;
    }
    const fails = outcomes.filter((o) => !o.ok).length;
    const failRate = fails / outcomes.length;
    if (failRate >= FLAPPY_FAIL_RATE) {
      return {
        tier: 'flappy',
        label: `近期失败 ${fails}/${outcomes.length}（抖动）`,
        failRate,
        samples: outcomes.length,
      };
    }
    return {
      tier: 'stable',
      label: `近期 ${outcomes.length} 次稳定`,
      failRate,
      samples: outcomes.length,
    };
  } catch {
    return null;
  }
}

/**
 * 从账本里挑一个当前最稳的替代模型（排除 excludeId）：先筛 stable，再按样本多、
 * 失败率低排序取第一。无可判级项 / 门关 → null（调用方不给替代建议，不硬塞）。
 * @param {string} excludeId
 * @param {object} [opts] { env }
 * @returns {string|null}
 */
function suggestStableAlternative(excludeId, opts = {}) {
  try {
    if (!isEnabled(opts.env)) {
      return null;
    }
    const skip = _norm(excludeId);
    const state = _read();
    const cands = [];
    for (const [id, rec] of Object.entries(state)) {
      if (id === skip || !rec || !Array.isArray(rec.outcomes)) {
        continue;
      }
      const d = classify(id, opts);
      if (d && d.tier === 'stable') {
        cands.push({ id, samples: d.samples, failRate: d.failRate });
      }
    }
    if (cands.length === 0) {
      return null;
    }
    cands.sort((a, b) => b.samples - a.samples || a.failRate - b.failRate);
    return cands[0].id;
  } catch {
    return null;
  }
}

/** 清空内存态（落盘文件不动）。测试与人工复位用。 */
function _reset() {
  _cache = null;
  _cacheMtimeMs = -1;
}

module.exports = {
  MAX_OUTCOMES,
  WINDOW_MS,
  MIN_SAMPLES,
  FLAPPY_FAIL_RATE,
  isEnabled,
  recordOutcome,
  classify,
  suggestStableAlternative,
  _file,
  _reset,
};
