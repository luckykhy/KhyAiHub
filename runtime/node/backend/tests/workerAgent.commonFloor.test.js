'use strict';
/**
 * workerAgent.commonFloor.test.js — the common floor reaching the coordinator
 * worker path (the second injection seam).
 *
 * Locks: (1) applyCommonFloor (constraints.js, single home for the floor text
 * AND its gate/idempotence policy) prepends the floor to a bare prompt;
 * (2) idempotent both ways — prompts already carrying EXECUTION_DISCIPLINE /
 * HARD_PROHIBITIONS (built-in agent defs) or the floor itself get no second
 * copy; (3) KHY_SUBAGENT_COMMON_FLOOR off → byte-identical passthrough;
 * (4) buildWorkerPrompt keeps the legacy composition
 * (role → Task → OUTPUT_CONTRACT) and applies the floor before the role text;
 * (5) gate off → byte-identical to the pre-floor composition (regression lock).
 *
 * Who breaks it red: removing the worker wiring, duplicating the floor, or
 * reordering floor/role/Task.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  SUBAGENT_COMMON_FLOOR,
  EXECUTION_DISCIPLINE,
  HARD_PROHIBITIONS,
  applyCommonFloor,
} = require('../src/agents/constraints');
const { buildWorkerPrompt, OUTPUT_CONTRACT } = require('../src/coordinator/workerAgent');

const BARE_ROLE =
  'You are a worker coding agent. Implement requested changes with edits and validation.';
const TASK = 'close the off-by-one in parser.js';

test('applyCommonFloor 对裸提示词前置地板块（floor→text 顺序）', () => {
  const out = applyCommonFloor(BARE_ROLE, {});
  assert.ok(out.startsWith(SUBAGENT_COMMON_FLOOR), out);
  assert.ok(out.endsWith(BARE_ROLE), out);
  assert.ok(out.includes('\n\n'));
});

test('幂等：含纪律块或禁止块的提示词不注入（双向断言）', () => {
  for (const carrier of [EXECUTION_DISCIPLINE, HARD_PROHIBITIONS]) {
    const out = applyCommonFloor(`${carrier}\n\n${BARE_ROLE}`, {});
    assert.strictEqual(out, `${carrier}\n\n${BARE_ROLE}`);
  }
});

test('自幂等：重复应用不产生双份地板块', () => {
  const once = applyCommonFloor(BARE_ROLE, {});
  const twice = applyCommonFloor(once, {});
  assert.strictEqual(twice, once);
});

test('门控关（0/false/off/no）逐字节不变', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(applyCommonFloor(BARE_ROLE, { KHY_SUBAGENT_COMMON_FLOOR: off }), BARE_ROLE);
  }
});

test('非字符串入参返回空串', () => {
  assert.strictEqual(applyCommonFloor(undefined, {}), '');
  assert.strictEqual(applyCommonFloor(null, {}), '');
});

test('buildWorkerPrompt：裸角色下 floor 在 role 前，Task 节与 OUTPUT_CONTRACT 位置不变', () => {
  const p = buildWorkerPrompt(BARE_ROLE, TASK, OUTPUT_CONTRACT, {});
  assert.ok(p.startsWith(SUBAGENT_COMMON_FLOOR), p);
  assert.ok(p.includes(BARE_ROLE), p);
  assert.ok(p.includes(`\n\nTask:\n${TASK}\n`), p);
  assert.ok(p.endsWith(OUTPUT_CONTRACT), p);
  assert.ok(p.indexOf(SUBAGENT_COMMON_FLOOR) < p.indexOf(BARE_ROLE), p);
});

test('buildWorkerPrompt 门控关 → 与既有拼接式逐字节相等（回归锁）', () => {
  const legacy = `${BARE_ROLE}\n\nTask:\n${TASK}\n${OUTPUT_CONTRACT}`;
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      buildWorkerPrompt(BARE_ROLE, TASK, OUTPUT_CONTRACT, { KHY_SUBAGENT_COMMON_FLOOR: off }),
      legacy
    );
  }
});

test('buildWorkerPrompt 幂等：角色提示词已含既有块时不注地板', () => {
  const p = buildWorkerPrompt(EXECUTION_DISCIPLINE, TASK, OUTPUT_CONTRACT, {});
  assert.ok(!p.includes(SUBAGENT_COMMON_FLOOR), p);
  assert.ok(p.includes(`\n\nTask:\n${TASK}\n`), p);
});
