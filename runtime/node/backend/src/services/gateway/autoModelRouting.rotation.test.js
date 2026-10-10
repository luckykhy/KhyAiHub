'use strict';

/**
 * autoModelRouting.rotation.test.js — 账本裁剪不许销毁证据（§15 R6）。
 *
 * `_appendObservation` 超过 2MB 会「留后半」，丢掉的正是**最早**那批样本——
 * 也就是 §10 的 S1→S2 毕业判据唯一存量。修复后的契约：被移出热文件的行必须先进归档，
 * 且热文件 + 归档的行数 == 裁剪前 + 新增。这里用真实的 2MB+ 文件触发（阈值不可 env 覆盖，
 * 把它做成可注入是另一处放宽，不划算）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const amr = require('./autoModelRouting');

function _seed(file, n) {
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    lines.push(JSON.stringify({ ev: 'select', seq: i, turnId: `9:s:${i}`, pad: 'x'.repeat(1000) }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return lines.length;
}

test('裁剪时最早那半段进归档，一行都不许消失', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-rotation-'));
  const file = path.join(dir, 'auto-route.jsonl');
  const env = {
    KHY_AUTO_MODEL_OBSERVE: '1',
    KHY_AUTO_MODEL_OBSERVE_FILE: file,
  };
  const seeded = _seed(file, 2200); // ~2.2MB+，必然越阈
  assert.ok(fs.statSync(file).size > 2 * 1024 * 1024, '夹具没越过 2MB 阈值，这条测会是空跑');

  const turn = amr.beginTurn({ sessionId: 'ROT' });
  amr.observeSelection(
    {
      turnId: turn,
      mode: 'economy',
      demand: { tier: 'T2', demand: 0.4, flags: [], admitted: false, reasons: [], capabilityRequired: null },
      legacy: { adapter: 'api', model: 'a' },
      ranked: [],
      skipped: [],
    },
    env
  );

  const hot = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const archivePath = file + '.archive.jsonl';
  assert.ok(fs.existsSync(archivePath), '裁剪发生了但没有归档 ⇒ 最早那半段样本被销毁了（违 §15 R6）');
  const archived = fs.readFileSync(archivePath, 'utf8').split('\n').filter(Boolean);

  // 守恒：归档 + 热文件 = 裁剪前 + 本轮新增一条
  assert.strictEqual(
    hot.length + archived.length,
    seeded + 1,
    `行数不守恒：seeded=${seeded} hot=${hot.length} archive=${archived.length}`
  );
  // 丢的必须是**最旧**的那批（归档按时间顺序保留 seq 小的）
  const firstArchived = JSON.parse(archived[0]);
  assert.strictEqual(firstArchived.seq, 0, '归档首行不是最早的样本，说明裁剪方向反了');
  assert.ok(
    JSON.parse(archived[archived.length - 1]).seq < JSON.parse(hot[0]).seq,
    '归档末尾比热文件首行还新 ⇒ 两段边界错了，可能有重叠或空洞'
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
