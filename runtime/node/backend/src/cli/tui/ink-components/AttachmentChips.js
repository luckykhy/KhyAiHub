'use strict';

/**
 * AttachmentChips — 终端侧的附件 chip 行（Ink TUI 输入框上方 + 提交后的回显共用）。
 *
 * 在这之前，两个面各自只有「数量」：输入框是 `已附加 N 张图片`（ChatColumn），回显是
 * `×N`（Transcript / transcriptLines）。用户在窄终端里没法回答「我刚贴的到底是哪一份」，
 * 多张时更没法对上号。
 *
 * 形态：`[PDF] 报告.pdf  [MD] 说明.md` —— 标签用扩展名同词（见 cli/attachmentFormat），
 * 只有 image / pdf / sheet / slide / md 五个桶上色（与桌面端 attachmentTint 同一批），
 * 其余继承终端前景。**不加 `×`**：终端 chip 点不掉（删除仍是 Esc 清空 / 空输入退格删末张），
 * 画一个按不动的叉比不画更糟。
 *
 * 宽度交给 Ink 的 flexWrap —— 终端列宽不可控，硬折行会在窄终端里错位；中文名是双宽，
 * 任何手工列宽预算都要走 wrapCell，这里不重复造。
 */

const React = require('react');

const inkRuntime = require('../inkRuntime');
const attachmentFormat = require('../../attachmentFormat');

/**
 * @param {{attachments?: Array<{name?:string, format?:string, size?:number}>}} props
 */
function AttachmentChips({ attachments }) {
  const { Box, Text } = inkRuntime.get();
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) {
    return null;
  }
  const h = React.createElement;
  return h(
    Box,
    { flexDirection: 'row', flexWrap: 'wrap', columnGap: 2 },
    ...list.map((att, index) => {
      // format 缺省时按名字现算，调用方不必先规范化一遍（fail-soft，绝不抛）。
      const format =
        att && att.format ? att.format : attachmentFormat.attachmentFormat(att && att.name);
      const tag = attachmentFormat.formatTag(format);
      const name = attachmentFormat.attachmentBasename(att && att.name) || '未命名';
      return h(
        Text,
        { key: `att${index}` },
        h(Text, { color: attachmentFormat.formatTint(format) }, `[${tag}]`),
        ` ${name}`
      );
    })
  );
}

module.exports = { AttachmentChips };
