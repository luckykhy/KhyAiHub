'use strict';

/**
 * evoTrustBreaker.test.js — co-located suite for the fuse box (pure state machine).
 *
 * IO: none (evoTrustBreaker.js:18 states it is a state machine; persistence is the engine's
 * job via evoLedger). Data homes are pinned before require anyway to match the unit-wide
 * isolation convention, and because nothing here may create a real ledger file.
 *
 * Defects pinned as CURRENT behaviour (documentation, never approval):
 *   B31-E27  the header promises 直到人工复位, yet no reset/unlock API exists at all.
 *   B31-E28  a patch anomaly counter is never cleared, so rollback re-fires on every later hit.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-evo-breaker-'));
process.env.KHY_DATA_HOME = path.join(TMP, 'data');
process.env.KHY_PROJECT_DATA_HOME = path.join(TMP, 'project');
process.env.HOME = TMP;
process.env.XDG_CONFIG_HOME = path.join(TMP, 'config');
if (process.platform === 'win32') {
  process.env.USERPROFILE = TMP;
}

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('./evoTrustBreaker');
const {
  EvoTrustBreaker,
  PROTECTED_INVARIANTS,
  DEFAULT_BRANCH_FUSE,
  DEFAULT_ENGINE_FUSE,
  DEFAULT_ROLLBACK_ANOMALIES,
} = mod;

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('evoTrustBreaker — surface', () => {
  test('module.exports keys are exactly the five documented names', () => {
    assert.deepEqual(Object.keys(mod).sort(), [
      'DEFAULT_BRANCH_FUSE',
      'DEFAULT_ENGINE_FUSE',
      'DEFAULT_ROLLBACK_ANOMALIES',
      'EvoTrustBreaker',
      'PROTECTED_INVARIANTS',
    ]);
  });

  test('the fuse thresholds are 2 / 2 / 3 and hardcoded (防呆③④ numbers)', () => {
    assert.equal(DEFAULT_BRANCH_FUSE, 2);
    assert.equal(DEFAULT_ENGINE_FUSE, 2);
    assert.equal(DEFAULT_ROLLBACK_ANOMALIES, 3);
  });

  test('PROTECTED_INVARIANTS is frozen and lists the lock modules plus the red-line sources', () => {
    assert.equal(Object.isFrozen(PROTECTED_INVARIANTS), true);
    assert.deepEqual(PROTECTED_INVARIANTS, [
      'evoTrustBreaker',
      'evoLedger',
      'organogenesisSandbox',
      'constraints',
      'constitutionalRedLines',
      'metaplan/trustCircuitBreaker',
    ]);
    assert.throws(() => PROTECTED_INVARIANTS.push('whatever'), TypeError);
  });
});

describe('evoTrustBreaker — construction', () => {
  test('defaults come from the exported constants', () => {
    const b = new EvoTrustBreaker();
    assert.equal(b.branchFuseThreshold, 2);
    assert.equal(b.engineFuseThreshold, 2);
    assert.equal(b.rollbackAnomalyThreshold, 3);
    assert.equal(b.isEngineReadOnly(), false);
    assert.equal(b.isBranchFused('anything'), false);
    assert.deepEqual(b.events(), []);
  });

  test('no argument at all constructs the same default machine', () => {
    assert.equal(new EvoTrustBreaker().engineFuseThreshold, 2);
  });

  test('a valid override is honoured and untouched siblings keep their default', () => {
    const b = new EvoTrustBreaker({ branchFuseThreshold: 5 });
    assert.equal(b.branchFuseThreshold, 5);
    assert.equal(b.engineFuseThreshold, 2);
    assert.equal(b.rollbackAnomalyThreshold, 3);
  });

  test('_posInt refuses zero, negatives, NaN and strings — a lowered fuse cannot be dialed to 0', () => {
    const b = new EvoTrustBreaker({
      branchFuseThreshold: 0,
      engineFuseThreshold: -3,
      rollbackAnomalyThreshold: '9',
    });
    assert.equal(b.branchFuseThreshold, 2);
    assert.equal(b.engineFuseThreshold, 2);
    assert.equal(b.rollbackAnomalyThreshold, 3);
    assert.equal(new EvoTrustBreaker({ branchFuseThreshold: NaN }).branchFuseThreshold, 2);
    assert.equal(new EvoTrustBreaker({ branchFuseThreshold: Infinity }).branchFuseThreshold, 2);
    // A fractional threshold IS accepted, which makes the fuse effectively earlier:
    assert.equal(new EvoTrustBreaker({ branchFuseThreshold: 0.5 }).branchFuseThreshold, 0.5);
    assert.equal(new EvoTrustBreaker({ branchFuseThreshold: 0.5 }).recordSandboxResult('x', false).branchFused, true);
  });
});

describe('evoTrustBreaker — recordSandboxResult: branch fuse (§3.4)', () => {
  test('a pass reports no fuse, no alert and leaves the machine open', () => {
    const b = new EvoTrustBreaker();
    assert.deepEqual(b.recordSandboxResult('p1', true), {
      branchFused: false,
      engineReadOnly: false,
      alert: null,
    });
    assert.deepEqual(b.events(), [{ type: 'sandbox_pass', painpointId: 'p1' }]);
  });

  test('the first failure only counts; the second fuses the branch and raises the alert', () => {
    const b = new EvoTrustBreaker();
    const r1 = b.recordSandboxResult('p1', false);
    assert.equal(r1.branchFused, false);
    assert.equal(r1.alert, null);
    const r2 = b.recordSandboxResult('p1', false);
    assert.equal(r2.branchFused, true);
    assert.equal(b.isBranchFused('p1'), true);
    assert.equal(r2.alert.kind, 'architectural-alert');
    assert.equal(r2.alert.painpointId, 'p1');
    assert.match(r2.alert.message, /连续 2 次补丁均未通过沙箱/);
    assert.match(r2.alert.message, /需人类架构介入/);
  });

  test('a third failure still reports fused but raises no duplicate alert (one alert per branch)', () => {
    const b = new EvoTrustBreaker();
    b.recordSandboxResult('p1', false);
    b.recordSandboxResult('p1', false);
    const r3 = b.recordSandboxResult('p1', false);
    assert.equal(r3.branchFused, true);
    assert.equal(r3.alert, null);
  });

  test('a pass in between resets that branch counter, so 失败-通过-失败 does not fuse', () => {
    const b = new EvoTrustBreaker();
    b.recordSandboxResult('p1', false);
    assert.equal(b.recordSandboxResult('p1', true).branchFused, false);
    assert.equal(b.recordSandboxResult('p1', false).branchFused, false);
    assert.equal(b.recordSandboxResult('p1', false).branchFused, true);
  });

  test('the branch counter is per pain point id, and a missing id is bucketed as "unknown"', () => {
    const b = new EvoTrustBreaker();
    b.recordSandboxResult('a', false);
    assert.equal(b.recordSandboxResult('b', false).branchFused, false, 'first failure for b');
    assert.equal(b.isBranchFused('a'), false);
    assert.equal(b.isBranchFused('b'), false);

    const b2 = new EvoTrustBreaker();
    assert.deepEqual(b2.recordSandboxResult(undefined, false), {
      branchFused: false,
      engineReadOnly: false,
      alert: null,
    });
    assert.equal(b2.isBranchFused('unknown'), false, 'one failure is not yet a fuse');
    b2.recordSandboxResult(undefined, false);
    assert.equal(b2.isBranchFused('unknown'), true);
    assert.equal(
      b2.isBranchFused(undefined),
      false,
      'isBranchFused(String(id)) maps undefined to "undefined", never to the "unknown" bucket'
    );
  });

  test('boundary: `passed` is tested for truthiness, so a non-boolean truthy verdict counts as a pass', () => {
    const b = new EvoTrustBreaker();
    b.recordSandboxResult('x', false);
    // 'false' is a truthy string: the machine resets the consecutive counter on it.
    assert.equal(b.recordSandboxResult('x', 'false').branchFused, false);
    assert.equal(b.recordSandboxResult('x', {}).engineReadOnly, false);
    assert.equal(b.recordSandboxResult('x', false).branchFused, false, 'counter was cleared by the pseudo-pass');
  });
});

describe('evoTrustBreaker — recordSandboxResult: engine read-only lock (防呆④)', () => {
  test('two consecutive failures ACROSS different pain points lock the whole engine', () => {
    const b = new EvoTrustBreaker();
    b.recordSandboxResult('a', false);
    const r = b.recordSandboxResult('b', false);
    assert.equal(r.engineReadOnly, true);
    assert.equal(b.isEngineReadOnly(), true);
    assert.equal(r.branchFused, false, 'neither branch reached its own threshold');
    assert.equal(b.isBranchFused('b'), false);
    assert.deepEqual(b._snapshot(), {
      engineReadOnly: true,
      consecutiveSandboxFailures: 2,
      fusedBranches: [],
    });
  });

  test('the lock event and the failure events are appended in causal order', () => {
    const b = new EvoTrustBreaker();
    b.recordSandboxResult('a', false);
    b.recordSandboxResult('b', false);
    const types = b.events().map((e) => e.type);
    assert.deepEqual(types, ['sandbox_fail', 'sandbox_fail', 'engine_readonly']);
    assert.equal(b.events()[1].consecutive, 2);
    assert.equal(b.events()[1].branchCount, 1);
  });

  test('a single pass between failures clears the consecutive counter (the lock is about 连续)', () => {
    const b = new EvoTrustBreaker();
    b.recordSandboxResult('a', false);
    assert.equal(b.recordSandboxResult('b', true).engineReadOnly, false);
    assert.equal(b.recordSandboxResult('c', false).engineReadOnly, false);
    assert.equal(b.recordSandboxResult('d', false).engineReadOnly, true);
  });

  test('the same pain point fuses its branch and the engine at once (both thresholds are 2)', () => {
    const b = new EvoTrustBreaker();
    b.recordSandboxResult('p', false);
    const r = b.recordSandboxResult('p', false);
    assert.equal(r.branchFused, true);
    assert.equal(r.engineReadOnly, true);
    assert.deepEqual(b._snapshot().fusedBranches, ['p']);
  });

  test('DEFECT B31-E27 (current behaviour): 防呆④ claims the lock holds 直到人工复位, but the class '
    + 'exposes no reset/unlock/clear of any kind — the lock is a process-lifetime flag and the '
    + 'only way back to writable is to restart the host', () => {
      const b = new EvoTrustBreaker();
      b.recordSandboxResult('x', false);
      b.recordSandboxResult('x', false); // 2 hits: branch x fused and the engine locked at once
      assert.equal(b.isEngineReadOnly(), true);
      const api = [
        ...Object.getOwnPropertyNames(EvoTrustBreaker.prototype),
        ...Object.getOwnPropertyNames(EvoTrustBreaker),
        ...Object.keys(b),
      ];
      assert.deepEqual(
        api.filter((n) => /reset|unlock|clear|rearm|release|manual/i.test(n)),
        [],
        'no documented human-reset entry point exists'
      );
      // A long run of clean verdicts never reopens it either:
      for (let i = 0; i < 5; i++) {
        assert.equal(b.recordSandboxResult(`ok-${i}`, true).engineReadOnly, true);
      }
      assert.equal(b.isEngineReadOnly(), true);
      assert.equal(b.isBranchFused('x'), true, 'the branch fuse is likewise permanent in-process');
    });
});

describe('evoTrustBreaker — recordPostLoadOutcome (§3.4 rollback)', () => {
  test('a clean run reports the accumulated count without incrementing it', () => {
    const b = new EvoTrustBreaker();
    assert.deepEqual(b.recordPostLoadOutcome('patch_1', false), { rollback: false, anomalies: 0 });
    assert.deepEqual(b.events(), [{ type: 'patch_ok', patchId: 'patch_1' }]);
  });

  test('the third anomaly triggers rollback; the first two only accumulate', () => {
    const b = new EvoTrustBreaker();
    assert.deepEqual(b.recordPostLoadOutcome('p', true), { rollback: false, anomalies: 1 });
    assert.deepEqual(b.recordPostLoadOutcome('p', true), { rollback: false, anomalies: 2 });
    assert.deepEqual(b.recordPostLoadOutcome('p', true), { rollback: true, anomalies: 3 });
    const types = b.events().map((e) => e.type);
    assert.deepEqual(types, [
      'patch_anomaly',
      'patch_anomaly',
      'patch_anomaly',
      'rollback_triggered',
    ]);
  });

  test('anomalies are counted per patch id', () => {
    const b = new EvoTrustBreaker();
    b.recordPostLoadOutcome('p1', true);
    assert.deepEqual(b.recordPostLoadOutcome('p2', true), { rollback: false, anomalies: 1 });
    assert.deepEqual(b.recordPostLoadOutcome('p1', true), { rollback: false, anomalies: 2 });
  });

  test('a missing patch id is bucketed as "unknown", and a falsy anomaly means clean', () => {
    const b = new EvoTrustBreaker();
    assert.deepEqual(b.recordPostLoadOutcome(undefined, true), { rollback: false, anomalies: 1 });
    assert.equal(b.recordPostLoadOutcome(undefined, true).anomalies, 2);
    assert.equal(b.recordPostLoadOutcome(undefined, true).rollback, true, 'three hits in one bucket');
    assert.deepEqual(b.recordPostLoadOutcome(undefined, false), { rollback: false, anomalies: 3 });
    assert.equal(
      b.events().filter((e) => e.patchId === 'unknown').length,
      5,
      'three patch_anomaly + one rollback_triggered + one patch_ok, all in the "unknown" bucket'
    );
  });

  test('DEFECT B31-E28 (current behaviour): the anomaly counter is never cleared once rollback '
    + 'fires, so every subsequent anomaly re-triggers the rollback signal and the engine appends '
    + 'another rollback record to the immutable ledger each time', () => {
      const b = new EvoTrustBreaker();
      const seq = [
        b.recordPostLoadOutcome('p', true),
        b.recordPostLoadOutcome('p', true),
        b.recordPostLoadOutcome('p', true),
        b.recordPostLoadOutcome('p', true),
        b.recordPostLoadOutcome('p', true),
      ];
      assert.deepEqual(seq.map((r) => [r.rollback, r.anomalies]), [
        [false, 1],
        [false, 2],
        [true, 3],
        [true, 4],
        [true, 5],
      ], 'rollback stays true forever, one trigger per later anomaly');
      // A clean run explicitly does NOT reset the accumulator (see the source comment):
      assert.deepEqual(b.recordPostLoadOutcome('p', false), { rollback: false, anomalies: 5 });
      assert.equal(b.events().filter((e) => e.type === 'rollback_triggered').length, 3);
    });
});

describe('evoTrustBreaker — isProtectedTarget (防呆③)', () => {
  test('exact protected module names are refused', () => {
    for (const name of PROTECTED_INVARIANTS) {
      assert.equal(EvoTrustBreaker.isProtectedTarget(name), true, name);
      assert.equal(
        EvoTrustBreaker.isProtectedTarget(`services/backend/src/.../${name}.js`),
        true,
        `${name} as a path fragment`
      );
    }
  });

  test('unrelated targets are accepted, and empty/undefined input never throws', () => {
    assert.equal(EvoTrustBreaker.isProtectedTarget('parser:weird-format'), false);
    assert.equal(EvoTrustBreaker.isProtectedTarget(''), false);
    assert.equal(EvoTrustBreaker.isProtectedTarget(), false);
    assert.equal(EvoTrustBreaker.isProtectedTarget(null), false);
    assert.equal(EvoTrustBreaker.isProtectedTarget(123), false);
    assert.equal(
      EvoTrustBreaker.isProtectedTarget(['evoLedger']),
      true,
      'String() of a one-element array is the bare name, so array input is matched too'
    );
    assert.equal(EvoTrustBreaker.isProtectedTarget({ toString: () => 'evoLedger:rewrite' }), true);
  });

  test('the matcher is a substring test, so any text merely CONTAINING a fragment is refused', () => {
    assert.equal(EvoTrustBreaker.isProtectedTarget('my-constraints-helper'), true);
    assert.equal(EvoTrustBreaker.isProtectedTarget('const constraintsList = []'), true);
    // This over-breadth is what hostPatcher.js:80 turns into a false constitution violation;
    // pinned as defect B31-E24 in hostPatcher.test.js where the consequence is observable.
  });

  test('isProtectedTarget is a static: instances do not expose it as an instance method', () => {
    const b = new EvoTrustBreaker();
    assert.equal(typeof EvoTrustBreaker.isProtectedTarget, 'function');
    assert.equal(Object.prototype.hasOwnProperty.call(EvoTrustBreaker.prototype, 'isProtectedTarget'), false);
    assert.equal(b.isProtectedTarget, undefined);
  });
});

describe('evoTrustBreaker — read-only views', () => {
  test('events() hands out copies, so a caller cannot rewrite fuse history', () => {
    const b = new EvoTrustBreaker();
    b.recordSandboxResult('p', false);
    const evs = b.events();
    assert.equal(evs.length, 1);
    evs[0].type = 'tampered';
    evs.push({ type: 'injected' });
    assert.equal(b.events().length, 1);
    assert.equal(b.events()[0].type, 'sandbox_fail');
    assert.notEqual(b.events(), evs, 'a fresh array every call');
  });

  test('_snapshot reports the three public fuse facts and nothing mutable', () => {
    const b = new EvoTrustBreaker();
    assert.deepEqual(b._snapshot(), {
      engineReadOnly: false,
      consecutiveSandboxFailures: 0,
      fusedBranches: [],
    });
    b.recordSandboxResult('p', false);
    b.recordSandboxResult('p', false);
    const snap = b._snapshot();
    snap.fusedBranches.push('forged-branch');
    assert.deepEqual(b._snapshot().fusedBranches, ['p'], 'Array.from() decouples the copy');
    assert.equal(b._snapshot().consecutiveSandboxFailures, 2);
  });

  test('the fuse box exposes no setter, so 自生成代码 cannot disarm it by field names alone', () => {
    const b = new EvoTrustBreaker();
    const proto = Object.getOwnPropertyNames(EvoTrustBreaker.prototype);
    assert.deepEqual(proto.sort(), [
      'constructor',
      'events',
      'isBranchFused',
      'isEngineReadOnly',
      'recordPostLoadOutcome',
      'recordSandboxResult',
      '_snapshot',
    ].sort());
    assert.equal(proto.includes('setEngineReadOnly'), false);
  });
});
