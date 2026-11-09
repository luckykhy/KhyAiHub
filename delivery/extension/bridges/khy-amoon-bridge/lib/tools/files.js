'use strict';

/**
 * Contract path shim: Phase 2 file tools come from lib/phone-tools.js.
 * They are intentionally not registered by lib/registry.js in Phase 1.
 */

const { createPhoneTools } = require('../phone-tools');

function createFileTools(ctx = {}) {
  const phone = createPhoneTools(ctx);
  return {
    phone_file_push: phone.phone_file_push,
    phone_file_pull: phone.phone_file_pull,
  };
}

module.exports = { createFileTools };
