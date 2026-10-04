'use strict';

/**
 * index.test.js — co-located suite for SelfBootstrapEngine, the closed-loop façade.
 *
 * Containment: every test that can reach a write channel injects the engine's own `ledger` seam
 * (index.js:43) with an in-memory double, so 防呆⑤ is never exercised against the repository.
 * The two tests that deliberately use the REAL evoLedger pin all four data homes into a fresh
 * mkdtemp directory before require (top of this file) and then assert the resolved ledger path
 * sits inside it. No code generation, no subprocess, no hot patch reaches a tracked file; the
 * HostPatcher track is a process-local Map.
 *
 * Defects pinned as CURRENT behaviour (documentation, never approval):
 *   B31-E29  _log() swallows both a throwing append and an {ok:false} append at all six call sites.
 *   B31-E30  the branch-fuse pre-check precedes the read-only check, so a doubly fused engine
 *            only ever reports the narrower reason.
 *   B31-E2 / B31-E17 / B31-E22 are also visible from the pipeline and pinned here.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-evo-engine-'));
process.env.KHY_DATA_HOME = path.join(TMP, 'data');
process.env.KHY_PROJECT_DATA_HOME = path.join(TMP, 'project');
process.env.HOME = TMP;
process.env.XDG_CONFIG_HOME = path.join(TMP, 'config');
if (process.platform === 'win32') {
  process.env.USERPROFILE = TMP;
}

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('./index');
const { SelfBootstrapEngine } = mod;
const evoLedger = require('./evoLedger');
const evoRequirement = require('./evoRequirement');
const { EvoTrustBreaker } = require('./evoTrustBreaker');
const { HostPatcher } = require('./hostPatcher');
const { OrganogenesisSandbox } = require('./organogenesisSandbox');
const { PainPointScanner } = require('./painPointScanner');

/**
 * Determinism seam for the evolved path (see DEFECT B31-E34).
 *
 * Every test that expects status `evolved` / `verdict.passed:true` runs a *benign* organ through
 * the REAL OrganogenesisSandbox. That sandbox's default is a fixed 200ms vm WALL-CLOCK
 * (organogenesisSandbox.js:24, pinned as B31-E3) which is not activity-aware; under parallel CPU
 * contention the compile/execute of even `x*2` can exceed 200ms, the verdict flips to
 * passed:false, no passToken is minted, applyPatch throws SandboxBypassError and the engine halts
 * at `sandbox-bypass-blocked` instead of `evolved` — a construction/orchestration assertion turned
 * red by ambient load, not by a logic change. These tests assert the loop's WIRING, not the
 * production budget, so they inject a generously budgeted sandbox. The budget is a test seam, not a
 * weakening: `passed`/`evolved`/`passToken` semantics are asserted exactly as before.
 */
const fastSandbox = () => new OrganogenesisSandbox({ timeoutMs: 20000 });

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** In-memory stand-in for the immutable ledger; records every append the engine attempts. */
function fakeLedger(opts = {}) {
  const calls = [];
  const kinds = opts.kinds || {};
  return {
    calls,
    KIND: evoLedger.KIND,
    append(kind, payload, o = {}) {
      calls.push({ kind, branch: o.branch, payload });
      if (kinds[kind] === 'throw') {
        throw new Error('ledger disk gone');
      }
      if (kinds[kind] === 'fail') {
        return { ok: false, error: '原子写失败' };
      }
      return { ok: true, seq: calls.length - 1, hash: `h${calls.length}` };
    },
    read: () => (opts.readReturn || []),
    verify: () => ({ ok: true, length: 0, brokenAt: null, reason: null }),
  };
}

/** A scanner double with a deterministic, L0-classifying attribution. */
function fakeScanner(overrides = {}) {
  return new PainPointScanner({
    diagnostician: { diagnose: () => ({ cause: '未归类', detail: 'plain detail', risk: null }) },
    ...overrides,
  });
}

const ORGAN = 'function organ(x){ return x * 2; }';
const goodGenerator = () => ({ code: ORGAN, entry: 'organ', probes: [{ input: 4, expected: 8 }] });
let _n = 0;
function friction(label) {
  _n += 1;
  return { signal: evoRequirement.SIGNALS.INTERCEPTOR_BLOCK, surface: `idx-${label}-x${_n}`, error: 'boom' };
}

describe('index — surface and construction', () => {
  test('module.exports keys are exactly the ten documented names', () => {
    assert.deepEqual(Object.keys(mod).sort(), [
      'ConstitutionViolation',
      'EvoTrustBreaker',
      'HostPatcher',
      'OrganogenesisSandbox',
      'PainPointScanner',
      'SandboxBypassError',
      'SelfBootstrapEngine',
      'evoLedger',
      'evoLevels',
      'evoRequirement',
    ]);
  });

  test('the façade re-exports the same singletons the sibling modules own', () => {
    assert.equal(mod.evoLedger, evoLedger);
    assert.equal(mod.evoRequirement, evoRequirement);
    assert.equal(mod.HostPatcher, HostPatcher);
    assert.equal(mod.EvoTrustBreaker, EvoTrustBreaker);
    assert.equal(mod.OrganogenesisSandbox, OrganogenesisSandbox);
    assert.equal(mod.PainPointScanner, PainPointScanner);
  });

  test('defaults: main branch, no generator, every collaborator built for us', () => {
    const eng = new SelfBootstrapEngine();
    assert.equal(eng.branch, 'main');
    assert.equal(eng.codeGenerator, null);
    assert.equal(eng.scanner.constructor.name, 'PainPointScanner');
    assert.equal(eng.sandbox.constructor.name, 'OrganogenesisSandbox');
    assert.equal(eng.breaker.constructor.name, 'EvoTrustBreaker');
    assert.equal(eng.patcher.constructor.name, 'HostPatcher');
    assert.equal(eng.ledger, evoLedger);
    assert.equal(new SelfBootstrapEngine({}).branch, 'main');
    assert.equal(new SelfBootstrapEngine({ branch: '' }).branch, 'main');
  });

  test('the patcher is wired to the engine breaker, so 防呆④ works on the default construction', () => {
    const eng = new SelfBootstrapEngine();
    assert.equal(eng.patcher.breaker, eng.breaker);
  });

  test('each seam is honoured by reference when supplied', () => {
    const parts = {
      scanner: fakeScanner(),
      sandbox: new OrganogenesisSandbox({ timeoutMs: 200 }),
      breaker: new EvoTrustBreaker(),
      patcher: new HostPatcher(),
      ledger: fakeLedger(),
    };
    const eng = new SelfBootstrapEngine(parts);
    assert.equal(eng.scanner, parts.scanner);
    assert.equal(eng.sandbox, parts.sandbox);
    assert.equal(eng.breaker, parts.breaker);
    assert.equal(eng.patcher, parts.patcher);
    assert.equal(eng.ledger, parts.ledger);
    assert.equal(typeof new SelfBootstrapEngine({ codeGenerator: () => ({}) }).codeGenerator, 'function');
    assert.equal(new SelfBootstrapEngine({ codeGenerator: 'not-a-function' }).codeGenerator, null);
  });
});

describe('index — the closed loop, happy path', () => {
  test('阻力 → 归因 → 生成 → 沙箱 → 热融合, with every stage记入日志', () => {
    const ledger = fakeLedger();
    const eng = new SelfBootstrapEngine({
      codeGenerator: goodGenerator,
      ledger,
      scanner: fakeScanner(),
      sandbox: fastSandbox(),
      branch: 'loop-happy',
    });
    const res = eng.evolve(friction('happy'));

    assert.equal(res.status, 'evolved');
    assert.equal(res.requirement.signal, 'interceptor-block');
    assert.equal(evoRequirement.validate(res.requirement).valid, true);
    assert.equal(res.verdict.passed, true);
    assert.equal(res.verdict.probeCount, 1);
    assert.equal(res.patch.ok, true);
    assert.equal(res.patch.patchId, `patch_${res.verdict.codeHash.slice(0, 12)}`);
    assert.equal(res.patch.target, `organ:${res.requirement.id}`, 'the default target is namespaced by the id');
    assert.equal(res.executionLevel, 'L0');
    assert.equal(res.validationSteps, 0);
    assert.deepEqual(ledger.calls.map((c) => c.kind), ['requirement', 'code', 'sandbox', 'hotload']);
    assert.deepEqual([...new Set(ledger.calls.map((c) => c.branch))], ['loop-happy']);
  });

  test('the four ledger payloads carry the provenance an auditor needs', () => {
    const ledger = fakeLedger();
    const eng = new SelfBootstrapEngine({ codeGenerator: goodGenerator, ledger, scanner: fakeScanner(), sandbox: fastSandbox(), branch: 'loop-payload' });
    const res = eng.evolve(friction('payload'));
    const [req, code, sdbx, hot] = ledger.calls.map((c) => c.payload);

    assert.equal(req.id, res.requirement.id);
    assert.equal(code.requirementId, res.requirement.id);
    assert.equal(code.entry, 'organ');
    assert.equal(code.codeLength, ORGAN.length);
    assert.equal(code.executionLevel, 'L0');
    assert.equal(code.validationSteps, 0);
    assert.equal(sdbx.requirementId, res.requirement.id);
    assert.deepEqual(Object.keys(sdbx).sort(), ['codeHash', 'error', 'passed', 'regressed', 'requirementId', 'solved', 'toxic', 'toxicity']);
    assert.equal(sdbx.passed, true);
    assert.equal(sdbx.error, null);
    assert.equal(hot.requirementId, res.requirement.id);
    assert.equal(hot.patchId, res.patch.patchId);
    assert.equal(hot.target, res.patch.target);
  });

  test('a candidate may name its own target, and a baseline is forwarded to the sandbox', () => {
    const ledger = fakeLedger();
    const eng = new SelfBootstrapEngine({
      codeGenerator: () => ({ ...goodGenerator(), target: 'parser:custom-name' }),
      ledger,
      scanner: fakeScanner(),
      sandbox: fastSandbox(),
      branch: 'loop-target',
    });
    assert.equal(eng.evolve(friction('target')).patch.target, 'parser:custom-name');

    const regressed = new SelfBootstrapEngine({
      codeGenerator: () => ({
        code: 'function organ(x){ return x + 1; }',
        entry: 'organ',
        probes: [{ input: 4, expected: 8 }],
        baseline: (input) => input * 2,
      }),
      ledger: fakeLedger(),
      scanner: fakeScanner(),
    });
    const res = regressed.evolve(friction('baseline'));
    assert.equal(res.status, 'sandbox-rejected');
    assert.equal(res.verdict.regressed, true);
    assert.equal(res.verdict.solved, false);
    assert.equal(res.reason, '影子方案引入退化，否决热载。');
  });

  test('CONTAINMENT: an injected ledger means no byte is written under the project data home', () => {
    const branch = 'loop-no-disk';
    const eng = new SelfBootstrapEngine({ codeGenerator: goodGenerator, ledger: fakeLedger(), scanner: fakeScanner(), sandbox: fastSandbox(), branch });
    assert.equal(eng.evolve(friction('disk')).status, 'evolved');
    assert.equal(eng.verifyLedger().ok, true);
    assert.equal(fs.existsSync(evoLedger._file(branch)), false, 'the real observations file was never opened');
    assert.equal(evoLedger._file(branch).startsWith(TMP), true);
  });

  test('DEFECT B31-E2 (current behaviour): the engine forwards `candidate.probes || []`, so a '
    + 'generator that returns no probe at all yields passed:true and a real热载凭证', () => {
      const ledger = fakeLedger();
      const eng = new SelfBootstrapEngine({
        codeGenerator: () => ({ code: 'function organ(){ return 1; }', entry: 'organ' }),
        ledger,
        scanner: fakeScanner(),
        sandbox: fastSandbox(),
        branch: 'loop-noprobe',
      });
      const res = eng.evolve(friction('noprobe'));
      assert.equal(res.status, 'evolved');
      assert.equal(res.verdict.probeCount, 0);
      assert.equal(res.verdict.solved, true, 'vacuous truth: nothing was tested');
      assert.equal(res.verdict.passToken !== null, true, 'a credential was signed for an untested organ');
      assert.equal(eng.patcher.loadedTargets().length, 1, 'and it was hot-loaded into the host track');
    });

  test('the default engine path writes only inside the pinned temp home', () => {
    const eng = new SelfBootstrapEngine({ branch: 'loop-real-ledger' });
    const res = eng.evolve(friction('real'));
    assert.equal(res.status, 'no-generator', 'without a generator the loop stops before any热载');
    const file = evoLedger._file('loop-real-ledger');
    assert.equal(file.startsWith(TMP), true, `${file} escaped the sandbox`);
    assert.equal(file.includes(path.join('khy-os', 'services')), false);
    assert.equal(fs.existsSync(file), true);
    assert.deepEqual(evoLedger.verify({ branch: 'loop-real-ledger' }), {
      ok: true,
      length: 1,
      brokenAt: null,
      reason: null,
    }, 'only the REQUIREMENT stage is logged before the halt');
    assert.equal(evoLedger.read({ branch: 'loop-real-ledger' })[0].kind, 'requirement');
  });
});

describe('index — halt paths', () => {
  test('DEFECT B31-E17 seen from the engine: a plain unclassified tool failure is minted as an '
    + 'unplanned L2 and the requirement gate refuses it, so the most common runtime friction can '
    + 'never enter the evolution loop', () => {
      const ledger = fakeLedger();
      const eng = new SelfBootstrapEngine({ codeGenerator: goodGenerator, ledger, branch: 'halt-e17' });
      const res = eng.evolve({ signal: evoRequirement.SIGNALS.TOOL_FAILURE, surface: 'plain-tool', error: 'no diagnosis matches' });
      assert.equal(res.status, 'requirement-invalid');
      assert.deepEqual(res.missing, ['l2Plan(architectureDiff/blastRadius)']);
      assert.match(res.reason, /需求规格不合规/);
      assert.equal(res.requirement.level, 'L2');
      assert.deepEqual(ledger.calls.map((c) => c.kind), ['requirement'], 'the invalid demand is still留痕');
    });

  test('a structurally broken requirement is refused without running the rest of the loop', () => {
    const ledger = fakeLedger();
    const eng = new SelfBootstrapEngine({
      codeGenerator: goodGenerator,
      ledger,
      scanner: { scan: () => ({ id: 'r-bare' }) },
      branch: 'halt-invalid',
    });
    const res = eng.evolve({});
    assert.equal(res.status, 'requirement-invalid');
    assert.deepEqual(res.missing, ['signal', 'attribution.why', 'level']);
    assert.equal(res.reason, '需求规格不合规：signal、attribution.why、level');

    const nullScan = new SelfBootstrapEngine({ codeGenerator: goodGenerator, ledger: fakeLedger(), scanner: { scan: () => null } });
    assert.deepEqual(nullScan.evolve({}), {
      status: 'requirement-invalid',
      requirement: null,
      missing: ['<all>'],
      reason: '需求规格不合规：<all>',
    });
  });

  test('no generator, a throwing generator and an empty candidate each halt with their own status', () => {
    const scanner = fakeScanner();
    const bare = new SelfBootstrapEngine({ scanner, ledger: fakeLedger(), branch: 'halt-nogen' });
    assert.equal(bare.evolve(friction('nogen')).status, 'no-generator');
    assert.match(bare.evolve(friction('nogen2')).reason, /未配置 codeGenerator/);

    const boom = new SelfBootstrapEngine({
      scanner,
      ledger: fakeLedger(),
      codeGenerator: () => {
        throw new Error('model offline');
      },
    });
    const boomRes = boom.evolve(friction('generr'));
    assert.equal(boomRes.status, 'generation-error');
    assert.equal(boomRes.reason, '代码生成失败：model offline', 'the generator error message is surfaced verbatim');

    for (const candidate of [null, undefined, {}, { code: '' }, { entry: 'organ' }, { code: 0, entry: 0 }]) {
      const empty = new SelfBootstrapEngine({ scanner, ledger: fakeLedger(), codeGenerator: () => candidate });
      assert.equal(empty.evolve(friction('genempty')).status, 'generation-empty', JSON.stringify(candidate));
    }
  });

  test('a toxic candidate is rejected before热载, and the reason quotes the toxicity hits', () => {
    const ledger = fakeLedger();
    const eng = new SelfBootstrapEngine({
      scanner: fakeScanner(),
      ledger,
      branch: 'halt-toxic',
      codeGenerator: () => ({ code: 'function organ(){ return require("fs"); }', entry: 'organ', probes: [{ expected: 1 }] }),
    });
    const res = eng.evolve(friction('toxic'));
    assert.equal(res.status, 'sandbox-rejected');
    assert.match(res.reason, /^沙箱判毒：/);
    assert.equal(res.verdict.toxic, true);
    assert.equal(res.verdict.passToken, null);
    assert.equal(res.branchFused, false);
    assert.deepEqual(ledger.calls.map((c) => c.kind), ['requirement', 'code', 'sandbox']);
    assert.equal(eng.patcher.loadedTargets().length, 0);
  });

  test('a forged or foreign verdict is stopped by the patcher credential gate', () => {
    const ledger = fakeLedger();
    const mockSandbox = {
      evaluate: () => ({
        passed: true,
        solved: true,
        regressed: false,
        toxic: false,
        toxicity: [],
        probeCount: 1,
        results: [],
        error: null,
        codeHash: 'a'.repeat(64),
        verdictDigest: 'deadbeefcafe1234',
        passToken: 'not-a-real-token',
      }),
    };
    const eng = new SelfBootstrapEngine({
      scanner: fakeScanner(),
      sandbox: mockSandbox,
      ledger,
      branch: 'halt-bypass',
      codeGenerator: goodGenerator,
    });
    const res = eng.evolve(friction('bypass'));
    assert.equal(res.status, 'sandbox-bypass-blocked');
    assert.match(res.reason, /沙箱凭证校验失败/);
    assert.deepEqual(ledger.calls.map((c) => c.kind), ['requirement', 'code', 'sandbox', 'alert']);
    assert.deepEqual(ledger.calls[3].payload, {
      kind: 'patch-rejected',
      requirementId: res.requirement.id,
      error: res.reason,
      code: 'EVO_SANDBOX_BYPASS',
    }, 'the rejection is logged with its machine code before the halt');
  });

  test('DEFECT B31-E22 seen from the engine: a patcher handed to the engine without a breaker is '
    + 'not locked even while a breaker elsewhere reports read-only', () => {
      const breaker = new EvoTrustBreaker();
      breaker.recordSandboxResult('other-engine', false);
      breaker.recordSandboxResult('other-engine', false);
      assert.equal(breaker.isEngineReadOnly(), true);
      const eng = new SelfBootstrapEngine({
        scanner: fakeScanner(),
        ledger: fakeLedger(),
        branch: 'halt-e22',
        breaker: new EvoTrustBreaker(),
        patcher: new HostPatcher(),
        sandbox: fastSandbox(),
        codeGenerator: goodGenerator,
      });
      assert.equal(eng.breaker.isEngineReadOnly(), false, 'this engine is a different breaker');
      assert.equal(eng.evolve(friction('e22')).status, 'evolved');
      // Whereas the same fused breaker, when wired, stops the loop at the pre-check:
      const locked = new SelfBootstrapEngine({
        scanner: fakeScanner(),
        ledger: fakeLedger(),
        breaker,
        codeGenerator: goodGenerator,
      });
      assert.equal(locked.evolve(friction('e22-locked')).status, 'engine-readonly');
      assert.equal(locked.patcher.loadedTargets().length, 0);
    });

  test('a patcher that returns ok:false halts as hotload-failed with its own reason', () => {
    const ledger = fakeLedger();
    const eng = new SelfBootstrapEngine({
      scanner: fakeScanner(),
      ledger,
      branch: 'halt-hotload',
      patcher: { applyPatch: () => ({ ok: false, reason: 'engine-readonly', error: 'locked by 防呆④' }) },
      sandbox: fastSandbox(),
      codeGenerator: goodGenerator,
    });
    const res = eng.evolve(friction('hotload'));
    assert.equal(res.status, 'hotload-failed');
    assert.equal(res.reason, 'locked by 防呆④');
    assert.equal(res.verdict.passed, true, 'the organ passed; only the load was refused');
    assert.deepEqual(ledger.calls.map((c) => c.kind), ['requirement', 'code', 'sandbox']);
  });

  test('DEFECT B31-E33 (current behaviour): the free-text `surface` supplied by the friction '
    + 'producer is concatenated into the classify() blob (evoLevels.js:60), so a surface that '
    + 'merely MENTIONS a core-flow word escalates the requirement to L2 and the pipeline refuses '
    + 'it — the word "constitution" in a module name is enough', () => {
      const ledger = fakeLedger();
      const eng = new SelfBootstrapEngine({ codeGenerator: goodGenerator, ledger, sandbox: fastSandbox(), branch: 'halt-e33' });
      const res = eng.evolve({ signal: evoRequirement.SIGNALS.INTERCEPTOR_BLOCK, surface: 'runtime-constitution', error: 'boom' });
      assert.equal(res.requirement.level, 'L2', 'rule-misfire wording is L0; the surface alone lifted it');
      assert.equal(res.status, 'requirement-invalid');
      assert.deepEqual(res.missing, ['l2Plan(architectureDiff/blastRadius)']);
      const plain = eng.evolve({ signal: evoRequirement.SIGNALS.INTERCEPTOR_BLOCK, surface: 'runtime-rules', error: 'boom' });
      assert.equal(plain.requirement.level, 'L0');
      assert.equal(plain.status, 'evolved');
    });

  test('the constitution guard is enforced through the engine, reported as constitution-violation', () => {
    const ledger = fakeLedger();
    const code = 'function organ(items){ const constraintsList = items.filter(Boolean); return constraintsList.length; }';
    const eng = new SelfBootstrapEngine({
      scanner: fakeScanner(),
      ledger,
      branch: 'halt-constitution',
      sandbox: fastSandbox(),
      codeGenerator: () => ({ code, entry: 'organ', probes: [{ input: [1, null, 3], expected: 2 }] }),
    });
    const res = eng.evolve(friction('guard'));
    assert.equal(res.status, 'constitution-violation');
    assert.match(res.reason, /受保护不变量/);
    assert.equal(res.verdict.passed, true, 'the sandbox itself cleared this organ (B31-E24)');
    assert.deepEqual(ledger.calls.map((c) => c.kind), ['requirement', 'code', 'sandbox', 'alert']);
    assert.equal(ledger.calls[3].payload.code, 'EVO_CONSTITUTION');
  });
});

describe('index — fuse integration', () => {
  test('two failed verdicts on one pain point fuse the branch, lock the engine and log alert+fuse', () => {
    const ledger = fakeLedger();
    const eng = new SelfBootstrapEngine({
      scanner: fakeScanner(),
      ledger,
      branch: 'fuse-loop',
      codeGenerator: () => ({ code: 'function organ(x){ return x + 1; }', entry: 'organ', probes: [{ input: 4, expected: 8 }] }),
    });
    const f = friction('fuse');
    const r1 = eng.evolve(f);
    assert.equal(r1.status, 'sandbox-rejected');
    assert.equal(r1.reason, '未解决痛点，否决热载。');
    assert.equal(r1.branchFused, false);
    assert.equal(r1.alert, null);

    const r2 = eng.evolve(f);
    assert.equal(r2.status, 'sandbox-rejected');
    assert.equal(r2.branchFused, true);
    assert.equal(r2.engineReadOnly, true);
    assert.equal(r2.alert.kind, 'architectural-alert');
    const kinds = ledger.calls.map((c) => c.kind);
    assert.equal(kinds.filter((k) => k === 'alert').length, 1);
    assert.equal(kinds.filter((k) => k === 'fuse').length, 1);
    const fuseEntry = ledger.calls.find((c) => c.kind === 'fuse');
    assert.deepEqual(fuseEntry.payload, { engineReadOnly: true, consecutiveSandboxFailures: 2, fusedBranches: [r2.requirement.id] });

    const r3 = eng.evolve(f);
    assert.equal(r3.status, 'branch-fused');
    assert.match(r3.reason, /分支已熔断，停止自举/);
  });

  test('DEFECT B31-E30 (current behaviour): the branch-fuse pre-check sits BEFORE the read-only '
    + 'check (index.js:66 vs :71), so a doubly fused engine only ever tells the operator the '
    + 'narrower reason and the 防呆④ lock is never reported', () => {
      const eng = new SelfBootstrapEngine({
        scanner: fakeScanner(),
        ledger: fakeLedger(),
        branch: 'fuse-order',
        codeGenerator: () => ({ code: 'function organ(x){ return x + 1; }', entry: 'organ', probes: [{ input: 4, expected: 8 }] }),
      });
      const f = friction('order');
      eng.evolve(f);
      const r2 = eng.evolve(f);
      assert.equal(r2.branchFused, true);
      assert.equal(r2.engineReadOnly, true, 'both fuses are blown at the same time');
      const r3 = eng.evolve(f);
      assert.equal(r3.status, 'branch-fused', 'the read-only lock is masked');
      assert.equal(eng.breaker.isEngineReadOnly(), true);
      assert.equal('engine-readonly' in r3, false);
    });

  test('observePatch drives the rollback and logs it once per trigger', () => {
    const ledger = fakeLedger();
    const eng = new SelfBootstrapEngine({
      scanner: fakeScanner(),
      ledger,
      branch: 'rollback',
      sandbox: fastSandbox(),
      codeGenerator: goodGenerator,
    });
    const evolved = eng.evolve(friction('rollback'));
    const patchId = evolved.patch.patchId;
    assert.deepEqual(eng.observePatch(patchId, evolved.patch.target, true), { rollback: false, anomalies: 1 });
    assert.deepEqual(eng.observePatch(patchId, evolved.patch.target, true), { rollback: false, anomalies: 2 });
    const third = eng.observePatch(patchId, evolved.patch.target, true);
    assert.equal(third.rollback, true);
    assert.equal(third.anomalies, 3);
    assert.deepEqual(third.rolledBack, { ok: true, target: evolved.patch.target, restored: false });
    assert.deepEqual(ledger.calls.filter((c) => c.kind === 'rollback').map((c) => c.payload), [
      { patchId, target: evolved.patch.target, anomalies: 3, restored: false },
    ]);
    assert.equal(eng.patcher.resolve(evolved.patch.target), null, 'the organ really left the track');

    // B31-E28 reachability from the engine: a fourth anomaly rolls back again.
    const fourth = eng.observePatch(patchId, evolved.patch.target, true);
    assert.equal(fourth.rollback, true);
    assert.equal(ledger.calls.filter((c) => c.kind === 'rollback').length, 2);
  });

  test('observePatch on a healthy patch logs nothing and reports zero anomalies', () => {
    const ledger = fakeLedger();
    const eng = new SelfBootstrapEngine({ scanner: fakeScanner(), ledger, branch: 'rollback-clean' });
    assert.deepEqual(eng.observePatch('patch_zzz', 'organ:x', false), { rollback: false, anomalies: 0 });
    assert.deepEqual(ledger.calls, []);
  });
});

describe('index — ledger accessors', () => {
  test('verifyLedger and history both use the engine branch', () => {
    const seen = [];
    const ledger = {
      KIND: evoLedger.KIND,
      append: (k, p, o) => {
        seen.push([k, o.branch]);
        return { ok: true, seq: 0, hash: 'h' };
      },
      read: (o) => {
        seen.push(['read', o.branch]);
        return [{ seq: 0, kind: 'requirement' }];
      },
      verify: (o) => {
        seen.push(['verify', o.branch]);
        return { ok: false, length: 1, brokenAt: 0, reason: '内容哈希不匹配于 #0（疑似篡改）' };
      },
    };
    const eng = new SelfBootstrapEngine({ ledger, branch: 'feat-x' });
    assert.deepEqual(eng.history(), [{ seq: 0, kind: 'requirement' }]);
    assert.equal(eng.verifyLedger().ok, false);
    assert.deepEqual(seen, [['read', 'feat-x'], ['verify', 'feat-x']]);
  });

  test('DEFECT B31-E29 (current behaviour): every _log call site discards the append result, and '
    + '_log itself swallows the exception, so the engine reports status "evolved" while 防呆⑤ '
    + 'recorded nothing at all', () => {
      const throwing = fakeLedger({
        kinds: {
          requirement: 'throw',
          code: 'throw',
          sandbox: 'throw',
          hotload: 'throw',
          alert: 'throw',
          fuse: 'throw',
          rollback: 'throw',
        },
      });
      const eng = new SelfBootstrapEngine({
        scanner: fakeScanner(),
        ledger: throwing,
        branch: 'log-throw',
        sandbox: fastSandbox(),
        codeGenerator: goodGenerator,
      });
      const res = eng.evolve(friction('logthrow'));
      assert.equal(res.status, 'evolved', 'the pipeline never looks at the journal');
      assert.equal(throwing.calls.length, 4, 'four attempts were made and all four threw');
      assert.deepEqual(eng.history(), [], 'nothing was persisted');
      assert.equal(eng.verifyLedger().ok, true, 'the fake verify still says the empty chain is fine');

      const failing = fakeLedger({
        kinds: { requirement: 'fail', code: 'fail', sandbox: 'fail', hotload: 'fail' },
      });
      const eng2 = new SelfBootstrapEngine({
        scanner: fakeScanner(),
        ledger: failing,
        branch: 'log-fail',
        sandbox: fastSandbox(),
        codeGenerator: goodGenerator,
      });
      const res2 = eng2.evolve(friction('logfail'));
      assert.equal(res2.status, 'evolved');
      assert.equal(Object.prototype.hasOwnProperty.call(res2, 'ledgerOk'), false, 'no write status is surfaced');
      assert.equal(failing.calls.length, 4);
    });

  test('_log returns the {ok:false} double to its caller but nothing consumes it', () => {
    const ledger = fakeLedger({ kinds: { requirement: 'fail' } });
    const eng = new SelfBootstrapEngine({ ledger, branch: 'log-private' });
    assert.deepEqual(eng._log(evoLedger.KIND.REQUIREMENT, { a: 1 }), { ok: false, error: '原子写失败' });
    assert.deepEqual(eng._log(evoLedger.KIND.ALERT, null), { ok: true, seq: 1, hash: 'h2' });
    const exploding = {
      append() {
        throw new Error('journal on fire');
      },
      read: () => [],
      verify: () => ({ ok: true }),
      KIND: evoLedger.KIND,
    };
    const eng2 = new SelfBootstrapEngine({ ledger: exploding });
    assert.deepEqual(eng2._log('requirement', {}), { ok: false }, 'the catch collapses any error into a bare flag');
  });

  test('_halt flattens status, requirement and extras into one object', () => {
    const eng = new SelfBootstrapEngine({ ledger: fakeLedger() });
    assert.deepEqual(eng._halt('s', { id: 'r' }, { reason: 'because', extra: 1 }), {
      status: 's',
      requirement: { id: 'r' },
      reason: 'because',
      extra: 1,
    });
    assert.deepEqual(eng._halt('s2', null, {}), { status: 's2', requirement: null });
  });
});
