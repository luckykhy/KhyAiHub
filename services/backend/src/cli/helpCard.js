'use strict';
/**
 * helpCard.js — 纯叶子:`khy help <命令>` 的卡片(轮二十五)。
 *
 * 病症:`khy help doc` / `khy help config` 报「未知帮助主题: doc」,只列
 * gateway|quant|ops 三个主题——但派发器认识全部 256 个顶层命令,manifest 里
 * usage/subCommands 数据俱在。**数据存在,入口拒答**,且 ✗ 后 rc 仍 0。
 *
 * 契约:零 IO(返回字符串数组,由 router 打印)、fail-soft 绝不抛、
 * kill switch KHY_HELP_CARD=off|0 → 返回 null 逐字节回退旧行为。
 * 主题优先:gateway/quant/ops 及其同义词永远让位给 formatters.printHelpTopic
 * 的富主题帮助(TOPIC_SYNONYMS 镜像其 _normalizeHelpTopic;该函数未导出,
 * 漂移由 helpCard.test.js 的主题不生成用例兜底)。
 */

// 与 formatters._normalizeHelpTopic(router 调用面)同词表——命中即不出卡。
const TOPIC_SYNONYMS = Object.freeze([
  'gateway', 'gw', 'model', 'models', '网关', '模型',
  'quant', 'khyquant', 'trade', 'trading', '量化', '交易',
  'ops', 'doctor', 'devops', '运维', '诊断', '排障',
]);

function isEnabled(env) {
  const raw = env && env.KHY_HELP_CARD;
  const v = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/**
 * @param {string} topic 用户敲的 `help <topic>` 位置参
 * @param {object} [env]
 * @returns {string[] | null} 卡片行;null = 不出卡(调用方走原主题帮助路径)
 */
function build(topic, env = process.env) {
  try {
    if (!isEnabled(env)) return null;
    const t = String(topic == null ? '' : topic).trim().toLowerCase();
    if (!t) return null;
    if (TOPIC_SYNONYMS.includes(t)) return null;

    const reg = require('./commandAutoRegistry');
    const canonical = reg.getAliases()[t] || t;
    const { getRouterSubCommands } = require('../constants/commandSchema');
    const subs = getRouterSubCommands()[canonical] || [];
    const entry = reg.getCompletions().find((c) => c.name === canonical);
    if (!entry && subs.length === 0) return null;

    const lines = [];
    lines.push(`  khy ${canonical}${entry && entry.description ? ' — ' + entry.description : ''}`);
    if (entry && entry.usage && entry.usage !== canonical) {
      lines.push(`  用法: khy ${entry.usage}`);
    }
    if (subs.length > 0) {
      lines.push(`  子命令: ${subs.join(' | ')}`);
    }
    if (canonical !== t) {
      lines.push(`  (「${t}」是「${canonical}」的别名)`);
    }
    return lines;
  } catch {
    return null;
  }
}

module.exports = { isEnabled, build };
