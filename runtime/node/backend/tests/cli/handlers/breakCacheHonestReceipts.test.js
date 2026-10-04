'use strict';

/**
 * breakCacheHonestReceipts.test.js — /break-cache 四分支回执诚实性契约。
 *
 * 复现源自 .khy/feedback/hci-r37-breakcache-fake-receipt/ :state 层用
 * `catch { /* ignore *\/ }` 吞掉 writeFileSync/unlinkSync 失败,handler 无条件
 * printSuccess → 「marker 已写入」「原本就未激活」全是假回执(假关闭尤其危险:
 * 标记还在磁盘上、击穿仍会生效)。
 *
 * 故障注入用真实 fs:marker/flag 路径预置为同名目录 → win32 写 EISDIR / 删 EPERM,
 * POSIX 同类错误 —— 不 stub fs(核心模块不可 stub),全走真实代码路径。
 * node --test only.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const BACKEND = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(BACKEND, 'src');

function seed(absPath, exportsObj) {
  const m = new Module(absPath, null);
  m.filename = absPath;
  m.loaded = true;
  m.exports = exportsObj;
  require.cache[absPath] = m;
}

// Mutable data dir; state 层每次 getPaths() 都经 dataHome 现取。
let DATA = null;
seed(path.join(SRC, 'utils', 'dataHome.js'), { getDataDir: () => DATA });

const rec = { success: [], error: [], info: [] };
seed(path.join(SRC, 'cli', 'formatters.js'), {
  printSuccess: (m) => rec.success.push(String(m)),
  printError: (m) => rec.error.push(String(m)),
  printInfo: (m) => rec.info.push(String(m)),
  printWarn: () => {},
  printTable: () => {},
});

const savedGate = process.env.KHY_BREAK_CACHE;
process.env.KHY_BREAK_CACHE = ''; // 门控默认开
const { handleBreakCache } = require(path.join(SRC, 'cli', 'handlers', 'breakCache.js'));

const MARKER = 'next-request-no-cache';
const ALWAYS = 'break-cache-always';

function freshDir(collide) {
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-honest-'));
  for (const name of collide) fs.mkdirSync(path.join(DATA, name), { recursive: true });
  return DATA;
}

function reset() {
  rec.success.length = 0;
  rec.error.length = 0;
  rec.info.length = 0;
}

test('T1 once + 写失败(目录冲突 EISDIR) → 错误行,绝不「已写入」', async (t) => {
  freshDir([MARKER]);
  reset();
  try {
    await handleBreakCache('once', [], {});
    assert.equal(rec.success.length, 0, '失败时不得 printSuccess, got: ' + JSON.stringify(rec.success));
    assert.equal(rec.error.length, 1);
    assert.match(rec.error[0], /缓存击穿 marker 写入失败/);
    assert.match(rec.error[0], /EISDIR/, '原始 errno 必须到达用户');
    assert.match(rec.error[0], /不会击穿/, '后果必须讲清');
  } finally {
    if (t.diagnostic) t.diagnostic('marker 路径从未成为文件: ' + !fs.statSync(path.join(DATA, MARKER)).isFile());
    fs.rmSync(DATA, { recursive: true, force: true });
  }
});

test('T2 always + 写失败 → 错误行点名持久 flag', async (t) => {
  freshDir([ALWAYS]);
  reset();
  try {
    await handleBreakCache('always', [], {});
    assert.equal(rec.success.length, 0);
    assert.equal(rec.error.length, 1);
    assert.match(rec.error[0], /持久 flag 写入失败/);
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
});

test('T3 off + 删失败(目录残留) → 报「移除失败+仍会生效」,禁「原本就未激活」', async (t) => {
  freshDir([MARKER, ALWAYS]);
  reset();
  try {
    await handleBreakCache('off', [], {});
    assert.equal(rec.success.length, 0, '假关闭是本契约的核心红线');
    assert.equal(rec.error.length, 1);
    assert.match(rec.error[0], /缓存击穿标记移除失败/);
    assert.match(rec.error[0], /仍会生效/);
    assert.ok(fs.existsSync(path.join(DATA, MARKER)), '失败场景里标记应仍在磁盘(回执如实说了仍在)');
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
});

test('T4 clear + 删失败 → 错误行,禁「没有待生效的 marker」', async (t) => {
  freshDir([MARKER]);
  reset();
  try {
    await handleBreakCache('clear', [], {});
    assert.equal(rec.success.length, 0);
    assert.equal(rec.error.length, 1);
    assert.match(rec.error[0], /清除一次性缓存击穿 marker 失败/);
    assert.match(rec.error[0], /下一次请求仍会击穿/);
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
});

test('T5 happy path 行为保持:once 写成真文件 + 回执「已写入」;off 真删', async (t) => {
  freshDir([]);
  reset();
  try {
    await handleBreakCache('once', [], {});
    assert.equal(rec.error.length, 0);
    assert.equal(rec.success.length, 1);
    assert.match(rec.success[0], /marker 已写入/);
    const mp = path.join(DATA, MARKER);
    assert.ok(fs.statSync(mp).isFile(), '真 marker 文件必须落盘(非空转断言)');

    reset();
    await handleBreakCache('off', [], {});
    assert.equal(rec.error.length, 0);
    assert.equal(rec.success.length, 1);
    assert.match(rec.success[0], /已移除/);
    assert.ok(!fs.existsSync(mp), 'off 必须真的删掉 marker');
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
});

test('T6 未激活时 off 仍说「原本就未激活」(既有措辞不误伤)', async (t) => {
  freshDir([]);
  reset();
  try {
    await handleBreakCache('off', [], {});
    assert.equal(rec.error.length, 0, '无文件无错误,不该新造错误行');
    assert.match(rec.success.join(''), /原本就未激活/);
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
});

process.on('exit', () => {
  if (savedGate === undefined) delete process.env.KHY_BREAK_CACHE;
  else process.env.KHY_BREAK_CACHE = savedGate;
});
