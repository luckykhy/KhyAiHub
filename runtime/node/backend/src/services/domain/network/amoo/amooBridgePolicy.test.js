'use strict';

// Co-located unit test for amooBridgePolicy.js.
//
// This leaf is the unit's safety surface: the allow-list, the confirm gate and
// the argv builders. Every case here is assertable with NO phone attached —
// that is the point. The pinned defects it guards against:
//   - a tool that is not in the installed lite build must be rejected, not
//     forwarded (the bridge answers `unknown tool` and the caller would read
//     that as a transport failure),
//   - `exec` and `rm` must demand confirm,
//   - `adb pair` must be unrepresentable — the builders only ever emit connect,
//   - argv must stay flat: no shell string is ever produced.

const test = require('node:test').test;
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

function pinSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-amoo-pol-'));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.KHY_DATA_HOME = path.join(root, 'data');
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('KHY_AMOO_')) {
      delete process.env[key];
    }
  }
  return root;
}

pinSandbox();

const policy = require('./amooBridgePolicy');
const {
  BRIDGE_TOOLS,
  evaluateBridgeCall,
  buildConnectArgv,
  buildDevicesArgv,
  buildForwardArgv,
  buildForwardListArgv,
  buildForwardRemoveArgv,
  buildShellArgv,
  buildLaunchAmooArgv,
  buildTapArgv,
  buildKeyEventArgv,
  buildUiDumpArgv,
  buildPullArgv,
  buildPushArgv,
  buildRemoveArgv,
  buildTokenReadArgv,
  buildRecoverBridgeArgv,
  parseDeviceList,
  classifyDeviceList,
  parseBridgeStatus,
  normalizeBridgeToken,
  maskToken,
  escapeForDeviceShell,
  KEY_EVENT_PASTE,
} = policy;

test('the allow-list is exactly the installed lite build', () => {
  const names = Object.keys(BRIDGE_TOOLS).sort();
  assert.deepEqual(names, [
    'battery',
    'brightness',
    'clipboard',
    'cp',
    'exec',
    'info',
    'list_apps',
    'ls',
    'mkdir',
    'mv',
    'notify',
    'open_url',
    'ping',
    'read',
    'rm',
    'share_text',
    'start_app',
    'stat',
    'toast',
    'verify_unused_placeholder',
    'vibrate',
    'volume',
    'write',
  ].filter((name) => name !== 'verify_unused_placeholder').sort());
  // The lite build advertises 22 tools; the list must not silently grow past it.
  assert.equal(names.length, 22);
});

test('a tool outside the list is rejected with the available names', () => {
  const decision = evaluateBridgeCall({ tool: 'ui_dump', args: {} });
  assert.equal(decision.ok, false);
  assert.equal(decision.code, 'tool_not_allowed');
  assert.match(decision.message, /ui_dump/);
  // The lite build has no UI tools at all; this is the case that proves it.
  for (const uiTool of ['ui_tap', 'ui_swipe', 'ui_click', 'ui_back', 'ui_home', 'shot_b64']) {
    assert.equal(evaluateBridgeCall({ tool: uiTool }).ok, false);
  }
});

test('read-only tools are classified read-only and never need confirm', () => {
  // Each tool gets its required args so the case really tests the risk tier and
  // not the arg validator.
  const cases = [
    ['ping', {}],
    ['info', {}],
    ['ls', { path: '/sdcard' }],
    ['read', { path: '/sdcard/a.txt' }],
    ['stat', { path: '/sdcard/a.txt' }],
    ['list_apps', {}],
    ['battery', {}],
  ];
  for (const [name, args] of cases) {
    const decision = evaluateBridgeCall({ tool: name, args });
    assert.equal(decision.ok, true, name);
    assert.equal(decision.readOnly, true, name);
    assert.equal(decision.requiresConfirm, false, name);
    assert.equal(decision.willExecute, true, name);
  }
});

test('exec and rm demand an explicit confirm and stay unexecuted without it', () => {
  const execPlan = evaluateBridgeCall({ tool: 'exec', args: { cmd: 'id' } });
  assert.equal(execPlan.ok, true);
  assert.equal(execPlan.risk, 'high');
  assert.equal(execPlan.requiresConfirm, true);
  assert.equal(execPlan.willExecute, false);
  const execGo = evaluateBridgeCall({ tool: 'exec', args: { cmd: 'id' }, confirm: true });
  assert.equal(execGo.willExecute, true);
  const rmPlan = evaluateBridgeCall({ tool: 'rm', args: { path: '/sdcard/x' } });
  assert.equal(rmPlan.requiresConfirm, true);
  assert.equal(rmPlan.willExecute, false);
  // A truthy-but-not-true confirm is not a confirm.
  assert.equal(evaluateBridgeCall({ tool: 'rm', args: { path: '/sdcard/x' }, confirm: 'yes' }).willExecute, false);
});

test('arg validation covers required, type, length, range and allowed-set', () => {
  // `ls` 的 path **不再必填**：手机原生是 `a.optString("path", "/sdcard")`
  // （Tools.java:873）——path 有默认值，故桥侧契约标可选，PC 侧策略必须一致，
  // 否则「列默认目录」这种调用会被 PC 侧拒掉而手机侧本来能跑。
  // 必填性的测例改用确实无默认值的参数：`write` 的 path。
  assert.equal(evaluateBridgeCall({ tool: 'write', args: {} }).code, 'arg_required');
  assert.equal(evaluateBridgeCall({ tool: 'ls', args: { path: 5 } }).code, 'arg_type');
  assert.equal(evaluateBridgeCall({ tool: 'ls', args: { path: 'x'.repeat(600) } }).code, 'arg_too_long');
  assert.equal(
    evaluateBridgeCall({ tool: 'exec', args: { cmd: 'id', timeout: 999 } }).code,
    'arg_range'
  );
  // Length is checked before the allowed-set, so the two are separated by size:
  // 'set-all' (7 chars) is short but invalid, 'paste-all' (9 chars) is too long.
  assert.equal(
    evaluateBridgeCall({ tool: 'clipboard', args: { op: 'set-all' } }).code,
    'arg_not_allowed'
  );
  assert.equal(
    evaluateBridgeCall({ tool: 'clipboard', args: { op: 'paste-all' } }).code,
    'arg_too_long'
  );
  assert.equal(
    evaluateBridgeCall({ tool: 'brightness', args: { value: 300 } }).code,
    'arg_range'
  );
  assert.equal(
    evaluateBridgeCall({ tool: 'clipboard', args: { op: 'set', text: 'x'.repeat(20001) } }).code,
    'arg_too_long'
  );
});

test('clipboard op=set is allowed without confirm (it is the only CJK route)', () => {
  const decision = evaluateBridgeCall({ tool: 'clipboard', args: { op: 'set', text: '中文任务' } });
  assert.equal(decision.ok, true);
  assert.equal(decision.risk, 'medium');
  assert.equal(decision.willExecute, true);
});

/**
 * 契约与手机原生对齐（本组 3 条是实测出来的真 bug，不是风格调整）：
 *
 *   1. `write` 的正文参数原生读 `content`（Tools.java:949），PC 侧策略原来
 *      声明 `text`——于是 evaluateBridgeCall 会**拒掉手机原生的真实参数名**，
 *      而 `text` 到了手机侧根本没人读。这是一条必然失败的调用路径。
 *   2. `volume` 原生读 `level`（Tools.java:835），PC 侧原来声明 `value`
 *      ——`value` 到了手机侧没人读，音量**静默不变**（比报错更坏）。
 *   3. `start_app` 原生认 package/component/extras/action/uri
 *      （Tools.java:587-600），PC 侧原来只声明 package+component，
 *      漏掉的那三个会被当「未知参数」拒掉。
 *
 * 另：ls.path / clipboard.op / notify.title / notify.text 的必填性已对齐
 * 原生的 optString 默认值——原来标必填会把「用默认值即可」的合法调用拒掉。
 */
test('PC-side contract matches the phone native parameter names (not a style choice)', () => {
  // 1. write 的正文参数是 content，不是 text
  assert.equal(
    evaluateBridgeCall({ tool: 'write', args: { path: '/sdcard/a.txt', content: 'hi' } }).ok,
    true,
    '原生读 content，PC 侧策略不得拒掉它'
  );
  assert.equal(
    evaluateBridgeCall({ tool: 'write', args: { path: '/sdcard/a.txt', text: 'hi' } }).code,
    'arg_unknown',
    'text 不是原生参数名，须被拒（否则会以空内容覆盖文件）'
  );

  // 2. volume 的档位参数是 level，不是 value
  assert.equal(
    evaluateBridgeCall({ tool: 'volume', args: { level: 5 } }).ok,
    true,
    '原生读 level，PC 侧策略不得拒掉它'
  );
  assert.equal(
    evaluateBridgeCall({ tool: 'volume', args: { value: 5 } }).code,
    'arg_unknown',
    'value 不是原生的音量参数名（那是亮度的），须被拒'
  );

  // 3. start_app 的 extras/action/uri 原生都认
  for (const extra of [{ extras: { a: 'b' } }, { action: 'x' }, { uri: 'y' }]) {
    const decision = evaluateBridgeCall({
      tool: 'start_app',
      args: { package: 'com.x', ...extra },
    });
    assert.equal(decision.ok, true, `start_app 应接受 ${JSON.stringify(extra)}`);
  }
});

test('params with a native default are optional on the PC side too', () => {
  // 原生：ls -> a.optString("path", "/sdcard")（Tools.java:873）
  assert.equal(evaluateBridgeCall({ tool: 'ls', args: {} }).ok, true);
  // 原生：clipboard -> a.optString("op", "get")（Tools.java:529）
  assert.equal(evaluateBridgeCall({ tool: 'clipboard', args: {} }).ok, true);
  // 原生：notify -> a.optString("title", "khy-os 桥")（Tools.java:548）
  assert.equal(evaluateBridgeCall({ tool: 'notify', args: { text: 'x' } }).ok, true);
  // write 的 path 无默认值，仍必填
  assert.equal(evaluateBridgeCall({ tool: 'write', args: {} }).code, 'arg_required');
});

test('adb pair is unrepresentable: builders only ever emit connect', () => {
  const builders = [
    buildConnectArgv('192.168.2.46', 33743),
    buildDevicesArgv(),
    buildForwardArgv('192.168.2.46:33743', 8896, 8896),
    buildForwardListArgv('192.168.2.46:33743'),
    buildShellArgv('s', 'id'),
    buildLaunchAmooArgv('s', 'com.stepos.ailauncher/.chat.activity.ChatMainActivity', 'com.stepos.ailauncher.action.OPEN_CHAT'),
    buildTapArgv('s', 10, 20),
    buildKeyEventArgv('s', KEY_EVENT_PASTE),
    buildUiDumpArgv('s', '/sdcard/x.xml'),
    buildPullArgv('s', '/sdcard/x.xml', 'C:/tmp/x.xml'),
    buildPushArgv('s', 'C:/tmp/x.json', '/sdcard/bridge-amoobridge/cmd_1.json'),
    buildRecoverBridgeArgv('s', 'com.khyos.khy_os_client'),
  ];
  for (const argv of builders) {
    assert.ok(Array.isArray(argv));
    assert.ok(argv.every((item) => typeof item === 'string'), 'argv must be flat strings');
    assert.ok(!argv.includes('pair'), `pair leaked into ${argv.join(' ')}`);
  }
  assert.deepEqual(buildConnectArgv('192.168.2.46', 33743), ['connect', '192.168.2.46:33743']);
  assert.deepEqual(buildForwardArgv('S', 8898, 8896), ['-s', 'S', 'forward', 'tcp:8898', 'tcp:8896']);
  assert.deepEqual(buildKeyEventArgv('S', 279), ['-s', 'S', 'shell', 'input', 'keyevent', '279']);
  assert.deepEqual(buildTapArgv('S', 1031.4, 1359.6), ['-s', 'S', 'shell', 'input', 'tap', '1031', '1360']);
  assert.deepEqual(buildUiDumpArgv('S', '/sdcard/a.xml'), ['-s', 'S', 'shell', 'uiautomator', 'dump', '/sdcard/a.xml']);
});

test('launch argv uses component AND action (Amoo has no LAUNCHER category)', () => {
  const argv = buildLaunchAmooArgv(
    '192.168.2.46:33743',
    'com.stepos.ailauncher/.chat.activity.ChatMainActivity',
    'com.stepos.ailauncher.action.OPEN_CHAT'
  );
  assert.deepEqual(argv, [
    '-s',
    '192.168.2.46:33743',
    'shell',
    'am',
    'start',
    '-n',
    'com.stepos.ailauncher/.chat.activity.ChatMainActivity',
    '-a',
    'com.stepos.ailauncher.action.OPEN_CHAT',
  ]);
});

test('bridge revival broadcasts REVIVE, never am start or am start-service', () => {
  const argv = buildRecoverBridgeArgv('192.168.2.46:33743', 'com.khyos.khy_os_client');
  assert.deepEqual(argv, [
    '-s',
    '192.168.2.46:33743',
    'shell',
    'am',
    'broadcast',
    '-a',
    'com.khyos.khy_os_client.bridge.REVIVE',
    '-n',
    'com.khyos.khy_os_client/com.khyos.khy_os_client.bridge.ReviveReceiver',
  ]);
});

test('every device-scoped builder carries -s <serial>', () => {
  // Android 11+ wireless debugging registers an mDNS/TLS entry for the SAME
  // handset, so `adb devices` can list two devices and any command without -s
  // dies with "more than one device/emulator". This is how the missing serial in
  // buildRecoverBridgeArgv was found on the real device.
  const serial = '192.168.2.46:33743';
  const scoped = [
    buildForwardArgv(serial, 8896, 8896),
    buildForwardListArgv(serial),
    buildForwardRemoveArgv(serial, 8896),
    buildShellArgv(serial, 'id'),
    buildLaunchAmooArgv(serial, 'com.stepos.ailauncher/.chat.activity.ChatMainActivity', 'com.stepos.ailauncher.action.OPEN_CHAT'),
    buildTapArgv(serial, 1, 2),
    buildKeyEventArgv(serial, KEY_EVENT_PASTE),
    buildUiDumpArgv(serial, '/sdcard/x.xml'),
    buildPullArgv(serial, '/sdcard/x.xml', 'C:/tmp/x.xml'),
    buildPushArgv(serial, 'C:/tmp/x.json', '/sdcard/bridge-amoobridge/cmd_1.json'),
    buildRemoveArgv(serial, '/sdcard/x.xml'),
    buildTokenReadArgv(serial, '/sdcard/bridge-amoobridge/token.txt'),
    buildRecoverBridgeArgv(serial, 'com.khyos.khy_os_client'),
  ];
  for (const argv of scoped) {
    assert.equal(argv[0], '-s', `missing -s in ${argv.join(' ')}`);
    assert.equal(argv[1], serial, `wrong serial in ${argv.join(' ')}`);
  }
  // The two deliberately unscoped commands stay unscoped.
  assert.deepEqual(buildConnectArgv('192.168.2.46', 33743), ['connect', '192.168.2.46:33743']);
  assert.deepEqual(buildDevicesArgv(), ['devices']);
});

test('parseDeviceList / classifyDeviceList read adb devices output', () => {
  const stdout = 'List of devices attached\n192.168.2.46:33743\tdevice\nemulator-5554\toffline\n';
  assert.deepEqual(parseDeviceList(stdout), [
    { serial: '192.168.2.46:33743', state: 'device' },
    { serial: 'emulator-5554', state: 'offline' },
  ]);
  assert.deepEqual(classifyDeviceList(stdout, '192.168.2.46:33743'), {
    connected: true,
    entries: parseDeviceList(stdout),
    reason: null,
  });
  assert.equal(classifyDeviceList(stdout, 'emulator-5554').reason, 'device_offline');
  assert.equal(classifyDeviceList(stdout, 'nope').reason, 'device_absent');
  assert.equal(classifyDeviceList('', 'nope').connected, false);
});

test('parseDeviceList keeps mDNS/TLS serials that contain a space', () => {
  // Byte-for-byte from the real device: adb separates the fields with a TAB and
  // the wireless-debugging serial itself contains a space plus a " (2)" suffix.
  const stdout = 'List of devices attached\r\nadb-ZYPZ261A01M6870010L-R9QdlL (2)._adb-tls-connect._tcp\tdevice\r\n\r\n';
  const serial = 'adb-ZYPZ261A01M6870010L-R9QdlL (2)._adb-tls-connect._tcp';
  assert.deepEqual(parseDeviceList(stdout), [{ serial, state: 'device' }]);
  assert.deepEqual(classifyDeviceList(stdout, serial), {
    connected: true,
    entries: parseDeviceList(stdout),
    reason: null,
  });
  // A truncated match must not be reported as connected either.
  assert.equal(classifyDeviceList(stdout, 'adb-ZYPZ261A01M6870010L-R9QdlL').reason, 'device_absent');
  // Space-separated (older adb) output must still parse.
  assert.deepEqual(parseDeviceList('List of devices attached\nmy serial with spaces device\n'), [
    { serial: 'my serial with spaces', state: 'device' },
  ]);
});

test('parseBridgeStatus reports staleness and never throws on junk', () => {
  const now = 1792584152782;
  const fresh = parseBridgeStatus(
    JSON.stringify({ running: true, ts: now - 1000, pid: 31290, http_port: 8896, mode: 'lite', canWrite: true, tools: 22 }),
    { nowMs: now }
  );
  assert.equal(fresh.running, true);
  assert.equal(fresh.pid, 31290);
  assert.equal(fresh.httpPort, 8896);
  assert.equal(fresh.tools, 22);
  assert.equal(fresh.canWrite, true);
  assert.equal(fresh.stale, false);

  const stale = parseBridgeStatus(JSON.stringify({ running: true, ts: now - 60000 }), { nowMs: now });
  assert.equal(stale.stale, true);

  const junk = parseBridgeStatus('not json', { nowMs: now });
  assert.equal(junk.running, false);
  assert.equal(junk.stale, true);
  assert.equal(junk.pid, null);
});

test('token normalisation and masking', () => {
  assert.deepEqual(normalizeBridgeToken('  5500fae8db41cd054f45ea8834198d30\n'), {
    ok: true,
    token: '5500fae8db41cd054f45ea8834198d30',
    reason: null,
  });
  assert.equal(normalizeBridgeToken('').reason, 'token_empty');
  assert.equal(normalizeBridgeToken('   ').reason, 'token_empty');
  assert.equal(normalizeBridgeToken('short').reason, 'token_too_short');
  assert.equal(normalizeBridgeToken('has spaces and more').reason, 'token_malformed');
  assert.equal(maskToken('5500fae8db41cd054f45ea8834198d30'), '5500…8d30');
  assert.equal(maskToken(''), '****');
  assert.equal(maskToken('abc'), '****');
});

test('escapeForDeviceShell quotes once and survives embedded single quotes', () => {
  assert.equal(escapeForDeviceShell('hello world'), "'hello world'");
  assert.equal(escapeForDeviceShell("it's fine"), "'it'\\''s fine'");
  // CJK passes through untouched — input text still refuses it, which is why
  // the clipboard route exists, but the escaping must not corrupt it.
  assert.equal(escapeForDeviceShell('中文 任务'), "'中文 任务'");
});
