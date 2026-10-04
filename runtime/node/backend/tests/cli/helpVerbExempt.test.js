'use strict';

/**
 * r220 pin test — 回捞门 help 豁免族（history/models/khymodel/log，#82/r216 门型）。
 * `<cmd> help` → 用法墙 rc=0 无 ✗；`<cmd> <bogus>` → ✗ 复述被拒词 rc=1。
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
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-r220-'));
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
  { cmd: 'history', verbs: 'list|resume|clear' },
  { cmd: 'models', verbs: 'list|pull|import|delete|set' },
  { cmd: 'khymodel', verbs: 'list|import|export|scan' },
  { cmd: 'log', verbs: 'error|tail|clear' },
  // r222 顺延簇:train/strategy/receipts 的回捞门(r200/r203/#10)补同一豁免。
  { cmd: 'train', verbs: 'start|cloud|distill|status|list|export|export-data|upload|data' },
  { cmd: 'strategy', verbs: 'list' },
  { cmd: 'receipts', verbs: 'list | show | search | orch | orchestration' },
  // r225 顺延簇:ops 簇六案七命令首次补门(cost 动词未注册,靠 args 回捞)。
  { cmd: 'usage', verbs: 'today|history|reset' },
  { cmd: 'cost', verbs: 'today|history|reset' },
  { cmd: 'growth', verbs: 'export|import|snapshot|snapshots|restore|reset' },
  { cmd: 'knowledge', verbs: 'search|stats|sync|self' },
  { cmd: 'security', verbs: 'scan|monitor|status|integrity|profile|audit|permissions' },
  { cmd: 'monitor', verbs: 'status|tail|clear|dashboard|tools|selfcheck|slow|profile' },
  { cmd: 'services', verbs: 'list|health' },
];

for (const { cmd, verbs } of COMMANDS) {
  test(`${cmd} help is exempt: usage wall rc=0 without ✗`, () => {
    const { out, status } = run([cmd, 'help']);
    assert.strictEqual(status, 0);
    assert.match(out, new RegExp(`用法: ${cmd} ${verbs.split('|').map((v) => v.trim().replace(/-/g, '\\-')).join('\\s*\\|\\s*')}`));
    assert.ok(!/未知子命令/.test(out), 'help 不应被回捞门拒绝');
    assert.ok(!/✗/.test(out), 'help 用法墙不应带 ✗ 字形');
  });

  test(`${cmd} <bogus> echoes rejected word with rc=1`, () => {
    const { out, status } = run([cmd, 'bogus-verb-x']);
    assert.strictEqual(status, 1);
    assert.match(out, /✗ 未知子命令/);
    assert.match(out, /bogus-verb-x/);
  });
}
