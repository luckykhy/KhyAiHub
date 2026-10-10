'use strict';

/**
 * textAddress.js contract tests — offset-faithful paragraph/sentence splitting
 * and precise occurrence replacement. Pure functions, zero IO.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  splitParagraphs,
  splitSentences,
  replaceAtLocation,
  locateWord,
} = require('./textAddress');

test('splitParagraphs: blank line is the separator, offsets are faithful', () => {
  const s = '第一段甲\n第二段乙\n\n第三段丙\n\n\n第四段丁';
  const paras = splitParagraphs(s);
  assert.equal(paras.length, 3);
  paras.forEach((p) => {
    assert.equal(s.slice(p.start, p.end), p.text, `offsets must reproduce text (para ${p.index})`);
    assert.equal(p.index, paras.indexOf(p) + 1, 'index is 1-based');
  });
  assert.deepEqual(paras.map((p) => p.text), ['第一段甲\n第二段乙', '第三段丙', '第四段丁']);
});

test('splitParagraphs: empty/blank/nullish input yields no paragraphs', () => {
  for (const input of ['', '   ', '\n\n\n', null, undefined]) {
    assert.deepEqual(splitParagraphs(input), [], `${String(input)}`);
  }
});

test('splitParagraphs: whitespace inside a paragraph is preserved, edges trimmed', () => {
  const s = '  alpha  beta  \n\n  gamma';
  const paras = splitParagraphs(s);
  assert.equal(paras.length, 2);
  assert.equal(paras[0].text, 'alpha  beta', 'inner double space kept, edge spaces dropped');
  assert.equal(paras[1].text, 'gamma');
});

test('splitSentences: CJK terminators stay inside their sentence', () => {
  const s = '甲句。乙句！丙句？丁句；戊句';
  const sents = splitSentences(s);
  assert.deepEqual(sents.map((x) => x.text), ['甲句。', '乙句！', '丙句？', '丁句；', '戊句']);
  sents.forEach((x) => assert.equal(s.slice(x.start, x.end), x.text));
});

test('splitSentences: only whitespace-final punctuation splits, so 3.14 stays whole', () => {
  // Documented intent is "avoid 3.14 / e.g." — in force only where the dot is not
  // followed by whitespace: 'e.g.' ends with '. ' and does become a boundary here.
  const sents = splitSentences('值 3.14 与 e.g. 如此 One more. tail');
  assert.ok(
    sents.some((x) => x.text.includes('3.14')),
    'a dot inside a number is never a sentence boundary',
  );
  assert.deepEqual(sents.map((x) => x.text), ['值 3.14 与 e.g.', '如此 One more.', 'tail']);
});

test('splitSentences: newline is a soft boundary and base shifts global offsets', () => {
  const doc = 'header\nAA BB\n\nCC DD';
  const para = splitParagraphs(doc)[1];
  const sents = splitSentences(doc.slice(para.start, para.end), para.start);
  assert.deepEqual(sents.map((x) => x.text), ['CC DD']);
  const s = doc.slice(para.start, para.end);
  sents.forEach((x) => assert.equal(doc.slice(x.start, x.end), x.text, 'offsets are document-global'));
  assert.equal(sents[0].start, para.start);
  assert.equal(s, 'CC DD');
});

test('replaceAtLocation: input validation errors are specific', () => {
  assert.equal(replaceAtLocation('x', {}).ok, false);
  assert.match(replaceAtLocation('x', {}).error, /word（要替换的词）必填/);
  assert.match(replaceAtLocation('x', { word: 'a' }).error, /replacement（替换为）必填/);
  assert.match(replaceAtLocation('x', { word: '', replacement: 'b' }).error, /word（要替换的词）必填/);
});

test('replaceAtLocation: an empty replacement deletes the occurrence', () => {
  const r = replaceAtLocation('猫 猫', { word: '猫', replacement: '', paragraph: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.text, ' 猫');
  assert.equal(r.replaced, 1);
});

test('replaceAtLocation: paragraph/sentence addressing reports what was available', () => {
  const doc = '甲 词\n\n乙 词 词';
  const pErr = replaceAtLocation(doc, { word: '词', replacement: 'X', paragraph: 9 });
  assert.equal(pErr.ok, false);
  assert.match(pErr.error, /第 9 段不存在/);
  assert.match(pErr.hint, /全文共 2 段/);
  assert.deepEqual(pErr.available, { paragraphs: 2 });

  const sErr = replaceAtLocation(doc, { word: '词', replacement: 'X', paragraph: 1, sentence: 5 });
  assert.equal(sErr.ok, false);
  assert.match(sErr.error, /第 1 段第 5 句不存在/);
  assert.match(sErr.hint, /该段共 1 句/);
  assert.deepEqual(sErr.available, { sentences: 1 });
});

test('replaceAtLocation: miss in scope still counts the document-wide occurrences', () => {
  const doc = '一 词\n\n二 另';
  const r = replaceAtLocation(doc, { word: '词', replacement: 'X', paragraph: 2 });
  assert.equal(r.ok, false);
  assert.match(r.hint, /「词」在全文共出现 1 次，但不在该位置/);
  assert.deepEqual(r.available, { inScope: 0, inDocument: 1 });

  const absent = replaceAtLocation(doc, { word: '无此词', replacement: 'X', paragraph: 1 });
  assert.match(absent.hint, /在全文中也不存在/);
  assert.deepEqual(absent.available, { inScope: 0, inDocument: 0 });
});

test('replaceAtLocation: occurrence is 1-based, defaults to 1, and rejects bad k', () => {
  const doc = 'A 词 B 词 C 词';
  const first = replaceAtLocation(doc, { word: '词', replacement: 'X' });
  assert.equal(first.ok, true);
  assert.equal(first.text, 'A X B 词 C 词', 'default is the FIRST hit only');
  assert.equal(first.scope.kind, 'document');

  const second = replaceAtLocation(doc, { word: '词', replacement: 'X', occurrence: 2 });
  assert.equal(second.text, 'A 词 B X C 词');

  const tooMany = replaceAtLocation(doc, { word: '词', replacement: 'X', occurrence: 4 });
  assert.equal(tooMany.ok, false);
  assert.deepEqual(tooMany.available, { inScope: 3 });
  assert.match(tooMany.error, /只出现 3 次，无法替换第 4 次/);

  for (const bad of [0, -1, 1.5, 'two']) {
    const r = replaceAtLocation(doc, { word: '词', replacement: 'X', occurrence: bad });
    assert.equal(r.ok, false, `${String(bad)} must be rejected`);
    assert.match(r.error, /occurrence 必须是 ≥1 的整数或 "all"/);
  }
});

test('replaceAtLocation: "all" replaces within scope only, leaving the rest verbatim', () => {
  const doc = '一 词 词\n\n二 词';
  const r = replaceAtLocation(doc, { word: '词', replacement: 'XY', paragraph: 1, occurrence: 'all' });
  assert.equal(r.ok, true);
  assert.equal(r.replaced, 2);
  assert.equal(r.text, '一 XY XY\n\n二 词', 'different-length replacement must not shift later text');
  assert.equal(r.scope.kind, 'paragraph');
  assert.equal(r.scope.paragraph, 1);
});

test('replaceAtLocation: sentence scope rewrites exactly one sentence', () => {
  const doc = '甲句 词。乙句 词。\n\n丙段 词。';
  const r = replaceAtLocation(doc, { word: '词', replacement: 'Z', paragraph: 1, sentence: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.text, '甲句 词。乙句 Z。\n\n丙段 词。');
  assert.deepEqual(r.scope, {
    kind: 'sentence',
    paragraph: 1,
    sentence: 2,
    text: '乙句 词。',
  });
});

test('locateWord: every hit is addressed by paragraph, sentence and in-sentence order', () => {
  const doc = '猫 猫。\n\n第二 猫。';
  const found = locateWord(doc, '猫');
  assert.deepEqual(found.map((f) => [f.paragraph, f.sentence, f.occurrenceInSentence]), [
    [1, 1, 1],
    [1, 1, 2],
    [2, 1, 1],
  ]);
  found.forEach((f) => assert.equal(doc.slice(f.offset, f.offset + 1), '猫', 'offset points at the word'));
  assert.deepEqual(locateWord(doc, '无'), []);
  assert.deepEqual(locateWord('', '猫'), []);
});
