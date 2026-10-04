'use strict';

/**
 * frictionBridge.test.js — co-located suite for the runtime observation seam (thin IO).
 *
 * This is the only module in the unit that the live tool path calls, and it writes: every test
 * therefore pins all four data homes into a fresh mkdtemp directory BEFORE requiring anything,
 * and asserts the resolved ledger path is inside that directory (never under the repository).
 * The real selfHeal diagnostician is used on purpose — this seam has no injection point, so the
 * fail-open construction (B31-E18 in painPointScanner.test.js) is part of what is being pinned.
 *
 * Defects pinned as CURRENT behaviour (documentation, never approval):
 *   B31-E20  the header declares the KHY_EVO_ENGINE gate for this bridge, yet the module reads no
 *            environment variable at all.
 *   B31-E21  the dedup mark is written BEFORE the ledger append and the append result is ignored,
 *            so a failed write is reported as observed and the retry is deduped away.
 *   B31-E19  the `!req` guard in observeFailure is unreachable because the scanner never returns null.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-evo-bridge-'));
process.env.KHY_DATA_HOME = path.join(TMP, 'data');
process.env.KHY_PROJECT_DATA_HOME = path.join(TMP, 'project');
process.env.HOME = TMP;
process.env.XDG_CONFIG_HOME = path.join(TMP, 'config');
if (process.platform === 'win32') {
  process.env.USERPROFILE = TMP;
}

const { describe, test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('./frictionBridge');
const { OBSERVATION_BRANCH, observeFailure, pendingObservations, _resetForTest } = mod;
const evoLedger = require('./evoLedger');
const evoRequirement = require('./evoRequirement');

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

let _seq = 0;
/** A friction surface no other test in this file (or a previous run) can collide with. */
function uniq(label) {
  _seq += 1;
  return `b31-${label}-${process.pid}-${_seq}`;
}

describe('frictionBridge — surface and containment', () => {
  test('module.exports keys are exactly the four documented names', () => {
    assert.deepEqual(Object.keys(mod).sort(), [
      'OBSERVATION_BRANCH',
      '_resetForTest',
      'observeFailure',
      'pendingObservations',
    ]);
    assert.equal(OBSERVATION_BRANCH, 'observations');
  });

  test('CONTAINMENT: the observations ledger resolves inside the pinned temp home', () => {
    const file = evoLedger._file(OBSERVATION_BRANCH);
    assert.equal(file.startsWith(TMP), true, `${file} escaped ${TMP}`);
    assert.equal(file.includes(path.join('khy-os', 'services')), false);
    assert.equal(path.basename(file), `ledger.${OBSERVATION_BRANCH}.json`);
  });

  test('DEFECT B31-E20 (current behaviour): frictionBridge.js:17 announces KHY_EVO_ENGINE as the '
    + 'switch for this seam, but the module reads no environment variable — turning the flag off '
    + 'does not stop a single observation', () => {
      const saved = process.env.KHY_EVO_ENGINE;
      const surface = uniq('gate');
      try {
        process.env.KHY_EVO_ENGINE = 'off';
        const off = observeFailure({ signal: 'tool-failure', surface, error: 'boom' });
        assert.equal(off.observed, true, 'the declared kill switch is not honoured here');
        process.env.KHY_EVO_ENGINE = 'on';
        // Letter suffixes only: signatureOf() folds digit runs to "#" (B31-E16), so a "-2"/"-3"
        // suffix would collide and the dedup set would swallow the observation.
        const on = observeFailure({ signal: 'tool-failure', surface: `${surface}-b`, error: 'boom' });
        assert.equal(on.observed, true);
        assert.equal(on.requirementId !== off.requirementId, true);
        delete process.env.KHY_EVO_ENGINE;
        const bare = observeFailure({ signal: 'tool-failure', surface: `${surface}-c`, error: 'boom' });
        assert.equal(bare.observed, true);
      } finally {
        if (saved === undefined) {
          delete process.env.KHY_EVO_ENGINE;
        } else {
          process.env.KHY_EVO_ENGINE = saved;
        }
      }
      // Enforcement is split across two inconsistent readers outside this unit (toolCalling via
      // capabilityMatrix, learningImprove via a private _envBool helper) and KHY_EVO_ENGINE has no
      // flagRegistry entry — recorded in the manifest contract, not reproducible from here.
    });
});

describe('frictionBridge — observeFailure happy path', () => {
  test('a real tool failure is forged into a requirement and留痕 in the observations branch', () => {
    const before = pendingObservations().length;
    const surface = uniq('happy');
    const r = observeFailure({
      signal: evoRequirement.SIGNALS.TOOL_FAILURE,
      surface,
      error: new Error('工具执行崩溃样例'),
      context: { tool: surface, sessionId: 's-1' },
    });
    assert.equal(r.observed, true);
    assert.equal(typeof r.requirementId, 'string');
    assert.match(r.requirementId, /^evo_[0-9a-f]{16}$/);
    assert.equal(Object.keys(r).sort().join(','), 'level,observed,requirementId');

    const chain = pendingObservations();
    assert.equal(chain.length, before + 1);
    const entry = chain[chain.length - 1];
    assert.equal(entry.kind, evoLedger.KIND.REQUIREMENT);
    assert.equal(entry.payload.source, 'runtime-friction');
    assert.equal(entry.payload.requirementId, r.requirementId);
    assert.equal(entry.payload.surface, surface);
    assert.equal(entry.payload.signal, 'tool-failure');
    assert.equal(typeof entry.payload.painPoint, 'string');
    assert.equal(typeof entry.payload.impact, 'string');
    assert.deepEqual(Object.keys(entry.payload.attribution).sort(), ['kind', 'surface', 'why']);
    assert.equal(typeof entry.hash, 'string');
    assert.equal(entry.version, evoLedger.LEDGER_VERSION);
  });

  test('the recorded id is the stable requirement signature, not a timestamp', () => {
    const surface = uniq('stable');
    const r = observeFailure({ signal: 'interceptor-block', surface, painPoint: '守卫拦下了合法写入' });
    assert.equal(
      r.requirementId,
      evoRequirement.signatureOf({ signal: 'interceptor-block', surface, painPoint: '守卫拦下了合法写入' })
    );
    assert.equal(r.level, 'L0');
  });

  test('every friction shape still produces an observation, including the completely empty one', () => {
    const surface = uniq('shape');
    const shapes = [
      { signal: 'compression-loss', surface },
      { surface: `${surface}-b` },
      { signal: 'not-a-signal', surface: `${surface}-c` },
    ];
    for (const friction of shapes) {
      const r = observeFailure(friction);
      assert.equal(r.observed, true, JSON.stringify(friction.signal));
      assert.equal(typeof r.level, 'string');
    }
  });

  test('DEFECT B31-E19 carry-over (current behaviour): the "no-requirement" exit at '
    + 'frictionBridge.js:84 is unreachable, because PainPointScanner.scan never returns null — '
    + 'even an empty friction is minted as an unusable L2 requirement', () => {
      for (const friction of [undefined, {}, { signal: 'tool-failure' }, { painPoint: '' }, 'string', 0, []]) {
        const r = observeFailure(friction);
        assert.equal(r.reason, undefined, 'the no-requirement branch never fires for any input shape');
        assert.equal(typeof r.requirementId, 'string');
        assert.equal(typeof r.observed, 'boolean');
      }
      const empty = observeFailure({ signal: 'tool-failure', surface: uniq('empty'), painPoint: '运行态 遭遇阻力' });
      assert.equal(empty.level, 'L2', 'B31-E17 rides along with every meaningless friction');
    });

  test('the runtime backlog inherits the B31-E17 mis-escalation: an unclassified tool failure is '
    + 'logged as level L2 while its execution level is the downgraded L0', () => {
      const r = observeFailure({ signal: 'tool-failure', surface: uniq('escalation'), error: 'nothing matches' });
      assert.equal(r.level, 'L2');
      const chain = pendingObservations();
      const entry = chain[chain.length - 1];
      assert.equal(entry.payload.level, 'L2');
      assert.equal(entry.payload.executionLevel, 'L0', '防呆② downgraded it at forge time');
      assert.match(entry.payload.attribution.why, /核心流转/);
    });
});

describe('frictionBridge — bounded dedup', () => {
  test('the same pain point signature留痕 once per process; the repeat reports deduped', () => {
    const surface = uniq('dedup');
    const friction = { signal: 'tool-failure', surface, error: 'boom-dup' };
    const first = observeFailure(friction);
    const before = pendingObservations().length;
    const second = observeFailure(friction);
    assert.equal(first.observed, true);
    assert.deepEqual(second, {
      observed: false,
      deduped: true,
      requirementId: first.requirementId,
      level: first.level,
    });
    assert.equal(pendingObservations().length, before, 'a deduped repeat writes nothing');
  });

  test('distinct pain points are distinct observations', () => {
    const surface = uniq('distinct');
    const a = observeFailure({ signal: 'tool-failure', surface, painPoint: 'first pain' });
    const b = observeFailure({ signal: 'tool-failure', surface, painPoint: 'second pain' });
    assert.equal(a.observed, true);
    assert.equal(b.observed, true);
    assert.notEqual(a.requirementId, b.requirementId);
  });

  test('DEFECT B31-E16 seen from the live seam: two genuinely different pain points that differ '
    + 'only in a digit share one signature, so the second real pain point is dropped as a "repeat"', () => {
      const surface = uniq('digits');
      const a = observeFailure({ signal: 'tool-failure', surface, painPoint: 'offset 12 rejected' });
      const b = observeFailure({ signal: 'tool-failure', surface, painPoint: 'offset 13 rejected' });
      assert.equal(a.observed, true);
      assert.equal(b.observed, false);
      assert.equal(b.deduped, true, 'a new pain point was silently swallowed as a duplicate');
      assert.equal(b.requirementId, a.requirementId);
    });

  test('_resetForTest clears the in-process dedup set but leaves the on-disk chain intact', () => {
    const surface = uniq('reset');
    const first = observeFailure({ signal: 'tool-failure', surface, error: 'boom-reset' });
    assert.equal(first.observed, true);
    const before = pendingObservations().length;
    _resetForTest();
    const again = observeFailure({ signal: 'tool-failure', surface, error: 'boom-reset' });
    assert.equal(again.observed, true, 'the same signature is留痕 a second time after a reset');
    assert.equal(pendingObservations().length, before + 1, 'the reset does not delete ledger evidence');
  });
});

describe('frictionBridge — fail-soft contract', () => {
  test('a friction that cannot even be destructured is swallowed as observe-error', () => {
    assert.deepEqual(observeFailure(null), { observed: false, reason: 'observe-error' });
  });

  test('an error object whose accessors explode still cannot bubble out of the seam', () => {
    const bomb = {
      get message() {
        throw new Error('property access explodes');
      },
    };
    let answer;
    assert.doesNotThrow(() => {
      answer = observeFailure({ signal: 'tool-failure', surface: uniq('bomb'), error: bomb });
    });
    assert.equal(typeof answer.observed, 'boolean', 'the diagnosis died and the seam absorbed it');
    assert.equal(typeof answer.requirementId, 'string');
  });

  test('the seam never blocks the caller: observation results are plain data, not exceptions', () => {
    const results = [
      observeFailure({ signal: 'context-meltdown', surface: uniq('never-throws-a') }),
      observeFailure({ signal: 'interceptor-block', surface: uniq('never-throws-b'), error: '' }),
      observeFailure(null),
    ];
    for (const r of results) {
      assert.equal(typeof r.observed, 'boolean');
      assert.equal(r instanceof Error, false);
    }
  });
});

describe('frictionBridge — the ledger write is not checked (B31-E21)', () => {
  const file = evoLedger._file(OBSERVATION_BRANCH);
  let saved = null;

  beforeEach(() => {
    // Squat the observations path with a directory so every atomic write must fail.
    if (fs.existsSync(file)) {
      saved = fs.readFileSync(file);
      fs.rmSync(file);
    } else {
      saved = null;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(file, { recursive: true });
  });

  test('DEFECT B31-E21 (current behaviour): the dedup mark is set BEFORE the append and the append '
    + 'result is discarded, so a failing write is reported as observed:true and the retry is '
    + 'deduped away — the pain point is lost while the caller is told it was recorded', () => {
      const surface = uniq('squat');
      const friction = { signal: 'tool-failure', surface, painPoint: 'write channel is a directory' };

      // Proof that the write channel really is broken for this branch:
      const direct = evoLedger.append(evoLedger.KIND.REQUIREMENT, { probe: surface }, { branch: OBSERVATION_BRANCH });
      assert.equal(direct.ok, false);
      assert.match(String(direct.error), /原子写失败|EBUSY|EPERM|EISDIR|ENOENT/);

      const first = observeFailure(friction);
      assert.equal(first.observed, true, 'the caller is told the observation was recorded');
      assert.equal(first.deduped, undefined);

      const backlog = pendingObservations();
      assert.equal(backlog.length, 0, 'nothing reached disk; the read path fail-opens to an empty list');

      const retry = observeFailure(friction);
      assert.equal(retry.observed, false);
      assert.equal(retry.deduped, true, 'the retry is swallowed as a duplicate of an observation that never existed');
      assert.equal(retry.requirementId, first.requirementId);
      assert.equal(pendingObservations().length, 0);
    });

  after(() => {
    try {
      fs.rmSync(file, { recursive: true, force: true });
      if (saved) {
        fs.writeFileSync(file, saved);
      }
    } catch {
      /* best-effort */
    }
  });
});

describe('frictionBridge — pendingObservations backlog shape', () => {
  test('the chain is append-only, ordered and hash-verified (防呆⑤ over the runtime backlog)', () => {
    const surface = uniq('chain');
    observeFailure({ signal: 'tool-failure', surface, painPoint: 'first link' });
    observeFailure({ signal: 'tool-failure', surface, painPoint: 'second link' });
    const chain = pendingObservations();
    assert.equal(chain.length >= 2, true);
    const seqs = chain.map((e) => e.seq);
    assert.deepEqual(seqs, seqs.slice().sort((a, b) => a - b), 'seq increases monotonically');
    assert.equal(seqs[0], 0);
    assert.equal(chain[chain.length - 1].payload.painPoint, 'second link');
    assert.deepEqual(evoLedger.verify({ branch: OBSERVATION_BRANCH }), {
      ok: true,
      length: chain.length,
      brokenAt: null,
      reason: null,
    });
  });

  test('pendingObservations always answers an array, and reading is a copy', () => {
    const chain = pendingObservations();
    assert.equal(Array.isArray(chain), true);
    const n = chain.length;
    chain.push({ forged: true });
    assert.equal(pendingObservations().length, n, 'a caller cannot inject into the backlog view');
  });

  test('the observations branch is separate from the engine main branch', () => {
    const obs = evoLedger._file(OBSERVATION_BRANCH);
    const main = evoLedger._file('main');
    assert.notEqual(obs, main);
    assert.equal(obs.startsWith(TMP), true);
    assert.equal(main.startsWith(TMP), true);
  });
});
