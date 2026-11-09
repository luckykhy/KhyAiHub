'use strict';

/**
 * integration.test.js — daemon assembly against a fake adb.
 *
 * This is the only test that starts the real lib/daemon.js. It uses
 * KHY_ADB=<node.exe> + KHY_ADB_ARGS=[fake-adb.js] so no real device, reverse or
 * adb server is touched. Port 0 lets the OS pick a free loopback port; the
 * daemon's runtime.json is the only source of that port.
 *
 * Covered:
 *   - token provisioning + runtime.json
 *   - /health, POST /v1/call (ping, bridge_status, mailbox_status)
 *   - MCP context -> daemon client -> HTTP -> registry -> handler
 *   - wireless reaching HEALTHY and the mailbox poller starting
 *   - file scope refusing khy_ask
 *   - shutdown removes runtime.json and its reverse mapping
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const C = require('../lib/contracts');
const { loadConfig } = require('../lib/config');
const { createLogger } = require('../lib/logger');
const { startDaemon, readRuntime, sameIdentity } = require('../lib/daemon');
const mcp = require('../lib/mcp');

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const FAKE_ADB = `'use strict';
const fs = require('fs');
const argv = process.argv.slice(2);
const logFile = process.env.FAKE_ADB_LOG;
const stateFile = process.env.FAKE_ADB_STATE;
if (logFile) { try { fs.appendFileSync(logFile, JSON.stringify(argv) + '\\n'); } catch {} }
function state() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { reverse: [] }; } }
function save(value) { if (stateFile) { try { fs.writeFileSync(stateFile, JSON.stringify(value)); } catch {} } }
function out(text) { process.stdout.write(text); }
let args = argv.slice();
if (args[0] === '-s') args = args.slice(2);
const cmd = args[0];
if (cmd === 'devices') { out('List of devices attached\\n192.168.2.46:33743\\tdevice product:PZ261A model:PZ261A device:PZ261A transport_id:13\\n'); process.exit(0); }
if (cmd === 'mdns') { out('List of discovered mdns services\\nadb-x\\t_adb-tls-connect._tcp\\t192.168.2.46:33743\\n'); process.exit(0); }
if (cmd === 'get-state') { out('device\\n'); process.exit(0); }
if (cmd === 'connect') { out('connected to ' + args[1] + '\\n'); process.exit(0); }
if (cmd === 'reverse') {
  const st = state();
  if (args[1] === '--list') { const ports = st.reverse || []; out(ports.map((p) => 'tcp:' + p + ' tcp:' + p).join('\\n') + (ports.length ? '\\n' : '')); process.exit(0); }
  if (args[1] === '--remove') { const m = /tcp:(\\d+)/.exec(args[2] || ''); if (m) st.reverse = (st.reverse || []).filter((p) => String(p) !== m[1]); save(st); process.exit(0); }
  const m = /tcp:(\\d+)/.exec(args[1] || '');
  if (m) { st.reverse = Array.from(new Set([...(st.reverse || []), m[1]])); save(st); }
  process.exit(0);
}
if (cmd === 'push') { process.exit(0); }
if (cmd === 'pull') { try { fs.writeFileSync(args[2], ''); } catch {} process.exit(0); }
if (cmd === 'exec-out') { process.stdout.write(Buffer.from('${PNG_1X1}', 'base64')); process.exit(0); }
if (cmd === 'shell') {
  const sh = args.slice(1).join(' ');
  if (/getprop\\s+['"]?ro\\.serialno['"]?/.test(sh)) { out('ZYPZ261A01M6870010L\\n'); process.exit(0); }
  if (/getprop\\s+['"]?ro\\.product\\.model['"]?/.test(sh)) { out('PZ261A\\n'); process.exit(0); }
  if (/getprop\\s+['"]?ro\\.build\\.version\\.sdk['"]?/.test(sh)) { out('36\\n'); process.exit(0); }
  if (/getprop/.test(sh)) { out('[ro.serialno]: [ZYPZ261A01M6870010L]\\n[ro.product.model]: [PZ261A]\\n[ro.product.brand]: [Zhipu]\\n[ro.build.version.sdk]: [36]\\n[ro.build.version.release]: [16]\\n'); process.exit(0); }
  if (/curl/.test(sh)) { out('{"ok":true}'); process.exit(0); }
  if (/ls -1/.test(sh)) { out(''); process.exit(0); }
  if (/wc -c/.test(sh)) { out('0\\n'); process.exit(0); }
  if (/test -f/.test(sh)) { out('0\\n'); process.exit(0); }
  if (/dumpsys window policy/.test(sh)) { out('mDreamingLockscreen=false\\n'); process.exit(0); }
  if (/dumpsys/.test(sh)) { out(''); process.exit(0); }
  if (/am start/.test(sh)) { out('Starting: Intent { }\\nStatus: ok\\n'); process.exit(0); }
  process.exit(0);
}
process.exit(0);
`;

function silentLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoon-integration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(predicate, timeoutMs = 8000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

test('sameIdentity requires the daemon.js marker and a matching executable', () => {
  const runtime = { exe_path: 'C:\\node.exe' };
  assert.equal(
    sameIdentity(runtime, { commandLine: 'node C:\\bridge\\bin\\daemon.js', exePath: 'C:\\node.exe' }),
    true
  );
  // Same node.exe but an unrelated script: must never be killed as "our" PID.
  assert.equal(
    sameIdentity(runtime, { commandLine: 'node C:\\other\\server.js', exePath: 'C:\\node.exe' }),
    false
  );
  assert.equal(
    sameIdentity(runtime, { commandLine: 'node C:\\bridge\\bin\\daemon.js', exePath: 'C:\\other.exe' }),
    false
  );
  assert.equal(
    sameIdentity(runtime, {
      commandLine: 'node C:\\bridge\\bin\\cli.js start --foreground',
      exePath: 'C:\\node.exe',
    }),
    true
  );
  assert.equal(sameIdentity(runtime, null), false);
});

test('daemon assembles wireless + mailbox + tasks and serves the 8 tools', async (t) => {
  const tmp = tempDir(t);
  const stateDir = path.join(tmp, 'state');
  const fakeAdb = path.join(tmp, 'fake-adb.js');
  fs.writeFileSync(fakeAdb, FAKE_ADB, 'utf8');
  const logFile = path.join(tmp, 'fake-adb.log');
  const stateFile = path.join(tmp, 'fake-adb.json');
  fs.writeFileSync(logFile, '', 'utf8');
  fs.writeFileSync(stateFile, JSON.stringify({ reverse: [] }), 'utf8');

  process.env.FAKE_ADB_LOG = logFile;
  process.env.FAKE_ADB_STATE = stateFile;
  t.after(() => {
    delete process.env.FAKE_ADB_LOG;
    delete process.env.FAKE_ADB_STATE;
  });

  const config = loadConfig({
    stateDir,
    env: {
      KHY_AMOON_HOME: stateDir,
      KHY_ADB: process.execPath,
      KHY_ADB_ARGS: JSON.stringify([fakeAdb]),
      KHY_AMOON_SERIAL: '192.168.2.46:33743',
    },
  });
  config.port = 0;
  config.portScanMax = 0;

  // A pre-existing capability file must survive startup ACL tightening; the
  // daemon used to clear the DACL of non-empty state directories.
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(config.paths.capability, JSON.stringify({ status: 'unverified', http: false }));

  const logger = createLogger({ level: 'error', file: null, stderr: null });
  const handle = await startDaemon({ config, logger });
  t.after(async () => {
    await handle.shutdown('test');
  });

  assert.equal(
    JSON.parse(fs.readFileSync(config.paths.capability, 'utf8')).status,
    'unverified',
    'pre-existing capability.json must stay readable'
  );
  assert.ok(fs.existsSync(config.paths.operatorToken), 'operator token provisioned');
  const runtime = readRuntime(config);
  assert.ok(runtime, 'runtime.json written');
  assert.equal(runtime.pid, process.pid);
  assert.equal(runtime.port, handle.port);
  assert.ok(handle.port > 0);

  const healthy = await waitFor(() => mcp.checkHealth(handle.port, 300), 5000);
  assert.equal(healthy, true, '/health must answer');

  const client = mcp.createDaemonClient({ config, logger: silentLogger(), autostart: false });
  const ping = await client.callTool('ping', {}, { timeoutMs: 5000 });
  assert.equal(ping.ok, true);
  assert.equal(ping.data.pong, true);

  // The dotted shorthand used in the docs reaches the wire tool through the
  // full HTTP -> registry path, not just through the registry unit stub.
  const dottedPhone = await client.callTool('phone.info', {}, { timeoutMs: 5000 });
  assert.equal(dottedPhone.ok, true);
  assert.ok(dottedPhone.data && (dottedPhone.data.model || dottedPhone.data.serial));

  const status = await client.callTool('bridge_status', { verbose: true }, { timeoutMs: 5000 });
  assert.equal(status.ok, true);
  assert.equal(status.data.protocol, 'khy-amoon/1');
  assert.ok(Array.isArray(status.data.tools) || status.data.tools === null);
  assert.ok(status.data.capabilities);
  assert.equal(status.data.capabilities.amoonToPc, 'unverified');

  const mailbox = await client.callTool('mailbox_status', {}, { timeoutMs: 5000 });
  assert.equal(mailbox.ok, true);
  assert.equal(typeof mailbox.data.running, 'boolean');

  // MCP context -> daemon client -> HTTP -> registry -> handler.
  const ctx = mcp.createContext({ config, logger: silentLogger(), deps: { autostart: false } });
  const mcpPing = await mcp.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ping', arguments: {} } },
    ctx
  );
  assert.equal(mcpPing.result.isError, false);
  assert.match(mcpPing.result.content[0].text, /pong/);

  // Wireless reaches HEALTHY against the fake device, then the mailbox polls.
  const healthyState = await waitFor(async () => {
    const snapshot = handle.snapshot();
    return snapshot.state === 'HEALTHY' ? snapshot : null;
  }, 8000);
  assert.ok(healthyState, `expected HEALTHY, got ${handle.snapshot().state}`);
  // IP:port config + no device.json: first contact must read ro.serialno and
  // persist it so a later DHCP reassignment is detected.
  const identityFile = path.join(config.stateDir, 'device.json');
  assert.ok(fs.existsSync(identityFile), 'device.json must be written on first contact');
  assert.equal(
    JSON.parse(fs.readFileSync(identityFile, 'utf8')).serial,
    'ZYPZ261A01M6870010L'
  );
  const mailboxRunning = await waitFor(() => handle.mailbox.status().running, 5000);
  assert.equal(mailboxRunning, true, 'mailbox poller must start once ADB is usable');
  assert.equal(handle.tasks.status().started, true, 'task queue must be started');

  // A message left in the local spool is re-delivered on the next healthy tick.
  const spoolFile = path.join(config.paths.dirs.outbox, 'msg_abcdefgh.json');
  fs.writeFileSync(spoolFile, `${JSON.stringify({ v: 1, id: 'abcdefgh', kind: 'text', text: 'retry' })}\n`);
  const flushed = await handle.registry.flushSpool();
  assert.equal(flushed.sent, 1);
  assert.ok(fs.existsSync(path.join(config.paths.dirs.outbox, 'sent', 'msg_abcdefgh.json')));

  // A successful amoon_send retires its spool envelope, so a later healthy
  // tick cannot push the same message twice.
  const operator = { kind: 'operator', scope: 'operator', tokenId: 'op', source: 'test' };
  const sent = await handle.registry.call(
    'amoon_send',
    { text: 'once', mode: 'file' },
    { principal: operator }
  );
  assert.equal(sent.ok, true);
  assert.equal(sent.data.state, 'pushed');
  assert.equal(sent.data.spool_retired, true);
  assert.equal(fs.existsSync(sent.data.local_path), false, 'spool file must leave the retry set');
  assert.ok(
    fs.existsSync(path.join(config.paths.dirs.outbox, 'sent', path.basename(sent.data.local_path))),
    'delivered envelope must be archived'
  );
  const flushedAgain = await handle.registry.flushSpool();
  assert.equal(flushedAgain.sent, 0, 'a delivered message must not be re-sent');

  // file scope is the unauthenticated mailbox: never model, never phone control.
  await assert.rejects(
    () => handle.registry.call('khy_ask', { question: 'x' }, { principal: { kind: 'file', scope: 'file' } }),
    (err) => err.code === 'forbidden_scope'
  );
  await assert.rejects(
    () => handle.registry.call('phone_screenshot', {}, { principal: { kind: 'file', scope: 'file' } }),
    (err) => err.code === 'forbidden_scope'
  );

  const adbLog = fs.readFileSync(logFile, 'utf8');
  assert.match(adbLog, /reverse/);
  assert.match(adbLog, /getprop/);
  assert.ok(!adbLog.includes('--remove-all'), 'must never call reverse --remove-all');

  await handle.shutdown('test');
  assert.equal(readRuntime(config), null, 'shutdown removes runtime.json');
  assert.ok(!fs.existsSync(config.paths.lock), 'shutdown releases daemon.lock');
  const after = fs.readFileSync(logFile, 'utf8');
  assert.match(after, /reverse","--remove/);
  assert.ok(!after.includes('--remove-all'));
});
