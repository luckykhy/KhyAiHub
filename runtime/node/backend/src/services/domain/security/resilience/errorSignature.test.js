'use strict';

// Unit-level contract tests for errorSignature.js (co-located, per [RESEARCH-018] §2.3).
// This file is the shared footing under deadLoopDetector (fingerprints) and the salvage
// protocol (reason codes), so what matters here is: determinism, key-order independence,
// the collision/distinctness table, and the exact precedence ladder of classifyFailure
// (missing-dep > HTTP status > timeout > network > permission > not-found > explicit passthrough).

const test = require('node:test');
const assert = require('node:assert/strict');

const errorSignature = require('./errorSignature');
const { callSignature, classifyFailure, stableStringify } = errorSignature;

test('module face', () => {
  assert.deepEqual(Object.keys(errorSignature).sort(),
    ['callSignature', 'classifyFailure', 'stableStringify']);
});

// ── stableStringify ──────────────────────────────────────────────────

test('stableStringify is key-order independent and sorted', () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  assert.equal(stableStringify({ a: 1, b: 2 }), '{"a":1,"b":2}');
  assert.equal(stableStringify({ b: { z: 1, a: 2 }, a: [1, { b: 2, a: 1 }] }),
    '{"a":[1,{"a":1,"b":2}],"b":{"a":2,"z":1}}');
});

test('stableStringify scalar and edge encodings', () => {
  assert.equal(stableStringify(null), 'null');
  assert.equal(stableStringify(undefined), 'null');
  assert.equal(stableStringify(0), '0');
  assert.equal(stableStringify(false), 'false');
  assert.equal(stableStringify('x'), '"x"');
  assert.equal(stableStringify(() => 1), '"[fn]"', 'functions collapse, never leak identity');
  assert.equal(stableStringify([]), '[]');
  assert.equal(stableStringify([1, 'a', null]), '[1,"a",null]');
  assert.equal(stableStringify({ a: undefined }), '{"a":null}',
    'undefined value survives as null — {a:undefined} equals {a:null} in fingerprints');
});

test('stableStringify ignores Symbol keys (EXEC_APPROVED-style pollution stays out)', () => {
  const withSym = { a: 1 };
  withSym[Symbol.for('EXEC_APPROVED')] = true;
  assert.equal(stableStringify(withSym), '{"a":1}');
});

// ── callSignature ────────────────────────────────────────────────────

test('callSignature: shape is `<trimmed-lowercase tool>#<base36 fingerprint>`', () => {
  const sig = callSignature('WebFetch', { url: 'https://example.com' });
  assert.match(sig, /^webfetch#[0-9a-z]+$/);
});

test('callSignature: tool name casing/surrounding space does not split fingerprints', () => {
  const p = { url: 'x' };
  assert.equal(callSignature(' WebFetch ', p), callSignature('webfetch', p));
});

test('callSignature: determinism and the distinctness table', () => {
  const a = callSignature('t', { url: 'x', k: 1 });
  const b = callSignature('t', { k: 1, url: 'x' }); // key order irrelevant
  assert.equal(a, b, 'same logical params object across calls → same signature');
  const table = [
    ['t', { url: 'x' }],
    ['t', { url: 'y' }],       // param value differs
    ['t', {}],                 // empty params
    ['T', { url: 'x' }],       // same tool, same params → COLLIDES with row 1 (by design)
    ['u', { url: 'x' }],       // different tool
    ['t', { url: ['x'] }],     // same shape as row 1 but array-typed
  ];
  const sigs = table.map(([tool, params]) => callSignature(tool, params));
  assert.equal(sigs[0], sigs[3], 'row 3 is a tool-case variant of row 0 → must collide by design');
  for (const i of [1, 2, 5]) {
    assert.notEqual(sigs[0], sigs[i], `row ${i} must be distinct from row 0`);
  }
  assert.notEqual(sigs[1], sigs[2]);
  assert.notEqual(sigs[1], sigs[5]);
  // Distinctness within the "same tool" family:
  assert.equal(new Set([sigs[0], sigs[1], sigs[2], sigs[5]]).size, 4);
});

test('callSignature: null/undefined params collapse to the empty-params fingerprint', () => {
  assert.equal(callSignature('t', null), callSignature('t', {}));
  assert.equal(callSignature('t', undefined), callSignature('t', {}));
  assert.equal(callSignature('t'), callSignature('t', {}));
});

test('callSignature: circular params do not throw — falls back to String(params) body', () => {
  const c = { a: 1 };
  c.self = c;
  const sig = callSignature('t', c);
  assert.match(sig, /^t#[0-9a-z]+$/);
  assert.equal(callSignature('t', c), sig, 'fallback fingerprint is stable across calls');
});

test('callSignature: empty tool name still produces a legal signature', () => {
  assert.match(callSignature('', { a: 1 }), /^#[0-9a-z]+$/);
  assert.match(callSignature(null, { a: 1 }), /^#[0-9a-z]+$/, 'String(null||\'\') is empty');
});

// ── classifyFailure ──────────────────────────────────────────────────

test('classifyFailure(null) is the shaped default, never a throw', () => {
  assert.deepEqual(classifyFailure(null), {
    code: 'EXECUTION_ERROR',
    reason: 'execution-error',
    retryable: false,
    missingDependency: null,
    message: '(no detail)',
  });
  assert.deepEqual(classifyFailure(undefined).code, 'EXECUTION_ERROR');
  assert.deepEqual(classifyFailure('').message, '(no detail)');
});

test('classifyFailure: missing-dependency ladder and dependency extraction', () => {
  const d1 = classifyFailure('puppeteer is not installed');
  assert.equal(d1.code, 'MISSING_DEPENDENCY');
  assert.equal(d1.reason, 'missing-dependency');
  assert.equal(d1.missingDependency, null, 'phrase matched, name not extractable');

  const d2 = classifyFailure('run: install ffmpeg to continue');
  assert.equal(d2.code, 'MISSING_DEPENDENCY');
  assert.equal(d2.missingDependency, 'ffmpeg', '"install <dep>" names the dependency');

  const d3 = classifyFailure({ error: 'please npm install chromium now' });
  assert.equal(d3.missingDependency, 'chromium');

  const d4 = classifyFailure({ code: 'MISSING_DEPENDENCY', missingDependency: 'torch' });
  assert.equal(d4.code, 'MISSING_DEPENDENCY');
  assert.equal(d4.missingDependency, 'torch', 'explicit field wins when phrase has no name');

  const d5 = classifyFailure('use pip3 install whisper for audio');
  assert.equal(d5.code, 'MISSING_DEPENDENCY');
  assert.equal(d5.missingDependency, 'whisper');
  assert.equal(d5.retryable, false, 'missing-dep is NOT retry material');
});

test('classifyFailure: HTTP status from structured fields and from text', () => {
  const s1 = classifyFailure({ status: 403 });
  assert.equal(s1.code, 'HTTP_403');
  assert.equal(s1.reason, 'http-403');

  const s2 = classifyFailure({ statusCode: 503 });
  assert.equal(s2.code, 'HTTP_503');

  const s3 = classifyFailure('GET failed: 429 Too Many Requests');
  assert.equal(s3.code, 'HTTP_429');

  const s4 = classifyFailure({ error: { message: 'upstream said 500 once', status: 500 } });
  assert.equal(s4.code, 'HTTP_500', 'nested error.status is read');

  const s5 = classifyFailure('port 8080 or room 1500 refused');
  assert.equal(s5.code, 'EXECUTION_ERROR',
    'only 3-digit 4xx/5xx tokens classify as HTTP — 8080/1500 must not');
});

test('classifyFailure: transient classes are the only retryable ones', () => {
  const t = classifyFailure({ code: 'TIMEOUT' });
  assert.deepEqual([t.code, t.reason, t.retryable], ['TIMEOUT', 'timeout', true]);
  assert.equal(classifyFailure('request timed out').code, 'TIMEOUT');
  assert.equal(classifyFailure('connect ETIMEDOUT 1.2.3.4').code, 'TIMEOUT');
  assert.equal(classifyFailure('ESOCKETTIMEDOUT').code, 'TIMEOUT');

  const n = classifyFailure('fetch failed: ECONNREFUSED 127.0.0.1');
  assert.deepEqual([n.code, n.reason, n.retryable], ['NETWORK_ERROR', 'network', true]);
  assert.equal(classifyFailure('getaddrinfo ENOTFOUND x.invalid').code, 'NETWORK_ERROR');
  assert.equal(classifyFailure('EAI_AGAIN lookup failed on dns').code, 'NETWORK_ERROR');
});

test('classifyFailure: permission and not-found classes', () => {
  assert.equal(classifyFailure('Permission denied, mkdir /x').code, 'PERMISSION_DENIED');
  assert.equal(classifyFailure('EACCES: operation not permitted').code, 'PERMISSION_DENIED');
  assert.equal(classifyFailure('HTTP flavor: Forbidden').code, 'PERMISSION_DENIED');
  assert.equal(classifyFailure('401 unauthorized').code, 'HTTP_401',
    'a bare 4xx token beats the unauthorized phrase — status has higher precedence');
  assert.equal(classifyFailure('ENOENT: no such file or directory').code, 'RESOURCE_NOT_FOUND');
  assert.equal(classifyFailure('resource not found').reason, 'not-found');
});

test('classifyFailure: precedence — missing-dependency beats an HTTP status in the same text', () => {
  const p = classifyFailure('install torch failed with 503');
  assert.equal(p.code, 'MISSING_DEPENDENCY', 'branch order in source: dep first, http second');
  assert.equal(p.missingDependency, 'torch');
});

test('classifyFailure: precedence — HTTP status beats an explicit TIMEOUT code', () => {
  const p = classifyFailure({ code: 'TIMEOUT', status: 404 });
  assert.equal(p.code, 'HTTP_404', 'http branch sits above timeout in the ladder');
});

test('classifyFailure: unknown explicit codes pass through, reason is kebab-lowercased', () => {
  const p = classifyFailure({ code: 'MY_CUSTOM_TOOL_CODE', error: 'bleh' });
  assert.equal(p.code, 'MY_CUSTOM_TOOL_CODE');
  assert.equal(p.reason, 'my-custom-tool-code');
  assert.equal(p.retryable, false);
  assert.equal(p.message, 'bleh');
});

test('classifyFailure: text extraction order over object shapes', () => {
  assert.equal(classifyFailure({ error: { message: 'm', code: 'c' } }).message, 'm');
  assert.equal(classifyFailure({ error: { code: 'c' } }).message, 'c',
    'error object without message falls to error.code (both text and explicit code)');
  assert.equal(classifyFailure({ message: 'plain msg' }).message, 'plain msg');
  assert.equal(classifyFailure({ note: 'note msg' }).message, 'note msg');
  assert.equal(classifyFailure(42).message, '(no detail)', 'non-object non-string input is inert');
  const err = new Error('socket hang up');
  const e = classifyFailure(err);
  assert.equal(e.message, 'socket hang up');
  assert.equal(e.code, 'EXECUTION_ERROR');
});

test('classifyFailure never throws on hostile inputs (it must not become a new fault source)', () => {
  for (const junk of [0, '', [], { error: [] }, { status: 'ZZ9' }, { error: { status: {} } }]) {
    const r = classifyFailure(junk);
    assert.equal(typeof r.code, 'string');
    assert.equal(typeof r.reason, 'string');
    assert.equal(typeof r.retryable, 'boolean');
  }
});
