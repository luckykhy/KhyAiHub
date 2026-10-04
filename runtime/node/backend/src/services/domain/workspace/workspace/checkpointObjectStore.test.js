'use strict';

// Colocated tests for checkpointObjectStore.js (content-addressed checkpoint object store).
// Runs against real fs inside os.tmpdir() only; never touches the repo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const store = require('./checkpointObjectStore');

const DIGEST_RE = /^[a-f0-9]{64}$/;

test('digestBuffer 对相同内容稳定、输出 64 位小写十六进制', () => {
  const d1 = store.digestBuffer(Buffer.from('hello'));
  const d2 = store.digestBuffer(Buffer.from('hello'));
  assert.equal(d1, d2);
  assert.match(d1, DIGEST_RE);
  assert.notEqual(store.digestBuffer(Buffer.from('world')), d1);
});

test('objectPath 合法 digest 产出两层分片路径', () => {
  const d = 'a'.repeat(64);
  const p = store.objectPath('/tmp/root', d);
  const norm = p.replace(/\\/g, '/');
  assert.ok(norm.includes('/objects/sha256/aa/'));
  assert.ok(norm.endsWith('/' + d + '.gz'));
});

test('objectPath 垃圾 digest 一律抛错（校验先于拼路径）', () => {
  const bad = [
    null,
    undefined,
    '',
    'ABC', // 64 位大写不接受
    'A'.repeat(64),
    'zzzz',
    'a'.repeat(63),
    'a'.repeat(65),
    '../../etc/passwd',
    0,
    NaN,
    {},
    [],
  ];
  for (const d of bad) {
    assert.throws(() => store.objectPath('/tmp/root', d), /Invalid checkpoint object digest/);
  }
});

test('objectPath 经 String() 强转：toString 伪装对象抛 TypeError、数组伪装死在 path.join', () => {
  // 行为记录（非推荐用法）：正则 test 走 String 强转——能强转出合法 64 位 hex 的非字符串
  // 会通过校验；随后对无 slice 的对象抛 TypeError（而非 Invalid digest）。
  const imposter = { toString: () => 'a'.repeat(64) };
  assert.throws(() => store.objectPath('/tmp/root', imposter), /digest\.slice is not a function/);
  // 数组有 slice、能过校验，但 path.join 只收 string → ERR_INVALID_ARG_TYPE
  assert.throws(
    () => store.objectPath('/tmp/root', ['a'.repeat(64)]),
    /must be of type string/
  );
});

test('putBuffer → readBuffer 内容往返一致，对象只落一份', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cas-'));
  try {
    const payload = Buffer.from('checkpoint payload 内容');
    const first = store.putBuffer(root, payload);
    assert.match(first.digest, DIGEST_RE);
    assert.equal(first.size, payload.length);
    assert.equal(first.encoding, 'gzip');

    const stat1 = fs.statSync(store.objectPath(root, first.digest));
    const second = store.putBuffer(root, payload);
    assert.equal(second.digest, first.digest);
    const stat2 = fs.statSync(store.objectPath(root, first.digest));
    assert.equal(stat2.mtimeMs, stat1.mtimeMs); // 写一次：已存在不重写

    assert.deepEqual(store.readBuffer(root, first), payload);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readBuffer 在 digest 被篡改时抛错（读时校验）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cas-'));
  try {
    const obj = store.putBuffer(root, Buffer.from('original'));
    const target = store.objectPath(root, obj.digest);
    fs.writeFileSync(target, zlib.gzipSync(Buffer.from('tampered')));
    assert.throws(() => store.readBuffer(root, obj), /digest mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readBuffer 在 size 与对象不符时抛错', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cas-'));
  try {
    const obj = store.putBuffer(root, Buffer.from('12345'));
    assert.throws(
      () => store.readBuffer(root, { digest: obj.digest, size: 999, encoding: 'gzip' }),
      /size mismatch/
    );
    // size 非有限数时不做校验（行为契约：Number.isFinite 才比对）
    const buf = store.readBuffer(root, { digest: obj.digest, size: 'bogus' });
    assert.equal(buf.toString(), '12345');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readBuffer 垃圾 digest / 缺对象路径抛错', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cas-'));
  try {
    assert.throws(() => store.readBuffer(root, { digest: null }), /Invalid checkpoint object digest/);
    assert.throws(() => store.readBuffer(root, { digest: '' }));
    const obj = store.putBuffer(root, Buffer.from('x'));
    fs.rmSync(store.objectPath(root, obj.digest));
    assert.throws(() => store.readBuffer(root, obj)); // ENOENT
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removeIfUnreferenced 只删存在的 digest 并返回数量', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cas-'));
  try {
    const a = store.putBuffer(root, Buffer.from('aaa'));
    const b = store.putBuffer(root, Buffer.from('bbb'));
    const missing = store.digestBuffer(Buffer.from('never-written'));
    assert.equal(store.removeIfUnreferenced(root, [a.digest, b.digest, missing]), 2);
    assert.equal(fs.existsSync(store.objectPath(root, a.digest)), false);
    assert.equal(fs.existsSync(store.objectPath(root, b.digest)), false);
    // 空入参与垃圾入参
    assert.equal(store.removeIfUnreferenced(root, []), 0);
    assert.throws(() => store.removeIfUnreferenced(root, [null])); // objectPath 校验直接抛
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('putBuffer 对垃圾载荷的行为：空串可写、null 抛错', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cas-'));
  try {
    const empty = store.putBuffer(root, '');
    assert.match(empty.digest, DIGEST_RE);
    assert.equal(empty.size, 0);
    assert.deepEqual(store.readBuffer(root, empty), Buffer.alloc(0));

    assert.throws(() => store.putBuffer(root, null)); // crypto.update(null) → TypeError
    assert.throws(() => store.putBuffer(root, {}));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
