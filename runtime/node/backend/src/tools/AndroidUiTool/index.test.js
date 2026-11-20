'use strict';

/**
 * AndroidUiTool/index.test.js — wiring contract of the D1 consumer.
 *
 * Policy lives in the service unit (androidRef/androidUiPolicy.test.js and
 * index.test.js). What is not covered there is the wiring, and that is where the
 * security contract sits: the gate must mean "the tool does not exist", execute
 * must delegate to the phone/androidRef facade, and the tool must never inject
 * confirm:true or build its own adb argv.
 *
 * Gate cases run in a child process: the tool reads env at require time.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TOOL_PATH = path.join(__dirname, 'index.js');

function probeToolShape(env) {
  const script = [
    'const m = require(process.argv[1]);',
    'const C = m && m.constructor;',
    'const disabled = !!(m && m._khyAndroidUiDisabled);',
    'const hasExec = typeof m.execute === "function";',
    'const hasPrompt = typeof m.prompt === "function";',
    'const hasSchema = !!(m.inputSchema && m.inputSchema.properties);',
    'const isTool = !disabled && hasExec && hasPrompt && hasSchema;',
    'console.log(JSON.stringify({',
    '  disabled, isTool,',
    '  toolName: isTool ? (C && C.toolName) : null,',
    '  risk: isTool ? (C && C.risk) : null,',
    '  category: isTool ? (C && C.category) : null,',
    '  searchHint: isTool ? (C && C.searchHint) : null,',
    '  actions: isTool ? m.inputSchema.properties.action.enum : null,',
    '  promptLength: isTool ? m.prompt().length : null,',
    '}));',
  ].join('\n');
  const out = execFileSync(process.execPath, ['-e', script, TOOL_PATH], {
    env: Object.assign({}, process.env, env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const line = out.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(line);
}

/** Comments and string literals stripped: "does the code do X" must not match prose. */
function codeOnly(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

// ── gating ───────────────────────────────────────────────────────────────────

test('默认与显式 1 都登记真工具（名称/风险/分类/动作表）', () => {
  for (const env of [{}, { KHY_ANDROID_UI_TOOL: '1' }, { KHY_ANDROID_UI_TOOL: '' }]) {
    const shape = probeToolShape(env);
    assert.equal(shape.disabled, false);
    assert.equal(shape.isTool, true);
    assert.equal(shape.toolName, 'AndroidUi');
    assert.equal(shape.risk, 'high');
    assert.equal(shape.category, 'system');
    assert.deepEqual(shape.actions,
      ['snapshot', 'tap', 'longpress', 'swipe', 'back', 'home', 'recents', 'type']);
  }
});

test('父闸 KHY_PHONE_BRIDGE=0 时子闸一并关（关 = 工具不存在）', () => {
  const shape = probeToolShape({ KHY_ANDROID_UI_TOOL: '1', KHY_PHONE_BRIDGE: '0' });
  assert.equal(shape.disabled, true);
  assert.equal(shape.isTool, false);
});

test('KHY_ANDROID_UI_TOOL 关 → 导出 benign 占位，自动发现跳过', () => {
  for (const value of ['0', 'false', 'off', 'no']) {
    const shape = probeToolShape({ KHY_ANDROID_UI_TOOL: value });
    assert.equal(shape.disabled, true, `${value} 应导出禁用标记`);
    assert.equal(shape.isTool, false, `${value} 不应导出可执行工具`);
  }
});

// ── metadata ─────────────────────────────────────────────────────────────────

test('prompt ≤600 字符；searchHint 非空且不复读工具名', () => {
  const shape = probeToolShape({});
  assert.ok(shape.promptLength > 0 && shape.promptLength <= 600,
    `prompt 长度 ${shape.promptLength} 超 600`);
  assert.equal(typeof shape.searchHint, 'string');
  assert.ok(shape.searchHint.trim().length > 0);
  assert.doesNotMatch(shape.searchHint.toLowerCase(), /androidui/);
});

// ── delegation, not re-implementation ────────────────────────────────────────

test('执行委托到 phone/androidRef 门面，不自己拼 adb 指令', () => {
  const src = fs.readFileSync(TOOL_PATH, 'utf8');
  assert.match(src, /require\('\.\.\/\.\.\/services\/domain\/network\/phone\/androidRef'\)/);
  assert.match(src, /getAndroidRef/);
  const code = codeOnly(TOOL_PATH);
  assert.doesNotMatch(code, /child_process|execFile|spawn\(/);
  // Device argv only exists in the service layer: no argv literal in the tool.
  assert.doesNotMatch(src, /\['shell'/);
  assert.doesNotMatch(src, /\['exec-out'/);
});

test('工具绝不替模型代传 confirm:true', () => {
  const code = codeOnly(TOOL_PATH);
  assert.doesNotMatch(code, /confirm\s*:\s*true/);
  // Only the value the model supplied is forwarded.
  assert.match(code, /params\.confirm === true/);
});

// ── execute behavior (facade stubbed, no device) ─────────────────────────────

function withFakeService(fake, fn) {
  const service = require('../../services/domain/network/phone/androidRef');
  const original = service.getAndroidRef;
  service.getAndroidRef = () => fake;
  try {
    return fn();
  } finally {
    service.getAndroidRef = original;
  }
}

test('execute 把参数原样交给服务，不自己解析 ref/坐标', async () => {
  const seen = [];
  const fake = { run: async (input) => { seen.push(input); return { success: true, action: input.action }; } };
  const tool = require('./index');

  const res = await withFakeService(fake, () => tool.execute({
    action: 'tap', ref: 'e14', confirm: true,
  }, {}));

  assert.equal(res.success, true);
  assert.deepEqual(seen[0], {
    action: 'tap', ref: 'e14', text: undefined, direction: undefined, distance: undefined, confirm: true,
  });
});

test('模型没给 confirm 时传下去的是 false，不是 undefined 也不是 true', async () => {
  const seen = [];
  const fake = { run: async (input) => { seen.push(input); return { success: false, requiresConfirm: true }; } };
  const tool = require('./index');

  await withFakeService(fake, () => tool.execute({ action: 'tap', ref: 'e14' }, {}));
  assert.equal(seen[0].confirm, false);
});

test('缺省 action 是 snapshot', async () => {
  const seen = [];
  const fake = { run: async (input) => { seen.push(input); return { success: true, action: input.action }; } };
  const tool = require('./index');

  await withFakeService(fake, () => tool.execute({}, {}));
  assert.equal(seen[0].action, 'snapshot');
});

test('未知 action 直接拒绝，不进入服务层', async () => {
  let called = false;
  const fake = { run: async () => { called = true; return { success: true }; } };
  const tool = require('./index');

  const res = await withFakeService(fake, () => tool.execute({ action: 'click' }, {}));
  assert.equal(res.success, false);
  assert.match(res.error, /未知 action/);
  assert.match(res.error, /snapshot/);
  assert.equal(called, false);
});

test('服务层抛错时收敛成可读错误，不把栈抛给模型', async () => {
  const fake = { run: async () => { throw new Error('boom'); } };
  const tool = require('./index');

  const res = await withFakeService(fake, () => tool.execute({ action: 'snapshot' }, {}));
  assert.equal(res.success, false);
  assert.match(res.error, /boom/);
  assert.ok(res.hint);
});
