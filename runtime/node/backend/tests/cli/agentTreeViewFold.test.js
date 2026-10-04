'use strict';

/**
 * [DESIGN-FOLD-001] §3 — agent_output → bounded full-prose buffer for the
 * sub-task peek screen (子任务副屏). Pins the accumulation contract that the
 * peek screen's honesty (tail-cap + dropped count) depends on.
 * (node:test style — runnable via `node --test` without jest installed.)
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  STATUS,
  makeAgentState,
  applyProgressEvent,
  accumulateAgentOutput,
  OUTPUT_LINES_CAP,
} = require('../../src/cli/agentTreeView');

test('accumulateAgentOutput: splits deltas on newlines and holds the unterminated tail', () => {
  let st = accumulateAgentOutput({}, 'alpha\nbe');
  assert.deepStrictEqual(st.outputLines, ['alpha']);
  assert.strictEqual(st.outputTail, 'be');
  st = accumulateAgentOutput(st, 'ta\ngamma\n');
  assert.deepStrictEqual(st.outputLines, ['alpha', 'beta', 'gamma']);
  assert.strictEqual(st.outputTail, '');
});

test('accumulateAgentOutput: pure — never mutates the input state', () => {
  const prev = { outputLines: ['a'], outputTail: 'b', outputDropped: 0 };
  const next = accumulateAgentOutput(prev, 'c\n');
  assert.deepStrictEqual(prev, { outputLines: ['a'], outputTail: 'b', outputDropped: 0 });
  assert.deepStrictEqual(next.outputLines, ['a', 'bc']);
});

test('accumulateAgentOutput: caps at OUTPUT_LINES_CAP keeping the TAIL, counts dropped honestly', () => {
  let st = { outputLines: [], outputTail: '', outputDropped: 0 };
  for (let i = 0; i < OUTPUT_LINES_CAP + 25; i++) {
    st = accumulateAgentOutput(st, `line-${i}\n`);
  }
  assert.strictEqual(st.outputLines.length, OUTPUT_LINES_CAP);
  assert.strictEqual(st.outputLines[0], 'line-25');
  assert.strictEqual(st.outputDropped, 25);
});

test('accumulateAgentOutput: hostile input never throws; empty delta ignored', () => {
  assert.doesNotThrow(() => accumulateAgentOutput(null, null));
  assert.doesNotThrow(() => accumulateAgentOutput({}, 42));
  assert.deepStrictEqual(accumulateAgentOutput({}, '').outputLines, []);
});

test('applyProgressEvent: agent_output accumulates only while running; buffer SURVIVES completion', () => {
  let a = makeAgentState({ name: 'A' });
  a = applyProgressEvent(a, { type: 'agent_output', text: 'hello\nworld\n' });
  assert.deepStrictEqual(a.outputLines, ['hello', 'world']);
  a = applyProgressEvent(a, { type: 'agent_completed', elapsed: 100 });
  assert.strictEqual(a.status, STATUS.COMPLETED);
  // The peek screen must still show what the agent said after it finished.
  assert.deepStrictEqual(a.outputLines, ['hello', 'world']);
  // Post-terminal deltas never resurrect/append (same guard as agent_text).
  const frozen = a;
  a = applyProgressEvent(a, { type: 'agent_output', text: 'x\n' });
  assert.strictEqual(a.outputLines, frozen.outputLines);
});
