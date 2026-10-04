'use strict';

// Co-located contract tests for rules.js (the single source of AI-pattern truth).
// Everything below is measured against the module; the mutation cases restore what
// they changed, because this module is a process-wide singleton other suites share.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const rules = require('./rules');

const RULES_PATH = require.resolve('./rules');

// Load a throw-away copy of rules.js with the given env, then put the original
// module instance back so no other suite ever sees the temporary one.
function withFreshRules(env, fn) {
  const original = require.cache[RULES_PATH];
  const touched = Object.keys(env);
  const prior = touched.map((k) => process.env[k]);
  try {
    touched.forEach((k, i) => {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    });
    delete require.cache[RULES_PATH];
    return fn(require(RULES_PATH));
  } finally {
    delete require.cache[RULES_PATH];
    if (original) require.cache[RULES_PATH] = original;
    touched.forEach((k, i) => {
      if (prior[i] === undefined) delete process.env[k];
      else process.env[k] = prior[i];
    });
  }
}

describe('PATTERNS — 16 种模式的声明完整性', () => {
  test('模式表恰好 16 条、编号 1..16 连续且唯一', () => {
    assert.equal(rules.PATTERNS.length, 16);
    assert.deepEqual(rules.PATTERNS.map((p) => p.id), Array.from({ length: 16 }, (_, i) => i + 1));
    assert.equal(new Set(rules.PATTERNS.map((p) => p.id)).size, 16);
    assert.deepEqual(
      rules.PATTERNS.map((p) => p.name),
      ['理论起笔', '段末套句', '编号逻辑', '被动分析套话', '模板化问题陈述', '三元并列对称',
        '画蛇添足总结句', '模糊归因', '填充短语', '泛化结尾', 'AI高频词', '回避「是」',
        '过度对仗排比', '三步走等重分析', '标点失衡', '加粗滥用']
    );
  });

  test('优先级只取 PRIORITY 三值；atEnd 只有 2/7；requiresNoCitation 只有 8', () => {
    const allowed = new Set(['high', 'mid', 'low']);
    for (const p of rules.PATTERNS) {
      assert.ok(allowed.has(p.priority), `pattern ${p.id} priority ${p.priority}`);
      assert.equal(typeof p.fix, 'string');
      assert.ok(p.fix.length > 0, `pattern ${p.id} has an empty fix`);
      assert.ok(Array.isArray(p.triggers) && p.triggers.length > 0);
      assert.ok(p.triggers.every((t) => typeof t === 'string' && t.length > 0));
    }
    assert.deepEqual(rules.PATTERNS.filter((p) => p.atEnd).map((p) => p.id), [2, 7]);
    assert.deepEqual(rules.PATTERNS.filter((p) => p.requiresNoCitation).map((p) => p.id), [8]);
    // 15/16 是段级/全文级判定，故意不给 regex。
    assert.deepEqual(rules.PATTERNS.filter((p) => p.regex === null).map((p) => p.id), [15, 16]);
  });

  test('每条 regex 源都能编译成 global RegExp 且初始 lastIndex 为 0', () => {
    for (const p of rules.PATTERNS.filter((x) => x.regex !== null)) {
      const re = new RegExp(p.regex, 'g');
      assert.equal(re.global, true);
      assert.equal(re.lastIndex, 0);
      assert.notEqual(p.regex.indexOf('('), -1, `pattern ${p.id} should capture`);
    }
  });

  test('PRIORITY 常量与模式表用同一套字面量', () => {
    assert.deepEqual(rules.PRIORITY, { HIGH: 'high', MID: 'mid', LOW: 'low' });
    assert.equal(rules.PATTERNS[0].priority, rules.PRIORITY.HIGH);
    assert.equal(rules.PATTERNS[3].priority, rules.PRIORITY.MID);
    assert.equal(rules.PATTERNS[11].priority, rules.PRIORITY.LOW);
  });
});

describe('词表与替换表', () => {
  test('AI 高频词 23 条、无重复；口语红线含一个重复项', () => {
    assert.equal(rules.HIGH_FREQ_WORDS.length, 23);
    assert.equal(new Set(rules.HIGH_FREQ_WORDS).size, 23);
    assert.equal(rules.NEUTRAL_TONE_MARKERS.length, 12);
    assert.equal(new Set(rules.NEUTRAL_TONE_MARKERS).size, 12);
    assert.equal(rules.COLLOQUIAL_BLOCKLIST.length, 20);
    assert.equal(new Set(rules.COLLOQUIAL_BLOCKLIST).size, 19, '666 is declared twice');
    assert.deepEqual(
      rules.COLLOQUIAL_BLOCKLIST.filter((w) => w === '666').length,
      2
    );
  });

  test('三个正则工厂返回缓存实例（同一对象），且能按词表匹配', () => {
    assert.equal(rules.highFreqRegex(), rules.highFreqRegex());
    assert.equal(rules.colloquialRegex(), rules.colloquialRegex());
    assert.equal(rules.neutralToneRegex(), rules.neutralToneRegex());
    const hf = rules.highFreqRegex();
    hf.lastIndex = 0;
    assert.equal(hf.exec('这深刻揭示了问题')[0], '深刻揭示');
    const nr = rules.neutralToneRegex();
    nr.lastIndex = 0;
    const found = [];
    let m;
    while ((m = nr.exec('换句话说，坦率地说，倒是罢了')) !== null) found.push(m[0]);
    assert.deepEqual(found, ['换句话说', '坦率地说', '倒是', '罢了']);
  });

  test('KNOWN-DEFECT: 口语红线里的 666 没有词边界，年份与数量被当成网络俚语', () => {
    // rules.js:251-272 + 352: the blocklist entry '666' is joined into a bare
    // alternation, so 万历（1666） and 6660条记录 each hand the caller a hit.
    // scorer.js:100 turns every hit into -8 学术分 (pinned in scorer.test.js).
    const cre = rules.colloquialRegex();
    cre.lastIndex = 0;
    const hits = [];
    let m;
    while ((m = cre.exec('万历（1666）年，6660条记录')) !== null) hits.push([m[0], m.index]);
    assert.deepEqual(hits, [['666', 4], ['666', 10]]);
  });

  test('KNOWN-DEFECT: 高频词表与替换表不对齐——“深刻揭示”能命中却没有替换建议', () => {
    // HIGH_FREQ_WORDS lists '深刻揭示' (rules.js:203-227) while REPLACEMENTS only
    // lists '深刻揭示了' (rules.js:232-245). The alternation matches the shorter
    // form first, so index.js:_replacementsFor() looks up '深刻揭示', misses, and
    // the rewrite brief offers no replacement for a hit it just reported.
    assert.equal(rules.HIGH_FREQ_WORDS.includes('深刻揭示'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(rules.REPLACEMENTS, '深刻揭示'), false);
    assert.equal(rules.REPLACEMENTS['深刻揭示了'], '说明了');
    // Empty-string replacements mean "delete the phrase", so a plain truthiness
    // test downstream would silently drop them — the table does contain two.
    assert.equal(rules.REPLACEMENTS['具有重要意义'], '');
    assert.equal(rules.REPLACEMENTS['综上所述'], '');
  });

  test('REPLACEMENTS 是普通对象：原型键可读，查表没有 own-property 守卫', () => {
    // index.js:96 reads rules.REPLACEMENTS[m.text] with no own-property guard.
    // Today the key space is the fixed high-frequency word list, so document text
    // cannot steer it — but the table itself is prototype-exposed, so any future
    // caller that feeds an external string in gets Object.prototype members back.
    assert.equal(typeof rules.REPLACEMENTS.toString, 'function');
    assert.equal(Object.prototype.hasOwnProperty.call(rules.REPLACEMENTS, 'toString'), false);
    assert.equal(Object.keys(rules.REPLACEMENTS).length, 12);
  });
});

describe('_escape 与阈值', () => {
  test('_escape 转义正则元字符，非字符串直接抛 TypeError', () => {
    assert.equal(rules._escape('a.b*c'), 'a\\.b\\*c');
    assert.equal(rules._escape('(2024)[x]{1,2}+?^$|\\'), '\\(2024\\)\\[x\\]\\{1,2\\}\\+\\?\\^\\$\\|\\\\');
    assert.equal(rules._escape('综上所述'), '综上所述');
    assert.throws(() => rules._escape(0), TypeError);
    assert.throws(() => rules._escape(null), TypeError);
    assert.throws(() => rules._escape(['a']), TypeError);
  });

  test('阈值表就是文档里那组数字（无 env 时的默认值）', () => {
    assert.deepEqual(rules.thresholds, {
      highFreqPerParagraph: 2,
      endClicheTotal: 1,
      tripletPerParagraph: 1,
      theoryOpenerRatio: 0.2,
      boldTotal: 5,
      generalEndingTotal: 0,
      vagueAttributionTotal: 0,
      explicitCitationFull: 15,
      huayongMin: 0.2,
      huayongMax: 0.4,
      colonPerParagraph: 3,
      dashPerParagraph: 4,
      aigcPass: 40,
      academicPass: 55,
    });
  });

  test('阈值只在模块加载时读一次 env：0 被尊重，垃圾回落默认值', () => {
    assert.equal(
      withFreshRules({ KHY_WEIPU_BOLD_TOTAL: '0' }, (fresh) => fresh.thresholds.boldTotal),
      0,
      "'0' is a non-empty string so the || fallback keeps it"
    );
    assert.equal(
      withFreshRules({ KHY_WEIPU_BOLD_TOTAL: ' 7 ' }, (fresh) => fresh.thresholds.boldTotal),
      7
    );
    assert.equal(
      withFreshRules({ KHY_WEIPU_AIGC_PASS: 'abc' }, (fresh) => fresh.thresholds.aigcPass),
      40
    );
    assert.equal(
      withFreshRules({ KHY_WEIPU_AIGC_PASS: '' }, (fresh) => fresh.thresholds.aigcPass),
      40
    );
    assert.equal(
      withFreshRules({ KHY_WEIPU_HUAYONG_MAX: '0.5' }, (fresh) => fresh.thresholds.huayongMax),
      0.5
    );
    // The original instance is untouched by the probe load.
    assert.equal(rules.thresholds.boldTotal, 5);
  });

  test('KNOWN-DEFECT: env 解析无校验——负数照单全收，1e3 被 parseInt 截成 1', () => {
    // rules.js:293-301 only checks Number.isFinite. A typo'd KHY_WEIPU_HIFREQ_PER_PARA
    // therefore inverts the gate instead of rejecting the value: -1 makes EVERY
    // paragraph fail the "AI高频词/段 ≤" constraint, and 1e3 silently becomes 1.
    assert.equal(
      withFreshRules({ KHY_WEIPU_HIFREQ_PER_PARA: '-1' }, (f) => f.thresholds.highFreqPerParagraph),
      -1
    );
    assert.equal(
      withFreshRules({ KHY_WEIPU_BOLD_TOTAL: '1e3' }, (f) => f.thresholds.boldTotal),
      1
    );
    assert.equal(
      withFreshRules({ KHY_WEIPU_BOLD_TOTAL: '2.9' }, (f) => f.thresholds.boldTotal),
      2
    );
    // _envFloat keeps the fraction but still accepts nonsense ranges.
    assert.equal(
      withFreshRules({ KHY_WEIPU_HUAYONG_MIN: '0.9' }, (f) => f.thresholds.huayongMin),
      0.9,
      'min > max makes the 化用 gate unsatisfiable'
    );
  });

  test('KNOWN-DEFECT: _resetCache 的注释承诺「阈值随 env 变更后重读」，实际只清正则缓存', () => {
    // rules.js:373-379 clears _compiled/_hifreq/_colloquial/_neutral only; `thresholds`
    // is a module-load-time const (line 306). A maintainer who sets env and calls the
    // documented helper gets stale thresholds with freshly compiled regexes.
    const before = rules.thresholds.boldTotal;
    process.env.KHY_WEIPU_BOLD_TOTAL = '0';
    try {
      rules._resetCache();
      assert.equal(rules.thresholds.boldTotal, before, 'thresholds did NOT re-read env');
      assert.notEqual(rules.compiledPatterns(), null, 'but the regex cache was rebuilt');
    } finally {
      delete process.env.KHY_WEIPU_BOLD_TOTAL;
      rules._resetCache();
    }
    assert.equal(rules.thresholds.boldTotal, before);
  });
});

describe('导出面的可变性（进程级共享真源）', () => {
  test('KNOWN-DEFECT: PATTERNS/thresholds/compiledPatterns 交出的是表内活引用，改一笔全进程生效', () => {
    // rules.js:381-395 exports the arrays/objects themselves and compiledPatterns()
    // (line 331-346) hands out the memoised _compiled array. detector.js:57 and
    // constraints.js:28 read them per call, so one careless mutation rewrites the
    // rule set for every consumer in the process — there is no clone, no freeze.
    assert.equal(rules.compiledPatterns(), rules.compiledPatterns(), 'cached array by identity');
    assert.equal(rules.thresholds, require('./rules').thresholds, 'same singleton object');
    assert.equal(rules.compiledPatterns()[0].re, rules.compiledPatterns()[0].re);

    const patterns = rules.PATTERNS;
    const n = patterns.length;
    patterns.push({ id: 99, name: 'probe', priority: 'low', triggers: ['x'], regex: null });
    try {
      assert.equal(require('./rules').PATTERNS.length, n + 1, 'write-through to the module');
    } finally {
      patterns.pop();
    }
    assert.equal(rules.PATTERNS.length, n);

    const fix = rules.compiledPatterns()[1].fix;
    rules.compiledPatterns()[1].fix = '已被某个调用方改写';
    try {
      assert.equal(require('./rules').compiledPatterns()[1].fix, '已被某个调用方改写');
    } finally {
      rules.compiledPatterns()[1].fix = fix;
    }
    assert.equal(rules.compiledPatterns()[1].fix, fix);

    const bold = rules.thresholds.boldTotal;
    rules.thresholds.boldTotal = 999;
    try {
      assert.equal(require('./rules').thresholds.boldTotal, 999);
    } finally {
      rules.thresholds.boldTotal = bold;
    }
    assert.equal(rules.thresholds.boldTotal, 5);
  });

  test('HIGH_FREQ_WORDS/COLLOQUIAL/NEUTRAL 数组同样是活的（改动会进入下次编译）', () => {
    // The lazy compilers read these arrays on first call and cache the RegExp, so an
    // appended word only takes effect after _resetCache() — a second order surprise
    // for anyone treating the export as a snapshot.
    const words = rules.HIGH_FREQ_WORDS;
    const reBefore = rules.highFreqRegex();
    words.push('探针词');
    try {
      assert.equal(rules.highFreqRegex(), reBefore, 'cached RegExp ignores the new word');
      rules._resetCache();
      const reAfter = rules.highFreqRegex();
      assert.notEqual(reAfter, reBefore);
      reAfter.lastIndex = 0;
      assert.equal(reAfter.test('这里有个探针词'), true);
    } finally {
      words.pop();
      rules._resetCache();
    }
    assert.equal(rules.HIGH_FREQ_WORDS.length, 23);
    assert.notEqual(rules.highFreqRegex(), reBefore, 'rebuilt without the probe word');
    assert.equal(rules.highFreqRegex().test('探针词'), false);
  });
});
