'use strict';

// Co-located contract tests for sandboxToggleState.js (零 IO 纯叶子)。
// Everything is injected through arguments; measured values come from
// .khyos/tmp/probeA1.js / probeA2.js. Two defects are pinned, not fixed.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSandboxFlag,
  resolveSandboxState,
  planSandboxAction,
  isEnabled,
} = require('./sandboxToggleState');

test('normalizeSandboxFlag 认全 true/false 同义词族并折叠大小写与空白', () => {
  for (const raw of ['true', 'TRUE', 'on', 'On', '1', '1 ', 'yes', 'enable', 'enabled', ' true ']) {
    assert.equal(normalizeSandboxFlag(raw), 'true', `${raw} folds to true`);
  }
  for (const raw of ['off', ' OFF ', 'false', 'Disable', 'disabled', 'no', '0']) {
    assert.equal(normalizeSandboxFlag(raw), 'false', `${raw} folds to false`);
  }
  for (const raw of ['auto', 'default', 'DEFAULT']) {
    assert.equal(normalizeSandboxFlag(raw), 'auto');
  }
});

test('normalizeSandboxFlag 把空串/缺省/空数组都读作 auto，把无法识别读作空串', () => {
  for (const raw of ['', '   ', null, undefined, [], 'auto']) {
    assert.equal(normalizeSandboxFlag(raw), 'auto', `${String(raw)} is the auto family`);
  }
  // 'reset' is accepted by planSandboxAction but is NOT a flag value — that asymmetry is real.
  assert.equal(normalizeSandboxFlag('reset'), '');
  assert.equal(normalizeSandboxFlag('banana'), '');
  assert.equal(normalizeSandboxFlag('y'), '', 'single letters are not aliases');
  assert.equal(normalizeSandboxFlag('n'), '');
  assert.equal(normalizeSandboxFlag({}), '', 'String({}) is "[object Object]"');
  assert.doesNotThrow(() => normalizeSandboxFlag(Symbol('x')));
  assert.equal(normalizeSandboxFlag(Symbol('x')), '');
});

test('normalizeSandboxFlag 对数字与布尔按字符串化判定（0 是 false，1 是 true）', () => {
  assert.equal(normalizeSandboxFlag(0), 'false');
  assert.equal(normalizeSandboxFlag(1), 'true');
  assert.equal(normalizeSandboxFlag(true), 'true');
  assert.equal(normalizeSandboxFlag(false), 'false');
  assert.equal(normalizeSandboxFlag(NaN), '', 'String(NaN) is "nan" which is in no set');
  assert.equal(normalizeSandboxFlag(new String('on')), 'true');
});

test('resolveSandboxState 显式 false 短路一切平台探测', () => {
  const s = resolveSandboxState({ flag: 'false', platform: 'linux', bwrapAvailable: true });
  assert.deepEqual(s, {
    flag: 'false',
    effective: false,
    backend: 'bubblewrap',
    available: true,
    reason: '已显式关闭(KHY_OS_SANDBOX=false)',
  });
  assert.deepEqual(Object.keys(s), ['flag', 'effective', 'backend', 'available', 'reason']);
});

test('resolveSandboxState 按注入的平台事实选后端，true 与 auto 一律看可用性', () => {
  assert.equal(resolveSandboxState({ flag: 'true', platform: 'linux', bwrapAvailable: true }).effective, true);
  assert.equal(resolveSandboxState({ flag: 'auto', platform: 'linux', bwrapAvailable: true }).effective, true);
  assert.equal(resolveSandboxState({ flag: 'true', platform: 'linux', bwrapAvailable: false }).effective, false);
  assert.equal(resolveSandboxState({ flag: 'true', platform: 'darwin', seatbeltAvailable: true }).backend, 'seatbelt');
  assert.equal(resolveSandboxState({ flag: 'true', platform: 'darwin', seatbeltAvailable: true }).reason, '已显式开启 → seatbelt 生效');
  assert.equal(resolveSandboxState({ flag: 'auto', platform: 'darwin', seatbeltAvailable: true }).reason, 'auto(平台后端可用) → seatbelt 生效');
});

test('resolveSandboxState win32 的 Job Object 恒可用，忽略注入的 false', () => {
  for (const flag of ['true', 'auto', undefined]) {
    const s = resolveSandboxState({ flag, platform: 'win32', bwrapAvailable: false, seatbeltAvailable: false });
    assert.equal(s.backend, 'job-object');
    assert.equal(s.available, true);
    assert.equal(s.effective, true);
  }
});

test('resolveSandboxState 未知平台得到 none/不可用，reason 带上原平台名', () => {
  const s = resolveSandboxState({ platform: 'freebsd', bwrapAvailable: true, seatbeltAvailable: true });
  assert.deepEqual(s, {
    flag: 'auto',
    effective: false,
    backend: 'none',
    available: false,
    reason: '当前平台(freebsd)无 OS 沙箱后端',
  });
  assert.equal(resolveSandboxState({}).reason, '当前平台(未知)无 OS 沙箱后端');
  assert.equal(resolveSandboxState().reason, '当前平台(未知)无 OS 沙箱后端');
});

test('KNOWN-DEFECT resolveSandboxState(null) 抛 TypeError，而同叶子的 isEnabled(null) 只是返回 false', () => {
  // The header contract says 绝不抛; the default parameter only covers `undefined`.
  assert.throws(() => resolveSandboxState(null), TypeError);
  assert.equal(isEnabled(null), false, 'the gate degrades instead of throwing');
  assert.doesNotThrow(() => resolveSandboxState(undefined));
  assert.doesNotThrow(() => resolveSandboxState(0));
  assert.equal(resolveSandboxState(0).backend, 'none');
});

test('KNOWN-DEFECT 平台名区分大小写，flag 却做了大小写折叠', () => {
  assert.equal(resolveSandboxState({ platform: 'LINUX', bwrapAvailable: true }).backend, 'none');
  assert.equal(resolveSandboxState({ platform: 'Win32' }).backend, 'none');
  assert.equal(resolveSandboxState({ platform: 'Win32'.toLowerCase() }).backend, 'job-object');
  assert.equal(normalizeSandboxFlag('TRUE'), 'true', 'the flag side is case-insensitive');
});

test('resolveSandboxState 字符串平台名与多余键都不影响判定', () => {
  assert.equal(resolveSandboxState('linux').backend, 'none', 'a bare string carries no platform field');
  assert.equal(resolveSandboxState({ platform: 'linux', bwrapAvailable: 1, extra: 'x' }).effective, true, 'truthiness of the probe flag, not === true');
  assert.equal(resolveSandboxState({ flag: 'reset', platform: 'darwin', seatbeltAvailable: true }).flag, 'auto', 'an unknown flag falls back to auto');
  assert.equal(resolveSandboxState({ flag: 0, platform: 'win32' }).flag, 'false', 'numeric 0 reads as an explicit off');
});

test('planSandboxAction auto/default/reset 三种动作都落成 unset（回默认）', () => {
  for (const action of ['auto', 'default', 'reset', ' AUTO ']) {
    assert.deepEqual(planSandboxAction(action, 'true'), { ok: true, unset: true, parseError: null });
    assert.deepEqual(Object.keys(planSandboxAction(action)), ['ok', 'unset', 'parseError']);
  }
  // cur is irrelevant for the unset family.
  assert.deepEqual(planSandboxAction('auto', 'false'), { ok: true, unset: true, parseError: null });
});

test('planSandboxAction 显式动作只报目标 flag，不看当前值', () => {
  for (const action of ['on', 'true', 'enable', '1']) {
    assert.deepEqual(planSandboxAction(action, 'false'), { ok: true, flag: 'true', parseError: null });
  }
  for (const action of ['off', 'false', 'disable', '0']) {
    assert.deepEqual(planSandboxAction(action, 'true'), { ok: true, flag: 'false', parseError: null });
  }
  assert.deepEqual(planSandboxAction(0), { ok: true, flag: 'false', parseError: null });
});

test('planSandboxAction toggle 只在当前显式 false 时翻成 true', () => {
  assert.deepEqual(planSandboxAction('toggle', 'false'), { ok: true, flag: 'true', parseError: null });
  assert.deepEqual(planSandboxAction('toggle', 'true'), { ok: true, flag: 'false', parseError: null });
  assert.deepEqual(planSandboxAction('toggle', 'auto'), { ok: true, flag: 'false', parseError: null });
  assert.deepEqual(planSandboxAction('toggle', 'banana'), { ok: true, flag: 'false', parseError: null }, 'an unknown current folds to auto → off');
  assert.deepEqual(planSandboxAction('toggle'), { ok: true, flag: 'false', parseError: null });
  assert.deepEqual(planSandboxAction(''), { ok: true, flag: 'false', parseError: null }, 'empty action means toggle');
  assert.deepEqual(planSandboxAction('', 'false'), { ok: true, flag: 'true', parseError: null });
});

test('planSandboxAction 未知动作给 ok:false 与人类可读 parseError', () => {
  const r = planSandboxAction('banana', 'false');
  assert.deepEqual(r, { ok: false, parseError: '未知动作:banana(支持 on|off|auto|toggle)' });
  assert.equal('flag' in r, false, 'no half-built plan on failure');
  assert.equal('unset' in r, false);
  // Only the action is echoed; a null action folds to the toggle branch instead of erroring.
  assert.deepEqual(planSandboxAction(null), { ok: true, flag: 'false', parseError: null });
  assert.equal(planSandboxAction({}).parseError, '未知动作:[object Object](支持 on|off|auto|toggle)');
});

test('isEnabled 默认开，关词集为 0/false/off/no（含空串，与门控族的空串即开不同）', () => {
  assert.equal(isEnabled(), true);
  assert.equal(isEnabled({}), true);
  assert.equal(isEnabled({ KHY_SANDBOX_TOGGLE: undefined }), true);
  for (const off of ['0', 'false', 'off', 'no', '', 'OFF', ' false ']) {
    assert.equal(isEnabled({ KHY_SANDBOX_TOGGLE: off }), false, `${JSON.stringify(off)} switches the gate off`);
  }
  for (const on of ['true', '1', 'yes', 'banana', 1, true]) {
    assert.equal(isEnabled({ KHY_SANDBOX_TOGGLE: on }), true, `${String(on)} is not an off word`);
  }
  assert.equal(isEnabled({ KHY_SANDBOX_TOGGLE: null }), false, 'null is stringified to "" → off');
  assert.equal(isEnabled({ KHY_SANDBOX_TOGGLE: 0 }), false);
  assert.equal(isEnabled({ KHY_SANDBOX_TOGGLE: false }), false);
});

test('KNOWN-DEFECT isEnabled(null) 关闭命令而 isEnabled(undefined) 开启，env 真假决定门控', () => {
  assert.equal(isEnabled(null), false, 'a null env silently disables the command');
  assert.equal(isEnabled(undefined), true, 'undefined takes the default `{}`');
  assert.equal(isEnabled(0), false, '`env && env.X` short-circuits to the falsy env itself');
  assert.equal(isEnabled('false'), true, 'a string env carries no flag → treated as unset');
  assert.equal(isEnabled([]), true);
});

test('isEnabled 不改动注入的 env', () => {
  const env = { KHY_SANDBOX_TOGGLE: 'off', KEEP: 'me' };
  isEnabled(env);
  isEnabled({ ...env });
  assert.deepEqual(env, { KHY_SANDBOX_TOGGLE: 'off', KEEP: 'me' });
});

test('叶子导出的四个函数就是判定表的全部面（无隐藏 IO 面）', () => {
  assert.deepEqual(Object.keys(require('./sandboxToggleState')).sort(), ['isEnabled', 'normalizeSandboxFlag', 'planSandboxAction', 'resolveSandboxState']);
  // Determinism: same injected facts, same result object shape and values.
  const a = resolveSandboxState({ flag: 'auto', platform: 'linux', bwrapAvailable: true });
  const b = resolveSandboxState({ flag: 'auto', platform: 'linux', bwrapAvailable: true });
  assert.deepEqual(a, b);
  assert.notEqual(a, b, 'a fresh object per call, never a shared instance');
});
