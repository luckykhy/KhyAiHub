'use strict';

/**
 * Regression: the MCP vision call site must bind to the module that actually exports
 * `callTool`. It previously required `src/cli/handlers/mcp`, whose export surface is
 * only `handleMcp`, so every `analyze_image` call threw
 * `TypeError: mcp.callTool is not a function` and the inner catch repackaged that as
 * an upstream "识图失败" line — a permanently dead feature dressed as a model error.
 *
 * Honest scope: this locks the *binding*, which is the defect. End-to-end recognition
 * additionally needs a connected MCP server (see `_resolveClient` →
 * `MCP server "…" not found` when nothing connected it); that receipt is out of reach
 * on a box without gateway credentials and is recorded as unclosed in
 * [DESIGN-LAY-008] §12.6.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, 'aiGatewayGenerateMethod.js');
const VISION_FN = '_callMcpVisionTool';

test(`${VISION_FN} does not require the CLI mcp handler`, () => {
  const src = fs.readFileSync(SRC, 'utf8');
  assert.ok(!src.includes("require('../../cli/handlers/mcp')"),
    'vision path must not bind to a CLI handler (export surface is handleMcp only)');
  assert.ok(!src.includes('require("../../cli/handlers/mcp")'),
    'vision path must not bind to a CLI handler (double-quote form)');
});

test('the bound target really provides callTool(serverName, toolName, args)', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const m = src.match(new RegExp(`require\\('(\\.\\./[^']*mcp[^']*)'\\)`));
  assert.ok(m, 'expected a relative require of an mcp module near the vision call site');
  const target = path.join(__dirname, m[1] + '.js');
  const targetDir = path.join(__dirname, m[1], 'index.js');
  assert.ok(fs.existsSync(target) || fs.existsSync(targetDir),
    `resolved require target must exist on disk: ${m[1]}`);

  const mcp = require(path.join(__dirname, m[1]));
  assert.equal(typeof mcp.callTool, 'function', 'callTool must be a function');
  assert.ok(mcp.callTool.length <= 3 && mcp.callTool.length >= 2,
    'callTool must accept (serverName, toolName, args?) like the call site passes');
});
