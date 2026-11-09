'use strict';

/**
 * adb.test.js — ADB transport / parser / wireless tests with a fake adb.
 *
 * The fake is a real Node script spawned through
 *   command = process.execPath, argsPrefix = [fake-adb.js]
 * (the same KHY_ADB=<node.exe> + KHY_ADB_ARGS=[fake] shape the design demands;
 * a .cmd shim cannot be spawned on Windows without EINVAL).
 *
 * No real device, no adb server, no network. State is passed through a JSON
 * file so reverse add/remove and probe sequences are observable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const C = require('../lib/contracts');
const adbLib = require('../lib/adb');
const { createWireless } = require('../lib/wireless');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

const FAKE_ADB_SOURCE = `'use strict';
const fs = require('fs');

const argv = process.argv.slice(2);
const logFile = process.env.FAKE_ADB_LOG;
if (logFile) fs.appendFileSync(logFile, JSON.stringify(argv) + '\\n');

const stateFile = process.env.FAKE_ADB_STATE;
function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { return {}; }
}
let state = readState();
function save() {
  try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch (e) {}
}
function out(text) {
  const value = String(text);
  process.stdout.write(value);
  if (!value.endsWith('\\n')) process.stdout.write('\\n');
}
function err(text) { process.stderr.write(String(text) + '\\n'); }

let index = 0;
let serial = null;
while (index < argv.length && argv[index] === '-s') { serial = argv[index + 1]; index += 2; }
const rest = argv.slice(index);
const command = rest[0];
const args = rest.slice(1);

function unquote(value) {
  return String(value || '').replace(/^'/, '').replace(/'$/, '').replace(/'\\\\''/g, "'");
}
function shell(cmdline) {
  if (cmdline === 'getprop') {
    return state.getpropText || [
      '[ro.serialno]: [ZYPZTEST0001]',
      '[ro.product.model]: [PZ261A]',
      '[ro.product.brand]: [StepX]',
      '[ro.build.version.sdk]: [36]',
      '[ro.build.version.release]: [16]'
    ].join('\\n');
  }
  if (cmdline.indexOf('getprop ') === 0) {
    const key = unquote(cmdline.slice(8).trim());
    if (key === 'ro.serialno') {
      const map = state.roSerials || {};
      if (serial && Object.prototype.hasOwnProperty.call(map, serial)) return map[serial];
      if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
      return state.roSerial || 'ZYPZTEST0001';
    }
    const defaults = {
      'ro.product.model': 'PZ261A',
      'ro.product.brand': 'StepX',
      'ro.build.version.sdk': '36',
      'ro.build.version.release': '16'
    };
    if (Object.prototype.hasOwnProperty.call(defaults, key)) return defaults[key];
    return '';
  }
  if (cmdline === 'wm size') return 'Physical size: 1080x2400';
  if (cmdline === 'dumpsys battery') return 'Current Battery Service state:\\n  level: 88\\n  status: 2';
  if (cmdline === 'dumpsys power') return 'mWakefulness=Awake';
  if (cmdline === 'dumpsys window policy') return 'isKeyguardShowing=false';
  if (cmdline === 'dumpsys activity top') return 'ACTIVITY com.stepos.ailauncher/.chat.activity.ChatMainActivity 123 pid=1';
  if (cmdline.indexOf('uiautomator dump ') === 0) return 'UI hierarchy dumped to: ' + unquote(cmdline.slice(17).trim());
  if (cmdline.indexOf('cat ') === 0) return state.xml || '';
  if (cmdline.indexOf('realpath ') === 0) return state.realpath || unquote(cmdline.slice(9).trim());
  if (cmdline.indexOf('sha256sum ') === 0) return (state.sha256 || '0'.repeat(64)) + '  ' + unquote(cmdline.slice(10).trim());
  if (cmdline.indexOf('rm -f ') === 0) return '';
  if (cmdline.indexOf('input ') === 0) { if (state.inputFail) { err('input failed'); process.exitCode = 1; } return ''; }
  if (cmdline.indexOf('curl ') === 0) {
    const calls = Number(state.curlCalls || 0);
    state.curlCalls = calls + 1;
    save();
    const sequence = state.healthSequence;
    if (Array.isArray(sequence) && sequence.length > 0) return sequence[Math.min(calls, sequence.length - 1)];
    return state.health || '{"ok":true}';
  }
  if (cmdline === 'bigout') return 'x'.repeat(100000);
  if (cmdline === 'failme') { err('boom'); process.exitCode = 1; return ''; }
  if (cmdline === 'hang') { setTimeout(function () {}, 5000); return null; }
  return cmdline;
}

switch (command) {
  case 'devices':
    out(state.devicesText || 'List of devices attached\\n');
    break;
  case 'mdns':
    out(state.mdnsText || 'List of discovered mdns services\\n');
    break;
  case 'connect':
    out(state.connectOutput || ('connected to ' + args[0]));
    break;
  case 'get-state':
    out(state.getState || 'device');
    break;
  case 'version':
    out('Android Debug Bridge version 1.0.41');
    break;
  case 'reverse':
    if (args[0] === '--list') {
      const entries = state.reverse || [];
      out(entries.map(function (entry) {
        return (serial ? serial + ' ' : '') + 'tcp:' + entry.remotePort + ' tcp:' + entry.localPort;
      }).join('\\n'));
    } else if (args[0] === '--remove') {
      const port = Number(String(args[1] || '').replace('tcp:', ''));
      state.reverse = (state.reverse || []).filter(function (entry) { return entry.remotePort !== port; });
      save();
      out(String(port));
    } else if (/^tcp:\\d+$/.test(String(args[0]))) {
      const remotePort = Number(String(args[0]).slice(4));
      const localPort = Number(String(args[1]).slice(4));
      state.reverse = state.reverse || [];
      state.reverse.push({ remotePort: remotePort, localPort: localPort });
      save();
      out(String(remotePort));
    } else {
      err('unknown reverse command');
      process.exitCode = 1;
    }
    break;
  case 'shell': {
    const value = shell(args.join(' '));
    if (value !== null) out(value);
    break;
  }
  case 'exec-out': {
    const cmdline = args.join(' ');
    if (cmdline === 'screencap -p') {
      process.stdout.write(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0d, 0x0a, 0xff]));
    } else if (cmdline.indexOf('cat ') === 0) {
      out(state.xml || '');
    } else {
      out(state.execOut || '');
    }
    break;
  }
  case 'push':
    out('1 file pushed');
    break;
  case 'pull': {
    fs.writeFileSync(args[1], state.pullContent || 'pulled');
    out('1 file pulled');
    break;
  }
  default:
    out('');
}
`;

function createHarness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoon-adb-'));
  const script = path.join(dir, 'fake-adb.js');
  const stateFile = path.join(dir, 'state.json');
  const logFile = path.join(dir, 'argv.log');
  fs.writeFileSync(script, FAKE_ADB_SOURCE, 'utf8');
  fs.writeFileSync(stateFile, JSON.stringify({ reverse: [] }), 'utf8');
  fs.writeFileSync(logFile, '', 'utf8');

  const previous = {
    state: process.env.FAKE_ADB_STATE,
    log: process.env.FAKE_ADB_LOG,
  };
  process.env.FAKE_ADB_STATE = stateFile;
  process.env.FAKE_ADB_LOG = logFile;

  t.after(() => {
    if (previous.state === undefined) delete process.env.FAKE_ADB_STATE;
    else process.env.FAKE_ADB_STATE = previous.state;
    if (previous.log === undefined) delete process.env.FAKE_ADB_LOG;
    else process.env.FAKE_ADB_LOG = previous.log;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function setState(patch) {
    const current = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    fs.writeFileSync(stateFile, JSON.stringify({ ...current, ...patch }), 'utf8');
  }
  function readState() {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  }
  function argvLog() {
    return fs
      .readFileSync(logFile, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  const config = {
    enabled: true,
    allowHighRisk: true,
    serial: 'SERIAL1',
    adb: { command: process.execPath, argsPrefix: [script] },
    limits: C.LIMITS,
    paths: { dirs: { spool: path.join(dir, 'spool'), screenshots: path.join(dir, 'shots') } },
  };

  return { dir, script, stateFile, logFile, config, setState, readState, argvLog };
}

function transportFor(harness, serial = 'SERIAL1') {
  return adbLib.createAdbTransport({
    config: { ...harness.config, serial },
    logger: silentLogger,
  });
}

test('shQuote/assertAsciiText/assertSafeRemoteName reject dangerous input', () => {
  assert.equal(adbLib.shQuote(''), "''");
  assert.equal(adbLib.shQuote('a b'), "'a b'");
  assert.equal(adbLib.shQuote("it's"), "'it'\\''s'");
  assert.equal(adbLib.shQuote('/sdcard/khy-amoon-bridge/tmp'), "'/sdcard/khy-amoon-bridge/tmp'");

  assert.equal(adbLib.assertAsciiText('hello 123'), 'hello 123');
  assert.throws(() => adbLib.assertAsciiText('中文'), (err) => err.code === 'unsupported_non_ascii');
  assert.throws(() => adbLib.assertAsciiText('a\nb'), (err) => err.code === 'invalid_args');
  assert.throws(() => adbLib.shQuote('a\u0000b'), (err) => err.code === 'invalid_args');

  assert.equal(adbLib.assertSafeRemoteName('blob_01.bin'), 'blob_01.bin');
  for (const bad of ['../x', 'a/b', 'a\\b', 'a b', '', 'x'.repeat(129)]) {
    assert.throws(() => adbLib.assertSafeRemoteName(bad), (err) => err.code === 'invalid_args', bad);
  }
});

test('parseDevices handles tabs, mDNS names with spaces and transport ids', () => {
  const text = [
    'List of devices attached',
    '192.168.2.46:33743\tdevice product:PZ261A model:PZ261A device:PZ261A transport_id:13',
    'adb-ZYPZ261A01M6870010L-R9QdlL (2)._adb-tls-connect._tcp\tdevice product:PZ261A model:PZ261A device:PZ261A transport_id:16',
    'emulator-5554\toffline',
    '',
  ].join('\r\n');

  const entries = adbLib.parseDevices(text);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].serial, '192.168.2.46:33743');
  assert.equal(entries[0].state, 'device');
  assert.equal(entries[0].transportId, 13);
  assert.equal(entries[1].serial, 'adb-ZYPZ261A01M6870010L-R9QdlL (2)._adb-tls-connect._tcp');
  assert.equal(entries[1].transportId, 16);
  assert.equal(entries[2].serial, 'emulator-5554');
  assert.equal(entries[2].state, 'offline');
});

test('parseMdns recognises connect/pairing services with spaces in names', () => {
  const text = [
    'List of discovered mdns services',
    'adb-ZYPZ261A01M6870010L-R9QdlL\t_adb-tls-connect._tcp\t192.168.2.46:33743',
    'adb-ZYPZ261A01M6870010L-R9QdlL (2)\t_adb-tls-connect._tcp\t192.168.2.46:37925',
    'adb-ZYPZ261A01M6870010L-R9QdlL\t_adb-tls-pairing._tcp\t192.168.2.46:41234',
  ].join('\n');

  const entries = adbLib.parseMdns(text);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].address, '192.168.2.46:33743');
  assert.equal(entries[0].kind, 'connect');
  assert.equal(entries[1].name, 'adb-ZYPZ261A01M6870010L-R9QdlL (2)');
  assert.equal(entries[2].kind, 'pairing');
  assert.equal(entries[2].port, 41234);
});

test('parseReverseList ignores foreign lines and keeps ports', () => {
  const entries = adbLib.parseReverseList('tcp:18765 tcp:18765\nSERIAL1 tcp:19000 tcp:19000\ngarbage\n');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].serial, null);
  assert.equal(entries[0].remotePort, 18765);
  assert.equal(entries[1].serial, 'SERIAL1');
  assert.equal(entries[1].localPort, 19000);
});

test('resolveAdb honours KHY_ADB/KHY_ADB_ARGS, PATH and rejects .cmd', () => {
  const env = { KHY_ADB: process.execPath, KHY_ADB_ARGS: '["fake-adb.js"]', PATH: '' };
  const resolved = adbLib.resolveAdb({ env, platform: 'win32' });
  assert.equal(resolved.command, process.execPath);
  assert.deepEqual(resolved.argsPrefix, ['fake-adb.js']);
  assert.equal(resolved.source, 'env');

  assert.throws(
    () => adbLib.resolveAdb({ env: { KHY_ADB: 'C:\\tools\\adb.cmd', PATH: '' }, platform: 'win32' }),
    (err) => err.code === 'invalid_config'
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoon-adb-path-'));
  try {
    const exe = path.join(dir, process.platform === 'win32' ? 'adb.exe' : 'adb');
    fs.writeFileSync(exe, '');
    const fromPath = adbLib.resolveAdb({
      env: { PATH: dir },
      platform: process.platform,
    });
    assert.equal(fromPath.command, exe);
    assert.equal(fromPath.source, 'path');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('transport always passes -s <serial> and reports exit/stdout/stderr', async (t) => {
  const harness = createHarness(t);
  const transport = transportFor(harness);

  const ok = await transport.shell('echo hello');
  assert.equal(ok.exit, 0);
  assert.equal(ok.stdout.trim(), 'echo hello');
  assert.equal(ok.timedOut, false);

  const failure = await transport.shell('failme');
  assert.equal(failure.exit, 1);
  assert.match(failure.stderr, /boom/);

  const calls = harness.argvLog();
  assert.deepEqual(calls[0], ['-s', 'SERIAL1', 'shell', 'echo hello']);
  assert.deepEqual(calls[1], ['-s', 'SERIAL1', 'shell', 'failme']);
});

test('transport refuses device commands without a serial but allows devices discovery', async (t) => {
  const harness = createHarness(t);
  const transport = transportFor(harness, null);

  await assert.rejects(transport.shell('getprop'), (err) => err.code === 'adb_unavailable');
  const devices = await transport.host(['devices', '-l'], { serial: false });
  assert.equal(devices.exit, 0);
  assert.match(devices.stdout, /List of devices/);
  assert.deepEqual(harness.argvLog()[0], ['devices', '-l']);
});

test('timeout kills the process and reports timedOut', async (t) => {
  const harness = createHarness(t);
  const transport = transportFor(harness);
  const started = Date.now();
  const result = await transport.shell('hang', { timeoutMs: 150 });
  const elapsed = Date.now() - started;

  assert.equal(result.timedOut, true);
  assert.ok(elapsed < 5000, `timeout should return quickly, took ${elapsed}ms`);
});

test('output cap truncates stdout and marks truncated', async (t) => {
  const harness = createHarness(t);
  const transport = transportFor(harness);
  const result = await transport.shell('bigout', { maxBytes: 1024 });

  assert.equal(result.truncated, true);
  assert.ok(result.stdout.length > 0 && result.stdout.length <= 1024, `got ${result.stdout.length}`);
});

test('execOut preserves binary bytes including CRLF', async (t) => {
  const harness = createHarness(t);
  const transport = transportFor(harness);
  const result = await transport.execOut('screencap -p', { maxBytes: 1024 });

  assert.ok(Buffer.isBuffer(result.stdout));
  const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x0d, 0x0a, 0xff]);
  assert.deepEqual([...result.stdout], [...expected]);
  assert.deepEqual(harness.argvLog()[0], ['-s', 'SERIAL1', 'exec-out', 'screencap -p']);
});

test('push passes argv unchanged and returns local byte count', async (t) => {
  const harness = createHarness(t);
  const transport = transportFor(harness);
  const local = path.join(harness.dir, 'a file with spaces.txt');
  fs.writeFileSync(local, 'hello', 'utf8');

  const result = await transport.push(local, '/sdcard/khy-amoon-bridge/tmp/a.txt.tmp');
  assert.equal(result.bytes, 5);
  assert.equal(result.remote, '/sdcard/khy-amoon-bridge/tmp/a.txt.tmp');

  const call = harness.argvLog()[0];
  assert.deepEqual(call, [
    '-s',
    'SERIAL1',
    'push',
    local,
    '/sdcard/khy-amoon-bridge/tmp/a.txt.tmp',
  ]);
});

test('pull writes the local file, hashes it and enforces maxBytes', async (t) => {
  const harness = createHarness(t);
  const transport = transportFor(harness);
  harness.setState({ pullContent: 'hello' });

  const local = path.join(harness.dir, 'pulled.bin');
  const pulled = await transport.pull('/sdcard/khy-amoon-bridge/blobs/a.bin', local, {
    maxBytes: 1024,
  });
  assert.equal(pulled.bytes, 5);
  assert.equal(fs.readFileSync(local, 'utf8'), 'hello');
  assert.equal(pulled.sha256, crypto.createHash('sha256').update('hello').digest('hex'));

  harness.setState({ pullContent: 'x'.repeat(2048) });
  const tooBig = path.join(harness.dir, 'too-big.bin');
  await assert.rejects(
    transport.pull('/sdcard/khy-amoon-bridge/blobs/big.bin', tooBig, { maxBytes: 1024 }),
    (err) => err.code === 'payload_too_large'
  );
  assert.equal(fs.existsSync(tooBig), false, 'oversized pull must be deleted');
});

test('transport snapshot exposes serial/device info/reverse and degrades on host failure', async (t) => {
  const harness = createHarness(t);
  const transport = transportFor(harness);
  assert.equal(transport.snapshot().state, 'STOPPED');

  await transport.shell('echo ok');
  assert.equal(transport.snapshot().state, 'HEALTHY');
  assert.equal(transport.snapshot().serial, 'SERIAL1');

  transport.setDeviceInfo({ model: 'PZ261A', sdk: 36 });
  transport.setReverse({ port: 18765, mapped: true, lastOk: '2026-01-01T00:00:00.000Z' });
  const snapshot = transport.snapshot();
  assert.equal(snapshot.model, 'PZ261A');
  assert.equal(snapshot.sdk, 36);
  assert.equal(snapshot.reverse.mapped, true);

  harness.setState({ getState: 'offline' });
  // A host command failing (non-zero exit) marks the transport degraded.
  const result = await transport.host(['reverse', '--bogus'], { timeoutMs: 5000 });
  assert.notEqual(result.exit, 0);
  assert.equal(transport.snapshot().state, 'DEGRADED_ADB');
});

test('wireless dedupes two transports of the same phone by ro.serialno', async (t) => {
  const harness = createHarness(t);
  const mdnsSerial = 'adb-ZYPZ261A01M6870010L-R9QdlL (2)._adb-tls-connect._tcp';
  harness.setState({
    devicesText: [
      'List of devices attached',
      '192.168.2.46:33743\tdevice product:PZ261A model:PZ261A device:PZ261A transport_id:13',
      `${mdnsSerial}\tdevice product:PZ261A model:PZ261A device:PZ261A transport_id:16`,
      '',
    ].join('\n'),
    roSerials: {
      '192.168.2.46:33743': 'ZYPZTEST0001',
      [mdnsSerial]: 'ZYPZTEST0001',
    },
  });

  const wireless = createWireless({
    config: { ...harness.config, serial: null },
    logger: silentLogger,
  });
  const resolved = await wireless.resolveSerial();
  assert.equal(resolved.source, 'dedupe');
  assert.equal(resolved.deviceSerial, 'ZYPZTEST0001');
  assert.equal(resolved.serial, '192.168.2.46:33743');
  assert.equal(resolved.transportId, 13);
});

test('wireless raises device_ambiguous for two different physical devices', async (t) => {
  const harness = createHarness(t);
  harness.setState({
    devicesText: [
      'List of devices attached',
      'AAA111\tdevice product:A model:A device:A transport_id:1',
      'BBB222\tdevice product:B model:B device:B transport_id:2',
      '',
    ].join('\n'),
    roSerials: { AAA111: 'PHONE_A', BBB222: 'PHONE_B' },
  });

  const wireless = createWireless({ config: { ...harness.config, serial: null }, logger: silentLogger });
  await assert.rejects(
    wireless.resolveSerial(),
    (err) => err.code === 'device_ambiguous' && Array.isArray(err.details.candidates)
  );
});

test('wireless honours an explicitly configured serial', async (t) => {
  const harness = createHarness(t);
  harness.setState({
    devicesText: 'List of devices attached\n192.168.2.46:33743\tdevice product:PZ261A model:PZ261A device:PZ261A transport_id:13\n',
  });

  const wireless = createWireless({
    config: { ...harness.config, serial: '192.168.2.46:33743' },
    logger: silentLogger,
  });
  const resolved = await wireless.resolveSerial();
  assert.equal(resolved.source, 'config');
  assert.equal(resolved.serial, '192.168.2.46:33743');
  assert.equal(resolved.transportId, 13);
});

test('wireless falls back to mDNS connect and verifies ro.serialno', async (t) => {
  const harness = createHarness(t);
  harness.setState({
    devicesText: 'List of devices attached\n',
    mdnsText: [
      'List of discovered mdns services',
      'adb-ZYPZ261A01M6870010L-R9QdlL\t_adb-tls-connect._tcp\t192.168.2.46:37925',
      '',
    ].join('\n'),
    roSerial: 'ZYPZTEST0001',
    getState: 'device',
  });

  const wireless = createWireless({
    config: { ...harness.config, serial: 'ZYPZTEST0001' },
    logger: silentLogger,
  });
  const resolved = await wireless.resolveSerial();
  assert.equal(resolved.source, 'mdns');
  assert.equal(resolved.serial, '192.168.2.46:37925');
  assert.equal(resolved.deviceSerial, 'ZYPZTEST0001');
});

test('ensureReverse adds, reports mapped and remove cleans only that port', async (t) => {
  const harness = createHarness(t);
  const wireless = createWireless({ config: harness.config, logger: silentLogger });

  const first = await wireless.ensureReverse(18765, { probe: false });
  assert.equal(first.mapped, true);
  assert.equal(first.rebuilt, false);
  assert.deepEqual(harness.readState().reverse, [{ remotePort: 18765, localPort: 18765 }]);

  const second = await wireless.ensureReverse(18765, { probe: false });
  assert.equal(second.mapped, true);
  assert.equal(second.rebuilt, false);

  const removed = await wireless.removeReverse(18765);
  assert.equal(removed.removed, true);
  assert.deepEqual(harness.readState().reverse, []);
});

test('ensureReverse rebuilds once when the health probe fails', async (t) => {
  const harness = createHarness(t);
  harness.setState({ healthSequence: ['{"ok":false}', '{"ok":true}'] });
  const wireless = createWireless({ config: harness.config, logger: silentLogger });

  const result = await wireless.ensureReverse(18765, { probe: true });
  assert.equal(result.mapped, true);
  assert.equal(result.rebuilt, true);
  assert.equal(result.probe.ok, true);
  assert.equal(harness.readState().curlCalls, 2);
});

test('wireless start/stop wires reverse and degrades only after two heartbeat failures', async (t) => {
  const harness = createHarness(t);
  harness.setState({
    devicesText: 'List of devices attached\nSERIAL1\tdevice product:PZ261A model:PZ261A device:PZ261A transport_id:13\n',
    roSerials: { SERIAL1: 'SERIAL1' },
  });
  const wireless = createWireless({ config: harness.config, logger: silentLogger });

  const started = await wireless.start({
    port: 18765,
    probe: false,
    stateIntervalMs: 100000,
    reverseIntervalMs: 100000,
  });
  assert.equal(started.state, 'HEALTHY');
  assert.equal(started.reverse.mapped, true);
  assert.equal(started.serial, 'SERIAL1');

  harness.setState({ getState: 'offline' });
  const first = await wireless.heartbeat();
  assert.equal(first.state, 'HEALTHY', 'one failure must not degrade');
  const second = await wireless.heartbeat();
  assert.equal(second.state, 'DEGRADED_ADB', 'two consecutive failures degrade');

  wireless.stop();
  assert.equal(wireless.snapshot().state, 'STOPPED');
});

test('pairHint never stores or echoes the pairing code', () => {
  const harnessConfig = { enabled: true, serial: null, adb: { command: 'adb', argsPrefix: [] } };
  const wireless = createWireless({ config: harnessConfig, logger: silentLogger });
  const hint = wireless.pairHint({ host: '192.168.2.46', port: 41234, code: '123456' });

  assert.equal(hint.ok, true);
  assert.equal(hint.command, 'adb pair 192.168.2.46:41234');
  assert.ok(!JSON.stringify(hint).includes('123456'), 'code must never be echoed');
  assert.match(hint.note, /配对码/);

  const bad = wireless.pairHint({ host: '192.168.2.46', port: 41234, code: 'abc' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'invalid_args');
});

test('wireless snapshot is DISABLED when KHY_AMOON_ENABLED=0', () => {
  const wireless = createWireless({
    config: { enabled: false, serial: null, adb: { command: 'adb', argsPrefix: [] } },
    logger: silentLogger,
  });
  const snapshot = wireless.snapshot();
  assert.equal(snapshot.state, 'DISABLED');
  assert.match(snapshot.reasons[0], /关闭/);
});
