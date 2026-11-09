'use strict';

/**
 * Contract path shim: createAmoonTools(ctx) -> {amoon_send, amoon_inbox, mailbox_status}.
 */

const { createBridgeToolsFromContext } = require('../bridge-tools');

function createAmoonTools(ctx = {}) {
  const bridge = createBridgeToolsFromContext(ctx);
  return {
    amoon_send: bridge.handlers.amoon_send,
    amoon_inbox: bridge.handlers.amoon_inbox,
    mailbox_status: bridge.handlers.mailbox_status,
  };
}

module.exports = { createAmoonTools };
