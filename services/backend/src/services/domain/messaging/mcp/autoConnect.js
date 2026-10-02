'use strict';

/**
 * MCP auto-connect (the missing runtime trigger).
 *
 * The consumer-side MCP client (services/mcp/index.js) was fully built and
 * unit-tested — stdio/HTTP/SSE transports, JSON-RPC, OAuth, collision-safe
 * `mcp__server__tool` naming, a per-turn registry refresh (toolPool.js) — but
 * NOTHING in production ever called `connectAll()`. Consequence:
 * `refreshMcpToolPool()` ran every loop turn yet `getConnectedServers()` was
 * always empty, so tools from a user's configured external MCP servers
 * (`~/.khy/mcp.json` / `<project>/.khy/mcp.json`) were never reachable.
 *
 * This leaf closes that gap with a one-shot, best-effort connect that runs once
 * per process at loop entry, mirroring the lazy `_getHookSystem()` pattern:
 *
 *   - One-shot: a latch (process-level by default, injectable for tests) ensures
 *     we connect at most once per process; persistent connections then survive
 *     across turns and the per-turn refresh picks up their tools.
 *   - Gated: `KHY_MCP_AUTOCONNECT` (default ON). Setting it to `false` yields the
 *     exact legacy behaviour (servers never connect) — byte-identical rollback.
 *   - Zero-cost when idle: if no servers are configured, returns immediately
 *     without spawning anything (the common case — no servers ship by default).
 *   - Best-effort: never throws. A connect failure must never break the loop.
 *
 * Dependencies (manager / env / latch state) are injectable so the decision and
 * dispatch logic are unit-testable with fakes — no subprocess, no network.
 */

// The default manager is the consumer-side MCP client (this directory's index),
// which owns loadConfig() + connectAll(). (It was previously pointed at the
// agent registry, which has neither — so the production call sites silently
// never connected any configured MCP server.)
const defaultManager = require('./index');

/**
 * Whether auto-connect is enabled. Default ON; only an explicit `false`
 * (case-insensitive) disables it, so the gate-off path is the legacy behaviour.
 * @param {object} [env]
 * @returns {boolean}
 */
function autoConnectEnabled(env = process.env) {
  return String((env && env.KHY_MCP_AUTOCONNECT) || '').toLowerCase() !== 'false';
}

/**
 * 连接失败/未连接的**用户可见文案**（纯函数，零 IO —— 便于单测锁定措辞）。
 *
 * 为什么需要它：MCP server 是**可选工具**（如 deepseek-eyes 提供图像识别），
 * 连不上不影响页面可用、不影响对话 —— 它是 fire-and-forget 的增强项。
 * 但历史上失败行走的是 `✗`（红色叉），用户把它读成「khy 启动出错」，
 * 于是「启动慢」的抱怨里混进了一个其实无害的噪声。
 *
 * 措辞纪律：必须同时给出（a）未连接的事实（b）「可选、不影响使用」的定性。
 * 少了 (b)，用户仍然会以为是故障；少了 (a)，排障时又找不到线索。
 *
 * @param {{name: string, error: string}} failure
 * @param {{done: number, total: number}} [progress]
 * @returns {string}
 */
function formatConnectFailure(failure, progress) {
  const name = (failure && failure.name) || 'unknown';
  const error = (failure && failure.error) || 'unknown error';
  const prefix =
    progress && Number.isFinite(progress.done) && Number.isFinite(progress.total)
      ? `[${progress.done}/${progress.total} ${((progress.done / progress.total) * 100)
          .toFixed(1)
          .padStart(5)}%] `
      : '';
  return `${prefix}! ${name} 未连接（可选工具，不影响使用）: ${error}`;
}

/**
 * 整轮汇总文案：N 个可选工具未连接。
 * @param {Array} failures
 * @returns {string}
 */
function formatConnectFailureSummary(failures) {
  const n = Array.isArray(failures) ? failures.length : 0;
  return `${n} 个可选工具未连接（不影响页面与对话，需要时可在设置里重连）:`;
}

// Process-level one-shot latch (default). Tests inject their own `state` to stay
// isolated, so no reset hook is needed.
const _processState = { started: false };

/**
 * Connect to configured client-side MCP servers exactly once per process.
 *
 * @param {object} [opts]
 * @param {object} [opts.manager]    MCP manager (default: services/mcp/index).
 * @param {object} [opts.env]        env source (default: process.env).
 * @param {string} [opts.projectDir] project dir for project-local mcp.json.
 * @param {{started:boolean}} [opts.state] one-shot latch (default: process singleton).
 * @returns {Promise<{connected?:string[], failed?:object[], skipped?:string, error?:string}>}
 */
async function ensureMcpConnected({
  manager = defaultManager,
  env = process.env,
  projectDir,
  state,
  onProgress,
} = {}) {
  const st = state || _processState;
  if (st.started) {
    return { skipped: 'already-started' };
  }
  st.started = true;

  // Gate OFF → legacy behaviour: never connect.
  if (!autoConnectEnabled(env)) {
    return { skipped: 'disabled' };
  }

  try {
    // Cheap pre-check: don't pay any connect cost when nothing is configured.
    const cfg =
      typeof manager.loadConfig === 'function'
        ? manager.loadConfig(projectDir) || { mcpServers: {} }
        : { mcpServers: {} };
    const names = Object.keys(cfg.mcpServers || {});
    if (!names.length) {
      return { skipped: 'no-servers' };
    }

    if (typeof manager.connectAll !== 'function') {
      return { skipped: 'unsupported' };
    }
    // UX: 传递 onProgress 回调给 connectAll,实现每台服务器的连接进度反馈
    const res = await manager.connectAll(projectDir, onProgress);
    return {
      connected: (res && res.connected) || [],
      failed: (res && res.failed) || [],
    };
  } catch (e) {
    // Best-effort: surface the message for diagnostics but never throw.
    return { error: e && e.message ? e.message : String(e) };
  }
}

module.exports = {
  ensureMcpConnected,
  autoConnectEnabled,
  formatConnectFailure,
  formatConnectFailureSummary,
};
