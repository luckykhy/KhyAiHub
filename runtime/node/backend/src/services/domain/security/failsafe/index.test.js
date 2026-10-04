'use strict';

// Co-located contract tests for failsafe/index.js (C-4, [RESEARCH-018] §2.3).
// The facade is the only surface most consumers import, so what matters here is the
// shell invariant (same bindings, no added behaviour) plus the one thing a facade can
// accidentally add: an unprotected handle on the mutable single-source-of-truth table.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const facade = require('./index');
const classifier = require('./classifier');
const errorCodes = require('./errorCodes');
const safeResponse = require('./safeResponse');
const streamInjector = require('./streamInjector');

// process.env read by streamInjector when installing the process-level guards.
const GUARD_ENV = 'KHY_FAILSAFE_PROCESS_GUARD';
const priorEnv = process.env[GUARD_ENV];
process.env[GUARD_ENV] = 'off';
after(() => {
  if (priorEnv === undefined) {
    delete process.env[GUARD_ENV];
  } else {
    process.env[GUARD_ENV] = priorEnv;
  }
  facade.StreamFailSafeInjector._clearActive();
});

describe('门面是纯壳：绑定同一，不加行为', () => {
  test('导出面恰为头注释承诺的 10 个成员', () => {
    assert.deepEqual(Object.keys(facade).sort(), [
      'ERROR_CODES',
      'FALLBACK_CODE',
      'SafeResponseWrapper',
      'StreamFailSafeInjector',
      'classify',
      'classifyCode',
      'getErrorCode',
      'isKnownCode',
      'listCodes',
      'sweepActive',
    ]);
  });

  test('每个成员都是子模块的同一绑定，而非包一层', () => {
    assert.equal(facade.classify, classifier.classify);
    assert.equal(facade.classifyCode, classifier.classifyCode);
    assert.equal(facade.ERROR_CODES, errorCodes.ERROR_CODES);
    assert.equal(facade.FALLBACK_CODE, errorCodes.FALLBACK_CODE);
    assert.equal(facade.getErrorCode, errorCodes.getErrorCode);
    assert.equal(facade.listCodes, errorCodes.listCodes);
    assert.equal(facade.isKnownCode, errorCodes.isKnownCode);
    assert.equal(facade.SafeResponseWrapper, safeResponse.SafeResponseWrapper);
    assert.equal(facade.StreamFailSafeInjector, streamInjector.StreamFailSafeInjector);
    assert.equal(facade.sweepActive, streamInjector.sweepActive);
  });

  test('头注释声明的四个组成里，classifierSignals 与 legacy 深链不进公共面', () => {
    // classifier.js exports _mapToolErrorCode/_mapKind for reuse; the facade deliberately
    // stops at the documented surface, so internal mapping must not leak through it.
    for (const internal of ['_mapToolErrorCode', '_mapKind', 'classifySignals', 'errorClassifier', 'SafeResponse']) {
      assert.equal(Object.prototype.hasOwnProperty.call(facade, internal), false, `门面多带了 ${internal}`);
    }
  });

  test('require 门面不会在 process 上装兜底监听器（无隐式全局副作用）', () => {
    const counts = ['uncaughtException', 'unhandledRejection', 'SIGTERM', 'SIGINT'].map((k) => process.listenerCount(k));
    const inj = new facade.StreamFailSafeInjector({ send: () => {} });
    assert.deepEqual(
      ['uncaughtException', 'unhandledRejection', 'SIGTERM', 'SIGINT'].map((k) => process.listenerCount(k)),
      counts,
      '门面导入即挂进程监听器会污染同进程的其它套件'
    );
    inj.dispose();
  });
});

describe('通过门面走完整链路', () => {
  test('归因链：任意垃圾信号都拿到登记码，且与直接用子模块一致', () => {
    const junk = [null, undefined, '', 0, NaN, -1, {}, [], 'constructor', { toString: 1 }, true];
    for (const input of junk) {
      const viaFacade = facade.classify(input);
      assert.equal(facade.isKnownCode(viaFacade.error_code), true);
      assert.equal(viaFacade.error_code, classifier.classify(input).error_code);
      assert.equal(viaFacade.reason, facade.getErrorCode(viaFacade.error_code).reason);
    }
    assert.equal(facade.classifyCode({ errorType: 'empty_reply' }, { model: 'm' }), 'E01');
  });

  test('字典链：八个码齐全，未知码落兜底 E04', () => {
    assert.deepEqual(facade.listCodes(), ['E01', 'E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08']);
    assert.equal(facade.FALLBACK_CODE, 'E04');
    assert.equal(facade.getErrorCode('E42'), facade.ERROR_CODES.E04);
  });

  test('拦截器链：经门面构造的 wrapper 仍把空 LLM 响应转成结构化错误', async () => {
    const w = new facade.SafeResponseWrapper({ kind: 'llm', model: 'm' });
    const empty = await w.guard(async () => '');
    assert.equal(empty.ok, false);
    assert.equal(empty.failure.error_code, 'E01');
    assert.equal(facade.classify(empty.failure).error_code, 'E01', '归因结果可再入分类器');
    const good = await w.guard(async () => '正文');
    assert.equal(good.ok, true);
  });

  test('流式链：经门面登记的注入器被 sweepActive 补写终态事件', () => {
    facade.StreamFailSafeInjector._clearActive();
    const events = [];
    new facade.StreamFailSafeInjector({ send: (e) => events.push(e), context: { requestId: 'facade-req' } });
    facade.sweepActive({ error_code: 'E06', message: 'process received SIGTERM', endpoint: 'process' });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'error');
    assert.equal(events[0].error_code, 'E06');
    assert.equal(events[0].requestId, 'facade-req');
    assert.equal(events[0].detail.includes('process received SIGTERM'), true);
  });

  test('KNOWN-DEFECT: 门面把可变字典原样递给调用方，一处改写全局归因', () => {
    // index.js:27 re-exports `errorCodes.ERROR_CODES` by reference with no copy and no
    // freeze, and classifier.js reads that same live table on every call. A consumer that
    // "just tweaks a suggestion locally" changes the user-visible文案 for every other
    // subsystem in the process — including the sensitive flag that gates redaction.
    assert.equal(facade.ERROR_CODES, errorCodes.ERROR_CODES, '门面未做只读隔离');
    const original = errorCodes.ERROR_CODES.E07.sensitive;
    assert.equal(original, true);

    facade.ERROR_CODES.E07.sensitive = false;
    const leaked = facade.classify({ allow: false, decision: 'deny', reasons: ['INTERNAL_POLICY_42'] });
    assert.equal(leaked.sensitive, false, '脱敏标记被门面句柄改掉，前端不再按敏感错误处理');
    // classifier.js:184 branches on `sensitive`, so the fixed 管控 template is replaced by
    // the raw fall-through path (fields stay whitelisted only because _collectFields keys
    // off the code, not the flag).
    assert.equal(leaked.detail, '操作被审批网关拒绝');
    assert.doesNotMatch(leaked.detail, /触发了系统管控策略/);

    facade.ERROR_CODES.E07.sensitive = original;
    assert.equal(facade.classify({ allow: false, decision: 'deny' }).sensitive, true);
  });
});
