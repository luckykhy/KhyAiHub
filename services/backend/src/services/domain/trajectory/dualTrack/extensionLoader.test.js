'use strict';

// Unit-level contract tests for extensionLoader.js (co-located, per [RESEARCH-018] §2.3).
// Two iron laws are proven here: (1) the base runtime always survives — a missing track,
// unreadable manifest, malformed JSON, or a single broken extension records into the result
// and returns/continues instead of throwing; (2) 红线5 sandbox — every module path is resolved
// and must stay inside the user track, or it throws CorePollutionError. All IO is injected
// (fs / requireImpl / pathImpl / logger) so no test touches disk; paths are pure math.

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('path');

const { loadUserTrack, assertWithinUserTrack, USER_TRACK_PROTECTED_NAMES } = require('./extensionLoader');
const { CorePollutionError } = require('./actionRegistry');

const TRACK = P.resolve('user_patch');

// Build a registry stub that records registerOverride calls.
function makeRegistry() {
  const calls = [];
  return {
    calls,
    registerOverride(type, handler, opts) {
      this.calls.push({ type, handler, opts });
      return this;
    },
  };
}

// Minimal in-memory fs for the manifest only.
function makeFs({ exists = true, manifest }) {
  return {
    existsSync: () => exists,
    readFileSync: () => manifest,
  };
}

test('USER_TRACK_PROTECTED_NAMES is the frozen pair the sandbox keys off', () => {
  assert.deepEqual(USER_TRACK_PROTECTED_NAMES, ['user_patch', 'extensions']);
  assert.equal(Object.isFrozen(USER_TRACK_PROTECTED_NAMES), true);
});

// ── assertWithinUserTrack: the sandbox primitive ─────────────────────────────
test('a path inside the track resolves and returns its absolute form', () => {
  const abs = assertWithinUserTrack('overrides/say.js', TRACK);
  assert.equal(abs, P.resolve(TRACK, 'overrides/say.js'));
});

test('a dot-relative path inside the track is allowed', () => {
  assert.doesNotThrow(() => assertWithinUserTrack('./x/y.js', TRACK));
});

test('a `..` escape throws CorePollutionError (红线5)', () => {
  assert.throws(() => assertWithinUserTrack('../evil.js', TRACK), CorePollutionError);
  assert.throws(() => assertWithinUserTrack('sub/../../evil.js', TRACK), CorePollutionError);
});

test('an absolute path outside the track throws', () => {
  const outside = P.resolve(TRACK, '..', 'core', 'index.js');
  assert.throws(() => assertWithinUserTrack(outside, TRACK), CorePollutionError);
});

// ── loadUserTrack: base always survives ──────────────────────────────────────
test('missing userTrackRoot or registry is a skip, not a throw', () => {
  const r1 = loadUserTrack();
  assert.deepEqual(r1, { loaded: [], skipped: [{ name: '<all>', reason: '缺少 userTrackRoot 或 registry' }], errors: [] });
  const r2 = loadUserTrack({ userTrackRoot: TRACK });
  assert.equal(r2.skipped[0].name, '<all>');
});

test('a non-existent track is a clean skip (pure official base is normal)', () => {
  const r = loadUserTrack({ userTrackRoot: TRACK, registry: makeRegistry(), fs: makeFs({ exists: false }) });
  assert.equal(r.skipped[0].name, '<manifest>');
  assert.equal(r.errors.length, 0);
  assert.equal(r.loaded.length, 0);
});

test('manifest read failure records an error and keeps the base alive', () => {
  const boomFs = { existsSync: () => true, readFileSync: () => { throw new Error('EIO'); } };
  const r = loadUserTrack({ userTrackRoot: TRACK, registry: makeRegistry(), fs: boomFs });
  assert.equal(r.errors[0].name, '<manifest>');
  assert.match(r.errors[0].reason, /读取失败: EIO/);
});

test('malformed manifest JSON errors out and warns, base survives', () => {
  const warns = [];
  const r = loadUserTrack({
    userTrackRoot: TRACK,
    registry: makeRegistry(),
    fs: makeFs({ manifest: '{ not valid json' }),
    logger: { warn: (m) => warns.push(m) },
  });
  assert.equal(r.errors[0].name, '<manifest>');
  assert.match(r.errors[0].reason, /manifest.json 解析失败/);
  assert.ok(warns.some((w) => w.includes('[dualTrack:loader]')));
});

test('valid manifest loads overrides + actions, resolving each module inside the track', () => {
  const registry = makeRegistry();
  const sayHandler = () => 'say';
  const speakMod = { handler: () => 'speak' };
  const requireImpl = (abs) => {
    if (abs.endsWith('say.js')) return sayHandler;
    if (abs.endsWith('speak_v2.js')) return speakMod;
    throw new Error('unexpected module ' + abs);
  };
  const manifest = JSON.stringify({
    name: 'my-patch',
    overrides: [{ actionType: 'say', module: './overrides/say.js' }],
    actions: [{ actionType: 'speak_v2', module: './actions/speak_v2.js' }],
  });
  const r = loadUserTrack({ userTrackRoot: TRACK, registry, fs: makeFs({ manifest }), requireImpl });
  assert.equal(r.loaded.length, 2);
  assert.deepEqual(r.loaded.map((x) => x.name).sort(), ['action:speak_v2', 'override:say']);
  assert.equal(r.errors.length, 0);
  assert.equal(registry.calls.length, 2);
  const sayCall = registry.calls.find((c) => c.type === 'say');
  assert.equal(sayCall.handler, sayHandler, 'a bare function module export is used directly');
  assert.equal(sayCall.opts.source, 'user_track:my-patch');
  const speakCall = registry.calls.find((c) => c.type === 'speak_v2');
  assert.equal(typeof speakCall.handler, 'function', '{ handler } export is unwrapped');
  assert.equal(speakCall.handler, speakMod.handler);
});

test('entries missing actionType or module are skipped', () => {
  const registry = makeRegistry();
  const manifest = JSON.stringify({ overrides: [{ actionType: 'say' }, { module: './x.js' }] });
  const r = loadUserTrack({ userTrackRoot: TRACK, registry, fs: makeFs({ manifest }), requireImpl: () => () => {} });
  assert.equal(r.skipped.length, 2);
  assert.ok(r.skipped.every((s) => /缺少 actionType 或 module/.test(s.reason)));
  assert.equal(registry.calls.length, 0);
});

test('a module that exports no handler is skipped', () => {
  const registry = makeRegistry();
  const manifest = JSON.stringify({ actions: [{ actionType: 'a', module: './a.js' }] });
  const r = loadUserTrack({
    userTrackRoot: TRACK,
    registry,
    fs: makeFs({ manifest }),
    requireImpl: () => ({ not: 'a handler' }),
  });
  assert.equal(r.skipped[0].reason, '模块未导出 handler 函数');
});

test('a sandbox-escaping module path is captured as an error, not thrown out (红线5)', () => {
  const registry = makeRegistry();
  const manifest = JSON.stringify({ overrides: [{ actionType: 'say', module: '../core/secret.js' }] });
  const r = loadUserTrack({ userTrackRoot: TRACK, registry, fs: makeFs({ manifest }), requireImpl: () => () => {} });
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].name, 'override:say');
  assert.match(r.errors[0].reason, /路径越出用户扩展轨/);
  assert.equal(registry.calls.length, 0, 'the escaping module must never be registered');
});

test('a requireImpl that throws is isolated: one bad extension does not sink the rest', () => {
  const registry = makeRegistry();
  const manifest = JSON.stringify({
    actions: [
      { actionType: 'good', module: './good.js' },
      { actionType: 'bad', module: './bad.js' },
    ],
  });
  const requireImpl = (abs) => {
    if (abs.endsWith('bad.js')) throw new Error('boom');
    return () => 'ok';
  };
  const r = loadUserTrack({ userTrackRoot: TRACK, registry, fs: makeFs({ manifest }), requireImpl });
  assert.equal(r.loaded.length, 1);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].name, 'action:bad');
});

test('a manifest without a name falls back to "unnamed" in the source tag', () => {
  const registry = makeRegistry();
  const manifest = JSON.stringify({ overrides: [{ actionType: 'say', module: './say.js' }] });
  loadUserTrack({ userTrackRoot: TRACK, registry, fs: makeFs({ manifest }), requireImpl: () => () => {} });
  assert.equal(registry.calls[0].opts.source, 'user_track:unnamed');
});
