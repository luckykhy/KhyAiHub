'use strict';

// Regression for hci-audit #44 (decision A, IMPL-RPT-063): single-letter short
// flags used to fall through parseInput into args untouched — 51 handler sites
// reading `options.<letter>` got nothing, so advertised syntax like
// `--dry-run, -n` never worked. Short flags now parse into options; whether one
// takes a VALUE is declared per-command in cli/shortOptionSpec.js (seeded from
// the 2026-09-28 survey of 44 handler read sites); undeclared letters default
// to boolean (conservative: a wrong 'value' would eat a positional).

const { test } = require('node:test');
const assert = require('node:assert');

const { parseInput } = require('../../src/cli/router.js');

test('boolean short flag reaches options (backup -n dry-run)', () => {
  const r = parseInput(['backup', 'prune', '-n']);
  assert.strictEqual(r.subCommand, 'prune');
  assert.strictEqual(r.options.n, true, 'the advertised -n must now be visible to the handler');
  assert.deepStrictEqual(r.args, []);
});

test('boolean short flag never eats the following positional (restore -n <id>)', () => {
  const r = parseInput(['backup', 'restore', '-n', 'b-20260928']);
  assert.strictEqual(r.options.n, true, 'backup declares n as boolean — it must not consume the id');
  assert.deepStrictEqual(r.args, ['b-20260928']);
  assert.strictEqual(r.subCommand, 'restore');
});

test('declared value flag consumes the next token (project tree -d 2)', () => {
  const r = parseInput(['project', 'tree', '-d', '2']);
  assert.strictEqual(r.options.d, '2', 'project declares d as value (depth)');
  assert.ok(!r.args.includes('2'), 'the value must not leak into positional args');
  assert.ok(!r.args.includes('-d'), 'the flag itself must leave args');
});

test('repo log -n 5 takes a value; repo -f stays boolean', () => {
  const withVal = parseInput(['repo', 'log', '-n', '5']);
  assert.strictEqual(withVal.options.n, '5');
  const boolF = parseInput(['repo', 'commit', '-f']);
  assert.strictEqual(boolF.options.f, true);
});

test('negative numbers and multi-letter dash tokens stay positional', () => {
  const r = parseInput(['cmd', '-5', '-xy']);
  assert.deepStrictEqual(r.args, ['-5', '-xy']);
  assert.deepStrictEqual(r.options, {});
});

test('undeclared command: letter defaults to boolean', () => {
  const r = parseInput(['nosuchcmd', '-x']);
  assert.strictEqual(r.options.x, true);
  assert.deepStrictEqual(r.args, []);
});

test('gate KHY_SHORT_OPTION_PARSE=0 restores the legacy byte-for-byte behavior', () => {
  const env = { KHY_SHORT_OPTION_PARSE: '0' };
  const orig = process.env.KHY_SHORT_OPTION_PARSE;
  process.env.KHY_SHORT_OPTION_PARSE = '0';
  try {
    const r = parseInput(['backup', 'prune', '-n']);
    assert.deepStrictEqual(r.options, {});
    assert.deepStrictEqual(r.args, ['-n']);
    assert.ok(env);
  } finally {
    if (orig === undefined) delete process.env.KHY_SHORT_OPTION_PARSE;
    else process.env.KHY_SHORT_OPTION_PARSE = orig;
  }
});

test('long options and the #43 optionValueGuard behavior are unchanged', () => {
  const dry = parseInput(['backup', 'prune', '--dry-run']);
  assert.deepStrictEqual(dry.options, { 'dry-run': true });
  const guard = parseInput(['msg', '--zqxflag', 'platforms']);
  assert.strictEqual(guard.subCommand, 'platforms');
  assert.strictEqual(guard.options.zqxflag, true);
});
