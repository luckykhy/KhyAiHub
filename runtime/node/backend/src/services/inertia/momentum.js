'use strict';

/**
 * inertia/momentum.js — 动量纯函数 + 七类停机机械判定核心。
 *
 * [DESIGN-ARCH-160] §3.5/§3.4。叶子纪律（与 TUI 叶子同源，须过
 * check-leaf-contract）：零 IO、绝不抛、绝不读 env、不改入参；
 * 常数由调用方经 constants 注入，缺省回落到 defaults.js 冻结值
 * （纯常量模块引用，非 IO）。
 *
 * 「自然衰减」的落地：不是拍脑袋的固定步数，而是对「换词绕圈子」
 * （searchConvergence 病案）的通用化——绕圈即掉动量，掉光即停车，
 * 远早于烧满 maxTurns。
 */

const { DEFAULTS, MOMENTUM_START } = require('./defaults');

function _num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function _clamp01(m) {
  if (m > 1) return 1;
  if (m < 0) return 0;
  return m;
}

/**
 * nextMomentum(prev, events, constants?) — 单轮动量推进（§3.5）。
 *
 * @param {number} prev      上一轮动量（非有限数 → 回落 MOMENTUM_START）
 * @param {string[]} events  本轮事件序列：progress | no_progress | repeat |
 *                           deny | error；未知事件忽略（绝不抛）
 * @param {object} [c]       decay 常数（缺省 DEFAULTS.decay）
 * @returns {{momentum: number, stopDecision: 'decay'|null}}
 *          momentum 已 clamp 到 [0,1]；progress 封顶 1.0；
 *          stopDecision 仅判 decay（completed 由探针在调用方判定）。
 */
function nextMomentum(prev, events, c) {
  const k = _isObj(c) ? c : DEFAULTS.decay;
  const noProgressPenalty = Math.abs(_num(k.noProgressPenalty, DEFAULTS.decay.noProgressPenalty));
  const repeatPenalty = Math.abs(_num(k.repeatPenalty, DEFAULTS.decay.repeatPenalty));
  const denyPenalty = Math.abs(_num(k.denyPenalty, DEFAULTS.decay.denyPenalty));
  const errorPenalty = Math.abs(_num(k.errorPenalty, DEFAULTS.decay.errorPenalty));
  const progressRestore = Math.abs(_num(k.progressRestore, DEFAULTS.decay.progressRestore));
  const stopBelow = _num(k.stopBelow, DEFAULTS.decay.stopBelow);

  let m = _num(prev, MOMENTUM_START);
  const list = Array.isArray(events) ? events : [];
  for (let i = 0; i < list.length; i++) {
    switch (list[i]) {
      case 'progress':
        m += progressRestore;
        break;
      case 'no_progress':
        m -= noProgressPenalty;
        break;
      case 'repeat':
        m -= repeatPenalty;
        break;
      case 'deny':
        m -= denyPenalty;
        break;
      case 'error':
        m -= errorPenalty;
        break;
      default:
        // 未知事件：忽略，绝不抛
        break;
    }
    m = _clamp01(m);
  }

  const final = Math.round(_clamp01(m) * 1e4) / 1e4;
  return {
    // 4 位小数量化：消除浮点累积漂移（1.0-0.4-0.4 = 0.19999… 会误判跌破 stopBelow）
    momentum: final,
    stopDecision: final < stopBelow ? 'decay' : null,
  };
}

/**
 * 七类停机机械判定核心（§3.4，纯函数；inertialRunService 每段末调用）。
 *
 * @param {object} s 状态快照：
 *   { completed, aborted, leaseExpired, consecutiveErrors, denies, ambiguity,
 *     turns, costCny, wallMs, idleMs, momentum }
 * @param {object} [cfg] { decay, budget, consecutiveErrorsForStop }
 * @returns {{stop: string|null, reason: string}}
 *   stop ∈ completed|external|error|privilege|ambiguity|budget|decay|null
 *
 * 判定优先级（治理类先于资源类——reason 归因更有价值，且越权/外部信号
 * 不应被「预算还够」掩盖）：
 *   completed > external > error > privilege > ambiguity > budget(idle>wall>turns>cost) > decay
 * budget.reason 细分 idle / wall / turns / cost（§3.4 预算停行）。
 */
function decideStop(s, cfg) {
  const st = _isObj(s) ? s : {};
  const c = _isObj(cfg) ? cfg : {};
  const decay = _isObj(c.decay) ? c.decay : DEFAULTS.decay;
  const budget = _isObj(c.budget) ? c.budget : DEFAULTS.budget;
  const errCap = Math.max(1, _num(c.consecutiveErrorsForStop, DEFAULTS.consecutiveErrorsForStop));

  if (st.completed === true) {
    return { stop: 'completed', reason: 'completion_probe_green' };
  }
  if (st.aborted === true) {
    return { stop: 'external', reason: 'abort_signal' };
  }
  if (st.leaseExpired === true) {
    return { stop: 'external', reason: 'lease_expired' };
  }
  if (_num(st.consecutiveErrors, 0) >= errCap) {
    return { stop: 'error', reason: 'consecutive_errors_' + errCap };
  }
  if (_num(st.denies, 0) >= Math.max(1, _num(budget.maxDenies, DEFAULTS.budget.maxDenies))) {
    return { stop: 'privilege', reason: 'deny_budget_exhausted' };
  }
  if (st.ambiguity === true) {
    return { stop: 'ambiguity', reason: 'model_decision_request' };
  }
  if (_num(st.idleMs, 0) >= Math.max(1, _num(budget.maxIdleMs, DEFAULTS.budget.maxIdleMs))) {
    return { stop: 'budget', reason: 'idle' };
  }
  if (_num(st.wallMs, 0) >= Math.max(1, _num(budget.maxWallMs, DEFAULTS.budget.maxWallMs))) {
    return { stop: 'budget', reason: 'wall' };
  }
  if (_num(st.turns, 0) >= Math.max(1, _num(budget.maxTurns, DEFAULTS.budget.maxTurns))) {
    return { stop: 'budget', reason: 'turns' };
  }
  if (_num(st.costCny, 0) >= Math.max(0, _num(budget.maxCostCny, DEFAULTS.budget.maxCostCny))) {
    return { stop: 'budget', reason: 'cost' };
  }
  if (_num(st.momentum, MOMENTUM_START) < _num(decay.stopBelow, DEFAULTS.decay.stopBelow)) {
    return { stop: 'decay', reason: 'momentum_below_stopBelow' };
  }
  return { stop: null, reason: '' };
}

function _isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

module.exports = {
  nextMomentum,
  decideStop,
};
