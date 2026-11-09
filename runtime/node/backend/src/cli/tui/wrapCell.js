'use strict';

/**
 * wrapCell — the SINGLE wrap + row-counting source (DESIGN-ARCH-103 P0-4 / H6).
 *
 * The historical bug class: components WRAPPED text one way and ESTIMATED its
 * row count another way ("branch-mirrored same source" by convention). When a
 * branch was added or the width changed, the estimate drifted from the render
 * and Ink erased the wrong number of rows → the resize ghosting. The fix is
 * CONSTRUCTIVE: rendering and billing both call these same functions, so they
 * cannot diverge.
 *
 * - wrapCell(text, width): grapheme/CJK/emoji-aware wrapping. Width metering
 *   is display width (CJK = 2, combining marks = 0, emoji = 2), not code-unit
 *   length. Width <= 0 → one segment per line (no wrapping).
 * - visualRows(text, width): === wrapCell(text, width).length (H6). Use it for
 *   ANY row-budget accounting of wrapped content.
 * - visualRowsUnwrapped(text): logical-line count (split on \n). Use it when
 *   the content is rendered UNWRAPPED — e.g. tool preview lines that are
 *   pre-truncated to one visual row each (the ToolLines folding model, 079
 *   §12.5 "1 source row = 1 visual row").
 * - clipCell(text, width): one visual row, cut with '…' instead of wrapped.
 *   For content whose contract IS a single row (pickers, sidebar rows) — where
 *   wrapping would inflate frame height rather than show more.
 * - pickerRowBudget / pickerPageRows: the two budgets a picker needs to stay
 *   inside the terminal — columns left for one clipped row, and how many rows
 *   the list may take given the terminal height. Both meter through this file
 *   so a picker can never bill a row differently from how it renders.
 * - fitBorder(width, {left,right,mid,busy}): a border line whose DISPLAY width
 *   is exactly `width`. Top and bottom borders must both come from this
 *   function so they are equal-width by construction (H4).
 */

let _stringWidth = null;
function sw() {
  if (_stringWidth === null) {
    try {
      const m = require('string-width');
      // string-width@5 is ESM: CJS require() yields the namespace
      // ({ default: fn }) — unwrap it.
      _stringWidth = typeof m === 'function' ? m : m.default;
      if (typeof _stringWidth !== 'function') {
        _stringWidth = false;
      }
    } catch {
      _stringWidth = false;
    }
  }
  return _stringWidth;
}

/**
 * Display width of a string (CJK=2, combining=0).
 *
 * 度量口径走共享底座 utils/text/width（显示宽度的单一真源）：它有 string-width 快路径，
 * 也有**正确的**手工 CJK 回退（宽字符 +2）。
 *
 * 原来这里自己实现了一份，失败时退回 `String(s).length` —— 那是**字符数**，不是显示列：
 * 中文一字两列，于是「按 80 显示列预算裁剪」实际放出了 160 列，截断点也随之落错。
 * 更糟的是 string-width 是 ESM，jest 的 require 拿不到它 ⇒ 测试环境正好走进这条错回退，
 * 于是「中文长消息不超过 80 显示列」这类断言全红，而生产环境（require 得通）看不出来 ——
 * 一份只在测试里显形的度量错误。
 */
function visWidth(s) {
  const text = String(s == null ? '' : s);
  try {
    const { displayWidth } = require('../../utils/text/width');
    const n = displayWidth(text);
    if (Number.isFinite(n)) {
      return n;
    }
  } catch {
    /* 底座不可用 → 退回本地实现 */
  }
  const w = sw();
  if (w) {
    try {
      const n = w(text);
      return Number.isFinite(n) ? n : text.length;
    } catch {
      /* fall through */
    }
  }
  return text.length;
}

/**
 * One terminal escape sequence at the current offset, matched as a unit.
 * CSI (`ESC [ params intermediates final`), OSC (`ESC ] … BEL|ST`), the
 * ESC-with-intermediates dispatches (e.g. `ESC ( B` charset designation) and
 * the two-byte ESC dispatches. These consume zero display columns and are the
 * shapes the terminal itself consumes — nothing inside one is a legal break
 * point, and metering their bytes as printable inflates the row width.
 *
 * CSI **parameter bytes** are the full ECMA-48 range `0x30–0x3F`
 * (`[0-9:;<=>?]`), not just digits/`;`/`?`: newer tooling and pasted model
 * output emit colon-separated truecolor SGR (`ESC [ 38:2:R:G:B m`) and private
 * params (`ESC [ > c`), which the narrower class used to split mid-sequence —
 * the trailing digits then got metered as printable and wrapped onto screen as
 * literal garbage (same family as BUG-32). The intermediate branch
 * `[ -/]+[@-~]` requires ≥1 intermediate byte (0x20–0x2F) before the final, so
 * a lone `ESC h` still falls through and keeps `h` printable.
 *
 * Sticky (`y`) so the scan stays linear on escape-heavy input.
 */
const ESC_SEQ_RE = /\x1b(?:\[[0-9:;<=>?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\)|[ -/]+[@-~]|[@-Z\\-_])/y;
/** Close everything a row might still have open at a wrap point. */
const SGR_OFF = '\x1b[0m';

/**
 * Attribute group an SGR parameter string writes. A later code in the same
 * group replaces the earlier one, which keeps the replay set to one parameter
 * string per attribute instead of an ever-growing list of history.
 */
function sgrGroup(first) {
  const n = first;
  if (n === 0) return 'reset';
  if (n === 39 || (n >= 30 && n <= 37) || (n >= 90 && n <= 97)) return 'fg';
  if (n === 49 || (n >= 40 && n <= 47) || (n >= 100 && n <= 107)) return 'bg';
  if (n === 22 || n === 1 || n === 2) return 'intensity';
  if (n === 23 || n === 3) return 'italic';
  if (n === 24 || n === 4) return 'underline';
  if (n === 27 || n === 7) return 'inverse';
  if (n === 29 || n === 9) return 'strike';
  if (n === 28 || n === 8) return 'conceal';
  if (n === 55 || n === 53) return 'overline';
  return 'code' + n;
}

function _newRun(cap) {
  return { cap, rows: [], acc: '', accW: 0, styled: Object.create(null) };
}

/**
 * Fill `run` from `t[i..)`. 全量与增量折行**共用这一段循环** —— 两者结果逐字节相同
 * 不是靠「两份实现碰巧一致」，而是靠同一段代码（两份抄写迟早分叉，那正是本文件要
 * 消灭的病）。run.styled 与行缓冲跨调用存活，是增量能续扫的前提。
 *
 * acc/accW 走局部变量、只在断行与退出时写回 run：每 token 一次属性写在这个热循环里
 * 是能测到的开销（同一个 run 对象被全量与增量共用，不能退回闭包局部量）。
 *
 * Walk by code point so surrogate pairs (emoji, CJK outside BMP) are never
 * split in half; step over escape sequences whole.
 */
function _scan(t, i, run) {
  const cap = run.cap;
  const styled = run.styled;
  const rows = run.rows;
  let acc = run.acc;
  let accW = run.accW;
  const len = t.length;
  const breakRow = () => {
    const ps = Object.values(styled);
    const open = ps.length ? '\x1b[' + ps.join(';') + 'm' : '';
    if (open) acc += SGR_OFF;
    rows.push(acc);
    acc = open;
    accW = 0;
  };
  while (i < len) {
    let token;
    let w;
    if (t.charCodeAt(i) === 27) {
      ESC_SEQ_RE.lastIndex = i;
      const m = ESC_SEQ_RE.exec(t);
      token = m ? m[0] : t[i];
      w = 0;
    } else {
      token = String.fromCodePoint(t.codePointAt(i));
      if (token === '\n') {
        breakRow();
        i += 1;
        continue;
      }
      w = visWidth(token);
    }
    if (w > 0 && accW + w > cap && accW > 0) {
      breakRow();
    }
    // A single code point wider than the cap gets its own row (never dropped,
    // never split — the physical-floor rule from 102 §6.9).
    acc += token;
    accW += w;
    if (token.length > 3 && token[0] === '\x1b' && token[1] === '[' && token.endsWith('m')) {
      const params = token.slice(2, -1);
      const codes = params === '' ? [] : params.split(';').map((p) => Number(p) || 0);
      if (codes.length === 0 || codes[0] === 0) {
        for (const k of Object.keys(styled)) delete styled[k];
      } else {
        styled[sgrGroup(codes[0])] = params;
      }
    }
    i += token.length;
  }
  run.acc = acc;
  run.accW = accW;
}

/**
 * Wrap text into segments of display width <= `width`.
 *
 * ANSI-aware: escape sequences are atomic and zero-width, so a wrap point can
 * never land inside `\x1b[36m` (which made the terminal print the leftover
 * `36m` as literal text). When a styled span straddles a wrap point the row is
 * closed with `ESC[0m` and the next row reopens the styles still in effect, so
 * coloring neither leaks past the line nor silently drops.
 *
 * @param {string} text
 * @param {number} width - max display width per segment (<= 0 → no wrapping)
 * @returns {string[]}
 */
function wrapCell(text, width) {
  const t = String(text == null ? '' : text);
  const cap = Math.max(0, Math.floor(Number(width) || 0));
  if (cap <= 0) {
    return t.split('\n');
  }
  const run = _newRun(cap);
  _scan(t, 0, run);
  run.rows.push(run.acc);
  return run.rows;
}

/**
 * 追加边界是否「干净」—— 干净才能从 `prev.length` 处续扫。
 *
 * 判据只有一条:**prev 里的转义序列,放到完整文本 t 上重新匹配,必须仍完整收在 prev
 * 内**(越界 = 上一帧的 token 化与全量扫描会不同,从续扫点起就分叉)。
 * 两种命中:
 *   - 代理对被劈开:全量扫描把 `❤️` 当**一个** code point(宽 2),从低代理项起扫会
 *     把它当两个字,行宽与切分点都不同。
 *   - 序列没闭合:上一帧只有 `\x1b[3` 时它匹配不上,退化成可打印的 `\x1b`,续扫会把
 *     `6m` 当正文。
 *
 * 查两处而不是一处,是被 OSC 的两个特性逼出来的:
 *   - OSC 的匹配长度取决于**后面还有没有终结符**,在截断的 prev 上 OSC 分支必然
 *     失配,正则退回最后一个备选 `[@-Z\\-_]`,把 `\x1b]` 当两字节 dispatch 吃掉 →
 *     判成干净 → 续扫从 OSC 体内开始。
 *   - OSC 体内可以再嵌 ESC(`\x1b]8;;u\x1b[36m…\x07`):此时尾部那个 ESC 自己匹配得好好的,
 *     越界的却是更外层的 OSC 起点,所以每个 OSC 起点都得单独查。
 * 非 OSC 的四种分支查尾部一个就够 —— 参数/中间字节类里都没有 ESC,被劈开的序列必然
 * 一直伸到 prev 末尾。
 *
 * 任一命中就整段重扫 —— 宁可慢一帧,不许折行结果与全量分叉。代价是每帧 O(prev 中的
 * OSC 数 + 1)次粘性匹配,不是 O(全文)。
 */
function _boundaryClean(prev, t) {
  const n = prev.length;
  const c = prev.charCodeAt(n - 1);
  if (c >= 0xd800 && c <= 0xdbff) {
    const d = t.charCodeAt(n);
    if (d >= 0xdc00 && d <= 0xdfff) return false; // 低代理项跟着走,不能劈
  }
  // 匹配不到 = t 上也没有终止符。文本变长只会让序列变长、不会凭空造出序列,
  // 故此时 prev 上的那个 ESC 同样是裸 ESC,续扫从它后面起是对的,不必重扫。
  for (let at = prev.indexOf('\x1b]'); at !== -1; at = prev.indexOf('\x1b]', at + 2)) {
    ESC_SEQ_RE.lastIndex = at;
    const m = ESC_SEQ_RE.exec(t);
    if (m && at + m[0].length > n) return false;
  }
  const tail = prev.lastIndexOf('\x1b');
  if (tail >= 0) {
    ESC_SEQ_RE.lastIndex = tail;
    const m = ESC_SEQ_RE.exec(t);
    if (m && tail + m[0].length > n) return false;
  }
  return true;
}

/**
 * 增量折行 —— 给「每帧对**累积全文**折行」的调用点用(流式正文每帧多几百字,
 * 全量重折让一轮答复变成 O(N²))。
 *
 * `state` 是上一帧的返回值原样传回;`text` **以旧文本为前缀**(流式追加)时只扫新增
 * 尾巴,已完成的行与跨行 SGR 状态原地续用,结果与 `wrapCell(text, cols)` 逐字节相同
 * —— 它们跑的是同一个 `_scan`。
 *
 * **state 是一次性的**:续扫走的是原地改写 `state.run` 的 `_scan`,所以传进来续过一次
 * 之后,那个 state 就与「扫到 state.text.length 为止」的状态不再对应,再拿它推演别的
 * 文本会静默给出错结果(不是报错)。要比较多个分支(换列宽会怎样 / 重新折一遍核对),
 * 每一支都得各自从**同一份未消费的 state** 出发。
 *
 * 文本被替换 / 缩短 / 列宽变化(rewind、换 turn、缩窗)时安全退回全量:prefix 校验
 * 不过就重扫,不猜。
 *
 * @param {{text:string,cols:number,run:object}|null} state
 * @param {string} text
 * @param {number} cols
 * @returns {{lines:string[], state:{text:string,cols:number,run:object}}}
 */
function wrapCellIncremental(state, text, cols) {
  const t = String(text == null ? '' : text);
  const cap = Math.max(0, Math.floor(Number(cols) || 0));
  const resumable =
    cap > 0 &&
    state &&
    state.run &&
    state.cols === cap &&
    t.length >= state.text.length &&
    t.startsWith(state.text) &&
    _boundaryClean(state.text, t);
  if (resumable) {
    const run = state.run;
    _scan(t, state.text.length, run);
    return { lines: run.rows.concat(run.acc), state: { text: t, cols: cap, run } };
  }
  if (cap <= 0) {
    const lines = t.split('\n');
    return { lines, state: { text: t, cols: cap, run: null } };
  }
  const run = _newRun(cap);
  _scan(t, 0, run);
  return { lines: run.rows.concat(run.acc), state: { text: t, cols: cap, run } };
}

/**
 * @param {string} text
 * @param {number} width
 * @returns {number} number of VISUAL rows the wrapped text occupies
 */
function visualRows(text, width) {
  return wrapCell(text, width).length;
}

/**
 * Logical row count (split on \n) for UNWRAPPED content. Billing for pre-
 * truncated one-row-per-line content (tool preview bodies).
 * @param {string} text
 * @returns {number}
 */
function visualRowsUnwrapped(text) {
  const t = String(text == null ? '' : text);
  return t === '' ? 0 : t.split('\n').length;
}

/**
 * Clip to ONE visual row of at most `width` display columns, marking the cut
 * with `marker` (default '…'). Same metering as wrapCell — code-point stepping,
 * escape sequences consumed whole — so a clip never lands inside a surrogate
 * pair and never leaves half an SGR behind.
 *
 * @param {string} text
 * @param {number} width - total columns the result may occupy, marker included
 * @param {string} [marker]
 * @returns {string}
 */
function clipCell(text, width, marker = '…') {
  const t = String(text == null ? '' : text).replace(/\r?\n/g, ' ');
  const cap = Math.floor(Number(width));
  if (!Number.isFinite(cap) || cap <= 0) {
    return '';
  }
  if (visWidth(t) <= cap) {
    return t;
  }
  const mk = visWidth(marker);
  if (cap <= mk) {
    return '';
  }
  let acc = '';
  let w = 0;
  let i = 0;
  let dropped = false;
  while (i < t.length) {
    let token;
    let tw;
    if (t[i] === '\x1b') {
      ESC_SEQ_RE.lastIndex = i;
      const m = ESC_SEQ_RE.exec(t);
      token = m ? m[0] : t[i];
      tw = 0;
    } else {
      token = String.fromCodePoint(t.codePointAt(i));
      tw = visWidth(token);
    }
    if (w + tw > cap - mk) {
      dropped = true;
      break;
    }
    acc += token;
    w += tw;
    i += token.length;
  }
  return dropped ? acc + marker : acc;
}

/**
 * Pad (or clip) `text` to EXACTLY `width` display columns.
 *
 * This exists so a right-aligned column can be built without a second width
 * meter: it clips with `clipCell` and pads with the same `visWidth` ruler, so
 * `visWidth(padCell(s, w)) === w` holds for every `w >= 1`. Re-deriving the
 * width here would let the clip point and the alignment column drift apart
 * independently — the two would look right in isolation and misalign together.
 *
 * @param {string} text
 * @param {number} width - exact columns the result occupies
 * @returns {string}
 */
function padCell(text, width) {
  const cap = Math.floor(Number(width));
  if (!Number.isFinite(cap) || cap <= 0) {
    return '';
  }
  const clipped = clipCell(text, cap);
  const w = visWidth(clipped);
  return w >= cap ? clipped : clipped + ' '.repeat(cap - w);
}

// Box(borderStyle:'round', paddingX:1) — what the picker chrome eats from the
// terminal width: 2 border + 2 padding columns.
const PICKER_BOX_CHROME_COLS = 4;
// Below this many columns there is nothing worth clipping to — render the row
// uncapped (and let ink wrap) rather than a row of nothing but '…'.
const PICKER_MIN_CONTENT_COLS = 8;
// The 「（12/40 · ↓更多）」 overflow hint is appended to the footer, so it can
// only ever push that row onto one more visual row.
const PICKER_HINT_ROWS = 1;
// Default cap on list rows, shared by the pickers: a cap, never a target —
// see pickerPageRows.
const PICKER_PAGE_SIZE = 12;

/**
 * Columns left for a picker row's variable content, or 0 when the width is
 * unknown / the row is too narrow to clip (caller then renders as before).
 * The prefix and suffix are measured, not assumed — number labels and
 * ' (不可选)'-style tags change width per row.
 */
function pickerRowBudget(cols, prefix, suffix) {
  const c = Math.floor(Number(cols));
  if (!Number.isFinite(c) || c <= 0) {
    return 0;
  }
  const budget = c - PICKER_BOX_CHROME_COLS - visWidth(prefix) - visWidth(suffix);
  return budget >= PICKER_MIN_CONTENT_COLS ? budget : 0;
}

/**
 * Rows a picker may spend on list items inside a terminal of `rows` lines.
 * Frame chrome is billed with the SAME wrap meter the rows use, because at
 * narrow widths the header and the footer each wrap into two visual rows —
 * assuming one is what put the 「Esc 取消」 hint off screen (BUG-54/BUG-55).
 * Returns PICKER_PAGE_SIZE when the size is unknown (render as before).
 */
function pickerPageRows(rows, cols, headerText, footerText) {
  const r = Math.floor(Number(rows));
  const c = Math.floor(Number(cols));
  if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(c) || c <= 0) {
    return PICKER_PAGE_SIZE;
  }
  const inner = c - PICKER_BOX_CHROME_COLS;
  const chrome = 2 + visualRows(headerText, inner) + visualRows(footerText, inner) + PICKER_HINT_ROWS;
  return Math.max(1, Math.min(PICKER_PAGE_SIZE, r - chrome));
}

/**
 * A single border row of EXACTLY `width` display columns.
 * @param {number} width
 * @param {{left?: string, right?: string, mid?: string, busy?: boolean}} [opts]
 * @returns {string}
 */
function fitBorder(width, opts = {}) {
  const left = opts.left || '╭';
  const right = opts.right || '╮';
  // busy → the gutter char switches to a "working" glyph but stays visible
  // (never `color: undefined` + dim, which vanishes in some terminals).
  const mid = opts.busy ? '╌' : (opts.mid || '─');
  const w = Math.max(0, Math.floor(Number(width) || 0));
  const fixed = visWidth(left) + visWidth(right);
  if (w <= fixed) {
    // Degenerate width: emit whatever corners FIT (a width-1 line can only
    // hold one corner); the visWidth(s) === width invariant holds.
    if (w === 0) {
      return '';
    }
    if (w <= visWidth(left)) {
      return left.slice(0, 1);
    }
    return left + right.slice(0, 1);
  }
  const inner = w - fixed;
  const reps = Math.max(1, inner);
  let s = left + mid.repeat(reps) + right;
  // Reconcile any residual width drift (mixed-width mid glyphs): pad or trim
  // to exactly `w` display columns.
  let guard = 0;
  while (visWidth(s) < w && guard++ < 16) {
    s = left + mid.repeat(reps + guard) + right;
  }
  return s;
}

module.exports = {
  wrapCell,
  wrapCellIncremental,
  visualRows,
  visualRowsUnwrapped,
  clipCell,
  padCell,
  fitBorder,
  visWidth,
  pickerRowBudget,
  pickerPageRows,
  PICKER_BOX_CHROME_COLS,
  PICKER_PAGE_SIZE,
};
