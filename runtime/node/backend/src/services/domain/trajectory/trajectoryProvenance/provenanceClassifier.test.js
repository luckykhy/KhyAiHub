'use strict';

/**
 * provenanceClassifier.test.js — 钉死入站溯源分类器的匹配语义与两处已登记缺陷：
 * hint 匹配是对 adapter|provider|serviceType（首个非空，小写）的「包含」判定，
 * _PRODUCER_HINTS 的数组顺序即优先级（claude-code > codex > relay）；serviceType
 * 独立参与循环判定（即使 adapter 非空也能经 serviceType 轴命中）；relay 的 producerId
 * 取 endpoint>model>provider 首个非空。缺陷钉而不修：(1) classifyProducer(null)/
 * classify(null) 抛 TypeError（`= {}` 默认值只兜 undefined）；(2) JSDoc 宣称的
 * `direct` 信号在实现中根本没被读取；(3) 下划线形态 'claude_code' 不命中任何 hint，
 * 外部内容被 fail-safe-to-ours 误标 khy-local（方向恰好是文档铁律最怕的漏标）。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('./provenanceClassifier.js');
const { PRODUCER, TRUST } = require('./khyTrace.js');

const { classify, classifyProducer } = mod;

describe('classifyProducer：hint 包含匹配与顺序优先级', () => {
  test('adapter 命中 codex 子串（含 codex-direct 这类命名），producerId 恒 null', () => {
    const signals = { adapter: 'codex-direct' };
    assert.ok(Object.keys(signals).length > 0);
    assert.deepStrictEqual(classifyProducer(signals), { producer: 'codex', producerId: null });
  });

  test('provider 命中 relay → producerId 取 endpoint/model/provider 首个非空', () => {
    assert.deepStrictEqual(classifyProducer({ provider: 'relay_api' }), {
      producer: 'relay',
      producerId: 'relay_api', // endpoint/model 缺位时 provider 兜底
    });
    assert.deepStrictEqual(classifyProducer({ provider: 'relay_api', model: 'gpt-x' }), {
      producer: 'relay',
      producerId: 'gpt-x', // model 优先于 provider
    });
    assert.deepStrictEqual(classifyProducer({ provider: 'relay_api', model: 'gpt-x', endpoint: 'tcp://a:1' }), {
      producer: 'relay',
      producerId: 'tcp://a:1', // endpoint 最优先
    });
    // 非 relay 命中不带 producerId——即便 endpoint 有值
    assert.deepStrictEqual(classifyProducer({ adapter: 'codex', endpoint: 'ep' }), {
      producer: 'codex',
      producerId: null,
    });
  });

  test('claude-code 两种写法（连字符 / 连写）都命中；大小写不敏感', () => {
    assert.strictEqual(classifyProducer({ adapter: 'claude-code-bridge' }).producer, 'claude-code');
    assert.strictEqual(classifyProducer({ adapter: 'claudecode' }).producer, 'claude-code');
    assert.strictEqual(classifyProducer({ serviceType: 'claude-code-relay' }).producer, 'claude-code');
    assert.strictEqual(classifyProducer({ adapter: 'CODEX-Direct' }).producer, 'codex');
  });

  test('hint 数组顺序即优先级：同串含多关键词时靠前者优先', () => {
    // 'relay' 与 'codex' 同在——_PRODUCER_HINTS 中 codex 在 relay 之前 → codex
    assert.strictEqual(classifyProducer({ adapter: 'codex relay mixed' }).producer, 'codex');
    // claude-code 排在 codex 之前 → claude-code
    assert.strictEqual(classifyProducer({ adapter: 'claude-code codex relay' }).producer, 'claude-code');
    // 该顺序变更会翻转这两断言——钉住顺序依赖本身
    assert.strictEqual(classify({ adapter: 'codex relay mixed' }).trust, TRUST.CLAIMED);
  });

  test('首个非空字符串胜出：空白 adapter 被 _firstString 跳过、fallback 到 provider', () => {
    assert.deepStrictEqual(classifyProducer({ adapter: '   ', provider: 'codex' }), {
      producer: 'codex',
      producerId: null,
    });
    // adapter 非空时 provider 完全不参与 hay（除非 hay 未命中而 serviceType 命中）
    assert.strictEqual(classifyProducer({ adapter: 'openai', provider: 'codex' }).producer, 'khy-local');
  });

  test('serviceType 独立参与循环：adapter 未命中时经 serviceType 轴仍可判 relay', () => {
    const signals = { adapter: 'plain-http', serviceType: 'relay-thing' };
    assert.ok(Object.keys(signals).length > 1);
    const out = classifyProducer(signals);
    assert.strictEqual(out.producer, 'relay');
    assert.strictEqual(out.producerId, null); // endpoint/model/provider 全空 → null
  });

  test('非字符串信号被跳过而非强转：数字/对象 adapter 不进 hay', () => {
    assert.deepStrictEqual(classifyProducer({ adapter: 42, provider: 'codex' }), {
      producer: 'codex',
      producerId: null,
    });
    assert.strictEqual(classifyProducer({ adapter: { toString: () => 'codex' } }).producer, 'khy-local');
    assert.strictEqual(classifyProducer({ adapter: ['codex'] }).producer, 'khy-local');
  });

  test('未识别/空信号 → khy-local + producerId:null（fail-safe-to-ours）', () => {
    for (const signals of [{}, { adapter: 'openai' }, { adapter: '   ' }, { provider: '' }, { serviceType: 'gpt-4o' }]) {
      assert.deepStrictEqual(
        classifyProducer(signals),
        { producer: 'khy-local', producerId: null },
        `信号 ${JSON.stringify(signals)} 应回落 khy-local`,
      );
    }
  });

  test('缺陷钉住（不修）：纯下划线 claude_code 不命中任何 hint → 外部被误标 khy-local', () => {
    // 见登记缺陷：_PRODUCER_HINTS 只有 'claude-code'/'claudecode'，没有 'claude_code'。
    // 可证伪预测：若有人把 'claude_code' 加进 hint 表，本断言将翻转为 claude-code。
    const underscore = { adapter: 'claude_code' };
    assert.ok(Object.keys(underscore).length > 0);
    assert.strictEqual(classifyProducer(underscore).producer, PRODUCER.KHY_LOCAL);
  });

  test('缺陷钉住（不修）：JSDoc 宣称的 direct 信号实现完全未读取', () => {
    // provenanceClassifier.js:35 注释列了 { adapter, provider, serviceType, direct, ... }，
    // 但函数体从不访问 signals.direct——带 direct:'relay-x' 的信号照样判 khy-local。
    assert.strictEqual(classifyProducer({ direct: 'relay-signal' }).producer, PRODUCER.KHY_LOCAL);
    assert.strictEqual(classify({ direct: 'codex-via-direct' }).producer, PRODUCER.KHY_LOCAL);
  });
});

describe('classify：producer × trust 组合', () => {
  test('khy-local → verified；codex/claude-code/relay 一律 claimed', () => {
    assert.deepStrictEqual(classify({}), { producer: 'khy-local', producerId: null, trust: 'verified' });
    assert.deepStrictEqual(classify({ adapter: 'codex-direct' }), {
      producer: 'codex', producerId: null, trust: 'claimed',
    });
    assert.deepStrictEqual(classify({ adapter: 'claude-code' }), {
      producer: 'claude-code', producerId: null, trust: 'claimed',
    });
    assert.deepStrictEqual(classify({ provider: 'relay_api', endpoint: 'ep' }), {
      producer: 'relay', producerId: 'ep', trust: 'claimed',
    });
  });

  test('trust 只由 producer 决定：hint 命中的外部永远拿不到 verified', () => {
    for (const adapter of ['codex', 'claude-code', 'relay', 'relay-mystery']) {
      const out = classify({ adapter });
      assert.notStrictEqual(out.producer, PRODUCER.KHY_LOCAL, `${adapter} 应命中外部`);
      assert.strictEqual(out.trust, TRUST.CLAIMED);
    }
  });

  test('分歧钉住：分类器对未识别串回落 khy-local/verified，而 khyTrace.normalizeProducer 同串坍缩 relay', () => {
    // 两侧防呆方向不同的又一体现：classifier 只认 hint 表，未知一律「我们的」；
    // normalizeProducer 则把未知坍缩为 relay。跨模块传入未识别串时结果取决于先过哪道门。
    const out = classify({ adapter: 'mystery-external' });
    assert.strictEqual(out.producer, PRODUCER.KHY_LOCAL);
    assert.strictEqual(out.trust, TRUST.VERIFIED);
  });
});

describe('缺陷钉住（不修）：null 信号抛 TypeError，默认值只兜 undefined', () => {
  test('classifyProducer(null) / classify(null) 当前必抛 TypeError——这是已登记缺陷', () => {
    // `signals = {}` 的参数默认值仅在 undefined 时生效；null 会穿透到属性读取。
    // 与模块头「纯函数、永不抛」的热路径承诺相悖，注册为缺陷、按现状钉死：
    // 若未来加了 null 兜底，本断言翻转即提醒更新登记表。不许软化为「may throw」。
    assert.throws(() => classifyProducer(null), TypeError);
    assert.throws(() => classify(null), TypeError);
    // 对照：undefined / 缺省走默认值分支，正常返回
    assert.doesNotThrow(() => classifyProducer(undefined));
    assert.strictEqual(classify().producer, 'khy-local');
  });
});
