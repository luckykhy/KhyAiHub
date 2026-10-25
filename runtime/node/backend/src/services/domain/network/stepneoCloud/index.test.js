'use strict';

/**
 * stepneoCloud/index.test.js — co-located suite for the facade.
 *
 * IO: none. The facade's job is wiring and guard rails, so what is asserted is
 * that the required credentials are refused loudly and that the assembled
 * session actually reaches the bridge with bridge names.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createStepneoSession, DEFAULT_MAX_ROUNDS, computeSign, buildHeaders,
  parseAccountToken, decodeToken, readAccountTokenFromDevice,
  buildToolSchemas, createToolNameResolver, runAgentTurn,
  chatCompletion, isEmptyCompletion, classifyStatus,
} = require('./index');

test('the facade re-exports every sibling surface', () => {
  // A consumer that has to reach past the facade is a consumer that will break
  // when this unit is reshaped.
  for (const fn of [
    computeSign, buildHeaders, parseAccountToken, decodeToken,
    readAccountTokenFromDevice, buildToolSchemas, createToolNameResolver,
    runAgentTurn, chatCompletion, isEmptyCompletion, classifyStatus,
  ]) {
    assert.equal(typeof fn, 'function');
  }
  assert.ok(Number.isFinite(DEFAULT_MAX_ROUNDS));
});

// ── credential guards ────────────────────────────────────────────────────────

function validOverrides() {
  return { token: 'tok', deviceId: 'dev', appSecret: 'sec', bridge: { call: async () => ({}) } };
}

test('a missing token, deviceId, appSecret or bridge is refused by name', () => {
  // Named, not generic: "invalid session" sends people grepping for which of the
  // four they forgot.
  assert.throws(() => createStepneoSession({ ...validOverrides(), token: '' }), /token 必填/);
  assert.throws(() => createStepneoSession({ ...validOverrides(), deviceId: '' }), /deviceId 必填/);
  assert.throws(() => createStepneoSession({ ...validOverrides(), appSecret: '' }), /appSecret 必填/);
  assert.throws(() => createStepneoSession({ ...validOverrides(), bridge: null }), /bridge 必填/);
});

test('the appSecret guard names where it must come from', () => {
  // R2: keys only via env, never persisted. The message is the reminder.
  assert.throws(
    () => createStepneoSession({ ...validOverrides(), appSecret: undefined }),
    /环境变量/,
  );
});

// ── the assembled session ────────────────────────────────────────────────────

test('a session runs a turn end to end against a stubbed upstream', async () => {
  const bridgeCalls = [];
  const bridge = {
    calls: bridgeCalls,
    async call(tool, args) { bridgeCalls.push({ tool, args }); return { success: true, result: { ok: true } }; },
  };

  const session = createStepneoSession({
    ...validOverrides(),
    bridge,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '47' }, finish_reason: 'stop' }],
        usage: { total_tokens: 72 },
      }),
    }),
  });

  const messages = [{ role: 'user', content: '回复 47' }];
  const out = await session.run(messages);

  assert.equal(out.ok, true);
  assert.equal(out.message.content, '47');
  assert.equal(bridgeCalls.length, 0);
  assert.equal(messages[messages.length - 1].content, '47');
});

test('the session advertises the bridge tools and maps names back to the bridge', async () => {
  // The end-to-end proof that the khyName -> bridgeName mapping survives the
  // facade. Without it the bridge answers "unknown tool" for every call.
  const bridgeCalls = [];
  const bridge = {
    async call(tool, args) { bridgeCalls.push({ tool, args }); return { success: true, result: { out: 'uid=2000' } }; },
  };

  let callCount = 0;
  const session = createStepneoSession({
    ...validOverrides(),
    bridge,
    fetchImpl: async () => {
      callCount += 1;
      const body = callCount === 1
        ? { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'phone_exec', arguments: '{"cmd":"id"}' } }] }, finish_reason: 'tool_calls' }] }
        : { choices: [{ message: { role: 'assistant', content: 'uid=2000' }, finish_reason: 'stop' }] };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  });

  const out = await session.run([{ role: 'user', content: '我是谁' }]);

  assert.equal(out.ok, true);
  assert.equal(bridgeCalls.length, 1);
  assert.equal(bridgeCalls[0].tool, 'exec');
  assert.deepEqual(bridgeCalls[0].args, { cmd: 'id' });
});

test('the session cap comes from env when set, else the default', () => {
  const base = { ...validOverrides(), fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }) };
  assert.equal(createStepneoSession({ ...base, env: {} }).maxRounds, DEFAULT_MAX_ROUNDS);
  assert.equal(createStepneoSession({ ...base, env: { STEPNEO_MAX_ROUNDS: '5' } }).maxRounds, 5);
  // An explicit argument wins over env, so a caller can narrow one turn without
  // mutating process-wide config.
  assert.equal(createStepneoSession({ ...base, env: { STEPNEO_MAX_ROUNDS: '5' }, maxRounds: 2 }).maxRounds, 2);
});
