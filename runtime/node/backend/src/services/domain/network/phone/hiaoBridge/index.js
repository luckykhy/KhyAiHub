'use strict';

/**
 * index.js — star-assembly facade for the hiao bridge unit.
 *
 * Single import point for consumers (the HiaoBridge tool, any future CLI
 * handler): they require this directory, never a sibling. The unit is a second
 * profile next to `phone/` — same direction (PC dials the phone over adb), a
 * different protocol and a governance pipeline the StepBridge profile has no
 * equivalent for.
 *
 * No module-load side effects beyond the spreads: no adb is spawned, no socket
 * is opened, no token is read until a caller asks. The client is built lazily
 * so requiring this facade (which the tool module does at discovery time) never
 * resolves env or touches the device.
 */

const hiaoBridgeConfig = require('./hiaoBridgeConfig');
const hiaoBridgePolicy = require('./hiaoBridgePolicy');
const { createHiaoBridgeClient } = require('./hiaoBridgeClient');

let clientSingleton = null;

function getHiaoBridgeClient(env = process.env) {
  if (!clientSingleton) {
    clientSingleton = createHiaoBridgeClient({ env });
  }
  return clientSingleton;
}

function resetHiaoBridgeForTests() {
  if (clientSingleton) {
    clientSingleton.resetForTests();
  }
  clientSingleton = null;
}

module.exports = {
  ...hiaoBridgeConfig,
  ...hiaoBridgePolicy,
  createHiaoBridgeClient,
  getHiaoBridgeClient,
  resetHiaoBridgeForTests,
};
