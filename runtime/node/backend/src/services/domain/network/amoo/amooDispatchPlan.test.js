'use strict';

// Co-located unit test for amooDispatchPlan.js.
//
// The plan leaf is what makes an actuation reviewable: the runner renders it
// when `confirm` is missing, so a caller sees every adb command before anything
// touches the phone. The cases pin the waiting strategy (capped backoff, round
// cap, deadline, stability rule) because a silent change there either burns the
// phone's battery or declares a timeout to be an answer.

const test = require('node:test').test;
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

function pinSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-amoo-plan-'));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.KHY_DATA_HOME = path.join(root, 'data');
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('KHY_AMOO_')) {
      delete process.env[key];
    }
  }
  return root;
}

pinSandbox();

const { resolveAmooConfig } = require('./amooBridgeConfig');
const {
  chooseInputRoute,
  nextPollDelay,
  computePollDeadlineMs,
  shouldStopPolling,
  buildDispatchPlan,
  renderDispatchPlan,
  truncateForResult,
} = require('./amooDispatchPlan');

const CONFIG = resolveAmooConfig({});

test('chooseInputRoute sends CJK through the clipboard and ASCII through input text', () => {
  assert.equal(chooseInputRoute('帮我查一下日程').route, 'clipboard');
  assert.equal(chooseInputRoute('帮我查一下日程').reason, 'payload_has_non_ascii');
  assert.equal(chooseInputRoute('check the calendar').route, 'adb-input-text');
  assert.equal(chooseInputRoute('check the calendar').reason, 'payload_is_ascii');
  assert.equal(chooseInputRoute('').route, 'adb-input-text');
  assert.equal(chooseInputRoute('   ').reason, 'payload_empty');
  assert.equal(chooseInputRoute(undefined).reason, 'payload_empty');
  // Tabs and newlines are ASCII and stay on the input text route.
  assert.equal(chooseInputRoute('a\tb\nc').route, 'adb-input-text');
});

test('nextPollDelay rises in steps and is capped', () => {
  assert.equal(nextPollDelay(1, 3000, 8000), 3000);
  assert.equal(nextPollDelay(5, 3000, 8000), 3000);
  assert.equal(nextPollDelay(6, 3000, 8000), 6000);
  // The step is visible when the cap allows it, and invisible when it does not.
  assert.equal(nextPollDelay(11, 3000, 20000), 9000);
  assert.equal(nextPollDelay(11, 3000, 8000), 8000);
  assert.equal(nextPollDelay(12, 3000, 8000), 8000);
  assert.equal(nextPollDelay(999, 3000, 8000), 8000);
  // Degenerate inputs clamp instead of producing 0 or negative delays: a
  // non-positive base means "not given" and falls back to the documented
  // default, while a positive base below the floor is raised to it.
  assert.equal(nextPollDelay(0, 0, 0), 3000);
  assert.equal(nextPollDelay(1, -5, -5), 3000);
  assert.equal(nextPollDelay(1, 100, 100), 250);
  assert.equal(nextPollDelay(undefined, undefined, undefined), 3000);
});

test('computePollDeadlineMs is bounded and consistent with the round cap', () => {
  const deadline = computePollDeadlineMs(3000, 40);
  assert.ok(deadline >= 3000);
  assert.ok(deadline <= 600000);
  // Fewer rounds must not produce a longer deadline.
  assert.ok(computePollDeadlineMs(3000, 5) <= deadline);
  assert.equal(computePollDeadlineMs(3000, 1), 3000);
  // A hostile env cannot push the deadline past the cap.
  assert.equal(computePollDeadlineMs(3000, 500), 600000);
});

test('shouldStopPolling reports WHICH condition fired', () => {
  assert.equal(shouldStopPolling({ round: 40, maxRounds: 40 }).reason, 'round_cap_reached');
  assert.equal(
    shouldStopPolling({ round: 3, maxRounds: 40, elapsedMs: 90000, deadlineMs: 90000 }).reason,
    'deadline_reached'
  );
  assert.equal(
    shouldStopPolling({ round: 3, maxRounds: 40, stability: { stable: true, reason: 'text_stable' } }).reason,
    'reply_stable_text_stable'
  );
  const keep = shouldStopPolling({ round: 3, maxRounds: 40, elapsedMs: 1000, deadlineMs: 90000, stability: { stable: false } });
  assert.equal(keep.stop, false);
  assert.equal(keep.reason, null);
  // Round cap beats an unstable reply: we never wait forever.
  assert.equal(
    shouldStopPolling({ round: 40, maxRounds: 40, stability: { stable: true } }).reason,
    'round_cap_reached'
  );
});

test('buildDispatchPlan orders the steps and carries the strategy', () => {
  const plan = buildDispatchPlan({ taskText: '帮我查一下日程', config: CONFIG });
  assert.equal(plan.inputRoute, 'clipboard');
  assert.equal(plan.taskChars, '帮我查一下日程'.length);
  assert.equal(plan.channel, 'http');
  assert.deepEqual(
    plan.steps.map((step) => step.id),
    [
      'ensure-device',
      'ensure-forward',
      'bridge-ping',
      'launch-amoo',
      'focus-input',
      'fill-text',
      'verify-input',
      'tap-send',
      'poll-reply',
      'collect-reply',
    ]
  );
  assert.equal(plan.poll.maxRounds, CONFIG.dispatch.pollMaxRounds);
  assert.equal(plan.poll.stableRounds, CONFIG.dispatch.replyStableRounds);
  assert.equal(plan.poll.intervalMs, CONFIG.dispatch.pollIntervalMs);
  assert.ok(plan.poll.deadlineMs > 0);
  // ASCII text takes the input text route.
  const ascii = buildDispatchPlan({ taskText: 'ping', config: CONFIG });
  assert.equal(ascii.inputRoute, 'adb-input-text');
  assert.equal(ascii.steps.find((step) => step.id === 'fill-text').detail.includes('input text'), true);
});

test('buildDispatchPlan honours an explicit mailbox channel', () => {
  const plan = buildDispatchPlan({ taskText: 'x', config: CONFIG, channel: 'mailbox' });
  assert.equal(plan.channel, 'mailbox');
  // No forward is needed for the mailbox, and the plan must not claim one.
  assert.equal(plan.steps.find((step) => step.id === 'ensure-forward'), undefined);
  assert.deepEqual(plan.steps.map((step) => step.id)[0], 'ensure-device');
  assert.deepEqual(plan.steps.map((step) => step.id)[1], 'bridge-ping');
  // The HTTP plan still carries both forward steps.
  const http = buildDispatchPlan({ taskText: 'x', config: CONFIG, channel: 'http' });
  assert.ok(http.steps.find((step) => step.id === 'ensure-forward'));
});

test('renderDispatchPlan is Chinese, numbered and mentions the wait strategy', () => {
  const plan = buildDispatchPlan({ taskText: '帮我查一下日程', config: CONFIG });
  const lines = renderDispatchPlan(plan);
  assert.ok(lines.length > 10);
  assert.match(lines[0], /下发通道/);
  assert.match(lines[2], /等待策略/);
  assert.match(lines[2], /最多 40 轮/);
  assert.match(lines[3], /步骤：/);
  assert.match(lines[4], /^ {2}1\. \[adb\]/);
  // Every step is rendered, not just the first few.
  assert.equal(lines.filter((line) => /^ {2}\d+\. /.test(line)).length, plan.steps.length);
});

test('truncateForResult marks the cut instead of silently dropping text', () => {
  const short = truncateForResult('abc', 10);
  assert.equal(short.truncated, false);
  assert.equal(short.text, 'abc');
  // A cap below the 50-char floor is raised to the floor, and the message says
  // the real number rather than the requested one.
  const floored = truncateForResult('x'.repeat(100), 10);
  assert.equal(floored.truncated, true);
  assert.equal(floored.originalChars, 100);
  assert.match(floored.text, /已截断，原文 100 字，保留前 50 字/);
  const cut = truncateForResult('x'.repeat(100), 60);
  assert.match(cut.text, /已截断，原文 100 字，保留前 60 字/);
  assert.equal(truncateForResult(undefined, 10).text, '');
  // A cap of 0 means "the smallest allowed", not "keep everything".
  assert.equal(truncateForResult('x'.repeat(100), 0).truncated, true);
  assert.match(truncateForResult('x'.repeat(100), 0).text, /保留前 50 字/);
  assert.equal(truncateForResult('x'.repeat(100), undefined).truncated, false);
});
