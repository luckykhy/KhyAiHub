'use strict';

/**
 * render.js — NarrativePlan + 结果叙事 → Markdown 成稿。
 *
 * DESIGN-ARCH-130。文档层的两个热奈特装置：
 *   预叙 prolepsis —— mode=both 时「结果叙事」置于「过程叙事」之前：先讲
 *                    交付了什么，再回溯怎么做到的（结果叙事复用
 *                    sessionRecapService.generateRecap 的确定性抽取）。
 *   证据锚点       —— 过程段每句以 [#n] 回指故事层事件 seq，文末锚点表
 *                    给出每条事件的时间与来源 uuid。叙事不虚构：任何一句
 *                    都能回到 transcript 验真。
 *
 * 纯函数：无 IO。--out 落盘在 handlers/recap.js。
 */

function _fmtClock(at) {
  const d = new Date(Number(at) || 0);
  if (Number.isNaN(d.getTime())) {
    return '--:--:--';
  }
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function _anchorTag(anchors) {
  return anchors.map((n) => `[#${n}]`).join('');
}

/** 结果叙事（预叙段）：拿 generateRecap 的现成抽取，不另写一套。 */
function _renderResult(recap) {
  const lines = [];
  lines.push('## 结果叙事（预叙）');
  lines.push('');
  if (!recap || !recap.sections) {
    lines.push('（无可呈现的结果。）');
    lines.push('');
    return lines;
  }
  if (recap.summary) {
    lines.push(recap.summary);
    lines.push('');
  }
  const s = recap.sections;
  if (Array.isArray(s.filesChanged) && s.filesChanged.length > 0) {
    lines.push(`- 改动文件（${s.filesChanged.length}）：${s.filesChanged.slice(0, 8).join('、')}${s.filesChanged.length > 8 ? ' 等' : ''}`);
  }
  if (Array.isArray(s.decisions) && s.decisions.length > 0) {
    for (const d of s.decisions.slice(0, 5)) {
      lines.push(`- 决策：${d}`);
    }
  }
  if (Array.isArray(s.openQuestions) && s.openQuestions.length > 0) {
    for (const q of s.openQuestions.slice(0, 3)) {
      lines.push(`- 未决：${q}`);
    }
  }
  lines.push('');
  return lines;
}

const MODE_LABEL = { scene: '场景', summary: '概要', pause: '停顿' };

/**
 * @param {object} input
 * @param {object} input.plan   buildNarrative 的返回
 * @param {Array}  input.events storyCollect 的 events（锚点表用）
 * @param {object} [input.recap] generateRecap 的返回（mode 含 result 时必传）
 * @param {string} [input.sessionId]
 * @param {'process'|'result'|'both'} [input.mode='both']
 * @returns {{markdown:string, anchorCount:number}}
 */
function renderNarrative({ plan, events, recap, sessionId, mode = 'both' }) {
  const lines = [];
  const sid = sessionId ? String(sessionId).slice(0, 8) : 'unknown';
  const focusLabel = plan.focus === 'reasoning' ? '内聚焦（含推理）' : '外聚焦（只讲行动）';
  const st = plan.stats;

  lines.push(`# 任务叙事 — ${sid}`);
  lines.push('');
  lines.push(
    `> 叙述者：KHY（事后叙述 · 外叙述层 · 第三人称） · 聚焦：${focusLabel} · ` +
      `事件 ${st.total} 条 — 场景 ${st.scene} / 概要 ${st.summary} / 停顿 ${st.pause} / 省略 ${st.ellipsis}`
  );
  lines.push('');

  if (mode === 'result' || mode === 'both') {
    lines.push(..._renderResult(recap));
  }

  const usedAnchors = new Set();
  if (mode === 'process' || mode === 'both') {
    lines.push('## 过程叙事');
    lines.push('');
    if (mode === 'both') {
      lines.push('（回到开头：上文是结局，以下按真实时序重述经过。）');
      lines.push('');
    }
    for (const p of plan.paragraphs) {
      p.anchors.forEach((n) => usedAnchors.add(n));
      const label = MODE_LABEL[p.mode] ? ` _(${MODE_LABEL[p.mode]})_` : '';
      lines.push(`- ${p.text} ${_anchorTag(p.anchors)}${label}`);
    }
    lines.push('');
  }

  if (usedAnchors.size > 0) {
    const bySeq = new Map((Array.isArray(events) ? events : []).map((e) => [e.seq, e]));
    lines.push('## 证据锚点');
    lines.push('');
    for (const n of [...usedAnchors].sort((a, b) => a - b)) {
      const e = bySeq.get(n);
      if (!e) {
        continue;
      }
      const detail = e.target || e.text || e.name || e.kind;
      lines.push(`- [#${n}] ${_fmtClock(e.at)} ${e.kind} — ${String(detail).slice(0, 60)}`);
    }
    lines.push('');
  }

  return { markdown: lines.join('\n'), anchorCount: usedAnchors.size };
}

module.exports = { renderNarrative, _fmtClock };
