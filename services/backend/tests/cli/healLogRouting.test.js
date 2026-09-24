'use strict';

// Regression for `khy heal log`: the handler had a working audit-log branch, but
// its manifest declared no subCommands, so parseInput never filled parsed.subCommand
// and the command silently ran the default dry-run体检 — identical to bare `khy heal`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test } = require('node:test');
const assert = require('node:assert');

const BIN = path.resolve(__dirname, '../../bin/khy.js');
// Output markers of the default (体检) branch, which must NOT appear for `log`.
const DEFAULT_BRANCH_MARKS = ['跳过自愈', 'dry-run', 'KHY_SOURCE_HEAL'];

function run(args, tmpHome) {
  const env = {};
  for (const key of Object.keys(process.env)) {
    if (/^(PATH|PATHEXT|COMSPEC|SYSTEMROOT|SYSTEMDRIVE|WINDIR|TEMP|TMP|TMPDIR|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|LANG|LC_ALL|TERM|NODE_ENV|CI)$/i.test(key)) {
      env[key] = process.env[key];
    }
  }
  env.HOME = tmpHome;
  if (process.platform === 'win32') env.USERPROFILE = tmpHome;
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env,
    timeout: 40000,
  });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

test('manifest declares heal/log in the router sub-command table', () => {
  const table = require('../../src/constants/commandSchema').getRouterSubCommands();
  assert.ok(Array.isArray(table.heal),
    'commandAutoRegistry no longer feeds SUB_COMMANDS for heal — `heal log` cannot be routed');
  assert.ok(table.heal.includes('log'), `heal sub-commands lost "log": ${JSON.stringify(table.heal)}`);
});

test('khy heal log takes the audit branch instead of the体检 default', (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-heal-log-'));
  t.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  const out = run(['heal', 'log', '--last', '5'], tmpHome);
  assert.ok(out.trim().length > 0, 'khy heal log produced no output at all');
  const leakedDefault = DEFAULT_BRANCH_MARKS.filter((m) => out.includes(m));
  assert.deepEqual(leakedDefault, [],
    `khy heal log collapsed onto the default体检 branch again:\n${out}`);
  const hitAudit = out.includes('暂无自愈事件记录') || (out.includes('时间') && out.includes('结果'));
  assert.ok(hitAudit, `khy heal log neither listed events nor said it had none:\n${out}`);
});
