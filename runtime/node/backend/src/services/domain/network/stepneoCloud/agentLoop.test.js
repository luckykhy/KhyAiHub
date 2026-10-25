'use strict';

/**
 * stepneoCloud/agentLoop.test.js — co-located suite for the tool-calling loop.
 *
 * IO: none. Both collaborators are fakes, so the loop's contract — ordering,
 * refusals, caps, and above all that it adds no policy of its own — is
 * assertable with no phone and no network.
 *
 * The property this suite exists to protect: the loop must not make an actuating
 * call on the model's behalf. The bridge's confirm gate is the only thing
 * standing between a hallucinated tool call and a changed phone.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runAgentTurn, DEFAULT_MAX_ROUNDS } = require('./agentLoop');

function makeUpstream(replies) {
  const seen = [];
  let i = 0;
  return {
    seen,
    async chatCompletion({ messages, tools }) {
      seen.push({ messages: JSON.parse(JSON.stringify(messages)), toolCount: tools.length });
      const reply = replies[Math.min(i, replies.length - 1)];
      i += 1;
      return reply;
    },
  };
}

function textReply(text) {
  return { ok: true, message: { role: 'assistant', content: text } };
}

function toolReply(calls) {
  return {
    ok: true,
    message: {
      role: 'assistant',
      content: '',
      tool_calls: calls.map((c, idx) => ({
        id: `call_${idx}`,
        type: 'function',
        function: { name: c.name, arguments: c.arguments === undefined ? '{}' : c.arguments },
      })),
    },
  };
}

function makeBridge(handler) {
  const calls = [];
  return {
    calls,
    async call(tool, args, opts) {
      calls.push({ tool, args, opts });
      return handler ? handler(tool, args, opts) : { success: true, result: { ok: true } };
    },
  };
}

// ── the happy path ───────────────────────────────────────────────────────────

test('a text-only reply ends the turn and is recorded in the transcript', async () => {
  const upstream = makeUpstream([textReply('完成了')]);
  const bridge = makeBridge();
  const messages = [{ role: 'user', content: '写个游戏' }];

  const out = await runAgentTurn({ upstream, bridge, messages });

  assert.equal(out.ok, true);
  assert.equal(out.message.content, '完成了');
  assert.equal(out.rounds, 1);
  assert.equal(bridge.calls.length, 0);
  assert.equal(messages[messages.length - 1].role, 'assistant');
  assert.equal(messages[messages.length - 1].content, '完成了');
});

test('a tool call is dispatched by BRIDGE name, not schema name', async () => {
  // The model only ever sees khyName (phone_exec). The bridge is called by
  // bridgeName (exec). Sending the schema name straight through is the bug this
  // guards: the bridge would answer "unknown tool" for every call.
  const upstream = makeUpstream([
    toolReply([{ name: 'phone_exec', arguments: '{"cmd":"id"}' }]),
    textReply('uid 是 2000'),
  ]);
  const bridge = makeBridge((tool) => ({ success: true, result: { out: 'uid=2000', tool } }));
  const messages = [{ role: 'user', content: '我是谁' }];

  const out = await runAgentTurn({ upstream, bridge, messages });

  assert.equal(out.ok, true);
  assert.equal(bridge.calls.length, 1);
  assert.equal(bridge.calls[0].tool, 'exec');
  assert.deepEqual(bridge.calls[0].args, { cmd: 'id' });
  assert.deepEqual(out.toolCalls, [{ name: 'exec', ok: true, why: null, code: null, requiresConfirm: false }]);
});

test('the assistant tool-call turn precedes the tool result in the transcript', async () => {
  // The upstream rejects a tool result whose assistant turn is missing, so the
  // order is load-bearing, not cosmetic.
  const upstream = makeUpstream([
    toolReply([{ name: 'phone_ls', arguments: '{"path":"/sdcard"}' }]),
    textReply('列完了'),
  ]);
  const bridge = makeBridge();
  const messages = [{ role: 'user', content: '列一下' }];

  await runAgentTurn({ upstream, bridge, messages });

  // [0] system (injected), [1] user, [2] assistant tool-call turn, [3] tool result.
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[2].role, 'assistant');
  assert.ok(Array.isArray(messages[2].tool_calls));
  assert.equal(messages[3].role, 'tool');
  assert.equal(messages[3].tool_call_id, 'call_0');
});

test('multiple tool calls in one reply all run, in order', async () => {
  const upstream = makeUpstream([
    toolReply([
      { name: 'phone_ls', arguments: '{"path":"/a"}' },
      { name: 'phone_ls', arguments: '{"path":"/b"}' },
    ]),
    textReply('两个都列了'),
  ]);
  const bridge = makeBridge();
  await runAgentTurn({ upstream, bridge, messages: [{ role: 'user', content: 'x' }] });
  assert.deepEqual(bridge.calls.map((c) => c.args.path), ['/a', '/b']);
});

// ── the confirm gate, which this loop must never bypass ──────────────────────

test('the loop NEVER injects confirm:true on the model\'s behalf', async () => {
  // This is the whole safety contract in one assertion. A model that asks for
  // write without confirm gets a refusal from the bridge, and that refusal is
  // what the model has to read and respond to.
  //
  // The fake mirrors the real client's refusal shape exactly — including
  // `requiresConfirm`, which is what the loop uses to tell a confirm-gate
  // refusal apart from a dead bridge. A fake that omitted it would let the loop
  // "work" while the flag it reports was always false.
  const upstream = makeUpstream([
    toolReply([{ name: 'phone_write', arguments: '{"path":"/sdcard/x","content":"hi"}' }]),
    textReply('桥拒绝了，需要确认'),
  ]);
  const bridge = makeBridge(() => ({
    success: false,
    requiresConfirm: true,
    code: 'requires_confirm',
    plan: { bridgeName: 'write', args: { path: '/sdcard/x' } },
    message: '将在手机上执行 write。确认后重发并带 confirm:true 才会真正执行。',
  }));
  const messages = [{ role: 'user', content: '写个文件' }];

  const out = await runAgentTurn({ upstream, bridge, messages });

  assert.equal(bridge.calls.length, 1);
  // The loop passes an explicit false rather than omitting the key: it now
  // always forwards whatever the model said, so "not injected" is spelled
  // `false`. What matters is that it is NOT true — a true here would mean the
  // loop approved an actuation the model never asked for.
  assert.equal(bridge.calls[0].opts.confirm, false);
  assert.ok(!('confirm' in bridge.calls[0].args));
  assert.equal(out.toolCalls[0].name, 'write');
  assert.equal(out.toolCalls[0].ok, false);
  assert.equal(out.toolCalls[0].requiresConfirm, true);
  // The refusal text reaches the model, not just the log. Asserted against the
  // bridge's REAL wording ("确认后重发并带 confirm:true"), not a paraphrase —
  // the point is that the model receives an instruction it can act on.
  const toolMsg = messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /confirm:true/);
  assert.doesNotMatch(toolMsg.content, /桥未返回结果/);
});

test('the confirm refusal reaches the model as the bridge worded it', async () => {
  // THE REGRESSION. The bridge answers a confirm refusal with `message`, not
  // `error` — see phoneBridgeClient._confirmGate(). Reading only `error` sent
  // the model "桥未返回结果", which is not an instruction, so it could never
  // learn to pass confirm. Measured on device: three write attempts, three
  // identical useless refusals.
  const upstream = makeUpstream([
    toolReply([{ name: 'phone_write', arguments: '{"path":"/sdcard/x"}' }]),
    textReply('好，我带上 confirm 再试'),
  ]);
  const bridge = makeBridge(() => ({
    success: false,
    requiresConfirm: true,
    code: 'requires_confirm',
    message: '将在手机上执行 write。确认后重发并带 confirm:true 才会真正执行。',
    plan: { bridgeName: 'write' },
  }));
  const messages = [{ role: 'user', content: '写' }];
  await runAgentTurn({ upstream, bridge, messages });
  const content = messages.find((m) => m.role === 'tool').content;
  assert.match(content, /confirm:true/);
  assert.doesNotMatch(content, /桥未返回结果/);
});

test('a refusal from the bridge is fed back as a tool result, not as an exception', async () => {
  // Throwing here would abort the whole turn on the first declined call.
  const upstream = makeUpstream([
    toolReply([{ name: 'phone_rm', arguments: '{"path":"/sdcard/DCIM","recursive":true}' }]),
    textReply('明白，不删'),
  ]);
  const bridge = makeBridge(() => ({ success: false, code: 'dangerous', error: '需要确认' }));
  const out = await runAgentTurn({ upstream, bridge, messages: [{ role: 'user', content: '删' }] });
  assert.equal(out.ok, true);
  assert.equal(out.toolCalls[0].ok, false);
});

// ── malformed calls ──────────────────────────────────────────────────────────

test('an invented tool name gets the list of real ones', async () => {
  // Same failure shape as the Dart tool engine: a bare "unknown tool" gives a
  // model nothing to correct itself with, and it retries the same string.
  const upstream = makeUpstream([
    toolReply([{ name: 'phone_nuke_everything', arguments: '{}' }]),
    textReply('换一个工具'),
  ]);
  const bridge = makeBridge();
  const messages = [{ role: 'user', content: 'x' }];

  await runAgentTurn({ upstream, bridge, messages });

  const toolMsg = messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /phone_nuke_everything/);
  assert.match(toolMsg.content, /phone_exec/);
  assert.match(toolMsg.content, /不要改用别的叫法/);
  assert.equal(bridge.calls.length, 0);
});

test('unparsable tool arguments are reported back rather than crashing the turn', async () => {
  const upstream = makeUpstream([
    toolReply([{ name: 'phone_exec', arguments: '{not json' }]),
    textReply('重发'),
  ]);
  const bridge = makeBridge();
  const messages = [{ role: 'user', content: 'x' }];

  const out = await runAgentTurn({ upstream, bridge, messages });

  assert.equal(out.ok, true);
  assert.equal(bridge.calls.length, 0);
  assert.match(messages.find((m) => m.role === 'tool').content, /不是合法 JSON/);
});

// ── caps and failures ────────────────────────────────────────────────────────

test('a model that never stops calling tools is capped and reported as such', async () => {
  // Not an error: the work done is real. But it must be distinguishable from a
  // clean finish, or the caller reports success on an unfinished turn.
  const upstream = makeUpstream([toolReply([{ name: 'phone_ls', arguments: '{"path":"/a"}' }])]);
  const bridge = makeBridge();

  const out = await runAgentTurn({ upstream, bridge, messages: [{ role: 'user', content: 'x' }], maxRounds: 3 });

  assert.equal(out.ok, false);
  assert.equal(out.stopped, 'max_rounds');
  assert.equal(out.rounds, 3);
  assert.equal(bridge.calls.length, 3);
  assert.match(out.error, /上限/);
});

test('the default round cap is finite', () => {
  // An infinite default would make a stuck model run until the process died.
  assert.ok(Number.isFinite(DEFAULT_MAX_ROUNDS));
  assert.ok(DEFAULT_MAX_ROUNDS > 0);
});

test('an upstream failure ends the turn with its own reason', async () => {
  const upstream = makeUpstream([{ ok: false, error: 'TPM 限流' }]);
  const bridge = makeBridge();
  const out = await runAgentTurn({ upstream, bridge, messages: [] });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'TPM 限流');
});

test('a missing upstream or bridge is refused instead of throwing', async () => {
  const bridge = makeBridge();
  const a = await runAgentTurn({ bridge, messages: [] });
  assert.equal(a.ok, false);
  assert.match(a.error, /upstream/);
  const upstream = makeUpstream([textReply('x')]);
  const b = await runAgentTurn({ upstream, messages: [] });
  assert.equal(b.ok, false);
  assert.match(b.error, /bridge/);
});

test('the tool list is offered to the upstream on every round', async () => {
  // Dropping it after round one silently removes the model's ability to act.
  const upstream = makeUpstream([
    toolReply([{ name: 'phone_ls', arguments: '{"path":"/a"}' }]),
    toolReply([{ name: 'phone_ls', arguments: '{"path":"/b"}' }]),
    textReply('done'),
  ]);
  const bridge = makeBridge();
  await runAgentTurn({ upstream, bridge, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(upstream.seen.length, 3);
  for (const call of upstream.seen) {
    assert.ok(call.toolCount > 0);
  }
});

test('a confirm the model puts in arguments is translated into the call option', async () => {
  // THE REGRESSION. confirm is a call option on the bridge, but the model's only
  // channel is the arguments object. Left untranslated, validateBridgeArgs
  // rejects it as an unknown arg ("工具 write 不接受参数 confirm"), the model
  // retries without it, hits the confirm gate, and oscillates until it runs out
  // of rounds. Measured on device: exactly that, 7 rounds, 0 successes.
  const upstream = makeUpstream([
    toolReply([{ name: 'phone_write', arguments: '{"path":"/sdcard/x","content":"hi","confirm":true}' }]),
    textReply('写好了'),
  ]);
  let seenOpts = null;
  const bridge = makeBridge((tool, args, opts) => {
    seenOpts = opts;
    // The args the bridge receives must NOT contain confirm, or its own
    // validator refuses the call.
    assert.ok(!('confirm' in args), 'confirm 不能混进 args');
    return { success: true, result: { ok: true } };
  });

  await runAgentTurn({ upstream, bridge, messages: [{ role: 'user', content: '写' }] });

  assert.equal(seenOpts.confirm, true);
});

test('a confirm:false the model sends is not silently upgraded', async () => {
  // Only an explicit true counts. A model that writes confirm:false has said
  // "do not do this", and honouring that is the whole point of the gate.
  let seenOpts = null;
  const upstream = makeUpstream([
    toolReply([{ name: 'phone_write', arguments: '{"path":"/sdcard/x","confirm":false}' }]),
    textReply('好'),
  ]);
  const bridge = makeBridge((t, a, opts) => { seenOpts = opts; return { success: true }; });
  await runAgentTurn({ upstream, bridge, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(seenOpts.confirm, false);
});

test('a system prompt is injected once, and never over an existing one', async () => {
  // THE REGRESSION. Without a system prompt the model answers from its reply
  // text. Measured on device: asked to write a game it began emitting the whole
  // HTML as its reply, exhausted the budget, and returned a 200 with an empty
  // body — because nothing had told it that writing a file is a tool call.
  const upstream = makeUpstream([textReply('done')]);
  const bridge = makeBridge();
  const messages = [{ role: 'user', content: '写个游戏' }];
  await runAgentTurn({ upstream, bridge, messages });
  assert.equal(messages[0].role, 'system');
  assert.equal(messages.filter((m) => m.role === 'system').length, 1);
  assert.match(messages[0].content, /工具才是真正落地动作的地方/);

  // A conversation that already has one keeps it.
  const upstream2 = makeUpstream([textReply('done')]);
  const messages2 = [{ role: 'system', content: '我自己的指令' }, { role: 'user', content: 'x' }];
  await runAgentTurn({ upstream: upstream2, bridge: makeBridge(), messages: messages2 });
  assert.equal(messages2[0].content, '我自己的指令');
  assert.equal(messages2.filter((m) => m.role === 'system').length, 1);
});

test('a caller can replace the system prompt entirely', async () => {
  const upstream = makeUpstream([textReply('ok')]);
  const messages = [{ role: 'user', content: 'x' }];
  await runAgentTurn({
    upstream, bridge: makeBridge(), messages, systemPrompt: '只准用中文',
  });
  assert.equal(messages[0].content, '只准用中文');
});
