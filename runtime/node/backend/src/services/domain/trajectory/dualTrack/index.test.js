'use strict';

// Unit-level contract tests for dualTrack/index.js — the DualTrackRuntime facade
// (co-located, per [RESEARCH-018] §2.3). The facade is orchestration only: assemble wires
// the core track → seal → load user track, and dispatch delegates to the degrade state
// machine. Everything it touches is injected (coreActions / fs / requireImpl / pathImpl /
// logger) so no test hits disk or the real user_patch dir. The contracts locked here are the
// real ones from the JSDoc: assemble seals + snapshots the core, dispatch never自主-executes
// on an unknown action, executor errors fall back to MANUAL_CONFIRM (红线3), and 红线5 holds
// after overrides (coreIntact) and refuses unauthorized writes.

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('path');

const facade = require('./index');
const { DualTrackRuntime, STATES, USER_TRACK_PROTECTED_NAMES, parseModelResponse, decideFlow } = facade;
const { CORE_ACTIONS } = require('./core/coreActions');

const TRACK = P.resolve('fake_user_patch');

// A fully-injected runtime: the default `fs`/`requireImpl` are replaced so nothing reads disk.
function makeRuntime(extra = {}) {
  const fs = extra.fs || { existsSync: () => false, readFileSync: () => '', mkdirSync: () => {}, writeFileSync: () => {} };
  return new DualTrackRuntime({
    coreRoot: P.resolve('fake_core'),
    userTrackRoot: TRACK,
    fs,
    requireImpl: extra.requireImpl || (() => { throw new Error('require must not be called'); }),
    pathImpl: P,
    logger: extra.logger,
    coreActions: extra.coreActions,
  });
}

test('module exports the documented surface', () => {
  assert.equal(typeof DualTrackRuntime, 'function');
  assert.equal(STATES.PROCEED, 'PROCEED');
  assert.deepEqual([...USER_TRACK_PROTECTED_NAMES], ['user_patch', 'extensions']);
  assert.equal(typeof parseModelResponse, 'function');
  assert.equal(typeof decideFlow, 'function');
});

test('constructor injects deps and starts unassembled', () => {
  const rt = makeRuntime();
  assert.equal(rt.assembled, false);
  assert.equal(rt.userTrackRoot, TRACK);
  assert.equal(rt.entryPoints.length, 4, 'core entry points are the compatibility contract');
  assert.equal(rt.registry.isSealed(), false);
  assert.equal(rt.coreIntact(), false, 'no core snapshot exists before assemble → intact check fails closed');
});

test('assemble registers the injected core actions, seals, and reports the load', () => {
  const rt = makeRuntime({ coreActions: { say: (a) => ({ echo: a.type }) } });
  const ret = rt.assemble();
  assert.equal(ret, rt, 'assemble returns the runtime for chaining');
  assert.equal(rt.assembled, true);
  assert.equal(rt.registry.isSealed(), true, 'core must be sealed after assemble (红线5)');
  assert.ok(rt.loadReport, 'assemble records a load report');
  assert.equal(rt.loadReport.skipped.some((s) => s.name === '<manifest>'), true, 'fs stub says no track');
  assert.equal(rt.resolveAction({ type: 'say' }).flow.state, STATES.PROCEED);
});

test('assemble with the real CORE_ACTIONS defaults wires say/read_file/noop', () => {
  const rt = makeRuntime();
  rt.assemble();
  assert.deepEqual(rt.registry.coreSnapshot(), ['noop', 'read_file', 'say'].sort());
  assert.equal(rt.coreIntact(), true);
});

test('parse delegates to the lenient parser and carries the injected logger', () => {
  const warns = [];
  const rt = makeRuntime({ logger: { warn: (m) => warns.push(m) } });
  const r = rt.parse('not json at all');
  assert.equal(r.degraded, true);
  assert.equal(r.ok, false);
  assert.equal(r.text, 'not json at all');
  assert.ok(warns.length > 0, 'parse must surface warnings through the injected logger');
});

test('resolveAction maps an unknown type to a MANUAL_CONFIRM flow', () => {
  const rt = makeRuntime({ coreActions: { say: () => ({}) } });
  rt.assemble();
  const { resolution, flow } = rt.resolveAction({ type: 'ghost' });
  assert.equal(resolution.isKnown, false);
  assert.equal(flow.state, STATES.MANUAL_CONFIRM);
  assert.equal(flow.control, 'human');
});

test('dispatch on a known core action auto-executes the handler', () => {
  const rt = makeRuntime({ coreActions: { say: (a) => ({ done: a.type, seen: a.params }) } });
  rt.assemble();
  const res = rt.dispatch({ type: 'say', params: { text: 'hi' } }, { ctx: { x: 1 } });
  assert.equal(res.state, STATES.PROCEED);
  assert.equal(res.control, 'auto');
  assert.equal(res.ok, true);
  assert.deepEqual(res.result, { done: 'say', seen: { text: 'hi' } });
  assert.equal(res.origin, 'core');
});

test('dispatch honours an injected executor over the resolved handler', () => {
  const rt = makeRuntime({ coreActions: { say: () => ({ from: 'core' }) } });
  rt.assemble();
  const res = rt.dispatch({ type: 'say' }, { executor: () => ({ from: 'injected' }) });
  assert.equal(res.result.from, 'injected');
});

test('dispatch on an unknown action hands control back, never auto-executing (红线2/3)', () => {
  const rt = makeRuntime({ coreActions: { say: () => ({}) } });
  rt.assemble();
  const res = rt.dispatch({ type: 'ghost', _raw: { z: 1 } });
  assert.equal(res.state, STATES.MANUAL_CONFIRM);
  assert.equal(res.control, 'human');
  assert.equal(res.ok, false);
  assert.equal(res.placeholder.renderable, true);
  assert.equal(res.message, res.placeholder.message);
});

test('a throwing executor is caught and downgraded to manual confirm, never a crash (红线3)', () => {
  const rt = makeRuntime({ coreActions: { boom: () => { throw new Error('executor blew up'); } } });
  rt.assemble();
  const res = rt.dispatch({ type: 'boom' });
  assert.equal(res.state, STATES.MANUAL_CONFIRM);
  assert.equal(res.control, 'human');
  assert.equal(res.ok, false);
  assert.equal(res.error.message, 'executor blew up');
  assert.equal(res.error.code, 'EXECUTOR_ERROR', 'a non-Error code falls back to the default tag');
  assert.equal(res.placeholder.renderable, true);
});

test('an executor error preserving an Error.code surfaces that code', () => {
  const rt = makeRuntime({
    coreActions: {
      boom: () => {
        const e = new Error('rate limited');
        e.code = '429';
        throw e;
      },
    },
  });
  rt.assemble();
  const res = rt.dispatch({ type: 'boom' });
  assert.equal(res.error.code, '429');
});

test('authorizedModelWrite delegates to the writer and enforces the authorization gate', () => {
  const writes = [];
  const fs = { existsSync: () => true, mkdirSync: () => {}, writeFileSync: (abs, c, enc) => writes.push({ abs, c, enc }) };
  const rt = makeRuntime({ fs });
  assert.throws(
    () => rt.authorizedModelWrite({ relPath: 'actions/a.js', content: 'x', authorized: false }),
    /AUTHORIZATION|授权/,
  );
  assert.equal(writes.length, 0, 'unauthorized must not write');
  const ok = rt.authorizedModelWrite({ relPath: 'actions/a.js', content: 'x', authorized: true });
  assert.equal(ok.written, P.resolve(TRACK, 'actions/a.js'));
  assert.equal(writes.length, 1);
});

test('authorizedModelWrite rejects a sandbox-escaping path (红线5)', () => {
  const fs = { existsSync: () => true, mkdirSync: () => {}, writeFileSync: () => {} };
  const rt = makeRuntime({ fs });
  assert.throws(() => rt.authorizedModelWrite({ relPath: '../evil.js', content: 'x', authorized: true }));
});

test('planUpdate / applyUpdate compose the update-guard contract', () => {
  const writes = [];
  const fs = { mkdirSync: () => {}, writeFileSync: (abs, c) => writes.push([abs, c]) };
  const rt = makeRuntime({ fs });
  const plan = rt.planUpdate([{ path: 'core_file.js', content: 'v' }]);
  assert.equal(plan.safe, true, 'a file inside coreRoot is planned safe');
  const res = rt.applyUpdate(plan);
  assert.equal(res.aborted, false);
  assert.equal(writes.length, 1);

  const unsafe = rt.planUpdate([{ path: P.join('..', 'escape.js') }]);
  assert.equal(unsafe.safe, false);
  assert.equal(rt.applyUpdate(unsafe).aborted, true, 'fail-closed: unsafe plan is not applied');
});

test('checkBreaking flags a core update that drops a user-relied entry point', () => {
  const rt = makeRuntime();
  const res = rt.checkBreaking(['registerOverride']);
  assert.equal(res.breaking, true);
  assert.ok(res.removed.includes('action.params'), 'CORE_ENTRY_POINTS minus the new set is reported');
  const stillGood = rt.checkBreaking([...rt.entryPoints]);
  assert.equal(stillGood.breaking, false);
});

test('coreIntact reports drift when the core track keys change after assemble', () => {
  const rt = makeRuntime({ coreActions: { say: () => ({}) } });
  rt.assemble();
  assert.equal(rt.coreIntact(), true);
  // Reach into the registry the way a real pollution would: change the core key set post-snapshot.
  rt.registry._core.set('smuggled', () => {});
  assert.equal(rt.coreIntact(), false, 'assertCoreIntact throws → coreIntact returns false');
});
