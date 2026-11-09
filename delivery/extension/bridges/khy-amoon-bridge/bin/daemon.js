#!/usr/bin/env node
'use strict';

/**
 * bin/daemon.js — detached daemon entry.
 *
 * `node bin/cli.js start` spawns this file with the inherited environment plus
 * KHY_AMOON_HOME/KHY_AMOON_PORT overrides. It is not meant to be run by hand
 * except for debugging (`node bin/daemon.js --state-dir <dir>`).
 */

const { runDaemonProcess } = require('../lib/daemon');

runDaemonProcess(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`daemon failed: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
