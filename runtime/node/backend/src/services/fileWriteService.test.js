'use strict';

// fileWriteService.test.js — 人/AI 共用写通道（DESIGN-ARCH-210 §6）。
// 断言的是「拒绝时磁盘必须原样」：mtime 冲突、闸门拒绝、闸门异常都不得落盘，
// 且写完要刷新先读后写台账（否则 AI 的下一笔 Edit 会被自己的写判成 stale）。
//
// Run: node --test runtime/node/backend/src/services/fileWriteService.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-file-write-'));
process.env.KHY_DATA_HOME = path.join(tmpRoot, 'data');
process.env.KHY_FILE_LOCK_DIR = path.join(tmpRoot, 'locks');

const { write, setPendingGate, MTIME_TOLERANCE_MS } = require('./fileWriteService');
const readTracker = require('../tools/_readTracker');

let seq = 0;
function target(name) {
  seq += 1;
  return path.join(tmpRoot, `case-${seq}`, name);
}

after(() => {
  setPendingGate(null);
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

test('新建文件：父目录自动创建，返回 mtime 并刷新先读后写台账', async () => {
  const filePath = target('deep/new.txt');
  const res = await write({ filePath, content: 'hello\n', createIfMissing: true, actor: 'tool', reason: 'test' });
  assert.equal(res.state, 'ok');
  assert.equal(res.ok, true);
  assert.equal(typeof res.mtimeMs, 'number');
  assert.equal(fs.readFileSync(filePath, 'utf-8'), 'hello\n');
  assert.equal(readTracker.hasRead(filePath), true);
});

test('未声明 createIfMissing 时缺文件返回 missing，且不创建它', async () => {
  const filePath = target('absent.txt');
  const res = await write({ filePath, content: 'x', actor: 'editor' });
  assert.equal(res.ok, false);
  assert.equal(res.state, 'missing');
  assert.equal(fs.existsSync(filePath), false);
});

test('基线一致时正常覆盖', async () => {
  const filePath = target('over.txt');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'old');
  const base = fs.statSync(filePath).mtimeMs;
  const res = await write({ filePath, content: 'new', baseMtimeMs: base, actor: 'editor' });
  assert.equal(res.state, 'ok');
  assert.equal(fs.readFileSync(filePath, 'utf-8'), 'new');
});

test('基线过期 → conflict，磁盘保持对方的内容', async () => {
  const filePath = target('race.txt');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'mine');
  const staleBaseline = fs.statSync(filePath).mtimeMs;
  fs.writeFileSync(filePath, 'theirs');
  fs.utimesSync(filePath, new Date(), new Date(Date.now() + MTIME_TOLERANCE_MS * 4));

  const res = await write({ filePath, content: 'mine-again', baseMtimeMs: staleBaseline, actor: 'editor' });
  assert.equal(res.ok, false);
  assert.equal(res.state, 'conflict');
  assert.equal(typeof res.diskMtimeMs, 'number');
  assert.equal(fs.readFileSync(filePath, 'utf-8'), 'theirs');
});

test('闸门拒绝 → rejected，不落盘', async () => {
  const filePath = target('gate-reject.txt');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'keep');
  setPendingGate(async () => ({ action: 'reject', error: '用户未批准该改动（磁盘保持原样）' }));
  try {
    const res = await write({ filePath, content: 'ai-change', actor: 'tool', reason: 'pending-accept' });
    assert.equal(res.state, 'rejected');
    assert.match(res.error, /未批准/);
    assert.equal(fs.readFileSync(filePath, 'utf-8'), 'keep');
  } finally {
    setPendingGate(null);
  }
});

test('闸门抛错按拒绝处理（fail-closed，不得默认放行）', async () => {
  const filePath = target('gate-throw.txt');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'keep');
  setPendingGate(async () => {
    throw new Error('审批通道断开');
  });
  try {
    const res = await write({ filePath, content: 'ai-change', actor: 'tool' });
    assert.equal(res.ok, false);
    assert.equal(res.state, 'rejected');
    assert.equal(fs.readFileSync(filePath, 'utf-8'), 'keep');
  } finally {
    setPendingGate(null);
  }
});

test('闸门放行后照常写入，并把 after 内容交给闸门审阅', async () => {
  const filePath = target('gate-pass.txt');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'before');
  const seen = [];
  setPendingGate(async (req) => {
    seen.push(req);
    return { action: 'write' };
  });
  try {
    const res = await write({ filePath, content: 'after', actor: 'tool', reason: 'gate-pass' });
    assert.equal(res.state, 'ok');
    assert.equal(fs.readFileSync(filePath, 'utf-8'), 'after');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].filePath, path.resolve(filePath));
    assert.equal(seen[0].content, 'after');
    assert.equal(seen[0].reason, 'gate-pass');
  } finally {
    setPendingGate(null);
  }
});

test('闸门只批准部分改动块时按 verdict.content 落盘（不是工具的全文）', async () => {
  const filePath = target('gate-subset.txt');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'line 1\nline 2\nline 3\n');
  setPendingGate(async () => ({ action: 'write', content: 'line 1\nline 2 CHANGED\nline 3\n' }));
  try {
    const res = await write({ filePath, content: 'line 1\nline 2 CHANGED\nline 3 AI\n', actor: 'tool', reason: 'pending-accept' });
    assert.equal(res.state, 'ok');
    assert.equal(fs.readFileSync(filePath, 'utf-8'), 'line 1\nline 2 CHANGED\nline 3\n');
    assert.equal(res.bytes, Buffer.byteLength('line 1\nline 2 CHANGED\nline 3\n', 'utf-8'));
  } finally {
    setPendingGate(null);
  }
});

test('批准期间磁盘被改 → conflict，绝不覆盖（不落盘）', async () => {
  const filePath = target('gate-conflict.txt');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'before');
  const base = fs.statSync(filePath).mtimeMs;
  setPendingGate(async () => {
    // 模拟用户审阅这几十秒里外部编辑器改了这个文件
    fs.writeFileSync(filePath, 'edited-while-reviewing');
    fs.utimesSync(filePath, new Date(), new Date(Date.now() + MTIME_TOLERANCE_MS * 4));
    return { action: 'write' };
  });
  try {
    const res = await write({ filePath, content: 'ai-change', baseMtimeMs: base, actor: 'tool' });
    assert.equal(res.ok, false);
    assert.equal(res.state, 'conflict');
    assert.equal(fs.readFileSync(filePath, 'utf-8'), 'edited-while-reviewing');
  } finally {
    setPendingGate(null);
  }
});

test('非字符串内容与空路径直接拒绝', async () => {
  assert.equal((await write({ filePath: '', content: 'x' })).state, 'rejected');
  const filePath = target('bad-content.txt');
  const res = await write({ filePath, content: Buffer.from('x'), createIfMissing: true });
  assert.equal(res.state, 'rejected');
  assert.equal(fs.existsSync(filePath), false);
});

test('连续两次写同一文件不会把自己锁住（锁已释放）', async () => {
  const filePath = target('twice.txt');
  const first = await write({ filePath, content: '1', createIfMissing: true });
  assert.equal(first.state, 'ok');
  const second = await write({ filePath, content: '2', baseMtimeMs: first.mtimeMs });
  assert.equal(second.state, 'ok');
  assert.equal(fs.readFileSync(filePath, 'utf-8'), '2');
});
