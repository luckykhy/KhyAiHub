'use strict';

/**
 * polish.js — 可选模型润色：骨架是确定性产物，模型只许改文风，不许改事实。
 *
 * DESIGN-ARCH-130。红线：润色后的文本必须
 *   (a) 保留骨架中的全部 [#n] 证据锚点；
 *   (b) 不得引入骨架之外的新锚点（防模型虚构「证据」）；
 *   (c) 篇幅不得超过骨架 3 倍（防注水）。
 * 任一校验失败即丢弃润色、回退骨架——与 mapAuthor 的强度门同一哲学：
 * 模型是可拔插的修辞层，骨架才是可信叙事。
 *
 * 门控 KHY_NARRATIVE_POLISH 默认关（触模型须显式 opt-in）。
 * 模型调用走 llmGenerateSink（[DESIGN-ARCH-051] §6.9 的零依赖 provider 槽），
 * 不直接 require 6000 行的 aiGateway。
 */

const ANCHOR_RE = /\[#(\d+)\]/g;

function _anchors(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(ANCHOR_RE)) {
    out.add(Number(m[1]));
  }
  return out;
}

/**
 * 校验润色稿是否守锚点契约。返回 null 表示通过，否则返回违规原因。
 * 导出供单测直接验证三种违规路径。
 */
function _validatePolish(skeleton, polished) {
  const base = _anchors(skeleton);
  const next = _anchors(polished);
  for (const n of base) {
    if (!next.has(n)) {
      return 'anchor-dropped';
    }
  }
  for (const n of next) {
    if (!base.has(n)) {
      return 'anchor-injected';
    }
  }
  if (String(polished || '').length > String(skeleton || '').length * 3) {
    return 'too-long';
  }
  return null;
}

function _polishEnabled(env) {
  const v = String((env && env.KHY_NARRATIVE_POLISH) || '')
    .trim()
    .toLowerCase();
  return !['', '0', 'false', 'off', 'no'].includes(v);
}

const PROMPT = [
  '你是一名叙事编辑。下面是一份由确定性引擎生成的任务执行叙事（Markdown），',
  '每句末尾的 [#n] 是证据锚点，回指真实执行记录。',
  '请把它改写成更连贯、更有叙事感的文字，但必须遵守三条硬约束：',
  '1. 保留全部 [#n] 锚点，一个不许丢，位置可随句子移动；',
  '2. 不得新增任何 [#n]，不得新增骨架中没有的事实、数字、文件名；',
  '3. 保留 Markdown 标题结构（#、##）。',
  '只输出改写后的 Markdown，不要解释。',
  '',
].join('\n');

/**
 * @param {string} skeleton renderNarrative 的 markdown
 * @param {object} [opts]
 * @param {object} [opts.env=process.env]
 * @param {number} [opts.maxTokens=2000]
 * @returns {Promise<{text:string, polished:boolean, reason:string}>}
 *   reason ∈ gate-off | no-provider | ok | error | anchor-dropped | anchor-injected | too-long
 */
async function maybePolish(skeleton, opts = {}) {
  const env = opts.env || process.env;
  if (!_polishEnabled(env)) {
    return { text: skeleton, polished: false, reason: 'gate-off' };
  }
  try {
    const llmGenerate = require('../../../llmGenerateSink').getLlmGenerateProvider();
    if (!llmGenerate) {
      return { text: skeleton, polished: false, reason: 'no-provider' };
    }
    const result = await llmGenerate(PROMPT + skeleton, {
      maxTokens: Number(opts.maxTokens) || 2000,
    });
    if (!result || !result.success || !result.content) {
      return { text: skeleton, polished: false, reason: 'error' };
    }
    const violation = _validatePolish(skeleton, result.content);
    if (violation) {
      return { text: skeleton, polished: false, reason: violation };
    }
    return { text: result.content, polished: true, reason: 'ok' };
  } catch {
    return { text: skeleton, polished: false, reason: 'error' };
  }
}

module.exports = { maybePolish, _validatePolish };
