'use strict';

/**
 * evoLevels.test.js — co-located suite for the L0/L1/L2 escalation lattice (pure leaf).
 *
 * No IO at all in this file: evoLevels is a pure deterministic module, so nothing here can
 * touch the repository. Data homes are still pinned before require, matching the unit-wide
 * isolation convention used by every other suite in this directory.
 *
 * B31-E13 pins the current (fail-open) behaviour of atLeast() — documentation, not approval.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-evo-levels-'));
process.env.KHY_DATA_HOME = path.join(TMP, 'data');
process.env.KHY_PROJECT_DATA_HOME = path.join(TMP, 'project');
process.env.HOME = TMP;
process.env.XDG_CONFIG_HOME = path.join(TMP, 'config');
if (process.platform === 'win32') {
  process.env.USERPROFILE = TMP;
}

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');

const levels = require('./evoLevels');
const {
  LEVELS,
  RANK,
  ALL,
  L2_DOWNGRADE_TO,
  L2_VALIDATION_STEPS,
  isLevel,
  rankOf,
  escalate,
  atLeast,
  classify,
  planL2,
} = levels;

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('evoLevels — surface', () => {
  test('module.exports keys are exactly the eleven documented names', () => {
    assert.deepEqual(Object.keys(levels).sort(), [
      'ALL',
      'L2_DOWNGRADE_TO',
      'L2_VALIDATION_STEPS',
      'LEVELS',
      'RANK',
      'atLeast',
      'classify',
      'escalate',
      'isLevel',
      'planL2',
      'rankOf',
    ]);
  });

  test('LEVELS / RANK / ALL are frozen and mutually consistent', () => {
    assert.equal(Object.isFrozen(LEVELS), true);
    assert.equal(Object.isFrozen(RANK), true);
    assert.equal(Object.isFrozen(ALL), true);
    assert.deepEqual(LEVELS, { L0: 'L0', L1: 'L1', L2: 'L2' });
    assert.deepEqual({ ...RANK }, { L0: 0, L1: 1, L2: 2 });
    assert.deepEqual(ALL, ['L0', 'L1', 'L2']);
  });

  test('the L2 downgrade target is L0 with 3 validation steps, hardcoded (防呆②)', () => {
    assert.equal(L2_DOWNGRADE_TO, 'L0');
    assert.equal(L2_VALIDATION_STEPS, 3);
  });
});

describe('evoLevels — isLevel / rankOf', () => {
  test('isLevel accepts exactly the three declared levels', () => {
    assert.equal(isLevel('L0'), true);
    assert.equal(isLevel('L1'), true);
    assert.equal(isLevel('L2'), true);
    assert.equal(isLevel('L3'), false);
    assert.equal(isLevel(''), false);
    assert.equal(isLevel(undefined), false);
    assert.equal(isLevel(null), false);
    assert.equal(isLevel(0), false);
  });

  test('isLevel does not answer true for inherited Object properties', () => {
    assert.equal(isLevel('constructor'), false);
    assert.equal(isLevel('toString'), false);
    assert.equal(isLevel('__proto__'), false);
  });

  test('rankOf maps known levels to 0/1/2 and EVERYTHING else to the strictest rank 2', () => {
    assert.equal(rankOf('L0'), 0);
    assert.equal(rankOf('L1'), 1);
    assert.equal(rankOf('L2'), 2);
    assert.equal(rankOf('bogus'), 2);
    assert.equal(rankOf(undefined), 2);
    assert.equal(rankOf(null), 2);
  });
});

describe('evoLevels — escalate', () => {
  test('returns the stricter of two known levels, order-independent', () => {
    assert.equal(escalate('L0', 'L2'), 'L2');
    assert.equal(escalate('L2', 'L0'), 'L2');
    assert.equal(escalate('L1', 'L0'), 'L1');
    assert.equal(escalate('L1', 'L2'), 'L2');
    assert.equal(escalate('L0', 'L0'), 'L0');
  });

  test('an unknown operand normalizes up to L2 (fail-safe direction)', () => {
    assert.equal(escalate('bogus', 'L0'), 'L2');
    assert.equal(escalate('L0', 'bogus'), 'L2');
    assert.equal(escalate(undefined, undefined), 'L2');
  });

  test('escalate is commutative and idempotent over the whole lattice', () => {
    for (const a of ['L0', 'L1', 'L2']) {
      assert.equal(escalate(a, a), a);
      for (const b of ['L0', 'L1', 'L2']) {
        assert.equal(escalate(a, b), escalate(b, a), `not commutative for ${a}/${b}`);
        assert.equal(rankOf(escalate(a, b)) >= Math.max(rankOf(a), rankOf(b)), true);
      }
    }
  });
});

describe('evoLevels — atLeast', () => {
  test('known levels compare by rank', () => {
    assert.equal(atLeast('L2', 'L0'), true);
    assert.equal(atLeast('L2', 'L2'), true);
    assert.equal(atLeast('L1', 'L0'), true);
    assert.equal(atLeast('L0', 'L1'), false);
    assert.equal(atLeast('L0', 'L2'), false);
    assert.equal(atLeast('L1', 'L2'), false);
  });

  test('DEFECT B31-E13 (current behaviour): an UNKNOWN level reports "at least L2" — the '
    + 'fail-safe rankOf turns the compliance predicate inside out', () => {
      assert.equal(atLeast('bogus', 'L2'), true, 'a non-level satisfies the strictest requirement');
      assert.equal(atLeast(undefined, 'L2'), true);
      assert.equal(atLeast(null, 'L0'), true);
      // The single external consumer of this predicate is a gate that opens on this value:
      // services/backend/src/services/domain/security/dataSovereignty/conflictQuencher.js:116
      //   if (!evoLevels.atLeast(requirement.level, evoLevels.LEVELS.L1) || level === 'L2') { ... }
      // so a requirement object whose `level` is missing/garbage passes the L1 floor check.
    });

  test('the required side is also fail-safe, so atLeast(x, garbage) is always true', () => {
    assert.equal(atLeast('L0', 'bogus'), false);
    assert.equal(atLeast('L2', 'bogus'), true);
  });
});

describe('evoLevels — classify', () => {
  test('core-flow keywords classify as L2 (Chinese and English alike)', () => {
    assert.equal(classify({ why: '压缩算法系统性缺陷' }), 'L2');
    assert.equal(classify({ why: '网关路由不可用' }), 'L2');
    assert.equal(classify({ why: '需要重构调度器' }), 'L2');
    assert.equal(classify({ why: '元约束彼此冲突' }), 'L2');
    assert.equal(classify({ why: 'the gateway compress path is broken' }), 'L2');
    assert.equal(classify({ why: 'scheduler core loop缺陷' }), 'L2');
  });

  test('capability-hole keywords that the L1 pattern actually recognizes', () => {
    assert.equal(classify({ why: '能力空洞：没有对应工具' }), 'L1');
    assert.equal(classify({ why: 'missing tool for this payload' }), 'L1');
    assert.equal(classify({ why: 'need a new parser' }), 'L1');
    assert.equal(classify({ why: 'new tool required' }), 'L1');
    assert.equal(classify({ why: '缺工具' }), 'L1');
    assert.equal(classify({ why: '未覆盖格式' }), 'L1');
  });

  test('DEFECT B31-E14 (current behaviour): the L1 Chinese patterns are ORDER-SENSITIVE, so the '
    + 'natural wording "缺少解析器" never reaches L1 — the tier is decided by whether some other '
    + 'text happens to put 工具 AFTER 缺', () => {
      assert.equal(classify({ why: '缺少解析器，无法处理新格式' }), 'L0', 'no pattern matches this');
      assert.equal(classify({ why: '缺少解析器' }), 'L0');
      assert.equal(classify({ why: '解析器缺失' }), 'L0');
      // 缺.*工具 needs 工具 to come later in the same blob:
      assert.equal(classify({ why: '缺少解析器，稍后要补一个工具' }), 'L1');
      assert.equal(classify({ why: '工具先行，再补缺少解析器' }), 'L0', 'same words, reversed order');
    });

  test('everything else falls through to L0', () => {
    assert.equal(classify({ why: '边缘 case 未覆盖' }), 'L0');
    assert.equal(classify({ why: '规则误杀了一次合法编辑' }), 'L0');
    assert.equal(classify({}), 'L0');
    assert.equal(classify(), 'L0');
  });

  test('classification reads why + surface + kind together, lowercase', () => {
    assert.equal(classify({ surface: 'COMPRESSOR' }), 'L2');
    assert.equal(classify({ kind: 'MISSING TOOL' }), 'L1');
    assert.equal(classify({ why: 'fine', surface: 'fine', kind: 'fine' }), 'L0');
  });

  test('L2 keywords win over L1 keywords when both are present (upgrade only)', () => {
    assert.equal(classify({ why: '缺少解析器，且压缩网关核心流转有缺陷' }), 'L2');
  });
});

describe('evoLevels — planL2 (防呆② gate)', () => {
  test('missing both fields reports both as missing and stays invalid', () => {
    const bad = planL2({});
    assert.equal(bad.valid, false);
    assert.deepEqual(bad.missing, ['architectureDiff(修改前后架构对比)', 'blastRadius(爆炸半径评估)']);
    assert.match(bad.reason, /L2 缺少必填项/);
  });

  test('whitespace / short values are refused (min length 8 after trim)', () => {
    assert.equal(planL2({ architectureDiff: 'short', blastRadius: 'x'.repeat(8) }).valid, false);
    assert.equal(planL2({ architectureDiff: '   ', blastRadius: 'x'.repeat(8) }).valid, false);
    assert.equal(planL2({ architectureDiff: 'abcdefgh', blastRadius: 'abcdefgh' }).valid, true);
  });

  test('a complete plan is valid AND still force-downgraded to L0 with 3 steps', () => {
    const good = planL2({
      architectureDiff: '压缩管线由单段改为分段记忆',
      blastRadius: '波及所有长链路任务的记忆完整性',
    });
    assert.equal(good.valid, true);
    assert.equal(good.declaredLevel, 'L2');
    assert.equal(good.executionLevel, 'L0', '执行级一律强制降级（防呆②）');
    assert.equal(good.validationSteps, 3);
    assert.match(good.reason, /强制降级为 L0 执行/);
    assert.deepEqual(good.missing, []);
  });

  test('even an INVALID plan reports executionLevel L0 — the downgrade is not conditional', () => {
    const bad = planL2({ architectureDiff: 'no' });
    assert.equal(bad.valid, false);
    assert.equal(bad.executionLevel, L2_DOWNGRADE_TO);
    assert.equal(bad.validationSteps, L2_VALIDATION_STEPS);
  });

  test('planL2 with no argument at all does not throw', () => {
    assert.equal(planL2().valid, false);
    assert.equal(planL2().missing.length, 2);
  });

  test('planL2 never returns a non-L0 level in any field other than declaredLevel', () => {
    for (const plan of [{}, { architectureDiff: 'a'.repeat(9) }, { blastRadius: 'b'.repeat(9) }, {
      architectureDiff: 'a'.repeat(9),
      blastRadius: 'b'.repeat(9),
    }]) {
      const r = planL2(plan);
      assert.equal(r.executionLevel, 'L0');
      assert.equal(r.declaredLevel, 'L2');
    }
  });
});
