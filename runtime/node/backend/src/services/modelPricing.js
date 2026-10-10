'use strict';

/**
 * modelPricing — 模型级价格解析(纯内核 + 一次性表加载)。
 *
 * 为什么存在(见 [DESIGN-ARCH-185] §3.4):tokenPricing.estimateCost() 拿**模型名**去对
 *   **provider 名表**做子串匹配。模型名里通常不含 provider 名(claude-* 不含 anthropic、
 *   glm-* 不含 智谱AI),于是实测 14 个抽样模型里 13 个静默落到 default 兜底,
 *   拿到同一个编造价 —— claude-opus 与 gpt-4o-mini 真实价差约 50 倍,账单口径下完全相等。
 *   本模块把「哪一行价格描述哪个模型」变成显式声明,并引入 priceState 五态:
 *   「不知道」必须是一个可路由的状态,而不是一个看起来像数据的默认数字。
 *
 * 五态与设计 §5.4 的三态关系:priced/free = 设计里的 priced(成本项可用);
 *   assumed/flat/unknown = 成本项**退出**。把 free 与 flat 分开是因为二者对路由的含义相反 ——
 *   本地推理是「真的最便宜」,订阅包月是「token 计价不成立」。混成一个状态会让
 *   路由器把包月渠道判成免费午餐,系统性地把流量全推过去。
 *
 * 契约(与全仓纯叶子一致):
 *   - 绝不抛:表坏 / 正则坏 / 入参非字符串,一律收敛到 unknown。
 *   - 确定性:同输入恒同输出。families 按声明顺序**首个命中即停**(顺序即优先级,
 *     特例必须排在其泛化条之前 —— 表里 _ordering_note 与测试共同守这条不变量)。
 *   - 零网络零子进程。表加载:env 内联 > appHome 覆盖 > 仓内文件,读一次缓存。
 */

// 磁盘 IO 收敛到全仓单点工具 readJsonFileSafe(本文件保持纯叶子契约:自身不 require fs)。
const _readJson = require('../utils/readJsonFileSafe');
const path = require('path');

const PRICING_REL = path.join('config', 'models', 'pricing.json');

// 成本项可用的状态(其余状态一律退出成本项)。
const _USABLE_STATES = new Set(['priced', 'free']);

// token 数:**不校验符号**。数学叶子不做上游的事(旧 tokenPricing 的「negative tokens
// propagate (no clamping)」契约),负数由调用方的取数路径负责,叶子如实算出一个负成本。
function _isNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

// 价格声明:**必须校验非负**。表是人写的配置,负价/NaN 是配置损坏,
// 必须收敛到 unknown 而不是算出一个「倒贴钱」的候选 —— 那会让路由器把坏配置当最便宜。
function _isPriceNum(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/** 归一一条价格声明 → { state, price|null, source, familyId }。坏声明收敛到 unknown。 */
function _normalizeEntry(entry, familyId) {
  try {
    const rawState = String((entry && entry.state) || '').trim().toLowerCase();
    const p = entry && typeof entry.price === 'object' ? entry.price : null;
    const source = (entry && typeof entry.source === 'string' && entry.source) || '';
    if (rawState === 'flat') {
      return { state: 'flat', price: null, source, familyId: familyId || null };
    }
    if (rawState === 'free') {
      return {
        state: 'free',
        price: { input: 0, output: 0, cachedRead: 0, reasoning: 0 },
        source,
        familyId: familyId || null,
      };
    }
    if (p && _isPriceNum(p.input) && _isPriceNum(p.output)) {
      return {
        state: 'priced',
        price: {
          input: p.input,
          output: p.output,
          cachedRead: _isPriceNum(p.cachedRead) ? p.cachedRead : null,
          reasoning: _isPriceNum(p.reasoning) ? p.reasoning : null,
        },
        source,
        familyId: familyId || null,
      };
    }
    return { state: 'unknown', price: null, source: '', familyId: null };
  } catch {
    return { state: 'unknown', price: null, source: '', familyId: null };
  }
}

/**
 * 解析一个模型 id(或 provider 键)的价格状态。绝不抛。
 * @param {string} modelId
 * @param {{table?:object, providerTable?:object}} [opts] table 由调用方注入(测试用)
 * @returns {{state:string, price:object|null, source:string, familyId:string|null, via:string}}
 */
function resolvePrice(modelId, opts = {}) {
  const unknown = { state: 'unknown', price: null, source: '', familyId: null, via: 'none' };
  try {
    const id = typeof modelId === 'string' ? modelId.trim().toLowerCase() : '';
    if (!id) return unknown;

    const table = opts.table && typeof opts.table === 'object' ? opts.table : _loadTable(opts.env);

    // 1) 精确模型条目
    const models = table && table.models && typeof table.models === 'object' ? table.models : {};
    if (Object.prototype.hasOwnProperty.call(models, id)) {
      const r = _normalizeEntry(models[id], id);
      if (r.state !== 'unknown') return { ...r, via: 'model' };
    }

    // 2) 家族正则,声明顺序首个命中即停
    const families = Array.isArray(table && table.families) ? table.families : [];
    for (const fam of families) {
      if (!fam || typeof fam.match !== 'string' || !fam.match) continue;
      let hit = false;
      try {
        hit = new RegExp(fam.match, 'i').test(id);
      } catch {
        continue; // 坏正则跳过该条,不影响其余
      }
      if (!hit) continue;
      const r = _normalizeEntry(fam, typeof fam.id === 'string' ? fam.id : '');
      if (r.state === 'unknown') continue; // 声明坏了 → 继续往下找,不静默当免费
      return { ...r, via: 'family' };
    }

    // 3) provider 粗价:**精确键**匹配(不再做子串),命中记 assumed
    const prov = opts.providerTable || require('./tokenPricing').TOKEN_PRICING;
    if (prov && typeof prov === 'object') {
      for (const key of Object.keys(prov)) {
        if (key === 'default') continue;
        if (key.toLowerCase() !== id) continue;
        const r = _normalizeEntry(
          { price: prov[key], source: `TOKEN_PRICING.${key}(provider 粗价)` },
          ''
        );
        if (r.state === 'priced') r.state = 'assumed';
        return { ...r, via: 'provider-exact' };
      }
    }

    return unknown;
  } catch {
    return unknown;
  }
}

/** 成本项是否可进路由排序(§5.4 的 λ 退出判据)。 */
function isCostUsable(stateOrResult) {
  try {
    const s =
      typeof stateOrResult === 'string'
        ? stateOrResult
        : String((stateOrResult && stateOrResult.state) || '');
    return _USABLE_STATES.has(s.trim().toLowerCase());
  } catch {
    return false;
  }
}

/**
 * 带状态的成本估算。**unknown/flat 返回 costUSD:null** —— 宁可没有数字,不要假数字。
 * @returns {{costUSD:number|null, costCNY:number|null, state:string, source:string, via:string}}
 */
function estimateCostDetailed(inputTokens, outputTokens, modelId, opts = {}) {
  try {
    const r = resolvePrice(modelId, opts);
    if (!isCostUsable(r.state) || !r.price) {
      return { costUSD: null, costCNY: null, state: r.state, source: r.source, via: r.via };
    }
    const i = _isNum(inputTokens) ? inputTokens : 0;
    const o = _isNum(outputTokens) ? outputTokens : 0;
    const usd = (i * r.price.input + o * r.price.output) / 1e6;
    const rate = Number(opts.usdToCny) || require('./tokenPricing').USD_TO_CNY;
    return {
      costUSD: usd,
      costCNY: usd * rate,
      state: r.state,
      source: r.source,
      via: r.via,
    };
  } catch {
    return { costUSD: null, costCNY: null, state: 'unknown', source: '', via: 'error' };
  }
}

/**
 * 价格覆盖率:路由器决定「成本项进不进排序」的直接输入,也是 route-replay 的体检位。
 * 规则:usable/total < 1 时,λ 必须按不可知降级(§5.4)—— 只要有一个 assumed 就不许
 * 拿成本当理由降档,否则 assumed 的那一个会被系统性饿死。
 */
function priceCoverage(modelIds, opts = {}) {
  const byState = { priced: 0, free: 0, assumed: 0, flat: 0, unknown: 0 };
  const list = Array.isArray(modelIds) ? modelIds : [];
  try {
    for (const m of list) {
      const s = resolvePrice(m, opts).state;
      if (Object.prototype.hasOwnProperty.call(byState, s)) byState[s] += 1;
      else byState.unknown += 1;
    }
  } catch {
    /* fail-soft:返回已统计的部分 */
  }
  const usable = byState.priced + byState.free;
  return {
    total: list.length,
    usable,
    byState,
    // 全 usable 才允许成本项参与(见上注释)
    allUsable: list.length > 0 && usable === list.length,
  };
}

// ── 表加载(一次;env 内联 > appHome 覆盖 > 仓内文件)────────────────────────
let _cached = null;

function _loadTable(env = process.env) {
  try {
    const e = env || process.env;
    const inline = e.KHY_MODEL_PRICING_JSON;
    if (typeof inline === 'string' && inline.trim()) {
      const parsed = JSON.parse(inline);
      if (parsed && typeof parsed === 'object') return parsed;
    }
    if (_cached) return _cached;
    // 覆盖文件落点与 modelFeatureRegistry 同惯例:显式 env > appHome > ~/.khyquant 兜底。
    let overrideFile = '';
    if (e.KHY_MODEL_PRICING_FILE && String(e.KHY_MODEL_PRICING_FILE).trim()) {
      overrideFile = path.resolve(String(e.KHY_MODEL_PRICING_FILE).trim());
    } else {
      try {
        overrideFile = path.join(require('../utils/dataHome').getAppHome(), 'model_pricing.json');
      } catch {
        overrideFile = path.join(require('os').homedir(), '.khyquant', 'model_pricing.json');
      }
    }
    const overrides = _readJson(overrideFile);
    const base = _readJson(path.resolve(__dirname, '..', '..', PRICING_REL));
    if (!base || typeof base !== 'object') {
      _cached = { families: [], models: {} };
      return _cached;
    }
    if (overrides && typeof overrides === 'object') {
      base.models = { ...(base.models || {}), ...(overrides.models || {}) };
      base.families = [...(overrides.families || []), ...(base.families || [])];
    }
    _cached = base;
    return _cached;
  } catch {
    return { families: [], models: {} };
  }
}

/** 测试钩子:丢掉缓存的表。 */
function _resetTableCache() {
  _cached = null;
}

module.exports = {
  estimateCostDetailed,
  isCostUsable,
  priceCoverage,
  resolvePrice,
  _resetTableCache,
};
