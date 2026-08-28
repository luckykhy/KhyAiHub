'use strict';

/**
 * nearVerb.js — 「单个短英文词打错成已知动词的近似拼」判定叶子。
 *
 * 存在的理由:一类命令把陌生 token 静默当作别的东西执行(吞词改意),
 * 其中写状态/写网络的那类(如 `goal lst` 直设目标、`pr creat` 真开 PR)
 * 必须在执行前拦下并给出建议动词。整句、多词、非 ASCII 输入不算近似拼。
 *
 * 契约:纯函数,无副作用;distance 用逐行 DP 的 Levenshtein。
 */

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * @param {string} token  已 lower 化的单个 token
 * @param {string[]} verbs 已知动词列表
 * @param {number} [maxDist=2]
 * @returns {string|null} 最近的动词(距离 ∈ [1, maxDist]);不是近似拼则 null
 */
function nearestKnownVerb(token, verbs, maxDist = 2) {
  if (typeof token !== 'string' || !/^[a-z]{2,12}$/.test(token)) return null;
  if (verbs.includes(token)) return null; // 本来就是精确动词,不是「近似拼」
  let best = null;
  let bestD = maxDist + 1;
  for (const v of verbs) {
    const d = editDistance(token, v);
    if (d < bestD) { best = v; bestD = d; }
  }
  return bestD <= maxDist ? best : null;
}

module.exports = { editDistance, nearestKnownVerb };
