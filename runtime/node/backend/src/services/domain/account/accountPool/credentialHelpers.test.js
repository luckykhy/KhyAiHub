'use strict';

// Co-located contract tests for credentialHelpers.js (pure value layer: only `crypto`).
// Every value below is MEASURED (probes .khyos/tmp/probeCred.js / probeCred2.js / probeCred3.js).
// No filesystem, no env, no real credential material: all tokens/emails are synthetic fixtures.

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./credentialHelpers');

// Synthetic, never real.
const FAKE_TOKEN_15 = 'abcdefghijklmno';
const FAKE_TOKEN_16 = 'abcdefghijklmnop';
const FAKE_EMAIL = 'user@corp.test';

test('导出面固定：20 个符号，别名表冻结，域名表为 Set，占位模式为 7 条无状态正则', () => {
  assert.deepEqual(Object.keys(h).slice().sort(), [
    'PLACEHOLDER_EMAIL_DOMAINS', 'PLACEHOLDER_PATTERNS', 'PROVIDER_ALIASES',
    '_isPlaceholderEmail', '_isPlaceholderValue', 'coerceObject', 'decodeMaybeURIComponent',
    'dedupePaths', 'firstNonEmpty', 'formatIso', 'hasLooseTokenShape', 'hasTokenShape',
    'isValidEmail', 'maskToken', 'normalizePoolType', 'normalizeTokenValue',
    'parseBoolean', 'parseCallbackPayload', 'safeJsonParse', 'tokenHash',
  ]);
  assert.equal(Object.isFrozen(h.PROVIDER_ALIASES), true);
  assert.deepEqual(Object.keys(h.PROVIDER_ALIASES), ['anti-gravity', 'anti_gravity', 'antigravity', 'nirvana']);
  assert.equal(h.PLACEHOLDER_EMAIL_DOMAINS instanceof Set, true);
  assert.equal(h.PLACEHOLDER_EMAIL_DOMAINS.size, 10);
  assert.equal(h.PLACEHOLDER_EMAIL_DOMAINS.has('localhost'), true);
  assert.equal(Array.isArray(h.PLACEHOLDER_PATTERNS), true);
  assert.equal(h.PLACEHOLDER_PATTERNS.length, 7);
  // No /g flag → `.test()` cannot leak lastIndex between calls.
  for (const re of h.PLACEHOLDER_PATTERNS) {
    assert.equal(re instanceof RegExp, true);
    assert.equal(re.global, false);
  }
});

test('normalizePoolType 折叠四条例名到 trae，并对大小写与首尾空白不敏感', () => {
  for (const raw of ['anti-gravity', 'anti_gravity', 'antigravity', 'nirvana', 'NIRVANA', ' anti-gravity ']) {
    assert.equal(h.normalizePoolType(raw), 'trae', `${raw} collapses onto trae`);
  }
  assert.equal(h.normalizePoolType('TRAE'), 'trae');
  assert.equal(h.normalizePoolType(' cursor '), 'cursor');
  assert.equal(h.normalizePoolType('Kiro'), 'kiro');
  // Unknown names pass through unchanged (after fold), they are not rejected.
  assert.equal(h.normalizePoolType('warp-c'), 'warp-c');
});

test('normalizePoolType 把所有假值归一到空串，数字 1 却保留为字符串 "1"', () => {
  for (const junk of ['', '   ', null, undefined, 0, -0, false, NaN, []]) {
    assert.equal(h.normalizePoolType(junk), '', `${String(junk)} becomes empty`);
  }
  assert.equal(h.normalizePoolType(1), '1');
  // Objects are String()-coerced, not rejected: the serialization artifact becomes the pool type.
  assert.equal(h.normalizePoolType({}), '[object object]');
  assert.equal(h.normalizePoolType('[object Object]'), '[object object]');
});

test('KNOWN-DEFECT: normalizePoolType 直取 PROVIDER_ALIASES[raw]，原型键泄漏出对象/函数', () => {
  // Measured: the lookup is unguarded, so inherited Object.prototype members are returned
  // instead of the lowered name — the pool type stops being a string.
  const viaProto = h.normalizePoolType('__proto__');
  assert.equal(typeof viaProto, 'object');
  assert.equal(String(viaProto), '[object Object]');
  const viaCtor = h.normalizePoolType('constructor');
  assert.equal(typeof viaCtor, 'function');
  // Only camelCase inheritance keeps the two below looking sane.
  assert.equal(h.normalizePoolType('toString'), 'tostring');
  assert.equal(h.normalizePoolType('hasOwnProperty'), 'hasownproperty');
  assert.equal(Object.prototype.hasOwnProperty.call(h.PROVIDER_ALIASES, 'toString'), false);
});

test('KNOWN-DEFECT: 强转族对无原型对象抛 TypeError，守卫族同输入却安全降级', () => {
  const bare = Object.create(null);
  // Guard-first helpers (typeof check before any coercion) degrade.
  assert.equal(h._isPlaceholderValue(bare), true);
  assert.equal(h._isPlaceholderEmail(bare), true);
  assert.equal(h.isValidEmail(bare), false);
  // String(x) helpers all explode on the same value.
  for (const fn of [h.normalizePoolType, h.normalizeTokenValue, h.maskToken, h.tokenHash, h.formatIso, h.hasTokenShape]) {
    assert.throws(() => fn(bare), TypeError);
  }
  assert.throws(() => h.firstNonEmpty([bare]), TypeError);
  assert.throws(() => h.dedupePaths([bare]), TypeError);
});

test('maskToken 边界在 10/11：≤10 保留 3 字符头，>10 用头6…尾4', () => {
  assert.equal(h.maskToken('abc'), 'abc***');
  assert.equal(h.maskToken('abcdefghij'), 'abc***'); // 10 chars
  assert.equal(h.maskToken('abcdefghijk'), 'abcdef...hijk'); // 11 chars
  assert.equal(h.maskToken('abcdefghijkl'), 'abcdef...ijkl');
  assert.equal(h.maskToken('0123456789'), '012***');
  assert.equal(h.maskToken('01234567890'), '012345...7890');
  // Masking is prefix/tail only — never a hash, so it is not a stable identity.
  assert.notEqual(h.maskToken(FAKE_TOKEN_16).length, 64);
});

test('maskToken 空值族返回 *** ，但字符串 "0" 与 true 会进入正常遮罩分支', () => {
  for (const junk of ['', '   ', null, undefined, 0, false, NaN, []]) {
    assert.equal(h.maskToken(junk), '***', `${String(junk)} is fully masked`);
  }
  assert.equal(h.maskToken('0'), '0***'); // numeric 0 vs string '0' take different branches
  assert.equal(h.maskToken(true), 'tru***');
});

test('maskToken 先裁剪首尾空白，但内部空白原样保留进遮罩', () => {
  assert.equal(h.maskToken('  abcdefghij  '), 'abc***');
  assert.equal(h.maskToken('a b c d e f g h i j k'), 'a b c ... j k');
});

test('KNOWN-DEFECT: maskToken 对非字符串 String() 强转，序列化残渣被当成合法遮罩', () => {
  assert.equal(h.maskToken({}), '[objec...ect]');
  assert.equal(h.maskToken(123456789012345), '123456...2345');
  // Surrogate pairs are counted per code unit, so the "tail 4" splits an emoji.
  assert.equal(h.maskToken('🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟🌟'), '🌟🌟🌟...🌟🌟');
});

test('tokenHash 对空白输入返回 null，去空白后稳定，并命中已知 SHA-256 向量', () => {
  for (const junk of ['', '  ', '\n\t', null, undefined, 0, [], false]) {
    assert.equal(h.tokenHash(junk), null, `${String(junk)} has no hash`);
  }
  assert.equal(h.tokenHash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(h.tokenHash(' abc '), h.tokenHash('abc'));
  assert.equal(h.tokenHash('abc').length, 64);
  assert.match(h.tokenHash(FAKE_TOKEN_16), /^[0-9a-f]{64}$/);
  assert.notEqual(h.tokenHash('abc'), h.tokenHash('abd'));
  // Same String() coercion as maskToken: an object hashes as its serialization artifact.
  assert.equal(h.tokenHash({}), h.tokenHash('[object Object]'));
});

test('formatIso 有效输入产出 UTC ISO，无效日期与垃圾串一律 null', () => {
  assert.equal(h.formatIso(1700000000000), '2023-11-14T22:13:20.000Z');
  assert.equal(h.formatIso('2020-02-02'), '2020-02-02T00:00:00.000Z');
  assert.equal(h.formatIso('1970-01-01T00:00:00.000Z'), '1970-01-01T00:00:00.000Z');
  assert.equal(h.formatIso(new Date(0)), '1970-01-01T00:00:00.000Z');
  assert.equal(h.formatIso(-1), '1969-12-31T23:59:59.999Z');
  assert.equal(h.formatIso(-86400000), '1969-12-31T00:00:00.000Z');
  for (const junk of ['banana', '2020-13-45', new Date('banana'), '  ', NaN, Infinity, -Infinity, {}, []]) {
    assert.equal(h.formatIso(junk), null, `${String(junk)} is not a date`);
  }
});

test('KNOWN-DEFECT: formatIso 用 !value 守卫，epoch 0 被丢弃而 true 反而得到一个可用时间', () => {
  assert.equal(h.formatIso(0), null); // the real epoch is rejected
  assert.equal(h.formatIso(''), null);
  assert.equal(h.formatIso(null), null);
  assert.equal(h.formatIso(undefined), null);
  assert.equal(h.formatIso(false), null);
  assert.equal(h.formatIso(true), '1970-01-01T00:00:00.001Z'); // 1 ms, from a boolean
});

test('KNOWN-DEFECT: formatIso 拒绝数字时间戳字符串（JSON 载荷常见形态）却接受同一个数字', () => {
  assert.equal(h.formatIso('1700000000000'), null);
  assert.equal(h.formatIso(1700000000000), '2023-11-14T22:13:20.000Z');
});

test('normalizeTokenValue 把任意值压成去空白字符串，空数组得空串而对象得序列化残渣', () => {
  assert.equal(h.normalizeTokenValue('  a  '), 'a');
  for (const junk of ['', null, undefined, 0, false, NaN, []]) {
    assert.equal(h.normalizeTokenValue(junk), '');
  }
  assert.equal(h.normalizeTokenValue({}), '[object Object]');
  assert.equal(h.normalizeTokenValue('👍'), '👍');
});

test('safeJsonParse 合法 JSON 永远优先于 fallback，包括 JSON 的假值字面量', () => {
  assert.deepEqual(h.safeJsonParse('{"a":1}'), { a: 1 });
  assert.deepEqual(h.safeJsonParse('[1,2]', 'fb'), [1, 2]);
  assert.deepEqual(h.safeJsonParse('  {"b":2}  ', 'fb'), { b: 2 });
  assert.equal(h.safeJsonParse('null', 'fb'), null); // valid JSON null beats the fallback
  assert.equal(h.safeJsonParse('false', 'fb'), false);
  assert.equal(h.safeJsonParse('0', 'fb'), 0);
  assert.equal(h.safeJsonParse('true', 'fb'), true);
  assert.deepEqual(h.safeJsonParse('{"a":{"b":[1,null,true]}}'), { a: { b: [1, null, true] } });
  // 1e999 is legal JSON text; JSON.parse maps it to Infinity, which JSON.stringify then
  // re-renders as the literal `null` — so this value cannot round-trip through the pool store.
  assert.equal(h.safeJsonParse('1e999'), Infinity);
  assert.equal(JSON.stringify(h.safeJsonParse('1e999')), 'null');
});

test('safeJsonParse 非字符串与坏 JSON 回落 fallback，缺省 fallback 是 null', () => {
  for (const junk of ['', '   ', null, undefined, 0, 123, {}, [], true]) {
    assert.equal(h.safeJsonParse(junk, 'fb'), 'fb', `${String(junk)} is not JSON text`);
  }
  for (const bad of ['banana', '{"a":}', '\ufeff{}', 'undefined']) {
    assert.equal(h.safeJsonParse(bad, 'fb'), 'fb', `${bad} is malformed`);
  }
  assert.deepEqual([h.safeJsonParse(''), h.safeJsonParse('banana')], [null, null]);
  // Prototype-polluting JSON text is parsed by JSON.parse, which never walks __proto__.
  const polluted = h.safeJsonParse('{"__proto__":{"x":1}}');
  assert.equal(Object.getPrototypeOf(polluted), Object.prototype);
  assert.equal(polluted.x, undefined);
});

test('isValidEmail 要求单 @ + 带点域名 + 无空白，并排除占位域名', () => {
  for (const ok of [FAKE_EMAIL, 'a@b.co', 'USER@CORP.TEST', '  ' + FAKE_EMAIL + '  ', 'a.b@c.d.e', 'admin@x.io', '你@好.com', 'user@bar.io']) {
    assert.equal(h.isValidEmail(ok), true, `${ok} is a real-shaped email`);
  }
  for (const bad of ['user@example.com', 'user@test.org', 'a@foo.com', 'user@localhost', 'user@placeholder.com', 'user@sample.com',
    'a@b', '@d.com', 'a@d.', 'x y@z.com', 'two@@d.com', 'https://x.com', 'admin', '邮箱@example.com', 'ab', 'abc', '']) {
    assert.equal(h.isValidEmail(bad), false, `${bad} is rejected`);
  }
  for (const junk of [null, undefined, 0, NaN, {}, [], true]) {
    assert.equal(h.isValidEmail(junk), false);
  }
});

test('_isPlaceholderEmail 把短串、占位域名与字段描述语都判为占位', () => {
  for (const ph of ['ab', 'admin', 'demo', 'test', 'user', 'your account', 'my_key', 'https://a.b', '[object Object]',
    'ユーザー', '任意填写', 'OAuth token', 'webdav url', 'user@localhost', 'password', '账号', '选填内容']) {
    assert.equal(h._isPlaceholderEmail(ph), true, `${ph} looks like a placeholder`);
  }
  for (const real of ['abc', FAKE_EMAIL, 'someone@warp.dev', 'warp']) {
    assert.equal(h._isPlaceholderEmail(real), false, `${real} survives the filter`);
  }
  // Same field-prefix collateral as _isPlaceholderValue: the canonical type reads as a label.
  assert.equal(h._isPlaceholderEmail('trae'), true);
  for (const junk of [null, undefined, 0, '', '  ', {}, []]) {
    assert.equal(h._isPlaceholderEmail(junk), true, 'non-strings are placeholders by contract');
  }
});

test('KNOWN-DEFECT: _isPlaceholderValue 的字段描述前缀正则误杀真实渠道名 trae', () => {
  assert.equal(h._isPlaceholderValue('trae'), true); // canonical pool type judged "placeholder"
  assert.equal(h._isPlaceholderValue('OAuth'), true);
  assert.equal(h._isPlaceholderValue('account'), true);
  assert.equal(h._isPlaceholderValue('password'), true);
  assert.equal(h._isPlaceholderValue('login name'), true);
  // Sibling pool types are fine — the filter is asymmetric across the same namespace.
  assert.equal(h._isPlaceholderValue('cursor'), false);
  assert.equal(h._isPlaceholderValue('kiro'), false);
  assert.equal(h._isPlaceholderValue('warp'), false);
  assert.equal(h._isPlaceholderValue('opencode'), false);
  assert.equal(h._isPlaceholderValue('1234567890abcdef'), false);
  // Length gate is 2 (vs 3 for emails), CJK is not length-limited the same way.
  assert.equal(h._isPlaceholderValue('a'), true);
  assert.equal(h._isPlaceholderValue('ab'), false);
  assert.equal(h._isPlaceholderValue('你好'), false);
  for (const junk of [null, undefined, 0, '', {}, []]) {
    assert.equal(h._isPlaceholderValue(junk), true);
  }
});

test('hasTokenShape 的下限是 16（含），字符集白名单排除 {} 等', () => {
  assert.equal(h.hasTokenShape(FAKE_TOKEN_16), true);
  assert.equal(h.hasTokenShape(FAKE_TOKEN_15), false); // 15 → below the bar
  assert.equal(h.hasTokenShape('a'.repeat(16)), true);
  assert.equal(h.hasTokenShape(' abcdefghijklmnop'), true); // surrounding space is trimmed first
  assert.equal(h.hasTokenShape('abcdefg hijklmnopqr'), false); // internal space
  assert.equal(h.hasTokenShape(`${FAKE_TOKEN_16}{`), false); // not in the safe charset
  assert.equal(h.hasTokenShape('a/b=c~d+e:f-g_h.i' + 'x'), true);
  for (const junk of ['short', '', '   ', null, undefined, 0, {}, [], true, 12345678901234]) {
    assert.equal(h.hasTokenShape(junk), false);
  }
});

test('KNOWN-DEFECT: hasLooseTokenShape 放宽的是字符集而非空白，首尾空白同样被 trim 放过', () => {
  assert.equal(h.hasLooseTokenShape(`${FAKE_TOKEN_16}{`), true); // strict says false
  assert.equal(h.hasLooseTokenShape('1234567890123456'), true);
  assert.equal(h.hasLooseTokenShape('123456789012345'), false); // still the 16 gate
  assert.equal(h.hasLooseTokenShape('abcdefg hijklmnopqr'), false);
  assert.equal(h.hasLooseTokenShape(`${FAKE_TOKEN_16} `), true); // trailing space tolerated, not "no whitespace"
  assert.equal(h.hasLooseTokenShape('中文中文中文中文中文中文中文中'), false); // 15 code units
  assert.equal(h.hasLooseTokenShape('中文中文中文中文中文中文中文中文'), true); // 16 code units, loose charset
});

test('coerceObject 只认括号对，并且原样透传（不拷贝）调用方对象', () => {
  const obj = { a: 1 };
  const arr = [1, 2];
  assert.equal(h.coerceObject(obj), obj);
  assert.equal(h.coerceObject(arr), arr);
  assert.equal(h.coerceObject('{"a":1}').a, 1);
  assert.deepEqual(h.coerceObject('  { "a" : 1 }  '), { a: 1 });
  assert.deepEqual(h.coerceObject('[1,2]'), [1, 2]);
  for (const junk of ['[1,2}', '{a}', 'garbage', '', '   ', '{"a":}', null, undefined, 0, 123, true, () => 1]) {
    assert.equal(h.coerceObject(junk), null, `${String(junk)} is not a JSON container`);
  }
  assert.notEqual(h.coerceObject('[1,2]'), h.coerceObject('[1,2]')); // string path mints a fresh object
});

test('KNOWN-DEFECT: coerceObject / parseCallbackPayload 返回同一引用，调用方改结果即改入参', () => {
  const input = { n: 1 };
  const viaCoerce = h.coerceObject(input);
  viaCoerce.n = 2;
  assert.equal(input.n, 2);
  const viaPayload = h.parseCallbackPayload(input);
  assert.equal(viaPayload, input);
  viaPayload.n = 3;
  assert.equal(input.n, 3);
});

test('KNOWN-DEFECT: parseCallbackPayload 丢弃数组载荷，而 coerceObject 同输入返回数组', () => {
  assert.deepEqual(h.coerceObject('[1,2]'), [1, 2]);
  assert.deepEqual(h.parseCallbackPayload('[1,2]'), {});
  // The array branch is a silent drop, then the query fallback still runs on the raw text.
  assert.deepEqual(h.parseCallbackPayload('[1,2]?a=1'), { a: '1' });
});

test('parseCallbackPayload 的 query 解析：切 ? 、跳空键、后写覆盖前写、+ 与 % 解码', () => {
  const direct = { code: '1' };
  assert.equal(h.parseCallbackPayload(direct), direct);
  assert.deepEqual(h.parseCallbackPayload('code=1&state=2'), { code: '1', state: '2' });
  assert.deepEqual(h.parseCallbackPayload('https://x.io/cb?code=1&state=2'), { code: '1', state: '2' });
  assert.deepEqual(h.parseCallbackPayload('{"code":"1"}'), { code: '1' });
  assert.deepEqual(h.parseCallbackPayload('{"a":{"b":1}}'), { a: { b: 1 } });
  assert.deepEqual(h.parseCallbackPayload('a=1&=2&b=3'), { a: '1', b: '3' }); // empty key skipped
  assert.deepEqual(h.parseCallbackPayload('code=1&code=2'), { code: '2' }); // last write wins
  assert.deepEqual(h.parseCallbackPayload('a=x+y'), { a: 'x y' });
  assert.deepEqual(h.parseCallbackPayload('a=%20'), { a: ' ' });
  assert.deepEqual(h.parseCallbackPayload('%E4%BD%A0=%E5%A5%BD'), { 你: '好' });
  assert.deepEqual(h.parseCallbackPayload('a=1&b'), { a: '1', b: '' });
  for (const junk of ['', '   ', null, undefined, 0, 'noequals', '=?', '&&&', 'https://x.io/cb', '{}']) {
    assert.deepEqual(h.parseCallbackPayload(junk), {}, `${String(junk)} yields an empty payload`);
  }
});

test('decodeMaybeURIComponent 只在像 URI 编码时解码，坏转义序列原样返回', () => {
  assert.equal(h.decodeMaybeURIComponent('%E4%BD%A0%E5%A5%BD'), '你好');
  assert.equal(h.decodeMaybeURIComponent('%e4%bd%A0'), '你'); // hex case insensitive
  assert.equal(h.decodeMaybeURIComponent('a%20b'), 'a b');
  assert.equal(h.decodeMaybeURIComponent('%2F'), '/');
  assert.equal(h.decodeMaybeURIComponent('  %2F  '), '/'); // trimmed first
  for (const bad of ['%ZZ', '%2', '50%', '%%%', 'plain', 'a+b']) {
    assert.equal(h.decodeMaybeURIComponent(bad), bad.trim());
  }
  for (const junk of ['', null, undefined, 0]) {
    assert.equal(h.decodeMaybeURIComponent(junk), '');
  }
});

test('KNOWN-DEFECT: firstNonEmpty / dedupePaths 把字符串入参按字符迭代，数字入参却抛 TypeError', () => {
  assert.equal(h.firstNonEmpty('abc'), 'a'); // string is iterable → char-wise
  assert.deepEqual(h.dedupePaths('abc'), ['a', 'b', 'c']);
  assert.throws(() => h.firstNonEmpty(123), TypeError);
  assert.throws(() => h.dedupePaths(123), TypeError);
  assert.throws(() => h.firstNonEmpty(true), TypeError);
  assert.throws(() => h.dedupePaths(NaN), TypeError);
});

test('firstNonEmpty 返回原值（含 0 / false / 对象引用），空列表与默认参数返回 null', () => {
  assert.equal(h.firstNonEmpty([]), null);
  assert.equal(h.firstNonEmpty(), null);
  assert.equal(h.firstNonEmpty(['a', 'b']), 'a');
  assert.equal(h.firstNonEmpty(['', 'x']), 'x');
  assert.equal(h.firstNonEmpty(['  ', 'y']), 'y');
  assert.equal(h.firstNonEmpty([null, '', 0]), 0); // 0 is kept, not skipped
  assert.equal(h.firstNonEmpty([false]), false);
  assert.equal(h.firstNonEmpty([null, '']), null);
  const obj = { k: 1 };
  assert.equal(h.firstNonEmpty([obj]), obj);
  assert.equal(h.firstNonEmpty([[], 'z']), 'z'); // String([]) is empty → skipped
  assert.equal(h.firstNonEmpty((function* () { yield ''; yield 'g'; })()), 'g'); // any iterable works
});

test('parseBoolean 的同义词两族，无法识别时回落 fallback，而 fallback 缺省为 true', () => {
  for (const truthy of ['1', 'true', 'YES', 'On', 'y', '  true  ', 1, true]) {
    assert.equal(h.parseBoolean(truthy), true, `${String(truthy)} is in the on family`);
  }
  for (const falsy of ['0', 'false', 'NO', 'off', 'n', 0, false]) {
    assert.equal(h.parseBoolean(falsy), false, `${String(falsy)} is in the off family`);
  }
  // Anything else falls back, and the fallback defaults to ON — so '2' only looks true.
  for (const junk of ['2', '-1', '', '   ', null, undefined, 'banana', {}, Symbol('x')]) {
    assert.equal(h.parseBoolean(junk), true, 'default fallback is ON');
  }
  assert.deepEqual(
    ['', null, undefined, 'banana', {}].map((x) => h.parseBoolean(x, false)),
    [false, false, false, false, false]
  );
  assert.equal(h.parseBoolean({}, 'FB'), 'FB'); // fallback is returned verbatim, any type
  assert.equal(h.parseBoolean(Symbol('x'), 'FB'), 'FB');
});

test('dedupePaths 裁剪后去重、保序、返回新数组，并兼容 Set 等可迭代入参', () => {
  assert.deepEqual(h.dedupePaths(['a', 'a', ' b ', '', null, 'b', undefined, '  ']), ['a', 'b']);
  assert.deepEqual(h.dedupePaths(['a', 'a ', ' a']), ['a']); // collapse happens after trim
  assert.deepEqual(h.dedupePaths(), []);
  assert.equal(h.dedupePaths().length, 0);
  assert.deepEqual(h.dedupePaths(new Set(['p', 'q', 'p'])), ['p', 'q']);
  assert.deepEqual(h.dedupePaths([1, 2, 1]), ['1', '2']); // numbers stringified
  assert.deepEqual(h.dedupePaths([[], []]), []); // String([]) is empty → dropped
  assert.deepEqual(h.dedupePaths([{}, {}]), ['[object Object]']); // distinct objects collapse together
  const input = ['b', 'b', 'c'];
  const result = h.dedupePaths(input);
  assert.notEqual(result, input);
  assert.deepEqual(input, ['b', 'b', 'c']); // caller array untouched
});
