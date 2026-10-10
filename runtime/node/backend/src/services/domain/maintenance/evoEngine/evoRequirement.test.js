'use strict';

/**
 * evoRequirement.test.js — co-located suite for the EvoRequirement forging stage (pure leaf).
 *
 * IO: none. evoRequirement needs only node:crypto plus the sibling evoLevels module, so no
 * test in this file can reach the repository. Data homes are still pinned before require so
 * this suite is interchangeable with the IO-bearing suites in the same directory.
 *
 * Defects pinned as CURRENT behaviour (documentation, never approval):
 *   B31-E15  validate() only rejects an L2 requirement whose l2Valid is strictly false.
 *   B31-E16  signatureOf() folds every digit run to '#', so distinct pain points collide.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-evo-req-'));
process.env.KHY_DATA_HOME = path.join(TMP, 'data');
process.env.KHY_PROJECT_DATA_HOME = path.join(TMP, 'project');
process.env.HOME = TMP;
process.env.XDG_CONFIG_HOME = path.join(TMP, 'config');
if (process.platform === 'win32') {
  process.env.USERPROFILE = TMP;
}

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');

const mod = require('./evoRequirement');
const { SIGNALS, signatureOf, forge, validate } = mod;

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('evoRequirement — surface', () => {
  test('module.exports keys are exactly the four documented names', () => {
    assert.deepEqual(Object.keys(mod).sort(), ['SIGNALS', 'forge', 'signatureOf', 'validate']);
  });

  test('SIGNALS is frozen and carries the four 阻力 signal types (防呆: no invented signals)', () => {
    assert.equal(Object.isFrozen(SIGNALS), true);
    assert.deepEqual(SIGNALS, {
      INTERCEPTOR_BLOCK: 'interceptor-block',
      TOOL_FAILURE: 'tool-failure',
      COMPRESSION_LOSS: 'compression-loss',
      CONTEXT_MELTDOWN: 'context-meltdown',
    });
    assert.equal(Object.keys(SIGNALS).length, 4);
  });
});

describe('evoRequirement — signatureOf', () => {
  test('same {signal, surface, painPoint} yields the same id across calls', () => {
    const a = signatureOf({ signal: 'tool-failure', surface: 'read-file', painPoint: 'cannot parse' });
    const b = signatureOf({ signal: 'tool-failure', surface: 'read-file', painPoint: 'cannot parse' });
    assert.equal(a, b);
    assert.match(a, /^evo_[0-9a-f]{16}$/);
  });

  test('any differing field changes the id', () => {
    const base = { signal: 'tool-failure', surface: 'read-file', painPoint: 'cannot parse' };
    const ids = new Set([
      signatureOf(base),
      signatureOf({ ...base, signal: 'interceptor-block' }),
      signatureOf({ ...base, surface: 'write-file' }),
      signatureOf({ ...base, painPoint: 'cannot parse either' }),
    ]);
    assert.equal(ids.size, 4);
  });

  test('the basis is lowercased and missing fields degrade to empty strings', () => {
    assert.equal(
      signatureOf({ signal: 'TOOL-FAILURE', surface: 'Read-File', painPoint: 'Cannot Parse' }),
      signatureOf({ signal: 'tool-failure', surface: 'read-file', painPoint: 'cannot parse' })
    );
    assert.equal(signatureOf({}), signatureOf({ signal: '', surface: '', painPoint: '' }));
  });

  test('signatureOf with no argument at all throws (no default parameter)', () => {
    assert.throws(() => signatureOf(), TypeError);
  });

  test('only the first 400 characters of the normalized basis are hashed', () => {
    const head = 'a'.repeat(400);
    assert.equal(
      signatureOf({ signal: 'tool-failure', surface: '', painPoint: `${head}X` }),
      signatureOf({ signal: 'tool-failure', surface: '', painPoint: `${head}Y` })
    );
  });

  test('DEFECT B31-E16 (current behaviour): digit runs collapse to "#", so genuinely distinct '
    + 'pain points share one signature id — which inflates the branch-fuse counter and makes the '
    + 'frictionBridge dedup drop the second, brand-new pain point', () => {
      const one = signatureOf({ signal: 'tool-failure', surface: 'read-file', painPoint: '第 12 行解析失败' });
      const two = signatureOf({ signal: 'tool-failure', surface: 'read-file', painPoint: '第 13 行解析失败' });
      assert.equal(one, two, 'two different files/lines produce the same pain point id');
      // Same collapse through the public forging API:
      const r1 = forge({
        signal: 'tool-failure',
        painPoint: '第 12 行解析失败',
        attribution: { kind: 'missing-tool', why: '普通病因', surface: 'read-file' },
      });
      const r2 = forge({
        signal: 'tool-failure',
        painPoint: '第 13 行解析失败',
        attribution: { kind: 'missing-tool', why: '普通病因', surface: 'read-file' },
      });
      assert.equal(r1.id, r2.id);
      assert.notEqual(r1.painPoint, r2.painPoint, 'the human-readable pain points differ');
      // Consequence recorded in the contract: EvoTrustBreaker counts these as the SAME branch
      // (evoTrustBreaker.js:86 keys on the id), so 2 unrelated failures fuse one branch.
    });
});

describe('evoRequirement — forge: attribution is the soul', () => {
  test('a missing or blank why throws — 头痛医头 is rejected at the minting gate', () => {
    assert.throws(() => forge({ painPoint: 'p' }), /attribution\.why 必填/);
    assert.throws(() => forge({ painPoint: 'p', attribution: {} }), /attribution\.why 必填/);
    assert.throws(() => forge({ attribution: { why: '   ' } }), /attribution\.why 必填/);
    assert.throws(() => forge(), /attribution\.why 必填/);
    assert.throws(() => forge({ attribution: { why: 0 } }), /attribution\.why 必填/);
  });

  test('an unknown signal silently degrades to tool-failure (never an unknown enum value)', () => {
    assert.equal(forge({ attribution: { why: 'w' }, signal: 'not-a-signal' }).signal, SIGNALS.TOOL_FAILURE);
    assert.equal(forge({ attribution: { why: 'w' }, signal: null }).signal, SIGNALS.TOOL_FAILURE);
    assert.equal(forge({ attribution: { why: 'w' } }).signal, SIGNALS.TOOL_FAILURE);
    for (const s of Object.values(SIGNALS)) {
      assert.equal(forge({ attribution: { why: 'w' }, signal: s }).signal, s);
    }
  });

  test('a fully specified requirement is returned with every documented field populated', () => {
    const r = forge({
      signal: SIGNALS.INTERCEPTOR_BLOCK,
      painPoint: '守卫拦下了合法写入',
      attribution: { kind: 'rule-misfire', why: '规则阈值僵化', surface: 'write-file' },
      impact: '中：同类操作全被拦',
      proposedModules: ['guard'],
      acceptanceCriteria: ['放行该操作'],
    });
    assert.equal(r.id, r.signature);
    assert.equal(r.id, signatureOf({ signal: 'interceptor-block', surface: 'write-file', painPoint: '守卫拦下了合法写入' }));
    assert.equal(r.signal, 'interceptor-block');
    assert.deepEqual(r.attribution, { kind: 'rule-misfire', why: '规则阈值僵化', surface: 'write-file' });
    assert.equal(r.impact, '中：同类操作全被拦');
    assert.deepEqual(r.proposedModules, ['guard']);
    assert.deepEqual(r.acceptanceCriteria, ['放行该操作']);
    assert.equal(validate(r).valid, true);
  });

  test('field defaults and truncations are deterministic', () => {
    const r = forge({
      painPoint: 'x'.repeat(500),
      attribution: { why: 'y'.repeat(900), surface: 'z'.repeat(600) },
      impact: 'i'.repeat(700),
      proposedModules: [{ a: 1 }, 2],
      acceptanceCriteria: [1, 2],
    });
    assert.equal(r.painPoint.length, 300);
    assert.equal(r.attribution.why.length, 500);
    assert.equal(r.attribution.surface.length, 300);
    assert.equal(r.impact.length, 500);
    assert.equal(r.attribution.kind, 'unknown', 'kind defaults to the literal string "unknown"');
    assert.deepEqual(r.proposedModules, ['[object Object]', '2'], 'array entries are String()-mapped');
    assert.deepEqual(r.acceptanceCriteria, ['1', '2']);
  });

  test('painPoint falls back to the attribution surface, then to the literal 未命名痛点', () => {
    assert.equal(forge({ attribution: { why: 'w', surface: '仅面' } }).painPoint, '仅面');
    assert.equal(forge({ attribution: { why: 'w' } }).painPoint, '未命名痛点');
  });

  test('an empty or non-array acceptanceCriteria is replaced by the single default criterion', () => {
    const def = ['解决该痛点且不引入退化'];
    assert.deepEqual(forge({ attribution: { why: 'w' }, acceptanceCriteria: [] }).acceptanceCriteria, def);
    assert.deepEqual(forge({ attribution: { why: 'w' }, acceptanceCriteria: 'nope' }).acceptanceCriteria, def);
    assert.deepEqual(forge({ attribution: { why: 'w' } }).acceptanceCriteria, def);
    // Non-array proposedModules degrades to [] instead of throwing:
    assert.deepEqual(forge({ attribution: { why: 'w' }, proposedModules: 'nope' }).proposedModules, []);
    assert.equal(forge({ attribution: { why: 'w' }, impact: '' }).impact, '未评估');
  });
});

describe('evoRequirement — forge: level wiring (防呆②)', () => {
  test('L0 mints executionLevel L0, 0 validation steps, l2Valid true, and no _l2 field', () => {
    const r = forge({ attribution: { why: '规则误杀了一次合法编辑' } });
    assert.equal(r.level, 'L0');
    assert.equal(r.executionLevel, 'L0');
    assert.equal(r.validationSteps, 0);
    assert.equal(r.l2Valid, true);
    assert.equal('_l2' in r, false);
  });

  test('L1 mints 1 validation step (measured: only order-sensitive Chinese patterns reach L1)', () => {
    const r = forge({ attribution: { why: '缺工具' } });
    assert.equal(r.level, 'L1');
    assert.equal(r.executionLevel, 'L1');
    assert.equal(r.validationSteps, 1);
    assert.equal(r.l2Valid, true);
  });

  test('an L2 requirement is force-downgraded to L0 with 3 steps and carries the plan verdict', () => {
    const r = forge({ attribution: { why: '压缩提取丢失核义' } });
    assert.equal(r.level, 'L2', 'declared tier');
    assert.equal(r.executionLevel, 'L0', '执行级一律强制降级（防呆②）');
    assert.equal(r.validationSteps, 3);
    assert.equal(r.l2Valid, false, 'no architectureDiff/blastRadius supplied');
    assert.equal(r._l2.valid, false);
    assert.deepEqual(r._l2.missing, [
      'architectureDiff(修改前后架构对比)',
      'blastRadius(爆炸半径评估)',
    ]);
    assert.equal(validate(r).valid, false);
    assert.deepEqual(validate(r).missing, ['l2Plan(architectureDiff/blastRadius)']);
  });

  test('a complete l2Plan flips l2Valid and passes validation while staying downgraded', () => {
    const r = forge({
      attribution: { why: '压缩提取丢失核义' },
      l2Plan: { architectureDiff: '压缩管线由单段改为分段记忆', blastRadius: '波及所有长链路任务的记忆完整性' },
    });
    assert.equal(r.l2Valid, true);
    assert.equal(r.executionLevel, 'L0');
    assert.equal(r.validationSteps, 3);
    assert.equal(validate(r).valid, true);
  });

  test('l2Plan is ignored entirely for a non-L2 requirement', () => {
    const r = forge({
      attribution: { why: '规则误杀了一次合法编辑' },
      l2Plan: { architectureDiff: 'x'.repeat(20), blastRadius: 'y'.repeat(20) },
    });
    assert.equal(r.level, 'L0');
    assert.equal('_l2' in r, false);
    assert.equal(r.validationSteps, 0);
  });
});

describe('evoRequirement — validate', () => {
  test('non-objects report a single <all> miss instead of throwing', () => {
    for (const bad of [null, undefined, 'str', 42, true]) {
      assert.deepEqual(validate(bad), { valid: false, missing: ['<all>'] });
    }
    assert.deepEqual(validate({}), {
      valid: false,
      missing: ['id', 'signal', 'attribution.why', 'level'],
    });
  });

  test('each broken element is named, and a forged requirement needs no repair', () => {
    const good = forge({ attribution: { why: '规则误杀' } });
    assert.deepEqual(validate(good), { valid: true, missing: [] });
    assert.deepEqual(validate({ ...good, id: '' }).missing, ['id']);
    assert.deepEqual(validate({ ...good, signal: 'made-up' }).missing, ['signal']);
    assert.deepEqual(validate({ ...good, attribution: { why: '' } }).missing, ['attribution.why']);
    assert.deepEqual(validate({ ...good, attribution: null }).missing, ['attribution.why']);
    assert.deepEqual(validate({ ...good, level: 'L9' }).missing, ['level']);
    assert.equal(validate({ ...good, id: '', signal: 'x', level: 'L3' }).missing.length, 3);
  });

  test('a hand-written L0 requirement is accepted — validation is structural only', () => {
    const hand = {
      id: 'evo_manual',
      signal: 'tool-failure',
      attribution: { why: '手写的归因' },
      level: 'L0',
    };
    assert.deepEqual(validate(hand), { valid: true, missing: [] });
  });

  test('an L2 requirement without the plan is refused (the documented 防呆② behaviour)', () => {
    const hand = {
      id: 'evo_manual_l2',
      signal: 'tool-failure',
      attribution: { why: '手写的归因' },
      level: 'L2',
      l2Valid: false,
    };
    assert.equal(validate(hand).valid, false);
    assert.match(validate(hand).missing[0], /l2Plan/);
  });

  test('DEFECT B31-E15 (current behaviour): the L2 clause is a strict === false test, so an L2 '
    + 'requirement that simply never went through planL2 passes 防呆② — the gate only closes on '
    + 'the value forge() writes, never on its absence', () => {
      const hand = {
        id: 'evo_manual_l2',
        signal: 'tool-failure',
        attribution: { why: '手写的归因' },
        level: 'L2',
      };
      assert.deepEqual(validate(hand), { valid: true, missing: [] }, 'l2Valid undefined ⇒ gate open');
      assert.equal(validate({ ...hand, l2Valid: true }).valid, true);
      assert.equal(validate({ ...hand, l2Valid: undefined }).valid, true);
      assert.equal(validate({ ...hand, l2Valid: null }).valid, true, 'null is not strictly false');
      assert.equal(validate({ ...hand, l2Valid: 0 }).valid, true, '0 is not strictly false');
      // Contrast with the one value that does close the gate:
      assert.equal(validate({ ...hand, l2Valid: false }).valid, false);
      // Consequence: index.js:56 gates the whole pipeline on this predicate, so a caller that
      // builds the requirement object by hand (or a scanner that stops calling planL2) can drive
      // an L2 change with no architectureDiff/blastRadius evidence at all.
    });

  test('validate does not mutate the requirement it inspects', () => {
    const hand = { id: 'evo_x', signal: 'tool-failure', attribution: { why: 'w' }, level: 'L2' };
    const before = JSON.stringify(hand);
    validate(hand);
    assert.equal(JSON.stringify(hand), before);
  });
});
