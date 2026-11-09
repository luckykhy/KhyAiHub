'use strict';

/**
 * Contract path shim: phone handlers live in lib/phone-tools.js.
 */

const { createPhoneTools } = require('../phone-tools');

module.exports = { createPhoneTools };
