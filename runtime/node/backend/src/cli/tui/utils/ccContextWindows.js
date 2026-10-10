'use strict';

/**
 * ccContextWindows.js —— 模型上下文窗口大小（tokens）
 *
 * 用于状态栏 Context 百分比计算。
 *
 * ⚠ 窗口值本身已迁到 constants/modelContextWindows.js（全仓单一真源）。本文件保留
 * 是因为 TUI 的三个导出名被 CcStatusLine / CcApp 与 tests/cli/tui/* 消费，删了会连带
 * 改 public API（TUI AGENTS §0.1）。**要新增/修正某个模型的窗口，改真源，不要改这里。**
 *
 * 参考：[DESIGN-ARCH-081] OpenAI 模型上下文窗口
 */

const {
  MODEL_CONTEXT_WINDOWS,
  resolveModelContextWindow,
} = require('../../../constants/modelContextWindows');
const { UNKNOWN_MODEL_CONTEXT_WINDOW } = require('../../../constants/contextWindowDefaults');

const DEFAULT_CONTEXT_WINDOW = UNKNOWN_MODEL_CONTEXT_WINDOW;

/**
 * 获取模型的上下文窗口大小
 * @param {string} modelId
 * @returns {number} token 数
 */
function getContextWindow(modelId) {
  return resolveModelContextWindow(modelId, DEFAULT_CONTEXT_WINDOW);
}

module.exports = { MODEL_CONTEXT_WINDOWS, DEFAULT_CONTEXT_WINDOW, getContextWindow };
