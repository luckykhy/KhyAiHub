#!/usr/bin/env node
'use strict';

/**
 * bin/mcp-server.js — thin MCP stdio entry point.
 *
 * All framing, tool dispatch and daemon HTTP live in lib/mcp.js. This file only:
 *   1. parses argv (--root / --state-dir / --khy-js / --no-autostart);
 *   2. loads the per-user config and creates a stderr-only logger;
 *   3. starts lib/mcp.js createStdioServer().
 *
 * Compatibility: the skeleton exported handleMessage/handleLine/runStdio from
 * this file. Those names are re-exported here so existing tests and callers
 * keep working; their implementation is now in lib/mcp.js.
 *
 * stdout is protocol-only. --help writes to stderr on purpose.
 */

const mcp = require('../lib/mcp');

module.exports = {
  SERVER_INFO: mcp.SERVER_INFO,
  DEFAULT_PROTOCOL_VERSION: mcp.DEFAULT_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS: mcp.SUPPORTED_PROTOCOL_VERSIONS,
  INSTRUCTIONS: mcp.INSTRUCTIONS,
  createStdioServer: mcp.createStdioServer,
  createContext: mcp.createContext,
  createDaemonClient: mcp.createDaemonClient,
  callTool: mcp.callTool,
  handleMessage: mcp.handleMessage,
  handleLine: mcp.handleLine,
  runStdio: mcp.runStdio,
  parseServerArgs: mcp.parseServerArgs,
  startFromProcess: mcp.startFromProcess,
};

if (require.main === module) {
  mcp.startFromProcess(process.argv.slice(2));
}
