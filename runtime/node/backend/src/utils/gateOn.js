'use strict';

/**
 * gateOn.js — 「按名读 env 门控·委派 flagRegistry 判定」共享 helper
 *   (只读 env·委派 flagRegistry·零文件/网络 IO·无状态·绝不抛)。
 *
 * 收敛 2 处 body 逐字节相同的私有 `_gateOn(name, env)`——
 *   constants/promptCacheOrder(内部用·:60/:65)· constants/promptPrefixShape(内部用·:40)。
 *
 * 语义:env 缺省 process.env。委派 `flagRegistry.isFlagEnabled(name, e)` 判定;
 *   require flagRegistry 失败 → 保守回退「仅显式 0/false/off/no 关(其余一律开)」。绝不抛。
 *   真身自 2026-09-28 起住在本目录（D3 `utils/flagRegistry/`），非 `services/`。
 *
 * 契约:非纯(读 process.env·require flagRegistry 服务)·不 mutate 入参·绝不抛。
 *   各消费方保留同名本地 `const _gateOn = require('../utils/gateOn')`
 *   → 调用点逐字节不变。utils/ 与 constants/ 同为 src/ 直属子目录,
 *   归位批 17 后解析目标为同目录 `./flagRegistry`（D3 真身），判定语义不变。
 */

function _gateOn(name, env) {
  const e = env || process.env || {};
  try {
    const flagRegistry = require('./flagRegistry');
    return flagRegistry.isFlagEnabled(name, e);
  } catch {
    const raw = String(e[name] == null ? '' : e[name])
      .trim()
      .toLowerCase();
    return !['0', 'false', 'off', 'no'].includes(raw);
  }
}

module.exports = _gateOn;
