'use strict';

/**
 * bootScreenSwitch — 「启动屏要不要画」的唯一判据。
 *
 * 两个消费者：ink-components/BootScreen.js（Ink 版启动屏）与 bootFrameAnsi.js
 * （Ink 装载之前那一帧裸 ANSI 品牌字标）。此前判据只写在 BootScreen.js 里，
 * 后者要复用就得 require 它 —— 而它 require React，于是「先问一句要不要画」会把
 * 整张 React 图拉进首帧之前，正好抵消这一帧要省下的钱。所以判据下沉成零依赖叶子。
 *
 * 纪律：零 IO、绝不抛、不读文件。（env 由调用方传入，缺省值仅为兼容既有调用。）
 */

const OFF_VALUES = Object.freeze(['0', 'false', 'off', 'no', 'legacy']);

function isBootScreenEnabled(env = process.env) {
  const v = String((env && env.KHY_BOOT_SCREEN) || '').trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

module.exports = { OFF_VALUES, isBootScreenEnabled };
