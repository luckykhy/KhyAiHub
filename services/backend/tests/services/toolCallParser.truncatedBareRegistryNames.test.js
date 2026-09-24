'use strict';

/**
 * toolCallParser.truncatedBareRegistryNames.test.js — regression for the Format 7
 * truncated BARE tool call name gate.
 *
 * Format 7 recovers a bare call that was cut off before its closing paren, e.g.
 *   websearch(query: "latest news
 * Historically the candidate name had to match a hardcoded 15-tool list, so a
 * truncated call to ANY other enabled tool (registry / custom / MCP) was silently
 * dropped — the same "tool call never executed" family as the function-tag hole.
 * The gate KHY_TOOLCALL_TRUNC_REGISTRY_NAMES (default-on) unions that list with
 * the ENABLED tool registry. OFF must byte-revert to the hardcoded list alone.
 */

const { parseToolCalls } = require('../../src/services/toolCallParser');
const assert = require('node:assert/strict');
const toolNames = require('../../src/services/tool/loop/toolNames');

const HARDCODED =
  /^(bash|shell|read|readfile|write|writefile|edit|editfile|grep|glob|find|ls|websearch|webfetch|search)$/i;

// Pick an enabled registry name that the hardcoded list would MISS, so the test
// exercises the union specifically and stays env-agnostic about tool identity.
function pickRegistryOnlyName() {
  const enabled = toolNames._collectEnabledToolNameSet();
  for (const n of enabled) {
    if (!HARDCODED.test(n)) {
      return n;
    }
  }
  return null;
}

describe('parseToolCalls Format 7 — truncated bare call name gate', () => {
  test('hardcoded-name truncated bare call still recovers (baseline)', () => {
    const calls = parseToolCalls('doomed prose\nwebsearch(query: "latest news');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]._repaired, true);
  });

  test('registry-only name is recovered when the gate is on', () => {
    const name = pickRegistryOnlyName();
    if (!name) {
      // No registry-only tool enabled in this env — nothing to assert; keep green.
      return;
    }
    const text = 'intro line\n' + name + '(query: "abc';
    const prev = process.env.KHY_TOOLCALL_TRUNC_REGISTRY_NAMES;
    process.env.KHY_TOOLCALL_TRUNC_REGISTRY_NAMES = 'on';
    try {
      const calls = parseToolCalls(text);
      assert.ok(calls.length >= 1, 'registry-union gate should recover the truncated call');
      assert.equal(calls[0]._repaired, true);
    } finally {
      if (prev === undefined) delete process.env.KHY_TOOLCALL_TRUNC_REGISTRY_NAMES;
      else process.env.KHY_TOOLCALL_TRUNC_REGISTRY_NAMES = prev;
    }
  });

  test('gate off → byte-revert: registry-only name is NOT recovered', () => {
    const name = pickRegistryOnlyName();
    if (!name) {
      return;
    }
    const text = 'intro line\n' + name + '(query: "abc';
    const prev = process.env.KHY_TOOLCALL_TRUNC_REGISTRY_NAMES;
    process.env.KHY_TOOLCALL_TRUNC_REGISTRY_NAMES = 'off';
    try {
      assert.deepEqual(parseToolCalls(text), []);
    } finally {
      if (prev === undefined) delete process.env.KHY_TOOLCALL_TRUNC_REGISTRY_NAMES;
      else process.env.KHY_TOOLCALL_TRUNC_REGISTRY_NAMES = prev;
    }
  });
});
