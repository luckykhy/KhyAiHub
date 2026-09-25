'use strict';
/**
 * toolUseLoop.oneshotToolBlocks.test.js — repro + contract for the
 * "同一个表格/同一段内容被重复输出多次" defect.
 *
 * Root cause: the per-batch structured tool-result payload
 * (`_structuredToolResultBlocks` / `_assistantToolUseBlocks` /
 * `_assistantThinkingBlocks`) used to be written onto `effectiveChatOpts` — the
 * single options object that EVERY loop iteration spreads into `chat()` — and
 * nothing ever cleared it. So any later iteration that ran no tools (a nudge, a
 * delivery gate, a verification probe) re-sent the previous batch verbatim.
 * `aiChatCore` prefers those structured blocks over the text it is handed, so
 * the intended instruction (the nudge / `[EVIDENCE GATE …]`) was dropped from
 * the model's context, and the model — seeing the same evidence with no new
 * instruction — produced the same answer again. Probes additionally carried the
 * caller's `onChunk`, so that duplicate answer also streamed to the terminal,
 * and it was appended to the authoritative history, which `khy resume` then
 * replays.
 *
 * Contract asserted here: the payload is ONE-SHOT — it rides exactly the
 * chat() call that follows its own tool batch; a tool-free round and an
 * out-of-band probe call carry neither the payload nor user-facing sinks.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-oneshot-blocks-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.KHY_TASK_CAPABILITY_GATE = 'false';
process.env.KHY_EXEC_APPROVAL = 'off';
process.env.KHY_METACONSTRAINT = 'off';
process.env.KHY_SYSCALL_GATEWAY = 'off';
process.env.KHY_VERIFY_NONEDIT_THRESHOLD = '1';

const toolUseLoop = require('../src/services/toolUseLoop');

/** Records every chat() call, then drives one shell batch and a conclusion. */
function makeRecordingChat(seen, conclusion) {
  let calls = 0;
  return async (message, opts) => {
    calls += 1;
    seen.push({ calls, message, opts: opts || {} });
    if (opts && opts._verificationProbe) {
      return {
        reply: JSON.stringify({ verdict: 'FAIL', gaps: ['output not verified'] }),
        stopReason: 'stop',
        provider: 'mock',
      };
    }
    if (calls === 1) {
      return {
        reply: '',
        toolUseBlocks: [
          { type: 'tool_use', id: 'call_oneshot_1', name: 'shellCommand', input: { command: 'echo hi' } },
        ],
        stopReason: 'tool_use',
        provider: 'mock',
      };
    }
    return { reply: conclusion, stopReason: 'stop', provider: 'mock' };
  };
}

const hasStaleBlocks = (call) =>
  call && call.opts && call.opts._structuredToolResultBlocks != null;

describe('toolUseLoop one-shot structured tool-result payload', () => {
  afterEach(() => {
    delete process.env.KHY_VERIFY_NONEDIT;
    process.env.KHY_VERIFY_NONEDIT_THRESHOLD = '1';
  });

  test('the gate-forced round re-sends nothing stale — it delivers the gate text', async () => {
    process.env.KHY_VERIFY_NONEDIT = 'on';
    const seen = [];
    const onChunk = jest.fn();

    await toolUseLoop.runToolUseLoop('run echo and report the result', {
      chat: makeRecordingChat(seen, 'done.'),
      maxIterations: 6,
      sessionId: 'sess-oneshot-gate',
      requestId: 'req-oneshot-gate',
      onControlRequest: async () => true,
      onChunk,
    });

    // Premise: the batch payload rode exactly one round (the one after the batch).
    const batchRound = seen.find((c) => !c.opts._verificationProbe && hasStaleBlocks(c));
    expect(batchRound).toBeDefined();

    // The evidence gate fired and forced another round. That round must carry the
    // gate instruction, not a second copy of the previous tool result.
    const gateRound = seen.find((c) => /EVIDENCE GATE/.test(String(c.message || '')));
    expect(gateRound).toBeDefined();
    expect(hasStaleBlocks(gateRound)).toBe(false);
  }, 120000);

  test('a tool-free probe call carries no payload and no user-facing sinks', async () => {
    process.env.KHY_VERIFY_NONEDIT = 'on';
    const seen = [];
    const onChunk = jest.fn();
    const onStatus = jest.fn();

    await toolUseLoop.runToolUseLoop('run echo and report the result', {
      chat: makeRecordingChat(seen, 'done.'),
      maxIterations: 6,
      sessionId: 'sess-oneshot-probe',
      requestId: 'req-oneshot-probe',
      onControlRequest: async () => true,
      onChunk,
      onStatus,
    });

    const probeCall = seen.find((c) => c.opts._verificationProbe === true);
    expect(probeCall).toBeDefined();
    // A probe's answer is parsed internally and never shown: it must not be able
    // to append a user turn / an assistant answer to the authoritative history,
    // nor to stream prose at the user as if it were a second answer.
    expect(hasStaleBlocks(probeCall)).toBe(false);
    expect(probeCall.opts._followUpTextKind).toBe('instruction');
    expect(typeof probeCall.opts.onChunk).toBe('function');
    expect(probeCall.opts.onChunk).not.toBe(onChunk);
    expect(typeof probeCall.opts.onStatus).toBe('function');
    expect(probeCall.opts.onStatus).not.toBe(onStatus);
    // The probe's sinks are inert: invoking them never reaches the caller.
    probeCall.opts.onChunk({ type: 'text', text: 'probe prose' });
    probeCall.opts.onStatus({ phase: 'request', message: 'probe status' });
    expect(onChunk).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
  }, 60000);

  test('a nudge round (no tool batch) does not re-send the previous batch', async () => {
    process.env.KHY_VERIFY_NONEDIT = 'off'; // isolate the nudge path
    const seen = [];

    await toolUseLoop.runToolUseLoop('run echo and report the result', {
      chat: makeRecordingChat(seen, '我找到了相关页面。让我访问这些页面来获取具体的信息。'),
      maxIterations: 6,
      sessionId: 'sess-oneshot-nudge',
      requestId: 'req-oneshot-nudge',
      onControlRequest: async () => true,
    });

    const batchRound = seen.find((c) => hasStaleBlocks(c));
    expect(batchRound).toBeDefined();

    const nudgeRound = seen.find((c) => /承诺不等于执行/.test(String(c.message || '')));
    expect(nudgeRound).toBeDefined();
    expect(hasStaleBlocks(nudgeRound)).toBe(false);
  }, 120000);
});
