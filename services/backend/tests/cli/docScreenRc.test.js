'use strict';

/**
 * r219 pin test — `khy doc` 用法墙 ✗/rc=1 配对 + help 豁免（#82/#37 兑现）。
 * 真实派发链：spawn 独立进程跑 bin/khy.js，三重钉桩沙箱（KHY_APP_HOME +
 * KHY_PROJECT_DATA_HOME + TMP/TEMP）保证零真实数据副作用。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BACKEND = path.resolve(__dirname, '..', '..');
const BIN = path.join(BACKEND, 'bin', 'khy.js');

function run(args) {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-r219-'));
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd: BACKEND,
    encoding: 'utf8',
    timeout: 20000,
    input: '',
    env: {
      ...process.env,
      KHY_APP_HOME: path.join(sb, 'app'),
      KHY_PROJECT_DATA_HOME: path.join(sb, 'proj'),
      TMP: sb,
      TEMP: sb,
    },
  });
  return { out: (res.stdout || '') + (res.stderr || ''), status: res.status };
}

test('bare doc prints ✗ usage with rc=1', () => {
  const { out, status } = run(['doc']);
  assert.strictEqual(status, 1);
  assert.match(out, /✗ 用法: doc title/);
});

test('doc <unknown verb> echoes the rejected word and exits 1', () => {
  const { out, status } = run(['doc', 'list']);
  assert.strictEqual(status, 1);
  assert.match(out, /✗ 未知子命令:list。用法/);
});

test('doc help is exempt: no ✗, no 未知子命令, rc=0', () => {
  const { out, status } = run(['doc', 'help']);
  assert.strictEqual(status, 0);
  assert.match(out, /用法: doc title/);
  assert.ok(!/✗/.test(out), 'help 不应带 ✗ 字形');
  assert.ok(!/未知子命令/.test(out), 'help 不应被回捞门拒绝');
});

test('doc title without path prints ✗ usage with rc=1', () => {
  const { out, status } = run(['doc', 'title']);
  assert.strictEqual(status, 1);
  assert.match(out, /✗ 用法: doc title <文件\.docx>/);
});
