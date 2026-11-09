'use strict';

/**
 * Contract path shim: MCP stdio lives in lib/mcp.js.
 */

const mcp = require('../mcp');

module.exports = {
  createStdioServer: mcp.createStdioServer,
  createContext: mcp.createContext,
  toolList: () => mcp.createContext({}).toolList(),
  handleMessage: mcp.handleMessage,
  handleLine: mcp.handleLine,
  runStdio: mcp.runStdio,
};
