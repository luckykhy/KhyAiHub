'use strict';

/**
 * resolveToolCalls — a tools-free turn must never dispatch a call.
 *
 * Regression: during a grace / forced-summary / circuit-breaker closing round
 * (forceNoTools=true), a weak model may still embed a text-style tool call in
 * its plain reply. The terminal directive is authoritative, so the call must be
 * dropped (return []) and the caller notified via onStrayToolCallWhenNoTools so
 * the loop can surface an honest end-of-loop reason.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveToolCalls } = require('../src/services/domain/catalog/toolUseLoop/resolveToolCalls');

const LT = '<';
const GT = '>';
const OPEN = LT + 'tool_call' + GT;
const CLOSE = LT + '/tool_call' + GT;
const STRAY = 'summarizing now ' + OPEN + 'ls' + CLOSE;

function makeDeps(overrides = {}) {
  const breadcrumbCalls = [];
  const strayCalls = [];
  const deps = {
    aiResult: { reply: STRAY, toolUseBlocks: [] },
    normalizedStopReason: 'end_turn',
    isTextProtocol: false,
    activeAdapter: { parseToolCalls: () => [{ name: 'shell', params: {} }] },
    modelLacksNativeTools: false,
    iteration: 9,
    parseToolCalls: (text) => (String(text).includes(OPEN) ? [{ name: 'shell', params: {} }] : []),
    canonicalizeToolCall: (c) => c,
    loopBreadcrumb: (name, meta) => breadcrumbCalls.push({ name, meta }),
    onStrayToolCallWhenNoTools: (info) => strayCalls.push(info),
    ...overrides,
  };
  return { deps, breadcrumbCalls, strayCalls };
}

describe('resolveToolCalls — tools-free turn drops every call', () => {
  test('forceNoTools + stray text call → [] and caller notified', () => {
    const { deps, breadcrumbCalls, strayCalls } = makeDeps({ forceNoTools: true });
    const out = resolveToolCalls(deps);
    assert.deepEqual(out, [], 'no tools-free turn may dispatch a call');
    assert.equal(strayCalls.length, 1, 'stray call must be surfaced to caller');
    assert.ok(strayCalls[0].count >= 1);
    assert.ok(
      breadcrumbCalls.some((b) => b.name === 'tools-free-stray-call-dropped'),
      'breadcrumb must record the dropped stray call'
    );
  });

  test('forceNoTools + plain reply → [] but NOT notified', () => {
    const { deps, strayCalls } = makeDeps({
      forceNoTools: true,
      aiResult: { reply: 'here is the final answer', toolUseBlocks: [] },
    });
    const out = resolveToolCalls(deps);
    assert.deepEqual(out, []);
    assert.equal(strayCalls.length, 0, 'nothing stray should not fire the notice');
  });

  test('forceNoTools + structured blocks → [] and notified with block count', () => {
    const { deps, strayCalls } = makeDeps({
      forceNoTools: true,
      aiResult: { reply: '', toolUseBlocks: [{ name: 'shell', input: {} }] },
    });
    const out = resolveToolCalls(deps);
    assert.deepEqual(out, []);
    assert.equal(strayCalls.length, 1);
    assert.equal(strayCalls[0].count, 1);
  });

  test('control: forceNoTools unset still parses the text call', () => {
    const { deps, strayCalls } = makeDeps({ forceNoTools: false });
    const out = resolveToolCalls(deps);
    assert.equal(out.length, 1, 'normal turn dispatches the parsed call as before');
    assert.equal(strayCalls.length, 0);
  });
});
