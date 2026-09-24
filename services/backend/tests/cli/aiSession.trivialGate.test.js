'use strict';

/**
 * Trivial-greeting session gate (aiSession._isTrivialGreetingSession).
 *
 * Contract:
 *   - a session holding nothing but one greeting exchange never reaches disk;
 *   - the verdict is NARROW — a one-turn real question, a tool-using turn
 *     (assistant content = block array, since buildAssistantContent only returns
 *     a plain string with zero tool_use and zero thinking) and a greeting that
 *     got a real follow-up are all still persisted;
 *   - KHY_SESSION_TRIVIAL_SKIP=0|false|off|no restores the legacy write-everything
 *     behaviour (CANON dialect, same as sessionPersistence's other session gates).
 *
 * Pure predicate only: no fs, no cwd, no sessionPersistence round-trip. The
 * end-to-end matrix (does a skipped turn really write zero artifacts, does the
 * next turn persist the greeting retroactively) is pinned by
 * .khy/feedback/2026-09-27-session-trivial-gate/verify.js.
 */

const test = require('node:test');
const assert = require('node:assert');

const { _isTrivialGreetingSession, _trivialSkipEnabled } = require('../../src/cli/aiSession');

const GREET = { role: 'user', content: '你好' };
const PLAIN = { role: 'assistant', content: '你好！我是 khy OS。' };
const TOOL_USE = {
  role: 'assistant',
  content: [
    { type: 'text', text: '你好！' },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git log' } },
  ],
};
const REAL_Q = { role: 'user', content: '阿富汗在打仗吗？为什么存在战争' };

test('trivial gate: lone greeting exchange is skipped', () => {
  assert.strictEqual(_isTrivialGreetingSession([GREET, PLAIN]), true);
  assert.strictEqual(
    _isTrivialGreetingSession([GREET]),
    false,
    'no assistant reply yet → undecided, stay conservative and record'
  );
  assert.strictEqual(_isTrivialGreetingSession([{ role: 'user', content: 'hi' }, PLAIN]), true);
  assert.strictEqual(_isTrivialGreetingSession([{ role: 'user', content: '你好！' }, PLAIN]), true,
    'punctuation is stripped by isGreeting, the single source');
});

test('trivial gate: a real follow-up un-trivializes the whole session', () => {
  assert.strictEqual(
    _isTrivialGreetingSession([GREET, PLAIN, REAL_Q, { role: 'assistant', content: '是的……' }]),
    false,
    '3rd message onward must persist — the greeting pair rides along'
  );
});

test('trivial gate: narrow on purpose — real one-turn questions still persist', () => {
  assert.strictEqual(_isTrivialGreetingSession([REAL_Q, { role: 'assistant', content: '……' }]), false);
  assert.strictEqual(
    _isTrivialGreetingSession([{ role: 'user', content: '你好，帮我看看最近 10 条提交' }, PLAIN]),
    false,
    'greeting + task is not a greeting'
  );
});

test('trivial gate: a turn that did tool work always persists', () => {
  assert.strictEqual(_isTrivialGreetingSession([GREET, TOOL_USE]), false);
});

test('trivial gate: junk input never throws and never skips', () => {
  for (const bad of [null, undefined, [], 'nope', [{}], [{ role: 'user' }], [{ role: 'assistant', content: '你好' }]]) {
    assert.strictEqual(_isTrivialGreetingSession(bad), false, JSON.stringify(bad));
  }
});

test('trivial gate: kill switch dialect is CANON, default on', () => {
  assert.strictEqual(_trivialSkipEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no', ' OFF ']) {
    assert.strictEqual(_trivialSkipEnabled({ KHY_SESSION_TRIVIAL_SKIP: off }), false, off);
  }
  for (const on of ['1', 'true', 'on', 'yes', 'garbage']) {
    assert.strictEqual(_trivialSkipEnabled({ KHY_SESSION_TRIVIAL_SKIP: on }), true, on);
  }
});
