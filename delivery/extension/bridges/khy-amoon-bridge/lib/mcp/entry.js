'use strict';

/**
 * Contract path shim: KhyOS MCP entry construction lives in lib/khy-tools.js.
 */

const khyTools = require('../khy-tools');

module.exports = {
  getMcpServerEntry: khyTools.getMcpServerEntry,
  buildMcpAddArgv: khyTools.buildMcpAddArgv,
  buildMcpRemoveArgv: khyTools.buildMcpRemoveArgv,
  findKhyOsInstallation: khyTools.findKhyOsInstallation,
};
