'use strict';

// r212 钉桩:`khy fork` 无可分叉会话时的 ✗/rc 配对(#82 族,CLEAN fork.js 5 处补 mark)。
// 双沙箱:KHY_APP_HOME + KHY_PROJECT_DATA_HOME 都指空临时目录 → 会话存储恒空,
// 必走 !source 分支,且任何注册/写入都落在沙箱内,真实 .khy 存储零接触。
// `--at` 悬挂形态一并钉:parseInput 吞掉选项后落进裸 fork 路径(r212 时点),
// 在空存储下与裸形态同屏同 rc——若未来该形态改道,此钉会红,提示重新裁决。
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const BIN = path.resolve(__dirname, '../../bin/khy.js');
const MARK = '没有可分叉的会话';

function spawnFork(verbArgs) {
  const appHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-r212-app-'));
  const projHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-r212-proj-'));
  try {
    return spawnSync(process.execPath, [BIN, ...verbArgs], {
      encoding: 'utf8',
      input: '',
      timeout: 60000,
      env: {
        ...process.env,
        KHY_APP_HOME: appHome,
        KHY_PROJECT_DATA_HOME: projHome,
      },
    });
  } finally {
    fs.rmSync(appHome, { recursive: true, force: true });
    fs.rmSync(projHome, { recursive: true, force: true });
  }
}

for (const [label, verbArgs] of [
  ['khy fork(空存储)', ['fork']],
  ['khy fork --at(悬挂选项)', ['fork', '--at']],
]) {
  test(`${label}: ✗ 必配 rc=1`, () => {
    const r = spawnFork(verbArgs);
    const out = (r.stdout || '') + (r.stderr || '');
    assert.ok(out.includes(MARK), `缺 ✗「${MARK}」屏;实际输出:\n${out}`);
    assert.strictEqual(r.status, 1, `✗ 已打印但 rc=${r.status}(#82 违约回潮)`);
  });
}
