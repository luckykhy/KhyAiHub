'use strict';

/**
 * correctionPhraseService.js — 校准话术 S1 观测编排（[DESIGN-ARCH-163] D5）。
 *
 * 网关送模型前被调用（观测原始用户消息，先于说明书卡追加）。命中修正句式且本轮
 * 不带图 → 往本地样本台账 append 一行 JSONL。**只记录，绝不改写 prompt、绝不抛、
 * 绝不阻断生成链路**（S1 观察者档，毕业判据见 FEATURE-OWNERSHIP.json
 * → image-calibrate-hint-skeleton；升 S3 前不存在注入路径，见 correctionPhraseCard
 * 的 KHY_CALIBRATE_HINT_STAGE）。
 *
 * 记录口径比文档判据略宽：artifacts=false/unknown 的命中也记，样本里带
 * assistantArtifacts 字段——S1 要判的正是「命中但其实是误报」的比例（S2 毕业
 * 要求误报 <10%），只记真命中就永远算不出误报率。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PREVIEW_CHARS = 120;

function _samplesFile(env = process.env) {
  const override = String((env && env.KHY_CORRECTION_PHRASE_SAMPLES) || '').trim();
  if (override) return override;
  const { getBaseDataDir } = require('../utils/dataHome');
  return path.join(getBaseDataDir('.'), 'correction_phrase_samples.jsonl');
}

function _preview(text) {
  return String(text == null ? '' : text)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .slice(0, PREVIEW_CHARS);
}

/**
 * 观测一条用户消息。返回值仅为可测性（true=已落样本）；对链路是 fire-and-forget。
 * @param {string} prompt  本轮用户原文（说明书卡追加**之前**）
 * @param {{images?: Array, messages?: Array}} options
 * @param {object} [env]
 * @returns {boolean}
 */
function observeCorrectionPhrase(prompt, options = {}, env = process.env) {
  try {
    const leaf = require('./correctionPhraseCard');
    const mode = leaf.effectiveMode(env);
    if (mode === 'off') return false;

    const images = Array.isArray(options.images) ? options.images : [];
    if (images.length > 0) return false; // 本轮带图 = 用户在给新证据，不是模糊修正

    const hits = leaf.classifyCorrectionPhrase(prompt);
    if (hits.length === 0) return false;

    const record = {
      ts: Date.now(),
      stage: 'S1',
      mode,
      categories: hits,
      assistantArtifacts: leaf.assistantHadArtifacts(options.messages),
      digest: crypto.createHash('sha256').update(String(prompt || '')).digest('hex').slice(0, 16),
      preview: _preview(prompt),
    };
    const file = _samplesFile(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

module.exports = { observeCorrectionPhrase, _samplesFile, PREVIEW_CHARS };
