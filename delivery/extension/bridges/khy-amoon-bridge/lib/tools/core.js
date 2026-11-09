'use strict';

/**
 * Contract path shim: createCoreTools(ctx) -> {ping, bridge_status}.
 */

const { createBridgeToolsFromContext } = require('../bridge-tools');

function createCoreTools(ctx = {}) {
  const bridge = createBridgeToolsFromContext(ctx);
  return {
    ping: bridge.handlers.ping,
    bridge_status: bridge.handlers.bridge_status,
  };
}

module.exports = { createCoreTools };
