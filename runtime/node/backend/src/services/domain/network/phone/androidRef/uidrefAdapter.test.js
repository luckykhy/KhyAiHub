'use strict';

/**
 * uidrefAdapter.test.js — contract of the dump -> snapshot adapter.
 *
 * Every case injects runAdb: nothing spawns adb. Fixtures are the vendored real
 * device dumps (settings-storage.xml is an 11-element settings screen); the pinned
 * readings below were measured on 2026-11-16 against the vendored uidref.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// androidRef -> phone -> network -> domain -> services -> src -> backend (6 levels)
const BACKEND = path.join(__dirname, '..', '..', '..', '..', '..', '..');
const KIT = path.join(BACKEND, 'vendor', 'android-agent-kit');
const UIDREF_FIXTURES = path.join(KIT, 'uidref', 'fixtures');
const UIDREF_VECTORS = path.join(KIT, 'uidref', 'vectors');

const uidref = require(path.join(KIT, 'uidref', 'js', 'uidref.js'));
const phone = require('../index.js');
const { createUidrefAdapter, findElement, DEFAULT_MAX_OUTPUT_CHARS } = require('./uidrefAdapter');

const SETTINGS_XML = fs.readFileSync(path.join(UIDREF_FIXTURES, 'settings-storage.xml'), 'utf8');

function makeAdapter(handler, options = {}) {
  const calls = [];
  const adapter = createUidrefAdapter(Object.assign({
    config: { serial: '192.168.1.9:5555', adbTimeoutMs: 15000 },
    runAdb: async (argv, runOptions) => {
      calls.push({ argv, runOptions });
      return handler(argv, runOptions);
    },
    uidref,
    buildAdbArgv: phone.buildAdbArgv,
  }, options));
  return { adapter, calls };
}

test('snapshot builds argv through the constructor (-s serial) and pins the real digest', async () => {
  const { adapter, calls } = makeAdapter(() => ({ ok: true, stdout: SETTINGS_XML, stderr: '', truncated: false }));

  const snap = await adapter.snapshot();

  assert.equal(snap.success, true);
  assert.equal(snap.action, 'snapshot');
  // Not a bare argv: -s comes from buildAdbArgv, without it a multi-device host
  // answers "more than one device".
  assert.deepEqual(calls[0].argv,
    ['-s', '192.168.1.9:5555', 'exec-out', 'uiautomator', 'dump', '/dev/tty']);
  // The dump needs the 512KB cap: 64KB would cut real screens (see module header).
  assert.equal(calls[0].runOptions.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS);
  assert.equal(calls[0].runOptions.timeoutMs, 15000);

  assert.equal(snap.snapshotId, 'se3522b5ce4a8');
  assert.equal(snap.package, 'com.android.settings');
  assert.equal(snap.elements.length, 11);
  assert.equal(snap.metrics.elements, 11);
  assert.equal(snap.metrics.xml_bytes, 29361);
  assert.equal(snap.metrics.digest_bytes, 659);
  // Upstream metrics()/digest() closures drop snapshot_id; the adapter restores it.
  assert.equal(snap.metrics.snapshot_id, 'se3522b5ce4a8');
  assert.match(snap.digest.split('\n')[0], /^\[se3522b5ce4a8\] com\.android\.settings /);
  assert.doesNotMatch(snap.digest, /\[undefined\]/);
  assert.equal(snap.truncated, false);
});

test('element refs follow pre-order document order e1..eN (replayed vendored vector XML)', async () => {
  const vector = JSON.parse(fs.readFileSync(path.join(UIDREF_VECTORS, 'determinism-001.json'), 'utf8'));
  const xml = vector.cases[0].in;
  const { adapter } = makeAdapter(() => ({ ok: true, stdout: xml, stderr: '', truncated: false }));

  const snap = await adapter.snapshot();
  assert.equal(snap.success, true);
  const expected = uidref.parse(xml);
  assert.equal(snap.snapshotId, expected.snapshot_id);
  assert.deepEqual(snap.elements.map((e) => e.ref), expected.elements.map((e) => e.ref));
  assert.deepEqual(snap.elements.map((e) => e.ref),
    expected.elements.map((_, i) => `e${i + 1}`));
});

test('dump failure / truncation / empty output each get their own code and a next step', async () => {
  const cases = [
    [{ ok: false, stdout: '', stderr: 'error: device offline', truncated: false }, 'dump_failed'],
    [{ ok: true, stdout: 'x'.repeat(10), stderr: '', truncated: true }, 'dump_truncated'],
    [{ ok: true, stdout: '   \n', stderr: '', truncated: false }, 'dump_empty'],
  ];
  for (const [reply, code] of cases) {
    const { adapter } = makeAdapter(() => reply);
    const snap = await adapter.snapshot();
    assert.equal(snap.success, false, `${code} must fail`);
    assert.equal(snap.code, code);
    assert.ok(snap.error && snap.error.length > 0, `${code} needs an error`);
    assert.ok(snap.hint && snap.hint.length > 0, `${code} needs a next step`);
  }
});

test('a throwing parser becomes dump_unparsable, never a throw', async () => {
  const { adapter } = makeAdapter(
    () => ({ ok: true, stdout: 'not-xml-at-all', stderr: '', truncated: false }),
    { uidref: { parse: () => { throw new Error('bad xml'); }, digest: () => '' } }
  );
  const snap = await adapter.snapshot();
  assert.equal(snap.success, false);
  assert.equal(snap.code, 'dump_unparsable');
  assert.match(snap.error, /bad xml/);
});

test('a throwing digest/metrics becomes digest_failed, never a throw', async () => {
  // Shape change in uidref (or a hand-rolled stub) must not escape snapshot().
  const { adapter } = makeAdapter(
    () => ({ ok: true, stdout: '<hierarchy/>', stderr: '', truncated: false }),
    { uidref: { parse: () => ({ snapshot_id: 's1', metrics: () => { throw new Error('no metrics'); } }), digest: () => '' } }
  );
  const snap = await adapter.snapshot();
  assert.equal(snap.success, false);
  assert.equal(snap.code, 'digest_failed');
  assert.match(snap.error, /no metrics/);
  assert.equal(snap.snapshotId, 's1');
  assert.ok(snap.hint);
});

test('a throwing transport is also flattened into a structured failure', async () => {
  const { adapter } = makeAdapter(() => { throw new Error('spawn ENOENT'); });
  const snap = await adapter.snapshot();
  assert.equal(snap.success, false);
  assert.equal(snap.code, 'dump_failed');
  assert.match(snap.error, /ENOENT/);
});

test('an unassembled adapter answers adapter_misconfigured instead of throwing', async () => {
  const adapter = createUidrefAdapter({ config: {}, uidref });
  const snap = await adapter.snapshot();
  assert.equal(snap.success, false);
  assert.equal(snap.code, 'adapter_misconfigured');
  assert.match(snap.error, /runAdb/);
});

test('the dump target is overridable from env (device path is not hardcoded at the call site)', async () => {
  const { adapter, calls } = makeAdapter(
    () => ({ ok: true, stdout: SETTINGS_XML, stderr: '', truncated: false }),
    { env: { KHY_ANDROID_UI_DUMP_PATH: '/sdcard/ui-dump.xml' } }
  );
  await adapter.snapshot();
  assert.equal(calls[0].argv[calls[0].argv.length - 1], '/sdcard/ui-dump.xml');
});

test('findElement only resolves refs from the current frame; unknown refs are null', async () => {
  const { adapter } = makeAdapter(() => ({ ok: true, stdout: SETTINGS_XML, stderr: '', truncated: false }));
  const snap = await adapter.snapshot();
  const hit = findElement(snap, 'e1');
  assert.ok(hit);
  assert.equal(hit.ref, 'e1');
  assert.equal(findElement(snap, 'e999'), null);
  assert.equal(findElement(null, 'e1'), null);
});
