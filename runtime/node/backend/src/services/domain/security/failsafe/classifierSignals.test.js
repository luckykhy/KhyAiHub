'use strict';

// Co-located contract tests for classifierSignals.js (C-4, [RESEARCH-018] §2.3).
// This leaf is the "signal reading + text redaction/clipping" layer of ErrorClassifier:
// pure predicates that turn an arbitrary raw failure signal into an E0x code, plus the
// three clippers that keep raw error text from escaping. The security-critical half is
// the redaction: whatever these functions hand back can end up in a user-visible
// detail, so the clipping caps and the secret-masking behaviour are pinned here.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const sig = require('./classifierSignals');
const { isKnownCode } = require('./errorCodes');

const MAX_DETAIL = 400;
const MAX_STACK = 1200;
const MAX_SNIPPET = 300;

describe('_readExplicitCode：已归因信号的幂等读取', () => {
  test('顶层与嵌套两种拼法都认，且必须是登记过的码', () => {
    assert.equal(sig._readExplicitCode({ error_code: 'E03' }), 'E03');
    assert.equal(sig._readExplicitCode({ errorCode: 'E06' }), 'E06');
    assert.equal(sig._readExplicitCode({ error: { error_code: 'E08' } }), 'E08');
    assert.equal(sig._readExplicitCode({ error: { errorCode: 'E05' } }), 'E05');
  });

  test('未登记码/非字符串/非对象一律返回 null（不当作已归因）', () => {
    const junk = [{ error_code: 'E09' }, { error_code: 'e01' }, { error_code: 404 }, { error_code: '' }, { error_code: null }, { error: { error_code: 'NOPE' } }, {}, [], 'E02', 0, -1, NaN, null, undefined, true];
    for (const input of junk) {
      assert.equal(sig._readExplicitCode(input), null, `${String(input)} 不该读出显式码`);
    }
  });

  test('顶层码优先于嵌套码', () => {
    assert.equal(sig._readExplicitCode({ error_code: 'E01', error: { error_code: 'E06' } }), 'E01');
  });

  test('KNOWN-DEFECT: 原型链上的 error_code 被当成显式归因，凭空信任继承属性', () => {
    // classifierSignals.js:38 `const c = o.error_code || o.errorCode` reads through the
    // prototype chain, so an object created from a polluted prototype claims an
    // attribution it never carried. isKnownCode itself uses hasOwnProperty, so the
    // "only registered codes" guard cannot catch this vector.
    const inherited = Object.create({ error_code: 'E03' });
    assert.equal(sig._readExplicitCode(inherited), 'E03');
    assert.equal(Object.prototype.hasOwnProperty.call(inherited, 'error_code'), false);
    assert.equal(isKnownCode('E03'), true, 'E03 是合法码，所以这道门完全放行');
  });
});

describe('_readDenyVerdict / _looksLikeDenyVerdict：审批网关裁决形状', () => {
  test('四种拒绝表达都算 deny，且必须带审批语境特征', () => {
    const verdicts = [
      { allow: false, decision: 'deny' },
      { allow: false, denied: 1, reasons: [] },
      { decision: 'denied', level: 3 },
      { decision: 'block', tripped: false },
      { tripped: true },
    ];
    for (const v of verdicts) {
      assert.equal(sig._looksLikeDenyVerdict(v), true, `${JSON.stringify(v)} 应判为拒绝裁决`);
      assert.equal(sig._readDenyVerdict(v), v, 'readDenyVerdict 原样返回裁决对象');
    }
  });

  test('裸 {allow:false} 不算裁决：缺审批语境特征时拒绝误吞', () => {
    assert.equal(sig._looksLikeDenyVerdict({ allow: false }), false);
    assert.equal(sig._readDenyVerdict({ allow: false }), null);
    assert.equal(sig._looksLikeDenyVerdict({ decision: 'deny' }), true, 'decision 本身就是语境特征');
  });

  test('放行裁决与 approval_level-only 的对象都不是 deny', () => {
    assert.equal(sig._looksLikeDenyVerdict({ allow: true, decision: 'allow' }), false);
    assert.equal(sig._looksLikeDenyVerdict({ approval_level: 5 }), false, '只有级别没有拒绝信号');
    assert.equal(sig._looksLikeDenyVerdict({ decision: 'ALLOW' }), false, 'decision 判定是大小写敏感的');
  });

  test('非对象输入安全返回 null/false，不抛', () => {
    for (const junk of [null, undefined, 0, '', 'deny', [], NaN, 10n, () => {}]) {
      assert.equal(sig._looksLikeDenyVerdict(junk), false);
      assert.equal(sig._readDenyVerdict(junk), null);
    }
  });

  test('allow:false 与 decision:allow 并存时按 deny 处理（拒绝优先）', () => {
    assert.equal(sig._looksLikeDenyVerdict({ allow: false, decision: 'allow' }), true);
  });
});

describe('_looksLikeMissingDependency / _readMissingDep：依赖缺失信号', () => {
  test('三种依赖缺失表达都识别', () => {
    assert.equal(sig._looksLikeMissingDependency({ name: 'MissingDependencyError' }), true);
    assert.equal(sig._looksLikeMissingDependency({ depId: 'ffmpeg' }), true);
    assert.equal(sig._looksLikeMissingDependency({ code: 'MISSING_DEPENDENCY' }), true);
  });

  test('其它大写错误码/普通对象/垃圾输入不误判为依赖缺失', () => {
    for (const input of [{ code: 'TIMEOUT' }, { name: 'ToolError' }, {}, [], 'MissingDependencyError', null, undefined, 0, NaN]) {
      assert.equal(sig._looksLikeMissingDependency(input), false, `${String(input)} 不该判为缺依赖`);
    }
  });

  test('depId / missing_dep / error.depId / ctx.missingDep 四级取源顺序', () => {
    assert.equal(sig._readMissingDep({ depId: 'a' }, {}), 'a');
    assert.equal(sig._readMissingDep({ missing_dep: 'b' }, {}), 'b');
    assert.equal(sig._readMissingDep({ error: { depId: 'c' } }, {}), 'c');
    assert.equal(sig._readMissingDep({}, { missingDep: 'd' }), 'd');
    assert.equal(sig._readMissingDep({}, { depId: 'e' }), 'e');
    assert.equal(sig._readMissingDep({}, {}), undefined, '无源时返回 undefined，交给上层填 unknown');
  });

  test('KNOWN-DEFECT: ctx 传 null 时 _readMissingDep 直接解引用抛 TypeError', () => {
    // classifierSignals.js:103 reads `ctx.missingDep` after guarding only `input`, while
    // classifier.js:70 normalizes context with `context || {}`. The leaf is exported as a
    // reusable face (module.exports at the bottom), so a direct caller passing null ctx —
    // e.g. an upstream that stores `undefined` in a field — crashes instead of degrading.
    // The early-return on input.depId still works, which is why the crash is easy to miss.
    assert.equal(sig._readMissingDep({ depId: 'x' }, null), 'x');
    assert.equal(sig._readMissingDep({ missing_dep: 'b' }, undefined), 'b');
    assert.throws(() => sig._readMissingDep({}, null), TypeError);
    assert.throws(() => sig._readMissingDep(null, undefined), TypeError);
  });
});

describe('_readToolErrorCode / _mapToolErrorCode：工具错误码分流', () => {
  test('顶层码要求全大写形态，映射表覆盖 7 个已知码', () => {
    assert.equal(sig._readToolErrorCode({ code: 'TIMEOUT' }), 'TIMEOUT');
    assert.equal(sig._mapToolErrorCode('MISSING_DEPENDENCY'), 'E05');
    assert.equal(sig._mapToolErrorCode('PERMISSION_DENIED'), 'E07');
    assert.equal(sig._mapToolErrorCode('TIMEOUT'), 'E06');
    assert.equal(sig._mapToolErrorCode('NETWORK_ERROR'), 'E06');
    for (const code of ['EXECUTION_ERROR', 'TOOL_UNAVAILABLE', 'INVALID_ARGS', 'RESOURCE_NOT_FOUND']) {
      assert.equal(sig._mapToolErrorCode(code), 'E04', `${code} 应归工具执行崩溃`);
    }
  });

  test('未登记码返回 null，让分类器继续往下找更强信号', () => {
    for (const code of ['ENOENT', 'EACCES', '', 'ANYTHING_NEW', 'PERMISSION_DENIED_X']) {
      assert.equal(sig._mapToolErrorCode(code), null);
    }
    assert.equal(sig._mapToolErrorCode(undefined), null);
  });

  test('顶层 code 必须是纯大写形态，小写/带数字被拒', () => {
    assert.equal(sig._readToolErrorCode({ code: 'timeout' }), null);
    assert.equal(sig._readToolErrorCode({ code: 'E_404' }), null);
    assert.equal(sig._readToolErrorCode({ code: 'A-B' }), null);
    assert.equal(sig._readToolErrorCode({ code: 404 }), null, '数字码不当工具错误码');
    assert.equal(sig._readToolErrorCode({ code: '' }), null);
  });

  test('KNOWN-DEFECT: 嵌套 error.code 绕过全大写形态校验，任意字符串都被当作工具错误码', () => {
    // classifierSignals.js:113 only checks `typeof o.error.code === 'string'` with no
    // /^[A-Z_]+$/ guard, unlike the top-level branch at line 110. Free-form provider
    // text therefore enters the code pipeline; _mapToolErrorCode then returns null for
    // it, so the mis-shape is invisible rather than rejected.
    assert.equal(sig._readToolErrorCode({ error: { code: 'lower case with spaces' } }), 'lower case with spaces');
    assert.equal(sig._readToolErrorCode({ error: { code: '13' } }), '13');
    assert.equal(sig._mapToolErrorCode(sig._readToolErrorCode({ error: { code: 'whatever' } })), null);
  });

  test('非对象输入返回 null 而非抛出', () => {
    for (const junk of [null, undefined, 0, '', 'TIMEOUT', NaN, []]) {
      assert.equal(sig._readToolErrorCode(junk), null);
    }
  });
});

describe('_isSafetyFinish：内容安全停止判定', () => {
  test('四个精确停止原因与两类子串命中都算安全停止', () => {
    for (const f of ['content_filter', 'refusal', 'safety', 'stop_violation', 'xxx_filter_xxx', 'no_refuse_policy']) {
      assert.equal(sig._isSafetyFinish(f), true, `${f} 应判安全停止`);
    }
  });

  test('正常停止原因与非字符串输入不放行', () => {
    for (const f of ['stop', 'length', 'tool_calls', 'end_turn', '', 'STOP', 'REFUSAL']) {
      assert.equal(sig._isSafetyFinish(f), false, `${JSON.stringify(f)} 不该判安全停止`);
    }
  });

  test('子串匹配比精确匹配宽：大小写不同需调用方先 lowercase', () => {
    assert.equal(sig._isSafetyFinish('Content_Filter'), false);
    assert.equal(sig._isSafetyFinish('content_filter'.toLowerCase()), true);
  });
});

describe('_mapKind：通用错误分类 → E0x', () => {
  test('六类 kind 的归位，与 errorCodes 的类别语义一致', () => {
    assert.equal(sig._mapKind('refusal'), 'E02');
    assert.equal(sig._mapKind('context_length'), 'E03');
    assert.equal(sig._mapKind('permission'), 'E07');
    for (const kind of ['timeout', 'network', 'rate_limit', 'overloaded', 'server_error']) {
      assert.equal(sig._mapKind(kind), 'E06', `${kind} 应归网络层熔断`);
    }
  });

  test('未映射 kind 返回 null（含 auth/billing/cancelled/model_not_found/process）', () => {
    for (const kind of ['auth', 'billing', 'cancelled', 'model_not_found', 'process', 'unknown', '', undefined, null, 0]) {
      assert.equal(sig._mapKind(kind), null);
    }
  });
});

describe('_detectKind：向 legacy errorClassifier 深链探测', () => {
  test('从 message 文本、code 与 ctx.httpStatus 三条路都能探出 kind', () => {
    assert.equal(sig._detectKind(new Error('upstream timeout after 30s'), {}), 'timeout');
    assert.equal(sig._detectKind({ code: 'ECONNREFUSED' }, {}), 'network');
    assert.equal(sig._detectKind({ message: 'prompt is too long' }, {}), 'context_length');
    assert.equal(sig._detectKind({}, { httpStatus: 429 }), 'rate_limit');
    assert.equal(sig._detectKind('fetch failed', {}), 'network', '字符串输入也被包成 {message} 探测');
  });

  test('探不出来时返回 undefined，不返回 null（调用方用 _mapKind 兜底）', () => {
    assert.equal(sig._detectKind(new Error('完全无关的描述'), {}), undefined);
    assert.equal(sig._detectKind(null, {}), undefined);
    assert.equal(sig._detectKind(0, {}), undefined);
    assert.equal(sig._detectKind('', {}), undefined);
    assert.equal(sig._detectKind({}, {}), undefined);
  });

  test('KNOWN-DEFECT: ctx 缺省时 _detectKind 抛 TypeError（叶子没有自己的 context 兜底）', () => {
    // classifierSignals.js:150 dereferences `ctx.httpStatus` before anything else, and the
    // `context || {}` normalization lives only in classifier.js:70. Called straight from the
    // exported leaf with a missing context the "pure helper" crashes instead of probing.
    assert.throws(() => sig._detectKind(new Error('boom'), undefined), TypeError);
    assert.throws(() => sig._detectKind(new Error('boom'), null), TypeError);
  });

  test('KNOWN-DEFECT: 探测过程把 ctx.httpStatus 回写进调用方的 input 对象（就地 mutation）', () => {
    // classifierSignals.js:152-154 assigns `probe.code = status` while probe still is the
    // caller's own object (line 151 keeps the reference for objects). A raw failure signal
    // that is a shared/replayed payload therefore grows a fabricated `.code` field and the
    // next consumer sees an error code the upstream never sent.
    const input = { message: 'gateway hiccup' };
    assert.equal(sig._detectKind(input, { httpStatus: 503 }), 'server_error');
    assert.equal(input.code, 503, 'input 被就地改写');
    assert.deepEqual(Object.keys(input), ['message', 'code']);
  });

  test('KNOWN-DEFECT: 冻结的失败信号会让深链探测抛 TypeError（只读对象无法被回写）', () => {
    // Same mutation as above, but on a frozen/sealed signal — which is how callers hand
    // over a shared verdict. _detectKind has no try/catch, so classify() only survives
    // because classifier.js:74 swallows it into FALLBACK_CODE, i.e. the attribution
    // silently degrades to E04 instead of the correct E06 server_error.
    const frozen = Object.freeze({ message: 'gateway hiccup' });
    assert.throws(() => sig._detectKind(frozen, { httpStatus: 503 }), TypeError);
    assert.equal(require('./classifier').classifyCode(frozen, { httpStatus: 503 }), 'E04');
  });
});

describe('_redactedMessage：原始报错文本的脱敏与裁剪', () => {
  test('五种输入形态都能取到可读文本，不抛', () => {
    assert.equal(sig._redactedMessage(new Error('boom'), {}), 'boom');
    assert.equal(sig._redactedMessage('plain string', {}), 'plain string');
    assert.equal(sig._redactedMessage({ message: 'structured' }, {}), 'structured');
    assert.equal(sig._redactedMessage({ error: { message: 'nested' } }, {}), 'nested');
    assert.equal(sig._redactedMessage({ error: 'bare string' }, {}), 'bare string');
    assert.equal(sig._redactedMessage({}, { message: 'from ctx' }), 'from ctx');
  });

  test('Error 的 cause 链被串进一条文本', () => {
    const err = new Error('outer', { cause: new Error('inner reason') });
    const out = sig._redactedMessage(err, {});
    assert.ok(out.includes('outer') && out.includes('inner reason'), out);
  });

  test('KNOWN-DEFECT: 数字 0 / false 的报错正文被 `String(x || \'\')` 吞成空串', () => {
    // classifierSignals.js:195 falls back to `String(input || '')`, and classifierSignals.js:197
    // wraps it in `String(raw || '')`. A numeric or boolean payload (some gateways return the
    // status word as a bare number) is falsy, so the message silently becomes ''.
    assert.equal(sig._redactedMessage(0, {}), '');
    assert.equal(sig._redactedMessage(false, {}), '');
    assert.equal(sig._redactedMessage(NaN, {}), '');
    assert.equal(sig._redactedMessage({ message: 0 }, {}), '', 'message:0 同样被吞');
    // Contrast: a non-falsy scalar survives, so the loss is specific to falsy values.
    assert.equal(sig._redactedMessage(7, {}), '7');
  });

  test('密钥/token 在返回前被掩码，原文绝不外泄', () => {
    const raw = 'auth failed with key sk-ABCDEFGHIJKLMNOPQRSTUV and Authorization: Bearer abcdefghijklmnop1234';
    const out = sig._redactedMessage(raw, {});
    assert.ok(!out.includes('sk-ABCDEFGHIJKLMNOPQRSTUV'), `密钥明文泄露: ${out}`);
    assert.ok(!out.includes('abcdefghijklmnop1234'), `Bearer 明文泄露: ${out}`);
    assert.ok(out.includes('sk-ABC'), `掩码应保留可辨识的头尾: ${out}`);
  });

  test('超长子串截到 MAX_DETAIL 并以省略号收尾，恰好等长不截', () => {
    const exact = sig._redactedMessage('x'.repeat(MAX_DETAIL), {});
    assert.equal(exact.length, MAX_DETAIL);
    const over = sig._redactedMessage('x'.repeat(MAX_DETAIL + 500), {});
    assert.equal(over.length, MAX_DETAIL + 1, '裁剪后应追加一个省略号字符');
    assert.ok(over.endsWith('…'));
  });
});

describe('_safeStack / _snippet / _clip：栈与样本裁剪', () => {
  test('_safeStack 优先取真栈，其次 ctx.stack，最后回落到 message', () => {
    const err = new Error('boom');
    assert.ok(sig._safeStack(err, {}).includes('at '), '应包含真实栈帧');
    assert.equal(sig._safeStack({ stack: 'manual stack' }, {}), 'manual stack');
    assert.equal(sig._safeStack({}, { stack: 'ctx stack' }), 'ctx stack');
    assert.equal(sig._safeStack({ message: 'only message' }, {}), 'only message');
  });

  test('_safeStack 对空对象返回空串，调用方据此标记归因不完整', () => {
    assert.equal(sig._safeStack({}, {}), '');
    assert.equal(sig._safeStack(null, {}), '');
    assert.equal(sig._safeStack(undefined, {}), '');
  });

  test('_safeStack 把非字符串 stack 强转并截到 MAX_STACK', () => {
    const huge = sig._safeStack({ stack: 'y'.repeat(MAX_STACK + 100) }, {});
    assert.equal(huge.length, MAX_STACK + 1);
    assert.ok(huge.endsWith('…'));
    assert.equal(sig._safeStack({ stack: 123456 }, {}), '123456');
  });

  test('_snippet 对 undefined/null 返回 undefined，对象走 JSON，循环结构退化到 String 而不抛', () => {
    assert.equal(sig._snippet(undefined), undefined);
    assert.equal(sig._snippet(null), undefined);
    assert.equal(sig._snippet('raw text'), 'raw text');
    assert.equal(sig._snippet({ a: 1 }), '{"a":1}');
    assert.equal(sig._snippet(0), '0', '0 是合法样本，不能被当成空');
    assert.equal(sig._snippet(false), 'false');
    const circular = {};
    circular.self = circular;
    assert.equal(sig._snippet(circular), '[object Object]');
  });

  test('_snippet 截到 MAX_SNIPPET，_clip 对非字符串原样透传', () => {
    const long = sig._snippet('z'.repeat(MAX_SNIPPET + 20));
    assert.equal(long.length, MAX_SNIPPET + 1);
    assert.equal(sig._clip('short', 10), 'short');
    assert.equal(sig._clip('exactly10!', 10), 'exactly10!', '等长不截');
    assert.equal(sig._clip(123456789, 5), 123456789, '非字符串不做裁剪也不转成字符串');
    assert.equal(sig._clip(null, 5), null);
  });
});
