'use strict';

/**
 * artifactHash.test.js — 钉死轨迹复现哈希契约：sha256 已知常量、null/undefined 收敛为空串哈希、
 * 文件不可读一律返回 null、规范 JSON 序列化的回退链。
 *
 * 实测更正（以行为为准，非注释）：模块头声称「Every function fails soft」，但第 5 个导出
 * sha256Hex 是对 sourceSnapshotCrypto 的原样再导出——传入 null 会抛 TypeError（不包 fail-soft），
 * 本文件如实钉住该透传行为。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mod = require('./artifactHash');

const SHA_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SHA_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-art-hash-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('模块导出恰为 hashString/readBytes/hashFile/hashCanonical/sha256Hex 五个符号', () => {
  assert.deepStrictEqual(Object.keys(mod).sort(), [
    'hashCanonical',
    'hashFile',
    'hashString',
    'readBytes',
    'sha256Hex',
  ]);
});

test('hashString 对 abc 返回业界已知 sha256 常量', () => {
  assert.strictEqual(mod.hashString('abc'), SHA_ABC);
});

test('hashString 对 null/undefined/空串统一收敛为空字节的 sha256', () => {
  assert.strictEqual(mod.hashString(null), SHA_EMPTY);
  assert.strictEqual(mod.hashString(undefined), SHA_EMPTY);
  assert.strictEqual(mod.hashString(''), SHA_EMPTY);
});

test('hashString 对数字先转字符串：123 等于对 "123" 求哈希', () => {
  assert.strictEqual(mod.hashString(123), 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3');
});

test('hashString 对普通对象走 String() 得到 "[object Object]" 的哈希', () => {
  assert.strictEqual(mod.hashString({}), 'b28c94b2195c8ed259f0b415aaee3f39b0b2920a4537611499fa044956917a21');
});

test('hashString 对同一输入三次调用结果相同（确定性）', () => {
  const a = mod.hashString('轨迹复现');
  assert.strictEqual(a, mod.hashString('轨迹复现'));
  assert.strictEqual(a, mod.hashString('轨迹复现'));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('readBytes 读取临时文件返回逐字节一致的 Buffer', () => {
  withTmp((dir) => {
    const f = path.join(dir, 'x.txt');
    fs.writeFileSync(f, '你好 replay');
    const buf = mod.readBytes(f);
    assert.ok(Buffer.isBuffer(buf));
    assert.strictEqual(buf.toString('utf-8'), '你好 replay');
  });
});

test('readBytes 对不存在路径返回 null 而不抛', () => {
  assert.strictEqual(mod.readBytes(path.join(os.tmpdir(), 'tr-definitely-absent-9x7')), null);
});

test('readBytes 对目录（非普通文件）返回 null', () => {
  withTmp((dir) => {
    assert.strictEqual(mod.readBytes(dir), null);
  });
});

test('hashFile 对不存在文件返回 null', () => {
  assert.strictEqual(mod.hashFile('Z:/no/such/file.bin'), null);
});

test('hashFile 对目录返回 null（statSync 成功但非文件）', () => {
  withTmp((dir) => {
    assert.strictEqual(mod.hashFile(dir), null);
  });
});

test('hashFile 对 utf-8 文本文件的结果与 hashString 同内容一致', () => {
  withTmp((dir) => {
    const f = path.join(dir, 'a.txt');
    const content = 'line1\nline2\n中文';
    fs.writeFileSync(f, content, 'utf-8');
    assert.strictEqual(mod.hashFile(f), mod.hashString(content));
  });
});

test('hashFile 对空文件返回空字节 sha256', () => {
  withTmp((dir) => {
    const f = path.join(dir, 'empty.bin');
    fs.writeFileSync(f, Buffer.alloc(0));
    assert.strictEqual(mod.hashFile(f), SHA_EMPTY);
  });
});

test('hashCanonical 对 {a:1} 哈希其 JSON 序列化，命中已知常量', () => {
  assert.strictEqual(mod.hashCanonical({ a: 1 }), '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862');
});

test('hashCanonical 对字符串 "abc" 哈希带引号的 JSON（不同于 hashString 裸串）', () => {
  assert.strictEqual(mod.hashCanonical('abc'), '6cc43f858fbb763301637b5af970e2a46b46f461f27e5a0f41e009c59b827b25');
  assert.notStrictEqual(mod.hashCanonical('abc'), mod.hashString('abc'));
});

test('hashCanonical 对 null 哈希字面量 "null"（JSON.stringify(null) 是真值短路失败）', () => {
  assert.strictEqual(mod.hashCanonical(null), '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b');
});

test('hashCanonical 对 undefined 走 || "" 回退得到空串哈希', () => {
  // JSON.stringify(undefined) === undefined → undefined || '' → ''
  assert.strictEqual(mod.hashCanonical(undefined), SHA_EMPTY);
});

test('hashCanonical 对数组 [1,2] 命中 JSON 序列化已知常量', () => {
  assert.strictEqual(mod.hashCanonical([1, 2]), '49a64717d5d4cb19952e6eac2946415cf6879adacf9908e7d872332d32c6e684');
});

test('hashCanonical 对循环引用回退 String() 得 "[object Object]" 哈希且不抛', () => {
  const cyc = {};
  cyc.self = cyc;
  assert.strictEqual(mod.hashCanonical(cyc), mod.hashString({}));
});

test('hashCanonical 键序不同则哈希不同（非排序规范化，仅 JSON.stringify 原样）', () => {
  assert.notStrictEqual(mod.hashCanonical({ a: 1, b: 2 }), mod.hashCanonical({ b: 2, a: 1 }));
});

test('sha256Hex 原样透传：对字符串直接命中已知哈希', () => {
  assert.strictEqual(mod.sha256Hex('str'), '8c25cb3686462e9a86d2883c5688a22fe738b0bbc85f458d2d2b5f3f667c6d5a');
});

test('sha256Hex 透传原函数对 null 抛 TypeError（不包 fail-soft，与四包装函数不同）', () => {
  assert.throws(() => mod.sha256Hex(null), TypeError);
});
