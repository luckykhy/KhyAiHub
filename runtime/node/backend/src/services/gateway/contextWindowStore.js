'use strict';

/**
 * contextWindowStore.js — 「我们测出来的模型上下文窗口」的跨重启记忆。
 *
 * 抄的是 toolCapabilityStore 的骨架（惰性读盘 / 原子 temp→rename 落盘 / 幂等守卫 /
 * 键规范化 / 容量上限），但**方向规则相反**，这是本文件与它最本质的差别：
 *
 *   toolCapabilityStore：只晋升不降级 —— 「确证支持工具」不能被「这次没看到」推翻
 *                        （toolCapabilityStore.js:280-288 存储层硬拒）。
 *   本文件：            **双向修正**。用户诉求就是「开始给小了，发现能更大要更新；
 *                        开始给大了，发现更小要改小」。而下调信号不是「这次没看到」，
 *                        是上游在 400 里**报出了自己的真实限制**
 *                        （"maximum context length is 128000"），那是比探测更硬的证据。
 *
 * 来源分两类，决定谁能覆盖谁 —— 这是 `_setContextWindowCache` 裸 Map.set 不提供、
 * 必须在存储层建立的那道优先级：
 *
 *   已验证(可双向覆盖)：probe / error-extract / listModels / generate-response
 *                       —— 都来自上游的亲口答复或端点元数据。
 *   标称(只填缺失)    ：free-catalog —— models.dev 的登记值，可能虚高（如 glm-5.2 标
 *                       1M 而某网关只给 200K）。绝不覆盖已学到的实测值。
 *
 * 静态表（constants/modelContextWindows.js）在本 store 之下：学到的值无论大小都
 * 压过静态表。这样「一开始保守给小了」会在第一次实测后自动变大，「一开始乐观给大了」
 * 会在第一次 400 后自动变小，且下一次重启就用实测值。
 */

const fs = require('fs');
const path = require('path');

const { getDataDir } = require('../../utils/dataHome');
const { capabilityModelKey } = require('./capabilityModelKey');
const { MAX_PLAUSIBLE_CONTEXT_WINDOW } = require('../../constants/contextWindowDefaults');

const SCHEMA_VERSION = 1;
const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 学到的窗口是模型的稳定属性，三个月足够长寿
const DEFAULT_MAX_ENTRIES = 500; // 与 _contextWindowCache 的 500 上限对齐

/** 上游亲口答复或端点元数据 → 允许双向覆盖（含把偏大的错值改小）。 */
const VERIFIED_SOURCES = new Set(['probe', 'error-extract', 'listModels', 'generate-response']);
/** 第三方登记值 → 只填缺失，绝不覆盖已学到的实测值。 */
const NOMINAL_SOURCES = new Set(['free-catalog']);

let _cache = null;
let _cacheLoaded = false;

function _off(env = process.env) {
  const v = env && env.KHY_CONTEXT_WINDOW_LEARNED;
  if (v === undefined || v === null || String(v).trim() === '') return false;
  return /^(0|false|off|no)$/i.test(String(v).trim());
}

function _num(env, name, dflt) {
  const n = Number(env && env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

function _storeFile(env = process.env) {
  const override = env && env.KHY_CONTEXT_WINDOW_LEARNED_FILE;
  if (override && String(override).trim()) {
    return String(override).trim();
  }
  // 与 routeLatencyStore / runtimeDiagnosticsStore 同家（网关运行态），不用
  // getBaseHome()：那侧是底座的七个写入方，白名单外的模块塞进去会破生态红线。
  return path.join(getDataDir('gateway'), 'context_window.json');
}

function _normalizeValue(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > MAX_PLAUSIBLE_CONTEXT_WINDOW ? MAX_PLAUSIBLE_CONTEXT_WINDOW : n;
}

/**
 * 本 store 自己的入参门槛：model id 必须是**非空字符串**。
 *
 * `capabilityModelKey` 内部是 `String(...)` 强制的，那对路由身份解析是对的（它要吃
 * 各种写法的串），但直接拿来当持久化键会把 `{}` 变成 `'[object object]'` 这种垃圾键
 * 写进磁盘，且永不命中、白占容量。仓内模型 id 一律是串，故在此收紧。
 */
function _modelKey(model) {
  if (typeof model !== 'string') return '';
  return capabilityModelKey(model);
}

function _ttlMs(env = process.env) {
  return _num(env, 'KHY_CONTEXT_WINDOW_LEARNED_TTL_MS', DEFAULT_TTL_MS);
}

function _maxEntries(env = process.env) {
  return _num(env, 'KHY_CONTEXT_WINDOW_LEARNED_MAX_ENTRIES', DEFAULT_MAX_ENTRIES);
}

function _load(env = process.env) {
  if (_cacheLoaded && _cache) {
    return _cache;
  }
  _cacheLoaded = true;
  if (_off(env)) {
    _cache = { version: SCHEMA_VERSION, entries: {} };
    return _cache;
  }
  try {
    const raw = fs.readFileSync(_storeFile(env), 'utf-8');
    const parsed = JSON.parse(raw);
    const entries = {};
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      for (const [rawKey, rec] of Object.entries(parsed.entries)) {
        const key = _modelKey(rawKey);
        const value = _normalizeValue(rec && rec.value);
        if (!key || value <= 0) continue;
        // 同一裸 id 出现多次时取更新的那条（键规范化可能把两个写法折叠成一个）
        const prev = entries[key];
        if (prev && Number(prev.measuredAt) >= Number(rec.measuredAt || 0)) continue;
        entries[key] = {
          value,
          source: String((rec && rec.source) || 'unknown'),
          measuredAt: Number(rec && rec.measuredAt) || 0,
        };
      }
    }
    _cache = { version: SCHEMA_VERSION, entries };
  } catch {
    _cache = { version: SCHEMA_VERSION, entries: {} };
  }
  return _cache;
}

function _save(state, env = process.env) {
  _cache = state;
  _cacheLoaded = true;
  const file = _storeFile(env);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch {
    /* best effort — 热路径绝不因磁盘失败而抛 */
  }
}

/** 容量上限：超了按 measuredAt 淘汰最旧的（与 _contextWindowCache 的 500 上限同量级）。 */
function _prune(state, env = process.env) {
  const cap = _maxEntries(env);
  const keys = Object.keys(state.entries);
  if (keys.length <= cap) return false;
  keys.sort((a, b) => (state.entries[a].measuredAt || 0) - (state.entries[b].measuredAt || 0));
  for (const k of keys.slice(0, keys.length - cap)) {
    delete state.entries[k];
  }
  return true;
}

/**
 * 取出某模型学到的窗口。无记录 / 键无法规范化 / 开关关闭 → 0（调用方据此回落）。
 *
 * 过期记录**照样返回**：一个三个月前的实测值也比「猜一个 128000」可靠。过期只影响
 * 是否重新探测（网关的 TTL 机制会把它标成待刷新），不影响这一次的取值。
 * @param {string} model
 * @param {Record<string,string>} [env]
 * @returns {number} token 数；无记录 → 0
 */
function getLearnedContextWindow(model, env = process.env) {
  try {
    if (_off(env)) return 0;
    const key = _modelKey(model);
    if (!key) return 0;
    const rec = _load(env).entries[key];
    return rec ? rec.value : 0;
  } catch {
    return 0;
  }
}

/**
 * 记一次学到的窗口。
 *
 * 覆盖规则（存储层强制，不靠调用点自觉）：
 *   - VERIFIED 来源 → 无条件覆盖，**包括把偏大的错值改小**。用户诉求即此。
 *   - NOMINAL 来源（free-catalog）→ 仅在无记录时写入。models.dev 标称 1M 不许压掉
 *     实测到的 200K，否则每次启动目录一热就把真值冲掉。
 *   - 值未变 → 跳过落盘（幂等守卫，避免每轮请求都写盘）。
 * @returns {boolean} 是否真的改了并落盘
 */
function recordLearnedContextWindow(model, value, opts = {}, env = process.env) {
  try {
    if (_off(env)) return false;
    const key = _modelKey(model);
    const next = _normalizeValue(value);
    if (!key || next <= 0) return false;

    const source = String(opts.source || 'unknown');
    const state = _load(env);
    const prev = state.entries[key];
    if (prev) {
      if (!VERIFIED_SOURCES.has(source) && NOMINAL_SOURCES.has(source)) {
        return false; // 标称值只填缺失
      }
      if (prev.value === next) {
        return false; // 幂等：值没变就别写盘
      }
    }
    state.entries[key] = { value: next, source, measuredAt: Date.now() };
    _prune(state, env);
    _save(state, env);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读出全部学到的记录，供网关在构造期一次性播种 TTL 缓存。
 * @returns {Array<{model: string, value: number, source: string, measuredAt: number}>}
 */
function listLearnedContextWindows(env = process.env) {
  try {
    if (_off(env)) return [];
    const ttl = _ttlMs(env);
    const now = Date.now();
    const out = [];
    for (const [model, rec] of Object.entries(_load(env).entries)) {
      const age = now - (Number(rec.measuredAt) || 0);
      // 负龄（机器时间被往回调）按 0 处理，不因时钟倒拨就丢掉记忆
      const remaining = ttl - Math.max(0, age);
      out.push({
        model,
        value: rec.value,
        source: rec.source,
        measuredAt: rec.measuredAt,
        // 负数 = 已陈旧。getModelContextWindow 对已过期条目返回旧值并后台刷新，
        // 正是我们要的「记忆仍然生效，但顺便重新确认一遍」。
        ttlMs: remaining > 0 ? remaining : 1,
        stale: remaining <= 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function _resetCache() {
  _cache = null;
  _cacheLoaded = false;
}

module.exports = {
  getLearnedContextWindow,
  recordLearnedContextWindow,
  listLearnedContextWindows,
  VERIFIED_SOURCES,
  NOMINAL_SOURCES,
  _storeFile,
  _resetCache,
};
