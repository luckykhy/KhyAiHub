'use strict';

/**
 * utils/text/width.js — pure display-width / ANSI-aware text helpers.
 *
 * Relocated out of cli/formatters.js on 2026-09-28 ([RESEARCH-018] §3.1 P2): these are pure
 * string algorithms consumed by both cli/ and services/, so the shared substrate (D3) is their
 * home; cli/formatters.js keeps its export surface by re-binding them, and the old cli path
 * stays the only entry for its existing consumers.
 *
 * Leaf contract: no cli/ require, no Ink, no terminal introspection (getTerminalColumns and
 * safeTerminalString stayed in formatters because they are CLI presentation concerns).
 */

// CSI/ESC coverage kept in lockstep with wrapCell's ESC_SEQ_RE so the width
// SSOT and the wrap/row biller agree on exactly which bytes are a zero-width
// escape. CSI parameter bytes are the full ECMA-48 range 0x30-0x3F
// (`[0-9:;<=>?]`, NOT just `[0-9;?]`): colon-separated truecolor SGR
// (`\x1b[38:2:R:G:Bm`) and private params (`\x1b[>c`) must be stripped whole,
// else their digits are metered as printable and the row budget drifts
// (same family as BUG-32 / BUG-98). The `[ -/]+[@-~]` branch covers
// ESC-with-intermediates dispatches (e.g. `\x1b(B` charset designation); it
// requires >=1 intermediate, so a lone printable after ESC is never eaten.
// eslint-disable-next-line no-control-regex
const _ANSI_PATTERN = /\u001b(?:[@-Z\\-_]|\[[0-9:;<=>?]*[ -/]*[@-~]|[ -/]+[@-~])/g;

// OSC sequences (hyperlinks, window titles): \x1b]...BEL or \x1b]...ESC\ (ST).
// Lazy body + both terminators; stripped BEFORE _ANSI_PATTERN so the ST's
// ESC\ is not consumed first, which would leave the OSC body behind.
// eslint-disable-next-line no-control-regex
const _OSC_PATTERN = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;

// strip-ansi loader sentinel: undefined = not tried, null = load failed (never retry).
let _stripAnsiLib;
function stripAnsi(str) {
  if (_stripAnsiLib === undefined) {
    try {
      const mod = require('strip-ansi');
      const fn =
        typeof mod === 'function'
          ? mod
          : mod && typeof mod.default === 'function'
            ? mod.default
            : null;
      _stripAnsiLib = fn || null;
    } catch {
      _stripAnsiLib = null;
    }
  }
  if (_stripAnsiLib) {
    try {
      // 先过仓内正则再交给库：_OSC_PATTERN / _ANSI_PATTERN 覆盖 ECMA-48 全参数段（含冒号式真彩色
      // `38:2:R:G:B`）、私有参数与两种 OSC 终止符，而 strip-ansi 放不住这些形态，会把参数数字
      // 原样吐出并被计成可打印宽度（实测 5 例见 .khy/feedback/b21-width-ssot/repro-before.txt）。
      // 顺序不可反：库只负责兜住仓内正则未覆盖的其余序列。
      return _stripAnsiLib(String(str == null ? '' : str).replace(_OSC_PATTERN, '').replace(_ANSI_PATTERN, ''));
    } catch {
      _stripAnsiLib = null;
    }
  }
  return String(str == null ? '' : str).replace(_OSC_PATTERN, '').replace(_ANSI_PATTERN, '');
}

/**
 * Calculate the visual display width of a string, accounting for:
 * - CJK characters (2 columns each)
 * - Emoji (2 columns each)
 * - ANSI escape codes (0 columns)
 * - Combining characters (0 columns)
 */
/**
 * Calculate display width of a string.
 * Uses string-width for accurate CJK/emoji/grapheme width calculation,
 * with a fast ASCII-only path for common cases.
 * Strips ANSI escape codes before measuring.
 */
// string-width loader sentinel: undefined = not tried, null = load failed (never retry).
let _stringWidth;
function _computeDisplayWidth(str) {
  const stripped = stripAnsi(str);
  if (!stripped) {
    return 0;
  }

  // Fast path: pure ASCII (common for code, paths, English text)
  if (/^[\x20-\x7E]*$/.test(stripped)) {
    return stripped.length;
  }

  // Full Unicode path via string-width (handles CJK, emoji, grapheme clusters)
  if (_stringWidth === undefined) {
    try {
      const mod = require('string-width');
      const fn =
        typeof mod === 'function'
          ? mod
          : mod && typeof mod.default === 'function'
            ? mod.default
            : null;
      _stringWidth = fn || null;
    } catch {
      _stringWidth = null;
    }
  }
  if (_stringWidth) {
    try {
      return _stringWidth(stripped);
    } catch {
      /* fallback below */
    }
  }

  // Fallback: manual calculation for environments without string-width
  let width = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3040 && cp <= 0x33bf) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x2fa1f) ||
      (cp >= 0x1f300 && cp <= 0x1f9ff)
    ) {
      width += 2;
    } else if (cp >= 0x0300 && cp <= 0x036f) {
      width += 0;
    } else {
      width += 1;
    }
  }
  return width;
}

// 显示宽度按字符串 LRU 记忆(纯叶子;门控 KHY_DISPLAY_WIDTH_MEMO 默认开)。渲染热路径每键对整行重测
// 宽度(主输入刷新每按键两次),而 displayWidth 是其字符串实参的纯函数 → 可安全记忆。惰性 require
// 避免加载期环依赖;叶子缺失/异常 → 直接 _computeDisplayWidth(逐字节回退)。
let _displayWidthMemo;
function displayWidth(str) {
  try {
    if (!_displayWidthMemo) {
      _displayWidthMemo = require('./displayWidthMemo');
    }
    return _displayWidthMemo.getDisplayWidth(str, _computeDisplayWidth, process.env);
  } catch {
    return _computeDisplayWidth(str);
  }
}

/**
 * Pad a string to a target display width, accounting for CJK characters.
 * @param {string} str - raw or ANSI-colored string
 * @param {number} targetWidth
 * @param {string} [fill=' ']
 * @returns {string}
 */
function padToWidth(str, targetWidth, fill = ' ') {
  const currentWidth = displayWidth(str);
  const needed = Math.max(0, targetWidth - currentWidth);
  return str + fill.repeat(needed);
}

/**
 * Truncate a string to a maximum display width, adding '...' if truncated.
 * @param {string} str
 * @param {number} maxWidth
 * @returns {string}
 */
// Wide (double-width) code-point ranges. Shared by both the legacy and the
// linear truncation paths so their width accounting stays byte-identical.
function _isWideCodePoint(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3040 && cp <= 0x33bf) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x2fa1f) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff)
  );
}

// ANSI-aware truncation guard (KHY_TRUNCATE_ANSI_LINEAR, default on).
//
// The legacy ESC branch below is both quadratic AND wrong: on every ESC byte
// (cp 0x1B) it evaluated `str.slice([...str].indexOf(ch))`, which (a) spreads
// the ENTIRE string into an array to locate the escape and (b) always returns
// the FIRST ESC's offset, not the current one. A garbled / mojibake paste that
// carries a run of raw ESC bytes ahead of any width-bearing text therefore
// grinds O(n^2) — measured ~13 s at 40 000 ESC, ~55 s at 80 000. On top of that
// the `for (k …)` "skip" loop is dead code (it allocates an iterator and does
// nothing), so the CSI sequence body (`[0;31m`) leaks into the width count.
//
// The linear path walks code points by index and, at each ESC, matches a CSI
// colour sequence with a STICKY regex anchored at the current offset (no slice,
// no full-string spread) — appending it verbatim at zero width. For any input
// WITHOUT an ESC byte the two paths are byte-identical (the ESC branch is never
// taken), so real callers — which pass ANSI-stripped plain text — are
// unaffected; only crafted ESC paste changes, and there the linear path is both
// correct and bounded. Off -> legacy quadratic/leaky branch (load-bearing).
const _TRUNCATE_ANSI_OFF = ['0', 'false', 'off', 'no'];
function _truncateAnsiLinearEnabled() {
  return !_TRUNCATE_ANSI_OFF.includes(
    String((process.env && process.env.KHY_TRUNCATE_ANSI_LINEAR) || '')
      .trim()
      .toLowerCase()
  );
}

// Sticky CSI matcher: `y` flag anchors at lastIndex without slicing. Parameter bytes are the full
// ECMA-48 range and the final byte a CSI dispatch byte — kept in lockstep with _ANSI_PATTERN above.
// The old `[0-9;]*m` form could not match colon-separated truecolor (`\x1b[38:2:R:G:Bm`): the walk
// dropped only the ESC and then metered AND re-emitted the parameter digits as printable text
// (row drift + visible `38:2:...m` residue in truncated cells; same family as BUG-32 / BUG-98).
const _CSI_SGR_STICKY = /\x1b\[[0-9:;<=>?]*[ -/]*[@-~]/y;

function _truncateToWidthLegacy(str, maxWidth) {
  let result = '';
  let w = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    // ANSI escape — skip entirely (zero width)
    if (cp === 0x1b) {
      // Fast-skip ESC[...m sequences
      const rest = str.slice([...str].indexOf(ch));
      const m = rest.match(/^\x1b\[[0-9;]*m/);
      if (m) {
        // Skip ANSI chars without adding width
        for (let k = 1; k < m[0].length; k++) {
          const iter = str[Symbol.iterator]();
          // Can't easily skip in for-of; ANSI in truncation input is rare — treat as w=0
        }
      }
      continue;
    }
    // Combining characters — zero width
    if (cp >= 0x0300 && cp <= 0x036f) {
      continue;
    }
    const charWidth = _isWideCodePoint(cp) ? 2 : 1;
    if (w + charWidth + 3 > maxWidth) {
      // reserve 3 for '...'
      result += '...';
      break;
    }
    result += ch;
    w += charWidth;
  }
  return result;
}

function truncateToWidth(str, maxWidth) {
  if (displayWidth(str) <= maxWidth) {
    return str;
  }
  if (!_truncateAnsiLinearEnabled()) {
    return _truncateToWidthLegacy(str, maxWidth);
  }

  let result = '';
  let w = 0;
  let i = 0;
  const len = str.length;
  while (i < len) {
    const cp = str.codePointAt(i);
    const chLen = cp > 0xffff ? 2 : 1;
    // ANSI escape — consume the whole CSI-SGR sequence at zero width.
    if (cp === 0x1b) {
      _CSI_SGR_STICKY.lastIndex = i;
      const m = _CSI_SGR_STICKY.exec(str);
      if (m) {
        result += m[0];
        i = _CSI_SGR_STICKY.lastIndex;
      } else {
        // Lone/non-SGR ESC: drop the ESC byte (legacy parity: zero width, not appended).
        i += chLen;
      }
      continue;
    }
    // Combining characters — zero width, dropped (legacy parity).
    if (cp >= 0x0300 && cp <= 0x036f) {
      i += chLen;
      continue;
    }
    // Measure with the SAME source as the `displayWidth(str) <= maxWidth` guard
    // above. `_isWideCodePoint`'s emoji table stops at 0x1f9ff and misses the
    // Extended-A block (0x1fa70–0x1faff), so using it here while the guard uses
    // string-width let modern emoji slip through under-truncated: the produced
    // line's real display width could exceed maxWidth → terminal wrap → +1 frame
    // row (BUG-98). displayWidth of one code point is cluster-faithful for the
    // single-unit emoji that reach here (ESC/combining already consumed above).
    const charWidth = displayWidth(str.slice(i, i + chLen));
    if (w + charWidth + 3 > maxWidth) {
      // reserve 3 for '...'
      result += '...';
      break;
    }
    result += str.slice(i, i + chLen);
    w += charWidth;
    i += chLen;
  }
  return result;
}

module.exports = {
  stripAnsi,
  displayWidth,
  padToWidth,
  truncateToWidth,
  _truncateAnsiLinearEnabled,
  _truncateToWidthLegacy,
};
