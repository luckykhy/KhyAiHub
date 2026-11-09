'use strict';

/**
 * errors.js — the single error vocabulary and BridgeError class, re-exported
 * from the frozen contracts module so callers can require one module without
 * duplicating the tables.
 */

const C = require('./contracts');

module.exports = {
  BridgeError: C.BridgeError,
  isBridgeError: C.isBridgeError,
  ERROR_CODES: C.ERROR_CODES,
  EXIT_CODES: C.EXIT_CODES,
};
