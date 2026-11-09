'use strict';

/**
 * smoke.test.js — the scaffold's minimum proof:
 *   - contracts and manifest agree on the 8 Phase 1 tools;
 *   - config resolves a per-user state dir and fails closed on a missing token;
 *   - the logger redacts tokens/bodies;
 *   - CLI --help works and unimplemented commands exit with an explicit code;
 *   - the MCP stdio skeleton answers initialize/tools/list and emits protocol only.
 *
 * It deliberately touches no ADB, HTTP server, mailbox, or daemon code.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const ROOT = path.resolve(__dirname, '..');
const C = require('../lib/contracts');
const { loadConfig, resolveStateDir, ensureStateDirs, requireOperatorToken } = require('../lib/config');
const { createLogger } = require('../lib/logger');
const cli = require('../bin/cli');
const mcp = require('../bin/mcp-server');

const PHASE1 = [
  'ping',
  'bridge_status',
  'khy_ask',
  'phone_screenshot',
  'phone_ui_dump',
  'phone_info',
  'phone_app_list',
  'phone_ls',
  'phone_exec',
  'amoon_send',
  'amoon_inbox',
  'mailbox_status',
];

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoon-smoke-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function capture() {
  const state = { out: '', err: '' };
  return {
    stdout: { write: (s) => { state.out += String(s); } },
    stderr: { write: (s) => { state.err += String(s); } },
    get out() { return state.out; },
    get err() { return state.err; },
  };
}

test('contracts expose exactly the 12 Phase 1 tools', () => {
  assert.deepEqual([...C.listToolNames()].sort(), [...PHASE1].sort());
  assert.equal(new Set(C.listToolNames()).size, 12);
  assert.equal(C.TOOLS.length, 12);

  for (const tool of C.TOOLS) {
    assert.equal(tool.phase, 1, `${tool.name} must be Phase 1`);
    assert.ok(tool.scopes.length > 0, `${tool.name} needs a scope`);
    assert.ok(tool.timeoutMs > 0);
    assert.ok(tool.responseMaxBytes <= C.LIMITS.responseHardMaxBytes);
    assert.equal(tool.inputSchema.type, 'object');
  }

  // file scope is the unauthenticated mailbox: never model or phone control.
  const fileTools = C.listToolsForScope('file').map((t) => t.name);
  assert.deepEqual([...fileTools].sort(), ['bridge_status', 'mailbox_status', 'ping']);
  assert.ok(!fileTools.includes('khy_ask'));
  assert.ok(C.getTool('phone_screenshot').scopes.includes('operator'));

  assert.equal(C.TOOL_POLICY.phoneAsk.defaultEnabled, false);
  assert.equal(C.TOOL_POLICY.sentinelTool, '__khy_amoon_no_tools__');
  assert.equal(C.TOOL_POLICY.phoneAsk.overrides.allowedTools[0], C.TOOL_POLICY.sentinelTool);

  for (const name of C.PHASE2_TOOL_NAMES) {
    assert.equal(C.getTool(name), null, `${name} must not be registered in Phase 1`);
  }

  // Cross-module shapes module C will receive/return.
  for (const key of ['config', 'adb', 'principal', 'audit']) {
    assert.ok(C.TOOL_CONTEXT_KEYS.includes(key), `ToolContext must include ${key}`);
  }
  assert.deepEqual([...C.ENVELOPE_FIELDS].slice(0, 3), ['ok', 'id', 'tool']);
});

test('manifest matches the contracts and the real KhyOS manifest rules', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'khy.extension.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert.equal(manifest.id, path.basename(ROOT));
  assert.equal(manifest.kind, 'runtime');
  assert.equal(manifest.namespace, 'amoon');
  assert.equal(typeof manifest.engines.khy, 'string');
  assert.ok(fs.existsSync(path.join(ROOT, manifest.main)), 'manifest.main must exist');
  assert.deepEqual(manifest.mcp.tools, C.listToolNames());
  assert.ok(manifest.capabilities.includes('mcp'));
  assert.ok(manifest.provides.includes('amoon-bridge'));
  assert.equal(manifest.schemaVersion, undefined, 'v1 manifest must not declare schemaVersion 2.0');

  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies, undefined, 'zero third-party dependencies');
  assert.equal(pkg.bin['khy-amoon-bridge'], 'bin/cli.js');
  assert.equal(pkg.scripts.test, 'node --test');
  assert.ok(fs.existsSync(path.join(ROOT, pkg.bin['khy-amoon-bridge'])));
});

test('config resolves a per-user state dir and validates inputs', (t) => {
  const tmp = tempDir(t);
  const env = { LOCALAPPDATA: tmp };

  assert.equal(resolveStateDir({ env, platform: 'win32' }), path.join(tmp, C.LOCAL_DIR_NAME));
  assert.equal(
    resolveStateDir({ env: { ...env, [C.ENV.home]: path.join(tmp, 'shared') }, platform: 'win32' }),
    path.join(tmp, 'shared')
  );

  assert.throws(() => loadConfig({ env: { ...env, [C.ENV.port]: '80' } }), /端口/);
  assert.throws(() => loadConfig({ env: { ...env, [C.ENV.port]: 'abc' } }), /端口/);
  assert.throws(() => loadConfig({ env: { ...env, [C.ENV.serial]: '--evil' } }), /SERIAL/);

  const config = loadConfig({ env, platform: 'win32' });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, C.DEFAULTS.port);
  assert.equal(config.stateDir, path.join(tmp, C.LOCAL_DIR_NAME));
  assert.equal(config.enabled, true);
  assert.equal(config.allowPhoneAsk, false);
  assert.equal(config.allowHighRisk, false);
  assert.equal(config.paths.operatorToken, path.join(config.stateDir, C.STATE_FILES.operatorToken));

  // Token access must fail closed, not return an empty string.
  assert.throws(() => requireOperatorToken(config), (err) => err.code === 'auth_unavailable');

  const dirs = ensureStateDirs(config);
  assert.ok(dirs.length >= 2);
  for (const dir of dirs) assert.ok(fs.statSync(dir).isDirectory());
  assert.ok(!fs.existsSync(config.paths.operatorToken), 'ensureStateDirs must not create tokens');
});

test('logger redacts tokens and message bodies', (t) => {
  const tmp = tempDir(t);
  const file = path.join(tmp, 'daemon.log');
  const logger = createLogger({ level: 'debug', file, stderr: null });
  const token = `khy_${'a'.repeat(40)}`;

  logger.info('outbound message', { token, text: 'private body', nested: { authorization: token } });

  const line = fs.readFileSync(file, 'utf8').trim();
  const record = JSON.parse(line);
  assert.equal(record.msg, 'outbound message');
  assert.equal(record.token, '[redacted]');
  assert.equal(record.text, '[redacted]');
  assert.equal(record.nested.authorization, '[redacted]');
  assert.ok(!line.includes(token), 'raw token must never be written');
  assert.ok(!line.includes('private body'), 'message bodies must never be written');
});

test('CLI --help exits 0 and documents every command', async () => {
  const io = capture();
  const code = await cli.main(['--help'], { stdout: io.stdout, stderr: io.stderr, env: {} });
  assert.equal(code, 0);
  assert.equal(io.err, '');
  for (const name of ['start', 'stop', 'status', 'doctor', 'call', 'phone', 'install', 'uninstall']) {
    assert.ok(io.out.includes(name), `help must mention ${name}`);
  }
  assert.match(io.out, /Phase 1/);
});

test('CLI call without a daemon exits 3 and never auto-starts when told not to', async (t) => {
  const tmp = tempDir(t);
  const stateDir = path.join(tmp, 'state');
  const io = capture();
  const code = await cli.main(['call', 'ping', '--json', '--no-autostart'], {
    stdout: io.stdout,
    stderr: io.stderr,
    env: { [C.ENV.home]: stateDir },
  });
  assert.equal(code, 3);
  const payload = JSON.parse(io.out);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'daemon_unavailable');
  assert.ok(!fs.existsSync(stateDir), 'call --no-autostart must not create the state directory');
});

test('CLI install --dry-run prints an absolute khy mcp add command without touching mcp.json', async (t) => {
  const tmp = tempDir(t);
  const stateDir = path.join(tmp, 'state');
  const io = capture();
  const code = await cli.main(['install', '--dry-run', '--json'], {
    stdout: io.stdout,
    stderr: io.stderr,
    env: { [C.ENV.home]: stateDir },
  });
  assert.equal(code, 0);
  const payload = JSON.parse(io.out);
  assert.equal(payload.ok, true);
  assert.equal(payload.dry_run, true);
  assert.match(payload.data.command, /mcp add amoon/);
  assert.ok(!fs.existsSync(stateDir), 'install --dry-run must not create the state directory');
  assert.ok(!fs.existsSync(path.join(stateDir, C.STATE_FILES.operatorToken)), 'dry-run must not create a token');
});

test('CLI status is read-only and does not claim a running daemon', async (t) => {
  const tmp = tempDir(t);
  const stateDir = path.join(tmp, 'state');
  const io = capture();
  const code = await cli.main(['status', '--json'], {
    stdout: io.stdout,
    stderr: io.stderr,
    env: { [C.ENV.home]: stateDir },
  });

  assert.equal(code, 0);
  const payload = JSON.parse(io.out);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.daemon.runtimePresent, false);
  assert.equal(payload.data.daemon.running, false);
  assert.equal(payload.data.stateDir, stateDir);
  assert.ok(!fs.existsSync(stateDir), 'status must not create the state directory');
});

test('MCP initialize/tools/list/tools/call behave like a skeleton', () => {
  const ctx = mcp.createContext({ config: null, logger: silentLogger });

  const init = mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, ctx);
  assert.equal(init.result.protocolVersion, mcp.DEFAULT_PROTOCOL_VERSION);
  assert.equal(init.result.serverInfo.name, 'amoon');
  assert.ok(init.result.capabilities.tools);

  const list = mcp.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx);
  assert.equal(list.result.tools.length, 12);
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), [...PHASE1].sort());

  const call = mcp.handleMessage(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ping', arguments: {} } },
    ctx
  );
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /not_implemented/);

  const unknownMethod = mcp.handleMessage({ jsonrpc: '2.0', id: 4, method: 'nope' }, ctx);
  assert.equal(unknownMethod.error.code, -32601);

  const parseError = mcp.handleLine('{', ctx);
  assert.equal(parseError.error.code, -32700);
});

test('MCP stdio emits protocol frames only (no logs on stdout)', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  let errText = '';
  stderr.on('data', (chunk) => { errText += chunk.toString(); });
  let outText = '';
  output.on('data', (chunk) => { outText += chunk.toString(); });

  const done = mcp.runStdio({
    stdin: input,
    stdout: output,
    stderr,
    config: null,
    logger: silentLogger,
  });

  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  input.end();
  await done;
  await new Promise((resolve) => setImmediate(resolve));

  const lines = outText.split('\n').filter(Boolean);
  assert.equal(lines.length, 2, 'stdout must contain exactly one frame per request');
  for (const line of lines) {
    const frame = JSON.parse(line); // throws if any log line leaked
    assert.equal(frame.jsonrpc, '2.0');
  }
  assert.equal(lines[1] && JSON.parse(lines[1]).result.tools.length, 12);
  assert.equal(errText, '', 'silent logger should keep stderr empty');
});
