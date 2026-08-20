'use strict';

/**
 * modelHealthLedger — 纯叶子:(adapter, model) 粒度的健康账本记分逻辑,零 IO、确定性、绝不抛。
 *
 * 背景(为什么存在):见 [DESIGN-ARCH-162] §2 根因链。既有 fast-fail 冷却按 adapter 键控,
 *   而 model_not_found 是**模型级**错误 → 一个坏默认模型毒化整渠道(E5)、auto 每轮撞同一个
 *   坏模型(E1+E2+E6)。本叶子把「哪个模型真的坏了、哪个只是暂时抖动」记成独立于渠道冷却的
 *   第二本账,供 autoModelRouting(IO 壳)消费。设计红线:transient 一次绝不拉黑(误报即灼伤),
 *   permanent 只标不删、到期走探活复活,不自动解禁。
 *
 * 契约(与全仓纯叶子一致):
 *   - 零 IO:不碰 fs/网络/子进程;时钟由调用方经 `at` 传入(保持确定性可测)。
 *     仅经 flagRegistry/env 参数读门控 KHY_AUTO_MODEL_HEALTH_AWARE。
 *   - 确定性:同输入恒同输出;record 返回**新**账本(浅拷贝 touched key),不改入参。
 *   - 绝不抛:任何异常路径返回安全值(''/null/'ignore'/原样账本)。
 *   - 门关(isEnabled=false)时 IO 壳整体短路,本叶子不被调用也无副作用。
 */

const modelNotFoundRecovery = require('./modelNotFoundRecovery');

const _FALSY = new Set(['0', 'false', 'off', 'no']); // CANON off-words

function isEnabled(env = process.env) {
  // flagRegistry 优先(集中真源),失败/不可用再退本地 CANON 解析。绝不抛。
  try {
    return require('../flagRegistry').isFlagEnabled(
      'KHY_AUTO_MODEL_HEALTH_AWARE',
      env || process.env
    );
  } catch {
    /* fall through to local */
  }
  try {
    const raw = (env || process.env).KHY_AUTO_MODEL_HEALTH_AWARE;
    const v = String(raw === undefined || raw === null ? 'true' : raw)
      .trim()
      .toLowerCase();
    return !_FALSY.has(v);
  } catch {
    return true;
  }
}

// ── 默认配置(毫秒/次数;均可被 IO 壳经 cfg 覆盖,env 解析在壳侧做)─────────────
const DEFAULT_CFG = Object.freeze({
  brokenTtlMs: 30 * 60 * 1000, // permanent 拉黑时长,到期转 probe-due(不自动解禁)
  transientWindowMs: 60 * 1000, // transient 计 strikes 的滑动窗口
  transientStrikes: 3, // 窗口内第 3 次 transient 失败才短暂 trip(一次 429 绝不影响可选)
  transientCooldownMs: 60 * 1000, // trip 后的短冷却(到期自动回 ok,无需探活)
  channelExhaustedRounds: 3, // 同一模型连续 N 轮 broken→探活失败,IO 壳据此降权整渠道
});

// transient 类 errorType 白名单(与 gatewayErrorClassifier 的产出词对齐);命中才记分。
const _TRANSIENT_TYPES = new Set([
  'rate_limit',
  'timeout',
  'network',
  'server_error',
  'unavailable',
  'overloaded',
]);

/**
 * 把一次失败分类为 permanent / transient / ignore。
 * permanent:model_not_found(含消息文本回退判定,复用 modelNotFoundRecovery 单一真源)。
 * transient:errorType 命中白名单。
 * ignore:其余一切(auth/bad_request/cancelled/unknown…)——**保守不记**,
 *   S1 观察期宁可少记也不制造假拉黑。
 * @returns {'permanent'|'transient'|'ignore'} 绝不抛。
 */
function classifyFailure(errorType, message) {
  try {
    if (modelNotFoundRecovery.isModelNotFound(errorType, message)) {
      return 'permanent';
    }
    const t = String(errorType || '')
      .trim()
      .toLowerCase();
    if (_TRANSIENT_TYPES.has(t)) {
      return 'transient';
    }
    return 'ignore';
  } catch {
    return 'ignore';
  }
}

/** 账本 key:`<adapter>|<model>`(小写 trim);任一缺失 → ''(调用方据此跳过)。绝不抛。 */
function keyOf(adapter, model) {
  try {
    const a = String(adapter || '')
      .trim()
      .toLowerCase();
    const m = String(model || '')
      .trim()
      .toLowerCase();
    if (!a || !m) {
      return '';
    }
    return `${a}|${m}`;
  } catch {
    return '';
  }
}

/** 空账本。entries: { [key]: { kind, errorType?, at, until, rounds, hits? } } */
function newLedger() {
  return { entries: {} };
}

function _cfg(overrides) {
  const src = overrides && typeof overrides === 'object' ? overrides : {};
  const out = {};
  for (const k of Object.keys(DEFAULT_CFG)) {
    const v = Number(src[k]);
    out[k] = Number.isFinite(v) && v >= 0 ? v : DEFAULT_CFG[k];
  }
  return out;
}

/**
 * 记一次结果,返回新账本(不改入参)。
 * ev = { adapter, model, outcome: 'success'|'failure', errorType?, message?, at }
 * 语义:
 *   success            → 清该 key(含 broken——上游突然又通了要能立刻恢复信任)。
 *   failure/permanent  → kind='broken', until=at+brokenTtlMs, rounds 进位(探活失败轮次)。
 *   failure/transient  → 滑动窗口计 strikes;达 transientStrikes → kind='tripped'
 *                        (短冷却);未达 → 只留 hits 不改 kind。
 *   failure/ignore     → 原样返回。
 * 绝不抛:任何异常返回原账本。
 */
function recordOutcome(ledger, ev, cfg, env = process.env) {
  try {
    if (!isEnabled(env)) {
      return ledger;
    }
    if (!ledger || typeof ledger !== 'object' || !ev || typeof ev !== 'object') {
      return ledger || newLedger();
    }
    const key = keyOf(ev.adapter, ev.model);
    if (!key) {
      return ledger;
    }
    const at = Number(ev.at);
    if (!Number.isFinite(at)) {
      return ledger;
    }
    const c = _cfg(cfg);
    const prev = ledger.entries[key];
    const entries = { ...ledger.entries };

    if (ev.outcome === 'success') {
      if (prev) {
        delete entries[key];
      }
      return { entries };
    }
    if (ev.outcome !== 'failure') {
      return ledger;
    }

    const klass = classifyFailure(ev.errorType, ev.message);
    if (klass === 'ignore') {
      return ledger;
    }
    if (klass === 'permanent') {
      const carryRounds =
        prev && prev.kind === 'broken' && Number.isFinite(prev.until) && at < prev.until
          ? Number(prev.rounds || 1)
          : Number.isFinite(prev && prev.until) && at >= prev.until
            ? Number(prev.rounds || 0) + 1
            : 0;
      entries[key] = {
        kind: 'broken',
        errorType: String(ev.errorType || 'model_not_found')
          .trim()
          .toLowerCase(),
        at,
        until: at + c.brokenTtlMs,
        rounds: carryRounds || 1,
      };
      return { entries };
    }
    // transient:滑动窗口
    const hits = Array.isArray(prev && prev.hits)
      ? prev.hits.filter((h) => Number.isFinite(h) && at - h <= c.transientWindowMs)
      : [];
    hits.push(at);
    const tripped = hits.length >= c.transientStrikes;
    entries[key] = {
      kind: tripped ? 'tripped' : String((prev && prev.kind) || 'ok'),
      errorType: String(ev.errorType || '')
        .trim()
        .toLowerCase(),
      at,
      until: tripped ? at + c.transientCooldownMs : Number(prev && prev.until) || at,
      rounds: Number(prev && prev.rounds) || 0,
      hits,
    };
    return { entries };
  } catch {
    return ledger;
  }
}

/**
 * 查一个 (adapter, model) 当前状态。过期自动降级语义:
 *   broken 未到期 → 'broken'(不可选);broken 已到期 → 'probe-due'(等探活,壳决定怎么用)。
 *   tripped 未到期 → 'tripped'(短冷却);到期 → 'ok'。
 * @returns {'ok'|'broken'|'tripped'|'probe-due'|'unknown-key'} 绝不抛。
 */
function statusOf(ledger, adapter, model, at) {
  try {
    const key = keyOf(adapter, model);
    if (!key) {
      return 'unknown-key';
    }
    const e = ledger && ledger.entries ? ledger.entries[key] : null;
    if (!e) {
      return 'ok';
    }
    const now = Number(at);
    if (!Number.isFinite(now)) {
      return e.kind === 'broken' ? 'probe-due' : 'ok';
    }
    if (e.kind === 'broken') {
      return now < Number(e.until || 0) ? 'broken' : 'probe-due';
    }
    if (e.kind === 'tripped') {
      return now < Number(e.until || 0) ? 'tripped' : 'ok';
    }
    return 'ok';
  } catch {
    return 'ok';
  }
}

/**
 * 探活结果回填:成功 → 清 key;失败 → 续一个 brokenTtlMs 并 rounds+1
 * (壳据 rounds ≥ channelExhaustedRounds 做整渠道降权,本叶子只如实记分)。绝不抛。
 */
function recordProbeResult(ledger, adapter, model, success, at, cfg, env = process.env) {
  try {
    if (!isEnabled(env)) {
      return ledger;
    }
    const key = keyOf(adapter, model);
    if (!ledger || !key || !Number.isFinite(Number(at))) {
      return ledger;
    }
    const entries = { ...ledger.entries };
    const prev = entries[key];
    if (!prev || prev.kind !== 'broken') {
      return ledger;
    }
    if (success) {
      delete entries[key];
    } else {
      const c = _cfg(cfg);
      entries[key] = { ...prev, at: Number(at), until: Number(at) + c.brokenTtlMs, rounds: Number(prev.rounds || 0) + 1 };
    }
    return { entries };
  } catch {
    return ledger;
  }
}

/** 连续 broken→探活失败轮次;无记录 → 0。绝不抛。 */
function brokenRounds(ledger, adapter, model) {
  try {
    const key = keyOf(adapter, model);
    const e = key && ledger && ledger.entries ? ledger.entries[key] : null;
    return e && e.kind === 'broken' ? Number(e.rounds || 0) : 0;
  } catch {
    return 0;
  }
}

/** 自描述(给工具 / CLI / 文档 / 提示词用)。 */
function describeModelHealthLedger() {
  return {
    gate: 'KHY_AUTO_MODEL_HEALTH_AWARE',
    defaultOn: true,
    defaults: DEFAULT_CFG,
    summary:
      '(adapter, model) 粒度健康账本纯逻辑:permanent(model_not_found)→broken TTL 拉黑、到期转' +
      ' probe-due 等探活复活(连续 N 轮探活失败供壳做整渠道降权);transient(429/timeout/5xx…)' +
      '滑动窗口计 strikes、第 3 次才短冷却,一次绝不拉黑;success 清账;其余 errorType 保守不记。' +
      '零 IO、时钟由调用方传入、返回新账本不改入参、绝不抛。',
  };
}

module.exports = {
  isEnabled,
  DEFAULT_CFG,
  classifyFailure,
  keyOf,
  newLedger,
  recordOutcome,
  statusOf,
  recordProbeResult,
  brokenRounds,
  describeModelHealthLedger,
};
