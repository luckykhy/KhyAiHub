'use strict';

/**
 * repeatedPromptRounds.unpolluted.test.js — W2 的**证伪-修复**对（自我对抗式）。
 *
 * 背景（[DESIGN-ARCH-198] §2.1，2026-11-01 用户实测）：用户连发 3 次「今天有些什么新闻？」，
 * 界面两次都显示「用户已第 **2** 次发送基本相同的请求（这是第二轮）」，
 * 而模型自己数出「这是**第三轮**同一请求」——两者互相矛盾。
 *
 * 根因：轮次计数器的输入源 `initialMessages` 里，user 消息**混装**了系统注入旁注
 * （「[SYSTEM] 重复请求识别:…」被前置进 currentMessage，又回灌进历史）。
 * 拿混装文本跟干净的新提示词比 → Jaccard 0.0476 ≪ 0.9 → 判「不同请求」
 * → 重复计数不增 → **轮次饱和在 2**。
 *
 * 本文件钉死不变式：**计数只看用户原话**。
 *
 * 反向对抗：
 *   - 用**真实的**注入文本形态（`buildRoundHint` 的产物）当夹具，而不是手搓的假串；
 *   - 断言「混装形态确实与干净形态**不**相似」——否则本组测试就是假绿；
 *   - 断言「剥掉旁注后**与**干净形态相似」——证明修复有效而非「两边都变空」。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const rpr = require('../../src/services/repeatedPromptRounds');
const scaffolding = require('../../src/services/promptScaffolding');

const ON = { KHY_PROMPT_ROUND_TRACKER: '1' };
const PLAIN = '今天有些什么新闻？';

describe('W2 · 重复请求轮次计数不被系统注入旁注污染', () => {
  test('【对抗前置】混装形态与干净形态**不**相似（否则本组是假绿）', () => {
    const hint = rpr.buildRoundHint(2, ON);
    const polluted = `${hint}\n\n${PLAIN}`;
    assert.ok(hint.includes('[SYSTEM]'), '注入形态应以 [SYSTEM] 开头');
    assert.ok(rpr.similarity(PLAIN, polluted) < 0.9, '混装形态不该与干净形态相似');
  });

  test('【对抗前置】剥掉旁注后**恢复**相似（证明修复有效而非「都变空」）', () => {
    const hint = rpr.buildRoundHint(2, ON);
    const polluted = `${hint}\n\n${PLAIN}`;
    const stripped = scaffolding.stripLeadingInjectedScaffold(polluted);
    assert.equal(stripped, PLAIN);
    assert.equal(rpr.similarity(PLAIN, stripped), 1);
  });

  test('剥离叶子：剥一层 / 剥多层 / 无旁注不动 / 正文里的 [SYSTEM] 不动', () => {
    const hint = rpr.buildRoundHint(2, ON);
    assert.equal(scaffolding.stripLeadingInjectedScaffold(`${hint}\n\n${PLAIN}`), PLAIN);
    assert.equal(
      scaffolding.stripLeadingInjectedScaffold(`${hint}\n\n${hint}\n\n${PLAIN}`),
      PLAIN,
      '多层叠加应全剥',
    );
    assert.equal(scaffolding.stripLeadingInjectedScaffold(PLAIN), PLAIN, '无旁注不动');
    // 用户正文里出现 [SYSTEM 字样但**没有**空行分隔形态 → 不该被剥
    const inBody = `请解释 [SYSTEM] 这个词`;
    assert.equal(scaffolding.stripLeadingInjectedScaffold(inBody), inBody);
  });

  test('isOnlyInjectedScaffold：只含旁注的 user 消息被认出', () => {
    const hint = rpr.buildRoundHint(2, ON);
    assert.equal(scaffolding.isOnlyInjectedScaffold(`${hint}\n\n`), true);
    assert.equal(scaffolding.isOnlyInjectedScaffold(`${hint}\n\n${PLAIN}`), false);
  });

  test('★ 核心：连发 4 次同款 → 轮次依次 1/2/3/4（今日恒为 1/2/2/2）', () => {
    const hist = [];
    const seen = [];
    for (let i = 1; i <= 4; i += 1) {
      const round = rpr.countRound(PLAIN, hist, ON);
      seen.push(round);
      // 复刻真实回灌：命中提示时，混装形态被写回历史（这正是污染源）。
      const persisted = round >= 2 ? `${rpr.buildRoundHint(round, ON)}\n\n${PLAIN}` : PLAIN;
      hist.push(persisted);
    }
    assert.deepEqual(seen, [1, 2, 3, 4]);
  });

  test('★ 核心：历史**混装**形态（真实回灌）也数对轮次', () => {
    // 直接用「已被旁注污染的历史」当输入 —— 这正是线上形态。
    const hint2 = rpr.buildRoundHint(2, ON);
    const hint3 = rpr.buildRoundHint(3, ON);
    const pollutedHistory = [PLAIN, `${hint2}\n\n${PLAIN}`, `${hint3}\n\n${PLAIN}`];
    assert.equal(rpr.countRound(PLAIN, pollutedHistory, ON), 4);
  });

  test('priorUserTextsFrom 抽出的是**剥掉旁注**的原话', () => {
    const hint = rpr.buildRoundHint(2, ON);
    const msgs = [
      { role: 'user', content: PLAIN },
      { role: 'assistant', content: '回答' },
      { role: 'user', content: `${hint}\n\n${PLAIN}` },
    ];
    const out = rpr.priorUserTextsFrom(msgs);
    assert.equal(out.length, 2);
    assert.equal(out[0], PLAIN);
    assert.equal(out[1], PLAIN, '混装的那条应剥成原话');
  });

  test('零回归：不同请求仍不计入轮次（零误报不破）', () => {
    const cur = '把缩放丢行也监听起来';
    const prior = ['配置模型密钥', '部署项目到服务器', '修复登录报错'];
    assert.equal(rpr.countRound(cur, prior, ON), 1);
  });

  test('零回归：尾随小改动（「，继续」）仍判同一请求', () => {
    const base = '然后一些软bug，需要主动监听，监听同时简单修复否则报错存日志';
    const withCont = `${base}，继续`;
    assert.equal(rpr.countRound(withCont, [base, base], ON), 3);
  });

  test('零回归：env 关闭 → 恒 1（不注入）', () => {
    assert.equal(rpr.countRound(PLAIN, [PLAIN, PLAIN, PLAIN], { KHY_PROMPT_ROUND_TRACKER: 'off' }), 1);
  });

  test('★ 门控：KHY_PROMPT_ROUND_UNPOLLUTED 关 → 逐字节回退今日行为（轮次饱和在 2）', () => {
    // 门关 = 不剥离旁注 → 与今日行为逐字节一致（今日：连发 4 次恒为 1/2/2/2）。
    const OFF = { KHY_PROMPT_ROUND_TRACKER: '1', KHY_PROMPT_ROUND_UNPOLLUTED: '0' };
    const hist = [];
    const seen = [];
    for (let i = 1; i <= 4; i += 1) {
      const round = rpr.countRound(PLAIN, hist, OFF);
      seen.push(round);
      hist.push(round >= 2 ? `${rpr.buildRoundHint(round, OFF)}\n\n${PLAIN}` : PLAIN);
    }
    assert.deepEqual(seen, [1, 2, 2, 2], '门关应回到今日的饱和行为');
  });

  test('★ 门控：门开（默认）→ 轮次递增到 4', () => {
    const ON2 = { KHY_PROMPT_ROUND_TRACKER: '1' };
    const hist = [];
    const seen = [];
    for (let i = 1; i <= 4; i += 1) {
      const round = rpr.countRound(PLAIN, hist, ON2);
      seen.push(round);
      hist.push(round >= 2 ? `${rpr.buildRoundHint(round, ON2)}\n\n${PLAIN}` : PLAIN);
    }
    assert.deepEqual(seen, [1, 2, 3, 4]);
  });

  test('★ 门控：priorUserTextsFrom 同样受门控（关 → 不剥离）', () => {
    const hint = rpr.buildRoundHint(2, ON);
    const msgs = [
      { role: 'user', content: PLAIN },
      { role: 'user', content: `${hint}\n\n${PLAIN}` },
    ];
    // 门开 → 剥成原话
    assert.deepEqual(
      rpr.priorUserTextsFrom(msgs, { KHY_PROMPT_ROUND_UNPOLLUTED: '1' }),
      [PLAIN, PLAIN],
    );
    // 门关 → 原样保留混装文本（逐字节回退今日）
    const off = rpr.priorUserTextsFrom(msgs, { KHY_PROMPT_ROUND_UNPOLLUTED: '0' });
    assert.equal(off[0], PLAIN);
    assert.ok(off[1].includes('[SYSTEM]'), '门关时混装文本应原样保留');
  });
});
