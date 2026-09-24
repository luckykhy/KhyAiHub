'use strict';

// Regression: handlers/modules.js once resolved the catalog four levels up from
// services/backend/src/cli/handlers — i.e. into services/ — so `khy modules`
// told the user the catalog did not exist while it sat in the repo, and the
// whole command (list/info/build) was unreachable. Guards the repo-root hop and
// the fact that a failure sentence must name a path that really is missing.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test } = require('node:test');
const assert = require('node:assert');

const BIN = path.resolve(__dirname, '../../bin/khy.js');
const CATALOG = path.resolve(__dirname, '../../../../packaging/modules/modules.json');

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

test('khy modules reads the catalog that actually ships in the repo', (t) => {
  // Precondition: without a catalog on disk the assertion below is vacuous.
  assert.ok(fs.existsSync(CATALOG), `expected catalog at ${CATALOG}`);

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-modules-'));
  t.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  const out = run(['modules'], tmpHome);
  assert.ok(out.trim().length > 0, 'khy modules produced no output at all');
  assert.ok(/Module ID/.test(out), `khy modules did not render the table:\n${out}`);
  assert.ok(!out.includes('未找到'), `khy modules still reports the catalog missing:\n${out}`);
});
