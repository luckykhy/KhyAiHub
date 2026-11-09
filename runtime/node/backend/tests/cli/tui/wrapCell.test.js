'use strict';

// wrapCell — single wrap + row-counting source (DESIGN-ARCH-103 P0-4 / H6).
// `node --test` (jest is broken under rtk for this tree).

const test = require('node:test');
const assert = require('node:assert');
const {
  wrapCell,
  wrapCellIncremental,
  visualRows,
  visualRowsUnwrapped,
  fitBorder,
  visWidth,
} = require('../../../src/cli/tui/wrapCell');

// ── H6 property: billing === render (visualRows === wrapCell().length) ───────
test('visualRows(t,w) === wrapCell(t,w).length over 30 random-ish combos', () => {
  const samples = [
    'hello world',
    '你好世界hello',
    'a b c d e f g',
    '❤️🚀🚀',
    'x'.repeat(500),
    '中文，。！？标点禁则测试',
    '',
    'a\nb\nc',
    '短',
    'word'.repeat(200),
  ];
  for (let i = 0; i < 30; i++) {
    const t = samples[i % samples.length];
    const w = [0, 1, 3, 4, 8, 10, 40, 80, 200][i % 9];
    assert.equal(visualRows(t, w), wrapCell(t, w).length, `t=${JSON.stringify(t).slice(0, 20)} w=${w}`);
  }
});

// ── wrapping semantics ────────────────────────────────────────────────────────
test('wrapCell: short text fits → single segment', () => {
  assert.deepEqual(wrapCell('abc', 3), ['abc']);
  assert.deepEqual(wrapCell('abc', 4), ['abc']);
});

// BUG-115: broad CSI param family (`:` truecolor, `>`, ESC-intermediate) must stay
// atomic/zero-width. Old ESC_SEQ_RE class `[0-9;?]` split them → digits leaked.
test('wrapCell: colon-truecolor / private CSI / ESC-intermediate stay atomic', () => {
  const E = String.fromCharCode(27);
  const cases = [
    'a' + E + '[38:2:255:128:0mBCDEFGH' + E + '[0m',
    'AB' + E + '[>cCDEF',
    'AB' + E + '(B' + E + '[0mCDEF',
  ];
  for (const s of cases) {
    const segs = wrapCell(s, 8);
    assert.equal(segs.length, 1, 'escape stays atomic (zero-width) -> single row');
    assert.equal(segs.join(''), s, 'no characters dropped');
  }
});

test('wrapCell: hard wrap at display-width boundary (no word split of CJK)', () => {
  const segs = wrapCell('abracadabra', 4);
  assert.ok(segs.every((s) => visWidth(s) <= 4 || visWidth(s) > 4 === visWidth(s)), 'each segment <= cap unless single char wider');
  assert.equal(segs.join(''), 'abracadabra', 'no characters dropped');
});

test('wrapCell: CJK double-width counts correctly (你好 = 4 cols)', () => {
  assert.equal(visWidth('你好'), 4);
  const segs = wrapCell('你好世界abc', 10);
  // 你好世界 = 8 cols, +abc = 11 > 10 → wraps after the CJK run
  assert.equal(segs.join(''), '你好世界abc', 'no characters dropped');
  assert.ok(segs.every((s) => visWidth(s) <= 10 || visWidth(s) === visWidth(s) && s.length === 1 && visWidth(s) > 10),
    'segments respect the cap');
});

test('wrapCell: surrogate pairs are never split in half', () => {
  const segs = wrapCell('a❤️b', 4);
  // No orphaned high surrogate may appear: every segment must be a valid string
  // whose re-join equals the original.
  assert.equal(segs.join(''), 'a❤️b');
  for (const s of segs) {
    assert.ok(!/[lead-surrogate]$/u.test(s));
  }
});

test('wrapCell: width<=0 → logical lines, no wrapping', () => {
  assert.deepEqual(wrapCell('abcd', 0), ['abcd']);
  assert.deepEqual(wrapCell('a\nb', -5), ['a', 'b']);
});

test('visualRowsUnwrapped: logical lines for pre-truncated content', () => {
  assert.equal(visualRowsUnwrapped('a\nb\nc'), 3);
  assert.equal(visualRowsUnwrapped(''), 0);
  assert.equal(visualRowsUnwrapped('x'), 1);
});

// ── fitBorder (H4: top+bottom from one function → equal width) ───────────────
test('fitBorder: display width exactly equals the requested width', () => {
  for (const w of [40, 79, 80, 119, 120, 121, 200]) {
    const top = fitBorder(w, { left: '╭', right: '╮' });
    const bot = fitBorder(w, { left: '╰', right: '╯' });
    assert.equal(visWidth(top), w, `top @${w}`);
    assert.equal(visWidth(bot), w, `bottom @${w}`);
  }
});

test('fitBorder: degenerate width never goes negative', () => {
  assert.equal(visWidth(fitBorder(2, { left: '╭', right: '╮' })), 2);
  assert.equal(visWidth(fitBorder(1)), 1);
  assert.equal(visWidth(fitBorder(0)), 0);
});

test('fitBorder: busy gutter switches mid char but keeps width', () => {
  assert.equal(visWidth(fitBorder(20, { left: '╭', right: '╮', busy: true })), 20);
  assert.ok(fitBorder(20, { left: '╭', right: '╮', busy: true }).includes('╌'));
  assert.ok(!fitBorder(20, { left: '╭', right: '╮' }).includes('╌'));
});

// ── ANSI awareness (BUG-32: a wrap point must never fall inside a sequence) ──
const ANSI_CODE = '未跟踪的本地密钥文件不会出现在 \x1b[36mgit status\x1b[39m 里，这一句要足够长以便越过任何合理的列宽上限。';
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
// A row whose trailing ESC has no terminating final byte = a sawn sequence.
function cutSequences(rows) {
  return rows.filter((s) => {
    const at = s.lastIndexOf('\x1b[');
    return at >= 0 && !/\x1b\[[0-9;?]*[ -/]*[@-~]/.test(s.slice(at));
  });
}

test('wrapCell: never cuts an ANSI sequence, at any width (BUG-32)', () => {
  for (let w = 1; w <= 40; w++) {
    const segs = wrapCell(ANSI_CODE, w);
    assert.deepEqual(cutSequences(segs), [], `width ${w} produced a sawn escape sequence`);
    // Re-joining must reproduce the input byte-for-byte apart from the SGR
    // close/reopen the splitter legitimately injects.
    assert.equal(stripAnsi(segs.join('')), stripAnsi(ANSI_CODE), `width ${w} dropped visible text`);
    for (const s of segs) {
      const visible = stripAnsi(s).length;
      assert.ok(
        visWidth(s) <= w || visible <= 1,
        `width ${w}: row over the cap with more than one glyph: ${JSON.stringify(s)}`
      );
    }
  }
});

test('wrapCell: escape bytes consume no display width', () => {
  // 'aaaa ' is 5 columns; the 9-column colored word then fits exactly in 14,
  // proving the 9 bytes of `\x1b[36m` cost nothing.
  assert.deepEqual(wrapCell('aaaa \x1b[36mbbbbbbbbb\x1b[39m', 14), ['aaaa \x1b[36mbbbbbbbbb\x1b[39m']);
  assert.deepEqual(wrapCell('aaaa \x1b[36mbbbbbbbbb\x1b[39m', 13), [
    'aaaa \x1b[36mbbbbbbbb\x1b[0m',
    '\x1b[36mb\x1b[39m',
  ]);
});

test('wrapCell: a style spanning the wrap point closes and reopens', () => {
  const segs = wrapCell('aaaa \x1b[36mbbbbbbbbb\x1b[39m', 10);
  assert.deepEqual(segs, [
    'aaaa \x1b[36mbbbbb\x1b[0m',
    '\x1b[36mbbbb\x1b[39m',
  ], 'the split row must not leak color past its end; the next one reopens it');
});

test('wrapCell: H6 billing holds for ANSI text too', () => {
  for (const w of [1, 7, 13, 20, 40]) {
    assert.equal(visualRows(ANSI_CODE, w), wrapCell(ANSI_CODE, w).length);
  }
});

// ── 增量折行:与全量逐行等价(这是增量的**前提**,不是「差不多」)────────────
// 增量的全部价值都押在「结果与 wrapCell 逐字节相同」上。只要这里有一条不成立,
// 流式正文就会在某一帧突然重排 —— 所以按多种切分粒度(含劈开代理对、劈开转义序列)
// 逐条比对,而不是抽一个幸运样本。
test('wrapCellIncremental === wrapCell, 逐行相同(纯文本/CJK/emoji/换行/ANSI/OSC)', () => {
  const E = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const ST = E + '\\';
  const CORPUS = [
    'hello world, plain ascii sentence that goes on and on.',
    '根据上一轮的反馈，wrapCell 的显示宽度计量在 CJK 上按 2 列计，emoji 与代理对一并处理。',
    '❤️🚀🚀 mixed with ascii so surrogate pairs land mid-chunk.',
    'a\nb\n\nc\n',
    ANSI_CODE,
    '```js\nfor (const seg of wrapCell(text, cols)) {}\n```\n\n',
    '- 每帧重新折行\n- memo deps 含 streaming\n\n',
    '',
    'x',
    E + '[36mcolored' + E + '[39m and ' + E + '[1mbold' + E + '[22m across rows',
    // OSC:续扫判据的真实失守形态。ESC_SEQ_RE 的 OSC 分支靠后面的终结符定长度,
    // 截断时必然失配并退回两字节 dispatch 分支 —— 语料里没有这些,缺陷就溜过去了。
    E + ']0;title' + BEL + 'abc',
    E + ']2;window title here' + ST + 'body text after',
    // OSC 体内嵌 ESC(OSC 8 超链接正是这个形态):尾部 ESC 自己匹配得上,
    // 越界的是更外层的 OSC 起点,只查尾部一个会漏。
    'x' + E + ']8;;http://example.com' + E + '[36mlink' + E + '[0m' + BEL + 'tail',
    'a' + E + ']8;;u' + E + '[36mb' + BEL + 'c',
    // ESC 出现在非行首 + 无终结符的裸 ESC。
    'ESC-not-at-line-start ' + E + '[31mred' + E + '[0m done',
    'bare ' + E + ' esc mid sentence',
    E + '(B' + E + '[mcharset' + E + '7' + E + '8' + E + '^' + E + '$ designators',
  ];
  // 切分粒度刻意不整除行宽:逼出「上一帧最后一行 + 新尾巴合并重折」那条路径。
  const CHUNKS = [1, 2, 3, 5, 7, 13, 64];
  for (const text of CORPUS) {
    for (const width of [1, 4, 10, 40, 80]) {
      const full = wrapCell(text, width);
      for (const step of CHUNKS) {
        let state = null;
        let seen = '';
        for (let i = 0; i <= text.length; i += step) {
          seen = text.slice(0, i);
          const got = wrapCellIncremental(state, seen, width);
          assert.deepEqual(
            got.lines,
            wrapCell(seen, width),
            `cols=${width} step=${step} prefix=${i} text=${JSON.stringify(text).slice(0, 40)}`
          );
          state = got.state;
        }
        assert.deepEqual(wrapCellIncremental(state, text, width).lines, full);
      }
    }
  }
});

// 上面那条等价性用例的**定点回归**:OSC 的匹配长度取决于后文还有没有终结符,
// 续扫判据若在截断的 prev 上问「这个 ESC 能否匹成完整序列」,OSC 分支必然失配并
// 退回两字节 dispatch 分支 → 判成干净 → 从 OSC 体内续扫,行数当场分叉。
test('wrapCellIncremental: OSC 被 chunk 劈开时不从 OSC 体内续扫', () => {
  const E = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const t = E + ']0;title' + BEL + 'abc';
  let state = null;
  for (let i = 1; i <= t.length; i++) {
    const got = wrapCellIncremental(state, t.slice(0, i), 1);
    assert.deepEqual(got.lines, wrapCell(t.slice(0, i), 1), `prefix=${i}`);
    state = got.state;
  }
  // OSC 8:体内还嵌了 CSI,尾部 ESC 自身匹配得上,越界的是外层 OSC 起点。
  const t2 = 'a' + E + ']8;;u' + E + '[36mb' + BEL + 'c';
  let st2 = null;
  for (let i = 1; i <= t2.length; i++) {
    const got = wrapCellIncremental(st2, t2.slice(0, i), 1);
    assert.deepEqual(got.lines, wrapCell(t2.slice(0, i), 1), `prefix=${i}`);
    st2 = got.state;
  }
});

// state 是一次性的:_scan 原地改写 state.run,续过一次之后那个 state 就不再对应
// 「扫到 state.text.length 为止」。本例把它钉住 —— 复用**不报错**,只是静默把上一次的
// 尾巴也带进来(TAIL1TAIL2),所以调用点必须每帧消费一次就换新。
test('wrapCellIncremental: state 续扫一次后即失效,复用会静默带出上一次的尾巴', () => {
  const base = 'abcdefghij'.repeat(20);
  const state = wrapCellIncremental(null, base, 20).state;

  const first = wrapCellIncremental(state, base + 'TAIL1', 20);
  assert.deepEqual(first.lines, wrapCell(base + 'TAIL1', 20), '第一次消费必须与全量一致');

  const reused = wrapCellIncremental(state, base + 'TAIL2', 20);
  assert.notDeepEqual(reused.lines, wrapCell(base + 'TAIL2', 20),
    '复用已消费的 state 会静默出错 —— 这正是 JSDoc 里「一次性」那句要拦的写法');
  assert.ok(reused.lines[reused.lines.length - 1].includes('TAIL1'),
    '上一帧的尾巴被带进了这一帧');
});

test('wrapCellIncremental: 文本被替换/缩短/换列宽时退回全量,结果仍与全量相同', () => {
  const a = '第一条消息 '.repeat(20);
  const b = '第二条完全不同的内容 '.repeat(20);
  // 换 turn:前缀不再匹配
  let st = wrapCellIncremental(null, a, 20).state;
  assert.deepEqual(wrapCellIncremental(st, b, 20).lines, wrapCell(b, 20));
  // rewind:文本变短
  st = wrapCellIncremental(null, a, 20).state;
  assert.deepEqual(wrapCellIncremental(st, a.slice(0, 10), 20).lines, wrapCell(a.slice(0, 10), 20));
  // 缩放窗口:列宽变了
  st = wrapCellIncremental(null, a, 20).state;
  assert.deepEqual(wrapCellIncremental(st, a + '尾巴', 30).lines, wrapCell(a + '尾巴', 30));
  // 无 cols 的兜底口径与 wrapCell 一致
  assert.deepEqual(wrapCellIncremental(null, 'a\nb', 0).lines, wrapCell('a\nb', 0));
  assert.deepEqual(wrapCellIncremental(null, 'abcdef', 0).lines, wrapCell('abcdef', 0));
});

// ── visWidth fallback safety ─────────────────────────────────────────────────
test('visWidth: emoji width 2, CJK 2, ASCII 1', () => {
  assert.equal(visWidth('a'), 1);
  assert.equal(visWidth('❤️'), 2);
  assert.equal(visWidth('你'), 2);
});
