'use strict';

/**
 * r216 pin test — `khy agent` 用户面本地化 + ✗/rc=1 配对（#82/#106 族）。
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
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-r216-'));
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

test('agent list renders Chinese chrome and localized toolProfile column', () => {
  const { out, status } = run(['agent', 'list']);
  assert.strictEqual(status, 0);
  assert.match(out, /代理角色模板/);
  assert.match(out, /角色键/);
  assert.match(out, /工具档/);
  assert.match(out, /Claude 兼容角色/);
  // 内部枚举不得裸出（渲染壳映射后仍保留原值兜底，但已知枚举必须显中文）
  assert.ok(!/^\s*\S+\s+\S+\s+minimal\s/m.test(out), 'toolProfile 列不应直出 minimal');
  assert.ok(!/Agent Templates/.test(out), '英文标题不应残留');
});

test('agent run without task prints ✗ usage with rc=1', () => {
  const { out, status } = run(['agent', 'run']);
  assert.strictEqual(status, 1);
  assert.match(out, /✗ 用法: agent run\|spawn/);
});

test('agent unknown verb is rejected with echo and rc=1, not swallowed into usage wall', () => {
  const { out, status } = run(['agent', 'bogus']);
  assert.strictEqual(status, 1);
  assert.match(out, /未知子命令: agent bogus/);
});

test('agent help exemption still prints usage wall with rc=0', () => {
  const { out, status } = run(['agent', 'help']);
  assert.strictEqual(status, 0);
  assert.match(out, /用法: agent run\|spawn/);
  assert.ok(!/未知子命令/.test(out), 'help 不应被回捞门拒绝');
});
