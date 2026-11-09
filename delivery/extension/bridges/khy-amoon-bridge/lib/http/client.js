'use strict';

/**
 * Contract path shim: the daemon HTTP client lives in lib/mcp.js.
 */

const mcp = require('../mcp');

function createBridgeClient(options = {}) {
  return mcp.createDaemonClient({
    config: options.config,
    logger: options.logger,
    autostart: options.autostart,
    startDaemon: options.startDaemon,
  });
}

module.exports = {
  createBridgeClient,
  createDaemonClient: mcp.createDaemonClient,
};
