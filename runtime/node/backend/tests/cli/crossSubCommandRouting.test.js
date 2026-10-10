'use strict';

// Regression: `khy cross <sub>` used to run `status` for every subcommand,
// because parseInput only fills parsed.subCommand from the static SUB_COMMANDS
// table, which has no `cross` key — so commandAutoRegistry had to re-align it
// from the manifest. If that alignment ever breaks again, the subcommands here
// all collapse back onto the status branch and produce identical output.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { test } = require('node:test');
const assert = require('node:assert');

const BIN = path.resolve(__dirname, '../../bin/khy.js');
const STATUS_MARK = '连接状态';

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

test('cross subcommands route independently instead of collapsing onto status', (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cross-route-'));
  t.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  const bare = run(['cross'], tmpHome);
  const sessions = run(['cross', 'sessions'], tmpHome);
  const devices = run(['cross', 'devices'], tmpHome);
  const leave = run(['cross', 'leave', 's-abc'], tmpHome);

  // A crashed/timing-out CLI returns empty output; without this the assertions
  // below pass vacuously.
  for (const [label, out] of [['bare', bare], ['sessions', sessions], ['devices', devices], ['leave', leave]]) {
    assert.ok(out.trim().length > 0, `khy cross (${label}) produced no output at all`);
  }

  // Control: the no-subcommand path still takes the status branch.
  assert.ok(bare.includes(STATUS_MARK), `bare khy cross lost its status output:\n${bare}`);

  // Each named subcommand must differ from status and from each other.
  assert.ok(sessions.includes('活跃会话数') && !sessions.includes(STATUS_MARK),
    `khy cross sessions ran the status branch instead:\n${sessions}`);
  assert.ok(devices.includes('未连接') && !devices.includes(STATUS_MARK),
    `khy cross devices ran the status branch instead:\n${devices}`);
  // `leave <id>` also pins that the positional survives the subcommand shift.
  assert.ok(leave.includes('已离开会话: s-abc'),
    `khy cross leave lost its positional sessionId:\n${leave}`);
});
