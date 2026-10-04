'use strict';
// 家庭契约回归:打印 ✗ 的失败路径必须以非零退出码收场(脚本/CI 可见);
// 只打印 ⚠ 的警告路径不得污染 rc。证据: .khy/feedback/non-git-rc-round17/
// (改前: 三条 not_a_repo ✗ 全 rc=0,而 33 个 handler 已用 utils/markProcessFailure 守约)。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BE = path.resolve(__dirname, '../..');
const KHY = path.join(BE, 'bin/khy.js');
const REPO = path.resolve(__dirname, '../../..');

function nonGitCwd() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-nongit-rc-'));
  assert.ok(!d.startsWith(BE));
  return d;
}

function run(args, cwd) {
  const r = spawnSync(process.execPath, [KHY, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env },
  });
  assert.strictEqual(r.error, undefined, `spawn failed: ${r.error && r.error.message}`);
  return { rc: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

for (const verb of ['install', 'uninstall', 'status']) {
  test(`live CLI: metadata hook ${verb} in non-git cwd → ✗ 与 rc=1 成对`, () => {
    const { rc, out } = run(['metadata', 'hook', verb], nonGitCwd());
    assert.ok(out.includes('✗') && out.includes('不是 git 仓库'), `missing ✗ line:\n${out}`);
    assert.strictEqual(rc, 1, `✗ rendered but rc=${rc} (contract: failure must exit non-zero)`);
  });
}

test('positive control: warn-only path (⚠ foreign_hook via <仓库路径>) keeps rc=0', () => {
  const { rc, out } = run(['metadata', 'hook', 'install', REPO], nonGitCwd());
  // 本仓库 .githooks 有非 khy 钩子 → foreign_hook(⚠) 或成功装钩(✓)。两者都不该是 ✗。
  assert.ok(!out.includes('✗'), `unexpected error render:\n${out}`);
  assert.strictEqual(rc, 0, `warn/success path must not fail the process (rc=${rc})`);
});
