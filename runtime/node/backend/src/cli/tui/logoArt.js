'use strict';

/**
 * logoArt — khy 品牌标记的**唯一资产**（图形 + 字标 + 一句话）。纯叶子：零 IO、确定性、绝不抛、不读 env。
 *
 * 为什么是它（[DESIGN-ARCH-134] §3.4 的原始病灶，至今未收口）：
 * 同一进程先后出现过**三种**品牌符号 —— 启动屏的 `╱╲` 双菱形、欢迎横幅的 13×9 像素四叶草、
 * CC 模式的 `✳ Khy` 字标；另两端（Web / APK）又各画了一个字母 K。
 * 2026-10-25 起，五端统一到**一枚**主标「内核环」（四段弧叶 + 菱形内核 + 内核上的 K 负槽）。
 *
 * 本模块提供 TUI 侧的**点阵渲染**：字符图与三档明暗都由生成物 `brandPixelArt.js` 提供，
 * 该文件由 `node scripts/brand/build-brand-assets.js` 从几何真源
 * `delivery/brand/khy-brand-geometry.js` 渲染而来 —— 改形状只改真源，不手改点阵。
 *
 * 纪律（与 `cli/startupBeats.js` 头部同）：
 *   - **零 IO**：点阵表就是字面量，不读文件、不读 env、不写 console。
 *   - **确定性**：同样的调用永远返回同样的结果。
 *   - **绝不抛**：畸形输入一律回退到安全值（fail-soft）。
 *   - **不改入参、返回新对象**：`markRows()` 每次构造新的 cell 对象，调用方可随意改。
 *
 * 字标与 tagline 取自 `utils/ccBrand.js` 的 `BRAND`（它是本仓的品牌文本单一真源，
 * 自述「修改品牌只需改此文件」）。**不再写第二份字面量** —— 代价是 ccBrand 的适用面
 * 从「CC 模式」扩到「品牌文本」，这是刻意的：品牌串漂移比模块归属更贵。
 */

const { BRAND } = require('./utils/ccBrand');
const { MARK_ART, MARK_SHADE, MARK_COLS, MARK_ROWS } = require('./brandPixelArt');

/** 字标。与 `WelcomeBanner.js` 的 `── khy OS vX.X.X ──` 同字面（不再写 `khy-os`：那是仓库目录名）。 */
const WORDMARK = 'khy OS';

/** 一句话说明。复用 `BRAND.tagline`，不写字面量。 */
const TAGLINE = BRAND.tagline;

/**
 * 三档明暗 → 终端颜色。
 *
 * D = 暗边 / M = 主体 / B = 高光，与主标琥珀渐变的三个亮度档一一对应
 * （明暗档由渲染时按像素亮度实测分档，不是手画的）。
 * 颜色取品牌琥珀族：**唯一**一份，启动屏与欢迎横幅共用（此前两处各写一份 'green'/'greenBright'）。
 */
const SHADE_COLOR = Object.freeze({
  D: '#9C4116',
  M: '#E2703A',
  B: '#FFC078',
});

/** 图形尺寸。显式常量而非从数组长度推导 —— 尺寸是设计值，不是实现细节。 */
const MARK_COLS_COUNT = MARK_COLS;
const MARK_ROWS_COUNT = MARK_ROWS;

/** 合法的明暗档位（`' '` 表示该格不画东西）。 */
const SHADES = Object.freeze(['D', 'M', 'B', ' ']);

/**
 * 把两条表合成「逐行逐格」结构，供渲染器直接消费：`rows[i][j] = { ch, shade }`。
 *
 * 两个渲染器（启动屏 / 欢迎横幅）原先各自解析一遍 shade 表 —— 同一段映射写两处就会漂移。
 * 这里收成唯一一份，两边都调它。
 *
 * @returns {Array<Array<{ch: string, shade: string}>>} 新数组 + 新对象；绝不返回内部引用。
 */
function markRows() {
  const rows = [];
  for (let i = 0; i < MARK_ART.length; i++) {
    const line = String(MARK_ART[i] || '');
    const shadeLine = String(MARK_SHADE[i] || '');
    const cells = [];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      // 空格不参与着色；档位缺失/非法一律回退到主体色（fail-soft）。
      const raw = shadeLine[j];
      const shade = ch === ' ' ? ' ' : SHADES.indexOf(raw) >= 0 && raw !== ' ' ? raw : 'M';
      cells.push({ ch, shade });
    }
    rows.push(cells);
  }
  return rows;
}

module.exports = {
  WORDMARK,
  TAGLINE,
  MARK_ART,
  MARK_SHADE,
  MARK_COLS: MARK_COLS_COUNT,
  MARK_ROWS: MARK_ROWS_COUNT,
  SHADE_COLOR,
  SHADES,
  markRows,
};
