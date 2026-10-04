'use strict';

/**
 * tui/uiAdapter.js — TUI renderer for unified UI responses.
 *
 * Renders response objects using Ink/React components.
 *
 * NOTE: TUI mode cannot use inquirer (it conflicts with Ink for stdin).
 * For confirm/list/form we prefer the native overlays through uiBridge and
 * otherwise fall back to the stdin prompts in ./uiStdinFallbacks. That leaf is
 * shared with uiBridge and must not import this module — the mutual import used
 * to be a require cycle (uiAdapter ⇄ uiBridge).
 *
 * 错误/信息渲染与 CLI formatters.js 对齐: 统一前缀 + 可选 title + 结构化输出。
 */

const fallbacks = require('./uiStdinFallbacks');

/**
 * Show info message in TUI.
 * @param {object} response
 */
function showInfo(response) {
  const prefix = response.title ? response.title + ': ' : '';
  process.stderr.write(`  i ${prefix}${response.message}\n`);
}

/**
 * Show success message in TUI.
 * @param {object} response
 */
function showSuccess(response) {
  process.stderr.write(`  ✓ ${response.message}\n`);
}

/**
 * Show error message in TUI.
 * 与 CLI printErrorPanel 对齐: 显示 title + message + code(如有)。
 * @param {object} response
 */
function showError(response) {
  const title = response.title || '';
  const code = response.code ? ` (${response.code})` : '';
  if (title) {
    process.stderr.write(`  ✗ ${title}${code}: ${response.message}\n`);
  } else {
    process.stderr.write(`  ✗ ${response.message}${code}\n`);
  }
}

/**
 * Show confirmation in TUI.
 * @param {object} response
 * @returns {Promise<boolean>}
 */
async function showConfirm(response) {
  // Try native TUI component first (if App refs available)
  try {
    const bridge = require('./uiBridge');
    if (bridge.hasAppRefs()) {
      return bridge.showConfirmNative(response);
    }
  } catch {
    // Fall through to simple fallback
  }

  return fallbacks.showConfirm(response);
}

/**
 * Show list selection in TUI.
 * @param {object} response
 * @returns {Promise<string>} Selected item id
 */
async function showList(response) {
  // Try native TUI component first (if App refs available)
  try {
    const bridge = require('./uiBridge');
    if (bridge.hasAppRefs()) {
      return bridge.showListNative(response);
    }
  } catch {
    // Fall through to simple fallback
  }

  return fallbacks.showList(response);
}

/**
 * Show form input in TUI.
 * @param {object} response
 * @returns {Promise<object>} Form values
 */
async function showForm(response) {
  // Try native TUI component first (if App refs available)
  try {
    const bridge = require('./uiBridge');
    if (bridge.hasAppRefs()) {
      return bridge.showFormNative(response);
    }
  } catch {
    // Fall through to simple fallback
  }

  return fallbacks.showForm(response);
}

/**
 * Prompt a single field in TUI.
 * @param {object} field - Field definition
 * @returns {Promise<string>}
 */
function promptField(field) {
  return fallbacks.promptField(field);
}

module.exports = {
  showInfo,
  showSuccess,
  showError,
  showConfirm,
  showList,
  showForm,
  promptField,
};
