'use strict';

/**
 * Contract path shim: the lifecycle is lib/wireless.js#createWireless.
 */

const { createWireless } = require('../wireless');

module.exports = {
  createAdbLifecycle: createWireless,
};
