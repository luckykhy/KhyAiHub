'use strict';

/**
 * ToolExecutionPanel — 结构化工具执行输出的**显示端面板**（三级区域，全宽内联）。
 *
 * ## 它画什么
 *
 * 用户点名的输出顺序，三区自上而下：
 *
 *   第 1 区（最上）用户指令 —— 原样呈现，不改写 / 不摘要 / 不截断
 *   第 2 区（中段）过程     —— 交替的工具调用结构化日志（S3 的 DisplayLine.text）
 *   第 3 区（最下）总结     —— totals + usage[]，unfinished 是一等状态
 *
 * 次序**不是本组件决定的**：`cli/toolExecutionReport.js` 的 `REPORT_ZONES` 是封闭集合，
 * 组装按它 map。本组件只按 `zones` 数组的下标顺序画（0/1/2），并顺手把 S3 的
 * `orderViolations` 带出来供诊断。想调换次序只有一条路——改 `REPORT_ZONES`，而那有测试盯着。
 *
 * ## 范式：照 TaskListPanel
 *
 * 同一个位置（App.js 的区域④ TASK_PANEL 之后）、同一种全宽内联形态、同一个 1s `nowTick`
 * 心跳驱动重渲染、同一套高度账本（`liveRegionBudget` 经 `toolExecutionSink.panelRows()`
 * 前馈，见 App.js 的 `taskLineCount` 加项）。**不自己读终端尺寸、不自己读 env**——门控与
 * 行数一律经 sink 取，App 只登记 `onToolGroups` 与渲染这一个节点。
 *
 * ## `cols`：可用显示列数（不传 = 不钳）
 *
 * Ink 的 `<Text>` 默认 `wrap='wrap'`，一行超宽就折成多行 —— 于是「账本记 7 行、终端画 13 行」，
 * 少算的那几行又把 live 区顶过 rows，触发 §0.2 明禁的 fullscreen 清屏。故 App 把**这个面板
 * 实际占到的列宽**递进来（legacy 全宽；宽屏分支还要再减掉固定侧栏），sink 按它把每行钳到不折。
 * 钳宽不改变行数（一行钳完还是一行），所以高度账本不受影响。
 *
 * ## 零破坏
 *
 * 门关（`KHY_TUI_TOOL_GROUPS` 非 '1'）→ sink 返 null → 本组件返 null → App 的渲染树上
 * 这个位置**什么都不画**，高度账本加 0。与改动前逐字节相同（用户硬约束第一条）。
 *
 * ## 渲染安全（tui/AGENTS.md §0.2）
 *
 * 本组件**不产出任何 ANSI 字节**：没有 DECSTBM 滚动区、没有 `\x1B[2J`、没有绝对定位转义。
 * 颜色只走 Ink 的 `dimColor` 通道（主题的事，不是本层的事）；行文本已由 sink 过
 * `utils/ansiSanitizer`。零线条（DESIGN-ARCH-176 §3.1「去线条、用底色分层」）：分区靠
 * **明暗**（第 1/3 区 dim，第 2 区常亮）表达，不画 `— 标签 —`。
 *
 * ## fault isolation
 *
 * 与 TaskListPanel 同一条：任何异常（sink 抛、inkRuntime 未就绪、畸形 zones）一律
 * try/catch 吞掉返 null。面板是辅助显示，绝不能拖垮整个 TUI。
 */

const React = require('react');

const inkRuntime = require('../inkRuntime');
const toolExecutionSink = require('../toolExecutionSink');

function ToolExecutionPanel(props = {}) {
  let view;
  try {
    view = toolExecutionSink.snapshot({
      messages: props.messages,
      instruction: props.instruction,
      rows: props.rows,
      maxRows: props.maxRows,
      cols: props.cols,
    });
  } catch {
    return null; // sink 抛错 → 不画，绝不能把 ink 渲染树带崩
  }
  if (!view || !(view.rowCount > 0)) return null;

  let Box;
  let Text;
  try {
    const ink = inkRuntime.get();
    Box = ink.Box;
    Text = ink.Text;
    if (!Box || !Text) return null;
  } catch {
    return null; // ink 未加载（首帧前的窗口期）→ 不画
  }
  const h = React.createElement;
  const children = [];

  // 第 1 区：用户指令原文。dim 而不截断——三行 dim 让「这是用户自己说的话」与下面机器产出
  // 的过程区在视觉上分层，但不加任何标签行（标签行要占高度账本，而指令本身就是最好的标签）。
  for (let i = 0; i < view.instructionRows.length; i += 1) {
    children.push(h(Text, { key: `te-instr-${i}`, dimColor: true }, view.instructionRows[i]));
  }
  // 第 2 区：过程。常亮——这是用户主要要看的那一区。行文本是 S3 的 DisplayLine.text
  // （已含行首字形 / bullet / 截断标记），本组件不改写一个字符。
  for (let i = 0; i < view.processRows.length; i += 1) {
    children.push(h(Text, { key: `te-proc-${i}` }, view.processRows[i]));
  }
  // 第 3 区：结构化总结。dim——它是计数不是叙述，视觉权重应低于过程区。
  for (let i = 0; i < view.summaryRows.length; i += 1) {
    children.push(h(Text, { key: `te-sum-${i}`, dimColor: true }, view.summaryRows[i]));
  }
  // No marginTop / marginBottom: 面板的高度整块经 toolExecutionSink.panelRows() 前馈进
  // liveRegionBudget 的账本（与 TaskListPanel 同一手法）。多一个 margin 行就是一笔没记账的
  // 高度 ⇒ live 区可能顶过 terminal rows ⇒ 触发 ink 的 fullscreen \x1B[2J（§0.2 明禁）。
  // paddingX 保留 1：与 TaskListPanel 同款左呼吸位，只占列不占行。
  return h(Box, { flexDirection: 'column', paddingX: 1 }, ...children);
}

module.exports = ToolExecutionPanel;
