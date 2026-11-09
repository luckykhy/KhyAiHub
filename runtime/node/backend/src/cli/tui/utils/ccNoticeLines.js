'use strict';

/**
 * ccNoticeLines.js — 多行 notice 的行模型纯叶子（零 IO、确定性、绝不抛）。
 *
 * 病因（收集式命令输出的呈现缺陷）：`khy phone status` / `khy amoo status` 这类走
 * `commandOutputSink` 收集路径的命令，handler 的多次 print（`  ✓ ` / `  i ` / `  ⚠ `）
 * 与 `renderStatusText` / `renderDispatchResultText` 拍成的**单个 \n 连接字符串**，
 * 一起落进同一条 notice。旧渲染把整段当一个字符串、只在最首行加 `'· '`：
 *   - 第 2..N 行顶到第 0 列 → 锯齿状（第 1 行有 `· `，续行没有对齐）；
 *   - 多次 print 的记号各自只落在自己那行行首，续行无对齐 → 混排难看；
 *   - `── Amoo 答复 ──` / `── 执行计划 ──` 这类段标题与正文同权 dim → 无层级，难扫读；
 *   - CJK 软换行折回来的续行同样顶第 0 列（与第一条同源）。
 *
 * 本叶子只做「拆行 + 定记号 + 悬挂缩进 + 定强调级」四件纯判断，输出一份**固定结构**的
 * 行模型；宽度裁切与上色由 CC 组件负责（颜色只能从 theme/ccTheme.js 取，本叶子不碰）。
 * 单一真源：CC 表面（CcNoticeBlock）与任何未来的只读消费者都从这里取行模型，
 * 不再各自 `split('\n')` 后手工拼缩进。
 *
 * 硬约束（面板侧 AGENTS.md 的下沉）：
 *   ① 行模型一次性建成，render 里不新建对象/数组 —— 调用方 useMemo 后按 key 比对；
 *   ② 输入容差：null / 非字符串 / 空串 → 空行模型，绝不抛；
 *   ③ 只按行判断，不猜终端列宽（CJK 双宽等显示宽度是组件的职责）。
 */

// 首行记号与续行悬挂缩进。缩进宽度 = 记号宽度，续行因此天然对齐到首行正文之下。
const NOTICE_MARKER = '· ';
const NOTICE_HANG = '  ';

// 显示宽度簇住在共享 substrate（与 ink-components/ccOverlayLayout.js 的 clipLine 同一把尺子）。
// 纯叶子、零 IO，所以本叶子仍然不碰进程状态。
const { displayWidth, truncateToWidth } = require('../../../utils/text/width');

const KINDS = Object.freeze({
  // `── 段标题 ──`：给一点强调（非 dim 或加粗），让答复/计划的层级可扫读。
  SECTION: 'section',
  // 行首的 `✓ `/`✗ `/`⚠ `/`i ` 记号（consoleNotice.js / consoleError.js 的真前缀）。
  MARK: 'mark',
  PLAIN: 'plain',
});

// renderStatusText / renderDispatchResultText 的段标题形状。
const SECTION_RE = /^──\s*(.+?)\s*──$/;
// printSuccess / printError / printWarn / printInfo 落在行首的记号。**必须带尾随空格**：
// `i ` 而不是 `i`，否则正文里 "input 未找到" 这类行会被误判成记号行。
const MARK_TOKENS = Object.freeze(['✓ ', '✗ ', '⚠ ', 'i ', '! ', '• ']);

function _isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function _str(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

/**
 * 判定一行的强调级。只认**行首**：正文中间出现的同形字符不算记号，
 * 否则一段正常回复会被整段标成「状态行」。
 * @param {unknown} text
 * @returns {'section'|'mark'|'plain'}
 */
function classifyLine(text) {
  const trimmed = _str(text).trim();
  if (!trimmed) {
    return KINDS.PLAIN;
  }
  if (SECTION_RE.test(trimmed)) {
    return KINDS.SECTION;
  }
  for (const token of MARK_TOKENS) {
    if (trimmed.startsWith(token)) {
      return KINDS.MARK;
    }
  }
  return KINDS.PLAIN;
}

/**
 * 建 notice 行模型。
 * @param {unknown} text notice 全文（可能含 \n）
 * @param {object} [opts]
 * @param {number} [opts.maxLines] 行数上限；>0 且超出时截断并追加一行 `…（另有 N 行）`
 * @returns {{lines: Array<{key:string, marker:string, text:string, kind:string}>,
 *            total:number, truncated:boolean}}
 */
function buildNoticeLines(text, opts = {}) {
  const options = _isPlainObject(opts) ? opts : {};
  const cap = Number(options.maxLines);
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0;

  // 归一换行 + 去尾部空行（sink.text() 已去过一次，这里是 Leaf 自足的兜底）。
  const raw = _str(text).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  // 纯空白等价于「没有内容」：画一个只有 `· ` 的空行比不画更糟。
  const parts = raw.trim() === '' ? [] : raw.split('\n');
  const over = limit > 0 && parts.length > limit;
  const kept = over ? parts.slice(0, limit) : parts;

  const lines = kept.map((line, i) => ({
    key: `n${i}`,
    marker: i === 0 ? NOTICE_MARKER : NOTICE_HANG,
    text: line,
    kind: classifyLine(line),
  }));
  if (over) {
    lines.push({
      key: 'more',
      marker: NOTICE_HANG,
      text: `…（另有 ${parts.length - limit} 行）`,
      kind: KINDS.MARK,
    });
  }
  return { lines, total: parts.length, truncated: over };
}

/**
 * 按**显示宽度**把一行 notice 裁到 width（CJK 双宽感知、去内嵌换行）。
 *
 * 与 ink-components/ccOverlayLayout.js 的 `clipLine` 的差别只有一处：省略号。那个叶子
 * 用共享 substrate 的 `truncateToWidth`，尾部是 ASCII `...`（3 列）；AGENTS.md §0.7
 * 要求截断用 `…`（1 列）。这里做收窄替换 ⇒ 只会更短，不会把行顶超，也不必改共享叶子
 * （那会影响所有既有浮层）。
 *
 * @param {unknown} text
 * @param {number} width
 * @returns {string}
 */
function clipNoticeLine(text, width) {
  const str = _str(text).replace(/[\r\n]+/g, ' ');
  const w = Math.max(4, Math.floor(Number(width) || 4));
  if (displayWidth(str) <= w) {
    return str;
  }
  return truncateToWidth(str, w).replace(/\.{3}$/, '…');
}

module.exports = {
  NOTICE_MARKER,
  NOTICE_HANG,
  KINDS,
  SECTION_RE,
  MARK_TOKENS,
  classifyLine,
  buildNoticeLines,
  clipNoticeLine,
};
