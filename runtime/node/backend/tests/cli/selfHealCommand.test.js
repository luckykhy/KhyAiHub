'use strict';

// Regression for two independent selfheal breakages:
//  1. Reachability — aliases.js rewrites the typed token to camelCase `selfHeal`
//     while every auto-registry key is lowercase, so dispatch() missed and the
//     router printed "未知命令: selfHeal" for all four spellings.
//  2. Honesty — the handler called selfHeal.getStats()/getModuleMap(), which do
//     not exist (services/selfHeal re-exports this very handler), so every
//     subcommand threw a TypeError that leaked as "is not a function".

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { test } = require('node:test');
const assert = require('node:assert');

const BIN = path.resolve(__dirname, '../../bin/khy.js');
const STATUS_MARK = '运行时路径自愈';

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

test('dispatch resolves a camelCase alias target against lowercase keys', async () => {
  const reg = require('../../src/cli/commandAutoRegistry');
  let handled = null;
  const ctx = {
    parsed: { command: 'selfHeal', subCommand: null, args: [], options: {} },
    // Keep the handler quiet: it prints via console.log, we only assert routing.
  };
  const log = console.log;
  console.log = () => {};
  try {
    handled = await reg.dispatch('selfHeal', ctx);
  } finally {
    console.log = log;
  }
  assert.ok(handled && handled.handled === true,
    'dispatch("selfHeal") fell through — the lowercase registry keys no longer absorb camelCase alias targets');
});

test('khy selfheal status reports the hook instead of throwing or claiming 未知命令', (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-selfheal-'));
  t.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  const out = run(['selfheal', 'status'], tmpHome);
  assert.ok(out.trim().length > 0, 'khy selfheal status produced no output at all');
  assert.ok(out.includes(STATUS_MARK), `khy selfheal status lost its report:\n${out}`);
  assert.ok(!out.includes('未知命令'), `khy selfheal is unreachable again:\n${out}`);
  assert.ok(!out.includes('is not a function'), `selfheal still calls a missing service method:\n${out}`);
  // Rule 2.2: the line must carry a target and a remedy, not just a headline.
  assert.ok(/钩子/.test(out) && /moduleSelfHeal/.test(out),
    `status output lost its hook/gate detail:\n${out}`);
});

test('khy selfheal test and index each take their own branch', (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-selfheal-'));
  t.after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  const testOut = run(['selfheal', 'test'], tmpHome);
  const indexOut = run(['selfheal', 'index'], tmpHome);
  assert.ok(testOut.trim().length > 0 && indexOut.trim().length > 0,
    'selfheal subcommands produced no output');
  assert.ok(testOut.includes('自检') && !indexOut.includes('自检'),
    `khy selfheal test/index collapsed onto one branch:\n--test--\n${testOut}\n--index--\n${indexOut}`);
  assert.ok(!testOut.includes('未知命令') && !indexOut.includes('未知命令'),
    'a selfheal subcommand fell through to 未知命令');
});
