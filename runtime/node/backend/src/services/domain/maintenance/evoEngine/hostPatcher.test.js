'use strict';

/**
 * hostPatcher.test.js — co-located suite for the hot-load executor (three gates).
 *
 * IO: none. HostPatcher writes only into a process-local shadow registry Map
 * (hostPatcher.js:16 states it never overwrites a core source file), so containment is
 * structural. The unit's own token machinery (organogenesisSandbox) is exercised in-process;
 * no subprocess, no repository path. Data homes are pinned before require as everywhere else.
 *
 * Defects pinned as CURRENT behaviour (documentation, never approval):
 *   B31-E22  `opts.breaker || null` + `if (this.breaker && ...)` makes 闸门③ a no-op for a
 *            standalone patcher even while the engine is fused.
 *   B31-E23  the declared verdict.codeHash is never re-verified, so the patch identity recorded
 *            downstream can be decoupled from the code that was loaded.
 *   B31-E24  闸门② runs the protected-name matcher over the WHOLE source text.
 *   B31-E25  rollback() reports ok:true for a target that never existed.
 *   B31-E26  _compile() swallows the materialization error into fn:null (and uses a fresh
 *            default-timeout sandbox, not the instance that signed the verdict).
 *   B31-E32  gate order is ③→②→① while the header numbers them ①②③, so a forged load attempt
 *            against a protected module is reported as a constitution violation.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-evo-patcher-'));
process.env.KHY_DATA_HOME = path.join(TMP, 'data');
process.env.KHY_PROJECT_DATA_HOME = path.join(TMP, 'project');
process.env.HOME = TMP;
process.env.XDG_CONFIG_HOME = path.join(TMP, 'config');
if (process.platform === 'win32') {
  process.env.USERPROFILE = TMP;
}

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('./hostPatcher');
const { HostPatcher, SandboxBypassError, ConstitutionViolation } = mod;
const { OrganogenesisSandbox } = require('./organogenesisSandbox');
const { EvoTrustBreaker } = require('./evoTrustBreaker');

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const ORGAN = 'function organ(x){ return x * 2; }';

/**
 * A genuine, token-bearing verdict for `code` produced by the real sandbox.
 *
 * Determinism: the sandbox default is a fixed 200ms vm wall clock (organogenesisSandbox.js:24,
 * DEFECT B31-E3 / load-sensitivity B31-E34). Under parallel CPU contention a benign organ can
 * blow that budget, the verdict flips to passed:false, no passToken is issued, and applyPatch
 * throws SandboxBypassError — turning a *construction* assertion red for an environmental reason.
 * The property under test here is "a genuine verdict hot-loads", not "the default budget is fast
 * enough", so this helper runs with a generous budget.
 */
function verdictFor(code, entry, probes) {
  return new OrganogenesisSandbox({ timeoutMs: 20000 }).evaluate({ code, entry, probes });
}
function realVerdict(code = ORGAN, entry = 'organ') {
  return verdictFor(code, entry, [{ input: 4, expected: 8 }]);
}

describe('hostPatcher — surface and construction', () => {
  test('module.exports keys are exactly the three documented names', () => {
    assert.deepEqual(Object.keys(mod).sort(), ['ConstitutionViolation', 'HostPatcher', 'SandboxBypassError']);
  });

  test('both gate errors are Error subclasses carrying the codes index.js maps', () => {
    const a = new SandboxBypassError('m');
    const b = new ConstitutionViolation('m');
    assert.equal(a instanceof Error, true);
    assert.equal(b instanceof Error, true);
    assert.equal(a.name, 'SandboxBypassError');
    assert.equal(a.code, 'EVO_SANDBOX_BYPASS');
    assert.equal(b.name, 'ConstitutionViolation');
    assert.equal(b.code, 'EVO_CONSTITUTION');
    assert.equal(a.message, 'm');
    assert.equal(typeof a.stack, 'string');
  });

  test('a patcher starts with an empty shadow registry and no breaker by default', () => {
    const hp = new HostPatcher();
    assert.equal(hp.registry instanceof Map, true);
    assert.equal(hp.registry.size, 0);
    assert.deepEqual(hp.loadedTargets(), []);
    assert.equal(hp.breaker, null);
    assert.deepEqual(hp._history, []);
    assert.equal(new HostPatcher({}).breaker, null);
    assert.equal(typeof new HostPatcher().applyPatch, 'function');
  });

  test('an injected Map is used by reference, so two patchers can share one evolution track', () => {
    const shared = new Map();
    const a = new HostPatcher({ registry: shared });
    const b = new HostPatcher({ registry: shared });
    a.applyPatch({ target: 'q', code: ORGAN, entry: 'organ', verdict: realVerdict() });
    assert.deepEqual(b.loadedTargets(), ['q']);
    assert.equal(shared.get('q').entry, 'organ');
  });

  test('a non-Map registry option is discarded rather than crashing later', () => {
    for (const bad of [{}, [], 'map', null, undefined]) {
      const hp = new HostPatcher({ registry: bad });
      assert.equal(hp.registry instanceof Map, true);
      assert.equal(hp.registry.size, 0);
    }
  });
});

describe('hostPatcher — happy path through all three gates', () => {
  test('a genuine sandbox verdict hot-loads the organ into the shadow registry', () => {
    const hp = new HostPatcher();
    const v = realVerdict();
    assert.equal(v.passed, true);
    const r = hp.applyPatch({ target: 'parser:weird-format', code: ORGAN, entry: 'organ', verdict: v });
    assert.equal(r.ok, true);
    assert.equal(r.patchId, `patch_${v.codeHash.slice(0, 12)}`);
    assert.equal(r.target, 'parser:weird-format');
    assert.equal(hp.loadedTargets().length, 1);

    const fn = hp.resolve('parser:weird-format');
    assert.equal(typeof fn, 'function');
    assert.equal(fn(21), 42, 'the loaded organ is the compiled source, callable by the host');
  });

  test('the registry record carries the full provenance the ledger expects', () => {
    const hp = new HostPatcher();
    const v = realVerdict();
    hp.applyPatch({ target: 't', code: ORGAN, entry: 'organ', verdict: v, requirementId: 'evo_abc' });
    const rec = hp.registry.get('t');
    assert.deepEqual(Object.keys(rec).sort(), ['code', 'codeHash', 'entry', 'fn', 'patchId', 'requirementId', 'target']);
    assert.equal(rec.requirementId, 'evo_abc');
    assert.equal(rec.codeHash, v.codeHash);
    assert.equal(rec.code, ORGAN);
    assert.equal(rec.target, 't');
    assert.equal(new HostPatcher().applyPatch({ target: 't', code: ORGAN, entry: 'organ', verdict: v }).ok, true);
  });

  test('requirementId is optional and recorded as null', () => {
    const hp = new HostPatcher();
    hp.applyPatch({ target: 't', code: ORGAN, entry: 'organ', verdict: realVerdict() });
    assert.equal(hp.registry.get('t').requirementId, null);
  });

  test('resolve/loadedTargets coerce the target to a string and never invent an organ', () => {
    const hp = new HostPatcher();
    assert.equal(hp.resolve('nope'), null);
    assert.equal(hp.resolve(), null);
    assert.equal(hp.resolve({ toString: () => 'x' }), null);
    assert.deepEqual(hp.loadedTargets(), []);
  });

  test('applyPatch with no argument at all reports the missing target instead of throwing', () => {
    assert.deepEqual(new HostPatcher().applyPatch(), { ok: false, error: 'missing target' });
    assert.deepEqual(new HostPatcher().applyPatch({}), { ok: false, error: 'missing target' });
    assert.deepEqual(new HostPatcher().applyPatch({ target: 0 }), { ok: false, error: 'missing target' });
    const blank = new HostPatcher().applyPatch({ target: '   ', code: ORGAN, entry: 'organ', verdict: realVerdict() });
    assert.equal(blank.ok, true, 'boundary: the target is only String()-ed, never trimmed or validated');
    assert.equal(blank.target, '   ');
  });
});

describe('hostPatcher — 闸门① credential check (防呆①)', () => {
  test('no verdict, an unsolved verdict and a tokenless verdict are all refused', () => {
    const hp = new HostPatcher();
    for (const verdict of [undefined, null, {}, { passed: false }, { passed: true }, { passed: true, passToken: null }]) {
      assert.throws(
        () => hp.applyPatch({ target: 't', code: ORGAN, entry: 'organ', verdict }),
        (e) => e instanceof SandboxBypassError && e.code === 'EVO_SANDBOX_BYPASS',
        JSON.stringify(verdict)
      );
    }
    assert.deepEqual(hp.loadedTargets(), [], 'a refused load leaves the track untouched');
  });

  test('the same code under a different verdict digest fails the HMAC binding', () => {
    const v = realVerdict();
    assert.throws(
      () => new HostPatcher().applyPatch({ target: 't', code: ORGAN, entry: 'organ', verdict: { ...v, verdictDigest: 'f'.repeat(16) } }),
      SandboxBypassError
    );
  });

  test('swapping the code after the verdict is caught — 绝不跳过沙箱 holds for the payload', () => {
    const v = realVerdict();
    assert.throws(
      () => new HostPatcher().applyPatch({ target: 't', code: 'function organ(x){ return x * 3; }', entry: 'organ', verdict: v }),
      (e) => e.code === 'EVO_SANDBOX_BYPASS' && /凭证校验失败/.test(e.message)
    );
  });

  test('a verdict that did not pass carries no token, so a passed flag alone cannot open the gate', () => {
    const failed = new OrganogenesisSandbox().evaluate({ code: ORGAN, entry: 'organ', probes: [{ input: 4, expected: 9 }] });
    assert.equal(failed.passed, false);
    assert.equal(failed.passToken, null);
    assert.throws(
      () => new HostPatcher().applyPatch({ target: 't', code: ORGAN, entry: 'organ', verdict: { ...failed, passed: true } }),
      SandboxBypassError
    );
  });
});

describe('hostPatcher — 闸门② constitution guard (防呆③)', () => {
  test('a protected target is refused with a constitution violation', () => {
    for (const target of ['evoLedger:rewrite', 'patch organogenesisSandbox', 'x/constraints/y', 'constitutionalRedLines']) {
      assert.throws(
        () => new HostPatcher().applyPatch({ target, code: ORGAN, entry: 'organ', verdict: { passed: true, passToken: 't', codeHash: 'a'.repeat(64), verdictDigest: 'd' } }),
        (e) => e instanceof ConstitutionViolation && e.code === 'EVO_CONSTITUTION',
        target
      );
    }
  });

  test('DEFECT B31-E24 (current behaviour): 闸门② also runs the path-fragment matcher over the whole '
    + 'SOURCE text, so an organ that merely declares an identifier containing "constraints" is '
    + 'rejected as a constitution violation even though the sandbox verdict was clean', () => {
      const code = 'function organ(items){ const constraintsList = items.filter(Boolean); return constraintsList.length; }';
      const v = new OrganogenesisSandbox().evaluate({ code, entry: 'organ', probes: [{ input: [1, null, 2], expected: 2 }] });
      assert.equal(v.passed, true);
      assert.deepEqual(v.toxicity, [], 'the sandbox itself found nothing wrong with it');
      assert.throws(
        () => new HostPatcher().applyPatch({ target: 'organ:filter', code, entry: 'organ', verdict: v }),
        (e) => e.code === 'EVO_CONSTITUTION' && /受保护不变量/.test(e.message)
      );
    });

  test('DEFECT B31-E32 (current behaviour): the gates run ③→②→① while the header numbers them ①②③, '
    + 'so a load with NO valid credential aimed at a protected module is reported as a constitution '
    + 'violation — the operator sees the wrong reason for a sandbox bypass attempt', () => {
      const hp = new HostPatcher();
      assert.throws(
        () => hp.applyPatch({ target: 'evoLedger', code: ORGAN, entry: 'organ', verdict: undefined }),
        (e) => e.code === 'EVO_CONSTITUTION',
        'gate 1 would have rejected it as EVO_SANDBOX_BYPASS'
      );
      // Same payload, unprotected target, to prove the credential gate is what would fire:
      assert.throws(
        () => hp.applyPatch({ target: 'organ:x', code: ORGAN, entry: 'organ', verdict: undefined }),
        (e) => e.code === 'EVO_SANDBOX_BYPASS'
      );
    });
});

describe('hostPatcher — 闸门③ engine read-only lock (防呆④)', () => {
  test('a wired breaker refuses the load and returns instead of throwing', () => {
    const breaker = new EvoTrustBreaker();
    breaker.recordSandboxResult('x', false);
    breaker.recordSandboxResult('y', false);
    assert.equal(breaker.isEngineReadOnly(), true);
    const hp = new HostPatcher({ breaker });
    assert.deepEqual(hp.applyPatch({ target: 't', code: ORGAN, entry: 'organ', verdict: realVerdict() }), {
      ok: false,
      reason: 'engine-readonly',
      error: '演进引擎已熔断为只读模式，拒绝热载（防呆④）。',
    });
    assert.equal(hp.registry.size, 0);
  });

  test('the gate is duck-typed, so any object exposing isEngineReadOnly() locks the patcher', () => {
    const hp = new HostPatcher({ breaker: { isEngineReadOnly: () => true } });
    assert.equal(hp.applyPatch({ target: 't', code: ORGAN, entry: 'organ', verdict: realVerdict() }).reason, 'engine-readonly');
    const open = new HostPatcher({ breaker: { isEngineReadOnly: () => false } });
    assert.equal(open.applyPatch({ target: 't', code: ORGAN, entry: 'organ', verdict: realVerdict() }).ok, true);
  });

  test('DEFECT B31-E22 (current behaviour): the header promises 三道硬闸门，缺一不可, but the lock '
    + 'gate is `if (this.breaker && ...)` and the breaker defaults to null — a patcher built '
    + 'without one hot-loads freely while the engine is fused read-only', () => {
      const breaker = new EvoTrustBreaker();
      breaker.recordSandboxResult('x', false);
      breaker.recordSandboxResult('x', false);
      assert.equal(breaker.isEngineReadOnly(), true);
      assert.equal(breaker.isBranchFused('x'), true);

      const bare = new HostPatcher();
      const v = realVerdict();
      const r = bare.applyPatch({ target: 't', code: ORGAN, entry: 'organ', verdict: v });
      assert.equal(r.ok, true, '防呆④ never fired for the default construction path');
      assert.equal(r.patchId, `patch_${v.codeHash.slice(0, 12)}`);
      assert.deepEqual(bare.loadedTargets(), ['t']);
      // The same verdict reaches the same registry whether or not the engine is fused:
      const wired = new HostPatcher({ breaker });
      assert.equal(wired.applyPatch({ target: 't', code: ORGAN, entry: 'organ', verdict: v }).ok, false);
    });

  test('the readonly gate runs before the credential gate, so an unsigned load reports the lock', () => {
    const hp = new HostPatcher({ breaker: { isEngineReadOnly: () => true } });
    assert.equal(hp.applyPatch({ target: 't', code: ORGAN, entry: 'organ', verdict: null }).reason, 'engine-readonly');
  });
});

describe('hostPatcher — patch identity provenance', () => {
  test('DEFECT B31-E23 (current behaviour): patchId and the registry codeHash come from the '
    + 'DECLARED verdict.codeHash, which is never compared to the hash of the code being loaded — '
    + 'so the ledger HOTLOAD key and the rollback attribution can name a code that was not loaded', () => {
      const v = realVerdict();
      const hp = new HostPatcher();
      const r = hp.applyPatch({ target: 't', code: ORGAN, entry: 'organ', verdict: { ...v, codeHash: 'f'.repeat(64) } });
      assert.equal(r.ok, true, 'verifyToken re-hashes the code internally but its result is not compared to v.codeHash');
      assert.equal(r.patchId, 'patch_ffffffffffff');
      assert.notEqual(r.patchId, `patch_${v.codeHash.slice(0, 12)}`, 'the true identity of the loaded organ');
      assert.equal(hp.registry.get('t').codeHash, 'f'.repeat(64));
    });

  test('a truncated or non-string declared hash is sliced without validation', () => {
    const v = realVerdict();
    assert.equal(
      new HostPatcher().applyPatch({ target: 't', code: ORGAN, entry: 'organ', verdict: { ...v, codeHash: 'short' } }).patchId,
      'patch_short'
    );
    assert.throws(
      () => new HostPatcher().applyPatch({ target: 't', code: ORGAN, entry: 'organ', verdict: { ...v, codeHash: 12345 } }),
      TypeError,
      'a numeric declared hash dies inside slice(), outside every gate'
    );
  });
});

describe('hostPatcher — rollback (§3.4)', () => {
  /** Hot-loads two different organs on one target and returns the patcher. */
  function twiceLoaded() {
    const hp = new HostPatcher();
    const first = 'function organ(){ return 1; }';
    const second = 'function organ(){ return 2; }';
    hp.applyPatch({ target: 't', code: first, entry: 'organ', verdict: verdictFor(first, 'organ', [{ expected: 1 }]) });
    hp.applyPatch({ target: 't', code: second, entry: 'organ', verdict: verdictFor(second, 'organ', [{ expected: 2 }]) });
    return hp;
  }

  test('a second load on the same target keeps a pre-state stack and rollback restores it', () => {
    const hp = twiceLoaded();
    assert.equal(hp.resolve('t')(), 2);
    assert.deepEqual(hp.rollback('t'), { ok: true, target: 't', restored: true });
    assert.equal(hp.resolve('t')(), 1, 'the previous organ is back in the evolution track');
    assert.equal(hp._history.length, 1, 'one pre-state frame is popped per rollback, not the whole stack');
  });

  test('the first load has no pre-state, so the second rollback uninstalls the target', () => {
    const hp = twiceLoaded();
    hp.rollback('t');
    assert.deepEqual(hp.rollback('t'), { ok: true, target: 't', restored: false });
    assert.equal(hp.resolve('t'), null);
    assert.deepEqual(hp.loadedTargets(), []);
  });

  test('DEFECT B31-E25 (current behaviour): rollback() answers ok:true for a target that never '
    + 'existed, and for no target at all — the caller cannot tell a rollback from a typo', () => {
      const hp = new HostPatcher();
      assert.deepEqual(hp.rollback('nope:never'), { ok: true, target: 'nope:never', restored: false });
      assert.deepEqual(hp.rollback(), { ok: true, target: 'undefined', restored: false });
      assert.equal(hp.registry.size, 0);
      assert.deepEqual(hp._history, []);
      // index.js:191 logs `restored` verbatim, so the immutable ledger records a successful
      // rollback of a target that was never loaded.
    });

  test('rollback pops only the most recent pre-state for that target, leaving other targets alone', () => {
    const hp = new HostPatcher();
    hp.applyPatch({ target: 'a', code: ORGAN, entry: 'organ', verdict: realVerdict() });
    hp.applyPatch({ target: 'b', code: ORGAN, entry: 'organ', verdict: realVerdict() });
    assert.deepEqual(hp.loadedTargets(), ['a', 'b']);
    assert.deepEqual(hp.rollback('a'), { ok: true, target: 'a', restored: false });
    assert.deepEqual(hp.loadedTargets(), ['b']);
  });
});

describe('hostPatcher — _compile containment', () => {
  test('a compilable organ is returned as a callable function', () => {
    const hp = new HostPatcher();
    const fn = hp._compile(ORGAN, 'organ');
    assert.equal(typeof fn, 'function');
    assert.equal(fn(5), 10);
  });

  test('DEFECT B31-E26 (current behaviour): a materialization failure collapses to null and the '
    + 'error text is dropped, while applyPatch still answers ok:true — the host then silently '
    + 'resolves nothing', () => {
      const hp = new HostPatcher();
      assert.equal(hp._compile('const x = 1;', 'organ'), null);
      const mat = new OrganogenesisSandbox()._materialize('const x = 1;', 'organ');
      assert.equal(mat.ok, false);
      assert.equal(typeof mat.error, 'string');
      assert.match(mat.error, /未定义入口函数 organ/, 'the message exists — _compile discards it');

      // Reachable through the public API: the verdict is genuine, the entry field is not carried
      // over from it, and applyPatch never validates patch.entry.
      const v = realVerdict();
      const r = hp.applyPatch({ target: 't', code: ORGAN, verdict: v });
      assert.equal(r.ok, true);
      assert.equal(hp.registry.get('t').entry, undefined);
      assert.equal(hp.resolve('t'), null, 'a loaded organ that cannot be called, reported as ok');
    });

  test('_compile is a private helper reached through a fresh default sandbox, not the instance '
    + 'that signed the verdict (structural half of B31-E26)', () => {
      const hp = new HostPatcher();
      const before = hp.registry.size;
      assert.equal(typeof hp._compile, 'function');
      assert.equal(hp._compile('function organ(){return 1}', 'organ')(), 1);
      assert.equal(hp.registry.size, before, 'compiling does not register anything');
      // Reading-verified, not reproduced: hostPatcher.js:156 builds `new sandbox.OrganogenesisSandbox()`
      // and therefore re-applies DEFAULT_TIMEOUT_MS (200ms) to code that was evaluated under some
      // other instance's timeout. Forcing that split deterministically needs a wall-clock race,
      // which a co-located suite must not introduce. Recorded as NOT VERIFIED.
    });
});
