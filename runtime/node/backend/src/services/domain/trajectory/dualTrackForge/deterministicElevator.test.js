'use strict';

/**
 * deterministicElevator.test.js — co-located suite for the deterministic elevation track.
 *
 * IO: none — the chain (deterministicElevator → physicalCodes → evoRequirement → evoLevels)
 * is pure; evoRequirement only needs node:crypto. Real dependencies are used so that the
 * documented invariant 「forge 实得级 === intendedLevel」 is checked against the live classifier.
 *
 * Defects pinned as CURRENT behaviour (documentation, never approval):
 *   DE-E1  an empty-string finding falls through `${physical.finding || m.action}`
 *          and the finding text silently becomes the action prescription.
 *   DE-E2  a non-object physical with a truthy `code` property path is only defended
 *          by the leading falsy check; detail.surface wins over toolName without warning.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { DeterministicElevator } = require('./deterministicElevator');
const { PHYSICAL_CODES, mappingFor } = require('./physicalCodes');

const d = new DeterministicElevator();

describe('DeterministicElevator.elevate — 物理异常确定性升维', () => {
  it('缺 code 的入参统一抛「需要带 code」错误', () => {
    assert.throws(() => d.elevate(null), { message: 'DeterministicElevator.elevate: 需要带 code 的 PhysicalException' });
    assert.throws(() => d.elevate(undefined), { message: /需要带 code/ });
    assert.throws(() => d.elevate({}), { message: /需要带 code/ });
    assert.throws(() => d.elevate({ code: '' }), { message: /需要带 code/ });
    assert.throws(() => d.elevate('ERR_SCHEMA_VIOLATION'), { message: /需要带 code/ });
  });

  it('未知物理码抛「未知物理码 + 码值」错误', () => {
    assert.throws(
      () => d.elevate({ code: 'ERR_NOPE' }),
      { message: 'DeterministicElevator.elevate: 未知物理码 ERR_NOPE' }
    );
  });

  it('四个合法物理码全部可升维且 intendedLevel 锁 L1', () => {
    for (const code of Object.values(PHYSICAL_CODES)) {
      const r = d.elevate({ code, finding: 'f' });
      assert.equal(r.code, code);
      assert.equal(r.intendedLevel, 'L1', code);
      assert.equal(r.priority, mappingFor(code).priority, code);
      assert.equal(r.action, mappingFor(code).action, code);
      // documented invariant: forged level === intendedLevel (no classify drift to L2)
      assert.equal(r.requirement.level, r.intendedLevel, code);
      assert.equal(r.requirement.executionLevel, 'L1', code);
      assert.equal(r.requirement.validationSteps, 1, code);
      assert.equal(r.requirement.l2Valid, true, code);
    }
  });

  it('ERR_SCHEMA_VIOLATION 铸造的需求字段逐一对得上映射表', () => {
    const m = mappingFor('ERR_SCHEMA_VIOLATION');
    const r = d.elevate({ code: 'ERR_SCHEMA_VIOLATION', finding: 'bad json' });
    assert.equal(r.finding, 'ERR_SCHEMA_VIOLATION: bad json');
    assert.equal(r.priority, 'Medium');
    const req = r.requirement;
    assert.equal(req.signal, m.signal);
    assert.equal(req.signal, 'tool-failure');
    assert.equal(req.painPoint, 'bad json');
    assert.equal(req.attribution.kind, 'physical-assertion');
    assert.equal(req.attribution.why, m.why);
    assert.equal(req.attribution.surface, 'ERR_SCHEMA_VIOLATION');
    assert.equal(req.impact, '物理断言判定的硬伤（ERR_SCHEMA_VIOLATION）：' + m.action + '。');
    assert.deepEqual(req.proposedModules, m.proposedModules);
    assert.deepEqual(req.acceptanceCriteria, [
      '消除 ERR_SCHEMA_VIOLATION 类硬伤且不引入退化',
      m.action + ' 后同类输入不再触发物理断言',
    ]);
    assert.match(req.id, /^evo_[0-9a-f]{16}$/);
    assert.equal(req.signature, req.id);
  });

  it('surface 取值优先 detail.surface，退而取 detail.toolName，再退取 code', () => {
    const withSurface = d.elevate({ code: 'ERR_TOOL_HALLUCINATION', detail: { surface: 'S', toolName: 'T' } });
    assert.equal(withSurface.requirement.attribution.surface, 'S');
    const withTool = d.elevate({ code: 'ERR_TOOL_HALLUCINATION', detail: { toolName: 'T' } });
    assert.equal(withTool.requirement.attribution.surface, 'T');
    const bare = d.elevate({ code: 'ERR_TOOL_HALLUCINATION' });
    assert.equal(bare.requirement.attribution.surface, 'ERR_TOOL_HALLUCINATION');
  });

  it('同一物理异常重复升维得到同一需求 id（签名稳定，非时间戳）', () => {
    const a = d.elevate({ code: 'ERR_RESOURCE_OVERFLOW', finding: 'ctx blowup' });
    const b = d.elevate({ code: 'ERR_RESOURCE_OVERFLOW', finding: 'ctx blowup' });
    assert.equal(a.requirement.id, b.requirement.id);
    const c = d.elevate({ code: 'ERR_RESOURCE_OVERFLOW', finding: 'ctx blowup 2' });
    assert.notEqual(a.requirement.id, c.requirement.id);
  });

  it('surface 数字被 String() 归一为字符串', () => {
    const r = d.elevate({ code: 'ERR_BEHAVIOR_FORBIDDEN', detail: { surface: 42 } });
    assert.equal(r.requirement.attribution.surface, '42');
  });

  it('KNOWN-DEFECT: DE-E1 finding 传空串被 || 吞掉，静默改用处方文案', () => {
    // measured: { code:'ERR_SCHEMA_VIOLATION', finding:'' } → finding 'ERR_SCHEMA_VIOLATION: <action>'
    // and painPoint also collapses to the code.
    const m = mappingFor('ERR_SCHEMA_VIOLATION');
    const r = d.elevate({ code: 'ERR_SCHEMA_VIOLATION', finding: '' });
    assert.equal(r.finding, `ERR_SCHEMA_VIOLATION: ${m.action}`);
    assert.equal(r.requirement.painPoint, 'ERR_SCHEMA_VIOLATION');
  });

  it('KNOWN-DEFECT: DE-E2 detail 非对象时短路后静默回退 code，不报结构错误', () => {
    // measured: detail: 'oops' (string) → detail.surface undefined → surface falls back to code
    const r = d.elevate({ code: 'ERR_TOOL_HALLUCINATION', finding: 'f', detail: 'oops' });
    assert.equal(r.requirement.attribution.surface, 'ERR_TOOL_HALLUCINATION');
  });
});
