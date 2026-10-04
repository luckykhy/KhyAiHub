'use strict';

// Co-located contract tests for detector.js (the deterministic 16-pattern scanner).
// Fixtures are kept free of ambiguous citation proximity unless a test is about it,
// because detector.js shares module-level RegExp state with textStats.js.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const detector = require('./detector');
const textStats = require('./textStats');

const MULTI = '第一段综上所述。\n\n依据框架的理论视角，研究表明（2020）数据。\n\n综上所述，这是第二段。';

describe('detect — 返回结构与定位', () => {
  test('findings 按 id 升序、每条带 name/priority/fix/count/matches', () => {
    const d = detector.detect(MULTI);
    assert.ok(d.findings.length > 0);
    const ids = d.findings.map((f) => f.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    for (const f of d.findings) {
      assert.equal(typeof f.name, 'string');
      assert.equal(typeof f.fix, 'string');
      assert.ok(['high', 'mid', 'low'].includes(f.priority));
      assert.equal(f.count, f.matches.length, `finding ${f.id} count vs matches`);
      for (const m of f.matches) {
        assert.equal(typeof m.text, 'string');
        assert.ok(Number.isInteger(m.index));
        assert.ok(Number.isInteger(m.paragraph));
        assert.equal(typeof m.atEnd, 'boolean');
      }
    }
  });

  test('每个命中的全局 index 都能与原文逐字对上（偏移不漂移）', () => {
    const d = detector.detect(MULTI);
    const bad = [];
    for (const f of d.findings) {
      for (const m of f.matches) {
        // 15/16 的 text 是聚合描述，不是原文片段。
        if (m.text.startsWith('冒号') || m.text.startsWith('全文加粗')) continue;
        if (MULTI.slice(m.index, m.index + m.text.length) !== m.text) {
          bad.push([f.id, m.text, m.index]);
        }
      }
    }
    assert.deepEqual(bad, []);
  });

  test('命中的 paragraph 号与段偏移表一致，段号从 0 起', () => {
    const paras = textStats.paragraphsWithOffsets(MULTI);
    const d = detector.detect(MULTI);
    assert.equal(d.perParagraph.length, paras.length);
    d.perParagraph.forEach((p, i) => {
      assert.equal(p.index, i);
      assert.equal(typeof p.theoryOpener, 'boolean');
      assert.ok(Number.isInteger(p.highFreq) && p.highFreq >= 0);
    });
    for (const f of d.findings) {
      for (const m of f.matches) {
        if (m.paragraph < 0) continue;
        const p = paras[m.paragraph];
        assert.ok(
          m.index >= p.start && m.index < p.start + p.text.length,
          `match ${m.text}@${m.index} outside paragraph ${m.paragraph}`
        );
      }
    }
  });

  test('atEnd 只标在套句类（模式 2/7），其余模式恒为 false', () => {
    const d = detector.detect(MULTI);
    for (const f of d.findings) {
      for (const m of f.matches) {
        if (f.id === 2 || f.id === 7) continue;
        assert.equal(m.atEnd, false, `pattern ${f.id} should not claim atEnd`);
      }
    }
    assert.deepEqual(
      d.findings.filter((f) => f.id === 7).map((f) => f.matches.map((m) => m.atEnd)),
      [[true, true]]
    );
  });
});

describe('_isNearEnd — 段末判定', () => {
  test('剩余长度 ≤ max(40, 段长*0.45) 才算段末', () => {
    assert.equal(detector._isNearEnd('综上所述', 0, 4), true);
    // 200-char paragraph: threshold = max(40, 90) = 90, tail 4 chars -> at end.
    assert.equal(detector._isNearEnd('甲'.repeat(100) + '综上所述', 100, 4), true);
    // Same hit at the head of that paragraph leaves 196 chars -> NOT at end.
    assert.equal(detector._isNearEnd('甲'.repeat(100) + '综上所述', 0, 4), false);
    // Degenerate inputs degrade instead of throwing.
    assert.equal(detector._isNearEnd('', 0, 0), true);
    assert.equal(detector._isNearEnd('甲乙丙', 99, 1), true);
  });

  test('段长 ≤ 40+ 命中文本时任何位置都算「段末」，长段的段首套句被跳过', () => {
    const d = detector.detect('综上所述。别的句子在这里也有内容补充说明一下情况');
    assert.deepEqual(d.findings.filter((f) => f.id === 7).map((f) => f.count), [1]);
    const long = detector.detect('综上所述' + '很长的内容在这里。'.repeat(10));
    assert.deepEqual(long.findings.filter((f) => f.id === 7).map((f) => f.count), []);
  });
});

describe('_hasNearbyCitation — 邻近出处核查', () => {
  test('±60 字符内有 <sup>[n]</sup>/[n]/年份括号即算有出处，超出窗口算无出处', () => {
    textStats.CITATION_YEAR.lastIndex = 0;
    assert.equal(detector._hasNearbyCitation('研究表明（2020）', 0), true);
    textStats.CITATION_YEAR.lastIndex = 0;
    assert.equal(detector._hasNearbyCitation('见文献[12]的表述', 0), true);
    textStats.CITATION_YEAR.lastIndex = 0;
    assert.equal(detector._hasNearbyCitation('见<sup>[3]</sup>的表述', 0), true);
    const far = '研究表明' + '填充'.repeat(40) + '（2020）。';
    textStats.CITATION_YEAR.lastIndex = 0;
    assert.equal(detector._hasNearbyCitation(far, 0), false);
    textStats.CITATION_YEAR.lastIndex = 0;
    assert.equal(detector._hasNearbyCitation('', 0), false);
    // Negative index clamps the window start to 0 rather than throwing.
    textStats.CITATION_YEAR.lastIndex = 0;
    assert.equal(detector._hasNearbyCitation('研究表明', -5), false);
  });

  test('自定义窗口参数生效', () => {
    textStats.CITATION_YEAR.lastIndex = 0;
    assert.equal(detector._hasNearbyCitation('研究表明XXXX（2020）', 0, 4), false);
    textStats.CITATION_YEAR.lastIndex = 0;
    assert.equal(detector._hasNearbyCitation('研究表明XXXX（2020）', 0, 20), true);
  });

  test('KNOWN-DEFECT: 邻近核查复用 /g 正则且不重置 lastIndex，同一入参的答案交替翻转', () => {
    // detector.js:39 calls textStats.CITATION_YEAR.test(slice) on the exported
    // global RegExp (textStats.js:102) without resetting lastIndex, and test()
    // advances that cursor. Identical arguments therefore return true, then false,
    // then true — the answer depends on what scanned before it.
    textStats.CITATION_YEAR.lastIndex = 0;
    const seq = [0, 1, 2, 3].map(() => detector._hasNearbyCitation('研究表明（2020）数据显示', 2));
    assert.deepEqual(seq, [true, false, true, false]);
    assert.equal(textStats.CITATION_YEAR.global, true);
  });

  test('KNOWN-DEFECT: 同一段里共用一条出处的两处模糊归因，第二处必被判成无出处（硬约束翻红）', () => {
    // Consequence of the stale cursor above: detector.js:101 skips a 模式 8 hit when
    // a citation is nearby, but the second hit's test() resumes after the first
    // match and reports "no citation" — here 业内普遍认为 sits 9 characters from
    // （2020）. vagueAttribution is a "=0" HARD gate (constraints.js:85-87), so a
    // properly cited paragraph fails the gate and the brief tells the author to go
    // find a reference that is already in the sentence.
    const shared = '研究表明（2020）该数据上涨，业内普遍认为同一结论。';
    const d = detector.detect(shared);
    const f8 = d.findings.filter((f) => f.id === 8);
    assert.equal(f8.length, 1);
    assert.equal(f8[0].count, 1);
    assert.deepEqual(f8[0].matches.map((m) => `${m.text}@${m.index}`), ['业内普遍认为@16']);
    // The same sentence pair in the other order flags the OTHER attribution — proof
    // that it is scan order, not citation distance, that decides.
    const reversed = detector.detect('业内普遍认为同一结论，研究表明（2020）该数据上涨。');
    assert.deepEqual(
      reversed.findings.filter((f) => f.id === 8).map((f) => f.matches.map((m) => `${m.text}@${m.index}`)),
      [['研究表明@11']]
    );
  });
});

describe('逐模式判定', () => {
  test('模式 1 理论起笔：只有每段第一句参与 openers 统计，命中本身仍会报出', () => {
    const d = detector.detect('普通开头。依据框架的理论视角展开。');
    assert.deepEqual(d.perParagraph.map((p) => p.theoryOpener), [false]);
    assert.deepEqual(d.findings.filter((f) => f.id === 1).map((f) => f.count), [1]);
    const ratio = detector.detect(
      '依据框架的理论视角。\n\n依据另一个模型的观点。\n\n普通段落内容。\n\n还是普通段落。'
    );
    assert.deepEqual(ratio.perParagraph.map((p) => p.theoryOpener), [true, true, false, false]);
    assert.equal(ratio.totals.theoryOpenerRatio, 0.5);
  });

  test('模式 3 编号逻辑要求「首先，…其次，」成对，单个首先不算', () => {
    assert.deepEqual(detector.detect('首先甲其次乙').findings.map((f) => f.id), []);
    const hit = detector.detect('首先，甲，其次，乙。');
    assert.deepEqual(hit.findings.filter((f) => f.id === 3).map((f) => f.count), [1]);
  });

  test('模式 8 在有出处时整条消失，无出处时才计数', () => {
    assert.deepEqual(detector.detect('研究表明（2020）数据显示。').findings.map((f) => f.id), []);
    const bare = detector.detect('研究表明该数据显示。');
    assert.deepEqual(bare.findings.filter((f) => f.id === 8).map((f) => f.count), [1]);
  });

  test('KNOWN-DEFECT: 模式 6「三元并列」不允许跨句，中文最常见的「从…看。从…看。从…看。」测不出来，tripletMax 恒为 0', () => {
    // rules.js:93-94 separates the three clauses with [^\n]{0,40}, which excludes 。,
    // so a real three-part 排比 never matches; constraints.js:54-60 judges the
    // "三元并列/段 ≤1" gate on totals.tripletMax and can therefore never fail.
    // The overlapping 模式 14 (which allows 。 inside its gap) DOES see the same text.
    const d = detector.detect('从经济维度看，A。从社会维度看，B。从文化维度看，C。');
    assert.equal(d.totals.tripletMax, 0);
    assert.deepEqual(d.findings.filter((f) => f.id === 6).map((f) => f.count), []);
    assert.deepEqual(d.findings.filter((f) => f.id === 14).map((f) => f.count), [1]);
    // The "三大/三重 + 冒号" branch does match, so only the 从…看 form is blind.
    assert.equal(detector.detect('三大考量：甲。三重维度：乙。').totals.tripletMax, 2);
  });

  test('模式 11 AI 高频词按段计数并驱动 maxHighFreqPerPara', () => {
    const d = detector.detect('进一步分析，多维度考察。');
    assert.deepEqual(d.findings.filter((f) => f.id === 11).map((f) => f.count), [2]);
    assert.equal(d.totals.maxHighFreqPerPara, 2);
    assert.equal(d.perParagraph[0].highFreq, 2);
    // Words that exist only in HIGH_FREQ_WORDS still count.
    assert.equal(detector.detect('层面维度日益愈发').totals.maxHighFreqPerPara, 4);
  });

  test('KNOWN-DEFECT: 模式 11 同一处命中被记两遍（模式表 regex 与高频词表重叠），findings 翻倍且 weighted 分被推高', () => {
    // detector.js:87-116 scans PATTERNS[10].regex ('深刻揭示了?') and pushes into the
    // id-11 finding, then detector.js:131-145 scans rules.highFreqRegex() ('深刻揭示')
    // over the same paragraph and pushes AGAIN at the same index. maxHighFreqPerPara
    // (the "每段≤2" gate) uses only the second loop, but totals.high/weighted — and
    // hence the AIGC score and the rewrite brief's location list — use the doubled
    // count. Two words in one paragraph become four reported hits.
    const d = detector.detect('这深刻揭示了问题，综合运用多种方法。');
    const f11 = d.findings.filter((f) => f.id === 11)[0];
    assert.equal(f11.count, 4);
    assert.deepEqual(
      f11.matches.map((m) => `${m.text}@${m.index}`),
      ['深刻揭示了@1', '综合运用@9', '深刻揭示@1', '综合运用@9']
    );
    assert.equal(d.totals.maxHighFreqPerPara, 2, 'gate input stays 2');
    assert.equal(d.totals.high, 4, 'weighted input doubled');
  });

  test('模式 15 标点失衡按段记一处，冒号含半角，破折号认 —— 与 --', () => {
    const colon = detector.detect('甲：乙:丙：丁');
    assert.deepEqual(colon.findings.filter((f) => f.id === 15).map((f) => [f.count, f.matches[0].text]), [[1, '冒号3/破折号0']]);
    const dashes = detector.detect('甲--乙--丙——丁——戊');
    assert.deepEqual(dashes.findings.filter((f) => f.id === 15).map((f) => f.matches[0].text), ['冒号0/破折号4']);
    assert.equal(dashes.perParagraph[0].dashes, 4);
    // Below the thresholds nothing is reported.
    assert.deepEqual(detector.detect('甲：乙').findings.filter((f) => f.id === 15).map((f) => f.count), []);
  });

  test('模式 16 加粗滥用是全文级：count 取总加粗数、paragraph 记 -1', () => {
    const d = detector.detect('**一****二****三****四****五****六**');
    assert.equal(d.stats.boldCount, 6);
    const f16 = d.findings.filter((f) => f.id === 16)[0];
    assert.equal(f16.count, 6);
    assert.equal(f16.priority, 'low');
    assert.equal(f16.matches.length, 1);
    assert.equal(f16.matches[0].paragraph, -1);
    assert.equal(f16.matches[0].text, '全文加粗 6 处');
    // 5 is inside the limit -> no finding at all.
    assert.deepEqual(detector.detect('**一****二****三****四****五**').findings.filter((f) => f.id === 16), []);
  });
});

describe('totals 聚合', () => {
  test('权重 high=3 / mid=2 / low=1，且 high/mid/low 计数与 findings 一致', () => {
    const d = detector.detect(MULTI);
    const by = { high: 0, mid: 0, low: 0 };
    let weighted = 0;
    for (const f of d.findings) {
      by[f.priority] += f.count;
      weighted += { high: 3, mid: 2, low: 1 }[f.priority] * f.count;
    }
    assert.equal(d.totals.high, by.high);
    assert.equal(d.totals.mid, by.mid);
    assert.equal(d.totals.low, by.low);
    assert.equal(d.totals.weighted, weighted);
    assert.deepEqual(d.findings.map((f) => [f.id, f.priority, f.count]), [
      [1, 'high', 1],
      [7, 'mid', 2],
      [11, 'high', 2],
    ]);
    assert.equal(d.totals.endCliche, 2, '段末套句总数 = 模式2 + 模式7');
    assert.equal(d.totals.theoryOpenerRatio, 1 / 3);
  });

  test('endCliche 只汇总模式 2 与 7', () => {
    const d = detector.detect('此案例印证了结论。综上所述');
    assert.deepEqual(d.findings.map((f) => [f.id, f.count]), [
      [2, 1],
      [7, 1],
      [11, 1],
    ]);
    assert.equal(d.totals.endCliche, 2);
  });

  test('无段落文本时聚合全为 0，不产生 NaN', () => {
    const d = detector.detect('');
    assert.deepEqual(d.findings, []);
    assert.deepEqual(d.perParagraph, []);
    assert.deepEqual(d.totals, {
      high: 0,
      mid: 0,
      low: 0,
      weighted: 0,
      theoryOpenerRatio: 0,
      maxHighFreqPerPara: 0,
      endCliche: 0,
      tripletMax: 0,
    });
    assert.equal(d.stats.chars, 0);
  });
});

describe('垃圾入参与确定性', () => {
  test('null/undefined/空串归零，非字符串走 String 兜底后被当成文本扫描', () => {
    assert.deepEqual(detector.detect(null).findings, []);
    assert.equal(detector.detect(null).stats.chars, 0);
    assert.equal(detector.detect(undefined).stats.paragraphCount, 0);
    assert.equal(detector.detect('').stats.chars, 0);
    // detector.js:54 String(text||'') — an object is measured as '[object Object]'.
    assert.equal(detector.detect({}).stats.chars, 14);
    assert.equal(detector.detect(12345).stats.chars, 5);
    assert.equal(detector.detect([]).stats.chars, 0, 'String([]) is the empty string');
  });

  test('同一文本重复检测给出同样的结果（不含引用邻近的模式）', () => {
    const a = JSON.stringify(detector.detect(MULTI).findings.map((f) => [f.id, f.count]));
    const b = JSON.stringify(detector.detect(MULTI).findings.map((f) => [f.id, f.count]));
    assert.equal(a, b);
  });

  test('星平面字符不炸扫描，偏移按 UTF-16 码元计', () => {
    const src = '综上所述𪚥𪚥𪚥。';
    const d = detector.detect(src);
    assert.deepEqual(d.findings.map((f) => [f.id, f.matches.map((m) => m.index)]), [
      [7, [0]],
      [11, [0]],
    ]);
    assert.equal(d.stats.chars, 11, '3 astral chars counted twice');
  });

  test('KNOWN-DEFECT: detect() 不携带原文本，下游 constraints/scorer 的文本相关判定静默失效', () => {
    // constraints.js:131 reads detection.text for the [待核实] count and scorer.js:83
    // /92 read it for 语气/口语 scoring. index.js:36 patches it on afterwards, but the
    // detector contract (detector.js:44-52 JSDoc lists findings/stats/perParagraph/
    // totals) never promises text — so calling detect()+check()/score() directly, which
    // the JSDoc of both modules advertises, silently scores every document as if it had
    // no [待核实] markers, no colloquialisms and no scholar voice.
    const d = detector.detect('这项结论[待核实]。');
    assert.equal('text' in d, false);
    assert.equal(d.stats.huayongMarkers, 0);
  });
});
