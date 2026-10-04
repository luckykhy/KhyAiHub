'use strict';

/**
 * selectionPlainCopy.test.js — [DESIGN-ARCH-149] 选区复制 ANSI 卫生回归。
 *
 * 实测症状（2026-09-24 用户报告）：从 TUI 拖选带 markdown 着色的转录文本复制，
 * 粘贴出来是 `1m[36m…` / `[38;2;97;175;239m…` 残骸 —— ESC 字节被粘贴方丢弃，
 * SGR 参数变成可见 ASCII。
 *
 * 根因：markdown 渲染层（chalk 真彩）的着色进入 `_mainContentLines`，而
 * `extractText` 原样切片零剥离；`charColForDisplay` 把 SGR 参数字节当可见字符
 * 计宽（visWidth 对 ESC 本身计 0，但对 `[`/数字/`m` 计 1），带色行上高亮/取词
 * 还整体偏离指针。
 *
 * 修复：P1 换算跳过 CSI 序列（零宽）；P2 产出前经 utils/stripAnsi 剥净。
 * 回滚钩子：`{ansiAware:false}` / `{plain:false}`（缺省 = 修复态）。
 *
 * 运行：node --test tests/cli/tui/selectionPlainCopy.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  createSelection,
  beginSelection,
  extendSelection,
  endSelection,
  charColForDisplay,
  extractText,
} = require('../../../src/cli/tui/selection');
const { visWidth } = require('../../../src/cli/tui/wrapCell');

/** 模拟一次「按下 → 拖到 → 松手」的手势。 */
function drag(l1, c1, l2, c2) {
  let s = beginSelection(createSelection(), l1, c1);
  s = extendSelection(s, l2, c2);
  return endSelection(s);
}

/** 旧算法参照实现（修复前的 charColForDisplay，逐字节复刻）—— 钉回滚口径用。 */
function legacyCol(lineText, displayCol) {
  let w = 0;
  let i = 0;
  for (const ch of String(lineText)) {
    const cw = visWidth(ch);
    if (displayCol < w + cw) {
      return i;
    }
    w += cw;
    i += ch.length;
  }
  return String(lineText).length;
}

/** 纯文本上的「显示列 → 可见字符序号」（输入必须不含 ESC，作期望值参照）。 */
function plainIndexForCol(plain, col) {
  let w = 0;
  let k = 0;
  for (const ch of plain) {
    if (col < w + visWidth(ch)) {
      return k;
    }
    w += visWidth(ch);
    k++;
  }
  return plain.length;
}

/** chalk 真彩着色的真实形状（用户粘贴残骸的来源行）。 */
const HEADING = '\x1b[1m\x1b[36m三、五大陷阱（选择题就靠这些坑得分）\x1b[22m\x1b[39m';
const HEADING_PLAIN = '三、五大陷阱（选择题就靠这些坑得分）';
const ITEM = '\x1b[38;2;97;175;239m1.\x1b[39m \x1b[1m\x1b[38;2;229;192;123m概念偷换：问"增长率"给"增长量"';
const ITEM_PLAIN = '1. 概念偷换：问"增长率"给"增长量"';

test('PC-01 单行带色：extractText 产出不含任何 ESC / SGR 残片', () => {
  const s = drag(0, 0, 0, HEADING.length);
  const out = extractText([HEADING], s);
  assert.strictEqual(out, HEADING_PLAIN);
  assert.ok(!out.includes('\x1b'), '不得含 ESC 字节');
  assert.ok(!/\[[0-9;]*m/.test(out), '不得含可见 SGR 残片');
});

test('PC-02 跨行带色：逐行剥净、保留行间 \\n 与空行', () => {
  const lines = [HEADING, '', ITEM];
  const s = drag(0, 0, 2, ITEM.length);
  const out = extractText(lines, s);
  assert.strictEqual(out, HEADING_PLAIN + '\n\n' + ITEM_PLAIN);
});

test('PC-03 换算跳过行中 SGR：指针列对准可见字符的原文下标', () => {
  // 可见文本 "abcd"：a(0) b(1) [ESC[1m 占 2..5] c(6) d(7) [ESC[0m 8..10]
  const line = 'ab\x1b[1mcd\x1b[0m';
  assert.strictEqual(charColForDisplay(line, 0), 0);
  assert.strictEqual(charColForDisplay(line, 2), 6); // 第 2 列 → 'c' 的原文下标
  assert.strictEqual(charColForDisplay(line, 3), 7); // 第 3 列 → 'd'
});

test('PC-04 用户残骸形状：指针列 → 原文下标，切片剥净后 == 可见前缀', () => {
  // 行首序列占 0..17，'1'=18。指针第 0 列 → '1' 的原文下标 18。
  assert.strictEqual(charColForDisplay(ITEM, 0), 18);
  // ' ' 在可见第 2 列、原文下标 25（'1'=18, '.'=19, ESC[39m=20..24）。
  assert.strictEqual(charColForDisplay(ITEM, 2), 25);
  // 语义验收：从指针列取到行尾，剥净后 == 可见文本从该列起的前缀。
  for (const col of [0, 1, 2, 3, 4, 5, 8]) {
    const c = charColForDisplay(ITEM, col);
    const out = extractText([ITEM], drag(0, c, 0, ITEM.length));
    assert.strictEqual(
      out,
      ITEM_PLAIN.slice(plainIndexForCol(ITEM_PLAIN, col)),
      `displayCol=${col} 时取词错位`
    );
  }
});

test('PC-05 无 ESC 行走快路径：与回滚口径逐字节相同', () => {
  const line = '  · 央视网新闻频道 抓取结果为空';
  for (let c = 0; c <= 8; c++) {
    assert.strictEqual(charColForDisplay(line, c), legacyCol(line, c));
  }
});

test('PC-06 回滚钩子：ansiAware:false / plain:false 精确还原旧口径', () => {
  const line = 'ab\x1b[1mcd';
  // 旧口径由参照实现钉住（visWidth 对 ESC 计 0、对参数字节计 1，值随 string-width
  // 是否装上而不同 —— 所以断言「== 旧算法」而不是写死数字）。
  for (const c of [0, 1, 2, 3, 5]) {
    assert.strictEqual(charColForDisplay(line, c, { ansiAware: false }), legacyCol(line, c));
  }
  assert.strictEqual(charColForDisplay(line, 2), 6); // 新口径：'c' 的原文下标
  // 旧提取：原样保留（含半个序列）
  const s = drag(0, 0, 0, 3);
  assert.strictEqual(extractText([line], s, { plain: false }), 'ab\x1b');
  assert.strictEqual(extractText([line], s), 'ab');
});

test('PC-07 畸形输入不抛：null 行 / 空数组 / 非字符串行', () => {
  const s = drag(0, 0, 1, 2);
  assert.strictEqual(extractText(null, s), '');
  assert.strictEqual(extractText([], s), '');
  assert.strictEqual(extractText([null, undefined, 42], s), '\n');
  assert.strictEqual(charColForDisplay(null, 3), 0);
  assert.strictEqual(charColForDisplay('', 3), 0);
});

test('PC-08 指针拖过可见行尾：clamp 到行尾且 extract 不抛、产物干净', () => {
  const out = charColForDisplay(HEADING, 999);
  assert.strictEqual(out, HEADING.length); // 旧语义保留：原文长度（含序列）
  const s = drag(0, 0, 0, out);
  assert.strictEqual(extractText([HEADING], s), HEADING_PLAIN);
});

test('PC-09 端到端：跨行拖选复制出纯文本（用户症状复现）', () => {
  const lines = [HEADING, ITEM];
  // 从标题第 2 列（'、'）拖到条目行第 5 列（'念'）—— 两端都带 SGR
  const c1 = charColForDisplay(HEADING, 2);
  const c2 = charColForDisplay(ITEM, 5);
  const s = drag(0, c1, 1, c2);
  const out = extractText(lines, s);
  assert.ok(!out.includes('\x1b'), '产物不得含 ESC');
  assert.strictEqual(out, HEADING_PLAIN.slice(1) + '\n' + ITEM_PLAIN.slice(0, 4));
});
