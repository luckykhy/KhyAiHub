'use strict';

/**
 * cleanupService.quarantineTrim.test.js — 隔离区/训练集裁剪的字节路径。
 *
 * 覆盖的真实缺口(2026-09-29 实测):.khy/training/interaction_quarantine.jsonl 547.8 MB,
 * 声明上限 20 MB。旧实现走「整文件 readFileSync(…,'utf-8') + 切行」,而该文件远超 Node
 * 单字符串上限(0x1fffffe8 ≈ 512 MB)⇒ 必抛 ERR_STRING_TOO_LONG,`catch { continue }` 把
 * 它吞成 {trimmed:false} ⇒ 该文件永远不被裁。且该文件单行均值 761 KB,
 * QUARANTINE_MAX_LINES=5000 合 3.6 GB,行上限在它身上根本没有约束力。
 *
 * 跑法:node --test tests/services/cleanupService.quarantineTrim.test.js
 * (同目录的 jest 件在本机跑不起来 —— node_modules/khy-os-backend/node_modules/jest 缺失。)
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 必须在 require cleanupService 之前钉住 data home:dataHome 的 _cached/_cachedAppHome
// 是「先到先得」的进程级缓存,一旦被别处按默认路径填充就再也改不动。
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-quarantine-trim-'));
const PREV_ENV = {
  KHY_DATA_HOME: process.env.KHY_DATA_HOME,
  KHY_APP_HOME: process.env.KHY_APP_HOME,
};
process.env.KHY_DATA_HOME = ROOT;
process.env.KHY_APP_HOME = ROOT;

const cleanupService = require('../../src/services/cleanupService');

const TRAINING = path.join(ROOT, 'training');
const QUARANTINE = path.join(TRAINING, 'interaction_quarantine.jsonl');
const RECORDS = path.join(TRAINING, 'interaction_records.jsonl');

const MB = 1024 * 1024;
const QUARANTINE_MAX_BYTES = 20 * MB; // = cleanupService 的 QUARANTINE_MAX_BYTES
const QUARANTINE_MAX_LINES = 5000; // = QUARANTINE_MAX_LINES
const TRAINING_MAX_BYTES = 50 * MB; // = TRAINING_MAX_BYTES

before(() => {
  fs.mkdirSync(TRAINING, { recursive: true });
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const [k, v] of Object.entries(PREV_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function reset() {
  for (const p of [QUARANTINE, RECORDS]) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* absent is fine */
    }
  }
}

/** 写 n 行、每行约 1 MB 的 jsonl,返回原始行数组。 */
function writeBig(filePath, n, prefix) {
  const body = [];
  for (let i = 0; i < n; i += 1) {
    body.push(`${prefix}${String(i).padStart(3, '0')}-${'x'.repeat(MB)}`);
  }
  fs.writeFileSync(filePath, body.join('\n') + '\n');
  return body;
}

/** 让对 target 的整文件读取必抛 Node 字符串上限错,并记录调用次数。 */
function blockWholeFileRead(target, fn) {
  const real = fs.readFileSync;
  const calls = [];
  fs.readFileSync = function (p, ...rest) {
    if (p === target) {
      calls.push(p);
      const e = new Error('Cannot create a string longer than 0x1fffffe8 characters');
      e.code = 'ERR_STRING_TOO_LONG';
      throw e;
    }
    return real.call(fs, p, ...rest);
  };
  try {
    return { calls, value: fn() };
  } finally {
    fs.readFileSync = real;
  }
}

describe('cleanupService.trimQuarantine — 字节路径', () => {
  test('超限文件必须真被裁掉(不得依赖整文件 readFileSync)', () => {
    reset();
    writeBig(QUARANTINE, 22, 'L');
    assert.ok(fs.statSync(QUARANTINE).size > QUARANTINE_MAX_BYTES, '前置:文件须超上限');

    // 模拟真实条件:任何对该文件的整文件读取都抛 Node 字符串上限错。
    // 旧实现走的就是这条路 ⇒ 抛 → catch → {trimmed:false} ⇒ 永不裁。
    const { calls, value: result } = blockWholeFileRead(QUARANTINE, () =>
      cleanupService.trimQuarantine()
    );

    assert.equal(calls.length, 0, '不得整文件读隔离区');
    assert.equal(result.trimmed, true, `应真裁掉,实得 ${JSON.stringify(result)}`);
    assert.ok(result.freedBytes > 0, '应报出释放字节数');
    const after = fs.statSync(QUARANTINE).size;
    assert.ok(after <= QUARANTINE_MAX_BYTES, `裁后应 ≤ 20 MB,实为 ${(after / MB).toFixed(1)} MB`);
  });

  test('保留的是尾部,且被切断的首行必须丢弃', () => {
    reset();
    const body = writeBig(QUARANTINE, 22, 'L');
    const result = cleanupService.trimQuarantine();
    assert.equal(result.trimmed, true);

    const kept = fs.readFileSync(QUARANTINE, 'utf8').split('\n').filter(Boolean);
    assert.ok(kept.length > 0, '不应裁成空文件');
    // 每一行都必须是完整记录:半条被切断的行一旦留下,下游 JSON.parse 会炸。
    for (const line of kept) {
      assert.match(line, /^L\d{3}-x+$/, `残留半条记录: ${line.slice(0, 40)}…`);
    }
    // 末行必须与原文件末行逐字节相同。
    assert.equal(kept[kept.length - 1], body[body.length - 1]);
    assert.equal(result.after, kept.length);
  });

  test('失败不再静默:读不了要带 error 出来', () => {
    reset();
    writeBig(QUARANTINE, 22, 'L');
    const sizeBefore = fs.statSync(QUARANTINE).size;

    const realOpenSync = fs.openSync;
    fs.openSync = function (p, ...rest) {
      if (p === QUARANTINE) {
        const e = new Error('EACCES: permission denied');
        e.code = 'EACCES';
        throw e;
      }
      return realOpenSync.call(fs, p, ...rest);
    };

    let result;
    try {
      result = cleanupService.trimQuarantine();
    } finally {
      fs.openSync = realOpenSync;
    }

    assert.equal(result.trimmed, false);
    // 旧实现这里返回裸 {trimmed:false},把「读不动」和「无需裁」混成一种。
    assert.equal(typeof result.error, 'string', '失败必须可诊断');
    assert.match(result.error, /EACCES/);
    assert.equal(fs.statSync(QUARANTINE).size, sizeBefore, '失败时不得动文件');
  });

  test('未超字节上限时仍按行裁(既有行为不变)', () => {
    reset();
    const lines = [];
    for (let i = 0; i < QUARANTINE_MAX_LINES + 1; i += 1) {
      lines.push(`{"i":${i}}`);
    }
    fs.writeFileSync(QUARANTINE, lines.join('\n') + '\n');
    assert.ok(fs.statSync(QUARANTINE).size <= QUARANTINE_MAX_BYTES, '前置:须未超字节上限');

    const result = cleanupService.trimQuarantine();
    assert.equal(result.trimmed, true);
    assert.equal(result.before, QUARANTINE_MAX_LINES + 1);
    assert.equal(result.after, QUARANTINE_MAX_LINES);
    const kept = fs.readFileSync(QUARANTINE, 'utf8').split('\n').filter(Boolean);
    assert.equal(kept.length, QUARANTINE_MAX_LINES);
    assert.equal(kept[kept.length - 1], `{"i":${QUARANTINE_MAX_LINES}}`, '保留的应是尾部');
  });

  test('未超上限且行数未超 ⇒ 不动文件', () => {
    reset();
    fs.writeFileSync(QUARANTINE, '{"i":1}\n{"i":2}\n');
    const before = fs.readFileSync(QUARANTINE, 'utf8');
    const result = cleanupService.trimQuarantine();
    assert.equal(result.trimmed, false);
    assert.equal(fs.readFileSync(QUARANTINE, 'utf8'), before);
  });
});

describe('cleanupService.trimTrainingData — 字节路径', () => {
  test('超 50 MB 的记录集不靠整文件读取也能裁', () => {
    reset();
    const body = writeBig(RECORDS, 55, 'T'); // ≈ 55 MB > TRAINING_MAX_BYTES(50 MB)
    assert.ok(fs.statSync(RECORDS).size > TRAINING_MAX_BYTES, '前置:须超 50 MB');

    const { calls, value: result } = blockWholeFileRead(RECORDS, () =>
      cleanupService.trimTrainingData()
    );

    assert.equal(calls.length, 0, '不得整文件读记录集');
    assert.equal(result.trimmed, true, `应真裁掉,实得 ${JSON.stringify(result)}`);
    const after = fs.statSync(RECORDS).size;
    assert.ok(after <= TRAINING_MAX_BYTES, `裁后应 ≤ 50 MB,实为 ${(after / MB).toFixed(1)} MB`);
    const kept = fs.readFileSync(RECORDS, 'utf8').split('\n').filter(Boolean);
    assert.equal(kept[kept.length - 1], body[body.length - 1], '保留的应是尾部');
    for (const line of kept) {
      assert.match(line, /^T\d{3}-x+$/, `残留半条记录: ${line.slice(0, 40)}…`);
    }
  });

  test('未超字节上限时仍按行裁(既有行为不变)', () => {
    reset();
    fs.writeFileSync(RECORDS, Array.from({ length: 8 }, (_, i) => `{"i":${i}}`).join('\n') + '\n');
    const result = cleanupService.trimTrainingData(5);
    assert.equal(result.trimmed, true);
    assert.equal(result.before, 8);
    assert.equal(result.after, 5);
  });
});
