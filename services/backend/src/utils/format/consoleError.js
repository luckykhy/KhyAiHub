'use strict';

/**
 * consoleError.js — 错误渲染的两个共享底座叶子（printError / printErrorPanel）。
 *
 * 拆出于 2026-09-28（[RESEARCH-018] §3.1 P2 batch 17）：两者原先住在 cli/formatters.js，
 * 而真正的调用方家族在 services 侧（错误结构化打印的单一真源 reportKhyError）；
 * 为一个渲染器把整条 services→cli 反向边留在错误路径上不划算。逐字节搬到这里，
 * cli/formatters.js 以同名 re-bind 保留导出面，故其 cli 消费点一行不改。
 *
 * 契约：纯渲染（读 process.stdout.columns 与门控 KHY_TABLE_BORDERS），不抛，不改任何状态。
 */

const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;
const tableStyle = require('./tableStyle');
const { displayWidth } = require('../text/width');

function printError(msg) {
  console.log(chalk.red('  ✗ ') + msg);
}

/**
 * Structured error panel with rounded border.
 * Shows title, message, reason, suggestions, and optional collapsed stack trace.
 *
 * @param {{ title?: string, message: string, reason?: string, suggestions?: string[], stack?: string }} opts
 */
function printErrorPanel(opts) {
  const title = opts.title || 'Error';
  const message = opts.message || '';
  const reason = opts.reason || '';
  const suggestions = opts.suggestions || [];
  const stack = opts.stack || '';

  const dim = chalk.dim;
  const borderless = tableStyle.isBorderless(process.env);
  // 无框风格:用一个红色左竖条标示「这是错误块」,而不是画一圈框。竖条 + 正文的
  // 组合让文件浏览器/编辑器里的红色断块一眼可辨,又不会像满框那样把注意力从错误
  // 文本抢到线框上。有框风格保留圆角框,供需要的老用户用 KHY_TABLE_BORDERS=full 恢复。
  const gutter = borderless ? '  ' + chalk.red.bold('│') + ' ' : dim('  │') + '  ';
  const maxW = Math.min((process.stdout.columns || 80) - 4, 72);
  const contentW = borderless ? maxW : maxW - 4;

  const lines = [];

  // Helper: wrap text to content width
  function wrapLine(text) {
    const words = text.split(/\s+/);
    const wrapped = [];
    let cur = '';
    for (const w of words) {
      if (cur && displayWidth(cur + ' ' + w) > contentW) {
        wrapped.push(cur);
        cur = w;
      } else {
        cur = cur ? cur + ' ' + w : w;
      }
    }
    if (cur) {
      wrapped.push(cur);
    }
    return wrapped.length ? wrapped : [''];
  }

  // Helper: render a content line. 无框时右侧不画 │,正文可随终端宽度自然换行。
  function addLine(text) {
    if (borderless) {
      lines.push(gutter + text);
      return;
    }
    const w = displayWidth(text);
    const pad = Math.max(0, contentW - w);
    lines.push(dim('  │') + '  ' + text + ' '.repeat(pad) + dim('│'));
  }

  function addEmpty() {
    if (borderless) {
      lines.push('');
      return;
    }
    lines.push(dim('  │') + ' '.repeat(contentW + 2) + dim('│'));
  }

  // Title bar
  if (borderless) {
    lines.push(chalk.red.bold(`  ✗ ${title}`));
  } else {
    const titleText = ` ✗ ${title} `;
    const titleW = displayWidth(titleText);
    const dashCount = Math.max(0, maxW - titleW - 2);
    lines.push(dim('  ╭─') + chalk.red.bold(titleText) + dim('─'.repeat(dashCount) + '╮'));
  }

  addEmpty();

  // Message
  for (const ml of wrapLine(message)) {
    addLine(ml);
  }

  // Reason
  if (reason) {
    addEmpty();
    for (const rl of wrapLine('Reason: ' + reason)) {
      addLine(chalk.yellow(rl));
    }
  }

  // Suggestions
  if (suggestions.length > 0) {
    addEmpty();
    addLine(chalk.dim('Suggestions:'));
    for (let i = 0; i < suggestions.length; i++) {
      for (const sl of wrapLine(`${i + 1}. ${suggestions[i]}`)) {
        addLine('  ' + sl);
      }
    }
  }

  // Stack (collapsed hint)
  if (stack) {
    addEmpty();
    addLine(chalk.dim('▸ Stack trace (ctrl+o to expand)'));
  }

  if (!borderless) {
    addEmpty();
    lines.push(dim('  ╰' + '─'.repeat(maxW) + '╯'));
  }

  console.log('');
  lines.forEach((l) => console.log(l));
  console.log('');
}

module.exports = { printError, printErrorPanel };
