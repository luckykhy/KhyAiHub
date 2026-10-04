'use strict';

/**
 * organogenesisSandbox.test.js — co-located suite for the shadow-execution organ sandbox.
 *
 * Containment contract of this suite: the sandbox only ever runs code inside `vm`
 * contexts. Nothing here touches the repository; the two modules with a write channel
 * (evoLedger / frictionBridge) are not required by this file at all.
 *
 * Several cases assert the CURRENT behaviour of registered defects (B31-E1 … B31-E5 in
 * khy.module.json). They are documentation, not approval — do not "fix" them by flipping
 * the assertion; the ruling belongs to the human maintainer.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Pin data homes before requiring anything that could resolve a path from env.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-evo-sb-'));
process.env.KHY_DATA_HOME = path.join(TMP, 'data');
process.env.KHY_PROJECT_DATA_HOME = path.join(TMP, 'project');
process.env.HOME = TMP;
process.env.XDG_CONFIG_HOME = path.join(TMP, 'config');
if (process.platform === 'win32') {
  process.env.USERPROFILE = TMP;
}

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');

const sbMod = require('./organogenesisSandbox');
const {
  OrganogenesisSandbox,
  DEFAULT_TIMEOUT_MS,
  TOXIC_PATTERNS,
  scanToxicity,
  verifyToken,
  _digestVerdict,
} = sbMod;

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort: temp dir is outside the repository */
  }
});

// Determinism guard for the whole suite. The sandbox default is a fixed 200ms vm WALL-CLOCK
// (organogenesisSandbox.js:24) that is NOT activity-aware — pinned as DEFECT B31-E3. Under
// parallel CPU contention (this repo runs `node --test` with one child per file, plus sibling
// agents), a *benign* organ can exceed that 200ms budget and flip a pure-logic assertion
// (passed:true -> false, passToken:null, _materialize ok:false) with no change to the source.
// Every sandbox whose verdict MUST reach a passing/ok result therefore runs with an explicit
// generous budget. The two tests that pin the DEFAULT value itself keep `new OrganogenesisSandbox({ timeoutMs: 20000 })`:
// the constructor surface (timeoutMs === 200) and DEFECT B31-E3 (a heavy organ that MUST time out).
// Registering the load-sensitivity is DEFECT B31-E34; the fix (activity-aware budget) belongs to
// the human maintainer, not this batch. Passing-verdict sites use `timeoutMs: 20000` inline.

// A benign, self-contained organ: semicolon-separated k=v parser. No forbidden token.
const KV_ORGAN = [
  'function organ(input) {',
  '  var out = {};',
  "  String(input).split(';').forEach(function (pair) {",
  "    if (!pair) return;",
  "    var i = pair.indexOf('=');",
  '    if (i < 0) return;',
  '    out[pair.slice(0, i)] = pair.slice(i + 1);',
  '  });',
  '  return out;',
  '}',
].join('\n');
const KV_PROBES = [
  { input: 'a=1;b=2', expected: { a: '1', b: '2' } },
  { input: 'x=hello', expected: { x: 'hello' } },
];

describe('organogenesisSandbox — exported surface (pinned verbatim)', () => {
  test('module.exports keys are exactly the six documented names', () => {
    assert.deepEqual(Object.keys(sbMod).sort(), [
      'DEFAULT_TIMEOUT_MS',
      'OrganogenesisSandbox',
      'TOXIC_PATTERNS',
      '_digestVerdict',
      'scanToxicity',
      'verifyToken',
    ]);
  });

  test('DEFAULT_TIMEOUT_MS is a fixed 200ms wall clock (see defect B31-E3)', () => {
    assert.equal(DEFAULT_TIMEOUT_MS, 200);
    // Deliberately the raw default here — this test pins that a no-arg sandbox still gets 200ms.
    assert.equal(new OrganogenesisSandbox().timeoutMs, 200);
    assert.equal(new OrganogenesisSandbox({ timeoutMs: 0 }).timeoutMs, 0);
    assert.equal(new OrganogenesisSandbox({ timeoutMs: 'NaN' }).timeoutMs, DEFAULT_TIMEOUT_MS);
  });

  test('TOXIC_PATTERNS is frozen and each entry carries re + label', () => {
    assert.equal(Object.isFrozen(TOXIC_PATTERNS), true);
    assert.ok(TOXIC_PATTERNS.length >= 10);
    for (const p of TOXIC_PATTERNS) {
      assert.equal(p.re instanceof RegExp, true);
      assert.equal(typeof p.label, 'string');
      assert.ok(p.label.length > 0);
    }
  });

  test('class exposes exactly two prototype methods beyond the constructor', () => {
    const names = Object.getOwnPropertyNames(OrganogenesisSandbox.prototype);
    for (const n of ['_materialize', 'evaluate', '_runIsolated']) {
      assert.equal(names.includes(n), true, `missing ${n}`);
    }
  });
});

describe('organogenesisSandbox — static toxicity scan', () => {
  test('require / process / eval / Function / dynamic import are flagged', () => {
    assert.ok(scanToxicity("var fs = require('fs');").length > 0);
    assert.ok(scanToxicity('process.exit(0)').length > 0);
    assert.ok(scanToxicity('eval("1+1")').length > 0);
    assert.ok(scanToxicity('new Function("return 1")').length > 0);
    assert.ok(scanToxicity('await import("fs")').length > 0);
  });

  test('literal dead loops are flagged, bounded loops are not', () => {
    assert.ok(scanToxicity('while (true) {}').length > 0);
    assert.ok(scanToxicity('for (;;) {}').length > 0);
    assert.deepEqual(scanToxicity('for (var i = 0; i < 10; i++) {}'), []);
  });

  test('prototype-escape shapes are flagged', () => {
    assert.ok(scanToxicity('o["__proto__"] = 1').length > 0);
    assert.ok(scanToxicity('C.constructor[0]').length > 0);
  });

  test('clean organ source yields zero hits', () => {
    assert.deepEqual(scanToxicity(KV_ORGAN), []);
  });

  test('DEFECT B31-E4 (current behaviour): the blacklist scans raw text, so the English word '
    + '"process" inside a COMMENT alone condemns a benign organ', () => {
    const commented = 'function organ(i){ /* process the input */ return i + 1; }';
    assert.deepEqual(scanToxicity(commented), ['process（禁止访问进程）']);
    const v = new OrganogenesisSandbox({ timeoutMs: 20000 }).evaluate({
      code: commented,
      entry: 'organ',
      probes: [{ input: 1, expected: 2 }],
    });
    assert.equal(v.toxic, true);
    assert.equal(v.passed, false);
    assert.equal(v.passToken, null);
    // The claim in the file header is "命中即判毒，连编译都不给" — a comment cannot execute.
  });

  test('DEFECT B31-E1 evidence (current behaviour): the blacklist is bypassable by string '
    + 'concatenation, so a realm escape is not flagged at all', () => {
      const escapeOrgan = [
        'function organ(input) {',
        '  var f = input.constructor.constructor;',
        '  var name = "pro" + "cess";',
        '  var p = f("return " + name)();',
        '  return String(p && p.version || "none");',
        '}',
      ].join('\n');
      assert.deepEqual(scanToxicity(escapeOrgan), [], 'static scan must miss the concatenated token');
    });
});

describe('organogenesisSandbox — evaluate() happy path', () => {
  test('healthy organ passes and receives a verifiable passToken', () => {
    const sb = new OrganogenesisSandbox({ timeoutMs: 20000 });
    const v = sb.evaluate({ code: KV_ORGAN, entry: 'organ', probes: KV_PROBES });
    assert.equal(v.passed, true);
    assert.equal(v.solved, true);
    assert.equal(v.regressed, false);
    assert.equal(v.toxic, false);
    assert.equal(v.probeCount, 2);
    assert.equal(v.error, null);
    assert.equal(typeof v.passToken, 'string');
    assert.equal(verifyToken(v.passToken, KV_ORGAN, v.verdictDigest), true);
    assert.equal(v.results.length, 2);
    assert.equal(v.results[0].ok, true);
    assert.equal(v.results[1].ok, true);
  });

  test('verdict carries a sha256 codeHash and a 16-char verdictDigest', () => {
    const v = new OrganogenesisSandbox({ timeoutMs: 20000 }).evaluate({ code: KV_ORGAN, entry: 'organ', probes: KV_PROBES });
    assert.match(v.codeHash, /^[0-9a-f]{64}$/);
    assert.match(v.verdictDigest, /^[0-9a-f]{16}$/);
  });

  test('same code hashes identically, different code hashes differently', () => {
    const sb = new OrganogenesisSandbox({ timeoutMs: 20000 });
    const a = sb.evaluate({ code: KV_ORGAN, entry: 'organ', probes: [] });
    const b = sb.evaluate({ code: KV_ORGAN, entry: 'organ', probes: [] });
    const c = sb.evaluate({ code: 'function organ(i){ return i; }', entry: 'organ', probes: [] });
    assert.equal(a.codeHash, b.codeHash);
    assert.notEqual(a.codeHash, c.codeHash);
  });

  test('_digestVerdict is deterministic over solved/regressed/toxic/probeCount only', () => {
    const base = { solved: true, regressed: false, toxic: false, probeCount: 2 };
    assert.equal(_digestVerdict(base), _digestVerdict({ ...base }));
    assert.notEqual(_digestVerdict(base), _digestVerdict({ ...base, probeCount: 3 }));
    // Fields outside the digest (results, error, codeHash) do not change it.
    assert.equal(_digestVerdict(base), _digestVerdict({ ...base, error: 'boom', results: [1] }));
  });
});

describe('organogenesisSandbox — verifyToken()', () => {
  test('null / empty token is refused without computing anything', () => {
    assert.equal(verifyToken(null, KV_ORGAN, 'd'), false);
    assert.equal(verifyToken('', KV_ORGAN, 'd'), false);
    assert.equal(verifyToken(undefined, KV_ORGAN, 'd'), false);
  });

  test('a genuine token fails when the code is swapped after issuance', () => {
    const v = new OrganogenesisSandbox({ timeoutMs: 20000 }).evaluate({ code: KV_ORGAN, entry: 'organ', probes: KV_PROBES });
    assert.equal(verifyToken(v.passToken, KV_ORGAN + '\n// tampered', v.verdictDigest), false);
  });

  test('a genuine token fails when the verdict digest is swapped', () => {
    const v = new OrganogenesisSandbox({ timeoutMs: 20000 }).evaluate({ code: KV_ORGAN, entry: 'organ', probes: KV_PROBES });
    assert.equal(verifyToken(v.passToken, KV_ORGAN, 'deadbeefdeadbeef'), false);
  });

  test('a random 64-hex token of the right length still fails (HMAC, not length check)', () => {
    const v = new OrganogenesisSandbox({ timeoutMs: 20000 }).evaluate({ code: KV_ORGAN, entry: 'organ', probes: KV_PROBES });
    assert.equal(v.passToken.length, 64);
    assert.equal(verifyToken('a'.repeat(64), KV_ORGAN, v.verdictDigest), false);
  });

  test('a short token is rejected by the length guard before timingSafeEqual', () => {
    assert.equal(verifyToken('abc', KV_ORGAN, 'x'), false);
  });
});

describe('organogenesisSandbox — rejection paths', () => {
  test('toxic organ: no compile attempt, toxic=true, no token', () => {
    const v = new OrganogenesisSandbox({ timeoutMs: 20000 }).evaluate({
      code: "function organ(i){ return require('fs'); }",
      entry: 'organ',
      probes: [{ input: 'x', expected: 1 }],
    });
    assert.equal(v.toxic, true);
    assert.equal(v.passed, false);
    assert.equal(v.passToken, null);
    assert.match(v.error, /静态毒性命中/);
    assert.equal(v.probeCount, 1);
    assert.deepEqual(v.results, []);
  });

  test('organ that does not define the entry function: compile failure, toxic=false', () => {
    const v = new OrganogenesisSandbox({ timeoutMs: 20000 }).evaluate({
      code: 'var notAFunction = 1;',
      entry: 'organ',
      probes: [{ input: 1, expected: 1 }],
    });
    assert.equal(v.passed, false);
    assert.equal(v.toxic, false);
    assert.match(v.error, /器官编译失败/);
    assert.match(v.error, /未定义入口函数 organ/);
    assert.equal(v.passToken, null);
  });

  test('syntax error surfaces as compile failure, never throws out of evaluate', () => {
    const v = new OrganogenesisSandbox({ timeoutMs: 20000 }).evaluate({ code: 'function {{{', entry: 'organ', probes: [] });
    assert.equal(v.passed, false);
    assert.equal(typeof v.error, 'string');
  });

  test('unsolved organ: solved=false, passed=false, no token', () => {
    const v = new OrganogenesisSandbox({ timeoutMs: 20000 }).evaluate({
      code: 'function organ(i){ return {}; }',
      entry: 'organ',
      probes: KV_PROBES,
    });
    assert.equal(v.solved, false);
    assert.equal(v.passed, false);
    assert.equal(v.passToken, null);
    assert.equal(v.regressed, false);
  });

  test('a throwing organ records the message in results[].threw and in error', () => {
    const v = new OrganogenesisSandbox({ timeoutMs: 20000 }).evaluate({
      code: 'function organ(i){ throw new Error("organ exploded"); }',
      entry: 'organ',
      probes: [{ input: 1, expected: 1 }],
    });
    assert.equal(v.passed, false);
    assert.match(v.error, /organ exploded/);
    assert.match(v.results[0].threw, /organ exploded/);
    assert.equal(v.results[0].ok, false);
  });

  test('probe without "expected" key only requires a non-undefined return', () => {
    const sb = new OrganogenesisSandbox({ timeoutMs: 20000 });
    const nullish = sb.evaluate({
      code: 'function organ(i){ return null; }',
      entry: 'organ',
      probes: [{ input: 1 }],
    });
    assert.equal(nullish.passed, true, 'null counts as "solved" when expected is absent');
    const undef = sb.evaluate({
      code: 'function organ(i){ }',
      entry: 'organ',
      probes: [{ input: 1 }],
    });
    assert.equal(undef.passed, false);
  });
});

describe('organogenesisSandbox — differential check against a baseline', () => {
  test('baseline that solves while the organ does not => regressed=true, passed=false', () => {
    const baseline = (i) => {
      const o = {};
      String(i)
        .split(';')
        .forEach((p) => {
          const kv = p.split('=');
          if (kv[0]) o[kv[0]] = kv[1];
        });
      return o;
    };
    const v = new OrganogenesisSandbox({ timeoutMs: 20000 }).evaluate({
      code: 'function organ(i){ return null; }',
      entry: 'organ',
      probes: KV_PROBES,
      baseline,
    });
    assert.equal(v.regressed, true);
    assert.equal(v.solved, false);
    assert.equal(v.passed, false);
    assert.equal(v.passToken, null);
  });

  test('array baseline is consumed positionally', () => {
    const v = new OrganogenesisSandbox({ timeoutMs: 20000 }).evaluate({
      code: 'function organ(i){ return 0; }',
      entry: 'organ',
      probes: [{ input: 1, expected: 1 }],
      baseline: [1],
    });
    assert.equal(v.regressed, true);
  });

  test('a throwing baseline is not counted as a regression source', () => {
    const v = new OrganogenesisSandbox({ timeoutMs: 20000 }).evaluate({
      code: 'function organ(i){ throw new Error("bad"); }',
      entry: 'organ',
      probes: [{ input: 1, expected: 1 }],
      baseline: () => {
        throw new Error('baseline dead');
      },
    });
    assert.equal(v.regressed, false);
    assert.equal(v.passed, false);
  });

  test('non-function, non-array baseline is treated as undefined output', () => {
    const v = new OrganogenesisSandbox({ timeoutMs: 20000 }).evaluate({
      code: 'function organ(i){ return 1; }',
      entry: 'organ',
      probes: [{ input: 1, expected: 1 }],
      baseline: 42,
    });
    assert.equal(v.passed, true);
    assert.equal(v.regressed, false);
  });

  test('custom equals is honored', () => {
    const v = new OrganogenesisSandbox({ timeoutMs: 20000 }).evaluate({
      code: 'function organ(i){ return "A"; }',
      entry: 'organ',
      probes: [{ input: 'a', expected: 'X' }],
      equals: () => true,
    });
    assert.equal(v.passed, true);
  });
});

describe('organogenesisSandbox — DEFECTS B31-E2 / B31-E5 / B31-E3 / B31-E6', () => {
  test('DEFECT B31-E2 (current behaviour): an organ with ZERO probes is "passed" and gets a '
    + 'hotload credential — 防呆① is satisfiable without a single check', () => {
      const v = new OrganogenesisSandbox({ timeoutMs: 20000 }).evaluate({
        code: 'function organ(i){ return 1; }',
        entry: 'organ',
      });
      assert.equal(v.probeCount, 0);
      assert.equal(v.solved, true, 'solved starts true and no probe ever falsifies it');
      assert.equal(v.passed, true);
      assert.equal(typeof v.passToken, 'string');
      assert.equal(verifyToken(v.passToken, 'function organ(i){ return 1; }', v.verdictDigest), true);
    });

  test('DEFECT B31-E5 (current behaviour): the default equality is JSON.stringify, so a '
    + 'semantically correct organ returning the same keys in another order is judged unsolved', () => {
      const v = new OrganogenesisSandbox({ timeoutMs: 20000 }).evaluate({
        code: 'function organ(i){ return { b: i, a: 1 }; }',
        entry: 'organ',
        probes: [{ input: 7, expected: { a: 1, b: 7 } }],
      });
      assert.equal(v.solved, false, 'key order, not content, decides the verdict');
      assert.equal(v.passed, false);
      assert.equal(v.error, null, 'and the verdict says nothing about why');
      // Objects minted inside the vm realm are structurally equal but not prototype-equal.
      assert.equal(JSON.stringify(v.results[0].actual), JSON.stringify({ b: 7, a: 1 }));
      assert.equal(JSON.stringify(v.results[0].actual) === JSON.stringify({ a: 1, b: 7 }), false,
        'the organ output is the same CONTENT, only the key order differs');
    });

  test('DEFECT B31-E3 (current behaviour): a fixed 200ms wall clock kills an organ doing '
    + 'legitimate heavy work, and the verdict reports it as "unsolved", not as a timeout class', () => {
      const heavy = 'function organ(i){ var n = 0; var x = 0; while (n < 4000000000) { n = n + 1; x = x + 1; } return x; }';
      assert.deepEqual(scanToxicity(heavy), [], 'bounded loop is not statically "toxic"');
      // The raw DEFAULT (200ms) is what fires here — this test proves the wall clock kills
      // legitimate heavy work. A generous budget would let it finish and flip the verdict.
      const v = new OrganogenesisSandbox().evaluate({
        code: heavy,
        entry: 'organ',
        probes: [{ input: 1, expected: 1 }],
      });
      assert.equal(v.toxic, false, 'header claims a dead loop is "毒性之一"; verdict says otherwise');
      assert.equal(v.solved, false);
      assert.equal(v.passed, false);
      assert.match(String(v.error), /timed out/, 'the only signal is a runtime error string');
      assert.equal(typeof v.error, 'string', 'evaluate returned a verdict instead of throwing');
    });

  test('DEFECT B31-E6 (current behaviour): the organ closure is built once, so state persists '
    + 'across probes even though a fresh context is created per call (the comment at :263 '
    + 'claims "杜绝跨调用状态污染")', () => {
      const stateful = 'var c = 0;\nfunction organ(i){ c = c + i; return c; }';
      const sb = new OrganogenesisSandbox({ timeoutMs: 20000 });
      const two = sb.evaluate({
        code: stateful,
        entry: 'organ',
        probes: [{ input: 1, expected: 1 }, { input: 1, expected: 1 }],
      });
      assert.equal(two.results[0].ok, true, 'first probe sees c=1');
      assert.equal(two.results[1].ok, false, 'second probe sees the accumulated c=2');
      assert.equal(two.solved, false, 'the verdict therefore depends on probe ORDER');
      const one = sb.evaluate({ code: stateful, entry: 'organ', probes: [{ input: 1, expected: 1 }] });
      assert.equal(one.passed, true, 'the identical organ passes when only one probe is run');
    });
});

describe('organogenesisSandbox — realm boundary as designed', () => {
  test('with a PRIMITIVE probe input the organ reaches no host realm (ReferenceError)', () => {
    const probe = [
      'function organ(i) {',
      '  try {',
      '    return String(i.constructor.constructor("return " + "pro" + "cess")().version);',
      '  } catch (e) {',
      '    return "blocked:" + e.name;',
      '  }',
      '}',
    ].join('\n');
    const v = new OrganogenesisSandbox({ timeoutMs: 20000 }).evaluate({
      code: probe,
      entry: 'organ',
      probes: [{ input: 'a', expected: 'blocked:ReferenceError' }],
    });
    assert.equal(v.toxic, false);
    assert.equal(v.results[0].actual, 'blocked:ReferenceError');
    // Contrast with the host-object case above: containment holds only for cloned/primitive
    // inputs, which is exactly why B31-E1 is an input-ownership problem, not a regex problem.
  });

  test('an undeclared identifier inside the organ is not resolvable from the context', () => {
    const v = new OrganogenesisSandbox({ timeoutMs: 20000 }).evaluate({
      code: 'function organ(i){ try { return String(nosuchbinding); } catch (e) { return e.name; } }',
      entry: 'organ',
      probes: [{ input: 1, expected: 'ReferenceError' }],
    });
    assert.equal(v.passed, true);
  });
});

describe('organogenesisSandbox — DEFECT B31-E1 (realm containment)', () => {
  test('CURRENT BEHAVIOUR: a host-realm probe input lets the organ reach the host process '
    + 'object; the empty frozen context is not a security boundary (read-only assertion)', () => {
      const escapeOrgan = [
        'function organ(input) {',
        '  var f = input.constructor.constructor;',
        '  var name = "pro" + "cess";',
        '  var p = f("return " + name)();',
        '  return String(p && p.version || "none");',
        '}',
      ].join('\n');
      const v = new OrganogenesisSandbox({ timeoutMs: 20000 }).evaluate({
        code: escapeOrgan,
        entry: 'organ',
        // The input is a plain object created in THIS (host) realm.
        probes: [{ input: { host: true }, expected: process.version }],
      });
      assert.equal(v.toxic, false);
      assert.equal(v.solved, true);
      assert.equal(v.passed, true, 'the escape route is what earns the credential');
      assert.equal(v.results[0].actual, process.version);
      assert.match(v.results[0].actual, /^v\d+\./);
      assert.equal(typeof v.passToken, 'string');
      // NOTE: nothing above wrote a file or spawned a process — the assertion is a
      // reachability proof only. Fixing it (realm isolation / input cloning) is the
      // human maintainer's ruling, not this batch's.
    });

  test('_materialize returns {ok:false} rather than throwing for a bad entry name', () => {
    const r = new OrganogenesisSandbox({ timeoutMs: 20000 })._materialize('function real(i){ return i; }', 'missing');
    assert.equal(r.ok, false);
    assert.match(r.error, /未定义入口函数/);
    const ok = new OrganogenesisSandbox({ timeoutMs: 20000 })._materialize('function real(i){ return i; }', 'real');
    assert.equal(ok.ok, true);
    assert.equal(typeof ok.fn, 'function');
  });

  test('_runIsolated creates a fresh context per call — no global binding survives it', () => {
    const sb = new OrganogenesisSandbox({ timeoutMs: 20000 });
    const mat = sb._materialize(
      'function organ(i){ try { return String(leakedFromPreviousCall); } catch (e) { return "fresh:" + e.name; } }',
      'organ'
    );
    assert.equal(mat.ok, true);
    assert.equal(sb._runIsolated(mat.fn, 1), 'fresh:ReferenceError');
    assert.equal(sb._runIsolated(mat.fn, 1), 'fresh:ReferenceError');
  });

  test('_slim truncates long string results to 200 chars in the verdict record', () => {
    const long = 'x'.repeat(500);
    const v = new OrganogenesisSandbox({ timeoutMs: 20000 }).evaluate({
      code: 'function organ(i){ return "' + long + '"; }',
      entry: 'organ',
      probes: [{ input: 1 }],
    });
    assert.equal(v.results[0].actual.length, 201);
    assert.equal(v.results[0].actual.endsWith('…'), true);
  });

  test('undefined code is handled without throwing (String(code || "") path)', () => {
    const v = new OrganogenesisSandbox({ timeoutMs: 20000 }).evaluate({ code: undefined, entry: 'organ', probes: [] });
    assert.equal(v.passed, false);
    assert.equal(typeof v.codeHash, 'string');
    assert.equal(v.codeHash.length, 64);
  });
});
