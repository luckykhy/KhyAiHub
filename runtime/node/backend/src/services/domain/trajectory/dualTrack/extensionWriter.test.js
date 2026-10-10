'use strict';

// Unit-level contract tests for extensionWriter.js (co-located, per [RESEARCH-018] §2.3).
// The writer enforces two gates in a fixed ORDER before any disk write: authorization first
// (模型 DIY must be explicitly opted-in), then the 红线5 sandbox. Both gates must short-circuit
// so a stub fs that throws on use proves "no write happened". Success path is checked through the
// injected fs seam by recording the exact (dir, abs, content, enc) arguments — the writer's own
// shaping, not a faked result.

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('path');

const { writeUserExtension, AuthorizationRequiredError, CorePollutionError } = require('./extensionWriter');

const TRACK = P.resolve('user_patch');

// A fs stub that records writes and explodes if used before the gates pass.
function makeFs() {
  const writes = [];
  const mkdirs = [];
  return {
    writes,
    mkdirs,
    mkdirSync: (dir, opts) => { mkdirs.push({ dir, opts }); },
    writeFileSync: (abs, content, enc) => { writes.push({ abs, content, enc }); },
  };
}

test('unauthorized (authorized !== true) is rejected before any filesystem touch', () => {
  const fs = makeFs();
  assert.throws(
    () => writeUserExtension({ userTrackRoot: TRACK, relPath: 'a.js', content: 'x', authorized: false, fs }),
    AuthorizationRequiredError,
  );
  assert.equal(fs.writes.length, 0);
  assert.equal(fs.mkdirs.length, 0);
  // The gate is strict !== true, so truthy-but-not-true is also rejected.
  for (const v of [undefined, null, 1, 'yes', {}]) {
    assert.throws(() => writeUserExtension({ userTrackRoot: TRACK, relPath: 'a.js', content: 'x', authorized: v, fs }));
  }
});

test('AuthorizationRequiredError carries name and code', () => {
  try {
    writeUserExtension({ userTrackRoot: TRACK, relPath: 'a.js', content: 'x', authorized: false });
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof AuthorizationRequiredError);
    assert.ok(e instanceof Error);
    assert.equal(e.name, 'AuthorizationRequiredError');
    assert.equal(e.code, 'AUTHORIZATION_REQUIRED');
  }
});

test('missing/invalid inputs are rejected after the auth gate but before writing', () => {
  const fs = makeFs();
  assert.throws(() => writeUserExtension({ authorized: true, relPath: 'a.js', content: 'x', fs }), /缺少 userTrackRoot/);
  assert.throws(() => writeUserExtension({ authorized: true, userTrackRoot: TRACK, content: 'x', fs }), /relPath 必须为非空字符串/);
  assert.throws(() => writeUserExtension({ authorized: true, userTrackRoot: TRACK, relPath: '', content: 'x', fs }), /relPath 必须为非空字符串/);
  assert.throws(() => writeUserExtension({ authorized: true, userTrackRoot: TRACK, relPath: 5, content: 'x', fs }), /relPath 必须为非空字符串/);
  assert.throws(() => writeUserExtension({ authorized: true, userTrackRoot: TRACK, relPath: 'a.js', content: 123, fs }), /content 必须为字符串/);
  assert.equal(fs.writes.length, 0);
});

test('a sandbox-escaping relPath throws CorePollutionError, no write', () => {
  const fs = makeFs();
  assert.throws(
    () => writeUserExtension({ userTrackRoot: TRACK, relPath: '../outside.js', content: 'x', authorized: true, fs }),
    CorePollutionError,
  );
  assert.equal(fs.writes.length, 0);
  assert.equal(fs.mkdirs.length, 0);
});

test('an absolute relPath outside the track is rejected', () => {
  const outside = P.resolve(TRACK, '..', 'core', 'index.js');
  const fs = makeFs();
  assert.throws(
    () => writeUserExtension({ userTrackRoot: TRACK, relPath: outside, content: 'x', authorized: true, fs }),
    CorePollutionError,
  );
  assert.equal(fs.writes.length, 0);
});

test('a valid authorized write goes through the fs seam with the right shape', () => {
  const fs = makeFs();
  const ret = writeUserExtension({
    userTrackRoot: TRACK,
    relPath: 'actions/say.js',
    content: 'module.exports = () => 1;',
    authorized: true,
    fs,
  });
  const expectedAbs = P.resolve(TRACK, 'actions/say.js');
  assert.deepEqual(ret, { written: expectedAbs });
  assert.equal(fs.mkdirs.length, 1);
  assert.equal(fs.mkdirs[0].dir, P.dirname(expectedAbs));
  assert.deepEqual(fs.mkdirs[0].opts, { recursive: true });
  assert.equal(fs.writes.length, 1);
  assert.equal(fs.writes[0].abs, expectedAbs);
  assert.equal(fs.writes[0].content, 'module.exports = () => 1;');
  assert.equal(fs.writes[0].enc, 'utf8');
});

test('empty-string content is allowed (a valid, intentional empty file)', () => {
  const fs = makeFs();
  const ret = writeUserExtension({ userTrackRoot: TRACK, relPath: 'blank.js', content: '', authorized: true, fs });
  assert.equal(ret.written, P.resolve(TRACK, 'blank.js'));
  assert.equal(fs.writes[0].content, '');
});

test('writeUserExtension also re-exports the CorePollutionError it can throw', () => {
  assert.equal(CorePollutionError.name, 'CorePollutionError');
});
