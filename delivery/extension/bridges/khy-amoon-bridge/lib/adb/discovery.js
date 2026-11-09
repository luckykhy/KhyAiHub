'use strict';

/**
 * Contract path shim: discovery lives in lib/adb.js + lib/wireless.js.
 * resolveSerial needs a transport + config, so it is built through the wireless
 * lifecycle rather than duplicated here.
 */

const adb = require('../adb');
const { createWireless } = require('../wireless');

function resolveSerial(options = {}) {
  const wireless = createWireless({
    config: options.config,
    transport: options.transport,
    logger: options.logger,
  });
  return wireless.resolveSerial(options);
}

module.exports = {
  resolveAdb: adb.resolveAdb,
  parseDevices: adb.parseDevices,
  parseMdns: adb.parseMdns,
  resolveSerial,
};
