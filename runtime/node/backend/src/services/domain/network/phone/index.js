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
const { createPhoneBridgeMailbox } = require('./phoneBridgeMailbox');
const { createPhoneBridgeClient } = require('./phoneBridgeClient');

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
  createPhoneBridgeMailbox,
  createPhoneBridgeClient,
  getPhoneBridgeClient,
  resetPhoneBridgeForTests,
};
