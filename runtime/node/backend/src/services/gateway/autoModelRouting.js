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

    // [DESIGN-ARCH-185] §5.4 pass D：档位带约束 + 成本项。两者都是**可选**的 ——
    // 调用方没给 mode 时走下面这条旧路径，位次与今日逐字节一致。
    let band = null;
    let lambda = null;
    let priceOf = null;
    let priceStates = null;
    const mode = opts && opts.mode && typeof opts.mode === 'object' ? opts.mode : null;
    try {
      if (mode) {
        band = { floorIdx: mode.floorIdx, ceilingIdx: mode.ceilingIdx };
        const mp = require('../modelPricing');
        priceStates = mp.priceCoverage(candidates.map((x) => x.model));
        // 只要池里有一个价格不可知，λ 就整项退出：否则那个「不知道多少钱」的
        // 候选会被系统性饿死（§5.4 的硬规则）。
        if (priceStates.allUsable) {
          const rm = require('./routingMode');
          lambda = rm.lambdaFor(mode, {
            coverage: priceStates,
            budgetRatio: Number.isFinite(opts.budgetRatio) ? opts.budgetRatio : undefined,
          });
          if (Number.isFinite(lambda)) {
            priceOf = (m) => {
              const p = mp.resolvePrice(m);
              if (!mp.isCostUsable(p.state) || !p.price) return null;
              // 每轮期望成本用同一权重近似（无法预知 token 时按 1:1 折中）
              return p.price.input + p.price.output;
            };
          }
        }
      }
    } catch {
      band = band && mode ? band : null;
      lambda = null;
      priceOf = null;
    }

    const ranked = autoModelSelect.rankAutoModels(taskType, candidates, {
      taskScale: opts && opts.taskScale,
      max: opts && opts.max,
      band,
      lambda,
      priceOf,
    });
    const bandEmptied = mode && ranked.length === 0 && candidates.length > 0;
    // margin = top1 与 top2 的分数差。只有走连续打分时才有；离散排序下返回 null，
    // 让调用方知道「低置信升档」这一判据当前不可用，而不是拿 0 假装算过。
    const margin =
      ranked.length >= 2 && Number.isFinite(ranked[0].score) && Number.isFinite(ranked[1].score)
        ? Number((ranked[0].score - ranked[1].score).toFixed(6))
        : null;
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

    // §5.5 升档：在**已排好序**的列表上收紧 floor（只保留 ≥ 升档结果的档位），
    // 不重排、不重新打分 —— 升档的语义是「排除太弱的选项」，不是「换个排序键」。
    // 放在 rank 内部而不是调用方，是因为只有这里拿得到候选池。
    let escalatedFrom = null;
    let escalateReason = null;
    let abstained = false;
    let outRanked = finalRanked;
    const escCtx = opts && opts.escalate && typeof opts.escalate === 'object' ? opts.escalate : null;
    if (escCtx && mode && finalRanked.length > 0) {
      try {
        const rm = require('./routingMode');
        // 调用方（generate）拿不到 margin —— 它就是本函数上面刚算出来的那个差值。
        // 此前 escCtx.margin 恒为 undefined，于是「卡里 auto.escalateOn 声明了 lowMargin」
        // 与「margin+demand 双低时弃权」这两条在生产路径上**永远不可能触发**：
        // 叶子测试全是手工构造 ctx 才过的，S1 样本里也永远不会出现 escalate=lowMargin。
        // 显式给了有限值的调用方仍然优先。
        const escIn = Object.assign({}, escCtx, {
          tier: finalRanked[0].tier,
          margin: Number.isFinite(escCtx.margin) ? escCtx.margin : margin,
        });
        const esc = rm.applyEscalation(mode, escIn);
        abstained = !!esc.abstained;
        if (esc.changed && esc.tier) {
          const floorIdx = rm.tierIdx(esc.tier);
          if (Number.isFinite(floorIdx)) {
            const tightened = finalRanked.filter(
              (r) => rm.tierIdx(r.tier) <= floorIdx && rm.tierIdx(r.tier) >= mode.ceilingIdx
            );
            if (tightened.length > 0) {
              escalatedFrom = finalRanked[0];
              escalateReason = esc.reason;
              outRanked = tightened;
            }
            // 收紧后为空 → **不**强行放宽（那等于让升档变成越界许可），保持原列表并记原因。
            else escalateReason = `${esc.reason}（收紧后无候选，保持原档）`;
          }
        }
      } catch {
        /* 升档失败不影响排序结果 */
      }
    }
    // §8-⑦ / §5.1：能力要求必须真的参与筛选。此前 `capabilityRequired` 被算出来、
    // 也被写进样本，却**没有任何消费方** —— 于是「无带该能力的候选时绝不降级硬答」
    // 只是一句写在文档里的话（185 §16.4w）。
    //
    // 三态而不是一刀切，这一点是整条判据的要害：
    //   合格      → 留
    //   已知不合格 → 淘汰（能力表里有这个渠道，但那一项为 0/缺）
    //   未知      → **留**并计数。能力表里没有的渠道（自建、私有适配器）很多，
    //     照 `meetsRequirements` 那种「未知即不满足」的语义去筛，会把好候选
    //     整池淘汰掉，表现为「没有可用模型」—— 那是把仪器的无知当成产品结论。
    let capabilityBlocked = null;
    let capabilityDropped = 0;
    let capabilityUnknown = 0;
    const capRequired = opts && typeof opts.capabilityRequired === 'string' ? opts.capabilityRequired.trim() : '';
    if (mode && capRequired && outRanked.length > 0) {
      try {
        const { getCapabilityRegistry } = require('./capabilityRegistry');
        const reg = getCapabilityRegistry(gateway);
        const minScore = Number((env || process.env).KHY_ROUTE_CAPABILITY_MIN_SCORE) || 1;
        const kept = [];
        for (const c of outRanked) {
          const caps = reg.getCapabilities(c.adapter);
          if (!caps) {
            capabilityUnknown += 1;
            kept.push(c);
            continue;
          }
          if ((Number(caps[capRequired]) || 0) >= minScore) kept.push(c);
          else capabilityDropped += 1;
        }
        // 只剩「未知」时不算被挡：那仍是仪器不知道，不是确实没有能力。
        if (kept.length === 0 && capabilityDropped > 0) {
          capabilityBlocked = capRequired;
          // 被挡就必须**没有赢家**。只挂一个 blocked 标记却照样给出不识图的头名，
          // 等于把「绝不降级硬答」这句承诺留给下游去自觉执行 ——
          // 第一版就是这么错的（测试直接抓到：blocked 已置位，winner 仍是无 vision 的渠道）。
          // 清空后 S3 的 apply 分支天然不进入（它要求 winner），旧路径原样接管。
          outRanked = [];
        } else if (kept.length !== outRanked.length) outRanked = kept;
      } catch {
        /* 能力表不可用 ⇒ 不筛选，也不谎报成筛过 */
      }
    }

    return {
      winner: outRanked.length > 0 ? outRanked[0] : null,
      ranked: outRanked,
      skipped,
      poolReady: true,
      margin,
      escalatedFrom,
      escalateReason,
      abstained,
      // 能力筛选的全过程读数。`unknown` 单独列出来，理由同上：看不见「有多少是仪器不知道」，
      // 「淘汰了 3 个」就会被读成「只有 1 个可用」。
      capability: capRequired
        ? {
            required: capRequired,
            blocked: capabilityBlocked,
            dropped: capabilityDropped,
            unknown: capabilityUnknown,
            kept: outRanked.length,
          }
        : null,
      // 成本项到底有没有参与、为什么没参与 —— 状态行与 route-replay 都要能点名，
      // 不许出现「看起来按成本路由了，其实 λ 早退出了」这种不可见的降级。
      cost: {
        lambda,
        participated: Number.isFinite(lambda),
        coverage: priceStates,
        bandEmptied: !!bandEmptied,
      },
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
        // 裁剪**不许销毁证据**：§15 R6 说这些样本是升档判据的唯一存量，
        // 而这里丢掉的正是**最早**那一批 —— 恰好是证明 S1→S2 达标的那一半。
        // 所以先把要移出热文件的半段追加进归档（append-only），再重写热文件。
        const dropped = keep.slice(0, Math.floor(keep.length / 2));
        try {
          fs.appendFileSync(file + '.archive.jsonl', dropped.join('\n') + '\n', 'utf8');
        } catch {
          /* 归档失败则**不裁剪**：宁可热文件超尺寸，也不静默丢样本 */
          throw new Error('archive-failed');
        }
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
 * ── turnId：把 select / failure / outcome 三类样本连成一轮 [DESIGN-ARCH-185] §3.5/§6.1 ──
 *
 * 修复前的事实：observeSelection 落 {ev:'select', at}，observeFailure 落 {ev:'failure', at}，
 * 两者只靠「时间邻接」离线 join —— 于是「选了它之后这一轮到底成没成、花了多少」连不起来。
 * 论文整个学习阶梯都建立在那条记录流上；不补 key，S1 的 200 条毕业判据永远不可判定。
 *
 * 计数器是**进程内状态**（与 ucbRouter 的臂统计同性质：不是 durable truth，重启就重新计数），
 * 所以 turnId 的唯一性范围是「本进程 × 本 session」。跨进程写同一个 jsonl 时可能撞号，
 * 这一点由 `pid` 字段兜住（重放工具按 pid+turnId 组合去重），不假装全局唯一。
 */
const _turnSeq = new Map(); // sessionId → 递增序号
const _openTurns = new Map(); // turnId → { at, sessionId }

function _pid() {
  return typeof process !== 'undefined' && process.pid ? String(process.pid) : 'na';
}

/**
 * 开一轮。返回 turnId，调用方必须把它塞进 options 并在记账点回传。
 * 绝不抛：任何异常都返回一个仍可用于 join 的降级 id。
 */
function beginTurn(ctx = {}) {
  try {
    const sid = String((ctx && ctx.sessionId) || 'anon');
    const seq = (_turnSeq.get(sid) || 0) + 1;
    _turnSeq.set(sid, seq);
    const turnId = `${_pid()}:${sid}:${seq}`;
    _openTurns.set(turnId, { at: Date.now(), sessionId: sid });
    // 防泄漏：只保留最近 500 个开着的轮次（成功/失败记账会主动删）
    if (_openTurns.size > 500) {
      for (const k of Array.from(_openTurns.keys()).slice(0, _openTurns.size - 500)) {
        _openTurns.delete(k);
      }
    }
    return turnId;
  } catch {
    return `${_pid()}:fallback:${Date.now()}`;
  }
}

/** 收尾一轮：ok / 成本 / token / 验证信号。turnId 缺失则不写（宁缺毋假）。 */
function observeOutcome(ev = {}, env = process.env) {
  try {
    if (!ev || !ev.turnId) return;
    _openTurns.delete(String(ev.turnId));
    _appendObservation(
      {
        ev: 'outcome',
        v: 1,
        turnId: String(ev.turnId),
        pid: _pid(),
        at: Number.isFinite(Number(ev.at)) ? Number(ev.at) : Date.now(),
        ok: !!ev.ok,
        errorType: ev.errorType ? String(ev.errorType) : null,
        mode: ev.mode ? String(ev.mode) : null,
        picked: ev.picked && typeof ev.picked === 'object' ? ev.picked : null,
        priceState: ev.priceState ? String(ev.priceState) : null,
        costUSD: Number.isFinite(Number(ev.costUSD)) ? Number(ev.costUSD) : null,
        tokens: ev.tokens && typeof ev.tokens === 'object' ? ev.tokens : null,
        // verify 位刻意留空也写 null：填不满是已知缺口（§2.3），不假装已有
        verify: ev.verify === undefined ? null : ev.verify,
        latencyMs: Number.isFinite(Number(ev.latencyMs)) ? Number(ev.latencyMs) : null,
      },
      env
    );
  } catch {
    /* fail-soft */
  }
}

/** 当前开着几轮（给 route-replay 与调试用）。 */
function openTurnCount() {
  return _openTurns.size;
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
        v: 1,
        // turnId 是本轮 join 的锚。缺失时不伪造 —— 宁可留下一条无法关联的样本，
        // 也不写一个「看起来能连上其实连不上」的 id（那会污染 §6.3 的全部统计）。
        turnId: ctx.turnId ? String(ctx.turnId) : null,
        pid: _pid(),
        at: Date.now(),
        mode: ctx.mode ? String(ctx.mode) : null,
        taskType: String(ctx.taskType || ''),
        legacy: { adapter: String(ctx.legacy.adapter || ''), model: legacyModel || null },
        rec: rec ? { adapter: rec.adapter, model: rec.model, tier: rec.tier } : null,
        divergent,
        skipped: Array.isArray(ctx.skipped) ? ctx.skipped.slice(0, 10) : [],
        // 四道 pass 的结果（S1 只记录不改道）。routeDemand 未接入时为 null。
        demand: ctx.demand && typeof ctx.demand === 'object'
          ? {
              tier: ctx.demand.tier || null,
              demand: Number.isFinite(ctx.demand.demand) ? ctx.demand.demand : null,
              flags: Array.isArray(ctx.demand.flags) ? ctx.demand.flags.slice(0, 8) : [],
              admitted: !!ctx.demand.admitted,
              reasons: Array.isArray(ctx.demand.reasons) ? ctx.demand.reasons.slice(0, 4) : [],
              capabilityRequired: ctx.demand.capabilityRequired || null,
              // §15-2 自查标记：这一轮的判断里有几条来自执行状态。
              // 不落这一行的话，`decide` 里算出来的 queryOnly 只活在内存里 ——
              // 「把事实写进样本」才是这条红线的可验收形态（同 margin 的处理方式）。
              stateInputs: ctx.demand.stateInputs && typeof ctx.demand.stateInputs === 'object'
                ? {
                    present: Array.isArray(ctx.demand.stateInputs.present) ? ctx.demand.stateInputs.present : [],
                    absent: Array.isArray(ctx.demand.stateInputs.absent) ? ctx.demand.stateInputs.absent : [],
                    // 判定用的独立信号。不列进白名单的话，样本里只剩 queryOnly 这个布尔，
                    // 谁都看不出「为什么算有/没有执行状态」—— M11 那次就是这么丢字段的。
                    independent: Array.isArray(ctx.demand.stateInputs.independent)
                      ? ctx.demand.stateInputs.independent
                      : [],
                    queryOnly: !!ctx.demand.stateInputs.queryOnly,
                  }
                : null,
            }
          : null,
        // margin 与成本参与情况：λ 标定与「低置信升档是否可达」的唯一证据来源
        margin: Number.isFinite(ctx.margin) ? ctx.margin : null,
        // §5.4 标定输入的目标侧（档卡 strongShare）。不落白名单就只活在内存里 ——
        // 这条本方案已经栽过三次（M11 queryOnly、M15 independent、M26 capability/beta）。
        strongTarget: Number.isFinite(ctx.strongTarget) ? ctx.strongTarget : null,
        // §5.5 升档痕迹：route-replay 靠它统计升档率（豁免率 <20% 是 S3 的毕业判据之一）
        escalatedFrom:
          ctx.escalatedFrom && typeof ctx.escalatedFrom === 'object'
            ? { model: ctx.escalatedFrom.model || null, tier: ctx.escalatedFrom.tier || null }
            : null,
        escalateReason: ctx.escalateReason ? String(ctx.escalateReason) : null,
        abstained: !!ctx.abstained,
      // §8-⑦ 的读数也要落盘：筛选发生过几次、淘汰几个、有几个是「仪器不知道」，
      // 只留在内存里就等于没做（M11/M15 两次都是栽在样本投影的白名单上）。
      capability: ctx.capability && typeof ctx.capability === 'object'
        ? {
            required: typeof ctx.capability.required === 'string' ? ctx.capability.required : null,
            blocked: typeof ctx.capability.blocked === 'string' ? ctx.capability.blocked : null,
            dropped: Number.isFinite(ctx.capability.dropped) ? ctx.capability.dropped : 0,
            unknown: Number.isFinite(ctx.capability.unknown) ? ctx.capability.unknown : 0,
            kept: Number.isFinite(ctx.capability.kept) ? ctx.capability.kept : 0,
          }
        : null,
      // β 的载体读数同 §8-⑦ 的纪律：不在白名单里就等于没测（M11/M15 两次都栽在这道上）。
      beta: ctx.beta && typeof ctx.beta === 'object'
        ? {
            declared: String(ctx.beta.declared || 'auto'),
            carried: !!ctx.beta.carried,
          }
        : null,
        // §5.6 软失败原因。null = 本轮没发生。**这个字段必须真的会被写**：
        // route-replay 读它统计软失败数，若写入端恒缺，统计就是一条恒 0 的假绿。
        softFail: ctx.softFail ? String(ctx.softFail) : null,
        cost: ctx.cost && typeof ctx.cost === 'object'
          ? {
              participated: !!ctx.cost.participated,
              lambda: Number.isFinite(ctx.cost.lambda) ? ctx.cost.lambda : null,
              bandEmptied: !!ctx.cost.bandEmptied,
              coverage: ctx.cost.coverage && typeof ctx.cost.coverage === 'object'
                ? { total: ctx.cost.coverage.total, usable: ctx.cost.coverage.usable }
                : null,
            }
          : null,
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
        v: 1,
        turnId: ev.turnId ? String(ev.turnId) : null,
        pid: _pid(),
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
  observeOutcome,
  beginTurn,
  openTurnCount,
  getSnapshot,
  describeAutoModelRouting,
};
