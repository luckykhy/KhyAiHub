'use strict';

// Co-located contract tests for langPreference.js (零 IO 纯叶子)。
// Values are MEASURED (probe .khyos/tmp/probeA1.js / probeA2.js) — including the two places
// where the leaf's own header contract ("绝不抛") does not hold for hostile inputs.

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeLanguage, describeLanguage, resolveActive } = require('./langPreference');

test('中文别名表覆盖中英两套写法并折叠空白与连字符', () => {
  for (const raw of ['zh', 'zh-CN', 'zh_CN', 'zh  CN', 'cn', 'chinese', 'Chinese', 'ChInEsE', '中文', '中', '  zh ']) {
    assert.equal(normalizeLanguage(raw), 'Chinese', `${raw} must fold to Chinese`);
  }
  for (const raw of ['en', 'enUS', 'en-us', 'en_gb', 'EN', 'english', 'English', '英文', '英语']) {
    assert.equal(normalizeLanguage(raw), 'English', `${raw} must fold to English`);
  }
});

test('auto 族四个词形都归一到 auto（跟随用户输入）', () => {
  for (const raw of ['auto', 'AUTO', 'auto ', '  a  u  t  o  ', 'AUT O', 'default', 'follow', 'same']) {
    assert.equal(normalizeLanguage(raw), 'auto', `${JSON.stringify(raw)} is an auto alias`);
  }
});

test('未收录的词形与垃圾输入一律返回空串而不是猜一个', () => {
  for (const junk of [' Mandarin ', 'ZH_hans', 'EN_UK', '繁體', 'ja', 'japanese', '日文', 'spanish']) {
    assert.equal(normalizeLanguage(junk), '', `${junk} is not in any alias set`);
  }
  for (const junk of [null, undefined, '', '   ', 0, 1, true, false, NaN, [], {}, 0n]) {
    assert.equal(normalizeLanguage(junk), '', `junk ${String(junk)} yields the unknown marker`);
  }
  assert.equal(normalizeLanguage(), '', 'no argument at all');
});

test('Symbol 与 String 包装对象都不会抛（String() 显式转换）', () => {
  assert.equal(normalizeLanguage(Symbol('en')), '', 'String(Symbol) yields "Symbol(en)", not "en"');
  assert.equal(normalizeLanguage(new String('en')), 'English');
  assert.doesNotThrow(() => normalizeLanguage(Symbol.iterator));
});

test('describeLanguage 只给展示标签，未识别值原样回显', () => {
  assert.equal(describeLanguage('auto'), '自动(跟随用户输入·中文优先)');
  assert.equal(describeLanguage('Chinese'), '中文');
  assert.equal(describeLanguage('English'), 'English');
  assert.equal(describeLanguage('weird'), 'weird', 'unknown values echo verbatim');
  assert.equal(describeLanguage('zh'), 'zh');
  for (const falsy of [null, undefined, '', 0, false, NaN, '0']) {
    assert.equal(typeof describeLanguage(falsy), 'string');
  }
  assert.equal(describeLanguage(null), '未设置');
  assert.equal(describeLanguage(0), '未设置');
});

test('KNOWN-DEFECT describeLanguage 对空数组返回空串标签，同族假值 0 却得到「未设置」', () => {
  // `pref || '未设置'` tests truthiness: [] is truthy, so String([]) === '' is handed to the UI.
  assert.equal(describeLanguage([]), '');
  assert.equal(describeLanguage(0), '未设置');
  assert.equal(describeLanguage([1]), '1', 'a one-element array leaks its join() form');
  assert.equal(describeLanguage({}.x), '未设置');
});

test('KNOWN-DEFECT describeLanguage/normalizeLanguage 对无原型对象抛 TypeError，违背头注「绝不抛」', () => {
  const bare = Object.create(null);
  assert.throws(() => describeLanguage(bare), TypeError);
  assert.throws(() => normalizeLanguage(bare), TypeError);
  // resolveActive is the one entry that survives it, because it guards with a truthiness test.
  assert.deepEqual(resolveActive(bare), { preference: 'auto', source: 'default' });
});

test('describeLanguage 与 normalizeLanguage 可往返（中文/英文标签能再解析，auto 标签不可）', () => {
  for (const pref of ['Chinese', 'English']) {
    assert.equal(normalizeLanguage(describeLanguage(pref)), pref, `${pref} survives a display round trip`);
  }
  // The auto label is prose, so feeding it back yields the unknown marker rather than 'auto'.
  assert.equal(normalizeLanguage(describeLanguage('auto')), '');
  assert.equal(normalizeLanguage(describeLanguage(null)), '');
});

test('resolveActive 未设 flag 时回落 auto/default', () => {
  assert.deepEqual(resolveActive(), { preference: 'auto', source: 'default' });
  assert.deepEqual(resolveActive({}), { preference: 'auto', source: 'default' });
  assert.deepEqual(resolveActive({ KHY_LANGUAGE: '' }), { preference: 'auto', source: 'default' });
  assert.deepEqual(resolveActive({ KHY_LANGUAGE: '  ' }), { preference: 'auto', source: 'default' });
  assert.deepEqual(resolveActive({ KHY_LANGUAGE: null }), { preference: 'auto', source: 'default' });
  assert.deepEqual(resolveActive({ KHY_LANGUAGE: 0 }), { preference: 'auto', source: 'default' });
  assert.deepEqual(resolveActive(null), { preference: 'auto', source: 'default' });
  assert.deepEqual(resolveActive('str'), { preference: 'auto', source: 'default' });
  assert.deepEqual(resolveActive([]), { preference: 'auto', source: 'default' });
});

test('resolveActive 命中 env 时 source 恒为 env，且与 prompts.js 写入的规范值对齐', () => {
  assert.deepEqual(resolveActive({ KHY_LANGUAGE: 'Chinese' }), { preference: 'Chinese', source: 'env' });
  assert.deepEqual(resolveActive({ KHY_LANGUAGE: ' English ' }), { preference: 'English', source: 'env' });
  assert.deepEqual(resolveActive({ KHY_LANGUAGE: 'zh' }), { preference: 'Chinese', source: 'env' });
  assert.deepEqual(resolveActive({ KHY_LANGUAGE: 'en-gb' }), { preference: 'English', source: 'env' });
  assert.deepEqual(resolveActive({ KHY_LANGUAGE: ['en'] }), { preference: 'English', source: 'env' });
});

test('resolveActive 无法归一时谎报 source=env，且数值 0 与字符串 "0" 走不同分支', () => {
  // An unparseable value still claims env authority while the preference is a fabricated auto.
  assert.deepEqual(resolveActive({ KHY_LANGUAGE: 'banana' }), { preference: 'auto', source: 'env' });
  assert.deepEqual(resolveActive({ KHY_LANGUAGE: '0' }), { preference: 'auto', source: 'env' });
  assert.deepEqual(resolveActive({ KHY_LANGUAGE: -1 }), { preference: 'auto', source: 'env' });
  assert.deepEqual(resolveActive({ KHY_LANGUAGE: 0 }), { preference: 'auto', source: 'default' });
  assert.deepEqual(resolveActive({ KHY_LANGUAGE: 'auto' }), { preference: 'auto', source: 'env' });
});

test('resolveActive 只字符串化 env 值：带 toString 的对象可用，普通对象落回 auto', () => {
  assert.deepEqual(resolveActive({ KHY_LANGUAGE: { toString() { return 'zh'; } } }), { preference: 'Chinese', source: 'env' });
  assert.deepEqual(resolveActive({ KHY_LANGUAGE: {} }), { preference: 'auto', source: 'env' }, 'String({}) is "[object Object]" which is unparseable');
});

test('resolveActive 每次返回新对象且不改动注入的 env', () => {
  const env = { KHY_LANGUAGE: 'en', OTHER: 'keep' };
  const a = resolveActive(env);
  const b = resolveActive(env);
  assert.notEqual(a, b, 'no shared mutable result object');
  assert.deepEqual(a, b);
  assert.deepEqual(env, { KHY_LANGUAGE: 'en', OTHER: 'keep' });
});

test('resolveActive 只读 KHY_LANGUAGE 这一个键', () => {
  assert.deepEqual(resolveActive({ LANGUAGE: 'en', LANG: 'en', KHY_LANG: 'en' }), { preference: 'auto', source: 'default' });
  assert.deepEqual(resolveActive({ KHY_LANGUAGE: 'en', KHY_LANG: 'zh' }), { preference: 'English', source: 'env' });
});
