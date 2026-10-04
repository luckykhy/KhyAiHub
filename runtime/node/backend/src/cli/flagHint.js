/**
 * flagHint.js — 打错的旗标不再静默失效（Rule 2 透明，轮二十）。
 *
 * 病症：`khy health --jsonn`（多敲一个 n）解析成 options.jsonn=true，没有任何
 * 消费方读它，处理器走无旗标分支——rc 照样 0，输出照样是文本表格。用户以为拿到
 * 的是 JSON，管道下游 `| jq` 才炸，且报错点在第三方程序里，排查方向整个偏掉。
 *
 * 药方刻意保守——**只提示、不改行为、不占 stdout**：
 *   词表 = 该命令 manifest `usage` 里出现过的 `--旗标` + 全局旗标；
 *   仅当「用户敲的旗标不在词表」且「与词表某成员编辑距离 ≤2」时，向 stderr 出
 *   一行「可能未生效 + 是否想用 --X」。完全不在词表附近的手敲旗标**不报**——
 *   未见于 usage 但被处理器合法消费的旗标确实存在，静默优先于误报。
 *
 * 关闭开关：KHY_FLAG_HINT=off|0（同 session_recall 家族的 kill-switch 惯例）。
 */
'use strict';

/** 派发喉口自身消费的全局旗标，永不提示。 */
const GLOBAL_FLAGS = Object.freeze(['help', 'verbose', 'debug']);

/** 短于此的键/候选不互相提议：2-3 字符的编辑距离噪音率太高。 */
const MIN_LEN = 4;
const MAX_DISTANCE = 2;

/** command → Set<flagName>（懒建、进程内缓存；manifest 静态，无失效问题）。 */
const _vocabCache = new Map();

function _usageVocab(command) {
  if (_vocabCache.has(command)) return _vocabCache.get(command);
  let vocab = new Set();
  try {
    const reg = require('./commandAutoRegistry');
    const canonical = reg.getAliases()[command] || command;
    const entry = reg.getCompletions().find((c) => c.name === canonical);
    const usage = entry ? String(entry.usage || '') : '';
    for (const m of usage.matchAll(/--([A-Za-z][\w-]*)/g)) vocab.add(m[1]);
    for (const g of GLOBAL_FLAGS) vocab.add(g);
  } catch {
    vocab = new Set();
  }
  _vocabCache.set(command, vocab);
  return vocab;
}

/** 上界截断的 Levenshtein：超过 max 即弃，够小才参与建议。 */
function _distanceCapped(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function _bestCandidate(keyLower, vocab) {
  let best = null;
  let bestD = MAX_DISTANCE + 1;
  for (const v of vocab) {
    const vl = v.toLowerCase();
    if (vl.length < MIN_LEN) continue;
    const d = _distanceCapped(keyLower, vl, MAX_DISTANCE);
    if (d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return bestD <= MAX_DISTANCE ? best : null;
}

/**
 * 派发前的一次性体检。绝不 throw——提示坏了不能影响命令本身。
 * @param {string} command 规范命令名（parseInput 已做别名归一）
 * @param {Object} options parseInput 的旗标对象（kebab 原样键）
 */
function hintUnknownFlags(command, options) {
  const off = process.env.KHY_FLAG_HINT;
  if (off === 'off' || off === '0') return;
  if (!command || !options || typeof options !== 'object') return;
  const vocab = _usageVocab(String(command));
  if (vocab.size <= GLOBAL_FLAGS.length) return; // usage 没声明任何旗标 → 无词表可对照
  for (const key of Object.keys(options)) {
    const k = String(key);
    if (vocab.has(k)) continue;
    if (GLOBAL_FLAGS.includes(k.toLowerCase())) continue;
    if (k.length < 3) continue;
    const best = _bestCandidate(k.toLowerCase(), vocab);
    if (best && best !== k) {
      process.stderr.write(
        `  i 提示: 旗标 --${k} 不在 \`khy ${command}\` 的用法中(可能未生效)；是否想用 --${best}？\n`
      );
    }
  }
}

module.exports = { hintUnknownFlags, _distanceCapped, _usageVocab };
