'use strict';

// r214 钉桩：khy train export-data 在无交互记录的空存储上必须
// (1) 打中文 ✗ 且带补救动作（不再直吐服务层英文串），
// (2) 进程退出码 1（#82 契约：用户可见 ✗ 必配 rc=1）。
// 三重钉桩：KHY_APP_HOME + KHY_PROJECT_DATA_HOME + TMP/TEMP，
// 保证任何写盘/清 temp 路径都落进沙箱（r213 教训）。

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.resolve(__dirname, '../../bin/khy.js');

function spawnExportData() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-r214-'));
  const app = path.join(root, 'app');
  const proj = path.join(root, 'proj');
  const tmp = path.join(root, 'tmp');
  for (const d of [app, proj, tmp]) fs.mkdirSync(d, { recursive: true });
  try {
    return spawnSync(process.execPath, [BIN, 'train', 'export-data'], {
      encoding: 'utf8',
      input: '',
      timeout: 60000,
      env: {
        ...process.env,
        KHY_APP_HOME: app,
        KHY_PROJECT_DATA_HOME: proj,
        TMP: tmp,
        TEMP: tmp,
      },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('train export-data 空记录: 中文 ✗ 且 rc=1', () => {
  const r = spawnExportData();
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  assert.match(out, /没有交互记录/);
  assert.doesNotMatch(out, /No interaction records found/);
  assert.strictEqual(r.status, 1);
});
