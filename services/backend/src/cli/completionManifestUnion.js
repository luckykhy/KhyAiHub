'use strict';

/**
 * completionManifestUnion — 让 router.getCompletions 并入 manifest 动词(纯叶子门控)。
 *
 * 根因(Tab 补全对 manifest 动词一律隐身, 审计 #18): router.js 的静态子命令表来自
 * `commandSchema.getRouterSubCommands()`,其合并守卫是 `!out[def.name]` —— **已在静态
 * ROUTER_SUB_COMMANDS 里的命令,manifest 追加的 subCommands 永不进表**。但派发通道
 * `commandAutoRegistry._alignSubCommand` 只看 manifest ⇒ 动词**敲得到、Tab 补不出来**。
 * 实测 6 命令受影响: backup 隐 new/ls/check/clean、project 隐 analysis/struct/mini/
 * find/search、selfheal 隐 status/index/test、metadata 隐 help、proxy 隐 core、
 * maintain 隐 bare(存证 .khy/feedback/tab-completion-union-round15/repro-before.txt)。
 *
 * 本叶子只做门控判定(与 inlineOptionParse/completionKeysLazy 同族约定):
 *   • isEnabled(env):门控 KHY_COMPLETION_MANIFEST_UNION 默认开;0/false/off/no 关。
 *   • union(staticSubs, manifestSubs):两侧都并入、去重、保持「静态在前」的原顺序;
 *     任一侧非数组 → 原样返回另一侧。零 IO、确定性、绝不抛。
 *
 * 关 → 调用方逐字节回退历史行为(只读静态表)。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_COMPLETION_MANIFEST_UNION;
  const v = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * @param {string[]|undefined} staticSubs   静态表动词(可为 undefined = 命令不在静态表)
 * @param {string[]|undefined} manifestSubs manifest 声明动词(占位提取失败时可能为空)
 * @returns {string[]} 去重并集;静态在前,manifest 追加
 */
function union(staticSubs, manifestSubs) {
  try {
    const a = Array.isArray(staticSubs) ? staticSubs : [];
    const b = Array.isArray(manifestSubs) ? manifestSubs : [];
    if (!b.length) return [...a];
    return [...new Set([...a, ...b])];
  } catch {
    return Array.isArray(staticSubs) ? [...staticSubs] : [];
  }
}

module.exports = { isEnabled, union };
