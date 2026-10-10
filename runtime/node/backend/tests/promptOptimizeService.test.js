'use strict';
/**
 * promptOptimizeService 的 fail-soft 契约（[DESIGN-PROMPT-003] §7 / §10 落地映射）：
 * 门控逃生口、输入护栏、网关注入下的成功/失败/超时/降级全路径。零真实网络（网关注入）。
 */
const assert = require('node:assert');

describe('promptOptimizeService ([DESIGN-PROMPT-003] §7)', () => {
  const O = require('../src/services/promptOptimizeService');

  const mkGateway = (result) => ({
    isInitialized: () => true,
    generate: async () => result,
  });
  const OK_CONTENT =
    'front-matter\n<<<OPTIMIZED\n改写后的提示词\nOPTIMIZED>>>\n<<<REASONS\n- 去愿望词\n- 补收口\nREASONS>>>';

  test('门关 → disabled，零调用', async () => {
    let called = false;
    const gw = { isInitialized: () => true, generate: async () => { called = true; return { success: true, content: 'x' }; } };
    const r = await O.optimizePrompt({ text: 'abc', env: { KHY_PROMPT_OPTIMIZE: '0' }, gateway: gw });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'disabled');
    assert.strictEqual(called, false, '门关时不得发起任何网关调用');
  });

  test('空输入 / 超长输入 → 结构化 reason', async () => {
    assert.strictEqual((await O.optimizePrompt({ text: '   ', env: {} })).reason, 'empty');
    const tooLong = await O.optimizePrompt({ text: 'a'.repeat(O.MAX_INPUT_CHARS + 1), env: {} });
    assert.strictEqual(tooLong.reason, 'too-long');
  });

  test('成功路径：解析改写稿与理由，给改前/改后评分', async () => {
    const r = await O.optimizePrompt({
      text: '帮我写个更专业的周报',
      env: {},
      gateway: mkGateway({ success: true, content: OK_CONTENT, model: 'm1', provider: 'p1' }),
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.optimized, '改写后的提示词');
    assert.deepStrictEqual(r.reasons, ['去愿望词', '补收口']);
    assert.strictEqual(r.degraded, false);
    assert.strictEqual(typeof r.before.score, 'number');
    assert.strictEqual(typeof r.after.score, 'number');
    assert.strictEqual(r.model, 'm1');
  });

  test('网关失败 / 抛异常 / 超时 → 各自 reason，绝不抛', async () => {
    const fail = await O.optimizePrompt({
      text: 'abc',
      env: {},
      gateway: mkGateway({ success: false, error: '429 限流' }),
    });
    assert.deepStrictEqual([fail.ok, fail.reason, fail.detail], [false, 'gateway-error', '429 限流']);

    const thrown = await O.optimizePrompt({
      text: 'abc',
      env: {},
      gateway: { isInitialized: () => true, generate: async () => { throw new Error('boom'); } },
    });
    assert.deepStrictEqual([thrown.ok, thrown.reason, thrown.detail], [false, 'error', 'boom']);

    const slow = await O.optimizePrompt({
      text: 'abc',
      env: {},
      gateway: { isInitialized: () => true, generate: () => new Promise(() => {}) },
      timeoutMs: 50,
    });
    assert.deepStrictEqual([slow.ok, slow.reason], [false, 'timeout']);
  });

  test('模型不守格式 → 整段降级为改写稿并标 degraded', async () => {
    const r = await O.optimizePrompt({
      text: 'abc',
      env: {},
      gateway: mkGateway({ success: true, content: '没守格式的整段输出' }),
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.optimized, '没守格式的整段输出');
    assert.strictEqual(r.degraded, true);
  });

  test('网关未初始化 → 先 init 再调用', async () => {
    let inited = false;
    const gw = {
      isInitialized: () => false,
      init: async () => { inited = true; },
      generate: async () => ({ success: true, content: OK_CONTENT }),
    };
    const r = await O.optimizePrompt({ text: 'abc', env: {}, gateway: gw });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(inited, true);
  });

  test('parseOptimizerOutput：带噪声前缀/无理由段/空输出', () => {
    assert.deepStrictEqual(O.parseOptimizerOutput('前言\n<<<OPTIMIZED\nX\nOPTIMIZED>>>'), {
      optimized: 'X',
      reasons: [],
      degraded: false,
    });
    assert.deepStrictEqual(O.parseOptimizerOutput(''), { optimized: '', reasons: [], degraded: false });
    const many = O.parseOptimizerOutput(
      '<<<OPTIMIZED\nX\nOPTIMIZED>>>\n<<<REASONS\n- 1\n- 2\n- 3\n- 4\n- 5\n- 6\nREASONS>>>'
    );
    assert.strictEqual(many.reasons.length, 5, '理由最多保留 5 条');
  });

  test('优化器 system prompt 在 PROMPT-001 上限内且含四步法', () => {
    const sys = O.buildOptimizerSystem();
    assert.ok(sys.length <= O.MAX_OPTIMIZER_SYSTEM_CHARS, `system ${sys.length} > ${O.MAX_OPTIMIZER_SYSTEM_CHARS}`);
    assert.ok(sys.includes('框架化') && sys.includes('内容化') && sys.includes('结构化'));
    assert.ok(sys.includes('<<<OPTIMIZED') && sys.includes('<<<REASONS'));
  });
});