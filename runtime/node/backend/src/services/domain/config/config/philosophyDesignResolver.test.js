'use strict';

// Co-located contract tests for philosophyDesignResolver.js (纯叶子 NL 解析)。
// Expectations were taken from the module's MEASURED output (probes in .khyos/tmp/probePhil.js
// and probePhil2.js). The leaf is zero-IO, so every call injects an explicit env object:
// the default argument is the real process.env, which we must never depend on.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isEnabled,
  PHILOSOPHY_DESIGN_DIRECTIVE,
  PHILOSOPHY_DESIGN_SUMMARY,
  matchPhilosophyDesign,
  resolvePhilosophyIntent,
  routePhilosophyIntent,
} = require('./philosophyDesignResolver');

const ON = { KHY_PHILOSOPHY_DESIGN: 'true' };
const OFF = { KHY_PHILOSOPHY_DESIGN: 'off' };
// A sentence carrying both required signals: ① philosophy ② "turn it into software".
const HIT = '把斯多葛哲学应用到软件项目里，用系统实现它';

test('门控默认开，且仅 0/false/off/no 四个词关', () => {
  assert.equal(isEnabled({}), true, 'unset flag must default to ON');
  for (const word of ['0', 'false', 'off', 'no']) {
    assert.equal(isEnabled({ KHY_PHILOSOPHY_DESIGN: word }), false, `${word} must switch off`);
    assert.equal(isEnabled({ KHY_PHILOSOPHY_DESIGN: word.toUpperCase() }), false, `${word} is case folded`);
    assert.equal(isEnabled({ KHY_PHILOSOPHY_DESIGN: ` ${word} ` }), false, `${word} survives trim`);
  }
  // Near misses stay ON: the gate is a closed set, not a prefix match.
  for (const word of ['nope', 'off-line', 'never', 'falsey', 'disable']) {
    assert.equal(isEnabled({ KHY_PHILOSOPHY_DESIGN: word }), true, `${word} is not an off word`);
  }
});

test('空串与 null/undefined 都读作「开」（与 isOffValue 族语义相反，实测钉死）', () => {
  // isOffValue() treats '' as off; this leaf's own _FALSY set does not contain ''.
  assert.equal(isEnabled({ KHY_PHILOSOPHY_DESIGN: '' }), true);
  assert.equal(isEnabled({ KHY_PHILOSOPHY_DESIGN: null }), true, 'null collapses to the "unset" literal');
  assert.equal(isEnabled({ KHY_PHILOSOPHY_DESIGN: undefined }), true);
  assert.equal(isEnabled({ KHY_PHILOSOPHY_DESIGN: 0 }), false, 'numeric 0 stringifies to "0" → off');
  assert.equal(isEnabled({ KHY_PHILOSOPHY_DESIGN: false }), false, 'boolean false stringifies to "false" → off');
});

test('env 本身是假值时看的是 env 的真值而不是 flag', () => {
  assert.equal(isEnabled(null), true, 'null env → raw null → treated as unset → ON');
  assert.equal(isEnabled(undefined), true, 'undefined env hits the default `{}` only via the param');
  assert.equal(isEnabled(0), false, 'falsy env short-circuits `env && env.X` to 0 → "0" → off');
  assert.equal(isEnabled('x'), true, 'string env carries no flag → undefined → ON');
  assert.equal(isEnabled([]), true);
});

test('哲学与「落地软件」两类信号必须同时命中', () => {
  assert.equal(matchPhilosophyDesign(HIT), true);
  assert.equal(matchPhilosophyDesign('我们讨论一下康德的伦理学'), false, 'philosophy alone is a discussion');
  assert.equal(matchPhilosophyDesign('帮我建一个待办项目'), false, 'a project without philosophy');
  assert.equal(matchPhilosophyDesign('把流程应用到软件架构'), false, 'apply signal without philosophy');
  assert.equal(matchPhilosophyDesign('庄子是谁'), false);
});

test('KNOWN-DEFECT 中国哲学流派只有中文词形，西方流派中英双轨（实测不对称）', () => {
  const apply = '与 应用到软件架构';
  for (const zh of ['道家', '儒家', '禅宗', '道德经', '无为', '阴阳', '中庸']) {
    assert.equal(matchPhilosophyDesign(zh + apply), true, `${zh} matches in Chinese`);
  }
  // The same schools written in English carry no alias, so an English-only request never fires.
  for (const en of ['taoism', 'tao te ching', 'confucianism', 'confucius', 'zen', 'buddhism', 'wu wei', 'yin yang']) {
    assert.equal(matchPhilosophyDesign(en + ' and ' + apply), false, `${en} has no alias`);
  }
  // Western schools do have both forms — that is the asymmetry.
  assert.equal(matchPhilosophyDesign('stoic and ' + apply), true);
  assert.equal(matchPhilosophyDesign('kant and ' + apply), true);
  assert.equal(matchPhilosophyDesign('social contract and ' + apply), true);
  assert.equal(matchPhilosophyDesign('separation of powers and ' + apply), false, 'only 三权分立 is listed');
});

test('英文落地短语按字面 apply 匹配，过去式 applied 不命中', () => {
  assert.equal(matchPhilosophyDesign('apply stoic philosophy to software architecture'), true);
  assert.equal(matchPhilosophyDesign('philosophy applied to software'), false, 'the stem is "apply", "applied" loses the y');
  assert.equal(matchPhilosophyDesign('PHILOSOPHY applied to SOFTWARE'), false, 'case folding does not rescue the stem');
  // Sibling branches do tolerate suffixes because they share a stem with the inflected form.
  assert.equal(matchPhilosophyDesign('stoic philosophy implemented in a system'), true);
  assert.equal(matchPhilosophyDesign('turn kantian ethics into software'), true);
});

test('代码块与行内 code 内的关键词不算用户指令', () => {
  assert.equal(matchPhilosophyDesign('```\n' + HIT + '\n```'), false);
  assert.equal(matchPhilosophyDesign('请把`道家无为`应用到一个系统'), false, 'the philosophy token lived inside backticks');
  assert.equal(matchPhilosophyDesign('请把 道家无为 应用到一个系统'), true, 'same sentence without the code span');
  assert.equal(matchPhilosophyDesign('```python\n# apply stoic to software\n```'), false);
});

test('跨行措辞会打断「应用…软件」短语（点号不吃换行）', () => {
  assert.equal(matchPhilosophyDesign('道家，把它应用到软件'), true);
  assert.equal(matchPhilosophyDesign('道家\n\n把它应用\n到软件'), false, 'a line break inside the verb window kills the match');
  assert.equal(matchPhilosophyDesign('道家\n把它应用到软件'), true, 'the apply clause itself still needs no newline');
});

test('垃圾输入一律 false 且绝不抛（契约：fail-soft）', () => {
  for (const junk of [null, undefined, '', '   ', '\n\t ', 0, 123, NaN, true, false, [], {}, Symbol.iterator, new Set()]) {
    assert.equal(matchPhilosophyDesign(junk), false, `junk ${String(junk)} must not match`);
  }
  assert.doesNotThrow(() => matchPhilosophyDesign({ toString() { throw new Error('boom'); } }));
  assert.equal(matchPhilosophyDesign({ toString() { throw new Error('boom'); } }), false);
  assert.equal(typeof matchPhilosophyDesign(HIT), 'boolean');
});

test('匹配函数不设长度上限（兄弟叶 nlExternalApp* 截 500、守卫叶截 4000）', () => {
  const long = '哲学' + 'x'.repeat(5000) + '应用到软件';
  assert.equal(matchPhilosophyDesign(long), true, 'this leaf scans the whole payload');
  assert.equal(matchPhilosophyDesign('a'.repeat(20000) + HIT), true);
});

test('命中意图产出 id/summary/directive 三键，directive 复用同一真源字符串', () => {
  const intent = resolvePhilosophyIntent(HIT, ON);
  assert.deepEqual(Object.keys(intent), ['id', 'summary', 'directive']);
  assert.equal(intent.id, 'philosophy-design');
  assert.equal(intent.summary, PHILOSOPHY_DESIGN_SUMMARY);
  assert.equal(intent.directive, PHILOSOPHY_DESIGN_DIRECTIVE, 'not a copy: single source of truth');
});

test('门控关时即使命中文本也返回 null', () => {
  assert.equal(resolvePhilosophyIntent(HIT, OFF), null);
  assert.equal(resolvePhilosophyIntent(HIT, { KHY_PHILOSOPHY_DESIGN: '0' }), null);
  assert.equal(resolvePhilosophyIntent(HIT, { KHY_PHILOSOPHY_DESIGN: 'no' }), null);
  assert.equal(resolvePhilosophyIntent(HIT, { KHY_PHILOSOPHY_DESIGN: 'TRUE' }).id, 'philosophy-design', 'upper-case ON value stays enabled');
});

test('未命中与空文本都返回 null，不产出半成品意图', () => {
  assert.equal(resolvePhilosophyIntent('你好', ON), null);
  assert.equal(resolvePhilosophyIntent('', ON), null);
  assert.equal(resolvePhilosophyIntent(null, ON), null);
  assert.equal(resolvePhilosophyIntent(undefined, ON), null);
  assert.equal(resolvePhilosophyIntent({}, ON), null);
  assert.equal(resolvePhilosophyIntent([], ON), null);
});

test('常量指令是 [SYSTEM: 开头的多行协议，摘要为单行', () => {
  assert.equal(PHILOSOPHY_DESIGN_DIRECTIVE.startsWith('[SYSTEM:'), true);
  assert.equal(PHILOSOPHY_DESIGN_DIRECTIVE.split('\n').length, 25);
  assert.equal(PHILOSOPHY_DESIGN_DIRECTIVE.includes('哲学概念 → 软件落点'), true);
  assert.equal(PHILOSOPHY_DESIGN_SUMMARY, '把哲学/思想类比成软件设计并真正实现');
  assert.equal(PHILOSOPHY_DESIGN_SUMMARY.includes('\n'), false);
});

test('缝入口命中时返回 {directive, intent}，未命中零注入', () => {
  const routed = routePhilosophyIntent({ text: HIT, env: ON });
  assert.deepEqual(Object.keys(routed), ['directive', 'intent']);
  assert.equal(routed.directive, PHILOSOPHY_DESIGN_DIRECTIVE);
  assert.equal(routed.intent.id, 'philosophy-design');
  assert.equal(routePhilosophyIntent({ text: '你好', env: ON }), null);
  assert.equal(routePhilosophyIntent({ text: HIT, env: OFF }), null);
});

test('缝入口对畸形 opts 一律 fail-soft 成 null', () => {
  assert.equal(routePhilosophyIntent(), null, 'no opts and no text → nothing injected');
  assert.equal(routePhilosophyIntent({}), null);
  assert.equal(routePhilosophyIntent(null), null);
  assert.equal(routePhilosophyIntent('x'), null);
  assert.equal(routePhilosophyIntent(0), null);
  assert.equal(routePhilosophyIntent({ text: { toString() { throw new Error('boom'); } }, env: ON }), null);
  assert.equal(routePhilosophyIntent({
    text: HIT,
    get env() { throw new Error('trap'); },
  }), null, 'a throwing getter is swallowed by the seam');
});

test('解析不改动注入的 env 与文本载体', () => {
  const env = { KHY_PHILOSOPHY_DESIGN: 'true', EXTRA: 'keep' };
  const carrier = { text: HIT };
  routePhilosophyIntent({ text: carrier.text, env });
  resolvePhilosophyIntent(carrier.text, env);
  assert.deepEqual(env, { KHY_PHILOSOPHY_DESIGN: 'true', EXTRA: 'keep' });
  assert.deepEqual(carrier, { text: HIT });
});
