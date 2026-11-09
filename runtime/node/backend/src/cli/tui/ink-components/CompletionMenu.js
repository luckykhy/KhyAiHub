'use strict';

/**
 * CompletionMenu — inline dropdown for slash-command and @file completion.
 * Visual model follows Claude Code: a bordered list under the prompt, the
 * selected row highlighted, command/description in two columns.
 *
 * Features:
 * - ESC exits cleanly (no residual traces via React unmount)
 * - Standardized format with border, two-column layout
 * - Page navigation with PageUp/PageDown or [/] keys
 */
const React = require('react');

const inkRuntime = require('../inkRuntime');
// 折叠/裁剪的计费口径与另两个选择器同源：视觉行 = wrapCell.visualRows。
const { clipCell, visualRows, visWidth } = require('../wrapCell');

const MAX_VISIBLE = 10;
const ITEMS_PER_PAGE = MAX_VISIBLE;
// 圆角边框 2 + paddingX 1×2：框内可用列 = cols − marginLeft − 本常量。
const BOX_CHROME_COLS = 4;
// 圆角边框 2 + 页脚 1：一页至少占 3 视觉行 ⇒ 高度预算先减它才得到「能画几条」。
const BOX_CHROME_ROWS = 3;
// 一个框最低 4 行（边框 2 + 1 条 + 页脚 1）。预算低于它就不是「少画几条」而是
// 「画不下」—— 那时整框让位（渲染 null、账本 0 行），把行留给转录与输入框：
// 补全看不见还能重敲，转录被 ink 的 fullscreen 清屏抹掉才是真丢了东西。
const MIN_FRAME_ROWS = BOX_CHROME_ROWS + 1;

/**
 * 页脚那一行的文案 —— 也是**账本**的一部分：它在 40 列下会从 1 行折成 2 行，
 * 少扣一行就等于主内容槽多报一行(BUG-59 同族，见 BUG-60)。
 * 退档阶梯照 BUG-58 的做法：整句 → 去种类前缀 → 去选择键 → 只剩退出键 → 按显示列截断。
 * 「Esc 取消」永远优先留在屏上，页码次之（用户先看怎么退，再看自己在第几页）。
 *
 * 2026-10-10 起补三路入口的广告位：左右键（斜杠=翻页 / 文件=目录）与鼠标点击。
 *  Glyph 一律避开 ↑↓←→：它们的东亚宽度是 Ambiguous，中文终端下可能按 2 列画，
 *  而账本按 1 列记 → 页脚折行、帧高失真（BUG-60 同族）。用「左右键」三个汉字
 *  （width 2，可度量）表达同一件事。
 */
function footerLabel(kind, page, totalPages, innerCols) {
  const kindName = kind === 'slash' || kind === 'slash-sub' ? '斜杠命令' : '文件';
  const navKey = kind === 'file' ? '左右键目录' : '左右键翻页';
  const pg = `${page + 1}/${totalPages}`;
  const cands = [
    `  ${kindName} · 第 ${pg} 页 · 回车执行 · ${navKey} · Esc 取消 · 点击选中`,
    `  第 ${pg} 页 · 回车执行 · ${navKey} · Esc 取消`,
    `  第 ${pg} 页 · Esc 取消`,
    `  Esc 取消`,
  ];
  const cap = Number(innerCols) > 0 ? Math.floor(Number(innerCols)) : 0;
  if (!cap) return cands[0];
  for (const t of cands) if (visWidth(t) <= cap) return t;
  return clipCell(cands[cands.length - 1], cap);
}

/**
 * 过滤词在标签里的高亮区间（显示列口径由调用方按字符切）。
 * 斜杠菜单的 query 形如 `/col`（含前导 `/`），@文件菜单形如 `@src/cl`；两者都先剥
 * 触发符再取最后一段（文件路径只拿末段名比）。大小写折叠若改变长度（个别语种）
 * → 放弃高亮也不算错列。找不到 → null（描述命中的候选就不高亮，绝不假装）。
 */
function matchRange(label, query) {
  const q = String(query == null ? '' : query).replace(/^[/@]/, '');
  const seg = q.includes('/') ? q.slice(q.lastIndexOf('/') + 1) : q;
  if (!seg) return null;
  const l = String(label == null ? '' : label);
  const ll = l.toLowerCase();
  const ql = seg.toLowerCase();
  if (ll.length !== l.length || ql.length !== seg.length) return null;
  const at = ll.indexOf(ql);
  if (at < 0) return null;
  return { start: at, end: at + ql.length };
}

// Category → ink named color. Keys are the commandSchema category vocabulary,
// values are chalk-form names: ink's colorize matches via `color in chalk`, so
// the brightBlue spelling renders no SGR at all — bright variants must be
// spelled blueBright/magentaBright.
const CATEGORY_COLORS = {
  model: 'magenta',
  data: 'white',
  security: 'red',
  dev: 'green',
  workflow: 'blueBright',
  system: 'cyan',
  analysis: 'magentaBright',
  default: 'gray',
};

// Off-switch parsing mirrors menuHover.js (0/false/off/no).
const CATEGORY_COLOR_OFF = ['0', 'false', 'off', 'no'];

/**
 * Unselected-row foreground color for one completion item.
 * Gate KHY_MENU_CATEGORY_COLOR defaults on; explicit falsy values, a missing
 * category key (slash-sub/@file items) and unknown tokens all fall back to the
 * legacy cyan so second-level menus keep rendering byte-identical.
 */
function categoryColor(item) {
  const raw = process.env.KHY_MENU_CATEGORY_COLOR;
  if (raw !== undefined && CATEGORY_COLOR_OFF.includes(String(raw).trim().toLowerCase())) {
    return 'cyan';
  }
  return (item && CATEGORY_COLORS[item.category]) || 'cyan';
}

/**
 * 一页能画几条 —— 宽度与**高度**双约束。改前只按 `ITEMS_PER_PAGE=10` 定页，
 * 于是 10 行高的终端里一个框 = 边框 2 + 10 + 页脚 1 = 13 行，比屏还高：
 * ink 走 fullscreen 清屏，用户敲 `/` 后连输入框一起看不见(BUG-60 的矮屏分支)。
 * `maxRows` 是账本给这个框留出的行数；未知(0/undefined)→ 逐字节保持今日 10 条一页。
 */
function perPageFor(maxRows) {
  const cap = Number(maxRows) > 0 ? Math.floor(Number(maxRows)) : 0;
  if (!cap) return ITEMS_PER_PAGE;
  return Math.max(1, Math.min(ITEMS_PER_PAGE, cap - BOX_CHROME_ROWS));
}

/**
 * 「这个预算画得下框吗」—— 账本与 paint 共用同一判据(见 `MIN_FRAME_ROWS`)。
 * 预算未知(0/undefined)→ 视作不受高度约束，逐字节保持今日形态。
 */
function frameFits(maxRows) {
  const cap = Number(maxRows) > 0 ? Math.floor(Number(maxRows)) : 0;
  return !cap || cap >= MIN_FRAME_ROWS;
}

/**
 * 横向下预算 —— 账本与 paint 的**唯一**几何来源。一条形如
 * `marker(2) + label + gap(2) + desc + gap(2) + badge`，五者相加必须 ≤ 框内宽，
 * 否则 ink 把这条折成 2 视觉行：帧高就成了宽度的函数，而 `menuRowCount` 按
 * 「一条 = 一行」记账会当场失真(BUG-60 在 20 列实测 28 画 / 4 记)。
 *
 * 三档横向预算（2026-10-10 视觉细化，全部仍在本叶子里算，paint 与账本同源）：
 *   labelWidth —— 命令名/文件名列，钳到 28（长路径必须裁而不是撑爆预算）；
 *   descMax    —— 描述列，剩余不足 8 列整栏让位；
 *   badgeWidth —— 右对齐的「⚙ 可调」徽标列（只有带参数面板的命令才有），
 *                 最窄那档下它第一个被挤掉（描述比徽标重要）。
 * `descMax`：null = 宽度未知走 legacy 不钳；0 = 整栏消失；>0 = 钳到该列数。
 * `badges`：visible 里各行的徽标文本（无徽标 = 空串），由调用方经
 * `badgeOf` 注入 —— 几何叶子不认命令语义。
 */
function menuGeom({ completion, page = 0, cols, marginLeft = 0, maxRows = 0, badgeOf } = {}) {
  const items = (completion && Array.isArray(completion.items) && completion.items) || [];
  const total = items.length;
  const perPage = perPageFor(maxRows);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const currentPage = Math.max(0, Math.min(Math.floor(Number(page)) || 0, totalPages - 1));
  const pageStart = currentPage * perPage;
  const visible = items.slice(pageStart, Math.min(total, pageStart + perPage));
  const inner =
    Number.isFinite(cols) && Number(cols) > 0
      ? Math.max(1, Math.floor(Number(cols)) - (Math.max(0, Number(marginLeft) || 0) + BOX_CHROME_COLS))
      : 0;
  const widestLabel = visible.reduce((w, it) => Math.max(w, visWidth(it.label || '')), 0);
  if (!inner) {
    return {
      visible,
      currentPage,
      totalPages,
      perPage,
      inner: 0,
      labelWidth: Math.min(28, widestLabel),
      descMax: null,
      badgeWidth: 0,
      badges: [],
    };
  }
  const labelWidth = Math.max(1, Math.min(28, widestLabel, inner - 2));
  const badges =
    typeof badgeOf === 'function'
      ? visible.map((it) => String(badgeOf(it) || ''))
      : visible.map(() => '');
  const widestBadge = badges.reduce((w, b) => Math.max(w, visWidth(b)), 0);
  // 徽标列最多吃掉 1/3 内宽：它是提示不是主角，绝不允许把描述挤没。
  const badgeWidth = Math.min(widestBadge, Math.max(0, Math.floor(inner / 3)));
  const budget = inner - 4 - labelWidth - (badgeWidth ? badgeWidth + 2 : 0);
  // 一栏至少 8 显示列才读得出东西，不如整栏让位给条目本身。
  return {
    visible,
    currentPage,
    totalPages,
    perPage,
    inner,
    labelWidth,
    descMax: budget >= 8 ? budget : 0,
    badgeWidth,
    badges,
  };
}

/**
 * 头一行（匹配数 + 页码）—— 与页脚同一本宽度账：它在 20 列会从 1 行折成 2 行，
 * 少扣一行就等于主内容槽多报一行(BUG-59 同族)。退档阶梯：整句 → 只留匹配数 →
 * 按显示列截断。空串 = 不画（账本 0 行）。
 */
function headerLabel(total, page, totalPages, innerCols) {
  const paged = totalPages > 1;
  const cands = paged
    ? [
        `  匹配 ${total} 条 · 第 ${page + 1}/${totalPages} 页`,
        `  匹配 ${total} 条`,
        `  ${total} 条`,
      ]
    : [`  ${total} 条`];
  const cap = Number(innerCols) > 0 ? Math.floor(Number(innerCols)) : 0;
  if (!cap) return cands[0];
  for (const t of cands) if (visWidth(t) <= cap) return t;
  return clipCell(cands[cands.length - 1], cap);
}

/**
 * 帧高（视觉行）单一真源：`App.js` 的 `_viewportHeight` 用它扣行，
 * 组件用它画行。入参形状与 CompletionMenu 的 props 一致。
 * 每条 item 恰好 1 视觉行（`menuGeom` 已保证一条 ≤ 框内宽），头/页脚都按 `inner`
 * 计折行 —— 三处共用同一把尺，账本才等于画出的行数。
 */
const HEADER_ROWS = 1;

function menuRowCount({ completion, page = 0, cols, marginLeft = 0, maxRows = 0, badgeOf } = {}) {
  if (!completion || !completion.active || !Array.isArray(completion.items) || completion.items.length === 0) {
    return 0;
  }
  // 画不下 = 一帧都不占（组件同一判据 return null），账本随之归零。
  if (!frameFits(maxRows)) return 0;
  const g = menuGeom({ completion, page, cols, marginLeft, maxRows, badgeOf });
  const headerText = headerLabel(
    completion.items.length,
    g.currentPage,
    g.totalPages,
    g.inner
  );
  const headerRows = g.inner ? visualRows(headerText, g.inner) : 1;
  const footerRows = g.inner ? visualRows(footerLabel(completion.kind, g.currentPage, g.totalPages, g.inner), g.inner) : 1;
  return g.visible.length + headerRows + footerRows + 2;
}

function CompletionMenu({
  completion,
  selectedIndex,
  marginLeft = 0,
  page = 0,
  cols,
  maxRows = 0,
  query = '',
  badgeOf,
  onItemPress,
  onItemHover,
}) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;
  if (!completion || !completion.active || completion.items.length === 0) {
    return null;
  }
  if (!frameFits(maxRows)) return null;

  // Both columns of a row must be budgeted in **display columns** (CJK = 2), not
  // UTF-16 units, and each column must be clamped to its own budget. `padEnd`
  // counts units, so a Chinese @file label was under-padded (description column
  // drifted per row) and inflated the description budget by the same amount —
  // re-introducing exactly the wrap-and-misalign the clamp below exists to
  // prevent. A label wider than the cap likewise escaped clamping. (BUG-47)
  let fmt = null;
  try {
    fmt = require('../../formatters');
  } catch {
    fmt = null; // fail-soft: fall back to the legacy unit-based accounting
  }
  const _clip = (s, w) => (fmt && fmt.displayWidth(s) > w ? fmt.truncateToWidth(s, w) : s);
  const _pad = (s, w) => (fmt ? fmt.padToWidth(s, w) : String(s).padEnd(w));

  // Geometry comes from the same pure function the ledger bills with: page clamping,
  // visible slice, label column width, the description budget, the badge column and
  // the height-budgeted page size (BUG-60).
  const g = menuGeom({ completion, page, cols, marginLeft, maxRows, badgeOf });
  const { visible, currentPage, totalPages, labelWidth, descMax, badgeWidth, badges } = g;
  const pageStart = currentPage * g.perPage;

  // A long description overflows the row and Ink wraps it onto a continuation
  // line that starts at the box's left edge — misaligned under the description
  // column (visible for e.g. `/advisor`). When a real terminal width is known,
  // clamp each description to one display line so rows never wrap; when even the
  // clamped column would not fit, the description is dropped for that frame
  // rather than buying height with it. Without `cols` the old behavior is
  // preserved byte-for-byte (`descMax === null`).
  const rows = visible.map((it, i) => {
    const idx = pageStart + i;
    const selected = idx === selectedIndex;
    const label = _pad(_clip(it.label || '', labelWidth), labelWidth);
    let desc = it.desc;
    if (descMax === 0) desc = null;
    else if (fmt && descMax > 0 && desc && fmt.displayWidth(desc) > descMax) {
      desc = fmt.truncateToWidth(desc, descMax);
    }
    // 过滤词高亮：把(已裁剪补齐的)标签按命中区间切成 normal/match 两段。
    // 总显示宽度不变 ⇒ 描述列起点与账本都不动（BUG-47 的对齐不变量保住）。
    // 无 query / 未命中 → 整段一个 child，字节与旧行为一致（旧行为锁测试靠这条）。
    const range = matchRange(label, query);
    const segs = range
      ? [
          { text: label.slice(0, range.start), match: false },
          { text: label.slice(range.start, range.end), match: true },
          { text: label.slice(range.end), match: false },
        ].filter((s) => s.text !== '')
      : [{ text: label, match: false }];
    const marker = selected ? '› ' : '  ';
    // 右对齐徽标（2026-10-10）：带参数面板的命令挂「⚙ 可调」，让用户在按回车前
    // 就知道这条会开面板而不是直接执行。徽标列宽由 menuGeom 统一算，paint 只摆位。
    const badge = badges[i] || '';
    const badgeCell = badgeWidth && badge ? _pad(badge, badgeWidth) : (badgeWidth ? ' '.repeat(badgeWidth) : '');
    return h(
      Box,
      {
        key: it.value || idx,
        // 鼠标层（mouseButtons.collectLayout 按 props 收命中区）：单击 = 对该条目
        // 走与回车相同的接受逻辑；悬停高亮只在 1003 全开时才有事件，默认点击档
        // 下这两个 handler 挂着也不产事件（零成本）。不传 → 一个都不挂，逐字节回退。
        onClick: typeof onItemPress === 'function' ? () => onItemPress(idx) : undefined,
        onMouseOver: typeof onItemHover === 'function' ? () => onItemHover(idx) : undefined,
      },
      h(
        Text,
        { color: selected ? 'black' : categoryColor(it), backgroundColor: selected ? 'cyan' : undefined },
        marker,
        ...segs.map((s, j) =>
          h(Text, { key: j, bold: s.match || undefined }, s.text)
        )
      ),
      desc ? h(Text, { dimColor: true }, '  ' + desc) : null,
      badgeCell ? h(Text, { dimColor: !selected, color: selected ? 'black' : 'yellow' }, '  ' + badgeCell) : null
    );
  });

  // marginLeft 让下拉横向对齐输入光标列(Fix 1b,门控 KHY_COMPLETION_FOLLOW_CURSOR
  // 在 App.js 侧判定;关时传 0 → 贴左=逐字节 legacy)。Math.max 防负值兜底。
  const margin = Math.max(0, Number(marginLeft) || 0);
  // 头一行：匹配数 + （多页时）页码。没有它，用户看着 10 行不知道「一共匹配了
  // 多少、现在在哪一页」—— 页脚只给键位。宽度退档与账本共用 headerLabel。
  const headerText = headerLabel(completion.items.length, currentPage, totalPages, g.inner);
  return h(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: 'gray',
      paddingX: 1,
      marginLeft: margin,
    },
    headerText ? h(Text, { dimColor: true }, headerText) : null,
    ...rows,
    h(Text, { dimColor: true }, footerLabel(completion.kind, currentPage, totalPages, g.inner))
  );
}

CompletionMenu.menuRowCount = menuRowCount;
CompletionMenu.footerLabel = footerLabel;
CompletionMenu.menuGeom = menuGeom;
CompletionMenu.perPageFor = perPageFor;
CompletionMenu.frameFits = frameFits;
CompletionMenu.matchRange = matchRange;
CompletionMenu.CATEGORY_COLORS = CATEGORY_COLORS;
CompletionMenu.categoryColor = categoryColor;
CompletionMenu.HEADER_ROWS = HEADER_ROWS;
CompletionMenu.BADGE = '⚙ 可调';
CompletionMenu.ITEMS_PER_PAGE = ITEMS_PER_PAGE;
CompletionMenu.BOX_CHROME_COLS = BOX_CHROME_COLS;
CompletionMenu.BOX_CHROME_ROWS = BOX_CHROME_ROWS;
CompletionMenu.MIN_FRAME_ROWS = MIN_FRAME_ROWS;

module.exports = CompletionMenu;
