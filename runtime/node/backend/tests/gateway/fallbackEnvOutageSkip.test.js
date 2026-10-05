'use strict';

/**
 * fallbackEnvOutageSkip.test.js — [DESIGN-ARCH-181] 二期:
 *   A) 环境级跳过接线三件套的纯函数面(planEnvOutageSkipStep / isEnvOutageActive /
 *      resetEnvOutagePass / ENV_OUTAGE_REPORT_NOTE);
 *   B) aiGatewayGenerateMethod.js 三处消费点(级联跳过 / jitter 前置 / 报告注记)与
 *      S2/S3 判据收拢的静态接线锁。
 *
 * 行为面(真跑级联)由 jest 套件钉住: tests/gateway/aiGateway.cascadeJitterSelfHeal.test.js
 * (环境级暂停远端 + jitter 前置 + fallbackOwnership:false 回滚)与
 * tests/gateway/aiGateway.networkResume.test.js(环境级证据仍交「等待网络恢复」)。
 * 本文件只钉纯函数语义与源码接线形态, 与真值行为测试互补。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const policy = require('../../src/services/gateway/fallbackEligibilityPolicy');

const SRC = path.join(
  __dirname,
  '..',
  '..',
  'src',
  'services',
  'gateway',
  'aiGatewayGenerateMethod.js'
);

const netFail = (key, extra = {}) => ({
  adapterKey: key,
  success: false,
  errorType: 'network',
  error: 'read ECONNRESET socket hang up',
  statusCode: 0,
  ...extra,
});

describe('[181] 二期 环境级跳过三件套(纯函数)', () => {
  test('W-01 policyOn=false(回滚面):三件套恒空转', () => {
    const st = { policyOn: false, armed: false, floor: 0 };
    const attempts = [netFail('a'), netFail('b')];
    const step = policy.planEnvOutageSkipStep(st, 'c', attempts);
    assert.equal(step.arm, false);
    assert.equal(step.skip, false);
    assert.equal(policy.isEnvOutageActive(st, attempts), false);
  });

  test('W-02 证据不足不动手:单通道 network(权重2<3)不触发', () => {
    const st = { policyOn: true, armed: false, floor: 0 };
    const step = policy.planEnvOutageSkipStep(st, 'b', [netFail('a')]);
    assert.equal(step.arm, false);
    assert.equal(step.skip, false);
  });

  test('W-03 跨通道复现成立(2 远端 network,权重4):arm + skip + 宣布文案与留痕', () => {
    const st = { policyOn: true, armed: false, floor: 0, announced: false };
    const attempts = [netFail('a'), netFail('b')];
    const step = policy.planEnvOutageSkipStep(st, 'c', attempts);
    assert.equal(step.arm, true);
    assert.equal(step.skip, true);
    assert.match(step.statusText, /暂停远端尝试/);
    assert.equal(step.skipEntry.errorType, 'env_outage_skip');
    assert.equal(step.skipEntry.virtualSkip, true);
    assert.equal(step.skipEntry.adapterKey, 'c');
  });

  test('W-04 证据窗口 floor:整轮重跑前置新后,上轮证据不再触发', () => {
    const attempts = [netFail('a'), netFail('b')];
    const st = { policyOn: true, armed: false, floor: 2 };
    const step = policy.planEnvOutageSkipStep(st, 'c', attempts);
    assert.equal(step.arm, false);
    assert.equal(step.skip, false);
  });

  test('W-05 目的地资格:本地不跳(arm 仍置), 人肉不跳', () => {
    const attempts = [netFail('a'), netFail('b')];
    const st = { policyOn: true, armed: false, floor: 0, localKeys: ['ollama', 'localLLM'] };
    const local = policy.planEnvOutageSkipStep(st, 'ollama', attempts);
    assert.equal(local.arm, true);
    assert.equal(local.skip, false);
    const manual = policy.planEnvOutageSkipStep(st, 'relay', attempts);
    assert.equal(manual.arm, true);
    assert.equal(manual.skip, false);
  });

  test('W-06 单次宣布:announced=true 时不再给文案;已留痕不再重复 push', () => {
    const attempts = [netFail('a'), netFail('b')];
    const st = { policyOn: true, armed: false, floor: 0, announced: true };
    const step = policy.planEnvOutageSkipStep(st, 'c', attempts);
    assert.equal(step.skip, true);
    assert.equal(step.statusText, '');
    const attempts2 = [
      ...attempts,
      { adapterKey: 'c', errorType: 'env_outage_skip', virtualSkip: true },
    ];
    const step2 = policy.planEnvOutageSkipStep(st, 'c', attempts2);
    assert.equal(step2.skip, true);
    assert.equal(step2.skipEntry, null);
  });

  test('W-07 isEnvOutageActive:armed 短路 + 证据窗口 + 远端成功证伪', () => {
    const env = [netFail('a'), netFail('b')];
    assert.equal(policy.isEnvOutageActive({ policyOn: true, armed: true, floor: 0 }, []), true);
    assert.equal(policy.isEnvOutageActive({ policyOn: true, armed: false, floor: 0 }, env), true);
    const falsified = [...env, { adapterKey: 'z', success: true }];
    assert.equal(
      policy.isEnvOutageActive({ policyOn: true, armed: false, floor: 0 }, falsified),
      false
    );
  });

  test('W-08 resetEnvOutagePass:清 armed/announced, floor 对齐当前长度', () => {
    const st = { policyOn: true, armed: true, announced: true, floor: 0 };
    const attempts = [netFail('a'), netFail('b'), netFail('c')];
    policy.resetEnvOutagePass(st, attempts);
    assert.equal(st.armed, false);
    assert.equal(st.announced, false);
    assert.equal(st.floor, 3);
  });

  test('W-09 绝不抛:垃圾输入安全缺省', () => {
    for (const bad of [null, undefined, 42, 'x', []]) {
      const step = policy.planEnvOutageSkipStep(bad, 'c', bad);
      assert.equal(step.skip, false);
      assert.equal(step.arm, false);
    }
    assert.equal(policy.isEnvOutageActive(null, null), false);
    assert.doesNotThrow(() => policy.resetEnvOutagePass(null, null));
  });

  test('W-10 报告注记:环境级语义 + khy doctor 指引', () => {
    assert.match(policy.ENV_OUTAGE_REPORT_NOTE, /网络\/代理不通/);
    assert.match(policy.ENV_OUTAGE_REPORT_NOTE, /khy doctor/);
  });
});

describe('[181] 二期 消费点静态接线锁(aiGatewayGenerateMethod.js)', () => {
  const src = fs.readFileSync(SRC, 'utf8');

  test('S-01 叶子导入(判据与三件套)', () => {
    assert.match(src, /require\('\.\/fallbackEligibilityPolicy'\)/);
    assert.ok(src.includes('strictRelaxQualifies: _strictRelaxQualifies'));
    assert.ok(src.includes('planEnvOutageSkipStep: _planEnvOutageSkipStep'));
  });

  test('S-02 消费点一:级联循环内跳过步进', () => {
    assert.ok(
      src.includes('const _envStep = _planEnvOutageSkipStep(_envGuard, entry.key, allAttempts);')
    );
    assert.ok(
      src.includes(
        'if (_envStep.skip) { if (_envStep.skipEntry) allAttempts.push(_envStep.skipEntry); continue; }'
      )
    );
    assert.ok(src.includes('_envGuard.armed = true'));
  });

  test('S-03 消费点二:jitter 前置判定(条件含环境级)', () => {
    assert.ok(src.includes('!_isEnvOutageActive(_envGuard, allAttempts)'));
  });

  test('S-04 消费点三:报告注记', () => {
    assert.ok(
      src.includes("(_isEnvOutageActive(_envGuard, allAttempts) ? _ENV_OUTAGE_REPORT_NOTE : '')")
    );
  });

  test('S-05 重跑重置:jitter 与续传两处 restart 均重置证据窗口', () => {
    const hits = src.split('_resetEnvOutagePass(_envGuard, allAttempts)').length - 1;
    assert.equal(hits, 2);
  });

  test('S-06 回滚面:状态袋以 options.fallbackOwnership !== false 承载', () => {
    assert.ok(src.includes('policyOn: options.fallbackOwnership !== false'));
  });

  test('S-07 S2/S3 判据收拢:_strictRelaxQualifies 委托,旧内联判据已删除', () => {
    assert.ok(src.includes('_strictRelaxQualifies({'));
    assert.ok(!src.includes('// 既有 process-sensitive 通道（IDE 桥接类）放宽路径保持不变。'));
    assert.ok(
      !src.includes('Number(this._adapterFailures[preferredAdapter] || 0) >= strictAutoRelaxMinFailures')
    );
  });
});
