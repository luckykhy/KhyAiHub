'use strict';

/**
 * taskSurface — 任务面板「底色 + 字形」策略层（DESIGN-ARCH-176 §3.1 / §3.2）。
 *
 * 职责：把「行状态」翻译成**底色与字形**两个通道的呈现决策。
 * 与既有 `taskLineStyle.js` 的关系是**通道分工，不是替代**：
 *   - `taskLineStyle` 管**前景**（color / bold / dim / strikethrough），本层不动它
 *   - `taskSurface`   管**背景**（backgroundColor / 字形冗余）
 * 两者共享同一个状态判据 `taskPanelLines.taskLineStatus`（图标逆映射 SSOT），
 * **绝不另立第二份图标表**。
 *
 * ★ 为什么要底色而不是线条（176 §3.1）：
 *   Ink 的 `render-background.js:19` 用**空格逐行填充** ⇒ 底色**不改字符数**
 *   ⇒ 不触发 Yoga reflow ⇒ 零残影。且不占额外行（框线占 2 行）。
 *
 * ★ 铁律（纯叶子，同 `chatChords.js` 规格）：
 *   零 IO · 确定性 · 绝不抛 · **绝不读 env** · 不改入参
 *   底色 token 由调用方从 `ccThemeBg.backgroundTokens()` 传入 —— 本层不require
 *   终端能力、不读 colorDepth，**只做「状态 → 用哪个 token 名」的纯映射**。
 */

// 图标 → 状态的判据复用既有 SSOT（taskPanelLines 的 ICON_STATUS 逆映射）。
const { taskLineStatus } = require('./taskPanelLines');

// ── 字形（无色/unknown 档下的冗余信息通道）────────────────────────
// ⚠ **这些不是「要显示的图标」**——行文本里已经带了 `taskPanelLines.js:16` 写入的
// `✓`/`→`/`✗`/`○`。本表是**冗余标记**，只在「颜色完全失效」时追加，
// 用于区分**字形相近**的两态（`✗` vs `○` 在小字号下容易看错）。
// 消费方拼行时必须**追加**而不是**替换**，否则会出现 `✓ ✓ 读取快照` 这类重复。
//
// `✗!` 的 `!` 就是这个冗余：失败必须被看见（TUI Design System「永远不要只用颜色」）。
const REDUNDANT_MARK = Object.freeze({
  // completed / pending 不需要冗余：✓ 与 ○ 字形本身已足够distinct，
  // 且 completed 另有删除线（taskLineStyle 的 strikethrough）双重提示。
  in_progress: '', // → 与 ○ 区分度足够
  error: '!', // ★ ✗ 与 ○ 在小字号下易混，追加叹号
  completed: '',
  pending: '',
});

// 状态 → 底色 token 名。**这是本层唯一的映射表**，消费方拿 token 名去
// ccThemeBg 的返回值里查色值；查不到（null）即「不设 backgroundColor」。
//
// unknown 档下 ccThemeBg 会把 bgActive/bgDanger 返 null ⇒ 自动退化为无底色，
// 状态区分落回字形。**这不是本层的分支逻辑，是 token 表的自然结果** ——
// 单一真源的好处就是降级不需要第二处判断。
const SURFACE_BY_STATUS = Object.freeze({
  in_progress: 'bgActive',
  error: 'bgDanger',
  // completed / pending 刻意不铺底色：
  // completed 已有删除线（taskLineStyle 的 strikethrough），再铺底色会双重降噪；
  // pending 保持「弱化未开始项」（taskLineStyle.js:26-27 已论证这是刻意设计）。
});

/**
 * 行 → 底色决策。
 *
 * @param {string} line - 行首带 ✓/→/✗/○ 图标的原始任务行
 * @param {object} tokens - `ccThemeBg.backgroundTokens()` 的返回值
 * @param {object} [opts]
 * @param {boolean} [opts.markFallback] - 无色/unknown 档下是否补冗余标记（默认 true）
 * @returns {{backgroundColor: ?string, mark: string, token: ?string, status: ?string}}
 *   - `backgroundColor: null` ⇒ **不要设 backgroundColor**（不是缺字段）
 *   - `mark` 是**要追加**的冗余标记（通常为空串），**不是替换行首图标**
 */
function surfaceForLine(line, tokens, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const status = taskLineStatus(line);
  if (!status) {
    // 行首非已知图标 → 保守：不铺底色、不加标记（诚实保留原行，绝不猜状态）
    return { backgroundColor: null, mark: '', token: null, status: null };
  }
  const tokenName = SURFACE_BY_STATUS[status] || null;
  const color = tokenName && tokens && typeof tokens === 'object' ? tokens[tokenName] || null : null;
  // 只有「该态本该有底色、但实际取不到」才补冗余标记
  // ⇒ completed/pending 刻意不铺底色，不会因此平白多出一个标记。
  const mark = (tokenName && !color && o.markFallback !== false)
    ? REDUNDANT_MARK[status] || ''
    : '';
  return { backgroundColor: color || null, mark, token: tokenName, status };
}

/**
 * 段头（分组标签）的底色决策。分组用**中性底色**，与状态底色区分开 ——
 * 这样「这一段属于哪一组」与「这一行是什么状态」是两个可独立扫读的维度。
 *
 * @param {object} tokens - `ccThemeBg.backgroundTokens()` 的返回值
 * @param {string} [variant] - 'subtle'（默认）| 'head'（面板头行）
 * @returns {?string} null ⇒ 不设 backgroundColor
 */
function surfaceForGroup(tokens, variant = 'subtle') {
  const name = variant === 'head' ? 'bgHead' : 'bgSubtle';
  if (!tokens || typeof tokens !== 'object') return null;
  return tokens[name] || null;
}

/**
 * 把一整批已渲染行按状态铺底色，返回可直接喂给 ink 的描述符数组。
 * 纯函数：入参行数组 + tokens ⇒ 新数组；不修改入参。
 *
 * @param {string[]} lines - 行首带状态图标的行
 * @param {object} tokens - `ccThemeBg.backgroundTokens()` 的返回值
 * @param {object} [opts] - 透传给 surfaceForLine
 * @returns {Array<{line: string, backgroundColor: ?string, mark: string, status: ?string}>}
 */
function surfaceAll(lines, tokens, opts = {}) {
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => {
    const d = surfaceForLine(line, tokens, opts);
    return { line: String(line == null ? '' : line), backgroundColor: d.backgroundColor, mark: d.mark, status: d.status };
  });
}

module.exports = {
  REDUNDANT_MARK,
  SURFACE_BY_STATUS,
  surfaceForLine,
  surfaceForGroup,
  surfaceAll,
};
