'use strict';

// Co-located contract tests for errorCodes.js (C-4, [RESEARCH-018] §2.3).
// errorCodes is the single source of truth for E01–E08: every structured failure in
// the failsafe subsystem reads its reason / requiredFields / retryable / resumable /
// sensitive flags from this table, so these tests pin the *contract* the table grants
// to classifier.js and streamInjector.js, plus the fail-safe fallback path.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const errorCodes = require('./errorCodes');
const classifier = require('./classifier');

const { ERROR_CODES, FALLBACK_CODE, getErrorCode, listCodes, isKnownCode } = errorCodes;

// Safety net: the table is not frozen in source (pinned below), so any case that has
// to mutate it must leave it exactly as it was found for suites sharing this process.
const pristine = JSON.parse(JSON.stringify(ERROR_CODES));
after(() => {
  for (const code of Object.keys(pristine)) {
    Object.assign(ERROR_CODES[code], pristine[code]);
  }
});

describe('errorCodes 模块面', () => {
  test('导出面恰为五个文档成员，无多余黑话', () => {
    assert.deepEqual(Object.keys(errorCodes).sort(), [
      'ERROR_CODES',
      'FALLBACK_CODE',
      'getErrorCode',
      'isKnownCode',
      'listCodes',
    ]);
  });

  test('登记码恰为 E01–E08 八个，顺序稳定', () => {
    assert.deepEqual(listCodes(), ['E01', 'E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08']);
  });

  test('每个码都自带 code/category/reason/requiredFields/suggestion 且 code 与键一致', () => {
    for (const key of listCodes()) {
      const def = ERROR_CODES[key];
      assert.equal(def.code, key, `${key} 的 code 字段与登记表键不一致`);
      assert.ok(def.category.length > 0);
      assert.ok(def.reason.length > 0);
      assert.ok(def.suggestion.length > 0);
      assert.ok(Array.isArray(def.requiredFields) && def.requiredFields.length > 0);
      assert.equal(new Set(def.requiredFields).size, def.requiredFields.length, `${key} 必填字段有重复`);
    }
  });

  test('模糊文案禁令：reason 里不得出现被废除的废话', () => {
    const banned = ['未知错误', '请求失败', '未返回有效回复', '发生错误', '处理中'];
    for (const key of listCodes()) {
      for (const phrase of banned) {
        assert.ok(!ERROR_CODES[key].reason.includes(phrase), `${key}.reason 含被废除文案「${phrase}」`);
      }
    }
  });

  test('只有安全审查与权限拦截两类需要脱敏（E02/E07）', () => {
    const sensitive = listCodes().filter((k) => ERROR_CODES[k].sensitive === true);
    assert.deepEqual(sensitive, ['E02', 'E07']);
    assert.equal(listCodes().filter((k) => ERROR_CODES[k].sensitive === false).length, 6);
  });

  test('resumable 与 continueHint 的耦合：可续接必有一句话，不可续接必为 null', () => {
    for (const key of listCodes()) {
      const def = ERROR_CODES[key];
      if (def.resumable) {
        assert.equal(typeof def.continueHint, 'string', `${key} resumable 却缺 continueHint`);
        assert.ok(def.continueHint.includes('继续'), `${key} 的续接提示应告诉用户说「继续」`);
      } else {
        assert.equal(def.continueHint, null, `${key} 不可续接却给了 continueHint`);
      }
    }
  });

  test('安全/权限/上下文溢出/工具崩溃/依赖缺失一律不可自动续接', () => {
    for (const key of ['E02', 'E03', 'E04', 'E05', 'E07']) {
      assert.equal(ERROR_CODES[key].resumable, false, `${key} 不应可续接`);
    }
    for (const key of ['E01', 'E06', 'E08']) {
      assert.equal(ERROR_CODES[key].resumable, true, `${key} 应可续接`);
    }
  });

  test('retryable 与 resumable 是两回事：E05 可重试但续接无意义', () => {
    assert.equal(ERROR_CODES.E05.retryable, true);
    assert.equal(ERROR_CODES.E05.resumable, false);
    assert.equal(ERROR_CODES.E03.retryable, false, '上下文溢出原样重发必然再次溢出');
  });
});

describe('getErrorCode / isKnownCode 的边界与兜底', () => {
  test('FALLBACK_CODE 自身是已登记码，且 getErrorCode 返回同一定义对象', () => {
    assert.equal(isKnownCode(FALLBACK_CODE), true);
    assert.equal(getErrorCode(FALLBACK_CODE), ERROR_CODES[FALLBACK_CODE]);
  });

  test('未知/畸形码 fail-safe 回落到 FALLBACK_CODE 的定义对象', () => {
    const junk = ['E09', 'e01', 'E1', '', '   ', null, undefined, 0, -1, NaN, 1e309, {}, [], true, false, 10n];
    for (const key of junk) {
      assert.equal(getErrorCode(key), ERROR_CODES[FALLBACK_CODE], `未知码 ${String(key)} 未回落兜底`);
    }
  });

  test('isKnownCode 只认登记键，原型键与数字一律拒绝', () => {
    for (const key of listCodes()) {
      assert.equal(isKnownCode(key), true, `${key} 应被认得`);
    }
    const notKnown = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'E0 ', '0', 0, null, undefined, NaN, {}, [], () => {}];
    for (const key of notKnown) {
      assert.equal(isKnownCode(key), false, `isKnownCode 误认 ${String(key)}`);
    }
  });

  test('listCodes 每次返回新数组，调用方 sort/pop 不会污染登记表', () => {
    const first = listCodes();
    first.push('FAKE');
    first[0] = 'CLOBBERED';
    assert.equal(listCodes().includes('FAKE'), false);
    assert.equal(listCodes()[0], 'E01');
    assert.equal(isKnownCode('FAKE'), false);
  });

  test('KNOWN-DEFECT: getErrorCode 走原型链取值，原型键不回落兜底而是返回 Object 自身', () => {
    // errorCodes.js:123 `ERROR_CODES[code] || ERROR_CODES[FALLBACK_CODE]` uses plain
    // bracket access with no own-property guard, so an inherited member is truthy and is
    // returned instead of the documented fail-safe fallback. Callers that then read
    // `.reason` / `.requiredFields` get undefined and crash downstream, defeating the
    // header promise "未知码 fail-safe 回落 FALLBACK_CODE，绝不返回空".
    assert.equal(getErrorCode('constructor'), Object, '返回的是 Object 构造器而非兜底定义');
    assert.equal(getErrorCode('constructor').code, undefined);
    assert.equal(getErrorCode('constructor').requiredFields, undefined);
    assert.equal(getErrorCode('__proto__'), Object.prototype);
    assert.equal(typeof getErrorCode('toString'), 'function');
    // isKnownCode does use hasOwnProperty, so the two functions disagree on the same key.
    assert.equal(isKnownCode('constructor'), false);
  });

  test('KNOWN-DEFECT: 单一真源表完全没有冻结，任何持有引用的模块都能改写全局归因文案', () => {
    // errorCodes.js:116 closes the object literal with no Object.freeze anywhere, and
    // index.js re-exports the same live reference. "reason 文案只能取自本表（固定、可枚举）"
    // is therefore unenforced: one stray write changes every later attribution in the
    // process, including the user-visible suggestion.
    assert.equal(Object.isFrozen(ERROR_CODES), false);
    assert.equal(Object.isFrozen(ERROR_CODES.E02), false);
    assert.equal(ERROR_CODES.E02.sensitive, true);

    ERROR_CODES.E02.sensitive = false;
    ERROR_CODES.E02.reason = '被外部改写的文案';
    const viaClassifier = classifier.classify({ error_code: 'E02', model: 'm' });
    assert.equal(viaClassifier.reason, '被外部改写的文案', 'classifier 直接读表，改写在别处也会生效');
    assert.equal(viaClassifier.sensitive, false, '脱敏标记被改掉后 classifier 不再脱敏');

    ERROR_CODES.E02.sensitive = true;
    ERROR_CODES.E02.reason = pristine.E02.reason;
    assert.equal(classifier.classify({ error_code: 'E02', model: 'm' }).sensitive, true);
  });

  test('KNOWN-DEFECT: requiredFields 数组本身可变，push 一个字段就让所有该码归因永久标记为不完整', () => {
    // errorCodes.js:54 E03 requiredFields is a plain mutable array. classifier.js:174
    // iterates def.requiredFields and fills missing ones with 'unknown', flipping
    // attribution_complete to false — so one push silently degrades every future E03.
    const before = classifier.classify({ error_code: 'E03', model: 'm', ctx_limit: 8, required_tokens: 9 });
    assert.equal(before.attribution_complete, true);

    ERROR_CODES.E03.requiredFields.push('phantom_field');
    const after = classifier.classify({ error_code: 'E03', model: 'm', ctx_limit: 8, required_tokens: 9 });
    assert.deepEqual(after.fields.phantom_field, 'unknown');
    assert.equal(after.attribution_complete, false, '凭空字段被当成必填项缺失');

    const idx = ERROR_CODES.E03.requiredFields.indexOf('phantom_field');
    ERROR_CODES.E03.requiredFields.splice(idx, 1);
    assert.equal(
      classifier.classify({ error_code: 'E03', model: 'm', ctx_limit: 8, required_tokens: 9 }).attribution_complete,
      true
    );
  });
});
