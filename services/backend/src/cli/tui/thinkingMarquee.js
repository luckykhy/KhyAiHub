'use strict';

/**
 * thinkingMarquee — 流式思维链单行预览的「跟随尾部滑动窗口」纯叶子
 * (零 IO、确定性、绝不抛、可单测)。
 *
 * 为什么这里没有计时器:预览行的相位来自**已累积的推理字符数**,而 chunk 到达本身
 * 就在驱动 `App.js:_mainContentLines` 重算(该 memo 的 deps 含 `query.streaming`)
 * ⇒ 窗口推进是流式的副产品,免费。另起 setInterval 只会让**定格之后**的屏幕自己动,
 * 并且每 tick 重渲整棵 live 树;而 `check-tui-gates` 实测 232 > 227 门预算已透支,
 * 也不允许为它再开一个开关。
 *
 * 方向:窗口**起点**随文本增长向右推进 ⇒ 读者视线从左往右读过去,旧字符从左侧移出。
 * 若将来要反向(从尾部滑回开头),只有下面 `start` 一处算式要改。
 *
 * 宽度口径一律委托 wrapCell 的 `visWidth` 单一真源 —— 不按 `.length` 计费:CJK 每字
 * 占 2 列,按字符数切出的窗口实际 ≈2×width 宽,会被 Viewport 的 overflow:hidden 裁掉
 * 右半(BUG-32 同族)。
 */

const { visWidth } = require('./wrapCell');

// 换行压成单行 —— 与改造前的预览行口径逐字节一致(只换窗口逻辑,不动归一化)。
function _oneLine(text) {
  return String(text === null || text === undefined ? '' : text).replace(/\s*\n\s*/g, ' ');
}

/**
 * 取**不超过 width 个显示列**的尾部窗口。
 *
 * @param {string} text 已累积的推理全文(可含换行,内部压成单行)
 * @param {number} width 可用显示列数(非法/≤0 → 空窗口)
 * @returns {{text:string, headCut:boolean}} headCut = true 表示开头已移出窗口
 */
function tailWindow(text, width) {
  const t = _oneLine(text);
  const cap = Math.floor(Number(width));
  if (!Number.isFinite(cap) || cap <= 0) {
    return { text: '', headCut: false };
  }
  if (visWidth(t) <= cap) {
    return { text: t, headCut: false };
  }
  // 从尾部**倒着**按码点累加显示宽度,装不下即停。必须倒着走:正向数出的列数属于
  // 开头那段,而开头与结尾的字符宽度分布不同,拿它切尾部可能仍超宽。
  // 按码点(非 .slice(1))迭代 surrogate 对才能整对保留 —— 切开的半个代理对会在终端
  // 上打出乱码。
  const cps = Array.from(t);
  let acc = 0;
  let keep = 0;
  for (let i = cps.length - 1; i >= 0; i -= 1) {
    const w = visWidth(cps[i]);
    if (acc + w > cap) {
      break;
    }
    acc += w;
    keep += 1;
  }
  return { text: cps.slice(cps.length - keep).join(''), headCut: true };
}

module.exports = { tailWindow };
