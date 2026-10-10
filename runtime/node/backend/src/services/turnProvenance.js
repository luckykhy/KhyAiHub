'use strict';

/**
 * 回合出处（provenance）的唯一判定叶子。
 *
 * 达成率的分母必须能把「真人请求」与「测试/自动化请求」分开：实测夹具流量占工具调用
 * 22.8% 且 100% 失败，占全部失败的 72.6%，混在一起读任何比率都是假的。
 *
 * 规则：显式值优先（调用方知道自己是谁），其次由测试运行器环境推导，最后才是 null
 * （未标注）。绝不把 null 猜成「真人」——那正是这次要修的错。
 *
 * @param {string|null} [explicit] 调用方显式传入的出处（options.turnSource）
 * @param {object} [env]
 * @returns {string|null}
 */
function resolveTurnSource(explicit, env) {
  const e = env || process.env;
  const v = String(explicit || e.KHY_TURN_SOURCE || '').trim();
  if (v) {
    return v.slice(0, 40);
  }
  // jest 在 worker 里注入 JEST_WORKER_ID；node --test 走 NODE_TEST_CONTEXT/NODE_ENV。
  if (e.JEST_WORKER_ID !== undefined || e.NODE_TEST_CONTEXT !== undefined || e.NODE_ENV === 'test') {
    return 'test';
  }
  return null;
}

module.exports = { resolveTurnSource };
