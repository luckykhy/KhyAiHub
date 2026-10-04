'use strict';

/**
 * consoleNotice.js — the terminal notice printers (✓ / ⚠ / i-prefixed lines).
 *
 * Home of record since 2026-09-28 ([RESEARCH-018] §3.1 P2 batch 15). These four lines
 * of output are the most-required capability in the repo, and `services/gatewayResetService`
 * needed them too — reaching up into `cli/formatters` for them was a reverse-layering
 * edge. They are pure output formatters (deterministic, no state, no IO beyond stdout),
 * so the shared substrate D3 is their home: `cli/formatters` now re-binds them, keeping
 * its export surface and all 159 cli consumers untouched.
 *
 * Whether a *service* should print at all is a separate behaviour question, deliberately
 * NOT decided here (relocation and behaviour change are cut in two passes).
 */

const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;

const { displayWidth } = require('../text/width');

function printSuccess(msg) {
  console.log(chalk.green('  ✓ ') + msg);
}

function printWarn(msg) {
  console.log(chalk.yellow('  ⚠ ') + msg);
}

// 启动屏的通知行历史上一律挂同一个前缀，一屏下来全是重复的字母，
// 看不出哪条讲登录、哪条讲版本。传了 label 就改成中文词前缀（「登录」「版本」
// 「清理」），靠词本身区分场景，不引入 emoji（仓库约定见 cli/formatters.js 顶部的
// minimal icons, no emoji）。label 按显示宽度而不是字符数补齐：中文字占 2 列，
// 英文占 1 列，按 length 补会把混排的正文顶歪。
// 不传 label 时用 ASCII 'i' 前缀，避免 Windows 终端 ℹ (U+2139) 渲染为方块。
const NOTICE_LABEL_WIDTH = 4;

function printInfo(msg, label) {
  if (typeof label === 'string' && label.length > 0) {
    const pad = ' '.repeat(Math.max(0, NOTICE_LABEL_WIDTH - displayWidth(label)));
    console.log('  ' + chalk.blue(label) + pad + '  ' + msg);
    return;
  }
  console.log(chalk.blue('  i ') + msg);
}

module.exports = { printSuccess, printWarn, printInfo, NOTICE_LABEL_WIDTH };
