'use strict';

/**
 * index.test.js — contract of the assembly facade: lazy singleton, no confirm
 * passthrough, the three-step loop order, and "a failed re-check is not a
 * failure verdict".
 *
 * runAdb replays three real dumps (c1 -> action -> c2); nothing spawns a process.
 * sleep is injected too: the 20s budget is asserted numerically, never waited.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND = path.join(__dirname, '..', '..', '..', '..', '..', '..');
const KIT = path.join(BACKEND, 'vendor', 'android-agent-kit');
const C1 = fs.readFileSync(path.join(KIT, 'screendiff', 'fixtures', 'c1.xml'), 'utf8');
const C2 = fs.readFileSync(path.join(KIT, 'screendiff', 'fixtures', 'c2.xml'), 'utf8');

const phone = require('../index.js');
const androidRef = require('./index');

const CONFIG = { serial: 'S1', adbTimeoutMs: 15000 };

/**
 * Replay dump/action replies in order. Default script: c1 -> tap ok -> c2.
 */
function makeRef(script, options = {}) {
  const calls = [];
  const sleeps = [];
  const replies = script.slice();
  const ref = androidRef.createAndroidRef(Object.assign({
    env: {},
    config: CONFIG,
    sleep: async (ms) => { sleeps.push(ms); },
    runAdb: async (argv) => {
      calls.push(argv);
      const next = replies.shift();
      if (next instanceof Error) {
        throw next;
      }
      return next || { ok: true, stdout: '', stderr: '', truncated: false };
    },
  }, options));
  return { ref, calls, sleeps };
}

const okDump = (xml) => ({ ok: true, stdout: xml, stderr: '', truncated: false });
const okAction = () => ({ ok: true, stdout: '', stderr: '', truncated: false });

/**
 * A parsed snapshot with one editable element, keyed by the dump marker. Used for
 * the type chain: the vendored dumps contain no editable element.
 */
function editableSnapshot(frame) {
  return {
    snapshot_id: `s-${frame}`,
    package: 'com.test',
    rotation: 0,
    width: 1080,
    height: 2400,
    nodes_total: 2,
    xml_bytes: 120,
    elements: [{
      ref: 'e1',
      role: 'edit',
      label: frame === 'after' ? 'abc 123' : '',
      bounds: [100, 100, 500, 200],
      center: [300, 150],
      clickable: true,
      long_clickable: false,
      scrollable: false,
      editable: true,
      checked: false,
      disabled: false,
      password: false,
    }],
    metrics: () => ({ elements: 1, xml_bytes: 120 }),
    digest: () => `digest-${frame}`,
  };
}

const EDITABLE_UIDREF = {
  parse: (xml) => editableSnapshot(String(xml).trim()),
  digest: (parsed) => `digest-${parsed.snapshot_id}`,
};

test('lazy singleton: getAndroidRef reuses the instance, reset rebuilds it', () => {
  androidRef.resetAndroidRefForTests();
  const a = androidRef.getAndroidRef({});
  const b = androidRef.getAndroidRef({});
  assert.equal(a, b);
  androidRef.resetAndroidRefForTests();
  const c = androidRef.getAndroidRef({});
  assert.notEqual(a, c);
  androidRef.resetAndroidRefForTests();
});

test('the phone facade exports createAdbTransport (the IO entry androidRef uses)', () => {
  assert.equal(typeof phone.createAdbTransport, 'function');
});

test('tap loop: prev dump -> input tap -> re-check dump, verdict from the real screendiff', async () => {
  const { ref, calls, sleeps } = makeRef([okDump(C1), okAction(), okDump(C2)]);

  const res = await ref.run({ action: 'tap', ref: 'e1', confirm: true });

  assert.equal(calls.length, 3);
  // 1) first frame is a dump, with -s supplied by the constructor
  assert.deepEqual(calls[0].slice(0, 2), ['-s', 'S1']);
  assert.ok(calls[0].includes('uiautomator'));
  // 2) coordinates come from uidref centerOf, not from the model
  assert.equal(calls[1].join(' '), '-s S1 shell input tap 540 1236');
  // 3) the re-check is another dump
  assert.ok(calls[2].includes('uiautomator'));

  assert.equal(sleeps[0], 20000, 'the settle budget falls back to 20000ms');
  assert.equal(res.success, true);
  assert.equal(res.executed, true);
  assert.equal(res.effective, true);
  assert.equal(res.verdict, 'target_changed');
  assert.deepEqual(res.changes, ['moved', 'label_changed']);
  assert.match(res.message, /已生效/);
  assert.equal(res.snapshotId, 's30fdb89d3242');
  assert.equal(res.steps.length, 3);
  assert.match(res.steps[0], /^1\/3 抓取当前界面/);
  assert.match(res.steps[1], /^2\/3 发送 shell input tap/);
  assert.match(res.steps[2], /^3\/3 复检完成/);
});

test('type loop: editable target -> numeric keyevents -> re-check reports the change', async () => {
  const { ref, calls, sleeps } = makeRef(
    [okDump('before'), okAction(), okDump('after')],
    { uidref: EDITABLE_UIDREF }
  );

  const res = await ref.run({ action: 'type', ref: 'e1', text: 'abc 123', confirm: true });

  assert.equal(calls.length, 3);
  // The only argv carrying user text is a list of numeric keycodes.
  assert.equal(calls[1].join(' '), '-s S1 shell input keyevent 29 30 31 62 8 9 10');
  assert.doesNotMatch(calls[1].join(' '), /abc/);
  assert.equal(sleeps[0], 20000);
  assert.equal(res.success, true);
  assert.equal(res.executed, true);
  assert.equal(res.effective, true);
  assert.equal(res.verdict, 'target_changed');
  assert.deepEqual(res.changes, ['label_changed']);
});

test('without confirm only a plan comes back: not a single adb call', async () => {
  const { ref, calls, sleeps } = makeRef([okDump(C1), okAction(), okDump(C2)]);
  const res = await ref.run({ action: 'tap', ref: 'e1' });
  assert.equal(res.requiresConfirm, true);
  assert.equal(res.code, 'requires_confirm');
  assert.equal(calls.length, 0);
  assert.equal(sleeps.length, 0);
});

test('KHY_ANDROID_UI_DUMP off gates run() and the exported snapshot() alike', async () => {
  const { ref, calls } = makeRef([okDump(C1), okAction(), okDump(C2)], {
    env: { KHY_ANDROID_UI_DUMP: 'off' },
  });

  const viaRun = await ref.run({ action: 'snapshot' });
  assert.equal(viaRun.success, false);
  assert.equal(viaRun.code, 'dump_disabled');

  // The facade must not expose an ungated screen-read door to future callers.
  const viaSnapshot = await ref.snapshot();
  assert.equal(viaSnapshot.success, false);
  assert.equal(viaSnapshot.code, 'dump_disabled');
  assert.equal(calls.length, 0);
});

test('a ref missing from the current frame is stale_ref; only the first dump is sent', async () => {
  const { ref, calls } = makeRef([okDump(C1), okAction(), okDump(C2)]);
  const res = await ref.run({ action: 'tap', ref: 'e99', confirm: true });
  assert.equal(res.success, false);
  assert.equal(res.code, 'stale_ref');
  assert.match(res.hint, /snapshot/);
  assert.equal(calls.length, 1);
});

test('type against a non-editable target is target_not_editable; no key is sent', async () => {
  const { ref, calls } = makeRef([okDump(C1), okAction(), okDump(C2)]);
  const res = await ref.run({ action: 'type', ref: 'e2', text: 'hi', confirm: true });
  assert.equal(res.success, false);
  assert.equal(res.code, 'target_not_editable');
  assert.equal(calls.length, 1);
});

test('action ran but the re-check dump failed -> executed:true / effective:null, never "no effect"', async () => {
  const { ref } = makeRef([
    okDump(C1),
    okAction(),
    { ok: false, stdout: '', stderr: 'error: device offline', truncated: false },
  ]);
  const res = await ref.run({ action: 'tap', ref: 'e1', confirm: true });
  assert.equal(res.success, true);
  assert.equal(res.executed, true);
  assert.equal(res.effective, null);
  assert.equal(res.code, 'verify_unavailable');
  assert.match(res.message, /不把没有证据当作未生效/);
});

test('adb refusing the action -> success:false / executed:false, no re-check', async () => {
  const { ref, calls, sleeps } = makeRef([
    okDump(C1),
    { ok: false, stdout: '', stderr: 'Error: injection failed', truncated: false },
  ]);
  const res = await ref.run({ action: 'tap', ref: 'e1', confirm: true });
  assert.equal(res.success, false);
  assert.equal(res.executed, false);
  assert.equal(res.code, 'action_failed');
  assert.match(res.error, /injection failed/);
  assert.equal(sleeps.length, 0);
  assert.equal(calls.length, 2);
});

test('back has no ref and is judged by whole-screen change: c1->c2 counts as effective', async () => {
  const { ref, calls } = makeRef([okDump(C1), okAction(), okDump(C2)]);
  const res = await ref.run({ action: 'back', confirm: true });
  assert.equal(calls[1].join(' '), '-s S1 shell input keyevent 4');
  assert.equal(res.success, true);
  assert.equal(res.effective, true);
  assert.equal(res.verdict, 'screen_changed');
});

test('an unchanged screen -> effective:false (the system key was swallowed)', async () => {
  const { ref } = makeRef([okDump(C1), okAction(), okDump(C1)]);
  const res = await ref.run({ action: 'home', confirm: true });
  assert.equal(res.effective, false);
  assert.equal(res.verdict, 'screen_unchanged');
  assert.match(res.message, /无变化/);
});

test('the settle budget comes from the numeric gate: explicit value applies, out of range clamps', async () => {
  const a = makeRef([okDump(C1), okAction(), okDump(C2)], { env: { KHY_ANDROID_UI_VERIFY_MS: '5000' } });
  await a.ref.run({ action: 'tap', ref: 'e1', confirm: true });
  assert.equal(a.sleeps[0], 5000);

  const b = makeRef([okDump(C1), okAction(), okDump(C2)], { env: { KHY_ANDROID_UI_VERIFY_MS: '1' } });
  await b.ref.run({ action: 'tap', ref: 'e1', confirm: true });
  assert.equal(b.sleeps[0], 5000, 'below min clamps to 5000');
});

test('a throwing runAdb becomes action_failed, never escapes', async () => {
  const { ref } = makeRef([okDump(C1), new Error('spawn ENOENT')]);
  const res = await ref.run({ action: 'tap', ref: 'e1', confirm: true });
  assert.equal(res.success, false);
  assert.equal(res.code, 'action_failed');
  assert.match(res.error, /ENOENT/);
});
