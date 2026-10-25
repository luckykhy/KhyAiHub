'use strict';

/**
 * phoneBridgeCatalog.test.js — co-located suite for the bridge contract catalog (pure leaf).
 *
 * IO: none. Every fact here is a translation decision, pinned so a README that
 * disagrees with the shipped artifact cannot quietly rewrite the contract.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const catalog = require('./phoneBridgeCatalog');

const REAL_TOOL_NAMES = Object.freeze([
  'ping', 'info', 'exec', 'ls', 'read', 'write', 'mkdir', 'rm', 'mv', 'cp', 'stat',
  'start_app', 'open_url', 'share_text', 'clipboard', 'toast', 'notify',
  'list_apps', 'battery', 'volume', 'brightness', 'vibrate',
  'loop_start', 'loop_stop', 'loop_status',
  'amoo_ask', 'amoo_result', 'amoo_memory',
]);

const REAL_UI_TOOL_NAMES = Object.freeze([
  'ui_dump', 'ui_tap', 'ui_click', 'ui_swipe', 'ui_longpress', 'ui_type',
  'ui_back', 'ui_home', 'ui_recents', 'shot', 'shot_b64',
]);

test('目录收录的正是实机 28 个非 UI 工具，一个不多一个不少', () => {
  assert.equal(catalog.BRIDGE_TOOLS.length, 28);
  assert.deepEqual(
    catalog.BRIDGE_TOOLS.map((t) => t.bridgeName).sort(),
    [...REAL_TOOL_NAMES].sort()
  );
});

test('UI 工具单独成表，不混进可真调用的目录', () => {
  assert.deepEqual([...catalog.UI_TOOLS].sort(), [...REAL_UI_TOOL_NAMES].sort());
  for (const name of REAL_UI_TOOL_NAMES) {
    assert.equal(catalog.findPhoneBridgeTool(name), null, `${name} 不是可真调用的工具`);
    assert.equal(catalog.isPhoneBridgeUiToolName(name), true);
  }
  assert.equal(catalog.isPhoneBridgeUiToolName('exec'), false);
});

test('ui_type 算执行类不算读取类，读表不会误判为只读', () => {
  // ui_type 用 ACTION_SET_TEXT 往别的 App 的输入框里写内容——它改的是目标
  // App 的状态，与 ui_tap/ui_click 同级，必须落在 ACTUATE。若哪天有人把它
  // 挪到 ACCESS_READ，无 PC 闭环里「写回结果」这一步就会被当成免确认只读
  // 操作放行，那正是这套分级要防的。
  assert.equal(catalog.UI_TOOL_ACCESS.ui_type, catalog.ACCESS_ACTUATE);
  assert.notEqual(catalog.UI_TOOL_ACCESS.ui_type, catalog.ACCESS_READ);
  // 且必须真的在分级表里——漏登记会让调用方按未知工具处理。
  for (const name of REAL_UI_TOOL_NAMES) {
    assert.ok(catalog.UI_TOOL_ACCESS[name], `${name} 没有准入分级`);
  }
});

test('khy 侧名字一律 phone_ 前缀且不与桥侧原名混淆', () => {
  for (const tool of catalog.BRIDGE_TOOLS) {
    assert.ok(tool.khyName.startsWith('phone_'), tool.khyName);
    assert.notEqual(tool.khyName, tool.bridgeName);
    assert.equal(catalog.resolveBridgeToolName(tool.khyName), tool.bridgeName);
  }
});

test('五个桥侧别名都解析到目标工具', () => {
  const expected = {
    shell_exec: 'exec',
    file_read: 'read',
    file_write: 'write',
    file_list: 'ls',
    sys_info: 'info',
  };
  for (const [alias, target] of Object.entries(expected)) {
    assert.equal(catalog.resolveBridgeToolName(alias), target);
    assert.equal(catalog.findPhoneBridgeTool(alias).bridgeName, target);
  }
});

test('别名表自身与桥侧 Tools 的别名一一对应', () => {
  assert.deepEqual({ ...catalog.ALIAS_TARGETS }, {
    shell_exec: 'exec',
    file_read: 'read',
    file_write: 'write',
    file_list: 'ls',
    sys_info: 'info',
  });
});

test('未知与空名字一律返 null，不抛', () => {
  for (const bad of [undefined, null, '', '   ', 'ui_dump', 'nope', 42, {}]) {
    assert.equal(catalog.findPhoneBridgeTool(bad), null, JSON.stringify(bad));
    assert.equal(catalog.resolveBridgeToolName(bad), null);
  }
  assert.equal(catalog.isPhoneBridgeToolName(''), false);
  assert.equal(catalog.isPhoneBridgeToolName('exec'), true);
});

test('access 只有 read / actuate 两档，且每个工具都显式声明', () => {
  for (const tool of catalog.BRIDGE_TOOLS) {
    assert.ok(
      tool.access === catalog.ACCESS_READ || tool.access === catalog.ACCESS_ACTUATE,
      `${tool.bridgeName} access=${tool.access}`
    );
  }
});

test('依赖参数翻转 access 的四个工具被标出来，而不是靠调用方猜', () => {
  const flip = catalog.BRIDGE_TOOLS.filter((t) => t.accessDependsOnOp).map((t) => t.bridgeName);
  // amoo_memory 的 op=get 是读、op=set 是写，所以必须跟 brightness/volume/clipboard
  // 一样显式标注——不标的话 set 会被当成免确认的读操作放行。
  assert.deepEqual(flip.sort(), ['amoo_memory', 'brightness', 'clipboard', 'volume']);
});

test('getPhoneBridgeToolAccess：clipboard 按 op 翻、volume/brightness 按有无值翻', () => {
  assert.equal(catalog.getPhoneBridgeToolAccess('clipboard'), catalog.ACCESS_READ);
  assert.equal(catalog.getPhoneBridgeToolAccess('clipboard', { op: 'get' }), catalog.ACCESS_READ);
  assert.equal(catalog.getPhoneBridgeToolAccess('clipboard', { op: 'set' }), catalog.ACCESS_ACTUATE);
  assert.equal(catalog.getPhoneBridgeToolAccess('volume'), catalog.ACCESS_READ);
  assert.equal(catalog.getPhoneBridgeToolAccess('volume', { level: 3 }), catalog.ACCESS_ACTUATE);
  assert.equal(catalog.getPhoneBridgeToolAccess('brightness'), catalog.ACCESS_READ);
  assert.equal(catalog.getPhoneBridgeToolAccess('brightness', { value: 128 }), catalog.ACCESS_ACTUATE);
  // 不随参数翻转的工具：传什么都是同一档
  assert.equal(catalog.getPhoneBridgeToolAccess('battery', { level: 9 }), catalog.ACCESS_READ);
  assert.equal(catalog.getPhoneBridgeToolAccess('rm', {}), catalog.ACCESS_ACTUATE);
  // 未知工具返 null 而不是默认放行
  assert.equal(catalog.getPhoneBridgeToolAccess('nope'), null);
});

test('写操作集合与桥契约逐条对得上', () => {
  const actuating = catalog.BRIDGE_TOOLS
    .filter((t) => t.access === catalog.ACCESS_ACTUATE && !t.accessDependsOnOp)
    .map((t) => t.bridgeName)
    .sort();
  assert.deepEqual(actuating, [
    'amoo_ask', 'cp', 'exec', 'loop_start', 'loop_stop', 'mkdir', 'mv', 'notify', 'open_url',
    'rm', 'share_text', 'start_app', 'toast', 'vibrate', 'write',
  ]);
});

test('rm 被单独标为 dangerous——recursive 默认 true 会连锅端', () => {
  const rm = catalog.findPhoneBridgeTool('rm');
  assert.equal(rm.dangerous, true);
  assert.equal(rm.args.recursive.description.includes('默认 true'), true);
  const others = catalog.BRIDGE_TOOLS.filter((t) => t.dangerous).map((t) => t.bridgeName);
  assert.deepEqual(others, ['rm']);
});

test('exec 的两个已知陷阱写进 note，不藏在实现里', () => {
  const exec = catalog.findPhoneBridgeTool('exec');
  assert.match(exec.note, /input \/ screencap \/ dumpsys \/ su \/ pm/);
  assert.match(exec.args.timeout.description, /sleep 300/);
  assert.equal(exec.args.timeout.maximum, 120);
  assert.equal(exec.args.timeout.minimum, 1);
});

test('UI 能力缺口有一句固定中文说明，指向 khy-os App 的无障碍服务', () => {
  assert.match(catalog.ACCESSIBILITY_GAP_REASON, /KhyAccessibilityService/);
  assert.match(catalog.ACCESSIBILITY_GAP_REASON, /无障碍服务/);
});

test('toKhyToolDefinition 转译出合法 JSON Schema 与 phone_ 名字', () => {
  const defs = catalog.listKhyToolDefinitions();
  // 28 = 22 个既有桥工具 + 3 个循环控制 + 3 个反代与记忆。
  assert.equal(defs.length, 28);
  for (const def of defs) {
    assert.ok(def.name.startsWith('phone_'));
    assert.equal(def.inputSchema.type, 'object');
    assert.ok(Array.isArray(def.inputSchema.required));
    assert.ok(def.description.length > 0);
    assert.ok(def.description.length <= 600, `${def.name} description ${def.description.length}`);
    for (const [argName, prop] of Object.entries(def.inputSchema.properties)) {
      assert.ok(['string', 'integer', 'boolean', 'object'].includes(prop.type), `${def.name}.${argName}`);
    }
  }
});

test('exec 的 schema 钉住 required/maxLength/取值范围', () => {
  const def = catalog.listKhyToolDefinitions().find((d) => d.bridgeName === 'exec');
  assert.deepEqual(def.inputSchema.required, ['cmd']);
  assert.equal(def.inputSchema.properties.cmd.maxLength, 4000);
  assert.equal(def.inputSchema.properties.timeout.minimum, 1);
  assert.equal(def.inputSchema.properties.timeout.maximum, 120);
  assert.equal(def.risk, 'high');
  assert.equal(def.requiresAccessibility, false);
});

test('rm 的风险档是 critical，其余写操作是 high，只读是 medium', () => {
  const byName = new Map(catalog.listKhyToolDefinitions().map((d) => [d.bridgeName, d.risk]));
  assert.equal(byName.get('rm'), 'critical');
  assert.equal(byName.get('exec'), 'high');
  assert.equal(byName.get('battery'), 'medium');
  assert.equal(byName.get('clipboard'), 'medium');
});

test('clipboard 的 op 用 enum 收窄，避免任意字符串穿透到桥上', () => {
  const def = catalog.listKhyToolDefinitions().find((d) => d.bridgeName === 'clipboard');
  assert.deepEqual(def.inputSchema.properties.op.enum, ['get', 'set']);
});

test('truncateBridgeResultText 超限才截断，并报出原长度', () => {
  const short = catalog.truncateBridgeResultText('abc', 10);
  assert.deepEqual(short, { text: 'abc', truncated: false });
  const long = catalog.truncateBridgeResultText('x'.repeat(50), 10);
  assert.equal(long.truncated, true);
  assert.equal(long.text.startsWith('xxxxxxxxxx'), true);
  assert.match(long.text, /原长度 50 字符/);
});

test('truncateBridgeResultText 对非字符串与坏上限不抛', () => {
  assert.equal(catalog.truncateBridgeResultText(undefined, 10).text, '');
  assert.equal(catalog.truncateBridgeResultText(null, 10).text, '');
  assert.equal(catalog.truncateBridgeResultText(42, 10).text, '42');
  assert.equal(catalog.truncateBridgeResultText('abcdef', 0).truncated, false);
  assert.equal(catalog.truncateBridgeResultText('abcdef', -5).truncated, false);
});

// ── UI 结果的字段级豁免 ──────────────────────────────────────────────────────
// 承重墙：shot_b64 的 b64 与 ui_dump 的 xml 的「大小就是载荷本身」。它们曾被
// 静默切成 8000 字符——GUI agent 拿到半张 JPEG，不报错，只是模型凭空变笨，
// 这种故障形态最难归因。豁免必须是字段级：否则同一个工具的 orig_w/bytes/scale
// 也一起拿到 40 万字符的上限，那既无收益又丢掉「一个工具不能灌满一轮」的保证。

test('shot_b64 的 b64 与 ui_dump 的 xml 有字段级豁免', () => {
  assert.equal(catalog.uiToolResultFieldCap('shot_b64', 'b64'), 400000);
  assert.equal(catalog.uiToolResultFieldCap('ui_dump', 'xml'), 400000);
});

test('豁免是字段级不是工具级：同工具的普通字段拿不到豁免', () => {
  // shot_b64 同时返回 orig_w/orig_h/w/h/bytes/scale，它们都是个位数到五位数，
  // 给 40 万字符上限没有任何收益。
  for (const field of ['orig_w', 'orig_h', 'w', 'h', 'bytes', 'scale', 'ok']) {
    assert.equal(catalog.uiToolResultFieldCap('shot_b64', field), null, field);
  }
  for (const field of ['nodes', 'ok']) {
    assert.equal(catalog.uiToolResultFieldCap('ui_dump', field), null, field);
  }
  // 不在表里的工具一律 null，由调用方回退到工具自身的 resultCapChars。
  assert.equal(catalog.uiToolResultFieldCap('exec', 'out'), null);
  assert.equal(catalog.uiToolResultFieldCap('read', 'content'), null);
  assert.equal(catalog.uiToolResultFieldCap('shot', 'b64'), null);
  // 坏输入不抛
  for (const bad of [undefined, null, '', 42, {}]) {
    assert.equal(catalog.uiToolResultFieldCap(bad, 'b64'), null, JSON.stringify(bad));
    assert.equal(catalog.uiToolResultFieldCap('shot_b64', bad), null, JSON.stringify(bad));
  }
});

test('豁免表被冻结，改不动', () => {
  assert.throws(() => {
    catalog.UI_TOOL_RESULT_FIELD_CAPS.shot_b64.b64 = 1;
  });
});

test('非 UI 工具的上限没有被这次修复顺手抬高', () => {
  // 范围证明：修的是 UI 分支缺 resultCapChars 导致的静默回退，
  // 不是把所有工具的上限一起放大。exec/read 仍走它们自己的上限。
  assert.equal(catalog.getResultCapChars('exec'), catalog.LARGE_RESULT_CAP_CHARS);
  assert.equal(catalog.getResultCapChars('read'), catalog.LARGE_RESULT_CAP_CHARS);
  assert.equal(catalog.getResultCapChars('ping'), 512);
  assert.equal(catalog.uiToolResultFieldCap('exec', 'out'), null);
});

test('每个工具都有 summary 与 note，resultCapChars 是正整数', () => {
  for (const tool of catalog.BRIDGE_TOOLS) {
    assert.ok(tool.summary && tool.summary.length > 0, tool.bridgeName);
    assert.ok(tool.note && tool.note.length > 0, tool.bridgeName);
    assert.ok(Number.isInteger(tool.resultCapChars) && tool.resultCapChars > 0, tool.bridgeName);
    assert.ok(tool.resultCapChars <= catalog.LARGE_RESULT_CAP_CHARS, tool.bridgeName);
  }
});

test('getResultCapChars 对未知工具回退到默认上限', () => {
  assert.equal(catalog.getResultCapChars('nope'), catalog.DEFAULT_RESULT_CAP_CHARS);
  assert.equal(catalog.getResultCapChars('exec'), catalog.LARGE_RESULT_CAP_CHARS);
  assert.equal(catalog.getResultCapChars('ping'), 512);
});

test('getPhoneBridgeTools 返回副本，改返回值不污染目录', () => {
  const first = catalog.getPhoneBridgeTools();
  first[0].bridgeName = 'mutated';
  first[0].args.injected = { type: 'string' };
  assert.equal(catalog.BRIDGE_TOOLS[0].bridgeName, 'ping');
  assert.equal(catalog.BRIDGE_TOOLS[0].args.injected, undefined);
});

test('getPhoneBridgeUiTools 返回副本', () => {
  const list = catalog.getPhoneBridgeUiTools();
  list.push('ui_fake');
  assert.equal(catalog.UI_TOOLS.includes('ui_fake'), false);
});
