'use strict';

/**
 * claimNegation.test.js — 钉死「否定守卫」纯叶子的三扇窗口、门控 off 词表与正则状态不变量。
 *
 * 为什么这支套件必须存在：claimReconciler 用「动词关键词」从转发的助手正文里抽动作声称，
 * 而关键词只匹动词、无视紧邻否定 —— 「我没有删除任何文件」会被读成「已删除」，
 * 反过来把真声称与假声称一起推向同一个判定。本叶子是那层修复的全部逻辑，
 * 它的正确性完全押在三件事上：窗口宽度、off 词表、以及「绝不污染被冻结词库的 RegExp 状态」。
 * 三件事任何一件漂移，都会静默改变门的行为，所以逐条钉死。
 *
 * 实测更正（与源码注释/上游直觉不同处，按真实语义钉死）：
 *   · 空字符串 `''` **不在** off 词表里 → 守卫仍然为 ON（`v !== undefined` 成立、`has('')` 不成立）。
 *   · 窗2 的 4 字符窗口对多字否定做的是**子串搜索**（正则未锚定），所以否定词与动词最多隔 2 字，
 *     隔 3 字起漏检；英文窗口的真实上限是「动词前 16 个字符」，且受 `\b` 约束：否定词距动词
 *     16 字符内可测，17 字符起永久漏检 —— 这两处都是本叶子最明确的假阴性面（见 boundary 用例）。
 *   · 单字否定只看紧贴的 1 个字符：`不 修改`（中间一个空格）即漏检。
 *   · `_firstUnnegatedMatch` 的克隆只发生在 negOn=true 分支；negOn=false 直接用原正则 `re.exec`，
 *     若调用方传入**全局**正则，原正则的 lastIndex 会被推进（词库当前全是非全局，故无害）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('./claimNegation');
const { CLAIM_FAMILIES } = require('./claimReconciler');

const EDIT_CLAIM = CLAIM_FAMILIES.find((f) => f.family === 'edit').claim;

/** 临时改 process.env 并在 finally 如实还原（含「原本未设置」这一态）。 */
function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    if (had) {
      process.env[name] = prev;
    } else {
      delete process.env[name];
    }
  }
}

// ── 导出面 ────────────────────────────────────────────────────────────────────

test('叶子恰导出 3 个内部符号，不含任何公共面', () => {
  assert.deepStrictEqual(Object.keys(leaf).sort(), [
    '_firstUnnegatedMatch',
    '_isNegatedClaim',
    '_isNegationGuardEnabled',
  ]);
});

// ── 门控 KHY_CLAIM_NEGATION_GUARD ─────────────────────────────────────────────

test('_isNegationGuardEnabled 注入 env 未设该键时为 ON（默认开）', () => {
  assert.strictEqual(leaf._isNegationGuardEnabled({}), true);
});

test('_isNegationGuardEnabled 的 off 词表恰为 0/false/off/no 四个值', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      leaf._isNegationGuardEnabled({ KHY_CLAIM_NEGATION_GUARD: off }),
      false,
      `off 词表应包含 ${off}`
    );
  }
});

test('_isNegationGuardEnabled 比较前 trim + toLowerCase，故 " OFF "/"False" 同样关闭守卫', () => {
  assert.strictEqual(leaf._isNegationGuardEnabled({ KHY_CLAIM_NEGATION_GUARD: ' OFF ' }), false);
  assert.strictEqual(leaf._isNegationGuardEnabled({ KHY_CLAIM_NEGATION_GUARD: 'False' }), false);
  assert.strictEqual(leaf._isNegationGuardEnabled({ KHY_CLAIM_NEGATION_GUARD: '\tNo\n' }), false);
});

test('_isNegationGuardEnabled 词表外取值一律保持 ON：OFF2/nope/1/TRUE 都不关闭', () => {
  for (const on of ['OFF2', 'nope', '1', 'TRUE', 'disabled', 'falsey']) {
    assert.strictEqual(
      leaf._isNegationGuardEnabled({ KHY_CLAIM_NEGATION_GUARD: on }),
      true,
      `${on} 不在 off 词表内，守卫必须仍为 ON`
    );
  }
});

test('_isNegationGuardEnabled 对空字符串保持 ON（实测："" 不在 off 词表，不是关闭值）', () => {
  assert.strictEqual(leaf._isNegationGuardEnabled({ KHY_CLAIM_NEGATION_GUARD: '' }), true);
  assert.strictEqual(leaf._isNegationGuardEnabled({ KHY_CLAIM_NEGATION_GUARD: '   ' }), true);
});

test('_isNegationGuardEnabled 数值 0 经 String() 后仍关闭守卫', () => {
  assert.strictEqual(leaf._isNegationGuardEnabled({ KHY_CLAIM_NEGATION_GUARD: 0 }), false);
});

test('_isNegationGuardEnabled env 传 null/undefined 时回落到 process.env', () => {
  withEnv('KHY_CLAIM_NEGATION_GUARD', 'off', () => {
    assert.strictEqual(leaf._isNegationGuardEnabled(), false);
    assert.strictEqual(leaf._isNegationGuardEnabled(null), false);
    assert.strictEqual(leaf._isNegationGuardEnabled(undefined), false);
  });
  withEnv('KHY_CLAIM_NEGATION_GUARD', undefined, () => {
    assert.strictEqual(leaf._isNegationGuardEnabled(null), true);
    assert.strictEqual(leaf._isNegationGuardEnabled(), true);
  });
});

test('_isNegationGuardEnabled 读取 env 抛异常时 fail-OPEN 为 ON（catch 分支恒 true）', () => {
  const boom = {
    get KHY_CLAIM_NEGATION_GUARD() {
      throw new Error('poisoned env proxy');
    },
  };
  assert.strictEqual(leaf._isNegationGuardEnabled(boom), true);
});

// ── _isNegatedClaim 三扇窗口 ──────────────────────────────────────────────────

test('_isNegatedClaim 窗1：动词紧贴的单字否定（未/没/无/别/不）判为否定', () => {
  const cases = [
    ['未修改文件', '修改', true],
    ['没删除文件', '删除', true],
    ['无需修改', '修改', true],
    ['别修改', '修改', true],
    ['不修改', '修改', true],
    ['我修改了文件', '修改', false],
  ];
  for (const [text, needle, want] of cases) {
    const idx = text.indexOf(needle);
    assert.ok(idx >= 0, `夹具必须含 ${needle}`);
    assert.strictEqual(leaf._isNegatedClaim(text, idx), want, `${text} @${idx} 应为 ${want}`);
  }
});

test('_isNegatedClaim 窗1 只看紧贴的 1 个字符：否定字与动词间隔一个空格即漏检', () => {
  const idx = '不 修改'.indexOf('修改');
  assert.strictEqual(idx, 2);
  // 紧贴字符是空格 → 窗1 不命中；窗2 的 4 字窗口 '不 ' 也不含多字否定词
  assert.strictEqual(leaf._isNegatedClaim('不 修改', idx), false);
  // 对照：去掉空格，同一否定字立刻命中（证明上一行不是夹具失效）
  assert.strictEqual(leaf._isNegatedClaim('不修改', 1), true);
});

test('_isNegatedClaim 窗2：4 字符窗口内的多字中文否定（没有/无需/尚未）判为否定', () => {
  assert.strictEqual(leaf._isNegatedClaim('没有修改', 2), true);
  assert.strictEqual(leaf._isNegatedClaim('尚未提交', 2), true);
  assert.strictEqual(leaf._isNegatedClaim('从未部署', 2), true);
  assert.strictEqual(leaf._isNegatedClaim('并未修改', 2), true);
  assert.strictEqual(leaf._isNegatedClaim('毫无修改', 2), true);
  // 对照：同一句去掉否定词 → 不是否定（证明上一行不是因为「匹配不到」而 false）
  assert.strictEqual(leaf._isNegatedClaim('接着修改', 2), false);
});

test('_isNegatedClaim 窗2 的真实容量：4 字窗口是「子串搜索」而非锚定，否定字与动词最多隔 2 字', () => {
  // 实测：_NEG_NEAR_RE 未加锚，只要在 4 字窗口内出现即命中 →
  //   间隔 0 字（没有修改）与间隔 2 字（没有另外修改）都命中，间隔 3 字起彻底漏检。
  const gap0 = '没有修改';
  const gap2 = '没有另外修改';
  const gap3 = '没有再另外修改';
  assert.strictEqual(leaf._isNegatedClaim(gap0, gap0.indexOf('修改')), true);
  assert.strictEqual(leaf._isNegatedClaim(gap2, gap2.indexOf('修改')), true);
  assert.strictEqual(
    leaf._isNegatedClaim(gap3, gap3.indexOf('修改')),
    false,
    '窗口外的多字否定不被识别 —— 钉住 4 字窗口上限'
  );
  // 对照：同一句去掉否定词 → 不是否定（证明上一行不是因为整句匹配不到而 false）
  assert.strictEqual(leaf._isNegatedClaim('接着修改', 2), false);
});

test('_isNegatedClaim 窗3：英文否定在动词前 16 字符内判为否定', () => {
  const yes = [
    'the file was not modified',
    'the file was never modified',
    'without being modified',
    "the file wasn't modified",
    'the file has not been changed',
  ];
  for (const s of yes) {
    const i = s.indexOf(s.match(/\b(modified|changed)\b/)[0]);
    assert.ok(i > 0, `夹具 ${s} 须含动词`);
    assert.strictEqual(leaf._isNegatedClaim(s, i), true, s);
  }
  assert.strictEqual(leaf._isNegatedClaim('modified the file', 0), false);
  assert.strictEqual(leaf._isNegatedClaim('the file was modified', 13), false);
});

test('_isNegatedClaim 窗3 的真实边界：not 距动词 16 字符内命中、17 字符起永久漏检（已注册的假阴性面）', () => {
  const inside = 'not' + '.'.repeat(13) + 'modified'; // 前文恰 16 字符
  const outside = 'not' + '.'.repeat(14) + 'modified'; // 前文 17 字符
  const iIdx = inside.indexOf('modified');
  const oIdx = outside.indexOf('modified');
  assert.strictEqual(iIdx, 16);
  assert.strictEqual(oIdx, 17);
  assert.strictEqual(leaf._isNegatedClaim(inside, iIdx), true);
  assert.strictEqual(
    leaf._isNegatedClaim(outside, oIdx),
    false,
    '窗口外（17 字符）的否定不被识别 —— 钉住窗口上限'
  );
  // 更远的英文否定（30+ 字符）同样漏检
  const far = 'we previously did nothing at all here and the file was modified';
  assert.strictEqual(leaf._isNegatedClaim(far, far.indexOf('modified')), false);
});

test('_isNegatedClaim 词法边界：非词字符填充才构成 \\b，字母填充会让 not 不再命中', () => {
  // 距动词 15 字符（在窗内），但 'not' 与后续字母粘连 → \b 不成立 → 漏检
  assert.strictEqual(leaf._isNegatedClaim('notaaaaaaaaaaaaa' + 'modified', 16), false);
  assert.strictEqual(leaf._isNegatedClaim('not.............' + 'modified', 16), true);
});

test('_isNegatedClaim 对畸形入参一律返回 false 且不抛', () => {
  assert.strictEqual(leaf._isNegatedClaim(null, 0), false);
  assert.strictEqual(leaf._isNegatedClaim(undefined, 0), false);
  assert.strictEqual(leaf._isNegatedClaim(5, 0), false);
  assert.strictEqual(leaf._isNegatedClaim({}, 0), false);
  assert.strictEqual(leaf._isNegatedClaim('未修改', -1), false);
  assert.strictEqual(leaf._isNegatedClaim('未修改', NaN), false);
  assert.strictEqual(leaf._isNegatedClaim('未修改', undefined), false);
  assert.strictEqual(leaf._isNegatedClaim('未修改', {}), false);
  // idx=0 无左侧窗口 → 永不判为否定
  assert.strictEqual(leaf._isNegatedClaim('修改文件', 0), false);
});

test('_isNegatedClaim 读取越界的 idx 不抛，按无否定处理', () => {
  assert.strictEqual(leaf._isNegatedClaim('未修改', 9999), false);
  assert.strictEqual(leaf._isNegatedClaim('未修改', Infinity), false);
});

// ── _firstUnnegatedMatch ──────────────────────────────────────────────────────

test('_firstUnnegatedMatch negOn=false 逐字节回退为 re.exec 首匹配（否定也算）', () => {
  const text = '没有修改，之后修改了文件';
  const m = leaf._firstUnnegatedMatch(EDIT_CLAIM, text, false);
  assert.ok(m);
  assert.strictEqual(m.index, 2);
  assert.strictEqual(m[0], '修改');
});

test('_firstUnnegatedMatch negOn=true 跳过被否定的首匹配，返回第一处非否定声称', () => {
  const text = '没有修改，之后修改了文件';
  const m = leaf._firstUnnegatedMatch(EDIT_CLAIM, text, true);
  assert.ok(m);
  assert.strictEqual(m.index, 7);
  assert.strictEqual(m[0], '修改了文件');
  // 对照同一夹具关守卫 → 落在被否定的第 2 处（证明上一行的 7 不是巧合）
  assert.strictEqual(leaf._firstUnnegatedMatch(EDIT_CLAIM, text, false).index, 2);
});

test('_firstUnnegatedMatch negOn=true 全文皆否定 → null', () => {
  assert.strictEqual(leaf._firstUnnegatedMatch(EDIT_CLAIM, '没有修改，也未编辑文件', true), null);
  assert.strictEqual(leaf._firstUnnegatedMatch(EDIT_CLAIM, '今天天气很好', true), null);
  assert.strictEqual(leaf._firstUnnegatedMatch(EDIT_CLAIM, '今天天气很好', false), null);
});

test('_firstUnnegatedMatch 绝不改动被冻结词库里的原正则状态：反复调用 lastIndex 恒 0、结果恒等', () => {
  const text = '没有修改，之后修改了文件';
  const first = leaf._firstUnnegatedMatch(EDIT_CLAIM, text, true);
  assert.strictEqual(EDIT_CLAIM.lastIndex, 0, '原正则 lastIndex 必须仍为 0');
  for (let i = 0; i < 5; i += 1) {
    const again = leaf._firstUnnegatedMatch(EDIT_CLAIM, text, true);
    assert.strictEqual(again.index, first.index, `第 ${i} 次重复调用结果漂移`);
    assert.strictEqual(again[0], first[0]);
    assert.strictEqual(EDIT_CLAIM.lastIndex, 0);
  }
  assert.strictEqual(EDIT_CLAIM.global, false, '词库正则当前非全局，克隆分支才可能不污染源');
});

test('_firstUnnegatedMatch 的零宽守卫确实被执行：前瞻正则逐位空匹配不死循环', () => {
  const text = '没有修改，未修改，修改';
  const re = /(?=修改)/g;
  const m = leaf._firstUnnegatedMatch(re, text, true);
  assert.ok(m, '必须在有限步内返回');
  assert.strictEqual(m.index, 9); // 前两处（2/6）被否定，第三处非否定
  assert.strictEqual(m[0], ''); // 零宽匹配
  // 实测：exec 对零宽匹配**不会**自动推进 lastIndex（上面 pairs 恒等），
  // 所以 claimNegation.js:69-71 的 `lastIndex += 1` 是必需的、不可删除的守卫。
  assert.strictEqual(re.lastIndex, 0, '原前瞻正则同样不得被污染');
});

test('_firstUnnegatedMatch 纯空匹配正则在首位置即返回，不挂起', () => {
  const re = /x*/g;
  const m = leaf._firstUnnegatedMatch(re, 'aaa', true);
  assert.ok(m);
  assert.strictEqual(m.index, 0);
  assert.strictEqual(m[0], '');
  assert.strictEqual(re.lastIndex, 0);
});

test('已注册偏差：negOn=false 分支直接用原正则，若传入全局正则则其 lastIndex 被推进', () => {
  const text = '没有修改，之后修改了文件';
  const G = /修/g;
  const a = leaf._firstUnnegatedMatch(G, text, false);
  const b = leaf._firstUnnegatedMatch(G, text, false);
  assert.strictEqual(a.index, 2);
  assert.strictEqual(b.index, 7, '回退分支不克隆 → 有状态；词库当前全为非全局故实际无害');
  assert.strictEqual(G.lastIndex, 8);
});

test('_firstUnnegatedMatch 对畸形文本不抛：exec 把 null 强转为字符串 "null" 后无匹配', () => {
  assert.strictEqual(leaf._firstUnnegatedMatch(EDIT_CLAIM, '', true), null);
  assert.strictEqual(leaf._firstUnnegatedMatch(EDIT_CLAIM, null, false), null);
  assert.strictEqual(leaf._firstUnnegatedMatch(EDIT_CLAIM, null, true), null);
  assert.strictEqual(leaf._firstUnnegatedMatch(EDIT_CLAIM, undefined, true), null);
});
