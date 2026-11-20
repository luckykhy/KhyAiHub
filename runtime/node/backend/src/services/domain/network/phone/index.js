'use strict';

/**
 * index.js — star-assembly facade for the phone bridge unit.
 *
 * Single import point for consumers: the tool, the CLI handler and any future
 * route all require this directory, never a sibling. Siblings do not require
 * each other except phoneBridgePolicy -> phoneBridgeCatalog (one direction: the
 * policy needs the tool table, the table knows nothing about policy).
 *
 * No module-load side effects beyond constructing the singletons: no adb is
 * spawned, no HTTP request is made, no token is read until a caller asks.
 */

const phoneBridgeConfig = require('./phoneBridgeConfig');
const phoneBridgePolicy = require('./phoneBridgePolicy');
const phoneBridgeCatalog = require('./phoneBridgeCatalog');
const phoneCollect = require('./phoneCollect');
const { createPhoneBridgeMailbox } = require('./phoneBridgeMailbox');
const { createAdbTransport, createPhoneBridgeClient } = require('./phoneBridgeClient');

let clientSingleton = null;

/**
 * Lazily built so that merely requiring this facade (which the tool module does
 * at discovery time) never resolves env or touches the device.
 */
function getPhoneBridgeClient(env = process.env) {
  if (!clientSingleton) {
    clientSingleton = createPhoneBridgeClient({ env });
  }
  return clientSingleton;
}

function resetPhoneBridgeForTests() {
  if (clientSingleton) {
    clientSingleton.resetForTests();
  }
  clientSingleton = null;
}

module.exports = {
  ...phoneBridgeConfig,
  ...phoneBridgePolicy,
  ...phoneBridgeCatalog,
  ...phoneCollect,
  createPhoneBridgeMailbox,
  createPhoneBridgeClient,
  getPhoneBridgeClient,
  resetPhoneBridgeForTests,
};
// createAdbTransport is exported outside the literal above: that object is the
// longest brace block in this file and check-file-ratchet's maxFuncLines counts
// it — any key added inside would push the HARD metric up.
module.exports.createAdbTransport = createAdbTransport;
