'use strict';

/**
 * slashCommandFilter.js — 斜杠命令选择器的纯排序内核（从 repl.js startRepl 闭包抽出）。
 *
 * 仅承载「给定命令表 + 过滤串 → 按相关度排序的命令子集」这一无副作用逻辑，
 * 不触碰任何渲染/readline/缓存状态，因此可独立单测。repl.js 的 _filterSlashCommands
 * 以 _getSlashCommands() 的结果为入参调用本函数。
 *
 * 评分（高→低）：命令前缀 > 命令子串 > 标签子串 / 描述子串。
 */

// 每命令的小写投影（cmd/label/desc）是静态的，只有 filter 逐键变化。按命令表身份记忆
// 该投影，避免每次按键对全量命令表重复 toLowerCase；门控关 → 现算，逐字节回退。
const _slashRankIndexMemo = require('./slashRankIndexMemo');

/** 现算命令表的小写投影（记忆首算 / 门控关时的回退路径共用）。保持与命令表等长同序。 */
function _buildRankIndex(list) {
  const idx = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const sc = list[i];
    idx[i] = {
      sc,
      cmdLower: String((sc && sc.cmd) || '').toLowerCase(),
      labelLower: String((sc && sc.label) || '').toLowerCase(),
      descLower: String((sc && sc.desc) || '').toLowerCase(),
    };
  }
  return idx;
}

/**
 * Gate for the two low-confidence tiers (label / desc substring).
 *
 * They match free text, so a SHORT LATIN needle hits letters inside unrelated
 * descriptions: on the live 257-command table `/co` yielded 119 rows of which 101 were
 * desc-only ("authenticate", "python", "claude code"…), `/st` 76/57 and `/re` 76/47 —
 * the menu paged out to 12 screens. Below 3 latin chars these tiers are pure noise, so
 * they stay closed. CJK needles are exempt: one han character carries more than two
 * latin letters and labels themselves are only 2–4 chars wide.
 * The prefix and command-substring tiers are untouched, so `/pr` → `/autofix-pr` holds.
 */
function lowConfidenceTierAllowed(needle) {
  return !/^[\x20-\x7e]+$/.test(needle) || needle.length >= 3;
}

/**
 * @param {Array<{cmd:string,label?:string,desc?:string}>} cmds 命令表
 * @param {string} filter 形如 "/mo" 的过滤串（含前导 '/'）；空或仅 '/' 时返回全量副本
 * @returns {Array<object>} 按相关度降序的命令子集（稳定排序，保留同分原序）
 */
function rankSlashCommands(cmds, filter) {
  const list = Array.isArray(cmds) ? cmds : [];
  if (!filter || filter === '/') {
    return list.slice();
  }

  const lower = String(filter).toLowerCase();
  const needle = lower.slice(1); // 去掉前导 '/'
  const lowTier = lowConfidenceTierAllowed(needle);

  // 小写投影按命令表身份记忆；门控关 / 非对象 / 异常 → 现算（逐字节回退）。
  const index = _slashRankIndexMemo.getRankIndex(list, () => _buildRankIndex(list), process.env);

  const scored = [];
  for (let i = 0; i < index.length; i++) {
    const it = index[i];
    let score = 0;
    if (it.cmdLower.startsWith(lower)) {
      score = 3;
    } // /mo → /model
    else if (it.cmdLower.includes(needle)) {
      score = 2;
    } // sub → /subscribe
    else if (lowTier && it.labelLower.includes(needle)) {
      score = 1;
    } // 模型 → label match
    else if (lowTier && it.descLower.includes(needle)) {
      score = 1;
    } // desc match

    if (score > 0) {
      scored.push({ sc: it.sc, score, idx: i });
    }
  }

  // 稳定排序：先按分数降序，同分按原始下标升序，保持原序观感
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.map((s) => s.sc);
}

module.exports = { rankSlashCommands };
