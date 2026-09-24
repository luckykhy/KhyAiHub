'use strict';

/**
 * toolCallParser.truncatedMutationRefusal.test.js — regression for T6: a
 * truncation-recovered call whose tool is confirmed MUTATING must not execute
 * invented (salvaged) arguments.
 *
 * max_tokens truncation means the arguments are incomplete. Salvage closes a
 * dangling string / drops a dangling key, which for a read-only tool is harmless
 * (a truncated search query still searches) but for a write/shell tool would run
 * a half-formed mutation — e.g. a cut-off `rm -rf /tm…` executed as-is. T6
 * resolves the tool through name-variants (shell_command → bash) to recover the
 * content-aware read-only verdict and, when mutating, delivers EMPTY params so
 * the tool's own required-field validation surfaces an honest error to the model
 * instead of corrupting state. Gated KHY_TOOLCALL_TRUNC_REFUSE_MUTATION (default
 * on); OFF → byte-revert to executing the salvaged params.
 */

const { parseToolCalls } = require('../../src/services/toolCallParser');
const assert = require('node:assert/strict');

const LT = String.fromCharCode(60);
const FT = LT + 'function=';

describe('parseToolCalls T6 — refuse to execute truncation-recovered mutating calls', () => {
  test('truncated bare shell call with a destructive command is refused (no partial rm)', () => {
    const calls = parseToolCalls('note\nbash(rm -rf /tm');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'shell_command');
    assert.deepEqual(calls[0].params, {}, 'mutating args are NOT fabricated/executed');
    assert.equal(calls[0]._repaired, true);
    assert.equal(calls[0]._truncatedParamsRefused, true);
  });

  test('truncated bare shell call with a read-only command still executes', () => {
    const calls = parseToolCalls('note\nbash(ls -la');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, { command: 'ls -la' });
    assert.ok(!calls[0]._truncatedParamsRefused, 'read-only command is not refused');
  });

  test('truncated write function-tag with invented content is refused', () => {
    const calls = parseToolCalls(FT + 'write_file>{"path":"a.txt","content":"hel');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'writeFile');
    assert.deepEqual(calls[0].params, {});
    assert.equal(calls[0]._truncatedParamsRefused, true);
  });

  test('truncated read function-tag executes (read-only, path closed)', () => {
    const calls = parseToolCalls(FT + 'read_file>{"path":"a.txt');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, { path: 'a.txt' });
    assert.ok(!calls[0]._truncatedParamsRefused);
  });

  test('gate off → byte-revert: salvaged mutating params execute as before', () => {
    const prev = process.env.KHY_TOOLCALL_TRUNC_REFUSE_MUTATION;
    process.env.KHY_TOOLCALL_TRUNC_REFUSE_MUTATION = 'off';
    try {
      const calls = parseToolCalls('x\nbash(rm -rf /tm');
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].params, { command: 'rm -rf /tm' });
      assert.ok(!calls[0]._truncatedParamsRefused, 'gate off never refuses');
    } finally {
      if (prev === undefined) delete process.env.KHY_TOOLCALL_TRUNC_REFUSE_MUTATION;
      else process.env.KHY_TOOLCALL_TRUNC_REFUSE_MUTATION = prev;
    }
  });
});
