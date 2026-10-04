'use strict';

/**
 * statusMessageFormatter — pure leaf (zero IO, deterministic, never throws, unit-testable).
 *
 * Home of record since 2026-09-28 ([RESEARCH-018] §3.1 P1: shared substrate / D3). It used to
 * sit under cli/ only because its first consumer was a TUI status line; `cli/statusMessageFormatter.js`
 * is now a pure re-export shell pointing here, and services require this file directly instead of
 * bootstrapping the CLI through `services/cliLeafPort`.
 *
 * Single source of truth for composing AGENTS.md Rule 2 compliant status text:
 * every user-facing status line must carry action + target + progress. This leaf
 * only assembles the string; callers supply the three dimensions.
 *
 *   - with progress: `${action} ${target}（${progress}）`
 *   - empty progress: `${action} ${target}…`  (trailing ellipsis fallback)
 *
 * Inputs are coerced to trimmed strings so a null/undefined arg never throws.
 */

/**
 * Compose an action + target + progress status message.
 * @param {string} action  operation verb (连接 / 解析 / 下载 …)
 * @param {string} target  object being acted on (PostgreSQL / AST / a file …)
 * @param {string} [progress] quantifiable progress signal (n/m, %, 第 n 次, bytes …)
 * @returns {string} composed status message
 */
function formatStatusMessage(action, target, progress) {
  const a = String(action == null ? '' : action).trim();
  const t = String(target == null ? '' : target).trim();
  const p = String(progress == null ? '' : progress).trim();
  const head = [a, t].filter(Boolean).join(' ');
  if (!head) {
    return p ? `（${p}）` : '…';
  }
  return p ? `${head}（${p}）` : `${head}…`;
}

module.exports = { formatStatusMessage };
