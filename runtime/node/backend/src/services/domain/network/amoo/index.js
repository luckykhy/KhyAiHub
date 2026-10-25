'use strict';

/**
 * index.js — star-assembly facade for the Amoo collaboration unit.
 *
 * One import point for every consumer. Siblings never require each other: the
 * leaves (config / policy / plan / snapshot) are pure and dependency-free, the
 * shells (client / mailbox / runner) take their collaborators through the
 * constructor, and this file is the only place they are wired together.
 *
 * Why a facade at all: the unit has three shells with a strict order
 * (runner → client → adb) plus a fallback (mailbox → client). Letting consumers
 * build that order themselves is how the wiring drifts; here it is built once
 * and `resetAmooForTests()` gives tests a clean slate.
 *
 * The read-only panel lane rides along here too: `AmooStatusProvider` (the only
 * shell that caches collectStatus for a UI) and `buildAmooPanelModel` (the pure
 * leaf that turns a snapshot into rows). Both are exported as references — the
 * provider is deliberately NOT instantiated here, because a panel that is never
 * opened must never have started a poll timer.
 *
 * Nothing at module load touches the filesystem or the phone: `getAppDataDir`
 * is passed as a function and only called when a scratch file is actually
 * needed.
 *
 * @module services/domain/network/amoo
 */

const { resolveAmooConfig } = require('./amooBridgeConfig');
const { AmooBridgeClient } = require('./amooBridgeClient');
const { AmooBridgeMailbox } = require('./amooMailbox');
const { AmooDispatchRunner } = require('./amooDispatchRunner');
const { buildAmooPanelModel } = require('./amooPanelViewModel');
const { AmooStatusProvider } = require('./amooStatusProvider');
const dataHome = require('../../../../utils/dataHome');

/**
 * Build a fresh, fully wired stack. Tests use this with injected fakes.
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {object} [opts.config]
 * @param {Function} [opts.spawnImpl]
 * @param {Function} [opts.sleep]
 * @param {Function} [opts.now]
 * @param {Function} [opts.getAppDataDir]
 * @returns {{config:object, client:AmooBridgeClient, mailbox:AmooBridgeMailbox,
 *            runner:AmooDispatchRunner}}
 */
function createAmooStack(opts = {}) {
  const config = opts.config || resolveAmooConfig(opts.env || process.env);
  const getAppDataDir =
    typeof opts.getAppDataDir === 'function' ? opts.getAppDataDir : dataHome.getAppDataDir;
  const shared = {
    spawnImpl: opts.spawnImpl,
    sleep: opts.sleep,
    now: opts.now,
  };
  const client = new AmooBridgeClient({ config, ...shared });
  const mailbox = new AmooBridgeMailbox({ config, client, getAppDataDir, ...shared });
  const runner = new AmooDispatchRunner({ config, client, mailbox, getAppDataDir, ...shared });
  return { config, client, mailbox, runner };
}

const defaultStack = createAmooStack();

/**
 * Drop cached secrets/state on the default stack. Called by tests between cases
 * so a token fetched for one device never leaks into the next.
 * @returns {{ok:boolean}}
 */
function resetAmooForTests() {
  defaultStack.client.invalidateToken();
  return { ok: true };
}

module.exports = {
  ...defaultStack,
  createAmooStack,
  resetAmooForTests,
  resolveAmooConfig,
  AmooBridgeClient,
  AmooBridgeMailbox,
  AmooDispatchRunner,
  AmooStatusProvider,
  buildAmooPanelModel,
  dataHome,
};
