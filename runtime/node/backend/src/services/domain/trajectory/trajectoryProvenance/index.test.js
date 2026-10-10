'use strict';

/**
 * index.test.js — 钉死 trajectoryProvenance 桶文件（barrel）契约：
 * khyTrace 十项顶层导出经 spread 透出且与 ./khyTrace 同引用（单一真源、无第二份拷贝）、
 * classify/classifyProducer 与 ./provenanceClassifier 同引用、九个命名空间 re-export
 * 与直接 require 同模块实例、冻结枚举穿越桶后仍冻结。表面多一个键或少一个键都会
 * 翻转第一支测试——这是防「桶面漂移」的棘轮。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const barrel = require('./index.js');
const khyTrace = require('./khyTrace.js');
const provenanceClassifier = require('./provenanceClassifier.js');
const traceProjection = require('./traceProjection.js');
const traceChain = require('./traceChain.js');
const quarantinePolicy = require('./quarantinePolicy.js');
const claimReconciler = require('./claimReconciler.js');

describe('barrel 公共表面', () => {
  test('导出面恰为 21 个键（khyTrace 10 + classify 2 + 命名空间别名 9），不多不少', () => {
    assert.deepStrictEqual(Object.keys(barrel).sort(), [
      'KIND',
      'PRODUCER',
      'TRACE_VERSION',
      'TRUST',
      'chain',
      'claimReconciler',
      'classify',
      'classifyProducer',
      'isRelayed',
      'isTrace',
      'khyTrace',
      'makeTrace',
      'normalizeProducer',
      'projection',
      'provenanceClassifier',
      'quarantine',
      'quarantinePolicy',
      'stamp',
      'traceChain',
      'traceOf',
      'traceProjection',
    ]);
  });

  test('khyTrace 全部顶层导出经 spread 可达且与源模块 === 同引用（无第二份拷贝）', () => {
    // 反空转：先证明源模块导出面非空，再逐键比引用
    assert.ok(Object.keys(khyTrace).length > 0);
    for (const key of Object.keys(khyTrace)) {
      assert.strictEqual(barrel[key], khyTrace[key], `${key} 必须与 ./khyTrace 同引用`);
    }
    assert.strictEqual(typeof barrel.makeTrace, 'function');
    assert.strictEqual(typeof barrel.stamp, 'function');
    assert.strictEqual(typeof barrel.isTrace, 'function');
    assert.strictEqual(typeof barrel.traceOf, 'function');
    assert.strictEqual(typeof barrel.isRelayed, 'function');
    assert.strictEqual(typeof barrel.normalizeProducer, 'function');
    assert.strictEqual(barrel.TRACE_VERSION, 1);
  });

  test('classify / classifyProducer 与 ./provenanceClassifier 同一函数对象', () => {
    assert.ok(Object.keys(provenanceClassifier).length > 0);
    assert.strictEqual(barrel.classify, provenanceClassifier.classify);
    assert.strictEqual(barrel.classifyProducer, provenanceClassifier.classifyProducer);
  });

  test('别名命名空间与全称命名空间同实例，且都等于直接 require 的模块对象', () => {
    assert.strictEqual(barrel.khyTrace, khyTrace);
    assert.strictEqual(barrel.provenanceClassifier, provenanceClassifier);
    assert.strictEqual(barrel.projection, traceProjection);
    assert.strictEqual(barrel.traceProjection, traceProjection);
    assert.strictEqual(barrel.chain, traceChain);
    assert.strictEqual(barrel.traceChain, traceChain);
    assert.strictEqual(barrel.quarantine, quarantinePolicy);
    assert.strictEqual(barrel.quarantinePolicy, quarantinePolicy);
    assert.strictEqual(barrel.claimReconciler, claimReconciler);
    // projection 与 traceProjection 是同一对象两个把手（不是拷贝）
    assert.strictEqual(barrel.projection, barrel.traceProjection);
    assert.strictEqual(barrel.chain, barrel.traceChain);
    assert.strictEqual(barrel.quarantine, barrel.quarantinePolicy);
  });

  test('九个命名空间 re-export 的导出面均非空（反空转：桶里不许挂空对象）', () => {
    for (const key of ['khyTrace', 'provenanceClassifier', 'projection', 'chain', 'quarantine',
      'traceProjection', 'traceChain', 'quarantinePolicy', 'claimReconciler']) {
      const ns = barrel[key];
      assert.ok(ns && typeof ns === 'object', `${key} 必须是对象`);
      assert.ok(Object.keys(ns).length > 0, `${key} 导出面不得为空`);
    }
  });

  test('冻结枚举穿越桶后仍冻结，改写仍抛 TypeError 且值不动', () => {
    assert.ok(Object.isFrozen(barrel.PRODUCER));
    assert.ok(Object.isFrozen(barrel.TRUST));
    assert.ok(Object.isFrozen(barrel.KIND));
    assert.throws(() => { barrel.PRODUCER.KHY_LOCAL = 'evil'; }, TypeError);
    assert.strictEqual(barrel.PRODUCER.KHY_LOCAL, 'khy-local');
  });

  test('经桶与经源模块两条路径调用同一函数得同一结果（行为一致性抽查）', () => {
    const viaBarrel = barrel.makeTrace({ producer: 'codex' });
    const viaSource = khyTrace.makeTrace({ producer: 'codex' });
    assert.strictEqual(viaBarrel.producer, viaSource.producer);
    assert.strictEqual(viaBarrel.trust, viaSource.trust);
    assert.strictEqual(barrel.isRelayed('relay'), khyTrace.isRelayed('relay'));
    assert.deepStrictEqual(
      barrel.classify({ adapter: 'codex-direct' }),
      provenanceClassifier.classify({ adapter: 'codex-direct' }),
    );
  });
});
