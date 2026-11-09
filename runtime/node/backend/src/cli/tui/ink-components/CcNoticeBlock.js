'use strict';

/**
 * CcNoticeBlock.js — CC 表面的多行 notice 渲染器（Cc 前缀 = CC 模式专用）。
 *
 * 只做呈现：行模型全部来自纯叶子 ../utils/ccNoticeLines.js，本组件零 IO、零判断。
 * 修的是收集式命令输出（`khy phone status` / `khy amoo status` / `khy amoo send`）
 * 在会话里的可读性：续行悬挂缩进对齐到 `· ` 之下，段标题（`── … ──`）与记号行
 * （`  ✓ ` / `  i ` / `  ⚠ `）与正文分层。
 *
 * 三条纪律：
 *   - 颜色只从 theme/ccTheme.js 的 CC_COLORS 取，不写 hex；
 *   - 每行恰好一行：clipLine 按**显示宽度**裁切（CJK 双宽感知）+ `wrap:'truncate'`，
 *     所以帧高账本可以直接数行模型的行数（CcApp.estimateMessageRows 就这么算）；
 *   - 门控写在父组件（CcApp 只在 CC 模式挂载），本组件内部不读 KHY_CC_TUI。
 */

const React = require('react');
// inkRuntime 是 ESM 桥接：顶层 .get() 会在 loadInk() 之前 require 本模块时抛错。
// 与 CcViewStack / CcToast 同一惰性模式 —— 组件渲染时（loadInk 之后）才取。
const inkRuntime = require('../inkRuntime');
const { CC_COLORS } = require('../theme/ccTheme');
const { buildNoticeLines, clipNoticeLine, KINDS } = require('../utils/ccNoticeLines');
// 尺寸真源：与 CcCommandPalette / CcHelpMenu 同一把尺子（BUG-73 的修法）。
const ccLayout = require('./ccOverlayLayout');

/**
 * @param {object} props
 * @param {unknown} props.content notice 全文（多行字符串）
 * @param {number} [props.cols] 宿主传入的列数；缺省走 ccOverlayLayout.termSize
 * @param {number} [props.maxLines] 行数上限，超出截断并标注
 * @param {boolean} [props.gap] 消息前的 marginTop 空行。短终端上这一行由
 *        chromeBudget.ccGapPlan 判给帧高（BUG-91），画不画由账本说，不是组件自己定
 *        —— 与 CcAssistantMessage 的 `gap` 同一条纪律：账本不留下它就不画。
 */
function CcNoticeBlock({ content, cols, maxLines, gap = true }) {
  const { Box, Text } = inkRuntime.get();

  // useMemo：行模型按 content 缓存，render 里不新建对象/数组。
  const model = React.useMemo(() => buildNoticeLines(content, { maxLines }), [content, maxLines]);
  if (model.lines.length === 0) {
    return null;
  }
  const inner = Math.max(8, ccLayout.termSize('cols', cols) - 1);

  return React.createElement(
    Box,
    { flexDirection: 'column', marginTop: gap ? 1 : 0 },
    model.lines.map((ln) => {
      const isSection = ln.kind === KINDS.SECTION;
      return React.createElement(
        Text,
        {
          key: ln.key,
          // 段标题不加 dim、给次要色：它是层级信号，不是同权正文。
          dimColor: !isSection,
          bold: isSection,
          color: isSection ? CC_COLORS.textSecondary : undefined,
          wrap: 'truncate',
        },
        clipNoticeLine(ln.marker + ln.text, inner)
      );
    })
  );
}

module.exports = {
  CcNoticeBlock: React.memo(CcNoticeBlock),
};
