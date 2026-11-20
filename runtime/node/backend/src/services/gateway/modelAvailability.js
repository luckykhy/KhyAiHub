'use strict';

/**
 * modelAvailability — 单模型可用性判定的纯叶子：零 IO、确定性、绝不抛、不改入参。
 *
 * 为什么单独成叶子：上游探测刻意区分「没测到」（probe 为 null / ok:false）与
 * 「测到 0 个」（ok:true && models:[]），两者语义不同，塌成一个数字会让告警与
 * 回退都失真（[DESIGN-ARCH-218] §1.4）。把三态分流收敛到一处，调用方不再各自解释。
 *
 * 优先级：人工配置单条 > 探测结果。本函数只做判定，不取默认模型——
 * default_fallback 的具体 id 由调用方注入，叶子不替它做选择。
 *
 * @module services/gateway/modelAvailability
 */

function toIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const id = item.trim();
      if (id && !ids.includes(id)) {
        ids.push(id);
      }
      continue;
    }
    if (item && typeof item === 'object' && typeof item.id === 'string') {
      const id = item.id.trim();
      if (id && !ids.includes(id)) {
        ids.push(id);
      }
    }
  }
  return ids;
}

function classifyModelAvailability(options) {
  try {
    // 解构必须在 try 内：null 入参在参数位解构时抛的 TypeError 接不住。
    const { probe, configured } = options && typeof options === 'object' ? options : {};
    const configuredIds = toIds(configured);

    // 人工配置单条 = 唯一可用，最高优先（语义同「钉选了一个模型」）。
    if (configuredIds.length === 1) {
      return { state: 'single', modelIds: configuredIds, reason: 'only_available_model' };
    }

    if (probe && probe.ok === true) {
      const probeIds = toIds(probe.models);
      if (probeIds.length === 1) {
        return { state: 'single', modelIds: probeIds, reason: 'only_available_model' };
      }
      if (probeIds.length > 1) {
        return { state: 'multiple', modelIds: probeIds, reason: null };
      }
      // ok:true + models:[] —— 跑成了但上游没报模型，不是「没测到」。
      return { state: 'empty', modelIds: [], reason: 'default_fallback' };
    }

    // probe 为 null / ok:false —— 没测到，绝不伪装成「测到 0 个」。
    return { state: 'unprobed', modelIds: [], reason: 'default_fallback' };
  } catch {
    // 绝不抛：畸形输入退回 unprobed，把取默认模型的决策留给调用方。
    return { state: 'unprobed', modelIds: [], reason: 'default_fallback' };
  }
}

module.exports = { classifyModelAvailability };
