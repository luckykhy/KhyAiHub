'use strict';

/**
 * r221 pin test — learn/fork 的 help 豁免（r219/r220 门型延伸）。
 * `fork help` → 用法墙 rc=0 无 ✗（此前直接执行分叉语义）；
 * `learn help` → 课程总览 rc=0（此前落进话题检索「未找到与 "help" 相关的课程」✗/rc=1）。
 * 对照:`fork` 裸(无会话) ✗/rc=1、`learn <bogus>` ✗未找到/rc=1 不变。
 * 真实派发链 spawn + 三重钉桩沙箱（KHY_APP_HOME + KHY_PROJECT_DATA_HOME + TMP/TEMP）。
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
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-r221-'));
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

test('fork help is exempt: usage wall rc=0 without ✗', () => {
  const { out, status } = run(['fork', 'help']);
  assert.strictEqual(status, 0);
  assert.match(out, /用法: khy fork/);
  assert.ok(!/✗/.test(out), 'fork help 不应执行分叉语义或带 ✗');
});

test('fork bare without any session still ✗/rc=1', () => {
  const { out, status } = run(['fork']);
  assert.strictEqual(status, 1);
  assert.match(out, /✗ 没有可分叉的会话/);
});

test('learn help falls to curriculum overview rc=0', () => {
  const { out, status } = run(['learn', 'help']);
  assert.strictEqual(status, 0);
  assert.match(out, /第 \d+ 层/);
  assert.ok(!/未找到/.test(out), 'help 不得被当成话题检索词');
  assert.ok(!/✗/.test(out), '课程总览不应带 ✗');
});

test('learn <bogus topic> keeps ✗/rc=1 not-found path', () => {
  const { out, status } = run(['learn', 'zz不存在话题qxy']);
  assert.strictEqual(status, 1);
  assert.match(out, /✗ 未找到与 "zz不存在话题qxy" 相关的课程/);
});
