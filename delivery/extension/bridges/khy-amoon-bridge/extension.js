'use strict';

/**
 * extension.js — KhyOS runtime plugin entry (manifest.main).
 *
 * Contract: the plugin loader resolves this file, requires it, and calls
 * activate(ctx) with a 5s timeout (runtime/node/backend/src/plugin-loader/index.js:731-761).
 * It must have NO side effects at require time: no daemon start, no stdin reads,
 * no child processes, no filesystem writes.
 *
 * The bridge itself is reached through the MCP stdio server (bin/mcp-server.js)
 * registered with `khy mcp add`, not through this plugin entry.
 */

let activated = false;

/**
 * @param {object} [ctx] KhyOS plugin context supplied by the loader.
 * @returns {Promise<{namespace: string, mcpEntry: string}>}
 */
async function activate(ctx) {
  activated = true;
  if (ctx && typeof ctx.logger === 'object' && ctx.logger && typeof ctx.logger.info === 'function') {
    ctx.logger.info('[amoon] extension activated (no runtime side effects)');
  }
  return { namespace: 'amoon', mcpEntry: 'bin/mcp-server.js' };
}

/**
 * @returns {Promise<void>}
 */
async function deactivate() {
  activated = false;
}

function isActivated() {
  return activated;
}

module.exports = { activate, deactivate, isActivated };
