'use strict';

// r211 钉桩：`khy ai dangerous`（未确认时）的同意门提示屏。
// 旧形：printError('⚠⚠⚠ 警告: ...') + 三条竖排 printInfo i 子弹，且 ✗ 与 rc=0
// 矛盾（这是提示不是失败，#40 族反形）。现形：单 ⚠ 行 + 无子弹续行 + remedy
// 带 khy 前缀。用 KHY_APP_HOME 空沙箱保证 dangerousAcknowledged 恒 false，
// 必走 !acknowledged 分支，且写侧落点全在临时目录（enableDangerousMode 的
// profile 同步 persist:false 本就未落盘，此处只是双保险）。
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const BIN = path.resolve(__dirname, '../../bin/khy.js');

function spawnDangerous() {
  const appHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-r211-pin-'));
  try {
    return spawnSync(process.execPath, [BIN, 'ai', 'dangerous'], {
      encoding: 'utf8',
      input: '',
      timeout: 60000,
      env: { ...process.env, KHY_APP_HOME: appHome },
    });
  } finally {
    fs.rmSync(appHome, { recursive: true, force: true });
  }
}

test('khy ai dangerous 未确认屏：单 ⚠ 字形，无 ✗/rc 矛盾', () => {
  const r = spawnDangerous();
  const out = (r.stdout || '') + (r.stderr || '');
  assert.ok(
    out.includes('⚠ 危险模式将跳过所有工具调用确认!'),
    `缺单 ⚠ 警告行；实际输出：\n${out}`
  );
  assert.ok(
    !out.includes('✗'),
    `提示屏不应出现 ✗ 错误字形（✗/rc=0 矛盾回潮）；实际输出：\n${out}`
  );
  assert.ok(
    !out.includes('⚠⚠⚠'),
    `不应回潮三重 ⚠；实际输出：\n${out}`
  );
  assert.strictEqual(r.status, 0, '确认门提示不是失败，rc 应为 0');
});

test('khy ai dangerous 续行无 i 子弹，remedy 带 khy 前缀', () => {
  const r = spawnDangerous();
  const out = (r.stdout || '') + (r.stderr || '');
  assert.ok(
    !out.includes('  i AI 将可以不经确认'),
    `续行不应吃 i 子弹；实际输出：\n${out}`
  );
  assert.ok(
    out.includes('khy ai dangerous --confirm'),
    `remedy 应给终端可用的 khy 前缀形态；实际输出：\n${out}`
  );
});
