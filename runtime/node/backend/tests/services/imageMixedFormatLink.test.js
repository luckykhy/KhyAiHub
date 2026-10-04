'use strict';

/**
 * [DESIGN-ARCH-163] 多格式同轮关联（一次输入多路径 + 混排文字）的确定性测试（node:test）。
 *
 * 锁定:
 *  ① extractAllInlineImageIntents: 多路径按出现序、引号优先占位、重复去重、纯文本 → [];
 *  ② resolveInlineImageSubmit 多路模式: ≥2 路径 → 原文逐字节保留 + 每图 label=原始路径;
 *     单路径 / 门控关 → 逐字节维持既有单路径行为（剥路径、无 label）;
 *  ③ normalizeImages label 白名单透传: 短字符串穿过,hostile/超长/非字符串被净化或丢弃;
 *  ④ buildContextCard 关联契约: turnTotal>1 出【图片对照】+ 指代约定 + 溢出诚实行;
 *     单图不出对照头; index 锚定发送序(可带空洞)。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractAllInlineImageIntents } = require('../../src/cli/repl/imageIntent');
const leaf = require('../../src/services/imageContextCard');
const { normalizeImages } = require('../../src/services/gateway/adapters/_imageCompat');

function pngBuf(w, h) {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

// ── ① 多路径扫描 ───────────────────────────────────────────────────────────
test('extractAllInlineImageIntents: 两个未引号路径按出现序返回', () => {
  const r = extractAllInlineImageIntents('对比 C:\\shots\\a.png 和 /tmp/b.jpg 的差异');
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].filePath, 'C:\\shots\\a.png');
  assert.strictEqual(r[1].filePath, '/tmp/b.jpg');
});

test('extractAllInlineImageIntents: 引号形态优先占位,不重叠不误拆', () => {
  const r = extractAllInlineImageIntents('看 "C:\\my dir\\c.png" 与 C:\\x\\d.png');
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].filePath, 'C:\\my dir\\c.png');
  assert.strictEqual(r[1].filePath, 'C:\\x\\d.png');
});

test('extractAllInlineImageIntents: 同一路径写两遍只留首现', () => {
  const r = extractAllInlineImageIntents('C:/t/a.png 再看 C:/t/a.png');
  assert.strictEqual(r.length, 1);
});

test('extractAllInlineImageIntents: 无路径 → []，绝不抛', () => {
  assert.deepStrictEqual(extractAllInlineImageIntents('普通文字，没有图片'), []);
  assert.deepStrictEqual(extractAllInlineImageIntents(''), []);
  assert.deepStrictEqual(extractAllInlineImageIntents(null), []);
});

// ── ② 提交接缝:多路模式 ────────────────────────────────────────────────────
function writeTmpPng(name, w, h) {
  const dir = path.join(os.tmpdir(), 'khy-mixed-link-test');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, pngBuf(w, h));
  return p;
}

test('resolveInlineImageSubmit: ≥2 路径 → 原文逐字节保留 + 每图 label=路径', () => {
  const p1 = writeTmpPng('lkA.png', 10, 10);
  const p2 = writeTmpPng('lkB.png', 20, 20);
  const { resolveInlineImageSubmit } = require('../../src/cli/tui/inlineImageSubmit');
  const text = `这两张按钮样式哪里不一致 ${p1} ${p2}`;
  const r = resolveInlineImageSubmit(text, { env: {} });
  assert.strictEqual(r.text, text, '多路模式不得改写用户原文(指代词与路径的相对位置即联系)');
  assert.strictEqual(r.images.length, 2);
  assert.strictEqual(r.images[0].label, p1);
  assert.strictEqual(r.images[1].label, p2);
  assert.ok(r.images[0].base64 && r.images[1].base64);
});

test('resolveInlineImageSubmit: 单路径维持既有单路径行为(剥路径,无 label)', () => {
  const p1 = writeTmpPng('lkC.png', 10, 10);
  const { resolveInlineImageSubmit } = require('../../src/cli/tui/inlineImageSubmit');
  const r = resolveInlineImageSubmit(`看看 ${p1}`, { env: {} });
  assert.strictEqual(r.images.length, 1);
  assert.strictEqual(r.images[0].label, undefined);
  assert.ok(!r.text.includes(p1), '单路径老逻辑应剥掉路径 span');
});

test('resolveInlineImageSubmit: 多路门控关 → 逐字节回退单路径老逻辑', () => {
  const p1 = writeTmpPng('lkD.png', 10, 10);
  const p2 = writeTmpPng('lkE.png', 20, 20);
  const { resolveInlineImageSubmit } = require('../../src/cli/tui/inlineImageSubmit');
  const r = resolveInlineImageSubmit(`${p1} 和 ${p2} 对比`, {
    env: { KHY_INLINE_MULTI_IMAGE: '0' },
  });
  assert.strictEqual(r.images.length, 1, '门控关 → 只走单路径第一张');
  assert.ok(!r.text.includes(p1));
});

// ── ③ normalizeImages label 白名单透传 ─────────────────────────────────────
test('normalizeImages: 干净 label 透传,base64 其余字段不变', () => {
  const b64 = Buffer.concat([pngBuf(8, 8), Buffer.alloc(64)]).toString('base64');
  const out = normalizeImages([{ base64: b64, mimeType: 'image/png', label: 'C:\\shots\\a.png' }]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].label, 'C:\\shots\\a.png');
  assert.strictEqual(out[0].base64, b64);
});

test('normalizeImages: hostile/超长/非字符串/含换行 label 净化或丢弃,绝不抛', () => {
  const b64 = Buffer.concat([pngBuf(8, 8), Buffer.alloc(64)]).toString('base64');
  const mk = (label) => normalizeImages([{ base64: b64, mimeType: 'image/png', label }])[0];
  assert.strictEqual(mk({ toString: () => { throw new Error('boom'); } }).label, undefined);
  assert.strictEqual(mk(12345).label, undefined);
  assert.strictEqual(mk('a'.repeat(500)).label.length, 160, '超长截断 160');
  assert.strictEqual(mk('line1\nline2\t.crg.png').label, 'line1 line2 .crg.png', '控制符各替换为一个空格');
});

// ── ④ buildContextCard 关联契约 ────────────────────────────────────────────
const cardA = { source: 'C:\\shots\\a.png', sizeBytes: 2048, width: 800, height: 600, format: 'png', mimeType: 'image/png', ocrText: '' };
const cardB = { source: '剪贴板/内联附件', sizeBytes: 1024, width: 400, height: 300, format: 'png', mimeType: 'image/png', ocrText: '' };

test('buildContextCard: 多图出对照表 + 指代约定,编号=发送序', () => {
  const out = leaf.buildContextCard(
    [{ ...cardA, index: 2 }, { ...cardB, index: 3 }],
    { turnTotal: 3 }
  );
  assert.match(out, /【附件对照 2\/3】/);
  assert.ok(out.includes('图2=C:\\shots\\a.png；图3=剪贴板/内联附件'), '对照表逐来自 label/来源');
  assert.match(out, /指代约定/);
  assert.match(out, /另有 1 个附件未出说明书/);
  assert.match(out, /【图片说明书 2\/3】/);
  assert.match(out, /【图片说明书 3\/3】/);
});

test('buildContextCard: 单图不出对照头,逐字节维持旧结构', () => {
  const out = leaf.buildContextCard([{ ...cardA, index: 1 }], { turnTotal: 1 });
  assert.ok(!out.includes('附件对照'));
  assert.ok(out.startsWith('【图片说明书 1/1】'));
  assert.match(out, /来源: C:\\shots\\a\.png/);
});
