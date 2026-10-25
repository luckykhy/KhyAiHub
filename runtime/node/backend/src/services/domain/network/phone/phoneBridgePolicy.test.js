'use strict';

/**
 * phoneBridgePolicy.test.js — co-located suite for the phone bridge policy leaf.
 *
 * IO: none. Every judgement here is a pure function of its inputs, which is the
 * whole point: the risk contract is assertable with no phone attached.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const policy = require('./phoneBridgePolicy');
const { ACCESS_READ, ACCESS_ACTUATE } = require('./phoneBridgeCatalog');

// ── argv builders ────────────────────────────────────────────────────────────

test('buildAdbArgv 有序列号时加 -s，没有时原样返回', () => {
  assert.deepEqual(policy.buildAdbArgv({ serial: '192.168.2.46:33743' }, ['shell', 'ls']), [
    '-s', '192.168.2.46:33743', 'shell', 'ls',
  ]);
  assert.deepEqual(policy.buildAdbArgv({}, ['shell', 'ls']), ['shell', 'ls']);
  assert.deepEqual(policy.buildAdbArgv(null, ['shell']), ['shell']);
  assert.deepEqual(policy.buildAdbArgv({ serial: 'x' }), ['-s', 'x']);
  assert.deepEqual(policy.buildAdbArgv({ serial: 'x' }, 'not-an-array'), ['-s', 'x']);
});

test('buildAdbArgv 只产 argv，绝不产 shell 串', () => {
  const argv = policy.buildAdbArgv({ serial: 's' }, ['shell', 'echo', 'hi; rm -rf /']);
  assert.equal(typeof argv.join(' '), 'string');
  assert.equal(argv.length, 5);
  // 注入的分号只是 argv 里的一个普通元素，不会被任何 shell 重新解释
  assert.equal(argv[4], 'hi; rm -rf /');
});

test('connect argv 永远是 connect，绝不是 pair', () => {
  const argv = policy.buildConnectArgv({ serial: '192.168.2.46:33743' });
  assert.deepEqual(argv, ['-s', '192.168.2.46:33743', 'connect', '192.168.2.46:33743']);
  assert.equal(argv.includes('pair'), false);
});

test('forward argv 是 tcp:<local> -> tcp:<remote>', () => {
  assert.deepEqual(policy.buildForwardArgv({ serial: 's' }, 8898, 8896), [
    '-s', 's', 'forward', 'tcp:8898', 'tcp:8896',
  ]);
});

test('revive 走导出广播（桥并入 khy-os App 后的唤醒路径）', () => {
  assert.deepEqual(policy.buildReviveArgv({ serial: 's' }), [
    '-s', 's', 'shell', 'am', 'broadcast',
    '-a', 'com.khyos.khy_os_client.bridge.REVIVE',
    '-n', 'com.khyos.khy_os_client/com.khyos.khy_os_client.bridge.ReviveReceiver',
  ]);
});

test('token/status 读取 argv 指向实测目录', () => {
  assert.deepEqual(policy.buildTokenReadArgv({ serial: 's' }, '/sdcard/bridge-amoobridge/token.txt'), [
    '-s', 's', 'shell', 'cat', '/sdcard/bridge-amoobridge/token.txt',
  ]);
  assert.deepEqual(policy.buildStatusReadArgv({ serial: 's' }, '/sdcard/bridge-amoobridge/status.json'), [
    '-s', 's', 'shell', 'cat', '/sdcard/bridge-amoobridge/status.json',
  ]);
});

// ── grants ───────────────────────────────────────────────────────────────────

test('五项授权全部适用于当前构建（桥在 khy-os App 内，无障碍由 App 承接）', () => {
  const grants = policy.listGrants();
  assert.equal(grants.length, 5);
  assert.deepEqual(grants.filter((g) => g.applicableToLiteBuild).map((g) => g.id).sort(), [
    'accessibility_service', 'battery_optimization', 'manage_external_storage',
    'usb_install_permission', 'write_settings',
  ]);
  const a11y = grants.find((g) => g.id === 'accessibility_service');
  assert.equal(a11y.applicableToLiteBuild, true);
  assert.match(a11y.why, /KhyAccessibilityService/);
  assert.equal(a11y.argv[4], 'com.khyos.khy_os_client/.KhyAccessibilityService');
});

test('必填授权是文件访问与电池白名单两项', () => {
  const required = policy.listGrants({ includeOptional: false }).map((g) => g.id).sort();
  assert.deepEqual(required, ['battery_optimization', 'manage_external_storage']);
});

test('includeOptional:false 时把可选项滤掉', () => {
  assert.equal(policy.listGrants({ includeOptional: false }).length, 2);
});

test('MANAGE_EXTERNAL_STORAGE 的 argv 与验证命令成对', () => {
  const grant = policy.findGrant('manage_external_storage');
  assert.deepEqual(grant.argv, ['appops', 'set', 'com.khyos.khy_os_client', 'MANAGE_EXTERNAL_STORAGE', 'allow']);
  assert.deepEqual(grant.verifyArgv, ['appops', 'get', 'com.khyos.khy_os_client', 'MANAGE_EXTERNAL_STORAGE']);
  assert.equal(grant.expectIncludes, 'allow');
});

test('USB 安装授权写成 :1——系统在安装失败后会自动写下 :0', () => {
  const grant = policy.findGrant('usb_install_permission');
  assert.equal(grant.argv[3], 'usb_install_item_com.khyos.khy_os_client');
  assert.equal(grant.argv[4], 'stepx-amoo-bridge:1');
  assert.equal(grant.expectIncludes, ':1');
});

test('findGrant 对未知 id 返 null，且返回的是副本', () => {
  assert.equal(policy.findGrant('nope'), null);
  assert.equal(policy.findGrant(undefined), null);
  const first = policy.findGrant('manage_external_storage');
  first.argv.push('MUTATED');
  assert.equal(policy.findGrant('manage_external_storage').argv.length, 5);
});

test('每项授权都有中文 label 与 why，且都是 argv 不是 shell 串', () => {
  for (const grant of policy.listGrants()) {
    assert.ok(grant.label && grant.label.length > 0, grant.id);
    assert.ok(grant.why && grant.why.length > 0, grant.id);
    assert.ok(Array.isArray(grant.argv) && grant.argv.every((a) => typeof a === 'string'), grant.id);
    assert.ok(Array.isArray(grant.verifyArgv), grant.id);
  }
});

// ── device path guard ────────────────────────────────────────────────────────

test('设备路径必须是绝对路径', () => {
  assert.equal(policy.validateDevicePath('sdcard/x').ok, false);
  assert.equal(policy.validateDevicePath('/sdcard/x').ok, true);
  assert.equal(policy.validateDevicePath('').ok, false);
  assert.equal(policy.validateDevicePath('   ').ok, false);
  assert.equal(policy.validateDevicePath(42).ok, false);
  assert.equal(policy.validateDevicePath(null).ok, false);
});

test('换行与空字符被当成命令注入拒绝，不是当成脏数据', () => {
  for (const bad of ['/sdcard/a\nrm -rf /', '/sdcard/a\rb', '/sdcard/a\0b']) {
    const res = policy.validateDevicePath(bad);
    assert.equal(res.ok, false, JSON.stringify(bad));
    assert.match(res.error, /换行或空字符/);
  }
});

test('含空白的路径被拒——adb shell 会按空白拆词', () => {
  const res = policy.validateDevicePath('/sdcard/my dir');
  assert.equal(res.ok, false);
  assert.match(res.error, /空白字符/);
});

test('validateDevicePath 返回 trim 后的值', () => {
  assert.equal(policy.validateDevicePath('  /sdcard/x  ').value, '/sdcard/x');
});

// ── validateBridgeArgs ───────────────────────────────────────────────────────

test('未知工具与空工具名被拒，不默许', () => {
  for (const bad of [undefined, null, '', '  ', 'nope', 'ui_dump', 42]) {
    const res = policy.validateBridgeArgs(bad, {});
    assert.equal(res.ok, false, JSON.stringify(bad));
    assert.equal(res.unknownTool, true);
  }
});

test('未知参数被拒而不是被静默丢弃', () => {
  const res = policy.validateBridgeArgs('exec', { cmd: 'id', injected: 'x' });
  assert.equal(res.ok, false);
  assert.match(res.error, /exec 不接受参数 injected/);
});

test('必填参数缺失被拒', () => {
  const res = policy.validateBridgeArgs('exec', {});
  assert.equal(res.ok, false);
  assert.match(res.error, /cmd 是必填项/);
  const read = policy.validateBridgeArgs('read', {});
  assert.equal(read.ok, false);
  assert.match(read.error, /path 是必填项/);
});

test('类型错误逐个报出，不合并成一句糊弄话', () => {
  assert.match(policy.validateBridgeArgs('exec', { cmd: 42 }).error, /cmd 必须是字符串/);
  assert.match(policy.validateBridgeArgs('exec', { cmd: 'id', timeout: 'abc' }).error, /timeout 必须是整数/);
  assert.match(policy.validateBridgeArgs('exec', { cmd: 'id', timeout: 1.5 }).error, /timeout 必须是整数/);
  assert.match(policy.validateBridgeArgs('write', { path: '/s', content: 1 }).error, /content 必须是字符串/);
  assert.match(policy.validateBridgeArgs('write', { path: '/s', append: 'yes' }).error, /append 必须是布尔值/);
  assert.match(policy.validateBridgeArgs('start_app', { package: 'p', extras: [] }).error, /extras 必须是对象/);
});

test('数值边界含端点，越界即拒', () => {
  assert.equal(policy.validateBridgeArgs('exec', { cmd: 'id', timeout: 1 }).ok, true);
  assert.equal(policy.validateBridgeArgs('exec', { cmd: 'id', timeout: 120 }).ok, true);
  assert.match(policy.validateBridgeArgs('exec', { cmd: 'id', timeout: 0 }).error, /不得小于 1/);
  assert.match(policy.validateBridgeArgs('exec', { cmd: 'id', timeout: 121 }).error, /不得大于 120/);
  assert.match(policy.validateBridgeArgs('brightness', { value: 256 }).error, /不得大于 255/);
  assert.match(policy.validateBridgeArgs('brightness', { value: -1 }).error, /不得小于 0/);
  assert.equal(policy.validateBridgeArgs('brightness', { value: 255 }).ok, true);
});

test('数值型字符串被归一成整数（JSON/命令行来的值常是字符串）', () => {
  const res = policy.validateBridgeArgs('exec', { cmd: 'id', timeout: '30' });
  assert.equal(res.ok, true);
  assert.equal(res.args.timeout, 30);
});

test('maxLength 在桥侧上限处收口', () => {
  assert.equal(policy.validateBridgeArgs('exec', { cmd: 'x'.repeat(4000) }).ok, true);
  const res = policy.validateBridgeArgs('exec', { cmd: 'x'.repeat(4001) });
  assert.equal(res.ok, false);
  assert.match(res.error, /长度 4001 超出上限 4000/);
});

test('enum 参数只接受列出的值', () => {
  assert.equal(policy.validateBridgeArgs('clipboard', { op: 'get' }).ok, true);
  assert.equal(policy.validateBridgeArgs('clipboard', { op: 'set' }).ok, true);
  assert.match(policy.validateBridgeArgs('clipboard', { op: 'peek' }).error, /必须是 get \/ set 之一/);
});

test('路径类参数走设备路径守卫', () => {
  assert.match(policy.validateBridgeArgs('ls', { path: 'sdcard' }).error, /必须是设备上的绝对路径/);
  assert.match(policy.validateBridgeArgs('ls', { path: '/sdcard/a\nb' }).error, /换行或空字符/);
  assert.match(policy.validateBridgeArgs('mv', { path: '/a', dest: 'b' }).error, /dest 必须是设备上的绝对路径/);
  assert.equal(policy.validateBridgeArgs('mv', { path: '/a', dest: '/b' }).ok, true);
});

test('合法调用回传归一化后的桥侧名字与参数', () => {
  const res = policy.validateBridgeArgs('phone_exec', { cmd: 'id', timeout: '5' });
  assert.equal(res.ok, true);
  assert.equal(res.bridgeName, 'exec');
  assert.equal(res.khyName, 'phone_exec');
  assert.deepEqual(res.args, { cmd: 'id', timeout: 5 });
});

test('可选参数不传时不出现在归一化结果里', () => {
  const res = policy.validateBridgeArgs('ls', {});
  assert.equal(res.ok, true);
  assert.deepEqual(res.args, {});
});

test('显式 null 的可选参数被当作未传，不当成类型错误', () => {
  const res = policy.validateBridgeArgs('exec', { cmd: 'id', timeout: null });
  assert.equal(res.ok, true);
  assert.deepEqual(res.args, { cmd: 'id' });
});

test('非对象 args 按空对象处理，不抛', () => {
  assert.equal(policy.validateBridgeArgs('battery', null).ok, true);
  assert.equal(policy.validateBridgeArgs('battery', 'nope').ok, true);
  assert.equal(policy.validateBridgeArgs('battery', []).ok, true);
  assert.equal(policy.validateBridgeArgs('exec', 42).ok, false);
});

test('桥侧别名也能过校验并解析到目标工具', () => {
  const res = policy.validateBridgeArgs('shell_exec', { cmd: 'id' });
  assert.equal(res.ok, true);
  assert.equal(res.bridgeName, 'exec');
});

// ── classifyBridgeCall ───────────────────────────────────────────────────────

test('只读调用不需要确认，档位 medium', () => {
  for (const name of ['ping', 'info', 'battery', 'list_apps', 'stat', 'ls']) {
    const c = policy.classifyBridgeCall(name, name === 'stat' ? { path: '/s' } : {});
    assert.equal(c.ok, true, name);
    assert.equal(c.access, ACCESS_READ, name);
    assert.equal(c.requiresConfirm, false, name);
    assert.equal(c.tier, 'medium', name);
  }
});

test('写调用一律要求确认，档位 high', () => {
  // rm 不在这张表里：它单独升到 critical，见下一条。
  for (const [name, args] of [['exec', { cmd: 'id' }], ['write', { path: '/s', content: 'x' }],
    ['start_app', { package: 'p' }], ['vibrate', {}], ['toast', { text: 'x' }]]) {
    const c = policy.classifyBridgeCall(name, args);
    assert.equal(c.ok, true, name);
    assert.equal(c.access, ACCESS_ACTUATE, name);
    assert.equal(c.requiresConfirm, true, name);
    assert.equal(c.tier, 'high', name);
  }
});

test('rm 单独升到 critical 并带上 recursive 默认 false 的警告', () => {
  // 2026-10-25：桥侧的 rm 默认由 true 改为 false（破坏性形态必须显式 opt-in），
  // 警告文案随之改为说明「要递归必须显式传 recursive: true」。
  const c = policy.classifyBridgeCall('rm', { path: '/sdcard/x' });
  assert.equal(c.tier, 'critical');
  assert.equal(c.requiresConfirm, true);
  assert.match(c.warning, /recursive 参数默认为 false/);
});

test('其余工具没有警告字段污染', () => {
  assert.equal(policy.classifyBridgeCall('exec', { cmd: 'id' }).warning, null);
  assert.equal(policy.classifyBridgeCall('battery').warning, null);
});

test('UI 工具被拒时说清需要无障碍，而不是报 unknown tool', () => {
  for (const name of ['ui_dump', 'ui_tap', 'ui_swipe', 'ui_click', 'ui_back', 'ui_home', 'shot_b64']) {
    const c = policy.classifyBridgeCall(name, {});
    assert.equal(c.ok, false, name);
    assert.equal(c.code, 'ui_tool_unavailable', name);
    assert.equal(c.requiresAccessibility, true, name);
    assert.match(c.error, /需要无障碍权限/);
    assert.match(c.detail, /KhyAccessibilityService/);
  }
});

test('v2.3.0：桥报告 ui=true 时 UI 工具按读/执行分级放行', () => {
  // 读类免确认（access 值 'read' 与 BRIDGE_TOOLS 同一套常量，此处用字面量断言）
  const dump = policy.classifyBridgeCall('ui_dump', {}, { uiAvailable: true });
  assert.equal(dump.ok, true);
  assert.equal(dump.access, 'read');
  assert.equal(dump.requiresConfirm, false);
  const shot = policy.classifyBridgeCall('shot_b64', { maxw: 480 }, { uiAvailable: true });
  assert.equal(shot.ok, true);
  assert.equal(shot.requiresConfirm, false);
  // 执行类走高危确认
  const tap = policy.classifyBridgeCall('ui_tap', { x: 1, y: 2 }, { uiAvailable: true });
  assert.equal(tap.ok, true);
  assert.equal(tap.access, 'actuate');
  assert.equal(tap.requiresConfirm, true);
  // 没有 ui 状态一律拒：undefined/false/非布尔真值都不放行
  for (const bad of [undefined, false, 'true', 1, null]) {
    assert.equal(
      policy.classifyBridgeCall('ui_dump', {}, { uiAvailable: bad }).code,
      'ui_tool_unavailable',
      JSON.stringify(bad)
    );
  }
  // plan 侧同一个开关
  assert.equal(policy.planBridgeCall({ tool: 'ui_tap', args: { x: 1, y: 2 }, uiAvailable: true }).success, true);
  assert.equal(policy.planBridgeCall({ tool: 'ui_dump', args: {} }).code, 'ui_tool_unavailable');
});

test('参数非法的调用带 code，便于上层分派', () => {
  const badArg = policy.classifyBridgeCall('exec', {});
  assert.equal(badArg.ok, false);
  assert.equal(badArg.code, 'invalid_args');
  const unknown = policy.classifyBridgeCall('nope', {});
  assert.equal(unknown.code, 'unknown_tool');
});

test('access 随参数翻转的三个工具在分类层就判对', () => {
  assert.equal(policy.classifyBridgeCall('clipboard', {}).requiresConfirm, false);
  assert.equal(policy.classifyBridgeCall('clipboard', { op: 'set', text: 'x' }).requiresConfirm, true);
  assert.equal(policy.classifyBridgeCall('volume', {}).requiresConfirm, false);
  assert.equal(policy.classifyBridgeCall('volume', { level: 3 }).requiresConfirm, true);
  assert.equal(policy.classifyBridgeCall('brightness', { value: 1 }).requiresConfirm, true);
});

test('分类结果带上结果体积上限', () => {
  assert.equal(policy.classifyBridgeCall('exec', { cmd: 'id' }).resultCapChars, 20000);
  assert.equal(policy.classifyBridgeCall('battery').resultCapChars, 512);
});

// ── planBridgeCall ───────────────────────────────────────────────────────────

test('只读调用直接放行，不生成计划', () => {
  const plan = policy.planBridgeCall({ tool: 'battery', args: {} });
  assert.equal(plan.success, true);
  assert.equal(plan.requiresConfirm, false);
  assert.equal(plan.classification.access, ACCESS_READ);
});

test('写调用无 confirm 时只回计划，绝不回「已执行」', () => {
  const plan = policy.planBridgeCall({ tool: 'exec', args: { cmd: 'id' }, baseUrl: 'http://127.0.0.1:8896' });
  assert.equal(plan.success, true);
  assert.equal(plan.requiresConfirm, true);
  assert.equal(plan.code, 'requires_confirm');
  assert.deepEqual(plan.plan.args, { cmd: 'id' });
  assert.equal(plan.plan.bridgeName, 'exec');
  assert.equal(plan.plan.access, ACCESS_ACTUATE);
  assert.equal(plan.plan.endpoint, 'http://127.0.0.1:8896/call');
  assert.match(plan.message, /确认后重发并带 confirm:true/);
  assert.match(plan.message, /会改变你手机的状态/);
});

test('计划里带 endpoint；没给 baseUrl 时退回裸路径', () => {
  assert.equal(policy.planBridgeCall({ tool: 'exec', args: { cmd: 'id' } }).plan.endpoint, '/call');
});

test('计划失败时不伪装成成功', () => {
  const plan = policy.planBridgeCall({ tool: 'nope', args: {} });
  assert.equal(plan.success, false);
  assert.equal(plan.code, 'unknown_tool');
  const uiPlan = policy.planBridgeCall({ tool: 'ui_tap', args: {} });
  assert.equal(uiPlan.success, false);
  assert.equal(uiPlan.code, 'ui_tool_unavailable');
});

// ── token hygiene ────────────────────────────────────────────────────────────

test('normalizeToken 吃掉 adb shell cat 带出的换行与空白', () => {
  assert.equal(policy.normalizeToken('5500fae8db41cd054f45ea8834198d30\n'), '5500fae8db41cd054f45ea8834198d30');
  assert.equal(policy.normalizeToken('  5500fae8db41cd054f45ea8834198d30  \r\n'), '5500fae8db41cd054f45ea8834198d30');
  assert.equal(policy.normalizeToken('a\nb'), 'b');
  assert.equal(policy.normalizeToken(''), '');
  assert.equal(policy.normalizeToken(undefined), '');
  assert.equal(policy.normalizeToken(null), '');
});

test('isValidTokenShape 只认 32 位十六进制', () => {
  const good = '5500fae8db41cd054f45ea8834198d30';
  assert.equal(policy.isValidTokenShape(good), true);
  assert.equal(policy.isValidTokenShape(good.toUpperCase()), true);
  assert.equal(policy.isValidTokenShape(good.slice(0, 31)), false);
  assert.equal(policy.isValidTokenShape(`${good}0`), false);
  assert.equal(policy.isValidTokenShape('not-a-token'), false);
  assert.equal(policy.isValidTokenShape(''), false);
  assert.equal(policy.isValidTokenShape(undefined), false);
  assert.equal(policy.isValidTokenShape(1234), false);
});

test('redactSecrets 覆盖 Authorization 头、Bearer 串与裸 32 hex', () => {
  const token = '5500fae8db41cd054f45ea8834198d30';
  assert.equal(
    policy.redactSecrets(`Authorization: Bearer ${token}`),
    'Authorization: Bearer ***'
  );
  assert.equal(policy.redactSecrets(`bearer ${token}`), 'bearer [redacted-token]');
  assert.equal(policy.redactSecrets(token), '[redacted-token]');
});

test('redactSecrets 不碰普通文本，也不抛', () => {
  const plain = 'adb: unable to connect to 192.168.2.46:33743';
  assert.equal(policy.redactSecrets(plain), plain);
  assert.equal(policy.redactSecrets(undefined), '');
  assert.equal(policy.redactSecrets(null), '');
  assert.equal(policy.redactSecrets(42), '42');
});

test('GRANTS 常量被冻结，改不动', () => {
  assert.throws(() => {
    policy.GRANTS.push({ id: 'x' });
  });
});

test('ARG_TYPES 与目录里实际用到的类型一致', () => {
  const catalog = require('./phoneBridgeCatalog');
  const used = new Set();
  for (const tool of catalog.BRIDGE_TOOLS) {
    for (const spec of Object.values(tool.args)) {
      used.add(spec.type);
    }
  }
  for (const type of used) {
    assert.ok(policy.ARG_TYPES.includes(type), type);
  }
  assert.deepEqual([...used].sort(), ['boolean', 'integer', 'object', 'string']);
});
