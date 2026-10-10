'use strict';

/**
 * asarArchive.test.js — .asar 头解析的 fail-closed 契约（零 IO 纯 Buffer）。
 *
 * 真源规范：DESIGN-ARCH-054 §3.1（asar 记为 SOURCE 档还原路径）。本文件的重点是
 * 「畸形输入绝不抛」这条铁律：pickle 前缀、headerSize 上下界、json 越界、JSON 形状、
 * 以及条目摊平时 offset/size/unpacked 的降级取值。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const asar = require('./asarArchive');

/** 造一段合法的 size pickle（8 字节）：payloadLen=4 + headerSize。 */
function sizePickle(headerSize) {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(4, 0);
  b.writeUInt32LE(headerSize, 4);
  return b;
}

/** 造一段 header pickle：UInt32LE 前缀 + UInt32LE jsonLen + json（4 字节对齐补零）。 */
function headerPickle(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const padded = 8 + json.length + ((4 - (json.length % 4)) % 4);
  const b = Buffer.alloc(padded);
  b.writeUInt32LE(4, 0);
  b.writeUInt32LE(json.length, 4);
  json.copy(b, 8);
  return { buf: b, headerSize: padded };
}

test('HEADER_BASE 是 8，且对外只暴露三个解析函数', () => {
  assert.strictEqual(asar.HEADER_BASE, 8);
  assert.deepStrictEqual(
    Object.keys(asar).sort(),
    ['HEADER_BASE', 'flattenEntries', 'parseHeader', 'parseHeaderSize']
  );
});

test('parseHeaderSize 接受合法 pickle 并原样回报 headerSize', () => {
  assert.strictEqual(asar.parseHeaderSize(sizePickle(128)), 128);
});

test('parseHeaderSize 对畸形输入一律返回 null（绝不抛）', () => {
  assert.strictEqual(asar.parseHeaderSize(null), null);
  assert.strictEqual(asar.parseHeaderSize('7f454c46'), null); // 字符串而非 Buffer
  assert.strictEqual(asar.parseHeaderSize(Buffer.alloc(7)), null); // 不足 8 字节
  const wrongPrefix = Buffer.alloc(8);
  wrongPrefix.writeUInt32LE(5, 0); // 载荷必须恰好是 4 字节
  wrongPrefix.writeUInt32LE(128, 4);
  assert.strictEqual(asar.parseHeaderSize(wrongPrefix), null);
});

test('parseHeaderSize 把 headerSize 钉在 (0, 512 MiB] 内（拒绝 0 与超大分配）', () => {
  const zero = Buffer.alloc(8);
  zero.writeUInt32LE(4, 0);
  zero.writeUInt32LE(0, 4);
  assert.strictEqual(asar.parseHeaderSize(zero), null);
  const huge = Buffer.alloc(8);
  huge.writeUInt32LE(4, 0);
  huge.writeUInt32LE(0xffffffff, 4); // 4 GiB-1 > 512 MiB 上限
  assert.strictEqual(asar.parseHeaderSize(huge), null);
  const atCap = sizePickle(512 * 1024 * 1024);
  assert.strictEqual(asar.parseHeaderSize(atCap), 512 * 1024 * 1024);
});

test('parseHeader 解出 header 与 dataOffset = 8 + headerSize', () => {
  const { buf, headerSize } = headerPickle({ files: { 'a.txt': { size: 3, offset: '0' } } });
  const parsed = asar.parseHeader(buf, headerSize);
  assert.strictEqual(parsed.dataOffset, 8 + headerSize);
  assert.deepStrictEqual(Object.keys(parsed.header.files), ['a.txt']);
});

test('parseHeader 对畸形输入返回 null：短缓冲 / jsonLen 越界 / 坏 JSON / 无 files', () => {
  assert.strictEqual(asar.parseHeader(Buffer.alloc(7), 8), null);
  assert.strictEqual(asar.parseHeader(null, 8), null);
  const overRun = Buffer.alloc(16);
  overRun.writeUInt32LE(4, 0);
  overRun.writeUInt32LE(999, 4); // jsonLen 声称比缓冲区长
  assert.strictEqual(asar.parseHeader(overRun, 16), null);
  const badJson = headerPickle('{not json');
  assert.strictEqual(asar.parseHeader(badJson.buf, badJson.headerSize), null);
  const noFiles = headerPickle({ notFiles: {} });
  assert.strictEqual(asar.parseHeader(noFiles.buf, noFiles.headerSize), null);
  const arr = headerPickle([1, 2]);
  assert.strictEqual(asar.parseHeader(arr.buf, arr.headerSize), null);
});

test('flattenEntries 递归目录、目录本身不产条目、路径用斜杠拼接', () => {
  const header = {
    files: {
      'a.txt': { size: 1, offset: '0' },
      dir: { files: { 'b.txt': { size: 2, offset: '1' }, deeper: { files: { 'c.txt': { size: 3, offset: '2' } } } } },
    },
  };
  assert.deepStrictEqual(
    asar.flattenEntries(header).map((e) => [e.path, e.type, e.offset, e.size]),
    [
      ['a.txt', 'file', 0, 1],
      ['dir/b.txt', 'file', 1, 2],
      ['dir/deeper/c.txt', 'file', 2, 3],
    ]
  );
});

test('flattenEntries 单列软链条目，不带 offset/size', () => {
  const entries = asar.flattenEntries({ files: { lnk: { link: '../target' } } });
  assert.deepStrictEqual(entries, [{ path: 'lnk', type: 'link', link: '../target' }]);
});

test('flattenEntries 的 offset/size 降级取值：非数字 size 归 0、负数归 0、坏 offset 归 null', () => {
  const entries = asar.flattenEntries({
    files: {
      bad: { size: 'not-a-number', offset: 'oops' },
      neg: { size: -5, offset: '7' },
      big: { size: 10, offset: '9007199254740993' }, // > 2^53：parseInt 收敛到双精度
    },
  });
  const byName = Object.fromEntries(entries.map((e) => [e.path, e]));
  assert.deepStrictEqual([byName.bad.offset, byName.bad.size], [null, 0]);
  assert.strictEqual(byName.neg.size, 0);
  assert.strictEqual(byName.neg.offset, 7);
  assert.strictEqual(Number.isFinite(byName.big.offset), true);
  assert.strictEqual(byName.big.offset, 9007199254740992);
});

test('flattenEntries 的 unpacked 只在 === true 时为真（字符串 true 不算）', () => {
  const entries = asar.flattenEntries({
    files: { a: { size: 1, offset: '0', unpacked: true }, b: { size: 1, offset: '1', unpacked: 'true' } },
  });
  assert.strictEqual(entries.find((e) => e.path === 'a').unpacked, true);
  assert.strictEqual(entries.find((e) => e.path === 'b').unpacked, false);
});

test('flattenEntries 对空/畸形 header 返回空数组（fail-closed，不抛）', () => {
  assert.deepStrictEqual(asar.flattenEntries(null), []);
  assert.deepStrictEqual(asar.flattenEntries({}), []);
  assert.deepStrictEqual(asar.flattenEntries({ files: 'not-an-object' }), []);
  assert.deepStrictEqual(asar.flattenEntries({ files: { junk: null, ok: { size: 1, offset: '0' } } }), [
    { path: 'ok', type: 'file', offset: 0, size: 1, unpacked: false },
  ]);
});

test('flattenEntries 会吞掉遍历中途抛出的异常并返回已收集部分', () => {
  let touched = 0;
  const header = { files: {} };
  Object.defineProperty(header.files, 'ok', {
    enumerable: true,
    value: { size: 1, offset: '0' },
  });
  Object.defineProperty(header.files, 'boom', {
    enumerable: true,
    get() {
      touched += 1;
      throw new Error('getter blew up mid-walk');
    },
  });
  // Object.keys 不触发 getter；node.files[name] 取值的瞬间抛 → walk 的 catch 兜住。
  assert.deepStrictEqual(asar.flattenEntries(header), [
    { path: 'ok', type: 'file', offset: 0, size: 1, unpacked: false },
  ]);
  assert.strictEqual(touched, 1);
});

test('parseHeader 不校验 header pickle 的前置 UInt32（磁盘上是 payloadSize 而非 4）', () => {
  const json = Buffer.from(JSON.stringify({ files: { a: { size: 1, offset: '0' } } }), 'utf8');
  const padded = 8 + json.length + ((4 - (json.length % 4)) % 4);
  const realLayout = Buffer.alloc(padded);
  realLayout.writeUInt32LE(4 + (padded - 8), 0); // 真实磁盘布局：payloadSize
  realLayout.writeUInt32LE(json.length, 4);
  json.copy(realLayout, 8);
  const parsed = asar.parseHeader(realLayout, padded);
  assert.strictEqual(parsed.dataOffset, 8 + padded);
  assert.deepStrictEqual(Object.keys(parsed.header.files), ['a']);
});
