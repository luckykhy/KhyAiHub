'use strict';

/**
 * autoModelRouting — IO 壳:(adapter, model) 粒度跨渠道候选池 + 健康账本持有者 + S1 分歧观察。
 *
 * 背景(为什么存在):见 [DESIGN-ARCH-162]。autoSelectModel 的选型与健康都停在 adapter 粒度,
 *   坏默认模型的渠道每轮被重选(E1-E6 证据链)。本壳补三件事:
 *     1. 候选池:init 后后台异步枚举各 available adapter 的 listModels(复用 gateway.listModels,
 *        已过 modelCuration/modelListTruth 真值过滤),TTL 惰性重刷(stale-while-revalidate,
 *        热路径绝不 await 网络);
 *     2. 账本:持有 modelHealthLedger 纯叶子的内存态,提供 recordOutcome 双写入口
 *        (挂在既有 success/`_recordAdapterFailure` 记账点,adapter 级冷却原样保留);
 *     3. 排序:pool − broken − tripped → autoModelSelect.rankAutoModels(现成纯函数)出全局 rank。
 *
 * 阶段(PROCESS-008,S1 观察者):本版**只观测不改道**——消费方照常走旧 autoSelectModel,
 *   本壳并行算出「新会选谁」并落 jsonl 分歧样本(`.khy/ruleguard/auto-route.jsonl`),
 *   同时账本双写真实生效(只写不被路由消费)。升 S3 后消费方才把 rank[0] 写进 options.model。
 *
 * 契约:
 *   - 门控 KHY_AUTO_MODEL_HEALTH_AWARE 默认开(判定收口在 modelHealthLedger.isEnabled,
 *     单一真源);关 → rank 返回 null、observe 不落盘、record 不改账本 → 逐字节回退现状。
 *   - 绝不抛:一切 IO(枚举/写盘/探活)fail-soft;排序异常返回 null。
 *   - 时钟不外露:内部用 Date.now();纯逻辑全在叶子。
 *   - 与神文件重构线(#7)解耦:只 require 纯叶子,不 require aiGateway
 *     (gateway 由调用方注入,防 require 环)。
 */

const fs = require('fs');
const path = require('path');

const ledger = require('./modelHealthLedger');
const autoModelSelect = require('./autoModelSelect');

// ── env 配置(全部可覆盖;默认值只在这一个模块出现,RUNTIME-001)────────────────
function _parseMs(raw, dflt, min) {
  const n = Number.parseInt(String(raw === undefined || raw === null ? '' : raw), 10);
  if (!Number.isFinite(n) || n <= 0) {
    return dflt;
  }
  return Math.max(min, n);
}

function _poolTtlMs(env = process.env) {
  return _parseMs(env.KHY_AUTO_MODEL_POOL_TTL_MS, 600000, 30000); // 候选池 10 分钟重刷
}
function _listTimeoutMs(env = process.env) {
  return _parseMs(env.KHY_AUTO_MODEL_LIST_TIMEOUT_MS, 5000, 500); // 单 adapter 枚举上限
}
function _ledgerCfg(env = process.env) {
  return {
    brokenTtlMs: _parseMs(env.KHY_AUTO_MODEL_BROKEN_TTL_MS, ledger.DEFAULT_CFG.brokenTtlMs, 60000),
    transientWindowMs: _parseMs(
      env.KHY_AUTO_MODEL_TRANSIENT_WINDOW_MS,
      ledger.DEFAULT_CFG.transientWindowMs,
      10000
    ),
    transientStrikes: _parseMs(
      env.KHY_AUTO_MODEL_TRANSIENT_STRIKES,
      ledger.DEFAULT_CFG.transientStrikes,
      2
    ),
    transientCooldownMs: _parseMs(
      env.KHY_AUTO_MODEL_TRANSIENT_COOLDOWN_MS,
      ledger.DEFAULT_CFG.transientCooldownMs,
      10000
    ),
    channelExhaustedRounds: ledger.DEFAULT_CFG.channelExhaustedRounds,
  };
}
function _observeEnabled(env = process.env) {
  try {
    return require('../flagRegistry').isFlagEnabled('KHY_AUTO_MODEL_OBSERVE', env || process.env);
  } catch {
    /* fall through */
  }
  const raw = (env || process.env).KHY_AUTO_MODEL_OBSERVE;
  return !String(raw === undefined || raw === null ? 'true' : raw)
    .trim()
    .toLowerCase()
    .match(/^(0|false|off|no)$/);
}

// 落地阶段真源(PROCESS-008 / [DESIGN-ARCH-162] §6):字面常量,守卫可比对
// (executorStage 漂移检查;先例 step-anchor——env 覆盖只作临时回退演示用)。
// S1=观察者:账本双写+分歧样本落盘,消费方(auto 分支)只观测不改路由。
// 升 S3 需要一次人工裁决,且届时要另加「rank[0] 钉进 options.model + 按 rank 序级联」
// 的应用代码——当前刻意不存在自动应用路径。
// 守卫(check-rollout-stage)的 executorStage 比对用纯字面量(先例 step-anchor:
// 三同族只从 env 读常量因而都挂 authority-drift warning,step-anchor 刻意避开)。
const KHY_AUTO_MODEL_ROUTE_STAGE = 'S1';

/**
 * 生效阶段。默认 S1(观察者);仅认 S2/S3,其余一律回落 S1(绝不 fail-open 到更高阶段)。
 * 注意:当前代码里**不存在**任何按阶段改变路由行为的路径——S3 应用代码留待升档时实现。
 * @param {object} [env]
 * @returns {'S1'|'S2'|'S3'}
 */
function getStage(env = process.env) {
  const raw = String((env && env.KHY_AUTO_MODEL_ROUTE_STAGE) || KHY_AUTO_MODEL_ROUTE_STAGE)
    .trim()
    .toUpperCase();
  if (raw === 'S2' || raw === 'S3') {
    return raw;
  }
  return KHY_AUTO_MODEL_ROUTE_STAGE;
}

// relay 系渠道沿旧 auto 语义恒为最后手段,不进全局池参与排序。
const _POOL_EXCLUDED_KEYS = new Set(['relay', 'webrelay', 'web-relay']);
// 观察样本落点:works/data/khy/ruleguard/auto-route.jsonl(与 authzFailureLedger 同档惯例;
// env KHY_AUTO_MODEL_OBSERVE_FILE 可覆盖,测试注入用)。
const _OBSERVE_REL = path.join('works', 'data', 'khy', 'ruleguard', 'auto-route.jsonl');
const _OBSERVE_MAX_BYTES = 2 * 1024 * 1024; // 与 ruleguard 台账同档:超限裁留后半

function _observePath(env = process.env) {
  const override = env.KHY_AUTO_MODEL_OBSERVE_FILE;
  if (override && typeof override === 'string') {
    return override;
  }
  return path.resolve(process.cwd(), _OBSERVE_REL);
}

// ── 内存态(模块级单例;gateway 实例由调用方逐次注入)───────────────────────────
let _ledgerState = ledger.newLedger();
// adapters: { [key]: { models: [{model, adapter, source}], at, status } }
let _pool = { adapters: {}, lastWarmAt: 0, warming: false };
const _reviveInFlight = new Set(); // 探活复活去重:key

function isEnabled(env = process.env) {
  return ledger.isEnabled(env);
}

// ── 候选池 ───────────────────────────────────────────────────────────────────

function _normalizeRows(adapterKey, rows) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(rows)) {
    return out;
  }
  for (const row of rows) {
    let model = '';
    if (typeof row === 'string') {
      model = row;
    } else if (row && typeof row === 'object') {
      model = row.id || row.model || row.name || '';
    }
    model = String(model || '')
      .trim()
      .replace(/^auto$/i, ''); // 哨兵字面不进池
    if (!model || seen.has(model.toLowerCase())) {
      continue;
    }
    seen.add(model.toLowerCase());
    out.push({ model, adapter: adapterKey, source: 'remote' });
  }
  return out;
}

async function _listWithTimeout(gateway, adapterKey, timeoutMs) {
  return await Promise.race([
    Promise.resolve()
      .then(() => gateway.listModels(adapterKey))
      .then((rows) => ({ ok: true, rows })),
    new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: 'listTimeout' }), timeoutMs);
      if (t && typeof t.unref === 'function') {
        t.unref();
      }
    }),
  ]);
}

/**
 * 后台刷新候选池(全渠道并行,fire-and-forget)。单渠道失败只丢该渠道候选
 * (status:'failed',下一 TTL 周期再试),不影响整池;绝不抛。
 */
async function refreshPool(gateway, env = process.env) {
  if (!isEnabled(env) || !gateway || _pool.warming) {
    return;
  }
  _pool.warming = true;
  try {
    const entries = Array.isArray(gateway._adapters) ? gateway._adapters : [];
    const targets = entries.filter(
      (e) =>
        e &&
        e.enabled &&
        e.available &&
        e.key &&
        !_POOL_EXCLUDED_KEYS.has(String(e.key).toLowerCase())
    );
    const timeoutMs = _listTimeoutMs(env);
    const results = await Promise.allSettled(
      targets.map(async (e) => {
        try {
          const r = await _listWithTimeout(gateway, e.key, timeoutMs);
          return { key: e.key, r };
        } catch (err) {
          // listModels 抛 → 与超时同路:标 failed 保旧数据,该渠道不整个消失。
          return { key: e.key, r: { ok: false, error: String((err && err.message) || err) } };
        }
      })
    );
    const next = { ..._pool.adapters };
    for (const res of results) {
      if (res.status !== 'fulfilled') {
        continue;
      }
      const { key, r } = res.value || {};
      if (!key) {
        continue;
      }
      if (r && r.ok) {
        const models = _normalizeRows(key, r.rows);
        next[key] = { models, at: Date.now(), status: models.length > 0 ? 'ok' : 'empty' };
      } else {
        // 超时/失败:保留旧列表(标 failed 时间戳照记),宁可拿旧数据排序也不清池。
        next[key] = next[key] || { models: [], at: 0, status: 'failed' };
        next[key].status = 'failed';
      }
    }
    _pool = { adapters: next, lastWarmAt: Date.now(), warming: false };
    _scheduleReviveProbes(gateway, env);
  } catch {
    _pool.warming = false;
  }
}

/** stale-while-revalidate:池过期只**触发**后台刷新,当次返回仍用旧数据,热路径零等待。 */
function ensurePool(gateway, env = process.env) {
  try {
    if (!isEnabled(env) || !gateway) {
      return;
    }
    const now = Date.now();
    if (_pool.lastWarmAt === 0 || now - _pool.lastWarmAt > _poolTtlMs(env)) {
      Promise.resolve()
        .then(() => refreshPool(gateway, env))
        .catch(() => {});
    }
  } catch {
    /* 绝不因池维护影响调用方 */
  }
}

/**
 * broken 到期(probe-due)的模型:后台 verifyModel 复活。成功清账,失败续期并累计轮次。
 * 复用 gateway.verifyModel 的严格探测路径(与 /model UI 同一真值),in-flight 去重防惊群。
 */
function _scheduleReviveProbes(gateway, env) {
  try {
    if (!isEnabled(env) || typeof gateway.verifyModel !== 'function') {
      return;
    }
    const now = Date.now();
    for (const bucket of Object.values(_pool.adapters)) {
      for (const c of bucket.models || []) {
        const st = ledger.statusOf(_ledgerState, c.adapter, c.model, now);
        if (st !== 'probe-due') {
          continue;
        }
        const key = ledger.keyOf(c.adapter, c.model);
        if (!key || _reviveInFlight.has(key)) {
          continue;
        }
        _reviveInFlight.add(key);
        Promise.resolve()
          .then(() => gateway.verifyModel(c.adapter, c.model))
          .then((res) => {
            _ledgerState = ledger.recordProbeResult(
              _ledgerState,
              c.adapter,
              c.model,
              !!(res && res.status === 'verified'),
              Date.now(),
              _ledgerCfg(env),
              env
            );
          })
          .catch(() => {})
          .finally(() => _reviveInFlight.delete(key));
      }
    }
  } catch {
    /* fail-soft */
  }
}

// ── 账本双写入口(挂在既有记账点)────────────────────────────────────────────

/**
 * 记一次生成结果。success=true 清账;failure 按叶子分类(permanent/transient/ignore)。
 * model 缺失(composite 剥离前的原串由调用方负责传**实际送出**的模型串)→ 不记。绝不抛。
 */
function recordOutcome(ev, env = process.env) {
  try {
    if (!isEnabled(env) || !ev) {
      return;
    }
    _ledgerState = ledger.recordOutcome(
      _ledgerState,
      { ...ev, at: Number.isFinite(Number(ev.at)) ? Number(ev.at) : Date.now() },
      _ledgerCfg(env),
      env
    );
  } catch {
    /* 记账失败绝不影响生成 */
  }
}

// ── 排序(消费入口)──────────────────────────────────────────────────────────

/**
 * 全局跨渠道排序。返回 null = 不可用(门关 / 池空),调用方逐字节走旧 autoSelectModel。
 * @returns {{winner:{model:string,adapter:string}|null, ranked:Array, skipped:Array,
 *            poolReady:boolean}|null}
 */
function rank(gateway, taskType, opts = {}, env = process.env) {
  try {
    if (!isEnabled(env)) {
      return null;
    }
    ensurePool(gateway, env);
    const now = Date.now();
    const c = _ledgerCfg(env);
    const candidates = [];
    const skipped = [];
    for (const bucket of Object.values(_pool.adapters)) {
      for (const m of bucket.models || []) {
        const st = ledger.statusOf(_ledgerState, m.adapter, m.model, now);
        if (st === 'broken' || st === 'probe-due') {
          skipped.push({
            adapter: m.adapter,
            model: m.model,
            reason: st === 'broken' ? 'model_not_found' : 'probe-due',
          });
          continue;
        }
        if (st === 'tripped') {
          // transient 熔断(窗口内 ≥3 次):短暂后置,不当永久坏——进 cooldown 让 rank 滤除。
          skipped.push({ adapter: m.adapter, model: m.model, reason: 'rate_flapped' });
          continue;
        }
        candidates.push({ ...m, tier: undefined, status: 'active' });
      }
    }
    if (candidates.length === 0) {
      return { winner: null, ranked: [], skipped, poolReady: false };
    }
    const ranked = autoModelSelect.rankAutoModels(taskType, candidates, {
      taskScale: opts && opts.taskScale,
      max: opts && opts.max,
    });
    // 整渠道连续 N 轮 broken→探活失败:该渠道头名若来自耗尽渠道,降入尾部(只动位次不动集合)。
    const exhausted = new Set();
    for (const r of ranked) {
      const rounds = ledger.brokenRounds(_ledgerState, r.adapter, r.model);
      if (rounds >= c.channelExhaustedRounds) {
        exhausted.add(r.adapter);
      }
    }
    const finalRanked =
      exhausted.size > 0
        ? [
            ...ranked.filter((r) => !exhausted.has(r.adapter)),
            ...ranked.filter((r) => exhausted.has(r.adapter)),
          ]
        : ranked;
    return {
      winner: finalRanked.length > 0 ? finalRanked[0] : null,
      ranked: finalRanked,
      skipped,
      poolReady: true,
    };
  } catch {
    return null;
  }
}

// ── S1 观察:分歧样本落盘 ────────────────────────────────────────────────────

function _appendObservation(lineObj, env) {
  try {
    if (!_observeEnabled(env)) {
      return;
    }
    const file = _observePath(env || process.env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > _OBSERVE_MAX_BYTES) {
        const keep = fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean);
        fs.writeFileSync(file, keep.slice(Math.floor(keep.length / 2)).join('\n') + '\n', 'utf8');
      }
    } catch {
      /* 裁剪失败照写不拦 */
    }
    fs.appendFileSync(file, JSON.stringify(lineObj) + '\n', 'utf8');
  } catch {
    /* 观察落盘绝不影响生成 */
  }
}

/**
 * S1:选型时刻样本。「旧选了 X / 新会选 Y / 当时账本跳过了谁」——升档判据的分歧记录。
 * legacy 来自既有 autoSelectModel 的返回(此刻仍照旧生效)。绝不抛。
 */
function observeSelection(ctx, env = process.env) {
  try {
    if (!ctx || !ctx.legacy) {
      return;
    }
    const rec = ctx.ranked && ctx.ranked.length > 0 ? ctx.ranked[0] : null;
    const legacyModel = String((ctx.legacy && ctx.legacy.model) || '');
    const divergent = !!(
      rec &&
      (rec.adapter !== String(ctx.legacy.adapter || '') ||
        (rec.model && rec.model.toLowerCase() !== legacyModel.toLowerCase()))
    );
    _appendObservation(
      {
        ev: 'select',
        at: Date.now(),
        taskType: String(ctx.taskType || ''),
        legacy: { adapter: String(ctx.legacy.adapter || ''), model: legacyModel || null },
        rec: rec ? { adapter: rec.adapter, model: rec.model, tier: rec.tier } : null,
        divergent,
        skipped: Array.isArray(ctx.skipped) ? ctx.skipped.slice(0, 10) : [],
      },
      env
    );
  } catch {
    /* fail-soft */
  }
}

/** S1:结果时刻样本(失败原文与模型串归因),与 select 样本按时间邻接离线 join。绝不抛。 */
function observeFailure(ev, env = process.env) {
  try {
    if (!ev) {
      return;
    }
    _appendObservation(
      {
        ev: 'failure',
        at: Number.isFinite(Number(ev.at)) ? Number(ev.at) : Date.now(),
        adapter: String(ev.adapter || ''),
        model: String(ev.model || '') || null,
        errorType: String(ev.errorType || '') || null,
      },
      env
    );
  } catch {
    /* fail-soft */
  }
}

/** 只读快照(给 khy gateway status / 调试用)。绝不抛。 */
function getSnapshot(env = process.env) {
  try {
    const now = Date.now();
    const pool = {};
    for (const [k, b] of Object.entries(_pool.adapters)) {
      pool[k] = { models: (b.models || []).length, status: b.status, at: b.at };
    }
    const marked = {};
    for (const [key, e] of Object.entries(_ledgerState.entries)) {
      marked[key] = { kind: e.kind, errorType: e.errorType || null, until: e.until, rounds: e.rounds || 0 };
    }
    return {
      enabled: isEnabled(env),
      lastWarmAt: _pool.lastWarmAt,
      now,
      pool,
      ledger: marked,
    };
  } catch {
    return { enabled: false, error: 'snapshot-unavailable' };
  }
}

/** 自描述(给工具 / CLI / 文档 / 提示词用)。 */
function describeAutoModelRouting() {
  return {
    gate: 'KHY_AUTO_MODEL_HEALTH_AWARE',
    observeGate: 'KHY_AUTO_MODEL_OBSERVE',
    defaultOn: true,
    stage: getStage(),
    summary:
      '[DESIGN-ARCH-162] auto 跨渠道模型粒度路由的 IO 壳:候选池(listModels 后台枚举+TTL 惰性重刷,' +
      '热路径零等待)+ modelHealthLedger 双写 + rankAutoModels 全局排序 + broken 到期 verifyModel' +
      ' 复活。S1 观察者档:只落 .khy/ruleguard/auto-route.jsonl 分歧样本,不改实际路由;门关逐字节回退。',
  };
}

module.exports = {
  isEnabled,
  KHY_AUTO_MODEL_ROUTE_STAGE,
  getStage,
  refreshPool,
  ensurePool,
  recordOutcome,
  rank,
  observeSelection,
  observeFailure,
  getSnapshot,
  describeAutoModelRouting,
};
