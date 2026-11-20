'use strict';

/**
 * androidUiPolicy.test.js — contract of the pure decision leaf: gates, confirm
 * plan, keycode table, target preconditions, four-state verdict.
 *
 * Pure functions, no device and no disk. The gate cases use the real flagRegistry
 * (the parent chain is resolved inside it); everything else injects isEnabled so a
 * decision bug cannot hide behind a registry bug.
 */

const test = require('node:test');
const assert = require('node:assert');

const policy = require('./androidUiPolicy');

const ALLOW = () => true;

function plan(input, options = {}) {
  return policy.planAndroidUiAction(input, Object.assign({ isEnabled: ALLOW }, options));
}

test('ACTIONS matches the tool surface and is frozen', () => {
  assert.deepEqual([...policy.ACTIONS],
    ['snapshot', 'tap', 'longpress', 'swipe', 'back', 'home', 'recents', 'type']);
  assert.equal(Object.isFrozen(policy.ACTIONS), true);
});

test('unknown action answers unknown_action with the valid list', () => {
  const res = plan({ action: 'click' });
  assert.equal(res.success, false);
  assert.equal(res.code, 'unknown_action');
  assert.match(res.error, /snapshot/);
});

test('KHY_ANDROID_UI_DUMP off -> dump_disabled (every action dumps first, so it is the main gate)', () => {
  for (const action of ['snapshot', 'tap', 'back']) {
    const res = policy.planAndroidUiAction(
      { action, ref: 'e1', confirm: true },
      { env: { KHY_ANDROID_UI_DUMP: 'off' }, isEnabled: () => false }
    );
    assert.equal(res.success, false);
    assert.equal(res.code, 'dump_disabled');
    assert.match(res.hint, /KHY_ANDROID_UI_DUMP/);
  }
});

test('KHY_ANDROID_UI_TEXT off -> type answers text_disabled, taps still allowed', () => {
  const isEnabled = (name) => name !== 'KHY_ANDROID_UI_TEXT';
  const typed = policy.planAndroidUiAction(
    { action: 'type', ref: 'e3', text: 'hi', confirm: true }, { isEnabled });
  assert.equal(typed.success, false);
  assert.equal(typed.code, 'text_disabled');
  assert.match(typed.hint, /ui_type/);
  // Plan only, never send: the plan shows how many characters were suppressed.
  assert.equal(typed.plan.action, 'type');
  assert.equal(typed.plan.textChars, 2);

  const tapped = policy.planAndroidUiAction({ action: 'tap', ref: 'e3', confirm: true }, { isEnabled });
  assert.equal(tapped.success, true);
});

test('a write action without confirm returns only a plan, mentioning confirm:true', () => {
  const res = plan({ action: 'tap', ref: 'e3' });
  assert.equal(res.success, false);
  assert.equal(res.requiresConfirm, true);
  assert.equal(res.code, 'requires_confirm');
  assert.equal(res.plan.action, 'tap');
  assert.equal(res.plan.ref, 'e3');
  assert.match(res.message, /元素 e3/);
  assert.match(res.message, /第 1\/1 步/);
  assert.match(res.message, /confirm:true/);
});

test('confirm:true actually releases the action; snapshot needs no confirm', () => {
  assert.equal(plan({ action: 'tap', ref: 'e3', confirm: true }).success, true);
  assert.equal(plan({ action: 'snapshot' }).success, true);
  assert.equal(plan({ action: 'snapshot' }).requiresConfirm, false);
});

test('ref is required and must look like e14: missing or malformed is refused', () => {
  for (const ref of [undefined, '', 'e', 'x9', 'e1; rm -rf /', 'E1']) {
    const res = plan({ action: 'tap', ref, confirm: true });
    assert.equal(res.success, false, `ref=${JSON.stringify(ref)} must be refused`);
    assert.equal(res.code, 'invalid_args');
    assert.match(res.error, /ref/);
  }
});

test('back/home/recents need no ref and carry their keyevent code in the plan', () => {
  for (const [action, code] of [['back', '4'], ['home', '3'], ['recents', '187']]) {
    const res = plan({ action, confirm: true });
    assert.equal(res.success, true, action);
    assert.equal(res.plan.ref, null);
    assert.deepEqual(res.plan.deviceArgs, ['shell', 'input', 'keyevent', code]);
  }
});

test('keycode table: lowercase letters/digits/space map to numeric codes', () => {
  const encoded = policy.encodeTextToKeycodes('abc 123');
  assert.equal(encoded.ok, true);
  assert.deepEqual(encoded.codes, [29, 30, 31, 62, 8, 9, 10]);
  assert.ok(encoded.codes.every((n) => Number.isInteger(n)));
});

test('characters outside the table are refused: backtick, $, quotes, newline, uppercase, CJK', () => {
  for (const bad of ['`', '$', '"', "'", '\n', 'A', '中', 'é']) {
    const encoded = policy.encodeTextToKeycodes(`ab${bad}`);
    assert.equal(encoded.ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.deepEqual(encoded.unsupported, [bad]);
    assert.match(encoded.message, /码表外字符/);
  }
});

test('the type plan carries only numeric codes, no raw characters', () => {
  const res = plan({ action: 'type', ref: 'e3', text: 'ok 42', confirm: true });
  assert.equal(res.success, true);
  assert.deepEqual(res.plan.deviceArgs,
    ['shell', 'input', 'keyevent', '43', '39', '62', '11', '9']);
  for (const arg of res.plan.deviceArgs.slice(3)) {
    assert.match(arg, /^\d+$/);
  }
});

test('buildDeviceArgs type branch: numeric codes only, null when the table refuses', () => {
  assert.deepEqual(policy.buildDeviceArgs({ action: 'type', text: 'abc 123' }),
    ['shell', 'input', 'keyevent', '29', '30', '31', '62', '8', '9', '10']);
  assert.equal(policy.buildDeviceArgs({ action: 'type', text: '中文' }), null);
  assert.equal(policy.buildDeviceArgs({ action: 'type', text: 'A' }), null);
});

test('type refusal paths: empty, too long and unsupported each get their own code', () => {
  assert.equal(plan({ action: 'type', ref: 'e3', text: '', confirm: true }).code, 'invalid_args');
  const long = plan({ action: 'type', ref: 'e3', text: 'a'.repeat(81), confirm: true });
  assert.equal(long.code, 'text_too_long');
  const bad = plan({ action: 'type', ref: 'e3', text: 'Hello 中文', confirm: true });
  assert.equal(bad.code, 'text_not_supported');
  assert.match(bad.hint, /PhoneBridge/);
});

test('swipe needs a direction and its distance is clamped to 100..1500', () => {
  assert.equal(plan({ action: 'swipe', ref: 'e1', confirm: true }).code, 'invalid_args');
  assert.equal(policy.clampDistance(undefined), 300);
  assert.equal(policy.clampDistance(10), 100);
  assert.equal(policy.clampDistance(99999), 1500);
  assert.equal(policy.clampDistance(600), 600);
});

test('buildDeviceArgs derives coordinates from the element center; swipe ends never go negative', () => {
  const element = { ref: 'e1', center: [540, 1200], editable: false };
  assert.deepEqual(policy.buildDeviceArgs({ action: 'tap', element }),
    ['shell', 'input', 'tap', '540', '1200']);
  assert.deepEqual(policy.buildDeviceArgs({ action: 'longpress', element }),
    ['shell', 'input', 'swipe', '540', '1200', '540', '1200', '600']);
  const up = policy.buildDeviceArgs({ action: 'swipe', element, direction: 'up', distance: 300 });
  assert.deepEqual(up, ['shell', 'input', 'swipe', '540', '1200', '540', '900', '300']);
  const far = policy.buildDeviceArgs({ action: 'swipe', element, direction: 'up', distance: 1500 });
  assert.equal(far[6], '0', 'the end y must not be negative (a minus reads as an argv flag)');
  assert.equal(policy.buildDeviceArgs({ action: 'tap', element: { center: null } }), null);
});

test('checkTarget: a ref missing from the frame is stale_ref; type needs an editable target', () => {
  assert.equal(policy.checkTarget('back', null), null, 'system keys need no ref');
  assert.equal(policy.checkTarget('tap', null).code, 'stale_ref');
  const notEditable = policy.checkTarget('type', { ref: 'e3', editable: false });
  assert.equal(notEditable.code, 'target_not_editable');
  assert.equal(policy.checkTarget('type', { ref: 'e3', editable: true }), null);
  assert.equal(policy.checkTarget('tap', { ref: 'e3', editable: false }), null);
});

test('verdictOfEffect four states: changed/gone work, unchanged does not, unknown cannot tell', () => {
  const changed = policy.verdictOfEffect({ conclusion: 'target_changed', changes: ['moved'] }, 'e3');
  assert.equal(changed.effective, true);
  assert.deepEqual(changed.changes, ['moved']);
  assert.match(changed.message, /已生效/);

  assert.equal(policy.verdictOfEffect({ conclusion: 'target_gone' }, 'e3').effective, true);

  const unchanged = policy.verdictOfEffect({ conclusion: 'target_unchanged' }, 'e3');
  assert.equal(unchanged.effective, false);
  assert.match(unchanged.message, /无可见变化/);

  const unknown = policy.verdictOfEffect({ conclusion: 'unknown_target' }, 'e3');
  assert.equal(unknown.effective, null);
  assert.match(unknown.message, /不把没有证据当作未生效/);

  assert.equal(policy.verdictOfEffect(null, 'e3').effective, null);
});

test('verdictOfScreenChange only looks at whole-screen identity (system keys have no ref)', () => {
  assert.equal(policy.verdictOfScreenChange({ is_identical: true }).effective, false);
  assert.equal(policy.verdictOfScreenChange({ is_identical: false }).effective, true);
});
