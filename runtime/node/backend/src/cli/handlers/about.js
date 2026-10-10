'use strict';

/**
 * about.js — `khy about`：产品定位面（INIT-PRD-004 的代码化）。
 *
 * 回答两件此前只有文档才回答的事：
 *   1. 这个产品是给谁的、承诺什么（tagline / 一句话定位 / 四条主张 / 目标用户）；
 *   2. 名字里的 "OS" 凭什么成立（壳→漏斗→网关运行时 + 可增删的内核/应用/拓展）。
 *
 * 措辞单一真源：`src/constants/positioning.js`（纯叶子）。本 handler 只做渲染，
 * 不写第二份文案 —— 改定位话术只改真源一处，横幅与 about 自动跟随。
 *
 * 自注册命令（commandAutoRegistry）：无需改 router.js 的 switch，manifest 即注册。
 */

const { MANIFEST_EXPORT_KEY } = require('../commandManifest');
const { POSITIONING } = require('../../constants/positioning');

function fmt() {
  return require('../formatters');
}

/** 渲染行集合（抽出来供单测断言内容，console 只负责打印）。 */
function buildAboutLines(version) {
  const lines = [];
  lines.push(`khy OS v${version || '?'}`);
  lines.push(POSITIONING.tagline);
  lines.push('');
  lines.push(POSITIONING.oneLiner);
  lines.push('');
  lines.push('为谁而做：' + POSITIONING.audience);
  lines.push('');
  lines.push('凭什么需要（对照直接用单一家工具）：');
  for (const claim of POSITIONING.claims) {
    lines.push(`  · ${claim.title} —— ${claim.body}`);
  }
  lines.push('');
  lines.push(POSITIONING.os.headline + '：');
  lines.push('  ' + POSITIONING.os.body);
  for (const layer of POSITIONING.os.layers) {
    lines.push('  ' + layer);
  }
  lines.push('');
  lines.push('定位与增长路线全文：' + POSITIONING.doc);
  return lines;
}

async function handleAbout() {
  const chalkModule = require('chalk');
  const chalk = chalkModule.default || chalkModule;
  const d = chalk.dim;
  let version = '';
  try {
    // 本文件在 src/cli/handlers/ 下：上跳三层到 services/backend/。
    version = require('../../../package.json').version;
  } catch {
    /* fail-soft: 版本未知就显示 ? */
  }

  const lines = buildAboutLines(version);
  console.log('');
  lines.forEach((line, i) => {
    if (i === 0) {
      console.log('  ' + chalk.bold(line) + d('  ·  ' + (lines[1] || '')));
    } else if (i === 1) {
      /* tagline 已并入首行，跳过 */
    } else {
      console.log('  ' + line);
    }
  });
  console.log('');
  return true;
}

module.exports = {
  handleAbout,
  buildAboutLines,
  [MANIFEST_EXPORT_KEY]: {
    name: 'about',
    aliases: ['关于', 'guanyu'],
    description: '产品定位一览：为谁做、凭什么、OS 之名何来（INIT-PRD-004）',
    usage: 'about',
    subCommands: [],
    category: 'system',
    handler: handleAbout,
  },
};
