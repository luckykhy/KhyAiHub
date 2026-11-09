'use strict';

/**
 * test/mcp.test.js — MCP handshake, tool table and KhyOS registration helpers.
 *
 * No daemon, no ADB, no real device, no mcp.json writes: a fake client is
 * injected through deps.client, and temp dirs hold any fixture files.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const C = require('../lib/contracts');
const { loadConfig } = require('../lib/config');
const mcp = require('../lib/mcp');
const khy = require('../lib/khy-tools');

const ROOT = path.resolve(__dirname, '..');
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

const silent = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
  isEnabled() {
    return false;
  },
  child() {
    return silent;
  },
  close() {},
});

function tempDir(t, prefix = 'amoon-mcp-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeConfig(t) {
  const dir = tempDir(t);
  return loadConfig({ env: { LOCALAPPDATA: dir }, platform: 'win32' });
}

/**
 * @param {(name:string,args:object,opts:object)=>Promise<object>} handler
 */
function fakeClient(handler) {
  const calls = [];
  return {
    calls,
    async callTool(name, args, opts) {
      calls.push({ name, args, opts });
      return handler(name, args, opts);
    },
  };
}

function okEnvelope(tool, data) {
  return {
    ok: true,
    id: 'req_test_0001',
    tool,
    ts: new Date().toISOString(),
    duration_ms: 1,
    data,
  };
}

function serverWith(config, client) {
  return mcp.createStdioServer({
    config,
    deps: { client, logger: silent, autostart: false },
  });
}

function call(server, id, name, args) {
  return server.handleMessage({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

function runLines(server, lines) {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  output.on('data', (chunk) => {
    out += chunk.toString();
  });
  stderr.on('data', (chunk) => {
    err += chunk.toString();
  });

  const done = server.run({ stdin: input, stdout: output, stderr });
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  return done
    .then(() => new Promise((resolve) => setImmediate(resolve)))
    .then(() => ({ out, err }));
}

// ── initialize / tools/list ─────────────────────────────────────────────────

test('initialize negotiates a known protocol version and identifies amoon', (t) => {
  const server = serverWith(makeConfig(t), fakeClient(async () => okEnvelope('ping', {})));

  const init = server.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'khy' } },
  });
  assert.equal(init.result.protocolVersion, '2024-11-05');
  assert.equal(init.result.serverInfo.name, 'amoon');
  assert.equal(init.result.serverInfo.version, C.BRIDGE_VERSION);
  assert.equal(init.result.capabilities.tools.listChanged, false);
  assert.equal(typeof init.result.instructions, 'string');
  assert.match(init.result.instructions, /Phase 0|unverified/);
  assert.match(init.result.instructions, /12 个工具/);
  assert.doesNotMatch(init.result.instructions, /8 个工具/);

  const unknown = server.handleMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: { protocolVersion: '9999-99-99' },
  });
  assert.equal(unknown.result.protocolVersion, mcp.DEFAULT_PROTOCOL_VERSION);
});

test('tools/list returns exactly the 12 Phase 1 tools in wire order', (t) => {
  const server = serverWith(makeConfig(t), fakeClient(async () => okEnvelope('ping', {})));
  const list = server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

  assert.deepEqual(list.result.tools.map((tool) => tool.name), PHASE1);
  assert.equal(list.result.tools.length, 12);

  for (const tool of list.result.tools) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} schema`);
    assert.ok(tool.description.length > 0);
    assert.equal(typeof tool.annotations.idempotentHint, 'boolean');
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
  }
  for (const phase2 of C.PHASE2_TOOL_NAMES) {
    assert.ok(!list.result.tools.some((tool) => tool.name === phase2), `${phase2} must not be listed`);
  }
  assert.deepEqual(server.toolList().map((tool) => tool.name), PHASE1);
});

// ── tools/call ──────────────────────────────────────────────────────────────

test('tools/call forwards arguments and renders a successful envelope', async (t) => {
  const client = fakeClient(async () => okEnvelope('ping', { pong: true, ts: 123, pid: 42 }));
  const server = serverWith(makeConfig(t), client);

  const response = await call(server, 3, 'ping', { verbose: true });
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 3);
  assert.equal(response.result.isError, false);
  assert.deepEqual(JSON.parse(response.result.content[0].text), { pong: true, ts: 123, pid: 42 });

  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].name, 'ping');
  assert.deepEqual(client.calls[0].args, { verbose: true });
  assert.ok(client.calls[0].opts.signal);
  assert.equal(server.context.active.size, 0);
});

test('tools/call defaults arguments to an empty object', async (t) => {
  const client = fakeClient(async () => okEnvelope('ping', { pong: true }));
  const server = serverWith(makeConfig(t), client);
  const response = await call(server, 4, 'ping', undefined);
  assert.equal(response.result.isError, false);
  assert.deepEqual(client.calls[0].args, {});
});

test('tools/call renders an error envelope as isError with the frozen code', async (t) => {
  const client = fakeClient(async () => ({
    ok: false,
    id: 'req_test_0002',
    tool: 'khy_ask',
    ts: new Date().toISOString(),
    duration_ms: 2,
    error: { code: 'forbidden_scope', message: '文件 scope 不能提问' },
  }));
  const server = serverWith(makeConfig(t), client);
  const response = await call(server, 5, 'khy_ask', { question: 'hi' });

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /^\[forbidden_scope\]/);
  assert.match(response.result.content[0].text, /文件 scope 不能提问/);
});

test('tools/call rejects unknown tools without calling the client', async (t) => {
  const client = fakeClient(async () => okEnvelope('ping', {}));
  const server = serverWith(makeConfig(t), client);
  const response = await call(server, 6, 'phone_shell', {});

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /^\[not_found\]/);
  assert.match(response.result.content[0].text, /Phase 1/);
  assert.equal(client.calls.length, 0);
});

test('tools/call rejects non-object arguments', async (t) => {
  const client = fakeClient(async () => okEnvelope('ping', {}));
  const server = serverWith(makeConfig(t), client);
  const response = await call(server, 7, 'ping', [1, 2, 3]);
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /^\[invalid_args\]/);
  assert.equal(client.calls.length, 0);
});

test('a context without an executor returns not_implemented, never success', (t) => {
  const ctx = mcp.createContext({ config: null, logger: silent });
  const response = mcp.handleMessage(
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'ping', arguments: {} } },
    ctx
  );
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /^\[not_implemented\]/);
  assert.match(response.result.content[0].text, /没有执行任何/);
});

test('a config error is surfaced as invalid_config', (t) => {
  const server = mcp.createStdioServer({
    config: null,
    deps: {
      logger: silent,
      autostart: false,
      configError: new C.BridgeError('invalid_config', 'KHY_AMOON_PORT 非法'),
    },
  });
  const response = server.handleMessage({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: 'ping', arguments: {} },
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /^\[invalid_config\]/);
  assert.match(response.result.content[0].text, /KHY_AMOON_PORT/);
});

test('a thrown BridgeError becomes an isError result', async (t) => {
  const client = fakeClient(async () => {
    throw new C.BridgeError('adb_unavailable', '设备不可用');
  });
  const server = serverWith(makeConfig(t), client);
  const response = await call(server, 10, 'phone_screenshot', {});
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /^\[adb_unavailable\]/);
});

test('error text never leaks a khy_ token', async (t) => {
  const secret = `khy_${'a'.repeat(40)}`;
  const client = fakeClient(async () => {
    throw new C.BridgeError('internal_error', `upstream failed with ${secret}`);
  });
  const server = serverWith(makeConfig(t), client);
  const response = await call(server, 11, 'ping', {});
  const text = response.result.content[0].text;
  assert.equal(response.result.isError, true);
  assert.ok(!text.includes(secret), 'raw token must be redacted');
  assert.ok(text.includes('khy_[redacted]'), 'redaction marker expected');
});

test('oversized data is truncated at the descriptor response cap', async (t) => {
  const descriptor = C.getTool('ping');
  assert.equal(descriptor.responseMaxBytes, 64 * 1024);

  const client = fakeClient(async () =>
    okEnvelope('ping', { blob: 'x'.repeat(descriptor.responseMaxBytes + 4096) })
  );
  const server = serverWith(makeConfig(t), client);
  const response = await call(server, 12, 'ping', {});
  const text = response.result.content[0].text;

  assert.equal(response.result.isError, false);
  assert.match(text, /\[已截断/);
  assert.ok(Buffer.byteLength(text, 'utf8') <= descriptor.responseMaxBytes + 256);
});

// ── JSON-RPC plumbing ───────────────────────────────────────────────────────

test('ping returns an empty result', (t) => {
  const server = serverWith(makeConfig(t), fakeClient(async () => okEnvelope('ping', {})));
  const response = server.handleMessage({ jsonrpc: '2.0', id: 13, method: 'ping' });
  assert.deepEqual(response.result, {});
});

test('notifications never get a response', (t) => {
  const server = serverWith(makeConfig(t), fakeClient(async () => okEnvelope('ping', {})));
  assert.equal(
    server.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    null
  );
  assert.equal(
    server.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }),
    null
  );
});

test('protocol errors use JSON-RPC codes', (t) => {
  const server = serverWith(makeConfig(t), fakeClient(async () => okEnvelope('ping', {})));

  const parse = server.handleLine('{not json');
  assert.equal(parse.error.code, -32700);

  const invalid = server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 14 }));
  assert.equal(invalid.error.code, -32600);

  const batch = server.handleLine(JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]));
  assert.equal(batch.error.code, -32600);

  const unknown = server.handleMessage({ jsonrpc: '2.0', id: 15, method: 'nope/nope' });
  assert.equal(unknown.error.code, -32601);

  assert.equal(server.handleLine('   '), null);
});

test('resources/prompts lists are empty but valid', (t) => {
  const server = serverWith(makeConfig(t), fakeClient(async () => okEnvelope('ping', {})));
  assert.deepEqual(server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'resources/list' }).result, {
    resources: [],
  });
  assert.deepEqual(server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'prompts/list' }).result, {
    prompts: [],
  });
});

// ── cancellation / async ordering / stdout purity ───────────────────────────

test('notifications/cancelled aborts the matching in-flight tools/call', async (t) => {
  const client = fakeClient(
    (name, args, opts) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(okEnvelope('ping', { slow: true })), 5000);
        if (opts.signal) {
          opts.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(Object.assign(new Error('request aborted'), { code: 'ABORT_ERR' }));
            },
            { once: true }
          );
        }
      })
  );
  const server = serverWith(makeConfig(t), client);

  const pending = call(server, 42, 'ping', {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(server.context.active.size, 1);

  const cancel = server.handleMessage({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 42 },
  });
  assert.equal(cancel, null);

  const response = await pending;
  assert.equal(response.id, 42);
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /^\[timeout\]/);
  assert.equal(server.context.active.size, 0);
});

test('run() writes only protocol frames to stdout and logs to stderr', async (t) => {
  const client = fakeClient(async () => okEnvelope('ping', { pong: true }));
  const server = serverWith(makeConfig(t), client);

  const { out, err } = await runLines(server, [
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'ping', arguments: {} },
    }),
  ]);

  const lines = out.split('\n').filter(Boolean);
  assert.equal(lines.length, 3, `stdout must contain one frame per request, got: ${out}`);
  const frames = lines.map((line) => JSON.parse(line));
  assert.deepEqual(frames.map((frame) => frame.id), [1, 2, 3]);
  assert.equal(frames[2].result.isError, false);
  assert.equal(err, '', 'silent logger must keep stderr empty');
});

test('a slow tools/call still answers after the client closes stdin', async (t) => {
  // Regression: unref'ed autostart handles must not let the event loop exit
  // before an in-flight tools/call is answered.
  const client = fakeClient(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    return okEnvelope('ping', { pong: true });
  });
  const server = serverWith(makeConfig(t), client);

  const { out } = await runLines(server, [
    JSON.stringify({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: { name: 'ping', arguments: {} },
    }),
  ]);

  const lines = out.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `expected one frame, got: ${out}`);
  const frame = JSON.parse(lines[0]);
  assert.equal(frame.id, 21);
  assert.equal(frame.result.isError, false);
  assert.deepEqual(JSON.parse(frame.result.content[0].text), { pong: true });
});

test('daemon client falls back from /v1/call to the in-tree /call route', async (t) => {
  const http = require('node:http');
  const config = makeConfig(t);
  fs.mkdirSync(config.stateDir, { recursive: true });
  const token = `khy_${'b'.repeat(32)}`;

  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization || null, body });
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      if (req.url === '/v1/call') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: '未知路径' } }));
        return;
      }
      if (req.url === '/call') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(okEnvelope('ping', { pong: true, via: '/call' })));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"ok":false,"error":{"code":"not_found","message":"unknown"}}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;

  fs.writeFileSync(
    config.paths.runtime,
    JSON.stringify({ pid: process.pid, port, host: '127.0.0.1', version: C.BRIDGE_VERSION })
  );
  fs.writeFileSync(config.paths.operatorToken, `${token}\n`);

  const client = mcp.createDaemonClient({ config, logger: silent, autostart: false });
  const envelope = await client.callTool('ping', {}, { timeoutMs: 5000 });

  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.via, '/call');
  const callPaths = seen.filter((entry) => entry.url === '/v1/call' || entry.url === '/call');
  assert.deepEqual(callPaths.map((entry) => entry.url), ['/v1/call', '/call']);
  assert.equal(callPaths[1].auth, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(callPaths[1].body).args, {});
  assert.equal(JSON.parse(callPaths[1].body).tool, 'ping');
});

// ── KhyOS registration helpers ──────────────────────────────────────────────

test('getMcpServerEntry produces absolute paths', (t) => {
  const dir = tempDir(t);
  const fakeKhy = path.join(dir, 'khy.js');
  fs.writeFileSync(fakeKhy, '// fake\n');

  const entry = khy.getMcpServerEntry({
    nodePath: process.execPath,
    extRoot: ROOT,
    stateDir: dir,
    khyJs: fakeKhy,
  });

  assert.equal(entry.command, path.resolve(process.execPath));
  assert.equal(entry.args[0], path.join(ROOT, 'bin', 'mcp-server.js'));
  assert.ok(path.isAbsolute(entry.args[0]));
  assert.deepEqual(entry.args.slice(1, 3), ['--root', ROOT]);
  assert.deepEqual(entry.args.slice(3, 5), ['--state-dir', path.resolve(dir)]);
  assert.deepEqual(entry.args.slice(5, 7), ['--khy-js', path.resolve(fakeKhy)]);

  assert.throws(
    () => khy.getMcpServerEntry({ nodePath: process.execPath, extRoot: dir, stateDir: dir }),
    (err) => err.code === 'invalid_config'
  );
});

test('buildMcpAddArgv inserts -- and keeps the inner argv intact', (t) => {
  const dir = tempDir(t);
  const fakeKhy = path.join(dir, 'khy.js');
  fs.writeFileSync(fakeKhy, '// fake\n');

  const argv = khy.buildMcpAddArgv({
    nodePath: process.execPath,
    extRoot: ROOT,
    stateDir: dir,
    khyJs: fakeKhy,
    scope: 'user',
  });

  assert.deepEqual(argv.slice(0, 6), ['mcp', 'add', 'amoon', '--scope', 'user', '--']);
  assert.equal(argv[6], path.resolve(process.execPath));
  assert.equal(argv[7], path.join(ROOT, 'bin', 'mcp-server.js'));
  assert.ok(argv.includes('--root'));
  assert.ok(argv.includes('--state-dir'));
  assert.ok(argv.includes('--khy-js'));

  const command = khy.buildMcpAddCommand({
    nodePath: process.execPath,
    extRoot: ROOT,
    stateDir: dir,
    khyJs: fakeKhy,
  });
  assert.match(command, /^& '/);
  assert.ok(command.includes('mcp'));
  assert.ok(command.includes('amoon'));
  assert.ok(command.includes('--state-dir'));
});

test('mcp.json helpers never mutate and never overwrite a corrupt file', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'mcp.json');

  const missing = khy.readMcpJson(file);
  assert.equal(missing.ok, true);
  assert.equal(missing.exists, false);
  assert.deepEqual(missing.data, { mcpServers: {} });

  fs.writeFileSync(file, '{ broken');
  const broken = khy.readMcpJson(file);
  assert.equal(broken.ok, false);
  assert.equal(broken.exists, true);
  assert.match(broken.error, /拒绝覆盖|解析失败/);

  fs.writeFileSync(file, JSON.stringify({ mcpServers: { amoon: { type: 'stdio' } }, keep: 1 }));
  const good = khy.readMcpJson(file);
  assert.equal(good.ok, true);
  assert.deepEqual(khy.findRegisteredServer(good.data), { type: 'stdio' });
  assert.equal(khy.findRegisteredServer(good.data, 'other'), null);
  assert.equal(good.data.keep, 1, 'unrelated top-level fields are preserved');
});

test('KhyOS discovery and mcp.json path resolution', (t) => {
  const dir = tempDir(t);
  const khyos = path.join(dir, 'khyos');
  const khyJs = path.join(khyos, 'runtime', 'node', 'backend', 'bin', 'khy.js');
  fs.mkdirSync(path.dirname(khyJs), { recursive: true });
  fs.writeFileSync(khyJs, '// fake\n');

  const found = khy.findKhyOsInstallation({ env: { KHY_JS: khyJs }, extRoot: ROOT });
  assert.ok(found);
  assert.equal(found.khyJs, path.resolve(khyJs));
  assert.equal(found.root, path.resolve(khyos));
  assert.equal(found.source, 'env:KHY_JS');

  const user = khy.resolveUserMcpJson({ env: { KHY_DATA_HOME: dir } });
  assert.equal(user.path, path.join(path.resolve(dir), 'mcp.json'));
  assert.equal(user.source, 'KHY_DATA_HOME');

  const portable = khy.resolveUserMcpJson({ env: {}, khyJs });
  assert.equal(portable.path, path.join(path.resolve(khyos), 'works', 'data', 'khy', 'mcp.json'));

  assert.throws(() => khy.buildMcpAddCommand({ extRoot: ROOT }), (err) => err.code === 'invalid_config');
});

test('verification/remove helpers target mcp__amoon__<tool> and remove amoon', () => {
  const verify = khy.buildVerifyArgv({ tool: 'ping' });
  assert.equal(verify[0], '-p');
  assert.ok(verify.includes('--allowedTools'));
  assert.ok(verify.includes('mcp__amoon__ping'));
  assert.ok(verify.includes('--output-format'));

  const remove = khy.buildMcpRemoveArgv({ khyJs: path.join(ROOT, 'package.json') });
  assert.deepEqual(remove, ['mcp', 'remove', 'amoon', '--scope', 'user']);

  assert.equal(khy.psQuote("a'b"), "'a''b'");
  assert.equal(khy.psQuote('C:\\x y\\z'), "'C:\\x y\\z'");

  assert.deepEqual(
    khy.describeRegisteredServer({
      type: 'stdio',
      command: 'node',
      args: ['x'],
      env: { SECRET: 'do-not-print' },
    }),
    { type: 'stdio', command: 'node', args: ['x'], envKeys: ['SECRET'], disabled: false }
  );
});
