'use strict';

/**
 * zenLocalRoute.js — 纯叶子:决定一次 OpenCode Zen 免费请求该「本机直连」还是「服务端代理」。
 *
 * 背景（2026-10-24 对 https://opencode.ai/zen/v1 实测,证据见 docs/opencode-provider-keys.md）：
 *   上游免费层的三道门里,最要命的是**配额按出口 IP 计**:
 *     · 本机 IP + 合法 UA 直连 → 429 FreeUsageLimitError（该 IP 的免费配额用完）
 *     · 共享代理 IP            → 403「abusive traffic from this IP address」
 *     · 非 opencode UA        → 403 FreeTierError（指纹门控,与 IP 无关）
 *   由此得到用户要的语义:**在哪台机器上允许,就在那台机器上用它的机器码和 IP**——
 *   请求必须从那台机器发出,否则共用一个出口 IP 就等于共用一份配额,一个人吃完全员 429。
 *
 * 两条路:
 *   local  —— 交回给**本机的 opencode CLI**（adapters/opencodeAdapter 既有能力）。本机 opencode
 *             自己带指纹、自己在自己的网络出口发出去 → 天然是「那台机器的机器码和 IP」。
 *             免费层的指纹门控与 body 门控(强制 stream:true + bash/read 工具)由本机 opencode
 *             自己满足,网关不必再伪造。
 *   proxy  —— 保持现状:网关自己发 HTTP,用 zenGatekeeper 的每机持久身份(zenIdentity.js)。
 *             仅在「没有本机 opencode」或「用户显式要求」时走这条路。
 *
 * 门控 / 覆盖（用户明确指定修改的唯一入口）:
 *   KHY_ZEN_LOCAL_ROUTE  主门。默认开;0/false/off/no 关 → 一律走 proxy（逐字节回退现状）。
 *   KHY_ZEN_ROUTE        显式指定 'local' 或 'proxy'，优先于主门与自动判定。
 *   KHY_ZEN_LOCAL_MODEL  逗号分隔的模型 id 白名单/黑名单语义尚未启用,留位不用（避免半吊子开关）。
 *
 * 契约:零 IO(不 spawn、不读文件);确定性(同输入同输出);绝不抛(坏输入 → 安全回退 proxy)。
 *
 * @module services/zenLocalRoute
 */

const _OFF = new Set(['0', 'false', 'off', 'no']);

/** 显式模式取值。 */
const MODE_LOCAL = 'local';
const MODE_PROXY = 'proxy';
/** 不适用（非 zen 免费模型）。 */
const MODE_NA = 'na';

function _env(env) {
  return env && typeof env === 'object' ? env : process.env || {};
}

/**
 * 主门是否开（整个「本机直连」能力的总开关）。默认开;显式 off 字面量关。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function localRouteEnabled(env = process.env) {
  try {
    const v = String(_env(env).KHY_ZEN_LOCAL_ROUTE == null ? '' : _env(env).KHY_ZEN_LOCAL_ROUTE)
      .trim()
      .toLowerCase();
    return !_OFF.has(v);
  } catch {
    return false;
  }
}

/**
 * 显式指定的模式（'local' / 'proxy'），没有则 ''。
 * @param {Record<string,string>} [env]
 * @returns {string}
 */
function explicitMode(env = process.env) {
  try {
    const v = String(_env(env).KHY_ZEN_ROUTE == null ? '' : _env(env).KHY_ZEN_ROUTE)
      .trim()
      .toLowerCase();
    return v === MODE_LOCAL || v === MODE_PROXY ? v : '';
  } catch {
    return '';
  }
}

/**
 * 该 model id 是否是 zen 免费模型（*-free 后缀）。leaf 缺失 → 按后缀再判一次，
 * 判不出就当作「不是免费模型」→ 不走本机直连（保守）。
 * @param {string} modelId
 * @returns {boolean}
 */
function isFreeZenModel(modelId) {
  const id = String(modelId == null ? '' : modelId).trim();
  if (!id) {
    return false;
  }
  try {
    const gate = require('./zenGatekeeper');
    if (gate && typeof gate.isFreeZenModelId === 'function') {
      return gate.isFreeZenModelId(id);
    }
  } catch {
    /* 叶子缺失 → 退回后缀判定 */
  }
  return id.endsWith('-free');
}

/**
 * 决策:一次 zen 免费请求走哪条路。
 *
 * @param {object} input
 * @param {string} input.poolKey      池名（'opencode-zen' 才适用）
 * @param {string} input.model        裸模型 id（不含 'api:opencode-zen:' 前缀）
 * @param {boolean} input.localAvailable 本机 opencode CLI 是否可用
 * @param {Record<string,string>} [input.env]
 * @returns {{mode:string, reason:string, model:string}}
 */
function decide(input = {}) {
  try {
    const inp = input && typeof input === 'object' ? input : {};
    const env = _env(inp.env);
    const poolKey = String(inp.poolKey || '').trim().toLowerCase();
    const model = String(inp.model || '').trim();

    if (poolKey !== 'opencode-zen') {
      return { mode: MODE_NA, reason: 'not-zen-pool', model };
    }
    if (!isFreeZenModel(model)) {
      return { mode: MODE_NA, reason: 'not-free-model', model };
    }

    const explicit = explicitMode(env);
    if (explicit === MODE_PROXY) {
      return { mode: MODE_PROXY, reason: 'explicit-proxy', model };
    }
    if (!localRouteEnabled(env)) {
      return { mode: MODE_PROXY, reason: 'gate-off', model };
    }
    if (explicit === MODE_LOCAL) {
      // 用户显式要求本机直连:即使探测不到本机 opencode 也照走（由调用方负责报错/回退），
      // 不能静默改成代理——那会违背「除非用户明确指定修改」的语义。
      return { mode: MODE_LOCAL, reason: 'explicit-local', model };
    }
    if (inp.localAvailable) {
      return { mode: MODE_LOCAL, reason: 'local-opencode-available', model };
    }
    return { mode: MODE_PROXY, reason: 'no-local-opencode', model };
  } catch {
    return { mode: MODE_PROXY, reason: 'error-fallback', model: '' };
  }
}

/**
 * 给本机 opencode 用的模型串（'opencode/<裸模型id>'）。
 * 上游模型清单来自 opencode 内置 provider，本机 opencode 认得 'opencode/<id>'。
 * @param {string} model
 * @returns {string}
 */
function localModelArg(model) {
  const id = String(model == null ? '' : model).trim();
  if (!id) {
    return '';
  }
  return id.includes('/') ? id : `opencode/${id}`;
}

module.exports = {
  MODE_LOCAL,
  MODE_PROXY,
  MODE_NA,
  localRouteEnabled,
  explicitMode,
  isFreeZenModel,
  decide,
  localModelArg,
};
