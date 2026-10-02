'use strict';
/**
 * doctorReport.js — pure layout for `khy doctor` console/JSON report (轮二十八).
 *
 * 病症:37 项检查结果平铺成 40+ 行等权重输出,警告与通过混在一起;
 * 具体修复指引藏在渲染器尾部 7 个 `checks.find(label)` 特判块里——
 * 检查项改名即静默失联(数据存在,入口拒答的 helpCard 同族病)。
 *
 * 契约:零 IO 纯函数(输入 = 检查项数组,输出 = 已着色字符串行数组)、
 * fail-soft(任何一项缺 summary/fix 只降级为从 detail 推导,绝不抛)、
 * 行宽裁剪到终端 columns(ANSI 感知,--verbose 关闭裁剪并展示 note)。
 *
 * 检查项字段约定(语义真源在本文件 JSDoc,生产方为 handlers/init.js、
 * handlers/doctorConnectivity.js、services/freshInstallDoctor.js):
 *   { category, label, ok, detail, level,          // 既有字段,不改名
 *     summary?,   // ≤40 display 宽的一句话结论(ok 项也必须有)
 *     fix?,       // 可执行的修复动作(一行命令或一步操作;warn/fail 必填其一)
 *     note?       // 补充背景,仅 --verbose / 行动清单缺 fix 时展示
 *   }
 * 不变式:!ok 的项必须有 fix 或 note(守卫 tests/cli/doctorReport.test.js)。
 */

const chalk = require('chalk');
const { displayWidth, truncateToWidth } = require('./formatters');

// summary 的展示宽度上限(display columns,含省略号)。
const SUMMARY_MAX_WIDTH = 40;

const ANSI_RESET = '\x1b[0m';

function _clip(line, maxWidth) {
  const out = truncateToWidth(line, maxWidth);
  return displayWidth(out) < displayWidth(line) ? out + ANSI_RESET : out;
}

/**
 * Per-item machine status for --json: ok|warn|fail, derived (never stored field).
 */
function itemStatus(item) {
  if (item && item.ok) return 'ok';
  return item && item.level === 'warn' ? 'warn' : 'fail';
}

/**
 * Normalize one check item: attach derived `status`, fail-soft `summary`
 * fallback from `detail`, and cap summary display width.
 */
function decorateCheck(item) {
  const decorated = { ...item, status: itemStatus(item) };
  const raw = String(item.summary || '').trim();
  if (raw) {
    decorated.summary = _clip(raw, SUMMARY_MAX_WIDTH);
  } else {
    // Fail-soft fallback for third-party add-on items lacking summary.
    decorated.summary = _clip(String(item.detail || '').trim(), SUMMARY_MAX_WIDTH);
  }
  return decorated;
}

function decorateChecks(checks) {
  return (checks || []).map(decorateCheck);
}

function countChecks(checks) {
  let ok = 0;
  let warn = 0;
  let fail = 0;
  for (const item of checks || []) {
    if (item.ok) ok++;
    else if (item.level === 'warn') warn++;
    else fail++;
  }
  return { ok, warn, fail, total: (checks || []).length };
}

function _icon(item) {
  if (item.ok) return chalk.green('✓');
  return item.level === 'warn' ? chalk.yellow('⚠') : chalk.red('✗');
}

// ── 行动清单(置顶)──────────────────────────────────────────────────────────

/**
 * 「✋ 需要处理 N 项」:all !ok items, label + summary + 修复/说明 一行动作。
 * 全绿时返回 []  (调用方不出该段)。
 */
function buildActionLines(checks, { width = 80 } = {}) {
  const pending = (checks || []).filter((c) => !c.ok);
  if (pending.length === 0) return [];
  const failCount = pending.filter((c) => c.level !== 'warn').length;
  const lines = [];
  lines.push('');
  const head =
    `  ${chalk.red.bold('需要处理 ' + pending.length + ' 项')}` +
    (failCount > 0 ? chalk.dim(`（其中 ${failCount} 项影响核心功能）`) : chalk.dim('（均为可选功能）'));
  lines.push(head);
  for (const item of pending) {
    lines.push(_clip(`    ${_icon(item)} ${chalk.bold(item.label)} — ${item.summary || ''}`, width));
    const action = item.fix ? { tag: '修复', text: item.fix } : item.note ? { tag: '说明', text: item.note } : null;
    if (action) {
      lines.push(_clip(`      ${chalk.dim(action.tag + ':')}${chalk.cyan(' ' + action.text)}`, width));
    }
  }
  lines.push('');
  return lines;
}

// ── 分组全量清单 ─────────────────────────────────────────────────────────────

/**
 * Category-grouped full list (既有布局),detail 单行裁剪到终端宽度;
 * verbose 时不裁剪 detail 并追加 note 行。
 */
function buildGroupedLines(checks, { width = 80, verbose = false } = {}) {
  const categories = {};
  for (const item of checks || []) {
    if (!categories[item.category]) categories[item.category] = [];
    categories[item.category].push(item);
  }
  const lines = [];
  for (const [category, items] of Object.entries(categories)) {
    lines.push(chalk.cyan(`  ${category}`));
    for (const item of items) {
      const detailText = verbose ? String(item.detail || '') : String(item.detail || '').replace(/\s+/g, ' ');
      const line = `    ${_icon(item)} ${item.label}${detailText ? chalk.dim(` — ${detailText}`) : ''}`;
      lines.push(verbose ? line : _clip(line, width));
      if (verbose && item.note) {
        lines.push(_clip(chalk.dim(`      说明: ${String(item.note).replace(/\s+/g, ' ')}`), width));
      }
    }
    lines.push('');
  }
  return lines;
}

// ── 总计 + 收尾建议 ──────────────────────────────────────────────────────────

function buildSummaryLines(counts) {
  const parts = [];
  if (counts.ok > 0) parts.push(chalk.green(`${counts.ok} 通过`));
  if (counts.warn > 0) parts.push(chalk.yellow(`${counts.warn} 警告`));
  if (counts.fail > 0) parts.push(chalk.red(`${counts.fail} 失败`));
  const lines = [`  ${chalk.bold('总计:')} ${parts.join(' · ')}`];
  lines.push('');
  if (counts.fail > 0) {
    lines.push(`  ${chalk.yellow('ℹ')} 按上方行动清单逐项处理后可重跑 ${chalk.cyan('khy doctor')} 复查`);
  } else if (counts.warn > 0) {
    lines.push(chalk.dim('  所有核心功能正常，警告项均为可选功能'));
  } else {
    lines.push(`  ${chalk.green('✔ 所有检查通过，系统就绪')}`);
  }
  return lines;
}

/**
 * Full console report (行动清单置顶 → 分组全量 → 总计)。Returns colored lines;
 * handleDoctor prints. Maintenance footer stays with the caller.
 */
function renderConsoleReport(checks, { verbose = false, width } = {}) {
  const w = Math.max(40, width || process.stdout.columns || 80);
  const decorated = decorateChecks(checks);
  const lines = [];
  lines.push(...buildActionLines(decorated, { width: w }));
  lines.push(...buildGroupedLines(decorated, { width: w, verbose }));
  lines.push(...buildSummaryLines(countChecks(decorated)));
  return lines;
}

module.exports = {
  SUMMARY_MAX_WIDTH,
  itemStatus,
  decorateCheck,
  decorateChecks,
  countChecks,
  buildActionLines,
  buildGroupedLines,
  buildSummaryLines,
  renderConsoleReport,
};
