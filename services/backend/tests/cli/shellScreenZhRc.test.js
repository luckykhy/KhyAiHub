'use strict';

/**
 * r217 pin test — `khy shell` 用户面本地化 + 裸用法 ✗/rc=1 配对（#82/#106 族）。
 * 真实派发链：spawn 独立进程跑 bin/khy.js，三重钉桩沙箱（KHY_APP_HOME +
 * KHY_PROJECT_DATA_HOME + TMP/TEMP）保证零真实数据副作用。
 * 注：deny/unavailable/validation/failed 分支在 non-TTY 下被交互权限门挡住，
 * 无法活复现，仅靠源码同型审查（本文件不覆盖，见账本 r217 注记）。
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
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-r217-'));
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

test('shell bare prints Chinese ✗ usage with rc=1', () => {
  const { out, status } = run(['shell']);
  assert.strictEqual(status, 1);
  assert.match(out, /✗ 用法: shell <命令/);
  assert.match(out, /i 提示:/);
  assert.ok(!/Usage: shell/.test(out), '英文 Usage 行不应残留');
  assert.ok(!/Tip: use/.test(out), '英文 Tip 行不应残留');
});

test('shell help prints Chinese title with rc=0', () => {
  const { out, status } = run(['shell', 'help']);
  assert.strictEqual(status, 0);
  assert.match(out, /🖥 Shell 命令/);
  assert.ok(!/Shell Command/.test(out), '英文标题不应残留');
});
