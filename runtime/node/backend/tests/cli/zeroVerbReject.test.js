'use strict';

/**
 * r226 pin test — 零动词命令尾词门（voice/compute，#210 族变体）。
 * 这两命令在 SUB_COMMANDS 无动词表，故文案是「不接受子命令」而非「未知子命令」。
 * `<cmd> help` → 用法墙 rc=0 无 ✗；`<cmd> <word>` → ✗ 复述被拒词 rc=1；
 * 裸命令 → 默认屏 rc=0。真实派发链 spawn + 三重钉桩沙箱。
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
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-r226-'));
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

const COMMANDS = [
  { cmd: 'voice', wall: '用法: voice（无子命令', screen: '语音控制' },
  { cmd: 'compute', wall: '用法: compute（无子命令', screen: '本地算力状态' },
];

for (const { cmd, wall, screen } of COMMANDS) {
  test(`${cmd} help is exempt: usage wall rc=0 without ✗`, () => {
    const { out, status } = run([cmd, 'help']);
    assert.strictEqual(status, 0);
    assert.ok(out.includes(wall), 'help 应打印零动词用法墙');
    assert.ok(!/不接受子命令/.test(out), 'help 不应被尾词门拒绝');
    assert.ok(!/✗/.test(out), 'help 用法墙不应带 ✗ 字形');
  });

  test(`${cmd} <word> echoes rejected word with rc=1`, () => {
    const { out, status } = run([cmd, 'bogus-arg-x']);
    assert.strictEqual(status, 1);
    assert.match(out, /✗ 不接受子命令/);
    assert.match(out, /bogus-arg-x/);
  });

  test(`${cmd} bare still renders default screen rc=0`, () => {
    const { out, status } = run([cmd]);
    assert.strictEqual(status, 0);
    assert.ok(out.includes(screen), `裸 ${cmd} 应仍渲染默认屏`);
    assert.ok(!/不接受子命令/.test(out));
  });
}
