'use strict';

/**
 * Contract path shim: createKhyTools(ctx) -> {khy_ask}.
 */

const { createBridgeToolsFromContext } = require('../bridge-tools');

function createKhyTools(ctx = {}) {
  const bridge = createBridgeToolsFromContext(ctx);
  return { khy_ask: bridge.handlers.khy_ask };
}

module.exports = { createKhyTools };
