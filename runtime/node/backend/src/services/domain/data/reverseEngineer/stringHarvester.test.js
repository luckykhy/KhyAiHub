'use strict';

/**
 * stringHarvester.test.js — 字符串收割与语义分类的契约（零 IO 纯 Buffer）。
 *
 * 真源规范：DESIGN-ARCH-054 §3.3。钉住的是「证据包能多可信」的地基：run 边界、
 * UTF-16LE 的对齐前提、各类上限（50/40/256/200）、地板值、以及非 Buffer 入参的降级形状。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const sh = require('./stringHarvester');

test('classify 按 CLASSIFIERS 声明顺序返回全部命中类别', () => {
  assert.deepStrictEqual(sh.classify('see http://example.com/x built 1.2.3'), ['url', 'version']);
  assert.deepStrictEqual(sh.classify('owner: dev@khy.example.com'), ['email']);
  assert.deepStrictEqual(sh.classify('C:\\Windows\\system32\\app.exe'), ['path']);
  assert.deepStrictEqual(sh.classify('/usr/lib/x86_64-linux-gnu/libc.so'), ['path']);
  assert.deepStrictEqual(sh.classify(''), []);
});

test('classify 识别四类密钥样式，短于阈值的 sk- 不算', () => {
  assert.deepStrictEqual(sh.classify('sk-abcdefghijklmnopqrstuvwxyz'), ['secret']);
  assert.deepStrictEqual(sh.classify('AKIAABCDEFGHIJKLMNOP'), ['secret']);
  assert.deepStrictEqual(sh.classify('ghp_abcdefghijklmnopqrstuvwxyz1234'), ['secret']);
  assert.deepStrictEqual(sh.classify('-----BEGIN RSA PRIVATE KEY-----'), ['secret']);
  assert.deepStrictEqual(sh.classify('sk-short'), []);
});

test('B27-F2 回归：PEM 支不再被整组前导 \\b 挡死，且无算法名的 PKCS#8 也命中', () => {
  // 修法有两处，各钉一根线：
  // ① 前导 \b 曾套在整个交替外面 → '-----BEGIN' 位于串首或非词字符后，无词边界，整支永不命中。
  //    钉 '-----BEGIN RSA PRIVATE KEY-----'（有算法名，只验 \b 这一处）。
  // ② `[A-Z ]+` 至少吃一个字符 → PKCS#8 的 '-----BEGIN PRIVATE KEY-----'（BEGIN 后直接 PRIVATE）
  //    在 + 下匹配不到。钉这条才守得住 * 的改动。
  assert.deepStrictEqual(sh.classify('-----BEGIN PRIVATE KEY-----'), ['secret']);
  assert.deepStrictEqual(sh.classify('-----BEGIN ENCRYPTED PRIVATE KEY-----'), ['secret']);
  // PEM 支只认私钥：公钥/证书不是秘密，不该被顺手捞进来（量化「不扩大指控面」）。
  assert.deepStrictEqual(sh.classify('-----BEGIN CERTIFICATE-----'), []);
  assert.deepStrictEqual(sh.classify('-----BEGIN PUBLIC KEY-----'), []);
  // 五连字符定界是 PEM 支的一部分：裸文本不算（防正则退化成 'BEGIN .* PRIVATE KEY'）。
  assert.deepStrictEqual(sh.classify('BEGIN PRIVATE KEY'), []);
  // 串中出现（前后有不可打印分隔符）同样命中——真实制品里 PEM 从不单独占一个字符串，
  // 走的是门面实际调用的 harvest() 全路径，不是只测 classify() 的单串入参。
  const embedded = sh.harvest(Buffer.from('\x00\x00-----BEGIN PRIVATE KEY-----\x00\x00', 'binary'));
  assert.deepStrictEqual(embedded.classified.secret, [
    { offset: 2, text: '-----BEGIN PRIVATE KEY-----' },
  ]);
});

test('_harvestAscii 的最小长度是「恰好命中」而非「超过」，尾部 run 也收', () => {
  const buf = Buffer.from('abcd\x00xyz', 'ascii');
  const hits = sh._harvestAscii(buf, 4);
  assert.deepStrictEqual(hits, [{ offset: 0, text: 'abcd', enc: 'ascii' }]);
  const tail = sh._harvestAscii(Buffer.from('\x00\x00hello', 'ascii'), 4);
  assert.deepStrictEqual(tail, [{ offset: 2, text: 'hello', enc: 'ascii' }]);
  assert.deepStrictEqual(sh._harvestAscii(Buffer.from('abc', 'ascii'), 4), []);
});

test('_harvestAscii 把不可打印字节当分隔符，偏移指向 run 起点', () => {
  const buf = Buffer.from('QQ\x00\x00MMMMDDDD\x07ZZZZ', 'ascii');
  const hits = sh._harvestAscii(buf, 4);
  assert.deepStrictEqual(
    hits.map((h) => [h.offset, h.text]),
    [
      [4, 'MMMMDDDD'],
      [13, 'ZZZZ'],
    ]
  );
});

test('_harvestUtf16le 只在偶偏移上成对读取（奇偏移起头的宽串会漏）', () => {
  const wide = Buffer.from('A\x00B\x00C\x00D\x00', 'binary');
  assert.deepStrictEqual(sh._harvestUtf16le(wide, 4), [
    { offset: 0, text: 'ABCD', enc: 'utf16le' },
  ]);
  // 前置 1 字节填充 → 整串错位，一条都捞不到（现状边界，如实钉住而不是改码）。
  const odd = Buffer.concat([Buffer.from('\x00', 'binary'), wide]);
  assert.deepStrictEqual(sh._harvestUtf16le(odd, 4), []);
});

test('_harvestUtf16le 要求高位字节为 0，故只捞 BMP 内拉丁字符', () => {
  const chinese = Buffer.from('中', 'utf16le'); // 2d 4e
  assert.deepStrictEqual(sh._harvestUtf16le(Buffer.concat([chinese, chinese, chinese, chinese]), 4), []);
});

test('harvest 对非 Buffer 入参降级为空对象，且 classified 是空形状（与正常路径不同）', () => {
  assert.deepStrictEqual(sh.harvest('not a buffer'), {
    total: 0,
    truncated: false,
    classified: {},
    toolchains: [],
    samples: [],
  });
  // 正常路径的 classified 恒有五个键——两处形状不一致是现状契约。
  const ok = sh.harvest(Buffer.from('nothing printable here', 'ascii'));
  assert.deepStrictEqual(Object.keys(ok.classified), ['url', 'path', 'version', 'email', 'secret']);
});

test('harvest 的 minLen 与 maxStrings 都有地板值（1 会被抬到 2 / 50）', () => {
  const pairs = 'ab\x00cd\x00ef'; // 三条长度恰为 2 的 run
  assert.strictEqual(
    sh.harvest(Buffer.from(pairs, 'ascii'), { minLen: 1 }).total,
    sh.harvest(Buffer.from(pairs, 'ascii'), { minLen: 2 }).total,
    'minLen=1 应与地板值 2 同档'
  );
  assert.strictEqual(sh.harvest(Buffer.from(pairs, 'ascii'), { minLen: 3 }).total, 0);
  // maxStrings 地板 50：请求 1 但只有 3 条命中 → 不该判截断；>50 条才判。
  assert.strictEqual(sh.harvest(Buffer.from(pairs, 'ascii'), { maxStrings: 1 }).truncated, false);
  const many = Array.from({ length: 60 }, (_, i) => `run${i}_pad`).join('\x00');
  const r = sh.harvest(Buffer.from(many, 'ascii'), { maxStrings: 1 });
  assert.strictEqual(r.total, 60);
  assert.strictEqual(r.truncated, true);
});

test('harvest 每类命中封顶 50 条、文本裁剪到 256', () => {
  // 分隔符必须用不可打印字节：空格本身可打印，会把整串并成一条 run（只产 1 个命中）。
  const urls = Array.from({ length: 60 }, (_, i) => `http://example.com/${i}`).join('\x00');
  const r = sh.harvest(Buffer.from(urls, 'ascii'));
  assert.strictEqual(r.classified.url.length, 50);
  assert.strictEqual(r.total, 60);
  const long = `http://example.com/${'x'.repeat(400)}`;
  const r2 = sh.harvest(Buffer.from(long, 'ascii'));
  assert.strictEqual(r2.classified.url[0].text.length, 256);
});

test('harvest 的 samples 按长度降序、封顶 40 条、文本裁剪到 200', () => {
  const parts = [];
  for (let i = 0; i < 45; i++) {
    parts.push('z'.repeat(10 + i));
  }
  parts.push('short');
  const r = sh.harvest(Buffer.from(parts.join('\x00'), 'ascii'), { minLen: 4 });
  assert.strictEqual(r.samples.length, 40);
  const lengths = r.samples.map((s) => s.text.length);
  assert.deepStrictEqual(lengths, [...lengths].sort((a, b) => b - a));
  const huge = 'q'.repeat(500);
  assert.strictEqual(
    sh.harvest(Buffer.from(huge, 'ascii'), { minLen: 4 }).samples[0].text.length,
    200
  );
});

test('harvest 去重上报工具链指纹（同一指纹命中多条只记一次）', () => {
  const buf = Buffer.from('GCC: (GNU) 12.0\x00GCC: (Debian) 11.0\x00clang version 15', 'ascii');
  const r = sh.harvest(buf, { minLen: 4 });
  assert.strictEqual(r.toolchains.filter((t) => t === 'gcc').length, 1, `实测 ${r.toolchains}`);
  assert.ok(r.toolchains.includes('clang'));
});

test('harvest 的 total 统计截断前的全部命中', () => {
  const parts = Array.from({ length: 80 }, (_, i) => `token${i}_xxxx`);
  const r = sh.harvest(Buffer.from(parts.join('\x00'), 'ascii'), { minLen: 4, maxStrings: 50 });
  assert.strictEqual(r.total, 80);
  assert.strictEqual(r.truncated, true);
});
