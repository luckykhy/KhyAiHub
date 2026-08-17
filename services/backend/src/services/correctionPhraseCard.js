'use strict';

/**
 * correctionPhraseCard.js — 「校准话术」判定纯叶子（[DESIGN-ARCH-163] D5，零 IO、
 * 确定性、绝不抛、可单测）。
 *
 * 场景：上一条助手回复含 UI/代码产物，用户下一条消息**不含图**却命中修正句式
 * （「应该是…而不是…」「颜色/字号/间距」等）。指南 §2.4.2 的对策是把模糊反馈引向
 * 「精确到 px / 色值」的确定性输入——即附一行五类骨架模板。
 *
 * 落地阶段（PROCESS-008，登记 FEATURE-OWNERSHIP.json → image-calibrate-hint-skeleton）：
 * **S1 只记录命中样本，绝不改写用户消息**。`effectiveMode()` 在阶段 < S3 时把
 * 'on'（注入档）一律收敛为 'log'；升 S3 前不允许有任何注入路径存在。
 */

// 阶段权威常量（PROCESS-008 登记：FEATURE-OWNERSHIP.json → image-calibrate-hint-skeleton）。
// S1 观察期铁律：低于 S3 时 'inject' 档一律收敛为 'log'，不存在任何注入代码路径。
// 升阶 = 人工裁决改此常量（一次只升一阶，PP-6），并同步登记表 stage/previousStage。
const KHY_CALIBRATE_HINT_STAGE = 'S1';
const _STAGE_ORDER = { S1: 1, S2: 2, S3: 3, S4: 4 };

// 五类修正句式关键词表（确定性、可审计；源自指南 §2.4.2 五分类）。
const PHRASE_CATEGORIES = Object.freeze({
  尺寸偏差: ['太大', '太小', '大一点', '小一点', '宽一点', '窄一点', '高一点', '矮一点',
    '间距', '字号', '字体大小', '太粗', '太细', 'padding', 'margin', 'too big', 'too small', 'spacing'],
  颜色偏差: ['颜色', '色值', '配色', '底色', '背景色', '太亮', '太暗', '偏色', 'too dark', 'too bright'],
  遗漏元素: ['少了', '漏了', '没显示', '不见了', '缺了', '看不到', 'missing', 'not shown', 'disappeared'],
  逻辑错误: ['逻辑', '不对', '报错', '白屏', '没反应', '无响应', '失效', 'broken', 'not working', "doesn't work"],
  文字错误: ['错别字', '文案', '写错', '拼写', '字错', 'typo', 'wording'],
});

const _OFF_VALUES = new Set(['off', '0', 'false', 'no']);

/**
 * 观测/注入开关。KHY_IMAGE_CALIBRATE_HINT ∈ {off,0,false,no} → 'off'；
 * ∈ {on,inject,1,true} → 'inject'；其余（含未设）→ 默认 'log'。
 * @returns {'off'|'log'|'inject'}
 */
function hintMode(env = process.env) {
  const raw = String((env && env.KHY_IMAGE_CALIBRATE_HINT) == null ? '' : (env && env.KHY_IMAGE_CALIBRATE_HINT))
    .trim()
    .toLowerCase();
  if (_OFF_VALUES.has(raw)) {
    return 'off';
  }
  if (raw === 'on' || raw === 'inject' || raw === '1' || raw === 'true') {
    return 'inject';
  }
  return 'log';
}

/**
 * 实际生效档：阶段 < S3 时 'inject' 一律收敛为 'log'（不注入任何骨架）。
 * @returns {'off'|'log'}
 */
function effectiveMode(env = process.env) {
  const m = hintMode(env);
  if (m === 'off') return 'off';
  if (m === 'inject' && (_STAGE_ORDER[KHY_CALIBRATE_HINT_STAGE] || 1) < 3) return 'log';
  return m;
}

/**
 * 命中了哪些修正句式类别（每类记第一个命中的关键词）。大小写不敏感。
 * @param {string} text
 * @returns {Array<{category:string, keyword:string}>} 无命中 → []
 */
function classifyCorrectionPhrase(text) {
  const s = String(text == null ? '' : text).toLowerCase();
  if (!s.trim()) return [];
  const hits = [];
  for (const [category, keywords] of Object.entries(PHRASE_CATEGORIES)) {
    for (const keyword of keywords) {
      if (s.includes(String(keyword).toLowerCase())) {
        hits.push({ category, keyword });
        break;
      }
    }
  }
  return hits;
}

// 代码/UI 产物形态（保守正则；配合 block-array 安全取文，见 [content-block-array] 家族）。
const _ARTIFACT_RE = /```|<div|<span|<button|<p\b|className\s*=|\.(vue|tsx|jsx|html|css)\b/i;

function _messageText(msg) {
  const c = msg && msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : ''))
      .join('\n');
  }
  return '';
}

/**
 * 上一条助手回复是否含 UI/代码产物。
 * @param {Array} [messages] 会话消息（content 为 string 或 block-array，均安全）
 * @returns {true|false|null} 无助手消息可判 → null（未知，调用方自行决定记录口径）
 */
function assistantHadArtifacts(messages) {
  try {
    if (!Array.isArray(messages) || messages.length === 0) return null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg && msg.role === 'assistant') {
        return _ARTIFACT_RE.test(_messageText(msg));
      }
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  KHY_CALIBRATE_HINT_STAGE,
  PHRASE_CATEGORIES,
  hintMode,
  effectiveMode,
  classifyCorrectionPhrase,
  assistantHadArtifacts,
};
