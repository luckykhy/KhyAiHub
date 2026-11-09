'use strict';

/**
 * Contract path shim: lib/adb/transport.js -> lib/adb.js.
 * The module was delivered as a single file; contracts.MODULES.B paths are kept
 * working with these re-exports so callers never have to branch on the layout.
 */

module.exports = require('../adb');
