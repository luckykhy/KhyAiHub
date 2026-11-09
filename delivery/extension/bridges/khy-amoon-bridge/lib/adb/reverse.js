'use strict';

/**
 * Contract path shim: reverse management is part of lib/wireless.js.
 */

const { createWireless } = require('../wireless');

function createReverse(options = {}) {
  const wireless = createWireless({
    config: options.config,
    transport: options.transport,
    logger: options.logger,
  });
  return {
    ensure: (port, opts) => wireless.ensureReverse(port, opts),
    remove: (port) => wireless.removeReverse(port),
    status: (port) => wireless.probeReverse(port),
    probe: (port, opts) => wireless.probeReverse(port, opts),
    list: () => wireless.reverseList(),
  };
}

module.exports = { createReverse };
