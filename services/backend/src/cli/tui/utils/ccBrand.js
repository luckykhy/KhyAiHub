'use strict';

/**
 * ccBrand.js —— 品牌文本集中管理
 *
 * CC 模式下所有面向用户的品牌文本。修改品牌只需改此文件。
 * 禁止在 CC 模式 UI 中出现 "Claude Code" 或 "Claude" 品牌文本。
 *
 * 参考：[DESIGN-ARCH-081] 品牌替换规范
 *
 * 定位话术（tagline 等「产品承诺」类文本）的措辞真源是
 * `src/constants/positioning.js`（INIT-PRD-004 的代码化）—— 本文件仍是 CC 模式
 * UI 文本的**消费汇聚点**，但不自写第二份承诺文案，避免品牌串漂移。
 */

const { POSITIONING } = require('../../../constants/positioning');

const BRAND = Object.freeze({
  name: 'Khy',
  fullName: 'Khy',
  logo: '✳',           // 动画星号字符
  tagline: POSITIONING.tagline,

  // UI 文本
  welcomeTitle: 'Welcome to Khy',
  welcomeSubtitle: POSITIONING.tagline,
  inputPlaceholder: 'Send a message...',
  statusBarModelPrefix: '', // 不显示 "Claude" 前缀

  // 版权/关于
  poweredBy: 'Powered by Khy',
  versionTemplate: (v) => `Khy v${v}`,
});

/**
 * 替换文本中的 Claude Code 品牌为 Khy
 * @param {string} text
 * @returns {string}
 */
function replaceBrand(text) {
  if (!text) return text;
  return text
    .replace(/Claude Code/g, BRAND.fullName)
    .replace(/\bClaude\b/g, BRAND.name)
    .replace(/claude-code/g, 'khy');
}

module.exports = { BRAND, replaceBrand };
