'use strict';

/**
 * sgrHold.js — SGR 鼠标序列的「不完整前缀」判定（2026-10-10）。
 *
 * 病象（用户报「鼠标悬停/点击对不上」，实测附带伤害）：ConPTY 会把**一次**鼠标
 * 上报拆成两次 stdin 读交付 —— `\x1b[<` 与 `32;10;28M`。ink 的 pending-escape
 * 刷新（`setImmediate`）随后把前半段当成一个独立按键发出，于是：
 *   · 前半段 `[<` 不匹配 `isMouseSequence` 的完整序列正则 → 落进文本编辑；
 *   · 后半段 `32;10;28M` 更是纯文本 → **输入框里多出一串 `32;10;28M`**。
 * 点击序列短、一次写完时碰不到这条缝；悬停/拖拽的连续上报必中。
 *
 * 修法（App 侧，本叶子只提供判定）：把「不完整的 SGR 前缀」在按键处理器最前面
 * 按住，与下一笔拼回完整序列再走鼠标分发；60ms 兜底放行，终端半途消失也不
 * 永久吞字节（放行时逐字节落回旧行为）。
 *
 * 判定刻意收得很窄：只认 `[<` 开头、后跟数字/分号、**没有**终结字节 `M`/`m`
 * 的串。完整的点击/松开序列、方向键、以及用户真按的 Esc 全部不受影响。
 */

const PARTIAL_SGR_RE = /^\[<[0-9;]*$/;
const PARTIAL_SGR_ESC_RE = /^\x1b\[<[0-9;]*$/;

/** 按住时长（ms）：够覆盖 ConPTY 的两次读间隔，又远短于人类可感知的延迟。 */
const HOLD_MS = 60;

/** 不完整 SGR 前缀的保守长度上限（防异常输入无限堆积）。 */
const MAX_HOLD_LEN = 24;

/**
 * 这一笔是不是「不完整的 SGR 鼠标前缀」？
 * @param {string} input ink useInput 交出的原始输入（ESC 可能已被剥掉）
 * @returns {boolean}
 */
function isPartialSgr(input) {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_HOLD_LEN) {
    return false;
  }
  return PARTIAL_SGR_RE.test(input) || PARTIAL_SGR_ESC_RE.test(input);
}

module.exports = { isPartialSgr, HOLD_MS, MAX_HOLD_LEN, PARTIAL_SGR_RE };
