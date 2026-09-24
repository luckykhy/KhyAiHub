'use strict';

// Regression for `khy backup <alias>`: the handler's switch supports new/ls/check/clean,
// but the router sub-command table only lists the canonical words and the manifest
// declared no subCommands, so parsed.subCommand stayed empty and
// `String(subCommand || 'create')` silently ran a 116 MB tier-core backup instead of
// the requested read-only verb. Two layers now protect that:
//   1. manifest subCommands — the auto-aligner can route the alias to its branch;
//   2. the create default only accepts a bare call or a real tier name.
// Tests stay in-process on the read-only branches so a regression never writes a backup.

const { test } = require('node:test');
const assert = require('node:assert');

// node:test reports the child process's exit status for the whole file, so a
// handler that legitimately marks a usage error (process.exitCode = 1) would
// turn every case red. capture() records the marking as `exitCode` and restores
// the previous value so the runner itself stays clean.
function capture(fn) {
  const lines = [];
  const orig = console.log;
  const savedExitCode = process.exitCode;
  const restore = () => {
    console.log = orig;
    process.exitCode = savedExitCode;
  };
  console.log = (...a) => lines.push(a.join(' '));
  try {
    return Promise.resolve(fn()).then((result) => {
      const exitCode = process.exitCode;
      restore();
      return { result, out: lines.join('\n'), exitCode };
    })
      .catch((error) => {
        const exitCode = process.exitCode;
        restore();
        return { result: null, out: lines.join('\n'), error, exitCode };
      });
  } catch (err) {
    const exitCode = process.exitCode;
    restore();
    return Promise.resolve({ result: null, out: lines.join('\n'), error: err, exitCode });
  }
}

test('dispatch routes `backup ls` to the listing instead of creating a backup', async () => {
  const reg = require('../../src/cli/commandAutoRegistry');
  const { result, out, error, exitCode } = await capture(() =>
    reg.dispatch('backup', { parsed: { command: 'backup', subCommand: null, args: ['ls'], options: {} } }));
  assert.ok(!error, `dispatch threw: ${error && error.message}`);
  assert.ok(result && result.handled === true, 'backup is no longer handled by the auto registry');
  assert.ok(!out.includes('创建备份'), `khy backup ls created a backup again:\n${out}`);
  assert.ok(out.includes('备份根'), `khy backup ls lost its listing output:\n${out}`);
  assert.ok(!exitCode, `the read-only listing marked the process failed: ${exitCode}`);
});

test('an unknown token never reaches the create default', async () => {
  const { handleBackupCommand } = require('../../src/cli/handlers/backup');
  const cases = ['lst', 'checkk', 'deleeet', 'buckup'];
  for (const token of cases) {
    const { out, exitCode } = await capture(() => handleBackupCommand(null, [token], {}));
    assert.ok(out.includes(`未知子命令:backup ${token}`),
      `khy backup ${token} produced no 未知子命令 report:\n${out}`);
    assert.ok(!out.includes('创建备份'),
      `khy backup ${token} silently fell through to create:\n${out}`);
    assert.strictEqual(exitCode, 1,
      `khy backup ${token} printed a usage error but exited 0`);
  }
});

test('manifest declares the aliases the switch itself handles', () => {
  const reg = require('../../src/cli/commandAutoRegistry');
  const entry = reg.getCompletions().find((c) => c.name === 'backup');
  assert.ok(entry, 'backup disappeared from the registry completions');
  for (const alias of ['new', 'ls', 'check', 'clean']) {
    assert.ok(entry.subCommands.includes(alias),
      `backup manifest lost alias "${alias}" — it would collapse onto create again`);
  }
});
