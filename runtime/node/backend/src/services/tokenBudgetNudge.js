'use strict';

// [AI-差距①·token 预算正向语义] 纯叶子:形状照抄 shortStopContinuation.js / tokenBudget.js。
//   零 I/O、确定性、绝不抛、门关返安全默认(shouldNudge→false;warn 文案返 '')。
//   本门**默认关**(opt-in):nudge 多一次模型调用,仅显式开启时生效。

/**
 * tokenBudgetNudge.js — 纯叶子:给 token 预算补上「正向半边」。
 *
 * 背景(见 docs/11_报告/RESEARCH/[RESEARCH-020]):CC 的 tokenBudget.ts 里,用户在提示中写
 * 「+500k」/「use 2M tokens」是一个**目标**(朝它把活干扎实),模型早停时系统注入 nudge 让它继续。
 * khy 现有的 tokenBudget.js 只解析了这个指令并把它**当上限**接线(toolUseLoopCore 到 spent>=ceiling
 * 即 stop),且 assessBudget 的 'warn' 档从无人消费(死代码)。本叶子补两块:
 *
 *   1. nudge 判定:当 in-prompt 目标未达、模型自然终局(无 tool_use)、且未用满单次封顶时,
 *      给出一次「继续未完成工作」的注入消息。诚实条款写进文案——已完成就直说,不许为凑预算灌水。
 *   2. warn 提醒:把 spent>=ceiling*warnRatio 且未 stop 的 warn 档,转成一行终端状态提醒
 *      (动作+目标+进度,规则 2)。纯告知,不拦截、不进模型上下文。
 *
 * 语义边界(不可放宽):
 *   - nudge **只服务 in-prompt 目标**(source==='prompt'),env 上限(KHY_TOKEN_BUDGET)永不 nudge。
 *     设上限的意图是控成本,不是烧钱。
 *   - nudge 与 goalStopGate 的 redrive 同轮互斥(条件 6):一个 turn 只许一个「再来一轮」驱动源。
 *
 * 契约:纯叶子——零 I/O(env 作参数传入)、确定性、绝不抛。门
 * (KHY_TOKEN_BUDGET_NUDGE,默认关)关 → shouldNudge 恒 false、buildWarnNotice 恒 ''
 * (逐字节回退到今日「到上限即停、warn 无人读」行为)。
 *
 * @module services/tokenBudgetNudge
 */

const DEFAULT_MAX_NUDGES = 1;
const MAX_NUDGES_CLAMP_LO = 0;
const MAX_NUDGES_CLAMP_HI = 10;

function _nonNeg(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return n;
}

/**
 * 是否启用(opt-in,默认关)。自包含解析:仅显式 'true'|'1' 视为开,其余(含缺省)一律关。
 *
 * 为何不委托 flagRegistry:兄弟叶子 tokenBudget.js 的门(KHY_TOKEN_BUDGET /
 * KHY_PROMPT_TOKEN_BUDGET)本就各自手写 off 词表、不碰注册表(见其 resolveBudget /
 * promptTokenBudgetEnabled)。且 flagRegistry 真源目录当前**未跟踪且在活跃再生**,
 * 登记项随时可能被重生抹掉;而它把「未登记的 name 保守放行为 true」——一旦登记丢失,
 * 委托分支会把本门误判为**默认开**,与「默认关」红线相悖,且 catch 兜底救不了「返回错值」
 * (只在抛错时触发)。自包含解析彻底消除这条隐患:语义稳定、确定性、零外部依赖。
 *
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : {});
  const raw = e && e.KHY_TOKEN_BUDGET_NUDGE;
  // opt-in 方言(对齐 flagRegistry 'opt-in' mode 与 shortStopContinuation 兜底):仅 true|1 开。
  return raw === 'true' || raw === '1';
}

/**
 * 解析单 turn nudge 上限。KHY_TOKEN_BUDGET_NUDGE_MAX,默认 1,clamp [0,10]。
 * 非有限值 → 默认 1(绝不因坏值退化为「无上限」)。
 * @param {object} [env]
 * @returns {number}
 */
function resolveMaxNudges(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : {});
  const raw = Number(e.KHY_TOKEN_BUDGET_NUDGE_MAX);
  let n = Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_MAX_NUDGES;
  if (n < MAX_NUDGES_CLAMP_LO) {
    n = MAX_NUDGES_CLAMP_LO;
  }
  if (n > MAX_NUDGES_CLAMP_HI) {
    n = MAX_NUDGES_CLAMP_HI;
  }
  return n;
}

/**
 * 判定这一轮是否值得注入一次 nudge 续跑。纯函数,绝不抛;任一条件不满足 → false。
 *
 * 全部条件:门开 && source==='prompt' && !hadToolCalls && ceiling>0 && spent<ceiling
 *          && nudgesUsed<maxNudges && !goalGateDroveRedrive(同轮互斥)。
 *
 * @param {{budgetSource?:'prompt'|'env', spent:number, ceiling:number,
 *          hadToolCalls?:boolean, nudgesUsed?:number,
 *          goalGateDroveRedrive?:boolean, maxNudges?:number}} ctx
 * @param {object} [env]
 * @returns {boolean}
 */
function shouldNudge(ctx, env) {
  try {
    if (!isEnabled(env)) {
      return false;
    }
    if (!ctx || typeof ctx !== 'object') {
      return false;
    }
    // 条件 1:本轮预算须来自 in-prompt 目标(env 上限永不 nudge)。
    if (ctx.budgetSource !== 'prompt') {
      return false;
    }
    // 条件 2:模型自然终局(本轮无 tool_use)。有工具调用说明仍在推进,不需 nudge。
    if (ctx.hadToolCalls === true) {
      return false;
    }
    // 条件 3:ceiling 有效且尚未触及停止线。
    const ceiling = _nonNeg(ctx.ceiling);
    if (ceiling <= 0) {
      return false;
    }
    const spent = _nonNeg(ctx.spent);
    if (spent >= ceiling) {
      return false;
    }
    // 条件 4:未用满单次封顶。
    const maxNudges = Number.isFinite(ctx.maxNudges)
      ? ctx.maxNudges
      : resolveMaxNudges(env);
    const used = _nonNeg(ctx.nudgesUsed);
    if (used >= maxNudges) {
      return false;
    }
    // 条件 5:goalStopGate 本轮未驱动 redrive(同轮互斥)。
    if (ctx.goalGateDroveRedrive === true) {
      return false;
    }
    return true;
  } catch {
    return false; // fail-soft
  }
}

/**
 * 构造注入对话的 nudge 续跑消息。含诚实条款:已完成就直说,不许凑预算灌水。
 * @param {{spent:number, ceiling:number, round?:number}} arg
 * @returns {string}
 */
function buildNudgeMessage({ spent, ceiling, round } = {}) {
  const _spent = Math.floor(_nonNeg(spent));
  const _ceiling = Math.floor(_nonNeg(ceiling));
  const _round = Math.floor(_nonNeg(round)) || 1;
  return (
    `[SYSTEM: 预算续跑 ${_round}] 本轮 token 目标 ${_ceiling},已用 ${_spent}。` +
    '若任务确已完成,请直接给出最终结论并明确说明「已完成」,**不要为凑预算灌水**;若仍有未完成的' +
    '实质工作(未读的代码、未跑的验证、未写的章节),请继续推进并优先完成它。'
  );
}

/**
 * 构造 warn 档的一次性终端状态提醒。门关 / ceiling 无效 / 未达 warn 线 → 返 ''。
 * 纯告知(动作+目标+进度),不拦截、不进模型上下文。
 * @param {{spent:number, ceiling:number, warnRatio?:number, source?:'prompt'|'env'}} arg
 * @param {object} [env]
 * @returns {string}
 */
function buildWarnNotice({ spent, ceiling, warnRatio, source } = {}, env) {
  try {
    if (!isEnabled(env)) {
      return '';
    }
    const _ceiling = _nonNeg(ceiling);
    if (_ceiling <= 0) {
      return '';
    }
    const _spent = _nonNeg(spent);
    if (_spent >= _ceiling) {
      return ''; // stop 线归 buildBudgetStopNotice,warn 只管「未达上限但接近」
    }
    let _warn = Number(warnRatio);
    if (!Number.isFinite(_warn)) {
      _warn = 0.8;
    }
    if (_warn < 0) {
      _warn = 0;
    }
    if (_warn > 1) {
      _warn = 1;
    }
    if (_spent < _ceiling * _warn) {
      return ''; // 还没到 warn 线
    }
    const remaining = Math.floor(_ceiling - _spent);
    const label = source === 'prompt' ? '提示内目标' : 'KHY_TOKEN_BUDGET';
    return `预算提醒: 已用 ${_spent}/${_ceiling} tokens(剩 ${remaining},来源 ${label})`;
  } catch {
    return '';
  }
}

module.exports = {
  isEnabled,
  resolveMaxNudges,
  shouldNudge,
  buildNudgeMessage,
  buildWarnNotice,
  DEFAULT_MAX_NUDGES,
  MAX_NUDGES_CLAMP_LO,
  MAX_NUDGES_CLAMP_HI,
};
