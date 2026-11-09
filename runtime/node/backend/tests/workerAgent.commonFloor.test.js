'use strict';
/**
 * workerAgent.commonFloor.test.js — the common floor AND the execution-scope
 * rule reaching the coordinator worker path (the second injection seam).
 *
 * Locks: (1) applyCommonFloor (constraints.js, single home for the floor text
 * AND its gate/idempotence policy) prepends the floor to a bare prompt;
 * (2) idempotent both ways — prompts already carrying EXECUTION_DISCIPLINE /
 * HARD_PROHIBITIONS (built-in agent defs) or the floor itself get no second
 * copy; (3) KHY_SUBAGENT_COMMON_FLOOR off → byte-identical fallback;
 * (4) buildWorkerPrompt composes scope → floor → role → Task → OUTPUT_CONTRACT,
 * matching AgentTool.buildSubagentSystemPrompt's scope → floor → role order;
 * (5) gate off → byte-identical to the scope-only composition (regression lock);
 * (6) the process-mode seam hands the child the same composed prompt.
 *
 * Who breaks it red: removing the worker wiring, duplicating the floor or the
 * scope text, reordering scope/floor/role/Task, or letting the process path
 * send a bare task.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  SUBAGENT_COMMON_FLOOR,
  SUBAGENT_EXECUTION_SCOPE,
  EXECUTION_DISCIPLINE,
  HARD_PROHIBITIONS,
  applyCommonFloor,
} = require('../src/agents/constraints');
const {
  buildWorkerPrompt,
  spawnWorker,
  shutdownWorker,
  OUTPUT_CONTRACT,
} = require('../src/coordinator/workerAgent');

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

test('buildWorkerPrompt：scope 在最前、floor 在 role 前，Task 节与 OUTPUT_CONTRACT 位置不变', () => {
  const p = buildWorkerPrompt(BARE_ROLE, TASK, OUTPUT_CONTRACT, {});
  assert.ok(p.startsWith(SUBAGENT_EXECUTION_SCOPE), p);
  assert.ok(p.includes(SUBAGENT_COMMON_FLOOR), p);
  assert.ok(p.includes(BARE_ROLE), p);
  assert.ok(p.includes(`\n\nTask:\n${TASK}\n`), p);
  assert.ok(p.endsWith(OUTPUT_CONTRACT), p);
  assert.ok(p.indexOf(SUBAGENT_EXECUTION_SCOPE) < p.indexOf(SUBAGENT_COMMON_FLOOR), p);
  assert.ok(p.indexOf(SUBAGENT_COMMON_FLOOR) < p.indexOf(BARE_ROLE), p);
});

test('buildWorkerPrompt 门控关 → 与 scope-only 拼接口逐字节相等（回归锁）', () => {
  // Mirrors AgentTool.buildSubagentSystemPrompt's gate-off lock: the floor is
  // gated, the scope rule is not.
  const expected = `${SUBAGENT_EXECUTION_SCOPE}\n\n${BARE_ROLE}\n\nTask:\n${TASK}\n${OUTPUT_CONTRACT}`;
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      buildWorkerPrompt(BARE_ROLE, TASK, OUTPUT_CONTRACT, { KHY_SUBAGENT_COMMON_FLOOR: off }),
      expected
    );
  }
});

test('buildWorkerPrompt 幂等：角色提示词已含既有块时不注地板', () => {
  const p = buildWorkerPrompt(EXECUTION_DISCIPLINE, TASK, OUTPUT_CONTRACT, {});
  assert.ok(!p.includes(SUBAGENT_COMMON_FLOOR), p);
  assert.ok(p.includes(`\n\nTask:\n${TASK}\n`), p);
});

test('process 模式：交给子进程的 prompt 与进程内路径同一组装（scope+floor+role+task）', async () => {
  // Stub ./processAgent through the require cache so the TASK prompt handed to
  // the child can be captured without forking a real process.
  const path = require('node:path');
  const procAgentPath = path.join(__dirname, '..', 'src', 'coordinator', 'processAgent.js');
  let captured = null;
  const stub = {
    id: 'pa-test',
    role: 'coder',
    run: async () => ({ status: 'completed', result: '' }),
    kill() {},
  };
  class StubProcessAgent {
    constructor(task) {
      captured = task;
      return stub;
    }
  }
  require.cache[require.resolve(procAgentPath)] = {
    id: procAgentPath,
    filename: procAgentPath,
    loaded: true,
    exports: { ProcessAgent: StubProcessAgent },
  };
  try {
    const worker = await spawnWorker(TASK, { role: 'coder', processMode: true });
    await new Promise((r) => setImmediate(r));
    shutdownWorker(worker.id);
  } finally {
    delete require.cache[require.resolve(procAgentPath)];
  }
  assert.ok(captured && captured.startsWith(SUBAGENT_EXECUTION_SCOPE), String(captured));
  assert.ok(captured.includes(SUBAGENT_COMMON_FLOOR), String(captured));
  assert.ok(captured.includes(`\n\nTask:\n${TASK}\n`), String(captured));
  assert.ok(captured.endsWith(OUTPUT_CONTRACT), String(captured));
});
