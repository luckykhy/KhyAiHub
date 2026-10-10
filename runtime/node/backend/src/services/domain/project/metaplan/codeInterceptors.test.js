'use strict';

// Unit-level contract tests for codeInterceptors.js (co-located, per [RESEARCH-018] §2.3).
// These are the 锁具 a Code_Hard strategy clamps onto an executor: each returns a
// pass/fail verdict on candidate content so a syntactically broken edit is rejected
// BEFORE it touches disk. Two properties dominate:
//   1. dispatch correctness — which interceptor actually runs for a registry key and a
//      language, because the registry's `validator` field and this switch are two halves
//      of one contract with no compiler between them;
//   2. the fail-safe promise — a validator NEVER throws at the caller, and a missing
//      tooling dependency degrades to {ok:true, skipped:true} ("no worse than today")
//      rather than blocking work.
// Tests are hermetic: the Python path is exercised with KHY_PYTHON_BIN pointed at a
// non-existent binary (so the result is the documented "python unavailable" degrade on
// every machine, not whatever python the developer happens to have), and
// JEST_WORKER_ID is cleared before the first JS validation because _getBabel() caches.

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');

// `_getBabel()` short-circuits to the vm probe when it thinks it is in a jest CJS worker,
// and it caches the decision on first use — so the env must be right before ANY call.
const savedJestWorker = process.env.JEST_WORKER_ID;
delete process.env.JEST_WORKER_ID;
// No test in this file may depend on the developer's python: force the degraded path.
// A bogus KHY_PYTHON_BIN makes spawnSync fail with ENOENT on every machine, which is
// exactly the arm under test. Real python3 (or the Store stub) would not be.
const savedPythonBin = process.env.KHY_PYTHON_BIN;
process.env.KHY_PYTHON_BIN = 'khy_b23_no_such_python_binary';

// Top-level hook: restored after the whole file, not after the first test.
after(() => {
  if (savedJestWorker === undefined) delete process.env.JEST_WORKER_ID;
  else process.env.JEST_WORKER_ID = savedJestWorker;
  if (savedPythonBin === undefined) delete process.env.KHY_PYTHON_BIN;
  else process.env.KHY_PYTHON_BIN = savedPythonBin;
});

const ci = require('./codeInterceptors');

test('the module surface is the four documented validators', () => {
  assert.deepEqual(Object.keys(ci).sort(), [
    'runInterceptor',
    'validateBalance',
    'validateJs',
    'validatePython',
  ]);
});

test('this repo ships @babel/parser, so the JS validator reports the babel arm', () => {
  // Explicit rather than incidental: every 'babel' expectation below only holds while
  // the optional-but-shipped dependency resolves. If it ever stops resolving, this
  // test names the cause instead of 6 tests failing on a validator-key mismatch.
  let parse;
  try {
    ({ parse } = require('@babel/parser'));
  } catch {
    parse = null;
  }
  assert.equal(typeof parse, 'function', '@babel/parser must be resolvable in this repo');
  assert.equal(ci.validateJs('const a = 1;').validator, 'babel');
});

test('validateJs passes well-formed code and rejects broken code with a location', () => {
  const good = ci.validateJs('const a = 1;\nfunction f() { return a; }\n');
  assert.equal(good.ok, true);
  assert.equal(good.validator, 'babel');
  assert.equal(good.error, undefined);

  const bad = ci.validateJs('function (');
  assert.equal(bad.ok, false);
  assert.equal(bad.validator, 'babel');
  assert.equal(typeof bad.error, 'string');
  assert.ok(bad.error.length > 0);
  assert.equal(bad.line, 1);
  // An error line must stay single-line and bounded — it is surfaced verbatim to a model.
  assert.equal(bad.error.includes('\n'), false);
  assert.ok(bad.error.length <= 200, `error not truncated: ${bad.error.length}`);
});

test('validateJs normalizes nullish and non-string code to the empty program', () => {
  for (const junk of [null, undefined, '']) {
    const out = ci.validateJs(junk);
    assert.equal(out.ok, true, `${String(junk)} should read as an empty program`);
    assert.equal(out.validator, 'babel');
  }
  // A number is stringified, not type-crashed — and the stringified form is then parsed
  // for real, so "42" passes as an expression while "[object Object]" is correctly
  // reported as a syntax error rather than being waved through.
  assert.equal(ci.validateJs(42).ok, true);
  assert.equal(ci.validateJs({ a: 1 }).ok, false, '"[object Object]" is not valid JS');
  assert.equal(ci.validateJs({ a: 1 }).validator, 'babel');
});

test('validateJs honours the typescript/jsx plugin switches it is called with', () => {
  const tsOnly = 'const x: number = 1;';
  assert.equal(ci.validateJs(tsOnly, { typescript: true, jsx: false }).ok, true);
  // The same source is a syntax error without the typescript plugin.
  assert.equal(ci.validateJs(tsOnly, { typescript: false, jsx: true }).ok, false);
  const jsxOnly = 'const A = <div className="x" />;';
  assert.equal(ci.validateJs(jsxOnly, { typescript: false, jsx: true }).ok, true);
  assert.equal(ci.validateJs(jsxOnly, { typescript: false, jsx: false }).ok, false);
  // tsx needs both plugins at once — the combination the registry advertises.
  assert.equal(ci.validateJs('const A = <div>{1 as number}</div>;', { typescript: true, jsx: true }).ok, true);
  // Option defaults: the second argument is optional entirely.
  assert.equal(ci.validateJs(jsxOnly).ok, true, 'jsx defaults to on');
});

test('runInterceptor maps the babel registry key onto the language-specific plugin set', () => {
  assert.deepEqual(run('babel', 'const a = 1;', 'javascript'), { ok: true, validator: 'babel' });
  // 'typescript' → typescript plugin, jsx OFF (the source comment is explicit about it).
  assert.equal(run('babel', 'const x: number = 1;', 'typescript').ok, true);
  assert.equal(run('babel', 'const A = <div/>;', 'typescript').ok, false);
  // 'tsx' → both plugins.
  assert.equal(run('babel', 'const A = <div/>;', 'tsx').ok, true);
  // 'jsx' → jsx only, so a type annotation is a syntax error.
  assert.equal(run('babel', 'const x: number = 1;', 'jsx').ok, false);
  // Unknown language strings fall back to the default option set (jsx on, ts off).
  assert.equal(run('babel', 'const x: number = 1;', 'cobol').ok, false);
  // Language is normalized for case and whitespace.
  assert.equal(run('babel', 'const x: number = 1;', ' TypeScript ').ok, true);
});

function run(validatorKey, content, language) {
  return ci.runInterceptor(validatorKey, content, { language });
}

test('vm_or_native uses the built-in vm compile probe for the JS family, with no deps', () => {
  for (const lang of ['javascript', 'typescript', 'jsx', 'tsx', '']) {
    const out = ci.runInterceptor('vm_or_native', 'const a = 1;', { language: lang });
    assert.equal(out.validator, 'vm', `${JSON.stringify(lang)} must take the vm arm`);
    assert.equal(out.ok, true);
  }
  const bad = ci.runInterceptor('vm_or_native', 'function (', { language: 'javascript' });
  assert.equal(bad.ok, false);
  assert.equal(bad.validator, 'vm');
  assert.match(bad.error, /function name|Unexpected|SyntaxError/i);
  assert.equal(bad.error.includes('\n'), false);
});

test('the vm probe only rejects SYNTAX, never a top-level reference', () => {
  // vm.Script compiles without executing, so an unresolved global is not a syntax
  // problem and must not be打回 — otherwise every script touching a global would fail.
  const out = ci.runInterceptor('vm_or_native', 'thisIsNotDefined.atAll();', { language: 'javascript' });
  assert.equal(out.ok, true);
  assert.equal(out.validator, 'vm');
  assert.equal(out.error, undefined);
  // The `note` arm ("vm 非语法错误") only fires if compilation itself throws a non-
  // SyntaxError, which a plain source string cannot do — so the happy path carries no
  // note. Recorded as a defensive branch in the README, not asserted as reachable.
  assert.equal(out.note, undefined);
  // A clean script and a reference-only script are indistinguishable to the probe.
  assert.deepEqual(ci.runInterceptor('vm_or_native', 'const a = 1;', { language: 'javascript' }), {
    ok: true,
    validator: 'vm',
  });
  // Unterminated string / brace: still compile-time syntax errors.
  assert.equal(ci.runInterceptor('vm_or_native', 'let s = "abc', { language: 'javascript' }).ok, false);
  assert.equal(ci.runInterceptor('vm_or_native', 'return 1', { language: 'javascript' }).ok, false);
});

test('python validation degrades to skipped:true rather than blocking when python3 is absent', () => {
  // KHY_PYTHON_BIN is pinned to a non-existent binary at the top of this file, so this
  // asserts the documented "no worse than today" arm on every machine.
  const out = ci.validatePython('def f():\n    return 1\n');
  assert.equal(out.ok, true, 'a missing parser must never block the work');
  assert.equal(out.validator, 'python_ast');
  assert.equal(out.skipped, true);
  assert.match(out.note, /python 不可用|无法启动/);
  assert.equal(out.error, undefined);
  // Reachable through both registry keys that name the python interceptor.
  const viaKey = ci.runInterceptor('python_ast', 'x = 1', {});
  assert.equal(viaKey.skipped, true);
  assert.equal(viaKey.validator, 'python_ast');
  const viaGeneric = ci.runInterceptor('vm_or_native', 'x = 1', { language: 'Python' });
  assert.equal(viaGeneric.validator, 'python_ast', 'the generic executor routes python natively');
  assert.equal(viaGeneric.skipped, true);
});

test('validateBalance is the cross-language last resort and reports which kind of imbalance', () => {
  const fails = [];
  const passing = [
    'let a = [1, { b: 2 }];',
    'fn main() { println(); }',
    'let s = "a\\"b";',
    'let t = `a ${ "b" } c`;',
    "let q = 'it\\'s';",
    '',
    'no brackets at all',
  ];
  for (const src of passing) {
    const out = ci.validateBalance(src);
    if (!out.ok) fails.push(`should balance: ${src} -> ${out.error}`);
    if (out.ok && out.validator !== 'balance') fails.push(`wrong validator for ${src}`);
    if (out.ok && !/结构配平/.test(out.note)) fails.push(`passing balance probe must explain itself: ${src}`);
  }
  const failing = [
    ['fn main() {', '括号不配平：1 个未闭合。'],
    ['}', "括号不配平：意外的 '}'。"],
    [')) ', '括号不配平：意外的 \')\'。'],
    ['let s = "abc', '字符串引号未闭合。'],
    ['let o = {a: 1', '括号不配平：1 个未闭合。'],
  ];
  for (const [src, expected] of failing) {
    const out = ci.validateBalance(src);
    if (out.ok !== false) fails.push(`should fail: ${src}`);
    else if (out.error !== expected) fails.push(`wrong message for ${JSON.stringify(src)}: ${out.error} != ${expected}`);
  }
  assert.deepEqual(fails, [], fails.join('\n'));
});

test('validateBalance never throws, whatever it is handed', () => {
  const throws = [];
  for (const junk of [null, undefined, 0, 42, true, {}, [], [1, 2], () => 1, Symbol('sym')]) {
    try {
      const out = ci.validateBalance(junk);
      if (typeof out.ok !== 'boolean') throws.push(`${String(junk)} produced no boolean verdict`);
    } catch (e) {
      throws.push(`${String(junk)} threw: ${e.message}`);
    }
  }
  assert.deepEqual(throws, [], throws.join('\n'));
});

test('a null validator key is an explicit pass, not an accidental one', () => {
  // This is the raw_string_injector path: "无 AST 校验（裸执行器，风险自担）".
  for (const content of ['function (', 'def :', '{{{']) {
    const out = ci.runInterceptor(null, content, { language: 'javascript' });
    assert.equal(out.ok, true);
    assert.equal(out.validator, 'none');
    assert.match(out.note, /无 AST 校验/);
  }
  assert.equal(ci.runInterceptor(undefined, 'x').validator, 'none');
  assert.equal(ci.runInterceptor('', 'x').validator, 'none');
});

test('an unknown validator key skips rather than blocking or throwing', () => {
  const out = ci.runInterceptor('quantum_parser', 'function (');
  assert.equal(out.ok, true);
  assert.equal(out.validator, 'quantum_parser', 'the unknown key is echoed for the audit trail');
  assert.equal(out.skipped, true);
  assert.match(out.note, /未知校验器 quantum_parser，跳过/);
});

test('runInterceptor is total: no (key, content, ctx) combination throws at the caller', () => {
  const keys = ['babel', 'python_ast', 'vm_or_native', 'none', null, '', 'bogus_key'];
  const contents = ['const a = 1;', 'function (', '', null, undefined, 12, {}, ['x']];
  const ctxs = [{}, undefined, { language: 'javascript' }, { language: null }, { language: 42 }];
  const throws = [];
  for (const key of keys) {
    for (const content of contents) {
      for (const ctx of ctxs) {
        try {
          const out = ci.runInterceptor(key, content, ctx);
          if (!out || typeof out.ok !== 'boolean') throws.push(`${String(key)}/${String(content)} produced no verdict`);
        } catch (e) {
          throws.push(`${String(key)}/${String(content)} threw: ${e.message}`);
        }
      }
    }
  }
  assert.deepEqual(throws, [], `runInterceptor is not total:\n${throws.join('\n')}`);
});

test('every registry validator key is dispatchable here — the two halves cannot drift', () => {
  // executorRegistry is pure data and never runs these; this file is the only place the
  // key names are honoured. Sweep every key the catalog actually advertises.
  const registry = require('./executorRegistry');
  const keys = registry.listExecutors().map((e) => e.validator);
  assert.deepEqual(keys, ['babel', 'python_ast', 'vm_or_native', null]);
  const drift = [];
  for (const key of keys) {
    if (key === null) continue;
    const out = ci.runInterceptor(key, 'x = 1', { language: 'unknown_language' });
    // The default arm answers "未知校验器 <key>，跳过" — reaching it for a key the
    // catalog actually advertises would mean the safety net silently never mounts.
    // A `skipped` from missing tooling (python absent) carries a different note and is
    // fine, so the drift test looks for the unknown-key wording specifically.
    if (/未知校验器/.test(String(out.note || ''))) drift.push(`registry key ${key} is unhandled here`);
  }
  assert.deepEqual(drift, [], drift.join('\n'));
});
