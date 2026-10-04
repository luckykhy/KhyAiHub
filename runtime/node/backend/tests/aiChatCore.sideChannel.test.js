'use strict';
/**
 * aiChatCore.sideChannel.test.js — contract for the out-of-band call guard.
 *
 * A verification/evidence probe's answer is parsed internally and never
 * delivered. Such a call must leave the authoritative history untouched;
 * before this guard it appended both its question and its answer, which is how
 * "the same conclusion" ended up in the transcript a second time (and why
 * `khy resume` replays it).
 *
 * Coverage note: `chat()` itself drives model calls / network / timers, so per
 * the leaf-contract suite's stance this test stays on the deterministic surface
 * (the predicate the two history writes are gated on). The producer side — the
 * tool loop marking its probes with `_verificationProbe` and stripping the
 * user-facing sinks — is covered behaviourally by
 * toolUseLoop.oneshotToolBlocks.test.js.
 */
const { isSideChannelCall } = require('../src/cli/aiChatCore');

describe('isSideChannelCall', () => {
  test('recognises verification probes and explicit side-channel calls', () => {
    expect(isSideChannelCall({ _verificationProbe: true })).toBe(true);
    expect(isSideChannelCall({ _sideChannel: true })).toBe(true);
  });

  test('treats ordinary turns — including tool follow-ups — as deliverable', () => {
    expect(isSideChannelCall(undefined)).toBe(false);
    expect(isSideChannelCall({})).toBe(false);
    expect(isSideChannelCall({ _isFollowUp: true })).toBe(false);
    expect(
      isSideChannelCall({
        _isFollowUp: true,
        _structuredToolResultBlocks: [{ type: 'tool_result', tool_use_id: 't1' }],
      })
    ).toBe(false);
    expect(isSideChannelCall({ _verificationProbe: false })).toBe(false);
  });
});
