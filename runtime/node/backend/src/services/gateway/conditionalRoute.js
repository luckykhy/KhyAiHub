'use strict';

/**
 * conditionalRoute — 条件路由纯叶子（[MGMT-PLAN-011] L6，借鉴 Portkey gateway）。
 *
 * 为什么存在：`autoModelRouting.rank()` 的排序输入只有「健康度 + 档位带 + 成本 λ」，
 * 没有「**按请求特征选 provider**」这一维。Portkey 的做法（`src/types/requestBody.ts`
 * 的 `Strategy.mode='conditional'` + `src/services/conditionalRouter.ts`）是把匹配上下文
 * 收成三元组、用 Mongo 风格算子求值，命中即指向一个具名 target。
 *
 * 本叶子只做「求值 + 选出 target」这件纯事；**不碰候选池、不碰排序**——
 * 消费方（autoModelRouting.rank）决定命中后干什么（见该文件里的接入点）。
 *
 * 契约（对齐 autoModelRouting 的叶子约定）：
 *   - **纯函数**：零 IO、零 require、绝不抛错；任何异常输入按「不命中」处理。
 *   - 求值上下文只有三个来源（对齐 Portkey `handlerUtils.ts:723-746` 的实证）：
 *       `metadata`（调用方给的标签，Portkey 里来自 `x-portkey-metadata` header）、
 *       `params`（请求体本身，即任意字段）、`path`（路径名）。
 *     **header 本身不作为匹配维度**——Portkey 明确只把 header 解析成 metadata 后再用。
 *   - 顺序命中即返回，未命中走 `default`，两者都没有 → null（调用方据此不做任何约束）。
 */

/** 支持的算子（Mongo 风格；对齐 Portkey conditionalRouter.ts）。 */
const OPERATORS = Object.freeze([
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$regex', '$and', '$or',
]);

/**
 * 点号路径取值（`metadata.user_plan` → ctx.metadata.user_plan）。
 * 任一段缺失返回 undefined，绝不抛。
 * @param {string} dotted
 * @param {object} ctx
 * @returns {*}
 */
function getPath(dotted, ctx) {
  if (typeof dotted !== 'string' || !dotted || !ctx || typeof ctx !== 'object') {
    return undefined;
  }
  let cur = ctx;
  for (const seg of dotted.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return undefined;
    }
    cur = cur[seg];
  }
  return cur;
}

/** 单值比较：操作数不是标量时按「不相等」处理（不抛、不猜）。 */
function _cmp(actual, op, expected) {
  switch (op) {
    case '$eq': return actual === expected;
    case '$ne': return actual !== expected;
    case '$gt': return Number(actual) > Number(expected);
    case '$gte': return Number(actual) >= Number(expected);
    case '$lt': return Number(actual) < Number(expected);
    case '$lte': return Number(actual) <= Number(expected);
    case '$in': return Array.isArray(expected) && expected.includes(actual);
    case '$nin': return Array.isArray(expected) && !expected.includes(actual);
    case '$regex': {
      if (actual === undefined || actual === null) return false;
      try {
        return new RegExp(expected).test(String(actual));
      } catch {
        return false; // 坏正则按不命中，绝不让一条写错的条件把整条路由打挂
      }
    }
    default: return false;
  }
}

/**
 * 求值一个 query（`{ 'metadata.user_plan': { $eq: 'paid' } }` 或 `{ $and: [...] }`）。
 * @param {object} query
 * @param {{metadata?:object, params?:object, path?:string}} ctx
 * @returns {boolean}
 */
function evaluate(query, ctx) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    return false;
  }
  const keys = Object.keys(query);
  if (keys.length === 0) {
    // 空 query **不命中**。若按「vacuously true」处理，一条漏写 query 的条件会
    // 永远命中并把全部流量导向它的 then —— 错一次就是全量错，故按不命中。
    return false;
  }
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  for (const [key, cond] of Object.entries(query)) {
    if (key === '$and') {
      if (!Array.isArray(cond) || !cond.every((q) => evaluate(q, c))) return false;
      continue;
    }
    if (key === '$or') {
      if (!Array.isArray(cond) || cond.length === 0 || !cond.some((q) => evaluate(q, c))) return false;
      continue;
    }
    const actual = getPath(key, c);
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      // 算子对象：至少一个算子命中才算命中（对齐 Mongo 的隐式 $and 语义）
      const entries = Object.entries(cond);
      if (entries.length === 0) return false;
      for (const [op, expected] of entries) {
        if (!OPERATORS.includes(op)) return false; // 不认识的算子 → 不命中，不静默放过
        if (!_cmp(actual, op, expected)) return false;
      }
      continue;
    }
    // 裸值：等价于 $eq（Portkey 亦支持 `{ 'metadata.k': 'v' }` 的简写）
    if (actual !== cond) return false;
  }
  return true;
}

/**
 * 在条件表里找第一个命中的条件，返回它的 `then`；未命中返回 `default` 或 null。
 *
 * @param {{conditions?:Array<{query:object, then:string}>,
 *          default?:string|null}} [strategy]
 * @param {{metadata?:object, params?:object, path?:string}} [ctx]
 * @returns {{target:string, via:'condition'|'default'}|null}
 */
function matchConditional(strategy, ctx) {
  if (!strategy || typeof strategy !== 'object') {
    return null;
  }
  const conds = Array.isArray(strategy.conditions) ? strategy.conditions : [];
  for (const cond of conds) {
    if (!cond || typeof cond !== 'object') continue;
    if (evaluate(cond.query, ctx)) {
      const target = typeof cond.then === 'string' && cond.then ? cond.then : null;
      if (target) return { target, via: 'condition' };
    }
  }
  const dflt = typeof strategy.default === 'string' && strategy.default ? strategy.default : null;
  return dflt ? { target: dflt, via: 'default' } : null;
}

/**
 * 把命中 target 的候选**提升到前列**（不排除其余，保持各组内相对次序不变）。
 *
 * 为什么是「提升」而不是 Portkey 的「只走该 target」：khy-os 的 rank 是对候选池排序，
 * 硬过滤会在 target 不可用时**清空池子**（Portkey 那边由 fallback 链兜底，khy-os 暂无）。
 * 提升的语义是「条件命中时优先这个 provider，它不可用就自然落到后面」——
 * 意图一致，且永不把池子掏空。
 *
 * @param {Array<{adapter:string, model:string}>} candidates
 * @param {{target:string, via:'condition'|'default'}|null} matched
 * @returns {{ordered:Array, applied:boolean, target:string|null, via:string|null, matchedCount:number}}
 */
function prioritize(candidates, matched) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!matched || !matched.target) {
    return { ordered: list, applied: false, target: null, via: null, matchedCount: 0 };
  }
  const hit = [];
  const rest = [];
  for (const cand of list) {
    if (cand && cand.adapter === matched.target) hit.push(cand);
    else rest.push(cand);
  }
  return {
    ordered: [...hit, ...rest],
    applied: hit.length > 0,
    target: matched.target,
    via: matched.via,
    matchedCount: hit.length,
  };
}

module.exports = {
  OPERATORS,
  getPath,
  evaluate,
  matchConditional,
  prioritize,
};
