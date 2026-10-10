'use strict';

// Co-located contract tests for textStats.js (deterministic CJK measurement leaf).
// All numbers below are MEASURED against the module, not inferred from the comments.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const ts = require('./textStats');

// Display width helper used only to prove what naturalLength() actually counts.
const codePoints = (s) => [...s].length;

describe('paragraphsWithOffsets — 段落切分与偏移', () => {
  test('空行切分保留每段起始偏移，且偏移能与原文逐段还原', () => {
    const src = '第一段内容\n\n第二段内容\n\n\n第三段';
    const paras = ts.paragraphsWithOffsets(src);
    assert.deepEqual(paras.map((p) => p.text), ['第一段内容', '第二段内容', '第三段']);
    for (const p of paras) {
      assert.equal(src.slice(p.start, p.start + p.text.length), p.text);
    }
    assert.deepEqual(paras.map((p) => p.start), [0, 7, 15]);
  });

  test('段落数 <2 且含单换行时回退按单换行切', () => {
    assert.deepEqual(ts.paragraphsWithOffsets('a\nb\nc').map((p) => p.text), ['a', 'b', 'c']);
    // 已经能切出 2 段时不回退：第二段内部的软换行被保留为段内文本。
    const mixed = ts.paragraphsWithOffsets('甲文\n\n\n乙文\n丙文');
    assert.deepEqual(mixed.map((p) => p.text), ['甲文', '乙文\n丙文']);
  });

  test('纯空白段被丢弃，全换行文本得到 0 段', () => {
    assert.deepEqual(ts.paragraphsWithOffsets('\n\n\n'), []);
    assert.deepEqual(ts.paragraphsWithOffsets(''), []);
    assert.deepEqual(ts.paragraphsWithOffsets('   \n\n \t \n\n 乙'), [{ text: ' 乙', start: 10 }]);
  });

  test('CRLF 不回退切分：段文本保留裸 \\r（不裁空白以外的字符）', () => {
    // /\n{2,}/ does not match "\r\n\r\n" as one delimiter run of \n only — it does,
    // because it counts \n occurrences; the \r before the split stays inside the text.
    const paras = ts.paragraphsWithOffsets('甲\r\n\r\n乙');
    assert.deepEqual(paras.map((p) => p.text), ['甲\r', '乙']);
    assert.deepEqual(paras.map((p) => p.start), [0, 5]);
  });

  test('KNOWN-DEFECT: paragraphsWithOffsets 对非字符串入参抛 TypeError，而 siblings 全部静默降级', () => {
    // textStats.js:24-51 reads text.slice()/re.exec(text) without the String(x||'')
    // guard every sibling function uses. compute() is safe (it coerces first),
    // detector.detect() coerces too — but the exported leaf crashes on 12/{}/NaN,
    // so any caller that reaches for it directly gets a throw instead of [] .
    assert.throws(() => ts.paragraphsWithOffsets(12), TypeError);
    assert.throws(() => ts.paragraphsWithOffsets({}), TypeError);
    assert.throws(() => ts.paragraphsWithOffsets(null), TypeError);
    assert.throws(() => ts.paragraphsWithOffsets(undefined), TypeError);
    // Contrast: the coercion-guarded siblings degrade.
    assert.deepEqual(ts.sentences(12), ['12']);
    assert.equal(ts.naturalLength(12), 2);
  });
});

describe('sentences — 句子切分', () => {
  test('中英终止符与全角问号感叹号、分号都算句界', () => {
    assert.deepEqual(ts.sentences('甲。乙！丙？丁；戊；己'), ['甲', '乙', '丙', '丁', '戊', '己']);
    assert.deepEqual(ts.sentences('A? B! C; D'), ['A', 'B', 'C', 'D']);
    assert.deepEqual(ts.sentences('原因如下：甲；乙。'), ['原因如下：甲', '乙']);
  });

  test('纯终止符文本与空白段返回空数组（不产生空句）', () => {
    assert.deepEqual(ts.sentences('。。。！！！'), []);
    assert.deepEqual(ts.sentences(''), []);
    assert.deepEqual(ts.sentences('   '), []);
  });

  test('KNOWN-DEFECT: 注释宣称「句子终止符（中英）」，但句点 . 不在类内——英文文本永远只有 1 句', () => {
    // textStats.js:12-13 says "句子终止符（中英）" yet SENTENCE_TERMINATORS is
    // /[。！？!?；;]+/ — no '.', no ':'. An English paragraph collapses into ONE
    // sentence, so sentenceCount/mean/CV and every per-sentence ratio downstream
    // (化用密度 = markers/sentenceCount) are off by the sentence count.
    assert.deepEqual(ts.sentences('Hello world. Second one. Third!'), [
      'Hello world. Second one. Third',
    ]);
    const en = ts.compute('Introduction. Methods. Results. Discussion. Conclusion.');
    assert.equal(en.sentenceCount, 1);
    assert.equal(en.chars, 51);
    assert.equal(en.rhythm.cv, 0);
  });

  test('非字符串经 String 兜底归一：0 被吞成空句组，对象变成 [object Object]', () => {
    assert.deepEqual(ts.sentences(0), []);
    assert.deepEqual(ts.sentences(false), []);
    assert.deepEqual(ts.sentences(''), []);
    assert.deepEqual(ts.sentences(true), ['true']);
    assert.deepEqual(ts.sentences({ a: 1 }), ['[object Object]']);
    assert.deepEqual(ts.sentences([1, 2]), ['1,2']);
  });
});

describe('naturalLength — 剥离标记后的长度', () => {
  test('加粗/上标/裸角标/URL 与空白都不计入长度', () => {
    assert.equal(ts.naturalLength('文本<sup>[3]</sup>尾'), 3);
    assert.equal(ts.naturalLength('详见 https://example.com/a b'), 3);
    assert.equal(ts.naturalLength('**加粗**与[12]角标'), 5);
    assert.equal(ts.naturalLength('甲\n乙  丙'), 3);
    assert.equal(ts.naturalLength(''), 0);
    assert.equal(ts.naturalLength(null), 0);
    assert.equal(ts.naturalLength(undefined), 0);
  });

  test('0 与 false 被字符串兜底吞成空串，而合法数字文本 0 有长度 1', () => {
    assert.equal(ts.naturalLength(0), 0);
    assert.equal(ts.naturalLength(false), 0);
    assert.equal(ts.naturalLength('0'), 1);
    assert.equal(ts.naturalLength('2019'), 4);
  });

  test('CJK 一字一码元，全角数字同样按字符计', () => {
    assert.equal(ts.naturalLength('中文English'), 9);
    assert.equal(ts.naturalLength('２０１９'), 4);
    assert.equal(ts.naturalLength('“引号”：全角'), 7);
  });

  test('KNOWN-DEFECT: naturalLength 用 .length 当长度，星平面字符（CJK 扩展 B/emoji）按 2 计', () => {
    // textStats.js:71-75 returns String#length (UTF-16 code units). '𪚥' (U+2A5A5)
    // and '𠀀' (U+20000) are one character each but count as 2, so every
    // sentenceLength/mean/CV/字数 figure for 古籍、生僻字、emoji text is inflated
    // and feeds scorer.academic lengthGood + rhythm and the 化用 density denominator.
    assert.equal(ts.naturalLength('𠀀'), 2);
    assert.equal(ts.naturalLength('𠀀'), codePoints('𠀀') + 1);
    assert.equal(ts.naturalLength('😀😀'), 4);
    const c = ts.compute('𪚥字测试。第二个句子𠀀啊。');
    assert.deepEqual(c.sentenceLengths, [5, 8]);
    assert.equal(codePoints('𪚥字测试'), 4);
    // A lone surrogate is not "fixed": it survives as one unit and still measures.
    assert.equal(ts.naturalLength('\ud800'), 1);
  });
});

describe('lengthVariation — 句长变异系数', () => {
  test('均值/标准差/CV 按总体标准差（除以 n）计算', () => {
    assert.deepEqual(ts.lengthVariation([10, 10, 10]), { mean: 10, std: 0, cv: 0 });
    assert.deepEqual(ts.lengthVariation([5, 15]), { mean: 10, std: 5, cv: 0.5 });
    assert.deepEqual(ts.lengthVariation([0, 5]), { mean: 2.5, std: 2.5, cv: 1 });
    assert.deepEqual(ts.lengthVariation([]), { mean: 0, std: 0, cv: 0 });
    assert.deepEqual(ts.lengthVariation([0, 0]), { mean: 0, std: 0, cv: 0 }, 'mean 0 short-circuits');
  });

  test('KNOWN-DEFECT: 非数组入参直接抛 TypeError，数组里的非数字静默产出 NaN', () => {
    // textStats.js:83-95: `lengths.length` / `lengths.reduce` are unguarded, and no
    // NaN filter exists — compute() pre-filters (n>0) so the leaf itself is the trap
    // for callers that hand it a number or a string array.
    assert.throws(() => ts.lengthVariation(null), TypeError);
    assert.throws(() => ts.lengthVariation(3), TypeError);
    assert.throws(() => ts.lengthVariation('abc'), TypeError);
    const junk = ts.lengthVariation(['x']);
    assert.ok(Number.isNaN(junk.mean) && Number.isNaN(junk.std) && Number.isNaN(junk.cv));
    // NaN mean is NOT caught by the `mean === 0` guard.
    assert.ok(Number.isNaN(ts.lengthVariation([NaN, 5]).cv));
  });
});

describe('compute — 全文级统计', () => {
  test('空文本给全零而不是 NaN，段落/句数均为 0', () => {
    const c = ts.compute('');
    assert.equal(c.chars, 0);
    assert.equal(c.paragraphCount, 0);
    assert.equal(c.sentenceCount, 0);
    assert.deepEqual(c.sentenceLengths, []);
    assert.deepEqual(c.rhythm, { mean: 0, std: 0, cv: 0 });
    assert.deepEqual(c.citationNumbers, []);
    assert.equal(ts.compute(null).chars, 0);
    assert.equal(ts.compute(undefined).sentenceCount, 0);
  });

  test('加粗计数只认成对 **…**，跨行与空内容不算', () => {
    assert.equal(ts.compute('**甲**与**乙**').boldCount, 2);
    assert.equal(ts.compute('**甲****乙**').boldCount, 2);
    assert.equal(ts.compute('**未闭合').boldCount, 0);
    assert.equal(ts.compute('**\n**').boldCount, 0);
    assert.equal(ts.compute('****').boldCount, 0);
  });

  test('<sup>[n]</sup> 优先；有 sup 时裸 [n] 完全不计数', () => {
    const sup = ts.compute('见<sup>[3]</sup>与[5]。');
    assert.equal(sup.explicitCitations, 1);
    assert.deepEqual(sup.citationNumbers, [3]);
    const bare = ts.compute('见文献[12]另见[12]。');
    assert.equal(bare.explicitCitations, 2);
    assert.equal(bare.distinctCitationNumbers, 1);
    assert.deepEqual(bare.citationNumbers, [12]);
  });

  test('KNOWN-DEFECT: distinctCitationNumbers 按原始字符串去重，citationNumbers 再 parseInt——同一文献的 [7] 与 [07] 被算成两篇', () => {
    // textStats.js:117-125 + 163-164: the Set keys on the captured TEXT, the array is
    // parseInt'ed afterwards. constraints.js:110 judges "显式引用篇数" on the Set size
    // and "编号严格递增" on the parsed array, so the two fields contradict each other
    // and the full-text gate can be satisfied by zero-padded re-citations.
    const c = ts.compute('<sup>[7]</sup>和<sup>[07]</sup>');
    assert.equal(c.explicitCitations, 2);
    assert.equal(c.distinctCitationNumbers, 2);
    assert.deepEqual(c.citationNumbers, [7, 7]);
    // Same number written twice is 1 篇, so the two counters disagree by construction.
    const dup = ts.compute('<sup>[7]</sup><sup>[7]</sup>');
    assert.equal(dup.distinctCitationNumbers, 1);
  });

  test('KNOWN-DEFECT: 化用年份只认半角括号与半角数字，中文论文常见的（２０１９）不算化用', () => {
    // textStats.js:102 CITATION_YEAR = /[（(][^（）()\n]{0,28}(?:19|20)\d{2}[）)]/ —
    // the parens are both widths, but \d{2} only matches ASCII digits, and
    // NUMBER_UNIT (line 106) likewise. huayongMarkers drives the 20%-40% hard gate
    // (constraints.js:89-100) and scorer's citation component: full-width citations
    // measure as zero 化用 and zero specificity instead of being counted.
    assert.equal(ts.compute('张三（２０１９）与李四（２０２０）的研究。').huayongMarkers, 0);
    assert.equal(ts.compute('张三（2019）的研究。').huayongMarkers, 1);
    assert.equal(ts.CITATION_YEAR.test('（２０１９）'), false);
    // Full-width percent is accepted, so the unit list is half CJK-aware.
    assert.equal(ts.compute('增长１５％，下降 20%。').numberUnitCount, 1);
  });

  test('年份去重计数、带单位数字逐处计数', () => {
    const c = ts.compute('（2020）与2020年和(1999)共 15% 3个 100人 5ms');
    assert.equal(c.yearCount, 2);
    assert.equal(c.numberUnitCount, 4);
    assert.equal(c.huayongMarkers, 2);
  });

  test('KNOWN-DEFECT: compute 会把非字符串垃圾当成文本统计，而不是拒绝或归零', () => {
    // textStats.js:140 String(text || '') — an object becomes '[object Object]' and a
    // number becomes its digits; compute() then reports a confident measurement for a
    // value that was never prose (detector.detect({}) inherits this).
    assert.equal(ts.compute({}).chars, 14);
    assert.equal(ts.compute([1, 2]).chars, 3);
    assert.equal(ts.compute(0).chars, 0, '0 is swallowed by the || fallback');
  });

  test('星平面字符在 compute 里同样按 2 个字符计入字数', () => {
    const c = ts.compute('𪚥字测试。');
    assert.equal(c.chars, 6);
    assert.equal(codePoints('𪚥字测试'), 4);
  });
});

describe('导出正则的共享状态', () => {
  test('KNOWN-DEFECT: 导出的 /g 正则是进程级共享可变单例，lastIndex 会跨调用方泄漏', () => {
    // textStats.js:98-102 + 171-182 export SUP_CITATION/BARE_CITATION/CITATION_YEAR
    // themselves (not copies) so detector.js can reuse them. _countMatches() resets
    // lastIndex, but the exported objects stay live: whoever calls .test()/.exec()
    // directly leaves a cursor behind for the next consumer.
    assert.equal(ts.CITATION_YEAR.global, true);
    assert.equal(ts.BARE_CITATION.global, true);
    assert.equal(ts.SUP_CITATION.global, true);
    assert.equal(ts.SENTENCE_TERMINATORS.global, false, 'split-only, non-global');
    // Proof of the leak: a bare .test() advances the shared cursor...
    ts.BARE_CITATION.lastIndex = 0;
    assert.equal(ts.BARE_CITATION.test('见[12]。'), true);
    assert.equal(ts.BARE_CITATION.lastIndex, 5);
    // ...and the next consumer's first match is searched from there.
    assert.equal(ts.BARE_CITATION.test('[12]。'), false, 'same pattern, stale cursor');
    ts.BARE_CITATION.lastIndex = 0;
    assert.equal(ts.BARE_CITATION.test('[12]。'), true);
  });

  test('裸角标查表的边界断言（lookbehind/lookahead 确实生效）', () => {
    ts.BARE_CITATION.lastIndex = 0;
    assert.equal(ts.BARE_CITATION.test('A1[12]'), false, 'word char before -> not a citation');
    ts.BARE_CITATION.lastIndex = 0;
    assert.equal(ts.BARE_CITATION.test('[1234]'), false, '4 digits out of range');
    ts.BARE_CITATION.lastIndex = 0;
    assert.equal(ts.BARE_CITATION.test('[ 7 ]'), true, 'inner spaces allowed');
    ts.BARE_CITATION.lastIndex = 0;
  });
});
