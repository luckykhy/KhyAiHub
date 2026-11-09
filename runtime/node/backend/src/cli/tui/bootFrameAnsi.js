'use strict';

/**
 * bootFrameAnsi — Ink 装载之前的那一帧：品牌字标 + tagline，裸 ANSI 直接写。
 *
 * 为什么需要（2026-11-04 实测，见 works/data/khy/perf/README.md）：
 * 首帧的品牌图是 Ink 画的，而 `import('ink')` 的求值约 1s——试过
 * `module.enableCompileCache()` 无效（860ms vs 暖缓存 777/966/1019），那是
 * react + reconciler + yoga 的**求值**不是解析。所以那 1s 里屏幕只有
 * bootPhaseLine 的一行 transient 进度。本叶子把字标提前画出来，让「已经在启动」
 * 在 200ms 量级成立。
 *
 * 这不是第二个启动屏。边界写死在这里：
 *   - 只画 2 行（字标 + tagline），不画点阵、不画节拍、不画进度条
 *     —— 节拍与百分比归 startupBeats / bootPhaseLine（[DESIGN-ARCH-115] §4）。
 *   - 调用方必须在 Ink 接管终端**之前**擦掉（`erase()`）。Ink 走备用屏，
 *     退出时还原主缓冲区；未擦的帧会在用户退出 khy 后留在屏幕上冒充 prompt。
 *     这与 startupAnchor.js 记录的「残影」是同一类问题。
 *
 * 纪律：零 IO、确定性、绝不抛、不读 env（颜色/宽度由调用方传入）、返回新对象。
 */

const { WORDMARK, TAGLINE } = require('./logoArt');
const { isBootScreenEnabled } = require('./bootScreenSwitch');

const RESET = '\u001b[0m';
const BOLD = '\u001b[1m';
const DIM = '\u001b[2m';
const CLEAR_LINE = '\u001b[K';
const INDENT = '  ';
/** 低于此列数不画 tagline：27 列的句子在窄终端会折行，把启动块撑成三行。 */
const MIN_COLS_FOR_TAGLINE = 30;
/** 品牌高光色，与 logoArt.SHADE_COLOR.B (#FFC078) 同源 —— 不写第二份色值。 */
const BRAND_FG = '\u001b[38;2;255;192;120m';

function _int(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * 生成品牌帧。
 * @param {object} [options]
 * @param {number} [options.cols] 终端列数（未知时按 80 保守处理）
 * @param {boolean} [options.color] 是否带 SGR；NO_COLOR / 非 TTY 时传 false
 * @returns {{text: string, lines: number}} text 以换行结尾，使紧随其后的 transient
 *   进度行独占一行；lines 是擦除时回退的行数。
 */
function render(options = {}) {
  const cols = _int(options.cols, 80);
  const color = options.color !== false;
  const on = (sgr) => (color ? sgr : '');

  const lines = [INDENT + on(BOLD + BRAND_FG) + WORDMARK + on(RESET)];
  const tag = String(TAGLINE || '').trim();
  if (tag && cols >= MIN_COLS_FOR_TAGLINE) {
    lines.push(INDENT + on(DIM) + tag + on(RESET));
  }

  return {
    text: lines.map((line) => line + CLEAR_LINE).join('\n') + '\n',
    lines: lines.length,
  };
}

/**
 * 擦掉 render() 写下的块。调用时光标应停在该块**下方紧邻**的行首
 * （bootPhaseLine.close() 清完自己的 transient 行后就是这个位置）。
 * @param {number} count render() 返回的 lines
 * @returns {string} 光标回到块首行行首
 */
function erase(count) {
  const n = _int(count, 0);
  if (n <= 0) return '';
  let out = `\u001b[${n}A`;
  for (let i = 0; i < n; i += 1) {
    out += '\r' + CLEAR_LINE;
    if (i < n - 1) out += '\u001b[1B';
  }
  if (n > 1) out += `\u001b[${n - 1}A`;
  return out + '\r';
}

module.exports = { render, erase, isEnabled: isBootScreenEnabled, MIN_COLS_FOR_TAGLINE };
