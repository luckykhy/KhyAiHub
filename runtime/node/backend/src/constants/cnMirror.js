'use strict';

/**
 * cnMirror.js — 国内镜像开关（`PROCESS-013`）—— 默认关闭，必须用户**显式 opt-in**。
 *
 * 与 Python 侧 `runtime/substrate/platform/khy_platform/cn_mirror.py` 同构（跨语言两份实现无法合并，
 * 故两边的判据与取值表必须逐字对齐；守卫 `check-native-registry.js` 对两个文件都
 * 要求出现开关名 `KHY_USE_CN_MIRROR`）。
 *
 * ## 为什么不再按 locale 猜
 *
 * 原实现按 `LANG`/`TZ` 判断「你在国内 ⇒ 自动用公共镜像」。问题不是用户体验，
 * 而是**不可复现**：同一份代码在两台机器上会从不同源取包，镜像同步延迟时甚至
 * 拿到旧版本，而流程照样成功 —— 出问题时无从判断包到底来自哪里。
 *
 * 改为显式开关后默认一律官方源，需要加速的用户一键可用。
 *
 * 零依赖：`setup.js` 在 `npm install` **之前**运行，此时 node_modules 还不存在，
 * 所以本模块不能 require 任何第三方包。
 */

/** 唯一的开关名。运行时要用镜像，必须让这个名字出现在使用处所在的文件里。 */
const ENV_FLAG = 'KHY_USE_CN_MIRROR';

/** 视为「开」的取值（大小写不敏感）。 */
const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'enable', 'enabled']);

/** 官方源（默认路径）。 */
const NPM_REGISTRY_OFFICIAL = 'https://registry.npmjs.org';
const PIP_INDEX_OFFICIAL = 'https://pypi.org/simple/';

/** 国内镜像（仅在显式 opt-in 后使用）。 */
const NPM_REGISTRY_CN = 'https://registry.npmmirror.com';
const PIP_INDEX_CN = 'https://mirrors.aliyun.com/pypi/simple/';

/**
 * 是否启用国内镜像。**默认 false**（官方源）。
 * 只看显式开关，不做任何 locale / TZ 猜测。
 * @param {object} [env]
 * @returns {boolean}
 */
function cnMirrorEnabled(env) {
  const source = env && typeof env === 'object' ? env : process.env;
  try {
    const raw = source && source[ENV_FLAG];
    return TRUTHY.has(String(raw == null ? '' : raw).trim().toLowerCase());
  } catch {
    return false;
  }
}

/** npm registry 地址：默认官方，显式 opt-in 后为国内镜像。 */
function npmRegistry(env) {
  return cnMirrorEnabled(env) ? NPM_REGISTRY_CN : NPM_REGISTRY_OFFICIAL;
}

/** pip index 地址：默认官方，显式 opt-in 后为国内镜像。 */
function pipIndex(env) {
  return cnMirrorEnabled(env) ? PIP_INDEX_CN : PIP_INDEX_OFFICIAL;
}

module.exports = {
  ENV_FLAG,
  TRUTHY,
  NPM_REGISTRY_OFFICIAL,
  NPM_REGISTRY_CN,
  PIP_INDEX_OFFICIAL,
  PIP_INDEX_CN,
  cnMirrorEnabled,
  npmRegistry,
  pipIndex,
};
