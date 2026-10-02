'use strict';
// Co-located unit test for ./contractChecker.js — batch B31 (D2 functional-unit conformance).
// The checker reads/writes only within an fs.mkdtempSync directory for file
// assertions, and httpStatus is exercised ONLY through its non-socket skip branches
// (invalid URL / unsupported protocol). requestStatus is imported at module load
// (contractChecker.js:30) with NO injection seam, so a live HTTP request cannot be
// driven from a hermetic test — that limitation is registered as a defect rather
// than hacked around. No sockets, no child processes, no timers.
// Pure node:test; async tests await already-resolved stubs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-wf-'));

const cc = require('./contractChecker.js');

// ── surface ───────────────────────────────────────────────────────────────────

test('exported surface is exactly the documented 3 keys', () => {
  assert.deepEqual(Object.keys(cc).sort(), ['checkContract', 'extractWindowTitles', 'interpolateVars']);
});

// ── interpolateVars ────────────────────────────────────────────────────────────

test('interpolateVars substitutes vars, JSON-encodes objects, keeps raw text on undefined', () => {
  assert.equal(cc.interpolateVars('hi {{name}}', { name: 'bob' }), 'hi bob');
  assert.equal(cc.interpolateVars('{{o}}', { o: { a: 1 } }), '{"a":1}');
  assert.equal(cc.interpolateVars(null, {}), '');
  // lenient by design: an undefined var keeps the ORIGINAL {{...}} text (unlike
  // workflowExecutor.interpolate which blanks it).
  assert.equal(cc.interpolateVars('{{nope}}!', {}), '{{nope}}!');
});

test('interpolateVars rejects prototype-chain pollution keys (keeps raw text)', () => {
  // _getPath returns undefined for __proto__/prototype/constructor, so the raw
  // placeholder survives instead of leaking inherited properties.
  assert.equal(cc.interpolateVars('{{__proto__.polluted}}', {}), '{{__proto__.polluted}}');
  assert.equal(cc.interpolateVars('{{constructor.escape}}', {}), '{{constructor.escape}}');
});

// ── extractWindowTitles ────────────────────────────────────────────────────────

test('extractWindowTitles parses Windows JSON and mac/linux raw lines', () => {
  assert.deepEqual(cc.extractWindowTitles(null), []);
  assert.deepEqual(cc.extractWindowTitles({ stdout: '   ' }), []);
  // single object
  assert.deepEqual(cc.extractWindowTitles({ stdout: JSON.stringify({ MainWindowTitle: 'Doc' }) }), ['Doc']);
  // array of objects with fallback field names
  const arr = [{ MainWindowTitle: 'A' }, { title: 'B' }, { name: 'C' }, { other: 1 }];
  assert.deepEqual(cc.extractWindowTitles({ stdout: JSON.stringify(arr) }), ['A', 'B', 'C']);
  // plain text lines (JSON parse fails -> raw non-empty lines)
  assert.deepEqual(cc.extractWindowTitles({ stdout: 'Line1\n\nLine2' }), ['Line1', 'Line2']);
});

// ── checkContract: overall shape ─────────────────────────────────────────────

test('checkContract: non-array / empty assertions pass vacuously', async () => {
  assert.deepEqual(await cc.checkContract([], {}), { passed: true, results: [] });
  assert.deepEqual(await cc.checkContract('nope', {}), { passed: true, results: [] });
  assert.deepEqual(await cc.checkContract(undefined, {}), { passed: true, results: [] });
});

test('checkContract: overall passed = every NON-skipped assertion passed', async () => {
  const ctx = { vars: { r: 'hello world' } };
  const res = await cc.checkContract(
    [
      { type: 'varContains', var: 'r', text: 'hello' }, // passed
      { type: 'windowTitle', pattern: 'whatever' }, // skipped (no executeTool)
    ],
    ctx
  );
  assert.equal(res.passed, true);
  assert.equal(res.results[0].passed, true);
  assert.equal(res.results[1].skipped, true);
});

test('checkContract: one failing assertion flips the whole contract', async () => {
  const res = await cc.checkContract([{ type: 'varContains', var: 'missing', text: 'x' }], { vars: {} });
  assert.equal(res.passed, false);
  assert.equal(res.results[0].passed, false);
  assert.match(res.results[0].reason, /变量未定义/);
});

test('checkContract never throws even when an assertion blows up mid-check', async () => {
  const evil = {
    get type() {
      throw new Error('explodes on read');
    },
  };
  const res = await cc.checkContract([evil], {});
  assert.equal(res.passed, false);
  assert.match(res.results[0].reason, /校验执行异常/);
});

// ── varContains ────────────────────────────────────────────────────────────────

test('varContains stringifies object vars and interpolates the needle', async () => {
  const res = await cc.checkContract(
    [
      { type: 'varContains', var: 'obj', text: '{{needle}}' },
      { type: 'varContains', var: 'obj', text: 'zzz' },
    ],
    { vars: { obj: { a: 'hello', b: 2 }, needle: 'hello' } }
  );
  assert.equal(res.results[0].passed, true); // JSON of obj contains 'hello'
  assert.equal(res.results[1].passed, false); // '未包含'
});

// ── fileExists / fileContains (confined to the throwaway temp dir) ──────────────

test('fileExists + fileContains read only inside the temp dir', async () => {
  const file = path.join(TMP_HOME, 'contract-target.txt');
  fs.writeFileSync(file, 'alpha bravo charlie', 'utf8');
  const res = await cc.checkContract(
    [
      { type: 'fileExists', path: file },
      { type: 'fileExists', path: path.join(TMP_HOME, 'ghost.txt') },
      { type: 'fileExists', path: '' },
      { type: 'fileContains', path: file, text: 'bravo' },
      { type: 'fileContains', path: file, text: 'nope' },
      { type: 'fileContains', path: path.join(TMP_HOME, 'ghost.txt'), text: 'x' },
    ],
    {}
  );
  const byIndex = res.results;
  assert.equal(byIndex[0].passed, true);
  assert.equal(byIndex[1].passed, false);
  assert.equal(byIndex[2].passed, false);
  assert.match(byIndex[2].reason, /空路径/);
  assert.equal(byIndex[3].passed, true);
  assert.equal(byIndex[4].passed, false);
  assert.match(byIndex[5].reason, /文件不存在/);
});

// ── windowTitle (fully mocked via ctx.executeTool; never hits a desktop) ───────

test('windowTitle: skips when executeTool is not injected', async () => {
  const res = await cc.checkContract([{ type: 'windowTitle', pattern: 'X' }], { vars: {} });
  assert.equal(res.results[0].skipped, true);
  assert.match(res.results[0].reason, /executeTool 未注入/);
});

test('windowTitle: skips when the desktop tool reports unavailable', async () => {
  const ctx = { vars: {}, executeTool: async () => ({ success: false, error: 'denied' }) };
  const res = await cc.checkContract([{ type: 'windowTitle', pattern: 'X' }], ctx);
  assert.equal(res.results[0].skipped, true);
  assert.match(res.results[0].reason, /不可用/);
});

test('windowTitle: hit / miss / invalid-regex / over-long-pattern outcomes', async () => {
  const titles = JSON.stringify([{ MainWindowTitle: 'Report Q3' }]);
  const ctx = { vars: {}, executeTool: async () => ({ success: true, stdout: titles }) };
  const res = await cc.checkContract(
    [
      { type: 'windowTitle', pattern: 'Report' }, // hit
      { type: 'windowTitle', pattern: 'zzz-no-match' }, // miss
      { type: 'windowTitle', pattern: '(' }, // invalid regex -> skip
      { type: 'windowTitle', pattern: 'a'.repeat(300) }, // over-long -> skip
    ],
    ctx
  );
  assert.equal(res.results[0].passed, true);
  assert.equal(res.results[1].passed, false);
  assert.match(res.results[1].reason, /未命中/);
  assert.equal(res.results[2].skipped, true);
  assert.match(res.results[2].reason, /正则语法错误/);
  assert.equal(res.results[3].skipped, true);
  assert.match(res.results[3].reason, /模式过长/);
});

// ── httpStatus: ONLY the non-socket skip branches (no request seam exists) ─────

test('httpStatus: skips invalid URLs and non-http protocols without opening a socket', async () => {
  const res = await cc.checkContract(
    [
      { type: 'httpStatus', url: 'not a valid url' }, // new URL throws -> skip
      { type: 'httpStatus', url: 'file:///etc/passwd' }, // unsupported protocol -> skip
      { type: 'httpStatus', url: 'ftp://example.com' }, // unsupported protocol -> skip
    ],
    {}
  );
  for (const r of res.results) {
    assert.equal(r.skipped, true);
    assert.equal(r.passed, true);
  }
  assert.match(res.results[0].reason, /URL 非法/);
  assert.match(res.results[1].reason, /协议 file: 不受支持/);
});

test('B31-W4 (static): httpStatus expect:null coerces to 0, not the default 200', () => {
  // contractChecker.js:238 `Number.isFinite(Number(a.expect)) ? Number(a.expect) : 200`.
  // Number(null) === 0 is finite, so an authored expect:null silently targets status
  // 0 (never matched) instead of falling back to the documented default 200 — same
  // Number-coercion family as retryPrimitives retries:null and healGuard maxDepth:null.
  // NOTE: this coercion is NOT runtime-observable in a hermetic test because
  // requestStatus is imported directly (line 30) with no injection seam; driving a
  // real status check would open a socket. Registered as a defect from the code path.
  const expectCoerce = (v) => (Number.isFinite(Number(v)) ? Number(v) : 200);
  assert.equal(expectCoerce(null), 0);
  assert.equal(expectCoerce(undefined), 200);
  assert.equal(expectCoerce('abc'), 200);
});

// ── unknown assertion type ───────────────────────────────────────────────────

test('unknown assertion type fails closed', async () => {
  const res = await cc.checkContract([{ type: 'teleport', x: 1 }], {});
  assert.equal(res.passed, false);
  assert.equal(res.results[0].type, 'teleport');
  assert.match(res.results[0].reason, /不支持的类型/);
});
