'use strict';

/**
 * gelabActionMap.test.js — co-located suite for the action→device-step table.
 *
 * IO: none. The two things most likely to rot here are the coordinate
 * arithmetic (a rounding or clamping error clicks the wrong thing, silently)
 * and the tool names (a name typed here but absent from the catalog fails on a
 * real device, minutes into a run). Both are pinned.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const map = require('./gelabActionMap');
const grammar = require('./gelabActionGrammar');
const catalog = require('../phoneBridgeCatalog');

const GEO = Object.freeze({ width: 1200, height: 2670 });

function act(text) {
  const r = grammar.str2action(text);
  assert.equal(r.ok, true, `fixture failed to parse: ${r.code} ${r.error}`);
  return r.action;
}

function plan(text, ctx = {}) {
  return map.translateAction(act(text), Object.assign({ geometry: GEO, backend: 'bridge' }, ctx));
}

test('converts 0-1000 to pixels with round on 1200x2670', () => {
  // 500/1000 * 1200 = 600 exactly; 250/1000 * 2670 = 667.5 -> 668.
  assert.equal(map.toPixel(500, 1200), 600);
  assert.equal(map.toPixel(250, 2670), 668);
  assert.equal(map.toPixel(0, 1200), 0);
  assert.equal(map.toPixel(999, 1200), 1199);
});

test('clamps v=1000 to width-1 not width', () => {
  // Clamping to `size` would land one pixel outside the screen, and the
  // gesture dispatcher drops that without an error.
  assert.equal(map.toPixel(1000, 1200), 1199);
  assert.equal(map.toPixel(1000, 2670), 2669);
});

test('clamps v=1001 and v=-1 back into the screen', () => {
  assert.equal(map.toPixel(1001, 1200), 1199);
  assert.equal(map.toPixel(-1, 1200), 0);
  assert.equal(map.toPixel(-9999, 2670), 0);
  assert.equal(map.toPixel(99999, 2670), 2669);
});

test('honours a rotated geometry 2670x1200 for the same normalized point', () => {
  // The model's 0-1000 space is resolution independent, so the same point maps
  // to different pixels after a rotation — and that is correct.
  assert.equal(map.toPixel(500, 2670), 1335);
  assert.equal(map.toPixel(500, 1200), 600);
});

test('refuses with no_geometry when geometry is null', () => {
  const p = plan('action: CLICK\nexplain: x\npoint: 500,500', { geometry: null });
  assert.equal(p.ok, false);
  assert.equal(p.code, 'no_geometry');
  assert.match(p.observation, /屏幕几何/);
  assert.equal(p.steps.length, 0);
});

test('observation names the clamp so the model can see it', () => {
  const p = plan('action: CLICK\nexplain: x\npoint: 1000,1000');
  assert.equal(p.ok, true);
  assert.deepEqual(p.steps[0].args, { x: 1199, y: 2669 });
  assert.match(p.observation, /已夹到/);
  // An in-range coordinate must NOT claim a clamp happened.
  const q = plan('action: CLICK\nexplain: x\npoint: 500,500');
  assert.doesNotMatch(q.observation, /已夹到/);
});

test('CLICK maps to ui_tap with pixel coordinates', () => {
  const p = plan('action: CLICK\nexplain: tap\npoint: 500,500');
  assert.equal(p.ok, true);
  assert.equal(p.access, 'actuate');
  assert.equal(p.steps.length, 1);
  assert.equal(p.steps[0].tool, 'ui_tap');
  assert.equal(p.steps[0].backend, 'bridge');
  assert.deepEqual(p.steps[0].args, { x: 600, y: 1335 });
});

test('SLIDE maps to ui_swipe and reports that midpoints are lost', () => {
  const p = plan('action: SLIDE\nexplain: scroll\npoint1: 500,800\npoint2: 500,200');
  assert.equal(p.steps[0].tool, 'ui_swipe');
  assert.deepEqual(p.steps[0].args, { x1: 600, y1: 2136, x2: 600, y2: 534, ms: 300 });
  assert.match(p.observation, /中间轨迹/);
});

test('LONGPRESS maps to ui_longpress with a duration inside the ceiling', () => {
  const p = plan('action: LONGPRESS\nexplain: hold\npoint: 100,100');
  assert.equal(p.steps[0].tool, 'ui_longpress');
  assert.equal(p.steps[0].args.ms, 700);
  // A model asking for longer than the ceiling is clamped AND told so, rather
  // than silently shortened.
  const q = plan('action: LONGPRESS\nexplain: hold\npoint: 100,100', { limits: { longpressMaxMs: 1500 } });
  assert.equal(q.steps[0].args.ms, 700);
});

test('rejects a degenerate SLIDE whose clamped endpoints coincide', () => {
  // Not "the system treats a zero-length path as a hold" — the bridge's own
  // longpress is built on exactly that. The reason is the silent mismatch: the
  // model believes it swiped, the device registers a press.
  const p = plan('action: SLIDE\nexplain: x\npoint1: 500,500\npoint2: 500,500');
  assert.equal(p.ok, false);
  assert.equal(p.code, 'degenerate_slide');
  assert.match(p.observation, /长按/);
  // Same outcome when two different normalized points collapse to one pixel.
  const q = plan('action: SLIDE\nexplain: x\npoint1: 1000,1000\npoint2: 1000,1000');
  assert.equal(q.code, 'degenerate_slide');
});

test('TYPE passes text through verbatim with no space to underscore mapping', () => {
  const p = plan('action: TYPE\nexplain: x\nvalue: hello world 你好');
  const typeStep = p.steps.find((s) => s.tool === 'ui_type');
  assert.ok(typeStep, 'expected a ui_type step');
  assert.equal(typeStep.args.text, 'hello world 你好');
});

test('TYPE emits a focus tap then a type step', () => {
  const p = plan('action: TYPE\nexplain: x\nvalue: hi\npoint: 500,900');
  assert.equal(p.steps.length, 2);
  assert.equal(p.steps[0].tool, 'ui_tap');
  assert.equal(p.steps[1].tool, 'ui_type');
  assert.equal(p.steps[1].verify, 'type');
});

test('TYPE prefers a live dump input box over the model guess', () => {
  const p = plan('action: TYPE\nexplain: x\nvalue: hi\npoint: 500,900', {
    lastInputBox: { x: 1031, y: 1360 },
  });
  assert.deepEqual(p.steps[0].args, { x: 1031, y: 1360 });
  assert.equal(p.steps[0].tool, 'ui_tap');
});

test('BACK and HOME map to the global actions', () => {
  assert.equal(plan('action: BACK\nexplain: x').steps[0].tool, 'ui_back');
  assert.equal(plan('action: HOME\nexplain: x').steps[0].tool, 'ui_home');
});

test('WAIT value is seconds, matching the shipped parser documentation', () => {
  // parser_0920_summary — the generation mcp_server_config.yaml actually
  // selects — documents value as 「等待时间（秒）」. An earlier revision used a
  // ">100 means milliseconds" heuristic with no basis in the shipped grammar.
  assert.equal(map.parseWaitMs(3), 3000);
  assert.equal(map.parseWaitMs(1), 1000);
  assert.equal(map.parseWaitMs(0.5), 500);
  assert.equal(map.parseWaitMs(30), 30000);
  // Garbage still degrades to one second rather than NaN.
  assert.equal(map.parseWaitMs(0), 1000);
  assert.equal(map.parseWaitMs(-5), 1000);
  assert.equal(map.parseWaitMs('abc'), 1000);
  const p = plan('action: WAIT\nexplain: let it load\nvalue: 3');
  assert.equal(p.control, 'wait');
  assert.equal(p.waitMs, 3000);
  assert.equal(p.steps.length, 0);
});

test('AWAKE resolves by exact label then unique substring then fails with candidates', () => {
  const apps = [
    { package: 'com.tencent.mm', label: '微信' },
    { package: 'com.stepos.ailauncher', label: '阶跃AI' },
    { package: 'com.android.settings', label: '设置' },
  ];
  const exact = plan('action: AWAKE\nexplain: x\nvalue: 微信', { apps });
  assert.equal(exact.steps[0].tool, 'start_app');
  assert.deepEqual(exact.steps[0].args, { package: 'com.tencent.mm' });

  const sub = plan('action: AWAKE\nexplain: x\nvalue: 跃', { apps });
  assert.deepEqual(sub.steps[0].args, { package: 'com.stepos.ailauncher' });

  const miss = plan('action: AWAKE\nexplain: x\nvalue: Photoshop', { apps });
  assert.equal(miss.ok, false);
  assert.equal(miss.code, 'app_unresolved');
  // The candidate list is the point: the model can retry with a real name
  // instead of guessing again.
  assert.match(miss.observation, /微信/);
  assert.match(miss.observation, /设置/);
});

test('AWAKE resolves a Chinese label 微信 to com.tencent.mm', () => {
  const p = plan('action: AWAKE\nexplain: x\nvalue: 微信', {
    apps: [{ package: 'com.tencent.mm', label: '微信' }],
  });
  assert.deepEqual(p.steps[0].args, { package: 'com.tencent.mm' });
  assert.match(p.observation, /微信/);
});

test('INFO and CALL_USER emit zero device steps and set the control', () => {
  const info = plan('action: INFO\nexplain: x\nvalue: what is on screen?');
  assert.equal(info.control, 'info');
  assert.equal(info.question, 'what is on screen?');
  assert.equal(info.steps.length, 0);

  const call = plan('action: CALL_USER\nexplain: x\nvalue: please pay\ntag: confirm_action');
  assert.equal(call.control, 'call_user');
  assert.equal(call.tag, 'confirm_action');
  assert.equal(call.steps.length, 0);
});

test('COMPLETE and ABORT emit zero device steps and carry their report', () => {
  const done = plan('action: COMPLETE\nexplain: x\nreturn: all done');
  assert.equal(done.control, 'complete');
  assert.equal(done.report, 'all done');
  assert.equal(done.steps.length, 0);

  const abort = plan('action: ABORT\nexplain: stuck on a login wall');
  assert.equal(abort.control, 'abort');
  assert.equal(abort.report, 'stuck on a login wall');
  assert.equal(abort.steps.length, 0);
});

test('every bridge tool name in the table resolves via the bridge catalog', () => {
  // The catalog drift alarm. A name typed here but not registered upstream
  // fails on a real device, mid-run, with a confusing error. This turns that
  // into a red test. adb-backend steps carry argv rather than a tool name and
  // are checked separately below.
  const seen = new Set();
  const samples = [
    'action: CLICK\nexplain: x\npoint: 500,500',
    'action: LONGPRESS\nexplain: x\npoint: 500,500',
    'action: SLIDE\nexplain: x\npoint1: 1,2\npoint2: 3,4',
    'action: TYPE\nexplain: x\nvalue: hi\npoint: 500,500',
    'action: BACK\nexplain: x',
    'action: HOME\nexplain: x',
    'action: AWAKE\nexplain: x\nvalue: 微信',
  ];
  for (const text of samples) {
    for (const backend of ['bridge', 'adb']) {
      const p = plan(text, { backend, apps: [{ package: 'com.tencent.mm', label: '微信' }] });
      for (const s of p.steps) {
        if (s.backend !== 'bridge') {
          continue;
        }
        seen.add(s.tool);
        const known = catalog.findPhoneBridgeTool(s.tool) !== null
          || catalog.isPhoneBridgeUiToolName(s.tool);
        assert.ok(known, `${s.tool} 不在 phoneBridgeCatalog 里——翻译表与目录漂移了`);
      }
    }
  }
  // Sanity: the sweep actually reached the tools, so a vacuous pass is impossible.
  assert.ok(seen.has('ui_tap'));
  assert.ok(seen.has('ui_type'));
  assert.ok(seen.has('start_app'));
  assert.ok(seen.has('ui_swipe'));
  assert.ok(seen.has('ui_longpress'));
  assert.ok(seen.has('ui_back'));
  assert.ok(seen.has('ui_home'));
});

test('adb backend steps carry flat argv and a shell tool, never a bridge name', () => {
  const p = plan('action: CLICK\nexplain: x\npoint: 500,500', { backend: 'adb' });
  assert.equal(p.steps[0].backend, 'adb');
  assert.equal(p.steps[0].tool, 'shell');
  assert.deepEqual(p.steps[0].args.argv, ['input', 'tap', '600', '1335']);
  // A bridge name leaking into the adb backend would be dispatched as argv and
  // fail obscurely.
  assert.notEqual(p.steps[0].tool, 'ui_tap');
});

test('translateAction never throws on garbage', () => {
  for (const bad of [null, undefined, 42, {}, { action: 42 }, { action: 'NOPE' }]) {
    const p = map.translateAction(bad, { geometry: GEO, backend: 'bridge' });
    assert.equal(p.ok, false, JSON.stringify(bad));
    assert.ok(typeof p.observation === 'string' && p.observation.length > 0);
  }
  // And a missing ctx is not an excuse to throw either.
  assert.equal(map.translateAction({ action: 'CLICK', point: [1, 2] }).code, 'no_geometry');
});
