'use strict';

/**
 * toolUseLoop.outcomeNarrationOccurrence.test.js — W5/W7 的**证伪-修复**对（自我对抗式）。
 *
 * 背景（[DESIGN-ARCH-198] §2.4，2026-11-01 用户实测截图）：一轮里 3 路并行 webSearch 的
 * 参考旁白是**同一句**重复三遍：
 *   「外部查到 10 条，我把要点整理出来再回到正题。 外部查到 7 条，我把要点整理出来再回到正题。
 *     外部查到 7 条，我把要点整理出来再回到正题。」
 *
 * 根因：`toolUseLoopCore._buildOutcomeReflectionHint` 调 `toolOutcomeNarration` 时
 * **没传** `options.occurrence` → occurrence undefined → `_voice` 恒取 occ=0 → 永远返回首发句。
 * 而 **TUI 侧**（`queryBridgeTimeline.computeToolOutcome`）**传了** occurrence、轮换正常 ——
 * 同一件事两处实现、两处行为（W5 治这个）。
 *
 * W7 是兜底：万一旁白仍逐字重复（不同工具类碰巧同句），折叠为一条 + 如实标出合并数。
 *
 * 反向对抗：断言**逐字不同**（不是「大概不同」）；并断言「门关 → 逐字节回退」。
 */

const path = require('path');

const BE = path.resolve(__dirname, '../..');
const core = require(path.join(BE, 'src/services/tool/toolUseLoop.js'));
const voice = require(path.join(BE, 'src/cli/toolPrefaceVoice.js'));

const _buildOutcomeReflectionHint = core._buildOutcomeReflectionHint;

/** 一条 webSearch 成功结果（旁白有内容）。 */
function webResult(n) {
  return {
    tool: 'websearch',
    result: { success: true, count: n, results: new Array(n).fill({ title: 'x' }) },
    params: {},
  };
}

describe('W5 · loop 侧旁白 occurrence 接线（[DESIGN-ARCH-198] §2.4）', () => {
  const prev = {};
  const KEYS = ['KHY_LOOP_NARRATION_OCCURRENCE', 'KHY_OUTCOME_HINT_DEDUP'];
  beforeEach(() => {
    for (const k of KEYS) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  test('【对抗前置】voice 层本身轮换正常（否则问题不在接线层）', () => {
    const r = { success: true, count: 7, results: new Array(7).fill({ title: 'x' }) };
    const a = voice.toolOutcomeNarration('websearch', r, {}, { occurrence: 0 });
    const b = voice.toolOutcomeNarration('websearch', r, {}, { occurrence: 1 });
    const c = voice.toolOutcomeNarration('websearch', r, {}, { occurrence: 2 });
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  test('★ 一批 3 路并行 webSearch → 旁白**逐字不同**（今日：三句全同）', () => {
    const hint = _buildOutcomeReflectionHint([webResult(10), webResult(7), webResult(7)], {});
    expect(hint).toBeTruthy();
    // 把提示块剥掉，只看旁白正文
    const body = hint.replace(/^\[SYSTEM:.*?：/, '').replace(/\]$/, '');
    const sentences = body.split('。').filter((s) => s.trim());
    expect(sentences.length).toBeGreaterThanOrEqual(3);
    expect(new Set(sentences.map((s) => s.trim())).size).toBe(sentences.length);
  });

  test('门关（W5+W7 都关）→ 与今日行为**逐字节**一致', () => {
    const results = [webResult(10), webResult(7), webResult(7)];
    // 今日行为 = 每条都取 occ=0 的首发句，逐条成行（不折叠）。
    const todayLines = results.map(
      (r) => voice.toolOutcomeNarration(r.tool, r.result, r.params, {}) || ''
    );
    const todayBody = todayLines.join(' ');

    process.env.KHY_LOOP_NARRATION_OCCURRENCE = '0';
    process.env.KHY_OUTCOME_HINT_DEDUP = '0';
    const off = _buildOutcomeReflectionHint(results, process.env);
    delete process.env.KHY_LOOP_NARRATION_OCCURRENCE;
    delete process.env.KHY_OUTCOME_HINT_DEDUP;

    const body = off.replace(/^\[SYSTEM:.*?：/, '').replace(/\]$/, '');
    expect(body).toBe(todayBody);
  });

  test('W7 兜底：逐字相同的两条折叠为一条 + 如实标出合并数', () => {
    // 同一工具类、同 count → occurrence 关掉时两旁白逐字相同 → W7 应折叠
    const results = [webResult(7), webResult(7)];
    process.env.KHY_LOOP_NARRATION_OCCURRENCE = '0';
    const hint = _buildOutcomeReflectionHint(results, process.env);
    delete process.env.KHY_LOOP_NARRATION_OCCURRENCE;
    const body = hint.replace(/^\[SYSTEM:.*?：/, '').replace(/\]$/, '');
    // 只剩一条旁白 + 一句合并说明
    expect((body.match(/我把要点整理出来再回到正题/g) || []).length).toBe(1);
    expect(body).toContain('合并');
  });

  test('零回归：单条工具的旁白与今日逐字节一致（occ 0 = 首发句）', () => {
    const r = { success: true, count: 24, results: new Array(24).fill({ t: 1 }) };
    const expected = voice.toolOutcomeNarration('websearch', r, {}, { occurrence: 0 });
    const hint = _buildOutcomeReflectionHint(
      [{ tool: 'websearch', result: r, params: {} }],
      {}
    );
    expect(hint).toContain(expected);
  });

  test('零回归：空结果 / 非数组 → 返空串', () => {
    expect(_buildOutcomeReflectionHint([], {})).toBe('');
    expect(_buildOutcomeReflectionHint(null, {})).toBe('');
  });

  test('零回归：KHY_OUTCOME_HINT=0 → 整块禁用', () => {
    const hint = _buildOutcomeReflectionHint([webResult(3)], { KHY_OUTCOME_HINT: '0' });
    expect(hint).toBe('');
  });
});
