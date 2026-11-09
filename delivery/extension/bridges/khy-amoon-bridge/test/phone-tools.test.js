'use strict';

/**
 * phone-tools.test.js — handler tests with an injected fake Transport.
 *
 * No adb, no device, no network. The fake records every shell/execOut/push/pull
 * call so tests can assert:
 *   - user values are quoted, never concatenated raw;
 *   - screenshots are written as Buffers (CRLF-safe PNG);
 *   - UI dumps parse fixtures and cap nodes;
 *   - high-risk tools are default-off;
 *   - file tools refuse traversal and out-of-spool paths;
 *   - every handler returns {ok:false,error} instead of throwing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const C = require('../lib/contracts');
const {
  createPhoneTools,
  parseUiXml,
  parseActivities,
  parseActivityTop,
  parseForegroundActivity,
  parseLsEntries,
  pngSize,
  isPng,
  PHONE_RESTRICTED_TOOLS,
  PHONE_EXEC_OPS,
  PHONE_PROHIBITED_TOOLS,
} = require('../lib/phone-tools');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

const UI_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.stepos.ailauncher" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]" />
  <node index="1" text="你好 &amp; hello" resource-id="com.stepos.ailauncher:id/tv_title" class="android.widget.TextView" package="com.stepos.ailauncher" content-desc="" clickable="false" enabled="true" bounds="[10,20][100,60]" />
  <node index="2" text="发送" resource-id="com.stepos.ailauncher:id/btn_send" class="android.widget.Button" package="com.stepos.ailauncher" content-desc="" clickable="true" enabled="true" bounds="[900,2100][1060,2200]" />
</hierarchy>`;

const TAP_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="OK" resource-id="com.x:id/ok1" class="android.widget.Button" package="com.x" clickable="true" enabled="true" bounds="[0,0][100,100]" />
  <node index="1" text="OK" resource-id="com.x:id/ok2" class="android.widget.Button" package="com.x" clickable="true" enabled="true" bounds="[200,200][300,300]" />
  <node index="2" text="发送" resource-id="com.x:id/btn_send" class="android.widget.Button" package="com.x" clickable="true" enabled="true" bounds="[900,2100][1060,2200]" />
</hierarchy>`;

const PROPS_TEXT = [
  '[ro.serialno]: [ZYPZTEST0001]',
  '[ro.product.model]: [PZ261A]',
  '[ro.product.brand]: [StepX]',
  '[ro.build.version.sdk]: [36]',
  '[ro.build.version.release]: [16]',
  '[persist.sys.timezone]: [Asia/Shanghai]',
].join('\n');

function makePng(width = 1080, height = 2400) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13, 0);
  const type = Buffer.from('IHDR');
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  const crc = Buffer.alloc(4);
  // Deliberate CRLF bytes after the header: they must survive untouched.
  return Buffer.concat([signature, length, type, data, crc, Buffer.from([0x00, 0x0d, 0x0a, 0xff])]);
}

function okResult(stdout = '') {
  return { exit: 0, stdout, stderr: '', truncated: false, timedOut: false };
}

function bufferResult(buffer, extra = {}) {
  return {
    exit: 0,
    stdout: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
    stderr: '',
    truncated: false,
    timedOut: false,
    ...extra,
  };
}

function defaultShell(cmd, overrides = {}) {
  if (cmd === 'getprop') return okResult(overrides.props || PROPS_TEXT);
  if (cmd.startsWith('getprop ')) {
    const key = cmd.slice(8).trim().replace(/^'|'$/g, '');
    const map = {
      'ro.serialno': 'ZYPZTEST0001',
      'ro.product.model': 'PZ261A',
      'ro.build.version.sdk': '36',
    };
    return okResult(map[key] || '');
  }
  if (cmd === 'wm size') return okResult('Physical size: 1080x2400');
  if (cmd === 'dumpsys battery') return okResult('Current Battery Service state:\n  level: 88\n  status: 2');
  if (cmd === 'dumpsys power') return okResult('mWakefulness=Awake');
  if (cmd === 'dumpsys window policy') return okResult('isKeyguardShowing=false');
  if (cmd === 'dumpsys activity top') {
    return okResult('ACTIVITY com.stepos.ailauncher/.chat.activity.ChatMainActivity 123 pid=1');
  }
  if (cmd.startsWith('uiautomator dump ')) return okResult('UI hierarchy dumped to: /data/local/tmp/x.xml');
  if (cmd.startsWith('realpath ')) {
    return okResult(overrides.realpath || cmd.slice(9).trim().replace(/^'|'$/g, ''));
  }
  if (cmd.startsWith('sha256sum ')) return okResult(`${overrides.remoteSha || '0'.repeat(64)}  x`);
  if (cmd.startsWith('mv ') || cmd.startsWith('rm ') || cmd.startsWith('input ')) return okResult('');
  return okResult('');
}

function defaultExecOut(cmd, overrides = {}) {
  if (cmd === 'screencap -p') return bufferResult(overrides.png || makePng());
  if (cmd.startsWith('cat ')) return bufferResult(overrides.xml || UI_XML);
  return bufferResult(Buffer.alloc(0));
}

function createFakeTransport(overrides = {}) {
  const calls = [];
  const transport = {
    calls,
    serial: 'DEV1',
    getSerial() {
      return 'DEV1';
    },
    async shell(cmd, opts) {
      calls.push({ kind: 'shell', cmd, opts });
      if (typeof overrides.shell === 'function') {
        const custom = await overrides.shell(cmd, opts, calls);
        if (custom !== undefined) return custom;
      }
      return defaultShell(cmd, overrides);
    },
    async execOut(cmd, opts) {
      calls.push({ kind: 'execOut', cmd, opts });
      if (typeof overrides.execOut === 'function') {
        const custom = await overrides.execOut(cmd, opts, calls);
        if (custom !== undefined) return custom;
      }
      return defaultExecOut(cmd, overrides);
    },
    async push(local, remote, opts) {
      calls.push({ kind: 'push', local, remote, opts });
      return { bytes: fs.statSync(local).size, remote };
    },
    async pull(remote, local, opts) {
      calls.push({ kind: 'pull', remote, local, opts });
      const content = overrides.pullContent === undefined ? 'pulled' : overrides.pullContent;
      fs.writeFileSync(local, content);
      const bytes = Buffer.byteLength(content);
      return {
        bytes: overrides.pullBytes === undefined ? bytes : overrides.pullBytes,
        local,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
      };
    },
    snapshot() {
      return { state: 'HEALTHY', serial: 'DEV1', model: 'PZ261A', sdk: 36, reverse: {} };
    },
  };
  return transport;
}

function makeConfig(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amoon-phone-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spool = path.join(dir, 'spool');
  const screenshots = path.join(spool, 'screenshots');
  fs.mkdirSync(spool, { recursive: true });
  return {
    dir,
    spool,
    screenshots,
    config: {
      allowHighRisk: true,
      limits: C.LIMITS,
      paths: { dirs: { spool, screenshots } },
      ...overrides,
    },
  };
}

test('parseUiXml decodes entities, bounds, package and enforces the node cap', () => {
  const parsed = parseUiXml(UI_XML);
  assert.equal(parsed.nodes.length, 3);
  assert.equal(parsed.total, 3);
  assert.equal(parsed.truncated, false);
  assert.equal(parsed.package, 'com.stepos.ailauncher');
  assert.equal(parsed.nodes[1].text, '你好 & hello');
  assert.equal(parsed.nodes[1].rid, 'com.stepos.ailauncher:id/tv_title');
  assert.deepEqual(parsed.nodes[2].bounds, { x1: 900, y1: 2100, x2: 1060, y2: 2200 });
  assert.equal(parsed.nodes[2].clickable, true);
  assert.equal(parsed.nodes[2].enabled, true);

  const capped = parseUiXml(UI_XML, 2);
  assert.equal(capped.nodes.length, 2);
  assert.equal(capped.total, 3);
  assert.equal(capped.truncated, true);
});

test('pngSize/isPng accept a real IHDR and reject text', () => {
  const png = makePng(720, 1600);
  assert.equal(isPng(png), true);
  assert.deepEqual(pngSize(png), { width: 720, height: 1600 });
  assert.equal(isPng(Buffer.from('not a png')), false);
  assert.equal(pngSize(Buffer.from('not a png')), null);
});

test('phone_info returns serial/model/screen/battery/power/keyguard', async (t) => {
  const { config } = makeConfig(t);
  const tools = createPhoneTools({ config, adb: createFakeTransport(), logger: silentLogger });

  const result = await tools.phone_info({});
  assert.equal(result.ok, true);
  assert.equal(result.serial, 'ZYPZTEST0001');
  assert.equal(result.model, 'PZ261A');
  assert.equal(result.brand, 'StepX');
  assert.equal(result.sdk, 36);
  assert.deepEqual(result.screen, { width: 1080, height: 2400 });
  assert.deepEqual(result.battery, { level: 88, status: 2, status_label: '充电中' });
  assert.equal(result.screen_on, true);
  assert.equal(result.keyguard, false);
  assert.equal(result.wakefulness, 'Awake');
});

test('phone_screenshot writes the exact PNG buffer, hashes it and supports inline', async (t) => {
  const { config } = makeConfig(t);
  const png = makePng(1080, 2400);
  const adb = createFakeTransport({ png });
  const tools = createPhoneTools({ config, adb, logger: silentLogger });

  const result = await tools.phone_screenshot({});
  assert.equal(result.ok, true);
  assert.equal(result.bytes, png.length);
  assert.equal(result.width, 1080);
  assert.equal(result.height, 2400);
  assert.equal(result.base64, undefined);
  assert.equal(result.sha256, crypto.createHash('sha256').update(png).digest('hex'));
  assert.deepEqual(fs.readFileSync(result.path), png, 'PNG bytes must not be text-converted');

  const inline = await tools.phone_screenshot({ inline: true });
  assert.equal(inline.ok, true);
  assert.equal(Buffer.from(inline.base64, 'base64').equals(png), true);

  const screencapCall = adb.calls.find((call) => call.kind === 'execOut' && call.cmd === 'screencap -p');
  assert.ok(screencapCall, 'screenshot must use exec-out screencap -p');
});

test('phone_screenshot rejects non-PNG output instead of reporting success', async (t) => {
  const { config } = makeConfig(t);
  const adb = createFakeTransport({
    execOut(cmd) {
      if (cmd === 'screencap -p') return { ...okResult(), stdout: Buffer.from('error: no display') };
      return undefined;
    },
  });
  const tools = createPhoneTools({ config, adb, logger: silentLogger });
  const result = await tools.phone_screenshot({});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'internal_error');
});

test('phone_ui_dump returns nodes/package/activity and only includes raw on request', async (t) => {
  const { config } = makeConfig(t);
  const tools = createPhoneTools({ config, adb: createFakeTransport(), logger: silentLogger });

  const result = await tools.phone_ui_dump({});
  assert.equal(result.ok, true);
  assert.equal(result.nodes.length, 3);
  assert.equal(result.package, 'com.stepos.ailauncher');
  assert.equal(result.activity, 'com.stepos.ailauncher/.chat.activity.ChatMainActivity');
  assert.equal(result.raw_xml, undefined);
  assert.equal(result.truncated, false);

  const withRaw = await tools.phone_ui_dump({ include_raw: true });
  assert.equal(withRaw.ok, true);
  assert.match(withRaw.raw_xml, /<hierarchy/);
});

test('phone_ui_tap is high-risk gated, validates coordinates and taps node centers', async (t) => {
  const { config } = makeConfig(t, { allowHighRisk: false });
  const disabled = createPhoneTools({ config, adb: createFakeTransport(), logger: silentLogger });
  const denied = await disabled.phone_ui_tap({ x: 10, y: 10 });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'invalid_config');
  assert.equal(denied.error.details.reason, 'high_risk_disabled');

  const enabledDir = makeConfig(t);
  const adb = createFakeTransport({ xml: TAP_XML });
  const tools = createPhoneTools({ config: enabledDir.config, adb, logger: silentLogger });

  const outside = await tools.phone_ui_tap({ x: 5000, y: 10 });
  assert.equal(outside.ok, false);
  assert.equal(outside.error.code, 'invalid_args');

  const missingY = await tools.phone_ui_tap({ x: 10 });
  assert.equal(missingY.ok, false);

  const byRid = await tools.phone_ui_tap({ rid: 'btn_send' });
  assert.equal(byRid.ok, true);
  assert.equal(byRid.x, 980);
  assert.equal(byRid.y, 2150);
  assert.ok(adb.calls.some((call) => call.kind === 'shell' && call.cmd === 'input tap 980 2150'));

  const ambiguous = await tools.phone_ui_tap({ text: 'OK' });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error.details.reason, 'ambiguous_selector');

  const indexed = await tools.phone_ui_tap({ text: 'OK', index: 1 });
  assert.equal(indexed.ok, true);
  assert.equal(indexed.x, 250);
  assert.equal(indexed.y, 250);
});

test('phone_ui_swipe, phone_key and phone_text enforce their whitelists', async (t) => {
  const { config } = makeConfig(t);
  const adb = createFakeTransport();
  const tools = createPhoneTools({ config, adb, logger: silentLogger });

  const swipe = await tools.phone_ui_swipe({ x1: 10, y1: 100, x2: 10, y2: 900 });
  assert.equal(swipe.ok, true);
  assert.equal(swipe.duration_ms, 300);
  assert.ok(adb.calls.some((call) => call.kind === 'shell' && call.cmd === 'input swipe 10 100 10 900 300'));

  const home = await tools.phone_key({ key: 'HOME' });
  assert.equal(home.ok, true);
  assert.ok(adb.calls.some((call) => call.cmd === 'input keyevent KEYCODE_HOME'));

  const power = await tools.phone_key({ key: 'POWER' });
  assert.equal(power.ok, false);
  assert.equal(power.error.code, 'invalid_args');

  const chinese = await tools.phone_text({ text: '中文' });
  assert.equal(chinese.ok, false);
  assert.equal(chinese.error.code, 'unsupported_non_ascii');

  const ascii = await tools.phone_text({ text: 'hello world' });
  assert.equal(ascii.ok, true);
  assert.ok(
    adb.calls.some((call) => call.kind === 'shell' && call.cmd === "input text 'hello%sworld'"),
    'spaces must be encoded as %s and quoted'
  );
});

test('phone_file_push writes tmp+mv, verifies sha256 and rejects traversal', async (t) => {
  const { config, spool } = makeConfig(t);
  const local = path.join(spool, 'payload.txt');
  fs.writeFileSync(local, 'bridge payload', 'utf8');
  const digest = crypto.createHash('sha256').update('bridge payload').digest('hex');

  const adb = createFakeTransport({
    shell(cmd) {
      if (cmd.startsWith('sha256sum ')) return okResult(`${digest}  x`);
      return undefined;
    },
  });
  const tools = createPhoneTools({ config, adb, logger: silentLogger });

  const result = await tools.phone_file_push({ local_path: local, remote_name: 'payload.txt' });
  assert.equal(result.ok, true);
  assert.equal(result.remote, `${C.REMOTE_DIRS.blobs}/payload.txt`);
  assert.equal(result.sha256, digest);
  assert.equal(result.verified, true);
  assert.equal(result.bytes, 14);

  const pushCall = adb.calls.find((call) => call.kind === 'push');
  assert.ok(pushCall.remote.startsWith(`${C.REMOTE_DIRS.tmp}/`), 'push must land in tmp');
  assert.ok(
    adb.calls.some(
      (call) => call.kind === 'shell' && call.cmd.includes(`mv -f`) && call.cmd.includes(`${C.REMOTE_DIRS.blobs}/payload.txt`)
    ),
    'tmp must be renamed into blobs'
  );

  const traversal = await tools.phone_file_push({ local_path: local, remote_name: '../escape' });
  assert.equal(traversal.ok, false);
  assert.equal(traversal.error.code, 'invalid_args');

  const outside = path.join(spool, '..', 'outside.txt');
  fs.writeFileSync(outside, 'nope', 'utf8');
  const outsideResult = await tools.phone_file_push({ local_path: outside, remote_name: 'x.txt' });
  assert.equal(outsideResult.ok, false);
  assert.equal(outsideResult.error.code, 'invalid_args');
});

test('phone_file_pull enforces allowed roots, realpath and max_bytes', async (t) => {
  const { config, spool } = makeConfig(t);
  const adb = createFakeTransport({ pullContent: 'result body' });
  const tools = createPhoneTools({ config, adb, logger: silentLogger });

  const good = await tools.phone_file_pull({
    remote_path: `${C.REMOTE_DIRS.blobs}/a.bin`,
    max_bytes: 1024,
  });
  assert.equal(good.ok, true);
  assert.equal(good.bytes, 11);
  assert.equal(good.sha256, crypto.createHash('sha256').update('result body').digest('hex'));
  assert.ok(good.local_path.startsWith(spool));

  const traversal = await tools.phone_file_pull({
    remote_path: `${C.REMOTE_ROOT}/../etc/passwd`,
  });
  assert.equal(traversal.ok, false);
  assert.equal(traversal.error.code, 'invalid_args');

  const escapingAdb = createFakeTransport({ realpath: '/sdcard/other/secret.bin' });
  const escapingTools = createPhoneTools({ config, adb: escapingAdb, logger: silentLogger });
  const escape = await escapingTools.phone_file_pull({
    remote_path: `${C.REMOTE_DIRS.blobs}/link.bin`,
  });
  assert.equal(escape.ok, false);
  assert.equal(escape.error.code, 'invalid_args');

  const bigAdb = createFakeTransport({ pullContent: 'small', pullBytes: 9999 });
  const bigTools = createPhoneTools({ config, adb: bigAdb, logger: silentLogger });
  const tooBig = await bigTools.phone_file_pull({
    remote_path: `${C.REMOTE_DIRS.blobs}/big.bin`,
    max_bytes: 10,
  });
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.error.code, 'payload_too_large');
});

test('handlers convert thrown transport errors into {ok:false} without throwing', async (t) => {
  const { config } = makeConfig(t);
  const adb = createFakeTransport({
    shell() {
      throw new Error('transport exploded');
    },
  });
  const tools = createPhoneTools({ config, adb, logger: silentLogger });

  const result = await tools.phone_info({});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'internal_error');
  assert.match(result.error.message, /transport exploded/);
});

test('restricted read-only phone tools are exported; shell/root/read/write stay prohibited', async (t) => {
  const { config } = makeConfig(t);
  const tools = createPhoneTools({ config, adb: createFakeTransport(), logger: silentLogger });

  for (const name of ['phone_info', 'phone_app_list', 'phone_ls', 'phone_exec']) {
    assert.equal(typeof tools[name], 'function', `${name} must be callable`);
  }
  assert.equal(tools.phone_shell, undefined);
  assert.equal(tools.phone_su, undefined);

  for (const name of ['phone_exec', 'phone_ls', 'phone_app_list']) {
    assert.ok(PHONE_RESTRICTED_TOOLS.includes(name), `${name} is restricted`);
    assert.ok(!PHONE_PROHIBITED_TOOLS.includes(name), `${name} is not prohibited`);
  }
  for (const name of ['phone_shell', 'phone_su', 'phone_read', 'phone_write', 'phone_app_start']) {
    assert.ok(PHONE_PROHIBITED_TOOLS.includes(name), `${name} stays prohibited`);
  }

  const badArgs = await tools.phone_info('not-an-object');
  assert.equal(badArgs.ok, false);
  assert.equal(badArgs.error.code, 'invalid_args');

  // The dot-style facade is additive only; it must point at the same handlers.
  assert.equal(tools.ui.tap, tools.phone_ui_tap);
  assert.equal(tools.ui.click, tools.phone_ui_tap);
  assert.equal(tools.ui.dump, tools.phone_ui_dump);
  assert.equal(tools.shot, tools.phone_screenshot);
  assert.equal(tools.phone.exec, tools.phone_exec);
  assert.equal(tools.phone.ls, tools.phone_ls);
  assert.equal(tools.phone.apps, tools.phone_app_list);
});

test('phone_exec only accepts fixed diagnostic ops and rejects shell metacharacters', async (t) => {
  const { config } = makeConfig(t);
  const transport = createFakeTransport({
    shell(cmd) {
      if (cmd.startsWith('echo ')) return okResult('ok\n');
      return undefined;
    },
  });
  const tools = createPhoneTools({ config, adb: transport, logger: silentLogger });

  const echoed = await tools.phone_exec({ op: 'echo', text: 'ok' });
  assert.equal(echoed.ok, true);
  assert.equal(echoed.stdout, 'ok');

  const prop = await tools.phone_exec({ op: 'getprop', key: 'ro.product.model' });
  assert.equal(prop.ok, true);
  assert.equal(prop.value, 'PZ261A');

  const wm = await tools.phone_exec({ op: 'wm_size' });
  assert.deepEqual(wm.physical, { width: 1080, height: 2400 });

  const battery = await tools.phone_exec({ op: 'dumpsys_battery' });
  assert.equal(battery.level, 88);

  const unknownOp = await tools.phone_exec({ op: 'shell', text: 'id' });
  assert.equal(unknownOp.ok, false);
  assert.equal(unknownOp.error.code, 'invalid_args');

  const unknownKey = await tools.phone_exec({ op: 'getprop', key: 'persist.sys.timezone' });
  assert.equal(unknownKey.ok, false);
  assert.equal(unknownKey.error.code, 'forbidden_scope');

  for (const text of ['a | id', 'a > /sdcard/x', 'a; id', '$(id)', '`id`', 'a\nb', 'a && id']) {
    const injected = await tools.phone_exec({ op: 'echo', text });
    assert.equal(injected.ok, false, `must reject: ${JSON.stringify(text)}`);
    assert.equal(injected.error.code, 'invalid_args');
  }
  assert.ok(PHONE_EXEC_OPS.includes('echo'));
  // The only commands sent are fixed templates with quoted values.
  for (const call of transport.calls.filter((entry) => entry.kind === 'shell')) {
    assert.ok(!/id|\$\(|`/.test(call.cmd) || call.cmd.startsWith('echo '));
  }
});

test('phone_ls is allowlisted and rejects traversal, absolute escape and symlink escape', async (t) => {
  const { config } = makeConfig(t);
  const listing =
    'total 8\n' +
    'drwxrwx--- 2 u0_a168 u0_a168 3452 2026-10-21 18:00 files\n' +
    '-rw-rw---- 1 u0_a168 u0_a168 12 2026-10-21 18:01 a.txt\n';
  const transport = createFakeTransport({
    shell(cmd) {
      if (cmd.startsWith('realpath -e ')) {
        const value = cmd.slice('realpath -e '.length).replace(/^'|'$/g, '');
        if (value === '/sdcard/Download') return okResult('/storage/emulated/0/Download\n');
        if (value === '/sdcard/Download/escape') return okResult('/data/local/tmp\n');
        return okResult(`${value}\n`);
      }
      if (cmd.startsWith('ls -la ')) return okResult(listing);
      return undefined;
    },
  });
  const tools = createPhoneTools({ config, adb: transport, logger: silentLogger });

  const ok = await tools.phone_ls({ path: '/sdcard/Download' });
  assert.equal(ok.ok, true);
  assert.equal(ok.path, '/storage/emulated/0/Download');
  assert.equal(ok.entries.length, 2);
  assert.equal(ok.entries[0].name, 'files');
  assert.equal(ok.entries[0].type, 'dir');

  const top = await tools.phone_ls({ path: '/sdcard' });
  assert.equal(top.ok, true);

  const outside = await tools.phone_ls({ path: '/sdcard/Android' });
  assert.equal(outside.ok, false);
  assert.equal(outside.error.code, 'forbidden_scope');

  const traversal = await tools.phone_ls({ path: '/sdcard/Download/../Android' });
  assert.equal(traversal.ok, false);
  assert.equal(traversal.error.code, 'invalid_args');

  const symlink = await tools.phone_ls({ path: '/sdcard/Download/escape' });
  assert.equal(symlink.ok, false);
  assert.equal(symlink.error.code, 'forbidden_scope');

  // A path under /storage/emulated/0 that is outside the named roots must be
  // rejected even though it shares the resolved /sdcard prefix.
  const escapedResolved = createFakeTransport({
    shell(cmd) {
      if (cmd.startsWith('realpath -e ')) return okResult('/storage/emulated/0/Android\n');
      if (cmd.startsWith('ls -la ')) return okResult('');
      return undefined;
    },
  });
  const escapedTools = createPhoneTools({ config, adb: escapedResolved, logger: silentLogger });
  const escaped = await escapedTools.phone_ls({ path: '/sdcard/Download' });
  assert.equal(escaped.ok, false);
  assert.equal(escaped.error.code, 'forbidden_scope');

  const control = await tools.phone_ls({ path: '/sdcard/Download/\u0001' });
  assert.equal(control.ok, false);
  assert.equal(control.error.code, 'invalid_args');
});

test('phone_app_list reads packages and foreground without app control', async (t) => {
  const { config } = makeConfig(t);
  const transport = createFakeTransport({
    shell(cmd) {
      if (cmd === 'pm list packages') {
        return okResult(
          'package:com.stepos.ailauncher\npackage:com.android.settings\npackage:com.example.app\n'
        );
      }
      if (cmd === 'dumpsys window') {
        return okResult(
          'mCurrentFocus=Window{1 u0 com.stepos.ailauncher/com.stepos.ailauncher.MainActivity}'
        );
      }
      return undefined;
    },
  });
  const tools = createPhoneTools({ config, adb: transport, logger: silentLogger });

  const all = await tools.phone_app_list({});
  assert.equal(all.ok, true);
  assert.equal(all.total, 3);
  assert.equal(all.foreground.package, 'com.stepos.ailauncher');

  const filtered = await tools.phone_app_list({ filter: 'stepos' });
  assert.equal(filtered.total, 1);
  assert.deepEqual(filtered.packages, ['com.stepos.ailauncher']);

  const badFilter = await tools.phone_app_list({ filter: 'x; id' });
  assert.equal(badFilter.ok, false);
  assert.equal(badFilter.error.code, 'invalid_args');
  assert.equal(tools.phone_app_start, undefined);

  // parseLsEntries is shared with phone_ls and keeps names with spaces.
  const parsed = parseLsEntries('total 1\n-rw-rw---- 1 u0_a1 u0_a1 5 2026-10-21 18:00 a b.txt\n');
  assert.equal(parsed[0].name, 'a b.txt');
});

test('foreground activity parsing prefers topResumedActivity/mCurrentFocus over stacked ACTIVITY blocks', () => {
  const stacked = [
    'TASK taskId=1',
    '  ACTIVITY cn.yuewen.ywapp/.MainActivity',
    '  ACTIVITY com.google.android.gm/.ConversationListActivity',
    '  ACTIVITY com.stepx.amoobridge/.MainActivity',
    '  topResumedActivity=ActivityRecord{abc u0 com.stepx.amoobridge/.MainActivity t42}',
  ].join('\n');
  assert.deepEqual(parseActivityTop(stacked), {
    package: 'com.stepx.amoobridge',
    activity: '.MainActivity',
  });
  assert.deepEqual(
    parseActivities(stacked).map((entry) => entry.package),
    ['cn.yuewen.ywapp', 'com.google.android.gm', 'com.stepx.amoobridge']
  );

  const windowDump = [
    '  mCurrentFocus=Window{1 u0 com.stepx.amoobridge/com.stepx.amoobridge.MainActivity}',
    '  mFocusedApp=ActivityRecord{2 u0 com.stepx.amoobridge/.MainActivity t42}',
  ].join('\n');
  assert.deepEqual(parseForegroundActivity(windowDump), {
    package: 'com.stepx.amoobridge',
    activity: 'com.stepx.amoobridge.MainActivity',
  });
  assert.equal(parseForegroundActivity('no focus here'), null);
});
