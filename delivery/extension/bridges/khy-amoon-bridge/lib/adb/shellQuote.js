'use strict';

const adb = require('../adb');

module.exports = {
  shQuote: adb.shQuote,
  assertAsciiText: adb.assertAsciiText,
  assertSafeRemoteName: adb.assertSafeRemoteName,
};
